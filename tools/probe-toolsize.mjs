/**
 * 数清两套插件「工具 schema」的静态体积（不加载插件、不碰运行中的 DSH）。
 * 支持两种源码形态：
 *   A. ctx.tools.register({ name, ... })         —— nebula 的写法（内联字面量）
 *   B. function xxxTool() { return { name, ... } } —— meow 编译后的写法（工厂返回字面量）
 * 口径（0.2.126 起分两本账）：
 *   · schema = parameters + output 两段（真正投影进宿主上下文的那部分），**受预算管**；
 *   · 整字面量 = 连 render 闭包、局部引用一起数，只当「粗胖警戒线」，不看小波动。
 * 分开的理由：0.2.126 的 render 去重让 memory_search 的字面量长了 1.3 KB，schema 一个字节
 * 没动——拿字面量当判据，会把「改实现」误判成「塞描述」，人就开始抬上界。
 * 描述文本若走 i18n（T("key")）则不计入，需另看 prompts/*.md。
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

/** schema 字节：parameters + output 两段（写进宿主上下文的就是这两段）。 */
function schemaOf(block) {
  const pi = block.indexOf('parameters:')
  if (pi < 0) return -1
  const params = cutObject(block, block.indexOf('{', pi))
  let out = ''
  const oi = block.indexOf('output:', pi)
  if (oi > 0) out = cutObject(block, block.indexOf('{', oi))
  return Buffer.byteLength(params + out, 'utf8')
}

const allRows = []

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
    const schemaBytes = schemaOf(block)
    if (schemaBytes < 0) continue
    rows.push({ name, bytes: Buffer.byteLength(block, 'utf8'), schema: schemaBytes, form: 'register' })
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
    const schemaBytes = schemaOf(block)
    if (schemaBytes < 0) continue
    rows.push({ name, bytes: Buffer.byteLength(block, 'utf8'), schema: schemaBytes, form: 'factory' })
  }

  allRows.push(...rows)
  const total = rows.reduce((a, r) => a + r.bytes, 0)
  const schemaTotal = rows.reduce((a, r) => a + r.schema, 0)
  console.log('== ' + label + '：' + rows.length + ' 个工具，schema 合计 ' + schemaTotal + ' B，整字面量 ' + total + ' B')
  for (const r of rows) console.log('   ' + r.name.padEnd(22) + 'schema ' + String(r.schema).padStart(6) + ' B · 字面量 ' + String(r.bytes).padStart(6) + ' B  (' + r.form + ')')
  return schemaTotal
}

const a = scan(vendorDir + '/meow-memory/lib/index.js', 'meow-memory')
const b = scan(vendorDir + '/dsh-memory-nebula/lib/index.js', 'memory-nebula')
const sum = a + b
const literalSum = allRows.reduce((acc, r) => acc + r.bytes, 0)
console.log('\n合计 = schema ' + sum + ' B（' + (sum / 1024).toFixed(1) + ' KB）· 整字面量 ' + literalSum + ' B')
console.log('粗估 token：混合中英按 3.5–4 字符/token → 约 ' + Math.round(sum / 4 / 1000) + '–' + Math.round(sum / 3.5 / 1000) + ' K token')
console.log('注：JSON 化后含 key 引号与转义，线上体积略大于此值；不含宿主附加字段；i18n 描述（T("key")）另计。')
console.log('※ 这是 0.1.x「拼接态」的下界基线（17 个原工具，未做 i18n 描述与 JSON 开销）；')
console.log('  0.2.x 融合后对外只注册 8 个工具：原始参数 4,714 B（verify.mjs A 段），')
console.log('  宿主 projectToolSchema 投影后 11,544 B（tools/probe-host.mjs D2，上限 16,000）。')

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
// 上界不是等号：设成「今天的实测值」时，任何一次正当改动都会踩线（0.2.85 只加了
// importanceWeight 一个字段 + 排序表达式改长，就 87,419 > 87,326）。留 ~5% 余量：
// 判据要抓的是「悄悄长胖」（有人塞一段长描述、多开十个参数），不是「代码有变化」。
// [macro-fusion 0.2.123] 上界从 92,000 抬到 94,000：memory_search 新增了 context 参数
// （输入 1 行 + 输出 1 行 + render 两行 + execute 里的窗口取值），实测 16,083 → 17,023 B。
// 这是「加了一个真功能」，不是「有人塞了一段长描述」——但为了让两者以后还分得开，
// 再加一道单项护栏：最大的那个工具自己也有上界，总量涨了必须能指到是哪个工具涨的。
// [0.2.126] 判据的量从「整字面量」换成「schema」：render 实现变了，schema 没变，就不该红。
// 实测（0.2.126）：schema 合计 21,973 B（meow 16,415 + 星图 5,558），memory_search 单项 5,927 B。
// 上界留 ~9% 余量抓「悄悄长胖」，不是等于实测值。
const BUDGET_BYTES = 24000
// [0.2.167] 6500 → 7500：memory_search 新增 band_keep（一整个参数：类型 + 默认值 + 描述，
// 统一工具与 meow 原工具各一份），实测 5,927 → 6,852 B。抬上界按老规矩只给实测值加 ~9.5%，
// 不按「反正还没到合计线」随口放宽——上界贴着实测值才抓得住下一次悄悄长胖。
const TOOL_BUDGET = { memory_search: 7500 }
// 整字面量只当粗胖警戒线（含 render 闭包、局部引用）：真有人塞一段长代码时它也拦得住。
// 105,000 → 106,000（0.2.170）：疑问框架剥离要在 explain 里说清「改过你的问法」，实测 105,156，
// 超 0.15%。这条线本来就不看小波动，为 156 B 去删一句可追溯性话反而本末倒置。
const LITERAL_CEIL = 106000


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
ok(sum <= BUDGET_BYTES, '体积：17 个工具 schema 合计没有膨胀', sum + ' B ≤ ' + BUDGET_BYTES + ' B')
ok(literalSum <= LITERAL_CEIL, '体积：整字面量（含 render 闭包）没到粗胖线', literalSum + ' B ≤ ' + LITERAL_CEIL + ' B')
// 单项护栏：合计算的是两套引擎的总账；总账一轮就抬 2,000 B 太粗，涨了多少得指到具体工具。
for (const name of Object.keys(TOOL_BUDGET)) {
  const hit = allRows.find((r) => r.name === name)
  ok(hit !== undefined && hit.schema <= TOOL_BUDGET[name],
    '体积：单项 schema ' + name + ' 没有膨胀',
    hit ? hit.schema + ' B ≤ ' + TOOL_BUDGET[name] + ' B' : '没有这个工具')
}

console.log(failures === 0 ? 'ALL PASS' : 'FAILURES: ' + failures)
if (failures !== 0) process.exitCode = 1
