/**
 * 文案归口：把子插件原文里的「旧工具名」换成 macro-memory 自己对外的那一套。
 *
 * 为什么需要：compatAliases 默认关掉，nebula_* / memory_find_similar / memory_home
 * 并不注册。子插件的返回文本里如果还写着「可以先用 nebula_recall 搜一下」，
 * 对模型就是一封死指针信 —— 它照着调，只会拿到「工具不存在」。
 *
 * 规则：
 *  - 只在 compatAliases=false 时替换（开着别名，旧名字确实能用，就不动原文）
 *  - 只做名字级替换，不改措辞、不重写子插件逻辑（DESIGN §7 R2）
 *  - 「星图」「记忆库」这类概念词保留，本来就是我们自己的说法
 */
export const BRAND_MAP = [
  // nebula 系 → macro 的 8 个统一工具
  ['nebula_recall', 'memory_search（mode="graph"）'],
  ['nebula_inspect', 'memory_read（neighbors>0）'],
  ['nebula_bridge', 'memory_search（mode="bridge"）'],
  ['nebula_link', 'memory_link'],
  ['nebula_path', 'memory_link（action="path"）'],
  ['nebula_stats', 'memory_admin（action="stats"）'],
  ['nebula_hygiene', 'memory_admin（action="hygiene"）'],
  ['nebula_sources', 'memory_admin（action="sources"）'],
  ['nebula_ingest', 'memory_admin（action="ingest"）'],
  // meow 系里没进主工具面的两个
  ['memory_find_similar', 'memory_search（mode="similar"）'],
  ['memory_home', 'memory_admin（action="home"）'],
  // 自称
  ['meow-memory', 'macro-memory'],
  ['meow 记忆库', '宏记忆库'],
]

/** 把一段子插件文本改成 macro 的说法；aliases=true 时原样返回。 */
export function brandText(text, { aliases = false } = {}) {
  if (aliases === true) return text
  if (typeof text !== 'string' || text.length === 0) return text
  let out = text
  for (const [from, to] of BRAND_MAP) {
    if (out.includes(from)) out = out.split(from).join(to)
  }
  return out
}

/** 这段文本里出现了哪几条旧名字（顺序同 BRAND_MAP）。 */
export function nameHints(text) {
  if (typeof text !== 'string' || text.length === 0) return []
  return BRAND_MAP.filter(([from]) => text.includes(from)).map(([from, to]) => ({ from, to }))
}

/** 「以上是原文」这句话的固定标记；用来保证重复过一遍不会叠两条。 */
export const ORIGINAL_MARK = '一个字没动'

/**
 * 返回的是记忆原文的场合（memory_search / memory_read）用它，而不是 brandText。
 *
 * 为什么不能直接替换：BRAND_MAP 里既有工具名（nebula_recall）也有自称（meow-memory），
 * 而这两串完全可能出现在**用户自己存的正文**里——记忆是「事实的账本」，读回来的必须
 * 跟存进去的一模一样。改了就是数据失真，模型照着读去改，还会把失真写回库里。
 * 所以正文一个字不动，只在末尾补一句「旧名按宏记忆的说法叫什么」，
 * 既不让模型拿着旧名去调（死指针），也不篡改内容。
 */
export function withNameHints(text, { aliases = false } = {}) {
  if (aliases === true) return text
  if (typeof text !== 'string' || text.length === 0) return text
  if (text.includes(ORIGINAL_MARK)) return text
  const hits = nameHints(text)
  if (hits.length === 0) return text
  const shown = hits.slice(0, 6).map((h) => `${h.from} → ${h.to}`)
  const more = hits.length > shown.length ? `；另外还有 ${hits.length - shown.length} 条旧名` : ''
  return `${text}\n\n（以上正文是记忆原文，${ORIGINAL_MARK}。里面的旧名字按宏记忆的说法是：${shown.join('；')}${more}——要调就调箭头右边的。）`
}

/** 递归把一个值里的字符串全部改口（数组/对象都走一遍）。 */
export function brandDeep(value, options) {
  if (typeof value === 'string') return brandText(value, options)
  if (Array.isArray(value)) return value.map((item) => brandDeep(item, options))
  if (value && typeof value === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(value)) out[k] = brandDeep(v, options)
    return out
  }
  return value
}
