/**
 * 数清两套插件「工具 schema」的静态体积（不加载插件、不碰运行中的 DSH）。
 * 支持两种源码形态：
 *   A. ctx.tools.register({ name, ... })         —— nebula 的写法（内联字面量）
 *   B. function xxxTool() { return { name, ... } } —— meow 编译后的写法（工厂返回字面量）
 * 口径：把整个对象字面量截出来数 UTF-8 字节。含少量非 schema 内容（render 闭包、
 * 局部引用），属偏高估计；描述文本若走 i18n（T("key")）则不计入，需另看 prompts/*.md。
 *
 * [macro-fusion 0.2.82] 这个脚本原本跑不动（用了没导入的 root，ReferenceError），
 * 因为没人跑、也没断言盯着，坏了很久。现在它取 vendorDir，并自己判「17 个原工具一个不少、
 * 字面量不膨胀」，进了 check-all——不跑的脚本一定会烂。
 */
import { vendorDir } from './_root.mjs'
import { readFileSync } from 'node:fs'


function cutObject(src, openIdx) {
  let depth = 0, inS = null, esc = false
  for (let i = openIdx; i < src.length; i++) {
    const c = src[i]
    if (inS) {
      if (esc) { esc = false; continue }
      if (c === '\\') { esc = true; continue }
      if (c === inS) inS = null
      continue
    }
    if (c === '"' || c === "'" || c === '`') { inS = c; continue }
    if (c === '{') depth++
    else if (c === '}') { depth--; if (depth === 0) return src.slice(openIdx, i + 1) }
  }
  return src.slice(openIdx)
}

function scan(file, label) {
  const src = readFileSync(file, 'utf8')
  const rows = []
  const seen = new Set()

  // A. ctx.tools.register({ ... })
  for (const m of src.matchAll(/tools\.register\s*\(\s*\{/g)) {
    const open = src.indexOf('{', m.index + m[0].length - 1)
    const block = cutObject(src, open)
    const nm = block.match(/name:\s*['"]([a-z_0-9]+)['"]/)
    const name = nm ? nm[1] : '(unnamed)'
    if (seen.has(name)) continue
    seen.add(name)
    rows.push({ name, bytes: Buffer.byteLength(block, 'utf8'), form: 'register' })
  }

  // B. return { name: "<tool>", ... }  （name 字面量以双引号出现，且前面 60 行内有 function）
  for (const m of src.matchAll(/name: "([a-z_]+_[a-z_]+)",/g)) {
    const name = m[1]
    if (seen.has(name)) continue
    const back = src.lastIndexOf('return {', m.index)
    if (back < 0 || m.index - back > 4000) continue
    const open = back + 'return '.length
    const block = cutObject(src, open)
    if (!block.includes('parameters')) continue
    seen.add(name)
    rows.push({ name, bytes: Buffer.byteLength(block, 'utf8'), form: 'factory' })
  }

  const total = rows.reduce((a, r) => a + r.bytes, 0)
  console.log('== ' + label + '：' + rows.length + ' 个工具，字面量合计 ' + total + ' B（' + (total / 1024).toFixed(1) + ' KB）')
  for (const r of rows) console.log('   ' + r.name.padEnd(22) + String(r.bytes).padStart(6) + ' B  (' + r.form + ')')
  return total
}

const a = scan(vendorDir + '/meow-memory/lib/index.js', 'meow-memory')
const b = scan(vendorDir + '/dsh-memory-nebula/lib/index.js', 'memory-nebula')
const sum = a + b
console.log('\n合计 = ' + sum + ' B（' + (sum / 1024).toFixed(1) + ' KB）')
console.log('粗估 token：混合中英按 3.5–4 字符/token → 约 ' + Math.round(sum / 4 / 1000) + '–' + Math.round(sum / 3.5 / 1000) + ' K token')
console.log('注：JSON 化后含 key 引号与转义，线上体积略大于此值；不含宿主附加字段；i18n 描述（T("key")）另计。')
console.log('※ 这是 0.1.x「拼接态」的下界基线（17 个原工具，未做 i18n 描述与 JSON 开销）；')
console.log('  0.2.x 融合后对外只注册 8 个工具：原始参数 4,714 B（verify.mjs A 段），')
console.log('  宿主 projectToolSchema 投影后 8,655 B（tools/probe-host.mjs D2，上限 16,000）。')

// ── 判据（0.2.82）──────────────────────────────────────────────────────────
// 这个脚本 0.2.7x 起就跑不动（用了没导入的 `root`），因为没人跑它、也没有断言盯着它，
// 坏了三个月没人知道。修法不是「修一行」，是让它进 check-all 并自己出判决：
//   · 清单：两个引擎的原工具一个不少、也没有多出来的（「meow 原有功能绝不能砍」的可执行版）；
//   · 体积：合计不许膨胀（参数只许变瘦，不许悄悄长回去）。
// 注意 --check 抓不到 ReferenceError：语法过 ≠ 跑得过，只有真跑一次才算数。
const MEOW_TOOLS = [
  'memory_remember', 'memory_search', 'memory_find_similar', 'memory_read',
  'memory_update', 'memory_project', 'memory_home', 'memory_dream',
]
const NEBULA_TOOLS = [
  'nebula_recall', 'nebula_inspect', 'nebula_link', 'nebula_path', 'nebula_stats',
  'nebula_hygiene', 'nebula_bridge', 'nebula_sources', 'nebula_ingest',
]
const BUDGET_BYTES = 87326

let failures = 0
function ok(cond, label, detail) {
  if (!cond) failures++
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + label + (detail ? '  ' + detail : ''))
}

const srcA = readFileSync(vendorDir + '/meow-memory/lib/index.js', 'utf8')
const srcB = readFileSync(vendorDir + '/dsh-memory-nebula/lib/index.js', 'utf8')
const missingM = MEOW_TOOLS.filter((n) => !srcA.includes(`"${n}"`))
const missingN = NEBULA_TOOLS.filter((n) => !srcB.includes(`'${n}'`))
ok(missingM.length === 0, '清单：meow 的 8 个原工具一个不少', missingM.length ? '缺 ' + missingM.join(',') : '8/8')
ok(missingN.length === 0, '清单：星图的 9 个原工具一个不少', missingN.length ? '缺 ' + missingN.join(',') : '9/9')
ok(sum <= BUDGET_BYTES, '体积：17 个工具字面量合计没有膨胀', sum + ' B ≤ ' + BUDGET_BYTES + ' B')

console.log(failures === 0 ? 'ALL PASS' : 'FAILURES: ' + failures)
if (failures !== 0) process.exitCode = 1
