/**
 * `memory_project`：项目全景，**按预算列**（0.6.63）。
 *
 * 为什么要有这一支：真库读数（cost.jsonl，30 次调用）显示这个工具平均一次回执
 * **11,581 字**，是全部工具里最大的一支——比命中注入一整轮（~550 字）大二十倍。
 * 全景本身有价值（它就是「这个项目到底记了什么」的目录），但**一次把所有条目的全文
 * 全端出来**是浪费：调用方十次有九次只是想确认「有没有这条、在哪一组」。
 *
 * 三条边界（与注入预算那套同一个口径，见 DESIGN §注入预算）：
 *   1. **默认不砍能力**：`projectMaxChars` 默认 3000，回执本来就短的（小项目）**逐字节
 *      原样返回**——压缩只在「原样超过上限」时发生，老路径一个字节不动。
 *   2. **只压正文，不压身份**：每条都留完整 id、层、首句，要全文用 `memory_read(id)`；
 *      分组标题与条数一条不丢（「有 12 条决策，列了 4 条」必须说出来）。
 *   3. **砍了必须自己说出来**：尾巴报「原文多少字 → 这里多少字、还有几条没列」，
 *      并给出三条出口：`budget=0` 看原样全量、`group=<组>` 只看一组、`memory_read(id)` 取全文。
 *
 * 参数都是可选的，全部省略时行为 = 「默认上限 3000 的压缩视图」，与 0.6.62 的差别只在
 * 大项目的回执长度上。
 */
import { TEXT_OUT } from '../shared.js'
import { cardTitle } from '../panel.js'
import { workspaceOfExec } from '../dreamledger.js'
import { projectAnswerKind } from '../contract.js'
import * as Meow from '../../../vendor/meow-memory/lib/index.js'

/**
 * `memory_project` 一次回执的默认字符上限（0.6.63）。
 *
 * 标定来自真库账本：这个工具平均一次回执 11,581 字（cost.jsonl，30 次调用），
 * 比命中注入一整轮（~550 字）大二十倍。3000 字大约装得下 30 条目录行
 * （每条 id + 层 + 60 字首句 ≈ 85 字），对一个项目的「有什么」够用了；
 * 大项目要全量就给 `budget=0`，只看一组给 `group=`。
 */
export const PROJECT_MAX_CHARS = 3000

/** 组的顺序＝面板顺序：准则在项目层之外，其余是 project 的六个子类。 */
const GROUP_ORDER = ['rules', 'overview', 'structure', 'decisions', 'quotes', 'ops', 'todo']/** 已完结待办单独一档（与引擎 `project.todoDone` 同义），只在列 todo 时跟在后面。 */
const DONE_GROUP = 'done'
const GROUP_LABEL = {
  rules: '准则',
  overview: '概览',
  structure: '结构',
  decisions: '决策',
  quotes: '原话',
  ops: '运维',
  todo: '待办',
  [DONE_GROUP]: '已完结待办',
}
/** 已完结待办最多列这么多条（与引擎 `buildProjectSection` 的 5 条一致）。 */
const DONE_MAX = 5
/** 每条留多少字的首句：够认出是哪条，又不至于把半截正文卖成全貌。 */
const ROW_HEAD = 60
/** 尾巴的预留：压了多少字、还有几条没列、三条出口——排正文时先把它扣掉。 */
const TAIL_RESERVE = 200
/** 上限低于这个数就不再叫「压缩视图」了：至少留得下一行标题 + 两三条目录。 */
const MIN_CAP = 160

/** 项目名按逗号拆（与引擎 `projectList` 同一个口径：一条记忆可挂多个项目）。 */
function projectList(raw) {
  return String(raw ?? '')
    .split(',')
    .map((one) => one.trim())
    .filter((one) => one !== '')
}

/** 首句 + 截断：换行压成空格，句末标点之后的内容不进目录（全文有 id 可取）。 */
function headOf(content) {
  const flat = String(content ?? '')
    .replace(/\s+/g, ' ')
    .trim()
  if (flat === '') return '（正文为空）'
  const m = flat.match(/^[\s\S]*?[。！？；!?;]/)
  const first = m === null ? flat : m[0]
  return first.length <= ROW_HEAD ? first : `${first.slice(0, ROW_HEAD - 1)}…`
}

/**
 * 从库里取这个项目的条目（读失败返回 null，调用方退回引擎原文——压缩绝不许把内容弄丢）。
 */
function rowsOf(workspace, dir, project) {
  if (workspace === '') return null
  try {
    const db = Meow.getDb(workspace, dir)
    const projectRows = db.list('project', {}) ?? []
    const rulesRows = db.list('rules', {}) ?? []
    const mine = (r) => projectList(r.project).includes(project)
    const active = projectRows.filter((r) => mine(r) && r.status === 'active')
    const done = projectRows
      .filter((r) => mine(r) && r.subcategory === 'todo' && r.status === 'stale' && Number.isFinite(Number(r.updated_at)))
      .sort((a, b) => Number(b.updated_at) - Number(a.updated_at))
      .slice(0, DONE_MAX)
    const rules = rulesRows.filter((r) => mine(r) && r.status === 'active')
    const groups = new Map()
    groups.set('rules', rules.map((r) => ({ row: r, level: 'rules' })))
    for (const sub of GROUP_ORDER) {
      if (sub === 'rules') continue
      groups.set(
        sub,
        active.filter((r) => (r.subcategory ?? 'overview') === sub).map((r) => ({ row: r, level: 'project' })),
      )
    }
    groups.set(
      DONE_GROUP,
      done.map((r) => ({ row: r, level: 'project' })),
    )
    return groups
  } catch {
    return null
  }
}

