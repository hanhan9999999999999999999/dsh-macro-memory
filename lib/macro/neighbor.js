// [macro-fusion 0.2.145] 每轮星图邻域注入。
//
// 为什么要有这一层：0.2.18 起「每轮自动注入」被整段删掉，改成全靠模型自己调 memory_search。
// 省了 token，也把记忆系统降级成「模型想起来才查」——主人 2026-11-21 的话：「邻域注入我认为
// 还是有必要的」。旋钮可以省，功能不能省：这一层把「这一轮的话在星图里连着谁」自动带进来。
//
// 三条硬约束（每条都对应一次踩坑或一条既定原则）：
//   1. **变化的内容不许进 system prompt 前缀**（0.2.18 的教训 / prompt 缓存）。
//      所以走 `agent/pre-step` 把一段**追加到最后一条用户消息后面**，前缀一个字节都不动。
//   2. **每轮都要跑的路径必须便宜**：只查星图、不查全库、不调模型；有上限（条数 + 字符），
//      没有邻居就一个字都不注入。宁可这一轮空着，也不许为了「显得有记忆」硬凑。
//   3. **注入的东西必须自己说明来路**：模型会把注入当成用户说的话。标题里写明「自动带来的、
//      不是用户说的」，并给出读全文的办法，否则它会把摘要当成原文引用。
import { graphNodesOf, uidOf } from './fusion.js'
import { shortIdsOf, shortenId } from './shortid.js'
import { neighborSeenPath, neighborSuspectPath, pruneNeighborSeen, NEIGHBOR_SEEN_MAX_IDS } from './store.js'
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import * as Meow from '../../vendor/meow-memory/lib/index.js'

/** 一次最多带几条邻居。 */
export const NEIGHBOR_DEFAULT_MAX = 4
/** 整块最多多少字符（含标题与收尾）。 */
export const NEIGHBOR_DEFAULT_CHARS = 420
/** 用户这一轮的话短于这么多字符就不猜（「好」「继续」「嗯」不构成检索意图）。 */
export const NEIGHBOR_MIN_QUERY = 6
/** 一个会话最多记多少条「已经带过」，防止长会话把集合撑大。 */
export const NEIGHBOR_SEEN_MAX = 200
/** [0.6.43] 扫历史注入消息反推「这个会话已经带过谁」时，最多回看多少条消息。 */
export const NEIGHBOR_SCAN_MAX = 400
/**
 * [0.6.43] 与问句**一个词面都不沾**的邻居，一轮最多留几条。
 *
 * 病根：星图沿 1 跳扩散时，`direct ≤ 0.15` 的节点是「靠邻居连上来的」，问句里的词在它的
 * label/preview 里一个都不出现。0.6.42 在真图（3,539 节点 / 16 个真问句）上量过：过 0.35 闸的
 * 44 条里这类占 7 条（15.9%）。它们不是「跨词面发现」，绝大多数是「沾了同一个泛词的邻居」，
 * 每轮塞进上下文就是纯噪声——模型会拿它当本轮相关事实去推理。
 *
 * 但一条都不留也不对：星图的用处正是「问句里没有、但确实相关」的那一跳（跨两层桥就长这样）。
 * 所以留 1 条（宁少不多），其余记进 `offtopic` 计数，让面板/探针看得见「这轮砍了几条」。
 */
export const NEIGHBOR_OFFTOPIC_KEEP = 1
/**
 * [0.6.43] 词面闸只对「强度也不够高」的邻居生效，门槛就是这条。
 *
 * 为什么加这条：词面零重合 ≠ 无关。中文换一个说法、跨语言、摘要被截断，都会让二元组完全不沾，
 * 而图上 0.8 的邻居仍然可能是这一轮最该看的那条。所以强度到 0.5 以上就免检，照带；
 * 只有「词面不沾 + 强度也一般」的那批才受 NEIGHBOR_OFFTOPIC_KEEP 配额管。
 */
export const NEIGHBOR_OFFTOPIC_SCORE = 0.5
/**
 * 强度低于这个数的邻居不注入（0.6.38）。
 * 为什么要有：星图会沿 1 跳把「沾一个词」的节点也算进来，强度 0.2 的那种基本是噪声——
 * 每轮带 4 条噪声进上下文，比不带更糟：模型会拿它当本轮相关事实去推理。
 * 判定用「有 score 才比」：老回执/无强度字段的节点照旧带，不因为在改进程里丢功能。
 */
export const NEIGHBOR_MIN_SCORE = 0.35
/**
 * 尾部给「觉得无关就断掉」的指导句预留的字符数。
 * 这条指导是 0.6.38 的重点：注入的邻居如果是错的，模型以前只能将错就错；
 * 现在要能在同一轮里用 nebula_link(action="path") 看路径、用 action="mute" 断掉那一跳。
 * 但它不能挤掉真正的条目——所以先扣预留，再排版。
 *
 * [0.6.44] 从 150 提到 170：尾注从「两步（先 path 再 mute）」改成「一步（直接 mute，带现成 id）」，
 * 多出来的十几个字换的是模型真的会动手——0.6.38 那版要它自己拼两个 id，实际很少被调用。
 */
// [0.6.61] 尾部预留跟着尾注一起瘦：0.6.44 的尾注 160 字，现在常态 120 字 / 单条短形态 91 字，
// 预留 170 等于白留 50 字——那 50 字本该拿来装邻居条目。压到 130：最长那条（带现成 id 的
// flagged 尾注）仍放得下，装不下时 `picked` 本来就退回 baseTail，不会把整块挤成只有尾注。
export const NEIGHBOR_TAIL_RESERVE = 130
/**
 * [0.6.44] 「这轮不沾词」的行尾标记。
 * 打上标记的那条来自词面闸的配额（`NEIGHBOR_OFFTOPIC_KEEP`），是最可能无关的一条；
 * 标出来 + 尾注给现成的 mute 命令，模型才可能在同轮里顺手把错边断掉，而不是将错就错。
 */
