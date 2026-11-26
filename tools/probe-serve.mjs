/**
 * 验收：单写者服务 `serve`（PLAN-UNIVERSAL §5、§6 / P1-1 / 判据 U7、U9）。
 *
 * 检的是「多 agent 共用一个库时，写只有一条队列」：
 *   V1 没有 `serve.json` = 没装服务：共享层直接返回 standalone，一次连接都不建
 *   V2 起服务后 `serve.json` 落在数据目录里，`/stats` 带对令牌能读
 *   V3 经服务写的条目真的进了库；`requestId` 重发同一条只算一次（幂等）
 *   V4 两个**独立进程**各写 200 条 → 库里 400 条、内容 400 种（U7：不丢不重）
 *   V5 令牌不对 → 401，且服务不改任何状态
 *   V6 服务被 kill（`serve.json` 留着）→ 写不进库、回执说清、落 pending（U9 前半）
 *   V7 服务回来 → 下次调用先补交，库里多出那一条，pending 清空（U9 后半）
 *   V8 服务正常关闭 → `serve.json` 自己消失、端口不再接受连接，回落 standalone
 *   V9 `noServe` 的调用不被自己的服务截走（否则 serve 里会无限递归）
 *   V10 `/events` 是 SSE：先来一条 hello，再有心跳（UI 就靠这条）
 *
 * 全部在临时目录里做，不碰真实库、不占固定端口（`port: 0`）。
 * 用法：node tools/probe-serve.mjs
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { root } from './_root.mjs'

const mod = (p) => import(pathToFileURL(join(root, p)).href)
const here = (p) => join(root, p)

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

const tmp = mkdtempSync(join(tmpdir(), 'macro-serve-'))
const ws = join(tmp, 'ws')
const home = join(tmp, 'home')
const dataDir = join(tmp, 'data')
for (const d of [ws, home, dataDir]) mkdirSync(d, { recursive: true })

process.env.DSH_HOME = join(tmp, 'dsh-home')
mkdirSync(join(process.env.DSH_HOME, 'storages'), { recursive: true })
writeFileSync(join(process.env.DSH_HOME, 'storages', 'meow-memory-home.json'), JSON.stringify({ homeDir: home }))

const { createMacroEngine } = await mod('lib/core/engine.js')
const { startServe } = await mod('lib/core/serve.js')
const { readServeInfo, pendingCount, request, SERVE_FILE, PENDING_FILE } = await mod('lib/core/client.js')
const Meow = await mod('vendor/meow-memory/lib/index.js')

const engineOpts = { dataDir, homeDir: home, projectDir: '.dsh-meow', meow: { autoMigrate: false } }
const serveFile = join(dataDir, SERVE_FILE)
const as = (agentId) => ({ cwd: ws, agentId })
const factCount = () => {
  const db = Meow.getDb(ws, '.dsh-meow')
  const row = db.p('SELECT COUNT(*) AS n FROM fact').get()
  return Number(row?.n ?? Object.values(row ?? {})[0] ?? 0)
}
const contents = () => {
  const db = Meow.getDb(ws, '.dsh-meow')
  return db.p('SELECT content FROM fact').all().map((r) => String(r.content ?? ''))
}
const remember = (eng, content, who = 'codex') =>
  eng.call('memory_remember', { content, level: 'fact', keywords: ['serve'], importance: 2, project: 'serve' }, as(who))

// V1：没装服务时一次连接都不建
const eng = await createMacroEngine(engineOpts)
const before = await eng.shareState()
check('V1 没有 serve.json 就是 standalone', before.mode === 'standalone' && !existsSync(serveFile), `${before.mode} / ${before.reason}`)
const first = await remember(eng, '直连写的第一条')
check('V1b 直连照常可写（不装服务不付代价）', eng.shareState !== undefined && !first.refused && factCount() === 1, `库里 ${factCount()} 条`)

// V2：起服务
const srv = await startServe({ ...engineOpts, cwd: ws })
const info = readServeInfo(dataDir)
check('V2 serve.json 落在数据目录', info !== null && info.pid === srv.pid && typeof info.token === 'string', `pid ${info?.pid}`)
const statsRes = await request(info, 'GET', '/stats', undefined, { timeout: 2000 })
check('V2b /stats 带对令牌能读', statsRes.status === 200 && statsRes.json?.pid === srv.pid, `status ${statsRes.status}`)

// V3：经服务写 + requestId 幂等
const w = await remember(eng, '经服务写的一条')
check('V3 经服务写真的进库', w.share?.mode === 'shared' && factCount() === 2, `mode ${w.share?.mode} / 库里 ${factCount()} 条`)
const dupId = 'probe-fixed-request-id'
const body = { requestId: dupId, tool: 'memory_remember', args: { content: '同一条 id 重发', level: 'fact', keywords: ['serve'], importance: 2, project: 'serve' }, cwd: ws, agent: 'codex' }
const r1 = await request(info, 'POST', '/call', body)
const r2 = await request(info, 'POST', '/call', body)
check(
  'V3b requestId 重发只算一次写',
  r1.status === 200 && r2.status === 200 && r2.json?.deduped === true && factCount() === 3,
  `deduped=${r2.json?.deduped} / 库里 ${factCount()} 条`,
)

// V4：两个独立进程各写 200 条（U7）
const child = join(tmp, 'writer.mjs')
writeFileSync(
  child,
  `
import { readFileSync } from 'node:fs'
import http from 'node:http'
const [serveFile, tag] = process.argv.slice(2)
const info = JSON.parse(readFileSync(serveFile, 'utf8'))
const u = new URL(info.url)
const send = (i) => new Promise((resolve, reject) => {
  const payload = Buffer.from(JSON.stringify({
    requestId: tag + '-' + i,
    tool: 'memory_remember',
    args: { content: tag + '-内容-' + i, level: 'fact', keywords: ['serve', tag], importance: 1, project: 'concurrent' },
    agent: tag,
  }))
  const req = http.request({ host: u.hostname, port: Number(u.port), method: 'POST', path: '/call',
    headers: { authorization: 'Bearer ' + info.token, 'content-type': 'application/json', 'content-length': String(payload.length) } },
    (res) => { const c = []; res.on('data', (d) => c.push(d)); res.on('end', () => resolve(res.statusCode)) })
  req.on('error', reject)
  req.write(payload)
  req.end()
})
for (let i = 0; i < 200; i += 1) await send(i)
process.exit(0)
`,
  'utf8',
)
const runWriter = (tag) =>
  new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [child, serveFile, tag], { stdio: ['ignore', 'ignore', 'pipe'] })
    const err = []
    p.stderr.on('data', (d) => err.push(d))
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${tag} exit ${code}: ${Buffer.concat(err).toString()}`))))
  })
const beforeU7 = factCount()
await Promise.all([runWriter('pa'), runWriter('pb')])
const all = contents()
const mine = all.filter((c) => c.startsWith('pa-内容-') || c.startsWith('pb-内容-'))
const distinct = new Set(mine)
check(
  'V4 两进程各写 200 条：400 条不丢不重',
  mine.length === 400 && distinct.size === 400 && factCount() === beforeU7 + 400,
  `新增 ${mine.length} 条 / 去重 ${distinct.size} 种 / 库里 ${factCount()} 条`,
)
const maxQueue = srv.stats().maxQueue
check('V4b 写是排队进的（队列见过峰值）', maxQueue >= 1, `maxQueue ${maxQueue}`)

// V5：令牌不对
const bad = await request({ ...info, token: 'x'.repeat(48) }, 'GET', '/stats', undefined, { timeout: 2000 })
check('V5 令牌不对一律 401', bad.status === 401, `status ${bad.status}`)

// V6：服务被 kill，serve.json 留着 → 不写库、落队列
const snapshot = readServeInfo(dataDir)
await srv.close('probe-simulate-kill')
writeFileSync(serveFile, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8')
const killed = await remember(eng, '服务不在时写的')
check(
  'V6 服务不在：这条没进库',
  killed.share?.mode === 'readonly' && killed.share?.queued === true && !contents().includes('服务不在时写的'),
  `mode ${killed.share?.mode} / pending ${pendingCount(dataDir)}`,
)
check('V6b 回执说清「没写进库」+ 三条路', /没有写进库/.test(String(killed.text)) && /macro-memory serve/.test(String(killed.text)) && /detach/.test(String(killed.text)), String(killed.text).split('\n')[0])
check('V6c 待补交队列里有这一条', pendingCount(dataDir) === 1 && readFileSync(join(dataDir, PENDING_FILE), 'utf8').includes('服务不在时写的'), `pending ${pendingCount(dataDir)}`)

// V7：服务回来 → 补交
const srv2 = await startServe({ ...engineOpts, cwd: ws })
const back = await eng.call('memory_search', { query: '服务不在时写的', k: 20 }, as('codex'))
check(
  'V7 服务回来先补交：库里有了、队列空了',
  back.share?.mode === 'shared' && back.share?.flushed === 1 && contents().includes('服务不在时写的') && pendingCount(dataDir) === 0,
  `flushed ${back.share?.flushed} / pending ${pendingCount(dataDir)}`,
)

// V9：noServe 不被自己的服务截走（serve 内部就是这么调的，否则递归）
const direct = await eng.call('memory_remember', { content: 'noServe 直连', level: 'fact', keywords: ['serve'], importance: 1, project: 'serve' }, { ...as('codex'), noServe: true })
check('V9 noServe 时即使服务在也直连', direct.share === undefined && !direct.refused, `share=${String(direct.share)}`)

// V10：SSE
const sse = await new Promise((resolve) => {
  const u = new URL(srv2.info.url)
  const req = http.request(
    { host: u.hostname, port: Number(u.port), path: '/events', headers: { authorization: `Bearer ${srv2.token}` } },
    (res) => {
      let buf = ''
      res.on('data', (d) => {
        buf += d.toString()
        if (buf.includes('event: hello')) {
          res.destroy()
          resolve({ status: res.statusCode, buf })
        }
      })
    },
  )
  req.on('error', () => resolve({ status: 0, buf: '' }))
  req.end()
})
check('V10 /events 是 SSE，先来 hello', sse.status === 200 && /^event: hello/m.test(sse.buf), sse.buf.split('\n')[0])

// V8：正常关闭 → 文件消失、端口不再连
const urlBefore = srv2.info.url
await srv2.close('probe-done')
const after = await eng.shareState()
let portDead = false
try {
  await request({ ...srv2.info, token: srv2.token }, 'GET', '/stats', undefined, { timeout: 400 })
} catch {
  portDead = true
}
check('V8 正常关闭后 serve.json 自己消失、回落 standalone', after.mode === 'standalone' && !existsSync(serveFile), `mode ${after.mode}`)
check('V8b 端口不再接受连接', portDead, urlBefore)

await eng.close()
try {
  rmSync(tmp, { recursive: true, force: true })
} catch {
  // Windows 上 SQLite 句柄可能还没放，临时目录留给系统清
}

console.log(`\n合计 ${pass + fail} 条：PASS ${pass} / FAIL ${fail}`)
process.exit(fail === 0 ? 0 : 1)
