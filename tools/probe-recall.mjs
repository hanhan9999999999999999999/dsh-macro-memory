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
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
check('R5 默认按 0.30 收窄：只沾「备份」一个词的 tail1 没展开', !hitsR5.some((h) => h.id === ids.tail1), hitsR5.map((h) => `${h.id.slice(0, 6)}@${relOf(h)}`).join(' '))
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
// 这里测的是噪声地板那把刀。0.2.170 的疑问剥离会在分词前就把「怎么」拿走，与地板无关却会
// 把地板的读数搅浑（noiseDropped 变 null、阴性对照放不回噪声）：两台刀分开测，新刀归 R8。
const NF_OPT = { questionStrip: false }
const nfOn = V.search(NF_Q, NF_DOCS, { k: 12, ...NF_OPT })
// 同上：这条测噪声地板，回执裁剪（0.2.165）与它无关。
const nfOff = V.search(NF_Q, NF_DOCS, { k: 12, noiseFloor: false, funcFloor: false, bandKeep: false, ...NF_OPT })
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
  JSON.stringify(V.search(NF_Q, NF_DOCS, { k: 12, explain: true, ...NF_OPT })[0]?.explain?.noiseDropped ?? null) === '["怎么"]',
  JSON.stringify(V.search(NF_Q, NF_DOCS, { k: 12, explain: true, ...NF_OPT })[0]?.explain?.noiseDropped ?? null),
)
const nfSmall = NF_DOCS.slice(0, 5)
check(
  'NF4 库小（<8 条）时一条都不剔：df 在小样本上不可信（5 条全含「怎么」也照旧参与）',
  V.search('怎么', nfSmall, { k: 8, ...NF_OPT }).length === 5 && V.search('怎么', nfSmall, { k: 8, explain: true, ...NF_OPT })[0]?.explain?.noiseDropped === undefined,
  `${V.search('怎么', nfSmall, { k: 8, ...NF_OPT }).length} 条`,
)
check(
  'NF5 整句都是常用词时整段回退（宁可噪声也不给空结果）',
  V.search('怎么', NF_DOCS, { k: 12, ...NF_OPT }).length === 8,
  `${V.search('怎么', NF_DOCS, { k: 12, ...NF_OPT }).length} 条`,
)
const nfA = V.search(NF_Q, NF_DOCS, { k: 12, ...NF_OPT })[0]
const nfB = V.search('星图建图的延迟调下来', NF_DOCS, { k: 12, ...NF_OPT })[0]
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
const vxOff = V.search(VX_Q, VX_DOCS, { k: 8, verbatim: false, funcFloor: false, questionStrip: false })
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
const VT_OPT = { questionStrip: false }
const vtFuncOn = V.search(VT_Q, VT_DOCS, { k: 8, noiseFloor: false, explain: true, ...VT_OPT })
// 这条测的是虚词地板：回执裁剪（0.2.165 的 trimByBand）与它无关，所以要显式关掉。
const vtFuncOff = V.search(VT_Q, VT_DOCS, { k: 8, noiseFloor: false, funcFloor: false, bandKeep: false, ...VT_OPT })
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

// ── R6（0.2.168）默认层要含 user：主人的偏好就在这一层，问「我习惯怎样」必须想起来 ──────────
// 背景：真库 545 条里 user 层只有 8 条，而这 8 条在工具路径上 8 题全漏（API 层每题都是第 1 名——
// 说明不是排序问题，是根本没进候选池）。soul 与 project 仍不默认：前者是 AI 自身人格，
// 后者放整个项目的概览，实测掺进来会抢首位。
const R6 = [
  { key: 'r6u', level: 'user', content: '盘口偏好：收尾先给读数再说话，每版都要能复核的数字。', keywords: ['盘口偏好', '读数', '收尾'] },
  { key: 'r6s', level: 'soul', content: '盘口偏好的语气：句首用海洋意象起头，别生硬。', keywords: ['盘口偏好', '语气', '鲸鱼娘'] },
  { key: 'r6j', level: 'project', content: '盘口偏好项目：这一轮只做检索，别的先不碰。', keywords: ['盘口偏好', '项目', '检索'] },
  { key: 'r6f', level: 'fact', content: '盘口偏好的记账口径：按条数算，不按字数。', keywords: ['盘口偏好', '记账', '条数'] },
]
for (const d of R6) {
  const r = await call('memory_remember', { content: d.content, project: '召回探针', keywords: d.keywords, importance: 1, level: d.level })
  ids[d.key] = r.id
}
// 每条断言用独立 session id：seen 会把「本会话已给过」的条目从第 6 条之后剔掉，混着量会串味。
const callR6 = (args, tag) => T.get('memory_search').execute(args, { agent: { session: { header: { cwd: workspace, id: `sess-r6-${tag}` } } } })
const R6Q = '盘口偏好'
const r6Default = await callR6({ query: R6Q, k: 10 }, 'def')
const r6Ids = (r) => (r.hits || []).map((h) => String(h.id))
const r6Has = (r, k) => r6Ids(r).some((id) => id.startsWith(ids[k]))
check(
  'R6 默认检索范围含 user：主人的偏好条目默认就该被召回（0.2.168 之前它是隐形的一层）',
  r6Has(r6Default, 'r6u'),
  `${r6Ids(r6Default).length} 条`,
)
check(
  'R6 阴性对照：显式只查 fact/lesson/topic/rules 时那条 user 条目一条都不剩（默认含它是真在起效）',
  !r6Has(await callR6({ query: R6Q, k: 10, level: 'fact,lesson,topic,rules' }, 'nouser'), 'r6u'),
  `关掉后 ${r6Ids(await callR6({ query: R6Q, k: 10, level: 'fact,lesson,topic,rules' }, 'nouser')).length} 条`,
)
check(
  'R6 边界没破：soul 与 project 仍不进默认（它们是「要查请显式说」的两层）',
  !r6Has(r6Default, 'r6s') && !r6Has(r6Default, 'r6j'),
  `默认命中：${r6Ids(r6Default).map((id) => id.slice(0, 6)).join(',')}`,
)
check(
  'R6 只是不默认，不是查不到：显式传 level:soul 时那条语气条目照样回来',
  r6Has(await callR6({ query: R6Q, k: 10, level: 'soul' }, 'soul'), 'r6s'),
  `${r6Ids(await callR6({ query: R6Q, k: 10, level: 'soul' }, 'soul2')).length} 条`,
)
const r6Explicit = await callR6({ query: R6Q, k: 10, level: 'fact,lesson,topic,rules,user', min_rel: 0.3 }, 'explicit')
check(
  'R6 默认值就是这两个数：不传参数与显式 {level:…user, min_rel:0.3} 逐位相同（默认值改没改一眼看得出）',
  JSON.stringify(r6Ids(r6Default)) === JSON.stringify(r6Ids(r6Explicit)),
  `${r6Ids(r6Default).length} vs ${r6Ids(r6Explicit).length}`,
)

