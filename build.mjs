/**
 * 生成 lib/client.js —— 浏览器侧组合层。
 *
 * 做法是纯文本拼接，不解析、不改写任何一方的代码逻辑：
 *
 *   1. 取 vendor/meow-memory/lib/client.js 全文，只把它的模块 id 改成
 *      'dsh-macro-memory-meow'（避免与真实 meow-memory 包的 id 撞车），
 *      并把 sourceMappingURL 指向 vendor 里的原 map；
 *   2. 取 vendor/dsh-memory-nebula/lib/client.js 全文，只把模块 id 改成
 *      'dsh-macro-memory-nebula'；
 *   3. 追加一小段组合层，注册 id = 'dsh-macro-memory'：它的 factory 里
 *      require 上面两个模块，把两个 UI 插件当成 cordis 子插件挂上去。
 *
 * 三个 load 都在同一个文件里，所以宿主只需为 dsh-macro-memory 加载这一份脚本，
 * 文件执行时三个 factory 一起进注册表；组合层 materialize 时再按需拉起前两个。
 *
 * 用法：node build.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { applySettingsFields } from './tools/patch-settings-fields.mjs'

const root = dirname(fileURLToPath(import.meta.url))
const MEOW_ID = 'dsh-macro-memory-meow'
const NEBULA_ID = 'dsh-macro-memory-nebula'
const SELF_ID = 'dsh-macro-memory'

function once(text, from, to) {
  const n = text.split(from).length - 1
  if (n !== 1) throw new Error(`expected exactly one occurrence of ${JSON.stringify(from)}, found ${n}`)
  return text.replace(from, to)
}

/** 只改顶层 load 的 id：bundle 内部 slots.register 里也有 id 字段，不能一起替换。 */
function replaceLoadId(text, fromId, toId) {
  const re = new RegExp(`(window\\.__ModuleLoader__\\.load\\(\\{\\s*\\n\\s*id: )(["'])${fromId}\\2`)
  const hits = text.match(new RegExp(re.source, 'g'))
  if (!hits || hits.length !== 1) throw new Error(`load-id ${fromId}: expected 1 match, got ${hits ? hits.length : 0}`)
  return text.replace(re, `$1"${toId}"`)
}

/** 明确个数的全量替换：少一处多一处都当切片漂移报错，不静默放过。 */
function replaceN(text, from, to, expected) {
  const n = text.split(from).length - 1
  if (n !== expected) throw new Error(`expected ${expected} occurrence(s) of ${JSON.stringify(from)}, found ${n}`)
  return text.split(from).join(to)
}

const meowPath = join(root, 'vendor', 'meow-memory', 'lib', 'client.js')
const nebulaPath = join(root, 'vendor', 'dsh-memory-nebula', 'lib', 'client.js')

let meow = readFileSync(meowPath, 'utf8')
meow = replaceLoadId(meow, 'meow-memory', MEOW_ID)
meow = once(meow, '//# sourceMappingURL=client.js.map', '//# sourceMappingURL=../vendor/meow-memory/lib/client.js.map')
if (!meow.includes('return module.exports;')) throw new Error('meow client bundle: unexpected shape')

// ── 面板口径：设置面板自己的标题（0.2.11）─────────────────────────────────
// meow 的设置面板内部拿 t("settings.title") 当 <h2> 与设置段标题，词典里写的是它
// 自己的旧名「喵记忆」/「Meow memory」。侧栏、设置段、工具面都已经叫「宏记忆」了，
// 面板里却写着另一个名字，用户会当成两个东西。只改词典里的这一条显示值，
// 词典结构、key、其它文案全部不动（zh 在 bundle 里是 \u 转义，所以按转义串替换）。
meow = once(meow, '"settings.title": "\\u55B5\\u8BB0\\u5FC6"', '"settings.title": "\\u5B8F\\u8BB0\\u5FC6"')
meow = replaceN(meow, '"settings.title": "Meow memory"', '"settings.title": "Macro Memory"', 2)

// ── 注入与星图邻域的旋钮搬进面板（0.6.42）──────────────────────────────────
// 六个旋钮（injectFloor / injectBodyMax / neighborInject / neighborMax /
// neighborChars / neighborMinScore）引擎与融合层都认，但面板里一个都没有。
// 补丁与文案在 tools/patch-settings-fields.mjs 里，锚点对不上会抛错。
meow = applySettingsFields(meow)

