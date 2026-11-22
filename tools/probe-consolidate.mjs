#!/usr/bin/env node
// 写入端巩固的量尺（0.4.0 P2 / PLAN-0.4 §5 P2）。
//
// 为什么要有这一支：`verify.mjs` 的 A58c 九条都钉在纯函数上（signals / summary / line 的形状），
// 证明不了「suggest 态真的一个字都不往库里写」。而 P2 的全部风险就在这一句上——一旦 suggest 态
// 偷偷落了库，用户会以为只是被提醒了一句，实际库里已经多了一条谁都没同意的摘要。
//
// 所以这里拿一个假的 flow 桩把 execute 整条跑通，数调用：
//   off       → 一次 memory_search 都不发（回执与没有这个功能时逐字节相同）
//   suggest   → 发两次 search（同话题 + 语义层），memory_remember / memory_update 各 0 次
//   write     → 恰好多 1 条 topic 摘要 + 每条旧条补一句「已巩固进」，status 一个字不动
//   merge     → 语义层满了：即使配 write 也只回「该并条，不是再加一条」，不落新条
//   none      → 三条件不成立时回执为空，一个字都不加
//
// 不做的事：不连真库、不写文件、不看时间。全部是桩。
import { root } from './_root.mjs'
import { createRemember, consolidateSignals, consolidateSummary } from '../lib/macro/defs/remember.js'

// root 不用来读文件（这一支全走桩），但 check-all 的「每支都从 _root.mjs 取根」这条判据要求
// 依赖本仓的脚本都显式声明根，别让脚本自己猜自己在哪。留着它，也说明这一支不该写盘。
void root

const GREEN = (s) => `\u001b[32m${s}\u001b[0m`
const RED = (s) => `\u001b[31m${s}\u001b[0m`
let pass = 0
let fail = 0

function check(label, ok, extra) {
  if (ok) {
    pass += 1
    console.log(`PASS  ${label}${extra === undefined ? '' : `  ${extra}`}`)
  } else {
    fail += 1
    console.log(`FAIL  ${label}${extra === undefined ? '' : `  ${extra}`}`)
  }
}

const NEW_ID = '0new0001abcd'
const TOPIC_ID = '0topic01wxyz'
const KEYWORDS = ['记忆插件', '检索', '巩固']

function hit(n, patch = {}) {
  return {
    id: `0old${n}0000aaaa`,
    level: 'fact',
    created_at: '2026-11-20T10:00:00Z',
    keywords: ['记忆插件', '检索', '第' + n + '条'],
    content: `第 ${n} 条：同一件事的第 ${n} 次记录，正文够长才看得出首行是哪句。`,
    ...patch,
  }
}

/** 假 flow：记下每一次调用，按名字回固定回执。 */
function makeFlow({ hits = [hit(1), hit(2), hit(3)], semantic = [] } = {}) {
  const calls = []
  // 主写入走 flow.call、巩固走 flow.tryCall——同名 memory_remember 会被两者都用，所以必须分开数，
  // 否则「巩固有没有多写一条」这个问题的答案永远是「有」（主写入那一条）。
  const of = (name) => calls.filter((one) => one.name === name && one.via === 'tryCall')
  const main = (name) => calls.filter((one) => one.name === name && one.via === 'call')
  return {
    calls,
    of,
    main,
    async call(name, payload) {
      calls.push({ name, payload, via: 'call' })
      return { text: `✅ 已写入（${payload.project}/${payload.level ?? 'fact'}）`, value: { id: NEW_ID } }
    },
    async applyLinks() {
      return ''
    },
    async tryCall(name, payload) {
      calls.push({ name, payload, via: 'tryCall' })
      if (name === 'memory_search') {
        const rows = payload.level ? semantic : hits
        return { text: '', value: { hits: rows } }
      }
      if (name === 'memory_remember') return { text: '✅ 已写入', value: { id: TOPIC_ID } }
      if (name === 'memory_update') return { text: '✅ 已更新', value: { ok: true } }
      return { text: '', value: null }
    },
  }
}

