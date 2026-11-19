/**
 * 覆盖审计：证明「子插件的功能全部搬过来了」。
 *
 * 做法：直接从 vendor 源码里点名子插件的所有工具（17 个），逐条对到 macro 的
 * 8 个统一工具或兼容别名上，并检查目标工具真的有那条入口
 * （memory_search 的 mode、memory_admin 的 action、memory_link 的 action）。
 *
 * 用法：node tools/coverage-audit.mjs
 */
import { root } from './_root.mjs'
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'


// 审计脚本会真的执行工具：memory_link 失败会往「待补连线队列」里记一条。
// 不把 DSH_HOME 指到临时目录，审计一次就在主人的账本上留一条假欠账（0.2.10 修）。
const home = mkdtempSync(join(tmpdir(), 'macro-audit-home-'))
process.env.DSH_HOME = home

// tools.js 会 import meow（要 @deepseek-ai/dsh-llm）：给个最小 stub，不启动 DSH
const stubFile = join(mkdtempSync(join(tmpdir(), 'macro-audit-stub-')), 'dsh-llm.mjs')
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

/** 17 个原工具 → macro 的落点。route 里写清楚带什么参数。 */
const COVERAGE = {
  // ── meow 8 个（写/读/整理/运维，全部 1:1 进主工具面）────────────────────
  memory_remember: { tool: 'memory_remember', how: '同名直通（+links[] 顺手固化星图关联）' },
  memory_update: { tool: 'memory_update', how: '同名直通（+links[]）' },
  memory_search: { tool: 'memory_search', how: '默认 mode="local"' },
  memory_read: { tool: 'memory_read', how: '同名直通（+neighbors 追加星图邻域）' },
  memory_project: { tool: 'memory_project', how: '同名直通' },
  memory_dream: { tool: 'memory_dream', how: '同名直通' },
  memory_find_similar: { tool: 'memory_search', mode: 'similar', how: 'memory_search(mode="similar", id=…)' },
  memory_home: { tool: 'memory_admin', action: 'home', how: 'memory_admin(action="home")' },
  // ── nebula 9 个（星图：检索/邻域/连线/路径/运维）────────────────────────
  nebula_recall: { tool: 'memory_search', mode: 'graph', how: 'memory_search(mode="graph")' },
  nebula_inspect: { tool: 'memory_read', how: 'memory_read 默认带 neighbors，内部走 inspect' },
  nebula_bridge: { tool: 'memory_search', mode: 'bridge', how: 'memory_search(mode="bridge")' },
  nebula_link: { tool: 'memory_link', action: 'link', how: 'memory_link(action="link")' },
  nebula_path: { tool: 'memory_link', action: 'path', how: 'memory_link(action="path")' },
  nebula_stats: { tool: 'memory_admin', action: 'stats', how: 'memory_admin(action="stats")' },
  nebula_hygiene: { tool: 'memory_admin', action: 'hygiene', how: 'memory_admin(action="hygiene")' },
  nebula_sources: { tool: 'memory_admin', action: 'sources', how: 'memory_admin(action="sources")' },
  nebula_ingest: { tool: 'memory_admin', action: 'ingest', how: 'memory_admin(action="ingest")' },
}

let failures = 0
function check(label, ok, extra) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra === undefined ? '' : '  ' + extra}`)
  if (!ok) failures++
}

// ── 1. 从 vendor 源码里点名原工具，确认表没漏 ──────────────────────────────
const meowSrc = readFileSync(join(root, 'vendor', 'meow-memory', 'lib', 'index.js'), 'utf8')
const nebulaSrc = readFileSync(join(root, 'vendor', 'dsh-memory-nebula', 'lib', 'index.js'), 'utf8')

const named = (src, prefix) => {
  const out = new Set()
  const re = new RegExp(`name:\\s*["'](${prefix}[a-z_]+)["']`, 'g')
  let m
  while ((m = re.exec(src))) out.add(m[1])
  return out
}
const vendorTools = new Set([...named(meowSrc, 'memory_'), ...named(nebulaSrc, 'nebula_')])
console.log(`     源码里的原工具（${vendorTools.size}）：${[...vendorTools].sort().join(', ')}`)
check('1.1 vendor 里认出来的原工具是 17 个', vendorTools.size === 17, `${vendorTools.size} 个`)

const missing = [...vendorTools].filter((n) => !COVERAGE[n])
check('1.2 每个原工具都有覆盖去向', missing.length === 0, missing.join(', ') || undefined)

const extra = Object.keys(COVERAGE).filter((n) => !vendorTools.has(n))
check('1.3 覆盖表里没有凭空多出来的工具', extra.length === 0, extra.join(', ') || undefined)

// ── 2. 目标工具真的存在、真的有那条入口 ────────────────────────────────────
const dummyBridge = {
  async call() {
    throw new Error('audit')
  },
  async tryCall() {
    return { text: '' }
  },
  promptDeclarations: () => [],
}
const { createUnifiedTools, createAliasTools } = await import(pathToFileURL(join(root, 'lib', 'macro', 'tools.js')).href)
const unified = createUnifiedTools({ bridge: dummyBridge, config: {} })
const aliases = createAliasTools({ bridge: dummyBridge })
const byName = new Map(unified.map((d) => [d.name, d]))
const aliasNames = aliases.map((d) => d.name)

