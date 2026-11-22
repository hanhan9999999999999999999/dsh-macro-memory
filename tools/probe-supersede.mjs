#!/usr/bin/env node
// 自动取代的量尺（0.4.0 P3 / PLAN-0.4 §5 P3）。
//
// 为什么要有这一支：verify 的 A58e 钉的是「判据本身判得对」，但它钉不住「写入路径到底有没有接上、
// 接上之后会不会悄悄改库」。P3 最容易骗人的一格正是这个：suggest 态如果偷偷标了 stale，
// 判据全绿、回执也好看，库里却已经动了。所以这里用桩 flow 真跑 createRemember，数真调用。
//
// 三条量的是三件事：
//   只建议是建议   suggest 一次 internal 检索、零次 memory_update（回执里有字，库里没动）
//   动库要显式     apply 才调 memory_update 标 stale，且 old 正文里留了「（已被取代：」
//   判据要窄       版本/日期/状态/数值/路径五类各自阳性 + 各自的阴性对照（宁可漏，不可误杀）
//
// 不做的事：不连主人的真库（hits 全是桩）、不看 wall clock（日期是字面量）。
import { root } from './_root.mjs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const sp = await import(pathToFileURL(join(root, 'lib', 'macro', 'supersede.js')).href)
const rem = await import(pathToFileURL(join(root, 'lib', 'macro', 'defs', 'remember.js')).href)
const meow = await import(pathToFileURL(join(root, 'vendor', 'meow-memory', 'lib', 'index.js')).href)

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

const NEW_ID = 'new00000-1111-2222-3333-444444444444'

/** 一条 hit：形状照 memory_search 的（注意是 similarity 不是 sim）。 */
function hit(id, level, content, similarity, repeat) {
  return { id, level, title: String(content).slice(0, 20), content, similarity, repeat }
}

/** 桩 flow：把每一次工具调用都记下来，回执按工具名给最小可用形状。 */
function mkFlow({ hits = [], readRows = {}, updateOk = true } = {}) {
  const calls = []
  const updates = []
  const flow = {
    calls,
    updates,
    async call(name, args) {
      calls.push({ name, args })
      if (name === 'memory_remember') {
        return { text: '✅ 记忆已写入（fact，id=new00000）\nkeywords 12 个', value: { id: NEW_ID } }
      }
      if (name === 'memory_update') {
        updates.push(args)
        return { text: '✅ 已更新', value: updateOk ? { ok: true, id: args.id } : { ok: false } }
      }
      return { text: `（${name} 桩）`, value: {} }
    },
    async tryCall(name, args) {
      calls.push({ name, args })
      if (name === 'memory_search') return { text: '', value: { hits } }
      if (name === 'memory_read') {
        const row = readRows[args.id] ?? readRows[String(args.id).slice(0, 8)]
        return row ? { text: '', value: row } : { text: '', value: { found: false } }
      }
      if (name === 'memory_update') {
        updates.push(args)
        return { text: updateOk ? '' : '写不进去', value: updateOk ? { ok: true, id: args.id } : { ok: false } }
      }
      return { text: '', value: {} }
    },
    async applyLinks() {
      return ''
    },
  }
  return flow
}

const rowOf = (id, content, level = 'fact', status = 'active') => ({ id, level, content, status, found: true })

/** 登记一行可读的旧条目：短 id 与完整 id 两种写法都查得到（人给的是短 id，hits 给的是完整 id）。 */
function readMap(rows) {
  const out = {}
  for (const one of rows) {
    out[one.id] = one
    out[one.id.slice(0, 8)] = one
  }
  return out
}

async function run({ config = {}, args = {}, hits = [], readRows = {} } = {}) {
  const flow = mkFlow({ hits, readRows })
  // 巩固默认关掉：这一段量的是取代，巩固那两枪检索会把「打了几枪」数乱。
  const tool = rem.createRemember({ flow, config: { consolidate: 'off', ...config } })
  const text = await tool.execute({ content: '当前 0.4.1，判据全绿', project: 'p3', keywords: ['版本', '判据'], importance: 2, ...args }, {})
  return { flow, text }
}

const searchesOf = (flow) => flow.calls.filter((c) => c.name === 'memory_search')

