/**
 * [macro-fusion 0.2.90] 两把尺子探针：真 vendor 引擎 + 合成语料，不启动 DSH、不碰真记忆库。
 *
 * 「相似」在这个库里有两只尺子——cosine（排序）和词集 Jaccard（写侧去重）。0.2.89 之前只报 cosine，
 * 于是「长条目里嵌了一句」能报 0.715 被当成「这句话记过了」。本探针守的是：两个数都报、口径各自说得清。
 *
 *   U0 装配：工具齐、四条语料就位
 *   U1 近重复：repeat ≥0.8，且回执说「写侧会判重复」
 *   U2 两处同口径：写侧回执的「重复度 N%」与相似检索的 repeat 是同一个数
 *   U3 长文嵌一句：cosine 高、repeat 低 30 个点以上 —— 回执要点名「看着像、其实不是同一句」
 *   U4 同话题不同结论：不触发任何一条校准句（该安静的安静）
 *   U5 repeat 每条都有、都是 0-1
 *   U6 排序仍按 cosine 降序（加了一个数没有偷偷改排序）
 *   U7 三语文案都有 repeat 这一键
 *   U8 repeat 用 tokenize 复算与工具一致（Jaccard 是同一把，不是另起一套）
 *
 * 用法：node tools/probe-ruler.mjs
 */
import { root } from './_root.mjs'
import { registerHooks } from 'node:module'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const home = mkdtempSync(join(tmpdir(), 'macro-ruler-home-'))
process.env.DSH_HOME = home

const stubDir = mkdtempSync(join(tmpdir(), 'macro-ruler-stub-'))
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
const T = new Map()
V.registerMemoryTools((t) => T.set(t.name, t), '.dsh-meow')

const workspace = join(home, 'ws')
mkdirSync(workspace, { recursive: true })
const execOf = (id) => ({ agent: { session: { header: { cwd: workspace, id } } } })
const call = (name, args, exec) => T.get(name).execute(args, exec)
const flat = (v) => String(v ?? '').replace(/\n+/g, ' / ')

// ── 语料 ────────────────────────────────────────────────────────────────────
const BASE = '发版前必须先把当前树备份到 D 盘，出问题先还原备份再排查。'
const BASE_KW = ['备份', '发版', '还原', '排查', '当前树', '流程', '纪律', '运维', '回滚', '发布']
// 近重复：同一件事改几个字（写侧 80% 门槛以内）
const NEAR = '发版前必须先把当前树备份到 D 盘，出了问题先还原备份再排查原因。'
const NEAR_KW = ['备份', '发版', '还原', '排查', '流程']
// 长条目里嵌着一模一样的基准句：cosine 会高，逐字重复度不该跟着高
const EMBED =
  '这半年踩过的坑都记在这里：发版前必须先把当前树备份到 D 盘，出问题先还原备份再排查；' +
  '另外日志要留三天，别清空 sessions 目录，接口 500 先看 tail 而不是整条重跑。'
const EMBED_KW = ['日志', '坑', 'sessions', '接口', '重跑']
// 同话题、两件事
const TOPIC = '每次发版都要写清验收人和回滚窗口，否则别合并。'
const TOPIC_KW = ['发版', '验收人', '回滚窗口', '合并']

check(
  'U0 工具注册齐（remember / find_similar 两件必须有）',
  ['memory_remember', 'memory_find_similar'].every((n) => T.has(n)),
  `${T.size} 个`,
)

const W = execOf('sess-ruler-write')
const eBase = await call('memory_remember', { content: BASE, level: 'fact', keywords: BASE_KW, importance: 2, project: '全局' }, W)
// NEAR 写进 lesson：跨层不会被合并，而且能顺手读到写侧那把尺子的分数
const eNear = await call('memory_remember', { content: NEAR, level: 'lesson', keywords: NEAR_KW, importance: 2, project: '全局' }, W)
const eEmbed = await call('memory_remember', { content: EMBED, level: 'fact', keywords: EMBED_KW, importance: 2, project: '全局' }, W)
const eTopic = await call('memory_remember', { content: TOPIC, level: 'fact', keywords: TOPIC_KW, importance: 2, project: '全局' }, W)

// ① 记录：EMBED 会不会因为跟 BASE 太像被同层合并？先确认四条都在
const ids = [eBase, eNear, eEmbed, eTopic]
check(
  'U0 四条语料都写下了（近重复那条写进 lesson，避开同层合并）',
  ids.every((r) => r && r.id) && new Set(ids.map((r) => r.id)).size === 4,
  ids.map((r) => String(r?.id ?? '?').slice(0, 8)).join(' '),
)

const sim = await call('memory_find_similar', { id: eBase.id, k: 5 }, W)
const noteText = String(sim.note ?? '')
const byId = new Map(sim.hits.map((h) => [h.id, h]))
const nearHit = byId.get(eNear.id)
const embedHit = byId.get(eEmbed.id)
const topicHit = byId.get(eTopic.id)

// ── U1 近重复 ──────────────────────────────────────────────────────────────
check(
  'U1 近重复（改几个字）：repeat ≥0.8 —— 这一条写侧就会判重复',
  Boolean(nearHit) && nearHit.repeat >= 0.8,
  nearHit ? `similarity ${nearHit.similarity} / repeat ${nearHit.repeat}` : '没出现',
)
check(
  'U1 回执说清「写侧会判重复，多半是同一句话存进了两层」',
  /逐字重复度 ≥80%/.test(noteText),
  flat(noteText).slice(0, 90),
)

// ── U2 两处同一把尺子 ───────────────────────────────────────────────────────
// 写侧（memory_remember → crossLevelDupe）只在 ≥0.8 时报，读到的「重复度 N%」正是本工具的 repeat。
const wroteN = (String(eNear.note ?? '').match(/重复度 (\d+)%/) ?? [])[1]
check(
  'U2 写侧回执的「重复度 N%」与相似检索的 repeat 是同一个数（差 ≤3 个点）',
  wroteN !== undefined && nearHit !== undefined && Math.abs(Number(wroteN) / 100 - nearHit.repeat) <= 0.03,
  `写侧 ${wroteN ?? '(没报)'}% vs 读侧 ${nearHit ? nearHit.repeat : '?'}`,
)

// ── U3 长文嵌一句 ─────────────────────────────────────────────────────────
check(
  'U3 长条目里嵌着一句：cosine ≥0.5 但逐字重复度不到 50%',
  Boolean(embedHit) && embedHit.similarity >= 0.5 && embedHit.repeat < 0.5,
  embedHit ? `similarity ${embedHit.similarity} / repeat ${embedHit.repeat}` : '没出现',
)
check(
  'U3 回执点名「看着像、其实不是同一句」（不然这条就是下一个「我以为是同一句」）',
  /看着像、其实不是同一句/.test(noteText),
  flat(noteText).slice(0, 90),
)

// ── U4 该安静的安静 ────────────────────────────────────────────────────────
check(
  'U4 同话题不同结论那条：repeat 明显低于 0.8（没有被算进「写侧会判重复」）',
  topicHit === undefined || topicHit.repeat < 0.8,
  topicHit ? `similarity ${topicHit.similarity} / repeat ${topicHit.repeat}` : '没进结果（分太低）',
)

// ── U5 字段完整性 ─────────────────────────────────────────────────────────
check(
  'U5 每条命中都有 repeat，且是 0-1 的数',
  sim.hits.length > 0 && sim.hits.every((h) => typeof h.repeat === 'number' && h.repeat >= 0 && h.repeat <= 1),
  `${sim.hits.length} 条`,
)
check(
  'U6 排序仍按 cosine 降序（多报一个数没偷偷改排序）',
  sim.hits.every((h, i) => i === 0 || sim.hits[i - 1].similarity >= h.similarity),
  sim.hits.map((h) => h.similarity).join(' ≥ '),
)

// ── U7 三语文案 ──────────────────────────────────────────────────────────
const prompts = ['zh', 'en', 'pt-br'].map((l) =>
  readFileSync(join(root, 'vendor', 'meow-memory', 'lib', 'prompts', l, 'tools.md'), 'utf8'),
)
check(
  'U7 三语文案都有 memory_find_similar.out.hits.repeat，且跟写侧门槛对上（提到 0.8 / 合并）',
  prompts.every((p) => /memory_find_similar\.out\.hits\.repeat:/.test(p) && /0\.8/.test(p)),
)

// ── U8 Jaccard 是同一把 ───────────────────────────────────────────────────
const jaccard = (a, b) => {
  const sa = new Set(V.tokenize(a))
  const sb = new Set(V.tokenize(b))
  if (sa.size === 0 || sb.size === 0) return 0
  let inter = 0
  for (const t of sa) if (sb.has(t)) inter++
  return inter / (sa.size + sb.size - inter)
}
// repeat 与写侧合并判据同源：只比正文（不含 title / keywords）
const replica = Math.round(jaccard(BASE, EMBED) * 1e3) / 1e3
check(
  'U8 repeat 用 tokenize 复算与工具一致（同一把 Jaccard，不是另起一套）',
  embedHit !== undefined && Math.abs(replica - embedHit.repeat) <= 0.002,
  `复算 ${replica} vs 工具 ${embedHit ? embedHit.repeat : '?'}`,
)