// ── 设置页「自定义库位置」的示例文案（0.7.0 · mac 适配）──────────────────────
// 原 placeholder 是 "D:\\data\\meow-memory"：Windows 上看得懂，mac 上是一条不存在的
// 盘符路径（mac 连 `D:` 这个概念都没有）。示例文案不该带平台假设，换成三平台通用的
// `~/.dsh/macro-memory`——宿主自己也不展开 `~`，所以它只是一句「长这样」，不是可填的值。
// 只改这一条显示值：字段 key / type / hint / 出厂值全部不动。
meow = once(meow, 'placeholder: "D:\\\\data\\\\meow-memory"', 'placeholder: "~/.dsh/macro-memory"')

let nebula = readFileSync(nebulaPath, 'utf8')
nebula = replaceLoadId(nebula, 'dsh-memory-nebula', NEBULA_ID)
if (!nebula.includes('module.exports = {')) throw new Error('nebula client bundle: unexpected shape')

const combiner = `
// ═══════════════════════════════════════════════════════════════════════════
// 组合层：把上面两份 UI 插件并排挂到同一个客户端 ctx 上。
// 逻辑只有「各调一次 apply」，不改写任何一方的行为。
// ═══════════════════════════════════════════════════════════════════════════
window.__ModuleLoader__.load({
  id: '${SELF_ID}',
  factory: function (require) {
    var module = { exports: {} }

    var meow = require('${MEOW_ID}')
    var nebula = require('${NEBULA_ID}')

    function union(a, b) {
      var out = []
      var i
      for (i = 0; i < (a || []).length; i++) if (out.indexOf(a[i]) < 0) out.push(a[i])
      for (i = 0; i < (b || []).length; i++) if (out.indexOf(b[i]) < 0) out.push(b[i])
      return out
    }

    // 子插件拿到的 ctx 在这里换掉 slots（宿主给 ctx.plugin 的 ctx 是它自己造的，
    // 所以归口必须发生在「子插件 apply 的入口」，不能在组合层 apply 外面套）。
    function asPlugin(mod, label) {
      return {
        name: label,
        inject: mod.inject || [],
        apply: function (ctx) {
          return mod.apply(brandCtx(ctx))
        },
      }
    }

    var children = [
      asPlugin(meow, 'meow-memory-ui'),
      asPlugin(nebula, 'memory-nebula-ui'),
    ]

    // ── 面板口径统一 ─────────────────────────────────────────────────────
    // 两个子 UI 各自注册自己的面板：meow 的设置节叫「喵记忆」，nebula 的侧栏图标叫
    // 「记忆星图」。一个插件对外应该只有一个名字，所以这里只改 slot 登记里的显示文案，
    // id / key / order / comp 全部原样透传——宿主、旧书签、按 id 过滤的 owner 都不受影响。
    // label 可能是 thunk（跟随语言切换），所以包一层函数而不是求值一次。
    var LABEL_BY_ID = { 'meow-memory': '宏记忆', 'memory-nebula': '宏记忆 · 星图' }
    var LABEL_RULES = [
      [/^喵记忆$/, '宏记忆'],
      [/^记忆星图$/, '宏记忆 · 星图'],
      [/^Meow Memory$/i, 'Macro Memory'],
      [/^Memory Nebula$/i, 'Macro Memory · Graph'],
    ]
    function brandText(value, fixed) {
      if (typeof value !== 'string') return value
      var out = fixed || value
      for (var i = 0; i < LABEL_RULES.length; i++) out = out.replace(LABEL_RULES[i][0], LABEL_RULES[i][1])
      return out
    }
    function brandLabel(value, meta) {
      var id = meta && (meta.id || meta.key)
      var fixed = id ? LABEL_BY_ID[id] : undefined
      if (typeof value === 'function') {
        return function () {
          var text = value()
          return brandText(text, fixed)
        }
      }
      return brandText(value, fixed)
    }
    function brandMeta(meta) {
      if (!meta || typeof meta !== 'object') return meta
      var out = {}
      for (var k in meta) out[k] = meta[k]
      if ('label' in out) out.label = brandLabel(out.label, meta)
      if ('title' in out) out.title = brandLabel(out.title, meta)
      return out
    }
    function slotsFacade(slots) {
      if (!slots || typeof slots.register !== 'function') return slots
      var facade = Object.create(slots)
      facade.register = function (meta, comp) {
        return slots.register.call(slots, brandMeta(meta), comp)
      }
      if (typeof slots.inject === 'function') {
        facade.inject = function (name, cb) {
          if (typeof cb !== 'function') return slots.inject.apply(slots, arguments)
          return slots.inject.call(slots, name, function (scoped) {
            // 嵌套注册也走同一套归口：inject 回调解到的 scoped ctx 同样换 slots
            return cb(scoped === undefined || scoped === null ? scoped : brandCtx(scoped))
          })
        }
      }
      return facade
    }
    function brandCtx(ctx) {
      if (!ctx || typeof ctx !== 'object') return ctx
      var slots = ctx.slots
      if (!slots || typeof slots.register !== 'function') return ctx
      var facade = slotsFacade(slots)
      try {
        return new Proxy(ctx, {
          get: function (target, prop) {
            if (prop === 'slots') return facade
            if (prop === 'scope') {
              return function () {
                var scoped = target.scope.apply(target, arguments)
                return brandCtx(scoped)
              }
            }
            if (prop === 'get') {
              return function (name) {
                var out = target.get.apply(target, arguments)
                return name === 'slots' ? facade : out
              }
            }
            var value = target[prop]
            return typeof value === 'function' ? value.bind(target) : value
          },
          has: function (target, prop) {
            return prop in target
          },
        })
      } catch (err) {
        // 老浏览器/受限环境拿不到 Proxy：宁可放弃归口也不能挡住面板注册
        return ctx
      }
    }

    module.exports = {
      name: 'macro-memory',
      inject: union(meow.inject, nebula.inject),
      apply: function (ctx) {
        for (var i = 0; i < children.length; i++) {
          var child = children[i]
          try {
            if (typeof ctx.plugin === 'function') {
              ctx.plugin(child, {})
            } else {
              child.apply(ctx)
            }
          } catch (err) {
            var tag = '[macro-memory] client plugin failed: ' + child.name
            if (typeof console !== 'undefined' && console.error) console.error(tag, err)
          }
        }
      },
    }

    return module.exports
  },
})
`

