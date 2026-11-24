#!/usr/bin/env node
// 每问一次的文档身份（0.6.35）量尺：`stableDocFor` / `stableDocs` 到底省了什么、有没有改口径。
//
// 为什么要有这一支：0.6.35 动的是**进打分之前**那一层——`memory_search` 原来每次都用
// `filtered.map(docFor)` 现造整库文档，而引擎的条级哈希缓存（`SIG_DOC_CACHE`，WeakMap 按对象身份）
// 与行缓存（`SIG_ROW_CACHE`，按数组身份）都只认身份。新对象一到，两个缓存全落空：每问一次把整库的
// content / title 重新混一遍签名。实测（10,000 条 / 600 问）：每问新建 12.5965ms、复用同一批 1.1072ms、
// 只换数组不改对象 1.8460ms —— 11.4 倍里有 10.7 倍是「重新算签名」，0.74 倍是「行缓存用不上」。
//
// 这一层不许改任何判分口径，所以判据分两头：
//   ① **省了多少**：同一批行（每问现拷，像 SQLite 每问查出来那样）走两条路，比 perQuery；
//   ② **一位不动**：两条路的命中 id 串逐字相同，且 `indexSignature` 逐字相同。
// 剩下的是复用层的边界：十个字段任一变动必换对象、上限会裁、脏行不炸、数组换格/换长/换序不串味。
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

