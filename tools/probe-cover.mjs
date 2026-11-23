// [macro-fusion 0.6.15] 判据：覆盖度不许「每条 × 每个问句词」重算一遍。
//
// 背景（`docs/INTERNAL.md` 9.214）：0.6.14 之后 `scanDoc` 的最大一块是覆盖度那段
// `for (const term of qKept) if (tfi.has(term)) cover += idfAt(term);`——行级读数里
// `index.js:3529` 573.9ms（10,000 条 / 300 问，总采样 4,216.7ms）。它做的是「这条命中了几成问句词」，
// 而倒排 `postings` 本来就记着「每个词出现在哪些条里」，同一笔账可以顺着倒排往回加一遍：
// 工作量从「候选数 × 问句词数」降到「这些词的出现次数之和」。
//
// 这一刀的风险不是慢，是**账算错**：加的顺序一变浮点和就变（哪怕差 1e-16，排名也会翻），
// 自适应换尺子后 idf 变了却没重算，覆盖度就停在旧尺子上。所以这个探针要证明六件事：
//
//   C0 两条路都在：倒排账（coverAcc）+ 倒排缺席时的逐条查表（退回路口径未丢）
//   C1 负对照：倒排开着（账）与倒排关着（逐条查）逐位相同——两条独立实现互相验
//   C2 覆盖度语义没变：全命中的那条 = 1，命中多的严格大于命中少的，且都在 [0,1]
//   C3 自适应换尺子后账跟着换：`adaptive` × 倒排开关四种组合，账与逐条查逐位相同
//   C4 空手问句：一个词都不在库里时回执为空、不留 NaN（0/0 不许漏出来）
//   C5 大一点的库（300 条 × 30 问）两条路仍逐位相同——重复词、df=0、共现都在
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
  const hasAcc = ENGINE.includes('const buildCoverAcc = () => {') && ENGINE.includes('coverAcc[p[pi]] += w;');
  const hasFallback = ENGINE.includes('for (let qi = 0; qi < qKept.length; qi++) if (tfi.has(qKept[qi])) cover += qKeptIdf[qi];');
  const usesAcc = ENGINE.includes('coverOf[di] = Math.min(1, coverAcc[di] / qIdfSum);');
  ok(
    'C0 两条路都在：倒排账 + 倒排缺席时的逐条查表（退回路口径没被顺手删掉）',
    hasAcc && hasFallback && usesAcc,
    `账=${hasAcc} · 逐条查=${hasFallback} · 走账=${usesAcc}`,
  );
}

const DOCS = [
  mk('0mcov00001', 'astra'),
  mk('0mcov00002', 'astra bravo'),
  mk('0mcov00003', 'astra bravo cygnus dorado'),
  mk('0mcov00004', 'zulu zulu'),
  mk('0mcov00005', 'astra bravo cygnus'),
  mk('0mcov00006', 'dorado astra'),
];
const Q = 'astra bravo cygnus dorado';

// ── C1 ───────────────────────────────────────────────────────────────────
{
  const on = JSON.stringify(search(Q, DOCS, { k: 10, explain: true, now: NOW }));
  const off = JSON.stringify(search(Q, DOCS, { k: 10, explain: true, now: NOW, inverted: false }));
  const covers = search(Q, DOCS, { k: 10, explain: true, now: NOW }).map((h) => h.explain.cover);
  ok(
    'C1 倒排开着（顺倒排记账）与倒排关着（逐条查表）逐位相同：两条独立实现互相验',
    on === off && covers.length > 0,
    `${on.length} 字符 · cover ${covers.join('/')}`,
  );
}

// ── C2 ───────────────────────────────────────────────────────────────────
{
  const hits = search(Q, DOCS, { k: 10, explain: true, now: NOW });
  const byId = new Map(hits.map((h) => [h.id, h.explain.cover]));
  const full = byId.get('0mcov00003');
  const c3 = byId.get('0mcov00005');
  const c2 = byId.get('0mcov00002');
  const c1 = byId.get('0mcov00001');
  const inRange = hits.every((h) => Number.isFinite(h.explain.cover) && h.explain.cover >= 0 && h.explain.cover <= 1);
  ok(
    'C2 覆盖度语义没变：全命中的那条 = 1，命中多的严格大于命中少的，且都在 [0,1]',
    full === 1 && c3 < full && c2 < c3 && c1 < c2 && inRange && !hits.some((h) => h.id === '0mcov00004'),
    `1/4=${c1} 2/4=${c2} 3/4=${c3} 4/4=${full}`,
  );
}

