#!/usr/bin/env node
/**
 * build-dual.mjs — 一次从同一份源长出两个包，并当场验它们是不是同一份。
 *
 * 为什么要有这一支（PLAN §11.1 / P2-2）：
 *   仓库里只有**一份** core（`lib/`、`bin/`、`vendor/`）。但 npm 上要有两个名字：
 *     - `macro-memory`      通用入口（MCP / CLI / core / ui），给 Codex / Claude Code / Cursor；
 *     - `dsh-macro-memory`  DSH 插件与市场条目，DSH 侧照旧装它。
 *   两份 tarball 里的代码必须逐字节同源——「同源」不能靠人记得两边都改，只能靠
 *   一个每次发版都跑的脚本，以及一条会红的判据（`tools/probe-dual.mjs`）。
 *
 * 这个脚本**不改仓库里的任何源文件**：
 *   - 根目录那一份就是 `dsh-macro-memory`（DSH 装载的就是它，位置不能动）；
 *   - 通用包在 `<out>/macro-memory` 里现长出来：按白名单复制 + 把根 package.json 的
 *     version 灌进 `packages/macro-memory/package.json` 这份模板。
 *
 * 用法：
 *   node tools/build-dual.mjs                    # 只看会复制什么、两版包元数据差在哪（不写盘）
 *   node tools/build-dual.mjs --apply            # 真在临时目录里长出来并逐字节校验同源
 *   node tools/build-dual.mjs --apply --out DIR  # 指定落点（目录名要带 macro-memory）
 *   node tools/build-dual.mjs --apply --pack     # 再各跑一次 npm pack，出两个 tarball
 *   node tools/build-dual.mjs --json             # 机器可读
 *
 * 纪律：
 *   - 只往**新建的**临时目录里写；`--out` 要求路径里带 `macro-memory`，且绝不允许
 *     落在仓库内部（否则 sync-trees 会把构建产物同步到装机树，插件体积翻倍）。
 *   - 不删任何已有目录：默认 mkdtemp 新建；`--out` 已存在就直接报错退出。
 *   - 不发包。`--pack` 只出 tarball，`npm publish` 永远是人来按（要凭据，也不该由脚本代劳）。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const argv = process.argv.slice(2)
const APPLY = argv.includes('--apply')
const PACK = argv.includes('--pack')
const JSON_OUT = argv.includes('--json')
const outArg = (argv.find((a) => a.startsWith('--out=')) ?? '').slice('--out='.length)

/** 通用包里要带的东西。多一项就多一份要维护的面；少一项装上去就缺件。 */
const COPY = ['bin', 'lib', 'vendor', 'docs/images', 'docs/MAC.md', 'docs/CHANGELOG.md', 'README.md', 'LICENSE']
/** 不该出现在任何 tarball 里的家底（自检脚本、内部笔记、规划稿）。 */
const FORBIDDEN_IN_TARBALL = ['tools/', 'docs/INTERNAL.md', 'docs/PLAN-UNIVERSAL.md', 'docs/EVAL-CLAIMS.md', 'node_modules/']

const TEMPLATE = path.join(ROOT, 'packages', 'macro-memory', 'package.json')

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

/** 走一棵树，返回相对路径 → sha256（目录本身不进表）。 */
function walk(dir, base = dir, acc = new Map()) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name)
    if (ent.isDirectory()) walk(full, base, acc)
    else if (ent.isFile()) acc.set(path.relative(base, full).split(path.sep).join('/'), sha256(full))
  }
  return acc
}

/** 同源比较：既比内容也比清单——只比交集会漏掉「多出来一个文件」。 */
function compareTree(a, b) {
  const A = walk(a)
  const B = walk(b)
  const onlyA = [...A.keys()].filter((k) => !B.has(k))
  const onlyB = [...B.keys()].filter((k) => !A.has(k))
  const differ = [...A.keys()].filter((k) => B.has(k) && A.get(k) !== B.get(k))
  return { files: A.size, onlyA, onlyB, differ, same: onlyA.length === 0 && onlyB.length === 0 && differ.length === 0 }
}

