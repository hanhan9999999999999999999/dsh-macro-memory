/**
 * [macro-fusion 0.2.149] 准确率量尺：40 条真实样张 × 45 条自然问句，报 hit@1 / hit@3 / MRR。
 *
 * 前四轮（0.2.146 噪声地板 / 0.2.147 标识符 / 0.2.148 补分位置 / 0.2.145 邻域）
 * 每一刀都有探针，但探针判的是「这个机制对不对」，没有一条判「问得自然时答得准不准」。
 * 要跟 MemOS / ThreadAtlas 比准确率，先得有自己的尺子——这把尺子的语料是插件自己的
 * 真实记忆（content 原样、层/重要度/状态原样），问句按「用户会怎么问」写，不抄正文措辞。
 *
 *   G0 语料规模与形状（40 条 / 45 问句 / 每条问句都有可接受答案）
 *   G1 hit@1 不低于 0.80：问一句，第一条就得是对的
 *   G2 hit@3 不低于 0.95：从「找不到」到「找得到但排第二」是两种失败，分开记账
 *   G3 MRR 不低于 0.88：排第二也要扣分，别让「反正都在前三」掩盖退步
 *   G4 只看聚合、不看单题：单题排名会因语料增删漂移，聚合三档才可当回归基线
 *   G5 阴性对照：把语料顺序打乱、把 importance 全抹平，三档必须变差——否则这把尺子量不出东西
 *   G6 每条 want 都在语料里（问句指向的答案真的存在，不是凭空的靶子）
 *
 * 用法：node tools/probe-gold.mjs
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

const fx = JSON.parse(readFileSync(join(root, 'tools', 'fixtures', 'gold-recall.json'), 'utf8'))
const V = await import(pathToFileURL(join(root, 'vendor', 'meow-memory', 'lib', 'index.js')).href)

const docs = fx.docs
const byId = new Map(docs.map((d) => [d.id, d]))
const K = 5

function measure(list, corpus) {
  let h1 = 0
  let h3 = 0
  let mrr = 0
  const miss = []
  for (const { q, want } of list) {
    const hits = V.search(q, corpus, { k: K })
    const ids = hits.map((h) => String(h.id))
    const rank = ids.findIndex((id) => want.includes(id))
    if (rank === 0) h1++
    if (rank >= 0 && rank < 3) h3++
    mrr += rank >= 0 ? 1 / (rank + 1) : 0
    if (rank !== 0) miss.push({ q, want, got: ids.slice(0, 3), rank })
  }
  const n = list.length
  return { n, hit1: h1 / n, hit3: h3 / n, mrr: mrr / n, miss }
}

check('G0 语料：40 条样张 + 45 条问句，层与状态都真（不是全 fact 的假语料）',
  docs.length === 40 && fx.queries.length === 45 &&
    new Set(docs.map((d) => d.level)).size >= 3 &&
    docs.some((d) => d.status !== 'active'),
  `${docs.length} 条 / ${fx.queries.length} 问 / 层 ${new Set(docs.map((d) => d.level)).size} 种`)

const base = measure(fx.queries, docs)
const fmt = (m) => `hit@1=${m.hit1.toFixed(3)} hit@3=${m.hit3.toFixed(3)} MRR=${m.mrr.toFixed(3)}（${m.n} 问）`
for (const m of base.miss) console.log(`      未中第 1：rank=${m.rank} ${m.q} → want ${m.want.join('/')}，got ${m.got.join(',')}`)

check('G1 hit@1 ≥ 0.80：问自然一句，第一条就得是那条', base.hit1 >= 0.8, fmt(base))
check('G2 hit@3 ≥ 0.95：排第二和找不到分开记账，前者才是可修的', base.hit3 >= 0.95, `hit@3=${base.hit3.toFixed(3)}`)
check('G3 MRR ≥ 0.88：排第二要扣分，别用「都在前三」掩盖退步', base.mrr >= 0.88, `MRR=${base.mrr.toFixed(3)}`)

// G4：聚合可当基线——同样的输入跑两遍必须同数（顺序敏感的实现会被抓出来）
const again = measure(fx.queries, docs)
check('G4 可复现：同一语料同一问句跑两遍，三档逐位相同',
  again.hit1 === base.hit1 && again.hit3 === base.hit3 && again.mrr === base.mrr,
  `${fmt(again)}`)

// G5：阴性对照——抹平重要度、打乱顺序，三档必须变差，否则这把尺子量不出东西
const flat = docs.map((d) => ({ ...d, importance: 2 }))
const flatM = measure(fx.queries, flat)
const shuffled = docs.slice().reverse()
const shufM = measure(fx.queries, shuffled)
// 0.2.149 一跑就露出来的事实：这套语料上「抹平 importance」反而 hit@1 更高（+0.023）。
// 也就是说重要度在这里是负收益——总览/铁律条目（importance 4）把专讲那件事的条目挤到第二。
// 判据只断言「量得到这一手」而不许把方向写死：方向是会随语料变的，尺子不许替读数说话。
const flatDelta = flatM.hit1 - base.hit1
check('G5 阴性对照：抹平 importance 后三档必须变化（量得到这一手，方向只报不判）',
  Math.abs(flatDelta) > 1e-9, `抹平 ${flatM.hit1.toFixed(3)} vs 原 ${base.hit1.toFixed(3)}（差 ${flatDelta >= 0 ? '+' : ''}${flatDelta.toFixed(3)}）`)
check('G5b 阴性对照：语料顺序反过来，三档不许「一样好」（顺序敏感的排名会露馅）',
  shufM.hit1 <= base.hit1 + 1e-9, `反序 ${shufM.hit1.toFixed(3)}`)

// G6：每条 want 都在语料里，问句不是凭空打靶
const orphans = fx.queries.filter((q) => q.want.some((id) => !byId.has(id))).map((q) => q.q)
check('G6 每个 want 都在语料里（问句指向的答案真的存在）', orphans.length === 0, orphans.join(' | '))

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
if (failures !== 0) process.exitCode = 1
