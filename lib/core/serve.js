/**
 * 单写者服务 `serve`（PLAN 第 6 节 / P1-1 / U7 / U9）。
 *
 * 三件事只有它能做：唯一的写连接、唯一跑 dream 的、唯一打快照的。
 * 其余进程要么直连（没服务时），要么把活交给它（有服务时）——两个写者同时开
 * 一个库，是这类插件唯一真会丢数据的坏，别的都能修。
 *
 * 传输：默认 TCP `127.0.0.1:0`（随机端口），非 Windows 额外挂一条 UDS
 * （`<dataDir>/serve.sock`）；端点信息写进 `<dataDir>/serve.json`，客户端按它探测。
 * 鉴权：一次性随机 token 写进 `serve.json`（0600），请求头 `Bearer`。
 *
 * 崩溃语义（U9）：
 *   agent 死    → 只是连接断了，服务与库都不受影响
 *   服务死      → 客户端探不通 → 写落 `pending.jsonl` → 回执写明「没写进库」
 *   服务回来    → 客户端下次调用先补交（按 requestId 去重，重发不会写两遍）
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

import { DEDUP_WINDOW, PENDING_FILE, pendingCount, readServeInfo, removeServeInfo, writeServeInfo, serveFilePath } from './client.js'
import { createMacroEngine, resolveDataDir, CORE_NAME } from './engine.js'
// 平台判断只有 platform.js 一个入口（probe-platform P8 会盯着这条）：这里不许自己去问宿主平台
import { isWindows, platformName } from '../macro/platform.js'

const VERSION = (() => {
  try {
    const pkg = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8'))
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0'
  } catch {
    return '0.0.0'
  }
})()

function jsonRes(res, status, obj) {
  const body = `${JSON.stringify(obj)}\n`
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) })
  res.end(body)
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (c) => {
      size += c.length
      if (size > 8 * 1024 * 1024) {
        reject(new Error('请求体超过 8 MB'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      if (text.trim().length === 0) return resolve({})
      try {
        resolve(JSON.parse(text))
      } catch (err) {
        reject(new Error(`请求体不是 JSON：${err.message}`))
      }
    })
    req.on('error', reject)
  })
}

/**
 * 起一个服务。
 * @param {object} opts 同 `createMacroEngine`，外加 `port` / `host` / `defaultCwd` / `quiet`
 * @returns {Promise<{url:string, token:string, pid:number, info:object, stats:Function, close:Function, server:object}>}
 */
