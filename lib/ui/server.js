/**
 * 管理界面（PLAN §10 / P2-1）：`macro-memory ui`。
 *
 * 三条纪律写在门口，别在下游再松：
 *
 *   1. **只听 `127.0.0.1`**，端口由系统挑（`port: 0`）；令牌一次性、进 URL、不落盘。
 *      它不是网络服务，是你自己机器上的一扇窗。
 *   2. **界面不直连库**（PLAN 原话：它是 `serve` 的客户端）。探到现成的 serve 就借它的；
 *      探不到就在本进程里临时起一个——`publish: false`，**不写发现文件、不撤别人的**，
 *      关界面就一起停。这样「开着界面」永远不会把一个共享服务变成两个写者。
 *   3. **关掉之后进程与端口全消失**：`close()` 里先关 HTTP，再关临时 serve（引擎跟着关）。
 *
 * 页面本身在 `page.js` 里，一个常量。
 */
import http from 'node:http'
import path from 'node:path'
import fs from 'node:fs'
import crypto from 'node:crypto'
import { discover, request as askServe } from '../core/client.js'
import { startServe } from '../core/serve.js'
import { resolveDataDir } from '../core/engine.js'
import { PAGE_HTML } from './page.js'

const VERSION = (() => {
  try {
    return String(JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version ?? '0.0.0')
  } catch {
    return '0.0.0'
  }
})()

function jsonRes(res, code, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) })
  res.end(body)
}

function textRes(res, code, text, type = 'text/plain; charset=utf-8') {
  res.writeHead(code, { 'content-type': type, 'content-length': Buffer.byteLength(text) })
  res.end(text)
}

