#!/usr/bin/env node
/**
 * [macro-fusion 0.6.3] 定序探针——钉住「同一问句，同一答案」。
 *
 * 起因（0.6.3 实测，`E:\Temp\cmp\det.mjs`）：`search()` 的最后一跳是
 * `hits.sort((a, b) => (bandOf.get(a) - bandOf.get(b)) || (b.score - a.score))`——
 * 分数一样时 V8 的稳定排序会**保留语料顺序**，于是同一问句在两套插入顺序下给出两套前十：
 *
 *   原序（40 条同构语料）：t-00,t-01,t-02,t-03,t-04
 *   乱序（seed=1）      ：t-31,t-23,t-28,t-38,t-27
 *
 * 生产里 docs 的顺序不是我们给的：存储层更新会改 rowid、VACUUM 与分页会换顺序，
 * 所以「谁先进库谁在前」等于「结果由存储布局决定」——比排序差一点点严重得多：
 * 对外报的每个读数都只是「抽到的那一次」，同一句话问两遍可能拿到不同记忆。
 *
 * 修法：分档 → 分数 → 更新得更晚的在前 → id 自然序（`D1:2` 排在 `D1:10` 前面）。
 * 四个键全是数据本身的属性，与语料顺序无关；`searchAdaptive` 的自适应 idf 挑簇那一跳
 * 原来按语料下标定序（`|| x - y`），同一把梯子换成 `laterFirst`。
 *
 * 读数（LoCoMo 1,531 问，`tools/bench-locomo.mjs`）：hit@1 0.3932 / hit@5 0.6192 /
 * hit@10 0.6924 / hit@20 0.7511 / MRR 0.4958 / recall@20 0.6322 / 空回 0.0000——
 * 与改前**逐位相同**（id 自然序正好等于语料的时间序，所以这次没有用读数换确定性）。
 *
 * 钉住的七条性质（删掉定序梯子 D3/D4/D8 就会红）：
 *   D1 同一进程连跑 5 次：id 序与分数逐位相同
 *   D3 插入顺序打乱三种（seed 3/11/42）：`search` 前十逐位相同
 *   D4 同上，`searchAdaptive` + `adaptiveIdf`（跨过闸门那一遍）也逐位相同
 *   D5 并列组里「更新得更晚的在前」：改 updated_at 就换人，打乱语料不换人
 *   D6 id 自然序：`D1:2` 先于 `D1:10`（纯码元序会把 10 排到 2 前面）
 *   D7 定序里不许出现 `localeCompare`（locale 随机器/ICU 变，换了机器就换顺序）
 *   D8 能红证明：把定序梯子换回「保留语料顺序」，同一份语料打乱后前十必然不同（在没 import 过真引擎的子进程里量）
 *   D2 跨进程：另起一个 node 进程跑同一份快照，哈希与本进程相同（没有进程内随机态）
 *
 * 用法：node tools/probe-determinism.mjs      （挂进 check-all；零 LLM、不碰真库、不写仓库文件）
 */
import { root } from './_root.mjs'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