export const NEIGHBOR_UNRELATED_MARK = ' · 未沾词'
/**
 * [0.6.54] 同一跳错边被标到第几轮就**暂时不再带**（0 = 关，退回 0.6.53 的「标了照带」）。
 *
 * 病根：0.6.44 给了模型现成的 `nebula_link(action="mute")` 命令，但大多数轮次里模型不会动手
 * （这很正常——它正忙着回答用户，顺手修图是次要任务）。于是同一跳错边在没有被断掉之前，
 * 每轮都重新被标一次「未沾词」、再带 30~60 字进上下文，用户付的是真金白银的 token。
 *
 * 处方不是「标一次就断」——那会把只是换了个说法的正确邻接一起掐死（0.6.43 的教训：
 * 词面零重合 ≠ 无关）。改成「连标 N 轮 → 先停带、账留着、命令照给」：噪声立刻止血，
 * 图一个字节都没改，模型什么时候想修还是那一条命令。N=3 是「同一个话题来回三轮」的长度，
 * 也是 0.6.49 给命中注入定的窗口（同一个量级，用户不必记两套数字）。
 */
export const NEIGHBOR_SUSPECT_TURNS = 3
/** [0.6.54] 错边账最多记多少跳（超过就丢最久没再被标的那条），防长会话把文件撑大。 */
export const NEIGHBOR_SUSPECT_MAX = 120
/**
 * [0.6.54] 暂时不带的那一跳，隔多少轮不再被标就自动放回。
 *
 * 没有这条，一次误标就是永久降级：话题过去之后再问到它，它还是被压着。
 * 与 `NEIGHBOR_SUSPECT_TURNS` 同值——「连标三轮停带」和「三轮没再标放回」是同一个尺度。
 */
export const NEIGHBOR_SUSPECT_DECAY = 3
/**
 * [0.6.55] 一轮里「长期记忆」最多注入多少字的默认值（0 = 不限，逐位等同 0.6.54）。
 *
 * 为什么要有这条：`injectMaxChars` 只管命中注入那一段，邻域块另有 `neighborChars`，
 * 会话累计另有 `injectSessionBudget`——三个上限各管一段，用户想「每轮最多 600 字」时
 * 没有任何一个数能直接对上。主人 2026-11-25 的原话是「每次长期记忆注入的时候要有的限制」，
 * 所以这一层做的是**跨层的一轮总账**：命中注入先花（它自己的上限照旧管它），邻域只能花
 * 剩下的。优先级写死不做推断——pre-step 里邻域包在 next() 之后，命中注入永远先落进 messages。
 */
export const NEIGHBOR_TURN_MAX_CHARS = 0
/**
 * [0.6.55] 一轮总上限的余额少于这么多字，就整块邻域都不带。
 *
 * 为什么不是「有多少带多少」：邻域块的固定开销是标题（约 40 字）+ 尾注（mute 指引约 100 字），
 * 余下不够 140 字时，硬塞的结果是「一条邻居 + 半句尾注」——模型看到一条没来路的条目，
 * 却拿不到「怎么断掉」的办法，比这轮空着更糟。
 */
export const NEIGHBOR_TURN_MIN_BLOCK = 140
/**
 * [0.6.62] 「边缘单条」的强度线：一块里只活下来一条邻居、且它的强度低于这个值，就叫边缘单条。
 *
 * 为什么单挑这一档：`bench37` 量了真库 17 条操作型话术——**11 条**的邻域块只带 1 条，
 * 强度几乎全落在 0.36–0.54（0.38 / 0.36 / 0.39 / 0.38 / 0.37 / 0.44 / 0.47 …），且 `weak=7`
 * （recall 给 8 条，7 条被强度闸或词面闸刷掉）。这正是主人说的「每轮几乎都要注入」的残余：
 * 一块 193 字，只换来一句「沾了一个二元组」的横向线索。强度上到 0.68 的那种（`suspect 账几天清一次`）
 * 是真线索，不能一起降频——所以线画在 0.55，不是「单条就降」。
 */
export const NEIGHBOR_SOLO_EDGE_SCORE = 0.55

/**
 * [0.6.50] 邻域注入的账本行：往 meow 的 `dream-debug.log` 追加一行（与引擎同一个文件、同一种格式）。
 *
 * 为什么要补这一笔：0.6.46 给命中注入做了面板（`memory_admin(action="inject")`），可邻域这一层
 * 从头到尾**一行账都不写**——用户在面板上只能看到「命中注入了多少字」，看不到「星图邻域每轮带了几条、
 * 砍了几条不沾词的、被跨层去重刷掉几条」。同一份上下文里花掉的字，一半来自邻域，账上却是 0。
 *
 * 三条规矩（与引擎的 appendDreamLog 一致）：
 *  1. **写不进去不许打断注入**：账本是解释用的，不是功能的一部分，失败静默；
 *  2. **没有 workspace 就不写**：探针 / 单测没有真会话时不该在磁盘上留账；
 *  3. **行格式与引擎同构**：`[ISO] <kind> pid= … k=v`，这样面板一个解析器就能读两种行。
 */
export function appendNeighborLog(workspace, dir, kind, rest) {
  const ws = String(workspace ?? '')
  if (ws === '') return
  const file = join(ws, String(dir || '.dsh-meow'), 'dream-debug.log')
  const line = `[${new Date().toISOString()}] ${kind} pid=${process.pid}${rest === '' ? '' : ` ${rest}`}`
  try {
    mkdirSync(dirname(file), { recursive: true })
    appendFileSync(file, `${line}\n`, 'utf8')
  } catch {
    // 只影响「面板看不看得见」，不影响这一轮注不注入。
  }
}

/**
 * [0.6.44] 从星图回执的 `why` 里抠「上游来源 id」。
 *
 * recall 的扩散档写的是「经由「<来源标签>」(<来源短 id 8 位>)的<type>关联扩散而来」；
 * 括号里那 8 位就是错的可能是哪一跳的起点，也是 `nebula_link(action="mute", a, b)` 的 `a`。
 * 直接命中档没有上游边（why 里没有括号 id），返回空串——那种条目不谈断边。
 * @param {string} why
 * @returns {string} 小写 8–12 位 id；没有就空串。
 */
export function neighborSourceIdOf(why) {
  const m = /[（(]([0-9a-z]{8,12})[)）]/i.exec(String(why ?? ''))
  return m === null ? '' : m[1].toLowerCase()
}
/**
 * [0.6.54] 读这个工作区的错边账。
 *
 * 形状：`{ round, edges: { "a|b": { n, first, last } } }`，`n` 是「被标未沾词」的累计轮数，
 * `last` 是最后一次被标的轮次号（工作区自己的轮次，不是全局）。读不动 / 坏 JSON / 没账
 * 一律当空账——这条路径每轮都跑，绝不能因为账坏了挡住注入。
 * @param {string} workspace
 * @returns {{round: number, edges: Record<string, {n: number, first: number, last: number}>}}
 */
