/**
 * 成本基线：数清两套插件「每轮固定开销」的静态部分。
 * 只读源码，不加载插件、不碰运行中的 DSH。
 *
 * [macro-fusion 0.2.83] 这里原本用的是没导入的 `root`（只 import 了 vendorDir），
 * 和 probe-toolsize 一模一样的烂法——`node --check` 看不出来，只有真跑才炸。
 * 现在取 vendorDir；这属于「手动脚本」账本（tools/manual-tools.mjs），
 * 由 tools/probe-tools.mjs 真跑一遍冒烟。
 */
import { root, vendorDir } from './_root.mjs'
import { existsSync, readFileSync } from 'node:fs'

const meow = readFileSync(vendorDir + '/meow-memory/lib/index.js', 'utf8')
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
// [macro-fusion 0.9.0] 这里原来写死两个本机绝对路径（`D:/document/.../package.json` 与
//   `.../.dsh-meow/memory.db`），而且 `createRequire()` 站在 try 外面。换一台机器跑（CI 的
//   Linux runner 就是一台）直接 `ERR_INVALID_ARG_VALUE('filename', filenameOrURL, …)` 退出 1——
//   probe-tools 的冒烟就是这么红的，detail 里那句 cjs/loader 栈完全看不出是路径的问题。
//   改成从 `root`（本文件所在目录的上一级）算路径：换目录、换盘、换系统都跟着走；
//   库里没有这条数据时只是这一段空着，不影响脚本本身的结论（只读账本该这样）。
import { createRequire } from 'node:module'
import { join } from 'node:path'
const dbPath = join(root, '.dsh-meow', 'memory.db')
let dbInfo = 'sqlite unavailable'
try {
  if (!existsSync(dbPath)) {
    dbInfo = `这个工作区还没有库（${dbPath}），库规模这一段跳过`
  } else {
    const require = createRequire(join(root, 'package.json'))
    const { DatabaseSync } = require('node:sqlite')
    const db = new DatabaseSync(dbPath, { readOnly: true })
    const rows = []
    for (const lvl of ['soul', 'user', 'project', 'fact', 'lesson', 'topic', 'rules']) {
      const r = db.prepare(`select count(*) c, sum(length(content)) n from ${lvl} where status='active'`).get()
      rows.push(`${lvl}:${r.c}/${r.n ?? 0}`)
    }
    dbInfo = rows.join('  ')
    db.close()
  }
} catch (err) {
  dbInfo = 'sqlite error: ' + err.message
}
console.log('meow db active rows/chars =', dbInfo)
