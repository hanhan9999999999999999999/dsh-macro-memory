/**
 * 探针：记忆库快照（0.6.68）
 *
 * 为什么要有这一支：9.267 那次事故里，插件的记忆库被一个开发脚本用自己的空壳 fixture 盖掉，
 * 2,613 条只剩一个空 schema——而事故前**一个备份都没有**（引擎的 `backupMemoryDb()` 默认关闭，
 * 且只留一份 `.bak`，连续两次写坏就一起没了）。这一支守的是新加的保险：
 *
 *  - 快照必须是**一致**的（`VACUUM INTO`，不是文件复制）：拿快照库数得出原来的条数；
 *  - 便宜：库没变、或距上一份没满间隔，就不写盘（`fresh/unchanged`、`fresh/gap`）；
 *  - 会轮转：只留最近 `keep` 份，删的是最老的；
 *  - 读得出来：面板给份数、大小、复原命令（且指向 `node tools/restore-live-db.mjs --source`）；
 *  - 不反咬：坏库时只回 `error` 不抛，面板照常念出旧快照；
 *  - 不越界：快照落在 `$DSH_HOME/macro-memory/snapshots/`，一个字节都不写进 `.dsh-meow`；
 *  - 守卫：`agent/pre-step` 透传 decision，并按 payload 的工作区存快照。
 *
 * 一个坑记在这里：`Meow.closeAllDbs()` 关的是**全部**缓存连接，顺手把 WAL checkpoint 进
 * `memory.db`，库的 mtime 就变新了——于是「库没变」那条闸会误判成「库变了」。所以这一支里
 * 谁都不在中途关库：句柄一直开到脚本末尾，只有 S16 要覆写坏库那一步才关。
 */
import { root } from './_root.mjs'
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const tmpRoot = mkdtempSync(join(tmpdir(), 'macro-probe-snapshot-'))
process.env.DSH_HOME = join(tmpRoot, 'home')

const S = await import(pathToFileURL(join(root, 'lib', 'macro', 'snapshot.js')).href)
const Meow = await import(pathToFileURL(join(root, 'vendor', 'meow-memory', 'lib', 'index.js')).href)
const { createAdmin } = await import(pathToFileURL(join(root, 'lib', 'macro', 'defs', 'admin.js')).href)

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

const HOUR = 60 * 60 * 1000
function wsWith(rows = 2) {
  const ws = mkdtempSync(join(tmpRoot, 'ws-'))
  const db = Meow.getDb(ws, '.dsh-meow')
  for (let i = 0; i < rows; i++) {
    db.insert({ level: 'fact', content: `快照样本第 ${i} 条：${'正文'.repeat(30)}`, project: '全局' })
  }
  return { ws, db }
}

// ── S1 首份：真存下来，且是一份能读的库 ────────────────────────────────────
const { ws, db } = wsWith(3)
const first = S.takeSnapshot({ workspace: ws, dir: '.dsh-meow' })
ok('S1 首份快照落盘（taken，字节数>0）', first.status === 'taken' && first.bytes > 0, JSON.stringify(first))

// ── S3 第一条闸：库没变就别再存 ───────────────────────────────────────────
ok(
  'S3 库没变 → fresh/unchanged，不再写盘',
  (() => {
    const r = S.takeSnapshot({ workspace: ws, dir: '.dsh-meow' })
    return r.status === 'fresh' && r.skipped === 'unchanged' && S.listSnapshots(ws).length === 1
  })(),
)

// ── S4 第二条闸：变了但没到间隔，也不存 ───────────────────────────────────
ok(
  'S4 库变了但没到间隔 → fresh/gap',
  (() => {
    db.insert({ level: 'fact', content: '又写了一条'.repeat(20), project: '全局' })
    const r = S.takeSnapshot({ workspace: ws, dir: '.dsh-meow', now: Date.now() + HOUR / 4 })
    return r.status === 'fresh' && r.skipped === 'gap' && S.listSnapshots(ws).length === 1
  })(),
)

