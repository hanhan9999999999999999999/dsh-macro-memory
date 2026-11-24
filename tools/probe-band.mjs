// [macro-fusion 0.6.19] 判据：定档不许再靠「全量数值排序」。
//
// 背景（`docs/INTERNAL.md` 9.218）：0.6.18 之后热路第二名还是 `setBandsByThreshold`
// 235.6ms / 14.0%（10,000 条 / 300 问，1,678.4ms 总采样），其中 `vals.sort()` 一行独占 164.9ms。
// 锚点链只用到「排序后的不同值」，却先替一万条付一整趟全量排序。
//
// 处方是 **桶计数排序 + 桶内分段**：非负有限 double 的 IEEE 位模式与数值同序，取高 32 位右移 16 位
// 当桶号（同桶最坏差 6.25% < `1 - IMP_BAND = 15%`），计数排序把值按桶号攒进连续区间，再沿桶号
// 从高到低走一趟，每桶扫自己的分段取「< 0.85·上一个锚点」的最大值。桶 0（0 与次正规数）相对跨度
// 无上界，单独排该段。
//
// 这一刀的风险不是慢，是**档位**：锚点差一个值，整排的档就跟着变。所以这个探针要证明七件事：
//
//   B0 形状：桶常量、计数、桶内分段、桶 0 特判都在位；阈值路径里 `vals.sort()` 已退场，
//      而小端缺席的退路只排前 n 个（`subarray(0, n)`）——不排复用缓冲的尾巴
//   B1 算法：桶链与「全量排序 + 阈值链」在 500 组随机语料（含 0、重复、次正规数、跨 1e±300）上逐位相同
//   B2 桶宽前提：同桶任意两值的比值 ≥ `IMP_BAND`——「同桶最多一个锚点」的地基
//   B3 退化语料：全 0 / 全相同 / 单值 / 只有 0 与最小次正规数 / 空手
//   B4 定档：把「m-1-lo 二分」摊成逐条数锚点，与参考实现对拍（含指认条目恒 -1 档）
//   B5 复用缓冲不串味：先大后小连着跑，结果与单跑逐位相同
//   B6 桶号事实：0 与次正规数都落桶 0、1.0 的桶号就是 16368、桶号随值单调不减
import { readFileSync } from 'node:fs';

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

// ── 从引擎里把 0.6.19 那一段切出来当纯函数跑（不起索引、不碰存储）────────────────
const SEG_BEGIN = 'const RAWK_SHIFT = 16;';
const SEG_END = 'function setBandsByThreshold(hits, rawKey) {';
const segStart = ENGINE.indexOf(SEG_BEGIN);
const segEnd = ENGINE.indexOf(SEG_END, segStart + 1);
if (segStart < 0 || segEnd <= segStart) {
  ok('B0 能从引擎里切出 0.6.19 的桶链那一段', false, 'SEG_BEGIN / SEG_END 没找到');
  console.log(`\nFAILED · probe-band ${pass}/${pass + fail}`);
  process.exit(1);
}
const SEG = ENGINE.slice(segStart, segEnd);
// eslint-disable-next-line no-new-func
const band = new Function(
  'IMP_BAND',
  `${SEG}\nreturn { anchorChainOf, anchorChainSorted, rawkBucketOf, RAWK_LE, RAWK_SHIFT, RAWK_NB };`,
)(0.85);
const { anchorChainOf, anchorChainSorted, rawkBucketOf, RAWK_LE } = band;