export async function startServe(opts = {}) {
  const dataDir = resolveDataDir({ dir: opts.dataDir })
  const token = crypto.randomBytes(24).toString('hex')
  const startedAt = Date.now()
  const engine = await createMacroEngine({ ...opts, dataDir, serve: 'off' })
  const defaultCwd = path.resolve(opts.defaultCwd ?? opts.cwd ?? process.cwd())

  // FIFO 队列：一条一个短事务。用 promise 链串行化，前一条失败不影响后一条。
  let tail = Promise.resolve()
  let queued = 0
  let maxQueue = 0
  function enqueue(job) {
    queued += 1
    if (queued > maxQueue) maxQueue = queued
    const run = tail.then(job, job)
    tail = run.then(
      () => {},
      () => {},
    )
    return run.finally(() => {
      queued -= 1
    })
  }

  const counts = { calls: 0, writes: 0, dedup: 0, failed: 0, attaches: 0 }
  const memo = new Map() // requestId -> 回执（去重窗口）
  const agents = new Map() // agent 名 -> {first, last, n}
  const listeners = new Set() // SSE

  function remember(id, payload) {
    memo.set(id, payload)
    if (memo.size > DEDUP_WINDOW) {
      const first = memo.keys().next().value
      if (first !== undefined) memo.delete(first)
    }
  }

  function noteAgent(agent) {
    const key = typeof agent === 'string' && agent.length > 0 ? agent : 'anonymous'
    const row = agents.get(key) ?? { first: Date.now(), last: 0, n: 0 }
    row.last = Date.now()
    row.n += 1
    agents.set(key, row)
    return key
  }

  function broadcast(event, data) {
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
    for (const res of listeners) {
      try {
        res.write(frame)
      } catch {
        listeners.delete(res)
      }
    }
  }

  function stats() {
    return {
      name: CORE_NAME,
      version: VERSION,
      pid: process.pid,
      url,
      dataDir,
      defaultCwd,
      startedAt,
      uptimeMs: Date.now() - startedAt,
      ...counts,
      queue: queued,
      maxQueue,
      dedupWindow: memo.size,
      pending: pendingCount(dataDir),
      agents: [...agents.entries()].map(([agent, row]) => ({ agent, n: row.n, first: row.first, last: row.last })),
    }
  }

  /** `/call` 与 `/write` 共用：写走队列，读也走队列（保证「读到刚写完的」）。 */
  async function handleCall(body) {
    const tool = typeof body.tool === 'string' && body.tool.length > 0 ? body.tool : 'memory_remember'
    const args = body.args && typeof body.args === 'object' ? body.args : {}
    const cwd = typeof body.cwd === 'string' && body.cwd.length > 0 ? path.resolve(body.cwd) : defaultCwd
    const agent = noteAgent(body.agent)
    const requestId = typeof body.requestId === 'string' ? body.requestId : ''
    if (requestId.length > 0) {
      const hit = memo.get(requestId)
      if (hit) {
        counts.dedup += 1
        return { ...hit, deduped: true }
      }
    }
    const payload = await enqueue(async () => {
      counts.calls += 1
      try {
        const result = await engine.call(tool, args, {
          cwd,
          agentId: agent,
          sessionId: body.session,
          noServe: true,
        })
        if (String(tool).startsWith('memory_') && (tool === 'memory_remember' || tool === 'memory_update' || tool === 'memory_link')) {
          counts.writes += 1
        }
        return {
          ok: true,
          tool,
          text: result.text ?? '',
          value: result.value ?? null,
          refused: result.refused === true,
        }
      } catch (err) {
        counts.failed += 1
        return { ok: false, tool, text: `服务里执行失败：${err?.message ?? err}`, value: null, error: String(err?.message ?? err) }
      }
    })
    if (requestId.length > 0) remember(requestId, payload)
    broadcast('call', { tool, agent, at: Date.now(), ok: payload.ok })
    return payload
  }

  const server = http.createServer(async (req, res) => {
    const urlPath = (req.url ?? '/').split('?')[0]
    const query = new URLSearchParams((req.url ?? '').split('?')[1] ?? '')
    const given = String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '')
    if (given !== token) return jsonRes(res, 401, { ok: false, error: 'token 不对（看 serve.json 里的 token）' })

    try {
      if (req.method === 'GET' && urlPath === '/stats') return jsonRes(res, 200, stats())

      if (req.method === 'GET' && urlPath === '/events') {
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        })
        res.write(`event: hello\ndata: ${JSON.stringify({ pid: process.pid, at: Date.now() })}\n\n`)
        listeners.add(res)
        const beat = setInterval(() => {
          try {
            res.write(`: ping ${Date.now()}\n\n`)
          } catch {
            clearInterval(beat)
            listeners.delete(res)
          }
        }, 15000)
        req.on('close', () => {
          clearInterval(beat)
          listeners.delete(res)
        })
        return undefined
      }

      if (req.method === 'POST' && (urlPath === '/call' || urlPath === '/write')) {
        const body = await readJson(req)
        const out = await handleCall(body)
        return jsonRes(res, 200, out)
      }

      if (req.method === 'GET' && urlPath === '/search') {
        const out = await handleCall({
          tool: 'memory_search',
          args: { query: query.get('q') ?? '', ...(query.get('k') ? { k: Number(query.get('k')) } : {}), ...(query.get('mode') ? { mode: query.get('mode') } : {}) },
          cwd: query.get('cwd') ?? undefined,
          agent: query.get('agent') ?? 'http',
        })
        return jsonRes(res, 200, out)
      }

      if (req.method === 'GET' && urlPath === '/read') {
        const out = await handleCall({ tool: 'memory_read', args: { id: query.get('id') ?? '' }, cwd: query.get('cwd') ?? undefined, agent: query.get('agent') ?? 'http' })
        return jsonRes(res, 200, out)
      }

      // 管理界面（PLAN §10 / P2-1）要的两块数据：分布账与 L0 注入预览。
      // 都**不直连库**：UI 走这两个端点，serve 才是库的主人；只读，不建库不建表。
      if (req.method === 'GET' && urlPath === '/census') {
        const cwdArg = query.get('cwd') ?? opts.cwd ?? process.cwd()
        try {
          return jsonRes(res, 200, { ok: true, ...engine.census(cwdArg) })
        } catch (err) {
          return jsonRes(res, 500, { ok: false, error: String(err?.message ?? err) })
        }
      }

      if (req.method === 'GET' && urlPath === '/inject') {
        const raw = query.get('maxChars')
        const maxChars = raw !== null && Number.isFinite(Number(raw)) && Number(raw) > 0 ? Number(raw) : undefined
        const text = engine.injection({ ...(maxChars === undefined ? {} : { maxChars }) })
        return jsonRes(res, 200, { ok: true, text, chars: String(text ?? '').length })
      }

      if (req.method === 'POST' && urlPath === '/attach') {
        const body = await readJson(req)
        counts.attaches += 1
        const agent = noteAgent(body.agent)
        return jsonRes(res, 200, { ok: true, mode: 'shared', agent, pid: process.pid, url, startedAt, defaultCwd })
      }

      if (req.method === 'POST' && urlPath === '/detach') {
        const body = await readJson(req)
        const agent = typeof body.agent === 'string' ? body.agent : ''
        if (body.shutdown === true) {
          jsonRes(res, 200, { ok: true, shutdown: true })
          setImmediate(() => {
            void close('detach-shutdown')
          })
          return undefined
        }
        return jsonRes(res, 200, { ok: true, mode: 'shared', detached: agent })
      }

      if (req.method === 'GET' && urlPath === '/health') return jsonRes(res, 200, { ok: true })

      return jsonRes(res, 404, { ok: false, error: `没有这个端点 ${req.method} ${urlPath}` })
    } catch (err) {
      counts.failed += 1
      return jsonRes(res, 500, { ok: false, error: String(err?.message ?? err) })
    }
  })

  let socketPath = ''
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    const port = Number.isInteger(opts.port) ? opts.port : 0
    const host = typeof opts.host === 'string' && opts.host.length > 0 ? opts.host : '127.0.0.1'
    server.listen(port, host, () => resolve())
  })
  const addr = server.address()
  const url = `http://${typeof opts.host === 'string' && opts.host.length > 0 ? opts.host : '127.0.0.1'}:${addr && typeof addr === 'object' ? addr.port : 0}`

  if (!isWindows()) {
    // UDS 是 Unix 上的首选（不用端口、不用防火墙），TCP 那条留着当后备。
    try {
      const uds = http.createServer(server.listeners('request')[0])
      socketPath = path.join(dataDir, 'serve.sock')
      fs.rmSync(socketPath, { force: true })
      await new Promise((resolve, reject) => {
        uds.once('error', reject)
        uds.listen(socketPath, () => resolve())
      })
      server.uds = uds
    } catch {
      socketPath = ''
    }
  }

  const info = {
    name: CORE_NAME,
    version: VERSION,
    pid: process.pid,
    url,
    ...(socketPath ? { socketPath } : {}),
    token,
    dataDir,
    defaultCwd,
    startedAt,
    platform: platformName(),
    host: os.hostname(),
    file: serveFilePath(dataDir),
  }
  // publish=false：只在本进程里当服务用，**不写发现文件**——管理界面（`macro-memory ui`）
  // 借不到现成服务时会临时起一个，它没有资格把别人的 `serve.json` 换成自己的。
  const publish = opts.publish !== false
  writeServeInfo(dataDir, info, { publish })

  let closed = false
  async function close(reason = 'manual') {
    if (closed) return { reason, already: true }
    closed = true
    for (const res of listeners) {
      try {
        res.end()
      } catch {
        // 已经断了
      }
    }
    listeners.clear()
    await new Promise((resolve) => server.close(() => resolve()))
    if (server.uds) await new Promise((resolve) => server.uds.close(() => resolve()))
    if (socketPath) fs.rmSync(socketPath, { force: true })
    await tail.catch(() => {})
    const removed = removeServeInfo(dataDir, token)
    try {
      await engine.close()
    } catch {
      // 关引擎失败不影响「服务已停」这个事实
    }
    return { reason, removed, stats: stats() }
  }

  return { url, token, pid: process.pid, info, stats, close, server, dataDir, engine }
}

/** 便捷读口：从 `serve.json` 里拿 token 后打一条 `/stats`。 */
export async function serveStats(dataDir) {
  const info = readServeInfo(dataDir)
  if (!info) return { mode: 'standalone', reason: 'no-serve-json', pending: pendingCount(dataDir), file: serveFilePath(dataDir), pendingFile: path.join(dataDir, PENDING_FILE) }
  const { request, discover } = await import('./client.js')
  const found = await discover(dataDir)
  if (found.mode !== 'shared') {
    return { mode: 'stale', reason: found.reason, info: { pid: info.pid, url: info.url, startedAt: info.startedAt }, pending: pendingCount(dataDir), file: serveFilePath(dataDir) }
  }
  const res = await request(info, 'GET', '/stats', undefined, { timeout: 2000 })
  return { mode: 'shared', stats: res.json, pending: pendingCount(dataDir), file: serveFilePath(dataDir) }
}