// ── R7 语义补位的两条闸（0.2.169）：补几条有上限，折掉的也要报 ─────────────
// 这条路只在稠密模型在的时候走（`denseRescueWanted`），所以自检机上它是关的：
// 行为测不了，就测契约——常量、限量、折数累加、报名口径，一样是判据。
// [macro-fusion 0.2.169] 0.2.154 的闸和 0.2.166 的兜底在本机从来没真跑过一次：
// 模块加载那行把「包名里有斜杠」当成「路径」，`@huggingface/transformers` 被拼成
// `file:///@huggingface/transformers`，抛错、被 catch 成 off，一声不响地降级了半年。
// 所以这里还要钉住那行判据本身：只有「真的像路径」才按路径 import。
const SRC = readFileSync(join(root, 'vendor', 'meow-memory', 'lib', 'index.js'), 'utf8')
const countOf = (needle) => SRC.split(needle).length - 1
check(
  'R7 补位有上限：DENSE_RESCUE_MAX 存在且只此一处（不封顶时回执从 4.54 条涨到 8.23 条，一条正解换四条陪跑）',
  SRC.includes('var DENSE_RESCUE_MAX = 2;') && countOf('DENSE_RESCUE_MAX') === 2,
  `出现 ${countOf('DENSE_RESCUE_MAX')} 次（定义 1 + 引用 1）`,
)
check(
  'R7 上限真在循环里生效：数到上限就 break，真正 push 时才 +1（不是数候选，是数补进来的）',
  SRC.includes('if (added >= maxRescue) break;') && SRC.includes('added += 1;') && SRC.includes('const maxRescue = Number.isFinite(opts.rescueMax)'),
  'break / added+=1 / rescueMax 三处都在',
)
check(
  'R7 折数要累加：上游折掉的不能被这一层的 slice 抹平（0.2.167 只报当次这刀，救援路径折了也不说）',
  SRC.includes('const upstreamTrim = Number(hits.trimmed) || 0;') &&
    SRC.includes('const dropped = sliced.length - out.length + upstreamTrim;'),
  'upstreamTrim 与 dropped 累加都在',
)
check(
  'R7 折数按来路分开记：词法尾部折的另记 rescueTrimmed（混进 band 那笔账会报出「折了 11 条」其实只折 1 条）',
  countOf('"rescueTrimmed"') === 2 && countOf('"rescueAdded"') === 2,
  `rescueTrimmed ${countOf('"rescueTrimmed"')} 处 / rescueAdded ${countOf('"rescueAdded"')} 处`,
)
check(
  'R7 补位要自己报名：note 里有 rescue 这一句，并且真进了 note 数组（补来的条目分数低，不说明会被当噪声删掉）',
  countOf('"search.rescue"') === 1 && SRC.includes('relNote, rescueNote, bandNote'),
  `search.rescue ${countOf('"search.rescue"')} 处`,
)
check(
  'R7 稠密模块加载判据：包名不当路径（这条一错，闸门与兜底会静默降级成 off，谁都看不出来）',
  SRC.includes("spec.startsWith('file:') || spec.startsWith('.') || spec.startsWith('/') || /^[A-Za-z]:[\\\\/]/.test(spec)") &&
    !SRC.includes("const asPath = /[\\\\/]/.test(spec)"),
  'asPath 判据在位，旧的「含斜杠就当路径」已不在',
)
// 幂等：救援这条路只按分数补位，不带随机——同一问句两次调用，id 顺序必须逐位相同。
const callR7 = (tag) => T.get('memory_search').execute({ query: '盘口偏好', k: 10 }, { agent: { session: { header: { cwd: workspace, id: `sess-r7-${tag}` } } } })
const r7a = (await callR7('a')).hits.map((h) => h.id)
const r7b = (await callR7('b')).hits.map((h) => h.id)
check(
  'R7 同一问句两次调用逐位相同：补位与折数都不带随机（换 session 也一样）',
  JSON.stringify(r7a) === JSON.stringify(r7b) && r7a.length > 0,
  `${r7a.length} vs ${r7b.length}`,
)

