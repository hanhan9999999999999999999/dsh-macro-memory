/**
 * [macro-fusion 0.2.88] 跨层重复探针：真 vendor 引擎 + 合成语料，不启动 DSH、不碰真记忆库。
 *
 *   M0 装配：三件工具齐、语料就位
 *   M1 同一句话写 fact 又写 lesson：照样落下两份（层各有分工是合法的，不硬拦）
 *   M2 但回执点名：「另一层已有几乎一样的条目（fact xxxxxxxx，重复度 100%）」+ 两条出路
 *   M3 检索侧折叠：默认参数下同一句话只列一次，尾注报出折了几条，并给 dedupe: false
 *   M4 阴性对照：传 dedupe: false 就回两条——说明 M3 折掉的正是那一条，不是把结果砍半
 *   M5 折叠保留的是「在用 → 较新 → 分高」挑出来的那条（0.2.141 起：分数不再一票决定）
 *   M6 不同内容不误折（fact / lesson 各有分工时两条都列）
 *   M7 同层重复仍走合并（新逻辑没有把「同一层」这条老路弄坏）
 *   M8 参数面：schema 里 dedupe 是 boolean、默认 true，三语文案都有这个键
 *
 * 用法：node tools/probe-dup.mjs
 */
import { root } from './_root.mjs'
import { registerHooks } from 'node:module'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const home = mkdtempSync(join(tmpdir(), 'macro-dup-home-'))
process.env.DSH_HOME = home

const stubDir = mkdtempSync(join(tmpdir(), 'macro-dup-stub-'))
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
  'M0 工具注册齐（remember / update / search 三件必须有）',
  ['memory_remember', 'memory_update', 'memory_search'].every((n) => T.has(n)),
  `${T.size} 个`,
)

const workspace = join(home, 'ws')
mkdirSync(workspace, { recursive: true })
const exec = { agent: { session: { header: { cwd: workspace, id: 'sess-dup' } } } }
const call = (name, args) => T.get(name).execute(args, exec)
const db = V.getDb(workspace, '.dsh-meow')
const flat = (v) => String(v ?? '').replace(/\n+/g, ' / ')

// 语料：一句「发布前备份」的铁律。写两次、分两层——这正是实测里最常撞的形态
// （同一句话既当事实记 fact，又当教训记 lesson）。
const LINE = '发布之前必须先把当前树备份到 D:\\备份 再动手，出问题先还原备份再排查，不许带着坏状态继续往下做。'
check('M0 语料就位', LINE.length > 40, `${LINE.length} 字`)

// ── M1 / M2：同一句话写两层 ───────────────────────────────────────────────
const f1 = await call('memory_remember', { content: LINE, level: 'fact', keywords: ['发布', '备份', '还原'], importance: 3, project: '全局' })
check('M1 第一层（fact）是「新写」，此时别的层还没有同句，回执不点别人的名', f1.merged === false && !String(f1.note ?? '').includes('另一层已有'), flat(f1.note).slice(0, 80))
const l1 = await call('memory_remember', { content: LINE, level: 'lesson', keywords: ['发布', '备份'], importance: 3, project: '全局' })
check('M1 第二层（lesson）也照样写下了，没有被硬拦（层各有分工是合法的）', l1.merged === false && l1.id !== f1.id, `${l1.id?.slice(0, 8)} vs ${f1.id?.slice(0, 8)}`)
check(
  'M1 两层真的各存一份（库里同句两条都在）',
  db.list('fact', { status: 'active' }).filter((r) => r.content === LINE).length === 1 &&
    db.list('lesson', { status: 'active' }).filter((r) => r.content === LINE).length === 1,
)
const noteL = String(l1.note ?? '')
check(
  'M2 回执点名另一层已有：层名 + 短 id + 重复度都在',
  noteL.includes('另一层已有') && noteL.includes('fact') && noteL.includes(f1.id.slice(0, 8)) && noteL.includes('100%'),
  flat(noteL).slice(0, 160),
)
check(
  'M2 点名时给出两条出路（归档其中一条 / 把措辞写开），不是只说「重复了」',
  noteL.includes('memory_update') && noteL.includes('archived') && noteL.includes('措辞'),
  flat(noteL).slice(0, 160),
)

// ── M3：默认参数下检索侧折叠 ──────────────────────────────────────────────
const s1 = await call('memory_search', { query: '发布前备份 还原' })
const hits1 = s1.hits ?? []
check('M3 默认参数：同一句话只列一次', hits1.length === 1, `${hits1.length} 条 ${hits1.map((h) => h.level).join(',')}`)
check(
  'M3 尾注报出折了几条（≥80% 重复度）',
  String(s1.note ?? '').includes('另有 1 条内容几乎一样') && String(s1.note ?? '').includes('80%'),
  flat(s1.note).slice(-170),
)
check('M3 折叠也要有出口：尾注说明 dedupe: false 看全量', String(s1.note ?? '').includes('dedupe: false'))

