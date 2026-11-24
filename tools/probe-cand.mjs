// [macro-fusion 0.6.18] 判据：候选集不许用 Set 去重。
//
// 背景（`docs/INTERNAL.md` 9.217）：0.6.17 之后热路第五名是候选集 IIFE
// `(anon)@index.js:3626`——137.4ms / 7.6%（10,000 条 / 300 问，1,808.2ms 总采样）。它只做一件事：
// 把问句各词（以及它们的同义扩词）的倒排下标并成一个集合。`Set.add` 每条要算哈希、找桶、在桶链上比，
// 后面 `for..of` 还要过迭代器协议；换成 **位图去重 + 按下标攒的候选表** 就够了。
//
// 这一刀的风险不是慢，是**顺序**：
//   · 候选表的首见序必须与 Set 的插入序逐位相同（同一条只进一次、进的位置一样），
//     否则第二趟打分遍历顺序变、`candArr` 的铺法变、极少数并列条的先后变；
//   · 去重判定必须是每次 `push` 前的那一次位图读，不能在循环外批量补；
//   · 换尺子那趟会再进 `scoreCandSet`，候选表只被读、不许被写坏。
// 所以这个探针要证明六件事：
//
//   C0 形状：位图 + 候选表在位，两处（问句词 / 同义扩词）都走同一条去重语句，Set 已彻底退场
//   C1 算法：位图并集与 Set 并集在 200 组随机倒排（含重复、乱序、空手）上逐位相同
//   C2 引擎：倒排开着（走候选表）与倒排关着（逐条扫）逐位相同——两条独立实现互相验
//   C3 同义扩词那条路也进候选表：扩词真的生效了，且开/关两路仍逐位相同
//   C4 空手问句：一个词都不在库里时回执为空、不留 NaN
//   C5 大一点的库（300 条 × 30 问，含 adaptiveIdf 换尺子那趟）两条路仍逐位相同
import { readFileSync } from 'node:fs';
import { search } from '../vendor/meow-memory/lib/index.js';

let pass = 0;
let fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) {
    pass += 1;
    console.log(`PASS ${name}${detail === '' ? '' : ` · ${detail}`}`);
  } else {
    fail += 1;
    console.log(`FAIL ${name}${detail === '' ? '' : ` · ${detail}`}`);
  }
};

const ENGINE = readFileSync(new URL('../vendor/meow-memory/lib/index.js', import.meta.url), 'utf8');
const NOW = 1795470000000;
const mk = (id, content, importance = 2, extra = {}) => ({
  id,
  level: 'fact',
  title: 't',
  content,
  importance,
  keywords: [],
  project: 'p',
  status: 'active',
  created_at: 1795000000000,
  updated_at: 1795000000000,
  ...extra,
});

// ── C0 ───────────────────────────────────────────────────────────────────
{
  const AT_OLD = 'const candAt = postings === null || verbOn ? null : new Uint8Array(docs.length);';
  const AT_NEW = 'const candAt = postings === null || verbOn ? null : scratch === null ? new Uint8Array(docs.length) : scratch.candAt;';
  const AT = ENGINE.includes(AT_OLD) ? AT_OLD : AT_NEW;
  const hasAt = ENGINE.includes(AT);
  const hasList = ENGINE.includes('const candList = candAt === null ? null : [];');
  const dedupe = (ENGINE.split('if (candAt[di] === 0) { candAt[di] = 1; candList.push(di); }').length - 1) === 2;
  const loops = ENGINE.includes('for (let ci = 0; ci < candList.length; ci++) {');
  const nullChecks = (ENGINE.split('if (candList === null) {').length - 1) === 2;
  // 只在这一段里查「Set 有没有退场」：引擎别处还用 Set，那是别的事。
  const candStart = ENGINE.indexOf(AT);
  const candEnd = ENGINE.indexOf('const scoreCandSet = () => {', candStart + 1);
  const candSeg = candStart >= 0 && candEnd > candStart ? ENGINE.slice(candStart, candEnd) : '';
  const noSet = candSeg !== '' && candSeg.includes('new Set()') === false && candSeg.includes('set.add(') === false;
  const noIter = ENGINE.includes('for (const di of candList)') === false;
  ok(
    'C0 位图 + 候选表在位：两处去重语句（问句词 / 同义扩词）、两处退路判空、遍历是下标循环、Set 已退场',
    hasAt && hasList && dedupe && loops && nullChecks && noSet && noIter,
    `位图=${hasAt} · 候选表=${hasList} · 去重两处=${dedupe} · 下标循环=${loops} · 判空两处=${nullChecks} · Set退场=${noSet} · 无迭代器=${noIter}`,
  );
}

