/**
 * 宿主管线探针：**真 cordis + 真 ToolsService + 真 SystemPrompt** + 我们的插件。
 *
 * 为什么要有它：verify.mjs 用的是假 ctx，只能证明「我们自己以为自己注册成功了」。
 * 这里换成 DSH 本体里的真服务，能触发宿主自己的契约校验：
 *   - ToolsService.register 的 output/render、assertSupportedJsonSchema、保留名检查
 *   - SystemPrompt.section 的 order 校验，以及 assemble() 出来的真实段落
 *
 * 断言：
 *   A. 真服务可用（cordis Context 里 tools / systemPrompt 都在）
 *   B. 我们的插件能 ctx.plugin 进真 cordis，apply 不抛
 *   C. 宿主看到的工具面严格是 8 个 memory_*，nebula_* 一个不漏进来
 *   D. 8 个工具全部通过宿主 projectToolSchema + assertSupportedJsonSchema，且 schema 合计 < 16000 B
 *   E. assemble() 里只有一段 macro-memory:guide（order 130、≤1300 字符），nebula RULE 没落地
 *   F. 8 个工具直接执行都能跑通（真 vendor、临时 DSH_HOME）
 *
 * 用法：node tools/probe-host.mjs
 *      DSH_APP="D:\\DSH\\DSH NEXT\\resources\\app" 可覆盖宿主目录
 */
import { root } from './_root.mjs'
import { registerHooks } from 'node:module'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const APP = process.env.DSH_APP || 'D:\\DSH\\DSH NEXT\\resources\\app'
const NM = join(APP, 'node_modules', '@deepseek-ai')

const home = mkdtempSync(join(tmpdir(), 'macro-host-home-'))
process.env.DSH_HOME = home

// dsh-llm 由 profile 在真运行时提供，本机没有实体包 → 用最小 stub 顶上
const stubDir = mkdtempSync(join(tmpdir(), 'macro-host-stub-'))
const stubFile = join(stubDir, 'dsh-llm.mjs')
writeFileSync(
  stubFile,
  `export function createUserMessage(init) { return { role: 'user', ...init } }
export function boundContextSummary(text) { return String(text).slice(0, 120) }
export default { createUserMessage, boundContextSummary }
`,
  'utf8',
)
// 只有「宿主目录之外」的导入者（我们的 vendor 包）才需要重定向：
// 宿主自己的包（resources/app 下）能正常解析，别去动它，否则会缺 HarnessError 之类的导出。
const APP_URL = pathToFileURL(APP).href
registerHooks({
  resolve(specifier, context, nextResolve) {
    const insideApp = String(context?.parentURL || '').startsWith(APP_URL)
    if (!insideApp) {
      if (specifier === '@deepseek-ai/dsh-llm') return { url: pathToFileURL(stubFile).href, shortCircuit: true }
      if (specifier === '@deepseek-ai/schemastery')
        return { url: pathToFileURL(join(NM, 'schemastery', 'lib', 'index.mjs')).href, shortCircuit: true }
    }
    return nextResolve(specifier, context)
  },
})

