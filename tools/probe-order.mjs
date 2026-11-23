// [macro-fusion 0.6.12] 判据：定序只排前 k 不许改任何一名的顺序。
//
// 背景（`docs/INTERNAL.md` 9.211）：bandize 以前对全量 hits 排两遍，而三个调用点接下来
// 都只取前 k 条。改成「档位仍按全量算 + 有界堆选前 k」之后，唯一需要证明的就是
// **输出与「全量排序再取前 k」逐位相同**。这个探针拿老实现（参考实现，原样抄在下面）
// 跟新实现对拍，语料、分数、时间戳、id 全部随机。
//
//   O1 500 组随机语料 × 六种 k：前 k 条的 id/score/档位与参考实现逐位相同
//   O2 hits 被截到 min(k, n)：不多不少
//   O3 入选条目的 `_band` 与 `explain.band` 与参考一致，且没有残留的 `_bandTmp`
//   O4 k<=0 / undefined / 大于总数：退回全序，长度与顺序都跟参考一致
//   O5 同分同时间：按 id 自然序（数字段按数值），与参考一致
//   O6 指认档（`_ident` / `_subj===1`）永远在第 -1 档，与参考一致
//   O7 语料换序：前 k 不变（定序只看数据，不看下标）
//   O8 能红证明：把有界堆的比较改成 `<=`（等于「并列也不替换」）后，参考实现对拍会红
import { bandize } from '../vendor/meow-memory/lib/index.js';

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

const IMP_BAND = 0.85;