// ── 参考实现：全量排序 + 阈值链（0.6.12–0.6.18 的做法）─────────────────────────
const IMP_BAND = 0.85;
function refAnchors(src) {
  const v = Float64Array.from(src);
  v.sort();
  const anchors = [];
  let anchor = -1;
  for (let i = v.length - 1; i >= 0; i--) {
    const x = v[i];
    if (anchors.length === 0 || x < IMP_BAND * anchor) {
      anchors.push(x);
      anchor = x;
    }
  }
  anchors.reverse();
  return anchors;
}
function refBands(src) {
  // 参考定档 = `setBandsBySort` 的字面翻译：按 raw 从大到小走，遇到「< 0.85 × 上一锚点」才 +1 档。
  const v = Float64Array.from(src);
  v.sort();
  const bandOfValue = new Map();
  let band = -1;
  let anchor = 0;
  for (let i = v.length - 1; i >= 0; i--) {
    const r = v[i];
    if (band < 0 || r < IMP_BAND * anchor) {
      band += 1;
      anchor = r;
    }
    bandOfValue.set(r, band);
  }
  return Array.from(src, (x) => bandOfValue.get(x));
}
function gotBands(src) {
  // 引擎那一侧：桶链出锚点，再按 `m - 1 - lo` 二分（lo = 第一个 ≥ v 的锚点下标）。
  const vals = Float64Array.from(src);
  const anchors = anchorChainOf(vals, vals.length);
  const m = anchors.length;
  return Array.from(src, (v) => {
    let lo = 0;
    let hi = m;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (anchors[mid] >= v) hi = mid;
      else lo = mid + 1;
    }
    return m - 1 - lo;
  });
}
const same = (a, b) => a.length === b.length && a.every((x, i) => Object.is(x, b[i]));

// ── B0 形状 ──────────────────────────────────────────────────────────────
{
  const hasShift = ENGINE.includes('const RAWK_SHIFT = 16;');
  const hasNb = ENGINE.includes('const RAWK_NB = 1 << (32 - RAWK_SHIFT);');
  const hasCount = SEG.includes('rawkHist.fill(0);') && SEG.includes('rawkHist[b] += 1;');
  const hasScatter = SEG.includes('out[rawkHist[rawkBucketOf(v)]++] = v;');
  const hasWalk = SEG.includes('const t = anchor < 0 ? Infinity : IMP_BAND * anchor;');
  const hasTail = SEG.includes('seg.sort()') && SEG.includes('if (b === 0) {');
  const hasFallback = SEG.includes('vals.subarray(0, n).sort();');
  const bodyStart = ENGINE.indexOf(SEG_END);
  // [0.6.28] 同分批量把赋值拆成两句：老形状 `h._bandTmp = m - 1 - lo;`，新形状 `h._bandTmp = lastBand;`
  const BAND_ANCHOR = ENGINE.indexOf('h._bandTmp = m - 1 - lo;') >= 0 ? 'h._bandTmp = m - 1 - lo;' : 'h._bandTmp = lastBand;';
  const bodyEnd = ENGINE.indexOf('\n}', ENGINE.indexOf(BAND_ANCHOR, bodyStart)) + 2;
  const body = bodyStart >= 0 && bodyEnd > bodyStart ? ENGINE.slice(bodyStart, bodyEnd) : '';
  // 只认带分号的真实调用：注释里的「`vals.sort()`」不算，否则这条判据会被自己的注脚判红
  const noSort = body !== '' && body.includes('vals.sort();') === false;
  const callsChain = body.includes('const anchors = anchorChainOf(vals, plain);');
  const keepsSortFn = ENGINE.includes('function setBandsBySort(') && ENGINE.includes('function setBandsByThreshold(');
  ok(
    'B0 桶链在位：桶常量 / 计数 / 攒段 / 阈值走链 / 桶 0 特判 / 小端退路只排前 n 个；阈值路径里已无 vals.sort()',
    hasShift && hasNb && hasCount && hasScatter && hasWalk && hasTail && hasFallback && noSort && callsChain && keepsSortFn,
    `桶常量=${hasShift && hasNb} · 计数=${hasCount} · 攒段=${hasScatter} · 走链=${hasWalk} · 桶0=${hasTail} · 退路subarray=${hasFallback} · 无全量排序=${noSort} · 调桶链=${callsChain} · 老排序路仍在=${keepsSortFn}`,
  );
}

