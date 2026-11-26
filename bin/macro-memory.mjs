#!/usr/bin/env node
/**
 * macro-memory CLI —— 没有 DSH 时的全部入口。
 *
 *   macro-memory mcp                 起 MCP stdio 服务器（Codex / Claude / Cursor 接这个）
 *   macro-memory init                写配置，并打印各宿主的接线片段
 *   macro-memory trust [dir]         信任一个工作区的记忆库（等价 DSH 的 /meow-trust）
 *   macro-memory remember "…"        写一条记忆
 *   macro-memory search "…"          检索
 *   macro-memory read <id>           读一条
 *   macro-memory project <名字>      项目全景
 *   macro-memory injection           看常驻注入文本（L0）
 *   macro-memory doctor              自检：引擎、库、信任、路径
 *   macro-memory stats               库规模与工具清单
 *
 * 设计约束：只依赖 node 内置；不写任何全局状态；每条命令结束都关库、退出码明确
 * （0 成功 / 1 用法错 / 2 运行错），方便脚本判断。
 */

import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PKG_ROOT = path.resolve(HERE, '..')

/** 自报版本：直接读 package.json，避免两处版本号打架。 */
function readVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(PKG_ROOT, 'package.json'), 'utf8'))
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0'
  } catch {
    return '0.0.0'
  }
}

const HELP = `macro-memory —— 一套记忆，所有 agent

用法：
  macro-memory <命令> [参数]

命令：
  mcp                 起 MCP stdio 服务器（给 Codex / Claude Code / Cursor 用）
  init                写配置到数据目录，并打印各宿主的接线片段
  trust [目录]        信任一个工作区的记忆库（等价 DSH 里的 /meow-trust）
  remember <内容>     写一条记忆
  search <查询>       检索记忆
  read <id>           读一条记忆
  project <项目名>    看一个项目的全景
  injection           打印常驻注入文本（L0，会被塞进系统提示的那段）
  refresh             刷新 AGENTS.md 里的 L0（升级后跑一次即可）
  uninstall           摘掉 AGENTS.md 里的 L0，原有内容逐字节还原
  migrate             把库的 schema 版本抬到本适配层认识的版本（先出一致副本）
  serve               起单写者服务（多 agent 共用一个库时，写只走它一条队列）
  attach              加入共享：登记自己 + 把待补交的写交上去
  detach              退出共享：删发现文件，回到直连（服务本身不动）
  share               看共享状态：谁是写者、队列多长、服务在不在
  ui                  开管理界面（只听 127.0.0.1，一次性令牌放 URL，关掉就消失）
  doctor              自检：引擎就绪、库位置、信任状态、路径
  stats               库规模与工具清单

通用参数：
  --cwd <目录>        按哪个工作区算（默认当前目录）
  --data-dir <目录>   配置/日志放哪（默认按平台）
  --project-dir <名>  工作区内的库目录名（默认 .dsh-meow，与 DSH 共用）
  --home-dir <目录>   全局库目录（默认跟随 meow：装了 DSH 就是 DSH 的 storages）
  --json              机器可读输出
  --no-nebula         不挂星图引擎（更快、更省内存）
  --file <路径>       改哪个文件（默认 AGENTS.md；可给多次或逗号分隔）
  --port <端口>       serve 监听端口（默认 0 = 系统挑一个，写进 serve.json）
  --agent <名字>      attach 时自报的名字（同一份库靠它区分谁写的）
  -h, --help          看这个

例子：
  npx -y macro-memory mcp
  npx -y macro-memory init
  npx -y macro-memory remember "预发库只读，改数据走主库" --project 运维 --keywords 预发,只读
  npx -y macro-memory search "预发库"
`
/** 极简参数解析：只认 `--k v` / `--k=v` / `--flag`，其余进位置参数。 */
function parseArgv(argv) {
  const out = { _: [] }
  // 可以出现多次、每次各算一个值的键（--file AGENTS.md --file CLAUDE.md）
  const multi = new Set(['file'])
  const put = (k, v) => {
    if (multi.has(k)) (out[k] ??= []).push(v)
    else out[k] = v
  }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--') {
      out._.push(...argv.slice(i + 1))
      break
    }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=')
      if (eq > 0) {
        put(a.slice(2, eq), a.slice(eq + 1))
        continue
      }
      const key = a.slice(2)
      const next = argv[i + 1]
      if (next !== undefined && !next.startsWith('-')) {
        put(key, next)
        i += 1
      } else {
        put(key, true)
      }
      continue
    }
    if (a === '-h') {
      out.help = true
      continue
    }
    out._.push(a)
  }
  return out
}

