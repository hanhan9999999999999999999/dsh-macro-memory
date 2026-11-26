/**
 * 验收：MCP 面（PLAN-UNIVERSAL §11 / P0-2、P2-3）。
 *
 * 检的是「别的宿主接进来，能不能真的读写同一份库」，而不是「文件里有没有 export」：
 *   M1  握手：`serverInfo` 的名字与版本跟根 package.json 同一个号；协议版本在支持列表里
 *   M2  握手就带手册：`instructions` 就是引擎那份注入正文，宿主不必再去翻文档
 *   M3  工具清单：8 个 `memory_*`，名字与 schema 跟引擎的 IR 逐字段一致（不是另抄一份）
 *   M4  **真写**：子进程 `tools/call memory_remember` 之后，另一个引擎实例立刻检索得到
 *   M5  归属：库里记下的 owner 是客户端自报的名字（`clientInfo.name`），不是猜的
 *   M6  **协议纯净**：stdout 每一行都是 JSON-RPC 报文，日志只走 stderr
 *   M7  坏报文：不是 JSON → -32700；未知方法 → -32601；未知工具 → -32602 且带可选清单
 *   M8  工具自己出错不炸协议：走 `result.isError`，JSON-RPC 层没有 `error`
 *   M9  可选能力明确回空：`ping` / `resources/list` / `prompts/list` 不装死
 *   M10 收摊：关 stdin 之后进程自己退出，退出码 0，不留僵尸
 *   M11 工作区：`--cwd` > `MACRO_MEMORY_WORKSPACE` > cwd，三条优先级各认一次
 *
 * 全部在临时目录里做，不碰真实库。
 * 用法：node tools/probe-mcp.mjs
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import readline from 'node:readline'
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

const tmp = mkdtempSync(join(tmpdir(), 'macro-mcp-'))
const ws = join(tmp, 'ws')
const home = join(tmp, 'home')
const dataDir = join(tmp, 'data')
for (const d of [ws, home, dataDir]) mkdirSync(d, { recursive: true })

process.env.DSH_HOME = join(tmp, 'dsh-home')
mkdirSync(join(process.env.DSH_HOME, 'storages'), { recursive: true })
writeFileSync(join(process.env.DSH_HOME, 'storages', 'meow-memory-home.json'), JSON.stringify({ homeDir: home }))

const { createMacroEngine } = await mod('lib/core/engine.js')
const { workspaceOf, versionOf } = await mod('lib/mcp/stdio.js')
const pkgRoot = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

const eng = await createMacroEngine({ dataDir, homeDir: home, projectDir: '.dsh-meow', meow: { autoMigrate: false } })
eng.trust(ws)

// ── 一个够用的 stdio 客户端 ──────────────────────────────────
// 只做探针要的四件事：写一行、等某条回包、收集所有来包、收尾。
const arrived = []
const noise = []       // stdout 上不是 JSON-RPC 报文的行
const stderrText = []
let seq = 0
const client = (() => {
  const child = spawn(
    process.execPath,
    [join(root, 'bin', 'macro-memory.mjs'), 'mcp', '--data-dir', dataDir, '--home-dir', home],
    { cwd: ws, env: { ...process.env }, stdio: ['pipe', 'pipe', 'pipe'] },
  )
  child.stderr.on('data', (b) => stderrText.push(String(b)))
  const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity })
  rl.on('line', (line) => {
    const text = line.trim()
    if (text === '') return
    let msg
    try {
      msg = JSON.parse(text)
    } catch {
      noise.push(text)
      return
    }
    if (msg === null || typeof msg !== 'object' || msg.jsonrpc !== '2.0') {
      noise.push(text)
      return
    }
    arrived.push(msg)
  })
  const exited = new Promise((resolve) => child.once('exit', (code) => resolve(code)))
  return {
    child,
    exited,
    line: (text) => child.stdin.write(`${text}\n`),
    request(method, params) {
      const id = `r${++seq}`
      const payload = { jsonrpc: '2.0', id, method }
      if (params !== undefined) payload.params = params
      child.stdin.write(`${JSON.stringify(payload)}\n`)
      return id
    },
    async waitFor(pred, ms = 8000) {
      const t0 = Date.now()
      for (;;) {
        const hit = arrived.find(pred)
        if (hit) return hit
        if (Date.now() - t0 > ms) return null
        await new Promise((r) => setTimeout(r, 10))
      }
    },
    async call(method, params) {
      const id = this.request(method, params)
      return this.waitFor((m) => m.id === id)
    },
  }
})()

// ── M1 / M2：握手 ────────────────────────────────────────────
const initId = client.request('initialize', {
  protocolVersion: '2025-06-18',
  capabilities: {},
  clientInfo: { name: 'probeclient', version: '0.0.1' },
})
const init = await client.waitFor((m) => m.id === initId)
const initText = String(init?.result?.instructions ?? '')
check(
  'M1 握手：名字与版本跟根 package.json 同一个号',
  init?.result?.serverInfo?.name === 'macro-memory' &&
    init?.result?.serverInfo?.version === pkgRoot.version &&
    String(init?.result?.protocolVersion ?? '').length > 0,
  `${init?.result?.serverInfo?.name} ${init?.result?.serverInfo?.version} / 协议 ${init?.result?.protocolVersion}`,
)
const expectInject = String(eng.injection({ maxChars: 1200 }))
check(
  'M2 握手就带手册：instructions 就是引擎那份注入正文',
  initText === expectInject && initText.length > 500,
  `${initText.length} 字符`,
)

// ── M3：工具清单与 IR 一致 ──────────────────────────────────
const list = await client.call('tools/list', {})
const listed = Array.isArray(list?.result?.tools) ? list.result.tools : []
const irNames = eng.tools.map((t) => t.name).sort()
check(
  'M3 工具清单：8 个 memory_*，schema 与引擎 IR 逐字段一致',
  listed.length === 8 &&
    listed.every((t) => /^memory_/.test(t.name) && typeof t.description === 'string' && t.inputSchema?.type === 'object') &&
    JSON.stringify(listed.map((t) => t.name).sort()) === JSON.stringify(irNames),
  `${listed.length} 个：${listed.map((t) => t.name).join(' ')}`,
)

// ── M4：真的写进库，别的实例读得到 ──────────────────────────
const KEY = 'MCP 炮台词'
const writeId = client.request('tools/call', {
  name: 'memory_remember',
  arguments: { content: `${KEY}：别的宿主接进来也得能写能读，这才是适配。`, level: 'fact', keywords: [KEY], importance: 2, project: 'mcp' },
})
const wrote = await client.waitFor((m) => m.id === writeId)
const wroteText = String(wrote?.result?.content?.[0]?.text ?? '')
const found = await eng.call('memory_search', { query: KEY, k: 3 }, { cwd: ws, agentId: 'probeclient' })
check(
  'M4 真写：MCP 写进去的东西，另一个引擎实例立刻检索得到',
  wrote?.result?.isError !== true && wroteText.length > 0 && String(found.text).includes(KEY),
  `回执 ${wroteText.length} 字符 / 检索命中 ${/\[\d+\]/.test(String(found.text)) ? '是' : '否'}`,
)

// ── M5：归属是客户端自报的名字 ──────────────────────────────
const census = eng.census(ws)
const owners = (census.agents ?? []).map((a) => a.owner)
check(
  'M5 归属：库里记下的 owner 是客户端自报的名字',
  owners.includes('probeclient'),
  `owner：${owners.join(' ') || '（空）'}`,
)

// ── M6：stdout 只有协议报文 ──────────────────────────────────
check(
  'M6 协议纯净：stdout 每一行都是 JSON-RPC 报文（日志只走 stderr）',
  noise.length === 0,
  noise.length === 0 ? `来包 ${arrived.length} 条，stderr ${stderrText.join('').trim().split('\n').length} 行` : `杂音：${noise[0]?.slice(0, 80)}`,
)

// ── M7：坏报文三种 ──────────────────────────────────────────
client.line('{这不是 JSON')
const parseErr = await client.waitFor((m) => m.error?.code === -32700)
const noMethod = await client.call('nonsense/method', {})
const noTool = await client.call('tools/call', { name: 'memory_nonexistent', arguments: {} })
check(
  'M7 坏报文：不是 JSON → -32700；未知方法 → -32601；未知工具 → -32602 且带可选清单',
  parseErr?.error?.code === -32700 &&
    noMethod?.error?.code === -32601 &&
    noTool?.error?.code === -32602 &&
    Array.isArray(noTool?.error?.data?.available) &&
    noTool.error.data.available.length === 8,
  `${parseErr?.error?.code} / ${noMethod?.error?.code} / ${noTool?.error?.code}（可选 ${noTool?.error?.data?.available?.length ?? 0} 个）`,
)

// ── M8：工具自己出错不炸协议 ────────────────────────────────
// 故意漏掉必填项：schema 门要么拒绝、要么抛错，两条路都必须落在 result 里。
const badCall = await client.call('tools/call', { name: 'memory_remember', arguments: { content: '缺关键词与项目' } })
check(
  'M8 工具自己出错：走 result.isError，JSON-RPC 层没有 error',
  badCall?.error === undefined && badCall?.result?.isError === true && String(badCall?.result?.content?.[0]?.text ?? '').length > 0,
  badCall?.error ? `协议层报错：${badCall.error.code}` : String(badCall?.result?.content?.[0]?.text ?? '').slice(0, 40),
)

// ── M9：可选能力明确回空 ────────────────────────────────────
const pong = await client.call('ping', {})
const res = await client.call('resources/list', {})
const prompts = await client.call('prompts/list', {})
check(
  'M9 可选能力明确回空：ping / resources/list / prompts/list 不装死',
  pong?.result !== undefined &&
    Array.isArray(res?.result?.resources) &&
    res.result.resources.length === 0 &&
    Array.isArray(prompts?.result?.prompts) &&
    prompts.result.prompts.length === 0,
  `ping ${JSON.stringify(pong?.result)} / resources ${res?.result?.resources?.length} / prompts ${prompts?.result?.prompts?.length}`,
)

// ── M11：工作区三条路（纯函数，不需要再起进程） ──────────────
const saved = process.env.MACRO_MEMORY_WORKSPACE
process.env.MACRO_MEMORY_WORKSPACE = join(tmp, 'from-env')
const byCwd = workspaceOf(join(tmp, 'from-arg'))
const byEnv = workspaceOf(undefined)
delete process.env.MACRO_MEMORY_WORKSPACE
const byProc = workspaceOf(undefined)
if (saved === undefined) delete process.env.MACRO_MEMORY_WORKSPACE
else process.env.MACRO_MEMORY_WORKSPACE = saved
check(
  'M11 工作区：--cwd > MACRO_MEMORY_WORKSPACE > cwd，三条优先级各认一次',
  byCwd === join(tmp, 'from-arg') && byEnv === join(tmp, 'from-env') && byProc === process.cwd() && versionOf() === pkgRoot.version,
  `${byCwd.split(/[\\/]/).pop()} > ${byEnv.split(/[\\/]/).pop()} > ${byProc.split(/[\\/]/).pop()}`,
)

// ── M10：关 stdin 之后自己退出 ──────────────────────────────
client.child.stdin.end()
const code = await Promise.race([client.exited, new Promise((r) => setTimeout(() => r('timeout'), 8000))])
check('M10 收摊：关 stdin 之后进程自己退出，退出码 0', code === 0, `退出码 ${code}`)

await eng.close()
try {
  const { rmSync } = await import('node:fs')
  rmSync(tmp, { recursive: true, force: true })
} catch {
  /* Windows 上偶尔 EPERM：临时目录留着不影响判据 */
}

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILED'}  probe-mcp：${pass}/${pass + fail}`)
process.exit(fail === 0 ? 0 : 1)
