#!/usr/bin/env node
/**
 * [macro-fusion 0.6.11] 原样匹配账——钉住「库没变时，不重复拼 haystack」这件事。
 *
 * 病根：问句里带标识符时（英文问句基本都带），`search` 会把整库每条记忆重新拼成一个
 * 小写字符串再逐条做子串匹配：`docs.map((d) => textOf(d).toLowerCase())`。
 * 拼出来的东西只由「库里有什么」决定，跟「问什么」毫无关系——可它每问一次都重拼一遍。
 * 实测（`E:\Temp\cmp\scale011.mjs` / `scale011b.mjs`，660 / 2,000 / 5,000 / 10,000 条同构语料）：
 * 这一通道占一次热检索的 **35.7% / 50.6% / 42.7% / 42.9%**；其中「逐条拼 + toLowerCase」
 * 在 10,000 条时 5.78ms，真正的逐条子串匹配只要 0.51ms —— 钱全花在重新拼串上。
 *
 * 处方：haystack 挪进搜索索引（懒建、随索引一起缓存），索引由签名把关。
 * 三条命门在这里逐条钉住：
 *   ① 内容与老实现逐位相同（id + project + docText，全小写）；
 *   ② 它待在索引里，就必须被签名覆盖——`project` 原先不在签名里，这是 0.6.10 没暴露的洞
 *      （老实现每问现拼所以看不出来，一搬进索引就会「改 project 拿旧串答新库」）；
 *   ③ 懒建 + 记账：没有标识符的问句一条都不许建，有标识符时同一张库只付一次钱。
 *
 *   V1 haystack 内容与老实现（现拼）逐位相同（200 种形状：缺字段 / 逗号串 / 脏元素 / 大写）
 *   V2 连问 5 次逐位相同，且第 2 次起「复用」在涨、「新建」不涨
 *   V3 就地改正文 → 索引重建、haystack 跟着变
 *   V4 就地改 project → haystack 跟着变（这条是 0.6.11 的新命门，签名没覆盖 project 时必红）
 *   V5 就地改 keywords 数组里的一个词 → haystack 跟着变
 *   V6 缓存版与老口径等价：返回条目的 `explain.verbatim.matched` 与用参考 haystack 现算的逐条相同
 *   V7 10,000 条带标识符问句：原样匹配通道的**固定开销** ≤ 7ms（份额 ≤ 40% 只作旁证；分母在 0.6.12→0.6.15 掉了约六成，份额口径会假红）
 *   V8 没有标识符的问句一条 haystack 都不建（中文问句占绝大多数）
 *   V9 能红证明：以「条数」当缓存键的坏实现，看不见 project 改动（真实现看得见）
 *
 * 用法：node tools/probe-verbatim.mjs   （挂进 check-all；只读引擎，不写任何文件）
 */
import { root } from './_root.mjs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const enginePath = join(root, 'vendor', 'meow-memory', 'lib', 'index.js')
const V = await import(pathToFileURL(enginePath).href)

