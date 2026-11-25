/**
 * 回执里的 id 该多短就多短（0.6.64）——**最短唯一前缀**。
 *
 * 为什么要有这一支：真库读出来的 id 是 `9 位 base36 时间戳 + '-' + 26 位 hex`，一共 36 字
 * （例 `0mwvkk15w-7ea683b10ad5432b89ac03e91e`）。而所有回执里模型真正要的只是「够抄、能定位」：
 *
 *   - 0.6.63 的项目全景目录每行印**完整 id**，真库 `dsh-macro-memory` 34 行光 id 就吃掉
 *     1,224 字（3000 上限的 41%）。换成 9 字前缀，同样上限多列约 11 条。
 *   - 邻域块行首一直是 `id.slice(0, 8)`，看着够短，但真库 1,121 条里**8 位前缀撞 9 对**
 *     （id 开头就是同一批写入的 base36 时间戳）。撞车的短 id 指向两条，模型拿它去
 *     `memory_read` / `memory_update` / `mute` 会撞上歧义拒绝——回执还会读成「那条记忆不见了」。
 *
 * 判据与 vendor 自带的那份完全一致（`vendor/meow-memory/lib/index.js:7188` 的 `uniqueShortId`）：
 * 前缀在库里命中 ≤1 条就算唯一，8 位起、不唯一就往下加长。区别只在这里一次算完全表
 * （7 条 `SELECT id` 摊一次），省得每条都发一句 `LIKE ?`。
 *
 * 边界：
 *   - 读写都吃前缀：`findByIdAll`（:683）对 <36 字按前缀跨层 `LIKE`，`update`（:715）同样；
 *     所以短 id 不是「只给眼睛看」的缩略，抄回去就能用。
 *   - 星图那边给的常常**本身就是短 id**（8 位或 12 位前缀）。`shortenId` 会先把它解析回
 *     唯一的那条完整 id，再给最短唯一前缀；解析不唯一就原样返回——不猜、不替它挑一条。
 *   - 库里查不到（工作区为空、表还没建）→ 返回 null，调用方退回老的 8 位切法，行为不变。
 *   - 不缓存：一条新写入的 id 可能和刚给出的前缀撞上，缓存下来的短 id 会悄悄变歧义。
 *     7 条 `SELECT id` 在千条量级上是毫秒级，宁可每轮重算。
 */

/** 最短也不短于 8 位：这是 meow 文档里「8 位短 id」的口径，老回执都按这个长度抄。 */
export const SHORT_ID_MIN = 8

/** 七层（与 vendor `LEVELS` 同序）。id 全局唯一，跨层一起算才安全。 */
const LEVELS = ['soul', 'user', 'rules', 'fact', 'lesson', 'topic', 'project']

/**
 * 算出「完整 id → 最短唯一前缀」的表，外加一份排好序的全表（供短 id 反查）。
 *
 * @param {{ p: (sql: string) => { all: () => any[] } }} db meow 的 MemoryDb
 * @returns {{byId: Map<string, string>, sorted: string[]} | null} 查不到任何 id 时 null
 */
export function shortIdsOf(db) {
  if (db === null || typeof db !== 'object' || typeof db.p !== 'function') return null
  const ids = []
  for (const level of LEVELS) {
    try {
      const rows = db.p(`SELECT id FROM ${level}`).all() ?? []
      for (const row of rows) {
        const id = String(row?.id ?? '')
        if (id !== '') ids.push(id)
      }
    } catch {
      // 这个工作区还没建这一层：跳过，不影响别的层。
    }
  }
  if (ids.length === 0) return null
  // 排序之后「前缀唯一」只需要跟左右的邻居比：同一前缀的 id 在字典序上必然相邻。
  ids.sort()
  const byId = new Map()
  for (let i = 0; i < ids.length; i += 1) {
    const id = ids[i]
    const floor = Math.min(SHORT_ID_MIN, id.length)
    let n = floor
    while (n < id.length) {
      const prefix = id.slice(0, n)
      const prev = i > 0 ? ids[i - 1] : ''
      const next = i + 1 < ids.length ? ids[i + 1] : ''
      if (!prev.startsWith(prefix) && !next.startsWith(prefix)) break
      n += 1
    }
    byId.set(id, id.slice(0, n))
  }
  return { byId, sorted: ids }
}

/**
 * 给定 id（完整或已经截短）→ 它该被印成多长。
 *
 * 三种情况：
 *   ① 表里有这条完整 id → 直接给它的最短唯一前缀；
 *   ② 给的是短 id，且在全表里只命中一条 → 解析出那条，给它的最短唯一前缀；
 *   ③ 命中零条或多条 → 原样（前 8 位）退回，绝不替调用方在两条之间挑一条。
 *
 * @param {{byId: Map<string, string>, sorted: string[]} | null | undefined} index `shortIdsOf` 的结果
 * @param {any} id 完整 id 或短 id
 * @returns {string}
 */
export function shortenId(index, id) {
  const given = String(id ?? '')
  if (given === '') return ''
  if (index !== null && typeof index === 'object' && index.byId instanceof Map) {
    const exact = index.byId.get(given)
    if (typeof exact === 'string') return exact
    const sorted = Array.isArray(index.sorted) ? index.sorted : []
    // 二分找第一个 >= given 的位置，再往后扫命中前缀的：字典序相邻，命中不会散开。
    let lo = 0
    let hi = sorted.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (sorted[mid] < given) lo = mid + 1
      else hi = mid
    }
    let hit = ''
    let count = 0
    for (let i = lo; i < sorted.length; i += 1) {
      if (!sorted[i].startsWith(given)) break
      count += 1
      if (count > 1) break
      hit = sorted[i]
    }
    if (count === 1) {
      const short = index.byId.get(hit)
      if (typeof short === 'string') return short
    }
  }
  return given.slice(0, SHORT_ID_MIN)
}
