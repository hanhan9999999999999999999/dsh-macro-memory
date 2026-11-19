/**
 * 待补连线队列：$DSH_HOME/macro-memory/pending-links.jsonl
 *
 * 为什么需要它：星图是「可重建索引」，新写入的条目要等一轮建图（引擎 12s 巡检）才变成节点。
 * 写记忆时顺手连线的请求如果因为「节点还没入图」或「星图模块这次没接上」而失败，
 * 直接丢掉等于用户白写；把请求落盘排队，之后每次读操作顺手补连，系统就能自愈——
 * 不需要模型记得回来补，也不用等用户在 12 秒后重新说一遍。
 *
 * 三条铁律：
 *   1. 队列坏了不影响记忆主功能（所有 IO 吞异常）；
 *   2. 任何一条连线最多重试到 TTL 到期，不制造无限增长的垃圾；
 *   3. 只排队「用户明确要求过」的连线，绝不自己发明关系。
 */
import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { macroHome, pendingPath, readJsonl, readJsonlDetail } from './store.js'
import { LINKED_MARK, MISSING_PAIR_MARK, SELF_PAIR_MARK, NOT_READY_MARK } from './contract.js'

export { pendingPath }

/**
 * 待补队列的「理由」只有一份（0.2.33）。
 *
 * 面板按理由分组之后，一个状况两种写法就会多出一个组：同样是「连线失败」，
 * 写记忆那条路以前记 `连线失败待重试`，`memory_link` 那条路记 `memory_link 失败待重试`——
 * 用户看到「2 条连线失败 + 1 条 memory_link 失败」，会以为这是两件不同的事。
 * 所以字面量只许在这里出现一次，其余地方一律用常量。
 */
export const PENDING_REASONS = {
  /** 星图模块没接上（子插件未装配 / 被配置关闭） */
  notReady: '星图未装配',
  /** 记忆刚写完，星图那轮建图还没跑到它 */
  notBuilt: '节点待入图',
  /** 星图这次太慢，我们按期限掐断了 */
  slow: '星图太慢待重试',
  /** 连线本身失败（不是「太慢」也不是「没入图」） */
  failed: '连线失败待重试',
  /** 一次写太多 / 一批的总账用完，排到下一轮 */
  deferred: '本次没轮到待补',
}

/** 面板里理由的固定顺序：越靠前越「正常」，越靠后越「要人管」。 */
export const REASON_ORDER = [
  PENDING_REASONS.deferred,
  PENDING_REASONS.notBuilt,
  PENDING_REASONS.slow,
  PENDING_REASONS.failed,
  PENDING_REASONS.notReady,
]

/** 理由归组：认识的按 `REASON_ORDER`，不认识的照原样单列（旧队列里可能留着老写法）。 */
export function reasonCounts(list) {
  const seen = new Map()
  for (const e of list) {
    const key = typeof e.reason === 'string' && e.reason.length > 0 ? e.reason : ''
    seen.set(key, (seen.get(key) ?? 0) + 1)
  }
  const known = REASON_ORDER.filter((r) => seen.has(r)).map((r) => ({ reason: r, count: seen.get(r) }))
  const rest = [...seen.entries()]
    .filter(([r]) => r !== '' && !REASON_ORDER.includes(r))
    .map(([reason, count]) => ({ reason, count }))
  const blank = seen.has('') ? [{ reason: '', count: seen.get('') }] : []
  return [...known, ...rest, ...blank]
}

/** 队列上限：超出就丢最老的，防止坏掉的星图把磁盘撑满。 */
export const PENDING_MAX = 500
/** 一条待补连线的存活时间：过了就认为用户已经不在乎了。 */
export const PENDING_TTL_MS = 7 * 24 * 60 * 60 * 1000
/**
 * 「星图说找不到这两条记忆」的宽限期（0.2.30）。
 *
 * 星图的这句 404 有两种含义，光看字分不出来：
 *   1. 节点还没建进图——记忆刚写完，引擎 12s 巡检还没跑到它（`vendor/dsh-memory-nebula/lib/host/nebula.js:79`）；
 *   2. 记忆真的没了——被删、被合并、id 写错。
 * 前者等一轮就好，后者重试一万次也一样。既然字面分不出来，就用**年龄**分：
 * 排队不足 `MISSING_GRACE_MS` 的一律先留着（建图一轮 12s；200k 条库实测建一次 24.5 秒，
 * 给 10 分钟是「再大的库也建完了」的量级），超过才摘。
 *
 * 旧行为（0.2.29 及之前）是把这句一律当永久失败摘掉：用户刚写完一条记忆、顺手连了邻居，
 * 紧接着读一次记忆触发补连 → 星图还没建到节点 → 说「找不到」→ 队列清零。**用户的连线白写**，
 * 而且没有任何报错。
 */
