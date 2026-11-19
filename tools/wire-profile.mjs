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
import { readFileSync, writeFileSync } from 'node:fs'

const PROFILE = 'D:/dsh-home/profiles/desktop'
const PKG = `${PROFILE}/package.json`
const PATCH = `${PROFILE}/cordis.patch.yml`
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

const status = process.argv.includes('--status')
const pkgText = readFileSync(PKG, 'utf8')
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