let total = 0
let failures = 0
function check(label, ok, extra) {
  total++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra === undefined || extra === '' ? '' : `  ${extra}`}`)
  if (!ok) failures++
}

// 关键词归一化：与引擎 `kwList` 同口径（数组滤空 / 逗号串切 / JSON 串解析）。
function kwOf(doc) {
  const raw = doc?.keywords
  if (Array.isArray(raw)) return raw.filter((w) => typeof w === 'string' && w.length > 0)
  if (typeof raw !== 'string') return []
  const s = raw.trim()
  if (s === '') return []
  if (s.startsWith('[')) {
    try {
      const parsed = JSON.parse(s)
      if (Array.isArray(parsed)) return parsed.filter((w) => typeof w === 'string' && w.length > 0)
    } catch { /* 不是 JSON 就按分隔符切 */ }
  }
  return s.split(/[,，、;；]/).map((w) => w.trim()).filter((w) => w.length > 0)
}
// 参考实现：0.6.10 及以前每问现拼的那串（项目里 `verbatimInputs` 的 4th 参）。
function refHay(d) {
  const dtext = [d?.title ?? '', d?.content ?? '', kwOf(d).join(' ')].join(' ')
  return (String(d?.id ?? '') + ' ' + String(d?.project ?? '') + ' ' + dtext).toLowerCase()
}
function rnd(seed) {
  let s = seed >>> 0 || 1
  return () => {
    s ^= s << 13; s >>>= 0
    s ^= s >> 17
    s ^= s << 5; s >>>= 0
    return s / 4294967296
  }
}
function shape(i) {
  const r = rnd(9001 + i)
  const pick = (arr) => arr[Math.floor(r() * arr.length) % arr.length]
  const base = {
    id: pick(['id-' + i, 'ID-' + i, 'a' + i, 'kv_store.ts:' + i]),
    title: pick(['超时处理', 'Timeout handling', '', '第 ' + i + ' 条']),
    content: pick([
      '把 kv_store.ts 里的超时调到 8000ms，原因是 rename 慢。',
      'KV_STORE.TS 的超时要按平台区分。',
      '',
      'x'.repeat(60),
    ]),
    updated_at: 1795400000000 + i,
    source_session: pick(['sess-1', 'SESS-2', undefined]),
  }
  if (i % 4 === 0) base.project = pick(['全局', 'dsh-macro-memory', 'P-' + i])
  if (i % 5 === 0) base.keywords = ['kv_store', '超时', '退避']
  else if (i % 5 === 1) base.keywords = 'kv_store,超时,退避'
  else if (i % 5 === 2) base.keywords = '["kv_store","超时"]'
  else if (i % 5 === 3) base.keywords = null
  return base
}
function makeCorpus(n) {
  const docs = []
  for (let i = 0; i < n; i++) {
    docs.push({
      id: 'id-' + i,
      title: '第 ' + i + ' 条记忆 关于 kv_store.ts 的超时处理',
      content: '第 ' + i + ' 条：把 kv_store.ts 里的超时从 3000ms 调到 8000ms，原因是 Windows 上 rename 偶尔要 4 秒才返回。编号 ' + i + '。',
      keywords: ['kv_store', '超时', '退避', '记忆' + (i % 97)],
      project: i % 3 === 0 ? '全局' : 'dsh-macro-memory',
      updated_at: 1795400000000 + i * 1000,
      source_session: 'sess-' + (i % 13),
    })
  }
  return docs
}

// ── V1：haystack 内容与老实现逐位相同 ──────────────────────────────────────────
{
  const docs = []
  for (let i = 0; i < 200; i++) docs.push(shape(i))
  V.clearSearchIndexCache()
  const idx = V.searchIndexOf(docs, {})
  const diff = []
  for (let i = 0; i < docs.length; i++) {
    const got = idx.hayAt(i)
    const want = refHay(docs[i])
    if (got !== want) diff.push(`${i}: ${JSON.stringify(got)} ≠ ${JSON.stringify(want)}`)
  }
  check('V1 haystack 与老实现（每问现拼）逐位相同（200 种形状）',
    diff.length === 0 && docs.length === 200, diff.length === 0 ? '200/200 一致' : diff.slice(0, 3).join(' | '))
}

// ── V2：连问 5 次，只拼一次 ───────────────────────────────────────────────────
{
  const docs = makeCorpus(660)
  V.clearSearchIndexCache()
  V.resetVerbatimHayStats()
  const q = 'how do I fix the timeout in kv_store.ts when rename is slow'
  const outs = []
  for (let i = 0; i < 5; i++) outs.push(V.search(q, docs, { k: 5 }).map((x) => x.id).join(','))
  const st = V.verbatimHayStats()
  const same = outs.every((x) => x === outs[0])
  check('V2 连问 5 次逐位相同，且第 2 次起只复用不重拼',
    same && outs[0] !== '' && st.built === 660 && st.reused >= 660 * 4,
    `结果 ${same ? '5/5 一致' : '有漂移'} · 新建 ${st.built} · 复用 ${st.reused}`)
}

// ── V3：就地改正文 → haystack 跟着变 ─────────────────────────────────────────
{
  const docs = makeCorpus(40)
  V.clearSearchIndexCache()
  const idx = V.searchIndexOf(docs, {})
  const before = idx.hayAt(3)
  const beforeBuilt = V.verbatimHayStats().built
  docs[3].content = '改过了：超时改成 12000ms，rename 不再重试。'
  const idx2 = V.searchIndexOf(docs, {})
  const after = idx2.hayAt(3)
  const rebuiltAfter = V.verbatimHayStats().built
  check('V3 就地改正文 → 索引重建、haystack 跟着变',
    before !== after && after === refHay(docs[3]) && idx !== idx2 && rebuiltAfter > beforeBuilt,
    `重建 ${idx !== idx2 ? '是' : '否'} · 新建 ${beforeBuilt}→${rebuiltAfter}`)
}

// ── V4：就地改 project → haystack 跟着变（0.6.11 的新命门） ────────────────────
{
  const docs = makeCorpus(40)
  V.clearSearchIndexCache()
  const idx = V.searchIndexOf(docs, {})
  const before = idx.hayAt(5)
  docs[5].project = '另一个项目'
  const idx2 = V.searchIndexOf(docs, {})
  const after = idx2.hayAt(5)
  check('V4 就地改 project → haystack 跟着变（签名必须覆盖 project）',
    before !== after && after === refHay(docs[5]) && after.includes('另一个项目'),
    `${before === after ? '没变（漏了）' : '变了'} · ${JSON.stringify(after.slice(0, 24))}…`)
}

// ── V5：就地改 keywords 元素 → haystack 跟着变 ───────────────────────────────
{
  const docs = makeCorpus(40)
  V.clearSearchIndexCache()
  const idx = V.searchIndexOf(docs, {})
  const before = idx.hayAt(7)
  docs[7].keywords[1] = '退避重试'
  const idx2 = V.searchIndexOf(docs, {})
  const after = idx2.hayAt(7)
  check('V5 就地改 keywords 数组里的一个词 → haystack 跟着变',
    before !== after && after === refHay(docs[7]) && after.includes('退避重试'),
    `${before === after ? '没变（漏了）' : '变了'}`)
}

// ── V6：缓存版与老口径等价（逐条比 explain.verbatim.matched） ─────────────────
{
  const docs = makeCorpus(660)
  V.clearSearchIndexCache()
  const queries = [
    'how do I fix the timeout in kv_store.ts when rename is slow',
    'kv_store.ts 的 rename 为什么要 4 秒',
    'Windows 上 rename 偶尔慢，超时怎么设',
    'sess-3 里记了什么',
    'id-42 这条说的什么',
    'Timeout handling for KV_STORE.TS',
  ]
  const bad = []
  for (const q of queries) {
    const hits = V.search(q, docs, { k: 8, explain: true })
    for (const h of hits) {
      const di = docs.findIndex((d) => d.id === h.id)
      const hay = refHay(docs[di])
      // 参考口径：标识符在大写 haystack 之外一律按小写比（verbatimOf 拿到的就是小写串）
      const got = (h.explain && h.explain.verbatim) || []
      const want = []
      for (const t of (h.explain && h.explain.strippedVerbatim) ?? []) void t
      // 用与引擎同口径的逐标识符判据重算：子串出现即命中（局部命中后缀 "(局部)" 由引擎决定，这里只比集合）
      const idents = V.identsOf(q)
      for (const t of idents) {
        if (!hay.includes(t.toLowerCase())) continue
        if (!got.some((g) => g === t || g === t + '(局部)')) want.push(t)
      }
      const gotBase = got.map((g) => String(g).replace(/\(局部\)$/, ''))
      if (want.some((t) => !gotBase.includes(t)) || gotBase.some((t) => !idents.map((x) => x.toLowerCase()).includes(t))) {
        bad.push(`${q} @ ${h.id}: got ${JSON.stringify(got)} want⊇${JSON.stringify(want)}`)
      }
    }
  }
  check('V6 缓存版与老口径等价：命中条目的 verbatim 明细与参考 haystack 现算一致',
    bad.length === 0, bad.length === 0 ? '6 个问句逐条一致' : bad.slice(0, 2).join(' | '))
}

// ── V7：10,000 条：原样匹配通道的固定开销 ≤ 7ms（份额降级成旁证） ────────────────
{
  const docs = makeCorpus(10000)
  const q = 'how do I fix the timeout in kv_store.ts when rename is slow'
  V.clearSearchIndexCache()
  V.search(q, docs, { k: 5 })
  const bench = (fn, rounds = 30) => {
    fn()
    const t0 = process.hrtime.bigint()
    for (let i = 0; i < rounds; i++) fn()
    return Number(process.hrtime.bigint() - t0) / 1e6 / rounds
  }
  const all = bench(() => V.search(q, docs, { k: 5 }))
  const noVerb = bench(() => V.search(q, docs, { k: 5, verbatim: false }))
  const verbCost = all - noVerb
  const share = verbCost / all
  // 0.6.15 起改口径：份额的分母（其它通道）在 0.6.12→0.6.15 之间掉了约六成，同一个固定开销摊在
  // 更小的分母上，25% 这条线必然假红（2026-11-24 实测 30.1%，而绝对开销 4.93ms 与 0.6.10 同级）。
  // 0.6.17 又把分母砍掉一半（`search` 8.35 → 3.5ms，回执对象先瘦后水化），份额升到 54.4% —— 同一笔
  // 固定开销、同样的绝对数，只因别的通道变快而「占比失控」。这笔账真正要守的始终是「固定开销不涨」，
  // 所以份额彻底降级成旁证（只打印，不参与判定）；拿分母变小说事会让优化越成功越红。
  check('V7 10,000 条：原样匹配通道的固定开销 ≤ 7ms（份额只作旁证，不参与判定；分母在 0.6.12→0.6.17 掉了约八成）',
    verbCost <= 7,
    `开销 ${verbCost.toFixed(2)}ms / 总 ${all.toFixed(2)}ms（${(share * 100).toFixed(1)}%）`)
}

// ── V8：没有标识符的问句一条 haystack 都不建 ─────────────────────────────────
{
  const docs = makeCorpus(660)
  V.clearSearchIndexCache()
  V.resetVerbatimHayStats()
  for (let i = 0; i < 5; i++) V.search('退避重试应该怎么写', docs, { k: 5 })
  const st = V.verbatimHayStats()
  check('V8 没有标识符的问句一条 haystack 都不建（懒建）',
    st.built === 0 && st.reused === 0 && st.calls === 5, `calls ${st.calls} · 新建 ${st.built} · 复用 ${st.reused}`)
}

// ── V9：能红证明——以「条数」当缓存键的坏实现看不见 project 改动 ──────────────
{
  const docs = makeCorpus(40)
  const BAD = new Map()
  const badHay = (i) => {
    const key = docs.length
    if (!BAD.has(key)) BAD.set(key, docs.map((d) => refHay(d)))
    return BAD.get(key)[i]
  }
  const badBefore = badHay(5)
  docs[5].project = '另一个项目'
  const badAfter = badHay(5)
  V.clearSearchIndexCache()
  const idx = V.searchIndexOf(docs, {})
  check('V9 能红证明：只按条数缓存的坏实现看不见 project 改动（真实现看得见）',
    badBefore === badAfter && idx.hayAt(5).includes('另一个项目'),
    `坏实现 ${badBefore === badAfter ? '漏了' : '看见了'} · 真实现 ${idx.hayAt(5).includes('另一个项目') ? '看见' : '漏了'}`)
}

console.log(failures === 0 ? `\nALL PASS  probe-verbatim：${total}/${total}` : `\n${failures} 条失败（共 ${total}）`)
process.exit(failures === 0 ? 0 : 1)