function engineOptions(args) {
  const opts = {}
  if (typeof args['data-dir'] === 'string') opts.dataDir = args['data-dir']
  if (typeof args['project-dir'] === 'string') opts.projectDir = args['project-dir']
  if (typeof args['home-dir'] === 'string') opts.homeDir = args['home-dir']
  if (args['no-nebula'] === true) opts.withNebula = false
  if (args.verbose === true) opts.verbose = true
  return opts
}

function cwdOf(args) {
  // MCP 客户端启动子进程时，cwd 常常是宿主自己的目录（不一定是项目目录），
  // 所以除了 --cwd，还认一个环境变量：配置里写死一行 env，比让宿主改 cwd 现实。
  const raw = typeof args.cwd === 'string'
    ? args.cwd
    : (typeof process.env.MACRO_MEMORY_WORKSPACE === 'string' && process.env.MACRO_MEMORY_WORKSPACE.trim().length > 0
      ? process.env.MACRO_MEMORY_WORKSPACE.trim()
      : process.cwd())
  return path.resolve(raw)
}

function out(text) {
  process.stdout.write(text.endsWith('\n') ? text : `${text}\n`)
}

async function loadEngine(args) {
  const { createMacroEngine } = await import('../lib/core/engine.js')
  return createMacroEngine(engineOptions(args))
}

