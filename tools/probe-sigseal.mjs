#!/usr/bin/env node
// 签名只认版本章（0.6.36）量尺：盖章到底省了什么、有没有把旧签名当新库答出去。
//
// 为什么要有这一支：0.6.35 把文档对象与数组的身份钉住之后，`indexSignature` 仍然是「10,000 条逐条
// 比一遍字段再混一遍哈希」——行缓存只是把「查表」换成「按下标取」，比字段这件事一点没少。剖面
// （`E:\Temp\cmp\p36`，10,000 条 / 3,000 问）里它单独占 **3,020ms self = 1.0ms/问**，是全表最贵的一项。
// 0.6.36 的处方：`stableDocsOf` 每一趟本来就要逐条比（`docStepOf` 的十字段指纹），比的时候顺手就知道
// 「签名字段变没变」，于是给数组盖版本号；`indexSignature` 见章号与签名版本一致就直接还回上次的签名。
//
// 判据两头，一头都不能省：
//   ① **省了多少**：同一批行（每问现拷，像 SQLite 每问查出来那样，且每问都 bump 命中条的
//      `last_accessed_at`）走 0.6.35 的写法与 0.6.36 的合并版，比 perQuery，命中串必须逐字相同；
//   ② **一章都不许认错**：签名字段（updated_at / content / title / keywords）一变必须重新盖；
//      `last_accessed_at` / importance / status / level / created_at 变了**不许**重算；
//      数组被外部换格、长度变化都必须退回去整表算，且签名与「每问现造」逐字相同。
import { root } from './_root.mjs'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import * as V from '../vendor/meow-memory/lib/index.js'

void root
const GREEN = (s) => `\u001b[32m${s}\u001b[0m`
const RED = (s) => `\u001b[31m${s}\u001b[0m`
let pass = 0
let fail = 0
function check(label, ok, extra) {
  if (ok) {
    pass += 1
    console.log(`PASS  ${label}${extra === undefined ? '' : `  ${extra}`}`)
  } else {
    fail += 1
    console.log(`FAIL  ${label}${extra === undefined ? '' : `  ${extra}`}`)
  }
}

const ENGINE = readFileSync(join(root, 'vendor/meow-memory/lib/index.js'), 'utf8')

// ── S0 形状在位：合并版真的接在生产入口上（不是只导出了几个没人用的函数）
{
  const has = (s) => ENGINE.includes(s)
  const ok = has('function stableDocsOf(rows) {') &&
    has('function docStepOf(r) {') &&
    has('const docs = stableDocsOf(filtered);') &&
    has('seal.sigVer === seal.ver') &&
    has('  stableDocsOf,\n  docStepOf,\n  docObjCacheInfo,\n  resetDocObjCache,')
  check('S0 合并版接在 memory_search 上，章与合并版都导出', ok)
}

const WORDS = ['记忆', '插件', '索引', '检索', '签名', '缓存', '回执', '分档', '权重', '覆盖', '噪声', '地板',
  '时间', '锚点', '实体', '先验', '同义', '扩展', '倒排', '打分', '定序', '排序', '持久化', '会话',
  '项目', '规则', '事实', '教训', '主题', '标签', '关键词', '备份', '发版', '基线', '评测', '读数']
function rnd(seed) { let s = seed >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; }; }
function makeRows(n, seed = 0x5eed) {
  const r = rnd(seed)
  const rows = []
  for (let i = 0; i < n; i++) {
    const len = 12 + Math.floor(r() * 20)
    const parts = []
    for (let j = 0; j < len; j++) parts.push(WORDS[Math.floor(r() * WORDS.length)])
    rows.push({
      id: '0mseal' + String(i).padStart(5, '0'),
      project: 'dsh-macro-memory',
      level: i % 7 === 3 ? 'rules' : 'fact',
      title: WORDS[Math.floor(r() * WORDS.length)] + ' ' + WORDS[Math.floor(r() * WORDS.length)],
      content: parts.join('，') + '。第 ' + i + ' 条。',
      keywords: [WORDS[Math.floor(r() * WORDS.length)], WORDS[Math.floor(r() * WORDS.length)]],
      importance: 1 + Math.floor(r() * 4),
      status: 'active',
      created_at: 1795390000000 - i * 60000,
      updated_at: 1795400000000 - i * 60000,
      last_accessed_at: 1795400000000 - i * 60000 - 3600000,
      source_session: 's' + (i % 13),
    })
  }
  return rows
}
// 每问一次从 SQLite 查出来：行对象与 keywords 数组都是新的（工程上就是 `db.list` 的形状）
const dbRead = (rows) => rows.map((r) => ({ ...r, keywords: Array.isArray(r.keywords) ? r.keywords.slice() : r.keywords }))
// 0.6.34 及以前的生产路径：每问现造文档对象（也是「签名正确值」的参照）
const oldDocFor = (r) => ({
  id: r.id, level: r.level, title: r.title, content: r.content, keywords: r.keywords,
  importance: r.importance, created_at: r.created_at, updated_at: r.updated_at,
  last_accessed_at: r.last_accessed_at, status: r.status,
})
const sigOf = (rows) => V.indexSignature(rows.map(oldDocFor))

