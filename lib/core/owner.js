/**
 * 归属账（PLAN-UNIVERSAL §4.1 / P1-2 的第一半）——**这条记忆是谁写的、能给谁看**。
 *
 * 为什么要单独一张旁表而不是给 meow 的七张层表加列：
 *   · meow 的层表是它自己的资产，`ALTER TABLE` 一次就是一次真迁移，七张表七个 ALTER；
 *   · 旁表用 `CREATE TABLE IF NOT EXISTS` 就能存在，老库第一次写入时自动补上，
 *     不写在库里的条目就是「没有归属记录」，读的时候照旧、不报错；
 *   · 归属是**我们这一层**的概念（`agentId` 只有宿主知道），meow 不该被迫知道。
 *
 * 三条纪律：
 *   1. `owner` 只能由服务端填（`exec.agent.id`），工具的入参改不动它——否则「谁写的」可以伪造；
 *   2. 记不上不许影响写入：归属是增强，把记忆写坏才是事故，所有异常吞掉并回一条 note；
 *   3. `update` 不改 `owner`，只把 `last_editor` 换人（PLAN U6）。
 */

/** 作用域三态。 */
export const SCOPES = ['private', 'workspace', 'global']

/** 层 → 默认 scope（PLAN §4.3）。人格是自己的，规矩与事实是工作区的。 */
export const DEFAULT_SCOPE_BY_LEVEL = {
  soul: 'private',
  user: 'private',
  rules: 'workspace',
  fact: 'workspace',
  lesson: 'workspace',
  topic: 'workspace',
  project: 'workspace',
}

const CREATE_SQL = `CREATE TABLE IF NOT EXISTS mem_owner (
  id TEXT PRIMARY KEY,
  owner TEXT,
  scope TEXT,
  visibility TEXT,
  level TEXT,
  last_editor TEXT,
  created_at INTEGER,
  updated_at INTEGER
)`

const CREATE_IDX = `CREATE INDEX IF NOT EXISTS mem_owner_owner ON mem_owner(owner, scope)`

/** meow 的 MemoryDb（有 p/exec 风格）与裸 node:sqlite 都能跑。 */
function prepareOf(db) {
  if (!db) return null
  if (typeof db.p === 'function') return db.p.bind(db)
  if (typeof db.prepare === 'function') return db.prepare.bind(db)
  return null
}

export function defaultScopeOf(level) {
  return DEFAULT_SCOPE_BY_LEVEL[String(level ?? '')] ?? 'workspace'
}

/** 把入参里的 scope 收敛成三态之一；给不出合法值就退回该层的默认值（不猜、不报错）。 */
export function normalizeScope(asked, level) {
  const v = typeof asked === 'string' ? asked.trim().toLowerCase() : ''
  return SCOPES.includes(v) ? v : defaultScopeOf(level)
}

/**
 * 造一个归属账读写口。
 * @param {object} db meow 的库句柄（有 `p()`）
 */
