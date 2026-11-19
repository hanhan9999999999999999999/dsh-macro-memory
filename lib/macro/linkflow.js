/**
 * 连线流程：写记忆时顺手连线、连不上就排队、读记忆时补。
 *
 * 这里只放「跨工具共用」的那部分（写路径 remember/update 与读路径 search/read/link 都要用），
 * 8 个工具的定义在 `defs/*.js`（DESIGN §16）。
 */
import { dropPending, flushPending, isLinkedText, isSelfPairText, queuePending, saysMissingNodes, LINK_BATCH_MS, LINK_CALL_MS, LINKS_PER_WRITE, MIN_STEP_MS, PENDING_REASONS, describeMs, isTimedOut, withBudget } from './links.js'
import { NODE_MISSING_MARK, inspectAnswerKind } from './contract.js'

export const LINK_NOTE = 'macro-memory: 写入时顺手固化的关联'

/** links 的入参形状：字符串 id，或 {id, note}（note 直接写进星图连线，留下「为什么连」）。 */
export const LINKS_SCHEMA = {
  type: 'array',
  description: '写入成功后顺手固化进星图的邻居记忆 id：可直接给 id 字符串，也可给 {id, note} 说明为什么要连。',
  items: {
    oneOf: [
      { type: 'string' },
      {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', description: '邻居记忆 id。' },
          note: { type: 'string', description: '为什么要连（会写进连线，方便以后回看）。' },
        },
        required: ['id'],
      },
    ],
  },
}

/**
 * 把外面的 `links` 拆成「能用的条目」+「丢了几条、为什么」（0.2.78）。
 *
 * [macro-fusion 0.2.78] 旧写法（`const list = Array.isArray(links) ? links : []` 再逐条
 * `continue`）的毛病是：丢的那几条**没有任何人知道**——面板上只剩「已连上 1 条」，
 * 读者会以为 3 条全连了。所以这里把丢弃原因一起交出去，由 `linkDropNote()` 说给读者听。
 */
export function linkArgs(links) {
  const list = Array.isArray(links) ? links : []
  const items = []
  let notArray = 0
  let blank = 0
  let wrongShape = 0
  if (links !== undefined && links !== null && !Array.isArray(links)) notArray = 1
  for (const item of list) {
    if (typeof item === 'string') {
      const id = item.trim()
      if (id.length > 0) items.push({ id, note: LINK_NOTE })
      else blank += 1
      continue
    }
    if (item && typeof item === 'object' && typeof item.id === 'string') {
      const id = item.id.trim()
      if (id.length === 0) {
        blank += 1
        continue
      }
      const note = typeof item.note === 'string' && item.note.trim().length > 0 ? item.note.trim() : LINK_NOTE
      items.push({ id, note })
      continue
    }
    wrongShape += 1
  }
  return { items, drop: { notArray, blank, wrongShape, total: notArray + blank + wrongShape } }
}

/** links 支持两种写法：`"id"` 或 `{ id, note }`（note 会写进星图连线，方便以后回看为什么连）。 */
export function normalizeLinks(links) {
  return linkArgs(links).items
}

/**
 * 「这次给的 links 有几条根本用不了」要说出口（0.2.78）。
 *
 * 两种情况都会让 `applyLinks()` 早退：条目全被筛掉、或者根本不知道锚点是谁。
 * 早退时不说话＝面板看起来跟没给 links 一样，而模型会认为「我已经连上了」。
 */
export function linkDropNote(drop, anchorMissing = false) {
  const d = drop && typeof drop === 'object' ? drop : {}
  const total = Math.max(0, Math.trunc(Number(d.total) || 0))
  if (total <= 0) return ''
  const bits = []
  if (Math.trunc(Number(d.notArray) || 0) > 0) bits.push('links 给的不是数组（整份用法没生效）')
  const blank = Math.max(0, Math.trunc(Number(d.blank) || 0))
  if (blank > 0) bits.push(`${blank} 条是空 id`)
  const shape = Math.max(0, Math.trunc(Number(d.wrongShape) || 0))
  if (shape > 0) bits.push(`${shape} 条既不是 id 字符串，也不是 {id, note}`)
  const head = bits.length > 0 ? `links 里这 ${total} 条没法用：${bits.join('；')}` : `links 里这 ${total} 条一条都没连上`
  return anchorMissing
    ? `${head}——而且这次也不知道要连到哪条记忆（写入回执里没给 id），所以连排队都没法排：先用 memory_search 找到 id，再用 memory_link 手动连。`
    : `${head}——这几条一条都没连、也没进排队：补成正经的 id 再试，别当成「已经连上了」。`
}