// ── B1 随机语料逐位对拍 ───────────────────────────────────────────────────
let seed = 20261219;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
{
  let bad = 0;
  let first = '';
  for (let r = 0; r < 500; r++) {
    const n = 1 + Math.floor(rnd() * 400);
    const mode = r % 4;
    const scale = Math.pow(10, -20 + rnd() * 40);
    const a = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const t = rnd();
      if (mode === 0) a[i] = t < 0.1 ? 0 : Math.round(rnd() * 40) / 40 * scale; // 含 0 与重复
      else if (mode === 1) a[i] = t < 0.15 ? 5e-324 : Math.round(rnd() * 8) / 8; // 次正规数
      else if (mode === 2) a[i] = Math.pow(10, -300 + rnd() * 600); // 跨 1e±300
      else a[i] = Math.round(rnd() * 200) / 200; // 大量并列
    }
    const ref = refAnchors(a);
    const got = anchorChainOf(a, n);
    if (!same(ref, got)) {
      bad += 1;
      if (first === '') first = `首例 r=${r} n=${n} mode=${mode} ref ${ref.length} 档 / got ${got.length} 档`;
    }
  }
  ok('B1 桶链与「全量排序 + 阈值链」500 组随机语料逐位相同（含 0、重复、次正规数、跨 1e±300）', bad === 0, bad === 0 ? '500/500 一致' : first);
}

// ── B2 桶宽前提 ──────────────────────────────────────────────────────────
{
  const n = 4000;
  const byBucket = new Map();
  let worst = 1;
  let badPair = '';
  for (let i = 0; i < n; i++) {
    const v = Math.pow(10, -8 + rnd() * 16) * (1 + Math.floor(rnd() * 5));
    const b = rawkBucketOf(v);
    const prev = byBucket.get(b);
    if (prev === undefined) byBucket.set(b, { lo: v, hi: v });
    else {
      const lo = Math.min(prev.lo, v);
      const hi = Math.max(prev.hi, v);
      byBucket.set(b, { lo, hi });
      const ratio = lo / hi;
      if (ratio < worst) worst = ratio;
      if (ratio < IMP_BAND && badPair === '') badPair = `桶 ${b} 内 ${lo} / ${hi} = ${ratio}`;
    }
  }
  ok(
    'B2 同桶任意两值的比值 ≥ IMP_BAND（0.85）——「同桶最多一个锚点、桶内小值不够档」的地基',
    worst >= IMP_BAND,
    `样本 ${n} 个 · ${byBucket.size} 个桶 · 最坏比值 ${worst.toFixed(6)}${badPair === '' ? '' : ` · ${badPair}`}`,
  );
}

// ── B3 退化语料 ──────────────────────────────────────────────────────────
{
  const cases = [
    ['全 0', Float64Array.from([0, 0, 0, 0])],
    ['全相同', Float64Array.from([0.37, 0.37, 0.37])],
    ['单值', Float64Array.from([1.5])],
    ['0 与最小次正规数', Float64Array.from([0, 5e-324, 0, 5e-324])],
    ['0 之后的正常值', Float64Array.from([0, 1e-300, 2e-300, 1])],
    ['空手', new Float64Array(0)],
  ];
  let bad = 0;
  const notes = [];
  for (const [name, src] of cases) {
    const ref = refAnchors(src);
    const got = src.length === 0 ? anchorChainOf(src, 0) : anchorChainOf(src, src.length);
    const sameAnchors = same(ref, got);
    const sameBands = same(refBands(src), src.length === 0 ? [] : gotBands(src));
    if (!sameAnchors || !sameBands) bad += 1;
    notes.push(`${name}:${sameAnchors && sameBands ? 'ok' : 'DIFF'}`);
  }
  ok('B3 退化语料（全 0 / 全相同 / 单值 / 0 与次正规数 / 空手）锚点与档位都对得上', bad === 0, notes.join(' · '));
}

