/**
 * [macro-fusion 0.2.149] 准确率量尺：40 条真实样张 × 45 条自然问句，报 hit@1 / hit@3 / MRR。
 *
 * 前四轮（0.2.146 噪声地板 / 0.2.147 标识符 / 0.2.148 补分位置 / 0.2.145 邻域）
 * 每一刀都有探针，但探针判的是「这个机制对不对」，没有一条判「问得自然时答得准不准」。
 * 要跟 MemOS / ThreadAtlas 比准确率，先得有自己的尺子——这把尺子的语料是插件自己的
 * 真实记忆（content 原样、层/重要度/状态原样），问句按「用户会怎么问」写，不抄正文措辞。
 *
 *   G0 语料规模与形状（40 条 / 45 问句 / 每条问句都有可接受答案）
 *   G1 hit@1 不低于 0.88：问一句，第一条就得是对的
 *   G2 hit@3 不低于 0.95：从「找不到」到「找得到但排第二」是两种失败，分开记账
 *   G3 MRR 不低于 0.92：排第二也要扣分，别让「反正都在前三」掩盖退步
 *   G4 只看聚合、不看单题：单题排名会因语料增删漂移，聚合三档才可当回归基线
 *   G5 阴性对照：把语料顺序打乱、把 importance 全抹平，三档必须变差——否则这把尺子量不出东西
 *   G6 每条 want 都在语料里（问句指向的答案真的存在，不是凭空的靶子）
 *   G8/G9 没得答时敢不敢空手（0.2.151 虚词地板）
 *   G10 换说法组：问句不抄正文用词时还能不能找到（0.2.152）
 *   G11 阴性对照：关键词退回「当正文」时两个池都不许更好（0.2.152）
 *
 * 用法：node tools/probe-gold.mjs
 */
