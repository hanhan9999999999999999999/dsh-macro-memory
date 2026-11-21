import { TEXT_OUT, pick } from '../shared.js'
import { LINKS_SCHEMA } from '../linkflow.js'
import { cardTitle } from '../panel.js'
import { workspaceOfExec } from '../dreamledger.js'
// [macro-fusion 0.2.138] 回执补一行「这条在取代链上的位置」（只在真有链时才出现）。
import { successionNote } from '../chain.js'
// [macro-fusion 0.2.157] 可更新性的两半：按句改（便宜）＋改前留一版（改坏了能退）。
import {
  REVISION_KEEP,
  appendTo,
  applyPatches,
  currentRow,
  revisionContent,
  revisionCount,
  saveRevision,
  shrinkGuard,
} from '../revisions.js'

const PATCH_SCHEMA = {
  type: 'array',
  items: {
    type: 'object',
    additionalProperties: false,
    required: ['find'],
    properties: {
      find: { type: 'string', description: '要改掉的那一段原文（必须在正文里唯一出现）。' },
      replace: { type: 'string', description: '换成什么；空串＝删掉这一段。' },
    },
  },
  description: '按句改：只给要改的那一句，不用把整段正文重发一遍（≤10 条，find 必须唯一命中）。',
}

function missingText(missing) {
  if (missing === 'no-db') return '这个工作区里还没有记忆库（.dsh-meow/memory.db）——没有可改的东西，这次一个字都没写。'
  if (missing === 'not-found') return '找不到这条记忆（七层表里都没有这个 id）。先用 memory_read 确认 id，别拿猜测去改。'
  if (missing === 'bad-arg') return 'id 是空的，没改。'
  if (missing.startsWith('read-failed')) return `读不到这条记忆现在的正文（${missing.slice('read-failed:'.length).trim()}），所以没敢动手——一个字都没写。`
  return `读不到这条记忆（${missing}），没改。`
}