// ── C1 ───────────────────────────────────────────────────────────────────
{
  // 参考实现：Set 去重后按插入序摊成数组（0.6.17 及以前的做法）。
  const bySet = (groups) => {
    const set = new Set();
    for (const g of groups) for (const di of g) set.add(di);
    return [...set];
  };
  const byBitmap = (groups, n) => {
    const at = new Uint8Array(n);
    const list = [];
    for (const g of groups) {
      for (let i = 0; i < g.length; i++) {
        const di = g[i];
        if (at[di] === 0) { at[di] = 1; list.push(di); }
      }
    }
    return list;
  };
  let seed = 20261127;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  let bad = 0;
  let shapes = 0;
  for (let t = 0; t < 200; t++) {
    const n = 1 + Math.floor(rnd() * 40);
    const gs = [];
    const gcount = Math.floor(rnd() * 6); // 0 组：一问一个词都不在库里
    for (let g = 0; g < gcount; g++) {
      const len = Math.floor(rnd() * 12);
      const arr = [];
      for (let i = 0; i < len; i++) arr.push(Math.floor(rnd() * n));
      gs.push(arr);
    }
    const a = bySet(gs);
    const b = byBitmap(gs, n);
    if (a.length !== b.length || a.some((v, i) => v !== b[i])) bad += 1;
    if (new Set(a).size === a.length) shapes += 1;
  }
  ok(
    'C1 位图并集与 Set 并集在 200 组随机倒排上逐位相同（含重复、乱序、一问全空手）',
    bad === 0,
    `不一致 ${bad}/200 · 无重复的组 ${shapes}/200`,
  );
}

// 刻意让标题与正文错开，字段命中位才不是白给。
const DOCS = [
  mk('0mcnd00001', 'astra', 2, { title: 'astra' }),
  mk('0mcnd00002', 'astra bravo', 2, { title: 'bravo' }),
  mk('0mcnd00003', 'astra bravo cygnus dorado', 2, { title: 'cygnus title' }),
  mk('0mcnd00004', 'zulu zulu', 2),
  mk('0mcnd00005', 'astra bravo cygnus', 2, { keywords: ['dorado'] }),
  mk('0mcnd00006', 'dorado astra', 3, { title: 'dorado', keywords: ['astra'] }),
];
const QS = ['astra', 'astra bravo', 'cygnus dorado', 'zulu', 'astra bravo cygnus dorado', 'dorado'];

// ── C2 ───────────────────────────────────────────────────────────────────
{
  let diff = 0;
  const rows = [];
  for (const q of QS) {
    const on = JSON.stringify(search(q, DOCS, { k: 10, explain: true, now: NOW }));
    const off = JSON.stringify(search(q, DOCS, { k: 10, explain: true, now: NOW, inverted: false }));
    if (on !== off) diff += 1;
    rows.push(`${q}=${on === off ? '同' : '差'}`);
  }
  ok(
    'C2 倒排开着（走候选表）与倒排关着（逐条扫）逐位相同：两条独立实现互相验',
    diff === 0,
    `${QS.length} 问 · ${rows.join(' ')}`,
  );
}

// ── C3 ───────────────────────────────────────────────────────────────────
{
  // 六条记忆的关键词两两共现（≥2 次、条件概率 1.0），共现扩词表里就会有 alpha ⇄ beta 这座桥。
  // 正文里必须真出现 alpha：扩词的门是「这个词在库里 df > 0」，只写在关键词里不算；
  // 而 cap = floor(n × 0.35)，小库里词一出现就超门，所以要垫 32 条填充（n=39 → cap=13，df(beta)=7）。
  // 桥接回来的那条（正文只有 beta）分低，会被 `trimByBand` 剪掉——所以这里不看回执多了谁，
  // 看的是**候选表真被扩词那一段塞过东西**：开桥时 `trimmed` 记 1，关桥时一条都不剪。
  const SYN = [];
  for (let i = 0; i < 6; i++) {
    SYN.push(mk(`0msyn0${String(i).padStart(4, '0')}`, 'alpha only text', 2, { keywords: ['alpha', 'beta'] }));
  }
  SYN.push(mk('0msyn09000', 'beta only text', 2));
  for (let i = 0; i < 32; i++) {
    SYN.push(mk(`0mfll0${String(i).padStart(4, '0')}`, `filler${i} words here`, 2));
  }
  const on = search('alpha', SYN, { k: 50, explain: true, now: NOW });
  const off = search('alpha', SYN, { k: 50, explain: true, now: NOW, synBridge: false });
  const bridged = on.trimmed === 1 && off.trimmed === void 0;
  // 桥只加候选、不加名次：回执的**条与序**逐位相同（分数会被桥抬高，那是扩词自己的账）。
  const same = JSON.stringify(on.map((h) => h.id)) === JSON.stringify(off.map((h) => h.id));
  const dedupeTwice = (ENGINE.split('if (candAt[di] === 0) { candAt[di] = 1; candList.push(di); }').length - 1) === 2;
  ok(
    'C3 同义扩词那条路也进候选表：开桥时多出一条候选（trimmed 0→1）、关桥时没有，且回执的条与序逐位相同',
    bridged && same && dedupeTwice,
    `开桥 trimmed=${on.trimmed} · 关桥 trimmed=${off.trimmed} · 条序一致=${same} · 去重两处=${dedupeTwice}`,
  );
}

