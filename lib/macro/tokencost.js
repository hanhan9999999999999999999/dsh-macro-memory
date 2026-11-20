/**
 * [macro-fusion 0.2.109] 回执成本：省 token 的前提是知道自己花了多少。
 *
 * 为什么单独一格：记忆系统的六个衡量维度里，「效率（检索快、不拖累当前任务）」是唯一没有数的——
 * probe 里有条数、有耗时，没有「这次检索占了多少上下文」。没有这个数，
 * 「多查几次也无所谓」就永远是一句空话，调用方也没法判断「值不值」。
 *
 * 口径三件事：
 *  1. 这是**估算**，不是计量。CJK 一个字按 1 token 算（偏保守：真实分词常见 1 字 0.6～1），
 *     其余按 4 字符 1 token。报出来的用量级够用来决定「要不要收紧、收紧多少」，
 *     不够用来跟账单对账——这句要写在尾注里，不然读者会拿它当账单。
 *  2. 只在回执已经够大时才报（`COST_SHOW_MIN`）。一条 40 token 的成本说明加在 80 token 的回执上，
 *     就是拿 token 换噪音——省 token 的工具自己先要省。
 *  3. 预算（budget）是**约束**，不是愿望：给了就让工具自己收缩并如实交代缩了什么；
 *     装不下就说最小能给多少，绝不假装装下了。
 */

/** CJK 统一表意文字 + 日文假名 + 谚文 + 全角标点：这些按「一字一 token」估。 */
const CJK = /[\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uff00-\uffef]/g

/** 回执大到这个量级才值得报成本（token）。低于它的成本说明本身比省下的还贵。 */
export const COST_SHOW_MIN = 500

/** 小到这个量级才建议「只看骨架」。再小就没有可省的了。 */
export const COST_HINT_MIN = 1200

/** 预算下限：比它还小的预算连一条标题都装不下，按不限额处理并说明原因。 */
export const BUDGET_MIN = 80

/** 估算 token 数：CJK 一字算 1，其余 4 字符算 1（向上取整）。空串算 0。 */
export function estTokens(text) {
  const s = typeof text === 'string' ? text : String(text ?? '')
  if (s.length === 0) return 0
  const cjk = (s.match(CJK) ?? []).length
  return cjk + Math.ceil((s.length - cjk) / 4)
}

/** 报数格式：一千以内给整数，过千给一位小数的 k（`1.2k`），不写成 `1.0k`。 */
export function fmtTokens(n) {
  const v = Number(n)
  if (!Number.isFinite(v) || v < 0) return '0'
  if (v < 1000) return String(Math.round(v))
  const k = (v / 1000).toFixed(1)
  return `${k.endsWith('.0') ? k.slice(0, -2) : k}k`
}

/**
 * 解析 budget。四种结果要分开，别压成「没给」：
 *  - 没给 → `{ value: null, note: '' }`（不限额，也不解释）
 *  - 给了但不像数 → 不限额 + 说清「你给的那个没被用上」
 *  - 给了但太小 → 不限额 + 说清最小可用值（假装缩到 80 只会给出一条标题，问不出东西）
 *  - 给了但太大 → 夹到上界 + 说清「结果是被改过的条件算出来的」
 */
export function budgetOf(raw, { max = 20000 } = {}) {
  if (raw === undefined || raw === null) return { value: null, note: '' }
  if (typeof raw === 'string' && raw.trim() === '') return { value: null, note: '' }
  const n = Number(raw)
  if (!Number.isFinite(n)) {
    return { value: null, note: `budget 给的是「${String(raw)}」，不是数字——这次按不限额给（回执仍会报成本）。` }
  }
  if (n < BUDGET_MIN) {
    return {
      value: null,
      note: `budget 给的是「${n}」，比最小可用预算 ${BUDGET_MIN} token 还小——这么点连一条标题都装不下，这次按不限额给。`,
    }
  }
  const whole = Math.floor(n)
  if (whole > max) {
    return { value: max, note: `budget 给的是「${whole}」，超出上界 ${max}——这次按 ${max} token 算，不是你给的那个。` }
  }
  return { value: whole, note: '' }
}

/** 成本那句话（不含预算部分）：`成本 ≈1.2k token（…）`。 */
export function costSentence(text) {
  const est = estTokens(text)
  return `成本 ≈${fmtTokens(est)} token（CJK 一字算 1、其余 4 字符算 1，是量级不是账单）`
}

/**
 * 给「读」这类固定形态的回执补成本：够大才说，不够大一个字不加。
 * 阈值放在这里而不是调用处——两处各写一个数，迟早一个来改、一个忘改。
 */
export function readCostTail(text, { min = COST_SHOW_MIN, hint = COST_HINT_MIN } = {}) {
  const s = String(text ?? '')
  const est = estTokens(s)
  if (est < min) return s
  const hintText = est >= hint ? '；只要骨架就少给几条邻居（neighbors=0 或 3）' : ''
  return `${s}\n\n${costSentence(s)}${hintText}`
}
