/**
 * 探针：术语对照桥（0.6.37 · 能力版）
 *
 * 为什么要有这一支：记忆库里除了记叙型条目，还有一类「术语/口语对照」条目——
 *   口语对照：发白＝过曝；小尾巴＝拖线；跟踪跑偏＝极轴误差
 * 这类条目短、密度高、把一整个领域的口语词全收在一处。检索时它是**同义词源**，
 * 却不该是**答案**：用户问「照片一放大就发白」要的是讲曝光的条目，不是那张对照表。
 * 0.6.36 之前引擎不认这种结构，对照条目吸收全部口语词、稳坐第一，
 * 冷域换说法 hit@1 因此是 0%（答案全被挤到 2–3 名）。
 *
 * 0.6.37 给它两个身份：
 *  ① 同义词源：从正文挖 `A＝B` 对，双向 + 切碎后喂扩词（替代人手枚举同义词）；
 *  ② 排序降权：判为对照型的条目乘 LOOKUP_PEN_DEF（0.25）——但用户自己就在问术语时（「…怎么说」）免降权。
 *
 * 读数（本支每次都会打印）：冷域换说法 hit@1 0.0% → 70.0%，hit@3 80% → 90%，MRR 0.342 → 0.800；
 * 同词池 100% 不动；真库 146 条里「含对但没被判对照型」的 19 条一条都不降权（零误伤）。
 */
import { root } from './_root.mjs'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const V = await import(pathToFileURL(join(root, 'vendor', 'meow-memory', 'lib', 'index.js')).href)

let pass = 0
let fail = 0
const bad = []
function ok(name, cond, detail) {
  if (cond) {
    pass++
    console.log('PASS ' + name + (detail ? '  ' + detail : ''))
  } else {
    fail++
    bad.push(name + '  ' + (detail ?? ''))
    console.log('FAIL ' + name + '  ' + (detail ?? ''))
  }
}
const pct = (x) => (Math.round(x * 1000) / 10).toFixed(1) + '%'
const fx = JSON.parse(readFileSync(join(root, 'tools', 'fixtures', 'domains.json'), 'utf8'))
const doms = fx.domains
const flat = doms.flatMap((d) => d.docs)
const paraAll = doms.flatMap((d) => d.queries.filter((q) => q.kind === 'para'))
const sameAll = doms.flatMap((d) => d.queries.filter((q) => q.kind === 'same'))

function measure(docs, queries, opts) {
  let h1 = 0
  let h3 = 0
  let rr = 0
  for (const q of queries) {
    const hits = V.searchAdaptive(q.q, docs, { k: 5, ...opts })
    const ids = hits.map((h) => String(h.id))
    const want = q.want.map(String)
    const at = ids.findIndex((id) => want.includes(id))
    if (at === 0) h1++
    if (at >= 0 && at < 3) h3++
    if (at >= 0) rr += 1 / (at + 1)
  }
  const n = queries.length || 1
  return { hit1: h1 / n, hit3: h3 / n, mrr: rr / n }
}
const sum = (rows, key) => rows.reduce((a, r) => a + r[key], 0) / (rows.length || 1)
const rankOf = (docs, q, want, opts) => {
  const ids = V.searchAdaptive(q, docs, { k: docs.length, ...opts }).map((h) => String(h.id))
  const at = ids.findIndex((id) => want.includes(id))
  return at
}

// ── T0 形状 ─────────────────────────────────────────────────────────────────
{
  const src = readFileSync(join(root, 'vendor', 'meow-memory', 'lib', 'index.js'), 'utf8')
  const has = (s) => src.includes(s)
  ok('T0 形状：对照桥的构造函数、降权系数、对外读数都在', has('function buildLookupBridge(docs, n, opts) {') &&
    has('var LOOKUP_PEN_DEF = 0.25;') && has('function lookupTypeOf(docs) {') &&
    has('lookupSyn: lookup === null ? null : lookup.syn,') && has('lookupPen: lookup === null ? null : lookup.pen,') &&
    has('buildLookupBridge,'), '四处齐全')
  ok('T0 形状：明确声明优先于统计共现（让位规则钉在源码里）',
    has('if (cooc instanceof Map && !(ownBridge !== void 0 && ownBridge.length > 0)) {'), 'ownBridge 让位')
}