// ── 重复注册守卫 ────────────────────────────────────────────────────────────
// 宿主可能把同一份 client bundle 用两个 specifier 各拉一次（`pkg` 与
// `pkg/client`）。ClientModuleSystem.register 对同 id 的第二次注册会抛
// "duplicate factory registration"，而这个错误顺着 bundle 执行链冒泡，会把
// 后面两个 load 一起打断——nebula 的 UI、组合层都不再注册，于是设置页与星图
// 整片消失（2026-11-18 实测）。这里只对「重复注册」这一种错误放行，其余照抛。
const guard = `
// ── 重复执行守卫（由 build.mjs 注入，勿手改）────────────────────────────────
// 详见 build.mjs 里的同名注释：同一 bundle 被执行两次时，第二个 register 会
// 抛 duplicate factory registration，并打断后续 load。这里吞掉这一种错误。
;(function () {
  var loader = typeof window !== 'undefined' ? window.__ModuleLoader__ : void 0
  if (!loader || typeof loader.load !== 'function' || loader.load.__macroGuarded) return
  var original = loader.load
  var guarded = function (registration) {
    try {
      return original.call(loader, registration)
    } catch (err) {
      var message = err && err.message ? String(err.message) : ''
      if (message.indexOf('duplicate factory registration') < 0) throw err
      if (typeof console !== 'undefined' && console.warn) {
        console.warn('[macro-memory] 同一 bundle 被加载了第二次，已忽略重复注册：' + message)
      }
      return void 0
    }
  }
  guarded.__macroGuarded = true
  loader.load = guarded
})()
`

const out = `${guard}\n${meow.trimEnd()}\n\n${nebula.trimEnd()}\n${combiner}`
writeFileSync(join(root, 'lib', 'client.js'), out, 'utf8')
console.log(`lib/client.js written: ${Buffer.byteLength(out, 'utf8')} bytes`)
console.log(`  ids: ${SELF_ID} / ${MEOW_ID} / ${NEBULA_ID}`)
