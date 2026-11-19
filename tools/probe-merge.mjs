/**
 * [macro-fusion 0.2.87] 合并账本探针：真 vendor 引擎 + 合成语料，不启动 DSH、不碰真记忆库。
 *
 *   M0 语料：一条长内容（含尾句细节）+ 一次同义再写，重复度落进 0.8 阈值
 *   M1 关键词取并集：合并不会把旧关键词换掉（旧的一条不剩 = 检索会漏）
 *   M2 归属不搬：这次给的 project 与旧的冲突时保留旧的，并在回执里说明
 *   M3 内容变短且非逐字：默认不换，旧细节原样留着，回执给出 overwrite 出口
 *   M4 overwrite: true 时才换（逃生口是真的能用，不是写了不生效）
 *   M5 更长的内容照旧替换（保护只对「变短」生效，不误挡正常更新）
 *   M6 importance 取大、corrected 保留、回执承认这是「合并」
 *   M7 阴性对照：旧写法（直接 db.update 覆盖 content+keywords）在同一语料上
 *      确实会丢关键词、把内容截短——说明 M1/M3 抓得到，不是恒 PASS 的注释
 *   M8 参数面：schema 里有 overwrite（boolean，默认 false），三语文案都有这个键
 *
 * 用法：node tools/probe-merge.mjs
 */
import { root } from './_root.mjs'
import { registerHooks } from 'node:module'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const home = mkdtempSync(join(tmpdir(), 'macro-merge-home-'))
process.env.DSH_HOME = home

const stubDir = mkdtempSync(join(tmpdir(), 'macro-merge-stub-'))
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
const exec = { agent: { session: { header: { cwd: workspace, id: 'sess-merge' } } } }
const call = (name, args) => T.get(name).execute(args, exec)
const row = (id) => V.getDb(workspace, '.dsh-meow').findById(id)?.row
const flat = (v) => String(v ?? '').replace(/\n+/g, ' / ')

// 语料：一句「长、含尾句细节」的铁律。短版把「也不许只备份配置文件」砍掉——
// 长度差 11 字，重复度仍在 0.8 以上，正好落进合并分支（M3 要拦的就是这一步）。
const LONG =
  '部署之前一定先备份：把 DSH_HOME 整个目录复制到备份盘的「日期-任务名」子目录，确认字节数一致再动代码；备份没成功就不许上线，也不许只备份配置文件。'
const SHORT = LONG.replace('，也不许只备份配置文件。', '。')
check('M0 语料长度：短版确实更短（否则 M3 无从谈起）', SHORT.length < LONG.length, `${LONG.length} → ${SHORT.length}`)

// ── M1 / M2 / M6：同一句话再写一遍 ────────────────────────────────────────
const first = await call('memory_remember', {
  content: LONG,
  level: 'lesson',
  keywords: ['部署', '备份', '铁律'],
  importance: 4,
  project: '甲项目',
  corrected: true,
})
check('M0 首次写入是「新写」不是「合并」', first.merged === false, first.id?.slice(0, 8))

const second = await call('memory_remember', {
  content: `${LONG}（第 2 次）`,
  level: 'lesson',
  keywords: ['上线'],
  importance: 2,
  project: '乙项目',
})
check('M1 同义再写走到合并分支（不是又写了一条）', second.merged === true && second.id === first.id, second.id?.slice(0, 8))
const rowA = row(second.id)
check(
  'M1 关键词取并集：旧的三条一条不剩才算丢（并集里旧的、新的都在）',
  ['部署', '备份', '铁律', '上线'].every((k) => (rowA?.keywords ?? []).includes(k)),
  JSON.stringify(rowA?.keywords),
)
check(
  'M2 归属不搬：这次给「乙项目」也不改掉旧的「甲项目」',
  rowA?.project === '甲项目',
  String(rowA?.project),
)
const noteA = String(second.note ?? '')
check(
  'M2 归属冲突要说出来，并给出换归属的正路（先归档再重写）',
  noteA.includes('归属没改') && noteA.includes('甲项目') && noteA.includes('乙项目') && noteA.includes('归档'),
  flat(noteA).slice(0, 150),
)
check(
  'M6 importance 取两者较大值，corrected 不被合并抹掉',
  rowA?.importance === 4 && Number(rowA?.corrected) === 1,
  `importance=${rowA?.importance} corrected=${rowA?.corrected}`,
)
check('M6 回执承认这是「合并」而不是「已写入」', noteA.includes('这是「合并」'), flat(noteA).slice(0, 60))
check(
  'M6 回执逐项说清并了什么（关键词条数 + importance 结论都在）',
  /关键词/.test(noteA) && /importance/.test(noteA),
  flat(noteA).slice(0, 120),
)