// ── R8 疑问框架剥离（0.2.170）：疑问词不算证据，跨界碎片尤其不算 ─────────────
// 中文按 bigram 切，「什么时候」会变成 `什么 / 么时 / 时候`。虚词表挡掉了「什么」「时候」，
// 「么时」这种没有意义的碎片却漏了网：真库 554 条上，换说池 13 题里 #3、#7 的榜首都是同一条
// 靠「么时」拿了 9.24 / 9.41 分的条目，而正解只有 5.84 / 3.61。整段剥掉之后首位 4/13 → 5/13。
// 这里既要钉住函数口径（剥什么、什么时候不剥、不碰标识符），也要造一个能红的受控库：
// 污染源只靠「么时」进榜——关掉这刀它在，开着它一个词都不剩。
const strip1 = V.stripQuestionFrame('它自己什么时候该回头反省一次')
check(
  'R8 疑问框架会剥：整段剥成空格，剥了什么要报得出来',
  !strip1.text.includes('什么时候') && strip1.stripped.includes('什么时候'),
  JSON.stringify(strip1),
)
const strip2 = V.stripQuestionFrame('什么时候')
check(
  'R8 剥完不足 4 个字符就整句回退：宁可带噪声，不许凭空空手',
  strip2.text === '什么时候' && strip2.stripped.length === 0,
  JSON.stringify(strip2),
)
const strip3 = V.stripQuestionFrame('0mwq84ts 什么时候更新的')
check(
  'R8 剥疑问不动标识符：id / 路径这类原样证据一个字都不能少（0.2.147 的地基）',
  strip3.text.includes('0mwq84ts') && strip3.stripped.length === 1,
  JSON.stringify(strip3),
)
check(
  'R8 空格切断跨界碎片：剥掉「什么时候」之后不再产出「么时 / 候该」这类假词',
  !V.tokenize(strip1.text).some((t) => t === '么时' || t === '候该'),
  JSON.stringify(V.tokenize(strip1.text)),
)
check(
  'R8 只在问句这一侧剥（索引不动）：剥离函数在被调用的地方只有一处，且带 questionStrip:false 的出口',
  countOf('stripQuestionFrame(') === 2 &&
    SRC.includes('const qStrip = opts.questionStrip === false ? { text: query, stripped: [] } : stripQuestionFrame(query);'),
  `stripQuestionFrame 出现 ${countOf('stripQuestionFrame(')} 处（定义 1 + 调用 1）`,
)
// 受控库：干净 workspace，四条语料，污染源只共享「么时」一个碎片。
const ws8 = join(home, 'ws8')
mkdirSync(ws8, { recursive: true })
const c8 = (name, args, tag) =>
  T.get(name).execute(args, { agent: { session: { header: { cwd: ws8, id: `sess-r8-${tag}` } } } })
const R8_SEED = [
  { content: '「什么时候」这类闸门词要单独成表，不能靠词边界。', keywords: ['闸门词', '词边界'], importance: 3, level: 'lesson', project: 'r8-闸门' },
  { content: '连着跑二十轮以上、同一个结论反复被推翻时，就该回头把这一段重写一遍。', keywords: ['重写', '推翻', '触发'], importance: 3, level: 'lesson', project: 'r8-闸门' },
  { content: '数据库迁移要挑低峰期做，先备份再动，回滚脚本要提前写好。', keywords: ['数据库', '迁移', '备份'], importance: 2, level: 'lesson', project: 'r8-闸门' },
  { content: '发版前把基线更新两轮，第二轮才作数。', keywords: ['基线', '发版'], importance: 2, level: 'lesson', project: 'r8-闸门' },
]
const r8ids = []
for (const s of R8_SEED) r8ids.push(String((await c8('memory_remember', s, 'w')).id).slice(0, 9))
const db8 = V.getDb(ws8, '.dsh-meow')
const docs8 = ['soul', 'user', 'rules', 'fact', 'lesson', 'topic', 'project'].flatMap((lv) => {
  try {
    return db8.listSearchable(lv)
  } catch {
    return []
  }
})
const q8 = '它自己什么时候该回头反省一次'
const off8 = await V.search(q8, docs8, { k: 10, questionStrip: false, min_rel: 0, bandKeep: false })
const on8 = await V.search(q8, docs8, { k: 10, min_rel: 0, bandKeep: false })
check(
  'R8 这刀真的会红：污染源只靠「么时」进榜，关掉它在、剥掉它一个词都不剩',
  off8.some((h) => String(h.id).startsWith(r8ids[0])) && !on8.some((h) => String(h.id).startsWith(r8ids[0])),
  `关掉 ${off8.length} 条（含污染源 ${off8.some((h) => String(h.id).startsWith(r8ids[0]))}）/ 默认 ${on8.length} 条（含污染源 ${on8.some((h) => String(h.id).startsWith(r8ids[0]))}）`,
)
const ex8 = await V.search(q8, docs8, { k: 5, explain: true })
check(
  'R8 explain 里看得见「改过你的问法」：默认回执不花字节，explain 模式必须给',
  Array.isArray(ex8[0]?.explain?.stripped) && ex8[0].explain.stripped.includes('什么时候'),
  JSON.stringify(ex8[0]?.explain?.stripped ?? null),
)
const offEx8 = await V.search(q8, docs8, { k: 5, explain: true, questionStrip: false })
check(
  'R8 关掉时 explain 也不许谎报：没剥就没有 stripped 这一项',
  offEx8[0]?.explain?.stripped === undefined,
  JSON.stringify(offEx8[0]?.explain?.stripped ?? null),
)



