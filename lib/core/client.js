/**
 * core 的共享层客户端（PLAN 第 5、6 节 / P1-1 / U7 / U9）。
 *
 * 三档模式：
 *   standalone  没有 `serve.json`（没装服务）→ 直连本地库，一切照旧
 *   shared      `serve.json` 在、探得通 → 读写都交给服务（它是唯一写连接）
 *   readonly    `serve.json` 在、探不通（服务被 kill 了 / 还没起来）→ 不写库，
 *               这一条先落 `pending.jsonl`，服务回来自动补交
 *
 * 「探不通也排队」而不是「探不通就自己写」，是因为：有 `serve.json` 说明这台机器
 * 上**本来**有个单写者，两个写者同时开库才是真正会丢数据的那种坏。宁可让用户
 * 多敲一次 `macro-memory serve`，也不让两条连接各写一半。
 *
 * 只有一条例外：令牌对不上（`401`）→ 当成「这不是我们的服务」，回落直连。
 * 否则换个用户、换个 dataDir 的旧 `serve.json` 会把整台机器锁成只读。
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { readJsonl } from '../macro/store.js'
import { isWindows } from '../macro/platform.js'

/** 服务发现文件（与数据目录同级，跟着 dataDir 隔离——探针各用各的临时目录）。 */
export const SERVE_FILE = 'serve.json'
/** 服务不通时待补交的写队列：一行一条 JSON，先来先补。 */
export const PENDING_FILE = 'pending.jsonl'
/** 探测超时：本机回环，300 ms 还没应就算不通。 */
const PROBE_TIMEOUT_MS = 300
/** 正常调用超时：写一条记忆不该慢过这个数。 */
const CALL_TIMEOUT_MS = 30000
/** `requestId` 记忆上限：服务端去重窗口，够覆盖一次重连的重发量。 */
export const DEDUP_WINDOW = 5000

export function serveFilePath(dataDir) {
  return path.join(dataDir, SERVE_FILE)
}

export function pendingFilePath(dataDir) {
  return path.join(dataDir, PENDING_FILE)
}

/** 读 `serve.json`；没有、坏掉、不是对象一律 null（坏文件不该让整个进程起不来）。 */
export function readServeInfo(dataDir) {
  try {
    const raw = fs.readFileSync(serveFilePath(dataDir), 'utf8')
    const info = JSON.parse(raw)
    if (!info || typeof info !== 'object') return null
    if (typeof info.token !== 'string' || info.token.length < 8) return null
    if (typeof info.url !== 'string' && typeof info.socketPath !== 'string') return null
    return info
  } catch {
    return null
  }
}

