/**
 * 8 个统一工具共用的东西：枚举、输出形状、取值小工具。
 *
 * 单独一个文件是为了让 `defs/*.js` 各自只依赖它和 `linkflow.js`，
 * 谁也不会反向依赖装配器 `tools.js`，加工具时不用动别人的 import（DESIGN §16）。
 */
import * as Meow from '../../vendor/meow-memory/lib/index.js'

/** 以 meow 导出为准；vendor 换版本时不会因为枚举漂移而注册失败。 */
export const LEVELS =
  Array.isArray(Meow.LEVELS) && Meow.LEVELS.length > 0
    ? Meow.LEVELS
    : ['soul', 'user', 'rules', 'fact', 'lesson', 'topic', 'project']

export const PROJECT_SUBCATEGORIES =
  Array.isArray(Meow.PROJECT_SUBCATEGORIES) && Meow.PROJECT_SUBCATEGORIES.length > 0
    ? Meow.PROJECT_SUBCATEGORIES
    : ['overview', 'structure', 'decisions', 'quotes', 'ops', 'todo']

/** 所有统一工具都吐纯文本：模型读得懂，也没必要为 8 个工具各设计一套结构化输出。 */
export const TEXT_OUT = {
  schema: { type: 'string' },
  render: (_args, value) => [
    { type: 'text', text: typeof value === 'string' ? value : safeJson(value) },
  ],
}

export function safeJson(value) {
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

/** 只把调用方真的给过的参数转给子插件——别用 undefined 覆盖 vendor 的默认值。 */
export function pick(source, keys) {
  const out = {}
  for (const key of keys) {
    if (source[key] !== undefined) out[key] = source[key]
  }
  return out
}

/**
 * [macro-fusion 0.2.62] 条数类参数的唯一出口：给多少就照办多少，改过了就得说出口。
 *
 * 以前 memory_read 里是「三元给默认 + `Number()`」后面接一句
 * `if (!Number.isFinite(want) || want <= 0) return said`：非数字、负数、0 三种情况
 * 一起被压成「这次没有邻居段」，读的人只会以为这条记忆压根没有邻居（DESIGN §72）。
 *
 * 约定：
 * - 没给（undefined / null / 空串）→ 默认值，不说话；
 * - 给了 0 → 照办 0（0 是什么意思由调用方定义），不说话；
 * - 非数字 / 负数 → 回默认值，并把原值和原因写出来；
 * - 非整数 → 抹掉小数，并说清「少掉的那半条不是你给的条件」；
 * - 超出上界 → 夹到上界，并说清「结果是被改过的条件算出来的」。
 */
export function countParam(name, raw, { min = 0, max = Number.POSITIVE_INFINITY, def } = {}) {
  if (raw === undefined || raw === null) return { value: def, note: '' }
  if (typeof raw === 'string' && raw.trim() === '') return { value: def, note: '' }
  const n = Number(raw)
  if (!Number.isFinite(n)) {
    return {
      value: def,
      note: `${name} 给的是「${String(raw)}」，不是数字——这次按默认 ${def} 条算，不是你给的那个。`,
    }
  }
  if (n < 0) {
    return {
      value: def,
      note: `${name} 给的是「${n}」，是负数——条数没有「从后往前数」这回事，这次按默认 ${def} 条算。`,
    }
  }
  if (n === 0) return { value: 0, note: '' }
  const whole = Math.floor(n)
  const clamped = Math.max(min, Math.min(max, whole))
  const bits = []
  if (whole !== n) bits.push(`条数只能是整数，这次按 ${clamped} 条算——少掉的那半条不是你给的条件`)
  if (clamped !== whole) {
    bits.push(`超出 ${min}–${max}，这次按 ${clamped} 条算——结果是被改过的条件算出来的，不是你给的那个`)
  }
  if (bits.length === 0) return { value: whole, note: '' }
  return { value: clamped, note: `${name} 给的是「${n}」，${bits.join('；')}。` }
}

/** 从星图 inspect 文本里只取「连接到的记忆」那一段，避免与 meow 的正文重复。 */
export function neighborSection(text, marker = '## 连接到的记忆') {
  if (typeof text !== 'string') return ''
  const at = text.indexOf(marker)
  if (at < 0) return ''
  return text.slice(at).trim()
}

/**
 * [macro-fusion 0.2.77] 邻居段没拿到时的那句话。
 * 以前 read.js 只写 `section ? said + '\n\n' + section : said`：星图失败或回执改了格式时，
 * 那句解释被整段丢掉，读者只看得到正文——于是把「没带到」读成「这条记忆没有邻居」。
 * 三种情况要说三种话，这里只认「段在不在」和「这一问查成没查成」，
 * 不接收星图原文（内部错误不该原样甩给模型）。
 */
export function neighborGapNote(section, reachable, raw = '') {
  if (typeof section === 'string' && section.trim().length > 0) return ''
  if (!reachable) {
    return '星图这次没答上来（这一问没查成），所以邻居一条都没带到——这不是「这条记忆没有邻居」。'
  }
  const said = String(raw ?? '')
  // 星图答上来了，但答的是「没这条记忆」：那是第三种情况，不能套「格式变了」。
  if (/星图里没有|图是空的|还没有节点/.test(said)) {
    return '星图这次没查到这条记忆（可能刚写还没入图，也可能 id 不对），所以没有邻居段——这不是「它没有邻居」。'
  }
  return '星图的回执里没有「连接到的记忆」这一段（多半是它改了格式），所以这次邻居没带到——这不是「这条记忆没有邻居」。'
}
