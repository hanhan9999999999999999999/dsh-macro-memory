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
  doctor              自检：引擎就绪、库位置、信任状态、路径
  stats               库规模与工具清单

通用参数：
  --cwd <目录>        按哪个工作区算（默认当前目录）
  --data-dir <目录>   配置/日志放哪（默认按平台）
  --project-dir <名>  工作区内的库目录名（默认 .dsh-meow，与 DSH 共用）
  --home-dir <目录>   全局库目录（默认跟随 meow：装了 DSH 就是 DSH 的 storages）
  --json              机器可读输出
  --no-nebula         不挂星图引擎（更快、更省内存）
  -h, --help          看这个

例子：
  npx -y -p dsh-macro-memory macro-memory mcp
  npx -y -p dsh-macro-memory macro-memory init
  npx -y -p dsh-macro-memory macro-memory remember "预发库只读，改数据走主库" --project 运维 --keywords 预发,只读
  npx -y -p dsh-macro-memory macro-memory search "预发库"
`

/** 极简参数解析：只认 `--k v` / `--k=v` / `--flag`，其余进位置参数。 */
function parseArgv(argv) {
  const out = { _: [] }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--') {
      out._.push(...argv.slice(i + 1))
      break
    }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=')
      if (eq > 0) {
        out[a.slice(2, eq)] = a.slice(eq + 1)
        continue
      }
      const key = a.slice(2)
      const next = argv[i + 1]
      if (next !== undefined && !next.startsWith('-')) {
        out[key] = next
        i += 1
      } else {
        out[key] = true
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
  const serverCmd = process.platform === 'win32' ? 'npx -y -p dsh-macro-memory macro-memory mcp' : 'npx -y -p dsh-macro-memory macro-memory mcp'
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
  const res = await eng.call('memory_remember', payload, { cwd: cwdOf(args) })
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
  }, { cwd: cwdOf(args) })
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
  }, { cwd: cwdOf(args) })
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
  const res = await eng.call('memory_project', { project }, { cwd: cwdOf(args) })
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
  const res = await eng.call('memory_admin', { action: 'stats' }, { cwd: cwdOf(args) })
  out(args.json === true ? JSON.stringify({ engine: eng.stats(), panel: res.text }) : res.text)
  await eng.close()
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
