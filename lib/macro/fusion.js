// [macro-fusion 0.2.118] 检索融合（RRF）：本地检索与星图扩散各给一套名次，
// 以前是把两段文本上下拼在一起，读者自己去合——同一堆记忆出现在两段里，第二遍白花 token，
// 而「两条路都命中的」这条最有价值的信息（交叉验证过的相关性）反倒没人说。
//
// 这里只做一件事：按**名次**把两路合成一张榜。用名次而不用分数，是因为两路的分数不同源
// （BM25 与星图强度）——分数线不一样的两组数放在一起比大小时，结论是编出来的。
// RRF（Reciprocal Rank Fusion）只要名次：score = Σ 1 / (K + rank)，K=60 是原论文的常用值，
// 作用是把头部差距压平，避免某一路的第一名靠单一分数直接压过另一路的共识项。

export const RRF_K = 60

/** 星图节点的标题行：`1. [fact] ws-name     强度 0.82 标题…`（见 nebula formatHits）。 */
const NODE_HEAD = /^(\d+)\.\s+\[([^\]]+)\]\s+(.*?)\s+强度\s+([\d.]+)\s*(.*)$/
const ID_LINE = /^\s{2,}id:\s*(\S+)\s*$/
const WHY_LINE = /^\s{2,}为什么：\s*(.*)$/
const PREVIEW_LINE = /^\s{2,}摘要：\s*(.*)$/

/**
 * 把 nebula_recall 的回执解析成节点表。
 *
 * 为什么解析文本而不是要一份结构化结果：nebula_recall 的 output schema 就是 `string`，
 * 改它的出参形状会连带改它自己的 render 与既有断言——为了融合去动上游的出参，代价不对等。
 * 解析不到（回执是别的形状、或者自带补丁被冲掉）时返回空数组，调用方退回原来的两段式。
 */
export function graphNodesOf(text) {
  const nodes = []
  let cur = null
  for (const line of String(text ?? '').split('\n')) {
    const head = NODE_HEAD.exec(line)
    if (head) {
      cur = {
        rank: Number(head[1]),
        level: head[2],
        score: Number(head[4]),
        label: String(head[5] ?? '').trim(),
        id: '',
        why: '',
        preview: '',
      }
      nodes.push(cur)
      continue
    }
    if (cur === null) continue
    const idm = ID_LINE.exec(line)
    if (idm) {
      cur.id = idm[1]
      continue
    }
    const whym = WHY_LINE.exec(line)
    if (whym) {
      cur.why = whym[1].trim()
      continue
    }
    const pm = PREVIEW_LINE.exec(line)
    if (pm) cur.preview = pm[1].trim()
  }
  return nodes.filter((n) => n.id !== '')
}

/** 星图 id 可能带工作区前缀（`ws:0mwowj2h2-…`），meow 的裸 id 是最后一段。 */
export function uidOf(id) {
  const s = String(id ?? '')
  const at = s.lastIndexOf(':')
  return at >= 0 ? s.slice(at + 1) : s
}

/** 两个 id 是否指同一条：同 uid，或一方是另一方的前缀（星图允许前 12 位指认）。 */
function sameMem(a, b) {
  if (a === b) return true
  if (a.length === 0 || b.length === 0) return false
  return a.startsWith(b) || b.startsWith(a)
}

/**
 * 合并两路名次。返回按 RRF 排好的行，每行带着它两边的名次——
 * 「第 1 名」和「只在星图里排第 4」是两种可信度，回执里必须能分开念。
 */
