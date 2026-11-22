import { LEVELS, PROJECT_SUBCATEGORIES, TEXT_OUT, pick } from '../shared.js'
import { LINKS_SCHEMA } from '../linkflow.js'
import { cardTitle } from '../panel.js'
import { supersedeMode, supersedeAdvice, supersedeSuggestNote, supersedeApplyLead } from '../supersede.js'

// [macro-fusion 0.2.117] 取代关系：写新的同时，把被它顶掉的旧的标成 stale 并在正文留一句
// 「（已被取代：<新 id>「<新内容开头>」，<日期>）」。
//
// 为什么要有这个口子：dream 的冲突块从 0.2.114 起每轮都在说「取新的、旧的标『（已被取代：…）』或设
// stale」，但工具面里根本没有一步能同时做到——只能先 remember 再逐条 update，中间忘一步就变成两条并排
// 活着。主人对「遗忘」的态度也很明确：不删，只矫正。所以这里做的是**改写 + 降格**，不是删除：
// 旧条目仍在库里、仍可 memory_read、正文里指得到新的那条。
const SUPERSEDE_MAX = 5
const SUPERSEDE_MARK = '（已被取代：'
const SUPERSEDE_HEAD = 24

/** 把 caller 给的 supersedes 归一：去空、去重、限条数，并把「超出的条数」原样报回去（不许静默截断）。 */
function supersedeAskedOf(raw) {
  if (raw === undefined || raw === null) return { ids: [], extra: [] }
  const list = Array.isArray(raw) ? raw : [raw]
  const asked = []
  for (const one of list) {
    if (typeof one !== 'string') continue
    const id = one.trim()
    if (id.length === 0) continue
    if (!asked.includes(id)) asked.push(id)
  }
  return { ids: asked.slice(0, SUPERSEDE_MAX), extra: asked.slice(SUPERSEDE_MAX) }
}

