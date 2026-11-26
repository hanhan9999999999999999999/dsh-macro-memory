/**
 * mcp/stdio —— `macro-memory/mcp` 的入口：装一个引擎，把它接到 stdin/stdout 上。
 *
 * 这一支存在的理由只有一个：让「起一个 MCP 服务器」变成**一句话**。
 *
 *   npx -y macro-memory mcp            # CLI 路子
 *   import { startMcp } from 'macro-memory/mcp'   # 代码路子
 *
 * 宿主启动 MCP 子进程时，cwd 往往是宿主自己的工作目录，不是项目目录。所以工作区
 * 除了 `--cwd` 还认一个环境变量 `MACRO_MEMORY_WORKSPACE`——在宿主配置里写死一行
 * env，比要求用户改 cwd 现实得多（同 CLI 的 `cwdOf`，两条路必须是同一套规则）。
 *
 * 纪律（与 mcp/server.js 一致，但这里是入口，所以要自己守住）：
 *   1. **stdout 只准出协议报文**：所有诊断写 stderr；
 *   2. 引擎起不来就退 2，并给一句人话，不半死不活地挂在那儿；
 *   3. 不主动装常驻、不偷偷起服务——MCP 只是个客户端，共享与否由用户决定。
 */

import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { createMacroEngine } from '../core/engine.js'
import { serveStdio } from './server.js'

/** 自报版本：读本包的 package.json，避免两处版本号打架。 */
export function versionOf() {
  try {
    const pkg = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8'))
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0'
  } catch {
    return '0.0.0'
  }
}

/** 工作区：`--cwd` > 环境变量 `MACRO_MEMORY_WORKSPACE` > 当前目录。 */
export function workspaceOf(explicit) {
  const raw =
    typeof explicit === 'string' && explicit.length > 0
      ? explicit
      : typeof process.env.MACRO_MEMORY_WORKSPACE === 'string' && process.env.MACRO_MEMORY_WORKSPACE.trim().length > 0
        ? process.env.MACRO_MEMORY_WORKSPACE.trim()
        : process.cwd()
  return path.resolve(raw)
}

/**
 * 起一个 stdio 服务器（阻塞到 stdin 关闭）。
 *
 * @param {object} [opts]
 * @param {string} [opts.cwd]        工作区（默认按 workspaceOf 的规则）
 * @param {string} [opts.dataDir]    配置/日志目录
 * @param {string} [opts.projectDir] 工作区内的库目录名
 * @param {string} [opts.homeDir]    全局库目录
 * @param {boolean} [opts.withNebula=false] 是否挂星图引擎
 * @param {boolean} [opts.verbose]
 * @param {string} [opts.name]       自报名字（默认 macro-memory）
 * @param {(line:string)=>void} [opts.log] 诊断日志（默认写 stderr）
 * @param {NodeJS.ReadableStream} [opts.input]
 * @param {NodeJS.WritableStream} [opts.output]
 */
export async function startMcp(opts = {}) {
  const log = opts.log ?? ((line) => process.stderr.write(`${line}\n`))
  const engine = await createMacroEngine({
    cwd: workspaceOf(opts.cwd),
    ...(typeof opts.dataDir === 'string' ? { dataDir: opts.dataDir } : {}),
    ...(typeof opts.projectDir === 'string' ? { projectDir: opts.projectDir } : {}),
    ...(typeof opts.homeDir === 'string' ? { homeDir: opts.homeDir } : {}),
    ...(opts.withNebula === true ? { withNebula: true } : {}),
    ...(opts.verbose === true ? { verbose: true } : {}),
  })
  if (!engine.ready.meow) {
    // 起不来就别装活：MCP 客户端会把「连上了但每个工具都报错」当成更坏的情况
    await engine.close()
    throw new Error('记忆引擎没装配起来：先跑一次 `macro-memory doctor` 看原因')
  }
  try {
    await serveStdio({
      engine,
      version: opts.version ?? versionOf(),
      name: opts.name ?? 'macro-memory',
      ...(opts.input ? { input: opts.input } : {}),
      ...(opts.output ? { output: opts.output } : {}),
      log,
    })
  } finally {
    await engine.close()
  }
}

/** 极简参数解析：只认 `--k v` / `--k=v` / `--flag`，与 CLI 同一套口味。 */
function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (!a.startsWith('--')) continue
    const eq = a.indexOf('=')
    if (eq > 2) {
      out[a.slice(2, eq)] = a.slice(eq + 1)
      continue
    }
    const key = a.slice(2)
    const next = argv[i + 1]
    if (typeof next === 'string' && !next.startsWith('--')) {
      out[key] = next
      i += 1
    } else {
      out[key] = true
    }
  }
  return out
}

/**
 * 直接跑这一支时的入口：`node lib/mcp/stdio.js [--cwd 目录] [--data-dir 目录] …`
 *
 * 失败一律退 2（装配问题），让宿主的「服务器起不来」提示里有字可看。
 */
export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv)
  try {
    await startMcp({
      ...(typeof args.cwd === 'string' ? { cwd: args.cwd } : {}),
      ...(typeof args['data-dir'] === 'string' ? { dataDir: args['data-dir'] } : {}),
      ...(typeof args['project-dir'] === 'string' ? { projectDir: args['project-dir'] } : {}),
      ...(typeof args['home-dir'] === 'string' ? { homeDir: args['home-dir'] } : {}),
      ...(args['with-nebula'] === true ? { withNebula: true } : {}),
      ...(args.verbose === true ? { verbose: true } : {}),
    })
    return 0
  } catch (err) {
    process.stderr.write(`macro-memory mcp：${err?.message ?? err}\n`)
    return 2
  }
}

// 被当脚本跑（不是被 import）时才自己启动
const isMain = (() => {
  const entry = process.argv[1]
  if (typeof entry !== 'string' || entry.length === 0) return false
  try {
    return pathToFileURL(path.resolve(entry)).href === import.meta.url
  } catch {
    return false
  }
})()

if (isMain) {
  const code = await main()
  if (code !== 0) process.exit(code)
}