const ARGS = {
  content: '2026-11-22 · 记忆插件的巩固逻辑按 CLS 改写：三条件同时成立才触发，suggest 默认不写库。',
  project: '宏记忆',
  keywords: KEYWORDS,
  importance: 2,
  level: 'fact',
}

async function run(config, flowOpts) {
  const flow = makeFlow(flowOpts)
  // [macro-fusion 0.4.0] 取代（P3）默认 suggest 会自己打一枪 memory_search，把「巩固发了几枪」数乱：
  // 这一支量的是巩固，取代一律关掉，别让两个功能的调用混在同一张账上。
  const tool = createRemember({ flow, config: { autoSupersede: 'off', ...config } })
  const text = await tool.execute(ARGS, {})
  return { text, flow }
}

// ── 1. 不配 = 默认 suggest，且一个字不写库 ───────────────────────────────────────────
const base = await run({})
check(
  'P1 不配就是 suggest（默认那一档），回执里有「该巩固了」和现成的调用形状',
  base.text.includes('— 同一件事已经写了 3 条，该巩固了 —') &&
    base.text.includes("memory_remember(content:") &&
    base.text.includes('库里这一个字都没动'),
  'suggest',
)
check(
  'P2 suggest 态：发了两次 search，memory_remember / memory_update 各 0 次',
  base.flow.of('memory_search').length === 2 &&
    base.flow.of('memory_remember').length === 0 &&
    base.flow.of('memory_update').length === 0,
  `${base.flow.of('memory_search').length} search / ${base.flow.of('memory_remember').length} remember / ${base.flow.of('memory_update').length} update`,
)
check(
  'P3 语义层那一次带了 level=rules,fact（否则「空位」是拿全层数当分子，判不准）',
  base.flow.of('memory_search').some((one) => one.payload?.level === 'rules,fact'),
  base.flow.of('memory_search').map((one) => one.payload?.level ?? '—').join(' / '),
)

// ── 2. off：连 search 都不发，回执与没有这个功能逐字节相同 ───────────────────────────
const off = await run({ consolidate: 'off' })
const bare = await run({ consolidate: 'definitely-not-a-mode' })
check(
  'P4 off 态：一次 search 都不发，回执等于「没这个功能」的那份',
  off.flow.of('memory_search').length === 0 && off.text === bare.text && !off.text.includes('该巩固'),
  `off=${off.text.length}B / 写错值=${bare.text.length}B`,
)

// ── 3. write：恰好多一条 topic + 每条旧条补一句巩固话，status 不动 ────────────────────
const wrote = await run({ consolidate: 'write' })
// 巩固那一条走的是 tryCall，主写入走的是 call——这里要的是巩固那条（见 makeFlow 的 of/main）。
const topicCall = wrote.flow.of('memory_remember')[0]
const updates = wrote.flow.of('memory_update')
check(
  'P5 write 态：恰好多 1 条 topic 摘要（首行以日期开头），没有多出别的写入',
  wrote.flow.of('memory_remember').length === 1 &&
    topicCall?.payload?.level === 'topic' &&
    /^\d{4}-\d{2}-\d{2} · 巩固（宏记忆）：/.test(String(topicCall?.payload?.content ?? '')),
  String(topicCall?.payload?.content ?? '').split('\n')[0].slice(0, 40),
)
check(
  'P6 write 态：3 条旧条各补一句「已巩固进」指回新条目，且 status 一个字都没带',
  updates.length === 3 &&
    updates.every((one) => String(one.payload?.content ?? '').includes(`（已巩固进：${TOPIC_ID.slice(0, 8)}`)) &&
    updates.every((one) => one.payload?.status === undefined),
  `${updates.length} update / status 出现 ${updates.filter((one) => one.payload?.status !== undefined).length} 次`,
)
check(
  'P7 write 态回执说实话：落了哪条、每条补没补上（不是只说「已巩固」）',
  wrote.text.includes(`已自动落一条巩固摘要 ${TOPIC_ID.slice(0, 8)}`) &&
    wrote.text.includes('正文末尾加了一句「已巩固进」'),
  'receipt',
)