function fail(msg) {
  if (JSON_OUT) process.stdout.write(`${JSON.stringify({ ok: false, error: msg }, null, 2)}\n`)
  else process.stderr.write(`build-dual：${msg}\n`)
  process.exit(1)
}

/** 落点：默认 mkdtemp；`--out` 必须带 macro-memory 且不在仓库里，且必须不存在。 */
function resolveOut() {
  if (outArg.length === 0) {
    if (!APPLY) return null
    return fs.mkdtempSync(path.join(os.tmpdir(), 'macro-memory-dual-'))
  }
  const abs = path.resolve(outArg)
  if (!path.basename(abs).includes('macro-memory')) fail(`--out 的目录名要带 macro-memory（防手滑把构建产物写进不相干的地方）：${abs}`)
  if (abs === ROOT || abs.startsWith(ROOT + path.sep)) fail(`--out 不能落在仓库里（sync-trees 会把产物同步到装机树）：${abs}`)
  if (fs.existsSync(abs)) fail(`--out 已存在，不覆盖也不删：${abs}`)
  return abs
}

const pkgRoot = readJson(path.join(ROOT, 'package.json'))
if (!fs.existsSync(TEMPLATE)) fail(`找不到通用包模板：${TEMPLATE}`)
const tpl = readJson(TEMPLATE)

// 通用包元数据：模板 + 根版本 + 去掉下划线注释（发布包里不留开发备注）
const universalPkg = { ...tpl, version: pkgRoot.version }
for (const k of Object.keys(universalPkg)) if (k.startsWith('_')) delete universalPkg[k]

// 版本映射：只有两边同一个版本号，才谈得上「一次发版两个包」
const versionOk = universalPkg.version === pkgRoot.version

// 白名单里到底有什么（只统计真实存在的）
const present = COPY.filter((rel) => fs.existsSync(path.join(ROOT, rel)))
const missing = COPY.filter((rel) => !fs.existsSync(path.join(ROOT, rel)))

const report = {
  ok: versionOk && missing.length === 0,
  repoRoot: ROOT,
  out: null,
  version: pkgRoot.version,
  universal: {
    name: universalPkg.name,
    version: universalPkg.version,
    exports: Object.keys(universalPkg.exports ?? {}),
    files: universalPkg.files,
    engines: universalPkg.engines,
    hasDshField: Object.prototype.hasOwnProperty.call(universalPkg, 'dsh'),
  },
  dsh: {
    name: pkgRoot.name,
    version: pkgRoot.version,
    exports: Object.keys(pkgRoot.exports ?? {}),
    hasDshField: Object.prototype.hasOwnProperty.call(pkgRoot, 'dsh'),
  },
  copy: present,
  missing,
  checks: [],
  tarballs: [],
}

function note(name, ok, detail) {
  report.checks.push({ name, ok, detail })
  if (!ok) report.ok = false
}

note('两包同一个版本号', versionOk, `根 ${pkgRoot.version} / 通用 ${universalPkg.version}`)
note('通用包模板的 exports 齐了 PLAN §11.2 那六条', ['.', './core', './mcp', './cli', './ui', './dsh'].every((k) => k in (universalPkg.exports ?? {})), Object.keys(universalPkg.exports ?? {}).join(' '))
note('通用包不带 DSH 插件字段', report.universal.hasDshField === false, 'dsh 字段只属于 dsh-macro-memory')
note('白名单里的东西都在', missing.length === 0, missing.length === 0 ? present.join(' ') : `缺 ${missing.join(' ')}`)

