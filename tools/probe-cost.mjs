/**
 * [macro-fusion 0.2.153] 效率量尺：检索要花的钱与时间。
 *
 * 前五刀量的都是「准不准」（0.2.149–0.152）。主人的六条标准里还有两条没人量过：
 *   效率：检索快、不拖累当前任务。
 *   抗噪性由 0.2.146/0.151 管，省 token 只被 probe-gold 的「空手」间接碰过一次。
 *
 * 这把尺子只量三件事，都跟「每轮固定开销」有关：
 *   C1 语料规模：40 条真样张，再复制到 400 / 1200 条（真库迟早是这个量级）
 *   C2 单次检索耗时：p50 / p95，只看 search() 本体（不含读库、不含渲染）
 *   C3 规模曲线：1200 / 400 两档的耗时比——线性实现会是 ≈3，次线性才是本事
 * 外加一条静态红线：
 *   C4 正文别被 tokenize 两次（同一段 content 扫两遍就是白烧 CPU）
 * 还有一条行为锁：
 *   C5 结果快照：top-5 的 id 与分数必须与 tools/fixtures/cost-snap.json 逐位相同
 *      —— 优化只许改「花多少时间」，不许改「答什么」。要换代就 node tools/probe-cost.mjs --write-snap
 *
 * 用法：node tools/probe-cost.mjs [--write-snap]
 */
import { root } from './_root.mjs'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

