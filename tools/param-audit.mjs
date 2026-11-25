/**
 * 参数覆盖审计：证明「没有砍掉 meow / nebula 原有的任何一个参数」。
 *
 * coverage-audit.mjs 证明的是「17 个工具都有去处」；
 * 这里再往下钻一层：**每个原工具的参数**在统一工具里都还能传进去，
 * 且原来必填的字段没有被悄悄变成可选。
 *
 * 做法：
 *   1. 用假 ctx 真跑两个 vendor 的 apply，把 17 个工具定义原样捕获（含 parameters）
 *   2. 调 createUnifiedTools 拿到 8 个统一工具的 parameters
 *   3. 按 ROUTE 表逐条比对参数字典（默认同名，需要改名就写在 paramMap 里）
 *
 * 只在「读 schema」，不写库、不联网、不碰运行中的 DSH。
 */
import { root } from './_root.mjs'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'

// ── 0. stub @deepseek-ai/dsh-llm（vendor 只在事件/消息构造时用到两个符号）──
const STUB = `
export function createUserMessage(...args) { return { role: 'user', args } }
export function boundContextSummary(summary) { return summary }
export function createAssistantMessage(...args) { return { role: 'assistant', args } }
export default {}
`
const stubUrl = `data:text/javascript,${encodeURIComponent(STUB)}`
registerHooks({
  resolve(spec, context, next) {
    if (spec === '@deepseek-ai/dsh-llm') return { url: stubUrl, shortCircuit: true }
    return next(spec, context)
  },
})

const Meow = await import(pathToFileURL(join(root, 'vendor/meow-memory/lib/index.js')).href)
const Nebula = await import(pathToFileURL(join(root, 'vendor/dsh-memory-nebula/lib/index.js')).href)
const { createUnifiedTools } = await import(pathToFileURL(join(root, 'lib/macro/tools.js')).href)

// ── 1. 捕获两个 vendor 的原工具定义 ───────────────────────────────────────
const home = mkdtempSync(join(tmpdir(), 'macro-param-audit-'))
process.env.DSH_HOME = home

const vendorDefs = new Map()

function makeCtx(capture) {
  const handlers = []
  const ctx = {
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    fiber: { state: 0 },
    on(_e, h) { handlers.push(h); return () => {} },
    effect(fn) { const d = fn(); return typeof d === 'function' ? d : () => {} },
    inject(_deps, cb) { return typeof cb === 'function' ? cb(ctx) : () => {} },
    get() { return undefined },
    plugin() { return () => {} },
    tools: { register(def) { capture(def); return () => {} }, registerProvider() { return () => {} } },
    systemPrompt: { section() { return () => {} }, context() { return () => {} }, tools() { return () => {} }, variable() { return () => {} } },
    webServer: { register() { return () => {} }, get() {}, routes() { return [] } },
    connection: { send() {}, on() { return () => {} }, broadcast() {} },
    settings: {
      register() {
        // meow 会拿返回的 scope 去 get()/watch()：给个最小实现，别让审计卡在设置区
        return { get: () => undefined, watch: () => () => {}, update() {}, reset() {} }
      },
      installSection() { return () => {} },
    },
    configEditor: { register() { return () => {} } },
    sessions: { get() {}, list() { return [] } },
  }
  return ctx
}

for (const [label, mod, cfg] of [
  ['meow', Meow, { homeDir: join(home, 'store'), promptLang: 'zh', reflectTurns: 5 }],
  ['nebula', Nebula, {}],
]) {
  const capture = (def) => {
    if (def && typeof def.name === 'string') vendorDefs.set(def.name, { vendor: label, def })
  }
  const ctx = makeCtx(capture)
  try {
    await mod.apply(ctx, cfg)
  } catch (err) {
    // nebula 在没有真 webServer 时可能抛；已捕获到工具就够了
    if (!vendorDefs.size) throw err
  }
  await new Promise((r) => setTimeout(r, 150))
}

// ── 2. 拿统一工具的 schema（不需要能执行，给个空 bridge 就够）─────────────
const dummyBridge = {
  has: () => false,
  get: () => undefined,
  names: () => [],
  call: async () => ({ text: '' }),
  tryCall: async () => ({ text: '' }),
  awaitTool: async () => undefined,
  promptDeclarations: () => [],
}
const unified = createUnifiedTools({ bridge: dummyBridge, config: {} })
const unifiedByName = new Map(unified.map((t) => [t.name, t]))

