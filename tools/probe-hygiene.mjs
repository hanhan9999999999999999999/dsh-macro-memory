#!/usr/bin/env node
// 写入端通胀体检的量尺（0.4.0 P2.5 / PLAN-0.4 §5 P2.5）。
//
// 为什么要有这一支：verify 的 A58d 钉的是「三条新类的判据写在源码里、纯函数判得对」，
// 但它拿不到「真库里的读次数到底有没有被记」——而 P2.5 里最容易骗人的一格正是这个：
// 只要 read_count 永远是 0，`unused` 就会把整库报成「召回过没人读」，而且看起来完全正常。
// 所以这一支用真 sqlite 建临时库、真跑 registerMemoryTools，数真列上的数。
//
// 三条量的是三件事：
//   selfecho  关键词有多少逐字出现在正文里（自证率）——样本太小不算，0.67 不算
//   unused    hit_count > 0 且 read_count = 0——「排进过候选」与「真被读过」是两件事
//   inflate   近 30 天 fact 增速 vs 结论层增速（比值，不是绝对量）
//
// 不做的事：不连主人的真库（全在 tmpdir 里建）、不看时间（age 由样本自己给）。
import { root } from './_root.mjs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'

const hy = await import(pathToFileURL(join(root, 'vendor', 'dsh-memory-nebula', 'lib', 'host', 'graph.js')).href)
const meow = await import(pathToFileURL(join(root, 'vendor', 'meow-memory', 'lib', 'index.js')).href)
const rd = await import(pathToFileURL(join(root, 'lib', 'macro', 'defs', 'read.js')).href)

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

const DAY = 86400000
const NOW = Date.now()

/** 一条星图节点。reads 不给就是「这个源没有这个字段」，与「记过 0 次」必须能分开。 */
function node(id, level, keywords, content, { hits = 0, reads, ageDays = 1, status = 'active' } = {}) {
  const one = {
    id,
    level,
    label: String(content).slice(0, 24),
    content,
    keywords,
    hits,
    status,
    importance: 2,
    createdAt: NOW - ageDays * DAY,
    updatedAt: NOW - ageDays * DAY,
  }
  if (reads !== undefined) one.reads = reads
  return one
}

function audit(nodes, edges = []) {
  const it = hy.auditHygieneSteps({ nodes, edges })
  let r = it.next()
  while (!r.done) r = it.next()
  return r.value
}

// ── 1. 九类元数据：新三类不是只加 key ─────────────────────────────────────────────
check(
  'H1 体检九类都有 label 与 hint，且三新类的 hint 要说清「为什么这是病」（不是一句标签）',
  Object.keys(hy.HYGIENE_META).length === 9 &&
    ['dup', 'stale', 'thin', 'oversize', 'unread', 'orphan'].every((k) => hy.HYGIENE_META[k]?.hint.length > 10) &&
    ['selfecho', 'unused', 'inflate'].every((k) => hy.HYGIENE_META[k]?.label.length > 0 && hy.HYGIENE_META[k]?.hint.length > 30),
  Object.keys(hy.HYGIENE_META).length + ' 类',
)

// ── 2. 关键词自证 ────────────────────────────────────────────────────────────────
// 阳性：4 个关键词全部逐字出现在正文里——挑词挑到自己身上，扩召回面等于没扩。
const echoYes = node('p-echo', 'fact', ['插件', '检索', '预算', '星图'], '这个插件用检索吃预算，星图连着插件。')
// 阴性一：只有 2 个关键词。1/2 = 50% 也能顶到「高」，但样本太小的比例不是信号。
const echoFew = node('p-echo-few', 'fact', ['插件', '检索'], '这个插件用检索吃预算。')
// 阴性二：3 个词里 2 个在正文，0.67 < 0.7。
const echoPart = node('p-echo-part', 'fact', ['插件', '检索', '不存在的词'], '这个插件用检索吃预算。')
const echoOut = audit([echoYes, echoFew, echoPart])
check(
  'H2 自证只抓「全部关键词都在正文里」：2 个词不判、0.67 不算（比例要配样本量）',
  echoOut.items.selfecho.length === 1 && echoOut.items.selfecho[0].id === 'p-echo',
  JSON.stringify(echoOut.items.selfecho.map((x) => [x.id, x.rate, `${x.echo}/${x.kws}`])),
)
check(
  'H3 自证率报到两位小数、并给分子分母（用户要能自己验一遍，而不是信一个百分比）',
  echoOut.items.selfecho[0]?.rate === 1 && echoOut.items.selfecho[0]?.echo === 4 && echoOut.items.selfecho[0]?.kws === 4,
  JSON.stringify(echoOut.items.selfecho[0]),
)

