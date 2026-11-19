import { LEVELS, PROJECT_SUBCATEGORIES, TEXT_OUT, pick } from '../shared.js'
import { LINKS_SCHEMA } from '../linkflow.js'
import { cardTitle } from '../panel.js'

export function createRemember({ flow }) {
  return {
    name: 'memory_remember',
    description:
      '把一条记忆写进宏记忆库（7 层 level + project 六子类）。与已有条目高度重复会自动合并；可用 links 顺手把关联固化进星图。',
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
      if (said.length === 0) {
        return '写入这次没有任何回执（既没说写进了哪一层，也没说为什么没写）——这不是「已经记住了」：先 memory_search 查一眼这条内容在不在库里，再决定要不要重试。'
      }
      const linked = await flow.applyLinks(main.value?.id, args.links, exec, 'remember')
      return linked ? `${said}\n\n${linked}` : said
    },
    presentCall(args) {
      return { card: 'generic', title: cardTitle('写入记忆', args.project), kind: 'write' }
    },
  }
}
