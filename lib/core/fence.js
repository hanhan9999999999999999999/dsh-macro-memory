/**
 * 文件围栏：唯一会碰用户文件的地方（PLAN-UNIVERSAL §8.3）。
 *
 * 规矩三条，写死在实现里：
 *  1. **块外零改动**：只做字符串拼接/替换，绝不对块外内容做 EOL 归一化、trim、排序。
 *  2. **幂等**：同一份 L0 写两次，文件字节不变（begin/end 之间原地替换，不叠加）。
 *  3. **可还原**：块里用 `sep="N"` 记住追加时我们额外插了几个换行，摘块时按它精确回收——
 *     用户原有文件（哪怕以两个空行结尾）能回到**逐字节**原样，而不是「差不多」。
 *
 * 为什么把 sep 记在块里而不是外部账本：卸载可能发生在另一个进程、另一个工作区、甚至另一台机器，
 * 只有文件自己带着「我是怎么被放进去的」才靠得住。
 */

export const FENCE_BEGIN = '<!-- macro-memory:begin'
export const FENCE_END = '<!-- macro-memory:end -->'
export const FENCE_VERSION = 1

const BEGIN_RE = /<!--\s*macro-memory:begin(?:\s+sep="(\d+)")?(?:\s+v="(\d+)")?\s*-->/
const END_RE = /<!--\s*macro-memory:end\s*-->/

/** 文件里用的是 LF 还是 CRLF——按第一处换行判定，全空或单行视为 LF。 */
export function detectEol(text) {
  const i = text.indexOf('\n')
  return i > 0 && text[i - 1] === '\r' ? '\r\n' : '\n'
}

/**
 * 块正文。`l0` 是引擎给的常驻注入文本（1,266 字符那一份），不在这里改写语义，
 * 只加一行业主说明（谁维护、怎么更新、怎么摘）。
 */
export function renderBlock(l0, { sep = 0, eol = '\n', version = FENCE_VERSION } = {}) {
  const body = String(l0 ?? '').replace(/\r\n/g, '\n').replace(/\s+$/, '')
  const lines = [
    `${FENCE_BEGIN} sep="${sep}" v="${version}" -->`,
    `<!-- 这一块由 macro-memory 维护，不要手改：更新用 \`macro-memory refresh\`，摘掉用 \`macro-memory uninstall\` -->`,
    '',
    body,
    FENCE_END,
  ]
  return lines.join(eol)
}

/** 找到块的区间；没有则 null。begin 有、end 没有也算「坏了」，交给调用方决定怎么报。 */
export function locate(text) {
  const b = BEGIN_RE.exec(text)
  if (!b) return null
  const rest = text.slice(b.index + b[0].length)
  const e = END_RE.exec(rest)
  if (!e) return { start: b.index, end: null, sep: Number(b[1] ?? 0), broken: true }
  return {
    start: b.index,
    end: b.index + b[0].length + e.index + e[0].length,
    sep: Number(b[1] ?? 0),
    version: Number(b[2] ?? 1),
    broken: false,
  }
}

/**
 * 写入/更新块。返回新文本与做了什么（`created` 文件原本不存在、`appended` 追加、`replaced` 原地替换）。
 * 注意：`created` 与 `appended` 的区别要由调用方按「原文本是否为空」自己判——这里只报事实。
 */
export function spliceBlock(text, l0, { eol } = {}) {
  const src = String(text ?? '')
  const useEol = eol ?? detectEol(src)
  const hit = locate(src)
  if (hit && !hit.broken) {
    // 原地替换：保留原来的 sep（当初怎么插的就还是怎么插的），块外一个字不动
    const block = renderBlock(l0, { sep: hit.sep, eol: useEol })
    return {
      text: src.slice(0, hit.start) + block + src.slice(hit.end),
      action: 'replaced',
      sep: hit.sep,
    }
  }
  // 追加：sep = 为了和上文隔开我们额外插了几个 eol
  let sep = 0
  if (src.length > 0) {
    sep = src.endsWith(useEol + useEol) ? 0 : src.endsWith(useEol) ? 1 : 2
  }
  const block = renderBlock(l0, { sep, eol: useEol })
  const pad = sep === 0 ? '' : useEol.repeat(sep)
  return { text: src + pad + block + useEol, action: src.length === 0 ? 'created' : 'appended', sep }
}

/**
 * 摘块。按 `sep` 精确回收当初插入的那几个换行，块后那个换行也是我们加的。
 * 返回 `{ text, removed, broken }`——`broken` 表示 begin 在、end 不在（只报，不改）。
 */
export function stripBlock(text) {
  const src = String(text ?? '')
  const hit = locate(src)
  if (!hit) return { text: src, removed: false, broken: false }
  if (hit.broken) return { text: src, removed: false, broken: true }
  const eol = detectEol(src)
  const padLen = hit.sep * eol.length
  const start = Math.max(0, hit.start - padLen)
  // 我们 append 时在块后补了一个 eol；只有当它确实紧跟块尾时才吃
  const eatsTail = src.slice(hit.end, hit.end + eol.length) === eol
  const end = eatsTail ? hit.end + eol.length : hit.end
  const before = src.slice(0, start)
  const after = src.slice(end)
  return { text: before + after, removed: true, broken: false, sep: hit.sep }
}

/** 摘完之后这个文件是不是「本来就不该存在」（只剩空白）：是则调用方应当删掉它。 */
export function looksEmpty(text) {
  return String(text ?? '').trim().length === 0
}