// ── D0 形状在位：这一段真的接在生产入口上（不是只导出了两个没人用的函数）
// 0.6.36 起生产入口改成合并版 `stableDocsOf(filtered)`（一趟 map+换格+盖章），旧写法 `stableDocs(filtered.map(docFor))`
// 只作历史形状保留在注释与老版本里——这里「新旧都认」，判的是「接上了」，不是「必须长成哪一句」。
{
  const has = (s) => ENGINE.includes(s)
  const ok = has('function stableDocFor(r) {') &&
    has('function stableDocs(list) {') &&
    has('const docFor = stableDocFor;') &&
    (has('const docs = stableDocsOf(filtered);') || has('const docs = stableDocs(filtered.map(docFor));')) &&
    has('  stableDocFor,\n  stableDocs,') &&
    has('docObjCacheInfo,') && has('resetDocObjCache,')
  check('D0 身份层接在 memory_search 上，且四个入口都导出', ok)
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
      id: '0mdoc' + String(i).padStart(5, '0'),
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
// 0.6.34 及以前的生产路径：每问现造文档对象
const oldDocFor = (r) => ({
  id: r.id, level: r.level, title: r.title, content: r.content, keywords: r.keywords,
  importance: r.importance, created_at: r.created_at, updated_at: r.updated_at,
  last_accessed_at: r.last_accessed_at, status: r.status,
})

// ── D1 复用计数：同一批行走两轮，第二轮一条对象都不该新造、数组该原样还回来
{
  const rows = makeRows(40, 0x11)
  V.resetDocObjCache()
  const a1 = V.stableDocs(dbRead(rows).map(V.stableDocFor))
  const c1 = V.docObjCacheInfo()
  const a2 = V.stableDocs(dbRead(rows).map(V.stableDocFor))
  const c2 = V.docObjCacheInfo()
  check('D1 复用：第二轮 40 条全复用、数组还回同一只',
    c1.fresh === 40 && c1.reuse === 0 && c1.arrFresh === 1 && c1.arrReuse === 0 &&
    c2.fresh === 40 && c2.reuse === 40 && c2.arrFresh === 1 && c2.arrReuse === 1 &&
    a1 === a2 && a1[0] === a2[0],
    `首轮 新${c1.fresh}/复用${c1.reuse} 数组${c1.arrFresh}/${c1.arrReuse} · 次轮 新${c2.fresh}/复用${c2.reuse} 数组${c2.arrFresh}/${c2.arrReuse}`)
}

// ── D2 十个字段任一变动必换对象：旧对象一个字都不许被改（缓存里还躺着它）
{
  const base = makeRows(3, 0x22)[0]
  V.resetDocObjCache()
  const first = V.stableDocFor({ ...base, keywords: base.keywords.slice() })
  const probes = [
    ['content', { content: base.content + '（改）' }],
    ['title', { title: base.title + '！' }],
    ['keywords元素', { keywords: [base.keywords[0], base.keywords[1] + 'x'] }],
    ['keywords长度', { keywords: base.keywords.slice(0, 1) }],
    ['importance', { importance: base.importance === 4 ? 1 : base.importance + 1 }],
    ['status', { status: 'stale' }],
    ['level', { level: base.level === 'rules' ? 'fact' : 'rules' }],
    ['created_at', { created_at: base.created_at - 1 }],
    ['updated_at', { updated_at: base.updated_at + 1 }],
    ['last_accessed_at', { last_accessed_at: base.last_accessed_at + 1 }],
  ]
  const snap = JSON.stringify(first)
  let swapped = 0
  const missed = []
  for (const [name, patch] of probes) {
    const next = V.stableDocFor({ ...base, keywords: base.keywords.slice(), ...patch })
    if (next !== first) swapped += 1
    else missed.push(name)
  }
  check('D2 十个字段任一动必换对象，旧对象不被就地改',
    swapped === probes.length && JSON.stringify(first) === snap,
    `换了 ${swapped}/${probes.length}${missed.length ? ` · 漏 ${missed.join('/')}` : ''} · 旧对象未变`)
}

// ── D3 一位不动：新路径数组的签名与「每问现造」逐字相同（含 keywords 是逗号串的脏行）
{
  const rows = makeRows(120, 0x33)
  rows[3].keywords = '记忆,插件、检索；缓存'
  rows[7].keywords = null
  rows[9].keywords = ['记忆']
  V.resetDocObjCache()
  const fresh = rows.map(oldDocFor)
  const stable = V.stableDocs(rows.map(V.stableDocFor))
  const a = V.indexSignature(fresh)
  const b = V.indexSignature(stable)
  const c = V.indexSignature(V.stableDocs(rows.map(V.stableDocFor)))
  check('D3 签名与现造逐字相同（脏 keywords 三种形态都算上）', a === b && b === c, `${a} / ${b} / ${c}`)
}

// ── D4 上限会裁：塞满 MAX+5 条不同 id，条数不外溢
{
  const rows = makeRows(200, 0x44)
  V.resetDocObjCache()
  const max = V.docObjCacheInfo().max
  for (let i = 0; i < 5; i++) V.stableDocFor({ ...rows[i % rows.length], id: '0extra' + i })
  // 上限是 20,000；这里只验证「超出就裁」这条口径本身，不真塞两万条（探针要快）
  const before = V.docObjCacheInfo()
  const okCap = Number.isFinite(max) && max > 0 && before.size <= max
  check('D4 上限口径在位（size ≤ max，裁剪有账）', okCap,
    `size ${before.size} / max ${max} · trimmed ${before.trimmed}`)
}

// ── D5 脏行不炸：null / 标量 / 缺字段都走旧路，签名照样对得上
{
  V.resetDocObjCache()
  const rows = makeRows(20, 0x55)
  rows[5] = null
  rows[11] = 'oops'
  delete rows[13].status
  delete rows[14].last_accessed_at
  let threw = null
  let sig = null
  try {
    const docs = V.stableDocs(rows.filter((r) => r && typeof r === 'object').map(V.stableDocFor))
    sig = V.indexSignature(docs)
  } catch (e) { threw = String(e && e.message) }
  const ref = V.indexSignature(rows.filter((r) => r && typeof r === 'object').map(oldDocFor))
  check('D5 脏行不炸（null / 标量 / 缺字段）', threw === null && sig === ref, threw ?? `${sig} / ${ref}`)
}

// ── D6 数组身份恒定：一样就还回去、不一样就**就地换格**（身份不许换，换了引擎行缓存整表作废）
// 为什么这条是硬的：`memory_search` 每次都会 `db.bumpHit` 抬命中那几条的 `last_accessed_at`，
// 所以第二问的行里总有几条不一样。若此时还回新数组，行缓存按数组身份判鲜 → 整库签名重算，收益归零。
{
  const rows = makeRows(6, 0x66)
  V.resetDocObjCache()
  const a = V.stableDocs(rows.map(V.stableDocFor))
  const again = V.stableDocs(a.slice())
  const swappedList = a.slice(); [swappedList[0], swappedList[1]] = [swappedList[1], swappedList[0]]
  const b = V.stableDocs(swappedList)
  const shortList = a.slice(0, 4)
  const c = V.stableDocs(shortList)
  const sameSlots = b.length === a.length && b.every((x, i) => x === swappedList[i])
  const shortOk = c.length === 4 && c.every((x, i) => x === shortList[i])
  check('D6 数组身份恒定：一样就还回、换序/换长就地换格（长度跟着变）',
    again === a && b === a && c === a && sameSlots && shortOk,
    `原样复制 ${again === a} · 换序后同一只 ${b === a} 且逐格正确 ${sameSlots} · 换长后同一只 ${c === a} 且 length ${c.length}`)
}

// ── D7 生产口径读数：同一批行两条路，比 perQuery（命中串必须逐字相同）
{
  const N = Number(process.env.DOCID_N || 2000)
  const Q = 60
  const TOTAL = Number(process.env.DOCID_TOTAL || 400)
  const rows = makeRows(N, 0x5eed)
  const queries = []
  for (let i = 0; i < Q; i++) {
    const x = WORDS[i % WORDS.length]
    const y = WORDS[(i * 7 + 3) % WORDS.length]
    queries.push(i % 5 === 0 ? `${x} 那条 ${y} 怎么写的` : `${x} ${y}`)
  }
  V.resetDocObjCache()
  // 复用层的前提是「搜索引擎绝不就地改文档对象」：命中对象全是新字面量（`hits.push({ ...docs[di] … })`），
  // 一旦哪天有人改成直接吐文档对象再往上写 `_raw`，缓存里的对象就会带上一问的残留。这里钉住它。
  const guardDocs = V.stableDocs(dbRead(rows).map(V.stableDocFor))
  const guardBefore = JSON.stringify(guardDocs)
  for (let i = 0; i < Q; i++) V.search(queries[i], guardDocs, { k: 5, explain: i % 3 === 0 })
  const guardAfter = JSON.stringify(guardDocs)
  // 预热两条路（索引与向量都按签名/内容缓存，冷热混在一起比没有意义）
  for (let i = 0; i < Q; i++) {
    V.search(queries[i], dbRead(rows).map(oldDocFor), { k: 5 })
    V.search(queries[i], V.stableDocs(dbRead(rows).map(V.stableDocFor)), { k: 5 })
  }
  const bench = (label, mk, churn) => {
    const ids = []
    let hits = 0
    const byId = new Map(rows.map((r) => [r.id, r]))
    const t0 = performance.now()
    for (let i = 0; i < TOTAL; i++) {
      const got = V.search(queries[i % Q], mk(), { k: 5 })
      hits += got.length
      if (i < Q) ids.push(got.map((h) => h.id).join(','))
      // 生产里 `memory_search` 每次都会 `db.bumpHit` 抬命中那几条的 `last_accessed_at`（引擎 `:6513`），
      // 所以下一问从库里查出来的行**一定有几条不一样**。不模拟这一点，量尺就把收益量大了。
      if (churn) for (const h of got) { const r = byId.get(h.id); if (r !== undefined) r.last_accessed_at = (r.last_accessed_at ?? 0) + 1000 }
    }
    const ms = performance.now() - t0
    return { label, perQuery: +(ms / TOTAL).toFixed(4), hits, idStr: ids.join('|') }
  }
  const oldOne = bench('旧路径', () => dbRead(rows).map(oldDocFor), false)
  const newOne = bench('新路径', () => V.stableDocs(dbRead(rows).map(V.stableDocFor)), false)
  const ratio = +(oldOne.perQuery / newOne.perQuery).toFixed(2)
  // 抬过命中条目的副本：这一轮才是生产真样子（行每问都在变）
  const rowsChurn = makeRows(N, 0x5eed)
  const oldChurn = bench('旧路径·有 bump', () => dbRead(rowsChurn).map(oldDocFor), true)
  const newChurn = bench('新路径·有 bump', () => V.stableDocs(dbRead(rowsChurn).map(V.stableDocFor)), true)
  const ratioChurn = +(oldChurn.perQuery / newChurn.perQuery).toFixed(2)
  check('D7 生产口径：同一批行新路径明显更快（判据 ≥ 2.0；含 bumpHit 那一轮也要 ≥ 2.0）',
    ratio >= 2 && ratioChurn >= 2 && oldOne.hits === newOne.hits && oldOne.idStr === newOne.idStr &&
    oldChurn.hits === newChurn.hits && oldChurn.idStr === newChurn.idStr && guardBefore === guardAfter,
    `${N} 条 / ${TOTAL} 问 · 无 bump 旧 ${oldOne.perQuery} vs 新 ${newOne.perQuery}ms（${ratio}×） · 有 bump 旧 ${oldChurn.perQuery} vs 新 ${newChurn.perQuery}ms（${ratioChurn}×） · 命中串${oldOne.idStr === newOne.idStr && oldChurn.idStr === newChurn.idStr ? '逐字相同' : '不一致！'} · 文档对象${guardBefore === guardAfter ? '未被就地改' : '被就地改了！'}`)
}

console.log(fail === 0 ? GREEN(`\nALL PASS  ${pass}/${pass + fail}`) : RED(`\nFAILED  ${fail}/${pass + fail}`))
process.exit(fail === 0 ? 0 : 1)