let routeOk = true
for (const [from, route] of Object.entries(COVERAGE)) {
  const def = byName.get(route.tool)
  if (!def) {
    routeOk = false
    check(`2 ${from} → ${route.tool}`, false, '目标工具不在 8 个统一工具里')
    continue
  }
  const props = def.parameters?.properties ?? {}
  if (route.mode !== undefined) {
    const values = props.mode?.enum ?? []
    if (!values.includes(route.mode)) {
      routeOk = false
      check(`2 ${from} → ${route.tool}(mode=${route.mode})`, false, `mode 枚举缺 ${route.mode}`)
    }
  }
  if (route.action !== undefined) {
    const values = props.action?.enum ?? []
    if (!values.includes(route.action)) {
      routeOk = false
      check(`2 ${from} → ${route.tool}(action=${route.action})`, false, `action 枚举缺 ${route.action}`)
    }
  }
}
check('2.1 17 条去向全部落在真实入口上', routeOk)

// ── 3. 8 个统一工具本身 ───────────────────────────────────────────────────
const EXPECT = [
  'memory_admin',
  'memory_dream',
  'memory_link',
  'memory_project',
  'memory_read',
  'memory_remember',
  'memory_search',
  'memory_update',
]
check('3.1 统一工具正好 8 个', JSON.stringify(unified.map((d) => d.name).sort()) === JSON.stringify(EXPECT))
check(
  '3.2 兼容别名含全部 11 个原名',
  ['memory_find_similar', 'memory_home', ...[...vendorTools].filter((n) => n.startsWith('nebula_'))].every((n) =>
    aliasNames.includes(n),
  ),
  aliasNames.join(', '),
)

// ── 4. 每个原工具都能被真实调用到（不是只有参数槽）─────────────────────────
const calls = []
const spy = {
  async call(name, args) {
    calls.push(name)
    // memory_read 是短 id 归一的通道：这里一律「找得到」且给一段正文（0.2.52 起空 text 会被融合层当成
    // 「上游没回执」先拦下，不再往下补连线），否则连线分支会在补全阶段就返回
    if (name === 'memory_read') return { value: { found: true, id: String(args?.id) }, text: '[fact] 记忆正文（audit 桩）' }
    return { value: {}, text: '' }
  },
  async tryCall(name, args) {
    calls.push(name)
    if (name === 'memory_read') return { value: { found: true, id: String(args?.id) }, text: '[fact] 记忆正文（audit 桩）' }
    return { text: '' }
  },
  promptDeclarations: () => [{ vendor: 'meow', decl: { name: 'x', text: 't' } }],
}
const spied = new Map(createUnifiedTools({ bridge: spy, config: {} }).map((d) => [d.name, d]))
const exec = { agent: { session: { header: { cwd: root } } } }
const invoke = async (tool, args) => {
  const def = spied.get(tool)
  try {
    await def.execute(args, exec)
  } catch {
    /* 参数不全时的抛错不算失败，只要它走到了子插件调用 */
  }
}
await invoke('memory_remember', { content: 'x', project: '全局', keywords: ['a'], importance: 1 })
await invoke('memory_update', { id: 'x', content: 'y' })
await invoke('memory_search', { query: 'q' })
await invoke('memory_search', { query: 'q', mode: 'graph' })
await invoke('memory_search', { query: 'q', mode: 'bridge' })
await invoke('memory_search', { id: 'x', mode: 'similar' })
await invoke('memory_read', { id: 'x', neighbors: 12 })
await invoke('memory_project', { project: '全局' })
await invoke('memory_dream', {})
await invoke('memory_admin', { action: 'home' })
await invoke('memory_admin', { action: 'stats' })
await invoke('memory_admin', { action: 'hygiene' })
await invoke('memory_admin', { action: 'sources' })
await invoke('memory_admin', { action: 'ingest', provider: 'x', items: [{ title: 't' }] })
await invoke('memory_link', { action: 'link', a: 'x', b: 'y' })
await invoke('memory_link', { action: 'path', a: 'x', b: 'y' })

const hitVendor = new Set(calls)
const expectedCalls = [
  'memory_remember',
  'memory_update',
  'memory_search',
  'memory_find_similar',
  'memory_read',
  'nebula_inspect',
  'memory_project',
  'memory_dream',
  'memory_home',
  'nebula_stats',
  'nebula_hygiene',
  'nebula_sources',
  'nebula_ingest',
  'nebula_recall',
  'nebula_bridge',
  'nebula_link',
  'nebula_path',
]
const notCalled = expectedCalls.filter((n) => !hitVendor.has(n))
check('4.1 17 个原工具都被真实调用路径走到', notCalled.length === 0, notCalled.join(', ') || undefined)

console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILED'}`)
if (failures === 0) {
  try {
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  } catch {
    /* Windows 句柄偶尔锁住，下次启动会重新建 */
  }
}
process.exit(failures === 0 ? 0 : 1)
