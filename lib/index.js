/**
 * dsh-macro-memory —— 记忆总成插件。
 *
 * 定位：一个插件顶替 meow-memory（跨会话记忆条目）+ dsh-memory-nebula（记忆星图），
 *       对外只暴露 8 个统一的 memory_* 工具与一段最小注入；
 *       两个原插件在这里是「引擎」，不是并列的插件 —— 它们的工具与注入都被融合层接管重组。
 *
 * 结构：
 *   lib/index.js           本文件，唯一的插件入口（含宿主设置页要的 Config）
 *   lib/macro/bridge.js    接管两个子插件的 ctx（工具/注入进不下宿主，其余透传）
 *   lib/macro/tools.js     8 个统一工具（复用子插件自己的写路径，不重写记忆逻辑）
 *   lib/macro/prompt.js    L0 常驻注入 + L2 按需完整手册
 *   lib/macro/cost.js      成本账本 $DSH_HOME/macro-memory/cost.jsonl
 *   lib/client.js          前端（由 build.mjs 从两个子插件的 web bundle 拼出）
 */
import z from '@deepseek-ai/schemastery'
import * as Meow from '../vendor/meow-memory/lib/index.js'
import * as Nebula from '../vendor/dsh-memory-nebula/lib/index.js'
import { brandText, withNameHints } from './macro/brand.js'
import { createBridge, errText, wrapPlugin } from './macro/bridge.js'
import { GUIDE_MAX_CHARS, GUIDE_NAME, GUIDE_ORDER, GUIDE_TEXT, clampGuide, guideBudget } from './macro/prompt.js'
import { createAliasTools, createUnifiedTools } from './macro/tools.js'
import { withCost } from './macro/cost.js'

export const name = 'macro-memory'
export const version = '0.2.101'
export const inject = ['tools']

/** 融合层自己的默认值；配置里可写在顶层，也可写在 macro: 段下。 */
export const MACRO_DEFAULTS = {
  /** 是否额外注册子插件原名工具（nebula_* / memory_find_similar / memory_home），默认关闭。 */
  compatAliases: false,
  /** L0 常驻注入的字符上限。 */
  guideMaxChars: GUIDE_MAX_CHARS,
  /** 统一工具等子插件装配完成的最长时间（毫秒）。 */
  toolWaitMs: 30000,
  /** 读路径补连线的节流窗口（毫秒）；0 表示每次都补。 */
  flushThrottleMs: 30000,
}

const MACRO_KEYS = ['compatAliases', 'guideMaxChars', 'toolWaitMs', 'flushThrottleMs']

/** 宿主设置页写入后的去抖窗口（毫秒）：连点几下只重建一次工具面。 */
const VOLATILE_DEBOUNCE_MS = 150

/** cosmokit 的 volatile 写入协议符号（跨 ESM/CJS 副本也认得）。 */
const VOLATILE_WRITE = Symbol.for('cosmokit.volatile.write')

/** 这个值是不是 cosmokit 的 volatile 引用。 */
export function isVolatileRef(value) {
  return typeof value === 'object' && value !== null && VOLATILE_WRITE in value
}

/**
 * 把配置读成普通对象：宿主传进来的可能是 volatile 引用（写入后原地更新），
 * 也可能是测试/旧路径给的普通对象。引用逐层解包，最多 8 层，防自引用打转。
 */
export function readConfigRoot(value) {
  let current = value
  for (let depth = 0; depth < 8; depth += 1) {
    if (!isVolatileRef(current) || typeof current.get !== 'function') break
    const next = current.get()
    if (next === current) break
    current = next
  }
  return current !== null && typeof current === 'object' ? current : {}
}

/** meow 自己声明的字段（带默认值与校验）——设置页要靠它们在「默认值 / 用户值」两栏之间显示。 */
const MEOW_FIELDS = Meow.Config !== undefined && Meow.Config.dict !== undefined ? Meow.Config.dict : {}
const MEOW_KEYS = Object.keys(MEOW_FIELDS)

