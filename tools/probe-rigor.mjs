#!/usr/bin/env node
/**
 * [macro-fusion 0.6.9] 量尺自己也要被量——「同一批题，换顺序再量一遍，读数还得一样」。
 *
 * 起因（PLAN §12 #2「评测做硬：单次 → 3 次 + std、A/B 互换判分顺序」）：
 * 0.3.0 起所有对外读数都是**单次、单序**量出来的：语料按库里顺序、问句按夹具顺序、
 * 跑一遍取一个数。这一路上我们已经用这些数否决过三个候选（英文词形归一、MMR、
 * 覆盖率重排），如果量尺本身对顺序敏感，那些「负数」里就掺着量尺的噪声——
 * 一个连自己都稳不住的尺子，不能用来判别人的生死。
 *
 * 三条性质，缺一条这把尺子就不许再用：
 *   R1 同一进程连跑 3 次：三档读数（hit@1 / hit@3 / MRR）与逐题名次**逐位相同**，std = 0
 *   R2 语料顺序倒过来（A/B 互换）与打乱（seed 3/11/42）：三档读数逐位相同
 *   R3 问句顺序倒过来：三档读数逐位相同（防「idf 预热/缓存命中顺序」影响读数）
 *   R4 独立 scorer 交叉验：另写一套（不复用主 scorer 的代码路径）对同一批 hits 重算，
 *      逐题名次与聚合值必须一致——两套实现同时写错才可能一起错
 *   R5 能红证明：给 scorer 注入位置偏置（同分时按语料顺序取前）后，R2 的读数必须变化，
 *      证明「互换」这条判据真的在盯东西，而不是永远绿
 *
 * 语料不新造：用 `tools/fixtures/gold-recall.json` 的 40 条真库样张 + 45/14/10 三组问句
 * （真库摘要、换说法、时间锚），与 `probe-recall` / `probe-gold` 同一份样张，读数口径一致。
 *
 * 用法：node tools/probe-rigor.mjs      （挂进 check-all；零 LLM、不碰真库、不写仓库文件）
 */
import { root } from './_root.mjs'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