// ── D 段：dream 拿到的是同一把尺子（0.2.92）─────────────────────────────
// dream 是全库唯一「回头看旧条目」的地方，可它原来只给清单、不给判据：哪两条其实是同一句话，
// 只能靠模型自己扫字面。这里守的是：写侧算出来的逐字重复对，原样进清单；没对子时一个字不加。
const dreamOf = (sid, ws) => {
  const db = V.getDb(ws, '.dsh-meow')
  const rounds = V.collectDreamRounds(db, sid, ws, '.dsh-meow', 0)
  const msg = V.buildDreamMessage(db, sid, Date.now(), rounds, 0)
  return msg.content.map((x) => x.text).join('\n')
}
// 本窗口那四条里，只有 BASE ⇄ NEAR 是逐字 ≥0.8（EMBED 只嵌了一句、TOPIC 只是同话题）
const dreamText = dreamOf('sess-ruler-write', workspace)
const dupLine = (dreamText.match(/^- (\S+) ⇄ (\S+)  ([0-9.]+) · (\S+) ⇄ (\S+)$/m) ?? [])
const dupSection = dreamText.includes('逐字重复对') && /【逐字重复对 \d+ 对】/.test(dreamText)
check(
  'D1 dream 清单里点名了那一对逐字重复（清单自己算，不让模型凭字面猜）',
  dupSection && /【逐字重复对 1 对】/.test(dreamText) && dupLine.length > 0,
  dupLine.length > 0 ? `${dupLine[1]} ⇄ ${dupLine[2]} ${dupLine[3]}` : '没这一行',
)
check(
  'D2 两个短 id 互相可区分（同一批写下的 id 前 8 位会撞，撞了就往下延）',
  dupLine.length > 0 && dupLine[1].trim() !== dupLine[2].trim() && dupLine[1].trim().length >= 8,
  dupLine.length > 0 ? `${dupLine[1].trim().length} / ${dupLine[2].trim().length} 位` : '没这一行',
)
check(
  'D3 门槛与处置都说清了（≥80% 与写侧同一把尺子，且没有留下没填的占位符）',
  /≥80%/.test(dreamText) && /memory_remember 判「重复」是同一把尺子/.test(dreamText) && !/[{}]threshold/.test(dreamText),
  (dreamText.match(/逐字重复度 ≥[0-9]+%/) ?? ['(没写门槛)'])[0],
)
// 精确到「这一对的成员就是 BASE 与 NEAR」：不拿截断 id 去做子串匹配——8 位前缀互为子串，
// 那样写出来的否定断言会假红/假绿（本探针第一版就这么错过了 EMBED）。
const isPrefixOf = (pre, id) => String(id ?? '').startsWith(pre)
const pairIds = dupLine.length > 0 ? [dupLine[1].trim(), dupLine[2].trim()] : []
const pairCovers = (id) => pairIds.some((q) => isPrefixOf(q, id))
check(
  'D4 重复对的成员正好是 BASE 与 NEAR（长文嵌一句、同话题都不在里头）',
  pairIds.length === 2 &&
    pairIds.every((q) => isPrefixOf(q, eBase.id) || isPrefixOf(q, eNear.id)) &&
    pairCovers(eBase.id) &&
    pairCovers(eNear.id) &&
    !pairCovers(eEmbed.id) &&
    !pairCovers(eTopic.id),
  pairIds.length > 0 ? pairIds.join(' / ') : '没这一行',
)
// 阴性对照：只有一个条目的窗口不该出现重复对块（没对子就一个字不加）
const soloWs = join(home, 'ws-solo')
mkdirSync(soloWs, { recursive: true })
await call('memory_remember', { content: '单条目窗口，没有任何重复。', level: 'fact', keywords: ['单条', '窗口'], importance: 1, project: '全局' }, execOf('sess-ruler-solo', soloWs))
const soloText = dreamOf('sess-ruler-solo', soloWs)
check(
  'D5 阴性对照：只有一条的窗口没有【逐字重复对】这一块',
  !/【逐字重复对 \d+ 对】/.test(soloText) && soloText.includes('本组记忆'),
  (soloText.match(/【逐字重复对 \d+ 对】/) ?? ['没有这一块（对）'])[0],
)
const labelFiles = ['zh', 'en', 'pt-br'].map((l) =>
  readFileSync(join(root, 'vendor', 'meow-memory', 'lib', 'prompts', l, 'labels.md'), 'utf8'),
)
check(
  'D6 三语 labels 都有 dream.dup.title / dream.dup.rule（新文案不许只写中文）',
  labelFiles.every((f) => /^- dream\.dup\.title:/m.test(f) && /^- dream\.dup\.rule:/m.test(f)),
)
const slotFiles = ['zh', 'en', 'pt-br'].map((l) =>
  readFileSync(join(root, 'vendor', 'meow-memory', 'lib', 'prompts', l, 'dream-atomic.md'), 'utf8'),
)
check(
  'D7 三语的整理指引都写了这一条（≥80% 才算重复，相似只是同话题）',
  slotFiles.every((f) => /≥80%/.test(f) && /archived/.test(f)),
)

// ── D8/D9：跨轮次的同一句话（0.2.93）─────────────────────────────────────
// atomic 与 topic 是两次独立的消息。0.2.92 只在「本轮的行」里两两比，于是同一句话一条记成 fact、
// 一条记成 topic 时永远碰不到一起——写侧 crossLevelDupe 早就能抓，dream 又漏一次。
const dreamAll = (sid, ws) => {
  const db = V.getDb(ws, '.dsh-meow')
  const rounds = V.collectDreamRounds(db, sid, ws, '.dsh-meow', 0)
  return rounds.map((_, i) => V.buildDreamMessage(db, sid, Date.now(), rounds, i).content.map((x) => x.text).join('\n'))
}
const crossWs = join(home, 'ws-cross')
mkdirSync(crossWs, { recursive: true })
// 坑：execOf 把 cwd 写死成主 workspace，跨窗口那几条要按自己目录写，否则 dream 在 crossWs 里什么都看不到
const execIn = (cwd, id) => ({ agent: { session: { header: { cwd, id } } } })
const CROSS = '跨轮次的同一句话：这条在 fact 与 topic 里各存了一份，正文逐字相同，处置应当只做一次。'
await call('memory_remember', { content: CROSS, level: 'fact', keywords: ['跨轮次', '同一句话', 'fact', 'topic', '重复', '处置'], importance: 1, project: '全局' }, execIn(crossWs, 'sess-ruler-cross'))
await call('memory_remember', { content: CROSS, level: 'topic', title: '跨轮次重复', keywords: ['跨轮次', '同一句话', 'fact', 'topic', '重复', '处置'], importance: 1, project: '全局' }, execIn(crossWs, 'sess-ruler-cross'))
await call('memory_remember', { content: '完全无关的一条：讲的是探针工作目录怎么清理，和上面那句没有共同词。', level: 'fact', keywords: ['探针', '目录', '清理', '无关'], importance: 1, project: '全局' }, execIn(crossWs, 'sess-ruler-cross'))
const crossTexts = dreamAll('sess-ruler-cross', crossWs)
const allCrossText = crossTexts.join('\n---\n')
const crossDupeLine = crossTexts.map((t) => (t.match(/^- (\S+) ⇄ (\S+)  ([0-9.]+) · (\S+) ⇄ (\S+)/m) ?? [])[0] ?? '').filter(Boolean)
const pairLineCount = crossTexts.reduce((n, t) => n + (t.match(/^- \S+ ⇄ \S+  [0-9.]+ · /gm) ?? []).length, 0)
check(
  'D8 跨轮次（fact ⇄ topic）的同一句话也被点名，且整轮只印一次（不在两轮消息里各印一遍）',
  crossDupeLine.length > 0 && pairLineCount === 1 && /fact ⇄ topic/.test(allCrossText) && /（另一组）/.test(allCrossText),
  `对子行 ${pairLineCount} 条 / ${crossDupeLine[0] ?? '没这一行'}`,
)
check(
  'D9 阴性对照：同一个窗口里无关的那条没被凑成对子（只按正文词集算，不靠项目/层级硬配）',
  !/清理/.test(crossDupeLine.join(' ')) && crossTexts.every((t) => (t.match(/^- \S+ ⇄ \S+  [0-9.]+ · /gm) ?? []).length <= 1),
  crossDupeLine[0] ?? '没有对子',
)

const crossSlotFiles = ['zh', 'en', 'pt-br'].flatMap((l) => ['dream-atomic.md', 'dream-topic.md'].map((f) => readFileSync(join(root, 'vendor', 'meow-memory', 'lib', 'prompts', l, f), 'utf8')))
check(
  'D10 三语指引都说明了「（另一组）」怎么处置（不然跨轮次对子等于没说）',
  crossSlotFiles.every((f) => /另组|另一组|another round|outra rodada/.test(f)) &&
    labelFiles.every((f) => /^- dream\.dup\.crossRound:/m.test(f)),
  `${crossSlotFiles.filter((f) => /另组|另一组|another round|outra rodada/.test(f)).length}/${crossSlotFiles.length} 份指引`,
)


// ── E1–E5：同一件事的「短摘录 + 长详写」（0.2.94）──────────────────────────
// 逐字重复度判据天然抓不到这种对子：15 词的摘录对 92 词的详写只有 0.16（实测），
// 但它们说的是同一件事。判据换成覆盖度：短的那条几乎整句都落在长的那条里。
const coverWs = join(home, 'ws-cover')
mkdirSync(coverWs, { recursive: true })
const C_SHORT = 'dsh 的 sandbox 关了以后 workspace 写入会报 EPERM，得先放行目录'
const C_LONG =
  '排查记录：主人在 Windows 上跑 dsh 的时候发现 sandbox 关了以后 workspace 写入会报 EPERM，得先放行目录才行；具体表现是 node 进程 fs.writeFile 直接抛错、robocopy 也会失败，最后是靠 diagnose-windows-sandbox-acl 检查祖先目录 ACL 才定位到问题，结论是沙箱策略与目录权限不一致，不是插件自己的 bug，改法是把工作目录加到放行清单里并重启 dsh。'
const C_OTHER = '另一个插件的日志说明：沙箱模式与目录权限是两件事，写日志失败通常是磁盘满或路径太长，与 sandbox 无关，遇到先看 free space。'
const coverExec = execIn(coverWs, 'sess-ruler-cover')
const eShort = await call('memory_remember', { content: C_SHORT, level: 'fact', keywords: ['sandbox', 'EPERM', '写入', '放行', '目录'], importance: 1, project: '全局' }, coverExec)
const eLong = await call('memory_remember', { content: C_LONG, level: 'topic', title: 'sandbox 写入报 EPERM 的排查', keywords: ['sandbox', 'EPERM', '排查', 'ACL', '放行'], importance: 1, project: '全局' }, coverExec)
const eOther = await call('memory_remember', { content: C_OTHER, level: 'fact', keywords: ['日志', '磁盘', '路径', '无关', '对照'], importance: 1, project: '全局' }, coverExec)
const coverText = dreamOf('sess-ruler-cover', coverWs)
const coverLine = (coverText.match(/^- (\S+) ⊂ (\S+)  ([0-9.]+) · (\S+) ⇒ (\S+)/m) ?? [])
check(
  'E1 dream 清单点名了「短摘录 + 长详写」这一对（逐字重复度低也算同一件事）',
  /【重复详写 1 对】/.test(coverText) && coverLine.length > 0,
  coverLine.length > 0 ? `${coverLine[1]} ⊂ ${coverLine[2]} ${coverLine[3]}` : '没这一行',
)
check(
  'E2 方向对：⊂ 左边是短摘录（fact）、右边是长详写（topic），不是反着印',
  coverLine.length > 0 &&
    isPrefixOf(coverLine[1].trim(), eShort.id) &&
    isPrefixOf(coverLine[2].trim(), eLong.id) &&
    coverLine[4] === 'fact' &&
    coverLine[5].startsWith('topic'),
  coverLine.length > 0 ? `${coverLine[1]} ⇒ ${coverLine[2]}  ${coverLine[4]} ⇒ ${coverLine[5]}` : '没这一行',
)
check(
  'E3 覆盖度与处置都写清了（≥90% 的门槛填上了，处置说的是合成一条，不是当两件事留着）',
  coverLine.length > 0 &&
    Number(coverLine[3]) >= 0.9 &&
    /覆盖度 ≥90%/.test(coverText) &&
    /合成一条/.test(coverText) &&
    /archived/.test(coverText) &&
    !/[{}]contain/.test(coverText),
  (coverText.match(/覆盖度 ≥[0-9]+%/) ?? ['(没写门槛)'])[0],
)
check(
  'E4 阴性对照 + 互斥：无关的那条没被凑成详写对，且这一窗只有详写块、没有逐字重复块（同一对不印两遍）',
  coverLine.length > 0 &&
    !isPrefixOf(coverLine[1].trim(), eOther.id) &&
    !isPrefixOf(coverLine[2].trim(), eOther.id) &&
    (coverText.match(/^- \S+ ⊂ \S+  [0-9.]+ · /gm) ?? []).length === 1 &&
    !/【逐字重复对 \d+ 对】/.test(coverText),
  `详写行 ${(coverText.match(/^- \S+ ⊂ \S+  [0-9.]+ · /gm) ?? []).length} 条`,
)
const coverSlotFiles = ['zh', 'en', 'pt-br'].flatMap((l) => ['dream-atomic.md', 'dream-topic.md'].map((f) => readFileSync(join(root, 'vendor', 'meow-memory', 'lib', 'prompts', l, f), 'utf8')))
check(
  'E5 三语文案与指引都有这一块（labels 的 dream.cover.title / rule + 六份指引）',
  labelFiles.every((f) => /^- dream\.cover\.title:/m.test(f) && /^- dream\.cover\.rule:/m.test(f)) &&
    coverSlotFiles.every((f) => /重复详写对|duplicate write-ups|redações duplicadas/.test(f)),
  `${coverSlotFiles.filter((f) => /重复详写对|duplicate write-ups|redações duplicadas/.test(f)).length}/${coverSlotFiles.length} 份指引`,
)