/**
 * [macro-fusion 0.2.79] 宿主设置页只认「声明在 Config 里、且路径落在 volatile 节点下」的键：
 *   1) 不导出 Config → describe() 里没有这个条目 → 设置页永远是「当前连接不支持设置写入」；
 *   2) 导出了但没声明的键 → 每次写入都被宿主的 strip() 剃掉（profile 里的 meow / nebula 会整段消失）；
 *   3) 根 volatile + 子字段 volatile 不能共存（schemastery 会报 "volatile fields require a fixed
 *      object path without an enclosing volatile field"），所以跟 meow 一样：根 volatile、子字段普通。
 * 平铺到根而不是塞进 meow: 段，是因为设置页的写入只支持顶层字段名（path:[field]）。
 */
export const Config = z.object({
  ...MEOW_FIELDS,
  /** 星图引擎的配置段（保留旧写法）。 */
  nebula: z.any(),
  /** 融合层的旧嵌套写法兼容段。 */
  macro: z.any(),
  /** meow 的旧嵌套写法兼容段（只读兜底；新写法平铺在根上）。 */
  meow: z.any(),
  compatAliases: z.boolean().default(MACRO_DEFAULTS.compatAliases),
  guideMaxChars: z.number().default(MACRO_DEFAULTS.guideMaxChars),
  toolWaitMs: z.number().default(MACRO_DEFAULTS.toolWaitMs),
  flushThrottleMs: z.number().default(MACRO_DEFAULTS.flushThrottleMs),
})
Object.assign(Config.meta, { default: {}, volatile: true })

/**
 * 把一份配置（volatile 引用或普通对象）解成三段：
 *   meow   子插件 meow 的配置：旧 meow: 段铺底，根上的同名字段覆盖（0.2.79 起是平铺的）
 *   nebula 星图配置段
 *   macro  融合层配置：macro: 段铺底，根上四个键覆盖，缺省用 MACRO_DEFAULTS
 */
export function resolveConfig(raw) {
  const src = readConfigRoot(raw)
  const nested = readConfigRoot(src.macro)
  const legacyMeow = readConfigRoot(src.meow)
  const macro = { ...MACRO_DEFAULTS }
  for (const key of MACRO_KEYS) {
    if (src[key] !== undefined) macro[key] = src[key]
    if (nested[key] !== undefined) macro[key] = nested[key]
  }
  const meow = { ...legacyMeow }
  for (const key of MEOW_KEYS) {
    if (src[key] !== undefined) meow[key] = src[key]
  }
  return {
    meow,
    nebula: readConfigRoot(src.nebula),
    macro,
  }
}

/** [macro-fusion 0.2.97] meow 的 projectDir 读口：面板的「整理留痕」按它找 dream 账本。
 *  装配时（apply）换成真正生效的值；没装配到就退回默认目录，绝不写死两份。 */
let meowDirReader = () => '.dsh-meow'