let failures = 0
function check(label, ok, extra) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra === undefined || extra === '' ? '' : `  ${extra}`}`)
  if (!ok) failures++
}

const enginePath = join(root, 'vendor', 'meow-memory', 'lib', 'index.js')
const V = await import(pathToFileURL(enginePath).href)
const idsOf = (hits) => hits.map((h) => h.id).join(',')
const sigOf = (hits) => hits.map((h) => `${h.id}:${Number(h.score).toFixed(6)}`).join('|')

// ── 语料：40 条全同构（分数必然大量并列）+ 20 条 nate + 20 条花园 + 300 条灌水（跨 idf 闸门）──
const base = []
for (let i = 0; i < 40; i++) base.push({ id: `t-${String(i).padStart(2, '0')}`, title: '复测', content: '滴定终点读两遍，记在备忘里。', level: 'fact', status: 'active' })
for (let i = 0; i < 20; i++) base.push({ id: `n-${String(i).padStart(2, '0')}`, title: '记录', content: `Nate 第 ${i} 件事：读两遍。`, level: 'fact', status: 'active' })
for (let i = 0; i < 20; i++) base.push({ id: `g-${String(i).padStart(2, '0')}`, title: '记录', content: `花园第 ${i} 株：浇两遍。`, level: 'fact', status: 'active' })
for (let i = 0; i < 300; i++) base.push({ id: `p-${String(i).padStart(3, '0')}`, title: '灌水', content: `无关条目第 ${i} 条，谈的是电路板与焊锡。`, level: 'fact', status: 'active' })
const qs = ['滴定终点读几遍', 'Nate', '两遍', '花园 浇', 'zzzz Nate', '读两遍 备忘']

function shuffle(arr, seed) {
  const a = arr.slice()
  let s = seed >>> 0
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296)
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

// ── D1：同进程重复 5 次 ────────────────────────────────────────────────────────
let repeatOk = true
for (const q of qs) {
  const first = sigOf(V.search(q, base, { k: 10 }))
  for (let r = 0; r < 4; r++) if (sigOf(V.search(q, base, { k: 10 })) !== first) repeatOk = false
}
check('D1 同一进程连跑 5 次：id 序与分数逐位相同', repeatOk)

// ── D3/D4：插入顺序打乱三种 ────────────────────────────────────────────────────
// 一律带 `cache: false`：让每次调用都按传进来的那份顺序重建倒排表。缓存键本身含顺序签名
// （`indexSignature` 是按 docs 顺序算的），所以开着缓存也不至于把两种顺序混成一张表；
// 但这条要钉的是「定序不靠语料顺序」，把缓存变量摘掉才量得干净。
let orderSearch = true
let orderAdaptive = true
let firstDiff = ''
for (const seed of [3, 11, 42]) {
  const shuf = shuffle(base, seed)
  for (const q of qs) {
    if (idsOf(V.search(q, base, { k: 10, cache: false })) !== idsOf(V.search(q, shuf, { k: 10, cache: false }))) {
      orderSearch = false
      if (firstDiff === '') firstDiff = `seed=${seed} q=${q}`
    }
    if (idsOf(V.searchAdaptive(q, base, { k: 10, adaptiveIdf: true, cache: false })) !== idsOf(V.searchAdaptive(q, shuf, { k: 10, adaptiveIdf: true, cache: false }))) {
      orderAdaptive = false
      if (firstDiff === '') firstDiff = `adaptive seed=${seed} q=${q}`
    }
  }
}
check('D3 插入顺序打乱三种：`search` 前十逐位相同（并列不按语料顺序）', orderSearch, firstDiff)
check('D4 同上，`searchAdaptive` + `adaptiveIdf` 的挑簇那一跳也逐位相同', orderAdaptive)

// ── D5：并列组里更新得更晚的在前 ───────────────────────────────────────────────
const twins = [
  { id: 'v-1', title: '复测', content: '滴定终点读两遍，记在备忘里。', level: 'fact', status: 'active', updated_at: 1000 },
  { id: 'v-2', title: '复测', content: '滴定终点读两遍，记在备忘里。', level: 'fact', status: 'active', updated_at: 9000 },
]
const tw = V.search('滴定终点读几遍', twins, { k: 2 })
const twShuf = V.search('滴定终点读几遍', twins.slice().reverse(), { k: 2 })
check('D5 并列时更新得更晚的排前面（与插入顺序无关）', idsOf(tw) === 'v-2,v-1' && idsOf(twShuf) === 'v-2,v-1', idsOf(tw))
check('D5 与 D5 反转语料一致（不是靠插入顺序凑出来的）', idsOf(tw) === idsOf(twShuf))

// ── D6：id 自然序，`D1:2` 先于 `D1:10` ─────────────────────────────────────────
const numIds = [
  { id: 'D1:10', title: '', content: '滴定终点读两遍。', level: 'fact', status: 'active' },
  { id: 'D1:2', title: '', content: '滴定终点读两遍。', level: 'fact', status: 'active' },
]
check('D6 id 自然序：`D1:2` 排在 `D1:10` 前面（纯码元序会反过来）', idsOf(V.search('滴定终点读几遍', numIds, { k: 2 })) === 'D1:2,D1:10', idsOf(V.search('滴定终点读几遍', numIds, { k: 2 })))

// ── D7：定序里不许出现 localeCompare ───────────────────────────────────────────
// localeCompare 的顺序随 ICU/locale 变：同一份记忆在另一台机器上排法就不一样，
// 「同一问句同一答案」这条承诺也就只在当前机器成立。允许的两处是显示分组（不参与检索定序）。
const src = readFileSync(enginePath, 'utf8')
const localeHits = []
const lines = src.split('\n')
for (let i = 0; i < lines.length; i++) {
  const line = lines[i]
  if (!line.includes('localeCompare')) continue
  if (line.includes('bandOf') || line.includes('raw[') || line.includes('cos') || line.includes('fuse')) localeHits.push(i + 1)
}
check('D7 检索定序里没有 localeCompare（显示分组那两处不算）', localeHits.length === 0, localeHits.map((n) => `index.js:${n}`).join(' '))

// ── D8：能红证明——把定序梯子换回「保留语料顺序」────────────────────────────────
// 必须在**没 import 过真引擎的子进程**里量。实测（`E:\Temp\cmp\dbg-red2/4.mjs`）：
// 同一个 `Module._compile` 出来的红模块，裸进程里两套顺序给出 t-00..t-04 / t-31,t-23…，
// 可进程里只要 import 过一次真引擎（哪怕一次 search 都不调用），两套顺序就都变成 t-00..t-04——
// 红线被「同进程里已加载过的那份引擎」悄悄钉死，量出来是假绿。子进程里没有这份状态，才是真读数。
const NEW = 'hits.sort((a, b) => (bandOf.get(a) - bandOf.get(b)) || (b.score - a.score) || (stampOf(a) < stampOf(b) ? 1 : stampOf(a) > stampOf(b) ? -1 : 0) || cmpText(a.id, b.id));'
if (!src.includes(NEW)) {
  check('D8 能红证明：定序梯子还在源码里（能定位到才谈得上「删掉就红」）', false)
} else {
  const redCode = `
