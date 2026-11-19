import { TEXT_OUT } from '../shared.js'
import { cardTitle } from '../panel.js'

export function createProject({ flow }) {
  return {
    name: 'memory_project',
    description: '看某个项目的全景记忆：overview/structure/decisions/quotes/ops/todo 分组全给（已完结的 todo 单独列）。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        project: { type: 'string', description: '项目名。' },
      },
      required: ['project'],
    },
    output: TEXT_OUT,
    async execute(args, exec) {
      const r = await flow.call('memory_project', { project: args.project }, exec)
      return r.text
    },
    presentCall(args) {
      return { card: 'generic', title: cardTitle('项目全景', args.project), kind: 'read' }
    },
  }
}