// ── M3：更短且非逐字 → 默认拒换 ───────────────────────────────────────────
const b1 = await call('memory_remember', { content: LONG, level: 'fact', keywords: ['部署', '备份'], importance: 2, project: '全局' })
const b2 = await call('memory_remember', { content: SHORT, level: 'fact', keywords: ['部署'], importance: 2, project: '全局' })
check('M3 变短的同义内容仍算合并（重复度过了阈值）', b2.merged === true && b2.id === b1.id, b2.id?.slice(0, 8))
const rowB = row(b2.id)
check('M3 内容没被换掉：旧的那句原样在', rowB?.content === LONG, `${String(rowB?.content ?? '').length} 字`)
check('M3 旧尾句细节还在（这正是「变短就覆盖」会吃掉的东西）', String(rowB?.content ?? '').includes('也不许只备份配置文件'))
const noteB = String(b2.note ?? '')
check(
  'M3 拒换要说清理由（长度对比 + 不是逐字同一句）',
  noteB.includes('内容没换') && noteB.includes(`${LONG.length} 字`) && noteB.includes(`${SHORT.length} 字`),
  flat(noteB).slice(0, 150),
)
check('M3 拒换要给逃生口 overwrite: true（不然就没法压缩了）', noteB.includes('overwrite: true'))

// ── M4：overwrite 才换 ────────────────────────────────────────────────────
const c1 = await call('memory_remember', { content: LONG, level: 'rules', keywords: ['部署', '备份'], importance: 3, project: '全局' })
const c2 = await call('memory_remember', { content: SHORT, level: 'rules', keywords: ['部署'], importance: 3, project: '全局', overwrite: true })
check('M4 overwrite: true 时短版真的换进去了（逃生口不是摆设）', c2.merged === true && row(c2.id)?.content === SHORT, `${String(row(c2.id)?.content ?? '').length} 字`)
check('M4 换了要说「已替换」并报长度变化', /内容已替换/.test(String(c2.note ?? '')) && String(c2.note ?? '').includes(`${SHORT.length} 字`), flat(c2.note).slice(0, 120))

// ── M5：更长 → 正常替换（保护不误挡）────────────────────────────────────
const d1 = await call('memory_remember', { content: LONG, level: 'topic', keywords: ['部署', '备份'], importance: 2, project: '全局' })
const LONGER = LONG.replace('。', '，也不许跳过校验。')
const d2 = await call('memory_remember', { content: LONGER, level: 'topic', keywords: ['校验'], importance: 2, project: '全局' })
check('M5 更长的内容照旧替换（保护只对变短生效）', d2.merged === true && row(d2.id)?.content === LONGER, `${String(row(d2.id)?.content ?? '').length} 字`)
check('M5 更长时也并进新关键词（并集不分长短）', (row(d2.id)?.keywords ?? []).includes('校验'), JSON.stringify(row(d2.id)?.keywords))

// ── M7：阴性对照——旧写法在同一语料上确实会丢东西 ─────────────────────────
// 这一条刻意用 user 层：上面 fact / lesson / rules / topic 都已经有同内容条目，
// 换个层才不会被合并吸进去（探针自己踩过一次：M7 和 M3 撞成同一条，判据就恒真）。
const e1 = await call('memory_remember', { content: LONG, level: 'user', keywords: ['部署', '备份', '铁律'], importance: 2, project: '甲项目' })
const db = V.getDb(workspace, '.dsh-meow')
db.update('user', e1.id, { content: SHORT, keywords: ['上线'], project: '乙项目' })
const rowOld = row(e1.id)
check(
  'M7 阴性对照：旧写法（content/keywords 直接覆盖）会只剩 1 个关键词、内容被截短',
  (rowOld?.keywords ?? []).length === 1 && rowOld?.content === SHORT,
  `${JSON.stringify(rowOld?.keywords)} / ${String(rowOld?.content ?? '').length} 字`,
)
check(
  'M7 阴性对照：同样一次合并，新写法的关键词数与内容长度都不同（判据抓得到差异）',
  (row(rowA.id)?.keywords ?? []).length !== (rowOld?.keywords ?? []).length && row(rowB.id)?.content?.length !== rowOld?.content?.length,
  `${(row(rowA.id)?.keywords ?? []).length} vs ${(rowOld?.keywords ?? []).length}`,
)

// ── M8：参数面 —— schema 与三语文案 ───────────────────────────────────────
const remember = T.get('memory_remember')
const prop = remember?.parameters?.properties?.overwrite
check('M8 schema 里 overwrite 是 boolean、默认 false', prop?.type === 'boolean' && prop?.default === false, JSON.stringify(prop?.default))
for (const lang of ['zh', 'en', 'pt-br']) {
  const md = readFileSync(join(root, 'vendor', 'meow-memory', 'lib', 'prompts', lang, 'tools.md'), 'utf8')
  check(`M8 ${lang} 文案里有 memory_remember.param.overwrite（缺了 T() 会直接抛）`, md.includes('- memory_remember.param.overwrite:'), `${md.length} 字符`)
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