export const MISSING_GRACE_MS = 10 * 60 * 1000

function valid(entry) {
  return (
    entry &&
    typeof entry === 'object' &&
    typeof entry.a === 'string' &&
    entry.a.length > 0 &&
    typeof entry.b === 'string' &&
    entry.b.length > 0
  )
}

/** 读全队列（坏行直接跳过；顺手清掉过期条目）。 */
export function readPending(now = Date.now()) {
  const out = []
  for (const entry of readJsonl(pendingPath())) {
    if (!valid(entry)) continue
    const ts = Number(entry.ts) || 0
    if (ts > 0 && now - ts > PENDING_TTL_MS) continue
    out.push({
      a: entry.a,
      b: entry.b,
      note: typeof entry.note === 'string' ? entry.note : '',
      ts: ts || now,
      reason: typeof entry.reason === 'string' ? entry.reason : '',
    })
  }
  return out
}

// 0.2.55：队列写不进去原来也是无声的（约定：不打断记忆主功能）。后果比账本更糟——
// 这条连线被排队了、返回 true，其实一个字都没落盘，下次读记忆也不会补；
// 而面板照旧报「0 条，都连上了，没有欠账」。这里留一份最小的失败账，只够面板说实话
// （写成功就清零：旧账不该冒充现在的状态）。
const writeFail = { failures: 0, error: '' }

/** 整体重写队列（先写临时文件再改名，避免半截文件）。 */
function writePending(list) {
  try {
    mkdirSync(macroHome(), { recursive: true })
    const file = pendingPath()
    const tmp = `${file}.tmp`
    const text = list.map((e) => JSON.stringify(e)).join('\n')
    writeFileSync(tmp, text.length > 0 ? `${text}\n` : '', 'utf8')
    renameSync(tmp, file)
    writeFail.failures = 0
    writeFail.error = ''
    return true
  } catch (err) {
    writeFail.failures += 1
    writeFail.error = String(err?.message ?? err)
    return false
  }
}

/** 排一条（同 a→b 已存在就不重复排，只刷新时间与理由）。 */
export function queuePending(a, b, note = '', reason = '') {
  const anchor = String(a ?? '').trim()
  const target = String(b ?? '').trim()
  if (anchor.length === 0 || target.length === 0 || anchor === target) return false
  const now = Date.now()
  const list = readPending(now).filter((e) => !(e.a === anchor && e.b === target))
  list.push({ a: anchor, b: target, note, ts: now, reason })
  while (list.length > PENDING_MAX) list.shift()
  return writePending(list)
}

/** 连线成功后把这条从队列里摘掉（手工补连也算）。 */
export function dropPending(a, b) {
  const anchor = String(a ?? '').trim()
  const target = String(b ?? '').trim()
  const list = readPending()
  const kept = list.filter((e) => !(e.a === anchor && e.b === target))
  if (kept.length === list.length) return false
  return writePending(kept)
}

export function pendingCount() {
  return readPending().length
}

/**
 * 预算哨兵：不是失败，只是「这一轮没来得及」，条目原样留在队列里下轮再补。
 * 用一个独立 Symbol 而不是 `null`/`{timedOut:true}`，是为了让「超时」和「归不出 id」
 * 在代码上根本不可能被混淆——前者要留，后者要摘。
 */
const TIMED_OUT = Symbol('macro-memory:budget-timeout')

/**
 * 给一次 await 套上剩余预算。
 *
 * 为什么不能只靠 `tryCall` 的 timeoutMs：那个数只管「等子插件把工具注册出来」，
 * 工具一旦已注册，`execute` 本身慢多久都照等（nebula_link 在建图争锁时能到几十秒）。
 * 而读路径最怕这个——一次 `memory_search` 被补连带住，用户感觉是「记忆坏了」。
 * 最小预算 `MIN_STEP_MS`：剩几毫秒时不再发请求，直接收工，省得白发一次。
 */
export const MIN_STEP_MS = 120

/**
 * 前台一次写连线的上限（0.2.31）。
 *
 * 0.2.28 的预算只管后台补连（`flushLinks` 1.2s / `flushNow` 1.5s）；前台
 * `memory_link` / 写记忆时顺手连线是**用户在等**的那条路，却一直裸等 `execute`：
 * 星图在建图争锁时能跑几十秒，工具调用就跟着挂几十秒，宿主那边看起来像卡死。
 * 20 秒是「建图 24.5s 那条实测」与「人还能忍」之间的折中：超过它就先记账排队。
 * 排队安全的前提是星图 `addLink` 用 `INSERT … ON CONFLICT(id) DO UPDATE`，重复连同一条边幂等。
 */
