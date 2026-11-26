#!/usr/bin/env node
/**
 * 单文件二进制构建（PLAN-UNIVERSAL §11.4 / P2-4）。
 *
 * 四种形态，一条命令：
 *   node tools/build-sea.mjs                                  体检：打进去哪些文件、多大、工具在不在
 *   node tools/build-sea.mjs --apply                          真建：记忆包 → SEA blob → 注入 → 产物 + SHA256SUMS
 *   node tools/build-sea.mjs --apply --skip-inject            只到 blob（没网、只想看体积时用）
 *   node tools/build-sea.mjs --apply --target mac-arm64 --node-bin /path/to/node  交叉打
 *
 * 纪律（和 tools/build-dual.mjs 同一套，理由也一样）：
 *   - 默认不写盘，`--apply` 才写；
 *   - 只往不存在的新目录写，**从不删除**任何已有目录；
 *   - 产物不许落在仓库里（`tools/sync-trees.mjs` 的 robocopy /E 会把它同步进装机树，
 *     插件体积凭空翻一倍）；
 *   - **永不 publish**，也不上传任何地方。
 *
 * 为什么不用打包器：SEA 的内嵌主脚本不能 import 外部模块，但 `node:sea` 的 getAsset
 * 能把任意二进制带进可执行文件。所以这里不引打包器、不做 tree-shaking，只把
 * `package.json` + `bin/` + `lib/` + `vendor/` 原样打进一个自定义容器（MMB1），
 * 由 tools/sea-entry.cjs 在运行时解到临时目录再真加载。好处是「打进去的就是仓库里那份」，
 * 一个字节都没被改写。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')

/** 打进单文件的东西：只要运行时要用的四样。tools/docs 是自检家底，不进产物。 */
const INCLUDE = ['package.json', 'bin', 'lib', 'vendor']

/** 产物里不该出现的东西——注错一次就是「把自检脚本发给用户」。 */
const FORBIDDEN_IN_BUNDLE = ['tools/', 'docs/', 'node_modules/', '.git/']

const POSTJECT = 'postject@1.0.0-alpha.6'
const SENTINEL_FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2'
const TARGETS = { 'win-x64': '.exe', 'win-arm64': '.exe', 'linux-x64': '', 'linux-arm64': '', 'mac-arm64': '', 'mac-x64': '' }

const args = process.argv.slice(2)
const flag = (name) => args.includes('--' + name)
const opt = (name) => {
  const i = args.indexOf('--' + name)
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : null
}

const apply = flag('apply')
const skipInject = flag('skip-inject')
const asJson = flag('json')
const notes = []
function note(name, ok, detail) {
  notes.push({ name, ok, detail })
  if (!asJson) console.log((ok ? '  ✓ ' : '  ✗ ') + name + (detail ? '  ' + detail : ''))
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}
const pkg = readJson(path.join(ROOT, 'package.json'))

/** 当前平台对应的 target 名。 */
function hostTarget() {
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
  if (process.platform === 'win32') return 'win-' + arch
  if (process.platform === 'darwin') return 'mac-' + arch
  return 'linux-' + arch
}

/** 产物目录：必须是自己挑的新目录，且不能在仓库里。 */
function resolveOut() {
  const given = opt('out')
  const dir = given
    ? path.resolve(given)
    : fs.mkdtempSync(path.join(os.tmpdir(), 'macro-memory-sea-'))
  if (given && fs.existsSync(dir) && fs.readdirSync(dir).length > 0) {
    throw new Error(`--out 目录已经有东西（${dir}）：换个新目录，这个脚本从不删别人的文件`)
  }
  if (!path.basename(dir).toLowerCase().includes('macro-memory')) {
    throw new Error(`--out 目录名里得带 macro-memory（现在叫 ${path.basename(dir)}）：产物是要发出去的，别混进别的目录`)
  }
  const rel = path.relative(ROOT, dir)
  if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) {
    throw new Error(`--out 不能落在仓库里（${dir}）：tools/sync-trees.mjs 的 robocopy /E 会把产物同步进装机树，体积翻倍`)
  }
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

/** 收集要打进包的文件（相对路径，排序，目录递归）。 */
function collect(rel, acc = []) {
  const abs = path.join(ROOT, rel)
  if (!fs.existsSync(abs)) return acc
  const st = fs.statSync(abs)
  if (st.isDirectory()) {
    for (const name of fs.readdirSync(abs).sort()) collect(rel + '/' + name, acc)
    return acc
  }
  acc.push(rel)
  return acc
}

/** 打 MMB1 容器：`MMB1\n<manifest 单行 JSON>\n` + 各文件内容顺序拼。 */
function makeBundle(files, outFile) {
  const parts = []
  const manifest = { format: 'MMB1', name: pkg.name, version: pkg.version, files: [] }
  let offset = 0
  for (const rel of files) {
    const b = fs.readFileSync(path.join(ROOT, rel))
    manifest.files.push({ path: rel, offset, size: b.length })
    offset += b.length
    parts.push(b)
  }
  const head = Buffer.from('MMB1\n' + JSON.stringify(manifest) + '\n', 'utf8')
  const bundle = Buffer.concat([head, ...parts])
  fs.writeFileSync(outFile, bundle)
  return { manifest, bytes: bundle.length }
}

