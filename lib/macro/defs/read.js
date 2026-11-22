import { TEXT_OUT, countParam, neighborSection, neighborGapNote } from '../shared.js'
import { cardTitle } from '../panel.js'
// [macro-fusion 0.2.138] 读到一条退位的记忆时，把「该去读哪一条」一起给出来。
import { workspaceOfExec } from '../dreamledger.js'
import { successionNote } from '../chain.js'
// [macro-fusion 0.2.156] 谱系的另一半：这条从哪来、为什么在库里、还有没有人用过。
import { provenanceNote } from '../provenance.js'
// [macro-fusion 0.2.109] 读一条连带邻居，是单次调用里最容易超预算的一支；够大就报成本。
// [macro-fusion 0.2.112] 这一支也吃 budget：正文一个字都不截，只能砍邻居——砍到底还放不下就只给骨架。
import { readCostTail, budgetOf, estTokens, fmtTokens } from '../tokencost.js'

/** 骨架只留正文第一行的前这么多字：够认出是哪条，又不会把半截正文卖成全貌。 */
const SKELETON_HEAD = 120

/** 砍邻居的阶梯：先照 caller 要的条数给，再 6 / 3 / 1 / 0，最多实测三次（每次都真取一次）。 */
const NEIGHBOR_LADDER = [6, 3, 1, 0]
const LADDER_TRIES = 3

/**
 * [macro-fusion 0.4.0] 正文里带巩固句时，抬头先说清「它是材料，不是现状」。
 *
 * 与 successionNote 的区别是「退位」和「归档」的区别：取代会改 status（读到它基本是走错门），
 * 巩固不改 status（这条还活着，细节只在这里，只是结论已经收到别处去了）。所以两句话不能合并：
 * 把巩固说成「已作废」会让人不敢用这条的细节，把取代说成「已归档」会让人以为结论还在原处。
 */
const CONSOLIDATED_RE = /（已巩固进：([0-9a-z]{8})(?:「([^」]{0,40})」)?，(\d{4}-\d{2}-\d{2})）/i
export function consolidatedNote(content) {
  const m = String(content ?? '').match(CONSOLIDATED_RE)
  if (!m) return ''
  const target = m[2] ? `${m[1]}「${m[2]}」` : m[1]
  return `这条是历史材料（${m[3]} 被收进 ${target}）：它没作废，细节只在这里；但要看现在的口径，读那一条。`
}

