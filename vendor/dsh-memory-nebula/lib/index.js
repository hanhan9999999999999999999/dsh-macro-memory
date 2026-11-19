/**
 * 宏记忆 · 星图 · 宿主插件 [macro-fusion 0.2.11]
 *
 * 干三件事：
 *  1. 以只读方式把各处记忆库（meow-memory 等）抽出来，建一张带证据的连接图；
 *  2. 在左侧栏给主人一个能看、能点的星云界面（同源 iframe）；
 *  3. 把这张图接进 AI 的检索路径：工具 + 每轮「邻域提示」，
 *     让别的记忆插件检索到 A 的时候，能顺带读出与 A 相连的 B。
 *
 * 只写自己的目录：$DSH_HOME/memory-nebula/
 */
import { registerRoutes, PREFIX, VERSION } from './host/http.js'
import { LiveEngine, liveFacade } from './host/live.js'
import { HUB_CAP } from './host/nebula.js'
import { nebulaHome } from './host/sources.js'
import { readFileSync, existsSync, appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { clip, cut } from './host/text.js'

/** 插件自己的日志（引擎还没起来时也能写）。 */
function appendLog(line) {
  try {
    const home = nebulaHome()
    mkdirSync(home, { recursive: true })
    appendFileSync(join(home, 'nebula.log'), `[${new Date().toISOString()}] ${line}\n`)
  } catch {
    /* 日志失败不影响主流程 */
  }
}

export const name = 'memory-nebula'
export const version = VERSION
export const inject = ['tools', 'systemPrompt', 'webServer', 'connection']

/** 每轮注入的稳定部分（进 prompt 缓存前缀，越短越好）。 */
const RULE = [
  '【宏记忆 · 星图 memory-nebula】你有一张跨工作区记忆网络（不同项目的记忆之间已经算好并验证过关联）。',
  '- 想找记忆时用 nebula_recall(query=…)：它从命中点沿关联扩散，会带回别的项目里真正相关的记忆，每条都给出关联证据。',
  '- 别的记忆工具（meow-memory / hindsight / openviking 等）返回了记忆 id 时，把 id 传给 nebula_recall(memory_ids=[…])，星图会把与它们相连的记忆一并读出——这是「检索 A 连带读出 B」的用法。',
  '- 不确定两条记忆为什么相连：用 nebula_path(a, b) 看它们之间的最短证据链，每一步都带连接类型和权重；这条路走不通就说明它们没有关系。',
  '- 想确认某条记忆的全部上下文（正文、关键词、邻居与每条边的证据、写它时主人说的原话），用 nebula_inspect(id)。',
  '- 发现关联是错的：`nebula_link(action="mute", a, b)` 屏蔽它（重建也不会再连），比 unlink 更彻底；撤销用 action="unmute"。',
  '- 想查记忆库自己的毛病（重复、该更新、关系凑数、超重、没人读、孤立）用 nebula_hygiene()；它只诊断，改不改由你或主人定。',
  '- 别的插件刚喂过记忆、你想补上下文又不想重复：nebula_bridge(memory_ids=[…]) 会挑出强相关但还没读过的邻居。要接新记忆库先看 nebula_sources 的指南；远端记忆服务可用 nebula_ingest 推进来。',
].join('\n')

/** 数字对齐，纯文本表格。 */
function pad(text, width) {
  const s = String(text ?? '')
  let w = 0
  for (const ch of s) w += ch.charCodeAt(0) > 127 ? 2 : 1
  return s + ' '.repeat(Math.max(0, width - w))
}

/**
 * [macro-fusion 0.2.57] 数值参数不许被 `Number(x) || 默认值` 吃掉。
 *
 * 老写法把「Number(args.x) 后面接 `|| 默认值`」塞进 Math.min/Math.max 三层里，有三个坑，而且都不吭声：
 *   ① 显式给的 **0** 是 falsy —— `min_weight: 0`（明确要求「不过滤权重」）会被换成 0.5，
 *      于是结果里有东西被滤掉，回执还说「把 min_weight 调低一点」，用户明明已经调到最低了；
 *      `hops: 0` 同样被换成默认跳数。
 *   ② 越界值被 Math.min/max 夹住，回执一个字都不说 —— 用户拿着被改过的条件读结论，
 *      而「30 条就是全部命中」这句话在夹过的 limit 下是假的。
 *   ③ 非数字（`limit: "十"`）静默退回默认。
 * 三次都只是「参数没生效」，但读者会把它读成「结果就是这样」。所以这里统一出口：
 * 合规就原样照办（0 也照办），不合规就夹/退回默认 **并且带一句话** 出来。
 * @returns {{value:number, note:string}} note 为空 = 不需要解释
 */
function numParam(name, raw, { min, max, def }) {
  if (raw === void 0 || raw === null || String(raw).trim() === '') return { value: def, note: '' }
  const n = Number(raw)
  if (!Number.isFinite(n)) {
    return { value: def, note: `${name} 给的是「${String(raw)}」，不是数字——这次按默认 ${def} 算，不是你给的那个值。` }
  }
  const clamped = Math.max(min, Math.min(max, n))
  if (clamped === n) return { value: n, note: '' }
  return { value: clamped, note: `${name} 给的是「${n}」，超出 ${min}–${max}，这次按 ${clamped} 算——结果是被改过的条件算出来的，不是你给的那个。` }
}

/**
 * 把命中结果排成给模型看的文本。
 * @param {{hits:any[], query:string, scanned?:number}} res
 * @param {string} [note]
 */
function formatHits(res, note = '') {
  const hits = res?.hits || []
  if (hits.length === 0) {
    // [macro-fusion 0.2.39] 空结果有两种：图里真没有，和图还没建完（空图 / 重建中）。
    // 以前两种都回一句「星图里没有匹配」，于是重建期的零命中被读成「确认没有这条记忆」。
    // 扫描条数是 recall 本来就算好的数（scanned），只是空命中时被丢掉了——这里不许再丢。
    const total = Number(res?.nodes ?? -1)
    const q = res?.query || ''
    const head =
      total === 0
        ? 'nebula_recall: 星图里还没有节点（图是空的），这一问等于没算。'
        : `nebula_recall: 星图里没有匹配「${q}」的记忆（图里 ${total < 0 ? '若干' : total} 条节点，一条都对不上）。`
    const unknown = Array.isArray(res?.unknown) ? res.unknown.filter(Boolean) : []
    const tail = unknown.length ? `这些词星图里一次都没出现：${unknown.slice(0, 6).join('、')}` : ''
    return [head, note, tail].filter(Boolean).join('\n')
  }
  const lines = []
  lines.push(`nebula_recall「${res.query || ''}」→ ${hits.length} 条（扫描 ${res.scanned || 0} 条候选${note ? '；' + note : ''}）`)
  hits.forEach((h, i) => {
    lines.push(
      `${i + 1}. [${h.level}] ${pad(h.ws, 12)} 强度 ${String(h.score).padEnd(5)} ${clip(h.label || h.title || h.id, 46)}`,
    )
    lines.push(`   id: ${h.id}`)
    if (h.why) lines.push(`   为什么：${h.why}`)
    if (h.preview) lines.push(`   摘要：${clip(h.preview, 150)}`)
  })
  return lines.join('\n')
}

/**
 * [macro-fusion 0.2.74] 列表被截断时的那一句尾注。
 *
 * 体检的每个列表有两道闸：引擎每类最多留 40 条（payload 有上限），参数 `limit` 再截一道。
 * 用户能看见的只有正文里那几行，所以「列了几条、还剩几条」必须按**正文实际列出的条数**
 * （printed）算，不能按任何一种内部账：
 *   - 按引擎那本账（items.length=40）算，会出现「只列前 40 条」底下只有 6 行；
 *   - 按参数 limit 算，会出现正文 6 行 + 「还有 94 条」= 100，而别的类别数字又对不上。
 *
 * 返回空串表示没截断（一条不少），调用方别加空行。
 */
export function listTail(n, printed, limit) {
  const total = Math.max(0, Math.trunc(Number(n) || 0))
  const shown = Math.max(0, Math.trunc(Number(printed) || 0))
  const cap = Math.max(1, Math.trunc(Number(limit) || 1))
  const left = total - shown
  if (left <= 0) return ''
  return `  …还有 ${left} 条（每类最多列 ${cap} 条，要看更多把 limit 调大；上面的计数是全量，没列的不代表不存在）`
}

/**
 * [macro-fusion 0.2.75] 枢纽榜被截断时的那一句尾注。
 *
 * 枢纽是**按连接度排在最前的一小撮**，不是「全图删掉这一小撮」：剩下的绝大多数是只有
 * 一两条边、甚至一条边都没有的记忆。旧写法把 `s.nodes - top.length` 当成「还有多少条没列」，
 * 读者读到的意思是「还有 2988 个枢纽没给你看」；它自己也知道这句话站不住，才紧跟着再补一句
 * 安抚——那句补丁等于当场承认前一个数字不成立。
 *
 * 现在只报读者能数到的三个数：这一段列了几条、够格参评的有几条（有连接的记忆）、
 * 参数能要到几条（上限）。三个数都来自「读者看得见的东西」，不掺引擎的内部计数。
 * 没截断就返回空串。
 */
export function hubTail(printed, pool, cap) {
  const shown = Math.max(0, Math.trunc(Number(printed) || 0))
  const cand = Math.max(0, Math.trunc(Number(pool) || 0))
  const limit = Math.max(1, Math.trunc(Number(cap) || 1))
  if (cand - shown <= 0) return ''
  return `  全图 ${cand} 条记忆彼此有连接，这里只取排在最前的 ${shown} 条（hubs 上限 ${limit}）；没进前 ${shown} 的不是「没有连接」，只是没排上来。`
}

export function apply(ctx) {
  const live = new LiveEngine({ onLog: appendLog })
  const nebula = liveFacade(live)
  const log = appendLog

  // ---------- 启动：后台建图 + 12s 巡检（引擎热载也在 LiveEngine 里） ----------
  live
    .ensure()
    .then(() => log('首次建图完成'))
    .catch((err) => log('首次建图失败：' + (err?.stack || err)))

  ctx.effect(() => {
    return () => {
      try {
        nebula.stopWatching()
      } catch {
        /* ignore */
      }
    }
  }, 'memory-nebula:cleanup')

  // ---------- HTTP + 页面 ----------
  try {
    registerRoutes(ctx.webServer, nebula, log, { mode: 'host', connection: ctx.connection })
    log(`已挂载 ${PREFIX}（页面 ${PREFIX}/app）`)
  } catch (err) {
    log('挂载 webServer 失败：' + (err?.stack || err))
  }

  // ---------- 工具 ----------
  const render = (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }]
  const out = { schema: { type: 'string' }, render }

  ctx.effect(() =>
    ctx.tools.register({
      name: 'nebula_recall',
      description:
        '在「宏记忆 · 星图」里检索记忆：先按语义/关键词命中，再沿已算好的关联（同一实体、同项目、同关键词、共激活、语义相似）向外扩散，把别的项目里真正相关的记忆一起带回来，并给出每一层的关联证据。适合跨项目回忆、找「和这件事有关但记在别处」的东西。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '自然语言描述或关键词。只给 memory_ids 时可以为空。' },
          memory_ids: {
            type: 'array',
            items: { type: 'string' },
            description: '别的记忆工具刚返回的记忆 id（meow 的 id 或星图的完整 id），用来从这些点向外交扩散。',
          },
          limit: { type: 'number', description: '返回条数，默认 10，上限 30。' },
          hops: { type: 'number', description: '扩散跳数，默认 2；1=只看直接邻居，2=邻居的邻居。' },
        },
        required: [],
        additionalProperties: false,
      },
      output: out,
      async execute(args = {}) {
        if (!nebula.graph || nebula.graph.nodes.length === 0) await nebula.refresh()
        const query = String(args.query || '').trim()
        const ids = Array.isArray(args.memory_ids) ? args.memory_ids.filter((x) => typeof x === 'string' && x.trim()) : []
        if (!query && ids.length === 0) return 'nebula_recall 需要 query 或 memory_ids 至少一个。'
        const pLimit = numParam('limit', args.limit, { min: 1, max: 30, def: 10 })
        const pHops = numParam('hops', args.hops, { min: 0, max: 3, def: 2 })
        const notes = [pLimit.note, pHops.note].filter(Boolean)
        const res = await nebula.recallAsync(query, { limit: pLimit.value, hops: pHops.value, seedIds: ids })
        const base = formatHits(res, ids.length ? `种子来自你给的 ${ids.length} 条记忆 id` : '')
        return notes.length ? `${base}\n${notes.join('\n')}` : base
      },
    }),
  )

  ctx.effect(() =>
    ctx.tools.register({
      name: 'nebula_inspect',
      description:
        '看一条记忆在星图里的完整上下文：全文、项目、关键词，以及它连接到的每一条记忆和「为什么相连」的证据。用来验证关联是否可信，或顺着一条记忆摸清一整片。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '记忆 id（星图完整 id，或 meow-memory 的裸 id）。' },
          neighbors: { type: 'number', description: '最多列出多少条邻居，默认 12。' },
        },
        required: ['id'],
        additionalProperties: false,
      },
      output: out,
      async execute(args = {}) {
        const id = String(args.id || '').trim()
        if (!id) return 'nebula_inspect 需要 id。'
        const d = nebula.detail(id)
        // [macro-fusion 0.2.42] 这一句在两种情况下都会出现，而两种情况下用户该做的事相反：
        // 图是空的（这次问等于没算）／ 图里有东西但没有这一条（可能刚写还没入图，也可能 id 不对）。
        // 前者被读成「这条记忆没了」→ 去还原备份。所以空图必须自己说清楚，并给出节点总数。
        if (!d) {
          const total = nebula.graph?.nodes?.length ?? 0
          if (total === 0) {
            return '星图里还没有节点（图是空的），这次 nebula_inspect 等于没算——这不是「这条记忆不存在」。等星图建起来（约 12s 一轮巡检）再查一次；记忆本身没受影响。'
          }
          return `星图里没有 id=${id} 的记忆。这不等于「记忆没了」：图里现有 ${total} 条节点，可能是刚写还没入图（约 12s 一轮巡检），也可能是 id 不对（裸 id 给前 12 位就够）。可以先用 nebula_recall 搜关键词确认。`
        }
        const pNb = numParam('neighbors', args.neighbors, { min: 1, max: 40, def: 12 })
        const max = pNb.value
        const lines = [
          `# ${d.title || d.label}`,
          `层级 ${d.level} · 工作区 ${d.wsTitle} · 项目 ${d.project || '—'} · 重要性 ${d.importance} · 连接 ${d.degree || (d.neighbors || []).length}`,
          `id: ${d.id}`,
          '',
          clip(d.content, 1600),
          '',
        ]
        if ((d.keywords || []).length) lines.push('关键词：' + d.keywords.join('、'), '')
        const nbrs = (d.neighbors || []).slice(0, max)
        lines.push(`## 连接到的记忆（${nbrs.length}/${(d.neighbors || []).length}）`)
        for (const n of nbrs) {
          lines.push(`- [${n.type} ${(n.weight ?? n.w ?? 0).toFixed(2)}] ${n.label}  ·  ${n.ws}  ·  ${n.level}`)
          lines.push(`  id: ${n.id}`)
          if (n.why) lines.push(`  证据：${n.why}`)
        }
        if (pNb.note) lines.push('', pNb.note)
        return lines.join('\n')
      },
    }),
  )

  ctx.effect(() =>
    ctx.tools.register({
      name: 'nebula_link',
      description:
        '人工校正星图连接：action="link" 把两条记忆固化成一条手工连线（永不剪掉）；action="unlink" 断开一条手工连线；' +
        'action="mute" 屏蔽一条**推断错了**的自动关联（记进黑名单，之后每次重建都不会再连它）；action="unmute" 撤销屏蔽。' +
        '改动只写进星图自己的库，不会动任何原记忆。',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['link', 'unlink', 'mute', 'unmute'],
            description: 'link=固化连线；unlink=断开手工连线；mute=屏蔽错误的自动关联；unmute=撤销屏蔽',
          },
          a: { type: 'string', description: '记忆 A 的 id' },
          b: { type: 'string', description: '记忆 B 的 id' },
          note: { type: 'string', description: '理由（可选，建议写，方便以后回看为什么连/为什么屏蔽）' },
        },
        required: ['action', 'a', 'b'],
        additionalProperties: false,
      },
      output: out,
      async execute(args = {}) {
        const action = String(args.action || '').trim()
        const a = String(args.a || '').trim()
        const b = String(args.b || '').trim()
        if (!a || !b) return '需要 a 和 b 两条记忆 id。'
        try {
        if (action === 'link') {
          const r = nebula.link(a, b, String(args.note || ''))
          // 就地生效：冻结 now 下策展一条与全量重建逐边相同（正好 +1 条），不重建
          return `已固化连线：${r.a} ↔ ${r.b}${r.note ? '（' + r.note + '）' : ''}`
        }
        if (action === 'unlink') {
          const ok = nebula.unlink(a, b)
          return ok ? `已断开：${a} ✕ ${b}` : '没有找到这条手工连线（可能本来就是断的，或 id 不对）。'
        }
        if (action === 'mute') {
          const r = nebula.mute(a, b, String(args.note || ''))
          // 就地删掉这一条；剪枝腾出的空位不补，下次重建时补位
          return `已屏蔽这条关联：${r.a} ✕ ${r.b}（以后重建不会再连；要撤销用 action="unmute"）`
        }
        if (action === 'unmute') {
          const ok = nebula.unmute(a, b)
          if (ok && nebula.takeRebuildFlag()) await nebula.refresh({ force: true })
          return ok ? `已撤销屏蔽：${a} ↔ ${b}（下次重建会重新按证据连）` : '这一对本来就没有被屏蔽。'
        }
        return 'action 只能是 link / unlink / mute / unmute。'
        } catch (err) {
          // id 不存在、或者引擎还在建图：把原因说清楚，别把异常丢给宿主
          return `nebula_link 没做成：${err?.message || err}`
        }
      },
    }),
  )

  ctx.effect(() =>
    ctx.tools.register({
      name: 'nebula_path',
      description:
        '解释两条记忆之间「到底怎么连上的」：在星图里找一条代价最小的证据链（优先走权重高的边），' +
        '逐步列出每一步的连接类型、权重和证据。找不到就说明这两条在星图里没有关系——不会硬凑。' +
        '用来核对推断是否合理，或回答「这条记忆和那个项目有什么干系」。',
      parameters: {
        type: 'object',
        properties: {
          a: { type: 'string', description: '起点记忆 id' },
          b: { type: 'string', description: '终点记忆 id' },
          maxHops: { type: 'number', description: '最多几跳，默认 6' },
        },
        required: ['a', 'b'],
        additionalProperties: false,
      },
      output: out,
      async execute(args = {}) {
        const a = String(args.a || '').trim()
        const b = String(args.b || '').trim()
        if (!a || !b) return '需要 a 和 b 两个 id。'
        const pMh = numParam('maxHops', args.maxHops, { min: 1, max: 12, def: 6 })
        const r = await nebula.path(a, b, { maxHops: pMh.value })
        if (!r || !r.found) {
          // [macro-fusion 0.2.45] 原来这里把四种情况压成一句
          // 「这两条记忆在星图里没有连上（<原因>）。没有关系就不编关系。」
          // 其中三种根本不是关系结论：图是空的、引擎还没带路径搜索、节点还没入图。
          // 这是这一族里代价最高的错误——「没有关系」会让人停止追问，而且它出现在
          // 提示词里教模型「用 nebula_path 核对推断」的地方。
          const totalP = nebula.graph?.nodes?.length ?? 0
          const hopsP = pMh.value
          if (totalP === 0) {
            return '星图里还没有节点（图是空的），这次 nebula_path 等于没算——这不是「这两条记忆没有关系」。等星图建起来（约 12s 一轮巡检）再问一次；记忆本身没受影响。'
          }
          if (r?.error) {
            if (String(r.error).includes('还没带上路径搜索')) {
              return `这次没算成：${r.error}。这不是「这两条记忆没有关系」——重启宿主后再问一次就行，记忆本身没受影响。`
            }
            return `这次没算成：${r.error}（图里现在有 ${totalP} 条节点）。这不等于「这两条记忆没有关系」——可能是刚写还没入图（约 12s 一轮巡检），也可能 id 不对（裸 id 给前 12 位就够）。等一轮再问一次就行。`
          }
          return `这两条记忆在星图里确实没有连上：${hopsP} 跳以内一条可走的边都没有（图里现有 ${totalP} 条节点）。没有关系就不编关系。${pMh.note ? '\n' + pMh.note : ''}`
        }
        if (!r.hops) return '是同一条记忆。'
        const lines = [`${r.nodes[0].label} ⇢ ${r.nodes[r.nodes.length - 1].label}：${r.hops} 跳，链强度 ${r.score}`, '']
        for (let i = 0; i < r.edges.length; i += 1) {
          const e = r.edges[i]
          const from = r.nodes[i]
          const to = r.nodes[i + 1]
          lines.push(`${i + 1}. ${from.label}`)
          lines.push(`   ↳ [${e.t}] ${e.w} · ${e.why}`)
          lines.push(`   → ${to.label}`)
        }
        lines.push('', '每一步都来自建图时算出的边；如果某一步你觉得不该连，用 nebula_link(action="mute") 把它按掉。')
        if (pMh.note) lines.push('', pMh.note)
        return lines.join('\n')
      },
    }),
  )

  ctx.effect(() =>
    ctx.tools.register({
      name: 'nebula_stats',
      description: '看宏记忆 · 星图的整体状况：多少条记忆、多少条连接、各工作区分布、连接类型分布、以及连接最多的枢纽记忆。',
      parameters: {
        type: 'object',
        properties: {
          // [macro-fusion 0.2.71] 上限必须写在这句话里，因为它是真的上限（以前实现写死 12，这句话形同虚设）
          // [macro-fusion 0.2.75] 上限只剩一个数（HUB_CAP）：夹参数、正文尾注、这句描述都读它。
          // 再写成字面量，就等于又把同一个上限抄了一遍——改一处漏两处。
          hubs: { type: 'number', description: `列多少个枢纽，默认 10，上限 ${HUB_CAP}；没列完的会在正文说清「这一段列了几条、够格参评的有几条」。` },
        },
        required: [],
        additionalProperties: false,
      },
      output: out,
      async execute(args = {}) {
        if (!nebula.graph || nebula.graph.nodes.length === 0) await nebula.refresh()
        // [macro-fusion 0.2.71] hubs 先算完再取概览：以前 `slice(0, 12)` 写死，
        // 给 20 也只出 12 条，且正文不说到没说完——「枢纽就这几个」是读者自己补的结论。
        // [macro-fusion 0.2.75] 夹参数的一个数、正文里那句上限、schema 里那句上限原来各写一遍，
        // 现在都读 HUB_CAP，一处改、三处一起动。
        const pHubs = numParam('hubs', args.hubs, { min: 1, max: HUB_CAP, def: 10 })
        const o = await nebula.overviewAsync({ hubs: pHubs.value })
        const s = o.stats || {}
        const top = o.hubs
        // [macro-fusion 0.2.41] 「0 条记忆」是最容易被读成「记忆丢了」的一行数字。
        // 同一句「0 条」既是「还没建起来」也是「来源读不出来」也是「真的一条都没有」——
        // 前两种情况下人第一反应是「数据没了」，然后去翻备份。必须当场把原因说出来。
        if ((nebula.graph?.nodes?.length ?? 0) === 0) {
          const bad = (o.readErrors || []).map((e) => e.title || e.key).filter(Boolean)
          const stores = (o.sources || []).length
          const why = bad.length
            ? `有 ${bad.length} 个来源读不出来（${bad.join(' / ')}）——这不是「记忆丢了」，是没读到。`
            : stores === 0
              ? '一个记忆来源都没接上（用 nebula_sources 看配置）——这不是「记忆丢了」。'
              : '来源都连着，但目前一条都没读进图里（建图一轮约 12s，建完再问一次）——这不是「记忆丢了」。'
          return [
            '宏记忆 · 星图现在还是空的：0 条记忆 / 0 条连接。',
            why,
            o.lastError ? `最近一次错误：${o.lastError}` : '',
            '记忆本身没受影响：这里只是「图里没有节点」，不等于库里没有记忆。',
          ]
            .filter(Boolean)
            .join('\n')
        }
        // [macro-fusion 0.2.71] 列表被截断时必须说：全图有几条、这里列了几条。
        // 一排 12 行写在「枢纽记忆：」下面，读者补的结论是「枢纽就这 12 个」——
        // 而它其实只是「按连接度 × 重要性排的前 12 条」，剩下的 200 条一个字没提。
        // [macro-fusion 0.2.75] 但「剩下的 200 条」不等于「还有 200 个枢纽」：那 200 条里
        // 大多是只有一两条边、甚至一条边都没有的记忆。旧写法 `s.nodes - top.length`
        // 把孤立记忆也算成「没列出的枢纽」，还要再补一句安抚话打圆场。
        // 现在抬头不报数，尾注由 hubTail() 一处说清：列了几条 / 有连接的共几条 / 上限几条。
        const pool = Math.max(0, (s.nodes || 0) - (s.orphans || 0))
        const lines = [
          `宏记忆 · 星图：${s.nodes} 条记忆 / ${s.edges} 条连接 / ${s.workspaces} 个工作区 / ${s.sessions} 个会话账本`,
          `平均连接度 ${(s.avgDegree || 0).toFixed(2)}，孤立记忆 ${s.orphans} 条，构建耗时 ${o.buildMs}ms`,
          '',
          '工作区：' + o.workspaces.map((w) => `${w.name}(${w.count})`).join('  '),
          '层级：' + Object.entries(o.levels || {}).map(([k, v]) => `${k}(${v})`).join('  '),
          '连接类型：' + Object.entries(o.edgeTypes || {}).map(([k, v]) => `${k}(${v})`).join('  '),
          '',
          '枢纽记忆（按连接度 × 重要性排）：',
        ]
        for (const h of top) lines.push(`- [${h.level}] ${h.label} · ${h.ws} · 连接 ${h.degree} · 重要性 ${h.importance}`)
        const hubNote = hubTail(top.length, pool, HUB_CAP)
        if (hubNote) lines.push(hubNote)
        if (o.lastError) lines.push('', '最近一次错误：' + o.lastError)
        if (pHubs.note) lines.push('', pHubs.note)
        return lines.join('\n')
      },
    }),
  )

  ctx.effect(() =>
    ctx.tools.register({
      name: 'nebula_hygiene',
      description:
        '记忆体检：把六类失效模式查出来给你——疑似重复、该更新了、关系是凑的、超重、没人读过、孤立。只诊断不改任何记忆；要不要合并、删掉、补连接由你或主人决定。',
      parameters: {
        type: 'object',
        properties: {
          kind: {
            type: 'string',
            enum: ['dup', 'stale', 'thin', 'oversize', 'unread', 'orphan'],
            description: '只看某一类；不传就返回全部概览。',
          },
          limit: { type: 'number', description: '每类最多列多少条，默认 6。' },
        },
        required: [],
        additionalProperties: false,
      },
      output: out,
      async execute(args = {}) {
        if (!nebula.graph || nebula.graph.nodes.length === 0) await nebula.refresh()
        const h = await nebula.hygieneAsync()
        // [macro-fusion 0.2.40] 空图时「共 0 项」会被读成「很干净」——那其实是没算。
        // 凭据只能用「图里有多少节点」：h.total 是「查出多少毛病」，两种情况下都可能是 0。
        if ((nebula.graph?.nodes?.length ?? 0) === 0) {
          return '记忆体检：星图里还没有节点（图是空的），这次体检等于没算——「0 项」不是「很干净」。等星图建起来（约 12s 一轮巡检）再查一次；记忆本身没受影响。'
        }
        const items = h.items || {}
        const pLim = numParam('limit', args.limit, { min: 1, max: 20, def: 6 })
        const limit = pLim.value
        const NAME = {
          dup: '疑似重复',
          stale: '该更新了',
          thin: '关系是凑的',
          oversize: '超重',
          unread: '没人读过',
          orphan: '孤立',
        }
        const kinds = args.kind ? [args.kind] : Object.keys(NAME)
        // [macro-fusion 0.2.64] 不认识的类别不许打成「undefined（0）」：那行看起来像
        // 「这一类是 0 条」，真实是「这一类根本不在体检范围内」。融合层已经按白名单挡过，
        // 这层是给直接用 nebula_hygiene 的宿主兜底——名字取不到就把键原样打出来。
        const labelOf = (k) => NAME[k] ?? String(k)
        const counts = h.counts || {}
        const lines = [`记忆体检：共 ${h.total} 项（只诊断，不动任何记忆）`]
        for (const k of kinds) {
          const arr = items[k] || []
          const n = counts[k] || arr.length
          if (!n) {
            lines.push('', `${labelOf(k)}（0）`)
            continue
          }
          // [macro-fusion 0.2.74] 一个列表被两处截断（引擎每类最多留 40 条 + 参数 limit），
          // 正文却只在抬头报了一处，而且报的是**引擎那本账**：counts=100、items 已截到 40、
          // limit=6 时抬头写「这里只列前 40 条」，正文其实只有 6 行，尾注「还有 94 条」。
          // 三个数字各说各的，读者拿哪个都算不对。现在只报一处：抬头只给全量计数，
          // 真正的「列了几条 / 还剩几条」由 listTail() 统一说。
          const printed = Math.min(limit, arr.length)
          lines.push('', `${labelOf(k)}（${n}）`)
          for (const it of arr.slice(0, printed)) {
            if (k === 'dup' && it.a && it.b) {
              lines.push(`- ${cut(it.a.label || '', 40)} ⇄ ${cut(it.b.label || '', 40)}（相似 ${it.sim}）`)
              lines.push(`  A: ${it.a.id}`)
              lines.push(`  B: ${it.b.id}`)
              continue
            }
            const extra = k === 'oversize' ? ` · ${it.size} 字` : k === 'thin' ? ` · 度 ${it.degree} 均权 ${it.avg}` : ''
            lines.push(`- [${it.level || ''}] ${cut(it.label || '', 50)} · ${it.ws || ''}${extra}`)
            lines.push(`  ${it.id}`)
          }
          const tail = listTail(n, printed, limit)
          if (tail) lines.push(tail)
        }
        lines.push('', '要动手就按 id 来：合并/改写属于别人的记忆库，先问主人；星图这边只提供 nebula_link(action="mute") 断掉错误关联。')
        if (pLim.note) lines.push('', pLim.note)
        return lines.join('\n')
      },
    }),
  )

  // ---------- 跨插件协同：补充包 / 来源体检 / 外部推送 ----------
  ctx.effect(() =>
    ctx.tools.register({
      name: 'nebula_bridge',
      description:
        '跨记忆插件的「补充包」。把别的记忆插件刚注入或刚检索到的记忆 id 交给星图，它沿已算好的关联扩散一跳，去掉已经注入过的，按预算挑出 2~4 条「强相关但还没讲过」的记忆。适合：你刚用 meow-memory / hindsight / openviking 检索过，想知道还有什么该一起读；或你只想补上下文，不想重复读同一批。',
      parameters: {
        type: 'object',
        properties: {
          memory_ids: {
            type: 'array',
            items: { type: 'string' },
            description: '种子记忆 id（任意插件的完整 id 或裸 id 都行）。',
          },
          query: { type: 'string', description: '没有 memory_ids 时，用查询词找种子。' },
          limit: { type: 'number', description: '最多返回几条，默认 4。' },
          chars: { type: 'number', description: '文本预算（字符），默认 900。' },
          min_weight: { type: 'number', description: '最低关联权重，默认 0.5。' },
          hops: { type: 'number', description: '扩散跳数，默认 1。' },
        },
        required: [],
        additionalProperties: false,
      },
      output: out,
      async execute(args = {}) {
        if (!nebula.graph || nebula.graph.nodes.length === 0) await nebula.refresh()
        const ids = Array.isArray(args.memory_ids) ? args.memory_ids.filter((x) => typeof x === 'string' && x.trim()) : []
        const query = String(args.query || '').trim()
        if (ids.length === 0 && !query) return 'nebula_bridge 需要 memory_ids 或 query 至少一个。'
        const pLim = numParam('limit', args.limit, { min: 1, max: 12, def: 4 })
        const pChars = numParam('chars', args.chars, { min: 200, max: 4000, def: 900 })
        const pWeight = numParam('min_weight', args.min_weight, { min: 0, max: 1, def: 0.5 })
        const pHops = numParam('hops', args.hops, { min: 0, max: 2, def: 1 })
        const notes = [pLim.note, pChars.note, pWeight.note, pHops.note].filter(Boolean)
        const res = nebula.bridge({
          ids,
          query,
          mark: true,
          budget: {
            maxItems: pLim.value,
            maxChars: pChars.value,
            minWeight: pWeight.value,
            hops: pHops.value,
          },
        })
        if (!res || !res.items?.length) {
          // [macro-fusion 0.2.44] 原来这里只有一句「种子 N 条、候选 M 条都已读过或在冷却期」，
          // 也在背两意：种子 0 条根本不是「都读过」，是「一条都没在图里找到」——
          // 图还没建起来、id 写错、刚写还没入图，全都落进这句话。四种情况分开说。
          const totalB = nebula.graph?.nodes?.length ?? 0
          const seedsB = res?.stats?.seedCount ?? 0
          const consideredB = res?.stats?.considered ?? 0
          const askedB = ids.length ? `你给的 ${ids.length} 个 id` : `查询「${query}」`
          const whyB =
            totalB === 0
              ? '星图里还没有节点（图是空的），这次 nebula_bridge 等于没算（不是「没有相关记忆」）。等星图建起来（约 12s 一轮巡检）再问一次；记忆本身没受影响。'
              : seedsB === 0
                ? `${askedB}一条都没在图里找到种子——可能是刚写还没入图（约 12s 一轮巡检），也可能 id 不对（裸 id 给前 12 位就够）。先用 memory_search 确认 id 再问。`
                : consideredB === 0
                  ? `有 ${seedsB} 条种子，但邻居都被过滤掉了（已读过 / 冷却期 / 权重低于 min_weight / 归档）。把 min_weight 调低一点，或换一条没读过的种子。`
                  : `候选 ${consideredB} 条，但没有一条进得了预算（可能都在同一工作区、已被 seen 标记，或字符预算太小）。加一点 chars 再试。`
          return ['nebula_bridge：这次没补到东西。', `  ${whyB}`, '这不是「图里没有相关记忆」。', ...notes].join('\n')
        }
        return [
          `nebula_bridge：从 ${res.stats.seedCount} 条种子扩散，候选 ${res.stats.considered} 条，选出 ${res.items.length} 条（${res.stats.chars} 字）`,
          res.text,
          ...notes,
        ].join('\n')
      },
    }),
  )

  ctx.effect(() =>
    ctx.tools.register({
      name: 'nebula_sources',
      description:
        '记忆来源体检 + 接入指南。列出星图现在接了哪些记忆库（meow / 笔记目录 / 任意 SQLite / 外部推送）、各自读到多少条、配置文件在哪、有哪些适配器可用。要接入一个新的记忆插件时先调它，按返回的 hint 填配置即可；改完再调一次确认。',
      parameters: {
        type: 'object',
        properties: {
          verbose: { type: 'boolean', description: '是否列出每个适配器的配置字段说明，默认 false。' },
        },
        required: [],
        additionalProperties: false,
      },
      output: out,
      async execute(args = {}) {
        const r = nebula.sourcesReport ? await nebula.sourcesReport() : null
        if (!r) return '星图引擎还没起来（等宿主重启后生效）。'
        const lines = []
        lines.push(`配置：${r.config.path}${r.config.exists ? '' : '（还没有，可新建）'}${r.config.error ? ' · 读坏了：' + r.config.error : ''}`)
        lines.push(`自动探测：${r.config.autoDetect ? '开' : '关'}`)
        lines.push('')
        // [macro-fusion 0.2.43] 「已接入 0 个来源，共读到 0 条记忆」这句话也背两个意思：
        //   一个是「真的没接」（配置没建 / 探测关着），一个是「接了没读到」（读失败 / 还没扫）。
        //   用户读到第一行的第一反应是「记忆没了」，所以这里要把这次具体是哪一种说出来。
        if (r.live.stores.length === 0) {
          const bad = (r.live.errors || []).map((e) => e.store || e.adapter).filter(Boolean)
          const why = bad.length
            ? `有 ${bad.length} 处读失败（${bad.join(' / ')}）——不是「没有记忆」，是没读到（下面列了原因）。`
            : r.config.exists === false
              ? `配置文件还没建（${r.config.path}）——所以一个来源都没接上。这不等于「记忆没了」。`
              : r.config.autoDetect === false
                ? '自动探测关着（autoDetect: false），也没有手写来源——是「没接」，不是「没记忆」。'
                : '配置在、自动探测也开着，但这次一个来源都没扫到——可能刚启动还没扫完（一轮约 12s），过一会儿再问一次；这不等于「记忆没了」。'
          lines.push('已接入 0 个来源，共读到 0 条记忆——这句有两种意思：')
          lines.push(`  ${why}`)
        } else {
          lines.push(`已接入 ${r.live.stores.length} 个来源，共读到 ${r.live.nodes} 条记忆：`)
          for (const s of r.live.stores) {
            lines.push(`- [${s.adapter}] ${s.title} · ${s.size ? Math.round(s.size / 1024) + 'KB' : '—'}${s.hasSessions ? ' · 有会话账本' : ''}`)
            lines.push(`  ${s.path}`)
          }
          // [macro-fusion 0.2.43] 来源接上了但 0 条：空库与路径写错长得一样，得说一句。
          if (r.live.nodes === 0) lines.push('  （来源接上了，但一条记忆都没读到：可能是库真是空的，也可能是路径指错了。）')
        }
        if (r.graph) {
          lines.push('')
          lines.push(`星图：${r.graph.nodes} 节点 / ${r.graph.edges} 边 / ${r.graph.workspaces} 工作区 / ${r.graph.sessions} 会话`)
        }
        if (r.live.errors?.length) {
          lines.push('')
          lines.push('读取失败：')
          for (const e of r.live.errors) lines.push(`- ${e.store || e.adapter}：${e.error}`)
        }
        lines.push('')
        lines.push('可用适配器：')
        for (const a of r.adapters) {
          lines.push(`- ${a.id}（${a.kind}）${a.name}：${a.description}`)
          if (args.verbose !== false && a.config && Object.keys(a.config).length > 0) {
            for (const [k, v] of Object.entries(a.config)) lines.push(`    ${k}: ${v}`)
          }
        }
        lines.push('')
        lines.push(r.hint)
        return lines.join('\n')
      },
    }),
  )

  ctx.effect(() =>
    ctx.tools.register({
      name: 'nebula_ingest',
      description:
        '把外部记忆推入星图。给「记忆不在本地落盘」的服务用（远端 hindsight / openviking / 或任何 API-only 记忆插件）：把条目推过来，它们就进同一张图，和 meow 的记忆一起参与关联与注入。同 uid 后写覆盖，重复推送不会长重影。',
      parameters: {
        type: 'object',
        properties: {
          provider: { type: 'string', description: '来源名，例如 hindsight / openviking / my-memory。' },
          items: {
            type: 'array',
            description: '记忆条目。至少给 title 或 content。',
            items: {
              type: 'object',
              properties: {
                uid: { type: 'string', description: '稳定 id；不给就按内容哈希。' },
                title: { type: 'string' },
                content: { type: 'string' },
                level: { type: 'string', description: 'soul / user / project / fact / lesson / topic / rules / note' },
                keywords: { type: 'array', items: { type: 'string' } },
                project: { type: 'string' },
                importance: { type: 'number' },
                status: { type: 'string' },
                ws: { type: 'string', description: '归属工作区名（展示用）。' },
                createdAt: { type: 'number', description: '毫秒时间戳。' },
              },
              additionalProperties: true,
            },
          },
        },
        required: ['provider', 'items'],
        additionalProperties: false,
      },
      output: out,
      async execute(args = {}) {
        const provider = String(args.provider || '').trim()
        const items = Array.isArray(args.items) ? args.items : []
        if (!provider) return 'nebula_ingest 需要 provider。'
        if (items.length === 0) return 'nebula_ingest 需要至少一条 items。'
        const res = await nebula.ingest(provider, items)
        if (res.error) return `没有写成任何一条：${res.error}`
        return [
          `已推入 ${res.written} 条 → ${res.file}` + (res.note ? `（${res.note}）` : ''),
          res.graph ? `星图现在是 ${res.graph.nodes} 节点 / ${res.graph.edges} 边` : '重建未完成（下次请求时生效）',
        ].join('\n')
      },
    }),
  )

  // ---------- 常驻注入：只放一段稳定规则 ----------
  //
  // 这里原来每轮会额外注入「本会话该被连带读出的邻居」：读 meow 账本当种子 → bridge 沿星图
  // 扩散 → 挑 ≤maxItems 条、≤maxChars 字，最多 maxRounds 批。
  //
  // 2026-11-18 移除这段自动注入，三条理由：
  //   1. 缓存：system prompt 在请求最前面，它一变，它后面整段对话历史都从前缀缓存里掉出来
  //      重新 prefill —— 代价 ≈ 当前上下文 token 数，而换回来的信息只有几百字符（约 36:1）。
  //      而且第 2 批会顶掉第 1 批，模型上一轮刚看到的邻居下一轮就没了。
  //   2. 位置：注入不是唯一出口。真要邻居的时候，模型正在查记忆，让它调工具拿更准。
  //   3. 可控：自动注入的收益无法度量，成本却每轮都在付。
  //
  // 邻域能力没有删，只是改成按需：nebula_recall(memory_ids=[…]) 与 nebula_bridge(…) 仍在，
  // 走同一套 bridge 逻辑，结果落在工具返回里（会话尾部，不伤前缀缓存）。
  ctx.effect(() =>
    ctx.systemPrompt.context({
      name: 'memory-nebula:rules',
      order: 960,
      text: () => RULE,
    }),
  )

  log(`宏记忆 · 星图已启动：${live.instance?.stores?.length ?? 0} 个记忆库候选`)
}