// ── C3 ───────────────────────────────────────────────────────────────────
{
  // 换尺子那一趟最容易漏：idf 换成双尺度了，覆盖度账还停在旧尺子上，两个口径的比值就会漏进 explain。
  // 源上钉顺序（清缓存 → 重记问句 idf → 重记覆盖度账 → 重扫），行为上钉「开两次逐位相同」和
  // 「开与关的账/逐条查两条路都一致」。
  const adStart = ENGINE.indexOf('if (opts.adaptiveIdf === true) {');
  const adEnd = adStart < 0 ? -1 : ENGINE.indexOf('adapt = { lam, cluster: cl.n };', adStart);
  const ad = adStart >= 0 && adEnd > adStart ? ENGINE.slice(adStart, adEnd) : '';
  const iCache = ad.indexOf('idfCache = new Map();');
  const iQ = ad.indexOf('refreshQidf();');
  const iAcc = ad.indexOf('buildCoverAcc();');
  const iFill = ad.indexOf('raw.fill(0);');
  const orderOk = iCache >= 0 && iQ > iCache && iAcc > iQ && iFill > iAcc;
  const base = { k: 10, explain: true, now: NOW, adaptiveIdf: true, idfScaleGate: 10 };
  const a = JSON.stringify(search(Q, DOCS, base));
  const b = JSON.stringify(search(Q, DOCS, base));
  const off = JSON.stringify(search(Q, DOCS, { ...base, inverted: false }));
  ok(
    'C3 自适应换尺子那趟先把账重记（清缓存 → 问句 idf → 覆盖度账 → 重扫），开两次逐位相同、两条路一致',
    orderOk && a === b && a === off,
    `顺序=${orderOk ? '对' : '不对'} · 两次相同=${a === b} · 账/逐条查一致=${a === off} · ${a.length} 字符`,
  );
}

// ── C4 ───────────────────────────────────────────────────────────────────
{
  const r = search('qqqq zzzz', DOCS, { k: 10, explain: true, now: NOW });
  const rOff = search('qqqq zzzz', DOCS, { k: 10, explain: true, now: NOW, inverted: false });
  const clean = [...r, ...rOff].every((h) => Number.isFinite(h.explain.cover) && Number.isFinite(h.score));
  ok(
    'C4 空手问句：一个词都不在库里时回执为空、不留 NaN（0/0 漏出来就会是 NaN）',
    r.length === 0 && rOff.length === 0 && clean,
    `命中 ${r.length}/${rOff.length} 条`,
  );
}

// ── C5 ───────────────────────────────────────────────────────────────────
{
  // 小而确定的伪随机库：重复词（tf>1）、df=0 的问句词、跨条共现都齐。
  let seed = 20261124;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const VOC = ['astra', 'bravo', 'cygnus', 'dorado', 'eridan', 'fornax', 'gemini', 'hydra', ' Indus', 'lyra']
    .map((w) => w.trim())
    .concat(['mensa', 'norma', 'orion', 'pavo', 'quasar', 'rigel', 'sirius', 'tucana', 'vela', 'volans']);
  const big = [];
  for (let d = 0; d < 300; d++) {
    const words = [];
    const len = 6 + Math.floor(rnd() * 10);
    for (let i = 0; i < len; i++) words.push(VOC[Math.floor(rnd() * VOC.length)]);
    big.push(mk(`0mcov1${String(d).padStart(4, '0')}`, words.join(' '), 1 + (d % 4)));
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
    'C5 大一点的库（300 条 × 30 问）两条路仍逐位相同——重复词、df=0、共现都在',
    diff === 0 && nonEmpty >= 25,
    `${qs.length} 问 · 不一致 ${diff} · 有回的 ${nonEmpty}`,
  );
}

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILED'} · probe-cover ${pass}/${pass + fail}`);
process.exit(fail === 0 ? 0 : 1);
