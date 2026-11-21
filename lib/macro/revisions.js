/**
 * [macro-fusion 0.2.157] 改前留一版：可更新性的另一半是「改坏了能退回来」。
 *
 * 为什么有这一层：0.2.156 让读者看清「这条谁写的、还有人用吗」，但一眼看不见的是
 * 「它被改过什么」。真库体检：513 条 active 里 **412 条** `updated_at` 明显晚于
 * `created_at`（其中 lesson 260 条），而正文里带「（已被取代：…）」的只有 2 条——
 * 说明绝大多数「改」是**正文被重写**，不是取代。重写是破坏性的：旧正文当场就没了，
 * 事后一句「我改错了」没有任何退路。
 *
 * 所以这里只做三件事，一件都不多：
 *  1. `saveRevision`：每次要写正文之前，把**旧正文**留底（同一条最多留 3 版，
 *     与上一版逐字相同时不重复记——留底不是记流水账）。
 *  2. `revisionContent`：按「上 N 版」取回一份旧正文，给 `memory_update(restore:N)` 用。
 *  3. `revisionNote`：给回执一行「改过几次、最近一次是什么时候」，让「这条在演进」
 *     和「这条一直没动」在阅读时就能分开。
 *
 * 纪律（与 chain.js / provenance.js 同源，都是被同一批教训换来的）：
 *  - **没库不说话、也不建库**：先 `existsSync`，读不到就返回 null / 空串。
 *  - **只读不写地读**：`revisionNote` 不 markAccessed、不动 hit_count。
 *  - **留底有上限**：`REVISION_KEEP = 3`，常量只有一个出口（写侧清理与读侧范围都读它）。
 *  - **纯度优先**：`applyPatches` / `appendTo` / `shrinkGuard` 是纯函数，不碰库——
 *    这样「按句改」的判据可以在探针里逐条量，不用先造一个库。
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import * as Meow from '../../vendor/meow-memory/lib/index.js'

const REVISION_KEEP = 3
const TABLE = 'memory_revisions'
/** 结果比原文短到这个比例以下，必须显式 `allowShrink` 才许写（防「按句改」变成「整段删」）。 */
const SHRINK_FLOOR = 0.7

const DDL = `CREATE TABLE IF NOT EXISTS ${TABLE} (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  memory_id TEXT NOT NULL,
  level TEXT,
  title TEXT,
  content TEXT NOT NULL,
  reason TEXT,
  saved_at INTEGER NOT NULL
)`
const DDL_INDEX = `CREATE INDEX IF NOT EXISTS ${TABLE}_memory_id ON ${TABLE}(memory_id)`

function dbFile(workspace, dir) {
  return join(workspace, dir, 'memory.db')
}

function hasDb(workspace, dir) {
  if (typeof workspace !== 'string' || workspace === '') return false
  return existsSync(dbFile(workspace, dir))
}

function readyDb(workspace, dir) {
  const db = Meow.getDb(workspace, dir)
  db.p(DDL).run()
  db.p(DDL_INDEX).run()
  return db
}