/** 把一段文本按终端宽度折行（中文按 2 列算），CLI 的正文不留超长行。 */
function wrap(text, width = 100) {
  const lines = []
  for (const para of String(text).split('\n')) {
    if (para.length === 0) {
      lines.push('')
      continue
    }
    let cur = ''
    let w = 0
    for (const ch of para) {
      const cw = /[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/.test(ch) ? 2 : 1
      if (w + cw > width) {
        lines.push(cur)
        cur = ''
        w = 0
      }
      cur += ch
      w += cw
    }
    if (cur.length > 0) lines.push(cur)
  }
  return lines.join('\n')
}

async function cmdMcp(args) {
  const { serveStdio } = await import('../lib/mcp/server.js')
  const eng = await loadEngine(args)
  if (!eng.ready.meow) {
    process.stderr.write('macro-memory：记忆引擎没装配起来，先跑 `macro-memory doctor` 看原因。\n')
    await eng.close()
    process.exit(2)
  }
  await serveStdio({
    engine: eng,
    version: readVersion(),
    name: 'macro-memory',
    log: (m) => process.stderr.write(`${m}\n`),
  })
}

async function cmdInit(args) {
  const { loadConfig, writeConfigFile, defaultConfig } = await import('../lib/core/config.js')
  const opts = engineOptions(args)
  const loaded = loadConfig({ dir: opts.dataDir })
  const current = loaded.config
  const next = {
    ...current,
    ...(opts.projectDir !== undefined ? { projectDir: opts.projectDir } : {}),
    ...(opts.homeDir !== undefined ? { homeDir: opts.homeDir } : {}),
    agent: {
      id: typeof args.agent === 'string' ? args.agent : current.agent?.id ?? '',
      label: typeof args.label === 'string' ? args.label : current.agent?.label ?? '',
    },
  }
  const file = writeConfigFile({ dir: opts.dataDir }, next)
  const cwd = cwdOf(args)
  const serverCmd = 'npx -y macro-memory mcp'
  out(`配置文件：${file}`)
  out(`工作区：  ${cwd}`)
  out(`库目录：  ${path.join(cwd, next.projectDir ?? '.dsh-meow')}（与 DSH 共用同一份）`)
  out('')
  out('把下面这段加到宿主的 MCP 配置里即可（Codex 用 ~/.codex/config.toml 的 [mcp_servers]，')
  out('Claude Code 用 `claude mcp add`，Cursor 用 Settings → MCP）：')
  out('')
  out('  {')
  out('    "mcpServers": {')
  out('      "macro-memory": {')
  out(`        "command": "${serverCmd.split(' ')[0]}",`)
  out(`        "args": ${JSON.stringify(serverCmd.split(' ').slice(1))}`)
  out('      }')
  out('    }')
  out('  }')
  out('')
  out('接上之后，agent 会看到 8 个 memory_* 工具；第一次在某个工作区写入前若提示未信任，')
  out(`跑一次：macro-memory trust "${cwd}"`)
  // 顺手把默认配置写全，免得下次 loadConfig 又是一份 patch
  if (!loaded.exists) writeConfigFile({ dir: opts.dataDir }, defaultConfig(next))
  // --agents（或给了 --file）时顺手把 L0 写进 AGENTS.md：MCP 之外的第二条路，
  // 宿主没装 MCP、只读项目文件也能看见这套工具。
  if (args.agents === true || typeof args.file !== 'undefined') {
    await writeAgentsFiles(args, 'init')
  }
}

/**
 * init --agents / refresh 共用：装配引擎取 L0，写进目标文件。
 *
 * 先对所有目标做一次只读预检再动手——多目标时不能「前两个改了、第三个坏块报错」，
 * 那种半成品最难收拾。
 */
async function writeAgentsFiles(args, mode) {
  const { resolveTargets, inspectBlock, applyBlock } = await import('../lib/core/agents-file.js')
  const cwd = cwdOf(args)
  const targets = resolveTargets(cwd, { files: args.file })
  const broken = targets.map((p) => inspectBlock(p)).filter((r) => r.broken)
  if (broken.length > 0) {
    for (const r of broken) out(`坏块：${r.path}（有 begin 没有 end，多半被手改坏）— 先修好或删掉那半块，这次一个文件都没动`)
    process.exit(2)
  }
  const eng = await loadEngine(args)
  const l0 = eng.injection()
  await eng.close()
  if (typeof l0 !== 'string' || l0.trim().length === 0) {
    out('注入文本是空的：引擎大概没装配起来。先跑 `macro-memory doctor` 看原因。')
    process.exit(2)
  }
  const rows = targets.map((p) => applyBlock(p, l0))
  out(mode === 'refresh' ? '刷新常驻注入（L0）：' : '写入常驻注入（L0）：')
  for (const r of rows) {
    const action = r.action === 'created' ? '新建' : r.action === 'appended' ? '追加到文件末尾' : '原地刷新'
    out(`  ${r.path}  ${action}，${r.chars} 字符 / 文件 ${r.bytes} 字节`)
  }
  out('')
  out('这套工具每轮都会读到这里；更新用 `macro-memory refresh`，摘掉用 `macro-memory uninstall`。')
}

async function cmdRefresh(args) {
  await writeAgentsFiles(args, 'refresh')
}

/**
 * `macro-memory migrate`：显式把库的 schema 版本抬到适配层认识的版本。
 * 默认 dry-run 之外的行为都写进回执——这一步会往用户库里写一个数字，必须说清楚。
 */
async function cmdMigrate(args) {
  const eng = await loadEngine(args)
  const cwd = cwdOf(args)
  const res = eng.migrateSchema(cwd, {
    dryRun: args['dry-run'] === true,
    ...(args.to !== undefined ? { to: Number(args.to) } : {}),
  })
  await eng.close()
  if (args.json === true) {
    out(JSON.stringify(res, null, 2))
    process.exit(res.ok ? 0 : 1)
  }
  if (res.reason === 'no-db') {
    out(`这个工作区还没有库：${path.join(cwd, '.dsh-meow', 'memory.db')}（首次写入时会创建，不需要迁移）`)
    process.exit(0)
  }
  if (res.reason === 'already') {
    out(`库已经是 v${res.to}，不用迁。`)
    process.exit(0)
  }
  if (res.reason === 'db-newer') {
    out(`库是 v${res.from}，比适配层认识的 v${res.to} 新——不降级。升级 macro-memory 才是正路。`)
    process.exit(1)
  }
  if (res.reason === 'unreadable') {
    out('读不出库版本（PRAGMA user_version 没反应），先确认这个库没坏。')
    process.exit(1)
  }
  if (res.reason === 'would-stamp') {
    out(`会从 v${res.from} 抬到 v${res.to}（dry-run，没动库）。去掉 --dry-run 才真写。`)
    process.exit(0)
  }
  out(`已迁移：v${res.from} → v${res.to}`)
  out(`迁移前的一致副本：${res.backup}`)
  out('v0 → v1 表结构与 meow 建出来的完全一样，这一步只是记账；将来加列/加表的 DDL 都挂在这里。')
}

async function cmdUninstall(args) {
  const { resolveTargets, removeBlock } = await import('../lib/core/agents-file.js')
  const cwd = cwdOf(args)
  const targets = resolveTargets(cwd, { files: args.file })
  const quiet = args.json === true
  const rows = targets.map((p) => ({ ...removeBlock(p), path: p }))
  if (quiet) {
    out(JSON.stringify({ cwd, rows }, null, 2))
  } else {
    for (const r of rows) {
      if (r.status === 'removed') {
        out(`已摘除：${r.path}${r.deleted ? '（摘完只剩空白，文件一并删掉）' : '（原有内容逐字节还原）'}`)
      } else if (r.status === 'skipped') {
        out(`坏块没动：${r.path}（有 begin 没有 end，先手工修好）`)
      } else {
        out(`没有块：${r.path}（跳过）`)
      }
    }
    if (rows.some((r) => r.status === 'removed')) {
      out('')
      out('记忆库原样保留（摘注入不等于删数据）：工作区库在 <工作区>/.dsh-meow，全局库在 meow 的 storages。')
    }
  }
  process.exit(rows.some((r) => r.status === 'skipped') ? 1 : 0)
}

async function cmdTrust(args) {
  const eng = await loadEngine(args)
  const target = typeof args._[0] === 'string' ? args._[0] : cwdOf(args)
  const res = eng.trust(target)
  out(res.trusted ? `已信任：${res.workspace}` : `写入信任表失败：${res.workspace}（检查 ${res.homeDir} 的权限）`)
  await eng.close()
  process.exit(res.trusted ? 0 : 2)
}

async function cmdRemember(args) {
  const content = args._.join(' ').trim()
  if (content.length === 0) {
    out('用法：macro-memory remember "<内容>" [--project 名字] [--level fact] [--importance 2] [--keywords a,b,c]')
    process.exit(1)
  }
  const eng = await loadEngine(args)
  const keywords = typeof args.keywords === 'string'
    ? args.keywords.split(',').map((s) => s.trim()).filter(Boolean)
    : []
  const payload = {
    content,
    level: typeof args.level === 'string' ? args.level : 'fact',
    importance: args.importance !== undefined ? Number(args.importance) : 2,
    project: typeof args.project === 'string' ? args.project : undefined,
    keywords,
  }
  const res = await eng.call('memory_remember', payload, { cwd: cwdOf(args), agentId: 'cli' })
  out(args.json === true ? JSON.stringify(res) : res.text)
  await eng.close()
  process.exit(res.refused === true ? 2 : 0)
}

async function cmdSearch(args) {
  const query = args._.join(' ').trim()
  if (query.length === 0) {
    out('用法：macro-memory search "<查询>" [--budget 800]')
    process.exit(1)
  }
  const eng = await loadEngine(args)
  const res = await eng.call('memory_search', {
    query,
    budget: args.budget !== undefined ? Number(args.budget) : undefined,
    k: args.k !== undefined ? Number(args.k) : undefined,
  }, { cwd: cwdOf(args), agentId: 'cli' })
  out(args.json === true ? JSON.stringify(res) : wrap(res.text))
  await eng.close()
}

async function cmdRead(args) {
  const id = typeof args._[0] === 'string' ? args._[0] : ''
  if (id.length === 0) {
    out('用法：macro-memory read <id> [--neighbors 6] [--budget 800]')
    process.exit(1)
  }
  const eng = await loadEngine(args)
  const res = await eng.call('memory_read', {
    id,
    neighbors: args.neighbors !== undefined ? Number(args.neighbors) : undefined,
    budget: args.budget !== undefined ? Number(args.budget) : undefined,
  }, { cwd: cwdOf(args), agentId: 'cli' })
  out(args.json === true ? JSON.stringify(res) : wrap(res.text))
  await eng.close()
}

async function cmdProject(args) {
  const project = args._.join(' ').trim()
  if (project.length === 0) {
    out('用法：macro-memory project <项目名>')
    process.exit(1)
  }
  const eng = await loadEngine(args)
  const res = await eng.call('memory_project', { project }, { cwd: cwdOf(args), agentId: 'cli' })
  out(args.json === true ? JSON.stringify(res) : wrap(res.text))
  await eng.close()
}

async function cmdInjection(args) {
  const eng = await loadEngine(args)
  const text = eng.injection()
  out(args.json === true ? JSON.stringify({ chars: text.length, text }) : text)
  await eng.close()
}

async function cmdDoctor(args) {
  const eng = await loadEngine(args)
  const cwd = cwdOf(args)
  const trust = eng.trustState(cwd)
  const stats = eng.stats()
  const lines = []
  lines.push('macro-memory doctor')
  lines.push(`  版本：      ${readVersion()}`)
  lines.push(`  数据目录：  ${eng.dataDir}`)
  lines.push(`  工作区：    ${cwd}`)
  lines.push(`  库目录：    ${trust.dir}${fs.existsSync(trust.dir) ? '' : '（还不存在，首次写入时创建）'}`)
  lines.push(`  全局库：    ${trust.homeDir}`)
  const schema = eng.schemaState(cwd)
  lines.push(`  库版本：    适配层 v${schema.adapterVersion} / 库 ${schema.dbVersion === null ? '还没有库' : `v${schema.dbVersion}`}${schema.readOnly ? '（比适配层新：只读）' : ''}`)
  const share = await eng.shareState()
  lines.push(`  共享：      ${share.mode} —— ${share.mode === 'standalone' ? '直连本地库（没装服务，功能一条不少）' : share.mode === 'shared' ? `写交给 pid ${share.info?.pid}（${share.info?.url ?? ''}），已服务 ${share.stats?.calls ?? 0} 次` : `serve.json 还在但连不上：${share.reason}`}${share.pending > 0 ? `，待补交 ${share.pending} 条` : ''}`)
  lines.push(`  信任：      ${trust.trusted ? '已信任' : `未信任（跑 macro-memory trust "${cwd}"）`}`)
  lines.push(`  引擎：      meow=${eng.ready.meow ? '就绪' : '未就绪'}  nebula=${eng.ready.nebula ? '就绪' : '未就绪'}`)
  lines.push(`  子工具：    ${stats.captured} 个被融合层收下`)
  lines.push(`  工具面：    ${eng.tools.map((t) => t.name).join('、')}`)
  lines.push(`  注入：      L0 ${eng.injection().length} 字符`)
  lines.push('')
  const problems = []
  if (!eng.ready.meow) problems.push('记忆引擎未就绪：多半是库打不开或迁移失败（跑 --verbose 看细节）')
  if (!eng.ready.nebula) problems.push('星图引擎未就绪：检索仍可用，只是没有关联扩散')
  if (!trust.trusted) problems.push('当前工作区未信任：写入会被拒绝（这是有意的防护）')
  if (schema.readOnly) problems.push(`库 schema v${schema.dbVersion} 比适配层 v${schema.adapterVersion} 新：读写暂停，升级 macro-memory 或显式跑 migrate`)
  if (share.mode === 'readonly') problems.push(`serve.json 还在但服务连不上（${share.reason}）：现在写不进去，${share.pending} 条在排队——起 macro-memory serve 补交，或 macro-memory detach 认输回直连`)
  if (problems.length === 0) {
    lines.push('结果：一切正常。')
  } else {
    lines.push('发现的问题：')
    for (const p of problems) lines.push(`  - ${p}`)
  }
  out(args.json === true
    ? JSON.stringify({ version: readVersion(), dataDir: eng.dataDir, trust, ready: eng.ready, stats, problems }, null, 2)
    : lines.join('\n'))
  await eng.close()
  process.exit(problems.length === 0 ? 0 : 1)
}

async function cmdStats(args) {
  const eng = await loadEngine(args)
  const res = await eng.call('memory_admin', { action: 'stats' }, { cwd: cwdOf(args), agentId: 'cli' })
  out(args.json === true ? JSON.stringify({ engine: eng.stats(), panel: res.text }) : res.text)
  await eng.close()
}

/** 共享层四个命令共用的最小装配：只要 dataDir 与探测，不要全套工具（省内存）。 */
async function shareLite(args) {
  const { resolveDataDir } = await import('../lib/core/paths.js')
  const client = await import('../lib/core/client.js')
  const dataDir = resolveDataDir({ dir: args['data-dir'] })
  return { dataDir, client }
}

/**
 * `serve`：前台常驻的单写者（PLAN 第 6 节）。
 *
 * 三件事只有它干：唯一写连接、唯一跑 dream 的、唯一打快照的。默认前台、默认不装
 * 任何常驻（LaunchAgent / 计划任务得显式 `--install-agent`，这一版还没做，明写在文档里）。
 */
async function cmdServe(args) {
  const { startServe } = await import('../lib/core/serve.js')
  const port = args.port === undefined ? 0 : Number(args.port)
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error('macro-memory serve：--port 要 0–65535 的整数')
    process.exit(1)
  }
  const srv = await startServe({
    dataDir: args['data-dir'],
    projectDir: args['project-dir'],
    homeDir: args['home-dir'],
    cwd: cwdOf(args),
    port,
    verbose: args.verbose === true,
  })
  if (args.json === true) {
    out(JSON.stringify({ url: srv.url, pid: srv.pid, token: srv.token, serveFile: srv.info.file, dataDir: srv.dataDir }))
  } else {
    out([
      '单写者服务起来了（前台运行，Ctrl-C 停）。',
      `  端点：      ${srv.url}`,
      `  pid：       ${srv.pid}`,
      `  令牌：      ${srv.token}`,
      `  发现文件：  ${srv.info.file}`,
      '',
      '从现在起，本机所有走这套 core 的 agent 都会把写交给这条队列（各自不用改配置）。',
      '  · 看状态：  macro-memory share',
      '  · 退出共享：macro-memory detach（服务还活着，只是发现文件被摘掉）',
      '  · 停服务：  Ctrl-C（serve.json 会自己删掉，大家回落直连）',
    ].join('\n'))
  }
  let stopping = false
  const stop = async (sig) => {
    if (stopping) return
    stopping = true
    const r = await srv.close(sig)
    if (args.json === true) out(JSON.stringify({ stopped: true, reason: r.reason, removed: r.removed }))
    else out(`已停（${r.reason}）：serve.json ${r.removed ? '已删掉，回到直连' : '没删（不是本进程写的，或者已经被清过）'}。`)
    process.exit(0)
  }
  process.on('SIGINT', () => void stop('SIGINT'))
  process.on('SIGTERM', () => void stop('SIGTERM'))
  await new Promise(() => {}) // 前台常驻，只等信号
}