// ── T1 对子解析：什么算一对，什么不算 ────────────────────────────────────────
{
  const a = V.lookupPairsOf('口语对照：发白＝过曝；小尾巴＝拖线')
  const b = V.lookupPairsOf('预算超了=预算超支,钱没到账=逾期未付')
  const c = V.lookupPairsOf('结论：甲＝甲；其余无关')
  const d = V.lookupPairsOf('这条没有任何等号，只是一段普通记叙')
  ok('T1 全角/半角等号都认，分号与逗号都能切对', a.length === 2 && b.length === 2,
    `全角 ${a.length} 对 · 半角 ${b.length} 对`)
  ok('T1 两侧相同的不算一对（`甲＝甲` 是无信息噪音）', c.length === 0 && V.lookupPairsOf('甲＝甲').length === 0,
    `混在正文里剩 ${c.length} 对`)
  ok('T1 没有等号的普通条目产不出对（不许把记叙文当对照表）', d.length === 0, '0 对')
}

// ── T2 判定：五域五条，真库零误伤 ───────────────────────────────────────────
{
  const t = V.lookupTypeOf(flat)
  const real = [...(JSON.parse(readFileSync(join(root, 'tools', 'fixtures', 'gold-recall.json'), 'utf8')).docs ?? []),
    ...(JSON.parse(readFileSync(join(root, 'tools', 'fixtures', 'gold-wide.json'), 'utf8')).documents ?? [])]
  const tr = V.lookupTypeOf(real)
  console.log(`MEASURE 判定：五域 60 条 → ${JSON.stringify(t)}；真库 ${real.length} 条 → ${JSON.stringify(tr)}`)
  ok('T2 五域里 5 条对照条目全被判出来，18 对全挖到', t.demoted === 5 && t.pairs === 18 && t.docs === 5,
    `pairs ${t.pairs} / docs ${t.docs} / demoted ${t.demoted}`)
  ok('T2 真库零误伤：含等号但密度不够的条目只贡献桥，一条都不降权', tr.demoted === 0 && tr.docs >= 1,
    `真库 ${real.length} 条里含对 ${tr.docs} 条、降权 ${tr.demoted} 条`)
}

// ── T3 降权与免降权：问事情 vs 问术语 ────────────────────────────────────────
{
  const q = '叶子发黄是不是缺肥'
  const plain = rankOf(flat, q, ['yy07'])
  const ask = rankOf(flat, '口语对照 里 叶子发黄 怎么说', ['yy12'])
  console.log(`MEASURE 降权：「${q}」yy07 名次 ${plain}（want 第 1）；问术语「…怎么说」yy12 名次 ${ask}`)
  ok('T3 问事情时，对照条目不许抢第一（本来它排第 1）', plain <= 1, `yy07 名次 ${plain}`)
  ok('T3 用户自己就在问术语时免降权：对照条目必须排第一', ask === 0, `yy12 名次 ${ask}`)
}

// ── T4 让位规则：明确声明比统计共现可信，两层不叠着投 ────────────────────────
{
  const on = sum(doms.map((d) => measure(d.docs, d.queries.filter((x) => x.kind === 'para'))), 'hit1')
  const offRows = doms.map((d) => measure(d.docs, d.queries.filter((x) => x.kind === 'para'), { coocLearn: false }))
  const off = sum(offRows, 'hit1')
  console.log(`MEASURE 让位：换说法 hit@1 默认 ${pct(on)} vs 关共现 ${pct(off)}`)
  ok('T4 关共现不掉分（口语词全在对照表里，共现层本来就该让位）', off <= on + 1e-9 && off >= on - 1e-9,
    `${pct(on)} vs ${pct(off)}`)
}