function sha256(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

function main() {
  const target = opt('target') ?? hostTarget()
  if (!(target in TARGETS)) throw new Error(`不认识的 --target：${target}（可选 ${Object.keys(TARGETS).join(' / ')}）`)
  const ext = TARGETS[target]
  const nodeBin = opt('node-bin') ?? (target === hostTarget() ? process.execPath : null)
  if (!nodeBin) {
    throw new Error(`交叉打 ${target} 得给 --node-bin <那个平台的 node 可执行文件>：注入是往那份二进制里塞东西，不能跨平台借`)
  }
  if (!fs.existsSync(nodeBin)) throw new Error(`--node-bin 不存在：${nodeBin}`)

  const files = INCLUDE.flatMap((rel) => collect(rel))
  const leaked = files.filter((rel) => FORBIDDEN_IN_BUNDLE.some((p) => rel.startsWith(p) || rel.includes('/node_modules/')))
  note('包里只有运行时那四样（tools / docs / node_modules 一律不进产物）', leaked.length === 0, leaked.length ? leaked.slice(0, 3).join(',') : `${files.length} 个文件`)

  const outDir = apply ? resolveOut() : null
  const bundleFile = path.join(outDir ?? os.tmpdir(), 'bundle.mmb')
  const entry = path.join(ROOT, 'tools', 'sea-entry.cjs')
  note('引导器在（tools/sea-entry.cjs，CJS：SEA 内嵌主脚本按 CJS 加载）', fs.existsSync(entry))

  if (!apply) {
    const total = files.reduce((n, rel) => n + fs.statSync(path.join(ROOT, rel)).size, 0)
    note('体检模式（加 --apply 才真建）', true, `${target} · ${files.length} 个文件 · ${(total / 1048576).toFixed(2)} MB`)
    note('注入器：构建期用 npx 取 ' + POSTJECT + '（不进仓库依赖）', true)
    return { ok: notes.every((n) => n.ok), mode: 'dry-run', target, files: files.length, bytes: total }
  }

  const { manifest, bytes } = makeBundle(files, bundleFile)
  note('记忆包打好了（MMB1）', bytes > 0, `${manifest.files.length} 个文件 · ${(bytes / 1048576).toFixed(2)} MB · v${manifest.version}`)

  const configFile = path.join(outDir, 'sea-config.json')
  const blobFile = path.join(outDir, 'sea-prep.blob')
  fs.writeFileSync(
    configFile,
    JSON.stringify({ main: entry, output: blobFile, disableExperimentalSEAWarning: true, assets: { 'bundle.mmb': bundleFile } }, null, 2) + '\n',
    'utf8',
  )
  const sea = spawnSync(process.execPath, ['--experimental-sea-config', configFile], { cwd: outDir, encoding: 'utf8' })
  const blobOk = sea.status === 0 && fs.existsSync(blobFile)
  note('SEA 准备包（node --experimental-sea-config）', blobOk, blobOk ? `${(fs.statSync(blobFile).size / 1048576).toFixed(2)} MB` : String(sea.stderr || sea.error || '').slice(-300))
  if (!blobOk) throw new Error('SEA 准备包没生成：先看上面那句 node 的报错')

  if (skipInject) {
    note('跳过注入（--skip-inject）', true, 'blob 与记忆包都在，注入对人跑')
    return { ok: notes.every((n) => n.ok), mode: 'no-inject', target, outDir, bytes, files: manifest.files.length }
  }

  const binFile = path.join(outDir, `macro-memory-${target}${ext}`)
  fs.copyFileSync(nodeBin, binFile)
  note('复制宿主 node 二进制', true, `${(fs.statSync(binFile).size / 1048576).toFixed(1)} MB`)

  const inject = spawnSync(
    'npx',
    ['--yes', POSTJECT, binFile, 'NODE_SEA_BLOB', blobFile, '--sentinel-fuse', SENTINEL_FUSE],
    { cwd: outDir, encoding: 'utf8', shell: true, timeout: 300000 },
  )
  const injected = inject.status === 0
  note('注入（postject）', injected, injected ? '完成' : String(inject.stderr || inject.error || '').slice(-300))
  if (!injected) throw new Error('注入失败：多半是 npx 取不到 postject（离线）或产物被占用；换 --out 新目录重试')

  // 打完必须自己跑一遍：能自报版本才算产物成立。
  const ver = spawnSync(binFile, ['--version'], { encoding: 'utf8', timeout: 120000 })
  const verText = String(ver.stdout ?? '').trim()
  note('产物能自报版本（macro-memory --version）', ver.status === 0 && verText === pkg.version, verText || String(ver.stderr ?? '').slice(-200))

  const sums = sha256(binFile)
  const sumsFile = path.join(outDir, 'SHA256SUMS.txt')
  fs.writeFileSync(sumsFile, `${sums}  ${path.basename(binFile)}\n`, 'utf8')
  note('SHA256SUMS.txt 与产物同目录', true, sums.slice(0, 16) + '…')

  if (target.startsWith('mac-')) {
    note('mac 产物还要签名 + 公证（不然首次运行被 Gatekeeper 拦）', true, `下一步：tools/sign-mac.sh ${path.basename(binFile)}`)
  }

  return { ok: notes.every((n) => n.ok), mode: 'built', target, outDir, binFile, bytes, files: manifest.files.length, sha256: sums }
}

try {
  const r = main()
  if (asJson) console.log(JSON.stringify({ ...r, notes }, null, 2))
  else if (r.mode === 'built') {
    console.log(`\n产物：${r.binFile}`)
    console.log(`       ${(r.bytes / 1048576).toFixed(2)} MB 记忆包 + 宿主 node`)
    console.log(`校验：SHA256SUMS.txt 就在同一目录（macOS/Linux 用 sha256sum -c，Windows 用 Get-FileHash）`)
  }
  process.exit(r.ok ? 0 : 1)
} catch (err) {
  if (asJson) console.log(JSON.stringify({ ok: false, error: String(err?.message ?? err), notes }, null, 2))
  else {
    console.error('✗ ' + String(err?.message ?? err))
    for (const n of notes) if (!n.ok) console.error('  之前没过的：' + n.name + (n.detail ? ' —— ' + n.detail : ''))
  }
  process.exit(2)
}