function readJson(req) {
  return new Promise((resolve) => {
    const chunks = []
    let size = 0
    req.on('data', (c) => {
      size += c.length
      if (size > 4 * 1024 * 1024) {
        req.destroy()
        resolve({})
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      if (raw.trim() === '') return resolve({})
      try {
        resolve(JSON.parse(raw))
      } catch {
        resolve({})
      }
    })
    req.on('error', () => resolve({}))
  })
}

/**
 * 起一扇窗。
 *
 * @param {object} opts
 * @param {string} [opts.dataDir] 数据目录（默认走 `resolveDataDir`）
 * @param {string} [opts.cwd] 打开时看哪个工作区（默认当前目录）
 * @param {string} [opts.agent] 界面自己报的 agent 名（默认 `ui`）
 * @param {number} [opts.port] 想固定端口就传（默认 0 = 系统挑）
 * @returns {Promise<{url:string, port:number, token:string, upstream:string, dataDir:string, cwd:string, server:object, close:Function}>}
 */
export async function startUi(opts = {}) {
  const dataDir = resolveDataDir({ dir: opts.dataDir })
  const cwd = path.resolve(opts.cwd ?? process.cwd())
  const agent = typeof opts.agent === 'string' && opts.agent.length > 0 ? opts.agent : 'ui'

  const found = await discover(dataDir)
  let upstream
  if (found.mode === 'shared' && found.info) {
    upstream = { mode: 'shared', info: found.info, note: `写交给已在跑的服务，pid ${found.info.pid}`, own: null }
  } else {
    const own = await startServe({
      dataDir,
      cwd,
      defaultCwd: cwd,
      port: 0,
      publish: false,
      ...(opts.homeDir ? { homeDir: opts.homeDir } : {}),
      ...(opts.projectDir ? { projectDir: opts.projectDir } : {}),
    })
    upstream = {
      mode: 'local',
      info: own.info,
      note: `没探到在跑的服务，界面自己临时起了一个（pid ${process.pid}，不写发现文件，关界面就停）`,
      own,
    }
  }

  const token = crypto.randomBytes(18).toString('hex')

  const server = http.createServer((req, res) => {
    void (async () => {
      const urlPath = (req.url ?? '/').split('?')[0]
      const query = new URLSearchParams((req.url ?? '').split('?')[1] ?? '')
      const given = String(req.headers['x-mm-token'] ?? query.get('t') ?? '')
      if (given !== token) {
        return textRes(res, 401, '令牌不对：请用启动时打印的那条带 t= 的地址打开这一页。')
      }

      try {
        if (req.method === 'GET' && (urlPath === '/' || urlPath === '/index.html')) {
          return textRes(res, 200, PAGE_HTML, 'text/html; charset=utf-8')
        }

        if (req.method === 'GET' && urlPath === '/api/state') {
          const [cen, st, inj] = await Promise.all([
            askServe(upstream.info, 'GET', `/census?cwd=${encodeURIComponent(cwd)}`, undefined, { timeout: 8000 }),
            askServe(upstream.info, 'GET', '/stats', undefined, { timeout: 8000 }),
            askServe(upstream.info, 'GET', '/inject', undefined, { timeout: 8000 }),
          ])
          return jsonRes(res, 200, {
            ok: true,
            version: VERSION,
            dataDir,
            cwd,
            agent,
            upstream: { mode: upstream.mode, note: upstream.note, pid: upstream.info.pid ?? null },
            census: cen.json ?? null,
            stats: st.json ?? null,
            injectChars: inj.json?.chars ?? 0,
          })
        }

        if (req.method === 'GET' && urlPath === '/api/census') {
          const out = await askServe(upstream.info, 'GET', `/census?cwd=${encodeURIComponent(query.get('cwd') ?? cwd)}`, undefined, { timeout: 8000 })
          return jsonRes(res, out.status === 200 ? 200 : 502, out.json ?? { ok: false, error: out.text })
        }

        if (req.method === 'GET' && urlPath === '/api/inject') {
          const cap = query.get('maxChars')
          const p = cap && Number(cap) > 0 ? `/inject?maxChars=${encodeURIComponent(cap)}` : '/inject'
          const out = await askServe(upstream.info, 'GET', p, undefined, { timeout: 8000 })
          return jsonRes(res, out.status === 200 ? 200 : 502, out.json ?? { ok: false, error: out.text })
        }

        if (req.method === 'GET' && urlPath === '/api/search') {
          const qs = new URLSearchParams()
          qs.set('q', query.get('q') ?? '')
          for (const key of ['k', 'mode']) {
            const v = query.get(key)
            if (v !== null && v !== '') qs.set(key, v)
          }
          qs.set('cwd', query.get('cwd') ?? cwd)
          qs.set('agent', agent)
          const out = await askServe(upstream.info, 'GET', `/search?${qs.toString()}`, undefined, { timeout: 30000 })
          return jsonRes(res, out.status === 200 ? 200 : 502, out.json ?? { ok: false, error: out.text })
        }

        if (req.method === 'GET' && urlPath === '/api/read') {
          const qs = new URLSearchParams()
          qs.set('id', query.get('id') ?? '')
          qs.set('cwd', query.get('cwd') ?? cwd)
          qs.set('agent', agent)
          const out = await askServe(upstream.info, 'GET', `/read?${qs.toString()}`, undefined, { timeout: 15000 })
          return jsonRes(res, out.status === 200 ? 200 : 502, out.json ?? { ok: false, error: out.text })
        }

        if (req.method === 'POST' && urlPath === '/api/call') {
          const body = await readJson(req)
          if (typeof body.tool !== 'string' || body.tool.length === 0) {
            return jsonRes(res, 400, { ok: false, error: '要给 tool（比如 memory_admin）' })
          }
          const out = await askServe(
            upstream.info,
            'POST',
            '/call',
            { tool: body.tool, args: body.args ?? {}, cwd: body.cwd ?? cwd, agent, requestId: body.requestId },
            { timeout: 120000 },
          )
          return jsonRes(res, out.status === 200 ? 200 : 502, out.json ?? { ok: false, error: out.text })
        }

        return jsonRes(res, 404, { ok: false, error: '没有这个端点' })
      } catch (err) {
        return jsonRes(res, 500, { ok: false, error: String(err?.message ?? err) })
      }
    })()
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen({ host: '127.0.0.1', port: Number.isInteger(opts.port) ? opts.port : 0 }, () => {
      server.removeListener('error', reject)
      resolve()
    })
  })

  const addr = server.address()
  const port = typeof addr === 'object' && addr ? Number(addr.port) : 0
  const url = `http://127.0.0.1:${port}/?t=${token}`

  let closed = false
  async function close(reason = 'ui-close') {
    if (closed) return { reason, already: true }
    closed = true
    await new Promise((resolve) => server.close(() => resolve()))
    let own = null
    if (upstream.own) {
      try {
        own = await upstream.own.close(reason)
      } catch {
        // 临时服务停不下来也不该拖住「界面已关」
      }
    }
    return { reason, upstream: upstream.mode, own }
  }

  return { url, port, token, upstream: upstream.mode, dataDir, cwd, agent, server, close }
}