export function apply(ctx, config) {
  const logger = safeLogger(ctx)
  // [macro-fusion 0.2.79] 有 volatile 配置的插件，宿主会额外自动生成一张通用表单页；
  // 我们自带「宏记忆」设置页，两张页面并排出现会互相打脸，这里把自动那张关掉。
  configureSettingsPage(ctx, logger)
  warnLegacySections(config, logger)

  let macroCfg = resolveConfig(config).macro
  let surface = null
  let stopped = false
  let timer
  let chain = Promise.resolve()
  let lastRoot = readConfigRoot(config)

  const bridge = createBridge({
    log: (msg) => logger?.debug?.(msg),
    warn: (msg) => logger?.warn?.(msg),
    // 子插件的返回文本里可能写着 nebula_recall / meow-memory 这些旧名字；
    // compatAliases 关着的时候它们根本没注册，原样吐给模型就是死指针，所以先换口。
    // 但「检索/读取」返回的是记忆原文：正文一个字不动，只在末尾补旧名对照（0.2.14）。
    // 这两处读的是 macroCfg 的最新值，所以改 compatAliases 不用重挂子插件（0.2.79）。
    brand: (text) => brandText(text, { aliases: macroCfg.compatAliases === true }),
    hints: (text) => withNameHints(text, { aliases: macroCfg.compatAliases === true }),
  })

  // ── 1. 两个子插件照旧装配，但拿到的是 facade ctx：
  //        它们注册的工具、想注入的 prompt 全被 bridge 收下，由下面重新组织。
  //        喂给引擎的只能是普通对象：宿主会用我们的 Config 解析 apply 的入参，解析结果是一份
  //        volatile 引用；meow 的 readConfigRoot 只认「带 get 的普通对象」，拿到宿主这种引用
  //        会当场装不起来（0.2.79 实测：它的 8 个工具一个都没注册，统一工具全线「这项能力
  //        还没就绪」）。所以引擎配置一律先解成普通对象；设置页改了引擎字段就整只重挂，
  //        由 syncSurface() 负责（0.2.79 修）。
  const initial = resolveConfig(config)
  let engineCfg = { meow: initial.meow, nebula: initial.nebula }
  const engines = new Map()

  // [macro-fusion 0.2.97] 整理留痕面板要读 meow 的账本，而账本按 meow 的 projectDir 放
  // （默认 .dsh-meow，可配）。这个路径只有引擎配置知道，所以在这里留一个读口：
  // 面板拿到的永远是「现在生效的那个目录」，而不是面板自己写死的 .dsh-meow。
  meowDirReader = () => {
    const d = engineCfg.meow?.projectDir
    return typeof d === 'string' && d.length > 0 ? d : '.dsh-meow'
  }

  const mountEngine = (vendor, mod, cfg) => {
    try {
      engines.set(vendor, ctx.plugin(wrapPlugin(mod, bridge, vendor), cfg))
    } catch (err) {
      logger?.warn?.(`[macro-memory] ${vendor} 引擎装配失败：${errText(err)}`)
    }
  }

  const unmountEngine = async (vendor) => {
    const fork = engines.get(vendor)
    engines.delete(vendor)
    if (fork === undefined || fork === null) return
    try {
      await fork.dispose?.()
    } catch (err) {
      logger?.debug?.(`[macro-memory] 拆卸 ${vendor} 引擎时出错：${errText(err)}`)
    }
  }

  mountEngine('meow', Meow, engineCfg.meow)
  mountEngine('nebula', Nebula, engineCfg.nebula)

  // ── 2. 工具面 + 注入 = 一层可整体重建的「表面」：
  //        配置里融合层那四个键变了就换一层，子插件不动（重挂 meow 会打断它正在做的扫描）。
  const stopSurface = async () => {
    const current = surface
    surface = null
    if (current === null) return
    await current.stop()
  }

  const startSurface = () => {
    surface = buildSurface(ctx, bridge, macroCfg, logger)
    return surface
  }

  const syncSurface = () => {
    const next = resolveConfig(config)
    const macroChanged = MACRO_KEYS.filter((key) => next.macro[key] !== macroCfg[key])
    const meowChanged = !sameValue(next.meow, engineCfg.meow)
    const nebulaChanged = !sameValue(next.nebula, engineCfg.nebula)
    if (macroChanged.length === 0 && !meowChanged && !nebulaChanged) return
    // 融合层的键立刻换新值：brand()/hints()/guide 都靠 macroCfg 现读，不用等异步重挂（0.2.79）
    macroCfg = next.macro
    const detail = macroChanged.map((key) => `${key}=${JSON.stringify(next.macro[key])}`).join('、')
    chain = chain
      .then(async () => {
        if (stopped) return
        if (meowChanged || nebulaChanged) {
          // 引擎自己那份配置是「装配时拍下的快照」，热写改不到它 —— 要它真按新配置跑，
          // 只能拆掉重挂。先收工具面：不然重挂那几百毫秒里统一工具会指向半死的引擎。
          const plan = []
          if (meowChanged) plan.push(['meow', Meow])
          if (nebulaChanged) plan.push(['nebula', Nebula])
          await stopSurface()
          for (const [vendor] of plan) await unmountEngine(vendor)
          engineCfg = { meow: next.meow, nebula: next.nebula }
          if (stopped) return
          for (const [vendor, mod] of plan) mountEngine(vendor, mod, engineCfg[vendor])
          startSurface()
          const which = plan.map(([vendor]) => vendor).join('+')
          logger?.info?.(
            `[macro-memory] 设置已热应用：记忆引擎（${which}）重新装配，扫描会重启`
              + `${detail ? `；同时生效：${detail}` : ''}（工具面与注入已重建）`,
          )
          return
        }
        await stopSurface()
        if (stopped) return
        startSurface()
        logger?.info?.(`[macro-memory] 设置已热应用：${detail}（工具面与注入已重建，引擎没动）`)
      })
      .catch((err) => logger?.warn?.(`[macro-memory] 设置热应用失败，仍在用旧工具面：${errText(err)}`))
    return chain
  }

  startSurface()

  // ── 3. 宿主设置页写入：volatile 引用被原地更新，这里只重建「表面」。
  const onVolatile = (paths) => {
    if (stopped) return
    if (timer !== undefined) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = undefined
      if (stopped) return
      const nextRoot = readConfigRoot(config)
      if (nextRoot.homeDir !== lastRoot.homeDir) {
        logger?.info?.(
          `[macro-memory] homeDir 从 ${JSON.stringify(lastRoot.homeDir)} 改成 ${JSON.stringify(nextRoot.homeDir)}：`
            + '记忆引擎会重新装配并切到新库目录（旧目录里的记忆不会自动搬过去）。',
        )
      }
      lastRoot = nextRoot
      logger?.debug?.(`[macro-memory] 设置页写入：${describePaths(paths)}`)
      syncSurface()
    }, VOLATILE_DEBOUNCE_MS)
  }

  if (typeof ctx.on === 'function') {
    try {
      ctx.on('loader/volatile-update', onVolatile)
    } catch (err) {
      logger?.debug?.(`[macro-memory] 订阅设置热更新失败：${errText(err)}`)
    }
  }

  ctx.effect(() => () => {
    stopped = true
    if (timer !== undefined) {
      clearTimeout(timer)
      timer = undefined
    }
    void stopSurface()
  })

  logger?.debug?.(
    `[macro-memory] 融合层就绪：${surface?.tools ?? 0} 个统一工具${macroCfg.compatAliases ? ' + 兼容别名' : ''}`,
  )
}