// ── F1–F4：覆盖度只说「是不是同一件事」，处方行才说「会不会漏字」（0.2.95）──────────
// 覆盖度 ≥90% 的意思是：短条还有最多 10% 的词没落进长条。只喊「合成一条」，那 10% 多半跟着短条
// 一起被扔掉——所以每一对下面再印一行处方，把短条里长条没有的词逐字数出来（最多 6 个）；
// 一个都没有时也要说清，那正好证明这次合并是无损的。
const RECIPE_LINE = /^ {2}(处方|Recipe|Receita)：/m
const keepWs = join(home, 'ws-recipe-keep')
mkdirSync(keepWs, { recursive: true })
const R_SHORT_KEEP = 'sandbox 关了以后 workspace 写入会报 EPERM，得先放行目录 TB7719'
const R_LONG =
  '排查记录：主人在 Windows 上跑 dsh 的时候发现 sandbox 关了以后 workspace 写入会报 EPERM，得先放行目录才行；具体表现是 node 进程 fs.writeFile 直接抛错、robocopy 也会失败，最后用 diagnose-windows-sandbox-acl 检查祖先目录 ACL 才定位到问题，结论是沙箱策略与目录权限不一致，不是插件自己的 bug。'
await call(
  'memory_remember',
  { content: R_SHORT_KEEP, level: 'fact', keywords: ['sandbox', 'EPERM', '放行', '目录', '单号'], importance: 1, project: '全局' },
  execIn(keepWs, 'sess-ruler-keep'),
)
await call(
  'memory_remember',
  { content: R_LONG, level: 'topic', title: 'sandbox 写入 EPERM 的排查', keywords: ['sandbox', 'EPERM', '排查', 'ACL', '放行'], importance: 1, project: '全局' },
  execIn(keepWs, 'sess-ruler-keep'),
)
const keepText = dreamAll('sess-ruler-keep', keepWs).join('\n---\n')
const keepPair = keepText.match(/^- (\S+) ⊂ (\S+)  ([0-9.]+) · /m) ?? []
check(
  'F1 每个详写对子下面都跟着一行处方（不是只有标题和规矩，模型知道具体该补哪些字）',
  keepPair.length > 0 && RECIPE_LINE.test(keepText) && !/\{(n|words|short|long)\}/.test(keepText),
  RECIPE_LINE.test(keepText) ? (keepText.match(/^ {2}(?:处方|Recipe|Receita)：.*/m) ?? [''])[0].slice(0, 60) : '没有处方行',
)
check(
  'F2 短条里长条没有的词被点名（TB7719 只在短条里——这类编号正是合并时最容易丢的东西）',
  /tb7719/i.test(keepText) && /1 (个词|word|palavra)/.test(keepText),
  (keepText.match(/^ {2}(?:处方|Recipe|Receita)：.*/m) ?? ['(没有处方行)'])[0].slice(0, 80),
)
const noneWs = join(home, 'ws-recipe-none')
mkdirSync(noneWs, { recursive: true })
const R_SHORT_NONE = 'sandbox 关了以后 workspace 写入会报 EPERM，得先放行目录'
await call(
  'memory_remember',
  { content: R_SHORT_NONE, level: 'fact', keywords: ['sandbox', 'EPERM', '放行', '目录', '写入'], importance: 1, project: '全局' },
  execIn(noneWs, 'sess-ruler-none'),
)
await call(
  'memory_remember',
  { content: R_LONG, level: 'topic', title: 'sandbox 写入 EPERM 的排查', keywords: ['sandbox', 'EPERM', '排查', 'ACL', '放行'], importance: 1, project: '全局' },
  execIn(noneWs, 'sess-ruler-none'),
)
const noneText = dreamAll('sess-ruler-none', noneWs).join('\n---\n')
check(
  'F3 阴性对照：短条整句都在长条里时，处方说「没有长条之外的词」，不硬凑几个词出来',
  /⊂/.test(noneText) && /没有长条之外的词|no words the long entry lacks|nenhuma palavra/.test(noneText) && !/tb7719/i.test(noneText),
  (noneText.match(/^ {2}(?:处方|Recipe|Receita)：.*/m) ?? ['(没有处方行)'])[0].slice(0, 70),
)
check(
  'F4 三语指引都写了「怎么合并」与三把尺子的分工，labels 都有 keep / keepNone 两键',
  coverSlotFiles.every((f) => /处方|recipe|receita/i.test(f)) &&
    coverSlotFiles.every((f) => /三把尺子|three rulers|três réguas/.test(f)) &&
    labelFiles.every((f) => /^- dream\.cover\.keep:/m.test(f) && /^- dream\.cover\.keepNone:/m.test(f)),
  `${coverSlotFiles.filter((f) => /三把尺子|three rulers|três réguas/.test(f)).length}/${coverSlotFiles.length} 份指引`,
)

// ── G1–G6：整理完要留痕——回执先说这一轮看到什么，收尾把同一份数字落库（0.2.96）──────────
// dream 以前「做完了什么都不说」：claim 只防重复整理，logDream 只记 done + 轮数，主人在面板与回执里都
// 看不到这一轮翻了多少条、撞上几对、有几对合并会丢字。这里守的是：摘要里的数字必须和清单里真正印出来
// 的块逐项相等（同源，不是另估一份）；没有字要补时不许硬凑那句缺词提示。
const planWs = keepWs
const planSid = 'sess-ruler-keep'
const planDb = V.getDb(planWs, '.dsh-meow')
const planRounds = V.collectDreamRounds(planDb, planSid, planWs, '.dsh-meow', 0)
const planDigest = V.dreamPlanDigest(planRounds)
const planText = dreamAll(planSid, planWs).join('\n---\n')
const printedCover = (planText.match(/^- \S+ ⊂ \S+  [0-9.]+ · /gm) ?? []).length
const printedDup = (planText.match(/^- \S+ ⇄ \S+  [0-9.]+ · /gm) ?? []).length
const printedMissing = (planText.match(/这 (\d+) 个词|these (\d+) words|estas (\d+) palavras/g) ?? []).reduce(
  (n, m) => n + Number(m.replace(/\D+/g, '')),
  0,
)
check(
  'G1 摘要里的对子数与清单里真正印出来的块逐项相等（同一份清单，不是另估一份）',
  planDigest.cover === printedCover && planDigest.dup === printedDup && planDigest.cover === 1 && planDigest.dup === 0,
  `摘要 cover=${planDigest.cover} dup=${planDigest.dup} / 印出来 ⊂${printedCover} ⇄${printedDup}`,
)
check(
  'G2 摘要的缺词数与处方行点名的词数一致，且条目数就是这一轮选中的行数（rows=2：短摘录 + 长详写）',
  planDigest.missing === printedMissing && planDigest.missing === 1 && planDigest.rows === 2 && planDigest.rounds >= 1,
  `missing=${planDigest.missing} / 处方点名 ${printedMissing} · rows=${planDigest.rows} rounds=${planDigest.rounds}`,
)
const receiptZh = V.dreamReceipt(planDigest)
check(
  'G3 回执先念规模：四个数字全在，没有留未填的占位符',
  receiptZh.includes(`${planDigest.rounds} 轮`) &&
    receiptZh.includes(`${planDigest.rows} 条`) &&
    receiptZh.includes(`${planDigest.dup} 对`) &&
    receiptZh.includes(`${planDigest.cover} 对`) &&
    !/[{}]/.test(receiptZh),
  receiptZh.split('\n')[0].slice(0, 90),
)
// 阴性对照：这条窗口只有一条记忆，没有任何对子——摘要全 0，回执不许硬凑「有几个词只活在短条里」那一句
const soloDigest = V.dreamPlanDigest(V.collectDreamRounds(V.getDb(soloWs, '.dsh-meow'), 'sess-ruler-solo', soloWs, '.dsh-meow', 0))
const soloReceipt = V.dreamReceipt(soloDigest)
check(
  'G4 阴性对照：干净窗口的摘要全 0，且回执不提缺词（该安静的安静）',
  soloDigest.dup === 0 && soloDigest.cover === 0 && soloDigest.missing === 0 && !/只活在短条里|live only in the excerpt/.test(soloReceipt) && soloReceipt.length > 0,
  `dup=${soloDigest.dup} cover=${soloDigest.cover} missing=${soloDigest.missing}`,
)
// 开工那一步真的走一遍：摘要要在 claim 之后算出来、回进 trace（dreamTool 与 /dream 都是拿 trace.digest
// 说话的，不是各自再算一份），同时落进 dream_meta，收尾才有东西可写进 dream_log
const planToolWs = join(home, 'ws-plan-tool')
mkdirSync(planToolWs, { recursive: true })
const planExec = execIn(planToolWs, 'sess-ruler-plan-tool')
await call('memory_remember', { content: R_SHORT_KEEP, level: 'fact', keywords: ['sandbox', 'EPERM', '放行', '目录', '单号'], importance: 1, project: '全局' }, planExec)
await call('memory_remember', { content: R_LONG, level: 'topic', title: 'sandbox 写入 EPERM 的排查', keywords: ['sandbox', 'EPERM', '排查', 'ACL', '放行'], importance: 1, project: '全局' }, planExec)
const trace96 = { reason: '' }
V.startWindowDream({}, planExec.agent, planToolWs, '.dsh-meow', undefined, 0, trace96)
const storedDigest = V.getDb(planToolWs, '.dsh-meow').getDreamMeta('dreamdigest:sess-ruler-plan-tool')
const toolReceipt = V.dreamReceipt(trace96.digest)
check(
  'G5 开工时摘要真的算好、回进 trace、且落进 dream_meta（工具面与 /dream 念的就是它，不是各自重算）',
  trace96.digest !== undefined &&
    trace96.digest.cover === 1 &&
    trace96.digest.missing === 1 &&
    typeof storedDigest === 'string' &&
    JSON.parse(storedDigest).cover === 1 &&
    /这一轮看到：\d+ 轮 \/ \d+ 条 · 逐字重复 \d+ 对 · 重复详写 1 对/.test(toolReceipt) &&
    /共 1 个词只活在短条里/.test(toolReceipt),
  `trace.cover=${trace96.digest?.cover} missing=${trace96.digest?.missing} meta=${storedDigest === undefined ? '缺' : '在'}`,
)
check(
  'G6 三语 labels 都有 dream.plan 与 dream.plan.missing 两键（回执不许只有中文）',
  labelFiles.every((f) => /^- dream\.plan:/m.test(f) && /^- dream\.plan\.missing:/m.test(f)),
  `${labelFiles.filter((f) => /^- dream\.plan:/m.test(f)).length}/${labelFiles.length} 份 labels`,
)
// 收尾真的留痕：走完两轮 dream（followup 能收消息），dream_log 的最后一行要带同一份摘要，meta 要清掉。
// 这条是 0.2.96 的正题——「整理完什么都不留」正是它要修的东西。
const logWs = join(home, 'ws-plan-log')
mkdirSync(logWs, { recursive: true })
const logAgent = { ...execIn(logWs, 'sess-ruler-plan-log').agent, followup() {} }
await call('memory_remember', { content: R_SHORT_KEEP, level: 'fact', keywords: ['sandbox', 'EPERM', '放行', '目录', '单号'], importance: 1, project: '全局' }, { agent: logAgent })
await call('memory_remember', { content: R_LONG, level: 'topic', title: 'sandbox 写入 EPERM 的排查', keywords: ['sandbox', 'EPERM', '排查', 'ACL', '放行'], importance: 1, project: '全局' }, { agent: logAgent })
const logDb = V.getDb(logWs, '.dsh-meow')
V.startWindowDream({}, logAgent, logWs, '.dsh-meow', undefined, 0)
V.advanceDream(logAgent, '.dsh-meow', undefined, 0)
V.advanceDream(logAgent, '.dsh-meow', undefined, 0)
const lastLog = logDb.db.prepare('SELECT summary, changes FROM dream_log ORDER BY run_at DESC LIMIT 1').get()
const lastChanges = JSON.parse(String(lastLog?.changes ?? '{}'))
check(
  'G7 收尾把同一份摘要写进 dream_log（changes.plan 有 rows/dup/cover/missing，summary 里也念一遍）',
  String(lastLog?.summary ?? '').includes('groups=') &&
    String(lastLog?.summary ?? '').includes('plan rows=2 dup=0 cover=1 missing=1') &&
    lastChanges.plan?.cover === 1 &&
    lastChanges.plan?.missing === 1 &&
    lastChanges.plan?.rows === 2,
  String(lastLog?.summary ?? '(没这一行)').slice(0, 96),
)
check(
  'G8 念完就把 meta 删掉（下一轮不许读到上一轮的旧账），但 stamped 这个老字段还在',
  V.getDb(logWs, '.dsh-meow').getDreamMeta('dreamdigest:sess-ruler-plan-log') === undefined && typeof lastChanges.stamped === 'number',
  `meta=${V.getDb(logWs, '.dsh-meow').getDreamMeta('dreamdigest:sess-ruler-plan-log') === undefined ? '已清' : '还在'} stamped=${lastChanges.stamped}`,
)
// 半路被中止也要留痕（abort 与 done 走同一个 finalize，这条守的是它没被改成只记 done 分支）
const abortWs = join(home, 'ws-plan-abort')
mkdirSync(abortWs, { recursive: true })
const abortAgent = { ...execIn(abortWs, 'sess-ruler-plan-abort').agent, followup() {} }
await call('memory_remember', { content: R_SHORT_KEEP, level: 'fact', keywords: ['sandbox', 'EPERM', '放行', '目录', '单号'], importance: 1, project: '全局' }, { agent: abortAgent })
await call('memory_remember', { content: R_LONG, level: 'topic', title: 'sandbox 写入 EPERM 的排查', keywords: ['sandbox', 'EPERM', '排查', 'ACL', '放行'], importance: 1, project: '全局' }, { agent: abortAgent })
V.startWindowDream({}, abortAgent, abortWs, '.dsh-meow', undefined, 0)
V.abortDream(abortAgent, '.dsh-meow', undefined)
const abortLog = V.getDb(abortWs, '.dsh-meow').db.prepare('SELECT summary FROM dream_log ORDER BY run_at DESC LIMIT 1').get()
check(
  'G9 中止（aborted）也带摘要落库——不是只有顺利收尾才留痕',
  String(abortLog?.summary ?? '').includes('aborted') && String(abortLog?.summary ?? '').includes('plan rows=2 dup=0 cover=1 missing=1'),
  String(abortLog?.summary ?? '(没这一行)').slice(0, 96),
)