function fmtTs(ms) {
  const n = Number(ms)
  if (!Number.isFinite(n) || n <= 0) return ''
  const d = new Date(n)
  if (Number.isNaN(d.getTime())) return ''
  const p = (x) => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** 当前这一条的正文与层（给「按句改」当底稿）。读不到就说读不到，不编。 */
export function currentRow({ workspace = '', dir = '.dsh-meow', id = '' } = {}) {
  const out = { missing: '', row: null }
  const want = String(id ?? '').trim()
  if (want === '') {
    out.missing = 'bad-arg'
    return out
  }
  if (!hasDb(workspace, dir)) {
    out.missing = 'no-db'
    return out
  }
  try {
    const read = Meow.readRowsByIds(workspace, dir, [want])
    const rows = Array.isArray(read.rows) ? read.rows : []
    const row = rows.find((r) => String(r.id ?? '').startsWith(want)) ?? rows[0] ?? null
    if (row === null) {
      out.missing = 'not-found'
      return out
    }
    out.row = {
      id: String(row.id ?? ''),
      level: String(row.sessionLevel ?? ''),
      title: String(row.title ?? ''),
      content: String(row.content ?? ''),
    }
    return out
  } catch (e) {
    out.missing = `read-failed: ${e instanceof Error ? e.message : String(e)}`
    return out
  }
}

/**
 * 按句改：`patches` = `[{ find, replace }]`。
 *  **唯一命中**才算数：0 次＝这段不在这一版正文里（可能已经改过或被改写）；多次＝
 *  这句话不足以定位，要人补上下文。两种情况都**一个字都不写**，把理由原样说出来。
 * 补丁按顺序作用（后一条看得到前一条的结果），这样「先改 A 再改 B」的直觉不会被推翻。
 */
export function applyPatches(content, patches) {
  let next = String(content ?? '')
  const list = Array.isArray(patches) ? patches : []
  if (list.length === 0) return { ok: false, why: 'patch 是空的：一条 {find, replace} 都没有' }
  let changed = 0
  for (let i = 0; i < list.length; i += 1) {
    const one = list[i] ?? {}
    const find = typeof one.find === 'string' ? one.find : ''
    const replace = typeof one.replace === 'string' ? one.replace : ''
    if (find === '') return { ok: false, why: `第 ${i + 1} 条 patch 的 find 是空串（空串会命中每一处，等于没定位）` }
    const parts = next.split(find)
    const hits = parts.length - 1
    if (hits === 0) {
      return { ok: false, why: `第 ${i + 1} 条 patch 要找的「${find.slice(0, 40)}」在这一版正文里找不到——可能已经改过，或者原文不是这几个字` }
    }
    if (hits > 1) {
      return { ok: false, why: `第 ${i + 1} 条 patch 要找的「${find.slice(0, 40)}」出现了 ${hits} 次，定位不到唯一一处——把上下文带长一点再改` }
    }
    next = parts.join(replace)
    changed += 1
  }
  return { ok: true, content: next, changed }
}

/** 追加一段：放在正文末尾，中间空一行（追一段不该把上一段连成一句）。 */
export function appendTo(content, extra) {
  const before = String(content ?? '').replace(/\s+$/, '')
  const add = String(extra ?? '').trim()
  if (add === '') return { ok: false, why: 'append 是空的：没有要追加的内容' }
  return { ok: true, content: before === '' ? add : `${before}\n\n${add}` }
}

/**
 * 防误删闸门：按句改的本意是「改一句」，不该顺手把整段删光。
 * 比原文短到 `SHRINK_FLOOR` 以下、又没有 `allowShrink: true`，就拒绝写。
 * 短文本（< 40 字）不设闸——一句话本来就可以被改短，20 字砍到 8 字也未必是事故。
 */
export function shrinkGuard(before, after, allowShrink = false) {
  const b = String(before ?? '').length
  const a = String(after ?? '').length
  if (allowShrink === true) return { ok: true }
  if (b < 40) return { ok: true }
  if (a >= Math.ceil(b * SHRINK_FLOOR)) return { ok: true }
  return {
    ok: false,
    why: `改完只剩 ${a} 字，原文 ${b} 字（少了 ${b - a} 字，超过三成）——这看着像整段被删，不像改一句。真要删就带 allowShrink: true 再调一次。`,
  }
}

/** 留底。只留旧正文，不覆盖任何东西；同一条最多 `REVISION_KEEP` 版。 */
export function saveRevision({ workspace = '', dir = '.dsh-meow', id = '', level = '', title = '', content = '', reason = '' } = {}) {
  const want = String(id ?? '').trim()
  const body = String(content ?? '')
  if (want === '' || body === '') return { saved: false, why: '空 id 或空正文，没什么可留的' }
  if (!hasDb(workspace, dir)) return { saved: false, why: 'no-db' }
  try {
    const db = readyDb(workspace, dir)
    const newest = db.p(`SELECT content FROM ${TABLE} WHERE memory_id = ? ORDER BY id DESC LIMIT 1`).get(want)
    if (newest && String(newest.content ?? '') === body) {
      // 上一版跟这一版逐字一样：再记一条只是流水账，读的人还得自己分辨哪条才是「上一版」。
      return { saved: false, why: 'same-as-last', kept: revisionCount({ workspace, dir, id: want }) }
    }
    db.p(`INSERT INTO ${TABLE} (memory_id, level, title, content, reason, saved_at) VALUES (?,?,?,?,?,?)`).run(
      want,
      String(level ?? ''),
      String(title ?? ''),
      body,
      String(reason ?? ''),
      Date.now(),
    )
    db.p(
      `DELETE FROM ${TABLE} WHERE memory_id = ? AND id NOT IN (SELECT id FROM ${TABLE} WHERE memory_id = ? ORDER BY id DESC LIMIT ${REVISION_KEEP})`,
    ).run(want, want)
    return { saved: true, kept: revisionCount({ workspace, dir, id: want }) }
  } catch (e) {
    return { saved: false, why: `save-failed: ${e instanceof Error ? e.message : String(e)}` }
  }
}

export function revisionCount({ workspace = '', dir = '.dsh-meow', id = '' } = {}) {
  const want = String(id ?? '').trim()
  if (want === '' || !hasDb(workspace, dir)) return 0
  try {
    const row = Meow.getDb(workspace, dir).p(`SELECT COUNT(*) AS n FROM ${TABLE} WHERE memory_id = ?`).get(want)
    return Number(row?.n ?? 0)
  } catch {
    return 0
  }
}

/** 由新到旧列出留底的版本（不含正文，正文用 `revisionContent` 取）。 */
export function listRevisions({ workspace = '', dir = '.dsh-meow', id = '', limit = REVISION_KEEP } = {}) {
  const want = String(id ?? '').trim()
  if (want === '' || !hasDb(workspace, dir)) return []
  try {
    const rows = Meow.getDb(workspace, dir)
      .p(`SELECT id, level, title, reason, saved_at, length(content) AS bytes FROM ${TABLE} WHERE memory_id = ? ORDER BY id DESC LIMIT ?`)
      .all(want, Math.max(1, Math.min(REVISION_KEEP, Number(limit) || REVISION_KEEP)))
    return (Array.isArray(rows) ? rows : []).map((r) => ({
      id: Number(r.id ?? 0),
      level: String(r.level ?? ''),
      title: String(r.title ?? ''),
      reason: String(r.reason ?? ''),
      saved_at: Number(r.saved_at ?? 0),
      bytes: Number(r.bytes ?? 0),
    }))
  } catch {
    return []
  }
}

/** 上 `back` 版的正文（back=1 就是改之前那一版）。没有就 null。 */
export function revisionContent({ workspace = '', dir = '.dsh-meow', id = '', back = 1 } = {}) {
  const want = String(id ?? '').trim()
  const n = Number(back)
  if (want === '' || !hasDb(workspace, dir)) return null
  if (!Number.isInteger(n) || n < 1 || n > REVISION_KEEP) return null
  try {
    const row = Meow.getDb(workspace, dir)
      .p(`SELECT content FROM ${TABLE} WHERE memory_id = ? ORDER BY id DESC LIMIT 1 OFFSET ?`)
      .get(want, n - 1)
    return row ? String(row.content ?? '') : null
  } catch {
    return null
  }
}

/** 回执里那一行：只在真改过的时候出现，改过几次、最近一次什么时候。 */
export function revisionNote({ workspace = '', dir = '.dsh-meow', id = '' } = {}) {
  const want = String(id ?? '').trim()
  if (want === '' || !hasDb(workspace, dir)) return ''
  let rows = []
  try {
    rows = Meow.getDb(workspace, dir)
      .p(`SELECT saved_at FROM ${TABLE} WHERE memory_id = ? ORDER BY id DESC LIMIT ${REVISION_KEEP}`)
      .all(want)
  } catch {
    return ''
  }
  const list = Array.isArray(rows) ? rows : []
  if (list.length === 0) return ''
  const last = fmtTs(list[0].saved_at)
  return `🕘 改过 ${list.length} 次${last ? `（最近 ${last}）` : ''}，留底的旧版本能退回去`
}

export { REVISION_KEEP, SHRINK_FLOOR }
