#!/usr/bin/env node
/**
 * [macro-fusion 0.6.6] 脏记忆探针——钉住「一条缺字段的条目不许把整次检索打成异常」。
 *
 * 病根（`E:\Temp\cmp\punct-drift.mjs` 扫出来的）：`docText(d)` 原来写的是
 *   `return [d.title ?? "", d.content, ...d.keywords].join(" ");`
 * 于是一条 `keywords` 缺失 / 为 null / 是逗号串的条目，会让 `verbatimInputs` 在遍历时抛
 *   `TypeError: d.keywords is not iterable`
 * 而 `verbatimInputs` 是**每条问句都要过的第一道工序**——不是「少一条」，是整次检索变异常。
 * 老库（导入行、别的插件写的行、调用方自己拼的 docs）里 keywords 的三种坏形状都真实存在：
 * 缺字段、`null`、`"a, b, c"`。同一处还有 `keywordHitScore` 前的 `d.keywords.length`。
 *
 * 这里钉住十三条性质（D8、D13 是能红证明，删掉归一化/入口闸立刻红）：
 *   D1 缺 keywords 的条目不再让多词问句抛异常（回数组，不是 TypeError）
 *   D2 缺 keywords 的条目仍然可被命中（归一化不是「跳过这一条」）
 *   D3 keywords 是逗号串时当词表用（旧数据最常见的形状）
 *   D4 keywords 是 null / 数字 / 对象时既不抛也不凭空命中
 *   D5 一条脏条目混进干净池，干净问句的第一名逐位不变（脏数据不许改写别人的排序）
 *   D6 content 缺失 / 是 null 时既不抛，也不把字面量「undefined」当成词去命中
 *   D7 三条路径（search / searchAdaptive / keywordHitScore）同一批脏 docs 都不抛
 *   D8 能红证明：把 docText 换回 `...d.keywords`，同一问句立刻抛 TypeError（子进程里量）
 *
 * 0.6.7 补一层：坏的不是字段形状，是**元素本身**（数组里一条 null / undefined / 标量）。
 *   D9  数组里混入 null / undefined / 字符串 / 数字：不抛，干净条目的第一名不动
 *   D10 docs 根本不是数组（字符串 / null / 对象）：回空数组，不抛
 *   D11 docs 全是坏行：回空数组（不是「把 null 当一条记忆去打分」）
 *   D12 keywordHitScore / searchAdaptive 同一批带 null 的池同口径
 *   D13 能红证明：把入口闸 `liveDocs` 改成直通 `return docs`，同一问句立刻抛（子进程里量）
 *
 * 用法：node tools/probe-dirty.mjs      （挂进 check-all；零 LLM、不碰真库、不写任何文件）
 */
import { root } from './_root.mjs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readFileSync } from 'node:fs'
import Module from 'node:module'
import { execFileSync } from 'node:child_process'