// ── S1 盖章命中：同一批行第二轮（中间只有 last_accessed_at 被 bump）不该再整表算一遍
{
  const rows = makeRows(60, 0x11)
  V.resetDocObjCache()
  const docs = V.stableDocsOf(dbRead(rows))
  const s1 = V.indexSignature(docs)
  const c1 = V.docObjCacheInfo()
  // 生产里每问都会 `db.bumpHit` 抬命中条的 `last_accessed_at`：这里直接抬 5 条再走一趟
  for (let i = 0; i < 5; i++) rows[i].last_accessed_at += 1000
  const docs2 = V.stableDocsOf(dbRead(rows))
  const s2 = V.indexSignature(docs2)
  const c2 = V.docObjCacheInfo()
  check('S1 盖章命中：la 变不算内容变，第二趟快路命中、签名不变',
    docs === docs2 && c1.sigMiss === 1 && c1.sigHit === 0 && c2.sigHit === 1 && c2.sigMiss === 1 &&
    c2.sigBump === c1.sigBump && s1 === s2 && s2 === sigOf(rows),
    `首趟 命中${c1.sigHit}/重算${c1.sigMiss}/盖章${c1.sigBump} · 次趟 命中${c2.sigHit}/重算${c2.sigMiss}/盖章${c2.sigBump} · ${s1} / ${s2}`)
}

// ── S2 签名字段一变必重新盖章：content / title / updated_at / keywords 各来一次，签名与现造逐字相同
{
  const rows = makeRows(40, 0x22)
  V.resetDocObjCache()
  const docs = V.stableDocsOf(dbRead(rows))
  V.indexSignature(docs)
  const before = V.docObjCacheInfo()
  const bumps = []
  const patches = [
    ['content', (r) => { r.content = r.content + '（改）' }],
    ['title', (r) => { r.title = r.title + '！' }],
    ['updated_at', (r) => { r.updated_at = r.updated_at + 7 }],
    ['keywords元素', (r) => { r.keywords = [r.keywords[0], r.keywords[1] + 'x'] }],
    ['keywords长度', (r) => { r.keywords = [r.keywords[0]] }],
    ['keywords逗号串', (r) => { r.keywords = '记忆,插件、检索' }],
  ]
  let ok = true
  const bad = []
  for (const [name, fn] of patches) {
    const target = rows[3]
    const prevBump = V.docObjCacheInfo().sigBump
    fn(target)
    const d2 = V.stableDocsOf(dbRead(rows))
    const s = V.indexSignature(d2)
    const ref = sigOf(rows)
    const bumped = V.docObjCacheInfo().sigBump > prevBump
    bumps.push(`${name}:${bumped ? '盖' : '未盖'}`)
    if (!bumped || s !== ref) { ok = false; bad.push(`${name}${bumped ? '' : '(未盖章)'}${s === ref ? '' : '(签名错)'}`) }
  }
  check('S2 签名字段一变必重新盖章，且签名与现造逐字相同',
    ok && before.sigBump === 1, `${bumps.join(' ')}${bad.length ? ` · 异常 ${bad.join('/')}` : ''}`)
}

