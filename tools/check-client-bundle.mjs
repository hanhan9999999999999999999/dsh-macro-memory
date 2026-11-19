/**
 * 校验 lib/client.js（浏览器侧组合产物）的关键结构。
 *
 * 为什么单独写一个脚本：build.mjs 是纯文本拼接，产物里同时有
 * 「重复执行守卫」和三段 load，任何一次误改都可能让某个 load 静默消失。
 * 这里逐项断言，缺一项就退出码非 0。
 *
 * 用法：node tools/check-client-bundle.mjs [目标文件]
 */
import { root } from './_root.mjs'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'

const target = process.argv[2] ? resolve(process.argv[2]) : join(root, 'lib', 'client.js')
const text = readFileSync(target, 'utf8')
const bytes = Buffer.byteLength(text, 'utf8')

const loadCalls = [...text.matchAll(/window\.__ModuleLoader__\.load\(\{/g)].length
const loadIds = [...text.matchAll(/window\.__ModuleLoader__\.load\(\{\s*id:\s*['"]([^'"]+)['"]/g)].map((m) => m[1])

const checks = [
  ['守卫存在 __macroGuarded', text.includes('__macroGuarded')],
  ['守卫识别 duplicate factory registration', text.includes('duplicate factory registration')],
  ['守卫注在第一个 load 之前', text.indexOf('__macroGuarded') < text.indexOf('window.__ModuleLoader__.load({')],
  ['load 调用共 3 处', loadCalls === 3],
  ['注册 id：meow 子层', loadIds.includes('dsh-macro-memory-meow')],
  ['注册 id：nebula 子层', loadIds.includes('dsh-macro-memory-nebula')],
  ['注册 id：组合层', loadIds.includes('dsh-macro-memory')],
  ['组合层 require 两个子模块', text.includes("require('dsh-macro-memory-meow')") && text.includes("require('dsh-macro-memory-nebula')")],
  ['设置命名空间探测仍在', text.includes('SETTINGS_NS_CANDIDATES')],
  ['无未替换的 meow 原 id', !/window\.__ModuleLoader__\.load\(\{\s*id:\s*['"]meow-memory['"]/.test(text)],
  ['无未替换的 nebula 原 id', !/window\.__ModuleLoader__\.load\(\{\s*id:\s*['"]dsh-memory-nebula['"]/.test(text)],
]

let failed = 0
for (const [label, ok] of checks) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`)
  if (!ok) failed += 1
}

const sha256 = createHash('sha256').update(text, 'utf8').digest('hex')
console.log(`\n${target}`)
console.log(`  ${bytes} B / sha256 ${sha256}`)
console.log(`  load ids: ${loadIds.join(' / ')}`)
console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