// ── S5–S6 到点就存 + 新→旧排序 ─────────────────────────────────────────────
{
  const r = S.takeSnapshot({ workspace: ws, dir: '.dsh-meow', now: Date.now() + 2 * HOUR })
  const list = S.listSnapshots(ws)
  ok('S5 库变了且满间隔 → 存第二份', r.status === 'taken' && list.length === 2, JSON.stringify(r))
  ok('S6 清单新→旧（按文件名里的时间戳排）', list[0].stamp >= list[1].stamp, list.map((x) => x.name).join(','))
}

// ── S7 轮转只留最新 ───────────────────────────────────────────────────────
{
  db.insert({ level: 'fact', content: '再写一条给轮转用'.repeat(20), project: '全局' })
  const r = S.takeSnapshot({ workspace: ws, dir: '.dsh-meow', keep: 1, gapMs: 0, now: Date.now() + 4 * HOUR })
  const list = S.listSnapshots(ws)
  ok(
    'S7 keep=1：删掉更老的 2 份，只剩最新 1 份',
    r.status === 'taken' && r.removed === 2 && list.length === 1,
    JSON.stringify({ removed: r.removed, left: list.length }),
  )
}

// ── S8–S9 面板：份数口径 + 复原入口 ──────────────────────────────────────
{
  const panel = S.readSnapshotPanel({ workspace: ws, dir: '.dsh-meow', keep: 7, limit: 7 })
  ok(
    'S8 面板念出库大小、份数与复原入口',
    panel.body.includes('快照（1/1 份') &&
      panel.body.includes('复原（先退出 DSH') &&
      panel.body.includes('restore-live-db.mjs --source'),
    panel.body.split('\n').slice(0, 2).join(' | '),
  )
  ok('S9 口径尾注带「最多留 N 份」与间隔', panel.scope.includes('最多留 7 份') && panel.scope.includes('间隔 60 分钟'), panel.scope)
}

// ── S2 一致快照：把快照当库打开，条数必须对得上 ────────────────────────────
{
  const latest = S.listSnapshots(ws)[0]
  const probeWs = mkdtempSync(join(tmpRoot, 'readback-'))
  mkdirSync(join(probeWs, '.dsh-meow'), { recursive: true })
  copyFileSync(latest.file, join(probeWs, '.dsh-meow', 'memory.db'))
  const readBack = Meow.getDb(probeWs, '.dsh-meow')
  const n = readBack.db.prepare('SELECT COUNT(*) AS n FROM fact').get().n
  ok('S2 快照是可读的一致库（fact 表里 5 条，含轮转前的写入）', n === 5, `n=${n}`)
}

// ── S10–S11 边界：没有库 / 没有工作区 ─────────────────────────────────────
ok('S10 工作区没有库 → no-db（不是 error）', S.takeSnapshot({ workspace: mkdtempSync(join(tmpRoot, 'empty-')) }).status === 'no-db')
ok('S11 拿不到工作区 → no-ws', S.takeSnapshot({ workspace: '   ' }).status === 'no-ws')

// ── S12 不越界：快照不进 .dsh-meow ────────────────────────────────────────
{
  const inside = readdirSync(join(ws, '.dsh-meow'))
  const stray = inside.filter((n) => n.includes('snapshot') || n.endsWith('.bak'))
  ok(
    'S12 快照落 $DSH_HOME/macro-memory/snapshots，不往 .dsh-meow 里塞东西',
    stray.length === 0 && S.snapshotDir(ws).startsWith(join(tmpRoot, 'home')),
    `stray=${JSON.stringify(stray)} dir=${S.snapshotDir(ws)}`,
  )
}

// ── S13–S15 守卫：透传 decision、按 payload 的工作区干活 ──────────────────
{
  let handler = null
  const logs = []
  const guard = S.createSnapshotGuard({
    ctx: {
      on: (ev, fn) => {
        handler = fn
        return () => {
          handler = null
        }
      },
    },
    meowDir: () => '.dsh-meow',
    logger: (m) => logs.push(m),
    gapMs: 0,
  })
  const gws = wsWith(2).ws
  const decision = { kind: 'enter', messages: [] }
  const out = await handler({ agent: { session: { header: { cwd: gws } } }, sessionId: 's-guard' }, async () => decision)
  ok('S13 守卫原样透传 decision（快照绝不改写这一轮）', out === decision)
  ok(
    'S14 守卫按 payload 的 cwd 存下快照，并落一行日志',
    S.listSnapshots(gws).length === 1 && logs.some((m) => m.includes('库快照已存')),
    logs.join(' / '),
  )
  guard.dispose()
  ok('S15 dispose 真的把监听器摘了', handler === null)
}