// ── 4. merge：语义层满了，即使 write 也只提示并条，不落新条 ──────────────────────────
const full = await run(
  { consolidate: 'write' },
  { semantic: new Array(8).fill(null).map((_, i) => hit(i + 10, { level: 'fact' })) },
)
check(
  'P8 语义层到上限：write 态也只回「该并条，不是再加一条」，memory_remember 0 次',
  full.text.includes('— 该并条，不是再加一条 —') &&
    full.flow.of('memory_remember').length === 0 &&
    full.flow.of('memory_update').length === 0,
  `${full.flow.of('memory_remember').length} remember / ${full.flow.of('memory_update').length} update`,
)

// ── 5. none：三条件不成立时一个字都不加 ──────────────────────────────────────────────
const thin = await run({ consolidate: 'write' }, { hits: [hit(1), hit(2)] })
const done = await run(
  { consolidate: 'write' },
  { hits: [hit(1), hit(2), hit(3)].map((one) => ({ ...one, content: `${one.content}（已巩固进：0old0001「旧摘要」，2026-11-21）` })) },
)
check(
  'P9 只有 2 条同话题 / 这批已经巩固过：回执里一个字都不加，也不落库',
  !thin.text.includes('该巩固') &&
    thin.flow.of('memory_remember').length === 0 &&
    !done.text.includes('该巩固') &&
    done.flow.of('memory_remember').length === 0,
  `2 条=${thin.flow.of('memory_remember').length} / 已巩固=${done.flow.of('memory_remember').length}`,
)

// ── 6. 纯函数与探针用的是同一份判断（防探针自己另立一套口径）──────────────────────────
// 不传 at：这一条只钉「首行是日期 + project + 关键词」的形状，不钉具体哪一天（钉死日期就得管时区，
// 而时区跟这个功能没关系）。另外 tools/probe-tools.mjs 会把 _root.mjs 的导出名 at 当自由变量抓，
// 这里少写一个 at 也就少一处要解释的巧合。
const sig = consolidateSignals({ hits: [hit(1), hit(2), hit(3)], semanticHits: [], newId: NEW_ID, keywords: KEYWORDS })
check(
  'P10 探针与实现共用同一份判断：signal.kind 是 fire，摘要首行形状与常量一致',
  sig.kind === 'fire' &&
    /^\d{4}-\d{2}-\d{2} · 巩固（宏记忆）：记忆插件、检索/.test(
      consolidateSummary({ rows: sig.rows, project: '宏记忆', keywords: KEYWORDS }),
    ),
  sig.kind,
)

// ── 7. 巩固检查的两枪都必须是 internal 的（0.4.0 的 H6 事故）──────────────────────────
// 事故经过：巩固检查调 memory_search 时，meow 会把命中的 20 条记进 seen（「这一轮已经端给用户看过」），
// 还会 bumpHit。于是写完一条记忆紧接着问 memory_search({mode:'similar', id})，回执是
// 「可比的候选一条都没有」——工具在它最该用的时刻被上一次内部查询关掉了。
// 这一条不只数「有没有传 internal」，还要真的跑出来：探针把 seen 记账当成会记账的桩，
// 巩固后若还去查相似，就该看到候选被排空。
const leaky = await run({ consolidate: 'write' })
const leakySearches = leaky.flow.of('memory_search')
check(
  'P11 巩固检查的每一次 search 都带 internal: true（否则会污染本会话的「已看过」账）',
  leakySearches.length === 2 && leakySearches.every((one) => one.payload.internal === true),
  leakySearches.map((one) => String(one.payload.internal)).join(','),
)
check(
  'P11b 主写入与巩固写入都不带 internal（internal 只属于内部查询，不许漏进写路径）',
  [...leaky.flow.main('memory_remember'), ...leaky.flow.of('memory_remember'), ...leaky.flow.of('memory_update')].every(
    (one) => one.payload.internal === undefined,
  ),
  '',
)

console.log('')
if (fail === 0) {
  console.log(GREEN(`ALL PASS（${pass} 条）`))
} else {
  console.log(RED(`${fail} FAILED / ${pass} passed`))
  process.exitCode = 1
}
