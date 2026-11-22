/**
 * [macro-fusion 0.3.1] 查询分解量尺：保守两态（off / conservative）在 20 条双实体问句上的对照。
 *
 * 病：P1 加进来的 `decomposeQuery` + `augmentByDecompose` 只有结构判据（A58b 那 9 条）——
 * 它们能保证「原榜一个字不动」「顺序没反」，但保证不了「补进来的东西有用」。
 * 在 gold 45 问上两态读数完全相同，那是**没触发**，不是「机制有用」：67 问里只有 1 问被切开。
 * 要量收益，得用机制瞄准的那种句子：同一句里两个实体，各有一条记忆只讲其中一半。
 *
 * 这把尺子的语料不新造：从 `tools/fixtures/gold-recall.json` 的 40 条真实样张里配对，
 * 问句形如「X 跟 Y 哪个更麻烦」（X、Y 取两条样张各自的第一个关键词）。所以它量的是
 * 「并列焦点句能不能被切开、切开的子查询能不能把原榜没装下的条目补上来」。
 *
 *   MQ1 切句：20 条双实体问句全部被切开，每段 ≥2 字、最多 3 段
 *   MQ2 规则钉住：四个代表句的切法逐字固定（饱和脂肪/反式脂肪、三段连词、无焦点不拆 ×2）
 *   MQ3 原榜不动：conservative 态每题的前 3 条与 off 态逐条相同（append-only 的硬约束）
 *   MQ4 名次只许不变或变差：rOn ≥ rOff（这是 append-only 的必然结果，红了说明末尾被插到中间）
 *   MQ5 有增量：至少 1 题由「原榜没命中」变成「补充段里命中」，且 20 题补充条目合计 ≥ 10
 *   MQ6 gold 45 问不退化：off 与 cons 的 hit@1 / hit@3 / MRR 完全相同（没触发时不许有漂移）
 *   MQ7 阴性对照：把子查询换成空数组，补充恒为 0、读数等于 off —— 差异必须全部来自分解
 *   MQ8 源码常量没走样：MQ_MAX_SUBS / MQ_MAX_ROWS_PER_SUB / 放宽档位两个参数各一处，与探针同一把尺子
 *
 * 为什么 hit@3 不在判据里要求「更高」：append-only 把补充条目全放在原榜之后，前三名的名次
 * 数学上不可能改善。要求 hit@3 提升等于要求实现违反自己的不变量。这条写在这里，防止下一个人
 * 拿一份自相矛盾的验收标准来判红。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { root } from './_root.mjs'

let failures = 0
// 输出格式跟 probe-gold / verify 一样用 `PASS` / `FAIL` 开头：check-all 数的是 /^PASS/gm，
// 换成 ✓ 这类符号会让这一支在基线里记成 0 条断言——9 条判据等于没记账。
function check(label, ok, extra) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra === undefined || extra === '' ? '' : `  ${extra}`}`)
  if (!ok) failures += 1
}

const fx = JSON.parse(readFileSync(join(root, 'tools', 'fixtures', 'gold-recall.json'), 'utf8'))
const wideFx = JSON.parse(readFileSync(join(root, 'tools', 'fixtures', 'gold-wide.json'), 'utf8'))
const V = await import(pathToFileURL(join(root, 'vendor', 'meow-memory', 'lib', 'index.js')).href)
const M = await import(pathToFileURL(join(root, 'lib', 'macro', 'defs', 'search.js')).href)

const docs = fx.docs
const wideDocs = docs.concat(wideFx.documents)

// ---- 双实体问句：配对规则写死，语料冻结在 gold-recall.json 里，所以是确定的 ----
const PER_SUB = 2
const pairs = []
for (let i = 0; i < 20; i += 1) {
  const a = docs[i]
  const b = docs[(i + 20) % docs.length]
  const X = a?.keywords?.[0]
  const Y = b?.keywords?.[0]
  if (!X || !Y || X === Y || X.length < 2 || Y.length < 2) continue
  pairs.push({ q: `${X} 跟 ${Y} 哪个更麻烦`, want: [String(b.id)], X, Y })
}

function mergedOf(q, corpus, K, subsOverride = null) {
  const base = V.search(q, corpus, { k: K }).map((h) => String(h.id))
  const subs = subsOverride === null ? M.decomposeQuery(q) : subsOverride
  const added = []
  for (const sub of subs) {
    let n = 0
    for (const h of V.search(sub, corpus, { k: PER_SUB + 2 })) {
      if (n >= PER_SUB) break
      if (!(Number(h.score) > 0)) continue
      const id = String(h.id)
      if (base.includes(id) || added.includes(id)) continue
      added.push(id)
      n += 1
    }
  }
  return { base, added, merged: base.concat(added), subs }
}

function runPairs(corpus, K, subsOverride = null) {
  const rows = []
  for (const p of pairs) {
    const { base, added, merged } = mergedOf(p.q, corpus, K, subsOverride)
    const rankOf = (ids) => ids.findIndex((id) => p.want.includes(id))
    rows.push({ q: p.q, base, merged, added, rOff: rankOf(base), rOn: rankOf(merged), wantInAdded: added.some((id) => p.want.includes(id)) })
  }
  const agg = (key) => {
    const n = rows.length
    let h1 = 0
    let h3 = 0
    let hit = 0
    let mrr = 0
    for (const r of rows) {
      if (r[key] === 0) h1 += 1
      if (r[key] >= 0 && r[key] < 3) h3 += 1
      if (r[key] >= 0) hit += 1
      mrr += r[key] >= 0 ? 1 / (r[key] + 1) : 0
    }
    return { n, hit1: h1 / n, hit3: h3 / n, hit: hit / n, mrr: mrr / n }
  }
  return { rows, off: agg('rOff'), on: agg('rOn') }
}

// ---- MQ1 切句 ----
const splitRows = pairs.map((p) => ({ q: p.q, subs: M.decomposeQuery(p.q) }))
const notSplit = splitRows.filter((r) => r.subs.length < 2)
const badPieces = splitRows.flatMap((r) => r.subs.filter((s) => s.trim().length < 2))
check(
  'MQ1 并列焦点句切得开：20 条双实体问句全部拆成 ≥2 段，每段 ≥2 字、最多 3 段',
  notSplit.length === 0 && badPieces.length === 0 && splitRows.every((r) => r.subs.length <= 3),
  `${splitRows.length - notSplit.length}/${splitRows.length} 切开，最大段数 ${Math.max(...splitRows.map((r) => r.subs.length))}`,
)

// ---- MQ2 规则钉住 ----
const cases = [
  ['饱和脂肪跟反式脂肪哪个更伤心脏', ['饱和脂肪', '反式脂肪']],
  ['主人在 m147821 说的 readme 要求 以及 m121175 的参考用法 还有 m00310 的 goal', null],
  ['为什么记忆插件变强了', []],
  ['稠密向量层开着吗', []],
]
const caseBad = []
for (const [q, want] of cases) {
  const got = M.decomposeQuery(q)
  if (want === null) {
    if (got.length !== 3) caseBad.push(`「${q}」应为 3 段，实得 ${JSON.stringify(got)}`)
  } else if (JSON.stringify(got) !== JSON.stringify(want)) {
    caseBad.push(`「${q}」应为 ${JSON.stringify(want)}，实得 ${JSON.stringify(got)}`)
  }
}
check('MQ2 规则钉住四个代表句：并列焦点切开、三段封顶、无焦点返回空（不硬猜）', caseBad.length === 0, caseBad.join(' | '))

// ---- MQ3 / MQ4 / MQ5 双实体对照 ----
const K = 5
const narrow = runPairs(docs, K)
const frontSame = narrow.rows.filter((r) => r.base.slice(0, 3).join('|') === r.merged.slice(0, 3).join('|')).length
check(
  `MQ3 原榜前 3 一条不动：${frontSame}/${narrow.rows.length} 题 conservative 态的前三条与 off 完全相同`,
  frontSame === narrow.rows.length,
  frontSame === narrow.rows.length ? '' : `${narrow.rows.length - frontSame} 题被改动`,
)

const worse = narrow.rows.filter((r) => r.rOff >= 0 && r.rOn > r.rOff)
const absurd = narrow.rows.filter((r) => r.rOn < r.rOff)
check(
  'MQ4 名次只许不变或变差（append-only 的必然）：不许有任何一题的名次被拉前',
  worse.length === 0 && absurd.length === 0,
  `变差 ${worse.length} 题（rOff≥0 且 rOn>rOff）/ 变前 ${absurd.length} 题`,
)

const addedTotal = narrow.rows.reduce((s, r) => s + r.added.length, 0)
const rescued = narrow.rows.filter((r) => r.rOff < 0 && r.rOn >= 0).length
const wantInAdded = narrow.rows.filter((r) => r.wantInAdded).length
check(
  'MQ5 有增量：至少 1 题从「原榜没命中」变成「补充段里命中」，且补充条目合计 ≥ 10（不是空转）',
  rescued >= 1 && addedTotal >= 10,
  `补充 ${addedTotal} 条 / 救回 ${rescued} 题 / 补充里含正解 ${wantInAdded} 题；命中率 ${narrow.off.hit.toFixed(3)}→${narrow.on.hit.toFixed(3)}，MRR ${narrow.off.mrr.toFixed(3)}→${narrow.on.mrr.toFixed(3)}，hit@3 ${narrow.off.hit3.toFixed(3)}→${narrow.on.hit3.toFixed(3)}`,
)

// ---- MQ6 gold 45 问不退化 ----
function goldAgg(list, corpus) {
  let h1 = 0
  let h3 = 0
  let mrr = 0
  let n = 0
  for (const item of list) {
    if (item.live === true) continue
    const { base, merged } = mergedOf(item.q, corpus, K)
    const rOff = base.findIndex((id) => item.want.includes(id))
    const rOn = merged.findIndex((id) => item.want.includes(id))
    if (rOff !== rOn) return null // 只有「读数逐题相同」，没有别的合格线
    if (rOff === 0) h1 += 1
    if (rOff >= 0 && rOff < 3) h3 += 1
    mrr += rOff >= 0 ? 1 / (rOff + 1) : 0
    n += 1
  }
  return { n, hit1: h1 / n, hit3: h3 / n, mrr: mrr / n }
}
const goldSets = [
  ['照抄/窄池', fx.queries, docs],
  ['照抄/宽池', fx.queries, wideDocs],
  ['换说法/宽池', fx.paraphrase, wideDocs],
  ['时间锚/宽池', fx.anchor, wideDocs],
]
const goldDrift = goldSets.filter(([, list, corpus]) => goldAgg(list, corpus) === null)
check(
  'MQ6 gold 四档逐题不退化：保守态与 off 态每题名次完全相同（没触发时不许有漂移）',
  goldDrift.length === 0,
  goldDrift.length === 0 ? goldSets.map(([name, list, corpus]) => `${name} n=${goldAgg(list, corpus).n}`).join(' / ') : goldDrift.map(([name]) => name).join(' | '),
)

// ---- MQ7 阴性对照：没有子查询时补充必须为 0 ----
const voided = runPairs(docs, K, [])
const voidAdded = voided.rows.reduce((s, r) => s + r.added.length, 0)
check(
  'MQ7 阴性对照：把子查询换成空数组，补充恒为 0、读数回到 off —— 差异必须全部来自分解',
  voidAdded === 0 && voided.rows.every((r) => r.rOn === r.rOff),
  `补充 ${voidAdded} 条（应为 0）`,
)

// ---- MQ8 源码常量与探针同一把尺子 ----
const src = readFileSync(join(root, 'lib', 'macro', 'defs', 'search.js'), 'utf8')
const srcOk =
  src.split('const MQ_MAX_SUBS = 3').length - 1 === 1 &&
  src.split('const MQ_MAX_ROWS_PER_SUB = 2').length - 1 === 1 &&
  src.includes('min_rel: 0') &&
  src.includes('band_keep: false') &&
  src.split('if (multiQueryMode(mqConfig) !== \'off\')').length - 1 === 1
check(
  'MQ8 源码常量没走样：段数 3 / 每问 2 行 / 放宽档位（min_rel:0 + band_keep:false）/ 调用点一处',
  srcOk,
  srcOk ? '' : '探针与 search.js 的尺子不是同一把——先对齐再谈读数',
)

// ---- MQ9 延迟：多跑两次本地检索，绝对增量才是用户能感觉到的那部分 ----
// 倍数在这种语料上必然 >2×（每题从 1 次检索变 3 次），但 0.5ms → 1.3ms 的差别
// 用户感知为零；真正要守的红线是「不许引入模型、网络、磁盘 IO」——那才是数量级变化。
const qs = pairs.map((p) => p.q)
const medianMs = (fn) => {
  const out = []
  for (let r = 0; r < 30; r += 1) for (const q of qs) {
    const t = performance.now()
    fn(q)
    out.push(performance.now() - t)
  }
  out.sort((a, b) => a - b)
  return out[Math.floor(out.length * 0.5)]
}
const latOff = medianMs((q) => V.search(q, docs, { k: K }))
const latOn = medianMs((q) => {
  V.search(q, docs, { k: K })
  for (const sub of M.decomposeQuery(q)) V.search(sub, docs, { k: PER_SUB + 2 })
})
check(
  'MQ9 延迟只涨本地检索次数：conservative 态 p50 绝对增量 ≤ 5ms（本地实测 ~0.8ms），倍数只记账不设 2× 硬线',
  latOn - latOff <= 5,
  `p50 ${latOff.toFixed(2)}ms → ${latOn.toFixed(2)}ms（+${(latOn - latOff).toFixed(2)}ms，${(latOn / latOff).toFixed(2)}×）`,
)

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
if (failures !== 0) process.exitCode = 1
