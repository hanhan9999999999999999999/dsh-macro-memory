/**
 * 探针：在 stub 出来的浏览器环境里跑一遍 lib/client.js，然后模拟宿主加载
 * （拿 factory → 执行 → apply），看**冷启动、单次执行**下 UI 到底会不会挂上。
 *
 * 为什么要有它：线上症状是「设置页的 meow 配置节、侧栏星图、折叠条全都不见」，
 * 而 verify.mjs 只验到「三个 id 注册了、组合层会 ctx.plugin 两个子插件」——
 * 再往下一层（slots 真的收到 register 调用）没有任何断言。这个脚本补的就是那层。
 *
 * 用法：node tools/probe-client-ui.mjs
 */
import { root } from './_root.mjs'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

let failures = 0
function check(label, ok, extra) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra === undefined ? '' : '  ' + extra}`)
  if (!ok) failures++
}

// ── 浏览器 stub ─────────────────────────────────────────────────────────────
const noop = () => {}
const el = () => ({
  style: {}, dataset: {},
  classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
  setAttribute: noop, getAttribute: () => null, removeAttribute: noop,
  appendChild: noop, removeChild: noop, insertBefore: noop,
  addEventListener: noop, removeEventListener: noop,
  querySelector: () => null, querySelectorAll: () => [],
  children: [], innerHTML: '', textContent: '',
})
const documentStub = { ...el(), head: el(), body: el(), documentElement: el(), createElement: el, createTextNode: el, createDocumentFragment: el }
const windowStub = {
  document: documentStub,
  location: { href: 'http://127.0.0.1/', origin: 'http://127.0.0.1', search: '', pathname: '/' },
  navigator: { language: 'zh-CN', languages: ['zh-CN'] },
  localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
  matchMedia: () => ({ matches: false, addEventListener: noop, removeEventListener: noop }),
  addEventListener: noop, removeEventListener: noop, dispatchEvent: () => true,
  requestAnimationFrame: (fn) => setTimeout(fn, 0), cancelAnimationFrame: noop,
  setTimeout, clearTimeout, setInterval: () => 0, clearInterval: noop,
  MutationObserver: class { observe() {} disconnect() {} },
  ResizeObserver: class { observe() {} disconnect() {} },
  IntersectionObserver: class { observe() {} disconnect() {} },
  getComputedStyle: () => ({ getPropertyValue: () => '' }),
  console,
}
windowStub.window = windowStub
windowStub.self = windowStub
windowStub.globalThis = windowStub

const registry = new Map()
windowStub.__ModuleLoader__ = {
  load(def) {
    if (registry.has(def.id)) throw new Error('duplicate factory registration for "' + def.id + '"')
    registry.set(def.id, def.factory)
  },
}

const react = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  Fragment: Symbol('Fragment'),
  useState: (v) => [typeof v === 'function' ? v() : v, noop],
  useEffect: noop, useLayoutEffect: noop, useInsertionEffect: noop,
  useMemo: (f) => f(), useCallback: (f) => f, useRef: (v) => ({ current: v }),
  useSyncExternalStore: (sub, get) => get(),
  useContext: () => ({}), createContext: (v) => ({ Provider: null, Consumer: null, _currentValue: v }),
  memo: (c) => c, forwardRef: (f) => f, cloneElement: (x) => x,
  Children: { map: () => [], toArray: () => [], forEach: noop },
}

const requireStub = (name) => {
  if (name === 'react') return react
  if (registry.has(name)) return registry.get(name)(requireStub)
  throw new Error('unexpected require: ' + name)
}

// ── 执行 client bundle（单次）──────────────────────────────────────────────
const code = readFileSync(join(root, 'lib', 'client.js'), 'utf8')
for (const key of ['MutationObserver', 'ResizeObserver', 'IntersectionObserver', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame']) {
  globalThis[key] = windowStub[key]
}
const run = new Function('window', 'document', 'navigator', 'console', 'require', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', code)
run(windowStub, documentStub, windowStub.navigator, console, requireStub, setTimeout, clearTimeout, () => 0, noop)

check('bundle 被执行一次后注册 3 个 id', registry.size === 3, [...registry.keys()].join(', '))

// ── 宿主 stub：slots 服务 + cordis 风格的 ctx ──────────────────────────────
const slots = {
  injects: [],
  registers: [],
  register(meta, comp) {
    // label 可能是 thunk（跟随语言切换），这里当场求值一份用来断言「面板口径」
    let label
    try {
      label = typeof meta.label === 'function' ? meta.label() : meta.label
    } catch (err) {
      label = `ERR:${err && err.message}`
    }
    this.registers.push({ name: meta.name, key: meta.key, id: meta.id, label, comp: typeof comp, component: comp, inject: meta.inject })
    return () => {}
  },
  inject(name, cb) {
    this.injects.push(name)
    const out = cb()
    return typeof out === 'function' ? out : () => {}
  },
}

const services = {
  slots,
  sessions: {},
  'remote.settings': {},
  // 宿主真实存在的服务：dsh-client-ui-settings 提供的 configForms。
  // 返回一个只有 macro-memory 命名空间的对象，模拟「entry id 就是 macro-memory」。
  configForms: {
    get(ns) {
      if (ns === 'macro-memory' || ns === 'dsh-macro-memory') return { namespace: ns, values: {} }
      return undefined
    },
  },
}

function makeCtx(depth = 0) {
  const ctx = {
    slots,
    sessions: { list: () => [], get: () => undefined, subscribe: () => () => {} },
    remote: { settings: { get: () => undefined, set: () => {} } },
    // 真实 cordis：fiber 活着时取不存在的服务得到 undefined；fiber 已 inactive
    // （bundle 被 HMR 重跑、旧 fiber 被 dispose）时抛 cannot get required service。
    get(name) {
      return services[name]
    },
    plugin(mod, cfg) {
      if (!mod || typeof mod.apply !== 'function') return () => {}
      if (depth > 2) return () => {}
      try {
        mod.apply(makeCtx(depth + 1), cfg)
      } catch (err) {
        console.error('[probe] 子插件 apply 抛出：' + (mod.name || '?'), err && err.message)
      }
      return () => {}
    },
    inject(deps, cb) {
      try { cb(makeCtx(depth + 1)) } catch (err) { console.error('[probe] inject 回调抛出：', err && err.message) }
      return () => {}
    },
    effect(fn) { const out = fn(); return typeof out === 'function' ? out : () => {} },
    scope() { return ctx },
    on: noop, off: noop, emit: noop, once: noop,
  }
  return ctx
}

const self = registry.get('dsh-macro-memory')(requireStub)
try {
  self.apply(makeCtx())
} catch (err) {
  console.error('[probe] 组合层 apply 抛出：', err && err.message)
}

// ── 断言：宿主该收到的注册都收到了 ─────────────────────────────────────────
const names = slots.registers.map((r) => r.name)
console.log('\nslots.inject 收到：', slots.injects.join(', ') || '(无)')
console.log('slots.register 收到：', slots.registers.map((r) => r.name + (r.key ? '[' + r.key + ']' : r.id ? '#' + r.id : '')).join(', ') || '(无)')
console.log('')

check('meow: 设置页注册了 settings.section', names.includes('settings.section'))
check('nebula: 侧栏图标注册了 sidebar.panellist', names.includes('sidebar.panellist'))
check('nebula: 主面板注册了 main', names.includes('main'))
check('meow: 折叠条挂到了会话槽位', names.some((n) => n.startsWith('conversation.')))

const mainReg = slots.registers.find((r) => r.name === 'main')
check('nebula: main 的 key 是 memory-nebula', mainReg?.key === 'memory-nebula', mainReg?.key)
const navReg = slots.registers.find((r) => r.name === 'sidebar.panellist')
check('nebula: 侧栏 id 是 memory-nebula', navReg?.id === 'memory-nebula', navReg?.id)
const setReg = slots.registers.find((r) => r.name === 'settings.section')
check('meow: 设置节 id 是 meow-memory（UI 命名空间）', setReg?.id === 'meow-memory', setReg?.id)

// ── 面板口径：对外只留「宏记忆」一个名字 ──────────────────────────────────
check('口径: 设置页入口叫「宏记忆」', setReg?.label === '宏记忆', setReg?.label)
check('口径: 侧栏入口叫「宏记忆 · 星图」', navReg?.label === '宏记忆 · 星图', navReg?.label)
const strayLabels = slots.registers
  .map((r) => r.label)
  .filter((l) => typeof l === 'string' && /喵记忆|记忆星图|Memory Nebula|Meow Memory/.test(l))
check('口径: 没有任何入口还留着旧名字', strayLabels.length === 0, strayLabels.join(' | ') || undefined)
check('口径: 面板 id 未被改写（宿主/书签认 id）', mainReg?.key === 'memory-nebula' && navReg?.id === 'memory-nebula')

// ── 0.6.42：设置页真的把六个旋钮渲染出来了（不是只写进 FIELDS 就算） ────────
// 用 host 那一侧的注入结果当 props（真实宿主也是这么传的：inject() 给什么，组件收到什么），
// 把组件跑一遍，收集整棵树里的文本节点，再逐条断言中文字面量。
const scopeStub = {
  subscribe: () => () => {},
  getSnapshot: () => ({ status: 'ready', mode: 'local', writable: true, user: {}, defaults: {} }),
  set: async () => true,
  unset: async () => true,
  bind: () => scopeStub,
}
const collectText = (node, out = []) => {
  if (node === null || node === undefined) return out
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node))
    return out
  }
  if (Array.isArray(node)) {
    for (const one of node) collectText(one, out)
    return out
  }
  if (typeof node === 'object') {
    if (node.props !== undefined && node.props !== null) {
      for (const v of Object.values(node.props)) {
        if (typeof v === 'string' || typeof v === 'number') out.push(String(v))
      }
    }
    collectText(node.children, out)
  }
  return out
}
let panelText = ''
try {
  const props = { ...(typeof setReg?.inject === 'function' ? setReg.inject() : {}), scope: scopeStub }
  panelText = collectText(setReg.component(props)).join(' | ')
} catch (err) {
  panelText = `ERR:${err && err.message}`
}
for (const label of ['单条正文基准上限', '命中相关度闸', '每轮带星图邻域', '每轮邻居条数', '邻域块字符上限', '邻居强度下限', '项目全景上限']) {
  check(`0.6.42 面板渲染出「${label}」`, panelText.includes(label), panelText.startsWith('ERR:') ? panelText.slice(0, 120) : undefined)
}
check('0.6.42 面板里有「星图邻域」分组标题', panelText.includes('星图邻域'))
check('0.6.63 面板里有「工具回执」分组与目录口径说明', panelText.includes('工具回执') && panelText.includes('还有几条没列'))
check(
  '0.6.48 面板说明写清「按名次分配」（最贴问的给两倍基准、其余六成）',
  panelText.includes('每轮按名次分配') && panelText.includes('两倍基准') && panelText.includes('六成'),
  panelText.slice(0, 200)
)

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
