// [macro-fusion 0.6.17] 判据：扫描期只铺「够定档」的瘦 hit，入选的 k 条事后水化。
//
// 背景（`docs/INTERNAL.md` 9.216）：0.6.16 之后 search 的头号开销是那条十四字段的 hit 对象字面量
// （`index.js:3858` 起，行级读数各 134–176ms / 300 问，合计约 1.07s）——可 `bandize` 与
// `trimByBand` 最后只留前 k 条，绝大多数对象的十来个字段从头到尾没人读。处方是扫描期只铺
// `_subj` / `_raw` / `cover` / `id` / `updated_at` / `score` + 下标 `_di`，截断之后再按原字面量的
// 键序把入选条水化（`matHitOf`）。
//
// 这一刀的风险不是慢，是**回执变了**：少一个字段、键序挪位、`_di` 漏出去、`trimmed` 丢了、
// 或者补分（标识符 / 层级意图 / 断言密度 / 现状仓）在水化时被重算掉。所以这个探针要证明六件事：
//
//   H0 两条路都在：瘦对象 + 水化（`leanHit` / `matHitOf`），完整字面量那条退路没被删
//   H1 等价：瘦路的回执与 explain 那条完整字面量（剥掉 explain）逐字节相同——含键序
//   H2 keepBand 那条路（searchHybrid 融合用）剥掉 `_raw`/`_bandTmp`/`_band`/`_ident`/`_dense` 后同样相同
//   H3 水化不泄漏：回执里没有 `_di`，`trimmed` 这个非枚举属性还在（挂数组上的折掉条数）
//   H4 可选字段照旧省略：docs 里 `void 0` 的 keywords/project/created_at/status/source_session 不许被写成空值
//   H5 空手问句与 300 条 × 30 问：两条路逐位相同，不一致 0
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

// ── H0 ───────────────────────────────────────────────────────────────────
{
  const hasLean =
    ENGINE.includes('const leanHit = opts.explain !== true && opts.keepBand !== true;') &&
    ENGINE.includes('const matHitOf = (h, di) => {') &&
    ENGINE.includes('_di: di');
  const hasHydrate =
    ENGINE.includes('const outHits = trimByBand(hits, k, opts);') &&
    ENGINE.includes('outHits[hi] = matHitOf(h, di);') &&
    ENGINE.includes('if (leanHit) {');
  ok('H0 两条路都在：瘦对象（leanHit / matHitOf / _di）+ 截断后水化，完整字面量那条还在', hasLean && hasHydrate, `瘦=${hasLean} · 水化=${hasHydrate}`);
}

const stripExplain = (hits) => hits.map((h) => {
  const c = { ...h };
  delete c.explain;
  return c;
});
const stripBand = (hits) => hits.map((h) => {
  const c = { ...h };
  delete c._raw;
  delete c._bandTmp;
  delete c._band;
  delete c._ident;
  delete c._dense;
  return c;
});
const j = (v) => JSON.stringify(v);

const DOCS = [
  mk('a1', '基线要跑几轮才收敛，跑三轮就到头了', 3),
  mk('a2', '把一个文件拆开之后怎么确认行为一点没变', 2),
  mk('a3', '打分顺着倒排累加，不再逐条查表', 2),
  mk('a4', '命中对象先铺瘦的，截断之后再水化', 4),
  mk('a5', '空手问句不许漏出 NaN', 1),
  mk('a6', '冷建索引只付一次钱', 2),
];

const QS = ['基线要跑几轮才收敛', '把一个文件拆开之后怎么确认行为没变', '打分怎么累加', '水化', '冷建索引', '什么都没有的问句'];

// ── H1 ───────────────────────────────────────────────────────────────────
{
  let same = 0;
  let diff = 0;
  for (const q of QS) {
    const lean = search(q, DOCS, { now: NOW, k: 3 });
    const full = stripExplain(search(q, DOCS, { now: NOW, k: 3, explain: true }));
    if (j(lean) === j(full)) same += 1;
    else diff += 1;
  }
  ok('H1 瘦路回执与 explain 那条完整字面量（剥掉 explain）逐字节相同：含键序', diff === 0 && same === QS.length, `${same}/${QS.length} 同 · 不一致 ${diff}`);
}

// ── H2 ───────────────────────────────────────────────────────────────────
{
  let same = 0;
  let diff = 0;
  for (const q of QS) {
    const lean = search(q, DOCS, { now: NOW, k: 3 });
    const band = stripBand(search(q, DOCS, { now: NOW, k: 3, keepBand: true }));
    if (j(lean) === j(band)) same += 1;
    else diff += 1;
  }
  ok('H2 keepBand 那条路（融合用）剥掉 _raw/_bandTmp/_band/_ident/_dense 后与瘦路相同', diff === 0 && same === QS.length, `${same}/${QS.length} 同 · 不一致 ${diff}`);
}

