/**
 * 验收：core 层（不依赖 DSH 的那半）真的能独立跑，并且与 DSH 侧共用同一份库。
 *
 * 这一支检的是「0.8.0 全 agent 适配」的地基，全部在临时目录里做，不碰真实库：
 *   C0 五个文件在位（engine / paths / trust / mini-host / config）
 *   C1 装配就绪：ready.meow && ready.nebula，融合层收下 17 个子工具
 *   C2 闭环：remember 写入 → search 命中 → read 读回原文
 *   C3 库位置：workspace 库落在 <ws>/.dsh-meow/memory.db（与 DSH 同一位置），dataDir 里没有库
 *   C4 信任门：陌生库（目录里有别人的文件）auto 策略拒绝写；trust 之后能写
 *   C5 注入：L0 ≤ 1,300 字符，且含 memory_remember（模型要知道有这工具）
 *   C6 MCP：initialize 回协议版本、tools/list 8 个、未知方法 -32601、坏 JSON -32700
 *   C7 CLI：--help 退出 0 且列出 mcp 子命令
 *   C8 平台：dataDir 三分支（Windows / macOS / Linux）与 MACRO_MEMORY_HOME 覆盖各自正确
 *   C9 关闭：close 之后引擎不再工作（不留后台句柄）
 *   C10 全局库同源：装了 DSH 就落 <DSH_HOME>/storages/meow-memory，没装退 ~/.dsh-meow
 *   C11 裸包：把运行面复制到一个没有 node_modules 的目录，仍能装配（vendor 自足 + compat 层）
 *   C12 npx 口径：文档里的命令必须能真的被执行（包名 ≠ bin 名这坑只踩一次）
 *
 * 用法：node tools/probe-core.mjs
 */
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
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

const tmp = mkdtempSync(join(tmpdir(), 'macro-core-'))
const wsA = join(tmp, 'ws-a')
const wsB = join(tmp, 'ws-b')
const home = join(tmp, 'home')
const dataDir = join(tmp, 'data')
for (const d of [wsA, wsB, home, dataDir]) mkdirSync(d, { recursive: true })

/**
 * 关键隔离：meow 的 `switchHomeDir()` 在全局目录被换成另一个空目录时，会把旧库
 * copy/rename 过去，并**把指针文件写进 `<DSH_HOME>/storages/meow-memory-home.json`**。
 * 本支为了测「全局库与 workspace 库分离」必须换一个临时 home——不隔离 DSH_HOME 的话，
 * 跑一次自检就把宿主真实的全局库指针改到临时目录（temp 一删，宿主就找不到库了）。
 * 所以在本进程内把 DSH_HOME 指到临时目录：指针落在那儿，随 temp 一起消失。
 */
process.env.DSH_HOME = join(tmp, 'dsh-home')
// 再把「当前全局目录」指到本支的临时 home：`switchHomeDir()` 在目标 ≠ 当前目录时
// 会从旧目录复制一份过来（并在 stderr 留一条 warn）。指针一写，两边一致，迁移不发生，
// 探针输出就干净了——顺手也证明「指针文件就是唯一真相」。
mkdirSync(join(process.env.DSH_HOME, 'storages'), { recursive: true })
writeFileSync(
  join(process.env.DSH_HOME, 'storages', 'meow-memory-home.json'),
  JSON.stringify({ homeDir: home }),
)

// ── C0 文件在位 ────────────────────────────────────────────────
const files = [
  'lib/core/engine.js',
  'lib/core/paths.js',
  'lib/core/trust.js',
  'lib/core/mini-host.js',
  'lib/core/config.js',
  'lib/mcp/server.js',
  'bin/macro-memory.mjs',
]
const missing = files.filter((f) => !existsSync(join(root, f)))
check('C0 core 七个文件在位（engine/paths/trust/mini-host/config/mcp/cli）', missing.length === 0, missing.join(',') || '全在')

/** C8 平台：纯函数，先测（与装配无关） */
{
  const { defaultDataDir } = await mod('lib/core/paths.js')
  const win = defaultDataDir({ platform: 'win32', env: { APPDATA: 'C:\\Users\\u\\AppData\\Roaming' }, home: 'C:\\Users\\u' })
  const mac = defaultDataDir({ platform: 'darwin', env: {}, home: '/Users/u' })
  const linux = defaultDataDir({ platform: 'linux', env: {}, home: '/home/u' })
  const override = defaultDataDir({ platform: 'linux', env: { MACRO_MEMORY_HOME: '/opt/mm' }, home: '/home/u' })
  const ok = win.replace(/\\/g, '/').endsWith('AppData/Roaming/macro-memory') &&
    mac === '/Users/u/Library/Application Support/macro-memory' &&
    linux === '/home/u/.local/share/macro-memory' &&
    override === '/opt/mm'
  check('C8 dataDir 三分支 + MACRO_MEMORY_HOME 覆盖（Windows 用 %APPDATA%）', ok, `${win} | ${mac} | ${linux}`)
}