// ── H. 账本读口（0.2.97）────────────────────────────────────────────────────
// 面板要把 dream_log 念给主人看，读口是 readDreamLedger()。它必须把三种「没念出账」分开：
// 没工作区 / 没建库 / 库在但读不出来——后两种合成一句，就是在拿「还没跑过」掩盖「坏了」。
const H1 = V.readDreamLedger('', '.dsh-meow', 5)
check('H1 没有工作区：missing=no-workspace，不假装「没跑过 dream」', H1.missing === 'no-workspace' && H1.rows.length === 0, H1.missing)

const emptyWs = join(home, 'ws-ledger-empty')
mkdirSync(emptyWs, { recursive: true })
const H2 = V.readDreamLedger(emptyWs, '.dsh-meow', 5)
check(
  'H2 工作区还没建库：missing=no-db，并且把要看的路径报出来',
  H2.missing === 'no-db' && H2.rows.length === 0 && H2.path.endsWith('memory.db'),
  H2.path.slice(-28),
)

const brokenWs = join(home, 'ws-ledger-broken')
mkdirSync(join(brokenWs, '.dsh-meow'), { recursive: true })
writeFileSync(join(brokenWs, '.dsh-meow', 'memory.db'), 'not a sqlite file at all', 'utf8')
const H3 = V.readDreamLedger(brokenWs, '.dsh-meow', 5)
check(
  'H3 库在但读不出来：missing 以 read-failed 开头、原因原样带出（不许说成没账本）',
  H3.missing.startsWith('read-failed:') && H3.rows.length === 0,
  H3.missing.slice(0, 60),
)

const H4 = V.readDreamLedger(logWs, '.dsh-meow', 5)
check(
  'H4 有账就念：最近一条带 plan，且顺序是最新在前',
  H4.missing === '' && H4.rows.length >= 1 && H4.rows[0].changes?.plan !== undefined && H4.rows[0].runAt >= (H4.rows[1]?.runAt ?? 0),
  `${H4.rows.length} 条 · 最新 plan.cover=${H4.rows[0]?.changes?.plan?.cover}`,
)

// 一行坏账不能吞掉整本账：手动插一条 changes 不是 JSON 的行
const badDb = V.getDb(logWs, '.dsh-meow')
badDb.db.prepare('INSERT INTO dream_log (run_at, summary, changes, note) VALUES (?, ?, ?, ?)').run(Date.now() + 5, 'window dream done: sess-bad changes={oops', '{oops', '')
const H5 = V.readDreamLedger(logWs, '.dsh-meow', 5)
check(
  'H5 坏行照样出一行（changes=null），不吞掉后面的好账',
  H5.rows.length >= 2 && H5.rows[0].changes === null && H5.rows.some((r) => r.changes?.plan !== undefined),
  `首行 changes=${String(H5.rows[0]?.changes)} 共 ${H5.rows.length} 条`,
)

// H6：条数上限自己收紧（0/负数走默认 5，超大夹到 50），不许把「随便给个数」变成全表扫描。
const clampDb = V.getDb(logWs, '.dsh-meow')
const zeroRows = clampDb.recentDreams(0)
const hugeRows = clampDb.recentDreams(9999)
check(
  'H6 limit 自己收紧：0 走默认 5、超大夹到 50（不把整本账一次拖出来）',
  zeroRows.length <= 5 && hugeRows.length <= 50 && zeroRows.length >= 1,
  `0→${zeroRows.length} 条 / 9999→${hugeRows.length} 条`,
)

// I 段（0.2.99）：正在整理的那一轮——读的是活 lease + dreamdigest meta，不是账本。
const liveWs = mkdtempSync(join(tmpdir(), 'ruler-live-'))
const liveDb = V.getDb(liveWs, '.dsh-meow')
const I0 = V.readLiveDream(liveWs, '.dsh-meow')
check(
  'I0 建了库但没在整理：一个会话都不报，不是「读不出来」',
  I0.missing === '' && I0.sessionIds.length === 0 && Object.keys(I0.plans).length === 0,
  `missing="${I0.missing}" ids=${I0.sessionIds.length}`,
)

const liveDigest = { rounds: 2, groups: 2, rows: 3, dup: 1, cover: 1, missing: 2, projects: ['probe'] }
liveDb.setDreamMeta('dreamdigest:sess-live', JSON.stringify(liveDigest))
liveDb.claimDream('sess-live', `owner-live-${process.pid}`, Date.now(), 120000)
const I1 = V.readLiveDream(liveWs, '.dsh-meow')
check(
  'I1 有活 lease：报出会话 id，并且把它那份 dreamdigest 一起念出来',
  I1.sessionIds.length === 1 && I1.sessionIds[0] === 'sess-live' && I1.plans['sess-live']?.rows === 3,
  `ids=${I1.sessionIds.join(',')} rows=${I1.plans['sess-live']?.rows}`,
)

// 阴性对照：lease 过期就不算「正在整理」，别把昨天那次说成现在跑的
liveDb.releaseDream('sess-live')
const I2 = V.readLiveDream(liveWs, '.dsh-meow')
check(
  'I2 lease 放掉之后立刻不再报（不把历史整理当现在进行时）',
  I2.sessionIds.length === 0,
  `ids=${I2.sessionIds.length}`,
)

// 只有 lease、没有 digest：该报会话，但不许凭空编规模
liveDb.claimDream('sess-noplan', `owner-noplan-${process.pid}`, Date.now(), 120000)
const I3 = V.readLiveDream(liveWs, '.dsh-meow')
check(
  'I3 只有 lease 没有 digest：报会话但 plans 为空（不编规模）',
  I3.sessionIds.includes('sess-noplan') && I3.plans['sess-noplan'] === undefined,
  `ids=${I3.sessionIds.join(',')} plan=${String(I3.plans['sess-noplan'])}`,
)

// 三种来路必须分开：没工作区 / 没库 / 读不开
const I4a = V.readLiveDream('', '.dsh-meow')
const I4b = V.readLiveDream(join(tmpdir(), `no-such-ws-${process.pid}`), '.dsh-meow')
check(
  'I4 没工作区与没建库分开说（不合成一句「没有在整理」）',
  I4a.missing === 'no-workspace' && I4b.missing === 'no-db',
  `a="${I4a.missing}" b="${I4b.missing}"`,
)

// collectDreamStates 新加的一列：正在整理的那一轮带 plan，老字段一个不少
liveDb.claimDream('sess-live', `owner-live2-${process.pid}`, Date.now(), 120000)
const states = V.collectDreamStates([{ id: 'sess-live', cwd: liveWs }], '.dsh-meow')
check(
  'I5 collectDreamStates 多一列 plans：老字段 dreamed/dreaming 还在，整理中的会话带 rows',
  Array.isArray(states.dreamed) &&
    Array.isArray(states.dreaming) &&
    states.dreaming.includes('sess-live') &&
    states.plans['sess-live']?.rows === 3,
  `dreamed=${states.dreamed.length} dreaming=${states.dreaming.join(',')} plans=${JSON.stringify(states.plans['sess-live'] ?? null)}`,
)