export function readSuspectLedger(workspace) {
  const out = { round: 0, edges: {} }
  const ws = String(workspace ?? '')
  if (ws === '') return out
  try {
    const parsed = JSON.parse(readFileSync(neighborSuspectPath(ws), 'utf8'))
    const round = Number.isFinite(parsed?.round) ? Math.max(0, Math.floor(parsed.round)) : 0
    const edges = {}
    const src = parsed?.edges
    if (src !== null && typeof src === 'object') {
      for (const [key, v] of Object.entries(src)) {
        const n = Number.isFinite(v?.n) ? Math.max(0, Math.floor(v.n)) : 0
        const last = Number.isFinite(v?.last) ? Math.max(0, Math.floor(v.last)) : 0
        const first = Number.isFinite(v?.first) ? Math.max(0, Math.floor(v.first)) : last
        if (n > 0 && key.includes('|')) edges[key] = { n, first, last }
      }
    }
    return { round, edges }
  } catch {
    return out
  }
}

/** 写账：失败只影响「下一轮还记不记得」，不影响这一轮注不注入，所以静默。 */
function writeSuspectLedger(workspace, ledger) {
  const ws = String(workspace ?? '')
  if (ws === '') return
  try {
    const file = neighborSuspectPath(ws)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify({ v: 1, at: new Date().toISOString(), round: ledger.round, edges: ledger.edges }), 'utf8')
  } catch {
    // 同上：账是解释用的，不是功能的一部分。
  }
}

/**
 * [0.6.54] 销账：模型真把这一跳 mute 掉了，错边账里那条就该消失。
 *
 * 匹配用 8 位前缀双向 `startsWith`：账里存的是星图回执给的短 id，而 `nebula_link` 拿到的是
 * 解析后的完整 id；两端口径不同，只有前缀能对上。返回清掉几条，调用方据此决定要不要记账。
 * @param {string} workspace
 * @param {string} a 上游来源 id（任意长度，≥8 位才谈得上匹配）
 * @param {string} b 邻居 id
 * @returns {number} 清掉几条
 */
export function clearSuspectEdge(workspace, a, b) {
  const ws = String(workspace ?? '')
  if (ws === '') return 0
  const la = String(a ?? '').toLowerCase()
  const lb = String(b ?? '').toLowerCase()
  if (la.length < 8 || lb.length < 8) return 0
  const ledger = readSuspectLedger(ws)
  let cleared = 0
  for (const key of Object.keys(ledger.edges)) {
    const [ka, kb] = key.split('|')
    const hit = (ka.startsWith(la.slice(0, 8)) || la.startsWith(ka.slice(0, 8))) && (kb.startsWith(lb.slice(0, 8)) || lb.startsWith(kb.slice(0, 8)))
    if (hit) {
      delete ledger.edges[key]
      cleared += 1
    }
  }
  if (cleared > 0) writeSuspectLedger(ws, ledger)
  return cleared
}

/** 星图那一侧的工具名（走 bridge，不直接碰 vendor）。 */
export const NEIGHBOR_TOOL = 'nebula_recall'
/** 注入消息的来源标记：宿主按它折叠成一行「上下文」，也让它与用户消息区分开。 */
export const NEIGHBOR_SOURCE_KIND = 'macro-memory:neighbor'

/**
 * 取这一轮「用户自己说的话」：最后一条 `source.kind === 'user'` 的文本块。
 * 注入消息、工具结果、别的插件的通知都不算——否则会拿自己上一轮的注入去检索。
 * @param {readonly {source?: {kind?: string}, content?: readonly {type: string, text?: string}[]}[]} messages
 * @returns {string} 去掉首尾空白的文本；没有就空串。
 */
export function neighborQueryOf(messages) {
  const list = Array.isArray(messages) ? messages : []
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const m = list[i]
    if (m === null || typeof m !== 'object') continue
    if (m.source?.kind !== 'user') continue
    const blocks = Array.isArray(m.content) ? m.content : []
    const text = blocks
      .filter((b) => b !== null && typeof b === 'object' && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join(' ')
      .trim()
    return text
  }
  return ''
}

/** 标签里不许出现换行：一行一条，读者才能一眼数清带了几条。 */
function oneLine(text, max = 60) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/**
 * [0.6.43] 词面指纹：汉字取二元组、拉丁取「≥2 字符的词」。
 *
 * 为什么不用单字：中文里「的 / 是 / 了 / 一」几乎出现在每条记忆里，按单字算重叠等于恒真。
 * 为什么不用分词器：这一层每轮都跑，而且只回答一个是非问题（这条和问句沾不沾词），
 * 二元组是这一类判定里最便宜且够用的做法；真需要质量的分词在上游检索层已经做过了。
 *
 * @param {string} text
 * @returns {Set<string>}
 */
export function neighborTokens(text) {
  const out = new Set()
  const s = String(text ?? '').toLowerCase()
  for (const run of s.match(/[\u3400-\u9fff]+/g) ?? []) {
    const cps = [...run]
    if (cps.length === 1) out.add(run)
    else for (let i = 0; i + 1 < cps.length; i += 1) out.add(cps[i] + cps[i + 1])
  }
  for (const word of s.match(/[a-z0-9][a-z0-9_.-]+/g) ?? []) out.add(word)
  return out
}

/** 注入块里的 id 标记：`[0mwq3aa9]` 或 `[0mwm83y43-429d…]`（8–9 位 + 可选长尾）。 */
const ID_TAG = /\[([0-9a-z]{8,9}(?:-[0-9a-f]{16,32})?)\]/gi
/** meow 侧注入消息的 `source.kind`：现行值 + 两个历史值（跨版本续读取历史时要认）。 */
const MEOW_KINDS = new Set(['plugin:macro-memory', 'macro-memory', 'meow-memory'])

/** [0.6.43] 这条消息是不是 meow 的记忆注入（含最老的 `{kind:'plugin', plugin:'meow-memory'}` 写法）。 */
function isMemorySource(source) {
  if (source === null || typeof source !== 'object') return false
  const kind = String(source.kind ?? '')
  if (kind === NEIGHBOR_SOURCE_KIND || MEOW_KINDS.has(kind)) return true
  return kind === 'plugin' && String(source.plugin ?? '') === 'meow-memory'
}