function dayStamp(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`
}

/** 那半句取代话：只写「谁顶掉的、什么时候」，不写判决——正文归 caller，我们只加一句事实。 */
function supersedeLineOf({ newId, newHead, at }) {
  const head = String(newHead ?? '').replace(/\s+/g, ' ').trim().slice(0, SUPERSEDE_HEAD)
  const who = String(newId).slice(0, 8)
  return `${SUPERSEDE_MARK}${who}${head ? `「${head}」` : ''}，${dayStamp(at)}）`
}

function shortId(id) {
  return String(id ?? '').slice(0, 8)
}

// [macro-fusion 0.2.117] 短 id 的尴尬：meow 的 id 形如 `0mwowj2h2-<32 hex>`，前缀是时间编码——
// **同一秒里先后写下的两条，前 8 位会一模一样**。于是「拿刚记住的那条 id 前 8 位去取代它的前一条」
// 这个最自然的用法，恰好会把新条目自己也命中。memory_read 这时回 ambiguous，候选 id 就在它的
// candidates 文字里：把新条目排除掉之后如果只剩一条，那不是「替你挑」，是**排除法**。
const CANDIDATE_ID = /0m[0-9a-z]+-[0-9a-f]{32}/g

function candidateIdsOf(v) {
  const out = []
  for (const one of String(v?.candidates ?? '').match(CANDIDATE_ID) ?? []) if (!out.includes(one)) out.push(one)
  return out
}

/** 歧义回执里到底命中几条：优先数候选 id，捞不到 id 时退回它自己那句「命中了 N 条」。 */
function ambiguousCountOf(v, ids) {
  if (ids.length > 0) return ids.length
  const m = /(\d+)\s*条/.exec(String(v?.note ?? ''))
  return m ? Number(m[1]) : 0
}

/**
 * 逐条把旧条目改写成「已被取代」。
 *
 * 每一种失败都必须单独说一句——尤其「没找到」和「没动它」：这两件事在回执里长得像是成功，
 * 而它们恰恰是「旧条目还活着、还占着召回位」的那种状态。
 */
// ── 写入端巩固（0.4.0 P2 / PLAN-0.4 §5 P2）────────────────────────────────────────────
//
// 为什么不是「同 project 同一天写到第 4 条就触发」：那是数数，不是信号。一天里写四条互不相干的
// 事也会触发，而同一件事连写三条（最该巩固的那种）反而不触发。按 CLS 的「巩固触发」改写为
// 三条件同时成立——
//   ① 重复模式：同 project 内、keywords 交集 ≥ 2 的条目在近 7 天里 ≥ 3 条（同一模式反复暴露）；
//   ② 慢路有空位：该 project 近 7 天语义层（rules / fact）少于 cap 条才准新增；满了应该**并进
//      已有的那条**（memory_update append），而不是再造一条同义摘要；
//   ③ 未巩固：这批条目正文里还没有巩固句（CONSOLIDATE_MARK），防同一批反复触发。
//
// 三档：off（一个字都不变）/ suggest（只贴材料，库里一个字没动）/ write（才自动落那条摘要）。
// 配置写坏一律当 off——退到最保守那一档。
const CONSOLIDATE_MAX = 3
const CONSOLIDATE_DAYS = 7
const CONSOLIDATE_MIN_REPEAT = 3
const CONSOLIDATE_MIN_SHARE = 2
const CONSOLIDATE_SEMANTIC_CAP = 8
const CONSOLIDATE_MARK = '（已巩固进：'
const CONSOLIDATE_HEAD = 40
const CONSOLIDATE_ROWS = 20
const CONSOLIDATE_CHARS = 300
const CONSOLIDATE_LEVELS = ['rules', 'fact']

export function consolidateMode(config = {}) {
  const raw = config?.consolidate
  // 没配就是默认那一档（suggest）——与 index.js 的 MACRO_DEFAULTS 对齐，免得「默认 suggest」只在
  // schema 层成立、函数层回 off，两处说法打架。唯独显式写错才退到 off。
  if (raw === undefined || raw === null) return 'suggest'
  const mode = typeof raw === 'string' ? raw.trim().toLowerCase() : ''
  return mode === 'suggest' || mode === 'write' || mode === 'off' ? mode : 'off'
}

function kwOf(list) {
  const out = new Set()
  for (const one of Array.isArray(list) ? list : []) {
    const word = String(one).trim().toLowerCase()
    if (word !== '') out.add(word)
  }
  return out
}

function headOf(text, n = CONSOLIDATE_HEAD) {
  return String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, n)
}

/**
 * 纯函数：把检索回执里的 hits 变成巩固信号。不起 IO、不读时钟，判据可以逐条钉。
 * `cap = 0` 表示不限（永远有空位）。
 */
export function consolidateSignals({ hits = [], semanticHits = [], newId = '', keywords = [], cap = CONSOLIDATE_SEMANTIC_CAP } = {}) {
  const mine = kwOf(keywords)
  const rows = []
  for (const hit of Array.isArray(hits) ? hits : []) {
    const id = String(hit?.id ?? '')
    if (id === '' || id === String(newId ?? '')) continue
    const shared = [...kwOf(hit?.keywords)].filter((word) => mine.has(word))
    if (shared.length < CONSOLIDATE_MIN_SHARE) continue
    const body = String(hit?.content ?? '')
    rows.push({
      id,
      id8: shortId(id),
      level: String(hit?.level ?? ''),
      day: String(hit?.created_at ?? hit?.createdAt ?? '').slice(0, 10),
      head: headOf(body),
      body,
      consolidated: body.includes(CONSOLIDATE_MARK),
      shared,
    })
  }
  const semanticCount = Array.isArray(semanticHits) ? semanticHits.length : 0
  const repeated = rows.length >= CONSOLIDATE_MIN_REPEAT
  const room = Number(cap) === 0 || semanticCount < Number(cap)
  const pending = rows.some((one) => !one.consolidated)
  const kind = repeated && pending ? (room ? 'fire' : 'merge') : 'none'
  return { rows, repeated, room, pending, semanticCount, cap: Number(cap), kind, fire: kind === 'fire' }
}

/** write 态落什么：规则版摘要。事件日期必须在正文开头——temporal 的收益全来自这里。 */
export function consolidateSummary({ rows = [], project = '', keywords = [], at = new Date() } = {}) {
  const words = [...kwOf(keywords)].slice(0, 6).join('、')
  const body = rows.slice(0, CONSOLIDATE_MAX).map((one) => `- ${one.head}`).join('\n')
  const head = `${dayStamp(at)} · 巩固（${String(project || '全局').trim() || '全局'}）${words ? `：${words}` : ''}`
  return `${head}\n${body}`.slice(0, CONSOLIDATE_CHARS)
}

/** 巩固句：改动最小的一句话，只写「并进哪条、什么时候」，不写判决（与取代句同款形状）。 */
export function consolidateLineOf({ newId, newHead, at }) {
  const head = headOf(newHead, SUPERSEDE_HEAD)
  return `${CONSOLIDATE_MARK}${shortId(newId)}${head ? `「${head}」` : ''}，${dayStamp(at)}）`
}

/** suggest 那一段材料：只有「该做什么」和现成的调用形状，不含任何已落库的声明。 */
function consolidateNote({ signal, project, keywords }) {
  if (!signal || signal.kind === 'none') return ''
  const rows = signal.rows.slice(0, CONSOLIDATE_MAX)
  const list = rows.map((one) => `${one.id8}（${one.level || '—'}，${one.day || '日期未知'}）「${one.head}」`).join('\n  ')
  if (signal.kind === 'merge') {
    return [
      `— 该并条，不是再加一条 —`,
      `同 project 近 ${CONSOLIDATE_DAYS} 天里已经有 ${signal.semanticCount} 条语义层（rules/fact），到上限 ${signal.cap} 了。再写一条同义摘要只会让这一层更稀。`,
      `这批：\n  ${list}`,
      `做法：memory_search 找到承载这件事的那条语义条目，用 memory_update append 把这次的增量补进去（不新增条目）。`,
    ].join('\n')
  }
  const ids = rows.map((one) => `'${one.id8}'`).join(', ')
  const words = [...kwOf(keywords)].slice(0, 6).join('、')
  return [
    `— 同一件事已经写了 ${signal.rows.length} 条，该巩固了 —`,
    `这批：\n  ${list}`,
    `如果它们讲的是同一件事：写一条 topic（事件日期放正文开头），再用 supersedes 指向上面这几条（旧条不删，只加一句「已巩固进」）。`,
    `  memory_remember(content: '${dayStamp(new Date())} · 谁 / 何时 / 为什么 / 结论', level: 'topic', project: '${String(project || '全局').trim() || '全局'}', keywords: [${words ? `'${words}'` : ''}], importance: 2, supersedes: [${ids}])`,
    `（这段只是提示：库里这一个字都没动。要自动落，配置项 consolidate 设成 write。）`,
  ].join('\n')
}

async function consolidateAfterWrite({ flow, exec, mode, newId, project, keywords }) {
  const words = [...kwOf(keywords)].join(' ')
  if (words === '') return ''
  // internal: true —— 这两枪是我自己为了判「该不该巩固」打的，不是端给用户看的结果。
  // 不关记账的话，写完一条紧接着问 memory_search({mode:'similar', id}) 会得到「候选一条都没有」
  // （同话题的这批刚被记进 seen），而且 bumpHit 会把 hit_count 抬起来污染通胀体检。
  const base = { query: words, project, k: CONSOLIDATE_ROWS, days: CONSOLIDATE_DAYS, status: 'active', content_max: 0, internal: true }
  const got = await flow.tryCall('memory_search', base, exec, '巩固检查：同话题条目')
  if (!got.value) return ''
  const hits = Array.isArray(got.value.hits) ? got.value.hits : []
  // 语义层条数：检索没有 importance 过滤，所以这里数的是 rules/fact 全部（偏严＝更容易判「有空位」，
  // 但绝不会把一个塞满的层看成空的）。
  const sem = await flow.tryCall('memory_search', { ...base, level: CONSOLIDATE_LEVELS.join(','), k: CONSOLIDATE_ROWS }, exec, '巩固检查：语义层')
  const signal = consolidateSignals({ hits, semanticHits: Array.isArray(sem.value?.hits) ? sem.value.hits : [], newId, keywords })
  const note = consolidateNote({ signal, project, keywords })
  if (note === '') return ''
  if (mode !== 'write' || signal.kind !== 'fire') return note
  // merge 态即使配了 write 也只回提示：语义层满了该并进已有那条，但「哪条承载这件事」不是规则能判的，
  // 自动挑一条并进去比不并更糟（会把两件事焊在一起）。
  // write：真落一条 topic，再给被合并的条目加一句巩固句（status 不动——巩固不是作废）。
  const summary = consolidateSummary({ rows: signal.rows, project, keywords })
  const wrote = await flow.tryCall('memory_remember', { content: summary, level: 'topic', project, keywords: [...kwOf(keywords)].slice(0, 8), importance: 2 }, exec, '落巩固摘要')
  const newOne = String(wrote.value?.id ?? '')
  if (newOne === '') return `${note}\n\n（这条提示没能自动落库：上游没回新条目 id。按上面的调用形状手动写一次即可。）`
  const lines = [`已自动落一条巩固摘要 ${shortId(newOne)}：${summary.split('\n')[0]}`]
  for (const one of signal.rows.slice(0, CONSOLIDATE_MAX)) {
    if (one.consolidated) {
      lines.push(`- ${one.id8} 正文里已经有一句「已巩固进」，没重复追加`)
      continue
    }
    const next = `${one.body}${one.body.endsWith('\n') || one.body.length === 0 ? '' : ' '}${consolidateLineOf({ newId: newOne, newHead: summary, at: new Date() })}`
    const patched = await flow.tryCall('memory_update', { id: one.id, content: next }, exec, '加巩固句')
    lines.push(
      patched.value?.ok === true
        ? `- ${one.id8} 正文末尾加了一句「已巩固进」`
        : `- ${one.id8} 没写进库（它还是原样，别当成已经并进去了）`,
    )
  }
  return `${note}\n\n${lines.join('\n')}`
}

async function markSuperseded({ flow, exec, ids, extra, newId, newHead, lead = '' }) {
  const lines = []
  for (const asked of ids) {
    // 「这条是不是就是刚写的那条」不能靠字符串前缀先判——同一秒写下的两条 id 前 8 位一模一样，
    // 先判就会把真正要处置的旧条目也当自己跳过（0.2.117 探针就是这么红的）。先读，读出来再判。
    const got = await flow.tryCall('memory_read', { id: asked }, exec, '读被取代的旧条目')
    let v = got.value
    let via = ''
    if (v && v.ambiguous === true) {
      const ids = candidateIdsOf(v)
      const others = ids.filter((one) => one !== newId)
      const n = ambiguousCountOf(v, ids)
      if (ids.length > 0 && others.length === 1) {
        const again = await flow.tryCall('memory_read', { id: others[0] }, exec, '读被取代的旧条目')
        if (again.value?.id === others[0]) {
          v = again.value
          via = `短 id ${asked} 先把刚写的 ${shortId(newId)} 也命中了（一共 ${n} 条），把它排除后只剩 ${shortId(others[0])}——按这条办的`
        }
      }
      if (!via) {
        lines.push(`- ${asked} 短 id 命中 ${n} 条，没替你挑一条——换成完整 id 再来一次，这 ${n} 条都还没动`)
        continue
      }
    }
    if (v && v.id === newId) {
      lines.push(`- ${shortId(newId)} 就是这次刚写的那一条，跳过了（一条记忆不能取代自己）`)
      continue
    }
    if (!v || v.found === false || !v.id) {
      lines.push(`- ${asked} 没找到（可能已归档或删除）——它没有被改`)
      continue
    }
    const id8 = shortId(v.id)
    const status = String(v.status ?? 'active')
    if (status === 'archived') {
      lines.push(`- ${id8}（${String(v.level ?? '')}）已经是 archived（作废），没动它`)
      continue
    }
    const oldText = String(v.content ?? '')
    if (oldText.includes(SUPERSEDE_MARK)) {
      lines.push(`- ${id8}（${String(v.level ?? '')}）正文里已经有一句「已被取代」，没重复追加`)
      continue
    }
    const next = `${oldText}${oldText.endsWith('\n') || oldText.length === 0 ? '' : ' '}${supersedeLineOf({ newId, newHead, at: new Date() })}`
    const patched = await flow.tryCall('memory_update', { id: v.id, content: next, status: 'stale' }, exec, '标为已被取代')
    const ok = patched.value?.ok === true
    if (!ok) {
      const why = String(patched.text ?? '').trim()
      lines.push(`- ${id8}（${String(v.level ?? '')}）找到了但没写进库${why ? `：${why.split('\n')[0]}` : ''}——它还是原样，别当成已经处置`)
      continue
    }
    lines.push(
      status === 'stale'
        ? `- ${id8}（${String(v.level ?? '')}）本来就是 stale，只补了一句「已被取代」`
        : `- ${id8}（${String(v.level ?? '')}）已标 stale，正文末尾补了一句「已被取代」`,
    )
    // 是靠排除法认出来的时候，必须把「为什么是这条」写出来——否则回执读起来像我替你挑了一条。
    if (via) lines.push(`  · ${via}`)
  }
  const head = [`取代（新写的 ${shortId(newId)} 接管这些条目的位置；旧条目一条都没删，只是不再算「在用」）：`]
  const tail = []
  if (extra.length > 0) {
    tail.push(`超出 ${SUPERSEDE_MAX} 条上限的 ${extra.length} 条这次没有处理：${extra.join('、')}——要一起处置就分两次调。`)
  }
  tail.push('反悔办法：旧条目都还在库里，memory_update 把 status 改回 active、再删掉那句取代话就恢复原样。')
  const out = [...(lead ? [lead] : []), ...head, ...lines, ...tail]
  return out.join('\n')
}

export function createRemember({ flow, config = {} }) {
  return {
    name: 'memory_remember',
    description:
      '把一条记忆写进宏记忆库（7 层 level + project 六子类）。与已有条目高度重复会自动合并；可用 links 顺手把关联固化进星图；被这次写入顶掉的旧条目用 supersedes 列出来，会标 stale 并在正文留下取代句（不删除）。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        content: { type: 'string', description: '要记住的内容。fact/lesson 一句话（≤60 字），topic ≤300 字；涉及用户原话必须保留措辞。' },
        project: { type: 'string', description: "归属：'全局' 或项目名；同时属于多个项目用英文逗号分隔。" },
        keywords: { type: 'array', items: { type: 'string' }, description: '8–13 个检索关键词，按「用户提到哪些词时该召回它」反向想。' },
        importance: { type: 'integer', description: '4=红线致命 3=主人强调/全局适用 2=抽象决策 1=琐碎' },
        level: { type: 'string', enum: LEVELS, description: '记忆层级，默认 fact。' },
        subcategory: { type: 'string', enum: PROJECT_SUBCATEGORIES, description: 'level=project 专用子类。' },
        goal: { type: 'string', description: 'topic 的目标句（这个窗口要把什么事做成）。' },
        corrected: { type: 'boolean', description: '是否来自主人纠正（level=lesson 用）。' },
        // [macro-fusion 0.2.87] 合并以前是「拿这次的参数把旧条目整条盖掉」：关键词被换掉、归属被搬走、
        // 更短的内容把旧细节吃掉。现在合并只做加法（关键词并集 / 归属不动 / 变短默认不换），
        // 这个开关是「我确实要压缩」的逃生口——不给这个口子，保护就变成了不能更新。
        overwrite: {
          type: 'boolean',
          description: '合并时是否允许用这次的内容覆盖旧内容（默认 false）。默认只在「新内容更短且不是逐字同一句」时拒换；确实要压缩就传 true。',
        },
        // [macro-fusion 0.2.117] 取代不是删除：旧条目留着，只是降格成 stale 并在正文里指向新的那条。
        supersedes: {
          type: 'array',
          items: { type: 'string' },
          description: '这次写入顶掉的旧条目 id（最多 5 条，短 id 前 8 位也行）。被列出的条目会标 stale 并在正文末尾加一句「（已被取代：<新 id>「<新内容开头>」，<日期>）」——不删除、可 memory_read、可反悔。',
        },
        links: LINKS_SCHEMA,
      },
      required: ['content', 'project', 'keywords', 'importance'],
    },
    output: TEXT_OUT,
    async execute(args, exec) {
      const payload = pick(args, ['content', 'level', 'project', 'subcategory', 'goal', 'importance', 'corrected', 'keywords', 'overwrite'])
      const main = await flow.call('memory_remember', payload, exec)
      // [macro-fusion 0.2.50] 上游回执空掉时不能把「没写进去」当成功：这里先看一眼有没有字。
      const said = String(main.text ?? '').trim()
      const sup = supersedeAskedOf(args.supersedes)
      if (said.length === 0) {
        const skip =
          sup.ids.length > 0 || sup.extra.length > 0
            ? '\n\n取代这次一条都没做：新条目连 id 都没拿到，不能把旧的指向一个不存在的新条目。'
            : ''
        return `写入这次没有任何回执（既没说写进了哪一层，也没说为什么没写）——这不是「已经记住了」：先 memory_search 查一眼这条内容在不在库里，再决定要不要重试。${skip}`
      }
      const newId = main.value?.id
      const out = [said]
      if (sup.ids.length > 0 || sup.extra.length > 0) {
        if (!newId) {
          out.push('取代这次一条都没做：新条目没拿到 id（上游只回了文字），没有「新 id」可写进取代句。先用 memory_search 找到这条的新 id，再逐条 memory_update。')
        } else {
          out.push(
            await markSuperseded({
              flow,
              exec,
              ids: sup.ids,
              extra: sup.extra,
              newId,
              newHead: typeof args.content === 'string' ? args.content : '',
            }),
          )
        }
      }
      // [macro-fusion 0.4.0] P3：人没点名要取代时，替人看一眼「库里有没有同一件事的旧说法」。
      // 默认 suggest 只把建议端出来（一个字不动库）；apply 才真走 markSuperseded——两条路复用同一个处置
      // 通道，免得「自动取代」和「人点名的取代」出现两套行为。off 连那一枪检索都不打。
      const autoMode = supersedeMode(config)
      if (autoMode !== 'off' && newId) {
        const cands = await supersedeAdvice({
          flow,
          exec,
          content: typeof args.content === 'string' ? args.content : '',
          project: args.project,
          level: args.level,
          keywords: args.keywords,
          newId,
          // 人已经点名要取代的那几条不再重复建议：他刚刚已经处置过了。
          skipIds: [...sup.ids, ...sup.extra],
        })
        if (cands.length > 0) {
          if (autoMode === 'apply') {
            out.push(
              await markSuperseded({
                flow,
                exec,
                ids: cands.map((one) => one.id),
                extra: [],
                newId,
                newHead: typeof args.content === 'string' ? args.content : '',
                lead: supersedeApplyLead(cands),
              }),
            )
          } else {
            out.push(supersedeSuggestNote(cands))
          }
        }
      }
      const linked = await flow.applyLinks(newId, args.links, exec, 'remember')
      if (linked) out.push(linked)
      // 巩固放在最后：此时新条已落库、id 已拿到，而且取代已经做完——巩固材料里不该再出现刚被顶掉的那条。
      const mode = consolidateMode(config)
      if (mode !== 'off' && newId) {
        const note = await consolidateAfterWrite({ flow, exec, mode, newId, project: args.project, keywords: args.keywords })
        if (note) out.push(note)
      }
      return out.join('\n\n')
    },
    presentCall(args) {
      return { card: 'generic', title: cardTitle('写入记忆', args.project), kind: 'write' }
    },
  }
}
