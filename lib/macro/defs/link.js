import { TEXT_OUT } from '../shared.js'
import { pathAnswerKind } from '../contract.js'
import { cardTitle } from '../panel.js'
import { appendNeighborLog, clearSuspectEdge } from '../neighbor.js'
import { workspaceOfExec } from '../dreamledger.js'
import {
  LINK_CALL_MS,
  PENDING_REASONS,
  describeMs,
  dropPending,
  isLinkedText,
  isNotReady,
  isSelfPairText,
  isTimedOut,
  queuePending,
  saysMissingNodes,
  withBudget,
} from '../links.js'

/**
 * [macro-fusion 0.2.59] 动作名和两端 id 都是「必填的枚举 / 必填的字段」，原来却是流水线自己往下走。
 *
 * `const action = String(args.action)` 只在**不认识**时抛错，`args.a` / `args.b` 干脆不校验：
 * `resolveIdDetail(undefined)` 回 `{ kind: 'missing', id: '' }`，而下面那句
 * `[ra === null ? args.a : null].filter(Boolean)` 会把 `undefined` 过滤掉——于是「缺参数」
 * 假装成「两端都查到了」，payload 变成 `{ a: null, b: null }`，星图回一句「连线未完成」，
 * 我们再把它读成「星图还没建到 / 暂时没落图」→ **排一条永远连不上的欠账**，还告诉用户
 * 「已排队，读记忆时自动补」。缺参数是最常见的调用错误，却拿到了最像环境问题的那句话。
 */
const LINK_ACTIONS = ['link', 'unlink', 'mute', 'unmute', 'path']

/**
 * [macro-fusion 0.2.60] 卡片上的中文名：动作键不是名字。
 * 0.2.25 在 memory_admin 里已经修过一次同样的毛病（`记忆运维：stats` 没人看得懂），
 * 这里漏了——`星图连线：path` 既不知道在做什么，还把只读的 path 标成了写操作。
 */
const LINK_ACTION_LABELS = {
  link: '连一条手工线',
  unlink: '断开手工线',
  mute: '屏蔽自动关联',
  unmute: '撤销屏蔽',
  path: '看证据链',
}

/** 动作名归一：trim + 小写，空值＝没给。不认识就一句都不动（和 0.2.58 的 mode 同一套规矩）。 */
function linkActionOf(args) {
  const raw = args.action
  if (typeof raw !== 'string' || raw.trim() === '') {
    return { name: '', bad: true, missing: true, raw: raw === undefined ? '' : String(raw) }
  }
  const name = raw.trim().toLowerCase()
  return { name, bad: !LINK_ACTIONS.includes(name), missing: false, raw: String(raw) }
}

function badActionText(act) {
  const list = 'link / unlink / mute / unmute / path'
  if (act.missing) {
    return (
      `memory_link 这次一条都没动：没给 action。\n` +
      `要做的动作得写明：${list}（连一条手工线用 link，断开用 unlink，屏蔽推断错的自动关联用 mute，撤销屏蔽用 unmute，解释证据链用 path）。\n` +
      '星图和记忆都没动——这不代表「连不上」，只是这一步还没开始。'
    )
  }
  return (
    `memory_link 这次一条都没动：action 给的是「${act.raw}」，这里只认 ${list}（大小写不敏感，前后空格会去掉）。\n` +
    '这不代表「连不上」——是动作名没对上，星图和记忆都没动。\n' +
    '对应关系：连一条手工线用 link；断开手工线用 unlink；屏蔽推断错的自动关联用 mute；撤销屏蔽用 unmute；解释两条记忆之间的证据链用 path（配 maxHops）。'
  )
}

const LINK_END_FIELDS = [
  ['a', '起点记忆的 id'],
  ['b', '终点记忆的 id（path 的终点）'],
]

/** 缺哪端就说哪端。空串 / 纯空格也算没给——`String(undefined)` 曾经让这一支直接消失。 */
function missingEnds(args) {
  const out = []
  for (const [key, hint] of LINK_END_FIELDS) {
    const v = args[key]
    if (typeof v !== 'string' || v.trim() === '') out.push({ key, hint })
  }
  // [0.6.65] pairs 给了但不是数组：这不是「缺 a」，但也绝不能被一句「缺 a」盖过去——
  // 调用方会以为「补上 a/b 就好」，那几对其实是形状不对。所以在这里占一格，一并说清。
  if (args?.pairs !== undefined && args?.pairs !== null && !Array.isArray(args.pairs)) {
    out.push({ key: 'pairs', hint: '要给成 [[a1,b1],[a2,b2]] 这种「一对一组」的数组（这次给的不是数组），这几对没动' })
  }
  return out
}

