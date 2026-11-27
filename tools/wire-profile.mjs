/**
 * 把 dsh-macro-memory 接进 profile：改两个文件，只做最小改动。
 *
 *   1. package.json 的 dsh.profile.bundles：
 *        - 去掉 "meow-memory"
 *        - 去掉 "dsh-memory-nebula"
 *        - 在原位置插入 "dsh-macro-memory"
 *   2. cordis.patch.yml：
 *        - 删掉 - id: memory-nebula（原 nebula bundle 的覆盖行）
 *        - 删掉两条 - id: meow-memory（历史遗留的覆盖行）
 *        - 插入一条 - id: macro-memory，带 meow 的配置
 *
 * 为什么必须删干净：patch 层指向不存在 id 的条目会让日志持续报
 * `patch: entry "<id>" not found`（这个 profile 2026-11-13 就踩过一次）。
 *
 * 用法：
 *   node tools/wire-profile.mjs --status     只打印当前状态，不改
 *   node tools/wire-profile.mjs --apply      执行（幂等）
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

// [macro-fusion 0.9.0] 这里原来写死 `D:/dsh-home/profiles/desktop`。
//   换一台机器跑（CI 的 Linux runner 就是一台）→ readFileSync 抛 ENOENT → exit 1，
//   probe-tools 的冒烟判据跟着红，而 detail 里只有一句「exit=1」，看不出是路径问题。
//   改成：先认 DSH_HOME，没有就看 D:/dsh-home 在不在（主人机器的布局），
//   再没有就退到 `~/.dsh`。真没有 profile 时——只读模式明说「没得接」并 exit 0，
//   只有真要写的人（--apply）才拿到 exit 1。
const DSH_HOME = process.env.DSH_HOME
  ?? (existsSync('D:/dsh-home') ? 'D:/dsh-home' : join(homedir(), '.dsh'))
const PROFILE = join(DSH_HOME, 'profiles', 'desktop')
const PKG = join(PROFILE, 'package.json')
const PATCH = join(PROFILE, 'cordis.patch.yml')
const OLD_BUNDLES = ['meow-memory', 'dsh-memory-nebula']
const NEW_BUNDLE = 'dsh-macro-memory'
const MACRO_ROW = [
  '# 2026-11-18: meow-memory 与 dsh-memory-nebula 各复制一份并入 dsh-macro-memory',
  '# （两份代码原样并列、未融合）。原两个 bundle 已从 dsh.profile.bundles 移除，',
  '# 它们在这里的覆盖条目一并删除，避免 patch: entry not found。',
  '- id: macro-memory',
  "  name: 'dsh-macro-memory'",
  '  disabled: false',
  '  config:',
  '    meow:',
  '      homeDir: dsh-storage',
  '      reflectTurns: 5',
  '      promptLang: zh',
  '      delegate:',
  '        model: ""',
  '        effort: ""',
  '    nebula: {}',
  '',
].join('\n')

// [macro-fusion 0.9.0] 不带参数就该是只读。原来写成 `status = argv.includes('--status')`，
//   于是 `node tools/wire-profile.mjs` 一句不带参数的调用会**直接改盘**——注释里写的是
//   「--status 只打印，--apply 执行」，代码和注释是反的。现在只有显式 `--apply` 才写。
const wantApply = process.argv.includes('--apply')
const status = !wantApply
if (!existsSync(PKG) || !existsSync(PATCH)) {
  console.log(`这台机器上没有这个 profile（找的是 ${PROFILE}）。`)
  console.log(wantApply
    ? '没有 DSH 安装就没得接——--apply 退出 1，什么都没写。'
    : '只读模式：没有 DSH 安装就没得接，跳过（exit 0）。')
  process.exit(wantApply ? 1 : 0)
}
const pkgText = readFileSync(PKG, 'utf8').replace(/^\uFEFF/, '')
const manifest = JSON.parse(pkgText)
const bundles = manifest?.dsh?.profile?.bundles ?? []
console.log('bundles:', bundles.join(', '))
const patchText = readFileSync(PATCH, 'utf8')
const eol = patchText.includes('\r\n') ? '\r\n' : '\n'
console.log('patch eol:', eol === '\r\n' ? 'CRLF' : 'LF')
for (const id of ['memory-nebula', 'meow-memory', 'macro-memory']) {
  const n = patchText.split(`- id: ${id}`).length - 1
  console.log(`patch rows for ${id}: ${n}`)
}
if (status) process.exit(0)

// ── package.json ────────────────────────────────────────────────────────────
const next = bundles.filter((name) => !OLD_BUNDLES.includes(name))
if (!next.includes(NEW_BUNDLE)) {
  const anchor = next.indexOf('dsh-better-sidebar')
  next.splice(anchor < 0 ? next.length : anchor + 1, 0, NEW_BUNDLE)
}
manifest.dsh.profile.bundles = next
writeFileSync(PKG, JSON.stringify(manifest, null, 2) + '\n', 'utf8')
console.log('package.json ->', next.join(', '))

// ── cordis.patch.yml ───────────────────────────────────────────────────────
const lf = patchText.replace(/\r\n/g, '\n')
const blocks = [
  '- id: memory-nebula\n  disabled: false\n',
  "- id: meow-memory\n  name: 'meow-memory'\n  config:\n    promptLang: zh\n    homeDir: dsh-storage\n",
  '- id: meow-memory\n  disabled: false\n  config:\n    homeDir: dsh-storage\n    reflectTurns: 5\n    promptLang: zh\n    delegate:\n      model: ""\n      effort: ""\n',
]
let work = lf
for (const block of blocks) {
  const n = work.split(block).length - 1
  console.log(`removing block (${n} match): ${JSON.stringify(block.slice(0, 40))}`)
  work = work.split(block).join('')
}
// 清掉可能留下的连续空行
work = work.replace(/\n{3,}/g, '\n\n')
if (!work.includes('- id: macro-memory')) {
  const anchor = '- id: browserskill\n'
  const at = work.indexOf(anchor)
  if (at < 0) throw new Error('anchor "- id: browserskill" not found in cordis.patch.yml')
  work = work.slice(0, at) + MACRO_ROW + work.slice(at)
}
const outPatch = eol === '\r\n' ? work.replace(/\n/g, '\r\n') : work
writeFileSync(PATCH, outPatch, 'utf8')
console.log('cordis.patch.yml written')