// ── 3. 召回过没人读 ─────────────────────────────────────────────────────────────
// 这条守的是「hit ≠ read」：bumpHit 在检索命中时加，bumpRead 只在 memory_read 成功时加。
const unusedYes = node('p-unused', 'fact', ['预算'], '预算的事。', { hits: 5, reads: 0, ageDays: 2 })
const unusedRead = node('p-read', 'fact', ['预算'], '预算的事。', { hits: 5, reads: 1, ageDays: 2 })
// 没命中过的归 unread（太久没人碰），不归这里——两类混起来，「召回过没人读」就失去意义。
const unusedNoHit = node('p-nohit', 'fact', ['预算'], '预算的事。', { hits: 0, reads: 0, ageDays: 9 })
// 别的适配器没有 read_count：不能凭 hits 一有就全报成 unused。
const unusedNoField = node('p-nofield', 'fact', ['预算'], '别的源', { hits: 9, ageDays: 1 })
const unusedOut = audit([unusedYes, unusedRead, unusedNoHit, unusedNoField])
check(
  'H4 只抓「命中过且一次没读」：读过的、没命中的都不算',
  unusedOut.items.unused.length === 1 && unusedOut.items.unused[0].id === 'p-unused' && unusedOut.items.unused[0].hits === 5,
  JSON.stringify(unusedOut.items.unused.map((x) => [x.id, x.hits])),
)
check(
  'H5 源里没有 reads 字段就整类不参与（否则别的适配器 hits 一有就全假阳）',
  !unusedOut.items.unused.some((x) => x.id === 'p-nofield'),
  '',
)
check(
  'H6 没命中过的那条落在 unread、不在 unused（两类各管一件事）',
  unusedOut.items.unread.some((x) => x.id === 'p-nohit') && !unusedOut.items.unused.some((x) => x.id === 'p-nohit'),
  `unread=${unusedOut.items.unread.map((x) => x.id).join(',')}`,
)

// ── 4. 层通胀（比值，不是绝对量）──────────────────────────────────────────────────
const facts8 = Array.from({ length: 8 }, (_, i) => node(`p-f${i}`, 'fact', ['x'], `原子事实 ${i}`, { ageDays: i + 1 }))
const inflateOut = audit(facts8)
check(
  'H7 近 30 天 fact 8 条 / 结论层 0 条 → 报（写得多、收得少）',
  inflateOut.counts.inflate === 1 && inflateOut.items.inflate.length === 1,
  inflateOut.items.inflate[0]?.label,
)
// 阴性对照：6 fact / 2 结论 = 恰好 3×，不报——门槛是「严格大于 3×」。
const balanced = [
  node('p-r1', 'rules', ['x'], '准则', { ageDays: 1 }),
  node('p-l1', 'lesson', ['x'], '教训', { ageDays: 2 }),
  ...Array.from({ length: 6 }, (_, i) => node(`p-g${i}`, 'fact', ['x'], `事实 ${i}`, { ageDays: i + 1 })),
]
check(
  'H8 阴性对照：6 / 2 = 恰好 3× 不报（比值要严格大于 3，否则「正常写作节奏」也会天天红）',
  audit(balanced).counts.inflate === 0,
  '',
)
check(
  'H9 通胀是整库一个判断：只给一行汇总、id 留空（面板不许把它当成一条记忆去跳）',
  inflateOut.items.inflate[0]?.id === '' && /fact \d+ 条 \/ 结论层 \d+ 条/.test(inflateOut.items.inflate[0]?.label ?? ''),
  JSON.stringify(inflateOut.items.inflate[0]?.id),
)
check(
  'H10 counts 九类齐、total 等于九类之和（少一类 total 就对不上，抬头写「共 N 项」却只画八行）',
  ['dup', 'stale', 'thin', 'oversize', 'unread', 'orphan', 'selfecho', 'unused', 'inflate'].every((k) => k in inflateOut.counts) &&
    inflateOut.total === Object.values(inflateOut.counts).reduce((a, b) => a + b, 0),
  `total=${inflateOut.total}`,
)