/**
 * C10 全局库同源：装了 DSH 的机器上，core 的缺省全局库必须落在
 * `<DSH_HOME>/storages/meow-memory`（DSH 侧 meow 用的就是这份），而不是 `~/.dsh-meow`——
 * 两个都叫「全局库」但内容不同，「一份真身」在全局层就断了。
 */
{
  const { detectHomeDir } = await mod('lib/core/paths.js')
  const withStorage = detectHomeDir({
    platform: 'win32',
    env: { DSH_HOME: 'C:\\dsh' },
    home: 'C:\\Users\\u',
    exists: (p) => p.replace(/\\/g, '/').toLowerCase().includes('storages/meow-memory'),
  })
  const onlyLegacy = detectHomeDir({
    platform: 'win32',
    env: { DSH_HOME: 'C:\\dsh' },
    home: 'C:\\Users\\u',
    exists: (p) => p.replace(/\\/g, '/').toLowerCase().endsWith('.dsh-meow'),
  })
  const neither = detectHomeDir({
    platform: 'win32',
    env: { DSH_HOME: 'C:\\dsh' },
    home: 'C:\\Users\\u',
    exists: () => false,
  })
  check('C10 有 DSH storages 时全局库与 DSH 同源', withStorage.replace(/\\/g, '/').toLowerCase() === 'c:/dsh/storages/meow-memory', withStorage)
  check('C10 没有 DSH storages 时退 meow 的 ~/.dsh-meow', onlyLegacy.replace(/\\/g, '/').toLowerCase() === 'c:/users/u/.dsh-meow', onlyLegacy)
  check('C10 两个都没建时优先 DSH 位置（装 DSH 是主流路径）', neither.replace(/\\/g, '/').toLowerCase() === 'c:/dsh/storages/meow-memory', neither)
}

// ── 装引擎（服务都挂上） ─────────────────────────────────────
const { createMacroEngine } = await mod('lib/core/engine.js')
const eng = await createMacroEngine({ dataDir, homeDir: home, projectDir: '.dsh-meow', meow: { autoMigrate: false } })

check('C1 装配就绪：meow 与 nebula 两边都挂上', eng.ready.meow === true && eng.ready.nebula === true, JSON.stringify(eng.ready))
check('C1 融合层收下 17 个子工具（nebula 9 + meow 8）', eng.stats().captured === 17, String(eng.stats().captured))
check('C1 对外只有 8 个 memory_* 工具', eng.tools.length === 8 && eng.tools.every((t) => t.name.startsWith('memory_')), eng.tools.map((t) => t.name).join(','))

const exec = { cwd: wsA, agentId: 'probe', sessionId: 'probe-1' }

// ── C2 闭环 ─────────────────────────────────────────────────
const wrote = await eng.call('memory_remember', {
  content: '探针：预发库只读，改数据走主库（core 闭环用）',
  project: '探针',
  keywords: ['预发', '只读', '主库', '探针'],
  importance: 2,
  level: 'fact',
}, exec)
const id = /id=([0-9a-z]+)/.exec(wrote.text)?.[1] ?? ''
check('C2 remember 写入成功并回 id', wrote.refused !== true && id.length > 0, id || wrote.text.slice(0, 60))

const found = await eng.call('memory_search', { query: '预发库 只读', budget: 300 }, exec)
check('C2 search 能命中刚写的那条', found.text.includes('预发库只读') && found.text.includes(id), id)

const read = await eng.call('memory_read', { id, neighbors: 0 }, exec)
check('C2 read 读回原文（一字不改）', read.text.includes('预发库只读，改数据走主库'), read.text.split('\n')[0])

// ── C3 库位置：与 DSH 同位置，dataDir 只放派生物 ───────────────
const wsDb = join(wsA, '.dsh-meow', 'memory.db')
const inDataDir = readdirSync(dataDir).filter((f) => f.endsWith('.db') || f === 'db')
check('C3 workspace 库落在 <ws>/.dsh-meow/memory.db（与 DSH 同一文件）', existsSync(wsDb), wsDb)
check('C3 dataDir 里没有记忆库（只放配置/派生物）', inDataDir.length === 0, inDataDir.join(',') || '空')

