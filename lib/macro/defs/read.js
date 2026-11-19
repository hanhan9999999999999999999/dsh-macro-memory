import { TEXT_OUT, countParam, neighborSection, neighborGapNote } from '../shared.js'
import { cardTitle } from '../panel.js'

export function createRead({ flow }) {
  return {
    name: 'memory_read',
    description: '读一条记忆的全文与元数据，并把星图里与它相连的记忆一起带出来（neighbors=0 可关掉邻域）。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'string', description: '记忆 id。' },
        neighbors: { type: 'integer', description: '带出多少条邻居，默认 12；0=不带。' },
      },
      required: ['id'],
    },
    output: TEXT_OUT,
    async execute(args, exec) {
      const main = await flow.call('memory_read', { id: args.id }, exec)
      // [macro-fusion 0.2.52] 上游一个字都不给时，空字符串会被读成「这条记忆是空的」。
      const said = String(main.text ?? '').trim()
      if (said.length === 0) {
        return '读取这次没有任何回执（既没有正文，也没说为什么没有）——这不是「这条记忆是空的」：先用 memory_search 或 memory_project 确认 id，再读一次。'
      }
      if (main.value?.found === false) return said
      await flow.flushLinks(exec)
      // [macro-fusion 0.2.62] 以前这里先把 neighbors 塞进 Number()，再拿「不是有限数、或者
      // 小于等于 0」做一句提前返回：非数字、负数、你自己要 0 三种情况压成同一个结果——
      // 没有邻居段。读的人只会得到「这条记忆没有邻居」这个错结论（DESIGN §72）。
      const nb = countParam('neighbors', args.neighbors, { min: 0, max: 40, def: 12 })
      if (nb.value <= 0) return nb.note.length > 0 ? `${said}\n\n${nb.note}` : said
      const inspect = await flow.tryCall('nebula_inspect', { id: args.id, neighbors: nb.value }, exec, '星图邻居')
      const section = neighborSection(inspect.text)
      // [macro-fusion 0.2.77] 没拿到邻居段时以前一声不吭（那句失败说明被拼掉的），
      // 读者会把「没带到」读成「这条记忆没有邻居」。三种情况三种话，见 neighborGapNote。
      const gap = neighborGapNote(section, inspect.def !== undefined, inspect.text)
      return [said, section, gap, nb.note].filter(Boolean).join('\n\n')
    },
    presentCall(args) {
      return { card: 'generic', title: cardTitle('读取记忆', args.id), kind: 'read' }
    },
  }
}