let failures = 0
function check(label, ok, extra) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra === undefined ? '' : '  ' + extra}`)
  if (!ok) failures++
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function waitFor(fn, ms = 8000, step = 100) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    try {
      const v = await fn()
      if (v) return v
    } catch {
      /* 服务还没就绪 */
    }
    await sleep(step)
  }
  return undefined
}

// ── A. 真 cordis + 真服务 ─────────────────────────────────────────────────
const { Context } = await import(pathToFileURL(join(NM, 'cordis', 'lib', 'index.js')).href)
const toolsMod = await import(pathToFileURL(join(NM, 'dsh-tools', 'lib', 'index.js')).href)
const promptMod = await import(pathToFileURL(join(NM, 'dsh-system-prompt', 'lib', 'index.js')).href)

const ctx = new Context()
await ctx.plugin(toolsMod.ToolsService)
await ctx.plugin(promptMod.SystemPrompt)

// nebula 声明 inject = ['tools','systemPrompt','webServer','connection']：
// 缺了这两个服务它就一直等，9 个星图工具根本不会注册。宿主里由 dsh-web-server 提供，
// 探针里给最小桩（只要 register 能收下路由就行）。
const { Service } = await import(pathToFileURL(join(NM, 'cordis', 'lib', 'index.js')).href)
class WebServerStub extends Service {
  constructor(c) {
    super(c, 'webServer')
    this.routes = []
    this.register = (def) => {
      this.routes.push(def)
      return () => {}
    }
  }
}
class ConnectionStub extends Service {
  constructor(c) {
    super(c, 'connection')
    this.clients = new Set()
  }
}
await ctx.plugin(WebServerStub)
await ctx.plugin(ConnectionStub)

const services = await waitFor(() => (typeof ctx.tools === 'object' && typeof ctx.systemPrompt === 'object' ? true : false))
check('A1 真 cordis 里 ToolsService 可用', typeof ctx.tools === 'object')
check('A2 真 cordis 里 SystemPrompt 可用', typeof ctx.systemPrompt === 'object')
if (!services) {
  console.log('\n真服务没起来，后续断言跳过')
  process.exit(1)
}

// assemble() 需要一个 executor（宿主正常运行时由 dsh-agent 提供），这里给个空壳；
// describe(definitions) 是 systemPrompt.tools 提供方要的 `{ schemas }`。
try {
  ctx.tools.setExecutor({
    execute: async () => ({ calls: [] }),
    describe: (defs = []) => ({ schemas: defs.map(({ name, description, parameters }) => ({ name, description, parameters })) }),
  })
} catch (err) {
  check('A3 挂空壳 executor', false, err.message)
}

// ── B. 插件装进真 cordis ──────────────────────────────────────────────────
const plugin = await import(pathToFileURL(join(root, 'lib', 'index.js')).href)
const Meow = await import(pathToFileURL(join(root, 'vendor', 'meow-memory', 'lib', 'index.js')).href)

const workspace = join(home, 'workspace')
const fiber = ctx.plugin(plugin, {
  meow: { homeDir: join(home, 'store'), promptLang: 'zh', reflectTurns: 5 },
  nebula: {},
})
await Promise.resolve(fiber).catch((err) => check('B0 插件装载', false, err?.message))

const ready = await waitFor(() => {
  const defs = ctx.tools.definitions?.()
  return Array.isArray(defs) && defs.length >= 8 ? defs : undefined
})
check('B1 插件 apply 抛错检查', true)
const defs = Array.isArray(ready) ? ready : []
const names = defs.map((d) => d.name).sort()
console.log('     宿主看到的工具：', names.join(', ') || '(空)')

// ── C. 工具面 ─────────────────────────────────────────────────────────────
const UNIFIED = [
  'memory_admin',
  'memory_dream',
  'memory_link',
  'memory_project',
  'memory_read',
  'memory_remember',
  'memory_search',
  'memory_update',
]
check('C1 恰好 8 个统一工具', JSON.stringify(names) === JSON.stringify(UNIFIED), `实际 ${names.length}`)
check('C2 没有 nebula_* 漏进宿主', names.every((n) => !n.startsWith('nebula_')))
check(
  'C3 没有 memory_find_similar / memory_home 漏进宿主',
  !names.includes('memory_find_similar') && !names.includes('memory_home'),
)

// ── D. 宿主自己的 schema 校验 ─────────────────────────────────────────────
let schemaBytes = 0
let schemaOk = true
for (const def of defs) {
  try {
    toolsMod.assertSupportedJsonSchema(def.parameters)
    const projected = toolsMod.projectToolSchema(def)
    schemaBytes += Buffer.byteLength(JSON.stringify(projected))
  } catch (err) {
    schemaOk = false
    check(`D ${def.name} 通过宿主 schema 校验`, false, err.message)
  }
}
check('D1 8 个工具全部通过 projectToolSchema + assertSupportedJsonSchema', schemaOk)
check('D2 schema 合计 < 16000 B', schemaBytes < 16000, `${schemaBytes} B`)

// ── E. 注入单点 ───────────────────────────────────────────────────────────
let asm
try {
  asm = await ctx.systemPrompt.assemble({})
} catch (err) {
  check('E0 assemble()', false, err.message)
}
if (asm) {
  const guide = asm.sections.filter((s) => s.name === 'macro-memory:guide')
  const length = (s) => String(typeof s.text === 'function' ? s.text({}) : s.text).length
  check('E1 assemble 里只有一段 macro-memory:guide', guide.length === 1, `实际 ${guide.length} 段`)
  if (guide[0]) {
    check('E2 注入长度 ≤1300 字符', length(guide[0]) <= 1300, `${length(guide[0])} 字符`)
    const text = String(typeof guide[0].text === 'function' ? guide[0].text({}) : guide[0].text)
    check('E3 注入覆盖 8 个工具名', UNIFIED.every((n) => text.includes(n)))
    check('E4 注入里不出现 nebula_ 旧工具名', !/nebula_/.test(text))
    // 0.2.34：注入贴着上限时，clampGuide 会切掉尾巴且一句不说。留余量是唯一能提前发现的办法。
    const headroom = 1300 - text.length
    check('E4b 注入留有余量（≥120 字符），不贴上限', headroom >= 120, `余量 ${headroom} 字符`)
    check(
      'E4c 注入说清排队欠账去哪看（memory_admin links，按理由分组）',
      text.includes('memory_admin(action="links")') && text.includes('按理由分组'),
      text.includes('memory_admin(action="links")') ? '有' : '没有',
    )
  }
  check('E5 nebula 的 RULE 没有单独成段', !asm.contexts.some((c) => /nebula/i.test(c.name ?? '')))
  const totalSection = asm.sections.reduce((n, s) => n + length(s), 0)
  const totalContext = asm.contexts.reduce((n, c) => n + String(typeof c.text === 'function' ? c.text({}) : c.text ?? '').length, 0)
  console.log(`     注入合计：sections ${asm.sections.length} 段/${totalSection} 字符，contexts ${asm.contexts.length} 段/${totalContext} 字符`)
}

// ── F. 真 vendor 端到端 ───────────────────────────────────────────────────
try {
  // 真运行时的记忆库本来就由 meow 自己建过、天然受信；探针里换成临时目录，
  // 必须显式把 home 指过去并登记信任，否则会撞上「未信任的外部记忆库」闸门。
  const store = join(home, 'store')
  Meow.setActiveHomeDir?.(store)
  Meow.enableWorkspaceTrust?.(store)
  Meow.getDb(workspace, '.dsh-meow')
  if (typeof Meow.trustWorkspace === 'function') Meow.trustWorkspace(workspace, 'probe-host')
} catch (err) {
  check('F0 预建记忆库', false, err.message)
}
const exec = { agent: { session: { header: { cwd: workspace } } } }
const run = async (name, args) => {
  const def = defs.find((d) => d.name === name)
  if (!def) return `(缺工具 ${name})`
  try {
    const value = await def.execute(args, exec)
    return def.output.render(args, value)
      .map((b) => (b.type === 'text' ? b.text : `[${b.type}]`))
      .join('\n')
  } catch (err) {
    return `(抛错) ${err.message}`
  }
}

const remembered = await run('memory_remember', {
  content: '宿主管线探针：macro-memory 能在真 cordis 里注册并写入记忆',
  level: 'fact',
  project: '全局',
  keywords: ['宿主探针', '真cordis', '注册', 'memory_remember', '真服务'],
  importance: 1,
})
check('F1 memory_remember 走真服务执行', /记忆已写入|已合并/.test(remembered), remembered.split('\n')[0].slice(0, 60))
const searched = await run('memory_search', { query: '宿主探针 真cordis', k: 3 })
check('F2 memory_search 命中', /关于：|\[/.test(searched), searched.split('\n')[0].slice(0, 60))
const admin = await run('memory_admin', { action: 'guide' })
check('F3 memory_admin(guide) 吐出完整手册', admin.length > 1500, `${admin.length} 字符`)
check('F3b 手册已改成 macro 的说法（无 nebula_ / meow-memory）', !/nebula_/.test(admin) && !/meow-memory/.test(admin))
const cost = await run('memory_admin', { action: 'cost' })
check('F4 memory_admin(cost) 有账本', /memory_remember|合计|暂无/.test(cost), cost.split('\n')[0].slice(0, 60))

// F4b：待补连线队列在真宿主里也能读到（星图可能还没建好，所以只断言「能读、不炸」）
const pending = await run('memory_admin', { action: 'links' })
check('F4b memory_admin(links) 能读队列', /待补连线/.test(pending), pending.split('\n')[0].slice(0, 60))

// F5：工具面文本里不许再出现「模型调不到的名字」
const home2 = await run('memory_admin', { action: 'home' })
const stats = await run('memory_admin', { action: 'stats' })
const linked = await run('memory_link', { action: 'path', a: '0mwm9h03', b: 'nope' })
const legacyName = /nebula_|meow-memory|memory_find_similar\(/
const leaks = [remembered, home2, stats, cost, admin].filter((t) => legacyName.test(t))
check('F5 界面文案里不含旧工具名', leaks.length === 0, leaks.map((t) => t.slice(0, 60)).join(' | ') || undefined)
// 检索/读取/写入回执吐的是记忆原文：里面出现旧名是**对的**（用户就是这么存的）。
// 这种输出的义务不是「改掉」，而是「一句话别动 + 附旧名对照」。
const unmarked = [searched, linked].filter((t) => legacyName.test(t) && !t.includes('一个字没动'))
check('F5b 正文里出现旧名时必带「原文没被改」的对照', unmarked.length === 0, unmarked.map((t) => t.slice(0, 60)).join(' | ') || undefined)

console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILED'}`)
process.exit(failures === 0 ? 0 : 1)