// ── 3. 路由表：原工具 → 统一工具（参数同名，需要改名写在 paramMap）────────
const ROUTE = {
  memory_remember: { to: 'memory_remember' },
  memory_update: { to: 'memory_update' },
  memory_search: { to: 'memory_search' },
  memory_find_similar: { to: 'memory_search' },
  memory_read: { to: 'memory_read' },
  memory_project: { to: 'memory_project' },
  memory_home: { to: 'memory_admin' },
  memory_dream: { to: 'memory_dream' },
  nebula_recall: { to: 'memory_search' },
  nebula_inspect: { to: 'memory_read' },
  nebula_link: { to: 'memory_link' },
  nebula_path: { to: 'memory_link' },
  nebula_stats: { to: 'memory_admin' },
  nebula_hygiene: { to: 'memory_admin' },
  nebula_bridge: { to: 'memory_search' },
  nebula_sources: { to: 'memory_admin' },
  nebula_ingest: { to: 'memory_admin' },
}

const EXTRA = {
  // 统一工具自己加的能力：不属于「原本功能」，单独列出，避免审计误判
  // [macro-fusion 0.2.109] budget：回执的 token 预算，是统一工具自己加的能力
  // （vendor 的 search 口只有 k / content_max，没有「按总预算自己收紧」这一层），登记在这里才算「有出处」。
  'memory_search': ['mode', 'expand', 'id', 'memory_ids', 'limit', 'hops', 'chars', 'min_weight', 'budget'],
  // [macro-fusion 0.2.112] budget：读这一支也吃预算——不给=不限额，给了就先砍邻居条数，正文一字不截。
  'memory_read': ['neighbors', 'budget'],
  'memory_link': ['action', 'a', 'b', 'note', 'maxHops'],
  // [macro-fusion 0.2.105] since / until：按日期筛 dream 账本，是统一工具自己加的能力
  // （vendor 的 dream 读口原来只有 limit/offset/project），登记在这里才算「有出处」。
  'memory_admin': ['action', 'target', 'limit', 'kind', 'hubs', 'verbose', 'provider', 'items', 'page', 'since', 'until'],
  // [macro-fusion 0.2.117] supersedes：写新的同时把被顶掉的旧条目降格并留取代句，是统一工具自己加的能力
  // （vendor 的 remember 只做重复合并，没有「取代」这个概念），登记在这里才算「有出处」。
  'memory_remember': ['links', 'supersedes'],
  // [macro-fusion 0.2.157] patch / append / restore / allowShrink：可更新性的两半（按句改 + 改前留一版），
  // vendor 的 update 口只收整段 content，这四个参数由融合层自己算成最终正文，登记在这里才算「有出处」。
  'memory_update': ['links', 'patch', 'append', 'restore', 'allowShrink'],
  // [macro-fusion 0.6.63] group / limit / budget：项目全景的目录视图是统一工具自己加的能力
  // （vendor 的 project 口只有 project 一个参数，一次吐全文，实测中位数 7,554 字、最大 27,319 字）。
  'memory_project': ['group', 'limit', 'budget'],
}

// [macro-fusion 0.4.0] WITHHELD：vendor 侧有、统一工具**故意**不暴露的参数。
// 与 EXTRA 是相反方向：EXTRA 记「融合层自己加的能力」，这里记「我们主动关掉的入口」。
// 为什么必须显式记账而不是静默跳过：1.1 守的病正是「融合层把上游能力克扣掉」——少一个参数而没人说，
// 和漏掉一个参数长得一模一样。而 internal 是唯一一个「暴露给模型就等于毁掉它自己」的参数：
// 模型一旦能传，就能把自己的查询伪装成「没端给用户看过」，seen 账本与召回次数立刻不可信。
const WITHHELD = {
  'memory_search.internal': '只给插件内部诊断（写入后判该不该巩固）：暴露给模型等于允许它伪造「这条没端给用户看过」',
}