/** `attach`：加入共享（登记 + 补交）。服务不在时如实说，并给出两条路。 */
async function cmdAttach(args) {
  const { dataDir, client } = await shareLite(args)
  const info = client.readServeInfo(dataDir)
  const agent = typeof args.agent === 'string' && args.agent.trim().length > 0 ? args.agent.trim() : `cli-${process.pid}`
  if (!info) {
    out([
      '没有服务在跑（standalone）：直连本地库，记 / 查 / 注入 / dream 一条不少。',
      `  发现文件：  ${client.serveFilePath(dataDir)}（不存在）`,
      '',
      '要让多个 agent 共用一个库、写只走一条队列：另开一个终端跑',
      '  macro-memory serve',
    ].join('\n'))
    process.exit(0)
  }
  const found = await client.discover(dataDir)
  if (found.mode !== 'shared') {
    const pending = client.pendingCount(dataDir)
    out([
      `serve.json 在，但服务连不上（${found.reason}）：现在处于只读档。`,
      `  端点：      ${info.url ?? info.socketPath}`,
      `  pid：       ${info.pid}`,
      `  待补交：    ${pending} 条（${path.join(dataDir, client.PENDING_FILE)}）`,
      '',
      '起服务就补交：macro-memory serve',
      '不想用服务：macro-memory detach',
    ].join('\n'))
    process.exit(1)
  }
  const res = await client.request(info, 'POST', '/attach', { agent, cwd: cwdOf(args) })
  const done = await client.flushPending(dataDir, info)
  const st = res.json
  out([
    `已加入共享（mode=shared），自报名字：${st?.agent ?? agent}`,
    `  端点：      ${info.url ?? info.socketPath}`,
    `  写者：      pid ${info.pid}`,
    `  这次补交：  ${done.sent} 条${done.left > 0 ? `，还剩 ${done.left} 条（服务那边还没写进去，下次再试）` : ''}`,
    `  队列：      ${client.pendingCount(dataDir)} 条待补交`,
  ].join('\n'))
  process.exit(0)
}

