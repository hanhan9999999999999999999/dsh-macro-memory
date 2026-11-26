/**
 * 验收：管理界面（PLAN-UNIVERSAL §10 / P2-1）。
 *
 * 检的是「界面是一扇窗，不是第二个写者，也不是一条捷径」：
 *   U1  只听 `127.0.0.1`（server.address().address 就是它），端口由系统挑
 *   U1b 令牌不对时连首页都不给（不是「先给页面再挡接口」）
 *   U2  首屏 ≤200 KB（PLAN §10 的硬判据）
 *   U3  七页都在页面里（概览 / 记忆 / 星图 / 注入预览 / agent / 共享 / 运维）
 *   U4  `/api/state` 把分布账、注入体积、上游模式一起给出
 *   U5  `/api/inject` 与引擎自己的 `injection()` 同一份字（字符数一致）
 *   U6  **界面改一条，宿主下次检索立刻读到**（PLAN P2-1 的判据，用另一个引擎实例验）
 *   U7  界面自己起的服务不写发现文件（`serve.json` 不出现）——它是客户端，不是共享服务
 *   U8  探到现成 serve 就借它，且关界面**不停别人的服务**
 *   U9  关掉之后端口不再接受连接（进程与端口全消失）
 *   U10 库不存在时只报空账，不为了让界面好看而在工作区里建目录建表
 *
 * 全部在临时目录里做，不碰真实库。
 * 用法：node tools/probe-ui.mjs
 */
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { root } from './_root.mjs'

const mod = (p) => import(pathToFileURL(join(root, p)).href)

let pass = 0
let fail = 0
function check(name, cond, detail = '') {
  if (cond) {
    pass += 1
    console.log(`PASS  ${name}  ${detail}`)
  } else {
    fail += 1
    console.log(`FAIL  ${name}  ${detail}`)
  }
}

const tmp = mkdtempSync(join(tmpdir(), 'macro-ui-'))
const ws = join(tmp, 'ws')
const home = join(tmp, 'home')
const dataDir = join(tmp, 'data')
const bare = join(tmp, 'bare')
for (const d of [ws, home, dataDir, bare]) mkdirSync(d, { recursive: true })

process.env.DSH_HOME = join(tmp, 'dsh-home')
mkdirSync(join(process.env.DSH_HOME, 'storages'), { recursive: true })
writeFileSync(join(process.env.DSH_HOME, 'storages', 'meow-memory-home.json'), JSON.stringify({ homeDir: home }))

const { createMacroEngine } = await mod('lib/core/engine.js')
const { startUi } = await mod('lib/ui/server.js')

// 先由一个「宿主」把工作区信任掉、写一条底料——界面之后写的那条要和它同库
const host = await createMacroEngine({ dataDir, homeDir: home, projectDir: '.dsh-meow', meow: { autoMigrate: false }, serve: 'off' })
host.trust(ws)
await host.call(
  'memory_remember',
  { content: '界面验收底料：这一条是宿主写的，界面只负责把它读出来。', level: 'fact', keywords: ['界面底料'], importance: 2, project: 'ui' },
  { cwd: ws, agentId: 'host' },
)
const hostChars = String(host.injection({})).length
await host.close()

const ui = await startUi({ dataDir, cwd: ws })
const addr = ui.server.address()
check('U1 只听 127.0.0.1（端口由系统挑）', addr && addr.address === '127.0.0.1' && addr.port > 0, `${addr?.address}:${addr?.port}`)