/** 工具面 + 注入：可整体重建，重建时先拆旧的再装新的。 */
function buildSurface(ctx, bridge, macro, logger) {
  const cleanups = []
  const unified = createUnifiedTools({ bridge, config: macro, meowDir: meowDirReader })
  for (const def of unified) pushTool(ctx, cleanups, def, logger)
  if (macro.compatAliases === true) {
    for (const def of createAliasTools({ bridge })) pushTool(ctx, cleanups, def, logger)
  }
  const disposeGuide = installGuide(ctx, macro, logger)
  if (typeof disposeGuide === 'function') cleanups.push(disposeGuide)

  let done = false
  return {
    tools: unified.length,
    stop: async () => {
      if (done) return
      done = true
      for (const fn of cleanups.reverse()) {
        try {
          await fn()
        } catch (err) {
          logger?.debug?.(`[macro-memory] 拆卸工具面时出错：${errText(err)}`)
        }
      }
    },
  }
}

function pushTool(ctx, cleanups, def, logger) {
  try {
    const dispose = ctx.tools.register(withCost(def.name, def))
    if (typeof dispose === 'function') cleanups.push(dispose)
  } catch (err) {
    logger?.warn?.(`[macro-memory] 工具 ${def.name} 注册失败：${errText(err)}`)
  }
}

