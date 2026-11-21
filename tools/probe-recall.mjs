/**
 * [macro-fusion 0.2.85] 召回探针：真 vendor 引擎 + 合成语料，不启动 DSH、不碰真记忆库。
 *
 *   R0 语料：五条合成记忆，层 / 重要度 / 措辞 / 时间全都被控住
 *   R1 相关度优先：`memory_search` 返回的第一条是最相关的那条，不是最旧的那条
 *   R2 重要度进分数：同题竞争时铁律（importance=4）压过随手记（importance=1），
 *      且 explain 里三个因子齐、score = bm25 × recencyWeight × importanceWeight
 *   R3 加成不碾压：只有一条强相关时，沾边的高重要度条目进不了结果
 *   R4 死条目不召回、层过滤真生效、中文长句能召回
 *   R5 阴性对照：同一语料上「importance 全抹平」会把顺序翻过来、
 *      「按 updated_at 升序」会把顺序排成另一个样子——两条判据真的能红
 *
 * 用法：node tools/probe-recall.mjs
 */
import { root } from './_root.mjs'
import { registerHooks } from 'node:module'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

// 记忆库整个落在临时 DSH_HOME 里：探针跑一百遍也不会碰到主人的真库。
const home = mkdtempSync(join(tmpdir(), 'macro-recall-home-'))
process.env.DSH_HOME = home

// dsh-llm stub（真实运行时由 profile 提供，本机没有实体）
const stubDir = mkdtempSync(join(tmpdir(), 'macro-recall-stub-'))
const stubFile = join(stubDir, 'dsh-llm.mjs')
writeFileSync(
  stubFile,
  `export function createUserMessage(init) { return { role: 'user', ...init } }
export function boundContextSummary(text) { return String(text).slice(0, 120) }
export default { createUserMessage, boundContextSummary }
`,
  'utf8',
)
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@deepseek-ai/dsh-llm') return { url: pathToFileURL(stubFile).href, shortCircuit: true }
    return nextResolve(specifier, context)
  },
})