/**
 * 「这条记忆还没进星图」的判据（0.2.29）。
 *
 * `nebula_inspect` 返回的是**文本**，不是结构，所以这里只能认措辞——这正是它脆的地方：
 * 星图哪天改一句话，我们就从「等 12 秒再连」悄悄退化成「立刻去连、连不上再排队」，
 * 而且**不会报错**，只是队列里多出一堆本该等一等就好的欠账。
 *
 * 字面量统一放在 `lib/macro/contract.js`（跨插件的字只有那一处），
 * 由 verify 拿它去对 vendor 的源码（`vendor/dsh-memory-nebula/lib/index.js` 的 `星图里没有 id=`）——
 * 对面一改措辞，断言先红，而不是等用户发现「怎么老是排队」。
 */
export { NODE_MISSING_MARK } from './contract.js'

/** 星图这次回话是不是「还没这条记忆」。文本通道唯一的判据。 */
export function saysMissing(text) {
  return String(text ?? '').includes(NODE_MISSING_MARK)
}

/**
 * [macro-fusion 0.2.54] 「这条没连上」的三种真相，各一句话。
 *
 * 原来三处（memory_link 的 a/b、remember 的 links 参数、补连队列）共用一句
 * 「找不到这条记忆（id 写错了，或它已经被合并掉）」——可短 id 撞车时它明明在，
 * 只是前缀不够；meow 没接上时连「有没有」都不知道。把「你给短了」和「工具没就绪」
 * 都说成「它没了」，读者只能去重新建一条，于是同一条记忆被写了两遍。
 * 所以：撞车、没查成、真没有，三句分开；真没有那句才允许提「写错了 / 被合并」。
 */
export const LINK_AMBIGUOUS_LINE =
  '这个短 id 不止一条记忆，这次一条都没连——把 id 给够位数（至少 8 位，最好整条）再写一次。连错一条比没连上更难发现'
export const LINK_UNAVAILABLE_LINE =
  '这次没查成（读记忆的工具没接上），没连——这不是「这条记忆不存在」，等它就绪再写一次'
export const LINK_MISSING_LINE =
  '这个工作区里没有这条记忆，没连——id 可能写错了一位，或者它已经被合并/删除，用 memory_search 反查一下'

/**
 * 后台补连与面板补连接的期限（0.2.33）。
 *
 * 这些数以前散在三处：`flushLinks` 里写 `1200, 8`，`flushNow` 的默认参数写 `1500, 20`，
 * 面板还自己再传一遍 `{ budgetMs: 1500, limit: 20 }`——面板改一次要改两处，漂了也没人发现。
 * 现在：常量只在这里，config 可覆盖，面板不写数（`flow.flushNow(exec)` 就是面板口径）。
 */
export const FLUSH_LINKS_BUDGET_MS = 1200
export const FLUSH_LINKS_LIMIT = 8
export const FLUSH_NOW_BUDGET_MS = 1500
export const FLUSH_NOW_LIMIT = 20

/** 等星图建图的轮询粒度：约等于它一轮巡检（12s）的十分之一量级。 */
export const POLL_STEP_MS = 1500

/**
 * 造一套「调用子插件 + 连线」的能力。返回值同时给 `defs/*.js` 用：
 * `call` / `tryCall`（统一超时与失败文案）、`applyLinks`（写路径）、`flushLinks`（读路径节流补连）、
 * `flushNow`（运维面板手动补一轮）。
 */