/**
 * [0.6.43] 从会话历史里反推「本会话已经注入过哪些条」——跨插件的去重依据。
 *
 * 两条来源都认：
 *   ① meow 的命中注入（`source.kind === 'plugin:macro-memory'`，条目头里带完整 id）；
 *   ② 我们自己的邻域注入（`source.kind === 'macro-memory:neighbor'`，条目里带前 8 位）。
 *
 * 为什么读历史而不读 meow 的账本文件：那是 `vendor/meow-memory` 的私有格式（`.dsh-meow/sessions-*`），
 * 跨插件 import 它的内部函数等于把两边的版本绑死；而「历史里出现过」本身就是最直接的事实，
 * 而且它顺带把「宿主重启后续会话」这个洞一起补了——重启后历史还在，账本却已经清零。
 *
 * @param {readonly any[]} messages
 * @returns {Set<string>} 小写 id（可能是长形式，比对时按前缀认）
 */
export function injectedIdsOf(messages) {
  const out = new Set()
  const list = Array.isArray(messages) ? messages : []
  const start = Math.max(0, list.length - NEIGHBOR_SCAN_MAX)
  for (let i = start; i < list.length; i += 1) {
    const m = list[i]
    if (m === null || typeof m !== 'object') continue
    if (!isMemorySource(m.source)) continue
    const blocks = Array.isArray(m.content) ? m.content : []
    const text = blocks
      .filter((b) => b !== null && typeof b === 'object' && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('\n')
    for (const hit of text.matchAll(ID_TAG)) out.add(hit[1].toLowerCase())
    if (out.size >= NEIGHBOR_SEEN_MAX) break
  }
  return out
}

/**
 * [0.6.55] 这一轮**已经**注入了多少字（跨插件，只算本轮）。
 *
 * 口径：从最后一条用户消息往后数，凡是记忆注入消息（meow 的命中/重放、本层邻域）的
 * 文本长度都加起来。为什么从用户消息往后数、而不是数整段历史：一轮总上限问的是
 * 「这一轮花多少」，把上一轮的注入算进来，上限在第二轮就会永远顶满。
 *
 * 读的是**上下文里的事实**，不是账本文件：账本是私有格式、跨版本会变，而「已经进了
 * 上下文的那几块」本身就是最直接的证据（0.6.43 跨层去重用的也是这条路）。
 *
 * @param {readonly any[]} messages
 * @returns {number} 字符数；这一轮还没有注入就是 0。
 */
export function injectedCharsOf(messages) {
  const list = Array.isArray(messages) ? messages : []
  let start = 0
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const m = list[i]
    if (m !== null && typeof m === 'object' && m.source?.kind === 'user') {
      start = i + 1
      break
    }
  }
  let total = 0
  for (let i = start; i < list.length; i += 1) {
    const m = list[i]
    if (m === null || typeof m !== 'object') continue
    if (!isMemorySource(m.source)) continue
    const blocks = Array.isArray(m.content) ? m.content : []
    for (const b of blocks) {
      if (b !== null && typeof b === 'object' && b.type === 'text' && typeof b.text === 'string') total += b.text.length
    }
  }
  return total
}

/** 两个 id 是不是同一条：相等，或 8 位前缀一致（星图给 8 位、meow 命中给长形式）。 */
function sameId(a, b) {
  if (a === b) return true
  if (a.length < 8 || b.length < 8) return false
  return a.slice(0, 8) === b.slice(0, 8)
}

/**
 * 把星图回执渲染成注入块。纯函数：探针直接喂文本就能验文案与上限。
 *
 * 形如：
 *   【星图邻域·不是用户原话】这轮连着：
 *   - [fact] [0mwq3aa9] 0.2.144 的交付态…（强度 0.82）
 *   memory_read("0mwq3aa9") 看全文；明显无关就 nebula_link(action="mute", …)，不用问用户。
 *
 * @param {string} recallText 星图工具（nebula_recall）的回执原文。
 * @param {{max?: number, chars?: number, skip?: Iterable<string>, minScore?: number, query?: string}} [opts]
 *   `skip` 是这个会话已经带过的 id（裸 id、长 id、带工作区前缀都认；按 8 位前缀比）。
 *   `query` 给了就启用词面闸（0.6.43）：与问句一个二元组都不沾的条目一轮最多留
 *   `NEIGHBOR_OFFTOPIC_KEEP` 条。不给就完全按旧口径（探针与老调用方不受影响）。
 * @param {(id: string) => string} [opts.shorten] 0.6.64：id 的显示形式（缺省取其前 8 位）。
 *   上层传进来的就是「最短唯一前缀」——真库 1,121 条里 8 位前缀撞 13 组，撞车的短 id 指向两条，
 *   模型拿它去 read / update / mute 会撞歧义拒绝，而读起来像「那条记忆不见了」。
 * @returns {{text: string, ids: string[], weak: number, offtopic: number, skipped: number, flagged: number} | null}
 *   `offtopic` 是被词面闸砍掉的条数，`skipped` 是被跨层去重挡掉的条数，`flagged` 是「未沾词但靠配额留下」的条数
 *   （这些行带 `NEIGHBOR_UNRELATED_MARK`，也就是模型最该复核的那几条）。一条都没有时返回 null。
 */