import { readFileSync } from 'node:fs'
import Module from 'node:module'
const enginePath = ${JSON.stringify(enginePath)}
const src = readFileSync(enginePath, 'utf8')
const red = new Module('red-det', null)
// 编译时的文件名必须落在引擎自己那一层：源码里的裸包名（\`@deepseek-ai/dsh-llm\` 等）
// 只有从这里出发才解析得到仓库的 node_modules——写成 'red-det.js' 会按 cwd 解析，
// 而 check-all 是在 E:\\Temp\\macro-neutral-cwd-* 里跑每一支的（第一版就是这么红的）。
red.filename = enginePath
red.paths = Module._nodeModulePaths(enginePath.slice(0, enginePath.lastIndexOf('/')))
red._compile(src.replace(${JSON.stringify(NEW)}, 'hits.sort((a, b) => (bandOf.get(a) - bandOf.get(b)) || (b.score - a.score));'), enginePath)
const docs = []
for (let i = 0; i < 40; i++) docs.push({ id: 't-' + String(i).padStart(2, '0'), title: '复测', content: '滴定终点读两遍，记在备忘里。', level: 'fact', status: 'active' })
let s = 1 >>> 0
const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296)
const shuf = docs.slice()
for (let i = shuf.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [shuf[i], shuf[j]] = [shuf[j], shuf[i]] }
const a = red.exports.search('滴定终点读几遍', docs, { k: 5, cache: false }).map((h) => h.id).join(',')
const b = red.exports.search('滴定终点读几遍', shuf, { k: 5, cache: false }).map((h) => h.id).join(',')
process.stdout.write(a === b ? 'SAME ' + a : 'DIFF ' + a + ' ' + b)
`
  let out = ''
  try {
    out = execFileSync(process.execPath, ['--input-type=module', '-e', redCode], { encoding: 'utf8' }).trim()
  } catch (e) {
    out = `ERR ${e.message.slice(0, 120)}`
  }
  const parts = out.split(' ')
  check('D8 能红证明：挖掉定序梯子后，同一语料打乱即换前十（子进程里量）', parts[0] === 'DIFF', parts[0] === 'DIFF' ? `${parts[1].split(',')[0]} ≠ ${parts[2].split(',')[0]}` : out.slice(0, 120))
}

// ── D2：跨进程哈希一致（没有进程内随机态）──────────────────────────────────────
const childCode = `
import { pathToFileURL } from 'node:url'
const V = await import(pathToFileURL(${JSON.stringify(enginePath)}).href)
const docs = []
for (let i = 0; i < 40; i++) docs.push({ id: 't-' + String(i).padStart(2, '0'), title: '复测', content: '滴定终点读两遍，记在备忘里。', level: 'fact', status: 'active' })
for (let i = 0; i < 20; i++) docs.push({ id: 'n-' + String(i).padStart(2, '0'), title: '记录', content: 'Nate 第 ' + i + ' 件事：读两遍。', level: 'fact', status: 'active' })
for (let i = 0; i < 20; i++) docs.push({ id: 'g-' + String(i).padStart(2, '0'), title: '记录', content: '花园第 ' + i + ' 株：浇两遍。', level: 'fact', status: 'active' })
const qs = ['滴定终点读几遍', 'Nate', '两遍', '花园 浇', 'zzzz Nate', '读两遍 备忘']
process.stdout.write(qs.map((q) => V.search(q, docs, { k: 10 }).map((h) => h.id).join(',')).join('||'))
`
const localHash = createHash('sha1').update(qs.map((q) => idsOf(V.search(q, base.slice(0, 80), { k: 10 }))).join('||')).digest('hex').slice(0, 16)
let childHash = ''
try {
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', childCode], { encoding: 'utf8' })
  childHash = createHash('sha1').update(out).digest('hex').slice(0, 16)
} catch (e) {
  childHash = `ERR ${e.message}`
}
check('D2 跨进程哈希与本进程相同（结果里没有进程内随机态）', localHash === childHash, `${localHash} / ${childHash.slice(0, 16)}`)

if (failures === 0) console.log('\nALL PASS  probe-determinism：9/9')
else console.log(`\n${failures} 条没过`)
process.exit(failures === 0 ? 0 : 1)