function missingEndsText(act, ends) {
  const which = ends.map((e) => (e.key === 'pairs' ? e.hint : `缺 ${e.key}（${e.hint}）`)).join('；')
  return (
    `memory_link(${act.name}) 这次一条都没动：${which}。\n` +
    'id 从 memory_search / memory_read 的回执里抄，8 位短 id 也认。\n' +
    '两端 id 没齐之前不会去动星图，也不会先排一条连不上的欠账——补上再调一次就行。'
  )
}

/** 参数给错了动作：一样要说「这次没用上」，不能当没看见（0.2.57 / 0.2.58 的同一套口径）。 */
function linkNotes(action, args) {
  const notes = []
  if (args.maxHops !== undefined && action !== 'path') {
    notes.push(`maxHops 只在 path 这个动作生效（这次是 ${action}），没用上。`)
  }
  if (typeof args.note === 'string' && args.note.trim() !== '' && action !== 'link' && action !== 'mute') {
    notes.push(`note 只有 link / mute 会存下来（这次是 ${action}），这句理由没地方记。`)
  }
  if (args.pairs !== undefined && args.pairs !== null && action !== 'mute') {
    notes.push(`pairs 只在 mute 生效（这次是 ${action}），这几对一条都没动。`)
  }
  return notes
}

/**
 * [0.6.65] 一次摘掉一整批错边：`pairs=[[a1,b1],[a2,b2]]`。
 *
 * 起因是邻域注入的修错闭环只能一跳一跳修：注入块里标了 3 条「未沾词」，
 * 尾注只给第一跳的现成命令，剩下两跳模型得自己拼 id，实际就没人拼——
 * 错边于是留在图上，下一轮继续占上下文。批量口的目标不是「更省字的命令」，
 * 而是让「这一轮确实无关的那几条」一次修完，和「只摘真正错的」这条护栏不冲突。
 *
 * 形状不对的条目**不静默丢**：丢掉的会被读成「那把也摘了/没摘也算成功」。
 * 返回 { pairs, notes }：pairs 是能做的，notes 是要说出来的（越界、形状不对）。
 */
const MUTE_PAIRS_MAX = 20

function mutePairsOf(action, args) {
  const none = { pairs: [], notes: [] }
  if (action !== 'mute' || args?.pairs === undefined || args?.pairs === null) return none
  // 不是数组：pairs 一条都做不了，但话要由 missingEnds 那边说（同一句话只说一次）。
  if (!Array.isArray(args.pairs)) return none
  const pairs = []
  const notes = []
  let bad = 0
  for (const one of args.pairs) {
    if (!Array.isArray(one) || one.length !== 2) {
      bad += 1
      continue
    }
    const a = typeof one[0] === 'string' ? one[0].trim() : ''
    const b = typeof one[1] === 'string' ? one[1].trim() : ''
    if (a === '' || b === '') {
      bad += 1
      continue
    }
    pairs.push([a, b])
  }
  if (bad > 0) notes.push(`有 ${bad} 对形状不对（每组要两个 id，空值也算没给），这几对没动。`)
  if (pairs.length > MUTE_PAIRS_MAX) {
    notes.push(`一次最多 ${MUTE_PAIRS_MAX} 对（给了 ${pairs.length} 对），这次只做前 ${MUTE_PAIRS_MAX} 对，剩下的再调一次。`)
    return { pairs: pairs.slice(0, MUTE_PAIRS_MAX), notes }
  }
  return { pairs, notes }
}

/** 逐对的成败判定：星图自己的话里能认出来的失败，比「回执非空就算成」可靠。 */
const MUTE_FAIL_HEADS = [
  '星图连线这次没做：',
  '这个工作区里没有这条记忆：',
  '星图这次没接上，',
  '星图还没建到这两条记忆',
]

function muteVerdict(text) {
  const t = String(text ?? '').trim()
  if (t === '') return { ok: false, why: '星图没回话（空回执）' }
  if (/内没回应/.test(t)) return { ok: false, why: '星图没在预算内回话（多半在建图），稍后重试' }
  if (MUTE_FAIL_HEADS.some((h) => t.startsWith(h))) return { ok: false, why: t.split('\n')[0].slice(0, 70) }
  return { ok: true, why: '' }
}