export function neighborBlockOf(recallText, opts = {}) {
  const max = Number.isFinite(opts.max) ? Math.max(0, Math.trunc(opts.max)) : NEIGHBOR_DEFAULT_MAX
  const chars = Number.isFinite(opts.chars) ? Math.max(80, Math.trunc(opts.chars)) : NEIGHBOR_DEFAULT_CHARS
  const minScore = Number.isFinite(opts.minScore) ? opts.minScore : NEIGHBOR_MIN_SCORE
  if (max === 0) return null
  // [0.6.54] 连标 N 轮、暂时不带的那些跳（按邻居短 id 认）。空集合 = 这一层关着。
  const suspectTurns = Number.isFinite(opts.suspectTurns) ? Math.max(0, Math.floor(opts.suspectTurns)) : NEIGHBOR_SUSPECT_TURNS
  const suspect =
    opts.suspect instanceof Set
      ? opts.suspect
      : new Set(Array.isArray(opts.suspect) ? opts.suspect.map((v) => String(v).toLowerCase()) : [])
  const skip = []
  for (const one of opts.skip ?? []) {
    const s = String(one).toLowerCase()
    if (s.length >= 8) skip.push(s)
  }
  const qTokens = typeof opts.query === 'string' && opts.query.trim() !== '' ? neighborTokens(opts.query) : null
  const shorten = typeof opts.shorten === 'function' ? opts.shorten : (id) => String(id).slice(0, 8)
  const nodes = graphNodesOf(recallText)
  if (nodes.length === 0) return null
  // [0.6.61] 头句从 40 字压到 19 字：实测默认档一块 283–369 字里，头 + 尾占 200 字（54–71%），
  // 条目只有 1–2 条（81–167 字）——框架文字比内容还长。归属护栏（不是用户原话）留着，
  // 它防的是模型把邻居当成用户刚说的话；「自动带来的」「下面几条」这些交代是给第一次看的人听的，
  // 每轮重复只是噪声。
  const head = '【星图邻域·不是用户原话】这轮连着：'
  const lines = [head]
  const ids = []
  // [0.6.62] 每条带出去的邻居的强度（与 ids 同序）。上层要知道「这一块是不是只有一条边缘线索」，
  // 光看条数不够——0.68 的单条值得每轮带，0.38 的不值得。
  const scores = []
  // 条目区按「总上限 - 尾部预留」排：尾部那句「觉得无关就断掉」是 0.6.38 的重点，
  // 0.6.44 又把它改成了带现成 id 的一步式命令（更长、更有用），
  // 不能因为条目排得满就被挤掉。上限本身小到预留比它还大时（探针的 120 字符档），
  // 先保证有条目——尾部装不下就不加（下面按剩余空间判断），绝不为了指导句把条目清零。
  const bodyCap = chars <= NEIGHBOR_TAIL_RESERVE + 100 ? chars : chars - NEIGHBOR_TAIL_RESERVE
  let weak = 0
  let offtopic = 0
  let offtopicKept = 0
  let skippedIds = 0
  let flagged = 0
  /** [0.6.54] 被「错边账」压住、这一轮没带的跳。 */
  let suspectSkipped = 0
  /** [0.6.54] 压住的那几跳（含 8 位短 id）：尾注据此给出**现成**的 mute 命令。 */
  const suppressed = []
  /** 被标记「未沾词」且 why 里能抠出来源 id 的边：尾注据此给出**现成**的 mute 命令。 */
  const flaggedEdges = []
  for (const node of nodes) {
    if (ids.length >= max) break
    const bare = uidOf(node.id).toLowerCase()
    if (skip.some((one) => sameId(one, bare))) {
      skippedIds += 1
      continue
    }
    // [0.6.54] 错边闸：这一跳连标了 N 轮「未沾词」还没被修，先不带（图不动、账不动）。
    // 顺序在跨层去重之后、强度闸之前：已经带过的照旧算去重，不看它是不是错边。
    if (suspect.has(bare)) {
      suspectSkipped += 1
      const src = neighborSourceIdOf(node.why)
      suppressed.push({ a: src.length >= 8 ? shorten(src) : '', b: shorten(bare) })
      continue
    }
    if (Number.isFinite(node.score) && node.score < minScore) {
      weak += 1
      continue
    }
    // 词面闸（0.6.43）：一个二元组都不沾、且强度也没到 NEIGHBOR_OFFTOPIC_SCORE 的邻居，
    // 一轮最多留 NEIGHBOR_OFFTOPIC_KEEP 条。顺序在强度闸之后：先刷掉弱邻居，
    // 再谈「这轮留几条不沾词的」——否则配额会被弱邻居吃掉。
    // 强度够高的不沾词条目照带：图上这么近就是有实质关联，词面不重合只是换了个说法。
    let unrelated = false
    if (qTokens !== null && !(Number.isFinite(node.score) && node.score >= NEIGHBOR_OFFTOPIC_SCORE)) {
      const bag = neighborTokens(`${node.label} ${node.why} ${node.preview}`)
      let overlap = 0
      for (const t of qTokens) {
        if (bag.has(t)) overlap += 1
        if (overlap > 0) break
      }
      if (overlap === 0) {
        if (offtopicKept >= NEIGHBOR_OFFTOPIC_KEEP) {
          offtopic += 1
          continue
        }
        offtopicKept += 1
        unrelated = true
      }
    }
    const label = oneLine(node.label, 48)
    const why = oneLine(node.why, 48)
    const score = Number.isFinite(node.score) && node.score > 0 ? `（强度 ${node.score.toFixed(2)}）` : ''
    // [0.6.44] 靠配额留下来的那条打标记：它最可能是错边，模型得先知道「这条我自己也没底」。
    const mark = unrelated ? NEIGHBOR_UNRELATED_MARK : ''
    const line = `- [${node.level}] [${shorten(bare)}] ${label}${score}${why === '' ? '' : ` · ${why}`}${mark}`
    // [0.6.47] 装不下就 `continue`，不是 `break`：旧写法拿一条长行（长标签 + 长 why）
    // 撞上 bodyCap 就整体收工，后面更短的条目一条都不试——`neighborChars` 调小到 120 时
    // 甚至第一条就放不下，整块邻域注入直接消失（静默、不打日志、下一轮一样），
    // 而用户只会以为「星图没东西」。跳过这一条继续试，能放几条放几条。
    if (lines.join('\n').length + line.length + 1 > bodyCap) continue
    lines.push(line)
    ids.push(bare)
    scores.push(Number.isFinite(node.score) ? node.score : 0)
    if (unrelated) {
      flagged += 1
      const src = neighborSourceIdOf(node.why)
      if (src.length >= 8) flaggedEdges.push({ a: shorten(src), b: shorten(bare) })
    }
  }
  // 全是弱邻居就一个字都不注入：宁可这一轮空着，也不为了让「显得有记忆」硬凑。
  // [0.6.54] 但如果这一轮**唯一**发生的事是「错边账压住了几条」，就不能当成「图上没东西」——
  // 上层的日志要能分开这两种空，否则用户会以为星图断了。
  if (ids.length === 0) {
    return suspectSkipped === 0
      ? null
      : { text: '', ids: [], scores: [], weak, offtopic, skipped: skippedIds, flagged, edges: flaggedEdges, suspect: suspectSkipped }
  }
  const first = shorten(ids[0])
  // [0.6.44] 尾注从「建议」改成「可执行」：
  //   ① 标了「未沾词」且 why 里抠得出来源 id 的，把 mute 要的两个 id 直接拼好给模型——
  //      0.6.38 那版要它自己先 path 再拼两个 id，实际上几乎不会被调用，错边就一直留着；
  //   ② 同时把判断标准说清（断的是**错边**，不是「这轮用不上」），否则模型会把无关的一律 mute，
  //      把图修成一条没有横向关联的直线——那是比噪声更坏的结果。
  // [0.6.61] 尾注三档：把「怎么拼 mute 的两个 id」这段教学从 160 字压到 70–125 字。
  //   ① 能给出成对 id 的（flagged）——照旧一步式命令，只删掉重复的解释；
  //   ② 常态多条目——保留 a/b 各填什么（这是 0.6.44 的成果，删了模型就退回先 path）；
  //   ③ 只有一条邻居且没有可疑跳——短形态，一块省下 80 字左右，而内容一字不少。
  // 「断的是错边、不是记忆」这句留着：0.6.44 的教训是删了它模型会把图上横向关联一律 mute，
  // 修成一条直线比噪声更坏。
  const genericTail = `memory_read("${first}") 看全文。明显无关就 nebula_link(action="mute", a=why 里那个来源 id, b=行首那 8 位) 断这一跳——断的是错边，不是记忆；这轮用不上就别动，不用问用户。`
  const flaggedTail =
    flaggedEdges.length > 0
      ? `memory_read("${first}") 看全文。标了「未沾词」的那条若确实无关：nebula_link(action="mute", a="${flaggedEdges[0].a}", b="${flaggedEdges[0].b}") 直接断这一跳（断的是错边，不是记忆），不用问用户；这轮只是用不上就别动。`
      : ''
  const shortTail = `memory_read("${first}") 看全文；明显无关就 nebula_link(action="mute", a=why 里来源 id, b=行首 8 位)，不用问用户。`
  const baseTail =
    flaggedTail !== ''
      ? flaggedTail
      : ids.length === 1 && suppressed.length === 0
        ? shortTail
        : genericTail
  // [0.6.54] 被压住的那几跳单独交代一句：不交代，模型会以为「这轮图里就这些」，
  // 错边永远没人修；交代了，它想修的那一轮还能拿到现成命令。装不下就退回原尾注——
  // 指导句不能挤掉条目，这是 0.6.44 定下的规矩。
  const sup = suppressed.length
    ? `另有 ${suppressed.length} 跳连续 ${suspectTurns} 轮标了「未沾词」、先不带了${suppressed[0].a === '' ? '' : `：确认无关就 nebula_link(action="mute", a="${suppressed[0].a}", b="${suppressed[0].b}")`}。`
    : ''
  const tail = `${baseTail}${sup}`
  const room = chars - lines.join('\n').length - 1
  const picked = tail.length <= room ? tail : baseTail.length <= room ? baseTail : ''
  if (picked !== '') lines.push(picked)
  return { text: lines.join('\n'), ids, scores, weak, offtopic, skipped: skippedIds, flagged, edges: flaggedEdges, suspect: suspectSkipped }
}

