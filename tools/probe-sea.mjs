#!/usr/bin/env node
/**
 * 单文件二进制的自检（PLAN-UNIVERSAL §11.4 / P2-4）。
 *
 * 它做的事只有一件：**真打一个单文件产物，然后真跑它**。
 *   - 记忆包（MMB1）里的每个文件与仓库里那份逐字节相同；
 *   - 产物能 `--version`、能当 MCP 服务器被握手；
 *   - 包里没有 tools/ 与 docs/（自检家底不许发给用户）；
 *   - mac 的签名公证脚本四步齐全。
 *
 * 为什么不做「Node SEA 支持哪些平台」这类静态判据：那是 Node 的事，问了也不涨信心。
 * 真打一次、真跑一次，一条抵十条。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { root } from './_root.mjs'

const pkg = JSON.parse(fs.readFileSync(join(root, 'package.json'), 'utf8'))
const tmp = fs.mkdtempSync(join(os.tmpdir(), 'macro-sea-'))
const out = join(tmp, 'macro-memory-sea-probe')

let failures = 0
let total = 0
function ok(cond, label, detail) {
  total++
  if (!cond) failures++
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + label + (detail ? '  ' + detail : ''))
}
const sha = (buf) => createHash('sha256').update(buf).digest('hex')

// ── S1 静态：构建脚本的门与防呆 ────────────────────────────────────────────
{
  const src = fs.readFileSync(join(root, 'tools', 'build-sea.mjs'), 'utf8')
  const gated = /flag\('apply'\)/.test(src) && /if \(!apply\)/.test(src)
  const guards = ['目录名里得带 macro-memory', '不能落在仓库里', '已经有东西'].filter((s) => src.includes(s))
  ok(gated && guards.length === 3, 'S1 构建默认不写盘（--apply 才写），三条防呆都在（目录名 / 不许落仓库 / 不删已有目录）', `防呆 ${guards.length}/3`)
  const publishes = /spawnSync\([^)]*'publish'/.test(src) || /args\.includes\('--publish'\)/.test(src)
  ok(!publishes, 'S1b 构建脚本里没有 publish 调用（发包永远人来按）')
}

// ── S2 真打一次（含注入）：产物要真能跑 ───────────────────────────────────
const build = spawnSync(process.execPath, [join(root, 'tools', 'build-sea.mjs'), '--apply', '--out', out, '--json'], {
  cwd: root,
  encoding: 'utf8',
  timeout: 240000,
})
let report = null
try {
  report = JSON.parse(String(build.stdout ?? ''))
} catch {
  report = null
}
ok(build.status === 0 && report?.ok === true, 'S2 真打一个单文件产物（记忆包 → SEA blob → 注入）', report ? `${report.target} · ${(report.bytes / 1048576).toFixed(2)} MB 包` : String(build.stderr ?? '').slice(-300))

const bundleFile = join(out, 'bundle.mmb')
const binFile = report?.binFile ?? join(out, `macro-memory-win-x64.exe`)
const blobFile = join(out, 'sea-prep.blob')

// ── S3 记忆包自洽：manifest 与内容，逐字节对回仓库 ──────────────────────────
{
  const buf = fs.readFileSync(bundleFile)
  const nl1 = buf.indexOf(0x0a)
  const nl2 = buf.indexOf(0x0a, nl1 + 1)
  const magic = buf.subarray(0, nl1).toString('utf8')
  const manifest = JSON.parse(buf.subarray(nl1 + 1, nl2).toString('utf8'))
  const dataStart = nl2 + 1
  const same = manifest.files.filter((f) => {
    const slice = buf.subarray(dataStart + f.offset, dataStart + f.offset + f.size)
    const src = fs.readFileSync(join(root, f.path))
    return sha(slice) === sha(src)
  })
  ok(magic === 'MMB1', 'S3 记忆包有 MMB1 头', magic)
  ok(manifest.files.length >= 180 && same.length === manifest.files.length, 'S3b 包里每个文件与仓库里那份逐字节相同', `${same.length}/${manifest.files.length} 个`)
  ok(manifest.version === pkg.version, 'S3c 包里记的版本与根 package.json 一致', manifest.version)

  const leaked = manifest.files.map((f) => f.path).filter((p) => p.startsWith('tools/') || p.startsWith('docs/') || p.includes('node_modules/'))
  ok(leaked.length === 0, 'S4 包里没有 tools / docs / node_modules（自检家底不发出去）', leaked.length ? leaked.slice(0, 3).join(',') : '干净')
}

// ── S5 blob 与 GUID 注入位置 ───────────────────────────────────────────────
{
  const blobBytes = fs.existsSync(blobFile) ? fs.statSync(blobFile).size : 0
  const bundleBytes = fs.statSync(bundleFile).size
  ok(blobBytes >= bundleBytes, 'S5 SEA 准备包盖住了整个记忆包', `${(blobBytes / 1048576).toFixed(2)} MB vs 包 ${(bundleBytes / 1048576).toFixed(2)} MB`)
  const config = JSON.parse(fs.readFileSync(join(out, 'sea-config.json'), 'utf8'))
  ok(
    path.basename(String(config.main)) === 'sea-entry.cjs' && config.assets?.['bundle.mmb'] && config.disableExperimentalSEAWarning === true,
    'S5b sea-config 指向 CJS 引导器、带上记忆包、关掉实验期警告',
    path.basename(String(config.main)),
  )
}

// ── S6 产物真跑：自报版本 ─────────────────────────────────────────────────
{
  const r = spawnSync(binFile, ['--version'], { encoding: 'utf8', timeout: 180000 })
  ok(r.status === 0 && String(r.stdout ?? '').trim() === pkg.version, 'S6 产物自己报得出正确版本（真正被跑起来，不是看文件大小）', String(r.stdout ?? '').trim() || String(r.stderr ?? '').slice(-200))
}

// ── S7 产物当 MCP 服务器：真握手一次 ──────────────────────────────────────
await (async () => {
  const ws = join(tmp, 'ws')
  fs.mkdirSync(ws, { recursive: true })
  const child = spawn(binFile, ['mcp', '--data-dir', join(tmp, 'data'), '--home-dir', join(tmp, 'home')], {
    cwd: ws,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let buf = ''
  let stderrText = ''
  const messages = []
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (d) => {
    buf += d
    let i = buf.indexOf('\n')
    while (i >= 0) {
      const line = buf.slice(0, i).trim()
      buf = buf.slice(i + 1)
      if (line) {
        try {
          messages.push(JSON.parse(line))
        } catch {
          messages.push({ broken: line })
        }
      }
      i = buf.indexOf('\n')
    }
  })
  child.stderr.on('data', (d) => {
    stderrText += d
  })
  const send = (obj) => child.stdin.write(JSON.stringify(obj) + '\n')
  const waitFor = async (pred, ms = 20000) => {
    const t0 = Date.now()
    while (Date.now() - t0 < ms) {
      const hit = messages.find(pred)
      if (hit) return hit
      await new Promise((r) => setTimeout(r, 20))
    }
    return null
  }

  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'probe-sea', version: '1' } } })
  const init = await waitFor((m) => m.id === 1)
  ok(
    init?.result?.serverInfo?.name === 'macro-memory' && init?.result?.serverInfo?.version === pkg.version,
    'S7 产物当 MCP 服务器握得上手（单文件形态下协议面完整）',
    init?.result?.serverInfo ? `${init.result.serverInfo.name} ${init.result.serverInfo.version}` : String(stderrText).slice(-200),
  )

  send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
  const list = await waitFor((m) => m.id === 2)
  ok(Array.isArray(list?.result?.tools) && list.result.tools.length === 8, 'S7b 工具面在单文件里也是 8 个', `${list?.result?.tools?.length ?? 0} 个`)

  const noise = messages.filter((m) => m.broken)
  ok(noise.length === 0, 'S7c stdout 只有协议报文（噪声会写进 stderr）', noise.length ? noise[0].broken.slice(0, 80) : '零噪声')

  child.stdin.end()
  const code = await new Promise((resolve) => {
    const t = setTimeout(() => resolve('timeout'), 20000)
    child.on('exit', (c) => {
      clearTimeout(t)
      resolve(c)
    })
  })
  ok(code === 0, 'S7d 关掉 stdin 后产物自己退 0', String(code))
})()

// ── S8 校验和文件 ─────────────────────────────────────────────────────────
{
  const sums = fs.readFileSync(join(out, 'SHA256SUMS.txt'), 'utf8').trim()
  const actual = sha(fs.readFileSync(binFile))
  ok(sums === `${actual}  ${path.basename(binFile)}`, 'S8 SHA256SUMS.txt 与产物实际校验和一致', actual.slice(0, 16) + '…')
}

// ── S9 mac 签名公证：四步都在（判据只能验脚本，spctl 通不通只有真机知道）──
{
  const sh = fs.readFileSync(join(root, 'tools', 'sign-mac.sh'), 'utf8')
  const steps = ['codesign --force --options runtime', 'codesign --verify', 'notarytool submit', 'stapler staple', 'spctl -a -vv']
  const missing = steps.filter((s) => !sh.includes(s))
  ok(missing.length === 0, 'S9 mac 签名 + 公证脚本四步齐全（签名 / 自验 / 送公证并钉票 / Gatekeeper 检查）', missing.length ? '缺：' + missing.join('、') : `${steps.length} 步`)
  ok(!/Apple_ID_PASSWORD|NOTARY_PASSWORD=/.test(sh), 'S9b 凭据不写死在脚本里（走 keychain profile）')
}

// ── S10 引导器：CJS、校验包头、归一 argv ──────────────────────────────────
{
  const src = fs.readFileSync(join(root, 'tools', 'sea-entry.cjs'), 'utf8')
  ok(/getAsset\(/.test(src) && /'MMB1'/.test(src), 'S10 引导器从自身取包并校验 MMB1 头', 'CJS')
  ok(/argv\[1\] === process\.execPath/.test(src), 'S10b 引导器归一抹平 SEA 的 argv（argv[1] 就是 exe 自己，直接 slice(2) 会少一个参数）')
  ok(/tmpdir\(\)/.test(src) && /macro-memory-sea-/.test(src), 'S10c 解包到临时目录并按包哈希分目录（同一版只解一次）')
}

try {
  fs.rmSync(tmp, { recursive: true, force: true })
} catch {
  // Windows 上偶尔 EPERM：收尾噪音，不影响判据
}

console.log(failures === 0 ? `ALL PASS  probe-sea：${total}/${total}` : `FAILED  ${failures} 条红`)
process.exit(failures === 0 ? 0 : 1)