/** `detach`：删发现文件，回落直连。服务本身不动（它可能还有别的 agent 在用）。 */
async function cmdDetach(args) {
  const { dataDir, client } = await shareLite(args)
  const info = client.readServeInfo(dataDir)
  const pending = client.pendingCount(dataDir)
  const removed = client.removeServeInfo(dataDir)
  const lines = []
  if (!info) {
    lines.push('本来就没在共享（没有 serve.json）：什么都不用做。')
  } else {
    lines.push(`已退出共享：发现文件${removed ? '删掉了' : '删不掉（权限？）'}，之后写库由本进程直连负责。`)
    lines.push(`  被摘掉的写者：pid ${info.pid}（${info.url ?? info.socketPath}）—— 服务本身没被停，别人还能用。`)
  }
  if (pending > 0) {
    lines.push('')
    lines.push(`还有 ${pending} 条待补交（${path.join(dataDir, client.PENDING_FILE)}）。`)
    lines.push('  直连模式下它们不会自动写进去（怕和服务的队列打架）。两条路：')
    lines.push('  1. 先 `macro-memory serve` + `macro-memory attach` 把队列交上去，再 detach；')
    lines.push('  2. 确认这几条不重要，直接删掉那个文件。')
  }
  out(args.json === true ? JSON.stringify({ removed, had: info ? { pid: info.pid, url: info.url } : null, pending }) : lines.join('\n'))
  process.exit(0)
}

