/**
 * [macro-fusion 0.2.89] 相似检索探针：真 vendor 引擎 + 合成语料，不启动 DSH、不碰真记忆库。
 *
 *   M0 装配：工具齐、语料就位
 *   M1 同一会话里刚写完就问「谁跟它像」——立刻能比（原来这一问是 0 命中，回执叫读者「等下一次会话」）
 *   M2 基准侧也把 keywords / title 算进去：只沾 keywords 的候选得看得见（正文口径下它是 0.000 分）
 *   M3 基准自己不进结果（id 互斥）
 *   M4 这一轮已经端过的照样排除——「别重复端」这个边界没被顺手拆掉
 *   M5 换个会话问，还是那一条（数据没被前面几次调用吃掉）
 *   M6 k 真的管条数
 *   M7 短 id 撞车仍抛错（0.2.53 的老账没被这次改动弄坏）
 *   M8 不存在的 id 仍说「相似检索没起点」
 *   M9 相似度是 0-1 且降序
 *   M10 三语文案：写明「基准和候选同一段文字」，且不再写「只检索其他会话建立的记忆」
 *
 * 用法：node tools/probe-similar.mjs
 */
import { root } from './_root.mjs'
import { registerHooks } from 'node:module'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const home = mkdtempSync(join(tmpdir(), 'macro-sim-home-'))
process.env.DSH_HOME = home

const stubDir = mkdtempSync(join(tmpdir(), 'macro-sim-stub-'))
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
check(
  'M0 工具注册齐（remember / update / find_similar 三件必须有）',
  ['memory_remember', 'memory_update', 'memory_find_similar'].every((n) => T.has(n)),
  `${T.size} 个`,
)

const workspace = join(home, 'ws')
mkdirSync(workspace, { recursive: true })
const execOf = (id) => ({ agent: { session: { header: { cwd: workspace, id } } } })
const call = (name, args, exec) => T.get(name).execute(args, exec)
const flat = (v) => String(v ?? '').replace(/\n+/g, ' / ')

// 语料：基准内容很短、真信息在 keywords 里——这正是本库最常见的形态（keywords 8-13 个）。
// B 只沾基准的 keywords；C 沾正文但换了话题（库房的门）；D 完全不沾。
const BASE = '凌晨两点到四点之间不要动库。'
const BASE_KW = ['备份', '窗口', '停机', '维护', '发布', '回滚', '灰度', '通知', '数据库', '计划']
const ONLY_KW = '发布前要通知值班同学，并准备回滚方案。'
const ONLY_KW_KW = ['发布', '通知', '回滚', '值班', '方案']
const SAME_WORDS = '两点到四点之间我一般在睡觉，别叫醒我。'
const SAME_WORDS_KW = ['睡觉', '作息', '凌晨']
const NOISE = '前端面板的配色用深蓝，别用纯黑。'
const NOISE_KW = ['面板', '配色', '主题']

const W = execOf('sess-sim-write')
const eA = await call('memory_remember', { content: BASE, level: 'fact', keywords: BASE_KW, importance: 2, project: '全局' }, W)
const eB = await call('memory_remember', { content: ONLY_KW, level: 'fact', keywords: ONLY_KW_KW, importance: 2, project: '全局' }, W)
const eC = await call('memory_remember', { content: SAME_WORDS, level: 'fact', keywords: SAME_WORDS_KW, importance: 2, project: '全局' }, W)
const eD = await call('memory_remember', { content: NOISE, level: 'lesson', keywords: NOISE_KW, importance: 2, project: '全局' }, W)
check('M0 语料就位（四条：基准 / 只沾 keywords / 沾正文 / 无关）', [eA, eB, eC, eD].every((r) => r && r.id), `基准 ${eA.id?.slice(0, 8)}`)

// ── M1：同一会话写完立刻能比 ────────────────────────────────────────────────
const sim1 = await call('memory_find_similar', { id: eA.id, k: 5 }, W)
check(
  'M1 同一会话里刚写完就问，立刻能比（不再整批排除本会话新写的条目）',
  sim1.hits.length > 0,
  `${sim1.hits.length} 条${sim1.note ? ' | note: ' + flat(sim1.note).slice(0, 70) : ''}`,
)
check(
  'M1 阴性对照：回执不再叫人「等下一次会话再问」',
  !/等下一次会话/.test(String(sim1.note ?? '')),
)
check(
  'M1 回执点名「命中里有 N 条是本会话刚写的」——别把刚记的当成旧依据',
  /命中里有 \d+ 条是本会话刚写的/.test(String(sim1.note ?? '')),
  flat(sim1.note).slice(0, 70),
)

