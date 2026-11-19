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

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