// ── 4. 断言 ───────────────────────────────────────────────────────────────
let failed = 0
function check(ok, name, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : `  ${detail}`}`)
  if (!ok) failed += 1
}

check(vendorDefs.size === 17, '0.1 捕获到 17 个原工具', `实际 ${vendorDefs.size}`)
check(unified.length === 8, '0.2 统一工具 8 个', `实际 ${unified.length}`)

const missing = []
const requiredLost = []
const covered = []
const narrowed = []
const withheld = []

// integer ⊂ number：原 schema 写 number、我们写 integer 属于「收窄」。这些字段都是条数/跳数，
// 真实调用只会传整数，收窄不丢能力；但必须显式记下来，而不是当没看见。
const NARROWING_OK = new Set(['number->integer'])

for (const [vendorTool, entry] of vendorDefs) {
  const route = ROUTE[vendorTool]
  if (!route) { missing.push(`${vendorTool}（路由表里没有）`); continue }
  const target = unifiedByName.get(route.to)
  if (!target) { missing.push(`${vendorTool} → ${route.to}（统一工具不存在）`); continue }
  const props = target.parameters?.properties ?? {}
  const required = new Set(target.parameters?.required ?? [])
  const vendorProps = entry.def.parameters?.properties ?? {}
  const vendorRequired = entry.def.parameters?.required ?? []
  const paramMap = route.paramMap ?? {}

  let ok = true
  for (const [pname, pschema] of Object.entries(vendorProps)) {
    const mapped = paramMap[pname] ?? pname
    const holdKey = `${vendorTool}.${pname}`
    if (!(mapped in props) && WITHHELD[holdKey]) {
      withheld.push(holdKey)
      continue
    }
    if (!(mapped in props)) {
      missing.push(`${vendorTool}.${pname} → ${route.to}.${mapped}（统一工具里没这个参数）`)
      ok = false
      continue
    }
    // 类型一致性：原参数是什么类型，统一工具里至少还得接受它
    const wantType = pschema?.type
    const gotType = props[mapped]?.type
    if (wantType && gotType && wantType !== gotType) {
      const pair = `${wantType}->${gotType}`
      if (NARROWING_OK.has(pair)) narrowed.push(`${vendorTool}.${pname} ${pair}`)
      else {
        missing.push(`${vendorTool}.${pname} 类型 ${wantType} ↔ ${route.to}.${mapped} ${gotType}`)
        ok = false
      }
    }
  }
  // 因为「一个工具承载多个 action/mode」而没法在 schema 里写死的必填，用运行时校验兜：
  // 下面 1.2 会真的调 execute 断它必须报错，所以这里只记录、不算退化。
  const RUNTIME_GUARDED = {
    'memory_search.query': 'local 模式在 execute 里守（similar/graph 不需要 query）',
    'memory_find_similar.id': 'mode=similar 在 execute 里守',
    'nebula_ingest.provider': 'action=ingest 在 execute 里守',
    'nebula_ingest.items': 'action=ingest 在 execute 里守',
  }
  for (const req of vendorRequired) {
    const mapped = paramMap[req] ?? req
    if (required.has(mapped)) continue
    const key = `${vendorTool}.${req}`
    if (RUNTIME_GUARDED[key]) continue
    requiredLost.push(`${vendorTool}.${req} → ${route.to}.${mapped} 变成可选了`)
  }
  if (ok) covered.push(`${vendorTool}(${Object.keys(vendorProps).length})`)
}

check(missing.length === 0, '1.1 原工具的每个参数都还能传进去', missing.length ? missing.join('；') : `${covered.length} 个工具全过`)
// 双向钉：既要求「登记的确实没暴露」，也要求「没暴露的确实登记了」。只钉一头的话，
// 记账条目过期（统一工具后来真把它暴露了）会静默留着，白名单从此替真实退化打掩护。
check(
  withheld.length === Object.keys(WITHHELD).length,
  '1.1b 故意不暴露的参数都记账，记账也没过期',
  withheld.length
    ? `${withheld.join('、')}（理由写在 WITHHELD）`
    : 'WITHHELD 记着的那个参数现在在统一工具里有了——不是记账过期就是它被悄悄放出来了',
)
if (narrowed.length) console.log(`INFO  number→integer 收窄（条数/跳数，不影响真实调用）：${narrowed.join('；')}`)
check(requiredLost.length === 0, '1.2 原来必填的字段没有失守', requiredLost.join('；') || 'schema 必填或运行时守')

// 1.2b 真的调 execute，确认「因合并变成按 action 才必填」的字段确实会报错，而不是静默放过
async function expectThrow(toolName, args, keyword) {
  const tool = unifiedByName.get(toolName)
  try {
    await tool.execute(args, {})
    return `${toolName} 没报错（应报「${keyword}」）`
  } catch (err) {
    const msg = String(err?.message ?? err)
    return msg.includes(keyword) ? '' : `${toolName} 报错信息不含「${keyword}」：${msg}`
  }
}
const guardFails = []
for (const [toolName, args, keyword, label] of [
  ['memory_search', { mode: 'local', query: '  ' }, 'query', '本地检索缺 query'],
  ['memory_search', { mode: 'similar' }, 'id', 'similar 缺 id'],
  ['memory_admin', { action: 'ingest' }, 'provider', 'ingest 缺 provider'],
  ['memory_admin', { action: 'ingest', provider: 'x' }, 'items', 'ingest 缺 items'],
]) {
  const bad = await expectThrow(toolName, args, keyword)
  if (bad) guardFails.push(`${label}：${bad}`)
}
check(guardFails.length === 0, '1.2b 按 action 才必填的字段在运行时守住了', guardFails.join('；') || '4 条全报错')

// 统一工具不能有「没人用的空壳参数」：每个参数要么来自某个 vendor，要么在 EXTRA 里声明
const vendorParams = new Set()
for (const [, entry] of vendorDefs) for (const p of Object.keys(entry.def.parameters?.properties ?? {})) vendorParams.add(p)
const unexplained = []
for (const tool of unified) {
  const extra = new Set(EXTRA[tool.name] ?? [])
  for (const p of Object.keys(tool.parameters?.properties ?? {})) {
    if (vendorParams.has(p) || extra.has(p)) continue
    unexplained.push(`${tool.name}.${p}`)
  }
}
check(unexplained.length === 0, '1.3 没有来路不明的新参数', unexplained.join('；') || '全部有出处')

// 每个统一工具至少要接到一个原工具（或明确是组合入口）
const reached = new Set(Object.values(ROUTE).map((r) => r.to))
const orphans = unified.map((t) => t.name).filter((n) => !reached.has(n))
check(orphans.length === 0, '1.4 8 个统一工具都在承接原能力', orphans.join('；') || '无孤立工具')

// 动作枚举完整性：原来能做的事，统一工具的枚举里都得有
const cases = [
  ['memory_link', 'action', ['link', 'unlink', 'mute', 'unmute', 'path']],
  ['memory_admin', 'action', ['home', 'stats', 'hygiene', 'sources', 'ingest', 'cost', 'guide']],
  ['memory_search', 'mode', ['local', 'graph', 'bridge', 'similar']],
]
for (const [tool, prop, want] of cases) {
  const got = unifiedByName.get(tool)?.parameters?.properties?.[prop]?.enum ?? []
  const lack = want.filter((w) => !got.includes(w))
  check(lack.length === 0, `2.1 ${tool}.${prop} 枚举齐全`, lack.length ? `缺 ${lack.join(',')}` : got.join('/'))
}

// memory_dream 的参数必须仍然是「无参」，否则等于偷偷加了口子
const dreamProps = Object.keys(unifiedByName.get('memory_dream')?.parameters?.properties ?? {})
check(dreamProps.length === 0, '3.1 memory_dream 仍未收参数', dreamProps.join(',') || '无参数')

// links 的新形态（{id,note}）必须被 schema 接受，且旧形态（字符串）不丢
const links = unifiedByName.get('memory_remember')?.parameters?.properties?.links
const branches = links?.items?.oneOf ?? []
check(branches.some((b) => b.type === 'string'), '3.2 links 仍接受字符串 id')
check(branches.some((b) => b.type === 'object' && b.properties?.note), '3.3 links 接受 {id,note} 带连线理由')

try {
  rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
} catch {
  // Windows 上 sqlite 句柄偶尔还没释放：临时目录留着不碍事，别把审计结果搞成失败
}
console.log('')
if (failed > 0) {
  console.log(`FAILED：${failed} 项`)
  process.exit(1)
}
console.log('ALL PASS')
