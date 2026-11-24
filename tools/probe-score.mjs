// [macro-fusion 0.6.16] 判据：打分不许「每条 × 每个问句词」地查表。
//
// 背景（`docs/INTERNAL.md` 9.215）：0.6.15 之后 `scanDoc` 的头号热点变成了打分循环里的
// `const f = tfi.get(term);`——`index.js:3564` 535.3ms（10,000 条 / 300 问）。它做的事是
// 「这条命中了几次这个词 × 这个词有多稀罕 × 命中的是标题还是关键词」，而这套算式的两个输入
// （该条该词的词频、该条把这个词放在哪个字段）在建索引时就已经定死，倒排 `postings` 顺手就能记下来。
// 于是打分倒过来扫：让每个问句词只碰「它真出现过」的那些条，把贡献加进 `raw[di]`。
//
// 这一刀的风险同样不是慢，是**账算错**：
//   · 每条拿到的加数顺序必须还是 qLoop 原序，不然浮点和就变（排名会翻）；
//   · 字段权重里 `FIELD_KW_W` 是每问参数（`opts.fieldKwW`），不能在建索引时预乘进去；
//   · 自适应换尺子会再打一遍分，候选表要是没重铺，同一条会被收尾循环算两遍。
// 所以这个探针要证明六件事：
//
//   S0 两条路都在：顺倒排打分（scoreCandSet）+ 逐条扫（scanDoc）的退路没被顺手删掉
//   S1 负对照：倒排开着（扫倒排）与倒排关着（逐条扫）逐位相同——两条独立实现互相验
//   S2 字段命中位等价于 titleSets/kwSets：默认 / 关键词权重 0 / 关字段加成 三档都对得上
//   S3 自适应换尺子那趟先重铺候选（源上钉顺序）+ 开两次逐位相同 + 两条路一致
//   S4 空手问句：一个词都不在库里时回执为空、不留 NaN
//   S5 大一点的库（300 条 × 30 问）两条路仍逐位相同——重复词（tf>1）、df=0 都在
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

// ── S0 ───────────────────────────────────────────────────────────────────
{
  const hasPath =
    ENGINE.includes('const scoreCandSet = () => {') &&
    // [0.6.29] `k1 + 1` 提成循环外的 `k1p1`，两种写法都认。
    (ENGINE.includes('raw[di] += idf0 * fw * (f * (k1 + 1) / (f + kDen[di]));') ||
      ENGINE.includes('raw[di] += idf0 * fw * (f * k1p1 / (f + kDen[di]));')) &&
    // [0.6.34] 候选表从 `[]` + push 换成定长 `Int32Array` + 游标；老写法的 `candArr.length = 0;`
    // 与候选副本一起撤了，这里改认新形状（旧的仍认，便于回滚时不必改探针）。
    (ENGINE.includes('const candBuf = candAt === null ? null : scratch === null ? new Int32Array(docs.length) : scratch.cand;') ||
      ENGINE.includes('candArr.length = 0;'));
  const hasIndex =
    ENGINE.includes('p.f.push(v);') &&
    ENGINE.includes('p.t.push((ts !== null && ts.has(t) ? 1 : 0) | (ks !== null && ks.has(t) ? 2 : 0));');
  const hasFallback = (ENGINE.split('raw[di] = scanDoc(di);').length - 1) === 2;
  ok(
    'S0 两条路都在：顺倒排打分 + 逐条扫的退路（首趟与换尺子那趟都留着退路）',
    hasPath && hasIndex && hasFallback,
    `扫倒排=${hasPath} · 倒排记词频/字段=${hasIndex} · 退路两处=${hasFallback}`,
  );
}

// 标题与关键词刻意和正文错开，字段命中位才不是白给。
const DOCS = [
  mk('0msco00001', 'astra', 2, { title: 'astra' }),
  mk('0msco00002', 'astra bravo', 2, { title: 'bravo' }),
  mk('0msco00003', 'astra bravo cygnus dorado', 2, { title: 'cygnus title' }),
  mk('0msco00004', 'zulu zulu', 2),
  mk('0msco00005', 'astra bravo cygnus', 2, { keywords: ['dorado'] }),
  mk('0msco00006', 'dorado astra', 3, { title: 'dorado', keywords: ['astra'] }),
];
const Q = 'astra bravo cygnus dorado';

// ── S1 ───────────────────────────────────────────────────────────────────
{
  const on = JSON.stringify(search(Q, DOCS, { k: 10, explain: true, now: NOW }));
  const off = JSON.stringify(search(Q, DOCS, { k: 10, explain: true, now: NOW, inverted: false }));
  const scores = search(Q, DOCS, { k: 10, explain: true, now: NOW }).map((h) => h.score.toFixed(4));
  const finite = search(Q, DOCS, { k: 10, explain: true, now: NOW }).every((h) => Number.isFinite(h.score));
  ok(
    'S1 倒排开着（扫倒排打分）与倒排关着（逐条扫）逐位相同：两条独立实现互相验',
    on === off && scores.length > 0 && finite,
    `${on.length} 字符 · score ${scores.join('/')}`,
  );
}

