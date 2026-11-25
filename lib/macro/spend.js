/**
 * [macro-fusion 0.6.70] 注入额度账（spend）：钱花在哪几条上。
 *
 * 病：0.6.55 起「每轮一共允许多少字」已经是用户可调的旋钮（`injectTurnMaxChars`），
 * 0.6.46 起「这几小时注入了多少字、被挡的是哪一类」也有账（`action="inject"`）。
 * 但两份账都只回答「一共花了多少」——**说不出是哪几条在花**。于是最典型的现场是：
 * 每轮都注入十几条、token 烧得心疼，翻面板只看到「本轮 3,412 字」，想动手却不知道
 * 该动哪一条：是那条每次都在的 900 字长文，还是十几条「被召回、从没被读过」的短句？
 *
 * 处方：按条目结账。库里有现成的三个数——`hit_count`（注入即 +1）、`read_count`
 * （真被 `memory_read` 读过才 +1）、`content` 长度——乘一乘就是每条的大致消耗。
 * 面板把它们排成「最吃额度的 N 条」，每条配一句**能直接执行**的出路（归档 / 降权 /
 * 拆条），并单列两个口子：注入了却没人读的、单条比基准长好几倍的。
 *
 * 三条口径上的自觉：
 * ① 这是**估算**，而且是有意取的上界：每轮按名次只给每条「基准的一部分」（最贴问的
 *    两倍、其余六成），所以真实消耗只会比 `注入次数 × 全文字数` 小。要日志实测的
 *    数字就问 `action="inject"`，两边摆在一起看，别拿估算当流水。
 * ② 只读：用 `openReadOnly` 打开现库（与 0.6.69 快照对比同一条路），不建表、不迁移、
 *    不写一行；库坏掉在这里也只说「读不出来」，不动手。
 * ③ 已归档的不进榜（它们本就不该再注入），但会单独报个数——否则「归档了怎么还在花」
 *    这种疑问没有答案。
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import * as Meow from '../../vendor/meow-memory/lib/index.js'
import { parseInjectLog } from './injectledger.js'
import { SNAPSHOT_LEVELS, humanStamp, openReadOnly } from './snapshot.js'

/** 每条正文的出厂基准（与引擎 `injectBodyMax` 默认值同源；配置写了就用配置）。 */
const BODY_MAX_DEFAULT = 240
/** 「注入了却没人读」的判定线：至少被注入这么多回还没人读，才值得点出来。 */
export const WASTE_MIN_HITS = 3
/** 「单条超长」的判定线：正文超过每条基准的两倍就算贵（面板里明写这条线怎么来的）。 */
const longLine = (bodyMax) => Math.max(200, bodyMax * 2)

/**
 * [0.6.71] 日志实测：与 `action="inject"` 读的是同一份 `dream-debug.log`（含 `.old`）。
 * 只回答「最近这些轮一共塞进去多少字、其中多少条次有按条记录」——它替不了估算
 * （估算是每条一辈子的账），但两者摆在一起，用户能立刻看出估算偏大多少。
 * 纯读，读不出来就返回 null，面板改口说「还没有日志」，不编数字。
 */
function measuredInject(workspace, dir) {
  const base = join(String(workspace ?? ''), String(dir || '.dsh-meow'))
  const parts = []
  let bytes = 0
  for (const name of ['dream-debug.log.old', 'dream-debug.log']) {
    const file = join(base, name)
    if (!existsSync(file)) continue
    try {
      bytes += statSync(file).size
      parts.push(readFileSync(file, 'utf8'))
    } catch {
      /* 这一段读不出来就当它没有；账照样能用估算出 */
    }
  }
  if (parts.length === 0) return null
  const { events } = parseInjectLog(parts.join('\n'))
  const hits = events.filter((e) => e.kind === 'hit' && e.hit === 'yes')
  const chars = hits.reduce((a, e) => a + e.len, 0)
  const picks = hits.reduce((a, e) => a + (Array.isArray(e.picks) ? e.picks.length : 0), 0)
  return { rounds: hits.length, chars, picks, bytes }
}

