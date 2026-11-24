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

/** 一次最多带几条邻居。 */
export const NEIGHBOR_DEFAULT_MAX = 4
/** 整块最多多少字符（含标题与收尾）。 */
export const NEIGHBOR_DEFAULT_CHARS = 420
/** 用户这一轮的话短于这么多字符就不猜（「好」「继续」「嗯」不构成检索意图）。 */
export const NEIGHBOR_MIN_QUERY = 6
/** 一个会话最多记多少条「已经带过」，防止长会话把集合撑大。 */
export const NEIGHBOR_SEEN_MAX = 200
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
 */
export const NEIGHBOR_TAIL_RESERVE = 150
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
 * 把星图回执渲染成注入块。纯函数：探针直接喂文本就能验文案与上限。
 *
 * 形如：
 *   【星图邻域 · 自动带来的】这一轮的话在星图里连着下面几条（不是用户说的原文）：
 *   - [fact] [0mwq3aa9] 0.2.144 的交付态…（强度 0.82）
 *   要全文用 memory_read(id)。
 *
 * @param {string} recallText 星图工具（nebula_recall）的回执原文。
 * @param {{max?: number, chars?: number, skip?: Iterable<string>}} [opts]
 *   `skip` 是这个会话已经带过的 id（裸 id 或带工作区前缀都认）。
 * @returns {{text: string, ids: string[]} | null} 一条都没有时返回 null。
 */
export function neighborBlockOf(recallText, opts = {}) {
  const max = Number.isFinite(opts.max) ? Math.max(0, Math.trunc(opts.max)) : NEIGHBOR_DEFAULT_MAX
  const chars = Number.isFinite(opts.chars) ? Math.max(80, Math.trunc(opts.chars)) : NEIGHBOR_DEFAULT_CHARS
  const minScore = Number.isFinite(opts.minScore) ? opts.minScore : NEIGHBOR_MIN_SCORE
  if (max === 0) return null
  const skip = new Set()
  for (const one of opts.skip ?? []) skip.add(String(one))
  const nodes = graphNodesOf(recallText)
  if (nodes.length === 0) return null
  const head = '【星图邻域 · 自动带来的】这一轮的话在星图里连着下面几条（不是用户说的原文）：'
  const lines = [head]
  const ids = []
  // 条目区按「总上限 - 尾部预留」排：尾部那句「觉得无关就 mute 掉」是 0.6.38 的重点，
  // 不能因为条目排得满就被挤掉。上限本身小到预留比它还大时（探针的 120 字符档），
  // 先保证有条目——尾部装不下就不加（下面按剩余空间判断），绝不为了指导句把条目清零。
  const bodyCap = chars <= NEIGHBOR_TAIL_RESERVE + 100 ? chars : chars - NEIGHBOR_TAIL_RESERVE
  let weak = 0
  for (const node of nodes) {
    if (ids.length >= max) break
    const bare = uidOf(node.id)
    if (skip.has(bare) || skip.has(node.id)) continue
    if (Number.isFinite(node.score) && node.score < minScore) {
      weak += 1
      continue
    }
    const label = oneLine(node.label, 48)
    const why = oneLine(node.why, 48)
    const score = Number.isFinite(node.score) && node.score > 0 ? `（强度 ${node.score.toFixed(2)}）` : ''
    const line = `- [${node.level}] [${bare.slice(0, 8)}] ${label}${score}${why === '' ? '' : ` · ${why}`}`
    if (lines.join('\n').length + line.length + 1 > bodyCap) break
    lines.push(line)
    ids.push(bare)
  }
  // 全是弱邻居就一个字都不注入：宁可这一轮空着，也不为了让「显得有记忆」硬凑。
  if (ids.length === 0) return null
  const first = ids[0].slice(0, 8)
  const tail = `要全文用 memory_read("${first}")，别把上面的摘要当原文引用。觉得哪条明显无关：nebula_link(action="path", a="<它 why 里的来源 id>", b="${first}") 看路径，错的那一跳用 action="mute" 断掉（mute 后重建也不再连）。`
  if (lines.join('\n').length + tail.length + 1 > chars) return { text: lines.join('\n'), ids, weak }
  lines.push(tail)
  return { text: lines.join('\n'), ids, weak }
}

/**
 * 每轮邻域注入器。
 *
 * @param {object} o
 * @param {any} o.ctx 插件上下文（只用 `ctx.on`）。
 * @param {{tryCall: Function}} o.bridge 融合层的桥：`tryCall(name, args, exec, label)`。
 * @param {{neighborInject?: boolean, neighborMax?: number, neighborChars?: number}} o.config 融合层配置。
 * @param {(msg: string) => void} [o.logger] debug 日志。
 * @param {() => Promise<{createUserMessage: Function}>} [o.loadLlm] 取宿主的消息工厂（探针可注入假货）。
 */
export function createNeighborInjector({ ctx, bridge, config = {}, logger, loadLlm }) {
  const seen = new Map()
  const state = { injected: 0, skipped: 0, calls: 0, failed: 0 }
  const enabled = config.neighborInject !== false
  const max = Number.isFinite(config.neighborMax) ? config.neighborMax : NEIGHBOR_DEFAULT_MAX
  const chars = Number.isFinite(config.neighborChars) ? config.neighborChars : NEIGHBOR_DEFAULT_CHARS
  const minScore = Number.isFinite(config.neighborMinScore) ? config.neighborMinScore : NEIGHBOR_MIN_SCORE
  let llm = null
  let llmTried = false

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

  const seenOf = (sid) => {
    let set = seen.get(sid)
    if (set === undefined) {
      set = new Set()
      seen.set(sid, set)
    }
    return set
  }

  /**
   * 决策函数：吃 pre-step 的 payload 与已定下的 decision，返回新的 decision。
   * 任何一步不满足就原样返回——注入失败绝不挡住这一轮。
   */
  const decide = async (payload, decision) => {
    if (!enabled) return decision
    if (decision === undefined || decision === null || decision.kind !== 'enter') return decision
    const messages = Array.isArray(decision.messages) ? decision.messages : []
    if (messages.length === 0) return decision
    const agent = payload?.agent
    if (agent?.session?.header?.origin === 'subagent') return decision
    const query = neighborQueryOf(messages)
    if (query.length < NEIGHBOR_MIN_QUERY) return decision
    const sid = String(agent?.session?.id ?? payload?.sessionId ?? 'unknown')
    const already = seenOf(sid)
    state.calls += 1
    let recallText = ''
    try {
      // 多要 4 条：强度过滤会刷掉一部分，回执只按 limit 裁剪，先多拿几条免得永远凑不满。
      const r = await bridge.tryCall(NEIGHBOR_TOOL, { query: query.slice(0, 300), limit: max + 4, hops: 1 }, undefined, '星图邻域')
      recallText = typeof r?.text === 'string' ? r.text : ''
    } catch (err) {
      state.failed += 1
      logger?.(`[macro-memory] 邻域注入这一轮没查成：${err instanceof Error ? err.message : String(err)}`)
      return decision
    }
    const block = neighborBlockOf(recallText, { max, chars, skip: already, minScore })
    if (block === null) {
      state.skipped += 1
      return decision
    }
    const make = await load()
    if (make === null) {
      state.failed += 1
      return decision
    }
    for (const id of block.ids) {
      already.add(id)
      if (already.size > NEIGHBOR_SEEN_MAX) {
        const first = already.values().next()
        if (!first.done) already.delete(first.value)
      }
    }
    state.injected += 1
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
