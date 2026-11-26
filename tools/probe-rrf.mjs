/**
 * 验收：三段召回 + RRF（PLAN-UNIVERSAL §9 / P1-3 / 判据 U6、U7）。
 *
 * 检的是「三种 scope 的条目不再被塞进一个池子比绝对值」：
 *   Q1 只有一段（全 workspace）时，默认路径与 `rrf:false` 逐字节一致 —— 单池旧行为没被吵醒
 *   Q2 三段都在时，默认顺序 ≠ 单池顺序（融合真的换了序，不是换了个说法）
 *   Q3 融合的偏置只抬本 agent 的 private：原始分最低的私事也能占首位
 *   Q4 关掉偏置（`private_boost:0`）后它回到原位 —— 首位是偏置挣来的，不是数据自带的
 *   Q5 分数归一化：榜首印出来的仍是词法量级的分（不是 RRF 的 0.0x），min_rel 的比例语义不变
 *   Q6 别人写的 private 连「段」都不算：它根本不进候选池，融合也变不出它
 *   Q7 没有分段账（老库 / 归属表被删）时退化成单池：与 `rrf:false` 逐字节一致
 *   Q8 开关的非法值不炸（`private_boost` 给字符串）
 *
 * 全部在临时目录里做，不碰真实库。
 * 用法：node tools/probe-rrf.mjs
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { root } from './_root.mjs'

const mod = (p) => import(pathToFileURL(join(root, p)).href)

let pass = 0
let fail = 0
function check(name, cond, detail = '') {
  if (cond) {
    pass += 1
    console.log(`PASS  ${name}  ${detail}`)
  } else {
    fail += 1
    console.log(`FAIL  ${name}  ${detail}`)
  }
}

const tmp = mkdtempSync(join(tmpdir(), 'macro-rrf-'))
const ws = join(tmp, 'ws')
const home = join(tmp, 'home')
const dataDir = join(tmp, 'data')
for (const d of [ws, home, dataDir]) mkdirSync(d, { recursive: true })

process.env.DSH_HOME = join(tmp, 'dsh-home')
mkdirSync(join(process.env.DSH_HOME, 'storages'), { recursive: true })
writeFileSync(join(process.env.DSH_HOME, 'storages', 'meow-memory-home.json'), JSON.stringify({ homeDir: home }))

const { createMacroEngine } = await mod('lib/core/engine.js')
const Meow = await mod('vendor/meow-memory/lib/index.js')
const eng = await createMacroEngine({ dataDir, homeDir: home, projectDir: '.dsh-meow', meow: { autoMigrate: false } })
const as = (agentId) => ({ cwd: ws, agentId })

const KEY = '三段召回炮台词'
const idOf = (r) => r.value?.id ?? /id\s*=\s*([0-9a-z][0-9a-z-]{5,})/.exec(r.text)?.[1] ?? ''
const write = (content, extra = {}, who = 'codex') =>
  eng.call('memory_remember', { content, level: 'fact', keywords: [KEY], importance: 2, project: 'rrf', ...extra }, as(who))
const search = (extra = {}, who = 'codex') => eng.call('memory_search', { query: KEY, k: 5, ...extra }, as(who))

/** 回执里的命中顺序（`[n] [层 : …] [id8-…]` 的 id8 序列）。 */
const orderOf = (text) => [...String(text).matchAll(/\[\d+\]\s*\[[^\]]*\]\s*\[([0-9a-z]{8})/g)].map((m) => m[1])

// ── 第一次：库里只有 workspace —— 单段，必须走旧路径 ────────────
const w1 = idOf(
  await write('三段召回炮台词：三段召回炮台词的分段方式、三段召回炮台词的边界、三段召回炮台词的开关、三段召回炮台词的偏置、三段召回炮台词的代价，全在这一条里说清楚。'),
)
const w2 = idOf(await write('三段召回：workspace 第二条，简单提一句三段召回炮台词。'))
const singleOn = await search()
const singleOff = await search({ rrf: false })
check(
  'Q1 只有一段时默认与 rrf:false 逐字节一致',
  singleOn.text === singleOff.text && orderOf(singleOn.text).length === 2,
  `命中 ${orderOf(singleOn.text).join(' ')}`,
)

// ── 第二次：补一条 private 与一条 global —— 三段齐了 ────────────
// 私事这条**故意最短、原始分最低**：它要能上首位，只可能是偏置挣来的。
const p1 = idOf(await write('三段召回：私事。', { scope: 'private' }))
const g1 = idOf(await write('三段召回：全局一条，讲三段召回炮台词。', { scope: 'global' }))
const threeOn = await search()
const threeOff = await search({ rrf: false })
const onOrder = orderOf(threeOn.text)
const offOrder = orderOf(threeOff.text)
check('Q2 三段齐了以后，融合的顺序与单池不同', onOrder.join() !== offOrder.join(), `融合 ${onOrder.join(' ')} / 单池 ${offOrder.join(' ')}`)
check(
  'Q3 偏置把本 agent 的 private 抬到首位（它在单池里是末位）',
  onOrder[0] === p1.slice(0, 8) && offOrder[offOrder.length - 1] === p1.slice(0, 8),
  `融合榜首 ${onOrder[0]} · 单池末位 ${offOrder[offOrder.length - 1]} · private ${p1.slice(0, 8)}`,
)

const noBoost = await search({ private_boost: 0 })
const noBoostOrder = orderOf(noBoost.text)
check(
  'Q4 关掉偏置后 private 不再占首位（首位是偏置挣的，不是数据自带的）',
  noBoostOrder[0] !== p1.slice(0, 8),
  `关偏置 ${noBoostOrder.join(' ')}（min_rel 会顺手收掉末位，所以只判「不是首位」）`,
)

const explained = await search({ explain: true })
const headScore = Number((/score=([\d.]+)/.exec(explained.text) ?? [])[1] ?? NaN)
check(
  'Q5 分数仍是词法量级（归一化到榜首原始分，不是 RRF 的 0.0x）',
  Number.isFinite(headScore) && headScore >= 1 && explained.text.includes('bm25='),
  Number.isFinite(headScore) ? `榜首 score=${headScore}` : 'explain 回执里没读到大分',
)

// ── 别人的 private 连段都不算 ────────────────────────────────
const byOther = await search({}, 'claude')
check(
  'Q6 别人的 private 不进任何一段（融合也变不出来）',
  !byOther.text.includes(p1.slice(0, 8)) && orderOf(byOther.text).length > 0,
  byOther.text.split('\n').find((l) => /^\[\d+\]/.test(l))?.slice(0, 100) ?? '一条都没有',
)

// ── 归属表被删 = 没有分段账 = 单池 ───────────────────────────
const db = Meow.getDb(ws, '.dsh-meow')
db.db.exec('DROP TABLE mem_owner')
const orphanOn = await search()
const orphanOff = await search({ rrf: false })
check(
  'Q7 归属表没了以后退化成单池（默认与 rrf:false 逐字节一致）',
  orphanOn.text === orphanOff.text && orderOf(orphanOn.text).length === 4,
  `命中 ${orderOf(orphanOn.text).length} 条，逐字节一致=${orphanOn.text === orphanOff.text}`,
)
check('Q8 开关的非法值不炸（private_boost 给字符串）', (await search({ private_boost: 'abc' })).refused !== true, '照常返回回执')

console.log(`\n${pass} PASS / ${fail} FAIL`)
await eng.close()
process.exit(fail === 0 ? 0 : 1)
