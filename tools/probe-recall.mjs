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

// ── R1 相关度优先：第一条是最相关的，不是最旧的 ─────────────────────────────
const hitsR1 = (await call('memory_search', { query: '部署', explain: true, k: 10 })).hits
check('R1 首条是最相关的（铁律），不是最旧的（随手记）', hitsR1[0]?.id === ids.iron, `${hitsR1[0]?.level} ${String(hitsR1[0]?.content ?? '').slice(0, 12)}`)
check('R1 随手记仍在结果里（不是被挤没，只是排后面）', hitsR1.some((h) => h.id === ids.casual))
const scoresR1 = hitsR1.map((h) => h.score)
check('R1 分数单调不增（排序真按分数，不是按时间）', scoresR1.every((v, i) => i === 0 || scoresR1[i - 1] >= v), scoresR1.join(' ≥ '))
const byTime = [...hitsR1].sort((a, b) => (a.updated_at ?? 0) - (b.updated_at ?? 0))
check('R1 阴性对照：旧口径（updated_at 升序）排出来的第一条不是同一条', byTime[0]?.id !== hitsR1[0]?.id, `${String(byTime[0]?.content ?? '').slice(0, 12)}`)

// ── R2 重要度进分数 + explain 三因子 ───────────────────────────────────────
const explainOf = (hits, key) => hits.find((h) => h.id === ids[key])?.explain
const exIron = explainOf(hitsR1, 'iron')
check('R2 explain 三个因子齐（bm25 / importanceWeight / recencyWeight）', ['bm25', 'importanceWeight', 'recencyWeight'].every((k) => typeof exIron?.[k] === 'number'), JSON.stringify(exIron))
check('R2 importance=4 的乘数是 1.75', exIron?.importanceWeight === 1.75, String(exIron?.importanceWeight))
check('R2 importance=1 的乘数是 1', explainOf(hitsR1, 'casual')?.importanceWeight === 1, String(explainOf(hitsR1, 'casual')?.importanceWeight))
const recomputed = hitsR1.map((h) => Math.round(h.explain.bm25 * h.explain.recencyWeight * h.explain.importanceWeight * 100) / 100)
check('R2 score = bm25 × recencyWeight × importanceWeight（分项能还原总分）', recomputed.every((v, i) => Math.abs(v - hitsR1[i].score) <= 0.011), `${recomputed.join(',')} vs ${hitsR1.map((h) => h.score).join(',')}`)
check('R2 铁律的 bm25 低于随手记，却靠重要度反超（不是靠措辞赢的）', exIron.bm25 <= (explainOf(hitsR1, 'casual')?.bm25 ?? Infinity), `${exIron.bm25} vs ${explainOf(hitsR1, 'casual')?.bm25}`)

// 阴性对照：把 importance 全抹平成 1，引擎自己就会把顺序翻过来。
// 这条同时证明「R1 不是恒真的」——去掉这个补丁，同一个查询会给出另一个首条。
const flat = V.search('部署', docsOf().map((d) => ({ ...d, importance: 1 })), { k: 10, explain: true })
check('R2 阴性对照：importance 全抹平后首条翻成随手记', flat[0]?.id === ids.casual, `${flat[0]?.level} score=${flat[0]?.score}`)

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