// J 段（0.2.100）：账本分页与单条展开的底座——「第 k 近」是唯一对外的编号口径。
const pageWs = mkdtempSync(join(tmpdir(), 'ruler-page-'))
const pageDb = V.getDb(pageWs, '.dsh-meow')
for (let i = 1; i <= 7; i += 1) {
  pageDb.logDream(`window dream done: sess-p${i} stamped=true`, {
    stamped: true,
    plan: { rounds: 1, groups: 1, rows: i, dup: 0, cover: 0, missing: 0, projects: ['p'] },
  }, '')
}
const J1 = V.readDreamLedger(pageWs, '.dsh-meow', 5, 0)
check(
  'J1 第一页：给 5 条、总数照实说（total 不是「这一页几条」）',
  J1.rows.length === 5 && J1.total === 7 && J1.rows[0].changes?.plan?.rows === 7,
  `${J1.rows.length} 条 · total=${J1.total}`,
)
const J2 = V.readDreamLedger(pageWs, '.dsh-meow', 5, 5)
check(
  'J2 第二页：只剩 2 条，且接着第一页往后读（不重不漏）',
  J2.rows.length === 2 && J2.rows[0].changes?.plan?.rows === 2 && J2.total === 7,
  `${J2.rows.length} 条 · 首行 rows=${J2.rows[0]?.changes?.plan?.rows}`,
)
const J3 = V.getDb(pageWs, '.dsh-meow')
const J3rows = J3.recentDreamsPage(3, 0)
check(
  'J3 分页上限自己收紧（0 走默认 5、超大夹到 50、offset 负数当 0）',
  J3.recentDreamsPage(0, 0).length === 5 && J3.recentDreamsPage(9999, 0).length === 7 && J3.recentDreamsPage(3, -5).length === 3,
  `0→${J3.recentDreamsPage(0, 0).length} 9999→${J3.recentDreamsPage(9999, 0).length} -5→${J3.recentDreamsPage(3, -5).length}`,
)
check('J3 行里带内部句柄 id，但面板对外只讲「第几近」', J3rows.every((r) => Number.isInteger(r.id) && r.id > 0), `ids=${J3rows.map((r) => r.id).join(',')}`)

const J4 = V.readDreamRecord(pageWs, '.dsh-meow', 2)
check(
  'J4 展开第 2 近：row 是它、prev 是更早的第 3 近（差要跟谁比有出处）',
  J4.missing === '' && J4.row?.changes?.plan?.rows === 6 && J4.prev?.changes?.plan?.rows === 5 && J4.total === 7,
  `row=${J4.row?.changes?.plan?.rows} prev=${J4.prev?.changes?.plan?.rows} total=${J4.total}`,
)
const J5 = V.readDreamRecord(pageWs, '.dsh-meow', 99)
check(
  'J5 要第 99 近：missing=no-row 并报出总数（不是「账本读不出来」）',
  J5.missing === 'no-row' && J5.row === null && J5.total === 7,
  `missing="${J5.missing}" total=${J5.total}`,
)
const J6 = V.readDreamRecord('', '.dsh-meow', 1)
const J6b = V.readDreamRecord(join(tmpdir(), `no-such-page-ws-${process.pid}`), '.dsh-meow', 1)
check(
  'J6 展开也是三态分开：没工作区 / 没建库（不合并成「没有这一条」）',
  J6.missing === 'no-workspace' && J6b.missing === 'no-db',
  `a="${J6.missing}" b="${J6b.missing}"`,
)

// K 段（0.2.101）：按项目段翻账——项目名在 changes.plan.projects 里，筛在 SQL 里做，数也一起筛。
const projWs = mkdtempSync(join(tmpdir(), 'ruler-proj-'))
const projDb = V.getDb(projWs, '.dsh-meow')
projDb.logDream('window dream done: sess-a stamped=true', { stamped: true, plan: { rounds: 1, rows: 1, dup: 0, cover: 0, missing: 0, projects: ['Alpha', 'Beta'] } }, 'a')
projDb.logDream('window dream done: sess-b stamped=true', { stamped: true, plan: { rounds: 1, rows: 2, dup: 0, cover: 0, missing: 0, projects: ['Alpha'] } }, 'b')
projDb.logDream('window dream done: sess-c stamped=true', { stamped: true, plan: { rounds: 1, rows: 3, dup: 0, cover: 0, missing: 0, projects: [] } }, 'c')
projDb.logDream('window dream done: sess-d stamped=true', { stamped: true, groups: 1 }, 'd')
projDb.logDream('window dream done: sess-e stamped=true', { stamped: true, plan: { rounds: 1, rows: 5, dup: 0, cover: 0, missing: 0, projects: ['Alpha'] } }, 'e')
const K1 = V.readDreamLedger(projWs, '.dsh-meow', 10, 0, 'Alpha')
check(
  'K1 按项目筛：行只剩 Alpha 那几条，total 也是筛后的数（不是全账本 5 条）',
  K1.rows.length === 3 && K1.total === 3 && K1.rows.every((r) => r.changes.plan.projects.includes('Alpha')),
  `rows=${K1.rows.length} total=${K1.total}`,
)
const K2 = V.readDreamLedger(projWs, '.dsh-meow', 10, 0, '')
check(
  'K2 不传项目：全账本 5 条都在（筛是加法，不改老口径）',
  K2.rows.length === 5 && K2.total === 5,
  `rows=${K2.rows.length} total=${K2.total}`,
)
const K3 = V.getDb(projWs, '.dsh-meow').dreamProjects(5)
check(
  'K3 项目分布：Alpha 3 次 / Beta 1 次，按次数降序；空数组与坏行不进分布',
  K3.items.length === 2 && K3.items[0].project === 'Alpha' && K3.items[0].n === 3 && K3.items[1].project === 'Beta' && K3.items[1].n === 1 && K3.total === 2,
  JSON.stringify(K3),
)
const K4 = V.getDb(projWs, '.dsh-meow').dreamProjects(1)
check(
  'K4 只列 1 个：total 仍报一共几个项目（「没列」不等于「没有」）',
  K4.items.length === 1 && K4.total === 2,
  `items=${K4.items.length} total=${K4.total}`,
)
const K5 = V.readDreamLedger(projWs, '.dsh-meow', 10, 0, 'Gamma')
check(
  'K5 筛一个不存在的项目：0 条、total=0，但不是 missing（账本在，只是没有这一段）',
  K5.rows.length === 0 && K5.total === 0 && K5.missing === '',
  `rows=${K5.rows.length} total=${K5.total} missing="${K5.missing}"`,
)
const K6 = V.readDreamProjects('', '.dsh-meow', 5)
const K6b = V.readDreamProjects(join(tmpdir(), `no-such-proj-ws-${process.pid}`), '.dsh-meow', 5)
check(
  'K6 项目分布也是三态分开：没工作区 / 没建库（不合并成「没有项目段」）',
  K6.missing === 'no-workspace' && K6b.missing === 'no-db',
  `a="${K6.missing}" b="${K6b.missing}"`,
)
const K7 = V.getDb(projWs, '.dsh-meow').recentDreamsPage(1, 0, 'Alpha')
check(
  'K7 分页也在 SQL 里筛：第一页就给最新那条 Alpha（不是先取全账本再挑）',
  K7.length === 1 && K7[0].changes.plan.rows === 5,
  `rows=${K7[0]?.changes?.plan?.rows}`,
)

// L 段（0.2.102）：落库的那份摘要本身——项目存名字（不是个数）、对子存明细。
// 为什么必须有这一段：0.2.101 的 K 段是手写 changes 造账，恰好写成了数组，于是「写侧存的是个数字」
// 这个真问题一次都没被扫到。这里直接调真 writer（dreamPlanDigest），从源头验。
const digWs = mkdtempSync(join(tmpdir(), 'ruler-digest-'))
const digDb = V.getDb(digWs, '.dsh-meow')
const mkRow = (id, level, content) => ({ id, level, content })
const dupOne = '默认用 pnpm 装依赖 不要混用 npm 和 yarn 锁文件只提交一个'
const dupTwo = '默认用 pnpm 装依赖 不要混用 npm 和 yarn 锁文件只提交一个副本'
const shortRow = mkRow('aaaa1111zz', 'topic', '探针里不要用 ^ 锚定面板首行 因为首行是抬头')
const longRow = mkRow('aaaa2222zz', 'fact', '探针里不要用 ^ 锚定面板首行 因为首行是抬头 否则断言必然打红 改密集块要带前后锚点')
const digRounds = [
  { kind: 'atomic', groups: [{ name: '', rows: [mkRow('cccc0001aa', 'fact', dupOne), mkRow('cccc0002aa', 'fact', dupTwo)] }], projects: ['Alpha', 'Beta'] },
  { kind: 'topic', groups: [{ name: 't', rows: [shortRow, longRow] }], projects: ['Alpha'] },
]
const L1 = V.dreamPlanDigest(digRounds)
check(
  'L1 写侧的摘要：projects 是名字数组（去重保序），个数另存 projectCount',
  Array.isArray(L1.projects) && L1.projects.join(',') === 'Alpha,Beta' && L1.projectCount === 3,
  `projects=${JSON.stringify(L1.projects)} projectCount=${L1.projectCount}`,
)
check(
  'L2 名字不再是数字：typeof projects 是 object（0.2.101 按名字筛账靠的就是这一条）',
  typeof L1.projects !== 'number' && L1.projects.length === 2,
  typeof L1.projects,
)
check(
  'L3 对子带明细：dup 一对、cover 一对，短 id 与清单同一套、两边层级都念出来',
  L1.pairs.length === 2 &&
    L1.pairs[0].kind === 'dup' &&
    L1.pairs[0].a === 'cccc0001' &&
    L1.pairs[0].levelA === 'fact' &&
    L1.pairs[1].kind === 'cover' &&
    L1.pairs[1].levelA === 'topic' &&
    L1.pairs[1].levelB === 'fact',
  JSON.stringify(L1.pairs),
)
check(
  'L4 重复详写对带「会丢几个词」的材料（合并时最容易被扔掉的就是这些词）',
  L1.pairs[1].missing === 0 && Array.isArray(L1.pairs[1].words),
  `missing=${L1.pairs[1].missing} words=${JSON.stringify(L1.pairs[1].words)}`,
)
// 7 条几乎一样的行 = 21 对；清单只印 5 对，摘要里的「几对」不许跟着被截断。
const manyRows = Array.from({ length: 7 }, (_, i) => mkRow(`dddd000${i}aa`, 'fact', `${dupOne} 第${i}份`))
const L5 = V.dreamPlanDigest([{ kind: 'atomic', groups: [{ name: '', rows: manyRows }], projects: [] }])
check(
  'L5 「这一轮撞上几对」是真数（21），存下来的明细才受上限（≤6）：数不被截断冒充',
  L5.dup === 21 && L5.pairs.length === 6 && L5.pairs.every((p) => p.kind === 'dup'),
  `dup=${L5.dup} pairs=${L5.pairs.length}`,
)
const L6 = V.dreamPlanDigest([])
check(
  'L6 空清单：全是 0，projects / pairs 是空数组（不是 undefined——读的人不用先判空）',
  L6.rows === 0 && L6.dup === 0 && Array.isArray(L6.projects) && L6.projects.length === 0 && Array.isArray(L6.pairs) && L6.pairs.length === 0,
  JSON.stringify(L6),
)
digDb.logDream('window dream done: sess-new stamped=true', { stamped: true, groups: 2, plan: L1 }, 'new')
digDb.logDream('window dream done: sess-legacy stamped=true', { stamped: true, groups: 1, plan: { rounds: 1, groups: 1, rows: 3, dup: 0, cover: 0, missing: 0, projects: 2 } }, 'legacy')
const L7 = V.readDreamLedger(digWs, '.dsh-meow', 10, 0, 'Alpha')
const L7b = V.getDb(digWs, '.dsh-meow').dreamProjects(5)
check(
  'L7 从写侧到 SQL 一路通：真摘要落库后按名字筛得到（0.2.101 漏的就是这一环），旧数字账不进分布',
  L7.total === 1 &&
    L7.rows[0].changes.plan.pairs.length === 2 &&
    L7b.items.length === 2 &&
    L7b.items.every((it) => typeof it.project === 'string'),
  `total=${L7.total} items=${JSON.stringify(L7b.items)}`,
)
const L8 = V.readDreamLedger(digWs, '.dsh-meow', 10, 0, '2')
check(
  'L8 老账本里那个「2」不是项目名：按 "2" 筛不到它（数字不许冒充文本）',
  L8.total === 0,
  `total=${L8.total}`,
)