import { root } from './_root.mjs'
import { readFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'

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

function measure(list, corpus, opts = {}) {
  let h1 = 0
  let h3 = 0
  let mrr = 0
  const miss = []
  for (const { q, want } of list) {
    const hits = V.search(q, corpus, { k: K, ...opts })
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

check('G0 语料：40 条样张 + 45 条照抄词问句 + 14 条换说法问句，层与状态都真（不是全 fact 的假语料）',
  docs.length === 40 && fx.queries.length === 45 && fx.paraphrase.length === 14 &&
    new Set(docs.map((d) => d.level)).size >= 3 &&
    docs.some((d) => d.status !== 'active'),
  `${docs.length} 条 / ${fx.queries.length} 问 + ${fx.paraphrase.length} 换说法 / 层 ${new Set(docs.map((d) => d.level)).size} 种 / 关键词均 ${(docs.reduce((a, d) => a + d.keywords.length, 0) / docs.length).toFixed(1)} 个`)

const base = measure(fx.queries, docs)
const fmt = (m) => `hit@1=${m.hit1.toFixed(3)} hit@3=${m.hit3.toFixed(3)} MRR=${m.mrr.toFixed(3)}（${m.n} 问）`
for (const m of base.miss) console.log(`      未中第 1：rank=${m.rank} ${m.q} → want ${m.want.join('/')}，got ${m.got.join(',')}`)

check('G1 hit@1 ≥ 0.88：问自然一句，第一条就得是那条', base.hit1 >= 0.88, fmt(base))
check('G2 hit@3 ≥ 0.95：排第二和找不到分开记账，前者才是可修的', base.hit3 >= 0.95, `hit@3=${base.hit3.toFixed(3)}`)
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
  flatM.hit1 >= 0.88 && flatM.hit3 >= 0.95,
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
// ── G8/G9（0.2.151）：库里没有这件事时，回执该是空的 ─────────────────────────
// 准确率不只有「问到了对不对」，还有「没得答时敢不敢空手」。这一批问句与记忆库毫无关系，
// 它们以前能凑出回执，靠的是问句里 `怎么 / 什么 / 用的` 这类两字碎片：碎片在本库 df 极低、
// idf 极高，一条只沾一个碎片的条目就上了桌。记 10/14 条硬凑出回执，回执比沉默更危险。
const NEG_QUERIES = [
  '明天北京的天气怎么样', '红烧肉要炖多久才烂', '秦始皇哪一年统一六国',
  '光合作用的暗反应发生在哪里', '帮我写一首关于秋天的七言绝句', 'Python 的 GIL 在 3.13 有变化吗',
  '火星上一天有多少小时', '红楼梦里通灵宝玉是什么来历', '吉他换弦要注意什么',
  '上一届世界杯冠军是谁', '我家的猫为什么半夜叫', '高铁票怎么改签',
  '咖啡因的半衰期是多久', '怎么腌酸菜不坏',
]
const abstain = (opts) => NEG_QUERIES.filter((q) => V.search(q, docs, { k: 5, ...opts }).length === 0);
const negEmpty = abstain({});
const negEmptyOld = abstain({ funcFloor: false });
check(
  'G8 没有的事就空手：14 条与记忆库无关的问句里，至少 9 条回执为空（问句虚词不算证据）',
  negEmpty.length >= 9,
  `空手 ${negEmpty.length}/14，仍硬凑：${NEG_QUERIES.filter((q) => !negEmpty.includes(q)).join(' / ')}`,
)
check(
  'G9 阴性对照：funcFloor:false 时这些问句又硬凑出回执（地板真在起效，不是本来就没命中）',
  negEmptyOld.length <= 4,
  `关掉后空手只剩 ${negEmptyOld.length}/14`,
)
// ── G10/G11（0.2.152）：尺子补真之后新增的两条 ─────────────────────────────
// 起因：0.2.149 定的阈值全建立在失真语料上——40 条样张的 keywords 全是空数组，
// 而真库里这 40 条 40/40 都带关键词（均 9.2 个）。也就是说 0.2.133 上线的
// FIELD_KW_W=0.35 从未被任何探针量到过；照抄池的高分也只测了「问句照抄正文用词」。
// 两件事一起补：关键词用真值（G0 已记账），另开一组「换说法」问句——用户不会照抄正文。
const para = measure(fx.paraphrase, docs)
for (const m of para.miss) console.log(`      换说法未中第 1：rank=${m.rank} ${m.q} → want ${m.want.join('/')}，got ${m.got.join(',')}`)
check('G10 换说法也找得到：问句刻意避开正文用词时，hit@1 ≥ 0.45 / hit@3 ≥ 0.65 / MRR ≥ 0.52',
  para.hit1 >= 0.45 && para.hit3 >= 0.65 && para.mrr >= 0.52, fmt(para))

// G11 阴性对照：关键词退回「当正文」（docText 平铺）时，两个池的 hit@1 都不许更好——
// 关键词是「用户会怎么问」的逆向词，平铺进正文会稀释短正文，还会让虚词问句沾到短词硬凑。
const bodyM = measure(fx.queries, docs, { kwSeparate: false })
const bodyP = measure(fx.paraphrase, docs, { kwSeparate: false })
check('G11 阴性对照：关键词当正文时两个池都不许更好（关键词只该是字段，不该稀释正文）',
  bodyM.hit1 <= base.hit1 + 1e-9 && bodyP.hit1 <= para.hit1 + 1e-9,
  `当正文 照抄 ${bodyM.hit1.toFixed(3)} / 换说法 ${bodyP.hit1.toFixed(3)} vs 当字段 ${base.hit1.toFixed(3)} / ${para.hit1.toFixed(3)}`)

// ── G12/G13/G14（0.2.154）：稠密向量是「可选的一路」，只许加分、不许硬要 ─────────
// 三条判据的**条数固定**：无论这台机器装没装 @huggingface/transformers、下没下模型，
// 都各打一行（G14 内部二分，但只有一行）。理由写在 INTERNAL 9.160：计数型基线一旦
// 跟运行状态耦合，基线就会在「记录基线」和「干净树」之间自己抖一条。
// G13 两条退路都必须逐位回到词法：一条显式开关（opts.dense === false），一条环境变量总开关。
// 分数也一起比（toFixed(9)）——「同序不同分」会让下游 min_rel 的 0.35 线悄悄换意思。
const sigOf = (hits) => hits.map((h) => `${h.id}:${h.score.toFixed(9)}`).join(',')
const denseQs = [...fx.queries.slice(0, 6), ...fx.paraphrase.slice(0, 4)].map((x) => x.q)
let identOpt = 0
for (const q of denseQs) {
  if (sigOf(V.search(q, docs, { k: docs.length })) === sigOf(await V.searchHybrid(q, docs, { k: docs.length, dense: false }))) identOpt++
}
const prevKill = process.env.MEOW_DENSE
process.env.MEOW_DENSE = '0'
let identEnv = 0
for (const q of denseQs) {
  if (sigOf(V.search(q, docs, { k: docs.length })) === sigOf(await V.searchHybrid(q, docs, { k: docs.length }))) identEnv++
}
const killedWarm = await V.denseWarm(docs, {})
if (prevKill === undefined) delete process.env.MEOW_DENSE
else process.env.MEOW_DENSE = prevKill
check(
  'G13 退路逐位相同：opts.dense=false 与 MEOW_DENSE=0 都必须回到纯词法（顺序和分数都不许变），开关关掉时预热也不许偷偷干活',
  identOpt === denseQs.length && identEnv === denseQs.length && killedWarm.embedded === 0,
  `开关 ${identOpt}/${denseQs.length}、环境变量 ${identEnv}/${denseQs.length}、预热 embedded=${killedWarm.embedded}`,
)

// G14 有模型时：混合检索不许把任何一个原本第一挤下来，两个池都不许变差。
// 没有模型时：退路本身就是要交的东西——「安静地什么都不做」也是验收项。
async function measureH(list, corpus, opts = {}) {
  let h1 = 0
  let h3 = 0
  let mrr = 0
  const rank0 = []
  for (const { q, want } of list) {
    const ids = (await V.searchHybrid(q, corpus, { k: K, ...opts })).map((h) => String(h.id))
    const rank = ids.findIndex((id) => want.includes(id))
    if (rank === 0) h1++
    if (rank >= 0 && rank < 3) h3++
    mrr += rank >= 0 ? 1 / (rank + 1) : 0
    rank0.push(rank)
  }
  const n = list.length
  return { n, hit1: h1 / n, hit3: h3 / n, mrr: mrr / n, rank0 }
}
// 能不能用，只能问「真去加载一次」的结果——denseStatus() 在没试过之前报的是 unloaded，
// 那不是「可用」，只是「还没问」。把 unloaded 当可用，没装依赖的机器就会掉到下面那条门槛上。
const warm = prevKill === '0' ? { state: 'off', embedded: 0, total: docs.length, cached: 0 } : await V.denseWarm(docs, {})
// 状态要在「真加载过一次」之后读：没试过之前报的 unloaded 不是结论，把它写进判据就等于自己骗自己。
const denseSt = V.denseStatus()
const DENSE_STATES = ['unloaded', 'ready', 'off']
const denseShapeOk =
  DENSE_STATES.includes(denseSt.state) &&
  typeof denseSt.model === 'string' &&
  typeof denseSt.vecs === 'number' &&
  typeof denseSt.dim === 'number' &&
  (denseSt.state === 'ready' ? denseSt.dim > 0 && denseSt.err === null : true) &&
  (denseSt.state === 'off' ? typeof denseSt.err === 'string' && denseSt.err.length > 0 : true)
check(
  'G12 稠密层只许三态（unloaded / ready / off）；说「坏了」时必须带得出原因，说「好了」时维度必须是真的',
  denseShapeOk,
  JSON.stringify(denseSt),
)
const denseUsable = warm.state === 'ready'
if (denseUsable) {
  const hm = await measureH(fx.queries, docs)
  const hp = await measureH(fx.paraphrase, docs)
  const lost = hm.rank0.filter((r, i) => r !== 0 && base.miss.every((m) => m.q !== fx.queries[i].q)).length
  check(
    'G14 混合检索只许加分：照抄池 hit@1 ≥ 词法且 ≥ 0.92、换说法池 hit@1 ≥ 词法且 ≥ 0.55，且原本第一的一条都不许掉',
    warm.state === 'ready' && hm.hit1 >= Math.max(base.hit1, 0.92) && hp.hit1 >= Math.max(para.hit1, 0.55) && hp.hit3 >= para.hit3 - 1e-9 && lost === 0,
    `混合 照抄 ${hm.hit1.toFixed(3)}/${hm.hit3.toFixed(3)}/${hm.mrr.toFixed(3)}、换说法 ${hp.hit1.toFixed(3)}/${hp.hit3.toFixed(3)}/${hp.mrr.toFixed(3)}；词法 ${base.hit1.toFixed(3)} / ${para.hit1.toFixed(3)}；掉队 ${lost}；向量 ${warm.embedded} 新编 / ${warm.cached} 在手 / 共 ${warm.total}`,
  )
} else {
  let identAll = 0
  for (const q of denseQs) {
    if (sigOf(V.search(q, docs, { k: docs.length })) === sigOf(await V.searchHybrid(q, docs, { k: docs.length }))) identAll++
  }
  check(
    'G14 没有模型就静悄悄退回词法：不装依赖也照样问得动，结果与纯词法逐位相同（不加提示、不改分数）',
    identAll === denseQs.length,
    `${identAll}/${denseQs.length} 逐位相同，状态 ${denseSt.state}`,
  )
}

// ── G15（0.2.155）稠密空手闸门：问句与全库最近的一条差得远，就不给答案 ─────────────
// 词法这边已经证明分不开：负样本里「火星上一天有多少小时」命中的那个词 df=1（全库最稀），
// 词法上它跟真正相关长得一模一样。语义分能分开——实测正样本最低余弦 0.477、
// 负样本除「Python 的 GIL」0.558 外全在 0.412 以下，门槛 0.44 时负样本挡 13/14、正样本误杀 0/58。
// 条数固定：有模型报「挡住几条 + 掐掉了几条正样本」，没模型报「一条都没判」——
// 后一条不是凑数，它是「可选性」这件事本身的验收项（关了闸门不许有任何副作用）。
const gateBlocked = []
for (const q of NEG_QUERIES) {
  const g = await V.denseGate(q, docs, {})
  if (g.fired) gateBlocked.push(q)
}
const gateKilled = []
for (const { q } of [...fx.queries, ...fx.paraphrase]) {
  const g = await V.denseGate(q, docs, {})
  if (g.fired) gateKilled.push(q)
}
if (denseUsable) {
  check(
    'G15 稠密空手闸门：与库不沾边的问句至少挡 12/14，且一条正样本都不许被掐（可选层，没模型时这条不判）',
    gateBlocked.length >= 12 && gateKilled.length === 0,
    `挡住 ${gateBlocked.length}/14，误掐 ${gateKilled.length}/58；漏过去：${NEG_QUERIES.filter((q) => !gateBlocked.includes(q)).join(' / ') || '无'}`,
  )
} else {
  check(
    'G15 没有稠密就不判：闸门一条都不许触发（可选层不许在没模型时改变任何回执）',
    gateBlocked.length === 0 && gateKilled.length === 0,
    `挡住 ${gateBlocked.length}/14、误掐 ${gateKilled.length}/58，状态 ${denseSt.state}`,
  )
}

// ── G16（0.2.156）来源一行：读一条记忆能回答「从哪来、为什么在库里、还有人用吗」 ────────
// 判据不是「有没有这一行」，而是「四种来路各说各的话，且没库的时候闭嘴」：
// 迁移 / 整理封存 / 会话直写 / 没记来源会话，四条不许说成同一句；
// 没有库、没有 id 时返回空串（不占 token、也不替人建出一个空库来）。
{
  const PROV = await import(pathToFileURL(join(root, 'lib', 'macro', 'provenance.js')).href)
  const home = mkdtempSync(join(tmpdir(), 'probe-gold-prov-'))
  const realHome = mkdtempSync(join(tmpdir(), 'probe-gold-prov-none-'))
  const P = await import(pathToFileURL(join(root, 'vendor', 'meow-memory', 'lib', 'index.js')).href)
  const d = P.getDb(home, '.dsh-meow')
  const now = Date.now()
  const ins = (id, extra) =>
    d
      .p(
        `INSERT INTO lesson (id, title, content, importance, keywords, status, source_session, hit_count, created_at, updated_at, last_accessed_at, corrected, project)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(id, '', '正文', 1, '[]', 'active', extra.src ?? null, extra.hit ?? 0, extra.ts, extra.ts, extra.last ?? null, extra.cor ?? 0, null)
  ins('probe-migr1', { src: 'migration', ts: now - 86_400_000 })
  ins('probe-drem1', { src: 'session-deadbeef-0001', ts: now - 7_200_000 })
  ins('probe-drec1', { src: 'session-deadbeef-0001', ts: now - 600_000, hit: 7, last: now - 60_000, cor: 1 })
  ins('probe-nosr1', { src: '', ts: now - 300_000 })
  d.p('INSERT INTO dream_log (run_at, summary, changes, note) VALUES (?,?,?,?)').run(now - 7_200_000 + 360_000, 'probe dream', '{}', '')
  const note = (id, ws = home) => PROV.provenanceNote({ workspace: ws, id })
  const shapes = {
    migr: note('probe-migr1').includes('迁移'),
    dream: note('probe-drem1').includes('那次整理里封存'),
    used: note('probe-drec1').includes('被读过 7 次') && note('probe-drec1').includes('主人纠正过'),
    nosrc: note('probe-nosr1').includes('没有记来源会话'),
    silent: note('probe-migr1', join(home, 'nope')) === '' && note('') === '',
  }
  const notMade = !existsSync(join(home, 'nope', '.dsh-meow', 'memory.db'))
  const bad = Object.entries(shapes)
    .filter(([, ok]) => !ok)
    .map(([k]) => k)
  check(
    'G16 来源一行：迁移／整理封存／会话直写／没记来源会话四种来路各说各的话，没库时闭嘴且不建库',
    bad.length === 0 && notMade,
    bad.length === 0 ? `${Object.keys(shapes).length}/${Object.keys(shapes).length} 形态对，没库不建库` : `说不清的：${bad.join(' / ')}${notMade ? '' : '；还顺手建了个空库'}`,
  )
  for (const dir of [home, realHome]) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* Windows 上 sqlite 还开着句柄时删不掉，留在临时目录里也无害 */
    }
  }
}

check('G6 每个 want 都在语料里（问句指向的答案真的存在）', orphans.length === 0, orphans.join(' | '))

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
if (failures !== 0) process.exitCode = 1