let failures = 0
function check(label, ok, extra) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra === undefined ? '' : '  ' + extra}`)
  if (!ok) failures++
}

const V = await import(pathToFileURL(join(root, 'vendor', 'meow-memory', 'lib', 'index.js')).href)

// ── 拿工具：registerMemoryTools 是纯注册函数，不需要装配整个插件 ────────────
const T = new Map()
V.registerMemoryTools((t) => T.set(t.name, t), '.dsh-meow')
check('R0 工具注册齐（remember / search / update 三件必须有）', ['memory_remember', 'memory_search', 'memory_update'].every((n) => T.has(n)), `${T.size} 个`)

const workspace = join(home, 'ws')
mkdirSync(workspace, { recursive: true })
const exec = { agent: { session: { header: { cwd: workspace, id: 'sess-recall' } } } }
const call = (name, args) => T.get(name).execute(args, exec)

// ── R0 语料 ────────────────────────────────────────────────────────────────
// 顺序是判据的一部分：先写「随手记」（旧、importance=1），再写「铁律」（新、importance=4）。
// 旧实现按 updated_at 升序重排，于是随手记永远压在第一条——这正是 R1 要抓的。
const SEED = [
  {
    key: 'casual',
    level: 'fact',
    importance: 1,
    // 措辞刻意压过铁律：query「部署」在这条里命中三次，在铁律里只命中一次（关键词）。
    // 于是「按 bm25 排」和「按重要度加权后排」会给出不同首条——判据才有区分力。
    content: '今天部署了三次，部署过程都挺顺，部署完顺手记一笔，日志在 var 目录。',
    keywords: ['部署', '日志', '随手记'],
  },
  {
    key: 'iron',
    level: 'lesson',
    importance: 4,
    corrected: true,
    content: '动手之前先备份，别急着上线。',
    keywords: ['部署', '备份', '铁律'],
  },
  {
    key: 'db',
    level: 'fact',
    importance: 1,
    content: '数据库连接池上限设成 32，超过就排队等，别再往上调。',
    keywords: ['数据库', '连接池', '上限'],
  },
  {
    key: 'graph',
    level: 'topic',
    importance: 4,
    content: '星图建图的延迟要盯着，一轮巡检大约 12 秒。',
    keywords: ['星图', '建图', '延迟'],
  },
  {
    key: 'dead',
    level: 'fact',
    importance: 2,
    content: '这条马上归档：压测调优的临时结论。',
    keywords: ['压测', '调优', '临时'],
  },
]
const ids = {}
for (const s of SEED) {
  const r = await call('memory_remember', {
    content: s.content,
    project: '召回探针',
    keywords: s.keywords,
    importance: s.importance,
    level: s.level,
    ...(s.corrected ? { corrected: true } : {}),
  })
  ids[s.key] = r.id
  check(`R0 语料写入 ${s.key}（${s.level} / importance=${s.importance}）`, typeof r.id === 'string' && r.merged !== true, String(r.id).slice(0, 8))
}
const db = V.getDb(workspace, '.dsh-meow')
const rowOf = (key) => db.findById(ids[key])?.row
const docsOf = () =>
  SEED.map((s) => {
    const r = rowOf(s.key)
    return { id: r.id, level: r.level, title: r.title ?? '', content: r.content, keywords: r.keywords, importance: r.importance, created_at: r.created_at, updated_at: r.updated_at }
  })
check('R0 语料时间序：随手记比铁律旧（否则「按时间排」和「按相关度排」分不开）', (rowOf('casual')?.updated_at ?? 0) <= (rowOf('iron')?.updated_at ?? 1))

// ── R1 相关度优先：第一条是「正文里就在说这件事」的那条 ─────────────────────
// [macro-fusion 0.2.152] 这条判据改过口径，改的理由记在这里：
// 旧版断言「铁律（importance 4，只有 keywords 里提到『部署』）压过随手记（正文提三次）」，
// 那是在关键词平铺进正文（+35% 字段加成）的旧打分下成立的——靠的正是 0.2.150 明令禁止的
// 「先验越级」。0.2.152 把关键词降成标签（tf 打 0.25 折、候选资格保留）之后，铁律落在下一档，
// impW 就再也翻不过去。于是改成显式口径：
//   正文重复说这件事的排第一；只在 keywords 里提到它的，靠桥接进榜但排后面。
// 这跟 0.2.150「证据先分档」一致：关键词是「用户会怎么问」的标签，不是「这条在讲什么」的证据。
const explainOfR1 = (hits, key) => hits.find((h) => h.id === ids[key])?.explain
const hitsR1 = (await call('memory_search', { query: '部署', explain: true, k: 10 })).hits
check('R1 首条是正文就在说这件事的那条（措辞三次），不是只在关键词里提到它的铁律',
  hitsR1[0]?.id === ids.casual, `${hitsR1[0]?.level} ${String(hitsR1[0]?.content ?? '').slice(0, 12)}`)
check('R1 关键词桥接没断：只在 keywords 里提到「部署」的铁律仍在结果里，且 bm25 > 0',
  hitsR1.some((h) => h.id === ids.iron) && (explainOfR1(hitsR1, 'iron')?.bm25 ?? 0) > 0,
  `铁律 bm25=${explainOfR1(hitsR1, 'iron')?.bm25} 排名=${hitsR1.findIndex((h) => h.id === ids.iron) + 1}`)
const scoresR1 = hitsR1.map((h) => h.score)
check('R1 分数单调不增（排序真按分数，不是按时间）', scoresR1.every((v, i) => i === 0 || scoresR1[i - 1] >= v), scoresR1.join(' ≥ '))
// 因果写清楚：铁律的先验不是「没算」，是算了也不够——impW 1.75 确实乘上去了，
// 但关键词只做标签（tf 打 0.25 折）之后它的词分本来就低，先验抬不动这条差距。
// 这正是 0.2.150 的规矩：先验可以决定同档谁先开口，不能决定谁有资格开口。
const exIronR1c = explainOfR1(hitsR1, 'iron')
check('R1 先验算了也没翻上去：铁律 impW 1.75 已生效，末尾仍是 0.97 < 榜首 1.83（差距来自词分，不是没算）',
  exIronR1c?.importanceWeight === 1.75 && (exIronR1c?.score ?? 0) < (hitsR1[0]?.score ?? 0),
  `iron impW=${exIronR1c?.importanceWeight} score=${exIronR1c?.score} / 榜首 ${hitsR1[0]?.score}`)

// ── R2 重要度进分数 + explain 三因子 ───────────────────────────────────────
const explainOf = (hits, key) => hits.find((h) => h.id === ids[key])?.explain
const exIron = explainOf(hitsR1, 'iron')
check('R2 explain 三个因子齐（bm25 / importanceWeight / recencyWeight）', ['bm25', 'importanceWeight', 'recencyWeight'].every((k) => typeof exIron?.[k] === 'number'), JSON.stringify(exIron))
check('R2 importance=4 的乘数是 1.75', exIron?.importanceWeight === 1.75, String(exIron?.importanceWeight))
check('R2 importance=1 的乘数是 1', explainOf(hitsR1, 'casual')?.importanceWeight === 1, String(explainOf(hitsR1, 'casual')?.importanceWeight))
const recomputed = hitsR1.map((h) => Math.round(h.explain.bm25 * h.explain.recencyWeight * h.explain.importanceWeight * 100) / 100)
check('R2 score = bm25 × recencyWeight × importanceWeight（分项能还原总分）', recomputed.every((v, i) => Math.abs(v - hitsR1[i].score) <= 0.011), `${recomputed.join(',')} vs ${hitsR1.map((h) => h.score).join(',')}`)
check('R2 铁律的 bm25 确实低于随手记（它是标签桥接进榜的，不是靠措辞赢的）', exIron.bm25 <= (explainOf(hitsR1, 'casual')?.bm25 ?? Infinity), `${exIron.bm25} vs ${explainOf(hitsR1, 'casual')?.bm25}`)

// 阴性对照（0.2.152 重写）：原写法「importance 全抹平后首条翻成随手记」是 0.2.150 分档之前的契约——
// 现在榜首本来就是随手记，抹平重要度也不会翻，那条断言已恒真（量不到东西）。改成量两件真事：
// ①抹平后铁律的分数必须掉下来（先验确实在算）；②按时间升序摆一遍首条不是现在这条（排序不是按时间蒙对的）。
const flat = V.search('部署', docsOf().map((d) => ({ ...d, importance: 1 })), { k: 10, explain: true })
const flatIron = flat.find((h) => h.id === ids.iron)
const ironScore = hitsR1.find((h) => h.id === ids.iron)?.score
check('R2 阴性对照：抹平 importance 后铁律分数确实掉了（先验真在算，不是摆设）',
  (flatIron?.score ?? 0) < (ironScore ?? 0) - 1e-9,
  `抹平 ${flatIron?.score} vs 原 ${ironScore}`)
// 时间序对照（0.2.152 重写）：R1 那两条里「随手记」恰好也是最旧的一条，时间序跟名次串重合——
// 在这份语料上「按时间排会不同」量不出来。改用独立小语料：相关的新、无关的旧，
// 真按时间升序会先把无关的旧条顶上来，而引擎给的是相关的新条。
const T_A85 = [
  { id: 't-old', level: 'fact', title: '', content: '数据库连接池的默认大小是八', keywords: [], importance: 4, status: 'active', created_at: 1, updated_at: 1000 },
  { id: 't-new', level: 'fact', title: '', content: '连接池上限调错了会打满', keywords: [], importance: 1, status: 'active', created_at: 2, updated_at: 9e12 },
]
const tHits = V.search('连接池 上限', T_A85, { k: 2, explain: true })
const tTime = T_A85.slice().sort((a, b) => a.updated_at - b.updated_at).map((d) => d.id)
check('R2 阴性对照：相关的那条更新，按时间升序却会先给无关的旧条（排序不是按时间蒙对的）',
  tHits[0]?.id === 't-new' && tTime[0] === 't-old',
  `引擎首条 ${tHits[0]?.id} / 时间序首条 ${tTime[0]}`)

// ── R3 加成不碾压：强相关只有一条时，沾边的高重要度进不来 ──────────────────
const hitsR3 = (await call('memory_search', { query: '数据库连接池', k: 10 })).hits
check('R3 强相关那条在第一位', hitsR3[0]?.id === ids.db, String(hitsR3[0]?.content ?? '').slice(0, 12))
check('R3 沾边的 importance=4 条目没被重要度抬进来', !hitsR3.some((h) => h.id === ids.iron || h.id === ids.graph), `${hitsR3.length} 条`)

// ── R4 死条目 / 层过滤 / 中文长句 ─────────────────────────────────────────
await call('memory_update', { id: ids.dead, status: 'archived' })
const hitsDead = (await call('memory_search', { query: '压测 调优', k: 10 })).hits
check('R4 归档条目不召回', !hitsDead.some((h) => h.id === ids.dead), `${hitsDead.length} 条`)
const hitsFact = (await call('memory_search', { query: '部署', level: 'fact', k: 10 })).hits
check('R4 level=fact 时只有 fact 层（铁律那条 lesson 不出现）', hitsFact.every((h) => h.level === 'fact') && !hitsFact.some((h) => h.id === ids.iron), hitsFact.map((h) => h.level).join(','))
const hitsLesson = (await call('memory_search', { query: '部署', level: 'lesson', k: 10 })).hits
check('R4 level=lesson 时铁律在', hitsLesson.some((h) => h.id === ids.iron), `${hitsLesson.length} 条`)
const hitsLong = (await call('memory_search', { query: '部署之前是不是应该先备份一下', k: 10 })).hits
check('R4 中文长句（不是关键词列表）也能召回铁律', hitsLong.some((h) => h.id === ids.iron), `${hitsLong.length} 条`)

// ── R5 相关度下限（min_rel）：排得对之后，别把尾巴也端出来 ────────────────
// [macro-fusion 0.2.86] 语料刻意在 R1–R4 之后才写：前面几组量的是打分与排序，
// 多两条只沾一个词的条目会动 idf，把 R2 的 bm25 比较搅乱——测什么就只给它看什么。
const TAIL = [
  { key: 'tail1', content: '备份文件放在 D 盘，按日期命名，一个月清一次。', keywords: ['备份', '目录', '归档'] },
  { key: 'tail2', content: '日志目录涨得很快，记得定期轮转。', keywords: ['日志', '轮转'] },
]
for (const t of TAIL) {
  const r = await call('memory_remember', { content: t.content, project: '召回探针', keywords: t.keywords, importance: 1, level: 'fact' })
  ids[t.key] = r.id
}
const r5Default = await call('memory_search', { query: '部署 备份', k: 10, explain: true })
const hitsR5 = r5Default.hits
const noteR5 = String(r5Default.note ?? '')
const relOf = (h) => (hitsR5[0]?.score ? Math.round((h.score / hitsR5[0].score) * 100) / 100 : 0)
check('R5 默认按 0.35 收窄：只沾「备份」一个词的 tail1 没展开', !hitsR5.some((h) => h.id === ids.tail1), hitsR5.map((h) => `${h.id.slice(0, 6)}@${relOf(h)}`).join(' '))
check('R5 收窄要说出来：note 报了条数并给了 min_rel=0 的出口', /另有 \d+ 条/.test(noteR5) && noteR5.includes('min_rel=0'), noteR5.replace(/\n/g, ' / ').slice(0, 120))
const r5All = await call('memory_search', { query: '部署 备份', k: 10, min_rel: 0 })
const hitsAll = r5All.hits
check('R5 阴性对照：min_rel=0 同一查询把 tail1 放回来（收窄真在起效，不是本来就没有）', hitsAll.some((h) => h.id === ids.tail1), `${hitsAll.length} 条 vs 默认 ${hitsR5.length} 条`)
check('R5 min_rel=0 时条数确实变多', hitsAll.length > hitsR5.length, `${hitsAll.length} > ${hitsR5.length}`)
const r5Tight = await call('memory_search', { query: '部署 备份', k: 10, min_rel: 0.99 })
check('R5 收得再紧也至少留榜首一条（不是把结果收成空）', r5Tight.hits.length === 1 && r5Tight.hits[0]?.id === ids.iron, `${r5Tight.hits.length} 条`)
// 「部署」这一个词上，铁律与随手记的相对位置是 1.81 : 1.48（rel 0.82），两条都该留着；
// 上面那句查询带「备份」，随手记本来就没沾这个词，拿它当「误伤」的反例会把判据写错。
const hitsR5pure = (await call('memory_search', { query: '部署', k: 10, explain: true })).hits
check('R5 强相关的一组不被误伤（查询「部署」时铁律与随手记都在，收窄只砍沾一个词的尾巴）', hitsR5pure.some((h) => h.id === ids.iron) && hitsR5pure.some((h) => h.id === ids.casual), hitsR5pure.map((h) => `${h.level}@${h.score}`).join(' '))
const r5Bad = await call('memory_search', { query: '部署 备份', k: 10, min_rel: 5 })
check('R5 min_rel 给越界值：夹回 1 并说明（不当作「查不到」）', /不在 0–1 里/.test(String(r5Bad.note ?? '')) && r5Bad.hits.length >= 1, String(r5Bad.note ?? '').split('\n').filter((l) => l.includes('min_rel')).join(' ').slice(0, 90))

// ── SESS（0.2.131）：会话主题扩展 ─────────────────────────────────────────
// 一条 20 字的短条目接不住问句的三四个实词。数据侧凭据是 omni35（649 题）：同一批条目上，
// 「补本段 tf-idf 前 12 个实词」把准确率从 39.3% 抬到 46.7%（p<0.0001），而「补 12 个全局高频词」
// 只值 +10（p=0.1986）。所以规则从语料现算，不靠写入纪律。这里只量引擎行为。
const mkDoc = (id, content, sess) => ({
  id,
  level: 'fact',
  title: content.slice(0, 8),
  content,
  keywords: [],
  importance: 2,
  status: 'active',
  project: null,
  source_session: sess,
  created_at: Date.now() - 86400000,
  updated_at: Date.now() - 86400000,
})
// s1 三条同会话：a1/a3 直接命中查询，a2 一个查询词都不含（BM25 完全不可见）。
const SESS_DOCS = [
  mkDoc('a1', '她在陶艺课上捏了个碗', 's1'),
  mkDoc('a2', '她买了六个杯子回家', 's1'),
  mkDoc('a3', '老师说釉色要等三天才干', 's1'),
  mkDoc('b1', '今天天气不错适合晒被子', 's2'),
]
const SESS_Q = '釉色 陶艺'
const sessOn = V.search(SESS_Q, SESS_DOCS, { k: 8 })
const sessOff = V.search(SESS_Q, SESS_DOCS, { k: 8, sessionTopic: false })
const sessIds = (hits) => hits.map((h) => h.id)

check(
  'SESS1 会话主题词：同会话里那条「一个查询词都不含」的条目也能进榜',
  sessIds(sessOn).includes('a2') && sessOff.some((h) => h.id === 'a1') && !sessIds(sessOff).includes('a2'),
  `开 ${sessIds(sessOn).join(',')} / 关 ${sessIds(sessOff).join(',')}`,
)
check(
  'SESS2 一眼能关：sessionTopic:false 之后回到纯 BM25（a2 消失）',
  !sessIds(sessOff).includes('a2') && sessIds(sessOff).length === 2,
  `${sessOff.length} 条`,
)
check(
  'SESS3 扩词不越位：靠主题词进榜的那条排在直接命中之后',
  sessIds(sessOn)[sessIds(sessOn).length - 1] === 'a2' && sessIds(sessOn).length === 3,
  sessIds(sessOn).join(','),
)
// 会话只有两条 → 低于 SESS_TOPIC_MIN=3，不扩。
const thin = [
  mkDoc('t1', '她在陶艺课上捏了个碗', 's9'),
  mkDoc('t2', '她买了六个杯子回家', 's9'),
]
const thinOn = sessIds(V.search(SESS_Q, thin, { k: 8 }))
check('SESS4 会话不足 3 条不扩（两条的段落不拿主题词凑数）', thinOn.join(',') === 't1', thinOn.join(','))

// 完全没有 source_session（老库、手动导入的条目）→ 与关掉时逐条一致，一点不带漂移。
const noSess = SESS_DOCS.map((d) => ({ ...d, source_session: null }))
const nsOn = V.search(SESS_Q, noSess, { k: 8 }).map((h) => `${h.id}:${h.score.toFixed(4)}`)
const nsOff = V.search(SESS_Q, noSess, { k: 8, sessionTopic: false }).map((h) => `${h.id}:${h.score.toFixed(4)}`)
check('SESS5 没有 source_session 时完全惰性（分数逐条相同，不靠字段兜底）', nsOn.join(' ') === nsOff.join(' '), nsOn.join(' '))

// ── NF（0.2.146）：噪声地板 —— 出现在一半以上条目里的查询词不参与打分 ────────
// 中文没有停用词表（英文靠 normalizeEn 的 EN_STOPWORDS），「怎么 / 那个 / 一下」照样进 BM25、
// 照样进覆盖度分母。库一变大，这些词把候选集撑成「都沾点边」，回执读起来像「都相关」。
// 这里量引擎行为：剔掉噪声词之后，只沾噪声的条目必须退出榜单，而相关条目一分不损。
const NF_NOISE = []
for (let i = 0; i < 8; i++) NF_NOISE.push(mkDoc('n' + i, `怎么记录第${i}条无关的流水账，随手写写。`, 's' + i))
const NF_DOCS = [
  ...NF_NOISE,
  mkDoc('real', '星图建图的延迟要盯着，一轮巡检大约 12 秒。', 's-real'),
  mkDoc('other', '另一个完全无关的条目，讲的是食堂菜单。', 's-other'),
]
// 噪声词单独成段（空格隔开）：剔掉它之后词表与「不含噪声词的那一问」逐字相同，NF6 才量得准。
const NF_Q = '怎么 星图建图的延迟调下来'
const nfOn = V.search(NF_Q, NF_DOCS, { k: 12 })
// 同上：这条测噪声地板，回执裁剪（0.2.165）与它无关。
const nfOff = V.search(NF_Q, NF_DOCS, { k: 12, noiseFloor: false, funcFloor: false, bandKeep: false })
const nfIds = (hits) => hits.map((h) => h.id).join(',')

check(
  'NF1 噪声词剔除后，只沾「怎么」的八条不再进榜（只剩真正相关的那条）',
  nfIds(nfOn) === 'real',
  `开 ${nfIds(nfOn)} / 共 ${NF_DOCS.length} 条语料`,
)
check(
  'NF2 阴性对照：noiseFloor:false（且把 0.2.151 的虚词地板一起关掉）时八条噪声全回来（地板真在起效）',
  nfOff.length === 9 && nfIds(nfOff).startsWith('real,') && NF_NOISE.every((d) => nfIds(nfOff).includes(d.id)),
  `${nfOff.length} 条：${nfIds(nfOff).slice(0, 40)}…`,
)
check(
  'NF3 剔了谁要说出来：explain.noiseDropped 点名「怎么」（可追溯性，不是悄悄改口径）',
  JSON.stringify(V.search(NF_Q, NF_DOCS, { k: 12, explain: true })[0]?.explain?.noiseDropped ?? null) === '["怎么"]',
  JSON.stringify(V.search(NF_Q, NF_DOCS, { k: 12, explain: true })[0]?.explain?.noiseDropped ?? null),
)
const nfSmall = NF_DOCS.slice(0, 5)
check(
  'NF4 库小（<8 条）时一条都不剔：df 在小样本上不可信（5 条全含「怎么」也照旧参与）',
  V.search('怎么', nfSmall, { k: 8 }).length === 5 && V.search('怎么', nfSmall, { k: 8, explain: true })[0]?.explain?.noiseDropped === undefined,
  `${V.search('怎么', nfSmall, { k: 8 }).length} 条`,
)
check(
  'NF5 整句都是常用词时整段回退（宁可噪声也不给空结果）',
  V.search('怎么', NF_DOCS, { k: 12 }).length === 8,
  `${V.search('怎么', NF_DOCS, { k: 12 }).length} 条`,
)
const nfA = V.search(NF_Q, NF_DOCS, { k: 12 })[0]
const nfB = V.search('星图建图的延迟调下来', NF_DOCS, { k: 12 })[0]
check(
  'NF6 剔掉 = 没问：同一问句去掉「怎么」后首条分数逐位相同（分子分母同口径）',
  nfA?.id === nfB?.id && Math.abs((nfA?.score ?? 0) - (nfB?.score ?? 0)) < 1e-9,
  `${nfA?.id}@${nfA?.score} vs ${nfB?.id}@${nfB?.score}`,
)

// ── VB（0.2.147）：标识符原样匹配 —— 版本号 / 路径 / 文件名 / 短 id 不过分词 ──────
// tokenize 把 0.2.146 切成 0 / 2 / 146、把 memory.db 切成 memori / db，于是问「哪个版本」
// 变成一堆谁都能沾边的碎词，真讲它的那条反被噪声挤下去；问一段短 id 更连候选都进不去
// （id 不在 docText 里，BM25 恒为 0）。这里量的是：字面上带这个标识符的条目被认出来，
// 而且认得克制——问句里一个标识符都不带时，分数一个字节都不动。
const VB_DOCS = [
  mkDoc('v146', '0.2.146 加了噪声地板：用 df 判据剔噪声词，分子分母同口径。', 's-v1'),
  mkDoc('v145', '0.2.145 加了每轮星图邻域注入，挂在 agent/pre-step 尾部追加。', 's-v2'),
  mkDoc('vnoise', '改了措辞之后分数漂了一点，别当成回归。', 's-v3'),
  mkDoc(
    'vpath',
    '补丁改的是 D:\\dsh-home\\vendor\\dsh-macro-memory\\vendor\\meow-memory\\lib\\index.js 里的 search()。',
    's-v4',
  ),
  mkDoc('vtool', 'tools/probe-words.mjs 里 claimedGuideLengths 会把「420 个字符」误报成口径不一致。', 's-v5'),
  mkDoc('0mwq5zzv8-c6a56522bbaa', '这一条正文里没有半个标识符，只讲交付态。', 's-v6'),
];
const vbIds = (hits) => hits.map((h) => h.id).join(',');
const VB_QVER = '0.2.146 改了什么'
check(
  'VB1 版本号是一个整体：identsOf 认 0.2.146，不认它被切碎的 0 / 2 / 146',
  JSON.stringify(V.identsOf(VB_QVER)) === '["0.2.146"]',
  JSON.stringify(V.identsOf(VB_QVER)),
)
const vbVer = V.search(VB_QVER, VB_DOCS, { k: 12, explain: true })
check(
  'VB2 问版本号时，字面带该版本的那条第 1（词侧被分词打碎，靠原样匹配认回来）',
  vbVer[0]?.id === 'v146' && (vbVer[0]?.explain?.verbatim ?? []).includes('0.2.146'),
  `${vbVer[0]?.id}@${vbVer[0]?.score} verbatim=${JSON.stringify(vbVer[0]?.explain?.verbatim ?? null)}`,
)
const VB_QID = '0mwq5zzv 是什么'
const vbIdOn = V.search(VB_QID, VB_DOCS, { k: 12, explain: true })
const vbIdOff = V.search(VB_QID, VB_DOCS, { k: 12, verbatim: false })
check(
  'VB3 问一段短 id 时，id 就是那条的那位直接站到第 1（正文里没有这个 token 也能被指认）',
  vbIdOn[0]?.id === '0mwq5zzv8-c6a56522bbaa',
  vbIds(vbIdOn),
)
check(
  'VB4 那不是词命中带来的：该条 explain.bm25 为 0（纯指认，不假装读到了正文）',
  (vbIdOn[0]?.explain?.bm25 ?? -1) === 0,
  `bm25=${vbIdOn[0]?.explain?.bm25} identBonus=${vbIdOn[0]?.explain?.identBonus}`,
)
check(
  'VB5 阴性对照：verbatim:false 时同一问句连候选都进不去（原样匹配真在起效，不是本来就有分）',
  !vbIds(vbIdOff).includes('0mwq5zzv8-c6a56522bbaa') && vbIdOff.every((h) => h.explain === undefined),
  vbIds(vbIdOff) || '0 条',
)
const VB_QPATH = 'D:\\dsh-home\\vendor\\dsh-macro-memory\\vendor\\meow-memory\\lib\\index.js 改了什么'
const vbPath = V.search(VB_QPATH, VB_DOCS, { k: 12, explain: true })
check(
  'VB6 路径整串命中：问句里写全路径时，正文带这串路径的条目排第 1',
  vbPath[0]?.id === 'vpath',
  `${vbPath[0]?.id}@${vbPath[0]?.score} 共 ${vbPath.length} 条`,
)
const VB_QLOOSE = 'E:\\Temp\\lib\\index.js 改了什么'
const vbLoose = V.search(VB_QLOOSE, VB_DOCS, { k: 12, explain: true })
const vbLooseHit = vbLoose.find((h) => h.id === 'vpath')
check(
  'VB7 降级要说实话：整串没命中、只有 basename 命中时，verbatim 里标「(局部)」而不是当成整串命中',
  (vbLooseHit?.explain?.verbatim ?? []).some((t) => t.endsWith('(局部)')),
  JSON.stringify(vbLooseHit?.explain?.verbatim ?? null),
)
const vbUpper = V.search('TOOLS/PROBE-WORDS.MJS 是干嘛的', VB_DOCS, { k: 12, explain: true })
check(
  'VB8 大小写不敏感：问句写大写也认得出同一个文件（两侧都小写化再比）',
  vbUpper[0]?.id === 'vtool' && (vbUpper[0]?.explain?.verbatim ?? []).includes('tools/probe-words.mjs'),
  `${vbUpper[0]?.id} verbatim=${JSON.stringify(vbUpper[0]?.explain?.verbatim ?? null)}`,
)
check(
  'VB9 太短的算不上标识符：a/b 与 1.5 都不进原样匹配（免得「a/b」这种通用词去刷分）',
  V.identsOf('a/b 和 1.5').length === 0,
  JSON.stringify(V.identsOf('a/b 和 1.5')),
)
check(
  'VB10 一条问句最多认 6 个标识符：多写的丢掉，不让一句话把半个库拽进来',
  V.identsOf('0.2.1 0.2.2 0.2.3 0.2.4 0.2.5 0.2.6 0.2.7 0.2.8').length === 6,
  JSON.stringify(V.identsOf('0.2.1 0.2.2 0.2.3 0.2.4 0.2.5 0.2.6 0.2.7 0.2.8')),
)
const vbNest = V.identsOf('tools/probe-words.mjs')
check(
  'VB11 同一处证据不记两遍：tools/probe-words.mjs 只留最长的那个，不再单留 probe-words / tools/probe-words',
  JSON.stringify(vbNest) === '["tools/probe-words.mjs"]',
  JSON.stringify(vbNest),
)
const VB_QPLAIN = '星图建图的延迟要盯着'
const vbPlainOn = V.search(VB_QPLAIN, VB_DOCS, { k: 12, explain: true }).map((h) => `${h.id}:${h.score}`)
const vbPlainOff = V.search(VB_QPLAIN, VB_DOCS, { k: 12, explain: true, verbatim: false }).map((h) => `${h.id}:${h.score}`)
check(
  'VB12 没有标识符的问句完全惰性：开与关逐条同分同名次（不是「多多少少加点分」）',
  vbPlainOn.join(' ') === vbPlainOff.join(' '),
  vbPlainOn.join(' '),
)
check(
  'VB13 没认到标识符时 explain 里不出现 verbatim 键（回执不编造证据）',
  V.search(VB_QPLAIN, VB_DOCS, { k: 12, explain: true }).every((h) => h.explain.verbatim === undefined),
  JSON.stringify(V.search(VB_QPLAIN, VB_DOCS, { k: 12, explain: true }).map((h) => h.explain.verbatim)),
)
const vbKwOn = V.keywordHitScore(VB_QID, VB_DOCS, { k: 5 })
const vbKwOff = V.keywordHitScore(VB_QID, VB_DOCS, { k: 5, verbatim: false })
check(
  'VB14 另一支打分器同口径：keywordHitScore 也认得出那段短 id，关掉后同样一条不剩',
  vbKwOn[0]?.id === '0mwq5zzv8-c6a56522bbaa' && vbKwOff.length === 0,
  `开 ${vbIds(vbKwOn)} / 关 ${vbKwOff.length} 条`,
)

// ── VX（0.2.148）：补分的单位跟着榜走 —— 指认不许被别人的重要性稀释 ────────────
// 0.2.147 把补分加进 raw，于是它会被每条自己的 importance / 新鲜度 / 状态权重再乘一遍：
// 一条 importance=4 的措辞命中（impW 1.75）就把「问的正是这条 id」压下去（实测 17.96 对 16.16）。
// 这里量的是：补分落在加权之后，单位取榜首的实际分数；指认在同量级里压得住措辞命中。
const vxDoc = (id, content, imp, sess) => ({ ...mkDoc(id, content, sess), importance: imp })
const VX_DOCS = [
  vxDoc('0mzz9abc1-aaaa', '这一条正文里没有半个标识符，只讲交付态。', 1, 's-x1'),
  vxDoc('loud', '改了什么 措辞更像那一条，而且重要度写得很高。', 4, 's-x2'),
]
const VX_Q = '0mzz9abc1 措辞'
const vxOn = V.search(VX_Q, VX_DOCS, { k: 8, explain: true })
const vxOff = V.search(VX_Q, VX_DOCS, { k: 8, verbatim: false, funcFloor: false })
check(
  'VX1 指认压得住重要性：问一条短 id 时，那条即使 importance=1 也排第 1（措辞命中的是 4 分也没用）',
  vxOn[0]?.id === '0mzz9abc1-aaaa',
  vxOn.map((h) => `${h.id}@${h.score.toFixed(2)}`).join(' '),
)
check(
  'VX2 补分落在加权之后：该条 score 与 identBonus 逐位相同（若先补分再乘权重，会差一个新鲜度系数）',
  Math.abs((vxOn[0]?.score ?? 0) - (vxOn[0]?.explain?.identBonus ?? -1)) < 2e-3,
  `score=${vxOn[0]?.score} bonus=${vxOn[0]?.explain?.identBonus}`,
)
check(
  'VX3 阴性对照：verbatim:false（虚词地板回到 0.2.150 口径）时那条连候选都没有，措辞命中重新占榜首',
  vxOff[0]?.id === 'loud' && !vxOff.some((h) => h.id === '0mzz9abc1-aaaa'),
  vxOff.map((h) => h.id).join(',') || '0 条',
)
check(
  'VX4 单位跟着榜走：补分 = 榜首分数 × 权重（1.5 指认 / 0.6 一般），不是词分最大值',
  Math.abs((vxOn[0]?.explain?.identBonus ?? 0) - (vxOn[1]?.score ?? 0) * 1.5) < 2e-3,
  `bonus=${vxOn[0]?.explain?.identBonus} 榜首措辞分=${vxOn[1]?.score}`,
)
const vxKw = V.keywordHitScore(VX_Q, VX_DOCS, { k: 5 })
check(
  'VX5 另一支打分器同口径：keywordHitScore 也把被指认那条排在第 1',
  vxKw[0]?.id === '0mzz9abc1-aaaa',
  vxKw.map((h) => h.id).join(',') || '0 条',
)
check(
  'VX6 临时字段不外漏：回执里不该出现 _vb（补完就摘，别把内部证据塞给读的人）',
  vxOn.every((h) => h._vb === undefined),
  JSON.stringify(Object.keys(vxOn[0] ?? {})),
)

// ── VT（0.2.151）：问句里的虚词不算证据 ────────────────────────────────────
// 噪声地板只认「到处都是」的词；虚词是另一半噪声——**哪都没有、却毫无信息**的两字碎片。
// 实测问「高铁票怎么改签」，`怎么` 在本库 df=1、idf 高得离谱，一条只沾「怎么」的条目就能上桌。
// 这里量四件事：虚词单独就能挡掉噪声、谁被剔要说出来、能一键关、以及「剔完只剩一个词」不许空手。
const VT_NOISE = []
for (let i = 0; i < 6; i++) VT_NOISE.push(mkDoc('t' + i, `怎么记录第${i}条流水账，随手写写。`, 's-t' + i))
const VT_DOCS = [
  ...VT_NOISE,
  mkDoc('vt-real', '星图建图的延迟要盯着，一轮巡检大约 12 秒。', 's-vt-real'),
  mkDoc('vt-why', '为什么这条会这么写，什么原因，也没说清。', 's-vt-why'),
  mkDoc('vt-id', '路径 D:\\dsh-home\\vendor\\meow-memory 下的索引文件。', 's-vt-id'),
  mkDoc('vt-en', 'latency 的观测点放在巡检里，不看 p99。', 's-vt-en'),
]
const VT_Q = '怎么 把延迟调下来'
const vtFuncOn = V.search(VT_Q, VT_DOCS, { k: 8, noiseFloor: false, explain: true })
// 这条测的是虚词地板：回执裁剪（0.2.165 的 trimByBand）与它无关，所以要显式关掉。
const vtFuncOff = V.search(VT_Q, VT_DOCS, { k: 8, noiseFloor: false, funcFloor: false, bandKeep: false })
const vtIds = (hits) => hits.map((h) => h.id).join(',')
check(
  'VT1 虚词单独就能挡噪声：关掉噪声地板，只留虚词地板，六条只沾「怎么」的流水账进不了榜',
  vtIds(vtFuncOn) === 'vt-real',
  `${vtIds(vtFuncOn)} / 共 ${VT_DOCS.length} 条语料`,
)
check(
  'VT2 剔了谁要说出来：explain.funcDropped 点名「怎么」（可追溯性，不是悄悄改口径）',
  JSON.stringify(vtFuncOn[0]?.explain?.funcDropped ?? null) === '["怎么"]',
  JSON.stringify(vtFuncOn[0]?.explain?.funcDropped ?? null),
)
check(
  'VT3 阴性对照：funcFloor:false 同一问句把六条噪声全放回来（虚词地板真在起效，不是本来就没命中）',
  vtFuncOff.length === 7 && VT_NOISE.every((d) => vtIds(vtFuncOff).includes(d.id)),
  `${vtFuncOff.length} 条：${vtIds(vtFuncOff).slice(0, 40)}…`,
)
check(
  'VT4 整句都是虚词时整段回退：问「为什么」照样能给回执，不因为剔词剔空而空手',
  V.search('为什么', VT_DOCS, { k: 3, explain: true }).length > 0 &&
    V.search('为什么', VT_DOCS, { k: 3, explain: true })[0]?.explain?.funcDropped === undefined,
  `${V.search('为什么', VT_DOCS, { k: 3 }).map((h) => h.id).join(',') || '0 条'}`,
)
check(
  'VT5 另一支打分器同口径：keywordHitScore 也只认内容词，六条流水账不进榜',
  (() => {
    const kw = V.keywordHitScore(VT_Q, VT_DOCS, { k: 8 })
    return kw.length === 1 && kw[0].id === 'vt-real'
  })(),
  V.keywordHitScore(VT_Q, VT_DOCS, { k: 8 }).map((h) => h.id).join(',') || '0 条',
)
check(
  'VT6 标识符与英文内容词不受影响：路径原样问得着，latency 照样能命中',
  V.search('D:\\dsh-home\\vendor\\meow-memory', VT_DOCS, { k: 5 }).some((h) => h.id === 'vt-id') &&
    V.search('latency 观测点', VT_DOCS, { k: 5 }).some((h) => h.id === 'vt-en'),
  V.search('latency 观测点', VT_DOCS, { k: 5 }).map((h) => h.id).join(',') || '0 条',
)
check(
  'VT7 剔完只剩一个内容词照样打分：只有一个真词命中时不许空手（那是「沾了一点」，不是噪声）',
  V.search('publishTimestamp 该写什么值', [mkDoc('vt-p', 'publishTimestamp 该写这个字段，别写时间。', 's-vt-p')], { k: 3 }).length === 1,
  `${V.search('publishTimestamp 该写什么值', [mkDoc('vt-p', 'publishTimestamp 该写这个字段，别写时间。', 's-vt-p')], { k: 3 }).length} 条`,
)

// 收尾：临时库在 Windows 上可能还被 sqlite 句柄占着（EPERM），清不掉不算失败——
// 反正落在临时目录里，系统自己会回收；这里只保证不开着的句柄变成假红。
for (const dir of [home, stubDir]) {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    console.log(`（临时目录没清掉，交给系统回收：${dir}）`)
  }
}
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
if (failures !== 0) process.exitCode = 1