// ── H3 ───────────────────────────────────────────────────────────────────
{
  const set3 = [
    mk('y0', '水化 字段'),
    mk('y1', '水化 字段 附加'),
    mk('y2', '水化 字段 别的'),
    ...Array.from({ length: 17 }, (_, i) => mk(`y${i + 3}`, `水化 单独${i}`)),
  ];
  const lean = search('水化 字段', set3, { now: NOW, k: 10, minKeep: 1 });
  const full = stripExplain(search('水化 字段', set3, { now: NOW, k: 10, minKeep: 1, explain: true }));
  const noDi = lean.every((h) => !('_di' in h));
  const keptRaw = lean.every((h) => h._raw === void 0);
  // `trimmed` / `rescueAdded` 挂在数组上的非枚举属性，水化是原地替换元素，属性必须原样留着。
  const descOf = (arr, key) => {
    const d = Object.getOwnPropertyDescriptor(arr, key);
    return d === void 0 ? '无' : `值=${String(d.value)}/可枚举=${d.enumerable}`;
  };
  const sameProps = descOf(lean, 'trimmed') === descOf(full, 'trimmed') && descOf(lean, 'rescueAdded') === descOf(full, 'rescueAdded');
  ok('H3 水化不泄漏：回执里没有 _di / _raw，数组上的 trimmed / rescueAdded 非枚举属性与完整路逐项相同', noDi && keptRaw && sameProps, `_di=${noDi} · _raw=${keptRaw} · 属性=${sameProps} · ${descOf(lean, 'trimmed')} / ${descOf(lean, 'rescueAdded')}`);
}

// ── H4 ───────────────────────────────────────────────────────────────────
{
  const sparse = [
    { id: 's1', level: 'fact', title: 't', content: '可选字段一个都不带，水化也不许补上', importance: 2, updated_at: 1795000000000 },
    mk('s2', '可选字段全带的那条：关键词 项目 创建时间 状态 会话', 3),
  ];
  const hits = search('可选字段一个都不带', sparse, { now: NOW, k: 2 });
  const h1 = hits.find((h) => h.id === 's1') ?? {};
  const h2 = hits.find((h) => h.id === 's2') ?? {};
  const sparseOk = !('keywords' in h1) && !('project' in h1) && !('created_at' in h1) && !('status' in h1) && !('source_session' in h1);
  const fullOk = Array.isArray(h2.keywords) && h2.project === 'p' && h2.created_at === 1795000000000 && h2.status === 'active';
  ok('H4 可选字段照旧省略：docs 里没有的五个字段不许被写成空值，有的照旧透传', sparseOk && fullOk, `瘦条=${sparseOk} · 全带=${fullOk}`);
}

// ── H5 ───────────────────────────────────────────────────────────────────
{
  const empty = search('zzzqqqxxx', DOCS, { now: NOW, k: 3 });
  const emptyOk = empty.length === 0;

  let seed = 20261124;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const words = ['水化', '瘦对象', '倒排', '覆盖度', '定档', '截断', '字段', '键序', '补分', '空回', '索引', '冷建'];
  const big = Array.from({ length: 300 }, (_, i) => {
    const n = 2 + Math.floor(rnd() * 4);
    const parts = [];
    for (let t = 0; t < n; t++) parts.push(words[Math.floor(rnd() * words.length)]);
    return mk(`b${i}`, parts.join('') + (i % 7 === 0 ? 'nothinghere' : ''), 1 + Math.floor(rnd() * 4), i % 5 === 0 ? { keywords: ['k'] } : {});
  });
  let diff = 0;
  let withHits = 0;
  for (let qi = 0; qi < 30; qi++) {
    const a = 1 + Math.floor(rnd() * 3);
    const b = 1 + Math.floor(rnd() * 3);
    const q = words[Math.floor(rnd() * words.length)] + words[Math.floor(rnd() * words.length)] + (rnd() < 0.3 ? 'nothinghere' : '');
    const lean = search(q, big, { now: NOW, k: 1 + (a + b) % 5 });
    const full = stripExplain(search(q, big, { now: NOW, k: 1 + (a + b) % 5, explain: true }));
    if (lean.length > 0) withHits += 1;
    if (j(lean) !== j(full)) diff += 1;
  }
  ok('H5 空手问句回执为空；300 条 × 30 问两条路仍逐位相同', emptyOk && diff === 0 && withHits === 30, `空回=${empty.length} 条 · 30 问 · 不一致 ${diff} · 有回的 ${withHits}`);
}

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILED'} · probe-hydrate ${pass}/${pass + fail}`);
if (fail > 0) process.exitCode = 1;