let failures = 0
function check(label, ok, extra) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra === undefined || extra === '' ? '' : `  ${extra}`}`)
  if (!ok) failures++
}

const writeSnap = process.argv.includes('--write-snap')
const fx = JSON.parse(readFileSync(join(root, 'tools', 'fixtures', 'gold-recall.json'), 'utf8'))
const enginePath = join(root, 'vendor', 'meow-memory', 'lib', 'index.js')
const V = await import(pathToFileURL(enginePath).href)
const engineSrc = readFileSync(enginePath, 'utf8')

// ── 语料：真样张打底，复制成大盘 ─────────────────────────────────────────────
function scaleDocs(base, n) {
  const out = []
  let i = 0
  while (out.length < n) {
    const d = base[i % base.length]
    const round = Math.floor(i / base.length)
    out.push(round === 0 ? d : { ...d, id: `${d.id}-r${round}` })
    i++
  }
  return out
}
const qs = fx.queries.map((x) => x.q)
const corpora = {
  40: fx.docs,
  400: scaleDocs(fx.docs, 400),
  1200: scaleDocs(fx.docs, 1200),
}

check('C1 语料三档都成形（40 条真样张 / 复制到 400 / 1200）',
  corpora[40].length === 40 && corpora[400].length === 400 && corpora[1200].length === 1200 &&
    new Set(corpora[1200].map((d) => d.id)).size === 1200,
  `40 / 400 / 1200 条，id 唯一`)

// ── 耗时：先热身一遍，再逐问计时 ────────────────────────────────────────────
function bench(corpus, warm = 1) {
  for (let w = 0; w < warm; w++) for (const q of qs) V.search(q, corpus, { k: 5 })
  const ms = []
  const hitsAll = []
  for (const q of qs) {
    const t0 = process.hrtime.bigint()
    const hits = V.search(q, corpus, { k: 5 })
    ms.push(Number(process.hrtime.bigint() - t0) / 1e6)
    hitsAll.push(hits)
  }
  const sorted = [...ms].sort((a, b) => a - b)
  const pick = (p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]
  return {
    p50: pick(0.5),
    p95: pick(0.95),
    max: sorted[sorted.length - 1],
    mean: ms.reduce((a, b) => a + b, 0) / ms.length,
    hitsAll,
  }
}

const b40 = bench(corpora[40])
const b400 = bench(corpora[400])
const b1200 = bench(corpora[1200])
const fmt = (b) => `p50=${b.p50.toFixed(1)}ms p95=${b.p95.toFixed(1)}ms max=${b.max.toFixed(1)}ms`

console.log(`      40 条   ${fmt(b40)}`)
console.log(`      400 条  ${fmt(b400)}`)
console.log(`      1200 条 ${fmt(b1200)}`)

check('C2 1200 条时单次检索 p95 不超过 20ms（一屏文字的钱，不该让模型等；0.2.153 前是 121.8ms）',
  b1200.p95 <= 20, fmt(b1200))

const growth = b1200.p50 / Math.max(0.01, b400.p50)
check('C3 规模三倍时耗时不超过 4.5 倍（指纹必须逐条过一遍，这一段注定线性；守的是别出现平方级）',
  growth <= 4.5, `1200/400 = ${growth.toFixed(2)}×`)

// ── C4 正文被 tokenize 两次就是白烧：内容是同一段，扫两遍没有任何新信息 ──────
const contentTokenize = (engineSrc.match(/tokenize\(String\(d\.content/g) || []).length
check('C4 正文只被 tokenize 一次（同一段 content 扫两遍不产生新信息）',
  contentTokenize <= 1, `tokenize(String(d.content…)) 出现 ${contentTokenize} 次`)

// ── C5 结果快照：优化只许改时间，不许改答案 ─────────────────────────────────
const snapPath = join(root, 'tools', 'fixtures', 'cost-snap.json')
const snapOf = (b, corpus) => b.hitsAll.map((hits) => hits.map((h) => `${h.id}:${(h.score ?? 0).toFixed(6)}`))
const nowSnap = { version: (fx.note ?? '').slice(0, 0), docs: {}, m: { 40: snapOf(b40), 1200: snapOf(b1200) } }
if (writeSnap || !existsSync(snapPath)) {
  writeFileSync(snapPath, JSON.stringify(nowSnap, null, 1) + '\n', 'utf8')
  console.log(`      结果快照已写入 tools/fixtures/cost-snap.json（${qs.length} 问 × {40,1200} 两档）`)
  check('C5 结果快照已落盘（首跑或 --write-snap）', true)
} else {
  const old = JSON.parse(readFileSync(snapPath, 'utf8'))
  const pairSame = (a, b) => a.length === b.length && a.every((row, i) => row.length === b[i].length && row.every((x, j) => x === b[i][j]))
  const same40 = pairSame(old.m['40'], nowSnap.m['40'])
  const same1200 = pairSame(old.m['1200'], nowSnap.m['1200'])
  let firstDiff = ''
  if (!same40 || !same1200) {
    const A = !same40 ? old.m['40'] : old.m['1200']
    const B = !same40 ? nowSnap.m['40'] : nowSnap.m['1200']
    for (let i = 0; i < A.length; i++) {
      if (!pairSame([A[i]], [B[i]])) { firstDiff = `第 ${i + 1} 问「${qs[i]}」旧 ${A[i].join(',')} → 新 ${B[i].join(',')}`; break }
    }
  }
  check('C5 top-5 的 id 与分数与快照逐位相同（只许变快，不许变答案）',
    same40 && same1200, firstDiff || `${qs.length} 问 × 两档全同`)
}

// ── C6 缓存不许答旧库：等长改写（同一秒、字数一模一样）跑不掉 ───────────────
// 指纹原来只看 content.length：改一个词但字数不变、updated_at 又落在同一秒，
// 旧表就会被当成新库用，用户看到的答案是他改之前的。这条专守这个缝——
// 用「蓝绿切换 → 红黑切换」这种等长换词，旧表里根本没有新词，答得出来才算对。
const c6 = [
  { id: 'c6a', project: '全局', content: '发布方式：蓝绿切换，切完观察五分钟', updated_at: '2026-11-21T20:00:00Z' },
  { id: 'c6b', project: '全局', content: '发布方式：金丝雀发布，先放一成流量', updated_at: '2026-11-21T20:00:00Z' },
]
V.clearSearchIndexCache()
const q6 = '红黑切换'
const cold6 = V.search(q6, c6, { k: 2 })
c6[0] = { ...c6[0], content: '发布方式：红黑切换，切完观察五分钟' }
const warm6 = V.search(q6, c6, { k: 2 })
const sig6 = (hits) => JSON.stringify(hits.map((h) => [h.id, (h.score ?? 0).toFixed(6)]))
check('C6 等长改写会被认出来（长度一样、updated_at 同秒，指纹仍要变）',
  V.indexSignature(c6) !== V.indexSignature([{ ...c6[0], content: '发布方式：蓝绿切换，切完观察五分钟' }, c6[1]]),
  `「蓝绿切换」→「红黑切换」同为 ${c6[0].content.length} 字`)
check('C6b 改完立刻问，答的是新库（旧表只认得「切换」两个字，分数会露馅）',
  warm6.length > 0 && warm6[0].id === 'c6a' && sig6(warm6) === sig6(V.search(q6, c6, { k: 2, cache: false })) &&
    (warm6[0].score ?? 0) > (cold6[0]?.score ?? 0),
  `改前 ${(cold6[0]?.score ?? 0).toFixed(3)} / 改后 ${(warm6[0]?.score ?? 0).toFixed(3)}（${warm6.map((h) => h.id).join(',')}）`)

// ── C7 缓存只许省时间：与关掉缓存的答案必须逐位相同 ────────────────────────
V.clearSearchIndexCache()
const t7a0 = process.hrtime.bigint()
const warm7 = qs.map((q) => V.search(q, corpora[1200], { k: 5 }))
const t7a = Number(process.hrtime.bigint() - t7a0) / 1e6
const t7b0 = process.hrtime.bigint()
const cold7 = qs.map((q) => V.search(q, corpora[1200], { k: 5, cache: false }))
const t7b = Number(process.hrtime.bigint() - t7b0) / 1e6
const flat7 = (all) => JSON.stringify(all.map((hits) => hits.map((h) => [h.id, (h.score ?? 0).toFixed(6)])))
check('C7 cache:false 与 cache:true 答案逐位相同（缓存只许省时间）',
  flat7(warm7) === flat7(cold7), `${qs.length} 问全同`)
check('C7b cache:false 明显更慢（否则这条闸门等于没开）',
  t7b > t7a * 2, `开 ${t7a.toFixed(1)}ms / 关 ${t7b.toFixed(1)}ms，${(t7b / Math.max(0.01, t7a)).toFixed(1)}×`)

// ── C8 缓存账要能数：同一张库连问不变多，库一改才 +1 ───────────────────────
V.clearSearchIndexCache()
const c8 = fx.docs.map((d) => ({ ...d }))
V.search('部署', c8, { k: 5 })
V.search('部署', c8, { k: 5 })
V.search('星图', c8, { k: 5 })
const info8a = V.searchIndexCacheInfo()
c8[0] = { ...c8[0], content: `${c8[0].content}（改）` }
V.search('部署', c8, { k: 5 })
const info8b = V.searchIndexCacheInfo()
const cleared8 = V.clearSearchIndexCache()
check('C8 同一张库连问不再建表（size 稳定在 1），改一条后才 +1',
  info8a.size === 1 && info8b.size === 2 && cleared8 === 2 && V.searchIndexCacheInfo().size === 0,
  `连问 3 次 size=${info8a.size} / 改后 size=${info8b.size} / 清掉 ${cleared8} 张`)
check('C8b 缓存有上限（不许无限长内存）', V.searchIndexCacheInfo().max === 4, `max=${V.searchIndexCacheInfo().max}`)

console.log('')
if (failures > 0) {
  console.log(`${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('ALL PASS')