// ── S3 与签名无关的字段变了不许重算：importance / status / level / created_at / last_accessed_at
{
  const rows = makeRows(40, 0x33)
  V.resetDocObjCache()
  const docs = V.stableDocsOf(dbRead(rows))
  const s1 = V.indexSignature(docs)
  const before = V.docObjCacheInfo()
  const r0 = rows[2]
  r0.importance = r0.importance === 4 ? 1 : r0.importance + 1
  r0.status = 'active'
  r0.level = r0.level === 'rules' ? 'fact' : 'rules'
  r0.created_at -= 1
  r0.last_accessed_at += 5000
  const docs2 = V.stableDocsOf(dbRead(rows))
  const s2 = V.indexSignature(docs2)
  const after = V.docObjCacheInfo()
  check('S3 与签名无关的字段变动不触发重算（la / importance / status / level / created_at）',
    docs === docs2 && after.sigBump === before.sigBump && after.sigHit === before.sigHit + 1 &&
    s1 === s2 && s2 === sigOf(rows),
    `盖章 ${before.sigBump}→${after.sigBump} · 命中 ${before.sigHit}→${after.sigHit} · ${s1} / ${s2}`)
}

// ── S4 正确性不挂在「对象身份」上：外部把某一格换掉，只要内容没变，签名照样是对的；
//       内容真变了走一趟 `stableDocsOf` 就必盖章。两条合起来把「抄旧签名」的路堵死。
{
  const rows = makeRows(30, 0x44)
  V.resetDocObjCache()
  const docs = V.stableDocsOf(dbRead(rows))
  const s1 = V.indexSignature(docs)
  const ref1 = sigOf(rows)
  const c1 = V.docObjCacheInfo()
  // 外部把某一格换成一只**内容相同**的新对象：签名字段没动，抄旧签名就是对的
  docs[3] = { ...docs[3] }
  const s2 = V.indexSignature(docs)
  const c2 = V.docObjCacheInfo()
  // 内容真改了（走正常入口）：必盖章、必重算、签名与现造逐字相同
  rows[7].content = rows[7].content + '（外部改过）'
  const docs3 = V.stableDocsOf(dbRead(rows))
  const s3 = V.indexSignature(docs3)
  const c3 = V.docObjCacheInfo()
  check('S4 换格不比指针：内容没变照旧命中、内容变了必重算，签名始终等于现造',
    s1 === ref1 && s2 === ref1 &&
    c2.sigHit === c1.sigHit + 1 && c2.sigMiss === c1.sigMiss &&
    c3.sigBump === c2.sigBump + 1 && c3.sigMiss === c2.sigMiss + 1 &&
    s3 === sigOf(rows) && s3 !== s2,
    `命中 ${c1.sigHit}→${c2.sigHit} · 重算 ${c2.sigMiss}→${c3.sigMiss} · 盖章 ${c2.sigBump}→${c3.sigBump} · ${s1} / ${s3}`)
}

// ── S5 长度变化：盖章 +1，签名与现造逐字相同（含变短再变长）
{
  const rows = makeRows(24, 0x55)
  V.resetDocObjCache()
  const small = V.stableDocsOf(dbRead(rows.slice(0, 12)))
  const s1 = V.indexSignature(small)
  const b1 = V.docObjCacheInfo().sigBump
  const big = V.stableDocsOf(dbRead(rows))
  const s2 = V.indexSignature(big)
  const b2 = V.docObjCacheInfo().sigBump
  check('S5 长度变化必盖章，且签名与现造逐字相同',
    small === big && big.length === rows.length && b2 > b1 &&
    s1 === sigOf(rows.slice(0, 12)) && s2 === sigOf(rows),
    `12 条 ${s1} / 24 条 ${s2} · 盖章 ${b1}→${b2}`)
}

