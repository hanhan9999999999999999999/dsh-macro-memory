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
 *   G16 来源一行：四种来路各说各的话，没库时闭嘴（0.2.156）
 *   G17 改前留一版：按句改只动那一句、找不到/多处命中一个字都不写、留底最多 3 版（0.2.157）
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

// ── G17（0.2.157）改前留一版：按句改便宜，但不能变成「整段删」或「改坏了没退路」 ──────
// 判据分两半：纯函数那半（找得到/找不到/多处命中/缩水闸）不碰库就能量；
// 库那一半（留底、上限 3 版、取回上一版）用临时 home 真写一遍。
{
  const REV = await import(pathToFileURL(join(root, 'lib', 'macro', 'revisions.js')).href)
  const home = mkdtempSync(join(tmpdir(), 'probe-gold-rev-'))
  const V2 = await import(pathToFileURL(join(root, 'vendor', 'meow-memory', 'lib', 'index.js')).href)
  const d = V2.getDb(home, '.dsh-meow')
  const body = '这条记忆讲的是 WAL：写入先落 -wal 文件，checkpoint 之后才合进主库。'
  d.p(
    `INSERT INTO lesson (id, title, content, importance, keywords, status, source_session, hit_count, created_at, updated_at, last_accessed_at, corrected, project)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run('probe-rev001', '', body, 1, '[]', 'active', null, 0, Date.now(), Date.now(), null, 0, null)

  const hit = REV.applyPatches(body, [{ find: '写入先落', replace: '写入先写进' }])
  const miss = REV.applyPatches(body, [{ find: '这句话不在正文里', replace: 'x' }])
  const many = REV.applyPatches('的的的', [{ find: '的', replace: '之' }])
  const app = REV.appendTo('上一段。', '下一段。')
  const shrunk = REV.shrinkGuard('一'.repeat(100), '一'.repeat(10))
  const shrunkOk = REV.shrinkGuard('一'.repeat(100), '一'.repeat(10), true)
  const shortOk = REV.shrinkGuard('一'.repeat(20), '一'.repeat(5))

  const s1 = REV.saveRevision({ workspace: home, id: 'probe-rev001', content: body, reason: 'patch' })
  const s2 = REV.saveRevision({ workspace: home, id: 'probe-rev001', content: body, reason: 'patch' })
  for (let i = 0; i < 5; i += 1) REV.saveRevision({ workspace: home, id: 'probe-rev001', content: `${body}（第 ${i} 版）`, reason: 'append' })
  const kept = REV.revisionCount({ workspace: home, id: 'probe-rev001' })
  const back1 = REV.revisionContent({ workspace: home, id: 'probe-rev001', back: 1 })
  const silent = REV.revisionNote({ workspace: join(home, 'nope'), id: 'probe-rev001' }) === '' && REV.revisionContent({ workspace: join(home, 'nope'), id: 'probe-rev001' }) === null
  const notMade = !existsSync(join(home, 'nope', '.dsh-meow', 'memory.db'))

  const wrong = []
  if (!(hit.ok && hit.content.includes('写入先写进') && !hit.content.includes('写入先落'))) wrong.push('唯一命中没只动那一句')
  if (!(!miss.ok && miss.why.includes('找不到'))) wrong.push('找不到还敢写')
  if (!(!many.ok && many.why.includes('3 次'))) wrong.push('多处命中不拦')
  if (!(app.ok && app.content === '上一段。\n\n下一段。')) wrong.push('追加没空一行')
  if (shrunk.ok) wrong.push('缩水三成没拦')
  if (!shrunkOk.ok) wrong.push('allowShrink 也不放行')
  if (!shortOk.ok) wrong.push('短文本被闸门误拦')
  if (!(s1.saved === true && s2.saved === false && s2.why === 'same-as-last')) wrong.push('逐字相同的旧正文重复记了')
  if (kept !== 3) wrong.push(`留底 ${kept} 版（应为 3）`)
  if (!(typeof back1 === 'string' && back1.length > 0)) wrong.push('取不回上一版')
  if (!silent || !notMade) wrong.push('没库时没闭嘴／顺手建了空库')
  check(
    'G17 改前留一版：按句改只动那一句，找不到与多处命中一个字都不写，留底 3 版且能退回上一版',
    wrong.length === 0,
    wrong.length === 0 ? '纯函数 7 条 + 留底 4 条都对' : wrong.join(' / '),
  )
  try {
    rmSync(home, { recursive: true, force: true })
  } catch {
    /* Windows 上 sqlite 还开着句柄时删不掉，留临时目录里无害 */
  }
}

// ── G18（0.2.159）时间锚：问句自己指了一个时刻，就别按「现在」折它 ─────────────
// 这一条量的是「口径」不是「技巧」：问「0.2.146 加了什么」，答的该是那一次的交付记录，
// 哪怕它现在已经 stale；问「现在主线推进到哪一版」，该按现在的状态排。
// 只免两样折扣（新鲜度、状态），词分与覆盖度一个都不许动——动了就不是锚点，是改判。
{
  const anchorM = measure(fx.anchor, docs)
  const offAll = measure(fx.queries, docs, { timeAnchor: false })
  const sigOf = (q, opts) =>
    V.search(q, docs, { k: docs.length, ...opts }).map((h) => `${h.id}:${Number(h.score).toFixed(6)}`).join('|')
  const plainQs = [...fx.queries, ...fx.paraphrase].map((x) => x.q).filter((q) => !V.timeAnchorOf(q))
  const drifted = plainQs.filter((q) => sigOf(q) !== sigOf(q, { timeAnchor: false }))

  const aq = '0.2.146 加了什么'
  const on = V.search(aq, docs, { k: docs.length, explain: true })
  const off = V.search(aq, docs, { k: docs.length, explain: true, timeAnchor: false })
  const onById = new Map(on.map((h) => [String(h.id), h]))
  const bm25Same = off.every((h) => onById.get(String(h.id)) !== undefined && onById.get(String(h.id)).explain.bm25 === h.explain.bm25)
  const exempted = on.filter((h) => h.explain.anchorHit === true)
  const noDiscount = exempted.length > 0 && exempted.every((h) => h.explain.recencyWeight === 1 && h.explain.statusWeight === 1)
  const staleFirst = String(on[0].id) === '0mwq5zzv'
  const staleSecondOff = String(off[0].id) !== '0mwq5zzv'
  const staleStayedStale = String(onById.get('0mwq5zzv').status ?? 'stale') !== 'active'

  const formsOk = ['0.2.146', '2026-11-21', '2026年11月'].every((t) => V.timeAnchorOf(`什么时候 ${t}`) === true)
  const plainOk = ['评测台为什么封存', '现在主线推进到哪一版', '跑评测要不要先报预算'].every((t) => V.timeAnchorOf(t) === false)

  const wrong = []
  if (!(anchorM.hit1 >= 0.7 && anchorM.hit3 === 1)) wrong.push(`锚点组 hit@1=${anchorM.hit1.toFixed(3)} hit@3=${anchorM.hit3.toFixed(3)}`)
  if (!(offAll.hit1 < base.hit1)) wrong.push('关掉时间锚后 45 池没有变差——阴性对照失效')
  if (drifted.length !== 0) wrong.push(`${drifted.length} 条非锚问句被影响了`)
  if (!bm25Same) wrong.push('词分被改了（锚点只许免折扣）')
  if (!noDiscount) wrong.push('免折的条目里 recency/status 仍不是 1')
  if (!staleFirst || !staleSecondOff) wrong.push('0.2.146 的正解没回到榜首（或关掉后也还在榜首）')
  if (!staleStayedStale) wrong.push('为了排名把 stale 洗成了 active')
  if (!formsOk || !plainOk) wrong.push('锚点形态识别不对')
  check(
    'G18 时间锚：问句自带版本号/日期就按「那一刻」排，只免新鲜度与状态两样折扣，词分一个都不动',
    wrong.length === 0,
    wrong.length === 0
      ? `锚点组 hit@1=${anchorM.hit1.toFixed(3)} hit@3=${anchorM.hit3.toFixed(3)}；关掉后 45 池 hit@1=${offAll.hit1.toFixed(3)} < 开时 ${base.hit1.toFixed(3)}；非锚问句漂移 0/${plainQs.length}；词分不变、免折 ${exempted.length} 条`
      : wrong.join(' / '),
  )
}

// ── G19（0.2.160）弱命中就说清：分低别装懂，把「差在哪」说出来 ────────────────
// 这一条量的是「诚实度」不是「命中率」：词对不上时（换说法池 hit@1=0.500）排序改不动，
// 那就把「榜首只覆盖了问句的几成」这件事说给调用方听，并给出库里实际用的说法。
// 三条底线：强命中一个字都不多说（零字节）、版本号问句不误报、说的都是能核对的事实。
{
  const noteOf = (q, opts) => V.weakNoteOf(V.search(q, docs, { k: 5 }), { query: q, ...opts })
  const hitOf = (q, opts) => V.search(q, docs, { k: 5, ...opts })

  const all = [...fx.queries, ...fx.paraphrase, ...fx.anchor]
  const notes = all.map((x) => noteOf(x.q))
  const fired = notes.filter((s) => s.length > 0).length
  const maxLen = notes.reduce((m, s) => Math.max(m, s.length), 0)

  // 最弱的一条（换说法池里正解与榜单交集为 0）必须说；一句正常问法必须闭嘴
  const weakQ = '自测怎么才算真的测到了东西'
  const weakNote = noteOf(weakQ)
  const quietQ = fx.queries.map((x) => x.q).find((q) => {
    const h = V.search(q, docs, { k: 5 })
    return h.length > 0 && h[0].anchored !== true && Number(h[0].cover) >= 0.35
  })
  const quietNote = quietQ === undefined ? '（找不到强命中样例）' : noteOf(quietQ)

  // 版本号问句：榜首那条自己就带这个版本号 → 不许说「措辞对不上」
  const anchoredQ = all.map((x) => x.q).find((q) => V.search(q, docs, { k: 2 })[0]?.anchored === true)
  const anchoredW = anchoredQ === undefined ? null : V.weakHitOf(hitOf(anchoredQ), { query: anchoredQ })
  const anchoredNote = anchoredQ === undefined ? '（找不到锚点样例）' : noteOf(anchoredQ)

  // 覆盖度是个比值：每条 hit 都该在 0..1 之间，且 explain 里点得出来
  const coverOk = all.every((x) =>
    V.search(x.q, docs, { k: 5 }).every((h) => typeof h.cover === 'number' && h.cover >= 0 && h.cover <= 1),
  )
  const exCover = typeof hitOf(weakQ, { explain: true })[0].explain.cover === 'number'

  // 阈值可覆盖：同一个问句，把门槛放到极低就闭嘴、放到极高就说——说明判据是门槛而不是偶然
  const forceQuiet = quietQ === undefined ? '' : noteOf(quietQ, { cover: 0, gap: 2 })
  const forceFire = quietQ === undefined ? 'x' : noteOf(quietQ, { cover: 1, gap: 2 })

  // 抽词：三种 keywords 写法都吃、剔数字、剔问句里已有的词、最多 3 个、每个 2–12 字
  const kwArr = V.hintWordsOf({ keywords: ['重放脚本', '锚点断言', '0.2.160', '验证', '补丁脚本'] }, '锚点断言怎么写')
  const kwJson = V.hintWordsOf({ keywords: '["重放脚本","锚点断言"]' }, '锚点断言怎么写')
  const kwCsv = V.hintWordsOf({ keywords: '重放脚本,锚点断言' }, '锚点断言怎么写')
  const kwNone = V.hintWordsOf({ keywords: '' }, '随便问问')
  const kwOk = (w) =>
    Array.isArray(w) && w.length <= 3 && w.every((t) => typeof t === 'string' && t.length >= 2 && t.length <= 12 && !/^\d+$/.test(t))
  // 问句里已有的词（锚点断言）与纯数字/版本号（0.2.160）都不该被当成「库里的说法」提出来
  const kwClean = kwArr.every((t) => !t.includes('锚点断言') && !/^[\d.\-/]+$/.test(t)) && kwArr.length === 3

  const wrong = []
  if (!(weakNote.length > 0 && weakNote.includes('换个词'))) wrong.push('最弱的问句没有提示')
  if (weakNote.includes('0.2.160') || weakNote.includes('锚点断言是不是')) wrong.push('提示里把问句原样复读了')
  if (quietNote !== '') wrong.push(`强命中仍多说了 ${quietNote.length} 字（应为零字节）`)
  if (anchoredQ !== undefined && !(anchoredW?.weak === false && anchoredW?.why === 'anchor' && anchoredNote === '')) {
    wrong.push('版本号问句被当成弱命中')
  }
  if (!coverOk || !exCover) wrong.push('cover 不在 0..1 或 explain 里没有')
  if (quietQ !== undefined && !(forceQuiet === '' && forceFire.length > 0)) wrong.push('阈值覆盖不动（判据不是门槛）')
  if (!kwOk(kwArr) || !kwOk(kwJson) || !kwOk(kwCsv) || kwNone.length !== 0) wrong.push('抽词规则不对')
  if (!kwClean) wrong.push('抽词没剔掉数字或问句里的词')
  if (!(maxLen <= 200)) wrong.push(`句长 ${maxLen} 字（上限 200）`)
  if (!(fired < all.length)) wrong.push('每条都说 = 等于没说')
  check(
    'G19 弱命中就说清：分低时说「差在哪」并给出库里的说法，强命中零字节，版本号问句不误报',
    wrong.length === 0,
    wrong.length === 0
      ? `${all.length} 问触发 ${fired}（${Math.round((fired / all.length) * 100)}%），句长 ≤ ${maxLen} 字；强命中 0 字节；锚点问句 ${anchoredQ === undefined ? '无样例' : '按情况闭嘴'}；抽词 3 种写法一致`
      : wrong.join(' / '),
  )
}

// ── G20（0.2.161）关键词字段更值钱：真库里 title 全空，keywords 是唯一的结构化桥 ─────────
// 这一条量的是「一个数该值多少」：不是把关键词抬得越高越好，而是抬到平台里——
// 抬过头照抄池就开始掉（tf1/fw1.2 → 0.911），抬回来（旧口径 tf0.25/fw0.35）锚点池就掉到 0.700。
// 平台内部的组合读数必须与默认**完全同分**，否则就不是平台，是一个捏出来的点。
{
  const base = measure(fx.queries, docs)
  const pBase = measure(fx.paraphrase, docs)
  const aBase = measure(fx.anchor, docs)

  const sig = (list, opts) =>
    list
      .map(({ q }) => V.search(q, docs, { k: K, ...opts }).map((h) => `${h.id}:${Number(h.score).toFixed(6)}`).join(','))
      .join('|')

  // ① 平台：三个平台内组合与默认逐条同分
  const plateau = [
    { kwTfW: 0.3, fieldKwW: 0.7 },
    { kwTfW: 0.325, fieldKwW: 0.65 },
    { kwTfW: 0.325, fieldKwW: 0.7 },
  ]
  // 平台看的是「排名与读数一处不动」，不是分数一模一样——权重不同，分数本来就该有一点差。
  // 平台只认读数（hit@1 / hit@3 / MRR）：同分并列的条目在平台内会换位子，读数一处不动才是判据。
  const orderOf = (list, opts) => list.length + ':' + list.reduce((n, { q }) => n + V.search(q, docs, { k: 3, ...opts }).length, 0)
  const trip = (o) => {
    const m = [measure(fx.queries, docs, o), measure(fx.paraphrase, docs, o), measure(fx.anchor, docs, o)]
    const r = (x) => Math.round(x * 1e3) / 1e3
    return m.map((x) => `${r(x.hit1)}/${r(x.hit3)}/${r(x.mrr)}`).join(' ')
  }
  const tripBase = trip({})
  const plateauOk = plateau.every((o) => trip(o) === tripBase)

  // ② 旧口径回退：锚点池必须真的变差（说明这两个数确实在起作用）
  const aOld = measure(fx.anchor, docs, { kwTfW: 0.25, fieldKwW: 0.35 })

  // ③ 抬过头：照抄池必须变差（说明不是「越大越好」）
  const qHot = measure(fx.queries, docs, { kwTfW: 1, fieldKwW: 1.2 })

  // ④ 照抄池零漂移：默认 vs 旧口径逐条排名相同
  const ranksOf = (list, opts) =>
    list.map(({ q, want }) => {
      const ids = V.search(q, docs, { k: K, ...opts }).map((h) => String(h.id))
      return ids.findIndex((id) => want.includes(id))
    })
  const rDefault = ranksOf(fx.queries, {})
  const rOld = ranksOf(fx.queries, { kwTfW: 0.25, fieldKwW: 0.35 })
  const drift = rDefault.reduce((n, r, i) => n + (r === rOld[i] ? 0 : 1), 0)

  // ⑤ 导出的常量就是默认值：显式传回它们必须与 {} 逐条同分
  const exportedOk = sig(fx.anchor, { kwTfW: V.KW_TF_W, fieldKwW: V.FIELD_KW_W_DEF }) === sig(fx.anchor, {})

  // ⑥ 换说法池不许被代价掉
  const pNew = measure(fx.paraphrase, docs)

  // ⑦ 平台边缘的反面：平台**外**必须真的不同分，否则「平台」就是随口一说的范围
  const qEdge = measure(fx.anchor, docs, { kwTfW: 0.4, fieldKwW: 0.45 })

  // ⑧ 同读数取保守值：0.5 / 0.6 的读数与默认一模一样，却会把「只在 keywords 里提到的条目」
  // 压过「正文命中的条目」——0.2.152 的「标签不是正文」在前，读数打平时只能选不破规矩的那个。
  const pairDocs = [
    { id: 'P', level: 'fact', title: '', content: '甲乙丙丁戊己', keywords: ['口径'], importance: 1, project: 'g20', updated_at: 1763e9, last_accessed_at: 1763e9 },
    { id: 'Q', level: 'fact', title: '', content: '口径甲乙丙丁', keywords: [], importance: 1, project: 'g20', updated_at: 1763e9, last_accessed_at: 1763e9 },
  ]
  const pairScore = (opts, id) => {
    const h = V.search('口径', pairDocs, { k: 2, ...opts }).find((x) => String(x.id) === id)
    return Number(h?.score ?? 0)
  }
  const tagBelowBody = (opts) => pairScore(opts, 'Q') > pairScore(opts, 'P')
  const invariantKept = tagBelowBody({})
  const hotBreaks = tagBelowBody({ kwTfW: 0.5, fieldKwW: 0.6 }) === false

  const wrong = []
  if (!plateauOk) wrong.push('平台内组合与默认不同分（判据不是平台）')
  if (!(aOld.hit1 <= 0.75 && aOld.mrr < aBase.mrr)) {
    wrong.push(`旧口径下锚点池没变差（hit@1=${aOld.hit1.toFixed(3)}）——阴性对照失效`)
  }
  if (!(qHot.hit1 < base.hit1)) wrong.push('关键词一路抬到 1/1.2 照抄池也没变差（判据不是门槛）')
  if (drift !== 0) wrong.push(`照抄池 ${drift} 条排名被动了`)
  if (!exportedOk) wrong.push('导出的 KW_TF_W / FIELD_KW_W_DEF 不是实际默认值')
  if (!(pNew.hit1 >= pBase.hit1 && pNew.hit3 >= pBase.hit3)) wrong.push('换说法池被代价掉了')
  if (Math.round(qEdge.hit1 * 1e3) === Math.round(aBase.hit1 * 1e3) && Math.round(qEdge.mrr * 1e3) === Math.round(aBase.mrr * 1e3)) {
    wrong.push('平台外的组合也与默认同分（平台边界不实）')
  }
  if (!invariantKept) wrong.push('默认值把「只在 keywords 里提到的条目」压过了正文命中的条目（破 0.2.152 的规矩）')
  if (!hotBreaks) wrong.push('0.5/0.6 居然没破规矩——那这条对照就白写了')

  check(
    'G20 关键词更值钱：抬到平台（不是捏一个点），旧口径锚点池掉、抬过头照抄池掉、照抄池零漂移',
    wrong.length === 0,
    wrong.length === 0
      ? `默认 照抄 ${base.hit1.toFixed(3)}/换说法 ${pNew.hit1.toFixed(3)}（hit@3 ${pNew.hit3.toFixed(3)}）/锚点 ${aBase.hit1.toFixed(3)}·MRR ${aBase.mrr.toFixed(3)}；平台 ${plateau.length}/${plateau.length} 同分；旧口径锚点 ${aOld.hit1.toFixed(3)}·MRR ${aOld.mrr.toFixed(3)}；抬过头照抄 ${qHot.hit1.toFixed(3)}；照抄漂移 ${drift} 条`
      : wrong.join(' / '),
  )
}
// ── G21（0.2.162）同义词桥：词面零交集时，换个说法还得找得到 ─────────────────────
// 换说法池 hit@1 卡在 0.500 不是排序不聪明，是「根本没有可比的词」：中文二元组这一层没有词形变化，
// 「反省」和「反思」、「推送」和「远端」在词面上就是两套东西。这一条量四件事：
//   ① 表本身站得住（手工、二字词、无跨组重复、权重在 (0,1) 开区间——换个说法能帮忙不能顶替原话）；
//   ② 真起作用（换说法池比关桥基线高，且不是靠代价照抄/锚点池换来的）；
//   ③ 只在加法那一层动（覆盖度分母、照抄池、锚点池逐条一处不动）；
//   ④ 自带阴性对照（关桥 = 权重 0；空表返回 null；只含同义词的条目在关桥时进不了候选、开桥时进得来）。
{
  const ranksOf = (list, opts) =>
    list.map(({ q, want }) => {
      const w = Array.isArray(want) ? want.map(String) : [String(want)]
      const ids = V.search(q, docs, { k: K, ...opts }).map((h) => String(h.id))
      return ids.findIndex((id) => w.includes(id))
    })
  const sigOf = (list, opts) =>
    list.map(({ q }) => V.search(q, docs, { k: K, ...opts }).map((h) => `${h.id}:${Number(h.score).toFixed(6)}`).join(',')).join('|')

  // ① 表形态
  const groups = V.SYN_GROUPS
  const flat = groups.flat()
  const shapeOk =
    Array.isArray(groups) &&
    groups.length >= 12 &&
    groups.every((g) => Array.isArray(g) && g.length >= 2 && g.every((w) => typeof w === 'string' && [...w].length === 2)) &&
    new Set(flat).size === flat.length &&
    typeof V.SYN_W === 'number' &&
    V.SYN_W > 0 &&
    V.SYN_W < 1 &&
    typeof V.synExpandOf === 'function'

  // ② 真起作用（换说法池 vs 关桥）
  const pOn = measure(fx.paraphrase, docs)
  const pOff = measure(fx.paraphrase, docs, { synBridge: false })

  // ③ 照抄池/锚点池零漂移（排名与读数都要一处不动）
  const qOn = measure(fx.queries, docs)
  const qOff = measure(fx.queries, docs, { synBridge: false })
  const aOn = measure(fx.anchor, docs)
  const aOff = measure(fx.anchor, docs, { synBridge: false })
  const qDrift = ranksOf(fx.queries, {}).reduce((n, r, i) => n + (r === ranksOf(fx.queries, { synBridge: false })[i] ? 0 : 1), 0)
  const aDrift = ranksOf(fx.anchor, {}).reduce((n, r, i) => n + (r === ranksOf(fx.anchor, { synBridge: false })[i] ? 0 : 1), 0)
  const same = (a, b) => Math.round(a * 1e3) === Math.round(b * 1e3)

  // ④ 覆盖度分母不动：同一条问句的开/关 cover 必须逐条相同（扩词不进 qIdfSum）
  // 覆盖度只认「同一条记忆的 cover 有没有变」：开桥会改变命中集合与顺序，按位置比是错的判据。
  const coverShape = fx.paraphrase.every(({ q }) => {
    const on = new Map(V.search(q, docs, { k: K }).map((h) => [String(h.id), Number(h.cover ?? -1).toFixed(3)]))
    const off = new Map(V.search(q, docs, { k: K, synBridge: false }).map((h) => [String(h.id), Number(h.cover ?? -1).toFixed(3)]))
    for (const [id, v] of on) if (off.has(id) && off.get(id) !== v) return false
    return true
  })

  // ⑤ 候选集：只含同义词的那条，关桥时进不来、开桥时进得来（倒排合并的证据）
  const synCorpus = [
    { id: 'S1', level: 'fact', title: '', content: '这一段讲的是反思', keywords: [], importance: 1, project: 'g21', updated_at: 1763e9, last_accessed_at: 1763e9 },
    { id: 'S2', level: 'fact', title: '', content: '这一段讲的是别的', keywords: [], importance: 1, project: 'g21', updated_at: 1763e9, last_accessed_at: 1763e9 },
  ]
  const synIds = (opts) => V.search('反省', synCorpus, { k: 2, ...opts }).map((h) => String(h.id))
  const bridgeEnters = synIds({}).includes('S1') && !synIds({ synBridge: false }).includes('S1')

  // ⑥ 虚词新增两条真的不进打分：含着「不要」的那条与不带它的一条必须同分
  // 构造要点：问句被剔掉「这个 / 要不 / 不要」之后，剩下的是「个要 / 要紧」；
  // 两条等长文档都只命中「要紧」，F1 多出的「不要」不允许进打分——所以必须同分。
  const funcCorpus = [
    { id: 'F1', level: 'fact', title: '', content: '不要紧', keywords: [], importance: 1, project: 'g21', updated_at: 1763e9, last_accessed_at: 1763e9 },
    { id: 'F2', level: 'fact', title: '', content: '很要紧', keywords: [], importance: 1, project: 'g21', updated_at: 1763e9, last_accessed_at: 1763e9 },
  ]
  const fScore = (id) => Number(V.search('这个要不要紧', funcCorpus, { k: 2 }).find((h) => String(h.id) === id)?.score ?? 0)
  const funcQuiet = same(fScore('F1'), fScore('F2'))

  // ⑦ 老规矩不破：正文命中压过只在 keywords 里的（0.2.152）
  const pairDocs = [
    { id: 'P', level: 'fact', title: '', content: '验收口径甲乙丙丁', keywords: [], importance: 1, project: 'g21', updated_at: 1763e9, last_accessed_at: 1763e9 },
    { id: 'Q', level: 'fact', title: '', content: '甲乙丙丁戊己庚辛', keywords: ['验收'], importance: 1, project: 'g21', updated_at: 1763e9, last_accessed_at: 1763e9 },
  ]
  const pairHits = V.search('验收口径', pairDocs, { k: 2 }).map((h) => String(h.id))
  const tagBelowBody = pairHits[0] === 'P'

  // ⑧ 阴性对照：关桥 = 权重 0，两条必须逐条同分（证明旋钮只有一个）
  const knobOk = sigOf(fx.paraphrase, { synBridge: false }) === sigOf(fx.paraphrase, { synW: 0 })

  // ⑨ 阴性对照：表里没有的词不扩（返回 null），不是「随便扩一堆」
  const noSyn = V.synExpandOf(['毫无关系'], new Map([['关系', 1]])) === null

  const wrong = []
  if (!shapeOk) wrong.push('同义词表形态不对（要 ≥12 组、每组 ≥2、每词两字、无跨组重复、0<SYN_W<1）')
  if (!(pOn.hit1 >= 0.7 && pOn.hit3 >= 0.9)) wrong.push(`换说法池没到门槛（hit@1=${pOn.hit1.toFixed(3)} hit@3=${pOn.hit3.toFixed(3)}）`)
  if (!(pOn.hit1 > pOff.hit1 + 0.05)) wrong.push('换说法池相对关桥基线几乎没动——同义桥没在起作用')
  if (qDrift !== 0 || !same(qOn.hit1, qOff.hit1) || !same(qOn.mrr, qOff.mrr)) wrong.push('照抄池被动了')
  if (aDrift !== 0 || !same(aOn.hit1, aOff.hit1) || !same(aOn.mrr, aOff.mrr)) wrong.push('锚点池被动了')
  if (!coverShape) wrong.push('cover 开/关不一致（扩词进了覆盖度分母）')
  if (!bridgeEnters) wrong.push('只含同义词的条目没被桥进来（倒排候选集没合并同义词 postings）')
  if (!funcQuiet) wrong.push('「不要」还在参与打分（虚词表没生效）')
  if (!tagBelowBody) wrong.push('只在 keywords 里的压过了正文命中的（破 0.2.152 的规矩）')
  if (!knobOk) wrong.push('synBridge:false 与 synW:0 不同分（旋钮不是一个）')
  if (!noSyn) wrong.push('表外词也被扩了（扩词没有边界）')

  check(
    'G21 同义词桥：换个说法能找回（换说法池抬起来），照抄/锚点/覆盖度一处不动，自带四道阴性对照',
    wrong.length === 0,
    wrong.length === 0
      ? `${groups.length} 组 / SYN_W=${V.SYN_W}；换说法 关 ${pOff.hit1.toFixed(3)}/${pOff.hit3.toFixed(3)}/${pOff.mrr.toFixed(3)} → 开 ${pOn.hit1.toFixed(3)}/${pOn.hit3.toFixed(3)}/${pOn.mrr.toFixed(3)}；照抄漂移 ${qDrift} 条、锚点漂移 ${aDrift} 条`
      : wrong.join(' / '),
  )
}

// G22（0.2.163 / 口径纠正 0.2.164）：覆盖度是内容证据，不是装饰——问句里那些词，这条到底占了几成。
// 这一组量的是「证据强度」：抬覆盖度权重必须三池不亏；顺手钉住「幂次是旋钮、默认线性」，
// 以及「库里的行必须经过 fromRow」——0.2.163 的真库读数就是被 raw row 坑掉的。
{
  const eng = readFileSync(join(root, 'vendor', 'meow-memory', 'lib', 'index.js'), 'utf8')
  const wrong = []
  // ① 单一来源：两个常量各一处定义，别的模块不许再写一份「覆盖度算多重」
  const shapeOk =
    eng.split('var COORD_W_DEF = ').length - 1 === 1 &&
    eng.split('var COORD_POW_DEF = ').length - 1 === 1 &&
    !readFileSync(join(root, 'lib', 'macro', 'defs', 'search.js'), 'utf8').includes('COORD_') &&
    !readFileSync(join(root, 'lib', 'macro', 'fusion.js'), 'utf8').includes('COORD_')
  if (!shapeOk) wrong.push('覆盖度的两个常量不是一处定义（或别的模块自己写了一份）')
  if (!(V.COORD_W_DEF === 0.45 && V.COORD_POW_DEF === 1)) wrong.push(`常量值不对：${V.COORD_W_DEF}/${V.COORD_POW_DEF}`)
  // ② 兜底同源：旋钮能覆盖，但默认值必须来自常量
  const knobOk =
    eng.includes('Number.isFinite(opts.coordW) ? opts.coordW : COORD_W_DEF') &&
    eng.includes('Number.isFinite(opts.coordPow) && opts.coordPow > 0 ? opts.coordPow : COORD_POW_DEF') &&
    eng.split('const cvr = Math.pow(Math.min(1, cover / qIdfSum), COORD_POW);').length - 1 === 1 &&
    eng.split('if (cvr > 0) s *= 1 - COORD_W + COORD_W * cvr;').length - 1 === 1
  if (!knobOk) wrong.push('覆盖度没真正进打分路径（幂次或协调因子写偏了）')
  // ③ 行为：覆盖度真的能把分差拉开（受控语料：等长、同 importance、只有覆盖度不同）
  const pad = 'zeta zeta zeta zeta zeta'
  const mk = (id, content) => ({ id, level: 'fact', content, title: '', keywords: [], importance: 1, status: 'active' })
  const covDocs = [
    mk('cov-hi', `alpha beta gamma ${pad}`),
    mk('cov-mid', `alpha beta ${pad} omega`),
    mk('cov-lo', `alpha ${pad} omega omega`),
  ]
  const pairRatio = (a, b, opts) => {
    const hits = V.search('alpha beta gamma', covDocs, { k: 3, ...opts })
    const m = new Map(hits.map((h) => [String(h.id), h.score]))
    return m.get(a) / m.get(b)
  }
  const rNarrow = pairRatio('cov-hi', 'cov-lo', { coordW: 0.35, coordPow: 1 })
  const rWide = pairRatio('cov-hi', 'cov-lo', {})
  if (!(rWide > rNarrow * 1.1)) wrong.push(`抬覆盖度没把分差拉开（${rNarrow.toFixed(2)} → ${rWide.toFixed(2)}）`)
  // ④ 幂次是旋钮、不是默认：抬到 1.2 会让低覆盖更疼（能证明它就够，不代表该当默认）
  const mPow1 = pairRatio('cov-hi', 'cov-lo', { coordW: 0.45, coordPow: 1 })
  const mPow12 = pairRatio('cov-hi', 'cov-lo', { coordW: 0.45, coordPow: 1.2 })
  if (!(mPow12 > mPow1 * 1.02)) wrong.push(`幂次旋钮失效（${mPow1.toFixed(3)} → ${mPow12.toFixed(3)}）`)
  // ⑤ 三池不亏：新口径不许比旧口径低一条
  const curQ = measure(fx.queries, docs)
  const curP = measure(fx.paraphrase, docs)
  const curA = measure(fx.anchor, docs)
  const cnt = (m, key) => Math.round(m[key] * m.n)
  if (!(cnt(curQ, 'hit1') >= 42 && cnt(curQ, 'hit3') >= 44)) wrong.push(`照抄池掉了（${cnt(curQ, 'hit1')}/${cnt(curQ, 'hit3')}，底线 42/44）`)
  if (!(cnt(curP, 'hit1') >= 10 && cnt(curP, 'hit3') >= 13 && curP.mrr >= 0.797)) wrong.push(`换说法池掉了（${cnt(curP, 'hit1')}/${cnt(curP, 'hit3')}，MRR ${curP.mrr.toFixed(3)}）`)
  if (!(cnt(curA, 'hit1') >= 8)) wrong.push(`锚点池掉了（${cnt(curA, 'hit1')}，底线 8）`)
  // ⑥ 三池读数不许被这一格挪动：0.35/1 与默认（0.45/1）逐池同值——覆盖度只该改「同档内谁在前」
  const oldQ = measure(fx.queries, docs, { coordW: 0.35, coordPow: 1 })
  const oldP = measure(fx.paraphrase, docs, { coordW: 0.35, coordPow: 1 })
  const oldA = measure(fx.anchor, docs, { coordW: 0.35, coordPow: 1 })
  const same = (a, b) => a.toFixed(3) === b.toFixed(3)
  if (!(same(oldQ.hit1, curQ.hit1) && same(oldQ.hit3, curQ.hit3) && same(oldQ.mrr, curQ.mrr))) wrong.push('照抄池与 0.35 口径不同值')
  if (!(same(oldP.hit1, curP.hit1) && same(oldP.hit3, curP.hit3) && same(oldP.mrr, curP.mrr))) wrong.push('换说法池与 0.35 口径不同值')
  if (!(same(oldA.hit1, curA.hit1) && same(oldA.mrr, curA.mrr))) wrong.push('锚点池与 0.35 口径不同值')
  // ⑦ 覆盖度本身不被协调因子改动：cover 说的还是「占了几成词」，不跟着权重走
  const coversAt = (opts) => {
    const m = new Map()
    for (const { q } of fx.queries) {
      for (const h of V.search(q, docs, { k: K, ...opts })) m.set(`${q}|${h.id}`, h.cover)
    }
    return m
  }
  const c0 = coversAt({ coordW: 0, coordPow: 1 })
  const c1 = coversAt({})
  let coverMoved = 0
  let coverShared = 0
  for (const [k, v] of c0) {
    if (!c1.has(k)) continue
    coverShared++
    if (c1.get(k) !== v) coverMoved++
  }
  if (coverMoved !== 0 || coverShared < 20) wrong.push(`cover 跟着权重变了 ${coverMoved} 处（只比到 ${coverShared} 条）`)
  // ⑧ 老规矩不破：正文命中的压过只在 keywords 里提到的（标签不是正文）
  const tagDocs = [
    mk('body-hit', '甲组乙组丙组都在这条正文里'),
    { id: 'kw-only', level: 'fact', content: '另一件事，什么都没提', title: '', keywords: ['甲组', '乙组', '丙组'], importance: 1, status: 'active' },
  ]
  const tagRank = V.search('甲组乙组丙组', tagDocs, { k: 2 }).map((h) => String(h.id))
  if (tagRank[0] !== 'body-hit') wrong.push('只在 keywords 里的压过了正文命中的（破 0.2.152 的规矩）')
  // ⑨ 取数口径：关键词通道只认数组。库里 keywords 是 JSON 文本，必须经过 fromRow 解析；
  //    谁绕过 fromRow 把 raw row 喂进 search，关键词通道会安静地整条失效（0.2.163 的真库读数就是这么错的）。
  const kwSites = eng.split('Array.isArray(').length - 1
  if (!(eng.includes('keywords = JSON.parse(String(r.keywords ?? "[]"))') && eng.includes('return rows.map((r) => this.fromRow(level, r));'))) {
    wrong.push('取数口径没有「fromRow 解析 keywords」这条线')
  }
  const kwOnlyDoc = [{ id: 'kw-only-doc', level: 'fact', title: '', content: '这条正文一个问句词都没有。', keywords: ['舵轮校准'], importance: 2, status: 'active' }]
  const kwOnlyHits = V.search('舵轮校准', kwOnlyDoc, { k: 1 })
  if (!(kwOnlyHits.length === 1 && kwOnlyHits[0].cover > 0.9)) wrong.push('只在 keywords 里的词没进词表（关键词通道整条失效了）')
  // ⑩ 有记：文档写清读数与代价
  const int164 = readFileSync(join(root, 'docs', 'INTERNAL.md'), 'utf8')
  const des164 = readFileSync(join(root, 'DESIGN.md'), 'utf8')
  if (!(int164.includes('## 9.171') && int164.includes('148/150') && int164.includes('raw row'))) wrong.push('INTERNAL 9.171 没写读数与口径纠正')
  if (!(des164.includes('## 176') && des164.includes('覆盖度'))) wrong.push('DESIGN 176 没写原则')

  check(
    'G22 覆盖度是证据：抬它能把分差拉开、三池一条不亏、cover 不跟权重走、关键词通道只认数组',
    wrong.length === 0,
    wrong.length === 0
      ? `COORD_W=${V.COORD_W_DEF} POW=${V.COORD_POW_DEF}；分差 ${rNarrow.toFixed(2)} → ${rWide.toFixed(2)}（幂次旋钮 ${mPow1.toFixed(3)} → ${mPow12.toFixed(3)}）；照抄 ${cnt(curQ, 'hit1')}/${cnt(curQ, 'hit3')} · 换说法 ${cnt(curP, 'hit1')}/${cnt(curP, 'hit3')} · 锚点 ${cnt(curA, 'hit1')}`
      : wrong.join(' / '),
  )
}

// ── G23（0.2.165）：回执按置信档收口 ─────────────────────────────────────────
// 这一组只问一件事：bandize 早就判断过「这条和榜首是不是一个量级」，回执有没有用它。
// 判据必须同时说清三件事——省了多少、有没有丢东西、关得掉吗。
{
  const eng = readFileSync(join(root, 'vendor/meow-memory/lib/index.js'), 'utf8')
  const wrong = []
  const occur = (t) => eng.split(t).length - 1
  if (occur('var RESULT_MIN_KEEP = 5;') !== 1) wrong.push('常量 RESULT_MIN_KEEP=5 不是唯一来源')
  if (occur('function trimByBand(') !== 1) wrong.push('trimByBand 没有唯一实现')
  if (occur('return trimByBand(') < 3) wrong.push('search / hybrid / dense 退路没有共用同一个裁剪口径')
  if (!eng.includes('if (opts.keepBand === true) return hits.slice(0,')) wrong.push('hybrid 拿不到带档位的中间结果')
  if (!eng.includes('h._band = b;')) wrong.push('bandize 没有把档位留在 hit 上')

  // 行为：默认回执 = 同档 + 至少 5 条，且绝不越过 k
  const lens = []
  const sameBandOk = []
  for (const { q } of fx.queries.slice(0, 20)) {
    const all = V.search(q, docs, { k: 10, bandKeep: false }).length
    const kept = V.search(q, docs, { k: 10 })
    lens.push(kept.length)
    // 下限只能补到「库里有几条」，不许凭空造：命中不足 5 条时就回那几条。
    sameBandOk.push(kept.length >= Math.min(5, all) && kept.length <= 10)
  }
  if (!sameBandOk.every(Boolean)) wrong.push('默认回执不是「至少 5、最多 k」')

  // 省：默认比关掉裁剪少得多（fixture 照抄池）
  const avgOf = (opts, list = fx.queries) => list.reduce((a, x) => a + V.search(x.q, docs, { k: 10, ...opts }).length, 0) / list.length
  const avgTrim = avgOf({})
  const avgAll = avgOf({ bandKeep: false })
  if (!(avgTrim < avgAll - 0.8)) wrong.push(`没省下多少：${avgTrim.toFixed(2)} vs ${avgAll.toFixed(2)}`)

  // 不丢东西：三池 hit@1 / top5 与关掉裁剪逐池相同
  const rankOf = (list, opts) => list.map(({ q, want }) => {
    const ids = V.search(q, docs, { k: 10, ...opts }).map((h) => String(h.id))
    return ids.findIndex((id) => want.includes(id))
  })
  const pools3 = [['照抄', fx.queries], ['换说法', fx.paraphrase], ['锚点', fx.anchor]]
  const loss = []
  for (const [name, list] of pools3) {
    const a = rankOf(list, {})
    const b = rankOf(list, { bandKeep: false })
    const a5 = a.filter((r) => r >= 0 && r < 5).length
    const b5 = b.filter((r) => r >= 0 && r < 5).length
    const a1 = a.filter((r) => r === 0).length
    const b1 = b.filter((r) => r === 0).length
    if (a5 !== b5 || a1 !== b1) loss.push(`${name} ${a1}/${a5} vs ${b1}/${b5}`)
  }
  if (loss.length > 0) wrong.push('裁剪丢了正解：' + loss.join('；'))

  // 关得掉：minKeep:0 与 bandKeep:false 逐位相同
  let offOk = 0
  for (const { q } of fx.queries.slice(0, 12)) {
    const x = V.search(q, docs, { k: 10, bandKeep: false }).map((h) => h.id).join(',')
    const y = V.search(q, docs, { k: 10, minKeep: 0 }).map((h) => h.id).join(',')
    if (x === y) offOk++
  }
  if (offOk !== 12) wrong.push(`minKeep:0 与 bandKeep:false 不等价（${offOk}/12）`)

  // k 更小时不许越界补
  const small = V.search(fx.queries[0].q, docs, { k: 3 })
  if (small.length > 3) wrong.push(`k=3 时回了 ${small.length} 条`)

  // 下限确实在起作用（minKeep 抬高到 12 也不许越过 k）
  const big = V.search(fx.queries[0].q, docs, { k: 10, minKeep: 12 })
  if (big.length > 10) wrong.push('minKeep 大于 k 时越界')

  // 文档在案
  const int165 = readFileSync(join(root, 'docs/INTERNAL.md'), 'utf8')
  const des165 = readFileSync(join(root, 'DESIGN.md'), 'utf8')
  if (!(int165.includes('## 9.172') && int165.includes('RESULT_MIN_KEEP') && int165.includes('9.80'))) wrong.push('INTERNAL 9.172 没写读数与口径')
  if (!(des165.includes('## 177') && des165.includes('回执'))) wrong.push('DESIGN 177 没写原则')

  check(
    'G23 回执按档收口：同档才回、至少 5 条、三池一条不丢、关得掉、doc 在案',
    wrong.length === 0,
    wrong.length === 0
      ? `默认 ${avgTrim.toFixed(2)} 条 vs 关掉 ${avgAll.toFixed(2)} 条（省 ${(100 * (1 - avgTrim / avgAll)).toFixed(0)}%）；三池 hit@1/top5 未变`
      : wrong.join(' / '),
  )
}

check('G6 每个 want 都在语料里（问句指向的答案真的存在）', orphans.length === 0, orphans.join(' | '))

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
if (failures !== 0) process.exitCode = 1