// ── C4 ───────────────────────────────────────────────────────────────────
{
  const r = search('qqqq zzzz', DOCS, { k: 10, explain: true, now: NOW });
  const rOff = search('qqqq zzzz', DOCS, { k: 10, explain: true, now: NOW, inverted: false });
  const clean = [...r, ...rOff].every((h) => Number.isFinite(h.score) && Number.isFinite(h.explain.cover));
  ok(
    'C4 空手问句：一个词都不在库里时回执为空、不留 NaN（0/0 漏出来就会是 NaN）',
    r.length === 0 && rOff.length === 0 && clean,
    `命中 ${r.length}/${rOff.length} 条`,
  );
}

// ── C5 ───────────────────────────────────────────────────────────────────
{
  let seed = 20261127;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const VOC = ['astra', 'bravo', 'cygnus', 'dorado', 'eridan', 'fornax', 'gemini', 'hydra', 'indus', 'lyra', 'mensa',
    'norma', 'orion', 'pavo', 'quasar', 'rigel', 'sirius', 'tucana', 'vela', 'volans'];
  const big = [];
  for (let d = 0; d < 300; d++) {
    const words = [];
    const len = 6 + Math.floor(rnd() * 10);
    for (let i = 0; i < len; i++) words.push(VOC[Math.floor(rnd() * VOC.length)]);
    const extra = {};
    if (d % 3 === 0) extra.title = `${VOC[d % VOC.length]} ${VOC[(d + 5) % VOC.length]}`;
    if (d % 5 === 0) extra.keywords = [VOC[(d + 11) % VOC.length]];
    big.push(mk(`0mcnd1${String(d).padStart(4, '0')}`, words.join(' '), 1 + (d % 4), extra));
  }
  const qs = [];
  for (let i = 0; i < 30; i++) {
    const parts = [];
    const n = 2 + Math.floor(rnd() * 4);
    for (let j = 0; j < n; j++) parts.push(VOC[Math.floor(rnd() * VOC.length)]);
    if (i % 7 === 0) parts.push('nothinghere');
    qs.push(parts.join(' '));
  }
  let diff = 0;
  let diffAdapt = 0;
  let nonEmpty = 0;
  for (const q of qs) {
    const a = JSON.stringify(search(q, big, { k: 8, explain: true, now: NOW }));
    const b = JSON.stringify(search(q, big, { k: 8, explain: true, now: NOW, inverted: false }));
    if (a !== b) diff += 1;
    if (JSON.parse(a).length > 0) nonEmpty += 1;
    // 换尺子那趟会再进 scoreCandSet：候选表只许被读，不许被写坏。
    const c = JSON.stringify(search(q, big, { k: 8, explain: true, now: NOW, adaptiveIdf: true, idfScaleGate: 10 }));
    const d = JSON.stringify(search(q, big, { k: 8, explain: true, now: NOW, adaptiveIdf: true, idfScaleGate: 10, inverted: false }));
    if (c !== d) diffAdapt += 1;
  }
  ok(
    'C5 大一点的库（300 条 × 30 问）两条路仍逐位相同，自适应换尺子那趟也相同——重复词、df=0 都在',
    diff === 0 && diffAdapt === 0 && nonEmpty >= 25,
    `${qs.length} 问 · 首趟不一致 ${diff} · 换尺子不一致 ${diffAdapt} · 有回的 ${nonEmpty}`,
  );
}

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILED'} · probe-cand ${pass}/${pass + fail}`);
process.exit(fail === 0 ? 0 : 1);
