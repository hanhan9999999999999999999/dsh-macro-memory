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
 *
 * [0.6.50] 这本账现在读**两种**注入：命中注入（`hit-chain` / `hit-skip`）与星图邻域
 * （`neighbor-chain` / `neighbor-skip`）。它们花的是同一份上下文预算：以前面板只念命中那一半，
 * 邻域每轮带几条、砍了几条不沾词的、被跨层去重刷掉几条，全是黑箱。两段分开算、
 * 分开写，因为「注入了多少字」和「邻域带了多少条」是两个不能相加的量。
 *
 * [0.6.51] 但**同一轮**要合账：命中注入与邻域是同一份上下文预算是真的，分两段念的结果是
 * 谁也答不出「这一轮到底被塞了多少字」。按「同 sid + 两秒内」把两边配回同一轮，单列一行
 * 「一轮合计」，明细里把那两行并成一行——只在两边都有账的轮上算，配不上的不硬凑。
 *
 * [0.6.52] 再往上加一层「一场会话」：按 sid 把同一场会话的所有轮并起来，报
 * 「命中 N 轮 / X 字 + 邻域 M 轮 / Y 字 = Z 字」。轮内合计回答「这一轮花了多少」，
 * 会话累计回答「这场聊下来花了多少」——两个问题，两行分开写，都不许互相顶替。
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** 出厂默认（与 vendor/meow-memory/lib/index.js 的 DEF 常量一致；面板只用来兜底，不参与判定）。 */
const DEFAULTS = {
  injectFloor: 0.35,
  injectBodyMax: 240,
  injectSessionBudget: 0,
  injectRepeatSim: 0.25,
  injectReinjectTurns: 12,
  hitTopK: 2,
}

/** `[2026-11-24T19:04:01.510Z] hit-chain pid=1 sid=abc textLen=240 hit=yes ...` */
const LINE_RE = /^\[([0-9T:.\-Z]+)\]\s+(hit-chain|hit-skip|neighbor-chain|neighbor-skip)\b(.*)$/

/**
 * [0.6.51] 把「同一轮的命中注入」与「同一轮的邻域链」配成一对。
 * 口径与 hit-skip 配轮一致：同 sid、两秒内、每条只用一次，取时间最近的那条。
 * 只返回配上的轮——配不上的不许猜。
 */
function pairRounds(hits, chains) {
  const used = new Set()
  const out = []
  for (const h of hits) {
    if (h.hit !== 'yes') continue
    let best = -1
    let bestGap = Infinity
    for (let i = 0; i < chains.length; i += 1) {
      if (used.has(i)) continue
      const c = chains[i]
      if (h.sid !== '' && c.sid !== '' && h.sid !== c.sid) continue
      const gap = Math.abs((h.at ?? 0) - (c.at ?? 0))
      if (gap > 2000) continue
      if (gap < bestGap) {
        best = i
        bestGap = gap
      }
    }
    if (best < 0) continue
    used.add(best)
    out.push({ hit: h, chain: chains[best] })
  }
  return out
}

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

