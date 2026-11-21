/**
 * [macro-fusion 0.2.156] 来源一行：这条记忆「从哪来、为什么存在、还有人用吗」。
 *
 * 为什么补这一行：0.2.138 的取代链（chain.js）只解决了谱系的一半——「它被谁接走了」。
 * 另一半一直空着：这条是谁写的、什么时候进库的、是整理封存的还是会话里直接写的、
 * 被读过几次。库里的字段其实都在（source_session / hit_count / last_accessed_at /
 * created_at，还有 dream_log 与 windows 两张表），可**没有一个工具读它们**：
 * `memory_read` 只印 level/标题/项目/目标/正文，最后一句是「需要更多细节就去聊天记录里搜」——
 * 可真相就在库里的三列上，让人肉去猜，等于可追溯性只做了一半。
 *
 * 四条约束（照抄 chain.js 的纪律，因为它们是被同一批教训换来的）：
 *  1. **只在有话说时才出现**：来源会话、整理归属、使用次数三块各自可缺；全缺就返回空串，
 *     绝不给一句「来源未知」占着 token。
 *  2. **不改任何数据**：只读三列 + 两张日志表，不新增列、不回填、不 markAccessed
 *     （读一条记忆的元数据不该让它变成「最近被用过」）。
 *  3. **拿不到就闭嘴**：没工作区 / 没库 / 读失败一律空串——先 existsSync 判存在，
 *     不为了一句说明去 getDb 建一个空库。
 *  4. **近似要说明白**：整理归属是按「created_at 落在某次 dream 的账之前 6 小时内」推的，
 *     所以措辞用「那次整理封存的」，不用肯定句；推不出来就说「当次会话直接写的」。
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import * as Meow from '../../vendor/meow-memory/lib/index.js'
// [macro-fusion 0.2.157] 「这条被改过吗」也是来源的一部分：只在真留过底时才有这一句。
import { revisionNote } from './revisions.js'

/** 整理账本与条目写入时间的最大落差：超过这个数就不认「是那一轮封存的」。 */
const DREAM_WINDOW_MS = 6 * 60 * 60 * 1000
/** 会话 id 形如 `session-4be47b9a-…`；回执里只留 8 位，够对上是哪次。 */
const SESSION_SHORT = 8
/** 迁移脚本写进去的来源标记（meow 自己的口径）。 */
const MIGRATION = 'migration'

function dbFile(workspace, dir) {
  return join(workspace, dir, 'memory.db')
}

function fmtTs(ms) {
  const n = Number(ms)
  if (!Number.isFinite(n) || n <= 0) return ''
  const d = new Date(n)
  if (Number.isNaN(d.getTime())) return ''
  const p = (x) => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

function shortSession(raw) {
  const s = String(raw ?? '').trim()
  if (s === '') return ''
  const body = s.startsWith('session-') ? s.slice('session-'.length) : s
  return body.slice(0, SESSION_SHORT)
}

/**
 * 这一条记忆的来源事实。`missing` 非空表示「读不到」，调用方据此闭嘴。
 *   row: { id, level, created_at, source_session, hit_count, last_accessed_at, corrected }
 *   dream: { at, summary } | null  —— 推定封存它的那一轮整理（可能推不出来）
 */
export function provenanceOf({ workspace = '', dir = '.dsh-meow', id = '' } = {}) {
  const out = { missing: '', row: null, dream: null }
  const want = String(id ?? '').trim()
  if (want === '') {
    out.missing = 'bad-arg'
    return out
  }
  if (typeof workspace !== 'string' || workspace.length === 0) {
    out.missing = 'no-workspace'
    return out
  }
  if (!existsSync(dbFile(workspace, dir))) {
    out.missing = 'no-db'
    return out
  }
  try {
    const read = Meow.readRowsByIds(workspace, dir, [want])
    const rows = Array.isArray(read.rows) ? read.rows : []
    // 短 id 可能撞车（meow 的 id 前 8 位是写入时刻）：只认前缀真正对得上的那条。
    const row = rows.find((r) => String(r.id ?? '').startsWith(want)) ?? rows[0] ?? null
    if (row === null) {
      out.missing = 'not-found'
      return out
    }
    out.row = {
      id: String(row.id ?? ''),
      level: String(row.sessionLevel ?? ''),
      created_at: Number(row.created_at ?? 0),
      source_session: String(row.source_session ?? ''),
      hit_count: Number(row.hit_count ?? 0),
      last_accessed_at: row.last_accessed_at == null ? null : Number(row.last_accessed_at),
      corrected: Number(row.corrected ?? 0) === 1,
    }
    const created = out.row.created_at
    if (created > 0) {
      const logs = Meow.getDb(workspace, dir)
        .p('SELECT run_at, summary FROM dream_log WHERE run_at IS NOT NULL ORDER BY run_at ASC')
        .all()
      for (const log of Array.isArray(logs) ? logs : []) {
        const at = Number(log.run_at ?? 0)
        // 整理先写条目、再落账，所以账在条目之后；落差太大就不是同一轮。
        if (at < created) continue
        if (at - created > DREAM_WINDOW_MS) break
        out.dream = { at, summary: String(log.summary ?? '') }
        break
      }
    }
    return out
  } catch (e) {
    out.missing = `read-failed: ${e instanceof Error ? e.message : String(e)}`
    return out
  }
}

/**
 * 回执里的那一行。读不到 / 什么都没有 → 空串（不占位、不猜）。
 */
export function provenanceNote({ workspace = '', dir = '.dsh-meow', id = '' } = {}) {
  const p = provenanceOf({ workspace, dir, id })
  if (p.missing.length > 0 || p.row === null) return ''
  const parts = []
  const sess = String(p.row.source_session ?? '')
  const wrote = fmtTs(p.row.created_at)
  if (sess === MIGRATION) {
    parts.push(`来源：老库迁移过来的${wrote ? `（${wrote} 落库）` : ''}，没有原始会话`)
  } else if (sess !== '') {
    const short = shortSession(sess)
    if (p.dream !== null) {
      const at = fmtTs(p.dream.at)
      parts.push(`来源：会话 ${short}${at ? ` 在 ${at} 那次整理里封存` : ' 在某次整理里封存'}`)
    } else {
      parts.push(`来源：会话 ${short} 当次直接写进来${wrote ? `（${wrote}）` : ''}`)
    }
  } else {
    // 来源会话都空着：只说「哪天进的库」，别把「没记来源」说得像「没有来源」。
    if (wrote) parts.push(`来源：没有记来源会话，${wrote} 进的库`)
  }
  if (p.row.hit_count > 0) {
    const last = fmtTs(p.row.last_accessed_at)
    parts.push(`被读过 ${p.row.hit_count} 次${last ? `（最近 ${last}）` : ''}`)
  } else {
    parts.push('还没被检索用过')
  }
  // [macro-fusion 0.2.157] 改过几次：留底表里没有这条就是没改过，一个字都不多说。
  const rev = revisionNote({ workspace, dir, id })
  if (rev.length > 0) parts.push(rev.replace(/^🕘\s*/, '').replace(/，留底的旧版本能退回去$/, ''))
  if (p.row.corrected) parts.push('主人纠正过')
  if (parts.length === 0) return ''
  return `📜 ${parts.join(' · ')}`
}