/** `share`：只读地看共享层现在什么样。 */
async function cmdShare(args) {
  const { dataDir, client } = await shareLite(args)
  const info = client.readServeInfo(dataDir)
  const found = await client.discover(dataDir)
  const pending = client.pendingCount(dataDir)
  const mode = found.mode === 'stale' ? 'readonly' : found.mode
  const lines = []
  lines.push('macro-memory share')
  lines.push(`  数据目录：  ${dataDir}`)
  lines.push(`  模式：      ${mode} —— ${client.modeNote(mode)}`)
  lines.push(`  发现文件：  ${client.serveFilePath(dataDir)}${info ? '' : '（不存在）'}`)
  if (info) {
    lines.push(`  写者：      pid ${info.pid}  ${info.url ?? info.socketPath}`)
    if (found.stats) {
      const s = found.stats
      lines.push(`  已服务：    ${s.calls} 次调用 / ${s.writes} 次写 / 去重 ${s.dedup} 次`)
      lines.push(`  队列：      现在 ${s.queue} 条，历史峰值 ${s.maxQueue} 条`)
      lines.push(`  连接过的 agent：${(s.agents ?? []).length === 0 ? '（还没有）' : s.agents.map((a) => `${a.agent}×${a.n}`).join('、')}`)
      lines.push(`  运行时长：  ${Math.round((s.uptimeMs ?? 0) / 1000)} 秒（版本 ${s.version}）`)
    }
  }
  lines.push(`  待补交：    ${pending} 条${pending > 0 ? `（${path.join(dataDir, client.PENDING_FILE)}）` : ''}`)
  if (mode === 'standalone') {
    lines.push('')
    lines.push('直连模式：功能一条不少，只是没有一个统一的写队列。要共享就 macro-memory serve。')
  }
  out(args.json === true ? JSON.stringify({ mode, dataDir, info: info ? { pid: info.pid, url: info.url, startedAt: info.startedAt } : null, stats: found.stats ?? null, pending, reason: found.reason ?? null }, null, 2) : lines.join('\n'))
  process.exit(mode === 'readonly' ? 1 : 0)
}