/**
 * [0.6.65] 批量主体：逐对走**同一条**单对路径（不是另写一套星图调用），
 * 这样歧义 / 没查成 / 不存在 / 超时这四种失败还是原来那几句原话——
 * 批量只是把结果收成一张清单，不新增一套「为什么没成」的说法。
 */
async function runMuteBatch(flow, pairs, args, exec) {
  const done = []
  const failed = []
  for (const [a, b] of pairs) {
    const text = await runLink(flow, 'mute', { ...args, a, b, pairs: undefined }, exec)
    const v = muteVerdict(text)
    if (v.ok) done.push(`${a} ↔ ${b}`)
    else failed.push({ a, b, why: v.why })
  }
  const head =
    done.length === 0
      ? `这批 ${pairs.length} 跳一条都没摘掉。`
      : `摘掉 ${done.length} 跳${failed.length === 0 ? '' : `，${failed.length} 跳没成（一共给了 ${pairs.length} 对）`}：${done.slice(0, 8).join('、')}${done.length > 8 ? ` 等 ${done.length} 跳` : ''}。`
  const lines = [head]
  if (failed.length > 0) {
    lines.push('没成的这几跳（星图的原话，重试时只给它们就行）：')
    for (const f of failed.slice(0, 8)) lines.push(`- ${f.a} ↔ ${f.b}：${f.why}`)
    if (failed.length > 8) lines.push(`- …还有 ${failed.length - 8} 跳没列`)
  }
  if (done.length > 0) {
    lines.push('断掉的这些不会再出现在邻域注入里，账上的观察记录也一起销了（重建也不会再连）。')
  }
  return lines.join('\n')
}

export function createLink({ flow, meowDir }) {
  // [0.6.54] 错边账要写在「邻域那一份」日志里，所以 link 也要知道 meow 目录。
  // 但 runLink 的签名是判据钉住的（verify A56：四参、薄壳一行调起）——不为自己方便改它，
  // 改成挂在 flow 上带进去：flow 本来就是这一支的注入面。
  if (meowDir !== undefined && flow && typeof flow === 'object') flow.meowDir = meowDir
  return {
    name: 'memory_link',
    description:
      '管理星图（宏记忆 · 星图）里的连线：link 固化一条手工连线、unlink 断开手工线、mute 屏蔽推断错的自动关联（重建也不会再连）、unmute 撤销屏蔽、path 解释两条记忆之间的最短证据链。a/b 支持 8 位短 id；mute 可以给 pairs 一次摘掉好几跳。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['link', 'unlink', 'mute', 'unmute', 'path'], description: '要做的动作。' },
        a: { type: 'string', description: '记忆 A 的 id（8 位短 id 也行）。' },
        b: { type: 'string', description: '记忆 B 的 id（path 的终点，8 位短 id 也行）。' },
        pairs: {
          type: 'array',
          description:
            'action=mute 一次摘掉好几跳：[[a1,b1],[a2,b2]]（最多 20 对，id 可以是 8 位短 id）。给了 pairs 就不用给 a/b。',
          items: { type: 'array', items: { type: 'string' } },
        },
        note: { type: 'string', description: '理由，方便以后回看为什么连/为什么屏蔽。' },
        maxHops: { type: 'integer', description: 'path 最多几跳，默认 6。' },
      },
      required: ['action'],
    },
    output: TEXT_OUT,
    async execute(args, exec) {
      const act = linkActionOf(args)
      if (act.bad) return badActionText(act)
      const batch = mutePairsOf(act.name, args)
      const ends = batch.pairs.length > 0 ? [] : missingEnds(args)
      if (ends.length > 0) return missingEndsText(act, ends)
      const text = await runLink(flow, act.name, args, exec)
      const notes = [...linkNotes(act.name, args), ...batch.notes]
      return notes.length > 0 ? `${text}\n\n${notes.join('\n')}` : text
    },
    presentCall(args) {
      // [macro-fusion 0.2.60] 卡片标题也是口径：动作键（link/path）不是名字，
      // 只读的 path 也不该被标成写操作。中文名与 kind 都从这里定，标题走 cardTitle()。
      const act = linkActionOf(args)
      if (act.bad) return { card: 'generic', title: cardTitle('星图连线', '动作名没对上'), kind: 'read' }
      const pairs = Array.isArray(args.pairs) ? args.pairs.filter((one) => Array.isArray(one) && one.length === 2) : []
      if (act.name === 'mute' && pairs.length > 0) {
        return { card: 'generic', title: cardTitle('星图连线', `一次摘 ${pairs.length} 跳`), kind: 'write' }
      }
      const ends = [args.a, args.b].filter((v) => typeof v === 'string' && v.trim() !== '').map((v) => v.trim())
      const detail = ends.length > 0 ? `${LINK_ACTION_LABELS[act.name]} ${ends.join(' ↔ ')}` : LINK_ACTION_LABELS[act.name]
      return { card: 'generic', title: cardTitle('星图连线', detail), kind: act.name === 'path' ? 'read' : 'write' }
    },
  }
}