// ── M4 / M5：阴性对照 —— 不折叠就回两条 ───────────────────────────────────
const s2 = await call('memory_search', { query: '发布前备份 还原', dedupe: false })
const hits2 = s2.hits ?? []
check('M4 阴性对照：dedupe: false 时两条都列（说明 M3 砍掉的正是这一条，不是恒砍）', hits2.length === 2, `${hits2.length} 条 ${hits2.map((h) => h.level).join(',')}`)
check('M4 不折叠时不该再报折叠尾注', !String(s2.note ?? '').includes('另有 1 条内容几乎一样'), flat(s2.note).slice(-90))
// 0.2.141：折叠的裁决权从「分数」交回「状态 → 时间 → 分数」。
// 这里两条都是 active，所以该留的是较新的那条；若时间也打平才轮到分数。
const rowM5 = new Map()
for (const level of ['fact', 'lesson']) for (const r of db.list(level, {})) rowM5.set(String(r.id), r)
const rankM5 = (h) => {
  const r = rowM5.get(String(h.id)) ?? {}
  return {
    st: V.statusWeight?.(r.status ?? h.status) ?? 1,
    at: Number(r.updated_at ?? h.updated_at ?? 0) || 0,
    sc: Number(h.score ?? 0) || 0,
  }
}
const orderM5 = [...(hits2 ?? [])].sort((a, b) => {
  const x = rankM5(a)
  const y = rankM5(b)
  if (x.st !== y.st) return y.st - x.st
  if (x.at !== y.at) return y.at - x.at
  return y.sc - x.sc
})
check(
  'M5 折叠保留的是「在用 → 较新 → 分高」挑出来的那条（分数不再一票决定）',
  hits1.length === 1 && hits2.length === 2 && String(hits1[0].id) === String(orderM5[0]?.id),
  `keep=${String(hits1[0]?.id).slice(0, 8)} 期望=${String(orderM5[0]?.id).slice(0, 8)}`,
)

// ── M6：不同内容不误折 ────────────────────────────────────────────────────
await call('memory_remember', { content: '星图连线的权重低于 0.5 就不建边，避免把噪音连进星图', level: 'fact', keywords: ['星图', '连线', '权重'], importance: 2, project: '全局' })
await call('memory_remember', { content: '写记忆时没连上的连线会排队，读记忆时自动补；排队欠账用 memory_admin 的 links 看', level: 'lesson', keywords: ['星图', '连线', '排队'], importance: 2, project: '全局' })
const s3 = await call('memory_search', { query: '星图 连线 权重', min_rel: 0 })
const hits3 = s3.hits ?? []
check('M6 不同措辞的两层条目都列出来（只折逐字级重复，改写过的照旧）', hits3.length === 2, `${hits3.length} 条 ${hits3.map((h) => h.level).join(',')}`)
check('M6 不误报折叠尾注', !String(s3.note ?? '').includes('没重复列'), flat(s3.note).slice(-90))
const noteM6 = hits3.map((h) => h.level).join(',')
check('M6 顺带确认它们确实是一 fact 一 lesson（否则这条判据没意义）', noteM6.includes('fact') && noteM6.includes('lesson'), noteM6)

// ── M7：同层重复仍走合并 ──────────────────────────────────────────────────
const f2 = await call('memory_remember', { content: LINE, level: 'fact', keywords: ['铁律'], importance: 3, project: '全局' })
check('M7 同层再写一遍仍走「合并」（新逻辑没把老路弄坏）', f2.merged === true && f2.id === f1.id, `${f2.id?.slice(0, 8)} merged=${f2.merged}`)
check(
  'M7 合并后 fact 层这句仍只有一条（没有被写成第二条）',
  db.list('fact', { status: 'active' }).filter((r) => r.content === LINE).length === 1,
)

// ── M8：参数面 —— schema 与三语文案 ───────────────────────────────────────
const prop = T.get('memory_search')?.parameters?.properties?.dedupe
check('M8 schema 里 dedupe 是 boolean、默认 true', prop?.type === 'boolean' && prop?.default === true, JSON.stringify(prop?.default))
for (const lang of ['zh', 'en', 'pt-br']) {
  const md = readFileSync(join(root, 'vendor', 'meow-memory', 'lib', 'prompts', lang, 'tools.md'), 'utf8')
  check(`M8 ${lang} 文案里有 memory_search.param.dedupe（缺了 T() 会直接抛）`, md.includes('- memory_search.param.dedupe:'), `${md.length} 字符`)
}

for (const dir of [home, stubDir]) {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    console.log(`（临时目录没清掉，交给系统回收：${dir}）`)
  }
}
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
if (failures !== 0) process.exitCode = 1
