import { TEXT_OUT, pick } from '../shared.js'
import { LINKS_SCHEMA } from '../linkflow.js'
import { cardTitle } from '../panel.js'

export function createUpdate({ flow }) {
  return {
    name: 'memory_update',
    description:
      '改一条已有记忆：内容/状态/关键词/归属/重要性。status=active 在用、stale 完结（todo 完成即 stale）、archived 作废删除。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'string', description: '记忆 id。' },
        content: { type: 'string', description: '新内容（整体替换）。' },
        status: { type: 'string', enum: ['active', 'stale', 'archived'], description: '新状态。' },
        importance: { type: 'integer', description: '新重要性。' },
        goal: { type: 'string', description: '新的 topic 目标句。' },
        project: { type: 'string', description: '新项目归属；传空字符串清空归属。' },
        keywords: { type: 'array', items: { type: 'string' }, description: '新关键词列表（不传=不改）。' },
        links: LINKS_SCHEMA,
      },
      required: ['id'],
    },
    output: TEXT_OUT,
    async execute(args, exec) {
      const payload = pick(args, ['id', 'content', 'status', 'importance', 'goal', 'project', 'keywords'])
      const main = await flow.call('memory_update', payload, exec)
      const linked = await flow.applyLinks(main.value?.id ?? args.id, args.links, exec, 'update')
      const said = String(main.text ?? '').trim()
      // [macro-fusion 0.2.49] 子插件那边已经把「改了什么/哪些没生效」说清了，但这一层不能只当
      // 管道：上游回了空串时，render 会退回 JSON.stringify(value)，读起来像「改好了」。
      // 空回执必须自己开口——「没说话」绝不能当「成功」。
      if (said.length === 0) {
        return '更新这次没有任何回执（既没说改成了什么，也没说为什么没改）——这不是「已经更新好了」：先 memory_read 看一眼这条记忆现在是什么样，再决定要不要重试。'
      }
      return linked ? `${said}\n\n${linked}` : said
    },
    presentCall(args) {
      return { card: 'generic', title: cardTitle('更新记忆', args.id), kind: 'write' }
    },
  }
}