export const LINK_CALL_MS = 20 * 1000

/**
 * 一次写入最多当场连几条（0.2.32）。
 *
 * 超过的部分**不许悄悄丢掉**：以前 `applyLinks` 里写的是 `items.slice(0, 12)`，
 * 模型给了 15 条 links，后 3 条既没连、也没排队、文案里一个字都没提——
 * 用户的意图就这么消失了，而且看起来一切正常。现在超出的部分一律进队列（读记忆时自动补），
 * 文案里要说清「另有 N 条排着」。
 */
export const LINKS_PER_WRITE = 12

/**
 * 一批前台连线的总时长上限（0.2.32）。
 *
 * `LINK_CALL_MS` 只管**单条**。12 条各挂 20 秒，一次写记忆能卡 4 分钟——
 * 用户在等的那条路还是能挂死，只是挂了四次。所以一批也要有总账：到点就把剩下的排队走人。
 */
export const LINK_BATCH_MS = 30 * 1000

/**
 * 掐断的那次调用是不是「预算到点」，而不是真的拿到了结果。
 * 哨兵不外泄（Symbol 留在本模块），调用方只能通过这个谓词问，避免各写一份 `===`。
 */
export function isTimedOut(x) {
  return x === TIMED_OUT
}

/**
 * 把毫秒说成人话：「20 秒」而不是「20000 毫秒」，「200 毫秒」而不是「0 秒」。
 * 超时文案里这个数必须真，否则用户按它去判断「要不要再等等」时会看错。
 */
export function describeMs(ms) {
  const n = Math.max(0, Math.round(Number(ms) || 0))
  if (n >= 1000) {
    const sec = n / 1000
    return `${Number.isInteger(sec) ? sec : Math.round(sec)} 秒`
  }
  return `${n} 毫秒`
}

export function withBudget(promise, ms) {
  if (!(ms >= MIN_STEP_MS)) return Promise.resolve(TIMED_OUT)
  let timer
  const guard = new Promise((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), ms)
    // 不让这个计时器把进程（或一次读）多留一秒
    if (typeof timer.unref === 'function') timer.unref()
  })
  const work = Promise.resolve(promise).catch(() => ({ entry: undefined, text: '' }))
  return Promise.race([work, guard]).finally(() => clearTimeout(timer))
}

/**
 * 补连一轮。判据由调用方给（`tryCall` 与 `isLinked`），这里只管顺序与预算：
 *   - 星图整体不可用时立刻停手，别把队列当靶子打（每次调用只探一次）；
 *   - 单条失败只是留在队列里，不影响别的条目；
 *   - `budgetMs` 是**真的**：每一次 await（含短 id 归一那两次 memory_read）都按剩余预算掐断，
 *     掐断即停手、条目留着。宁可不补，也不能把一次读操作拖成几十秒。
 *
 * [macro-fusion 0.2.54] `resolve` 现在可以回一个带 kind 的结构（`resolveIdDetail`），
 * 也能回老的 `完整 id / null`。三种「归不出来」必须分开处理：
 *   - `ambiguous`（短 id 撞车，记忆明明在，只是前缀不够）→ **留着**，摘掉等于永远不补；
 *   - `unavailable`（memory_read 没接上，连有没有都不知道）→ **留着**；
 *   - `missing`（这个工作区真没有 / 已被合并）→ 才摘。
 * 原来一律 `resolve(...) === null` 就摘，并报「清掉 N 条永远连不上的（记忆已合并/删除）」——
 * 一次 meow 超时就能把用户辛苦写的连线整批清掉，而且理由说的是另一回事。
 */