// M 段（0.2.103）：库规模——账本原来只记「翻了几条」，不记「库有多大」。
// 这一段从真库数起（insert 真行、status 真值），再从真开工流程里读回落库的那一份。
const scaleWs = mkdtempSync(join(tmpdir(), 'ruler-scale-'))
const scaleDb = V.getDb(scaleWs, '.dsh-meow')
scaleDb.insert({ level: 'fact', content: '库规模探针：一条在用事实', keywords: ['probe', 'scale'] })
scaleDb.insert({ level: 'fact', content: '库规模探针：一条已归档事实', keywords: ['probe', 'scale'], status: 'archived' })
scaleDb.insert({ level: 'topic', content: '库规模探针：一条在用主题', keywords: ['probe', 'scale'] })
scaleDb.insert({ level: 'lesson', content: '库规模探针：一条已过时教训', keywords: ['probe', 'scale'], status: 'stale' })
const L9 = V.dreamStoreScale(scaleDb)
check(
  'L9 库规模只数 status=active（归档/过时的账挂在 status 上，不该混进「库有多大」）',
  L9.active === 2 && L9.byLevel.fact === 1 && L9.byLevel.topic === 1 && L9.byLevel.lesson === undefined,
  JSON.stringify(L9),
)
const emptyScale = V.dreamStoreScale(V.getDb(mkdtempSync(join(tmpdir(), 'ruler-scale-empty-')), '.dsh-meow'))
check(
  'L10 空库：active=0 且 byLevel 是空对象（不是 undefined 让人先判空，也不是一排 0 让人以为空层也算数）',
  emptyScale.active === 0 && typeof emptyScale.byLevel === 'object' && Object.keys(emptyScale.byLevel).length === 0,
  JSON.stringify(emptyScale),
)
// 真开工那一步：store 要跟着 digest 一起落进 dream_meta（面板读的就是这一份），不另算一遍。
const scaleDreamWs = mkdtempSync(join(tmpdir(), 'ruler-scale-dream-'))
const scaleExec = execIn(scaleDreamWs, 'sess-ruler-scale-dream')
await call('memory_remember', { content: '库规模探针：真开工前的一条事实', level: 'fact', keywords: ['probe', 'scale'], importance: 1, project: '全局' }, scaleExec)
await call('memory_remember', { content: '库规模探针：真开工前的一条主题', level: 'topic', title: '库规模探针', keywords: ['probe', 'scale'], importance: 1, project: '全局' }, scaleExec)
const scaleTrace = { reason: '' }
V.startWindowDream({}, scaleExec.agent, scaleDreamWs, '.dsh-meow', undefined, 0, scaleTrace)
const scaleMeta = V.getDb(scaleDreamWs, '.dsh-meow').getDreamMeta('dreamdigest:sess-ruler-scale-dream')
const scaleStored = typeof scaleMeta === 'string' ? JSON.parse(scaleMeta) : {}
check(
  'L11 真开工：库规模跟着摘要一起进 dream_meta（trace 与落库同一份，不各自数一次）',
  scaleTrace.digest?.store?.active === 2 &&
    scaleStored.store?.active === 2 &&
    scaleStored.store?.byLevel?.fact === 1 &&
    scaleStored.store?.byLevel?.topic === 1,
  `trace=${JSON.stringify(scaleTrace.digest?.store)} meta=${JSON.stringify(scaleStored.store)}`,
)

// N 段（0.2.104）：账本行的稳定引用——「第几近」会随新账往下挪，dream_log.id 不挪。
// 这一段的核心动作是「先记住引用，再让账本往前走一格」，然后验证引用还指着同一条、编号已经变了。
const refWs = mkdtempSync(join(tmpdir(), 'ruler-ref-'))
const refDb = V.getDb(refWs, '.dsh-meow')
const refPlan = (project, dup) => ({
  rounds: 1,
  rows: 2,
  dup,
  cover: 0,
  missing: 0,
  projects: [project],
  projectCount: 1,
  pairs: [],
  store: { active: 1, byLevel: { fact: 1 } },
})
refDb.logDream('收尾：第一条账', { plan: refPlan('Alpha', 1), stamped: true }, '')
const refPage = refDb.recentDreamsPage(5, 0)
const refId = refPage[0].id
const refRunAt = refPage[0].runAt
const rankBefore = refDb.dreamRankOf(refId)
refDb.logDream('收尾：第二条账', { plan: refPlan('Beta', 2), stamped: true }, '')
const rankAfter = refDb.dreamRankOf(refId)
const refRow = refDb.dreamById(refId)
check(
  'L12 引用不挪、编号会挪：同一行记下 r<N> 之后又跑一轮，它的第几近从 1 变 2，而 dreamById 取回的仍是同一条（runAt 一致）',
  refId > 0 && rankBefore === 1 && rankAfter === 2 && refRow !== null && refRow.runAt === refRunAt,
  `id=${refId} before=${rankBefore} after=${rankAfter} runAt=${refRunAt}/${refRow?.runAt}`,
)
const refRead = V.readDreamRecordByRef(refWs, '.dsh-meow', refId)
const refMiss = V.readDreamRecordByRef(refWs, '.dsh-meow', 999999)
check(
  'L13 按引用读一条：row.id 就是那个引用、rank 是它此刻的第几近；引用不存在时 missing=no-row（不拿「读不到」冒充「账本空」）',
  refRead.missing === '' &&
    refRead.row?.id === refId &&
    refRead.rank === 2 &&
    refRead.total === 2 &&
    refMiss.missing === 'no-row' &&
    refMiss.total === 2 &&
    refMiss.row === null,
  `read=${refRead.missing}/${refRead.row?.id}/rank=${refRead.rank} miss=${refMiss.missing}/${refMiss.total}`,
)
const refZero = V.readDreamRecordByRef(refWs, '.dsh-meow', 0)
check(
  'L14 引用 0 / 非数字不猜行：一律 no-row，不去取「最新那条」凑一个结果（猜出来的引用比没有引用更坏）',
  refZero.missing === 'no-row' && refZero.row === null,
  `missing=${refZero.missing}`,
)

// O 段（0.2.105）：按日期筛账——闭区间、本机时区、行与总数同一把筛子。
// 这一段不用 logDream（它写的是「现在」），直接插 run_at，才量得出边界：
// 18 号 00:00:00.000 要算进来、18 号 23:59:59.999 要算进来、19 号 00:00:00.000 要挡在外面。
const spanWs = mkdtempSync(join(tmpdir(), 'ruler-span-'))
const spanDb = V.getDb(spanWs, '.dsh-meow')
const spanIns = spanDb.db.prepare('INSERT INTO dream_log (run_at, summary, changes, note) VALUES (?, ?, ?, ?)')
const spanPlan = (project) => JSON.stringify({ plan: { projects: [project], rounds: [], pairs: { dup: 0, cover: 0 }, words: [] } })
const day18 = new Date(2026, 10, 18, 0, 0, 0, 0).getTime()
const day19 = day18 + 86400000
spanIns.run(day18 - 1, 'window dream done: before', spanPlan('Alpha'), '')
spanIns.run(day18, 'window dream done: start', spanPlan('Beta'), '')
spanIns.run(day18 + 43200000, 'window dream done: noon', spanPlan('Alpha'), '')
spanIns.run(day19 - 1, 'window dream done: end', spanPlan('Alpha'), '')
spanIns.run(day19, 'window dream done: after', spanPlan('Beta'), '')
const spanRows = spanDb.recentDreamsPage(10, 0, '', day18, day19 - 1)
const spanCount = spanDb.dreamCountOf('', day18, day19 - 1)
const spanOneDay = spanDb.recentDreamsPage(10, 0, '', day18, day18 + 1)
check(
  'L15 日期是闭区间：00:00:00.000 与 23:59:59.999 都在里面，前 1 毫秒、后 1 毫秒都在外面；条数（3）与行数一致',
  spanRows.length === 3 && spanCount === 3 && spanRows.every((r) => r.runAt >= day18 && r.runAt <= day19 - 1) && spanOneDay.length === 1,
  `rows=${spanRows.length} count=${spanCount} oneDay=${spanOneDay.length} at=${spanRows.map((r) => r.runAt).join(',')}`,
)
const spanProj = spanDb.dreamCountOf('Alpha', day18, day19 - 1)
const spanOnlyProj = spanDb.dreamCountOf('Alpha')
const spanNothing = spanDb.dreamCountOf('', day19 + 1, day19 + 86400000)
check(
  'L16 时间与项目段叠着筛：Alpha 在 18 号只有 2 条、全账本 3 条；筛到没账的区间是 0（不是回退成全账本）',
  spanProj === 2 && spanOnlyProj === 3 && spanNothing === 0,
  `proj=${spanProj} onlyProj=${spanOnlyProj} nothing=${spanNothing}`,
)
const spanGot = V.readDreamSpan(spanWs, '.dsh-meow')
check(
  'L17 账本覆盖范围：first / last 就是最早与最新那条的时间（筛空了要靠它说「这段里没有」，不是「账本里没有」）',
  spanGot.missing === '' && spanGot.first === day18 - 1 && spanGot.last === day19,
  `missing=${spanGot.missing} first=${spanGot.first - day18} last=${spanGot.last - day18}`,
)