export function createOwnerStore(db) {
  let ready = false
  let broken = null

  function ensure() {
    if (ready) return true
    if (broken) return false
    try {
      db.exec?.(CREATE_SQL) ?? db.db?.exec?.(CREATE_SQL)
      if (!db.exec && !db.db?.exec) throw new Error('这个库句柄没有 exec()')
      return (ready = true)
    } catch (err) {
      broken = String(err?.message ?? err)
      return false
    }
  }

  // 建表偶尔成功、偶尔失败：两种句柄的 exec 在不同版本里可能只存在一个，这里两种都试。
  function ensureTable() {
    if (ready) return true
    try {
      if (typeof db.exec === 'function') db.exec(CREATE_SQL)
      else if (typeof db.db?.exec === 'function') db.db.exec(CREATE_SQL)
      else throw new Error('这个库句柄没有 exec()')
      if (typeof db.exec === 'function') db.exec(CREATE_IDX)
      else db.db.exec(CREATE_IDX)
      ready = true
      return true
    } catch (err) {
      broken = String(err?.message ?? err)
      return false
    }
  }

  const p = prepareOf(db)

  return {
    /** 表在不在（只读）。 */
    get available() {
      return p !== null && (ready || ensureTable())
    },
    get error() {
      return broken
    },
    /**
     * 记一条归属。已存在时只更新 `last_editor` / `scope` / `visibility`，**不动 `owner`**。
     * @returns {boolean} 记上了没有（失败不影响调用方继续写记忆）
     */
    record(id, { owner, scope, visibility, level, editor } = {}) {
      if (!id || !p) return false
      if (!ensureTable()) return false
      const now = Date.now()
      const own = typeof owner === 'string' && owner.trim() !== '' ? owner.trim() : null
      const sc = normalizeScope(scope, level)
      const vis = normalizeScope(visibility, level) === 'workspace' && sc === 'private' ? 'private' : normalizeScope(visibility, level)
      try {
        const row = p('SELECT owner, scope, visibility FROM mem_owner WHERE id = ?').get(id)
        if (row) {
          p('UPDATE mem_owner SET owner = COALESCE(?, owner), scope = ?, visibility = ?, last_editor = ?, updated_at = ? WHERE id = ?')
            .run(own, sc, vis, editor ?? own, now, id)
        } else {
          p('INSERT INTO mem_owner (id, owner, scope, visibility, level, last_editor, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)')
            .run(id, own, sc, vis, String(level ?? ''), editor ?? own, now, now)
        }
        return true
      } catch {
        return false
      }
    },
    /**
     * 只换「谁最后动过」，不碰 owner / scope / visibility。
     * `memory_update` 走这条：改内容不等于改主人，也不该顺手把别人设的边界改回默认。
     */
    touch(id, { editor } = {}) {
      if (!id || !p || !ensureTable()) return false
      try {
        p('UPDATE mem_owner SET last_editor = ?, updated_at = ? WHERE id = ?').run(editor ?? null, Date.now(), id)
        return true
      } catch {
        return false
      }
    },
    /** 按 id 批量取归属。查不到的不出现在返回里（不是错误，是「没有归属记录」）。 */
    ownersOf(ids = []) {
      const want = [...new Set(ids.filter((x) => typeof x === 'string' && x !== ''))]
      const out = new Map()
      if (want.length === 0 || !p || !ensureTable()) return out
      try {
        const marks = want.map(() => '?').join(',')
        for (const row of p(`SELECT id, owner, scope, visibility, last_editor FROM mem_owner WHERE id IN (${marks})`).all(...want)) {
          out.set(row.id, row)
        }
      } catch {
        /* 读不出来就当没有 */
      }
      return out
    },
    /**
     * 对 `selfId` 来说**看不见**的条目 id 集合：别人写的 private。
     *
     * 三条口径，都是有意的：
     *   · 只挡 `private`。`workspace` / `global` 就是拿来共享的，挡掉等于把功能关掉；
     *   · `owner` 为空的 private **不挡**——那是没有归属记录的老条目（0.9 之前写的全是），
     *     一挡就等于把历史记忆整库藏起来，这不是隐私，这是事故；
     *   · 查表失败返回空集：宁可多看见一条，不可让检索整支崩掉（同 record 的纪律）。
     */
    hiddenFor(selfId) {
      const out = new Set()
      const self = typeof selfId === 'string' && selfId !== '' ? selfId : null
      if (self === null || !p || !ensureTable()) return out
      try {
        for (const row of p(`SELECT id FROM mem_owner
                              WHERE scope = 'private' AND owner IS NOT NULL AND owner <> ?`).all(self)) {
          out.add(String(row.id))
        }
      } catch {
        /* 读不出来就当没有：可见性降级成「都能看」，不降级成「都看不见」 */
      }
      return out
    },
    /**
     * 全库「短 id → scope」的表（窄：只有两列，不碰正文）。
     *
     * 给三段召回用：检索时要把候选按 `private` / `workspace` / `global` 分三段各自打分，
     * 而 scope 只记在这张旁表里——引擎（meow）不认识 `mem_owner`，也不该认识。
     * 为什么给全表而不是按候选 id 现查：一段 `SELECT ... WHERE id IN (?,?,…)` 也要拼几百个占位符，
     * 而这条窄 SELECT 一次就能读完（几千行、几十 KB），比两遍查询更便宜也更好解释。
     * 读失败返回空表 = 三段退化成一段 = 单池旧行为（同 hiddenFor 的纪律：降级成能看，不降成看不见）。
     */
    scopeMapFor() {
      const out = new Map()
      if (!p || !ensureTable()) return out
      try {
        for (const row of p('SELECT id, scope FROM mem_owner').all()) {
          if (!row || !row.id) continue
          out.set(String(row.id), String(row.scope ?? 'workspace'))
        }
      } catch {
        /* 读不出来就当没有归属：检索退回单池 */
      }
      return out
    },
    /** 谁在这个库里写过东西（UI / 面板用）。 */
    agents() {
      if (!p || !ensureTable()) return []
      try {
        return p(`SELECT owner, COUNT(*) AS n, MIN(created_at) AS first, MAX(updated_at) AS last
                    FROM mem_owner WHERE owner IS NOT NULL GROUP BY owner ORDER BY n DESC`).all()
      } catch {
        return []
      }
    },
    /**
     * 一张只读的分布账（UI 概览 / 共享矩阵用）：总数、三档 scope 各几条、七层各几条。
     *
     * 与 `agents()` 的区别：那条是「谁写的」，这条是「按什么分」。**不建表**——UI 打开
     * 一个还没有归属记录的老库时不该顺手写盘（只读面板一次写都不该有）。
     */
    census() {
      const out = { total: 0, scopes: { private: 0, workspace: 0, global: 0 }, layers: {}, matrix: {}, owners: 0 }
      if (!p) return out
      const seen = new Set()
      try {
        for (const row of p('SELECT scope, level, owner, COUNT(*) AS n FROM mem_owner GROUP BY scope, level, owner').all()) {
          const n = Number(row?.n ?? 0)
          out.total += n
          const sc = SCOPES.includes(String(row?.scope)) ? String(row?.scope) : 'workspace'
          out.scopes[sc] += n
          const lv = String(row?.level ?? '?')
          out.layers[lv] = (out.layers[lv] ?? 0) + n
          const cell = out.matrix[lv] ?? (out.matrix[lv] = { private: 0, workspace: 0, global: 0 })
          cell[sc] += n
          if (row?.owner) seen.add(String(row.owner))
        }
      } catch {
        /* 表还不存在（这个库从没记过归属）：空账，不是错 */
      }
      out.owners = seen.size
      return out
    },
  }
}