/**
 * [0.6.54] 错边销账：mute 成功之后把这一跳从观察账里摘掉，留一行 `neighbor-fix`。
 * 单独一个函数只为一件事——runLink 的入口处必须还是那**一行** `return r2.text`（verify A34 钉着的结构），
 * 别让「顺手记一笔」把这句撑成一块。
 */
function noteSuspectCleared(exec, ra, rb, meowDir) {
  try {
    const ws = workspaceOfExec(exec)
    if (ws === '') return
    const cleared = clearSuspectEdge(ws, ra, rb)
    if (cleared <= 0) return
    // 记在邻域那一份账里（同一个 dream-debug.log）：面板一条解析器就能把「断了几跳」算出来。
    appendNeighborLog(ws, typeof meowDir === 'function' ? meowDir() : '.dsh-meow', 'neighbor-fix', `a=${String(ra).slice(0, 8)} b=${String(rb).slice(0, 8)} via=mute cleared=${cleared}`)
  } catch {
    // 销账失败不影响 mute 本身——图已经断了，这才是用户要的结果。
  }
}

/**
 * 动作名与两端 id 都已校验过。[macro-fusion 0.2.59] 主体从 execute 搬到模块级函数：
 * 对象方法里裸调模块级函数会解析到外层作用域（0.2.58 踩过），所以 flow 显式传进来。
 */
