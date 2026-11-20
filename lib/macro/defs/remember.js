import { LEVELS, PROJECT_SUBCATEGORIES, TEXT_OUT, pick } from '../shared.js'
import { LINKS_SCHEMA } from '../linkflow.js'
import { cardTitle } from '../panel.js'

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
async function markSuperseded({ flow, exec, ids, extra, newId, newHead }) {
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
  return [...head, ...lines, ...tail].join('\n')
}

export function createRemember({ flow }) {
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
      const linked = await flow.applyLinks(newId, args.links, exec, 'remember')
      if (linked) out.push(linked)
      return out.join('\n\n')
    },
    presentCall(args) {
      return { card: 'generic', title: cardTitle('写入记忆', args.project), kind: 'write' }
    },
  }
}