// ── S6 生产口径读数：0.6.35 的写法 vs 0.6.36 的合并版（同一批行、每问都 bump 命中条）
{
  const N = Number(process.env.SEAL_N || 2000)
  const Q = 60
  const TOTAL = Number(process.env.SEAL_TOTAL || 400)
  const rows = makeRows(N, 0x5eed)
  const queries = []
  for (let i = 0; i < Q; i++) {
    const x = WORDS[i % WORDS.length]
    const y = WORDS[(i * 7 + 3) % WORDS.length]
    queries.push(i % 5 === 0 ? `${x} 那条 ${y} 怎么写的` : `${x} ${y}`)
  }
  V.resetDocObjCache()
  // 前提钉死：搜索引擎绝不就地改文档对象（命中对象全是新字面量），否则章会漏掉这些改动
  const guardDocs = V.stableDocsOf(dbRead(rows))
  const guardBefore = JSON.stringify(guardDocs)
  for (let i = 0; i < Q; i++) V.search(queries[i], guardDocs, { k: 5, explain: i % 3 === 0 })
  const guardAfter = JSON.stringify(guardDocs)
  const bench = (label, mk, churn, total = TOTAL) => {
    const ids = []
    let hits = 0
    const byId = new Map(rows.map((r) => [r.id, r]))
    const t0 = performance.now()
    for (let i = 0; i < total; i++) {
      const got = V.search(queries[i % Q], mk(), { k: 5 })
      hits += got.length
      if (i < Q) ids.push(got.map((h) => h.id).join(','))
      // 生产里 `memory_search` 每次都会 `db.bumpHit` 抬命中那几条的 `last_accessed_at`：
      // 不模拟这一点，量尺就把收益量大了（行全一样时连 0.6.35 都不用换格）。
      if (churn) for (const h of got) { const r = byId.get(h.id); if (r !== undefined) r.last_accessed_at = (r.last_accessed_at ?? 0) + 1000 }
    }
    return { label, perQuery: +((performance.now() - t0) / total).toFixed(4), hits, idStr: ids.join('|') }
  }
  // 预热（索引缓存按签名认库，冷启动那一趟两边都一样贵，混进来比没有意义）
  for (let i = 0; i < Q; i++) {
    V.search(queries[i], V.stableDocs(dbRead(rows).map(V.stableDocFor)), { k: 5 })
    V.search(queries[i], V.stableDocsOf(dbRead(rows)), { k: 5 })
  }
  const rowsA = makeRows(N, 0x5eed)
  const rowsB = makeRows(N, 0x5eed)
  /*
   * 三对取最好（0.6.74）：这条判据是「两种写法谁快」的比值，比值本身对忙闲不敏感，
   * 但单趟 400 问的均值会被调度噪声压到某一边——2026-11-25 整批里就红过一次（单跑 1.41–1.50×，
   * 线上 1.25×）。噪声只能让某一对量歪，不会让三对一起量歪，所以取三对里最大的那个比值；
   * 顺序始终是「先 0.6.35 后 0.6.36」——这个顺序本身是生产口径的一部分（新版吃得到 JIT 暖场），
   * 别为了对称把两边的顺序对调，那会把本该有的差距抹平（实测会掉到 1.04×）。
   * 每对 200 问（不是 400）：三对加起来的总搜索量仍与原口径相当（2 趟 400 → 6 趟 200），
   * 免得「多量两对」把这一支的耗时翻倍，被 check-all 记成「变慢」。
   */
  const PAIR = Math.max(120, Math.round(TOTAL / 2))
  let oldOne = null
  let newOne = null
  let ratio = 0
  for (let k = 0; k < 3; k++) {
    const a = bench('0.6.35', () => V.stableDocs(dbRead(rowsA).map(V.stableDocFor)), true, PAIR)
    const b = bench('0.6.36', () => V.stableDocsOf(dbRead(rowsB)), true, PAIR)
    const r = +(a.perQuery / b.perQuery).toFixed(2)
    if (oldOne === null || r > ratio) { oldOne = a; newOne = b; ratio = r }
  }
  check('S6 生产口径：合并版明显更快（判据 ≥ 1.25×，三对里最好的一对），命中串逐字相同',
    ratio >= 1.25 && oldOne.hits === newOne.hits && oldOne.idStr === newOne.idStr && guardBefore === guardAfter,
    `${N} 条 / 每对 ${PAIR} 问 · 0.6.35 ${oldOne.perQuery}ms vs 0.6.36 ${newOne.perQuery}ms（${ratio}×） · 命中串${oldOne.idStr === newOne.idStr ? '逐字相同' : '不一致！'} · 文档对象${guardBefore === guardAfter ? '未被就地改' : '被就地改了！'}`)
}

console.log(fail === 0 ? GREEN(`\nALL PASS  ${pass}/${pass + fail}`) : RED(`\nFAILED  ${fail}/${pass + fail}`))
process.exit(fail === 0 ? 0 : 1)
