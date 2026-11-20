/**
 * 自检：不启动 DSH，验证融合后的两个半侧都能成立。
 *
 *   A. 宿主侧：import('./lib/index.js') 拿到的必须是「融合层」的形状——
 *      8 个统一 memory_* 工具、只有一段 L0 注入、子插件的工具与注入被接管不下发。
 *      （真 vendor 的端到端联动看 tools/probe-fusion.mjs，这里只查装配契约。）
 *      @deepseek-ai/dsh-llm 用 registerHooks 就地指向一个 2 符号 stub
 *      （真实运行时由 DSH 的 profile resolution 提供，本机 profile 里没有实体）。
 *
 *   B. 客户端侧：在 stub 出来的 window 上执行 lib/client.js，
 *      确认三个模块 id 都已注册；再把组合层的 factory 拉起来，确认导出形状与
 *      apply 行为（两个 UI 子插件各挂一次）。
 *
 * 用法：node verify.mjs
 */
import { registerHooks } from 'node:module'
import { readFileSync, writeFileSync, mkdtempSync, readdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { root } from './tools/_root.mjs'
const noop = () => {}
let failures = 0
function check(label, ok, extra) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra === undefined ? '' : '  ' + extra}`)
  if (!ok) failures++
}

// ── A. 宿主侧 ───────────────────────────────────────────────────────────────
const stubDir = mkdtempSync(join(tmpdir(), 'macro-memory-stub-'))
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

const host = await import(pathToFileURL(join(root, 'lib', 'index.js')).href)
check('host: name', host.name === 'macro-memory', host.name)
check('host: version 0.2.x', /^0\.2\./.test(String(host.version)), host.version)
check('host: inject = [tools]', JSON.stringify(host.inject) === JSON.stringify(['tools']), JSON.stringify(host.inject))
check('host: apply is function', typeof host.apply === 'function')
// [0.2.79] 宿主设置页只认「导出 Config + 路径落在 volatile 节点下」的键：
// 以前不导出 Config，describe() 里根本没有这个条目，设置页只能报「不支持设置写入」。
check('host: 导出 Config（不导出就永远进不了设置页）', typeof host.Config?.toJSON === 'function')
check('host: Config 根是 volatile（写入原地生效，不重挂插件）', host.Config?.meta?.volatile === true)
{
  const form = host.Config.toJSON()
  const keys = Object.keys(host.Config.dict ?? {})
  const flat = ['enabled', 'projectDir', 'homeDir', 'hitTopK', 'titleMax', 'reflect', 'reflectTurns', 'promptLang', 'dream']
  check('host: Config 平铺了 meow 的字段（设置页靠它们写 meow 自己的配置）', flat.every((key) => keys.includes(key)), keys.join(','))
  const own = ['compatAliases', 'guideMaxChars', 'toolWaitMs', 'flushThrottleMs', 'nebula', 'macro', 'meow']
  check('host: Config 平铺了融合层 4 个键 + 3 个兼容段（否则写入时被 strip 剃掉）', own.every((key) => keys.includes(key)), keys.join(','))
  check('host: 只有根一个 volatile（schemastery 不许根与子字段同时 volatile）', (JSON.stringify(form).match(/"volatile":true/g) ?? []).length === 1)
  const parsed = host.Config({ compatAliases: true, hitTopK: 4, nebula: {}, meow: { homeDir: 'dsh-storage' } })
  check('host: Config 解析出根 volatile 引用', host.isVolatileRef(parsed) === true)
  const snap = host.readConfigRoot(parsed)
  check('host: 根引用解包后带上用户值', snap.compatAliases === true && snap.hitTopK === 4, JSON.stringify(snap).slice(0, 120))
  check('host: 兼容段原样保留（profile 里的 meow/nebula 不会被剃）', snap.meow?.homeDir === 'dsh-storage' && snap.nebula !== undefined)
  const cfg = host.resolveConfig(parsed)
  check('host: resolveConfig 把根字段与旧 meow 段合到一起', cfg.meow.hitTopK === 4 && cfg.meow.homeDir === 'dsh-storage', JSON.stringify(cfg.meow).slice(0, 160))
  check('host: resolveConfig 的 macro 段拿到根上的 4 个键', cfg.macro.compatAliases === true && cfg.macro.toolWaitMs === host.MACRO_DEFAULTS.toolWaitMs)
}
check('host: MACRO_DEFAULTS 有默认值', host.MACRO_DEFAULTS?.compatAliases === false && host.MACRO_DEFAULTS?.guideMaxChars > 0)

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

/** 最小 cordis ctx 替身：只做装配契约断言，不真跑 vendor。 */
function makeHostCtx() {
  const tools = new Map()
  const prompts = []
  const plugins = []
  const services = {
    tools: { register: (def) => (tools.set(def.name, def), noop) },
    systemPrompt: { section: (decl) => (prompts.push(decl), noop), context: (decl) => (prompts.push(decl), noop) },
  }
  const base = {
    get: (name) => services[name],
    effect(fn) {
      const d = typeof fn === 'function' ? fn() : undefined
      return typeof d === 'function' ? d : noop
    },
    on: () => noop,
    inject: (_deps, cb) => (typeof cb === 'function' ? cb(base) : base),
    plugin(mod, cfg) {
      plugins.push({ name: mod?.name, cfg })
      return noop
    },
    tools: services.tools,
    systemPrompt: services.systemPrompt,
    logger: { debug: noop, info: noop, warn: noop, error: noop },
  }
  return { ctx: base, tools, prompts, plugins }
}

{
  const h = makeHostCtx()
  host.apply(h.ctx, { meow: { promptLang: 'zh' }, nebula: {} })
  check('装配: 两个子插件挂上', h.plugins.length === 2, h.plugins.map((p) => p.name).join(' + '))
  check('装配: 子插件名字保留', h.plugins[0]?.name === 'meow-memory' && h.plugins[1]?.name === 'memory-nebula')
  check('装配: meow 配置原样透传', h.plugins[0]?.cfg?.promptLang === 'zh')

  const names = [...h.tools.keys()].sort()
  check('装配: 宿主工具 = 8 个 memory_*', JSON.stringify(names) === JSON.stringify(UNIFIED), names.join(','))
  check('装配: 没有 nebula_* 漏进宿主', !names.some((n) => n.startsWith('nebula_')))
  check('装配: 没有 memory_find_similar / memory_home 漏进宿主', !names.includes('memory_find_similar') && !names.includes('memory_home'))

  check('注入: 只有一段', h.prompts.length === 1, String(h.prompts.length))
  const guide = h.prompts[0]
  check('注入: name = macro-memory:guide', guide?.name === 'macro-memory:guide', String(guide?.name))
  check('注入: order = 130', guide?.order === 130, String(guide?.order))
  check('注入: 文本是字符串', typeof guide?.text === 'string')
  check('注入: ≤1300 字符', typeof guide?.text === 'string' && guide.text.length <= 1300, String(guide.text?.length))
  check('注入: 宏口吻（提到 macro-memory）', String(guide?.text).includes('macro-memory'))
  check('注入: 覆盖 8 个工具名', UNIFIED.every((n) => String(guide?.text).includes(n)))

  const schemaSizes = [...h.tools.values()]
    .map((d) => JSON.stringify(d.parameters ?? {}).length)
    .reduce((a, b) => a + b, 0)
  check('成本: 8 个工具 schema 合计 < 16000 B', schemaSizes < 16000, `${schemaSizes} B`)
}

{
  // compatAliases 打开时，把子插件原名工具补回来。
  const h = makeHostCtx()
  host.apply(h.ctx, { compatAliases: true })
  const names = [...h.tools.keys()]
  check('兼容别名: 主力 8 个仍在', UNIFIED.every((n) => names.includes(n)))
  check('兼容别名: nebula_* 补回 9 个', names.filter((n) => n.startsWith('nebula_')).length === 9, names.filter((n) => n.startsWith('nebula_')).join(','))
  check('兼容别名: memory_find_similar / memory_home 补回', names.includes('memory_find_similar') && names.includes('memory_home'))
}

// ── A2. 文案归口（brand.js）─────────────────────────────────────────────────
{
  const { brandText, BRAND_MAP } = await import('./lib/macro/brand.js')
  const sample = '可以先用 nebula_recall 搜一下；也可以用 memory_find_similar；meow-memory 的库在 memory_home。'
  const branded = brandText(sample)
  check('文案: 旧工具名全部换口', !/nebula_|memory_find_similar|memory_home|meow-memory/.test(branded), branded)
  check('文案: nebula_recall → memory_search(mode="graph")', branded.includes('memory_search（mode="graph"）'))
  check('文案: compatAliases=true 时原样返回', brandText(sample, { aliases: true }) === sample)
  check('文案: 映射表覆盖 9 个 nebula 工具', BRAND_MAP.filter(([from]) => from.startsWith('nebula_')).length === 9)
  check('文案: 空值不炸', brandText('') === '' && brandText(undefined) === undefined)
}

// ── A3. 待补连线队列（links.js）：纯函数契约，不碰星图 ──────────────────────
{
  const links = await import('./lib/macro/links.js')
  const { mkdtempSync: mkdt } = await import('node:fs')
  const { rmSync: rm } = await import('node:fs')
  const oldHome = process.env.DSH_HOME
  const tmpHome = mkdt(join(tmpdir(), 'macro-verify-links-'))
  process.env.DSH_HOME = tmpHome
  try {
    const clear = () => {
      for (const e of links.readPending()) links.dropPending(e.a, e.b)
    }
    clear()
    check('队列: 空时长度为 0', links.readPending().length === 0)
    links.queuePending('mem-1', 'mem-2', 'note-a', '测试')
    links.queuePending('mem-1', 'mem-2', 'note-b', '测试')
    check('队列: 同一条不重复排', links.readPending().length === 1, String(links.readPending().length))
    links.queuePending('mem-1', 'mem-3')
    check('队列: 再加一条', links.readPending().length === 2)
    check('队列: 自连不入队', links.queuePending('mem-1', 'mem-1') === false)
    check('队列: 空 id 不入队', links.queuePending('', 'mem-2') === false)
    links.dropPending('mem-1', 'mem-2')
    check('队列: drop 只摘一条', links.readPending().length === 1, String(links.readPending().length))
    // 过期条目要被过滤掉（TTL 之外的欠账不再追）
    const stale = { a: 'mem-9', b: 'mem-8', note: '', ts: Date.now() - links.PENDING_TTL_MS - 1000, reason: '' }
    writeFileSync(links.pendingPath(), `${JSON.stringify(stale)}\nbad-json\n`, 'utf8')
    check('队列: 过期条目被过滤', links.readPending().length === 0)
    check('队列: 坏行不炸', links.readPending().length === 0)
    check('队列: 面板文案可用', links.pendingReport().includes('待补连线'))
    // 星图那两句报错要能认出来；但「找不到」不算永久失败（0.2.30：也可能只是还没建进图）
    check('队列: 认得出「自己连自己」', links.isSelfPairText('不能把一条记忆和它自己配成一对：x') === true)
    check('队列: 认得出「找不到这两条记忆」', links.saysMissingNodes('找不到这两条记忆：a / b') === true)
    check('队列: 两句都认，但分开判', links.isSelfPairText('找不到这两条记忆：a / b') === false && links.saysMissingNodes('不能把一条记忆和它自己配成一对：x') === false)
    check('队列: 普通失败不算（要留着重试）', links.saysMissingNodes('星图引擎正在建图') === false && links.isSelfPairText('星图引擎正在建图') === false)
    check('队列: 「找不到」有宽限期这个数', Number.isFinite(links.MISSING_GRACE_MS) && links.MISSING_GRACE_MS >= 5 * 60 * 1000)
    // resolve 归不出完整 id 的条目，补连一轮就该被摘掉，而不是烂到 TTL
    links.queuePending('mem-7', 'gone-8', 'n', '测试')
    const round = await links.flushPending({
      tryCall: async () => ({ entry: {}, text: '已固化连线：x ↔ y' }),
      isLinked: links.isLinkedText,
      resolve: async (id) => (String(id).startsWith('gone-') ? null : String(id)),
      // 预算给足：这条测的是「归不出 id 就摘」，不是预算（0.2.28 起预算小于 MIN_STEP_MS 会一条都不试）
      budgetMs: 1200,
      limit: 5,
    })
    check('队列: 归不出的条目被清掉', round.dropped === 1 && links.readPending().length === 0, JSON.stringify(round))
    clear()
  } finally {
    if (oldHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = oldHome
    try {
      rm(tmpHome, { recursive: true, force: true, maxRetries: 5 })
    } catch {
      /* Windows 句柄偶尔锁住 */
    }
  }
}

// ── A4. 结构自检：工具定义一文件一个，装配器不许再长回巨石 ────────────────
{
  const macroDir = join(root, 'lib', 'macro')
  const defsDir = join(macroDir, 'defs')
  const toolsSrc = readFileSync(join(macroDir, 'tools.js'), 'utf8')
  const defFiles = readdirSync(defsDir).filter((f) => f.endsWith('.js')).sort()
  check('结构: defs 恰好 8 个工具文件', defFiles.length === 8, defFiles.join(','))
  check(
    '结构: 文件名与工具名对齐',
    defFiles.join(',') === 'admin.js,dream.js,link.js,project.js,read.js,remember.js,search.js,update.js',
    defFiles.join(','),
  )
  check('结构: tools.js 不再肥大（<6 KB）', toolsSrc.length < 6144, `${toolsSrc.length} B`)
  check('结构: tools.js 不直接写工具 schema', !toolsSrc.includes('additionalProperties: false'), 'schema 应留在 defs')
  check('结构: 装配器恰好装配 8 个', (toolsSrc.match(/create[A-Z][A-Za-z]+\(\{ flow/g) ?? []).length === 8)
  const badDeps = defFiles.filter((f) => {
    const src = readFileSync(join(defsDir, f), 'utf8')
    return src.includes("from '../tools.js'") || src.includes('from "../tools.js"')
  })
  check('结构: defs 不反向依赖 tools.js', badDeps.length === 0, badDeps.join(','))
  const sharedSrc = readFileSync(join(macroDir, 'shared.js'), 'utf8')
  check('结构: 共用形状只在 shared.js 定义一次', sharedSrc.includes('export const TEXT_OUT') && !toolsSrc.includes('export const TEXT_OUT'))
}

// ── A5. 体检测试：doctor.mjs 只读、只依赖 node 内置与本地模块 ──────────────
{
  const docPath = join(root, 'tools', 'doctor.mjs')
  const docSrc = readFileSync(docPath, 'utf8')
  check('体检: doctor.mjs 存在且成形（>3 KB）', docSrc.length > 3072, `${docSrc.length} B`)
  const externals = (docSrc.match(/from '([^']+)'/g) ?? [])
    .map((m) => m.slice(6, -1))
    .filter((s) => !s.startsWith('node:') && !s.startsWith('.'))
  check('体检: doctor 不引第三方依赖', externals.length === 0, externals.join(','))
  // 只读：不许出现写盘 API（体检报告可以给建议，但不能自己动手）
  const writers = ['writeFileSync', 'rmSync', 'unlinkSync', 'mkdirSync', 'copyFileSync', 'renameSync', 'appendFileSync']
    .filter((api) => docSrc.includes(api))
  check('体检: doctor 不写盘', writers.length === 0, writers.join(','))
  const sections = [
    '== 版本与身份 ==',
    '== vendor ↔ profile 同步 ==',
    '== 加载面 ==',
    '== 补丁账本 ==',
    '== vendor 账本 ==',
    '== 自检基线 ==',
    '== 存储层 ==',
    '== 运行时 ==',
    '== 文档声称 ==',
    '== 备份 ==',
  ]
  const missing = sections.filter((s) => !docSrc.includes(s))
  check('体检: 十段齐全', missing.length === 0, missing.join(','))
  check('体检: 用真函数量注入长度', docSrc.includes('clampGuide') && docSrc.includes('readPending'))
  // vendor/ 必须进同步比对：补丁打在 vendor 上，只比 lib/tools 会漏掉「vendor 改了没同步」
  check(
    '体检: 同步比对含 vendor 且两棵树对称',
    docSrc.includes('function treeSync(aRoot, bRoot)') &&
      docSrc.includes("walk(join(r, 'vendor'))") &&
      docSrc.includes('FILES_AT_ROOT') &&
      docSrc.includes('root === PROFILE ? treeSync(PROFILE, VENDOR) : treeSync(root, PROFILE)'),
  )
  // README 声称与实物一致性由 doctor 自己核，verify 只守「它确实在核」这件事
  // 0.2.81 起文档拆成两份：账本（docs/INTERNAL.md）与门面（README.md），doctor 两段各核一半
  check('体检: 核文档声称', docSrc.includes('内部日志提到的脚本都存在') && docSrc.includes('字节数是最新的'))
}

// ── A6. 真引擎探针存在，且没被降级成 stub（0.2.8）───────────────────────────
{
  const graphSrc = readFileSync(join(root, 'tools', 'probe-graph.mjs'), 'utf8')
  check('端到端: probe-graph.mjs 存在且成形（>6 KB）', graphSrc.length > 6144, `${graphSrc.length} B`)
  const must = ['memory-nebula', 'window-index.json', 'workspace.json', 'memory_admin', 'DatabaseSync']
  const missing = must.filter((s) => !graphSrc.includes(s))
  check('端到端: 用真工作区布局 + 真 meow 库', missing.length === 0, missing.join(','))
  check('端到端: 断言星图连接数（不是只断言文本非空）', graphSrc.includes("'连接'"), '')
  check('端到端: 跑完清掉临时 DSH_HOME', graphSrc.includes('rmSync(home'))
}

// ── A7. vendor 补丁账本：打在第三方引擎上的改动必须能被机器找回来（0.2.9）──
{
  const recallPath = join(root, 'vendor', 'dsh-memory-nebula', 'lib', 'host', 'recall.js')
  const recallSrc = readFileSync(recallPath, 'utf8')
  check('补丁: recall.js 带 macro-fusion 标记', recallSrc.includes('[macro-fusion 0.2.9]'), '')
  check('补丁: 有 includeInactive 出口（需要看归档时能关掉）', recallSrc.includes('const includeInactive = opts.includeInactive === true'))
  check('补丁: 归档/删除在结果位与种子上都被排除', /const selectable = [\s\S]{0,220}archived[\s\S]{0,80}deleted/.test(recallSrc))
  const bridgePath = join(root, 'vendor', 'dsh-memory-nebula', 'lib', 'host', 'bridge.js')
  const bridgeSrc = readFileSync(bridgePath, 'utf8')
  check('补丁: 与 bridge.js 的 statusFactor 同口径（archived 计 0）', /s === 'archived' \|\| s === 'deleted'\) return 0/.test(bridgeSrc), '')
  // doctor 的补丁账本必须记着这一条，否则升级后没人知道要去补
  const docSrc = readFileSync(join(root, 'tools', 'doctor.mjs'), 'utf8')
  check('补丁: doctor 账本里有 recall 这一条', docSrc.includes('[macro-fusion 0.2.9]') && docSrc.includes('recall.js'))
  // 探针必须真能区分「命中了」和「没命中」：miss 文案会回显 query，只用 includes 会假通过
  const graphSrc = readFileSync(join(root, 'tools', 'probe-graph.mjs'), 'utf8')
  check('补丁: probe-graph 有归档断言且不用 includes(query) 判命中', graphSrc.includes('归档后星图检索不再命中') && graphSrc.includes('const miss ='))
}

// ── A8. 星图缺席时的降级：以 meow 为主，星图挂了记忆照样要能查（0.2.10）──
{
  const read = (p) => readFileSync(join(root, 'lib', 'macro', p), 'utf8')
  const searchSrc = read('defs/search.js')
  check('降级: graph/bridge 走 tryCall 不硬抛', /mode === 'graph' \|\| mode === 'bridge'[\s\S]{0,600}flow\.tryCall\(tool/.test(searchSrc))
  check('降级: 星图缺席时退回本地检索并说明原因', searchSrc.includes('星图这次没接上，先只给本地检索结果'))
  check('降级: 没 query 时讲清怎么兜住', searchSrc.includes('给个 query 我就能先用本地检索兜住'))
  const linkSrc = read('defs/link.js')
  check('降级: unlink/mute/path 也走 tryCall', /flow\.tryCall\(\s*action === 'path' \? 'nebula_path' : 'nebula_link'/.test(linkSrc))
  check('降级: 改星图的动作失败时说清记忆没受影响', linkSrc.includes('记忆本身没受影响'))
  const adminSrc = read('defs/admin.js')
  check('降级: 星图面板统一走 graphPanel', adminSrc.includes('const graphPanel = async (name, payload, what, miss)') && !/flow\.call\('nebula_/.test(adminSrc))
  check('降级: 推入外部记忆缺席时说清一条都没进去', adminSrc.includes('这批外部记忆一条都没推进去'))
  // 硬约定：lib/macro 里任何地方都不许对 nebula_* 直接 flow.call（只有 meow 自己的工具可以）
  const hard = []
  for (const f of [...readdirSync(join(root, 'lib', 'macro')).filter((n) => n.endsWith('.js')), ...readdirSync(join(root, 'lib', 'macro', 'defs')).map((n) => join('defs', n))]) {
    const src = read(f)
    if (/flow\.call\('nebula_/.test(src)) hard.push(f)
  }
  check('降级: lib/macro 不再对 nebula_* 直接 call', hard.length === 0, hard.join(','))
  const fusionSrc = readFileSync(join(root, 'tools', 'probe-fusion.mjs'), 'utf8')
  for (const key of ['G1 星图缺席时 mode=graph 退回本地检索', 'G6 星图缺席时 unlink 说明记忆没受影响', 'G8 星图缺席时读记忆只出正文', 'G10 星图面板缺席时不甩内部错误']) {
    check(`降级: probe-fusion 有断言「${key}」`, fusionSrc.includes(key), '')
  }
  // 自检脚本自己不许写主人的生产账本：会真跑工具的脚本一律把 DSH_HOME 指到临时目录
  const toolDir = join(root, 'tools')
  const dirty = readdirSync(toolDir)
    .filter((f) => f.endsWith('.mjs'))
    .filter((f) => {
      const src = readFileSync(join(toolDir, f), 'utf8')
      return /createUnifiedTools|host\.apply\(/.test(src) && !src.includes('process.env.DSH_HOME')
    })
  check('降级: 会真跑工具的脚本都沙箱 DSH_HOME', dirty.length === 0, dirty.join(','))
  check(
    '降级: coverage-audit 用临时 DSH_HOME（不再往待补队列里留假欠账）',
    readFileSync(join(toolDir, 'coverage-audit.mjs'), 'utf8').includes('macro-audit-home-'),
  )
}

// ── A9. 面板口径收口：一个插件对外只有一个名字（0.2.11）────────────────────
{
  const clientPath = join(root, 'lib', 'client.js')
  const client = readFileSync(clientPath, 'utf8')
  // meow 设置面板的标题在词典里：zh 是 \u 转义，en/pt 是字面量
  check('口径: 产物里设置面板标题已叫「宏记忆」', client.includes('"settings.title": "\\u5B8F\\u8BB0\\u5FC6"'))
  check('口径: 产物里没有旧的「喵记忆」', !client.includes('"settings.title": "\\u55B5\\u8BB0\\u5FC6"'))
  check('口径: 英文设置标题已叫 Macro Memory', client.includes('"settings.title": "Macro Memory"') && !client.includes('"settings.title": "Meow memory"'))
  // 改名必须写在构建脚本里，否则下一次 node build.mjs 就退回旧名（产物是生成物）
  const build = readFileSync(join(root, 'build.mjs'), 'utf8')
  check('口径: build.mjs 里钉着词典改名', build.includes('"settings.title": "\\\\u55B5\\\\u8BB0\\\\u5FC6"') && build.includes('function replaceN('))
  // 星图子应用：显示名、窗口标题、画布水印、侧栏标签四处都得跟上
  const web = (p) => readFileSync(join(root, 'vendor', 'dsh-memory-nebula', 'lib', 'web', p), 'utf8')
  const i18n = web('i18n.js')
  check('口径: 星图应用带改名标记', i18n.includes('[macro-fusion 0.2.11]'))
  check('口径: i18n 里「宏记忆 · 星图」的英文是 Macro Memory · Graph', i18n.includes('"宏记忆 · 星图": "Macro Memory · Graph"'))
  check('口径: 窗口标题两种语言都改了', i18n.includes("lang === 'en' ? 'Macro Memory · Graph' : '宏记忆 · 星图'"))
  const leftovers = ['index.html', 'app.js', 'render.js'].filter((f) => web(f).includes('记忆星图'))
  // i18n 允许留一处：文件头的改名说明（「原来叫『记忆星图』」）。除它之外一处都不许有。
  const i18nHits = i18n.split('记忆星图').length - 1
  const i18nOnlyInNote = i18nHits === 1 && /原来叫「记忆星图」/.test(i18n)
  check('口径: 星图前端没有旧名残留', leftovers.length === 0 && i18nOnlyInNote, leftovers.concat(i18nOnlyInNote ? [] : ['i18n.js']).join(','))
  check('口径: 画布水印改成 MACRO MEMORY', web('app.js').includes("g.fillText('MACRO MEMORY'"))
  check(
    '口径: 侧栏/iframe 标签与面板同名',
    readFileSync(join(root, 'vendor', 'dsh-memory-nebula', 'lib', 'client.js'), 'utf8').includes("var LABEL = '宏记忆 · 星图'"),
  )
  const doctorSrc = readFileSync(join(root, 'tools', 'doctor.mjs'), 'utf8')
  check('口径: 体检账本记着这条补丁', doctorSrc.includes('[macro-fusion 0.2.11]') && doctorSrc.includes("var LABEL = '宏记忆 · 星图'"))
  // 「门牌」不止前端四处：注入横幅、工具描述、stats 抬头、口令页、离线快照、导出抬头、CLI 抬头都是人能看见的字
  const neb = (p) => readFileSync(join(root, 'vendor', 'dsh-memory-nebula', p), 'utf8')
  const nebIndex = neb(join('lib', 'index.js'))
  check('口径: 注入横幅叫「宏记忆 · 星图」', nebIndex.includes('【宏记忆 · 星图 memory-nebula】'))
  check('口径: 工具描述与 stats 抬头同名', nebIndex.includes('看宏记忆 · 星图的整体状况') && nebIndex.includes('`宏记忆 · 星图：${s.nodes}'))
  check('口径: 口令页标题同名', neb(join('lib', 'host', 'http.js')).includes('<title>宏记忆 · 星图 · 需要口令</title>'))
  // 快照标题的 needle 必须和 index.html 的 <title> 一字不差，否则 put() 会抛「找不到 标题」
  const share = neb(join('lib', 'host', 'share.js'))
  check(
    '口径: 离线快照的 needle 与页面标题一致',
    share.includes("'<title>宏记忆 · 星图</title>'") && web('index.html').includes('<title>宏记忆 · 星图</title>'),
  )
  check('口径: 导出抬头与 CLI 抬头同名', neb(join('lib', 'host', 'nebula.js')).includes('# 宏记忆 · 星图导出') && neb(join('lib', 'standalone.mjs')).includes('宏记忆 · 星图独立引擎'))
  check('口径: 融合层自己的工具描述不再叫旧名', !readFileSync(join(root, 'lib', 'macro', 'defs', 'link.js'), 'utf8').includes('记忆星图'))
}

// ── A10. 加料失败不污染主语：内部错误不许出现在成功结果里（0.2.12）────────────
{
  const read = (p) => readFileSync(join(root, p), 'utf8')
  const linksSrc = read(join('lib', 'macro', 'links.js'))
  const searchSrc = read(join('lib', 'macro', 'defs', 'search.js'))
  const linkSrc = read(join('lib', 'macro', 'defs', 'link.js'))
  // 「星图没接上」与「星图说这一步不行」是两种失败，措辞不能混：前者说环境，后者转述原话
  // 0.2.29 起这句搬进了 contract.js：bridge 抛、links 认，同一个常量一个字
  const contractSrc0 = read(join('lib', 'macro', 'contract.js'))
  check('加料: links.js 有「没接上」的判据', contractSrc0.includes("export const NOT_READY_MARK = '这项能力还没就绪'") && linksSrc.includes('export function isNotReady('))
  check('加料: 判据取的是 bridge 未注册工具时的原话', read(join('lib', 'macro', 'bridge.js')).includes('NOT_READY_MARK'))
  // local 检索是主语，扩散是加料：扩散失败只能省略或说一句，不能把 tryCall 文案拼进结果
  check('加料: local+expand 扩散失败时不拼接失败文案', /if \(!spread\.entry\) return/.test(searchSrc) && searchSrc.includes('关联扩散没做'))
  check('加料: 连线排队在「没接上」时说环境而不是内部错误', linkSrc.includes('if (isNotReady(why))') && linkSrc.includes('星图这次没接上，连线已排队'))
  const probeFusion = read(join('tools', 'probe-fusion.mjs'))
  check('加料: 探针守 G12（扩散失败不污染）', probeFusion.includes('G12 扩散失败不把内部错误塞进成功结果'))
  check('加料: 探针守 G13（排队文案不说内部错误）', probeFusion.includes('G13 连线排队文案是「星图这次没接上」'))
}

// ── A11. 一条命令跑完所有自检（0.2.13）──────────────────────────────────────
{
  const read = (p) => readFileSync(join(root, p), 'utf8')
  const all = read(join('tools', 'check-all.mjs'))
  // 清单必须覆盖十一支：少一支就等于少一类回归（0.2.13 头一次跑就抓到 probe-inject 漏跑+失效）
  const EXPECT = [
    'verify.mjs',
    'tools/probe-fusion.mjs',
    'tools/probe-graph.mjs',
    'tools/probe-host.mjs',
    'tools/probe-client-ui.mjs',
    'tools/coverage-audit.mjs',
    'tools/param-audit.mjs',
    'tools/check-client-bundle.mjs',
    'tools/probe-inject.mjs',
    'tools/check-yaml.mjs',
    'tools/probe-load.mjs',
    'tools/doctor.mjs',
  ]
  const missed = EXPECT.filter((f) => !all.includes(`'${f}'`))
  check('一键: check-all 清单齐全', missed.length === 0, missed.join(',') || `${EXPECT.length} 支`)
  // 顺序是知识：doctor 必须最后（它要读两棵树同步与备份目录）
  const posDoctor = all.indexOf("'tools/doctor.mjs'")
  const posInspect = all.indexOf("'tools/probe-graph.mjs'")
  check('一键: doctor 排在最后', posDoctor > posInspect && posDoctor > 0)
  // 沙箱下 Node 的 stdio:'pipe' 会 EPERM，所以子进程输出必须走文件 fd
  check('一键: 子进程输出走 fd 不用管道', /stdio: \['ignore', fd, fd\]/.test(all) && !all.includes("stdio: 'pipe'"))
  check('一键: 给机器读的 --json 与筛选 --only', all.includes("flag('json')") && all.includes("opt('only')"))
  check('一键: 只读（不调 build）', !all.includes('build.mjs'))
  check('一键: README 有出处', readFileSync(join(root, 'docs', 'INTERNAL.md'), 'utf8').includes('node tools/check-all.mjs'))
  // probe-inject 的老毛病：写死字数会随改名失效，且临时 home 建在工程目录里
  const inject = read(join('tools', 'probe-inject.mjs'))
  check('一键: 注入探针不再写死字数', !inject.includes('=== 689') && inject.includes('plain.length < 800'))
  check('一键: 注入探针不在工程目录留 .probe-home', !inject.includes("'D:/dsh-home/vendor/dsh-macro-memory/.probe-home'") && inject.includes("mkdtempSync(join(tmpdir()"))
}

// ── A12. 原文优先：检索/读取返回的正文不许被改口（0.2.14）──────────────────
{
  const read = (p) => readFileSync(join(root, p), 'utf8')
  const brand = read(join('lib', 'macro', 'brand.js'))
  const bridge = read(join('lib', 'macro', 'bridge.js'))
  const index = read(join('lib', 'index.js'))
  check('原文: brand.js 有 nameHints / withNameHints', /export function nameHints/.test(brand) && /export function withNameHints/.test(brand))
  // 对照说明只能有一条：靠固定标记做幂等，重复渲染不会叠第二条
  check('原文: 对照说明靠标记做幂等', /export const ORIGINAL_MARK = '一个字没动'/.test(brand) && brand.includes('text.includes(ORIGINAL_MARK)'))
  check('原文: aliases 开着时原样返回', /if \(aliases === true\) return text/.test(brand))
  // 内容型工具的名单是「知识」：漏一个就等于让某个入口继续改用户的字
  const contentList = bridge.match(/export const CONTENT_TOOLS = new Set\(\[([\s\S]*?)\]\)/)
  const listed = contentList ? contentList[1] : ''
  const mustHave = ['memory_search', 'memory_read', 'memory_remember', 'memory_update', 'nebula_recall', 'nebula_inspect']
  const missingContent = mustHave.filter((n) => !listed.includes(`'${n}'`))
  check('原文: 内容型工具名单齐全', contentList !== null && missingContent.length === 0, missingContent.join(',') || '6/6')
  check('原文: bridge 按工具分流（内容走 hints，其余走 brand）', /CONTENT_TOOLS\.has\(name\) \? hints : brand/.test(bridge))
  check('原文: hints 是 createBridge 的选项', /const hints = typeof options\.hints === 'function'/.test(bridge))
  check('原文: index.js 把 hints 接上', /hints: \(text\) => withNameHints\(text/.test(index) && index.includes('withNameHints'))
  const probe = read(join('tools', 'probe-fusion.mjs'))
  check('原文: 探针实测写入→检索→读取逐字一致', probe.includes('H3 read 的记忆正文与写入时逐字一致') && probe.includes('H2 search 的正文里仍是原文'))
  check('原文: 探针实测重复读不叠第二条', probe.includes('H4 反复读不会把对照说明叠成两条'))
  const host = read(join('tools', 'probe-host.mjs'))
  check('原文: 宿主面把「界面文案」与「记忆正文」分开断言', host.includes('F5 界面文案里不含旧工具名') && host.includes('F5b 正文里出现旧名时必带'))
  check('原文: README 有出处', readFileSync(join(root, 'docs', 'INTERNAL.md'), 'utf8').includes('原文优先'))
}


// ── A13. 透传面：子插件的非工具能力要照到宿主，工具口子要堵住（0.2.15）────────
{
  const read = (p) => readFileSync(join(root, p), 'utf8')
  // 0.2.26 起「换门」在 facade.js（bridge.js 只负责收下与转调）
  const facadeSrc = read(join('lib', 'macro', 'facade.js'))
  const probe = read(join('tools', 'probe-fusion.mjs'))
  // facade.get 只该拦两样：注入归口与工具归口；其余服务必须原样透传
  check('透传: get("tools") 也走 facade（否则子插件能直挂宿主）', /if \(name === 'tools'\) return toolsFacade/.test(facadeSrc))
  check('透传: get 里仍只特判 systemPrompt / tools 两个名字', /if \(name === 'systemPrompt'\) return promptFacade/.test(facadeSrc) && /return real\.get\?\.\(name\)/.test(facadeSrc))
  check('透传: 探针记录了命令 / 路由 / 钩子三条通道', /registeredCommands\.push/.test(probe) && /registeredRoutes\.push/.test(probe) && /ctxEvents\.push/.test(probe))
  check('透传: 探针给 meow 备了立即就绪的 commands / webServer / sessionPersistence', /commands: \{/.test(probe) && /webServer: \{/.test(probe) && /sessionPersistence: \{ list: async \(\) => \[\] \}/.test(probe))
  check('透传: 探针实测 /dream 命令挂上宿主', probe.includes('I1 meow 的命令还挂得上宿主') && probe.includes('I2 /dream 命令里有 dream 字样'))
  check('透传: 探针实测 dream 图标路由挂上宿主', probe.includes('I3 dream 图标数据路由还挂得上宿主') && probe.includes('/meow-memory/dreamed-sessions'))
  check('透传: 探针实测会话钩子原样到达', probe.includes('I4 meow 的会话钩子原样到达宿主') && probe.includes("'agent/turn-stopping'"))
  check('透传: 探针里有「想绕过融合层」的合成插件做反向验证', probe.includes('shadow_tool') && probe.includes('I5 ctx.get("tools").register 被桥接收走') && probe.includes('I6 ctx.get("systemPrompt").section 也被桥接收走'))
  check('透传: 探针断言宿主工具表没多出 shadow_tool', /shadowTools\.length === 0/.test(probe))
  check('透传: 探针断言非工具服务照常透传', probe.includes('I7 非工具类服务照常透传'))
  check('透传: README 有出处', readFileSync(join(root, 'docs', 'INTERNAL.md'), 'utf8').includes('透传面'))
}


// ── A14. 手册的门牌：三个面（工具 / 命令 / 面板）都得写清（0.2.16）────────────
{
  const read = (p) => readFileSync(join(root, p), 'utf8')
  const prompt = read(join('lib', 'macro', 'prompt.js'))
  const admin = read(join('lib', 'macro', 'defs', 'admin.js'))
  const vendor = read(join('vendor', 'meow-memory', 'lib', 'index.js'))
  check('门牌: prompt.js 导出 NAV_TEXT', /export const NAV_TEXT = `/.test(prompt))
  check('门牌: 门牌里点名两条命令与两个面板', prompt.includes('/dream') && prompt.includes('/meow-trust') && prompt.includes('设置里的「宏记忆」') && prompt.includes('「宏记忆 · 星图」'))
  check('门牌: L0 注入也点了三个面', /三个面都在/.test(prompt))
  check('门牌: guide 先讲门牌再接 vendor 原文', /\$\{NAV_TEXT\}\\n\\n---\\n\\n\$\{buildFullGuide\(bridge\)\}/.test(admin))
  // 交叉核对：手册里的命令名必须真是 vendor 注册的名字，否则手册在说谎
  check('门牌: 命令名与 vendor 注册名一致', vendor.includes('name: "dream"') && vendor.includes('name: "meow-trust"'))
  const probe = read(join('tools', 'probe-fusion.mjs'))
  check('门牌: 探针实测手册开头讲三个面', probe.includes('J1 手册开头讲清三个面') && probe.includes('J2 手册写明命令名'))
  check('门牌: 探针实测 vendor 原文仍在后面', probe.includes('J4 vendor 的手册原文仍然原样接在后面'))
  check('门牌: 探针交叉核对命令名', probe.includes('J7 手册里的命令名与 vendor 实际注册名对得上'))
  check('门牌: README 有出处', readFileSync(join(root, 'docs', 'INTERNAL.md'), 'utf8').includes('三个面'))
}


// ── A15. vendor 账本：拷进来的第三方源码要能证明「没人动过」（0.2.17）──────────
{
  const read = (p) => readFileSync(join(root, p), 'utf8')
  const hashMod = read(join('tools', 'vendor-hash.mjs'))
  const maker = read(join('tools', 'make-vendor-manifest.mjs'))
  const doctor = read(join('tools', 'doctor.mjs'))
  check('账本: 指纹算法只有一份实现', /export function hashTree/.test(hashMod) && /export const SKIP_DIRS/.test(hashMod))
  check('账本: 生成方 import 同一份实现', maker.includes("from './vendor-hash.mjs'") && maker.includes('hashTree'))
  check('账本: 核对方也 import 同一份实现', doctor.includes("'vendor-hash.mjs'") && doctor.includes('hashTree'))
  check('账本: doctor 有「vendor 账本」段', doctor.includes('== vendor 账本 =='))
  check('账本: doctor 反向核对未记账目录', doctor.includes('vendor 下没有未记账的目录'))

  const manifestPath = join(root, 'vendor', 'VENDOR.json')
  check('账本: vendor/VENDOR.json 在', existsSync(manifestPath))
  if (existsSync(manifestPath)) {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    const listed = Array.isArray(manifest.vendors) ? manifest.vendors : []
    check('账本: 两个 vendor 都记了', listed.length === 2, listed.map((v) => v.name).join(','))
    const fields = ['dir', 'name', 'version', 'files', 'bytes', 'sha256']
    const bad = listed.filter((v) => fields.some((f) => v[f] === undefined || v[f] === null))
    check('账本: 每条都有 dir/name/version/files/bytes/sha256', listed.length > 0 && bad.length === 0, bad.map((v) => v.dir).join(','))
    // 账本版本必须与 vendor 源码里的 package.json 对得上，否则账本本身就是假的
    const mismatch = listed.filter((v) => {
      const p = join(root, v.dir, 'package.json')
      if (!existsSync(p)) return true
      return JSON.parse(readFileSync(p, 'utf8')).version !== v.version
    })
    check('账本: 版本号与 vendor 源码一致', mismatch.length === 0, mismatch.map((v) => v.dir).join(','))
    // 指纹必须真的是 sha256（64 位十六进制），不是随手写的短串
    const notHash = listed.filter((v) => !/^[0-9a-f]{64}$/.test(String(v.sha256)))
    check('账本: 指纹是完整 sha256', notHash.length === 0)
  }
  check('账本: README 有出处', readFileSync(join(root, 'docs', 'INTERNAL.md'), 'utf8').includes('vendor 账本'))
}


// ── A16. 断言数基线：绿不等于没退化（0.2.18）──────────────────────────────
{
  const checkAll = readFileSync(join(root, 'tools', 'check-all.mjs'), 'utf8')
  const doctorSrc = readFileSync(join(root, 'tools', 'doctor.mjs'), 'utf8')
  check('基线: check-all 会数断言条数', /const countPass = \(text\) =>/.test(checkAll) && checkAll.includes('/^PASS/gm'))
  check('基线: 读 tools/baselines.json', checkAll.includes("'baselines.json'") && checkAll.includes('baselines.counts'))
  check('基线: 掉了判红（regressed 参与退出码）', /r\.pass < r\.base/.test(checkAll) && /process\.exit\(verdict \? 0 : 1\)/.test(checkAll))
  check('基线: 多了只提醒不判红', /r\.pass > r\.base/.test(checkAll) && checkAll.includes('确认后 --update-baselines'))
  check('基线: --update-baselines 写盘', checkAll.includes("flag('update-baselines')") && checkAll.includes('writeFileSync(') && checkAll.includes('BASELINES'))
  check('基线: --only 时合并旧账不写残', checkAll.includes('...(baselines.counts ?? {})'))

  const basePath = join(root, 'tools', 'baselines.json')
  check('基线: tools/baselines.json 在', existsSync(basePath))
  if (existsSync(basePath)) {
    const base = JSON.parse(readFileSync(basePath, 'utf8'))
    const counts = base.counts ?? {}
    check('基线: 版本与 package.json 一致', base.version === JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version, String(base.version))
    const listed = [...checkAll.matchAll(/^\s*\['([^']+\.mjs)'/gm)].map((m) => m[1])
    const missing = listed.filter((f) => counts[f] === undefined)
    check('基线: 覆盖 check-all 的每一支', listed.length > 0 && missing.length === 0, missing.join(','))
    check('基线: 只读脚本也要记账（0 条也算）', counts['tools/check-client-bundle.mjs'] === 0 && counts['tools/check-yaml.mjs'] === 0)
    check('基线: 条数都是非负整数', Object.values(counts).every((n) => Number.isInteger(n) && n >= 0))
  }
  check('基线: doctor 有「自检基线」段', doctorSrc.includes('== 自检基线 =='))
  check('基线: doctor 反向核对覆盖', doctorSrc.includes('基线覆盖 check-all 里的每一支'))
  check('基线: README 讲了这个门', readFileSync(join(root, 'docs', 'INTERNAL.md'), 'utf8').includes('baselines.json'))
}


// ── A17. 耗时预算：卡死要给一条超时的红，而不是无限等（0.2.19）────────────────
{
  const checkAll = readFileSync(join(root, 'tools', 'check-all.mjs'), 'utf8')
  check('耗时: 每支带 timeout 跑', checkAll.includes('timeout: budget') && checkAll.includes('killSignal'))
  check('耗时: 超时能认出来', checkAll.includes("run.error?.code === 'ETIMEDOUT'") && checkAll.includes('timedOut'))
  check('耗时: 超时算失败且单独报', checkAll.includes('ok: !failed && !timedOut') && checkAll.includes('超时被杀'))
  check('耗时: 宽裕系数与下限都有名字', /const BUDGET_FACTOR = \d+/.test(checkAll) && /const MIN_BUDGET_MS = [\d_]+/.test(checkAll))
  check('耗时: 没记账的脚本给足余量', /const FIRST_RUN_BUDGET_MS = [\d_]+/.test(checkAll) && checkAll.includes('FIRST_RUN_BUDGET_MS'))
  check('耗时: 记账时同时写 ms 与 budgetMs', checkAll.includes('ms[r.file] = r.ms') && checkAll.includes('budgetMs[r.file] ='))

  const basePath = join(root, 'tools', 'baselines.json')
  if (existsSync(basePath)) {
    const base = JSON.parse(readFileSync(basePath, 'utf8'))
    const steps = [...checkAll.matchAll(/^\s*\['([^']+\.mjs)'/gm)].map((m) => m[1])
    const noBudget = steps.filter((f) => !Number.isInteger(base.budgetMs?.[f]))
    check('耗时: 基线里每一支都有预算', steps.length > 0 && noBudget.length === 0, noBudget.join(','))
    const shallow = steps.filter((f) => !Number.isInteger(base.ms?.[f]))
    check('耗时: 基线里每一支都有实测耗时', shallow.length === 0, shallow.join(','))
    const tight = steps.filter((f) => Number.isInteger(base.budgetMs?.[f]) && base.budgetMs[f] < base.ms[f] * 2)
    check('耗时: 预算不少于实测两倍', tight.length === 0, tight.join(','))
    const tooSmall = steps.filter((f) => base.budgetMs?.[f] < 30_000)
    check('耗时: 预算下限 30s', tooSmall.length === 0, tooSmall.join(','))
  }
  const docSrc = readFileSync(join(root, 'tools', 'doctor.mjs'), 'utf8')
  check('耗时: doctor 核预算', docSrc.includes('每支都有耗时预算') && docSrc.includes('预算至少是上次实测的两倍'))
  check('耗时: README 讲了', readFileSync(join(root, 'docs', 'INTERNAL.md'), 'utf8').includes('耗时预算'))
}

// ── A18. 耗时漂移：变慢要说话，但不用判红（0.2.20）──────────────────────────
{
  const checkAll = readFileSync(join(root, 'tools', 'check-all.mjs'), 'utf8')
  check('漂移: 阈值与噪声下限都有名字', /const SLOW_FACTOR = 1\.5/.test(checkAll) && /const SLOW_FLOOR_MS = 1_000/.test(checkAll))
  check('漂移: 拿基线 ms 比', checkAll.includes('const lastMs = baselines.ms?.[file]') && checkAll.includes('ms > lastMs * SLOW_FACTOR'))
  check(
    '漂移: 太快的与超时的都不参与',
    checkAll.includes('ms >= SLOW_FLOOR_MS') && checkAll.includes('!timedOut && Number.isInteger(lastMs)'),
  )
  check('漂移: 每行下面补一句 ~', checkAll.includes('~ 比基线慢') && checkAll.includes('不判红'))
  check('漂移: 汇总单独列一段', checkAll.includes('耗时变慢 ${slowSteps.length} 支') && checkAll.includes('别直接 --update-baselines'))
  check('漂移: 不参与退出码', checkAll.includes('const verdict = bad.length === 0 && regressed.length === 0') && checkAll.includes('slowSteps'))
  check('漂移: 记账时提醒正在把慢记成正常', checkAll.includes('把 ${slowSteps.length} 支「变慢了」的耗时记成新基线'))
  check('漂移: JSON 里有 slow 字段', checkAll.includes('slow: slowSteps.map(') && checkAll.includes('lastMs: r.lastMs ?? null'))

  const base = JSON.parse(readFileSync(join(root, 'tools', 'baselines.json'), 'utf8'))
  check('漂移: 基线 note 说清 1.5 倍只提醒', String(base.note).includes('1.5 倍只提醒不判红'))

  const docSrc = readFileSync(join(root, 'tools', 'doctor.mjs'), 'utf8')
  check('漂移: doctor 核阈值存在', docSrc.includes('耗时漂移有阈值') && docSrc.includes('SLOW_FACTOR'))
  check('漂移: doctor 核两张表同名单', docSrc.includes('耗时表与预算表覆盖同一批脚本'))
  check(
    '漂移: README 讲了',
    readFileSync(join(root, 'docs', 'INTERNAL.md'), 'utf8').includes('耗时漂移') && readFileSync(join(root, 'docs', 'INTERNAL.md'), 'utf8').includes('1.5 倍'),
  )
}

// ── A19. 存储层归位：路径只有一个出处，jsonl 只有一套解析（0.2.21）──────────────
{
  const libDir = join(root, 'lib')
  const files = []
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.name.endsWith('.js')) files.push(p)
    }
  }
  walk(libDir)
  const src = new Map(files.map((p) => [p.slice(root.length + 1).replace(/\\/g, '/'), readFileSync(p, 'utf8')]))

  check('存储: store.js 在', src.has('lib/macro/store.js'))
  const store = src.get('lib/macro/store.js') ?? ''
  check(
    '存储: store 导出七个入口（含把成败原因带出来的两个）',
    ['macroHome', 'ledgerPath', 'pendingPath', 'readJsonl', 'appendJsonl', 'readJsonlDetail', 'appendJsonlDetail'].every(
      (n) => store.includes(`export function ${n}`),
    ),
  )

  // 路径唯一出处：整个 lib 只有 store.js 读 DSH_HOME
  const homeReaders = [...src.entries()].filter(([, t]) => t.includes('process.env.DSH_HOME')).map(([f]) => f)
  check('存储: 只有 store.js 读 DSH_HOME', homeReaders.length === 1 && homeReaders[0] === 'lib/macro/store.js', homeReaders.join(','))

  // jsonl 解析唯一出处：逐行 JSON.parse 只允许出现在 store.js
  const lineParsers = [...src.entries()].filter(([, t]) => /JSON\.parse\(line\)/.test(t)).map(([f]) => f)
  check('存储: 逐行解析只有一份', lineParsers.length === 1 && lineParsers[0] === 'lib/macro/store.js', lineParsers.join(','))

  // 依赖方向：队列不再借成本账本的 import 去算路径
  const links = src.get('lib/macro/links.js') ?? ''
  check('存储: links 不再依赖 cost', !/from '\.\/cost\.js'/.test(links) && links.includes("from './store.js'"))
  // 成本账本自己不再碰文件系统
  const cost = src.get('lib/macro/cost.js') ?? ''
  check('存储: cost 不再直接读文件', !cost.includes('readFileSync') && !cost.includes('appendFileSync') && cost.includes('appendJsonl'))
  // 老调用方仍能拿到路径（转发导出），否则 doctor/探针会静默换路径
  check('存储: cost 仍转发 ledgerPath', /export \{ ledgerPath \}/.test(cost))
  check('存储: links 仍导出 pendingPath', /export \{ pendingPath \}/.test(links))

  const docSrc = readFileSync(join(root, 'tools', 'doctor.mjs'), 'utf8')
  check('存储: doctor 核路径唯一出处', docSrc.includes('路径只有一个出处'))
  const readme = readFileSync(join(root, 'docs', 'INTERNAL.md'), 'utf8')
  check('存储: README 讲了', readme.includes('存储层') && readme.includes('store.js'))
  const design = readFileSync(join(root, 'DESIGN.md'), 'utf8')
  check('存储: DESIGN 记了判据', design.includes('依赖方向') && design.includes('store.js'))
}


// ── A20. 动作表：枚举、分发、实现三者是同一份数据（0.2.22）────────────────────
{
  const read = (p) => readFileSync(join(root, p), 'utf8')
  const adminSrc = read(join('lib', 'macro', 'defs', 'admin.js'))
  const probe = read(join('tools', 'probe-fusion.mjs'))
  const readme = read('docs/INTERNAL.md')
  const design = read('DESIGN.md')

  check('动作表: 表是模块级导出的纯数据', /export const ACTIONS = \{/.test(adminSrc))
  // 枚举不许再手写第二个副本：它必须是从表里长出来的
  check('动作表: 参数枚举直接取 Object.keys(ACTIONS)', /enum: Object\.keys\(ACTIONS\)/.test(adminSrc))
  check('动作表: 不再有按 action 的 if/else 链', !/if \(action === '(home|stats|hygiene|sources|ingest|cost|links|guide)'\)/.test(adminSrc))
  // 三种实现字段，分发只认 kind
  check('动作表: 分发按 kind 走三种实现', /spec\.kind === 'call'/.test(adminSrc) && /spec\.kind === 'graph'/.test(adminSrc))
  check('动作表: 表里写了「表外的 key 走 local 实现」的兜底', adminSrc.includes('在表里但没有实现'))
  check('动作表: 未知 action 仍然明确报错', /未知 action=\$\{action\}/.test(adminSrc))
  // 表里每一行都要么带外部工具名、要么带 local 实现——空行等于死路
  check('动作表: 每行都有名字（call/graph 或 local 分支）', (() => {
    const body = adminSrc.slice(adminSrc.indexOf('export const ACTIONS'), adminSrc.indexOf('function guardIngest'))
    const rows = [...body.matchAll(/^\s{2}(\w+): \{([^}]*)\}/gm)]
    return rows.length === 9 && rows.every(([, , spec]) => /kind: '(call|graph|local)'/.test(spec))
  })())
  // ingest 的运行时守卫还在（schema 收不住必填）
  check('动作表: ingest 仍守 provider/items', adminSrc.includes('action="ingest" 需要 provider') && adminSrc.includes('action="ingest" 需要 items'))
  // 星图面板仍走 tryCall 降级（0.2.10 的承诺不因重构丢失）
  check('动作表: 星图面板仍走 graphPanel/tryCall', adminSrc.includes('const graphPanel = async (name, payload, what, miss)') && adminSrc.includes('flow.tryCall(name, payload, exec, what)'))
  // 门牌的拼法没被重构改掉（0.2.16 的 A14 依赖这一行）
  check('动作表: guide 仍先门牌后 vendor 原文', /\$\{NAV_TEXT\}\\n\\n---\\n\\n\$\{buildFullGuide\(bridge\)\}/.test(adminSrc))

  check('动作表: 探针实测「枚举里的 action 都能走通」', probe.includes('K4 枚举里每个 action 都真的能走通') && probe.includes('deadEnds'))
  check('动作表: 探针交叉核对枚举与表是同一份', probe.includes('K1 枚举就是动作表本身') && probe.includes('adminMod.ACTIONS'))
  check('动作表: 探针实测表外 action 报错', probe.includes('K5 表外的 action 仍然明确报错'))

  check('动作表: README 有出处', readme.includes('动作表') && readme.includes('0.2.22'))
  check('动作表: DESIGN 记了判据', design.includes('动作表') && design.includes('死路'))
}

// ── A21. 加载面：判据归 DSH，问它而不是抄它（0.2.23）──────────────────────────
{
  const read = (p) => readFileSync(join(root, p), 'utf8')
  const loadSrc = read(join('tools', 'probe-load.mjs'))
  const checkAllSrc = read(join('tools', 'check-all.mjs'))
  const doctorSrc = read(join('tools', 'doctor.mjs'))
  const readme = read('docs/INTERNAL.md')
  const design = read('DESIGN.md')

  // 1) 判据出处：必须是 DSH 装好的 app-boot，而不是我们手写的规则
  check('加载面: 探针 import 的是装好的 app-boot', loadSrc.includes("@deepseek-ai/dsh-app-boot/lib/index.js") && loadSrc.includes('await import(pathToFileURL'))
  check('加载面: 运行时版本取自 app-boot 自己', loadSrc.includes('mod.getDshRuntimeVersion()'))
  // 2) 兼容/平台/补丁 三条闸都用它的函数
  check('加载面: 兼容性问 DSH 的 evaluatePluginCompatibility', loadSrc.includes('mod.evaluatePluginCompatibility(') && loadSrc.includes('mod.pluginCompatibilityWarning('))
  check('加载面: 平台与补丁也用它自己的解析器', loadSrc.includes('mod.assertBundlePlatform(') && loadSrc.includes('mod.bundlePatchPaths(') && loadSrc.includes('mod.loadOverlayPatches('))
  check('加载面: bundle 目录用 resolveBundleDir 问，不自己拼路径', loadSrc.includes('mod.resolveBundleDir('))
  // 3) 两份都问：装好的那份 + 本仓源码
  check('加载面: 装的那份与本仓同版（抓「改了忘了同步」）', loadSrc.includes('DSH 加载的那份与本仓同版') && loadSrc.includes('DSH 会跑旧代码，先同步'))
  check('加载面: 本仓源码也按同一套判据问一遍', loadSrc.includes('本仓这份源码按 DSH 的判据也兼容'))
  // 4) 装配：composeEntries 之后条目还在、没被禁用
  check('加载面: 装配走 composeEntries（boot 里那一次 applyEntryPatches）', loadSrc.includes('mod.composeEntries(') && loadSrc.includes('applyEntryPatches'))
  check('加载面: 装配后恰好 1 条且不是 disabled: true', loadSrc.includes('装配后条目里恰好 1 条 macro-memory') && loadSrc.includes('装配后它不是被禁用的'))
  // 5) 只读：不写清单、不 apply 补丁、不启动插件
  check('加载面: 探针全程只读（不写文件、不 apply）', !/writeFileSync|appendFileSync|applyEntryPatches\(/.test(loadSrc))
  // 6) 查不了就红，不许当绿
  check('加载面: 找不到 DSH 直接 FAIL，不假装绿', loadSrc.includes('DSH_APP_DIR') && loadSrc.includes('加载面这一条查不了，不许当绿'))
  // 7) 接线与文档出处
  check('加载面: check-all 里有这一支', checkAllSrc.includes("'tools/probe-load.mjs'"))
  check('加载面: doctor 的加载面指向探针', doctorSrc.includes("'加载面还有 probe-load 去问 DSH 自己'"))
  check('加载面: README 有出处', readme.includes('probe-load.mjs') && readme.includes('0.2.23'))
  check('加载面: DESIGN 记了判据所有权', design.includes('判据的所有权') && design.includes('composeEntries'))
}

// ── A22. 运行态验收：问跑着的那个进程，起点不许猜（0.2.24）────────────────────
{
  const read = (p) => readFileSync(join(root, p), 'utf8')
  const liveSrc = read(join('tools', 'accept-live.mjs'))
  const checkAllSrc = read(join('tools', 'check-all.mjs'))
  const readme = read('docs/INTERNAL.md')
  const design = read('DESIGN.md')

  check('运行态: 探针存在且只读（不写文件、不 apply、不启停）', !/writeFileSync|appendFileSync|unlinkSync|applyEntryPatches\(/.test(liveSrc))
  // 起点必须问操作系统：第一版拿日志文件创建时间当起点，日志轮转时结论会整个反过来
  check('运行态: 起点取进程创建时间', liveSrc.includes('DSH_LIVE_PROCESS') && liveSrc.includes('Get-Process -Name') && liveSrc.includes('StartTime'))
  check('运行态: 不再拿日志文件创建时间当起点', !/logStat\.birthtime/.test(liveSrc))
  check('运行态: 查不到起点就 INFO 不猜', liveSrc.includes('查不到运行起点'))
  // 两条判红的依据
  check('运行态: 宿主不在跑就红', liveSrc.includes("fail('宿主还活着'") && liveSrc.includes("pass('宿主还活着'"))
  check('运行态: 日志里有本插件 error 就红', liveSrc.includes('\\[error\\]') && liveSrc.includes('日志里没有一条 error 提到本插件'))
  // 只报告不判红的两条：不许偷偷改成 fail
  check('运行态: 「没活动」与「跑的旧代码」只报告不判红', !/fail\('服务端代码在这次运行里跑过'/.test(liveSrc)
    && !/fail\('跑的是不是现在这份代码'/.test(liveSrc)
    && liveSrc.includes("info('跑的是不是现在这份代码'"))
  // 前端那半截的判据：宿主自己打的 bundle 列表
  check('运行态: 前端产物按宿主自己的 bundle 列表判', /dsh-macro-memory\\\/client\\\.js/.test(liveSrc) && liveSrc.includes('&rev='))
  check('运行态: 只读日志尾部（别整文件读进内存）', liveSrc.includes('4 * 1024 * 1024'))
  // 不进 check-all：DSH 没开就红 = 把环境当代码判
  check('运行态: 不进 check-all（环境依赖不算代码体检）', !checkAllSrc.includes("'tools/accept-live.mjs'"))
  check('运行态: README 有出处与 0.2.24', readme.includes('tools/accept-live.mjs') && readme.includes('0.2.24'))
  check('运行态: DESIGN 记了日志轮转这个坑', design.includes('日志轮转') && design.includes('起点不能猜'))
}

// ── A23. 面板口径：八个面板一个抬头，名字只有一份（0.2.25）────────────────────
{
  const read = (p) => readFileSync(join(root, p), 'utf8')
  const panelSrc = read(join('lib', 'macro', 'panel.js'))
  const adminSrc = read(join('lib', 'macro', 'defs', 'admin.js'))
  const costSrc = read(join('lib', 'macro', 'cost.js'))
  const readme = read('docs/INTERNAL.md')
  const design = read('DESIGN.md')

  // 1) 抬头只有一个出处：panel.js
  check('口径: 抬头只由 panel.js 产（panelHead / panelText / PANEL_BRAND）', /export function panelHead/.test(panelSrc) && /export function panelText/.test(panelSrc) && /export const PANEL_BRAND = '宏记忆'/.test(panelSrc))
  check('口径: 其它文件里没有第二份抬头字面量', !adminSrc.includes('【宏记忆') && !costSrc.includes('【宏记忆'))
  // 2) 名字只有一份：动作表的 label，八行都要有且两两不同
  const table = adminSrc.slice(adminSrc.indexOf('export const ACTIONS'), adminSrc.indexOf('export const PANEL_SUMMARY'))
  const rowLabels = [...table.matchAll(/label: '([^']+)'/g)].map((m) => m[1])
  check('口径: 九个面板名都在动作表里', rowLabels.length === 9 && new Set(rowLabels).size === 9, rowLabels.join('/'))
  // 3) 三种 kind 走同一个 wrap：正文原样、抬头统一
  check('口径: 三种 kind 都过同一个 wrap', /const wrap = \(spec, \{ body, note \}\) => \{[\s\S]{0,400}?return panelText\(spec\.label, body, note\)\n      \}/.test(adminSrc) && (adminSrc.match(/wrap\(spec, /g) ?? []).length === 3)
  check('口径: 手册那行明确豁免（wrap: false + 理由）', /guide: \{ kind: 'local', label: '完整手册'[^}]*wrap: false \}/.test(adminSrc) && adminSrc.includes('唯一豁免'))
  // 4) 卡片标题也用表里的名字，不是 action 键（0.2.70 起细节位放参数，前缀仍是 label）
  check('口径: 卡片标题取 label 而不是 action', /const spec = ACTIONS\[shown\][\s\S]{0,200}?cardTitle\(spec\.label, cardDetail\(args\)\)/.test(adminSrc))
  // 5) 工具描述由表生成，不再手抄一份清单
  check('口径: 工具描述由表生成（PANEL_SUMMARY）', /export const PANEL_SUMMARY =/.test(adminSrc) && adminSrc.includes('description: PANEL_SUMMARY'))
  // 6) 默认条数只写在表里，别处不许再各写一个 200 / 20
  check('口径: 条数默认值只写在表里', /defaultLimit: 200/.test(adminSrc) && /defaultLimit: 20/.test(adminSrc) && !/\? 200 :/.test(adminSrc) && !/\? 20 :/.test(adminSrc))
  check('口径: 默认值读取只有 limitOf 一条路径', /export function limitOf/.test(panelSrc) && /limitOf\(ACTIONS\.(cost|links), args\)/.test(adminSrc))
  // 7) 参数说明与实际读参数的落点对得上（limit 以前漏了 links）
  check('口径: limit 的说明包含了真正会用它的面板', adminSrc.includes('action=hygiene/cost/dream/links 的条数'))
  // 9) 抬头是契约，不是排版：剥抬头的函数只有一份，按行读数据的探针必须用它
  const graphProbe = read(join('tools', 'probe-graph.mjs'))
  check('口径: 按行读正文的探针用 stripHead 剥抬头，不靠猜行号', /export function stripHead/.test(panelSrc) && graphProbe.includes('panelMod.stripHead(') && !/text\(await run\('memory_admin', \{ action: 'stats' \}\)\)\.split/.test(graphProbe))
  // 10) 正文不许为了统一被改写：成本账本原来的汇总行还在
  check('口径: 成本账本的正文没被抬头顶掉', !costSrc.includes('# macro-memory 成本账本') && costSrc.includes('合计：入参'))
  // 9) 证据 + 文档出处
  const probe = read(join('tools', 'probe-fusion.mjs'))
  check('口径: 探针实测八个抬头一致、手册豁免', probe.includes('L1 八个统计面板的抬头同一个样') && probe.includes('L3 手册不加抬头') && probe.includes('L5 条数上限有口径说明'))
  check('口径: README 有出处与 0.2.25', readme.includes('panel.js') && readme.includes('0.2.25'))
  check('口径: DESIGN 记了抬头与豁免', design.includes('抬头') && design.includes('为什么手册不加抬头') && design.includes('wrap: false'))
}


// ── A24. 桥拆三件事：收下 / 换门 / 出文本各一个文件（0.2.26）──────────────────
{
  const read = (p) => readFileSync(join(root, p), 'utf8')
  const bridgeSrc = read(join('lib', 'macro', 'bridge.js'))
  const facadeSrc = read(join('lib', 'macro', 'facade.js'))
  const renderSrc = read(join('lib', 'macro', 'render.js'))
  const indexSrc = read(join('lib', 'index.js'))
  const readme = read('docs/INTERNAL.md')
  const design = read('DESIGN.md')

  // 1) 一个文件只有一件能被一句话说清的事
  check('拆: 桥只负责收下与转调（有 createBridge，没有 Proxy）', /export function createBridge/.test(bridgeSrc) && !bridgeSrc.includes('new Proxy(') && /export const CONTENT_TOOLS/.test(bridgeSrc))
  check('拆: 换门只在 facade.js（Proxy 也只在它里面）', /export function createFacade/.test(facadeSrc) && /export function wrapPlugin/.test(facadeSrc) && (facadeSrc.match(/new Proxy\(/g) ?? []).length === 3 && !bridgeSrc.includes('new Proxy('))
  check('拆: 出文本是纯函数（render.js 不 import 任何东西、不建状态）', /export function renderToolText/.test(renderSrc) && /export function errText/.test(renderSrc) && !/^\s*import /m.test(renderSrc) && !renderSrc.includes('new Map('))
  check('拆: 无环（facade / render 都不回头 import bridge）', !facadeSrc.includes("'./bridge.js'") && !renderSrc.includes("'./bridge.js'"))

  // 2) 拆结构不改调用方：index.js 那一行 import 照旧能用
  check('拆: index.js 仍从 bridge.js 拿 createBridge / errText / wrapPlugin', /import \{ createBridge, errText, wrapPlugin \} from '\.\/macro\/bridge\.js'/.test(indexSrc))
  check('拆: bridge.js 用转出维持旧引用（不重复实现）', /export \{ createFacade, wrapPlugin \} from '\.\/facade\.js'/.test(bridgeSrc) && /export \{ errText \}/.test(bridgeSrc) && !/export function createFacade/.test(bridgeSrc) && !/export function renderToolText/.test(bridgeSrc))
  check('拆: bridge 里 renderToolText 只有 import 一处、调用一处', (bridgeSrc.match(/renderToolText/g) ?? []).length === 2)

  // 3) 拆完之后每个文件都还能一眼读完（不许把 292 行搬成两个 146 行）
  const lines = (s) => s.split('\n').length
  check('拆: 三个文件都在百来行以内', lines(bridgeSrc) <= 160 && lines(facadeSrc) <= 140 && lines(renderSrc) <= 60, `${lines(bridgeSrc)}/${lines(facadeSrc)}/${lines(renderSrc)}`)

  // 4) 行为不变要有实测，不是靠读代码
  const probe = read(join('tools', 'probe-fusion.mjs'))
  check('拆: 探针实测三个入口都在、旧引用仍等价', probe.includes('M1 桥拆成三个文件后入口一个不少') && probe.includes('M2 bridge.js 仍转出 errText / wrapPlugin / createFacade'))
  check('拆: 探针实测换门后服务透传、render 退回 JSON', probe.includes('M3 换门之后其余服务照样透传') && probe.includes('M4 出文本仍优先子插件 render') && probe.includes('M5 渲染炸了也不吞掉结果'))

  // 5) 文档出处
  check('拆: README 记了三个文件的分工与 0.2.26', readme.includes('facade.js') && readme.includes('render.js') && readme.includes('0.2.26'))
  check('拆: DESIGN 记了为什么拆、按什么切', design.includes('bridge.js') && design.includes('换门') && design.includes('纯函数'))
}

// ── A25. 项目根只有一处出处（0.2.27）────────────────────────────────────────
{
  const read = (p) => readFileSync(join(root, p), 'utf8')
  const rootSrc = read(join('tools', '_root.mjs'))
  const checkAll = read(join('tools', 'check-all.mjs'))
  const doctorSrc = read(join('tools', 'doctor.mjs'))
  const readme = read('docs/INTERNAL.md')
  const design = read('DESIGN.md')

  // 1) 出处本身：只算一次，且只算这三样
  check('根: tools/_root.mjs 是唯一出处（root / vendorDir / at）',
    /export const root = dirname\(dirname\(fileURLToPath\(import\.meta\.url\)\)\)/.test(rootSrc) &&
    /export const vendorDir = join\(root, 'vendor'\)/.test(rootSrc) &&
    /export function at\(\.\.\.segs\)/.test(rootSrc))

  // 2) 不许各自再算一遍根：三种旧写法都要绝迹（以前 13 种写法、2 条写死绝对路径）
  const tools = readdirSync(join(root, 'tools')).filter((n) => n.endsWith('.mjs') && n !== '_root.mjs')
  const srcOf = (n) => readFileSync(join(root, 'tools', n), 'utf8')
  // 判据只看「root 是怎么算出来的」，不管注释里提到这些词（那条教训本身就是注释里写的）
  const code = (n) => srcOf(n).split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*|\*\/)/.test(l)).join('\n')
  const viaDir = tools.filter((n) => /const\s+root\s*=\s*dirname\(/.test(code(n)))
  check('根: 除 _root.mjs 外没有第二处拿 dirname 算根', viaDir.length === 0, viaDir.join(', ') || `${tools.length} 个脚本`)
  const viaCwd = tools.filter((n) => /const\s+root\s*=\s*process\.cwd\(\)/.test(code(n)))
  check('根: 没有脚本拿 process.cwd() 当项目根', viaCwd.length === 0, viaCwd.join(', '))
  const hard = tools.filter((n) => /const\s+root\s*=\s*['"]D:/.test(code(n)))
  check('根: 没有把 D:/dsh-home 写死当根', hard.length === 0, hard.join(', '))
  // 还有一种写法：const here = resolve(import.meta.dirname, '..')——probe-load 原来就是它
  const viaMeta = tools.filter((n) => /import\.meta\.dirname/.test(code(n)))
  check('根: 没有脚本用 import.meta.dirname 自己往上一层摸', viaMeta.length === 0, viaMeta.join(', '))

  // 3) 被 check-all 点名的那几支，凡是要读本仓文件的，一律从 _root.mjs 取。
  //    两支例外有明确理由，写在表里而不是「漏了」：
  //    probe-inject 只经相对 import 读 vendor；check-yaml 只读 DSH 安装与 profile。
  const steps = [...checkAll.matchAll(/^\s*\['([^']+\.mjs)'/gm)].map((m) => m[1])
  const NO_ROOT = {
    'tools/probe-inject.mjs': '只经相对 import 读 vendor，不拼仓内路径',
    'tools/check-yaml.mjs': '只读 DSH 安装与 profile，不读本仓',
  }
  const needRoot = steps.filter((f) => !(f in NO_ROOT))
  const notImported = needRoot.filter((f) => !/from '[^']*_root\.mjs'/.test(read(f)))
  check(
    '根: check-all 里要读本仓的每一支都从 _root.mjs 取根',
    steps.length === 21 && notImported.length === 0 && Object.keys(NO_ROOT).every((f) => steps.includes(f)),
    notImported.length ? notImported.join(', ') : `${needRoot.length} 支取根 / ${Object.keys(NO_ROOT).length} 支有理由例外`,
  )
  // 例外表不能成为逃逸口：被豁免的那支必须真的不碰 root
  const faked = Object.keys(NO_ROOT).filter((f) => /join\(root,/.test(srcOf(f.split('/').pop())))
  check('根: 例外清单里没有偷偷用 root 的脚本', faked.length === 0, faked.join(', '))

  // 4) 检查器不补环境：子进程在无关的空目录里跑，谁偷用 cwd 就当场红。
  //    只看代码行不看注释——注释里恰好写着反例（"以前这里写 cwd: root"），
  //    拿整段文本判真假会被自己的说明文绊倒（0.2.23 栽过一次）。
  const optLines = checkAll.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*|\*\/)/.test(l))
  const neutral = optLines.some((l) => l.includes('cwd: neutralCwd'))
  const stillRoot = optLines.some((l) => /cwd:\s*root\b/.test(l))
  check(
    '根: check-all 用中性 cwd 跑每一支（不替被检查者补环境）',
    neutral && !stillRoot && checkAll.includes('不该替被检查者补环境'),
    stillRoot ? '还有 cwd: root' : 'cwd: neutralCwd',
  )

  // 5) doctor 自己也得按 root 拼路径，不能只对别人提要求
  check('根: doctor 的路径都从 root 拼', (doctorSrc.match(/join\(root, /g) ?? []).length >= 20)

  // 6) 文档出处
  check('根: README 记了 _root.mjs 与 0.2.27', readme.includes('_root.mjs') && readme.includes('0.2.27'))
  check('根: DESIGN 记了为什么只留一处、cwd 为什么故意给空目录',
    design.includes('_root.mjs') && design.includes('单一出处') && design.includes('process.cwd()'))
}


// ── A26. 补连预算是真的（0.2.28）──────────────────────────────────────────
{
  const read = (p) => readFileSync(join(root, p), 'utf8')
  const linksSrc = read(join('lib', 'macro', 'links.js'))
  const adminSrc = read(join('lib', 'macro', 'defs', 'admin.js'))
  const fusionSrc = read(join('tools', 'probe-fusion.mjs'))
  const readme = read('docs/INTERNAL.md')
  const design = read('DESIGN.md')

  // 1) 超时是独立的哨兵：不能和「归不出 id」「永久失败」共用一个返回值，
  //    否则「该留的」会被当成「该摘的」删掉。
  check(
    '预算: 超时用独立哨兵，不和「归不出 id」混用',
    /const TIMED_OUT = Symbol\('macro-memory:budget-timeout'\)/.test(linksSrc) &&
      linksSrc.includes('rawA === TIMED_OUT || rawB === TIMED_OUT') &&
      linksSrc.includes('if (r === TIMED_OUT)'),
  )
  check(
    '预算: 最小步长写成常量并导出（探针要用）',
    /export const MIN_STEP_MS = 120/.test(linksSrc) && linksSrc.includes('if (remaining() < MIN_STEP_MS)'),
  )

  // 2) 每一次 await 都被「剩余预算」包起来：归一 id 两次 + 连线一次，一个都不能漏。
  //    以前只靠 tryCall 的 timeoutMs——那个数只管等工具注册，execute 慢多久都照等。
  check(
    '预算: 归一 id 与连线调用都套剩余预算',
    /withBudget\(resolve\(entry\.a, exec\), remaining\(\)\)/.test(linksSrc) &&
      /withBudget\(resolve\(entry\.b, exec\), remaining\(\)\)/.test(linksSrc) &&
      /withBudget\(tryCall\('nebula_link'/.test(linksSrc),
  )
  // 3) 三个检查点（循环顶部 / 归一 / 连线）都走同一条「停手但留着」的路径
  check(
    '预算: 三处检查点走同一条停手路径（掐断 ≠ 失败）',
    (linksSrc.match(/stopped = 'budget'/g) ?? []).length === 3,
    String((linksSrc.match(/stopped = 'budget'/g) ?? []).length),
  )
  check('预算: 计时器 unref（不拖住事件循环）', linksSrc.includes('timer.unref'))

  // 4) tried 的语义：真的动过几条；旧写法把「没来得及试」也算成试过
  check(
    '预算: tried 报真的动过几条，不是 min(len,limit)',
    linksSrc.includes('let tried = 0') && linksSrc.includes('tried += 1') && !linksSrc.includes('Math.min(list.length, limit)'),
  )

  // 5) 面板不许看起来像「补完了一轮」
  check('预算: links 面板明说预算用完、剩下的下次接着补', adminSrc.includes("round.stopped === 'budget'"))
  // 6) 行为级证据：慢桩证明「真掐断」而不是「恰好快」
  check(
    '预算: 探针用慢桩证明慢调用会被掐断',
    fusionSrc.includes('N1 掐断就不等它跑完') && fusionSrc.includes('N4 星图没接上只探一次') && fusionSrc.includes('N5 预算不足一条就一个请求都不发'),
  )
  // 7) 文档出处
  check('预算: README 记了 MIN_STEP_MS 与 0.2.28', readme.includes('MIN_STEP_MS') && readme.includes('0.2.28'))
  check('预算: DESIGN 记了为什么 tryCall 的超时管不住 execute', design.includes('Promise.race') && design.includes('MIN_STEP_MS'))
}


// ── A27. 跨插件的文字契约只有一处，并且有断言盯着对面（0.2.29）──────────────
{
  const read = (p) => readFileSync(join(root, p), 'utf8')
  const contractSrc = read(join('lib', 'macro', 'contract.js'))
  const flowSrc = read(join('lib', 'macro', 'linkflow.js'))
  const linksSrc = read(join('lib', 'macro', 'links.js'))
  const bridgeSrc = read(join('lib', 'macro', 'bridge.js'))
  const linkDefSrc = read(join('lib', 'macro', 'defs', 'link.js'))
  const fusionSrc = read(join('tools', 'probe-fusion.mjs'))
  const readme = read('docs/INTERNAL.md')
  const design = read('DESIGN.md')

  // 1) 跨插件措辞的判据只有一份（0.2.38）：常量表在 tools/criteria.mjs，
  //    这里逐条落成断言，doctor 读同一份汇总——不再各写一套 bareMarks。
  //    注意「运行时值」这一条：源码里有 `export const X = '…'` 不代表真的导出了那个值。
  const criteria27 = await import('./tools/criteria.mjs')
  const contract27 = await import('./lib/macro/contract.js')
  const list27 = criteria27.contractChecklist({
    contractSrc,
    sources: {
      'links.js': linksSrc,
      'bridge.js': bridgeSrc,
      'linkflow.js': flowSrc,
      'defs/link.js': linkDefSrc,
      'defs/search.js': read('lib/macro/defs/search.js'),
      'store.js': read('lib/macro/store.js'),
      'cost.js': read('lib/macro/cost.js'),
      // 0.2.61：面板条数的口径在 panel.js（limitOf）与 defs/admin.js（两处调用点）里
      'panel.js': read('lib/macro/panel.js'),
      'defs/admin.js': read('lib/macro/defs/admin.js'),
      'shared.js': read('lib/macro/shared.js'),
      'defs/read.js': read('lib/macro/defs/read.js'),
      'prompt.js': read('lib/macro/prompt.js'),
    },
    runtime: contract27,
    nebIndexSrc: read(join('vendor', 'dsh-memory-nebula', 'lib', 'index.js')),
    nebCoreSrc: read(join('vendor', 'dsh-memory-nebula', 'lib', 'host', 'nebula.js')),
    meowIndexSrc: read(join('vendor', 'meow-memory', 'lib', 'index.js')),
  })
  // 条数不是契约，内容才是：这里对的是「有哪些条」，不是「有几条」。
  const expectIds = [
    'table',
    'kinds',
    'marks',
    'runtime',
    'leak',
    'kind',
    'vendor-index',
    'vendor-core',
    'vendor-recall',
    'vendor-hygiene',
    'vendor-stats',
    'vendor-inspect',
    'vendor-sources',
    'vendor-bridge',
    'vendor-path',
    'vendor-similar',
    'vendor-project',
    'vendor-dream',
    'vendor-update',
    'vendor-remember',
    'vendor-search',
    'vendor-search-param',
    'vendor-read',
    'vendor-similar-id',
    'link-resolve-three',
    'store-fail-visible',
    'vendor-param-zero',
    'search-mode-whitelist',
    'link-action-and-ends',
    'admin-limit-zero',
    'read-neighbors-param',
  'guide-budget-param',
          'admin-hygiene-kind',
    'search-limit-used-note',
  'graph-fallback-param-note',
    'similar-mode-param-note',
    'panel-param-owner-note',
  'search-id-memoryids-note',
  'admin-card-detail',
  'stats-hubs-cap',
  'graph-miss-split',
    'hygiene-count-ledger',
    'cost-scope-count',
    'read-neighbor-gap',
    'link-args-drop',
  ]
  check(
    '契约: 措辞判据清单就是这四十五条，且 id 不重复',
    new Set(list27.map((c) => c.id)).size === list27.length &&
      list27.length === expectIds.length &&
      expectIds.every((id) => list27.some((c) => c.id === id)),
    `${list27.map((c) => c.id).join(',')}`,
  )
  for (const item of list27) check(`契约清单: ${item.label}`, item.ok, item.detail)
  check(
    '契约: 措辞判据也只有一份（体检读同一张表）',
    /from '\.\/criteria\.mjs'/.test(read(join('tools', 'doctor.mjs'))) &&
      read(join('tools', 'doctor.mjs')).includes('contractChecklist(') &&
      !read(join('tools', 'doctor.mjs')).includes("'没有关系就不编关系'"),
    'doctor 自带字面量表' && 'doctor 是否手抄',
  )
  const st27 = criteria27.selfTestContract()
  check('契约: 每条措辞判据都验证过能被打红（不是恒真）', st27.baseline.length === 0 && st27.survived.length === 0, `样板红 ${st27.baseline.join('/') || '无'} / 打不红 ${st27.survived.join('/') || '无'}`)
  const v27 = JSON.parse(read('package.json')).version.split('.').map(Number)
  check('契约: 版本不早于 0.2.38', v27[0] === 0 && v27[1] === 2 && v27[2] >= 38, v27.join('.'))
  check(
    '契约: README 与 DESIGN 记了这一轮（判据自己也是两份）',
    readme.includes('0.2.38') && design.includes('0.2.38') && design.includes('判据自己'),
    `${readme.includes('0.2.38')}/${design.includes('0.2.38')}`,
  )

  // 2) 三处都从 contract 取，不再各写各的
  check(
    '契约: bridge 抛的话与 links 认的字是同一个常量',
    /import \{ NOT_READY_MARK \} from '\.\/contract\.js'/.test(bridgeSrc) && bridgeSrc.includes('${NOT_READY_MARK}'),
  )
  check(
    '契约: links 的连线判据用 contract 的常量',
    linksSrc.includes("from './contract.js'") &&
      linksSrc.includes('includes(LINKED_MARK)') &&
      linksSrc.includes('includes(SELF_PAIR_MARK)') &&
      linksSrc.includes('includes(MISSING_PAIR_MARK)'),
  )
  check('契约: linkflow 的「还没入图」也用同一个常量', flowSrc.includes("from './contract.js'") && flowSrc.includes('saysMissing(text)'))

  // 3) 结构判据稳、措辞判据脆：结构那条必须先判，且等待不睡过期限
  check(
    '契约: unavailable 看结构（entry === undefined），不看文案',
    flowSrc.includes('probe.entry === undefined') &&
      // 0.2.42：后面那半步从「反推」（`!saysMissing(text)`）改成了正面归类（`inspectAnswerKind(text) === 'ok'`），
      // 顺序判据跟着换成新的那一步——仍然是「结构在前、措辞在后」。
      (flowSrc.includes("inspectAnswerKind(text) === 'ok'") || flowSrc.includes('!saysMissing(text)')) &&
      flowSrc.indexOf('probe.entry === undefined') <
        flowSrc.indexOf(flowSrc.includes("inspectAnswerKind(text) === 'ok'") ? "inspectAnswerKind(text) === 'ok'" : '!saysMissing(text)'),
  )
  check('契约: 轮询等待不超过剩余期限', /setTimeout\(r, Math\.min\(pollStepMs, Math\.max\(0, deadline - Date\.now\(\)\)\)\)/.test(flowSrc))

  // 4) 守门断言：这些字必须真的在对面的源码里。对面改一个字，这里先红——
  //    否则我们只会静默退化成「立刻去连、连不上再排队」，谁都不会发现。
  //    注意要盯**那一句**、不是「文件里有这几个字」：一个文件里「星图里没有」出现 4 次，
  //    只查子串的话改掉关键那一次仍会绿（0.2.29 的阴性对照第一次就栽在这上面）。
  const nebIndex = read(join('vendor', 'dsh-memory-nebula', 'lib', 'index.js'))
  const nebCore = read(join('vendor', 'dsh-memory-nebula', 'lib', 'host', 'nebula.js'))
  check(
    '契约: 星图源码里真的还有那两句（按整句认，不是按子串）',
    nebIndex.includes('星图里没有 id=${id} 的记忆') && nebIndex.includes('已固化连线：'),
    `index.js ${nebIndex.length} 字符`,
  )
  check(
    '契约: 引擎源码里真的还有那两句永久失败（按整句认）',
    nebCore.includes("'找不到这两条记忆：'") && nebCore.includes("'不能把一条记忆和它自己配成一对：'"),
    `nebula.js ${nebCore.length} 字符`,
  )

  // 5) 行为级证据与文档
  check('契约: 探针钉住了三态与措辞边界', fusionSrc.includes('O1 星图没接上判 unavailable') && fusionSrc.includes('O4 saysMissing 只认那一句'))
  check('契约: README 记了 contract.js 与 0.2.29', readme.includes('contract.js') && readme.includes('0.2.29'))
  check('契约: DESIGN 记了为什么只能认措辞、以及谁盯着 vendor', design.includes('措辞') && design.includes('vendor'))
}

// ── A28. 同一句「找不到这两条记忆」有两种含义，按年龄分辨（0.2.30）────────────
{
  // 为什么要有这一块：星图的 404 既可能是「节点还没建进图」（12s 一轮巡检），
  // 也可能是「记忆真的没了」。旧代码一律当永久失败摘掉，于是「刚写完记忆、顺手连邻居」
  // 的用户连线被当场清空，还没有任何报错。判据不是文案，而是年龄。
  const read = (p) => readFileSync(join(root, p), 'utf8')
  const linksSrc28 = read(join('lib', 'macro', 'links.js'))
  const flowSrc28 = read(join('lib', 'macro', 'linkflow.js'))
  const linkSrc28 = read(join('lib', 'macro', 'defs', 'link.js'))
  const fusionSrc28 = read(join('tools', 'probe-fusion.mjs'))
  const readme28 = read('docs/INTERNAL.md')
  const design28 = read('DESIGN.md')
  const links28 = await import('./lib/macro/links.js')

  // 1) 宽限期是个有量级的数，不是一个随手的常量
  check(
    '宽限: MISSING_GRACE_MS 导出且是分钟量级',
    Number.isFinite(links28.MISSING_GRACE_MS) && links28.MISSING_GRACE_MS >= 5 * 60 * 1000 && links28.MISSING_GRACE_MS <= 60 * 60 * 1000,
    String(links28.MISSING_GRACE_MS),
  )

  // 2) 旧的「一刀切」判据必须彻底消失：留着它，将来一定有人再拿它去摘刚写完的连线
  check(
    '宽限: isPermanentFailure 没留下来，两句分开判',
    links28.isPermanentFailure === undefined && typeof links28.isSelfPairText === 'function' && typeof links28.saysMissingNodes === 'function',
    typeof links28.isPermanentFailure,
  )
  check(
    '宽限: 源码里不再有一刀切的永久失败判据',
    !linksSrc28.includes('isPermanentFailure') && !flowSrc28.includes('isPermanentFailure') && !linkSrc28.includes('isPermanentFailure'),
  )

  // 3) 判据顺序：成功 → 自己连自己 → 「找不到」按年龄 → 桥没接上
  const iLinked = linksSrc28.indexOf('if (isLinked(r.text))')
  const iSelf = linksSrc28.indexOf('if (isSelfPairText(r.text))')
  const iMissing = linksSrc28.indexOf('if (saysMissingNodes(r.text))')
  const iDown = linksSrc28.indexOf('if (r.entry === undefined)')
  check(
    '宽限: 判据顺序是 成功→自己连自己→找不到→没接上',
    iLinked > 0 && iLinked < iSelf && iSelf < iMissing && iMissing < iDown,
    `${iLinked}/${iSelf}/${iMissing}/${iDown}`,
  )
  check(
    '宽限: 「找不到」只按年龄决定留还是摘',
    /Date\.now\(\) - entry\.ts >= MISSING_GRACE_MS/.test(linksSrc28) && linksSrc28.includes('dropped += 1'),
  )

  // 4) 两条写路径都要排队，不能把用户的 links 一句「找不到」打发掉
  check(
    '宽限: applyLinks 遇到「找不到」排队，理由是节点待入图',
    flowSrc28.includes('saysMissingNodes(r.text)') &&
      flowSrc28.includes('notBuilt ? PENDING_REASONS.notBuilt') &&
      flowSrc28.includes('queuePending('),
  )
  check(
    '宽限: memory_link 也排队，并且照实说「还没建到」',
    linkSrc28.includes('saysMissingNodes(why)') && linkSrc28.includes('PENDING_REASONS.notBuilt') && linkSrc28.includes('还没建到'),
  )

  // 5) 行为级证据（P 段）与旧断言已改口
  const probes28 = ['P1 刚排队就报「找不到」不当永久失败', 'P2 过了宽限期还「找不到」就摘掉', 'P3 「自己连自己」不管多年轻都当场摘', 'P4 写路径遇到「还没建进图」要排队', 'P5 星图没接上就停手', 'P6 连线被预算掐断时 tried 不虚报']
  const missingProbe = probes28.filter((p) => !fusionSrc28.includes(p))
  check('宽限: 探针 P1–P6 钉住了「按年龄分辨」', missingProbe.length === 0, missingProbe.join(' / ') || '6/6')
  check(
    '宽限: 旧断言「直接清掉」已改口',
    !fusionSrc28.includes('不重试，直接清掉') && fusionSrc28.includes('过了宽限期还「找不到」才摘'),
  )

  // 6) 文档
  check('宽限: README 记了 MISSING_GRACE_MS 与 0.2.30', readme28.includes('MISSING_GRACE_MS') && readme28.includes('0.2.30'))
  check('宽限: DESIGN 记了宽限期这件事', design28.includes('宽限'))
}

// ── A29. 前台写路径也有期限：用户在等的那条路不能跟着星图一起挂（0.2.31）──────
{
  // 为什么要有这一块：0.2.28 的预算只管后台补连（flushLinks 1.2s / flushNow 1.5s）。
  // 前台 `memory_link` 和「写记忆时顺手连线」是用户在等的那条路，却一直裸等 `execute`——
  // 星图建图争锁能跑几十秒（links.js 的注释自己写着），工具调用就跟着挂几十秒，
  // 在宿主那边看起来就是「这个工具坏了」。掐断不是失败：addLink 是 ON CONFLICT DO UPDATE，
  // 重复连同一条边幂等，所以排队重试安全。
  const read29 = (p) => readFileSync(join(root, p), 'utf8')
  const linksSrc29 = read29(join('lib', 'macro', 'links.js'))
  const flowSrc29 = read29(join('lib', 'macro', 'linkflow.js'))
  const linkSrc29 = read29(join('lib', 'macro', 'defs', 'link.js'))
  const fusionSrc29 = read29(join('tools', 'probe-fusion.mjs'))
  const readme29 = read29('docs/INTERNAL.md')
  const design29 = read29('DESIGN.md')
  const pkg29 = JSON.parse(read29('package.json'))
  const links29 = await import('./lib/macro/links.js')

  // 1) 期限是个有量级的数：比建图一轮（12s）松，比「几十秒」紧
  check(
    '前台: LINK_CALL_MS 导出且在 5–60 秒之间',
    Number.isFinite(links29.LINK_CALL_MS) && links29.LINK_CALL_MS >= 5000 && links29.LINK_CALL_MS <= 60000,
    String(links29.LINK_CALL_MS),
  )
  check('前台: 三个新出口都在（isTimedOut / describeMs / withBudget）', typeof links29.isTimedOut === 'function' && typeof links29.describeMs === 'function' && typeof links29.withBudget === 'function')

  // 2) 哨兵不外泄：Symbol 留在 links.js 里，外面只能问谓词
  check(
    '前台: 超时哨兵不外泄，只能通过 isTimedOut 问',
    linksSrc29.includes("const TIMED_OUT = Symbol(") && linksSrc29.includes('return x === TIMED_OUT') && !flowSrc29.includes('TIMED_OUT') && !linkSrc29.includes('TIMED_OUT'),
  )

  // 3) 两条前台调用都套上了 withBudget，不是只改了一条
  check(
    '前台: applyLinks 的连线套了期限并按超时排队',
    flowSrc29.includes('withBudget(tryCall(\'nebula_link\'') && flowSrc29.includes('isTimedOut(raw)') && flowSrc29.includes('PENDING_REASONS.slow'),
  )
  check(
    '前台: memory_link 的 link 动作套了期限并按超时排队',
    linkSrc29.includes("withBudget(flow.tryCall('nebula_link', payload") && linkSrc29.includes('PENDING_REASONS.slow') && linkSrc29.includes('describeMs(callMs)'),
  )
  check(
    '前台: 只读的 path 超时不留队列欠账',
    linkSrc29.includes('isTimedOut(raw2)') &&
      linkSrc29.includes('记忆本身没受影响') &&
      // 排队语句只有 link 那一处（在 isTimedOut(raw2) 之前）；path 分支后面不许再出现 queuePending
      linkSrc29.indexOf('PENDING_REASONS.slow') > 0 &&
      linkSrc29.indexOf('PENDING_REASONS.slow') < linkSrc29.indexOf('isTimedOut(raw2)') &&
      !linkSrc29.slice(linkSrc29.indexOf('isTimedOut(raw2)')).includes('queuePending('),
  )
  // 4) 裸等的老写法必须消失，否则期限加了等于没加
  check('前台: 写路径不再裸等 nebula_link', !flowSrc29.includes("const r = await tryCall('nebula_link'") && !linkSrc29.includes("const r = await flow.tryCall('nebula_link', payload, exec, '星图连线')"))

  // 5) 期限可配（探针和重负载机器都要能改），并且真的透给 defs
  check('前台: linkCallMs 可配且透出给 defs/*.js', flowSrc29.includes('config.linkCallMs ?? LINK_CALL_MS') && /linkCallMs,\s+linkBatchMs/.test(flowSrc29) && flowSrc29.includes('graphState,') )

  // 6) 行为级证据：Q 段六组，钉住「墙钟受控 + 条目留队 + 文案不赖用户」
  const probes29 = ['Q1 写路径连线超时按期限掐断', 'Q1 掐断后条目留队', 'Q2 memory_link 前台调用也被期限包住', 'Q3 正常路径原样转述星图的话', 'Q4 path 超时不留队列欠账', 'Q5 isTimedOut 只认掐断', 'Q6 期限文案不出现「0 秒」']
  const missingQ = probes29.filter((p) => !fusionSrc29.includes(p))
  check('前台: 探针 Q1–Q6 钉住了前台期限', missingQ.length === 0, missingQ.join(' / ') || `${probes29.length}/${probes29.length}`)

  // 7) 版本与文档（版本会一直往前走，这里只钉「不早于 0.2.31」，具体值交给当轮那块断言）
  const v29 = pkg29.version.split('.').map(Number)
  check('前台: 版本不早于 0.2.31', v29[0] === 0 && v29[1] === 2 && v29[2] >= 31, pkg29.version)
  check('前台: README 记了 LINK_CALL_MS', readme29.includes('LINK_CALL_MS'))
  check('前台: DESIGN 讲了「前台也要有期限」这件事', design29.includes('0.2.31') && design29.includes('前台'))
}


// ── A30. 一批连线两道闸：条数与总时长，超出的排队不许悄悄消失（0.2.32）────────
{
  // 为什么要有这一块：`applyLinks` 里原本写的是 `items.slice(0, 12)`。
  // 模型给 15 条 links，后 3 条既没连、也没排队、文案里一个字都没提——用户的意图就这么消失了，
  // 而且一切看起来都正常（执行 0 条错误）。另一头：单条期限 20 秒，12 条各挂 20 秒就是 4 分钟，
  // 用户在等的那条路照样能挂死，只是挂了十二次。所以一批也要有总账，超出的排队。
  const read30 = (p) => readFileSync(join(root, p), 'utf8')
  const linksSrc30 = read30(join('lib', 'macro', 'links.js'))
  const flowSrc30 = read30(join('lib', 'macro', 'linkflow.js'))
  const fusionSrc30 = read30(join('tools', 'probe-fusion.mjs'))
  const readme30 = read30('docs/INTERNAL.md')
  const design30 = read30('DESIGN.md')
  const pkg30 = JSON.parse(read30('package.json'))
  const links30 = await import('./lib/macro/links.js')

  // 1) 两个闸都是有量级的常量
  check(
    '单批: LINKS_PER_WRITE 导出且在 8–30 条之间',
    Number.isFinite(links30.LINKS_PER_WRITE) && links30.LINKS_PER_WRITE >= 8 && links30.LINKS_PER_WRITE <= 30,
    String(links30.LINKS_PER_WRITE),
  )
  check(
    '单批: LINK_BATCH_MS 导出且在 10–120 秒之间',
    Number.isFinite(links30.LINK_BATCH_MS) && links30.LINK_BATCH_MS >= 10000 && links30.LINK_BATCH_MS <= 120000,
    String(links30.LINK_BATCH_MS),
  )

  // 2) 静默截断必须彻底消失：source 里不许再出现写死的 12
  check(
    '单批: 写死的 items.slice(0, 12) 已经消失',
    !flowSrc30.includes('items.slice(0, 12)') && flowSrc30.includes('const head = items.slice(0, linksPerWrite)'),
  )

  // 3) 「星图还没就绪」那条路上排队不设上限：15 条也要全留下
  check(
    '单批: 星图没就绪时整批排队，不截条数',
    flowSrc30.includes('for (const target of items) {') && !flowSrc30.includes('for (const target of items.slice('),
  )

  // 4) 一批的总账：期限取 min(单条上限, 剩余整批时间)
  check(
    '单批: 每条的期限取 min(linkCallMs, 整批剩余)',
    flowSrc30.includes('const deadline = Date.now() + linkBatchMs') && flowSrc30.includes('Math.min(linkCallMs, left)'),
  )

  // 5) 没轮到的（超条数 / 超总时长）都进队列，理由单独一条
  check(
    '单批: 超出的条目一律排队，理由可分辨',
    flowSrc30.includes('[...overflow, ...later]') && flowSrc30.includes('PENDING_REASONS.deferred'),
  )

  // 6) 两种情况都要说出来，而不是只说「已连上」
  check(
    '单批: 文案分别说清「多出来几条」与「整批最多连多久」',
    flowSrc30.includes('多出来的 ${overflow.length} 条已排队') && flowSrc30.includes('整批最多连 ${describeMs(linkBatchMs)}'),
  )

  // 7) 两个闸都能被 config 覆盖，并透给 defs / 探针
  check(
    '单批: 两个闸都可配且透出',
    flowSrc30.includes('config.linkBatchMs ?? LINK_BATCH_MS') &&
      flowSrc30.includes('config.linksPerWrite ?? LINKS_PER_WRITE') &&
      /linkCallMs,\s+linkBatchMs,\s+linksPerWrite,/.test(flowSrc30),
  )

  // 8) 行为级证据：R 段五组十项
  const probes30 = [
    'R1 单批当场最多连 LINKS_PER_WRITE 条',
    'R1 多出来的 3 条进队列，不许消失',
    'R1 文案说清「多出来的已排队」',
    'R2 一批的总时长受 linkBatchMs 约束',
    'R2 没轮到的进队列，一条不丢',
    'R2 文案说清「整批最多连多久」',
    'R3 正常路径三条都连上',
    'R3 正常路径不进队列、也不多说一句',
    'R4 星图没就绪时 15 条全排队',
    'R5 两条闸的默认值',
    'R5 两条闸都能从 config 覆盖并读回',
    'R6 单条比整批总账慢时按整批掐断',
    'R6 掐断后两条都在队列里',
    'R6 文案里的期限是整批的剩余',
  ]
  const missingR = probes30.filter((p) => !fusionSrc30.includes(p))
  check('单批: 探针 R1–R6 钉住了两道闸', missingR.length === 0, missingR.join(' / ') || `${probes30.length}/${probes30.length}`)

  // 9) 版本与文档（版本会一直往前走：这里只钉「不早于 0.2.32」，具体值交给当轮那块断言）
  const v30 = pkg30.version.split('.').map(Number)
  check('单批: 版本不早于 0.2.32', v30[0] === 0 && v30[1] === 2 && v30[2] >= 32, pkg30.version)
  check('单批: README 记了 LINKS_PER_WRITE / LINK_BATCH_MS 与 0.2.32', readme30.includes('LINKS_PER_WRITE') && readme30.includes('LINK_BATCH_MS') && readme30.includes('0.2.32'))
  check('单批: DESIGN 讲了「一批也要有总账」', design30.includes('0.2.32') && design30.includes('一批也要有总账'), design30.includes('一批也要有总账') ? '有' : '没有')
}

// ── A31. 面板口径：理由只有一份、按理由分组、面板不写数（0.2.33）────────────
{
  // 为什么要有这一块：同一件事在两条路上有两种叫法——写记忆那条记 `连线失败待重试`，
  // `memory_link` 那条记 `memory_link 失败待重试`。面板把理由摊在每行括号里，用户看到
  // 「2 条连线失败 + 1 条 memory_link 失败」，会以为是两件不同的事；再加上一串明细里
  // 看不出「是星图慢，还是我们没轮到」。另一头：1200/1500/8/20/1500 这些数散在三处，
  // 面板还自己再传一遍 `{ budgetMs: 1500, limit: 20 }`——改了默认值面板不知道。
  const read31 = (p) => readFileSync(join(root, p), 'utf8')
  const linksSrc31 = read31(join('lib', 'macro', 'links.js'))
  const flowSrc31 = read31(join('lib', 'macro', 'linkflow.js'))
  const linkSrc31 = read31(join('lib', 'macro', 'defs', 'link.js'))
  const adminSrc31 = read31(join('lib', 'macro', 'defs', 'admin.js'))
  const fusionSrc31 = read31(join('tools', 'probe-fusion.mjs'))
  const doctorSrc31 = read31(join('tools', 'doctor.mjs'))
  const readme31 = read31('docs/INTERNAL.md')
  const design31 = read31('DESIGN.md')
  const pkg31 = JSON.parse(read31('package.json'))
  const links31 = await import('./lib/macro/links.js')
  const flow31 = await import('./lib/macro/linkflow.js')

  // 1) 口径判据只有一份：tools/criteria.mjs
  //    以前这一节与 doctor 的结构段各写一遍，宽严还不一样（这里查全部五个值，doctor 只查两个），
  //    于是把 `'连线失败待重试'` 抄回 linkflow 会 verify 红、doctor 绿 —— 体检漏在最该看的地方。
  const criteria31 = await import('./tools/criteria.mjs')
  const list31 = criteria31.reasonChecklist({
    linksSrc: linksSrc31,
    flowSrc: flowSrc31,
    linkSrc: linkSrc31,
    adminSrc: adminSrc31,
    reasons: links31.PENDING_REASONS ?? {},
    order: links31.REASON_ORDER ?? [],
  })
  check(
    '口径: 判据清单十一条且 id 不重复',
    list31.length === 11 && new Set(list31.map((c) => c.id)).size === 11,
    `${list31.length} 条`,
  )
  for (const item of list31) check(`口径清单: ${item.label}`, item.ok, item.detail)
  check(
    '口径: 体检读的是同一份清单，没有第二份写法',
    /from '\.\/criteria\.mjs'/.test(doctorSrc31) && !doctorSrc31.includes('节点待入图') && !doctorSrc31.includes('memory_link 失败待重试'),
    /from '\.\/criteria\.mjs'/.test(doctorSrc31) ? 'doctor 已改读 criteria.mjs' : 'doctor 还自己写判据',
  )
  check(
    '口径: 清单没通过时能说清是哪几条（summarizeChecklist）',
    (() => {
      const bad = criteria31.summarizeChecklist([{ label: '理由字面量', ok: false, detail: '星图太慢待重试' }])
      const okSum = criteria31.summarizeChecklist([{ label: '假', ok: true, detail: '' }])
      return bad === '理由字面量（星图太慢待重试）' && okSum === '1/1 全过'
    })(),
    criteria31.summarizeChecklist(list31).slice(0, 80),
  )
  // 单一口径最大的风险是「判据恒真」：两边都读它，它要是不响，验和体检就一起瞎。
  // 自检逐条造一个只该弄红那一条的输入，样板本身有红或某条造坏了都没红都不算数。
  const selftest31 = criteria31.selfTestChecklist()
  check(
    '口径: 每条判据都验证过能被打红（不是恒真）',
    selftest31.baseline.length === 0 && selftest31.survived.length === 0,
    `样板红 ${selftest31.baseline.join(',') || '无'} / 打不红 ${selftest31.survived.join(',') || '无'}`,
  )

  // 4) 期限只有一个出口：常量 + config，面板不写数
  check(
    '口径: 补连的四个数与轮询粒度都是有量的常量',
    flow31.FLUSH_LINKS_BUDGET_MS === 1200 &&
      flow31.FLUSH_LINKS_LIMIT === 8 &&
      flow31.FLUSH_NOW_BUDGET_MS === 1500 &&
      flow31.FLUSH_NOW_LIMIT === 20 &&
      flow31.POLL_STEP_MS === 1500,
    `${flow31.FLUSH_LINKS_BUDGET_MS}/${flow31.FLUSH_LINKS_LIMIT}/${flow31.FLUSH_NOW_BUDGET_MS}/${flow31.FLUSH_NOW_LIMIT}/${flow31.POLL_STEP_MS}`,
  )
  check(
    '口径: 两条出口各取自己的 config，源码里没有裸数',
    flowSrc31.includes('config.flushBudgetMs ?? FLUSH_LINKS_BUDGET_MS') &&
      flowSrc31.includes('config.panelBudgetMs ?? FLUSH_NOW_BUDGET_MS') &&
      flowSrc31.includes('config.pollStepMs ?? POLL_STEP_MS') &&
      flowSrc31.includes('budgetMs: flushBudgetMs, limit: flushLimit') &&
      !flowSrc31.includes('budgetMs: 1200') &&
      !flowSrc31.includes('budgetMs = 1500') &&
      !flowSrc31.includes('Math.min(1500'),
    'ok',
  )
  // 面板那两条（不自己传数 / 说清还剩几条）已在判据清单里，这里只钉「查的是同一处」已足够
  check(
    '口径: flow 把四个数与轮询粒度交出去（调用方能读回）',
    flowSrc31.includes('panelBudgetMs,\n    panelLimit,\n    pollStepMs,') || /return \{[\s\S]*panelBudgetMs,[\s\S]*pollStepMs,[\s\S]*\}/.test(flowSrc31),
    'ok',
  )

  // 5) 探针 S1–S4 钉住了这些行为
  const probes31 = [
    'S1 理由表五个键齐全且值不重复',
    'S1 面板顺序覆盖全部理由',
    'S2 面板先给一句「按理由」的账',
    'S2 已知理由按固定顺序',
    'S2 旧写法的理由照原样单列在已知之后，不吞',
    'S2 空队列只说一句 0 条，不加「按理由」',
    'S3 面板补连按 panelBudgetMs 掐断',
    'S3 掐断后说清还剩几条',
    'S3 面板按理由分组给出条数',
    'S4 后台补连用 flushBudgetMs，到点就收手',
    'S4 后台掐断后条目还在队列里',
    'S4 两套数各归各的，都能读回',
  ]
  const missingS = probes31.filter((p) => !fusionSrc31.includes(p))
  check('口径: 探针 S1–S4 钉住了理由分组与两条期限', missingS.length === 0, missingS.join(' / ') || `${probes31.length}/${probes31.length}`)

  // 6) 版本与文档
  // 版本会一直往前走：这里只钉「不早于 0.2.33」，具体值交给当轮那块
  const v31 = pkg31.version.split('.').map(Number)
  check('口径: 版本不早于 0.2.33', v31[0] === 0 && v31[1] === 2 && v31[2] >= 33, pkg31.version)
  check(
    '口径: README 记了理由表与 0.2.33',
    readme31.includes('PENDING_REASONS') && readme31.includes('0.2.33'),
    readme31.includes('PENDING_REASONS') ? '有' : '没有',
  )
  check('口径: DESIGN 讲了「理由也是口径」', design31.includes('0.2.33') && design31.includes('理由也是口径'), design31.includes('理由也是口径') ? '有' : '没有')
}

// ── A32. 注入截断也要说话：切了就说切了，而且把「去哪看全文」留住（0.2.34）──────
{
  // 为什么要有这一块：`clampGuide` 原本是「超了就在行边界切一刀」，切完一个字都不说。
  // 模型看到的手册就少了一截，而最可能被切掉的正是最后那行「完整手册见 memory_admin(action="guide")」——
  // 于是它既不知道自己看到的是残本，也不知道还能去哪要全文。上限本身没错，错在切得不出声。
  const prompt = await import('./lib/macro/prompt.js')
  const { GUIDE_TEXT, GUIDE_MAX_CHARS, GUIDE_MIN_HEADROOM, GUIDE_TAIL_MARK, clampGuide } = prompt
  const long = Array.from({ length: 40 }, (_, i) => `第 ${i} 行：这是一段专门用来把上限顶穿的文本。`).join('\n')

  check('注入: 没超上限时一个字都不改', clampGuide('abc', 10) === 'abc', clampGuide('abc', 10))
  check('注入: 当前手册本身没触顶', clampGuide() === GUIDE_TEXT, `${GUIDE_TEXT.length}/${GUIDE_MAX_CHARS}`)
  check(
    '注入: 手册留有余量（低于余量说明该删句子，而不是等它被截）',
    GUIDE_MAX_CHARS - GUIDE_TEXT.length >= GUIDE_MIN_HEADROOM,
    `余量 ${GUIDE_MAX_CHARS - GUIDE_TEXT.length} / 下限 ${GUIDE_MIN_HEADROOM}`,
  )
  check(
    '注入: 余量下限是个有量级的数',
    Number.isFinite(GUIDE_MIN_HEADROOM) && GUIDE_MIN_HEADROOM >= 60 && GUIDE_MIN_HEADROOM <= 300,
    String(GUIDE_MIN_HEADROOM),
  )

  const out = clampGuide(long, 300)
  check('注入: 超上限时自己说出来（带截断尾巴）', out.includes(GUIDE_TAIL_MARK), out.slice(-30))
  check('注入: 截断后的长度仍在上限内（尾巴算在预算里）', out.length <= 300, `${out.length}/300`)
  check(
    '注入: 截断后「去哪看全文」不许丢',
    out.includes('memory_admin(action="guide")'),
    out.includes('memory_admin(action="guide")') ? '在' : '丢了',
  )
  check('注入: 尾巴在最后一行，不埋在半截句子后面', out.endsWith(GUIDE_TAIL_MARK), JSON.stringify(out.split('\n').pop()?.slice(0, 24)))
  check(
    '注入: 上限小到放不下尾巴时也不崩（不伪造完整）',
    clampGuide(long, 5).length === 5 && clampGuide(long, 0) === '',
    `${clampGuide(long, 5).length}/${clampGuide(long, 0).length}`,
  )

  // 文档与版本
  const read32 = (p) => readFileSync(join(root, p), 'utf8')
  const pkg32 = JSON.parse(read32('package.json'))
  // 版本会一直往前走：这里只钉「不早于 0.2.34」，具体值交给当轮那块
  const v32 = pkg32.version.split('.').map(Number)
  check('注入: 版本不早于 0.2.34', v32[0] === 0 && v32[1] === 2 && v32[2] >= 34, pkg32.version)
  check(
    '注入: README 记了 GUIDE_TAIL_MARK 与 0.2.34',
    read32('docs/INTERNAL.md').includes('GUIDE_TAIL_MARK') && read32('docs/INTERNAL.md').includes('0.2.34'),
    read32('docs/INTERNAL.md').includes('GUIDE_TAIL_MARK') ? '有' : '没有',
  )
  check(
    '注入: DESIGN 讲了「截断也要说话」',
    read32('DESIGN.md').includes('0.2.34') && read32('DESIGN.md').includes('截断也要说话'),
    read32('DESIGN.md').includes('截断也要说话') ? '有' : '没有',
  )
}

// ── A33. 面板说清这一轮的上限：被什么掐的，得看得出来（0.2.36）──────────────
{
  // 为什么要有这一块：`memory_admin(action="links")` 会先手动补一轮（有预算），再把队列摊开。
  // 预算用完了会说「还剩 N 条」，但**没说这个 N 是被 1.5 秒掐的还是被 20 条掐的**——
  // 用户看到「还剩 12 条」只会想「再点一次」，其实再点也一样，因为时间只给了 1.5 秒。
  // 数字本来就在 flow 的配置里，面板不该自己写，只能转述。
  const read33 = (p) => readFileSync(join(root, p), 'utf8')
  const linksSrc33 = read33(join('lib', 'macro', 'links.js'))
  const adminSrc33 = read33(join('lib', 'macro', 'defs', 'admin.js'))
  const fusionSrc33 = read33(join('tools', 'probe-fusion.mjs'))
  const pkg33 = JSON.parse(read33('package.json'))

  check(
    '上限: 补连结果把这一轮的上限一起交出来（空队列那次也一样）',
    (linksSrc33.match(/stopped: 'empty', budgetMs, limit/g) ?? []).length === 1 &&
      /return \{ tried, linked, dropped, ambiguous, unavailable, left: readPending\(\)\.length, stopped, budgetMs, limit \}/.test(linksSrc33),
    (linksSrc33.match(/budgetMs, limit/g) ?? []).length + ' 处',
  )
  check(
    '上限: 面板转述 flow 的数，自己不写数',
    adminSrc33.includes('describeMs(round.budgetMs)') &&
      adminSrc33.includes('${round.limit}') &&
      // 判据只看代码行：注释里那句「以前这里传 { budgetMs: 1500, limit: 20 }」是说明文，不是行为
      !/flushNow\(exec,\s*\{[^}]*budgetMs/.test(adminSrc33),
    adminSrc33.includes('describeMs(round.budgetMs)') ? 'ok' : '面板没转述上限',
  )
  check(
    '上限: describeMs 从 links.js 进 admin（秒/毫秒只有一个出口）',
    /import \{ describeMs, pendingReport \} from '\.\.\/links\.js'/.test(adminSrc33),
    adminSrc33.includes('describeMs') ? 'ok' : '没引 describeMs',
  )
  const probes33 = ['S3 面板说清这一轮的上限（时间与条数都来自 config）', 'S5 空队列也说清这一轮的上限', 'S5 空队列不冒充「有预算在用」']
  const missing33 = probes33.filter((p) => !fusionSrc33.includes(p))
  check('上限: 探针 S3/S5 钉住了这两句', missing33.length === 0, missing33.join(' / ') || '3/3')

  const v33 = pkg33.version.split('.').map(Number)
  check('上限: 版本不早于 0.2.36', v33[0] === 0 && v33[1] === 2 && v33[2] >= 36, pkg33.version)
  check(
    '上限: README 与 DESIGN 记了这一轮',
    read33('docs/INTERNAL.md').includes('0.2.36') && read33('DESIGN.md').includes('0.2.36') && read33('DESIGN.md').includes('被什么掐的'),
    `${read33('docs/INTERNAL.md').includes('0.2.36')}/${read33('DESIGN.md').includes('0.2.36')}`,
  )
}

// ── A34. path 的四种回答要分辨：两种是「还没算」，一种是「算完了没关系」（0.2.37）──
{
  // 为什么要有这一块：`memory_link(action="path")` 以前把 `nebula_path` 的话原样转述。
  // 但那四句里有两句是「节点还没建进图」（12s 一轮巡检）——字面上像「它们没关系」，
  // 实际是「还没算」。用户会当结论收下，然后再也不问了。0.2.30 那句 404 背两个意思，
  // 这是同一个坏法的第二个工具。
  const read34 = (p) => readFileSync(join(root, p), 'utf8')
  const contractSrc34 = read34(join('lib', 'macro', 'contract.js'))
  const linkSrc34 = read34(join('lib', 'macro', 'defs', 'link.js'))
  const fusionSrc34 = read34(join('tools', 'probe-fusion.mjs'))
  const pkg34 = JSON.parse(read34('package.json'))
  const contract34 = await import('./lib/macro/contract.js')

  const MARKS34 = {
    PATH_MISSING_NODES_MARK: '找不到这两个节点',
    PATH_NOT_IN_GRAPH_MARK: '节点不在当前星图里',
    PATH_UNRELATED_MARK: '没有关系就不编关系',
    PATH_ENGINE_STALE_MARK: '还没带上路径搜索',
  }
  const missing34 = Object.entries(MARKS34).filter(([n, m]) => !contractSrc34.includes(`export const ${n} = '${m}'`))
  check('path: 四句话都在 contract.js 起名', missing34.length === 0, missing34.map(([n]) => n).join(', ') || '4/4')
  check(
    'path: 这些字在 defs/link.js 里一个字都不许再写',
    Object.values(MARKS34).every((m) => !linkSrc34.includes(`'${m}'`)),
    Object.values(MARKS34).filter((m) => linkSrc34.includes(`'${m}'`)).join(', ') || '无泄漏',
  )
  check('path: 归类函数只有 contract.js 一处，且 link 从那里取', /export function pathAnswerKind\(/.test(contractSrc34) && linkSrc34.includes("from '../contract.js'") && linkSrc34.includes('pathAnswerKind('))

  // 行为级：归类本身必须对。顺序就是判据——先认「没入图」，再看「没关系」，
  // 否则「找不到这两个节点…没有关系就不编关系」这种拼接文本会被判成结论。
  const CASES34 = [
    ['找不到这两个节点：a / b', 'missing'],
    ['节点不在当前星图里', 'missing'],
    ['这个引擎版本还没带上路径搜索（等宿主重启后生效）', 'engineStale'],
    ['这两条记忆在星图里没有连上（超过 6 跳）。没有关系就不编关系。', 'unrelated'],
    ['找不到这两个节点：a / b。没有关系就不编关系。', 'missing'],
    ['a → b（1 跳）\n每一步都来自建图时算出的边', 'ok'],
    ['', 'ok'],
  ]
  const bad34 = CASES34.filter(([text, want]) => contract34.pathAnswerKind(text) !== want)
  check('path: 六种输入各自归对类（含拼接与空串）', bad34.length === 0, bad34.map(([t, w]) => `${w}:${t.slice(0, 6)}`).join(' / ') || `${CASES34.length}/${CASES34.length}`)

  // 结构性：只读动作不许因为翻译就多出队列欠账；真结论照原样转述
  check(
    'path: 翻译在 path 分支里，且只读动作不进队列',
    /if \(action !== 'path'\) return r2\.text/.test(linkSrc34) &&
      linkSrc34.indexOf("kind === 'missing'") > linkSrc34.indexOf('pathAnswerKind(') &&
      !/kind === 'missing'[\s\S]{0,400}queuePending\(/.test(linkSrc34),
    linkSrc34.includes("if (kind === 'engineStale')") ? 'ok' : '缺 engineStale 分支',
  )

  const probes34 = [
    'T1 四类回答各归各的（顺序对了才不会把「没算」判成结论）',
    'T1 拼接文本先认「没入图」（顺序即判据）',
    // 探针里是模板串，判据照抄源码那一行（不照抄渲染后的结果）
    'T2 「${text.slice(0, 6)}」不冒充结论',
    'T3 真没关系原样转述（不替星图下结论）',
    'T4 旧引擎说清「要重启宿主」而不是「没关系」',
    'T5 翻译不改只读语义：队列一条都不许涨',
  ]
  const missingP34 = probes34.filter((p) => !fusionSrc34.includes(p))
  check('path: 探针 T1–T5 钉住了四种回答与只读语义', missingP34.length === 0, missingP34.join(' / ') || '6/6')

  const v34 = pkg34.version.split('.').map(Number)
  check('path: 版本不早于 0.2.37', v34[0] === 0 && v34[1] === 2 && v34[2] >= 37, pkg34.version)
  check(
    'path: README 与 DESIGN 记了这一轮',
    read34('docs/INTERNAL.md').includes('0.2.37') && read34('DESIGN.md').includes('0.2.37') && read34('DESIGN.md').includes('还没算'),
    `${read34('docs/INTERNAL.md').includes('0.2.37')}/${read34('DESIGN.md').includes('0.2.37')}`,
  )
}

// A36（0.2.39）：空命中也背两个意思——「图里真没有」和「图还没建完」。
// 这一族和 A34 的 path 是同一类坏法：星图一句话，我们原样转述就替用户确认了没算过的事。
{
  const c36 = await import('./lib/macro/contract.js')
  const contractSrc36 = readFileSync(join(root, 'lib', 'macro', 'contract.js'), 'utf8')
  const search36 = readFileSync(join(root, 'lib', 'macro', 'defs', 'search.js'), 'utf8')
  const nebIndex36 = readFileSync(join(root, 'vendor', 'dsh-memory-nebula', 'lib', 'index.js'), 'utf8')
  const fusion36 = readFileSync(join(root, 'tools', 'probe-fusion.mjs'), 'utf8')

  check(
    'recall: 两个常量按值起名（改字必须先改契约）',
    c36.RECALL_EMPTY_GRAPH_MARK === '星图里还没有节点（图是空的）' && c36.RECALL_NO_MATCH_MARK === '星图里没有匹配',
    `${c36.RECALL_EMPTY_GRAPH_MARK} / ${c36.RECALL_NO_MATCH_MARK}`,
  )
  check('recall: 归类只有一处实现，检索侧从 contract 取', /export function recallAnswerKind\(/.test(contractSrc36) && search36.includes('recallAnswerKind('))
  check(
    'recall: 检索侧不许再写这两个字面量',
    !search36.includes(`'${c36.RECALL_EMPTY_GRAPH_MARK}'`) && !search36.includes(`'${c36.RECALL_NO_MATCH_MARK}'`),
    '干净',
  )
  const kinds36 = [
    ['nebula_recall: 星图里还没有节点（图是空的），这一问等于没算。', 'emptyGraph'],
    ['nebula_recall: 星图里没有匹配「q」的记忆（图里 12 条节点，一条都对不上）。', 'noMatch'],
    ['— 星图关联扩散 —\n命中 2 条', 'ok'],
    ['', 'ok'],
  ]
  const wrong36 = kinds36.filter(([t, want]) => c36.recallAnswerKind(t) !== want)
  check('recall: 三种回答各归各的（空串也是 ok，不瞎猜）', wrong36.length === 0, wrong36.map(([t, w]) => `${w}:${t.slice(0, 8)}`).join(' / ') || `${kinds36.length}/${kinds36.length}`)

  // vendor 补丁：空命中不再只说一句话，扫描条数必须留住
  check(
    'recall: 星图源码里空命中带上了节点总数（0.2.39 补丁在位）',
    nebIndex36.includes('星图里还没有节点（图是空的），这一问等于没算。') && nebIndex36.includes('一条都对不上'),
    nebIndex36.includes('这一问等于没算') ? 'ok' : '空命中又只剩一句话',
  )
  check(
    'recall: 空图与零命中在星图源码里是两个分支（不是一个字符串拼出来的）',
    /total === 0[\s\S]{0,200}星图里还没有节点[\s\S]{0,200}没有匹配/.test(nebIndex36),
    'ok',
  )

  // 我们这边：空图必须退回本地（以 meow 为主），零命中照原样转述
  check(
    'recall: graph/bridge 遇到空图先退本地再解释',
    /recallAnswerKind\(r\.text\) === 'emptyGraph'/.test(search36) &&
      search36.includes('这不是「没有这条记忆」的答案') &&
      search36.includes('星图现在还是空的'),
  )
  check(
    'recall: 没 query 时讲清「给个 query 就能兜住」',
    search36.includes('给个 query 我就能先用本地检索兜住'),
  )
  check(
    'recall: local 零命中自动扩散时，空图只附一句「没算」不冒充佐证',
    search36.includes('关联扩散这次没算') && search36.includes('这不是「确认没有」'),
  )
  const probes36 = ['U1 两种空命中各归各的', 'U2 空图不是「没有这条记忆」的答案', 'U3 空图 + 没 query', 'U4 空图时 mode=bridge', 'U5 本地零命中时自动扩散仍然发生', 'U6 真没有匹配时原样转述', 'U7 空命中的翻译不改只读语义']
  const missingP36 = probes36.filter((p) => !fusion36.includes(p))
  check('recall: 探针 U1–U7 钉住了空图的两种说法与只读语义', missingP36.length === 0, missingP36.join(' / ') || `${probes36.length}/${probes36.length}`)

  const v36 = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version.split('.').map(Number)
  check('recall: 版本不早于 0.2.39', v36[0] === 0 && v36[1] === 2 && v36[2] >= 39, v36.join('.'))
  check(
    'recall: README 与 DESIGN 记了这一轮',
    readFileSync(join(root, 'docs', 'INTERNAL.md'), 'utf8').includes('0.2.39') && readFileSync(join(root, 'DESIGN.md'), 'utf8').includes('0.2.39') && readFileSync(join(root, 'DESIGN.md'), 'utf8').includes('空命中'),
    `${readFileSync(join(root, 'docs', 'INTERNAL.md'), 'utf8').includes('0.2.39')}/${readFileSync(join(root, 'DESIGN.md'), 'utf8').includes('0.2.39')}`,
  )
}


// A37（0.2.40）：体检的「共 0 项」也背两个意思——「一条毛病都没有」和「一条都没算」。
{
  const contract37 = await import(pathToFileURL(join(root, 'lib/macro/contract.js')).href)
  const criteria37 = await import(pathToFileURL(join(root, 'tools/criteria.mjs')).href)
  const nebIndex37 = readFileSync(join(root, 'vendor', 'dsh-memory-nebula', 'lib', 'index.js'), 'utf8')
  const probeGraph37 = readFileSync(join(root, 'tools', 'probe-graph.mjs'), 'utf8')
  const fusion37 = readFileSync(join(root, 'tools', 'probe-fusion.mjs'), 'utf8')
  const contractSrc37 = readFileSync(join(root, 'lib', 'macro', 'contract.js'), 'utf8')

  check(
    '体检: 常量按值起名（这次体检等于没算）',
    contractSrc37.includes("export const HYGIENE_EMPTY_GRAPH_MARK = '这次体检等于没算'"),
    'HYGIENE_EMPTY_GRAPH_MARK',
  )
  check(
    '体检: 归类只有一处实现，两种输入各归各的',
    /export function hygieneAnswerKind\(/.test(contractSrc37) &&
      contract37.hygieneAnswerKind('记忆体检：星图里还没有节点（图是空的），这次体检等于没算——') === 'emptyGraph' &&
      contract37.hygieneAnswerKind('记忆体检：共 0 项（只诊断，不动任何记忆）') === 'ok' &&
      contract37.hygieneAnswerKind('') === 'ok',
    contract37.hygieneAnswerKind('记忆体检：共 0 项'),
  )
  check(
    '体检: 凭据是「图里有多少节点」，不是「查出多少毛病」',
    /nodes\?\.length[\s\S]{0,60}=== 0/.test(nebIndex37) && !/h\.total === 0/.test(nebIndex37),
    'vendor/index.js 的 nebula_hygiene',
  )
  check(
    '体检: vendor 里空图那一支说清了「0 项不是干净」',
    nebIndex37.includes('这次体检等于没算') && nebIndex37.includes('「0 项」不是「很干净」') && nebIndex37.includes('[macro-fusion 0.2.40]'),
    '补丁在不在',
  )
  check(
    `体检: 措辞表里有这一条，判据清单里也有 vendor-hygiene（共 ${Object.keys(criteria37.CONTRACT_MARKS).length} 个常量）`,
    criteria37.CONTRACT_MARKS.HYGIENE_EMPTY_GRAPH_MARK === contract37.HYGIENE_EMPTY_GRAPH_MARK &&
      criteria37.contractChecklist({ contractSrc: contractSrc37, nebIndexSrc: nebIndex37 }).some((c) => c.id === 'vendor-hygiene'),
    String(Object.keys(criteria37.CONTRACT_MARKS).length) + ' 个常量',
  )
  check(
    '体检: 探针钉住了「空图」与「有节点」两面（G1b / G1c）',
    probeGraph37.includes('G1b 空图时体检说「等于没算」，不是「共 0 项」') &&
      probeGraph37.includes('G1c 有节点后体检不再说「等于没算」'),
    'probe-graph',
  )
  check(
    '体检: 面板侧也钉住了（V1–V3）',
    fusion37.includes('V1 体检的空结果被归成「没算」') &&
      fusion37.includes('V2 面板把「等于没算」原样交给用户') &&
      fusion37.includes('V3 真干净时不许加「没算」的噪声'),
    'probe-fusion',
  )
  const v37 = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version.split('.').map(Number)
  check('体检: 版本不早于 0.2.40', v37[0] === 0 && v37[1] === 2 && v37[2] >= 40, v37.join('.'))
  check(
    '体检: README 与 DESIGN 记了这一轮',
    readFileSync(join(root, 'docs', 'INTERNAL.md'), 'utf8').includes('0.2.40') &&
      readFileSync(join(root, 'DESIGN.md'), 'utf8').includes('0.2.40') &&
      readFileSync(join(root, 'DESIGN.md'), 'utf8').includes('共 0 项'),
    '文档',
  )
}

// A38（0.2.41）：星图概况的「0 条记忆」也背两个意思——「图还没建起来」和「记忆丢了」。
// 前四次都是把没算说成没有（让人放心），这次方向反过来：让人恐慌，代价是去还原/重灌。
{
  const contract38 = await import(pathToFileURL(join(root, 'lib/macro/contract.js')).href)
  const criteria38 = await import(pathToFileURL(join(root, 'tools/criteria.mjs')).href)
  const nebIndex38 = readFileSync(join(root, 'vendor', 'dsh-memory-nebula', 'lib', 'index.js'), 'utf8')
  const contractSrc38 = readFileSync(join(root, 'lib', 'macro', 'contract.js'), 'utf8')
  const probeGraph38 = readFileSync(join(root, 'tools', 'probe-graph.mjs'), 'utf8')
  const fusion38 = readFileSync(join(root, 'tools', 'probe-fusion.mjs'), 'utf8')

  check(
    '概况: 常量按值起名（星图现在还是空的）',
    contractSrc38.includes("export const STATS_EMPTY_GRAPH_MARK = '星图现在还是空的'"),
    'STATS_EMPTY_GRAPH_MARK',
  )
  check(
    '概况: 归类只有一处实现，空图与有节点各归各的',
    /export function statsAnswerKind\(/.test(contractSrc38) &&
      contract38.statsAnswerKind('宏记忆 · 星图现在还是空的：0 条记忆 / 0 条连接。') === 'emptyGraph' &&
      contract38.statsAnswerKind('宏记忆 · 星图：28 条记忆 / 41 条连接') === 'ok' &&
      contract38.statsAnswerKind('') === 'ok',
    contract38.statsAnswerKind('宏记忆 · 星图：28 条记忆'),
  )
  check(
    '概况: 空图那一支点了名「这不是记忆丢了」，且说了原因（读失败/没接上/还没建完）',
    nebIndex38.includes('这不是「记忆丢了」') &&
      nebIndex38.includes('一个记忆来源都没接上') &&
      /readErrors/.test(nebIndex38),
    'vendor/index.js 的 nebula_stats',
  )
  check(
    '概况: 补丁有标记，且凭据仍是「图里有多少节点」',
    // 光有这段文字不够：判据要盯住「守卫就在 0.2.41 这段里、且真的在判」，否则 `if (false)` 也能绿。
    /\[macro-fusion 0\.2\.41\][\s\S]{0,700}?nodes\?\.length \?\? 0\) === 0/.test(nebIndex38) &&
      !/\[macro-fusion 0\.2\.41\][\s\S]{0,700}?if \(false\)/.test(nebIndex38),
    '补丁在不在',
  )
  check(
    `概况: 措辞表有这一条，判据清单里也有 vendor-stats（共 ${Object.keys(criteria38.CONTRACT_MARKS).length} 个常量）`,
    criteria38.CONTRACT_MARKS.STATS_EMPTY_GRAPH_MARK === contract38.STATS_EMPTY_GRAPH_MARK &&
      criteria38.contractChecklist({ contractSrc: contractSrc38, nebIndexSrc: nebIndex38 }).some((c) => c.id === 'vendor-stats'),
    String(Object.keys(criteria38.CONTRACT_MARKS).length) + ' 个常量',
  )
  check(
    '概况: 文件头那张表不许有重复行，也不许缺常量',
    (() => {
      const list = criteria38.contractChecklist({ contractSrc: contractSrc38, nebIndexSrc: nebIndex38 })
      const row = list.find((c) => c.id === 'table')
      return row ? row.ok : false
    })(),
    'criteria 的 table 一条',
  )
  check(
    '概况: 探针钉住了「空图」与「有节点」两面（G1d / G1e）',
    probeGraph38.includes('G1d 空图时星图概况点明「这不是记忆丢了」') &&
      probeGraph38.includes('G1e 有节点后星图概况不再说「还是空的」'),
    'probe-graph',
  )
  check(
    '概况: 面板侧也钉住了（W1–W3）',
    fusion38.includes('W1 概况的空图被归成「空图」') &&
      fusion38.includes('W2 面板把「不是记忆丢了」原样交给用户') &&
      fusion38.includes('W3 有节点时不许加「记忆丢了」的噪声'),
    'probe-fusion',
  )
  const v38 = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version.split('.').map(Number)
  check('概况: 版本不早于 0.2.41', v38[0] === 0 && v38[1] === 2 && v38[2] >= 41, v38.join('.'))
  check(
    '概况: README 与 DESIGN 记了这一轮',
    readFileSync(join(root, 'docs', 'INTERNAL.md'), 'utf8').includes('0.2.41') &&
      readFileSync(join(root, 'DESIGN.md'), 'utf8').includes('0.2.41') &&
      readFileSync(join(root, 'DESIGN.md'), 'utf8').includes('记忆丢了'),
    '文档',
  )
}

// A39（0.2.42）：读单条记忆的空结果也背两个意思——「图还是空的」和「图里没这条」。
// 这次的特殊处：这句话不只给人读，`linkflow.graphState()` 也读它来决定「入图了没有」。
{
  const contract39 = await import(pathToFileURL(join(root, 'lib/macro/contract.js')).href)
  const criteria39 = await import(pathToFileURL(join(root, 'tools/criteria.mjs')).href)
  const nebIndex39 = readFileSync(join(root, 'vendor', 'dsh-memory-nebula', 'lib', 'index.js'), 'utf8')
  const contractSrc39 = readFileSync(join(root, 'lib', 'macro', 'contract.js'), 'utf8')
  const linkflow39 = readFileSync(join(root, 'lib', 'macro', 'linkflow.js'), 'utf8')
  const fusion39 = readFileSync(join(root, 'tools', 'probe-fusion.mjs'), 'utf8')
  const EMPTY39 = '星图里还没有节点（图是空的），这次 nebula_inspect 等于没算——这不是「这条记忆不存在」。'
  const NOT_FOUND39 = '星图里没有 id=x 的记忆。这不等于「记忆没了」：图里现有 28 条节点。'
  const OLD39 = '星图里没有 id=x 的记忆。可以先用 nebula_recall 搜一下。'

  check(
    'inspect: 两个常量按值起名',
    contractSrc39.includes("export const INSPECT_EMPTY_GRAPH_MARK = '这次 nebula_inspect 等于没算'") &&
      contractSrc39.includes("export const INSPECT_NOT_FOUND_MARK = '这不等于「记忆没了」'"),
    'INSPECT_EMPTY_GRAPH_MARK / INSPECT_NOT_FOUND_MARK',
  )
  check(
    'inspect: 三种回答各归各的（旧文案也算「没找到」，空串不瞎猜）',
    /export function inspectAnswerKind\(/.test(contractSrc39) &&
      contract39.inspectAnswerKind(EMPTY39) === 'emptyGraph' &&
      contract39.inspectAnswerKind(NOT_FOUND39) === 'notFound' &&
      contract39.inspectAnswerKind(OLD39) === 'notFound' &&
      contract39.inspectAnswerKind('## 连接到的记忆（1/1）') === 'ok' &&
      contract39.inspectAnswerKind('') === 'ok',
    contract39.inspectAnswerKind(EMPTY39) + '/' + contract39.inspectAnswerKind(NOT_FOUND39) + '/' + contract39.inspectAnswerKind(OLD39),
  )
  check(
    'inspect: 「没找到」也认旧文案（补丁被冲掉时不许退化成「已入图」）',
    /INSPECT_NOT_FOUND_MARK\)\s*\|\|\s*s\.includes\(NODE_MISSING_MARK\)/.test(contract39.inspectAnswerKind.toString()),
    'inspectAnswerKind 的兼容分支',
  )
  check(
    'inspect: vendor 空图那支说清「等于没算」，没找到那支说清「不是记忆没了」',
    nebIndex39.includes('这次 nebula_inspect 等于没算') &&
      nebIndex39.includes('这不等于「记忆没了」') &&
      /图里现有 \$\{total\} 条节点/.test(nebIndex39),
    'vendor/index.js 的 nebula_inspect',
  )
  check(
    'inspect: 补丁有标记，凭据是图里节点数',
    /\[macro-fusion 0\.2\.42\][\s\S]{0,400}?const total = nebula\.graph\?\.nodes\?\.length \?\? 0[\s\S]{0,80}?if \(total === 0\)/.test(nebIndex39) &&
      !/\[macro-fusion 0\.2\.42\][\s\S]{0,400}?if \(false\)/.test(nebIndex39),
    '补丁在不在',
  )
  check(
    'inspect: graphState 只认「正常正文」为 ready，不再靠「不含 missing」反推',
    /inspectAnswerKind\(text\) === 'ok'/.test(linkflow39) && !/!saysMissing\(text\)/.test(linkflow39),
    'linkflow.graphState',
  )
  check(
    'inspect: 措辞表有这两条，判据清单里有 vendor-inspect',
    criteria39.CONTRACT_MARKS.INSPECT_EMPTY_GRAPH_MARK === contract39.INSPECT_EMPTY_GRAPH_MARK &&
      criteria39.CONTRACT_MARKS.INSPECT_NOT_FOUND_MARK === contract39.INSPECT_NOT_FOUND_MARK &&
      criteria39
        .contractChecklist({ contractSrc: contractSrc39, nebIndexSrc: nebIndex39 })
        .some((c) => c.id === 'vendor-inspect' && c.ok),
    String(Object.keys(criteria39.CONTRACT_MARKS).length) + ' 个常量',
  )
  check(
    'inspect: 探针钉住了四种归类与「排队理由不是失败」（X1–X5）',
    fusion39.includes('X1 空图归成「没算」') &&
      fusion39.includes('X1 旧文案也归成「没这条」') &&
      fusion39.includes('X2 空图时写入：连线排队，理由是「节点待入图」而不是「失败」') &&
      fusion39.includes('X5 真入图了就当场连上，不排队'),
    'probe-fusion',
  )
  const v39 = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version.split('.').map(Number)
  check('inspect: 版本不早于 0.2.42', v39[0] === 0 && v39[1] === 2 && v39[2] >= 42, v39.join('.'))
  check(
    'inspect: README 与 DESIGN 记了这一轮',
    readFileSync(join(root, 'docs', 'INTERNAL.md'), 'utf8').includes('0.2.42') &&
      readFileSync(join(root, 'DESIGN.md'), 'utf8').includes('0.2.42') &&
      readFileSync(join(root, 'DESIGN.md'), 'utf8').includes('记忆没了'),
    '文档',
  )}

// A40（0.2.43）：来源体检的「已接入 0 个来源，共读到 0 条记忆」也背两个意思——
// 「没接上」（配置没建 / 探测关着 / 读失败）和「接了没读到」。用户读到它第一反应同样是「记忆没了」。
{
  const contract40 = await import(pathToFileURL(join(root, 'lib/macro/contract.js')).href)
  const criteria40 = await import(pathToFileURL(join(root, 'tools/criteria.mjs')).href)
  const nebIndex40 = readFileSync(join(root, 'vendor', 'dsh-memory-nebula', 'lib', 'index.js'), 'utf8')
  const contractSrc40 = readFileSync(join(root, 'lib', 'macro', 'contract.js'), 'utf8')
  const fusion40 = readFileSync(join(root, 'tools', 'probe-fusion.mjs'), 'utf8')
  const EMPTY40 = [
    '配置：/home/u/.dsh/nebula.json（还没有，可新建）',
    '已接入 0 个来源，共读到 0 条记忆——这句有两种意思：',
    '  配置文件还没建——这不等于「记忆没了」。',
  ].join('\n')
  const FULL40 = '已接入 1 个来源，共读到 128 条记忆：\n- [sqlite] meow · 512KB'

  check(
    'sources: 常量按值起名',
    contractSrc40.includes("export const SOURCES_EMPTY_MARK = '这句有两种意思'"),
    'SOURCES_EMPTY_MARK',
  )
  check(
    'sources: 两种回答各归各的（空串不瞎猜）',
    /export function sourcesAnswerKind\(/.test(contractSrc40) &&
      contract40.sourcesAnswerKind(EMPTY40) === 'emptyStores' &&
      contract40.sourcesAnswerKind(FULL40) === 'ok' &&
      contract40.sourcesAnswerKind('') === 'ok',
    contract40.sourcesAnswerKind(EMPTY40) + '/' + contract40.sourcesAnswerKind(FULL40),
  )
  check(
    'sources: vendor 那一支点了名，并分三种「没接上」的原因',
    nebIndex40.includes('这句有两种意思') &&
      nebIndex40.includes('这不等于「记忆没了」') &&
      nebIndex40.includes('一个来源都没接上') &&
      nebIndex40.includes('自动探测关着（autoDetect: false）') &&
      nebIndex40.includes('处读失败（'),
    'vendor/index.js 的 nebula_sources',
  )
  check(
    'sources: 补丁有标记，守卫是在判「来源数」不是别的',
    /\[macro-fusion 0\.2\.43\][\s\S]{0,900}?live\.stores\.length === 0/.test(nebIndex40) &&
      !/\[macro-fusion 0\.2\.43\][\s\S]{0,900}?if \(false\)/.test(nebIndex40),
    '补丁在不在',
  )
  check(
    'sources: 措辞表有这一条，判据清单里有 vendor-sources',
    criteria40.CONTRACT_MARKS.SOURCES_EMPTY_MARK === contract40.SOURCES_EMPTY_MARK &&
      criteria40
        .contractChecklist({ contractSrc: contractSrc40, nebIndexSrc: nebIndex40 })
        .some((c) => c.id === 'vendor-sources' && c.ok),
    String(Object.keys(criteria40.CONTRACT_MARKS).length) + ' 个常量',
  )
  check(
    'sources: 探针钉住了「没接上」与「正常报表」两面（Y1–Y3）',
    fusion40.includes('Y1 「0 个来源」被归成「没接上」') &&
      fusion40.includes('Y2 面板把「这句有两种意思」与原因原样交给用户') &&
      fusion40.includes('Y3 有来源时不许加「记忆没了」的噪声'),
    'probe-fusion',
  )
  const v40 = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version.split('.').map(Number)
  check('sources: 版本不早于 0.2.43', v40[0] === 0 && v40[1] === 2 && v40[2] >= 43, v40.join('.'))
  check(
    'sources: README 与 DESIGN 记了这一轮',
    readFileSync(join(root, 'docs', 'INTERNAL.md'), 'utf8').includes('0.2.43') &&
      readFileSync(join(root, 'DESIGN.md'), 'utf8').includes('0.2.43') &&
      readFileSync(join(root, 'DESIGN.md'), 'utf8').includes('没接上'),
    '文档',
  )
}

// A41（0.2.44）：补邻居的空结果把「种子一条都没找到」说成了「都读过」——
// 没找到 ≠ 读过。四种原因现在分开说，且空图那支仍要被 recallAnswerKind 认成「没算」，
// 否则 defs/search.js 的 bridge 模式就丢了本地兜底。
{
  const contract41 = await import(pathToFileURL(join(root, 'lib/macro/contract.js')).href)
  const criteria41 = await import(pathToFileURL(join(root, 'tools/criteria.mjs')).href)
  const nebIndex41 = readFileSync(join(root, 'vendor', 'dsh-memory-nebula', 'lib', 'index.js'), 'utf8')
  const contractSrc41 = readFileSync(join(root, 'lib', 'macro', 'contract.js'), 'utf8')
  const fusion41 = readFileSync(join(root, 'tools', 'probe-fusion.mjs'), 'utf8')
  const Z_EMPTY41 = 'nebula_bridge：这次没补到东西。\n  星图里还没有节点（图是空的），这次 nebula_bridge 等于没算。'
  const Z_NOSEED41 = 'nebula_bridge：这次没补到东西。\n  你给的 2 个 id 一条都没在图里找到种子。'
  const Z_FILTER41 = 'nebula_bridge：这次没补到东西。\n  有 3 条种子，但邻居都被过滤掉了。'
  const Z_OK41 = 'nebula_bridge：从 3 条种子扩散，候选 12 条，选出 4 条（820 字）'

  check(
    'bridge: 两个常量按值起名',
    contractSrc41.includes("export const BRIDGE_EMPTY_MARK = '这次没补到东西'") &&
      contractSrc41.includes("export const BRIDGE_NOT_EMPTY_MEMORY_MARK = '这不是「图里没有相关记忆」'"),
    'BRIDGE_EMPTY_MARK / BRIDGE_NOT_EMPTY_MEMORY_MARK',
  )
  check(
    'bridge: 三种空各归空，补到东西时才是 ok',
    contract41.bridgeAnswerKind(Z_EMPTY41) === 'empty' &&
      contract41.bridgeAnswerKind(Z_NOSEED41) === 'empty' &&
      contract41.bridgeAnswerKind(Z_FILTER41) === 'empty' &&
      contract41.bridgeAnswerKind(Z_OK41) === 'ok' &&
      contract41.bridgeAnswerKind('') === 'ok',
    [Z_EMPTY41, Z_NOSEED41, Z_FILTER41, Z_OK41].map((t) => contract41.bridgeAnswerKind(t)).join(','),
  )
  check(
    'bridge: 空图那句仍算「没算」（bridge 模式的本地兜底靠它）',
    contract41.recallAnswerKind(Z_EMPTY41) === 'emptyGraph',
    contract41.recallAnswerKind(Z_EMPTY41),
  )
  check(
    'bridge: vendor 四种原因都在，旧文案一个字都不留',
    nebIndex41.includes('一条都没在图里找到种子') &&
      nebIndex41.includes('邻居都被过滤掉了') &&
      nebIndex41.includes('没有一条进得了预算') &&
      nebIndex41.includes('星图里还没有节点（图是空的）') &&
      !nebIndex41.includes('没有可补充的邻居'),
    'vendor/index.js 的 nebula_bridge',
  )
  check(
    'bridge: 补丁有标记，守卫读的是 seedCount',
    /\[macro-fusion 0\.2\.44\][\s\S]{0,1400}?stats\?\.seedCount \?\? 0/.test(nebIndex41) &&
      !/\[macro-fusion 0\.2\.44\][\s\S]{0,1400}?if \(false\)/.test(nebIndex41),
    '补丁在不在',
  )
  check(
    'bridge: 措辞表有这一条，判据清单里有 vendor-bridge',
    criteria41.CONTRACT_MARKS.BRIDGE_EMPTY_MARK === contract41.BRIDGE_EMPTY_MARK &&
      criteria41
        .contractChecklist({ contractSrc: contractSrc41, nebIndexSrc: nebIndex41 })
        .some((c) => c.id === 'vendor-bridge' && c.ok),
    String(Object.keys(criteria41.CONTRACT_MARKS).length) + ' 个常量',
  )
  check(
    'bridge: 探针钉住了三种空与兜底（Z1–Z3）',
    fusion41.includes('Z1 空图/没种子/被过滤都归成「没补到」') &&
      fusion41.includes('Z2 空图那句仍被 recallAnswerKind 认成「没算」') &&
      fusion41.includes('Z3 空图时 bridge 模式退本地检索'),
    'probe-fusion',
  )
  const v41 = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version.split('.').map(Number)
  check('bridge: 版本不早于 0.2.44', v41[0] === 0 && v41[1] === 2 && v41[2] >= 44, v41.join('.'))
  check(
    'bridge: README 与 DESIGN 记了这一轮',
    readFileSync(join(root, 'docs', 'INTERNAL.md'), 'utf8').includes('0.2.44') &&
      readFileSync(join(root, 'DESIGN.md'), 'utf8').includes('0.2.44') &&
      readFileSync(join(root, 'DESIGN.md'), 'utf8').includes('没找到 ≠ 读过'),
    '文档',
  )
}

// A42（0.2.45）：`nebula_path` 把「图空着 / 节点没入图 / 引擎旧」和「确实没关系」
// 压成同一句，而且句尾还硬邦邦地加一句「没有关系就不编关系」——那是**结论**，
// 让模型停止追问。四支分开之后，结论只许出现在真算过的那一句里。
{
  const contract42 = await import(pathToFileURL(join(root, 'lib/macro/contract.js')).href)
  const criteria42 = await import(pathToFileURL(join(root, 'tools/criteria.mjs')).href)
  const nebIndex42 = readFileSync(join(root, 'vendor', 'dsh-memory-nebula', 'lib', 'index.js'), 'utf8')
  const contractSrc42 = readFileSync(join(root, 'lib', 'macro', 'contract.js'), 'utf8')
  const linkSrc42 = readFileSync(join(root, 'lib', 'macro', 'defs', 'link.js'), 'utf8')
  const fusion42 = readFileSync(join(root, 'tools', 'probe-fusion.mjs'), 'utf8')
  const P_EMPTY42 = '星图里还没有节点（图是空的），这次 nebula_path 等于没算——这不是「这两条记忆没有关系」。'
  const P_MISSING42 = '这次没算成：找不到这两个节点：a / b（图里现在有 3 条节点）。'
  const P_STALE42 = '这次没算成：这个引擎版本还没带上路径搜索（等宿主重启后生效）。'
  const P_UNRELATED42 = '这两条记忆在星图里确实没有连上：6 跳以内一条可走的边都没有。没有关系就不编关系。'

  check(
    'path: 空图那支有名字（常量按值）',
    contractSrc42.includes("export const PATH_EMPTY_GRAPH_MARK = '这次 nebula_path 等于没算'") &&
      criteria42.CONTRACT_MARKS.PATH_EMPTY_GRAPH_MARK === contract42.PATH_EMPTY_GRAPH_MARK,
    'PATH_EMPTY_GRAPH_MARK',
  )
  check(
    'path: 四句各归各的，图空着先于「节点没入图」',
    contract42.pathAnswerKind(P_EMPTY42) === 'emptyGraph' &&
      contract42.pathAnswerKind(P_MISSING42) === 'missing' &&
      contract42.pathAnswerKind(P_STALE42) === 'engineStale' &&
      contract42.pathAnswerKind(P_UNRELATED42) === 'unrelated',
    [P_EMPTY42, P_MISSING42, P_STALE42, P_UNRELATED42].map((t) => contract42.pathAnswerKind(t)).join(','),
  )
  check(
    'path: 结论只出现在真算过的那一句',
    [P_EMPTY42, P_MISSING42, P_STALE42].every((t) => !t.includes('没有关系就不编关系')) &&
      P_UNRELATED42.includes('没有关系就不编关系'),
    '三句没结论 / 一句有结论',
  )
  check(
    'path: vendor 四支都在，旧的拼接模板一个字都不留',
    nebIndex42.includes('这次 nebula_path 等于没算') &&
      nebIndex42.includes('确实没有连上') &&
      nebIndex42.includes('还没带上路径搜索') &&
      !/没有连上（\$\{r\?\.error/.test(nebIndex42),
    'vendor/index.js 的 nebula_path',
  )
  check(
    'path: 补丁有标记，凭据是节点数',
    /\[macro-fusion 0\.2\.45\][\s\S]{0,1600}?nodes\?\.length \?\? 0/.test(nebIndex42) &&
      !/\[macro-fusion 0\.2\.45\][\s\S]{0,1600}?if \(false\)/.test(nebIndex42),
    '补丁在不在',
  )
  check(
    'path: 图空那支在 link.js 里显式放行（不像 missing 那样再翻译一遍）',
    /kind === 'emptyGraph'[\s\S]{0,120}?return r2\.text/.test(linkSrc42),
    'defs/link.js',
  )
  check(
    'path: 判据清单里有 vendor-path',
    criteria42
      .contractChecklist({
        contractSrc: contractSrc42,
        nebIndexSrc: nebIndex42,
      })
      .some((c) => c.id === 'vendor-path' && c.ok),
    String(Object.keys(criteria42.CONTRACT_MARKS).length) + ' 个常量',
  )
  check(
    'path: 探针钉住新文案的两种翻译（T6–T7）',
    fusion42.includes('T6 新文案四句各归各的') && fusion42.includes('T7 新「没算成」文案仍被翻成「还没建到这两条记忆」'),
    'probe-fusion',
  )
  const v42 = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version.split('.').map(Number)
  check('path: 版本不早于 0.2.45', v42[0] === 0 && v42[1] === 2 && v42[2] >= 45, v42.join('.'))
  check(
    'path: README 与 DESIGN 记了这一轮',
    readFileSync(join(root, 'docs', 'INTERNAL.md'), 'utf8').includes('0.2.45') &&
      readFileSync(join(root, 'DESIGN.md'), 'utf8').includes('0.2.45') &&
      readFileSync(join(root, 'DESIGN.md'), 'utf8').includes('停止追问'),
    '文档',
  )
}

// A43（0.2.46）：`memory_find_similar` 一条都没有的时候，render 返回空数组，
// 融合层只剩 `{"hits": []}`——一次**没算成**的检索读起来像「记忆里确实没有相似的东西」。
// 四种原因里三种是「没算」，只有词汇零重叠那一句才是结论。
{
  const contract43 = await import(pathToFileURL(join(root, 'lib/macro/contract.js')).href)
  const criteria43 = await import(pathToFileURL(join(root, 'tools/criteria.mjs')).href)
  const contractSrc43 = readFileSync(join(root, 'lib/macro', 'contract.js'), 'utf8')
  const meowIndex43 = readFileSync(join(root, 'vendor', 'meow-memory', 'lib', 'index.js'), 'utf8')
  const searchSrc43 = readFileSync(join(root, 'lib/macro/defs', 'search.js'), 'utf8')
  const fusion43 = readFileSync(join(root, 'tools', 'probe-fusion.mjs'), 'utf8')
  const S_NO_TARGET43 = '相似检索没算成：这条记忆没有可用于比较的词（内容全是符号/数字/停用词）。这不是「记忆里没有相似的东西」。'
  const S_FEW43 = '相似检索没算成：库里就只有这一条可比的记忆。这不是「记忆里没有相似的东西」。'
  const S_FILTER43 = '相似检索没算成：可比的候选一条都没有（库里 12 条）。这不是「记忆里没有相似的东西」。'
  const S_NONE43 = '这次真算过了：5 条候选里没有一条和它有共同词汇（相似度全是 0）。这才是「记忆里没有相似的东西」。'
  const S_HIT43 = '[lesson 0mwm1] 相似度 0.412 有共同词汇的条目'

  check(
    'similar: 两个常量按值起名，且只有一个结论句',
    contractSrc43.includes("export const SIMILAR_NOT_COMPUTED_MARK = '相似检索没算成'") &&
      contractSrc43.includes("export const SIMILAR_NONE_MARK = '这才是「记忆里没有相似的东西」'") &&
      criteria43.CONTRACT_MARKS.SIMILAR_NOT_COMPUTED_MARK === contract43.SIMILAR_NOT_COMPUTED_MARK &&
      criteria43.CONTRACT_MARKS.SIMILAR_NONE_MARK === contract43.SIMILAR_NONE_MARK,
    'SIMILAR_NOT_COMPUTED_MARK / SIMILAR_NONE_MARK',
  )
  check(
    'similar: 三种「没算成」都归 notComputed，真算过那句才是 none',
    [S_NO_TARGET43, S_FEW43, S_FILTER43].every((t) => contract43.similarAnswerKind(t) === 'notComputed') &&
      contract43.similarAnswerKind(S_NONE43) === 'none' &&
      contract43.similarAnswerKind(S_HIT43) === 'ok',
    [S_NO_TARGET43, S_FEW43, S_FILTER43, S_NONE43, S_HIT43].map((t) => contract43.similarAnswerKind(t)).join(','),
  )
  check(
    'similar: 结论句只出现在真算过的那一支',
    [S_NO_TARGET43, S_FEW43, S_FILTER43].every((t) => !t.includes('这才是「记忆里没有相似的东西」')),
    '三句没结论',
  )
  check(
    'similar: vendor 四种原因齐全，note 进了 schema、render 会说话',
    meowIndex43.includes('相似检索没算成') &&
      meowIndex43.includes('这才是「记忆里没有相似的东西」') &&
      /note: \{ type: "string" \}/.test(meowIndex43) &&
      /text: String\(v\.note \|\|/.test(meowIndex43) &&
      /hits\.length === 0\) \{\n\s+return \[\{/.test(meowIndex43),
    'vendor/meow-memory/lib/index.js',
  )
  check(
    'similar: 补丁有标记，凭据是可检索条数与候选数',
    /\[macro-fusion 0\.2\.46\][\s\S]{0,2200}?candidates\.length === 0/.test(meowIndex43) &&
      /\[macro-fusion 0\.2\.46\][\s\S]{0,2200}?rows\.length <= 1/.test(meowIndex43) &&
      !/\[macro-fusion 0\.2\.46\][\s\S]{0,2200}?if \(false\)/.test(meowIndex43),
    '补丁在不在',
  )
  check(
    'similar: 融合层自己也有兜底（子插件一个字都不给时）',
    /相似检索这次没给出任何内容/.test(searchSrc43) && searchSrc43.includes('"hits"'),
    'lib/macro/defs/search.js',
  )
  check(
    'similar: 判据清单里有 vendor-similar',
    criteria43
      .contractChecklist({
        contractSrc: contractSrc43,
        meowIndexSrc: meowIndex43,
      })
      .some((c) => c.id === 'vendor-similar' && c.ok),
    String(Object.keys(criteria43.CONTRACT_MARKS).length) + ' 个常量',
  )
  check(
    'similar: 探针钉住三种归类与兜底（AC1–AC3）',
    fusion43.includes('AC1 三种「没算成」都归 notComputed') &&
      fusion43.includes('AC2 空结果不再沉默') &&
      fusion43.includes('AC3 子插件一个字都不给时'),
    'probe-fusion',
  )
  const v43 = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version.split('.').map(Number)
  check('similar: 版本不早于 0.2.46', v43[0] === 0 && v43[1] === 2 && v43[2] >= 46, v43.join('.'))
  check(
    'similar: README 与 DESIGN 记了这一轮',
    readFileSync(join(root, 'docs', 'INTERNAL.md'), 'utf8').includes('0.2.46') &&
      readFileSync(join(root, 'DESIGN.md'), 'utf8').includes('0.2.46') &&
      readFileSync(join(root, 'DESIGN.md'), 'utf8').includes('一个字都不给'),
    '文档',
  )
}

// A44（0.2.47）：`memory_project` 的空全景原来只有「该项目暂无记忆条目」一句。
// 名字拼错 / project 层空但 fact·lesson·topic 有东西 / 真的没有，三种共用一句，
// 前两种都被读成「这个项目没记忆」——要么漏掉一堆，要么新建一个重复项目。
{
  const contract44 = await import(pathToFileURL(join(root, 'lib/macro/contract.js')).href)
  const criteria44 = await import(pathToFileURL(join(root, 'tools/criteria.mjs')).href)
  const contractSrc44 = readFileSync(join(root, 'lib/macro', 'contract.js'), 'utf8')
  const meowIndex44 = readFileSync(join(root, 'vendor', 'meow-memory', 'lib', 'index.js'), 'utf8')
  const fusion44 = readFileSync(join(root, 'tools', 'probe-fusion.mjs'), 'utf8')
  const P_TYPO44 = '【项目：dsh-macor-memory】这个名字在库里一条都对不上——七层表里没有任何一条记忆的 project 字段写着它。\n库里现有的项目名：dsh-macro-memory / meow-memory。\n这不是「这个项目没有记忆」，是名字没对上。'
  const P_HALF44 = '【项目：X】该项目暂无记忆条目。\n上面这句只说了一半：overview/structure/decisions/quotes/ops/todo 六类与项目准则都没有 active 条目，但这个项目在别的层还有 3 条记忆（fact 2 / lesson 1）。\n这不是「这个项目没有记忆」——用 memory_search(project="X", query=…) 能把它们捞出来。'
  const P_EMPTY44 = '【项目：X】该项目暂无记忆条目。\n查过七层表：project 字段正好写着这个名字的 active 条目是 0 条，这次是真没有（已归档/已完结的不算）。'
  const P_OK44 = '【项目：X】\n\n项目概述\n- fact 0mwmxj9o ...'

  check(
    'project: 三个常量按值起名，且与判据表一致',
    contractSrc44.includes("export const PROJECT_NAME_NOT_FOUND_MARK = '这个名字在库里一条都对不上'") &&
      contractSrc44.includes("export const PROJECT_OTHER_LAYERS_MARK = '在别的层还有'") &&
      contractSrc44.includes("export const PROJECT_TRULY_EMPTY_MARK = '这次是真没有'") &&
      criteria44.CONTRACT_MARKS.PROJECT_NAME_NOT_FOUND_MARK === contract44.PROJECT_NAME_NOT_FOUND_MARK &&
      criteria44.CONTRACT_MARKS.PROJECT_OTHER_LAYERS_MARK === contract44.PROJECT_OTHER_LAYERS_MARK &&
      criteria44.CONTRACT_MARKS.PROJECT_TRULY_EMPTY_MARK === contract44.PROJECT_TRULY_EMPTY_MARK,
    'PROJECT_NAME_NOT_FOUND_MARK / PROJECT_OTHER_LAYERS_MARK / PROJECT_TRULY_EMPTY_MARK',
  )
  check(
    'project: 四句各归各的（名字对不上 / 别的层还有 / 真没有 / 正常有内容）',
    contract44.projectAnswerKind(P_TYPO44) === 'nameNotFound' &&
      contract44.projectAnswerKind(P_HALF44) === 'otherLayers' &&
      contract44.projectAnswerKind(P_EMPTY44) === 'empty' &&
      contract44.projectAnswerKind(P_OK44) === 'ok',
    [P_TYPO44, P_HALF44, P_EMPTY44, P_OK44].map((t) => contract44.projectAnswerKind(t)).join(','),
  )
  check(
    'project: 「查无此名」那句不带结论，结论只留给真没有的那一支',
    !P_TYPO44.includes('这次是真没有') &&
      !P_HALF44.includes('这次是真没有') &&
      P_EMPTY44.includes('这次是真没有') &&
      !P_EMPTY44.includes('在别的层还有'),
    '三句互斥',
  )
  check(
    'project: vendor 三分支齐全，且分支前有 0.2.47 标记',
    /\[macro-fusion 0\.2\.47\][\s\S]{0,4000}?这个名字在库里一条都对不上/.test(meowIndex44) &&
      /\[macro-fusion 0\.2\.47\][\s\S]{0,4000}?在别的层还有 \$\{total\} 条记忆/.test(meowIndex44) &&
      /\[macro-fusion 0\.2\.47\][\s\S]{0,4000}?这次是真没有/.test(meowIndex44) &&
      !/\[macro-fusion 0\.2\.47\][\s\S]{0,4000}?if \(false\)/.test(meowIndex44),
    'vendor/meow-memory/lib/index.js',
  )
  check(
    'project: 凭据是「别的层的条数」和「库里现有的项目名」，不是凭空下结论',
    /\[macro-fusion 0\.2\.47\][\s\S]{0,4000}?listProjectNames\(\)/.test(meowIndex44) &&
      /\[macro-fusion 0\.2\.47\][\s\S]{0,4000}?db\.list\('fact', \{ status: 'active' \}\)/.test(meowIndex44) &&
      /\[macro-fusion 0\.2\.47\][\s\S]{0,4000}?counts\.reduce\(\(a, \[, n\]\) => a \+ n, 0\)/.test(meowIndex44),
    'listProjectNames + db.list + counts.reduce',
  )
  check(
    'project: 判据清单里有 vendor-project 且为绿',
    criteria44
      .contractChecklist({ contractSrc: contractSrc44, meowIndexSrc: meowIndex44 })
      .some((c) => c.id === 'vendor-project' && c.ok),
    String(Object.keys(criteria44.CONTRACT_MARKS).length) + ' 个常量',
  )
  check(
    'project: 探针钉住两种空法与归类（AD1–AD3）',
    fusion44.includes('AD1 对不上的项目名说「一条都对不上」') &&
      fusion44.includes('AD2 只有 fact 层有东西时') &&
      fusion44.includes('AD3 三种空各归各的'),
    'probe-fusion',
  )
  check(
    'project: 正常有内容的项目不被这句话污染（仍以项目头开始）',
    P_OK44.startsWith('【项目：X】') && !P_OK44.includes('这个名字在库里一条都对不上'),
    'ok',
  )
  const v44 = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version.split('.').map(Number)
  check('project: 版本不早于 0.2.47', v44[0] === 0 && v44[1] === 2 && v44[2] >= 47, v44.join('.'))
  check(
    'project: README 与 DESIGN 记了这一轮',
    readFileSync(join(root, 'docs', 'INTERNAL.md'), 'utf8').includes('0.2.47') &&
      readFileSync(join(root, 'DESIGN.md'), 'utf8').includes('0.2.47') &&
      readFileSync(join(root, 'DESIGN.md'), 'utf8').includes('查无此名'),
    '文档',
  )
}

// A45（0.2.48）：`startWindowDream()` 有四个 `return false`，调用方只看「有没有 lease」猜，
// 于是「消息没送进会话」被说成「本窗口没有需要整理的记忆」——一句结论把可重试的失败埋了。
{
  const contract45 = await import(pathToFileURL(join(root, 'lib/macro/contract.js')).href)
  const criteria45 = await import(pathToFileURL(join(root, 'tools/criteria.mjs')).href)
  const contractSrc45 = readFileSync(join(root, 'lib/macro', 'contract.js'), 'utf8')
  const meowIndex45 = readFileSync(join(root, 'vendor', 'meow-memory', 'lib', 'index.js'), 'utf8')
  const dreamSrc45 = readFileSync(join(root, 'lib/macro', 'defs', 'dream.js'), 'utf8')
  const fusion45 = readFileSync(join(root, 'tools', 'probe-fusion.mjs'), 'utf8')
  const D_NOTHING45 = '本窗口没有需要整理的记忆（盘点过：没有未封存的记忆轮次）——这一次是真没有，不是 dream 坏了。'
  const D_BUSY45 = '本窗口确实有记忆要整理，但已经有一个 dream 在跑（或上一轮还在待补收尾）——这次没启动，等它收尾后再触发就行。'
  const D_FAILED45 =
    '这次没启动成功：整理任务的消息没送进会话（会话正忙或被中断）。要整理的记忆还在，稍后再触发一次就行——这不是「没有需要整理的记忆」。'
  const D_NOID45 = '这次没启动成功：拿不到这个窗口的标识，所以没法开工（这不是「没有需要整理的记忆」）。'
  const D_OK45 = '🧠 dream 已触发：整理任务已在后台运行，会话流中的任务气泡会显示进度与完成状态。'
  const D_REPLY45 =
    'dream 未启动：这次没启动成功：整理任务的消息没送进会话（会话正忙或被中断）。要整理的记忆还在，稍后再触发一次就行——这不是「没有需要整理的记忆」。'

  check(
    'dream: 三个常量按值起名，且与判据表一致',
    contractSrc45.includes("export const DREAM_NOTHING_MARK = '没有需要整理的记忆（盘点过'") &&
      contractSrc45.includes("export const DREAM_BUSY_MARK = '已经有一个 dream 在跑'") &&
      contractSrc45.includes("export const DREAM_NOT_STARTED_MARK = '这次没启动成功'") &&
      criteria45.CONTRACT_MARKS.DREAM_NOTHING_MARK === contract45.DREAM_NOTHING_MARK &&
      criteria45.CONTRACT_MARKS.DREAM_BUSY_MARK === contract45.DREAM_BUSY_MARK &&
      criteria45.CONTRACT_MARKS.DREAM_NOT_STARTED_MARK === contract45.DREAM_NOT_STARTED_MARK,
    'DREAM_NOTHING_MARK / DREAM_BUSY_MARK / DREAM_NOT_STARTED_MARK',
  )
  check(
    'dream: 五种回执各归各的（没东西 / 已有在跑 / 没送出去 / 没标识 / 真启动了）',
    contract45.dreamAnswerKind(D_NOTHING45) === 'nothing' &&
      contract45.dreamAnswerKind(D_BUSY45) === 'busy' &&
      contract45.dreamAnswerKind(D_FAILED45) === 'notStarted' &&
      contract45.dreamAnswerKind(D_NOID45) === 'notStarted' &&
      contract45.dreamAnswerKind(D_OK45) === 'ok' &&
      contract45.dreamAnswerKind(D_REPLY45) === 'notStarted',
    [D_NOTHING45, D_BUSY45, D_FAILED45, D_NOID45, D_OK45, D_REPLY45]
      .map((t) => contract45.dreamAnswerKind(t))
      .join(','),
  )
  check(
    'dream: 只有「盘点过为空」那一支敢说没有记忆，其余三支都否认这句',
    D_NOTHING45.includes('没有需要整理的记忆（盘点过') &&
      !D_BUSY45.includes('没有需要整理的记忆（盘点过') &&
      !D_FAILED45.includes('没有需要整理的记忆（盘点过') &&
      !D_NOID45.includes('没有需要整理的记忆（盘点过') &&
      D_FAILED45.includes('这不是「没有需要整理的记忆」') &&
      D_NOID45.includes('这不是「没有需要整理的记忆」'),
    '三句互斥',
  )
  check(
    'dream: vendor 四个 false 各自带因由（trace 收集器），不是只回布尔',
    /\[macro-fusion 0\.2\.48\][\s\S]{0,6000}?return say\("noSessionId"\)/.test(meowIndex45) &&
      /\[macro-fusion 0\.2\.48\][\s\S]{0,6000}?return say\("noRounds"\)/.test(meowIndex45) &&
      /\[macro-fusion 0\.2\.48\][\s\S]{0,6000}?return say\("claimed"\)/.test(meowIndex45) &&
      /\[macro-fusion 0\.2\.48\][\s\S]{0,6000}?return say\("sendFailed"\)/.test(meowIndex45) &&
      /trace\.reason = "started"/.test(meowIndex45),
    'noSessionId / noRounds / claimed / sendFailed',
  )
  check(
    'dream: 工具面与 /dream 命令面都按 trace 分支（同一句两种说法不许并存）',
    /trace48\.reason === "noRounds"/.test(meowIndex45) &&
      /trace48\.reason === "claimed"/.test(meowIndex45) &&
      /trace48\.reason === "sendFailed"/.test(meowIndex45) &&
      /traceCmd48\.reason === "claimed"/.test(meowIndex45) &&
      /traceCmd48\.reason === "sendFailed"/.test(meowIndex45) &&
      !/const lease = getDb\(workspace, dir\)\.getDreamLease/.test(meowIndex45),
    'trace48 / traceCmd48',
  )
  check(
    'dream: 融合层不被空回执沉默（defs/dream.js 自己说话）',
    /\[macro-fusion 0\.2\.48\][\s\S]{0,600}?said\.length === 0/.test(dreamSrc45) &&
      dreamSrc45.includes('没有任何回执') &&
      !dreamSrc45.includes('没有需要整理的记忆（盘点过'),
    'lib/macro/defs/dream.js',
  )
  check(
    'dream: 判据清单里有 vendor-dream 且为绿',
    criteria45
      .contractChecklist({ contractSrc: contractSrc45, meowIndexSrc: meowIndex45 })
      .some((c) => c.id === 'vendor-dream' && c.ok),
    String(Object.keys(criteria45.CONTRACT_MARKS).length) + ' 个常量',
  )
  check(
    'dream: 探针钉住四种原因与兜底（AE1–AE3）',
    fusion45.includes('AE1 四种没启动各归各的') &&
      fusion45.includes('AE2 送不出去时不许说成「没有需要整理的记忆」') &&
      fusion45.includes('AE3 子插件一个字都不给时，融合层自己说「没有回执」'),
    'probe-fusion',
  )
  const v45 = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version.split('.').map(Number)
  check('dream: 版本不早于 0.2.48', v45[0] === 0 && v45[1] === 2 && v45[2] >= 48, v45.join('.'))
  check(
    'dream: README 与 DESIGN 记了这一轮',
    readFileSync(join(root, 'docs', 'INTERNAL.md'), 'utf8').includes('0.2.48') &&
      readFileSync(join(root, 'DESIGN.md'), 'utf8').includes('0.2.48') &&
      readFileSync(join(root, 'DESIGN.md'), 'utf8').includes('没启动'),
    '文档',
  )
}

// A46（0.2.49）：`memory_update` 只回一个 `ok`。过滤是必要的，但被过滤掉的字段一声不响，
// patch 空了 `ok` 仍是 true——于是「一个字段都没写进去」被说成「✅ 已更新」。
{
  const contract46 = await import(pathToFileURL(join(root, 'lib/macro/contract.js')).href)
  const criteria46 = await import(pathToFileURL(join(root, 'tools/criteria.mjs')).href)
  const contractSrc46 = readFileSync(join(root, 'lib/macro', 'contract.js'), 'utf8')
  const meowIndex46 = readFileSync(join(root, 'vendor', 'meow-memory', 'lib', 'index.js'), 'utf8')
  const updateSrc46 = readFileSync(join(root, 'lib/macro', 'defs', 'update.js'), 'utf8')
  const fusion46 = readFileSync(join(root, 'tools', 'probe-fusion.mjs'), 'utf8')
  const U_NOTHING46 =
    '这次什么都没改：一个能写进库的字段都没有。（只给了 id，别的字段一个都没带。）要改就带上 fact 层支持的字段再调一次——这不是「已经更新好了」。'
  const U_PARTIAL46 =
    '✅ 已更新（fact 0mwmy2qi）：content。但这几个字段没生效：goal（只有 topic 层有目标句，这条是 fact）——这是「部分生效」，不是全部。'
  const U_NOTFOUND46 =
    '更新失败：没有这个 id（七层表里都找不到）。短 id 给前 8 位就够，但要能唯一命中；请先用 memory_search / memory_read 确认 id。'
  const U_OK46 = '✅ 已更新（fact 0mwmy2qi）：importance。'

  check(
    'update: 三个常量按值起名，且与判据表一致',
    contractSrc46.includes("export const UPDATE_NOTHING_MARK = '这次什么都没改'") &&
      contractSrc46.includes("export const UPDATE_PARTIAL_MARK = '这是「部分生效」，不是全部'") &&
      contractSrc46.includes("export const UPDATE_NOT_FOUND_MARK = '没有这个 id'") &&
      criteria46.CONTRACT_MARKS.UPDATE_NOTHING_MARK === contract46.UPDATE_NOTHING_MARK &&
      criteria46.CONTRACT_MARKS.UPDATE_PARTIAL_MARK === contract46.UPDATE_PARTIAL_MARK &&
      criteria46.CONTRACT_MARKS.UPDATE_NOT_FOUND_MARK === contract46.UPDATE_NOT_FOUND_MARK,
    'UPDATE_NOTHING_MARK / UPDATE_PARTIAL_MARK / UPDATE_NOT_FOUND_MARK',
  )
  check(
    'update: 四种回执各归各的（什么都没改 / 部分生效 / 查无此 id / 真改成了）',
    contract46.updateAnswerKind(U_NOTHING46) === 'nothing' &&
      contract46.updateAnswerKind(U_PARTIAL46) === 'partial' &&
      contract46.updateAnswerKind(U_NOTFOUND46) === 'notFound' &&
      contract46.updateAnswerKind(U_OK46) === 'ok',
    [U_NOTHING46, U_PARTIAL46, U_NOTFOUND46, U_OK46].map((t) => contract46.updateAnswerKind(t)).join(','),
  )
  check(
    'update: 「部分生效」带 ✅ 开头，只能靠后半句与「全部生效」分开（顺序错了就分不开）',
    contract46.updateAnswerKind(U_PARTIAL46) === 'partial' &&
      contract46.updateAnswerKind('✅ 已更新（fact 0mwmy2qi）：importance。') === 'ok' &&
      U_PARTIAL46.includes('✅ 已更新'),
    'partial 前的判断顺序',
  )
  check(
    'update: 什么都没改时自己否认「已经更新好了」，查无此 id 时不否认（各说各的）',
    U_NOTHING46.includes('这不是「已经更新好了」') &&
      !U_NOTFOUND46.includes('这不是「已经更新好了」') &&
      !U_NOTFOUND46.includes('这次什么都没改'),
    '两句互斥',
  )
  check(
    'update: vendor 不再用「patch 为空也算成功」那一行（旧谎的凭据）',
    !/const ok = Object\.keys\(patch\)\.length > 0 \? db\.update/.test(meowIndex46) &&
      /const changed = Object\.keys\(patch\)/.test(meowIndex46) &&
      /const dropped = \[\]/.test(meowIndex46) &&
      /if \(changed\.length === 0\) \{/.test(meowIndex46),
    'changed / dropped',
  )
  check(
    'update: 被过滤的字段逐个点名（content 空串 / status 越界 / importance 非数 / goal 层不对 / project 层不对 / keywords 空）',
    /dropped\.push\("content（给的是空串/.test(meowIndex46) &&
      /dropped\.push\(`status（\$\{String\(parsed\.status\)\} 不在 active\/stale\/archived 里）`\)/.test(meowIndex46) &&
      /dropped\.push\(`importance（/.test(meowIndex46) &&
      /dropped\.push\(`goal（只有 topic 层有目标句/.test(meowIndex46) &&
      /dropped\.push\(`project（/.test(meowIndex46) &&
      /dropped\.push\("keywords（归一后是空列表/.test(meowIndex46),
    '六种过滤原因',
  )
  check(
    'update: 找到了但没写进库时说「没写进库」，不冒充找不到、也不冒充已更新',
    meowIndex46.includes('找到了这条记忆，但没写进库') &&
      /ok = db\.update\(found\.level, found\.row\.id, patch\) === true/.test(meowIndex46),
    'db.update === true',
  )
  check(
    'update: 融合层不被空回执沉默（defs/update.js 自己说话）',
    /\[macro-fusion 0\.2\.49\][\s\S]{0,600}?said\.length === 0/.test(updateSrc46) &&
      updateSrc46.includes('没有任何回执') &&
      updateSrc46.includes('这不是「已经更新好了」'),
    'lib/macro/defs/update.js',
  )
  check(
    'update: 判据清单里有 vendor-update 且为绿',
    criteria46
      .contractChecklist({ contractSrc: contractSrc46, meowIndexSrc: meowIndex46 })
      .some((c) => c.id === 'vendor-update' && c.ok),
    String(Object.keys(criteria46.CONTRACT_MARKS).length) + ' 个常量',
  )
  check(
    'update: 探针钉住四种回执与兜底（AF1–AF5）',
    fusion46.includes('AF1 四种回执各归各的') &&
      fusion46.includes('AF2 只给 id 不带任何字段时') &&
      fusion46.includes('AF3 字段被过滤时点名是哪个字段') &&
      fusion46.includes('AF4 查无此 id 时说「没有这个 id」') &&
      fusion46.includes('AF5 子插件一个字都不给时'),
    'probe-fusion',
  )
  const v46 = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version.split('.').map(Number)
  check('update: 版本不早于 0.2.49', v46[0] === 0 && v46[1] === 2 && v46[2] >= 49, v46.join('.'))
  check(
    'update: README 与 DESIGN 记了这一轮',
    readFileSync(join(root, 'docs', 'INTERNAL.md'), 'utf8').includes('0.2.49') &&
      readFileSync(join(root, 'DESIGN.md'), 'utf8').includes('0.2.49') &&
      readFileSync(join(root, 'DESIGN.md'), 'utf8').includes('静默'),
    '文档',
  )
}

// A47（0.2.50）：`memory_remember` 的七个参数里有六个会被悄悄纠正——层名写错直接落进 fact、
// subcategory/goal/corrected 给错层就丢、importance 小数被四舍五入、内容像旧条目就并进去。
// 五种情况原来共用一句「✅ 记忆已写入」，读起来像「按你说的写好了」。
{
  const contract47 = await import(pathToFileURL(join(root, 'lib/macro/contract.js')).href)
  const criteria47 = await import(pathToFileURL(join(root, 'tools/criteria.mjs')).href)
  const contractSrc47 = readFileSync(join(root, 'lib/macro', 'contract.js'), 'utf8')
  const meowIndex47 = readFileSync(join(root, 'vendor', 'meow-memory', 'lib', 'index.js'), 'utf8')
  const rememberSrc47 = readFileSync(join(root, 'lib/macro', 'defs', 'remember.js'), 'utf8')
  const fusion47 = readFileSync(join(root, 'tools', 'probe-fusion.mjs'), 'utf8')
  const R_LEVEL47 =
    '✅ 记忆已写入（fact，id=abcd1234）。\n写成 fact 了：你给的层名「lessons」不在七层里（soul / user / project / fact / lesson / topic / rules），这条记忆被记进了 fact——这不是「按你说的层写好了」。'
  const R_DROPPED47 = '✅ 记忆已写入（fact，id=abcd1234）。\n这几个参数没生效：goal（只有 topic 层有目标句，这条是 fact）。'
  const R_MERGED47 =
    '✅ 已合并到已有条目（fact，id=abcd1234）。\n这条并进了已有条目 abcd1234（与它的内容重复度 ≥80%）。这是「合并」，不是「新写一条」。'
  const R_OK47 = '✅ 记忆已写入（fact，id=abcd1234）。项目：AG探针项目0250。无需重复调用本工具。'

  check(
    'remember: 三个常量按值起名，且与判据表一致',
    contractSrc47.includes("export const REMEMBER_LEVEL_FALLBACK_MARK = '这不是「按你说的层写好了」'") &&
      contractSrc47.includes("export const REMEMBER_DROPPED_MARK = '这几个参数没生效'") &&
      contractSrc47.includes("export const REMEMBER_MERGED_MARK = '这是「合并」，不是「新写一条」'") &&
      criteria47.CONTRACT_MARKS.REMEMBER_LEVEL_FALLBACK_MARK === contract47.REMEMBER_LEVEL_FALLBACK_MARK &&
      criteria47.CONTRACT_MARKS.REMEMBER_DROPPED_MARK === contract47.REMEMBER_DROPPED_MARK &&
      criteria47.CONTRACT_MARKS.REMEMBER_MERGED_MARK === contract47.REMEMBER_MERGED_MARK,
    'REMEMBER_LEVEL_FALLBACK_MARK / REMEMBER_DROPPED_MARK / REMEMBER_MERGED_MARK',
  )
  check(
    'remember: 四种回执各归各的（层名被改过 / 参数没生效 / 合进旧条目 / 真按原样写入）',
    contract47.rememberAnswerKind(R_LEVEL47) === 'levelFallback' &&
      contract47.rememberAnswerKind(R_DROPPED47) === 'dropped' &&
      contract47.rememberAnswerKind(R_MERGED47) === 'merged' &&
      contract47.rememberAnswerKind(R_OK47) === 'ok',
    [R_LEVEL47, R_DROPPED47, R_MERGED47, R_OK47].map((t) => contract47.rememberAnswerKind(t)).join(','),
  )
  check(
    'remember: 层名被改过的那句自己否认「按你说的层写好了」（否则读者以为目标层多了一条）',
    R_LEVEL47.includes('这不是「按你说的层写好了」') &&
      contract47.rememberAnswerKind(R_LEVEL47) === 'levelFallback' &&
      !R_OK47.includes('按你说的层写好了'),
    '否认 + 干净写入不否认',
  )
  check(
    'remember: 「合并」与「新写一条」分得开（前者的句头是 ✅ 已合并，后者是 ✅ 记忆已写入）',
    contract47.rememberAnswerKind(R_MERGED47) === 'merged' &&
      contract47.rememberAnswerKind(R_OK47) === 'ok' &&
      R_MERGED47.includes('这是「合并」，不是「新写一条」'),
    'merged 与 ok 的分界',
  )
  check(
    'remember: vendor 里层名不再静默落进 fact（levelBad 真的在判，不是 if (false)）',
    /const levelBad = levelAsked\.length > 0 && !LEVELS\.includes\(levelAsked\)/.test(meowIndex47) &&
      /const level = LEVELS\.includes\(levelAsked\) \? levelAsked : "fact"/.test(meowIndex47) &&
      /被记进了 \$\{level\}/.test(meowIndex47),
    'levelBad / levelAsked',
  )
  check(
    'remember: 四个参数被丢掉时逐个点名（subcategory / goal / corrected / importance 小数）',
    /dropped\.push\(`subcategory（只有 project 层有子类/.test(meowIndex47) &&
      /dropped\.push\(`subcategory（「\$\{subcategoryAsked\}」不在六类里/.test(meowIndex47) &&
      /dropped\.push\(`goal（只有 topic 层有目标句/.test(meowIndex47) &&
      /dropped\.push\(`corrected（只有 lesson 层记「被纠正」/.test(meowIndex47) &&
      /dropped\.push\(`importance（\$\{describeArg\(parsed\.importance\)\} 不是整数/.test(meowIndex47),
    '五种过滤原因',
  )
  check(
    'remember: 合并时明说并进了哪一条、这是「合并」不是「新写一条」',
    meowIndex47.includes('这条并进了已有条目') &&
      meowIndex47.includes('这是「合并」，不是「新写一条」'),
    'merge 分支',
  )
  check(
    'remember: 干净写入的句子一个字不变（没警告时仍是一行「✅ 记忆已写入…无需重复调用本工具。」）',
    /if \(note\.length === 0\) \{\n\s+return \[\{ type: "text", text: `\$\{base\}\$\{proj\}\$\{kw\}无需重复调用本工具。` \}\]/.test(
      meowIndex47,
    ),
    'render 的干净支',
  )
  check(
    'remember: 融合层不被空回执沉默（defs/remember.js 自己说话）',
    /\[macro-fusion 0\.2\.50\][\s\S]{0,600}?said\.length === 0/.test(rememberSrc47) &&
      rememberSrc47.includes('没有任何回执') &&
      rememberSrc47.includes('这不是「已经记住了」'),
    'lib/macro/defs/remember.js',
  )
  check(
    'remember: 判据清单里有 vendor-remember 且为绿',
    criteria47
      .contractChecklist({ contractSrc: contractSrc47, meowIndexSrc: meowIndex47 })
      .some((c) => c.id === 'vendor-remember' && c.ok),
    String(Object.keys(criteria47.CONTRACT_MARKS).length) + ' 个常量',
  )
  check(
    'remember: 探针钉住四种回执与兜底（AG1–AG5）',
    fusion47.includes('AG1 四种回执各归各的') &&
      fusion47.includes('AG2 层名写错时回执点名') &&
      fusion47.includes('AG3 给错层的 goal / corrected 逐条点名') &&
      fusion47.includes('AG4 同样的话再写一遍时明说「合并」') &&
      fusion47.includes('AG5 子插件一个字都不给时'),
    'probe-fusion',
  )
  const v47 = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version.split('.').map(Number)
  check('remember: 版本不早于 0.2.50', v47[0] === 0 && v47[1] === 2 && v47[2] >= 50, v47.join('.'))
  check(
    'remember: README 与 DESIGN 记了这一轮',
    readFileSync(join(root, 'docs', 'INTERNAL.md'), 'utf8').includes('0.2.50') &&
      readFileSync(join(root, 'DESIGN.md'), 'utf8').includes('0.2.50') &&
      readFileSync(join(root, 'DESIGN.md'), 'utf8').includes('错层'),
    '文档',
  )
}

// A48（0.2.51）：`memory_search` 的 `level` 过滤写错层名时把数组过滤成空 → 零命中，
// 回执只剩「以最新的为准」，读者会把它读成「记忆里没有」。
{
  const contract48 = await import(pathToFileURL(join(root, 'lib/macro/contract.js')).href)
  const criteria48 = await import(pathToFileURL(join(root, 'tools/criteria.mjs')).href)
  const contractSrc48 = readFileSync(join(root, 'lib/macro', 'contract.js'), 'utf8')
  const meowIndex48 = readFileSync(join(root, 'vendor', 'meow-memory', 'lib', 'index.js'), 'utf8')
  const searchSrc48 = readFileSync(join(root, 'lib/macro', 'defs', 'search.js'), 'utf8')
  const fusion48 = readFileSync(join(root, 'tools', 'probe-fusion.mjs'), 'utf8')
  const BASE48 = '如果冲突，以最新的为准。'
  const R_NONE48 = `${BASE48}\n这次一条都没查：你给的层名「lessons」不在七层里（soul / user / project / fact / lesson / topic / rules）。这不是「记忆里没有」，是层名没对上——换成真实层名再查一次。`
  const R_PART48 = `${BASE48}\n这几个层名没生效：lessons（不在七层里）——这次只查了 fact 层。`
  const R_SCOPE48 = `${BASE48}\n这次只在 fact 层里查了，零命中：别的层就算有同关键词也看不到。`
  const R_NOREPLY48 = '检索这次没有任何回执（既没有条目，也没说为什么没有）——这不是「记忆里没有这条」。'
  const R_OK48 = `${BASE48}\n[fact] [0mwmz5l2] [刚刚] 关于：探针 / 检索`

  check(
    'search: 四个常量按值起名，且与判据表一致',
    contractSrc48.includes("export const SEARCH_LEVEL_NONE_MARK = '这次一条都没查：你给的层名'") &&
      contractSrc48.includes("export const SEARCH_LEVEL_PARTIAL_MARK = '这几个层名没生效'") &&
      contractSrc48.includes("export const SEARCH_SCOPE_ONLY_MARK = '这次只在'") &&
      contractSrc48.includes("export const SEARCH_NO_REPLY_MARK = '检索这次没有任何回执'") &&
      criteria48.CONTRACT_MARKS.SEARCH_LEVEL_NONE_MARK === contract48.SEARCH_LEVEL_NONE_MARK &&
      criteria48.CONTRACT_MARKS.SEARCH_LEVEL_PARTIAL_MARK === contract48.SEARCH_LEVEL_PARTIAL_MARK &&
      criteria48.CONTRACT_MARKS.SEARCH_SCOPE_ONLY_MARK === contract48.SEARCH_SCOPE_ONLY_MARK &&
      criteria48.CONTRACT_MARKS.SEARCH_NO_REPLY_MARK === contract48.SEARCH_NO_REPLY_MARK,
    'SEARCH_LEVEL_NONE_MARK / SEARCH_LEVEL_PARTIAL_MARK / SEARCH_SCOPE_ONLY_MARK / SEARCH_NO_REPLY_MARK',
  )
  check(
    'search: 五种空结果各归各的（层名全错 / 部分失效 / 上游没回执 / 只在某几层查过 / 正常）',
    contract48.searchAnswerKind(R_NONE48) === 'levelNone' &&
      contract48.searchAnswerKind(R_PART48) === 'levelPartial' &&
      contract48.searchAnswerKind(R_NOREPLY48) === 'noReply' &&
      contract48.searchAnswerKind(R_SCOPE48) === 'scopeOnly' &&
      contract48.searchAnswerKind(R_OK48) === 'ok',
    [R_NONE48, R_PART48, R_NOREPLY48, R_SCOPE48, R_OK48].map((t) => contract48.searchAnswerKind(t)).join(','),
  )
  check(
    'search: 层名全错那句自己否认「记忆里没有」（否则会有人照着再写一条重复的）',
    R_NONE48.includes('这不是「记忆里没有」') &&
      contract48.searchAnswerKind(R_NONE48) === 'levelNone' &&
      !R_OK48.includes('记忆里没有'),
    '否认 + 正常结果不否认',
  )
  check(
    'search: 「部分层名失效」与「只在某几层里查过」分得开（前者说丢了哪几个，后者给出全层查的出路）',
    contract48.searchAnswerKind(R_PART48) === 'levelPartial' &&
      contract48.searchAnswerKind(R_SCOPE48) === 'scopeOnly' &&
      R_PART48.includes('不在七层里') &&
      R_SCOPE48.includes('零命中'),
    'levelPartial 与 scopeOnly 的分界',
  )
  check(
    'search: vendor 不再把层名过滤成空数组就完事（levelAsked / levelBad / levelValid 三个变量都在判）',
    /const levelAsked = typeof parsed\.level === "string"/.test(meowIndex48) &&
      /const levelBad = levelAsked\.filter\(\(s\) => !LEVELS\.includes\(s\)\)/.test(meowIndex48) &&
      /const levelValid = levelAsked\.filter\(\(s\) => LEVELS\.includes\(s\)\)/.test(meowIndex48) &&
      /const levels = levelValid\.length > 0 \? levelValid : levelAsked\.length === 0 \? \["fact", "lesson", "topic", "rules"\] : \[\]/.test(
        meowIndex48,
      ),
    'levelAsked / levelBad / levelValid',
  )
  check(
    'search: 两条新话真的拼进 note（而不是写了常量却没人用）',
    /\$\{levelAsked\.join\("、"\)\}」不在七层里/.test(meowIndex48) &&
      /\$\{levelBad\.join\("、"\)\}（不在七层里）/.test(meowIndex48) &&
      /const scopeNote = hits\.length === 0 && levelValid\.length > 0/.test(meowIndex48) &&
      /const note = \[plain, levelNote, scopeNote, statusNote, daysNote, kNote, cmNote(?:, \w+)*\]\.filter\(\(s\) => s\.length > 0\)\.join\("\\n"\)/.test(meowIndex48),
    'note 拼装',
  )
  // 老话在那行模板串里是 \uXXXX 转义的，断言前先还原（0.2.48 的教训：别把中文写成转义再去 includes）。
  const unesc48 = (s) => s.replace(/\\u([0-9A-Fa-f]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
  check(
    'search: 没给 level 的老话一个字不变（本次零命中：默认检索范围是 fact/lesson/topic/rules）',
    /hits\.length === 0 && !explicitLevels && !statusDead \? `\$\{BASE_NOTE\}/.test(meowIndex48) &&
      unesc48(meowIndex48).includes('本次零命中：默认检索范围是 fact/lesson/topic/rules'),
    '原有默认支',
  )
  check(
    'search: 融合层不被空回执沉默（defs/search.js 自己说话）',
    /\[macro-fusion 0\.2\.51\][\s\S]{0,600}?String\(main\.text \?\? ''\)\.trim\(\)\.length === 0/.test(searchSrc48) &&
      searchSrc48.includes('检索这次没有任何回执') &&
      searchSrc48.includes('这不是「记忆里没有这条」'),
    'lib/macro/defs/search.js',
  )
  check(
    'search: 判据清单里有 vendor-search 且为绿',
    criteria48
      .contractChecklist({ contractSrc: contractSrc48, meowIndexSrc: meowIndex48 })
      .some((c) => c.id === 'vendor-search' && c.ok),
    String(Object.keys(criteria48.CONTRACT_MARKS).length) + ' 个常量',
  )
  check(
    'search: 探针钉住五种空结果与兜底（AH1–AH6）',
    fusion48.includes('AH1 五种空结果各归各的') &&
      fusion48.includes('AH2 层名一个都不认识时说「这次一条都没查」') &&
      fusion48.includes('AH3 部分层名不认识时点名') &&
      fusion48.includes('AH4 显式限定层却零命中时说') &&
      fusion48.includes('AH5 没给 level 时仍是原来那句') &&
      fusion48.includes('AH6 子插件一个字都不给时'),
    'probe-fusion',
  )
  const v48 = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version.split('.').map(Number)
  check('search: 版本不早于 0.2.51', v48[0] === 0 && v48[1] === 2 && v48[2] >= 51, v48.join('.'))
  check(
    'search: README 与 DESIGN 记了这一轮',
    readFileSync(join(root, 'docs', 'INTERNAL.md'), 'utf8').includes('0.2.51') &&
      readFileSync(join(root, 'DESIGN.md'), 'utf8').includes('0.2.51') &&
      readFileSync(join(root, 'DESIGN.md'), 'utf8').includes('层名'),
    '文档',
  )
}

// A49（0.2.52）：`memory_read` 的短 id 走 LIKE 前缀，撞上多条时**静默取第一条**（按 LEVELS 顺序跨表），
// 回执却写成「[fact] 标题（active）」，读起来像「你要的就是这条」——递来的其实是别人的正文。
// 而写路径 memory_update 早就拒绝歧义，读比写松，两边口径不统一。
{
  const contract49 = await import(pathToFileURL(join(root, 'lib/macro/contract.js')).href)
  const criteria49 = await import(pathToFileURL(join(root, 'tools/criteria.mjs')).href)
  const contractSrc49 = readFileSync(join(root, 'lib/macro', 'contract.js'), 'utf8')
  const meowIndex49 = readFileSync(join(root, 'vendor', 'meow-memory', 'lib', 'index.js'), 'utf8')
  const readSrc49 = readFileSync(join(root, 'lib/macro', 'defs', 'read.js'), 'utf8')
  const fusion49 = readFileSync(join(root, 'tools', 'probe-fusion.mjs'), 'utf8')
  const R_AMB49 =
    '这个短 id 不止一条记忆：命中了 7 条（fact 0mwn0apf1「AI 探针」；lesson 0mwmz5n0「回执」）。所以这次一条都没读——不是我替你挑第一条。把 id 给够位数（至少 8 位，最好整条）再读一次。'
  const R_NF49 =
    '这个工作区里一条都没有：id「0mzz」在七层表里都查不到。可能是拼错了、位数不够（短 id 至少 8 位），也可能是这条记忆建在别的 cwd 会话里。'
  const R_NOREPLY49 = '读取这次没有任何回执（既没有正文，也没说为什么没有）——这不是「这条记忆是空的」。'
  const R_OK49 = '[fact] 标题（active）\n项目：AI探针项目0252\n正文…\n如果冲突，以最新的为准。'

  check(
    'read: 三个常量按值起名，且与判据表一致',
    contractSrc49.includes("export const READ_AMBIGUOUS_MARK = '这个短 id 不止一条记忆'") &&
      contractSrc49.includes("export const READ_NOT_FOUND_MARK = '这个工作区里一条都没有'") &&
      contractSrc49.includes("export const READ_NO_REPLY_MARK = '读取这次没有任何回执'") &&
      criteria49.CONTRACT_MARKS.READ_AMBIGUOUS_MARK === contract49.READ_AMBIGUOUS_MARK &&
      criteria49.CONTRACT_MARKS.READ_NOT_FOUND_MARK === contract49.READ_NOT_FOUND_MARK &&
      criteria49.CONTRACT_MARKS.READ_NO_REPLY_MARK === contract49.READ_NO_REPLY_MARK,
    'READ_AMBIGUOUS_MARK / READ_NOT_FOUND_MARK / READ_NO_REPLY_MARK',
  )
  check(
    'read: 四种读结果各归各的（短 id 撞车 / 工作区里真没有 / 上游没回执 / 真读到了）',
    contract49.readAnswerKind(R_AMB49) === 'ambiguous' &&
      contract49.readAnswerKind(R_NF49) === 'notFound' &&
      contract49.readAnswerKind(R_NOREPLY49) === 'noReply' &&
      contract49.readAnswerKind(R_OK49) === 'ok',
    [R_AMB49, R_NF49, R_NOREPLY49, R_OK49].map((t) => contract49.readAnswerKind(t)).join(','),
  )
  check(
    'read: 撞车那句自己否认「替你挑了第一条」（否则它读起来和真读到一模一样）',
    R_AMB49.includes('不是我替你挑第一条') &&
      contract49.readAnswerKind(R_AMB49) === 'ambiguous' &&
      !R_OK49.includes('不是我替你挑第一条'),
    '否认 + 正常读到不否认',
  )
  check(
    'read: 「撞车」与「真没有」分得开（前者说命中几条，后者说工作区与位数）',
    contract49.readAnswerKind(R_AMB49) === 'ambiguous' &&
      contract49.readAnswerKind(R_NF49) === 'notFound' &&
      R_AMB49.includes('命中了') &&
      R_NF49.includes('别的 cwd 会话') &&
      R_NF49.includes('至少 8 位'),
    'ambiguous 与 notFound 的分界',
  )
  check(
    'read: vendor 不再用 findById 静默取第一条（先数一遍，>1 就拒绝读）',
    /const matches = typeof db\.findByIdAll === "function"/.test(meowIndex49) &&
      // 必须锚在 read 这一处：`matches.length > 1` 在别的分支里也出现过，
      // 只判「这句话在不在」会被别处的同款 if 蒙过（0.2.52 阴性对照踩到的）。
      /if \(matches\.length > 1\) \{\s*\n\s*const shown = matches\.slice\(0, 5\)/.test(meowIndex49) &&
      /ambiguous: true/.test(meowIndex49) &&
      !/const found = getDb\(workspace, dir\)\.findById\(id\);/.test(meowIndex49),
    'findByIdAll + matches.length > 1',
  )
  check(
    'read: 三个新字段在 schema 里（ambiguous / candidates / note）',
    /ambiguous: \{ type: "boolean" \}/.test(meowIndex49) &&
      /candidates: \{ type: "array", items: \{ type: "string" \} \}/.test(meowIndex49) &&
      /note: \{ type: "string" \}/.test(meowIndex49),
    'output.schema',
  )
  check(
    'read: render 先判 ambiguous 再判 found（不然「没读到」会被写成「未找到该记忆」）',
    /if \(v\.ambiguous === true\) return \[\{ type: "text", text: String\(v\.note \?\? ""\) \}\]/.test(meowIndex49),
    'render 分支顺序',
  )
  check(
    'read: 真没有那支点名当前工作区（记忆库按工作区分库，换个 cwd 就查不到）',
    /记忆库按工作区分开存（当前工作区 \$\{workspace\}）/.test(meowIndex49),
    'memory_read note',
  )
  check(
    'read: 融合层不被空回执沉默（defs/read.js 自己说话）',
    /\[macro-fusion 0\.2\.52\][\s\S]{0,400}?const said = String\(main\.text \?\? ''\)\.trim\(\)\n\s+if \(said\.length === 0\) \{/.test(
      readSrc49,
    ) &&
      readSrc49.includes('读取这次没有任何回执') &&
      readSrc49.includes('这不是「这条记忆是空的」'),
    'lib/macro/defs/read.js',
  )
  check(
    'read: 判据清单里有 vendor-read 且为绿',
    criteria49
      .contractChecklist({ contractSrc: contractSrc49, meowIndexSrc: meowIndex49 })
      .some((c) => c.id === 'vendor-read' && c.ok),
    String(Object.keys(criteria49.CONTRACT_MARKS).length) + ' 个常量',
  )
  check(
    'read: 探针钉住撞车/查无/兜底与正常读（AI1–AI5）',
    fusion49.includes('AI1 四种读结果各归各的') &&
      fusion49.includes('AI2 两位前缀撞车时明说「不止一条」') &&
      fusion49.includes('AI3 查无此 id 时说「这个工作区里一条都没有」') &&
      fusion49.includes('AI4 唯一 8 位前缀照常读出正文') &&
      fusion49.includes('AI5 子插件一个字都不给时'),
    'probe-fusion',
  )
  const v49 = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version.split('.').map(Number)
  check('read: 版本不早于 0.2.52', v49[0] === 0 && v49[1] === 2 && v49[2] >= 52, v49.join('.'))
  check(
    'read: README 与 DESIGN 记了这一轮',
    readFileSync(join(root, 'docs', 'INTERNAL.md'), 'utf8').includes('0.2.52') &&
      readFileSync(join(root, 'DESIGN.md'), 'utf8').includes('0.2.52') &&
      readFileSync(join(root, 'DESIGN.md'), 'utf8').includes('撞车'),
    '文档',
  )
}

// A50（0.2.53）：`memory_find_similar` 的基准读取也是 `findById`——短 id 撞车时静默取第一条，
// 然后**拿别人的正文当基准**去算相似度：分数与排序全错，而回执看起来完全正常。
// 0.2.52 只修了 memory_read，这条读路径同样吃短 id；这里把两边口径对齐，并钉住「基准没站住」的两种说法。
{
  const contract50 = await import(pathToFileURL(join(root, 'lib/macro/contract.js')).href)
  const criteria50 = await import(pathToFileURL(join(root, 'tools/criteria.mjs')).href)
  const contractSrc50 = readFileSync(join(root, 'lib/macro', 'contract.js'), 'utf8')
  const meowIndex50 = readFileSync(join(root, 'vendor', 'meow-memory', 'lib', 'index.js'), 'utf8')
  const searchSrc50 = readFileSync(join(root, 'lib/macro', 'defs', 'search.js'), 'utf8')
  const fusion50 = readFileSync(join(root, 'tools', 'probe-fusion.mjs'), 'utf8')
  const S_AMB50 =
    '相似检索未完成：memory_find_similar: 相似检索这次一条都没比：这个短 id 命中了 3 条（fact 0m1「…」；lesson 0m2「…」）。不是我替你挑第一条——基准挑错，比出来的相似度全是错的。把 id 给够位数（至少 8 位，最好整条）再试。'
  const S_NF50 =
    '相似检索未完成：memory_find_similar: 相似检索没起点——这个工作区里一条都没有：id「0mzz」在七层表里都查不到（记忆库按工作区分开存，当前工作区 x）。可能是拼错了、位数不够（至少 8 位）。'
  const S_NOT50 = '相似检索没算成：可比的候选一条都没有（库里 9 条，本会话新写的和这一轮已看过的都被排除了）。'
  const S_NONE50 = '没有一条够得上：这才是「记忆里没有相似的东西」。'
  const S_HIT50 = '[fact 0mwmz5l2] 相似度 0.731 标题 正文…'

  check(
    'similar: 两个新常量按值起名，且与判据表一致',
    contractSrc50.includes("export const SIMILAR_AMBIGUOUS_MARK = '相似检索这次一条都没比'") &&
      contractSrc50.includes("export const SIMILAR_NOT_FOUND_MARK = '相似检索没起点'") &&
      criteria50.CONTRACT_MARKS.SIMILAR_AMBIGUOUS_MARK === contract50.SIMILAR_AMBIGUOUS_MARK &&
      criteria50.CONTRACT_MARKS.SIMILAR_NOT_FOUND_MARK === contract50.SIMILAR_NOT_FOUND_MARK,
    'SIMILAR_AMBIGUOUS_MARK / SIMILAR_NOT_FOUND_MARK',
  )
  check(
    'similar: 五种结果各归各的（基准撞车 / 基准没起点 / 没算成 / 真没有 / 算出来了）',
    contract50.similarAnswerKind(S_AMB50) === 'ambiguous' &&
      contract50.similarAnswerKind(S_NF50) === 'notFound' &&
      contract50.similarAnswerKind(S_NOT50) === 'notComputed' &&
      contract50.similarAnswerKind(S_NONE50) === 'none' &&
      contract50.similarAnswerKind(S_HIT50) === 'ok',
    [S_AMB50, S_NF50, S_NOT50, S_NONE50, S_HIT50].map((t) => contract50.similarAnswerKind(t)).join(','),
  )
  check(
    'similar: 归类只有一个函数（0.2.46 的两支并进来，不是再声明一个）',
    (contractSrc50.match(/export function similarAnswerKind\(/g) ?? []).length === 1,
    String((contractSrc50.match(/export function similarAnswerKind\(/g) ?? []).length) + ' 处声明',
  )
  check(
    'similar: 基准没站住排在「没算成 / 没有相似」前（撞车时那两句话都不成立）',
    contract50.similarAnswerKind(`${S_AMB50} ${S_NOT50} ${S_NONE50}`) === 'ambiguous' &&
      contract50.similarAnswerKind(S_AMB50) !== 'none',
    'ambiguous 优先',
  )
  check(
    'similar: 撞车那句自己否认「没有相似」，并说清基准挑错会算错分数',
    S_AMB50.includes('不是我替你挑第一条') &&
      S_AMB50.includes('基准挑错，比出来的相似度全是错的') &&
      !S_AMB50.includes('记忆里没有相似') &&
      !S_HIT50.includes('基准挑错'),
    '否认 + 真算出来时不带这句',
  )
  check(
    'similar: 「基准撞车」与「基准没起点」分得开（命中几条 vs 工作区与位数）',
    contract50.similarAnswerKind(S_AMB50) === 'ambiguous' &&
      contract50.similarAnswerKind(S_NF50) === 'notFound' &&
      S_AMB50.includes('命中了 3 条') &&
      S_NF50.includes('记忆库按工作区分开存') &&
      S_NF50.includes('至少 8 位'),
    'ambiguous 与 notFound 的分界',
  )
  check(
    'similar: vendor 不再用 findById 取基准（先数一遍，>1 就一条都不比）',
    /const matches = typeof db\.findByIdAll === "function"/.test(meowIndex50) &&
      // 必须锚到 find_similar 这一处：read 那边同一个 if 块长得几乎一样，
      // 只判「if (matches.length > 1)」会被 read 的补丁蒙过（0.2.52 阴性对照踩到的）。
      /if \(matches\.length > 1\) \{\s*\n\s*const shown = matches\.slice\(0, 5\)[\s\S]{0,400}?memory_find_similar: 相似检索这次一条都没比/.test(
        meowIndex50,
      ) &&
      !/const found = db\.findById\(id\);\s*\n\s*if \(!found\) throw new Error\(`memory_find_similar: 未找到记忆/.test(meowIndex50),
    'findByIdAll + matches.length > 1 + 老 throw 已消失',
  )
  check(
    'similar: 两条 throw 各自说清（撞车说「一条都没比」、没起点说「工作区里一条都没有」）',
    /memory_find_similar: 相似检索这次一条都没比/.test(meowIndex50) &&
      /memory_find_similar: 相似检索没起点/.test(meowIndex50) &&
      /当前工作区 \$\{workspace\}/.test(meowIndex50),
    'vendor throw 文本',
  )
  check(
    'similar: 0.2.46 的兜底没被这一刀弄坏（融合层空回执那句仍在）',
    searchSrc50.includes('相似检索这次没给出任何内容') &&
      searchSrc50.includes('这不是「记忆里没有相似的东西」') &&
      /mode === 'similar'/.test(searchSrc50),
    'lib/macro/defs/search.js',
  )
  check(
    'similar: 判据清单里有 vendor-similar-id 且为绿（0.2.46 那条 vendor-similar 也仍是绿的）',
    criteria50
      .contractChecklist({ contractSrc: contractSrc50, meowIndexSrc: meowIndex50 })
      .filter((c) => (c.id === 'vendor-similar-id' || c.id === 'vendor-similar') && c.ok).length === 2,
    String(Object.keys(criteria50.CONTRACT_MARKS).length) + ' 个常量',
  )
  check(
    'similar: 探针钉住撞车/没起点/正常比（AJ1–AJ4）',
    fusion50.includes('AJ1 三种相似检索结果各归各的') &&
      fusion50.includes('AJ1 撞车那句自己说清「基准挑错，分数全是错的」') &&
      fusion50.includes('AJ2 基准短 id 撞车时明说「一条都没比」') &&
      fusion50.includes('AJ2 且不给出任何「相似度 0.xxx」的假分数') &&
      fusion50.includes('AJ3 基准查无此 id 时说「相似检索没起点」') &&
      fusion50.includes('AJ4 整条 id 照常走到「比了一遍」'),
    'probe-fusion',
  )
  const v50 = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version.split('.').map(Number)
  check('similar: 版本不早于 0.2.53', v50[0] === 0 && v50[1] === 2 && v50[2] >= 53, v50.join('.'))
  check(
    'similar: README 与 DESIGN 记了这一轮',
    readFileSync(join(root, 'docs', 'INTERNAL.md'), 'utf8').includes('0.2.53') &&
      readFileSync(join(root, 'DESIGN.md'), 'utf8').includes('0.2.53') &&
      readFileSync(join(root, 'DESIGN.md'), 'utf8').includes('基准'),
    '文档',
  )
}

// A51（0.2.54）：融合层把短 id 归一成完整 id 的那一步只回「id 或 null」，于是三种完全不同的
// 真相被说成同一句话「找不到这条记忆（id 写错了，或它已经被合并掉）」：
//   撞车（memory_read 明确说这个前缀不止一条，记忆明明在）/ 没查成（meow 没接上，连有没有都不知道）/ 真没有。
// 而且补连队列见 null 就摘，面板还报「清掉 N 条永远连不上的（记忆已合并/删除）」——一次超时就能整批清空。
// 这一块把三句分开，并钉住「前两种一条都不许摘」。
{
  const flowSrc51 = readFileSync(join(root, 'lib/macro', 'linkflow.js'), 'utf8')
  const linksSrc51 = readFileSync(join(root, 'lib/macro', 'links.js'), 'utf8')
  const linkDefSrc51 = readFileSync(join(root, 'lib/macro', 'defs', 'link.js'), 'utf8')
  const adminSrc51 = readFileSync(join(root, 'lib/macro', 'defs', 'admin.js'), 'utf8')
  const contract51 = await import(pathToFileURL(join(root, 'lib/macro/contract.js')).href)
  const criteria51 = await import(pathToFileURL(join(root, 'tools/criteria.mjs')).href)
  const fusion51 = readFileSync(join(root, 'tools', 'probe-fusion.mjs'), 'utf8')

  check(
    'link: 三句各一个常量（撞车 / 没查成 / 真没有），不再挤在一句话里',
    flowSrc51.includes("export const LINK_AMBIGUOUS_LINE =") &&
      flowSrc51.includes("export const LINK_UNAVAILABLE_LINE =") &&
      flowSrc51.includes("export const LINK_MISSING_LINE =") &&
      flowSrc51.includes('连错一条比没连上更难发现') &&
      flowSrc51.includes('这不是「这条记忆不存在」'),
    '三常量',
  )
  check(
    'link: 归一函数回四种 kind，而不是 id / null 两态',
    flowSrc51.includes('async function resolveIdDetail(') &&
      flowSrc51.includes("return { kind: 'missing', id: ''") &&
      flowSrc51.includes("kind: 'unavailable'") &&
      flowSrc51.includes("kind: 'ambiguous'") &&
      flowSrc51.includes("return { kind: 'ok', id: v.id }"),
    'resolveIdDetail',
  )
  check(
    'link: 旧的 resolveId 只留成兼容壳（拿不到完整 id 就 null），不再自己做判断',
    /async function resolveId\(id, exec\) \{\s*\n\s*const d = await resolveIdDetail\(id, exec\)\s*\n\s*return d\.kind === 'ok' \? d\.id : null\s*\n\s*\}/.test(
      flowSrc51,
    ),
    'resolveId 兼容壳',
  )
  check(
    'link: memory_link 的 a/b 也走三分支，旧那句「找不到这条记忆」已经消失',
    linkDefSrc51.includes('flow.resolveIdDetail(args.a, exec)') &&
      linkDefSrc51.includes('星图连线这次没做：') &&
      linkDefSrc51.includes('这不是「这条记忆不存在」') &&
      !linkDefSrc51.includes('找不到这条记忆'),
    'defs/link.js',
  )
  check(
    'link: 真没有那一支才提「写错一位 / 被合并」，并指向 memory_search 反查',
    linkDefSrc51.includes('这个工作区里没有这条记忆') &&
      linkDefSrc51.includes('写错了一位') &&
      linkDefSrc51.includes('memory_search 反查'),
    'defs/link.js',
  )
  check(
    '队列: 撞车的条目留着（单独计数、不摘、不算 dropped）',
    /if \(da\.kind === 'ambiguous' \|\| db\.kind === 'ambiguous'\) \{\s*\n\s*\/\/[^\n]*\n\s*ambiguous \+= 1\s*\n\s*continue\s*\n\s*\}/.test(
      linksSrc51,
    ),
    'links.js',
  )
  check(
    '队列: 没查成的条目也留着（单独计数、不摘）',
    /if \(da\.kind === 'unavailable' \|\| db\.kind === 'unavailable'\) \{\s*\n\s*\/\/[^\n]*\n\s*unavailable \+= 1\s*\n\s*continue\s*\n\s*\}/.test(
      linksSrc51,
    ),
    'links.js',
  )
  check(
    '队列: 只有「真没有」才摘，且两种新计数都交出去（空队列也一样）',
    /if \(da\.kind !== 'ok' \|\| db\.kind !== 'ok'\) \{\s*\n\s*dropped \+= 1/.test(linksSrc51) &&
      /return \{ tried, linked, dropped, ambiguous, unavailable, left: readPending\(\)\.length, stopped, budgetMs, limit \}/.test(
        linksSrc51,
      ) &&
      /if \(list\.length === 0\)\s*\n\s*return \{[^}]*ambiguous: 0, unavailable: 0/.test(linksSrc51),
    'links.js',
  )
  check(
    '面板: 撞车与没查成各有一条说明，且不再混进「清掉」',
    adminSrc51.includes('短 id 不止一条记忆') &&
      adminSrc51.includes('原样留着下次再试') &&
      /if \(round\.ambiguous > 0\)/.test(adminSrc51) &&
      /if \(round\.unavailable > 0\)/.test(adminSrc51),
    'defs/admin.js',
  )
  check(
    'link: 三个文件都不再抄 meow 那句「短 id 不止一条记忆」当自己的字面量（转述要引常量）',
    !linkDefSrc51.includes(`'${contract51.READ_AMBIGUOUS_MARK}'`) &&
      !flowSrc51.includes(`'${contract51.READ_AMBIGUOUS_MARK}'`) &&
      !linksSrc51.includes(`'${contract51.READ_AMBIGUOUS_MARK}'`),
    'READ_AMBIGUOUS_MARK',
  )
  check(
    'link: 判据清单里有 link-resolve-three，且整张清单仍全绿（四十五条）',
    (() => {
      const list = criteria51.contractChecklist({
        contractSrc: readFileSync(join(root, 'lib/macro', 'contract.js'), 'utf8'),
        sources: {
          'links.js': linksSrc51,
          'bridge.js': readFileSync(join(root, 'lib/macro', 'bridge.js'), 'utf8'),
          'linkflow.js': flowSrc51,
          'defs/link.js': linkDefSrc51,
          'defs/search.js': readFileSync(join(root, 'lib/macro', 'defs', 'search.js'), 'utf8'),
          'store.js': readFileSync(join(root, 'lib/macro', 'store.js'), 'utf8'),
          'cost.js': readFileSync(join(root, 'lib/macro', 'cost.js'), 'utf8'),
          'panel.js': readFileSync(join(root, 'lib/macro', 'panel.js'), 'utf8'),
          'defs/admin.js': readFileSync(join(root, 'lib/macro', 'defs', 'admin.js'), 'utf8'),
          'shared.js': readFileSync(join(root, 'lib/macro', 'shared.js'), 'utf8'),
          'defs/read.js': readFileSync(join(root, 'lib/macro', 'defs', 'read.js'), 'utf8'),
          'prompt.js': readFileSync(join(root, 'lib/macro', 'prompt.js'), 'utf8'),
        },
        runtime: contract51,
        nebIndexSrc: readFileSync(join(root, 'vendor', 'dsh-memory-nebula', 'lib', 'index.js'), 'utf8'),
        nebCoreSrc: readFileSync(join(root, 'vendor', 'dsh-memory-nebula', 'lib', 'host', 'nebula.js'), 'utf8'),
        meowIndexSrc: readFileSync(join(root, 'vendor', 'meow-memory', 'lib', 'index.js'), 'utf8'),
      })
      const mine = list.find((c) => c.id === 'link-resolve-three')
      return list.length === 45 && mine?.ok === true && list.every((c) => c.ok)
    })(),
    '判据清单',
  )
  check(
    'link: 探针钉住三种真相与「前两种不摘队列」（AK1–AK5）',
    fusion51.includes('AK1 连线时短 id 撞车') &&
      fusion51.includes('AK1 且不冒充「这条记忆不存在」') &&
      fusion51.includes('AK2 读记忆的工具没接上') &&
      fusion51.includes('AK3 撞车的条目留在队列里') &&
      fusion51.includes('AK3 面板如实报「没连也没摘」') &&
      fusion51.includes('AK4 没查成的条目也留在队列里') &&
      fusion51.includes('AK4 面板说「原样留着下次再试」') &&
      fusion51.includes('AK5 真没有的条目照旧摘掉'),
    'probe-fusion',
  )
  const v51 = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version.split('.').map(Number)
  check('link: 版本不早于 0.2.54', v51[0] === 0 && v51[1] === 2 && v51[2] >= 54, v51.join('.'))
  check(
    'link: README 与 DESIGN 记了这一轮',
    readFileSync(join(root, 'docs', 'INTERNAL.md'), 'utf8').includes('0.2.54') &&
      readFileSync(join(root, 'DESIGN.md'), 'utf8').includes('0.2.54') &&
      readFileSync(join(root, 'DESIGN.md'), 'utf8').includes('补连队列'),
    '文档',
  )
}

// A52（0.2.55）：面板上的「0 条 / 还是空的」原来只有一种说法，但它有四种来路：
//   从没写过 / 写不进去（记账、排队都失败）/ 读不出来（EISDIR、权限）/ 整份都是坏行。
// 前三种都被说成「你还没调用工具」「都连上了，没有欠账」——把「我没做到」推给了用户。
// 这一块把四支分开，并要求写成功时把失败账清零（旧账不许冒充现在的状态）。
{
  const store52 = readFileSync(join(root, 'lib/macro/store.js'), 'utf8')
  const cost52 = readFileSync(join(root, 'lib/macro/cost.js'), 'utf8')
  const links52 = readFileSync(join(root, 'lib/macro/links.js'), 'utf8')
  const fusion52 = readFileSync(join(root, 'tools', 'probe-fusion.mjs'), 'utf8')
  const criteria52 = await import(pathToFileURL(join(root, 'tools/criteria.mjs')).href)
  const contract52 = await import(pathToFileURL(join(root, 'lib/macro/contract.js')).href)

  check(
    'store: 读侧把「为什么没读到」带出来，只有 ENOENT 才算真的没有',
    store52.includes('export function readJsonlDetail(') &&
      /err && err\.code === 'ENOENT'/.test(store52) &&
      store52.includes('unreadable: !missing') &&
      store52.includes('badLines'),
    'readJsonlDetail',
  )
  check(
    'store: 写侧把失败原因带出来，不再只回一个 false',
    store52.includes('export function appendJsonlDetail(') &&
      cost52.includes('appendJsonlDetail(') &&
      /if \(!r\.ok\) \{/.test(cost52),
    'appendJsonlDetail',
  )
  check(
    'store: 成本账本四种「空」各说各的',
    cost52.includes('一行都没写进去') &&
      cost52.includes('一行都解析不出来') &&
      cost52.includes('不是账本是空的') &&
      cost52.includes('还没记过账'),
    '四支',
  )
  check(
    'store: 记账失败时明确否认「你还没调用工具」',
    cost52.includes('这不是「你还没调用工具」'),
    '否认',
  )
  check(
    'store: 记账写成功就把失败账清零（旧账不冒充现在的状态）',
    /writeFail\.failures = 0/.test(cost52) && /writeFail\.failures = 0/.test(links52),
    '清零',
  )
  check(
    'store: 待补队列四种「空」各说各的，真的 0 条仍是原来那句',
    links52.includes('一条都没存下来') &&
      links52.includes('一行都解析不出来') &&
      links52.includes('不是「都连上了、没有欠账」') &&
      links52.includes('一条都用不上（要么过期了，要么缺 a/b）') &&
      links52.includes('待补连线：0 条（星图那边都连上了，没有欠账）'),
    '四支',
  )
  check(
    'store: 队列写不进去仍返回 false，主流程照旧不被打断',
    /renameSync\(tmp, file\)\s*\n\s*writeFail\.failures = 0/.test(links52) &&
      /catch \(err\) \{\s*\n\s*writeFail\.failures \+= 1[\s\S]{0,120}return false/.test(links52),
    'queuePending',
  )
  check(
    'store: 判据清单里有 store-fail-visible，且这条会红（自测过）',
    (() => {
      const list = criteria52.contractChecklist({
        contractSrc: readFileSync(join(root, 'lib/macro', 'contract.js'), 'utf8'),
        sources: {
          'links.js': links52,
          'bridge.js': readFileSync(join(root, 'lib/macro', 'bridge.js'), 'utf8'),
          'linkflow.js': readFileSync(join(root, 'lib/macro', 'linkflow.js'), 'utf8'),
          'defs/link.js': readFileSync(join(root, 'lib/macro', 'defs', 'link.js'), 'utf8'),
          'defs/search.js': readFileSync(join(root, 'lib/macro', 'defs', 'search.js'), 'utf8'),
          'store.js': store52,
          'cost.js': cost52,
          'panel.js': readFileSync(join(root, 'lib/macro', 'panel.js'), 'utf8'),
          'defs/admin.js': readFileSync(join(root, 'lib/macro', 'defs', 'admin.js'), 'utf8'),
          'shared.js': readFileSync(join(root, 'lib/macro', 'shared.js'), 'utf8'),
          'defs/read.js': readFileSync(join(root, 'lib/macro', 'defs', 'read.js'), 'utf8'),
          'prompt.js': readFileSync(join(root, 'lib/macro', 'prompt.js'), 'utf8'),
        },
        runtime: contract52,
        nebIndexSrc: readFileSync(join(root, 'vendor', 'dsh-memory-nebula', 'lib', 'index.js'), 'utf8'),
        nebCoreSrc: readFileSync(join(root, 'vendor', 'dsh-memory-nebula', 'lib', 'host', 'nebula.js'), 'utf8'),
        meowIndexSrc: readFileSync(join(root, 'vendor', 'meow-memory', 'lib', 'index.js'), 'utf8'),
      })
      const mine = list.find((c) => c.id === 'store-fail-visible')
      return list.length === 45 && mine?.ok === true && list.every((c) => c.ok)
    })(),
    'store-fail-visible',
  )
  check(
    'store: 探针把四种来路钉在真文件系统上（AL1–AL8）',
    ['AL1', 'AL2', 'AL3', 'AL4', 'AL5', 'AL6', 'AL7', 'AL8'].every((n) => fusion52.includes(`'${n} `)),
    'probe-fusion',
  )
  const v52 = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version.split('.').map(Number)
  check('store: 版本不早于 0.2.55', v52[0] === 0 && v52[1] === 2 && v52[2] >= 55, v52.join('.'))
  check(
    'store: README 与 DESIGN 记了这一轮（四种来路）',
    readFileSync(join(root, 'docs', 'INTERNAL.md'), 'utf8').includes('0.2.55') &&
      readFileSync(join(root, 'DESIGN.md'), 'utf8').includes('0.2.55') &&
      readFileSync(join(root, 'DESIGN.md'), 'utf8').includes('四种来路'),
    '文档',
  )
}

// ── A53. 检索参数给错了：状态 / 时段 / 条数 / 截断各说各的（0.2.56）────────
{
  const meow56 = readFileSync(join(root, 'vendor', 'meow-memory', 'lib', 'index.js'), 'utf8')
  const fusion56 = readFileSync(join(root, 'tools', 'probe-fusion.mjs'), 'utf8')
  const criteria56 = await import(pathToFileURL(join(root, 'tools', 'criteria.mjs')).href)
  const contract56 = await import(pathToFileURL(join(root, 'lib/macro/contract.js')).href)

  check(
    'search: 状态值按白名单收，拼错的名字留着说（不再直接塞给 db.list）',
    meow56.includes('const STATUS_VALUES = ["active", "stale", "archived"]') &&
      /const statusBad = statusAsked\.filter\(\(s\) => s !== "all" && !STATUS_VALUES\.includes\(s\)\)/.test(meow56) &&
      /const statusList = statusAsked\.filter\(\(s\) => s === "all" \|\| STATUS_VALUES\.includes\(s\)\)/.test(meow56) &&
      /const statusDead = statusAsked\.length > 0 && statusList\.length === 0/.test(meow56),
    'STATUS_VALUES',
  )
  check(
    'search: 状态值全不认识时一行都不查（不去库里空转一趟再报零命中）',
    /const rows = statusDead \? \[\] : levels\.flatMap/.test(meow56),
    'statusDead',
  )
  check(
    'search: 状态值全错时说「这次一条都没查」，并否认「记忆里没有」',
    meow56.includes('状态值没对上') &&
      meow56.includes('你给的状态值') &&
      meow56.includes('这不是「记忆里没有」，是状态值没对上'),
    '全错',
  )
  check(
    'search: 部分状态值不认识时点名，并说清这次只按哪些过滤',
    meow56.includes('这几个状态值没生效') && meow56.includes('这次只按 ${statusList.join(" / ")} 过滤'),
    '部分',
  )
  check(
    'search: 状态值全错时不许再报「本次零命中：默认检索范围…」（两件事别混）',
    /const plain = hits\.length === 0 && !explicitLevels && !statusDead \?/.test(meow56),
    'plain',
  )
  check(
    'search: days 给非正数时说「这个过滤没生效，等于查了全部时段」',
    /const daysGiven = /.test(meow56) && meow56.includes('days 给的是') && meow56.includes('不是正数') && meow56.includes('没生效'),
    'days',
  )
  check(
    'search: k / content_max 被夹到边界时说清按多少处理',
    meow56.includes('k 给的是') &&
      meow56.includes('超出 1–50') &&
      meow56.includes('content_max 给的是') &&
      meow56.includes('超出 0–5000') &&
      /const kClamped = kGiven && \(kRaw === void 0 \|\| kRaw < 1 \|\| kRaw > 50\)/.test(meow56) &&
      /const cmClamped = cmGiven && \(cmRaw === void 0 \|\| cmRaw < 0 \|\| cmRaw > 5e3\)/.test(meow56),
    'k/content_max',
  )
  check(
    'search: 四条参数提示并进 note，且顺序在老的层名/范围提示之后',
    /const note = \[plain, levelNote, scopeNote, statusNote, daysNote, kNote, cmNote(?:, \w+)*\]\.filter\(\(s\) => s\.length > 0\)\.join\("\\n"\)/.test(meow56),
    'note',
  )
  check(
    'search: 判据清单里 45 条含 vendor-search-param，且这条会红（自测过）',
    (() => {
      const list = criteria56.contractChecklist({
        contractSrc: readFileSync(join(root, 'lib/macro', 'contract.js'), 'utf8'),
        sources: {
          'links.js': readFileSync(join(root, 'lib/macro', 'links.js'), 'utf8'),
          'bridge.js': readFileSync(join(root, 'lib/macro', 'bridge.js'), 'utf8'),
          'linkflow.js': readFileSync(join(root, 'lib/macro', 'linkflow.js'), 'utf8'),
          'defs/link.js': readFileSync(join(root, 'lib/macro', 'defs', 'link.js'), 'utf8'),
          'defs/search.js': readFileSync(join(root, 'lib/macro', 'defs', 'search.js'), 'utf8'),
          'store.js': readFileSync(join(root, 'lib/macro', 'store.js'), 'utf8'),
          'cost.js': readFileSync(join(root, 'lib/macro', 'cost.js'), 'utf8'),
          'panel.js': readFileSync(join(root, 'lib/macro', 'panel.js'), 'utf8'),
          'defs/admin.js': readFileSync(join(root, 'lib/macro', 'defs', 'admin.js'), 'utf8'),
          'shared.js': readFileSync(join(root, 'lib/macro', 'shared.js'), 'utf8'),
          'defs/read.js': readFileSync(join(root, 'lib/macro', 'defs', 'read.js'), 'utf8'),
          'prompt.js': readFileSync(join(root, 'lib/macro', 'prompt.js'), 'utf8'),
        },
        runtime: contract56,
        nebIndexSrc: readFileSync(join(root, 'vendor', 'dsh-memory-nebula', 'lib', 'index.js'), 'utf8'),
        nebCoreSrc: readFileSync(join(root, 'vendor', 'dsh-memory-nebula', 'lib', 'host', 'nebula.js'), 'utf8'),
        meowIndexSrc: meow56,
      })
      const mine = list.find((c) => c.id === 'vendor-search-param')
      return list.length === 45 && mine?.ok === true && list.every((c) => c.ok)
    })(),
    'vendor-search-param',
  )
  check(
    'search: 探针把四种参数错法钉在真调用上（AM1–AM7）',
    ['AM1', 'AM2', 'AM3', 'AM4', 'AM5', 'AM6', 'AM7'].every((n) => fusion56.includes(`'${n} `)),
    'probe-fusion',
  )
  const v56 = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version.split('.').map(Number)
  check('search: 版本不早于 0.2.56', v56[0] === 0 && v56[1] === 2 && v56[2] >= 56, v56.join('.'))
  check(
    'search: README 与 DESIGN 记了这一轮（参数没生效）',
    readFileSync(join(root, 'docs', 'INTERNAL.md'), 'utf8').includes('0.2.56') &&
      readFileSync(join(root, 'DESIGN.md'), 'utf8').includes('0.2.56') &&
      readFileSync(join(root, 'DESIGN.md'), 'utf8').includes('参数没生效'),
    '文档',
  )
}

// ── A54. 数值参数：0 是值不是「没给」，越界要说出来（0.2.57）─────────────
// 星图的六个工具都用同一句 `Math.max(min, Math.min(max, Number(x) || def))` 收参数：
//   ① `min_weight: 0`（明确要求不过滤）是 falsy → 被换成 0.5，结果少了还被劝「调低一点」；
//   ② 越界被夹住后一个字都不说，用户拿着被改过的条件读结论；
//   ③ 非数字静默退回默认。
// 这一块要求统一走 numParam()，且每条结果都把「被改过」说出来（合法时一句都不加）。
{
  const neb57 = readFileSync(join(root, 'vendor', 'dsh-memory-nebula', 'lib', 'index.js'), 'utf8')
  const graph57 = readFileSync(join(root, 'tools', 'probe-graph.mjs'), 'utf8')
  const criteria57 = await import(pathToFileURL(join(root, 'tools/criteria.mjs')).href)
  const contract57 = await import(pathToFileURL(join(root, 'lib/macro/contract.js')).href)

  check(
    'param: 统一出口 numParam()，合规原样照办（0 也是值），不合规带回一句话',
    neb57.includes('function numParam(name, raw, { min, max, def })') &&
      /if \(clamped === n\) return \{ value: n, note: '' \}/.test(neb57) &&
      neb57.includes('不是数字——这次按默认') &&
      neb57.includes('超出 ${min}–${max}，这次按 ${clamped} 算'),
    'numParam',
  )
  check(
    'param: 六个工具的调用点全部换成 numParam（老的三层 Math.max/min 一个不剩）',
    /const pLimit = numParam\('limit', args\.limit, \{ min: 1, max: 30, def: 10 \}\)/.test(neb57) &&
      /const pHops = numParam\('hops', args\.hops, \{ min: 0, max: 3, def: 2 \}\)/.test(neb57) &&
      /const pWeight = numParam\('min_weight', args\.min_weight, \{ min: 0, max: 1, def: 0\.5 \}\)/.test(neb57) &&
      /const pMh = numParam\('maxHops', args\.maxHops, \{ min: 1, max: 12, def: 6 \}\)/.test(neb57) &&
      /const pHubs = numParam\('hubs', args\.hubs, \{ min: 1, max: HUB_CAP, def: 10 \}\)/.test(neb57) &&
      /const pNb = numParam\('neighbors', args\.neighbors, \{ min: 1, max: 40, def: 12 \}\)/.test(neb57) &&
      !/Number\(args\.\w+\) \|\|/.test(neb57),
    '调用点',
  )
  check(
    'param: recall 的两个参数各自出现在结果末尾（合法就不加）',
    neb57.includes("const notes = [pLimit.note, pHops.note].filter(Boolean)") &&
      /return notes\.length \? `\$\{base\}\\n\$\{notes\.join\('\\n'\)\}` : base/.test(neb57),
    'recall',
  )
  check(
    'param: inspect / stats / hygiene 的条数参数越界时补一行说明',
    neb57.includes('if (pNb.note) lines.push') &&
      neb57.includes('if (pHubs.note) lines.push') &&
      neb57.includes('if (pLim.note) lines.push'),
    'inspect/stats/hygiene',
  )
  check(
    'param: path 的两个出口都带上 maxHops 的说明（没连上也可能是跳数被夹过）',
    /确实没有连上[\s\S]{0,160}pMh\.note/.test(neb57) && /mute"\) 把它按掉[\s\S]{0,120}pMh\.note/.test(neb57),
    'path',
  )
  check(
    'param: bridge 的四个参数都进 budget，两处返回都带说明',
    neb57.includes('const pChars = numParam') &&
      neb57.includes('maxItems: pLim.value') &&
      neb57.includes('maxChars: pChars.value') &&
      neb57.includes('minWeight: pWeight.value') &&
      neb57.includes('hops: pHops.value') &&
      /'这不是「图里没有相关记忆」。', \.\.\.notes\]/.test(neb57) &&
      /res\.text,\s*\n\s*\.\.\.notes,/.test(neb57),
    'bridge',
  )
  check(
    'param: 判据清单里 45 条含 vendor-param-zero，且这条会红（自测过）',
    (() => {
      const list = criteria57.contractChecklist({
        contractSrc: readFileSync(join(root, 'lib/macro', 'contract.js'), 'utf8'),
        sources: {
          'links.js': readFileSync(join(root, 'lib/macro', 'links.js'), 'utf8'),
          'bridge.js': readFileSync(join(root, 'lib/macro', 'bridge.js'), 'utf8'),
          'linkflow.js': readFileSync(join(root, 'lib/macro', 'linkflow.js'), 'utf8'),
          'defs/link.js': readFileSync(join(root, 'lib/macro', 'defs', 'link.js'), 'utf8'),
          'defs/search.js': readFileSync(join(root, 'lib/macro', 'defs', 'search.js'), 'utf8'),
          'store.js': readFileSync(join(root, 'lib/macro', 'store.js'), 'utf8'),
          'cost.js': readFileSync(join(root, 'lib/macro', 'cost.js'), 'utf8'),
          'panel.js': readFileSync(join(root, 'lib/macro', 'panel.js'), 'utf8'),
          'defs/admin.js': readFileSync(join(root, 'lib/macro', 'defs', 'admin.js'), 'utf8'),
          'shared.js': readFileSync(join(root, 'lib/macro', 'shared.js'), 'utf8'),
          'defs/read.js': readFileSync(join(root, 'lib/macro', 'defs', 'read.js'), 'utf8'),
          'prompt.js': readFileSync(join(root, 'lib/macro', 'prompt.js'), 'utf8'),
        },
        runtime: contract57,
        nebIndexSrc: neb57,
        nebCoreSrc: readFileSync(join(root, 'vendor', 'dsh-memory-nebula', 'lib', 'host', 'nebula.js'), 'utf8'),
        meowIndexSrc: readFileSync(join(root, 'vendor', 'meow-memory', 'lib', 'index.js'), 'utf8'),
      })
      const mine = list.find((c) => c.id === 'vendor-param-zero')
      return list.length === 45 && mine?.ok === true && list.every((c) => c.ok)
    })(),
    'vendor-param-zero',
  )
  check(
    'param: 探针在真工具面上钉住七种参数说法（AN1–AN7）',
    ['AN1', 'AN2', 'AN3', 'AN4', 'AN5', 'AN6', 'AN7'].every((n) => graph57.includes(`'${n} `)),
    'probe-graph',
  )
  const v57 = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version.split('.').map(Number)
  check('param: 版本不早于 0.2.57', v57[0] === 0 && v57[1] === 2 && v57[2] >= 57, v57.join('.'))
  check(
    'param: README 与 DESIGN 记了这一轮（给 0 就照办 0）',
    readFileSync(join(root, 'docs', 'INTERNAL.md'), 'utf8').includes('0.2.57') &&
      readFileSync(join(root, 'DESIGN.md'), 'utf8').includes('0.2.57') &&
      readFileSync(join(root, 'DESIGN.md'), 'utf8').includes('给 0 就照办 0'),
    '文档',
  )
}

// A55. 检索模式名给错：不许静默换成另一种检索（0.2.58）
{
  const searchSrc = readFileSync(join(root, 'lib', 'macro', 'defs', 'search.js'), 'utf8')
  const criteria58 = await import(pathToFileURL(join(root, 'tools', 'criteria.mjs')).href)
  const contract58 = await import(pathToFileURL(join(root, 'lib', 'macro', 'contract.js')).href)
  const fusionSrc58 = readFileSync(join(root, 'tools', 'probe-fusion.mjs'), 'utf8')
  check(
    'search: 模式名先归一再判白名单（空串＝没给、大小写不敏感、原值留住）',
    searchSrc.includes("const MODE_VALUES = ['local', 'graph', 'bridge', 'similar']") &&
      searchSrc.includes("typeof raw === 'string' ? raw.trim() : ''") &&
      searchSrc.includes("if (text.length === 0) return { name: 'local', bad: false, raw: '' }") &&
      searchSrc.includes('const name = text.toLowerCase()') &&
      searchSrc.includes('bad: !MODE_VALUES.includes(name), raw: String(raw)'),
    'modeOf',
  )
  check(
    'search: 模式名不合法时一句都不查（先挡住，再谈检索）',
    /const mode = modeOf\(args\)[\s\S]{0,200}?if \(mode\.bad\) return badModeText\(mode\)[\s\S]{0,400}?const text = await runSearch\(flow, args, exec, flags\)/.test(
      searchSrc,
    ),
    'badMode',
  )
  check(
    'search: 不合法时说清「这次一条都没查」「不是记忆里没有」，并给出哪种意图用哪个词',
    searchSrc.includes('mode 没生效：你给的是「${mode.raw}」') &&
      searchSrc.includes('这次一条都没查——这不是「记忆里没有」，是模式名没对上') &&
      searchSrc.includes('沿关联扩散用 graph') &&
      searchSrc.includes('相似条目用 similar + id'),
    'badModeText',
  )
  check(
    'search: 参数给在别的模式上时逐条说明「这次没用上」',
    searchSrc.includes('expand 只在 local 模式生效') &&
      /k 是本地检索的条数；\$\{mode\} 模式用 limit，这次按 \$\{def\} 条算/.test(searchSrc) &&
      searchSrc.includes('limit 是 graph / bridge 的条数') &&
      searchSrc.includes('只在 bridge 模式生效，这次没用上'),
    'modeNotes',
  )
  check(
    'search: 尾注只在薄壳里拼一次（十个出口不必各写一遍）',
    /const notes = modeNotes\(mode\.name, args, flags\)\s*\n\s*return notes\.length > 0 \? `\$\{text\}\\n\\n\$\{notes\.join\('\\n'\)\}` : text/.test(
      searchSrc,
    ),
    'wrapper',
  )
  check(
    'search: 老的「不认识就当 local」写法一行都不剩（注释里提一句可以，代码里不行）',
    !/^\s*const mode = String\(args\.mode/m.test(searchSrc) && /async function runSearch\(flow, args, exec, flags = \{\}\)/.test(searchSrc),
    'legacy',
  )
  check(
    'search: 判据清单里 45 条含 search-mode-whitelist，且这条会红（自测过）',
    (() => {
      const list = criteria58.contractChecklist({
        contractSrc: readFileSync(join(root, 'lib/macro', 'contract.js'), 'utf8'),
        sources: {
          'links.js': readFileSync(join(root, 'lib/macro', 'links.js'), 'utf8'),
          'bridge.js': readFileSync(join(root, 'lib/macro', 'bridge.js'), 'utf8'),
          'linkflow.js': readFileSync(join(root, 'lib/macro', 'linkflow.js'), 'utf8'),
          'defs/link.js': readFileSync(join(root, 'lib/macro', 'defs', 'link.js'), 'utf8'),
          'defs/search.js': searchSrc,
          'store.js': readFileSync(join(root, 'lib/macro', 'store.js'), 'utf8'),
          'cost.js': readFileSync(join(root, 'lib/macro', 'cost.js'), 'utf8'),
          'panel.js': readFileSync(join(root, 'lib/macro', 'panel.js'), 'utf8'),
          'defs/admin.js': readFileSync(join(root, 'lib/macro', 'defs', 'admin.js'), 'utf8'),
          'shared.js': readFileSync(join(root, 'lib/macro', 'shared.js'), 'utf8'),
          'defs/read.js': readFileSync(join(root, 'lib/macro', 'defs', 'read.js'), 'utf8'),
          'prompt.js': readFileSync(join(root, 'lib/macro', 'prompt.js'), 'utf8'),
        },
        runtime: contract58,
        nebIndexSrc: readFileSync(join(root, 'vendor', 'dsh-memory-nebula', 'lib', 'index.js'), 'utf8'),
        nebCoreSrc: readFileSync(join(root, 'vendor', 'dsh-memory-nebula', 'lib', 'host', 'nebula.js'), 'utf8'),
        meowIndexSrc: readFileSync(join(root, 'vendor', 'meow-memory', 'lib', 'index.js'), 'utf8'),
      })
      const mine = list.find((c) => c.id === 'search-mode-whitelist')
      return list.length === 45 && mine?.ok === true && list.every((c) => c.ok)
    })(),
    'search-mode-whitelist',
  )
  check(
    'search: 探针在真工具面上钉住九种模式说法（AO1–AO9）',
    ['AO1', 'AO2', 'AO3', 'AO4', 'AO5', 'AO6', 'AO7', 'AO8', 'AO9'].every((n) => fusionSrc58.includes(`'${n} `)),
    'probe-fusion',
  )
  const v58 = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version.split('.').map(Number)
  check('search: 版本不早于 0.2.58', v58[0] === 0 && v58[1] === 2 && v58[2] >= 58, v58.join('.'))
  check(
    'search: README 与 DESIGN 记了这一轮（模式名没对上）',
    readFileSync(join(root, 'docs', 'INTERNAL.md'), 'utf8').includes('0.2.58') &&
      readFileSync(join(root, 'DESIGN.md'), 'utf8').includes('0.2.58') &&
      readFileSync(join(root, 'DESIGN.md'), 'utf8').includes('模式名没对上'),
    '文档',
  )
}

// A56. 连线的动作名与两端 id：缺了先挡住，参数给错动作要说没用上（0.2.59）
{
  const linkSrc59 = readFileSync(join(root, 'lib', 'macro', 'defs', 'link.js'), 'utf8')
  const criteria59 = await import(pathToFileURL(join(root, 'tools', 'criteria.mjs')).href)
  const contract59 = await import(pathToFileURL(join(root, 'lib', 'macro', 'contract.js')).href)
  const fusionSrc59 = readFileSync(join(root, 'tools', 'probe-fusion.mjs'), 'utf8')
  check(
    'link: 动作名先归一（trim + 小写）再判白名单，空值算没给',
    linkSrc59.includes("const LINK_ACTIONS = ['link', 'unlink', 'mute', 'unmute', 'path']") &&
      /function linkActionOf\(args\)/.test(linkSrc59) &&
      /raw\.trim\(\)\.toLowerCase\(\)/.test(linkSrc59) &&
      /name, bad: !LINK_ACTIONS\.includes\(name\), missing: false, raw: String\(raw\)/.test(linkSrc59) &&
      linkSrc59.includes('没给 action'),
    'linkActionOf',
  )
  check(
    'link: 动作名写错时说清给的是什么、只认哪五个、星图和记忆都没动',
    linkSrc59.includes('action 给的是「${act.raw}」') &&
      linkSrc59.includes('只认 ${list}（大小写不敏感') &&
      linkSrc59.includes("const list = 'link / unlink / mute / unmute / path'") &&
      linkSrc59.includes('星图和记忆都没动') &&
      linkSrc59.includes('解释两条记忆之间的证据链用 path'),
    'badActionText',
  )
  check(
    'link: 缺 a / b 时先挡住——空串和纯空格也算没给（原来是 String(undefined) 让这一支整个消失）',
    /function missingEnds\(args\)/.test(linkSrc59) &&
      /typeof v !== 'string' \|\| v\.trim\(\) === ''/.test(linkSrc59) &&
      /function missingEndsText\(act, ends\)/.test(linkSrc59) &&
      linkSrc59.includes('缺 ${e.key}') &&
      linkSrc59.includes('也不会先排一条连不上的欠账'),
    'missingEnds',
  )
  check(
    'link: 薄壳先拦动作名、再拦两端 id、最后才跑主体（顺序不许换）',
    /if \(act\.bad\) return badActionText\(act\)[\s\S]{0,200}if \(ends\.length > 0\) return missingEndsText\(act, ends\)[\s\S]{0,160}const text = await runLink\(flow, act\.name, args, exec\)/.test(
      linkSrc59,
    ),
    'gate-order',
  )
  check(
    'link: 参数给错动作要带尾注（maxHops 只 path 用、note 只 link/mute 存），且只在薄壳里拼一次',
    linkSrc59.includes('maxHops 只在 path 这个动作生效') &&
      linkSrc59.includes('note 只有 link / mute 会存下来') &&
      /const notes = linkNotes\(act\.name, args\)/.test(linkSrc59) &&
      /notes\.length > 0 \? `\$\{text\}\\n\\n\$\{notes\.join\('\\n'\)\}` : text/.test(linkSrc59),
    'linkNotes',
  )
  check(
    'link: 老的 String(args.action) + 抛错写法一行都不剩（主体搬成模块级 runLink）',
    !/^\s*const action = String\(args\.action\)/m.test(linkSrc59) && /async function runLink\(flow, action, args, exec\)/.test(linkSrc59),
    'legacy',
  )
  check(
    'link: 判据清单里 45 条含 link-action-and-ends，且这条会红（自测过）',
    (() => {
      const list = criteria59.contractChecklist({
        contractSrc: readFileSync(join(root, 'lib/macro', 'contract.js'), 'utf8'),
        sources: {
          'links.js': readFileSync(join(root, 'lib/macro', 'links.js'), 'utf8'),
          'bridge.js': readFileSync(join(root, 'lib/macro', 'bridge.js'), 'utf8'),
          'linkflow.js': readFileSync(join(root, 'lib/macro', 'linkflow.js'), 'utf8'),
          'defs/link.js': linkSrc59,
          'defs/search.js': readFileSync(join(root, 'lib/macro/defs', 'search.js'), 'utf8'),
          'store.js': readFileSync(join(root, 'lib/macro', 'store.js'), 'utf8'),
          'cost.js': readFileSync(join(root, 'lib/macro', 'cost.js'), 'utf8'),
          'panel.js': readFileSync(join(root, 'lib/macro', 'panel.js'), 'utf8'),
          'defs/admin.js': readFileSync(join(root, 'lib/macro', 'defs', 'admin.js'), 'utf8'),
          'shared.js': readFileSync(join(root, 'lib/macro', 'shared.js'), 'utf8'),
          'defs/read.js': readFileSync(join(root, 'lib/macro', 'defs', 'read.js'), 'utf8'),
          'prompt.js': readFileSync(join(root, 'lib/macro', 'prompt.js'), 'utf8'),
        },
        runtime: contract59,
        nebIndexSrc: readFileSync(join(root, 'vendor', 'dsh-memory-nebula', 'lib', 'index.js'), 'utf8'),
        nebCoreSrc: readFileSync(join(root, 'vendor', 'dsh-memory-nebula', 'lib', 'host', 'nebula.js'), 'utf8'),
        meowIndexSrc: readFileSync(join(root, 'vendor', 'meow-memory', 'lib', 'index.js'), 'utf8'),
      })
      const mine = list.find((c) => c.id === 'link-action-and-ends')
      return list.length === 45 && mine?.ok === true && list.every((c) => c.ok)
    })(),
    'link-action-and-ends',
    'admin-limit-zero',
  )
  check(
    'link: 探针在真工具面上钉住八种缺参数 / 错动作说法（AP1–AP8）',
    ['AP1', 'AP2', 'AP3', 'AP4', 'AP5', 'AP6', 'AP7', 'AP8'].every((n) => fusionSrc59.includes(`'${n} `)),
    'probe-fusion',
  )
  const v59 = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version.split('.').map(Number)
  check('link: 版本不早于 0.2.59', v59[0] === 0 && v59[1] === 2 && v59[2] >= 59, v59.join('.'))
  check(
    'link: README 与 DESIGN 记了这一轮（缺参数不许说成「已排队」）',
    readFileSync(join(root, 'docs', 'INTERNAL.md'), 'utf8').includes('0.2.59') &&
      readFileSync(join(root, 'DESIGN.md'), 'utf8').includes('0.2.59') &&
      readFileSync(join(root, 'DESIGN.md'), 'utf8').includes('缺参数'),
    '文档',
  )
}

// A57. 卡片抬头：动作键不许冒充名字，只读的 path 不许标成写（0.2.60）
{
  const panelSrc60 = readFileSync(join(root, 'lib', 'macro', 'panel.js'), 'utf8')
  const defsDir60 = join(root, 'lib', 'macro', 'defs')
  const defs60 = ['remember', 'update', 'search', 'read', 'project', 'link', 'dream', 'admin'].map((n) => [
    n,
    readFileSync(join(defsDir60, `${n}.js`), 'utf8'),
  ])
  const linkSrc60 = defs60.find(([n]) => n === 'link')[1]
  const searchSrc60 = defs60.find(([n]) => n === 'search')[1]
  const adminSrc60 = defs60.find(([n]) => n === 'admin')[1]
  const fusionSrc60 = readFileSync(join(root, 'tools', 'probe-fusion.mjs'), 'utf8')
  check(
    'card: 标题只有一条出口 cardTitle()（空细节不留悬空分隔符、压成一行、40 字截断）',
    /export const CARD_DETAIL_MAX = 40/.test(panelSrc60) &&
      /export function cardTitle\(label, detail\)/.test(panelSrc60) &&
      /detail\.replace\(\/\\s\+\/g, ' '\)\.trim\(\)/.test(panelSrc60) &&
      /if \(flat\.length === 0\) return prefix/.test(panelSrc60) &&
      /flat\.slice\(0, CARD_DETAIL_MAX\)/.test(panelSrc60) &&
      panelSrc60.includes('`${prefix}：${short}`'),
    'cardTitle',
  )
  check(
    'card: 八个 defs 全走 cardTitle，没有一处自己拼标题模板',
    defs60.every(([, src]) => src.includes("from '../panel.js'") && src.includes('cardTitle(')) &&
      !defs60.some(([, src]) => /title: `/.test(src)),
    defs60.filter(([, src]) => !src.includes('cardTitle(')).map(([n]) => n).join(',') || '全部改完',
  )
  check(
    'card: 连线的动作键换成中文名，path 标成只读',
    /const LINK_ACTION_LABELS = \{/.test(linkSrc60) &&
      ['连一条手工线', '断开手工线', '屏蔽自动关联', '撤销屏蔽', '看证据链'].every((s) => linkSrc60.includes(s)) &&
      /kind: act\.name === 'path' \? 'read' : 'write'/.test(linkSrc60) &&
      !linkSrc60.includes('星图连线：${'),
    'link-card',
  )
  check(
    'card: 检索模式换成中文名，模式写错时说「模式名没对上」',
    /const MODE_LABELS = \{ local: '本地检索', graph: '沿关联扩散', bridge: '补邻居', similar: '相似条目' \}/.test(searchSrc60) &&
      searchSrc60.includes("mode.bad ? '模式名没对上'") &&
      !searchSrc60.includes('检索记忆：${'),
    'search-card',
  )
  check(
    'card: 运维面板的未知动作给中文名，也不许把键当面板名贴上去（0.2.70 起前缀不再塞品牌）',
    /cardTitle\('未知动作', shown\)/.test(adminSrc60) &&
      adminSrc60.includes('const spec = ACTIONS[shown]') &&
      !adminSrc60.includes('cardTitle(panelBrand'),
    'admin-card',
  )
  check(
    'card: 探针在真工具面上钉住十个标题事实（AQ1–AQ10）',
    ['AQ1', 'AQ2', 'AQ3', 'AQ4', 'AQ5', 'AQ6', 'AQ7', 'AQ8', 'AQ9', 'AQ10'].every((n) => fusionSrc60.includes(`'${n} `)),
    'probe-fusion',
  )
  const v60 = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version.split('.').map(Number)
  check('card: 版本不早于 0.2.60', v60[0] === 0 && v60[1] === 2 && v60[2] >= 60, v60.join('.'))
  check(
    'card: README 与 DESIGN 记了这一轮（卡片标题也是口径）',
    readFileSync(join(root, 'docs', 'INTERNAL.md'), 'utf8').includes('0.2.60') &&
      readFileSync(join(root, 'docs', 'INTERNAL.md'), 'utf8').includes('cardTitle') &&
      readFileSync(join(root, 'DESIGN.md'), 'utf8').includes('0.2.60') &&
      readFileSync(join(root, 'DESIGN.md'), 'utf8').includes('悬空冒号'),
    '文档',
  )
}

// A58. 面板条数：给 0 就照办 0，改了就说话（0.2.61）
{
  const panelSrc61 = readFileSync(join(root, 'lib', 'macro', 'panel.js'), 'utf8')
  const adminSrc61 = readFileSync(join(root, 'lib', 'macro', 'defs', 'admin.js'), 'utf8')
  const sharedSrc62 = readFileSync(join(root, 'lib', 'macro', 'shared.js'), 'utf8')
  const readDefSrc62 = readFileSync(join(root, 'lib', 'macro', 'defs', 'read.js'), 'utf8')
  const promptSrc63 = readFileSync(join(root, 'lib', 'macro', 'prompt.js'), 'utf8')
  const costSrc61 = readFileSync(join(root, 'lib', 'macro', 'cost.js'), 'utf8')
  const linksSrc61 = readFileSync(join(root, 'lib', 'macro', 'links.js'), 'utf8')
  const fusionSrc61 = readFileSync(join(root, 'tools', 'probe-fusion.mjs'), 'utf8')
  check(
    'limit: 条数只有一条出口，四种输入各带一句话（0 照办、负数/非数字回默认、非整数抹小数）',
    /export function limitOf\(spec, args\) \{/.test(panelSrc61) &&
      panelSrc61.includes("return { value: fallback, note: '' }") &&
      panelSrc61.includes('不是数字——这次按默认 ${fallback} 条算') &&
      panelSrc61.includes('是负数——条数没有「从后往前数」这回事') &&
      panelSrc61.includes('limit 给的是 0，这次一条都不列') &&
      panelSrc61.includes('条数只能是整数，这次按 ${whole} 条算') &&
      panelSrc61.includes('return { value: whole, note: ') &&
      !panelSrc61.includes('n > 0 ? Math.floor(n) : fallback'),
    'limitOf',
  )
  check(
    'limit: 两张面板都把 note 拼进抬头（没有 note 时不多一个字）',
    adminSrc61.includes('const lim = limitOf(ACTIONS.cost, args)') &&
      adminSrc61.includes('const lim = limitOf(ACTIONS.links, args)') &&
      adminSrc61.includes('const c = readCost(lim.value)') &&
      adminSrc61.includes('[c.scope, lim.note].filter(Boolean).join') &&
      adminSrc61.includes('[`最多列 ${lim.value} 条`, cap, lim.note].filter(Boolean).join'),
    'admin',
  )
  check(
    'limit: 成本账本 0 支：slice(-0) 不再把整本账当「不列」',
    costSrc61.includes('n <= 0') &&
      costSrc61.includes('这次一条都不列（账本里其实有 ${detail.lines} 行') &&
      /detail\.entries\.slice\(-n\)/.test(costSrc61),
    'cost',
  )
  check(
    'limit: 待补连线 0 支：不列也要说清队列里有多少',
    linksSrc61.includes('cap <= 0') &&
      linksSrc61.includes('这次一条都不列（队列里其实有 ${list.length} 条') &&
      /list\.slice\(0, cap\)/.test(linksSrc61),
    'links',
  )
  const criteria61 = await import(pathToFileURL(join(root, 'tools', 'criteria.mjs')).href)
  const contract61 = await import(pathToFileURL(join(root, 'lib', 'macro', 'contract.js')).href)
  const read61 = (p) => readFileSync(join(root, p), 'utf8')
  const list61 = criteria61.contractChecklist({
    contractSrc: read61(join('lib', 'macro', 'contract.js')),
    sources: {
      'links.js': linksSrc61,
      'bridge.js': read61(join('lib', 'macro', 'bridge.js')),
      'linkflow.js': read61(join('lib', 'macro', 'linkflow.js')),
      'defs/link.js': read61(join('lib', 'macro', 'defs', 'link.js')),
      'defs/search.js': read61(join('lib', 'macro', 'defs', 'search.js')),
      'store.js': read61(join('lib', 'macro', 'store.js')),
      'cost.js': costSrc61,
      'panel.js': panelSrc61,
      'defs/admin.js': adminSrc61,
      'shared.js': sharedSrc62,
      'defs/read.js': readDefSrc62,
      'prompt.js': promptSrc63,
    },
    runtime: contract61,
    nebIndexSrc: read61(join('vendor', 'dsh-memory-nebula', 'lib', 'index.js')),
    nebCoreSrc: read61(join('vendor', 'dsh-memory-nebula', 'lib', 'host', 'nebula.js')),
    meowIndexSrc: read61(join('vendor', 'meow-memory', 'lib', 'index.js')),
  })
  const mine61 = list61.find((c) => c.id === 'admin-limit-zero')
  check('limit: 判据清单里有 admin-limit-zero，且整张清单仍全绿（四十五条）', list61.length === 45 && mine61?.ok === true && list61.every((c) => c.ok), mine61?.detail ?? '缺这一条')
  const st61 = criteria61.selfTestContract()
  check('limit: 这条判据自测过能被打红（不是恒真）', st61.baseline.length === 0 && st61.survived.length === 0, `样板红 ${st61.baseline.join('/') || '无'} / 打不红 ${st61.survived.join('/') || '无'}`)
  check(
    'limit: 探针在真工具面上钉住七个条数事实（AR1–AR7）',
    ['AR1', 'AR2', 'AR3', 'AR4', 'AR5', 'AR6', 'AR7'].every((n) => fusionSrc61.includes(`'${n} `)),
    'probe-fusion',
  )
  const v61 = JSON.parse(read61('package.json')).version.split('.').map(Number)
  check('limit: 版本不早于 0.2.61', v61[0] === 0 && v61[1] === 2 && v61[2] >= 61, v61.join('.'))
  check(
    'limit: README 与 DESIGN 记了这一轮（条数也是条件）',
    read61('docs/INTERNAL.md').includes('0.2.61') && read61('docs/INTERNAL.md').includes('limitOf') && read61('DESIGN.md').includes('0.2.61') && read61('DESIGN.md').includes('slice(-0)'),
    '文档',
  )
}

// ── A59：读记忆的 neighbors 给错要说出口（0.2.62）────────────────────────────
{
  const sharedSrc62b = readFileSync(join(root, 'lib', 'macro', 'shared.js'), 'utf8')
  const readDefSrc62b = readFileSync(join(root, 'lib', 'macro', 'defs', 'read.js'), 'utf8')
  const fusionSrc62 = readFileSync(join(root, 'tools', 'probe-fusion.mjs'), 'utf8')
  check(
    'nb: 条数只有一个出口 countParam()，四种输入各带一句话（0 照办、负数/非数字回默认、小数抹掉、超界夹住）',
    /export function countParam\(name, raw, \{ min = 0, max = Number\.POSITIVE_INFINITY, def \} = \{\}\)/.test(sharedSrc62b) &&
      sharedSrc62b.includes("if (raw === undefined || raw === null) return { value: def, note: '' }") &&
      sharedSrc62b.includes('不是数字——这次按默认 ${def} 条算') &&
      sharedSrc62b.includes('是负数——条数没有「从后往前数」这回事') &&
      sharedSrc62b.includes("if (n === 0) return { value: 0, note: '' }") &&
      sharedSrc62b.includes('少掉的那半条不是你给的条件') &&
      sharedSrc62b.includes('结果是被改过的条件算出来的'),
    'countParam',
  )
  check(
    'nb: 读记忆走 countParam，不再用「不是有限数就 return」把三种情况压成一种',
    readDefSrc62b.includes("countParam('neighbors', args.neighbors, { min: 0, max: 40, def: 12 })") &&
      /if \(nb\.value <= 0\) return nb\.note\.length > 0/.test(readDefSrc62b) &&
      /neighbors: nb\.value/.test(readDefSrc62b) &&
      !/const want = args\.neighbors === undefined/.test(readDefSrc62b) &&
      !/!Number\.isFinite\(want\)/.test(readDefSrc62b),
    'defs/read.js',
  )
  check(
    'nb: 说明接在回执末尾（有邻居段就接在段后），不顶掉正文',
    /const section = neighborSection\(inspect\.text\)/.test(readDefSrc62b) &&
      /\[said, section, gap, nb\.note\]\.filter\(Boolean\)\.join\('\\n\\n'\)/.test(readDefSrc62b) &&
      !/const base = section \?/.test(readDefSrc62b),
    'note 拼接',
  )
  const criteria62 = await import(pathToFileURL(join(root, 'tools', 'criteria.mjs')).href)
  const contract62 = await import(pathToFileURL(join(root, 'lib', 'macro', 'contract.js')).href)
  const read62 = (p) => readFileSync(join(root, p), 'utf8')
  const list62 = criteria62.contractChecklist({
    contractSrc: read62(join('lib', 'macro', 'contract.js')),
    sources: {
      'links.js': read62(join('lib', 'macro', 'links.js')),
      'bridge.js': read62(join('lib', 'macro', 'bridge.js')),
      'linkflow.js': read62(join('lib', 'macro', 'linkflow.js')),
      'defs/link.js': read62(join('lib', 'macro', 'defs', 'link.js')),
      'defs/search.js': read62(join('lib', 'macro', 'defs', 'search.js')),
      'store.js': read62(join('lib', 'macro', 'store.js')),
      'cost.js': read62(join('lib', 'macro', 'cost.js')),
      'panel.js': read62(join('lib', 'macro', 'panel.js')),
      'defs/admin.js': read62(join('lib', 'macro', 'defs', 'admin.js')),
      'shared.js': sharedSrc62b,
      'defs/read.js': readDefSrc62b,
      'prompt.js': read62(join('lib', 'macro', 'prompt.js')),
    },
    runtime: contract62,
    nebIndexSrc: read62(join('vendor', 'dsh-memory-nebula', 'lib', 'index.js')),
    nebCoreSrc: read62(join('vendor', 'dsh-memory-nebula', 'lib', 'host', 'nebula.js')),
    meowIndexSrc: read62(join('vendor', 'meow-memory', 'lib', 'index.js')),
  })
  const mine62 = list62.find((c) => c.id === 'read-neighbors-param')
  check(
    'nb: 判据清单里有 read-neighbors-param，且整张清单仍全绿（四十五条）',
    list62.length === 45 && mine62?.ok === true && list62.every((c) => c.ok),
    mine62?.detail ?? '缺这一条',
  )
  const st62 = criteria62.selfTestContract()
  check('nb: 这条判据自测过能被打红（不是恒真）', st62.baseline.length === 0 && st62.survived.length === 0, `样板红 ${st62.baseline.join('/') || '无'} / 打不红 ${st62.survived.join('/') || '无'}`)
  check(
    'nb: 探针在真工具面上钉住十条邻居事实（AS1–AS10）',
    ['AS1', 'AS2', 'AS3', 'AS4', 'AS5', 'AS6', 'AS7', 'AS8', 'AS9', 'AS10'].every((n) => fusionSrc62.includes(`'${n} `)),
    'probe-fusion',
  )
  const v62 = JSON.parse(read62('package.json')).version.split('.').map(Number)
  check('nb: 版本不早于 0.2.62', v62[0] === 0 && v62[1] === 2 && v62[2] >= 62, v62.join('.'))
  check(
    'nb: README 与 DESIGN 记了这一轮（邻居条数也是条件）',
    read62('docs/INTERNAL.md').includes('0.2.62') && read62('docs/INTERNAL.md').includes('countParam') && read62('DESIGN.md').includes('0.2.62') && read62('DESIGN.md').includes('没有邻居'),
    '文档',
  )
}

// ── A60：注入上限写坏不许变成「零字注入」（0.2.63）──────────────────────────
{
  const promptSrc63 = readFileSync(join(root, 'lib', 'macro', 'prompt.js'), 'utf8')
  const indexSrc63 = readFileSync(join(root, 'lib', 'index.js'), 'utf8')
  const adminSrc63 = readFileSync(join(root, 'lib', 'macro', 'defs', 'admin.js'), 'utf8')
  const fusionSrc63 = readFileSync(join(root, 'tools', 'probe-fusion.mjs'), 'utf8')
  check(
    'budget: 注入上限只有一个出口 guideBudget()，六种输入各带一句话（写坏回默认、0 才照办 0）',
    /export function guideBudget\(raw\) \{/.test(promptSrc63) &&
      promptSrc63.includes("if (raw === undefined || raw === null || raw === '') return { value: GUIDE_MAX_CHARS, note: '' }") &&
      promptSrc63.includes('不是数字——这次按默认 ${GUIDE_MAX_CHARS} 字算') &&
      promptSrc63.includes('是负数——上限没有「从后往前数」这回事') &&
      promptSrc63.includes('一个字都不注入') &&
      promptSrc63.includes('少掉的那半字不是你给的条件') &&
      promptSrc63.includes('尾巴都放不下') &&
      /const cap = guideBudget\(maxChars\)\.value/.test(promptSrc63) &&
      !/Math\.max\(0, Number\(maxChars\)/.test(promptSrc63),
    'prompt.js',
  )
  check(
    'budget: 装上注入前先过出口，被改过就 warn 一句（不是悄悄换个上限）',
    indexSrc63.includes('const budget = guideBudget(macro.guideMaxChars)') &&
      /if \(budget\.note\) logger\?\.warn\?\.\(/.test(indexSrc63) &&
      /const text = clampGuide\(GUIDE_TEXT, budget\.value\)/.test(indexSrc63),
    'lib/index.js',
  )
  check(
    'budget: 手册末尾带一行「L0 注入：现在 N/M 字」，写坏时那句话一起带出来',
    adminSrc63.includes('const budget = guideBudget(config.guideMaxChars)') &&
      adminSrc63.includes('const fit = clampGuide(GUIDE_TEXT, budget.value).length') &&
      adminSrc63.includes('L0 注入：现在 ${fit}/${budget.value} 字'),
    'defs/admin.js',
  )
  const criteria63 = await import(pathToFileURL(join(root, 'tools', 'criteria.mjs')).href)
  const contract63 = await import(pathToFileURL(join(root, 'lib', 'macro', 'contract.js')).href)
  const read63 = (p) => readFileSync(join(root, p), 'utf8')
  const list63 = criteria63.contractChecklist({
    contractSrc: read63(join('lib', 'macro', 'contract.js')),
    sources: {
      'links.js': read63(join('lib', 'macro', 'links.js')),
      'bridge.js': read63(join('lib', 'macro', 'bridge.js')),
      'linkflow.js': read63(join('lib', 'macro', 'linkflow.js')),
      'defs/link.js': read63(join('lib', 'macro', 'defs', 'link.js')),
      'defs/search.js': read63(join('lib', 'macro', 'defs', 'search.js')),
      'store.js': read63(join('lib', 'macro', 'store.js')),
      'cost.js': read63(join('lib', 'macro', 'cost.js')),
      'panel.js': read63(join('lib', 'macro', 'panel.js')),
      'defs/admin.js': adminSrc63,
      'shared.js': read63(join('lib', 'macro', 'shared.js')),
      'defs/read.js': read63(join('lib', 'macro', 'defs', 'read.js')),
      'prompt.js': promptSrc63,
    },
    runtime: contract63,
    nebIndexSrc: read63(join('vendor', 'dsh-memory-nebula', 'lib', 'index.js')),
    nebCoreSrc: read63(join('vendor', 'dsh-memory-nebula', 'lib', 'host', 'nebula.js')),
    meowIndexSrc: read63(join('vendor', 'meow-memory', 'lib', 'index.js')),
  })
  const mine63 = list63.find((c) => c.id === 'guide-budget-param')
  check(
    'budget: 判据清单里有 guide-budget-param，且整张清单仍全绿（四十五条）',
    list63.length === 45 && mine63?.ok === true && list63.every((c) => c.ok),
    mine63?.detail ?? '缺这一条',
  )
  const st63 = criteria63.selfTestContract()
  check('budget: 这条判据自测过能被打红（不是恒真）', st63.baseline.length === 0 && st63.survived.length === 0, `样板红 ${st63.baseline.join('/') || '无'} / 打不红 ${st63.survived.join('/') || '无'}`)
  check(
    'budget: 探针在真函数与真工具面上钉住十一条上限事实（AT1–AT11）',
    ['AT1', 'AT2', 'AT3', 'AT4', 'AT5', 'AT6', 'AT7', 'AT8', 'AT9', 'AT10', 'AT11'].every((n) => fusionSrc63.includes(`'${n} `)),
    'probe-fusion',
  )
  const v63 = JSON.parse(read63('package.json')).version.split('.').map(Number)
  check('budget: 版本不早于 0.2.63', v63[0] === 0 && v63[1] === 2 && v63[2] >= 63, v63.join('.'))
  check(
    'budget: README 与 DESIGN 记了这一轮（注入上限也是条件）',
    read63('docs/INTERNAL.md').includes('0.2.63') && read63('docs/INTERNAL.md').includes('guideBudget') && read63('DESIGN.md').includes('0.2.63') && read63('DESIGN.md').includes('零字注入'),
    '文档',
  )
}

// ── 0.2.64：体检的类别是枚举（给错不许打成「这一类是 0」）────────────────
{
  const adminSrc64 = readFileSync(join(root, 'lib', 'macro', 'defs', 'admin.js'), 'utf8')
  const nebIndex64 = readFileSync(join(root, 'vendor', 'dsh-memory-nebula', 'lib', 'index.js'), 'utf8')
  const fusionSrc64 = readFileSync(join(root, 'tools', 'probe-fusion.mjs'), 'utf8')
  check(
    'hyg: 体检的类别按白名单守，不认识的当场说清「没跑」',
    adminSrc64.includes("const HYGIENE_KINDS = ['dup', 'stale', 'thin', 'oversize', 'unread', 'orphan']") &&
      /function guardHygiene\(args\)/.test(adminSrc64) &&
      /const name = raw\.trim\(\)\.toLowerCase\(\)/.test(adminSrc64) &&
      adminSrc64.includes('if (!HYGIENE_KINDS.includes(name)) {') &&
      adminSrc64.includes('throw new Error(') &&
      adminSrc64.includes('这次体检没有跑') &&
      adminSrc64.includes('别把「没跑」读成「这一类没有问题」'),
    'defs/admin.js',
  )
  check(
    'hyg: 归一后写回 args.kind，并且挂在表上（分发不认具体 action 名）',
    /args\.kind = name/.test(adminSrc64) && adminSrc64.includes('guard: guardHygiene'),
    'defs/admin.js',
  )
  check(
    'hyg: 空串＝没给（与缺省同义），不报错也不塞一个空类别下去',
    adminSrc64.includes("if (name === '') return"),
    'defs/admin.js',
  )
  check(
    'hyg: 星图那层不再把不认识的类别打成「undefined（0）」',
    nebIndex64.includes('const labelOf = (k) => NAME[k] ?? String(k)') &&
      nebIndex64.includes('${labelOf(k)}（0）') &&
      !/\$\{NAME\[k\]\}（0）/.test(nebIndex64),
    'vendor/dsh-memory-nebula/lib/index.js',
  )
  const criteria64 = await import(pathToFileURL(join(root, 'tools', 'criteria.mjs')).href)
  const contract64 = await import(pathToFileURL(join(root, 'lib', 'macro', 'contract.js')).href)
  const read64 = (p) => readFileSync(join(root, p), 'utf8')
  const list64 = criteria64.contractChecklist({
    contractSrc: read64(join('lib', 'macro', 'contract.js')),
    sources: {
      'links.js': read64(join('lib', 'macro', 'links.js')),
      'bridge.js': read64(join('lib', 'macro', 'bridge.js')),
      'linkflow.js': read64(join('lib', 'macro', 'linkflow.js')),
      'defs/link.js': read64(join('lib', 'macro', 'defs', 'link.js')),
      'defs/search.js': read64(join('lib', 'macro', 'defs', 'search.js')),
      'store.js': read64(join('lib', 'macro', 'store.js')),
      'cost.js': read64(join('lib', 'macro', 'cost.js')),
      'panel.js': read64(join('lib', 'macro', 'panel.js')),
      'defs/admin.js': adminSrc64,
      'shared.js': read64(join('lib', 'macro', 'shared.js')),
      'defs/read.js': read64(join('lib', 'macro', 'defs', 'read.js')),
      'prompt.js': read64(join('lib', 'macro', 'prompt.js')),
    },
    runtime: contract64,
    nebIndexSrc: nebIndex64,
    nebCoreSrc: read64(join('vendor', 'dsh-memory-nebula', 'lib', 'host', 'nebula.js')),
    meowIndexSrc: read64(join('vendor', 'meow-memory', 'lib', 'index.js')),
  })
  const mine64 = list64.find((c) => c.id === 'admin-hygiene-kind')
  check(
    'hyg: 判据清单里有 admin-hygiene-kind，且整张清单仍全绿（四十五条）',
    list64.length === 45 && mine64?.ok === true && list64.every((c) => c.ok),
    mine64?.detail ?? '缺这一条',
  )
  const st64 = criteria64.selfTestContract()
  check(
    'hyg: 这条判据自测过能被打红（不是恒真）',
    st64.baseline.length === 0 && st64.survived.length === 0,
    `样板红 ${st64.baseline.join('/') || '无'} / 打不红 ${st64.survived.join('/') || '无'}`,
  )
  check(
    'hyg: 探针在真工具面上钉住八条类别事实（AU1–AU8）',
    ['AU1', 'AU2', 'AU3', 'AU4', 'AU5', 'AU6', 'AU7', 'AU8'].every((n) => fusionSrc64.includes(`'${n} `)),
    'probe-fusion',
  )
  const v64 = JSON.parse(read64('package.json')).version.split('.').map(Number)
  check('hyg: 版本不早于 0.2.64', v64[0] === 0 && v64[1] === 2 && v64[2] >= 64, v64.join('.'))
  check(
    'hyg: README 与 DESIGN 记了这一轮（体检的类别也是条件）',
    read64('docs/INTERNAL.md').includes('0.2.64') &&
      read64('docs/INTERNAL.md').includes('guardHygiene') &&
      read64('DESIGN.md').includes('0.2.64') &&
      read64('DESIGN.md').includes('这一类是 0'),
    '文档',
  )
}

// ── 0.2.65：检索尾注不许撒谎（local 扩散真读了 limit / hops 却说「没用上」）──
{
  const searchSrc65 = readFileSync(join(root, 'lib', 'macro', 'defs', 'search.js'), 'utf8')
  const fusionSrc65 = readFileSync(join(root, 'tools', 'probe-fusion.mjs'), 'utf8')
  check(
    'lim: local 模式的三态尾注（真扩散 / 本要扩散但没接上 / 根本没扩散）都在',
    /function modeNotes\(mode, args, flags = \{\}\)/.test(searchSrc65) &&
      searchSrc65.includes('const spread = flags.spread === true') &&
      searchSrc65.includes('const tried = flags.spreadTried === true && !spread') &&
      searchSrc65.includes('这次扩散真的用了它（limit=${flags.spreadLimit}）') &&
      searchSrc65.includes('这次本来要扩散（会用 limit=${flags.spreadLimit}），但星图没接上') &&
      searchSrc65.includes('这次没有扩散，limit 没用上'),
    'defs/search.js',
  )
  check(
    'lim: 扩散用的是 args 原值（limit=0 也照递），不是悄悄换回默认',
    searchSrc65.includes('const spreadLimit = args.limit ?? 5') &&
      searchSrc65.includes('const spreadHops = args.hops ?? 2') &&
      searchSrc65.includes('limit: spreadLimit, hops: spreadHops') &&
      /if \(spread\.entry\) flags\.spread = true/.test(searchSrc65),
    'defs/search.js',
  )
  check(
    'lim: 尾注不再对所有 local 检索一律说「没用上 limit」',
    !searchSrc65.includes('limit 只在 graph / bridge 模式生效'),
    'defs/search.js',
  )
  const criteria65 = await import(pathToFileURL(join(root, 'tools', 'criteria.mjs')).href)
  const contract65 = await import(pathToFileURL(join(root, 'lib', 'macro', 'contract.js')).href)
  const read65 = (p) => readFileSync(join(root, p), 'utf8')
  const list65 = criteria65.contractChecklist({
    contractSrc: read65(join('lib', 'macro', 'contract.js')),
    sources: {
      'links.js': read65(join('lib', 'macro', 'links.js')),
      'bridge.js': read65(join('lib', 'macro', 'bridge.js')),
      'linkflow.js': read65(join('lib', 'macro', 'linkflow.js')),
      'defs/link.js': read65(join('lib', 'macro', 'defs', 'link.js')),
      'defs/search.js': read65(join('lib', 'macro', 'defs', 'search.js')),
      'store.js': read65(join('lib', 'macro', 'store.js')),
      'cost.js': read65(join('lib', 'macro', 'cost.js')),
      'panel.js': read65(join('lib', 'macro', 'panel.js')),
      'defs/admin.js': read65(join('lib', 'macro', 'defs', 'admin.js')),
      'shared.js': read65(join('lib', 'macro', 'shared.js')),
      'defs/read.js': read65(join('lib', 'macro', 'defs', 'read.js')),
      'prompt.js': read65(join('lib', 'macro', 'prompt.js')),
    },
    runtime: contract65,
    nebIndexSrc: read65(join('vendor', 'dsh-memory-nebula', 'lib', 'index.js')),
    nebCoreSrc: read65(join('vendor', 'dsh-memory-nebula', 'lib', 'host', 'nebula.js')),
    meowIndexSrc: read65(join('vendor', 'meow-memory', 'lib', 'index.js')),
  })
  const mine65 = list65.find((c) => c.id === 'search-limit-used-note')
  check(
    'lim: 判据清单里有 search-limit-used-note，且整张清单仍全绿（四十五条）',
    list65.length === 45 && mine65?.ok === true && list65.every((c) => c.ok),
    mine65?.detail ?? '缺这一条',
  )
  const st65 = criteria65.selfTestContract()
  check(
    'lim: 这条判据自测过能被打红（不是恒真）',
    st65.baseline.length === 0 && st65.survived.length === 0,
    `样板红 ${st65.baseline.join('/') || '无'} / 打不红 ${st65.survived.join('/') || '无'}`,
  )
  check(
    'lim: 探针在真工具面上钉住九条尾注事实（AV1–AV9）',
    ['AV1', 'AV2', 'AV3', 'AV4', 'AV5', 'AV6', 'AV7', 'AV8', 'AV9'].every((n) => fusionSrc65.includes(`'${n} `)),
    'probe-fusion',
  )
  const v65 = JSON.parse(read65('package.json')).version.split('.').map(Number)
  check('lim: 版本不早于 0.2.65', v65[0] === 0 && v65[1] === 2 && v65[2] >= 65, v65.join('.'))
  check(
    'lim: README 与 DESIGN 记了这一轮（尾注不许撒谎）',
    read65('docs/INTERNAL.md').includes('0.2.65') &&
      read65('docs/INTERNAL.md').includes('modeNotes') &&
      read65('DESIGN.md').includes('0.2.65') &&
      read65('DESIGN.md').includes('没用上 limit'),
    '文档',
  )
}

// ── A66. 同一组参数在两条路径上一进一出（0.2.66）──────────────────────────
// graph / bridge 走星图时，project / level / days / k 这些本地条件被丢掉；
// 星图没接上（或图还是空的）时这一问退到本地检索，同一批条件又真的生效了。
// 老尾注只有一句「k 是本地检索的条数…这次按 N 条算」——退路那条分支上它说反话。
{
  const read66 = (p) => readFileSync(join(root, p), 'utf8')
  const searchSrc66 = read66(join('lib', 'macro', 'defs', 'search.js'))
  check(
    'fb: 本地条件分两条路径说话：走星图说「只在本地检索生效」，退本地检索说「它们真的用上了」',
    searchSrc66.includes('只在本地检索生效') &&
      searchSrc66.includes('它们真的用上了——但结果不是星图给的'),
    'defs/search.js',
  )
  check(
    'fb: 三种处境各有一句（走星图没用到 / 星图没接上压根没算 / 退到本地真用上了）',
    searchSrc66.includes('k 是本地检索的条数') &&
      searchSrc66.includes('k 这次没参与') &&
      searchSrc66.includes('k 这次真的用上了'),
    'defs/search.js',
  )
  check(
    'fb: 两条退路（星图缺席 / 图是空的）都置了 flag，尾注才有依据',
    searchSrc66.split('flags.graphFellBack = true').length - 1 === 2 &&
      searchSrc66.split('flags.graphAbsentNoLocal = true').length - 1 === 2 &&
      searchSrc66.includes("const LOCAL_ONLY_PARAMS = ['level', 'project', 'status', 'days', 'content_max', 'explain']"),
    'defs/search.js',
  )
  const criteria66 = await import(pathToFileURL(join(root, 'tools', 'criteria.mjs')).href)
  const contract66 = await import(pathToFileURL(join(root, 'lib', 'macro', 'contract.js')).href)
  const list66 = criteria66.contractChecklist({
    contractSrc: read66(join('lib', 'macro', 'contract.js')),
    sources: {
      'links.js': read66(join('lib', 'macro', 'links.js')),
      'bridge.js': read66(join('lib', 'macro', 'bridge.js')),
      'linkflow.js': read66(join('lib', 'macro', 'linkflow.js')),
      'defs/link.js': read66(join('lib', 'macro', 'defs', 'link.js')),
      'defs/search.js': read66(join('lib', 'macro', 'defs', 'search.js')),
      'store.js': read66(join('lib', 'macro', 'store.js')),
      'cost.js': read66(join('lib', 'macro', 'cost.js')),
      'panel.js': read66(join('lib', 'macro', 'panel.js')),
      'defs/admin.js': read66(join('lib', 'macro', 'defs', 'admin.js')),
      'shared.js': read66(join('lib', 'macro', 'shared.js')),
      'defs/read.js': read66(join('lib', 'macro', 'defs', 'read.js')),
      'prompt.js': read66(join('lib', 'macro', 'prompt.js')),
    },
    runtime: contract66,
    nebIndexSrc: read66(join('vendor', 'dsh-memory-nebula', 'lib', 'index.js')),
    nebCoreSrc: read66(join('vendor', 'dsh-memory-nebula', 'lib', 'host', 'nebula.js')),
    meowIndexSrc: read66(join('vendor', 'meow-memory', 'lib', 'index.js')),
  })
  const mine66 = list66.find((c) => c.id === 'graph-fallback-param-note')
  check(
    'fb: 判据清单里有 graph-fallback-param-note，且整张清单仍全绿（四十五条）',
    list66.length === 45 && mine66?.ok === true && list66.every((c) => c.ok),
    mine66?.detail ?? '缺这一条',
  )
  const st66 = criteria66.selfTestContract()
  check(
    'fb: 这条判据自测过能被打红（不是恒真）',
    st66.baseline.length === 0 && st66.survived.length === 0,
    `样板红 ${st66.baseline.join('/') || '无'} / 打不红 ${st66.survived.join('/') || '无'}`,
  )
  const fusionSrc66 = read66(join('tools', 'probe-fusion.mjs'))
  check(
    'fb: 探针在真工具面上钉住九条路径事实（AW1–AW9）',
    ['AW1', 'AW2', 'AW3', 'AW4', 'AW5', 'AW6', 'AW7', 'AW8', 'AW9'].every((n) => fusionSrc66.includes(`'${n} `)),
    'probe-fusion',
  )
  const v66 = JSON.parse(read66('package.json')).version.split('.').map(Number)
  check('fb: 版本不早于 0.2.66', v66[0] === 0 && v66[1] === 2 && v66[2] >= 66, v66.join('.'))
  check(
    'fb: README 与 DESIGN 记了这一轮（同一组参数两条路径）',
    read66('docs/INTERNAL.md').includes('0.2.66') &&
      read66('docs/INTERNAL.md').includes('LOCAL_ONLY_PARAMS') &&
      read66('DESIGN.md').includes('0.2.66') &&
      read66('DESIGN.md').includes('退到本地检索'),
    '文档',
  )
}

// ── A67. 相似模式是第三张表：它只认 id / k / content_max（0.2.67）──────────
// graph / bridge 那一族说了两轮（0.2.65 的 limit / hops、0.2.66 的本地条件），
// 相似检索这张表还只剩一句 limit——query（读者以为在按句子找）、level / project /
// status / days / explain、hops、memory_ids 全被丢掉且一声不吭。
{
  const read67 = (p) => readFileSync(join(root, p), 'utf8')
  const searchSrc67 = read67(join('lib', 'macro', 'defs', 'search.js'))
  check(
    'sim: 相似模式给了 query 必须说话：这一问是拿 id 去比，不是按句子找',
    searchSrc67.includes('query 在相似模式没用上') &&
      searchSrc67.includes('不是按你说的句子找') &&
      searchSrc67.includes('相似检索只认 id / k / content_max'),
    'defs/search.js',
  )
  check(
    'sim: 本地条件在相似模式里被丢掉时说清「这不是没有相似，是压根没算」',
    searchSrc67.includes('是本地检索的条件；相似检索只认 id / k / content_max') &&
      searchSrc67.includes('这不是「没有相似」，是这几个条件压根没算'),
    'defs/search.js',
  )
  check(
    'sim: hops / memory_ids 也各有一句，不许留沉默',
    searchSrc67.includes('相似检索不扩散，这次没用上') &&
      searchSrc67.includes('相似检索只看 id 指向的那一条，这次没用上'),
    'defs/search.js',
  )
  check(
    'sim: content_max 是相似检索认的参数，不许被打进「没用上」',
    searchSrc67.includes("const similarIgnored = LOCAL_ONLY_PARAMS.filter((n) => n !== 'content_max' && args[n] !== undefined)") &&
      !searchSrc67.includes('content_max 是本地检索的条件'),
    'defs/search.js',
  )
  const criteria67 = await import(pathToFileURL(join(root, 'tools', 'criteria.mjs')).href)
  const contract67 = await import(pathToFileURL(join(root, 'lib', 'macro', 'contract.js')).href)
  const list67 = criteria67.contractChecklist({
    contractSrc: read67(join('lib', 'macro', 'contract.js')),
    sources: {
      'links.js': read67(join('lib', 'macro', 'links.js')),
      'bridge.js': read67(join('lib', 'macro', 'bridge.js')),
      'linkflow.js': read67(join('lib', 'macro', 'linkflow.js')),
      'defs/link.js': read67(join('lib', 'macro', 'defs', 'link.js')),
      'defs/search.js': searchSrc67,
      'store.js': read67(join('lib', 'macro', 'store.js')),
      'cost.js': read67(join('lib', 'macro', 'cost.js')),
      'panel.js': read67(join('lib', 'macro', 'panel.js')),
      'defs/admin.js': read67(join('lib', 'macro', 'defs', 'admin.js')),
      'shared.js': read67(join('lib', 'macro', 'shared.js')),
      'defs/read.js': read67(join('lib', 'macro', 'defs', 'read.js')),
      'prompt.js': read67(join('lib', 'macro', 'prompt.js')),
    },
    runtime: contract67,
    nebIndexSrc: read67(join('vendor', 'dsh-memory-nebula', 'lib', 'index.js')),
    nebCoreSrc: read67(join('vendor', 'dsh-memory-nebula', 'lib', 'host', 'nebula.js')),
    meowIndexSrc: read67(join('vendor', 'meow-memory', 'lib', 'index.js')),
  })
  const mine67 = list67.find((c) => c.id === 'similar-mode-param-note')
  check(
    'sim: 判据清单里有 similar-mode-param-note，且整张清单仍全绿（四十五条）',
    list67.length === 45 && mine67?.ok === true && list67.every((c) => c.ok),
    mine67?.detail ?? '缺这一条',
  )
  const st67 = criteria67.selfTestContract()
  check(
    'sim: 这条判据自测过能被打红（不是恒真）',
    st67.baseline.length === 0 && st67.survived.length === 0,
    `样板红 ${st67.baseline.join('/') || '无'} / 打不红 ${st67.survived.join('/') || '无'}`,
  )
  const fusionSrc67 = read67(join('tools', 'probe-fusion.mjs'))
  check(
    'sim: 探针在真工具面上钉住十条事实（AX1–AX10）',
    ['AX1', 'AX2', 'AX3', 'AX4', 'AX5', 'AX6', 'AX7', 'AX8', 'AX9', 'AX10'].every((n) => fusionSrc67.includes(`'${n} `)),
    'probe-fusion',
  )
  const v67 = JSON.parse(read67('package.json')).version.split('.').map(Number)
  check('sim: 版本不早于 0.2.67', v67[0] === 0 && v67[1] === 2 && v67[2] >= 67, v67.join('.'))
  check(
    'sim: README 与 DESIGN 记了这一轮（相似模式只认三个参数）',
    read67('docs/INTERNAL.md').includes('0.2.67') &&
      read67('docs/INTERNAL.md').includes('相似检索只认') &&
      read67('DESIGN.md').includes('0.2.67') &&
      read67('DESIGN.md').includes('第三张表'),
    '文档',
  )
}

// ── A68. 面板不读的参数不许悄悄消失（0.2.68）─────────────────────────────
// 八个参数对每个 action 都合法，执行时只取表里那一行列的。`pick()` 把剩下的静默丢掉，
// 于是给 cost 配 kind 会拿到一份「看起来按 dup 筛过」的账本。
{
  const read68 = (p) => readFileSync(join(root, p), 'utf8')
  const adminSrc68 = read68(join('lib', 'macro', 'defs', 'admin.js'))
  check(
    'pst: 反查表从动作表算出来（不另抄一份），尾注函数在',
    adminSrc68.includes('export const PARAM_OWNERS = (() => {') &&
      adminSrc68.includes('for (const name of spec.params ?? []) {') &&
      adminSrc68.includes('export function strayNote(action, spec, args) {'),
    'defs/admin.js',
  )
  check(
    'pst: 尾注点名「这参数归谁」，并说清这次一点没参与',
    adminSrc68.includes("(PARAM_OWNERS.get(name) ?? []).join(' / ')") &&
      adminSrc68.includes('不读${it}，这次一点没参与') &&
      adminSrc68.includes('别读成「结果已经按${it}收窄过」'),
    'defs/admin.js',
  )
  check(
    'pst: call / graph / local 三条分发都带上尾注（graph 那条还要并上体检口径那句，0.2.91）',
    adminSrc68.split('note: stray').length - 1 === 1 &&
      adminSrc68.includes("note: [ruler, stray].filter(Boolean).join(' · ')") &&
      adminSrc68.includes('[out.note, stray].filter(Boolean).join('),
    `note: stray × ${adminSrc68.split('note: stray').length - 1}`,
  )
  check(
    'pst: 手册只免抬头不免说话（末尾补一句）',
    adminSrc68.includes('spec.wrap === false') &&
      adminSrc68.includes('return extra.length > 0 ? `${text}\\n\\n${extra}` : text'),
    'defs/admin.js',
  )
  const criteria68 = await import(pathToFileURL(join(root, 'tools', 'criteria.mjs')).href)
  const contract68 = await import(pathToFileURL(join(root, 'lib', 'macro', 'contract.js')).href)
  const list68 = criteria68.contractChecklist({
    contractSrc: read68(join('lib', 'macro', 'contract.js')),
    sources: {
      'links.js': read68(join('lib', 'macro', 'links.js')),
      'bridge.js': read68(join('lib', 'macro', 'bridge.js')),
      'linkflow.js': read68(join('lib', 'macro', 'linkflow.js')),
      'defs/link.js': read68(join('lib', 'macro', 'defs', 'link.js')),
      'defs/search.js': read68(join('lib', 'macro', 'defs', 'search.js')),
      'store.js': read68(join('lib', 'macro', 'store.js')),
      'cost.js': read68(join('lib', 'macro', 'cost.js')),
      'panel.js': read68(join('lib', 'macro', 'panel.js')),
      'defs/admin.js': adminSrc68,
      'shared.js': read68(join('lib', 'macro', 'shared.js')),
      'defs/read.js': read68(join('lib', 'macro', 'defs', 'read.js')),
      'prompt.js': read68(join('lib', 'macro', 'prompt.js')),
    },
    runtime: contract68,
    nebIndexSrc: read68(join('vendor', 'dsh-memory-nebula', 'lib', 'index.js')),
    nebCoreSrc: read68(join('vendor', 'dsh-memory-nebula', 'lib', 'host', 'nebula.js')),
    meowIndexSrc: read68(join('vendor', 'meow-memory', 'lib', 'index.js')),
  })
  const mine68 = list68.find((c) => c.id === 'panel-param-owner-note')
  check(
    'pst: 判据清单里有 panel-param-owner-note，且整张清单仍全绿（四十五条）',
    list68.length === 45 && mine68?.ok === true && list68.every((c) => c.ok),
    mine68?.detail ?? '缺这一条',
  )
  const st68 = criteria68.selfTestContract()
  check(
    'pst: 这条判据自测过能被打红（不是恒真）',
    st68.baseline.length === 0 && st68.survived.length === 0,
    `样板红 ${st68.baseline.join('/') || '无'} / 打不红 ${st68.survived.join('/') || '无'}`,
  )
  const fusionSrc68 = read68(join('tools', 'probe-fusion.mjs'))
  check(
    'pst: 探针在真工具面上钉住九条面板口径（AY1–AY9）',
    ['AY1', 'AY2', 'AY3', 'AY4', 'AY5', 'AY6', 'AY7', 'AY8', 'AY9'].every((n) => fusionSrc68.includes(`'${n} `)),
    'probe-fusion',
  )
  const v68 = JSON.parse(read68('package.json')).version.split('.').map(Number)
  check('pst: 版本不早于 0.2.68', v68[0] === 0 && v68[1] === 2 && v68[2] >= 68, v68.join('.'))
  check(
    'pst: README 与 DESIGN 记了这一轮（面板不读的参数）',
    read68('docs/INTERNAL.md').includes('0.2.68') &&
      read68('docs/INTERNAL.md').includes('面板不读的参数') &&
      read68('DESIGN.md').includes('0.2.68') &&
      read68('DESIGN.md').includes('参数归属'),
    '文档',
  )
}

  // ── A69. 0.2.69：id 只在 similar 当基准、memory_ids 只在扩散当起点 ────────────
  {
    const read69 = (rel) => readFileSync(join(root, rel), 'utf8')
    const searchSrc69 = read69(join('lib', 'macro', 'defs', 'search.js'))
    check(
      'id/ids: 两句都在（id 只属于 similar、memory_ids 只在扩散时当起点）',
      searchSrc69.includes('id 只在 mode=similar 里当基准') &&
        searchSrc69.includes('memory_ids 只在扩散时当起点'),
      'defs/search.js',
    )
    check(
      'id/ids: id 那句说清「不是这条记忆被排除了」，并给出正确用法',
      searchSrc69.includes('这次没用上它——这不是「这条记忆被排除了」') && searchSrc69.includes('用 mode=similar 再问一次'),
      'defs/search.js',
    )
    check(
      'id/ids: memory_ids 三种处境分开说（真用上 / 星图没接上 / 压根没扩散）',
      searchSrc69.includes('memory_ids 这次真的用上了') &&
        searchSrc69.includes('memory_ids 平时是扩散的起点') &&
        searchSrc69.includes('这次没有扩散，它没用上'),
      'defs/search.js',
    )
    check(
      'id/ids: 两道闸都看 mode（similar 的 id、graph/bridge 的 memory_ids 不许被误报）',
      searchSrc69.includes("if (mode !== 'similar' && typeof args.id === 'string' && args.id.trim() !== '')") &&
        searchSrc69.includes("if (mode === 'local' && args.memory_ids !== undefined)"),
      'defs/search.js',
    )
    const criteria69 = await import(pathToFileURL(join(root, 'tools', 'criteria.mjs')).href)
    const contract69 = await import(pathToFileURL(join(root, 'lib', 'macro', 'contract.js')).href)
    const list69 = criteria69.contractChecklist({
      contractSrc: read69(join('lib', 'macro', 'contract.js')),
      sources: {
        'links.js': read69(join('lib', 'macro', 'links.js')),
        'bridge.js': read69(join('lib', 'macro', 'bridge.js')),
        'linkflow.js': read69(join('lib', 'macro', 'linkflow.js')),
        'defs/link.js': read69(join('lib', 'macro', 'defs', 'link.js')),
        'defs/search.js': searchSrc69,
        'store.js': read69(join('lib', 'macro', 'store.js')),
        'cost.js': read69(join('lib', 'macro', 'cost.js')),
        'panel.js': read69(join('lib', 'macro', 'panel.js')),
        'defs/admin.js': read69(join('lib', 'macro', 'defs', 'admin.js')),
        'shared.js': read69(join('lib', 'macro', 'shared.js')),
        'defs/read.js': read69(join('lib', 'macro', 'defs', 'read.js')),
        'prompt.js': read69(join('lib', 'macro', 'prompt.js')),
      },
      runtime: contract69,
      nebIndexSrc: read69(join('vendor', 'dsh-memory-nebula', 'lib', 'index.js')),
      nebCoreSrc: read69(join('vendor', 'dsh-memory-nebula', 'lib', 'host', 'nebula.js')),
      meowIndexSrc: read69(join('vendor', 'meow-memory', 'lib', 'index.js')),
    })
    const mine69 = list69.find((c) => c.id === 'search-id-memoryids-note')
    check(
      'id/ids: 判据清单里有 search-id-memoryids-note，且整张清单仍全绿（四十五条）',
      list69.length === 45 && mine69?.ok === true && list69.every((c) => c.ok),
      mine69?.detail ?? '缺这一条',
    )
    const st69 = criteria69.selfTestContract()
    check(
      'id/ids: 这条判据自测过能被打红（不是恒真）',
      st69.baseline.length === 0 && st69.survived.length === 0,
      `样板红 ${st69.baseline.join('/') || '无'} / 打不红 ${st69.survived.join('/') || '无'}`,
    )
    const fusionSrc69 = read69(join('tools', 'probe-fusion.mjs'))
    check(
      'id/ids: 探针在真工具面上钉住八条（AZ1–AZ8）',
      ['AZ1', 'AZ2', 'AZ3', 'AZ4', 'AZ5', 'AZ6', 'AZ7', 'AZ8'].every((n) => fusionSrc69.includes(`'${n} `)),
      'probe-fusion',
    )
    const v69 = JSON.parse(read69('package.json')).version.split('.').map(Number)
    check('id/ids: 版本不早于 0.2.69', v69[0] === 0 && v69[1] === 2 && v69[2] >= 69, v69.join('.'))
    check(
      'id/ids: README 与 DESIGN 记了这一轮',
      read69('docs/INTERNAL.md').includes('0.2.69') &&
        read69('docs/INTERNAL.md').includes('id 只在 mode=similar') &&
        read69('DESIGN.md').includes('0.2.69') &&
        read69('DESIGN.md').includes('memory_ids'),
      '文档',
    )
  }

  {
    const read70 = (x) => readFileSync(join(root, x), 'utf8')
    const adminSrc70 = read70(join('lib', 'macro', 'defs', 'admin.js'))
    const panelSrc70 = read70(join('lib', 'macro', 'panel.js'))
    check(
      'card: 卡片细节按参数归属表列这一轮真给了的值',
      adminSrc70.includes('export function cardDetail(args) {') &&
        adminSrc70.includes('for (const name of PARAM_OWNERS.keys()) {'),
      'cardDetail',
    )
    check(
      'card: 数组说条数，长内容压一行，没给的不进卡片',
      adminSrc70.includes('${name}=${v.length} 条') &&
        adminSrc70.includes('JSON.stringify') &&
        adminSrc70.includes("parts.join(' ')"),
      'cardDetail',
    )
    check(
      'card: 前缀只放面板中文名，不再塞品牌（0.2.60 的口径）',
      !adminSrc70.includes('cardTitle(panelBrand') &&
        !adminSrc70.includes('PANEL_BRAND as panelBrand') &&
        adminSrc70.includes('cardTitle(spec.label, cardDetail(args))'),
      'brand',
    )
    check(
      'card: 未知 action 把用户写的原值带上，别只说「未知」',
      adminSrc70.includes("cardTitle('未知动作', shown)") &&
        adminSrc70.includes("const shown = typeof args?.action === 'string' ? args.action.trim() : ''"),
      'shown',
    )
    check(
      'card: 细节预算仍是 40 字，超了截断（卡片不进会话正文，图个一眼认出）',
      panelSrc70.includes('CARD_DETAIL_MAX = 40') && panelSrc70.includes('cardTitle'),
      'panel.js',
    )
    const criteria70 = await import(pathToFileURL(join(root, 'tools', 'criteria.mjs')).href)
    const contract70 = await import(pathToFileURL(join(root, 'lib', 'macro', 'contract.js')).href)
    const list70 = criteria70.contractChecklist({
      contractSrc: read70(join('lib', 'macro', 'contract.js')),
      sources: {
        'links.js': read70(join('lib', 'macro', 'links.js')),
        'bridge.js': read70(join('lib', 'macro', 'bridge.js')),
        'linkflow.js': read70(join('lib', 'macro', 'linkflow.js')),
        'defs/link.js': read70(join('lib', 'macro', 'defs', 'link.js')),
        'defs/search.js': read70(join('lib', 'macro', 'defs', 'search.js')),
        'store.js': read70(join('lib', 'macro', 'store.js')),
        'cost.js': read70(join('lib', 'macro', 'cost.js')),
        'panel.js': panelSrc70,
        'defs/admin.js': adminSrc70,
        'shared.js': read70(join('lib', 'macro', 'shared.js')),
        'defs/read.js': read70(join('lib', 'macro', 'defs', 'read.js')),
        'prompt.js': read70(join('lib', 'macro', 'prompt.js')),
      },
      runtime: contract70,
      nebIndexSrc: read70(join('vendor', 'dsh-memory-nebula', 'lib', 'index.js')),
      nebCoreSrc: read70(join('vendor', 'dsh-memory-nebula', 'lib', 'host', 'nebula.js')),
      meowIndexSrc: read70(join('vendor', 'meow-memory', 'lib', 'index.js')),
    })
    const mine70 = list70.find((c) => c.id === 'admin-card-detail')
    check(
      'card: 判据清单里有 admin-card-detail，且整张清单仍全绿（四十五条）',
      list70.length === 45 && mine70?.ok === true && list70.every((c) => c.ok),
      mine70?.detail ?? '缺这一条',
    )
    const st70 = criteria70.selfTestContract()
    check(
      'card: 这条判据自测过能被打红（不是恒真）',
      st70.baseline.length === 0 && st70.survived.length === 0,
      `样板红 ${st70.baseline.join('/') || '无'} / 打不红 ${st70.survived.join('/') || '无'}`,
    )
    const fusionSrc70 = read70(join('tools', 'probe-fusion.mjs'))
    check(
      'card: 探针在真工具面上钉住八条（BA1–BA8）',
      ['BA1', 'BA2', 'BA3', 'BA4', 'BA5', 'BA6', 'BA7', 'BA8'].every((n) => fusionSrc70.includes(`'${n} `)),
      'probe-fusion',
    )
    const v70 = JSON.parse(read70('package.json')).version.split('.').map(Number)
    check('card: 版本不早于 0.2.70', v70[0] === 0 && v70[1] === 2 && v70[2] >= 70, v70.join('.'))
    check(
      'card: README 与 DESIGN 记了这一轮',
      read70('docs/INTERNAL.md').includes('0.2.70') &&
        read70('docs/INTERNAL.md').includes('卡片') &&
        read70('DESIGN.md').includes('0.2.70') &&
        read70('DESIGN.md').includes('cardDetail'),
      '文档',
    )
  }

  {
    const read71 = (x) => readFileSync(join(root, x), 'utf8')
    const nebCoreSrc71 = read71(join('vendor', 'dsh-memory-nebula', 'lib', 'host', 'nebula.js'))
    const nebIndexSrc71 = read71(join('vendor', 'dsh-memory-nebula', 'lib', 'index.js'))
    const adminSrc71 = read71(join('lib', 'macro', 'defs', 'admin.js'))
    check(
      'hubs: 上限只有一个出处（HUB_CAP），概览按调用方要的条数取',
      nebCoreSrc71.includes('export const HUB_CAP = 40') &&
        nebCoreSrc71.includes('export function hubSlots(value, def = 12)') &&
        nebCoreSrc71.includes('return Math.min(HUB_CAP, n)') &&
        nebCoreSrc71.includes('.slice(0, hubSlots(opts.hubs))') &&
        nebCoreSrc71.split('hubSlots(opts.hubs)').length - 1 === 1,
      'nebula.js',
    )
    check(
      'hubs: 概览的异步版把 hubs 一路带下去（不再是空参掉回默认 12）',
      nebCoreSrc71.includes('async overviewAsync(opts = {})') &&
        /async overviewAsync\(opts = \{\}\) \{[\s\S]{0,120}?return this\.overview\(opts\)/.test(nebCoreSrc71),
      'overviewAsync',
    )
    // 真跑一遍：这个函数是纯的，直接 import 就能验，不用建图
    const nebCore = await import(pathToFileURL(join(root, 'vendor', 'dsh-memory-nebula', 'lib', 'host', 'nebula.js')).href)
    check(
      'hubs: hubSlots 真的按 1..40 夹（20→20、99→40、3.7→3、没给→12）',
      nebCore.hubSlots(20) === 20 &&
        nebCore.hubSlots(99) === 40 &&
        nebCore.hubSlots(3.7) === 3 &&
        nebCore.hubSlots(undefined) === 12 &&
        nebCore.hubSlots('8') === 8,
      [20, 99, 3.7, undefined, '8'].map((v) => `${String(v)}→${nebCore.hubSlots(v)}`).join(' '),
    )
    check(
      'hubs: stats 把用户给的条数递下去，且不再自己二次 slice',
      nebIndexSrc71.includes('overviewAsync({ hubs: pHubs.value })') &&
        !nebIndexSrc71.includes('o.hubs.slice(0, pHubs.value)'),
      'nebula_stats',
    )
    check(
      'hubs: 没排上来的不许说成「还有 N 条没列」（0.2.75 收紧）',
      nebIndexSrc71.includes('export function hubTail(printed, pool, cap)') &&
        nebIndexSrc71.includes('const pool = Math.max(0, (s.nodes || 0) - (s.orphans || 0))') &&
        nebIndexSrc71.includes('const hubNote = hubTail(top.length, pool, HUB_CAP)') &&
        !nebIndexSrc71.includes('还有 ${s.nodes - top.length} 条没列') &&
        !nebIndexSrc71.includes('没列的不代表不是枢纽'),
      'hubTail',
    )
    check(
      'hubs: 参数说明把上限写出来（宏记忆面板与星图两侧口径一致，星图侧读 HUB_CAP）',
      adminSrc71.includes('默认 10，上限 40') &&
        nebIndexSrc71.includes('默认 10，上限 ${HUB_CAP}') &&
        !nebIndexSrc71.includes('默认 10，上限 40'),
      'schema',
    )
    const criteria71 = await import(pathToFileURL(join(root, 'tools', 'criteria.mjs')).href)
    const contract71 = await import(pathToFileURL(join(root, 'lib', 'macro', 'contract.js')).href)
    const list71 = criteria71.contractChecklist({
      contractSrc: read71(join('lib', 'macro', 'contract.js')),
      sources: {
        'links.js': read71(join('lib', 'macro', 'links.js')),
        'bridge.js': read71(join('lib', 'macro', 'bridge.js')),
        'linkflow.js': read71(join('lib', 'macro', 'linkflow.js')),
        'defs/link.js': read71(join('lib', 'macro', 'defs', 'link.js')),
        'defs/search.js': read71(join('lib', 'macro', 'defs', 'search.js')),
        'store.js': read71(join('lib', 'macro', 'store.js')),
        'cost.js': read71(join('lib', 'macro', 'cost.js')),
        'panel.js': read71(join('lib', 'macro', 'panel.js')),
        'defs/admin.js': adminSrc71,
        'shared.js': read71(join('lib', 'macro', 'shared.js')),
        'defs/read.js': read71(join('lib', 'macro', 'defs', 'read.js')),
        'prompt.js': read71(join('lib', 'macro', 'prompt.js')),
      },
      runtime: contract71,
      nebIndexSrc: nebIndexSrc71,
      nebCoreSrc: nebCoreSrc71,
      meowIndexSrc: read71(join('vendor', 'meow-memory', 'lib', 'index.js')),
    })
    const mine71 = list71.find((c) => c.id === 'stats-hubs-cap')
    check(
      'hubs: 判据清单里有 stats-hubs-cap，且整张清单仍全绿（四十五条）',
      list71.length === 45 && mine71?.ok === true && list71.every((c) => c.ok),
      mine71?.detail ?? '缺这一条',
    )
    const st71 = criteria71.selfTestContract()
    check(
      'hubs: 这条判据自测过能被打红（不是恒真）',
      st71.baseline.length === 0 && st71.survived.length === 0,
      `样板红 ${st71.baseline.join('/') || '无'} / 打不红 ${st71.survived.join('/') || '无'}`,
    )
    const graphSrc71 = read71(join('tools', 'probe-graph.mjs'))
    check(
      'hubs: 真图探针上钉了五条（GB1–GB5，0.2.75 换过口径）',
      ['GB1', 'GB2', 'GB3', 'GB4', 'GB5'].every((n) => graphSrc71.includes(`'${n} `)),
      'probe-graph',
    )
    const v71 = JSON.parse(read71('package.json')).version.split('.').map(Number)
    check('hubs: 版本不早于 0.2.71', v71[0] === 0 && v71[1] === 2 && v71[2] >= 71, v71.join('.'))
    check(
      'hubs: README 与 DESIGN 记了这一轮',
      read71('docs/INTERNAL.md').includes('0.2.71') &&
        read71('docs/INTERNAL.md').includes('枢纽') &&
        read71('DESIGN.md').includes('0.2.71') &&
        read71('DESIGN.md').includes('hubSlots'),
      '文档',
    )
  }

// ── A72（0.2.72）：星图面板「没接上」的两种情形必须分开说 ─────────────────
{
  const adminSrc72 = readFileSync(join(root, 'lib', 'macro', 'defs', 'admin.js'), 'utf8')
  check(
    'miss: graphPanel 分两支——装配没完成与星图那边报错各说各的',
    adminSrc72.includes('said.includes(NOT_READY_MARK)') &&
      adminSrc72.includes('要的那个能力还没装配好') &&
      adminSrc72.includes('星图这次答不上来（${what}）'),
    'graphPanel',
  )
  check(
    'miss: 老那句「……——等星图就绪再试一次就行」彻底没了',
    !adminSrc72.includes('等星图就绪') && !adminSrc72.includes('${miss}——'),
    '旧话术',
  )
  check(
    'miss: 分支依据取自 contract 的 NOT_READY_MARK，不抄字面量',
    adminSrc72.includes("import { NOT_READY_MARK } from '../contract.js'") &&
      !adminSrc72.includes("'这项能力还没就绪'"),
    'NOT_READY_MARK',
  )
  check(
    'miss: 星图报错时剥掉「${what}未完成：」前缀，只留原因',
    adminSrc72.includes('const pre = `${what}未完成：`') &&
      adminSrc72.includes('const reason = said.startsWith(pre) ? said.slice(pre.length) : said'),
    'reason',
  )
  check(
    'miss: 四个星图面板各留各的 miss（没被统一成一句空话）',
    ['星图概况这会儿看不了', '记忆体检这会儿做不了', '记忆来源这会儿看不了', '这批外部记忆一条都没推进去'].every(
      (s) => adminSrc72.includes(s),
    ),
    'miss 四处',
  )
  const criteria72 = await import(pathToFileURL(join(root, 'tools', 'criteria.mjs')).href)
  const runtime72 = await import(pathToFileURL(join(root, 'lib', 'macro', 'contract.js')).href)
  check(
    'miss: 判据清单里有 graph-miss-split，且整张清单仍全绿（四十五条）',
    (() => {
      const list = criteria72.contractChecklist({
        contractSrc: readFileSync(join(root, 'lib', 'macro', 'contract.js'), 'utf8'),
        sources: {
          'links.js': readFileSync(join(root, 'lib', 'macro', 'links.js'), 'utf8'),
          'bridge.js': readFileSync(join(root, 'lib', 'macro', 'bridge.js'), 'utf8'),
          'linkflow.js': readFileSync(join(root, 'lib', 'macro', 'linkflow.js'), 'utf8'),
          'defs/link.js': readFileSync(join(root, 'lib', 'macro', 'defs', 'link.js'), 'utf8'),
          'defs/search.js': readFileSync(join(root, 'lib', 'macro', 'defs', 'search.js'), 'utf8'),
          'store.js': readFileSync(join(root, 'lib', 'macro', 'store.js'), 'utf8'),
          'cost.js': readFileSync(join(root, 'lib', 'macro', 'cost.js'), 'utf8'),
          'panel.js': readFileSync(join(root, 'lib', 'macro', 'panel.js'), 'utf8'),
          'defs/admin.js': adminSrc72,
          'shared.js': readFileSync(join(root, 'lib', 'macro', 'shared.js'), 'utf8'),
          'defs/read.js': readFileSync(join(root, 'lib', 'macro', 'defs', 'read.js'), 'utf8'),
          'prompt.js': readFileSync(join(root, 'lib', 'macro', 'prompt.js'), 'utf8'),
        },
        runtime: runtime72,
        nebIndexSrc: readFileSync(join(root, 'vendor', 'dsh-memory-nebula', 'lib', 'index.js'), 'utf8'),
        nebCoreSrc: readFileSync(join(root, 'vendor', 'dsh-memory-nebula', 'lib', 'host', 'nebula.js'), 'utf8'),
        meowIndexSrc: readFileSync(join(root, 'vendor', 'meow-memory', 'lib', 'index.js'), 'utf8'),
      })
      const mine = list.find((c) => c.id === 'graph-miss-split')
      return list.length === 45 && mine?.ok === true && list.every((c) => c.ok)
    })(),
    'graph-miss-split',
  )
  check(
    'miss: 判据自测没有幸存（每刀都能打红），基线里没有恒红条',
    (() => {
      const st = criteria72.selfTestContract()
      return st.baseline.length === 0 && st.survived.length === 0
    })(),
    'selfTest',
  )
  const fusionSrc72 = readFileSync(join(root, 'tools', 'probe-fusion.mjs'), 'utf8')
  check(
    'miss: 融合探针上钉了六条（CA1–CA6）',
    ['CA1', 'CA2', 'CA3', 'CA4', 'CA5', 'CA6'].every((n) => fusionSrc72.includes(`'${n} `)),
    'probe-fusion',
  )
  const v72 = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version.split('.').map(Number)
  check('miss: 版本不早于 0.2.72', v72[0] === 0 && v72[1] === 2 && v72[2] >= 72, v72.join('.'))
  check(
    'miss: README 与 DESIGN 记了这一轮',
    readFileSync(join(root, 'docs', 'INTERNAL.md'), 'utf8').includes('0.2.72') &&
      readFileSync(join(root, 'docs', 'INTERNAL.md'), 'utf8').includes('没接上') &&
      readFileSync(join(root, 'DESIGN.md'), 'utf8').includes('0.2.72') &&
      readFileSync(join(root, 'DESIGN.md'), 'utf8').includes('graphPanel'),
    '文档',
  )
}

// ── A73（0.2.73）：体检的判决只看 tag——打了 FAIL 就必须红 ───────────────────
{
  const doctorSrc73 = readFileSync(join(root, 'tools', 'doctor.mjs'), 'utf8')
  const verdictSrc73 = readFileSync(join(root, 'tools', 'doctor-verdict.mjs'), 'utf8')
  check(
    'doctor: 判决器抽到 tools/doctor-verdict.mjs，doctor 不再自己记账',
    verdictSrc73.includes('export function makeVerdict(log = console.log)') &&
      doctorSrc73.includes("import { makeVerdict } from './doctor-verdict.mjs'") &&
      !doctorSrc73.includes('let fails = 0') &&
      !doctorSrc73.includes('let warns = 0'),
    'doctor-verdict',
  )
  const { makeVerdict } = await import(pathToFileURL(join(root, 'tools', 'doctor-verdict.mjs')).href)
  const run73 = (fn) => {
    const out = []
    const v = makeVerdict((s) => out.push(s))
    fn(v)
    return { fails: v.fails, warns: v.warns, out }
  }
  const old73 = run73((v) => v.line('FAIL', true, '老写法', 'cond ? PASS : FAIL'))
  check(
    'doctor: 老写法（打 FAIL 却把 true 当第二参）也必须计失败',
    old73.fails === 1 && old73.warns === 0 && old73.out[0].startsWith('FAIL  老写法'),
    `fails=${old73.fails}`,
  )
  const mix73 = run73((v) => {
    v.line('PASS', true, 'a')
    v.line('WARN', false, 'b')
    v.line('FAIL', false, 'c')
    v.line('PASS', false, 'd')
  })
  check(
    'doctor: PASS+true 不计、WARN 计警告、FAIL 计失败、PASS+false 也算失败',
    mix73.fails === 2 && mix73.warns === 1,
    `${mix73.fails} 失败 / ${mix73.warns} 警告`,
  )
  const wrap73 = run73((v) => {
    v.pass('p')
    v.warn('w')
    v.fail('f')
  })
  check(
    'doctor: pass/fail/warn 三件套与 tag 一致，打印格式仍是「TAG␠␠名字␠␠附加」',
    wrap73.fails === 1 && wrap73.warns === 1 && wrap73.out[1] === 'WARN  w' && wrap73.out[2].startsWith('FAIL  f'),
    wrap73.out.join(' | '),
  )
  const sites73 = doctorSrc73.split('line(').length - 1
  check(
    'doctor: 所有判定仍走同一个判决器（调用点没被顺手删掉）',
    sites73 >= 40 && doctorSrc73.includes('const { line, pass, fail, warn } = verdict'),
    `${sites73} 处 line(`,
  )
  check(
    'doctor: 结论与退出码都看 verdict 的账，不再读某个局部变量',
    doctorSrc73.includes('return verdict.fails === 0') &&
      doctorSrc73.includes('process.exit(verdict.fails > 0 || (STRICT && verdict.warns > 0) ? 1 : 0)'),
    '判定出口',
  )
  const v73 = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version.split('.').map(Number)
  check('doctor: 版本不早于 0.2.73', v73[0] === 0 && v73[1] === 2 && v73[2] >= 73, v73.join('.'))
  check(
    'doctor: README 与 DESIGN 记了这一轮（README 还得提到 doctor-verdict.mjs，否则体检嫌它没出处）',
    readFileSync(join(root, 'docs', 'INTERNAL.md'), 'utf8').includes('0.2.73') &&
      readFileSync(join(root, 'docs', 'INTERNAL.md'), 'utf8').includes('tools/doctor-verdict.mjs') &&
      readFileSync(join(root, 'DESIGN.md'), 'utf8').includes('0.2.73') &&
      readFileSync(join(root, 'DESIGN.md'), 'utf8').includes('makeVerdict'),
    '文档',
  )
}

// ── A74（0.2.74）：体检的条数只有一本账——抬头给全量，「列了几条 / 还剩几条」按正文实列算 ─────
{
  const nebSrc74 = readFileSync(join(root, 'vendor', 'dsh-memory-nebula', 'lib', 'index.js'), 'utf8')
  check(
    'hygiene: 条数的账收在一处（listTail），两本账的写法都没了',
    nebSrc74.includes('export function listTail(n, printed, limit)') &&
      nebSrc74.includes('const printed = Math.min(limit, arr.length)') &&
      nebSrc74.includes('const tail = listTail(n, printed, limit)') &&
      !nebSrc74.includes('这里只列前 ${arr.length} 条') &&
      !nebSrc74.includes('if (n > limit) lines.push'),
    'listTail',
  )
  const { listTail } = await import(pathToFileURL(join(root, 'vendor', 'dsh-memory-nebula', 'lib', 'index.js')).href)
  const cases74 = [
    [100, 6, 6],
    [41, 6, 6],
    [100, 40, 20],
  ]
  const tails74 = cases74.map(([n, p, l]) => listTail(n, p, l))
  check(
    'hygiene: 尾注的「还剩几条」按正文实列算，并把这次上限说出来',
    tails74[0].includes('…还有 94 条') &&
      tails74[0].includes('每类最多列 6 条') &&
      tails74[1].includes('…还有 35 条') &&
      tails74[2].includes('…还有 60 条') &&
      tails74[2].includes('每类最多列 20 条') &&
      listTail(6, 6, 6) === '' &&
      listTail(0, 0, 6) === '' &&
      listTail(2, 5, 6) === '',
    JSON.stringify(tails74.map((t) => t.slice(0, 12))),
  )
  check(
    'hygiene: 抬头只给全量计数，不再自带「只列前 N 条」',
    nebSrc74.includes("lines.push('', `${labelOf(k)}（${n}）`)") && nebSrc74.includes('没列的不代表不存在'),
    '抬头',
  )
  const criteria74 = await import(pathToFileURL(join(root, 'tools', 'criteria.mjs')).href)
  const list74 = criteria74.contractChecklist({
    contractSrc: readFileSync(join(root, 'lib', 'macro', 'contract.js'), 'utf8'),
    sources: {
      'links.js': readFileSync(join(root, 'lib', 'macro', 'links.js'), 'utf8'),
      'bridge.js': readFileSync(join(root, 'lib', 'macro', 'bridge.js'), 'utf8'),
      'linkflow.js': readFileSync(join(root, 'lib', 'macro', 'linkflow.js'), 'utf8'),
      'defs/link.js': readFileSync(join(root, 'lib', 'macro', 'defs', 'link.js'), 'utf8'),
      'defs/search.js': readFileSync(join(root, 'lib', 'macro', 'defs', 'search.js'), 'utf8'),
      'store.js': readFileSync(join(root, 'lib', 'macro', 'store.js'), 'utf8'),
      'cost.js': readFileSync(join(root, 'lib', 'macro', 'cost.js'), 'utf8'),
      'panel.js': readFileSync(join(root, 'lib', 'macro', 'panel.js'), 'utf8'),
      'defs/admin.js': readFileSync(join(root, 'lib', 'macro', 'defs', 'admin.js'), 'utf8'),
      'shared.js': readFileSync(join(root, 'lib', 'macro', 'shared.js'), 'utf8'),
      'defs/read.js': readFileSync(join(root, 'lib', 'macro', 'defs', 'read.js'), 'utf8'),
      'prompt.js': readFileSync(join(root, 'lib', 'macro', 'prompt.js'), 'utf8'),
    },
    runtime: await import(pathToFileURL(join(root, 'lib', 'macro', 'contract.js')).href),
    nebIndexSrc: nebSrc74,
    nebCoreSrc: readFileSync(join(root, 'vendor', 'dsh-memory-nebula', 'lib', 'host', 'nebula.js'), 'utf8'),
    meowIndexSrc: readFileSync(join(root, 'vendor', 'meow-memory', 'lib', 'index.js'), 'utf8'),
  })
  const mine74 = list74.find((c) => c.id === 'hygiene-count-ledger')
  check(
    'hygiene: 判据清单里有 hygiene-count-ledger，且整张清单仍全绿（四十五条）',
    list74.length === 45 && mine74?.ok === true && list74.every((c) => c.ok),
    mine74?.detail ?? '缺这一条',
  )
  check(
    'hygiene: 判据自测没有幸存（这一刀也能打红）',
    (() => {
      const st = criteria74.selfTestContract()
      return st.baseline.length === 0 && st.survived.length === 0
    })(),
    'selfTest',
  )
  const graphSrc74 = readFileSync(join(root, 'tools', 'probe-graph.mjs'), 'utf8')
  check(
    'hygiene: 真引擎探针上钉了六条（HD0–HD5），且用的是真工具面',
    ['HD0', 'HD1', 'HD2', 'HD3', 'HD4', 'HD5'].every((n) => graphSrc74.includes(`'${n} `)) &&
      graphSrc74.includes("action: 'hygiene', kind: 'orphan', limit: 6"),
    'probe-graph',
  )
  const v74 = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version.split('.').map(Number)
  check('hygiene: 版本不早于 0.2.74', v74[0] === 0 && v74[1] === 2 && v74[2] >= 74, v74.join('.'))
  check(
    'hygiene: README 与 DESIGN 记了这一轮',
    readFileSync(join(root, 'docs', 'INTERNAL.md'), 'utf8').includes('0.2.74') &&
      readFileSync(join(root, 'docs', 'INTERNAL.md'), 'utf8').includes('listTail') &&
      readFileSync(join(root, 'DESIGN.md'), 'utf8').includes('0.2.74') &&
      readFileSync(join(root, 'DESIGN.md'), 'utf8').includes('listTail'),
    '文档',
  )
}

// ── A75（0.2.75）：枢纽榜的尾注只报读者数得到的数——列了几条 / 有连接的共几条 / 上限几条 ─────
{
  const nebSrc75 = readFileSync(join(root, 'vendor', 'dsh-memory-nebula', 'lib', 'index.js'), 'utf8')
  const nebCoreSrc75 = readFileSync(join(root, 'vendor', 'dsh-memory-nebula', 'lib', 'host', 'nebula.js'), 'utf8')
  check(
    'hubs: 上限只剩一个数（HUB_CAP），夹参数 / 尾注 / schema 都读它',
    nebCoreSrc75.includes('export const HUB_CAP = 40') &&
      nebCoreSrc75.includes('return Math.min(HUB_CAP, n)') &&
      nebSrc75.includes("import { HUB_CAP } from './host/nebula.js'") &&
      nebSrc75.includes("numParam('hubs', args.hubs, { min: 1, max: HUB_CAP, def: 10 })") &&
      nebSrc75.includes('上限 ${HUB_CAP}') &&
      !nebSrc75.includes('默认 10，上限 40'),
    'HUB_CAP',
  )
  const neb75 = await import(pathToFileURL(join(root, 'vendor', 'dsh-memory-nebula', 'lib', 'index.js')).href)
  const t75 = (a, b, c) => neb75.hubTail(a, b, c)
  check(
    'hubs: 尾注按「列了几条 / 有连接的共几条 / 上限几条」说话',
    t75(12, 624, 40) ===
      '  全图 624 条记忆彼此有连接，这里只取排在最前的 12 条（hubs 上限 40）；没进前 12 的不是「没有连接」，只是没排上来。',
    t75(12, 624, 40),
  )
  check(
    'hubs: 没截断就闭嘴（相等 / 池子更小 / 全零都不出尾注）',
    t75(40, 40, 40) === '' && t75(12, 12, 40) === '' && t75(10, 5, 40) === '' && t75(0, 0, 40) === '',
    [t75(40, 40, 40), t75(12, 12, 40), t75(10, 5, 40), t75(0, 0, 40)].map((x) => JSON.stringify(x)).join('|'),
  )
  check(
    'hubs: 参数脏了也归一（不出现 NaN / 负数，夹到能算的数）',
    t75('2', '9', '0') ===
      '  全图 9 条记忆彼此有连接，这里只取排在最前的 2 条（hubs 上限 1）；没进前 2 的不是「没有连接」，只是没排上来。',
    t75('2', '9', '0'),
  )
  check(
    'hubs: stats 的池子按「有连接的记忆」算，不再拿节点总数吓人',
    nebSrc75.includes('export function hubTail(printed, pool, cap)') &&
      nebSrc75.includes('const pool = Math.max(0, (s.nodes || 0) - (s.orphans || 0))') &&
      nebSrc75.includes('const hubNote = hubTail(top.length, pool, HUB_CAP)') &&
      !nebSrc75.includes('还有 ${s.nodes - top.length} 条没列') &&
      !nebSrc75.includes('没列的不代表不是枢纽'),
    'pool',
  )
  const criteria75 = await import(pathToFileURL(join(root, 'tools', 'criteria.mjs')).href)
  const list75 = criteria75.contractChecklist({
    contractSrc: readFileSync(join(root, 'lib', 'macro', 'contract.js'), 'utf8'),
    sources: {
      'links.js': readFileSync(join(root, 'lib', 'macro', 'links.js'), 'utf8'),
      'bridge.js': readFileSync(join(root, 'lib', 'macro', 'bridge.js'), 'utf8'),
      'linkflow.js': readFileSync(join(root, 'lib', 'macro', 'linkflow.js'), 'utf8'),
      'defs/link.js': readFileSync(join(root, 'lib', 'macro', 'defs', 'link.js'), 'utf8'),
      'defs/search.js': readFileSync(join(root, 'lib', 'macro', 'defs', 'search.js'), 'utf8'),
      'store.js': readFileSync(join(root, 'lib', 'macro', 'store.js'), 'utf8'),
      'cost.js': readFileSync(join(root, 'lib', 'macro', 'cost.js'), 'utf8'),
      'panel.js': readFileSync(join(root, 'lib', 'macro', 'panel.js'), 'utf8'),
      'defs/admin.js': readFileSync(join(root, 'lib', 'macro', 'defs', 'admin.js'), 'utf8'),
      'shared.js': readFileSync(join(root, 'lib', 'macro', 'shared.js'), 'utf8'),
      'defs/read.js': readFileSync(join(root, 'lib', 'macro', 'defs', 'read.js'), 'utf8'),
      'prompt.js': readFileSync(join(root, 'lib', 'macro', 'prompt.js'), 'utf8'),
    },
    runtime: await import(pathToFileURL(join(root, 'lib', 'macro', 'contract.js')).href),
    nebIndexSrc: nebSrc75,
    nebCoreSrc: nebCoreSrc75,
    meowIndexSrc: readFileSync(join(root, 'vendor', 'meow-memory', 'lib', 'index.js'), 'utf8'),
  })
  const mine75 = list75.find((c) => c.id === 'stats-hubs-cap')
  check(
    'hubs: 判据清单里有 stats-hubs-cap，且整张清单仍全绿（四十五条）',
    list75.length === 45 && mine75?.ok === true && list75.every((c) => c.ok),
    mine75?.detail ?? '缺这一条',
  )
  const graphSrc75 = readFileSync(join(root, 'tools', 'probe-graph.mjs'), 'utf8')
  check(
    'hubs: 真引擎探针上钉了这一轮（GB1–GB5 不截断闭嘴 / HB0–HB6 截断时三个数对得上）',
    ['GB1', 'GB2', 'GB3', 'GB4', 'GB5', 'HB0', 'HB1', 'HB2', 'HB3', 'HB4', 'HB5', 'HB6'].every((n) =>
      graphSrc75.includes(`'${n} `),
    ) && graphSrc75.includes("action: 'stats', hubs: 1"),
    'probe-graph',
  )
  const v75 = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version.split('.').map(Number)
  check('hubs: 版本不早于 0.2.75', v75[0] === 0 && v75[1] === 2 && v75[2] >= 75, v75.join('.'))
  const readme75 = readFileSync(join(root, 'docs', 'INTERNAL.md'), 'utf8')
  const design75 = readFileSync(join(root, 'DESIGN.md'), 'utf8')
  check(
    'hubs: README 与 DESIGN 记了这一轮',
    readme75.includes('0.2.75') && readme75.includes('hubTail') && design75.includes('0.2.75') && design75.includes('HUB_CAP'),
    '文档',
  )
}

// ── A76（0.2.76）：成本面板的「最近 N 次」按真算了的条数报——要了几次 / 算了几条 / 更早几条没进 / 几行读不出来 ──
{
  const costSrc76 = readFileSync(join(root, 'lib', 'macro', 'cost.js'), 'utf8')
  const adminSrc76 = readFileSync(join(root, 'lib', 'macro', 'defs', 'admin.js'), 'utf8')
  check(
    'cost: 三个数收成一个出口（costScope），面板不再自己报「最近 N 次」',
    costSrc76.includes('export function costScope(asked, counted, good, bad = 0)') &&
      costSrc76.includes('export function readCost(limit = 200)') &&
      costSrc76.includes('export function costReport(limit = 200) {') &&
      costSrc76.includes('return readCost(limit).body') &&
      costSrc76.includes('scope: costScope(n, entries.length, detail.entries.length, detail.badLines)') &&
      adminSrc76.includes('const c = readCost(lim.value)') &&
      adminSrc76.includes('[c.scope, lim.note].filter(Boolean).join') &&
      !adminSrc76.includes('最近 ${lim.value} 次调用'),
    'costScope',
  )
  const cost76 = await import(pathToFileURL(join(root, 'lib', 'macro', 'cost.js')).href)
  const s76 = (a, b, c, d) => cost76.costScope(a, b, c, d)
  check(
    'cost: 要了 200 次、账本只有 5 条、另有 2 行读不出来——三个数都说出口',
    s76(200, 5, 7, 2) ===
      '统计最近 5 次调用（你要的是 200 次，账本里能算的只有 5 条）；更早的 2 条没进这次统计；另有 2 行解析不出来，一行都没算进去',
    s76(200, 5, 7, 2),
  )
  check(
    'cost: 账本比要的还少时，明说「能算的只有几条」，不拿要的次数当事实',
    s76(200, 7, 7, 0) === '统计最近 7 次调用（你要的是 200 次，账本里能算的只有 7 条）',
    s76(200, 7, 7, 0),
  )
  check(
    'cost: 要的都算进来了、一条不差、没有坏行——只留基句，不补「能算的只有」也不提坏行',
    s76(200, 200, 200, 0) === '统计最近 200 次调用' &&
      s76(5, 5, 5, 0) === '统计最近 5 次调用' &&
      s76(0, 0, 0, 3) === '',
    [s76(200, 200, 200, 0), s76(5, 5, 5, 0), s76(0, 0, 0, 3)].map((x) => JSON.stringify(x)).join('|'),
  )
  check(
    'cost: 更早的按「账本里的 − 这次算的」算，参数脏了归一',
    s76(200, 200, 250, 0) === '统计最近 200 次调用；更早的 50 条没进这次统计' &&
      s76('2', '9', '0') === '统计最近 9 次调用' &&
      s76(-3, 4, 4, -9) === '统计最近 4 次调用',
    [s76(200, 200, 250, 0), s76('2', '9', '0'), s76(-3, 4, 4, -9)].map((x) => JSON.stringify(x)).join('|'),
  )
  check(
    'cost: costReport 还是字符串（老调用点不用改），readCost 给两样',
    typeof cost76.costReport === 'function' && typeof cost76.readCost === 'function' && typeof cost76.costReport(0) === 'string',
    typeof cost76.costReport(0),
  )
  const criteria76 = await import(pathToFileURL(join(root, 'tools', 'criteria.mjs')).href)
  const list76 = criteria76.contractChecklist({
    contractSrc: readFileSync(join(root, 'lib', 'macro', 'contract.js'), 'utf8'),
    sources: {
      'links.js': readFileSync(join(root, 'lib', 'macro', 'links.js'), 'utf8'),
      'bridge.js': readFileSync(join(root, 'lib', 'macro', 'bridge.js'), 'utf8'),
      'linkflow.js': readFileSync(join(root, 'lib', 'macro', 'linkflow.js'), 'utf8'),
      'defs/link.js': readFileSync(join(root, 'lib', 'macro', 'defs', 'link.js'), 'utf8'),
      'defs/search.js': readFileSync(join(root, 'lib', 'macro', 'defs', 'search.js'), 'utf8'),
      'store.js': readFileSync(join(root, 'lib', 'macro', 'store.js'), 'utf8'),
      'cost.js': costSrc76,
      'panel.js': readFileSync(join(root, 'lib', 'macro', 'panel.js'), 'utf8'),
      'defs/admin.js': adminSrc76,
      'shared.js': readFileSync(join(root, 'lib', 'macro', 'shared.js'), 'utf8'),
      'defs/read.js': readFileSync(join(root, 'lib', 'macro', 'defs', 'read.js'), 'utf8'),
      'prompt.js': readFileSync(join(root, 'lib', 'macro', 'prompt.js'), 'utf8'),
    },
    runtime: await import(pathToFileURL(join(root, 'lib', 'macro', 'contract.js')).href),
    nebIndexSrc: readFileSync(join(root, 'vendor', 'dsh-memory-nebula', 'lib', 'index.js'), 'utf8'),
    nebCoreSrc: readFileSync(join(root, 'vendor', 'dsh-memory-nebula', 'lib', 'host', 'nebula.js'), 'utf8'),
    meowIndexSrc: readFileSync(join(root, 'vendor', 'meow-memory', 'lib', 'index.js'), 'utf8'),
  })
  const mine76 = list76.find((c) => c.id === 'cost-scope-count')
  check(
    'cost: 判据清单里有 cost-scope-count，且整张清单仍全绿（四十五条）',
    list76.length === 45 && mine76?.ok === true && list76.every((c) => c.ok),
    mine76?.detail ?? '缺这一条',
  )
  const fusionSrc76 = readFileSync(join(root, 'tools', 'probe-fusion.mjs'), 'utf8')
  check(
    'cost: 真面板探针上钉了这一轮（CB1–CB7：要了几次 / 算了几条 / 更早几条 / 几行坏了 / 0 条不许写「统计最近 0 次」）',
    ['CB1', 'CB2', 'CB3', 'CB4', 'CB5', 'CB6', 'CB7'].every((n) => fusionSrc76.includes(`'${n} `)) &&
      fusionSrc76.includes('// ── CB. ') &&
      !fusionSrc76.includes('最近 ${lim.value} 次调用'),
    'probe-fusion',
  )
  const v76 = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version.split('.').map(Number)
  check('cost: 版本不早于 0.2.76', v76[0] === 0 && v76[1] === 2 && v76[2] >= 76, v76.join('.'))
  const readme76 = readFileSync(join(root, 'docs', 'INTERNAL.md'), 'utf8')
  const design76 = readFileSync(join(root, 'DESIGN.md'), 'utf8')
  check(
    'cost: README 与 DESIGN 记了这一轮',
    readme76.includes('0.2.76') && readme76.includes('costScope') && design76.includes('0.2.76') && design76.includes('costScope'),
    '文档',
  )
}

// ── A77（0.2.77）：读记忆的邻居段没拿到时要分三种话说——没查成 / 没查到这条 / 回执里没这一段 ──
{
  const sharedSrc77 = readFileSync(join(root, 'lib', 'macro', 'shared.js'), 'utf8')
  const readSrc77 = readFileSync(join(root, 'lib', 'macro', 'defs', 'read.js'), 'utf8')
  check(
    'read: 邻居段没拿到时的话收成一个出口（neighborGapNote），read.js 不再「有段就拼、没段就闭嘴」',
    sharedSrc77.includes("export function neighborGapNote(section, reachable, raw = '') {") &&
      readSrc77.includes('const gap = neighborGapNote(section, inspect.def !== undefined, inspect.text)') &&
      readSrc77.includes('[said, section, gap, nb.note].filter(Boolean).join') &&
      !readSrc77.includes('const base = section ?'),
    'neighborGapNote',
  )
  const shared77 = await import(pathToFileURL(join(root, 'lib', 'macro', 'shared.js')).href)
  const g77 = (s, r, raw) => shared77.neighborGapNote(s, r, raw)
  check(
    'read: 有邻居段时一句废话都不加',
    g77('## 连接到的记忆（2/2）\n- node-1', true, '## 连接到的记忆（2/2）\n- node-1') === '',
    JSON.stringify(g77('## 连接到的记忆（2/2）', true, '')),
  )
  check(
    'read: 星图没答上来时说的是「没查成」，而且否认「没有邻居」',
    g77('', false, '星图邻居未完成：ENOENT') ===
      '星图这次没答上来（这一问没查成），所以邻居一条都没带到——这不是「这条记忆没有邻居」。' &&
      g77('   ', false, '') === '星图这次没答上来（这一问没查成），所以邻居一条都没带到——这不是「这条记忆没有邻居」。',
    JSON.stringify(g77('', false, 'x')),
  )
  check(
    'read: 星图答上来了但说没这条记忆——第三种话，不套「改了格式」',
    g77('', true, '星图里没有 id=abc 的记忆。这不等于「记忆没了」') ===
      '星图这次没查到这条记忆（可能刚写还没入图，也可能 id 不对），所以没有邻居段——这不是「它没有邻居」。' &&
      g77('', true, '星图里还没有节点（图是空的），这次 nebula_inspect 等于没算') ===
        '星图这次没查到这条记忆（可能刚写还没入图，也可能 id 不对），所以没有邻居段——这不是「它没有邻居」。',
    JSON.stringify(g77('', true, '星图里没有 id=abc')),
  )
  check(
    'read: 回执里真没有那一段时才说「改了格式」',
    g77('', true, '星图：这条记忆在，什么都没说') ===
      '星图的回执里没有「连接到的记忆」这一段（多半是它改了格式），所以这次邻居没带到——这不是「这条记忆没有邻居」。',
    JSON.stringify(g77('', true, '别的')),
  )
  const criteria77 = await import(pathToFileURL(join(root, 'tools', 'criteria.mjs')).href)
  const list77 = criteria77.contractChecklist({
    contractSrc: readFileSync(join(root, 'lib', 'macro', 'contract.js'), 'utf8'),
    sources: {
      'links.js': readFileSync(join(root, 'lib', 'macro', 'links.js'), 'utf8'),
      'bridge.js': readFileSync(join(root, 'lib', 'macro', 'bridge.js'), 'utf8'),
      'linkflow.js': readFileSync(join(root, 'lib', 'macro', 'linkflow.js'), 'utf8'),
      'defs/link.js': readFileSync(join(root, 'lib', 'macro', 'defs', 'link.js'), 'utf8'),
      'defs/search.js': readFileSync(join(root, 'lib', 'macro', 'defs', 'search.js'), 'utf8'),
      'store.js': readFileSync(join(root, 'lib', 'macro', 'store.js'), 'utf8'),
      'cost.js': readFileSync(join(root, 'lib', 'macro', 'cost.js'), 'utf8'),
      'panel.js': readFileSync(join(root, 'lib', 'macro', 'panel.js'), 'utf8'),
      'defs/admin.js': readFileSync(join(root, 'lib', 'macro', 'defs', 'admin.js'), 'utf8'),
      'shared.js': sharedSrc77,
      'defs/read.js': readSrc77,
      'prompt.js': readFileSync(join(root, 'lib', 'macro', 'prompt.js'), 'utf8'),
    },
    runtime: await import(pathToFileURL(join(root, 'lib', 'macro', 'contract.js')).href),
    nebIndexSrc: readFileSync(join(root, 'vendor', 'dsh-memory-nebula', 'lib', 'index.js'), 'utf8'),
    nebCoreSrc: readFileSync(join(root, 'vendor', 'dsh-memory-nebula', 'lib', 'host', 'nebula.js'), 'utf8'),
    meowIndexSrc: readFileSync(join(root, 'vendor', 'meow-memory', 'lib', 'index.js'), 'utf8'),
  })
  const mine77 = list77.find((c) => c.id === 'read-neighbor-gap')
  check(
    'read: 判据清单里有 read-neighbor-gap，且整张清单仍全绿（四十五条）',
    list77.length === 45 && mine77?.ok === true && list77.every((c) => c.ok),
    mine77?.detail ?? '缺这一条',
  )
  const fusionSrc77 = readFileSync(join(root, 'tools', 'probe-fusion.mjs'), 'utf8')
  check(
    'read: 真面板探针上钉了这一轮（CC1–CC6：没答上来 / 没这段 / 正常原样 / 0 不问 / 参数脏 / 没这条记忆）',
    ['CC1', 'CC2', 'CC3', 'CC4', 'CC5', 'CC6'].every((n) => fusionSrc77.includes(`'${n} `)) &&
      fusionSrc77.includes('// ── CC. '),
    'probe-fusion',
  )
  const v77 = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version.split('.').map(Number)
  check('read: 版本不早于 0.2.77', v77[0] === 0 && v77[1] === 2 && v77[2] >= 77, v77.join('.'))
  const readme77 = readFileSync(join(root, 'docs', 'INTERNAL.md'), 'utf8')
  const design77 = readFileSync(join(root, 'DESIGN.md'), 'utf8')
  check(
    'read: README 与 DESIGN 记了这一轮',
    readme77.includes('0.2.77') && readme77.includes('neighborGapNote') && design77.includes('0.2.77') && design77.includes('neighborGapNote'),
    '文档',
  )
}

// ── A78（0.2.78）：写入时给的 links，用不了的条目要数出来，不许悄悄丢 ──────────────
{
  const flowSrc78 = readFileSync(join(root, 'lib', 'macro', 'linkflow.js'), 'utf8')
  check(
    'link: links 的拆分收成一个出口（linkArgs），丢弃原因跟着条目一起交出去',
    flowSrc78.includes('export function linkArgs(links) {') &&
      flowSrc78.includes('export function linkDropNote(drop, anchorMissing = false) {') &&
      flowSrc78.includes('const { items, drop } = linkArgs(links)') &&
      !flowSrc78.includes('const items = normalizeLinks(links)'),
    'linkArgs',
  )
  check(
    'link: 三个早退口子都要说话——没锚点 / 条目全废 / 排队中也拼上丢弃说明（阴性对照 B、C 两刀就切在这里）',
    flowSrc78.includes('if (!anchorId) return linkDropNote({ ...drop, total: drop.total + items.length }, true)') &&
      flowSrc78.includes('if (items.length === 0) return linkDropNote(drop)') &&
      flowSrc78.includes('return droppedNote ? `${queuedText}\\n\\n${droppedNote}` : queuedText'),
    '早退口子',
  )
  const flow78 = await import(pathToFileURL(join(root, 'lib', 'macro', 'linkflow.js')).href)
  const args78 = (v) => flow78.linkArgs(v)
  const a1 = args78('mem-x')
  check(
    'link: 整份不是数组时记一条「不是数组」，条目为空',
    a1.items.length === 0 && a1.drop.notArray === 1 && a1.drop.total === 1,
    JSON.stringify(a1.drop),
  )
  const a2 = args78(['mem-a', '', { note: '没 id' }, 42, { id: '  ' }])
  check(
    'link: 空 id 与形状不对分开数，好条目照留',
    a2.items.length === 1 && a2.items[0].id === 'mem-a' && a2.drop.blank === 2 && a2.drop.wrongShape === 2 && a2.drop.total === 4,
    JSON.stringify(a2),
  )
  const a3 = args78([{ id: 'mem-b', note: '同类' }, 'mem-c'])
  check(
    'link: 好条目一条不丢，note 原样带过去',
    a3.items.length === 2 && a3.items[0].note === '同类' && a3.items[1].id === 'mem-c' && a3.drop.total === 0,
    JSON.stringify(a3.items),
  )
  check(
    'link: normalizeLinks 仍是薄壳（老调用点不用改）',
    JSON.stringify(flow78.normalizeLinks(['mem-a'])) === JSON.stringify([{ id: 'mem-a', note: flow78.LINK_NOTE }]),
    'normalizeLinks',
  )
  const note78 = (drop, miss) => flow78.linkDropNote(drop, miss)
  check(
    'link: 没丢东西时一句废话不说；links 根本没给也不说话',
    note78({ notArray: 0, blank: 0, wrongShape: 0, total: 0 }) === '' && note78(undefined) === '' && note78('abc') === '',
    JSON.stringify([note78({ total: 0 }), note78(undefined)]),
  )
  check(
    'link: 丢了条目时说清丢了几条、为什么，并否认「已经连上了」',
    note78({ notArray: 1, blank: 0, wrongShape: 0, total: 1 }) ===
      'links 里这 1 条没法用：links 给的不是数组（整份用法没生效）——这几条一条都没连、也没进排队：补成正经的 id 再试，别当成「已经连上了」。' &&
      note78({ notArray: 0, blank: 1, wrongShape: 2, total: 3 }) ===
        'links 里这 3 条没法用：1 条是空 id；2 条既不是 id 字符串，也不是 {id, note}——这几条一条都没连、也没进排队：补成正经的 id 再试，别当成「已经连上了」。',
    note78({ notArray: 0, blank: 1, wrongShape: 2, total: 3 }),
  )
  check(
    'link: 不知道锚点是谁时另说一句——连排队都没法排',
    note78({ notArray: 0, blank: 0, wrongShape: 0, total: 2 }, true) ===
      'links 里这 2 条一条都没连上——而且这次也不知道要连到哪条记忆（写入回执里没给 id），所以连排队都没法排：先用 memory_search 找到 id，再用 memory_link 手动连。',
    note78({ total: 2 }, true),
  )
  const criteria78 = await import(pathToFileURL(join(root, 'tools', 'criteria.mjs')).href)
  const list78 = criteria78.contractChecklist({
    contractSrc: readFileSync(join(root, 'lib', 'macro', 'contract.js'), 'utf8'),
    sources: {
      'links.js': readFileSync(join(root, 'lib', 'macro', 'links.js'), 'utf8'),
      'bridge.js': readFileSync(join(root, 'lib', 'macro', 'bridge.js'), 'utf8'),
      'linkflow.js': flowSrc78,
      'defs/link.js': readFileSync(join(root, 'lib', 'macro', 'defs', 'link.js'), 'utf8'),
      'defs/search.js': readFileSync(join(root, 'lib', 'macro', 'defs', 'search.js'), 'utf8'),
      'store.js': readFileSync(join(root, 'lib', 'macro', 'store.js'), 'utf8'),
      'cost.js': readFileSync(join(root, 'lib', 'macro', 'cost.js'), 'utf8'),
      'panel.js': readFileSync(join(root, 'lib', 'macro', 'panel.js'), 'utf8'),
      'defs/admin.js': readFileSync(join(root, 'lib', 'macro', 'defs', 'admin.js'), 'utf8'),
      'shared.js': readFileSync(join(root, 'lib', 'macro', 'shared.js'), 'utf8'),
      'defs/read.js': readFileSync(join(root, 'lib', 'macro', 'defs', 'read.js'), 'utf8'),
      'prompt.js': readFileSync(join(root, 'lib', 'macro', 'prompt.js'), 'utf8'),
    },
    runtime: await import(pathToFileURL(join(root, 'lib', 'macro', 'contract.js')).href),
    nebIndexSrc: readFileSync(join(root, 'vendor', 'dsh-memory-nebula', 'lib', 'index.js'), 'utf8'),
    nebCoreSrc: readFileSync(join(root, 'vendor', 'dsh-memory-nebula', 'lib', 'host', 'nebula.js'), 'utf8'),
    meowIndexSrc: readFileSync(join(root, 'vendor', 'meow-memory', 'lib', 'index.js'), 'utf8'),
  })
  const mine78 = list78.find((c) => c.id === 'link-args-drop')
  check(
    'link: 判据清单里有 link-args-drop，且整张清单仍全绿（四十五条）',
    list78.length === 45 && mine78?.ok === true && list78.every((c) => c.ok),
    mine78?.detail ?? '缺这一条',
  )
  const fusionSrc78 = readFileSync(join(root, 'tools', 'probe-fusion.mjs'), 'utf8')
  check(
    'link: 真面板探针上钉了这一轮（CD1–CD5：不是数组 / 混坏条目 / 没锚点 / 全好 / 没给）',
    ['CD1', 'CD2', 'CD3', 'CD4', 'CD5'].every((n) => fusionSrc78.includes(`'${n} `)) && fusionSrc78.includes('// ── CD. '),
    'probe-fusion',
  )
  const v78 = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version.split('.').map(Number)
  check('link: 版本不早于 0.2.78', v78[0] === 0 && v78[1] === 2 && v78[2] >= 78, v78.join('.'))
  const readme78 = readFileSync(join(root, 'docs', 'INTERNAL.md'), 'utf8')
  const design78 = readFileSync(join(root, 'DESIGN.md'), 'utf8')
  check(
    'link: README 与 DESIGN 记了这一轮',
    readme78.includes('0.2.78') && readme78.includes('linkDropNote') && design78.includes('0.2.78') && design78.includes('linkDropNote'),
    '文档',
  )
}

const el = () => ({
  style: {},
  dataset: {},
  classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
  setAttribute: noop,
  getAttribute: () => null,
  removeAttribute: noop,
  appendChild: noop,
  removeChild: noop,
  insertBefore: noop,
  addEventListener: noop,
  removeEventListener: noop,
  querySelector: () => null,
  querySelectorAll: () => [],
  children: [],
  innerHTML: '',
  textContent: '',
})
const documentStub = {
  ...el(),
  head: el(),
  body: el(),
  documentElement: el(),
  createElement: el,
  createTextNode: el,
  createDocumentFragment: el,
}
const windowStub = {
  document: documentStub,
  location: { href: 'http://127.0.0.1/', origin: 'http://127.0.0.1', search: '', pathname: '/' },
  navigator: { language: 'zh-CN', languages: ['zh-CN'] },
  localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
  matchMedia: () => ({ matches: false, addEventListener: noop, removeEventListener: noop }),
  addEventListener: noop,
  removeEventListener: noop,
  dispatchEvent: () => true,
  requestAnimationFrame: (fn) => setTimeout(fn, 0),
  cancelAnimationFrame: noop,
  setTimeout,
  clearTimeout,
  setInterval: () => 0,
  clearInterval: noop,
  MutationObserver: class { observe() {} disconnect() {} },
  ResizeObserver: class { observe() {} disconnect() {} },
  IntersectionObserver: class { observe() {} disconnect() {} },
  getComputedStyle: () => ({ getPropertyValue: () => '' }),
  console,
}
windowStub.window = windowStub
windowStub.self = windowStub
windowStub.globalThis = windowStub

const moduleRegistry = new Map()
windowStub.__ModuleLoader__ = {
  load(def) {
    if (moduleRegistry.has(def.id)) throw new Error('duplicate module id: ' + def.id)
    moduleRegistry.set(def.id, def.factory)
  },
}

const react = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  Fragment: Symbol('Fragment'),
  useState: (v) => [typeof v === 'function' ? v() : v, noop],
  useEffect: noop,
  useLayoutEffect: noop,
  useMemo: (f) => f(),
  useCallback: (f) => f,
  useRef: (v) => ({ current: v }),
  useContext: () => ({}),
  createContext: (v) => ({ Provider: null, Consumer: null, _currentValue: v }),
  memo: (c) => c,
  forwardRef: (f) => f,
  cloneElement: (x) => x,
  Children: { map: () => [], toArray: () => [] },
}

const requireStub = (name) => {
  if (name === 'react') return react
  if (moduleRegistry.has(name)) return moduleRegistry.get(name)(requireStub)
  throw new Error('unexpected require: ' + name)
}

const clientCode = readFileSync(join(root, 'lib', 'client.js'), 'utf8')
const runClient = new Function('window', 'document', 'navigator', 'console', 'require', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', clientCode)
runClient(windowStub, documentStub, windowStub.navigator, console, requireStub, setTimeout, clearTimeout, () => 0, noop)

check('client: three module ids registered', moduleRegistry.size === 3, [...moduleRegistry.keys()].join(', '))
check('client: self id present', moduleRegistry.has('dsh-macro-memory'))
check('client: meow id namespaced', moduleRegistry.has('dsh-macro-memory-meow'))
check('client: nebula id namespaced', moduleRegistry.has('dsh-macro-memory-nebula'))
check('client: original meow id NOT claimed', !moduleRegistry.has('meow-memory'))
check('client: original nebula id NOT claimed', !moduleRegistry.has('dsh-memory-nebula'))

const meowUi = moduleRegistry.get('dsh-macro-memory-meow')(requireStub)
const nebulaUi = moduleRegistry.get('dsh-macro-memory-nebula')(requireStub)
check('client: meow ui exports apply', typeof meowUi.apply === 'function')
check('client: meow ui inject', JSON.stringify(meowUi.inject) === JSON.stringify(['slots', 'sessions', 'remote.settings']), JSON.stringify(meowUi.inject))
check('client: meow ui fold dock export', typeof meowUi.MemoryFoldDock === 'function')
check('client: nebula ui exports apply', typeof nebulaUi.apply === 'function')
check('client: nebula ui name', nebulaUi.name === 'memory-nebula', nebulaUi.name)

const self = moduleRegistry.get('dsh-macro-memory')(requireStub)
check('client: self name', self.name === 'macro-memory', self.name)
check(
  'client: self inject = union of both',
  JSON.stringify(self.inject) === JSON.stringify(['slots', 'sessions', 'remote.settings']),
  JSON.stringify(self.inject),
)
const clientPlugins = []
self.apply({ plugin: (mod, cfg) => clientPlugins.push({ name: mod.name, inject: mod.inject, cfg }) })
check('client: two ui sub-plugins mounted', clientPlugins.length === 2, clientPlugins.map((p) => p.name).join(' + '))
check('client: meow ui mounted first', clientPlugins[0]?.name === 'meow-memory-ui')
check('client: nebula ui mounted second', clientPlugins[1]?.name === 'memory-nebula-ui')
check('client: sub-plugin inject carried over', JSON.stringify(clientPlugins[1]?.inject) === JSON.stringify(['slots']), JSON.stringify(clientPlugins[1]?.inject))

// ── A79. 设置页可写（0.2.79）：Config 是唯一写入口；写入后只重建「表面」，子插件不重挂 ──
{
  const WRITE = Symbol.for('cosmokit.volatile.write')
  const makeLiveCtx = () => {
    const tools = new Map()
    const prompts = []
    const handlers = new Map()
    const plugins = []
    const services = {
      tools: {
        register: (def) => {
          tools.set(def.name, def)
          return () => tools.delete(def.name)
        },
      },
      systemPrompt: {
        section: (decl) => {
          prompts.push(decl)
          return () => {
            const index = prompts.indexOf(decl)
            if (index >= 0) prompts.splice(index, 1)
          }
        },
      },
    }
    const base = {
      get: (n) => services[n],
      effect: (fn) => {
        const d = typeof fn === 'function' ? fn() : undefined
        return typeof d === 'function' ? d : noop
      },
      on: (name, fn) => {
        const list = handlers.get(name) ?? []
        list.push(fn)
        handlers.set(name, list)
        return () => {
          const again = handlers.get(name) ?? []
          const index = again.indexOf(fn)
          if (index >= 0) again.splice(index, 1)
        }
      },
      inject: (_deps, cb) => (typeof cb === 'function' ? cb(base) : base),
      plugin: (mod, cfg) => {
        plugins.push({ name: mod?.name, cfg, hasConfig: mod?.Config !== undefined })
        return noop
      },
      tools: services.tools,
      systemPrompt: services.systemPrompt,
      logger: { debug: noop, info: noop, warn: noop, error: noop },
    }
    return { ctx: base, tools, prompts, handlers, plugins }
  }

  const h = makeLiveCtx()
  let snap = { compatAliases: false, guideMaxChars: 1300, homeDir: 'dsh-storage', nebula: {} }
  const root = { get: () => snap, [WRITE]: (value) => { snap = value } }
  host.apply(h.ctx, root)
  check('设置: 平铺配置下工具面 8 个', h.tools.size === 8, String(h.tools.size))
  check('设置: 注入只有一段', h.prompts.length === 1, String(h.prompts.length))
  check('设置: 订阅了 loader/volatile-update', (h.handlers.get('loader/volatile-update') ?? []).length === 1)
  check(
    '设置: 引擎拿到的是普通对象（宿主那种 volatile 引用它不认）',
    host.isVolatileRef(h.plugins[0]?.cfg) === false && h.plugins[0]?.cfg?.homeDir === 'dsh-storage',
    JSON.stringify(h.plugins[0]?.cfg),
  )
  check(
    '设置: 包装子插件时没把 Config 带过去（否则宿主拿我们的大 schema 去解它的配置）',
    h.plugins.every((p) => p.hasConfig === false),
    h.plugins.map((p) => `${p.name}:${p.hasConfig}`).join(','),
  )

  const fire = (paths) => {
    for (const fn of h.handlers.get('loader/volatile-update') ?? []) fn(paths)
  }

  // 宿主写一次 compatAliases=true：引用原地更新 → 去抖后重建工具面
  root[WRITE]({ ...snap, compatAliases: true })
  fire([['compatAliases']])
  await new Promise((resolve) => setTimeout(resolve, 300))
  const names = [...h.tools.keys()]
  check('设置: 写入 compatAliases 后别名工具补回来了', names.filter((n) => n.startsWith('nebula_')).length === 9 && names.includes('memory_home'), String(names.filter((n) => n.startsWith('nebula_')).length))
  check('设置: 重建后注入仍只有一段（旧的先拆再装）', h.prompts.length === 1, String(h.prompts.length))
  check('设置: 重建后统一工具一个没丢', UNIFIED.every((n) => names.includes(n)), names.length + ' 个工具')

  // 只改 meow 自己的字段：它的配置是装配时拍下的快照，热写改不到 —— 只能重挂那一只引擎
  const meowBefore = h.plugins.length
  root[WRITE]({ ...snap, hitTopK: 5 })
  fire([['hitTopK']])
  await new Promise((resolve) => setTimeout(resolve, 300))
  check(
    '设置: 改 meow 字段会重挂记忆引擎（配置快照否则不会变）',
    h.plugins.length === meowBefore + 1 && h.plugins.at(-1)?.cfg?.hitTopK === 5,
    `${meowBefore} → ${h.plugins.length}：${JSON.stringify(h.plugins.at(-1)?.cfg)}`,
  )
  check('设置: 引擎重挂后统一工具一个没丢', UNIFIED.every((n) => h.tools.has(n)), `${h.tools.size} 个工具`)

  // 改 nebula 段：只重挂星图那一只，别顺手把 meow 也拆了
  const nebulaBefore = h.plugins.length
  root[WRITE]({ ...snap, nebula: { threshold: 0.5 } })
  fire([['nebula']])
  await new Promise((resolve) => setTimeout(resolve, 300))
  check(
    '设置: 改 nebula 段只重挂星图引擎',
    h.plugins.length === nebulaBefore + 1 && JSON.stringify(h.plugins.at(-1)?.cfg) === '{"threshold":0.5}',
    `${nebulaBefore} → ${h.plugins.length}：${JSON.stringify(h.plugins.at(-1)?.cfg)}`,
  )

  // 类型不对的写入要被 Config 拦下（设置页 decode 就靠这个判断「能不能写」）
  let threw = false
  try {
    host.Config({ compatAliases: 'yes' })
  } catch {
    threw = true
  }
  check('设置: 类型不对的写入被 Config 拦下', threw)
}

// ── A80. 口径统一（0.2.80）：注入卡的来源不再叫 plugin:meow-memory，但老消息仍要认得 ──
{
  const readSrc = (rel) => readFileSync(join(root, rel), 'utf8')
  // 源码里非 ASCII 以 \uXXXX 形式存，比较前先把待查串编码成同样形式
  const esc = (s) => [...s].map((ch) => {
    const c = ch.codePointAt(0)
    return c >= 0x20 && c < 0x7f ? ch : '\\u' + c.toString(16).toUpperCase().padStart(4, '0')
  }).join('')

  const meowHost = readSrc('vendor/meow-memory/lib/index.js')
  const blockStart = meowHost.indexOf('var PLUGIN_NAME = "meow-memory";')
  const blockEnd = meowHost.indexOf('// src/dream.ts', blockStart)
  const source = blockStart >= 0 && blockEnd > blockStart
    ? new Function(`${meowHost.slice(blockStart, blockEnd)}; return { isMeowSource, PLUGIN_KIND, PLUGIN_SOURCE };`)()
    : null
  check('口径: vendor meow 把来源 kind 定成 plugin:macro-memory', source?.PLUGIN_KIND === 'plugin:macro-memory' && source?.PLUGIN_SOURCE?.kind === 'plugin:macro-memory', String(source?.PLUGIN_KIND))
  check(
    '口径: 新 kind 认、老 kind 也认、别的插件不认',
    source?.isMeowSource({ kind: 'plugin:macro-memory' }) === true
      && source?.isMeowSource({ kind: 'plugin:meow-memory' }) === true
      && source?.isMeowSource({ kind: 'plugin', plugin: 'meow-memory' }) === true
      && source?.isMeowSource({ kind: 'plugin:hindsight' }) === false
      && source?.isMeowSource(null) === false,
    'isMeowSource 行为',
  )

  const bundle = readSrc('lib/client.js')
  check('口径: 客户端包里也写着 plugin:macro-memory（老快照一起认）', bundle.includes('var PLUGIN_KIND = "plugin:macro-memory";') && bundle.includes('LEGACY_PLUGIN_KINDS.includes(record.kind)'))

  const transcripts = readSrc('vendor/dsh-memory-nebula/lib/host/transcripts.js')
  check(
    '口径: 星图的工具归因表把记忆类工具算到 plugin:macro-memory',
    transcripts.includes("memory_search: 'plugin:macro-memory'")
      && transcripts.includes("nebula_recall: 'plugin:macro-memory'")
      && transcripts.includes("nebula_bridge: 'plugin:macro-memory'")
      && !transcripts.includes('plugin:meow-memory')
      && !transcripts.includes('plugin:dsh-memory-nebula'),
  )

  check('口径: 设置页中文文案不再说「喵记忆」', bundle.includes(`"settings.loading": "${esc('宏记忆配置加载中')}`) && !bundle.includes(`"${esc('喵记忆配置加载中')}`))
  check(
    '口径: 保存后不再谎称「要重启 meow-memory 插件」（0.2.79 起是热应用）',
    bundle.includes(`"settings.saved": "${esc('已保存 ✓ 已生效')}"`)
      && !bundle.includes(esc('热重载/重启 meow-memory 插件后生效')),
  )
  check(
    '口径: 写不进去时不再拿「仅本机回环连接可编辑」当挡箭牌',
    !bundle.includes(esc('仅本机回环连接可编辑')),
  )
}

// ── A81. 调试仪器带上生产（0.2.81）：设置链路诊断默认不出声，日志有上限 ──
{
  const meowSrc = readFileSync(join(root, 'vendor/meow-memory/lib/index.js'), 'utf8')
  check(
    '诊断: 设置链路的日志默认关着，只有显式打开才写',
    meowSrc.includes('var SETTINGS_DIAG_ON = process.env.DSH_MEMORY_SETTINGS_DIAG === "1";'),
  )
  check(
    '诊断: 除了那个开关所在的 helper，源码里再没有别处直接往 settings-diag.log 写',
    (meowSrc.match(/settings-diag\.log/g) ?? []).length === 1,
  )
  check(
    '诊断: 关闭时 describe 快照一次都不 dump（连 5 秒后的那次也跳过）',
    meowSrc.includes('const dumpDescribe = () => {\n            if (!SETTINGS_DIAG_ON) return;'),
  )
  check(
    '诊断: 日志有 256 KiB 上限，超了从尾巴重开（不然一天能长到一百多 KB）',
    meowSrc.includes('var SETTINGS_DIAG_MAX_BYTES = 256 * 1024;') && meowSrc.includes('st.size > SETTINGS_DIAG_MAX_BYTES'),
  )
  check(
    '诊断: 开关打开时仍然照常写（不是把功能删了，是默认不出声）',
    meowSrc.includes('function settingsDiag(line) {\n  if (!SETTINGS_DIAG_ON) return;'),
  )
}

// ── A82. 不跑的脚本会烂（0.2.82）：probe-toolsize 从死到进 check-all，并自己出判决 ──
// 它 0.2.7x 起就 ReferenceError（用了没导入的 `root`），因为没人跑、也没断言盯着，坏了很久没人知道。
// 语法检查（node --check）抓不到这种错，只有真跑一次才算数 → 所以必须进 check-all。
{
  const probeSrc = readFileSync(join(root, 'tools/probe-toolsize.mjs'), 'utf8')
  const checkAllSrc = readFileSync(join(root, 'tools/check-all.mjs'), 'utf8')
  check(
    '脚本: probe-toolsize 进了 check-all 的 STEPS（不跑的脚本一定会烂）',
    checkAllSrc.includes("['tools/probe-toolsize.mjs'"),
  )
  check(
    '脚本: 它取根走 _root.mjs 的 vendorDir，没有裸 root',
    probeSrc.includes("import { vendorDir } from './_root.mjs'") && !/scan\(root\b|\broot \+ '\//.test(probeSrc),
  )
  check(
    '脚本: 它自己会判「17 个原工具一个不少」（meow 8 + 星图 9）',
    /const MEOW_TOOLS = \[[\s\S]{0,400}?\]/.test(probeSrc) &&
      (probeSrc.match(/'(memory|nebula)_[a-z_]+'/g) ?? []).length >= 17 &&
      probeSrc.includes('ok(missingM.length === 0') &&
      probeSrc.includes('ok(missingN.length === 0'),
  )
  // 0.2.85：上界从「等于今天实测值」改成留余量（87,326 → 92,000）。
  // 等于实测值的判据在正当改动上也会红（只加一个 explain 字段就踩线），
  // 那会教人「红了就往上调」，最后等于没有判据；留 5% 余量才抓得住真正的膨胀。
  check(
    '脚本: 体积有上限判据（92,000，留 ~5% 余量而不是等于实测值），膨胀就红',
    probeSrc.includes('const BUDGET_BYTES = 92000') && probeSrc.includes('ok(sum <= BUDGET_BYTES'),
  )
  check(
    '脚本: 失败时置 exitCode 1（check-all 才看得见）',
    probeSrc.includes('if (failures !== 0) process.exitCode = 1'),
  )
}

// ── A83. 装一个探测器，而不是再修一个脚本（0.2.83）──
// 0.2.82 修了 probe-toolsize 的裸 root，紧接着发现 cost-baseline 有一模一样的错。
// 结论：这不是手滑，是一整类（没被执行的脚本会安静地烂）。所以这一轮装探测器：
//   tools/manual-tools.mjs 是「手动脚本」的账本，tools/probe-tools.mjs 判「有没有归不了类的脚本」、
//   判「有没有白用 _root.mjs 的导出」、并把标了 smoke 的只读脚本真跑一遍。
{
  const checkAllSrc = readFileSync(join(root, 'tools/check-all.mjs'), 'utf8')
  const probeTools = readFileSync(join(root, 'tools/probe-tools.mjs'), 'utf8')
  const manualSrc = readFileSync(join(root, 'tools/manual-tools.mjs'), 'utf8')
  const costSrc = readFileSync(join(root, 'tools/cost-baseline.mjs'), 'utf8')

  check(
    '账本: 手动脚本账本存在且被探测器 import（数据与判据分开）',
    manualSrc.includes('export const MANUAL_TOOLS') && probeTools.includes("import { MANUAL_TOOLS } from './manual-tools.mjs'"),
  )
  check(
    '账本: 每条手动脚本都带 smoke 与 why（不许「没说」）',
    (manualSrc.match(/smoke: (true|false)/g) ?? []).length >= 5 && (manualSrc.match(/why: '/g) ?? []).length >= 5,
  )
  check(
    '账本: probe-tools 进了 check-all 的 STEPS（探测器自己也被执行）',
    checkAllSrc.includes("['tools/probe-tools.mjs'"),
  )
  check(
    '账本: probe-tools 自己会判「每个脚本都有归属」与「白用 _root 导出」',
    probeTools.includes('ok(\n  unclassified.length === 0') &&
      probeTools.includes('function findFreeVars(raw)') &&
      probeTools.includes("'自由变量：_root.mjs 的导出（'"),
  )
  check(
    '账本: 有阴性对照（拿已知写坏的片段验探测器自己）',
    probeTools.includes("ok(findFreeVars(\"const a = readFileSync(root + '/x', 'utf8')\").includes('root')") &&
      probeTools.includes("ok(findFreeVars(\"const at = hay.indexOf(x)") &&
      probeTools.includes("ok(classify('tools/__nope__.mjs') === 'orphan'"),
  )
  check(
    '账本: 冒烟只跑标了 smoke 的，且真跑（不是读代码猜）',
    probeTools.includes('for (const m of smokeList)') && probeTools.includes('spawnSync(process.execPath, [join(root, m.file)'),
  )
  check(
    '脚本: cost-baseline 的裸 root 也修了（同一类错的第二例）',
    costSrc.includes("import { vendorDir } from './_root.mjs'") && !/readFileSync\(root \+/.test(costSrc),
  )
  check(
    '脚本: cost-baseline 进账本且标了 smoke（只读，可随时跑）',
    /file: 'tools\/cost-baseline\.mjs',\n\s+smoke: true/.test(manualSrc),
  )
}

// ── A84. 口径总账：同一件事只许有一种说法（0.2.84）──
// 「8 个工具 / 七个 level / action 枚举 / 体检六类 / 注入 1,085 字符」这些话同时活在
// 注入手册、schema、代码常量、README 与两份市场索引里。漏改一处不会报错，
// 只会让模型照手册去调一个不存在的东西、让用户读到已成历史的数字。
// tools/probe-words.mjs 从代码里取真值再逐处比对；这一节钉住「它存在、它在跑、它真会红」。
{
  const checkAllSrc = readFileSync(join(root, 'tools/check-all.mjs'), 'utf8')
  const wordsSrc = readFileSync(join(root, 'tools/probe-words.mjs'), 'utf8')

  check(
    '口径: probe-words 进了 check-all 的 STEPS（总账真的会被对一遍）',
    checkAllSrc.includes("['tools/probe-words.mjs'"),
  )
  // 判据不许自带第二份清单：真值必须从代码里取（工具名/动作表/常量/手册）。
  check(
    '口径: 真值从 lib 里取，不在探针里抄一份名单',
    wordsSrc.includes('createUnifiedTools({ bridge: stub') &&
      wordsSrc.includes("import { LEVELS, PROJECT_SUBCATEGORIES } from '../lib/macro/shared.js'") &&
      wordsSrc.includes("import { GUIDE_TEXT, NAV_TEXT } from '../lib/macro/prompt.js'") &&
      wordsSrc.includes("import { ACTIONS } from '../lib/macro/defs/admin.js'"),
  )
  // 三组核心比对：手册↔动作表、手册↔LEVELS、对外数字↔实测注入长度。
  check(
    '口径: 手册动作枚举与动作表逐字比、LEVELS 与手册名单比、字符数与 README/索引比',
    wordsSrc.includes('actionsInGuide === actionKeys') &&
      wordsSrc.includes('LEVELS.every((l) => levelsInGuide.includes(l))') &&
      wordsSrc.includes("join(root, 'plugin-market', 'index.cn.json')"),
  )
  // 死指针：旧名字既不能出现在工具说明里，也不能出现在注入手册里。
  check(
    '口径: 判死指针（工具说明与注入手册都不许再出现旧工具名）',
    wordsSrc.includes("const OLD = ['nebula_', 'memory_find_similar', 'memory_home', 'meow-memory']") &&
      wordsSrc.includes("'死指针：8 个工具的说明里没有旧工具名/旧插件名'"),
  )
  // 阴性对照：解析器与检测器必须证明自己抓得住坏输入（教训 59）。
  check(
    '口径: 有阴性对照（谎报的字符数、认不出的模式都会被抓住）',
    wordsSrc.includes('function claimedGuideLengths(text)') &&
      wordsSrc.includes("claimedGuideLengths('常驻注入 1,086 字符')") &&
      wordsSrc.includes("modeTokens('这里没有模式').length === 0"),
  )
  // 这一探针自己也得有归属与出口：失败必须置非零，否则 check-all 会把它当绿的。
  check(
    '口径: 失败时自己把 exitCode 置非零（不然红也读不出来）',
    wordsSrc.includes('if (failures !== 0) process.exitCode = 1'),
  )
}

// ── A85. 召回校准：最相关的排最前，重要度要进分数（0.2.85）──
// 0.2.85 修的是 meow 引擎里两件「安静的错」：
//   ① search() 里 importance 只用来豁免时间衰减、从不进分数——一条 importance=4 的铁律
//      会因为措辞差一点就排到 importance=1 的随手记后面；
//   ② 渲染前按 updated_at 升序重排，把算出来的相关度整个丢掉——模型读到的第一条永远最旧。
// 两处都在 vendor 里，坏起来一声不响（照样有结果、照样有分数），所以必须被钉住。
{
  const meowSrc = readFileSync(join(root, 'vendor/meow-memory/lib/index.js'), 'utf8')
  const checkAllSrc = readFileSync(join(root, 'tools/check-all.mjs'), 'utf8')
  const recallSrc = readFileSync(join(root, 'tools/probe-recall.mjs'), 'utf8')

  check(
    '召回: 重要度乘数进了打分（score = raw × w × impW，且 impW 与 keywordHitScore 同口径 0.25）',
    meowSrc.includes('const impW = 1 + (impOf(docs[di]) - 1) * 0.25;') &&
      meowSrc.includes('score: raw[di] * w * impW,'),
  )
  check(
    '召回: explain 把 importanceWeight 也露出来（三个因子缺一个就没法解释排序）',
    meowSrc.includes('importanceWeight: Math.round(impW * 1e3) / 1e3') &&
      meowSrc.includes('importanceWeight: h.explain?.importanceWeight ?? 1'),
  )
  check(
    '召回: 渲染顺序按相关度降序，updated_at 只做平手时的次级',
    meowSrc.includes('const reordered = [...hits].sort((a, b) => (b.score - a.score) || ((b.updated_at ?? 0) - (a.updated_at ?? 0)));') &&
      !meowSrc.includes('const reordered = [...hits].sort((a, b) => (a.updated_at ?? 0) - (b.updated_at ?? 0));'),
  )
  check(
    '召回: probe-recall 进了 check-all 的 STEPS（校准真的会被跑一遍）',
    checkAllSrc.includes("['tools/probe-recall.mjs'"),
  )
  // 探针必须用真引擎真工具，不许自己复写一份打分公式——复写出来的「判据」验的是抄件。
  check(
    '召回: 探针用真 vendor（registerMemoryTools + 真 memory_search），不自己算分',
    recallSrc.includes('V.registerMemoryTools((t) => T.set(t.name, t),') &&
      recallSrc.includes("await call('memory_search', { query: '部署'") &&
      recallSrc.includes('V.search('),
  )
  // 阴性对照：同一语料上「抹平重要度」和「按时间升序」都必须给出另一个答案，
  // 否则那两条判据是恒真的注释（教训 59 / 教训 60 的同一课）。
  check(
    '召回: 有阴性对照（抹平 importance 顺序会翻、按时间升序首条会变）',
    recallSrc.includes("flat[0]?.id === ids.casual") &&
      recallSrc.includes("byTime[0]?.id !== hitsR1[0]?.id"),
  )
  check(
    '召回: 失败时自己把 exitCode 置非零（不然红也读不出来）',
    recallSrc.includes('if (failures !== 0) process.exitCode = 1'),
  )
}

// ── A86. 检索的相关度下限：尾巴要收、但不能把结果收空（0.2.86）──
// 30 条语料实测的分数断崖：榜首 14.08 分时，第 3 条起只有 0.33——那些是「只沾一个词」的条目，
// 照样占 k 名额、照样被当成相关读。所以给 memory_search 加 min_rel（默认 0.35）。
// 这里钉三件事：下限真的在滤、排序第一位永远不被滤掉、收掉的东西要说出来并且能关掉。
{
  const meowSrc = readFileSync(join(root, 'vendor/meow-memory/lib/index.js'), 'utf8')
  const searchSrc = readFileSync(join(root, 'lib/macro/defs/search.js'), 'utf8')
  const recallSrc = readFileSync(join(root, 'tools/probe-recall.mjs'), 'utf8')

  check(
    '下限: memory_search 有 min_rel（默认 0.35、限 0–1、夹边界时说清按多少算）',
    meowSrc.includes('min_rel: { type: "number", minimum: 0, maximum: 1, default: 0.35') &&
      meowSrc.includes('const minRel = relRaw !== void 0') &&
      meowSrc.includes('const relClamped = relGiven && (relRaw === void 0 || relRaw < 0 || relRaw > 1)') &&
      meowSrc.includes('不在 0–1 里'),
  )
  check(
    '下限: 排序第一位永远留着（下限再高也不许把结果收空），且先按分数线滤再折叠（折叠只动尾巴不动榜首）',
    meowSrc.includes(
      'const aboveFloor = minRel > 0 && topScore > 0 ? ranked.filter((h, i) => i === 0 || h.score >= topScore * minRel) : ranked;',
    ) && meowSrc.indexOf('const aboveFloor') < meowSrc.indexOf('foldNearDupes(aboveFloor)'),
  )
  check(
    '下限: 被收掉的尾巴要报数（还剩几条、最高几分），并给出 min_rel=0 的出路',
    meowSrc.includes('const belowFloor = ranked.length - aboveFloor.length') &&
      meowSrc.includes('要看全量就传 min_rel=0'),
  )
  check(
    '下限: 融合层三处参数白名单都带 min_rel（不然 macro 侧传下去也被丢掉），schema 也有',
    (searchSrc.match(/'min_rel'/g) || []).length >= 3 && /min_rel: \{ type: 'number'/.test(searchSrc),
  )
  check(
    '下限: probe-recall 有 R5 组，含「关掉下限尾巴回来」的阴性对照与越界夹回',
    recallSrc.includes("key: 'tail1'") &&
      recallSrc.includes('min_rel: 0') &&
      recallSrc.includes('min_rel: 5') &&
      recallSrc.includes('另有 '),
  )
}

// [macro-fusion 0.2.87] 「合并」以前是「拿这次的参数把旧条目整条盖掉」：关键词被整个换掉（检索就漏）、
// 归属被搬到另一个项目（回执不提）、更短的新内容把旧细节吃掉（实测 78 字 → 67 字，尾句消失）。
// 现在合并只做加法。这里钉四件事：并集而不是覆盖、归属冲突不动且说明、变短默认不换但有 overwrite 出口、
// 以及新探针 probe-merge 真的进了 check-all。
{
  const meowSrc = readFileSync(join(root, 'vendor/meow-memory/lib/index.js'), 'utf8')
  const mergeSrc = readFileSync(join(root, 'tools/probe-merge.mjs'), 'utf8')
  const macroRemember = readFileSync(join(root, 'lib/macro/defs/remember.js'), 'utf8')
  const checkAllSrc = readFileSync(join(root, 'tools/check-all.mjs'), 'utf8')

  check(
    '合并: 关键词取并集（旧的一条不删，新的并进来），不再整条替换',
    meowSrc.includes('for (const k of [...kwOld, ...asked.keywords]) {') &&
      meowSrc.includes('const patch = { importance: impNext, keywords: kwUnion };') &&
      !meowSrc.includes('patch.keywords = keywords;'),
  )
  check(
    '合并: 归属冲突时不搬（保留旧 project）并把冲突说出来',
    meowSrc.includes('const projKept = projOld.length > 0 && asked.project !== projOld;') &&
      meowSrc.includes('if (!projKept && asked.project) patch.project = asked.project;') &&
      meowSrc.includes('归属没改：这条原属'),
  )
  check(
    '合并: 内容变短且非逐字默认不换，overwrite: true 才换（保护不是不能更新）',
    meowSrc.includes('const shrink = asked.content.length < oldContent.length && sim < 0.98;') &&
      meowSrc.includes('const holdContent = shrink && !asked.overwrite;') &&
      meowSrc.includes('if (!holdContent) patch.content = asked.content;') &&
      meowSrc.includes('确实要换成短的，传 overwrite: true') &&
      meowSrc.includes('overwrite: { type: "boolean", default: false, description: T("memory_remember.param.overwrite") }'),
  )
  check(
    '合并: 回执逐项报账（关键词条数 / importance 结论 / 内容换没换），不是只说一句「已合并」',
    meowSrc.includes('关键词并进了 ${kwAdded.length} 条') &&
      meowSrc.includes('importance 从 ${impOld} 提到 ${impNext}') &&
      meowSrc.includes('内容没换：旧 ${oldContent.length} 字、这次 ${asked.content.length} 字'),
  )
  check(
    '合并: 账本逻辑在工具字面量外面（applyMerge 定义在 rememberTool 之前，体积预算别被说明书吃掉）',
    meowSrc.includes('function applyMerge(db, level, merged, asked) {') &&
      meowSrc.indexOf('function applyMerge(db, level, merged, asked) {') < meowSrc.indexOf('function rememberTool(dir) {'),
  )
  check(
    '合并: 融合层把 overwrite 传下去（不传就等于接口写了不生效），schema 也有',
    macroRemember.includes("'corrected', 'keywords', 'overwrite'") && /overwrite: \{\n\s+type: 'boolean'/.test(macroRemember),
  )
  check(
    '合并: probe-merge 进了 check-all 的 STEPS，且带阴性对照（旧写法确实会丢东西）',
    checkAllSrc.includes("['tools/probe-merge.mjs'") &&
      mergeSrc.includes('db.update(\'user\', e1.id, { content: SHORT, keywords: [\'上线\'], project: \'乙项目\' })') &&
      mergeSrc.includes('M7 阴性对照'),
  )
}

// [macro-fusion 0.2.88] 写去重只在同一层里比（db.list(level)），所以同一句话既记 fact 又记 lesson
// 会真的落下两份：实测检索时两条分数一模一样（1.280 / 1.280）并排端出来，白占一个 k 名额、
// 同一段字要让模型读两遍，全程一声不响。这里钉四件事：写的时候点名「另一层已有」、检索时折叠
// 逐字级重复、折叠必须带 dedupe: false 出口（教训 63）、以及新探针 probe-dup 真的进了 check-all。
{
  const meowSrc = readFileSync(join(root, 'vendor/meow-memory/lib/index.js'), 'utf8')
  const dupSrc = readFileSync(join(root, 'tools/probe-dup.mjs'), 'utf8')
  const checkAllSrc = readFileSync(join(root, 'tools/check-all.mjs'), 'utf8')

  check(
    '跨层重复: 写的时候扫别的层（跳过本层），撞上就说出来而不是闷声写两份',
    meowSrc.includes('function crossLevelDupe(db, level, content) {') &&
      meowSrc.includes('if (lv === level) continue;') &&
      meowSrc.includes('if (sim >= DEDUP_THRESHOLD && (!best || sim > best.sim)) best = { id: r.id, level: lv, sim };') &&
      meowSrc.includes('const crossNote = crossLevelNote(crossLevelDupe(db, level, content), db);'),
  )
  check(
    '跨层重复: 点名要带层名、短 id、重复度，并给出两条出路（归档 / 把措辞写开）',
    // 0.2.92：这里的短 id 改成 uniqueShortId 算出来的不撞前缀（原来直接 slice(0, 8)，
    // 同一批写下的两条会印成同一个 id，拿着它去 memory_update 会撞上歧义拒绝）。
    meowSrc.includes('另一层已有几乎一样的条目（${hit.level} ${shortId}，重复度 ${Math.round(hit.sim * 100)}%）') &&
      meowSrc.includes('const shortId = db === undefined ? hit.id.slice(0, 8) : uniqueShortId(db, hit.level, hit.id);') &&
      meowSrc.includes('status 设 archived') &&
      meowSrc.includes('把措辞写开一点'),
  )
  check(
    '跨层重复: 检索侧折叠逐字级重复，且只折在分数排序之后（保留榜首那条）',
    meowSrc.includes('function foldNearDupes(hits) {') &&
      meowSrc.includes('kept.some((k) => similarity(k.content ?? "", h.content ?? "") >= DEDUP_THRESHOLD)') &&
      meowSrc.includes('const foldedRes = dedupeOn ? foldNearDupes(aboveFloor) : { kept: aboveFloor, folded: 0 };'),
  )
  check(
    '跨层重复: 折叠报条数、说清常见成因，并给 dedupe: false 出口（收窄必带出口）',
    meowSrc.includes('另有 ${foldedRes.folded} 条内容几乎一样（重复度 ≥${Math.round(DEDUP_THRESHOLD * 100)}%）没重复列') &&
      meowSrc.includes('要看全量传 dedupe: false') &&
      meowSrc.includes('dedupe: { type: "boolean", default: true, description: T("memory_search.param.dedupe") }'),
  )
  check(
    '跨层重复: 折叠不占 k 名额（blind/fresh 都从 unique 切，不是从折叠前的 aboveFloor 切）',
    meowSrc.includes('const unique = foldedRes.kept;') &&
      meowSrc.includes('const blind = unique.slice(0, blindCount);') &&
      meowSrc.includes('for (const h of unique.slice(blindCount)) {') &&
      !meowSrc.includes('const blind = aboveFloor.slice(0, blindCount);'),
  )
  check(
    '跨层重复: 两处辅助函数在工具字面量外面（体积预算；且注释说明实测分数）',
    meowSrc.indexOf('function foldNearDupes(hits) {') < meowSrc.indexOf('function rememberTool(dir) {') &&
      meowSrc.includes('1.280 / 1.280'),
  )
  check(
    '跨层重复: probe-dup 进了 check-all 的 STEPS，且带阴性对照（dedupe: false 回两条）',
    checkAllSrc.includes("['tools/probe-dup.mjs'") && dupSrc.includes("dedupe: false") && dupSrc.includes('M4 阴性对照'),
  )
  const searchDefSrc = readFileSync(join(root, 'lib/macro/defs/search.js'), 'utf8')
  check(
    '跨层重复: 融合层三处参数白名单都带 dedupe（不然 macro 侧传下去也被丢掉），schema 也有',
    (searchDefSrc.match(/'dedupe'\]/g) || []).length >= 3 && /dedupe: \{ type: 'boolean'/.test(searchDefSrc),
  )
}


// [macro-fusion 0.2.89] 相似检索的两处口径错位：① 候选把「本会话新写的」整批排掉——可「我刚写了
// 这几条，谁跟谁像」正是它最自然的用法，实测三条相关记忆写完回执是「可比的候选一条都没有……等
// 下一次会话再问」；② 基准只拿正文去比、候选取的是 title + 正文 + keywords——同一把尺子两边量的
// 字不一样，实测「只沾基准 keywords」的候选在正文口径下 0.000 分（被 s<=0 直接丢掉），基准也走
// docText 才 0.228。这里钉五件事：一把尺子、会话不再兼职去重、端过的仍然排除、刚写的要点名、探针进线。
{
  const meowSrc = readFileSync(join(root, 'vendor/meow-memory/lib/index.js'), 'utf8')
  const simSrc = readFileSync(join(root, 'tools/probe-similar.mjs'), 'utf8')
  const checkAllSrc = readFileSync(join(root, 'tools/check-all.mjs'), 'utf8')
  const zhSrc = readFileSync(join(root, 'vendor/meow-memory/lib/prompts/zh/tools.md'), 'utf8')
  const enSrc = readFileSync(join(root, 'vendor/meow-memory/lib/prompts/en/tools.md'), 'utf8')
  const ptSrc = readFileSync(join(root, 'vendor/meow-memory/lib/prompts/pt-br/tools.md'), 'utf8')

  check(
    '相似检索: 基准和候选量的是同一段文字（基准也走 docText，不再只取正文）',
    meowSrc.includes('const hits = findSimilar(docText(found.row), docs, k, found.row.content);') &&
      !meowSrc.includes('const hits = findSimilar(found.row.content, docs, k);') &&
      meowSrc.includes('function docText(d) {'),
  )
  check(
    '相似检索: 候选不再按会话身份整批排掉（seen 仍然排除——「别重复端」是 seen 的活）',
    meowSrc.includes('const candidates = rows.filter((r) => r.id !== found.row.id && !seen.has(r.id));') &&
      !meowSrc.includes('r.source_session !== sessionId);'),
  )
  check(
    '相似检索: 本会话刚写的命中要点名（别把「我刚记的」当成「已有依据」）',
    meowSrc.includes('const freshHits = hits.filter((h) => rows.some((r) => r.id === h.id && r.source_session === sessionId));') &&
      meowSrc.includes('命中里有 ${freshHits.length} 条是本会话刚写的'),
  )
  check(
    '相似检索: 空结果的解释跟着改口径（不再说「本会话新写的」被排除，也不再叫人等下一次会话）',
    meowSrc.includes('这一轮已经端给你看过的都排除了') &&
      !/本会话新写的和这一轮已看过的都被排除了/.test(meowSrc) &&
      !/或等下一次会话再问/.test(meowSrc),
  )
  check(
    '相似检索: 三语文案写明「同一段文字 / 同一把尺子」，且不再写「只检索其他会话建立的记忆」',
    /基准和候选用的是同一段文字/.test(zhSrc) &&
      /one ruler for both sides/.test(enSrc) &&
      /a mesma régua para os dois lados/.test(ptSrc) &&
      !/同样只检索其他会话建立的记忆/.test(zhSrc),
  )
  check(
    '相似检索: probe-similar 进了 check-all 的 STEPS，且带阴性对照（正文口径 0.000 / 换会话不再点名）',
    checkAllSrc.includes("['tools/probe-similar.mjs'") &&
      simSrc.includes('M2 基准自己的 keywords 真的参与了比较') &&
      simSrc.includes('M5 阴性对照') &&
      simSrc.includes('M4 这一轮已经端过的照样排除'),
  )
}

// [macro-fusion 0.2.90] 「相似」在这个库里有两只尺子：cosine（排序用，对长文宽容）和词集 Jaccard
// （写侧 80% 合并门槛用的那把）。0.2.89 前后只报 cosine，于是「长条目里嵌着同一句话」报 0.715 就会被
// 读成「这句早就记过了」；而写侧对同一对内容报的「重复度 81%」在相似检索里根本无处可查。这里钉六件事：
// 两个数都报、repeat 与写侧同源（都只比正文）、Jaccard 只有一处实现、两种误读各有校准句、排序没被动、
// 探针进了线。实测同一对内容：近重复 0.944 / 0.808；长文嵌一句 0.545 / 0.407；同话题 0.134 / 0.025。
{
  const meowSrc = readFileSync(join(root, 'vendor/meow-memory/lib/index.js'), 'utf8')
  const rulerSrc = readFileSync(join(root, 'tools/probe-ruler.mjs'), 'utf8')
  const checkAllSrc = readFileSync(join(root, 'tools/check-all.mjs'), 'utf8')
  const searchSrc = readFileSync(join(root, 'lib/macro/defs/search.js'), 'utf8')
  const zhSrc = readFileSync(join(root, 'vendor/meow-memory/lib/prompts/zh/tools.md'), 'utf8')
  const enSrc = readFileSync(join(root, 'vendor/meow-memory/lib/prompts/en/tools.md'), 'utf8')
  const ptSrc = readFileSync(join(root, 'vendor/meow-memory/lib/prompts/pt-br/tools.md'), 'utf8')

  check(
    '相似检索: 两个数都报出来（similarity 排序用 / repeat 逐字级），不只报 cosine',
    meowSrc.includes('repeat: Math.round(overlapOfSets(repeatSet, new Set(tokenize(d.content ?? ""))) * 1e3) / 1e3') &&
      meowSrc.includes('similarity: Math.round(s * 1e3) / 1e3'),
  )
  check(
    '相似检索: repeat 与写侧合并判据同源——都只比正文（keywords / title 只参与 cosine 排序）',
    meowSrc.includes('const repeatSet = new Set(tokenize(targetContent === undefined ? target : targetContent));') &&
      meowSrc.includes('function similarity(a, b) {\n  return overlapOfSets(') &&
      !/function similarity\(a, b\) \{\n  const sa = new Set/.test(meowSrc),
  )
  check(
    '相似检索: Jaccard 只有一处实现（similarity 与 repeat 都走 overlapOfSets，防两套口径漂移）',
    meowSrc.includes('function overlapOfSets(sa, sb)') &&
      (meowSrc.match(/function overlapOfSets\(/g) || []).length === 1 &&
      (meowSrc.match(/overlapOfSets\(/g) || []).length >= 3,
  )
  check(
    '相似检索: 两种误读都有校准句（看着像其实不是同一句 / 逐字 ≥80% 写侧会判重复）',
    meowSrc.includes('function similarCalibNote(hits, freshHits)') &&
      meowSrc.includes('const looksLike = hits.filter((h) => h.similarity >= 0.5 && h.repeat < 0.5);') &&
      meowSrc.includes('其中 ${looksLike.length} 条看着像、其实不是同一句') &&
      meowSrc.includes('const verbatim = hits.filter((h) => h.repeat >= DEDUP_THRESHOLD);'),
  )
  check(
    '相似检索: 排序仍只按 cosine（多报一个数没有偷偷改排序，也没有按 repeat 重排）',
    meowSrc.includes('scored.sort((a, b) => b.similarity - a.similarity);') &&
      !/scored\.sort\(\(a, b\) => b\.repeat/.test(meowSrc),
  )
  check(
    '相似检索: 校准句在工具字面量外（否则工具体积预算当场爆）+ 三语文案都有 repeat 这一键',
    meowSrc.indexOf('function similarCalibNote(') < meowSrc.indexOf('function rememberTool(dir) {') &&
      /memory_find_similar\.out\.hits\.repeat:/.test(zhSrc) &&
      /memory_find_similar\.out\.hits\.repeat:/.test(enSrc) &&
      /memory_find_similar\.out\.hits\.repeat:/.test(ptSrc),
  )
  // 注释里会提到旧文案（那正是记录），所以判据钉旧**字面量**而不是那个词
  check(
    '相似检索: 融合层兜底文案不再说「等下一次会话」（0.2.89 起本会话新写的也算候选，那是过期劝告）',
    !/换一条基准再问一次/.test(searchSrc) && /换一条基准、把 k 给大一点再问/.test(searchSrc),
  )
  check(
    '相似检索: probe-ruler 进了 check-all 的 STEPS，且带同口径 / 看着像 / 复算三条断言',
    checkAllSrc.includes("['tools/probe-ruler.mjs'") &&
      rulerSrc.includes('U2 写侧回执的「重复度 N%」与相似检索的 repeat 是同一个数') &&
      rulerSrc.includes('U3 回执点名「看着像、其实不是同一句」') &&
      rulerSrc.includes('U8 repeat 用 tokenize 复算与工具一致'),
  )
}

// [macro-fusion 0.2.91] 星图体检的「相似 N」是**稀有词签名**估出来的（24 词、df≥2、门槛 0.86），
// 库小的时候签名退化成「两边共有的词」，同一对内容会被报成「相似 1」。而工具里的「逐字重复度」
// 是全文词集 Jaccard，与写侧 80% 合并判据同源。实测同一对内容：面板 1 / 工具 0.42 / 写侧不判重复。
// 融合层拿不到正文、无法重算第二把尺子，所以这里钉的是「把两把尺子摆到抬头里」这件事本身：
// 只在真列出对子时说、说清这是什么量、指路去看 repeat、与 nebula 的实现常量对得上。
{
  const adminSrc = readFileSync(join(root, 'lib/macro/defs/admin.js'), 'utf8')
  const graphSrc = readFileSync(join(root, 'vendor/dsh-memory-nebula/lib/host/graph.js'), 'utf8')
  const probeSrc = readFileSync(join(root, 'tools/probe-graph.mjs'), 'utf8')
  const checkAllSrc = readFileSync(join(root, 'tools/check-all.mjs'), 'utf8')

  check(
    '体检口径: 校准句是模块级导出函数（可单测），且只有 hygiene 分支才掺',
    adminSrc.includes('export function hygieneRulerNote(body, args)') &&
      adminSrc.includes("const ruler = action === 'hygiene' ? hygieneRulerNote(text, args) : ''") &&
      (adminSrc.match(/hygieneRulerNote\(/g) || []).length >= 2,
  )
  check(
    '体检口径: 校准句是**并进**尾注，不顶掉原有的「没排上来」提示',
    adminSrc.includes("note: [ruler, stray].filter(Boolean).join(' · ')"),
  )
  check(
    '体检口径: 文案说清三件事——这是稀有词签名 / 与逐字重复度不是一把尺子 / 判重复去看 repeat ≥0.80',
    adminSrc.includes('稀有词签名估算') &&
      adminSrc.includes('不是同一把尺子') &&
      adminSrc.includes('memory_search 的 repeat（≥0.80 写侧就判重复）') &&
      adminSrc.includes('每条约留最稀有的 24 个词'),
  )
  check(
    '体检口径: 文案里的 24 词 / 门槛 0.86 与 nebula 的实现对得上（说的是真的，不是写死的形容）',
    graphSrc.includes('const SIG_N = 24') && /hyJaccardAtLeast\([^;]*?,\s*0\.86\)/.test(graphSrc),
  )
  check(
    '体检口径: 没有对子 / 只看别的类别时一句都不掺（不制造噪音）',
    adminSrc.includes("if (asked !== '' && asked !== 'dup') return ''") &&
      adminSrc.includes("if (!text.includes('（相似 ')) return ''"),
  )
  check(
    '体检口径: probe-graph 的 H 段七条进了线，且带两条阴性对照（写侧不判重复 / kind=stale 不掺）',
    checkAllSrc.includes("['tools/probe-graph.mjs'") &&
      probeSrc.includes('H1 两条核心不同的都写下了') &&
      probeSrc.includes('H2 写侧没把这两条判成重复') &&
      probeSrc.includes('H6 同一对在工具里逐字只有四成') &&
      probeSrc.includes('H7 只看别的类别时不掺这句话（不制造噪音）'),
  )
}


// [macro-fusion 0.2.92] dream 是全库唯一「回头看旧条目」的地方，可它原来只给清单、不给判据：哪两条
// 其实是同一句话，只能靠模型自己扫字面比。写侧（0.2.88 / 0.2.90）早就算得出逐字重复度，dream 却
// 拿不到——同一把尺子只在一个方向上有刻度。这里钉三件事：算出来了、只在有对子时出现、短 id 不撞。
{
  const vSrc = readFileSync(join(root, 'vendor/meow-memory/lib/index.js'), 'utf8')
  const checkAllSrc = readFileSync(join(root, 'tools/check-all.mjs'), 'utf8')
  const rulerSrc = readFileSync(join(root, 'tools/probe-ruler.mjs'), 'utf8')
  const langs = ['zh', 'en', 'pt-br']
  const labelOf = (l) => readFileSync(join(root, 'vendor/meow-memory/lib/prompts', l, 'labels.md'), 'utf8')
  const slotOf = (l, f) => readFileSync(join(root, 'vendor/meow-memory/lib/prompts', l, f), 'utf8')

  check(
    'dream 重复: 重复对是模块级的两个纯函数（可单测），门槛默认取写侧同一个 DEDUP_THRESHOLD',
    vSrc.includes('function dreamDupPairs(rows, threshold = DEDUP_THRESHOLD,') &&
      vSrc.includes('function uniqueShortIdsAmong(rows, min = 8)') &&
      vSrc.includes('var DREAM_DUP_MAX = 5;'),
  )
  check(
    'dream 重复: 清单里真的用上了（算 / 渲染 / 并进 list 三处缺一不可）',
    vSrc.includes('const dupPairs = dreamDupPairs(allRows)') &&
      vSrc.includes('const shortOf = uniqueShortIdsAmong(allRows);') &&
      vSrc.includes('list: listBlock + dupBlock'),
  )
  check(
    'dream 重复: 没有对子就一个字不加（干净清单不加噪音），门槛数字由常量算出、不是写死的 80',
    vSrc.includes('const dupBlock = dupPairs.length === 0 ? "" :') &&
      (vSrc.match(/String\(Math\.round\(DEDUP_THRESHOLD \* 100\)\)/g) || []).length >= 2,
  )
  check(
    'dream 重复: 对子里的短 id 走 uniqueShortIdsAmong，不再直接 slice(0, 8)（撞了就是自己和自己重复）',
    vSrc.includes('${shortOf.get(String(p.a.id))}') &&
      vSrc.includes('${shortOf.get(String(p.b.id))}') &&
      !/\\\\u21C4[^`]*slice\(0, 8\)/.test(vSrc),
  )
  check(
    'dream 重复: 跨层回执同样改用不撞前缀的短 id（记忆 update 的歧义拒绝不该被回执带出来）',
    vSrc.includes('function uniqueShortId(db, level, id, min = 8)') &&
      vSrc.includes('const shortId = db === undefined ? hit.id.slice(0, 8) : uniqueShortId(db, hit.level, hit.id);') &&
      vSrc.includes('const crossNote = crossLevelNote(crossLevelDupe(db, level, content), db);'),
  )
  check(
    'dream 重复: 三语 labels 都有这条文案，占位符按名字填（{n} / {threshold} 都不许漏印）',
    langs.every((l) => {
      const s = labelOf(l)
      return /^- dream\.dup\.title:/m.test(s) && /^- dream\.dup\.rule:/m.test(s) && s.includes('{n}') && s.includes('{threshold}')
    }),
  )
  check(
    'dream 重复: 三语的整理指引都写了这条处置（≥80% 才算重复、相似只是同话题、另一条 archived）',
    langs.every((l) => {
      const a = slotOf(l, 'dream-atomic.md')
      const b = slotOf(l, 'dream-topic.md')
      return a.includes('≥80%') && a.includes('archived') && b.includes('≥80%') && b.includes('archived')
    }),
  )
  check(
    'dream 重复: probe-ruler 的 D 段七条进了线（含「成员正好是那一对」与「单条目不出块」两条阴性对照）',
    checkAllSrc.includes("['tools/probe-ruler.mjs'") &&
      rulerSrc.includes('D1 dream 清单里点名了那一对逐字重复') &&
      rulerSrc.includes('D2 两个短 id 互相可区分') &&
      rulerSrc.includes('D4 重复对的成员正好是 BASE 与 NEAR') &&
      rulerSrc.includes('D5 阴性对照：只有一条的窗口没有') &&
      rulerSrc.includes('D7 三语的整理指引都写了这一条'),
  )
}

// [macro-fusion 0.2.93] 0.2.92 的重复对只在「本轮的行」里比，而 atomic 与 topic 是两次独立的消息：
// 同一句话一条记 fact、一条记 topic 时永远碰不到一起——写侧 crossLevelDupe 扫全部层能抓，dream 又漏一次。
// 这里钉四件事：对子在整窗口范围算、只由先出现的那一轮展示、跨轮次要标出来、三语指引都说清怎么处置。
{
  const vSrc = readFileSync(join(root, 'vendor/meow-memory/lib/index.js'), 'utf8')
  const checkAllSrc = readFileSync(join(root, 'tools/check-all.mjs'), 'utf8')
  const rulerSrc = readFileSync(join(root, 'tools/probe-ruler.mjs'), 'utf8')
  const langs = ['zh', 'en', 'pt-br']
  const labelOf = (l) => readFileSync(join(root, 'vendor/meow-memory/lib/prompts', l, 'labels.md'), 'utf8')
  const slotOf = (l, f) => readFileSync(join(root, 'vendor/meow-memory/lib/prompts', l, f), 'utf8')

  check(
    'dream 跨轮次: 对子在整窗口的行上算（allRows 覆盖 atomic + topic，不再是 roundRows 自说自话）',
    vSrc.includes('const allRows = rounds.filter((r) => Array.isArray(r.groups)).flatMap((r) => r.groups.flatMap((g) => g.rows));') &&
      vSrc.includes('const dupPairs = dreamDupPairs(allRows).filter((p) => dreamPairOwner(rounds, p) === idx);') &&
      vSrc.includes('const shortOf = uniqueShortIdsAmong(allRows);'),
  )
  check(
    'dream 跨轮次: 归属轮次由纯函数 dreamPairOwner 决定（先出现的那一轮负责说，同一对只印一次）',
    vSrc.includes('function dreamPairOwner(rounds, pair)') &&
      vSrc.includes('for (const g of rounds[i].groups ?? []) {') &&
      /function dreamPairOwner\(rounds, pair\) \{[\s\S]{0,400}?return -1;/.test(vSrc),
  )
  check(
    'dream 跨轮次: 跨轮次的对子行标出「（另一组）」，文案走 labels 不写死中文',
    vSrc.includes('const inThisRound = roundIds.has(String(p.a.id)) && roundIds.has(String(p.b.id));') &&
      vSrc.includes('? pairLine : `${pairLine}\\uFF08${lbl3("dream.dup.crossRound")}\\uFF09`'),
  )
  check(
    'dream 跨轮次: 三语 labels 都有 dream.dup.crossRound（新文案不许只写中文）',
    langs.every((l) => /^- dream\.dup\.crossRound: \S/m.test(labelOf(l))),
  )
  check(
    'dream 跨轮次: 三语六份整理指引都说清了「（另一组）」怎么处置（看不见对方也得办）',
    langs.every((l) =>
      ['dream-atomic.md', 'dream-topic.md'].every((f) => /another round|outra rodada|另一组/.test(slotOf(l, f))),
    ),
  )
  check(
    'dream 跨轮次: probe-ruler 的 D8/D9/D10 进了线（含「整轮只印一次」与「无关那条不配对」）',
    checkAllSrc.includes("['tools/probe-ruler.mjs'") &&
      rulerSrc.includes('D8 跨轮次（fact ⇄ topic）的同一句话也被点名') &&
      rulerSrc.includes('D9 阴性对照：同一个窗口里无关的那条没被凑成对子') &&
      rulerSrc.includes('D10 三语指引都说明了「（另一组）」怎么处置'),
  )
}


// [macro-fusion 0.2.94] 逐字重复度抓不到「一条短摘录 + 一条长详写」：实测 15 词对 92 词只有 0.16，
// 但它们说的是同一件事，只是叠成了摘要 + 全文。判据换成覆盖度（小集合做分母），配两道闸：
// 短的那条至少 8 个不同的词、长度比 ≤0.75。这里钉：常量在、判据是覆盖度、与 ≥80% 互斥、
// 清单真用上、没对子不加字、三语 label 与指引都写了这一条、探针 E 段进线。
{
  const vSrc = readFileSync(join(root, 'vendor/meow-memory/lib/index.js'), 'utf8')
  const checkAllSrc = readFileSync(join(root, 'tools/check-all.mjs'), 'utf8')
  const rulerSrc = readFileSync(join(root, 'tools/probe-ruler.mjs'), 'utf8')
  const langs = ['zh', 'en', 'pt-br']
  const labelOf = (l) => readFileSync(join(root, 'vendor/meow-memory/lib/prompts', l, 'labels.md'), 'utf8')
  const slotOf = (l, f) => readFileSync(join(root, 'vendor/meow-memory/lib/prompts', l, f), 'utf8')
  check(
    'dream 详写对: 覆盖度判据是模块级纯函数，门槛是三个具名常量（不是散在逻辑里的魔数）',
    vSrc.includes('var DREAM_COVER_MIN = 0.9;') &&
      vSrc.includes('var DREAM_COVER_MIN_WORDS = 8;') &&
      vSrc.includes('var DREAM_COVER_RATIO_MAX = 0.75;') &&
      /function dreamCoverPairs\(rows, minContain = DREAM_COVER_MIN,/.test(vSrc),
  )
  check(
    'dream 详写对: 分母取小集合（覆盖度，不是 Jaccard），且与 ≥80% 的重复对互斥',
    vSrc.includes('const small = a.size <= b.size ? a : b;') &&
      vSrc.includes('return inter / small.size;') &&
      vSrc.includes('if (overlapOfSets(a, b) >= DEDUP_THRESHOLD) continue;'),
  )
  check(
    'dream 详写对: 清单在整窗口范围算详写对，只由先出现的那一轮印，且拼在 list 末尾',
    vSrc.includes('const coverPairs = dreamCoverPairs(allRows).filter((p) => dreamPairOwner(rounds, p) === idx);') &&
      vSrc.includes('list: listBlock + dupBlock + coverBlock'),
  )
  check(
    'dream 详写对: 没对子一个字不加，门槛文案由常量算出来（不许把 90 写死在文案里）',
    vSrc.includes('const coverBlock = coverPairs.length === 0 ? "" :') &&
      (vSrc.split('String(Math.round(DREAM_COVER_MIN * 100))').length - 1) >= 2,
  )
  check(
    'dream 详写对: 三语 labels 都有 dream.cover.title / dream.cover.rule，占位符按名字填（{n} / {contain}）',
    langs.every((l) => {
      const s = labelOf(l)
      return /^- dream\.cover\.title:/m.test(s) && /^- dream\.cover\.rule:/m.test(s) && s.includes('{n}') && s.includes('{contain}')
    }),
  )
  check(
    'dream 详写对: 三语六份指引都写了这一条（重复度低也可能是一条摘录 + 一条全文）',
    langs.every((l) =>
      ['dream-atomic.md', 'dream-topic.md'].every((f) =>
        /重复详写对|duplicate write-ups|redações duplicadas/.test(slotOf(l, f)),
      ),
    ),
  )
  check(
    'dream 详写对: probe-ruler 的 E1–E5 进了线（含方向、阴性对照、与逐字重复块互斥）',
    checkAllSrc.includes("['tools/probe-ruler.mjs'") &&
      rulerSrc.includes('E1 dream 清单点名了「短摘录 + 长详写」这一对') &&
      rulerSrc.includes('E2 方向对：⊂ 左边是短摘录') &&
      rulerSrc.includes('E3 覆盖度与处置都写清了') &&
      rulerSrc.includes('E4 阴性对照 + 互斥'),
  )
}

// [macro-fusion 0.2.95] 覆盖度只说「是不是同一件事」，不说「合并会不会漏字」：≥90% 的意思是
// 短条最多还有 10% 的词没落进长条，只喊「合成一条」，那 10% 多半跟着短条一起被扔掉。
// 这里钉：处方是模块级纯函数、按词长降序取前 6 个、两个分支都走 labels、缩进接在对子行后面、
// 三语 label 与六份指引都写了怎么合并与三把尺子的分工、探针 F 段进线。
{
  const vSrc = readFileSync(join(root, 'vendor/meow-memory/lib/index.js'), 'utf8')
  const checkAllSrc = readFileSync(join(root, 'tools/check-all.mjs'), 'utf8')
  const rulerSrc = readFileSync(join(root, 'tools/probe-ruler.mjs'), 'utf8')
  const langs = ['zh', 'en', 'pt-br']
  const labelOf = (l) => readFileSync(join(root, 'vendor/meow-memory/lib/prompts', l, 'labels.md'), 'utf8')
  const slotOf = (l, f) => readFileSync(join(root, 'vendor/meow-memory/lib/prompts', l, f), 'utf8')
  check(
    'dream 合并处方: 漏词判据是模块级纯函数，词数上限是具名常量 DREAM_MERGE_WORDS（不是魔数）',
    vSrc.includes('var DREAM_MERGE_WORDS = 6;') &&
      /function missingWordsOf\(smallSet, bigSet, max = DREAM_MERGE_WORDS\)/.test(vSrc) &&
      vSrc.includes('for (const w of smallSet) if (!bigSet.has(w)) out.push(w);'),
  )
  check(
    'dream 合并处方: 只数「短条有、长条没有」的词，按词长降序（先念信息量最大的那几个）',
    vSrc.includes('out.sort((x, y) => y.length - x.length || (x < y ? -1 : x > y ? 1 : 0));') &&
      vSrc.includes('return { total: out.length, sample: out.slice(0, max) };') &&
      vSrc.includes('const miss = missingWordsOf(a.size <= b.size ? a : b, a.size <= b.size ? b : a);'),
  )
  check(
    'dream 合并处方: 详写对带着漏词数出行，渲染时两个分支都走 labels（没漏字也要说清是无损的）',
    vSrc.includes('missing: miss.total, words: miss.sample') &&
      vSrc.includes('lbl3("dream.cover.keep",') &&
      vSrc.includes('lbl3("dream.cover.keepNone")') &&
      vSrc.includes('const recipe = p.missing === 0') &&
      vSrc.includes(': lbl3("dream.cover.keep", { n: String(p.missing), words: p.words.join("\\u3001") })'),
  )
  check(
    'dream 合并处方: 处方行缩进在对子行下面（`\\n  ${recipe}`），不是另起一个块',
    vSrc.includes('return `${head}\\n  ${recipe}`;'),
  )
  check(
    'dream 合并处方: 三语 labels 都有 keep / keepNone，占位符按名字填（{n} / {words}，且对准短条与长条）',
    langs.every((l) => {
      const s = labelOf(l)
      const keep = (s.match(/^- dream\.cover\.keep: .*$/m) ?? [''])[0]
      return (
        /^- dream\.cover\.keep:/m.test(s) &&
        /^- dream\.cover\.keepNone:/m.test(s) &&
        s.includes('{n}') &&
        s.includes('{words}') &&
        !/[{}]contain/.test(keep)
      )
    }),
  )
  check(
    'dream 合并处方: 三语六份指引都写了处方怎么用，并写清三把尺子各管一段（重复该合并、相似不许合并）',
    langs.every((l) =>
      ['dream-atomic.md', 'dream-topic.md'].every(
        (f) =>
          /处方|recipe|receita/i.test(slotOf(l, f)) &&
          /三把尺子|three rulers|três réguas/.test(slotOf(l, f)),
      ),
    ),
  )
  check(
    'dream 合并处方: probe-ruler 的 F1–F4 进了线（含无损分支与「不硬凑词」的阴性对照）',
    checkAllSrc.includes("['tools/probe-ruler.mjs'") &&
      rulerSrc.includes('F1 每个详写对子下面都跟着一行处方') &&
      rulerSrc.includes('F2 短条里长条没有的词被点名') &&
      rulerSrc.includes('F3 阴性对照：短条整句都在长条里时') &&
      rulerSrc.includes('F4 三语指引都写了「怎么合并」与三把尺子的分工'),
  )
}

// [macro-fusion 0.2.99] 账本记的是「整理完之后」，主人盯着的却是「现在这一轮在干什么」：
// 月亮图标的 SSE 事件原来只有 state，面板也只能念历史。这里钉三件事：
// ①广播多带一个可选的 detail（加法，老消费方只认 state 照样工作）；
// ②dream 开始时把同一份 dreamPlanDigest 一起广播出去，不去读第二份口径；
// ③readLiveDream 用活 lease + dreamdigest 读「进行中」，三态与 readDreamLedger 一样分开说，
//   并且面板把它排成第一行、不给它编序号（它还不是账本里的一行）。
{
  const vSrc = readFileSync(join(root, 'vendor/meow-memory/lib/index.js'), 'utf8')
  const panelSrc = readFileSync(join(root, 'lib', 'macro', 'dreamledger.js'), 'utf8')
  const checkAllSrc = readFileSync(join(root, 'tools', 'check-all.mjs'), 'utf8')
  const rulerSrc = readFileSync(join(root, 'tools', 'probe-ruler.mjs'), 'utf8')
  const fusionSrc = readFileSync(join(root, 'tools', 'probe-fusion.mjs'), 'utf8')
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  const idxSrc = readFileSync(join(root, 'lib', 'index.js'), 'utf8')
  check(
    'dream 进行中: 广播带可选 detail，老调用方（只传 state）照样工作',
    vSrc.includes('  broadcast(sessionId, state, detail) {') &&
      vSrc.includes('    this.write(sessionId, state, detail);') &&
      vSrc.includes('const signalDreamState = (sessionId, state, detail) => {') &&
      vSrc.includes('broadcast.broadcast(sessionId, state, detail);'),
  )
  check(
    'dream 进行中: 开始时广播的就是 dreamPlanDigest 那份摘要（不另立口径）',
    vSrc.includes('onDreamState?.(sessionId, "dreaming", { plan: digest });') &&
      vSrc.indexOf('const digest = dreamPlanDigest(rounds);') < vSrc.indexOf('onDreamState?.(sessionId, "dreaming", { plan: digest });'),
  )
  check(
    'dream 进行中: readLiveDream 是模块级读口，三态分开（没工作区 / 没建库 / 读不开）',
    /function readLiveDream\(workspace, dir = "\.dsh-meow"\)/.test(vSrc) &&
      vSrc.includes('missing: "no-workspace"') &&
      vSrc.includes('missing: "no-db"') &&
      vSrc.includes('`read-failed: ${e?.message ?? e}`') &&
      /^\s{2}readLiveDream,$/m.test(vSrc),
  )
  check(
    'dream 进行中: 只认活 lease（过期的 lease 不算「现在在整理」），规模只从 dreamdigest 读',
    vSrc.includes('if (lease === null || Date.now() - lease.progress_at > DREAM_LEASE_MS) continue;') &&
      vSrc.includes('const rawPlan = db.getDreamMeta(`dreamdigest:${w.session_id}`);'),
  )
  check(
    'dream 进行中: collectDreamStates 多出 plans 一列，dreamed/dreaming 两个老字段没动',
    vSrc.includes('return { dreamed, dreaming, plans };') &&
      vSrc.includes('const plans = {};') &&
      vSrc.includes('plans[w.session_id] = JSON.parse(rawPlan);'),
  )
  check(
    'dream 进行中: 面板把它排在第一行、不带序号，并且说清「收尾后会变成账本里的一行」',
    panelSrc.includes("if (liveText !== '') lines.unshift(liveText, '')") &&
      panelSrc.includes('收尾之后这里会变成账本里的一行历史') &&
      panelSrc.includes('规模还没落 meta') &&
      panelSrc.includes("if (liveText !== '') scopeParts.push('第一行是正在整理的那一轮，规模读的是 dreamdigest，不是账本')"),
  )
  check(
    'dream 进行中: 面板对「没在整理」与「读不出来」不合并（沿用 readLiveDream 的三态）',
    panelSrc.includes('const live = wantPage === 1 ? Meow.readLiveDream(workspace, dir)') && !/live\.missing === 'no-db'/.test(panelSrc),
  )
  check(
    'dream 进行中: 探针进线（probe-ruler I0–I5、probe-fusion D18–D19）',
    checkAllSrc.includes("['tools/probe-ruler.mjs'") &&
      rulerSrc.includes('I0 建了库但没在整理：一个会话都不报') &&
      rulerSrc.includes('I2 lease 放掉之后立刻不再报') &&
      rulerSrc.includes('I3 只有 lease 没有 digest：报会话但 plans 为空（不编规模）') &&
      fusionSrc.includes('D18 整理中：第一行念这一轮的规模') &&
      fusionSrc.includes('D19 lease 放掉后第一行消失'),
  )
  check(
    'dream 进行中: 版本不早于 0.2.99（两处一致；具体版本号由 doctor 的单一来源那条守）',
    (() => {
      const v = pkg.version.split('.').map((x) => Number(x))
      const atLeast = v[0] > 0 || v[1] > 2 || (v[1] === 2 && v[2] >= 99)
      return atLeast && idxSrc.includes(`export const version = '${pkg.version}'`)
    })() &&
      readFileSync(join(root, 'docs', 'INTERNAL.md'), 'utf8').includes('## 9.105') &&
      readFileSync(join(root, 'DESIGN.md'), 'utf8').includes('## 111'),
  )
}

// [macro-fusion 0.2.100] 0.2.97 起面板能念账本，但账本一长就只看得见最近 5 条，而且每条只有一行——
// 「那一条当时到底写了什么、跟上一比是多了还是少了」问不出来。这里钉四件事：
// ①读口能翻页（LIMIT/OFFSET + 总数由 COUNT 给，不是「这一页几条」）；
// ②对外只有一个编号口径「第几近」，跨页连续；内部 rowid 只当句柄，不进正文；
// ③单条展开念 summary/note/changes 原文，老记录明说没有规模，超长截断要报真实长度；
// ④page / id 给脏了当面打回——静默退回第 1 页最容易让人以为「账本就这几条」。
{
  const vSrc = readFileSync(join(root, 'vendor/meow-memory/lib/index.js'), 'utf8')
  const panelSrc = readFileSync(join(root, 'lib', 'macro', 'dreamledger.js'), 'utf8')
  const adminSrc = readFileSync(join(root, 'lib', 'macro', 'defs', 'admin.js'), 'utf8')
  const checkAllSrc = readFileSync(join(root, 'tools', 'check-all.mjs'), 'utf8')
  const rulerSrc = readFileSync(join(root, 'tools', 'probe-ruler.mjs'), 'utf8')
  const fusionSrc = readFileSync(join(root, 'tools', 'probe-fusion.mjs'), 'utf8')
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  const idxSrc = readFileSync(join(root, 'lib', 'index.js'), 'utf8')
  check(
    'dream 翻页: 读口带 OFFSET，总数由 dreamCount 给（不拿本页条数冒充总数）',
    vSrc.includes('ORDER BY run_at DESC, rowid DESC LIMIT ? OFFSET ?') &&
      vSrc.includes('recentDreamsPage(limit = 5, offset = 0') &&
      vSrc.includes('dreamCount() {') &&
      vSrc.includes('total: db.dreamCount'),
  )
  check(
    'dream 翻页: 同一个 run_at 也有稳定次序（rowid DESC），翻页不会漏条/重条',
    vSrc.includes('ORDER BY run_at DESC, rowid DESC LIMIT ? OFFSET ?') &&
      vSrc.includes('  recentDreamsPage(limit = 5, offset = 0'),
  )
  check(
    'dream 展开: readDreamRecord 是模块级读口，多一个 no-row 态，并把「更早一条」一起带出来',
    /function readDreamRecord\(workspace, dir = "\.dsh-meow", rank = 1\)/.test(vSrc) &&
      vSrc.includes('missing: "no-row"') &&
      vSrc.includes('const rows = db.recentDreamsPage(2, k - 1);') &&
      /^\s{2}readDreamRecord,$/m.test(vSrc),
  )
  check(
    'dream 翻页: 面板的编号跨页连续（firstRank），趋势行只在第 1 页出',
    panelSrc.includes('const firstRank = (effectivePage - 1) * want + 1') &&
      panelSrc.includes('const lines = rows.map((row, i) => rowLine(row, firstRank + i))') &&
      panelSrc.includes("const live = wantPage === 1 ? Meow.readLiveDream(workspace, dir) : { sessionIds: [] }") &&
      panelSrc.includes('趋势行只在第 1 页出'),
  )
  check(
    'dream 翻页: 页码越过最后一页时退到最后一页并说清（不返回空白页）',
    panelSrc.includes('const lastPage = Math.max(1, Math.ceil(total / want))') &&
      panelSrc.includes('const effectivePage = Math.min(wantPage, lastPage)') &&
      panelSrc.includes('早过最后一页'),
  )
  check(
    'dream 展开: 原文照账本念（摘要 / 备注 / changes JSON），超长截断并报真实长度',
    panelSrc.includes('变化原文：') &&
      panelSrc.includes('const CAP = 1200') &&
      panelSrc.includes('（前 ${CAP} 字符，共 ${raw.length} 字符）') &&
      panelSrc.includes("'（这一条没有摘要）'") &&
      panelSrc.includes("'（这一条没写备注）'"),
  )
  check(
    'dream 展开: 老记录明说没有 changes.plan；与更早一条的差只报真变了的段',
    panelSrc.includes('它写在 0.2.96 之前，当时还没有记规模') &&
      panelSrc.includes('function compareLine(row, prev, prevRank)') &&
      panelSrc.includes('都没变') &&
      panelSrc.includes('两边都没有规模数字，不比较'),
  )
  check(
    'dream 参数: page / id 给脏了当面打回，不静默退回默认',
    adminSrc.includes('function pageOf(raw)') &&
      adminSrc.includes('function idOf(raw)') &&
      adminSrc.includes('这次没有列账——别把「没列」读成「账本里只有这几条」') &&
      adminSrc.includes('这次没有展开任何一条') &&
      adminSrc.includes("params: ['limit', 'page', 'id', 'project']") &&
      adminSrc.includes('page: { type: \'integer\''),
  )
  check(
    'dream 参数: schema 里 page / id 有独立说明（参数说明也是产品的一部分）',
    adminSrc.includes('action=dream 翻到第几页') && adminSrc.includes('action=dream 展开一条账'),
  )
  check(
    'dream 翻页: 探针进线（probe-ruler J1–J6、probe-fusion D20–D25）',
    checkAllSrc.includes("['tools/probe-ruler.mjs'") &&
      rulerSrc.includes('J1 第一页：给 5 条、总数照实说') &&
      rulerSrc.includes('J2 第二页：只剩 2 条，且接着第一页往后读') &&
      rulerSrc.includes('J5 要第 99 近：missing=no-row') &&
      fusionSrc.includes('D20 第一页：列出 3 条、编号从 #1 起') &&
      fusionSrc.includes('D22 页码越过最后一页') &&
      fusionSrc.includes('D25 id 给脏了当面打回'),
  )
  check(
    'dream 翻页: 版本不早于 0.2.100（两处一致），文档 9.106 / 112 在位',
    (() => {
      const v = pkg.version.split('.').map((x) => Number(x))
      const atLeast = v[0] > 0 || v[1] > 2 || (v[1] === 2 && v[2] >= 100)
      return atLeast && idxSrc.includes(`export const version = '${pkg.version}'`)
    })() &&
      readFileSync(join(root, 'docs', 'INTERNAL.md'), 'utf8').includes('## 9.106') &&
      readFileSync(join(root, 'DESIGN.md'), 'utf8').includes('## 112'),
  )
}

// [macro-fusion 0.2.101] 0.2.100 让账本能翻页、能摊开某一条，但 `changes.plan.projects` 一直只被数了个数。
// 「这一轮动了哪几个项目、某个项目的账翻出来看看」问不出来。这里钉四件事：
// ①筛在 SQL 里做（json_each + json_valid），页面与总数共用一个筛子，坏行不许算进匹配；
// ②分布读口另有一份，total 是 COUNT(DISTINCT)——只列前几个时「没列」不等于「没有」；
// ③面板：分布只在没筛且第 1 页出；筛着时编号改口径并说清；筛空 ≠ 账本空；展开不属于就说清；
// ④project 给脏了当面打回，不静默当「没匹配到」。
{
  const vSrc = readFileSync(join(root, 'vendor/meow-memory/lib/index.js'), 'utf8')
  const panelSrc = readFileSync(join(root, 'lib', 'macro', 'dreamledger.js'), 'utf8')
  const adminSrc = readFileSync(join(root, 'lib', 'macro', 'defs', 'admin.js'), 'utf8')
  const rulerSrc = readFileSync(join(root, 'tools', 'probe-ruler.mjs'), 'utf8')
  const fusionSrc = readFileSync(join(root, 'tools', 'probe-fusion.mjs'), 'utf8')
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  const idxSrc = readFileSync(join(root, 'lib', 'index.js'), 'utf8')
  check(
    'dream 项目筛: 筛在 SQL 里做，页面与总数共用一个筛子（不各算一套）',
    // [macro-fusion 0.2.105] 写侧改成 parts/args 拼 WHERE（项目段 + 日期共用一套筛子），
    // 签名多了 since/until，行和总数都吃同一份 parts。
    vSrc.includes('recentDreamsPage(limit = 5, offset = 0, project = "", since = 0, until = 0)') &&
      vSrc.includes('const name = String(project ?? "").trim();') &&
      vSrc.includes('const where = parts.length === 0 ? "" : "WHERE " + parts.join(" AND ");') &&
      vSrc.includes('const rows = this.db.prepare(sql).all(...args, n, skip);') &&
      /function readDreamLedger\(workspace, dir = "\.dsh-meow", limit = 5, offset = 0, project = "", since = 0, until = 0\)/.test(vSrc) &&
      vSrc.includes('total: db.dreamCountOf(project, since, until),'),
  )
  check(
    'dream 项目筛: 坏行先被 json_valid 挡掉（不许把一行坏账算成「匹配」或把查询带崩）',
    vSrc.includes('dreamCountOf(project = "", since = 0, until = 0)') &&
      (vSrc.match(/json_valid\(changes\)/g) ?? []).length >= 2 &&
      (vSrc.match(/json_valid\(dream_log\.changes\)/g) ?? []).length >= 2,
  )
  check(
    'dream 项目分布: 次数降序、同数次按名字，total 是 COUNT(DISTINCT)（只列前几个也不许报成「只有这几个」）',
    vSrc.includes('dreamProjects(limit = 5)') &&
      vSrc.includes('GROUP BY je.value ORDER BY n DESC, je.value ASC LIMIT ?') &&
      vSrc.includes('SELECT COUNT(DISTINCT je.value) AS n FROM dream_log, ') &&
      vSrc.includes('const n = Math.min(20, Math.max(1, Number.isFinite(asked) && asked > 0 ? asked : 5));'),
  )
  check(
    'dream 项目分布: 模块级读口 readDreamProjects 三态分开、并已导出',
    /function readDreamProjects\(workspace, dir = "\.dsh-meow", limit = 5\)/.test(vSrc) &&
      vSrc.includes('missing: "no-workspace"') &&
      vSrc.includes('missing: "no-db"') &&
      /^\s{2}readDreamProjects,$/m.test(vSrc),
  )
  check(
    'dream 项目筛: 面板第 1 页给分布行，且只在没筛时给（筛完再报分布会被当成「分布也筛过了」）',
    panelSrc.includes('function projectsLine(got)') &&
      panelSrc.includes('function projectNames(row)') &&
      // [macro-fusion 0.2.105] 按日期筛时同样不给分布：那是全账本的分布，不是这段日子的。
      panelSrc.includes('if (!filtered && !ranged) {') &&
      panelSrc.includes('const projects = projectsLine(Meow.readDreamProjects(workspace, dir, 5))') &&
      panelSrc.includes('项目分布按 changes.plan.projects 数出现次数，只列前 5 个；要看某个项目的账就用 project= 筛'),
  )
  check(
    'dream 项目筛: 筛着的时候编号改口径并说清（#k 是筛出来的第几近，不是全账本序号）',
    panelSrc.includes('const filtered = wantProject !== \'\'') &&
      panelSrc.includes('#k 是筛出来这几条里的第几近，不是全账本序号') &&
      // [macro-fusion 0.2.105] 筛子可能是「项目段」也可能是「日期」，导航行改成念 sieve，别只认项目段。
      panelSrc.includes("nav.push(sieve === '' ? `共 ${total} 条 · 每页 ${want} 条` : `共 ${total} 条（${sieve}）· 每页 ${want} 条`)") &&
      panelSrc.includes('Meow.readDreamLedger(workspace, dir, want, (effectivePage - 1) * want, wantProject, range.since, range.until).rows'),
  )
  check(
    'dream 项目筛: 筛空了不等于账本空（两句话分开说，并给出全账本条数）',
    panelSrc.includes('`账本里没有项目段「${wantProject}」的整理记录（全账本 ${allTotal} 条）') &&
      panelSrc.includes('项目名要按 changes.plan.projects 里的原样写，别自己翻译') &&
      panelSrc.includes('账本还是空的（${ledger.path}），项目段「${wantProject}」自然也还没有记录'),
  )
  check(
    'dream 项目筛: 展开时项目对不上就说清（照账念，但别当成筛选结果；编号仍是全账本的）',
    panelSrc.includes('这一条属于项目段「${wantProject}」。') &&
      panelSrc.includes('这一条不属于项目段「${wantProject}」——它记的是') &&
      panelSrc.includes('展开的编号仍是全账本的第几近（筛选不改编号）'),
  )
  check(
    'dream 参数: project 给成长句当面打回，不把它当「没匹配到」',
    adminSrc.includes('function projectOf(raw)') &&
      adminSrc.includes('只认一个项目段的名字') &&
      adminSrc.includes('这次没有筛任何账——别把「没筛」读成「这个项目没有账」') &&
      adminSrc.includes("params: ['limit', 'page', 'id', 'project']") &&
      adminSrc.includes('action=dream 只列某个项目段的账'),
  )
  check(
    'dream 项目筛: 探针进线（probe-ruler K1–K7、probe-fusion D26–D31）',
    rulerSrc.includes('K1 按项目筛：行只剩 Alpha 那几条') &&
      rulerSrc.includes('K3 项目分布：Alpha 3 次 / Beta 1 次') &&
      rulerSrc.includes('K5 筛一个不存在的项目') &&
      rulerSrc.includes('K7 分页也在 SQL 里筛') &&
      fusionSrc.includes('D26 第 1 页给项目分布') &&
      fusionSrc.includes('D28 筛一个不存在的项目') &&
      fusionSrc.includes('D31 筛 + 翻页'),
  )
  check(
    'dream 项目筛: 版本不早于 0.2.101（两处一致），文档 9.107 / 113 在位',
    (() => {
      const v = pkg.version.split('.').map((x) => Number(x))
      const atLeast = v[0] > 0 || v[1] > 2 || (v[1] === 2 && v[2] >= 101)
      return atLeast && idxSrc.includes(`export const version = '${pkg.version}'`)
    })() &&
      readFileSync(join(root, 'docs', 'INTERNAL.md'), 'utf8').includes('## 9.107') &&
      readFileSync(join(root, 'DESIGN.md'), 'utf8').includes('## 113'),
  )
}

// [macro-fusion 0.2.102] 0.2.101 的按项目筛账在真账本上永远筛不到东西：写侧存的是「个数」，
// 而 0.2.101 的探针手写 changes 恰好写成了数组，于是整条链路的真问题被盖住。这一版修写侧，
// 顺带把「跟谁撞了」落进账本，展开一条账就能直接动手合并。
{
  const vSrc = readFileSync(join(root, 'vendor/meow-memory/lib/index.js'), 'utf8')
  const panelSrc = readFileSync(join(root, 'lib', 'macro', 'dreamledger.js'), 'utf8')
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  const idxSrc = readFileSync(join(root, 'lib', 'index.js'), 'utf8')
  const rulerSrc102 = readFileSync(join(root, 'tools', 'probe-ruler.mjs'), 'utf8')
  const fusionSrc102 = readFileSync(join(root, 'tools', 'probe-fusion.mjs'), 'utf8')
  check(
    'dream 摘要: projects 存名字数组（去重保序），个数另存 projectCount——按名字筛账才有东西可筛',
    vSrc.includes('function dreamPlanProjectNames(rounds)') &&
      vSrc.includes('if (name !== "" && !out.includes(name)) out.push(name);') &&
      vSrc.includes('projects: dreamPlanProjectNames(rounds),') &&
      vSrc.includes('projectCount: rounds.reduce((n, r) => n + (Array.isArray(r.projects) ? r.projects.length : 0), 0),'),
  )
  check(
    'dream 摘要: 对子明细随账落库（短 id 与清单同一套，上限 6 对）',
    vSrc.includes('var DREAM_PLAN_PAIR_CAP = 6;') &&
      vSrc.includes('function dreamPlanPairs(allRows)') &&
      vSrc.includes('const shortOf = uniqueShortIdsAmong(allRows);') &&
      vSrc.includes('pairs: dreamPlanPairs(allRows)') &&
      vSrc.includes('return out.slice(0, DREAM_PLAN_PAIR_CAP);') &&
      vSrc.includes('words: Array.isArray(p.words) ? p.words.slice(0, DREAM_MERGE_WORDS) : []'),
  )
  check(
    'dream 摘要: 「撞上几对」是真数，不被清单上限截断（截断只影响印出来的那几对）',
    vSrc.includes('function dreamDupPairs(rows, threshold = DEDUP_THRESHOLD, max = DREAM_DUP_MAX)') &&
      vSrc.includes('function dreamCoverPairs(rows, minContain = DREAM_COVER_MIN, max = DREAM_DUP_MAX)') &&
      vSrc.includes('dup: dreamDupPairs(allRows, DEDUP_THRESHOLD, Infinity).length,') &&
      vSrc.includes('const covers = dreamCoverPairs(allRows, DREAM_COVER_MIN, Infinity);'),
  )
  check(
    'dream 筛账: 只把文本当项目名（老账本里的数字不许冒充名字，也不许进分布）',
    vSrc.includes("WHERE json_valid(dream_log.changes) AND je.type = 'text' GROUP BY je.value") &&
      vSrc.includes("WHERE json_valid(dream_log.changes) AND je.type = 'text'") &&
      vSrc.includes("WHERE json_each.type = 'text' AND json_each.value = ?") &&
      (vSrc.match(/json_each\.type = 'text' AND json_each\.value = \?/g) ?? []).length === 2,
  )
  check(
    'dream 面板: 两种形态都认（老账本只记个数，不能念成 0 个项目段）',
    panelSrc.includes('function projectCountOf(plan)') &&
      panelSrc.includes('const projects = projectCountOf(plan)') &&
      (panelSrc.match(/projectCountOf\(plan\)/g) ?? []).length >= 3 &&
      !panelSrc.includes('Array.isArray(plan.projects) ? plan.projects.length : 0'),
  )
  check(
    'dream 面板: 对子块的四种来路各说各话（没 plan / 没存明细 / 真没撞上 / 有数没列）',
    panelSrc.includes('对子：这条账没有 changes.plan（它写在 0.2.96 之前），谈不上对子。') &&
      panelSrc.includes('没有存对子明细（0.2.102 之前的记录）') &&
      panelSrc.includes('对子：这一轮没撞上对子，没有可合并的。') &&
      panelSrc.includes('却没有一条明细——别把「没列」读成「没有」。'),
  )
  check(
    'dream 面板: 明细超上限要报差额，并点明短 id 可以直接拿去用',
    panelSrc.includes('对子（账里存了 ${stored.length} 对，这一轮共 ${dup + cover} 对）：') &&
      panelSrc.includes('还有 ${dup + cover - stored.length} 对没落账（一条账只存前几对）——数是真数，点名只到前几对。') &&
      panelSrc.includes('短 id 和整理清单里印的是同一套，可以直接拿去 memory_read / memory_update。'),
  )
  check(
    'dream 面板: 展开顺序是「项目段 → 对子 → 比更早一条 → 原文」（对子不被 1200 字截断挤掉）',
    (() => {
      const seg = panelSrc.slice(panelSrc.indexOf('function expandPanel(rec, rank)'), panelSrc.indexOf('function compareLine('))
      const a = seg.indexOf('lines.push(pairsBlock(row))')
      const b = seg.indexOf('const cmp = compareLine(row, prev, rank + 1)')
      const c = seg.indexOf('const raw = row.changes === null')
      return a > 0 && b > a && c > b
    })(),
  )
  check(
    'dream 面板: 老账本只记了数时把数念出来，不假装没记项目段',
    panelSrc.includes('`项目段：这条账只记了个数（${legacy} 个），没记名字——它写在 0.2.102 之前。`'),
  )
  check(
    'dream 摘要: 探针进线（probe-ruler L1–L8 从写侧验、probe-fusion D32–D36 从面板验）',
    rulerSrc102.includes('L1 写侧的摘要：projects 是名字数组（去重保序），个数另存 projectCount') &&
      rulerSrc102.includes('L2 名字不再是数字') &&
      rulerSrc102.includes('L5 「这一轮撞上几对」是真数（21）') &&
      rulerSrc102.includes('L7 从写侧到 SQL 一路通') &&
      rulerSrc102.includes('L8 老账本里那个「2」不是项目名') &&
      fusionSrc102.includes('D32 展开一条新账：对子摊成清单') &&
      fusionSrc102.includes('D33 老格式的账：个数照念') &&
      fusionSrc102.includes('D35 对子超出落库上限') &&
      fusionSrc102.includes('D36 从写侧到面板一路通'),
  )
  check(
    'dream 摘要: 版本不早于 0.2.102（两处一致），文档 9.108 / 114 在位',
    (() => {
      const v = pkg.version.split('.').map((x) => Number(x))
      const atLeast = v[0] > 0 || v[1] > 2 || (v[1] === 2 && v[2] >= 102)
      return atLeast && idxSrc.includes(`export const version = '${pkg.version}'`)
    })() &&
      readFileSync(join(root, 'docs', 'INTERNAL.md'), 'utf8').includes('## 9.108') &&
      readFileSync(join(root, 'DESIGN.md'), 'utf8').includes('## 114'),
  )
}

// [macro-fusion 0.2.103] 账本只记「这一轮翻了几条」，不记「库本身有多大」：翻 20 条，在 800 条的库和
// 40 条的库里不是一个意思。这一版让开工那一刻的库规摸（只数 active、按层拆开）跟着摘要一起落库，
// 面板展开与趋势都能念出来；老账不补 0。
{
  const vSrc = readFileSync(join(root, 'vendor/meow-memory/lib/index.js'), 'utf8')
  const panelSrc = readFileSync(join(root, 'lib', 'macro', 'dreamledger.js'), 'utf8')
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  const idxSrc = readFileSync(join(root, 'lib', 'index.js'), 'utf8')
  const rulerSrc103 = readFileSync(join(root, 'tools', 'probe-ruler.mjs'), 'utf8')
  const fusionSrc103 = readFileSync(join(root, 'tools', 'probe-fusion.mjs'), 'utf8')
  check(
    'dream 规模: 写侧真的去数库（只数 active，按层拆，零层不进 JSON）',
    vSrc.includes('function dreamStoreScale(db)') &&
      vSrc.includes('SELECT COUNT(*) AS n FROM ${level} WHERE status = \'active\'') &&
      vSrc.includes('if (n > 0) byLevel[level] = n;') &&
      vSrc.includes('return { active, byLevel };') &&
      vSrc.includes('  dreamStoreScale,'),
  )
  check(
    'dream 规模: 开工那一刻取一次，跟着摘要落进 dream_meta（不是收尾再数——收尾时库已经被改过了）',
    (() => {
      const seg = vSrc.slice(vSrc.indexOf('function startWindowDream('), vSrc.indexOf('function advanceDream('))
      const a = seg.indexOf('const digest = dreamPlanDigest(rounds);')
      const b = seg.indexOf('digest.store = dreamStoreScale(db);')
      const c = seg.indexOf('db.setDreamMeta(`dreamdigest:${sessionId}`, JSON.stringify(digest));')
      const d = seg.indexOf('onDreamState?.(sessionId, "dreaming", { plan: digest });')
      return a > 0 && b > a && c > b && d > c
    })(),
  )
  check(
    'dream 规模: 面板三种来路分开讲（没记 / 空库 0 条 / 正常条数）',
    panelSrc.includes('function storeOf(plan)') &&
      panelSrc.includes('function storeBlock(row)') &&
      panelSrc.includes("return '库规模：这条账没有记库规模（它写在 0.2.103 之前）——别把「没记」读成「库是空的」。'") &&
      panelSrc.includes("if (store.active === 0 && span === null) return '库规模：开工时库里 0 条在用记忆——这一轮是在空库上整理的。'") &&
      panelSrc.includes('const head = `库规模：开工时 ${store.active} 条在用${levelsText(store)}`'),
  )
  check(
    'dream 规模: 没有 plan 的账不再叠一层库规模告示（0.2.96 那句已经解释过）',
    (() => {
      const seg = panelSrc.slice(panelSrc.indexOf('function storeBlock(row)'), panelSrc.indexOf('function expandPanel('))
      return seg.includes('if (plan === undefined || plan === null) return \'\'')
    })(),
  )
  check(
    'dream 规模: 展开顺序是「项目段 → 对子 → 库规模 → 比更早一条 → 原文」',
    (() => {
      const seg = panelSrc.slice(panelSrc.indexOf('function expandPanel(rec, rank)'), panelSrc.indexOf('function compareLine('))
      const a = seg.indexOf('lines.push(pairsBlock(row))')
      const b = seg.indexOf('const storeLine = storeBlock(row)')
      const c = seg.indexOf('const cmp = compareLine(row, prev, rank + 1)')
      return a > 0 && b > a && c > b
    })(),
  )
  check(
    'dream 规模: 趋势行按「最早→最新」给区间，并且至少两次有数才敢讲（一次是快照不是走势）',
    panelSrc.includes('const storeRows = ordered.map((r) => storeOf(r.changes?.plan)).filter((s) => s !== null)') &&
      panelSrc.includes('if (storeRows.length >= 2) {') &&
      panelSrc.includes('parts.push(`库 开工时 ${first} → ${last} 条（${word}）`)') &&
      panelSrc.includes('库规模只有 ${storeRows.length} 次有数——更早的账写在 0.2.103 之前，没有这一格'),
  )
  check(
    'dream 规模: 探针进线（probe-ruler L9–L11 验写侧真数、probe-fusion D37–D39 验面板真念）',
    rulerSrc103.includes('L9 库规模只数 status=active') &&
      rulerSrc103.includes('L10 空库：active=0 且 byLevel 是空对象') &&
      rulerSrc103.includes('L11 真开工：库规模跟着摘要一起进 dream_meta') &&
      fusionSrc103.includes('D37 展开新账念库规模') &&
      fusionSrc103.includes('D38 老账（没有 store 这一格）明说没记') &&
      fusionSrc103.includes('D39 趋势行带上库规模区间'),
  )
  check(
    'dream 规模: 版本不早于 0.2.103（两处一致），文档 9.109 / 115 在位',
    (() => {
      const v = pkg.version.split('.').map((x) => Number(x))
      const atLeast = v[0] > 0 || v[1] > 2 || (v[1] === 2 && v[2] >= 103)
      return atLeast && idxSrc.includes(`export const version = '${pkg.version}'`)
    })() &&
      readFileSync(join(root, 'docs', 'INTERNAL.md'), 'utf8').includes('## 9.109') &&
      readFileSync(join(root, 'DESIGN.md'), 'utf8').includes('## 115'),
  )
}

// [macro-fusion 0.2.104] 「第几近」会随新账往下挪，回指不了：#3 今天指这一轮，跑完下一轮就换人。
// dream_log.id 是 AUTOINCREMENT，只增不减、删了也不复用，所以 r<N> 是这一行自己的名字。
// 这是有意反转 0.2.100「不暴露 rowid」那条口径——理由写在 DESIGN 116 里。
{
  const vSrc = readFileSync(join(root, 'vendor/meow-memory/lib/index.js'), 'utf8')
  const panelSrc = readFileSync(join(root, 'lib', 'macro', 'dreamledger.js'), 'utf8')
  const adminSrc = readFileSync(join(root, 'lib', 'macro', 'defs', 'admin.js'), 'utf8')
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  const idxSrc = readFileSync(join(root, 'lib', 'index.js'), 'utf8')
  const rulerSrc104 = readFileSync(join(root, 'tools', 'probe-ruler.mjs'), 'utf8')
  const fusionSrc104 = readFileSync(join(root, 'tools', 'probe-fusion.mjs'), 'utf8')
  check(
    'dream 引用: 写侧按 id 取一条账，读不到返回 null（不拿「读不到」冒充「不存在」）',
    vSrc.includes('dreamById(id) {') &&
      vSrc.includes('SELECT id, run_at, summary, changes, note FROM dream_log WHERE id = ?') &&
      vSrc.includes('if (key === 0) return null;') &&
      vSrc.includes('if (!row) return null;') &&
      vSrc.includes('return { id: Number(row.id) || 0, runAt: Number(row.run_at) || 0,'),
  )
  check(
    'dream 引用: 「第几近」和账本列表必须同一把尺子（run_at 相同再比 id），否则引用和编号会指向不同的行',
    (() => {
      const seg = vSrc.slice(vSrc.indexOf('dreamRankOf(id) {'), vSrc.indexOf('close() {'))
      const page = vSrc.slice(vSrc.indexOf('recentDreamsPage('), vSrc.indexOf('recentDreamsPage(') + 2400)
      return (
        seg.includes('SELECT COUNT(*) AS n FROM dream_log WHERE run_at > ? OR (run_at = ? AND id > ?)') &&
        page.includes('ORDER BY run_at DESC, rowid DESC') &&
        seg.includes('return (Number(before?.n) || 0) + 1;')
      )
    })(),
  )
  check(
    'dream 引用: readDreamRecordByRef 四态之外多一个 no-row，成功时把 rank 与 prev 一起带出来',
    vSrc.includes('function readDreamRecordByRef(workspace, dir = ".dsh-meow", ref = 0)') &&
      vSrc.includes('if (!row) return { row: null, prev: null, rank: 0, path, missing: "no-row", total };') &&
      vSrc.includes('return { row: row ?? rows[0] ?? null, prev: rows[1] ?? null, rank, path, missing: "", total };') &&
      vSrc.includes('  readDreamRecordByRef,'),
  )
  check(
    'dream 引用: 面板认 r<N> 这种写法，列表每行都拼上自己的号（老账行也拼，否则最早的几轮永远回指不了）',
    panelSrc.includes('function refOfRow(row)') &&
      panelSrc.includes('function refIdOf(raw)') &&
      panelSrc.includes('const tailRef = ref === \'\' ? \'\' : ` · 引用 ${ref}`') &&
      panelSrc.includes('这条记录比 0.2.96 早，当时还没写规模数字${tailRef}') &&
      panelSrc.includes('` · 引用 ${ref}`'),
  )
  check(
    'dream 引用: 按引用展开排在「按第几近」之前，且两种写法分开讲（引用不挪、编号会挪）',
    (() => {
      const a = panelSrc.indexOf('if (wantRef > 0) {')
      const b = panelSrc.indexOf('if (wantId > 0) {')
      const c = panelSrc.indexOf('const wantId = wantRef > 0 ? 0 :')
      return a > 0 && b > a && c > 0 && c < a
    })(),
  )
  check(
    'dream 引用: 引用不存在时明说这个号不会发给新账，并给按位置 / 按内容两条替代路',
    panelSrc.includes('账本里没有引用 r${wantRef} 的那一条（一共 ${rec.total} 条）') &&
      panelSrc.includes('从来不会把老号发给新账') &&
      panelSrc.includes('要按位置找，就翻 page 看 #k；要按内容找，就用摘要里的字眼去搜。'),
  )
  check(
    'dream 引用: 展开时把「它现在排第几近」和「引用」摆在一起，并说清引用不受项目筛选影响',
    panelSrc.includes('引用 r${wantRef}：这个号跟着这一行走，账本再长几轮也不挪') &&
      panelSrc.includes('它现在排第 ${rankNow} 近——「#k」会随新账往下挪，回指请用引用。') &&
      panelSrc.includes('按引用 r${wantRef} 展开${rankNow > 0 ? `（现在第 ${rankNow} 近）` : \'\'}，共 ${rec.total} 条') &&
      panelSrc.includes("(wantProject === '' ? '' : '；引用不受项目筛选影响')"),
  )
  check(
    'dream 引用: 第几近那条路也顺手给出引用（省一次翻列表），编号口径不变',
    panelSrc.includes('`展开第 ${wantId} 条（共 ${rec.total} 条${rowRef === \'\' ? \'\' : `；引用 ${rowRef}，要回指就用 id=${rowRef}`}）'),
  )
  check(
    'dream 引用: 提示行只在第 1 页说一次（每页都印等于拿 token 换噪音）',
    (() => {
      const idx = panelSrc.indexOf('引用：每行末尾的 r<N> 是这一行的固定号')
      if (idx < 0) return false
      // 提示行必须落在「第 1 页」那段里（wantPage === 1 的那一支），且由「有没有引用」守着。
      const page1 = panelSrc.lastIndexOf('if (wantPage === 1) {', idx)
      const blockEnd = panelSrc.indexOf('if (total > want) {', idx)
      const near = panelSrc.slice(Math.max(0, idx - 400), idx)
      return page1 > 0 && blockEnd > idx && near.includes("if (rows.some((r) => refOfRow(r) !== '')) {")
    })(),
  )
  check(
    'dream 引用: admin 的 id 两种写法都认，r0 与乱写各自当面打回',
    adminSrc.includes('const byRef = /^[rR](\\d{1,9})$/.exec(text)') &&
      adminSrc.includes('id 引用要从 r1 起（r0 不存在）') &&
      adminSrc.includes('只认两种写法：「3」/「#3」这种「第几近」编号') &&
      adminSrc.includes('「r128」这种账本引用（每行末尾那个号，新账来了也不挪）') &&
      adminSrc.includes('"r128" 是账本引用（每行末尾那个号，不挪，回指某一轮用它）'),
  )
  check(
    'dream 引用: 探针进线（probe-ruler L12–L14 验写侧不挪、probe-fusion D40–D42 验面板真念）',
    rulerSrc104.includes('L12 引用不挪、编号会挪') &&
      rulerSrc104.includes('L13 按引用读一条') &&
      rulerSrc104.includes('L14 引用 0 / 非数字不猜行') &&
      fusionSrc104.includes('D40 列表每行都带账本引用 r<N>') &&
      fusionSrc104.includes('D41 又跑了一轮之后按引用展开') &&
      fusionSrc104.includes('D42 引用不存在'),
  )
  check(
    'dream 引用: 版本不早于 0.2.104（两处一致），文档 9.110 / 116 在位',
    (() => {
      const v = pkg.version.split('.').map((x) => Number(x))
      const atLeast = v[0] > 0 || v[1] > 2 || (v[1] === 2 && v[2] >= 104)
      return atLeast && idxSrc.includes(`export const version = '${pkg.version}'`)
    })() &&
      readFileSync(join(root, 'docs', 'INTERNAL.md'), 'utf8').includes('## 9.110') &&
      readFileSync(join(root, 'DESIGN.md'), 'utf8').includes('## 116'),
  )
}

// [macro-fusion 0.2.105] 账本只知道「翻了几条」，问不了「这几天整理得怎么样」：
// 要按日期问，就得有日期筛。三条硬口径：闭区间、本机时区、行与总数过同一把筛子。
{
  const vSrc = readFileSync(join(root, 'vendor/meow-memory/lib/index.js'), 'utf8')
  const panelSrc = readFileSync(join(root, 'lib', 'macro', 'dreamledger.js'), 'utf8')
  const adminSrc = readFileSync(join(root, 'lib', 'macro', 'defs', 'admin.js'), 'utf8')
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  const idxSrc = readFileSync(join(root, 'lib', 'index.js'), 'utf8')
  const auditSrc = readFileSync(join(root, 'tools', 'param-audit.mjs'), 'utf8')
  const rulerSrc105 = readFileSync(join(root, 'tools', 'probe-ruler.mjs'), 'utf8')
  const fusionSrc105 = readFileSync(join(root, 'tools', 'probe-fusion.mjs'), 'utf8')
  check(
    'dream 日期筛: 写侧把日期条件放进 SQL（行和总数同一把筛子），闭区间两端都含',
    vSrc.includes('recentDreamsPage(limit = 5, offset = 0, project = "", since = 0, until = 0) {') &&
      vSrc.includes('parts.push("run_at >= ?");') &&
      vSrc.includes('parts.push("run_at <= ?");') &&
      vSrc.includes('const where = parts.length === 0 ? "" : "WHERE " + parts.join(" AND ");') &&
      vSrc.includes('dreamCountOf(project = "", since = 0, until = 0) {'),
  )
  check(
    'dream 日期筛: 三个读口都接日期（账本行 / 总数 / 覆盖范围），readDreamSpan 也导出',
    vSrc.includes('function readDreamLedger(workspace, dir = ".dsh-meow", limit = 5, offset = 0, project = "", since = 0, until = 0) {') &&
      vSrc.includes('rows: db.recentDreamsPage(limit, offset, project, since, until),') &&
      vSrc.includes('total: db.dreamCountOf(project, since, until),') &&
      vSrc.includes('dreamsSpan() {') &&
      vSrc.includes('SELECT MIN(run_at) AS a, MAX(run_at) AS b FROM dream_log') &&
      vSrc.includes('function readDreamSpan(workspace, dir = ".dsh-meow")') &&
      vSrc.includes('  readDreamSpan,'),
  )
  check(
    'dream 日期筛: 面板按本机时区解日期，绝不用 Date.parse（那是 UTC，东八区整体错 8 小时）',
    panelSrc.includes('function dayStartOf(raw) {') &&
      panelSrc.includes('const t = new Date(y, mo - 1, d, 0, 0, 0, 0)') &&
      panelSrc.includes('return s === null ? null : s + 86400000 - 1') &&
      // 注释里可以写「不能用 Date.parse」，代码里一个字都不许有——先剥掉注释行再查。
      !panelSrc
        .split('\n')
        .filter((line) => {
          const t = line.trim()
          return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*')
        })
        .join('\n')
        .includes('Date.parse(') &&
      panelSrc.includes('return `UTC${sign}${String(Math.floor(abs / 60)).padStart(2, \'0\')}:${String(abs % 60).padStart(2, \'0\')}`'),
  )
  check(
    'dream 日期筛: 写坏了就打回（坏日期 / 反着写），不猜一个日期去筛',
    panelSrc.includes('function rangeOf(sinceRaw, untilRaw) {') &&
      panelSrc.includes('这种写法不敢猜') &&
      panelSrc.includes('比 until「${untilText}」还晚——这样筛不出任何一条') &&
      panelSrc.includes("if (range.bad !== '') return { body: `${range.bad}这次没有列账。`, scope: '按时间筛的写法被打回，账本一条没动' }"),
  )
  check(
    'dream 日期筛: 打回发生在读账本之前（一次坏日期不该先查库再拒绝），行与总数都带日期',
    (() => {
      const bad = panelSrc.indexOf('if (range.bad !== \'\') return { body:')
      const firstRead = panelSrc.indexOf('Meow.readDreamLedger(')
      return bad > 0 && firstRead > bad
    })() &&
      panelSrc.includes("const ledger = Meow.readDreamLedger(workspace, dir, want, offset, wantProject, range.since, range.until)") &&
      panelSrc.includes('Meow.readDreamLedger(workspace, dir, want, (effectivePage - 1) * want, wantProject, range.since, range.until).rows'),
  )
  check(
    'dream 日期筛: 筛空了要说「这段里没有」+ 账本覆盖范围，不能读成「账本里没有」',
    panelSrc.includes("const span = Meow.readDreamSpan(workspace, dir)") &&
      panelSrc.includes('这段时间里没有${who}整理记录——${cover}') &&
      panelSrc.includes("账本覆盖 ${stamp(span.first)} → ${stamp(span.last)}（本机时区 ${tzLabel()}）") &&
      panelSrc.includes('；项目段「${wantProject}」这段时间里一条都没有'),
  )
  check(
    'dream 日期筛: 展开一条时说清它在不在区间里，但编号/引用口径不变（和项目筛同一条分寸）',
    panelSrc.includes('function rangeNoteOf(row, range) {') &&
      panelSrc.includes('这一条不在 ${range.label} 这段时间里（它写在 ${stamp(at)}）') &&
      panelSrc.includes('[expandPanel(rec, wantId), rangeNoteOf(rec.row, range), filterNote]') &&
      panelSrc.includes('日期筛选也不影响引用'),
  )
  check(
    'dream 日期筛: admin 只把原样日期交过去（解析只写一份，别在两处各写一套）',
    adminSrc.includes('const since = String(args.since ?? \'\').trim()') &&
      adminSrc.includes('const until = String(args.until ?? \'\').trim()') &&
      adminSrc.includes('        since,\n        until,') &&
      adminSrc.includes('写 "2026-11-18"') &&
      auditSrc.includes("'page', 'since', 'until']"),
  )
  check(
    'dream 日期筛: 探针进线（probe-ruler L15–L17 验闭区间与覆盖范围、probe-fusion D43–D45 验面板真念）',
    rulerSrc105.includes('L15 日期是闭区间') &&
      rulerSrc105.includes('L16 时间与项目段叠着筛') &&
      rulerSrc105.includes('L17 账本覆盖范围') &&
      fusionSrc105.includes('D43 since=今天') &&
      fusionSrc105.includes('D44 日期写坏了就打回') &&
      fusionSrc105.includes('D45 空区间要说清'),
  )
  check(
    'dream 日期筛: 版本不早于 0.2.105（两处一致），文档 9.111 / 117 在位',
    (() => {
      const v = pkg.version.split('.').map((x) => Number(x))
      const atLeast = v[0] > 0 || v[1] > 2 || (v[1] === 2 && v[2] >= 105)
      return atLeast && idxSrc.includes(`export const version = '${pkg.version}'`)
    })() &&
      readFileSync(join(root, 'docs', 'INTERNAL.md'), 'utf8').includes('## 9.111') &&
      readFileSync(join(root, 'DESIGN.md'), 'utf8').includes('## 117'),
  )
}

// [macro-fusion 0.2.106] 只念开工那一眼，永远算不出「这一轮让库变轻还是变重」：
// 收尾也数一次，两个点的差单独一格，且必须和「因」（stamped）分开写。
{
  const vSrc = readFileSync(join(root, 'vendor/meow-memory/lib/index.js'), 'utf8')
  const panelSrc = readFileSync(join(root, 'lib', 'macro', 'dreamledger.js'), 'utf8')
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  const idxSrc = readFileSync(join(root, 'lib', 'index.js'), 'utf8')
  const rulerSrc106 = readFileSync(join(root, 'tools', 'probe-ruler.mjs'), 'utf8')
  const fusionSrc106 = readFileSync(join(root, 'tools', 'probe-fusion.mjs'), 'utf8')
  check(
    'dream 库规模: 收尾那一刻也数一次，和开工那份一起进 changes（不靠事后重算）',
    vSrc.includes('plan.storeEnd = dreamStoreScale(db);') &&
      vSrc.includes('plan.storeDelta = plan.storeEnd.active - before;') &&
      vSrc.includes('const before = Number(plan.store?.active);') &&
      vSrc.includes('store=${plan.store?.active ?? "?"}->${plan.storeEnd.active}'),
  )
  check(
    'dream 库规模: 差只在两个点都有数时才算（开工那一格没数就不猜差，别拿 NaN 当 0）',
    vSrc.includes('if (Number.isFinite(before) && before >= 0) plan.storeDelta = plan.storeEnd.active - before;') &&
      vSrc.includes('const storeNote = plan === void 0 || plan.storeEnd === void 0 ? "" :'),
  )
  check(
    'dream 库规模: 面板读收尾数与读开工数用同一套规矩（正数才认、零层不留）',
    panelSrc.includes('function storeEndOf(plan) {') &&
      panelSrc.includes('return storeOf({ store: plan?.storeEnd })') &&
      panelSrc.includes('function storeDeltaOf(plan) {') &&
      panelSrc.includes('if (start === null || end === null) return null') &&
      panelSrc.includes('return { start, end, delta: end.active - start.active }'),
  )
  check(
    'dream 库规模: 两个点都有时连起来念（开工 → 收尾 + 差在句尾），层数走 levelsText 不叠两层括号',
    panelSrc.includes('function levelsText(store) {') &&
      panelSrc.includes('→ 收尾 ${span.end.active} 条在用${levelsText(span.end)}，${word}') &&
      panelSrc.includes('比开工多 ${span.delta} 条') &&
      panelSrc.includes('比开工少 ${-span.delta} 条') &&
      panelSrc.includes("'和开工时一样'"),
  )
  check(
    'dream 库规模: 只有开工数的老账照旧只念一眼（不编收尾、不补 0），空库那句也不动',
    panelSrc.includes('if (store.active === 0 && span === null) return \'库规模：开工时库里 0 条在用记忆——这一轮是在空库上整理的。\'') &&
      panelSrc.includes('if (span === null) return head'),
  )
  check(
    'dream 库规模: 差与因分开写——口径句说清 ±N 是「库变了多少」，归因看 stamped',
    panelSrc.includes('function storeDeltaNote(row) {') &&
      panelSrc.includes('不是「这一轮改了几条」') &&
      panelSrc.includes("这一轮封存/完结 ${stamped} 条（changes.stamped）") &&
      panelSrc.includes('if (span === null) return \'\''),
  )
  check(
    'dream 库规模: 趋势行给收尾净变化，缺收尾数的账要说几次（括号里的括号用破折号拆开）',
    panelSrc.includes('const spans = ordered.map((r) => storeDeltaOf(r.changes?.plan)).filter((s) => s !== null)') &&
      panelSrc.includes('收尾${word}（${spans.length} 次有收尾数）') &&
      panelSrc.includes('次只有开工数、没有收尾数——0.2.106 之前的账没有这一格') &&
      panelSrc.includes('库规模只有 ${storeRows.length} 次有数——更早的账写在 0.2.103 之前，没有这一格'),
  )
  check(
    'dream 库规模: 探针进线（probe-ruler L18–L20 验真开工到真收尾、probe-fusion D46–D48 验面板两条路）',
    rulerSrc106.includes('L18 收尾也数一次') &&
      rulerSrc106.includes('L19 差是净变化，不是「新写了几条」') &&
      rulerSrc106.includes('L20 老账不补收尾数') &&
      fusionSrc106.includes('D46 有收尾数时念两个点') &&
      fusionSrc106.includes('D47 差与因分开') &&
      fusionSrc106.includes('D48 只有开工数的老账不许编收尾'),
  )
  check(
    'dream 库规模: 版本不早于 0.2.106（两处一致），文档 9.112 / 118 在位',
    (() => {
      const v = pkg.version.split('.').map((x) => Number(x))
      const atLeast = v[0] > 0 || v[1] > 2 || (v[1] === 2 && v[2] >= 106)
      return atLeast && idxSrc.includes(`export const version = '${pkg.version}'`)
    })() &&
      readFileSync(join(root, 'docs', 'INTERNAL.md'), 'utf8').includes('## 9.112') &&
      readFileSync(join(root, 'DESIGN.md'), 'utf8').includes('## 118'),
  )
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