/**
 * 给行里的 id 加来源标签（PLAN U6：A 写的条目，B 读到时带 `agent:A`）。
 *
 * 这是**文本层**的做法，故意的：meow 的七层渲染有十几处，改它等于把「回执文案」这条资产
 * 重新过一遍；而「哪个 id 属于谁」是查表得来的事实，标签只是把它印在 id 旁边。
 *
 * 认两种形态，都是实测出来的：
 *   1. 回执行里的方括号 id：`[0mwxux1f6-709dde1a98df49729b9f192c10]`（8 位短 id + `-` + 32 位）
 *   2. 行首裸短 id：`- 0mwxux1f（fact）`
 * 正文里同形的 8 位串（构建号、哈希）不会被标——它们不在方括号里，也不在行首。
 */
const BRACKET_ID = /\[([0-9a-z]{8}[0-9a-z-]{0,32})\]/g
const LINE_ID = /(^|\n)([ \t]*(?:[-*+]\s+|\d+\.\s+)?)([0-9a-z]{8})(?=[0-9a-z-]*(?:[\]（(\s，,）)]|$))/g

export function tagOwners(text, store, selfId) {
  let out = String(text ?? '')
  if (out === '' || !store) return out
  const ids = new Set()
  for (const m of out.matchAll(BRACKET_ID)) ids.add(m[1].slice(0, 8))
  for (const m of out.matchAll(LINE_ID)) ids.add(m[3])
  if (ids.size === 0) return out
  const owners = store.ownersOf([...ids])
  if (owners.size === 0) return out
  const find = (id8) => {
    for (const [full, row] of owners) {
      if (full.startsWith(id8)) return row
    }
    return null
  }
  out = out.replace(BRACKET_ID, (whole, id) => {
    const row = find(id.slice(0, 8))
    if (!row) return whole
    const tag = labelOf(row, selfId)
    return tag ? `${whole}${tag}` : whole
  })
  out = out.replace(LINE_ID, (whole, lead, indent, id8) => {
    const row = find(id8)
    if (!row) return whole
    const tag = labelOf(row, selfId)
    return tag ? `${lead}${indent}${id8}${tag}` : whole
  })
  return out
}

/** `[self]` / `[agent:x]` / `[global]`；没有归属记录就不加标签（不写「未知」，那是假话）。 */
export function labelOf(row, selfId) {
  const owner = typeof row?.owner === 'string' ? row.owner : ''
  const scope = typeof row?.scope === 'string' ? row.scope : ''
  if (scope === 'global') return '`[global]`'
  if (owner === '') return ''
  if (selfId && owner === selfId) return '`[self]`'
  return `\`[agent:${owner}]\``
}

/**
 * 算这一轮调用要给引擎看的可见性（挂在 `exec.visibility` 上）。
 *
 * 为什么要现算：写完一条 private 的下一次调用就该挡，改 scope 的下一次也该放开。
 * 一条 `SELECT id` 很轻，不值得缓存——缓存错了就是「刚写的私密条目被人搜到」。
 *
 * `scopes` 是三段召回的分段账（`短 id → scope`）：没有它，引擎只能把七层的候选塞进一个池子
 * 打分，`private` / `workspace` / `global` 三种不同可比性的条目就被当成同一把尺子量。
 * 拿不到这张表（老库、表坏了）就是空表，引擎按单池跑——行为与 0.9 之前逐位一致。
 *
 * @returns {{self: string, hidden: Set<string>, scopes: Map<string,string>}}
 */
export function buildVisibility(store, selfId) {
  const self = typeof selfId === 'string' && selfId !== '' ? selfId : 'core'
  const hidden = store && typeof store.hiddenFor === 'function' ? store.hiddenFor(self) : new Set()
  const scopes = store && typeof store.scopeMapFor === 'function' ? store.scopeMapFor() : new Map()
  return { self, hidden, scopes }
}
