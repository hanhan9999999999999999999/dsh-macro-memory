/**
 * facade ctx（0.2.26 从 bridge.js 分出来）：把子插件看到的 `ctx` 换成一个 Proxy。
 *
 * 只改写 tools / systemPrompt / get / inject / plugin 五处，其余原样透传真实 ctx
 * （函数会 bind，避免 cordis 内部拿到 Proxy 当 this）。
 * 桥本身（收下工具/注入、转调）在 `bridge.js`；这里只负责「换门」。
 */

const PROMPT_PASSTHROUGH = new Set(['tools', 'variable', 'services', 'peek'])

/**
 * 造一个 facade ctx：只改写 tools / systemPrompt / get / inject / plugin，
 * 其余全部透传给真实 ctx。
 */
export function createFacade(real, bridge, vendor) {
  if (!real) return real

  const realTools = () => {
    try {
      return real.get?.('tools')
    } catch {
      return undefined
    }
  }
  const realPrompt = () => {
    try {
      return real.get?.('systemPrompt')
    } catch {
      return undefined
    }
  }

  const toolsFacade = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === 'register') {
          return (definition, options) => bridge.captureTool(vendor, definition, options)
        }
        const svc = realTools()
        const value = svc ? svc[prop] : undefined
        return typeof value === 'function' ? value.bind(svc) : value
      },
      has(_t, prop) {
        return prop === 'register'
      },
    },
  )

  const promptFacade = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === 'section') {
          return (decl) => bridge.capturePrompt(vendor, 'section', decl)
        }
        if (prop === 'context') {
          return (decl) => bridge.capturePrompt(vendor, 'context', decl)
        }
        if (PROMPT_PASSTHROUGH.has(prop)) {
          const svc = realPrompt()
          const value = svc ? svc[prop] : undefined
          return typeof value === 'function' ? value.bind(svc) : value
        }
        const svc = realPrompt()
        const value = svc ? svc[prop] : undefined
        return typeof value === 'function' ? value.bind(svc) : value
      },
      has(_t, prop) {
        return prop === 'section' || prop === 'context'
      },
    },
  )

  const facade = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === 'tools') return toolsFacade
        if (prop === 'systemPrompt') return promptFacade
        if (prop === 'get') {
          return (name) => {
            if (name === 'systemPrompt') return promptFacade
            // 子插件若走 ctx.get('tools').register 注册工具，必须同样被收进桥——
            // 否则它绕过融合层直接挂到宿主，8 个统一工具的承诺当场破功（0.2.15）。
            if (name === 'tools') return toolsFacade
            return real.get?.(name)
          }
        }
        if (prop === 'inject') {
          return (deps, callback) => {
            if (typeof callback !== 'function') return real.inject(deps)
            return real.inject(deps, (scoped) => callback(createFacade(scoped, bridge, vendor)))
          }
        }
        if (prop === 'plugin') {
          return (plugin, cfg) => real.plugin(wrapPlugin(plugin, bridge, vendor), cfg)
        }
        const value = Reflect.get(real, prop)
        return typeof value === 'function' ? value.bind(real) : value
      },
      has(_t, prop) {
        if (prop === 'tools' || prop === 'systemPrompt') return true
        try {
          return prop in real
        } catch {
          return false
        }
      },
      set(_t, prop, value) {
        real[prop] = value
        return true
      },
    },
  )

  return facade
}

/**
 * 把子插件模块包成「apply 时拿到 facade ctx」的插件对象。
 *
 * 只挑 name / inject / apply / reusable 四项，绝不 {...mod} 整包拷贝 —— 插件模块里还有
 * Config 之类的导出，拷过来宿主就会拿父插件的 schema 去解析子插件的配置
 * （0.2.79 实测：meow 的配置被我们那张 21 键大 schema 解析成 volatile 引用，引擎当场装不起来）。
 */
export function wrapPlugin(mod, bridge, vendor) {
  const plugin = {
    name: mod.name,
    apply: (ctx, config) => mod.apply(createFacade(ctx, bridge, vendor), config),
  }
  if (mod.inject !== undefined) plugin.inject = mod.inject
  if (mod.reusable !== undefined) plugin.reusable = mod.reusable
  return plugin
}
