/**
 * 子插件返回值的「出文本」这一件事（0.2.26 从 bridge.js 分出来）。
 *
 * 约定：
 *  - 只用子插件自己的 output.render，绝不重写它的返回结构；
 *  - 渲染抛错 / 没给 render 才退回字符串或 JSON —— 这里不做品牌改口（那在 bridge.call 里决定）。
 */

export function errText(err) {
  if (err instanceof Error) return err.message
  return String(err)
}

/** 用子插件自己的 output.render 把结果渲染成文本，绝不重写返回结构。 */
export function renderToolText(def, args, value) {
  const render = def?.output?.render
  if (typeof render === 'function') {
    try {
      const blocks = render(args, value)
      const list = Array.isArray(blocks) ? blocks : []
      const texts = list
        .map((b) => (typeof b === 'string' ? b : typeof b?.text === 'string' ? b.text : ''))
        .filter((t) => t !== '')
      if (texts.length > 0) return texts.join('\n')
    } catch {
      /* 渲染失败就退回 JSON */
    }
  }
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}