async function runLink(flow, action, args, exec) {
  // [0.6.65] 批量摘边从这里分出去：一对时归一回单对路径（下游一字不改），多对时逐对收成一张清单。
  const batch = mutePairsOf(action, args)
  if (batch.pairs.length > 1) return runMuteBatch(flow, batch.pairs, args, exec)
  if (batch.pairs.length === 1) args = { ...args, a: batch.pairs[0][0], b: batch.pairs[0][1], pairs: undefined }
  // 短 id → 完整 id：meow 输出只给 8 位前缀，星图节点 id 是完整 id。
  // 0.2.54：归不出来有三种，各说各的——撞车（记忆在、前缀不够）/ 没查成（不知道有没有）/
  // 真没有。原来一律报「找不到（id 写错了，或它已经被合并/删除）」，撞车和超时都被说成「它没了」。
  const da = await flow.resolveIdDetail(args.a, exec)
  const db = await flow.resolveIdDetail(args.b, exec)
  const AMB = '星图连线这次没做：'
  if (da.kind === 'ambiguous' || db.kind === 'ambiguous') {
    const notes = [da, db]
      .filter((d) => d.kind === 'ambiguous')
      .map((d) => `「${d.id}」${d.note || 'id 给短了，落不到唯一一条'}`)
    return (
      `${AMB}${notes.join('；')}\n` +
      `连错一条比没连上更难发现，所以这次一条都没连：把 id 给够位数（至少 8 位，最好整条）再试一次。`
    )
  }
  if (da.kind === 'unavailable' || db.kind === 'unavailable') {
    const notes = [da, db].filter((d) => d.kind === 'unavailable').map((d) => `「${d.id}」${d.note || '没查到'}`)
    return (
      `${AMB}这次没查成：${notes.join('；')}\n` +
      `这不是「这条记忆不存在」——读记忆的工具这次没接上，等它就绪再试一次；连线一条都没动。`
    )
  }
  const ra = da.kind === 'ok' ? da.id : null
  const rb = db.kind === 'ok' ? db.id : null
  const missing = [ra === null ? args.a : null, rb === null ? args.b : null].filter(Boolean)
  if (missing.length > 0) {
    return `这个工作区里没有这条记忆：${missing.join('、')}——id 可能写错了一位，或者它已经被合并/删除（合并会把旧 id 指到新条目上，旧的那条就查不到了）。用 memory_search 反查一下 id 再连。`
  }
  const payload = { action, a: ra, b: rb }
  if (args.note !== undefined) payload.note = args.note
  if (args.maxHops !== undefined) payload.maxHops = args.maxHops

  if (action === 'link') {
    await flow.flushLinks(exec)
    const callMs = flow.linkCallMs ?? LINK_CALL_MS
    const raw = await withBudget(flow.tryCall('nebula_link', payload, exec, '星图连线'), callMs)
    if (isTimedOut(raw)) {
      // 掐断不是失败（0.2.31）：星图多半正在建图，`addLink` 幂等，排队重试不会写脏数据。
      queuePending(ra, rb, typeof args.note === 'string' ? args.note : '', PENDING_REASONS.slow)
      return (
        `星图 ${describeMs(callMs)}内没回应（多半在建图），连线已排队，读记忆时会自动补；` +
        `也可以稍后重试 memory_link(action="link", a="${ra}", b="${rb}")。`
      )
    }
    const r = raw
    if (r.entry) {
      if (isLinkedText(r.text)) dropPending(ra, rb)
      return r.text
    }
    const why = r.text.replace(/^星图连线未完成：/, '')
    // 自己连自己：星图明确拒绝，排队也没用，别制造一条永远连不上的欠账
    if (isSelfPairText(why)) return why.slice(0, 200)
    // 其余都要排队（0.2.30 起含「找不到这两条记忆」）：那句话可能是「节点还没建进图」，
    // 不是「记忆不存在」——把它当永久失败，用户这次连线就白写了。
    const notBuilt = saysMissingNodes(why)
    const retry = `也可以稍后重试 memory_link(action="link", a="${ra}", b="${rb}")。`
    queuePending(ra, rb, typeof args.note === 'string' ? args.note : '', notBuilt ? PENDING_REASONS.notBuilt : PENDING_REASONS.failed)
    // 环境问题（星图没装配/没起）不转述内部错误：成功路径上出现「这项能力还没就绪」会让模型以为工具面坏了
    if (isNotReady(why)) {
      return `星图这次没接上，连线已排队，读记忆时会自动补；${retry}`
    }
    if (notBuilt) {
      return `星图还没建到这两条记忆（约 12s 一轮巡检），连线已排队，读记忆时会自动补；${retry}`
    }
    return `连线暂时没落图（${why.slice(0, 120)}），已排队，之后读记忆时自动补连；${retry}`
  }
  const verb = { unlink: '断开连线', mute: '屏蔽自动关联', unmute: '撤销屏蔽', path: '解释证据链' }[action] || action
  const callMs2 = flow.linkCallMs ?? LINK_CALL_MS
  const raw2 = await withBudget(
    flow.tryCall(
      action === 'path' ? 'nebula_path' : 'nebula_link',
      payload,
      exec,
      action === 'path' ? '星图路径' : '星图连线',
    ),
    callMs2,
  )
  if (isTimedOut(raw2)) {
    return (
      `星图 ${describeMs(callMs2)}内没回应（多半在建图），${verb}这次没做成——` +
      '等它建完再试一次就行，记忆本身没受影响。'
    )
  }
  const r2 = raw2
  if (r2.entry) {
    // path 是唯一一个「星图的原话本身就是答案」的动作，但它的四句话里有两句
    // 字面上像「没关系」、实际是「还没算」（0.2.37）。这一步只做翻译，不改星图的结论：
    // 真没关系照原样转述（那是诚实），没算出来就说清「这不是答案」。
    // [0.6.54] 错边闭环的最后一环：模型真把这一跳断掉了，错边账要当场销掉。
    // 不销的话这条边会在账里留到过期（NEIGHBOR_SUSPECT_DECAY 轮），面板也会一直报「待处理」——
    // 用户看到的就成了「AI 修了、账上没修」。
    if (action === 'mute') noteSuspectCleared(exec, ra, rb, flow.meowDir)
    if (action !== 'path') return r2.text
    const kind = pathAnswerKind(r2.text)
    if (kind === 'missing') {
      return (
        '星图还没建到这两条记忆（约 12s 一轮巡检），所以现在看不出它们有没有关系——' +
        '这不是「没关系」的答案，等它建完再问一次就行；记忆本身没受影响。'
      )
    }
    if (kind === 'engineStale') {
      return '星图这次的引擎还没带上路径搜索——要等宿主重启后才有，记忆和连线都没受影响。'
    }
    if (kind === 'emptyGraph') {
      // 图还空着（0.2.45）：这句话本身就是结论——「这次没算」，不是「没关系」，
      // 星图的原文已经写清了，原样转述。
      return r2.text
    }
    return r2.text
  }
  // 这几个动作改的是星图自己，落不了盘也没法先记账；说清楚「记忆没受影响」比报内部错误有用
  return `星图这次没接上，${verb}没做成——这一步改的是星图自己，等它就绪再试一次就行，记忆本身没受影响。`
}
