/**
 * 验收：nebula 的 systemPrompt.context 已改为「只有稳定 RULE」，不再每轮注入邻域。
 * 用临时 DSH_HOME，不碰真实星图数据。
 * 用法：node tools/probe-inject.mjs
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 沙箱 DSH_HOME：挂在临时目录，别在工程目录里留 .probe-home（会进两棵树比对、也会被当成星图数据）
const tmpHome = mkdtempSync(join(tmpdir(), 'macro-inject-home-'))
mkdirSync(join(tmpHome, 'memory-nebula'), { recursive: true })
process.env.DSH_HOME = tmpHome

const registered = []
const captured = {}
const noop = () => {}

function makeCtx() {
  const tools = { register: (def) => { registered.push(def); return noop } }
  const systemPrompt = {
    context: (def) => { captured.context = def; return noop },
    section: (def) => { captured.section = def; return noop },
  }
  const base = {
    tools,
    systemPrompt,
    effect: (fn) => { try { fn() } catch { /* ignore */ } return noop },
    on: () => noop,
    get: () => ({ register: noop, section: noop }),
    logger: { info: noop, warn: noop, error: noop, debug: noop },
    webServer: { registerRoutes: noop },
    connection: { on: noop },
  }
  return new Proxy(base, {
    get(t, k) { return k in t ? t[k] : noop },
  })
}

const mod = await import('../vendor/dsh-memory-nebula/lib/index.js')
const results = []
const check = (label, ok, extra = '') => {
  results.push({ label, ok, extra })
  console.log((ok ? 'PASS ' : 'FAIL ') + label + (extra ? '  ' + extra : ''))
}

check('插件 name', mod.name === 'memory-nebula', mod.name)
check('inject 四项未变', mod.inject.join(',') === 'tools,systemPrompt,webServer,connection', mod.inject.join(','))

let threw = null
try {
  const ret = mod.apply(makeCtx())
  if (ret && typeof ret.then === 'function') await ret
} catch (err) {
  threw = err
}
check('apply 未抛错', threw === null, threw ? threw.message : '')

// 等 live.ensure 之类的异步收尾（不让它影响断言，但让它有机会跑完）
await new Promise((r) => setTimeout(r, 50))

check('注册了 systemPrompt.context', !!captured.context, Object.keys(captured).join(','))
check('注入块 name = memory-nebula:rules', captured.context?.name === 'memory-nebula:rules', String(captured.context?.name))
check('注入块 order = 960', captured.context?.order === 960, String(captured.context?.order))
check('text 是函数', typeof captured.context?.text === 'function', typeof captured.context?.text)

const t = captured.context?.text
const plain = t?.()
const sameAgain = t?.()
const withSession = t?.({ agent: { session: { header: { id: 'sess-probe', cwd: 'D:/probe-workspace' } } } })

check('text() 返回字符串', typeof plain === 'string', typeof plain)
check('text() 稳定（两次同一引用）', plain === sameAgain)
check('带会话上下文也返回同一字符串', withSession === plain)
// 断言的是「只剩一段稳定 RULE」这件事，不是某个具体字数：0.2.11 把星图改名叫「宏记忆 · 星图」，
// RULE 里那几处随之 +4 字符，写死 689 就变成「改名顺便弄挂一支探针」。上限 800 仍能抓住
// 「又偷偷把邻域注入塞回来」这种回归（旧版每轮注入是 KB 级的）。
check('长度仍是 RULE 量级（< 800 字符，不随会话变化）', plain.length < 800, String(plain.length))
check('不再含「星图挑了」', !plain.includes('星图挑了'))
check('不再含未读邻居段落', !plain.includes('与本会话已读记忆相连'))
check('RULE 第 1 条仍在', plain.includes('nebula_recall'))
check('RULE 最后一条（bridge 指引）仍在', plain.includes('nebula_bridge(memory_ids=[…]) 会挑出强相关但还没读过的邻居'))

check('工具数 = 9（邻域能力仍在工具面）', registered.length === 9, String(registered.length))
const names = registered.map((d) => d.name).sort()
check('nebula_bridge 仍注册', names.includes('nebula_bridge'), names.join(','))

const failed = results.filter((r) => !r.ok)
console.log('---')
console.log(`结果：${results.length - failed.length}/${results.length} PASS`)
console.log('注入文本前缀：', JSON.stringify(plain.slice(0, 60)))
try { rmSync(tmpHome, { recursive: true, force: true }) } catch { /* ignore */ }
if (failed.length) process.exit(1)