// ── C4 信任门 ────────────────────────────────────────────────
// 造一个「看起来像从别处搬来的」库目录：里面有不是本插件产生的文件
mkdirSync(join(wsB, '.dsh-meow'), { recursive: true })
writeFileSync(join(wsB, '.dsh-meow', 'notes.txt'), 'not mine\n')
const guardB = eng.trustState(wsB)
const refused = await eng.call('memory_remember', {
  content: '探针：这条不该被写进陌生库',
  project: '探针',
  keywords: ['探针', '信任门'],
  importance: 1,
}, { cwd: wsB })
check('C4 陌生库 auto 策略拒绝写（refused，且不抛异常）', refused.refused === true && guardB.trusted === false, `${guardB.reason} / ${refused.refused}`)
check('C4 拒绝话术说清目录 + 给一条能粘的命令', refused.text.includes('trust') && refused.text.includes(wsB), refused.text.split('\n')[0])
const trustedB = eng.trust(wsB)
const wroteB = await eng.call('memory_remember', {
  content: '探针：信任之后这条能写进来',
  project: '探针',
  keywords: ['探针', '信任后'],
  importance: 1,
}, { cwd: wsB })
check('C4 trust 之后同一个库能写（不需要重启引擎）', trustedB.trusted === true && wroteB.refused !== true, String(wroteB.refused))

// ── C5 注入 ─────────────────────────────────────────────────
const inj = eng.injection()
check('C5 L0 注入 ≤1,300 字符', inj.length <= 1300, `${inj.length} 字符`)
check('C5 L0 里点了 memory_remember 的名字（模型得知道有这工具）', inj.includes('memory_remember'), '')

// ── C7 CLI（独立进程，与引擎无关） ────────────────────────────
{
  let out = ''
  let code = 0
  try {
    out = execFileSync(process.execPath, [join(root, 'bin', 'macro-memory.mjs'), '--help'], {
      encoding: 'utf8',
      env: { ...process.env, MACRO_MEMORY_HOME: dataDir },
    })
  } catch (err) {
    code = err.status ?? 1
    out = String(err.stdout ?? '')
  }
  check('C7 CLI --help 退出 0 且列出 mcp 子命令', code === 0 && out.includes('mcp') && out.includes('所有 agent'), `exit=${code}`)
}

