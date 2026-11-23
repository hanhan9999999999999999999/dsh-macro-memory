#!/usr/bin/env node
/**
 * bench-locomo.mjs —— 英文独立量尺（不进 check-all：需要外部数据集，仓库里没有）。
 *
 * 为什么要有它：仓库里所有「检索变准了」的读数都来自自建 660 条中文语料（`E:\Temp\cmp\corpus.json`），
 * 那套语料是这个插件自己的开发史——在同一套语料上调参、再用它证明提升，天然有「尺子过拟合」的风险。
 * 这把尺子用的是外部英文数据（LoCoMo `locomo10.json`，Snap Research 公开集），零 LLM、零网络：
 * 每条对话轮当一条记忆，官方 `evidence`（`D1:3` 这种 dia_id）当金标，量 hit@k / recall@k / MRR。
 *
 * 口径（说清楚，别和 `docs/EVAL-CLAIMS.md` A2 的 0.7546 混着引用）：
 *   - 这里是**原始对话行当记忆**（每条一轮话），不是 A2 的「ingestion 抽出来的记忆条目」；
 *     语料不同，绝对值不可比，只用来做同一套语料上的 A/B（改前 / 改后同尺）。
 *   - 排序走 `Meow.search`（基础路径，`bandKeep: false`，`k` 由 `--k` 给），不吃 `searchAdaptive`，
 *     因为这里量的是词面/排序本身，不是自适应 idf 的规模闸门。
 *   - `category 5`（adversarial，答案不在对话里）按官方口径剔除。
 *
 * 用法：
 *   node tools/bench-locomo.mjs --data=E:\Temp\omni\OmniMemEval-main\data\locomo\locomo10.json
 *   node tools/bench-locomo.mjs --data=... --k=20 --json
 *   node tools/bench-locomo.mjs --data=... --limit=200 --verbose   # 抽样快跑 / 逐题看漏在哪
 *
 * 输出：一行总计 + 按 category / 按金标条数的分档；`--json` 给机器读的版本（贴进 REPORT 用）。
 */
import { readFileSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const here = fileURLToPath(new URL('.', import.meta.url))
const ENGINE = here + '../vendor/meow-memory/lib/index.js'
const Meow = require(ENGINE)

const args = process.argv.slice(2)
const flag = (name, dflt) => {
  const hit = args.find((a) => a === `--${name}` || a.startsWith(`--${name}=`))
  if (!hit) return dflt
  const eq = hit.indexOf('=')
  return eq < 0 ? true : hit.slice(eq + 1)
}
const DATA = flag('data', '')
const K = Number(flag('k', 20))
const LIMIT = Number(flag('limit', 0))
const JSON_OUT = flag('json', false) === true
const VERBOSE = flag('verbose', false) === true

if (!DATA || !existsSync(DATA)) {
  console.error('需要数据集：node tools/bench-locomo.mjs --data=<locomo10.json>')
  console.error('  数据集从 OmniMemEval 仓库拿（data/locomo/locomo10.json），本仓不内置。')
  process.exit(2)
}

const raw = readFileSync(DATA, 'utf8')
const dataSha = createHash('sha256').update(raw).digest('hex').slice(0, 12)
const data = JSON.parse(raw)

/** 一条对话轮 → 一条记忆。`title` 留空，`keywords` 留空：这里量的是正文的词面。 */
const turnsOf = (sample) => {
  const out = []
  const conv = sample.conversation ?? {}
  for (const key of Object.keys(conv)) {
    if (!/^session_\d+$/.test(key)) continue
    for (const t of conv[key] ?? []) {
      out.push({ id: t.dia_id, title: '', content: `${t.speaker}: ${t.text}`, keywords: [], session: key })
    }
  }
  return out
}
const rankOf = (hits, id) => {
  for (let i = 0; i < hits.length; i += 1) if (hits[i].id === id) return i
  return -1
}
const pct = (n, d) => (d > 0 ? n / d : 0)
const f4 = (x) => x.toFixed(4)

const ks = [1, 5, 10, K].filter((k, i, a) => k > 0 && a.indexOf(k) === i).sort((a, b) => a - b)
const agg = { n: 0, docs: 0, hit: Object.fromEntries(ks.map((k) => [k, 0])), mrr: 0, recall: 0, retrieved: 0, empty: 0 }
const byCat = new Map()
const byGold = new Map()
const bySize = new Map()

let sampleSeen = 0
for (const sample of data) {
  const docs = turnsOf(sample)
  agg.docs += docs.length
  const goldIds = new Set(docs.map((d) => d.id))
  const qs = (sample.qa ?? []).filter((q) => Number(q.category) !== 5)
  for (const q of qs) {
    if (LIMIT > 0 && agg.n >= LIMIT) break
    const gold = [...new Set((q.evidence ?? []).filter((e) => goldIds.has(e)))]
    if (gold.length === 0) continue
    const hits = Meow.search(String(q.question ?? ''), docs, { k: Math.max(K, 1), bandKeep: false })
    let best = -1
    for (const g of gold) {
      const r = rankOf(hits, g)
      if (r >= 0 && (best < 0 || r < best)) best = r
    }
    agg.n += 1
    agg.retrieved += hits.length
    if (hits.length === 0) agg.empty += 1
    for (const k of ks) if (best >= 0 && best < k) agg.hit[k] += 1
    if (best >= 0) {
      agg.mrr += 1 / (best + 1)
      agg.recall += 1 / gold.length
    }
    const cat = `cat${q.category ?? '?'}`
    const a = byCat.get(cat) ?? { n: 0, hitK: 0, hit1: 0 }
    a.n += 1
    if (best === 0) a.hit1 += 1
    if (best >= 0 && best < K) a.hitK += 1
    byCat.set(cat, a)
    const gk = gold.length > 1 ? 'gold2+' : 'gold1'
    const g = byGold.get(gk) ?? { n: 0, hitK: 0, recall: 0 }
    g.n += 1
    if (best >= 0 && best < K) g.hitK += 1
    if (best >= 0) g.recall += 1 / gold.length
    byGold.set(gk, g)
    const sizeKey = docs.length > 400 ? 'docs>400' : docs.length > 200 ? 'docs201-400' : 'docs<=200'
    const s = bySize.get(sizeKey) ?? { n: 0, hitK: 0 }
    s.n += 1
    if (best >= 0 && best < K) s.hitK += 1
    bySize.set(sizeKey, s)
    if (VERBOSE && best !== 0) console.log(`  ${best < 0 ? '未命中' : '#' + (best + 1)}  ${q.question}`)
  }
  sampleSeen += 1
  if (LIMIT > 0 && agg.n >= LIMIT) break
}

const result = {
  tool: 'bench-locomo',
  dataset: { path: DATA, sha256_12: dataSha, samples: sampleSeen, docs: agg.docs },
  params: { k: K },
  total: {
    n: agg.n,
    hitAt: Object.fromEntries(ks.map((k) => [k, Number(f4(pct(agg.hit[k], agg.n)))])),
    mrr: Number(f4(pct(agg.mrr, agg.n))),
    [`recallAt${K}`]: Number(f4(pct(agg.recall, agg.n))),
    avgRetrieved: Number((pct(agg.retrieved, agg.n)).toFixed(2)),
    emptyRate: Number(f4(pct(agg.empty, agg.n))),
  },
  byCategory: Object.fromEntries([...byCat].sort().map(([c, a]) => [c, { n: a.n, hitAt1: Number(f4(pct(a.hit1, a.n))), [`hitAt${K}`]: Number(f4(pct(a.hitK, a.n))) }])),
  byGoldCount: Object.fromEntries([...byGold].sort().map(([c, a]) => [c, { n: a.n, [`hitAt${K}`]: Number(f4(pct(a.hitK, a.n))), [`recallAt${K}`]: Number(f4(pct(a.recall, a.n))) }])),
  byCorpusSize: Object.fromEntries([...bySize].sort().map(([c, a]) => [c, { n: a.n, [`hitAt${K}`]: Number(f4(pct(a.hitK, a.n))) }])),
}

if (JSON_OUT) {
  console.log(JSON.stringify(result, null, 2))
} else {
  const t = result.total
  console.log(`数据集 ${dataSha} · ${sampleSeen} 段对话 / ${agg.docs} 条对话轮 / ${agg.n} 问（剔 cat5）· k=${K}`)
  console.log(`  hit@1 ${f4(t.hitAt['1'])}  hit@5 ${f4(t.hitAt['5'] ?? 0)}  hit@10 ${f4(t.hitAt['10'] ?? 0)}  hit@${K} ${f4(t.hitAt[String(K)])}  MRR ${f4(t.mrr)}  recall@${K} ${f4(t[`recallAt${K}`])}  平均取回 ${t.avgRetrieved}  空回 ${f4(t.emptyRate)}`)
  for (const [c, a] of Object.entries(result.byCategory)) console.log(`  ${c} n=${a.n} hit@1 ${a.hitAt1} hit@${K} ${a[`hitAt${K}`]}`)
  for (const [c, a] of Object.entries(result.byGoldCount)) console.log(`  ${c} n=${a.n} hit@${K} ${a[`hitAt${K}`]} recall@${K} ${a[`recallAt${K}`]}`)
  for (const [c, a] of Object.entries(result.byCorpusSize)) console.log(`  ${c} n=${a.n} hit@${K} ${a[`hitAt${K}`]}`)
}