export async function flushPending({ tryCall, isLinked, resolve, budgetMs = 1200, limit = 8, exec } = {}) {
  const started = Date.now()
  const remaining = () => budgetMs - (Date.now() - started)
  const norm = (x) => (x && typeof x === 'object' && typeof x.kind === 'string' ? x : { kind: x === null ? 'missing' : 'ok', id: x })
  const list = readPending()
  if (list.length === 0)
    return { tried: 0, linked: 0, dropped: 0, ambiguous: 0, unavailable: 0, left: 0, stopped: 'empty', budgetMs, limit }

  const done = []
  let linked = 0
  let dropped = 0
  let ambiguous = 0
  let unavailable = 0
  let tried = 0
  let stopped = ''
  for (const entry of list.slice(0, limit)) {
    if (remaining() < MIN_STEP_MS) {
      stopped = 'budget'
      break
    }
    tried += 1
    let a = entry.a
    let b = entry.b
    if (typeof resolve === 'function') {
      const rawA = await withBudget(resolve(entry.a, exec), remaining())
      const rawB = rawA === TIMED_OUT ? TIMED_OUT : await withBudget(resolve(entry.b, exec), remaining())
      if (rawA === TIMED_OUT || rawB === TIMED_OUT) {
        stopped = 'budget'
        tried -= 1
        break
      }
      const da = norm(rawA)
      const db = norm(rawB)
      if (da.kind === 'ambiguous' || db.kind === 'ambiguous') {
        // 记忆在，只是 id 给短了：留着等下一次（或用户把 id 补全），绝不摘
        ambiguous += 1
        continue
      }
      if (da.kind === 'unavailable' || db.kind === 'unavailable') {
        // 这次没查成 ≠ 这条不存在：留着，下一轮再试
        unavailable += 1
        continue
      }
      if (da.kind !== 'ok' || db.kind !== 'ok') {
        dropped += 1
        done.push(entry)
        continue
      }
      a = da.id
      b = db.id
    }
    const r = await withBudget(tryCall('nebula_link', { action: 'link', a, b, note: entry.note }, exec, '星图连线'), remaining())
    if (r === TIMED_OUT) {
      stopped = 'budget'
      // 这条根本没动过手，别算进 tried（0.2.28 的语义：tried = 真的动过几条）
      tried -= 1
      break
    }
    // 判据顺序不能反（0.2.30）：成功 → 真永久 → 「找不到」（要按年龄分）→ 桥没接上。
    // 旧顺序把「找不到」并进「永久失败」，把「刚写完、节点还没建进图」也摘掉了。
    if (isLinked(r.text)) {
      linked += 1
      done.push(entry)
      continue
    }
    if (isSelfPairText(r.text)) {
      // 自己连自己：换多少时间都一样，当场摘
      dropped += 1
      done.push(entry)
      continue
    }
    if (saysMissingNodes(r.text)) {
      // 可能是「还没建进图」，也可能是「真的没了」——只按年龄区分
      if (Date.now() - entry.ts >= MISSING_GRACE_MS) {
        dropped += 1
        done.push(entry)
      }
      continue
    }
    if (r.entry === undefined) {
      // 工具本身上下线了（桥没拿到）/ 调用炸了：这一轮别再打它
      stopped = 'unavailable'
      break
    }
    // 其余（节点还没入图、引擎说稍后再试）留着，等下一轮。
  }
  if (done.length > 0) {
    const drop = new Set(done.map((e) => `${e.a}\u0000${e.b}`))
    writePending(readPending().filter((e) => !drop.has(`${e.a}\u0000${e.b}`)))
  }
  // tried = 真的动过几条（被预算掐断的那条不算动过）；旧写法报 min(len,limit) 会把「没来得及试」也算成试过
  // budgetMs / limit 一起交出去（0.2.36）：面板要能说出「这一轮最多补多久、几条」，
  // 否则被掐断时用户只看到「还剩 N 条」，不知道这个 N 是被 1.5 秒掐的，还是被 20 条掐的。
  return { tried, linked, dropped, ambiguous, unavailable, left: readPending().length, stopped, budgetMs, limit }
}

