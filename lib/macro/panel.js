/**
 * 面板口径（0.2.25）：八个面板共用一个抬头，名字只有一份。
 *
 * 以前每个面板各写各的开头：成本账本用 `# macro-memory 成本账本（最近 N 次）`，
 * 待补连线直接甩 `待补连线：N 条`，星图那四个干脆是 vendor 原文（开头是它自己的话）。
 * 模型一次只拿到一段文本，八段八套开头等于没有抬头——既看不出这是哪个面，
 * 也分不清「空」是因为没数据、还是因为星图没接上。
 *
 * 三条约定：
 *   1. 抬头只由这里产；名字只从 defs/admin.js 的 ACTIONS 表来，不在这里再抄一遍。
 *   2. 抬头加在正文**上面**，正文一个字不动（vendor 原文照旧原样）。
 *   3. 手册（guide）没有统计口径可报，不加抬头——全表唯一豁免，理由写在那一行上。
 */

export const PANEL_BRAND = '宏记忆'

/** 抬头本身：`【宏记忆｜成本账本】`。note 是口径说明（最近多少次 / 最多列几条）。 */
export function panelHead(label, note) {
  const head = `【${PANEL_BRAND}｜${String(label ?? '')}】`
  const extra = String(note ?? '').trim()
  return extra.length > 0 ? `${head}${extra}` : head
}

/** 面板全文：抬头 + 正文（正文空就只剩抬头，不留一行空白）。 */
export function panelText(label, body, note) {
  const text = String(body ?? '').trim()
  return text.length > 0 ? `${panelHead(label, note)}\n${text}` : panelHead(label, note)
}

/**
 * 去掉抬头，拿回正文（给「按行读数据」的调用方用：探针要读的是正文第一行）。
 *
 * 有这个函数，说明「抬头」这件事有契约：读的人不靠猜第几行是数据，而靠剥掉抬头。
 * 不带抬头（比如手册）时原样返回，不做任何改写。
 */
export function stripHead(text) {
  const s = String(text ?? '')
  const mark = `【${PANEL_BRAND}｜`
  if (!s.startsWith(mark)) return s
  const at = s.indexOf('】')
  if (at < 0) return s
  return s.slice(s[at + 1] === '\n' ? at + 2 : at + 1)
}

/**
 * 条数上限：默认值跟着动作表走。[macro-fusion 0.2.61]
 * 以前是各写各的 `args.limit === undefined ? 200 : Number(args.limit)`，成本用 200、
 * 队列用 20，两处默认值散在两个方法里；换默认值得翻两处，且没有地方能一眼看全。
 * 现在默认值写在那张表的 defaultLimit，读取只有这一条路径。
 *
 * 0.2.61：这条路径原来对四种输入一声不吭地退回默认值——
 * `limit: 0`（明说「一条都别列」）、`limit: -3`（负条数）、`limit: "十"`（不是数字）、
 * `limit: 2.7`（非整数）。用户拿着被换过的条数读结论，还以为看到的是自己要求的那一段。
 * 判定规则跟 vendor 侧的 numParam()（0.2.57）同一套：能照办就照办，改了就说话。
 */
export function limitOf(spec, args) {
  const fallback = Number(spec?.defaultLimit ?? 0)
  const raw = args?.limit
  if (raw === undefined || raw === null || raw === '') return { value: fallback, note: '' }
  const n = Number(raw)
  if (!Number.isFinite(n)) {
    return { value: fallback, note: `limit 给的是「${String(raw)}」，不是数字——这次按默认 ${fallback} 条算，不是你给的那个。` }
  }
  if (n < 0) {
    return { value: fallback, note: `limit 给的是「${n}」，是负数——条数没有「从后往前数」这回事，这次按默认 ${fallback} 条算。` }
  }
  if (n === 0) {
    return { value: 0, note: 'limit 给的是 0，这次一条都不列——不是「一条都没有」，是你要求不列。' }
  }
  const whole = Math.floor(n)
  if (whole === n) return { value: whole, note: '' }
  return { value: whole, note: `limit 给的是「${n}」，条数只能是整数，这次按 ${whole} 条算——少掉的那半条不是你给的条件。` }
}

/**
 * 卡片标题（0.2.60）：抬头与卡片是同一套口径，标题也只有这一条出口。[macro-fusion 0.2.60]
 *
 * 以前八个 presentCall 各写各的模板串：admin 用中文 label（0.2.25 修过），
 * link 却直接把参数键贴上去——`星图连线：link`、`检索记忆：graph`，
 * 正是 0.2.25 在 admin 里明确禁止的那种「谁也不认识的东西」。
 * 另外参数没给时会留下悬空的冒号（`项目全景：`），多行内容会撑爆一行卡片。
 *
 * 三条约定：
 *   1. 标题 = 前缀 + 「：」 + 细节；细节为空就只留前缀，不留悬空分隔符。
 *   2. 细节压成一行、去掉首尾空白；超过 40 字截断加省略号（卡片只有一行）。
 *   3. 任何面板都不许自己拼字符串——只认 prefix（中文名）+ detail（参数的值）。
 */
export const CARD_DETAIL_MAX = 40

export function cardTitle(label, detail) {
  const prefix = String(label ?? '').trim()
  const flat = typeof detail === 'string' ? detail.replace(/\s+/g, ' ').trim() : ''
  if (flat.length === 0) return prefix
  const short = flat.length > CARD_DETAIL_MAX ? `${flat.slice(0, CARD_DETAIL_MAX)}…` : flat
  return `${prefix}：${short}`
}
