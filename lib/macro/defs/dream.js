import { TEXT_OUT } from '../shared.js'
import { cardTitle } from '../panel.js'

export function createDream({ flow }) {
  return {
    name: 'memory_dream',
    description: '触发一次本窗口的记忆整理（dream）：把本窗口建立/提取过的记忆逐轮封存成跨会话记忆。',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: TEXT_OUT,
    async execute(_args, exec) {
      const r = await flow.call('memory_dream', {}, exec)
      const said = String(r.text ?? '').trim()
      // [macro-fusion 0.2.48] 上游一个字都不给时这里不能沉默：空串会被读成「整理过了，没什么可说」，
      // 而真实是「这次没算成」。同一句缺陷在子插件里修过一次，融合层这层也要自己守。
      if (said.length === 0) {
        return '整理任务这次没有任何回执（既没说启动了，也没说为什么没启动）——这不是「没有需要整理的记忆」，重试一次或看看宿主日志。'
      }
      return said
    },
    presentCall() {
      return { card: 'generic', title: cardTitle('整理本窗口记忆', ''), kind: 'write' }
    },
  }
}