// ── R9 历史可查（0.2.171）：点了名就说清「它过期了」，别装作没有 ─────────────
// 真库里问「0.2.148 改了什么」前 10 名一条正解都没有——不是排序差，是那条交付 fact 已被
// 后续版本取代（status=stale），而 listSearchable 只回 active。于是读者得到的是五条顺带
// 提过这个版本号的条目，一句提示都没有。这里钉的是：问句点了名（版本号 / 路径 / 短 id），
// 而这名字只活在过期条目里时，翻出来、标明过期、并且给得出一个关掉它的开关。
const ws9 = join(home, 'ws9')
mkdirSync(ws9, { recursive: true })
const c9 = (name, args, tag) =>
  T.get(name).execute(args, { agent: { session: { header: { cwd: ws9, id: `sess-r9-${tag}` } } } })
const R9_SEED = [
  { content: '0.2.148 交付态：这一版把标识符补分挪到加权之后，并修了分档。', keywords: ['0.2.148', '交付态'], importance: 3, level: 'fact', project: 'r9-历史' },
  { content: '改 vendor 副本必须在包目录留三样东西，否则下次取包会静默丢补丁。', keywords: ['vendor', '副本'], importance: 3, level: 'lesson', project: 'r9-历史' },
  { content: '0.2.148 顺手记一句：日志要留着，出事时它比记忆可靠。', keywords: ['日志'], importance: 2, level: 'lesson', project: 'r9-历史' },
  { content: '数据库迁移要挑低峰期做，先备份再动。', keywords: ['数据库', '迁移'], importance: 2, level: 'lesson', project: 'r9-历史' },
]
const r9ids = []
for (const s of R9_SEED) r9ids.push(String((await c9('memory_remember', s, 'w')).id).slice(0, 9))
await c9('memory_update', { id: r9ids[0], status: 'stale' }, 'up-a')
await c9('memory_update', { id: r9ids[3], status: 'stale' }, 'up-b')
const q9 = '0.2.148 改了哪些东西'
const has9 = (out, id) => (out?.hits ?? []).some((h) => String(h.id).startsWith(id))
const on9 = await c9('memory_search', { query: q9, k: 10 }, 'on')
check(
  'R9 点了名的历史翻得出来：问句带版本号、正解只在过期条目里时，它照样进回执',
  has9(on9, r9ids[0]),
  `hits=${(on9?.hits ?? []).length} 含过期正解=${has9(on9, r9ids[0])}`,
)
check(
  'R9 翻出来要说「过期」：note 里点明它已被后续版本取代，别当成现在的结论',
  /已过期/.test(String(on9?.note ?? '')) && /0\.2\.148/.test(String(on9?.note ?? '')),
  String(on9?.note ?? '').slice(Math.max(0, String(on9?.note ?? '').indexOf('0.2.148') - 40), String(on9?.note ?? '').indexOf('0.2.148') + 90),
)
const off9 = await c9('memory_search', { query: q9, k: 10, include_stale: false }, 'off')
check(
  'R9 关得掉：include_stale:false 时一条过期条目都不带（阴性对照）',
  !has9(off9, r9ids[0]),
  `含过期正解=${has9(off9, r9ids[0])}`,
)
const noId9 = await c9('memory_search', { query: '最后改了哪些东西', k: 10 }, 'noid')
check(
  'R9 只对「点了名」的问句放宽：问句里没有标识符时，过期条目一条不补',
  !has9(noId9, r9ids[0]),
  `含过期正解=${has9(noId9, r9ids[0])}`,
)
check(
  'R9 补也只补点了名的：同库里没提这个版本号的过期条目一条都不许跟上来',
  !has9(on9, r9ids[3]),
  `无关过期条目在榜=${has9(on9, r9ids[3])}`,
)
check(
  'R9 只是检索这一侧放宽：listSearchable 的口径一个字没动（过了期的不默认进候选）',
  SRC.includes('listSearchable(level)') &&
    /listSearchable\(level\) \{[^}]*status: "active"/.test(SRC) &&
    SRC.includes('const askIdents = statusDead || statusList.length > 0 || parsed.include_stale === false ? [] : identsOf(query);'),
  `listSearchable 定义在=${SRC.includes('listSearchable(level)')} 出口在=${SRC.includes('parsed.include_stale === false')}`,
)

