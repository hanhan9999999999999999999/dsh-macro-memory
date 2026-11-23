#!/usr/bin/env node
/**
 * [macro-fusion 0.6.4] 单字问句探针——钉住「一个汉字进来，不许因为分词粒度变成『没有』」。
 *
 * 病根（`E:\Temp\cmp\edge.mjs` 扫出来的，`single.mjs` 定到根）：
 * 本文件 `tokenize` 的中日韩那一段只产出**二元组**（`vendor/meow-memory/lib/index.js:1660-1663`
 * 的 `if (run.length >= 2)`），于是一个汉字的问句切出来是空数组：
 *   `tokenize('读')` → `[]`     而 `tokenize('读两遍')` → `['读两','两遍']`
 * `search` 的第一道门 `if (q.length === 0 && idents.length === 0) return []` 于是直接空手：
 * 「读」「钱」「花」这类最直白的问法，库里明明白白写着，回执永远是空的。
 * 这和 0.6.2 修的是同一族病——那条治「剔词剔空」，这条治「压根切不出词」；两条合起来才守得住
 * 「回执不全 ≠ 库里没有」：不许把「有」说成「没有」。
 *
 * 处方（窄到只治这一件事）：只有当问句切不出任何词、且问句本身是**单个汉字**时，按原文子串
 * 在 title/content/keywords 里数命中次数（NFKC + 小写），分数交回 `bandize` 的四把钥匙定序。
 * 只放单字、不放任意短串：两个汉字以上本来就能切，英文单字（`the`/`a`）做子串才是真噪声——
 * `tools/probe-gold.mjs` 的 G8「没有的事就空手」就是专门抓这个的。
 *
 * 这里钉住九条性质（都是行为断言，删掉兜底 L1/L2/L6/L7/L8 立刻红）：
 *   L1 单字中文问句不再空手，且每条命中真的含那个字
 *   L2 只写在 keywords 里的字也认（兜底不是只扫 content）
 *   L3 英文停用词仍然空手（`the`/`a` 一个都不许放进来）
 *   L4 纯标点 / 纯空白 / 空串仍然空手
 *   L5 定序不看插入顺序，并列时「更新得更晚的在前」，k 仍然生效
 *   L6 三条检索路径（search / searchAdaptive / keywordHitScore）同口径
 *   L7 能红证明：挖掉兜底后同一问句回空（在子进程里量）
 *   L8 库里没有的字仍然空手
 *
 * 用法：node tools/probe-literal.mjs      （挂进 check-all；零 LLM、不碰真库、不写任何文件）
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
const sortedIds = (hits) => hits.map((h) => String(h.id)).sort().join(',')

// ── 合成语料：`读` 落两条双胞胎（只有 updated_at 不同，用来量并列定序）；
//    `花` 只写在 keywords 里（验证兜底扫的不只是 content）；`鲸` 全库没有 ────────────
const docs = [
  { id: 'L-a', title: '实验', content: '滴定终点读两遍，再记一次。', updated_at: 1000 },
  { id: 'L-b', title: '实验', content: '滴定终点读两遍，收工。', updated_at: 9000 },
  { id: 'L-c', title: '记账', content: '钱要记清楚，别凭印象。', updated_at: 500 },
  { id: 'L-d', title: '花园', content: '记录一条。', keywords: ['花', '花园'], updated_at: 100 },
  { id: 'L-e', title: '其它', content: '这段与那件事无关。', updated_at: 100 },
]

// ── L1 / L2：单字不再空手，且命中真的有那个字 ───────────────────────────────────
const du = V.search('读', structuredClone(docs), { k: 5 })
const hayOf = (h) => `${h.title ?? ''} ${h.content ?? ''} ${Array.isArray(h.keywords) ? h.keywords.join(' ') : String(h.keywords ?? '')}`
check('L1 单字中文问句不再空手（`读` → 非空）', du.length > 0, `${du.length} 条`)
check('L1 每条命中真的含那个字（不是拿别的条目凑数）', du.length > 0 && du.every((h) => hayOf(h).includes('读')), idsOf(du))

const hua = V.search('花', structuredClone(docs), { k: 5 })
check('L2 只写在 keywords 里的字也认（`花` → L-d）', idsOf(hua) === 'L-d', idsOf(hua) || '(空)')

// ── L3 / L4：闸门必须是「一个码点 + 汉字」，不是「短」 ────────────────────────────
// `the` 会被停用词吃掉，英文单字做子串匹配就是纯噪声——那正是 G8 要抓的硬凑。
const en = [
  { id: 'E-a', title: 'note', content: 'the a an of to be', updated_at: 1 },
  { id: 'E-b', title: 'note', content: 'Console 由 Nate 持有。', updated_at: 2 },
]
const theHits = V.search('the', structuredClone(en), { k: 5 })
const aHits = V.search('a', structuredClone(en), { k: 5 })
check('L3 英文停用词仍然空手（`the` / `a` 都是 0 条）', theHits.length === 0 && aHits.length === 0, `the=${theHits.length} a=${aHits.length}`)

const punct = V.search('。', structuredClone(docs), { k: 5 })
const blank = V.search('   ', structuredClone(docs), { k: 5 })
const empty = V.search('', structuredClone(docs), { k: 5 })
check('L4 纯标点 / 纯空白 / 空串仍然空手', punct.length === 0 && blank.length === 0 && empty.length === 0, `。=${punct.length} 空格=${blank.length} 空串=${empty.length}`)

// ── L5：定序不看插入顺序；并列时「更新得更晚的在前」；k 仍然生效 ──────────────────
const rev = V.search('读', structuredClone(docs).reverse(), { k: 5 })
check('L5 定序不看插入顺序（反转语料逐位相同）', idsOf(rev) === idsOf(du), `${idsOf(du)} | ${idsOf(rev)}`)
check('L5 并列时「更新得更晚的在前」（L-b 9000 先于 L-a 1000）', idsOf(du).split(',')[0] === 'L-b', idsOf(du))
check('L5 k 仍然生效（k=1 只回 1 条）', V.search('读', structuredClone(docs), { k: 1 }).length === 1)

// ── L6：三条路径同口径（不许一个打分器认单字、另一个不认）────────────────────────
const viaAdaptive = V.searchAdaptive('读', structuredClone(docs), { k: 5, adaptiveIdf: true })
const viaKeyword = typeof V.keywordHitScore === 'function' ? V.keywordHitScore('读', structuredClone(docs), { k: 5 }) : []
check(
  'L6 三条路径同口径：search / searchAdaptive / keywordHitScore 命中集合相同',
  viaAdaptive.length > 0 && viaKeyword.length > 0 && sortedIds(viaAdaptive) === sortedIds(du) && sortedIds(viaKeyword) === sortedIds(du),
  `${sortedIds(du)} | ${sortedIds(viaAdaptive)} | ${sortedIds(viaKeyword)}`,
)

// ── L7：能红证明——挖掉兜底，同一问句立刻回空 ────────────────────────────────────
// 在**子进程**里量（`docs/INTERNAL.md` 9.202.5 的教训：同进程只要 import 过真引擎，
// 某些红模块会被那份已加载的引擎悄悄钉死，量出来是假绿）。编译文件名必须落在引擎自己那一层，
// 否则源码里的裸包名会按 check-all 的中性 cwd 解析而报 ERR_MODULE_NOT_FOUND。
const src = readFileSync(enginePath, 'utf8')
const PATCHED = 'return literalFallback(query, docs, opts);'
if (!src.includes(PATCHED)) {
  check('L7 能红证明：兜底调用还在源码里（能定位到才谈得上「删掉就红」）', false)
} else {
  const redCode = `
import { readFileSync } from 'node:fs'
import Module from 'node:module'
const enginePath = ${JSON.stringify(enginePath)}
const src = readFileSync(enginePath, 'utf8')
const red = new Module('red-lit', null)
red.filename = enginePath
red.paths = Module._nodeModulePaths(enginePath.slice(0, enginePath.lastIndexOf('/')))
red._compile(src.split(${JSON.stringify(PATCHED)}).join('return [];'), enginePath)
const docs = [
  { id: 'L-a', title: '实验', content: '滴定终点读两遍，再记一次。', updated_at: 1000 },
  { id: 'L-b', title: '实验', content: '滴定终点读两遍，收工。', updated_at: 9000 },
  { id: 'L-d', title: '花园', content: '记录一条。', keywords: ['花', '花园'], updated_at: 100 },
]
const one = red.exports.search('读', docs, { k: 5 })
const two = red.exports.search('花', docs, { k: 5 })
process.stdout.write(one.length + ',' + two.length)
`
  let out = ''
  try {
    out = execFileSync(process.execPath, ['--input-type=module', '-e', redCode], { encoding: 'utf8' }).trim()
  } catch (e) {
    out = `ERR ${e.message.slice(0, 120)}`
  }
  check('L7 能红证明：挖掉兜底后 `读` / `花` 都回空（子进程里量）', out === '0,0', out)
}

// ── L8：不凭空编——库里没有的字仍然空手 ──────────────────────────────────────────
const whale = V.search('鲸', structuredClone(docs), { k: 5 })
check('L8 库里没有的字仍然空手（`鲸` → 0 条）', whale.length === 0, `${whale.length} 条`)

console.log(failures === 0 ? `\nALL PASS  probe-literal：${total}/${total}` : `\n${failures} 条失败`)
process.exit(failures === 0 ? 0 : 1)