/**
 * 每轮邻域注入器。
 *
 * @param {object} o
 * @param {any} o.ctx 插件上下文（只用 `ctx.on`）。
 * @param {{tryCall: Function}} o.bridge 融合层的桥：`tryCall(name, args, exec, label)`。
 * @param {{neighborInject?: boolean, neighborMax?: number, neighborChars?: number, injectTurnMaxChars?: number}} o.config 融合层配置。
 * @param {(msg: string) => void} [o.logger] debug 日志。
 * @param {() => string} [o.meowDir] [0.6.50] meow 的 projectDir 读口（账本落点用，缺省 .dsh-meow）。
 * @param {() => Promise<{createUserMessage: Function}>} [o.loadLlm] 取宿主的消息工厂（探针可注入假货）。
 */
export function createNeighborInjector({ ctx, bridge, config = {}, logger, meowDir, loadLlm }) {
  const seen = new Map()
  const state = { injected: 0, skipped: 0, calls: 0, failed: 0, deduped: 0, offtopic: 0, flagged: 0, suppressed: 0, capped: 0, edged: 0 }
  const enabled = config.neighborInject !== false
  const max = Number.isFinite(config.neighborMax) ? config.neighborMax : NEIGHBOR_DEFAULT_MAX
  const chars = Number.isFinite(config.neighborChars) ? config.neighborChars : NEIGHBOR_DEFAULT_CHARS
  const minScore = Number.isFinite(config.neighborMinScore) ? config.neighborMinScore : NEIGHBOR_MIN_SCORE
  // [0.6.54] 错边账的窗口：0 = 整层关着（行为逐位等同 0.6.53）。
  const suspectTurns = Number.isFinite(config.neighborSuspectTurns) ? Math.max(0, Math.floor(config.neighborSuspectTurns)) : NEIGHBOR_SUSPECT_TURNS
  // [0.6.55] 一轮总上限（0 = 不限）：命中注入先花，这一层只花剩下的。
  const turnMax = Number.isFinite(config.injectTurnMaxChars) ? Math.max(0, Math.floor(config.injectTurnMaxChars)) : NEIGHBOR_TURN_MAX_CHARS
  let llm = null
  let llmTried = false
  let pruned = false

  const load = async () => {
    if (llm !== null) return llm
    if (llmTried) return null
    llmTried = true
    try {
      const mod = typeof loadLlm === 'function' ? await loadLlm() : await import('@deepseek-ai/dsh-llm')
      if (typeof mod?.createUserMessage === 'function') llm = mod.createUserMessage
    } catch (err) {
      logger?.(`[macro-memory] 邻域注入取不到消息工厂，本轮不注入：${err instanceof Error ? err.message : String(err)}`)
    }
    return llm
  }

  /**
   * 读盘上的账本（一个会话一个 json）。坏文件一律当空账，绝不让它挡住本轮。
   * [0.6.62] 账本除了「带过哪些 id」，还记 `edge`：上一轮带的是不是「边缘单条」块。
   * 它撑着降频那条规矩——边缘单条带一轮、休一轮。老账本没有这个字段时按 0 读，
   * 也就是「下一轮照常带」，不会因为升级而突然静默。
   */
  const readSeenFile = (sid) => {
    const out = { ids: new Set(), edge: 0 }
    try {
      const raw = readFileSync(neighborSeenPath(sid), 'utf8')
      const parsed = JSON.parse(raw)
      const ids = Array.isArray(parsed?.ids) ? parsed.ids : []
      for (const id of ids) {
        const s = String(id ?? '').toLowerCase()
        if (s.length >= 8) out.ids.add(s)
      }
      out.edge = parsed?.edge === 1 ? 1 : 0
    } catch {
      // ENOENT / 坏 JSON / 读不动：都当作「还没记过」。这一类失败只影响省 token，不影响正确性。
    }
    return out
  }

  /** 写盘：失败只记一笔日志（不打断这一轮），并在下一轮重试。 */
  const writeSeenFile = (sid, st) => {
    const file = neighborSeenPath(sid)
    try {
      mkdirSync(dirname(file), { recursive: true })
      // 0.6.44：账本只进不出会长成几百 KB，每次 decide 整份 parse。留最近的 400 条就够
      // （一轮最多 4 条邻域，更早的早被窗口挤出去了）。Set 的迭代顺序就是插入顺序。
      const set = st.ids
      const kept = set.size > NEIGHBOR_SEEN_MAX_IDS ? [...set].slice(set.size - NEIGHBOR_SEEN_MAX_IDS) : [...set]
      writeFileSync(file, JSON.stringify({ sid, at: new Date().toISOString(), ids: kept, edge: st.edge === 1 ? 1 : 0 }), 'utf8')
    } catch (err) {
      logger?.(`[macro-memory] 邻域账本写不进去（下一轮会重试）：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const seenOf = (sid) => {
    let st = seen.get(sid)
    if (st === undefined) {
      // 0.6.43：不再是「新会话就空账」——先把盘上这份读回来，宿主重启/续接会话不会重复注入。
      st = readSeenFile(sid)
      seen.set(sid, st)
    }
    return st
  }

  /**
   * 决策函数：吃 pre-step 的 payload 与已定下的 decision，返回新的 decision。
   * 任何一步不满足就原样返回——注入失败绝不挡住这一轮。
   */
  const decide = async (payload, decision) => {
    if (!enabled) return decision
    // [0.6.50] 账本落点：workspace 与会话头同一个口径（引擎 workspaceOfAgent 读的就是 header.cwd），
    // 目录走 meow 的 projectDir。取不到 workspace 就一个字节都不写。
    const agentOf = payload?.agent
    const wsOf = typeof agentOf?.session?.header?.cwd === 'string' ? agentOf.session.header.cwd : ''
    const dirOf = typeof meowDir === 'function' ? meowDir() : undefined
    const logLine = (kind, rest) => appendNeighborLog(wsOf, dirOf, kind, rest)
    // 0.6.44：进程内第一次决策时顺手清一次账本目录（太老 / 太多）。只删本插件自己的缓存，
    // 失败不抛；清理结果只在 debug 日志里留一行。
    if (!pruned) {
      pruned = true
      const r = pruneNeighborSeen()
      if (r.removedByAge > 0 || r.removedByCount > 0 || r.error !== '') {
        logger?.(`[macro-memory] 邻域账本清理：扫到 ${r.scanned} 个，按天删 ${r.removedByAge}，按数删 ${r.removedByCount}${r.error === '' ? '' : `（错误：${r.error}）`}`)
      }
    }
    if (decision === undefined || decision === null || decision.kind !== 'enter') return decision
    const messages = Array.isArray(decision.messages) ? decision.messages : []
    if (messages.length === 0) {
      logLine('neighbor-skip', 'reason=empty-msg')
      return decision
    }
    const agent = payload?.agent
    if (agent?.session?.header?.origin === 'subagent') {
      logLine('neighbor-skip', 'reason=subagent')
      return decision
    }
    const query = neighborQueryOf(messages)
    if (query.length < NEIGHBOR_MIN_QUERY) {
      logLine('neighbor-skip', 'reason=short')
      return decision
    }
    const sid = String(agent?.session?.id ?? payload?.sessionId ?? 'unknown')
    const seenState = seenOf(sid)
    const already = seenState.ids
    // 0.6.43 跨层去重：这一轮（以及本会话历史里）**别的注入已经带过**的条，邻域不再带第二遍。
    // 命中注入（meow）与本层注入的是同一批记忆，同一条一轮里出现两次是纯浪费。
    const carried = injectedIdsOf(messages)
    // [0.6.55] 一轮总账：这一轮已经注入的（命中 / 重放，可能不止一块）先记账，
    // 邻域只能花剩下的。0 = 不限时逐位走 0.6.54 的老路（不读、不算、不写读数）。
    const carriedChars = turnMax > 0 ? injectedCharsOf(messages) : 0
    let blockChars = chars
    if (turnMax > 0) {
      const left = turnMax - carriedChars
      if (left < NEIGHBOR_TURN_MIN_BLOCK) {
        state.skipped += 1
        state.capped += 1
        logLine('neighbor-skip', `reason=turncap sid=${sid} turnSpent=${carriedChars} turnCap=${turnMax} left=${Math.max(0, left)}`)
        return decision
      }
      blockChars = Math.min(chars, left)
    }
    const skip = new Set(already)
    for (const id of carried) skip.add(id)
    state.calls += 1
    let recallText = ''
    try {
      // 多要 4 条：强度/词面过滤会刷掉一部分，回执只按 limit 裁剪，先多拿几条免得永远凑不满。
      const r = await bridge.tryCall(NEIGHBOR_TOOL, { query: query.slice(0, 300), limit: max + 4, hops: 1 }, undefined, '星图邻域')
      recallText = typeof r?.text === 'string' ? r.text : ''
    } catch (err) {
      state.failed += 1
      logLine('neighbor-skip', `reason=tool sid=${sid}`)
      logger?.(`[macro-memory] 邻域注入这一轮没查成：${err instanceof Error ? err.message : String(err)}`)
      return decision
    }
    // [0.6.54] 错边账：读一次（工作区一份），连标 ≥ suspectTurns 轮、且最近还在被标的跳先压住。
    // 过期的（连续 NEIGHBOR_SUSPECT_DECAY 轮没再被标）当场就不算——一次误标不该永久降级。
    const ledger = suspectTurns > 0 && wsOf !== '' ? readSuspectLedger(wsOf) : { round: 0, edges: {} }
    const withheld = new Set()
    for (const [key, edge] of Object.entries(ledger.edges)) {
      if (edge.n < suspectTurns) continue
      if (ledger.round - edge.last > NEIGHBOR_SUSPECT_DECAY) continue
      withheld.add(String(key.split('|')[1] ?? '').toLowerCase())
    }
    // [0.6.64] 行首 id 给最短唯一前缀：8 位切法在真库上撞 13 组，撞车的 id 指向两条，
    // 模型拿它去 read / update / mute 会撞歧义拒绝。星图回执给的常是短 id，
    // `shortenId` 会先解析回唯一的那条再取前缀；解析不唯一就原样退回，不替它挑一条。
    const shortIndex = wsOf === '' ? null : shortIdsOf(Meow.getDb(wsOf, dirOf))
    const shorten = (id) => shortenId(shortIndex, id)
    const block = neighborBlockOf(recallText, {
      max,
      chars: blockChars,
      skip,
      minScore,
      query,
      suspect: withheld,
      suspectTurns,
      shorten,
    })
    state.offtopic += block === null ? 0 : block.offtopic
    if (block === null) {
      state.skipped += 1
      logLine('neighbor-skip', `reason=empty sid=${sid}`)
      return decision
    }
    // [0.6.54] 只有「被错边账压住的那几条」这一种情况会拿到空正文：这一轮一个字都不注入，
    // 但要把「压住了几条」记下来——否则用户看到的是「星图这轮没东西」，账上却查不出原因。
    if (block.text === '') {
      state.skipped += 1
      state.suppressed += block.suspect ?? 0
      const heldIds = [...withheld].slice(0, 6).join(',')
      logLine(
        'neighbor-skip',
        `reason=suspect sid=${sid} withheld=${block.suspect ?? 0} turns=${suspectTurns} ids=${heldIds}`,
      )
      return decision
    }
    state.deduped += block.skipped
    state.flagged += block.flagged ?? 0
    state.suppressed += block.suspect ?? 0
    // [0.6.62] 边缘单条：一块里只活下来一条、强度又没过 0.55 的，带一轮休一轮。
    // 0.6.43 的账本已经让「同一条邻居」整会话只带一次，所以每轮来的是**新**的边缘线索；
    // 真库上这类块占操作型轮次的 11/17、每块 193 字（bench37），而 0.68 那种单条是真线索，
    // 手感完全不同——所以只对「弱」的那一档降频，条数本身不降。
    // 0 = 关掉这条规矩（逐位退回 0.6.61 的行为）；配置口 neighborSoloEdge。
    const edgeScore = Number.isFinite(config.neighborSoloEdge)
      ? Math.min(1, Math.max(0, config.neighborSoloEdge))
      : NEIGHBOR_SOLO_EDGE_SCORE
    const soloScore = Number.isFinite(block.scores?.[0]) ? block.scores[0] : 0
    const soloEdge = edgeScore > 0 && block.ids.length === 1 && soloScore < edgeScore
    if (soloEdge && seenState.edge === 1) {
      state.skipped += 1
      state.edged += 1
      seenState.edge = 0
      writeSeenFile(sid, seenState)
      logLine('neighbor-skip', `reason=edgeturn sid=${sid} score=${soloScore.toFixed(2)} chars=${block.text.length}`)
      return decision
    }
    // [0.6.54] 两件事：①这一轮真标了的跳 +1；②轮次号 +1、过期跳放回、总量封顶。
    // 顺序不能反——先盖章再判「最近被标」会把这一轮算到下一轮，账永远比实际晚一轮。
    if (suspectTurns > 0 && wsOf !== '') {
      ledger.round += 1
      const round = ledger.round
      for (const e of block.edges ?? []) {
        const key = `${e.a.slice(0, 8)}|${e.b.slice(0, 8)}`
        const old = ledger.edges[key]
        ledger.edges[key] = { n: (old?.n ?? 0) + 1, first: old?.first ?? round, last: round }
      }
      for (const key of Object.keys(ledger.edges)) {
        if (round - ledger.edges[key].last > NEIGHBOR_SUSPECT_DECAY) delete ledger.edges[key]
      }
      const keys = Object.keys(ledger.edges)
      if (keys.length > NEIGHBOR_SUSPECT_MAX) {
        keys.sort((x, y) => ledger.edges[x].last - ledger.edges[y].last)
        for (const k of keys.slice(0, keys.length - NEIGHBOR_SUSPECT_MAX)) delete ledger.edges[k]
      }
      writeSuspectLedger(wsOf, ledger)
      const still = Object.entries(ledger.edges).filter(([, e]) => e.n >= suspectTurns)
      if (still.length > 0) {
        logLine(
          'neighbor-suspect',
          `sid=${sid} withheld=${still.length} turns=${suspectTurns} ids=${still.map(([k]) => k.split('|')[1]).join(',')}`,
        )
      }
    }
    const make = await load()
    if (make === null) {
      state.failed += 1
      logLine('neighbor-skip', `reason=llm sid=${sid}`)
      return decision
    }
    for (const id of block.ids) {
      already.add(id)
      if (already.size > NEIGHBOR_SEEN_MAX) {
        const first = already.values().next()
        if (!first.done) already.delete(first.value)
      }
    }
    // [0.6.62] 记账：这一轮带出去的是不是边缘单条，决定下一轮要不要让路。
    seenState.edge = soloEdge ? 1 : 0
    writeSeenFile(sid, seenState)
    state.injected += 1
    // 成功这一笔记的是「真正进了上下文的那一块」：条数、字数、以及三道闸各自的读数。
    logLine(
      'neighbor-chain',
      `sid=${sid} ids=${block.ids.length} chars=${block.text.length} weak=${block.weak} offtopic=${block.offtopic} flagged=${block.flagged ?? 0} deduped=${block.skipped} max=${max} cap=${chars} minScore=${minScore} turnCap=${turnMax} turnSpent=${carriedChars} solo=${soloEdge ? 1 : 0}`,
    )
    const msg = make({
      content: [{ type: 'text', text: block.text }],
      source: { kind: NEIGHBOR_SOURCE_KIND, form: 'notice', summary: `星图邻域 ${block.ids.length} 条` },
    })
    // 追加在**后面**：前缀不动，缓存不碎；模型看到的顺序是「用户说 → 附带邻域」。
    return { ...decision, messages: [...messages, msg] }
  }

  const dispose = ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    try {
      return await decide(payload, decision)
    } catch (err) {
      state.failed += 1
      logger?.(`[macro-memory] 邻域注入出错（不影响这一轮）：${err instanceof Error ? err.message : String(err)}`)
      return decision
    }
  })

  return {
    decide,
    stats: () => ({ ...state, sessions: seen.size }),
    dispose: typeof dispose === 'function' ? dispose : () => {},
  }
}