let total = 0
let failures = 0
function check(label, ok, extra) {
  total++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra === undefined || extra === '' ? '' : `  ${extra}`}`)
  if (!ok) failures++
}

const enginePath = join(root, 'vendor', 'meow-memory', 'lib', 'index.js')
const V = await import(pathToFileURL(enginePath).href)
const idsOf = (hits) => hits.map((h) => h.id).join(',')
const safe = (fn) => {
  try {
    return { ok: true, value: fn() }
  } catch (e) {
    return { ok: false, value: e }
  }
}

// ── 干净池：两条正常条目（带 keywords），用来量「脏条目有没有污染别人」 ────────────
const clean = [
  { id: 'C-a', title: '滴定', content: '滴定终点读两遍，再记一次。', keywords: ['滴定', '终点'], updated_at: 2000 },
  { id: 'C-b', title: '记账', content: '钱要记清楚，别凭印象。', keywords: ['记账', '钱'], updated_at: 1000 },
]
const baselineTop = idsOf(V.search('滴定终点', structuredClone(clean), { k: 5 }).slice(0, 1))

// ── D1 / D2：缺 keywords 的条目 ─────────────────────────────────────────────────
const noKw = { id: 'K-1', title: '滴定', content: '滴定终点读两遍，手别抖。', updated_at: 3000 }
const r1 = safe(() => V.search('滴定终点读两遍', [...structuredClone(clean), noKw], { k: 5 }))
check('D1 缺 keywords 的条目不再把多词问句打成异常', r1.ok, r1.ok ? `${r1.value.length} 条` : String(r1.value).slice(0, 90))
check(
  'D2 缺 keywords 的条目仍然可被命中（归一化不是跳过这一条）',
  r1.ok && r1.value.some((h) => h.id === 'K-1'),
  r1.ok ? idsOf(r1.value) : '(异常)',
)

// ── D3：keywords 是逗号串（旧数据最常见的形状） ───────────────────────────────────
const strKw = { id: 'K-2', title: '花园', content: '记录一条。', keywords: '浇花, 施肥, 换盆', updated_at: 500 }
const r3 = safe(() => V.search('浇花', [...structuredClone(clean), strKw], { k: 5 }))
check('D3 keywords 是逗号串时当词表用（`浇花` 能命中）', r3.ok && r3.value.some((h) => h.id === 'K-2'), r3.ok ? idsOf(r3.value) : String(r3.value).slice(0, 90))

// ── D4：keywords 是 null / 数字 / 对象 ──────────────────────────────────────────
const weirdKws = [
  { id: 'K-3', title: '空', content: '纸上写着九个数字，与别的无关。', keywords: null, updated_at: 10 },
  { id: 'K-4', title: '数', content: '纸上写着九个数字，与别的无关。', keywords: 7, updated_at: 11 },
  { id: 'K-5', title: '物', content: '纸上写着九个数字，与别的无关。', keywords: { a: 1 }, updated_at: 12 },
]
const r4 = safe(() => V.search('那件事', [...structuredClone(clean), ...weirdKws], { k: 5 }))
check(
  'D4 keywords 是 null / 数字 / 对象时既不抛，也不凭空命中',
  r4.ok && r4.value.every((h) => !['K-3', 'K-4', 'K-5'].includes(h.id)),
  r4.ok ? idsOf(r4.value) : String(r4.value).slice(0, 90),
)

// ── D5：脏条目不许改写别人的排序 ────────────────────────────────────────────────
const dirtyPool = [...structuredClone(clean), noKw, strKw, ...weirdKws.map((d) => ({ ...d }))]
const poisonedTop = idsOf(V.search('滴定终点', dirtyPool, { k: 5 }).slice(0, 1))
check('D5 一条脏条目混进干净池，干净问句的第一名逐位不变', poisonedTop === baselineTop, `${baselineTop} → ${poisonedTop}`)

// ── D6：content 缺失 / null ────────────────────────────────────────────────────
const noContent = [
  { id: 'K-6', title: '只有标题', updated_at: 20 },
  { id: 'K-7', title: '空正文', content: null, keywords: [], updated_at: 21 },
]
const r6 = safe(() => V.search('只有标题', [...structuredClone(clean), ...noContent], { k: 5 }))
const undefinedHits = safe(() => V.search('undefined', [...structuredClone(clean), ...noContent], { k: 5 }))
check('D6 content 缺失 / 为 null 时不抛（标题仍可命中）', r6.ok && r6.value.some((h) => h.id === 'K-6'), r6.ok ? idsOf(r6.value) : String(r6.value).slice(0, 90))
check(
  'D6 缺 content 不会把字面量「undefined」变成可检索的词',
  undefinedHits.ok && !undefinedHits.value.some((h) => ['K-6', 'K-7'].includes(h.id)),
  undefinedHits.ok ? idsOf(undefinedHits.value) : String(undefinedHits.value).slice(0, 90),
)

// ── D7：三条路径同一批脏 docs ───────────────────────────────────────────────────
const r7a = safe(() => V.searchAdaptive('滴定终点', dirtyPool, { k: 5, adaptiveIdf: true }))
const r7b = safe(() => V.keywordHitScore('滴定终点', dirtyPool, { k: 5 }))
check('D7 searchAdaptive 与 keywordHitScore 同一批脏 docs 都不抛', r7a.ok && r7b.ok, `${r7a.ok ? 'adapt ok' : 'adapt 异常'} / ${r7b.ok ? 'keyword ok' : 'keyword 异常'}`)

// ── D8：能红证明——把 docText 换回 `...d.keywords`，同一问句立刻抛 TypeError ──────
const RED_SRC = 'return Array.isArray(d.keywords) ? d.keywords : [...d.keywords];'
const src = readFileSync(enginePath, 'utf8')
const kwListSrc = (src.match(/function kwList\(d\) \{[\s\S]*?\n\}/) ?? [''])[0]
const redCode = `
import { readFileSync } from 'node:fs'
import Module from 'node:module'
const enginePath = ${JSON.stringify(enginePath)}
const red = new Module('red-dirty', null)
red.filename = enginePath
red.paths = Module._nodeModulePaths(enginePath.slice(0, enginePath.lastIndexOf('/')))
const oldFn = ${JSON.stringify(kwListSrc)}
const newFn = ${JSON.stringify('function kwList(d) {\n  ' + RED_SRC + '\n}')}
const patched = readFileSync(enginePath, 'utf8').replace(oldFn, newFn)
if (patched === readFileSync(enginePath, 'utf8')) process.stdout.write('PATCH-MISS')
red._compile(patched, enginePath)
const docs = [
  { id: 'C-a', title: '滴定', content: '滴定终点读两遍。', keywords: ['滴定'], updated_at: 1 },
  { id: 'K-1', title: '滴定', content: '滴定终点读两遍，手别抖。', updated_at: 2 },
]
try {
  red.exports.search('滴定终点', docs, { k: 5 })
  process.stdout.write('NO-THROW')
} catch (e) {
  process.stdout.write(String(e && e.message ? e.message : e).slice(0, 60))
}
`
let redOut = ''
try {
  redOut = execFileSync(process.execPath, ['--input-type=module', '-e', redCode], { encoding: 'utf8' }).trim()
} catch (e) {
  redOut = `ERR ${String(e.message).slice(0, 80)}`
}
check('D8 能红证明：把 kwList 换回 `[...d.keywords]` 后同一问句立刻抛「not iterable」（子进程里量）', /not iterable/.test(redOut), redOut)

// ── D9–D12（0.6.7）：坏的是元素本身，不是字段形状 ──────────────────────────────
const dirtyElems = [null, undefined, '滴定', 42, structuredClone(clean[0]), structuredClone(clean[1])]
const r9 = safe(() => V.search('滴定终点', dirtyElems, { k: 5 }))
check('D9 数组里混入 null / undefined / 字符串 / 数字：不抛，且条目仍可命中', r9.ok && r9.value.length > 0, r9.ok ? idsOf(r9.value) : String(r9.value).slice(0, 90))
check(
  'D9 坏元素不许改写干净条目的第一名',
  r9.ok && idsOf(r9.value.slice(0, 1)) === baselineTop,
  r9.ok ? `${baselineTop} → ${idsOf(r9.value.slice(0, 1))}` : '(异常)',
)

const notArrays = ['滴定终点', null, { 0: { id: 'x' }, length: 1 }, 42]
const r10 = notArrays.map((docs) => safe(() => V.search('滴定终点', docs, { k: 5 })))
check(
  'D10 docs 根本不是数组（字符串 / null / 类数组对象 / 数字）：回空数组，不抛',
  r10.every((r) => r.ok && Array.isArray(r.value) && r.value.length === 0),
  r10.map((r) => (r.ok ? `ok(${r.value.length})` : '异常')).join(' / '),
)

const r11 = safe(() => V.search('滴定终点', [null, undefined, null], { k: 5 }))
check('D11 docs 全是坏行：回空数组，不抛', r11.ok && Array.isArray(r11.value) && r11.value.length === 0, r11.ok ? `ok(${r11.value.length})` : '(异常)')

const r12a = safe(() => V.keywordHitScore('滴定终点', dirtyElems, { k: 5 }))
const r12b = safe(() => V.searchAdaptive('滴定终点', dirtyElems, { k: 5 }))
check('D12 keywordHitScore 与 searchAdaptive 同一批带 null 的池同口径（都不抛）', r12a.ok && r12b.ok, `${r12a.ok ? 'keyword ok' : 'keyword 异常'} / ${r12b.ok ? 'adapt ok' : 'adapt 异常'}`)

// ── D13：能红证明——把入口闸改成直通，同一问句立刻抛 ────────────────────────────
const liveSrc = (src.match(/function liveDocs\(docs\) \{[\s\S]*?\n\}/) ?? [''])[0]
const redCode2 = `
import { readFileSync } from 'node:fs'
import Module from 'node:module'
const enginePath = ${JSON.stringify(enginePath)}
const red = new Module('red-null-entry', null)
red.filename = enginePath
red.paths = Module._nodeModulePaths(enginePath.slice(0, enginePath.lastIndexOf('/')))
const oldFn = ${JSON.stringify(liveSrc)}
const newFn = ${JSON.stringify('function liveDocs(docs) {\n  return docs;\n}')}
const patched = readFileSync(enginePath, 'utf8').replace(oldFn, newFn)
if (patched === readFileSync(enginePath, 'utf8')) process.stdout.write('PATCH-MISS')
red._compile(patched, enginePath)
const docs = [null, { id: 'C-a', title: '滴定', content: '滴定终点读两遍。', keywords: ['滴定'], updated_at: 1 }]
try {
  red.exports.search('滴定终点', docs, { k: 5 })
  process.stdout.write('NO-THROW')
} catch (e) {
  process.stdout.write(String(e && e.message ? e.message : e).slice(0, 60))
}
`
let redOut2 = ''
try {
  redOut2 = execFileSync(process.execPath, ['--input-type=module', '-e', redCode2], { encoding: 'utf8' }).trim()
} catch (e) {
  redOut2 = `ERR ${String(e.message).slice(0, 80)}`
}
check('D13 能红证明：把 liveDocs 改成直通 `return docs` 后同一问句立刻抛（子进程里量）', /null|undefined/i.test(redOut2) && !/NO-THROW|PATCH-MISS/.test(redOut2), redOut2)

console.log(failures === 0 ? `\nALL PASS  probe-dirty：${total}/${total}` : `\n${failures} 条失败（共 ${total}）`)
process.exit(failures === 0 ? 0 : 1)