// exports 指向的文件真的存在（装上去 404 是最难查的那种坏）
const exportTargets = Object.entries(universalPkg.exports ?? {})
  .filter(([k]) => k !== './package.json')
  .map(([, v]) => String(v).replace(/^\.\//, ''))
const absentTargets = exportTargets.filter((rel) => !fs.existsSync(path.join(ROOT, rel)))
note('exports 的每个目标文件都存在', absentTargets.length === 0, absentTargets.length === 0 ? exportTargets.join(' ') : `缺 ${absentTargets.join(' ')}`)

if (!APPLY) {
  if (JSON_OUT) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  else {
    process.stdout.write(`源：${ROOT}\n版本：${pkgRoot.version}（两包同一个号）\n`)
    process.stdout.write(`通用包将复制：${present.join('、')}\n`)
    if (missing.length > 0) process.stdout.write(`缺：${missing.join('、')}\n`)
    for (const c of report.checks) process.stdout.write(`${c.ok ? '✓' : '✗'} ${c.name} —— ${c.detail}\n`)
    process.stdout.write('\n只体检没写盘。真长出来加 --apply，要 tarball 再加 --pack。\n')
  }
  process.exit(report.ok ? 0 : 1)
}

const OUT = resolveOut()
report.out = OUT
const UNI = path.join(OUT, 'macro-memory')
fs.mkdirSync(UNI, { recursive: true })

// 1) 按白名单复制（目录递归，文件直拷）
for (const rel of present) {
  const src = path.join(ROOT, rel)
  const dst = path.join(UNI, rel)
  fs.mkdirSync(path.dirname(dst), { recursive: true })
  fs.cpSync(src, dst, { recursive: fs.statSync(src).isDirectory() })
}
// 2) 灌版本号后的通用包 package.json
fs.writeFileSync(path.join(UNI, 'package.json'), `${JSON.stringify(universalPkg, null, 2)}\n`, 'utf8')

// 3) 同源校验：lib / bin / vendor 三棵树逐字节
for (const rel of ['lib', 'bin', 'vendor']) {
  if (!fs.existsSync(path.join(ROOT, rel))) continue
  const cmp = compareTree(path.join(ROOT, rel), path.join(UNI, rel))
  note(`同源：${rel}/ 逐字节一致`, cmp.same, cmp.same
    ? `${cmp.files} 个文件`
    : `只在源 ${cmp.onlyA.length} / 只在产物 ${cmp.onlyB.length} / 内容不同 ${cmp.differ.length}`)
}

// 4) 可选：出 tarball（不起发布，只打包）
if (PACK) {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  for (const [label, cwd] of [['dsh-macro-memory', ROOT], ['macro-memory', UNI]]) {
    const res = spawnSync(npm, ['pack', '--pack-destination', OUT, '--json'], { cwd, encoding: 'utf8', shell: true })
    if (res.status !== 0) {
      note(`${label} 打得出 tarball`, false, String(res.stderr ?? '').trim().split('\n').slice(-3).join(' | '))
      continue
    }
    let files = []
    let file = ''
    try {
      const parsed = JSON.parse(String(res.stdout).trim())
      files = parsed[0]?.files?.map((f) => f.path) ?? []
      file = parsed[0]?.filename ?? ''
    } catch {
      note(`${label} 打得出 tarball`, false, 'npm pack 的输出不是 JSON')
      continue
    }
    report.tarballs.push({ label, file, files: files.length })
    note(`${label} 打得出 tarball`, file.length > 0, `${file}（${files.length} 个文件）`)
    const leaked = files.filter((f) => FORBIDDEN_IN_TARBALL.some((bad) => f === bad.replace(/\/$/, '') || f.startsWith(bad)))
    note(`${label} 的 tarball 不带自检家底`, leaked.length === 0, leaked.length === 0 ? '干净' : `漏了 ${leaked.slice(0, 6).join(', ')}`)
  }
}

if (JSON_OUT) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
else {
  process.stdout.write(`落点：${OUT}\n版本：${pkgRoot.version}\n`)
  for (const c of report.checks) process.stdout.write(`${c.ok ? '✓' : '✗'} ${c.name} —— ${c.detail}\n`)
  if (report.tarballs.length > 0) process.stdout.write(`tarball：${report.tarballs.map((t) => t.file).join('、')}\n`)
  process.stdout.write(`\n${report.ok ? '两包同源、版本对齐。' : '有判据红了，别发。'}发版仍要人来按：npm publish 要有凭据。\n`)
}
process.exit(report.ok ? 0 : 1)
