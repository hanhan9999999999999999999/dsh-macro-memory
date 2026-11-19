#!/usr/bin/env node
/**
 * accept-live —— 对着**正在运行的** DSH 做只读验收（0.2.24）
 *
 * 跟 probe-load.mjs 的分工：
 *   probe-load  问「装进去的这份能不能被加载」——离线判据，冷启动之前就能问。
 *   accept-live 问「现在跑着的那个进程，到底加载了什么、有没有在跑、有没有报错」——只有运行态能答。
 *
 * 两条都是只读：不写 profile、不 apply 补丁、不启停任何进程、不碰别人的会话。
 * 判红的条件只有两条：宿主不在跑（查不了运行态）、日志里出现指向本插件的 error。
 * 「跑的是旧代码」只报告不判红——重启的节奏归主人，不归探针。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { root } from './_root.mjs'

const home = process.env.DSH_HOME || join(homedir(), '.dsh')
const profileName = process.env.DSH_PROFILE || 'desktop'
const profileDir = join(home, 'profiles', profileName)
const logFile = join(home, 'logs', 'desktop-next.log')
const dataDir = join(home, 'macro-memory')

let fails = 0
const pass = (what, detail) => console.log(`PASS  ${what}${detail ? `：${detail}` : ''}`)
const info = (what, detail) => console.log(`INFO  ${what}${detail ? `：${detail}` : ''}`)
const warn = (what, detail) => console.log(`WARN  ${what}${detail ? `：${detail}` : ''}`)
const fail = (what, detail) => {
  fails += 1
  console.log(`FAIL  ${what}${detail ? `：${detail}` : ''}`)
}

// ── 1. 宿主在不在跑 ────────────────────────────────────────────────────────
// 用日志文件的创建时间当「这次运行的起点」：DSH 每次启动重写 desktop-next.log。
// 用它的最近修改时间当「刚刚还有活动」：查不了这两件之一，运行态就无从谈起。
if (!existsSync(logFile)) {
  fail('找得到 DSH 的运行日志', logFile)
  console.log(`\n结果：${fails} 条失败 —— 没有日志就查不了运行态，别当成「没加载」`)
  process.exit(1)
}
const logStat = statSync(logFile)
const ageMin = (Date.now() - logStat.mtimeMs) / 60000
if (ageMin <= 5) pass('宿主还活着', `日志 ${ageMin.toFixed(1)} 分钟前还有写入`)
else fail('宿主还活着', `日志 ${ageMin.toFixed(0)} 分钟没动了 —— DSH 大概没在跑，运行态查不了`)

// 「这次运行的起点」：不能拿日志文件的创建时间——日志会轮转/重写，那样算出来的起点是
// 上一次轮转的时间（实测过：进程 22:48 起，日志文件 03:37 才建，直接判成「跑的比改动新」）。
// 问操作系统的进程创建时间，问不到就老实说查不到，不猜。
const hostStartedAt = (() => {
  const name = process.env.DSH_LIVE_PROCESS || 'DSH NEXT'
  try {
    const out = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command',
        `$p = Get-Process -Name '${name}' -ErrorAction SilentlyContinue | Sort-Object StartTime | Select-Object -First 1; if ($p) { $p.StartTime.ToUniversalTime().ToString('o') }`],
      { encoding: 'utf8', timeout: 15000 },
    ).trim()
    if (!out) return null
    const t = new Date(out)
    return Number.isNaN(t.getTime()) ? null : t
  } catch {
    return null
  }
})()
if (hostStartedAt) info('这次运行的起点', `${hostStartedAt.toLocaleString()}（宿主进程的创建时间）`)
else info('这次运行的起点', '查不到宿主进程（换个名字可用 DSH_LIVE_PROCESS 指定）——下面两条会因此保守处理')


// 只看尾部，别把几十 MB 的日志整个读进内存
const logText = (() => {
  const size = logStat.size
  const start = Math.max(0, size - 4 * 1024 * 1024)
  const buf = readFileSync(logFile).subarray(start)
  return buf.toString('utf8')
})()

// ── 2. 前端那半截：宿主有没有把我们的 client 产物发给页面 ──────────────────
// DSH 的渲染进程会打印它加载的 bundle 列表（dsh-app://app/plugins/??a/client.js,b/client.js…）。
// 这是运行中的宿主自己说的，不是我们推的。
const clientHit = /dsh-macro-memory\/client\.js/.test(logText)
const rev = (logText.match(/client\.js&rev=([0-9a-f]+)/) || [])[1]
if (clientHit) pass('前端产物在跑着的宿主里', rev ? `bundle 列表 rev=${rev}` : 'bundle 列表里有它')
else fail('前端产物在跑着的宿主里', '日志尾部的 bundle 列表里没有 dsh-macro-memory/client.js')

// ── 3. 服务端那半截：这次运行里有没有真的写过数据 ──────────────────────────
// 注意：没有活动不等于没加载（刚起、没人调工具，本来就不会写）。所以只报告，不判红。
const touched = []
if (hostStartedAt && existsSync(dataDir)) {
  for (const name of readdirSync(dataDir)) {
    const p = join(dataDir, name)
    try {
      const st = statSync(p)
      if (st.isFile() && st.mtimeMs > hostStartedAt.getTime()) touched.push(`${name} ${new Date(st.mtimeMs).toLocaleString()}`)
    } catch { /* 半路被删的竞态，忽略 */ }
  }
}
if (!hostStartedAt) info('服务端代码在这次运行里跑过', '查不到运行起点，这条不猜')
else if (touched.length) pass('服务端代码在这次运行里跑过', touched.join('；'))
else info('服务端代码在这次运行里跑过', `这次运行还没写过 ${dataDir} 里的任何文件（不算错，只是没活动）`)


