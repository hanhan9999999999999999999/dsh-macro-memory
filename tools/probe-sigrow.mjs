// probe-sigrow（0.6.20）：签名校验改「对齐行缓存」的判据
// 病根：`sigDocOf` 每问每库走一遍，10,000 条就是 10,000 次 WeakMap.get（热检索采样 17.4%）。
// 处方：按数组下标对齐的侧表，行里存条级记录；只在同一个数组第 2 次进来时才铺。
// 这里钉的是「换了取值方式，结论一个字都不能变」：行缓存那一趟必须与「每次新建数组」那一趟逐位相同。
import { readFileSync } from 'node:fs';
import * as V from '../vendor/meow-memory/lib/index.js';

const ENGINE = readFileSync(new URL('../vendor/meow-memory/lib/index.js', import.meta.url), 'utf8');

let pass = 0;
let fail = 0;
function ok(name, cond, detail = '') {
  if (cond) {
    pass++;
    console.log(`PASS ${name}${detail === '' ? '' : ' · ' + detail}`);
  } else {
    fail++;
    console.log(`FAIL ${name}${detail === '' ? '' : ' · ' + detail}`);
  }
}

function rnd(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}
const WORDS = ['记忆', '插件', '索引', '签名', '缓存', '定档', '权重', '回执', '锚点', '倒排'];
function mkDoc(i, r) {
  const words = [];
  const len = 2 + Math.floor(r() * 5);
  for (let j = 0; j < len; j++) words.push(WORDS[Math.floor(r() * WORDS.length)]);
  return {
    id: '0mdoc' + String(i).padStart(5, '0'),
    project: i % 3 === 0 ? 'alpha' : 'beta',
    title: WORDS[Math.floor(r() * WORDS.length)],
    content: words.join('，') + '。第 ' + i + ' 条。',
    keywords: [WORDS[Math.floor(r() * WORDS.length)], WORDS[Math.floor(r() * WORDS.length)]],
    updated_at: 1795400000000 - i * 1000,
    source_session: 's' + (i % 5),
  };
}
function mkLib(n, seed) {
  const r = rnd(seed);
  const docs = [];
  for (let i = 0; i < n; i++) docs.push(mkDoc(i, r));
  return docs;
}

// R0 形状：侧表与两处取值分支都在，且首次访问不铺行
const r0 = [
  ['const SIG_ROW_CACHE = new WeakMap();', '侧表本身'],
  ['function sigRowFor(docs, n) {', '取行入口'],
  ['if (slot.row === null && slot.visits >= 2) slot.row = new Array(n);', '首次访问不铺行'],
  ['function sigDocOfRow(row, i, d) {', '行内校验'],
  ['sigStats.hashed++;\n    sigStats.reused++;', '行命中计数与 sigDocOf 同口径'],
  ['const row = sigRowFor(docs, n).row;', 'indexSignature 取行'],
  ['h ^= row === null ? sigDocOf(docs[i]) : sigDocOfRow(row, i, docs[i]);', '两路合并'],
  ['for (const d of docs) {', '非数组可迭代物的旧路仍在'],
];
const miss0 = r0.filter(([needle]) => !ENGINE.includes(needle)).map(([, what]) => what);
ok('R0 行缓存形状', miss0.length === 0, miss0.length === 0 ? `${r0.length} 件在位` : `缺 ${miss0.join(' / ')}`);

// R1 行缓存一趟 vs 每次新建数组一趟：逐位相同（500 库 × 随机变更）
let r1Bad = 0;
let r1Cases = 0;
for (let s = 0; s < 500; s++) {
  const r = rnd(90001 + s);
  const n = 1 + Math.floor(r() * 60);
  const docs = mkLib(n, 7001 + s);
  const rounds = 3 + Math.floor(r() * 3);
  for (let k = 0; k < rounds; k++) {
    // 同一轮里先让行缓存那条路跑（第 1 次不铺行、第 2 次铺、第 3 次起命中），再拿新数组那一趟对拍
    const warm = V.indexSignature(docs);
    const warm2 = V.indexSignature(docs);
    const fresh = V.indexSignature(docs.slice());
    r1Cases++;
    if (warm !== warm2 || warm !== fresh) r1Bad++;
    // 随机改一处：内容 / 标题 / 项目 / 关键词 / 时间 / 顺序
    const pick = Math.floor(r() * 6);
    const i = Math.floor(r() * docs.length);
    if (pick === 0) docs[i].content = docs[i].content + '补';
    else if (pick === 1) docs[i].title = '改' + k;
    else if (pick === 2) docs[i].project = docs[i].project === 'alpha' ? 'beta' : 'alpha';
    else if (pick === 3) docs[i].keywords = [...docs[i].keywords, '新词'];
    else if (pick === 4) docs[i].updated_at = docs[i].updated_at + 1;
    else if (docs.length > 1) {
      const j = Math.floor(r() * docs.length);
      const t = docs[i];
      docs[i] = docs[j];
      docs[j] = t;
    }
    // 改完必须被看见：行缓存那条路与新数组那条路要一起变
    const afterSame = V.indexSignature(docs);
    const afterFresh = V.indexSignature(docs.slice());
    r1Cases++;
    if (afterSame !== afterFresh) r1Bad++;
  }
}
ok('R1 行缓存与新建数组逐位相同', r1Bad === 0, `${r1Cases} 次对拍 / 不一致 ${r1Bad}`);