export function fuseRanked({ localHits = [], graphNodes = [] } = {}) {
  const localRank = new Map()
  localHits.forEach((h, i) => {
    const u = uidOf(h?.id)
    if (u.length > 0 && !localRank.has(u)) localRank.set(u, i + 1)
  })
  const graphRank = new Map()
  const graphByUid = new Map()
  graphNodes.forEach((n, i) => {
    const u = uidOf(n?.id)
    if (u.length === 0) return
    if (!graphRank.has(u)) {
      graphRank.set(u, i + 1)
      graphByUid.set(u, n)
    }
  })
  const localByUid = new Map()
  localHits.forEach((h) => {
    const u = uidOf(h?.id)
    if (u.length > 0 && !localByUid.has(u)) localByUid.set(u, h)
  })

  // 前缀指认的情况要认出来：星图给前 12 位、本地给全 id 时，两边 uid 不完全相等。
  const rows = []
  const taken = new Set()
  for (const [u, rank] of localRank) {
    let g = graphRank.get(u) ?? 0
    let gn = g > 0 ? graphByUid.get(u) : null
    if (g === 0) {
      for (const [gu, gr] of graphRank) {
        if (taken.has(gu)) continue
        if (sameMem(u, gu)) {
          g = gr
          gn = graphByUid.get(gu)
          taken.add(gu)
          break
        }
      }
    }
    rows.push({ uid: u, localRank: rank, graphRank: g, local: localByUid.get(u) ?? null, graph: gn })
  }
  for (const [gu, gr] of graphRank) {
    if (taken.has(gu)) continue
    if ([...localRank.keys()].some((u) => sameMem(u, gu))) continue
    rows.push({ uid: gu, localRank: 0, graphRank: gr, local: null, graph: graphByUid.get(gu) })
  }
  for (const r of rows) {
    r.rrf = (r.localRank > 0 ? 1 / (RRF_K + r.localRank) : 0) + (r.graphRank > 0 ? 1 / (RRF_K + r.graphRank) : 0)
  }
  rows.sort((a, b) => b.rrf - a.rrf || (a.localRank || 999) - (b.localRank || 999) || (a.graphRank || 999) - (b.graphRank || 999))
  const both = rows.filter((r) => r.localRank > 0 && r.graphRank > 0).length
  const graphOnly = rows.filter((r) => r.localRank === 0).length
  return { rows, both, graphOnly, localOnly: rows.filter((r) => r.graphRank === 0).length }
}

/** 一条命中在榜上的「怎么来的」：两路都中要说两遍，只有一路也要说清是哪一路。 */
export function routeOf(row) {
  if (row.localRank > 0 && row.graphRank > 0) return `本地#${row.localRank} + 星图#${row.graphRank}`
  if (row.localRank > 0) return `本地#${row.localRank}`
  return `星图#${row.graphRank}`
}

function clip(text, n) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim()
  return s.length > n ? `${s.slice(0, n)}…` : s
}

/**
 * 排成给人看的一张榜。
 *
 * 分工：本地命中的条目带全文（它就是答案本身），星图独有的条目只带 lab 与证据
 * （它们靠关联进来，读者要判断的是「这条为什么跟我有关」，不是它的逐字全文）。
 */
export function fusedText({ note = '', rows = [], k = 10, graphShown = 5, dropped = 0, shorten } = {}) {
  // [0.6.67] 行首 id 交给上层决定形状：命中注入 / 邻域 / 项目目录早就是「最短唯一前缀」，
  // 只有这张融合榜还在印 36 字全 id（10 条榜光 id 就吃掉 ~360 字），而且抄回去还得再切。
  // 不给 shorten 时逐位保持老行为——探针与老调用方不受影响。
  const showLocal = typeof shorten === 'function' ? shorten : (id) => String(id ?? '')
  const showGraph =
    typeof shorten === 'function' ? (id) => shorten(uidOf(id)) : (id) => String(id ?? '')
  const lines = []
  const head = note.trim()
  if (head !== '') lines.push(head)
  let printed = 0
  let graphPrinted = 0
  for (const r of rows) {
    if (r.localRank > 0) {
      if (printed >= k) continue
      printed += 1
      const h = r.local ?? {}
      const kw = Array.isArray(h.keywords) ? h.keywords.filter((x) => typeof x === 'string' && x.length > 0) : []
      const about = kw.length > 0 ? kw.join(', ') : clip(h.content, 40)
      const title = String(h.title ?? '').trim()
      lines.push(`${printed}. [${String(h.level ?? '')} ${showLocal(h.id ?? r.uid)}] ${routeOf(r)}${title ? ` · ${title}` : ''} —— 关于：${about}`)
      const body = String(h.content ?? '').replace(/\s+/g, ' ').trim()
      if (body !== '') lines.push(`   ${body}`)
    } else {
      if (graphPrinted >= graphShown) continue
      graphPrinted += 1
      printed += 1
      const g = r.graph ?? {}
      const why = String(g.why ?? '').trim()
      lines.push(`${printed}. [${String(g.level ?? '')} ${showGraph(g.id ?? r.uid)}] ${routeOf(r)}（本地没命中，靠关联进来${why ? `：${why}` : ''}）`)
      if (String(g.preview ?? '').trim() !== '') lines.push(`   ${clip(g.preview, 150)}`)
    }
  }
  if (dropped > 0) {
    lines.push(`（另有 ${dropped} 条星图带回来的没有展开：这次的 limit / 预算只够前 ${graphPrinted} 条。）`)
  }
  return lines.join('\n')
}