export function createLinkFlow({ bridge, config = {} }) {
  const toolWaitMs = config.toolWaitMs ?? 30000
  const linkWaitMs = config.linkWaitMs ?? 14000
  const flushThrottleMs = config.flushThrottleMs ?? 30000
  // 前台一次写连线的上限（0.2.31）：用户在等的这条路也必须有个头，不能跟着星图建图一起挂
  const linkCallMs = config.linkCallMs ?? LINK_CALL_MS
  // 一批的总账（0.2.32）与单批条数：单条有期限 ≠ 一批有期限，12 条各挂 20 秒还是 4 分钟
  const linkBatchMs = config.linkBatchMs ?? LINK_BATCH_MS
  const linksPerWrite = config.linksPerWrite ?? LINKS_PER_WRITE
  // 补连的预算与条数（0.2.33）：后台一条、面板一条，两条都不许自己写数
  const flushBudgetMs = config.flushBudgetMs ?? FLUSH_LINKS_BUDGET_MS
  const flushLimit = config.flushLimit ?? FLUSH_LINKS_LIMIT
  const panelBudgetMs = config.panelBudgetMs ?? FLUSH_NOW_BUDGET_MS
  const panelLimit = config.panelLimit ?? FLUSH_NOW_LIMIT
  const pollStepMs = config.pollStepMs ?? POLL_STEP_MS

  const call = (name, args, exec) => bridge.call(name, args, exec, toolWaitMs)
  const tryCall = (name, args, exec, label) => bridge.tryCall(name, args, exec, toolWaitMs, label)

  /**
   * 星图是「可重建索引」：新写入的条目要等一轮建图（约 12s 巡检）才变成节点。
   * 返回三态：'ready' 已入图 / 'pending' 还没入图（等得起，稍后再连）/ 'unavailable' 星图模块根本没接上。
   * 三态必须分开——退化成二态会把「没装星图」错报成「等 12 秒就好」。
   *
   * 两个判据的性质完全不同，别混：
   *   - 'unavailable' 看的是**结构**（`probe.entry === undefined`，即桥根本没拿到这个工具），稳；
   *   - 'pending' 看的是**措辞**（`inspectAnswerKind`），脆，靠 verify 盯着 vendor 的原文。
   */
  async function graphState(id, exec, deadlineMs = linkWaitMs) {
    const deadline = Date.now() + Math.max(0, deadlineMs)
    for (;;) {
      const probe = await tryCall('nebula_inspect', { id, neighbors: 0 }, exec, '星图')
      if (probe.entry === undefined) return 'unavailable'
      const text = String(probe.text ?? '')
      // 只有「正常正文」才算 ready（0.2.42）。原来写的是「非空且不含 NODE_MISSING_MARK 就算 ready」，
      // 于是 0.2.42 给 inspect 补的「图还是空的」那一支会被判成 ready：空图上每次写入都先去连、
      // 连不上再落一条「失败」欠账——原因错（应为「节点待入图」），而且要多等一次读才补上。
      if (text.length > 0 && inspectAnswerKind(text) === 'ok') return 'ready'
      if (Date.now() >= deadline) return 'pending'
      // 睡也不能睡过期限：轮询间隔 `pollStepMs` 是「建图一轮」的量级，
      // 但调用方可能只给了 300ms（探针就是这么测的）——按剩余时间取小，别把等待做超。
      await new Promise((r) => setTimeout(r, Math.min(pollStepMs, Math.max(0, deadline - Date.now()))))
    }
  }

  /**
   * 短 id 归一成完整 id。
   *
   * meow 的工具输出与快照只给前 8 位（`findById` 支持前缀），而星图 `resolveIds` 只认完整 id
   * 或 `meow:<store>:<level>:<id>` 形式的节点 id。不归一就会出现「刚写完的记忆，连线说找不到」。
   * 归不出来（记忆已被删/合并）返回 null，调用方据此判定为永久失败，不再排队重试。
   */
  const idCache = new Map()

  /**
   * [macro-fusion 0.2.54] 归一的结果不能只有「成 / 不成」两态。
   *
   * memory_read 从 0.2.52 起把「短 id 撞车」单独标成 `ambiguous`（列出候选、一条都不读）；
   * 从 0.2.53 起相似检索也这么办。可归一这边原来只回 `null`，于是三件完全不同的事被压成一句话
   * 「找不到这条记忆（id 写错了，或它已经被合并掉）」：
   *   - 真没有（missing）：这句才对；
   *   - 撞车（ambiguous）：这条记忆**在**，只是前缀不够——这么说等于把「你给短了」说成「它没了」；
   *   - 这次没查成（unavailable，meow 没装配/超时/报错）：连「有没有」都不知道，更不该下结论。
   * 更糟的是补连队列：`flushPending` 见 `null` 就当「永远连不上」摘掉，面板还报「清掉 N 条（记忆已合并/删除）」。
   * 所以归一必须回一个带 kind 的结构，让调用方各说各的话。
   */
  async function resolveIdDetail(id, exec) {
    const raw = String(id ?? '').trim()
    if (raw.length === 0) return { kind: 'missing', id: '', note: 'id 是空的' }
    if (raw.length >= 36) return { kind: 'ok', id: raw }
    const hit = idCache.get(raw)
    if (hit !== undefined) return { kind: 'ok', id: hit }
    const r = await tryCall('memory_read', { id: raw }, exec, '记忆')
    const v = r.value
    if (v && typeof v === 'object') {
      if (v.ambiguous === true) {
        // 原样带上 meow 的候选清单：口径只有一处，我们不重写它的措辞
        return { kind: 'ambiguous', id: raw, note: String(v.note ?? '').trim(), candidates: String(v.candidates ?? '') }
      }
      if (v.found === true && typeof v.id === 'string') {
        idCache.set(raw, v.id)
        return { kind: 'ok', id: v.id }
      }
      return { kind: 'missing', id: raw, note: String(v.note ?? '').trim() }
    }
    // 没有可用的回执：工具没接上（桥拿不到 / 调用炸了），或者回来一个不是对象的东西。
    // 这两种都只能算「没查成」——「找不到这条记忆」这个结论我们根本还没拿到依据。
    return { kind: 'unavailable', id: raw, note: String(r.text ?? '').replace(/^未完成：/, '').slice(0, 120) }
  }

  /** 兼容旧调用点：只要完整 id 的地方用这个（拿不到就 null）。 */
  async function resolveId(id, exec) {
    const d = await resolveIdDetail(id, exec)
    return d.kind === 'ok' ? d.id : null
  }

  /**
   * 写记忆时顺手连线。三种「这次没连上」的情况都要落盘排队（见 lib/macro/links.js）：
   * 星图没接上 / 节点还没入图 / 单条连线报错。下次读记忆时自动补，不指望模型记得回来补。
   */
  async function applyLinks(anchorId, links, exec, label) {
    const { items, drop } = linkArgs(links)
    if (items.length === 0 && drop.total === 0) return ''
    // 0.2.78：条目被筛光 / 不知道锚点是谁，这两种早退以前都是 `return ''`——
    // 面板看起来跟没给 links 一样，而调用者以为「已经连上了」。
    if (!anchorId) return linkDropNote({ ...drop, total: drop.total + items.length }, true)
    if (items.length === 0) return linkDropNote(drop)
    const anchor = (await resolveId(anchorId, exec)) ?? String(anchorId)
    const state = await graphState(anchor, exec)
    if (state !== 'ready') {
      let queued = 0
      // 排队不设条数上限（队列自己有 PENDING_MAX）：星图还没就绪时，用户的每一条都得留下
      for (const target of items) {
        if (queuePending(anchor, target.id, target.note, state === 'unavailable' ? PENDING_REASONS.notReady : PENDING_REASONS.notBuilt)) queued += 1
      }
      const why =
        state === 'unavailable'
          ? '星图模块这次没接上（子插件未装配或配置关闭）'
          : '星图还没建到这条记忆（约 12s 一轮巡检）'
      const droppedNote = linkDropNote(drop)
      const queuedText = `关联已排队 ${queued} 条（${why}）：之后读记忆时自动补连，不用你再提醒；也可以现在就 memory_link(action="link", a="${anchor}", b="…") 手动连。`
      return droppedNote ? `${queuedText}\n\n${droppedNote}` : queuedText
    }
    const lines = []
    let queued = 0
    // 单批条数（LINKS_PER_WRITE）与单批总时长（linkBatchMs）两道闸：超出的都排队，一条都不丢
    const head = items.slice(0, linksPerWrite)
    const overflow = items.slice(linksPerWrite)
    const deadline = Date.now() + linkBatchMs
    const later = []
    for (let i = 0; i < head.length; i += 1) {
      const target = head[i]
      const left = deadline - Date.now()
      if (left < MIN_STEP_MS) {
        // 一批的总账到点了：这一条和后面的都排进队列，文案里如实说
        later.push(...head.slice(i))
        break
      }
      const d = await resolveIdDetail(target.id, exec)
      // 0.2.54：三种「归不出来」各说各的，别一律说成「找不到（id 写错了/已被合并）」
      if (d.kind === 'ambiguous') {
        lines.push(`- ${target.id}：${LINK_AMBIGUOUS_LINE}`)
        continue
      }
      if (d.kind === 'unavailable') {
        const queued1 = queuePending(anchor, target.id, target.note, PENDING_REASONS.notReady)
        if (queued1) queued += 1
        lines.push(
          `- ${target.id}：${LINK_UNAVAILABLE_LINE}${queued1 ? '，已排队等补连' : ''}`,
        )
        continue
      }
      if (d.kind !== 'ok') {
        lines.push(`- ${target.id}：${LINK_MISSING_LINE}`)
        continue
      }
      const full = d.id
      const raw = await withBudget(tryCall('nebula_link', { action: 'link', a: anchor, b: full, note: target.note }, exec, '星图连线'), Math.min(linkCallMs, left))
      if (isTimedOut(raw)) {
        // 掐断不等于失败：星图可能已经把边写进去了（addLink 幂等），所以只说「这次没等到」，
        // 记一条待补——用户填的 links 一个字都不能丢。
        queuePending(anchor, full, target.note, PENDING_REASONS.slow)
        queued += 1
        lines.push(`- ${target.id}：星图 ${describeMs(Math.min(linkCallMs, left))}内没回应（多半在建图），已排队等补连`)
        continue
      }
      const r = raw
      if (isLinkedText(r.text)) {
        lines.push(`- ${target.id}：已连上`)
        continue
      }
      if (isSelfPairText(r.text)) {
        // 自己连自己：星图明确拒绝，排队也没用，如实转述
        lines.push(`- ${target.id}：${String(r.text).split('\n')[0]}`)
        continue
      }
      // 「找不到这两条记忆」不是永久失败（0.2.30）：记忆刚写完、星图还没建到节点时它也这么回。
      // 这时**必须排队**——否则用户写了 links 等于没写，而且我们还会把责任说成「id 写错了」。
      const notBuilt = saysMissingNodes(r.text)
      if (queuePending(anchor, full, target.note, notBuilt ? PENDING_REASONS.notBuilt : PENDING_REASONS.failed)) queued += 1
      lines.push(`- ${target.id}：${notBuilt ? '星图还没建到它（约 12s 一轮巡检），已排队等补连' : String(r.text).split('\n')[0]}`)
    }
    // 这一次没轮到的（超出单批条数 / 超出单批总时长）全部排队：宁可晚几分钟补上，也不能悄悄消失
    for (const target of [...overflow, ...later]) {
      if (queuePending(anchor, target.id, target.note, PENDING_REASONS.deferred)) queued += 1
    }
    const notes = []
    // 0.2.78：筛掉的条目也要占一行——否则「连了 1 条」会被读成「3 条都连了」
    const droppedNote = linkDropNote(drop)
    if (droppedNote) notes.push(droppedNote)
    if (queued > 0) notes.push(`另有 ${queued} 条排队等补连（读记忆时自动重试）。`)
    if (overflow.length > 0) notes.push(`一次最多当场连 ${linksPerWrite} 条，多出来的 ${overflow.length} 条已排队。`)
    if (later.length > 0) notes.push(`整批最多连 ${describeMs(linkBatchMs)}，没连完的 ${later.length} 条已排队。`)
    const tail = notes.length > 0 ? `\n${notes.join(' ')}` : ''
    return `星图连线（${label}）：\n${lines.join('\n')}${tail}`
  }

  let lastFlush = 0

  /**
   * 读路径顺手补连。节流 30s，预算 `flushBudgetMs`——宁可不补，也不能把一次读拖成几十秒。
   * 星图整体不可用时立刻停手，不把队列当靶子打。
   */
  async function flushLinks(exec) {
    if (Date.now() - lastFlush < flushThrottleMs) return
    lastFlush = Date.now()
    try {
      await flushPending({ tryCall, isLinked: isLinkedText, resolve: resolveIdDetail, exec, budgetMs: flushBudgetMs, limit: flushLimit })
    } catch {
      /* 补连是锦上添花，失败不影响这次读 */
    }
  }

  /** 运维面板手动补一轮（不节流，但同样有预算上限）。面板不传数，走的是同一条出口。 */
  async function flushNow(exec, opts = {}) {
    lastFlush = Date.now()
    const budgetMs = opts.budgetMs ?? panelBudgetMs
    const limit = opts.limit ?? panelLimit
    return flushPending({ tryCall, isLinked: isLinkedText, resolve: resolveIdDetail, exec, budgetMs, limit })
  }

  return {
    call,
    tryCall,
    toolWaitMs,
    linkWaitMs,
    flushThrottleMs,
    linkCallMs,
    linkBatchMs,
    linksPerWrite,
    flushBudgetMs,
    flushLimit,
    panelBudgetMs,
    panelLimit,
    pollStepMs,
    graphState,
    resolveId,
    resolveIdDetail,
    applyLinks,
    flushLinks,
    flushNow,
  }
}