// ── R10 主语位指认（0.2.172）：问句点名的东西就是它的主语，别让它排在「顺带提过」后面 ──
// 真库里问「0.2.148 改了什么」，正解（正文以版本号开头）排在一条教训后面——那条教训只在句中
// 提了这个版本号，可它更短、词更密，词分高出十三分；而分档那条规矩（0.2.150）说「跨档不许越级」，
// 词分怎么加都翻不过去。这里钉的是：正文以问句点名的标识符**开头**的条目直接免档进第一档，
// 只在句中提到的不算，没点名的问句一点不动，开关给得出。
const R10_DOCS = [
  { id: '0r10a0001', level: 'fact', title: '', content: '0.2.148 交付态：这一版把标识符补分挪到加权之后，并修了分档。', keywords: ["0.2.148", "交付态"], importance: 3, project: 'r10-主语', status: 'active', created_at: 1795310000000, updated_at: 1795310000000, last_accessed_at: 1795310000000 },
  { id: '0r10a0002', level: 'lesson', title: '', content: '标识符补分 0.2.148 就加进 score 了，分档读的却是纯词分，所以只改补分权重翻不过档。0.2.148 改了补分，改了权重，改了分档口径；0.2.148 这一版改了补分之后分数还是上不去，改了分档才越得过去，改了补分权重也没用。', keywords: ['分档', '补分', '0.2.148'], importance: 3, project: 'r10-主语', status: 'active', created_at: 1795310000000, updated_at: 1795310000000, last_accessed_at: 1795310000000 },
  { id: '0r10a0003', level: 'lesson', title: '', content: '数据库迁移要挑低峰期做，先备份再动。数据库迁移要挑低峰期做，先备份再动。', keywords: ["数据库", "迁移"], importance: 3, project: 'r10-主语', status: 'active', created_at: 1795310000000, updated_at: 1795310000000, last_accessed_at: 1795310000000 },
]
const Q10 = '0.2.148 改了哪些东西'
const pos10 = (hits, id) => hits.findIndex((h) => String(h.id).startsWith(id))
const r10on = V.search(Q10, R10_DOCS, { k: 10, explain: true })
const r10off = V.search(Q10, R10_DOCS, { k: 10, explain: true, identSubjBand: false })
check(
  'R10 主语位免档：正文以问句点名的标识符开头的条目，排在只在句中提过它的短条目前面',
  pos10(r10on, '0r10a0001') === 0 && pos10(r10on, '0r10a0002') > 0,
  `主语位第 ${pos10(r10on, '0r10a0001') + 1} 名，句中提名第 ${pos10(r10on, '0r10a0002') + 1} 名`,
)
check(
  'R10 关得掉：identSubjBand:false 时主语位那条退回第二（阴性对照，说明是这把刀在起作用）',
  pos10(r10off, '0r10a0001') > 0,
  `关掉后主语位第 ${pos10(r10off, '0r10a0001') + 1} 名`,
)
const r10noId = V.search('最后改了哪些东西', R10_DOCS, { k: 10 })
const r10noIdOff = V.search('最后改了哪些东西', R10_DOCS, { k: 10, identSubjBand: false })
check(
  'R10 只对「点了名」的问句放宽：问句里没有标识符时，开关前后名次逐位相同',
  r10noId.map((h) => h.id).join(',') === r10noIdOff.map((h) => h.id).join(','),
  `开关前后同序=${r10noId.map((h) => String(h.id).slice(0, 9)).join(',')}`,
)
check(
  'R10 只在正文开头算主语：句中提到的版本号不许靠这一刀上位（开了不比关着更靠前）',
  pos10(r10on, '0r10a0002') >= pos10(r10off, '0r10a0002'),
  `句中提名那条 开=${pos10(r10on, '0r10a0002') + 1} 关=${pos10(r10off, '0r10a0002') + 1}（开时不得更靠前）`,
)
check(
  'R10 免档不是免排序：同在第一档里仍按词分排，且这条规矩只写在 bandize 一处',
  SRC.includes('if (h._ident === true || h._subj === 1) {') &&
    (SRC.match(/_subj === 1/g) || []).length === 1 &&
    SRC.includes('var IDENT_SUBJ_W = 0;'),
  `免档判据在=${SRC.includes('h._ident === true || h._subj === 1')} 主语权重默认 0=${SRC.includes('var IDENT_SUBJ_W = 0;')}`,
)
check(
  'R10 explain 里看得见这一刀：subjBonus 只在给了权重时出现，默认 0 时不留空字段',
  SRC.includes('if (h.explain !== void 0) h.explain.subjBonus = Math.round(addS * 1e3) / 1e3;') &&
    SRC.includes('if (srHit > 0 && identSubjW > 0 && opts.identSubj !== false) {') &&
    r10on.every((h) => h.explain === void 0 || h.explain.subjBonus === void 0),
  `subjBonus 出口在=${SRC.includes('h.explain.subjBonus')} 默认不留空=${r10on.every((h) => h.explain === void 0 || h.explain.subjBonus === void 0)}`,
)

