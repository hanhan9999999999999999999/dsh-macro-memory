/**
 * 探针：注入额度账（0.6.70）。
 *
 * 问的是同一件事的三个面：
 *  1. 数对不对——`hit_count × 正文字数` 会不会算错、排的序对不对（次数多 ≠ 贵：一条 1,105 字
 *     被注入 5 次就是 5,525 字，比 185 字被注入 10 次的 1,850 字贵三倍）；
 *  2. 话对不对——每条后面那句出路是不是**能直接执行**的命令（带本条 id），归档 / 拆条 /
 *     降权三种各归各位；两个口子（注入了却没人读、单条超长）数得上；
 *  3. 手干净不干净——面板是纯读：`memory.db` 一个字节不动、`.dsh-meow` 里不多出文件。
 *     这一条最容易悄悄坏掉（顺手开个写句柄、顺手建个表），所以它单独一条断言。
 *
 * 也测三种「不装成 0」：没库（一行都没花过 ≠ 花的都是 0）、没工作区、库读不出来（指向
 * `action="snapshot"`，而不是甩个 SQLite 报错）；另测缺表的半张 schema 不让整份读数作废。
 */
import { mkdirSync, mkdtempSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { root } from './_root.mjs'

const tmpRoot = mkdtempSync(join(tmpdir(), 'macro-probe-spend-'))
process.env.DSH_HOME = join(tmpRoot, 'home')

const S = await import(pathToFileURL(join(root, 'lib', 'macro', 'spend.js')).href)
const { createAdmin } = await import(pathToFileURL(join(root, 'lib', 'macro', 'defs', 'admin.js')).href)
const Meow = await import(pathToFileURL(join(root, 'vendor', 'meow-memory', 'lib', 'index.js')).href)

let pass = 0
let fail = 0
const bad = []
function ok(name, cond, detail) {
  if (cond) {
    pass++
    console.log('PASS ' + name + (detail ? '  ' + detail : ''))
  } else {
    fail++
    bad.push(name + (detail ? '  ' + detail : ''))
    console.log('FAIL ' + name + (detail ? '  ' + detail : ''))
  }
}

const wsOf = (ws) => ({ agent: { session: { header: { cwd: ws } } } })
const adminOf = () =>
  createAdmin({
    flow: { flushNow: async () => ({}) },
    bridge: { call: async () => ({ text: '' }), tryCall: async () => ({ text: '' }), promptDeclarations: () => [] },
    config: { injectTurnMaxChars: 8000, injectMaxChars: 0, injectBodyMax: 240 },
    meowDir: () => '.dsh-meow',
  })

// ── 造库：贵而短的、长而少见的、没注入过的、已归档的、同额不同长的 ─────────
const ws = mkdtempSync(join(tmpRoot, 'ws-'))
const db = Meow.getDb(ws, '.dsh-meow')
db.insert({ level: 'fact', content: `贵的短条：${'字'.repeat(180)}`, project: '全局' }) // 185 字 × 10 次
db.insert({ level: 'fact', content: `长的条目：${'长'.repeat(1100)}`, project: '全局' }) // 1,105 字 × 5 次
db.insert({ level: 'lesson', content: `没人碰的新条：${'新'.repeat(100)}`, project: '全局' })
db.insert({ level: 'fact', content: `归档掉的：${'旧'.repeat(100)}`, project: '全局' })
db.insert({ level: 'fact', content: `也归档了：${'废'.repeat(100)}`, project: '全局' })
db.insert({ level: 'fact', content: `同额的短：${'短'.repeat(245)}`, project: '全局' }) // 250 字 × 4 次
db.insert({ level: 'fact', content: `同额的长：${'长'.repeat(495)}`, project: '全局' }) // 500 字 × 2 次
const h = db.db
h.exec(`UPDATE fact SET hit_count = 10, read_count = 0 WHERE content LIKE '贵的短条%'`)
h.exec(`UPDATE fact SET hit_count = 5, read_count = 2 WHERE content LIKE '长的条目%'`)
h.exec(`UPDATE fact SET hit_count = 4, read_count = 3 WHERE content LIKE '同额的短%'`)
h.exec(`UPDATE fact SET hit_count = 2, read_count = 3 WHERE content LIKE '同额的长%'`)
h.exec(`UPDATE fact SET status = 'archived' WHERE content LIKE '归档掉的%' OR content LIKE '也归档了%'`)

const dbPath = Meow.memoryDbPath(ws, '.dsh-meow')
const dirPath = join(ws, '.dsh-meow')
const before = { size: statSync(dbPath).size, mtime: statSync(dbPath).mtimeMs, files: readdirSync(dirPath).length }

const p = S.readSpendPanel({ workspace: ws, config: { injectTurnMaxChars: 8000, injectMaxChars: 0, injectBodyMax: 240 } })
const rank = p.body.slice(p.body.indexOf('最吃额度的'))
const line = (n) => rank.split('\n').find((x) => x.trim().startsWith(`${n}. `)) ?? ''

// ── K1–K2 接线：admin 认这个 action，抬头与口径都在 ───────────────────────
{
  const body = String(await adminOf().execute({ action: 'budget' }, wsOf(ws)) ?? '')
  ok(
    'K1 memory_admin(action="budget") 出正文：抬头「注入额度账」+ 库路径',
    body.includes('注入额度账') && body.includes('库：') && body.includes('估算累计注入'),
    body.split('\n')[0],
  )
  ok(
    'K2 抬头带口径（几条 / 列了几条）',
    /\d+ 条 · 列了 \d+ 条/.test(body),
    (body.match(/\d+ 条 · 列了 \d+ 条[^\n]*/) ?? [''])[0],
  )
}
// ── K3 顶部合计：归档单独计、不进榜 ───────────────────────────────────────
ok(
  'K3 合计 5 条（2 条归档只报数不计），估 5,525+1,850+1,000+1,000 = 9,375 字',
  p.body.includes('5 条 ·') && p.body.includes('估算累计注入 9,375 字（另有 2 条已归档，不进榜也不计）'),
  p.body.split('\n')[1].trim(),
)
// ── K4 两把尺子不混：估算是上界，实测指向 inject ──────────────────────────
ok(
  'K4 写明「估算 = 注入计数 × 本条字数，是上界」并把实测指给 memory_admin(action="inject")',
  p.body.includes('估算 = 注入计数 × 本条字数，是上界') && p.body.includes('memory_admin(action="inject")'),
)
// ── K5 配额行读 config（0 印「不限」，给数就印数） ────────────────────────
{
  const q = (cfg) => S.readSpendPanel({ workspace: ws, config: cfg }).body.split('\n').find((x) => x.startsWith('配额（面板读设置')) ?? ''
  ok(
    'K5 配额行读的是 config：默认全 0 → 全「不限」',
    q({}).includes('每轮 不限 · 单次命中 不限 · 每条基准 240 字'),
    q({}),
  )
  ok(
    'K6 设了就得原样念出来（不吃默认）',
    q({ injectTurnMaxChars: 12345, injectMaxChars: 678, injectBodyMax: 300 }).includes('每轮 12,345 字 · 单次命中 678 字 · 每条基准 300 字'),
    q({ injectTurnMaxChars: 12345, injectMaxChars: 678, injectBodyMax: 300 }),
  )
}
// ── K7 排序按估算，不按次数：5 次 × 1,105 字 压过 10 次 × 185 字 ─────────
ok(
  'K7 榜首是「5 次 × 1,105 字 = 5,525 字」，第 2 名才是「10 次 × 185 字 = 1,850 字」',
  line(1).includes('5,525 字（估） · fact · 1,105 字/条 × 5 次') && line(2).includes('1,850 字（估） · fact · 185 字/条 × 10 次'),
  `${line(1).trim()} | ${line(2).trim()}`,
)
// ── K8 每条带 id，且命令里的 id 就是本条 id ──────────────────────────────
{
  const block = rank.split('\n')
  const idLine = block.find((x) => x.trim().startsWith('id=') && x.includes('0m')) ?? ''
  const id = idLine.trim().replace(/^id=/, '')
  const exitLine = block[block.indexOf(idLine) + 1] ?? ''
  ok(
    'K8 每条给 id=…，下一行的命令里用的是同一个 id（复制就能跑）',
    id.length > 8 && exitLine.includes(`id="${id}"`) && /memory_(update|read)\(/.test(exitLine),
    `${id} → ${exitLine.trim().slice(0, 48)}`,
  )
}
// ── K9 三条出路各归各位 ──────────────────────────────────────────────────
{
  const byTitle = (word) => {
    const rows = p.body.split('\n')
    const i = rows.findIndex((x) => x.includes(word))
    return rows[i + 2] ?? ''
  }
  ok('K9 从没读过（≥3 次）→ 归档，给整条 memory_update 命令', byTitle('贵的短条').includes('从没读过：memory_update(id=') && byTitle('贵的短条').includes('status="archived"'), byTitle('贵的短条').trim().slice(0, 60))
  ok('K10 比基准长 4.6 倍 → 先 memory_read 看全文，再压短或拆条', byTitle('长的条目').includes('长 4.6 倍') && byTitle('长的条目').includes('memory_read(id='), byTitle('长的条目').trim().slice(0, 60))
  ok('K11 又读过又不超长 → 降权（importance=1），不劝归档', byTitle('同额的短').includes('嫌贵就降权') && !byTitle('同额的短').includes('status="archived"'), byTitle('同额的短').trim().slice(0, 60))
}
// ── K12 已归档的一个字都不进统计 ────────────────────────────────────────
ok(
  'K12 归档条目不进榜、不进「没读过」名单（正文里「归档掉的 / 也归档了」一句都不出现）',
  !p.body.includes('归档掉的') && !p.body.includes('也归档了') && p.body.includes('另有 2 条已归档'),
)
// ── K13 两个口子的数与占比自洽 ──────────────────────────────────────────
{
  const waste = /注入了却没人读：(\d+) 条，估 ([\d,]+) 字（占 (\d+)%）/.exec(p.body)
  const okWaste = waste !== null && waste[1] === '1' && waste[2] === '1,850' && waste[3] === '20'
  ok('K13 口子一：1 条 / 1,850 字 / 占 9,375 的 20%，并指给 hygiene kind="unused"', okWaste && p.body.includes('hygiene", kind="unused"'), waste === null ? '没匹配到' : waste[0])
  ok('K14 口子二：超长的 2 条（1,105 与 500 都 > 480），最长 1,105 字', p.body.includes('单条超长（> 480 字）：2 条，最长 1,105 字'), (p.body.match(/单条超长（[^\n]*/) ?? [''])[0])
}
// ── K15 纯读：库与目录都没被动过 ────────────────────────────────────────
{
  const after = { size: statSync(dbPath).size, mtime: statSync(dbPath).mtimeMs, files: readdirSync(dirPath).length }
  ok(
    'K15 纯读：memory.db 字节与 mtime 都不变、.dsh-meow 里文件数不变（没建表没写 WAL）',
    after.size === before.size && after.mtime === before.mtime && after.files === before.files,
    `${before.size} B / ${before.files} 个文件`,
  )
}
// ── K16 limit：生效、提示后面还有、超上限夹住 ────────────────────────────
{
  const one = S.readSpendPanel({ workspace: ws, limit: 1 })
  ok('K16 limit=1 只列一条并说「后面还有 3 条」', one.body.includes('最吃额度的 1 条：') && one.body.includes('…后面还有 3 条（加大 limit 看全）'))
  const many = S.readSpendPanel({ workspace: ws, limit: 999 })
  ok('K17 limit 超上限夹到 50，一条不落也不炸', many.body.includes('最吃额度的 4 条（全库只有 4 条注入过）'))
}
// ── K18 同额按字数降序（估算相同再比正文长度） ──────────────────────────
{
  const body = S.readSpendPanel({ workspace: ws, limit: 50 }).body
  const iLong = body.indexOf('同额的长')
  const iShort = body.indexOf('同额的短')
  ok('K18 同额（1,000 字）时正文长的排前面：500 字 × 2 在 250 字 × 4 之前', iLong > 0 && iShort > 0 && iLong < iShort)
}
// ── K19 一条都没注入过 ──────────────────────────────────────────────────
{
  const fresh = mkdtempSync(join(tmpRoot, 'fresh-'))
  Meow.getDb(fresh, '.dsh-meow').insert({ level: 'fact', content: '还没被注入过的一条', project: '全局' })
  const r = S.readSpendPanel({ workspace: fresh })
  ok('K19 全 0 → 明说「还没有条目被注入过」，不出空榜单', r.body.includes('还没有条目被注入过') && !r.body.includes('最吃额度的') && r.body.includes('1 条 ·'))
}
// ── K20 没库：一行都没花过 ≠ 花的都是 0 ─────────────────────────────────
{
  const empty = mkdtempSync(join(tmpRoot, 'empty-'))
  const r = S.readSpendPanel({ workspace: empty })
  ok('K20 没库 → 说「还没有记忆库 / 一行额度都还没花过」，scope 为空', r.body.includes('还没有记忆库') && r.body.includes('一行额度都还没花过') && r.scope === '')
}
// ── K21 没工作区 ────────────────────────────────────────────────────────
ok('K21 拿不到工作区 → 独立文案，不装成「没花过」', S.readSpendPanel({ workspace: '' }).body.includes('拿不到工作区'))
// ── K22 库坏了：照实说 + 指向 snapshot，而且不去动它 ────────────────────
{
  const broken = mkdtempSync(join(tmpRoot, 'broken-'))
  mkdirSync(join(broken, '.dsh-meow'), { recursive: true })
  const f = join(broken, '.dsh-meow', 'memory.db')
  writeFileSync(f, Buffer.alloc(4096, 0x41))
  const r = S.readSpendPanel({ workspace: broken })
  ok('K22 坏库 → 「读不出来」并指向 memory_admin(action="snapshot")', r.body.includes('但读不出来') && r.body.includes('action="snapshot"'), r.body.split('\n')[1].slice(0, 40))
  ok('K23 坏库时「纯读」也兑现：文件字节没变（没被顺手打开写一遍）', statSync(f).size === 4096)
}
// ── K24 半张 schema：缺一层不让整份读数作废 ──────────────────────────────
{
  const part = mkdtempSync(join(tmpRoot, 'partial-'))
  const d = Meow.getDb(part, '.dsh-meow')
  d.insert({ level: 'fact', content: '只在这一层有东西'.repeat(3), project: '全局' })
  d.db.exec(`UPDATE fact SET hit_count = 2`)
  d.db.exec('DROP TABLE lesson')
  const spend = S.readSpend(Meow.getDb(part, '.dsh-meow').db)
  const r = S.readSpendPanel({ workspace: part })
  ok(
    'K24 缺 lesson 表 → missing 点名、榜单照出、面板写明「这 1 层没有表」',
    spend.missing.includes('lesson') && spend.rows.length === 1 && r.body.includes('最吃额度的 1 条') && r.body.includes('这 1 层没有表'),
    `missing=${spend.missing.join(',')}`,
  )
}

Meow.closeAllDbs?.()
if (fail > 0) {
  console.log('\n失败清单：\n  - ' + bad.join('\n  - '))
}
console.log(`\n${fail === 0 ? 'ALL PASS' : fail + ' 条失败'}：${pass}/${pass + fail} 条`)
process.exit(fail === 0 ? 0 : 1)