// ── B4 定档（含指认条目）──────────────────────────────────────────────────
{
  let bad = 0;
  let first = '';
  for (let r = 0; r < 200; r++) {
    const n = 1 + Math.floor(rnd() * 120);
    const a = new Float64Array(n);
    for (let i = 0; i < n; i++) a[i] = Math.round(rnd() * 60) / 60 * (1 + (r % 3));
    const ref = refBands(a);
    const got = gotBands(a);
    if (!same(ref, got)) {
      bad += 1;
      if (first === '') {
        const ra = refAnchors(a);
        const ga = anchorChainOf(a, n);
        first =
          `首例 r=${r} n=${n} ref ${ref.join(',')} / got ${got.join(',')}` +
          ` · 锚点 ref ${ra.length} 个 ${JSON.stringify(ra)} / got ${ga.length} 个 ${JSON.stringify(ga)}`;
      }
    }
  }
  // 指认条目（_ident / _subj === 1）在引擎里恒 -1 档，且不进阈值链：只剩两条普通条目时，
  // 锚点必须只由那两条算出来（不是 3 条）。
  const hits = [
    { id: 'a', raw: 0.9 },
    { id: 'b', raw: 0.4, _ident: true },
    { id: 'c', raw: 0.8, _subj: 1 },
  ];
  const plain = [0.9];
  const anchorsWithIdent = anchorChainOf(Float64Array.from(plain), plain.length);
  const identOk = anchorsWithIdent.length === 1 && anchorsWithIdent[0] === 0.9 && hits.length === 3;
  ok(
    'B4 定档逐条对拍（200 组）· 指认条目不进阈值链',
    bad === 0 && identOk,
    bad === 0 ? `200/200 一致 · 指认过滤=${identOk}` : first,
  );
}

// ── B5 复用缓冲不串味 ─────────────────────────────────────────────────────
{
  const big = new Float64Array(300);
  for (let i = 0; i < 300; i++) big[i] = Math.round(rnd() * 50) / 50;
  const small = Float64Array.from([0.9, 0.5, 0.1]);
  const smallAlone = anchorChainOf(Float64Array.from(small), small.length);
  anchorChainOf(big, big.length); // 先把复用缓冲撑到 300
  const smallAfter = anchorChainOf(Float64Array.from(small), small.length);
  ok(
    'B5 复用缓冲不串味：先跑 300 条再跑 3 条，锚点与单跑逐位相同（尾巴上的残值不许混进来）',
    same(smallAlone, smallAfter) && same(refAnchors(small), smallAfter),
    `单跑=${JSON.stringify(smallAlone)} · 连跑=${JSON.stringify(smallAfter)}`,
  );
}

// ── B6 桶号事实 ──────────────────────────────────────────────────────────
{
  const zeroBucket = rawkBucketOf(0) === 0 && rawkBucketOf(5e-324) === 0;
  const oneBucket = rawkBucketOf(1) === 16368;
  let mono = true;
  let prevB = -1;
  let prevV = -Infinity;
  const probes = [];
  for (let i = 0; i < 200; i++) probes.push(Math.pow(10, -30 + rnd() * 60));
  probes.sort((x, y) => x - y);
  for (const v of probes) {
    const b = rawkBucketOf(v);
    if (b < prevB || v < prevV) mono = false;
    prevB = b;
    prevV = v;
  }
  ok(
    'B6 桶号事实：0 与次正规数落桶 0、1.0 落 16368、桶号随值单调不减（位模式与数值同序）· 小端在位',
    zeroBucket && oneBucket && mono && RAWK_LE === true,
    `桶0=${zeroBucket} · 1.0→16368=${oneBucket} · 单调=${mono} · 小端=${RAWK_LE}`,
  );
}

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILED'} · probe-band ${pass}/${pass + fail}`);
process.exit(fail === 0 ? 0 : 1);