/**
 * 关掉宿主为「有 volatile 配置的插件」自动生成的通用表单页（auto: false）。
 * 关不掉不算故障：多一张页面比没有页面好，所以只记 debug。
 */
function configureSettingsPage(ctx, logger) {
  const configure = (child) => {
    let settings
    try {
      settings = child.get?.('settings')
    } catch {
      settings = undefined
    }
    if (settings === undefined || settings === null || typeof settings.configure !== 'function') return
    try {
      child.effect(() => settings.configure({ auto: false }, ctx.fiber))
    } catch (err) {
      logger?.debug?.(`[macro-memory] 关闭自动设置页失败（不影响使用）：${errText(err)}`)
    }
  }
  try {
    if (typeof ctx.inject === 'function') ctx.inject(['settings'], configure)
    else configure(ctx)
  } catch (err) {
    logger?.debug?.(`[macro-memory] 取 settings 服务失败（不影响使用）：${errText(err)}`)
  }
}

/** 旧写法 config.meow / config.macro 还在的话，说清楚哪几个键被根字段盖住了。 */
function warnLegacySections(raw, logger) {
  const src = readConfigRoot(raw)
  const sections = [
    ['meow', 'meow'],
    ['macro', 'macro'],
  ]
  for (const [section, label] of sections) {
    const legacy = src[section]
    if (legacy === null || typeof legacy !== 'object' || Array.isArray(legacy)) continue
    const keys = Object.keys(legacy)
    if (keys.length === 0) continue
    const shadowed = keys.filter((key) => src[key] !== undefined && !sameValue(src[key], legacy[key]))
    logger?.warn?.(
      `[macro-memory] 配置里还有旧写法 config.${label}（${keys.join('、')}）：0.2.79 起配置平铺在根上`
        + `${shadowed.length > 0 ? `，其中 ${shadowed.join('、')} 已被根字段覆盖（根字段优先）` : '，根上没写的键仍按旧段生效'}。`
        + '把这段里的键搬到根上，这条提示就不再出现。',
    )
  }
}

function sameValue(a, b) {
  if (a === b) return true
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false
  try {
    return JSON.stringify(a) === JSON.stringify(b)
  } catch {
    return false
  }
}

function describePaths(paths) {
  if (!Array.isArray(paths)) return '(未知路径)'
  const list = paths.map((path) => (Array.isArray(path) && path.length > 0 ? path.join('.') : '(根)'))
  return list.length > 0 ? list.join('、') : '(根)'
}

function installGuide(ctx, macro, logger) {
  // [macro-fusion 0.2.63] 上限先过唯一出口：配置写错要回默认并吭声，不许悄悄变成 0（＝不注入）
  const budget = guideBudget(macro.guideMaxChars)
  if (budget.note) logger?.warn?.(`[macro-memory] ${budget.note}`)
  const text = clampGuide(GUIDE_TEXT, budget.value)
  let timer
  let disposer
  let tries = 0

  const attempt = () => {
    if (disposer) return
    let svc
    try {
      svc = ctx.get?.('systemPrompt')
    } catch {
      svc = undefined
    }
    if (svc && typeof svc.section === 'function') {
      try {
        disposer = svc.section({ name: GUIDE_NAME, order: GUIDE_ORDER, text })
        logger?.debug?.(`[macro-memory] L0 注入已装上（${text.length} 字符）`)
      } catch (err) {
        logger?.warn?.(`[macro-memory] L0 注入安装失败：${errText(err)}`)
      }
      return
    }
    tries += 1
    if (tries <= 200) timer = setTimeout(attempt, 250)
  }

  attempt()
  // 返回拆卸函数：工具面重建时由 buildSurface 统一收，不再各自挂 ctx.effect（0.2.79）
  return () => {
    if (timer !== undefined) {
      clearTimeout(timer)
      timer = undefined
    }
    try {
      disposer?.()
    } catch {
      /* ignore */
    }
    disposer = undefined
  }
}

function safeLogger(ctx) {
  try {
    return ctx.logger
  } catch {
    return undefined
  }
}