// ── R11 层级意图（0.2.173）：问句问的是「准则/做法/事实/来龙去脉」，就把对应那一层往前放 ──
// 真库里 #21「反思应该由什么触发」正解在 rules 层 19.18 分，压它的是 lesson 层 19.86 分——
// 差八毛钱也翻不过去，因为分档看的是纯词分。这类错配不是「词没匹配上」，是「问的是规矩、
// 答的是经验」。这里钉的是：问句带明确意图词时，对应层级的条目在 _raw 上抬一档；但只抬
// 「本来就近」的（_raw 不低于最高分的 LEVEL_INTENT_RATIO），分差太远的不许凭空造相关性。
const R11_DOCS = [
  { id: '0r11a0001', level: 'rules', title: '', content: '要不要重启 DSH、要不要清缓存这类事该由用户拍板：改动做完把选择权交回去，不自己顺手重启。', keywords: ['重启', '拍板', '准则'], importance: 3, project: 'r11-层级', status: 'active', created_at: 1795310000000, updated_at: 1795310000000, last_accessed_at: 1795310000000 },
  { id: '0r11a0002', level: 'lesson', title: '', content: '重启这件事以前是自己顺手做的，后来发现会打断别人的会话，就改成先问一句、等用户自己重启。重启要等，重启别自己来。', keywords: ['重启', '打断', '教训'], importance: 2, project: 'r11-层级', status: 'active', created_at: 1795310000000, updated_at: 1795310000000, last_accessed_at: 1795310000000 },
  { id: '0r11a0003', level: 'fact', title: '', content: '运行中的 DSH 进程仍在用旧引擎，重启之后才会加载新版本。', keywords: ['重启', '引擎'], importance: 2, project: 'r11-层级', status: 'active', created_at: 1795310000000, updated_at: 1795310000000, last_accessed_at: 1795310000000 },
  { id: '0r11a0004', level: 'rules', title: '', content: '数据库迁移要挑低峰期做，先备份再动手，别在白天业务高峰碰它。', keywords: ['数据库', '迁移', '备份'], importance: 1, project: 'r11-层级', status: 'active', created_at: 1795310000000, updated_at: 1795310000000, last_accessed_at: 1795310000000 },
]
const Q11 = '重启这件事该由谁来定'
const pos11 = (hits, id) => hits.findIndex((h) => String(h.id).startsWith(id))
const r11on = V.search(Q11, R11_DOCS, { k: 10, explain: true })
const r11off = V.search(Q11, R11_DOCS, { k: 10, explain: true, levelIntent: false })
check(
  'R11 问「该由谁来定」时规则那一层进第一档（问的是准则，答的就得是准则）',
  pos11(r11on, '0r11a0001') === 0,
  `规则那条第 ${pos11(r11on, '0r11a0001') + 1} 名，做法那条第 ${pos11(r11on, '0r11a0002') + 1} 名`,
)
check(
  'R11 关得掉：levelIntent:false 时规则那条不再第一（阴性对照，说明是这把刀在起作用）',
  pos11(r11off, '0r11a0001') > 0,
  `关掉后规则第 ${pos11(r11off, '0r11a0001') + 1} 名`,
)
check(
  'R11 比率门：分差太远的那条不会被层级意图抬上来（只帮「本来就近」的，不凭空造相关性）',
  (pos11(r11on, '0r11a0004') === -1 || pos11(r11on, '0r11a0004') > 1) && pos11(r11on, '0r11a0004') === pos11(r11off, '0r11a0004'),
  `不相关规则条 开=${pos11(r11on, '0r11a0004') + 1} 关=${pos11(r11off, '0r11a0004') + 1}`,
)
const r11plainOn = V.search('星图建图的延迟', R11_DOCS, { k: 10 })
const r11plainOff = V.search('星图建图的延迟', R11_DOCS, { k: 10, levelIntent: false })
check(
  'R11 问句里没有意图词时，开关前后逐位同序（不认识的问句就当没这把刀）',
  r11plainOn.map((h) => h.id).join(',') === r11plainOff.map((h) => h.id).join(','),
  `同序=${r11plainOn.map((h) => String(h.id).slice(0, 9)).join(',')}`,
)
const lvCalls = (SRC.match(/intentLevelsOf\(/g) || []).length
check(
  'R11 只在问句这一侧判意图：库里的条目层是老实话，只有问句需要猜',
  lvCalls === 2 && SRC.includes('const lvIntent = intentLevelsOf(query);'),
  `intentLevelsOf( 出现 ${lvCalls} 次（定义 1 + 调用 1）`,
)
const r11hit = r11on.find((h) => String(h.id).startsWith('0r11a0001'))
const r11others = r11on.filter((h) => !String(h.id).startsWith('0r11a0001'))
check(
  'R11 抬过谁要说出来：explain.levelIntent 只在真抬了的时候出现',
  r11hit?.explain?.levelIntent === true &&
    r11others.every((h) => h.explain === void 0 || h.explain.levelIntent === void 0),
  `规则那条 levelIntent=${r11hit?.explain?.levelIntent} 别条留空=${r11others.every((h) => h.explain === void 0 || h.explain.levelIntent === void 0)}`,
)


// ── R12（0.2.174）求值型问句：要的是那条断言，不是那段背景 ────────────────────
// 「publishTimestamp 该写什么值」的正解是「必须是过去的秒级时间戳」；压在上面的那条讲
// 「有两套时间戳、别只改一处」——词分都够，差的是「答的是不是问的那个」。断言词是结论
// 的形状（必须/一律/只认/至少/只有），铺垫里没有；且只看开头六十个字，写在第五段的
// 断言不是这条的结论。
const R12_DOCS = [
  {
    id: '0r12a0001',
    level: 'fact',
    content: 'publishTimestamp 必须是过去的秒级时间戳，写成毫秒会被市场拒收。',
    title: '',
    keywords: ['publishTimestamp', '时间戳'],
    importance: 2,
    status: 'active',
    updated_at: 1763e9,
    last_accessed_at: 1763e9,
  },
  {
    id: '0r12a0002',
    level: 'fact',
    content: 'publishTimestamp 有两套：市场索引里的那套和条目里的那套，改的时候别只改一处，两处 publishTimestamp 口径要对齐。',
    title: '',
    keywords: ['publishTimestamp', '市场索引'],
    importance: 2,
    status: 'active',
    updated_at: 1763e9,
    last_accessed_at: 1763e9,
  },
  {
    id: '0r12a0003',
    level: 'fact',
    content: '市场索引的版本号跟着 feat 提交走，不是跟着 chore。',
    title: '',
    keywords: ['市场索引', '版本号'],
    importance: 2,
    status: 'active',
    updated_at: 1763e9,
    last_accessed_at: 1763e9,
  },
  {
    id: '0r12a0004',
    level: 'fact',
    content:
      '这次发版先改引擎再改镜像，镜像要跑 robocopy 全覆盖，语料和基线需要重新生一遍，顺序反了就得重跑；publishTimestamp 必须是过去的秒级时间戳。',
    title: '',
    keywords: ['发版', 'publishTimestamp'],
    importance: 2,
    status: 'active',
    updated_at: 1763e9,
    last_accessed_at: 1763e9,
  },
]
const Q12 = 'publishTimestamp 该写什么值'
const pos12 = (hits, id) => hits.findIndex((h) => String(h.id).startsWith(id))
const r12on = V.search(Q12, R12_DOCS, { k: 10 })
const r12off = V.search(Q12, R12_DOCS, { k: 10, tipAssert: false })
check(
  'R12 问「该写什么值」时，开头就是断言的那条进第一（要的是结论，不是背景）',
  pos12(r12on, '0r12a0001') === 0,
  `断言条第 ${pos12(r12on, '0r12a0001') + 1} 名，背景条第 ${pos12(r12on, '0r12a0002') + 1} 名`,
)
check(
  'R12 关得掉：tipAssert:false 时断言条不再第一（阴性对照，说明是这把刀在起作用）',
  pos12(r12off, '0r12a0001') > 0,
  `关掉后断言条第 ${pos12(r12off, '0r12a0001') + 1} 名`,
)
const r12plainA = V.search('publishTimestamp 那两套时间戳是怎么来的', R12_DOCS, { k: 10 })
const r12plainB = V.search('publishTimestamp 那两套时间戳是怎么来的', R12_DOCS, { k: 10, tipAssert: false })
check(
  'R12 问句不是求值型时，开关前后逐位同序（来龙去脉不替人挑结论）',
  r12plainA.map((h) => h.id).join(',') === r12plainB.map((h) => h.id).join(','),
  `同序=${r12plainA.map((h) => String(h.id).slice(0, 9)).join(',')}`,
)
const s12of = (hits, id) => Number(hits.find((h) => String(h.id).startsWith(id))?.score ?? 0)
check(
  'R12 只看开头六十个字：断言写在后面那条一点不加（写在第五段的断言不是这条的结论）',
  Math.abs(s12of(r12on, '0r12a0004') - s12of(r12off, '0r12a0004')) < 1e-9 &&
    s12of(r12on, '0r12a0001') > s12of(r12off, '0r12a0001'),
  `后段断言条 ${s12of(r12on, '0r12a0004').toFixed(3)}→${s12of(r12off, '0r12a0004').toFixed(3)}；开头断言条 ${s12of(r12on, '0r12a0001').toFixed(3)}→${s12of(r12off, '0r12a0001').toFixed(3)}`,
)
const afCalls = (SRC.match(/assertRatioOf\(/g) || []).length
check(
  'R12 只在正文这一侧算断言密度：问句那条只判「是不是在求值」，密度分两处落地（进档 + 档内）',
  afCalls === 3 && SRC.includes('const tipOn = tipAssertOn(query) && opts.tipAssert !== false;'),
  `assertRatioOf( 出现 ${afCalls} 次（定义 1 + 分档 1 + 打分 1）`,
)
const s12on = Number(r12on.find((h) => String(h.id).startsWith('0r12a0001'))?.score ?? 0)
const s12zero = Number(
  V.search(Q12, R12_DOCS, { k: 10, tipAssertW: 0 }).find((h) => String(h.id).startsWith('0r12a0001'))?.score ?? 0,
)
const s12off = Number(r12off.find((h) => String(h.id).startsWith('0r12a0001'))?.score ?? 0)
check(
  'R12 权重是旋钮：tipAssertW:0 与关掉同分，默认比关掉高（加成真的落在那条分数上）',
  Math.abs(s12zero - s12off) < 1e-9 && s12on > s12off,
  `默认 ${s12on.toFixed(3)} / 权重0 ${s12zero.toFixed(3)} / 关了 ${s12off.toFixed(3)}`,
)

// ── R13（0.2.176）状态问句直通现状仓 ────────────────────────────────────────────
// 真库里问「现在主线推进到哪一版」，要的是一条 project 层的「项目现状」，而它和问句
// 一个词都不重——纯词法连候选都进不去。这一组用四条受控语料把这件事钉住，顺带钉住「它不乱动」。
const R13_DOCS = [
  {
    id: '0r13a0001',
    level: 'project',
    content: '项目现状（0.2.176）：24 支自检全绿，成本快照已换代，这一轮整备完毕。',
    title: '',
    keywords: ['项目现状', '交付态'],
    importance: 2,
    status: 'active',
    updated_at: 1763e9,
    last_accessed_at: 1763e9,
  },
  {
    id: '0r13a0002',
    level: 'project',
    content: '当前待办（2026-11-22 整理）：①是否推远端 ②清理临时模型目录 ③重启才吃到新版。',
    title: '',
    keywords: ['当前待办', '待办'],
    importance: 2,
    status: 'active',
    updated_at: 1762e9,
    last_accessed_at: 1762e9,
  },
  {
    id: '0r13a0003',
    level: 'lesson',
    content: '推送之前必须问主人点头，不许自己往远端仓库推。',
    title: '',
    keywords: ['推送', '问主人', '远端仓库'],
    importance: 3,
    status: 'active',
    updated_at: 1761e9,
    last_accessed_at: 1761e9,
  },
  {
    id: '0r13a0004',
    level: 'topic',
    content: '评测线为什么封存：榜单口径变了三轮，冻结快照答不了时效题，索性封存。',
    title: '',
    keywords: ['评测线', '封存', '缘由'],
    importance: 2,
    status: 'active',
    updated_at: 1760e9,
    last_accessed_at: 1760e9,
  },
]
const pos13 = (hits, id) => hits.findIndex((h) => String(h.id).startsWith(id))
const Q13 = '现在主线推进到哪一版'
const r13on = V.search(Q13, R13_DOCS, { k: 10 })
const r13off = V.search(Q13, R13_DOCS, { k: 10, statusDigest: false })
check(
  'R13 状态问句去现状仓取：词面一个都不重，也要把「项目现状」抬到第一',
  pos13(r13on, '0r13a0001') === 0,
  `现状条第 ${pos13(r13on, '0r13a0001') + 1} 名`,
)
check(
  'R13 关得掉：statusDigest:false 时它不是第一（阴性对照，说明是这一刀在起作用）',
  pos13(r13off, '0r13a0001') !== 0,
  `关掉后现状条${pos13(r13off, '0r13a0001') === -1 ? '不在候选里' : `第 ${pos13(r13off, '0r13a0001') + 1} 名`}`,
)
const r13objA = V.search('现在推送欠账什么规矩', R13_DOCS, { k: 10 })
const r13objB = V.search('现在推送欠账什么规矩', R13_DOCS, { k: 10, statusDigest: false })
check(
  'R13 对象问句不插手：问「现在这笔规矩怎么算」时开关前后逐位同序（泛时间词不算局面词）',
  r13objA.map((h) => String(h.id)).join(',') === r13objB.map((h) => String(h.id)).join(','),
  `同序=${r13objA.map((h) => String(h.id).slice(0, 9)).join(',')}`,
)
const r13why = V.search('评测线为什么封存', R13_DOCS, { k: 10 })
const r13anchor = V.search('0.2.150 主线停在哪一版', R13_DOCS, { k: 10 })
const r13anchorOff = V.search('0.2.150 主线停在哪一版', R13_DOCS, { k: 10, statusDigest: false })
check(
  'R13 问原因、问「某版本那一刻」都不拦：现状仓答不了缘由，也不该替时间锚抢答',
  r13why[0] && String(r13why[0].id).startsWith('0r13a0004') &&
    r13anchor.map((h) => String(h.id)).join(',') === r13anchorOff.map((h) => String(h.id)).join(','),
  `原因句首位=${String(r13why[0]?.id).slice(0, 9)}；锚点句与关掉时同序`,
)
const sdCalls = (SRC.match(/statusDigestOf\(/g) || []).length
check(
  'R13 只在两处落地：定义一次、search 里调用一次；被抬的那条带 explain.statusDigest 记号',
  sdCalls === 2 &&
    r13on.find((h) => String(h.id).startsWith('0r13a0001'))?.explain?.statusDigest === undefined &&
    V.search(Q13, R13_DOCS, { k: 10, explain: true }).some((h) => h.explain?.statusDigest === true),
  `statusDigestOf( 出现 ${sdCalls} 次（定义 1 + 调用 1）`,
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
