/**
 * 一次性补丁：移除 nebula 的「每轮自动注入邻域」逻辑，只保留稳定 RULE 段。
 * 按行号切片替换（不做正则），替换前断言锚点行内容，错一行就报错不写盘。
 * 用法：node tools/patch-nebula-noinject.mjs [--apply]
 */
import { readFileSync, writeFileSync } from 'node:fs'

const file = 'D:/dsh-home/vendor/dsh-macro-memory/vendor/dsh-memory-nebula/lib/index.js'
const apply = process.argv.includes('--apply')
const src = readFileSync(file, 'utf8')
const lines = src.split('\n')

// 1-based 锚点
const HEAD = 543   // '  // ---------- 每轮注入：稳定规则 + ...'
const TAIL = 617   // '  )'
const headLine = lines[HEAD - 1]
const tailLine = lines[TAIL - 1]

if (!headLine.includes('每轮注入：稳定规则')) throw new Error('锚点 HEAD 不匹配：' + JSON.stringify(headLine))
if (tailLine.trim() !== ')') throw new Error('锚点 TAIL 不匹配：' + JSON.stringify(tailLine))
if (!lines[552].includes('ctx.effect') && !lines[552].includes('ctx.effect')) throw new Error('锚点 553 不匹配：' + JSON.stringify(lines[552]))

const replacement = `  // ---------- 常驻注入：只放一段稳定规则 ----------
  //
  // 这里原来每轮会额外注入「本会话该被连带读出的邻居」：读 meow 账本当种子 → bridge 沿星图
  // 扩散 → 挑 ≤maxItems 条、≤maxChars 字，最多 maxRounds 批。
  //
  // 2026-11-18 移除这段自动注入，三条理由：
  //   1. 缓存：system prompt 在请求最前面，它一变，它后面整段对话历史都从前缀缓存里掉出来
  //      重新 prefill —— 代价 ≈ 当前上下文 token 数，而换回来的信息只有几百字符（约 36:1）。
  //      而且第 2 批会顶掉第 1 批，模型上一轮刚看到的邻居下一轮就没了。
  //   2. 位置：注入不是唯一出口。真要邻居的时候，模型正在查记忆，让它调工具拿更准。
  //   3. 可控：自动注入的收益无法度量，成本却每轮都在付。
  //
  // 邻域能力没有删，只是改成按需：nebula_recall(memory_ids=[…]) 与 nebula_bridge(…) 仍在，
  // 走同一套 bridge 逻辑，结果落在工具返回里（会话尾部，不伤前缀缓存）。
  ctx.effect(() =>
    ctx.systemPrompt.context({
      name: 'memory-nebula:neighbors',
      order: 960,
      text: () => RULE,
    }),
  )`

const out = [...lines.slice(0, HEAD - 1), ...replacement.split('\n'), ...lines.slice(TAIL)].join('\n')

console.log('替换行数 =', TAIL - HEAD + 1, '→', replacement.split('\n').length)
console.log('原文件行数 =', lines.length, ' 新文件行数 =', out.split('\n').length)
if (!apply) {
  console.log('（dry-run，未写盘；加 --apply 才写）')
} else {
  writeFileSync(file, out, 'utf8')
  console.log('已写入', file)
}
