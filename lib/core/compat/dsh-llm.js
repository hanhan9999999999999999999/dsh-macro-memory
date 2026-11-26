/**
 * `@deepseek-ai/dsh-llm` 的最小兼容层（0.8.1）。
 *
 * 为什么需要：meow 引擎在模块顶层
 * `import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm'`。
 * 在 DSH 里这个包由宿主提供，所以一直没暴露问题；但 0.8.0 承诺「不装 DSH 也能用」
 * （npx / MCP），干净机器上根本没有这个包 → `ERR_MODULE_NOT_FOUND`，包当场起不来。
 *
 * 这里只复刻 meow 真正用到的两个符号（外加同族几个构造器，防上游将来多用），
 * 语义与 DSH 的 `@deepseek-ai/dsh-llm` 逐字对齐：
 *   - createMessage：`{...input, id: randomUUID()}` → structuredClone → deepFreeze
 *   - boundContextSummary：超过 120 字符截到 119 + '…'
 *
 * 这不是「假实现」：这两个函数本来就是纯数据整形，没有模型调用、没有 I/O。
 */

import { randomUUID } from 'node:crypto'

/** 与 dsh-llm 的 CONTEXT_SUMMARY_MAX_CHARS 同值。 */
export const CONTEXT_SUMMARY_MAX_CHARS = 120

/** 逐层冻结（structuredClone 出来的对象没有共享引用，直接递归即可）。 */
function deepFreeze(value) {
  if (value === null || typeof value !== 'object') return value
  for (const key of Object.keys(value)) deepFreeze(value[key])
  return Object.freeze(value)
}

/** 截断一条 notice 摘要，超出上限时补省略号。 */
export function boundContextSummary(summary) {
  return summary.length <= CONTEXT_SUMMARY_MAX_CHARS
    ? summary
    : `${summary.slice(0, CONTEXT_SUMMARY_MAX_CHARS - 1)}…`
}

/** 复制一份已带身份的 message 并冻结。 */
export function freezeMessage(message) {
  return deepFreeze(structuredClone(message))
}

/** 造一条带稳定身份的消息并冻结。 */
export function createMessage(input) {
  return deepFreeze(structuredClone({ ...input, id: randomUUID() }))
}

export function createDeveloperMessage(input) {
  return createMessage({ ...input, role: 'developer' })
}

export function createUserMessage(input) {
  return createMessage({ ...input, role: 'user' })
}

export function createAssistantMessage(input) {
  return createMessage({
    role: 'assistant',
    content: input.content,
    source: { kind: 'model', ...input.source },
  })
}

export function createSystemMessage(text) {
  return createMessage({
    role: 'system',
    content: text.length === 0 ? [] : [{ type: 'text', text }],
  })
}

export default {
  CONTEXT_SUMMARY_MAX_CHARS,
  boundContextSummary,
  freezeMessage,
  createMessage,
  createDeveloperMessage,
  createUserMessage,
  createAssistantMessage,
  createSystemMessage,
}
