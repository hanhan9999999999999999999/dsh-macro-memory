#!/usr/bin/env node
/**
 * [macro-fusion 0.6.0] 规模自适应 idf 的开关账——钉住「什么情况下这机制不许动结果」。
 *
 * 为什么探针只管等价、不管准确率：准确率那一栏（真库快照 660 条：照抄 0.895→0.921、
 * 换说法 0.333→0.417、误伤 0）需要一份 ≥300 条的**真实**语料，探针仓库里没有，
 * 硬造一份「刚好能翻转」的合成样张等于把结论焊死在刀刃上——那种绿是假绿。
 * 所以读数留在 docs/PLAN-0.6.md §1，这里只钉住让它安全的那几条：
 *
 *   D1 默认关：不传 adaptiveIdf 与显式关逐位相同（引擎默认值不许被改动顺手带开）
 *   D2 小池不动：N<规模闸门（窄池 40 / 宽池 146）时开与关逐位相同
 *   D3 λ 上限 0：跨过闸门也不改判（相当于「只算不算用」）
 *   D4 闸门不是摆设：把闸门调到 0，宽池上必须出现改判——否则这条机制等于没接上
 *   D5 全是泛词退全库：一个区分词都没有的问句，结果逐位相同
 *   D6 结构不变量：过闸门且榜首接近时，簇恰为 topM 条、λ 落在 (0, cap]
 *   D7/D8 旋钮真接上了：topM 改 5/12 簇跟着变；α、cap 改了小分数就变
 *   D9 成本：p95 增量 ≤2ms（321 条语料）
 *   D10 回执形态：开关不许改返回条数/字段，status 要透传（0.6.0 · P4）
 *   D11 候选不许凭空长出来（打开后每个 id 都来自语料）
 *   D12 接线点还在：`rankForSearch` 默认打开、词形桥那遍显式关（删掉任何一处，前 13 条仍会全绿）
 *
 * 用法：node tools/probe-idf.mjs      （挂进 check-all；零 LLM、不碰真库、不写任何文件）
 */
import { root } from './_root.mjs'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