// ── S1–S2：三态的下界与「只建议」───────────────
{
  const hits = [hit('aaaaaaaa-1', 'fact', '当前 0.4.0，判据全绿', 0.62, 0.42)]
  const off = await run({ config: { autoSupersede: 'off' }, hits })
  check(
    'S1 off 连检索那一枪都不打（关掉一个开关不该仍收一次检索成本）',
    searchesOf(off.flow).length === 0 && off.flow.updates.length === 0 && !off.text.includes('autoSupersede'),
    `searches=${searchesOf(off.flow).length}`,
  )
  const sug = await run({ config: { autoSupersede: 'suggest' }, hits })
  const q = searchesOf(sug.flow)[0]
  check(
    'S2 suggest 只打一枪 internal 检索，零次 memory_update（回执里有字、库里一个字没动）',
    searchesOf(sug.flow).length === 1 &&
      q.args.internal === true &&
      q.args.status === 'active' &&
      q.args.k === 20 &&
      q.args.content_max === 0 &&
      sug.flow.updates.length === 0 &&
      sug.text.includes('一个字没动库'),
    `internal=${q?.args.internal} updates=${sug.flow.updates.length}`,
  )
}

// ── S3–S4：apply 真动库、人点过的不重复建议 ───────────────
{
  const hits = [hit('aaaaaaaa-1', 'fact', '当前 0.4.0，判据全绿', 0.62, 0.42)]
  const readRows = readMap([rowOf('aaaaaaaa-1', '当前 0.4.0，判据全绿')])
  const app = await run({ config: { autoSupersede: 'apply' }, hits, readRows })
  check(
    'S3 apply 真调 memory_update 标 stale，并在旧正文末尾留下取代句（不是删掉）',
    app.flow.updates.length === 1 &&
      app.flow.updates[0].status === 'stale' &&
      String(app.flow.updates[0].content).includes('（已被取代：') &&
      app.text.includes('自动取代'),
    `updates=${app.flow.updates.length}`,
  )
  const told = await run({
    config: { autoSupersede: 'suggest' },
    hits,
    readRows,
    args: { supersedes: ['aaaaaaaa'] },
  })
  check(
    'S4 人已经点名要取代的那条不再出现在建议里（他刚处置过，别让他看第二遍）：候选被 skip 空，建议段整段不出现',
    !told.text.includes('一个字没动库') && told.flow.updates.length === 1,
    `updates=${told.flow.updates.length}`,
  )
}

// ── S5：没有候选就一个字不加 ───────────────
{
  const none = await run({ config: { autoSupersede: 'apply' }, hits: [] })
  check(
    'S5 没有候选时回执里连标题都不出现（不许印一个空段落）',
    !none.text.includes('autoSupersede') && !none.text.includes('⚠️ 这几条') && none.flow.updates.length === 0,
    none.text.split('\n').length + ' 行',
  )
}

// ── S6–S11：五类判据的阳性与阴性对照 ───────────────
{
  const low = await run({ config: {}, hits: [hit('aaaaaaaa-1', 'fact', '当前 0.4.0，判据全绿', 0.1, 0.9)] })
  check('S6 相似度不足 0.3 的一条不算候选（只是「都在讲版本」，不是同一件事）', !low.text.includes('aaaaaaaa'), 'sim=0.1')

  const numLow = await run({
    config: {},
    args: { content: '现在 27 支 suite，判据全绿' },
    hits: [hit('bbbbbbbb-2', 'fact', '现在 26 支 suite', 0.55, 0.31)],
  })
  check(
    'S7 数值不同但逐字重复度只有 0.31 的不报（否则「3 条」「5 条」满库乱撞）',
    !numLow.text.includes('bbbbbbbb'),
    'repeat=0.31',
  )
  const numOk = await run({
    config: {},
    args: { content: '现在 27 支 suite，判据全绿' },
    hits: [hit('bbbbbbbb-3', 'fact', '现在 26 支 suite', 0.55, 0.51)],
  })
  check('S8 同一句话的改写里数字变了才报（repeat 0.51）', numOk.text.includes('bbbbbbbb') && numOk.text.includes('26'), 'repeat=0.51')

  const cross = await run({
    config: {},
    args: { content: '现在 27 支 suite，判据全绿' },
    hits: [hit('cccccccc-4', 'fact', '现在 26 条断言', 0.6, 0.9)],
  })
  check('S9 跨单位不比：27 支 vs 26 条不是同一件事', !cross.text.includes('cccccccc'), '支 vs 条')

  const ver = await run({ config: {}, hits: [hit('dddddddd-5', 'fact', '当前 0.4.0，判据全绿', 0.62, 0.42)] })
  check('S10 版本号漂移不看重复度也报（0.42 也认——版本是硬事实）', ver.text.includes('dddddddd') && ver.text.includes('0.4.0'), 'repeat=0.42')

  const state = await run({
    config: {},
    args: { content: 'P3 已落地，判据全绿' },
    hits: [hit('eeeeeeee-6', 'fact', 'P3 未开始', 0.5, 0.2)],
  })
  check('S11 状态词反转照报（一边做完、一边没做，这是结论互斥）', state.text.includes('eeeeeeee') && state.text.includes('未开始'), 'repeat=0.2')

  const path = await run({
    config: {},
    args: { content: '落点在 tools/probe-p3.mjs' },
    hits: [hit('ffffffff-7', 'fact', '落点在 lib/probe-p3.mjs', 0.7, 0.8)],
  })
  check('S12 同一个文件名换了目录照报（同一主语换了地方）', path.text.includes('ffffffff') && path.text.includes('lib/probe-p3.mjs'), 'repeat=0.8')
}

