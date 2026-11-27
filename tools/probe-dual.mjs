/**
 * 验收：双包（PLAN-UNIVERSAL §11.1、§11.2 / P2-2）。
 *
 * 检的是「两个包名背后是不是同一份东西，以及发版这件事有没有被人偷偷自动化」：
 *   D1  `macro-memory/core` 真的存在：`lib/core/index.js` 把 core 面摆到门口（≥40 个导出）
 *   D2  `macro-memory/mcp` 真的能起：`lib/mcp/stdio.js` 的 versionOf() 与根 package.json 同一个号
 *   D3  通用包模板的 `exports` 齐了 PLAN §11.2 那六条，且每个目标文件都在
 *   D4  两包分工不混：通用包不带 `dsh` 字段，DSH 包带着 `dsh` 与 `cordis.patch.yml`
 *   D5  **同源**：从同一份源长出来的通用包，`lib` / `bin` / `vendor` 与根逐字节一致
 *   D6  **版本映射**：产物里的版本 = 根的版本（模板里写的是 0.0.0，靠脚本灌，靠这条盯）
 *   D7  装上去能 import：`macro-memory/core`、`/mcp`、`/ui` 三个子路径都解析得了
 *   D8  两份 tarball 都打得出来，且都不带自检家底（tools/ 与内部笔记）
 *   D9  防手滑：`--out` 落在仓库里会被拒（构建产物一旦进仓库，sync-trees 会把它同步到装机树）
 *   D10 不发包：脚本里没有 `publish` 调用——发版要有凭据，这一步必须由人来按
 *
 * 全部在临时目录里做，不碰真实库，也不动仓库里的文件。
 * 用法：node tools/probe-dual.mjs
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { root } from './_root.mjs'

const mod = (p) => import(pathToFileURL(join(root, p)).href)

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

const tmp = mkdtempSync(join(tmpdir(), 'macro-dual-'))
const pkgRoot = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const tplPath = join(root, 'packages', 'macro-memory', 'package.json')

// D1 core 面：门口摆着的东西够不够用
const core = await mod('lib/core/index.js')
const coreKeys = Object.keys(core)
check(
  'D1 core 面把装配、归属、共享三组都摆出来',
  coreKeys.length >= 40 && ['createMacroEngine', 'buildVisibility', 'startServe', 'discover', 'ensureTrust'].every((k) => k in core),
  `${coreKeys.length} 个导出`,
)

// D2 MCP 入口：版本号只有一个来源
const stdio = await mod('lib/mcp/stdio.js')
check(
  'D2 MCP 入口自报的版本与根 package.json 一致',
  typeof stdio.startMcp === 'function' && stdio.versionOf() === pkgRoot.version,
  `${stdio.versionOf()} vs ${pkgRoot.version}`,
)

// D3 模板 exports
const tpl = JSON.parse(readFileSync(tplPath, 'utf8'))
const wanted = ['.', './core', './mcp', './cli', './ui', './dsh']
const missingKeys = wanted.filter((k) => !(k in (tpl.exports ?? {})))
const missingFiles = Object.entries(tpl.exports ?? {})
  .filter(([k]) => k !== './package.json')
  .map(([, v]) => String(v).replace(/^\.\//, ''))
  .filter((rel) => !existsSync(join(root, rel)))
check(
  'D3 通用包 exports 齐了六条，且每个目标文件都在',
  missingKeys.length === 0 && missingFiles.length === 0,
  missingKeys.length === 0 && missingFiles.length === 0 ? wanted.join(' ') : `缺键 ${missingKeys.join(',')} / 缺文件 ${missingFiles.join(',')}`,
)

// D4 两包分工
const rootHasDsh = Object.prototype.hasOwnProperty.call(pkgRoot, 'dsh') && existsSync(join(root, 'cordis.patch.yml'))
const tplHasDsh = Object.prototype.hasOwnProperty.call(tpl, 'dsh')
check('D4 dsh 字段只在 DSH 包那一边', rootHasDsh && !tplHasDsh, `根有 dsh=${rootHasDsh} / 通用包有 dsh=${tplHasDsh}`)

// D5 / D6 / D8：真构建一次（带打包）
const out = join(tmp, 'macro-memory-dual-probe')
const res = spawnSync(process.execPath, [join(root, 'tools', 'build-dual.mjs'), '--apply', '--pack', '--json', `--out=${out}`], {
  cwd: root,
  encoding: 'utf8',
})
let rep = null
try {
  rep = JSON.parse(String(res.stdout).trim())
} catch {
  rep = null
}
const checks = rep?.checks ?? []
const unified = (name) => checks.find((c) => c.name === name)
check(
  'D5 同源：lib / bin / vendor 三棵树逐字节一致',
  ['lib', 'bin', 'vendor'].every((t) => unified(`同源：${t}/ 逐字节一致`)?.ok === true),
  ['lib', 'bin', 'vendor'].map((t) => `${t}:${unified(`同源：${t}/ 逐字节一致`)?.detail ?? '缺失'}`).join(' · '),
)
const uniPkg = existsSync(join(out, 'macro-memory', 'package.json'))
  ? JSON.parse(readFileSync(join(out, 'macro-memory', 'package.json'), 'utf8'))
  : null
const placeholderKept = /^0\.0\.0$/.test(String(tpl.version))
check(
  'D6 版本映射：产物版本 = 根的版本（模板留的是占位，不是手填的版本）',
  uniPkg?.version === pkgRoot.version && placeholderKept,
  `产物 ${uniPkg?.version} / 根 ${pkgRoot.version} / 模板 ${tpl.version}`,
)

// D7 装上去能 import：拿产物当 node_modules 里的一个包
let importOk = false
let importDetail = ''
try {
  const nm = join(tmp, 'app', 'node_modules')
  mkdirSync(nm, { recursive: true })
  symlinkSync(join(out, 'macro-memory'), join(nm, 'macro-memory'), 'junction')
  const probeFile = join(tmp, 'app', 'import-probe.mjs')
  writeFileSync(
    probeFile,
    [
      "export * as core from 'macro-memory/core'",
      "export * as mcp from 'macro-memory/mcp'",
      "export * as ui from 'macro-memory/ui'",
      '',
    ].join('\n'),
    'utf8',
  )
  const m = await import(pathToFileURL(probeFile).href)
  importOk = typeof m.core.createMacroEngine === 'function' && typeof m.mcp.startMcp === 'function' && typeof m.ui.startUi === 'function'
  importDetail = `core ${Object.keys(m.core).length} 导出 / mcp ${Object.keys(m.mcp).length} / ui ${Object.keys(m.ui).length}`
} catch (err) {
  importDetail = String(err?.message ?? err)
}
check('D7 子路径 import 真解析得了（core / mcp / ui）', importOk, importDetail)

// D8 tarball
const tarballs = rep?.tarballs ?? []
const tgzNames = tarballs.map((t) => t.file)
const tarOk = tarballs.length === 2 && tgzNames.every((f) => existsSync(join(out, f)))
let leak = ''
if (tarOk) {
  for (const f of tgzNames) {
    const tar = spawnSync('tar', ['-tzf', join(out, f)], { encoding: 'utf8' })
    if (tar.status === 0) {
      const bad = String(tar.stdout)
        .split('\n')
        .filter((l) => /package\/tools\/|package\/docs\/(INTERNAL|PLAN-UNIVERSAL|EVAL-CLAIMS)\.md/.test(l))
      if (bad.length > 0) leak += `${f}:${bad.length} `
    }
  }
}
check('D8 两份 tarball 都出得来，且不带自检家底', tarOk && leak.length === 0, tarOk ? tgzNames.join('、') + (leak ? ` · 漏 ${leak}` : ' · 干净') : '打包失败')

// D9 防手滑：--out 落在仓库里必须被拒
const bad = spawnSync(process.execPath, [join(root, 'tools', 'build-dual.mjs'), '--apply', `--out=${join(root, 'dist-macro-memory')}`], {
  cwd: root,
  encoding: 'utf8',
})
check('D9 构建产物不许落在仓库里（--out 在仓库内直接拒）', bad.status !== 0 && /不能落在仓库里/.test(String(bad.stderr)), String(bad.stderr).trim().split('\n')[0] ?? '')

// D11/D12 `--out` 两种写法都得认：`--out DIR` 与 `--out=DIR`。
// 为什么单列两条：`release.yml` 里写的是**空格形式**，而脚本曾经只认等号形式——参数被静默
// 忽略后产物落进 mkdtemp，紧接着 `ls -l "$RUNNER_TEMP/macro-memory-dual"` 找不到目录，
// 发版 job 必红。本机撞不上（手打的是等号形式），所以用「已存在的目录必须被拒」这种便宜
// 判据把它钉住：一旦参数没被解析到，脚本会走 mkdtemp 正常退出、status 是 0。
const taken = join(tmp, 'taken-macro-memory')
mkdirSync(taken, { recursive: true })
const spaced = spawnSync(process.execPath, [join(root, 'tools', 'build-dual.mjs'), '--apply', '--out', taken], {
  cwd: root,
  encoding: 'utf8',
})
check(
  'D11 `--out DIR`（空格形式）被认出来，不是静默走默认落点',
  spaced.status !== 0 && /--out 已存在/.test(String(spaced.stderr)) && String(spaced.stderr).includes(taken),
  String(spaced.stderr).trim().split('\n')[0] || `exit=${spaced.status}`,
)
const eqForm = spawnSync(process.execPath, [join(root, 'tools', 'build-dual.mjs'), '--apply', `--out=${taken}`], {
  cwd: root,
  encoding: 'utf8',
})
check(
  'D12 `--out=DIR`（等号形式）同样被认出',
  eqForm.status !== 0 && /--out 已存在/.test(String(eqForm.stderr)),
  String(eqForm.stderr).trim().split('\n')[0] || `exit=${eqForm.status}`,
)

// D10 不发包
const src = readFileSync(join(root, 'tools', 'build-dual.mjs'), 'utf8')
check(
  'D10 脚本里没有 publish 调用（发版要人来按）',
  !/spawnSync\([^)]*'publish'/.test(src) && !/args\.includes\('--publish'\)/.test(src),
  '只打包，不发布',
)

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILED'}  probe-dual：${pass}/${pass + fail}`)
try {
  const { rmSync } = await import('node:fs')
  rmSync(tmp, { recursive: true, force: true })
} catch {
  // Windows 上偶发 EPERM，不影响结论
}
process.exit(fail === 0 ? 0 : 1)
