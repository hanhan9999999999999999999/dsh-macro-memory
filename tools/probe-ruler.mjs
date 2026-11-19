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

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
