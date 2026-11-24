/**
 * 注入账本面板（0.6.46）：`memory_admin(action="inject")` 的正文从这里出。
 *
 * 为什么要有这个面板：0.6.41 / 0.6.44 / 0.6.45 三道闸（单条正文上限、会话预算、同话题抑制、
 * 命中闸门）都在往 `dream-debug.log` 里写账，可**只有写、没有读**——日志躺在项目目录里，
 * 用户想问「这几小时到底注入了多少字、被挡的是哪一类」只能自己去翻几千行文本。
 * 一个只有写口的账本，等于把「可解释」做成了「我写过」。
 *
 * 三条规矩（和 dreamledger.js 同一套）：
 *  1. 面板只念日志，不自己算：所有数字都能从 `dream-debug.log` 的行里验算出来。
 *  2. 「没有账」和「读不出来」分开说：前者是这窗口还没到过注入这一步（或日志被轮转掉了），
 *     后者是文件在但读不动——把后者说成前者是最难查的那种谎。
 *  3. 认旧格式：0.6.43 及以前的 `hit-chain` 行只有 `textLen=/hit=`，没有 floor/gated/skip。
 *     面板照算字数，但要明说「这几行是旧格式，闸门读数不全」，不许把缺字段读成 0。
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** 出厂默认（与 vendor/meow-memory/lib/index.js 的 DEF 常量一致；面板只用来兜底，不参与判定）。 */
const DEFAULTS = {
  injectFloor: 0.35,
  injectBodyMax: 240,
  injectSessionBudget: 0,
  injectRepeatSim: 0.25,
  hitTopK: 2,
}

/** `[2026-11-24T19:04:01.510Z] hit-chain pid=1 sid=abc textLen=240 hit=yes ...` */
const LINE_RE = /^\[([0-9T:.\-Z]+)\]\s+(hit-chain|hit-skip)\b(.*)$/

/** `k=v` 逐对拆开（值里不含空格；日志本身就是这么写的）。 */
function pairsOf(rest) {
  const out = Object.create(null)
  for (const part of String(rest ?? '').trim().split(/\s+/)) {
    const at = part.indexOf('=')
    if (at <= 0) continue
    out[part.slice(0, at)] = part.slice(at + 1)
  }
  return out
}

function numOf(raw, fallback = 0) {
  const n = Number(raw)
  return Number.isFinite(n) ? n : fallback
}

/** `2026-11-24T19:04:01.510Z` → 毫秒；解不出给 0（时间不明，别拿现在顶）。 */
function timeOf(iso) {
  const t = Date.parse(String(iso))
  return Number.isFinite(t) ? t : 0
}

/** 本机时间的「MM-DD HH:mm」：面板只给到分钟，秒在这里没有信息量。 */
function stamp(at) {
  const t = Number(at)
  if (!Number.isFinite(t) || t <= 0) return '时间不明'
  const d = new Date(t)
  const p = (n) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

function p50Of(sorted) {
  if (sorted.length === 0) return 0
  return sorted[Math.floor(sorted.length / 2)]
}

/**
 * 读一份日志文本 → 事件数组 + 坏行数。
 *
 * 只认 `hit-chain` / `hit-skip` 两种行；其余行（pre-step / check / dream / turn-stopping）
 * 一律跳过，**不计坏行**——它们不是这本账要读的东西，把它们算成「解析失败」会让
 * 面板看起来像日志坏了。
 */
export function parseInjectLog(text) {
  const events = []
  let bad = 0
  let legacy = 0
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '' || !line.includes('hit-')) continue
    const m = LINE_RE.exec(line)
    if (m === null) {
      bad += 1
      continue
    }
    const at = timeOf(m[1])
    const kv = pairsOf(m[3])
    if (m[2] === 'hit-chain') {
      // 0.6.43 及以前：没有 floor=，也没有 gated= —— 只记了字数与出口
      const isLegacy = kv.floor === undefined && kv.gated === undefined
      if (isLegacy) legacy += 1
      // spent 写的是「已花/上限」（如 `268/∞`、`780/800`）：取除号前那一半才是已花，
      // 直接 Number('268/∞') 会得到 NaN，被兜成 0，面板就会说「这轮一个字都没花」。
      const spentRaw = kv.spent === undefined ? '' : String(kv.spent)
      events.push({
        kind: 'hit',
        at,
        sid: String(kv.sid ?? ''),
        len: numOf(kv.textLen),
        // 三态（照日志原样，不改写）：yes=真注入了记忆；null=这一轮没有命中注入；
        // 缺字段=更老的版本，连这个键都没有——不许当成 null 读。
        hit: kv.hit === undefined ? 'unknown' : String(kv.hit),
        floor: kv.floor === undefined ? null : numOf(kv.floor),
        gated: kv.gated === undefined ? null : numOf(kv.gated),
        bodyCut: kv.bodyCut === undefined ? null : numOf(kv.bodyCut),
        repeated: kv.repeated === undefined ? null : numOf(kv.repeated),
        spent: spentRaw === '' ? null : numOf(spentRaw.split('/')[0]),
        limit: spentRaw.includes('/') ? spentRaw.split('/')[1] : '',
        legacy: isLegacy,
      })
    } else {
      // 0.6.44 起才有：四种出口 empty / floor / budget / repeat
      events.push({
        kind: 'skip',
        at,
        sid: String(kv.sid ?? ''),
        reason: String(kv.reason ?? ''),
        extra: m[3].trim(),
        legacy: false,
      })
    }
  }
  // 两代日志拼起来后顺序天然是对的（.old 在前），但同一毫秒内可能乱：稳定排序兜一层。
  events.sort((a, b) => a.at - b.at)
  return { events, bad, legacy }
}

