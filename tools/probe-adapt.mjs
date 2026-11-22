/**
 * 探针：跨领域适应力（0.5.0 · P0）
 *
 * 为什么要有这一支：主人要的不是「在 dsh 这套词汇上再准一点」，而是「换一个完全陌生的场景，
 * 库里全是没见过的词，还能不能找得到」。0.4.0 的 gold 池只有一个领域（这个插件自己的开发史），
 * 在那儿调出来的东西，换到医学/法律/园艺/天文/财务就像换了个宇宙——手工同义表（SYN_GROUPS）
 * 里一个词都用不上。
 *
 * 所以这把尺子只量三件事：
 *  A 同词召回不塌：新领域里问句用正文原词，第一命中必须是那条（引擎在陌生词汇上也不许崩）。
 *  B 换说法还能找到：问句用口语备忘里的词（正式文档里没有），答案在正式文档里——
 *    这一条只能靠「从库里自己学出来的桥」，手工表在这五个领域里是空的。
 *  C 不是靠手工表撑的：synBridge:false 与默认几乎一样 → 证明冷域的高分来自共现自学习；
 *     coocLearn:false 一关就掉，进一步证明是它。
 *
 * 夹具：tools/fixtures/domains.json（5 域 × 12 条 + 每域 5 问：3 同词 + 2 换说法）。
 * 反向断言：换说法问句的每个词都不与 SYN_GROUPS 相交（否则量的是老表，不是适应力）。
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
const K = 5

function measure(docs, queries, opts = {}) {
  let h1 = 0
  let h3 = 0
  let mrr = 0
  let n = 0
  const miss = []
  const call = opts.__plain === true ? V.search : V.searchAdaptive
  const rest = { ...opts }
  delete rest.__plain
  for (const item of queries) {
    const hits = call(item.q, docs, { k: K, ...rest })
    const ids = hits.map((h) => String(h.id))
    const rank = ids.findIndex((id) => item.want.includes(id))
    n++
    if (rank === 0) h1++
    if (rank >= 0 && rank < 3) h3++
    mrr += rank >= 0 ? 1 / (rank + 1) : 0
    if (rank !== 0) miss.push({ q: item.q, want: item.want[0], got: ids.slice(0, 3).join(','), rank })
  }
  return { n, hit1: n ? h1 / n : 0, hit3: n ? h3 / n : 0, mrr: n ? mrr / n : 0, miss }
}
const sum = (rs, key) => {
  const n = rs.reduce((a, r) => a + r.n, 0)
  return n ? rs.reduce((a, r) => a + r[key] * r.n, 0) / n : 0
}

// ── A0 夹具形态 + 冷域反向断言 ───────────────────────────────────────────────
{
  const words = new Set(V.SYN_GROUPS.flat())
  const sizes = doms.map((d) => d.docs.length)
  ok('A0 夹具：5 个互不相关的领域，每域 12 条记忆、5 条问句（3 同词 + 2 换说法）',
    doms.length === 5 && sizes.every((s) => s === 12) &&
      doms.every((d) => d.queries.length === 5 && d.queries.filter((q) => q.kind === 'para').length === 2),
    `${doms.map((d) => d.name).join('/')} · ${doms.map((d) => d.queries.length).join('+')} 问`)
  // 换说法问句的每一个词都不许出现在手工表里：出现了就说明这条「换说法」其实能靠老表赢，
  // 量出来的是老表的手艺，不是引擎对新领域的适应力。
  const leaked = []
  for (const d of doms) {
    for (const q of d.queries.filter((x) => x.kind === 'para')) {
      for (const t of V.tokenize(q.q)) if (words.has(t)) leaked.push(`${d.name}:${q.q}→${t}`)
    }
  }
  ok('A0 换说法问句与手工同义表零交集：冷域读数不许借老表的光', leaked.length === 0, leaked.join(' | ') || '零交集')
  // 每域都必须真有「桥」：换说法问句里的口语词（bridge[0]）在答案文档里不存在，
  // 而它对应的正式词（bridge[1]）只在答案文档里——这才叫「非跨过一座库自己学出来的桥不可」。
  // 只用夹具自报的 bridge 对来判，不靠「猜哪个词算桥」。
  const noBridge = []
  for (const d of doms) {
    const byId = new Map(d.docs.map((x) => [x.id, x]))
    for (const q of d.queries.filter((x) => x.kind === 'para')) {
      const [loose, formal] = q.bridge ?? []
      const ans = String(byId.get(q.want[0]).title) + ' ' + String(byId.get(q.want[0]).content)
      const elsewhere = String((byId.get(q.want[0]).keywords ?? []).join(' '))
      if (!loose || !formal) { noBridge.push(`${d.name}:${q.q} 缺 bridge 声明`); continue }
      const looseInAns = ans.includes(loose) || elsewhere.includes(loose)
      const formalInAns = ans.includes(formal) || elsewhere.includes(formal)
      const looseElsewhere = d.docs.some((x) => x.id !== q.want[0] && (String(x.content) + (x.keywords ?? []).join(' ')).includes(loose))
      if (looseInAns || !formalInAns || !looseElsewhere) {
        noBridge.push(`${d.name}:${q.q} looseInAns=${looseInAns} formalInAns=${formalInAns} looseElsewhere=${looseElsewhere}`)
      }
    }
  }
  ok('A0 每条换说法都真需要一座桥：口语词不在答案里、正式词只在答案里', noBridge.length === 0, noBridge.join(' | ') || '都有桥')
}

// ── A1 同词召回 ─────────────────────────────────────────────────────────────
const sameAll = []
const paraAll = []
const per = []
for (const d of doms) {
  const s = measure(d.docs, d.queries.filter((q) => q.kind === 'same'))
  const p = measure(d.docs, d.queries.filter((q) => q.kind === 'para'))
  sameAll.push(s)
  paraAll.push(p)
  per.push({ name: d.name, same: s, para: p })
  console.log(`MEASURE ${d.name}：同词 hit@1 ${pct(s.hit1)} (${s.n}) · 换说法 hit@1 ${pct(p.hit1)} MRR ${p.mrr.toFixed(3)}`)
  for (const m of p.miss) console.log(`    MISS 换说法「${m.q}」want=${m.want} got=${m.got} rank=${m.rank}`)
  for (const m of s.miss) console.log(`    MISS 同词「${m.q}」want=${m.want} got=${m.got} rank=${m.rank}`)
}
const sameH1 = sum(sameAll, 'hit1')
const paraH1 = sum(paraAll, 'hit1')
ok('A1 陌生领域同词召回：问句里的词就在正文里，第一条必须是对的（≥90%）', sameH1 >= 0.9,
  `${pct(sameH1)} · ${per.map((x) => x.name + ' ' + pct(x.same.hit1)).join(' / ')}`)
console.log(`MEASURE 冷域换说法基线：hit@1 ${pct(paraH1)} · hit@3 ${pct(sum(paraAll, 'hit3'))} · MRR ${sum(paraAll, 'mrr').toFixed(3)}`)

// ── A2 消融：关共现 / 关手工表 ───────────────────────────────────────────────
// 判据看 hit@3 而不是 hit@1：0.5.0 的桥是「补位」性质的（第一名按设计不动），命中率提升
// 全发生在第 2、第 3 位；拿 hit@1 判消融，桥关掉也不掉分，等于没判。
{
  const paraH3 = sum(paraAll, 'hit3')
  const off = doms.map((d) => measure(d.docs, d.queries.filter((q) => q.kind === 'para'), { coocLearn: false }))
  const offH3 = sum(off, 'hit3')
  const noLearned = doms.map((d) => measure(d.docs, d.queries.filter((q) => q.kind === 'para'), { synBridge: false }))
  const noBridgeH3 = sum(noLearned, 'hit3')
  console.log(`MEASURE 消融（hit@3）：默认 ${pct(paraH3)} / 关共现 ${pct(offH3)} / 关扩词 ${pct(noBridgeH3)}`)
  ok('A2 关掉共现自学习，冷域换说法必须变差（证明高分是学出来的，不是碰巧）', offH3 < paraH3 - 0.15,
    `${pct(paraH3)} → ${pct(offH3)}`)
  ok('A2 冷域里手工表本就无词可用：关扩词与「只关共现」读数一致（差异 ≤1 题）',
    Math.abs(noBridgeH3 - offH3) <= 0.11, `${pct(noBridgeH3)} vs ${pct(offH3)}`)
}

// ── A3 混库不污染：5 个领域拼成一个库，别域的词不许把本域问句带歪 ──────────────
{
  const allDocs = doms.flatMap((d) => d.docs)
  const mixed = doms.map((d) => measure(allDocs, d.queries.filter((q) => q.kind === 'para')))
  const mixedH1 = sum(mixed, 'hit1')
  console.log(`MEASURE 混库（${allDocs.length} 条）：换说法 hit@1 ${pct(mixedH1)} · 单域 ${pct(paraH1)}`)
  ok('A3 五个领域混在一个库里，换说法读数不许比单域差（共现表不许被别域的词污染）',
    mixedH1 >= paraH1 - 0.06, `${pct(mixedH1)} vs ${pct(paraH1)}`)
}

// ── A4 第二遍只补位、不翻盘 ─────────────────────────────────────────────────
// 词形桥（searchAdaptive 的第二遍）只许把桥捞回来的条目填进第 2、第 3 位：每条问句的第一名
// 必须与只跑一遍（search）一模一样。这是「换场景更准」与「老答案别被动」之间的分界——
// 通了这一条，precise 的老读数才不会被「又听了一遍」悄悄改掉。
{
  const plain = doms.map((d) => measure(d.docs, d.queries.filter((q) => q.kind === 'para'), { __plain: true }))
  const plainH3 = sum(plain, 'hit3')
  const paraH3 = sum(paraAll, 'hit3')
  const flipped = []
  for (const d of doms) {
    for (const q of d.queries.filter((x) => x.kind === 'para')) {
      const a = V.search(q.q, d.docs, { k: K })[0]
      const b = V.searchAdaptive(q.q, d.docs, { k: K })[0]
      if (String(a?.id) !== String(b?.id)) flipped.push(`${d.name}:${q.q} ${a?.id} → ${b?.id}`)
    }
  }
  console.log(`MEASURE 一遍 vs 两遍：hit@3 ${pct(plainH3)} → ${pct(paraH3)}（第一名改判 ${flipped.length} 题）`)
  ok('A4 两遍只补位：第二名以后可以变，第一名必须与只跑一遍逐位相同', flipped.length === 0, flipped.join(' | ') || '第一名全同')
  ok('A4 两遍确实捞回了桥：冷域换说法 hit@3 至少涨 2 题', paraH3 >= plainH3 + 0.2, `${pct(plainH3)} → ${pct(paraH3)}`)
}

// ── A5 真实噪声：库里混进 146 条真记忆（不是夹具里的干净词表），桥还找得到吗 ──────────
// A1–A4 都在「12 条干净记忆」的小池里量。小池有一个隐蔽的好处：干扰条目也来自同一个词表，
// 每个词都「见过」，idf 也稳。真库不是这样——146 条真记忆（gold-recall 40 + gold-wide 106）
// 讲的是这个插件自己的开发史，词汇、长度、密度都不一样。不加这一条，读数就有「过拟合小池」的嫌疑。
// 判据只守两条：①不塌（hit@3 ≥ 0.5）；②桥在噪声里仍然可归因（关共现至少掉 2 题）。
{
  const readFx = (name) => JSON.parse(readFileSync(join(root, 'tools', 'fixtures', name), 'utf8'))
  const real = [...(readFx('gold-recall.json').docs ?? []), ...(readFx('gold-wide.json').documents ?? [])].map((x, i) => ({
    ...x,
    id: 'real' + i,
    level: x.level ?? 'fact',
    status: x.status ?? 'active',
    importance: x.importance ?? 2,
    project: x.project ?? '真库',
    title: x.title ?? '',
    content: x.content ?? '',
    keywords: Array.isArray(x.keywords) ? x.keywords : [],
  }))
  const noisy = [...doms.flatMap((d) => d.docs), ...real]
  const allPara = doms.flatMap((d) => d.queries.filter((q) => q.kind === 'para'))
  const clean = measure(doms.flatMap((d) => d.docs), allPara)
  const mixed = measure(noisy, allPara)
  const mixedOff = measure(noisy, allPara, { coocLearn: false })
  console.log(`MEASURE 真实噪声（${noisy.length} 条 = 60 夹具 + ${real.length} 真记忆）：换说法 hit@3 ${pct(mixed.hit3)}（纯池 ${pct(clean.hit3)}）· 关共现 ${pct(mixedOff.hit3)}`)
  ok('A5 混进 146 条真记忆当干扰，换说法 hit@3 不许塌（≥50%）', mixed.hit3 >= 0.5, `${pct(mixed.hit3)}（纯池 ${pct(clean.hit3)}）`)
  ok('A5 噪声里桥仍然可归因：关掉共现自学习，换说法 hit@3 至少掉 2 题', mixedOff.hit3 <= mixed.hit3 - 0.2,
    `${pct(mixed.hit3)} → ${pct(mixedOff.hit3)}`)
}

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES: ' + fail}  passed ${pass} / failed ${fail}`)
if (fail > 0) {
  console.log(bad.map((b) => '  - ' + b).join('\n'))
  process.exitCode = 1
}