const getRaw = async (p, tok = ui.token) => {
  const r = await fetch(`http://127.0.0.1:${ui.port}${p}`, { headers: tok ? { 'x-mm-token': tok } : {} })
  const text = await r.text()
  return { status: r.status, text }
}
const getJson = async (p) => JSON.parse((await getRaw(p)).text)
const postJson = async (p, body) => {
  const r = await fetch(`http://127.0.0.1:${ui.port}${p}`, {
    method: 'POST',
    headers: { 'x-mm-token': ui.token, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: r.status, json: await r.json() }
}

const noTok = await getRaw('/', '')
check('U1b 令牌不对时连首页都不给', noTok.status === 401, `status ${noTok.status}`)

const page = await getRaw('/')
const bytes = Buffer.byteLength(page.text)
check('U2 首屏 ≤200 KB', page.status === 200 && bytes > 0 && bytes <= 200 * 1024, `${bytes} B`)
check(
  'U3 七页都在页面里',
  ['overview', 'memory', 'graph', 'inject', 'agents', 'share', 'ops'].every((x) => page.text.includes(`'${x}', '`)) && page.text.includes('hashchange'),
  '七页路由 + hashchange 都在',
)

const state = await getJson('/api/state')
check(
  'U4 分布账 / 注入体积 / 上游模式一起给出',
  state.ok === true && typeof state.census?.total === 'number' && state.census.layers && typeof state.injectChars === 'number' && state.upstream?.mode === 'local',
  `total ${state.census?.total} · inject ${state.injectChars} 字符 · upstream ${state.upstream?.mode}`,
)
check('U5 /api/inject 与引擎同一份字', (await getJson('/api/inject')).chars === hostChars, `接口 ${(await getJson('/api/inject')).chars} / 引擎 ${hostChars}`)

// 界面写一条 → 宿主（另一实例）下次检索立刻读到
const wrote = await postJson('/api/call', {
  tool: 'memory_remember',
  args: { content: '界面写进去的：蓝鲸在深海里敲了一下键盘。', level: 'fact', keywords: ['蓝鲸'], importance: 2, project: 'ui' },
})
const host2 = await createMacroEngine({ dataDir, homeDir: home, projectDir: '.dsh-meow', meow: { autoMigrate: false }, serve: 'off' })
const seen = await host2.call('memory_search', { query: '蓝鲸', k: 5 }, { cwd: ws, agentId: 'host' })
await host2.close()
check(
  'U6 界面改一条，宿主下次检索立刻读到',
  wrote.status === 200 && String(wrote.json?.text ?? '').includes('已写入') && String(seen.text).includes('蓝鲸在深海'),
  String(wrote.json?.text ?? '').slice(0, 40).replace(/\n/g, ' '),
)
check('U7 界面自己起的服务不写发现文件', !existsSync(join(dataDir, 'serve.json')), `serve.json 不存在（upstream ${state.upstream?.mode}）`)

// 借现成 serve：起一个真服务，界面应切成 shared；关界面不许把别人的服务带走
const { startServe } = await mod('lib/core/serve.js')
const shared = await startServe({ dataDir, cwd: ws, port: 0 })
const ui2 = await startUi({ dataDir, cwd: ws })
const api2 = async (p) => (await fetch(`http://127.0.0.1:${ui2.port}${p}`, { headers: { 'x-mm-token': ui2.token } })).json()
const state2 = await api2('/api/state')
check('U8 探到现成 serve 就借它（且关界面不停别人的服务）', state2.upstream.mode === 'shared', `upstream ${state2.upstream.mode}`)
await ui2.close('probe-ui')
const client = await mod('lib/core/client.js')
const alive = await client.discover(dataDir)
check('U8b 关掉界面后共享服务还在跑', alive.mode === 'shared', `discover → ${alive.mode}`)
await shared.close('probe-ui')

const port0 = ui.port
await ui.close('probe-ui')
let refused = false
try {
  await fetch(`http://127.0.0.1:${port0}/?t=${ui.token}`)
} catch {
  refused = true
}
check('U9 关掉之后端口不再接受连接', refused, `端口 ${port0}`)

// 空库只读：库不存在时不建目录、不建表
const ui3 = await startUi({ dataDir: join(tmp, 'data-bare'), cwd: bare })
const bareState = await (async () => {
  const r = await fetch(`http://127.0.0.1:${ui3.port}/api/state`, { headers: { 'x-mm-token': ui3.token } })
  return r.json()
})()
const bareDir = join(bare, '.dsh-meow')
check(
  'U10 库不存在时只报空账（不建目录、不建表）',
  bareState.census?.total === 0 && !existsSync(bareDir),
  `total ${bareState.census?.total} · ${bareDir} 存在=${existsSync(bareDir)}`,
)
await ui3.close('probe-ui')

console.log(`\n${pass} PASS / ${fail} FAIL`)
try {
  const { rmSync } = await import('node:fs')
  rmSync(tmp, { recursive: true, force: true })
} catch {
  // Windows 上 SQLite 句柄偶尔还没释放，删不掉不影响判据
}
process.exit(fail === 0 ? 0 : 1)