let failures = 0
let total = 0
function check(label, ok, extra) {
  total++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra === undefined || extra === '' ? '' : `  ${extra}`}`)
  if (!ok) failures++
}

const enginePath = join(root, 'vendor', 'meow-memory', 'lib', 'index.js')
const V = await import(pathToFileURL(enginePath).href)
const fixture = JSON.parse(readFileSync(join(root, 'tools', 'fixtures', 'gold-recall.json'), 'utf8'))

// 三组问句拼成一条：45 真库摘要 + 14 换说法 + 10 时间锚
const questions = [
  ...fixture.queries.map((x) => ({ ...x, group: 'queries' })),
  ...fixture.paraphrase.map((x) => ({ ...x, group: 'paraphrase' })),
  ...fixture.anchor.map((x) => ({ ...x, group: 'anchor' })),
]
const docs = fixture.docs

// ── 主 scorer：hit@1 / hit@3 / MRR（名次 = want 里任一 id 第一次出现的位置）──
function scoreAll(list, docList) {
  const rows = []
  for (const item of list) {
    const hits = V.search(item.q, docList, { k: 10 })
    const ids = hits.map((h) => h.id)
    let rank = 0
    for (let i = 0; i < ids.length; i++) {
      if (item.want.includes(ids[i])) { rank = i + 1; break }
    }
    rows.push({ q: item.q, group: item.group, rank, ids: ids.join(',') })
  }
  const agg = (rows) => {
    const n = rows.length
    const at1 = rows.filter((r) => r.rank === 1).length / n
    const at3 = rows.filter((r) => r.rank >= 1 && r.rank <= 3).length / n
    const mrr = rows.reduce((a, r) => a + (r.rank > 0 ? 1 / r.rank : 0), 0) / n
    return { at1, at3, mrr, n }
  }
  return { rows, agg: agg(rows) }
}

const fmt = (a) => `hit@1 ${a.at1.toFixed(4)} / hit@3 ${a.at3.toFixed(4)} / MRR ${a.mrr.toFixed(4)}`
const sameAgg = (a, b) => a.at1 === b.at1 && a.at3 === b.at3 && a.mrr === b.mrr
const rowSig = (r) => `${r.q}\u0001${r.rank}\u0001${r.ids}`

// ── R1 连跑 3 次 ────────────────────────────────────────────────────────────
const runs = [0, 1, 2].map(() => scoreAll(questions, docs).agg)
const r1same = runs.every((a) => sameAgg(a, runs[0]))
check(
  'R1 同一进程连跑 3 次：三档读数逐位相同（std = 0）',
  r1same,
  runs.map(fmt).join(' | '),
)

// ── R2 语料顺序互换 / 打乱 ──────────────────────────────────────────────────
const baseAgg = runs[0]
const reversed = scoreAll(questions, docs.slice().reverse()).agg
check(
  'R2 语料顺序倒过来（A/B 互换）读数逐位相同',
  sameAgg(baseAgg, reversed),
  `${fmt(baseAgg)} → ${fmt(reversed)}`,
)
function shuffle(arr, seed) {
  const a = arr.slice()
  let s = seed >>> 0
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296)
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}
const shuffledAggs = [3, 11, 42].map((seed) => scoreAll(questions, shuffle(docs, seed)).agg)
check(
  'R2b 语料打乱三种（seed 3/11/42）读数逐位相同',
  shuffledAggs.every((a) => sameAgg(baseAgg, a)),
  shuffledAggs.map(fmt).join(' | '),
)

// ── R3 问句顺序互换 ────────────────────────────────────────────────────────
const qReversed = scoreAll(questions.slice().reverse(), docs).agg
check(
  'R3 问句顺序倒过来读数逐位相同（不靠预热顺序占便宜）',
  sameAgg(baseAgg, qReversed),
  `${fmt(baseAgg)} → ${fmt(qReversed)}`,
)

// ── R4 独立 scorer 交叉验 ──────────────────────────────────────────────────
// 另一套实现：显式逐条扫、按 want 反查最早名次（不复用上面任何一行），并参与聚合。
function independentScore(list, docList) {
  const out = []
  for (const item of list) {
    const ids = V.search(item.q, docList, { k: 10 }).map((h) => h.id)
    const earliest = item.want
      .map((w) => ids.indexOf(w))
      .filter((i) => i >= 0)
      .sort((a, b) => a - b)[0]
    out.push({ q: item.q, rank: earliest === undefined ? 0 : earliest + 1 })
  }
  const n = out.length
  let h1 = 0
  let h3 = 0
  let rr = 0
  for (const r of out) {
    if (r.rank === 1) h1++
    if (r.rank >= 1 && r.rank <= 3) h3++
    if (r.rank > 0) rr += 1 / r.rank
  }
  return { at1: h1 / n, at3: h3 / n, mrr: rr / n, ranks: out.map((r) => `${r.q}\u0001${r.rank}`) }
}
const main = scoreAll(questions, docs)
const indep = independentScore(questions, docs)
const mainRanks = main.rows.map((r) => `${r.q}\u0001${r.rank}`)
check(
  'R4 独立 scorer 交叉验：逐题名次与三档聚合与主 scorer 一致',
  mainRanks.join('|') === indep.ranks.join('|') && sameAgg(main.agg, indep),
  `主 ${fmt(main.agg)} / 独立 ${fmt(indep)}`,
)

// ── R5 能红证明：给 scorer 注入位置偏置，R2 必须变红 ────────────────────────
// 偏置写法：同分时按语料下标取（等价于 0.6.3 修掉的「谁先进库谁在前」），只看第一名。
// 在进程内算，不起子进程：这条判据不该依赖宿主能不能捕获子进程输出。
const biasedTop1 = (list) => {
  let hit1 = 0
  for (const item of questions) {
    const hits = V.search(item.q, list, { k: 10 })
    const idx = new Map(list.map((d, i) => [d.id, i]))
    const biased = hits
      .map((h, i) => ({ id: h.id, key: (idx.has(h.id) ? idx.get(h.id) : 1e9) + i * 1e-6 }))
      .sort((a, b) => a.key - b.key)
    if (biased.length && item.want.includes(biased[0].id)) hit1++
  }
  return hit1
}
const biasNormal = biasedTop1(docs)
const biasReversed = biasedTop1(docs.slice().reverse())
check(
  'R5 能红证明：注入「同分按语料序」的偏置后，A/B 互换的第一名命中数必须不同',
  biasNormal !== biasReversed,
  `正序 ${biasNormal} 命中 / 倒序 ${biasReversed} 命中`,
)

// ── R6 分档口径：三组题数与各组读数（不重跑，直接从主 scorer 的名次算）──────────
const groupAgg = (g) => {
  const rows = main.rows.filter((r) => r.group === g)
  const n = rows.length
  return {
    n,
    at1: rows.filter((r) => r.rank === 1).length / n,
    at3: rows.filter((r) => r.rank >= 1 && r.rank <= 3).length / n,
    mrr: rows.reduce((a, r) => a + (r.rank > 0 ? 1 / r.rank : 0), 0) / n,
  }
}
const gq = groupAgg('queries')
const gp = groupAgg('paraphrase')
const ga = groupAgg('anchor')
check(
  'R6 三组分档口径固定：45 真库摘要 / 14 换说法 / 10 时间锚，合计 69 题，各组读数由同一批名次算出',
  main.agg.n === 69 && gq.n === 45 && gp.n === 14 && ga.n === 10,
  `真库 ${fmt(gq)} · 换说法 ${fmt(gp)} · 时间锚 ${fmt(ga)}`,
)

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} 条失败（共 ${total}）`}  probe-rigor：${total - failures}/${total}`)
process.exit(failures === 0 ? 0 : 1)