/**
 * `ui`：开一扇窗。
 *
 * 三种退出方式都算正常：Ctrl-C、关掉终端、或者直接在页面上用够了。关闭走 `close()`，
 * 端口与临时服务一起消失——不留后台进程，不留端口，也不留 `serve.json`（它是客户端，
 * 不是共享服务）。
 */
async function cmdUi(args) {
  const { dataDir } = await shareLite(args)
  const { startUi } = await import('../lib/ui/server.js')
  const cwd = path.resolve(args.cwd ?? process.cwd())
  const port = args.port === undefined ? 0 : Number(args.port)
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    out(`--port 要给 0–65535，收到 ${args.port}`)
    process.exit(1)
  }
  const ui = await startUi({ dataDir, cwd, port, ...(args.agent ? { agent: String(args.agent) } : {}) })
  if (args.json === true) {
    out(JSON.stringify({ url: ui.url, port: ui.port, token: ui.token, upstream: ui.upstream, dataDir, cwd }, null, 2))
  } else {
    out(
      [
        'macro-memory ui',
        `  地址：      ${ui.url}`,
        `  上游：      ${ui.upstream === 'shared' ? '借用已在跑的 serve' : '界面自己临时起了一个（不写发现文件）'}`,
        `  工作区：    ${cwd}`,
        '',
        '  浏览器打开上面那条地址（带 t= 的那条就是凭据，别贴给别人）。',
        '  Ctrl-C 关掉：端口与临时服务一起消失，不留后台进程。',
      ].join('\n'),
    )
  }
  const bye = async (sig) => {
    try {
      await ui.close(sig)
    } catch {
      // 关不干净也要退
    }
    process.exit(0)
  }
  process.on('SIGINT', () => void bye('SIGINT'))
  process.on('SIGTERM', () => void bye('SIGTERM'))
  await new Promise(() => {})
}