let failures = 0
function check(label, ok, extra) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra === undefined || extra === '' ? '' : `  ${extra}`}`)
  if (!ok) failures++
}

const V = await import(pathToFileURL(join(root, 'vendor', 'meow-memory', 'lib', 'index.js')).href)
const seqOf = (hits) => hits.map((h) => `${h.id}:${Number(h.score ?? 0).toFixed(6)}`).join('|')
const idsOf = (hits) => hits.map((h) => h.id).join(',')

// ── 合成语料：321 条，榜首与第二名咬得很紧（λ 会真的 >0），簇由数据自己长 ──────────
const SYN = (() => {
  const docs = []
  docs.push({
    id: 'idf-target',
    title: '收工前的复测',
    content: '每次跑完先同步一次数，用碘量计复测滴定终点两遍，两遍一致才收工。',
    level: 'fact',
    project: '合成样张',
    importance: 2,
  })
  for (let i = 0; i < 5; i++)
    docs.push({ id: `idf-s${i}`, title: '基线记录', content: `基线同步收工 基线同步收工 基线同步收工 基线同步收工 编号${i}`, level: 'fact', project: '合成样张', importance: 2 })
  for (let i = 0; i < 55; i++)
    docs.push({ id: `idf-w${i}`, title: '基线记录', content: `基线同步一次就收工 编号${i}`, level: 'fact', project: '合成样张', importance: 2 })
  for (let i = 0; i < 3; i++)
    docs.push({ id: `idf-r${i}`, title: '滴定备忘', content: `滴定终点读两遍，记在备忘里 ${i}`, level: 'fact', project: '合成样张', importance: 1 })
  for (let i = 0; i < 250; i++)
    docs.push({ id: `idf-b${i}`, title: '备份备忘', content: `备份提醒${i}：探针与断言各看一遍，日志端口别漏。`, level: 'fact', project: '合成样张', importance: 1 })
  for (const d of docs) d.status = 'active'
  return docs
})()
const SYN_Q = '基线要同步几次才算收工，滴定终点怎么判'
const SYN_N = SYN.length

// ── 两池真夹具（宽池 = 窄池 40 + gold-wide 106） ─────────────────────────────
const narrow = JSON.parse(readFileSync(join(root, 'tools', 'fixtures', 'gold-recall.json'), 'utf8')).docs
const wide = (() => {
  const extra = JSON.parse(readFileSync(join(root, 'tools', 'fixtures', 'gold-wide.json'), 'utf8')).documents
  const seen = new Set(narrow.map((d) => d.id))
  return narrow.concat(extra.filter((d) => !seen.has(d.id)))
})()

const QS = ['基线同步', '收工判据', '备份探针', '缓存日志', '探针断言']
let same = 0
let total = 0
for (const q of QS) {
  const a = seqOf(V.search(q, wide, { k: wide.length, bandKeep: true }))
  const b = seqOf(V.search(q, wide, { k: wide.length, bandKeep: true, adaptiveIdf: true }))
  total++
  if (a === b) same++
  const c = seqOf(V.search(q, narrow, { k: narrow.length, bandKeep: true }))
  const d = seqOf(V.search(q, narrow, { k: narrow.length, bandKeep: true, adaptiveIdf: true }))
  total++
  if (c === d) same++
  const e = seqOf(V.search(q, SYN, { k: SYN_N, bandKeep: true, adaptiveIdf: false }))
  const f = seqOf(V.search(q, SYN, { k: SYN_N, bandKeep: true }))
  total++
  if (e === f) same++
}
check('D1 不传 adaptiveIdf 与显式关逐位相同（宽池/窄池/合成）', same === total, `${same}/${total}`)

{
  let ok = 0
  let n = 0
  for (const q of QS) {
    for (const pool of [narrow, wide]) {
      const a = seqOf(V.search(q, pool, { k: pool.length, bandKeep: true }))
      const b = seqOf(V.search(q, pool, { k: pool.length, bandKeep: true, adaptiveIdf: true }))
      n++
      if (a === b) ok++
    }
  }
  check('D2 小池（40 / 146 条，N<300）开与关逐位相同', ok === n, `${ok}/${n}`)
}

{
  let ok = 0
  let n = 0
  for (const q of QS.concat([SYN_Q])) {
    const pool = q === SYN_Q ? SYN : wide
    const a = seqOf(V.search(q, pool, { k: pool.length, bandKeep: true }))
    const b = seqOf(V.search(q, pool, { k: pool.length, bandKeep: true, adaptiveIdf: true, idfScaleGate: 0, idfLamCap: 0 }))
    n++
    if (a === b) ok++
  }
  check('D3 λ 上限 0 时跨过闸门也不改判', ok === n, `${ok}/${n}`)
}

{
  let diff = 0
  for (const q of QS) {
    const pool = wide
    const a = seqOf(V.search(q, pool, { k: pool.length, bandKeep: true }))
    const b = seqOf(V.search(q, pool, { k: pool.length, bandKeep: true, adaptiveIdf: true, idfScaleGate: 0 }))
    if (a !== b) diff++
  }
  check('D4 把闸门调到 0，宽池上必须出现改判（闸门真接上了）', diff > 0, `${diff}/${QS.length} 题改判`)
}

{
  const q0 = '备忘'
  const a = seqOf(V.search(q0, SYN, { k: SYN_N, bandKeep: true }))
  const b = seqOf(V.search(q0, SYN, { k: SYN_N, bandKeep: true, adaptiveIdf: true }))
  check('D5 全是泛词的问句退全库（结果逐位相同）', a === b, a === b ? '逐位相同' : '被改了')
}

{
  const hits = V.search(SYN_Q, SYN, { k: SYN_N, bandKeep: true, adaptiveIdf: true, explain: true })
  const dbg = hits[0]?.explain?.adaptiveIdf
  check('D6 过闸门且咬得紧时：簇 = topM、0<λ≤cap', !!dbg && dbg.cluster === 8 && dbg.lam > 0 && dbg.lam <= 0.3001, dbg ? `簇 ${dbg.cluster} λ ${dbg.lam.toFixed(3)}` : '没有 adaptiveIdf（λ=0 或没有区分词）')
}

{
  const c5 = V.search(SYN_Q, SYN, { k: SYN_N, bandKeep: true, adaptiveIdf: true, explain: true, idfClusterTopM: 5, idfClusterMin: 5 })[0]?.explain?.adaptiveIdf
  const c12 = V.search(SYN_Q, SYN, { k: SYN_N, bandKeep: true, adaptiveIdf: true, explain: true, idfClusterTopM: 12, idfClusterMin: 12 })[0]?.explain?.adaptiveIdf
  check('D7 topM 旋钮接上了（5 / 12 条各归各的簇）', c5?.cluster === 5 && c12?.cluster === 12, `${c5?.cluster} / ${c12?.cluster}`)
}

{
  const full = (opt) => seqOf(V.search(SYN_Q, SYN, { k: SYN_N, bandKeep: true, adaptiveIdf: true, ...opt }))
  const a100 = full({})
  const a0 = full({ idfAlpha: 0 })
  const cap = full({ idfLamCap: 0.15 })
  check('D8 α 旋钮接上了（α=0 与 α=100 分数不同）', a0 !== a100, a0 === a100 ? '相同' : '不同')
  check('D8b λ 上限旋钮接上了（0.15 与 0.3 分数不同）', cap !== a100, cap === a100 ? '相同' : '不同')
}

{
  const p95 = (opt) => {
    const runs = []
    for (let i = 0; i < 25; i++) {
      const s = process.hrtime.bigint()
      V.search(SYN_Q, SYN, { k: 5, ...opt })
      runs.push(Number(process.hrtime.bigint() - s) / 1e6)
    }
    runs.sort((x, y) => x - y)
    return runs[Math.floor(runs.length * 0.95)]
  }
  const off = Math.min(p95({}), p95({}), p95({}))
  const on = Math.min(p95({ adaptiveIdf: true }), p95({ adaptiveIdf: true }), p95({ adaptiveIdf: true }))
  check('D9 p95 增量 ≤2ms（321 条语料，k=5）', on - off <= 2, `${off.toFixed(2)}ms → ${on.toFixed(2)}ms（+${(on - off).toFixed(2)}）`)
  const top = V.search(SYN_Q, SYN, { k: 5, adaptiveIdf: true })
  check('D10 开关不影响返回条数与字段', top.length === 5 && typeof top[0].title === 'string' && typeof top[0].level === 'string', `${top.length} 条`)
  check('D10b 回执带 status（0.6.0 · P4 透传，不参与打分）', top.every((h) => h.status === 'active'), top.map((h) => h.status).join('/'))
  const ids = idsOf(top)
  check('D11 打开时仍是同一批候选（不许凭空造条目）', ids.split(',').every((id) => SYN.some((d) => d.id === id)), ids.split(',').length + ' 个 id 全部来自语料')
}

{
  // 静态账：这条机制在引擎里有两个「接线点」，删掉任何一个，上面 13 条全绿而线上悄悄退回 0.5.0。
  // ①rankForSearch 产品入口默认打开 ②searchAdaptive 的词形桥那遍显式关掉（§8 未决 3）。
  const src = readFileSync(join(root, 'vendor', 'meow-memory', 'lib', 'index.js'), 'utf8')
  const entryOn = /const o = opts\.adaptiveIdf === false \? opts : \{ \.\.\.opts, adaptiveIdf: true \};/.test(src)
  const bridgeOff = /search\(query, docs, \{ \.\.\.opts, synFormBridge: true, adaptiveIdf: false \}\)/.test(src)
  check(
    'D12 接线点还在：产品入口默认开、词形桥那遍显式关',
    entryOn && bridgeOff,
    `入口=${entryOn ? '开' : '缺失'} 桥=${bridgeOff ? '关' : '缺失'}`,
  )
}

const totalChecks = 14
console.log(`\n${failures === 0 ? 'ALL PASS' : 'FAILED'}  probe-idf：${totalChecks - failures}/${totalChecks}`)
if (failures > 0) process.exitCode = 1