// ── M2：基准侧也走 docText（title + 正文 + keywords）──────────────────────────
const hitB = sim1.hits.find((h) => h.id === eB.id)
check(
  'M2 只沾基准 keywords 的候选看得见（正文口径下它是 0.000 分，被 s<=0 直接丢掉）',
  Boolean(hitB) && hitB.similarity > 0,
  hitB ? `similarity ${hitB.similarity}` : '没出现',
)
check(
  'M2 基准自己的 keywords 真的参与了比较（同一句正文、keywords 不同 → 分数不同）',
  (() => {
    const withKw = V.findSimilar([BASE, ...BASE_KW].join(' '), [{ id: 'x', level: 'fact', title: '', content: ONLY_KW, keywords: ONLY_KW_KW }], 1)
    const noKw = V.findSimilar(BASE, [{ id: 'x', level: 'fact', title: '', content: ONLY_KW, keywords: ONLY_KW_KW }], 1)
    return withKw.length > 0 && noKw.length === 0
  })(),
  '带 keywords 有分 / 只给正文零命中',
)
check('M3 基准自己不进结果', !sim1.hits.some((h) => h.id === eA.id))

// ── M4：这一轮端过的仍然排除 ────────────────────────────────────────────────
const sim2 = await call('memory_find_similar', { id: eA.id, k: 5 }, W)
const shownBefore = new Set(sim1.hits.map((h) => h.id))
check(
  'M4 这一轮已经端过的照样排除（「别重复端」这条边界没被拆掉）',
  sim1.hits.length >= 2 && !sim2.hits.some((h) => shownBefore.has(h.id)),
  `第一次 ${sim1.hits.length} 条，第二次 ${sim2.hits.length} 条，交集 ${sim2.hits.filter((h) => shownBefore.has(h.id)).length}`,
)
check(
  'M4 第二次的空不是「库里没有可比对象」——必须说清是候选被排除了',
  !/库里就只有这一条/.test(String(sim2.note ?? '')),
  flat(sim2.note).slice(0, 70),
)

// ── M5：换会话照样看得到 ────────────────────────────────────────────────────
const sim3 = await call('memory_find_similar', { id: eA.id, k: 5 }, execOf('sess-sim-read'))
check('M5 换个会话问，那两条照样看得到（数据没被前面的调用吃掉）', sim3.hits.length >= 2, `${sim3.hits.length} 条`)
check('M5 阴性对照：换了会话就不再点「本会话刚写」', !/本会话刚写的/.test(String(sim3.note ?? '')), flat(sim3.note).slice(0, 50))

// ── M6：k 管条数 ────────────────────────────────────────────────────────────
const sim4 = await call('memory_find_similar', { id: eA.id, k: 1 }, execOf('sess-sim-k'))
check('M6 k=1 只回一条', sim4.hits.length === 1, `${sim4.hits.length} 条`)

// ── M7：短 id 撞车仍抛错 ────────────────────────────────────────────────────
const db = V.getDb(workspace, '.dsh-meow')
db.insert({ id: '0msim01', level: 'fact', content: '撞车语料一：备份窗口。', keywords: ['备份'], importance: 1 })
db.insert({ id: '0msim02', level: 'fact', content: '撞车语料二：备份窗口。', keywords: ['备份'], importance: 1 })
let collision = ''
try {
  await call('memory_find_similar', { id: '0msim0', k: 3 }, execOf('sess-sim-collide'))
} catch (e) {
  collision = String(e && e.message ? e.message : e)
}
check('M7 短 id 撞车仍抛错，不替人挑第一条', /相似检索这次一条都没比/.test(collision), collision.slice(0, 60))

// ── M8：不存在的 id ─────────────────────────────────────────────────────────
let missing = ''
try {
  await call('memory_find_similar', { id: '0mnotexist', k: 3 }, execOf('sess-sim-miss'))
} catch (e) {
  missing = String(e && e.message ? e.message : e)
}
check('M8 不存在的 id 仍说「相似检索没起点」', /相似检索没起点/.test(missing), missing.slice(0, 60))

// ── M9：分数区间与顺序 ──────────────────────────────────────────────────────
check(
  'M9 相似度都在 0-1、按降序排',
  sim3.hits.every((h, i) => h.similarity > 0 && h.similarity <= 1 && (i === 0 || sim3.hits[i - 1].similarity >= h.similarity)),
  sim3.hits.map((h) => h.similarity).join(' ≥ '),
)

// ── M10：三语文案 ───────────────────────────────────────────────────────────
const zh = readFileSync(join(root, 'vendor', 'meow-memory', 'lib', 'prompts', 'zh', 'tools.md'), 'utf8')
const en = readFileSync(join(root, 'vendor', 'meow-memory', 'lib', 'prompts', 'en', 'tools.md'), 'utf8')
const pt = readFileSync(join(root, 'vendor', 'meow-memory', 'lib', 'prompts', 'pt-br', 'tools.md'), 'utf8')
check(
  'M10 三语文案都写明「基准和候选同一段文字」，且不再写「只检索其他会话建立的记忆」',
  zh.includes('基准和候选用的是同一段文字') &&
    en.includes('one ruler for both sides') &&
    pt.includes('a mesma régua para os dois lados') &&
    !/同样只检索其他会话建立的记忆/.test(zh) &&
    !en.includes('only looks at memories created in other sessions') &&
    !pt.includes('olha apenas memórias criadas em outras sessões'),
)

console.log(failures === 0 ? '\nALL PASS' : `\nFAIL ${failures} 条`)
process.exit(failures === 0 ? 0 : 1)