/**
 * 组装 → 执行。所有命令共用一套：解析参数、选命令、异常兜底（打印到 stderr、退 2）。
 */
async function main() {
  const args = parseArgv(process.argv.slice(2))
  if (args.help === true || args._.length === 0) {
    out(HELP)
    process.exit(args.help === true ? 0 : 1)
  }
  const cmd = args._.shift()
  switch (cmd) {
    case 'mcp':
      return cmdMcp(args)
    case 'init':
      return cmdInit(args)
    case 'trust':
      return cmdTrust(args)
    case 'remember':
      return cmdRemember(args)
    case 'search':
      return cmdSearch(args)
    case 'read':
      return cmdRead(args)
    case 'project':
      return cmdProject(args)
    case 'injection':
      return cmdInjection(args)
    case 'refresh':
      return cmdRefresh(args)
    case 'uninstall':
      return cmdUninstall(args)
    case 'migrate':
      return cmdMigrate(args)
    case 'serve':
      return cmdServe(args)
    case 'attach':
      return cmdAttach(args)
    case 'detach':
      return cmdDetach(args)
    case 'share':
      return cmdShare(args)
    case 'ui':
      return cmdUi(args)
    case 'doctor':
      return cmdDoctor(args)
    case 'stats':
      return cmdStats(args)
    default:
      out(`没有这个命令：${cmd}\n\n${HELP}`)
      process.exit(1)
  }
}

main().catch((err) => {
  process.stderr.write(`macro-memory 出错：${err?.stack ?? err}\n`)
  process.exit(2)
})