// P 段（0.2.106）：收尾那一刻也数一次库规模——只念开工那一眼，就永远算不出「这一轮让库变轻还是变重」。
// 差要能被「加两条、归档一条」算成 +1（净变化），而不是「新写了几条」（2）。
const endWs = mkdtempSync(join(tmpdir(), 'ruler-storeend-'))
const endExec = execIn(endWs, 'sess-ruler-storeend')
const endAgent = { ...endExec.agent, followup() {} }
await call('memory_remember', { content: '收尾规模探针：开工前的一条事实', level: 'fact', keywords: ['probe', 'storeend'], importance: 1, project: '全局' }, { agent: endAgent })
await call('memory_remember', { content: '收尾规模探针：开工前的一条主题', level: 'topic', title: '收尾规模探针', keywords: ['probe', 'storeend'], importance: 1, project: '全局' }, { agent: endAgent })
const endTrace = { reason: '' }
V.startWindowDream({}, endAgent, endWs, '.dsh-meow', undefined, 0, endTrace)
const endDb = V.getDb(endWs, '.dsh-meow')
await call('memory_remember', { content: '收尾规模探针：整理中新写的事实', level: 'fact', keywords: ['probe', 'storeend'], importance: 1, project: '全局' }, { agent: endAgent })
await call('memory_remember', { content: '收尾规模探针：整理中新写的教训', level: 'lesson', keywords: ['probe', 'storeend'], importance: 1, project: '全局', corrected: true }, { agent: endAgent })
const endTopic = endDb.db.prepare("SELECT id FROM topic WHERE status = 'active' LIMIT 1").get()
endDb.update('topic', String(endTopic?.id), { status: 'archived' })
V.advanceDream(endAgent, '.dsh-meow', undefined, 0)
V.advanceDream(endAgent, '.dsh-meow', undefined, 0)
const endRow = endDb.recentDreamsPage(1, 0)[0]
const endPlan = endRow?.changes?.plan
check(
  'L18 收尾也数一次：开工 2 条 → 收尾 3 条，落库日志带 store=2->3（两个点都进 changes，不靠事后重算）',
  endTrace.digest?.store?.active === 2 &&
    endPlan?.storeEnd?.active === 3 &&
    endPlan?.store?.active === 2 &&
    String(endRow?.summary ?? '').includes('store=2->3'),
  `trace=${endTrace.digest?.store?.active} store=${endPlan?.store?.active} end=${endPlan?.storeEnd?.active} summary=${endRow?.summary}`,
)
check(
  'L19 差是净变化，不是「新写了几条」：+2 新写 -1 归档 落成 +1；归档的层不进收尾层数',
  endPlan?.storeDelta === 1 && endPlan?.storeEnd?.byLevel?.fact === 2 && endPlan?.storeEnd?.byLevel?.lesson === 1 && endPlan?.storeEnd?.byLevel?.topic === undefined,
  `delta=${endPlan?.storeDelta} byLevel=${JSON.stringify(endPlan?.storeEnd?.byLevel)}`,
)
const endOldWs = mkdtempSync(join(tmpdir(), 'ruler-storeend-old-'))
const endOldDb = V.getDb(endOldWs, '.dsh-meow')
endOldDb.logDream('老账：只记了开工', { stamped: 1, plan: { rows: 1, dup: 0, cover: 0, missing: 0, store: { active: 2, byLevel: { fact: 2 } } } }, '')
const endOldRow = endOldDb.recentDreamsPage(1, 0)[0]
check(
  'L20 老账不补收尾数：0.2.106 之前写的账 storeEnd / storeDelta 都没有（宁可没有，不许补 0 让人以为库清零了）',
  endOldRow?.changes?.plan?.store?.active === 2 &&
    endOldRow?.changes?.plan?.storeEnd === undefined &&
    endOldRow?.changes?.plan?.storeDelta === undefined,
  `store=${endOldRow?.changes?.plan?.store?.active} end=${String(endOldRow?.changes?.plan?.storeEnd)}`,
)

// Q 段（0.2.107）：收尾方式落成结构化 changes.kind。
// 以前只有摘要首词能分辨「跑完了」和「半路停下」，组数只有分子没有分母；
// 补记账和被封存的账更惨——它们没有 plan，于是被一律念成「比 0.2.96 早」，把 0.2.96 之后的账说成更早的账，
// 其中「连续失败被止损封存」那支连账本都不落，只在 dream-debug.log 里留一句。
const qAgent = (ws, id) => {
  const exec = execIn(ws, id)
  const agent = { ...exec.agent, followup() {} }
  return { ws, id, agent }
}
const qSeed = async (agent, tag) => {
  await call(
    'memory_remember',
    { content: `收尾方式探针 ${tag}：发版前先备份到 D 盘，出问题先还原备份再排查。`, level: 'fact', keywords: ['probe', 'kind', tag, 'backup', 'restore', 'rollback', 'release', 'ops', 'discipline'], importance: 1, project: '全局' },
    { agent },
  )
  await call(
    'memory_remember',
    { content: `收尾方式探针 ${tag}：半路停下的一轮不能算跑完的轮，数字只是扫到那儿的中间值。`, level: 'fact', keywords: ['probe', 'kind', tag, 'groups', 'abort', 'seal', 'recover', 'ledger'], importance: 1, project: '全局' },
    { agent },
  )
}

const qAbort = qAgent(mkdtempSync(join(tmpdir(), 'ruler-kind-abort-')), 'sess-ruler-kind-abort')
await qSeed(qAbort.agent, 'abort')
V.startWindowDream({}, qAbort.agent, qAbort.ws, '.dsh-meow', undefined, 0, { reason: '' })
const qAbortDb = V.getDb(qAbort.ws, '.dsh-meow')
V.advanceDream(qAbort.agent, '.dsh-meow', undefined, 0)
V.abortDream(qAbort.agent, '.dsh-meow', undefined)
const qAbortRow = qAbortDb.recentDreamsPage(1, 0)[0]
const qAbortKind = qAbortRow?.changes?.kind
check(
  'L21 中途放弃落结构化 kind：走完几组 / 本来几组都有（分子分母都在账本里，不靠摘要猜）',
  qAbortKind?.kind === 'aborted' &&
    qAbortKind?.groupsDone === 1 &&
    qAbortKind?.groupsTotal === 2 &&
    String(qAbortRow?.summary ?? '').includes('groups=1/2'),
  `kind=${JSON.stringify(qAbortKind)} summary=${qAbortRow?.summary}`,
)

const qRec = qAgent(mkdtempSync(join(tmpdir(), 'ruler-kind-recovered-')), 'sess-ruler-kind-recovered')
await qSeed(qRec.agent, 'recovered')
V.startWindowDream({}, qRec.agent, qRec.ws, '.dsh-meow', undefined, 0, { reason: '' })
const qRecDb = V.getDb(qRec.ws, '.dsh-meow')
V.advanceDream(qRec.agent, '.dsh-meow', undefined, 0)
V.recoverInterruptedDream(qRecDb, qRec.id, qRec.ws, '.dsh-meow')
const qRecRow = qRecDb.recentDreamsPage(1, 0)[0]
check(
  'L22 被打断后补记：kind=recovered 且写了走完几组（补记账也要能答「补到哪儿了」）',
  qRecRow?.changes?.kind?.kind === 'recovered' &&
    qRecRow?.changes?.kind?.groupsDone === 1 &&
    qRecRow?.changes?.groups === 1,
  `kind=${JSON.stringify(qRecRow?.changes?.kind)} groups=${qRecRow?.changes?.groups}`,
)

// 失败计数按「同一整理范围 T」累加，T 就是窗口的 last_event_time：先立窗口再开工，否则每次都算新范围。
const qSeal = qAgent(mkdtempSync(join(tmpdir(), 'ruler-kind-sealed-')), 'sess-ruler-kind-sealed')
await qSeed(qSeal.agent, 'sealed')
const qSealDb = V.getDb(qSeal.ws, '.dsh-meow')
qSealDb.touchWindow(qSeal.id, qSeal.ws, Date.now() - 60000)
const qRets = []
for (let i = 0; i < 3; i++) {
  V.startWindowDream({}, qSeal.agent, qSeal.ws, '.dsh-meow', undefined, 0, { reason: '' })
  qRets.push(V.handleMemoryTurnFailure(qSealDb, qSeal.id, qSeal.ws, '.dsh-meow'))
}
const qSealRow = qSealDb.recentDreamsPage(1, 0)[0]
check(
  'L23 连续失败达上限也进账本：kind=sealed + fails=3（以前只写 dream-debug.log，面板上像没整理过）',
  qRets[0] === 'released' &&
    qRets[1] === 'released' &&
    qRets[2] === 'sealed' &&
    qSealRow?.changes?.kind?.kind === 'sealed' &&
    qSealRow?.changes?.kind?.fails === 3,
  `rets=${qRets.join(',')} kind=${JSON.stringify(qSealRow?.changes?.kind)}`,
)

const qGive = qAgent(mkdtempSync(join(tmpdir(), 'ruler-kind-gaveup-')), 'sess-ruler-kind-gaveup')
const qGiveDb = V.getDb(qGive.ws, '.dsh-meow')
qGiveDb.touchWindow(qGive.id, qGive.ws, Date.now() - 60000)
for (let i = 0; i < 3; i++) V.recoverInterruptedDream(qGiveDb, qGive.id, qGive.ws, '.dsh-meow')
const qGiveRow = qGiveDb.recentDreamsPage(1, 0)[0]
check(
  'L24 连续没进展被封存：kind=gaveup + 失败次数都在账里（一组都没走完也要留痕）',
  qGiveRow?.changes?.kind?.kind === 'gaveup' &&
    qGiveRow?.changes?.kind?.fails === 3 &&
    String(qGiveRow?.summary ?? '').includes('fails=3'),
  `kind=${JSON.stringify(qGiveRow?.changes?.kind)}`,
)

// Q 段（0.2.108）：层走向要按层数，所以先把写侧的层口径钉死——
// 它数的是 status='active'，而且零层不写进 byLevel（读侧的「缺层 = 那一轮那层 0 条」全靠这条）。
const qScale = qAgent(mkdtempSync(join(tmpdir(), 'ruler-level-scale-')), 'sess-ruler-level-scale')
// 两条 fact 的内容与关键词都刻意错开：写侧有去重，长得像的两条会被合成一条，
// 探针就验不出「同一层里两条是两条」了。
await call(
  'memory_remember',
  { content: '层规模探针甲：占住事实层第一个格子，用来验证按层计数时它算一条。', level: 'fact', keywords: ['probe', 'level', 'alpha', 'ledger', 'bylevel', 'drift', 'store', 'scale', 'trend'], importance: 1, project: '全局' },
  { agent: qScale.agent },
)
await call(
  'memory_remember',
  { content: '另一条完全不相干的事实：层走向只关心每层有几条在用，不在乎这些条目讲的是什么故事，所以这条写点别的。', level: 'fact', keywords: ['probe', 'level', 'beta', 'snapshot', 'counter', 'store', 'ledger', 'trend', 'drift'], importance: 1, project: '全局' },
  { agent: qScale.agent },
)
await call(
  'memory_remember',
  { content: '层走向探针三：教训层只有一条，用来验证跨层不像跨项目那样串味。', level: 'lesson', keywords: ['probe', 'level', 'lesson', 'bylevel', 'drift', 'scale', 'ledger', 'trend'], importance: 1, project: '全局', corrected: true },
  { agent: qScale.agent },
)
const qScaleDb = V.getDb(qScale.ws, '.dsh-meow')
const qScale1 = V.dreamStoreScale(qScaleDb)
check(
  'L25 层规模只数 status=active 且零层不写：fact 2 / lesson 1，没有写过的层不出现（缺层 = 0，不是「没记」）',
  qScale1.active === 3 &&
    qScale1.byLevel.fact === 2 &&
    qScale1.byLevel.lesson === 1 &&
    qScale1.byLevel.topic === undefined &&
    qScale1.byLevel.soul === undefined,
  `scale=${JSON.stringify(qScale1)}`,
)
const qScaleFact = qScaleDb.db.prepare("SELECT id FROM fact WHERE status = 'active' LIMIT 1").get()
qScaleDb.update('fact', String(qScaleFact?.id), { status: 'archived' })
const qScale2 = V.dreamStoreScale(qScaleDb)
check(
  'L26 归档立刻从层规模里掉出去：active 3 → 2，fact 2 → 1（按状态数，不是按行数）',
  qScale2.active === 2 && qScale2.byLevel.fact === 1 && qScale2.byLevel.lesson === 1,
  `scale=${JSON.stringify(qScale2)}`,
)