export function createUpdate({ flow, meowDir = () => '.dsh-meow' }) {
  return {
    name: 'memory_update',
    description:
      '改一条已有记忆：内容/状态/关键词/归属/重要性。status=active 在用、stale 完结（todo 完成即 stale）、archived 作废删除。只想改一句时用 patch（{find, replace}，find 要唯一命中），想在末尾补一段用 append，这两种都不用把整段正文重发；改完的旧正文会留底，restore:N 能退回去。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'string', description: '记忆 id。' },
        content: { type: 'string', description: '新内容（整体替换；与 patch/append/restore 互斥）。' },
        patch: PATCH_SCHEMA,
        append: { type: 'string', description: '在正文末尾追加一段（空行分隔；与 content/patch/restore 互斥）。' },
        restore: {
          type: 'integer',
          description: `退回到留底的第 N 版（1=改之前那一版，最多 ${REVISION_KEEP} 版）。退回前会把现在这版再留一次底。`,
        },
        allowShrink: { type: 'boolean', description: '允许改完比原文短三成以上（默认拦下，防「改一句」变成「整段删」）。' },
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
      const workspace = workspaceOfExec(exec)
      const dir = typeof meowDir === 'function' ? meowDir() : '.dsh-meow'
      const hasContent = typeof args.content === 'string' && args.content.trim() !== ''
      const patches = Array.isArray(args.patch) ? args.patch.filter((one) => one && typeof one === 'object') : []
      const wantsAppend = typeof args.append === 'string' && args.append.trim() !== ''
      const wantsRestore = args.restore !== undefined && args.restore !== null
      const wantsLocal = patches.length > 0 || wantsAppend || wantsRestore

      // 两种意图不许混：一边给整段新正文、一边给「改哪一句」，模型自己都没想清楚哪个算数。
      if (wantsLocal && hasContent) {
        return '这次没改：content（整段替换）和 patch/append/restore（局部修改）不能同时给——一个说「新版正文长这样」，一个说「改其中一句」，落库时只有一个能算数。挑一种再调一次。'
      }

      let content = hasContent ? args.content : undefined
      let reason = hasContent ? 'content' : ''
      let kept = 0
      if (hasContent || wantsLocal) {
        const cur = currentRow({ workspace, dir, id: args.id })
        const known = cur.missing.length === 0 && cur.row !== null
        // 「按句改」没有原文就无从定位，硬改等于猜；整段替换沿用老行为——读不到旧正文也把新正文
        // 交给上游，库里到底有没有这条由上游自己说（别在这里替它下结论）。
        if (!known && wantsLocal) return missingText(cur.missing)
        const before = known ? cur.row.content : ''
        const rowId = known ? cur.row.id : args.id

        if (known && wantsLocal) {
          if (wantsRestore) {
            const n = Number(args.restore)
            if (!Number.isInteger(n) || n < 1 || n > REVISION_KEEP) {
              return `这次没改：restore 只认 1–${REVISION_KEEP}（1 是改之前那一版），收到的是 ${String(args.restore)}。`
            }
            const prev = revisionContent({ workspace, dir, id: rowId, back: n })
            if (prev === null) return `这次没改：这条记忆只留了 ${revisionCount({ workspace, dir, id: rowId })} 版底，没有第 ${n} 版可退。`
            content = prev
            reason = 'restore'
          } else {
            let next = before
            if (patches.length > 0) {
              const r = applyPatches(next, patches)
              if (!r.ok) return `这次没改：${r.why}。一个字都没写——先 memory_read 看一眼这条现在的正文，再照原文改。`
              next = r.content
              reason = 'patch'
            }
            if (wantsAppend) {
              const a = appendTo(next, args.append)
              if (!a.ok) return `这次没改：${a.why}。`
              next = a.content
              reason = reason === 'patch' ? 'patch+append' : 'append'
            }
            const g = shrinkGuard(before, next, args.allowShrink === true)
            if (!g.ok) return `这次没改：${g.why}`
            if (next === before) return '这次没改：改完之后跟原来一个字都不差（patch 可能把那段换成了同样的文字）。'
            content = next
          }
        }

        // 留底放在写之前：写成功而留底失败，等于「改坏了没退路」，那才是真事故。
        if (known && typeof content === 'string' && content !== before) {
          const saved = saveRevision({ workspace, dir, id: rowId, level: cur.row.level, title: cur.row.title, content: before, reason })
          kept = Number(saved.kept ?? 0)
        }
      }

      const payload = pick({ ...args, content }, ['id', 'content', 'status', 'importance', 'goal', 'project', 'keywords'])
      // [macro-fusion 0.2.138] 链要在**改之前**读：memory_update 换正文会连正文末尾那句
      // 「（已被取代：…）」一起换掉，改完再查就只剩一条看起来普通的记录了。
      const chain = successionNote({
        workspace,
        dir,
        id: args.id,
      })
      const main = await flow.call('memory_update', payload, exec)
      const linked = await flow.applyLinks(main.value?.id ?? args.id, args.links, exec, 'update')
      const said = String(main.text ?? '').trim()
      // [macro-fusion 0.2.49] 子插件那边已经把「改了什么/哪些没生效」说清了，但这一层不能只当
      // 管道：上游回了空串时，render 会退回 JSON.stringify(value)，读起来像「改好了」。
      // 空回执必须自己开口——「没说话」绝不能当「成功」。
      if (said.length === 0) {
        return '更新这次没有任何回执（既没说改成了什么，也没说为什么没改）——这不是「已经更新好了」：先 memory_read 看一眼这条记忆现在是什么样，再决定要不要重试。'
      }
      // [macro-fusion 0.2.157] 留底这件事必须说出来：不然「改坏了能退」只是我心里知道。
      const revNote =
        kept > 0
          ? `🕘 改之前那一版留底了（这条现在能退 ${kept} 版：memory_update(restore:1) 就是上一版${kept > 1 ? '，restore:2 再往前一版' : ''}）。`
          : ''
      return [said, revNote, linked, chain].filter((one) => typeof one === 'string' && one.length > 0).join('\n\n')
    },
    presentCall(args) {
      return { card: 'generic', title: cardTitle('更新记忆', args.id), kind: 'write' }
    },
  }
}
