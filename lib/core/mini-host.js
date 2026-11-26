/**
 * mini-host —— 一个「够用」的 cordis 兼容宿主。
 *
 * 为什么要有它：两个引擎（meow-memory / dsh-memory-nebula）是写成 cordis 插件的，
 * 它们的 `apply(ctx, config)` 会向 ctx 要四类东西——工具注册口、注入口、事件口、服务表。
 * 在没有 DSH 的宿主里（MCP / CLI / 别的 agent），这些都得有人给。本文件就是那个人。
 *
 * 设计原则（改之前先读）：
 *   1. **只实现用得到的**。没实现的能力一律返回 undefined，让调用方走它自己的降级分支，
 *      而不是抛一个「假红」——真实缺口靠 probe-core 的清单去发现，不靠这里炸。
 *   2. **不猜、不静默改**：所有陌生事件名照收（存进 listeners），不主动派发。
 *      引擎里的「每轮注入 / 自动反思」依赖会话事件，MCP 场景本来就没有会话，
 *      它们静默待着是正确行为，不是丢功能。
 *   3. **零外部依赖**：只用 node 内置。core 不许 import 任何 @deepseek-ai/*。
 */

const noop = () => {}

/** 事件监听表：事件名 → 监听器数组。 */
function makeBus() {
  const map = new Map()
  return {
    on(event, fn) {
      if (typeof fn !== 'function') return noop
      if (!map.has(event)) map.set(event, [])
      map.get(event).push(fn)
      return () => {
        const list = map.get(event)
        if (!list) return
        const i = list.indexOf(fn)
        if (i >= 0) list.splice(i, 1)
      }
    },
    emit(event, ...args) {
      const list = map.get(event)
      if (!list || list.length === 0) return 0
      for (const fn of list.slice()) {
        try {
          fn(...args)
        } catch {
          /* 监听器炸了不许拖垮宿主 */
        }
      }
      return list.length
    },
    size() {
      let n = 0
      for (const list of map.values()) n += list.length
      return n
    },
  }
}

/**
 * 造一个 mini 宿主。
 *
 * @param {object} [options]
 * @param {object} [options.logger] 自定义 logger（默认静默，`verbose` 打开时打到 stderr）
 * @param {boolean} [options.verbose]
 * @param {object} [options.services] 预置服务表（例如测试里塞一个假的 webServer）
 */