/** 面板正文：账目 + 最近若干轮明细。`limit` 只控明细条数，统计永远覆盖整份日志。 */
export function readInjectPanel({ workspace, dir, limit = 12, config = {} } = {}) {
  const base = join(String(workspace ?? ''), String(dir || '.dsh-meow'))
  const nowFile = join(base, 'dream-debug.log')
  const oldFile = join(base, 'dream-debug.log.old')
  const files = []
  for (const f of [oldFile, nowFile]) {
    if (!existsSync(f)) continue
    let size = 0
    try {
      size = statSync(f).size
    } catch {
      size = 0
    }
    files.push({ path: f, size, text: safeRead(f) })
  }
  const gate = [
    `floor ${numOf(config.injectFloor, DEFAULTS.injectFloor)}`,
    `单条 ${numOf(config.injectBodyMax, DEFAULTS.injectBodyMax)} 字`,
    `会话累计 ${numOf(config.injectSessionBudget, DEFAULTS.injectSessionBudget) > 0 ? `${numOf(config.injectSessionBudget)} 字` : '不限'}`,
    `同话题 ${numOf(config.injectRepeatSim, DEFAULTS.injectRepeatSim)}`,
    `每轮最多 ${numOf(config.hitTopK, DEFAULTS.hitTopK)} 条`,
  ].join(' · ')

  if (files.length === 0) {
    return {
      body:
        `这个工作区里还没有注入账（找的是 ${nowFile}）。\n` +
        '没到过注入这一步、或者插件换到别的库目录时都会这样——不是「账本是空的」。',
      scope: '',
    }
  }
  const totalBytes = files.reduce((a, f) => a + f.size, 0)
  const joined = files.map((f) => f.text).join('\n')
  const { events, bad, legacy } = parseInjectLog(joined)
  const hits = events.filter((e) => e.kind === 'hit')
  const skips = events.filter((e) => e.kind === 'skip')

  if (events.length === 0) {
    return {
      body:
        `日志在（${fmtKb(totalBytes)}），但里面一行注入账都没有。\n` +
        `日志：${nowFile}` +
        (bad > 0 ? `\n另有 ${bad} 行长得像注入账却解析不出来，一行都没算进去。` : ''),
      scope: '',
    }
  }

  const injected = hits.filter((e) => e.hit === 'yes')
  const noHit = hits.filter((e) => e.hit !== 'yes')
  const lens = injected.map((e) => e.len).sort((a, b) => a - b)
  const sum = lens.reduce((a, b) => a + b, 0)
  const avg = lens.length > 0 ? Math.round(sum / lens.length) : 0
  const gated = injected.reduce((a, e) => a + (e.gated ?? 0), 0)
  const bodyCut = injected.reduce((a, e) => a + (e.bodyCut ?? 0), 0)
  const repeated = injected.reduce((a, e) => a + (e.repeated ?? 0), 0)

  const byReason = new Map()
  for (const s of skips) byReason.set(s.reason, (byReason.get(s.reason) ?? 0) + 1)

  const lines = [`闸门：${gate}`, '']
  const rounds = hits.length + skips.length
  lines.push(`出口：${rounds} 轮里有 ${injected.length} 轮注入、${skips.length} 轮挡下${noHit.length > 0 ? `、${noHit.length} 轮没命中注入` : ''}`)
  if (noHit.length > 0) {
    // 旧格式里「没命中」只有一行 hit=null，没写为什么（0.6.44 起才有四种 hit-skip 出口）。
    // 这句必须跟着那行一起出现在正文里，否则「挡下 0 轮 + 16 轮没命中」会被读成「闸门从没生效」。
    lines.push(`- 其中 ${noHit.length} 轮是「算了但没注入」：0.6.44 起会分别写明是未命中 / 闸门 / 预算 / 同话题，更早的行只记了这一句。`)
  }
  if (skips.length > 0) {
    const known = ['empty', 'floor', 'budget', 'repeat']
    for (const r of known) {
      const n = byReason.get(r)
      if (!n) continue
      lines.push(`- ${reasonLabel(r)}：${n} 轮`)
    }
    for (const [r, n] of byReason) {
      if (known.includes(r)) continue
      lines.push(`- ${r === '' ? '出口没写原因' : r}：${n} 轮`)
    }
  }
  if (injected.length > 0) {
    lines.push(
      '',
      `字数：合计 ${sum.toLocaleString('en-US')} 字 / 平均 ${avg} 字每轮 / 中位 ${p50Of(lens)} / 最省 ${lens[0]} / 最多 ${lens[lens.length - 1]}`,
    )
    if (gated > 0) lines.push(`闸门挡下的条目：${gated} 条（过线但没进注入的）`)
    if (bodyCut > 0) lines.push(`正文被压：${bodyCut} 条（只留了首句或前几句，全文要用 id 去 memory_read）`)
    if (repeated > 0) lines.push(`同话题抑制：${repeated} 条（上一轮注入过、相似度超线的条目，按条算不按轮算）`)
  }
  if (legacy > 0) {
    // 旧格式只记「注入成功」的那些轮，挡下的轮根本没写行——所以「0 轮挡下」这种读数
    // 在旧格式日志上必须当场解释掉，否则会被读成「从来没挡过任何东西」。
    lines.push(
      '',
      `另有 ${legacy} 行是 0.6.43 及以前的旧格式（没有 floor / gated 读数，挡下的轮也没写行）：` +
        '字数照算，闸门读数与「挡下」计数不全——上面的挡下轮数只统计新格式。',
    )
  }

  const want = Math.max(0, Math.trunc(numOf(limit, 12)))
  if (want > 0) {
    const recent = events.slice(-want).reverse()
    lines.push('', `最近 ${recent.length} 轮（新的在前）：`)
    for (const e of recent) {
      if (e.kind === 'hit') {
        if (e.hit !== 'yes') {
          // 旧格式的「没命中」：字数照印（那点字是骨架/边界句，不是记忆），原因不明就说原因不明
          lines.push(`- ${stamp(e.at)} 没注入（${e.len} 字骨架${e.hit === 'unknown' ? '，出口没记' : ''}）`)
          continue
        }
        const bits = [`注入 ${e.len} 字`]
        if (e.gated !== null && e.gated > 0) bits.push(`挡 ${e.gated} 条`)
        if (e.bodyCut !== null && e.bodyCut > 0) bits.push(`压 ${e.bodyCut} 条`)
        if (e.repeated !== null && e.repeated > 0) bits.push(`同类 ${e.repeated}`)
        lines.push(`- ${stamp(e.at)} ${bits.join(' · ')}`)
      } else {
        lines.push(`- ${stamp(e.at)} 挡下：${reasonLabel(e.reason)}${detailOf(e)}`)
      }
    }
  } else if (want === 0) {
    lines.push('', '按你给的 limit=0 这次一条明细都不列（统计照算）。')
  }

  lines.push('', `日志：${nowFile}${files.length > 1 ? `（含 1 份 .old）` : ''} · ${fmtKb(totalBytes)} · ${events.length} 行账`)
  if (bad > 0) lines.push(`另有 ${bad} 行长得像注入账却解析不出来，一行都没算进去。`)

  const oldest = events[0]?.at ?? 0
  const newest = events[events.length - 1]?.at ?? 0
  const scope =
    oldest > 0
      ? `覆盖 ${stamp(oldest)} 到 ${stamp(newest)} 的 ${rounds} 轮出口记录`
      : `覆盖 ${rounds} 轮出口记录（时间读不出来）`
  return { body: lines.join('\n'), scope }
}

function detailOf(e) {
  const extra = String(e.extra ?? '')
  if (extra === '') return ''
  // 去掉 reason=k 之后剩下的 kv，只挑读者能用的
  const kv = pairsOf(extra)
  const bits = []
  if (kv.gated !== undefined) bits.push(`挡 ${numOf(kv.gated)} 条`)
  if (kv.floor !== undefined) bits.push(`floor ${kv.floor}`)
  if (kv.similar !== undefined) bits.push(`相似 ${kv.similar}`)
  if (kv.sim !== undefined) bits.push(`相似 ${kv.sim}`)
  if (kv.spent !== undefined) bits.push(`累计 ${kv.spent}`)
  return bits.length > 0 ? `（${bits.join(' · ')}）` : ''
}

function reasonLabel(reason) {
  switch (String(reason)) {
    case 'empty':
      return '未命中（没有条目过搜索线）'
    case 'floor':
      return '命中闸门（过搜索线但没过 floor）'
    case 'budget':
      return '会话预算用尽'
    case 'repeat':
      return '同话题抑制（上轮已注入）'
    default:
      return reason === '' ? '出口没写原因' : reason
  }
}

function fmtKb(bytes) {
  const n = Number(bytes) || 0
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(2)} MB`
}

function safeRead(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}