// ── S16–S17 坏库：只回 error，不抛；面板照常念旧快照 ──────────────────────
{
  const { ws: bws } = wsWith(2)
  S.takeSnapshot({ workspace: bws, dir: '.dsh-meow' })
  // 覆写之前必须把缓存连接关掉（Windows 上开着句柄写不进同一个文件）；
  // 这也是本支唯一一次 closeAllDbs，所以它之前没有任何「库没变」类的断言。
  Meow.closeAllDbs?.()
  writeFileSync(join(bws, '.dsh-meow', 'memory.db'), Buffer.alloc(4096, 0x41))
  const r = S.takeSnapshot({ workspace: bws, dir: '.dsh-meow', force: true })
  const panel = S.readSnapshotPanel({ workspace: bws, dir: '.dsh-meow' })
  ok('S16 库坏了 → status=error、带原话、不抛', r.status === 'error' && String(r.error).length > 0, JSON.stringify(r).slice(0, 120))
  ok('S17 库坏了面板仍念得出旧快照（退得回去）', panel.body.includes('快照（1/1 份'))
}

// ── S18 面板动作与动作表对得上：admin(snapshot) 能出正文 ─────────────────
{
  const { ws: aws } = wsWith(2)
  const admin = createAdmin({
    flow: { flushNow: async () => ({}) },
    bridge: { call: async () => ({ text: '' }), tryCall: async () => ({ text: '' }), promptDeclarations: () => [] },
    config: {},
    meowDir: () => '.dsh-meow',
  })
  const r = await admin.execute({ action: 'snapshot' }, { agent: { session: { header: { cwd: aws } } } })
  const body = String(r ?? '')
  ok(
    'S18 memory_admin(snapshot)：出正文，并写明这次有没有存',
    body.includes('库：') && body.includes('快照（') && /这次存了一份|这次没多存|这次没存/.test(body),
    body.split('\n').slice(0, 2).join(' | '),
  )
}