/** 从 hit-skip 行的 `extra` 原文里抠一个 `key=123`（只用于挡下轮那些读数）。 */
function extraNumOf(e, key) {
  const m = new RegExp(`(?:^|\\s)${key}=(\\d+)`).exec(String(e.extra ?? ''))
  return m === null ? 0 : Number(m[1])
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
    if (line === '' || !/hit-|neighbor-/.test(line)) continue
    const m = LINE_RE.exec(line)
    if (m === null) {
      bad += 1
      continue
    }
    const at = timeOf(m[1])
    const kv = pairsOf(m[3])
    if (m[2] === 'neighbor-chain') {
      // 0.6.50：邻域这一轮真的进了上下文——记的是「进了多少」（条数 + 字符）。
      events.push({
        kind: 'neighbor',
        at,
        sid: String(kv.sid ?? ''),
        ids: numOf(kv.ids),
        chars: numOf(kv.chars),
        weak: numOf(kv.weak),
        offtopic: numOf(kv.offtopic),
        flagged: numOf(kv.flagged),
        deduped: numOf(kv.deduped),
        max: numOf(kv.max),
        cap: numOf(kv.cap),
        minScore: kv.minScore === undefined ? null : numOf(kv.minScore),
      })
    } else if (m[2] === 'neighbor-skip') {
      events.push({
        kind: 'nskip',
        at,
        sid: String(kv.sid ?? ''),
        reason: String(kv.reason ?? ''),
        extra: m[3].trim(),
      })
    } else if (m[2] === 'hit-chain') {
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
        // [0.6.49] 老条目放回：这一轮把多少条超出重放窗口的条目从「本会话已给过」名单里摘掉。
        released: kv.released === undefined ? null : numOf(kv.released),
        reinjectTurns: kv.reinject === undefined ? null : numOf(kv.reinject),
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
    `重放 ${numOf(config.injectReinjectTurns, DEFAULTS.injectReinjectTurns) > 0 ? `${numOf(config.injectReinjectTurns, DEFAULTS.injectReinjectTurns)} 轮` : '关（永久拉黑）'}`,
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
  const chains = events.filter((e) => e.kind === 'neighbor')
  const neighborSkips = events.filter((e) => e.kind === 'nskip')

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
  // [0.6.47] 闸门读数过去只数「注入成功」的那些轮：整轮被 floor / repeat 挡下时
  // `hit=null`，这些数字一条都不计——闸最生效的时候面板显示 0，排查时会被读成「闸没生效」。
  // 挡下的轮，真正的读数在 hit-skip 那一行（`gated=` / `repeated=`），两边一起加。
  const gated = hits.reduce((a, e) => a + (e.gated ?? 0), 0) + skips.reduce((a, e) => a + extraNumOf(e, 'gated'), 0)
  const bodyCut = hits.reduce((a, e) => a + (e.bodyCut ?? 0), 0)
  const repeated = hits.reduce((a, e) => a + (e.repeated ?? 0), 0) + skips.reduce((a, e) => a + extraNumOf(e, 'repeated'), 0)
  const released = hits.reduce((a, e) => a + (e.released ?? 0), 0) + skips.reduce((a, e) => a + extraNumOf(e, 'released'), 0)
  const reinjectTurns = hits.reduce((a, e) => (e.reinjectTurns !== null ? e.reinjectTurns : a), numOf(config.injectReinjectTurns, DEFAULTS.injectReinjectTurns))

  // [0.6.51] 一轮合计：命中与邻域都有的那些轮，把两份字数加在一起再统计。
  // 只在两边都配上的轮上算（配不上的单边轮不进来），并在行里写清「几轮」，
  // 免得被读成「所有轮的平均」。
  const roundPairs = pairRounds(hits, chains)
  const roundLen = roundPairs.map((p) => p.hit.len + p.chain.chars)
  const roundSum = roundLen.reduce((a, b) => a + b, 0)
  const roundAvg = roundLen.length > 0 ? Math.round(roundSum / roundLen.length) : 0
  const roundMax = roundLen.length > 0 ? Math.max(...roundLen) : 0
  const roundNeighborSum = roundPairs.reduce((a, p) => a + p.chain.chars, 0)
  const roundShare = roundSum > 0 ? Math.round((roundNeighborSum / roundSum) * 100) : 0

  // [0.6.52] 一场会话的累计：同一 sid 的注入轮与邻域轮各自求和，再给一行合计。
  // 「最近一场」按最后一条带 sid 的账取（日志顺序已排序），sid 为空的老账不进这一行。
  const sessionOf = new Map()
  const touch = (sid, at) => {
    if (sid === '') return null
    let box = sessionOf.get(sid)
    if (box === undefined) {
      box = { sid, last: 0, hitRounds: 0, hitChars: 0, chainRounds: 0, chainChars: 0 }
      sessionOf.set(sid, box)
    }
    if ((at ?? 0) > box.last) box.last = at ?? 0
    return box
  }
  for (const h of hits) {
    const box = touch(h.sid, h.at)
    if (box === null || h.hit !== 'yes') continue
    box.hitRounds += 1
    box.hitChars += h.len
  }
  for (const c of chains) {
    const box = touch(c.sid, c.at)
    if (box === null) continue
    box.chainRounds += 1
    box.chainChars += c.chars
  }
  let sessionLast = null
  for (const box of sessionOf.values()) {
    if (sessionLast === null || box.last > sessionLast.last) sessionLast = box
  }

  const byReason = new Map()
  for (const s of skips) byReason.set(s.reason, (byReason.get(s.reason) ?? 0) + 1)

  // [0.6.47] 轮数不许双计：0.6.44 起每一轮都会写一行 `hit-chain`，被闸挡下的轮**另外**
  // 再写一行 `hit-skip`——两行是同一轮的两半。旧算法把 hits 与 skips 直接相加，
  // 挡下越多，轮数、每轮均值、命中率虚高得越多（挡一半就翻倍）。
  // 这里先按「同 sid + 两秒内 + hit≠yes」把 skip 配回它那一轮，配不上的（只有 skip 行的
  // 老写法 / 手工拼的日志）才单独算一轮。
  const pairedHits = new Set()
  const pairedSkips = new Set()
  for (const s of skips) {
    for (let i = 0; i < hits.length; i += 1) {
      if (pairedHits.has(i)) continue
      const h = hits[i]
      if (h.hit === 'yes') continue
      if (s.sid !== '' && h.sid !== '' && s.sid !== h.sid) continue
      if (Math.abs((h.at ?? 0) - (s.at ?? 0)) > 2000) continue
      pairedHits.add(i)
      pairedSkips.add(s)
      break
    }
  }
  const unpairedSkips = skips.filter((s) => !pairedSkips.has(s))
  const rounds = hits.length + unpairedSkips.length

  const lines = [`闸门：${gate}`, '']
  const blockedRounds = Math.max(0, rounds - injected.length)
  lines.push(`出口：${rounds} 轮里有 ${injected.length} 轮注入、${blockedRounds} 轮没注入`)
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
  }
  // 这三行与「注入了多少轮」无关：全被挡下的会话里它们才是唯一有信息量的读数。
  if (gated > 0) lines.push(`闸门挡下的条目：${gated} 条（过线但没进注入的）`)
  if (bodyCut > 0) lines.push(`正文被压：${bodyCut} 条（只留了首句或前几句，全文要用 id 去 memory_read）`)
  if (repeated > 0) lines.push(`同话题抑制：${repeated} 条（上一轮注入过、相似度超线的条目，按条算不按轮算）`)
  // [0.6.49] 「放回」不是「跳过」：它是把本会话里隔得够久的条目重新放回候选，
  // 所以它涨的一般伴随注入条数涨——面板上单列一行，免得被读成又被挡了一批。
  if (released > 0) lines.push(`老条目放回：${released} 条（隔 ${reinjectTurns} 轮没再给过的条目重新进候选；0 = 永不放回）`)
  // [0.6.50] 邻域这一半：它和命中注入花同一份预算，但口径不同——命中是「注入了多少字」，
  // 邻域是「这一轮星图带了几条、砍了几条」。两个数不许相加（同一条记忆可能两层都带，
  // 跨层去重是**邻域**跳过的，命中那边已经算过它自己的字）。
  if (chains.length > 0 || neighborSkips.length > 0) {
    const nRounds = chains.length + neighborSkips.length
    const nLens = chains.map((e) => e.chars).sort((a, b) => a - b)
    const nSum = nLens.reduce((a, b) => a + b, 0)
    const nAvg = nLens.length > 0 ? Math.round(nSum / nLens.length) : 0
    const nIds = chains.reduce((a, e) => a + e.ids, 0)
    const nDeduped = chains.reduce((a, e) => a + e.deduped, 0)
    const nOfftopic = chains.reduce((a, e) => a + e.offtopic, 0)
    const nWeak = chains.reduce((a, e) => a + e.weak, 0)
    const nFlagged = chains.reduce((a, e) => a + e.flagged, 0)
    lines.push(
      '',
      chains.length > 0
        ? `邻域注入：${nRounds} 轮里 ${chains.length} 轮带进上下文（合计 ${nSum.toLocaleString('en-US')} 字 / 平均 ${nAvg} 字每轮 / 中位 ${p50Of(nLens)} / 最多 ${nLens[nLens.length - 1]} · 共 ${nIds} 条）`
        : `邻域注入：${nRounds} 轮一次都没带进上下文`,
    )
    if (neighborSkips.length > 0) {
      const byN = new Map()
      for (const e of neighborSkips) byN.set(e.reason, (byN.get(e.reason) ?? 0) + 1)
      const bits = []
      for (const [r, n] of byN) bits.push(`${neighborReasonLabel(r)} ${n} 轮`)
      lines.push(`- 没带的原因：${bits.join(' · ')}`)
    }
    if (nDeduped > 0) lines.push(`- 跨层去重：跳过 ${nDeduped} 条（别的注入这轮已经带过，邻域不再带第二遍）`)
    if (nOfftopic > 0) lines.push(`- 未沾词：${nOfftopic} 条（强度够但一个词面都不沾，一轮只留一条，其余砍掉）`)
    if (nWeak > 0) lines.push(`- 强度不够：${nWeak} 条（低于门槛，一条都没带）`)
    if (nFlagged > 0) lines.push(`- 打标记：${nFlagged} 条（带了「未沾词」标记，尾部给了 mute 指引）`)
  }
  if (roundPairs.length > 0) {
    lines.push(
      '',
      `一轮合计：命中与邻域都有账的 ${roundPairs.length} 轮里，一起花 ${roundSum.toLocaleString('en-US')} 字（平均 ${roundAvg} 字 / 最多 ${roundMax} 字；其中邻域 ${roundNeighborSum.toLocaleString('en-US')} 字，占 ${roundShare}%）`,
    )
  }
  if (sessionLast !== null && sessionLast.hitChars + sessionLast.chainChars > 0) {
    const total = sessionLast.hitChars + sessionLast.chainChars
    const short = sessionLast.sid.length > 8 ? sessionLast.sid.slice(0, 8) + '…' : sessionLast.sid
    lines.push(
      '',
      `本场会话（${short}）：命中注入 ${sessionLast.hitRounds} 轮 / ${sessionLast.hitChars.toLocaleString('en-US')} 字，` +
        `邻域 ${sessionLast.chainRounds} 轮 / ${sessionLast.chainChars.toLocaleString('en-US')} 字，合计 ${total.toLocaleString('en-US')} 字`,
    )
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

  // [0.6.51] 明细里同理：同一轮的命中行与邻域行并成一行，邻域那行不再单独出现。
  const chainOfHit = new Map()
  const mergedChains = new Set()
  for (const p of roundPairs) {
    chainOfHit.set(p.hit, p.chain)
    mergedChains.add(p.chain)
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
        if (e.released !== null && e.released > 0) bits.push(`放回 ${e.released}`)
        const mate = chainOfHit.get(e)
        if (mate) {
          bits.push(`邻域 ${mate.ids} 条 ${mate.chars} 字（合计 ${e.len + mate.chars} 字）`)
        }
        lines.push(`- ${stamp(e.at)} ${bits.join(' · ')}`)
      } else if (e.kind === 'neighbor') {
        // 0.6.51：已经并进上面那行「注入 … 字 · 邻域 … 字（合计）」的那一轮，不再重复出现。
        if (mergedChains.has(e)) continue
        const bits = [`邻域 ${e.ids} 条`, `${e.chars} 字`]
        if (e.offtopic > 0) bits.push(`未沾词 ${e.offtopic}`)
        if (e.deduped > 0) bits.push(`去重 ${e.deduped}`)
        if (e.flagged > 0) bits.push(`打标 ${e.flagged}`)
        lines.push(`- ${stamp(e.at)} ${bits.join(' · ')}`)
      } else if (e.kind === 'nskip') {
        lines.push(`- ${stamp(e.at)} 邻域没带：${neighborReasonLabel(e.reason)}`)
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
      ? `覆盖 ${stamp(oldest)} 到 ${stamp(newest)} 的 ${rounds} 轮出口记录${chains.length + neighborSkips.length > 0 ? ` · 邻域 ${chains.length + neighborSkips.length} 轮` : ''}`
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
  if (kv.released !== undefined && numOf(kv.released) > 0) bits.push(`放回 ${numOf(kv.released)} 条`)
  if (kv.reinject !== undefined) bits.push(`窗口 ${kv.reinject} 轮`)
  return bits.length > 0 ? `（${bits.join(' · ')}）` : ''
}

/** [0.6.50] 邻域这边的出口名：与命中那边的四种出口不是一套，别复用 reasonLabel。 */
function neighborReasonLabel(reason) {
  switch (String(reason)) {
    case 'short':
      return '问句太短（不到 6 字，不猜）'
    case 'empty':
      return '星图没给出可用的邻居（全被强度 / 词面 / 已带过刷掉）'
    case 'tool':
      return '星图没查成（工具失败）'
    case 'llm':
      return '拿不到消息工厂'
    case 'empty-msg':
      return '这一轮没有消息'
    case 'subagent':
      return '子代理轮不注入'
    default:
      return reason === '' ? '出口没写原因' : reason
  }
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
