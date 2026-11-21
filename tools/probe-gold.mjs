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

check('G1 hit@1 ≥ 0.86：问自然一句，第一条就得是那条', base.hit1 >= 0.86, fmt(base))
check('G2 hit@3 ≥ 0.99：排第二和找不到分开记账，前者才是可修的', base.hit3 >= 0.99, `hit@3=${base.hit3.toFixed(3)}`)
check('G3 MRR ≥ 0.92：排第二要扣分，别用「都在前三」掩盖退步', base.mrr >= 0.92, `MRR=${base.mrr.toFixed(3)}`)

// G4：聚合可当基线——同样的输入跑两遍必须同数（顺序敏感的实现会被抓出来）
const again = measure(fx.queries, docs)
check('G4 可复现：同一语料同一问句跑两遍，三档逐位相同',
  again.hit1 === base.hit1 && again.hit3 === base.hit3 && again.mrr === base.mrr,
  `${fmt(again)}`)

// G5：0.2.150 把 importance 关进「近分带」之后，聚合上抹平它可能一动不动——这不再是缺陷，
// 而是它不该能改判的证据。所以这里改成两支微案例，直接量「它在带内还活不活、在带外还算不算」。
const mkDoc = (id, title, content, importance, extra) => ({
  id, level: 'fact', title, content, keywords: [title], importance, status: 'active',
  created_at: '2026-11-20T00:00:00.000Z', updated_at: '2026-11-20T00:00:00.000Z', ...(extra || {}),
})

// G5a 带内：同一句话两条记忆，只有 important 不同——高分那条必须在前，且权重各是 1.75 / 1.25
const inBand = V.search('上传 github 之前 必须 问主人 点头', [
  mkDoc('mz-in-hi', '上传前必须问主人', '上传 github 之前 必须 先问主人 点头 再 push', 4),
  mkDoc('mz-in-lo', '上传前必须问主人（随手记）', '上传 github 之前 必须 先问主人 点头 再 push', 2),
], { k: 2, explain: true })
const hiW = inBand.find((h) => h.id === 'mz-in-hi')?.explain?.importanceWeight
const loW = inBand.find((h) => h.id === 'mz-in-lo')?.explain?.importanceWeight
check('G5a 带内重要度仍然改判：同词分的两条，importance 4 排在 2 前面，权重 1.75 / 1.25',
  inBand[0]?.id === 'mz-in-hi' && hiW === 1.75 && loW === 1.25,
  `榜首=${inBand[0]?.id} 权重 ${hiW} / ${loW}`)

// G5b 带外：一条 importance=4 但只沾到一个词的条目，必须落在下一档（band ≥ 1），
// 不许越过词分够得着榜首的那条（band 0）——权重能改分数，改不了档。
const outBand = V.search('标识符 版本号 路径', [
  mkDoc('mz-out-hi', '总览（importance 4）', '版本号 总览 主线 推进 到 哪一版', 4),
  mkDoc('mz-out-lo', '专讲（importance 2）', '标识符 版本号 路径 标识符 版本号 路径 标识符 版本号 路径', 2),
], { k: 2, explain: true })
const outHi = outBand.find((h) => h.id === 'mz-out-hi')
const outLo = outBand.find((h) => h.id === 'mz-out-lo')
check('G5b 带外重要度不许越级：词分够不着榜首的条目落在 band ≥ 1，榜首是 band 0 的那条',
  outBand[0]?.id === 'mz-out-lo' && outLo?.explain?.band === 0 && outHi?.explain?.band >= 1,
  `榜首=${outBand[0]?.id}(band ${outLo?.explain?.band}) 总览 band ${outHi?.explain?.band} / impW ${outHi?.explain?.importanceWeight}`)

// G5c 聚合读数照报（方向不判）：抹掉 importance 之后，这把尺子不许崩——先验不是证据，去掉它顶多平手
const flat = docs.map((d) => ({ ...d, importance: 2 }))
const flatM = measure(fx.queries, flat)
const flatDelta = flatM.hit1 - base.hit1
check('G5c 抹平 importance 后仍然准（顶多平手，不许崩）：先验去掉，证据自己还得站得住',
  flatM.hit1 >= 0.86 && flatM.hit3 >= 0.99,
  `抹平 ${fmt(flatM)} vs 原 ${fmt(base)}（hit@1 差 ${flatDelta >= 0 ? '+' : ''}${flatDelta.toFixed(3)}）`)

// G5d 语料顺序反过来，三档不许「一样好」（顺序敏感的排名会露馅）
const shufM = measure(fx.queries, docs.slice().reverse())
check('G5d 阴性对照：语料顺序反过来，三档不许一样好（顺序敏感的实现会露馅）',
  shufM.hit1 <= base.hit1 + 1e-9, `反序 ${shufM.hit1.toFixed(3)}`)

// G7 时间折扣有下限：一年前的条目落在带外（词分只有榜首的三分之一），衰减该出手，
// 但出手有底线——权重停在 RECENCY_FLOOR(0.6)，条目还留在榜上，不是被折成看不见。
const old = '2025-11-01T00:00:00.000Z'
// 词分是「命中了几个词」的加权和（二进制 tf，重复不涨分），所以旧条要落在带外，
// 只能少沾词：新条命中 4 个，旧条只命中 1 个。
const recency = V.search('鲸落 深海 回声 泡沫', [
  mkDoc('mz-new', '鲸落（新）', '鲸落 深海 回声 泡沫 的 一次 记录', 2, { updated_at: '2026-11-21T00:00:00.000Z' }),
  mkDoc('mz-old', '鲸落（旧）', '鲸落 只有 一个 词', 2, { updated_at: old }),
], { k: 2, explain: true })
const oldHit = recency.find((h) => h.id === 'mz-old')
check('G7 时间折扣有下限：一年前的条目权重停在 RECENCY_FLOOR(0.6)，不许被折成看不见',
  oldHit?.explain?.recencyWeight === 0.6 && recency.some((h) => h.id === 'mz-old'),
  `旧条权重=${oldHit?.explain?.recencyWeight} 排名=${recency.findIndex((h) => h.id === 'mz-old') + 1}`)

// G6：每条 want 都在语料里，问句不是凭空打靶
const orphans = fx.queries.filter((q) => q.want.some((id) => !byId.has(id))).map((q) => q.q)
check('G6 每个 want 都在语料里（问句指向的答案真的存在）', orphans.length === 0, orphans.join(' | '))

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
if (failures !== 0) process.exitCode = 1