export function createRead({ flow, meowDir = () => '.dsh-meow' }) {
  return {
    name: 'memory_read',
    description:
      '读一条记忆的全文与元数据，并把星图里与它相连的记忆一起带出来（neighbors=0 可关掉邻域）。给 budget 就按预算收紧：只砍邻居，正文从不截断，砍到底还放不下就只给骨架。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'string', description: '记忆 id。' },
        neighbors: { type: 'integer', description: '带出多少条邻居，默认 12；0=不带。' },
        budget: {
          type: 'integer',
          description: '这一读最多花多少 token（估算）。不给=不限额；给了就先砍邻居条数，正文不截断。',
        },
      },
      required: ['id'],
    },
    output: TEXT_OUT,
    async execute(args, exec) {
      const main = await flow.call('memory_read', { id: args.id }, exec)
      // [macro-fusion 0.2.52] 上游一个字都不给时，空字符串会被读成「这条记忆是空的」。
      let said = String(main.text ?? '').trim()
      if (said.length === 0) {
        return '读取这次没有任何回执（既没有正文，也没说为什么没有）——这不是「这条记忆是空的」：先用 memory_search 或 memory_project 确认 id，再读一次。'
      }
      if (main.value?.found === false) return said
      await flow.flushLinks(exec)
      // [macro-fusion 0.2.138] 链上那两行并进正文：它属于「这条记忆现在是什么样」，
      // 不是附加说明——预算按含链的长度算，砍邻居时也不会把它砍掉。
      const chain = successionNote({
        workspace: workspaceOfExec(exec),
        dir: typeof meowDir === 'function' ? meowDir() : '.dsh-meow',
        id: args.id,
      })
      // [macro-fusion 0.2.156] 来源一行同理并进正文：正文回答「它说了什么」，这一行回答
      // 「凭什么信它、它从哪来」。同样按含它的长度算预算，砍邻居时不会被砍掉。
      const prov = provenanceNote({
        workspace: workspaceOfExec(exec),
        dir: typeof meowDir === 'function' ? meowDir() : '.dsh-meow',
        id: args.id,
      })
      const extras = [consolidatedNote(main.value?.content), prov, chain].filter(Boolean).join('\n')
      if (extras.length > 0) said = `${said}\n\n${extras}`
      // [macro-fusion 0.2.62] 以前这里先把 neighbors 塞进 Number()，再拿「不是有限数、或者
      // 小于等于 0」做一句提前返回：非数字、负数、你自己要 0 三种情况压成同一个结果——
      // 没有邻居段。读的人只会得到「这条记忆没有邻居」这个错结论（DESIGN §72）。
      const nb = countParam('neighbors', args.neighbors, { min: 0, max: 40, def: 12 })
      const budget = budgetOf(args.budget)

      /** 按条数真取一次邻居段；0 条不打扰星图（问它要 0 条本来也问不出东西）。 */
      const withNeighbors = async (count) => {
        if (count <= 0) return { text: said, section: '' }
        const inspect = await flow.tryCall('nebula_inspect', { id: args.id, neighbors: count }, exec, '星图邻居')
        const section = neighborSection(inspect.text)
        // [macro-fusion 0.2.77] 没拿到邻居段时以前一声不吭（那句失败说明被拼掉的），
        // 读者会把「没带到」读成「这条记忆没有邻居」。三种情况三种话，见 neighborGapNote。
        const gap = neighborGapNote(section, inspect.def !== undefined, inspect.text)
        return { text: [said, section, gap].filter(Boolean).join('\n\n'), section }
      }

      // 没给预算：老样子，够大就报成本（省 token 的工具自己也要能报账）。
      // budget 给的「不是数字 / 太小」也走这条路——那种 note 必须带出来，不然等于悄悄忽略了他给的数。
      if (budget.value === null) {
        if (nb.value <= 0) return [said, nb.note, budget.note].filter(Boolean).join('\n\n')
        const got = await withNeighbors(nb.value)
        return readCostTail([got.text, nb.note, budget.note].filter(Boolean).join('\n\n'))
      }

      const bodyEst = estTokens(said)
      // 正文是 caller 要的东西，一个字都不能裁：裁一半他会当全文用。装不下就只给骨架。
      if (bodyEst > budget.value) {
        return skeletonOf(said, { budget: budget.value, bodyEst, budgetNote: budget.note, nbNote: nb.note })
      }

      // 正文装得下：从 caller 要的条数往下试，第一次装下就停——每一档都是一次真取、一次实测。
      const ladder = [nb.value, ...NEIGHBOR_LADDER]
        .filter((n, i, arr) => n <= nb.value && arr.indexOf(n) === i)
        .slice(0, LADDER_TRIES)
      let picked = null
      for (const count of ladder) {
        const got = await withNeighbors(count)
        const text = [got.text, nb.note].filter(Boolean).join('\n\n')
        if (estTokens(text) <= budget.value) {
          picked = { count, text, est: estTokens(text) }
          break
        }
      }
      // nb=0 时阶梯只有 [0]，正文已经过了预算，所以这里只是兜底：绝不返回半截正文。
      if (picked === null) picked = { count: 0, text: said, est: bodyEst }

      const cutNote = picked.count === nb.value ? '' : `邻居 ${nb.value}→${picked.count} 条才装下`
      const costNote = `≈${fmtTokens(picked.est)} token／预算 ${budget.value}`
      const withTail = `${picked.text}\n\n（${costNote}${cutNote ? `；${cutNote}` : '，装下了'}）`
      // 砍了邻居就必须说（改过就要交代）；没砍时这句账要装得进预算才加——
      // 正文已经装下，别为一句说明把它挤出去。
      if (cutNote) return withTail
      return estTokens(withTail) <= budget.value ? withTail : picked.text
    },
    presentCall(args) {
      return { card: 'generic', title: cardTitle('读取记忆', args.id), kind: 'read' }
    },
  }
}

/**
 * [macro-fusion 0.2.112] 预算连正文都装不下时的形态：一行标题 + 一句为什么没给全文。
 *
 * 为什么不像别的工具那样「缩到最小再给」：读的正文就是 caller 要的东西，缩了等于给假货——
 * 半截记忆会被当成完整记忆用，这比不给更坏。所以这里给的是**指路**：正文多长、缺口多少、
 * 怎么看到全文（抬预算 / 先搜摘要）。
 */
function skeletonOf(said, { budget, bodyEst, budgetNote, nbNote }) {
  const first = said.split('\n').map((line) => line.trim()).find((line) => line.length > 0) ?? ''
  const head = first.length > SKELETON_HEAD ? `${first.slice(0, SKELETON_HEAD)}…` : first
  const over = estTokens(head) > budget
  return [
    head,
    '',
    `正文共 ${said.length} 字（≈${fmtTokens(bodyEst)} token），比你给的预算 ${budget} token 大——这次一个字都没裁给你：截一半你会把它当成全文。要看全文就把 budget 提到 ≥${bodyEst}，或者先用 memory_search 看摘要挑一条。`,
    over ? '连上面那一行标题都超过你给的预算了；但不写这句，你就会把骨架当成全文。' : '',
    budgetNote,
    nbNote,
  ]
    .filter(Boolean)
    .join('\n')
}