// Q 段（0.2.109）：回执成本的口径是「估算」，不是账单——所以先把它钉成一条可复算的尺子：
// 同一句话算两遍必须一样，中英混排不许按字符数糊过去，空串算 0。
const tok = await import(pathToFileURL(join(root, 'lib/macro/tokencost.js')).href)
check(
  'L27 估算口径可复算：CJK 一字 1、其余 4 字符 1，空串 0，两次一样',
  tok.estTokens('中文四个字') === 5 &&
    tok.estTokens('hello world') === 3 &&
    tok.estTokens('') === 0 &&
    tok.estTokens('中文') === tok.estTokens('中文') &&
    tok.estTokens('中文abc') === 2 + 1,
  `中文四个字=${tok.estTokens('中文四个字')} hello world=${tok.estTokens('hello world')} 中文abc=${tok.estTokens('中文abc')}`,
)
check(
  'L28 预算四态不压成一态：没给 / 不像数 / 太小 / 超上界 各说各的（装不下绝不假装装下）',
  tok.budgetOf(undefined).value === null &&
    tok.budgetOf(undefined).note === '' &&
    tok.budgetOf('abc').value === null &&
    tok.budgetOf('abc').note.includes('不是数字') &&
    tok.budgetOf(20).value === null &&
    tok.budgetOf(20).note.includes(`最小可用预算 ${tok.BUDGET_MIN}`) &&
    tok.budgetOf(30000).value === 20000 &&
    tok.budgetOf(30000).note.includes('超出上界') &&
    tok.budgetOf(400).value === 400 &&
    tok.budgetOf(400).note === '',
  JSON.stringify([tok.budgetOf('abc').note, tok.budgetOf(20).note, tok.budgetOf(30000).note]),
)

// Q 段（0.2.111）：项目规模要按项目数，所以先把写侧的项目口径钉死——
// 它跨五个带 project 列的层相加、按 status='active' 数、NULL 与空串不算一个项目、零不写进 byProject。
const qProj = qAgent(mkdtempSync(join(tmpdir(), 'ruler-project-scale-')), 'sess-ruler-project-scale')
await call(
  'memory_remember',
  { content: '项目规模探针甲：Alpha 项目的第一条事实，用来验证跨层按项目相加时它算进 Alpha。', level: 'fact', keywords: ['probe', 'project', 'byproject', 'alpha', 'ledger', 'scale', 'store', 'trend'], importance: 1, project: 'Alpha' },
  { agent: qProj.agent },
)
await call(
  'memory_remember',
  { content: '项目规模探针乙：Alpha 项目的第二条事实，关键词刻意与上一条错开，免得写侧去重把它们并成一条。', level: 'fact', keywords: ['probe', 'project', 'beta', 'snapshot', 'counter', 'store', 'ledger', 'byproject'], importance: 1, project: 'Alpha' },
  { agent: qProj.agent },
)
await call(
  'memory_remember',
  { content: '项目规模探针丙：这条落在教训层但同属 Alpha，用来验证跨层同名项目会相加而不是各算一行。', level: 'lesson', keywords: ['probe', 'project', 'lesson', 'byproject', 'drift', 'scale', 'ledger', 'trend'], importance: 1, project: 'Alpha', corrected: true },
  { agent: qProj.agent },
)
await call(
  'memory_remember',
  { content: '项目规模探针丁：Beta 项目的唯一一条主题，用来验证不同项目互不相加。', level: 'topic', keywords: ['probe', 'project', 'topic', 'beta', 'byproject', 'scale', 'goal', 'ledger'], importance: 1, project: 'Beta', goal: '验证按项目计数时不串味' },
  { agent: qProj.agent },
)
const qProjDb = V.getDb(qProj.ws, '.dsh-meow')
const qProj1 = V.dreamStoreScale(qProjDb)
check(
  'L29 项目规模跨五个带 project 的层相加、只数 active：Alpha 3（fact 2 + lesson 1）/ Beta 1；soul 与 user 没有归属不进这条数',
  qProj1.byProject?.Alpha === 3 &&
    qProj1.byProject?.Beta === 1 &&
    Object.keys(qProj1.byProject ?? {}).length === 2 &&
    qProj1.byLevel.fact === 2 &&
    qProj1.byLevel.lesson === 1 &&
    qProj1.byLevel.topic === 1,
  `scale=${JSON.stringify(qProj1)}`,
)
// 全局条目（project 为 NULL）不许占一个项目名，否则每个「全局」都会被算成一个项目。
const qProjGlobal = V.dreamStoreScale(V.getDb(qScale.ws, '.dsh-meow'))
check(
  'L30 没有项目归属的条目不算一个项目：全写「全局」的库里 byProject 里不出现 null / 空名',
  Object.keys(qProjGlobal.byProject ?? {}).every((k) => String(k).trim() !== '') &&
    !Object.prototype.hasOwnProperty.call(qProjGlobal.byProject ?? {}, 'null'),
  `scale=${JSON.stringify(qProjGlobal)}`,
)
const qProjTopic = qProjDb.db.prepare("SELECT id FROM topic WHERE status = 'active' LIMIT 1").get()
qProjDb.update('topic', String(qProjTopic?.id), { status: 'archived' })
const qProj2 = V.dreamStoreScale(qProjDb)
check(
  'L31 归档立刻从项目规模里掉出去：Beta 1 → 0（整个键消失，不是写成 0），Alpha 仍是 3',
  qProj2.byProject?.Beta === undefined && qProj2.byProject?.Alpha === 3 && qProj2.active === 3,
  `scale=${JSON.stringify(qProj2)}`,
)

// ═══ [macro-fusion 0.2.114] 疑似冲突对：同一件事写成两种说法 ═══
// 逐字重复与「摘要 + 全文」都抓不到的那一种病：正文差得够多（所以不算重复），
// 关键词却指着同一个主题，数字/版本彼此不同。断言写的是「差异摊得出来 + 判据不误报」。
const cfRow = (id, content, keywords, updated_at, status = 'active', level = 'fact') => ({
  id, level, content, keywords, updated_at, created_at: updated_at - 100, status,
})
const cfA = cfRow('cf000001aa', 'DSH 的记忆库在 C 盘的 .dsh 目录里，插件版本 0.1.x，配置文件也在 C 盘', ['DSH', '路径'], 1000)
const cfB = cfRow('cf000002bb', 'DSH 已经搬到 D 盘 dsh-home，插件版本 0.2.113，所有配置与插件数据都在 D 盘', ['DSH', '路径'], 2000)
const cfRounds = [{ kind: 'atomic', groups: [{ name: '', rows: [cfA, cfB] }], projects: ['Alpha'] }]
const cfDig = V.dreamPlanDigest(cfRounds)
const cfPair = cfDig.conflictPairs?.[0] ?? {}
check(
  'L32 同一主题写了不同版本：digest 记 1 对，差异（共用关键词 / 各自独有 / 谁更新）全部落账',
  cfDig.conflicts === 1 &&
    cfDig.dup === 0 && cfDig.cover === 0 &&
    cfPair.newer === 'b' && cfPair.onlyA?.includes('0.1') && cfPair.onlyB?.includes('0.2.113') &&
    Array.isArray(cfPair.shared) && cfPair.shared.length === 2 && cfPair.newerAt === 2000,
  `conflicts=${cfDig.conflicts} pair=${JSON.stringify(cfPair)}`,
)
// 阴性对照一：数字一致、只是换了说法 —— 那是复述，不许报成冲突（报了就会让整理去改本来对的条目）。
const cfC = cfRow('cf000003cc', '插件版本 0.2.113 装在 D 盘，配置文件也放在 D 盘的 dsh-home 下', ['DSH', '路径'], 3000)
const cfRestate = V.dreamPlanDigest([{ kind: 'atomic', groups: [{ name: '', rows: [cfB, cfC] }], projects: [] }])
check(
  'L33 阴性对照：数字一致而措辞不同的复述不算冲突',
  cfRestate.conflicts === 0,
  `conflicts=${cfRestate.conflicts} pair=${JSON.stringify(cfRestate.conflictPairs)}`,
)
// 阴性对照二：归档的那条不报——归档本身就是处置，再报一次只是催人做已经做过的事。
const cfArchived = V.dreamPlanDigest([{ kind: 'atomic', groups: [{ name: '', rows: [cfA, { ...cfB, status: 'archived' }] }], projects: [] }])
check(
  'L34 阴性对照：归档的那条不报冲突',
  cfArchived.conflicts === 0,
  `conflicts=${cfArchived.conflicts}`,
)
// 回执与清单：数字进回执（不用展开账才看见），清单里摊差异与判据；时间一样就说「分不出谁新」。
const cfReceipt = V.dreamReceipt(cfDig)
const cfMsg = (rounds, idx) => V.buildDreamMessage(null, 'sess', Date.now(), rounds, idx).content.map((c) => c.text ?? '').join('\n')
const cfBody = cfMsg(cfRounds, 0)
check(
  'L35 回执点出冲突对数，清单里标题 / 共用关键词 / 各自独有 / 判据四件都在',
  cfReceipt.includes('另有 1 对疑似冲突') &&
    cfBody.includes('【疑似冲突 1 对】') &&
    cfBody.includes('共用关键词：') &&
    cfBody.includes('  cf000001 独有 0.1') &&
    /→ cf000002 更新（\d{4}-\d{2}-\d{2} \d{2}:\d{2}）/.test(cfBody) &&
    cfBody.includes('措辞不同而数字一致的'),
  `receipt=${flat(cfReceipt)} body=${flat(cfBody.slice(cfBody.indexOf('【疑似冲突'), cfBody.indexOf('【疑似冲突') + 200))}`,
)
const cfTie = V.dreamPlanDigest([{ kind: 'atomic', groups: [{ name: '', rows: [cfA, { ...cfB, updated_at: 1000 }] }], projects: [] }])
const cfTieRounds = [{ kind: 'atomic', groups: [{ name: '', rows: [cfA, { ...cfB, updated_at: 1000 }] }], projects: [] }]
check(
  'L36 更新时间一模一样：newer=both，清单说「分不出谁新」而不是硬挑一条',
  cfTie.conflictPairs?.[0]?.newer === 'both' && cfMsg(cfTieRounds, 0).includes('分不出谁新'),
  `newer=${cfTie.conflictPairs?.[0]?.newer}`,
)
// 同一对跨轮（一条在 fact 轮、另一条在 topic 轮）只由先出现的那一轮负责说，别两轮各印一遍；
// 另一条不在本组清单里时要标「（另一组）」，否则整理时看不见对方会以为没这回事。
const cfCross = [
  { kind: 'atomic', groups: [{ name: '', rows: [cfA] }], projects: [] },
  { kind: 'topic', groups: [{ name: 't', rows: [cfB] }], projects: [] },
]
check(
  'L37 跨轮同一对只印一次：先出现的那一轮有块并标「另一组」，后一轮一个字都不加',
  cfMsg(cfCross, 0).includes('【疑似冲突 1 对】') &&
    cfMsg(cfCross, 0).includes('（另一组）') &&
    !cfMsg(cfCross, 1).includes('【疑似冲突 1 对】'),
  `r0=${cfMsg(cfCross, 0).includes('【疑似冲突 1 对】')} r1=${cfMsg(cfCross, 1).includes('【疑似冲突 1 对】')}`,
)

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
