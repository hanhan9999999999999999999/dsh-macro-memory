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

check('G6 每个 want 都在语料里（问句指向的答案真的存在）', orphans.length === 0, orphans.join(' | '))

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
if (failures !== 0) process.exitCode = 1