function numOf(v, fallback = 0) {
  const n = Number(v)
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback
}

const comma = (n) => Number(n).toLocaleString('en-US')

/** 面板上的一行标题：压到 28 字，空了退回正文首句。 */
function shortTitle(row) {
  const raw = String(row.title ?? '').trim() || String(row.content ?? '').trim()
  const flat = raw.replace(/\s+/g, ' ').trim()
  if (flat === '') return '（无标题）'
  return flat.length > 28 ? `${flat.slice(0, 28)}…` : flat
}

/**
 * 把库摊成一条条账单。表不在（老库 / 半张 schema）就跳过那层——坏一张不该让整份读数作废。
 * @returns {{rows: object[], byLevel: object[], missing: string[], archived: number}}
 */
export function readSpend(handle) {
  const rows = []
  const byLevel = []
  const missing = []
  let archived = 0
  for (const level of SNAPSHOT_LEVELS) {
    let raw = []
    try {
      raw = handle
        .prepare(`SELECT id, title, content, hit_count, read_count, importance, status, last_accessed_at FROM ${level}`)
        .all()
    } catch {
      missing.push(level)
      continue
    }
    const box = { level, count: 0, chars: 0, hit: 0, spend: 0, archived: 0 }
    for (const r of raw) {
      const id = String(r.id ?? '')
      if (id === '') continue
      const chars = String(r.content ?? '').length
      const hits = numOf(r.hit_count)
      const reads = numOf(r.read_count)
      const status = String(r.status ?? 'active')
      const spend = hits * chars
      box.count += 1
      box.chars += chars
      if (hits > 0) box.hit += 1
      box.spend += spend
      if (status === 'archived') {
        box.archived += 1
        archived += 1
        continue
      }
      rows.push({
        id,
        level,
        title: shortTitle(r),
        chars,
        hits,
        reads,
        importance: numOf(r.importance),
        status,
        last: numOf(r.last_accessed_at),
        spend,
      })
    }
    byLevel.push(box)
  }
  return { rows, byLevel, missing, archived }
}

/** 每层一行的对齐（层名固定 7 个，短的补空格；面板是给人扫的，列不齐就不成表）。 */
function levelLine(box) {
  const name = box.level.padEnd(7, ' ')
  const avg = box.count > 0 ? Math.round(box.chars / box.count) : 0
  const tail = box.archived > 0 ? `  归档 ${box.archived}` : ''
  return `  ${name} ${String(box.count).padStart(4, ' ')} 条  ${comma(box.chars).padStart(9, ' ')} 字  均 ${String(avg).padStart(4, ' ')}  注入过 ${box.hit}${tail}`
}

/** 一条的出路：三种里挑一种，永远给现成命令，不给「建议优化」。 */
function exitFor(row, bodyMax) {
  const arg = `id="${row.id}"`
  if (row.reads === 0 && row.hits >= WASTE_MIN_HITS) {
    return `从没读过：memory_update(${arg}, status="archived") 归档；只想降权用 importance=1`
  }
  if (row.chars > longLine(bodyMax)) {
    return `比每条基准（${bodyMax} 字）长 ${(row.chars / bodyMax).toFixed(1)} 倍：memory_read(${arg}) 看全文，再 memory_update 压短或拆成两条`
  }
  return `嫌贵就降权：memory_update(${arg}, importance=1)（注入仍会带，但排在后面）`
}

/**
 * 面板正文。数字全部念库里的列，不算「应该花多少」。
 * @returns {{body: string, scope: string}}
 */