// ── 4. 有没有报错指向本插件 ────────────────────────────────────────────────
const errLines = logText
  .split(/\r?\n/)
  .filter((l) => /\[error\]/i.test(l) && /macro-memory/i.test(l))
if (errLines.length === 0) pass('日志里没有一条 error 提到本插件')
else fail('日志里没有一条 error 提到本插件', `${errLines.length} 条，第一条：${errLines[0].slice(0, 200)}`)

// ── 5. 跑的是不是现在这份代码（只报告，不判红）──────────────────────────────
// 装了不等于是最新的：DSH 在启动那一刻把插件读进内存，之后改文件不会热更新。
const installedPkg = join(profileDir, 'node_modules', 'dsh-macro-memory', 'package.json')
let installedVersion = '（读不到）'
let installedAt = 0
if (existsSync(installedPkg)) {
  try {
    installedVersion = JSON.parse(readFileSync(installedPkg, 'utf8')).version ?? installedVersion
    installedAt = statSync(installedPkg).mtimeMs
  } catch { /* 读不动就当读不到 */ }
}
const repoPkg = join(root, 'package.json')
const repoVersion = JSON.parse(readFileSync(repoPkg, 'utf8')).version
const newer = []
if (hostStartedAt) {
  for (const dir of ['lib', 'tools', '']) {
    const base = dir ? join(root, dir) : root
    if (!existsSync(base)) continue
    for (const name of readdirSync(base)) {
      const p = join(base, name)
      try {
        const st = statSync(p)
        if (st.isFile() && st.mtimeMs > hostStartedAt.getTime()) newer.push(dir ? `${dir}/${name}` : name)
      } catch { /* 同上 */ }
    }
  }
}
if (!hostStartedAt) {
  info('跑的是不是现在这份代码', `查不到运行起点；装的那份是 ${installedVersion}，本仓是 ${repoVersion}`)
} else if (installedAt > hostStartedAt.getTime() || newer.length) {
  info('跑的是不是现在这份代码', `DSH 这次运行从 ${hostStartedAt.toLocaleString()} 开始，之后本仓有 ${newer.length} 个文件改过；装的那份是 ${installedVersion}，本仓是 ${repoVersion} —— 要看到改动得重启 DSH（不判红：重启归主人）`)
} else {
  pass('跑的是不是现在这份代码', `启动时间 ${hostStartedAt.toLocaleString()} 晚于本仓所有改动，装的是 ${installedVersion}`)
}

console.log(fails === 0 ? '\n结果：运行态验收通过（问的是跑着的那个 DSH 自己）' : `\n结果：${fails} 条失败`)
process.exit(fails === 0 ? 0 : 1)