// ── S19–S25 退之前先看清楚要退掉什么（0.6.69 对比） ───────────────────────
{
  const { ws: cws, db: cdb } = wsWith(2)
  S.takeSnapshot({ workspace: cws, dir: '.dsh-meow' })
  cdb.insert({ level: 'fact', content: '快照之后新写的 fact', project: '全局' })
  cdb.insert({ level: 'lesson', content: '快照之后新写的 lesson', project: '全局' })
  const cmp = S.compareWithLive({ workspace: cws, dir: '.dsh-meow' })
  const lines = S.compareLines(cmp, { stamp: '2026-11-25 18:50' })
  ok(
    'S19 对比：快照 2 条 → 现库 4 条，新写 2 条并按层分开数',
    cmp.status === 'ok' && cmp.added.total === 2 && cmp.removed.total === 0 && cmp.added.byLevel.fact === 1 && cmp.added.byLevel.lesson === 1,
    JSON.stringify({ s: cmp.status, a: cmp.added?.byLevel, r: cmp.removed?.total }),
  )
  ok('S20 新写的那几条给得出标题（不然读者还得自己去翻）', lines.some((l) => l.includes('新写的例如：') && l.includes('fact')), lines.join(' | '))

  // 面板：只读地比一次，库的 mtime 不能动
  const before = statSync(join(cws, '.dsh-meow', 'memory.db')).mtimeMs
  const panel = S.readSnapshotPanel({ workspace: cws, dir: '.dsh-meow' })
  ok('S21 面板出对比行，且对比不写库（mtime 没变）', panel.body.includes('快照 2 条 → 现库 4 条') && statSync(join(cws, '.dsh-meow', 'memory.db')).mtimeMs === before)

  // 丢了一条：退回去会把它带回来
  const row = cdb.db.prepare('SELECT id FROM fact LIMIT 1').all()
  cdb.db.prepare('DELETE FROM fact WHERE id = ?').run(row[0].id)
  const cmp2 = S.compareWithLive({ workspace: cws, dir: '.dsh-meow' })
  const lines2 = S.compareLines(cmp2)
  ok(
    'S22 现库丢了一条 → 对比说出来「退回去会带回来」',
    cmp2.removed.total === 1 && cmp2.removed.byLevel.fact === 1 && lines2.some((l) => l.includes('退到这一份会把它们带回来')),
    lines2.join(' | '),
  )

  // 坏的那份正好是最新的：跳过它，复原命令指向还读得动的那一份
  const fake = join(S.snapshotDir(cws), 'memory-20990101-000000.db')
  writeFileSync(fake, Buffer.alloc(2048, 0x42))
  const cmp3 = S.compareWithLive({ workspace: cws, dir: '.dsh-meow' })
  const panel3 = S.readSnapshotPanel({ workspace: cws, dir: '.dsh-meow' })
  ok(
    'S23 最新那份坏了 → 自动跳过，仍能拿旧的那份做对比',
    cmp3.status === 'ok' && cmp3.skipped.length === 1 && cmp3.file.endsWith('.db') && !cmp3.file.includes('2099'),
    JSON.stringify({ s: cmp3.status, skip: cmp3.skipped?.length }),
  )
  ok(
    'S24 面板点名哪份读不出来、复原命令不指向它',
    panel3.body.includes('已跳过') && panel3.body.includes('（读不出来）') && panel3.body.includes('拷回快照：') && !/拷回快照：[^\n]*memory-2099/.test(panel3.body),
    panel3.body.split('\n').filter((l) => l.includes('已跳过') || l.includes('拷回快照：')).join(' | ').slice(0, 200),
  )

  // 4,096 字节的合法空库（9.267 现场那种空壳）：读得动但一条都没有
  const emptyDb = join(tmpRoot, 'empty-shape.db')
  {
    const h = new DatabaseSync(emptyDb)
    h.exec('PRAGMA user_version = 0')
    h.close()
  }
  const cmp4 = S.compareWithLive({ workspace: cws, dir: '.dsh-meow', file: emptyDb })
  ok(
    'S25 空 schema 的快照 → 单独报 snapshot-empty（退它等于清库），不报成「之后新写 N 条」',
    cmp4.status === 'snapshot-empty' && S.compareLines(cmp4).some((l) => l.includes('退它等于把现库')),
    String(cmp4.status),
  )

  // 一份都没有 / 一份都打不开
  const { ws: nws } = wsWith(1)
  ok('S26 没有快照的工作区 → no-snapshot，不出对比行', S.compareWithLive({ workspace: nws, dir: '.dsh-meow' }).status === 'no-snapshot')
  const { ws: jws } = wsWith(1)
  mkdirSync(S.snapshotDir(jws), { recursive: true })
  writeFileSync(join(S.snapshotDir(jws), 'memory-20200101-000000.db'), Buffer.alloc(1024, 0x7a))
  const jcmp = S.compareWithLive({ workspace: jws, dir: '.dsh-meow' })
  const jpanel = S.readSnapshotPanel({ workspace: jws, dir: '.dsh-meow' })
  ok(
    'S27 快照全坏 → no-usable-snapshot，面板直说「没有能退的东西」且不给命令',
    jcmp.status === 'no-usable-snapshot' && jpanel.body.includes('一份都打不开') && !jpanel.body.includes('拷回快照：'),
    String(jcmp.status),
  )
}

// 句柄不关，Windows 上删不掉临时目录（EPERM）；关完也可能被别的进程短暂占着，
// 重试几次就够了——清不掉临时目录不该让这一支变成失败。
Meow.closeAllDbs?.()
for (let i = 0; i < 5; i++) {
  try {
    rmSync(tmpRoot, { recursive: true, force: true })
    break
  } catch {
    await new Promise((r) => setTimeout(r, 120))
  }
}

console.log('')
if (fail > 0) {
  console.log(`FAILED  passed ${pass} / failed ${fail}`)
  for (const b of bad) console.log('  ✗ ' + b)
  process.exitCode = 1
} else {
  console.log(`ALL PASS  probe-snapshot：${pass}/${pass}`)
}