// ── 5. 真库：read_count 只由 memory_read 记 ──────────────────────────────────────
// 这一节是整支的重点：前面的判据都能在纯函数上满足，而「谁来记这个数」只能真跑一次。
const ws = mkdtempSync(join(tmpdir(), 'probe-hygiene-'))
const tools = {}
meow.registerMemoryTools((t) => {
  tools[t.name] = t
}, '.dsh-meow')
const exec = { agent: { session: { header: { cwd: ws, id: 'probe-hygiene' } } } }
const db = new meow.MemoryDb(join(ws, '.dsh-meow', 'memory.db'))
const reads = (id) => db.findById(id).row.read_count
const hitsOf = (id) => db.findById(id).row.hit_count

try {
  const w = await tools['memory_remember'].execute(
    { content: '体检量尺：这条会被读两次', level: 'fact', project: '宏记忆', keywords: ['体检', '读两次'], importance: 2 },
    exec,
  )
  const id = w?.id ?? w?.value?.id
  check('H11 真库：刚写完 read_count = 0', !!id && reads(id) === 0, String(id))

  await tools['memory_read'].execute({ id }, exec)
  check('H12 真库：读一次 → read_count = 1', reads(id) === 1, String(reads(id)))
  await tools['memory_read'].execute({ id }, exec)
  check('H13 真库：再读一次 → 2（累加，不是覆盖成 1）', reads(id) === 2, String(reads(id)))

  await tools['memory_search'].execute({ query: '体检' }, exec)
  check(
    'H14 真库：检索命中只加 hit_count，不许冒充「读过」',
    reads(id) === 2 && hitsOf(id) >= 1,
    `reads=${reads(id)} hits=${hitsOf(id)}`,
  )

  const before = reads(id)
  await tools['memory_read'].execute({ id: 'ffffffff' }, exec)
  check('H15 真库：读一个不存在的 id 一个字都不记（失败不产生信号）', reads(id) === before, `${before} → ${reads(id)}`)

  // 老库补列：手工建一张没有 read_count 的 fact 表，再让 MemoryDb 打开它。
  // 补出来的列必须是 0——「没记过」不许被当成「读过 0 次」以外的任何东西。
  const oldWs = mkdtempSync(join(tmpdir(), 'probe-hygiene-old-'))
  const { DatabaseSync } = await import('node:sqlite')
  const { mkdirSync } = await import('node:fs')
  mkdirSync(join(oldWs, '.dsh-meow'), { recursive: true })
  const raw = new DatabaseSync(join(oldWs, '.dsh-meow', 'memory.db'))
  raw.exec(
    "CREATE TABLE fact (id TEXT PRIMARY KEY, title TEXT, content TEXT NOT NULL, importance INTEGER NOT NULL DEFAULT 1, keywords TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL DEFAULT 'active', source_session TEXT, hit_count INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, last_accessed_at INTEGER, project TEXT)",
  )
  raw
    .prepare('INSERT INTO fact (id, content, created_at, updated_at, hit_count) VALUES (?,?,?,?,?)')
    .run('old-hit-7', '老库的一条', NOW, NOW, 7)
  raw.close()
  const oldDb = new meow.MemoryDb(join(oldWs, '.dsh-meow', 'memory.db'))
  const oldRow = oldDb.list('fact')[0]
  check(
    'H16 老库自动补列，补出来是 0：命中 7 次的老条目不会被当成「读过」（否则 unused 整类假阳）',
    oldRow.read_count === 0 && oldRow.hit_count === 7,
    `reads=${oldRow.read_count} hits=${oldRow.hit_count}`,
  )
  oldDb.db.close()
  // meow 的 dbCache 与 WAL 句柄还会握着这两个目录，删不掉是常态；临时目录交给系统清理。
  // 清理失败绝不判红——这一支量的是「读次数有没有被记」，不是磁盘卫生。
  try {
    rmSync(oldWs, { recursive: true, force: true, maxRetries: 3 })
  } catch {}
} finally {
  db.db.close()
  try {
    rmSync(ws, { recursive: true, force: true, maxRetries: 3 })
  } catch {}
}

// ── 6. 读回执的抬头：巩固句要说「这是材料」───────────────────────────────────────
const line = rd.consolidatedNote('正文\n（已巩固进：0coNEW00「摘要头」，2026-11-22）')
check(
  'H17 读到带巩固句的记忆：抬头点明「没作废，但结论在别处」（不许说成已删除）',
  line.includes('0coNEW00') && line.includes('没作废'),
  line,
)
check('H18 没有巩固句就一个字都不加（否则每条读回执都多一行噪音）', rd.consolidatedNote('正文') === '', '')

console.log('')
if (fail === 0) {
  console.log(GREEN(`ALL PASS（${pass} 条）`))
} else {
  console.log(RED(`${fail} FAILED / ${pass} passed`))
  process.exitCode = 1
}
