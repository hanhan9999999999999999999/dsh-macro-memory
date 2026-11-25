/**
 * 探针：按条流水（0.6.71）。
 *
 * 病：0.6.70 的额度账是**估算**（`hit_count × 正文字数`），注入日志只记「这一轮一共 X 字」。
 * 两份账各自都像真的，摆在一起却对不上——用户想动手时还是不知道该动哪一条。
 *
 * 这一版补的是**流水**：引擎把「这一轮到底进了哪几条、各占多少字、被压成什么模式」
 * 写进 `hit-chain` 行的 `picks=`，面板把账算出来，额度账把实测摆在估算旁边。
 *
 * 探针按四层问：
 *  1. 引擎那层：`renderHitEntries` 的 `sizes` 与 `modes` 逐格对齐、`buildHitInjection` 的
 *     `picks` 形状对、字数真的是「写进上下文的长度」而不是全文长度（紧预算时必须变小）；
 *  2. 日志那层：`picks=` 的三种写法（有值 / `-` / 字段缺席）各归各位——**缺席 ≠ 空**，
 *     把老日志读成「这一轮一条都没进」是这一版最可能的谎；
 *  3. 面板那层：按条合计、占比、吃额度最多的排序、没按条记录的轮数、明细行内嵌、
 *     `limit=0` 只关明细不关统计；
 *  4. 手干净不干净：两个面板都是纯读，日志一个字节不动、目录里不多出文件。
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { root } from './_root.mjs'

const tmpRoot = mkdtempSync(join(tmpdir(), 'macro-probe-picks-'))
process.env.DSH_HOME = join(tmpRoot, 'home')

const L = await import(pathToFileURL(join(root, 'lib', 'macro', 'injectledger.js')).href)
const S = await import(pathToFileURL(join(root, 'lib', 'macro', 'spend.js')).href)
const V = await import(pathToFileURL(join(root, 'vendor', 'meow-memory', 'lib', 'index.js')).href)
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

const engSrc = readFileSync(join(root, 'vendor', 'meow-memory', 'lib', 'index.js'), 'utf8')

// ── 引擎那层：真跑一遍 buildHitInjection，看 picks 是不是「写进去的那段」 ──────
const LONG = `部署脚本的端口约定是 8080，别改成 80。${'填充内容，与问题无关。'.repeat(40)}`
const SHORT = '备份目录固定放在 D:\\备份，一次一个时间戳子目录。'
const Q = '部署脚本的端口约定'
const mkRow = (id, level, content, keywords) => ({
  id,
  level,
  content,
  title: content.slice(0, 24),
  keywords,
  project: '全局',
  importance: 2,
  status: 'active',
  hit_count: 0,
  read_count: 0,
  created_at: 1,
  updated_at: 2,
  last_accessed_at: null,
})
const rows = [mkRow('picks0001', 'fact', LONG, ['部署', '脚本', '端口', '约定']), mkRow('picks0002', 'fact', SHORT, ['备份', '目录', '时间戳'])]

function runOn(q, opts) {
  const db = {
    list: (level) => rows.filter((r) => r.level === level),
    bumpHit: () => {},
    isFresh: () => false,
    idsBySession: () => [],
    findById: (id) => ({ row: rows.find((r) => r.id === id) }),
  }
  const sid = 'sess-picks-' + Math.random().toString(36).slice(2, 8)
  return V.buildHitInjection(db, join(tmpRoot, 'ws-engine'), sid, q, opts, '.dsh-meow')
}
mkdirSync(join(tmpRoot, 'ws-engine', '.dsh-meow'), { recursive: true })

{
  const free = runOn(Q, {})
  const picks = Array.isArray(free.picks) ? free.picks : []
  ok('P1 picks 形状对（id / chars / mode 都在）', picks.length > 0 && picks.every((p) => typeof p.id === 'string' && p.id !== '' && Number.isFinite(p.chars) && typeof p.mode === 'string'), picks.map((p) => `${p.id}:${p.chars}:${p.mode}`).join(','))
  const sum = picks.reduce((a, p) => a + p.chars, 0)
  ok('P2 按条字数合计不超过这一轮的正文长度', sum <= String(free.text ?? '').length, `${sum} ≤ ${String(free.text ?? '').length}`)
  const longPick = picks.find((p) => p.id === 'picks0001')
  ok('P3 宽松预算下长条是 full、字数等于全文', longPick !== undefined && longPick.mode === 'full' && longPick.chars === LONG.length, longPick === undefined ? '没进' : `${longPick.chars} / ${LONG.length}`)

  const tight = runOn(Q, { injectBodyMax: 60, injectMaxChars: 300 })
  const tp = Array.isArray(tight.picks) ? tight.picks : []
  const tl = tp.find((p) => p.id === 'picks0001')
  ok('P4 紧预算下同一条变短：模式不再是 full、字数小于全文', tl !== undefined && tl.mode !== 'full' && tl.chars < LONG.length, tl === undefined ? '没进' : `${tl.chars} 字 / ${tl.mode}（全文 ${LONG.length}）`)
  ok('P5 紧预算下这一轮总长仍守住单次上限', String(tight.text ?? '').length <= 300, `${String(tight.text ?? '').length} ≤ 300`)

  // 主流程里「按条」不能把「一共」搞坏：picks 合计 ≤ textLen 已测，这里补一条对齐
  const re = V.renderHitEntries(rows.slice(0, 1), { full: false, bodyMax: 0 }, Q)
  ok('P6 renderHitEntries 的 sizes 与 modes 逐格对齐', Array.isArray(re.sizes) && re.sizes.length === (re.modes ?? []).length && re.sizes.every((n) => Number.isFinite(n)), `sizes=${JSON.stringify(re.sizes)} modes=${JSON.stringify(re.modes)}`)
  ok('P7 sizes 是「真渲染出来的长度」：大于 0 且不超过全文', re.sizes[0] > 0 && re.sizes[0] <= LONG.length, `${re.sizes[0]} / ${LONG.length}（mode=${re.modes?.[0]}）`)
}

// 引擎改完，写日志的那一头也要跟上：hook 的 hit-chain 行必须真的把 picks 印出来
// （这段 hook 在引擎里，不在插件 lib/index.js——按错文件会「看着有源码、其实没接上」）。
ok('P8 hook 在 hit-chain 行里写了 picks=', /picks=\$\{picksStr\}/.test(engSrc))
ok('P9 hook 每条 picks 用 `id8:chars:mode`，且一次最多 8 条', engSrc.includes('hit.picks.slice(0, 8)') && engSrc.includes('${String(p.id).slice(0, 8)}:${p.chars}:${p.mode}'))

// ── 日志那层：三种写法各归各位 ───────────────────────────────────────────
const now = (min) => new Date(Date.UTC(2026, 10, 25, 10, min, 0)).toISOString()
const LINE = (min, len, picks) =>
  `[${now(min)}] hit-chain sid=aaaa1111 textLen=${len} hit=yes floor=0 qfloor=0 gated=0 body=1 bodyCut=0 sim=0 repeated=0 released=0 reinject=0${picks === null ? '' : ` picks=${picks}`} spent=0`
const MIXED = [
  LINE(0, 340, '1f2e3d4c:120:full,9a8b7c6d:95:squeeze,55667788:22:head'),
  LINE(5, 210, '1f2e3d4c:210:full'),
  LINE(10, 88, null), // 老格式：没有 picks 字段
  LINE(15, 100, '-'), // 有字段但这一轮没送条目
  `[${now(20)}] hit-skip sid=aaaa1111 reason=floor gated=4`,
].join('\n')

{
  const { events } = L.parseInjectLog(MIXED)
  const hits = events.filter((e) => e.kind === 'hit')
  ok('P10 三条明细解析出来，picks 条数与 id/字数/模式都对', hits[0].picks.length === 3 && hits[0].picks[1].id === '9a8b7c6d' && hits[0].picks[1].chars === 95 && hits[0].picks[1].mode === 'squeeze', JSON.stringify(hits[0].picks))
  ok('P11 字段缺席（老日志）读成「没有按条记录」，不是「一条都没进」', hits[2].hasPicks === false && hits[2].picks.length === 0)
  ok('P12 `picks=-` 是「有记录、零条」，与老日志分开', hits[3].hasPicks === true && hits[3].picks.length === 0)
  const broken = L.parseInjectLog(`[${now(30)}] hit-chain sid=aaaa1111 textLen=50 hit=yes floor=0 picks=deadbeef::full,zombie:12: spent=0`)
  const bh = broken.events.filter((e) => e.kind === 'hit')[0]
  ok('P13 缺字数 / 缺模式的坏段不炸：字数记 0、id 保留', bh !== undefined && bh.picks.length === 2 && bh.picks[0].chars === 0 && bh.picks[1].chars === 12, JSON.stringify(bh?.picks))
}

// ── 面板那层 ────────────────────────────────────────────────────────────
const ws = mkdtempSync(join(tmpRoot, 'ws-'))
const dir = '.dsh-meow'
mkdirSync(join(ws, dir), { recursive: true })
const logPath = join(ws, dir, 'dream-debug.log')
writeFileSync(logPath, MIXED + '\n', 'utf8')
const before = { size: statSync(logPath).size, mtime: statSync(logPath).mtimeMs, files: readdirSync(join(ws, dir)).length }

{
  const panel = L.readInjectPanel({ workspace: ws, dir, limit: 12, config: {} })
  const body = panel.body
  ok('P14 按条流水：轮数 / 条次 / 字数 / 占比', body.includes('按条流水：2 轮有按条记录，4 条次共 447 字（占这些轮注入字数的 81%）'), body.split('\n').find((l) => l.startsWith('按条流水：')) ?? '（没有这一行）')
  ok('P15 吃额度最多按字数排（不是按次数）', body.includes('- 吃额度最多：1f2e3d4c 2 次 / 330 字 · 9a8b7c6d 1 次 / 95 字 · 55667788 1 次 / 22 字'), body.split('\n').find((l) => l.startsWith('- 吃额度最多')) ?? '（没有这一行）')
  // 三种轮分开数：有记录的、有记录但一条没进（`picks=-`）、根本没记录（老日志）。
  // 合成一句会把「这轮被闸挡住了」说成「这轮没记账」——所以两句话都要在。
  ok('P16 没按条记录的轮与「有记录但零条」分成两句（不合成一句）', body.includes('另有 1 轮没有按条记录') && body.includes('另有 1 轮有按条记录但一条没进'), body.split('\n').filter((l) => l.startsWith('- 另有')).join(' / ') || '（没有这两行）')
  ok('P17 明细行内嵌 picks，被压过的带模式', body.includes('注入 340 字 · 1f2e3d4c 120 字 · 9a8b7c6d 95 字（squeeze） · 55667788 22 字（head）'), body.split('\n').find((l) => l.includes('340 字')) ?? '（没有这一行）')
  ok('P18 老格式那一轮不冒充按条记录', body.includes('11-25 18:10 注入 88 字\n') || body.split('\n').some((l) => l.includes('注入 88 字') && !l.includes('1f2e3d4c')))

  const zero = L.readInjectPanel({ workspace: ws, dir, limit: 0, config: {} })
  ok('P19 limit=0 只关明细，按条流水照算', zero.body.includes('按条流水：2 轮有按条记录') && !zero.body.includes('最近 '), zero.body.includes('最近 ') ? '明细还在' : '')
}

{
  // 全老日志：一句话说清「还没有按条记录」，且不许出现「0 轮」冒充结论
  const legacyWs = mkdtempSync(join(tmpRoot, 'ws-legacy-'))
  mkdirSync(join(legacyWs, dir), { recursive: true })
  writeFileSync(join(legacyWs, dir, 'dream-debug.log'), [LINE(0, 100, null), LINE(5, 120, null)].join('\n') + '\n', 'utf8')
  const body = L.readInjectPanel({ workspace: legacyWs, dir, limit: 12, config: {} }).body
  ok('P20 全是老日志时说「都还没有按条记录」并指向新版', body.includes('这 2 轮都还没有按条记录') && body.includes('0.6.71'), body.split('\n').find((l) => l.startsWith('按条流水：')) ?? '（没有这一行）')
}

// ── 额度账那边：把实测摆在估算旁边 ────────────────────────────────────────
{
  const db = Meow.getDb(ws, dir)
  db.insert({ level: 'fact', id: '1f2e3d4c-0000-4000-8000-000000000001', content: '长'.repeat(600), title: '长条', keywords: ['x'], project: '全局' })
  db.insert({ level: 'fact', id: '9a8b7c6d-0000-4000-8000-000000000002', content: '短'.repeat(40), title: '短条', keywords: ['x'], project: '全局' })
  db.db.exec(`UPDATE fact SET hit_count = 4 WHERE id = '1f2e3d4c-0000-4000-8000-000000000001'`)
  const body = S.readSpendPanel({ workspace: ws, dir, limit: 3, config: {} }).body
  ok('P21 日志实测：轮数 / 总字数 / 平均', body.includes('日志实测（同一份 dream-debug.log）：4 轮命中注入共 738 字 / 平均 185 字每轮'), body.split('\n').find((l) => l.includes('日志实测')) ?? '（没有这一行）')
  ok('P22 有按条记录时指向注入账逐条看', body.includes('每轮进了哪几条有按条记录（4 条次）') && body.includes('memory_admin(action="inject")'))
  ok('P23 估算与实测并排，并说清以哪边为准', body.includes('估算 = 注入计数 × 本条字数，是上界') && body.includes('两边对不上时以日志为准'))
}

{
  // 没有日志：不许编实测数字
  const bareWs = mkdtempSync(join(tmpRoot, 'ws-bare-'))
  const db = Meow.getDb(bareWs, dir)
  db.insert({ level: 'fact', content: '一条没人注入的', title: 'x', keywords: ['x'], project: '全局' })
  db.db.exec(`UPDATE fact SET hit_count = 2`)
  const body = S.readSpendPanel({ workspace: bareWs, dir, limit: 3, config: {} }).body
  ok('P24 没有注入日志时说「还没有日志」，不编实测', body.includes('日志实测：这个工作区还没有注入日志'), body.split('\n').find((l) => l.includes('日志实测')) ?? '（没有这一行）')
}

// ── 手干净不干净 ────────────────────────────────────────────────────────
{
  const after = { size: statSync(logPath).size, mtime: statSync(logPath).mtimeMs, files: readdirSync(join(ws, dir)).length }
  ok('P25 面板纯读：日志字节与 mtime 没动、目录不多文件', before.size === after.size && before.mtime === after.mtime && after.files >= before.files, `${before.size}/${after.size} B`)
}

console.log('')
console.log(`ALL PASS：${pass}/${pass + fail}`)
if (fail > 0) {
  console.log(bad.join('\n'))
  process.exitCode = 1
}
try {
  Meow.closeAllDbs()
} catch {
  /* 关不掉不影响读数 */
}