/**
 * 压缩视图：分组目录 + 逐条首句，按 cap 装。
 *
 * 返回值故意不带 `text` 以外的状态：调用方只要「是不是还能原样给」这一个判断。
 */
export function compactProject({ project, groups, cap }) {
  const limit = Math.max(MIN_CAP, Math.floor(cap))
  const order = [...GROUP_ORDER, DONE_GROUP]
  const total = order.reduce((a, key) => a + (groups.get(key)?.length ?? 0), 0)
  const head = `【${project}】全景目录`
  const lines = [head]
  let used = head.length + 1
  let listed = 0
  let skipped = 0
  for (const key of order) {
    const list = groups.get(key) ?? []
    if (list.length === 0) continue
    const title = `§ ${GROUP_LABEL[key]} ${list.length} 条`
    let titleShown = false
    for (const one of list) {
      const id = String(one.row.id ?? '')
      const line = `- [${id}] ${one.level} ${headOf(one.row.content)}`
      // 尾巴先扣：宁可少列一条，也不许「说好 3000 实际 3200」。
      if (used + line.length + 1 + TAIL_RESERVE > limit) {
        skipped += 1
        continue
      }
      if (!titleShown) {
        lines.push(title)
        used += title.length + 1
        titleShown = true
      }
      lines.push(line)
      used += line.length + 1
      listed += 1
    }
    if (!titleShown) skipped += list.length
  }
  if (listed === 0) {
    // 一条都装不下的极小上限：只给「有多少条、怎么看」，不假装这是全景。
    return { text: `${head}\n共 ${total} 条，上限 ${limit} 字连一条目录都排不下——给更大的 budget，或按 group=<${GROUP_ORDER.join('|')}> 一次看一组。`, listed: 0, total }
  }
  const cuts = skipped > 0 ? `还有 ${skipped} 条没列（上限 ${limit} 字）。` : ''
  const tail =
    `${cuts}原文 ${total} 条都在这儿记着：全量看给 budget=0，只看一组给 group=<${GROUP_ORDER.join('|')}>，` +
    `某条全文用 memory_read("它的 id")。`
  return { text: [...lines, tail].join('\n'), listed, total }
}

export function createProject({ flow, config = {}, meowDir = () => '.dsh-meow' }) {
  return {
    name: 'memory_project',
    description:
      '看某个项目的全景记忆：overview/structure/decisions/quotes/ops/todo 分组（已完结的 todo 单独列）。默认给「目录 + 每条首句」的压缩视图，按 projectMaxChars 收紧；budget=0 看原样全量，group 只看一组，正文用 memory_read(id) 取。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        project: { type: 'string', description: '项目名。' },
        group: {
          type: 'string',
          enum: GROUP_ORDER,
          description: '只看这一组（rules / overview / structure / decisions / quotes / ops / todo）。',
        },
        limit: {
          type: 'integer',
          description: '每组最多列几条（默认不限，只受 budget 约束）。',
        },
        budget: {
          type: 'integer',
          description: '这次回执的字符上限；0 = 原样全量（旧行为）；不给 = 用设置里的 projectMaxChars。',
        },
      },
      required: ['project'],
    },
    output: TEXT_OUT,
    async execute(args, exec) {
      const project = String(args.project ?? '').trim()
      const r = await flow.call('memory_project', { project }, exec)
      const full = String(r.text ?? '')
      // 「名字对不上 / 别的层还有 / 真没有」这三类回执是**结论**，不是目录：
      // 它们本来就只有一两句，压缩只会把话说不清（0.2.47 花了整段才把三种情况分开）。
      if (full.length === 0 || projectAnswerKind(full) !== 'ok') return full
      const raw = Number.isFinite(args.budget) ? Math.floor(args.budget) : NaN
      const cap = Number.isFinite(raw) ? raw : Number(config.projectMaxChars ?? 0)
      if (!(cap > 0) || full.length <= cap) return full
      const groups = rowsOf(workspaceOfExec(exec), typeof meowDir === 'function' ? meowDir() : '.dsh-meow', project)
      if (groups === null) return full
      const want = typeof args.group === 'string' ? args.group.trim() : ''
      let picked = groups
      if (want !== '') {
        const keep = [...GROUP_ORDER, DONE_GROUP].includes(want) ? [want] : []
        if (keep.length === 0) {
          return `${full}\n\n（group=「${want}」不是这几组之一：${GROUP_ORDER.join(' / ')}。上面是原样全量，这次没按组筛。）`
        }
        picked = new Map()
        for (const key of keep) picked.set(key, groups.get(key) ?? [])
      }
      const perGroup = Number.isFinite(args.limit) ? Math.max(0, Math.floor(args.limit)) : 0
      if (perGroup > 0) {
        const sliced = new Map()
        for (const [key, list] of picked) sliced.set(key, list.slice(0, perGroup))
        picked = sliced
      }
      const out = compactProject({ project, groups: picked, cap })
      // 原样多少字、这里多少字：说清「省了」这件事，不然读者以为全景就这么点。
      return `${out.text}\n（原文 ${full.length} 字 → 这份 ${out.text.length} 字）`
    },
    presentCall(args) {
      const name = typeof args.project === 'string' ? args.project.trim() : ''
      const g = typeof args.group === 'string' && args.group !== '' ? ` · ${args.group}` : ''
      return { card: 'generic', title: cardTitle('项目全景', name === '' ? '' : `${name}${g}`), kind: 'read' }
    },
  }
}