export function createMiniHost(options = {}) {
  const verbose = options.verbose === true
  const bus = makeBus()
  const services = new Map(Object.entries(options.services ?? {}))
  const effects = []
  const children = []
  let disposed = false

  const logger = options.logger ?? {
    debug: (...a) => (verbose ? console.error('[debug]', ...a) : undefined),
    info: (...a) => (verbose ? console.error('[info]', ...a) : undefined),
    warn: (...a) => console.error('[warn]', ...a),
    error: (...a) => console.error('[error]', ...a),
  }

  /** 工具注册口：宿主侧真正要的就是这张表。 */
  const toolTable = new Map()
  const toolsService = {
    register(def) {
      if (!def || typeof def.name !== 'string') return noop
      toolTable.set(def.name, def)
      return () => {
        if (toolTable.get(def.name) === def) toolTable.delete(def.name)
      }
    },
    get(name) {
      return toolTable.get(name)
    },
    list() {
      return [...toolTable.values()]
    },
    has(name) {
      return toolTable.has(name)
    },
  }

  /** 注入口：subsystem 里叫 section / context，这里都收进一张表。 */
  const prompts = []
  const promptService = {
    section(decl) {
      prompts.push({ kind: 'section', decl })
      return () => {
        const i = prompts.findIndex((p) => p.decl === decl)
        if (i >= 0) prompts.splice(i, 1)
      }
    },
    context(decl) {
      prompts.push({ kind: 'context', decl })
      return () => {
        const i = prompts.findIndex((p) => p.decl === decl)
        if (i >= 0) prompts.splice(i, 1)
      }
    },
    list() {
      return prompts.slice()
    },
  }

  /**
   * 设置区服务：真实 DSH 里 `ctx.settings` 由设置面板提供（installSection + describe）。
   * core 场景没有面板，但引擎的装配代码会读 `ctx.settings.installSection` / `.register`，
   * 给 undefined 会直接炸在属性访问上（不是「优雅降级」）。所以这里给一个**空实现**：
   * register 收下 schema 但不落任何 UI，describe 返回空表——引擎随后会记一条
   * 「非 0.1.7+ 形态，配置走 patch 层」的 warn，这正是我们想要的行为：
   * 没有面板，配置就只能来自 config.json 与构造参数。
   */
  const settingsService = {
    describe() {
      return []
    },
    register(_ns, _schema, opts) {
      let value = opts?.base ?? {}
      const listeners = []
      return {
        get: () => value,
        set(next) {
          value = next
          for (const fn of listeners) fn()
        },
        onChange(fn) {
          if (typeof fn === 'function') listeners.push(fn)
          return () => {
            const i = listeners.indexOf(fn)
            if (i >= 0) listeners.splice(i, 1)
          }
        },
        /** meow 的设置区用 `scope.watch()` 订阅变更（不是 onChange），两种名字都给。 */
        watch(fn) {
          if (typeof fn !== 'function') return () => {}
          listeners.push(fn)
          return () => {
            const i = listeners.indexOf(fn)
            if (i >= 0) listeners.splice(i, 1)
          }
        },
      }
    },
  }

  /**
   * 用户命令服务。DSH 里这是斜杠命令面板（/dream、/meow-trust）。
   * core 场景没有斜杠命令——但**必须给一个空实现**：引擎会 `inject(['commands'])` 等它，
   * 拿不到就卡满 20 秒再 warn，把冷启动拖成一次超时。收下定义、不执行，就够了。
   */
  const commandTable = new Map()
  const commandsService = {
    register(def) {
      const name = typeof def?.name === 'string' ? def.name : `cmd-${commandTable.size + 1}`
      commandTable.set(name, def)
      return () => {
        if (commandTable.get(name) === def) commandTable.delete(name)
      }
    },
    get(name) {
      return commandTable.get(name)
    },
    list() {
      return [...commandTable.entries()].map(([name, def]) => ({ name, def }))
    },
  }

  /**
   * 本地 web 服务。DSH 里有真的 HTTP 端口，meow 会往上挂 /meow-memory/* 路由。
   * core 场景不监听任何端口（这是有意的：不占端口、不留后台服务），但**必须给一个
   * 空实现**——引擎拿不到就每 1 秒重试、撑满 20 次才 warn，把冷启动硬拖成 20 秒。
   * 这里收下路由、不监听：路由表本身可以给 UI 预览用，但不 open 任何 socket。
   */
  const routes = new Map()
  const webServerService = {
    register(route) {
      if (route && typeof route.path === 'string') routes.set(route.path, route)
      return () => {
        if (route && routes.get(route.path) === route) routes.delete(route.path)
      }
    },
    get(pathname) {
      return routes.get(pathname)
    },
    list() {
      return [...routes.values()]
    },
    /** 明确没有监听：任何「本机 http://…」都别指望它。 */
    listening: false,
    port: 0,
  }

  services.set('tools', toolsService)
  services.set('systemPrompt', promptService)
  services.set('settings', settingsService)
  services.set('commands', commandsService)
  services.set('webServer', webServerService)

  const ctx = {
    logger,
    fiber: { effect: (fn) => ctx.effect(fn), dispose: noop },
    slots: {
      register() {
        return noop
      },
      get() {
        return undefined
      },
    },
    get(name) {
      return services.get(name)
    },
    set(name, value) {
      services.set(name, value)
      // cordis 里服务名就是 ctx 上的属性（`ctx.settings`、`ctx.tools`）。
      // 引擎有两套读法混着用，只实现 get() 会让它在属性访问上炸——两边都给。
      if (typeof name === 'string' && !(name in ctx)) ctx[name] = value
      return value
    },
    provide(name, value) {
      return ctx.set(name, value)
    },
    on(event, fn) {
      return bus.on(event, fn)
    },
    once(event, fn) {
      const off = bus.on(event, (...args) => {
        off()
        if (typeof fn === 'function') fn(...args)
      })
      return off
    },
    before(event, fn) {
      return bus.on(`before:${event}`, fn)
    },
    after(event, fn) {
      return bus.on(`after:${event}`, fn)
    },
    effect(fn) {
      if (typeof fn !== 'function') return noop
      const dispose = fn()
      if (typeof dispose === 'function') effects.push(dispose)
      return () => {
        if (typeof dispose === 'function') dispose()
      }
    },
    inject(_deps, callback) {
      // 没有异步服务：依赖一律视为就绪，立刻给一个同源的子 ctx。
      if (typeof callback !== 'function') return ctx
      try {
        return callback(ctx)
      } catch (err) {
        logger.warn?.('[mini-host] inject 回调失败：', err?.message ?? err)
        return undefined
      }
    },
    plugin(mod, config) {
      if (disposed) return { dispose: noop }
      const target = typeof mod === 'function' ? { apply: mod } : mod
      if (!target || typeof target.apply !== 'function') return { dispose: noop }
      const fork = { dispose: noop, name: target.name }
      try {
        target.apply(ctx, config)
      } catch (err) {
        logger.warn?.(`[mini-host] 插件 ${target.name ?? '(匿名)'} 装配失败：${err?.message ?? err}`)
      }
      children.push(fork)
      return fork
    },
    tools: toolsService,
    systemPrompt: promptService,
    settings: settingsService,
    commands: commandsService,
    webServer: webServerService,
    // connection 是 DSH 侧的连接服务（authGate 用它做 cookie 认证）：core 没有，
    // 给 undefined 让引擎走「环回 fence」降级分支，这是它自己的设计。
    connection: undefined,
  }

  return {
    ctx,
    tools: toolTable,
    prompts,
    bus,
    logger,
    /** 拔掉所有 effect + 清空工具表（顺序相反，和真实宿主一致）。 */
    async dispose() {
      if (disposed) return
      disposed = true
      for (const fn of effects.reverse()) {
        try {
          await fn()
        } catch {
          /* 拆卸失败不影响其他 */
        }
      }
      toolTable.clear()
    },
    stats() {
      return {
        tools: toolTable.size,
        prompts: prompts.length,
        listeners: bus.size(),
        effects: effects.length,
        disposed,
      }
    },
  }
}