function rnd(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function stampOf(h) {
  const v = h === null || h === undefined ? undefined : h.updated_at;
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  if (typeof v === 'string' && v !== '') {
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : 0;
  }
  return 0;
}

function cmpText(a, b) {
  const x = a === null || a === undefined ? '' : String(a);
  const y = b === null || b === undefined ? '' : String(b);
  if (x === y) return 0;
  const xa = x.match(/\d+|\D+/g) ?? [];
  const ya = y.match(/\d+|\D+/g) ?? [];
  for (let i = 0; i < Math.min(xa.length, ya.length); i += 1) {
    const p = xa[i];
    const q = ya[i];
    if (p === q) continue;
    const pd = p.charCodeAt(0) >= 48 && p.charCodeAt(0) <= 57;
    const qd = q.charCodeAt(0) >= 48 && q.charCodeAt(0) <= 57;
    if (pd && qd) {
      const pn = Number(p);
      const qn = Number(q);
      if (pn !== qn) return pn < qn ? -1 : 1;
      if (p.length !== q.length) return p.length < q.length ? -1 : 1;
      continue;
    }
    return p < q ? -1 : 1;
  }
  return xa.length === ya.length ? 0 : xa.length < ya.length ? -1 : 1;
}

/** 老实现原样抄一份：全量两遍排序 + Map<对象, 档>。 */
function refBandize(input, rawKey) {
  const hits = input.map((h) => ({ ...h }));
  if (hits.length < 2) return hits;
  const byRaw = hits.slice().sort((a, b) => b[rawKey] - a[rawKey]);
  const bandOf = new Map();
  let band = -1;
  let anchorRaw = 0;
  for (const h of byRaw) {
    if (h._ident === true || h._subj === 1) {
      bandOf.set(h, -1);
      continue;
    }
    const r = h[rawKey];
    if (band < 0 || r < IMP_BAND * anchorRaw) {
      band += 1;
      anchorRaw = r;
    }
    bandOf.set(h, band);
  }
  for (const [h, b] of bandOf) {
    h._band = b;
    if (h.explain !== undefined) h.explain.band = b;
  }
  hits.sort((a, b) => (bandOf.get(a) - bandOf.get(b)) || (b.score - a.score) ||
    (stampOf(a) < stampOf(b) ? 1 : stampOf(a) > stampOf(b) ? -1 : 0) || cmpText(a.id, b.id));
  return hits;
}

/** 参考实现的「接下来那一步」：slice(0, k) 后只留可以逐位比的三个字段。 */
function refPrefix(input, rawKey, k) {
  const sorted = refBandize(input, rawKey);
  const want = Number.isFinite(k) && k > 0 ? Math.round(k) : sorted.length;
  return sorted.slice(0, want).map((h) => ({ id: h.id, score: h.score, band: h._band }));
}

function makeHits(r, n) {
  const out = [];
  for (let i = 0; i < n; i += 1) {
    const raw = Math.round(r() * 1000) / 100; // 两位小数，制造大量并列
    const score = Math.round(raw * (1 + r() * 2) * 100) / 100;
    out.push({
      id: '0m' + (r() < 0.5 ? 'doc' : 'd') + String(Math.floor(r() * 900) + 1),
      score,
      _raw: raw,
      updated_at: r() < 0.15 ? undefined : 1795400000000 - Math.floor(r() * 8) * 60000,
      explain: r() < 0.4 ? {} : undefined,
    });
  }
  // 少量指认条目：档位恒为 -1，且不在 raw 排序里当锚。
  for (let i = 0; i < Math.max(1, Math.round(n * 0.05)); i += 1) {
    const di = Math.floor(r() * n);
    if (r() < 0.5) out[di]._ident = true;
    else out[di]._subj = 1;
  }
  return out;
}

const sameList = (a, b) => a.length === b.length && a.every((x, i) =>
  x.id === b[i].id && x.score === b[i].score && x.band === b[i].band);

// ── O1 / O2 / O3：随机语料对拍 ────────────────────────────────────────────
{
  const r = rnd(0x0612);
  const ks = [1, 2, 5, 8, 20, Infinity];
  const first = [];
  let allSame = true;
  let lenOk = true;
  let bandOk = true;
  let clean = true;
  let cases = 0;
  for (let t = 0; t < 500; t += 1) {
    const n = 2 + Math.floor(r() * 40);
    const hits = makeHits(r, n);
    const k = ks[t % ks.length];
    const ref = refPrefix(hits, '_raw', k);
    const got = bandize(hits.map((h) => ({ ...h })), '_raw', k);
    const gotPrefix = got.map((h) => ({ id: h.id, score: h.score, band: h._band }));
    cases += 1;
    if (!sameList(ref, gotPrefix)) {
      allSame = false;
      if (first.length === 0) first.push({ t, k, n, ref: ref.slice(0, 4), got: gotPrefix.slice(0, 4) });
    }
    const wantLen = Number.isFinite(k) && k > 0 ? Math.min(Math.round(k), n) : n;
    if (got.length !== wantLen) lenOk = false;
    if (got.some((h) => h.explain !== undefined && h.explain.band !== h._band)) bandOk = false;
    if (got.some((h) => h._bandTmp !== undefined)) clean = false;
  }
  ok('O1 前 k 条与「全量排序再取前 k」逐位相同', allSame, `${cases} 组 × k∈{1,2,5,8,20,∞}${allSame ? '' : ' · 首例 ' + JSON.stringify(first[0])}`);
  ok('O2 hits 截到 min(k, n)', lenOk);
  ok('O3 入选条目 _band / explain.band 同步、无 _bandTmp 残留', bandOk && clean);
}

// ── O4：k<=0 / undefined / 超过总数 → 全序 ────────────────────────────────
{
  const r = rnd(0x0613);
  let good = true;
  const detail = [];
  for (const k of [0, -3, undefined, 10_000]) {
    const hits = makeHits(r, 12);
    const ref = refPrefix(hits, '_raw', k);
    const got = bandize(hits.map((h) => ({ ...h })), '_raw', k);
    const gotPrefix = got.map((h) => ({ id: h.id, score: h.score, band: h._band }));
    if (!sameList(ref, gotPrefix)) {
      good = false;
      detail.push(String(k));
    }
  }
  ok('O4 k<=0 / undefined / 超过总数 退回全序，与参考一致', good, good ? 'k∈{0,-3,undefined,10000}' : '不一致 k=' + detail.join(','));
}

// ── O5：同分同时间按 id 自然序 ───────────────────────────────────────────
{
  const hits = ['0m10', '0m2', '0m9', '0ma', '0m1'].map((id) => ({ id, score: 1, _raw: 1, updated_at: 1000 }));
  const ref = refPrefix(hits, '_raw', 5).map((h) => h.id);
  const got = bandize(hits.map((h) => ({ ...h })), '_raw', 5).map((h) => h.id);
  ok('O5 同分同时间按 id 自然序（数字段按数值）', JSON.stringify(ref) === JSON.stringify(got), `${got.join(' < ')}`);
}

// ── O6：指认档恒为 -1 ────────────────────────────────────────────────────
{
  const hits = [
    { id: '0mx1', score: 0, _raw: 0, _ident: true },
    { id: '0mx2', score: 9, _raw: 9 },
    { id: '0mx3', score: 8, _raw: 8 },
    { id: '0mx4', score: 0, _raw: 0, _subj: 1 },
  ];
  const ref = refPrefix(hits, '_raw', 4);
  const got = bandize(hits.map((h) => ({ ...h })), '_raw', 4).map((h) => ({ id: h.id, score: h.score, band: h._band }));
  ok('O6 指认档（_ident / _subj=1）恒在第 -1 档', sameList(ref, got) && ref[0].band === -1 && ref[1].band === -1,
    got.map((h) => `${h.id}:${h.band}`).join(' '));
}

// ── O7：语料换序不影响前 k ───────────────────────────────────────────────
{
  const r = rnd(0x0614);
  const hits = makeHits(r, 30);
  const base = bandize(hits.map((h) => ({ ...h })), '_raw', 6).map((h) => ({ id: h.id, score: h.score, band: h._band }));
  let stable = true;
  for (let t = 0; t < 40; t += 1) {
    const shuffled = hits.map((h) => ({ ...h })).sort(() => (r() < 0.5 ? -1 : 1));
    const got = bandize(shuffled, '_raw', 6).map((h) => ({ id: h.id, score: h.score, band: h._band }));
    if (!sameList(base, got)) stable = false;
  }
  ok('O7 语料换序后前 k 不变', stable);
}

// ── O8：能红证明（坏实现必须被参考实现对拍抓出来）────────────────────────
{
  const r = rnd(0x0615);
  // 坏实现：有界堆只在「严格更好」时替换，但档位算完就丢——等价于「不做档位筛选」。
  const bad = (input, rawKey, k) => {
    const arr = input.map((h) => ({ ...h }));
    const want = Number.isFinite(k) && k > 0 ? Math.round(k) : arr.length;
    arr.sort((a, b) => (b.score - a.score) || cmpText(a.id, b.id));
    return arr.slice(0, want);
  };
  let caught = false;
  for (let t = 0; t < 200 && !caught; t += 1) {
    const hits = makeHits(r, 20);
    const ref = refPrefix(hits, '_raw', 5);
    const got = bad(hits, '_raw', 5).map((h) => ({ id: h.id, score: h.score, band: h._band }));
    if (!sameList(ref, got)) caught = true;
  }
  ok('O8 能红证明：丢掉档位筛选的坏实现必被抓出', caught);
}

// ── O9：负数 raw 退回老路，与参考逐位一致 ────────────────────────────────
// 阈值链要求「锚点严格下降」，负数下 0.85·a > a，前提不成立——引擎必须自动退回全量排序那一支，
// 而且结果得和参考实现（老代码原样）一字不差，否则就是「优化顺手改了口径」。
{
  const r = rnd(0x0616);
  let good = true;
  const detail = [];
  for (let t = 0; t < 60; t += 1) {
    const n = 2 + Math.floor(r() * 18);
    const hits = makeHits(r, n).map((h) => {
      const v = Math.round((r() * 12 - 6) * 100) / 100; // -6..6，含 0 与重复
      return { ...h, _raw: v };
    });
    const k = [1, 3, 20][t % 3];
    const ref = refPrefix(hits, '_raw', k);
    const got = bandize(hits.map((h) => ({ ...h })), '_raw', k).map((h) => ({ id: h.id, score: h.score, band: h._band }));
    if (!sameList(ref, got)) {
      good = false;
      if (detail.length === 0) detail.push(`t=${t} n=${n} k=${k}`);
    }
  }
  ok('O9 负数 raw 走退回路，与参考逐位一致', good, good ? '60 组（-6..6，含 0 与重复）' : '首例 ' + detail[0]);
}

// ── O10：NaN / undefined raw 也退回老路 ───────────────────────────────────
{
  const r = rnd(0x0617);
  let good = true;
  const detail = [];
  const dirty = [NaN, undefined, null, Number.POSITIVE_INFINITY];
  for (let t = 0; t < 40; t += 1) {
    const n = 2 + Math.floor(r() * 14);
    const hits = makeHits(r, n).map((h, i) => {
      if (i % 5 === 0) return { ...h, _raw: dirty[(i / 5 + t) % dirty.length] };
      return h;
    });
    const ref = refPrefix(hits, '_raw', 5);
    const got = bandize(hits.map((h) => ({ ...h })), '_raw', 5).map((h) => ({ id: h.id, score: h.score, band: h._band }));
    if (!sameList(ref, got)) {
      good = false;
      if (detail.length === 0) detail.push(`t=${t} n=${n}`);
    }
  }
  ok('O10 NaN / undefined / null / Infinity raw 同样退回老路，与参考一致', good, good ? '40 组（每 5 条插一个脏值）' : '首例 ' + detail[0]);
}

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILED'} ${pass}/${pass + fail}`);
if (fail > 0) process.exitCode = 1;