export function writeServeInfo(dataDir, info, opts = {}) {
  // publish=false：不落发现文件（管理界面临时起的服务没有资格换掉别人的 serve.json）。
  if (opts.publish === false) return null
  fs.mkdirSync(dataDir, { recursive: true })
  const file = serveFilePath(dataDir)
  fs.writeFileSync(file, `${JSON.stringify(info, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  return file
}

/** 只在 token 对得上时删——别把别人（另一个 dataDir/用户）的发现文件撤了。 */
export function removeServeInfo(dataDir, token) {
  const info = readServeInfo(dataDir)
  if (!info) return false
  if (typeof token === 'string' && token.length > 0 && info.token !== token) return false
  try {
    fs.unlinkSync(serveFilePath(dataDir))
    return true
  } catch {
    return false
  }
}

export function makeRequestId() {
  return `${process.pid.toString(36)}-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`
}

/** 一次 HTTP 往返。Windows 走 `url`（127.0.0.1），Unix 优先 `socketPath`。 */
export function request(info, method, urlPath, body, opts = {}) {
  const timeout = Number(opts.timeout ?? CALL_TIMEOUT_MS)
  const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8')
  const headers = {
    authorization: `Bearer ${info.token}`,
    accept: 'application/json',
  }
  if (payload) {
    headers['content-type'] = 'application/json'
    headers['content-length'] = String(payload.length)
  }
  const options = { method, path: urlPath, headers, timeout }
  if (!isWindows() && typeof info.socketPath === 'string' && info.socketPath.length > 0) {
    options.socketPath = info.socketPath
  } else {
    const u = new URL(info.url)
    options.host = u.hostname
    options.port = Number(u.port || 80)
  }
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        let json = null
        try {
          json = text.length > 0 ? JSON.parse(text) : null
        } catch {
          json = null
        }
        resolve({ status: res.statusCode ?? 0, text, json })
      })
    })
    req.on('timeout', () => {
      req.destroy(new Error(`超时（${timeout} ms）`))
    })
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

/**
 * 探一次服务：`/stats` 回 200 才算通。
 * @returns {Promise<{mode:'standalone'|'shared'|'stale', info?:object, stats?:object, reason?:string}>}
 */
export async function discover(dataDir) {
  const info = readServeInfo(dataDir)
  if (!info) return { mode: 'standalone', reason: 'no-serve-json' }
  try {
    const res = await request(info, 'GET', '/stats', undefined, { timeout: PROBE_TIMEOUT_MS })
    if (res.status === 401) return { mode: 'standalone', info, reason: 'unauthorized' }
    if (res.status !== 200 || !res.json) return { mode: 'stale', info, reason: `stats ${res.status}` }
    return { mode: 'shared', info, stats: res.json }
  } catch (err) {
    return { mode: 'stale', info, reason: String(err?.message ?? err) }
  }
}

// ── 待补交队列 ────────────────────────────────────────────────────────────────

export function enqueuePending(dataDir, item) {
  try {
    fs.mkdirSync(dataDir, { recursive: true })
    fs.appendFileSync(pendingFilePath(dataDir), `${JSON.stringify(item)}\n`, 'utf8')
    return true
  } catch {
    return false
  }
}

export function readPending(dataDir) {
  // 逐行解析只许有一份（doctor 的「jsonl 逐行解析没有第二份」盯着这条）：
  // 这里直接借 store.js 的读法——空行跳过、坏行丢掉、文件不在就空。
  return readJsonl(pendingFilePath(dataDir)).filter(
    (item) => item && typeof item === 'object' && typeof item.tool === 'string',
  )
}

/** 整份重写（原子替换），补交失败的行留下。 */
export function rewritePending(dataDir, items) {
  const file = pendingFilePath(dataDir)
  try {
    if (items.length === 0) {
      fs.rmSync(file, { force: true })
      return
    }
    const tmp = `${file}.tmp`
    fs.writeFileSync(tmp, items.map((it) => JSON.stringify(it)).join('\n') + '\n', 'utf8')
    fs.renameSync(tmp, file)
  } catch {
    // 写不回去也不能崩：队列是尽力而为
  }
}

export function pendingCount(dataDir) {
  return readPending(dataDir).length
}

/**
 * 把待补交的写补上。服务端按 `requestId` 去重，所以「补交时其实已经写进去了」
 * 不会变成两条——这也是队列里必须存原始 id 的原因。
 * @returns {Promise<{sent:number, left:number, failed:number}>}
 */
export async function flushPending(dataDir, info) {
  const items = readPending(dataDir)
  if (items.length === 0) return { sent: 0, left: 0, failed: 0 }
  const left = []
  let sent = 0
  for (const item of items) {
    try {
      const res = await request(info, 'POST', '/call', {
        requestId: item.requestId,
        tool: item.tool,
        args: item.args ?? {},
        cwd: item.cwd,
        agent: item.agent,
        session: item.session,
      })
      if (res.status === 200) sent += 1
      else left.push(item)
    } catch {
      left.push(item)
    }
  }
  rewritePending(dataDir, left)
  return { sent, left: left.length, failed: left.length }
}

// ── 给引擎用的那一层 ─────────────────────────────────────────────────────────

const MODE_NOTE = {
  standalone: '直连本地库',
  shared: '读写都走服务（唯一写连接）',
  readonly: '服务不在了：这次没写进库，先排队等补交',
}

export function modeNote(mode) {
  return MODE_NOTE[mode] ?? mode
}

/** 服务不通时的回执：说清「没写进去」「排在第几条」「怎么补」。 */
export function offlineText(info, queuedCount, dataDir) {
  const where = typeof info?.url === 'string' ? info.url : info?.socketPath ?? '服务'
  return [
    `服务连不上（${where}，pid ${info?.pid ?? '?'}），**这次没有写进库**。`,
    `已经排进待补交队列：${path.join(dataDir, PENDING_FILE)} 现在第 ${queuedCount} 条。`,
    '',
    '三条路，挑一条：',
    '  1. `macro-memory serve` 起服务——下次调用会自动补交（服务端按 requestId 去重，不会写两遍）；',
    '  2. 直接再调一次同一件事，服务在的话先补交再执行；',
    '  3. `macro-memory detach` 认输，回到直连模式（之后写库由本进程负责）。',
  ].join('\n')
}

/**
 * 引擎的共享层入口：`standalone` 就返回 `{mode:'standalone'}` 让调用方直连，
 * 否则直接把结果（或只读回执）交给上层。
 */
export async function sharedCall({ dataDir, tool, args, cwd, agentId, sessionId }) {
  const found = await discover(dataDir)
  if (found.mode === 'standalone') return { mode: 'standalone', reason: found.reason }
  const info = found.info
  if (found.mode === 'stale') {
    enqueuePending(dataDir, {
      requestId: makeRequestId(),
      tool,
      args,
      cwd,
      agent: agentId,
      session: sessionId,
      at: Date.now(),
      error: found.reason,
    })
    const queued = pendingCount(dataDir)
    return {
      mode: 'readonly',
      refused: true,
      queued: true,
      reason: 'serve-down',
      text: offlineText(info, queued, dataDir),
      value: null,
    }
  }
  const requestId = makeRequestId()
  let res
  try {
    res = await request(info, 'POST', '/call', {
      requestId,
      tool,
      args,
      cwd,
      agent: agentId,
      session: sessionId,
    })
  } catch (err) {
    enqueuePending(dataDir, { requestId, tool, args, cwd, agent: agentId, session: sessionId, at: Date.now(), error: String(err?.message ?? err) })
    const queued = pendingCount(dataDir)
    return {
      mode: 'readonly',
      refused: true,
      queued: true,
      reason: 'serve-down',
      text: offlineText(info, queued, dataDir),
      value: null,
    }
  }
  if (res.status === 401) return { mode: 'standalone', reason: 'unauthorized' }
  if (res.status !== 200 || !res.json) {
    enqueuePending(dataDir, { requestId, tool, args, cwd, agent: agentId, session: sessionId, at: Date.now(), error: `status ${res.status}` })
    const queued = pendingCount(dataDir)
    return {
      mode: 'readonly',
      refused: true,
      queued: true,
      reason: `serve-${res.status}`,
      text: offlineText(info, queued, dataDir),
      value: null,
    }
  }
  // 顺手补交：只在队列非空时做，正常路径（队列空）零成本。
  let flushed = 0
  if (pendingCount(dataDir) > 0) {
    const done = await flushPending(dataDir, info)
    flushed = done.sent
  }
  return { mode: 'shared', requestId, text: res.json.text ?? '', value: res.json.value ?? null, deduped: res.json.deduped === true, flushed }
}
