/**
 * macro-memory 融合层：把 meow-memory 与 nebula 两个子插件「接管」进来。
 *
 * 做法：不改 vendor 一行代码，只在 apply 外面包一个 facade ctx。
 *  - 子插件调 ctx.tools.register(...)  → 被 bridge 收下，不直接进宿主
 *  - 子插件调 ctx.systemPrompt.section/context(...) → 被 bridge 收下，不直接注入
 *  - 其余 ctx 能力（logger / get / on / effect / webServer / connection / settings …）
 *    原样透传给真正的 cordis ctx（函数会 bind，避免 cordis 内部拿到 Proxy 当 this）
 *
 * 于是「17 个工具、两段注入」全部落到 facade 层，由 lib/macro/tools.js 与
 * lib/macro/prompt.js 重新组织成 macro 自己的 8 个 memory_* 工具 + 一段 L0 注入。
 *
 * 0.2.26 三件事各一个文件：
 *  - 本文件  bridge.js —— 收下工具与注入、转调子插件工具（有状态）
 *  - facade.js —— 把 ctx 换成 Proxy（换门，无状态）
 *  - render.js —— 把子插件返回值变成文本（纯函数）
 */

import { errText, renderToolText } from './render.js'
import { NOT_READY_MARK } from './contract.js'

// 兼容旧引用：errText 原来就导出在本文件里（index.js 一直这么 import）。
export { errText }
export { createFacade, wrapPlugin } from './facade.js'

const noop = () => {}

/** 统一工具等子插件装配时用的等待上限（毫秒）。 */
export const DEFAULT_TOOL_WAIT_MS = 30000

/**
 * 返回「记忆原文」的工具：它们的文本里有用户存进去的字，**不许改口**（只追加旧名对照）。
 * 其余工具（stats / guide / link / remember …）吐的是融合层自己的界面文案，按 BRAND_MAP 换名没问题。
 */
export const CONTENT_TOOLS = new Set([
  'memory_search',
  'memory_read',
  'memory_remember',
  'memory_update',
  'memory_find_similar',
  'nebula_recall',
  'nebula_inspect',
  'nebula_bridge',
  'nebula_path',
])

export function createBridge(options = {}) {
  const log = typeof options.log === 'function' ? options.log : noop
  const warn = typeof options.warn === 'function' ? options.warn : noop
  /** 子插件文本的「改口」函数（把旧工具名换成 macro 的说法）；默认原样。 */
  const brand = typeof options.brand === 'function' ? options.brand : (t) => t
  /** 原文工具的「只加对照、不动正文」函数；默认原样。 */
  const hints = typeof options.hints === 'function' ? options.hints : (t) => t

  /** name -> { name, vendor, def, options } */
  const tools = new Map()
  /** 捕获到的注入声明（按到达顺序） */
  const prompts = []
  /** vendor -> 该 vendor 捕获到的工具名 */
  const vendorTools = new Map()

  function note(vendor) {
    if (!vendorTools.has(vendor)) vendorTools.set(vendor, [])
    return vendorTools.get(vendor)
  }

  const bridge = {
    /** 子插件 register 的工具被收在这里，返回给它的是一次性 disposer。 */
    captureTool(vendor, def, options = {}) {
      if (!def || typeof def.name !== 'string') {
        warn(`[macro-memory] ${vendor} 注册了没有 name 的工具，已忽略`)
        return noop
      }
      tools.set(def.name, { name: def.name, vendor, def, options })
      const list = note(vendor)
      if (!list.includes(def.name)) list.push(def.name)
      log(`[macro-memory] 收到 ${vendor} 的工具 ${def.name}`)
      return () => {
        const hit = tools.get(def.name)
        if (hit && hit.vendor === vendor && hit.def === def) tools.delete(def.name)
      }
    },

    /** 子插件的 systemPrompt.section / .context 被收在这里，一律不落宿主。 */
    capturePrompt(vendor, kind, decl) {
      prompts.push({ vendor, kind, decl })
      log(`[macro-memory] 收到 ${vendor} 的注入 ${kind}:${String(decl?.name)}`)
      return noop
    },

    has(name) {
      return tools.has(name)
    },

    get(name) {
      return tools.get(name)
    },

    names() {
      return [...tools.keys()]
    },

    /** 取子插件的工具定义；还没装配好就轮询等一会儿（默认 30s）。 */
    async awaitTool(name, timeoutMs = DEFAULT_TOOL_WAIT_MS) {
      const hit = tools.get(name)
      if (hit) return hit
      const deadline = Date.now() + Math.max(0, timeoutMs)
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100))
        const again = tools.get(name)
        if (again) return again
      }
      return undefined
    },

    /** 融合层自己调子插件工具：拿到定义、执行、用子插件自己的 render 出文本。 */
    async call(name, args, exec, timeoutMs) {
      const entry = await bridge.awaitTool(name, timeoutMs)
      if (!entry) {
        // 不给模型甩子插件的内部名字：它只认识 macro 的 8 个工具
        warn(`[macro-memory] 子插件能力 ${name} 尚未就绪`)
        throw new Error(`macro-memory：${NOT_READY_MARK}（对应子模块尚未装配完成，或被配置关闭），请稍后重试。`)
      }
      const value = await entry.def.execute(args, exec)
      const rendered = renderToolText(entry.def, args, value)
      // 原文工具：正文不动，只补旧名对照；其余工具：按 BRAND_MAP 改口。
      const decorate = CONTENT_TOOLS.has(name) ? hints : brand
      return { entry, def: entry.def, value, text: decorate(rendered) }
    },

    /**
     * call 的「失败不致命」版本：拿来做增强（星图邻域/相似/连线）用。
     * label 是给模型看的说法（例如「星图扩散」），缺省才用子插件工具名——
     * 免得工具输出里出现「memory_search 未完成」这种自己说自己没做完的怪句子。
     */
    async tryCall(name, args, exec, timeoutMs, label) {
      try {
        return await bridge.call(name, args, exec, timeoutMs)
      } catch (err) {
        const who = typeof label === 'string' && label.length > 0 ? label : name
        return { entry: undefined, def: undefined, value: undefined, text: brand(`${who}未完成：${errText(err)}`) }
      }
    },

    promptDeclarations() {
      return prompts.slice()
    },

    snapshot() {
      return {
        tools: [...tools.values()].map((t) => ({ name: t.name, vendor: t.vendor })),
        prompts: prompts.map((p) => ({ vendor: p.vendor, kind: p.kind, name: String(p.decl?.name) })),
      }
    },
  }

  return bridge
}