/** 面板用：队列概况（不触发补连，纯读）。 */
export function pendingReport(limit = 20) {
  const detail = readJsonlDetail(pendingPath())
  const list = readPending()
  if (list.length === 0) {
    const p = pendingPath()
    // 0.2.55：「0 条」有四种来路，一种都不是「星图那边都连上了」
    if (writeFail.failures > 0) {
      return (
        `待补连线：一条都没存下来——最近 ${writeFail.failures} 次写队列都失败了（${writeFail.error}）。\n` +
        `这不是「没有欠账」：该排队的连线确实发生过，只是没落到盘上，读记忆时也补不了。队列：${p}`
      )
    }
    if (detail.unreadable) {
      return `待补连线：队列在，但这次读不出来（${detail.error}）——不是「都连上了、没有欠账」。队列：${p}`
    }
    if (detail.badLines > 0) {
      return `待补连线：队列里有 ${detail.lines} 行，但一行都解析不出来（${detail.badLines} 行坏行）——不是没有欠账，是这份队列坏了。队列：${p}`
    }
    if (detail.entries.length > 0) {
      // 解析出来了却一条都用不上：要么过期了，要么缺 a/b。两种可能都摆出来，不替人挑。
      return `待补连线：队列里有 ${detail.entries.length} 条记录，但这次一条都用不上（要么过期了，要么缺 a/b）。队列：${p}`
    }
    return '待补连线：0 条（星图那边都连上了，没有欠账）。'
  }
  // 0.2.61：limit=0 照办 0，但要说清队列里其实有多少条（不然正文看着像「没有欠账」）
  const cap = Number(limit)
  if (Number.isFinite(cap) && cap <= 0) {
    return `按你给的 limit=${cap} 这次一条都不列（队列里其实有 ${list.length} 条，不是没有欠账）。队列：${pendingPath()}`
  }
  const lines = list.slice(0, cap).map((e, i) => {
    // 本地时间（sv-SE 恰好是 "YYYY-MM-DD HH:mm"），别让面板显示成 UTC 让人误判「过期」
    const when = new Date(e.ts).toLocaleString('sv-SE', { hour12: false }).slice(0, 16)
    const why = e.reason ? `（${e.reason}）` : ''
    return `${i + 1}. ${e.a} ↔ ${e.b}　${when}${why}`
  })
  const more = list.length > cap ? `\n… 还有 ${list.length - cap} 条` : ''
  // 先给一句「按理由」的账（0.2.33）：一串逐条明细看不出「是星图慢，还是我们没轮到」，
  // 也看不出「这 6 条其实是一件事」。不认识的旧理由照原样列出，不吞。
  const groups = reasonCounts(list)
    .map((g) => `${g.reason === '' ? '未记理由' : g.reason} ${g.count}`)
    .join(' · ')
  return `待补连线：${list.length} 条（读记忆时会自动补，过期 ${Math.round(PENDING_TTL_MS / 86400000)} 天丢弃）\n按理由：${groups}\n${lines.join('\n')}${more}`
}

/**
 * 星图**连线成功**的文案（原文见 `vendor/dsh-memory-nebula/lib/index.js` 的 `已固化连线`）。
 *
 * 它和下面几个一样是「跨插件的文字契约」：那边是另一个仓库、另一套版本节奏，
 * 我们只能认字。所以字面量统一放在 `contract.js` 里各写一遍，
 * 再由 verify 拿它们去对 vendor 源码——对面哪天改词，断言先红。
 */
export { LINKED_MARK, MISSING_PAIR_MARK, SELF_PAIR_MARK, NOT_READY_MARK } from './contract.js'

/** 是否真的连上了（nebula_link 的成功文案）。 */
export function isLinkedText(text) {
  return typeof text === 'string' && text.includes(LINKED_MARK)
}

/**
 * 重试也不会变的失败：星图说「不能和自己配对」
 * （原文见 `vendor/dsh-memory-nebula/lib/host/nebula.js:90` 的 `new Error(...)`）。
 *
 * 注意「找不到这两条记忆」**不在**这里（0.2.30）：那句话有两种含义——节点还没建进图（等一轮就好）
 * 与记忆真的没了（重试无用）。混进来的后果是刚写完的连线被当场摘掉，见 `MISSING_GRACE_MS`。
 */
export function isSelfPairText(text) {
  return String(text ?? '').includes(SELF_PAIR_MARK)
}

/**
 * 星图说「找不到这两条记忆」（`vendor/dsh-memory-nebula/lib/host/nebula.js:79`）。
 *
 * 这句**不代表永久失败**：记忆刚写完时节点还没建进图，星图同样这么回。
 * 调用方必须自己决定「留还是摘」，判据是年龄（`MISSING_GRACE_MS`）或结构（再 inspect 一次）。
 */
export function saysMissingNodes(text) {
  return String(text ?? '').includes(MISSING_PAIR_MARK)
}

/**
 * 星图**没接上**（没装配 / 被配置关掉 / 引擎还没起），而不是「星图说这一步不行」。
 *
 * 判据是 bridge 在工具未注册时抛的那句（`lib/macro/bridge.js` 的 `call()`）。分出来的用途：
 * 这两种失败的**措辞**不一样——没接上属于环境问题，说「星图这次没接上」就够了；说不行属于内容问题，
 * 得把星图的原话转告。混在一起写的后果是成功路径上漏出内部错误（0.2.12 修的就是这个）。
 * 那句文案本身在 `contract.js` 起名（`NOT_READY_MARK`），bridge 抛、这里认，两边同一个字。
 */

/** 这条失败文案是不是「星图没接上」。 */
export function isNotReady(text) {
  return String(text ?? '').includes(NOT_READY_MARK)
}

