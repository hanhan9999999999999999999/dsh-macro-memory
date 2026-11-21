/**
 * [macro-fusion 0.2.138] 取代链可视：一条记忆现在处在链上的哪个位置。
 *
 * 为什么要有这个：0.2.117 起 supersedes 会把旧条目标 stale 并在正文末尾留一句话
 * 「（已被取代：<新 id>「<开头>」，<日期>）」。话留下了，但**没有人在读它**——
 * 你 memory_update 一条旧条目时，回执只说「已更新」，你看不出这条其实早就退位了；
 * 你写新条目时也说不出「我这一条接的是谁的手」。于是库里有一条真实的谱系，
 * 却只能靠人肉 grep 才看得见。可追溯性不是「写过」，是「读的时候能顺着走」。
 *
 * 三个约束（这也是这一版只做两行的原因）：
 *  1. **只在真有链时才说话**：绝大多数更新/读取没有谱系，多一行就是多花 token。
 *  2. **不改任何数据**：链是读出来的，不是维护出来的——不新增列、不新增索引、
 *     不回头补写旧条目（那会把已经很长的库再改一遍，收益抵不上风险）。
 *  3. **拿不到就闭嘴**：没工作区 / 没库 / 读失败一律返回空串，绝不猜一段链出来，
 *     也绝不为了一句提示去 `getDb` 建一个空库（先 existsSync 判存在）。
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import * as Meow from '../../vendor/meow-memory/lib/index.js'
import { LEVELS } from './shared.js'

/** 与 defs/remember.js 的 SUPERSEDE_MARK 必须是同一个串（那边写、这边读）。 */
export const SUPERSEDE_MARK = '（已被取代：'
/** meow 的 id 形如 `0mwowj2h2-<32 hex>`，取代句里只留前 8 位。 */
const SHORT = 8
/** 链上一行最多点几条：谱系再长，读者也只需要「有这件事」+ 几个把手。 */
const SHOW_MAX = 5
/** 抬头从哪里截：够认出是哪条，又不会把一整段正文塞进回执。 */
const HEAD_MAX = 28

function dbFile(workspace, dir) {
  return join(workspace, dir, 'memory.db')
}

/** id 的前 8 位——取代句、去重判断、跨条匹配全用这一个口径。 */
export function shortId(id) {
  return String(id ?? '').slice(0, SHORT)
}

function headOf(text) {
  const first = String(text ?? '')
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0) ?? ''
  return first.length > HEAD_MAX ? `${first.slice(0, HEAD_MAX)}…` : first
}

/**
 * 从正文里读出「我已被谁接手」。
 * 取代句的形态是 `（已被取代：<id8>「<开头>」，<日期>）`，开头和日期都可能缺——
 * 缺的就不编：解析不出来就返回 null，让调用方当作「没有这段谱系」。
 */
export function supersededBy(content) {
  const text = String(content ?? '')
  const at = text.indexOf(SUPERSEDE_MARK)
  if (at < 0) return null
  const rest = text.slice(at + SUPERSEDE_MARK.length)
  const idm = /^\s*([0-9a-z]{4,})/.exec(rest)
  if (idm === null) return null
  const headm = new RegExp(`^[0-9a-z]{4,}「([^」]*)」`).exec(rest)
  const daym = /[，,]\s*(\d{4}-\d{1,2}-\d{1,2})\s*[）)]/.exec(rest)
  return { id8: idm[1], head: headm?.[1] ?? '', day: daym?.[1] ?? '' }
}

/**
 * 一条记忆在链上的位置：`mine` = 谁接手了它，`killed` = 它接手过谁。
 * missing 三态照老规矩分开（no-workspace / no-db / read-failed），但它只用于内部判断，
 * 对外一律闭嘴——「读不到链」不等于「这条没有链」，可两者对读者都只能是「没有可说的」。
 */
export function successionOf({ workspace = '', dir = '.dsh-meow', id = '' } = {}) {
  const out = { mine: null, killed: [], missing: '' }
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
    // 自己那一条：短 id 当输入时 readRowsByIds 可能回好几条（同秒同前缀），只认前缀对得上的。
    const read = Meow.readRowsByIds(workspace, dir, [want])
    const rows = Array.isArray(read.rows) ? read.rows : []
    const self = rows.find((r) => String(r.id ?? '').startsWith(want)) ?? rows[0] ?? null
    if (self !== null) out.mine = supersededBy(self.content)
    const shore = shortId(want)
    const needle = SUPERSEDE_MARK + shore
    const db = Meow.getDb(workspace, dir)
    for (const level of LEVELS) {
      const list = db.list(level, {})
      for (const r of Array.isArray(list) ? list : []) {
        const rid = String(r.id ?? '')
        if (shortId(rid) === shore) continue // 自己（含同前缀的兄弟条）不算「我接手的」
        if (!String(r.content ?? '').includes(needle)) continue
        out.killed.push({ level, id: rid, status: String(r.status ?? ''), head: headOf(r.content) })
      }
    }
    return out
  } catch (e) {
    out.missing = `read-failed: ${e instanceof Error ? e.message : String(e)}`
    return out
  }
}

/**
 * 回执里那两行（可能只有一行、也可能一行都没有）。
 * 语气分开是有意的：`mine` 是警告（你手上这条已经退位了），`killed` 是史证（旧的那些别再用）。
 */
export function successionNote({ workspace = '', dir = '.dsh-meow', id = '' } = {}) {
  const chain = successionOf({ workspace, dir, id })
  if (chain.missing.length > 0) return ''
  const lines = []
  if (chain.mine !== null && chain.mine.id8.length > 0) {
    const who = `${chain.mine.id8}${chain.mine.head ? `「${chain.mine.head}」` : ''}`
    const when = chain.mine.day ? `${chain.mine.day} 写下` : '不知道哪天写下'
    lines.push(
      `⛓ 这条已被人接手：${who}（${when}）。你手上是退位的那条——检索时说话的是接手它的那条；这次结论才准，就去改那条，或者让这条带 supersedes 重写一次。`,
    )
  }
  if (chain.killed.length > 0) {
    const shown = chain.killed
      .slice(0, SHOW_MAX)
      .map((k) => `${k.level} ${shortId(k.id)}${k.status !== '' && k.status !== 'active' ? `（${k.status}）` : ''}`)
    const more = chain.killed.length > SHOW_MAX ? `，另有 ${chain.killed.length - SHOW_MAX} 条` : ''
    lines.push(
      `⛓ 这条接手过 ${chain.killed.length} 条：${shown.join('、')}${more}——旧的那几条只作史证，别拿它们的结论用。`,
    )
  }
  return lines.join('\n')
}
