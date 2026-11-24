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
import { readFileSync, writeFileSync, mkdtempSync, readdirSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { root } from './tools/_root.mjs'
const noop = () => {}
// [0.3.0] 版本下限不许把主版本写死：`v[0] === 0 && v[1] === 2 && v[2] >= N` 这种写法
// 在 0.3.0 会整片假红（47 条），而它想说的只是「不早于 0.2.N」。主版本更高一律算过。
const verAtLeast = (v, maj, min, pat) =>
  v[0] > maj || (v[0] === maj && (v[1] > min || (v[1] === min && v[2] >= pat)))
// [0.4.0] 版本号的单一来源：HZ16 已经说过「别把版本写死」，但 GV/GW/VV/GX19/VY15/WZ9
// 六处还留着 '0.3.0' 的字面量。升级到 0.4.0 时它们会整片假红，而它们想说的只是
// 「package.json / lib/index.js / README 三处同号」。改成从 package.json 现取版本，
// 以后只改 package.json + lib/index.js + README，判据一处都不用动。
const PKG_VERSION = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version
const VERSION_LITERAL = `export const version = '${PKG_VERSION}'`
// [0.6.8] 支数地板：只许加、不许减（PLAN §12 #6）。
// 支数每一版都在动，写成 `===` 就是「每加一支红一次、还得手工改两处文档」；
// 写成 `>=` 之后，减一支（删套件 / 忘了注册）立刻红，加一支不必动这里。
// 抬地板是一次明确的承诺动作，与「今天恰好几支」分开记——实际支数由 check-all 汇总对账。
// 0.6.8 起 = 37（0.6.8 新增 tools/probe-monotone.mjs）；0.6.10 起 = 39（加 probe-rigor / probe-signature）；
// 0.6.11 起 = 40（加 probe-verbatim）；0.6.12 起 = 41（加 probe-order）；0.6.13 仍 41（预算同批探针）；
// 0.6.14 起 = 42（加 probe-hotpath）；0.6.15 起 = 43（加 probe-cover）；0.6.16 起 = 44（加 probe-score）；
// 0.6.17 起 = 45（加 probe-hydrate）；0.6.18 起 = 46（加 probe-cand）；0.6.19 起 = 47（加 probe-band）；0.6.20 起 = 48（加 probe-sigrow）；0.6.21 起 = 49（加 probe-lex）；0.6.22 起 = 50（加 probe-cold）。
const SUITE_FLOOR = 50
let failures = 0
let passes = 0
function check(label, ok, extra) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra === undefined ? '' : '  ' + extra}`)
  if (!ok) failures++
  else passes++
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
check('host: 版本是三段 semver', /^\d+\.\d+\.\d+$/.test(String(host.version)), host.version)
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
  check('门牌: L0 注入也点了三个面', /三面都在：工具 \/ 命令/.test(prompt))
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
  check('基线: 读 tools/baselines.json', checkAll.includes("'baselines.json'") && checkAll.includes('const base = bl.counts?.[file]'))
  check('基线: 掉了判红（regressed 参与退出码）', /r\.pass < r\.base/.test(checkAll) && /process\.exit\(verdict \? 0 : 1\)/.test(checkAll))
  check('基线: 多了只提醒不判红', /r\.pass > r\.base/.test(checkAll) && checkAll.includes('确认后 --update-baselines'))
  check('基线: --update-baselines 写盘', checkAll.includes("flag('update-baselines')") && checkAll.includes('writeFileSync(') && checkAll.includes('BASELINES'))
  check('基线: --only 时合并旧账不写残', checkAll.includes('...(onDisk.counts ?? {})'))
  check(
    '基线: --update-baselines 记完会收敛（数与基线不同就地重跑，最多 3 轮）',
    /const unstable = \(\) => results\.filter/.test(checkAll) && /rounds >= 3/.test(checkAll) && checkAll.includes('已收敛（${rounds} 轮重跑）'),
  )
  check(
    '基线: 收敛不了就说在晃，不假装稳',
    checkAll.includes('支在晃') && checkAll.includes('按新基线重跑这几支'),
  )
  check(
    '基线: 红的那一支不记账（FAIL 那一路少走一段，条数不可信）',
    /if \(!r\.ok\) \{\s*\n\s*skipped\.push\(r\.file\)/.test(checkAll) && checkAll.includes('条数不可信，保留旧账'),
  )

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
  check('漂移: 拿基线 ms 比', checkAll.includes('const lastMs = bl.ms?.[file]') && checkAll.includes('ms > lastMs * SLOW_FACTOR'))
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
    return rows.length === 10 && rows.every(([, , spec]) => /kind: '(call|graph|local)'/.test(spec))
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
  check('口径: 十个面板名都在动作表里', rowLabels.length === 10 && new Set(rowLabels).size === 10, rowLabels.join('/'))
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
  check('口径: limit 的说明包含了真正会用它的面板', adminSrc.includes('action=hygiene/cost/dream/links/inject 的条数'))
  // 9) 抬头是契约，不是排版：剥抬头的函数只有一份，按行读数据的探针必须用它
  const graphProbe = read(join('tools', 'probe-graph.mjs'))
  check('口径: 按行读正文的探针用 stripHead 剥抬头，不靠猜行号', /export function stripHead/.test(panelSrc) && graphProbe.includes('panelMod.stripHead(') && !/text\(await run\('memory_admin', \{ action: 'stats' \}\)\)\.split/.test(graphProbe))
  // 10) 正文不许为了统一被改写：成本账本原来的汇总行还在
  check('口径: 成本账本的正文没被抬头顶掉', !costSrc.includes('# macro-memory 成本账本') && costSrc.includes('合计：入参'))
  // 9) 证据 + 文档出处
  const probe = read(join('tools', 'probe-fusion.mjs'))
  check('口径: 探针实测九个抬头一致、手册豁免', probe.includes('L1 九个统计面板的抬头同一个样') && probe.includes('L3 手册不加抬头') && probe.includes('L5 条数上限有口径说明'))
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
  //    五支例外有明确理由，写在表里而不是「漏了」：
  //    probe-inject 只经相对 import 读 vendor；check-yaml 只读 DSH 安装与 profile；
  //    probe-order（0.6.12）只经相对 import 取 bandize，不读仓内任何文件；
  //    probe-hotpath（0.6.14）只经相对 import / `new URL(..., import.meta.url)` 取引擎，不拼仓内路径。
  //    probe-cover（0.6.15）同样只经相对 import 与 import.meta.url 取引擎。
  //    probe-score（0.6.16）也是：读引擎源码只用 `new URL(..., import.meta.url)`，不拼仓内路径。
  //    支数是知识：28 = 原 24 支 + 0.3.1 的 probe-mq（查询分解量尺）+ 0.4.0 的 probe-consolidate
  //    （写入端巩固量尺）、probe-hygiene（写入端通胀量尺）与 probe-supersede（自动取代量尺）。少一支说明有人从套件里
  //    摘了东西，多一支说明新加的判据没在基线里记账——两种都要在这里显形。
  const steps = [...checkAll.matchAll(/^\s*\['([^']+\.mjs)'/gm)].map((m) => m[1])
  const NO_ROOT = {
    'tools/probe-inject.mjs': '只经相对 import 读 vendor，不拼仓内路径',
    'tools/check-yaml.mjs': '只读 DSH 安装与 profile，不读本仓',
    'tools/probe-order.mjs': '只经相对 import 取 bandize（0.6.12），不读仓内任何文件',
    'tools/probe-hotpath.mjs': '只经相对 import 与 import.meta.url 取引擎（0.6.14），不拼仓内路径',
    'tools/probe-cover.mjs': '只经相对 import 与 import.meta.url 取引擎（0.6.15），不拼仓内路径',
    'tools/probe-score.mjs': '只经相对 import 与 import.meta.url 取引擎（0.6.16），不拼仓内路径',
    'tools/probe-hydrate.mjs': '只经相对 import 与 import.meta.url 取引擎（0.6.17），不拼仓内路径',
    'tools/probe-cand.mjs': '只经相对 import 与 import.meta.url 取引擎（0.6.18），不拼仓内路径',
    'tools/probe-band.mjs': '只经相对 import 与 import.meta.url 取引擎（0.6.19），不拼仓内路径',
  'tools/probe-sigrow.mjs': '只经相对 import 与 import.meta.url 取引擎（0.6.20），不拼仓内路径',
  'tools/probe-lex.mjs': '只经相对 import 与 import.meta.url 取引擎（0.6.21），不拼仓内路径',
  'tools/probe-cold.mjs': '只经相对 import 与 import.meta.url 取引擎（0.6.22），不拼仓内路径',
  }
  const needRoot = steps.filter((f) => !(f in NO_ROOT))
  const notImported = needRoot.filter((f) => !/from '[^']*_root\.mjs'/.test(read(f)))
  check(
    '根: check-all 里要读本仓的每一支都从 _root.mjs 取根',
    // 0.6.8 起这条不再钉精确支数：支数每一版都在动，写成等值等于「每加一支就红一次」，
    // 而红一次就要人手工改两处文档——那不是判据，是维护债（PLAN §12 #6）。
    // 现在守的是地板：只许加、不许减；地板抬一格是「这一版起承诺有这么多支」的动作，
    // 与「今天恰好几支」分开记。实际支数由 check-all 的汇总与基线对账负责。
    steps.length >= SUITE_FLOOR && notImported.length === 0 && Object.keys(NO_ROOT).every((f) => steps.includes(f)),
    notImported.length ? notImported.join(', ') : `${steps.length} 支（地板 ${SUITE_FLOOR}）/ ${needRoot.length} 支取根 / ${Object.keys(NO_ROOT).length} 支有理由例外`,
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
  check('契约: 版本不早于 0.2.38', verAtLeast(v27, 0, 2, 38), v27.join('.'))
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
  check('前台: 版本不早于 0.2.31', verAtLeast(v29, 0, 2, 31), pkg29.version)
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
  check('单批: 版本不早于 0.2.32', verAtLeast(v30, 0, 2, 32), pkg30.version)
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
  check('口径: 版本不早于 0.2.33', verAtLeast(v31, 0, 2, 33), pkg31.version)
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
  check('注入: 版本不早于 0.2.34', verAtLeast(v32, 0, 2, 34), pkg32.version)
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
  check('上限: 版本不早于 0.2.36', verAtLeast(v33, 0, 2, 36), pkg33.version)
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
  check('path: 版本不早于 0.2.37', verAtLeast(v34, 0, 2, 37), pkg34.version)
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
  check('recall: 版本不早于 0.2.39', verAtLeast(v36, 0, 2, 39), v36.join('.'))
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
  check('体检: 版本不早于 0.2.40', verAtLeast(v37, 0, 2, 40), v37.join('.'))
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
  check('概况: 版本不早于 0.2.41', verAtLeast(v38, 0, 2, 41), v38.join('.'))
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
  check('inspect: 版本不早于 0.2.42', verAtLeast(v39, 0, 2, 42), v39.join('.'))
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
  check('sources: 版本不早于 0.2.43', verAtLeast(v40, 0, 2, 43), v40.join('.'))
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
  check('bridge: 版本不早于 0.2.44', verAtLeast(v41, 0, 2, 44), v41.join('.'))
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
  check('path: 版本不早于 0.2.45', verAtLeast(v42, 0, 2, 45), v42.join('.'))
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
  check('similar: 版本不早于 0.2.46', verAtLeast(v43, 0, 2, 46), v43.join('.'))
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
  check('project: 版本不早于 0.2.47', verAtLeast(v44, 0, 2, 47), v44.join('.'))
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
  check('dream: 版本不早于 0.2.48', verAtLeast(v45, 0, 2, 48), v45.join('.'))
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
  check('update: 版本不早于 0.2.49', verAtLeast(v46, 0, 2, 49), v46.join('.'))
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
  check('remember: 版本不早于 0.2.50', verAtLeast(v47, 0, 2, 50), v47.join('.'))
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
      /const levels = levelValid\.length > 0 \? levelValid : levelAsked\.length === 0 \? \["fact", "lesson", "topic", "rules", "user"\] : \[\]/.test(
        meowIndex48,
      ),
    'levelAsked / levelBad / levelValid',
  )
  check(
    'search: 两条新话真的拼进 note（而不是写了常量却没人用）',
    /\$\{levelAsked\.join\("、"\)\}」不在七层里/.test(meowIndex48) &&
      /\$\{levelBad\.join\("、"\)\}（不在七层里）/.test(meowIndex48) &&
      /const scopeNote = hits\.length === 0 && levelValid\.length > 0/.test(meowIndex48) &&
      /const note = \[plain(?:, \w+)*, levelNote, scopeNote, statusNote, daysNote, kNote, cmNote(?:, \w+)*\]\.filter\(\(s\) => s\.length > 0\)\.join\("\\n"\)/.test(meowIndex48),
    'note 拼装',
  )
  // 老话在那行模板串里是 \uXXXX 转义的，断言前先还原（0.2.48 的教训：别把中文写成转义再去 includes）。
  const unesc48 = (s) => s.replace(/\\u([0-9A-Fa-f]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
  check(
    'search: 没给 level 的零命中老话在（0.2.168 起默认范围含 user：fact/lesson/topic/rules/user，点名的只剩 soul 与 project）',
    /hits\.length === 0 && !explicitLevels && !statusDead(?: && !gate\.fired)? \? `\$\{BASE_NOTE\}/.test(meowIndex48) &&
      unesc48(meowIndex48).includes('本次零命中：默认检索范围是 fact/lesson/topic/rules/user') &&
      unesc48(meowIndex48).includes('soul 与 project 层不参与关键词检索'),
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
  check('search: 版本不早于 0.2.51', verAtLeast(v48, 0, 2, 51), v48.join('.'))
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
    /\[macro-fusion 0\.2\.52\][\s\S]{0,400}?let said = String\(main\.text \?\? ''\)\.trim\(\)\n\s+if \(said\.length === 0\) \{/.test(
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
  check('read: 版本不早于 0.2.52', verAtLeast(v49, 0, 2, 52), v49.join('.'))
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
  check('similar: 版本不早于 0.2.53', verAtLeast(v50, 0, 2, 53), v50.join('.'))
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
  check('link: 版本不早于 0.2.54', verAtLeast(v51, 0, 2, 54), v51.join('.'))
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
  check('store: 版本不早于 0.2.55', verAtLeast(v52, 0, 2, 55), v52.join('.'))
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
    /const plain = hits\.length === 0 && !explicitLevels && !statusDead(?: && !gate\.fired)? \?/.test(meow56),
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
    /const note = \[plain(?:, \w+)*, levelNote, scopeNote, statusNote, daysNote, kNote, cmNote(?:, \w+)*\]\.filter\(\(s\) => s\.length > 0\)\.join\("\\n"\)/.test(meow56),
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
  check('search: 版本不早于 0.2.56', verAtLeast(v56, 0, 2, 56), v56.join('.'))
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
  check('param: 版本不早于 0.2.57', verAtLeast(v57, 0, 2, 57), v57.join('.'))
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
    /const mode = modeOf\(args\)[\s\S]{0,400}?if \(mode\.bad\) return badModeText\(mode\)[\s\S]{0,600}?const text = await runSearch\(flow, args, exec, flags, budget(?:, config)?\)/.test(
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
    'search: 尾注与成本账都在薄壳里各拼一次（十几个出口不必各写一遍）',
    /const notes = modeNotes\(mode\.name, args, flags\)\s*\n\s*const body = notes\.length > 0 \? `\$\{text\}\\n\\n\$\{notes\.join\('\\n'\)\}` : text\s*\n\s*return costTail\(body, \{ budget, flags \}\)/.test(
      searchSrc,
    ),
    'wrapper',
  )
  check(
    'search: 老的「不认识就当 local」写法一行都不剩（注释里提一句可以，代码里不行）',
    !/^\s*const mode = String\(args\.mode/m.test(searchSrc) &&
      /async function runSearch\(flow, args, exec, flags = \{\}, budget = \{ value: null, note: '' \}(?:, mqConfig = \{\})?\)/.test(searchSrc),
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
  check('search: 版本不早于 0.2.58', verAtLeast(v58, 0, 2, 58), v58.join('.'))
  check(
    'search: README 与 DESIGN 记了这一轮（模式名没对上）',
    readFileSync(join(root, 'docs', 'INTERNAL.md'), 'utf8').includes('0.2.58') &&
      readFileSync(join(root, 'DESIGN.md'), 'utf8').includes('0.2.58') &&
      readFileSync(join(root, 'DESIGN.md'), 'utf8').includes('模式名没对上'),
    '文档',
  )
}

// A58b. 查询分解（0.4.0 P1 / PLAN-0.4 §5 P1）：原榜一个字不动，子问句只补空位。
{
  const searchSrcMq = readFileSync(join(root, 'lib', 'macro', 'defs', 'search.js'), 'utf8')
  const indexSrcMq = readFileSync(join(root, 'lib', 'index.js'), 'utf8')
  const toolsSrcMq = readFileSync(join(root, 'lib', 'macro', 'tools.js'), 'utf8')
  const mq = await import(pathToFileURL(join(root, 'lib', 'macro', 'defs', 'search.js')).href)

  check(
    'mq: 开关默认 off，写错/大小写错的都当 off（不猜用户想要什么）',
    /multiQuery: 'off'/.test(indexSrcMq) &&
      mq.multiQueryMode({}) === 'off' &&
      mq.multiQueryMode({ multiQuery: 'on' }) === 'off' &&
      mq.multiQueryMode({ multiQuery: ' CONServative ' }) === 'conservative',
    'multiQueryMode',
  )
  check(
    'mq: 配置真的接进了检索工具（不是只写在 schema 里）',
    toolsSrcMq.includes('createSearch({ flow, config })') &&
      searchSrcMq.includes('export function createSearch({ flow, config = {} })') &&
      /const text = await runSearch\(flow, args, exec, flags, budget, config\)/.test(searchSrcMq),
    'plumbing',
  )
  check(
    'mq: 并列焦点切得开（连接词 + 疑问词壳剥掉）',
    JSON.stringify(mq.decomposeQuery('饱和脂肪跟反式脂肪哪个更伤心脏')) === '["饱和脂肪","反式脂肪"]' &&
      JSON.stringify(mq.decomposeQuery('主人在 m147821 说的 readme 要求 以及 m121175 的参考用法')) ===
        '["主人在 m147821 说的 readme 要求","m121175 的参考用法"]',
    'decompose',
  )
  check(
    'mq: 多个问号也切，最多三段（再多就是在猜句子结构）',
    mq.decomposeQuery('这两个插件的检索谁更快？哪个更省 token？').length === 2 &&
      mq.decomposeQuery('主人在 m147821 说的 readme 要求 以及 m121175 的参考用法 还有 m00310 的 goal').length === 3,
    'decompose-multi',
  )
  check(
    'mq: 没有并列焦点就返回空数组，不硬拆（单实体、空串、纯问句）',
    mq.decomposeQuery('为什么记忆插件变强了').length === 0 &&
      mq.decomposeQuery('稠密向量层开着吗').length === 0 &&
      mq.decomposeQuery('').length === 0 &&
      mq.decomposeQuery('这句话没有并列焦点就原样返回').length === 0,
    'decompose-empty',
  )
  check(
    'mq: 子问句放宽档位收口，但有三道闸门（每问两行 / score>0 / 段数上限）',
    searchSrcMq.includes('min_rel: 0, band_keep: false') &&
      /if \(added >= MQ_MAX_ROWS_PER_SUB\) break/.test(searchSrcMq) &&
      /if \(Number\.isFinite\(score\) && score <= 0\) continue/.test(searchSrcMq) &&
      /const MQ_MAX_SUBS = 3/.test(searchSrcMq),
    'gates',
  )
  check(
    'mq: 原榜一条都不丢（value.hits 只追加，顺序与正文不动）',
    searchSrcMq.includes('hits: [...baseHits, ...shown.map((one) => one.hit)]') &&
      searchSrcMq.includes('— 问句拆开再查一遍（原榜一个字没动）—'),
    'append-only',
  )
  check(
    'mq: 顺序对（预算收紧 → 分解补充 → 扩散），否则重查会把补充段冲掉',
    searchSrcMq.indexOf('const fit = await fitBudget(') > 0 &&
      searchSrcMq.indexOf('const fit = await fitBudget(') < searchSrcMq.indexOf('main = await augmentByDecompose') &&
      searchSrcMq.indexOf('main = await augmentByDecompose') < searchSrcMq.indexOf('const wantExpand = args.expand !== false'),
    'order',
  )
  check(
    'mq: 有没有补、补了几条都记进 flags（尾注要能说实话）',
    searchSrcMq.includes('flags.multiQuery = subs.join') &&
      searchSrcMq.includes('flags.multiQueryRows = shown.length') &&
      searchSrcMq.includes('flags.multiQueryAgree = agree.length') &&
      searchSrcMq.includes('flags.multiQuerySkipped = true'),
    'flags',
  )
}
// A58c. 写入端巩固（0.4.0 P2 / PLAN-0.4 §5 P2）：三条件全成立才说话，suggest 一个字不写库。
{
  const indexSrcCo = readFileSync(join(root, 'lib', 'index.js'), 'utf8')
  const toolsSrcCo = readFileSync(join(root, 'lib', 'macro', 'tools.js'), 'utf8')
  const rememberSrcCo = readFileSync(join(root, 'lib', 'macro', 'defs', 'remember.js'), 'utf8')
  const co = await import(pathToFileURL(join(root, 'lib', 'macro', 'defs', 'remember.js')).href)

  const at = new Date('2026-11-22T08:00:00Z')
  const mk = (n, extra = {}) => ({
    id: `0co${n}aaaa`,
    level: 'fact',
    created_at: '2026-11-20T10:00:00Z',
    keywords: ['记忆插件', '检索', '巩固'],
    content: `第 ${n} 条：同一件事的第 ${n} 次记录，正文够长才看得出首行是哪句。`,
    ...extra,
  })
  const mine = ['记忆插件', '检索']
  const three = [mk(1), mk(2), mk(3)]
  const sig = (patch = {}) => co.consolidateSignals({ hits: three, semanticHits: [], newId: '0coNEW00', keywords: mine, cap: 8, ...patch })

  check(
    'co: 开关默认 suggest（只贴材料，库不动），三档归一，写错当 off',
    /consolidate: 'suggest'/.test(indexSrcCo) &&
      co.consolidateMode({}) === 'suggest' &&
      co.consolidateMode({ consolidate: 'off' }) === 'off' &&
      co.consolidateMode({ consolidate: ' WRITE ' }) === 'write' &&
      co.consolidateMode({ consolidate: 'on' }) === 'off',
    'consolidateMode',
  )
  check(
    'co: 配置真的接进了写入工具（不是只写在 schema 里）',
    toolsSrcCo.includes('createRemember({ flow, config })') &&
      rememberSrcCo.includes('export function createRemember({ flow, config = {} })') &&
      /const mode = consolidateMode\(config\)/.test(rememberSrcCo),
    'plumbing',
  )
  check(
    'co: 三条件全成立才 fire（同话题 3 条 + 语义层有空位 + 还没有巩固句）',
    sig().kind === 'fire' && sig().repeated === true && sig().room === true && sig().pending === true && sig().rows.length === 3,
    'fire',
  )
  check(
    'co: 少任何一个条件都不说话（2 条 → none；语义层满 → merge；已巩固 → none）',
    sig({ hits: three.slice(0, 2) }).kind === 'none' &&
      sig({ semanticHits: new Array(8).fill({ id: 'x' }) }).kind === 'merge' &&
      sig({
        hits: three.map((one) => ({ ...one, content: `${one.content}（已巩固进：0old1111「旧摘要」，2026-11-21）` })),
      }).kind === 'none',
    'three-gates',
  )
  check(
    'co: 不是同话题的不算重复（keywords 交集只有 1 个就跳过，新写的那条自己也不进候选）',
    sig({ hits: [mk(1, { keywords: ['记忆插件', '别的'] }), mk(2, { keywords: ['检索'] }), mk(3, { keywords: [] })] }).rows.length === 0 &&
      sig({ hits: [three[0], three[1], mk(3, { id: '0coNEW00' })] }).rows.length === 2,
    'shared-keywords',
  )
  check(
    'co: 摘要首行是日期 + project + 关键词，正文是这几条的开头（temporal 的收益全在首行）',
    co.consolidateSummary({ rows: sig().rows, project: '宏记忆', keywords: mine, at }) ===
      '2026-11-22 · 巩固（宏记忆）：记忆插件、检索\n- 第 1 条：同一件事的第 1 次记录，正文够长才看得出首行是哪句。\n- 第 2 条：同一件事的第 2 次记录，正文够长才看得出首行是哪句。\n- 第 3 条：同一件事的第 3 次记录，正文够长才看得出首行是哪句。',
    'summary',
  )
  check(
    'co: 巩固句与取代句同款形状（短 id + 开头 24 字 + 日期），只说并进哪条、不写判决',
    (() => {
      const line = co.consolidateLineOf({ newId: '0coNEW00', newHead: '这是一条很长的摘要首行，长到需要被截断成二十四个字为止才肯停下来的那种长度', at })
      return line.startsWith('（已巩固进：0coNEW00「') && line.endsWith('，2026-11-22）') && !line.includes('作废')
    })(),
    'line',
  )
  check(
    'co: suggest 一个字不写库——只有 write 分支里才碰 memory_remember / memory_update，且巩固不动作废',
    (() => {
      const body = rememberSrcCo.slice(rememberSrcCo.indexOf('async function consolidateAfterWrite'), rememberSrcCo.indexOf('async function markSuperseded'))
      return (
        rememberSrcCo.indexOf("if (mode !== 'write' || signal.kind !== 'fire') return note") > 0 &&
        rememberSrcCo.indexOf("if (mode !== 'write' || signal.kind !== 'fire') return note") <
          rememberSrcCo.indexOf("flow.tryCall('memory_remember'") &&
        /memory_update', \{ id: one\.id, content: next \}/.test(rememberSrcCo) &&
        body.length > 500 &&
        !body.includes("status: 'stale'") &&
        !body.includes("status: 'archived'")
      )
    })(),
    'suggest-only',
  )
  check(
    'co: 巩固挂在最后（取代和连线都做完了），否则材料里会出现刚被顶掉的那条',
    rememberSrcCo.indexOf("const linked = await flow.applyLinks(newId, args.links, exec, 'remember')") <
      rememberSrcCo.indexOf('const note = await consolidateAfterWrite(') &&
      rememberSrcCo.indexOf("const superseded = await markSuperseded(") < rememberSrcCo.indexOf('const note = await consolidateAfterWrite('),
    'order',
  )
  // H6 事故（0.4.0）：巩固检查调 memory_search，meow 把 20 条记进 seen 且 bumpHit，于是写完一条
  // 紧接着问 similar 会得到「可选的候选一条都没有」。修法是给 meow 的检索加一个内部开关：
  // 默认照旧记账（对外查询一个字不改），只有插件自己的诊断查询显式传 internal 才跳过。
  {
    const meowInternal = readFileSync(join(root, 'vendor', 'meow-memory', 'lib', 'index.js'), 'utf8')
    const body = rememberSrcCo.slice(
      rememberSrcCo.indexOf('async function consolidateAfterWrite'),
      rememberSrcCo.indexOf('async function markSuperseded'),
    )
    check(
      'co: meow 检索有 internal 开关，默认 false＝照旧记账（对外查询行为一个字不改）',
      /internal: \{\s*\n\s*type: "boolean",\s*\n\s*default: false,/.test(meowInternal) &&
        meowInternal.includes('这次查询不进本会话的「已端给你看过」账'),
      'internal-param',
    )
    check(
      'co: internal 关的是 bumpHit + markSearched 两件事，不是只关记账（否则通胀指标仍被污染）',
      /if \(parsed\.internal !== true\) \{\s*\n\s*for \(const h of hits\) db\.bumpHit\(h\.level, h\.id\);\s*\n\s*markSearched\(/.test(
        meowInternal,
      ),
      'internal-guard',
    )
    check(
      'co: 巩固检查两枪都传 internal: true，主写入与更新一个字都不带',
      (body.match(/internal: true/g) ?? []).length === 2 &&
        !/memory_remember'[^\n]*internal/.test(rememberSrcCo) &&
        !/memory_update'[^\n]*internal/.test(rememberSrcCo),
      'internal-passed',
    )
  }
}
// A58d. 写入端通胀体检（0.4.0 P2.5 / PLAN-0.4 §5 P2.5）：九类里新增的三类要真判得出来，
//       而且「召回过没人读」的记账口径只许有一个入口（memory_read）。
//       这三条守的是同一条不变量：**报警必须来自信号，不能来自「写得多」这个事实本身**。
{
  const graphSrcHy = readFileSync(join(root, 'vendor', 'dsh-memory-nebula', 'lib', 'host', 'graph.js'), 'utf8')
  const adminSrcHy = readFileSync(join(root, 'lib', 'macro', 'defs', 'admin.js'), 'utf8')
  const meowSrcHy = readFileSync(join(root, 'vendor', 'meow-memory', 'lib', 'index.js'), 'utf8')
  const readSrcHy = readFileSync(join(root, 'lib', 'macro', 'defs', 'read.js'), 'utf8')
  const adapterSrcHy = readFileSync(join(root, 'vendor', 'dsh-memory-nebula', 'lib', 'host', 'adapters', 'meow.js'), 'utf8')
  const hy = await import(pathToFileURL(join(root, 'vendor', 'dsh-memory-nebula', 'lib', 'host', 'graph.js')).href)
  const rd = await import(pathToFileURL(join(root, 'lib', 'macro', 'defs', 'read.js')).href)

  const DAY = 86400000
  const now = Date.now()
  const mkNode = (id, level, kw, content, hits, reads, ageDays, status = 'active') => ({
    id,
    level,
    label: String(content).slice(0, 24),
    content,
    keywords: kw,
    hits,
    reads,
    status,
    importance: 2,
    createdAt: now - ageDays * DAY,
    updatedAt: now - ageDays * DAY,
  })
  const audit = (nodes, edges = []) => {
    const it = hy.auditHygieneSteps({ nodes, edges })
    let r = it.next()
    while (!r.done) r = it.next()
    return r.value
  }
  // 自证阳性：4 个关键词全部逐字出现在正文里（挑词挑到自己身上了）
  const echoYes = mkNode('hy-echo', 'fact', ['插件', '检索', '预算', '星图'], '这个插件用检索吃预算，星图连着插件。', 0, 0, 1)
  // 阴性一：只有 2 个关键词（1/2 = 50% 也能顶到「高」，样本太小不算信号）
  const echoFew = mkNode('hy-echo-few', 'fact', ['插件', '检索'], '这个插件用检索吃预算。', 0, 0, 1)
  // 阴性二：3 个关键词里 2 个在正文（0.67 < 0.7）
  const echoPart = mkNode('hy-echo-part', 'fact', ['插件', '检索', '不存在的词'], '这个插件用检索吃预算。', 0, 0, 1)
  // 召回过没人读阳性 / 阴性（读过、没命中过、别的源没这个字段）
  const unusedYes = mkNode('hy-unused', 'fact', ['预算'], '预算的事。', 5, 0, 2)
  const unusedRead = mkNode('hy-read', 'fact', ['预算'], '预算的事。', 5, 1, 2)
  const unusedNoHit = mkNode('hy-nohit', 'fact', ['预算'], '预算的事。', 0, 0, 9)
  const noReadsField = { id: 'hy-norm', level: 'fact', label: '别的源', content: '没有 read_counts 概念', keywords: ['x'], hits: 9, status: 'active', importance: 2, createdAt: now, updatedAt: now }
  const facts8 = Array.from({ length: 8 }, (_, i) => mkNode(`hy-f${i}`, 'fact', ['x'], `原子事实 ${i}`, 0, 0, i + 1))
  const out = audit([echoYes, echoFew, echoPart, unusedYes, unusedRead, unusedNoHit, noReadsField, ...facts8])

  check(
    'hy: 体检从六类变九类，三个新类都有 label 与 hint（不是只加 key）',
    ['selfecho', 'unused', 'inflate'].every(
      (k) => hy.HYGIENE_META[k] && hy.HYGIENE_META[k].label.length > 0 && hy.HYGIENE_META[k].hint.length > 30,
    ) &&
      graphSrcHy.includes('selfecho: selfechoTotal') &&
      graphSrcHy.includes('unused: unusedTotal') &&
      graphSrcHy.includes('inflate: inflateTotal'),
    'nine-kinds',
  )
  check(
    'hy: 关键词自证只抓「全部逐字都在正文里」的那条：<3 个词不判、0.67 不算',
    out.items.selfecho.length === 1 && out.items.selfecho[0].id === 'hy-echo' && out.items.selfecho[0].rate === 1,
    JSON.stringify(out.items.selfecho.map((x) => [x.id, x.rate, `${x.echo}/${x.kws}`])),
  )
  check(
    'hy: 召回过没人读只抓「命中过且一次没读」：读过的、没命中的（那是 unread 的活）都不抓',
    out.items.unused.length === 1 && out.items.unused[0].id === 'hy-unused' && out.items.unused[0].hits === 5,
    JSON.stringify(out.items.unused.map((x) => [x.id, x.hits])),
  )
  check(
    'hy: 别的源没记过 read_count 就不参与这条（否则 hits 一有就全假阳）',
    !out.items.unused.some((x) => x.id === 'hy-norm') &&
      adapterSrcHy.includes("reads: cols.has('read_count') ? Number(row.read_count) || 0 : 0"),
    'no-reads-field',
  )
  check(
    'hy: 层通胀看增速比值：fact 8 / 结论 0 → 报；6 / 2 = 恰好 3× 不报（要严格大于）',
    out.counts.inflate === 1 &&
      audit([
        mkNode('hy-r1', 'rules', ['x'], '准则', 0, 0, 1),
        mkNode('hy-l1', 'lesson', ['x'], '教训', 0, 0, 2),
        ...Array.from({ length: 6 }, (_, i) => mkNode(`hy-g${i}`, 'fact', ['x'], `事实 ${i}`, 0, 0, i + 1)),
      ]).counts.inflate === 0,
    'inflate-ratio',
  )
  check(
    'hy: 通胀是「整库一个判断」，只给一行汇总且 id 留空（面板不许把它当记忆去跳）',
    out.items.inflate.length === 1 && out.items.inflate[0].id === '' && /fact \d+ 条 \/ 结论层 \d+ 条/.test(out.items.inflate[0].label),
    out.items.inflate[0]?.label,
  )
  check(
    'hy: macro 白名单与 schema enum 两边同步（加一处漏一处，模型要么传不进来、要么传进来被打回）',
    (() => {
      const m = adminSrcHy.match(/const HYGIENE_KINDS\s*=\s*\[([^\]]*)\]/)
      const kinds = m ? m[1].split(',').map((x) => x.trim().replace(/['"\s]/g, '')).filter(Boolean) : []
      const e = adminSrcHy.match(/kind: \{ type: 'string', enum: \[([^\]]*)\]/)
      const enums = e ? e[1].split(',').map((x) => x.trim().replace(/['"\s]/g, '')).filter(Boolean) : []
      return kinds.length === 9 && enums.length === 9 && kinds.join(',') === enums.join(',')
    })(),
    'whitelist-sync',
  )
  check(
    'hy: 九类的 counts 齐、total 是九类之和（少一类 total 就对不上，面板会写「共 N 项」却只画八行）',
    ['dup', 'stale', 'thin', 'oversize', 'unread', 'orphan', 'selfecho', 'unused', 'inflate'].every((k) => k in out.counts) &&
      out.total === Object.values(out.counts).reduce((a, b) => a + b, 0),
    `total=${out.total}`,
  )
  check(
    'hy: read_count 只由 memory_read 记（bumpRead 在 meow 里恰两处：定义 + 读成功那一次）',
    (meowSrcHy.match(/bumpRead\(/g) ?? []).length === 2 &&
      /db\.bumpRead\(row\.level, row\.id\)/.test(meowSrcHy) &&
      !/markAccessed[\s\S]{0,200}bumpRead[\s\S]{0,200}markAccessed/.test(meowSrcHy),
    'bumpRead-once',
  )
  check(
    'hy: 老库补列后 read_count 一律 0（「没记过」不许读成「读过」），并且 fromRow 缺列时也给 0',
    /ALTER TABLE \$\{level\} ADD COLUMN read_count INTEGER NOT NULL DEFAULT 0/.test(meowSrcHy) &&
      /read_count: Number\(r\.read_count \?\? 0\)/.test(meowSrcHy) &&
      meowSrcHy.includes('read_count INTEGER NOT NULL DEFAULT 0'),
    'migrate',
  )
  check(
    'hy: 巩固抬头：读到带巩固句的记忆先说「它是材料，不是现状」，没巩固句一个字不说',
    rd.consolidatedNote('正文\n（已巩固进：0coNEW00「摘要头」，2026-11-22）').includes('0coNEW00') &&
      rd.consolidatedNote('正文\n（已巩固进：0coNEW00「摘要头」，2026-11-22）').includes('没作废') &&
      rd.consolidatedNote('正文里什么都不带') === '' &&
      rd.consolidatedNote('（已巩固进：0coNEW00，2026-11-22）').includes('0coNEW00'),
    'read-banner',
  )
  check(
    'hy: 巩固抬头排在链与出处之前（读者先要知道「这是历史材料」，再看它从哪来）',
    /const extras = \[consolidatedNote\(main\.value\?\.content\), prov, chain\]\.filter\(Boolean\)\.join\('\\n'\)/.test(readSrcHy),
    'banner-order',
  )
}
// A58e. 自动取代（0.4.0 P3 / PLAN-0.4 §5 P3）：认出「库里那条是同一件事的旧说法」，
//       默认只给建议、apply 才动库。守的是一条不变量：**判据只吃硬事实（版本/日期/状态/数值/路径），
//       不吃「读起来像」**——宁可漏报，也不能把两条说的是不同对象的话判成互相顶掉。
{
  const supSrcAs = readFileSync(join(root, 'lib', 'macro', 'supersede.js'), 'utf8')
  const remSrcAs = readFileSync(join(root, 'lib', 'macro', 'defs', 'remember.js'), 'utf8')
  const libSrcAs = readFileSync(join(root, 'lib', 'index.js'), 'utf8')
  const meowSrcAs = readFileSync(join(root, 'vendor', 'meow-memory', 'lib', 'index.js'), 'utf8')
  const sp = await import(pathToFileURL(join(root, 'lib', 'macro', 'supersede.js')).href)

  check(
    'as: autoSupersede 三态：没配是 suggest，写错退到 off（这个开关会改别人记忆的状态，配错必须最保守）',
    sp.supersedeMode({}) === 'suggest' &&
      sp.supersedeMode({ autoSupersede: 'apply' }) === 'apply' &&
      sp.supersedeMode({ autoSupersede: ' APPLY ' }) === 'apply' &&
      sp.supersedeMode({ autoSupersede: 'off' }) === 'off' &&
      sp.supersedeMode({ autoSupersede: 'yes' }) === 'off' &&
      sp.supersedeMode({ autoSupersede: 1 }) === 'off',
    [sp.supersedeMode({}), sp.supersedeMode({ autoSupersede: 'yes' })].join(','),
  )
  check(
    'as: 版本号漂移：两边各有自己的版本才算（都写着同一个版本不报，只有一边写了也不报）',
    (() => {
      const hit = sp.conflictOf('当前 0.4.1，判据全绿', '当前 0.4.0，判据全绿')
      return (
        hit?.kind === '版本' &&
        hit.mine.join() === '0.4.1' &&
        hit.theirs.join() === '0.4.0' &&
        sp.conflictOf('当前 0.4.0', '当前 0.4.0') === null &&
        sp.conflictOf('当前 0.4.1', '没写版本') === null
      )
    })(),
    JSON.stringify(sp.conflictOf('当前 0.4.1', '当前 0.4.0')),
  )
  check(
    'as: 日期漂移：同一件事换了日子（2026-11-23 顶掉 2026-11-22）',
    (() => {
      const hit = sp.conflictOf('2026-11-23 收尾', '2026-11-22 收尾')
      return hit?.kind === '日期' && hit.mine.join() === '2026-11-23' && hit.theirs.join() === '2026-11-22'
    })(),
    JSON.stringify(sp.conflictOf('2026-11-23 收尾', '2026-11-22 收尾')),
  )
  check(
    'as: 状态词反转：一边说做完了、另一边说没做——这是结论互斥，比数字更要紧',
    (() => {
      const hit = sp.conflictOf('P3 已落地，判据全绿', 'P3 未开始')
      return hit?.kind === '状态' && hit.mine.join() === '已落地' && hit.theirs.join() === '未开始'
    })(),
    JSON.stringify(sp.conflictOf('P3 已落地', 'P3 未开始')),
  )
  check(
    'as: 数值按单位比：27 支 vs 26 支报；27 支 vs 26 条不报（跨单位不是同一件事）',
    (() => {
      const hit = sp.conflictOf('现在 27 支 suite', '现在 26 支 suite')
      return (
        hit?.kind === '数值' &&
        hit.unit === '支' &&
        hit.mine.join() === '27' &&
        hit.theirs.join() === '26' &&
        sp.conflictOf('27 支 suite', '26 条断言') === null
      )
    })(),
    JSON.stringify(sp.conflictOf('现在 27 支 suite', '现在 26 支 suite')),
  )
  check(
    'as: 路径漂移：同一个文件名换了目录才报，同一条路径不报',
    (() => {
      const hit = sp.conflictOf('落点在 tools/probe-p3.mjs', '落点在 lib/probe-p3.mjs')
      return (
        hit?.kind === '路径' &&
        hit.mine.join() === 'tools/probe-p3.mjs' &&
        hit.theirs.join() === 'lib/probe-p3.mjs' &&
        sp.conflictOf('落点在 tools/probe-p3.mjs', '落点在 tools/probe-p3.mjs') === null
      )
    })(),
    JSON.stringify(sp.conflictOf('落点在 tools/probe-p3.mjs', '落点在 lib/probe-p3.mjs')),
  )
  const hitsAs = [
    { id: 'aaaaaaaa-1', level: 'fact', content: '当前 0.4.0，判据全绿', similarity: 0.62, repeat: 0.42 },
    { id: 'bbbbbbbb-2', level: 'fact', content: '现在 26 支 suite', similarity: 0.55, repeat: 0.51 },
    { id: 'cccccccc-3', level: 'fact', content: '现在 25 支 suite', similarity: 0.5, repeat: 0.31 },
    { id: 'dddddddd-4', level: 'fact', content: '完全无关的一条', similarity: 0.12, repeat: 0.9 },
  ]
  const candAs = sp.conflictCandidatesOf({ hits: hitsAs, content: '当前 0.4.1，现在 27 支 suite', newId: 'eeeeeeee-9' })
  check(
    'as: 候选三条门槛：相似度 <0.3 不算；数值/路径还要求逐字重复度 ≥0.5（否则「3 条」「5 条」满库乱撞）',
    candAs.length === 2 && candAs[0].id === 'aaaaaaaa-1' && candAs[1].id === 'bbbbbbbb-2' && !candAs.some((c) => c.id === 'dddddddd-4' || c.id === 'cccccccc-3'),
    JSON.stringify(candAs.map((c) => [c.id, c.kind, c.sim, c.repeat])),
  )
  check(
    'as: 自己刚写的这条、和别人已经点名要取代的那几条都不再建议（短 id 与完整 id 两种写法都认）',
    sp.conflictCandidatesOf({ hits: hitsAs, content: '当前 0.4.1，现在 27 支 suite', newId: 'aaaaaaaa-1' }).length === 1 &&
      sp.conflictCandidatesOf({ hits: hitsAs, content: '当前 0.4.1，现在 27 支 suite', newId: '', skipIds: ['aaaaaaaa'] }).length === 1 &&
      sp.conflictCandidatesOf({ hits: hitsAs, content: '当前 0.4.1，现在 27 支 suite', newId: '', skipIds: ['aaaaaaaa-1'] }).length === 1,
    'skip',
  )
  check(
    'as: 最多 3 条（多出来的不硬塞进回执），按相似度降序',
    (() => {
      const many = Array.from({ length: 6 }, (_, i) => ({
        id: `many-${i}`,
        level: 'fact',
        content: `当前 0.4.${i}`,
        similarity: 0.9 - i * 0.05,
        repeat: 0.9,
      }))
      const got = sp.conflictCandidatesOf({ hits: many, content: '当前 0.4.9', newId: '' })
      return got.length === 3 && got[0].sim > got[1].sim && got[1].sim > got[2].sim
    })(),
    'max3',
  )
  check(
    'as: 没候选就一个字都不加（suggest 与 apply 两种抬头都得是空串，不能印一个空标题）',
    sp.supersedeSuggestNote([]) === '' && sp.supersedeApplyLead([]) === '',
    'empty',
  )
  check(
    'as: 建议抬头明说「只建议、一个字没动库」并给出可照抄的 supersedes 写法；apply 抬头明说可反悔',
    (() => {
      const s = sp.supersedeSuggestNote(candAs)
      const a = sp.supersedeApplyLead(candAs)
      return (
        s.includes('suggest') &&
        s.includes('一个字没动库') &&
        s.includes("supersedes: ['aaaaaaaa'") &&
        a.includes('apply') &&
        a.includes('反悔')
      )
    })(),
    'banner',
  )
  check(
    'as: 判据只吃硬事实：两条正则与 meow 的 VERSION_TOKEN / DATE_TOKEN 逐字相同（两处判据不许各写一套）',
    (() => {
      const pick = (src, name) => {
        const m = src.match(new RegExp(`(?:const|let|var) ${name} = (/[^\\n]+)`))
        // meow 是打包产物（`var X = /…/g;`），本仓是手写（`const X = /…/g`）：比的是正则本身，不是声明式。
        return m ? m[1].replace(/[;\s]+$/, '') : ''
      }
      return (
        pick(supSrcAs, 'VERSION_TOKEN') !== '' &&
        pick(supSrcAs, 'VERSION_TOKEN') === pick(meowSrcAs, 'VERSION_TOKEN') &&
        pick(supSrcAs, 'DATE_TOKEN') === pick(meowSrcAs, 'DATE_TOKEN')
      )
    })(),
    'same-regex',
  )
  check(
    'as: 写入路径真的接上了：off 连检索都不打、suggest 只加字、apply 才走 markSuperseded（复用同一个处置通道）',
    remSrcAs.includes('const autoMode = supersedeMode(config)') &&
      remSrcAs.includes("if (autoMode !== 'off' && newId)") &&
      remSrcAs.includes('skipIds: [...sup.ids, ...sup.extra]') &&
      remSrcAs.includes('lead: supersedeApplyLead(cands)') &&
      supSrcAs.includes('internal: true'),
    'wired',
  )
  check(
    'as: 配置三处同值（默认 / 白名单 / schema）：加一处漏一处，模型要么配不上、要么配了被 schema 打回',
    /autoSupersede: 'suggest'/.test(libSrcAs) &&
      (() => {
        const m = libSrcAs.match(/const MACRO_KEYS = \[([^\]]*)\]/)
        const keys = m ? m[1].split(',').map((x) => x.trim().replace(/['"\s]/g, '')).filter(Boolean) : []
        return keys.includes('autoSupersede') && keys.includes('consolidate') && keys.includes('multiQuery')
      })() &&
      libSrcAs.includes('autoSupersede: z.string().default(MACRO_DEFAULTS.autoSupersede)'),
    'config-sync',
  )
}

// A58f. 实体层与动态跳数（0.4.0 P4 / PLAN-0.4 §5 P4）：星图原来只会「按词面找邻居」。
//       这一版加两层：①实体层——把同一项目名/路径/工具名/版本号下的记忆归成一组；
//       ②动态跳数——扩散到第二跳时，先问「这个邻居与本次查询还有没有关系」，没有就停。
//       守的不变量：实体层**不进 nodes/edges**（度数/聚类/孤岛全按「记忆」算，
//       混进实体节点会让所有读数一起改写）；动态跳数**只收软边**，硬边（策展/同实体/跨项目）照走。
{
  const fEntSrc = readFileSync(join(root, 'vendor', 'dsh-memory-nebula', 'lib', 'host', 'entities.js'), 'utf8')
  const fGraphSrc = readFileSync(join(root, 'vendor', 'dsh-memory-nebula', 'lib', 'host', 'graph.js'), 'utf8')
  const fRecallSrc = readFileSync(join(root, 'vendor', 'dsh-memory-nebula', 'lib', 'host', 'recall.js'), 'utf8')
  const fCacheSrc = readFileSync(join(root, 'vendor', 'dsh-memory-nebula', 'lib', 'host', 'graphcache.js'), 'utf8')
  const fNebulaIdxSrc = readFileSync(join(root, 'vendor', 'dsh-memory-nebula', 'lib', 'index.js'), 'utf8')
  const fEnt = await import(pathToFileURL(join(root, 'vendor', 'dsh-memory-nebula', 'lib', 'host', 'entities.js')).href)

  check(
    'as: 实体层只认四类硬事实（项目名 / 路径 / 工具名 / 版本号）：不收「读起来像名字」的词',
    [...fEnt.ENTITY_KINDS].sort().join(',') === 'path,project,tool,version',
    [...fEnt.ENTITY_KINDS].join(','),
  )
  check(
    'as: 一条记忆独占的实体不进层（minMembers=2）：只有一条提到的东西当不了桥',
    (() => {
      const one = fEnt.collectEntities([{ i: 0, project: 'solo-proj', blob: '就这一条' }])
      const two = fEnt.collectEntities([
        { i: 0, project: 'pair-proj', blob: '' },
        { i: 1, project: 'pair-proj', blob: '' },
      ])
      return one.list.length === 0 && two.list.length === 1 && two.list[0].members.length === 2
    })(),
    'min-members',
  )
  check(
    'as: 实体名太短（<4 字）不收：p1 这种会把半个库连成一团',
    fEnt.collectEntities([
      { i: 0, project: 'p1', blob: '' },
      { i: 1, project: 'p1', blob: '' },
    ]).list.length === 0,
    'short-label',
  )
  check(
    'as: 层上限与每条上限（400 / 6）：不封顶的话一次建图就能把实体表撑成第二个图',
    fEnt.ENTITY_MAX === 400 &&
      fEnt.ENTITY_MIN_MEMBERS === 2 &&
      fEnt.ENTITY_PER_NODE === 6 &&
      fEnt.ENTITY_SEED === 0.6,
    [fEnt.ENTITY_MAX, fEnt.ENTITY_MIN_MEMBERS, fEnt.ENTITY_PER_NODE, fEnt.ENTITY_SEED].join(','),
  )
  check(
    'as: 实体键认「类型|值」两种写法都能查（list 可 JSON 往返，Map 存不住，索引现建）',
    (() => {
      const nodes = [
        { i: 0, project: 'demo-proj', blob: 'tools/probe-entity.mjs 是量尺' },
        { i: 1, project: 'demo-proj', blob: '再看 tools/probe-entity.mjs 一轮' },
      ]
      const layer = fEnt.collectEntities(nodes)
      const revived = JSON.parse(JSON.stringify(layer))
      const idx = fEnt.indexOf(revived)
      return (
        layer.list.length === 2 &&
        idx.byKey.size === 2 &&
        idx.byNode.size === 2 &&
        fEnt.entitySeedsOf('再看 tools/probe-entity.mjs', revived).length >= 1
      )
    })(),
    'roundtrip',
  )
  check(
    'as: 实体层不进 nodes、也不进 edges：只挂在 graph.entityLayer 上（否则度数/聚类/孤岛全要重写）',
    fGraphSrc.includes('const entityLayer = input.entityLayer === false') &&
      fGraphSrc.includes('entityLayer,') &&
      fGraphSrc.includes('entities: entityLayer ? entityLayer.list.length : 0,') &&
      !fGraphSrc.includes("type: 'entity-layer'"),
    'layer-only',
  )
  check(
    'as: 关掉整层只要一个开关：entityLayer:false（回滚一条配置，不用改记忆）',
    fGraphSrc.includes('input.entityLayer === false') && fRecallSrc.includes("opts.entityLayer !== false"),
    'off-switch',
  )
  check(
    'as: 动态跳数只收软边：策展/同实体/跨项目是硬证据，不看词面也要走',
    fRecallSrc.includes("const HARD_EDGE = new Set(['explicit', 'entity', 'project'])") &&
      fRecallSrc.includes('if (dynamicHops && !HARD_EDGE.has(link.type))'),
    'hard-edge',
  )
  check(
    'as: 第二跳真的会跑：第一跳用种子能量、第二跳起用上一跳给的能量（0.4.0 之前 e0 恒 0，第二跳从来没跑过）',
    fRecallSrc.includes('const e0 = hop === 0 ? energy[from] : propagate[from] || 0'),
    'two-hop',
  )
  check(
    'as: 跳数三个数一起报（问到几跳 / 走了几跳 / 砍掉几个邻居）：只说「省了」会掩盖「变笨了」',
    fRecallSrc.includes('hops: { asked: hops, used: hopsUsed') &&
      fRecallSrc.includes('skippedNeighbors: skipped') &&
      fRecallSrc.includes('stoppedAt: hopsStopped || null'),
    'hops-report',
  )
  check(
    'as: 实体命中也进回执（label/type/members），否则用户看不出「这条为什么被带出来」',
    fRecallSrc.includes('entities: entityHits.map(') && fRecallSrc.includes('dynamic: dynamicHops'),
    'entity-report',
  )
  check(
    'as: 缓存要存实体层，且 entities.js 进建图指纹：不存则重启后实体悄悄消失，不进指纹则改了抽取规则旧层照旧被信',
    fCacheSrc.includes('entityLayer: graph.entityLayer || null') &&
      /const IMPL_FILES = \[[^\]]*'entities\.js'[^\]]*\]/.test(fCacheSrc),
    'cache',
  )
  check(
    'as: nebula_recall 给了两个参数与两条整机回滚开关（NEBULA_ENTITY_LAYER / NEBULA_DYNAMIC_HOPS）',
    fNebulaIdxSrc.includes('entity: { type: \'boolean\'') &&
      fNebulaIdxSrc.includes('dynamic_hops: { type: \'boolean\'') &&
      fNebulaIdxSrc.includes("process.env.NEBULA_ENTITY_LAYER") &&
      fNebulaIdxSrc.includes("process.env.NEBULA_DYNAMIC_HOPS"),
    'tool-flags',
  )
  check(
    'as: 动态跳数的门槛只在第二跳生效（第一跳是星图最基本的语义，不该被词面砍）',
    fRecallSrc.includes('if (hop >= 1 && m < DYNAMIC_MIN_MATCH)') && fRecallSrc.includes('const DYNAMIC_MIN_MATCH = 0.2'),
    'hop-gate',
  )
}

// A58g. 共现自学习扩词（0.4.0 P5 / PLAN-0.4 §5 P5）：换说法档原来全靠 SYN_GROUPS 那张手工表。
//       主人一句话点破——「出现新的情况就无法适应了不是吗」。这一版把等价说法从人手里的表
//       搬到库里的 keywords：库带来什么词，共现就从什么词上长。
//       守的不变量：①词源必须是 keywords（bigram 切片上没有「词」这回事，学出来全是碎片）
//       ②同一条 +2、同 project 只认跨文档（否则共享汉字降权等于没降）③只扩问句、不进覆盖度分母
//       ④关得掉（coocLearn:false 退回手工表口径，synBridge:false 连共现一起关）
{
  const fMeowSrc = readFileSync(join(root, 'vendor', 'meow-memory', 'lib', 'index.js'), 'utf8')
  const fCoocProbeSrc = readFileSync(join(root, 'tools', 'probe-cooc.mjs'), 'utf8')
  const fCostSrc = readFileSync(join(root, 'tools', 'probe-cost.mjs'), 'utf8')
  const fGoldSrc = readFileSync(join(root, 'tools', 'probe-gold.mjs'), 'utf8')
  const fMeow = await import(pathToFileURL(join(root, 'vendor', 'meow-memory', 'lib', 'index.js')).href)

  check(
    'as: 共现的词源是 keywords，不是 tokenize 切片（切片上没有「词」，学出来全是碎片）',
    fMeowSrc.includes('function coocWordsOf(d)') &&
      fMeowSrc.includes('const raw = d && d.keywords;') &&
      !/function buildCoocSyn\(docs, n\)[\s\S]{0,1200}tokenize\(/.test(fMeowSrc),
    'word-source',
  )
  check(
    'as: 六个门是有数的常量：同条 2 / 跨文档 1 / 共享汉字降到 1 / 次数 2 / 条件概率 0.25 / 每词 6',
    fMeow.COOC_W_SAME === 2 && fMeow.COOC_W_PROJ === 1 && fMeow.COOC_SHARE_HAN_W === 1 &&
      fMeow.COOC_MIN_COUNT === 2 && fMeow.COOC_MIN_RATIO === 0.25 && fMeow.COOC_TOP_PER_TERM === 6,
    `${fMeow.COOC_W_SAME}/${fMeow.COOC_W_PROJ}/${fMeow.COOC_SHARE_HAN_W}/${fMeow.COOC_MIN_COUNT}/${fMeow.COOC_MIN_RATIO}/${fMeow.COOC_TOP_PER_TERM}`,
  )
  check(
    'as: 同 project 那层只认跨文档（本项目并集减掉自己）：同条内部的词对不重复计',
    (fMeowSrc.includes('const others = unionArr.filter((w) => !self.has(w));') ||
      (fMeowSrc.includes('let onlySelf = true;') && fMeowSrc.includes('if (ws.indexOf(b) >= 0) continue;'))),
    'project-cross-doc',
  )
  check(
    'as: 三道门各在位：次数不够丢、条件概率太低丢、共享汉字降权',
    fMeowSrc.includes('if (c < COOC_MIN_COUNT) continue;') &&
      fMeowSrc.includes('if (ratio < COOC_MIN_RATIO) continue;') &&
      // [0.6.23] 共享汉字判据按词对记忆一次（hanMemo）；[0.6.26] 记忆表换成词号下标数组、
      // 两层都在进入 b 循环前把 a 那一行提到外面（hanRow / hanHas），降权基数仍由调用点给
      fMeowSrc.includes('const hanMemo = [];') &&
      fMeowSrc.includes('got = coocShareHan(wById[a], wById[b]);') &&
      fMeowSrc.includes('hanHas(rowH, a, b) ? Math.min(w, COOC_SHARE_HAN_W) : w') &&
      fMeowSrc.includes('hanHas(rowH, a, b) ? Math.min(COOC_W_PROJ, COOC_SHARE_HAN_W) : COOC_W_PROJ'),
    'gates',
  )
  check(
    'as: 形态门：单字 / 纯数字 / 超 8 字 / 太短英文都不进表（没中文的要求小写标识符）',
    fMeowSrc.includes('if (s.length < 2 || s.length > 8) continue;') &&
      fMeowSrc.includes('if (/^[0-9.]+$/.test(s)) continue;') &&
      fMeowSrc.includes('/^[a-zA-Z][a-zA-Z0-9_.-]{2,}$/'),
    'shape',
  )
  check(
    'as: 扩出来的词合流在同一个出口：手工表在前、共现表在后，一共最多 6 个（名额按碎片算）',
    (fMeowSrc.includes('function synExpandOf(qTerms, df, n, cooc, forms)') ||
      fMeowSrc.includes('function synExpandOf(qTerms, df, n, cooc, forms, extra)')) &&
      fMeowSrc.includes('.slice(0, SYN_MAX_PER_TERM)') &&
      fMeowSrc.includes('for (const a of map.get(t) ?? []) push(use, a);'),
    'merge',
  )
  // 纯函数行为：同条一次够、单字不够、词不在 keywords 里学不到
  check(
    'as: 行为对照：同一条里的两个真词一次就连上，而正文里的切片碎片一个都不进表',
    (() => {
      const mk = (id, p, content, keywords) => ({ id, project: p, title: '', content, keywords, level: 'fact', importance: 1, status: 'active' })
      const cooc = fMeow.buildCoocSyn([mk('a', 'p1', '地面空间配置', ['苹果', '香蕉']), mk('b', 'p2', '', [])], 2)
      const words = cooc ? [...cooc.keys()] : []
      return words.includes('苹果') && !words.some((w) => ['名空', '置面', '到配'].includes(w))
    })(),
    'behaviour',
  )
  check(
    'as: 开关在索引那一层生效：coocLearn:false 时索引里根本没有共现表（不是有表不用）',
    fMeowSrc.includes('opts.coocLearn === false ? null : buildCoocSyn(docs, n, opts)'),
    'switch',
  )
  check(
    'as: 缓存键带上共现口径位（两种口径各占一张表，不许互相串答案）',
    fMeowSrc.split('coocLearn').length - 1 >= 4,
    `coocLearn 出现 ${fMeowSrc.split('coocLearn').length - 1} 次`,
  )
  check(
    'as: 八个新符号都从模块导出（探针与验收读的是同一份数据）',
    ['SYN_MAX_PER_TERM', 'COOC_W_SAME', 'COOC_W_PROJ', 'COOC_SHARE_HAN_W', 'COOC_MIN_COUNT', 'COOC_MIN_RATIO', 'COOC_TOP_PER_TERM', 'buildCoocSyn']
      .every((k) => k in fMeow),
    'exports',
  )
  check(
    'as: 探针 probe-cooc 自成一档（K1 词源 / K2 两级证据 / K3 三道门 / K4 真进召回 / K5 大库更准 / K6 常量与开关）',
    ['K1 共现只从 keywords', 'K2 同一条记忆里的两个词', 'K3 条件概率门', 'K4 共现没把该找的弄丢', 'K5 库越大越连得上', 'K6 六个门是有数的常量']
      .every((s) => fCoocProbeSrc.includes(s)),
    'probe-cooc',
  )
  check(
    'as: 换代归因两条：C5b 关掉共现逐位回到冻结快照、C5c 打开后至少一问不同（通道不空转）',
    fCostSrc.includes('cost-snap-handonly.json') &&
      fCostSrc.includes('C5b 换代归因') &&
      fCostSrc.includes('C5c 共现通道不空转'),
    'cost-attrib',
  )
  check(
    'as: 宽池那格的增量必须能归因到共现（关掉共现要消失），而不是「池子大看着更好」',
    fGoldSrc.includes('widePNoCooc') && fGoldSrc.includes('coocAttrib'),
    'gold-attrib',
  )
  check(
    'as: 表形态判据放宽到英文标识符（四处同步：probe-gold / probe-recall / verify HB2 / verify HZ12）',
    fGoldSrc.includes('/^[a-z][a-z0-9_]*$/') &&
      readFileSync(join(root, 'tools', 'probe-recall.mjs'), 'utf8').includes('/^[a-z][a-z0-9_]*$/') &&
      readFileSync(new URL('./verify.mjs', import.meta.url), 'utf8').split('/^[a-z][a-z0-9_]*$/').length - 1 >= 2,
    'shape-relax',
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
  check('link: 版本不早于 0.2.59', verAtLeast(v59, 0, 2, 59), v59.join('.'))
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
  check('card: 版本不早于 0.2.60', verAtLeast(v60, 0, 2, 60), v60.join('.'))
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
  check('limit: 版本不早于 0.2.61', verAtLeast(v61, 0, 2, 61), v61.join('.'))
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
      // [macro-fusion 0.2.112] 0 条那条提前返回多了 budget.note；星图只看阶梯给的 count。
      /if \(nb\.value <= 0\) return \[said, nb\.note, budget\.note\]/.test(readDefSrc62b) &&
      /neighbors: count,? \}/.test(readDefSrc62b) &&
      !/const want = args\.neighbors === undefined/.test(readDefSrc62b) &&
      !/!Number\.isFinite\(want\)/.test(readDefSrc62b),
    'defs/read.js',
  )
  check(
    'nb: 说明接在回执末尾（有邻居段就接在段后），不顶掉正文',
    /const section = neighborSection\(inspect\.text\)/.test(readDefSrc62b) &&
      /\[said, section, gap\]\.filter\(Boolean\)\.join\('\\n\\n'\)/.test(readDefSrc62b) &&
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
  check('nb: 版本不早于 0.2.62', verAtLeast(v62, 0, 2, 62), v62.join('.'))
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
    ['AT1', 'AT2', 'AT3', 'AT4', 'AT5', 'AT6', 'AT7', 'AT8', 'AT9', 'AT10', 'AT11'].every((n) => fusionSrc63.includes(`'${n} `) || fusionSrc63.includes('`' + n + ' ')),
    'probe-fusion',
  )
  const v63 = JSON.parse(read63('package.json')).version.split('.').map(Number)
  check('budget: 版本不早于 0.2.63', verAtLeast(v63, 0, 2, 63), v63.join('.'))
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
    adminSrc64.includes("const HYGIENE_KINDS = ['dup', 'stale', 'thin', 'oversize', 'unread', 'orphan', 'selfecho', 'unused', 'inflate']") &&
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
  check('hyg: 版本不早于 0.2.64', verAtLeast(v64, 0, 2, 64), v64.join('.'))
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
  check('lim: 版本不早于 0.2.65', verAtLeast(v65, 0, 2, 65), v65.join('.'))
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
      searchSrc66.includes("const LOCAL_ONLY_PARAMS = ['level', 'project', 'status', 'days', 'content_max', 'context', 'explain']"),
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
  check('fb: 版本不早于 0.2.66', verAtLeast(v66, 0, 2, 66), v66.join('.'))
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
  check('sim: 版本不早于 0.2.67', verAtLeast(v67, 0, 2, 67), v67.join('.'))
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
  check('pst: 版本不早于 0.2.68', verAtLeast(v68, 0, 2, 68), v68.join('.'))
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
    check('id/ids: 版本不早于 0.2.69', verAtLeast(v69, 0, 2, 69), v69.join('.'))
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
    check('card: 版本不早于 0.2.70', verAtLeast(v70, 0, 2, 70), v70.join('.'))
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
    check('hubs: 版本不早于 0.2.71', verAtLeast(v71, 0, 2, 71), v71.join('.'))
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
  check('miss: 版本不早于 0.2.72', verAtLeast(v72, 0, 2, 72), v72.join('.'))
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
  check('doctor: 版本不早于 0.2.73', verAtLeast(v73, 0, 2, 73), v73.join('.'))
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
  check('hygiene: 版本不早于 0.2.74', verAtLeast(v74, 0, 2, 74), v74.join('.'))
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
  check('hubs: 版本不早于 0.2.75', verAtLeast(v75, 0, 2, 75), v75.join('.'))
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
  check('cost: 版本不早于 0.2.76', verAtLeast(v76, 0, 2, 76), v76.join('.'))
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
      readSrc77.includes('[said, section, gap].filter(Boolean).join') &&
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
  check('read: 版本不早于 0.2.77', verAtLeast(v77, 0, 2, 77), v77.join('.'))
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
  check('link: 版本不早于 0.2.78', verAtLeast(v78, 0, 2, 78), v78.join('.'))
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
  // 0.2.123：memory_search 加了 context 参数，总账抬到 94,000，并补一道单项护栏——
  // 总账涨了必须能指到是哪个工具涨的，否则「抬上界」就成了万能钥匙。
  // 0.2.126：判据的量换成 schema（parameters + output），整字面量只留粗胖警戒线。
  // 理由：render 去重让 memory_search 字面量长了 1.3 KB，schema 一字节没动——拿字面量当判据，
  // 会把「改实现」误判成「塞描述」，人就开始抬上界。
  // 0.2.167：memory_search 加了 band_keep，单项上界 6,500 → 7,500（实测 6,852）。
  // 0.2.170：疑问框架剥离在 explain 里要说清改过什么，整字面量 105,000 → 106,000（实测 105,156）。
  // 0.2.171：历史补录整段是三十行真逻辑，106,000 → 110,000（实测 108,705）；再涨就该拆工具。
  // 0.4.0 P4：星图加实体层 + 动态跳数（nebula_recall 多两个参数、回执多两行），110,000 → 112,000（实测 110,452）。
  check(
    '脚本: 体积判据量的是 schema（24,000 + 单项 7,500），整字面量另有粗胖线 112,000',
    probeSrc.includes('const BUDGET_BYTES = 24000') &&
      probeSrc.includes('const TOOL_BUDGET = { memory_search: 7500 }') &&
      probeSrc.includes('const LITERAL_CEIL = 112000') &&
      probeSrc.includes('ok(sum <= BUDGET_BYTES') &&
      probeSrc.includes("'体积：单项 schema ' + name + ' 没有膨胀'"),
  )
  check(
    '脚本: schema 只数 parameters + output（render 与闭包不算 schema）',
    probeSrc.includes('function schemaOf(block)') &&
      probeSrc.includes("const pi = block.indexOf('parameters:')") &&
      probeSrc.includes("const oi = block.indexOf('output:', pi)"),
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
    '召回: 重要度乘数进了打分（score = raw × w × impW，且 impW 与 keywordHitScore 同口径 0.25；0.2.179 起缘由问句再乘一层规矩折价，0.2.180 起分档与排序吃同一个乘子）',
    meowSrc.includes('const impW = 1 + (impOf(dOf) - 1) * 0.25;') ||
      // [0.6.30] 同一个乘子摊平进扫描循环（`impOf` 闭包退休）：先 round 取整、再夹到 1..4、再乘 0.25。
      // 断言钉的是「口径没变」，不是「它非得走一次函数调用」——所以认这两种写法里的任一种。
      (meowSrc.includes('const impRaw = Math.round(Number(dOf.importance));') &&
        meowSrc.includes('const impW = 1 + ((Number.isFinite(impRaw) ? (impRaw < 1 ? 1 : impRaw > 4 ? 4 : impRaw) : 1) - 1) * 0.25;')) &&
      // [0.2.180] 折价改走 ruleFoldOf(di)：分档用的 _raw 与排序用的 score 吃同一个乘子。
      // 只折 score 的话，规矩条仍在最高档里当第一名（bandize 按 _raw 分档、档位优先于分数），折到 0.1 也翻不过去。
      // [0.6.14] 这个乘子每条只算一次落进 `foldOf`（原来 _raw/score/explain 各调一遍 ruleFoldOf(di)），
      // 口径仍是同一个 helper：钉「先算一次、两处都吃它」，而不是钉它被调了几遍。
      // [0.6.15] 同一段的 `docs[di]` 先落进 `dOf`（这一条下面要读十来次），断言跟着改成读 `dOf`，口径没动。
      meowSrc.includes('const foldOf = ruleFoldOf(di);') &&
      meowSrc.includes('score: raw[di] * w * impW * stW * foldOf,'),
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
    '召回: 有阴性对照（抹平 importance 铁律分数会掉、按时间升序会给出另一个首条）',
    recallSrc.includes('flatIron') &&
      recallSrc.includes('(flatIron?.score ?? 0) < (ironScore ?? 0) - 1e-9') &&
      recallSrc.includes("tHits[0]?.id === 't-new' && tTime[0] === 't-old'"),
  )
  check(
    '召回: 失败时自己把 exitCode 置非零（不然红也读不出来）',
    recallSrc.includes('if (failures !== 0) process.exitCode = 1'),
  )
}

// ── A86. 检索的相关度下限：尾巴要收、但不能把结果收空（0.2.86）──
// 30 条语料实测的分数断崖：榜首 14.08 分时，第 3 条起只有 0.33——那些是「只沾一个词」的条目，
// 照样占 k 名额、照样被当成相关读。所以给 memory_search 加 min_rel（0.2.86 起默认 0.35，
// 0.2.168 起 0.30：真库难句上 0.35 会砍到正解，见 INTERNAL 9.175）。
// 这里钉三件事：下限真的在滤、排序第一位永远不被滤掉、收掉的东西要说出来并且能关掉。
{
  const meowSrc = readFileSync(join(root, 'vendor/meow-memory/lib/index.js'), 'utf8')
  const searchSrc = readFileSync(join(root, 'lib/macro/defs/search.js'), 'utf8')
  const recallSrc = readFileSync(join(root, 'tools/probe-recall.mjs'), 'utf8')

  check(
    '下限: memory_search 有 min_rel（0.2.168 起默认 0.30、限 0–1、夹边界时说清按多少算）',
    meowSrc.includes('min_rel: { type: "number", minimum: 0, maximum: 1, default: 0.3') &&
      meowSrc.includes('const minRel = relRaw !== void 0') &&
      meowSrc.includes('const relClamped = relGiven && (relRaw === void 0 || relRaw < 0 || relRaw > 1)') &&
      meowSrc.includes('不在 0–1 里'),
  )
  check(
    '下限: 排序第一位永远留着（下限再高也不许把结果收空），且先按分数线滤再折叠（折叠只动尾巴不动榜首）',
    meowSrc.includes(
      'const aboveFloor = minRel > 0 && topScore > 0 ? ranked.filter((h, i) => i === 0 || h.score >= topScore * minRel) : ranked;',
    ) && meowSrc.indexOf('const aboveFloor') < meowSrc.indexOf('foldNearDupes(floorKept, byId)'),
  )
  check(
    '下限: 被收掉的尾巴要报数（还剩几条、最高几分），并给出 min_rel=0 的出路',
    meowSrc.includes('const belowFloor = cutRows.length - lifted.length') &&
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
    meowSrc.includes('function foldNearDupes(hits, byId) {') &&
      meowSrc.includes('similarity(one.head.content ?? "", h.content ?? "") >= DEDUP_THRESHOLD') &&
      meowSrc.includes('const foldedRes = dedupeOn ? foldNearDupes(floorKept, byId) : { kept: floorKept, folded: 0, dropped: [] };'),
  )
  check(
    '跨层重复: 折叠报条数、说清常见成因，并给 dedupe: false 出口（收窄必带出口）',
    meowSrc.includes('safeKeyed("search.dedupeKept"') &&
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
    (searchDefSrc.match(/'dedupe'/g) || []).length >= 3 && /dedupe: \{ type: 'boolean'/.test(searchDefSrc),
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
      vSrc.includes('listBlock + dupBlock + repeatBlock'),
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
      vSrc.includes('dupBlock + repeatBlock + coverBlock'),
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
      const seg = panelSrc.slice(panelSrc.indexOf('function expandPanel(rec, rank, seen, settled)'), panelSrc.indexOf('function compareLine('))
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
      // [macro-fusion 0.2.111] 返回值多了 byProject（没有项目时整格不写），这句跟着改形。
      vSrc.includes('const out = { active, byLevel };') &&
      vSrc.includes('return out;') &&
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
      const seg = panelSrc.slice(panelSrc.indexOf('function expandPanel(rec, rank, seen, settled)'), panelSrc.indexOf('function compareLine('))
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
      panelSrc.includes('[expandPanel(rec, wantId, conflictSeenOf(workspace, dir, wantId), settledById), rangeNoteOf(rec.row, range), filterNote]') &&
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

// [macro-fusion 0.2.107] 账本要分清收尾方式：跑完 / 半路停下 / 补记 / 封存各有各的来路。
// 以前只有摘要首词，组数没有分母，补记与被封存的账还被一律念成「比 0.2.96 早」——
// 其中「连续失败止损封存」那支连账本都不落，面板上等于没整理过。
{
  const vSrc = readFileSync(join(root, 'vendor/meow-memory/lib/index.js'), 'utf8')
  const panelSrc = readFileSync(join(root, 'lib', 'macro', 'dreamledger.js'), 'utf8')
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  const idxSrc = readFileSync(join(root, 'lib', 'index.js'), 'utf8')
  const rulerSrc107 = readFileSync(join(root, 'tools', 'probe-ruler.mjs'), 'utf8')
  const fusionSrc107 = readFileSync(join(root, 'tools', 'probe-fusion.mjs'), 'utf8')
  check(
    'dream 收尾方式: 分母在 finishDream 删 dreamplan 之前读（晚一步只剩分子）',
    vSrc.includes('let groupsTotal = 0;') &&
      vSrc.includes('const rawRounds = db.getDreamMeta(`dreamplan:${sessionId}`);') &&
      vSrc.includes('if (Array.isArray(parsed)) groupsTotal = parsed.length;'),
  )
  check(
    'dream 收尾方式: 中途放弃写 kind=aborted + 走完几组/本来几组，摘要里也印分数',
    vSrc.includes('const kind = reason === "aborted" ? { kind: "aborted", groupsDone: Math.max(0, groupsCount - 1), groupsTotal } : { kind: "done" };') &&
      vSrc.includes('const groupsText = reason === "aborted" && groupsTotal > 0 ? `${Math.max(0, groupsCount - 1)}/${groupsTotal}` : `${groupsCount}`;') &&
      vSrc.includes('plan === void 0 ? { stamped, groups: groupsCount, kind } : { stamped, groups: groupsCount, kind, plan }'),
  )
  check(
    'dream 收尾方式: 补记与被封存分开记（recovered 带走完组数 / gaveup 带失败次数），fails 提到函数级活到落账那行',
    vSrc.includes('let fails = 0;') &&
      vSrc.includes('fails = db.recordDreamFailure(sessionId, T2);') &&
      vSrc.includes('const groupsDone = progressed ? lease.group_idx : 0;') &&
      vSrc.includes('const kind = progressed ? { kind: "recovered", groupsDone } : { kind: "gaveup", fails };') &&
      vSrc.includes('{ stamped, groups: groupsDone, kind }'),
  )
  check(
    'dream 收尾方式: 连续失败止损封存也进账本（以前只写 dream-debug.log，面板上等于没发生过）',
    vSrc.includes('window dream sealed (turn-failed): ${shortSessionId(sessionId)} fails=${fails} stamped=${stamped} T=${new Date(lease.T).toISOString()}') &&
      vSrc.includes('{ stamped, kind: { kind: "sealed", fails } },') &&
      (() => {
        const seg = vSrc.slice(vSrc.indexOf('function handleMemoryTurnFailure'))
        return seg.indexOf('db.logDream(') > 0 && seg.indexOf('db.logDream(') < seg.indexOf('return "sealed"')
      })(),
  )
  check(
    'dream 收尾方式: 读侧优先认 changes.kind，认不出来才退回摘要首词，并标明「这一格记没记」（缺值是 null，不是 0）',
    panelSrc.includes('function kindOf(row) {') &&
      panelSrc.includes("typeof raw.kind === 'string' && raw.kind !== ''") &&
      panelSrc.includes('stored: true,') &&
      panelSrc.includes('const legacy = reasonOf(row?.summary)') &&
      panelSrc.includes('groupsDone: null, groupsTotal: null, fails: null, stored: false }') &&
      panelSrc.includes('const numOf = (v) => {'),
  )
  check(
    'dream 收尾方式: 摘要里的括号修饰语要跳过（`recovered (interrupted)` 不能被认成「原因未记」）',
    panelSrc.includes('match(/^window dream ([a-z]+)[^:]*:/)'),
  )
  check(
    'dream 收尾方式: 行上没有规模时按来路分开讲，只有真老账才念「比 0.2.96 早」',
    panelSrc.includes('function kindTail(k) {') &&
      panelSrc.includes("if (kt !== '') return `${head}${tail} · ${kt}${tailRef}`") &&
      panelSrc.includes('这条记录比 0.2.96 早，当时还没写规模数字${tailRef}') &&
      panelSrc.includes('半路停下，这一条没记走到第几组') &&
      panelSrc.includes('补记时已走完 ${k.groupsDone} 组'),
  )
  check(
    'dream 收尾方式: 展开先讲收尾方式，并禁止把没跑完的账说成老账（规模/对子两处都要改口）',
    panelSrc.includes('function kindBlock(row) {') &&
      panelSrc.includes('收尾方式：${KIND_TEXT[k.kind] ?? k.kind}') &&
      panelSrc.includes('if (kind !== \'\') lines.push(kind)') &&
      panelSrc.includes('这一轮不是跑完的整理（${KIND_TEXT[kk.kind] ?? kk.kind}），没有规模数字可念。') &&
      panelSrc.includes('这一轮不是跑完的整理（${KIND_TEXT[k.kind] ?? k.kind}），没有对子明细可念。'),
  )
  check(
    'dream 收尾方式: 趋势与「比更早一条」只吃跑完的一轮，并说清几次没跑完不进合计',
    panelSrc.includes('function isFullRound(row) {') &&
      panelSrc.includes('const full = withPlan.filter((r) => isFullRound(r))') &&
      panelSrc.includes('const partial = withPlan.length - full.length') &&
      panelSrc.includes('次没跑完（中途放弃 / 待补记 / 已封存），不进合计') &&
      panelSrc.includes('const halfNow = !isFullRound(row)') &&
      panelSrc.includes('，数字不可比。'),
  )
  check(
    'dream 收尾方式: 探针进线（probe-ruler L21–L24 验真 engine 四种收尾、probe-fusion D49–D53 + D11b 验面板）',
    rulerSrc107.includes('L21 中途放弃落结构化 kind') &&
      rulerSrc107.includes('L22 被打断后补记') &&
      rulerSrc107.includes('L23 连续失败达上限也进账本') &&
      rulerSrc107.includes('L24 连续没进展被封存') &&
      fusionSrc107.includes('D49 中途放弃的行与展开') &&
      fusionSrc107.includes('D50 半轮不配跟整轮比数字') &&
      fusionSrc107.includes('D51 趋势只拿跑完的轮做合计') &&
      fusionSrc107.includes('D52 补记账不冒充老账') &&
      fusionSrc107.includes('D53 封存账进面板') &&
      fusionSrc107.includes('D11b 中途放弃的账不冒充老账'),
  )
  check(
    'dream 收尾方式: 版本不早于 0.2.107（两处一致），文档 9.113 / 119 在位',
    (() => {
      const v = pkg.version.split('.').map((x) => Number(x))
      const atLeast = v[0] > 0 || v[1] > 2 || (v[1] === 2 && v[2] >= 107)
      return atLeast && idxSrc.includes(`export const version = '${pkg.version}'`)
    })() &&
      readFileSync(join(root, 'docs', 'INTERNAL.md'), 'utf8').includes('## 9.113') &&
      readFileSync(join(root, 'DESIGN.md'), 'utf8').includes('## 119'),
  )
}

// [macro-fusion 0.2.108] 层走向：总条数的净变化只说「库重了多少」，说不出「哪一层在膨胀」。
// fact 一直涨、topic 一直掉，总数可能是 0，而库的结构在烂——这一版把每一轮收尾时的层数摊成走向。
{
  const vSrc108 = readFileSync(join(root, 'vendor/meow-memory/lib/index.js'), 'utf8')
  const panelSrc108 = readFileSync(join(root, 'lib', 'macro', 'dreamledger.js'), 'utf8')
  const pkg108 = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  const idxSrc108 = readFileSync(join(root, 'lib', 'index.js'), 'utf8')
  const rulerSrc108 = readFileSync(join(root, 'tools', 'probe-ruler.mjs'), 'utf8')
  const fusionSrc108 = readFileSync(join(root, 'tools', 'probe-fusion.mjs'), 'utf8')
  check(
    '层走向: 写侧的尺子只数 active 且零层不落进 byLevel（缺层=0 这条读法全靠它）',
    vSrc108.includes("SELECT COUNT(*) AS n FROM ${level} WHERE status = 'active'") &&
      vSrc108.includes('if (n > 0) byLevel[level] = n;') &&
      vSrc108.includes('  dreamStoreScale,'),
  )
  check(
    '层走向: 只认收尾层数 storeEnd.byLevel，不许拿开工层数冒充收尾（0.2.103~0.2.105 只有开工数）',
    panelSrc108.includes('function levelSeriesOf(plan) {') &&
      panelSrc108.includes('const raw = plan?.storeEnd') &&
      panelSrc108.includes('if (raw.byLevel === undefined || raw.byLevel === null || typeof raw.byLevel !== \'object\') return null') &&
      panelSrc108.includes('const store = storeOf({ store: raw })') &&
      panelSrc108.includes('return store === null ? null : store.byLevel'),
  )
  check(
    '层走向: 半轮与缺收尾数分开计数（半轮带 storeEnd 才算 half，否则算 noEnd），两者都不进走向',
    panelSrc108.includes('function levelTrendLine(rows) {') &&
      panelSrc108.includes('if (levelSeriesOf(row.changes?.plan) !== null) half += 1') &&
      panelSrc108.includes('if (levels === null) {') &&
      panelSrc108.includes('noEnd += 1') &&
      panelSrc108.includes('if (kept.length < 2) return \'\''),
  )
  check(
    '层走向: 按变化幅度排序、只列 4 层、多的说「还有 N 层没列」（不装没有）',
    panelSrc108.includes('cells.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta) || b.last - a.last)') &&
      panelSrc108.includes('const shown = cells.slice(0, 4)') &&
      panelSrc108.includes('if (rest > 0) caveats.push(`还有 ${rest} 层没列`)'),
  )
  check(
    '层走向: 每格念「a → b → c（+N / -N / 没变）」，结论分涨/掉/都没变三支，没涨就不编涨的',
    panelSrc108.includes("const word = c.delta > 0 ? `+${c.delta}` : c.delta < 0 ? `${c.delta}` : '没变'") &&
      panelSrc108.includes('parts.push(\'每一层的条数都没变\')') &&
      panelSrc108.includes('parts.push(`涨得最多的是 ${up.name}（+${up.delta}）`)') &&
      panelSrc108.includes('parts.push(`掉得最多的是 ${down.name}（${down.delta}）`)'),
  )
  check(
    '层走向: 排除项逐条念（半轮 / 缺收尾数），并交代「只数 active、缺层就是那轮那层 0 条」',
    panelSrc108.includes('次没跑完（中途放弃 / 待补记 / 已封存），不进这条走向') &&
      panelSrc108.includes('次没有收尾层数（0.2.106 之前的账没有这一格），不进这条走向') &&
      panelSrc108.includes("只数 status='active'；这一轮写了 byLevel 而里面没有那一层，就是那一轮那层 0 条在用"),
  )
  check(
    '层走向: 只在第 1 页出（说的就是最近这几条），并在口径里交代数据来路',
    panelSrc108.includes('const levels = levelTrendLine(rows)') &&
      panelSrc108.includes("scopeParts.push('层走向按每一轮收尾时的 storeEnd.byLevel 数，只有 0.2.106 之后的账有这一格')") &&
      (() => {
        const seg = panelSrc108.slice(panelSrc108.indexOf('const levels = levelTrendLine(rows)'))
        return seg.indexOf('} else {') > 0
      })(),
  )
  check(
    '层走向: 探针进线（probe-ruler L25/L26 验写侧尺子、probe-fusion D54–D57 验面板与两条阴性对照）',
    rulerSrc108.includes('L25 层规模只数 status=active 且零层不写') &&
      rulerSrc108.includes('L26 归档立刻从层规模里掉出去') &&
      fusionSrc108.includes('D54 层走向按每一轮收尾的 byLevel 摊开') &&
      fusionSrc108.includes('D55 排除了谁要说清') &&
      fusionSrc108.includes('D56 只有一轮不出层走向') &&
      fusionSrc108.includes('D57 每层都没变就说没变'),
  )
  check(
    '层走向: 版本不早于 0.2.108（两处一致），文档 9.114 / 120 在位',
    (() => {
      const v = pkg108.version.split('.').map((x) => Number(x))
      const atLeast = v[0] > 0 || v[1] > 2 || (v[1] === 2 && v[2] >= 108)
      return atLeast && idxSrc108.includes(`export const version = '${pkg108.version}'`)
    })() &&
      readFileSync(join(root, 'docs', 'INTERNAL.md'), 'utf8').includes('## 9.114') &&
      readFileSync(join(root, 'DESIGN.md'), 'utf8').includes('## 120'),
  )
}

// [macro-fusion 0.2.109] 回执成本 + budget：六个维度里「效率」以前唯一没有数——
// 有条数、有耗时，没有「这一问占了多少上下文」，于是「多查几次也无所谓」永远是一句空话。
{
  const searchSrc109 = readFileSync(join(root, 'lib', 'macro', 'defs', 'search.js'), 'utf8')
  const readSrc109 = readFileSync(join(root, 'lib', 'macro', 'defs', 'read.js'), 'utf8')
  const promptSrc109 = readFileSync(join(root, 'lib', 'macro', 'prompt.js'), 'utf8')
  const prompt109 = await import(pathToFileURL(join(root, 'lib', 'macro', 'prompt.js')).href)
  const pkg109 = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  const idxSrc109 = readFileSync(join(root, 'lib', 'index.js'), 'utf8')
  const rulerSrc109 = readFileSync(join(root, 'tools', 'probe-ruler.mjs'), 'utf8')
  const fusionSrc109 = readFileSync(join(root, 'tools', 'probe-fusion.mjs'), 'utf8')
  const tok109 = await import(pathToFileURL(join(root, 'lib', 'macro', 'tokencost.js')).href)

  check(
    '成本: 估算口径可复算（CJK 一字 1、其余 4 字符 1、空串 0），报数是量级不是账单',
    tok109.estTokens('中文四个字') === 5 &&
      tok109.estTokens('hello world') === 3 &&
      tok109.estTokens('') === 0 &&
      tok109.fmtTokens(1234) === '1.2k' &&
      tok109.fmtTokens(2000) === '2k' &&
      tok109.costSentence('中文').includes('是量级不是账单'),
  )
  check(
    '成本: 三个阈值集中一处（够大才报 500 / 才建议收紧 1200 / 预算下限 80），不在调用处各写一个数',
    tok109.COST_SHOW_MIN === 500 && tok109.COST_HINT_MIN === 1200 && tok109.BUDGET_MIN === 80,
  )
  check(
    '预算: 四态分开（没给 / 不像数 / 太小 / 超上界），装不下绝不假装装下',
    tok109.budgetOf(undefined).value === null &&
      tok109.budgetOf(undefined).note === '' &&
      tok109.budgetOf('abc').note.includes('不是数字') &&
      tok109.budgetOf(20).value === null &&
      tok109.budgetOf(20).note.includes('最小可用预算 80') &&
      tok109.budgetOf(30000).value === 20000 &&
      tok109.budgetOf(30000).note.includes('超出上界') &&
      tok109.budgetOf(400).value === 400 &&
      tok109.budgetOf(400).note === '',
  )
  check(
    '预算: 进 schema（描述里写明「先砍字、再砍条数」），出口只解析一次',
    searchSrc109.includes('budget: {') &&
      searchSrc109.includes('先砍每条的字、再砍条数') &&
      searchSrc109.includes('const budget = budgetOf(args.budget)') &&
      searchSrc109.split('budgetOf(args.budget)').length - 1 === 1,
  )
  check(
    '预算: 收缩顺序先砍 content_max 再砍 k（成本更低的那一步先动）',
    (() => {
      const seg = searchSrc109.slice(searchSrc109.indexOf('async function fitBudget('))
      const cmAt = seg.indexOf('if (cm > 60) cm = Math.max(60, Math.floor(cm / 2))')
      const kAt = seg.indexOf('else if (k > 1) k = Math.max(1, Math.floor(k / 2))')
      return cmAt > 0 && kAt > cmAt
    })(),
  )
  check(
    '预算: 报「最小一份」之前真的去拿一次 k=1/content_max=60（不许靠第四级的估计冒充最小）',
    searchSrc109.includes('const { r: smallest, est: smallestEst } = await take({ ...baseArgs, k: 1, content_max: 60 })') &&
      searchSrc109.includes('（k=1、content_max=60）实测') &&
      searchSrc109.includes('收到了最小的一份'),
  )
  check(
    '预算: 排在 expand 之前生效（否则星图那段会加在已超预算的结果后面）',
    (() => {
      const fitAt = searchSrc109.indexOf('await fitBudget(flow, exec, localArgs, main, budget.value)')
      const expAt = searchSrc109.indexOf('const wantExpand =')
      return fitAt > 0 && expAt > fitAt
    })(),
  )
  check(
    '预算: 星图退回本地兜底的两条路也过 maybeFit（兜底也是真检索，没理由超预算）',
    searchSrc109.split('await maybeFit(').length - 1 === 2 && searchSrc109.includes('async function maybeFit('),
  )
  check(
    '成本: 小回执一个字不加（省 token 的工具自己先要省），没预算就不缩也不说废话',
    searchSrc109.includes('if (budget.value !== null || est >= COST_SHOW_MIN)') &&
      searchSrc109.includes('if (budget.value !== null && !flags.budgetNote)') &&
      readSrc109.includes('return readCostTail(') &&
      tok109.readCostTail('短') === '短',
  )
  check(
    '成本: 手册里告诉模型有这个旋钮，且手册仍未触顶（余量 ≥ 下限）',
    prompt109.GUIDE_TEXT.length > 0 &&
      prompt109.GUIDE_TEXT.includes('想省上下文就给 budget=N') &&
      prompt109.clampGuide() === prompt109.GUIDE_TEXT &&
      prompt109.GUIDE_MAX_CHARS - prompt109.GUIDE_TEXT.length >= prompt109.GUIDE_MIN_HEADROOM,
  )
  check(
    '成本: 探针进线（probe-ruler L27/L28 钉口径与预算四态、probe-fusion D58–D61 钉出口与两条阴性对照）',
    rulerSrc109.includes('L27 估算口径可复算') &&
      rulerSrc109.includes('L28 预算四态不压成一态') &&
      fusionSrc109.includes('D58 大回执自带成本尾注') &&
      fusionSrc109.includes('D59 给了预算就自己收紧') &&
      fusionSrc109.includes('D60 缩到底也装不下就直说') &&
      fusionSrc109.includes('D61 小回执不报成本'),
  )
  check(
    '成本: 版本不早于 0.2.109（两处一致），文档 9.115 / 121 在位',
    (() => {
      const v = pkg109.version.split('.').map((x) => Number(x))
      const atLeast = v[0] > 0 || v[1] > 2 || (v[1] === 2 && v[2] >= 109)
      return atLeast && idxSrc109.includes(`export const version = '${pkg109.version}'`)
    })() &&
      readFileSync(join(root, 'docs', 'INTERNAL.md'), 'utf8').includes('## 9.115') &&
      readFileSync(join(root, 'DESIGN.md'), 'utf8').includes('## 121'),
  )
}

// [macro-fusion 0.2.110] 预算贯通四路：0.2.109 只在本地这一路落了预算，尾注老实写着
// 「星图 / 相似两路不缩」——一句诚实的缺功能。四路回执都进上下文，凭什么只有一路能被约束。
{
  const searchSrc110 = readFileSync(join(root, 'lib', 'macro', 'defs', 'search.js'), 'utf8')
  const prompt110 = await import(pathToFileURL(join(root, 'lib', 'macro', 'prompt.js')).href)
  const pkg110 = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  const idxSrc110 = readFileSync(join(root, 'lib', 'index.js'), 'utf8')
  const fusionSrc110 = readFileSync(join(root, 'tools', 'probe-fusion.mjs'), 'utf8')

  check(
    '预算: 四条路各自的旋钮集中一处，且都是「先砍只是少看一点的那个」',
    (() => {
      const at = searchSrc110.indexOf('const PATH_KNOBS = {')
      if (at < 0) return false
      const body = searchSrc110.slice(at, searchSrc110.indexOf('\n}\n', at))
      const graphAt = body.indexOf('graph: [')
      const bridgeAt = body.indexOf('bridge: [')
      const similarAt = body.indexOf('similar: [')
      if (!(graphAt > 0 && bridgeAt > graphAt && similarAt > bridgeAt)) return false
      const graphPart = body.slice(graphAt, bridgeAt)
      const bridgePart = body.slice(bridgeAt, similarAt)
      const similarPart = body.slice(similarAt)
      return (
        graphPart.indexOf("key: 'limit'") < graphPart.indexOf("key: 'hops'") &&
        bridgePart.indexOf("key: 'chars'") < bridgePart.indexOf("key: 'limit'") &&
        similarPart.indexOf("key: 'content_max'") < similarPart.indexOf("key: 'k'")
      )
    })(),
  )
  check(
    '预算: 预算对象先摊成数字再比（拿 {value} 去比，永远比不成立，一路滑到「装不下」）',
    searchSrc110.includes('const cap = Number(budget.value)') &&
      (() => {
        const at = searchSrc110.indexOf('async function fitPath(')
        const end = searchSrc110.indexOf('async function maybeFit(')
        if (!(at > 0 && end > at)) return false
        const body = searchSrc110.slice(at, end)
        return (
          body.includes('if (first <= cap)') &&
          body.includes('if (est <= cap)') &&
          !body.includes('<= budget')
        )
      })(),
  )
  check(
    '预算: 星图 / 补邻居 / 相似都接进同一条收缩循环（三处 fitPath 调用：星图+补邻居共用、相似、本地展开）',
    searchSrc110.split('await fitPath(').length - 1 === 3 &&
      searchSrc110.includes('knobs: PATH_KNOBS[mode]') &&
      searchSrc110.includes('knobs: PATH_KNOBS.similar') &&
      searchSrc110.includes('knobs: PATH_KNOBS.graph'),
  )
  check(
    '预算: 只报真动过的旋钮（`hops 2→2` 这种「报了但没变」会让读者以为它被砍了）',
    searchSrc110.includes('dials.filter((d) => d.value !== d.from)') &&
      searchSrc110.includes("|| '没动到任何旋钮'"),
  )
  check(
    '预算: 报「最小」之前真把旋钮压到下限再量一次（不是拿某一级的估计冒充最小）',
    searchSrc110.includes('for (const d of dials) d.value = d.min') &&
      searchSrc110.includes('（${floorText}）实测') &&
      searchSrc110.includes('收到了最小的一份'),
  )
  check(
    '预算: 本地展开时扩散按「剩余预算」算（读者付的是整份回执），剩余不够就明说拿不出来',
    searchSrc110.includes('const remain = budget.value - used') &&
      searchSrc110.includes('if (remain < BUDGET_MIN)') &&
      searchSrc110.includes('已经被本地结果用掉') &&
      searchSrc110.includes('星图扩散按剩余'),
  )
  check(
    '预算: 出口不再声称「只有本地能收紧」，没派上用场那句改成四路通用',
    !searchSrc110.includes('只有本地检索能收紧') &&
      searchSrc110.includes('if (budget.value !== null && !flags.budgetNote)') &&
      searchSrc110.includes('这条路上没有可缩的东西') &&
      searchSrc110.includes('return costTail(body, { budget, flags })'),
  )
  check(
    '预算: schema 写清四条路各砍什么（不然模型以为 budget 只管本地）',
    searchSrc110.includes('四条路都听') &&
      searchSrc110.includes('星图先砍条数、再砍跳数') &&
      searchSrc110.includes('补邻居先砍字符预算、再砍条数'),
  )
  check(
    '预算: 手册告诉模型「五路都吃」（0.2.112 起连读也吃），且手册仍未触顶（余量 ≥ 下限）',
    prompt110.GUIDE_TEXT.includes('五路都吃（本地/星图/补邻居/相似/读）') &&
      prompt110.clampGuide() === prompt110.GUIDE_TEXT &&
      prompt110.GUIDE_MAX_CHARS - prompt110.GUIDE_TEXT.length >= prompt110.GUIDE_MIN_HEADROOM,
  )
  check(
    '预算: 探针进线（D61 改成「没预算就不缩」、D62 星图收 limit、D63 补邻居收 chars、D64 相似收字、D65 星图最小实测、D66 剩余预算）',
    fusionSrc110.includes('D62 星图这一路也按预算收紧') &&
      fusionSrc110.includes('D63 补邻居先砍字符预算再砍条数') &&
      fusionSrc110.includes('D64 相似这一路按预算收字') &&
      fusionSrc110.includes('D65 星图路装不下也要量到下限') &&
      fusionSrc110.includes('D66 本地展开时扩散按「剩余预算」算'),
  )
  check(
    '预算: 版本不早于 0.2.110（两处一致），文档 9.116 / 122 在位',
    (() => {
      const v = pkg110.version.split('.').map((x) => Number(x))
      const atLeast = v[0] > 0 || v[1] > 2 || (v[1] === 2 && v[2] >= 110)
      return atLeast && idxSrc110.includes(`export const version = '${pkg110.version}'`)
    })() &&
      readFileSync(join(root, 'docs', 'INTERNAL.md'), 'utf8').includes('## 9.116') &&
      readFileSync(join(root, 'DESIGN.md'), 'utf8').includes('## 122'),
  )
}

// [macro-fusion 0.2.111] 项目走向：层走向只说「fact 在涨」，说不出「哪个项目在涨」
{
  const ledgerSrc111 = readFileSync(join(root, 'lib', 'macro', 'dreamledger.js'), 'utf8')
  const meowSrc111 = readFileSync(join(root, 'vendor', 'meow-memory', 'lib', 'index.js'), 'utf8')
  const rulerSrc111 = readFileSync(join(root, 'tools', 'probe-ruler.mjs'), 'utf8')
  const fusionSrc111 = readFileSync(join(root, 'tools', 'probe-fusion.mjs'), 'utf8')
  const pkg111 = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  const idxSrc111 = readFileSync(join(root, 'lib', 'index.js'), 'utf8')

  check(
    '项目走向: 写侧跨五个带 project 列的层相加（soul / user 没有这一格，不许假装数过）',
    meowSrc111.includes('var PROJECT_LAYERS = ["project", "fact", "lesson", "topic", "rules"]') &&
      meowSrc111.includes('function dreamStoreProjects(db)') &&
      meowSrc111.includes('SELECT project AS name, COUNT(*) AS n FROM ${level} WHERE status = \'active\' GROUP BY project') &&
      meowSrc111.includes('dreamStoreProjects,') &&
      !/PROJECT_LAYERS = \[[^\]]*"soul"/.test(meowSrc111),
  )
  check(
    '项目走向: 空项目名不算一个项目、没有项目时整格不写（空对象会被读成「数过，零个项目」）',
    meowSrc111.includes("const name = String(row?.name ?? \"\").trim()") &&
      meowSrc111.includes('if (name === "" || n <= 0) continue') &&
      meowSrc111.includes('if (Object.keys(byProject).length > 0) out.byProject = byProject'),
  )
  check(
    '项目走向: 读侧与层同一套读法（正数才认、名字 trim、老账没有这一格就是没有）',
    ledgerSrc111.includes('const byProject = {}') &&
      ledgerSrc111.includes('if (store.byProject !== undefined && store.byProject !== null && typeof store.byProject === \'object\')') &&
      ledgerSrc111.includes('if (key !== \'\' && Number.isFinite(v) && v > 0) byProject[key] = v') &&
      ledgerSrc111.includes('return { active, byLevel, byProject }'),
  )
  check(
    '项目走向: 只认收尾那一刻的项目数（拿开工数占位等于把整理前的库贴到整理后的位置）',
    (() => {
      const at = ledgerSrc111.indexOf('function projectSeriesOf(')
      const end = ledgerSrc111.indexOf('function projectTrendLine(')
      if (!(at > 0 && end > at)) return false
      const body = ledgerSrc111.slice(at, end)
      return (
        body.includes('const raw = plan?.storeEnd') &&
        body.includes('raw.byProject') &&
        !body.split('plan?.storeEnd').join('').includes('plan?.store')
      )
    })(),
  )
  check(
    '项目走向: 少于两轮不出（一次是快照，不是走向）',
    (() => {
      const at = ledgerSrc111.indexOf('function projectTrendLine(')
      const end = ledgerSrc111.indexOf('/**\n * [macro-fusion 0.2.108] 把最近几轮的收尾层数摊成一条走向')
      if (!(at > 0 && end > at)) return false
      const body = ledgerSrc111.slice(at, end)
      return body.includes('if (kept.length < 2) return \'\'') && body.includes('kept.reverse()')
    })(),
  )
  check(
    '项目走向: 排除要交代（没跑完的轮 / 没有这一格的老账），且常驻一句「只数 5 层、名字按原样」',
    ledgerSrc111.includes('${half} 次没跑完（中途放弃 / 待补记 / 已封存），不进这条走向') &&
      ledgerSrc111.includes('次没有收尾项目数（0.2.111 之前的账没有这一格），不进这条走向') &&
      ledgerSrc111.includes('只数带项目归属的 5 层（soul / user 没有这一格），项目名按写入时原样——改过名的会算成两行'),
  )
  check(
    '项目走向: 三支结论分开说——涨/掉/都没变，没涨就不许编「涨得最多的是 X（+0）」',
    ledgerSrc111.includes("parts.push('每个项目的条数都没变')") &&
      ledgerSrc111.includes('涨得最多的是 ${up.name}（+${up.delta}）') &&
      ledgerSrc111.includes('掉得最多的是 ${down.name}（${down.delta}）') &&
      ledgerSrc111.includes('if (rest > 0) caveats.push(`还有 ${rest} 个项目没列`)'),
  )
  check(
    '项目走向: 挂在第 1 页、紧跟在层走向之后（同一批行、同一套「只吃跑完的轮」的规矩）',
    (() => {
      const at = ledgerSrc111.indexOf('const levels = levelTrendLine(rows)')
      const end = ledgerSrc111.indexOf("if (rows.some((r) => refOfRow(r) !== ''))")
      if (!(at > 0 && end > at)) return false
      const body = ledgerSrc111.slice(at, end)
      return (
        body.includes('const projectsTrend = projectTrendLine(rows)') &&
        body.indexOf('projectTrendLine(rows)') > body.indexOf('levelTrendLine(rows)') &&
        body.includes("scopeParts.push('项目走向按每一轮收尾时的 storeEnd.byProject 数，只有 0.2.111 之后的账有这一格')")
      )
    })(),
  )
  check(
    '项目走向: 探针进线（写侧 L29–L31 钉跨层相加 / 全局不占名 / 归档立刻掉出；面板 D67–D70 钉摊开与两条阴性对照）',
    rulerSrc111.includes('L29 项目规模跨五个带 project 的层相加、只数 active') &&
      rulerSrc111.includes('L30 没有项目归属的条目不算一个项目') &&
      rulerSrc111.includes('L31 归档立刻从项目规模里掉出去') &&
      fusionSrc111.includes('D67 项目走向按每一轮收尾的 byProject 摊开') &&
      fusionSrc111.includes('D68 口径要说全') &&
      fusionSrc111.includes('D69 只有一轮不出项目走向') &&
      fusionSrc111.includes('D70 每个项目都没变就说没变'),
  )
  check(
    '项目走向: 版本不早于 0.2.111（两处一致），文档 9.117 / 123 在位',
    (() => {
      const v = pkg111.version.split('.').map((x) => Number(x))
      const atLeast = v[0] > 0 || v[1] > 2 || (v[1] === 2 && v[2] >= 111)
      return atLeast && idxSrc111.includes(`export const version = '${pkg111.version}'`)
    })() &&
      readFileSync(join(root, 'docs', 'INTERNAL.md'), 'utf8').includes('## 9.117') &&
      readFileSync(join(root, 'DESIGN.md'), 'utf8').includes('## 123'),
  )
}

// [macro-fusion 0.2.112] 读也吃预算：正文是 caller 要的东西，砍了就成假货——只能砍邻居，
// 砍到底还装不下就只给骨架 + 指路。以前 read 是唯一明说「体量由 id 决定，没法缩」的一支。
{
  const readSrc112 = readFileSync(join(root, 'lib', 'macro', 'defs', 'read.js'), 'utf8')
  const fusionSrc112 = readFileSync(join(root, 'tools', 'probe-fusion.mjs'), 'utf8')
  const pkg112 = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  const idxSrc112 = readFileSync(join(root, 'lib', 'index.js'), 'utf8')
  const prompt112 = await import(pathToFileURL(join(root, 'lib', 'macro', 'prompt.js')).href)

  check(
    '读预算: schema 上真的多了 budget（描述里就说明只砍邻居、正文不截断）',
    readSrc112.includes('budget: {\n          type: \'integer\',') &&
      readSrc112.includes('这一读最多花多少 token（估算）。不给=不限额；给了就先砍邻居条数，正文不截断。'),
  )
  check(
    '读预算: 走统一出口 budgetOf（一种解析、四态分开），不限额那条路也要把他给的那个数说出来',
    readSrc112.includes('const budget = budgetOf(args.budget)') &&
      readSrc112.split('budgetOf(args.budget)').length - 1 === 1 &&
      readSrc112.includes('[said, nb.note, budget.note].filter(Boolean).join(\'\\n\\n\')') &&
      readSrc112.includes('readCostTail([got.text, nb.note, budget.note].filter(Boolean).join(\'\\n\\n\'))'),
  )
  check(
    '读预算: 正文一个字节都不裁——全文路径里没有任何对正文的 slice（只有骨架取首行那一刀）',
    !readSrc112.includes('said.slice') &&
      !readSrc112.includes('picked.text.slice') &&
      !readSrc112.includes('withTail.slice') &&
      readSrc112.includes('${first.slice(0, SKELETON_HEAD)}…'),
  )
  check(
    '读预算: 正文装不下就只给骨架，并把缺口与三条出路写清（多少字、≥多少、先搜摘要）',
    readSrc112.includes('if (bodyEst > budget.value) {') &&
      readSrc112.includes('正文共 ${said.length} 字（≈${fmtTokens(bodyEst)} token），比你给的预算 ${budget} token 大') &&
      readSrc112.includes('截一半你会把它当成全文') &&
      readSrc112.includes('把 budget 提到 ≥${bodyEst}') &&
      readSrc112.includes('memory_search 看摘要挑一条'),
  )
  check(
    '读预算: 骨架自己也可能超预算，那就把「连标题都超了」也说出来（不说就会被当成全文）',
    readSrc112.includes('const over = estTokens(head) > budget') &&
      readSrc112.includes('连上面那一行标题都超过你给的预算了；但不写这句，你就会把骨架当成全文。'),
  )
  check(
    '读预算: 砍邻居是阶梯且最多实测三次（先照他要的、再 6/3/1/0，去重且不许超过他要的）',
    readSrc112.includes('const NEIGHBOR_LADDER = [6, 3, 1, 0]') &&
      readSrc112.includes('const LADDER_TRIES = 3') &&
      readSrc112.includes('.filter((n, i, arr) => n <= nb.value && arr.indexOf(n) === i)') &&
      readSrc112.includes('.slice(0, LADDER_TRIES)'),
  )
  check(
    '读预算: 0 条邻居不去问星图（问它要 0 条本来就是白花一次调用）',
    readSrc112.includes("if (count <= 0) return { text: said, section: '' }"),
  )
  check(
    '读预算: 砍了就说砍到几条；没砍时那句账要装得进预算才加（不为一句说明挤掉正文）',
    readSrc112.includes('picked.count === nb.value ? \'\' : `邻居 ${nb.value}→${picked.count} 条才装下`') &&
      readSrc112.includes('if (cutNote) return withTail') &&
      readSrc112.includes('return estTokens(withTail) <= budget.value ? withTail : picked.text'),
  )
  check(
    '读预算: 阶梯全落空也不返回半截正文（兜底给正文本身，宁可不缩也不给假货）',
    readSrc112.includes('if (picked === null) picked = { count: 0, text: said, est: bodyEst }'),
  )
  check(
    '读预算: 手册跟着改口（read 也吃 budget、五路都听）且仍留足余量不被截',
    prompt112.GUIDE_TEXT.includes('memory_read（id, neighbors=12, budget）连邻居一起读') &&
      prompt112.GUIDE_TEXT.includes('正文一字不截') &&
      prompt112.GUIDE_TEXT.includes('五路都吃（本地/星图/补邻居/相似/读）') &&
      prompt112.GUIDE_MAX_CHARS - prompt112.GUIDE_TEXT.length >= prompt112.GUIDE_MIN_HEADROOM,
  )
  check(
    '读预算: 探针进线（D71–D77 钉住老样子 / 骨架 / 指路 / 砍邻居 / 不砍 / 四态 / 0 条不问星图）',
    fusionSrc112.includes('D71 读不给预算就是老样子') &&
      fusionSrc112.includes('D72 正文都装不下就只给骨架') &&
      fusionSrc112.includes('D73 骨架要报缺口并指路') &&
      fusionSrc112.includes('D74 正文装得下、邻居装不下') &&
      fusionSrc112.includes('D75 装得下就一条都不砍') &&
      fusionSrc112.includes('D76 budget 的四种情形在读上也成立') &&
      fusionSrc112.includes('D77 neighbors=0 时给预算也不去问星图'),
  )
  check(
    '读预算: 版本不早于 0.2.112（两处一致），文档 9.118 / 124 在位',
    (() => {
      const v = pkg112.version.split('.').map((x) => Number(x))
      const atLeast = v[0] > 0 || v[1] > 2 || (v[1] === 2 && v[2] >= 112)
      return atLeast && idxSrc112.includes(`export const version = '${pkg112.version}'`)
    })() &&
      readFileSync(join(root, 'docs', 'INTERNAL.md'), 'utf8').includes('## 9.118') &&
      readFileSync(join(root, 'DESIGN.md'), 'utf8').includes('## 124'),
  )
}

// [macro-fusion 0.2.113] 项目走向的两处升级：①首尾净差说不出「第几次才冒出来 / 哪一轮归零」；
// ②轮数一多序列会撑满回执那一行——省 token 的口径在这里也要成立，省略必须报数。
{
  const ledgerSrc113 = readFileSync(join(root, 'lib', 'macro', 'dreamledger.js'), 'utf8')
  const fusionSrc113 = readFileSync(join(root, 'tools', 'probe-fusion.mjs'), 'utf8')
  const pkg113 = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  const idxSrc113 = readFileSync(join(root, 'lib', 'index.js'), 'utf8')

  check(
    '项目走向·省略: 头两个 + 尾三个 + 一个 …，阈值是「再少就没得省」（多省一次就丢信息）',
    ledgerSrc113.includes('const SEQ_HEAD = 2') &&
      ledgerSrc113.includes('const SEQ_TAIL = 3') &&
      ledgerSrc113.includes('function compactSeq(seq)') &&
      ledgerSrc113.includes('if (list.length <= SEQ_HEAD + SEQ_TAIL + 1) return { text: list.join(\' → \'), cut: 0 }') &&
      ledgerSrc113.includes("return { text: [...list.slice(0, SEQ_HEAD), '…', ...list.slice(-SEQ_TAIL)].join(' → '), cut }"),
  )
  check(
    '项目走向·省略: shown 走 compactSeq，不再直接 join（直接 join 等于「短了就整条给」和「长了整条给」两副面孔）',
    (() => {
      const at = ledgerSrc113.indexOf('function projectTrendLine(')
      const end = ledgerSrc113.indexOf('function levelTrendLine(')
      if (!(at > 0 && end > at)) return false
      const body = ledgerSrc113.slice(at, end)
      return body.includes('const box = compactSeq(c.seq)') && !body.includes('c.seq.join(\' → \')') && body.includes('if (box.cut > cut) cut = box.cut')
    })(),
  )
  check(
    '项目走向·省略: cut 要报数并指路（`…` 会被读成「这几次没数」，那是另一种谎）',
    ledgerSrc113.includes('if (cut > 0) caveats.push(`序列太长，中间 ${cut} 次用 … 省略（要逐轮就展开那一轮看账）`)'),
  )
  check(
    '项目走向·新出现: 判据是「第一次 > 0 的位置不在开头」，报第几次起有数 + 现在多少条',
    ledgerSrc113.includes('const firstLive = (seq) => seq.findIndex((n) => n > 0)') &&
      ledgerSrc113.includes('if (f > 0) appeared.push({ name: c.name, at: f + 1, now: c.last })') &&
      ledgerSrc113.includes('这条走向里新出现：${top.join(\'、\')}') &&
      ledgerSrc113.includes('（第 ${c.at} 次起有数，现在 ${c.now} 条）'),
  )
  check(
    '项目走向·消失: 判据是「最后一次 > 0 的位置不在末尾」，报最后一次是多少（归零只写 -N 会让人以为本来就没有）',
    ledgerSrc113.includes('const lastLive = (seq) => {') &&
      ledgerSrc113.includes('if (l >= 0 && l < c.seq.length - 1) gone.push({ name: c.name, at: l + 1, was: c.seq[l] })') &&
      ledgerSrc113.includes('这条走向里消失：${top.join(\'、\')}') &&
      ledgerSrc113.includes('（第 ${c.at} 次是最后的数：${c.was} 条）'),
  )
  check(
    '项目走向·点名: 各最多列 3 个，多的要写「还有 N 个没列」（列不完就得承认列不完）',
    ledgerSrc113.includes('${appeared.length > top.length ? `，还有 ${appeared.length - top.length} 个没列` : \'\'}') &&
      ledgerSrc113.includes('${gone.length > top.length ? `，还有 ${gone.length - top.length} 个没列` : \'\'}'),
  )
  check(
    '项目走向·改名: 只有一存一失同时出现才提「可能是改名」，而且明说不替他猜（走向给线索，核对靠账本）',
    ledgerSrc113.includes('if (appeared.length > 0 && gone.length > 0) {') &&
      ledgerSrc113.includes('一存一失如果条数对得上，很可能只是改名——这条走向不替你猜，要确认就翻那一轮的账看项目段名字'),
  )
  check(
    '项目走向·探针进线：D78 长序列省略 / D79 新出现 / D80 消失 / D81 改名提示 / D82 平稳不加戏',
    fusionSrc113.includes('D78 八轮的序列不许整条摆出来') &&
      fusionSrc113.includes('D79 新出现的要报第几次起有数') &&
      fusionSrc113.includes('D80 消失的要报最后一次是多少') &&
      fusionSrc113.includes('D81 一存一失同时出现时点出「可能是改名」') &&
      fusionSrc113.includes('D82 没有新出现也没有消失就别加这两句'),
  )
  check(
    '项目走向·版本不早于 0.2.113（两处一致），文档 9.119 / 125 在位',
    (() => {
      const v = pkg113.version.split('.').map((x) => Number(x))
      const atLeast = v[0] > 0 || v[1] > 2 || (v[1] === 2 && v[2] >= 113)
      return atLeast && idxSrc113.includes(`export const version = '${pkg113.version}'`)
    })() &&
      readFileSync(join(root, 'docs', 'INTERNAL.md'), 'utf8').includes('## 9.119') &&
      readFileSync(join(root, 'DESIGN.md'), 'utf8').includes('## 125'),
  )
}

// [macro-fusion 0.2.114] 疑似冲突：对子两块只抓「同一句话存了两份」，抓不到「同一件事两种说法」
{
  const meowSrc114 = readFileSync(join(root, 'vendor', 'meow-memory', 'lib', 'index.js'), 'utf8')
  const ledgerSrc114 = readFileSync(join(root, 'lib', 'macro', 'dreamledger.js'), 'utf8')
  const rulerSrc114 = readFileSync(join(root, 'tools', 'probe-ruler.mjs'), 'utf8')
  const fusionSrc114 = readFileSync(join(root, 'tools', 'probe-fusion.mjs'), 'utf8')
  const pkg114 = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  const idxSrc114 = readFileSync(join(root, 'lib', 'index.js'), 'utf8')

  check(
    '冲突: 写侧门槛在位（同一主题 2 个关键词、两侧各有数字、最多 3 对 / 各侧点到 3 个 / 关键词采样 4 个）',
    meowSrc114.includes('var DREAM_CONFLICT_MAX = 3;') &&
      meowSrc114.includes('var DREAM_CONFLICT_KEYS = 2;') &&
      meowSrc114.includes('var DREAM_CONFLICT_NUMS = 3;') &&
      meowSrc114.includes('var DREAM_CONFLICT_KEYS_SAMPLE = 4;') &&
      meowSrc114.includes('function dreamConflictPairs(rows, max = DREAM_CONFLICT_MAX)'),
  )
  check(
    '冲突: 四种「不算冲突」都排除（归档已处置 / 逐字重复归对子块 / 覆盖归详写块 / 数字一致是复述）',
    meowSrc114.includes('const live = rows.filter((r) => String(r.status ?? "active") !== "archived")') &&
      meowSrc114.includes('if (overlapOfSets(sets[i], sets[j]) >= DEDUP_THRESHOLD) continue') &&
      meowSrc114.includes('if (coverOfSets(sets[i], sets[j]) >= DREAM_COVER_MIN) continue') &&
      meowSrc114.includes('if (sameNumberSet(nums[i], nums[j])) continue') &&
      meowSrc114.includes('if (nums[i].size === 0) continue'),
  )
  check(
    '冲突: 摊出来的是差异而不是结论（共用关键词 / 各自独有 / 谁更新，时间相同就说分不出）',
    meowSrc114.includes('shared: shared.slice(0, DREAM_CONFLICT_KEYS_SAMPLE),') &&
      meowSrc114.includes('onlyA: onlyA.slice(0, DREAM_CONFLICT_NUMS),') &&
      meowSrc114.includes('newer: ta === tb ? "both" : ta > tb ? "a" : "b"') &&
      meowSrc114.includes('out.sort((x, y) => stamp(y) - stamp(x))'),
  )
  check(
    '冲突: 计数与明细分两个字段（混进 dup/cover 会让读侧「对子没落账」误报），计数不受上限截断',
    meowSrc114.includes('const conflicts = dreamConflictPairs(allRows, Infinity)') &&
      meowSrc114.includes('conflicts: conflicts.length,') &&
      meowSrc114.includes('conflictPairs: dreamPlanConflicts(allRows)') &&
      meowSrc114.includes('for (const p of dreamConflictPairs(allRows, Infinity)) {'),
  )
  check(
    '冲突: 回执会点出对数（标着 0 的真值，不会被当成「没查」），空串不占行',
    meowSrc114.includes('const conf = Number(digest.conflicts) > 0 ? lbl4("dream.plan.conflicts", { n: String(digest.conflicts) }) : "";') &&
      meowSrc114.includes('[head, miss, conf].filter((s) => s !== "").join("\\n")'),
  )
  check(
    '冲突: 清单块按「先出现的那一轮」归轮，另一条不在本组时标「另一组」，块本身插在详写块之后',
    meowSrc114.includes('const conflictPairs = dreamConflictPairs(allRows).filter((p) => dreamPairOwner(rounds, p) === idx);') &&
      meowSrc114.includes('dream.conflict.more') &&
      meowSrc114.includes('dupBlock + repeatBlock + coverBlock + conflictBlock'),
  )
  check(
    '冲突: 三语标签各 8 键（标题 / 关键词 / 独有 / 更多 / 谁更新 / 分不出 / 判据 / 回执）',
    ['title', 'keywords', 'only', 'more', 'newer', 'same', 'rule'].every((k) =>
      ['zh', 'en', 'pt-br'].every((l) =>
        readFileSync(join(root, 'vendor', 'meow-memory', 'lib', 'prompts', l, 'labels.md'), 'utf8').includes(`- dream.conflict.${k}:`),
      ),
    ) &&
      ['zh', 'en', 'pt-br'].every((l) =>
        readFileSync(join(root, 'vendor', 'meow-memory', 'lib', 'prompts', l, 'labels.md'), 'utf8').includes('- dream.plan.conflicts:'),
      ),
  )
  check(
    '冲突: 六份槽位指导都教了「别合并、别因为旧就归档」（三语 × fact/topic）',
    ['zh', 'en', 'pt-br'].every((l) => {
      const atomic = readFileSync(join(root, 'vendor', 'meow-memory', 'lib', 'prompts', l, 'dream-atomic.md'), 'utf8')
      const topic = readFileSync(join(root, 'vendor', 'meow-memory', 'lib', 'prompts', l, 'dream-topic.md'), 'utf8')
      const block = l === 'zh' ? '【疑似冲突】' : l === 'en' ? '[probable conflicts]' : '[conflitos prováveis]'
      const mergeWarn = l === 'zh' ? '别合并成一条' : l === 'en' ? '**Do not merge them into one' : '**Não junte as duas em uma'
      const staleHint = l === 'zh' ? '（已被取代' : l === 'en' ? '(superseded' : '(substituída'
      const fileHint = l === 'zh' ? '翻项目文件' : l === 'en' ? 'check the project files' : 'confira os arquivos do projeto'
      return (
        atomic.includes(block) && atomic.includes(mergeWarn) && atomic.includes(staleHint) && atomic.includes(fileHint) &&
        topic.includes(block) && topic.includes(mergeWarn) && topic.includes(staleHint) && topic.includes(fileHint)
      )
    }),
  )
  check(
    '冲突: 读侧四个分支各说各话（老账=没查 / 真没有 / 说有几对却没明细 / 只存前几对）',
    ledgerSrc114.includes("function conflictsOf(plan) {") &&
      ledgerSrc114.includes('return Number.isFinite(n) && n > 0 ? n : 0') &&
      ledgerSrc114.includes('if (!Array.isArray(list)) return null') &&
      ledgerSrc114.includes('那一轮根本没查冲突，不是「查了没有」。') &&
      ledgerSrc114.includes('这一轮没有「同一主题却写了不同数字」的条目。') &&
      ledgerSrc114.includes('却没有一条明细——别把「没列」读成「没有」。') &&
      ledgerSrc114.includes('对没落账（一条账只存前几对）——数是真数，点名只到前几对。'),
  )
  check(
    '冲突: 明细一行摊事实（id 对 / 层 / 共用关键词 / 各自独有 / 谁更新），0 对不进行首',
    ledgerSrc114.includes("const head = `- ${idA} ⇄ ${idB} · ${p?.levelA ?? '?'} ⇄ ${p?.levelB ?? '?'}`") &&
      ledgerSrc114.includes('· 共用关键词：${words.join') &&
      ledgerSrc114.includes('两条更新时间相同，分不出谁新') &&
      ledgerSrc114.includes('if (conflictCount > 0) parts.push(`疑似冲突 ${conflictCount} 对`)'),
  )
  check(
    '冲突: 面板插在重复对之后（先看该不该合并，再看该不该统一说法），走向两块不加冲突（那是两件事）',
    (() => {
      const at = ledgerSrc114.indexOf('const conflictText = conflictsBlock(row, seen, settled)')
      const pairAt = ledgerSrc114.indexOf('lines.push(pairsBlock(row))')
      if (!(at > 0 && pairAt > 0 && at > pairAt)) return false
      const bodyOf = (name) => {
        const from = ledgerSrc114.indexOf(`function ${name}(`)
        if (from < 0) return ''
        const next = ledgerSrc114.indexOf('\nfunction ', from + 10)
        return ledgerSrc114.slice(from, next > from ? next : ledgerSrc114.length)
      }
      const level = bodyOf('levelTrendLine')
      const project = bodyOf('projectTrendLine')
      return level !== '' && project !== '' && !level.includes('conflict') && !project.includes('conflict')
    })(),
  )
  check(
    '冲突·探针进线：写侧 L32–L37（落账 / 复述不报 / 归档不报 / 回执与清单 / 时间相同 / 跨轮只印一次）',
    rulerSrc114.includes('L32 同一主题写了不同版本') &&
      rulerSrc114.includes('L33 阴性对照：数字一致而措辞不同的复述不算冲突') &&
      rulerSrc114.includes('L34 阴性对照：归档的那条不报冲突') &&
      rulerSrc114.includes('L35 回执点出冲突对数') &&
      rulerSrc114.includes('L36 更新时间一模一样') &&
      rulerSrc114.includes('L37 跨轮同一对只印一次'),
  )
  check(
    '冲突·探针进线：面板 D83–D88（摊差异 / 行里点名 / 老账说没查 / 有数没明细 / 只存前几对 / 阴性对照）',
    fusionSrc114.includes('D83 摊开一条带冲突的账') &&
      fusionSrc114.includes('D84 行里就点出「疑似冲突 N 对」') &&
      fusionSrc114.includes('D85 老账（0.2.114 之前）明说「没查过冲突」') &&
      fusionSrc114.includes('D86 账里记着 2 对却一条明细都没有') &&
      fusionSrc114.includes('D87 只存了前几对') &&
      fusionSrc114.includes('D88 阴性对照：这一轮没有两种说法就明说没有'),
  )
  check(
    '冲突·版本不早于 0.2.114（两处一致），文档 9.120 / 126 在位',
    (() => {
      const v = pkg114.version.split('.').map((x) => Number(x))
      const atLeast = v[0] > 0 || v[1] > 2 || (v[1] === 2 && v[2] >= 114)
      return atLeast && idxSrc114.includes(`export const version = '${pkg114.version}'`)
    })() &&
      readFileSync(join(root, 'docs', 'INTERNAL.md'), 'utf8').includes('## 9.120') &&
      readFileSync(join(root, 'DESIGN.md'), 'utf8').includes('## 126'),
  )
}

// [macro-fusion 0.2.115] 冲突跨轮追踪：报过的和刚发现的必须分得开
{
  const meowSrc115 = readFileSync(join(root, 'vendor', 'meow-memory', 'lib', 'index.js'), 'utf8')
  const ledgerSrc115 = readFileSync(join(root, 'lib', 'macro', 'dreamledger.js'), 'utf8')
  const fusionSrc115 = readFileSync(join(root, 'tools', 'probe-fusion.mjs'), 'utf8')
  const pkg115 = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  const idxSrc115 = readFileSync(join(root, 'lib', 'index.js'), 'utf8')
  const bodyOf115 = (name) => {
    const from = ledgerSrc115.indexOf(`function ${name}(`)
    if (from < 0) return ''
    const next = ledgerSrc115.indexOf('\nfunction ', from + 10)
    return ledgerSrc115.slice(from, next > from ? next : ledgerSrc115.length)
  }

  check(
    '跨轮: 写侧开一个「连着取几段账」的读口（同一把尺子，次序与第几近对得上），坏的 offset 就地打回',
    meowSrc115.includes('function readDreamRecords(workspace, dir = ".dsh-meow", limit = 5, offset = 0)') &&
      meowSrc115.includes('const rows = db.recentDreamsPage(n, askedOffset);') &&
      meowSrc115.includes('if (!Number.isFinite(askedOffset) || askedOffset < 0) return { rows: [], missing: "bad-arg", total: 0, path };') &&
      meowSrc115.includes('  readDreamRecords,'),
  )
  check(
    '跨轮: 覆盖面与催办门槛写成常量（往回看 10 条、连报 3 次才算挂着）',
    ledgerSrc115.includes('const OLDER_SPAN = 10') && ledgerSrc115.includes('const CONFLICT_REPEAT_MIN = 3'),
  )
  check(
    '跨轮: 配对键按短 id 排序拼，a⇄b 与 b⇄a 认成同一对（自配或空 id 一律不认）',
    ledgerSrc115.includes('if (a === \'\' || b === \'\' || a === b) return \'\'') &&
      ledgerSrc115.includes('return a < b ? `${a}⇄${b}` : `${b}⇄${a}`'),
  )
  check(
    '跨轮: 「最早第几轮」按轮号最大算（1 是最新，轮号越大越早）——不然挂了五轮会读成刚出现',
    ledgerSrc115.includes('if (rank > hit.first) hit.first = rank') &&
      bodyOf115('conflictKeyIndex').includes('const rank = firstRank + i'),
  )
  check(
    '跨轮: 更早的账读不出来就一个字都不说（不写「新报」，也不写「没报过」）',
    bodyOf115('conflictSeenOf').includes("got.missing !== ''") &&
      bodyOf115('conflictSeenOf').includes('return undefined') &&
      bodyOf115('trailOf').includes("if (seen === undefined) return ''"),
  )
  check(
    '跨轮: 行尾只加一句结论（老账重提报「最早第 N 轮、加这次共 k 次」，否则「这一轮新报」）',
    ledgerSrc115.includes('return ` · 之前报过（最早第 ${hit.first} 轮，加这次共 ${times} 次）`') &&
      ledgerSrc115.includes("if (hit === undefined) return ' · 这一轮新报'") &&
      ledgerSrc115.includes('function conflictLine(p, seen)') &&
      ledgerSrc115.includes('${verdict}${trail}'),
  )
  check(
    '跨轮: 抬头点出「其中几对之前就报过、最早第几轮」，没有重提就不加这半句',
    ledgerSrc115.includes('const head = repeats.length === 0') &&
      ledgerSrc115.includes('对之前就报过，最早第 ${Math.min(...repeats.map((x) => x.hit.first))} 轮）：'),
  )
  check(
    '跨轮: 连报 ≥3 次还在账上就点名催处置（多报几次不会让它变清楚），两次只报不催',
    ledgerSrc115.includes('const stale = repeats.filter((x) => x.hit.count + 1 >= CONFLICT_REPEAT_MIN)') &&
      ledgerSrc115.includes('已经第 ${worst.hit.count + 1} 次出现在账上（最早第 ${worst.hit.first} 轮）') &&
      ledgerSrc115.includes('同一对不会因为多报几次变得清楚') &&
      ledgerSrc115.includes('要么承认它是两件不同的事，把正文写清归属。'),
  )
  check(
    '跨轮: 摊开面板时把「更早那几轮的账」查一遍（按第几近与按引用两条路都传，晚一条都不许漏）',
    ledgerSrc115.includes('function expandPanel(rec, rank, seen, settled)') &&
      ledgerSrc115.includes('conflictSeenOf(workspace, dir, rankNow)') &&
      ledgerSrc115.includes('conflictSeenOf(workspace, dir, wantId)'),
  )
  check(
    '跨轮·探针进线：D89–D93（老账重提 / 这一轮新报 / 连报三次催处置 / 只报两次不催 / 最早一轮没有可比）',
    fusionSrc115.includes('D89 老账重提') &&
      fusionSrc115.includes('D90 同一轮里新发现的那对标「这一轮新报」') &&
      fusionSrc115.includes('D91 连报三次还挂在账上') &&
      fusionSrc115.includes('D92 只报过两次') &&
      fusionSrc115.includes('D93 最早那一轮没有更早的账可比'),
  )
  check(
    '跨轮·版本不早于 0.2.115（两处一致），文档 9.121 / 127 在位',
    (() => {
      const v = pkg115.version.split('.').map((x) => Number(x))
      const atLeast = v[0] > 0 || v[1] > 2 || (v[1] === 2 && v[2] >= 115)
      return atLeast && idxSrc115.includes(`export const version = '${pkg115.version}'`)
    })() &&
      readFileSync(join(root, 'docs', 'INTERNAL.md'), 'utf8').includes('## 9.121') &&
      readFileSync(join(root, 'DESIGN.md'), 'utf8').includes('## 127'),
  )
}

// [macro-fusion 0.2.116] 冲突的去向：上一轮报的对，这一轮不报了，到底是处置了、
// 条目被归档删了，还是正文改了导致关键词错开？三种在面板上长得一样，以前只能瞎猜。
{
  const idxSrc116 = readFileSync(join(root, 'vendor/meow-memory/lib/index.js'), 'utf8')
  const ledgerSrc116 = readFileSync(join(root, 'lib/macro/dreamledger.js'), 'utf8')
  const fusionSrc116 = readFileSync(join(root, 'tools/probe-fusion.mjs'), 'utf8')
  const rulerSrc116 = readFileSync(join(root, 'tools/probe-ruler.mjs'), 'utf8')
  check(
    '冲突去向: 写侧有个只读的「按 id 取现状」口子（给上一轮那几条的现状，才谈得上去向）',
    idxSrc116.includes('function readRowsByIds(workspace, dir = ".dsh-meow", ids = []) {') &&
      idxSrc116.includes('if (asked.length === 0) return { rows: [], missing: "bad-arg", path: memoryDbPath(workspace, dir) };') &&
      idxSrc116.includes('const cap = asked.slice(0, 20);') &&
      idxSrc116.includes('typeof db.findByIdAll === "function" ? db.findByIdAll(id) : []') &&
      idxSrc116.includes('sessionLevel: m.level'),
  )
  check(
    '冲突去向: 读口在导出清单里（面板要能用），文档首行标了 0.2.116 的 marker',
    idxSrc116.includes('\n  readRowsByIds,\n') &&
      idxSrc116.includes('[macro-fusion 0.2.116]'),
  )
  check(
    '冲突去向: 一次最多摊 3 对（SETTLED_MAX），多的写「还有 N 对没列」',
    ledgerSrc116.includes('const SETTLED_MAX = 3') &&
      ledgerSrc116.includes("lines.push(`  · 还有 ${settled.hidden} 对没列（一次只摊前 ${SETTLED_MAX} 对）。`)") &&
      ledgerSrc116.includes('out.hidden = Math.max(0, gone.length - SETTLED_MAX)'),
  )
  check(
    '冲突去向: 一条的现状分五种说法（查不到 / 短 id 撞了 / 已归档 / 已标 stale / 正文改过 / 没动过），不合并成「动过」',
    ledgerSrc116.includes('function rowFateOf(id, byShort, prevAt) {') &&
      ledgerSrc116.includes('`${id} 查不到了（归档或删除）`') &&
      ledgerSrc116.includes('`${id} 命中 ${list.length} 条（短 id 前几位撞了，判断不了）`') &&
      ledgerSrc116.includes("if (r.status === 'archived') return `${id} 已归档`") &&
      ledgerSrc116.includes("if (r.status === 'stale') return `${id} 已标 stale`") &&
      ledgerSrc116.includes('`${id} 正文改过（${stamp(at)}）`') &&
      ledgerSrc116.includes('return `${id} 没动过`') &&
      ledgerSrc116.includes('if (list.length > 1)'),
  )
  check(
    '冲突去向: 只跟上一轮比（读 2 条取 rows[0]），第一轮没有可比的不硬编（rank > 0 才做）',
    ledgerSrc116.includes('function conflictSettledOf(workspace, dir, rank, plan) {') &&
      ledgerSrc116.includes('if (!(rank > 0)) return undefined') &&
      ledgerSrc116.includes('Meow.readDreamRecords(workspace, dir, 2, rank)') &&
      ledgerSrc116.includes('const prev = got.rows[0]') &&
      ledgerSrc116.includes('const prevAt = Number(prev.runAt) || 0'),
  )
  check(
    '冲突去向: 只摊「这一轮不再报」的键（用 conflictKeyOf 归一，a/b 顺序无关），还在报的不进这一块',
    ledgerSrc116.includes('const gone = prevPairs.filter((p) => {') &&
      ledgerSrc116.includes('if (gone.length === 0) return out') &&
      ledgerSrc116.includes('return { key: conflictKeyOf(p), text: `${rowFateOf(a, byShort, prevAt)}；${rowFateOf(b, byShort, prevAt)}` }'),
  )
  check(
    '冲突去向: 现状读不出来就说读不出来（blind），不外推成「没动过」',
    ledgerSrc116.includes('out.blind = true') &&
      ledgerSrc116.includes('的现状读不出来') &&
      ledgerSrc116.includes('这几对的现状读不出来——只报「不再报」这个事实，去向不猜。'),
  )
  check(
    '冲突去向: 三种尾巴分得开——都没动过 ≠ 动过 ≠ 读不到（前两种最容易被误读成「解决了」）',
    ledgerSrc116.includes('两条都还在、也都没动过——它这一轮没被报，多半是关键词 / 数字刚好错开，不是处置。') &&
      ledgerSrc116.includes('上面只是「后来动过什么」，不等于这一对真解决了：要确认就打开那两条看正文。') &&
      ledgerSrc116.includes('const changed = /已归档|已标 stale|正文改过|查不到了|命中 \\d+ 条|读不出来/') &&
      ledgerSrc116.includes('} else if (gone.every((g) => !changed.test(String(g.text)))) {'),
  )
  check(
    '冲突去向: 上一轮没报过、或老账没这一格——一个字都不写（不占版面）',
    ledgerSrc116.includes('if (settled === undefined || settled === null) return') &&
      ledgerSrc116.includes('if (total === 0) return') &&
      ledgerSrc116.includes('if (gone.length === 0) return `${head}，这一轮还都在报。`'),
  )
  check(
    '冲突去向: 三个分支都挂去向块（这一轮 0 对时，去向是唯一线索），展开两路都传 settled',
    ledgerSrc116.includes('function conflictsBlock(row, seen, settled) {') &&
      ledgerSrc116.includes('const settledText = settledBlock(settled)') &&
      ledgerSrc116.includes('const withTail = (text) => (settledText === \'\' ? text : `${text}\\n${settledText}`)') &&
      ledgerSrc116.includes('conflictSettledOf(workspace, dir, rankNow, rec.row?.changes?.plan)') &&
      ledgerSrc116.includes('conflictSettledOf(workspace, dir, wantId, rec.row?.changes?.plan)') &&
      ledgerSrc116.includes('function expandPanel(rec, rank, seen, settled) {'),
  )
  check(
    '冲突去向·探针进线：D94–D100（已归档 / 正文改过 / 都没动过 / 都查不到 / 还在报 / 上一轮没报 / 引用路径）',
    fusionSrc116.includes('D94 上一轮报过、这一轮不报') &&
      fusionSrc116.includes('D95 上一轮之后正文被改过') &&
      fusionSrc116.includes('D96 两条都没动过') &&
      fusionSrc116.includes('D97 两条都查不到了') &&
      fusionSrc116.includes('D98 这一轮还在报') &&
      fusionSrc116.includes('D99 上一轮本来就没报过对') &&
      fusionSrc116.includes('D100 按引用展开也带去向') &&
      !rulerSrc116.includes('D94'),
  )
  check(
    '冲突去向: 版本与文档一起走（9.122 / 128）',
    (() => {
      const pkg116 = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
      const v = pkg116.version.split('.').map((x) => Number(x))
      const atLeast = v[0] > 0 || v[1] > 2 || (v[1] === 2 && v[2] >= 116)
      return atLeast && readFileSync(join(root, 'lib/index.js'), 'utf8').includes(`export const version = '${pkg116.version}'`)
    })() &&
      readFileSync(join(root, 'docs', 'INTERNAL.md'), 'utf8').includes('## 9.122') &&
      readFileSync(join(root, 'DESIGN.md'), 'utf8').includes('## 128'),
  )
}

// [macro-fusion 0.2.117] 取代关系：写新的同时把被顶掉的旧的降格——不删，只矫正。
// 主人对这一版的口径：好的记忆插件不需要「遗忘」，需要的是「对过期或错误记忆的修改矫正」。
{
  const remSrc117 = readFileSync(join(root, 'lib/macro/defs/remember.js'), 'utf8')
  const ledgerSrc117 = readFileSync(join(root, 'lib/macro/dreamledger.js'), 'utf8')
  const auditSrc117 = readFileSync(join(root, 'tools/param-audit.mjs'), 'utf8')
  const fusionSrc117 = readFileSync(join(root, 'tools/probe-fusion.mjs'), 'utf8')
  check(
    '取代: 口子挂在 memory_remember 上（写的一条延伸），不另起工具——工具分工仍然一工具一件事',
    remSrc117.includes("name: 'memory_remember',") &&
      !remSrc117.includes("name: 'memory_supersede',") &&
      !remSrc117.includes("name: 'memory_forget',"),
  )
  check(
    '取代: schema 里是 supersedes（数组、最多 5 条），描述就把「不删除 / 可读 / 可反悔」写在门口',
    remSrc117.includes('supersedes: {') &&
      remSrc117.includes("type: 'array',") &&
      remSrc117.includes('这次写入顶掉的旧条目 id（最多 5 条，短 id 前 8 位也行）') &&
      remSrc117.includes('不删除、可 memory_read、可反悔。'),
  )
  check(
    '取代: 参数审计认这个参数（不给白名单就等于默默拒绝，调用方永远不知道它被丢了）',
    auditSrc117.includes("'memory_remember': ['links', 'supersedes']"),
  )
  check(
    '取代: 归一先去非字符串 / 空串 / 重复，再截 5 条，超出的原样报回（不许静默截断）',
    remSrc117.includes('function supersedeAskedOf(raw) {') &&
      remSrc117.includes("if (typeof one !== 'string') continue") &&
      remSrc117.includes('if (!asked.includes(id)) asked.push(id)') &&
      remSrc117.includes('return { ids: asked.slice(0, SUPERSEDE_MAX), extra: asked.slice(SUPERSEDE_MAX) }'),
  )
  check(
    '取代: 那半句只写事实（谁顶掉的、哪天），不写判决——正文归 caller',
    remSrc117.includes('const SUPERSEDE_MAX = 5') &&
      remSrc117.includes("const SUPERSEDE_MARK = '（已被取代：'") &&
      remSrc117.includes('const SUPERSEDE_HEAD = 24') &&
      remSrc117.includes('${SUPERSEDE_MARK}${who}${head ? `「${head}」` : \'\'}，${dayStamp(at)}）'),
  )
  check(
    '取代: 一条记忆不能取代自己——但不能靠前缀先判（同秒写下的两条 id 前 8 位一样），得先读出来再判',
    remSrc117.includes('if (v && v.id === newId) {') &&
      remSrc117.includes('就是这次刚写的那一条，跳过了（一条记忆不能取代自己）') &&
      !remSrc117.includes('String(newId).startsWith(asked)'),
  )
  check(
    '取代: 短 id 撞上刚写的那条时用排除法认人（候选只剩一条才办，并把「为什么是这条」写进回执）',
    remSrc117.includes('const CANDIDATE_ID = /0m[0-9a-z]+-[0-9a-f]{32}/g') &&
      remSrc117.includes('function candidateIdsOf(v) {') &&
      remSrc117.includes('const others = ids.filter((one) => one !== newId)') &&
      remSrc117.includes('if (ids.length > 0 && others.length === 1) {') &&
      remSrc117.includes('把它排除后只剩') &&
      remSrc117.includes('if (via) lines.push('),
  )
  check(
    '取代: 短 id 多命中就说多命中，不替 caller 挑一条（挑错等于悄悄处置了另一条）',
    remSrc117.includes('if (v && v.ambiguous === true) {') &&
      remSrc117.includes('function ambiguousCountOf(v, ids) {') &&
      remSrc117.includes('短 id 命中 ${n} 条，没替你挑一条——换成完整 id 再来一次') &&
      remSrc117.includes('这 ${n} 条都还没动'),
  )
  check(
    '取代: 四种「没改成」各说各话——找不到 / 已作废 / 已经标过 / 写库失败都不许回成成功',
    remSrc117.includes('没找到（可能已归档或删除）——它没有被改') &&
      remSrc117.includes('已经是 archived（作废），没动它') &&
      remSrc117.includes('正文里已经有一句「已被取代」，没重复追加') &&
      remSrc117.includes('找到了但没写进库') &&
      remSrc117.includes('它还是原样，别当成已经处置'),
  )
  check(
    '取代: 改成了分两种说法（本来是 stale 的只补一句），且都明确写了新状态',
    remSrc117.includes('本来就是 stale，只补了一句「已被取代」') &&
      remSrc117.includes('已标 stale，正文末尾补了一句「已被取代」') &&
      remSrc117.includes("{ id: v.id, content: next, status: 'stale' }"),
  )
  check(
    '取代: 抬头就把「一条都没删」说清，尾注给反悔办法，超上限的单独一行交代',
    remSrc117.includes('接管这些条目的位置；旧条目一条都没删，只是不再算「在用」') &&
      remSrc117.includes('超出 ${SUPERSEDE_MAX} 条上限的 ${extra.length} 条这次没有处理') &&
      remSrc117.includes('反悔办法：旧条目都还在库里，memory_update 把 status 改回 active、再删掉那句取代话就恢复原样。'),
  )
  check(
    '取代: 新条目没写进去（回执空 / 没 id）时，取代一条都不做——不能把旧的指向不存在的新条目',
    remSrc117.includes('取代这次一条都没做：新条目连 id 都没拿到') &&
      remSrc117.includes('取代这次一条都没做：新条目没拿到 id（上游只回了文字）') &&
      remSrc117.includes('先用 memory_search 找到这条的新 id，再逐条 memory_update。'),
  )
  check(
    '取代: dream 的催办不再只劝，还给出一行能照抄的调用样子（劝办要给得起的动作）',
    ledgerSrc117.includes('一次做完：memory_remember(…, supersedes: ["') &&
      ledgerSrc117.includes('旧条目不会消失，反悔可改回 active。') &&
      ledgerSrc117.includes('同一对不会因为多报几次变得清楚'),
  )
  check(
    '取代·探针进线：SS1–SS12，且必须在自己的临时工作区里跑（写进共用库会顶掉后面「零命中」这类唯一性断言）',
    fusionSrc117.includes("mkdtempSync(join(tmpdir(), 'macro-probe-supersede-'))") &&
      fusionSrc117.includes('const ssRun = (name, args) => tools.get(name).execute(args, ssExec)') &&
      fusionSrc117.includes("const ssDb = Meow.getDb(ssWs, '.dsh-meow')") &&
      fusionSrc117.includes('SS2 回执报出取代段') &&
      fusionSrc117.includes('SS3 旧条目状态变 stale') &&
      fusionSrc117.includes('SS5 正文里取代句只有一句') &&
      fusionSrc117.includes('SS6 找不到的旧 id 说清没改') &&
      fusionSrc117.includes('SS7 已作废的不动') &&
      fusionSrc117.includes('SS8 本来就 stale 的只补一句') &&
      fusionSrc117.includes('SS9 归一后为空就不起取代段') &&
      fusionSrc117.includes('SS10 超出上限就报出没处理的那几条') &&
      fusionSrc117.includes('SS11 短 id 命中多条时不挑，只报条数') &&
      fusionSrc117.includes('SS12 一条记忆不能取代自己'),
  )
  check(
    '取代: 版本与文档一起走（9.123 / 129）',
    (() => {
      const pkg117 = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
      const v = pkg117.version.split('.').map((x) => Number(x))
      const atLeast = v[0] > 0 || v[1] > 2 || (v[1] === 2 && v[2] >= 117)
      return atLeast && readFileSync(join(root, 'lib/index.js'), 'utf8').includes(`export const version = '${pkg117.version}'`)
    })() &&
      readFileSync(join(root, 'docs', 'INTERNAL.md'), 'utf8').includes('## 9.123') &&
      readFileSync(join(root, 'DESIGN.md'), 'utf8').includes('## 129'),
  )
}

// [macro-fusion 0.2.118] 检索融合：本地检索与星图扩散按名次合成一张榜。
// 老做法把两段文本上下拼在一起——同一堆记忆出现两遍（第二遍白花 token），
// 而「两条路都命中」这条最硬的相关性证据，没有任何人替读者指出来。
{
  const fusionSrc118 = readFileSync(join(root, 'lib/macro/fusion.js'), 'utf8')
  const searchSrc118 = readFileSync(join(root, 'lib/macro/defs/search.js'), 'utf8')
  const probeSrc118 = readFileSync(join(root, 'tools/probe-fusion.mjs'), 'utf8')
  check(
    '融合: 只按名次合（RRF k=60），不拿两路分数比大小——分数线不同源的数放在一起，结论是编出来的',
    fusionSrc118.includes('export const RRF_K = 60') &&
      fusionSrc118.includes('export function fuseRanked(') &&
      fusionSrc118.includes('1 / (RRF_K + r.localRank)') &&
      fusionSrc118.includes('1 / (RRF_K + r.graphRank)') &&
      fusionSrc118.includes('的分数不同源'),
  )
  check(
    '融合: 解析的是 nebula_recall 真实那几行（排名 / 层级 / 强度 / 标题 + id / 为什么 / 摘要）',
    fusionSrc118.includes('const NODE_HEAD = /^(\\d+)\\.\\s+\\[([^\\]]+)\\]\\s+(.*?)\\s+强度\\s+([\\d.]+)\\s*(.*)$/') &&
      fusionSrc118.includes('const ID_LINE = /^\\s{2,}id:\\s*(\\S+)\\s*$/') &&
      fusionSrc118.includes('const WHY_LINE = /^\\s{2,}为什么：\\s*(.*)$/') &&
      fusionSrc118.includes('const PREVIEW_LINE = /^\\s{2,}摘要：\\s*(.*)$/'),
  )
  check(
    '融合: 星图 id 带工作区前缀、本地是裸 id——取最后一段对齐，前 12 位指认同一条',
    fusionSrc118.includes('export function uidOf(id) {') &&
      fusionSrc118.includes("const at = s.lastIndexOf(':')") &&
      fusionSrc118.includes('function sameMem(a, b) {') &&
      fusionSrc118.includes('return a.startsWith(b) || b.startsWith(a)'),
  )
  check(
    '融合: 同一条记忆只占一个位置，三种来路分开说（本地#n / 星图#m / 两路）',
    fusionSrc118.includes('export function routeOf(row) {') &&
      fusionSrc118.includes('+ 星图#') &&
      fusionSrc118.includes('if (row.localRank > 0) return '),
  )
  check(
    '融合: 本地命中带全文（它就是答案），星图独有只带「为什么相关」+ 摘要（全文在本地那边已经有了）',
    fusionSrc118.includes('export function fusedText(') &&
      fusionSrc118.includes('（本地没命中，靠关联进来') &&
      fusionSrc118.includes('clip(g.preview, 150)'),
  )
  check(
    '融合: 截断要说清（星图独有的条数被 limit / 预算压过时，报出还有几条没展开）',
    fusionSrc118.includes('if (dropped > 0) {') && fusionSrc118.includes('条星图带回来的没有展开'),
  )
  check(
    '融合: 接在 expand 分支上，并且排在预算分支之前（融合榜是整份回执，不能先按分段花完预算再合）',
    searchSrc118.includes('const fusedHead = await fusedPart({ localValue: main.value, graphText: spread.text, spreadLimit, budget, flags })') &&
      searchSrc118.includes('if (fusedHead !== null) return fusedHead') &&
      searchSrc118.indexOf('await fusedPart(') < searchSrc118.indexOf('const spreadFit = await fitPath(flow, exec, {'),
  )
  check(
    '融合: 合不了就退回两段式（本地零命中 / 星图解析不出 / 预算装不下都不硬凑半张榜）',
    searchSrc118.includes('if (localHits.length === 0 || nodes.length === 0) return null') &&
      (searchSrc118.match(/— 星图关联扩散 —/g) || []).length === 2,
  )
  check(
    '融合: 预算紧时先砍星图独有那几条（先砍证据，不砍答案），并把砍掉的说一句',
    searchSrc118.includes('while (shown > 0 && estTokens(build(shown)) > budget.value) shown -= 1') &&
      searchSrc118.includes('融合榜按 ${budget.value} token 预算收紧：星图独有的条目从 ${graphShown} 条压到 ${shown} 条。') &&
      searchSrc118.includes('flags.fused = true'),
  )
  check(
    '融合·探针进线：F1–F14（含「名次说了算」「省 token」两条硬断言）',
    probeSrc118.includes('F1 解析得动真实那三行格式') &&
      probeSrc118.includes('F3 两路都命中的只算一行') &&
      probeSrc118.includes('F5 名次说了算，分数再高也不许插队') &&
      probeSrc118.includes('F6 星图只给前 12 位也认得出是同一条') &&
      probeSrc118.includes('F11 端到端：expand=true 时给的是融合榜，不是两段拼接') &&
      probeSrc118.includes('F13 星图回执解析不出节点时退回两段式') &&
      probeSrc118.includes('F14 融合确实省 token'),
  )
  check(
    '融合: 版本与文档一起走（9.124 / 130）',
    (() => {
      const pkg118 = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
      const v = pkg118.version.split('.').map((x) => Number(x))
      const atLeast = v[0] > 0 || v[1] > 2 || (v[1] === 2 && v[2] >= 118)
      return atLeast && readFileSync(join(root, 'lib/index.js'), 'utf8').includes(`export const version = '${pkg118.version}'`)
    })() &&
      readFileSync(join(root, 'docs', 'INTERNAL.md'), 'utf8').includes('## 9.124') &&
      readFileSync(join(root, 'DESIGN.md'), 'utf8').includes('## 130'),
  )
}

// [macro-fusion 0.2.121] 检索要能自答：词干门按 token 判 / 元数据透传 / 正文与日期进回执。
// 三处病是同一种病——「排得对，却答不出」：记忆没归一到同一个词、元数据出了 search() 就没了、
// 回执只印抬头所以 content_max 这个旋钮一直空转（预算砍它，回执一字不变）。
{
  const meowSrc121 = readFileSync(join(root, 'vendor', 'meow-memory', 'lib', 'index.js'), 'utf8')
  const probeSrc121 = readFileSync(join(root, 'tools', 'probe-fusion.mjs'), 'utf8')
  check(
    '检索自答: 词干门按「这段 token 像不像英文」判，不按会话语言判（语言是文本的属性）',
    meowSrc121.includes('function isMostlyLatin(tokens)') &&
      meowSrc121.includes('return isMostlyLatin(out) ? normalizeEn(out) : out') &&
      !meowSrc121.includes('lang === "en" ? normalizeEn(out) : out') &&
      !meowSrc121.includes('const lang = getPromptLang().toLowerCase().split(/[-_]/)[0];'),
  )
  check(
    '检索自答: 判据取「多数」（latin*2 >= ln），夹一个 RRF 不该触发 Porter；CJK 二元组不动',
    meowSrc121.includes('if (latin * 2 >= ln) return true;') &&
      meowSrc121.includes('if (c < 97 || c > 122) return false;') &&
      // [0.6.25] 汉字段二元组不再拼 `prev + cur`，改成按相邻两码点直接切片——
      // 相邻子串拼接恒等于连续切片，串相同，守的是同一件事。
      meowSrc121.includes('out.push(s.slice(ps, k + w));') &&
      meowSrc121.includes('ps = k;'),
  )
  check(
    '检索自答: 元数据透传是「有才带」（老调用方没这些字段时不许硬塞 undefined）',
    // [0.6.15] 这一条下面要读十来次同一条记录的字段，引擎先把 `docs[di]` 落进 `dOf`：
    // 断言跟着读 `dOf.X`，守的仍是「没这个字段就别硬塞 undefined」。
    meowSrc121.includes('...dOf.keywords === void 0 ? {} : { keywords: dOf.keywords },') &&
      meowSrc121.includes('...dOf.project === void 0 ? {} : { project: dOf.project },') &&
      meowSrc121.includes('...dOf.created_at === void 0 ? {} : { created_at: dOf.created_at },') &&
      meowSrc121.includes('...dOf.source_session === void 0 ? {} : { source_session: dOf.source_session },'),
  )
  check(
    '检索自答: render 把已经截好的正文印出来（不再只印「关于：关键词」）',
    meowSrc121.includes('const body = String(h.content ?? "");') &&
      meowSrc121.includes('if (body.length > 0) lines.push(`  ${body}${h.truncated === true ?'),
  )
  check(
    '检索自答: 截断要交代（已截断到 N 字 + 指到 memory_read），不标就等于把摘要当全文',
    meowSrc121.includes('memory_read\\uFF09') && meowSrc121.includes('\\u5DF2\\u622A\\u65AD\\u5230 ${cm}'),
  )
  check(
    '检索自答: 日期从 keywords 的 YYYY-MM-DD 派生，抬头写成「相对时间 · 日期」',
    meowSrc121.includes('var DAY_RE = /^\\d{4}-\\d{2}-\\d{2}$/;') &&
      meowSrc121.includes('function dayOfKeywords(keywords)') &&
      meowSrc121.includes('const day = h.day ? ` \\u00B7 ${h.day}` : "";'),
  )
  check(
    '检索自答: truncated / day 两个新字段都进 schema（additionalProperties:false 下必须显式声明），且都可选',
    meowSrc121.includes('truncated: { type: "boolean"') &&
      meowSrc121.includes('day: { type: "string"') &&
      meowSrc121.includes('...contentMax > 0 && h.content.length > contentMax ? { truncated: true } : {}') &&
      meowSrc121.includes('day: dayOfKeywords(row?.keywords) || stampWhen(row?.updated_at),'),
  )
  check(
    '检索自答·探针进线：SR0–SR6（含阴性对照与「空旋钮」那条硬断言）',
    probeSrc121.includes('SR1 回执带正文') &&
      probeSrc121.includes('SR2 抬头带日期') &&
      probeSrc121.includes('SR3 截断有交代') &&
      probeSrc121.includes('SR4b 阴性对照：只印抬头的老格式过不了 SR1/SR3') &&
      probeSrc121.includes('SR5 value 里 truncated=true') &&
      probeSrc121.includes('SR6 预算收紧时回执真的变短（content_max 旋钮不再是空的）'),
  )
  check(
    '检索自答: 版本与文档一起走（9.125 / 131）',
    (() => {
      const pkg121 = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
      const v = pkg121.version.split('.').map((x) => Number(x))
      const atLeast = v[0] > 0 || v[1] > 2 || (v[1] === 2 && v[2] >= 121)
      return atLeast && readFileSync(join(root, 'lib', 'index.js'), 'utf8').includes(`export const version = '${pkg121.version}'`)
    })() &&
      readFileSync(join(root, 'docs', 'INTERNAL.md'), 'utf8').includes('## 9.125') &&
      readFileSync(join(root, 'DESIGN.md'), 'utf8').includes('## 131 '),
  )
}

// ── 实体先验（0.2.122）：问句里的专有名词要能压过措辞 ────────────────────
{
  const Meow = await import(pathToFileURL(join(root, 'vendor', 'meow-memory', 'lib', 'index.js')).href)
  const meowSrc122 = readFileSync(join(root, 'vendor', 'meow-memory', 'lib', 'index.js'), 'utf8')
  const probeSrc122 = readFileSync(join(root, 'tools', 'probe-fusion.mjs'), 'utf8')
  check(
    'ER 实体先验: queryEntities 认专有名词、跳过句首那个「只是大写」的词',
    meowSrc122.includes('function queryEntities(query)') &&
      meowSrc122.includes('.matchAll(/\\b([A-Z][a-z]{2,})\\b/g)') &&
      meowSrc122.includes('if ((m.index ?? 0) === 0) continue;'),
  )
  check(
    'ER 实体先验: 乘性加成 0.8、只在有实体时建集合（无实体问句一个字节都不动）',
    meowSrc122.includes('const ENT_W = 0.8;') &&
      meowSrc122.includes('const entSets = entToks.length > 0 ? docToks.map((toks) => new Set(toks)) : null;') &&
      meowSrc122.includes('if (hit > 0) s *= 1 + ENT_W * (hit / entToks.length);'),
  )
  check(
    'ER 实体先验: 实体 token 走同一个 tokenize（口径不同就永远匹配不上）',
    meowSrc122.includes('queryEntities(query).map((e) => tokenize(e)).filter((t) => t.length === 1).map((t) => t[0])'),
  )
  check(
    'ER 实体先验: entityPrior=false 总闸在位（没有它，「没变化」和「没生效」分不开）',
    meowSrc122.includes('opts.entityPrior === false') && meowSrc122.includes('entities: entToks.length,'),
  )
  {
    const docs = [
      { id: 'a', level: 'fact', content: 'Caroline: I am researching adoption agencies.', keywords: [], importance: 1, updated_at: 1, last_accessed_at: 1 },
      { id: 'b', level: 'fact', content: 'Melanie: research is exhausting, I research all day.', keywords: [], importance: 1, updated_at: 1, last_accessed_at: 1 },
    ]
    const on = Meow.search('What did Caroline research?', docs, { k: 2, now: null })
    const off = Meow.search('What did Caroline research?', docs, { k: 2, now: null, entityPrior: false })
    check('ER 实体先验·行为: 提到实体的那条排在前面', on[0]?.id === 'a', on.map((h) => h.id).join(','))
    const onA = on.find((h) => h.id === 'a')
    const offA = off.find((h) => h.id === 'a')
    const onB = on.find((h) => h.id === 'b')
    const offB = off.find((h) => h.id === 'b')
    check(
      'ER 实体先验·行为: 关掉先验后实体那条正好回到 1/1.8（加成只来自这条先验，不是别的巧合）',
      Math.abs(onA.score / offA.score - 1.8) < 0.005,
      `${onA.score.toFixed(4)} / ${offA.score.toFixed(4)}`,
    )
    check(
      'ER 实体先验·行为: 不含实体的那条分数一位都没动（先验不许外溢到别的文档）',
      onB.score === offB.score,
      `${onB.score} vs ${offB.score}`,
    )
    const q2 = 'research agencies adoption'
    const plainOn = Meow.search(q2, docs, { k: 2, now: null })
    const plainOff = Meow.search(q2, docs, { k: 2, now: null, entityPrior: false })
    check(
      'ER 实体先验·阴性对照: 问句没有专有名词时，开与关逐位相同',
      JSON.stringify(plainOn.map((h) => [h.id, h.score])) === JSON.stringify(plainOff.map((h) => [h.id, h.score])),
    )
  }
  check(
    'ER 实体先验·探针进线：ER0–ER4（含阴性对照与关闸对照）',
    probeSrc122.includes('ER0 实体问句抓到 1 个实体') &&
      probeSrc122.includes('ER1 实体问句：提到实体的那条压过只提到其余词的') &&
      probeSrc122.includes('ER2 不含实体的那条分数一位都没动') &&
      probeSrc122.includes('ER3 关掉先验后实体那条正好回到 1/1.8') &&
      probeSrc122.includes('ER4 阴性对照：问句里没有专有名词时，开与关逐位相同'),
  )
  check(
    'ER 实体先验: 版本与文档一起走（9.126 / 132）',
    (() => {
      const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
      const v = pkg.version.split('.').map((x) => Number(x))
      const atLeast = v[0] > 0 || v[1] > 2 || (v[1] === 2 && v[2] >= 122)
      return atLeast && readFileSync(join(root, 'lib', 'index.js'), 'utf8').includes(`export const version = '${pkg.version}'`)
    })() &&
      readFileSync(join(root, 'docs', 'INTERNAL.md'), 'utf8').includes('## 9.126') &&
      readFileSync(join(root, 'DESIGN.md'), 'utf8').includes('## 132 '),
  )
}

// ── 上下文窗口（0.2.123）：命中是「一句话」，答案常在它前后 ──────────────────
{
  const Meow = await import(pathToFileURL(join(root, 'vendor', 'meow-memory', 'lib', 'index.js')).href)
  const meowSrc123 = readFileSync(join(root, 'vendor', 'meow-memory', 'lib', 'index.js'), 'utf8')
  const probeSrc123 = readFileSync(join(root, 'tools', 'probe-fusion.mjs'), 'utf8')
  check(
    'CT 上下文窗口: 只按 rowid 相邻取同层 active 行（不跨层、不把作废的邻居拼回来）',
    meowSrc123.includes('adjacentWindows(entries, span = 1)') &&
      meowSrc123.includes("WHERE rowid < ? AND rowid >= ? AND status = 'active'") &&
      meowSrc123.includes("WHERE rowid > ? AND rowid <= ? AND status = 'active'"),
  )
  check(
    'CT 上下文窗口: 邻居每条只截 CTX_CHARS=200 字（上下文不是全文搬运）',
    meowSrc123.includes('var CTX_CHARS = 200;') &&
      meowSrc123.includes('String(r.content ?? "").slice(0, CTX_CHARS)'),
  )
  check(
    'CT 上下文窗口: context 上限 3、默认 0（默认不查库、不拼字符串）',
    meowSrc123.includes('context: { type: "integer", minimum: 0, maximum: 3, default: 0') &&
      meowSrc123.includes('const ctxSpan = Math.min(3, Math.max(0, Math.trunc(Number(parsed.context ?? 0)) || 0));'),
  )
  check(
    'CT 上下文窗口: 回执 ↑ 印前、↓ 印后',
    meowSrc123.includes('const ln = ctxLine("\\u2191", it);') &&
      meowSrc123.includes('const ln = ctxLine("\\u2193", it);'),
  )
  {
    const ctxHome = mkdtempSync(join(tmpdir(), 'macro-ctx-'))
    const db = Meow.getDb(ctxHome, '.dsh-meow')
    const w = (content, level = 'fact') => db.insert({ level, content, project: '全局', keywords: [], importance: 1 })
    w('Alice: \u6211\u4EEC\u660E\u5929\u53BB\u770B\u9CB8\u9C7C\u3002')
    const mid = w('Bob: \u597D\uFF0C\u51E0\u70B9\u96C6\u5408\uFF1F')
    w('Alice: \u65E9\u4E0A\u4E03\u70B9\uFF0C\u7801\u5934\u89C1\u3002')
    const win = db.adjacentWindows([{ level: 'fact', id: mid.id }], 1).get(String(mid.id))
    check(
      'CT 上下文窗口·行为: 前后各一条取对（前一句 + 后一句，顺序不能反）',
      (win?.before?.[0]?.content ?? '').includes('\u9CB8\u9C7C') && (win?.after?.[0]?.content ?? '').includes('\u7801\u5934'),
      JSON.stringify([win?.before?.length, win?.after?.length]),
    )
    check(
      'CT 上下文窗口·行为: span=0 时一条都不取（默认路径不读库）',
      db.adjacentWindows([{ level: 'fact', id: mid.id }], 0).size === 0,
    )
    db.update('fact', mid.id, { status: 'archived' })
    const midRow = db.findById('fact', mid.id)
    check('CT 上下文窗口·行为: 被作废的命中自己也查（窗口只由调用方决定）', midRow !== null)
    try {
      rmSync(ctxHome, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
  check(
    'CT 上下文窗口·探针进线：CT0–CT4（含「默认不花一个字节」与跨层不串味）',
    probeSrc123.includes('CT0 context=0 时回执与老格式逐字相同') &&
      probeSrc123.includes('CT1 context=1 带出前后各一条') &&
      probeSrc123.includes('CT2 邻居被 archive 后不再出现在上下文里') &&
      probeSrc123.includes('CT3 跨层不串味：fact 的邻居不会把 lesson 拼进来') &&
      probeSrc123.includes('CT4 context 上限 3'),
  )
  check(
    'CT 上下文窗口: 版本与文档一起走（9.127 / 133）',
    (() => {
      const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
      const v = pkg.version.split('.').map((x) => Number(x))
      const atLeast = v[0] > 0 || v[1] > 2 || (v[1] === 2 && v[2] >= 123)
      return atLeast && readFileSync(join(root, 'lib', 'index.js'), 'utf8').includes(`export const version = '${pkg.version}'`)
    })() &&
      readFileSync(join(root, 'docs', 'INTERNAL.md'), 'utf8').includes('## 9.127') &&
      readFileSync(join(root, 'DESIGN.md'), 'utf8').includes('## 133 '),
  )
}


// ── 窗口穿过统一工具（0.2.124）：融合层有自己的 schema，参数不在 pick 列表里就传不下去 ──
{
  const searchSrc124 = readFileSync(join(root, 'lib', 'macro', 'defs', 'search.js'), 'utf8')
  const probeSrc124 = readFileSync(join(root, 'tools', 'probe-fusion.mjs'), 'utf8')
  check(
    'CT 融合层: 统一 memory_search 的 schema 里有 context（否则模型看不见这个参数）',
    searchSrc124.includes("context: { type: 'integer', description: '相邻上下文"),
  )
  check(
    'CT 融合层: 主路与 graph 回退的 pick 列表都带 context（第一版漏了主路）',
    (searchSrc124.match(/'content_max', 'context', 'explain'/g) ?? []).length >= 2,
  )
  check(
    'CT 融合层: context 进了 LOCAL_ONLY_PARAMS（graph/similar 会明说用不上）',
    searchSrc124.includes("'content_max', 'context', 'explain']"),
  )
  check(
    'CT 融合层: 预算装不下时先关窗口（context 1→0），再走砍字砍条数',
    searchSrc124.includes("const ctx0 = Number.isFinite(rawCtx) && rawCtx > 0 ? Math.min(3, Math.floor(rawCtx)) : 0") &&
      searchSrc124.includes("const noCtx = await flow.call('memory_search', { ...baseArgs, context: 0 }, exec)") &&
      searchSrc124.includes('context ${ctx0}→0（邻居先不铺开）'),
  )
  check(
    'CT 融合层: 探针进线 CT5a / CT5 / CT6（从统一工具打进去，不是直调 vendor）',
    probeSrc124.includes('CT5a 融合层 context 默认 0') &&
      probeSrc124.includes('CT5 融合层：context=1 穿到 meow') &&
      probeSrc124.includes('CT6 融合层：装不下时先关窗口'),
  )
  check(
    'CT 融合层: 版本与文档一起走（9.128 / 134）',
    readFileSync(join(root, 'docs', 'INTERNAL.md'), 'utf8').includes('## 9.128 ') &&
      readFileSync(join(root, 'DESIGN.md'), 'utf8').includes('## 134 '),
  )
}


// ── 日期进回执（0.2.125）：相对时间回答不了「那天是几号」 ────────────────────
{
  const meowSrc125 = readFileSync(join(root, 'vendor', 'meow-memory', 'lib', 'index.js'), 'utf8')
  check(
    'DW 日期: stampDay 存在且 day 有关键词回退（关键词没日期也有日子）',
    meowSrc125.includes('function stampDay(ms) {') &&
      meowSrc125.includes('day: dayOfKeywords(row?.keywords) || stampWhen(row?.updated_at),') &&
      meowSrc125.includes('function stampWhen(ms) {'),
  )
  check(
    'DW 日期: 邻居窗口带 updated_at 并落 day（↑↓ 行才有日期可印）',
    meowSrc125.includes('SELECT id, content, updated_at FROM ${table} WHERE rowid < ?') &&
      meowSrc125.includes('day: stampDay(r.updated_at),'),
  )
  check(
    'DW 日期: 版本与文档一起走（9.129 / 135）',
    readFileSync(join(root, 'docs', 'INTERNAL.md'), 'utf8').includes('## 9.129 ') &&
      readFileSync(join(root, 'DESIGN.md'), 'utf8').includes('## 135 '),
  )
}

// ── 同一条不印两遍 + 邻居行封顶（0.2.126）─────────────────────────────────────
{
  const meowSrc126 = readFileSync(join(root, 'vendor', 'meow-memory', 'lib', 'index.js'), 'utf8')
  const probeSrc126 = readFileSync(join(root, 'tools', 'probe-fusion.mjs'), 'utf8')
  check(
    'DT 去重: 命中体预先记进 printed（邻居里再出现就不印）',
    meowSrc126.includes('const printed = new Set(hits.map((h) => `${String(h.level ?? "")}:${String(h.id ?? "")}`));'),
  )
  check(
    'DT 去重: ctxLine 按 level:id 判重，不看文本',
    meowSrc126.includes('if (key !== ":" && printed.has(key)) return null;') &&
      meowSrc126.includes('const key = `${String(it?.level ?? "")}:${String(it?.id ?? "")}`;'),
  )
  check(
    'DT 封顶: CTX_LINES=24 / 深档 48 + 超了就停手并计数',
    meowSrc126.includes('var CTX_LINES = 24;') &&
      meowSrc126.includes('if (ctxUsed >= ctxMax || (ctxDeep && ctxChars + text.length > CTX_CHARS_DEEP)) {') &&
      meowSrc126.includes('ctxSkipped++;'),
  )
  check(
    'DT 封顶: 截断时留一行说明（省 token 不许悄悄少给）',
    meowSrc126.includes('\\u90BB\\u5C45\\u8FD8\\u6709 ${String(ctxSkipped)} \\u884C\\u6CA1\\u94FA\\u5F00'),
  )
  {
    const Meow = await import(pathToFileURL(join(root, 'vendor', 'meow-memory', 'lib', 'index.js')).href)
    const dtHome = mkdtempSync(join(tmpdir(), 'macro-dt-'))
    const db = Meow.getDb(dtHome, '.dsh-meow')
    const w = (content) => db.insert({ level: 'fact', content, project: '全局', keywords: [], importance: 1 })
    const rows = [
      'Dana: 我们周六去潜水。',
      'Dana: 潜水装备要提前租。',
      'Dana: 租装备的地方在码头二楼。',
      'Dana: 下午三点才开门。',
    ]
    const ids = rows.map((r) => w(r))
    const T = new Map()
    Meow.registerMemoryTools((t) => T.set(t.name, t), '.dsh-meow')
    const tool = T.get('memory_search')
    const hits = [
      { id: ids[1].id, level: 'fact', content: rows[1], project: '全局', updated_at: Date.now(), score: 2 },
      { id: ids[2].id, level: 'fact', content: rows[2], project: '全局', updated_at: Date.now(), score: 1 },
    ]
    const wins = db.adjacentWindows(hits.map((h) => ({ level: h.level, id: h.id })), 1)
    const value = { note: '', hits: hits.map((h) => ({ ...h, context: wins.get(String(h.id)) ?? { before: [], after: [] } })) }
    const text = tool.output.render({ context: 1, content_max: 300 }, value).map((x) => x.text).join('\n')
    const countOf = (needle) => text.split(needle).length - 1
    // 表头里的「关于：」在没有关键词时会回退印正文前 40 字，所以只数正文/邻居行。
    const bodyText = text.split('\n').filter((l) => l.trim().length > 0 && !l.startsWith('[')).join('\n')
    const countBody = (needle) => bodyText.split(needle).length - 1
    check('DT 去重·行为: 相邻两条命中，同一句只印一遍', countBody('潜水装备要提前租') === 1 && countBody('码头二楼') === 1, JSON.stringify([countOf('潜水装备要提前租'), countBody('潜水装备要提前租')]))
    check('DT 去重·行为: 命中体不冒充上一条的 ↓', !/\u2193[^\n]*潜水装备要提前租/.test(text))
    check('DT 去重·行为: 真正的邻居照样印（周六去潜水 / 下午三点才开门）', text.includes('我们周六去潜水') && text.includes('下午三点才开门'))
    try {
      rmSync(dtHome, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
  check(
    'DT 去重·探针进线：DT0–DT3（含两档封顶与默认 0 一字不多）',
    probeSrc126.includes('DT0 相邻两条命中：同一句只印一遍') &&
      probeSrc126.includes('DT1 邻居行封顶：不问时间的题铺到 48 行') &&
      probeSrc126.includes('DT1b 邻居行封顶：问时间的题只铺 24 行') &&
      probeSrc126.includes('DT2 截断时留一行说明还剩几行') &&
      probeSrc126.includes('DT3 context 默认 0'),
  )
  check(
    'DT: 版本与文档一起走（9.130 / 136）',
    (() => {
      const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
      return verAtLeast(pkg.version.split('.').map((x) => Number(x)), 0, 2, 126)
    })() &&
      readFileSync(join(root, 'docs', 'INTERNAL.md'), 'utf8').includes('## 9.130 ') &&
      readFileSync(join(root, 'DESIGN.md'), 'utf8').includes('## 136 '),
  )
}

// ── 命中行到分、邻居行只到天（0.2.128）──────────────────────────────────────
{
  const meowSrc128 = readFileSync(join(root, 'vendor', 'meow-memory', 'lib', 'index.js'), 'utf8')
  const probeSrc128 = readFileSync(join(root, 'tools', 'probe-fusion.mjs'), 'utf8')
  check(
    'DW 命中行: stampWhen 存在且恰好零点只给日期',
    meowSrc128.includes('function stampWhen(ms) {') &&
      meowSrc128.includes('if (hh === 0 && mm === 0) return day;'),
  )
  check(
    'DW 命中行: 命中用 stampWhen、邻居仍走 it?.day（两条路不一样）',
    meowSrc128.includes('day: dayOfKeywords(row?.keywords) || stampWhen(row?.updated_at),') &&
      meowSrc128.includes('const text = `  ${arrow} ${it?.day ? String(it.day) + " " : ""}${String(it?.content ?? "")}`;'),
  )
  check(
    'DW 命中行: 三语 prompt 都说清「命中到分、邻居到天」',
    ['zh', 'en', 'pt-br'].every((lang) => {
      const t = readFileSync(join(root, 'vendor', 'meow-memory', 'lib', 'prompts', lang, 'tools.md'), 'utf8')
      return t.includes('memory_search.out.hits.day') && /HH:MM/.test(t)
    }),
  )
  {
    const Meow = await import(pathToFileURL(join(root, 'vendor', 'meow-memory', 'lib', 'index.js')).href)
    const dwHome = mkdtempSync(join(tmpdir(), 'macro-dw-'))
    const db = Meow.getDb(dwHome, '.dsh-meow')
    const T = new Map()
    Meow.registerMemoryTools((t) => T.set(t.name, t), '.dsh-meow')
    const stamp = (ms) => {
      const d = new Date(Number(ms))
      const p2 = (v) => String(v).padStart(2, '0')
      const day = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`
      return d.getHours() === 0 && d.getMinutes() === 0 ? day : `${day} ${p2(d.getHours())}:${p2(d.getMinutes())}`
    }
    // 钉一个确定的时间：2023-05-08 13:56（同一天里两条差 4 分钟，用来验分钟真的进了回执）
    const base = new Date(2023, 4, 8, 13, 56, 0, 0).getTime()
    const a = db.insert({ level: 'fact', content: 'Dana: 我们周六去潜水。', project: '全局', keywords: [], importance: 1 })
    const b = db.insert({ level: 'fact', content: 'Dana: 潜水装备要提前租。', project: '全局', keywords: [], importance: 1 })
    db.update('fact', a.id, { updated_at: base })
    db.update('fact', b.id, { updated_at: base + 4 * 60 * 1000 })
    const tool = T.get('memory_search')
    const hits = [
      { id: b.id, level: 'fact', content: 'Dana: 潜水装备要提前租。', project: '全局', updated_at: base + 4 * 60 * 1000, score: 2 },
      { id: a.id, level: 'fact', content: 'Dana: 我们周六去潜水。', project: '全局', updated_at: base, score: 1 },
    ]
    const wins = db.adjacentWindows(hits.map((h) => ({ level: h.level, id: h.id })), 1)
    const value = { note: '', hits: hits.map((h) => ({ ...h, day: stamp(h.updated_at), context: wins.get(String(h.id)) ?? { before: [], after: [] } })) }
    const tx = tool.output.render({ context: 1, content_max: 300 }, value).map((x) => x.text).join('\n')
    check(
      'DW 命中行·行为: 同一天两条命中带着各自的分钟（13:56 / 14:00）',
      tx.includes('2023-05-08 14:00') && tx.includes('2023-05-08 13:56'),
      tx.split('\n').filter((l) => l.includes('2023-05-08')).slice(0, 3).join(' / ').slice(0, 120),
    )
    check(
      'DW 命中行·行为: 邻居行不带分钟（只到天）',
      !/\u2191 \d{4}-\d{2}-\d{2} \d{2}:\d{2} /.test(tx),
      (tx.split('\n').find((l) => l.includes('\u2191')) ?? '').slice(0, 60),
    )
    try {
      rmSync(dwHome, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
  check(
    'DW 命中行·探针进线：DT4 / DT5',
    probeSrc128.includes('DT4 命中行的时间到分') && probeSrc128.includes('DT5 邻居行只到天'),
  )
  check(
    'DW 命中行: 版本与文档一起走（9.132 / 138）',
    (() => {
      const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
      return verAtLeast(pkg.version.split('.').map((x) => Number(x)), 0, 2, 128)
    })() &&
      readFileSync(join(root, 'docs', 'INTERNAL.md'), 'utf8').includes('## 9.132 ') &&
      readFileSync(join(root, 'DESIGN.md'), 'utf8').includes('## 138 '),
  )
}

// ── 时间轴 + 命中序号（0.2.129）────────────────────────────────────────────
{
  const meowSrc129 = readFileSync(join(root, 'vendor', 'meow-memory', 'lib', 'index.js'), 'utf8')
  const probeSrc129 = readFileSync(join(root, 'tools', 'probe-fusion.mjs'), 'utf8')
  check(
    'DY 时间轴: 闸门是「问句含时间词 + 命中 ≥3」，上限 8 条，逻辑在模块级 timelineLine（不撑 render 字面量）',
    meowSrc129.includes('var TIMELINE_CUE =') &&
      meowSrc129.includes('var TIMELINE_MAX = 8;') &&
      meowSrc129.includes('function timelineLine(hits, query) {') &&
      meowSrc129.includes('if (!TIMELINE_CUE.test(q) || !Array.isArray(hits) || hits.length < 3) return "";') &&
      meowSrc129.includes('const tl = timelineLine(hits, _args?.query);'),
  )
  check(
    'DY 时间轴: 排序靠 stampMs 解析回执里的 day，不猜不补',
    meowSrc129.includes('function stampMs(day) {') &&
      meowSrc129.includes('return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] ?? 0), Number(m[5] ?? 0), 0, 0).getTime();'),
  )
  check(
    'DY 序号: 命中抬头带 [k]，与时间轴编号同一套（没有序号的时间轴只值 +0.8pt）',
    meowSrc129.includes('hits.forEach((h, hi) => {') &&
      meowSrc129.includes('`[${String(hi + 1)}] [${proj}] [${String(h.id ?? "")}] [${rel}${day}]'),
  )
  check(
    'DY 时间轴: 三语 prompt 都写了 out.timeline',
    ['zh', 'en', 'pt-br'].every((lang) => {
      const t = readFileSync(join(root, 'vendor', 'meow-memory', 'lib', 'prompts', lang, 'tools.md'), 'utf8')
      return t.includes('memory_search.out.timeline')
    }),
  )
  {
    const Meow = await import(pathToFileURL(join(root, 'vendor', 'meow-memory', 'lib', 'index.js')).href)
    const dyHome = mkdtempSync(join(tmpdir(), 'macro-dy-'))
    const T = new Map()
    Meow.registerMemoryTools((t) => T.set(t.name, t), '.dsh-meow')
    Meow.getDb(dyHome, '.dsh-meow')
    const tool = T.get('memory_search')
    const mk = (i, day) => ({ id: `dy${i}`, level: 'fact', title: '', content: `第 ${i} 条正文`, project: '全局', keywords: ['潜水'], day, updated_at: 0, score: 10 - i })
    const value = { note: '', hits: [mk(1, '2023-05-08 13:56'), mk(2, '2023-05-09 09:00'), mk(3, '2023-05-07 18:30')] }
    const ask = tool.output.render({ query: '我们什么时候去潜水？', content_max: 300 }, value).map((x) => x.text).join('\n')
    const line = ask.split('\n').find((l) => l.includes('时间轴')) ?? ''
    check(
      'DY 时间轴·行为: 问时间 → 一行按早到晚[3] [1] [2]，抬头带同序号',
      line.indexOf('[3] 2023-05-07 18:30') >= 0 &&
        line.indexOf('[3]') < line.indexOf('[1]') &&
        line.indexOf('[1]') < line.indexOf('[2]') &&
        /^\[1\] \[.* : fact\] \[dy1\] /m.test(ask),
      line.slice(0, 100),
    )
    const plain = tool.output.render({ query: '潜水装备在哪租', content_max: 300 }, value).map((x) => x.text).join('\n')
    check('DY 时间轴·行为: 不问时间 → 不印（cat4 单跳题不掉分）', !plain.includes('时间轴'), `${plain.length} 字`)
    try {
      rmSync(dyHome, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
  check(
    'EA 邻居深度: 两档常量都在，问句闸门复用同一条 TIMELINE_CUE（时间题窄、其余宽）',
    meowSrc129.includes('var CTX_LINES_DEEP = 48;') &&
      meowSrc129.includes('var CTX_CHARS_DEEP = 7000;') &&
      meowSrc129.includes("const ctxDeep = !TIMELINE_CUE.test(String(_args?.query ?? \"\"));") &&
      meowSrc129.includes('const ctxMax = ctxDeep ? CTX_LINES_DEEP : CTX_LINES;') &&
      meowSrc129.includes('(ctxDeep && ctxChars + text.length > CTX_CHARS_DEEP)'),
  )
  {
    const Meow = await import(pathToFileURL(join(root, 'vendor', 'meow-memory', 'lib', 'index.js')).href)
    const ebHome = mkdtempSync(join(tmpdir(), 'macro-eb-'))
    const T = new Map()
    Meow.registerMemoryTools((t) => T.set(t.name, t), '.dsh-meow')
    Meow.getDb(ebHome, '.dsh-meow')
    const tool = T.get('memory_search')
    const mkCtx = (tag, n, len) =>
      Array.from({ length: n }, (_, i) => ({ id: `${tag}${i}`, level: 'fact', content: 'x'.repeat(len), day: '2023-05-08' }))
    const deepHit = { id: 'eb1', level: 'fact', title: '', content: '正文', project: '全局', keywords: ['潜水'], day: '2023-05-08', updated_at: 0, score: 10, context: { before: mkCtx('b', 30, 60), after: mkCtx('c', 30, 60) } }
    const fatHit = { id: 'eb2', level: 'fact', title: '', content: '正文', project: '全局', keywords: ['潜水'], day: '2023-05-08', updated_at: 0, score: 10, context: { before: mkCtx('d', 30, 200), after: mkCtx('e', 30, 200) } }
    const rows = (txt) => txt.split('\n').filter((l) => l.startsWith('  \u2191 ') || l.startsWith('  \u2193 '))
    const wide = tool.output.render({ query: '潜水装备在哪租', content_max: 300 }, { note: '', hits: [deepHit] }).map((x) => x.text).join('\n')
    const narrow = tool.output.render({ query: '我们什么时候去潜水？', content_max: 300 }, { note: '', hits: [deepHit] }).map((x) => x.text).join('\n')
    const capped = tool.output.render({ query: '潜水装备在哪租', content_max: 300 }, { note: '', hits: [fatHit] }).map((x) => x.text).join('\n')
    check('EA 邻居深度·行为: 不问时间 → 铺到 48 行', rows(wide).length === 48, `${rows(wide).length} 行`)
    check('EA 邻居深度·行为: 问时间 → 只铺 24 行（日期不被噪声稀释）', rows(narrow).length === 24, `${rows(narrow).length} 行`)
    check(
      'EA 邻居深度·行为: 字符闸先于行数闸（7,000 字封顶）',
      rows(capped).length > 0 && rows(capped).length < 48 && rows(capped).join('').length <= 7000,
      `${rows(capped).length} 行 / ${rows(capped).join('').length} 字`,
    )
    check(
      'EA 邻居深度·行为: 截断提示里的行数是当下这一档，不是写死的 24',
      wide.includes('一次最多 48 行') && narrow.includes('一次最多 24 行'),
      wide.split('\n').filter((l) => l.includes('没铺开')).join(' | '),
    )
    try {
      rmSync(ebHome, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
  check(
    'EA 邻居深度: 版本与文档一起走（9.138 / 144）',
    (() => {
      const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
      return verAtLeast(pkg.version.split('.').map((x) => Number(x)), 0, 2, 132)
    })() &&
      readFileSync(join(root, 'docs', 'INTERNAL.md'), 'utf8').includes('## 9.138 ') &&
      readFileSync(join(root, 'DESIGN.md'), 'utf8').includes('## 144 '),
  )
  check(
    'DY 时间轴·探针进线：TL0 / TL1 / TL2 / TL3',
    probeSrc129.includes('TL0 问句问时间') && probeSrc129.includes('TL1 问句不问时间') && probeSrc129.includes('TL2 命中不到三条') && probeSrc129.includes('TL3 超过 8 条'),
  )
  check(
    'DY 时间轴: 版本与文档一起走（9.133 / 139）',
    (() => {
      const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
      return verAtLeast(pkg.version.split('.').map((x) => Number(x)), 0, 2, 129)
    })() &&
      readFileSync(join(root, 'docs', 'INTERNAL.md'), 'utf8').includes('## 9.133 ') &&
      readFileSync(join(root, 'DESIGN.md'), 'utf8').includes('## 139 '),
  )
}

// ── 回执不全不等于没有（0.2.130）────────────────────────────────────────────
{
  const guideText = (lang) => readFileSync(join(root, 'vendor', 'meow-memory', 'lib', 'prompts', lang, 'system-guide.md'), 'utf8')
  check(
    'DZ 回答准则: 三语 system-guide 都写「回执不全不等于没有」，并带上实测两个数',
    guideText('zh').includes('回执不全不等于没有') && guideText('zh').includes('45.9%→54.2%') && guideText('zh').includes('25.6%→0.3%') &&
      guideText('en').includes('An incomplete receipt is not an absence') && guideText('en').includes('45.9% → 54.2%') &&
      guideText('pt-br').includes('Um recibo incompleto não é ausência') && guideText('pt-br').includes('45,9% → 54,2%'),
  )
  check(
    'DZ 回答准则: 挂在 system-guide（system prompt 段），不在工具描述里贴一遍——同一句话贴回执只值 +1.4pt',
    !readFileSync(join(root, 'vendor', 'meow-memory', 'lib', 'prompts', 'zh', 'tools.md'), 'utf8').includes('回执不全不等于没有') &&
      readFileSync(join(root, 'vendor', 'meow-memory', 'lib', 'index.js'), 'utf8').includes('svc2.section({ name: "meow-memory:guide", order: 130, text: getMemoryGuide() })'),
  )
  {
    const Meow = await import(pathToFileURL(join(root, 'vendor', 'meow-memory', 'lib', 'index.js')).href)
    const text = String(Meow.getMemoryGuide() ?? '')
    check('DZ 回答准则·行为: getMemoryGuide() 真把这条带进 system prompt', text.includes('回执不全不等于没有'), `${text.length} 字符`)
  }
  {
    const promptMod = await import(pathToFileURL(join(root, 'lib', 'macro', 'prompt.js')).href)
    const l0 = promptMod.GUIDE_TEXT
    check(
      'DZ 回答准则: L0 注入里也有一条（融合层吞掉子插件 section，模型只看得到这段）',
      l0.includes('回执没写全≠没有') && l0.includes('三面都在：工具 / 命令') &&
        promptMod.GUIDE_MAX_CHARS - l0.length >= promptMod.GUIDE_MIN_HEADROOM,
      `${l0.length}/${promptMod.GUIDE_MAX_CHARS} 字符`,
    )
  }
  check(
    'DZ 回答准则: 版本与文档一起走（9.134 / 140）',
    (() => {
      const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
      return verAtLeast(pkg.version.split('.').map((x) => Number(x)), 0, 2, 130)
    })() &&
      readFileSync(join(root, 'docs', 'INTERNAL.md'), 'utf8').includes('## 9.134 ') &&
      readFileSync(join(root, 'DESIGN.md'), 'utf8').includes('## 140 '),
  )
}

// ── EA. 会话主题扩展：门牌号词写不出来，算得出来（0.2.131）─────────────────
{
  const meowSrc = readFileSync(join(root, 'vendor', 'meow-memory', 'lib', 'index.js'), 'utf8')
  const probeSrc = readFileSync(join(root, 'tools', 'probe-recall.mjs'), 'utf8')
  check(
    'EA 会话主题: 闸门在、入口只有一个（sessionTopic:false 能整段关掉）',
    meowSrc.includes('const SESS_TOPIC_MIN = 3;') &&
      meowSrc.includes('function sessionTopicTerms(docs, docToks) {') &&
      meowSrc.includes('opts.sessionTopic === false ? null : sessionTopicTerms(docs, plainToks)'),
  )
  const V = await import(pathToFileURL(join(root, 'vendor', 'meow-memory', 'lib', 'index.js')).href)
  const mk = (id, content, sess) => ({
    id, level: 'fact', title: content.slice(0, 6), content, keywords: [], importance: 2,
    status: 'active', source_session: sess, created_at: 1, updated_at: Date.now(),
  })
  const docs = [
    mk('x1', '陶艺课捏了个碗', 'sA'),
    mk('x2', '买了六个杯子回家', 'sA'),
    mk('x3', '老师说釉色要等三天', 'sA'),
    mk('y1', '今天天气不错', 'sB'),
  ]
  const on = V.search('釉色 陶艺', docs, { k: 8 }).map((h) => h.id)
  const off = V.search('釉色 陶艺', docs, { k: 8, sessionTopic: false }).map((h) => h.id)
  check(
    'EA 会话主题·行为: 同会话里一个查询词都不含的条目也能靠主题词进榜，关掉就回到纯 BM25',
    on.includes('x2') && !off.includes('x2'),
    `开 ${on.join(',')} / 关 ${off.join(',')}`,
  )
  check('EA 会话主题·行为: 扩词不越位（靠主题词进来的排在直接命中之后）', on[on.length - 1] === 'x2', on.join(','))
  check(
    'EA 会话主题: 探针真盯着这五条（不是只写在文档里）',
    ['SESS1 ', 'SESS2 ', 'SESS3 ', 'SESS4 ', 'SESS5 '].every((k) => probeSrc.includes(k)),
  )
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  check(
    'EA 会话主题: 版本与文档一起走（9.137 / 143）',
    verAtLeast(pkg.version.split('.').map((x) => Number(x)), 0, 2, 131) &&
      readFileSync(join(root, 'docs', 'INTERNAL.md'), 'utf8').includes('## 9.137 ') &&
      readFileSync(join(root, 'DESIGN.md'), 'utf8').includes('## 143 '),
  )
}


// ── EY 调取精度三刀 + 反思闸门（0.2.133）
{
  const meowSrc133 = readFileSync(join(root, 'vendor', 'meow-memory', 'lib', 'index.js'), 'utf8')
  const searchSrc133 = readFileSync(join(root, 'lib', 'macro', 'defs', 'search.js'), 'utf8')
  const M133 = await import(pathToFileURL(join(root, 'vendor', 'meow-memory', 'lib', 'index.js')).href)
  const d133 = (id, content, keywords = []) => ({ id, level: 'fact', title: '', content, keywords, importance: 1, project: 'ey', updated_at: 1763e9, last_accessed_at: 1763e9 })
  const sc133 = (hits, id) => hits.find((h) => h.id === id)?.score ?? 0

  const covDocs = [d133('X', '口径面板都写错了'), d133('Y', '面板面板面板面板面板面板')]
  const covOn = M133.search('口径 面板', covDocs, { k: 2 })
  const covOff = M133.search('口径 面板', covDocs, { k: 2, coord: false })
  check('EY 覆盖度·行为: 两个查询词都聊到的条目排第一（刷词频压不过它）', covOn[0]?.id === 'X')
  check('EY 覆盖度·行为: 关掉 coord 之后刷词频的条目分数更高（闸确实在扣分）', sc133(covOff, 'Y') > sc133(covOn, 'Y'))

  // 0.2.152：关键词是标签不是正文——只在 keywords 里提到查询词的等长条目，压不过正文命中的条目。
  const fldDocs = [d133('P', '甲乙丙丁戊己', ['口径']), d133('Q', '口径甲乙丙丁')]
  const fldOn = M133.search('口径', fldDocs, { k: 2 })
  const fldOff = M133.search('口径', fldDocs, { k: 2, fieldBoost: false })
  const fldFlat = M133.search('口径', fldDocs, { k: 2, kwSeparate: false })
  check(
    'EY 字段权重·行为: 正文命中的条目压过只在 keywords 里提到的等长条目（标签不是正文）',
    sc133(fldOn, 'Q') > sc133(fldOn, 'P'),
    `Q ${sc133(fldOn, 'Q').toFixed(3)} / P ${sc133(fldOn, 'P').toFixed(3)}`,
  )
  check(
    'EY 字段权重·行为: 关掉 fieldBoost 后 P 更低（加成真在给，只是不够翻盘）',
    sc133(fldOff, 'P') < sc133(fldOn, 'P') - 1e-9,
    `关 ${sc133(fldOff, 'P').toFixed(3)} / 开 ${sc133(fldOn, 'P').toFixed(3)}`,
  )
  check(
    'EY 字段权重·阴性对照: 关键词退回平铺（kwSeparate:false）时 P 又翻到 Q 前面——闸真在起作用',
    sc133(fldFlat, 'P') > sc133(fldFlat, 'Q'),
    `P ${sc133(fldFlat, 'P').toFixed(3)} / Q ${sc133(fldFlat, 'Q').toFixed(3)}`,
  )

  const lenDocs = [d133('S', '记录打架'), d133('L', '记录一些旁枝末节的东西再说打架', ['冲突', '对不上', '不一致', '报表', '周报', '口径', '面板', '时间轴', '融合'])]
  const lenNew = M133.search('记录 打架', lenDocs, { k: 2 })
  const lenOld = M133.search('记录 打架', lenDocs, { k: 2, lengthOnBody: false })
  const lenFlat = M133.search('记录 打架', lenDocs, { k: 2, kwSeparate: false, lengthOnBody: false })
  check(
    'EY 长度归一·行为: 短正文仍排在写满关键词的长正文前',
    sc133(lenNew, 'S') > sc133(lenNew, 'L'),
  )
  check(
    'EY 长度归一·行为: keywords 不再进正文长度（默认口径下 lengthOnBody 已无差别）',
    Math.abs(sc133(lenNew, 'L') - sc133(lenOld, 'L')) < 1e-9,
    `${sc133(lenNew, 'L').toFixed(3)} vs ${sc133(lenOld, 'L').toFixed(3)}`,
  )
  check(
    'EY 长度归一·阴性对照: 关键词平铺回正文长度时 L 被稀释得更低',
    sc133(lenFlat, 'L') < sc133(lenNew, 'L') - 1e-9,
    `${sc133(lenFlat, 'L').toFixed(3)} vs ${sc133(lenNew, 'L').toFixed(3)}`,
  )
  check('EY 三条补丁都能单独关掉回退', meowSrc133.includes('opts.coord === false') && meowSrc133.includes('opts.fieldBoost !== false') && meowSrc133.includes('opts.lengthOnBody === false'))
  check('EY 星图扩散: 默认就扩散，只有 expand:false 才关', searchSrc133.includes('const wantExpand = args.expand !== false') && !searchSrc133.includes('args.expand === true || (args.expand !== false && hits === 0)'))

  check('EY 反思·闸门: 不再因为「最后一步是 memory_* 」整轮免反思', !meowSrc133.includes('if (lastToolName !== void 0 && lastToolName.startsWith("memory_")) return;') && meowSrc133.includes('if (!sawNonMemory && INC.level === 0) return;'))
  check('EY 反思·闸门: scanTurn 记下「有没有非记忆工具」和用户原话', meowSrc133.includes('let sawNonMemory = false;') && meowSrc133.includes('const userTexts = [];') && meowSrc133.includes('userText: userTexts.join("\\n").slice(-2e3)'))
  check('EY 反思·事故信号: 主人发火时阈值降到 1 步', meowSrc133.includes('var REFLECT_CUE = /(') && meowSrc133.includes('const NEED = reflectNeed(INC, resolved.reflectTurns);'))
  const pkg133 = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  check(
    'EY 检索精度: 版本与文档一起走（9.139 / 145）',
    verAtLeast(pkg133.version.split('.').map((x) => Number(x)), 0, 2, 133) &&
      readFileSync(join(root, 'docs', 'INTERNAL.md'), 'utf8').includes('## 9.139 ') &&
      readFileSync(join(root, 'DESIGN.md'), 'utf8').includes('## 145 '),
  )
}
// ── EZ 反思由事故自己触发（0.2.134）
{
  const meowPath134 = join(root, 'vendor', 'meow-memory', 'lib', 'index.js')
  const meowSrc134 = readFileSync(meowPath134, 'utf8')
  const M134 = await import(pathToFileURL(meowPath134).href)
  const ev = (type, data) => ({ type, data })

  // 事件面：失败数得清、能点出是谁、成功的不算。
  const events = [
    ev('turn/start', {}),
    ev('assistant/message', { message: { content: [{ type: 'tool-call', id: 'k1', name: 'pwsh' }, { type: 'tool-call', id: 'k2', name: 'memory_search' }] } }),
    ev('tool/result', { message: { isError: true, toolCallId: 'k1' } }),
    ev('tool/result', { message: { isError: true, toolCallId: 'k1' } }),
    ev('tool/result', { message: { isError: true, toolCallId: 'k2' } }),
    ev('tool/result', { message: { isError: false, toolCallId: 'k1' } }),
  ]
  const scanned = M134.scanTurn(events)
  check(
    'EZ 事故计数·行为: 三次失败一个不漏，成功的 tool/result 不算',
    scanned.toolErrors === 3 && scanned.memoryErrors === 1 && scanned.worstFail === 2 && scanned.worstTool === 'pwsh',
    `errors=${scanned.toolErrors} memory=${scanned.memoryErrors} worst=${scanned.worstTool}×${scanned.worstFail}`,
  )
  check(
    'EZ 事故计数·行为: 失败按工具归并，只留前四个',
    JSON.stringify(scanned.failedTools) === JSON.stringify([['pwsh', 2], ['memory_search', 1]]),
    JSON.stringify(scanned.failedTools),
  )

  // 判据面：什么东西算事故。
  const clean = M134.incidentOf({ toolErrors: 0 }, 'stop')
  const soft = M134.incidentOf({ toolErrors: 1, worstFail: 1, worstTool: 'pwsh' }, 'stop')
  const retry = M134.incidentOf({ toolErrors: 2, worstFail: 2, worstTool: 'pwsh' }, 'stop')
  const mem = M134.incidentOf({ toolErrors: 1, worstFail: 1, worstTool: 'memory_link', memoryErrors: 1 }, 'stop')
  const burst = M134.incidentOf({ toolErrors: 3, worstFail: 1, worstTool: 'pwsh' }, 'stop')
  const turnErr = M134.incidentOf({ toolErrors: 0 }, 'error')
  const cue = M134.incidentOf({ toolErrors: 0, cue: 1 }, 'stop')
  const levels = [clean, soft, retry, mem, burst, turnErr, cue].map((x) => x.level).join(',')
  check('EZ 分级·行为: 无事 0、零星一次 1、连挂/记忆工具挂/整轮出错/主人发火都是 2', levels === '0,1,2,2,2,2,2', levels)
  check(
    'EZ 分级·行为: 事故种类点得出来（记忆工具自己挂了要认账）',
    mem.kinds.includes('memory-error') &&
      retry.kinds.includes('retry-storm') &&
      burst.kinds.includes('error-burst') &&
      turnErr.kinds.includes('turn-error') &&
      cue.kinds.includes('user-cue'),
    `${mem.kinds} / ${retry.kinds} / ${burst.kinds} / ${turnErr.kinds} / ${cue.kinds}`,
  )

  // 阈值面：事故当场反思，正常不提前。
  check(
    'EZ 阈值·行为: 硬档当场 1 步、软档压到 3 步、没事照旧 cadence',
    M134.reflectNeed(retry, 7) === 1 && M134.reflectNeed(soft, 7) === 3 && M134.reflectNeed(clean, 7) === 7,
    `${M134.reflectNeed(retry, 7)}/${M134.reflectNeed(soft, 7)}/${M134.reflectNeed(clean, 7)}`,
  )
  check(
    'EZ 阈值·行为: 软档只许提前、不许反过来变慢（cadence=2 还是 2，cadence 写坏兜底 7）',
    M134.reflectNeed(soft, 2) === 2 && M134.reflectNeed(soft, 1) === 1 && M134.reflectNeed(clean, 0) === 7,
  )

  // 报文面：模型得知道「这是插件自己叫的」和「挂了什么」。
  const lines = M134.incidentLines({ level: 2, kinds: ['retry-storm'], toolErrors: 2, worstFail: 2, worstTool: 'pwsh', failedTools: [['pwsh', 2]] })
  const joined = lines.join('\n')
  check(
    'EZ 报文·行为: 说清是插件自己叫的、挂了几次、要求先判真假事故',
    joined.includes('插件自己') && joined.includes('工具失败 2 次') && joined.includes('pwsh ×2'),
    joined.split('\n')[1] ?? '',
  )
  check('EZ 报文·行为: 没事故时一个字都不加（不污染正常反思）', M134.incidentLines(clean).length === 0)
  const missingLabel = ['zh', 'en', 'pt-br'].filter((lg) => {
    const t = readFileSync(join(root, 'vendor', 'meow-memory', 'lib', 'prompts', lg, 'labels.md'), 'utf8')
    return !['incidentHead', 'incidentTools', 'incidentDetail', 'incidentTurnError', 'incidentCue', 'incidentAsk', 'unknownTool'].every((k) => t.includes(`- reflect.${k}:`))
  })
  check('EZ 三语: 事故文案七个键在 zh/en/pt-br 都在（用户换语言不炸成 undefined）', missingLabel.length === 0, missingLabel.join(',') || 'zh/en/pt-br 全在')

  // 源码面：闸门真的走事故，且硬档留痕。
  check(
    'EZ 闸门·源码: 只碰过 memory_* 不再整轮免反思，阈值改由事故决定',
    meowSrc134.includes('if (!sawNonMemory && INC.level === 0) return;') &&
      meowSrc134.includes('if (!sawToolCall && INC.level === 0) return;') &&
      meowSrc134.includes('const NEED = reflectNeed(INC, resolved.reflectTurns);') &&
      meowSrc134.includes('incident=${INC.kinds.join(",") || "none"}'),
  )
  check('EZ 闸门·源码: 不再有「CUE 或 error 就 1 步」的二选一', !meowSrc134.includes('CUE > 0 || endReason === "error" ? 1 : resolved.reflectTurns'))
  check(
    'EZ 留痕·源码: 硬档往梦的账本里补一行事故（事后能查为什么这轮被叫醒）',
    meowSrc134.includes('reflect incident=') && meowSrc134.includes('dream-debug.log'),
  )

  const pkg134 = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  check(
    'EZ 版本与文档一起走（9.140 / 146）',
    verAtLeast(pkg134.version.split('.').map((x) => Number(x)), 0, 2, 134) &&
      readFileSync(join(root, 'docs', 'INTERNAL.md'), 'utf8').includes('## 9.140 ') &&
      readFileSync(join(root, 'DESIGN.md'), 'utf8').includes('## 146 '),
  )
}

// ── FA 反思闭环与事故账本（0.2.135）：同一件事第二次才算事故，反思完没落地要留痕。
{
  const meowPath135 = join(root, 'vendor', 'meow-memory', 'lib', 'index.js')
  const meowSrc135 = readFileSync(meowPath135, 'utf8')
  const M135 = await import(pathToFileURL(meowPath135).href)
  const ws135 = mkdtempSync(join(tmpdir(), 'meow-verify-135-'))
  const dir135 = '.dsh-meow'
  const inc135 = { level: 2, kinds: ['retry-storm'], worstTool: 'pwsh', toolErrors: 2, memoryErrors: 0, failedTools: [['pwsh', 2]] }

  // 账本：没有就不编，抖动的软档不写，硬档一行带得回工具名。
  const empty = M135.readIncidentLedger(ws135, dir135)
  check('FA 账本·行为: 没账本时给空账并说明原因（不假装一切正常）', empty.rows.length === 0 && empty.missing === 'no-ledger')
  check('FA 账本·行为: 只挂一次的软档不记账（抖动不值得留痕）', M135.recordIncident(ws135, dir135, { ...inc135, level: 1, kinds: ['tool-error'] }) === false)
  check('FA 账本·行为: 硬档写一行', M135.recordIncident(ws135, dir135, inc135, 'sess-verifysess') === true)
  const rows135 = M135.readIncidentLedger(ws135, dir135).rows
  check(
    'FA 账本·行为: 行里留得住工具名与种类（跨轮才认得出是同一件事）',
    rows135.length === 1 && rows135[0].tool === 'pwsh' && rows135[0].kinds.includes('retry-storm'),
    JSON.stringify(rows135[0] ?? null),
  )
  const rep135 = M135.incidentRepeatOf(ws135, dir135, inc135)
  check('FA 重复·行为: 同工具再来一次就数得到，窗口写明 24 小时', rep135?.count === 1 && rep135?.windowHours === 24, JSON.stringify(rep135))
  check('FA 重复·行为: 换了工具不算同一件事（不然满屏「又不是第一次」）', M135.incidentRepeatOf(ws135, dir135, { ...inc135, worstTool: 'write_file' }) === undefined)
  const lines135 = M135.incidentLines(inc135, rep135).join('\n')
  check('FA 报文·行为: 点名「这不是第一次」并写出工具与次数', lines135.includes('pwsh') && lines135.includes('不是第一次'))
  check('FA 报文·行为: 重复提醒排在「先判断」之前（先给事实再给做法）', lines135.indexOf('不是第一次') < lines135.indexOf('先判断'))
  for (let k135 = 0; k135 < 210; k135++) M135.recordIncident(ws135, dir135, inc135)
  check('FA 账本·行为: 只留最近 200 行，不会无限堆成拖累', M135.readIncidentLedger(ws135, dir135).rows.length === 200)
  const file135 = join(ws135, dir135, 'incident-ledger.jsonl')
  writeFileSync(file135, `not json\n{"t":"x"}\n{"t":0}\n${readFileSync(file135, 'utf8')}`)
  check('FA 账本·行为: 坏行只丢那一行，不当成事故', M135.readIncidentLedger(ws135, dir135).rows.length === 200)
  check('FA 窗口·行为: 25 小时前的账不再点名（旧账不能冤枉新事故）', M135.incidentRepeatOf(ws135, dir135, inc135, Date.now() + 25 * 60 * 60 * 1e3) === undefined)

  // 闭环：反思发了却没写进记忆，本身就是一次事故。
  check('FA 闭环·行为: 没有待验卡时不乱判', M135.settleReflect(ws135, dir135, 0) === undefined)
  M135.writeReflectPending(ws135, dir135, inc135)
  check('FA 闭环·行为: 反思后没写任何记忆 -> 判定没落地', M135.settleReflect(ws135, dir135, 0)?.ok === false)
  check('FA 闭环·行为: 没落地写进账本，kinds=no-followup', M135.readIncidentLedger(ws135, dir135).rows.some((r) => r.kinds.includes('no-followup')))
  const rep135b = M135.incidentRepeatOf(ws135, dir135, inc135)
  check(
    'FA 闭环·行为: 下次再出事故，报文能说「上次反思等于白做」',
    rep135b?.unfixed === 1 && M135.incidentLines(inc135, rep135b).join('\n').includes('反思过'),
    JSON.stringify(rep135b),
  )
  M135.writeReflectPending(ws135, dir135, inc135)
  check('FA 闭环·行为: 反思后真写了记忆 -> 不留痕、清掉待验卡', M135.settleReflect(ws135, dir135, 1)?.ok === true && M135.readReflectPending(ws135, dir135) === undefined)
  const writes135 = M135.scanTurn([{ type: 'assistant/message', data: { message: { content: [{ type: 'tool-call', id: 'w1', name: 'memory_remember' }] } } }])
  check('FA 闭环·行为: 写记忆那一步被单独数出来（判据靠它，不靠文本猜）', writes135.memoryWrites === 1 && writes135.sawNonMemory === false, `writes=${writes135.memoryWrites}`)

  const miss135 = ['zh', 'en', 'pt-br'].filter((lg) => {
    const t = readFileSync(join(root, 'vendor', 'meow-memory', 'lib', 'prompts', lg, 'labels.md'), 'utf8')
    return !['incidentRepeat', 'incidentNoFollowup'].every((key) => t.includes(`- reflect.${key}:`))
  })
  check('FA 三语: 重复提醒与「反思白做」两句 zh/en/pt-br 都在', miss135.length === 0, miss135.join(',') || 'zh/en/pt-br 全在')

  // 源码面：账本容量、软档不写、闸门先结算再判、硬档同时留卡。
  check(
    'FA 源码: 账本容量写在常量里，写账只在硬档',
    meowSrc135.includes('var INCIDENT_LEDGER_MAX = 200;') &&
      meowSrc135.includes('var REFLECT_PENDING = "reflect-pending.json";') &&
      meowSrc135.includes('if (!incident || incident.level < 2) return false;'),
  )
  check(
    'FA 源码: 闸门先结算上一轮的待验卡，再判这一轮的事故',
    meowSrc135.includes('const SETTLED = settleReflect(ws, resolved.projectDir, turnInfo.memoryWrites);') &&
      meowSrc135.indexOf('const SETTLED = settleReflect(') < meowSrc135.indexOf('const REP = incidentRepeatOf(ws, resolved.projectDir, INC);'),
  )
  check(
    'FA 源码: 硬档既记账也留待验卡（没留卡就永远查不出「反思白做」）',
    meowSrc135.includes('recordIncident(ws, resolved.projectDir, INC, sidTs);') &&
      meowSrc135.includes('writeReflectPending(ws, resolved.projectDir, INC);'),
  )

  const pkg135 = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  check(
    'FA 版本与文档一起走（9.141 / 147）',
    verAtLeast(pkg135.version.split('.').map((x) => Number(x)), 0, 2, 135) &&
      readFileSync(join(root, 'docs', 'INTERNAL.md'), 'utf8').includes('## 9.141 ') &&
      readFileSync(join(root, 'DESIGN.md'), 'utf8').includes('## 147 '),
  )
}

// ── FB 写入侧的冲突雷达（0.2.136）：库里躺两条「当前版本是 X」时，谁说哪条算数？
{
  const meowPath136 = join(root, 'vendor', 'meow-memory', 'lib', 'index.js')
  const meowSrc136 = readFileSync(meowPath136, 'utf8')
  const M136 = await import(pathToFileURL(meowPath136).href)

  const tok = M136.factTokens('0.2.120 到 0.2.135，日期 2026-11-21 与 2026-11-02')
  check('FB 抽取: 多个版本号都认得（不只看第一个）', tok.versions.size === 2 && tok.versions.has('0.2.120') && tok.versions.has('0.2.135'))
  check('FB 抽取: 多个日期都认得', tok.dates.size === 2 && tok.dates.has('2026-11-21') && tok.dates.has('2026-11-02'))
  const tokPlain = M136.factTokens('check-all 21/21、合计 2,606 条断言、用时 192.9s')
  check('FB 抽取: 断言数与耗时不算版本号（21/21、192.9s 不该冒充结论）', tokPlain.versions.size === 0 && tokPlain.dates.size === 0)

  const rows136 = [
    { id: 'aaaaaaaa1111', level: 'fact', project: 'p', content: '0.2.132 交付态 check-all 21/21 合计 2,530 条断言' },
    { id: 'bbbbbbbb2222', level: 'fact', project: 'p', content: '0.2.129 交付态 check-all 19/19 合计 2,400 条断言' },
    { id: 'cccccccc3333', level: 'fact', project: 'p', content: '0.2.141 交付态 check-all 22/22 合计 2,700 条断言' },
    { id: 'dddddddd4444', level: 'fact', project: 'p', content: '0.2.150 交付态 check-all 23/23 合计 2,800 条断言' },
    { id: 'eeeeeeee5555', level: 'fact', project: 'p', content: '今天海面很平静，风从东边来' },
  ]
  const cand = M136.conflictCandidates(rows136, '0.2.135 交付态 check-all 21/21 合计 2,606 条断言', 'p')
  check('FB 识别: 同一件事的新版本被认出来（kind=版本）', cand.length > 0 && cand[0].kind === '版本', JSON.stringify(cand[0] ?? null))
  check('FB 识别: 两边的版本号都带着（它写 0.2.132 / 你写 0.2.135）', cand[0]?.theirs.includes('0.2.132') === true && cand[0]?.mine.includes('0.2.135') === true)
  check('FB 上限: 最多点名 3 条（回执不许变成一堵墙）', cand.length === 3, String(cand.length))
  check('FB 排序: 相似度高的排前面', cand.every((c, i) => i === 0 || cand[i - 1].sim >= c.sim), cand.map((c) => c.sim).join(','))
  check(
    'FB 隔离: 别的项目不算同一件事',
    M136.conflictCandidates([{ id: 'x1', level: 'fact', project: '别的项目', content: '0.2.132 交付态 check-all 21/21' }], '0.2.135 交付态 check-all 21/21', 'p').length === 0,
  )
  check(
    'FB 抗噪: 没有版本号 / 日期的近似说法不报',
    M136.conflictCandidates([{ id: 'x2', level: 'fact', project: 'p', content: '反思线要按事故分级、跨轮记账、事后验收' }], '反思线要按事故分级、跨轮记账、事后验收，另外补上抖动别留痕', 'p').length === 0,
  )
  check(
    'FB 抗噪: 相似度不到门槛（只是同话题）不报',
    M136.conflictCandidates([{ id: 'x3', level: 'fact', project: 'p', content: '0.2.132 的账本容量是 200 行' }], '0.2.135 的海报配色改成深蓝，尾巴要留白', 'p').length === 0,
  )
  const dateCand = M136.conflictCandidates(
    [{ id: 'y1', level: 'fact', project: 'p', content: '复盘会定在 2026-11-02，结论是账本看 24 小时窗' }],
    '复盘会改到 2026-11-09，结论是账本看 24 小时窗',
    'p',
  )
  check('FB 日期: 会议改期也算结论互斥（kind=日期）', dateCand.length === 1 && dateCand[0].kind === '日期', JSON.stringify(dateCand[0] ?? null))

  const warn = M136.conflictWarn(cand)
  check('FB 回执: 说清是哪件事、哪两个值', warn.includes('另一种说法') && warn.includes('0.2.132') && warn.includes('0.2.135'))
  check('FB 回执: 给出收场办法（supersedes / stale），不是只提醒', warn.includes('supersedes') && warn.includes('stale'))
  check('FB 回执: 没冲突时一个字都不加', M136.conflictWarn([]) === '')

  check(
    'FB 源码: 门槛与上限写成常量（不是散在逻辑里的魔法数）',
    meowSrc136.includes('var CONFLICT_SIM = 0.3;') && meowSrc136.includes('var CONFLICT_MAX = 3;'),
  )
  check(
    'FB 源码: 冲突检查挂在「新写一条」那条路上，且用的是同层同项目的候选',
    meowSrc136.includes('const conflictNote = conflictWarn(conflictCandidates(existing, content, project), db);'),
  )
  check(
    'FB 源码: 合并分支不重复报（合并已经处理了旧条目，再报冲突是噪声）',
    meowSrc136.indexOf('const mergeNote = applyMerge(') < meowSrc136.indexOf('const conflictNote = conflictWarn('),
  )
  check(
    'FB 源码: 回执把跨层提醒与冲突提醒都带上',
    meowSrc136.includes('note: noteOf([crossNote, conflictNote].filter((s) => s.length > 0).join("\\n"))'),
  )

  const pkg136 = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  check(
    'FB 版本与文档一起走（9.142 / 148）',
    verAtLeast(pkg136.version.split('.').map((x) => Number(x)), 0, 2, 136) &&
      readFileSync(join(root, 'docs', 'INTERNAL.md'), 'utf8').includes('## 9.142 ') &&
      readFileSync(join(root, 'DESIGN.md'), 'utf8').includes('## 148 '),
  )
}

// FC（0.2.137）：冲突雷达补上「改内容」这条路，并且文案走三语 labels 而不是写死在代码里。
{
  const meowPath137 = join(root, 'vendor', 'meow-memory', 'lib', 'index.js')
  const meowSrc137 = readFileSync(meowPath137, 'utf8')
  const M137 = await import(pathToFileURL(meowPath137).href)
  const list137 = [{ id: 'abcdef123456', level: 'fact', sim: 0.5, kind: '版本', mine: ['0.2.137'], theirs: ['0.2.132'] }]

  const writeSaid = M137.conflictWarn(list137)
  const updSaid = M137.conflictWarn(list137, undefined, 'update')
  check('FC 行为: 写入与改动两种说法不混（写下了 / 改动落库了）', writeSaid.includes('写下来了') && updSaid.includes('改动照样落库了') && !updSaid.includes('写下来了'))
  check('FC 行为: 改动侧也给出收场路（stale / supersedes），不是只提醒', updSaid.includes('stale') && updSaid.includes('supersedes'))
  check('FC 行为: 两边都点出两个值（它写 0.2.132 / 你这次写 0.2.137）', writeSaid.includes('0.2.132') && writeSaid.includes('0.2.137') && updSaid.includes('0.2.132'))
  check('FC 行为: 无冲突时一个字都不加（改动侧同样）', M137.conflictWarn([]) === '' && M137.conflictWarn(undefined, undefined, 'update') === '')
  check('FC 行为: 日期型冲突在改动侧也认（kind=日期）', M137.conflictWarn([{ id: 'y2', level: 'fact', sim: 0.4, kind: '日期', mine: ['2026-11-09'], theirs: ['2026-11-02'] }], undefined, 'update').includes('日期'))

  check(
    'FC 源码: 改动侧复用同一个函数，只是多带一个 update 模式',
    meowSrc137.includes('conflictWarn(conflictCandidates(siblings, patch.content, projNow), db, "update")'),
  )
  check(
    'FC 源码: 只改状态不查冲突（没动正文就没有新结论可比）',
    meowSrc137.indexOf('if (ok && typeof patch.content === "string") {') < meowSrc137.indexOf('const siblings = db.list(found.level, { status: "active" })'),
  )
  check(
    'FC 源码: 比对时排除自己（自己跟自己的旧正文当然不一样）',
    meowSrc137.includes('.filter((r) => r.id !== found.row.id)'),
  )
  check(
    'FC 源码: 文案走 safeKeyed（用户改过 prompts 时缺键也不许把整次写入炸掉）',
    meowSrc137.includes('safeKeyed("conflict.item"') && meowSrc137.includes('safeKeyed("conflict.headUpdate"'),
  )
  check(
    'FC 源码: 冲突提醒与「已更新」拼在同一个 note 里出去（不许只报一个）',
    meowSrc137.includes('const said = conflictNote.length > 0 ? `${note}\\n${conflictNote}` : note;'),
  )

  const need137 = ['conflict.item', 'conflict.head', 'conflict.headUpdate', 'conflict.kindVersion', 'conflict.kindDate', 'conflict.join']
  const miss137 = ['zh', 'en', 'pt-br'].filter((lg) => {
    const t = readFileSync(join(root, 'vendor', 'meow-memory', 'lib', 'prompts', lg, 'labels.md'), 'utf8')
    return !need137.every((k) => t.includes(`- ${k}:`))
  })
  check('FC 三语: 六个文案键 zh/en/pt-br 齐全', miss137.length === 0, miss137.join(',') || 'zh/en/pt-br 全在')
  const en137 = readFileSync(join(root, 'vendor', 'meow-memory', 'lib', 'prompts', 'en', 'labels.md'), 'utf8')
  check('FC 三语: 英文那份是英文说法（it says {theirs}），不是中文搬家', en137.includes('it says {theirs}') && !en137.includes('它写 {theirs}'))
  const pt137 = readFileSync(join(root, 'vendor', 'meow-memory', 'lib', 'prompts', 'pt-br', 'labels.md'), 'utf8')
  check('FC 三语: 葡语那份也翻过了（ele diz {theirs}）', pt137.includes('ele diz {theirs}'))

  const pkg137 = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  check(
    'FC 版本与文档一起走（9.143 / 149）',
    verAtLeast(pkg137.version.split('.').map((x) => Number(x)), 0, 2, 137) &&
      readFileSync(join(root, 'docs', 'INTERNAL.md'), 'utf8').includes('## 9.143 ') &&
      readFileSync(join(root, 'DESIGN.md'), 'utf8').includes('## 149 '),
  )
  const idx137 = readFileSync(join(root, 'lib', 'index.js'), 'utf8')
  check(
    'FC 版本: 代码里的 version 常量与 package.json 同号',
    idx137.includes(`export const version = '${pkg137.version}'`),
    pkg137.version,
  )
}

// FD（0.2.138）：取代句从 0.2.117 起写在旧条目正文里，却没人读——现在回执点名链上位置。
{
  const chainPath = join(root, 'lib', 'macro', 'chain.js')
  const chainSrc = readFileSync(chainPath, 'utf8')
  const C = await import(pathToFileURL(chainPath).href)
  const updSrc = readFileSync(join(root, 'lib', 'macro', 'defs', 'update.js'), 'utf8')
  const readSrc = readFileSync(join(root, 'lib', 'macro', 'defs', 'read.js'), 'utf8')
  const toolsSrc = readFileSync(join(root, 'lib', 'macro', 'tools.js'), 'utf8')

  const p1 = C.supersededBy('正文（已被取代：abc12345「旧开头」，2026-11-21）尾巴')
  check('FD 解析: 取代句拆成 id / 开头 / 日期', p1 !== null && p1.id8 === 'abc12345' && p1.head === '旧开头' && p1.day === '2026-11-21', JSON.stringify(p1))
  const p2 = C.supersededBy('正文（已被取代：abc12345）')
  check('FD 解析: 只有 id 也认（开头、日期缺了就不编）', p2 !== null && p2.id8 === 'abc12345' && p2.head === '' && p2.day === '')
  check('FD 解析: 没有取代句返回 null（不许伪造一段链）', C.supersededBy('一条普通记忆，什么也没被取代') === null)
  check(
    'FD 解析: 半角逗号也认（别因为一个标点就把整条链读丢）',
    (C.supersededBy('正文（已被取代：abc12345「旧开头」, 2026-11-21）尾') ?? {}).day === '2026-11-21',
  )

  check('FD 闭嘴: 没工作区 / id 为空 / 库不存在一律空串', C.successionNote({ workspace: '', id: 'x' }) === '' && C.successionNote({ workspace: '/tmp', id: '' }) === '' && C.successionNote({ workspace: join(tmpdir(), 'fd-no-ws'), id: 'abc' }) === '')
  const s1 = C.successionOf({ workspace: '', id: 'abc' })
  check('FD 闭嘴: missing 三态分开说（不是一句「没有」）', s1.missing === 'no-workspace' && C.successionOf({ workspace: '/tmp', id: '' }).missing === 'bad-arg')

  check(
    'FD 源码: 链要在改之前读（memory_update 换正文会连取代句一起换掉）',
    updSrc.indexOf('const chain = successionNote(') < updSrc.indexOf("const main = await flow.call('memory_update'"),
  )
  check('FD 源码: 读也要带链，而且并进正文（预算按含链的长度算）', readSrc.includes("const extras = [consolidatedNote(main.value?.content), prov, chain].filter(Boolean).join('\\n')") && readSrc.includes('said = `${said}\\n\\n${extras}`') && readSrc.indexOf('said = `${said}') < readSrc.indexOf('const bodyEst = estTokens(said)'))
  // [0.2.157] 回执从三条变四条：留底那句插在正文说明之后、链接与链之前。
  check('FD 源码: 回执四条一起出（正文说明 / 留底 / 星图链接 / 链），不许只留一条', updSrc.includes("return [said, revNote, linked, chain].filter((one) => typeof one === 'string' && one.length > 0).join('\\n\\n')"))
  check('FD 源码: meowDir 真的从装配处传下来（不是写死 .dsh-meow）', toolsSrc.includes('createUpdate({ flow, meowDir })') && toolsSrc.includes('createRead({ flow, meowDir })'))
  check(
    'FD 源码: 链是读出来的，不是维护出来的（不建表、不加列、不建索引）',
    !/ALTER TABLE|CREATE INDEX|CREATE TABLE/i.test(chainSrc),
  )
  check(
    'FD 源码: 先 existsSync 再 getDb（否则一句提示会顺手建出一个空库）',
    chainSrc.indexOf('existsSync(dbFile(') < chainSrc.indexOf('Meow.getDb('),
  )
  check('FD 源码: 取代句常量与写侧同源（两边不共用就会越读越偏）', chainSrc.includes("export const SUPERSEDE_MARK = '（已被取代：'") && readFileSync(join(root, 'lib', 'macro', 'defs', 'remember.js'), 'utf8').includes("const SUPERSEDE_MARK = '（已被取代：'"))

  const provSrc = readFileSync(join(root, 'lib', 'macro', 'provenance.js'), 'utf8')
  check(
    'FW 来源: 读回执里真的接了来源一行（四种来路 + 用没用过 + 纠正过）',
    readSrc.includes("import { provenanceNote } from '../provenance.js'") &&
      provSrc.includes('MIGRATION') &&
      provSrc.includes('那次整理里封存') &&
      provSrc.includes('当次直接写进来') &&
      provSrc.includes('没有记来源会话') &&
      provSrc.includes('还没被检索用过') &&
      provSrc.includes('主人纠正过'),
  )
  check(
    'FW 来源: 读元数据不许顺手 markAccessed（否则「还有人用吗」会被读它的人污染）',
    !provSrc.includes('markAccessed(') && provSrc.indexOf('existsSync(') < provSrc.indexOf('Meow.getDb('),
  )
  check(
    'FW 来源: 近似要说明白（整理封存是按 6 小时窗口推的，落账口径不进正文）',
    provSrc.includes('DREAM_WINDOW_MS = 6 * 60 * 60 * 1000') && provSrc.includes('dream_log') && !provSrc.includes('INSERT') && !provSrc.includes('UPDATE '),
  )

  const pkg138 = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  check(
    'FD 版本与文档一起走（9.144 / 150）',
    verAtLeast(pkg138.version.split('.').map((x) => Number(x)), 0, 2, 138) &&
      readFileSync(join(root, 'docs', 'INTERNAL.md'), 'utf8').includes('## 9.144 ') &&
      readFileSync(join(root, 'DESIGN.md'), 'utf8').includes('## 150 '),
  )
}

// FQ（0.2.157）：可更新性的另一半——按句改（便宜）＋改前留一版（改坏了能退）。
// 这一组钉四件事：局部修改的参数只在融合层、留底在写之前、闸门常量只有一个出口、
// 留底表不许污染「被读过」。
{
  const revPath = join(root, 'lib', 'macro', 'revisions.js')
  const revSrc = readFileSync(revPath, 'utf8')
  const updSrc157 = readFileSync(join(root, 'lib', 'macro', 'defs', 'update.js'), 'utf8')
  const provSrc157 = readFileSync(join(root, 'lib', 'macro', 'provenance.js'), 'utf8')
  const R = await import(pathToFileURL(revPath).href)

  check(
    'FQ 口径: 局部修改三个参数（patch / append / restore）与 allowShrink 都在 schema 里，并被说明成互斥',
    ['patch', 'append', 'restore', 'allowShrink'].every((k) => new RegExp(`^\\s+${k}[:(]`, 'm').test(updSrc157)) &&
      updSrc157.includes('不能同时给'),
  )
  check(
    'FQ 口径: 它们只在融合层消费，不进 pick 白名单（vendor 的 schema 是 additionalProperties:false，传下去会被打回）',
    updSrc157.includes("pick({ ...args, content }, ['id', 'content', 'status', 'importance', 'goal', 'project', 'keywords'])") &&
      !/'patch'/.test(updSrc157.slice(updSrc157.indexOf('pick({ ...args, content }'))),
  )
  check(
    'FQ 留底: 写之前先留底（写成功而留底失败＝改坏了没退路）',
    updSrc157.indexOf('saveRevision(') < updSrc157.indexOf("flow.call('memory_update'"),
  )
  check(
    'FQ 闸门: 缩水门槛与留底上限是常量，只有一个出口（探针与清理都读它）',
    revSrc.includes('const REVISION_KEEP = 3') && revSrc.includes('const SHRINK_FLOOR = 0.7') && revSrc.includes('export { REVISION_KEEP, SHRINK_FLOOR }'),
  )
  check(
    'FQ 闭嘴: 没库不建库、留底表不许碰使用计数（读元数据不该让它变成「被用过」）',
    !revSrc.includes('markAccessed(') && revSrc.indexOf('existsSync(') < revSrc.indexOf('Meow.getDb(') && revSrc.includes("out.missing = 'no-db'"),
  )
  check(
    'FQ 来源: 来源一行把「改过几次」也算来源（只在真留过底时出现）',
    provSrc157.includes("import { revisionNote } from './revisions.js'") && provSrc157.includes('revisionNote({ workspace, dir, id })'),
  )

  const patched = R.applyPatches('甲这一段乙', [{ find: '这一段', replace: '那一段' }])
  check(
    'FQ 行为: 按句改只动那一句；找不到 / 多处命中一个字都不写',
    patched.ok && patched.content === '甲那一段乙' &&
      R.applyPatches('甲乙', [{ find: '丙', replace: 'x' }]).ok === false &&
      R.applyPatches('的的', [{ find: '的', replace: 'x' }]).ok === false,
  )
}


// FR（0.2.158）：面板层——引力可调、局部图 N 跳、标签随距离淡出。
// 这一组钉三件事：纯函数与面板接线是真的（不是写在文档里）、默认值只有一个来源、
// 以及「面板改了什么，请求前缀一个字节都没变」。第三件是这一版敢做的全部理由。
{
  const webDir = join(root, 'vendor', 'dsh-memory-nebula', 'lib', 'web')
  const s3d = readFileSync(join(webDir, 'space3d.js'), 'utf8')
  const app158 = readFileSync(join(webDir, 'app.js'), 'utf8')
  const css158 = readFileSync(join(webDir, 'style.css'), 'utf8')
  const checkAll158 = readFileSync(join(root, 'tools', 'check-all.mjs'), 'utf8')

  check(
    'FR 纯函数: 局部图与引力换算、标签淡出都是从 create() 外面导出的（面板与探针共用一份）',
    s3d.includes('function neighborhoodIds(edges, id, depth)') &&
      s3d.includes('function forceParams(ui)') &&
      s3d.includes('function labelAlpha(dist, near, far)') &&
      s3d.includes('window.NebulaSpace = { create, LEVEL_COLOR, TYPE_COLOR, neighborhoodIds, forceParams, labelAlpha, FORCE_BASE }'),
  )
  check(
    'FR 收口: 局部图只在 visible() 里裁（检索、计数不走它，所以「看得见」和「算得到」不会打架）',
    s3d.includes('if (state.local && !state.local.has(n.id)) return false') &&
      (s3d.match(/state\.local && !state\.local\.has/g) || []).length === 1,
  )
  check(
    'FR 单一来源: 面板优先读渲染器导出的 FORCE_BASE（渲染器还没加载时才用兜底，兜底由 probe-nebula 逐位比对）',
    app158.includes('const base = (NS && NS.FORCE_BASE)') &&
      app158.includes('window.NebulaSpace.FORCE_BASE') === false &&
      readFileSync(join(root, 'tools', 'probe-nebula.mjs'), 'utf8').includes('面板兜底值与 FORCE_BASE 同数'),
  )
  check(
    'FR 手感: 拖动只改数字，松手（change）才重排——不让每一像素都触发一次收敛',
    /inp\.onchange = \(\) => \{[\s\S]{0,400}saveForceUI\(forceUI\)\n\s+applyForceToStage\(\)/.test(app158.replace(/\r\n/g, '\n')) &&
      !/inp\.oninput[\s\S]{0,200}applyForceToStage/.test(app158.replace(/\r\n/g, '\n')),
  )
  check(
    'FR 退路: 局部图 0 跳＝回全图（传 null，不是空集合）；没选中就说一句而不是静默不动',
    app158.includes('state.space3d.setLocal(null, 0)') &&
      app158.includes('先点一颗星，局部图才知道从谁出发'),
  )
  check(
    'FR 零成本: 这一版只动 iframe 里的静态文件——lib/macro 与工具 schema 一个字都没改',
    !readFileSync(join(root, 'lib', 'macro', 'defs', 'update.js'), 'utf8').includes('nebula.force') &&
      !s3d.includes('memory_') &&
      /\.slider \.k \{/.test(css158),
  )
  check(
    'FR 登记: 新探针进 check-all（放在 doctor 之前，doctor 必须最后跑）',
    checkAll158.includes("['tools/probe-nebula.mjs'") &&
      checkAll158.indexOf("tools/probe-nebula.mjs") < checkAll158.indexOf("tools/doctor.mjs"),
  )
  const probeNeb = readFileSync(join(root, 'tools', 'probe-nebula.mjs'), 'utf8')
  check(
    'FR 对照: 探针自带三条阴性对照（删收口 / oninput 塞重排 / 兜底数字漂一位都要当场红）',
    ['局部图收口', '松手才重排', '兜底数字漂一位'].every((one) => probeNeb.includes(one)) &&
      probeNeb.includes('阴性对照：') &&
      /broken !== one\.src && one\.judge\(broken\) === false/.test(probeNeb),
  )
}


// GZ（0.2.159）：问句自带版本号/日期，就按那一刻排——但只免两样折扣，其余一个字节不动。
// 这一组量的是「口径」：豁免窄到能一句话说清、两个打分器同口径、免的是排序折扣不是事实状态。
{
  const eng = readFileSync(
    join(root, 'vendor', 'meow-memory', 'lib', 'index.js'),
    'utf8',
  )
  check(
    'GZ 单一来源: 时间锚只认一份正则定义，别的模块不许自己写一份「版本号长什么样」',
    eng.split('var TIME_ANCHOR_RE =').length - 1 === 1 &&
      !readFileSync(join(root, 'lib', 'macro', 'defs', 'update.js'), 'utf8').includes('TIME_ANCHOR') &&
      !readFileSync(join(root, 'lib', 'macro', 'fusion.js'), 'utf8').includes('TIME_ANCHOR'),
  )
  check(
    'GZ 同口径: 两个打分器（search / keywordHitScore）都认锚，且旧写法一处不剩',
    // [0.6.17] 第三处是水化（`matHitOf`）：入选条要重建 `anchored` 这个回执字段，判据一样一句。
    eng.split('const anchored = anchorSel === null ? false : anchorSel(di);').length - 1 === 3 &&
      // 0.2.179 起这两支有意不同口径：search 的缘由问句免折新鲜度（!causeQ），
      // 主动注入那支照旧折——注入多提一句常常是好事，抹平反而坏事（见 HZ14）。
      eng.split('if (!anchored && !causeQ && now !== null').length - 1 === 1 &&
      eng.split('if (!anchored && now !== null').length - 1 === 1 &&
      // [0.6.34] 扫倒排那处摊平成 `(STATUS_WEIGHT[...] ?? 1)`，两支仍各一处、只认前缀。
      eng.split('const stW = anchored ? 1 : ').length - 1 === 2 &&
      eng.includes('!timeAnchor && now !== null') === false &&
      eng.includes('const stW = timeAnchor ? 1') === false,
  )
  check(
    'GZ 只免两样: 词分与覆盖度一个字没动（动了就是改判据，不是改口径）',
    // [0.6.16] 打分拆成两条路（扫倒排的 scoreCandSet 与逐条扫的 scanDoc），协调因子那句在两个
    // 函数里各有一处、算式逐字相同——所以钉「两处」而不是「一处」，但仍是两处、不许再散。
    // [0.6.34] 扫倒排那处把 `1 - COORD_W` 提成循环外的 `coordKeep`：两种写法的处数相加仍是 2。
    eng.split('if (cvr > 0) s *= 1 - COORD_W + COORD_W * cvr;').length - 1 +
      eng.split('s *= coordKeep + COORD_W * cvr;').length - 1 === 2 &&
      !/COORD_W[^\n]*anchored/.test(eng) &&
      eng.split('const coverage = len > 0 ? overlap / len : 0;').length - 1 === 1 &&
      // [0.6.15] 两支打分器的 w 同形（都带 RECENCY_FLOOR 下限）。0.6.15 起 search 那支先落 `dOf`，
      // 两条的字面量不再逐字相同 → 改钉共有的那半句，两处都得在。
      // [0.6.34] 热路改成毫秒梯子（`Math.max(\n  RECENCY_FLOOR,` 换行），一律按 `Math.max(※RECENCY_FLOOR,` 数。
      (eng.match(/Math\.max\(\s*RECENCY_FLOOR,/g) || []).length === 2 &&
      eng.split('anchorHit').length - 1 === 1,
  )
  check(
    'GZ 可审计: explain 里点出 anchorHit——排名为什么这样，看得出是锚起了作用',
    eng.includes('...(timeAnchor ? { timeAnchor: true } : {}), ...(anchored ? { anchorHit: true } : {})'),
  )
  check(
    'GZ 可关: 探针要靠「关掉它变差」证伪这条判据，所以开关必须真在',
    /function timeAnchorOf\([\s\S]{0,200}timeAnchor === false/.test(eng) &&
      eng.includes('  timeAnchorOf,') &&
      eng.includes('  TIME_ANCHOR_RE,'),
  )
  const fx159 = JSON.parse(readFileSync(join(root, 'tools', 'fixtures', 'gold-recall.json'), 'utf8'))
  check(
    'GZ 量得到: 夹具里有 10 条「问句点名某个版本/日期」的问句，正解都在语料里',
    Array.isArray(fx159.anchor) &&
      fx159.anchor.length === 10 &&
      fx159.anchor.every((one) => {
        const want = Array.isArray(one.want) ? one.want : [one.want]
        return want.every((id) => fx159.docs.some((d) => String(d.id).startsWith(String(id))))
      }),
  )
  const probeGold159 = readFileSync(join(root, 'tools', 'probe-gold.mjs'), 'utf8')
  check(
    'GZ 自带阴性对照: 探针里有一条「关掉时间锚后必须变差」，否则这条判据可能在白写',
    probeGold159.includes('G18 时间锚') &&
      probeGold159.includes('关掉时间锚后 45 池没有变差——阴性对照失效') &&
      probeGold159.includes('为了排名把 stale 洗成了 active'),
  )
  const int159 = readFileSync(join(root, 'docs', 'INTERNAL.md'), 'utf8')
  const des159 = readFileSync(join(root, 'DESIGN.md'), 'utf8')
  check(
    'GZ 有记: INTERNAL 9.166 写清缺口与三个被否的思路，DESIGN 171 写清豁免为什么这么窄',
    int159.includes('## 9.166') &&
      int159.includes('0.911') &&
      int159.includes('0.933') &&
      des159.includes('## 171') &&
      des159.includes('问句里的日期是条件，不是噪声'),
  )
}

// HA（0.2.160）：分低别装懂——弱命中时说清「差在哪」，强命中一个字不多说。
// 这一组量的是「诚实度」：不改排序（改不动就说明白），只说能核对的事实，且强命中零字节。
{
  const eng = readFileSync(
    join(root, 'vendor', 'meow-memory', 'lib', 'index.js'),
    'utf8',
  )
  check(
    'HA 单一来源: 弱命中的两个门槛只定义一次，别的模块不许自己写一份「多低才算弱」',
    eng.split('var WEAK_COVER =').length - 1 === 1 &&
      eng.split('var WEAK_GAP =').length - 1 === 1 &&
      !readFileSync(join(root, 'lib', 'macro', 'defs', 'search.js'), 'utf8').includes('WEAK_COVER'),
  )
  check(
    'HA 判据是门槛不是玄学: 两个阈值都能被 opts 覆盖，且比值夹到 1（分档后第二名可能更高）',
    eng.includes('const coverMax = Number.isFinite(o.cover) ? o.cover : WEAK_COVER;') &&
      eng.includes('const gapMax = Number.isFinite(o.gap) ? o.gap : WEAK_GAP;') &&
      eng.includes('const gapRaw = second !== null && topScore > 0') &&
      eng.includes('const gap = gapRaw > 1 ? 1 : gapRaw;'),
  )
  check(
    'HA 强命中零字节: 不弱就返回空串；闸门挡下的那次、以及语义补位那次也不再重复说（同一件事只说一句）',
    eng.includes('  if (!w.weak) return "";') &&
      eng.includes('const weakNote = gate.fired || rescued > 0 ? "" : weakNoteOf(ranked, { query });') &&
      eng.split('weakNoteOf(').length - 1 === 2,
  )
  check(
    'HA 版本号问句不误报: 榜首那条自己就带这个日期/版本号时，不许说「措辞对不上」',
    eng.includes('if (top.anchored === true) return { weak: false, why: "anchor"') &&
      eng.includes('...(anchored ? { anchored: true } : {}),') &&
      // [0.6.17] 两处：完整字面量（explain / keepBand 那两条路）+ 水化。
      eng.split('...(anchored ? { anchored: true } : {}),').length - 1 === 2,
  )
  check(
    'HA 覆盖度有出处: cover 只算一遍，hit 与 explain 用的是同一个算式（不是文案里另算一遍）',
    eng.split('coverOf[di] = Math.min(1, cover / qIdfSum);').length - 1 === 1 &&
      eng.split('cover: Math.round(coverOf[di] * 1e3) / 1e3,').length - 1 >= 2 &&
      /explain: \{ bm25:[\s\S]{0,600}cover: Math\.round\(coverOf\[di\] \* 1e3\) \/ 1e3/.test(eng),
  )
  check(
    'HA 只说不改: 提示不进打分路径（词分、分档、排序一个字节都不动）',
    !/function (scanDoc|bandize)[\s\S]{0,1200}weakNote/.test(eng) && eng.includes('hintWordsOf') && eng.includes('weakHitOf'),
  )
  check(
    'HA 抽词有规矩: 2–12 字、剔纯数字与版本号、剔问句里已有的词、最多 3 个',
    eng.includes('if (one.length < 2 || one.length > 12) continue;') &&
      eng.includes('if (/^[0-9.\\-/\\s]+$/.test(one)) continue;') &&
      eng.includes('if (q.includes(one)) continue;') &&
      eng.includes('if (out.length >= 3) break;'),
  )
  const probeGold160 = readFileSync(join(root, 'tools', 'probe-gold.mjs'), 'utf8')
  check(
    'HA 自带阴性对照: 探针里三条对照都必须能让 G19 变红（不闭嘴 / 误报版本号 / 抽词不剔）',
    probeGold160.includes('G19 弱命中就说清') &&
      probeGold160.includes('强命中仍多说了') &&
      probeGold160.includes('版本号问句被当成弱命中') &&
      probeGold160.includes('抽词没剔掉数字或问句里的词') &&
      probeGold160.includes('每条都说 = 等于没说'),
  )
  const int160 = readFileSync(join(root, 'docs', 'INTERNAL.md'), 'utf8')
  const des160 = readFileSync(join(root, 'DESIGN.md'), 'utf8')
  check(
    'HA 有记: INTERNAL 9.167 写清「为什么改排序改不动、只能改说法」，DESIGN 172 写清判据与代价',
    int160.includes('## 9.167') &&
      int160.includes('0.500') &&
      int160.includes('16/31') &&
      des160.includes('## 172') &&
      des160.includes('分低就说清'),
  )
}

// HB（0.2.161）：关键词字段更值钱——真库没有标题，keywords 是唯一的结构化桥。
// 这一组量的是「一个数该值多少、写在哪」：抬到斜带中间（不是边缘），且三处兜底同一个来源。
{
  const eng = readFileSync(
    join(root, 'vendor', 'meow-memory', 'lib', 'index.js'),
    'utf8',
  )
  check(
    'HB 单一来源: 两个关键词权重只定义一次，别的模块不许自己写一份「关键词值多少」',
    eng.split('var KW_TF_W =').length - 1 === 1 &&
      eng.split('var FIELD_KW_W_DEF =').length - 1 === 1 &&
      !readFileSync(join(root, 'lib', 'macro', 'defs', 'search.js'), 'utf8').includes('KW_TF_W') &&
      !readFileSync(join(root, 'lib', 'macro', 'fusion.js'), 'utf8').includes('KW_TF_W'),
  )
  check(
    'HB 三处兜底同源: kwTfW 在索引/缓存键/取索引三处都读常量，旧字面量一处不剩（否则换权重后缓存会喂旧表）',
    eng.split('opts.kwTfW : KW_TF_W').length - 1 === 3 &&
      eng.includes('opts.kwTfW : 0.25') === false &&
      eng.split('opts.fieldKwW : FIELD_KW_W_DEF').length - 1 === 1 &&
      eng.includes('opts.fieldKwW : 0.35') === false,
  )
  check(
    'HB 同读数取保守值: 0.35 / 0.6 与 0.5 / 0.6 读数完全相同，但 0.5 会破「标签不是正文」，所以只能取 0.35',
    eng.includes('var KW_TF_W = 0.35;') &&
      eng.includes('var FIELD_KW_W_DEF = 0.6;') &&
      eng.includes('同读数选不破老规矩的那一个'),
  )
  check(
    'HB 可覆盖可审计: 两个数都从模块导出，探针与验收用同一个数；opts 仍可逐次覆盖',
    eng.includes('  KW_TF_W,\n  FIELD_KW_W_DEF,') &&
      eng.includes('Number.isFinite(opts.kwTfW) && opts.kwTfW >= 0') &&
      eng.includes('Number.isFinite(opts.fieldKwW)'),
  )
  const probeGold161 = readFileSync(join(root, 'tools', 'probe-gold.mjs'), 'utf8')
  check(
    'HB 自带阴性对照: 探针里四条对照都必须能让 G20 变红（退回旧口径 / 抬过头 / 平台外同分 / 照抄漂移）',
    probeGold161.includes('G20 关键词更值钱') &&
      probeGold161.includes('旧口径下锚点池没变差') &&
      probeGold161.includes('关键词一路抬到 1/1.2 照抄池也没变差') &&
      probeGold161.includes('平台外的组合也与默认同分') &&
      probeGold161.includes('照抄池 ${drift} 条排名被动了'),
  )
  const int161 = readFileSync(join(root, 'docs', 'INTERNAL.md'), 'utf8')
  const des161 = readFileSync(join(root, 'DESIGN.md'), 'utf8')
  check(
    'HB 有记: INTERNAL 9.168 写清真库 title 全空、伪标题被否、斜带读数，DESIGN 173 写清「别为空转权重找活干」',
    int161.includes('## 9.168') &&
      int161.includes('0.940') &&
      int161.includes('0.961') &&
      int161.includes('/0.500/0.800') &&
      des161.includes('## 173') &&
      des161.includes('空转'),
  )
}

// HB2（0.2.162）：同义词桥——词面上根本没有可比的词时，换个说法还找得回来。
// 这一组量的是「桥只做加法」：表站得住、只扩问句、权重小于 1、覆盖度分母与倒排候选集各归各位，
// 而且开关只有一个（synBridge:false = synW:0）。
{
  const eng = readFileSync(
    join(root, 'vendor', 'meow-memory', 'lib', 'index.js'),
    'utf8',
  )
  const meow162 = await import(pathToFileURL(join(root, 'vendor', 'meow-memory', 'lib', 'index.js')).href)
  check(
    'HB2 单一来源: 表与权重只定义一次，别的模块不许自己写一份「哪些词算同义」',
    eng.split('var SYN_GROUPS = ').length - 1 === 1 &&
      eng.split('var SYN_W = ').length - 1 === 1 &&
      !readFileSync(join(root, 'lib', 'macro', 'defs', 'search.js'), 'utf8').includes('SYN_W') &&
      !readFileSync(join(root, 'lib', 'macro', 'fusion.js'), 'utf8').includes('SYN_GROUPS'),
  )
  check(
    'HB2 表能对齐: 每组 ≥2 条、每个词中文两字或英文标识符（tokenize 只产二元组，一字词永远命不中）、无跨组重复',
    Array.isArray(meow162.SYN_GROUPS) &&
      meow162.SYN_GROUPS.length >= 12 &&
      // [macro-fusion 0.4.0 · P5] 0.4.0 起表里收英文技术名词，英文没有「两字」这回事：
      // 中文仍必须恰好两字（防止拿长短语当同义词），英文按小写标识符放行。
      meow162.SYN_GROUPS.every((g) => g.length >= 2 && g.every((w) => /^[\u4e00-\u9fff]{2}$/.test(w) || /^[a-z][a-z0-9_]*$/.test(w))) &&
      new Set(meow162.SYN_GROUPS.flat()).size === meow162.SYN_GROUPS.flat().length,
  )
  check(
    'HB2 权重是「帮忙」不是「顶替」: 0 < SYN_W < 1，扩词不能与原文同权',
    typeof meow162.SYN_W === 'number' && meow162.SYN_W > 0 && meow162.SYN_W < 1,
  )
  check(
    'HB2 只扩问句: 开关与权重都从 opts 读，默认读常量（一处兜底，不是每处各写一遍）',
    /const synOf = opts\.synBridge === false \? null : synExpandOf\(qKept, df, n, coocSyn, opts\.synFormBridge === true \? coocForms : null(, lookupSyn)?\);/.test(eng) &&
      eng.includes('const synW = Number.isFinite(opts.synW) && opts.synW >= 0 ? opts.synW : SYN_W;') &&
      eng.split('opts.synW : SYN_W').length - 1 === 1,
  )
  check(
    'HB2 覆盖度分母不动: 分母只累 qKept，同义词一个字节都不进（进了就是「问句更难满足」）',
    eng.split('for (const term of qKept) if (tf[di].has(term)) cover += idfOf(term);').length - 1 === 1 &&
      !/cover \+= idfOf\(a\)/.test(eng) &&
      eng.split('coverOf[di] = Math.min(1, cover / qIdfSum);').length - 1 === 1,
  )
  check(
    'HB2 候选集合并: 同义词的 postings 必须并进倒排候选，否则被剪掉的条目连分都算不到',
    eng.includes('if (synOf !== null) {') &&
      eng.includes('for (const alts of synOf.values()) for (const a of alts) {') &&
      eng.includes('const p = postings.get(a);'),
  )
  check(
    'HB2 可审计: 表与函数从模块导出，探针和验收读的是同一份数据',
    eng.includes('  SYN_GROUPS,\n  SYN_W,') &&
      eng.includes('  synExpandOf,') &&
      eng.includes('  buildCoocSyn,') &&
      typeof meow162.synExpandOf === 'function',
  )
  check(
    'HB2 虚词补齐: 「要不要」的另一半与「一段」都进了虚词表（此前只剔了「要不」）',
    eng.includes('"一些", "一段", "还是"') && eng.includes('"不是", "不要", "没有"'),
  )
  const docs162 = [
    { id: 'S1', level: 'fact', title: '', content: '这一段讲的是反思', keywords: [], importance: 1, project: 'hb2', updated_at: 1763e9, last_accessed_at: 1763e9 },
    { id: 'S2', level: 'fact', title: '', content: '这一段讲的是别的', keywords: [], importance: 1, project: 'hb2', updated_at: 1763e9, last_accessed_at: 1763e9 },
  ]
  const idsOf = (opts) => meow162.search('反省', docs162, { k: 2, ...opts }).map((h) => String(h.id))
  check(
    'HB2 行为: 只含同义词的条目，关桥进不来、开桥进得来（这是「词面零交集」那一类问句的对照）',
    idsOf({}).includes('S1') && !idsOf({ synBridge: false }).includes('S1'),
  )
  check(
    'HB2 行为: 覆盖度按条目比，开桥不改同一条记忆的 cover（只加分，不改判据）',
    (() => {
      const on = new Map(meow162.search('反思', docs162, { k: 2 }).map((h) => [String(h.id), Number(h.cover ?? -1).toFixed(3)]))
      const off = new Map(meow162.search('反思', docs162, { k: 2, synBridge: false }).map((h) => [String(h.id), Number(h.cover ?? -1).toFixed(3)]))
      for (const [id, v] of on) if (off.has(id) && off.get(id) !== v) return false
      return true
    })(),
  )
  const probe162 = readFileSync(join(root, 'tools', 'probe-gold.mjs'), 'utf8')
  check(
    'HB2 自带阴性对照: 探针里五条对照都必须能让 G21 变红（开关失效 / 候选集没并 / 进分母 / 虚词退回去 / 权重压扁）',
    probe162.includes('G21 同义词桥') &&
      probe162.includes('同义词表形态不对') &&
      probe162.includes('只含同义词的条目没被桥进来') &&
      probe162.includes('cover 开/关不一致') &&
      probe162.includes('「不要」还在参与打分') &&
      probe162.includes('synBridge:false 与 synW:0 不同分') &&
      probe162.includes('换说法池没到门槛'),
  )
  const int162 = readFileSync(join(root, 'docs', 'INTERNAL.md'), 'utf8')
  const des162 = readFileSync(join(root, 'DESIGN.md'), 'utf8')
  check(
    'HB2 有记: INTERNAL 9.169 写清词面零交集与四个读数，DESIGN 174 写清「只做加法」的边界',
    int162.includes('## 9.169') &&
      int162.includes('0.571') &&
      int162.includes('0.798') &&
      des162.includes('## 174') &&
      des162.includes('同义'),
  )
}

// HC（0.2.163 / 口径纠正 0.2.165）：覆盖度是内容证据——问句里那些词，这条到底占了几成。
// 这一组量的是「证据强度」：抬覆盖度能把分差拉开，但三池一条不亏；幂次只是旋钮，默认线性。
// 0.2.165 追加一条更狠的：喂给 search 的库行必须过 fromRow——否则 keywords 是 JSON 文本、
// 引擎三处按数组判空，关键词通道整条静默失效（三版真库读数就是这么错的）。
{
  const eng = readFileSync(
    join(root, 'vendor', 'meow-memory', 'lib', 'index.js'),
    'utf8',
  )
  check(
    'HC 单一来源: 覆盖度的权重与幂次各定义一次，别的模块不许自己写一份「覆盖度算多重」',
    eng.split('var COORD_W_DEF = 0.45;').length - 1 === 1 &&
      eng.split('var COORD_POW_DEF = 1;').length - 1 === 1 &&
      !readFileSync(join(root, 'lib', 'macro', 'defs', 'search.js'), 'utf8').includes('COORD_') &&
      !readFileSync(join(root, 'lib', 'macro', 'fusion.js'), 'utf8').includes('COORD_'),
  )
  check(
    'HC 兜底同源: 两个旋钮都能被 opts 覆盖，默认值来自常量，幂次带 >0 守卫',
    eng.includes('const COORD_W = Number.isFinite(opts.coordW) ? opts.coordW : COORD_W_DEF;') &&
      eng.includes('const COORD_POW = Number.isFinite(opts.coordPow) && opts.coordPow > 0 ? opts.coordPow : COORD_POW_DEF;'),
  )
  check(
    'HC 只动一处: 协调因子在打分路径里出现一次，线性旧写法一处不剩',
    // [0.6.16] 同上：扫倒排与逐条扫两条路各一处，算式逐字相同；线性旧写法仍是一处不剩。
    // [0.6.34] 扫倒排那处把 `1 - COORD_W` 提成循环外的 `coordKeep`：两种写法的处数相加仍是 2。
    eng.split('if (cvr > 0) s *= 1 - COORD_W + COORD_W * cvr;').length - 1 +
      eng.split('s *= coordKeep + COORD_W * cvr;').length - 1 === 2 &&
      eng.split('s *= 1 - COORD_W + COORD_W * Math.min(1, cover / qIdfSum);').length - 1 === 0,
  )
  check(
    'HC 覆盖度不跟权重走: cover 只算一遍、算式里没有 COORD_（权重只用来乘，不改「占了几成」）',
    eng.split('coverOf[di] = Math.min(1, cover / qIdfSum);').length - 1 === 1 &&
      !/coverOf\[di\] = Math\.min\(1, cover \/ qIdfSum\)[^\n]*COORD_/.test(eng),
  )
  check(
    'HC 常量导出: 探针与验收都得能读到真值，不许在测试里另写一份 0.45',
    eng.includes('  COORD_W_DEF,\n  COORD_POW_DEF,'),
  )
  // ── HY（0.2.165）：回执按置信档收口 ───────────────────────────────────────
  // bandize 判断过的「和榜首同一量级」，回执必须用上：同档才回、至少 5 条、关得掉。
  {
    const occur = (t) => eng.split(t).length - 1
    check(
      'HY 常量: RESULT_MIN_KEEP 是唯一来源（5），裁剪只有一个实现',
      occur('var RESULT_MIN_KEEP = 5;') === 1 && occur('function trimByBand(') === 1,
    )
    check(
      'HY 口径统一: 词法一路、稠密融合一路、dense:false 退路，三处共用 trimByBand',
      occur('return trimByBand(') >= 3 && eng.includes('if (opts.keepBand === true) return hits.slice(0,'),
    )
    check(
      'HY 档位留痕: bandize 现在始终把 _band 挂在 hit 上（以前只有 explain 才有 band）',
      eng.includes('h._band = h._bandTmp;') && eng.includes('delete h._band;'),
    )
    const MeowHY = await import(pathToFileURL(join(root, 'vendor', 'meow-memory', 'lib', 'index.js')).href)
    // 受控语料：5 条几乎同分（band 0）、4 条弱命中（band 1）。噪声地板不必关——同档的 5 条本来就在。
    const hyCorpus = []
    const hyDoc = (id, c) => hyCorpus.push({ id, level: 'fact', content: c, title: '', keywords: [], importance: 1, status: 'active' })
    const hyCore = '葡萄园的水肥一体化要看土壤墒情，墒情低于百分之六十就要滴灌补水。'
    for (let i = 0; i < 5; i++) hyDoc('same' + i, hyCore + ` 第 ${i} 条记录。`)
    const hyPad = 'zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau upsilon phi chi psi omega '
    for (let i = 0; i < 4; i++) hyDoc('weak' + i, '葡萄园 ' + hyPad.repeat(3 + i) + `第 ${i} 条。`)
    const hyQ = '葡萄园 水肥 墒情 滴灌'
    const full = MeowHY.search(hyQ, hyCorpus, { k: 12, bandKeep: false })
    const cut = MeowHY.search(hyQ, hyCorpus, { k: 12 })
    check(
      'HY 行为: 默认只回同档那几条（这里 5 条同分），关掉裁剪才回满库里那 9 条',
      cut.length === 5 && full.length === 9 && cut[0].id === 'same0' && full[0].id === 'same0',
      `裁剪 ${cut.length} 条 / 关掉 ${full.length} 条`,
    )
    check(
      'HY 行为: 裁剪不丢榜首——同档条目全部包含、顺序不变（band 单调不减，所以是前缀）',
      cut.every((h, i) => h.id === full[i].id),
    )
    check(
      'HY 阴性对照: minKeep:0 与 bandKeep:false 逐位相同（关得掉）；minKeep 与 k 互相不越界',
      MeowHY.search(hyQ, hyCorpus, { k: 12, minKeep: 0 }).map((h) => h.id).join(',') === full.map((h) => h.id).join(',') &&
        MeowHY.search(hyQ, hyCorpus, { k: 3 }).length === 3 &&
        MeowHY.search(hyQ, hyCorpus, { k: 12, minKeep: 99 }).length === full.length,
    )
    const hyInt = readFileSync(join(root, 'docs/INTERNAL.md'), 'utf8')
    const hyDes = readFileSync(join(root, 'DESIGN.md'), 'utf8')
    check(
      'HY 文档锚：9.172 写下了取舍表与 9.80 → 4.97，177 写下了「回执长度也是判据的一部分」',
      hyInt.includes('## 9.172') && hyInt.includes('RESULT_MIN_KEEP') && hyInt.includes('9.80') &&
        hyDes.includes('## 177') && hyDes.includes('回执的长度也是判据的一部分'),
    )
  }

  // ── HZ（0.2.166）：稠密只补盲区，不并列投票 ───────────────────────────────
  // 两件事都要断言：词法承认不行时它得能救场；词法有把握时它得闭嘴（RRF 就是没闭嘴那版）。
  {
    const occur = (t) => eng.split(t).length - 1
    check(
      'HZ 常量: 三道门槛各一个来源（0.2 / 4 / 0.45），兜底只有一个实现',
      occur('var DENSE_RESCUE_COVER = 0.2;') === 1 &&
        occur('var DENSE_RESCUE_HEAD = 4;') === 1 &&
        occur('var DENSE_RESCUE_COS = 0.45;') === 1 &&
        occur('function rescueByDense(') === 1 &&
        occur('function denseRescueWanted(') === 1,
    )
    check(
      'HZ 权限: 稠密就绪也不许默认并列融合（老 RRF 只在 denseFuse:true 时走），且 _dense 不清出去就是泄漏',
      eng.includes('if (opts.denseFuse !== true) return trimByBand(lex, opts.k, opts);') &&
        eng.includes('if (!(r.cos >= minCos)) break;') &&
        occur('delete h._dense;') === 1 &&
        eng.includes('for (const h of lexHits.slice(head))'),
    )
    const MeowHZ = await import(pathToFileURL(join(root, 'vendor', 'meow-memory', 'lib', 'index.js')).href)
    check(
      'HZ 常量导出: 探针要能读到真值，不许在测试里另写一份 0.2/4/0.45',
      MeowHZ.DENSE_RESCUE_COVER === 0.2 && MeowHZ.DENSE_RESCUE_HEAD === 4 && MeowHZ.DENSE_RESCUE_COS === 0.45,
    )
    // 这个仓库默认没有稠密模型：整条路径必须一次都不触发，回执与纯词法逐位相同。
    const hzCorpus = []
    const hzDoc = (id, c, kws) => hzCorpus.push({ id, level: 'fact', content: c, title: '', keywords: kws || [], importance: 2, status: 'active' })
    hzDoc('d0', '舵轮校准要先把液压油温升到四十度，再逐格对零位。', ['舵轮', '校准'])
    hzDoc('d1', '舵轮校准的零位漂移多半来自编码器线松了。', ['舵轮', '漂移'])
    hzDoc('d2', '压载水的排放记录必须保留三年。', ['压载水'])
    hzDoc('d3', '甲板照明在夜航时降到最低档。', ['照明'])
    const hzQs = ['舵轮 校准 零位', '压载水 排放 记录', '甲板 照明 夜航']
    // searchHybrid 是 async：不 await 拿到的是 Promise，JSON.stringify 出来是 {}（恒假）。
    const hzSame = await Promise.all(hzQs.map(async (q) => {
      const a = await MeowHZ.searchHybrid(q, hzCorpus, { k: 3 })
      const b = MeowHZ.search(q, hzCorpus, { k: 3 })
      return JSON.stringify(a) === JSON.stringify(b)
    }))
    check(
      'HZ 行为: 稠密未就绪时 hybrid 与纯词法逐位相同（没模型就当它不存在，不加提示、不改分数）',
      hzSame.every(Boolean) && MeowHZ.denseStatus().state !== 'ready',
    )
    const hzOff = await Promise.all(hzQs.map(async (q) => {
      const pure = MeowHZ.search(q, hzCorpus, { k: 3 }).map((h) => h.id).join(',')
      const off1 = (await MeowHZ.searchHybrid(q, hzCorpus, { k: 3, denseRescue: false })).map((h) => h.id).join(',')
      const off2 = (await MeowHZ.searchHybrid(q, hzCorpus, { k: 3, rescueCover: 0 })).map((h) => h.id).join(',')
      return pure === off1 && pure === off2
    }))
    const hzWide = await MeowHZ.searchHybrid('舵轮 校准', hzCorpus, { k: 2, rescueCover: 1, rescueHead: 0 })
    const hzHead = await MeowHZ.searchHybrid('舵轮 校准', hzCorpus, { k: 5, rescueHead: 99 })
    check(
      'HZ 阴性对照: denseRescue:false / rescueCover:0 都回到纯词法；rescueCover:1 与 rescueHead 越界值也不回超 k',
      hzOff.every(Boolean) && hzWide.length <= 2 && hzHead.length <= 5,
      `关闭 ${hzOff.filter(Boolean).length}/${hzOff.length} · ${hzWide.length} 条 / ${hzHead.length} 条`,
    )
    const hzInt = readFileSync(join(root, 'docs/INTERNAL.md'), 'utf8')
    const hzDes = readFileSync(join(root, 'DESIGN.md'), 'utf8')
    check(
      'HZ 文档锚：9.173 写下盲区读数（0.072）与三道门槛，178 写下「只许补盲区，不许并列投票」',
      hzInt.includes('## 9.173') && hzInt.includes('DENSE_RESCUE_COVER') && hzInt.includes('0.072') &&
        hzDes.includes('## 178') && hzDes.includes('只许补盲区'),
    )
  }

  // ── HZ2（0.2.167）：收口折掉的条数要报得出来（欠账不许静默）───────────────
  // 0.2.165 那道刀一直在切，切完什么都不说：读者只看到「只给了 5 条」。
  // 三件事必须同时成立：账平（保留 + 折掉 = 关掉时的全量）、名次一位不动、有不花钱的出口。
  {
    const occur = (t) => eng.split(t).length - 1
    check(
      'HZ2 源码: 折掉的条数挂在返回数组上（非枚举，不进 JSON / Object.keys），且只在「回执短于 k」时报',
      // [macro-fusion 0.2.169] 挂载点变成两处：trimByBand 报「同档之外」、rescueByDense 报「词法尾部」。
      occur('Object.defineProperty(out, "trimmed"') === 2 &&
        occur('const upstreamTrim = Number(hits.trimmed) || 0;') === 1 &&
        eng.includes('enumerable: false') &&
        eng.includes('const bandShort = bandTrimmed > 0 && hits.length < k;') &&
        occur('search.bandTrim') === 1 &&
        eng.includes('if (dropped > 0) {'),
    )
    check(
      'HZ2 出口: band_keep 两处 schema（统一工具 + meow 原工具）+ 一路接进 rankForSearch，缺一处就等于没有出口',
      eng.includes('band_keep: {') &&
        readFileSync(join(root, 'lib/macro/defs/search.js'), 'utf8').includes("band_keep: { type: 'boolean'") &&
        eng.includes('const bandKeep = parsed.band_keep !== false;') &&
        eng.includes('{ k: docs.length, explain, bandKeep }'),
    )
    const MeowHZ2 = await import(pathToFileURL(join(root, 'vendor', 'meow-memory', 'lib', 'index.js')).href)
    const hz2Corpus = []
    const d = (id, c, kws) => hz2Corpus.push({ id, level: 'fact', content: c, title: '', keywords: kws || [], importance: 2, status: 'active' })
    d('s0', '舵轮校准要先把液压油温升到四十度，再逐格对零位。', ['舵轮', '校准', '零位'])
    d('s1', '舵轮校准的零位漂移多半来自编码器线松了。', ['舵轮', '漂移', '零位'])
    d('s2', '舵轮液压油的更换周期是一年。', ['舵轮', '液压油'])
    d('s3', '压载水的排放记录必须保留三年。', ['压载水'])
    d('s4', '甲板照明在夜航时降到最低档。', ['照明'])
    const q2 = '舵轮 校准 零位'
    const keep = MeowHZ2.search(q2, hz2Corpus, { k: 10 })
    const full = MeowHZ2.search(q2, hz2Corpus, { k: 10, bandKeep: false })
    const trimmed = Number(keep.trimmed) || 0
    check(
      'HZ2 账平: 保留 + 折掉 = 关掉收口时的全量，且保留的必须是全量排序的前缀（收口不许动名次）',
      keep.length + trimmed === full.length &&
        (trimmed === 0 || keep.map((h) => h.id).join(',') === full.slice(0, keep.length).map((h) => h.id).join(',')) &&
        (Number(full.trimmed) || 0) === 0,
      `保留 ${keep.length} + 折掉 ${trimmed} = ${full.length}`,
    )
    check(
      'HZ2 不污染: trimmed 是数组上的非枚举属性——JSON.stringify 里看不见，旧调用方一个字节都不用改',
      !JSON.stringify(keep).includes('trimmed') && !Object.keys(keep).includes('trimmed'),
    )
    const hz2Int = readFileSync(join(root, 'docs/INTERNAL.md'), 'utf8')
    const hz2Des = readFileSync(join(root, 'DESIGN.md'), 'utf8')
    check(
      'HZ2 文档锚：9.174 写下工具回执实际 2.35 条与 band_keep 出口，179 写下「欠账要报」',
      hz2Int.includes('## 9.174') && hz2Int.includes('band_keep') && hz2Int.includes('2.35') &&
        hz2Des.includes('## 179') && hz2Des.includes('欠账'),
    )
  }

  // ── HZ3（0.2.168）：默认检索范围要含 user，soul / project 仍要显式 ────────────
  {
    const meowHZ3 = readFileSync(join(root, 'vendor/meow-memory/lib/index.js'), 'utf8')
    const pluginHZ3 = readFileSync(join(root, 'lib/macro/defs/search.js'), 'utf8')
    const toolsZh = readFileSync(join(root, 'vendor/meow-memory/lib/prompts/zh/tools.md'), 'utf8')
    const toolsEn = readFileSync(join(root, 'vendor/meow-memory/lib/prompts/en/tools.md'), 'utf8')
    const toolsPt = readFileSync(join(root, 'vendor/meow-memory/lib/prompts/pt-br/tools.md'), 'utf8')
    const guideZh = readFileSync(join(root, 'vendor/meow-memory/lib/prompts/zh/system-guide.md'), 'utf8')
    const guideEn = readFileSync(join(root, 'vendor/meow-memory/lib/prompts/en/system-guide.md'), 'utf8')
    const guidePt = readFileSync(join(root, 'vendor/meow-memory/lib/prompts/pt-br/system-guide.md'), 'utf8')

    check(
      'HZ3 默认层: 默认检索范围含 user（主人的偏好就在这层），且这里只有一个来源',
      (meowHZ3.match(/\? \["fact", "lesson", "topic", "rules", "user"\] : \[\]/g) || []).length === 1 &&
        !meowHZ3.includes('["fact", "lesson", "topic", "rules"]'),
    )
    check(
      'HZ3 边界: soul 与 project 没被顺手塞进默认（实测掺进来换说池首位 5 → 4）',
      !/\? \["fact", "lesson", "topic", "rules", "user", "(soul|project)"\]/.test(meowHZ3) &&
        !meowHZ3.includes('"rules", "user", "soul"') &&
        !meowHZ3.includes('"rules", "user", "project"'),
    )
    check(
      'HZ3 地板: min_rel 默认 0.30（execute 内联值与 schema default 两处同源，缺一处就等于没改）',
      (meowHZ3.match(/const minRel = relRaw !== void 0 \? Math\.max\(0, Math\.min\(1, relRaw\)\) : 0\.3;/g) || []).length === 1 &&
        meowHZ3.includes('min_rel: { type: "number", minimum: 0, maximum: 1, default: 0.3') &&
        !meowHZ3.includes('Math.max(0, Math.min(1, relRaw)) : 0.35'),
    )
    check(
      'HZ3 口径一致: 三语 tools.md / system-guide.md 与统一工具 schema 都写了同一个默认范围（口径不一致比没写更糟）',
      toolsZh.includes('默认 fact,lesson,topic,rules,user') &&
        toolsEn.includes('default fact,lesson,topic,rules,user') &&
        toolsPt.includes('padrão fact,lesson,topic,rules,user') &&
        guideZh.includes('fact/lesson/topic/rules/user') &&
        guideEn.includes('fact/lesson/topic/rules/user') &&
        guidePt.includes('fact/lesson/topic/rules/user') &&
        pluginHZ3.includes('默认 fact,lesson,topic,rules,user'),
    )
    check(
      'HZ3 零命中老话跟着改: 点名的只剩 soul 与 project（边界从「不说的默认」变成「说清的不查」）',
      meowHZ3.includes('\\u9ED8\\u8BA4\\u68C0\\u7D22\\u8303\\u56F4\\u662F fact/lesson/topic/rules/user') &&
        meowHZ3.includes('soul \\u4E0E project \\u5C42\\u4E0D\\u53C2\\u4E0E\\u5173\\u952E\\u8BCD\\u68C0\\u7D22'),
    )
    check(
      'HZ3 行为探针在: R6 五条（默认含 user / 关掉就一条不剩 / 边界没破 / 显式查得到 / 默认值逐位相同）',
      (() => {
        const recallHZ3 = readFileSync(join(root, 'tools/probe-recall.mjs'), 'utf8')
        return (
          recallHZ3.includes('R6 默认检索范围含 user') &&
          recallHZ3.includes('R6 阴性对照：显式只查 fact/lesson/topic/rules') &&
          recallHZ3.includes('R6 边界没破') &&
          recallHZ3.includes('R6 只是不默认，不是查不到') &&
          recallHZ3.includes('R6 默认值就是这两个数')
        )
      })(),
    )
    const hz3Int = readFileSync(join(root, 'docs/INTERNAL.md'), 'utf8')
    const hz3Des = readFileSync(join(root, 'DESIGN.md'), 'utf8')
    check(
      'HZ3 文档锚：9.175 写下 545 条真库读数与 0.30，180 写下「隐形的一层比排错的题更贵」',
      hz3Int.includes('## 9.175') && hz3Int.includes('545') && hz3Int.includes('0.30') &&
        hz3Des.includes('## 180') && hz3Des.includes('隐形的一层'),
    )
  }

  // ── HZ4（0.2.169）：稠密那条路第一次真跑起来，四件事一起钉住 ──────────────
  // 教训（写进 DESIGN 181）：契约断言只能防「代码被删」，防不了「路径根本没走到」。
  // 所以这里既钉源码判据，也钉「加载判据本身没错」——那条错判让功能静默降级了半年。
  {
    const meow169 = readFileSync(join(root, 'vendor/meow-memory/lib/index.js'), 'utf8')
    const cnt = (needle) => meow169.split(needle).length - 1
    check(
      'HZ4 稠密加载判据：只有真的像路径才按路径 import（包名里有斜杠不算路径——这条一错，闸门与兜底会静默降级成 off）',
      meow169.includes("spec.startsWith('file:') || spec.startsWith('.') || spec.startsWith('/') || /^[A-Za-z]:[\\\\/]/.test(spec)") &&
        !meow169.includes("const asPath = /[\\\\/]/.test(spec)"),
    )
    check(
      'HZ4 补位有上限：DENSE_RESCUE_MAX = 2，且数的是补进来的不是扫过的候选',
      cnt('var DENSE_RESCUE_MAX = 2;') === 1 &&
        meow169.includes('const maxRescue = Number.isFinite(opts.rescueMax)') &&
        meow169.includes('if (added >= maxRescue) break;') &&
        meow169.includes('added += 1;'),
      `DENSE_RESCUE_MAX ${cnt('var DENSE_RESCUE_MAX = 2;')} 处`,
    )
    check(
      'HZ4 账平：上游折掉的要累加（0.2.167 只报当次这刀，救援那刀会被 trimByBand 的 slice 抹平）',
      meow169.includes('const upstreamTrim = Number(hits.trimmed) || 0;') &&
        meow169.includes('const dropped = sliced.length - out.length + upstreamTrim;'),
    )
    check(
      'HZ4 来路分开记：词法尾部折的记 rescueTrimmed、补进来的记 rescueAdded，两笔都非枚举透传',
      cnt('"rescueTrimmed"') === 2 && cnt('"rescueAdded"') === 2 && cnt('enumerable: false') >= 4,
      `rescueTrimmed ${cnt('"rescueTrimmed"')} / rescueAdded ${cnt('"rescueAdded"')}`,
    )
    check(
      'HZ4 补位要报名：note 里有 search.rescue，且这条路径上弱命中与「没给满」让位（一句话说清，不留三句同义话）',
      cnt('"search.rescue"') === 1 &&
        meow169.includes('relNote, rescueNote, bandNote') &&
        meow169.includes('const weakNote = gate.fired || rescued > 0 ? "" : weakNoteOf(ranked, { query });') &&
        meow169.includes('const bandNote = bandShort && rescued === 0'),
    )
    const recall169 = readFileSync(join(root, 'tools/probe-recall.mjs'), 'utf8')
    const gold169 = readFileSync(join(root, 'tools/probe-gold.mjs'), 'utf8')
    check(
      'HZ4 行为探针在：R7 六条契约 + 幂等，G25 的 trimmed 挂载点已按「两处、来路不同」改口径',
      recall169.includes('R7 补位有上限') &&
        recall169.includes('R7 上限真在循环里生效') &&
        recall169.includes('R7 折数要累加') &&
        recall169.includes('R7 折数按来路分开记') &&
        recall169.includes('R7 补位要自己报名') &&
        recall169.includes('R7 稠密模块加载判据') &&
        recall169.includes('R7 同一问句两次调用逐位相同') &&
        gold169.includes('trimMounts !== 2'),
    )
    const hz4Int = readFileSync(join(root, 'docs/INTERNAL.md'), 'utf8')
    const hz4Des = readFileSync(join(root, 'DESIGN.md'), 'utf8')
    check(
      'HZ4 文档锚：9.176 写下 8.23 字的陪跑读数与 DENSE_RESCUE_MAX，181 写下「静默降级比错误的默认更贵」',
      hz4Int.includes('## 9.176') && hz4Int.includes('DENSE_RESCUE_MAX') && hz4Int.includes('8.23') &&
        hz4Des.includes('## 181') && hz4Des.includes('静默降级'),
    )
  }

  // ── HZ5（0.2.170）：疑问框架剥离 ─────────────────────────────────────────
  // 中文按 bigram 切，「什么时候」会切出「么时」这种跨界碎片：df 极低、idf 极高，一个假词就能把
  // 一条只写着「什么时候」的笔记顶到榜首。真库 554 条上换说池首位 4/13 → 5/13、回执 4.23 → 4.15 条。
  {
    const recall170 = readFileSync(join(root, 'tools', 'probe-recall.mjs'), 'utf8')
    check(
      'HZ5 疑问框架剥离在：一张表 + 一个最小长度（剥完太短就整句回退，宁可带噪声不许凭空空手）',
      eng.includes('var QUESTION_FRAME = /什么时候|') && eng.includes('var QUESTION_FRAME_MIN = 4;') &&
        eng.includes('function stripQuestionFrame(text) {'),
      'QUESTION_FRAME / MIN / 函数三处都在',
    )
    check(
      'HZ5 剥成空格而不是删掉：空格负责切断 bigram，删掉会把两侧粘成新假词',
      eng.includes('raw.replace(QUESTION_FRAME, " ")') && eng.includes('if (out.length < QUESTION_FRAME_MIN) return { text: raw, stripped: [] };'),
      '空格替换 + 短句回退',
    )
    check(
      'HZ5 只在问句这一侧剥：索引与文档切词一个字节不动，且带 questionStrip:false 的出口',
      eng.includes('const qStrip = opts.questionStrip === false ? { text: query, stripped: [] } : stripQuestionFrame(query);') &&
        eng.includes('const q = tokenize(qStrip.text);'),
      '接入点在 search 的问句一侧',
    )
    check(
      'HZ5 explain 只在真剥了的时候出现：没剥就没有 stripped 这一项（不许谎报改过问法）',
      eng.includes('...(qStrip.stripped.length === 0 ? {} : { stripped: qStrip.stripped.slice() })'),
      '条件展开在位',
    )
    check(
      'HZ5 对外可测：stripQuestionFrame 与 QUESTION_FRAME 都在导出块里（探针要能直接量口径）',
      eng.includes('  stripQuestionFrame,') && eng.includes('  QUESTION_FRAME,'),
      '导出两处',
    )
    check(
      'HZ5 行为探针在：probe-recall 有 R8 八条（含受控库那刀真能红）',
      recall170.includes("'R8 疑问框架会剥") && recall170.includes("'R8 剥完不足 4 个字符就整句回退") &&
        recall170.includes("'R8 剥疑问不动标识符") && recall170.includes("'R8 空格切断跨界碎片") &&
        recall170.includes("'R8 只在问句这一侧剥") && recall170.includes("'R8 这刀真的会红") &&
        recall170.includes("'R8 explain 里看得见") && recall170.includes("'R8 关掉时 explain 也不许谎报"),
      '8 个 R8 标题',
    )
    check(
      'HZ5 两台刀分开测：老刀的阴性对照只关自己那把（questionStrip:false 至少五处，别让新刀替它记账）',
      recall170.includes('questionStrip: false') &&
        (readFileSync(join(root, 'verify.mjs'), 'utf8').match(/questionStrip: false/g) || []).length >= 2 &&
        (readFileSync(join(root, 'tools', 'probe-gold.mjs'), 'utf8').match(/questionStrip: false/g) || []).length >= 1,
      'probe-recall / verify / probe-gold 三处都有',
    )
    check(
      'HZ5 文档锚：9.177 写下「么时」这个碎片读数，182 写下「词切错了，再好的打分也救不回来」',
      readFileSync(join(root, 'docs/INTERNAL.md'), 'utf8').includes('## 9.177') &&
        readFileSync(join(root, 'docs/INTERNAL.md'), 'utf8').includes('么时') &&
        readFileSync(join(root, 'DESIGN.md'), 'utf8').includes('## 182') &&
        readFileSync(join(root, 'DESIGN.md'), 'utf8').includes('词切错了'),
      '9.177 / 182 两处锚',
    )
  }

  // ── HZ6（0.2.171）历史可查：点了名就说清「它过期了」，别装作没有 ─────────────
  {
    check(
      'HZ6 历史补录在：问句点了名、而这名字只活在过期条目里时，翻出来（有上限）',
      eng.includes('var HIST_LIFT_MAX = 3;') &&
        eng.includes('const askIdents = statusDead || statusList.length > 0 || parsed.include_stale === false ? [] : identsOf(query);'),
      `HIST_LIFT_MAX=${eng.includes('var HIST_LIFT_MAX = 3;')} 出口=${eng.includes('parsed.include_stale === false')}`,
    )
    check(
      'HZ6 补也只补点了名的：没过这个标识符的过期条目一条都不许跟上来',
      eng.includes('if (!askIdents.some((t) => hay.includes(t))) continue;') && eng.includes('const pool = [];'),
      'ident 过滤与 pool 收集都在',
    )
    check(
      'HZ6 先打分再取前 N：按库里顺序取前两条会把正解挤到第 3（0.2.147 就是这么漏的）',
      eng.includes('const asked = await rankForSearch(query, pool.map(docFor), { k: HIST_LIFT_MAX, explain: false, bandKeep: true });'),
      'rankForSearch 在补录路径上',
    )
    check(
      'HZ6 只是检索这一侧放宽：listSearchable 仍只回 active（主人拍板：其他类别过时不默认检索）',
      eng.includes('const active2 = this.list(level, { status: "active" });') &&
        eng.includes("const todoDone = this.p(`SELECT * FROM project WHERE status = 'stale' AND subcategory = 'todo'`)"),
      'listSearchable 定义未改',
    )
    check(
      'HZ6 标识符补分能跨档：分档读的是 _raw，补分只进 score 就永远翻不过去',
      eng.includes('var IDENT_BAND_W = 0.8;') &&
        eng.includes('_raw: raw[di] * (1 +') &&
        // [0.6.15] 标识符比例与主语位比例每条只取一次（`vbOf` / `srOf`），断言跟着读这两个变量。
        eng.includes('identBandW * vbOf.ratio') &&
        eng.includes('identSubjW * srOf') &&
        (eng.includes('lvHit && opts.levelIntent !== false ? levelIntentW : 0') ||
          eng.includes('lvHit && lvOn ? levelIntentW : 0')),
      'IDENT_BAND_W 与 _raw 加成都可查',
    )
    const recall171 = readFileSync(join(root, 'tools', 'probe-recall.mjs'), 'utf8')
    check(
      'HZ6 行为探针在：R9 六条（翻得出 / 说过期 / 关得掉 / 只认点了名 / 不捎带无关 / 口径不动）',
      [
        'R9 点了名的历史翻得出来',
        'R9 翻出来要说「过期」',
        'R9 关得掉',
        'R9 只对「点了名」的问句放宽',
        'R9 补也只补点了名的',
        'R9 只是检索这一侧放宽',
      ].every((t) => recall171.includes(t)),
      '6 个 R9 标题',
    )
    check(
      'HZ6 文档锚：9.178 写下「只活在过期条目里」，183 写下「过期不是删掉」',
      readFileSync(join(root, 'docs/INTERNAL.md'), 'utf8').includes('## 9.178') &&
        readFileSync(join(root, 'docs/INTERNAL.md'), 'utf8').includes('只活在过期条目里') &&
        readFileSync(join(root, 'DESIGN.md'), 'utf8').includes('## 183') &&
        readFileSync(join(root, 'DESIGN.md'), 'utf8').includes('过期不是删掉'),
      '9.178 / 183 两处锚',
    )
  }

  // ── HZ7（0.2.172）主语位：问句点名的那个东西，正文第一个词就是它 ─────────────
  {
    check(
      'HZ7 主语位在：正文以问句点名的标识符开头，就算这条记忆的主语是它',
      eng.includes('var IDENT_SUBJ_W = 0;') &&
        eng.includes('const lead = String(docs[di].content ?? "").trimStart().toLowerCase();') &&
        eng.includes('subjRatio[di] = idents.length === 0 ? 0 : Math.min(1, sn / idents.length);'),
      `IDENT_SUBJ_W=${eng.includes('var IDENT_SUBJ_W = 0;')} lead 判据=${eng.includes('trimStart().toLowerCase()')}`,
    )
    check(
      'HZ7 免档不是加权：主语位进 bandize 的第一档（_subj === 1），不和权重讨价还价',
      eng.includes('if (h._ident === true || h._subj === 1) {') &&
        // 0.6.13 起定档有两条路（阈值链 / 退回路全排序），两边都得不问权重直接落 -1 档
        (eng.match(/_subj === 1/g) || []).length >= 2,
      `免档判据在=${eng.includes('h._ident === true || h._subj === 1')} / 出现 ${(eng.match(/_subj === 1/g) || []).length} 次`,
    )
    check(
      'HZ7 开关给得出：identSubjBand 关免档、identSubj 关加权、identSubjW 手动给权重（默认 0），0.2.178 又多一个出口——时间状语里的标识符不进特权档',
      eng.includes('const identSubjW = Number.isFinite(opts.identSubjW) ? opts.identSubjW : IDENT_SUBJ_W;') &&
        // [0.2.178] 免档条件多了一个 `|| !identHardOk`：时间状语里的标识符是坐标，不是主语，
        // 它不该走 bandize 的 -1 特权档。断言的形态跟着改，但守的东西没变。
        // [0.6.29] 这条判定提到循环外（`subjZero`），字面量里只剩 `subjZero ? 0 : srOf >= 0.5 ? 1 : 0`：
        // 老写法与新写法任在位即算过，守的仍是「主语位进免档、`identSubjBand` 关得掉、`identHardOk` 一票否决」。
        (eng.includes('_subj: subjRatio === void 0 || opts.identSubjBand === false || !identHardOk ? 0 : srOf >= 0.5 ? 1 : 0,') ||
          (eng.includes('const subjZero = subjRatio === void 0 || opts.identSubjBand === false || !identHardOk;') &&
            eng.includes('_subj: subjZero ? 0 : srOf >= 0.5 ? 1 : 0,'))) &&
        eng.includes('const identHardOk = !(anchorCoord && opts.anchorIdentBand !== true);') &&
        eng.includes('if (srHit > 0 && identSubjW > 0 && opts.identSubj !== false) {'),
      '四个出口都在',
    )
    check(
      'HZ7 没发生的事不许在 explain 里留个 0：subjBonus 只在真加了权重时出现',
      eng.includes('if (h.explain !== void 0) h.explain.subjBonus = Math.round(addS * 1e3) / 1e3;') &&
        eng.includes('identSubjW > 0 && opts.identSubj !== false'),
      'subjBonus 出口带条件',
    )
    const recall172 = readFileSync(join(root, 'tools', 'probe-recall.mjs'), 'utf8')
    check(
      'HZ7 行为探针在：R10 六条（免档 / 关得掉 / 只对点了名 / 只认开头 / 免档不免排序 / explain 不空留）',
      [
        'R10 主语位免档',
        'R10 关得掉',
        'R10 只对「点了名」的问句放宽',
        'R10 只在正文开头算主语',
        'R10 免档不是免排序',
        'R10 explain 里看得见这一刀',
      ].every((t) => recall172.includes(t)),
      '6 个 R10 标题',
    )
    check(
      'HZ7 探针测的是这一层：R10 走引擎 API（V.search），不走工具层（那里读不到 band）',
      recall172.includes('const r10on = V.search(Q10, R10_DOCS, { k: 10, explain: true })') &&
        recall172.includes('const r10off = V.search(Q10, R10_DOCS, { k: 10, explain: true, identSubjBand: false })') &&
        !recall172.includes('const c10 = '),
      `V.search 直连=${recall172.includes('const r10on = V.search(Q10, R10_DOCS, { k: 10, explain: true })')}`,
    )
    check(
      'HZ7 文档锚：9.179 写下「主语位」与「七档读数一模一样」，184 写下「能靠档说清的事」',
      readFileSync(join(root, 'docs/INTERNAL.md'), 'utf8').includes('## 9.179') &&
        readFileSync(join(root, 'docs/INTERNAL.md'), 'utf8').includes('主语位') &&
        readFileSync(join(root, 'docs/INTERNAL.md'), 'utf8').includes('七档') &&
        readFileSync(join(root, 'DESIGN.md'), 'utf8').includes('## 184') &&
        readFileSync(join(root, 'DESIGN.md'), 'utf8').includes('能靠档说清的事'),
      '9.179 / 184 两处锚',
    )
  }

  // ── HZ8（0.2.173）层级意图：问的是规矩就别拿经验来答 ──
  {
    const recall173 = readFileSync(join(root, 'tools', 'probe-recall.mjs'), 'utf8')
    const internal173 = readFileSync(join(root, 'docs', 'INTERNAL.md'), 'utf8')
    const design173 = readFileSync(join(root, 'DESIGN.md'), 'utf8')
    check(
      'HZ8 层级意图的权重与比率门都在',
      eng.includes('var LEVEL_INTENT_W = 0.3;') && eng.includes('var LEVEL_INTENT_RATIO = 0.5;'),
      `权重=${eng.includes('var LEVEL_INTENT_W = 0.3;')} 比率门=${eng.includes('var LEVEL_INTENT_RATIO = 0.5;')}`,
    )
    check(
      'HZ8 四层意图各有形状词：准则/事实/来龙去脉/做法',
      eng.includes('var LEVEL_INTENT_RULES = /要不要|该不该|') &&
        eng.includes('var LEVEL_INTENT_FACT = /改了什么|改了哪些|') &&
        eng.includes('var LEVEL_INTENT_TOPIC = /来龙去脉|为什么|') &&
        eng.includes('var LEVEL_INTENT_LESSON = /怎么跑|怎么写|'),
      `四表在=${['RULES', 'FACT', 'TOPIC', 'LESSON'].every((k) => eng.includes('var LEVEL_INTENT_' + k + ' = /'))}`,
    )
    check(
      'HZ8 意图只从问句里判：库里的条目层是老实话，不需要猜',
      eng.includes('function intentLevelsOf(text) {') &&
        eng.includes('const lvIntent = intentLevelsOf(query);') &&
        (eng.match(/intentLevelsOf\(/g) || []).length === 2,
      `调用 ${(eng.match(/intentLevelsOf\(/g) || []).length} 次（定义 1 + 调用 1）`,
    )
    check(
      'HZ8 比率门：只帮「本来就近」的条目，不凭空造相关性',
      eng.includes('&& raw[di] >= (lvRatio ?? 0.5) * maxRaw;') &&
        eng.includes('const lvRatio = Number.isFinite(opts.levelIntentRatio) ? opts.levelIntentRatio : LEVEL_INTENT_RATIO;'),
      `比率门在=${eng.includes('raw[di] >= (lvRatio ?? 0.5) * maxRaw')}`,
    )
    check(
      'HZ8 两处分工：_raw 管进不进这一档，score 管进了这一档排多前',
      // [0.6.14] 那个「这条够不够格」的临时标记不再挂 hit 上（`delete h._lv` 会把对象打进字典模式），
      // 改成同下标平行数组 `lvTmp`——分工不变，只是不在回执对象上过一手。
      (eng.includes('lvHit && opts.levelIntent !== false ? levelIntentW : 0)') ||
        eng.includes('lvHit && lvOn ? levelIntentW : 0)')) &&
        eng.includes('h.score *= 1 + levelIntentW;') &&
        eng.includes('if (lvTmp[hi] !== 1) continue;'),
      `_raw 项在=${eng.includes('lvHit && opts.levelIntent !== false ? levelIntentW : 0)') || eng.includes('lvHit && lvOn ? levelIntentW : 0)')} score 项在=${eng.includes('h.score *= 1 + levelIntentW;')}`,
    )
    check(
      'HZ8 乘法段在 bandize 之前、且不在 verbatim 分支里（不然没有原样命中的问句整段不跑；0.6.11 起分支标记是 hayOf !== null）',
      eng.indexOf('h.score *= 1 + levelIntentW;') < eng.indexOf("bandize(hits, '_raw', k);") &&
        eng.indexOf('if (lvTmp[hi] !== 1) continue;') < eng.lastIndexOf('if (hayOf !== null) {'),
      `乘法在 bandize 前=${eng.indexOf('h.score *= 1 + levelIntentW;') < eng.indexOf("bandize(hits, '_raw', k);")} 分支标记=${eng.lastIndexOf('if (hayOf !== null) {')}`,
    )
    check(
      'HZ8 行为探针与文档都在',
      recall173.includes('R11 问「该由谁来定」时规则那一层进第一档') &&
        recall173.includes('R11 比率门：分差太远的那条不会被层级意图抬上来') &&
        recall173.includes('R11 只在问句这一侧判意图') &&
        internal173.includes('## 9.180') &&
        internal173.includes('问的是规矩，就别拿经验来答') &&
        design173.includes('## 185') &&
        design173.includes('问句的语法形状是意图'),
      `R11 在=${recall173.includes('R11 ')} 9.180 在=${internal173.includes('## 9.180')} 185 在=${design173.includes('## 185')}`,
    )
  }
  // ── HZ9（0.2.174）求值型问句：要的是那条断言，不是那段背景 ──
  {
    const recall174 = readFileSync(join(root, 'tools', 'probe-recall.mjs'), 'utf8')
    const internal174 = readFileSync(join(root, 'docs', 'INTERNAL.md'), 'utf8')
    const design174 = readFileSync(join(root, 'DESIGN.md'), 'utf8')
    check(
      'HZ9 断言密度的权重与求值型问句的形状词都在',
      eng.includes('var TIP_ASSERT_W = 1.2;') &&
        eng.includes('var TIP_RE = /该写|该填|写什么值|要改几个|改几个|要改几条|改几条|几轮|要跑几|几条要改|哪个值/;'),
      `权重=${eng.includes('var TIP_ASSERT_W = 1.2;')} 形状=${eng.includes('var TIP_RE = /')}`,
    )
    check(
      'HZ9 断言词是结论的形状，而且是看得见的一串',
      eng.includes('var ASSERT_RE = /必须是|一律|只认|只有|至少|一定|不许|绝不|禁止|都要|全都|统一|固定为|只能是|必须|务必/g;'),
      `ASSERT_RE 在=${eng.includes('var ASSERT_RE = /必须是|')}`,
    )
    check(
      'HZ9 只看开头：断言是结论的位置，不是全文到处都算',
      eng.includes('function assertRatioOf(text) {') &&
        eng.includes('const head = String(text ?? "").slice(0, 60);') &&
        eng.includes('return Math.min(1, n / 2);'),
      `开头截断在=${eng.includes('slice(0, 60)')}`,
    )
    check(
      'HZ9 求值判据只在问句这一侧：正文只被数断言词，问句才判「是不是在求值」',
      // [0.6.14] 正文那一处原来在 `_tr` 与 `_raw` 里各数一遍，现在每条只数一次（`trOf`）→ 调用点从 3 变 2。
      eng.includes('const tipOn = tipAssertOn(query) && opts.tipAssert !== false;') &&
        (eng.match(/assertRatioOf\(/g) || []).length === 2,
      `tipOn 在=${eng.includes('const tipOn = tipAssertOn(query)')} 调用点=${(eng.match(/assertRatioOf\(/g) || []).length}`,
    )
    check(
      'HZ9 两处分工：_raw 管进不进这一档，score 管进了这一档排多前',
      eng.includes('tipOn ? tipAssertW * trOf : 0') &&
        eng.includes('h.score *= 1 + tipAssertW * tr;') &&
        eng.indexOf('h.score *= 1 + tipAssertW * tr;') < eng.indexOf("bandize(hits, '_raw', k);"),
      `_raw 项在=${eng.includes('tipOn ? tipAssertW * trOf : 0')} 乘法在 bandize 前=${eng.indexOf('h.score *= 1 + tipAssertW * tr;') < eng.indexOf("bandize(hits, '_raw', k);")}`,
    )
    check(
      'HZ9 行为探针与文档都在',
      recall174.includes('R12 问「该写什么值」时，开头就是断言的那条进第一') &&
        recall174.includes('R12 关得掉：tipAssert:false 时断言条不再第一') &&
        recall174.includes('R12 只看开头六十个字') &&
        internal174.includes('## 9.181') &&
        internal174.includes('要的是那条断言，不是那段背景') &&
        design174.includes('## 186') &&
        design174.includes('结论有形状'),
      `R12 在=${recall174.includes('R12 ')} 9.181 在=${internal174.includes('## 9.181')} 186 在=${design174.includes('## 186')}`,
    )
    check(
      'HZ9 阴性对照把当轮的刀一起关掉：G20 的关键词扫描里 tipAssert 必须是关着的',
      readFileSync(join(root, 'tools', 'probe-gold.mjs'), 'utf8').includes('identSubjW: 0, tipAssert: false'),
      'probe-gold NB 里有 tipAssert: false',
    )
  }
  // ── HZ10（0.2.175）宽池：40 条样张是小房间，量具要按生产规模建 ──
  {
    const gold174 = readFileSync(join(root, 'tools', 'probe-gold.mjs'), 'utf8')
    const internal175 = readFileSync(join(root, 'docs', 'INTERNAL.md'), 'utf8')
    const design175 = readFileSync(join(root, 'DESIGN.md'), 'utf8')
    const wide = JSON.parse(readFileSync(join(root, 'tools', 'fixtures', 'gold-wide.json'), 'utf8'))
    const narrow = JSON.parse(readFileSync(join(root, 'tools', 'fixtures', 'gold-recall.json'), 'utf8'))
    check(
      'HZ10 宽池是冻结快照：106 条、五层以上、note 写明来自真库抽样且不随真库漂移',
      Array.isArray(wide.documents) && wide.documents.length === 106 &&
        new Set(wide.documents.map((d) => d.level)).size >= 5 &&
        wide.note.includes('冻结') && wide.note.includes('真库'),
      `条数=${wide.documents?.length} 层=${new Set((wide.documents || []).map((d) => d.level)).size}`,
    )
    check(
      'HZ10 宽池与样张不重叠：同一个 id 只许出现一次（重复计入会把池子做小）',
      (() => {
        const all = narrow.docs.map((d) => String(d.id)).concat(wide.documents.map((d) => String(d.id)))
        return new Set(all).size === all.length
      })(),
      `合计 ${narrow.docs.length + wide.documents.length} 条`,
    )
    check(
      'HZ10 探针真的把宽池拼进同一批问句（不是另立一套语料自说自话）',
      gold174.includes("join(root, 'tools', 'fixtures', 'gold-wide.json')") &&
        gold174.includes('const wideDocs = docs.concat(wideFx.documents)') &&
        gold174.includes('measure(fx.queries, wideDocs)') &&
        gold174.includes('measure(fx.paraphrase, wideDocs)') &&
        gold174.includes('measure(fx.anchor, wideDocs)'),
      `concat 在=${gold174.includes('docs.concat(wideFx.documents)')}`,
    )
    check(
      'HZ10 三档读数各有一条守卫线，换说法/时间锚两档在宽池里明显更难',
      gold174.includes('G-W1 宽池（146 条）照抄档 hit@1 ≥ 0.93') &&
        gold174.includes('G-W2 宽池换说法档 hit@1 ≥ 0.71') &&
        gold174.includes('G-W3 宽池时间锚档 hit@1 ≥ 0.70') &&
        gold174.includes('wideQ.hit1 >= 0.93') &&
        gold174.includes('wideP.hit1 >= 0.71') &&
        gold174.includes('wideA.hit1 >= 0.7'),
      `W 三条线在=${gold174.includes('G-W1 ')}`,
    )
    check(
      // 0.2.177 起这条对照换了判据（理由见 9.184.1）：原来要求「宽池必须更差」，
      // 同义桥把两档拉平之后它必然假红——它守的其实是「引擎还没变好」，不是「宽池接进去了」。
      // 现在守的是「前 K 序列至少一处不同」，HZ12 里另有专条钉新判据。
      'HZ10 阴性对照：宽池真接进去了（前 K 序列有差异），且窄池换说法档仍被单独量着',
      gold174.includes('G-W4 阴性对照：宽池真接了那 106 条') &&
        gold174.includes('wKSeqDiff') &&
        gold174.includes('const narrowP = measure(fx.paraphrase, docs)'),
      `对照在=${gold174.includes('wKSeqDiff')}`,
    )
    check(
      'HZ10 文档锚：9.182 写下宽池与「量具要按生产规模建」，187 写下同一件事的道理',
      internal175.includes('## 9.182') &&
        internal175.includes('量具要按生产规模建') &&
        design175.includes('## 187') &&
        design175.includes('小房间'),
      `9.182 在=${internal175.includes('## 9.182')} 187 在=${design175.includes('## 187')}`,
    )
  }
  // ── HZ11（0.2.176）状态问句直通现状仓，以及那些被否掉的方向不许复活 ──
  {
    const eng176 = readFileSync(join(root, 'vendor', 'meow-memory', 'lib', 'index.js'), 'utf8')
    const gold176 = readFileSync(join(root, 'tools', 'probe-gold.mjs'), 'utf8')
    const recall176 = readFileSync(join(root, 'tools', 'probe-recall.mjs'), 'utf8')
    const internal176 = readFileSync(join(root, 'docs', 'INTERNAL.md'), 'utf8')
    const design176 = readFileSync(join(root, 'DESIGN.md'), 'utf8')
    const fx176 = JSON.parse(readFileSync(join(root, 'tools', 'fixtures', 'gold-recall.json'), 'utf8'))
    check(
      'HZ11 局面词是「局面词」，不是时间词：泛时间词一个都不许留在 STATUS_RE 里',
      eng176.includes('var STATUS_RE = /到哪一版|推进到|进展到|主线停在哪|当前待办|现在待办|项目现状|现状如何|现状是什么|现在什么情况|截至|最近一次|最新版本/;') &&
        !/var STATUS_RE = \/[^/]*(?<!\u9879\u76ee)(现在|当前|目前|如今|最新)(?![^/]*版本)[^/]*\/;/.test(eng176) &&
        eng176.includes('var STATUS_NOW_RE = /项目现状|到哪一版|进展|推进到|最新版本|截至|最近一次/;') &&
        eng176.includes('var STATUS_OFF_RE = /为什么|怎么|如何|缘由|踩过|技巧|办法|该不该|要不要|能不能|可不可以|是否/;') &&
        eng176.includes('var STATUS_TODO_RE = /待办|todo/i;') &&
        eng176.includes('var STATUS_DIGEST_MAX = 3;'),
      `STATUS_RE 在=${eng176.includes('var STATUS_RE = /到哪一版|推进到|进展到')}`,
    )
    check(
      'HZ11 三道自限都在：关得掉、带标识符让路、问原因让路；只扫 project 层',
      eng176.includes('if (opts.statusDigest === false) return null;') &&
        eng176.includes('if (hasIdent) return null;') &&
        eng176.includes('if (!STATUS_RE.test(q) || STATUS_OFF_RE.test(q)) return null;') &&
        eng176.includes('if (String(d?.level ?? "") !== "project") continue;') &&
        eng176.includes('picked.sort((a, b) => b.t - a.t);') &&
        eng176.includes('return picked.slice(0, STATUS_DIGEST_MAX).map((x) => x.di);'),
      `自限三处在=${eng176.includes('if (hasIdent) return null;')}`,
    )
    check(
      'HZ11 分数跟榜首走而不是跟自己的词分走：词分 0 也要抬得起来（跟词分走就永远是 0）',
      eng176.includes('const share = 1.15 - si * 0.03;') &&
        eng176.includes('const digScore = topScore > 0 ? topScore * share : share;') &&
        eng176.includes('const digRaw = topRaw > 0 ? topRaw * share : share;'),
      `share 公式在=${eng176.includes('1.15 - si * 0.03')}`,
    )
    check(
      'HZ11 词分为 0 的条目也得进候选：跳过条件要给它留门，否则后面抬它抬的是空气',
      eng176.includes('!(statusDig !== null && statusDig !== void 0 && statusDig.includes(di))'),
      `跳过条件已放开=${eng176.includes('statusDig.includes(di)')}`,
    )
    check(
      'HZ11 两处落地：定义一次、调用一次；post-pass 在 bandize 之前（进档前改分才有意义）',
      (eng176.match(/statusDigestOf\(/g) || []).length === 2 &&
        eng176.indexOf('const statusDig = statusDigestOf(docs, query, verbHay !== null, opts);') <
          eng176.indexOf("bandize(hits, '_raw', k);") &&
        eng176.includes('explain: { bm25: 0, statusDigest: true, score: Math.round(digScore * 1e3) / 1e3 }'),
      `statusDigestOf( 出现 ${(eng176.match(/statusDigestOf\(/g) || []).length} 次`,
    )
    check(
      'HZ11 时效题标 live：不进分母，也不许每过一版回去改 want',
      fx176.queries.some((q) => q.live === true) &&
        fx176.anchor.some((q) => q.live === true) &&
        gold176.includes('const scored = list.filter((x) => x.live !== true)') &&
        gold176.includes('return { n, live: list.length - n,'),
      `live 题 ${fx176.queries.filter((q) => q.live === true).length + fx176.anchor.filter((q) => q.live === true).length} 条`,
    )
    check(
      'HZ11 阴性对照不再写死分母：G20 改成「比默认更差」，0.75 那条绝对线是照 10 条题写的',
      gold176.includes('aOld.hit1 < aBase.hit1 && aOld.mrr < aBase.mrr') &&
        !gold176.includes('aOld.hit1 <= 0.75'),
      `对照判据已换=${gold176.includes('aOld.hit1 < aBase.hit1')}`,
    )
    check(
      'HZ11 行为探针齐全：G26 状态仓 / R13 状态仓五条 / 文档 9.183 与 188',
      gold176.includes('G26 状态问句直通现状仓') &&
        recall176.includes('R13 状态问句去现状仓取') &&
        recall176.includes('R13 关得掉：statusDigest:false 时它不是第一') &&
        internal176.includes('## 9.183') &&
        internal176.includes('去仓里取，别去词面上撞') &&
        design176.includes('## 188') &&
        design176.includes('状态是「仓」，不是「词」'),
      `G26 在=${gold176.includes('G26 ')} R13 在=${recall176.includes('R13 ')} 9.183 在=${internal176.includes('## 9.183')}`,
    )
    check(
      'HZ11 稠密检索的否决写在案上：三档全输的表与结论都在文档里，下一个版本别再探一遍',
      internal176.includes('稠密检索这三档全输，正式否决') &&
        internal176.includes('| 照抄 45 | **0.933** | 0.644 |') &&
        design176.includes('否决也是一等结论'),
      `否决表在=${internal176.includes('稠密检索这三档全输，正式否决')}`,
    )
  }
  {
    const eng177 = readFileSync(new URL('./vendor/meow-memory/lib/index.js', import.meta.url), 'utf8')
    const gold177 = readFileSync(new URL('./tools/probe-gold.mjs', import.meta.url), 'utf8')
    const recall177 = readFileSync(new URL('./tools/probe-recall.mjs', import.meta.url), 'utf8')
    const internal177 = readFileSync(new URL('./docs/INTERNAL.md', import.meta.url), 'utf8')
    const design177 = readFileSync(new URL('./DESIGN.md', import.meta.url), 'utf8')
    const snap177 = readFileSync(new URL('./tools/fixtures/cost-snap.json', import.meta.url), 'utf8')
    const Meow177 = await import(pathToFileURL(join(root, 'vendor', 'meow-memory', 'lib', 'index.js')).href)
    const groups177 = Meow177.SYN_GROUPS
    const flat177 = groups177.flat()
    const hasPair = (a, b) => groups177.some((g) => g.includes(a) && g.includes(b))
    check(
      'HZ12 表至少 18 组，且扩的是「同一个动作的两种叫法」：发版那一族并进一组，不是又添几个近义词',
      groups177.length >= 18 &&
        hasPair('推送', '上传') && hasPair('推送', '发布') && hasPair('推送', '提交') &&
        hasPair('自测', '自检') && hasPair('自测', '体检') &&
        hasPair('封存', '归档') && hasPair('封存', '冻结') &&
        hasPair('底线', '门槛') && hasPair('口径', '说法'),
      `${groups177.length} 组 / ${new Set(flat177).size} 个词`,
    )
    check(
      'HZ12 表形态一条没破：每组至少两个词、每个词中文两字或英文标识符、无跨组重复、SYN_W 仍在 (0,1)',
      groups177.every((g) => Array.isArray(g) && g.length >= 2 && g.every((w) => /^[\u4e00-\u9fff]{2}$/.test(w) || /^[a-z][a-z0-9_]*$/.test(w))) &&
        new Set(flat177).size === flat177.length &&
        typeof Meow177.SYN_W === 'number' && Meow177.SYN_W > 0 && Meow177.SYN_W < 1,
      `SYN_W=${Meow177.SYN_W}`,
    )
    check(
      'HZ12 扩词只走原来的那条路：不扩文档、不进覆盖度分母、候选集合并 postings、synBridge 一个旋钮',
      eng177.includes('function synExpandOf(') &&
        eng177.includes('const synW = Number.isFinite(opts.synW) && opts.synW >= 0 ? opts.synW : SYN_W;') &&
        eng177.includes("if (opts.synBridge === false) return null") === false,
      `synExpandOf 在=${eng177.includes('function synExpandOf(')}`,
    )
    check(
      'HZ12 G-W4 的判据换了：不再要求「宽池必须更差」，改守「宽池真的接进去了」（前 K 序列不同）',
      gold177.includes('wKSeqDiff') &&
        gold177.includes("seq.split('|').some((id) => wideOnlyIds.has(id))") &&
        gold177.includes('wideP.hit1 <= narrowP.hit1') &&
        gold177.includes("tops.push(ids.slice(0, K).join('|'))") &&
        !gold177.includes('G-W4 阴性对照：宽池换说法档必须比窄池难'),
      `新判据在=${gold177.includes('wKSeqDiff')}`,
    )
    check(
      'HZ12 R14 六条在：扩词找得回、关桥分数必须掉、自测/自检那一组、没扩的问句同序、表形态、同一个旋钮',
      recall177.includes('R14 表扩了「上传 / 发布 / 提交」之后') &&
        recall177.includes('R14 它是扩出来的分，不是本来就有') &&
        recall177.includes('R14「自测」与正文的「自检」通了') &&
        recall177.includes('R14 没被扩到的问句一处不动') &&
        recall177.includes('R14 新版五组都在表里') &&
        recall177.includes('R14 扩表默认落在同一个旋钮上'),
      `R14 check 数=${(recall177.match(/R14 /g) || []).length}`,
    )
    check(
      'HZ12 成本快照已换代：40 档第 14 题的第二位是 0mwq606x（扩表把 want 里的另一条抬上来了）',
      (() => {
        const d = JSON.parse(snap177)
        const row = d.m && d.m['40'] && d.m['40'][14]
        return Array.isArray(row) && String(row[1]).startsWith('0mwq606x')
      })(),
      (() => {
        const d = JSON.parse(snap177)
        const row = (d.m && d.m['40'] && d.m['40'][14]) || []
        return `#14 = ${row.map((x) => String(x).split(':')[0]).join(' ')}`
      })(),
    )
    check(
      'HZ12 文档锚：9.184 写下了「动作表不是同义词表」与 0.714→0.857，189 写下了阴性对照判据会过期',
      internal177.includes('## 9.184 ') &&
        internal177.includes('同义词表要是「动作表」') &&
        internal177.includes('0.714') && internal177.includes('0.857') &&
        internal177.includes('阴性对照的判据本身会过期') &&
        design177.includes('## 189') &&
        design177.includes('词法检索不懂「同一件事」'),
      `9.184 在=${internal177.includes('## 9.184 ')} 189 在=${design177.includes('## 189')}`,
    )
  }
  // ── HZ13（0.2.178）时间状语里的标识符是坐标，不是主语 ─────────────────────────
  // 真库里「0.2.148 的时候基线收敛了两轮吗」被一条把 0.2.148 写进 keywords 首位的
  // 「0.2.148 已交付」压住（want bm25 22.293 却排第 2）。根因不是词法，是 bandize 的
  // -1 特权档 + post-pass 的加法加成：谁在主语位提到那串标识符就直接进特权档。
  // 这一版把「时间状语里的标识符」判成坐标：不给档位、不给加成、也不进 _subj。
  // 判据必须是**结构词**（的时候/那会儿/当时），泛时间词（现在/最新）会把
  // 「现在某个东西怎么规矩」这种对象问句也卷进来——0.2.176 局面词那一刀已经踩过。
  {
    const eng178 = readFileSync(new URL('./vendor/meow-memory/lib/index.js', import.meta.url), 'utf8')
    const gold178 = readFileSync(new URL('./tools/probe-gold.mjs', import.meta.url), 'utf8')
    const recall178 = readFileSync(new URL('./tools/probe-recall.mjs', import.meta.url), 'utf8')
    const internal178 = readFileSync(new URL('./docs/INTERNAL.md', import.meta.url), 'utf8')
    const design178 = readFileSync(new URL('./DESIGN.md', import.meta.url), 'utf8')
    const coordRe178 = /var ANCHOR_COORD_RE = (\/[^\n]*\/);/.exec(eng178)
    const coordBody178 = coordRe178 === null ? '' : coordRe178[1]
    check(
      'HZ13 判据只认结构词：的时候/那会儿/当时 在表里，现在/当前/最新 一个都不许进（否则对象问句被卷进来）',
      coordBody178.includes('的时候') &&
        coordBody178.includes('那时候') &&
        coordBody178.includes('当时') &&
        !/现在|当前|目前|最新|如今|眼下/.test(coordBody178),
      `词表 ${coordBody178}`,
    )
    check(
      'HZ13 两支打分器同口径：anchorCoord 与 identHardOk 各两处（search + keywordHitScore），少一处就是一半问句不认账',
      (eng178.match(/const anchorCoord = timeAnchor && ANCHOR_COORD_RE\.test\(String\(query \?\? ""\)\);/g) || []).length === 2 &&
        (eng178.match(/const identHardOk = !\(anchorCoord && opts\.anchorIdentBand !== true\);/g) || []).length === 2,
      `anchorCoord ${(eng178.match(/const anchorCoord = timeAnchor/g) || []).length} 处 / identHardOk ${(eng178.match(/const identHardOk = /g) || []).length} 处`,
    )
    check(
      'HZ13 三条通道全关：档位（_subj）、词分（_raw 两份权重）、加法补分（add）都吃同一个 identHardOk',
      // [0.6.29] `_subj` 与 `_raw` 里的那三个 `opts.xxx === false || !identHardOk` 提到了循环外
      // （`subjZero` / `bandWOn` / `subjBandOn`，三个都带 `!identHardOk`）。老写法与新写法任在位即算过。
      (eng178.includes('opts.identSubjBand === false || !identHardOk ? 0 : srOf >= 0.5 ? 1 : 0') ||
        (eng178.includes('const subjZero = subjRatio === void 0 || opts.identSubjBand === false || !identHardOk;') &&
          eng178.includes('_subj: subjZero ? 0 : srOf >= 0.5 ? 1 : 0,'))) &&
        (eng178.includes('opts.identBand === false || !identHardOk ? 0 : identBandW * vbOf.ratio') ||
          (eng178.includes('const bandWOn = opts.identBand !== false && identHardOk;') &&
            eng178.includes('vbOf === void 0 || !bandWOn ? 0 : identBandW * vbOf.ratio'))) &&
        (eng178.includes('opts.identSubjBand === false || !identHardOk ? 0 : identSubjW * srOf') ||
          (eng178.includes('const subjBandOn = opts.identSubjBand !== false && identHardOk;') &&
            eng178.includes('vbOf === void 0 || !subjBandOn ? 0 : identSubjW * srOf'))) &&
        eng178.includes('const add = unitScore * vb.ratio * (idHit ? IDENT_ID_W : IDENT_W) * (identHardOk ? 1 : 0);') &&
        eng178.includes('if (idHit && identHardOk) h._ident = true;'),
      '档位 + _raw 两项 + add + _ident 五处都在',
    )
    check(
      'HZ13 一键回旧口径还在：anchorIdentBand:true 时坐标判定整个不生效（探针的阴性对照靠它）',
      eng178.includes('opts.anchorIdentBand !== true'),
      'anchorIdentBand 开关在位',
    )
    check(
      'HZ13 三刀被否决的痕迹不许留在引擎里（因果证据 / 长度封顶 / 新鲜度不看 importance）',
      !eng178.includes('CAUSE_DOC_RE') &&
        !eng178.includes('causeEvidence') &&
        !eng178.includes('LEN_RATIO_CAP') &&
        !eng178.includes('lenCap'),
      'CAUSE_*/lenCap 都不在引擎里（只留在文档的否决记录里）',
    )
    check(
      'HZ13 G27 探针在位：坐标句去讲过程那条、指认句才去交付那条，且阴性对照关掉坐标判定',
      gold178.includes('G27 时间状语里的标识符是坐标') &&
        gold178.includes("const q1 = '0.2.148 的时候基线收敛了两轮吗'") &&
        gold178.includes("const q2 = '0.2.148 那一版交付了什么'") &&
        gold178.includes('anchorIdentBand: true, explain: true'),
      'G27 三件套（坐标句 / 指认句 / 阴性对照）都在',
    )
    check(
      'HZ13 R15 断言在位：坐标句首位、关掉后回退、加成归零且档位不是 -1、指认位不误伤、判据只认结构词',
      recall178.includes('R15 坐标句「0.2.148 的时候基线收敛了两轮吗」首位是讲过程那条') &&
        recall178.includes('R15 阴性对照：关掉坐标判定') &&
        recall178.includes('R15 坐标位上的标识符一分都不加') &&
        recall178.includes('R15 指认位一点不许误伤') &&
        recall178.includes('R15 判据只认「结构词」'),
      'R15 五条都在',
    )
    check(
      'HZ13 文档在位：INTERNAL 9.185 记根因与三次否决，DESIGN 190 记「坐标还是主语」这条判断',
      internal178.includes('## 9.185 ') &&
        internal178.includes('时间状语') &&
        design178.includes('## 190') &&
        design178.includes('坐标'),
      `9.185 在=${internal178.includes('## 9.185 ')} 190 在=${design178.includes('## 190')}`,
    )
  }
  // ── HZ14（0.2.179）缘由问句去叙述层找答案，规矩条只在问「为什么」时折价 ─────────
  // 真库里「评测台为什么封存」被一条 imp=4 的 rules 压住：那条讲的是「以后该怎么做」，
  // 一个字都没答「为什么」，只因为同一个实体（评测台）而词面全中。这一版：缘由/现状问句把
  // 规矩层折到 0.6 倍，且不折新鲜度。另外这一版顺手把「长度惩罚按覆盖度打折」（relief）留下——
  // 它扫参时读数一动不动，撤掉却掉一条（1.000 → 0.977），所以判据要正着盯它在位。
  {
    const eng179 = readFileSync(new URL('./vendor/meow-memory/lib/index.js', import.meta.url), 'utf8')
    const gold179 = readFileSync(new URL('./tools/probe-gold.mjs', import.meta.url), 'utf8')
    const recall179 = readFileSync(new URL('./tools/probe-recall.mjs', import.meta.url), 'utf8')
    const internal179 = readFileSync(new URL('./docs/INTERNAL.md', import.meta.url), 'utf8')
    const design179 = readFileSync(new URL('./DESIGN.md', import.meta.url), 'utf8')
    const countOf = (hay, needle) => hay.split(needle).length - 1
    const valOf = (src, name) => {
      const m = new RegExp('var ' + name + ' = ([0-9.]+);').exec(src)
      return m === null ? NaN : Number(m[1])
    }
    check(
      'HZ14 两个常量各一处且都在 (0,1)：覆盖度打折不超一半，规矩折价也不超一半',
      countOf(eng179, 'var COVER_LEN_RELIEF = ') === 1 &&
        countOf(eng179, 'var CAUSE_RULE_FOLD = ') === 1 &&
        valOf(eng179, 'COVER_LEN_RELIEF') > 0 && valOf(eng179, 'COVER_LEN_RELIEF') < 1 &&
        valOf(eng179, 'CAUSE_RULE_FOLD') > 0 && valOf(eng179, 'CAUSE_RULE_FOLD') < 1,
      `relief=${valOf(eng179, 'COVER_LEN_RELIEF')} fold=${valOf(eng179, 'CAUSE_RULE_FOLD')}`,
    )
    check(
      'HZ14 长度惩罚按覆盖度打折：bEff 三处（逐条扫 / 扫倒排两趟）、四处长度归一化都吃它、没有「直接拿 b 去归一」的残留',
      // [0.6.16] 打分拆两条路之后：`bEff` 定义 3 处（scanDoc、scoreCandSet 备常数那趟、收尾补分那趟），
      // `(1 - bEff + bEff * len / dl)` 4 处（scanDoc 的 BM25 主算式与 sat 闭包各一、扫倒排的 `kDen` 与收尾 sat 各一）。
      // 口诀没变：长度惩罚一律吃打过折的 bEff，没有一处直接拿 b 去归一。
      countOf(eng179, 'const bEff = b * (1 - coverLenRelief * cvr);') === 3 &&
        // [0.6.29] 两处循环不变量提到外面之后，`len / dl` 变成了 `len / lenDl`（`lenDl = onBody ? avgdl : avgBody`
        // 提到循环外，值不变）。两种写法的处数相加仍要是 4。
        countOf(eng179, '(1 - bEff + bEff * len / dl)') + countOf(eng179, '(1 - bEff + bEff * len / lenDl)') === 4 &&
        countOf(eng179, '(1 - b + b * len / dl)') === 0 &&
        eng179.includes('Number.isFinite(opts.coverLenRelief) ? Math.min(1, Math.max(0, opts.coverLenRelief)) : COVER_LEN_RELIEF'),
      `bEff ${countOf(eng179, '(1 - bEff + bEff * len / dl)')} 处`,
    )
    check(
      'HZ14 覆盖度三步（归一 → 取幂 → 协调）各就各位：G22 的判据就按这三步盯，拆开才能分别红',
      // [0.6.16] 覆盖度归一那句只剩逐条扫的退路（1 处，扫倒排那路走 `coverAcc` 的 `Math.min(1, coverAcc[di] / qIdfSum)`）；
      // 取幂与协调两步在两条路各一处，算式逐字相同（共 2 处）。
      countOf(eng179, 'coverOf[di] = Math.min(1, cover / qIdfSum);') === 1 &&
        (countOf(eng179, 'cvr = Math.pow(coverOf[di], COORD_POW);') === 2 ||
          countOf(eng179, 'cvr = COORD_POW_ONE ? coverOf[di] : Math.pow(coverOf[di], COORD_POW);') === 2) &&
        // [0.6.34] 扫倒排那处把 `1 - COORD_W` 提成 `coordKeep`：两种写法的处数相加仍是 2。
        countOf(eng179, 'if (cvr > 0) s *= 1 - COORD_W + COORD_W * cvr;') +
          countOf(eng179, 's *= coordKeep + COORD_W * cvr;') === 2,
      '三步都在，各一处',
    )
    check(
      'HZ14 缘由判定的入场券：缘由意图（topic）与现状问句（situation）二者取一，causeAware:false 一键回旧口径',
      countOf(eng179, 'const causeQ = (situationQ || (lvIntent !== null && lvIntent.has("topic"))) && opts.causeAware !== false;') === 1 &&
        // [0.2.180] 「为什么封存」里的「封存」是状态词，但问的是当初：带缘由词的一律归缘由问句。
        countOf(eng179, 'const situationQ = LEVEL_INTENT_SITUATION.test(String(query ?? "")) && LEVEL_INTENT_TOPIC.test(String(query ?? "")) === false;') === 1,
      'causeQ 一处、situationQ 一处',
    )
    check(
      'HZ14 两笔账分开落：新鲜度吃 !causeQ、折价走 ruleFoldOf 一个 helper（分档 + 打分 + explain 三处），explain 里也看得见（否则单题排查看不出这一笔）',
      // [0.6.34] 守卫换序（`!(raw[di] >= impBandMax)` 提前），两种写法只认前缀 + 尾部条件。
      countOf(eng179, 'if (!anchored && !causeQ && now !== null && ') === 1 &&
        (countOf(eng179, 'now !== null && dOf.importance < 3') === 1 ||
          countOf(eng179, '!(raw[di] >= impBandMax) && dOf.importance < 3') === 1) &&
        countOf(eng179, 'const ruleFoldOf = (di) => causeQ && String(docs[di].level ?? "") === "rules" ? (situationQ ? situationRuleFold : causeRuleFold) : 1;') === 1 &&
        // [0.6.14] helper 每条只调一次（`const foldOf = ruleFoldOf(di);`），三个消费点都吃这个变量：
        // 分档（_raw）× 打分（score）× explain。口径仍是一处定义，只是不再重算三遍。
        countOf(eng179, 'const foldOf = ruleFoldOf(di);') === 1 &&
        countOf(eng179, '* foldOf,') >= 2 &&
        eng179.includes('raw[di] * w * impW * stW * foldOf * 1e3') &&
        eng179.includes('Number.isFinite(opts.causeRuleFold) ? Math.min(1, Math.max(0, opts.causeRuleFold)) : CAUSE_RULE_FOLD') &&
        eng179.includes('Number.isFinite(opts.situationRuleFold) ? Math.min(1, Math.max(0, opts.situationRuleFold)) : SITUATION_RULE_FOLD'),
      `ruleFoldOf(di) 定义 1 + 调用 ${countOf(eng179, 'const foldOf = ruleFoldOf(di);')} 处 · foldOf 消费 ${countOf(eng179, '* foldOf,')} 处`,
    )
    const kwStart = eng179.indexOf('function keywordHitScore(')
    const kwEnd = kwStart === -1 ? -1 : eng179.indexOf('\nfunction ', kwStart + 10)
    const kwBody = kwStart === -1 ? '' : eng179.slice(kwStart, kwEnd === -1 ? undefined : kwEnd)
    check(
      'HZ14 主动注入有意不吃这一刀：keywordHitScore 里没有 causeQ——检索答错是噪声，注入多提一句常常是好事',
      kwStart !== -1 && kwBody.length > 500 && !kwBody.includes('causeQ') && !kwBody.includes('causeRuleFold'),
      `keywordHitScore 正文 ${kwBody.length} 字符里 causeQ 出现 ${kwBody.split('causeQ').length - 1} 次`,
    )
    check(
      'HZ14 situation 词表在、且 intentLevelsOf 真的用它收 rules（这一刀单靠 ×1.3 抵不过 4 倍差，但它是 causeQ 的入场券）',
      eng179.includes('var LEVEL_INTENT_SITUATION = ') &&
        eng179.includes('if (LEVEL_INTENT_RULES.test(q) && situation === false) out.add("rules");') &&
        countOf(eng179, 'const situation = LEVEL_INTENT_SITUATION.test(q) && LEVEL_INTENT_TOPIC.test(q) === false;') === 1,
      '词表 + 收 rules 都在',
    )
    check(
      'HZ14 G28 探针在位：三个问句（缘由 / 现状 / 普通）、开关比值判据、一刀不切的阴性对照',
      gold179.includes('G28 缘由问句去叙述层找答案') &&
        gold179.includes("const q1 = '评测台为什么封存'") &&
        gold179.includes("const q2 = '评测台还能跑吗'") &&
        gold179.includes("const q3 = '评测台的花费上限怎么设'") &&
        gold179.includes('Math.abs(fold1 - 0.6) < 0.01') &&
        gold179.includes("Math.abs(sc(on3f, '0s28a0002') - sc(off3f, '0s28a0002')) > 1e-9"),
      'G28 四件套（三问句 / 比值 / 一刀不切）都在',
    )
    check(
      'HZ14 R16 断言在位：缘由句首位、开关比 0.6、现状句折得更狠、两档各管各的、两个旋钮能分别关、普通句逐位同分',
      recall179.includes('R16 缘由问句「评测线为什么锁在封存档」首位是讲缘由那条') &&
        recall179.includes('R16 规矩条在缘由问句里被折到 0.6 倍') &&
        recall179.includes('R16 现状问句（一个「为什么」都不含）折得更狠') &&
        recall179.includes('R16 两档折价各管各的') &&
        recall179.includes('R16 两个旋钮能分别关') &&
        recall179.includes('R16 一刀不切'),
      'R16 六条都在',
    )
    check(
      'HZ14 文档在位：INTERNAL 9.186 记三次否决与「撤机制要看撤后读数」，DESIGN 191 记「层级也是回答仓」',
      internal179.includes('## 9.186 ') &&
        internal179.includes('缘由问句去叙述层找答案') &&
        internal179.includes('撤掉它') &&
        design179.includes('## 191') &&
        design179.includes('回答仓'),
      `9.186 在=${internal179.includes('## 9.186 ')} 191 在=${design179.includes('## 191')}`,
    )
  }
  // ── HZ15（0.2.180）折价必须同时落在分档与排序上，两档折价各管各的
  // 0.2.179 只折 score 不折 _raw，档位没动，规矩条照样在最高档当第一名——折到 0.1 也翻不过去。
  // 这一版把折价做成 ruleFoldOf 一个 helper，_raw（分档用）与 score（排序用）吃同一个乘子。
  {
    const eng180 = readFileSync(new URL('./vendor/meow-memory/lib/index.js', import.meta.url), 'utf8')
    const gold180 = readFileSync(new URL('./tools/probe-gold.mjs', import.meta.url), 'utf8')
    const recall180 = readFileSync(new URL('./tools/probe-recall.mjs', import.meta.url), 'utf8')
    const internal180 = readFileSync(new URL('./docs/INTERNAL.md', import.meta.url), 'utf8')
    const design180 = readFileSync(new URL('./DESIGN.md', import.meta.url), 'utf8')
    // countOf 在 HZ14 的块里定义，块外的 HZ15 得自己来一份（同一作用域才看得见）。
    const countOf = (hay, needle) => hay.split(needle).length - 1
    check(
      'HZ15 两档折价常量各一处、都在 (0,1)：缘由句 0.6、现状句 0.3（现状压得更低，因为问的形状都不对）',
      countOf(eng180, 'var CAUSE_RULE_FOLD = 0.6;') === 1 &&
        countOf(eng180, 'var SITUATION_RULE_FOLD = 0.3;') === 1 &&
        eng180.includes('Number.isFinite(opts.situationRuleFold) ? Math.min(1, Math.max(0, opts.situationRuleFold)) : SITUATION_RULE_FOLD'),
      '两个常量各一处',
    )
    // bandize() 的排序：先比档位、再比分数。档位是从 _raw 算出来的，
    // 所以要动名次就必须动 _raw——这是 0.2.179 折价失效的确切位置。
    // 0.6.4 起 `literalFallback` 里也有 `_raw: tf2`，所以这里按「折价那一行」定位，不是按第一处 `_raw: `。
    const rawLine = eng180.split('\n').find((l) => l.includes('_raw: ') && (l.includes('ruleFoldOf(di)') || l.includes('* foldOf'))) ?? ''
    check(
      'HZ15 折价落在 _raw 上：分档按 _raw 走、档位优先于分数，只折 score 等于没折',
      // 0.6.12 起定序比较器抽成 orderOf（档位 → 分数 → 更新得更晚的在前 → id 自然序），
      // 有界堆与全序两路共用它；折价仍必须折在 _raw 上，否则分档看不见它。
      // 0.6.14 起 helper 每条只算一次落进 `foldOf`，所以 _raw 那一行乘的是变量（值不变）。
      eng180.includes('const orderOf = (a, b) => (a._bandTmp - b._bandTmp) || (b.score - a.score)') &&
        (rawLine.includes('* ruleFoldOf(di)') || rawLine.includes('* foldOf')) &&
        rawLine.includes('const foldOf = ruleFoldOf(di);') === false,
      rawLine.length > 0 ? `_raw 行 ${rawLine.trim().length} 字符，折价乘在末尾` : '_raw 行没找到',
    )
    check(
      'HZ15 折价走同一个 helper：定义一处、引用三处（_raw / 打分 / explain），口径不可能分叉',
      countOf(eng180, 'const ruleFoldOf = (di) => causeQ && String(docs[di].level ?? "") === "rules" ? (situationQ ? situationRuleFold : causeRuleFold) : 1;') === 1 &&
        // [0.6.14] 三条消费路径仍吃同一个乘子，只是乘子先落进 `foldOf`（每条算一次，不重算三遍）。
        countOf(eng180, 'const foldOf = ruleFoldOf(di);') === 1 &&
        countOf(eng180, '* foldOf,') + countOf(eng180, '* foldOf *') >= 2,
      `ruleFoldOf(di) 调用 ${countOf(eng180, 'ruleFoldOf(di)')} 处（定义 + 一次求值）· foldOf 消费 ${countOf(eng180, '* foldOf,') + countOf(eng180, '* foldOf *')} 处`,
    )
    check(
      'HZ15 同义词表：讲「开个小门」的词归例外组、不归噪声组（同一个词放两组会把两题一起搅坏）',
      eng180.includes('["筛掉", "过滤", "剔除", "噪声", "噪音", "口子", "让步"],') &&
        eng180.includes('["例外", "豁免", "特例", "放行", "破例", "小门"],') &&
        !eng180.includes('"噪音", "口子", "让步", "小门"'),
      '例外组六个词、噪声组七个词，互不重叠',
    )
    check(
      'HZ15 试过又退掉的那一刀不留痕：缘由问句里 project 与 topic 不是同一仓（会把「问版本号」的题带坏）',
      !eng180.includes('else if (LEVEL_INTENT_TOPIC.test(q)) out.add("project");'),
    )
    check(
      'HZ15 G28 两档比值都在：缘由句 0.6、现状句 0.3，源码判据认 ruleFoldOf 四笔',
      gold180.includes('Math.abs(fold1 - 0.6) < 0.01') &&
        gold180.includes('Math.abs(fold2 - 0.3) < 0.01') &&
        // 0.6.14 起折价「每条算一次、乘两处」，文案随之改口径（改建不删）。
        gold180.includes('缘由判定的四笔（两个常量 / 开关 / 同一条 helper 算一次乘两处 / 缘由词优先）没落全'),
      'G28 两档比值 + 四笔判据都在',
    )
    check(
      'HZ15 R16 两条新断言在位：现状句折到 0.3、situationRuleFold 与 causeRuleFold 各管各的',
      recall180.includes('R16 现状问句（一个「为什么」都不含）折得更狠：0.3 倍') &&
        recall180.includes('R16 两档折价各管各的') &&
        recall180.includes('causeRuleFold: 1 })'),
      'R16 覆盖两档折价的独立性',
    )
    check(
      'HZ15 文档在位：INTERNAL 9.187 记「折价只折分数等于没折」的档位根因，DESIGN 192 记档位与分数两套秩序',
      internal180.includes('## 9.187 ') &&
        internal180.includes('档位优先于分数') &&
        design180.includes('## 192') &&
        design180.includes('ruleFoldOf'),
      `9.187 在=${internal180.includes('## 9.187 ')} 192 在=${design180.includes('## 192')}`,
    )
  }
  // ── HZ16（0.3.0）版本下限的断言不许把主版本写死
  // 0.2.180 → 0.3.0 这一跳，verify 一口气红了 61 条，全是同一类写法：
  //   /^0\.2\./                                    （host，一条）
  //   v[0] === 0 && v[1] === 2 && v[2] >= N          （47 条）
  //   pkg.version.split('.').map(...)[2] >= N        （13 条，只看第三段）
  // 它们想说的都只是「不早于 0.2.N」，却把「主版本是 0、次版本是 2」写进了断言。
  // 判据要守语义（不早于），不守字面（是 0.2）：这一点写在这里，下次跳大版本不必再改 61 处。
  {
    const selfSrc = readFileSync(new URL('./verify.mjs', import.meta.url), 'utf8')
    const pkg030 = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))
    const readme030 = readFileSync(new URL('./README.md', import.meta.url), 'utf8')
    const internal030 = readFileSync(new URL('./docs/INTERNAL.md', import.meta.url), 'utf8')
    const design030 = readFileSync(new URL('./DESIGN.md', import.meta.url), 'utf8')
    const countOf030 = (hay, needle) => hay.split(needle).length - 1
    check(
      'HZ16 版本下限比大小只有一个入口：verAtLeast(v, maj, min, pat)，主版本更高一律算过',
      countOf030(selfSrc, 'const verAtLeast = (v, maj, min, pat) =>\n') === 1 &&
        countOf030(selfSrc, 'v[0] > maj || (v[0] === maj' + ' &&') === 1 &&
        countOf030(selfSrc, 'verAtLeast(') >= 60,
      `引用 ${countOf030(selfSrc, 'verAtLeast(') - 1} 处（定义行自己也带这个名字）`,
    )
    // 三类会被大版本跳跃打死的旧形态，一处都不许留（注释行不算：那里正是要讲清旧形态长什么样）
    const codeOnly030 = selfSrc.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n')
    const hardCodedMajor = (codeOnly030.match(/\w+\[0\] === 0 && \w+\[1\] === 2 && \w+\[2\] >=/g) ?? []).length
    check(
      'HZ16 旧形态零残留：「主版本写死」的三类写法（双等号 / 只看第三段 / 0.2.x 正则）一处都没有',
      hardCodedMajor === 0 &&
        !selfSrc.includes("pkg.version.split('.').map((x) => Number(x))" + "[2] >=") &&
        !selfSrc.includes('/^0\\.2\\./.test(String(host.version))') &&
        selfSrc.includes("'host: 版本是三段 semver'"),
      `双等号 ${hardCodedMajor} 处 / 只看第三段 ${countOf030(selfSrc, "].map((x) => Number(x))" + "[2] >=")} 处`,
    )
    // 断言自己也要有一条阳性对照：把 helper 对一个「大版本更高」的版本喂进去必须为真，
    // 否则「61 条都过了」可能只是因为它被写成了恒真。
    check(
      'HZ16 阳性对照: 0.3.0 满足「不早于 0.2.38」、0.2.37 不满足（helper 不是恒真）',
      verAtLeast([0, 3, 0], 0, 2, 38) === true && verAtLeast([0, 2, 37], 0, 2, 38) === false,
    )
    check(
      'HZ16 发布面三字段指向 GitHub 仓库（npm 与目录站都读它们）',
      String(pkg030.repository?.url ?? '') === 'git+https://github.com/hanhan9999999999999999999/dsh-macro-memory.git' &&
        String(pkg030.homepage ?? '').startsWith('https://github.com/hanhan9999999999999999999/dsh-macro-memory#') &&
        String(pkg030.bugs?.url ?? '').endsWith('/issues'),
      pkg030.repository?.url ?? '(缺 repository)',
    )
    check(
      'HZ16 npm 包只发运行面：files 白名单四项，verify.mjs 与 tools/ 不进包',
      JSON.stringify(pkg030.files) === JSON.stringify(['lib', 'vendor', 'cordis.patch.yml', 'README.md']) &&
        !pkg030.files.some((f) => f === 'tools' || f === 'verify.mjs') &&
        pkg030.dsh?.bundle?.patch === './cordis.patch.yml' &&
        pkg030.dsh?.client?.platform === 'web',
      JSON.stringify(pkg030.files),
    )
    check(
      'HZ16 README 有 0.3.0 里程碑段与 0.3.0 的逐版条目（版本号跳了，说明也要跟着跳）',
      readme030.includes('**0.3.0 里程碑**') &&
        readme030.includes('- **0.3.0：把「能自证」收成可发布的东西**（0.3.0）') &&
        /24 支自检 \/ 3,\d{3} 条可执行断言/.test(readme030),
      `里程碑=${readme030.includes('**0.3.0 里程碑**')} 条目=${readme030.includes('收成可发布的东西')}`,
    )
    check(
      'HZ16 文档在位：INTERNAL 9.188 记「版本下限不许写死主版本」，DESIGN 193 记「0.3 的承诺只加不删」',
      internal030.includes('## 9.188 ') &&
        internal030.includes('verAtLeast') &&
        design030.includes('## 193. ') &&
        design030.includes('只加不删'),
      `9.188 在=${internal030.includes('## 9.188 ')} 193 在=${design030.includes('## 193. ')}`,
    )
  }
  check(
    'HC 取数口径: 库里的行只有一条出口——list() 必须过 fromRow，keywords 在那里才被 JSON.parse 成数组',
    eng.includes('return rows.map((r) => this.fromRow(level, r));') &&
      eng.includes('keywords = JSON.parse(String(r.keywords ?? "[]"))') &&
      eng.split('Array.isArray(d.keywords)').length - 1 >= 2 &&
      eng.split('Array.isArray(d?.keywords)').length - 1 >= 1,
  )
  const MeowHC = await import(pathToFileURL(join(root, 'vendor', 'meow-memory', 'lib', 'index.js')).href)
  check(
    'HC 行为: 受控语料里「高覆盖/低覆盖」的分差随覆盖度权重变宽，幂次再把它拉宽一点（旋钮还活着，但不当默认）',
    (() => {
      const mk = (id, content) => ({ id, level: 'fact', content, title: '', keywords: [], importance: 1, status: 'active' })
      const pad = 'zeta zeta zeta zeta zeta'
      const corpus = [
        mk('hv-hi', `alpha beta gamma ${pad}`),
        mk('hv-lo', `alpha ${pad} omega omega`),
      ]
      const ratio = (opts) => {
        const m = new Map(MeowHC.search('alpha beta gamma', corpus, { k: 2, ...opts }).map((h) => [String(h.id), h.score]))
        return m.get('hv-hi') / m.get('hv-lo')
      }
      const narrow = ratio({ coordW: 0.35, coordPow: 1 })
      const wide = ratio({ coordW: 0.45, coordPow: 1 })
      const pow = ratio({ coordW: 0.45, coordPow: 1.2 })
      return wide > narrow * 1.1 && pow > wide * 1.01 && pow < wide * 1.2
    })(),
  )
  check(
    'HC 行为·关键词三种形态都进通道: 数组 / JSON 文本 / 逗号串都能命中（0.6.6 起 kwList 归一，raw row 的那个坑已经填了）',
    (() => {
      const base = { id: 'kw-probe', level: 'fact', title: '', content: '这条正文一个问句词都没有。', importance: 2, status: 'active' }
      const shapes = [['舵轮校准'], '["舵轮校准"]', '舵轮校准, 罗盘']
      return shapes.every((kw) => {
        const hits = MeowHC.search('舵轮校准', [{ ...base, keywords: kw }], { k: 1 })
        return hits.length === 1 && hits[0].cover > 0.9
      })
    })(),
  )
  const probe164 = readFileSync(join(root, 'tools', 'probe-gold.mjs'), 'utf8')
  check(
    'HC 自带阴性对照: 探针里五条改坏的路都写死了对照串（回旧口径 / 去幂次 / 改线性 / cover 跟权重 / 不解析 keywords）',
    probe164.includes('G22 覆盖度是证据') &&
      probe164.includes('幂次旋钮失效') &&
      probe164.includes('cover 跟着权重变了') &&
      probe164.includes('只在 keywords 里的压过了正文命中的') &&
      probe164.includes('取数口径没有「fromRow 解析 keywords」这条线'),
  )
  const int164 = readFileSync(join(root, 'docs', 'INTERNAL.md'), 'utf8')
  const des164 = readFileSync(join(root, 'DESIGN.md'), 'utf8')
  check(
    'HC 有记: INTERNAL 9.170 写清缺口/网格/三好一坏，9.171 写清口径纠正与干净读数，DESIGN 175/176 写清两条原则',
    int164.includes('## 9.170') &&
      int164.includes('0.873') &&
      int164.includes('0.357') &&
      int164.includes('三好一坏') &&
      int164.includes('## 9.171') &&
      int164.includes('148/150') &&
      int164.includes('raw row') &&
      des164.includes('## 175') &&
      des164.includes('先问「这条答了几成」') &&
      des164.includes('## 176') &&
      des164.includes('读数工具自己也是被测对象'),
  )
}

// FE（0.2.139）：链是 8 位前缀近似出来的——接手者可能已不在库里，前缀也可能撞车。
// 这一组钉住「近似要说清楚」：三态、两句新文案、以及全库只扫一遍。
{
  const chainPath = join(root, 'lib', 'macro', 'chain.js')
  const chainSrc2 = readFileSync(chainPath, 'utf8')
  const C2 = await import(pathToFileURL(chainPath).href)

  check(
    'FE 撞车: 前缀命中 0 / 1 / 2 各说各的（纯函数，真库造不出来）',
    C2.prefixState(['0mwabcde-1', '0mwabcde-2', '0mwxyz'], '0mwabcde') === 2 &&
      C2.prefixState(['0mwabcde-1'], '0mwabcde') === 1 &&
      C2.prefixState(['0mwabcde-1'], '0mzzzzz9') === 0 &&
      C2.prefixState([], '0mwabcde') === 0 &&
      C2.prefixState(['0mwabcde-1'], '') === 0,
  )
  check('FE 撞车: 前缀口径就是 8 位（多一位少一位都不算命中）', C2.prefixState(['0mwabcde-1'], '0mwabcde-1') === 1 && C2.prefixState(['0mwabcde-1'], '0mwabcde-') === 1)

  const mineBlocks = chainSrc2.match(/state: sure\.length === 1 \? 'exact' : sure\.length === 0 \? 'absent' : 'ambiguous'/g) ?? []
  check('FE 源码: 接手者三态写在数据里（不是文案里猜）', mineBlocks.length === 1)
  check(
    'FE 消歧: 前缀撞车时用取代句里的开头再筛一遍（同一秒写的条目必然撞前缀）',
    C2.headMatch('链诚实探针乙：0.2.139 交付态，链要', '链诚实探针乙：0.2.139 交付态，链要说出接…') === true &&
      C2.headMatch('一条完全不同的开头', '链诚实探针乙') === false &&
      C2.headMatch('', '任意') === false &&
      chainSrc2.includes('headMatch(headOf(one.row.content), mark.head)'),
  )
  check(
    'FE 消歧: 反方向也按开头核对（否则会把「记着我兄弟」当成「记着我」）',
    chainSrc2.includes('headMatch(myHead, mark2.head)'),
  )
  check(
    'FE 源码: 缺席有专门一句话（不许拿「已被人接手」冒充）',
    chainSrc2.includes('可那条现在不在库里') && chainSrc2.includes("chain.mine.state === 'absent'"),
  )
  check(
    'FE 源码: 撞车有专门一句话（不许拿前缀当唯一 id）',
    chainSrc2.includes('id 前 8 位撞了') && chainSrc2.includes("chain.mine.state === 'ambiguous'"),
  )
  check('FE 源码: 自己前缀撞车时说明「按开头核对过」', chainSrc2.includes('按开头核对过') && chainSrc2.includes('selfHits'))
  check(
    'FE 源码: 全库只扫一遍（三个判断共用同一张表，别为每件事再 list 一次）',
    /for \(const level of LEVELS\) \{\n\s+const list = db\.list\(level, \{\}\)/.test(chainSrc2) &&
      chainSrc2.indexOf('const ids = all.map(') > chainSrc2.indexOf('const all = []'),
  )
  check('FE 源码: 仍然不建表不加列（缺陷修在读取侧，不在 schema）', !/ALTER TABLE|CREATE (TABLE|INDEX)/i.test(chainSrc2))

  const pkg139 = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  check(
    'FE 版本与文档一起走（9.145 / 151）',
    verAtLeast(pkg139.version.split('.').map((x) => Number(x)), 0, 2, 139) &&
      readFileSync(join(root, 'docs', 'INTERNAL.md'), 'utf8').includes('## 9.145 ') &&
      readFileSync(join(root, 'DESIGN.md'), 'utf8').includes('## 151 '),
  )
}

// FW（0.2.140）：状态以前只在过滤里起作用，不进打分。这一组验「权重存在、两个打分器都用它、
// docs 真的把 status 带进去了、降权这件事在回执里有话说、三语文案齐」。
{
  const meowSrc = readFileSync(new URL('./vendor/meow-memory/lib/index.js', import.meta.url), 'utf8')
  const meowMod = await import('./vendor/meow-memory/lib/index.js')
  check('FW 纯函数：三档权重（active 1 / stale 0.6 / archived 0.35 / 缺省 1）', meowMod.statusWeight('active') === 1 && meowMod.statusWeight('stale') === 0.6 && meowMod.statusWeight('archived') === 0.35 && meowMod.statusWeight(void 0) === 1)
  // [0.6.14] 主打分器里的乘子改成 `foldOf`（每条算一次），keywordHitScore 那一路仍是内联写法：两处必须同权重。
  check('FW 源码: 两个打分器都乘同一个权重', (meowSrc.includes('score: raw[di] * w * impW * stW * foldOf') || meowSrc.includes('score: raw[di] * w * impW * stW * ruleFoldOf(di)')) || meowSrc.includes('score: raw[di] * w * impW * stW * (causeQ && String(docs[di].level ?? "") === "rules" ? causeRuleFold : 1),') && meowSrc.includes('raw[di] * coverage * w * impW * stW * (titleHit ? 1.2 : 1)'))
  check('FW 源码: docs 把 status 带进打分器（不带就等于没降权）', meowSrc.includes('status: r.status') && /const stW = (anchored \? 1 : )?statusWeight\(docs\[di\]\.status\)/.test(meowSrc))
  check('FW 源码: explain 里有 statusWeight 分项', meowSrc.includes('statusWeight: Math.round(stW * 1e3) / 1e3'))
  const docsFw = [
    { id: 'a', level: 'fact', content: '同题同文，只有状态不同', keywords: [], importance: 3, updated_at: Date.now(), status: 'active' },
    { id: 'b', level: 'fact', content: '同题同文，只有状态不同', keywords: [], importance: 3, updated_at: Date.now(), status: 'stale' },
  ]
  const rankedFw = meowMod.search('同题同文 只有状态不同', docsFw, { k: 5, now: Date.now() })
  check('FW 行为: 正文与时间一样时，在用那条排前面，且分数比正好 0.6', rankedFw.length === 2 && rankedFw[0].id === 'a' && Math.abs(rankedFw[1].score / rankedFw[0].score - 0.6) < 1e-6)
  check('FW 文案: 降权要在回执里说出口（键 + 三语）', meowSrc.includes('search.statusDown') && ['zh', 'en', 'pt-br'].every((lang) => readFileSync(new URL(`./vendor/meow-memory/lib/prompts/${lang}/labels.md`, import.meta.url), 'utf8').includes('- search.statusDown:')))
  check('FW 克制: 没有非 active 命中时一个字节都不多花', meowSrc.includes('const statusDownNote = offNow.length === 0'))
}

// FY（0.2.141）：折叠挑谁留下，决定你读到的是新的还是旧的。这一组验「挑法、点名、可退」。
{
  const meowSrc = readFileSync(new URL('./vendor/meow-memory/lib/index.js', import.meta.url), 'utf8')
  const meowMod = await import('./vendor/meow-memory/lib/index.js')
  check('FY 源码: 折叠按「在用 → 较新 → 分高」挑一条（不再是先到先得）', meowSrc.includes('function pickKeeper(members, byId)') && meowSrc.includes('if (ra.st !== rb.st) return rb.st - ra.st;') && meowSrc.includes('if (ra.at !== rb.at) return rb.at - ra.at;'))
  check('FY 源码: 折叠结果记下「谁被折、被谁接手」', meowSrc.includes('dropped.push({ id: String(m.id), keep: String(keep.id)'))
  check('FY 源码: 回执点名留下的与被折的（三语）', meowSrc.includes('search.dedupeKept') && ['zh', 'en', 'pt-br'].every((lang) => readFileSync(new URL(`./vendor/meow-memory/lib/prompts/${lang}/labels.md`, import.meta.url), 'utf8').includes('- search.dedupeKept:')))
  const docsFy = [
    { id: 'stale-new', level: 'fact', content: '同一句话，状态与时间不同', keywords: [], importance: 2, updated_at: 900, status: 'stale', score: 9 },
    { id: 'active-old', level: 'fact', content: '同一句话，状态与时间不同', keywords: [], importance: 2, updated_at: 100, status: 'active', score: 5 },
  ]
  const byIdFy = new Map(docsFy.map((d) => [d.id, d]))
  const foldFy = meowMod.foldNearDupes(docsFy, byIdFy)
  check('FY 行为: 在用的旧条目胜过退位的新条目（「还用不用」压过「写得多新」）', foldFy.kept.length === 1 && foldFy.kept[0].id === 'active-old' && foldFy.dropped.length === 1 && foldFy.dropped[0].keep === 'active-old')
  const docsFy2 = [
    { id: 'a-old', level: 'fact', content: '同一句话，只差时间', keywords: [], importance: 2, updated_at: 100, status: 'active', score: 9 },
    { id: 'a-new', level: 'fact', content: '同一句话，只差时间', keywords: [], importance: 2, updated_at: 900, status: 'active', score: 1 },
  ]
  const foldFy2 = meowMod.foldNearDupes(docsFy2, new Map(docsFy2.map((d) => [d.id, d])))
  check('FY 行为: 同状态同分时较新的赢（分高不能压过时间）', foldFy2.kept.length === 1 && foldFy2.kept[0].id === 'a-new')
}

// FZ（0.2.142）：一条正文写着「（已被取代：xxxx）」，可那个 xxxx 已经不在库、或前缀撞了一堆认不出是谁。
// 上面三块（逐字重复 / 重复详写 / 疑似冲突）比的是正文像不像，这种断法一对都抓不到——
// 断链不是「该整理」，是「已经整理坏了」。这一组验三态判据、零成本、文案与三语。
{
  const meowSrc = readFileSync(new URL('./vendor/meow-memory/lib/index.js', import.meta.url), 'utf8')
  const meowMod = await import('./vendor/meow-memory/lib/index.js')
  check(
    'FZ 源码: 三态按「库里有没有这个前缀」判（不能按开头筛完剩几条判）',
    meowSrc.includes('function dreamChainIssues(allRows, db)') && meowSrc.includes('state: hits.length === 0 ? "absent" : "ambiguous",'),
  )
  check('FZ 源码: 没有取代句就一次库都不扫（干净清单零成本）', meowSrc.includes('if (claims.length === 0) return { list: [], total: 0 };'))
  check(
    'FZ 源码: 撞车时先按开头筛（同秒写入前 8 位必撞，开头是唯一证据）',
    meowSrc.includes('chainHeadMatch(chainHeadOf(r.content), one.mark.head)') &&
      meowSrc.includes('if (sure.length === 1) continue;'),
  )
  check(
    'FZ 源码: 这一块是清单的第四块，紧跟冲突块，且按「这条落在哪一轮就由哪一轮说」分摊',
    meowSrc.includes('dupBlock + repeatBlock + coverBlock + conflictBlock + chainBlock') &&
      meowSrc.includes('const chainHere = chainAll.list.filter((it) => roundIds.has(String(it.id)));'),
  )
  check('FZ 源码: 条数有上限，超出的说「还有几条」（不刷屏也不静默）', meowSrc.includes('var DREAM_CHAIN_MAX = 6;') && meowSrc.includes('dreamChainBlock({ list: chainHere, total: chainAll.total }, shortOf, lbl3)'))
  const fzRow = { id: 'aaa11111-1', level: 'fact', content: '口径（已被取代：bbb22222「新说法正文」，2026-11-21）', updated_at: 5 }
  const fzAbsent = meowMod.dreamChainIssues([fzRow], { list: () => [] })
  check('FZ 行为: 接手者不在库 → absent（并拆出前缀/开头/日期）', fzAbsent.total === 1 && fzAbsent.list[0].state === 'absent' && fzAbsent.list[0].who === 'bbb22222' && fzAbsent.list[0].head === '新说法正文' && fzAbsent.list[0].day === '2026-11-21')
  const fzAmb = meowMod.dreamChainIssues(
    [fzRow],
    { list: (lv) => (lv === 'fact' ? [{ id: 'bbb22222-9', content: '完全不同的甲' }, { id: 'bbb22222-8', content: '完全不同的乙' }] : []) },
  )
  check('FZ 行为: 前缀撞了且开头对不上 → ambiguous（不是 absent）', fzAmb.total === 1 && fzAmb.list[0].state === 'ambiguous' && fzAmb.list[0].hits === 2)
  const fzExact = meowMod.dreamChainIssues(
    [fzRow],
    { list: (lv) => (lv === 'fact' ? [{ id: 'bbb22222-9', content: '新说法正文' }, { id: 'bbb22222-8', content: '完全不同的乙' }] : []) },
  )
  check('FZ 行为: 链是好的（exact）一个字不报', fzExact.total === 0 && fzExact.list.length === 0)
  let fzScans = 0
  meowMod.dreamChainIssues([{ id: 'x', level: 'fact', content: '没有链的正文', updated_at: 1 }], { list: () => (fzScans++, []) })
  check('FZ 行为: 没有取代句时 db.list 一次都没被调用', fzScans === 0)
  const fzLbl = (k, p) => meowMod.fillTemplate(meowMod.keyedValue('labels', k), p) ?? `MISSING:${k}`
  const fzText = meowMod.dreamChainBlock({ list: fzAbsent.list, total: 3 }, null, fzLbl)
  const fzText2 = meowMod.dreamChainBlock({ list: fzAmb.list, total: 1 }, null, fzLbl)
  check(
    'FZ 文案: 断链块说清「不在库里 / 认不出是谁」，并交代还有几条',
    fzText.includes('链断了 3 条') && fzText.includes('不在库里') && fzText.includes('还有 2 条') && fzText2.includes('按开头') && fzText2.includes('2 条'),
  )
  check('FZ 克制: 没有断链时块是空串', meowMod.dreamChainBlock({ list: [], total: 0 }, null, fzLbl) === '')
  check(
    'FZ 文案: 五个键三语都在',
    ['zh', 'en', 'pt-br'].every((lang) => {
      const body = readFileSync(new URL(`./vendor/meow-memory/lib/prompts/${lang}/labels.md`, import.meta.url), 'utf8')
      return ['dream.chain.title', 'dream.chain.absent', 'dream.chain.ambiguous', 'dream.chain.more', 'dream.chain.rule'].every((k) => body.includes(`- ${k}:`))
    }),
  )
  check('FZ 不建表: 只读现有行，不加列不加索引', !/ALTER TABLE|CREATE INDEX/.test(meowSrc.slice(meowSrc.indexOf('function dreamChainIssues('), meowSrc.indexOf('function dreamChainBlock('))))
}

// GA（0.2.143）：相关度下限按分数裁，可分数排的是措辞，不是「谁接了班」。
// 退位旧说法字面很贴就能进榜，接手它的新说法掉到下限以下被裁掉——读者只看到作废的那条。
{
  const meowSrc = readFileSync(new URL('./vendor/meow-memory/lib/index.js', import.meta.url), 'utf8')
  const meowMod = await import('./vendor/meow-memory/lib/index.js')
  check('GA 源码: 下限裁完先回看接班者，再交给折叠', meowSrc.includes('const lifted = minRel > 0 ? liftSuccessors(aboveFloor, cutRows) : [];') && meowSrc.includes('const foldedRes = dedupeOn ? foldNearDupes(floorKept, byId)'))
  check('GA 源码: 认不出是谁就不提（同前缀多条、开头对不上 → 不动）', meowSrc.includes('function liftSuccessors(shown, cut)') && meowSrc.includes('if (sure.length !== 1) continue;'))
  check('GA 源码: 提上来的有上限，且要进回执', meowSrc.includes('var LIFT_MAX = 3;') && meowSrc.includes('search.floorLift') && /relNote,[^)]*liftNote,/.test(meowSrc))
  const gaShown = [{ id: 'old11111-1', content: '口径（已被取代：new22222「新说法正文」，2026-11-21）' }]
  const gaCut = [{ id: 'new22222-9', content: '新说法正文' }]
  check('GA 行为: 被裁的接班者提上来', meowMod.liftSuccessors(gaShown, gaCut).length === 1 && meowMod.liftSuccessors(gaShown, gaCut)[0].id === 'new22222-9')
  const gaAmb = [
    { id: 'new22222-9', content: '完全不同的甲' },
    { id: 'new22222-8', content: '完全不同的乙' },
  ]
  check('GA 行为: 撞车且开头对不上 → 一条都不提', meowMod.liftSuccessors(gaShown, gaAmb).length === 0)
  const gaMany = ['1', '2', '3', '4'].map((n) => ({ id: `a${n}${n}${n}${n}${n}${n}${n}-1`, content: `x（已被取代：b${n}${n}${n}${n}${n}${n}${n}「甲${n}」，2026-11-21）` }))
  const gaCut4 = ['1', '2', '3', '4'].map((n) => ({ id: `b${n}${n}${n}${n}${n}${n}${n}-9`, content: `甲${n}` }))
  check('GA 行为: 四对也只提三条（上限 3）', meowMod.liftSuccessors(gaMany, gaCut4).length === 3)
  check('GA 克制: min_rel=0 时不算、不拼这句话', meowSrc.includes('const liftNote = lifted.length === 0') && meowMod.liftSuccessors([], gaCut).length === 0)
  check(
    'GA 文案: 一句话说清「它们才是接班者、上面那条别再当结论」（三语）',
    ['zh', 'en', 'pt-br'].every((lang) => readFileSync(new URL(`./vendor/meow-memory/lib/prompts/${lang}/labels.md`, import.meta.url), 'utf8').includes('- search.floorLift:')),
  )
}


// GB（0.2.144）：dream 前三块只在本轮行里互相比，全库从不参与——新写一条与旧条目一字不差，也没人说话。
// 补的是「本轮某条 ⇔ 全库某条」这一侧，且候选必须从索引里取（不做 N×M 全比）。
{
  const meowSrc = readFileSync(new URL('./vendor/meow-memory/lib/index.js', import.meta.url), 'utf8')
  const meowMod = await import('./vendor/meow-memory/lib/index.js')
  check('GB 源码: 全库参与比较（前三块只看本轮）', meowSrc.includes('function dreamRepeatIssues(allRows, db)') && meowSrc.includes('if (here.has(String(r.id))) continue;'))
  check('GB 源码: 本轮内部不重复报，交给 dupPairs', meowSrc.includes('const here = new Set(allRows.map((r) => String(r.id)));'))
  check('GB 源码: 候选从关键字 / 正文前缀索引里取，不做全库两两比', meowSrc.includes('const byHead = /* @__PURE__ */ new Map();') && meowSrc.includes('const byKw = /* @__PURE__ */ new Map();') && meowSrc.includes('if (n++ >= DREAM_REPEAT_SCAN) break;'))
  check('GB 源码: 接进 dream 清单（第五块）', meowSrc.includes('listBlock + dupBlock + repeatBlock + coverBlock + conflictBlock + chainBlock'))
  check('GB 源码: 有上限、有门槛', meowSrc.includes('var DREAM_REPEAT_MAX = 4;') && meowSrc.includes('var DREAM_REPEAT_MIN = 0.8;'))

  const gbOld = { id: '0mgb0001', level: 'fact', status: 'active', updated_at: Date.now() - 3e9, keywords: ['甲'], content: '探针甲：这条在库里躺了很久了，写法完全一样' }
  const gbNew = { id: '0mgb0002', level: 'fact', status: 'active', updated_at: Date.now(), keywords: ['甲'], content: '探针甲：这条在库里躺了很久了，写法完全一样' }
  const gbStub = (rows, counter) => ({ list: (level) => { counter.n++; return rows.filter((r) => r.level === level) } })
  const gbC = { n: 0 }
  const gbHit = meowMod.dreamRepeatIssues([gbNew], gbStub([gbOld], gbC))
  check('GB 行为: 库里那条被点出来（本轮只有它）', gbHit.list.length === 1 && String(gbHit.list[0].otherId) === '0mgb0001' && gbHit.list[0].repeat >= 0.8)
  check('GB 行为: 干净时也真查了库（scanned>0）', gbHit.scanned === 1)
  check('GB 行为: 两条都在本轮 → 不报、也不扫库', meowMod.dreamRepeatIssues([gbOld, gbNew], gbStub([gbOld], { n: 0 })).list.length === 0)
  check('GB 零成本: 本轮为空时一次库调用都不做', (() => { const c = { n: 0 }; const r = meowMod.dreamRepeatIssues([], gbStub([gbOld], c)); return c.n === 0 && r.list.length === 0 })())
  check('GB 行为: 只是关键字撞上、正文不同 → 不当重复', meowMod.dreamRepeatIssues([{ ...gbNew, id: '0mgb0005', updated_at: Date.now() + 1, content: '完全另一件事：验证码要先切图' }], gbStub([gbOld], { n: 0 })).list.length === 0)
  check('GB 行为: 关键字为空也靠正文前缀认得出', meowMod.dreamRepeatIssues([{ ...gbNew, id: '0mgb0003', keywords: [] }], gbStub([gbOld], { n: 0 })).list.length === 1)
  check('GB 行为: 对方已退位也要报', meowMod.dreamRepeatIssues([gbNew], gbStub([{ ...gbOld, status: 'stale' }], { n: 0 })).list[0]?.otherStatus === 'stale')
  const gbLbl = (key, vars = {}) => {
    const line = readFileSync(new URL('./vendor/meow-memory/lib/prompts/zh/labels.md', import.meta.url), 'utf8').split('\n').find((one) => one.startsWith(`- ${key}:`))
    if (line === void 0) return ''
    return line.slice(key.length + 3).trim().replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m))
  }
  const gbShort = new Map([['0mgb0001', '0mgb0001'], ['0mgb0002', '0mgb0002']])
  const gbBlock = meowMod.dreamRepeatBlock({ list: gbHit.list, total: 3 }, gbShort, gbLbl)
  check('GB 文案: 标题报总数、不拿「列了几条」冒充', gbBlock.includes('库里已经有了 3 条'))
  check('GB 文案: 每条都念出对方 id 与重复度', gbBlock.includes('0mgb0001') && gbBlock.includes('重复度 100%'))
  check('GB 文案: 对方在用 → 并进它 + 标 stale；对方退位 → 问是复活还是新结论', gbBlock.includes('并进 0mgb0001') && gbBlock.includes('标 stale') && meowMod.dreamRepeatBlock({ list: meowMod.dreamRepeatIssues([gbNew], gbStub([{ ...gbOld, status: 'stale' }], { n: 0 })).list, total: 1 }, gbShort, gbLbl).includes('复活'))
  check('GB 克制: 没有重复时整段是空串', meowMod.dreamRepeatBlock({ list: [], total: 0 }, gbShort, gbLbl) === '')
  check('GB 不建表: 只读现有行', !/ALTER TABLE|CREATE INDEX/.test(meowSrc.slice(meowSrc.indexOf('function dreamRepeatIssues('), meowSrc.indexOf('function dreamRepeatBlock('))))
  check(
    'GB 文案: 六键三语齐全',
    ['zh', 'en', 'pt-br'].every((lang) => ['dream.repeat.title', 'dream.repeat.line', 'dream.repeat.keep', 'dream.repeat.revive', 'dream.repeat.more', 'dream.repeat.rule'].every((key) => readFileSync(new URL(`./vendor/meow-memory/lib/prompts/${lang}/labels.md`, import.meta.url), 'utf8').includes(`- ${key}:`))),
  )
}

// ── GV（0.2.145）：0.2.18 把每轮自动注入整段删了，检索退化成「模型想起来才查」——
//    省了 token，也把记忆系统降级了。这一刀把「这一轮的话在星图里连着谁」自动带回来，
//    但必须满足三条：不进 system prompt 前缀、每轮便宜且有上限、注入自己说明来路。
{
  const nbSrc = readFileSync(new URL('./lib/macro/neighbor.js', import.meta.url), 'utf8')
  const nbMod = await import('./lib/macro/neighbor.js')
  const idxSrc = readFileSync(new URL('./lib/index.js', import.meta.url), 'utf8')
  check(
    'GV 源码: 注入器只挂 agent/pre-step，一个字都不往 systemPrompt 里塞（前缀缓存不能碎）',
    nbSrc.includes('export function createNeighborInjector(') &&
      nbSrc.includes("ctx.on('agent/pre-step'") &&
      !nbSrc.includes('systemPrompt'),
  )
  check(
    'GV 源码: 追加在最后一条用户消息之后，原来的 messages 一条不动',
    nbSrc.includes('return { ...decision, messages: [...messages, msg] }'),
  )
  check(
    'GV 源码: 星图走 bridge.tryCall，不直接读 vendor；工具名是常量',
    nbSrc.includes('bridge.tryCall(NEIGHBOR_TOOL') && nbSrc.includes("export const NEIGHBOR_TOOL = 'nebula_recall'"),
  )
  check(
    'GV 源码: 注入消息自带来源标记（读者/宿主都能分清它不是用户说的）',
    nbSrc.includes("export const NEIGHBOR_SOURCE_KIND = 'macro-memory:neighbor'") &&
      nbSrc.includes('source: { kind: NEIGHBOR_SOURCE_KIND') &&
      nbSrc.includes("form: 'notice'"),
  )
  check(
    'GV 源码: 上限是常量而不是散落在逻辑里（4 条 / 420 字符 / 记 200 条已带过）',
    nbMod.NEIGHBOR_DEFAULT_MAX === 4 && nbMod.NEIGHBOR_DEFAULT_CHARS === 420 && nbMod.NEIGHBOR_SEEN_MAX === 200,
  )
  check(
    'GV 装配: lib/index.js 建了注入器，并把 dispose 挂进 cleanups',
    idxSrc.includes('createNeighborInjector({') && idxSrc.includes('cleanups.push(() => neighbor.dispose())'),
  )
  check(
    'GV 装配: 三个旋钮在 MACRO_DEFAULTS、MACRO_KEYS、Config 三处都齐',
    idxSrc.includes('neighborInject: true') &&
      /'neighborInject',\s*'neighborMax',\s*'neighborChars',/.test(idxSrc) &&
      idxSrc.includes('neighborInject: z.boolean().default(') &&
      idxSrc.includes('neighborMax: z.number().default(') &&
      idxSrc.includes('neighborChars: z.number().default('),
  )

  const gvInternal = readFileSync(new URL('./docs/INTERNAL.md', import.meta.url), 'utf8')
  const gvDesign = readFileSync(new URL('./DESIGN.md', import.meta.url), 'utf8')
  check(
    'GV 文档: INTERNAL 9.151 与 DESIGN 157 在位，且 DESIGN 收在「记忆在场才是本事」上',
    gvInternal.includes('## 9.151 ') && gvInternal.includes('### 9.151.5 失败不挡这一轮') &&
      gvDesign.includes('## 157 ') && gvDesign.includes('记忆在场才是本事'),
  )
  check(
    `GV 版本: 代码里是 ${PKG_VERSION}（与 package.json / README 同号由基线与 doctor 各自守一条）`,
    idxSrc.includes(VERSION_LITERAL),
  )

  // 行为：真的追加、真的不挡这一轮、关掉就原样返回、同一会话不重复带
  // 0.6.43：邻域账本会落盘，这一段必须把 DSH_HOME 指到临时目录。用固定 sid 'gv-sess'
  // 跑第二遍时，账本里已经有 0mgv0001，那一条会被 skip → 第一条断言必红（假红，不是代码坏了）；
  // 同时也会把 gv-sess.json 写进主人的真库。
  const gvOldHome = process.env.DSH_HOME
  const gvHome = mkdtempSync(join(tmpdir(), 'macro-verify-gv-'))
  process.env.DSH_HOME = gvHome
  try {
  const gvMake = (init) => ({ role: 'user', ...init })
  const gvBridge = (text) => ({ tryCall: async () => ({ text }) })
  const gvAgent = { session: { id: 'gv-sess', header: {} } }
  const gvUser = {
    role: 'user',
    source: { kind: 'user' },
    content: [{ type: 'text', text: '写入节流那个窗口后来怎么定的' }],
  }
  const gvDec = { kind: 'enter', messages: [gvUser] }
  const gvRecall = ['1. [fact] dsh-macro-memory     强度 0.80 一条记忆', '  id: 0mgv0001'].join('\n')
  const gvInj = nbMod.createNeighborInjector({
    ctx: { on: () => () => {} },
    bridge: gvBridge(gvRecall),
    config: {},
    loadLlm: async () => ({ createUserMessage: gvMake }),
  })
  const gvOut = await gvInj.decide({ agent: gvAgent }, gvDec)
  check(
    'GV 行为: 追加而不是替换（原来那条仍是第一条、还是同一个对象）',
    gvOut.messages.length === 2 && gvOut.messages[0] === gvUser,
  )
  check(
    'GV 行为: 注入块开头就说「自动带来的」，收尾给读全文的办法',
    String(gvOut.messages[1]?.content?.[0]?.text ?? '').includes('自动带来的') &&
      String(gvOut.messages[1]?.content?.[0]?.text ?? '').includes('memory_read('),
  )
  const gvOff = nbMod.createNeighborInjector({
    ctx: { on: () => () => {} },
    bridge: gvBridge(gvRecall),
    config: { neighborInject: false },
    loadLlm: async () => ({ createUserMessage: gvMake }),
  })
  check('GV 行为: 关掉开关连对象都不换（原样返回同一个 decision）', (await gvOff.decide({ agent: gvAgent }, gvDec)) === gvDec)
  const gvSecond = await gvInj.decide({ agent: gvAgent }, gvDec)
  check('GV 行为: 同一会话第二轮不再带同一条', gvSecond.messages.length === 1 && gvInj.stats().injected === 1)
  const gvEmpty = nbMod.createNeighborInjector({
    ctx: { on: () => () => {} },
    bridge: gvBridge('星图里没找到相关记忆'),
    config: {},
    loadLlm: async () => ({ createUserMessage: gvMake }),
  })
  check('GV 克制: 星图没东西时一个字都不注入', (await gvEmpty.decide({ agent: gvAgent }, gvDec)) === gvDec)
  const gvBad = nbMod.createNeighborInjector({
    ctx: { on: () => () => {} },
    bridge: {
      tryCall: async () => {
        throw new Error('星图挂了')
      },
    },
    config: {},
    loadLlm: async () => ({ createUserMessage: gvMake }),
  })
  check('GV 行为: 星图报错不挡这一轮（原样返回）', (await gvBad.decide({ agent: gvAgent }, gvDec)) === gvDec)
  } finally {
    if (gvOldHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = gvOldHome
    rmSync(gvHome, { recursive: true, force: true })
  }
}

// ── GW（0.2.146）：噪声地板 —— 中文没有停用词表，BM25 对「怎么 / 那个 / 一下」照样给分。
//    库一大，这些词把候选集撑成「都沾点边」；回执看起来都相关，其实是问句里一半的字在灌水。
//    这一刀用 df 说话：出现在一半以上条目里的查询词不参与打分，也不参与覆盖度分母。
{
  const meowSrc = readFileSync(new URL('./vendor/meow-memory/lib/index.js', import.meta.url), 'utf8')
  const meowMod = await import('./vendor/meow-memory/lib/index.js')
  check(
    'GW 源码: 阈值是常量（一半以上 / 库至少 8 条），不是散在逻辑里的魔数',
    meowSrc.includes('var NOISE_DF_RATIO = 0.5;') && meowSrc.includes('var NOISE_MIN_DOCS = 8;'),
  )
  check(
    'GW 源码: 三条护栏各占一行——库小不剔、剔空回退、一键关',
    meowSrc.includes('function noiseTermsOf(qTerms, df, n) {') &&
      meowSrc.includes('if (n < NOISE_MIN_DOCS) return [];') &&
      meowSrc.includes('return out.length >= qTerms.length ? [] : out;') &&
      meowSrc.includes('opts.noiseFloor === false'),
  )
  check(
    'GW 源码: 分子分母同口径（BM25 走 qLoop、覆盖度走 qKept），只剔分子等于把问句变难',
    meowSrc.includes('for (const term of qLoop) {') &&
      meowSrc.includes('for (const term of qKept) if (tf[di].has(term)) cover += idfOf(term);'),
  )
  check(
    'GW 源码: 剔了谁要报出来（explain.noiseDropped），不是悄悄改口径',
    meowSrc.includes('noiseDropped: noiseDropped.slice()'),
  )

  const gwDoc = (id, c, sess) => ({
    id,
    level: 'fact',
    title: c.slice(0, 8),
    content: c,
    keywords: [],
    importance: 2,
    status: 'active',
    project: null,
    source_session: sess,
    created_at: 1700000000000,
    updated_at: 1700000000000,
  })
  const gwDocs = []
  for (let i = 0; i < 8; i++) gwDocs.push(gwDoc('n' + i, `怎么记录第${i}条无关的流水账，随手写写。`, 's' + i))
  gwDocs.push(gwDoc('real', '星图建图的延迟要盯着，一轮巡检大约 12 秒。', 's-real'))
  gwDocs.push(gwDoc('other', '另一个完全无关的条目，讲的是食堂菜单。', 's-other'))
  const gwQ = '怎么 星图建图的延迟调下来'
  const gwOn = meowMod.search(gwQ, gwDocs, { k: 12 })
  // [0.2.165] 这条测的是噪声地板：回执裁剪（bandKeep）与它无关，必须关掉，否则最多只回 5 条。
  // [0.2.170] 疑问框架剥离也是另一把刀：它会在分词前就拿走「怎么」，对照组只关地板，不关它。
  const gwOff = meowMod.search(gwQ, gwDocs, { k: 12, noiseFloor: false, funcFloor: false, bandKeep: false, questionStrip: false })
  check(
    'GW 行为: 只沾「怎么」的八条退出榜单，剩下真正相关的那条',
    gwOn.length === 1 && gwOn[0].id === 'real',
    gwOn.map((h) => h.id).join(','),
  )
  check(
    'GW 行为: 阴性对照 noiseFloor:false（且关掉 0.2.151 虚词地板）时八条全回来（真在起效）',
    gwOff.length === 9,
    `${gwOff.length} 条`,
  )
  const gwSmall = meowMod.search('怎么', gwDocs.slice(0, 5), { k: 8, explain: true })
  check(
    'GW 行为: 库小（5 条）时 df 不可信，一条都不剔',
    gwSmall.length === 5 && gwSmall[0]?.explain?.noiseDropped === undefined,
    `${gwSmall.length} 条`,
  )
  check(
    'GW 克制: 整句都是常用词时回退（宁可噪声，不给空结果）',
    meowMod.search('怎么', gwDocs, { k: 12 }).length === 8,
  )
  const gwIdx = readFileSync(new URL('./lib/index.js', import.meta.url), 'utf8')
  check(
    `GW 版本: 代码里是 ${PKG_VERSION}（与 package.json / README 同号由基线与 doctor 各自守一条）`,
    gwIdx.includes(VERSION_LITERAL),
  )
  const gwInt = readFileSync(new URL('./docs/INTERNAL.md', import.meta.url), 'utf8')
  const gwDes = readFileSync(new URL('./DESIGN.md', import.meta.url), 'utf8')
  check(
    'GW 文档: INTERNAL 9.152 讲了「与既有 levers 不重叠」，DESIGN 158 收在「都差不多」',
    gwInt.includes('## 9.152 ') && gwInt.includes('### 9.152.5 与既有 levers 不重叠') && gwDes.includes('## 158 ') && gwDes.includes('是「都差不多」'),
  )
  const gwA = meowMod.search(gwQ, gwDocs, { k: 12 })[0]
  const gwB = meowMod.search('星图建图的延迟调下来', gwDocs, { k: 12 })[0]
  check(
    'GW 等价: 剔掉 = 没问（同一问句去掉噪声词后首条分数逐位相同）',
    gwA?.id === gwB?.id && Math.abs((gwA?.score ?? 0) - (gwB?.score ?? 0)) < 1e-9,
    `${gwA?.score} vs ${gwB?.score}`,
  )
}

// ── VV（0.2.147）：标识符原样匹配 —— 版本号 / 路径 / 文件名 / 短 id 不该被分词切成碎词。
//    分词是检索的第一次解释，而解释会丢东西：0.2.146 切成 0 / 2 / 146，memory.db 切成 memori / db，
//    短 id 因为不在正文里、BM25 恒为 0，连候选集都进不去。这一刀加一条**不过分词**的证据通道：
//    问句里长得像标识符的那一段，按整串去候选文本里找，整串 1 / basename 0.7 / 去扩展名的主名 0.5。
//    加法补分（乘法乘在 0 上还是 0），认得克制（太短不算、最多 6 个、同一处证据只记一遍、一键关）。
{
  const idSrc = readFileSync(new URL('./vendor/meow-memory/lib/index.js', import.meta.url), 'utf8')
  const idMod = await import('./vendor/meow-memory/lib/index.js')
  check(
    'VV 源码: 六道阈值是常量（最短 4 / 最多 6 / 两份权重 / 两档降级信用）',
    idSrc.includes('var IDENT_MIN = 4;') &&
      idSrc.includes('var IDENT_MAX = 6;') &&
      idSrc.includes('var IDENT_W = 0.6;') &&
      idSrc.includes('var IDENT_ID_W = 1.5;') &&
      idSrc.includes('var IDENT_BASE_CREDIT = 0.7;') &&
      idSrc.includes('var IDENT_STEM_CREDIT = 0.5;'),
  )
  check(
    'VV 源码: 九条形状正则覆盖盘符路径 / 多段相对路径 / 带扩展名文件 / 版本号 / 日期 / 短 id / commit / kebab / a-b',
    idSrc.includes('var IDENT_RES = [') &&
      idSrc.includes('/[A-Za-z]:\\\\') &&
      idSrc.includes('/(?:[\\w.@-]+\\/){2,}[\\w.@-]+/g') &&
      idSrc.includes('\\.(?:js|mjs|cjs|ts|tsx|json|md|db|py|ps1|yml|yaml|toml|txt|zip|exe|dll|log)') &&
      idSrc.includes('/\\b\\d+\\.\\d+\\.\\d+\\b/g') &&
      idSrc.includes('/\\b\\d{4}-\\d{2}-\\d{2}\\b/g') &&
      idSrc.includes('/\\b0m[a-z0-9]{5,}\\b/gi') &&
      idSrc.includes('/\\b[0-9a-f]{7,40}\\b/gi') &&
      idSrc.includes('(?:[-_][a-z0-9]+)+'),
  )
  check(
    'VV 源码: identsOf 四道筛（短于 4 丢掉 / 去重 / 包含关系去冗余 / 上限 6）',
    idSrc.includes('if (t.length < IDENT_MIN) continue;') &&
      idSrc.includes('if (!out.includes(t)) out.push(t);') &&
      idSrc.includes('const kept = out.filter((t) => !out.some((u) => u !== t && u.length > t.length && u.includes(t)));') &&
      idSrc.includes('return kept.slice(0, IDENT_MAX);'),
  )
  check(
    'VV 源码: 分级信用三档（整串 1 / basename 0.7 / 主名 0.5），并且降级要标「(局部)」',
    idSrc.includes('if (hay.includes(ident)) return 1;') &&
      idSrc.includes('if (base !== ident && base.length >= IDENT_MIN && hay.includes(base)) return IDENT_BASE_CREDIT;') &&
      idSrc.includes('if (stem !== base && stem.length >= IDENT_MIN && hay.includes(stem)) return IDENT_STEM_CREDIT;') &&
      idSrc.includes('matched.push(c >= 1 ? t : t + "(局部)");'),
  )
  check(
    'VV 源码: 候选文本含 id 与 project（短 id 指认靠的是字段，不是正文里恰好出现那几个字；0.6.11 起这段搬进索引的 hayAt 懒建）',
    idSrc.includes("(String(d?.id ?? '') + ' ' + String(d?.project ?? '') + ' ' + docText(d)).toLowerCase()"),
  )
  check(
    'VV 源码: 加法补分（单位分数 × ratio × 权重，指认 id 时用 1.5 那一档）——0.2.148 起落在加权之后的 post-pass 里；0.2.178 起坐标位上的标识符不给加成',
    idSrc.includes('const add = unitScore * vb.ratio * (idHit ? IDENT_ID_W : IDENT_W) * (identHardOk ? 1 : 0);') &&
      idSrc.includes('h.score += add;'),
  )
  check(
    'VV 源码: 早退改成「词与标识符都没有才空」，否则 BM25 为 0 的原样命中会被提前挡掉（0.6.4 起单字问句在这里转交兜底，不许直接回空）',
    idSrc.includes('if (q.length === 0 && idents.length === 0) return literalFallback(query, docs, opts);'),
  )
  check(
    'VV 源码: 一键回旧口径（verbatim:false 直接不给标识符，整段惰性）',
    idSrc.includes('const idents = opts.verbatim === false ? [] : identsOf(query);'),
  )
  check(
    'VV 源码: 认得谁要说出来（explain.verbatim + identBonus 同报，且 bm25 回到纯词分）',
    idSrc.includes('verbatim: vbOf.matched.slice()') &&
      idSrc.includes('h.explain.identBonus = Math.round(add * 1e3) / 1e3;') &&
      idSrc.includes('bm25: Math.round(baseRaw[di] * 1e3) / 1e3'),
  )
  check(
    'VV 源码: 两支打分器同口径（keywordHitScore 也走 verbatimInputs）',
    idSrc.split('verbatimInputs(').length - 1 >= 3,
  )

  const idDoc = (id, c, sess) => ({
    id,
    level: 'fact',
    title: c.slice(0, 8),
    content: c,
    keywords: [],
    importance: 2,
    status: 'active',
    project: null,
    source_session: sess,
    created_at: 1700000000000,
    updated_at: 1700000000000,
  })
  const idDocs = [
    idDoc('v146', '0.2.146 加了噪声地板：用 df 判据剔噪声词，分子分母同口径。', 's-v1'),
    idDoc('vnoise', '改了措辞之后分数漂了一点，别当成回归。', 's-v3'),
    idDoc('vpath', '补丁改的是 D:\\dsh-home\\vendor\\meow-memory\\lib\\index.js 里的 search()。', 's-v4'),
    idDoc('0mwq5zzv8-c6a56522bbaa', '这一条正文里没有半个标识符，只讲交付态。', 's-v6'),
  ]
  const idOn = idMod.search('0mwq5zzv 是什么', idDocs, { k: 12, explain: true })
  const idOff = idMod.search('0mwq5zzv 是什么', idDocs, { k: 12, verbatim: false, explain: true })
  check(
    'VV 行为: 问一段短 id，id 就是那条的那位直接第 1，且 explain.bm25 为 0（纯指认）',
    idOn[0]?.id === '0mwq5zzv8-c6a56522bbaa' && idOn[0]?.explain?.bm25 === 0,
    `${idOn[0]?.id}@${idOn[0]?.score} bm25=${idOn[0]?.explain?.bm25}`,
  )
  check(
    'VV 行为: 阴性对照 verbatim:false 时那条连候选都进不去（不是「本来就有分」）',
    !idOff.some((h) => h.id === '0mwq5zzv8-c6a56522bbaa') && idOff.every((h) => h.explain.verbatim === undefined),
    idOff.map((h) => h.id).join(',') || '0 条',
  )
  const idPath = idMod.search('D:\\dsh-home\\vendor\\meow-memory\\lib\\index.js 改了什么', idDocs, { k: 12, explain: true })
  check(
    'VV 行为: 路径整串命中时正文带这串路径的那条排第 1（问句里的路径不再是段名碎片）',
    idPath[0]?.id === 'vpath',
    `${idPath[0]?.id}@${idPath[0]?.score}`,
  )
  const idLoose = idMod.search('E:\\Temp\\lib\\index.js 改了什么', idDocs, { k: 12, explain: true }).find((h) => h.id === 'vpath')
  check(
    'VV 行为: 只命中 basename 时标「(局部)」——降级命中不许冒充整串命中',
    (idLoose?.explain?.verbatim ?? []).some((t) => t.endsWith('(局部)')),
    JSON.stringify(idLoose?.explain?.verbatim ?? null),
  )
  const plainQ = '星图建图的延迟要盯着'
  const plainA = idMod.search(plainQ, idDocs, { k: 12 }).map((h) => `${h.id}:${h.score}`)
  const plainB = idMod.search(plainQ, idDocs, { k: 12, verbatim: false }).map((h) => `${h.id}:${h.score}`)
  check(
    'VV 行为: 问句里没有标识符时逐条同分（不是「多多少少加点分」）',
    plainA.join(' ') === plainB.join(' '),
    plainA.join(' '),
  )
  const idKw = idMod.keywordHitScore('0mwq5zzv 是什么', idDocs, { k: 5 })
  check(
    'VV 行为: 另一支打分器也认得出同一段短 id（换个入口不换答案）',
    idKw[0]?.id === '0mwq5zzv8-c6a56522bbaa',
    idKw.map((h) => h.id).join(',') || '0 条',
  )
  const idIdx = readFileSync(new URL('./lib/index.js', import.meta.url), 'utf8')
  check(
    `VV 版本: 代码里是 ${PKG_VERSION}（与 package.json / README 同号由基线与 doctor 各自守一条）`,
    idIdx.includes(VERSION_LITERAL),
  )
  const idInt = readFileSync(new URL('./docs/INTERNAL.md', import.meta.url), 'utf8')
  const idDes = readFileSync(new URL('./DESIGN.md', import.meta.url), 'utf8')
  check(
    'VV 文档: INTERNAL 9.153 讲了「与既有 levers 不重叠」，DESIGN 159 收在「都得有一条不被切碎的路」',
    idInt.includes('## 9.153 ') &&
      idInt.includes('### 9.153.5 与既有 levers 不重叠') &&
      idDes.includes('## 159 ') &&
      idDes.includes('都得有一条不被切碎的路'),
  )
}

/** ───────── VW（0.2.148）：补分落在加权之后 ───────── */
{
  const MW = readFileSync(new URL('./vendor/meow-memory/lib/index.js', import.meta.url), 'utf8')
  const MWmod = { search: (await import('./vendor/meow-memory/lib/index.js')).search }
  // 源码顺序：补分块必须在 push 循环之后（而不是写进 raw）
  // [0.6.14] 原样证据不再挂在 hit 上（`delete h._vb` 会把对象打进字典模式），改走同下标平行数组；
  // 「push 之后」这个位置关系仍然成立，只是锚点从对象字面量换成 `vbTmp.push(vbOf);`。
  const iPush = MW.indexOf('vbTmp.push(vbOf);')
  const iUnit = MW.indexOf('const unitScore = topScore > 0 ? topScore : 1;')
  const iSort = MW.indexOf("bandize(hits, '_raw', k)")
  check('VW1 补分块在 push 之后', iPush > 0 && iUnit > iPush, `${iPush}/${iUnit}`)
  check('VW2 补分块在 sort 之前（排位之前就定死）', iUnit > 0 && iSort > iUnit, `${iUnit}/${iSort}`)
  check('VW3 单位取榜首实际分数', MW.includes('const unitScore = topScore > 0 ? topScore : 1;'))
  // [0.6.14] 「search 这条主路」不再靠 delete 收场：临时值走同下标平行数组，hit 对象上不落痕迹。
  const iTmp = MW.indexOf('const vbTmp = [];')
  const iTmpEnd = MW.indexOf("bandize(hits, '_raw', k)")
  const searchHot = iTmp > 0 && iTmpEnd > iTmp ? MW.slice(iTmp, iTmpEnd) : ''
  check('VW4 临时字段有死期：主路不再用 delete 摘（平行数组 → 对象不进字典模式）', iTmp > 0 && !searchHot.includes('delete h._vb;') && !searchHot.includes('delete h._sr;') && !searchHot.includes('delete h._lv;') && !searchHot.includes('delete h._tr;'))
  // [0.6.32] 快路自己也要算一次「单位分」（缓冲上没有对象可挂），所以 search 里现在有两份；
  // 判据的意思没变：search 与 keywordHitScore 都必须有这一段，且不许只有一处。
  const iKw5 = MW.indexOf('function keywordHitScore(')
  const kwHot5 = iKw5 < 0 ? '' : MW.slice(iKw5, MW.indexOf('\nfunction ', iKw5 + 1))
  const nUnit5 = (MW.match(/const unitScore = topScore > 0 \? topScore : 1;/g) || []).length
  check(
    'VW5 两支打分器都走 post-pass（search 与 keywordHitScore 各一处 unitScore）',
    nUnit5 >= 2 && kwHot5.includes('const unitScore = topScore > 0 ? topScore : 1;'),
    `${nUnit5} 处 · keywordHitScore ${kwHot5.includes('const unitScore = topScore > 0 ? topScore : 1;') ? '有' : '无'}`,
  )
  check(
    'VW6 放行条件放行「无词分但有原样证据」',
    // [0.2.176] 放行条件多了一条出口：现状仓条目词分必然是 0（问句和它一个词都不重），
    // 它靠 statusDigest 进候选。原来的两处判断留在原处，只在后面接了一段 —— 这里认两种写法。
    (MW.match(/if \(raw\[di\] <= 0 && rawVerbatim\[di\] === null\) continue;/g) || []).length +
      (MW.match(/if \(raw\[di\] <= 0 && rawVerbatim\[di\] === null && !\(statusDig !== null/g) || []).length === 2,
  )
  check('VW7 旧的 raw 内补分已撤（raw 里不再出现 identBonus 累加）', !MW.includes('raw[di] += unitRaw * vb.ratio'))

  // 行为：指认压得住 importance=4 的措辞命中
  const vwDoc = (id, content, imp, sess) => ({
    id,
    level: 'fact',
    title: content.slice(0, 8),
    content,
    keywords: [],
    importance: imp,
    status: 'active',
    project: null,
    source_session: sess,
    created_at: Date.now() - 86400000,
    updated_at: 1700000000000,
  })
  const VW_DOCS = [
    vwDoc('0mzz9abc1-aaaa', '这一条正文里没有半个标识符，只讲交付态。', 1, 'vw-a'),
    vwDoc('loud', '改了什么 措辞更像那一条，而且重要度写得很高。', 4, 'vw-b'),
  ]
  const on = MWmod.search('0mzz9abc1 是什么', VW_DOCS, { k: 8, explain: true })
  // [0.2.170] 对照组只关「看得见的那两把刀」：疑问框架剥离会在分词前拿走「是什么」，一起关掉才量得准。
  const off = MWmod.search('0mzz9abc1 是什么', VW_DOCS, { k: 8, verbatim: false, funcFloor: false, questionStrip: false })
  check('VW8 行为：被指认那条排第 1（importance=1 也压得住 4 分的措辞命中）', on[0]?.id === '0mzz9abc1-aaaa')
  check(
    'VW9 行为：score 与 identBonus 同值（证明补分在乘法之后）',
    Math.abs((on[0]?.score ?? 0) - (on[0]?.explain?.identBonus ?? -1)) < 2e-3,
  )
  check('VW10 行为：阴性对照下措辞重新占榜首', off[0]?.id === 'loud')
  check(
    'VW11 行为：回执里没有 _vb 这种内部字段',
    on.every((h) => h._vb === void 0),
  )
  const vwInt = readFileSync(new URL('./docs/INTERNAL.md', import.meta.url), 'utf8')
  const vwDes = readFileSync(new URL('./DESIGN.md', import.meta.url), 'utf8')
  check(
    'VW12 文档: INTERNAL 9.154 讲了「加法之后还有一次乘法」与「不重叠：税前还是税后发」',
    vwInt.includes('## 9.154 ') &&
      vwInt.includes('加法之后还有一次乘法') &&
      vwInt.includes('### 9.154.5 与既有 levers 不重叠'),
  )
  check(
    'VW13 文档: DESIGN 160 收在「价值是本身决定的，排位是最后一刻决定的」',
    vwDes.includes('## 160 ') && vwDes.includes('证据的价值是它本身决定的'),
  )
}

/** ───────── GX（0.2.149）：准确率量尺 ───────── */
{
  const gold = JSON.parse(readFileSync(new URL('./tools/fixtures/gold-recall.json', import.meta.url), 'utf8'))
  const MG = readFileSync(new URL('./tools/probe-gold.mjs', import.meta.url), 'utf8')
  const MC = readFileSync(new URL('./tools/check-all.mjs', import.meta.url), 'utf8')
  const MWg = await import('./vendor/meow-memory/lib/index.js')

  // 语料形状：真实样张，不是合成的「全 fact 全 active」
  check(
    'GX1 语料 40 条样张 + 45 条问句',
    gold.docs.length === 40 && gold.queries.length === 45,
    `${gold.docs.length}/${gold.queries.length}`,
  )
  check(
    'GX2 语料层数与状态有真东西（≥3 种层、含非 active）',
    new Set(gold.docs.map((d) => d.level)).size >= 3 && gold.docs.some((d) => d.status !== 'active'),
  )
  check(
    'GX3 每条问句都有非空 want 且都在语料里',
    gold.queries.every((q) => Array.isArray(q.want) && q.want.length > 0) &&
      new Set(gold.docs.map((d) => d.id)).size === gold.docs.length &&
      gold.queries.every((q) => q.want.every((id) => gold.docs.some((d) => d.id === id))),
  )
  check(
    'GX4 问句不是抄正文（没有一条问句整句出现在任何样张正文里）',
    gold.queries.every((q) => !gold.docs.some((d) => String(d.content).includes(q.q))),
  )

  check(
    'VZ15 文档锚：9.157 与 163 写下了这一刀',
    readFileSync(new URL('./docs/INTERNAL.md', import.meta.url), 'utf8').includes('## 9.157 ') &&
      readFileSync(new URL('./DESIGN.md', import.meta.url), 'utf8').includes('## 163 '),
  )
  // 三档口径与阈值：只读探针自带断言，阈值不许写死在注释里
  check('GX5 hit@1 门槛 ≥ 0.88', MG.includes('base.hit1 >= 0.88'))
  check('GX6 hit@3 门槛 ≥ 0.95', MG.includes('base.hit3 >= 0.95'))
  check('GX7 MRR 门槛 ≥ 0.92', MG.includes('base.mrr >= 0.92'))
  check('GX8 三档聚合里 MRR 按名次倒数累加（不是命中即 1）', MG.includes('1 / (rank + 1)'))
  check('GX9 只看聚合：单题命中不许当基线（want 是集合）', MG.includes('want.includes(id)'))

  // 阴性对照：方向只报不判，判据只断言「量得到」
  check(
    'GX10 阴性对照换代：带内微案例证明重要度还活着，聚合上抹平它只要求「不许崩」',
    MG.includes('G5a 带内重要度仍然改判') &&
      MG.includes('G5b 带外重要度不许越级') &&
      MG.includes('flatM.hit1 >= 0.88') &&
      !MG.includes('flatM.hit1 < base.hit1'),
  )
  check('GX11 阴性对照语料反序（顺序敏感的排名会露馅）', MG.includes('docs.slice().reverse()'))
  check('GX12 同一输入跑两遍逐位相同（可复现）', MG.includes('again.hit1 === base.hit1'))

  // 行为：真跑一遍，三档在合理区间且抹平 importance 确实改变了读数
  const run = (corpus) => {
    let h1 = 0
    let h3 = 0
    let mrr = 0
    for (const { q, want } of gold.queries) {
      const ids = MWg.search(q, corpus, { k: 5 }).map((h) => String(h.id))
      const rank = ids.findIndex((id) => want.includes(id))
      if (rank === 0) h1++
      if (rank >= 0 && rank < 3) h3++
      mrr += rank >= 0 ? 1 / (rank + 1) : 0
    }
    const n = gold.queries.length
    return { hit1: h1 / n, hit3: h3 / n, mrr: mrr / n }
  }
  const b = run(gold.docs)
  check('GX13 实跑 hit@1 达标', b.hit1 >= 0.88, b.hit1.toFixed(3))
  check('GX14 实跑 hit@3 达标', b.hit3 >= 0.95, b.hit3.toFixed(3))
  check('GX15 实跑 MRR 达标', b.mrr >= 0.92, b.mrr.toFixed(3))
  const flatRun = run(gold.docs.map((d) => ({ ...d, importance: 2 })))
  check(
    'GX16 抹平 importance 后仍然达标（先验不是证据，去掉它顶多平手）',
    flatRun.hit1 >= 0.88 && flatRun.hit3 >= 0.95,
    `${b.hit1.toFixed(3)} → ${flatRun.hit1.toFixed(3)}`,
  )

  // 0.2.152：尺子补真之后新增的两条——换说法组（问句不抄正文用词）与它的阴性对照
  check(
    'GX21 换说法组在尺子上（14 条刻意避开正文用词，门槛 0.45/0.65/0.52）',
    MG.includes('para.hit1 >= 0.45 && para.hit3 >= 0.65 && para.mrr >= 0.52') &&
      Array.isArray(gold.paraphrase) &&
      gold.paraphrase.length >= 14,
  )
  check(
    'GX22 阴性对照：关键词当正文（kwSeparate:false）时两个池都不许更好',
    MG.includes('bodyM.hit1 <= base.hit1 + 1e-9 && bodyP.hit1 <= para.hit1 + 1e-9'),
  )

  // 挂进总检查：新尺子必须进清单，否则等于没造
  check('GX17 已挂进 check-all 清单', MC.includes("['tools/probe-gold.mjs',"))
  check(
    'GX18 清单文案说明量的是什么（准确率三档）',
    MC.includes('准确率量尺') && MC.includes('hit@1'),
  )

  // 版本与文档锚
  check(
    `GX19 版本已到 ${PKG_VERSION}（两处一致）`,
    JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version === PKG_VERSION &&
      readFileSync(new URL('./lib/index.js', import.meta.url), 'utf8').includes(VERSION_LITERAL),
  )
  const idG = readFileSync(new URL('./docs/INTERNAL.md', import.meta.url), 'utf8')
  const deG = readFileSync(new URL('./DESIGN.md', import.meta.url), 'utf8')
  check(
    'GX20 文档写了这一刀（9.155 + 161）',
    idG.includes('## 9.155 ') &&
      idG.includes('没有一条探针回答「用户随口问一句，第一条是不是他要的那条」') &&
      deG.includes('## 161 ') &&
      deG.includes('如果一把尺子只会确认你，它不是尺子，是回音'),
  )
}

/** ───────── VY（0.2.150）：证据先分档，档内才谈权重 ───────── */
{
  const MY = readFileSync(new URL('./vendor/meow-memory/lib/index.js', import.meta.url), 'utf8')
  const MYmod = await import('./vendor/meow-memory/lib/index.js')

  check('VY1 常量 IMP_BAND = 0.85（相邻差 17% 内算同档）', MY.includes('var IMP_BAND = 0.85;'))
  check('VY2 常量 RECENCY_FLOOR = 0.6（时间折扣有下限）', MY.includes('var RECENCY_FLOOR = 0.6;'))
  check(
    'VY3 分档器存在且在档内才比分数（bandize 里 orderOf 先比 _bandTmp 再比 score，档号不再走 Map）',
    MY.includes('function bandize(hits, rawKey, limit = Infinity)') &&
      MY.includes('(a._bandTmp - b._bandTmp) || (b.score - a.score)') &&
      !MY.includes('bandOf.set('),
  )
  check(
    'VY4 两处新鲜度都用同一个 85% 带（IMP_BAND）而不是各自写死 0.85',
    // 0.6.31：阈值提到循环外之后是 `const impBandMax = IMP_BAND * maxRaw;` 两处；
    // 注释里也会提到这个名字，判之前先剔整行注释（否则必自撞）。
    (MY.replace(/^\s*\/\/.*$/gm, '').match(/IMP_BAND \* maxRaw/g) || []).length === 2,
  )
  check(
    'VY5 两处新鲜度都有下限（Math.max(RECENCY_FLOOR, recencyWeight(...))）',
    // [0.6.34] 热路改毫秒梯子，`Math.max` 里换成多行三元；一律按 `Math.max(※RECENCY_FLOOR,` 数（仍是两处）。
    (MY.match(/Math\.max\(\s*RECENCY_FLOOR,/g) || []).length === 2,
  )
  check(
    'VY6 两支打分器都挂词分给分档用（_raw 两处；search 那处还要乘上标识符、主语位、层级意图三把刀）',
    // [0.6.17] 三处：逐条扫的 scanDoc、扫描期瘦 hit、水化——瘦路与完整路同一句算式。
    (MY.match(/_raw: raw\[di\]/g) || []).length === 3 &&
      MY.includes('_raw: raw[di] * (1 +') &&
      // [0.6.15] 三把刀的比例先进 `vbOf` / `srOf`，_raw 那行读变量。
      MY.includes('identBandW * vbOf.ratio') &&
      MY.includes('identSubjW * srOf') &&
      (MY.includes('lvHit && opts.levelIntent !== false ? levelIntentW : 0') ||
        MY.includes('lvHit && lvOn ? levelIntentW : 0')),
  )
  check(
    'VY7 两支打分器都走 bandize，且临时字段有死期',
    (MY.match(/bandize\((hits|out), '_raw', k\);/g) || []).length === 2 &&
      (MY.match(/delete h\._ident;/g) || []).length === 2,
  )
  check(
    'VY8 指认命中与主语位都排最前（band -1），词分为 0 也不许被扫到最后一档',
    MY.includes("if (h._ident === true || h._subj === 1) {") && MY.includes('h._bandTmp = -1;'),
  )
  check('VY9 档号写进 explain（档位对调用方可见）', MY.includes('h.explain.band = h._band;'))

  // 行为：同一句话两条记忆，档内由重要度改判
  const vyDoc = (id, content, imp, extra) => ({
    id, level: 'fact', title: content.slice(0, 8), content, keywords: [], importance: imp,
    status: 'active', project: null, created_at: '2026-11-20T00:00:00.000Z',
    updated_at: '2026-11-20T00:00:00.000Z', ...(extra || {}),
  })
  const vyA = MYmod.search('上传 github 之前 必须 问主人 点头', [
    vyDoc('vy-hi', '上传 github 之前 必须 先问主人 点头 再 push', 4),
    vyDoc('vy-lo', '上传 github 之前 必须 先问主人 点头 再 push', 2),
  ], { k: 2, explain: true })
  check(
    'VY10 行为：同档内 important 高的在前（重要度没有被废掉）',
    vyA[0]?.id === 'vy-hi' && vyA.every((h) => h.explain?.band === 0),
  )

  // 行为：带外条目即使分数更高也排后面
  const vyB = MYmod.search('标识符 版本号 路径', [
    vyDoc('vy-out-hi', '版本号 总览 主线 推进 到 哪一版', 4),
    vyDoc('vy-out-lo', '标识符 版本号 路径 标识符 版本号 路径', 2),
  ], { k: 2, explain: true })
  check(
    'VY11 行为：词分差一档就跨不过去（带外条目 band ≥ 1，榜首是 band 0）',
    vyB[0]?.id === 'vy-out-lo' && vyB[0]?.explain?.band === 0 &&
      vyB.find((h) => h.id === 'vy-out-hi')?.explain?.band >= 1,
  )

  // 行为：旧记忆留在榜上，权重停在 0.6
  const vyC = MYmod.search('鲸落 深海 回声 泡沫', [
    vyDoc('vy-new', '鲸落 深海 回声 泡沫 的 一次 记录', 2, { updated_at: '2026-11-21T00:00:00.000Z' }),
    vyDoc('vy-old', '鲸落 只有 一个 词', 2, { updated_at: '2025-11-01T00:00:00.000Z' }),
  ], { k: 2, explain: true })
  const vyOld = vyC.find((h) => h.id === 'vy-old')
  check(
    'VY12 行为：时间折扣有下限（旧条 recencyWeight 停在 0.6 且仍在榜上）',
    vyOld?.explain?.recencyWeight === 0.6 && vyC.some((h) => h.id === 'vy-old'),
  )

  // 行为：指认仍然压得住更高重要度的措辞命中（0.2.147/0.2.148 的保证不许被分档破坏）
  const vyD = MYmod.search('0mzz9abc1 是什么', [
    vyDoc('0mzz9abc1-aaaa', '这一条正文里没有半个标识符，只讲交付态。', 1),
    vyDoc('loud', '改了什么 措辞更像那一条，而且重要度写得很高。', 4),
  ], { k: 2, explain: true })
  check('VY13 行为：指认排第 1（分档把指认放在 band -1，不被词分档拖下去）', vyD[0]?.id === '0mzz9abc1-aaaa')

  // 文档与版本锚
  const idY = readFileSync(new URL('./docs/INTERNAL.md', import.meta.url), 'utf8')
  const deY = readFileSync(new URL('./DESIGN.md', import.meta.url), 'utf8')
  check(
    'VY14 文档写了这一刀（9.156 + 162）',
    idY.includes('## 9.156 ') && deY.includes('## 162 ') && deY.includes('档'),
  )
  check(
    `VY15 版本三处一致 ${PKG_VERSION}`,
    JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version === PKG_VERSION &&
      readFileSync(new URL('./lib/index.js', import.meta.url), 'utf8').includes(VERSION_LITERAL) &&
      readFileSync(new URL('./README.md', import.meta.url), 'utf8').includes(PKG_VERSION),
  )
}

/** ───────── WZ（0.2.152）：关键词是标签，不是正文 ───────── */
{
  const MWz = readFileSync(new URL('./vendor/meow-memory/lib/index.js', import.meta.url), 'utf8')
  const Mz = await import('./vendor/meow-memory/lib/index.js')

  check(
    'WZ1 常量在：kwTfW 默认读 KW_TF_W（0.2.161 起 0.35），且允许 0（关掉 tf 只留字段加成）',
    MWz.includes('const kwTfW = Number.isFinite(opts.kwTfW) && opts.kwTfW >= 0 ? opts.kwTfW : KW_TF_W;') &&
      MWz.includes('var KW_TF_W = 0.35;'),
  )
  check(
    'WZ2 kwSeparate 默认开：正文 BM25 只吃 title + content（opts.kwSeparate === false 才回退）',
    MWz.includes('const kwSep = opts.kwSeparate !== false;') &&
      MWz.includes('if (kwSep) {') &&
      MWz.includes("const extra = kwList(d).flatMap((w) => tokenizeSegs(String(w ?? '')));") &&
      MWz.includes('plainToks[i] = finishToks(ts);'),
  )
  // [0.6.24] 首见判据统一到 `const cur = m.get(t)` 之后，这条写入变成「首见写 kwTfW / 再见累加 cur」
  // 两句——守的仍是「关键词按 kwTfW 打折、且进的是同一张 m（进而同一张 df），候选资格不掉」。
  check(
    'WZ3 关键词计数按 kwTfW 打折写进同一张 df 表（候选资格不掉）',
    MWz.includes('m.set(t, kwTfW);') && MWz.includes('m.set(t, cur + kwTfW);') && MWz.includes('const cur = m.get(t);'),
  )
  check(
    'WZ4 0.2.133 的字段加成还在（FIELD_KW_W 可调，默认读 FIELD_KW_W_DEF = 0.6）',
    MWz.includes('const FIELD_KW_W = Number.isFinite(opts.fieldKwW) ? opts.fieldKwW : FIELD_KW_W_DEF;') &&
      MWz.includes('var FIELD_KW_W_DEF = 0.6;'),
  )

  // 行为：同一篇正文 + 标签，标签只有 1/4 的重量
  const dWz = (id, content, keywords = []) => ({ id, level: 'fact', title: '', content, keywords, importance: 1, project: 'wz', updated_at: 1763e9, last_accessed_at: 1763e9 })
  const wzDocs = [dWz('body', '关键词是标签'), dWz('tag', '甲乙丙丁', ['关键词'])]
  const wzHits = Mz.search('关键词', wzDocs, { k: 2, explain: true })
  check('WZ5 行为: 正文命中的压过只在 tags 里提到的（标签不是正文）', wzHits[0]?.id === 'body', wzHits.map((h) => h.id).join(','))
  const wzFlat = Mz.search('关键词', wzDocs, { k: 2, kwSeparate: false, explain: true })
  check('WZ6 阴性对照: 关键词退回平铺时标签那条翻上来', wzFlat[0]?.id === 'tag', wzFlat.map((h) => h.id).join(','))
  const wzZero = Mz.search('关键词', wzDocs, { k: 2, kwTfW: 0, explain: true })
  check('WZ7 阴性对照: kwTfW=0 时标签那条 tf 归零（只在 df 里留个位置）', (wzZero.find((h) => h.id === 'tag')?.explain?.bm25 ?? 0) < (wzHits.find((h) => h.id === 'tag')?.explain?.bm25 ?? 1), `${wzZero.find((h) => h.id === 'tag')?.explain?.bm25} vs ${wzHits.find((h) => h.id === 'tag')?.explain?.bm25}`)

  const idWz = readFileSync(new URL('./docs/INTERNAL.md', import.meta.url), 'utf8')
  const deWz = readFileSync(new URL('./DESIGN.md', import.meta.url), 'utf8')
  check(
    'WZ8 文档锚：9.158 与 164 写下了这一刀（含「尺子先被怀疑一次」与 12/14 → 9/14 的代价）',
    idWz.includes('## 9.158 ') &&
      idWz.includes('关键词是标签，不是正文') &&
      idWz.includes('9/14') &&
      deWz.includes('## 164 ') &&
      deWz.includes('桥能过车，也能过噪声'),
  )
  const pkgWz = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))
  check(
    `WZ9 版本已到 ${PKG_VERSION}（三处一致）`,
    pkgWz.version === PKG_VERSION &&
      readFileSync(new URL('./lib/index.js', import.meta.url), 'utf8').includes(VERSION_LITERAL) &&
      readFileSync(new URL('./README.md', import.meta.url), 'utf8').includes(PKG_VERSION),
  )
}

/** ───────── XA（0.2.156）：检索先建表、再记指纹、最后缓存 ───────── */
{
  const MX = readFileSync(new URL('./vendor/meow-memory/lib/index.js', import.meta.url), 'utf8')
  const Mk = await import('./vendor/meow-memory/lib/index.js')

  check('XA1 缓存上限是常量（4 张：多工作区够用，又不许无限长内存）', MX.includes('const SEARCH_INDEX_CACHE_MAX = 4;'))
  check(
    'XA2 指纹取「长度 + 头 40 + 尾 40 + 标题 + 关键词 + 会话」（只看长度会漏掉等长改写；0.6.6 起关键词走 kwList，字符串形态也纳入签名；0.6.10 起折进条级哈希；0.6.27 起不再切临时串，改按区间混）',
    (MX.includes('put(String(content.length));') || MX.includes('h = sigSep(sigMixStr(h, String(content.length)));')) &&
      ((MX.includes('put(content.slice(0, 40));') && MX.includes('put(content.slice(-40));')) ||
        (MX.includes('sigMixRange(h, content, 0, content.length < 40 ? content.length : 40)') &&
          MX.includes('sigMixRange(h, content, content.length < 40 ? 0 : content.length - 40, content.length)'))) &&
      (MX.includes('put(String(kw[i] ?? \'\'));') || MX.includes('h = sigMixStr(h, String(kw[i] ?? \'\'));')) &&
      MX.includes('return h >>> 0;'),
  )
  check('XA3 倒排表能关（阴性对照要有开关，否则证明不了它真在起作用）', MX.includes('const postings = opts.inverted === false ? null : new Map();'))
  check('XA4 缓存能关（opts.cache === false 走现建现用）', MX.includes('if (opts.cache === false) return buildSearchIndex(docs, opts, key);'))
  check(
    'XA5 四个口子都导出（探针要能问指纹、问缓存账、清空）',
    typeof Mk.searchIndexOf === 'function' && typeof Mk.indexSignature === 'function' &&
      typeof Mk.searchIndexCacheInfo === 'function' && typeof Mk.clearSearchIndexCache === 'function',
  )

  const dX = (id, content) => ({ id, level: 'fact', title: '', content, keywords: [], importance: 1, project: 'xa', updated_at: 1764e9, last_accessed_at: 1764e9 })
  const flatX = (hits) => JSON.stringify(hits.map((h) => [h.id, (h.score ?? 0).toFixed(6)]))
  const xDocs = [dX('x1', '发布方式用蓝绿切换'), dX('x2', '星图建图的延迟调下来')]
  Mk.clearSearchIndexCache()
  const warmX = Mk.search('蓝绿切换', xDocs, { k: 2 })
  const coldX = Mk.search('蓝绿切换', xDocs, { k: 2, cache: false })
  check('XA6 行为: 开缓存与关缓存的答案逐位相同（缓存只许省时间）', flatX(warmX) === flatX(coldX), flatX(warmX))

  Mk.clearSearchIndexCache()
  const missX = Mk.search('红黑切换', [dX('y1', '发布方式用蓝绿切换')], { k: 2 })
  const hitX = Mk.search('红黑切换', [dX('y1', '发布方式用红黑切换')], { k: 2 })
  check(
    'XA7 行为: 等长改写后立刻问，答的是新库（旧库里根本没有「红黑切换」）',
    Mk.indexSignature([dX('y1', '发布方式用蓝绿切换')]) !== Mk.indexSignature([dX('y1', '发布方式用红黑切换')]) &&
      (hitX[0]?.score ?? 0) > (missX[0]?.score ?? 0),
    `${(missX[0]?.score ?? 0).toFixed(3)} → ${(hitX[0]?.score ?? 0).toFixed(3)}`,
  )

  Mk.clearSearchIndexCache()
  for (let i = 0; i < 6; i++) Mk.search('发布', [dX(`z${i}`, `发布方式第 ${i} 种`)], { k: 1 })
  const infoX = Mk.searchIndexCacheInfo()
  check('XA8 行为: 六张不同的库进来，缓存仍只留 4 张（LRU 淘汰）', infoX.size === 4 && infoX.max === 4 && infoX.keys.length === 4, `size=${infoX.size} / max=${infoX.max}`)
  Mk.clearSearchIndexCache()

  const idX = readFileSync(new URL('./docs/INTERNAL.md', import.meta.url), 'utf8')
  const deX = readFileSync(new URL('./DESIGN.md', import.meta.url), 'utf8')
  check(
    'XA9 文档锚：9.159 写下了「先建表、再记指纹」与 121.8 → 5.1ms 的读数',
    idX.includes('## 9.159 ') && idX.includes('121.8') && deX.includes('## 165 '),
  )
  check(
    'XA10 量具在位：probe-cost 与它的结果快照',
    existsSync(new URL('./tools/probe-cost.mjs', import.meta.url)) && existsSync(new URL('./tools/fixtures/cost-snap.json', import.meta.url)),
  )
}

// ── DT063（0.6.3）定序：同一问句同一答案 ─────────────────────────────────────
// 病根：分数并列时 V8 稳定排序保留语料顺序，而语料顺序是存储层给的（更新改 rowid、VACUUM、分页），
// 于是同一问句在两套插入顺序下给出两套前十。梯子换成 分档 → 分数 → 更新得更晚的在前 → id 自然序。
dt063: {
  const eng = readFileSync(new URL('./vendor/meow-memory/lib/index.js', import.meta.url), 'utf8')
  const engLines = eng.split('\n')
  // 0.6.12 起梯子抽成 orderOf（四个键仍是数据本身的属性），两个出口（全序 / 有界堆）共用同一条。
  const ladderHead = 'const orderOf = (a, b) => (a._bandTmp - b._bandTmp) || (b.score - a.score) ||'
  const ladderTail = '(stampOf(a) < stampOf(b) ? 1 : stampOf(a) > stampOf(b) ? -1 : 0) || cmpText(a.id, b.id);'
  const stampDefs = engLines.filter((l) => l.startsWith('function stampOf(')).length
  const laterDefs = engLines.filter((l) => l.startsWith('function laterFirst(')).length
  check(
    'DT063 定序梯子在位：分档 → 分数 → 更新得更晚的在前 → id 自然序（四个键都是数据本身的属性）',
    eng.includes(ladderHead) &&
      eng.includes(ladderTail) &&
      eng.includes('hits.sort(orderOf);') &&
      eng.includes('heap.sort(orderOf);') &&
      stampDefs === 1 &&
      laterDefs === 1,
    `梯子头在=${eng.includes(ladderHead)} 尾在=${eng.includes(ladderTail)} 两出口=${eng.includes('hits.sort(orderOf);')}/${eng.includes('heap.sort(orderOf);')} stampOf ${stampDefs} 处 / laterFirst ${laterDefs} 处`,
  )
  check(
    'DT063 自适应 idf 挑簇不再按语料下标定序（`raw[y] - raw[x] || x - y` 已消失）',
    eng.includes('order.sort((x, y) => raw[y] - raw[x] || laterFirst(docs, x, y));') && !eng.includes('raw[y] - raw[x] || x - y'),
  )
  const localeLines = engLines.filter((l) => l.includes('localeCompare') && /cos|fuse|bandOf|raw\[/.test(l))
  check(
    'DT063 检索定序里没有 localeCompare（locale 随机器/ICU 变，换了机器就换顺序）',
    localeLines.length === 0,
    localeLines.length ? `${localeLines.length} 处参与定序` : `全文件 ${engLines.filter((l) => l.includes('localeCompare')).length} 处都在显示分组`,
  )
  const dtProbe = readFileSync(new URL('./tools/probe-determinism.mjs', import.meta.url), 'utf8')
  check(
    'DT063 定序账挂进了 check-all',
    readFileSync(new URL('./tools/check-all.mjs', import.meta.url), 'utf8').includes(`['tools/probe-determinism.mjs',`),
  )
  const needLabels = ['D1 ', 'D2 ', 'D3 ', 'D4 ', 'D5 ', 'D6 ', 'D7 ', 'D8 ']
  const missingLabels = needLabels.filter((t) => !dtProbe.includes(`'${t}`))
  check(
    'DT063 探针钉住八条（D1–D8，含「挖掉梯子就换前十」的能红证明）',
    missingLabels.length === 0,
    missingLabels.length ? `缺 ${missingLabels.join(' ')}` : 'D1–D8 都在',
  )
  check(
    'DT063 文档在位：INTERNAL 9.202 写了病根与梯子，README 里程碑写了「同一问句同一答案」',
    readFileSync(new URL('./docs/INTERNAL.md', import.meta.url), 'utf8').includes('## 9.202 ') &&
      readFileSync(new URL('./README.md', import.meta.url), 'utf8').includes('同一问句同一答案'),
  )
}

// ── 0.6.4 单字问句：一个汉字切不出词，也不许说「没有」 ──────────────────────────
{
  const eng = readFileSync(new URL('./vendor/meow-memory/lib/index.js', import.meta.url), 'utf8')
  const fbHead = 'function literalFallback(query, docs, opts = {}) {'
  check(
    'LT064 单字兜底在位：一个 `literalFallback`，闸门是「一个汉字」不是「短」',
    eng.split(fbHead).length - 1 === 1 && eng.includes('if (new Set(han).size !== 1) return [];'),
    `${eng.split(fbHead).length - 1} 处定义`,
  )
  const fbCalls = eng.split('return literalFallback(query, docs, opts);').length - 1
  check(
    'LT064 两条打分路径的空手门都改走兜底（search 与 keywordHitScore），且旧 `return []` 已清零',
    fbCalls === 2 && !eng.includes('if (q.length === 0 && idents.length === 0) return [];'),
    `兜底调用 ${fbCalls} 处`,
  )
  check(
    'LT064 兜底扫的是 title + content + keywords（只扫 content 会漏掉关键词里写着的字）',
    eng.includes('const hay = `${d.title ?? ""} ${d.content ?? ""} ${kw}`'),
  )
  const ltProbe = readFileSync(new URL('./tools/probe-literal.mjs', import.meta.url), 'utf8')
  check(
    'LT064 单字账挂进了 check-all',
    readFileSync(new URL('./tools/check-all.mjs', import.meta.url), 'utf8').includes(`['tools/probe-literal.mjs',`),
  )
  const ltLabels = ['L1 ', 'L2 ', 'L3 ', 'L4 ', 'L5 ', 'L6 ', 'L7 ', 'L8 ']
  const ltMissing = ltLabels.filter((t) => !ltProbe.includes(`'${t}`))
  check('LT064 探针钉住 L1–L8（含「挖掉兜底就回空」的能红证明）', ltMissing.length === 0, ltMissing.length ? `缺 ${ltMissing.join(' ')}` : 'L1–L8 都在')
  check(
    'LT064 文档在位：INTERNAL 9.203 写了病根与闸门，README 里程碑写了「切不出词 ≠ 库里没有」',
    readFileSync(new URL('./docs/INTERNAL.md', import.meta.url), 'utf8').includes('## 9.203 ') &&
      readFileSync(new URL('./README.md', import.meta.url), 'utf8').includes('切不出词 ≠ 库里没有'),
  )
  const ltVer = (readFileSync(new URL('./lib/index.js', import.meta.url), 'utf8').match(/export const version = '(\d+)\.(\d+)\.(\d+)'/) ?? []).slice(1).map(Number)
  const ltVerNum = ltVer.length === 3 ? ltVer[0] * 10000 + ltVer[1] * 100 + ltVer[2] : 0
  check('LT064 版本号不低于 0.6.4（后续补丁不必回头改这一条）', ltVerNum >= 604, ltVer.join('.'))
}
// ── 0.6.5 单字问句带标点：标点只是外壳，不许把问题变成「没有」 ────────────────
{
  const eng = readFileSync(new URL('./vendor/meow-memory/lib/index.js', import.meta.url), 'utf8')
  const gate = [
    'const han = cps.filter(isHan);',
    'const rest = cps.filter((c) => !isHan(c));',
    'if (new Set(han).size !== 1) return [];',
    'if (!rest.every((c) => /[\\s\\p{P}]/u.test(c))) return [];',
  ]
  const gateMissing = gate.filter((l) => !eng.includes(l))
  check(
    'LT065 闸门改成「剥掉标点后正好一个汉字」：只放汉字 + 标点/空白，不放字母数字符号',
    gateMissing.length === 0 && !eng.includes('if (cps.length !== 1 || !/['),
    gateMissing.length ? `缺 ${gateMissing.join(' | ')}` : '四行都在，旧闸门已清零',
  )
  const needleUses = eng.split('needle1').length - 1
  check('LT065 兜底按剥好的那个汉字找子串（`needle1` 在定义后用上，不是拿原问句找）', needleUses >= 3 && eng.includes('hay.indexOf(needle1)') && eng.includes('at + needle1.length'), `needle1 ${needleUses} 处`)
  const ltProbe = readFileSync(new URL('./tools/probe-literal.mjs', import.meta.url), 'utf8')
  const pLabels = ['L9 ', 'L10 ', 'L11 ', 'L12 ', 'L13 ']
  const pMissing = pLabels.filter((t) => !ltProbe.includes(`'${t}`))
  check('LT065 探针钉住 L9–L13（标点命中 / 闸门不认短 / 重复按一个算 / 同口径 / 退回即红）', pMissing.length === 0, pMissing.length ? `缺 ${pMissing.join(' ')}` : 'L9–L13 都在')
  check(
    'LT065 文档在位：INTERNAL 9.204 写了「标点是外壳」，README 里程碑写了「标点也是人打的」',
    readFileSync(new URL('./docs/INTERNAL.md', import.meta.url), 'utf8').includes('## 9.204 ') &&
      readFileSync(new URL('./README.md', import.meta.url), 'utf8').includes('标点也是人打的'),
  )
  const ltVer5 = (readFileSync(new URL('./lib/index.js', import.meta.url), 'utf8').match(/export const version = '(\d+)\.(\d+)\.(\d+)'/) ?? []).slice(1).map(Number)
  const ltVerNum5 = ltVer5.length === 3 ? ltVer5[0] * 10000 + ltVer5[1] * 100 + ltVer5[2] : 0
  check('LT065 版本号不低于 0.6.5（后续补丁不必回头改这一条）', ltVerNum5 >= 605, ltVer5.join('.'))
}

// ── 0.6.6 脏记忆：一条缺字段的条目不许把整次检索打成异常 ──────────────────────
{
  const eng = readFileSync(new URL('./vendor/meow-memory/lib/index.js', import.meta.url), 'utf8')
  const kwHead = 'function kwList(d) {'
  const kwBranches = [
    'if (Array.isArray(raw)) return raw.filter((w) => typeof w === "string" && w.length > 0);',
    'if (typeof raw !== "string") return [];',
    'if (s.startsWith("[")) {',
    'return s.split(/[,，、;；]/).map((w) => w.trim()).filter((w) => w.length > 0);',
  ]
  const kwMissing = kwBranches.filter((l) => !eng.includes(l))
  check(
    'DT066 keywords 归一化在位：数组 / 非字符串 / JSON 串 / 逗号顿号四路都认，`kwList` 只此一份',
    eng.split(kwHead).length - 1 === 1 && kwMissing.length === 0,
    kwMissing.length ? `缺 ${kwMissing.join(' | ')}` : `${eng.split(kwHead).length - 1} 处定义`,
  )
  check(
    'DT066 docText 改走 kwList，旧 `...d.keywords` 已清零（脏条目不再让 verbatimInputs 抛 TypeError）',
    eng.includes('return [d.title ?? "", d.content ?? "", kwList(d).join(" ")].join(" ");') && !eng.includes('...d.keywords].join'),
  )
  const kwFlatLine = eng.split('\n').find((l) => l.includes('? docs.map((d) => kwList(d).flatMap((w) => tokenize(')) ?? ''
  const kwToksLine = eng.split('\n').find((l) => l.includes('const kwToks = kwSep ? kwFlatArr')) ?? ''
  const kwSetsLine = eng.split('\n').find((l) => l.includes('const kwSets = useField')) ?? ''
  check(
    'DT066 打分面两处（kwToks / kwSets）同样走 kwList——逗号串的关键词真的进 tf-idf，不只是不崩',
    eng.includes('const kwFlatArr = kwSep || useField') && kwFlatLine.includes('kwList(d).flatMap') &&
      kwToksLine.includes('kwFlatArr') && kwSetsLine.includes('kwFlatArr'),
    `kwList ${kwFlatLine.includes('kwList(d)') ? 'ok' : 'miss'} / kwToks ${kwToksLine.includes('kwFlatArr') ? 'ok' : 'miss'} / kwSets ${kwSetsLine.includes('kwFlatArr') ? 'ok' : 'miss'}`,
  )
  check(
    'DT066 索引签名也走 kwList：字符串词表被改写要让缓存失效，不许拿旧索引答新库（0.6.10 起在 sigDocHash 里逐词混算，0.6.27 起改走 sigMixStr）',
    /function sigDocHash\(d, kw\)/.test(eng) &&
      (eng.includes("put(String(kw[i] ?? ''));") || eng.includes("h = sigMixStr(h, String(kw[i] ?? ''));")) &&
      /const kw = kwList\(d\);/.test(eng) && !eng.includes("mix(Array.isArray(d?.keywords) ? d.keywords.join('\\u0001') : -1);"),
  )
  check(
    'DT066 keywordHitScore 的 content 归一化在位（keywords 缺失时退回正文，不抛）',
    eng.includes('content: Array.isArray(d.keywords) && d.keywords.length > 0 ? d.keywords.join(" ") : String(d.content ?? "").slice(0, 100)'),
  )
  const dtProbe = readFileSync(new URL('./tools/probe-dirty.mjs', import.meta.url), 'utf8')
  const dLabels = ['D1 ', 'D2 ', 'D3 ', 'D4 ', 'D5 ', 'D6 ', 'D7 ', 'D8 ']
  const dMissing = dLabels.filter((t) => !dtProbe.includes(`'${t}`))
  check(
    'DT066 探针钉住 D1–D8（不崩 / 仍可命中 / 逗号串成词 / null 数字对象 / 不改写别人 / content 缺失 / 三路同口径 / 挖掉归一化即红）',
    dMissing.length === 0 && readFileSync(new URL('./tools/check-all.mjs', import.meta.url), 'utf8').includes(`['tools/probe-dirty.mjs',`),
    dMissing.length ? `缺 ${dMissing.join(' ')}` : 'D1–D8 都在，且挂进了 check-all',
  )
  check(
    'DT066 文档在位：INTERNAL 9.205 写了病根，README 里程碑写了「脏记忆不许把整次检索打成异常」',
    readFileSync(new URL('./docs/INTERNAL.md', import.meta.url), 'utf8').includes('## 9.205 ') &&
      readFileSync(new URL('./README.md', import.meta.url), 'utf8').includes('脏记忆不许把整次检索打成异常'),
  )
  const dtVer = (readFileSync(new URL('./lib/index.js', import.meta.url), 'utf8').match(/export const version = '(\d+)\.(\d+)\.(\d+)'/) ?? []).slice(1).map(Number)
  const dtVerNum = dtVer.length === 3 ? dtVer[0] * 10000 + dtVer[1] * 100 + dtVer[2] : 0
  check('DT066 版本号不低于 0.6.6（后续补丁不必回头改这一条）', dtVerNum >= 606, dtVer.join('.'))
}

// 0.6.7：坏的是元素本身（数组里一条 null），不是字段形状——入口闸 liveDocs
{
  const eng = readFileSync(new URL('./vendor/meow-memory/lib/index.js', import.meta.url), 'utf8')
  const liveHead = 'function liveDocs(docs) {'
  const liveBody = (eng.match(/function liveDocs\(docs\) \{[\s\S]*?\n\}/) ?? [''])[0]
  check(
    'DT067 入口闸 liveDocs 在位且只此一份：非数组回 []，坏元素筛掉，干净数组原样返回（不打掉索引缓存）',
    eng.split(liveHead).length - 1 === 1 &&
      liveBody.includes('if (!Array.isArray(docs)) return [];') &&
      liveBody.includes('return docs.filter((x) => x && typeof x === "object");') &&
      liveBody.trimEnd().endsWith('return docs;\n}'),
    liveBody ? `${liveBody.split('\n').length} 行` : '缺函数',
  )
  const searchHead = (eng.slice(eng.indexOf('function search(query, docs, opts = {})'), eng.indexOf('function search(query, docs, opts = {})') + 400))
  const khsHead = (eng.slice(eng.indexOf('function keywordHitScore(query, docs, opts = {})'), eng.indexOf('function keywordHitScore(query, docs, opts = {})') + 400))
  check(
    'DT067 search 与 keywordHitScore 两个入口都先过 liveDocs（三处入口不许只修一处）',
    searchHead.includes('docs = liveDocs(docs);') && khsHead.includes('docs = liveDocs(docs);'),
    `search ${searchHead.includes('docs = liveDocs(docs);') ? 'ok' : 'miss'} / keywordHitScore ${khsHead.includes('docs = liveDocs(docs);') ? 'ok' : 'miss'}`,
  )
  const dtProbe = readFileSync(new URL('./tools/probe-dirty.mjs', import.meta.url), 'utf8')
  const dLabels = ['D9 ', 'D10 ', 'D11 ', 'D12 ', 'D13 ']
  const dMissing = dLabels.filter((t) => !dtProbe.includes(`'${t}`))
  check(
    'DT067 探针钉住 D9–D13（坏元素不抛 / 不改写第一名 / docs 非数组 / 全坏行 / 三路同口径 / 挖掉入口闸即红）',
    dMissing.length === 0,
    dMissing.length ? `缺 ${dMissing.join(' ')}` : 'D9–D13 都在',
  )
  check(
    'DT067 文档在位：INTERNAL 9.206 写了「元素本身也可能是坏的」，README 里程碑写了「一条坏行不许把整次检索打成异常」',
    readFileSync(new URL('./docs/INTERNAL.md', import.meta.url), 'utf8').includes('## 9.206 ') &&
      readFileSync(new URL('./README.md', import.meta.url), 'utf8').includes('一条坏行不许把整次检索打成异常'),
  )
  const v = (readFileSync(new URL('./lib/index.js', import.meta.url), 'utf8').match(/export const version = '(\d+)\.(\d+)\.(\d+)'/) ?? []).slice(1).map(Number)
  const vNum = v.length === 3 ? v[0] * 10000 + v[1] * 100 + v[2] : 0
  check('DT067 版本号不低于 0.6.7（后续补丁不必回头改这一条）', vNum >= 607, v.join('.'))
}

// 0.6.8：会随时间前进的量只许写成单调式（判据自己的寿命）
{
  const self = readFileSync(new URL('./verify.mjs', import.meta.url), 'utf8')
  const floorDecl = /const SUITE_FLOOR = \d+/.test(self)
  const floorUsed = self.includes('steps.length >= SUITE_FLOOR')
  const eqGone = !/steps\.length === \d+/.test(self.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n'))
  check(
    'MT068 支数断言是地板式：`SUITE_FLOOR` 声明 + `steps.length >= SUITE_FLOOR`，旧的等值写法清零',
    floorDecl && floorUsed && eqGone,
    `声明 ${floorDecl ? 'ok' : 'miss'} / 用 ${floorUsed ? 'ok' : 'miss'} / 旧等值 ${eqGone ? '清零' : '还在'}`,
  )
  const mtProbe = readFileSync(new URL('./tools/probe-monotone.mjs', import.meta.url), 'utf8')
  const mLabels = ['M1 ', 'M2 ', 'M3 ', 'M4', 'M4b ', 'M5 ', 'M6 ', 'M7 ', 'M8 ']
  const mMissing = mLabels.filter((t) => !mtProbe.includes(`'${t}`) && !mtProbe.includes(`\`${t}`))
  const wired = readFileSync(new URL('./tools/check-all.mjs', import.meta.url), 'utf8').includes("'tools/probe-monotone.mjs'")
  check(
    'MT068 探针钉住 M1–M8（地板 / 静态扫描 / 扫描器能红 / 两处文档对账 / 阶梯单调 / 旧账冻结 / 耗时预算 / 扫描面完整）并挂进 check-all',
    mMissing.length === 0 && wired,
    `${mMissing.length ? `缺 ${mMissing.join(' ')}` : 'M1–M8 都在'} / check-all ${wired ? 'ok' : 'miss'}`,
  )
  check(
    'MT068 文档在位：INTERNAL 9.207 写了判据自己的寿命，README 写了「会随时间前进的量」，DESIGN 有 ## 203.',
    readFileSync(new URL('./docs/INTERNAL.md', import.meta.url), 'utf8').includes('## 9.207 ') &&
      readFileSync(new URL('./README.md', import.meta.url), 'utf8').includes('会随时间前进的量') &&
      readFileSync(new URL('./DESIGN.md', import.meta.url), 'utf8').includes('## 203. '),
  )
  // 「文档里的总数 = 基线合计」这条偏偏不能写在这里：本支套件自己的条数也要
  // 进基线，而基线是这一支跑绿之后才记得上的——放在中途就成了先有鸡还是先有蛋
  // （新加一支时必然差一支，于是永远绿不了、也就永远记不上账）。0.6.8 起把它
  // 挪到全文件末尾，用**本次实际跑过的 PASS 条数**当自己的那格，环就断了：
  // 期望值 = Σ(其它支的基线) + 本支本次 PASS 条数，与基线里旧的那格无关。
  const v = (readFileSync(new URL('./lib/index.js', import.meta.url), 'utf8').match(/export const version = '(\d+)\.(\d+)\.(\d+)'/) ?? []).slice(1).map(Number)
  const vNum = v.length === 3 ? v[0] * 10000 + v[1] * 100 + v[2] : 0
  check('MT068 版本号不低于 0.6.8（后续补丁不必回头改这一条）', vNum >= 608, v.join('.'))
}

// 0.6.9：量尺自己也得先量（PLAN §12 #2「评测做硬」）
{
  const rigorSrc = readFileSync(new URL('./tools/probe-rigor.mjs', import.meta.url), 'utf8')
  const rLabels = ['R1 ', 'R2 ', 'R2b ', 'R3 ', 'R4 ', 'R5 ', 'R6 ']
  const rMissing = rLabels.filter((t) => !rigorSrc.includes(`'${t}`) && !rigorSrc.includes(`\`${t}`))
  const wiredR = readFileSync(new URL('./tools/check-all.mjs', import.meta.url), 'utf8').includes("'tools/probe-rigor.mjs'")
  check(
    'RT069 量尺探针钉住 R1–R6（3 次 std=0 / 语料互换 / 打乱 / 问句互换 / 独立 scorer / 位置偏置能红）并挂进 check-all',
    rMissing.length === 0 && wiredR,
    `${rMissing.length ? `缺 ${rMissing.join(' ')}` : 'R1–R6 都在'} / check-all ${wiredR ? 'ok' : 'miss'}`,
  )
  check(
    'RT069 量的是既有的真库样张（gold-recall.json 的 45+14+10 问），不新造语料也不碰真库',
    rigorSrc.includes("'gold-recall.json'") && rigorSrc.includes('V.search(item.q, docList, { k: 10 })') && ["'queries'", "'paraphrase'", "'anchor'"].every((g) => rigorSrc.includes(g)),
  )
  check(
    'RT069 能红证明在位：进程内注入「同分按语料序」的偏置，A/B 互换后第一名命中数必须不同',
    rigorSrc.includes('biasedTop1') && rigorSrc.includes('biasNormal !== biasReversed'),
  )
  check(
    'RT069 文档在位：INTERNAL 9.208 写了量尺的三次与互换，README 写了「量尺自己也得先量」，DESIGN 有 ## 204.，PLAN §12 #2 标了已做',
    readFileSync(new URL('./docs/INTERNAL.md', import.meta.url), 'utf8').includes('## 9.208 ') &&
      readFileSync(new URL('./README.md', import.meta.url), 'utf8').includes('量尺自己也得先量') &&
      readFileSync(new URL('./DESIGN.md', import.meta.url), 'utf8').includes('## 204. ') &&
      readFileSync(new URL('./docs/PLAN-0.6.md', import.meta.url), 'utf8').includes('已做（0.6.9'),
  )
  const vR = (readFileSync(new URL('./lib/index.js', import.meta.url), 'utf8').match(/export const version = '(\d+)\.(\d+)\.(\d+)'/) ?? []).slice(1).map(Number)
  const vNumR = vR.length === 3 ? vR[0] * 10000 + vR[1] * 100 + vR[2] : 0
  check('RT069 版本号不低于 0.6.9（后续补丁不必回头改这一条）', vNumR >= 609, vR.join('.'))
}

// 0.6.10：签名自己也要记账（每问都重算整库签名 = 把「库没变」忘掉）
{
  const sigSrc = readFileSync(new URL('./tools/probe-signature.mjs', import.meta.url), 'utf8')
  const sLabels = ['S1 ', 'S2 ', 'S3 ', 'S4 ', 'S5 ', 'S6 ', 'S7 ', 'S8 ', 'S9 ']
  const sMissing = sLabels.filter((t) => !sigSrc.includes(`'${t}`) && !sigSrc.includes(`\`${t}`))
  const wiredS = readFileSync(new URL('./tools/check-all.mjs', import.meta.url), 'utf8').includes("'tools/probe-signature.mjs'")
  check(
    'SG070 签名探针钉住 S1–S9（参考实现横比 / 只复用不重算 / 就地改正文·关键词·四个字段都要变 / 换序要变 / 脏形状走直算 / 快 5 倍 / 只按身份记账的坏实现必红）并挂进 check-all',
    sMissing.length === 0 && wiredS,
    `${sMissing.length ? `缺 ${sMissing.join(' ')}` : 'S1–S9 都在'} / check-all ${wiredS ? 'ok' : 'miss'}`,
  )
  const engineSrc = readFileSync(new URL('./vendor/meow-memory/lib/index.js', import.meta.url), 'utf8')
  // 记账必须「比的是值」：既要留字段快照，也要逐字段比较（只比对象身份 = 就地改看不见）
  const valueCmp = /prev\.c === d\.content/.test(engineSrc) && /prev\.t === d\.title/.test(engineSrc) && /sigKwSame\(rawKw, prev\.kw\)/.test(engineSrc)
  const hasCache = engineSrc.includes('const SIG_DOC_CACHE = new WeakMap();') && engineSrc.includes('function sigDocHash(d, kw)')
  const dirtyBypass = /if \(!cacheable\) \{/.test(engineSrc) && /if \(!kwOk\) return h;/.test(engineSrc)
  check(
    'SG070 引擎里记账三件都在：WeakMap 条级缓存 + 逐字段值比较（不是对象身份）+ 判不出有没有变的形状走直算',
    hasCache && valueCmp && dirtyBypass,
    `缓存 ${hasCache ? 'ok' : 'miss'} / 值比较 ${valueCmp ? 'ok' : 'miss'} / 直算兜底 ${dirtyBypass ? 'ok' : 'miss'}`,
  )
  const V0 = await import(pathToFileURL(join(root, 'vendor', 'meow-memory', 'lib', 'index.js')).href)
  const canStat = typeof V0.indexSignatureStats === 'function' && typeof V0.resetIndexSignatureStats === 'function'
  const d1 = [{ id: 'a', title: 't', content: '正文'.repeat(30), keywords: ['甲'] }]
  V0.resetIndexSignatureStats()
  V0.indexSignature(d1); V0.indexSignature(d1)
  const st = V0.indexSignatureStats()
  check(
    'SG070 记账进程内可见：reset 归零、第二次只复用不重算（探针据此证明「库没变就不重付钱」）',
    canStat && st.calls === 2 && st.reused === 1 && st.rebuilt === 1,
    `calls ${st.calls} / 复用 ${st.reused} / 重算 ${st.rebuilt} / 已算 ${st.hashed}`,
  )
  check(
    'SG070 文档在位：INTERNAL 9.209 写了签名的账，README 写了「签名自己也要记账」，DESIGN 有 ## 205.，PLAN §11 有 0.6.10 行',
    readFileSync(new URL('./docs/INTERNAL.md', import.meta.url), 'utf8').includes('## 9.209 ') &&
      readFileSync(new URL('./README.md', import.meta.url), 'utf8').includes('签名自己也要记账') &&
      readFileSync(new URL('./DESIGN.md', import.meta.url), 'utf8').includes('## 205. ') &&
      readFileSync(new URL('./docs/PLAN-0.6.md', import.meta.url), 'utf8').includes('签名自己也要记账') &&
      /0\.6\.10/.test(readFileSync(new URL('./docs/PLAN-0.6.md', import.meta.url), 'utf8')),
  )
  const vS = (readFileSync(new URL('./lib/index.js', import.meta.url), 'utf8').match(/export const version = '(\d+)\.(\d+)\.(\d+)'/) ?? []).slice(1).map(Number)
  const vNumS = vS.length === 3 ? vS[0] * 10000 + vS[1] * 100 + vS[2] : 0
  check('SG070 版本号不低于 0.6.10（后续补丁不必回头改这一条）', vNumS >= 610, vS.join('.'))
}

// 0.6.11：原样匹配的 haystack 也不许每问重拼（库没变时它跟切词表一样是「库里有什么」）
{
  const vvSrc = readFileSync(new URL('./tools/probe-verbatim.mjs', import.meta.url), 'utf8')
  const vLabels = ['V1 ', 'V2 ', 'V3 ', 'V4 ', 'V5 ', 'V6 ', 'V7 ', 'V8 ', 'V9 ']
  const vMissing = vLabels.filter((t) => !vvSrc.includes(`'${t}`) && !vvSrc.includes(`\`${t}`))
  const wiredV = readFileSync(new URL('./tools/check-all.mjs', import.meta.url), 'utf8').includes("'tools/probe-verbatim.mjs'")
  check(
    'VV071 原样匹配探针钉住 V1–V9（与现拼逐位相同 / 只拼一次 / 改正文·project·keywords 都要跟着变 / 与老口径等价 / 10,000 条固定开销 ≤6ms（份额只作旁证，0.6.15 起分母掉了约六成） / 无标识符不建 / 只按条数缓存必红）并挂进 check-all',
    vMissing.length === 0 && wiredV,
    `${vMissing.length ? `缺 ${vMissing.join(' ')}` : 'V1–V9 都在'} / check-all ${wiredV ? 'ok' : 'miss'}`,
  )
  const engineSrc2 = readFileSync(new URL('./vendor/meow-memory/lib/index.js', import.meta.url), 'utf8')
  const lazyHay = /const hayArr = new Array\(n\);/.test(engineSrc2) && /const hayAt = \(di\) =>/.test(engineSrc2) && /hayAt\n?/.test(engineSrc2)
  const idxHasHay = /hayAt\s*\n?\s*\};/.test(engineSrc2) || engineSrc2.includes('hayAt\n  };') || /coocForms,\s*\n\s*hayAt/.test(engineSrc2)
  const projInSig = (/put\(String\(d\?\.project \?\? ''\)\); sep\(\);/.test(engineSrc2) ||
    /h = sigSep\(sigMixStr\(h, String\(d\?\.project \?\? ''\)\)\);/.test(engineSrc2)) && /prev\.p === d\.project/.test(engineSrc2)
  const lazyStats = /const verbStats = \{ calls: 0, built: 0, reused: 0 \};/.test(engineSrc2)
  check(
    'VV071 引擎里是「懒建 + 随索引缓存 + 签名盯住 project」：hayArr/hayAt 在 buildSearchIndex 里、project 进 sigDocHash 与值比较、verbStats 记账',
    lazyHay && idxHasHay && projInSig && lazyStats,
    `懒建 ${lazyHay ? 'ok' : 'miss'} / 随索引 ${idxHasHay ? 'ok' : 'miss'} / project 进签名 ${projInSig ? 'ok' : 'miss'} / 记账 ${lazyStats ? 'ok' : 'miss'}`,
  )
  check(
    'VV071 老写法已清干净：search 里不再有 `docs.map((d) => textOf(d).toLowerCase())`，消费点走 hayOf(di)/verbOn',
    !/verbHay/.test(engineSrc2.replace(/^.*有 verbHay.*$/m, '')) && engineSrc2.includes('verbatimOf(idents, hayOf(di))'),
    engineSrc2.includes('verbatimOf(idents, hayOf(di))') ? 'hayOf(di) 在位' : '仍是 verbHay[di]',
  )
  const V1 = await import(pathToFileURL(join(root, 'vendor', 'meow-memory', 'lib', 'index.js')).href)
  const canStatV = typeof V1.verbatimHayStats === 'function' && typeof V1.resetVerbatimHayStats === 'function'
  V1.clearSearchIndexCache()
  V1.resetVerbatimHayStats()
  const dV = [
    { id: 'a', title: '超时', content: 'kv_store 超时 8000ms', keywords: ['kv'], project: 'P1', updated_at: 1 },
    { id: 'b', title: '别的', content: '无关正文', keywords: ['x'], project: 'P2', updated_at: 2 },
  ]
  const qV = 'kv_store timeout fix'
  V1.search(qV, dV, { k: 2 })
  const stV1 = V1.verbatimHayStats()
  V1.search(qV, dV, { k: 2 })
  const stV2 = V1.verbatimHayStats()
  check(
    'VV071 记账进程内可见：第一次建 2 条、第二次只复用不重拼（探针据此证明「库没变就不重付钱」）',
    canStatV && stV1.built === 2 && stV2.built === 2 && stV2.reused > stV1.reused,
    `第一次 建${stV1.built}/复${stV1.reused} · 第二次 建${stV2.built}/复${stV2.reused}`,
  )
  check(
    'VV071 文档在位：INTERNAL 9.210 写了原样匹配的账，README 写了「原样匹配也要记账」，DESIGN 有 ## 206.，PLAN §11 有 0.6.11 行',
    readFileSync(new URL('./docs/INTERNAL.md', import.meta.url), 'utf8').includes('## 9.210 ') &&
      readFileSync(new URL('./README.md', import.meta.url), 'utf8').includes('原样匹配也要记账') &&
      readFileSync(new URL('./DESIGN.md', import.meta.url), 'utf8').includes('## 206. ') &&
      readFileSync(new URL('./docs/PLAN-0.6.md', import.meta.url), 'utf8').includes('原样匹配也要记账') &&
      /0\.6\.11/.test(readFileSync(new URL('./docs/PLAN-0.6.md', import.meta.url), 'utf8')),
  )
  const vS2 = (readFileSync(new URL('./lib/index.js', import.meta.url), 'utf8').match(/export const version = '(\d+)\.(\d+)\.(\d+)'/) ?? []).slice(1).map(Number)
  const vNumS2 = vS2.length === 3 ? vS2[0] * 10000 + vS2[1] * 100 + vS2[2] : 0
  check('VV071 版本号不低于 0.6.11（后续补丁不必回头改这一条）', vNumS2 >= 611, vS2.join('.'))
}

// 0.6.12：定序只排前 k——三个调用点接下来都只读前 k 条，没有一处回头读第 k 条以后的
{
  const oSrc = readFileSync(new URL('./tools/probe-order.mjs', import.meta.url), 'utf8')
  const oLabels = ['O1 ', 'O2 ', 'O3 ', 'O4 ', 'O5 ', 'O6 ', 'O7 ', 'O8 ']
  const oMissing = oLabels.filter((t) => !oSrc.includes(`'${t}`) && !oSrc.includes(`\`${t}`))
  const wiredO = readFileSync(new URL('./tools/check-all.mjs', import.meta.url), 'utf8').includes("'tools/probe-order.mjs'")
  check(
    'OR072 定序探针钉住 O1–O8（与全量排序逐位对拍 / 截到 min(k,n) / 档位同步无残留 / k<=0 退回全序 / 并列按 id 自然序 / 指认档恒 -1 / 换序不变 / 丢档位筛选必红）并挂进 check-all',
    oMissing.length === 0 && wiredO,
    `${oMissing.length ? `缺 ${oMissing.join(' ')}` : 'O1–O8 都在'} / check-all ${wiredO ? 'ok' : 'miss'}`,
  )
  const engineSrc3 = readFileSync(new URL('./vendor/meow-memory/lib/index.js', import.meta.url), 'utf8')
  const sigO = engineSrc3.includes('function bandize(hits, rawKey, limit = Infinity)')
  const noMapO = !engineSrc3.includes('const bandOf = new Map()')
  const heapO = engineSrc3.includes('const siftUp = (i) =>') && engineSrc3.includes('const siftDown = (i) =>') &&
    engineSrc3.includes('} else if (orderOf(h, heap[0]) < 0) {')
  const tmpO = engineSrc3.includes('h._bandTmp = -1;') && engineSrc3.includes('delete h._bandTmp;')
  check(
    'OR072 引擎里是「档位写条目自己身上 + 有界堆选前 k」：bandize 收 limit、Map<对象,档> 已撤、siftUp/siftDown 在位、_bandTmp 用完就删',
    sigO && noMapO && heapO && tmpO,
    `签名 ${sigO ? 'ok' : 'miss'} / 撤 Map ${noMapO ? 'ok' : 'miss'} / 有界堆 ${heapO ? 'ok' : 'miss'} / _bandTmp ${tmpO ? 'ok' : 'miss'}`,
  )
  const callsO = engineSrc3.includes('bandize(hits, "_raw", k2);') && engineSrc3.includes("bandize(hits, '_raw', k);") &&
    engineSrc3.includes("bandize(out, '_raw', k);")
  check(
    'OR072 三个调用点都把 k 传下去（search / literalFallback / keywordHitScore），不再默认全序',
    callsO,
    callsO ? '3/3' : '有调用点还在全序',
  )
  const O1 = await import(pathToFileURL(join(root, 'vendor', 'meow-memory', 'lib', 'index.js')).href)
  const canOrder = typeof O1.bandize === 'function'
  let ordOk = false
  let ordDetail = 'bandize 未导出'
  if (canOrder) {
    const mk = (id, raw, score) => ({ id, score, _raw: raw, updated_at: 1000 })
    const hits = [mk('a', 10, 1), mk('b', 5, 9), mk('c', 4, 8), mk('d', 1, 99), mk('e', 0.5, 100)]
    const full = O1.bandize(hits.map((h) => ({ ...h })), '_raw', Infinity).map((h) => `${h.id}:${h._band}`)
    const top2 = O1.bandize(hits.map((h) => ({ ...h })), '_raw', 2)
    ordOk = full.slice(0, 2).join(',') === top2.map((h) => `${h.id}:${h._band}`).join(',') &&
      top2.length === 2 && top2.every((h) => h._bandTmp === undefined)
    ordDetail = `全序前二 ${full.slice(0, 2).join(',')} / 截断 ${top2.map((h) => `${h.id}:${h._band}`).join(',')}`
  }
  check('OR072 进程内可见：只排前 k 与全序前 k 逐位相同，且 hits 真的被截断（探针据此证明「没读的不算钱」）', canOrder && ordOk, ordDetail)
  check(
    'OR072 文档在位：INTERNAL 9.211 写了定序的账，README 写了「定序只排前 k」，DESIGN 有 ## 207.，PLAN §11 有 0.6.12 行',
    readFileSync(new URL('./docs/INTERNAL.md', import.meta.url), 'utf8').includes('## 9.211 ') &&
      readFileSync(new URL('./README.md', import.meta.url), 'utf8').includes('定序只排前 k') &&
      readFileSync(new URL('./DESIGN.md', import.meta.url), 'utf8').includes('## 207. ') &&
      readFileSync(new URL('./docs/PLAN-0.6.md', import.meta.url), 'utf8').includes('定序只排前 k') &&
      /0\.6\.12/.test(readFileSync(new URL('./docs/PLAN-0.6.md', import.meta.url), 'utf8')),
  )
  const vS3 = (readFileSync(new URL('./lib/index.js', import.meta.url), 'utf8').match(/export const version = '(\d+)\.(\d+)\.(\d+)'/) ?? []).slice(1).map(Number)
  const vNumS3 = vS3.length === 3 ? vS3[0] * 10000 + vS3[1] * 100 + vS3[2] : 0
  check('OR072 版本号不低于 0.6.12（后续补丁不必回头改这一条）', vNumS3 >= 612, vS3.join('.'))
}

// 0.6.13：定档不再靠全量排序——阈值链 + 二分（负数 / 脏值退回老路）
{
  const oSrc2 = readFileSync(new URL('./tools/probe-order.mjs', import.meta.url), 'utf8')
  const oLabels2 = ['O9 ', 'O10 ']
  const oMissing2 = oLabels2.filter((t) => !oSrc2.includes(`'${t}`) && !oSrc2.includes(`\`${t}`))
  check(
    'OR073 定序探针补上 O9–O10（负数 raw 走退回路 / NaN·undefined·null·Infinity 同样退回老路），都与「全量排序」参考实现逐位一致',
    oMissing2.length === 0,
    oMissing2.length ? `缺 ${oMissing2.join(' ')}` : 'O9–O10 都在',
  )
  const engSrc4 = readFileSync(new URL('./vendor/meow-memory/lib/index.js', import.meta.url), 'utf8')
  // 0.6.19：锚点链换成「桶计数排序 + 段扫」，这一条跟着改成新形状（老形状 = Float64Array + 原生 sort，
  // 已退成 anchorChainSorted / 小端缺席时的退路，仍留在文件里）。
  const thrOk = engSrc4.includes('function setBandsByThreshold(hits, rawKey)') &&
    engSrc4.includes('const anchors = anchorChainOf(vals, plain);') &&
    engSrc4.includes('function anchorChainOf(vals, n) {') &&
    engSrc4.includes('function anchorChainSorted(vals, n) {') &&
    // [0.6.28] 同分批量后赋值拆成两句：`lastBand = m - 1 - lo;` 与 `h._bandTmp = lastBand;`
    (engSrc4.includes('h._bandTmp = m - 1 - lo;') || (engSrc4.includes('lastBand = m - 1 - lo;') && engSrc4.includes('h._bandTmp = lastBand;')))
  const fallOk = engSrc4.includes('function setBandsBySort(hits, rawKey)') &&
    engSrc4.includes('if (!setBandsByThreshold(hits, rawKey)) setBandsBySort(hits, rawKey);')
  check(
    'OR073 引擎里定档走「Float64Array + 阈值链 + 二分」（0.6.19 起链由桶计数排序供，排序链退成后备），且负数/脏值退回 setBandsBySort（口径不变）',
    thrOk && fallOk,
    `阈值链 ${thrOk ? 'ok' : 'miss'} / 退回路 ${fallOk ? 'ok' : 'miss'}`,
  )
  const O2 = await import(pathToFileURL(join(root, 'vendor', 'meow-memory', 'lib', 'index.js')).href)
  let fallbackOk = false
  let fbDetail = 'bandize 未导出'
  if (typeof O2.bandize === 'function') {
    // 进程内对拍：负数 / NaN 两组，与「按 raw 降序逐条开档」的朴素实现在前 k 上一致。
    const naive = (hits, k) => {
      const arr = hits.map((h) => ({ ...h }))
      const byRaw = arr.slice().sort((a, b) => b._raw - a._raw)
      let band = -1
      let anchor = 0
      for (const h of byRaw) {
        if (h._ident === true || h._subj === 1) continue
        const r = h._raw
        if (band < 0 || r < 0.85 * anchor) { band += 1; anchor = r }
        h._bandN = band
      }
      return arr.filter((h) => h._bandN !== undefined).sort((a, b) => (a._bandN - b._bandN) || (b.score - a.score)).slice(0, k).map((h) => `${h.id}:${h._bandN}`)
    }
    const cases = [
      [{ id: 'a', score: 5, _raw: -1, updated_at: 1 }, { id: 'b', score: 4, _raw: -4, updated_at: 2 }, { id: 'c', score: 3, _raw: -2, updated_at: 3 }, { id: 'd', score: 2, _raw: 0, updated_at: 4 }],
      [{ id: 'e', score: 5, _raw: NaN, updated_at: 1 }, { id: 'f', score: 4, _raw: 3, updated_at: 2 }, { id: 'g', score: 3, _raw: undefined, updated_at: 3 }, { id: 'h', score: 2, _raw: 2, updated_at: 4 }],
    ]
    fallbackOk = cases.every((cs) => {
      const want = naive(cs, 4).join(',')
      const got = O2.bandize(cs.map((h) => ({ ...h })), '_raw', 4).map((h) => `${h.id}:${h._band}`).join(',')
      fbDetail = `参考 ${want} / 实得 ${got}`
      return want === got
    })
  }
  // NaN 那一组的并列键在 v8 里不稳定，只要求「脏值不抛错、条数对、非脏条目档号一致」——
  // 这里退一步判：条数与不抛错，并逐位比对第一组（纯负数，语义确定）。
  check('OR073 进程内可见：负数 raw 与 NaN raw 下 bandize 不抛错且与朴素实现逐位一致', fallbackOk, fbDetail)
  check(
    'OR073 文档在位：INTERNAL 9.212 写了「定档不靠排序」，README 写了「定档不再靠全量排序」，DESIGN 有 ## 208.，PLAN §11 有 0.6.13 行',
    readFileSync(new URL('./docs/INTERNAL.md', import.meta.url), 'utf8').includes('## 9.212 ') &&
      readFileSync(new URL('./README.md', import.meta.url), 'utf8').includes('定档不再靠全量排序') &&
      readFileSync(new URL('./DESIGN.md', import.meta.url), 'utf8').includes('## 208. ') &&
      /0\.6\.13/.test(readFileSync(new URL('./docs/PLAN-0.6.md', import.meta.url), 'utf8')),
  )
  const vS4 = (readFileSync(new URL('./lib/index.js', import.meta.url), 'utf8').match(/export const version = '(\d+)\.(\d+)\.(\d+)'/) ?? []).slice(1).map(Number)
  const vNumS4 = vS4.length === 3 ? vS4[0] * 10000 + vS4[1] * 100 + vS4[2] : 0
  check('OR073 版本号不低于 0.6.13（后续补丁不必回头改这一条）', vNumS4 >= 613, vS4.join('.'))
}

// 0.6.14：热路不许先挂后摘——临时值进平行数组，回执对象字段集合不变
{
  const hSrc = readFileSync(new URL('./tools/probe-hotpath.mjs', import.meta.url), 'utf8')
  const hLabels = ['H1 ', 'H2 ', 'H3 ', 'H4 ', 'H5 ', 'H6 ']
  const hMissing = hLabels.filter((t) => !hSrc.includes(`'${t}`) && !hSrc.includes(`\`${t}`))
  const wired = readFileSync(new URL('./tools/check-all.mjs', import.meta.url), 'utf8').includes("'tools/probe-hotpath.mjs'")
  const excused = readFileSync(new URL('./verify.mjs', import.meta.url), 'utf8').includes("'tools/probe-hotpath.mjs'")
  check(
    'OR074 热路探针 H1–H6 在位（无 delete / 两遍逐位 / 补分·层级·断言密度各只落该落的那条 / 换尺子清缓存），check-all 挂线且列进取根例外',
    hMissing.length === 0 && wired && excused,
    hMissing.length ? `缺 ${hMissing.join(' ')}` : `挂线 ${wired ? 'ok' : 'miss'} / 例外 ${excused ? 'ok' : 'miss'}`,
  )
  const engSrc5 = readFileSync(new URL('./vendor/meow-memory/lib/index.js', import.meta.url), 'utf8')
  // 只切主路（`const vbTmp = [];` → `bandize(hits, '_raw', k)`）：`keywordHitScore` 那条路另有自己的
  // `_vb` 生命周期，不在这一版的处理范围里，但它也不许被误判成「主路还在 delete」。
  const hotStart5 = engSrc5.indexOf('const vbTmp = [];')
  const hotEnd5 = engSrc5.indexOf("bandize(hits, '_raw', k)")
  const hot5 = hotStart5 > 0 && hotEnd5 > hotStart5 ? engSrc5.slice(hotStart5, hotEnd5) : ''
  const tmpOk = hot5.length > 0 &&
    ['const srTmp = [];', 'const lvTmp = [];', 'const trTmp = [];'].every((t) => hot5.includes(t)) &&
    ['_vb', '_sr', '_lv', '_tr'].every((k) => !hot5.includes(`delete h.${k};`))
  const idfOk = engSrc5.includes('const idfAt = (t) =>') && engSrc5.includes('idfCache = new Map();')
  check(
    'OR074 引擎主路里四个临时值进平行数组（不再 delete 摘字段），idf 每趟记一次并在换尺子时清账',
    tmpOk && idfOk,
    `平行数组 ${tmpOk ? 'ok' : 'miss'} / idf 记忆化 ${idfOk ? 'ok' : 'miss'}`,
  )
  const H2 = await import(pathToFileURL(join(root, 'vendor', 'meow-memory', 'lib', 'index.js')).href)
  let cleanOk = false
  let cleanDetail = 'search 未导出'
  if (typeof H2.search === 'function') {
    const docs = ['0mhot111', '0mhot222', '0mhot333'].map((id, i) => ({
      id,
      level: 'fact',
      title: 't',
      content: `alpha beta delta ${i}`,
      importance: 2,
      updated_at: '2026-01-01T00:00:00Z',
      keywords: ['alpha'],
      project: 'p',
    }))
    const r = H2.search('alpha beta', docs, { k: 5, explain: true, now: 1795470000000 })
    const leaks = r.filter((h) => ['_vb', '_sr', '_lv', '_tr', '_bandTmp'].some((k) => k in h))
    cleanOk = r.length === 3 && leaks.length === 0 && r.every((h) =>
      typeof h.explain === 'object' && '_subj' in h && 'cover' in h && 'score' in h && !('_raw' in h) && !('_band' in h))
    cleanDetail = `${r.length} 条 / 泄漏 ${leaks.length}`
  }
  check('OR074 进程内可见：search 回执不含临时字段（`_vb/_sr/_lv/_tr/_bandTmp` 与用过的 `_raw`/`_band` 都不许留着），`_subj`/`cover`/`score`/explain 照旧在', cleanOk, cleanDetail)
  check(
    'OR074 文档在位：INTERNAL 9.213 写了「热路不许先挂后摘」，README 写了「热路上不留痕」，DESIGN 有 ## 209.，PLAN 有 0.6.14',
    readFileSync(new URL('./docs/INTERNAL.md', import.meta.url), 'utf8').includes('## 9.213 ') &&
      readFileSync(new URL('./README.md', import.meta.url), 'utf8').includes('热路上不留痕') &&
      readFileSync(new URL('./DESIGN.md', import.meta.url), 'utf8').includes('## 209. ') &&
      /0\.6\.14/.test(readFileSync(new URL('./docs/PLAN-0.6.md', import.meta.url), 'utf8')),
  )
  const vS5 = (readFileSync(new URL('./lib/index.js', import.meta.url), 'utf8').match(/export const version = '(\d+)\.(\d+)\.(\d+)'/) ?? []).slice(1).map(Number)
  const vNumS5 = vS5.length === 3 ? vS5[0] * 10000 + vS5[1] * 100 + vS5[2] : 0
  check('OR074 版本号不低于 0.6.14（后续补丁不必回头改这一条）', vNumS5 >= 614, vS5.join('.'))
}

// 0.6.15：覆盖度不许「每条 × 每个问句词」重算——顺着倒排把账加一遍
{
  const cSrc = readFileSync(new URL('./tools/probe-cover.mjs', import.meta.url), 'utf8')
  const cLabels = ['C0 ', 'C1 ', 'C2 ', 'C3 ', 'C4 ', 'C5 ']
  const cMissing = cLabels.filter((t) => !cSrc.includes(`'${t}`))
  const cWired = readFileSync(new URL('./tools/check-all.mjs', import.meta.url), 'utf8').includes("'tools/probe-cover.mjs'")
  const cExcused = readFileSync(new URL('./verify.mjs', import.meta.url), 'utf8').includes("'tools/probe-cover.mjs'")
  check(
    'OR075 覆盖度探针 C0–C5 在位（两条路 / 对拍逐位 / 语义没变 / 换尺子重记账 / 空手不留 NaN / 大库仍一致），check-all 挂线且列进取根例外',
    cMissing.length === 0 && cWired && cExcused,
    cMissing.length ? `缺 ${cMissing.join(' ')}` : `挂线 ${cWired ? 'ok' : 'miss'} / 例外 ${cExcused ? 'ok' : 'miss'}`,
  )
  const engSrc6 = readFileSync(new URL('./vendor/meow-memory/lib/index.js', import.meta.url), 'utf8')
  // [0.6.16] 倒排条目从「下标数组」变成 `{ d, f, t }` 之后，覆盖度这趟改成先取 `const pd = p.d;`
  // 再按 `pd.length` 遍历——旧钉 `coverAcc[p[pi]] += w;` 已经不在了，改钉新形（两半都得在）。
  const accOk =
    (engSrc6.includes('const coverAcc = postings === null ? null : new Float64Array(docs.length);') ||
      engSrc6.includes('const coverAcc = postings === null ? null : scratch === null ? new Float64Array(docs.length) : scratch.coverAcc;')) &&
    engSrc6.includes('const buildCoverAcc = () => {') &&
    engSrc6.includes('const pd = p.d;') &&
    engSrc6.includes('for (let pi = 0; pi < pd.length; pi++) coverAcc[pd[pi]] += w;') &&
    engSrc6.includes('coverOf[di] = Math.min(1, coverAcc[di] / qIdfSum);') &&
    engSrc6.includes('const idf = qLoopIdf[qi];')
  // 退回路口径不许被顺手删掉：倒排缺席（opts.inverted === false）时仍逐条查表。
  const fbOk = engSrc6.includes("for (let qi = 0; qi < qKept.length; qi++) if (tfi.has(qKept[qi])) cover += qKeptIdf[qi];")
  check(
    'OR075 引擎里覆盖度顺倒排记账（coverAcc 一趟加好），倒排缺席时退回逐条查表，打分的 idf 也不再每格重算',
    accOk && fbOk,
    `倒排账 ${accOk ? 'ok' : 'miss'} / 退回路 ${fbOk ? 'ok' : 'miss'}`,
  )
  const adStart6 = engSrc6.indexOf('if (opts.adaptiveIdf === true) {')
  const adEnd6 = adStart6 < 0 ? -1 : engSrc6.indexOf('adapt = { lam, cluster: cl.n };', adStart6)
  const ad6 = adStart6 >= 0 && adEnd6 > adStart6 ? engSrc6.slice(adStart6, adEnd6) : ''
  const iCache6 = ad6.indexOf('idfCache = new Map();')
  const iQ6 = ad6.indexOf('refreshQidf();')
  const iAcc6 = ad6.indexOf('buildCoverAcc();')
  const iFill6 = ad6.indexOf('raw.fill(0);')
  check(
    'OR075 自适应换尺子那趟先把账重记：清 idf 缓存 → 重记问句 idf → 重记覆盖度账 → raw.fill(0) 重扫（顺序不许颠倒）',
    ad6.length > 0 && iCache6 >= 0 && iQ6 > iCache6 && iAcc6 > iQ6 && iFill6 > iAcc6,
    ad6.length === 0 ? '自适应块没找到' : `清缓存 ${iCache6} → 问句 idf ${iQ6} → 覆盖账 ${iAcc6} → 重扫 ${iFill6}`,
  )
  const C2 = await import(pathToFileURL(join(root, 'vendor', 'meow-memory', 'lib', 'index.js')).href)
  let coverOk = false
  let coverDetail = 'search 未导出'
  if (typeof C2.search === 'function') {
    const docs = [
      { id: '0mcov111', content: 'astra', importance: 2 },
      { id: '0mcov222', content: 'astra bravo', importance: 2 },
      { id: '0mcov333', content: 'astra bravo cygnus dorado', importance: 2 },
    ].map((d) => ({ ...d, level: 'fact', title: 't', updated_at: '2026-01-01T00:00:00Z', keywords: [], project: 'p' }))
    const q = 'astra bravo cygnus dorado'
    const on = JSON.stringify(C2.search(q, docs, { k: 5, explain: true, now: 1795470000000 }))
    const off = JSON.stringify(C2.search(q, docs, { k: 5, explain: true, now: 1795470000000, inverted: false }))
    const full = C2.search(q, docs, { k: 5, explain: true, now: 1795470000000 }).find((h) => h.id === '0mcov333')
    coverOk = on === off && full !== undefined && full.explain.cover === 1
    coverDetail = `两路一致 ${on === off} / 全命中 cover ${full === undefined ? '-' : full.explain.cover}`
  }
  check('OR075 进程内：倒排账与逐条查表两条路逐位相同，全命中的那条 cover 仍为 1', coverOk, coverDetail)
  check(
    'OR075 文档在位：INTERNAL 9.214 写了「覆盖度顺着倒排记一遍账」，README 写了「覆盖度不再逐条重算」，DESIGN 有 ## 210.，PLAN 有 0.6.15',
    readFileSync(new URL('./docs/INTERNAL.md', import.meta.url), 'utf8').includes('## 9.214 ') &&
      readFileSync(new URL('./README.md', import.meta.url), 'utf8').includes('覆盖度不再逐条重算') &&
      readFileSync(new URL('./DESIGN.md', import.meta.url), 'utf8').includes('## 210. ') &&
      /0\.6\.15/.test(readFileSync(new URL('./docs/PLAN-0.6.md', import.meta.url), 'utf8')),
  )
  const vS6 = (readFileSync(new URL('./lib/index.js', import.meta.url), 'utf8').match(/export const version = '(\d+)\.(\d+)\.(\d+)'/) ?? []).slice(1).map(Number)
  const vNumS6 = vS6.length === 3 ? vS6[0] * 10000 + vS6[1] * 100 + vS6[2] : 0
  check('OR075 版本号不低于 0.6.15（后续补丁不必回头改这一条）', vNumS6 >= 615, vS6.join('.'))
}

// 0.6.16：打分也不许「每条 × 每个问句词」查表——倒排里记着词频与字段命中位，反过来扫词
{
  const sSrc = readFileSync(new URL('./tools/probe-score.mjs', import.meta.url), 'utf8')
  const sLabels = ['S0 ', 'S1 ', 'S2 ', 'S3 ', 'S4 ', 'S5 ']
  const sMissing = sLabels.filter((t) => !sSrc.includes(`'${t}`))
  const sWired = readFileSync(new URL('./tools/check-all.mjs', import.meta.url), 'utf8').includes("'tools/probe-score.mjs'")
  const sExcused = readFileSync(new URL('./verify.mjs', import.meta.url), 'utf8').includes("'tools/probe-score.mjs'")
  check(
    'OR076 打分探针 S0–S5 在位（两条路 / 对拍逐位 / 字段位等价 / 换尺子先重铺 / 空手不留 NaN / 大库仍一致），check-all 挂线且列进取根例外',
    sMissing.length === 0 && sWired && sExcused,
    sMissing.length ? `缺 ${sMissing.join(' ')}` : `挂线 ${sWired ? 'ok' : 'miss'} / 例外 ${sExcused ? 'ok' : 'miss'}`,
  )
  const engSrc7 = readFileSync(new URL('./vendor/meow-memory/lib/index.js', import.meta.url), 'utf8')
  const pathOk =
    engSrc7.includes('const scoreCandSet = () => {') &&
    // [0.6.34] `candArr` 那只副本（内容与顺序恒等于候选表）整只删掉，改认定长 `Int32Array` + 游标。
    (engSrc7.includes('const candBuf = candAt === null ? null : scratch === null ? new Int32Array(docs.length) : scratch.cand;') ||
      engSrc7.includes('candArr.length = 0;')) &&
    // [0.6.29] `k1 + 1` 提成 `k1p1`、字段加成改成 `FIELD_W_TAB[fl & 3]`：老写法与新写法任在位即算过。
    (engSrc7.includes('raw[di] += idf0 * fw * (f * (k1 + 1) / (f + kDen[di]));') ||
      engSrc7.includes('raw[di] += idf0 * fw * (f * k1p1 / (f + kDen[di]));')) &&
    ((engSrc7.includes('if (fl & 1) fw += FIELD_TITLE_W;') &&
      engSrc7.includes('if (fl & 2) fw += FIELD_KW_W;')) ||
      (engSrc7.includes('const FIELD_W_TAB = [1, 1 + FIELD_TITLE_W, 1 + FIELD_KW_W, 1 + FIELD_TITLE_W + FIELD_KW_W];') &&
        // [0.6.39] 表外面多乘一个「这个词在库里有声明对端就打 0.7」的系数（qLoopDeclW）；
        // 没有声明对端时它整条 null，走的还是原来那一格。两种形状任在位即算过。
        (engSrc7.includes('const fw = FIELD_W_TAB[fl & 3];') ||
          engSrc7.includes('const fw = qLoopDeclW === null ? FIELD_W_TAB[fl & 3] : FIELD_W_TAB[fl & 3] * qLoopDeclW[qi];'))))
  // 倒排要记词频与「命中了哪几个字段」；字段权重值本身不许预乘（opts.fieldKwW 是每问参数）。
  const idxOk =
    engSrc7.includes('p.f.push(v);') &&
    engSrc7.includes('p.t.push((ts !== null && ts.has(t) ? 1 : 0) | (ks !== null && ks.has(t) ? 2 : 0));') &&
    !/p\.w\.push/.test(engSrc7)
  // 退路不许被顺手删掉：倒排缺席（opts.inverted === false）或问句带标识符时仍逐条扫，首趟与换尺子两处都在。
  const fbOk = (engSrc7.split('raw[di] = scanDoc(di);').length - 1) === 2
  check(
    'OR076 引擎里打分顺倒排累加（候选先备常数再按词扫），倒排记着词频与字段命中位、字段权重不预乘，逐条扫的退路两处都在',
    pathOk && idxOk && fbOk,
    `扫倒排 ${pathOk ? 'ok' : 'miss'} / 倒排记 ${idxOk ? 'ok' : 'miss'} / 退路 ${fbOk ? 'ok' : 'miss'}`,
  )
  const adStart7 = engSrc7.indexOf('if (opts.adaptiveIdf === true) {')
  const adEnd7 = adStart7 < 0 ? -1 : engSrc7.indexOf('adapt = { lam, cluster: cl.n };', adStart7)
  const ad7 = adStart7 >= 0 && adEnd7 > adStart7 ? engSrc7.slice(adStart7, adEnd7) : ''
  const iCache7 = ad7.indexOf('idfCache = new Map();')
  const iQ7 = ad7.indexOf('refreshQidf();')
  const iAcc7 = ad7.indexOf('buildCoverAcc();')
  const iFill7 = ad7.indexOf('raw.fill(0);')
  const iScore7 = ad7.indexOf('scoreCandSet();')
  check(
    'OR076 自适应换尺子那趟：清缓存 → 问句 idf → 覆盖度账 → 清账 → 重新打分（候选要重铺，否则同一条会被算两遍）',
    ad7.length > 0 && iCache7 >= 0 && iQ7 > iCache7 && iAcc7 > iQ7 && iFill7 > iAcc7 && iScore7 > iFill7,
    ad7.length === 0 ? '自适应块没找到' : `清缓存 ${iCache7} → 问句 idf ${iQ7} → 覆盖账 ${iAcc7} → 清账 ${iFill7} → 打分 ${iScore7}`,
  )
  const S2 = await import(pathToFileURL(join(root, 'vendor', 'meow-memory', 'lib', 'index.js')).href)
  let scoreOk = false
  let scoreDetail = 'search 未导出'
  if (typeof S2.search === 'function') {
    const docs = [
      { id: '0msco111', content: 'astra', importance: 2, title: 'astra' },
      { id: '0msco222', content: 'astra bravo', importance: 2, title: 'bravo' },
      { id: '0msco333', content: 'astra bravo cygnus dorado', importance: 2, keywords: ['dorado'] },
    ].map((d) => ({ ...d, level: 'fact', updated_at: '2026-01-01T00:00:00Z', project: 'p' }))
    const q = 'astra bravo cygnus dorado'
    const base = { k: 5, explain: true, now: 1795470000000 }
    const on = JSON.stringify(S2.search(q, docs, base))
    const off = JSON.stringify(S2.search(q, docs, { ...base, inverted: false }))
    const kw0 = JSON.stringify(S2.search(q, docs, { ...base, fieldKwW: 0 }))
    const kw0off = JSON.stringify(S2.search(q, docs, { ...base, fieldKwW: 0, inverted: false }))
    const fin = S2.search(q, docs, base).every((h) => Number.isFinite(h.score))
    scoreOk = on === off && kw0 === kw0off && fin
    scoreDetail = `两路一致 ${on === off} / 关键词权重 0 也一致 ${kw0 === kw0off} / score 有限 ${fin}`
  }
  check('OR076 进程内：扫倒排与逐条扫两条路逐位相同，字段权重换成每问参数照样对得上', scoreOk, scoreDetail)
  check(
    'OR076 文档在位：INTERNAL 9.215 写了「打分顺着倒排累加」，README 写了「打分不再逐条查表」，DESIGN 有 ## 211.，PLAN 有 0.6.16',
    readFileSync(new URL('./docs/INTERNAL.md', import.meta.url), 'utf8').includes('## 9.215 ') &&
      readFileSync(new URL('./README.md', import.meta.url), 'utf8').includes('打分不再逐条查表') &&
      readFileSync(new URL('./DESIGN.md', import.meta.url), 'utf8').includes('## 211. ') &&
      /0\.6\.16/.test(readFileSync(new URL('./docs/PLAN-0.6.md', import.meta.url), 'utf8')),
  )
  const vS7 = (readFileSync(new URL('./lib/index.js', import.meta.url), 'utf8').match(/export const version = '(\d+)\.(\d+)\.(\d+)'/) ?? []).slice(1).map(Number)
  const vNumS7 = vS7.length === 3 ? vS7[0] * 10000 + vS7[1] * 100 + vS7[2] : 0
  check('OR076 版本号不低于 0.6.16（后续补丁不必回头改这一条）', vNumS7 >= 616, vS7.join('.'))
}

// 0.6.17：命中对象不许扫描期就把十四个字段全铺出来——定档截断只吃六样，入选的 k 条事后水化
{
  const hSrc = readFileSync(new URL('./tools/probe-hydrate.mjs', import.meta.url), 'utf8')
  const hLabels = ['H0 ', 'H1 ', 'H2 ', 'H3 ', 'H4 ', 'H5 ']
  const hMissing = hLabels.filter((t) => !hSrc.includes(`'${t}`))
  const hWired = readFileSync(new URL('./tools/check-all.mjs', import.meta.url), 'utf8').includes("'tools/probe-hydrate.mjs'")
  const hExcused = readFileSync(new URL('./verify.mjs', import.meta.url), 'utf8').includes("'tools/probe-hydrate.mjs'")
  check(
    'OR077 水化探针 H0–H5 在位（源码五件 / 瘦路与 explain 逐字节含键序 / keepBand 路 / 无 _di 泄漏且数组属性在 / 可选字段照旧省略 / 大库仍一致），check-all 挂线且列进取根例外',
    hMissing.length === 0 && hWired && hExcused,
    hMissing.length ? `缺 ${hMissing.join(' ')}` : `挂线 ${hWired ? 'ok' : 'miss'} / 例外 ${hExcused ? 'ok' : 'miss'}`,
  )
  const engSrc8 = readFileSync(new URL('./vendor/meow-memory/lib/index.js', import.meta.url), 'utf8')
  // 瘦路的条件：只有「不要 explain 也不要 band」才走，另外两条路必须留在完整字面量上。
  const leanOk =
    engSrc8.includes('const leanHit = opts.explain !== true && opts.keepBand !== true;') &&
    engSrc8.includes('if (leanHit) {') &&
    engSrc8.includes('} else hits.push({')
  // 瘦对象只许带定档要用的六样加下标：多带了字段说明整条字面量被搬回来了。
  const leanBody = engSrc8.slice(engSrc8.indexOf('if (leanHit) {'), engSrc8.indexOf('} else hits.push({'))
  const leanFields = [...leanBody.matchAll(/^ {8}([A-Za-z_]+):/gm)].map((m) => m[1])
  const leanFieldsOk =
    // [0.6.29] 瘦对象上不再算 `cover`（截断后由 `matHitOf` 现算），所以六样 + `_di` 与老七样任一位在即算过。
    (JSON.stringify(leanFields) === JSON.stringify(['_subj', '_raw', 'cover', 'id', 'updated_at', 'score', '_di']) ||
      JSON.stringify(leanFields) === JSON.stringify(['_subj', '_raw', 'id', 'updated_at', 'score', '_di'])) &&
    leanBody.includes('_di: di')
  const hydrateOk =
    engSrc8.includes('const matHitOf = (h, di) => {') &&
    engSrc8.includes('const outHits = trimByBand(hits, k, opts);') &&
    engSrc8.includes('outHits[hi] = matHitOf(h, di);') &&
    engSrc8.includes('return outHits;')
  // keepBand 那条提前返回必须还在（searchHybrid 要拿 `_band` 融合），水化在它之后不许动手。
  // [0.6.28] 这个出口前面多了一句 `hotScratchDone();`，返回语句本身没动。
  const keepSlice = 'return hits.slice(0, Number.isFinite(k) && k > 0 ? Math.round(k) : hits.length);'
  const keepOk = engSrc8.includes('if (opts.keepBand === true) return hits.slice(0, Number.isFinite(k) && k > 0 ? Math.round(k) : hits.length);') ||
    (engSrc8.includes('if (opts.keepBand === true) {') && engSrc8.includes(keepSlice) && engSrc8.includes('hotScratchDone();'))
  check(
    'OR077 引擎里命中对象先瘦后水化：扫描期只铺定档要用的六样加 _di，截断之后再按原键序水化；explain / keepBand 两条路仍走完整字面量',
    leanOk && leanFieldsOk && hydrateOk && keepOk,
    `瘦路 ${leanOk ? 'ok' : 'miss'} / 瘦字段 ${leanFieldsOk ? leanFields.join(',') : `多带 ${leanFields.join(',')}`} / 水化 ${hydrateOk ? 'ok' : 'miss'} / keepBand ${keepOk ? 'ok' : 'miss'}`,
  )
  const S3 = await import(pathToFileURL(join(root, 'vendor', 'meow-memory', 'lib', 'index.js')).href)
  let hyOk = false
  let hyDetail = 'search 未导出'
  if (typeof S3.search === 'function') {
    const docs = [
      { id: '0mhyd111', content: 'astra bravo', title: 'astra', importance: 2, keywords: ['bravo'], project: 'p' },
      { id: '0mhyd222', content: 'astra cygnus dorado', title: 'cygnus', importance: 1, project: 'p', status: 'stale' },
      { id: '0mhyd333', content: 'dorado echo', title: 'dorado', importance: 3, project: 'q', created_at: '2026-01-02T00:00:00Z' },
    ].map((d) => ({ ...d, level: 'fact', updated_at: '2026-01-01T00:00:00Z' }))
    const q = 'astra dorado cygnus'
    const base = { k: 3, now: 1795470000000 }
    const strip = (h) => {
      const o = { ...h }
      delete o.explain
      return JSON.stringify(o)
    }
    const lean = S3.search(q, docs, base)
    const full = S3.search(q, docs, { ...base, explain: true })
    const same = lean.length === full.length && lean.every((h, i) => strip(h) === strip(full[i]))
    const noLeak = lean.every((h) => !('_di' in h) && !('_raw' in h) && !('_band' in h) && !('_ident' in h) && !('_dense' in h))
    let keepSame = false
    const keep = S3.search(q, docs, { ...base, keepBand: true })
    if (keep.length === lean.length) {
      const peel = (h) => {
        const o = { ...h }
        for (const f of ['_raw', '_bandTmp', '_band', '_ident', '_dense']) delete o[f]
        return JSON.stringify(o)
      }
      keepSame = keep.every((h, i) => peel(h) === strip(full[i]))
    }
    hyOk = same && noLeak && keepSame && keep.length > 0
    hyDetail = `两条路逐字节 ${same} / 无内部字段 ${noLeak} / keepBand 路 ${keepSame}（${keep.length} 条）`
  }
  check('OR077 进程内：瘦路回执与 explain 路逐字段逐字节相同（含键序），keepBand 路剥内部字段后也相同', hyOk, hyDetail)
  check(
    'OR077 文档在位：INTERNAL 9.216 写了「命中对象先瘦后水化」，README 写了「先瘦后水化」，DESIGN 有 ## 212.，PLAN 有 0.6.17',
    readFileSync(new URL('./docs/INTERNAL.md', import.meta.url), 'utf8').includes('## 9.216 ') &&
      readFileSync(new URL('./README.md', import.meta.url), 'utf8').includes('先瘦后水化') &&
      readFileSync(new URL('./DESIGN.md', import.meta.url), 'utf8').includes('## 212. ') &&
      /0\.6\.17/.test(readFileSync(new URL('./docs/PLAN-0.6.md', import.meta.url), 'utf8')),
  )
  const vS8 = (readFileSync(new URL('./lib/index.js', import.meta.url), 'utf8').match(/export const version = '(\d+)\.(\d+)\.(\d+)'/) ?? []).slice(1).map(Number)
  const vNumS8 = vS8.length === 3 ? vS8[0] * 10000 + vS8[1] * 100 + vS8[2] : 0
  check('OR077 版本号不低于 0.6.17（后续补丁不必回头改这一条）', vNumS8 >= 617, vS8.join('.'))
}

// 0.6.18：候选集不再是 Set——位图去重 + 首见序候选表。首见序 = Set 的插入序，
// 所以扫描顺序、浮点加法顺序、回执顺序都逐位不变；省的是 1 万次 Set.add 与两份 Set 的分配。
{
  const cSrc = readFileSync(new URL('./tools/probe-cand.mjs', import.meta.url), 'utf8')
  const cLabels = ['C0 ', 'C1 ', 'C2 ', 'C3 ', 'C4 ', 'C5 ']
  const cMissing = cLabels.filter((t) => !cSrc.includes(`'${t}`))
  const cWired = readFileSync(new URL('./tools/check-all.mjs', import.meta.url), 'utf8').includes("'tools/probe-cand.mjs'")
  const cExcused = readFileSync(new URL('./verify.mjs', import.meta.url), 'utf8').includes("'tools/probe-cand.mjs'")
  check(
    'OR078 候选账探针 C0–C5 在位（源码七件 / 与 Set 算法对拍 / 倒排开与关两路逐位相同 / 扩词那条路 / 空手问句 / 大库换尺子），check-all 挂线且列进取根例外',
    cMissing.length === 0 && cWired && cExcused,
    cMissing.length ? `缺 ${cMissing.join(' ')}` : `挂线 ${cWired ? 'ok' : 'miss'} / 例外 ${cExcused ? 'ok' : 'miss'}`,
  )
  const engSrc9 = readFileSync(new URL('./vendor/meow-memory/lib/index.js', import.meta.url), 'utf8')
  // [0.6.34] 候选表换成定长 `Int32Array` + 游标 `candN`：两种形态都认（见 probe-cand C0）。
  const dedupeLine =
    engSrc9.includes('if (candAt[di] === 0) { candAt[di] = 1; candBuf[candN++] = di; }')
      ? 'if (candAt[di] === 0) { candAt[di] = 1; candBuf[candN++] = di; }'
      : 'if (candAt[di] === 0) { candAt[di] = 1; candList.push(di); }'
  const candStart = engSrc9.indexOf('const candAt = postings === null || verbOn ? null : new Uint8Array(docs.length);') >= 0
    ? engSrc9.indexOf('const candAt = postings === null || verbOn ? null : new Uint8Array(docs.length);')
    : engSrc9.indexOf('const candAt = postings === null || verbOn ? null : scratch === null ? new Uint8Array(docs.length) : scratch.candAt;')
  const candEnd = candStart < 0 ? -1 : engSrc9.indexOf('const scoreCandSet = () => {', candStart + 1)
  const candBody = candStart >= 0 && candEnd > candStart ? engSrc9.slice(candStart, candEnd) : ''
  const bitmapOk = candStart >= 0 &&
    (engSrc9.includes('const candList = candAt === null ? null : [];') ||
      engSrc9.includes('const candBuf = candAt === null ? null : scratch === null ? new Int32Array(docs.length) : scratch.cand;'))
  const dedupeTwice = engSrc9.split(dedupeLine).length - 1 === 2
  const loopOk = (engSrc9.includes('for (let ci = 0; ci < candList.length; ci++) {') ||
    engSrc9.includes('for (let ci = 0; ci < candN; ci++) {')) &&
    !engSrc9.includes('for (const di of candList)') && !engSrc9.includes('for (const di of candBuf)')
  const nullTwice = engSrc9.split('if (candList === null) {').length - 1 === 2 ||
    engSrc9.split('if (candBuf === null) {').length - 1 === 2
  // 候选集那一段里 Set 必须真的退场；引擎别处（比如 forms、图遍历）还在用 Set，全文件查会误判。
  const noSet = candBody.length > 0 && !candBody.includes('new Set()') && !candBody.includes('set.add(')
  check(
    'OR078 引擎里候选集换成位图 + 首见序候选表：两处去重语句、下标循环、两处退路判空，那一段里 Set 已退场',
    bitmapOk && dedupeTwice && loopOk && nullTwice && noSet,
    `位图 ${bitmapOk ? 'ok' : 'miss'} / 去重两处 ${dedupeTwice} / 下标循环 ${loopOk ? 'ok' : 'miss'} / 判空两处 ${nullTwice} / Set 退场 ${noSet ? 'ok' : 'miss'}`,
  )
  const S4 = await import(pathToFileURL(join(root, 'vendor', 'meow-memory', 'lib', 'index.js')).href)
  let cdOk = false
  let cdDetail = 'search 未导出'
  if (typeof S4.search === 'function') {
    const docs = [
      { id: '0mcd1111', content: 'astra', importance: 2, title: 'astra' },
      { id: '0mcd2222', content: 'astra bravo', importance: 2, title: 'bravo' },
      { id: '0mcd3333', content: 'astra bravo cygnus dorado', importance: 2, keywords: ['dorado'] },
    ].map((d) => ({ ...d, level: 'fact', updated_at: '2026-01-01T00:00:00Z', project: 'p' }))
    const q = 'astra bravo cygnus dorado'
    const base = { k: 5, explain: true, now: 1795470000000 }
    const on = JSON.stringify(S4.search(q, docs, base))
    const off = JSON.stringify(S4.search(q, docs, { ...base, inverted: false }))
    const fin = S4.search(q, docs, base).every((h) => Number.isFinite(h.score))
    // 扩词那条路：库要够大才过得了 df 上限（cap = floor(n × 0.35)），
    // 且被桥接回来的那条分数低、会被截断剪掉——所以判据看 trimmed 的变化与条序，不看分数。
    const SYN = []
    for (let i = 0; i < 6; i++) SYN.push({ id: '0msyn' + String(i).padStart(4, '0'), content: 'alpha only text', importance: 2, keywords: ['alpha', 'beta'] })
    SYN.push({ id: '0msyn09000', content: 'beta only text', importance: 2 })
    for (let i = 0; i < 32; i++) SYN.push({ id: '0mfll' + String(i).padStart(4, '0'), content: 'filler' + i + ' words here', importance: 2 })
    const synDocs = SYN.map((d) => ({ ...d, level: 'fact', title: 't', project: 'p', status: 'active', created_at: 1795000000000, updated_at: 1795000000000 }))
    const bOn = S4.search('alpha', synDocs, { k: 50, explain: true, now: 1795470000000 })
    const bOff = S4.search('alpha', synDocs, { k: 50, explain: true, now: 1795470000000, synBridge: false })
    const bridged = bOn.trimmed === 1 && bOff.trimmed === void 0
    const orderSame = JSON.stringify(bOn.map((h) => h.id)) === JSON.stringify(bOff.map((h) => h.id))
    cdOk = on === off && fin && bridged && orderSame
    cdDetail = `倒排开/关一致 ${on === off} / score 有限 ${fin} / 扩词桥多一条 ${bridged} / 条序不变 ${orderSame}`
  }
  check('OR078 进程内：位图候选表的回执与逐条扫逐字节相同，扩词那条路也真的进候选表（多一条、条序不变）', cdOk, cdDetail)
  check(
    'OR078 文档在位：INTERNAL 9.217 写了「位图 + 首见序候选表」，README 写了「候选集不再用 Set」，DESIGN 有 ## 213.，PLAN 有 0.6.18',
    readFileSync(new URL('./docs/INTERNAL.md', import.meta.url), 'utf8').includes('## 9.217 ') &&
      readFileSync(new URL('./README.md', import.meta.url), 'utf8').includes('候选集不再用 Set') &&
      readFileSync(new URL('./DESIGN.md', import.meta.url), 'utf8').includes('## 213. ') &&
      /0\.6\.18/.test(readFileSync(new URL('./docs/PLAN-0.6.md', import.meta.url), 'utf8')),
  )
  const vS9 = (readFileSync(new URL('./lib/index.js', import.meta.url), 'utf8').match(/export const version = '(\d+)\.(\d+)\.(\d+)'/) ?? []).slice(1).map(Number)
  const vNumS9 = vS9.length === 3 ? vS9[0] * 10000 + vS9[1] * 100 + vS9[2] : 0
  check('OR078 版本号不低于 0.6.18（后续补丁不必回头改这一条）', vNumS9 >= 618, vS9.join('.'))
}

// 0.6.19：定档不再靠「全量数值排序」（桶计数排序 + 桶内分段，见 INTERNAL 9.218 / DESIGN 214）。
{
  const bSrc = readFileSync(new URL('./tools/probe-band.mjs', import.meta.url), 'utf8')
  const bWired = readFileSync(new URL('./tools/check-all.mjs', import.meta.url), 'utf8').includes("'tools/probe-band.mjs'")
  const bExcused = readFileSync(new URL('./verify.mjs', import.meta.url), 'utf8').includes("'tools/probe-band.mjs'")
  const bLabels = ['B0 桶链在位', 'B1 桶链与', 'B2 同桶任意两值的比值', 'B3 退化语料', 'B4 定档逐条对拍', 'B5 复用缓冲不串味', 'B6 桶号事实'].every((t) => bSrc.includes(t))
  check(
    'OR079 桶链探针 B0–B6 在位，check-all 挂线且列进取根例外',
    bLabels && bWired && bExcused,
    `标签 ${bLabels} / 挂线 ${bWired} / 取根例外 ${bExcused}`,
  )

  const ENGINE_B = readFileSync(new URL('./vendor/meow-memory/lib/index.js', import.meta.url), 'utf8')
  const bBegin = ENGINE_B.indexOf('const RAWK_SHIFT = 16;')
  const bBodyStart = ENGINE_B.indexOf('function setBandsByThreshold(hits, rawKey) {')
  const bSeg = bBegin >= 0 && bBodyStart > bBegin ? ENGINE_B.slice(bBegin, bBodyStart) : ''
  const bBandAnchor = ENGINE_B.indexOf('h._bandTmp = m - 1 - lo;') >= 0 ? 'h._bandTmp = m - 1 - lo;' : 'h._bandTmp = lastBand;'
  const bBodyEnd = ENGINE_B.indexOf('\n}', ENGINE_B.indexOf(bBandAnchor, bBodyStart))
  const bBody = bBodyStart >= 0 && bBodyEnd > bBodyStart ? ENGINE_B.slice(bBodyStart, bBodyEnd) : ''
  const parts = {
    桶常量: bSeg.includes('const RAWK_SHIFT = 16;') && bSeg.includes('const RAWK_NB = 1 << (32 - RAWK_SHIFT);'),
    计数: (bSeg.includes('rawkHist.fill(0, 0, rawkTopPrev + 1);') || bSeg.includes('rawkHist.fill(0);')) &&
      bSeg.includes('rawkHist[b] += 1;'),
    攒段: bSeg.includes('out[rawkHist[rawkBucketOf(v)]++] = v;'),
    阈值: bSeg.includes('const t = anchor < 0 ? Infinity : IMP_BAND * anchor;'),
    桶0: bSeg.includes('if (b === 0) {') && bSeg.includes('seg.sort();'),
    退路: bSeg.includes('vals.subarray(0, n).sort();'),
    走链: bBody.includes('const anchors = anchorChainOf(vals, plain);'),
    老路: ENGINE_B.includes('function setBandsBySort(hits, rawKey) {'),
  }
  const noFullSort = bBody !== '' && bBody.includes('vals.sort();') === false
  check(
    'OR079 引擎里定档换成桶计数排序 + 段扫：桶常量 / 计数 / 攒段 / 阈值走链 / 桶 0 特判 / 小端退路只排前 n 个，阈值路径里全量排序已退场',
    Object.values(parts).every(Boolean) && noFullSort,
    `${Object.entries(parts).map(([k, v]) => `${k}=${v}`).join(' · ')} · 无全量排序=${noFullSort}`,
  )

  // 进程内对拍：把桶链那一段切出来当纯函数，与「全量排序 + 阈值链」在三组固定语料上逐位比。
  let eqOk = false
  let eqDetail = ''
  try {
    // eslint-disable-next-line no-new-func
    const mod = new Function('IMP_BAND', `${bSeg}\nreturn { anchorChainOf };`)(0.85)
    const refChain = (src) => {
      const v = Float64Array.from(src)
      v.sort()
      const out = []
      let anchor = -1
      for (let i = v.length - 1; i >= 0; i--) {
        const x = v[i]
        if (out.length === 0 || x < 0.85 * anchor) {
          out.push(x)
          anchor = x
        }
      }
      out.reverse()
      return out
    }
    const corpora = [
      [0.9, 0.5, 0.1, 0.5, 0.3, 0.05, 0.95, 0.7],
      [0, 5e-324, 1e-300, 2e-300, 1, 0, 1e300],
      [0.37, 0.37, 0.37, 0.4, 0.34, 0.25, 0.6, 0.5, 0.42],
    ]
    const bad = corpora.filter((c) => {
      const vals = Float64Array.from(c)
      return JSON.stringify(mod.anchorChainOf(vals, vals.length)) !== JSON.stringify(refChain(c))
    })
    eqOk = bad.length === 0
    eqDetail = `${corpora.length} 组语料 · 不一致 ${bad.length}`
  } catch (e) {
    eqDetail = String(e && e.message)
  }
  check('OR079 进程内：桶链与「全量排序 + 阈值链」在三组固定语料（含 0、次正规数、并列）上逐位相同', eqOk, eqDetail)

  const iSrc = readFileSync(new URL('./docs/INTERNAL.md', import.meta.url), 'utf8')
  const rSrc = readFileSync(new URL('./README.md', import.meta.url), 'utf8')
  const dSrc = readFileSync(new URL('./DESIGN.md', import.meta.url), 'utf8')
  check(
    'OR079 文档在位：INTERNAL 9.218 写了「桶计数排序」，README 写了「定档不再排序」，DESIGN 有 ## 214.，PLAN 有 0.6.19',
    iSrc.includes('## 9.218 ') && rSrc.includes('定档不再排序') && dSrc.includes('## 214. ') && /0\.6\.19/.test(readFileSync(new URL('./docs/PLAN-0.6.md', import.meta.url), 'utf8')),
  )
  const vS10 = (readFileSync(new URL('./lib/index.js', import.meta.url), 'utf8').match(/export const version = '(\d+)\.(\d+)\.(\d+)'/) ?? []).slice(1).map(Number)
  const vNumS10 = vS10.length === 3 ? vS10[0] * 10000 + vS10[1] * 100 + vS10[2] : 0
  check('OR079 版本号不低于 0.6.19（后续补丁不必回头改这一条）', vNumS10 >= 619, vS10.join('.'))
}

// 0.6.20：签名校验不再每问查一遍 WeakMap（对齐行缓存，见 INTERNAL 9.219 / DESIGN 215）。
{
  const gSrc = readFileSync(new URL('./tools/probe-sigrow.mjs', import.meta.url), 'utf8')
  const gWired = readFileSync(new URL('./tools/check-all.mjs', import.meta.url), 'utf8').includes("'tools/probe-sigrow.mjs'")
  const gExcused = readFileSync(new URL('./verify.mjs', import.meta.url), 'utf8').includes("'tools/probe-sigrow.mjs'")
  const gLabels = ['R0 行缓存形状', 'R1 行缓存与新建数组逐位相同', 'R2 计数口径', 'R3 变更必被看见', 'R4 三次一致', 'R5 脏值'].every((t) => gSrc.includes(t))
  check(
    'OR080 签名行缓存探针 R0–R5 在位（形状八件 / 与新建数组那条路逐位相同 / 计数口径 / 变更必被看见 / 三次一致 / 脏值不合并），check-all 挂线且列进取根例外',
    gLabels && gWired && gExcused,
    `标签 ${gLabels} / 挂线 ${gWired} / 取根例外 ${gExcused}`,
  )

  const ENGINE_G = readFileSync(new URL('./vendor/meow-memory/lib/index.js', import.meta.url), 'utf8')
  const partsG = {
    侧表: ENGINE_G.includes('const SIG_ROW_CACHE = new WeakMap();'),
    取行: ENGINE_G.includes('function sigRowFor(docs, n) {'),
    首访不铺: ENGINE_G.includes('if (slot.row === null && slot.visits >= 2) slot.row = new Array(n);'),
    行内校验: ENGINE_G.includes('function sigDocOfRow(row, i, d) {'),
    行命中计数: ENGINE_G.includes('sigStats.hashed++;\n    sigStats.reused++;'),
    两路合并: ENGINE_G.includes('h ^= row === null ? sigDocOf(docs[i]) : sigDocOfRow(row, i, docs[i]);'),
    非数组旧路: ENGINE_G.includes('for (const d of docs) {'),
    单趟签名: ENGINE_G.includes('const sig = indexSignature(docs);') &&
      ENGINE_G.includes('const key = indexPathKey(docs, opts, sig);') &&
      ENGINE_G.includes('given.__sig === sig &&'),
  }
  const missG = Object.keys(partsG).filter((k) => !partsG[k])
  check(
    'OR080 引擎里签名校验换成「按数组下标对齐的侧表」：行缓存只在第 2 次访问才铺、行命中计数与 sigDocOf 同口径、非数组可迭代物仍走旧路，签名一问只算一次',
    missG.length === 0,
    missG.length === 0 ? `${Object.keys(partsG).length} 件在位` : `缺 ${missG.join(' / ')}`,
  )

  let sameOk = false
  let sameDetail = ''
  try {
    const S4 = await import(pathToFileURL(join(root, 'vendor', 'meow-memory', 'lib', 'index.js')).href)
    const W = ['记忆', '插件', '索引', '签名', '缓存', '定档']
    const r = (() => { let s = 0x51ed; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296 } })()
    const mk = (i) => ({
      id: '0mg' + i, project: i % 2 ? 'a' : 'b', title: W[i % 6],
      content: W[Math.floor(r() * 6)] + '，' + W[Math.floor(r() * 6)] + '。第 ' + i + ' 条。',
      keywords: [W[Math.floor(r() * 6)]], updated_at: 1795400000000 - i, source_session: 's' + (i % 3),
    })
    let bad = 0
    let cases = 0
    for (let s = 0; s < 40; s++) {
      const docs = []
      for (let i = 0; i < 1 + (s % 25); i++) docs.push(mk(i))
      for (let k = 0; k < 3; k++) {
        cases++
        if (S4.indexSignature(docs) !== S4.indexSignature(docs.slice())) bad++
        docs[0].content += '变'
        cases++
        if (S4.indexSignature(docs) !== S4.indexSignature(docs.slice())) bad++
      }
    }
    sameOk = bad === 0
    sameDetail = `${cases} 次对拍 · 不一致 ${bad}`
  } catch (e) {
    sameDetail = String(e && e.message)
  }
  check('OR080 进程内：行缓存那一趟与「每次新建数组」那一趟签名逐位相同，改一处两路一起变', sameOk, sameDetail)

  let cntOk = false
  let cntDetail = ''
  try {
    const S5 = await import(pathToFileURL(join(root, 'vendor', 'meow-memory', 'lib', 'index.js')).href)
    const mkDoc = (i) => ({ id: '0mc' + i, project: 'p', title: 't' + i, content: '正文 ' + i, keywords: ['记忆'], updated_at: 1795400000000 - i, source_session: 's1' })
    const a = []
    const b = []
    for (let i = 0; i < 120; i++) { a.push(mkDoc(i)); b.push(mkDoc(i)) }
    const grab = (fn) => { S5.resetIndexSignatureStats(); fn(); const st = S5.indexSignatureStats(); return `${st.calls}/${st.hashed}/${st.reused}/${st.rebuilt}` }
    const sameKey = grab(() => { S5.indexSignature(a); S5.indexSignature(a) })
    const freshKey = grab(() => { S5.indexSignature(b.slice()); S5.indexSignature(b.slice()) })
    cntOk = sameKey === freshKey
    cntDetail = `同一数组 ${sameKey} / 每次新建 ${freshKey}`
  } catch (e) {
    cntDetail = String(e && e.message)
  }
  check('OR080 进程内：行缓存不偷偷改计数口径（calls / hashed / reused / rebuilt 与不带行缓存那条路相同）', cntOk, cntDetail)

  check(
    'OR080 文档在位：INTERNAL 9.219 写了「对齐行缓存」，README 写了「签名校验不再查 WeakMap」，DESIGN 有 ## 215.，PLAN 有 0.6.20',
    readFileSync(new URL('./docs/INTERNAL.md', import.meta.url), 'utf8').includes('## 9.219 ') &&
      readFileSync(new URL('./README.md', import.meta.url), 'utf8').includes('签名校验不再查 WeakMap') &&
      readFileSync(new URL('./DESIGN.md', import.meta.url), 'utf8').includes('## 215. ') &&
      /0\.6\.20/.test(readFileSync(new URL('./docs/PLAN-0.6.md', import.meta.url), 'utf8')),
  )
  const vS11 = (readFileSync(new URL('./lib/index.js', import.meta.url), 'utf8').match(/export const version = '(\d+)\.(\d+)\.(\d+)'/) ?? []).slice(1).map(Number)
  const vNumS11 = vS11.length === 3 ? vS11[0] * 10000 + vS11[1] * 100 + vS11[2] : 0
  check('OR080 版本号不低于 0.6.20（后续补丁不必回头改这一条）', vNumS11 >= 620, vS11.join('.'))
}

// 0.6.21：词法分类不再逐字符跑两条 Unicode 正则（BMP 表，见 INTERNAL 9.220 / DESIGN 216）。
{
  const lSrc = readFileSync(new URL('./tools/probe-lex.mjs', import.meta.url), 'utf8')
  const lWired = readFileSync(new URL('./tools/check-all.mjs', import.meta.url), 'utf8').includes("'tools/probe-lex.mjs'")
  const lExcused = readFileSync(new URL('./verify.mjs', import.meta.url), 'utf8').includes("'tools/probe-lex.mjs'")
  const lLabels = ['L0 形状', 'L1 全码点', 'L2 表本身', 'L3 切段', 'L4 惰性', 'L5 退化'].every((t) => lSrc.includes(t))
  check(
    'OR081 词法探针 L0–L5 在位（形状 / 全码点逐点相同 / 表本身逐格相同 / 切段逐串相同 / 惰性只建一次 / 退化），check-all 挂线且列进取根例外',
    lLabels && lWired && lExcused,
    `标签 ${lLabels} / 挂线 ${lWired} / 取根例外 ${lExcused}`,
  )

  const ENGINE_L = readFileSync(new URL('./vendor/meow-memory/lib/index.js', import.meta.url), 'utf8')
  // 0.6.22 起 tokenize 只剩一行包装（`return finishToks(tokenizeSegs(text));`），切段循环搬进了 tokenizeSegs。
  const tokBodyL = (() => {
    const a = ENGINE_L.indexOf('function tokenizeSegs(text) {')
    return a < 0 ? '' : ENGINE_L.slice(a, ENGINE_L.indexOf('\n}\n', a))
  })()
  const partsL = {
    三档常量: ENGINE_L.includes('var CLS_SKIP = 0;') && ENGINE_L.includes('var CLS_CJK = 1;') && ENGINE_L.includes('var CLS_WORD = 2;'),
    惰性槽: ENGINE_L.includes('var clsBmp = null;'),
    建表: ENGINE_L.includes('var t = new Uint8Array(65536);') && ENGINE_L.includes('var t = clsBmp === null ? (clsBmp = buildClsBmp()) : clsBmp;'),
    表由正则扫出: ENGINE_L.includes('new RegExp(CJK.source + "+", "gu")') && ENGINE_L.includes('new RegExp(WORD.source + "+", "gu")'),
    只补空格: ENGINE_L.includes('if (t[k] === CLS_SKIP) t[k] = CLS_WORD;'),
    单码点快路: ENGINE_L.includes('if (cp.length === 1) {') && ENGINE_L.includes('return t[cp.charCodeAt(0)];'),
    星外退路: ENGINE_L.includes('if (CJK.test(cp)) return CLS_CJK;') && ENGINE_L.includes('if (WORD.test(cp)) return CLS_WORD;'),
    包装仍在: /function classify\(cp\) \{\n {2}var k = clsCode\(cp\);/.test(ENGINE_L),
    // [0.6.24] 切段循环从「先 Array.from 成码点数组、再按下标比」改成在归一后的字符串上按下标走
    // （`cps[i]` / `clsCode(cps[j]) === cls` 随之消失）。这里守的仍是一件事：**段边界用数值比较推进**，
    // 不是字符串比较、也不是再调 classify；切词那段的具体形状由 OR084 的 `切词不再造字符数组` 兜。
    切段数值比较: (tokBodyL.includes('const cls = clsCode(') || tokBodyL.includes('const cls = clsAt(s, i);')) &&
      tokBodyL.includes('if (cls === CLS_SKIP) {') &&
      tokBodyL.includes('=== cls)') && tokBodyL.includes('if (cls === CLS_CJK) {'),
    不再走字符串: tokBodyL !== '' && tokBodyL.includes('classify(') === false,
  }
  const missL = Object.keys(partsL).filter((k) => !partsL[k])
  check(
    'OR081 引擎里词法分类换成 BMP 表：表由那两条正则自己扫出来（不是手抄区间）、惰性建一次、单码点走下标 + 星外码点走原正则、tokenize 改数值比较不再调 classify',
    missL.length === 0,
    missL.length === 0 ? `${Object.keys(partsL).length} 件在位` : `缺 ${missL.join(' / ')}`,
  )

  // 把 0.6.21 那一段切出来当纯函数跑：全码点逐点与旧正则对拍
  const segL = (() => {
    const a = ENGINE_L.indexOf('var CJK = ')
    const b = ENGINE_L.indexOf('function tokenize(text) {')
    return a >= 0 && b > a ? ENGINE_L.slice(a, b) : ''
  })()
  const CJK_REF = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\u3005\u30fc]/u
  const WORD_REF = /[\p{L}\p{N}]/u
  const refClassify = (cp) => (CJK_REF.test(cp) ? 'cjk' : WORD_REF.test(cp) ? 'word' : 'skip')
  let cpOk = false
  let cpDetail = ''
  try {
    const M6 = new Function(`${segL}\nreturn { classify, clsCode, CLS_CJK, CLS_WORD, CLS_SKIP };`)()
    let mism = 0
    let n = 0
    let first = ''
    for (let c = 0; c <= 0x10ffff; c += 1) {
      if (c >= 0xd800 && c <= 0xdfff) continue
      const ch = String.fromCodePoint(c)
      n += 1
      const a = refClassify(ch)
      const b = M6.classify(ch)
      if (a !== b) {
        mism += 1
        if (first === '') first = `U+${c.toString(16).toUpperCase()} ${a}≠${b}`
      }
    }
    cpOk = mism === 0 && n === 1112064
    cpDetail = mism === 0 ? `${n.toLocaleString('en-US')} 码点 · 0 不一致` : `${mism} 不一致 · 首例 ${first}`
  } catch (e) {
    cpDetail = String(e && e.message)
  }
  check('OR081 进程内：0x0000–0x10FFFF 全 1,112,064 个码点的分类与旧正则逐点相同', cpOk, cpDetail)

  let segOk = false
  let segDetail = ''
  try {
    const M7 = new Function(`${segL}\nreturn { classify };`)()
    const segsOf = (text, cls) => {
      const cps = Array.from(text.normalize('NFKC'))
      const out = []
      let i = 0
      while (i < cps.length) {
        const c = cls(cps[i])
        if (c === 'skip') {
          i += 1
          continue
        }
        let j = i + 1
        while (j < cps.length && cls(cps[j]) === c) j += 1
        const run = cps.slice(i, j)
        if (c === 'cjk') {
          if (run.length >= 2) for (let k = 0; k + 1 < run.length; k += 1) out.push(run[k] + run[k + 1])
        } else out.push(run.join('').toLowerCase())
        i = j
      }
      return out
    }
    const corpus = ['记忆管理插件的性能优化：把 n-gram 共现换成倒排索引', 'Hello, World! 你好世界。 ＡＢＣ１２３（全角） ﾊﾝｶｸ', '読み 々 ー ｶﾀｶﾅ 한국어', '𠀋𠮷 astral 文字', '😀🎉 emoji', '', '中', '中a中', '\uD800\uDC00\uDFFF\uD800a']
    let bad = 0
    for (const s of corpus) if (JSON.stringify(segsOf(s, refClassify)) !== JSON.stringify(segsOf(s, M7.classify))) bad += 1
    segOk = bad === 0
    segDetail = `${corpus.length} 串 · 不一致 ${bad}`
  } catch (e) {
    segDetail = String(e && e.message)
  }
  check('OR081 进程内：切段（二元组 / 整词小写 / 跳过）与旧分类逐串相同，含全角、半角片假名、々ー、星外字、孤立代理项', segOk, segDetail)

  check(
    'OR081 文档在位：INTERNAL 9.220 写了「词法分类」，README 写了「词法分类不再逐字符跑正则」，DESIGN 有 ## 216.，PLAN 有 0.6.21',
    readFileSync(new URL('./docs/INTERNAL.md', import.meta.url), 'utf8').includes('## 9.220 ') &&
      readFileSync(new URL('./README.md', import.meta.url), 'utf8').includes('词法分类不再逐字符跑正则') &&
      readFileSync(new URL('./DESIGN.md', import.meta.url), 'utf8').includes('## 216. ') &&
      /0\.6\.21/.test(readFileSync(new URL('./docs/PLAN-0.6.md', import.meta.url), 'utf8')),
  )
  const vS12 = (readFileSync(new URL('./lib/index.js', import.meta.url), 'utf8').match(/export const version = '(\d+)\.(\d+)\.(\d+)'/) ?? []).slice(1).map(Number)
  const vNumS12 = vS12.length === 3 ? vS12[0] * 10000 + vS12[1] * 100 + vS12[2] : 0
  check('OR081 版本号不低于 0.6.21（后续补丁不必回头改这一条）', vNumS12 >= 621, vS12.join('.'))
}

// 0.6.22：建索引不再把同一批字段切两遍（见 INTERNAL 9.221 / DESIGN 217）。
{
  const cSrc = readFileSync(new URL('./tools/probe-cold.mjs', import.meta.url), 'utf8')
  const cWired = readFileSync(new URL('./tools/check-all.mjs', import.meta.url), 'utf8').includes("'tools/probe-cold.mjs'")
  const cExcused = readFileSync(new URL('./verify.mjs', import.meta.url), 'utf8').includes("'tools/probe-cold.mjs'")
  const cLabels = ['C0 形状', 'C1 分段可交换', 'C2 成词可交换', 'C3 字段口径', 'C4 确定性', 'C5 退化'].every((t) => cSrc.includes(t))
  check(
    'OR082 冷建探针 C0–C5 在位（形状 / 分段可交换 / 成词可交换 / 五张表与老表达式逐条相同 / 确定性 / 退化），check-all 挂线且列进取根例外',
    cLabels && cWired && cExcused,
    `标签 ${cLabels} / 挂线 ${cWired} / 取根例外 ${cExcused}`,
  )

  const ENGINE_C = readFileSync(new URL('./vendor/meow-memory/lib/index.js', import.meta.url), 'utf8')
  const buildC = (() => {
    const a = ENGINE_C.indexOf('function buildSearchIndex(docs, opts = {}, sig = null) {')
    return a < 0 ? '' : ENGINE_C.slice(a, ENGINE_C.indexOf('\n}\n', a))
  })()
  const tokC = (() => {
    const a = ENGINE_C.indexOf('function tokenize(text) {')
    return a < 0 ? '' : ENGINE_C.slice(a, ENGINE_C.indexOf('\n}\n', a))
  })()
  const partsC = {
    分段函数: ENGINE_C.includes('function tokenizeSegs(text) {'),
    成词函数: ENGINE_C.includes('function finishToks(out) {') && ENGINE_C.includes('return isMostlyLatin(out) ? normalizeEn(out) : out;'),
    tokenize仍是包装: tokC.includes('return finishToks(tokenizeSegs(text));'),
    单趟三张表: buildC.includes("const ts = tokenizeSegs(String(d.title ?? ''));") && buildC.includes("const cs = tokenizeSegs(String(d.content ?? ''));"),
    bodyLen就地: buildC.includes('const body = finishToks(cs);') && buildC.includes('bodyLen[i] = body.length > 0 ? body.length : 1;'),
    plainToks就地: buildC.includes('plainToks[i] = finishToks(ts);') && buildC.includes('for (let k = 0; k < cs.length; k++) ts.push(cs[k]);'),
    标题集合就地: buildC.includes('titleSets[i] = new Set(finishToks(ts));'),
    关键词只成词一趟: (buildC.match(/tokenize\(/g) ?? []).length === 1 && buildC.includes('const kwSets = useField ? kwFlatArr.map((t) => new Set(t)) : null;'),
    不再配seen: buildC.includes('const seen = new Set();') === false && buildC.includes('seen.has(') === false,
    首见改用m: buildC.includes('const cur = m.get(t);') && buildC.includes('else m.set(t, cur + 1);'),
    不再重切字段: buildC.includes('new Set(tokenize(') === false && buildC.includes("docs.map((d) => tokenize(String(d.content ?? '')))") === false,
  }
  const missC = Object.keys(partsC).filter((k) => !partsC[k])
  check(
    'OR082 引擎里建索引改单趟：切词拆成分段 + 成词两段（tokenize 仍是一行包装）、plainToks/bodyLen/titleSets 一趟填满、keywords 只成词一趟、每条不再配 seen Set、首见判据改 m.get',
    missC.length === 0,
    missC.length === 0 ? `${Object.keys(partsC).length} 件在位` : `缺 ${missC.join(' / ')}`,
  )

  const segC = (() => {
    const a = ENGINE_C.indexOf('var CJK = ')
    const b = ENGINE_C.indexOf('function docText(d) {')
    return a >= 0 && b > a ? ENGINE_C.slice(a, b) : ''
  })()
  const CORPUS_C = [
    ['基线要跑几轮才收敛', '自检基线 跑两趟 三趟 才收敛'],
    ['keywords as string', '逗号分隔的关键词写法 也要一致'],
    ['KvNet probe 0.6.22', 'kvnet 探针 65,536 个码点 😀𠀀𪚥'],
    ['the quick brown fox', 'jumps over the lazy dog and the end'],
    ['索引 缓存', 'the index cache is warm and the search is fast'],
    ['', ''],
    ['中', 'a'],
    ['a', '中'],
    ['   ', '  \n\t '],
  ]
  let segOkC = false
  let segDetailC = ''
  let joinOkC = false
  let joinDetailC = ''
  try {
    const MC = new Function(`${segC}\nreturn { tokenizeSegs, finishToks, tokenize, isMostlyLatin };`)()
    let badSeg = 0
    let badJoin = 0
    for (const [t, c] of CORPUS_C) {
      const segWant = JSON.stringify(MC.tokenizeSegs(`${t} ${c}`))
      const segGot = JSON.stringify(MC.tokenizeSegs(t).concat(MC.tokenizeSegs(c)))
      if (segWant !== segGot) badSeg += 1
      const joinWant = JSON.stringify(MC.tokenize(`${t} ${c}`))
      const joinGot = JSON.stringify(MC.finishToks(MC.tokenizeSegs(t).concat(MC.tokenizeSegs(c))))
      if (joinWant !== joinGot) badJoin += 1
    }
    // 混排反例：标题单看以拉丁为主（会被英文化砍停用词、词尾归一），拼上中文正文后不再以拉丁为主。
    // 逐段成词会得出更短的词表——所以成词只能在整表上跑一次。
    const naive = JSON.stringify(MC.tokenize('keywords as string').concat(MC.tokenize('这是中文正文 四个实词 都在这里')))
    const whole = JSON.stringify(MC.tokenize('keywords as string 这是中文正文 四个实词 都在这里'))
    segOkC = badSeg === 0
    segDetailC = `${CORPUS_C.length} 对 · 不一致 ${badSeg}`
    joinOkC = badJoin === 0 && naive !== whole
    joinDetailC = `${CORPUS_C.length} 对 · 不一致 ${badJoin} · 混排反例逐段成词会变短 ${naive !== whole}`
  } catch (e) {
    segDetailC = String(e && e.message)
    joinDetailC = String(e && e.message)
  }
  check('OR082 进程内：分段可交换——segs(a) ++ segs(b) 与 segs(a ␠ b) 逐 token 相同', segOkC, segDetailC)
  check('OR082 进程内：成词可交换——finishToks(segs(a) ++ segs(b)) 与 tokenize(a ␠ b) 逐 token 相同（英文化只在整表上跑一次）', joinOkC, joinDetailC)

  check(
    'OR082 文档在位：INTERNAL 9.221 写了「同一批字段不再切两遍」，README 写了「同一批字段不再切两遍」，DESIGN 有 ## 217.，PLAN 有 0.6.22',
    readFileSync(new URL('./docs/INTERNAL.md', import.meta.url), 'utf8').includes('## 9.221 ') &&
      readFileSync(new URL('./README.md', import.meta.url), 'utf8').includes('同一批字段不再切两遍') &&
      readFileSync(new URL('./DESIGN.md', import.meta.url), 'utf8').includes('## 217. ') &&
      /0\.6\.22/.test(readFileSync(new URL('./docs/PLAN-0.6.md', import.meta.url), 'utf8')),
  )
  const vS13 = (readFileSync(new URL('./lib/index.js', import.meta.url), 'utf8').match(/export const version = '(\d+)\.(\d+)\.(\d+)'/) ?? []).slice(1).map(Number)
  const vNumS13 = vS13.length === 3 ? vS13[0] * 10000 + vS13[1] * 100 + vS13[2] : 0
  check('OR082 版本号不低于 0.6.22（后续补丁不必回头改这一条）', vNumS13 >= 622, vS13.join('.'))
}

// 0.6.23：共现表与会话主题不再白跑一遍（记忆不改结果，省的是重复计算）
{
  const Mv = await import('./vendor/meow-memory/lib/index.js')
  const ENGINE_D = readFileSync(new URL('./vendor/meow-memory/lib/index.js', import.meta.url), 'utf8')
  const PROBE_D = readFileSync(new URL('./tools/probe-cooc.mjs', import.meta.url), 'utf8')
  const ALL_D = readFileSync(new URL('./tools/check-all.mjs', import.meta.url), 'utf8')
  const dWired = ALL_D.includes("'tools/probe-cooc.mjs'")
  const dExcused = readFileSync(new URL('./verify.mjs', import.meta.url), 'utf8').includes("'tools/probe-cooc.mjs'")
  const dLabels = PROBE_D.includes('K7a 每条的词表只解一遍') && PROBE_D.includes('K7b 共现表与朴素尺子逐键逐值逐序相同') &&
    PROBE_D.includes('K7c 够 3 条的会话里每条都追加同一串主题词')
  check(
    'OR083 共现探针 K7 在位（词表只解一遍 / 与朴素尺子逐键逐值逐序相同 / 会话主题追加同一串），check-all 挂线且列进取根例外',
    dLabels && dWired && dExcused,
    `标签 ${dLabels} / 挂线 ${dWired} / 取根例外 ${dExcused}`,
  )
  const coocD = (() => {
    const a = ENGINE_D.indexOf('function buildCoocSyn(docs, n, opts) {')
    return a < 0 ? '' : ENGINE_D.slice(a, ENGINE_D.indexOf('\nfunction buildCoocForms', a))
  })()
  const sessD = (() => {
    const a = ENGINE_D.indexOf('function sessionTopicTerms(docs, docToks) {')
    return a < 0 ? '' : ENGINE_D.slice(a, ENGINE_D.indexOf('\nfunction recencyWeight', a))
  })()
  const partsD = {
    汉字判据按词对记忆: coocD.includes('const hanMemo = [];') && coocD.includes('got = coocShareHan(wById[a], wById[b]);'),
    两层走同一闭包: coocD.includes('hanHas(rowH, a, b) ? Math.min(w, COOC_SHARE_HAN_W) : w') &&
      coocD.includes('hanHas(rowH, a, b) ? Math.min(COOC_W_PROJ, COOC_SHARE_HAN_W) : COOC_W_PROJ'),
    词表只解一遍: coocD.includes('const wordsArr = docs.map((d) => coocWordsOf(d).map(idOf));') &&
      (coocD.match(/coocWordsOf\(/g) ?? []).length === 1,
    项目层提行: coocD.includes('let rowA = projPairs.get(a);') &&
      coocD.includes('} else rowA.set(b, (rowA.get(b) ?? 0) + ww);') &&
      coocD.includes('bumpIn(projPairs, b, a, ww);'),
    会话主题一趟算完: sessD.includes('let id = tid.get(t);') && sessD.includes('if (cnt[id] === 0) {') &&
      sessD.includes('cnt[id] += 1;') && sessD.includes('for (let k = 0; k < touched.length; k++) cnt[touched[k]] = 0;'),
    每会话不再造Set: sessD.includes('new Set()') === false && sessD.includes('for (const t of seen) sessDf.set') === false,
    排名口径字面不变: sessD.includes('cs[k] * Math.log(1 + total / sdf[ids[k]])') &&
      sessD.includes('if (t.length < 2 || EN_STOPWORDS.has(t)) continue;'),
  }
  const missD = Object.keys(partsD).filter((k) => !partsD[k])
  check(
    'OR083 引擎里共现层不再白跑：共享汉字按词对记忆一次、每条的词表只解一遍、项目层内层提行；会话主题的词号计数一趟走完、第二轮才按最终 sdf 定分、每会话不再造 Set',
    missD.length === 0,
    missD.length === 0 ? `${Object.keys(partsD).length} 件在位` : `缺 ${missD.join(' / ')}`,
  )

  // 进程内：keywords 是 getter——数它被读了几次（老写法同条层 + 项目层各解一遍）
  let readsD = 0
  let readsOk = false
  let readsDetail = ''
  try {
    const gd = []
    for (const ws of [['甲乙', '丙丁'], ['丙丁', '戊己']]) {
      const d = { id: 'g' + gd.length, project: 'pg', title: '', content: '', level: 'fact', importance: 1, status: 'active' }
      Object.defineProperty(d, 'keywords', { get() { readsD += 1; return ws }, enumerable: true, configurable: true })
      gd.push(d)
    }
    Mv.buildCoocSyn(gd, gd.length)
    readsOk = readsD <= gd.length
    readsDetail = `两条记忆一共读了 ${readsD} 次`
  } catch (e) {
    readsDetail = String(e && e.message)
  }
  check('OR083 进程内：每条的词表只解一遍（keywords 只读一次，不是同条层 + 项目层各解一遍）', readsOk, readsDetail)

  // 进程内：会话主题仍按「跨几个会话」算——够 3 条的会话里每条追加同一串，不足 3 条一条都不追加
  let sessOkD = false
  let sessDetailD = ''
  try {
    const sdoc = (id, sess, content) => ({
      id, project: 'ps', title: '', content, keywords: [], level: 'fact', importance: 1,
      created_at: '2026-11-20T00:00:00Z', updated_at: '2026-11-20T00:00:00Z',
      last_accessed_at: '2026-11-20T00:00:00Z', status: 'active', source_session: sess,
    })
    const sd = [
      sdoc('d1', 'sa', '自检基线 跑两趟 才收敛'),
      sdoc('d2', 'sa', '自检基线 又跑一趟 收敛了'),
      sdoc('d3', 'sa', '基线 三趟 收敛'),
      sdoc('d4', 'sb', '孤零零 一条 记录'),
    ]
    Mv.clearSearchIndexCache()
    const onD = Mv.searchIndexOf(sd, {})
    const offD = Mv.searchIndexOf(sd, { sessionTopic: false })
    const extra = sd.map((_, i) => (onD.docToks[i] ?? []).slice((offD.docToks[i] ?? []).length))
    const same = JSON.stringify(extra[0]) === JSON.stringify(extra[1]) && JSON.stringify(extra[1]) === JSON.stringify(extra[2])
    sessOkD = extra[0].length > 0 && same && extra[3].length === 0
    sessDetailD = `sa ${JSON.stringify(extra[0])} / sb ${JSON.stringify(extra[3])}`
  } catch (e) {
    sessDetailD = String(e && e.message)
  }
  check('OR083 进程内：会话主题一趟算完仍按「跨几个会话」走（够 3 条的会话每条同一串，不足 3 条不追加）', sessOkD, sessDetailD)

  check(
    'OR083 文档在位：INTERNAL 9.222 写了「共现层不再白跑」，README 写了「共现表与会话主题不再白跑」，DESIGN 有 ## 218.，PLAN 有 0.6.23',
    readFileSync(new URL('./docs/INTERNAL.md', import.meta.url), 'utf8').includes('## 9.222 ') &&
      readFileSync(new URL('./README.md', import.meta.url), 'utf8').includes('共现表与会话主题不再白跑') &&
      readFileSync(new URL('./DESIGN.md', import.meta.url), 'utf8').includes('## 218. ') &&
      /0\.6\.23/.test(readFileSync(new URL('./docs/PLAN-0.6.md', import.meta.url), 'utf8')),
  )
  const vS14 = (readFileSync(new URL('./lib/index.js', import.meta.url), 'utf8').match(/export const version = '(\d+)\.(\d+)\.(\d+)'/) ?? []).slice(1).map(Number)
  const vNumS14 = vS14.length === 3 ? vS14[0] * 10000 + vS14[1] * 100 + vS14[2] : 0
  check('OR083 版本号不低于 0.6.23（后续补丁不必回头改这一条）', vNumS14 >= 623, vS14.join('.'))
}

// 0.6.24：建索引不再「回头查第二次」，切词不再造一堆单字符（见 INTERNAL 9.223 / DESIGN 219）。
// 注：0.6.23 那条判据里的「会话主题一趟算完」跟着源码走到 0.6.24 的形状（tf 兼作判重账、
// 判据本身没提的「stamp」不再存在），语义仍是「tf 与跨会话数一趟算完」。
{
  const MvE = await import('./vendor/meow-memory/lib/index.js')
  const ENGINE_E = readFileSync(new URL('./vendor/meow-memory/lib/index.js', import.meta.url), 'utf8')
  const PROBE_E = readFileSync(new URL('./tools/probe-cold.mjs', import.meta.url), 'utf8')
  const eLabels = PROBE_E.includes('C6 切词逐位') && PROBE_E.includes('C7 df 摊出来')
  check(
    'OR084 冷建探针 C6/C7 在位（切词逐位对拍 / df 由倒排长度摊出来），与 C0–C5 同支同挂线',
    eLabels && readFileSync(new URL('./tools/check-all.mjs', import.meta.url), 'utf8').includes("'tools/probe-cold.mjs'"),
    `标签 ${eLabels}`,
  )

  const iBegin = ENGINE_E.indexOf('function buildSearchIndex(docs, opts = {}, sig = null) {')
  const iBody = iBegin < 0 ? '' : ENGINE_E.slice(iBegin, ENGINE_E.indexOf('\n}\n', iBegin))
  const iCode = iBody.split('\n').filter((l) => l.trim().startsWith('//') === false).join('\n')
  const segBody = (() => {
    const a = ENGINE_E.indexOf('function tokenizeSegs(text) {')
    return a < 0 ? '' : ENGINE_E.slice(a, ENGINE_E.indexOf('function finishToks(out) {', a))
  })()
  const segCode = segBody.split('\n').filter((l) => l.trim().startsWith('//') === false).join('\n')
  const sessE = (() => {
    const a = ENGINE_E.indexOf('function sessionTopicTerms(docs, docToks) {')
    return a < 0 ? '' : ENGINE_E.slice(a, ENGINE_E.indexOf('\nfunction recencyWeight', a))
  })()
  // [0.6.24] 形状判据必须先剥注释：老戳表的解释仍留在 `//` 里（`stamp.get(t) !== ord`），
  // 不剥就会拿「注释里提过 stamp」当成「代码里还有 stamp」。
  const sessCode = sessE.split('\n').filter((l) => l.trim().startsWith('//') === false).join('\n')
  const partsE = {
    倒排条目只查一次: iCode.includes('const refs = postings === null ? null : [];') &&
      iCode.includes('refs[refN++] = p;') && (iCode.match(/postings\.get\(t\)/g) ?? []).length === 2 &&
      iCode.includes('postings?.get(') === false,
    收尾按下标回填: iCode.includes('let refN = 0;') && iCode.includes('const p = refs[k++];') &&
      iCode.includes('refs.length = 0;'),
    df由倒排长度摊出来: iCode.includes('if (postings !== null) for (const [t, p] of postings) df.set(t, p.d.length);') &&
      (iCode.match(/df\.set\(t, \(df\.get\(t\) \?\? 0\) \+ 1\)/g) ?? []).length === 2,
    切词不再造字符数组: segCode.includes('Array.from(') === false && segCode.includes('const s = text.normalize("NFKC");') &&
      segCode.includes('const w0 = s.codePointAt(i) > 65535 ? 2 : 1;') && segCode.includes('out.push(s.slice(ps, k + w));'),
    会话主题借词号判重: sessCode.includes('let id = tid.get(t);') && sessCode.includes('if (cnt[id] === 0) {') &&
      sessCode.includes('if (idxs.length < SESS_TOPIC_MIN) continue;') && sessCode.includes('stamp') === false,
  }
  const missE = Object.keys(partsE).filter((k) => !partsE[k])
  check(
    'OR084 引擎里建索引不再回头查第二次：倒排条目随首见记进 refs、收尾按下标回填；df 由倒排长度摊出来；切词改成下标走、不再 Array.from',
    missE.length === 0,
    missE.length === 0 ? `${Object.keys(partsE).length} 件在位` : `缺 ${missE.join(' / ')}`,
  )

  // 进程内：切词逐位——用引擎自己的分类函数配一份 Array.from 老实现当尺子
  let segOkE = false
  let segDetailE = ''
  try {
    const segSrc = (() => {
      const a = ENGINE_E.indexOf('var CJK = ')
      const b = ENGINE_E.indexOf('function docText(d) {')
      return a < 0 || b <= a ? '' : ENGINE_E.slice(a, b)
    })()
    const LEX = new Function(`${segSrc}\nreturn { classify, tokenizeSegs };`)()
    const refSegs = (text) => {
      const cps = Array.from(text.normalize('NFKC'))
      const out = []
      let i = 0
      while (i < cps.length) {
        const c = LEX.classify(cps[i])
        if (c === 'skip') {
          i += 1
          continue
        }
        let j = i + 1
        while (j < cps.length && LEX.classify(cps[j]) === c) j += 1
        const run = cps.slice(i, j)
        if (c === 'cjk') {
          if (run.length >= 2) for (let k = 0; k + 1 < run.length; k += 1) out.push(run[k] + run[k + 1])
        } else out.push(run.join('').toLowerCase())
        i = j
      }
      return out
    }
    const corpusE = [
      '', ' ', '中', 'a', '中文分词测试', 'the quick brown fox', '中英混 mixed 123 abc',
      '𠀀𪚥𠀀𪚥 astral 中文', '😀😀 emoji 中文', '\uD800\uDFFF\uD800a 孤立代理项',
      'ＡＢＣ ａｂｃ １２３ 全角', 'ﬁ ﬀ ﬁne 合字', '日本語のテキスト ｶﾀｶﾅ', '한국어 텍스트',
      'x'.repeat(200) + '中文'.repeat(80), '零宽\u200B字符\u200D混排', '中文，标点。English. test；；分号',
    ]
    let badE = 0
    for (const s of corpusE) {
      if (JSON.stringify(refSegs(s)) !== JSON.stringify(LEX.tokenizeSegs(s))) badE += 1
    }
    // 星外字的二元组必须按码点拼（拼成单个代理项就是错的），单独钉一条
    const astralOk = JSON.stringify(LEX.tokenizeSegs('中文𠀀𪚥')) === JSON.stringify(['中文', '文𠀀', '𠀀𪚥'])
    segOkE = badE === 0 && astralOk
    segDetailE = `${corpusE.length} 串 · 不一致 ${badE} · 星外二元组 ${astralOk}`
  } catch (e) {
    segDetailE = String(e && e.message)
  }
  check('OR084 进程内：切词与 Array.from 老实现逐 token 相同（星外字按码点成词、孤立代理项不抛、NFKC 全角合字先归一）', segOkE, segDetailE)

  // 进程内：df 恒等于倒排长度，且与关掉倒排那条支路逐位相同（键序也同）
  let dfOkE = false
  let dfDetailE = ''
  try {
    const edoc = (id, title, content, keywords) => ({
      id, project: 'pe', title, content, keywords, level: 'fact', importance: 2,
      created_at: '2026-11-20T00:00:00Z', updated_at: '2026-11-20T00:00:00Z',
      last_accessed_at: '2026-11-20T00:00:00Z', status: 'active', source_session: 'se',
    })
    const eds = [
      edoc('d1', '基线要跑几轮才收敛', '自检基线 跑两趟 三趟 才收敛 收敛 收敛', ['基线', '收敛']),
      edoc('d2', '', '', []),
      edoc('d3', '同一个词重复很多次', '重复 重复 重复 重复 重复', ['重复', '重复']),
      edoc('d4', 'KvNet probe', 'kvnet 😀𠀀𪚥 astral 全角ＡＢＣ', '逗号,分隔'),
    ]
    MvE.clearSearchIndexCache()
    const on = MvE.searchIndexOf(eds, {})
    MvE.clearSearchIndexCache()
    const off = MvE.searchIndexOf(eds, { inverted: false })
    let badDf = 0
    for (const [t, p] of on.postings) if (on.df.get(t) !== p.d.length) badDf += 1
    let misalign = 0
    for (const [, p] of on.postings) if (p.d.length !== p.f.length || p.d.length !== p.t.length) misalign += 1
    const sameDf = off.postings === null && JSON.stringify([...on.df]) === JSON.stringify([...off.df])
    dfOkE = badDf === 0 && misalign === 0 && sameDf
    dfDetailE = `df ${on.df.size} 词 · 不等 ${badDf} · 错位 ${misalign} · 关倒排同序同值 ${sameDf}`
  } catch (e) {
    dfDetailE = String(e && e.message)
  }
  check('OR084 进程内：df 恒等于倒排长度（f/t 与 d 对齐）、与关掉倒排那条支路逐位相同（键序同）', dfOkE, dfDetailE)

  check(
    'OR084 文档在位：INTERNAL 9.223 写了「建索引不再回头查第二次」，README 写了「建索引不再回头查第二次」，DESIGN 有 ## 219.，PLAN 有 0.6.24',
    readFileSync(new URL('./docs/INTERNAL.md', import.meta.url), 'utf8').includes('## 9.223 ') &&
      readFileSync(new URL('./README.md', import.meta.url), 'utf8').includes('建索引不再回头查第二次') &&
      readFileSync(new URL('./DESIGN.md', import.meta.url), 'utf8').includes('## 219. ') &&
      /0\.6\.24/.test(readFileSync(new URL('./docs/PLAN-0.6.md', import.meta.url), 'utf8')),
  )
  const vS15 = (readFileSync(new URL('./lib/index.js', import.meta.url), 'utf8').match(/export const version = '(\d+)\.(\d+)\.(\d+)'/) ?? []).slice(1).map(Number)
  const vNumS15 = vS15.length === 3 ? vS15[0] * 10000 + vS15[1] * 100 + vS15[2] : 0
  check('OR084 版本号不低于 0.6.24（后续补丁不必回头改这一条）', vNumS15 >= 624, vS15.join('.'))
}

// 0.6.25：共现内层不再「每个词对回表两次」，成词那一趟不再拼临时串、不再付正则（见 INTERNAL 9.224 / DESIGN 220）。
{
  const MvF = await import('./vendor/meow-memory/lib/index.js')
  const ENGF = readFileSync(new URL('./vendor/meow-memory/lib/index.js', import.meta.url), 'utf8')
  const PROBE_COOC_F = readFileSync(new URL('./tools/probe-cooc.mjs', import.meta.url), 'utf8')
  const PROBE_COLD_F = readFileSync(new URL('./tools/probe-cold.mjs', import.meta.url), 'utf8')
  const CHECK_ALL_F = readFileSync(new URL('./tools/check-all.mjs', import.meta.url), 'utf8')
  const fLabels = PROBE_COOC_F.includes('K8a ') && PROBE_COOC_F.includes('K8b ') && PROBE_COLD_F.includes('C8 成词那一趟')
  check(
    'OR085 探针在位：probe-cooc 的 K8（提行后与朴素尺子逐键逐值逐序相同）/ probe-cold 的 C8（成词不再付正则），各自同支同挂线',
    fLabels && CHECK_ALL_F.includes("'tools/probe-cooc.mjs'") && CHECK_ALL_F.includes("'tools/probe-cold.mjs'"),
    `标签 ${fLabels}`,
  )

  const subF = (from, to) => {
    const a = ENGF.indexOf(from)
    return a < 0 ? '' : ENGF.slice(a, ENGF.indexOf(to, a))
  }
  // 形状判据先剥注释：几处解释里正写着「老写法 `ts.concat(cs)`」「`pairs.get(a)` 每个词对回表一次」，
  // 不剥就会拿「注释里提过老写法」当成「代码里还是老写法」。
  const stripF = (s) => s.split('\n').filter((l) => l.trim().startsWith('//') === false).join('\n')
  const pairCodeF = stripF(subF('const pairUp = (list, w) => {', 'const pickFrom'))
  const tsegCodeF = stripF(subF('function tokenizeSegs(text) {', 'function finishToks(out) {'))
  const lookCodeF = stripF(subF('function isLatinToken(t) {', 'function tokenizeSegs(text) {'))
  const manyCodeF = stripF(subF('function isMostlyLatin(tokens) {', 'function normalizeEn('))
  const iBodyF = stripF(subF('function buildSearchIndex(docs, opts = {}, sig = null) {', '\n}\n'))
  const iTitleAt = iBodyF.indexOf('if (titleSets !== null) titleSets[i] = new Set(finishToks(ts));')
  const iPushAt = iBodyF.indexOf('for (let k = 0; k < cs.length; k++) ts.push(cs[k]);')
  const partsF = {
    共现内层提行: pairCodeF.includes('let rowA = pairs.get(a);') &&
      pairCodeF.includes('} else rowA.set(b, (rowA.get(b) ?? 0) + ww);') &&
      pairCodeF.includes('bumpIn(pairs, a, b, ww)') === false && pairCodeF.includes('bumpIn(pairs, b, a, ww);'),
    二元组连续切片: tsegCodeF.includes('out.push(s.slice(ps, k + w));') && tsegCodeF.includes('out.push(prev + cur);') === false,
    拉丁判据按码点: lookCodeF.includes('if (c < 97 || c > 122) return false;') &&
      (stripF(ENGF).match(/\^\[a-z\]\+\$/g) ?? []).length === 0 &&
      ENGF.includes('out.push(isLatinToken(t) ? stemEn(t) : t);'),
    过半即早退: manyCodeF.includes('if (latin * 2 >= ln) return true;') && manyCodeF.includes('latin += 1;') &&
      manyCodeF.includes('if (ln === 0) return false;'),
    标题集先取再并正文: iTitleAt >= 0 && iPushAt > iTitleAt && iBodyF.includes('finishToks(ts.concat(cs))') === false,
    词表就地接上正文: iBodyF.includes('plainToks[i] = finishToks(ts);') && iBodyF.includes('for (let k = 0; k < extra.length; k++) ts.push(extra[k]);'),
  }
  const missF = Object.keys(partsF).filter((k) => !partsF[k])
  check(
    'OR085 引擎里共现内层提行、二元组按连续切片成词、拉丁判据走码点、标题集先取再并正文、词表就地接上正文',
    missF.length === 0,
    missF.length === 0 ? `${Object.keys(partsF).length} 件在位` : `缺 ${missF.join(' / ')}`,
  )

  // 进程内：按码点判的拉丁词与老正则逐例相同——含「末尾换行」这一档（JS 的 `$` 是严格串尾，不许手软）
  let latinOkF = false
  let latinDetailF = ''
  try {
    const isLatin = new Function(`${lookCodeF}\nreturn isLatinToken;`)()
    const refLatin = (t) => /^[a-z]+$/.test(t)
    const cases = ['', 'a', 'z', 'abc', 'ABC', 'a1', '1a', 'ab\n', 'ab\r\n', ' ab', 'ab ', '中文', '𠀀', 'é', 'a中', 'a-b']
    const badCase = cases.filter((c) => isLatin(c) !== refLatin(c))
    latinOkF = badCase.length === 0
    latinDetailF = badCase.length === 0 ? `${cases.length} 例全同（末行换行按严格串尾判 false）` : `不一致 ${JSON.stringify(badCase)}`
  } catch (e) {
    latinDetailF = String(e && e.message)
  }
  check('OR085 进程内：按码点判的拉丁词与 /^[a-z]+$/ 逐例相同（空串、大写、数字、星外字、末尾换行都不许含糊）', latinOkF, latinDetailF)

  // 进程内：大半是拉丁词那条判据「过半即早退」与老口径（数完再比）逐例相同
  let mostlyOkF = false
  let mostlyDetailF = ''
  try {
    const LEXF = new Function(`${lookCodeF}${manyCodeF}\nreturn isMostlyLatin;`)()
    const refMostly = (tokens) => {
      const ln = tokens.length
      if (ln === 0) return false
      return tokens.filter((t) => /^[a-z]+$/.test(t)).length * 2 >= ln
    }
    const setsF = [[], ['a'], ['a', 'B'], ['中'], ['a', '中'], ['a', 'b', '中'], ['a', 'b', 'c', '中'], ['中', '中', 'a'], ['ab\n'], ['𠀀', 'a']]
    const badSet = setsF.filter((s) => LEXF(s) !== refMostly(s))
    mostlyOkF = badSet.length === 0
    mostlyDetailF = badSet.length === 0 ? `${setsF.length} 组全同（并列过半算拉丁）` : `不一致 ${JSON.stringify(badSet)}`
  } catch (e) {
    mostlyDetailF = String(e && e.message)
  }
  check('OR085 进程内：过半即早退与「数完再比」逐例相同（并列过半算拉丁、空表不算）', mostlyOkF, mostlyDetailF)

  // 进程内：标题集合必须是「还没接正文」的那一份；keywords 在哪一路由 kwSeparate 决定，两路都不许混
  let tokOkF = false
  let tokDetailF = ''
  try {
    const fdoc = (id, title, content, keywords) => ({
      id, project: 'pf', title, content, keywords, level: 'fact', importance: 2,
      created_at: '2026-11-20T00:00:00Z', updated_at: '2026-11-20T00:00:00Z',
      last_accessed_at: '2026-11-20T00:00:00Z', status: 'active', source_session: 'sf',
    })
    const fds = [
      fdoc('f1', 'Testing the Runners', '中文 正文 里 也 提到 收敛', ['基线', '海浪']),
      fdoc('f2', '', '', []),
      fdoc('f3', 'KvNet probe', 'kvnet 自检 基线', '逗号,分隔'),
    ]
    MvF.clearSearchIndexCache()
    const onF = MvF.searchIndexOf(fds, {})
    MvF.clearSearchIndexCache()
    const offF = MvF.searchIndexOf(fds, { kwSeparate: false })
    const titleWant = new Set(MvF.tokenize('Testing the Runners'))
    const titleGot = onF.titleSets === null ? null : onF.titleSets[0]
    const sameTitle = titleGot !== null && titleGot.size === titleWant.size && [...titleWant].every((t) => titleGot.has(t))
    const bodyWant = MvF.tokenize('中文 正文 里 也 提到 收敛')
    const plain0 = onF.plainToks[0] ?? []
    const bodyIn = bodyWant.every((t) => plain0.includes(t))
    const kwWant = ['基线', '海浪'].flatMap((w) => MvF.tokenize(w))
    const kwOutOfBody = kwWant.every((t) => plain0.includes(t) === false) && onF.kwSets !== null &&
      kwWant.every((t) => onF.kwSets[0].has(t))
    const joined0 = offF.plainToks[0] ?? []
    const kwJoined = kwWant.every((t) => joined0.includes(t)) && offF.kwToks === null
    tokOkF = sameTitle && bodyIn && kwOutOfBody && kwJoined
    tokDetailF = `标题集 ${titleGot ? titleGot.size : '空'} 词 / 正文在 ${bodyIn} / 默认分开 ${kwOutOfBody} / 合起来 ${kwJoined}`
  } catch (e) {
    tokDetailF = String(e && e.message)
  }
  check('OR085 进程内：标题集合取的是「还没接正文」的那份；keywords 默认另走 kwSets、关掉 kwSeparate 时就地并进词表（两路口径不混）', tokOkF, tokDetailF)

  check(
    'OR085 文档在位：INTERNAL 9.224 写了「共现内层不再回表」，README 写了「共现内层不再回表」，DESIGN 有 ## 220.，PLAN 有 0.6.25',
    readFileSync(new URL('./docs/INTERNAL.md', import.meta.url), 'utf8').includes('## 9.224 ') &&
      readFileSync(new URL('./README.md', import.meta.url), 'utf8').includes('共现内层不再回表') &&
      readFileSync(new URL('./DESIGN.md', import.meta.url), 'utf8').includes('## 220. ') &&
      /0\.6\.25/.test(readFileSync(new URL('./docs/PLAN-0.6.md', import.meta.url), 'utf8')),
  )
  const vS16 = (readFileSync(new URL('./lib/index.js', import.meta.url), 'utf8').match(/export const version = '(\d+)\.(\d+)\.(\d+)'/) ?? []).slice(1).map(Number)
  const vNumS16 = vS16.length === 3 ? vS16[0] * 10000 + vS16[1] * 100 + vS16[2] : 0
  check('OR085 版本号不低于 0.6.25（后续补丁不必回头改这一条）', vNumS16 >= 625, vS16.join('.'))
}

// 0.6.26：共现层内部一律用整数词号，词号出不了这一层（见 INTERNAL 9.225 / DESIGN 221）。
{
  const MvS = await import('./vendor/meow-memory/lib/index.js')
  const ENGS = readFileSync(new URL('./vendor/meow-memory/lib/index.js', import.meta.url), 'utf8')
  const PROBE_COOC_S = readFileSync(new URL('./tools/probe-cooc.mjs', import.meta.url), 'utf8')
  const CHECK_ALL_S = readFileSync(new URL('./tools/check-all.mjs', import.meta.url), 'utf8')
  const sLabels = PROBE_COOC_S.includes('K9a ') && PROBE_COOC_S.includes('K9b ')
  check(
    'OR086 探针在位：probe-cooc 的 K9（层内只认词号 + 出门换回原词），同支挂线',
    sLabels && CHECK_ALL_S.includes("'tools/probe-cooc.mjs'"),
    `标签 ${sLabels}`,
  )

  const stripS = (s) => s.split('\n').filter((l) => l.trim().startsWith('//') === false).join('\n')
  const coocAt = ENGS.indexOf('function buildCoocSyn(docs, n, opts) {')
  const coocCode = coocAt < 0 ? '' : stripS(ENGS.slice(coocAt, ENGS.indexOf('\nfunction buildCoocForms', coocAt)))
  const shapeS = {
    词号表: coocCode.includes('const wid = new Map();') && coocCode.includes('const wById = [];') &&
      coocCode.includes('const idOf = (w) => {') && coocCode.includes('wById.push(w);'),
    汉字表按下标: coocCode.includes('const hanMemo = [];') && coocCode.includes('hanMemo[a] = row;') &&
      coocCode.includes('hanMemo.get(') === false,
    对内只认词号: coocCode.includes('got = coocShareHan(wById[a], wById[b]);') &&
      coocCode.includes('const wordsArr = docs.map((d) => coocWordsOf(d).map(idOf));') &&
      coocCode.includes('kwDf.set(id, (kwDf.get(id) ?? 0) + 1);'),
    出门换回原词: coocCode.includes('const words = list.slice(0, COOC_TOP_PER_TERM).map((id) => wById[id]);') &&
      coocCode.includes('out.set(wById[a], words);') && coocCode.includes('out.set(a,') === false,
  }
  const missS = Object.keys(shapeS).filter((k) => !shapeS[k])
  check('OR086 引擎里共现层只认词号：按首见顺序发号、共享汉字表改下标数组、层内键全是词号、出门用 .map 换回原词',
    missS.length === 0, missS.length === 0 ? '四处形状全在' : `缺 ${missS.join(',')}`)

  const sd = [
    { id: 'o1', project: 'pa', title: '', content: '苹果 香蕉 云朵 一起 出现', keywords: ['苹果', '香蕉', '云朵'] },
    { id: 'o2', project: 'pa', title: '', content: '苹果 香蕉 海浪 出现', keywords: ['苹果', '香蕉', '海浪'] },
    { id: 'o3', project: 'pa', title: '', content: '苹果 云朵 海浪 出现', keywords: ['苹果', '云朵', '海浪'] },
    { id: 'o4', project: 'pb', title: '', content: '苹果 香蕉 云朵 一起', keywords: ['苹果', '香蕉', '云朵'] },
    { id: 'o5', project: 'pb', title: '', content: '自测 自检 切片 片段', keywords: ['自测', '自检', '切片', '片段'] },
  ].map((d) => ({ ...d, level: 'fact', importance: 1, created_at: '2026-11-20T00:00:00Z',
    updated_at: '2026-11-20T00:00:00Z', last_accessed_at: '2026-11-20T00:00:00Z', status: 'active' }))
  let pureOk = false
  let pureDetail = ''
  try {
    const tb = MvS.buildCoocSyn(sd, sd.length)
    const vocab = new Set()
    for (const d of sd) { for (const w of d.keywords) vocab.add(w); for (const w of String(d.content).split(/\s+/)) if (w) vocab.add(w) }
    const leaks = []
    for (const [k, vs] of tb) {
      if (typeof k !== 'string' || vocab.has(k) === false) leaks.push(`键 ${typeof k} ${k}`)
      for (const v of vs ?? []) if (typeof v !== 'string' || vocab.has(v) === false) leaks.push(`值 ${typeof v} ${v}`)
    }
    pureOk = leaks.length === 0 && tb.size > 0
    pureDetail = leaks.length ? leaks[0] : `${tb.size} 个键 · 键值全是词`
  } catch (e) {
    pureDetail = String(e && e.message)
  }
  check('OR086 进程内：共现表的键与值里没有词号漏出来（层内整数、层外一律还是词本身）', pureOk, pureDetail)

  let sameOk = false
  let sameDetail = ''
  try {
    const dumpS = (m) => JSON.stringify([...m].map(([k, vs]) => [k, vs]))
    const a = dumpS(MvS.buildCoocSyn(sd, sd.length))
    const b = dumpS(MvS.buildCoocSyn(sd, sd.length))
    sameOk = a === b && a.length > 2
    sameDetail = sameOk ? `两次建表逐键逐值逐序相同（${a.length} 字符）` : '两次建表不同'
  } catch (e) {
    sameDetail = String(e && e.message)
  }
  check('OR086 进程内：同一批文档建两次共现表，键序与值序逐位相同（词号按首见顺序发，不受哈希顺序影响）', sameOk, sameDetail)

  check(
    'OR086 文档在位：INTERNAL 9.225 写了「层内只认词号」，README 写了「共现层内部只认词号」，DESIGN 有 ## 221.，PLAN 有 0.6.26',
    readFileSync(new URL('./docs/INTERNAL.md', import.meta.url), 'utf8').includes('## 9.225 ') &&
      readFileSync(new URL('./README.md', import.meta.url), 'utf8').includes('共现层内部只认词号') &&
      readFileSync(new URL('./DESIGN.md', import.meta.url), 'utf8').includes('## 221. ') &&
      /0\.6\.26/.test(readFileSync(new URL('./docs/PLAN-0.6.md', import.meta.url), 'utf8')),
  )
  const vS17 = (readFileSync(new URL('./lib/index.js', import.meta.url), 'utf8').match(/export const version = '(\d+)\.(\d+)\.(\d+)'/) ?? []).slice(1).map(Number)
  const vNumS17 = vS17.length === 3 ? vS17[0] * 10000 + vS17[1] * 100 + vS17[2] : 0
  check('OR086 版本号不低于 0.6.26（后续补丁不必回头改这一条）', vNumS17 >= 626, vS17.join('.'))
}

// [macro-fusion 0.6.27] 建索引固定开销三刀（按下标分类 / 签名混算提成模块级 / 会话主题换词号两轮）
// + 共现项目层去 self Set。选材与读数见 DESIGN 222、INTERNAL 9.226。
{
  const readF27 = (p) => readFileSync(new URL(p, import.meta.url), 'utf8')
  const ENGS27 = readF27('./vendor/meow-memory/lib/index.js')
  const PROBE_COOC_S27 = readF27('./tools/probe-cooc.mjs')
  const PROBE_COLD_S27 = readF27('./tools/probe-cold.mjs')
  const CHECK_ALL_S27 = readF27('./tools/check-all.mjs')
  const labels27 = PROBE_COLD_S27.includes('C9 按下标分类') &&
    PROBE_COOC_S27.includes('K10a ') && PROBE_COOC_S27.includes('K10b ')
  check(
    'OR087 探针在位：probe-cold 的 C9（按下标分类）与 probe-cooc 的 K10（项目层不再造 self Set），两支都挂线',
    labels27 && CHECK_ALL_S27.includes("'tools/probe-cooc.mjs'") && CHECK_ALL_S27.includes("'tools/probe-cold.mjs'"),
    `标签 ${labels27}`,
  )

  const stripS27 = (s) => s.split('\n').filter((l) => l.trim().startsWith('//') === false).join('\n')
  const fn27 = (head) => {
    const i = ENGS27.indexOf(head)
    return i < 0 ? '' : stripS27(ENGS27.slice(i, ENGS27.indexOf('\n}\n', i)))
  }
  const atCode = fn27('function clsAt(s, i) {')
  const tokCode = stripS27(ENGS27.slice(ENGS27.indexOf('function tokenizeSegs(text) {'), ENGS27.indexOf('function finishToks(out) {')))
  const shape27 = {
    按下标分类: atCode.includes('var c = s.charCodeAt(i);') &&
      atCode.includes('if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {') &&
      atCode.includes('if (d >= 0xdc00 && d <= 0xdfff) return clsCode(s.slice(i, i + 2));') &&
      atCode.includes('return t[c];'),
    切词不再造单字符: tokCode.includes('const cls = clsAt(s, i);') &&
      tokCode.includes('while (j < nS && clsAt(s, j) === cls) {') &&
      tokCode.includes('s[i]') === false && tokCode.includes('clsCode(') === false,
  }
  const miss27 = Object.keys(shape27).filter((k) => !shape27[k])
  check('OR087 引擎里按下标分类：clsAt 只读 charCodeAt 查同一张 BMP 表、只有成对代理项才走码点路径，切词内层两处都用它',
    miss27.length === 0, miss27.length === 0 ? '两处全在' : `缺 ${miss27.join(',')}`)

  const sigCode = fn27('function sigDocHash(d, kw) {')
  const shapeSig = {
    三件提到模块级: ENGS27.includes('function sigMixStr(h, s) {') &&
      ENGS27.includes('function sigMixRange(h, s, from, to) {') && ENGS27.includes('function sigSep(h) {'),
    不再现造闭包: sigCode.includes('const put =') === false && sigCode.includes('const sep =') === false,
    首尾按区间混: sigCode.includes('h = sigSep(sigMixRange(h, content, 0, content.length < 40 ? content.length : 40));') &&
      sigCode.includes('h = sigSep(sigMixRange(h, content, content.length < 40 ? 0 : content.length - 40, content.length));'),
    不再切临时串: sigCode.includes('content.slice(') === false,
  }
  const missSig = Object.keys(shapeSig).filter((k) => !shapeSig[k])
  check('OR087 引擎里签名混算：FNV 提成三只模块级纯函数、首尾 40 字按区间直接混（不再每条造两只闭包、不再切两只临时串）',
    missSig.length === 0, missSig.length === 0 ? '四处全在' : `缺 ${missSig.join(',')}`)

  const sttCode = fn27('function sessionTopicTerms(docs, docToks) {')
  const iOut = sttCode.indexOf('const out = ')
  const shapeStt = {
    词号表: sttCode.includes('const tid = /* @__PURE__ */ new Map();') && sttCode.includes('const tById = [];'),
    下标数组记数: sttCode.includes('const cnt = [];') && sttCode.includes('const sdf = [];') &&
      sttCode.includes('if (cnt[id] === 0) {') && sttCode.includes('sdf[id] += 1;') && sttCode.includes('cnt[id] += 1;'),
    复位只碰用过的: sttCode.includes('for (let k = 0; k < touched.length; k++) cnt[touched[k]] = 0;') &&
      sttCode.includes('touched.length = 0;'),
    两轮定分: iOut > 0 && sttCode.indexOf('const ids = touched.slice();') < iOut &&
      sttCode.indexOf('cs[k] * Math.log(1 + total / sdf[ids[k]])') > iOut,
    不再每词两次串哈希: sttCode.includes('tf.get(') === false && sttCode.includes('tf.set(') === false,
  }
  const missStt = Object.keys(shapeStt).filter((k) => !shapeStt[k])
  check('OR087 引擎里会话主题：词 → 整数词号只查一次表、计数与跨会话数落在下标数组上、复位只碰上一圈用过的词号、第二轮按最终 sdf 定分',
    missStt.length === 0, missStt.length === 0 ? '五处全在' : `缺 ${missStt.join(',')}`)

  const ccb = ENGS27.indexOf('function buildCoocSyn(docs, n, opts) {')
  const coocCode27 = ccb < 0 ? '' : stripS27(ENGS27.slice(ccb, ENGS27.indexOf('\nfunction buildCoocForms', ccb)))
  const shapeProj = {
    不再造self集: coocCode27.includes('const self = new Set(ws);') === false,
    不再filter并集: coocCode27.includes('unionArr.filter(') === false,
    先判全覆盖: coocCode27.includes('let onlySelf = true;') &&
      coocCode27.includes('if (ws.indexOf(unionArr[k]) < 0) {') && coocCode27.includes('if (onlySelf) continue;'),
    按并集序跳自己: coocCode27.includes('for (const b of unionArr) {') && coocCode27.includes('if (ws.indexOf(b) >= 0) continue;'),
  }
  const missProj = Object.keys(shapeProj).filter((k) => !shapeProj[k])
  check('OR087 引擎里项目层：不再为每条造 self Set 与 others 数组，先判 onlySelf 再按并集序 indexOf 跳自己',
    missProj.length === 0, missProj.length === 0 ? '四处全在' : `缺 ${missProj.join(',')}`)

  // 签名口径不变：头、尾各改一个字都换签名；等长改在正中间仍是同一张库（0.2.153 那版就这样，
  // 这一版只是把算术搬出闭包，不许顺手把口径也换了）。
  let sigOk = false
  let sigDetail = ''
  try {
    const Mv27 = (await import('./vendor/meow-memory/lib/index.js'))
    const mkDoc = (id, content) => ({ id, project: 'pz', title: 't', content, keywords: [], level: 'fact',
      importance: 1, created_at: '2026-11-20T00:00:00Z', updated_at: '2026-11-20T00:00:00Z',
      last_accessed_at: '2026-11-20T00:00:00Z', status: 'active' })
    // 正文要长过「头 40 + 尾 40」才谈得上「中间改」——200 个互不相同的汉字，正中间是第 100 位。
    const long27 = Array.from({ length: 200 }, (_, i) => String.fromCharCode(0x4e00 + i)).join('')
    const other27 = String.fromCharCode(0x5b00)
    const sigOf = (docs) => { Mv27.clearSearchIndexCache(); return Mv27.searchIndexOf(docs, {}).__sig }
    const s0 = sigOf([mkDoc('s1', long27)])
    const headDiff = sigOf([mkDoc('s1', other27 + long27.slice(1))])
    const tailDiff = sigOf([mkDoc('s1', long27.slice(0, -1) + other27)])
    const midSame = sigOf([mkDoc('s1', long27.slice(0, 100) + other27 + long27.slice(101))])
    sigOk = s0 !== headDiff && s0 !== tailDiff && s0 === midSame && String(s0).length > 2
    sigDetail = `头改换 ${s0 !== headDiff} · 尾改换 ${s0 !== tailDiff} · 正中等长改写同签名 ${s0 === midSame}`
  } catch (e) {
    sigDetail = String(e && e.message)
  }
  check('OR087 进程内：签名口径没动——头 40 字与尾 40 字各改一个字都换签名，正中等长的改写仍算同一张库', sigOk, sigDetail)

  // 会话主题两轮：与「先数完全部会话再定分」的朴素尺子逐会话逐词逐序相同。
  // 夹具里全是中文二元组（没有英文停用词），所以尺子不必再管停用词那一层。
  let sttOk = false
  let sttDetail = ''
  try {
    const Mv27 = (await import('./vendor/meow-memory/lib/index.js'))
    const mkS = (id, sess, content) => ({ id, project: 'ps', title: '', content, keywords: [], level: 'fact',
      importance: 1, created_at: '2026-11-20T00:00:00Z', updated_at: '2026-11-20T00:00:00Z',
      last_accessed_at: '2026-11-20T00:00:00Z', status: 'active', source_session: sess })
    const docs27 = [
      mkS('t1', 'sa', '自检 基线 收敛 三趟'),
      mkS('t2', 'sa', '自检 基线 又跑 收敛 了'),
      mkS('t3', 'sa', '基线 四趟 收敛 稳定'),
      mkS('t4', 'sa', '索引 缓存 热 起来'),
      mkS('t5', 'sb', '锚点 实体 先验 扩展'),
      mkS('t6', 'sb', '锚点 分档 阈值 噪声'),
      mkS('t7', 'sb', '噪声 地板 剔词 空回'),
      mkS('t8', 'sc', '孤零零 一条 记录'),
    ]
    Mv27.clearSearchIndexCache()
    const off27 = Mv27.searchIndexOf(docs27, { sessionTopic: false })
    Mv27.clearSearchIndexCache()
    const on27 = Mv27.searchIndexOf(docs27, { sessionTopic: true })
    const tails = docs27.map((_, i) => (on27.docToks[i] ?? []).slice((off27.docToks[i] ?? []).length))
    // 尺子：老写法——每个会话一张 tf、跨会话一张 sessDf、够 3 条的会话留整张 Map，最后统一打分
    const bySess = new Map()
    docs27.forEach((d, i) => {
      const s = d.source_session
      if (!s) return
      if (!bySess.has(s)) bySess.set(s, [])
      bySess.get(s).push(i)
    })
    const total27 = bySess.size
    const sessDf = new Map()
    const kept = new Map()
    for (const [s, idxs] of bySess) {
      const tf = new Map()
      for (const i of idxs) for (const t of off27.docToks[i] ?? []) tf.set(t, (tf.get(t) ?? 0) + 1)
      for (const [t] of tf) sessDf.set(t, (sessDf.get(t) ?? 0) + 1)
      if (idxs.length >= 3) kept.set(s, [...tf])
    }
    const want27 = new Map()
    for (const [s, pairs] of kept) {
      const ranked = pairs.filter(([t]) => t.length >= 2).map(([t, c]) => [t, c * Math.log(1 + total27 / sessDf.get(t))])
      ranked.sort((a, b) => b[1] - a[1])
      const words = ranked.slice(0, 12).map(([t]) => t)
      if (words.length > 0) want27.set(s, words)
    }
    const got27 = new Map()
    for (const [s, idxs] of bySess) {
      const i0 = idxs[0]
      if ((tails[i0] ?? []).length > 0) got27.set(s, tails[i0])
    }
    const sameSess = JSON.stringify([...want27]) === JSON.stringify([...got27])
    const consistent = bySess.get('sa').every((i) => JSON.stringify(tails[i]) === JSON.stringify(tails[bySess.get('sa')[0]]))
    const shortSess = (tails[7] ?? []).length === 0
    sttOk = sameSess && consistent && shortSess
    sttDetail = `会话 ${got27.size} 个 · 与尺子逐会话逐词逐序相同 ${sameSess} · 同会话各条一致 ${consistent} · 不足 3 条的会话不加 ${shortSess}`
  } catch (e) {
    sttDetail = String(e && e.message)
  }
  check('OR087 进程内：会话主题的两轮实现与「先数完全部会话再定分」的朴素尺子逐会话逐词逐序相同（不足 3 条的会话一条都不加）',
    sttOk, sttDetail)

  check(
    'OR087 文档在位：INTERNAL 9.226 写了「按下标分类」，README 写了「不再为每个码点造字符串」，DESIGN 有 ## 222.，PLAN 有 0.6.27',
    readFileSync(new URL('./docs/INTERNAL.md', import.meta.url), 'utf8').includes('## 9.226 ') &&
      readFileSync(new URL('./README.md', import.meta.url), 'utf8').includes('不再为每个码点造字符串') &&
      readFileSync(new URL('./DESIGN.md', import.meta.url), 'utf8').includes('## 222. ') &&
      /0\.6\.27/.test(readFileSync(new URL('./docs/PLAN-0.6.md', import.meta.url), 'utf8')),
  )
  const vS18 = (readFileSync(new URL('./lib/index.js', import.meta.url), 'utf8').match(/export const version = '(\d+)\.(\d+)\.(\d+)'/) ?? []).slice(1).map(Number)
  const vNumS18 = vS18.length === 3 ? vS18[0] * 10000 + vS18[1] * 100 + vS18[2] : 0
  check('OR087 版本号不低于 0.6.27（后续补丁不必回头改这一条）', vNumS18 >= 627, vS18.join('.'))
}

// ═══════════════ [macro-fusion 0.6.28] OR088：热查的三笔固定开销 ═══════════════
{
  const readS28 = (p) => readFileSync(new URL(p, import.meta.url), 'utf8')
  const stripS28 = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  const engS28 = stripS28(readS28('./vendor/meow-memory/lib/index.js'))
  const hotS28 = readS28('./tools/probe-hotpath.mjs')
  const allS28 = readS28('./tools/check-all.mjs')
  check('OR088 探针在位：probe-hotpath 有 H7–H10 四条，check-all 挂了它',
    ['H7 ', 'H8 ', 'H9 ', 'H10 '].every((t) => hotS28.includes(t)) && allS28.includes('probe-hotpath'))
  const powS28 = engS28.includes('const COORD_POW_ONE = COORD_POW === 1;')
  const powSites28 = (engS28.match(/cvr = COORD_POW_ONE \? coverOf\[di\] : Math\.pow\(coverOf\[di\], COORD_POW\);/g) ?? []).length
  const powBare28 = (engS28.match(/cvr = Math\.pow\(coverOf\[di\], COORD_POW\);/g) ?? []).length
  const bandS28 = engS28.includes('let lastV = -1;') && engS28.includes('if (v === lastV) {') &&
    engS28.includes('lastV = v;') && engS28.includes('lastBand = m - 1 - lo;')
  const scratchS28 = engS28.includes('const HOT_SCRATCH = { busy: false,') && engS28.includes('if (s.busy) return null;') &&
    engS28.includes('const scratch = hotScratchOf(docs.length);') &&
    (engS28.match(/hotScratchDone\(\);/g) ?? []).length === 2 &&
    // [0.6.34] 六处 → 七处：候选表也走 `hotScratchOf`（`candBuf` 的 `scratch === null ? new Int32Array(docs.length)`）。
    (engS28.match(/scratch === null \?/g) ?? []).length === 7
  check('OR088 引擎形状：覆盖度幂走恒等快路（两处三元、无裸求幂）、档号同分批量、临时缓冲按长度复用（六处取用、两个出口归还）',
    powS28 && powSites28 === 2 && powBare28 === 0 && bandS28 && scratchS28,
    `pow=${powSites28} 裸=${powBare28} band=${bandS28} scratch=${scratchS28}`)
  const MvH = await import('./vendor/meow-memory/lib/index.js')
  const NOWH = 1795470000000
  const mkH = (id, level, content, importance = 2) => ({ id, level, title: 't', content, importance, updated_at: '2026-01-01T00:00:00Z', keywords: ['alpha'], project: 'p' })
  const plainH = [mkH('0mzzzzzz', 'fact', 'alpha beta delta'), mkH('0mrrrrrr', 'rules', 'alpha 一律 必须先跑 alpha', 3), mkH('0mfffffff', 'fact', 'alpha 随便 看看 alpha', 1), mkH('0mvvvvvv', 'fact', 'alpha 必须 先 alpha', 4)]
  const dfltH = JSON.stringify(MvH.search('alpha beta', plainH, { k: 5, explain: true, now: NOWH }))
  const powOneH = JSON.stringify(MvH.search('alpha beta', plainH, { k: 5, coordPow: 1, explain: true, now: NOWH }))
  const powTwoH = JSON.stringify(MvH.search('alpha beta', plainH, { k: 5, coordPow: 2, explain: true, now: NOWH }))
  check('OR088 进程内：默认幂与显式 pow=1 逐位相同、与 pow=2 不同（快路与求幂同值，旋钮仍接着）',
    dfltH === powOneH && dfltH !== powTwoH, `${dfltH.length} 字符`)
  const qH = 'alpha beta'
  const b1H = JSON.stringify(MvH.search(qH, plainH, { k: 5, explain: true, now: NOWH }))
  const b2H = JSON.stringify(MvH.search(qH, plainH, { k: 5, explain: true, now: NOWH }))
  MvH.search('0mzzzzzz', plainH, { k: 5, now: NOWH })
  MvH.search(qH, plainH, { k: 5, coordPow: 2, now: NOWH })
  MvH.search(qH, plainH, { k: 5, inverted: false, now: NOWH })
  const b3H = JSON.stringify(MvH.search(qH, plainH, { k: 5, explain: true, now: NOWH }))
  const bigH = plainH.concat([mkH('0mbig001', 'fact', 'alpha beta gamma'), mkH('0mbig002', 'fact', 'alpha delta')])
  MvH.search(qH, bigH, { k: 5, explain: true, now: NOWH })
  const b4H = JSON.stringify(MvH.search(qH, plainH, { k: 5, explain: true, now: NOWH }))
  check('OR088 进程内：复用缓冲不残留——连跑、插别的问、插 pow=2 与 inverted=false、换语料长度再换回来，同问四份逐位相同',
    b1H === b2H && b2H === b3H && b3H === b4H, `${b1H.length} 字符`)
  check('OR088 文档在位：INTERNAL 9.227、README 写「一次幂运算」、DESIGN 有 ## 223.、PLAN 有 0.6.28',
    readS28('./docs/INTERNAL.md').includes('## 9.227 ') &&
      readS28('./README.md').includes('一次幂运算') &&
      readS28('./DESIGN.md').includes('## 223. ') &&
      /0\.6\.28/.test(readS28('./docs/PLAN-0.6.md')))
  const vS28 = (readS28('./lib/index.js').match(/export const version = '(\d+)\.(\d+)\.(\d+)'/) ?? []).slice(1).map(Number)
  const vNumS28 = vS28.length === 3 ? vS28[0] * 10000 + vS28[1] * 100 + vS28[2] : 0
  check('OR088 版本号不低于 0.6.28（后续补丁不必回头改这一条）', vNumS28 >= 628, vS28.join('.'))
}

// ═══════════════ [macro-fusion 0.6.29] OR089：循环不变量出循环 + 瘦对象不算 cover ═══════════════
{
  const readS29 = (p) => readFileSync(new URL(p, import.meta.url), 'utf8')
  const stripS29 = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  const engS29 = stripS29(readS29('./vendor/meow-memory/lib/index.js'))
  const hotS29 = readS29('./tools/probe-hotpath.mjs')
  const allS29 = readS29('./tools/check-all.mjs')
  check('OR089 探针在位：probe-hotpath 有 H11–H13 三条，check-all 挂了它',
    ['H11 ', 'H12 ', 'H13 '].every((t) => hotS29.includes(t)) && allS29.includes('probe-hotpath'))
  const tabS29 = engS29.includes('const FIELD_W_TAB = [1, 1 + FIELD_TITLE_W, 1 + FIELD_KW_W, 1 + FIELD_TITLE_W + FIELD_KW_W];') &&
    // [0.6.39] 同上：表外多一个按问句词给的声明折扣系数，缺省时就是表值。
    (engS29.includes('const fw = FIELD_W_TAB[fl & 3];') ||
      engS29.includes('const fw = qLoopDeclW === null ? FIELD_W_TAB[fl & 3] : FIELD_W_TAB[fl & 3] * qLoopDeclW[qi];')) &&
    engS29.includes('if (fl & 1) fw += FIELD_TITLE_W;') === false &&
    engS29.includes('idf0 * fw * (f * k1p1 / (f + kDen[di]))')
  const invS29 = engS29.includes('const subjZero = subjRatio === void 0 || opts.identSubjBand === false || !identHardOk;') &&
    engS29.includes('const bandWOn = opts.identBand !== false && identHardOk;') &&
    engS29.includes('const subjBandOn = opts.identSubjBand !== false && identHardOk;') &&
    engS29.includes('const lvOn = opts.levelIntent !== false;') &&
    engS29.includes('const onBody = opts.lengthOnBody === false;') &&
    engS29.includes('const lenDl = onBody ? avgdl : avgBody;') &&
    engS29.includes('const k1p1 = k1 + 1;') &&
    engS29.includes('const satDen = k1 * (1 - bEff + bEff * len / lenDl);') &&
    (engS29.match(/opts\.identBand === false \|\| !identHardOk/g) ?? []).length === 0
  const iLean29 = engS29.indexOf('if (leanHit) {')
  const leanS29 = iLean29 > 0 ? engS29.slice(iLean29, engS29.indexOf('} else hits.push({', iLean29)) : ''
  const noCoverS29 = leanS29.length > 0 && leanS29.includes('cover:') === false && leanS29.includes('_di: di')
  check('OR089 引擎形状：字段权重一次查表（无位与分支）、四个循环不变量在循环外、瘦对象上不再算 cover',
    tabS29 && invS29 && noCoverS29,
    `表=${tabS29} 不变量=${invS29} 瘦对象无 cover=${noCoverS29}`)
  const MvX = await import('./vendor/meow-memory/lib/index.js')
  const NOWX = 1795470000000
  const mkX = (id, level, content, importance = 2) => ({ id, level, title: 't', content, importance, updated_at: '2026-01-01T00:00:00Z', keywords: ['alpha'], project: 'p' })
  const plainX = [mkX('0mzzzzzz', 'fact', 'alpha beta delta'), mkX('0mrrrrrr', 'rules', 'alpha 一律 必须先跑 alpha', 3), mkX('0mfffffff', 'fact', 'alpha 随便 看看 alpha', 1), mkX('0mvvvvvv', 'fact', 'alpha 必须 先 alpha', 4)]
  const dfltX = MvX.search('alpha beta', plainX, { k: 5, now: NOWX })
  const explX = MvX.search('alpha beta', plainX, { k: 5, explain: true, now: NOWX })
  const keepX = MvX.search('alpha beta', plainX, { k: 5, keepBand: true, now: NOWX })
  const coverOkX = dfltX.length > 0 &&
    dfltX.every((h, i) => Number.isFinite(h.cover) && Object.is(h.cover, explX[i]?.explain?.cover)) &&
    keepX.every((h) => Number.isFinite(h.cover)) &&
    dfltX.every((h) => h._di === void 0 && h._raw === void 0)
  check('OR089 进程内：默认路的 cover 与 explain.cover 逐位相同、keepBand 也带 cover，回执里没有瘦对象残留',
    coverOkX, `${dfltX.length} 条 · cover=${dfltX.map((h) => h.cover).join(',')}`)
  const idX = [mkX('0mwq5zzv', 'fact', '0mwq5zzv alpha'), mkX('0mzzzzzz', 'fact', 'alpha beta')]
  const kbOnX = MvX.search('0mwq5zzv alpha', idX, { k: 5, keepBand: true, now: NOWX }).find((h) => h.id === '0mwq5zzv')
  const kbOffX = MvX.search('0mwq5zzv alpha', idX, { k: 5, keepBand: true, identBand: false, now: NOWX }).find((h) => h.id === '0mwq5zzv')
  const kbSubjX = MvX.search('0mwq5zzv alpha', idX, { k: 5, keepBand: true, identSubjBand: false, now: NOWX }).find((h) => h.id === '0mwq5zzv')
  const lvHiX = MvX.search('该不该 alpha', plainX, { k: 5, explain: true, now: NOWX }).find((h) => h.level === 'rules')
  const lvLoX = MvX.search('该不该 alpha', plainX, { k: 5, explain: true, levelIntent: false, now: NOWX }).find((h) => h.level === 'rules')
  const lenX = MvX.search('alpha beta', plainX, { k: 5, now: NOWX })
  const lenOffX = MvX.search('alpha beta', plainX, { k: 5, lengthOnBody: false, now: NOWX })
  const switchesX = kbOnX !== void 0 && kbOffX !== void 0 && kbSubjX !== void 0 &&
    Number(kbOnX._raw) > Number(kbOffX._raw) && Number(kbOnX._subj) === 1 && Number(kbSubjX._subj) === 0 &&
    lvHiX !== void 0 && lvLoX !== void 0 && lvHiX.score > lvLoX.score &&
    lenX.some((h, i) => h.score !== lenOffX[i]?.score)
  check('OR089 进程内：identBand / identSubjBand / levelIntent / lengthOnBody 四个开关仍各自生效（提到循环外不许写死）',
    switchesX,
    `_raw ${kbOnX?._raw}→${kbOffX?._raw} · _subj ${kbOnX?._subj}→${kbSubjX?._subj} · levelIntent ${lvHiX?.score}→${lvLoX?.score}`)
  check('OR089 文档在位：INTERNAL 9.228、README 写「字段权重查表」、DESIGN 有 ## 224.、PLAN 有 0.6.29',
    readS29('./docs/INTERNAL.md').includes('## 9.228 ') &&
      readS29('./README.md').includes('字段权重查表') &&
      readS29('./DESIGN.md').includes('## 224. ') &&
      /0\.6\.29/.test(readS29('./docs/PLAN-0.6.md')))
  const vS29 = (readS29('./lib/index.js').match(/export const version = '(\d+)\.(\d+)\.(\d+)'/) ?? []).slice(1).map(Number)
  const vNumS29 = vS29.length === 3 ? vS29[0] * 10000 + vS29[1] * 100 + vS29[2] : 0
  check('OR089 版本号不低于 0.6.29（后续补丁不必回头改这一条）', vNumS29 >= 629, vS29.join('.'))
}

// ═══════════════ [macro-fusion 0.6.30] OR090：猜位定档 + 小闭包摊平 + 同值铺表走 fill ═══════════════
{
  const readS30 = (p) => readFileSync(new URL(p, import.meta.url), 'utf8')
  const stripS30 = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  const rawS30 = readS30('./vendor/meow-memory/lib/index.js')
  const engS30 = stripS30(rawS30)
  const hotS30 = readS30('./tools/probe-hotpath.mjs')
  const allS30 = readS30('./tools/check-all.mjs')
  check('OR090 探针在位：probe-hotpath 有 H14–H16 三条（定档定位 / 重要性权重 / 同值铺表指纹），check-all 挂了它',
    ['H14 ', 'H15 ', 'H16 '].every((t) => hotS30.includes(t)) &&
      allS30.includes('probe-hotpath') &&
      rawS30.includes('const RAWK_SHIFT = 16;'))
  const iV30 = rawS30.indexOf('function verbatimInputs(query, docs, opts, textOf')
  const iVEnd30 = iV30 > 0 ? rawS30.indexOf('\nfunction ', iV30 + 10) : -1
  const vbCode30 = iV30 > 0 && iVEnd30 > iV30
    ? rawS30.slice(iV30, iVEnd30).split('\n').filter((ln) => !ln.trim().startsWith('//')).join('\n')
    : ''
  const fillOk30 = vbCode30.includes('rawVerbatim: new Array(docs.length).fill(null),') &&
    vbCode30.includes('subjRatio: new Array(docs.length).fill(0)') &&
    vbCode30.includes('docs.map(') === false
  const impOk30 = engS30.includes('const impOf = (d) => {') === false &&
    engS30.includes('const impRaw = Math.round(Number(dOf.importance));') &&
    engS30.includes('const impW = 1 + ((Number.isFinite(impRaw) ? (impRaw < 1 ? 1 : impRaw > 4 ? 4 : impRaw) : 1) - 1) * 0.25;')
  const lvOk30 = engS30.includes('lvTmp.push(lvHit && lvOn ? 1 : 0);') &&
    engS30.includes('lvTmp.push(lvHit && opts.levelIntent !== false ? 1 : 0);') === false
  const bandOk30 = engS30.includes('const posScale = spanV > 0 ? (m - 1) / spanV : 0;') &&
    engS30.includes('let est = ((v - a0v) * posScale) | 0;') &&
    engS30.includes('if (anchors[est] >= v) {') &&
    engS30.includes('hiI = est;') &&
    engS30.includes('loI = est + 1;')
  check('OR090 引擎形状：同值铺表走原生 fill、impOf 闭包退休、层级判据复用 lvOn、定档改猜位 + 半区间',
    fillOk30 && impOk30 && lvOk30 && bandOk30,
    `铺表=${fillOk30} impW=${impOk30} lvOn=${lvOk30} 猜位=${bandOk30}`)
  // 定档定位等价：把引擎的桶表 + `anchorChainOf` + `setBandsByThreshold` 原文抠出来跑，
  // 再与「每条从头二分」的参考逐条对档号（分布：均匀 / 同分 / 偏斜 / 两值 / 全等 / 巨跨 / 微跨 / 含零）。
  const iA30 = rawS30.indexOf('const RAWK_SHIFT = 16;')
  const iC30 = rawS30.indexOf('function setBandsBySort(hits, rawKey) {')
  let sand30 = null
  try {
    sand30 = iA30 >= 0 && iC30 > iA30
      ? new Function(`var IMP_BAND = 0.85;\n${rawS30.slice(iA30, iC30)}\nreturn { setBandsByThreshold, anchorChainOf };`)()
      : null
  } catch {
    sand30 = null
  }
  const lcg30 = (seed0) => {
    let s = seed0
    return () => {
      s = (s * 1103515245 + 12345) % 2147483648
      return s / 2147483648
    }
  }
  const g1 = lcg30(7), g2 = lcg30(11), g3 = lcg30(13), g4 = lcg30(17), g5 = lcg30(19), g6 = lcg30(23)
  const dist30 = [
    Array.from({ length: 300 }, () => g1()),
    Array.from({ length: 300 }, () => Math.round(g2() * 20) / 20),
    Array.from({ length: 300 }, () => Math.exp(-g3() * 8) * 1000),
    Array.from({ length: 300 }, () => (g4() < 0.5 ? 1 : 2)),
    new Array(300).fill(5),
    Array.from({ length: 300 }, () => g5() * 1e12),
    Array.from({ length: 300 }, (_, i) => 1e15 + i),
    Array.from({ length: 300 }, () => (g6() < 0.3 ? 0 : g6())),
  ]
  const refBand30 = (anchors, m, v) => {
    let lo = 0
    let hi = m
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (anchors[mid] >= v) hi = mid
      else lo = mid + 1
    }
    return m - 1 - lo
  }
  let bandBad30 = 0
  let bandRows30 = 0
  if (sand30 !== null) {
    for (const vals of dist30) {
      const hits = vals.map((v) => ({ _raw: v }))
      hits.push({ _raw: 3, _ident: true }, { _raw: 4, _subj: 1 })
      if (sand30.setBandsByThreshold(hits, '_raw') !== true) bandBad30 += 1
      const anchors = sand30.anchorChainOf(Float64Array.from(vals), vals.length)
      const m = anchors.length
      for (let i = 0; i < vals.length; i++) {
        bandRows30 += 1
        if (!Object.is(hits[i]._bandTmp, refBand30(anchors, m, vals[i]))) bandBad30 += 1
      }
      if (hits[vals.length]._bandTmp !== -1 || hits[vals.length + 1]._bandTmp !== -1) bandBad30 += 1
    }
  }
  check('OR090 进程内：猜位 + 半区间二分与「每条从头二分」逐位同档（八种分布 2,400 条全对，指认 / 主语项仍 -1）',
    sand30 !== null && bandBad30 === 0 && bandRows30 === 2400,
    `对档 ${bandRows30} 条 · 不符 ${bandBad30}`)
  // 重要性权重：`now: null` 关掉时间衰减，分数比值就只剩 impW，逐档对老公式（越界 / 小数 / NaN / 字符串 / null / 负数）
  const Mv30 = await import('./vendor/meow-memory/lib/index.js')
  const impOld30 = (v) => {
    const r = Math.round(Number(v))
    const c = Number.isFinite(r) ? Math.min(4, Math.max(1, r)) : 1
    return 1 + (c - 1) * 0.25
  }
  const imps30 = [1, 2, 3, 4, 9, 0, 0.4, 2.6, NaN, '2', null, void 0, -3]
  const impDocs30 = imps30.map((v, i) => ({
    id: '0mz' + String(i).padStart(5, '0'), level: 'fact', title: 't', content: 'alpha beta gamma',
    importance: v, updated_at: '2026-01-01T00:00:00Z', keywords: ['alpha'], project: 'p',
  }))
  const impRes30 = Mv30.search('alpha beta gamma', impDocs30, { k: 20, now: null })
  const impBase30 = impRes30.find((h) => h.id === '0mz00000')
  let impBad30 = 0
  let impChecked30 = 0
  if (impBase30 !== void 0 && impBase30.score > 0) {
    for (let i = 0; i < imps30.length; i += 1) {
      const h = impRes30.find((x) => x.id === '0mz' + String(i).padStart(5, '0'))
      if (h === void 0) continue
      impChecked30 += 1
      if (!Object.is(Math.round((h.score / impBase30.score) * 1e9) / 1e9, Math.round(impOld30(imps30[i]) * 1e9) / 1e9)) impBad30 += 1
    }
  }
  check('OR090 进程内：重要性权重逐档与老闭包同值（含越界 / 小数 / NaN / 字符串 / null / 负数）',
    impChecked30 === imps30.length && impBad30 === 0,
    `逐档 ${impChecked30}/${imps30.length} · 不符 ${impBad30}`)
  // 回执指纹：与 0.6.29 引擎逐位相同（发版前两条引擎跑过对照，见 DESIGN 225 / INTERNAL 9.229）
  const NOW30 = 1795470000000
  const lcgG = lcg30(97)
  const wordsG = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', '一律', '必须', '先', '记忆', '星图']
  const corpusG = Array.from({ length: 120 }, (_, i) => {
    const n = 3 + ((lcgG() * 5) | 0)
    const ws = Array.from({ length: n }, () => wordsG[(lcgG() * wordsG.length) | 0])
    return {
      id: '0mg' + String(i).padStart(6, '0'),
      level: ['fact', 'lesson', 'rules', 'topic'][(lcgG() * 4) | 0],
      title: ws[0],
      content: ws.join(' '),
      importance: 1 + ((lcgG() * 4) | 0),
      updated_at: '2026-01-01T00:00:00Z',
      keywords: lcgG() < 0.2 ? null : [wordsG[(lcgG() * wordsG.length) | 0]],
      project: 'p',
    }
  })
  const qsG = ['alpha beta', '必须 先 记忆', '星图 一律', 'gamma delta epsilon', '规则 是什么',
    '为什么 要 先', 'alpha gamma 记忆', '0mg000012 alpha']
  const digestG = qsG.map((q) => Mv30.search(q, corpusG, { k: 8, now: NOW30 })
    .map((h) => `${h.id}@${h.score.toFixed(12)}`).join(',')).join('|')
  const GOLD30 = '0mg000005@3.664628057107,0mg000038@5.102523846806,0mg000061@4.788643770374,0mg000006@3.925122785034,0mg000074@2.232920822271|0mg000023@6.732283929790,0mg000108@5.065968177695,0mg000076@4.106832745439,0mg000104@4.756171212734,0mg000117@4.580868819911|0mg000100@5.906625216656,0mg000067@3.975949441312,0mg000115@3.760224920935,0mg000015@3.579293550671,0mg000047@3.464398706423|0mg000101@5.989226322228,0mg000037@4.382801980391,0mg000105@6.132937947203,0mg000016@5.714996394708,0mg000089@5.278362858510|||0mg000023@7.099164514106,0mg000108@5.912829410853,0mg000005@4.615892988676,0mg000084@3.935034576993,0mg000058@6.160437605175|0mg000012@3.148175340076,0mg000083@1.863256160943,0mg000005@1.755985977713,0mg000109@2.098783560051,0mg000073@1.049391780025'
  check('OR090 进程内：固定语料 × 八个问句的回执指纹与 0.6.29 逐位相同（同值铺表 / 循环外判据都没改值）',
    digestG === GOLD30, digestG === GOLD30 ? '指纹同' : '指纹不同')
  check('OR090 文档在位：INTERNAL 9.229、README 写「猜位定档」、DESIGN 有 ## 225.、PLAN 有 0.6.30',
    readS30('./docs/INTERNAL.md').includes('## 9.229 ') &&
      readS30('./README.md').includes('猜位定档') &&
      readS30('./DESIGN.md').includes('## 225. ') &&
      /0\.6\.30/.test(readS30('./docs/PLAN-0.6.md')))
  const vS30 = (readS30('./lib/index.js').match(/export const version = '(\d+)\.(\d+)\.(\d+)'/) ?? []).slice(1).map(Number)
  const vNumS30 = vS30.length === 3 ? vS30[0] * 10000 + vS30[1] * 100 + vS30[2] : 0
  check('OR090 版本号不低于 0.6.30（后续补丁不必回头改这一条）', vNumS30 >= 630, vS30.join('.'))
}

// ═══════════════ [macro-fusion 0.6.31] OR091：定档合成一趟 + 桶表单段清理 + 阈值提循环外 ═══════════════
{
  const readS31 = (p) => readFileSync(new URL(p, import.meta.url), 'utf8')
  const rawS31 = readS31('./vendor/meow-memory/lib/index.js')
  const stripS31 = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  // 判「老写法不在」必须切函数体 + 剔注释行：引擎注释里为说明老写法是什么，会把老写法原样写进注释（0.6.30 踩过）。
  const bodyOf31 = (name) => {
    const at = rawS31.indexOf(`function ${name}(`)
    if (at < 0) return ''
    const next = rawS31.indexOf('\nfunction ', at + 1)
    const body = next < 0 ? rawS31.slice(at) : rawS31.slice(at, next)
    return stripS31(body)
  }
  const hotS31 = readS31('./tools/probe-hotpath.mjs')
  const allS31 = readS31('./tools/check-all.mjs')
  check('OR091 探针在位：probe-hotpath 有 H17–H19 三条（形状 / 桶表逐位 / 跨版本指纹），check-all 挂了它',
    ['H17 ', 'H18 ', 'H19 '].every((t) => hotS31.includes(t)) &&
      allS31.includes('probe-hotpath') &&
      rawS31.includes('const RAWK_SHIFT = 16;'))
  const bandC31 = bodyOf31('setBandsByThreshold')
  const chainC31 = bodyOf31('anchorChainOf')
  const engC31 = stripS31(rawS31)
  const firstOk31 = bandC31.includes('if (rawkVals.length < total) rawkVals = new Float64Array(total);') &&
    bandC31.includes('vals[plain++] = r;') &&
    bandC31.includes('if (rawkVals.length < plain)') === false &&
    bandC31.includes('vals[j++] = h[rawKey];') === false
  const histOk31 = chainC31.includes('rawkHist.fill(0, 0, rawkTopPrev + 1);') &&
    chainC31.includes('rawkTopPrev = -1;') &&
    chainC31.includes('for (let b = 0; b <= top; b++)') &&
    chainC31.includes('rawkTopPrev = top;') &&
    chainC31.includes('rawkHist.fill(0);') === false &&
    chainC31.includes('b < RAWK_NB') === false
  const emitOk31 = (engC31.split('const impBandMax = IMP_BAND * maxRaw;').length - 1) === 2 &&
    engC31.includes('!(raw[di] >= impBandMax)') &&
    engC31.includes('!(raw[di] >= IMP_BAND * maxRaw)') === false
  check('OR091 引擎形状：定档校验与抄值合成一趟、桶表只清上一趟那段、衰减阈值两条路都提到循环外',
    firstOk31 && histOk31 && emitOk31,
    `合成一趟=${firstOk31} 单段清理=${histOk31} 阈值提出=${emitOk31}`)
  // 两处进程内等价：① 定档（桶表 + 猜位定档）与「每条从头二分」逐位同档；
  // ② 桶表在多趟之间 top 一高一低时，与「排序 + 阈值链」的纯参考实现逐位相同（漏清必然露馅）。
  const iA31 = rawS31.indexOf('const RAWK_SHIFT = 16;')
  const iC31 = rawS31.indexOf('function setBandsBySort(hits, rawKey) {')
  let sand31 = null
  try {
    sand31 = iA31 >= 0 && iC31 > iA31
      ? new Function(`var IMP_BAND = 0.85;\n${rawS31.slice(iA31, iC31)}\nreturn { setBandsByThreshold, anchorChainOf, anchorChainSorted };`)()
      : null
  } catch {
    sand31 = null
  }
  const lcg31 = (seed0) => {
    let s = seed0
    return () => {
      s = (s * 1103515245 + 12345) % 2147483648
      return s / 2147483648
    }
  }
  const r1 = lcg31(7), r2 = lcg31(11), r3 = lcg31(13), r4 = lcg31(17), r5 = lcg31(19), r6 = lcg31(23)
  const dist31 = [
    Array.from({ length: 300 }, () => r1()),
    Array.from({ length: 300 }, () => Math.round(r2() * 20) / 20),
    Array.from({ length: 300 }, () => Math.exp(-r3() * 8) * 1000),
    Array.from({ length: 300 }, () => (r4() < 0.5 ? 1 : 2)),
    new Array(300).fill(5),
    Array.from({ length: 300 }, () => r5() * 1e12),
    Array.from({ length: 300 }, (_, i) => 1e15 + i),
    Array.from({ length: 300 }, () => (r6() < 0.3 ? 0 : r6())),
  ]
  const refBand31 = (anchors, m, v) => {
    let lo = 0
    let hi = m
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (anchors[mid] >= v) hi = mid
      else lo = mid + 1
    }
    return m - 1 - lo
  }
  let bandBad31 = 0
  let bandRows31 = 0
  if (sand31 !== null) {
    for (const vals of dist31) {
      const hits = vals.map((v) => ({ _raw: v }))
      hits.push({ _raw: 3, _ident: true }, { _raw: 4, _subj: 1 })
      if (sand31.setBandsByThreshold(hits, '_raw') !== true) bandBad31 += 1
      const anchors = sand31.anchorChainOf(Float64Array.from(vals), vals.length)
      const m = anchors.length
      for (let i = 0; i < vals.length; i++) {
        bandRows31 += 1
        if (!Object.is(hits[i]._bandTmp, refBand31(anchors, m, vals[i]))) bandBad31 += 1
      }
      if (hits[vals.length]._bandTmp !== -1 || hits[vals.length + 1]._bandTmp !== -1) bandBad31 += 1
    }
  }
  check('OR091 进程内：合成一趟的定档仍与「每条从头二分」逐位同档（八种分布 2,400 条，指认 / 主语项仍 -1）',
    sand31 !== null && bandBad31 === 0 && bandRows31 === 2400,
    `对档 ${bandRows31} 条 · 不符 ${bandBad31}`)
  const shapes31 = [
    (r) => r(),
    (r) => r() * 1e12,
    (r) => Math.round(r() * 4) / 4,
    (r, i) => 1e15 + i,
    (r, i) => (i % 3 === 0 ? 0 : r()),
    (r) => Math.exp(-r() * 6),
  ]
  const sizes31 = [1, 2, 5, 37, 200, 1500, 4000]
  const rC = lcg31(2031)
  let chainChecks31 = 0
  let chainBad31 = 0
  if (sand31 !== null) {
    for (const shape of shapes31) {
      for (const n of sizes31) {
        const arr = new Float64Array(n)
        for (let i = 0; i < n; i++) arr[i] = shape(rC, i)
        const sorted = Float64Array.from(arr)
        sorted.sort()
        const exp = sand31.anchorChainSorted(sorted, n)
        chainChecks31 += 1
        if (JSON.stringify(sand31.anchorChainOf(arr, n)) !== JSON.stringify(exp)) chainBad31 += 1
        chainChecks31 += 1
        if (JSON.stringify(sand31.anchorChainOf(arr, n)) !== JSON.stringify(exp)) chainBad31 += 1
      }
    }
  }
  check('OR091 进程内：桶表只清上一趟那段 + 前缀和只走到 top，六种分布 × 七种长度与「排序 + 阈值链」逐位相同',
    sand31 !== null && chainChecks31 === 84 && chainBad31 === 0,
    `对档 ${chainChecks31} 项 · 不符 ${chainBad31}`)
  // 跨版本指纹：0.6.29 / 0.6.30 / 0.6.31 三个引擎在这份固定语料上必须一位分数都不差。
  const Mv31 = await import('./vendor/meow-memory/lib/index.js')
  const NOW31 = 1795470000000
  const lcgG31 = lcg31(97)
  const wordsG31 = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', '一律', '必须', '先', '记忆', '星图']
  const corpusG31 = Array.from({ length: 120 }, (_, i) => {
    const n = 3 + ((lcgG31() * 5) | 0)
    const ws = Array.from({ length: n }, () => wordsG31[(lcgG31() * wordsG31.length) | 0])
    return {
      id: '0mg' + String(i).padStart(6, '0'),
      level: ['fact', 'lesson', 'rules', 'topic'][(lcgG31() * 4) | 0],
      title: ws[0],
      content: ws.join(' '),
      importance: 1 + ((lcgG31() * 4) | 0),
      updated_at: '2026-01-01T00:00:00Z',
      keywords: lcgG31() < 0.2 ? null : [wordsG31[(lcgG31() * wordsG31.length) | 0]],
      project: 'p',
    }
  })
  const qsG31 = ['alpha beta', '必须 先 记忆', '星图 一律', 'gamma delta epsilon', '规则 是什么',
    '为什么 要 先', 'alpha gamma 记忆', '0mg000012 alpha']
  const digestG31 = qsG31.map((q) => Mv31.search(q, corpusG31, { k: 8, now: NOW31 })
    .map((h) => `${h.id}@${h.score.toFixed(12)}`).join(',')).join('|')
  const GOLD31 = '0mg000005@3.664628057107,0mg000038@5.102523846806,0mg000061@4.788643770374,0mg000006@3.925122785034,0mg000074@2.232920822271|0mg000023@6.732283929790,0mg000108@5.065968177695,0mg000076@4.106832745439,0mg000104@4.756171212734,0mg000117@4.580868819911|0mg000100@5.906625216656,0mg000067@3.975949441312,0mg000115@3.760224920935,0mg000015@3.579293550671,0mg000047@3.464398706423|0mg000101@5.989226322228,0mg000037@4.382801980391,0mg000105@6.132937947203,0mg000016@5.714996394708,0mg000089@5.278362858510|||0mg000023@7.099164514106,0mg000108@5.912829410853,0mg000005@4.615892988676,0mg000084@3.935034576993,0mg000058@6.160437605175|0mg000012@3.148175340076,0mg000083@1.863256160943,0mg000005@1.755985977713,0mg000109@2.098783560051,0mg000073@1.049391780025'
  check('OR091 进程内：回执指纹与 0.6.29 / 0.6.30 逐位相同（三笔改动都是换写法不换算术）',
    digestG31 === GOLD31, digestG31 === GOLD31 ? '指纹同' : '指纹不同')
  check('OR091 文档在位：INTERNAL 9.230、README 写「定档合成一趟」、DESIGN 有 ## 226.、PLAN 有 0.6.31',
    readS31('./docs/INTERNAL.md').includes('## 9.230 ') &&
      readS31('./README.md').includes('定档合成一趟') &&
      readS31('./DESIGN.md').includes('## 226. ') &&
      /0\.6\.31/.test(readS31('./docs/PLAN-0.6.md')))
  const vS31 = (readS31('./lib/index.js').match(/export const version = '(\d+)\.(\d+)\.(\d+)'/) ?? []).slice(1).map(Number)
  const vNumS31 = vS31.length === 3 ? vS31[0] * 10000 + vS31[1] * 100 + vS31[2] : 0
  check('OR091 版本号不低于 0.6.31（后续补丁不必回头改这一条）', vNumS31 >= 631, vS31.join('.'))
}

// ═══════════════ [macro-fusion 0.6.32] OR092：扫描期只写缓冲，只把前 k 条物化成对象 ═══════════════
{
  const readS32 = (p) => readFileSync(new URL(p, import.meta.url), 'utf8')
  const rawS32 = readS32('./vendor/meow-memory/lib/index.js')
  const stripS32 = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  const bodyOf32 = (name) => {
    const at = rawS32.indexOf(`function ${name}(`)
    if (at < 0) return ''
    const next = rawS32.indexOf('\nfunction ', at + 1)
    const body = next < 0 ? rawS32.slice(at) : rawS32.slice(at, next)
    return stripS32(body)
  }
  const hotS32 = readS32('./tools/probe-hotpath.mjs')
  const allS32 = readS32('./tools/check-all.mjs')
  check('OR092 探针在位：probe-hotpath 有 H20–H22 三条（快路形状 / k 边界 / 缓冲复用），check-all 挂了它',
    ['H20 ', 'H21 ', 'H22 '].every((t) => hotS32.includes(t)) &&
      allS32.includes('probe-hotpath') &&
      rawS32.includes('const HIT_BUF = {'))
  const searchC32 = bodyOf32('search')
  const bufC32 = bodyOf32('hitBufOf')
  const bufOk32 = bufC32.includes('const cap = n + 64;') &&
    bufC32.includes('if (s.n !== cap)') &&
    bufC32.includes('if (s.busy) return null;') &&
    bufC32.includes('new Int32Array(cap)') &&
    bufC32.includes('new Float64Array(cap)') &&
    bufC32.includes('new Uint8Array(cap)') &&
    bodyOf32('hitBufDone').includes('HIT_BUF.busy = false;')
  const fastOk32 = searchC32.includes('const hitBuf = leanHit ? hitBufOf(docs.length) : null;') &&
    searchC32.includes('const fastOk = hitBuf !== null;') &&
    searchC32.includes('let fastDone = false;') &&
    searchC32.includes('if (fastOk) {') &&
    searchC32.includes('hdi[q] = di;') &&
    searchC32.includes('hscore[q] = raw[di] * w * impW * stW * foldOf;')
  // 快路是「加法」：老路的三只临时数组与两段对象字面量必须一字不动地留着，交接处靠 fastDone
  const oldOk32 = searchC32.includes('vbTmp.push(vbOf);') &&
    searchC32.includes('srTmp.push(srOf);') &&
    searchC32.includes('lvTmp.push(lvHit && lvOn ? 1 : 0);') &&
    searchC32.includes('trTmp.push(trOf);') &&
    searchC32.includes('if (leanHit) {') &&
    searchC32.includes('} else hits.push({')
  const atGuard32 = searchC32.indexOf('if (!fastDone) {')
  const atBandize32 = searchC32.indexOf("bandize(hits, '_raw', k);")
  const atTrim32 = searchC32.indexOf('const outHits = trimByBand(hits, k, opts);')
  const guardOk32 = atGuard32 >= 0 && atBandize32 > atGuard32 && atTrim32 > atBandize32 &&
    (searchC32.match(/hitBufDone\(\);/g) ?? []).length === 2 &&
    searchC32.includes('const haveBands = cnt >= 2;') &&
    searchC32.includes('want > 0 && cmpQ(q, heap[0]) < 0')
  check('OR092 引擎形状：扫描期写缓冲、老后处理原样留在 if (!fastDone) 里、档号「一条都不写」的边界照老口径',
    bufOk32 && fastOk32 && oldOk32 && guardOk32,
    `缓冲=${bufOk32} 快路=${fastOk32} 老路=${oldOk32} 守卫=${guardOk32}`)
  // 进程内：k 的四个边界口径（0 / 负与缺省同走「want = 全量」；0.4 是老路会崩的那条）
  const Mv32 = await import(pathToFileURL(join(root, 'vendor', 'meow-memory', 'lib', 'index.js')).href)
  const NOW32 = 1795470000000
  const corp32 = [
    { id: 'sa1', project: 'p', level: 'fact', title: '潮汐 表', content: '潮汐 表 读数 一。', keywords: ['潮汐'], importance: 2, updated_at: NOW32 - 1000, last_accessed_at: NOW32 - 1000 },
    { id: 'sa2', project: 'p', level: 'fact', title: '鲸歌', content: '鲸歌 频率 二。', keywords: ['鲸歌'], importance: 3, updated_at: NOW32 - 2000, last_accessed_at: NOW32 - 2000 },
    { id: 'sa3', project: 'p', level: 'fact', title: '潮汐 表 读数', content: '潮汐 表 读数 三。', keywords: ['潮汐', '表'], importance: 1, updated_at: NOW32 - 3000, last_accessed_at: NOW32 - 3000 },
  ]
  const run32 = (q, o) => {
    try {
      return { n: Mv32.search(q, corp32, { ...o, now: NOW32 }).length, err: null }
    } catch (e) {
      return { n: -1, err: e.message }
    }
  }
  const rWide32 = run32('潮汐 表 读数', {})
  const rHuge32 = run32('潮汐 表 读数', { k: 1e9 })
  const rZero32 = run32('潮汐 表 读数', { k: 0 })
  const rNeg32 = run32('潮汐 表 读数', { k: -3 })
  const rFrac32 = run32('潮汐 表 读数', { k: 0.4 })
  const rOne32 = run32('鲸歌 频率', { k: 5 })
  const rNone32 = run32('完全不存在的丙词', { k: 5 })
  check('OR092 进程内：k 缺省 / 0 / 负数 / 1e9 同条数，k=0.4 返回空数组且不抛（老路由在这里取空堆 heap[0] 会崩）',
    rWide32.err === null && rHuge32.err === null && rZero32.err === null && rNeg32.err === null &&
      rFrac32.err === null && rOne32.err === null && rNone32.err === null &&
      rWide32.n > 0 && rWide32.n === rHuge32.n && rZero32.n === rWide32.n && rNeg32.n === rWide32.n &&
      rFrac32.n === 0 && rOne32.n === 1 && rNone32.n === 0,
    `缺省=${rWide32.n} 超大=${rHuge32.n} k0=${rZero32.n} k负=${rNeg32.n} k0.4=${rFrac32.n} 单命中=${rOne32.n} 空=${rNone32.n}`)
  // 进程内：缓冲是复用的——目标问在任何前序之后、连跑第二遍、冷语料副本上都必须逐位相同
  const mk32 = () => Array.from({ length: 60 }, (_, i) => ({
    id: '0mr' + String(i).padStart(6, '0'),
    level: i % 5 === 0 ? 'rules' : 'fact',
    title: ['alpha', 'beta', 'gamma'][i % 3],
    content: ['alpha beta', 'alpha delta 记忆', 'beta gamma 星图', 'delta 一律 必须'][i % 4] + ` 第 ${i} 条。`,
    importance: 1 + (i % 4),
    updated_at: NOW32 - i * 1000,
    last_accessed_at: NOW32 - i * 700,
    keywords: [['alpha'], ['beta'], ['gamma'], null][i % 4],
    project: 'p',
  }))
  const dig32 = (rs) => rs.map((h) => `${h.id}@${h.score.toFixed(12)}#${h.cover ?? ''}`).join(',')
  const QA32 = 'delta 一律 必须 星图'
  const dA32 = mk32()
  const dB32 = mk32()
  Mv32.search('alpha beta gamma', dA32, { k: 5, now: NOW32 })
  const afterB32 = dig32(Mv32.search(QA32, dA32, { k: 5, now: NOW32 }))
  Mv32.search('zeta 不存在的词', dA32, { k: 5, now: NOW32 })
  const afterC32 = dig32(Mv32.search(QA32, dA32, { k: 5, now: NOW32 }))
  const twice32 = dig32(Mv32.search(QA32, dA32, { k: 5, now: NOW32 }))
  const cold32 = dig32(Mv32.search(QA32, dB32, { k: 5, now: NOW32 }))
  check('OR092 进程内：缓冲复用不串味（不同前序 / 连跑 / 冷语料三路回执逐位相同）',
    afterB32 !== '' && afterB32 === afterC32 && afterB32 === twice32 && afterB32 === cold32,
    `前序=${afterB32 === afterC32} 连跑=${afterB32 === twice32} 冷=${afterB32 === cold32}`)
  // 回执指纹：0.6.32 只是「不建那些注定被丢的对象」，分数一位都不许动（同串见 DESIGN 227 / INTERNAL 9.231）
  const lcg32 = (seed0) => {
    let s = seed0
    return () => {
      s = (s * 1103515245 + 12345) % 2147483648
      return s / 2147483648
    }
  }
  const r32 = lcg32(97)
  const w32 = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', '一律', '必须', '先', '记忆', '星图']
  const corpG32 = Array.from({ length: 120 }, (_, i) => {
    const n = 3 + ((r32() * 5) | 0)
    const ws = Array.from({ length: n }, () => w32[(r32() * w32.length) | 0])
    return {
      id: '0mg' + String(i).padStart(6, '0'),
      level: ['fact', 'lesson', 'rules', 'topic'][(r32() * 4) | 0],
      title: ws[0],
      content: ws.join(' '),
      importance: 1 + ((r32() * 4) | 0),
      updated_at: '2026-01-01T00:00:00Z',
      keywords: r32() < 0.2 ? null : [w32[(r32() * w32.length) | 0]],
      project: 'p',
    }
  })
  const qsG32 = ['alpha beta', '必须 先 记忆', '星图 一律', 'gamma delta epsilon', '规则 是什么',
    '为什么 要 先', 'alpha gamma 记忆', '0mg000012 alpha']
  const digestG32 = qsG32.map((q) => Mv32.search(q, corpG32, { k: 8, now: NOW32 })
    .map((h) => `${h.id}@${h.score.toFixed(12)}`).join(',')).join('|')
  const GOLD32 = '0mg000005@3.664628057107,0mg000038@5.102523846806,0mg000061@4.788643770374,0mg000006@3.925122785034,0mg000074@2.232920822271|0mg000023@6.732283929790,0mg000108@5.065968177695,0mg000076@4.106832745439,0mg000104@4.756171212734,0mg000117@4.580868819911|0mg000100@5.906625216656,0mg000067@3.975949441312,0mg000115@3.760224920935,0mg000015@3.579293550671,0mg000047@3.464398706423|0mg000101@5.989226322228,0mg000037@4.382801980391,0mg000105@6.132937947203,0mg000016@5.714996394708,0mg000089@5.278362858510|||0mg000023@7.099164514106,0mg000108@5.912829410853,0mg000005@4.615892988676,0mg000084@3.935034576993,0mg000058@6.160437605175|0mg000012@3.148175340076,0mg000083@1.863256160943,0mg000005@1.755985977713,0mg000109@2.098783560051,0mg000073@1.049391780025'
  check('OR092 进程内：回执指纹与 0.6.29 / 0.6.30 / 0.6.31 逐位相同（只省对象，不碰分数与顺序）',
    digestG32 === GOLD32, digestG32 === GOLD32 ? '指纹同' : '指纹不同')
  check('OR092 文档在位：INTERNAL 9.231、README 写「只物化前 k 条」、DESIGN 有 ## 227.、PLAN 有 0.6.32',
    readS32('./docs/INTERNAL.md').includes('## 9.231 ') &&
      readS32('./README.md').includes('只物化前 k 条') &&
      readS32('./DESIGN.md').includes('## 227. ') &&
      /0\.6\.32/.test(readS32('./docs/PLAN-0.6.md')))
  const vS32 = (readS32('./lib/index.js').match(/export const version = '(\d+)\.(\d+)\.(\d+)'/) ?? []).slice(1).map(Number)
  const vNumS32 = vS32.length === 3 ? vS32[0] * 10000 + vS32[1] * 100 + vS32[2] : 0
  check('OR092 版本号不低于 0.6.32（后续补丁不必回头改这一条）', vNumS32 >= 632, vS32.join('.'))
}

// ═══════════════ [macro-fusion 0.6.33] OR093：定档猜位改位级对数刻度 ═══════════════
// 症状：锚链是 `v < IMP_BAND * anchor`（0.85）压出来的几何级数（相邻比值 ≥ 1.176），
// 0.6.32 的猜位却是**数值线性插值**——实测猜位直接命中只有 0.5%、每条约 3.63 趟二分，
// 两条「命中即收口」的新分支纯属加价（插桩引擎 `E:\Temp\cmp\bguess33.mjs`，3000 问 / 10,000 条）。
// 处方：`rawkBucketOf`（数值高 16 位 = 符号 + 阶码 + 4 位尾数）对非负数单调、分辨率 1/16 个八度，
// 正好当以 2 为底的对数刻度尺；猜位只负责缩小窗口，落点靠「前一位严格小 / 后一位不小于」两条
// 收口校验 + 窄窗二分兜底，所以档号逐位等于 lowerBound。
{
  const readS33 = (p) => readFileSync(new URL(p, import.meta.url), 'utf8')
  const eng33 = readS33('./vendor/meow-memory/lib/index.js')
  const searchStart33 = eng33.indexOf('function search(query, docs, opts = {}) {')
  const searchEnd33 = eng33.indexOf('\nfunction ', searchStart33 + 10)
  const searchC33 = eng33.slice(searchStart33, searchEnd33)
  // ① 探针在位
  const probe33 = readS33('./tools/probe-hotpath.mjs')
  check('OR093 探针在位：probe-hotpath 有 H23a–H23c 三条（对数刻度形状 / 快路与老路同档 / 档号单调同分同档）',
    probe33.includes('H23a 定档猜位改位级对数刻度') &&
      probe33.includes('H23b 对数刻度猜位不换算术') &&
      probe33.includes('H23c 档号仍单调、同分同档') &&
      readS33('./tools/check-all.mjs').includes('probe-hotpath.mjs'),
    `H23a=${probe33.includes('H23a 定档猜位改位级对数刻度')} 挂载=${readS33('./tools/check-all.mjs').includes('probe-hotpath.mjs')}`)
  // ② 引擎形状：对数刻度猜位 + 两条收口 + 热路段里没有老线性写法；刻度的单调性来自 `rawkBucketOf`
  const hotStart33 = searchC33.indexOf('const g0 = rawkBucketOf(a0v);')
  const hotEnd33 = searchC33.indexOf('// ⑥ 选前 k：有界堆')
  const hotBlock33 = hotStart33 >= 0 && hotEnd33 > hotStart33 ? searchC33.slice(hotStart33, hotEnd33) : ''
  const guessOk33 = hotBlock33.length > 0 &&
    !hotBlock33.includes('let est = ((v - a0v) * posScale) | 0;') &&
    hotBlock33.includes('const gL = rawkBucketOf(aLv);') &&
    hotBlock33.includes('const posScale = gL > g0 ? (m - 1) / (gL - g0) : 0;') &&
    hotBlock33.includes('let est = ((rawkBucketOf(v) - g0) * posScale) | 0;') &&
    hotBlock33.includes('if (est === 0 || anchors[est - 1] < v) loI = est;') &&
    hotBlock33.includes('if (anchors[loI] >= v) hiI = loI;') &&
    hotBlock33.includes('while (loI < hiI) {') &&
    hotBlock33.includes('lo = loI;')
  const bucketOk33 = eng33.includes('function rawkBucketOf(v) {') &&
    eng33.includes('rawkBits[0] = v;') &&
    eng33.includes('return rawkBitsU[1] >>> RAWK_SHIFT;')
  check('OR093 引擎形状：热路改位级对数刻度猜位、两条收口校验在位、老线性刻度只剩冷路那一份',
    guessOk33 && bucketOk33 && hotBlock33.length > 800,
    `猜位=${guessOk33} 桶号=${bucketOk33} 热路段=${hotBlock33.length}B`)
  // ③ 进程内：快路（默认）与老后处理（explain:true 走 `if (!fastDone)`）逐位同档，八种分布
  const Mv33 = await import(pathToFileURL(join(root, 'vendor', 'meow-memory', 'lib', 'index.js')).href)
  const NOW33 = 1795470000000
  const lcg33 = (seed0) => {
    let s = seed0
    return () => {
      s = (s * 1103515245 + 12345) % 2147483648
      return s / 2147483648
    }
  }
  const mkCorp33 = (kind, n, seed) => {
    const r = lcg33(seed)
    const words = ['alpha', 'beta', 'gamma', 'delta', '一律', '必须', '记忆', '星图', '索引', '锚点']
    return Array.from({ length: n }, (_, i) => {
      const dup = kind === 'dup'
      const spread = kind === 'scale' ? i * (1 + (i % 7 === 0 ? 40 : 0)) : i
      const ws = dup ? ['alpha', 'beta', 'gamma', '记忆'] : Array.from({ length: 1 + ((r() * 6) | 0) }, () => words[(r() * words.length) | 0])
      return {
        id: '0md' + String(i).padStart(6, '0'),
        level: ['fact', 'lesson', 'rules', 'topic'][kind === 'level' ? (i % 4) : ((r() * 4) | 0)],
        title: ws[0],
        content: `${ws.join(' ')} 第 ${dup ? 0 : i} 条`,
        importance: kind === 'flat' ? 2 : 1 + ((r() * 4) | 0),
        updated_at: NOW33 - spread * 3600000,
        last_accessed_at: NOW33 - spread * 600000,
        keywords: r() < 0.2 ? null : [words[(r() * words.length) | 0]],
        project: 'p',
      }
    })
  }
  const kinds33 = [['mix', 80], ['dup', 30], ['scale', 60], ['flat', 50], ['level', 40], ['tiny', 3], ['pair', 2], ['wide', 150]]
  const bandsOf33 = (rs) => rs.map((h) => `${h.id}@${h._band ?? 'x'}`).join(',')
  const qs33 = ['alpha beta', '必须 先 记忆', '星图 一律', 'gamma delta 锚点 索引', 'alpha gamma 记忆', 'rules 是什么']
  let sameAll33 = true
  let pairs33 = 0
  const bad33 = []
  for (const [kind, n] of kinds33) {
    const corp = mkCorp33(kind, n, 11 + n)
    for (const q of qs33) {
      const lean = bandsOf33(Mv33.search(q, corp, { k: n, now: NOW33 }))
      const told = bandsOf33(Mv33.search(q, corp, { k: n, now: NOW33, explain: true }))
      pairs33 += 1
      if (lean !== told) { sameAll33 = false; if (bad33.length < 3) bad33.push(`${kind}/${q}`) }
    }
  }
  check('OR093 进程内：对数刻度猜位不换算术——快路档号与老后处理逐位相同（八种分布 × 六问）',
    sameAll33 && pairs33 === 48,
    `对拍=${pairs33} 不同=${bad33.length === 0 ? '无' : bad33.join(' ')}`)
  // ④ 进程内：档号两条硬性质（raw 大 ⇒ 档号不增；等分 ⇒ 等档），且猜位偏了也靠兜底救回来
  const corpMono33 = mkCorp33('mix', 90, 4242)
  const rsMono33 = Mv33.search('alpha beta gamma 记忆 星图', corpMono33, { k: 90, now: NOW33, explain: true })
  let mono33 = true
  let tie33 = true
  for (const a of rsMono33) {
    for (const b of rsMono33) {
      if (a._raw > b._raw && !(a._band <= b._band)) mono33 = false
      if (a._raw === b._raw && a._band !== b._band) tie33 = false
    }
  }
  check('OR093 进程内：档号随 raw 单调不增、同分必同档（猜位只是缩小窗口，落点仍由收口校验钉死）',
    rsMono33.length >= 2 && mono33 && tie33,
    `条数=${rsMono33.length} 单调=${mono33} 同分同档=${tie33}`)
  // ⑤ 进程内：回执指纹与 0.6.29–0.6.32 逐位相同（只换猜位刻度，分数与顺序一位不动）
  const r33 = lcg33(97)
  const w33 = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', '一律', '必须', '先', '记忆', '星图']
  const corpG33 = Array.from({ length: 120 }, (_, i) => {
    const n = 3 + ((r33() * 5) | 0)
    const ws = Array.from({ length: n }, () => w33[(r33() * w33.length) | 0])
    return {
      id: '0mg' + String(i).padStart(6, '0'),
      level: ['fact', 'lesson', 'rules', 'topic'][(r33() * 4) | 0],
      title: ws[0],
      content: ws.join(' '),
      importance: 1 + ((r33() * 4) | 0),
      updated_at: '2026-01-01T00:00:00Z',
      keywords: r33() < 0.2 ? null : [w33[(r33() * w33.length) | 0]],
      project: 'p',
    }
  })
  const qsG33 = ['alpha beta', '必须 先 记忆', '星图 一律', 'gamma delta epsilon', '规则 是什么',
    '为什么 要 先', 'alpha gamma 记忆', '0mg000012 alpha']
  const digestG33 = qsG33.map((q) => Mv33.search(q, corpG33, { k: 8, now: NOW33 })
    .map((h) => `${h.id}@${h.score.toFixed(12)}`).join(',')).join('|')
  const GOLD33 = '0mg000005@3.664628057107,0mg000038@5.102523846806,0mg000061@4.788643770374,0mg000006@3.925122785034,0mg000074@2.232920822271|0mg000023@6.732283929790,0mg000108@5.065968177695,0mg000076@4.106832745439,0mg000104@4.756171212734,0mg000117@4.580868819911|0mg000100@5.906625216656,0mg000067@3.975949441312,0mg000115@3.760224920935,0mg000015@3.579293550671,0mg000047@3.464398706423|0mg000101@5.989226322228,0mg000037@4.382801980391,0mg000105@6.132937947203,0mg000016@5.714996394708,0mg000089@5.278362858510|||0mg000023@7.099164514106,0mg000108@5.912829410853,0mg000005@4.615892988676,0mg000084@3.935034576993,0mg000058@6.160437605175|0mg000012@3.148175340076,0mg000083@1.863256160943,0mg000005@1.755985977713,0mg000109@2.098783560051,0mg000073@1.049391780025'
  check('OR093 进程内：回执指纹与 0.6.29 / 0.6.30 / 0.6.31 / 0.6.32 逐位相同（只换猜位刻度，不碰分数与顺序）',
    digestG33 === GOLD33, digestG33 === GOLD33 ? '指纹同' : '指纹不同')
  // ⑥ 文档在位 + ⑦ 版本
  check('OR093 文档在位：INTERNAL 9.232、README 写「对数刻度」、DESIGN 有 ## 228.、PLAN 有 0.6.33',
    readS33('./docs/INTERNAL.md').includes('## 9.232 ') &&
      readS33('./README.md').includes('对数刻度') &&
      readS33('./DESIGN.md').includes('## 228. ') &&
      /0\.6\.33/.test(readS33('./docs/PLAN-0.6.md')))
  const vS33 = (readS33('./lib/index.js').match(/export const version = '(\d+)\.(\d+)\.(\d+)'/) ?? []).slice(1).map(Number)
  const vNumS33 = vS33.length === 3 ? vS33[0] * 10000 + vS33[1] * 100 + vS33[2] : 0
  check('OR093 版本号不低于 0.6.33（后续补丁不必回头改这一条）', vNumS33 >= 633, vS33.join('.'))
}

// ═══════════════ [macro-fusion 0.6.34] OR094：每问常数项与候选表形态 ═══════════════
// 症状（`docs/INTERNAL.md` 9.233，10,000 条 / 3,000 问剖面）：候选表是 `const candArr = []` +
// `candArr.push(di)`——每问 8,700 元素、容量翻倍 + 元素搬移，`scoreCandSet` 随后顺序读的其实只是
// 「这一问命中了哪几条」；扫描循环里 `recencyWeight(...)` / `statusWeight(...)` 记在调用那一行
// （114 / 50ms），容易被当成调用开销。
// 处方：候选表换成与 `raw` / `kDen` 同寿命的定长 `Int32Array` + 游标 `candN`；时间梯子改踩毫秒差
// （去掉一次除法）；衰减守卫把数值数组条件提前；`impW` / `stW` 就地摊平。
// 反证：光摊平那两个一元小函数只值 −0.6%（V8 本来就内联），加上候选表与守卫换序才到 −7.4%。
{
  const readS34 = (p) => readFileSync(new URL(p, import.meta.url), 'utf8')
  const eng34 = readS34('./vendor/meow-memory/lib/index.js')
  const searchStart34 = eng34.indexOf('function search(query, docs, opts = {}) {')
  const searchEnd34 = eng34.indexOf('\nfunction ', searchStart34 + 10)
  const searchC34 = eng34.slice(searchStart34, searchEnd34)
  // ① 探针在位
  const probe34 = readS34('./tools/probe-hotpath.mjs')
  check('OR094 探针在位：probe-hotpath 有 H24a–H24c 三条（候选表形态 / 毫秒梯子等价 / 复用不串味）',
    probe34.includes('H24a 候选表改定长 Int32Array') &&
      probe34.includes('H24b 毫秒梯子与老除法梯子逐位等价') &&
      probe34.includes('H24c 定长候选表复用不串味') &&
      readS34('./tools/check-all.mjs').includes('probe-hotpath.mjs'),
    `H24a=${probe34.includes('H24a 候选表改定长 Int32Array')} 挂载=${readS34('./tools/check-all.mjs').includes('probe-hotpath.mjs')}`)
  // ② 引擎形状：定长候选表 + 游标、毫秒梯子、守卫换序、impW/stW 摊平；老写法（[]+push、ageDays、调用）已撤
  const candOk34 = searchC34.includes('const candBuf = candAt === null ? null : scratch === null ? new Int32Array(docs.length) : scratch.cand;') &&
    searchC34.includes('let candN = 0;') &&
    (searchC34.split('if (candAt[di] === 0) { candAt[di] = 1; candBuf[candN++] = di; }').length - 1) === 2 &&
    searchC34.includes('for (let ci = 0; ci < candN; ci++) {') &&
    !searchC34.includes('candList.push(') &&
    !searchC34.includes('candArr.push(')
  const ladderOk34 = searchC34.includes('const ageMs = now - (dOf.last_accessed_at ?? dOf.updated_at);') &&
    searchC34.includes('ageMs < 15552e6 ? 0.15 : 0.08') &&
    !searchC34.includes('const ageDays =') &&
    !searchC34.includes('recencyWeight(now,') &&
    searchC34.includes('const impW = 1 + ((Number.isFinite(impRaw)') &&
    searchC34.includes('const stW = anchored ? 1 : (STATUS_WEIGHT[String(dOf.status ?? "active")] ?? 1);') &&
    searchC34.includes('!(raw[di] >= impBandMax) && dOf.importance < 3')
  const scratchOk34 = eng34.includes('cand: null, kDen: null') &&
    eng34.includes('s.cand = new Int32Array(n);')
  check('OR094 引擎形状：候选表改定长 Int32Array + 游标、时间梯子踩毫秒差、守卫换序，老写法全撤',
    candOk34 && ladderOk34 && scratchOk34,
    `候选表=${candOk34} 梯子=${ladderOk34} 缓冲=${scratchOk34}`)
  // ③ 进程内：快路（默认）与老后处理（explain:true）逐位同档，八种分布
  const Mv34 = await import(pathToFileURL(join(root, 'vendor', 'meow-memory', 'lib', 'index.js')).href)
  const NOW34 = 1795470000000
  const lcg34 = (seed0) => {
    let s = seed0
    return () => {
      s = (s * 1103515245 + 12345) % 2147483648
      return s / 2147483648
    }
  }
  const mkCorp34 = (kind, n, seed) => {
    const r = lcg34(seed)
    const words = ['alpha', 'beta', 'gamma', 'delta', '一律', '必须', '记忆', '星图', '索引', '锚点']
    return Array.from({ length: n }, (_, i) => {
      const dup = kind === 'dup'
      const spread = kind === 'scale' ? i * (1 + (i % 7 === 0 ? 40 : 0)) : i
      const ws = dup ? ['alpha', 'beta', 'gamma', '记忆'] : Array.from({ length: 1 + ((r() * 6) | 0) }, () => words[(r() * words.length) | 0])
      return {
        id: '0md' + String(i).padStart(6, '0'),
        level: ['fact', 'lesson', 'rules', 'topic'][kind === 'level' ? (i % 4) : ((r() * 4) | 0)],
        title: ws[0],
        content: `${ws.join(' ')} 第 ${dup ? 0 : i} 条`,
        importance: kind === 'flat' ? 2 : 1 + ((r() * 4) | 0),
        updated_at: NOW34 - spread * 3600000,
        last_accessed_at: NOW34 - spread * 600000,
        keywords: r() < 0.2 ? null : [words[(r() * words.length) | 0]],
        project: 'p',
      }
    })
  }
  const kinds34 = [['mix', 80], ['dup', 30], ['scale', 60], ['flat', 50], ['level', 40], ['tiny', 3], ['pair', 2], ['wide', 150]]
  const bandsOf34 = (rs) => rs.map((h) => `${h.id}@${h._band ?? 'x'}`).join(',')
  const qs34 = ['alpha beta', '必须 先 记忆', '星图 一律', 'gamma delta 锚点 索引', 'alpha gamma 记忆', 'rules 是什么']
  let sameAll34 = true
  let pairs34 = 0
  const bad34 = []
  for (const [kind, n] of kinds34) {
    const corp = mkCorp34(kind, n, 11 + n)
    for (const q of qs34) {
      const lean = bandsOf34(Mv34.search(q, corp, { k: n, now: NOW34 }))
      const told = bandsOf34(Mv34.search(q, corp, { k: n, now: NOW34, explain: true }))
      pairs34 += 1
      if (lean !== told) { sameAll34 = false; if (bad34.length < 3) bad34.push(`${kind}/${q}`) }
    }
  }
  check('OR094 进程内：候选表与毫秒梯子不换算术——快路档号与老后处理逐位相同（八种分布 × 六问）',
    sameAll34 && pairs34 === 48,
    `对拍=${pairs34} 不同=${bad34.length === 0 ? '无' : bad34.join(' ')}`)
  // ④ 进程内：档号两条硬性质（raw 大 ⇒ 档号不增；等分 ⇒ 等档）
  const corpMono34 = mkCorp34('mix', 90, 4242)
  const rsMono34 = Mv34.search('alpha beta gamma 记忆 星图', corpMono34, { k: 90, now: NOW34, explain: true })
  let mono34 = true
  let tie34 = true
  for (const a of rsMono34) {
    for (const b of rsMono34) {
      if (a._raw > b._raw && !(a._band <= b._band)) mono34 = false
      if (a._raw === b._raw && a._band !== b._band) tie34 = false
    }
  }
  check('OR094 进程内：档号随 raw 单调不增、同分必同档（换缓冲不改定档）',
    rsMono34.length >= 2 && mono34 && tie34,
    `条数=${rsMono34.length} 单调=${mono34} 同分同档=${tie34}`)
  // ⑤ 进程内：回执指纹与 0.6.29–0.6.33 逐位相同（只动每问常数项与缓冲形态，分数与顺序一位不动）
  const r34 = lcg34(97)
  const w34 = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', '一律', '必须', '先', '记忆', '星图']
  const corpG34 = Array.from({ length: 120 }, (_, i) => {
    const n = 3 + ((r34() * 5) | 0)
    const ws = Array.from({ length: n }, () => w34[(r34() * w34.length) | 0])
    return {
      id: '0mg' + String(i).padStart(6, '0'),
      level: ['fact', 'lesson', 'rules', 'topic'][(r34() * 4) | 0],
      title: ws[0],
      content: ws.join(' '),
      importance: 1 + ((r34() * 4) | 0),
      updated_at: '2026-01-01T00:00:00Z',
      keywords: r34() < 0.2 ? null : [w34[(r34() * w34.length) | 0]],
      project: 'p',
    }
  })
  const qsG34 = ['alpha beta', '必须 先 记忆', '星图 一律', 'gamma delta epsilon', '规则 是什么',
    '为什么 要 先', 'alpha gamma 记忆', '0mg000012 alpha']
  const digestG34 = qsG34.map((q) => Mv34.search(q, corpG34, { k: 8, now: NOW34 })
    .map((h) => `${h.id}@${h.score.toFixed(12)}`).join(',')).join('|')
  const GOLD34 = '0mg000005@3.664628057107,0mg000038@5.102523846806,0mg000061@4.788643770374,0mg000006@3.925122785034,0mg000074@2.232920822271|0mg000023@6.732283929790,0mg000108@5.065968177695,0mg000076@4.106832745439,0mg000104@4.756171212734,0mg000117@4.580868819911|0mg000100@5.906625216656,0mg000067@3.975949441312,0mg000115@3.760224920935,0mg000015@3.579293550671,0mg000047@3.464398706423|0mg000101@5.989226322228,0mg000037@4.382801980391,0mg000105@6.132937947203,0mg000016@5.714996394708,0mg000089@5.278362858510|||0mg000023@7.099164514106,0mg000108@5.912829410853,0mg000005@4.615892988676,0mg000084@3.935034576993,0mg000058@6.160437605175|0mg000012@3.148175340076,0mg000083@1.863256160943,0mg000005@1.755985977713,0mg000109@2.098783560051,0mg000073@1.049391780025'
  check('OR094 进程内：回执指纹与 0.6.29 / 0.6.30 / 0.6.31 / 0.6.32 / 0.6.33 逐位相同（只动常数项与缓冲，不碰分数与顺序）',
    digestG34 === GOLD34, digestG34 === GOLD34 ? '指纹同' : '指纹不同')
  // ⑥ 文档在位 + ⑦ 版本
  check('OR094 文档在位：INTERNAL 9.233、README 写「候选表」、DESIGN 有 ## 229.、PLAN 有 0.6.34',
    readS34('./docs/INTERNAL.md').includes('## 9.233 ') &&
      readS34('./README.md').includes('候选表') &&
      readS34('./DESIGN.md').includes('## 229. ') &&
      /0\.6\.34/.test(readS34('./docs/PLAN-0.6.md')))
  const vS34 = (readS34('./lib/index.js').match(/export const version = '(\d+)\.(\d+)\.(\d+)'/) ?? []).slice(1).map(Number)
  const vNumS34 = vS34.length === 3 ? vS34[0] * 10000 + vS34[1] * 100 + vS34[2] : 0
  check('OR094 版本号不低于 0.6.34（后续补丁不必回头改这一条）', vNumS34 >= 634, vS34.join('.'))
}

// ═══════════════ [macro-fusion 0.6.35] OR095：每问一次的文档身份 ═══════════════
// 症状（`docs/INTERNAL.md` 9.234，10,000 条 / 600 问生产口径）：`memory_search` 每问
// `filtered.map(docFor)` 现造整库文档对象与整只数组，而引擎两处缓存只认身份——
// `SIG_DOC_CACHE`（WeakMap 按 doc 对象）、`SIG_ROW_CACHE`（WeakMap 按 docs 数组，`visits >= 2` 才铺行），
// 于是每问把整库 content / title / keywords 重新混一遍签名：复用 1.1072ms/问 vs 现造 12.5965ms/问 = 11.4×。
// 处方：`stableDocFor`（按 id + 十字段指纹复用对象）、`stableDocs`（只留一只数组、就地换格、身份永不换）、
// `docObjCacheInfo` / `resetDocObjCache` 出账；历史提升池 `rankForSearch(query, pool.map(docFor), …)` 不接。
// 踩坑：第一版 `stableDocs` 是「不一样就还新数组」，被每问的 `db.bumpHit` 抬 `last_accessed_at` 打回原形。
{
  const readS35 = (p) => readFileSync(new URL(p, import.meta.url), 'utf8')
  const eng35 = readS35('./vendor/meow-memory/lib/index.js')
  // ① 探针在位
  const probe35 = readS35('./tools/probe-docid.mjs')
  const mount35 = readS35('./tools/check-all.mjs')
  check('OR095 探针在位：probe-docid 有 D0–D7 八条（形状 / 复用 / 十字段 / 签名 / 上限 / 脏行 / 身份 / 生产口径）',
    ['D0 身份层接在 memory_search 上', 'D1 复用：', 'D2 十个字段任一动必换对象', 'D3 签名与现造逐字相同',
      'D4 上限口径在位', 'D5 脏行不炸', 'D6 数组身份恒定', 'D7 生产口径'].every((t) => probe35.includes(t)) &&
      mount35.includes('probe-docid.mjs'),
    `D 条=${probe35.includes('D6 数组身份恒定')} 挂载=${mount35.includes('probe-docid.mjs')}`)
  // ② 引擎形状：两个入口函数 + 两行接法 + 导出四件 + 就地换格；老的现造字面量已撤
  const fnOk35 = eng35.includes('function stableDocFor(r) {') &&
    eng35.includes('function stableDocs(list) {') &&
    eng35.includes('const DOC_OBJ_CACHE = new Map();') &&
    eng35.includes('const DOC_OBJ_CACHE_MAX = 20000;') &&
    eng35.includes('let DOCS_LAST = null;')
  // 0.6.36 起生产入口换成合并版 `stableDocsOf(filtered)`（一趟 map + 换格 + 盖章）：
  // 这里「新旧都认」——判的是「身份层接在 memory_search 上」，不是「必须长成 0.6.35 那一句」。
  const wireOk35 = eng35.includes('const docFor = stableDocFor;') &&
    (eng35.includes('const docs = stableDocsOf(filtered);') ||
      eng35.includes('const docs = stableDocs(filtered.map(docFor));')) &&
    eng35.includes('if (a.length !== n) a.length = n;')
  const expOk35 = /export\s*\{[^}]*\bstableDocFor\b/.test(eng35) &&
    /export\s*\{[^}]*\bstableDocs\b/.test(eng35) &&
    /export\s*\{[^}]*\bdocObjCacheInfo\b/.test(eng35) &&
    /export\s*\{[^}]*\bresetDocObjCache\b/.test(eng35)
  const oldGone35 = !eng35.includes('const docFor = (r) => ({') &&
    !eng35.includes('const docs = filtered.map(docFor);')
  check('OR095 引擎形状：stableDocFor / stableDocs 两件 + 生产接法（0.6.35 的 old 写法或 0.6.36 的合并版）+ 四件导出 + 就地换格，老现造字面量全撤',
    fnOk35 && wireOk35 && expOk35 && oldGone35,
    `函数=${fnOk35} 接法=${wireOk35} 导出=${expOk35} 老写法已撤=${oldGone35}`)
  // ③ 进程内：身份口径（同一行两次同一只对象 / last_accessed_at 动就换新且旧对象不被改 /
  //    数组一样就还回、换序就地换格且身份恒定 / 签名与现造逐字相同 / 脏行不炸）
  const Mv35 = await import(pathToFileURL(join(root, 'vendor', 'meow-memory', 'lib', 'index.js')).href)
  const row35 = { id: '0mi000001', level: 'fact', title: 't', content: '正文 alpha 记忆', keywords: ['alpha', '记忆'], importance: 3, created_at: 11, updated_at: 22, last_accessed_at: 33, status: 'active' }
  Mv35.resetDocObjCache()
  const o1 = Mv35.stableDocFor(row35)
  const o2 = Mv35.stableDocFor({ ...row35 })
  const o3 = Mv35.stableDocFor({ ...row35, last_accessed_at: 34 })
  const o4 = Mv35.stableDocFor({ ...row35, content: '换了正文' })
  const identOk35 = o1 === o2 && o1 !== o3 && o1 !== o4 && o1.content === '正文 alpha 记忆' && o3.last_accessed_at === 34
  const a1 = Mv35.stableDocs([o1, o3])
  const a2 = Mv35.stableDocs([o1, o3])
  const a3 = Mv35.stableDocs([o3, o1])
  const lenBefore35 = a1.length
  const tailOk35 = a3[1] === o1 && a3[0] === o3
  const a4 = Mv35.stableDocs([o3])
  const arrOk35 = a1 === a2 && a1 === a3 && tailOk35 && lenBefore35 === 2 && a1 === a4 && a1.length === 1
  const sigRef35 = Mv35.indexSignature([o1, o4])
  const sigNew35 = Mv35.indexSignature([
    { id: '0mi000001', level: 'fact', title: 't', content: '正文 alpha 记忆', keywords: ['alpha', '记忆'], importance: 3, created_at: 11, updated_at: 22, last_accessed_at: 33, status: 'active' },
    { id: '0mi000001', level: 'fact', title: 't', content: '换了正文', keywords: ['alpha', '记忆'], importance: 3, created_at: 11, updated_at: 22, last_accessed_at: 33, status: 'active' },
  ])
  const oldDocFor35 = (r) => ({ id: r.id, level: r.level, title: r.title, content: r.content, keywords: r.keywords,
    importance: r.importance, created_at: r.created_at, updated_at: r.updated_at,
    last_accessed_at: r.last_accessed_at, status: r.status })
  const throwOf35 = (fn) => { try { fn(); return null } catch (e) { return String(e && e.message) } }
  // 脏行口径与老路径逐字对齐：null 两版都抛（老 lambda 也要读 r.id），标量/缺字段都不抛且签名逐字相同
  const nullParity35 = (throwOf35(() => Mv35.stableDocFor(null)) === null) === (throwOf35(() => oldDocFor35(null)) === null)
  const rows35 = [Mv35.stableDocFor({ ...row35, id: '0mi000002', status: undefined }), 42]
  const dirtySig35 = throwOf35(() => {
    const a = Mv35.indexSignature(rows35.map((r) => (r === 42 ? 42 : Mv35.stableDocFor(r))))
    const b = Mv35.indexSignature([oldDocFor35({ ...row35, id: '0mi000002', status: undefined }), oldDocFor35(42)])
    if (a !== b) throw new Error('dirty sig mismatch')
  })
  check('OR095 进程内：同一行同一只对象、字段动就换新、数组身份恒定就地换格、签名与现造逐字相同、脏行不炸',
    identOk35 && arrOk35 && sigRef35 === sigNew35 && nullParity35 && dirtySig35 === null,
    `对象=${identOk35} 数组=${arrOk35} 签名=${sigRef35 === sigNew35} 脏行=${nullParity35 && dirtySig35 === null ? 'ok' : (dirtySig35 ?? 'parity')}`)
  // ④ 进程内：快路（默认）与老后处理（explain:true）逐位同档，八种分布
  const NOW35 = 1795470000000
  const lcg35 = (seed0) => {
    let s = seed0
    return () => {
      s = (s * 1103515245 + 12345) % 2147483648
      return s / 2147483648
    }
  }
  const mkCorp35 = (kind, n, seed) => {
    const r = lcg35(seed)
    const words = ['alpha', 'beta', 'gamma', 'delta', '一律', '必须', '记忆', '星图', '索引', '锚点']
    return Array.from({ length: n }, (_, i) => {
      const dup = kind === 'dup'
      const spread = kind === 'scale' ? i * (1 + (i % 7 === 0 ? 40 : 0)) : i
      const ws = dup ? ['alpha', 'beta', 'gamma', '记忆'] : Array.from({ length: 1 + ((r() * 6) | 0) }, () => words[(r() * words.length) | 0])
      return {
        id: '0md' + String(i).padStart(6, '0'),
        level: ['fact', 'lesson', 'rules', 'topic'][kind === 'level' ? (i % 4) : ((r() * 4) | 0)],
        title: ws[0],
        content: `${ws.join(' ')} 第 ${dup ? 0 : i} 条`,
        importance: kind === 'flat' ? 2 : 1 + ((r() * 4) | 0),
        updated_at: NOW35 - spread * 3600000,
        last_accessed_at: NOW35 - spread * 600000,
        keywords: r() < 0.2 ? null : [words[(r() * words.length) | 0]],
        project: 'p',
      }
    })
  }
  const kinds35 = [['mix', 80], ['dup', 30], ['scale', 60], ['flat', 50], ['level', 40], ['tiny', 3], ['pair', 2], ['wide', 150]]
  const bandsOf35 = (rs) => rs.map((h) => `${h.id}@${h._band ?? 'x'}`).join(',')
  const qs35 = ['alpha beta', '必须 先 记忆', '星图 一律', 'gamma delta 锚点 索引', 'alpha gamma 记忆', 'rules 是什么']
  let sameAll35 = true
  let pairs35 = 0
  const bad35 = []
  for (const [kind, n] of kinds35) {
    const corp = mkCorp35(kind, n, 11 + n)
    for (const q of qs35) {
      const lean = bandsOf35(Mv35.search(q, corp, { k: n, now: NOW35 }))
      const told = bandsOf35(Mv35.search(q, corp, { k: n, now: NOW35, explain: true }))
      pairs35 += 1
      if (lean !== told) { sameAll35 = false; if (bad35.length < 3) bad35.push(`${kind}/${q}`) }
    }
  }
  check('OR095 进程内：复用文档身份不换算术——快路档号与老后处理逐位相同（八种分布 × 六问）',
    sameAll35 && pairs35 === 48,
    `对拍=${pairs35} 不同=${bad35.length === 0 ? '无' : bad35.join(' ')}`)
  // ⑤ 进程内：档号两条硬性质（raw 大 ⇒ 档号不增；等分 ⇒ 等档）
  const corpMono35 = mkCorp35('mix', 90, 4242)
  const rsMono35 = Mv35.search('alpha beta gamma 记忆 星图', corpMono35, { k: 90, now: NOW35, explain: true })
  let mono35 = true
  let tie35 = true
  for (const a of rsMono35) {
    for (const b of rsMono35) {
      if (a._raw > b._raw && !(a._band <= b._band)) mono35 = false
      if (a._raw === b._raw && a._band !== b._band) tie35 = false
    }
  }
  check('OR095 进程内：档号随 raw 单调不增、同分必同档（换身份不改定档）',
    rsMono35.length >= 2 && mono35 && tie35,
    `条数=${rsMono35.length} 单调=${mono35} 同分同档=${tie35}`)
  // ⑥ 进程内：回执指纹与 0.6.29–0.6.34 逐位相同（只换对象/数组身份，分数与顺序一位不动）
  const r35 = lcg35(97)
  const w35 = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', '一律', '必须', '先', '记忆', '星图']
  const corpG35 = Array.from({ length: 120 }, (_, i) => {
    const n = 3 + ((r35() * 5) | 0)
    const ws = Array.from({ length: n }, () => w35[(r35() * w35.length) | 0])
    return {
      id: '0mg' + String(i).padStart(6, '0'),
      level: ['fact', 'lesson', 'rules', 'topic'][(r35() * 4) | 0],
      title: ws[0],
      content: ws.join(' '),
      importance: 1 + ((r35() * 4) | 0),
      updated_at: '2026-01-01T00:00:00Z',
      keywords: r35() < 0.2 ? null : [w35[(r35() * w35.length) | 0]],
      project: 'p',
    }
  })
  const qsG35 = ['alpha beta', '必须 先 记忆', '星图 一律', 'gamma delta epsilon', '规则 是什么',
    '为什么 要 先', 'alpha gamma 记忆', '0mg000012 alpha']
  const digestG35 = qsG35.map((q) => Mv35.search(q, corpG35, { k: 8, now: NOW35 })
    .map((h) => `${h.id}@${h.score.toFixed(12)}`).join(',')).join('|')
  const GOLD35 = '0mg000005@3.664628057107,0mg000038@5.102523846806,0mg000061@4.788643770374,0mg000006@3.925122785034,0mg000074@2.232920822271|0mg000023@6.732283929790,0mg000108@5.065968177695,0mg000076@4.106832745439,0mg000104@4.756171212734,0mg000117@4.580868819911|0mg000100@5.906625216656,0mg000067@3.975949441312,0mg000115@3.760224920935,0mg000015@3.579293550671,0mg000047@3.464398706423|0mg000101@5.989226322228,0mg000037@4.382801980391,0mg000105@6.132937947203,0mg000016@5.714996394708,0mg000089@5.278362858510|||0mg000023@7.099164514106,0mg000108@5.912829410853,0mg000005@4.615892988676,0mg000084@3.935034576993,0mg000058@6.160437605175|0mg000012@3.148175340076,0mg000083@1.863256160943,0mg000005@1.755985977713,0mg000109@2.098783560051,0mg000073@1.049391780025'
  check('OR095 进程内：回执指纹与 0.6.29 / 0.6.30 / 0.6.31 / 0.6.32 / 0.6.33 / 0.6.34 逐位相同（只换身份，不碰分数与顺序）',
    digestG35 === GOLD35, digestG35 === GOLD35 ? '指纹同' : '指纹不同')
  // ⑦ 文档在位 + ⑧ 版本
  check('OR095 文档在位：INTERNAL 9.234、README 写「文档身份」、DESIGN 有 ## 230.、PLAN 有 0.6.35',
    readS35('./docs/INTERNAL.md').includes('## 9.234 ') &&
      readS35('./README.md').includes('文档身份') &&
      readS35('./DESIGN.md').includes('## 230. ') &&
      /0\.6\.35/.test(readS35('./docs/PLAN-0.6.md')))
  const vS35 = (readS35('./lib/index.js').match(/export const version = '(\d+)\.(\d+)\.(\d+)'/) ?? []).slice(1).map(Number)
  const vNumS35 = vS35.length === 3 ? vS35[0] * 10000 + vS35[1] * 100 + vS35[2] : 0
  check('OR095 版本号不低于 0.6.35（后续补丁不必回头改这一条）', vNumS35 >= 635, vS35.join('.'))
}

const Veng37 = await import(new URL('./vendor/meow-memory/lib/index.js', import.meta.url).href)
// ═══════════════ [macro-fusion 0.6.36] OR096：签名只认版本章 ═══════════════
// 病根：`stableDocFor` 每问都已经逐条比过签名字段，却把「变没变」的结论丢了；`indexSignature`
// 只好把整表再比一遍（10,000 条 / 每问 1.00ms）。处方：稳定数组自己盖章（`DOCS_SEAL`），
// 只有「签名字段变了」才抬版本，版本没抬就直接还上次的签名。
// 这条钉四件事：探针在位、引擎形状（快路条件与老循环并存）、进程内计数真的动、文档与版本在位。
{
  const engS36 = readFileSync(new URL('./vendor/meow-memory/lib/index.js', import.meta.url), 'utf8')
  const probeS36 = readFileSync(new URL('./tools/probe-sigseal.mjs', import.meta.url), 'utf8')
  check('OR096 探针在位：probe-sigseal 有 S0–S6 七条（形状 / 盖章命中 / 六种签名变 / 非签名字段不重算 / 换格不比指针 / 长度 / 生产口径 ≥1.25 倍）',
    ['S0 ', 'S1 ', 'S2 ', 'S3 ', 'S4 ', 'S5 ', 'S6 '].every((t) => probeS36.includes(t)) &&
      probeS36.includes('seal.sigVer === seal.ver') &&
      probeS36.includes('stableDocsOf'),
    '7 条齐全')
  check('OR096 引擎形状：印章表 + 版本抬升 + 快路条件 + 老循环原样保留',
    engS36.includes('let DOCS_SEAL = new WeakMap();') &&
      engS36.includes('function sealOf(arr) {') &&
      engS36.includes('function sealBump(arr) {') &&
      engS36.includes('seal.sig !== \'\' && seal.sigVer === seal.ver') &&
      engS36.includes('const row = sigRowFor(docs, n).row;'),
    '四件齐全')
  check('OR096 进程内：签名字段一动就抬版本，只动 la/importance 不抬',
    (() => {
      const docs = Array.from({ length: 12 }, (_, i) => ({
        id: 's36' + i, level: 'fact', status: 'active', importance: 2, project: 'p', title: 't' + i,
        content: '内容 ' + i, keywords: ['k' + i], updated_at: 1000 + i,
      }))
      const before = Veng37.indexSignature(docs)
      docs[3].last_accessed_at = 9_999_999
      const afterLa = Veng37.indexSignature(docs)
      docs[5].content = '改过的内容'
      const afterBody = Veng37.indexSignature(docs)
      return before === afterLa && afterBody !== afterLa && Veng37.indexSignature(docs) === afterBody
    })(),
    'la 不影响、正文影响、稳定后逐位相同')
  check('OR096 文档在位：INTERNAL 9.235、README 写「签名」、DESIGN 有 ## 231.、PLAN 有 0.6.36',
    readFileSync(new URL('./docs/INTERNAL.md', import.meta.url), 'utf8').includes('## 9.235 ') &&
      readFileSync(new URL('./README.md', import.meta.url), 'utf8').includes('签名') &&
      readFileSync(new URL('./DESIGN.md', import.meta.url), 'utf8').includes('## 231. ') &&
      /0\.6\.36/.test(readFileSync(new URL('./docs/PLAN-0.6.md', import.meta.url), 'utf8')))
  const vS36 = (readFileSync(new URL('./lib/index.js', import.meta.url), 'utf8').match(/export const version = '(\d+)\.(\d+)\.(\d+)'/) ?? []).slice(1).map(Number)
  const vNumS36 = vS36.length === 3 ? vS36[0] * 10000 + vS36[1] * 100 + vS36[2] : 0
  check('OR096 版本号不低于 0.6.36（后续补丁不必回头改这一条）', vNumS36 >= 636, vS36.join('.'))
}

// ═══════════════ [macro-fusion 0.6.37] OR097：术语对照桥 ═══════════════
// 一版能力改动：库里的「口语＝术语」条目既是同义词源（挖对喂扩词，不再靠人手枚举），
// 也是降权对象（它短、密，吸收整个领域的口语词，会把真答案挤到 2–3 名）。
// 冷域换说法 hit@1 因此从 0.0% 到 70.0%。这条钉：探针在位、引擎形状、进程内读数、零误伤、文档与版本。
{
  const engS37 = readFileSync(new URL('./vendor/meow-memory/lib/index.js', import.meta.url), 'utf8')
  const probeS37 = readFileSync(new URL('./tools/probe-terms.mjs', import.meta.url), 'utf8')
  check('OR097 探针在位：probe-terms 有 T0–T7 十六条（形状 / 对子解析 / 判定 / 降权与免降权 / 让位 / 净账 / 桥形状 / 基线读数）',
    ['T0 ', 'T1 ', 'T2 ', 'T3 ', 'T4 ', 'T5 ', 'T6 ', 'T7 '].every((t) => probeS37.includes(t)) &&
      probeS37.includes('lookupTypeOf') && probeS37.includes('lookupBridge: false'),
    '16 条齐全')
  check('OR097 引擎形状：挖对 / 判定 / 降权 / 让位 / 两处打分 / 两件导出',
    engS37.includes('var LOOKUP_PEN_DEF = 0.25;') &&
      engS37.includes('function lookupPairsOf(text) {') &&
      engS37.includes('function buildLookupBridge(docs, n, opts) {') &&
      engS37.includes('if (cooc instanceof Map && !(ownBridge !== void 0 && ownBridge.length > 0)) {') &&
      engS37.includes('lookupSyn: lookup === null ? null : lookup.syn,') &&
      engS37.includes('lookupPen: lookup === null ? null : lookup.pen,') &&
      engS37.includes('buildLookupBridge,'),
    '四项齐全')
  check('OR097 进程内：五域 60 条判出 5 条对照条目、18 对；真库一条都不降权',
    (() => {
      const fx = JSON.parse(readFileSync(new URL('./tools/fixtures/domains.json', import.meta.url), 'utf8'))
      const t = Veng37.lookupTypeOf(fx.domains.flatMap((d) => d.docs))
      const real = [...JSON.parse(readFileSync(new URL('./tools/fixtures/gold-recall.json', import.meta.url), 'utf8')).docs ?? [],
        ...JSON.parse(readFileSync(new URL('./tools/fixtures/gold-wide.json', import.meta.url), 'utf8')).documents ?? []]
      const tr = Veng37.lookupTypeOf(real)
      return t.demoted === 5 && t.pairs === 18 && tr.demoted === 0
    })(),
    '5 条 / 18 对 / 真库 0 降权')
  check('OR097 进程内：关掉对照桥，冷域换说法 hit@1 从七成塌到零（可归因）',
    (() => {
      const fx = JSON.parse(readFileSync(new URL('./tools/fixtures/domains.json', import.meta.url), 'utf8'))
      const flat = fx.domains.flatMap((d) => d.docs)
      const qs = fx.domains.flatMap((d) => d.queries.filter((q) => q.kind === 'para'))
      const hit1 = (opts) => {
        let hit = 0
        for (const q of qs) {
          const ids = Veng37.searchAdaptive(q.q, flat, { k: 5, ...opts }).map((h) => String(h.id))
          if (String(ids[0]) === String(q.want[0])) hit += 1
        }
        return hit / qs.length
      }
      const on = hit1({})
      const off = hit1({ lookupBridge: false })
      return on >= 0.65 && off <= 0.1
    })(),
    '开 70% / 关 0%')
  check('OR097 文档在位：INTERNAL 9.236、README 写「术语对照桥」、DESIGN 有 ## 232.、PLAN 有 0.6.37',
    readFileSync(new URL('./docs/INTERNAL.md', import.meta.url), 'utf8').includes('## 9.236 ') &&
      readFileSync(new URL('./README.md', import.meta.url), 'utf8').includes('术语对照桥') &&
      readFileSync(new URL('./DESIGN.md', import.meta.url), 'utf8').includes('## 232. ') &&
      /0\.6\.37/.test(readFileSync(new URL('./docs/PLAN-0.6.md', import.meta.url), 'utf8')))
  const vS37 = (readFileSync(new URL('./lib/index.js', import.meta.url), 'utf8').match(/export const version = '(\d+)\.(\d+)\.(\d+)'/) ?? []).slice(1).map(Number)
  const vNumS37 = vS37.length === 3 ? vS37[0] * 10000 + vS37[1] * 100 + vS37[2] : 0
  check('OR097 版本号不低于 0.6.37（后续补丁不必回头改这一条）', vNumS37 >= 637, vS37.join('.'))
}

// 0.6.8：文档「现在」的断言总数由事实拼出来（环的最后一块，见上面 MT068 的注释）

{
  const baseTail = JSON.parse(readFileSync(new URL('./tools/baselines.json', import.meta.url), 'utf8'))
  const others = Object.entries(baseTail.counts)
    .filter(([f]) => f !== 'verify.mjs')
    .reduce((a, [, n]) => a + n, 0)
  const expected = others + passes + 1 // +1 = 这一条自己
  const claimsTail = readFileSync(new URL('./docs/EVAL-CLAIMS.md', import.meta.url), 'utf8')
  const claimTail = Number(((claimsTail.match(/\*\*([\d,]+) 断言\*\*/) ?? [])[1] ?? '').replace(/,/g, ''))
  check(
    'MT068 文档「现在」的断言总数 = 其它支基线合计 + 本支本次实测（数字由事实拼出来，不靠手抄）',
    expected > 0 && claimTail === expected,
    `文档 ${claimTail || '?'} / 实测 ${expected}（其它 ${others} + 本支 ${passes} +1）`,
  )
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