// R2 计数口径：同一数组连算两次，与「两次都新建数组」的 calls / hashed / reused / rebuilt 完全相同
// 两条路各用一份**互不相干**的同形库：共用一批文档对象时，先跑的那条路会把条级缓存填满，
// 后跑的那条自然全是 reused——那是测量顺序，不是口径差异。
function counts(runTwice) {
  V.resetIndexSignatureStats();
  runTwice();
  return V.indexSignatureStats();
}
const docsSame = mkLib(200, 4242);
const docsFresh = mkLib(200, 4242);
const sameTwice = counts(() => { V.indexSignature(docsSame); V.indexSignature(docsSame); });
const freshTwice = counts(() => { V.indexSignature(docsFresh.slice()); V.indexSignature(docsFresh.slice()); });
const sameKey = ['calls', 'hashed', 'reused', 'rebuilt'].map((k) => `${k}=${sameTwice[k]}`).join(' ');
const freshKey = ['calls', 'hashed', 'reused', 'rebuilt'].map((k) => `${k}=${freshTwice[k]}`).join(' ');
ok('R2 计数口径一致', sameTwice.calls === freshTwice.calls && sameTwice.hashed === freshTwice.hashed &&
  sameTwice.reused === freshTwice.reused && sameTwice.rebuilt === freshTwice.rebuilt,
  `${sameKey} / 新建 ${freshKey}`);

// R3 变更必被看见：五种改法各改一处，签名都要变；同内容不同数组必须相同
const base = mkLib(30, 5150);
const baseSig = V.indexSignature(base);
const mutateCases = [
  ['改正文', () => { base[3].content += 'x'; }],
  ['改标题', () => { base[7].title = '换名'; }],
  ['改项目', () => { base[11].project = 'gamma'; }],
  ['改关键词', () => { base[19].keywords = [...base[19].keywords, 'z']; }],
  ['改时间', () => { base[23].updated_at += 60000; }],
  ['换顺序', () => { const t = base[2]; base[2] = base[29]; base[29] = t; }],
  ['删一条', () => { base.pop(); }],
  ['加一条', () => { base.push(mkDoc(999, rnd(7))); }],
];
const seen = [];
for (const [what, act] of mutateCases) {
  const before = V.indexSignature(base);
  act();
  const after = V.indexSignature(base);
  seen.push({ what, changed: before !== after });
}
const notSeen = seen.filter((x) => !x.changed).map((x) => x.what);
ok('R3 变更必被看见', notSeen.length === 0, `${mutateCases.length} 种改法，漏 ${notSeen.length}${notSeen.length ? '：' + notSeen.join(' / ') : ''}`);

// R4 同内容不同数组、以及「第 2 次进来才铺行」都不改结论
const libA = mkLib(40, 8080);
const libB = libA.map((d) => ({ ...d, keywords: d.keywords.slice() }));
const first = V.indexSignature(libA);
const second = V.indexSignature(libA);
const third = V.indexSignature(libA);
const copy = V.indexSignature(libB);
ok('R4 三次一致、副本同签名', first === second && second === third && first === copy, `${first} · 副本 ${copy}`);

// R5 脏值不许把两条认成一条：非对象、缺字段、关键词里塞对象
const dirty = [{ id: 'a' }, { id: 'a', content: 'x' }, { id: 'a', content: 'y' }, null, undefined, 'str', 42, { id: 'a', keywords: [{ o: 1 }] }];
const dirtySigA = V.indexSignature(dirty);
const dirtySigB = V.indexSignature(dirty.slice());
ok('R5 脏值两路同签名', dirtySigA === dirtySigB, `${dirtySigA}`);

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILED'} · probe-sigrow ${pass}/${pass + fail}`);
process.exitCode = fail === 0 ? 0 : 1;