/**
 * C12 npx 口径（0.8.0 翻车的那一刀）：npm 包叫 `dsh-macro-memory`，bin 叫 `macro-memory`，
 * 名字不一样 → `npx -y macro-memory …` 会被 npx 当成「去找一个叫 macro-memory 的包」，
 * npm 上根本没有，报 `'macro-memory' is not recognized`。命令只许两种写法：
 *   ① npx -y -p dsh-macro-memory macro-memory …（显式指定包，最稳）
 *   ② npx -y dsh-macro-memory …（package.json 里给 bin 加了同名别名才成立）
 */
{
  const docs = ['README.md', 'docs/CHANGELOG.md', 'bin/macro-memory.mjs', 'lib/core/engine.js']
  // md 只扫 ``` 代码块里的行：正文里出现 `npx -y macro-memory …` 是在讲反面例子，
  // 那不是「照抄会翻车」的命令，判红就变成了抓叙述。
  const commandLines = (f, text) => {
    const lines = text.split('\n')
    if (!f.endsWith('.md')) return lines.map((l, i) => [i + 1, l])
    const out = []
    let fence = false
    for (let i = 0; i < lines.length; i++) {
      if (/^\s*```/.test(lines[i])) { fence = !fence; continue }
      if (fence) out.push([i + 1, lines[i]])
    }
    return out
  }
  const bad = []
  for (const f of docs) {
    const text = readFileSync(join(root, f), 'utf8')
    for (const [no, line] of commandLines(f, text)) {
      if (line.includes('npx -y macro-memory') || line.includes('npx -y -p macro-memory')) {
        bad.push(`${f}:${no}: ${line.trim().slice(0, 90)}`)
      }
    }
  }
  check('C12 命令里没有「npx -y macro-memory」这种 npx 找不到包的写法（代码块与 CLI 输出为准）', bad.length === 0, bad[0] ?? '写法统一为 -p dsh-macro-memory macro-memory')

  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  const bins = Object.keys(pkg.bin ?? {})
  check('C12 package.json 的 bin 里带包名本身（npx -y <包名> 才找得到命令）', bins.includes(pkg.name), bins.join(', '))
}

/**
 * C11 裸包（0.8.1）：包的运行面里不能出现「装 DSH 才有」的裸依赖。
 * 0.8.0 的 meow 顶部 `import '@deepseek-ai/dsh-llm'`，干净机器上直接 ERR_MODULE_NOT_FOUND——
 * 这条把运行面复制到没有 node_modules 的目录里跑一遍 doctor，把这个洞焊死。
 */
{
  const bare = join(tmp, 'bare')
  // 把全局库与指针都圈进临时目录：否则 meow 的 autoMigrate 会把宿主真实的
  // `~/.dsh-meow` 复制进来（只是多读一次 + 一条 warn，但探针不该有这种噪音）。
  const dshHome = join(tmp, 'dsh-home-bare')
  const bareHome = join(dshHome, 'storages', 'meow-memory')
  mkdirSync(bareHome, { recursive: true })
  writeFileSync(join(dshHome, 'storages', 'meow-memory-home.json'), JSON.stringify({ homeDir: bareHome }))
  for (const d of ['bin', 'lib', 'vendor']) {
    cpSync(join(root, d), join(bare, d), {
      recursive: true,
      filter: (src) => !src.split(/[\\/]/).includes('node_modules'),
    })
  }
  cpSync(join(root, 'package.json'), join(bare, 'package.json'))
  let out = ''
  let code = 0
  try {
    out = execFileSync(process.execPath, [join(bare, 'bin', 'macro-memory.mjs'), 'doctor', '--no-nebula'], {
      encoding: 'utf8',
      cwd: bare,
      env: {
        ...process.env,
        DSH_HOME: dshHome,
        MACRO_MEMORY_HOME: join(tmp, 'bare-home'),
        MACRO_MEMORY_WORKSPACE: join(tmp, 'bare-ws'),
      },
    })
  } catch (err) {
    code = err.status ?? 1
    out = String(err.stdout ?? '')
  }
  const engineLine = out.split('\n').find((l) => l.includes('引擎')) || ''
  check(
    'C11 裸包（没有 node_modules）仍能装配：引擎就绪 + 8 工具 + L0 注入',
    !existsSync(join(bare, 'node_modules')) && out.includes('meow=就绪') && out.includes('memory_remember'),
    `exit=${code} ${engineLine.trim()}`,
  )
  check(
    'C11 宿主包不再靠天吃饭：vendor 自带 schemastery/cosmokit + compat 层替 dsh-llm',
    existsSync(join(bare, 'vendor', 'schemastery', 'lib', 'index.mjs')) &&
      existsSync(join(bare, 'vendor', 'cosmokit', 'lib', 'index.js')) &&
      existsSync(join(bare, 'lib', 'core', 'compat', 'dsh-llm.js')),
    '',
  )
}

// ── C6 MCP（最后跑：serveStdio 结束会关引擎） ──────────────────
{
  const { serveStdio } = await mod('lib/mcp/server.js')
  const input = new PassThrough()
  const output = new PassThrough()
  let buf = ''
  output.on('data', (d) => {
    buf += d.toString('utf8')
  })
  const done = serveStdio({ engine: eng, version: 'probe', name: 'macro-memory', input, output, log: () => {} })
  const send = (obj) => input.write(`${JSON.stringify(obj)}\n`)
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'probe', version: '0' } } })
  send({ jsonrpc: '2.0', method: 'notifications/initialized' })
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
  send({ jsonrpc: '2.0', id: 3, method: 'nope' })
  input.write('{ 这不是 JSON\n')
  await new Promise((r) => setTimeout(r, 600))
  input.end()
  await done
  const lines = buf.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
  const byId = new Map(lines.map((m) => [m.id, m]))
  const init = byId.get(1)
  const list = byId.get(2)
  const tools = list?.result?.tools ?? []
  check('C6 initialize 回协议版本与 serverInfo', init?.result?.protocolVersion === '2025-06-18' && init?.result?.serverInfo?.name === 'macro-memory', init?.result?.protocolVersion)
  check('C6 tools/list 列出 8 个工具且每个都有 inputSchema', tools.length === 8 && tools.every((t) => t.inputSchema && t.inputSchema.type === 'object'), String(tools.length))
  check('C6 未知方法回 -32601', byId.get(3)?.error?.code === -32601, String(byId.get(3)?.error?.code))
  check('C6 坏 JSON 回 -32700（连接不断）', lines.some((m) => m.error?.code === -32700), '')
}

// ── C9 关闭 ─────────────────────────────────────────────────
// 判据不是「必须抛异常」：关掉之后工具可能抛、也可能回一句「尚未就绪」，
// 两者都算健康——真正要防的是**静默成功**（关了还在读写，说明有句柄没释放）。
let closed = false
let afterText = ''
try {
  const r = await eng.call('memory_search', { query: '关闭后', budget: 100 }, exec)
  afterText = r?.text ?? ''
} catch (err) {
  closed = true
  afterText = String(err?.message ?? err)
}
const healthy = closed || /尚未就绪|已关闭|已停|不可用/.test(afterText)
check('C9 close 之后不再静默成功（抛错或明说不可用）', healthy, closed ? '抛错' : afterText.slice(0, 60))

await eng.close().catch(() => {})
try {
  rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
} catch {
  /* Windows 上库句柄偶尔还没松手，临时目录留着不判红（系统 temp 会自己清） */
}

console.log('')
console.log(`${pass} PASS / ${fail} FAIL`)
if (fail > 0) process.exitCode = 1