// ── S2 ───────────────────────────────────────────────────────────────────
{
  // 字段权重是每问参数：扫倒排那路必须照样吃 opts，不能把建索引时的默认值烧进去。
  const tiers = [{}, { fieldKwW: 0 }, { fieldKwW: 3 }, { fieldBoost: false }];
  const rows = [];
  let allSame = true;
  let spread = false;
  const firsts = new Set();
  for (const t of tiers) {
    const base = { k: 10, explain: true, now: NOW, ...t };
    const a = JSON.stringify(search(Q, DOCS, base));
    const b = JSON.stringify(search(Q, DOCS, { ...base, inverted: false }));
    if (a !== b) allSame = false;
    firsts.add(a);
    rows.push(`${JSON.stringify(t)}=${a === b ? '同' : '差'}`);
  }
  const base0 = JSON.stringify(search(Q, DOCS, { k: 10, explain: true, now: NOW }));
  spread = firsts.size > 1 && base0 !== JSON.stringify(search(Q, DOCS, { k: 10, explain: true, now: NOW, fieldBoost: false }));
  ok(
    'S2 字段命中位等价于 titleSets/kwSets：默认 / 关键词权重 0 / 权重 3 / 关字段加成 四档两条路都对得上',
    allSame && spread,
    `${rows.join(' ')} · 档间确有差异=${spread}`,
  );
}

// ── S3 ───────────────────────────────────────────────────────────────────
{
  const adStart = ENGINE.indexOf('if (opts.adaptiveIdf === true) {');
  const adEnd = adStart < 0 ? -1 : ENGINE.indexOf('adapt = { lam, cluster: cl.n };', adStart);
  const ad = adStart >= 0 && adEnd > adStart ? ENGINE.slice(adStart, adEnd) : '';
  const iCache = ad.indexOf('idfCache = new Map();');
  const iQ = ad.indexOf('refreshQidf();');
  const iAcc = ad.indexOf('buildCoverAcc();');
  const iFill = ad.indexOf('raw.fill(0);');
  const iScore = ad.indexOf('scoreCandSet();');
  const orderOk = iCache >= 0 && iQ > iCache && iAcc > iQ && iFill > iAcc && iScore > iFill;
  const base = { k: 10, explain: true, now: NOW, adaptiveIdf: true, idfScaleGate: 10 };
  const a = JSON.stringify(search(Q, DOCS, base));
  const b = JSON.stringify(search(Q, DOCS, base));
  const off = JSON.stringify(search(Q, DOCS, { ...base, inverted: false }));
  ok(
    'S3 自适应换尺子那趟先把候选重铺再打分（清缓存 → 问句 idf → 覆盖度账 → 清账 → 打分），开两次逐位相同、两条路一致',
    orderOk && a === b && a === off,
    `顺序=${orderOk ? '对' : '不对'} · 两次相同=${a === b} · 扫倒排/逐条一致=${a === off} · ${a.length} 字符`,
  );
}

// ── S4 ───────────────────────────────────────────────────────────────────
{
  const r = search('qqqq zzzz', DOCS, { k: 10, explain: true, now: NOW });
  const rOff = search('qqqq zzzz', DOCS, { k: 10, explain: true, now: NOW, inverted: false });
  const clean = [...r, ...rOff].every((h) => Number.isFinite(h.score) && Number.isFinite(h.explain.cover));
  ok(
    'S4 空手问句：一个词都不在库里时回执为空、不留 NaN（0/0 漏出来就会是 NaN）',
    r.length === 0 && rOff.length === 0 && clean,
    `命中 ${r.length}/${rOff.length} 条`,
  );
}

// ── S5 ───────────────────────────────────────────────────────────────────
{
  // 小而确定的伪随机库：重复词（tf>1）、df=0 的问句词、标题/关键词命中都齐。
  let seed = 20261125;
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
    big.push(mk(`0msco1${String(d).padStart(4, '0')}`, words.join(' '), 1 + (d % 4), extra));
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
  let nonEmpty = 0;
  for (const q of qs) {
    const a = JSON.stringify(search(q, big, { k: 8, explain: true, now: NOW }));
    const b = JSON.stringify(search(q, big, { k: 8, explain: true, now: NOW, inverted: false }));
    if (a !== b) diff += 1;
    if (JSON.parse(a).length > 0) nonEmpty += 1;
  }
  ok(
    'S5 大一点的库（300 条 × 30 问）两条路仍逐位相同——重复词、df=0、标题/关键词命中都在',
    diff === 0 && nonEmpty >= 25,
    `${qs.length} 问 · 不一致 ${diff} · 有回的 ${nonEmpty}`,
  );
}

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILED'} · probe-score ${pass}/${pass + fail}`);
process.exit(fail === 0 ? 0 : 1);