export function readSpendPanel({ workspace = '', dir = '.dsh-meow', limit = 5, config = {}, now = Date.now() } = {}) {
  const ws = String(workspace ?? '').trim()
  if (ws === '') {
    return { body: '拿不到工作区——额度账是按工作区结的，这次一条都算不出来（不是「还没花过」）。', scope: '' }
  }
  const want = Math.max(1, Math.min(50, numOf(limit, 5)))
  let dbPath = ''
  try {
    dbPath = Meow.memoryDbPath(ws, dir)
  } catch {
    dbPath = ''
  }
  let dbBytes = 0
  if (dbPath !== '') {
    try {
      dbBytes = statSync(dbPath).size
    } catch {
      dbBytes = 0
    }
  }
  if (dbBytes === 0) {
    return {
      body: `这个工作区还没有记忆库（找的是 ${dbPath === '' ? '（路径取不到）' : dbPath}）。\n一行额度都还没花过——不是「花的都是 0」。`,
      scope: '',
    }
  }
  const probe = openReadOnly(dbPath)
  if (probe.status !== 'ok') {
    return {
      body:
        `库在（${comma(dbBytes)} B），但读不出来：${probe.status === 'no-file' ? '文件不在了' : (probe.error ?? '原因未记')}。\n` +
        '额度账是纯读的，不会为了出数去动库；先看 memory_admin(action="snapshot") 能不能退一份回来。',
      scope: '',
    }
  }
  let spend
  try {
    spend = readSpend(probe.db)
  } finally {
    try {
      probe.db.close()
    } catch {
      /* 关不掉不影响读数 */
    }
  }

  const bodyMax = numOf(config.injectBodyMax, BODY_MAX_DEFAULT) || BODY_MAX_DEFAULT
  const perHit = numOf(config.injectMaxChars, 0)
  const perTurn = numOf(config.injectTurnMaxChars, 0)
  const quota = [
    `每轮 ${perTurn > 0 ? `${comma(perTurn)} 字` : '不限'}`,
    `单次命中 ${perHit > 0 ? `${comma(perHit)} 字` : '不限'}`,
    `每条基准 ${comma(bodyMax)} 字`,
  ].join(' · ')

  const lines = []
  lines.push(`库：${dbPath}`)
  const live = spend.rows
  const total = live.length
  const totalChars = live.reduce((a, r) => a + r.chars, 0)
  const injected = live.filter((r) => r.hits > 0)
  const spendSum = live.reduce((a, r) => a + r.spend, 0)
  lines.push(
    `  ${comma(total)} 条 · ${comma(totalChars)} 字 · 注入过 ${comma(injected.length)} 条，估算累计注入 ${comma(spendSum)} 字` +
      (spend.archived > 0 ? `（另有 ${spend.archived} 条已归档，不进榜也不计）` : ''),
  )
  lines.push('  估算 = 注入计数 × 本条字数，是上界（每轮按名次只给每条基准的一部分）。')
  // [0.6.71] 估算旁边摆实测：同一个工作区的注入日志，命中轮数与总字数。
  // 「一对账」是这一版的目的——用户不必再在两份面板之间自己换算。
  const measured = measuredInject(ws, dir)
  if (measured === null) {
    lines.push('  日志实测：这个工作区还没有注入日志（dream-debug.log）——真实花了多少还不知道；按轮的实测账看 memory_admin(action="inject")。')
  } else if (measured.rounds === 0) {
    lines.push(
      `  日志实测：日志在（${comma(measured.bytes)} B），但还没有一轮注入成功——估算那边有数也只说明历史上注入过；按轮的实测账看 memory_admin(action="inject")。`,
    )
  } else {
    const avgRound = Math.round(measured.chars / measured.rounds)
    lines.push(
      `  日志实测（同一份 dream-debug.log）：${comma(measured.rounds)} 轮命中注入共 ${comma(measured.chars)} 字 / 平均 ${avgRound} 字每轮` +
        (measured.picks > 0
          ? `；每轮进了哪几条有按条记录（${comma(measured.picks)} 条次），逐条看 memory_admin(action="inject")`
          : '；还没有按条记录（0.6.71 起 hit-chain 才写 picks=），想按轮对账就跑一轮新版'),
    )
    lines.push('  估算偏大是设计如此（按排名分档给字数，真塞进去的更短）；两边对不上时以日志为准。')
  }
  lines.push(`配额（面板读设置，0 = 不限）：${quota}`)
  const table = spend.byLevel.filter((b) => b.count > 0)
  if (table.length > 0) {
    lines.push('按层：')
    for (const box of table) lines.push(levelLine(box))
  }
  if (spend.missing.length > 0) {
    lines.push(`  （${spend.missing.join(' / ')} 这 ${spend.missing.length} 层没有表，跳过了——老库或半张 schema 才会这样）`)
  }

  if (injected.length === 0) {
    lines.push('')
    lines.push('还没有条目被注入过（注入计数全是 0）——要么库是新的，要么注入一直没走到这一步。')
    const scope = total > 0 ? `${comma(total)} 条 / 全库 0 条花过额度` : ''
    return { body: lines.join('\n'), scope }
  }

  const ranked = injected.slice().sort((a, b) => b.spend - a.spend || b.chars - a.chars || a.id.localeCompare(b.id))
  const top = ranked.slice(0, want)
  lines.push('')
  lines.push(
    ranked.length < want ? `最吃额度的 ${ranked.length} 条（全库只有 ${ranked.length} 条注入过）：` : `最吃额度的 ${want} 条：`,
  )
  top.forEach((row, i) => {
    const meta = [
      `${comma(row.spend)} 字（估）`,
      row.level,
      `${comma(row.chars)} 字/条 × ${comma(row.hits)} 次`,
      `读过 ${comma(row.reads)} 次`,
      row.last > 0 ? `最近活动 ${humanStamp(row.last)}` : '没有时间戳',
    ].join(' · ')
    lines.push(`  ${i + 1}. ${meta}`)
    lines.push(`     ${row.title}`)
    lines.push(`     id=${row.id}`)
    lines.push(`     ${exitFor(row, bodyMax)}`)
  })
  if (ranked.length > want) {
    lines.push(`  …后面还有 ${ranked.length - want} 条（加大 limit 看全）`)
  }

  const waste = ranked.filter((r) => r.reads === 0 && r.hits >= WASTE_MIN_HITS)
  const wasteSpend = waste.reduce((a, r) => a + r.spend, 0)
  const longOnes = ranked.filter((r) => r.chars > longLine(bodyMax))
  const longest = longOnes.reduce((m, r) => Math.max(m, r.chars), 0)
  lines.push('')
  lines.push('两个口子：')
  if (waste.length === 0) {
    lines.push(`  · 注入了却没人读：没有（判据是注入 ≥ ${WASTE_MIN_HITS} 次且读过 0 次）`)
  } else {
    const share = spendSum > 0 ? Math.round((wasteSpend / spendSum) * 100) : 0
    lines.push(
      `  · 注入了却没人读：${waste.length} 条，估 ${comma(wasteSpend)} 字（占 ${share}%）——名单看 memory_admin(action="hygiene", kind="unused")`,
    )
  }
  if (longOnes.length === 0) {
    lines.push(`  · 单条超长（> ${comma(longLine(bodyMax))} 字）：没有`)
  } else {
    lines.push(
      `  · 单条超长（> ${comma(longLine(bodyMax))} 字）：${longOnes.length} 条，最长 ${comma(longest)} 字——先 memory_read 看全文，再压短或拆条`,
    )
  }
  lines.push('')
  lines.push(`（榜单口径：命中 ${comma(injected.length)} 条按估算降序，同额按字数；已归档的不进榜）`)

  const scope = `${comma(total)} 条 · 列了 ${top.length} 条${ranked.length > want ? `（前 ${want}）` : ''}`
  return { body: lines.join('\n'), scope }
}

