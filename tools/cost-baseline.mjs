/**
 * 成本基线：数清两套插件「每轮固定开销」的静态部分。
 * 只读源码，不加载插件、不碰运行中的 DSH。
 */
import { vendorDir } from './_root.mjs'
import { readFileSync } from 'node:fs'

const meow = readFileSync(root + '/meow-memory/lib/index.js', 'utf8')
const neb = readFileSync(vendorDir + '/dsh-memory-nebula/lib/index.js', 'utf8')

function chars(s) { return [...s].length }

// ── nebula 的常驻 RULE ──────────────────────────────────────────────────────
const ruleMatch = neb.match(/const RULE = \[([\s\S]*?)\]\.join\('\\n'\)/)
let ruleChars = null
if (ruleMatch) {
  const body = ruleMatch[1]
  const lines = [...body.matchAll(/'((?:[^'\\]|\\.)*)'/g)].map((m) => m[1].replace(/\\n/g, '\n').replace(/\\'/g, "'"))
  ruleChars = chars(lines.join('\n'))
}
console.log('nebula RULE chars =', ruleChars)

// ── 工具定义：按 `name: '<x>'` 抓，统计 description 长度 ────────────────────
function tools(src, prefix) {
  const out = []
  const re = new RegExp(`name: ['"](${prefix}[a-z_]*)['"]`, 'g')
  let m
  while ((m = re.exec(src))) out.push(m[1])
  return [...new Set(out)]
}
const meowTools = tools(meow, 'memory_')
const nebTools = tools(neb, 'nebula_')
console.log('meow tools (' + meowTools.length + '):', meowTools.join(', '))
console.log('nebula tools (' + nebTools.length + '):', nebTools.join(', '))

// description 文本总量（粗口径：所有 description: '<...>' 字面量）
function descChars(src) {
  let total = 0, n = 0
  for (const m of src.matchAll(/description:\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"|`([^`]*)`)/g)) {
    const t = m[1] ?? m[2] ?? m[3] ?? ''
    total += chars(t); n++
  }
  return { n, total }
}
const md = descChars(meow), nd = descChars(neb)
console.log('meow description literals =', md.n, 'chars =', md.total)
console.log('nebula description literals =', nd.n, 'chars =', nd.total)

// ── nebula 邻域注入的上限 ───────────────────────────────────────────────────
console.log('nebula inject budget: maxItems=4 maxChars=900 maxRounds=2 (defaults)')
console.log('nebula worst-case dynamic chars =', 900 * 2 + ruleChars)

// ── meow 注入模板里的固定段落 ───────────────────────────────────────────────
const guides = [...meow.matchAll(/\[MEMORY_GUIDE\]|记忆导引|长期记忆|【记忆】/g)].length
console.log('meow inject markers occurrences =', guides)

// ── 当前真实库的规模（meow） ───────────────────────────────────────────────
import { createRequire } from 'node:module'
const require = createRequire('D:/document/DSH Memory Macro-Regulation System/package.json')
let dbInfo = 'sqlite unavailable'
try {
  const { DatabaseSync } = require('node:sqlite')
  const db = new DatabaseSync('D:/document/DSH Memory Macro-Regulation System/.dsh-meow/memory.db', { readOnly: true })
  const rows = []
  for (const lvl of ['soul', 'user', 'project', 'fact', 'lesson', 'topic', 'rules']) {
    const r = db.prepare(`select count(*) c, sum(length(content)) n from ${lvl} where status='active'`).get()
    rows.push(`${lvl}:${r.c}/${r.n ?? 0}`)
  }
  dbInfo = rows.join('  ')
  db.close()
} catch (err) {
  dbInfo = 'sqlite error: ' + err.message
}
console.log('meow db active rows/chars =', dbInfo)