// ── S13：apply 的上限 ───────────────
{
  const many = Array.from({ length: 5 }, (_, i) => hit(`many0000-${i}`, 'fact', `当前 0.4.${i}，判据全绿`, 0.9 - i * 0.05, 0.9))
  const readRows = {}
  for (const one of many) readRows[one.id] = rowOf(one.id, one.content)
  const capped = await run({ config: { autoSupersede: 'apply' }, hits: many, readRows })
  check(
    'S13 apply 最多动 3 条（多出来的不下手，也不假装处置了）',
    capped.flow.updates.length === 3 && capped.text.includes('自动取代（autoSupersede: apply）：3 条'),
    `updates=${capped.flow.updates.length}`,
  )
}

// ── S14：与 meow 的判据同结论（版本 / 日期两类）───────────────
{
  const pairs = [
    ['当前 0.4.1，判据全绿', '当前 0.4.0，判据全绿'],
    ['2026-11-23 收尾', '2026-11-22 收尾'],
    ['当前 0.4.0，判据全绿', '当前 0.4.0，判据全绿'],
    ['没写版本的一句话', '另一句没版本的话'],
  ]
  const rows = pairs.map(([mine, theirs], i) => ({ id: `pair-${i}`, level: 'fact', project: 'p3', content: theirs }))
  const agree = pairs.map(([mine], i) => {
    const mineKind = sp.conflictOf(mine, rows[i].content)?.kind ?? ''
    const theirs = meow.conflictCandidates(rows, mine, 'p3')
    const theirKind = theirs.find((c) => c.id === rows[i].id)?.kind ?? ''
    // macro 侧在 meow 不报的时候可能还会报状态/数值/路径，所以只比「版本/日期」这两类。
    const mineVD = mineKind === '版本' || mineKind === '日期' ? mineKind : ''
    return `${mineVD}|${theirKind}`
  })
  check(
    'S14 与 meow 的 conflictCandidates 同结论：版本/日期两类两边谁报谁就都报（两处判据没各写一套）',
    agree.every((one) => {
      const [a, b] = one.split('|')
      return a === b
    }),
    agree.join('  '),
  )
}

// ── S15：巩固与取代共存时不互相吃掉 ───────────────
{
  const hits = [hit('aaaaaaaa-1', 'fact', '当前 0.4.0，判据全绿', 0.62, 0.42)]
  const both = await run({ config: { autoSupersede: 'suggest', consolidate: 'off' }, hits })
  const only = await run({ config: { autoSupersede: 'off', consolidate: 'off' }, hits })
  check(
    'S15 同一份 hits 下：只建议态的回执 = 无建议态的回执 + 一段建议（建议是加法，不改原有回执）',
    both.text.startsWith(only.text) && both.text.length > only.text.length,
    `${only.text.length} → ${both.text.length}`,
  )
}

console.log('')
if (fail > 0) {
  console.log(`${fail} FAILED / ${pass} passed`)
  process.exit(1)
}
console.log(`${pass} passed  ${new Date().toISOString().slice(11, 19)}`)