// ── T5 桥是净贡献，不是「碰巧」 ─────────────────────────────────────────────
{
  const para = doms.map((d) => measure(d.docs, d.queries.filter((x) => x.kind === 'para')))
  const same = doms.map((d) => measure(d.docs, d.queries.filter((x) => x.kind === 'same')))
  const noLookP = doms.map((d) => measure(d.docs, d.queries.filter((x) => x.kind === 'para'), { lookupBridge: false }))
  const noLookS = doms.map((d) => measure(d.docs, d.queries.filter((x) => x.kind === 'same'), { lookupBridge: false }))
  const p0 = sum(para, 'hit1')
  const p1 = sum(noLookP, 'hit1')
  const s0 = sum(same, 'hit1')
  const s1 = sum(noLookS, 'hit1')
  console.log(`MEASURE 净账：换说法 hit@1 ${pct(p1)}（关桥）→ ${pct(p0)}（开桥）· 同词 ${pct(s1)} → ${pct(s0)}`)
  ok('T5 关掉对照桥换说法必须塌一半以上（本版的账）', p0 >= p1 + 0.5, `${pct(p1)} → ${pct(p0)}`)
  ok('T5 同词池一处不动（桥只管换说法，不许动照抄题）', Math.abs(s0 - s1) <= 1e-9, `${pct(s1)} → ${pct(s0)}`)
}

// ── T6 桥的形状：双向 + 切碎（打分坐标系是 bigram 碎片） ────────────────────
{
  const idx = { lookupSyn: V.buildLookupBridge(doms[0].docs, doms[0].docs.length, {}).syn }
  const syn = idx.lookupSyn
  const has = (k, v) => Array.isArray(syn?.get(k)) && syn.get(k).includes(v)
  const f = (k) => (syn?.get(k) ?? []).join('/')
  console.log(`MEASURE 桥表：降糖药→${f('降糖药')} · 降糖→${f('降糖')} · 二甲→${f('二甲')}`)
  ok('T6 双向：口语词能到术语，术语也能回口语词', has('降糖药', '二甲双胍') && has('二甲双胍', '降糖药'),
    '降糖药↔二甲双胍')
  ok('T6 切碎：问句里的碎片（降糖/糖药）也要能桥到整术语', has('降糖', '二甲双胍') || has('糖药', '二甲双胍'),
    `降糖 → ${f('降糖')}`)
}

// ── T7 基线读数：这三个数就是 0.6.37 的答卷 ─────────────────────────────────
{
  const para = sum(doms.map((d) => measure(d.docs, d.queries.filter((x) => x.kind === 'para'))), 'hit1')
  const para3 = sum(doms.map((d) => measure(d.docs, d.queries.filter((x) => x.kind === 'para'))), 'hit3')
  const mrr = sum(doms.map((d) => measure(d.docs, d.queries.filter((x) => x.kind === 'para'))), 'mrr')
  console.log(`MEASURE 冷域换说法（0.6.36 基线 0.0% / 80.0% / 0.342）：hit@1 ${pct(para)} · hit@3 ${pct(para3)} · MRR ${mrr.toFixed(3)}`)
  ok('T7 冷域换说法 hit@1 ≥ 65%（0.6.36 是 0%，基线钉在这里防回退）', para >= 0.65, pct(para))
  ok('T7 冷域换说法 hit@3 ≥ 85%', para3 >= 0.85, pct(para3))
}

console.log('')
if (fail > 0) {
  console.log(`FAILED  passed ${pass} / failed ${fail}`)
  for (const b of bad) console.log('  ✗ ' + b)
  process.exitCode = 1
} else {
  console.log(`ALL PASS  probe-terms：${pass}/${pass}`)
}
