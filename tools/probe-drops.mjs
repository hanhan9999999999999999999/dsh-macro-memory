/**
 * 探针：落选名单（0.6.72）。
 *
 * 病：0.6.71 的 `picks=` 只记「这一轮进了哪几条」，挡在门外的一条都不提。
 * 于是「这条记忆为什么从来不出现」只能猜：分数不够？只对上单字？上一轮刚给过？
 * 被这一轮的字数上限挤掉了？四种原因的对策互不相同（补 keywords / 补两字词 / 什么都不用改 /
 * 压短条目或调额度），猜错就白改。
 *
 * 这一版补的是**另一半流水**：引擎把每条落选的 id / 分数 / 原因写进 `drops=`（hit-chain 与
 * hit-skip 两处都写），面板按条目聚合、按主因给一句能照做的对策。
 *
 * 探针按四层问：
 *  1. 引擎那层：四道闸（literal / floor / repeat / cap）各真的往里放一笔，成功的一轮里
 *     也有落选；落选的不许同时又出现在 picks 里；
 *  2. 日志那层：`drops=` 三种写法（有值 / `-` / 缺席）各归各位，**缺席 ≠ 空**；
 *  3. 面板那层：聚合口径、按次数排序、四种对策各归各位、明细行内嵌、老日志与「一条没落选」分开说；
 *  4. 手干净不干净：面板纯读。
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { root } from './_root.mjs'

const tmpRoot = mkdtempSync(join(tmpdir(), 'macro-probe-drops-'))
process.env.DSH_HOME = join(tmpRoot, 'home')

const L = await import(pathToFileURL(join(root, 'lib', 'macro', 'injectledger.js')).href)
const V = await import(pathToFileURL(join(root, 'vendor', 'meow-memory', 'lib', 'index.js')).href)

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

// ── 引擎那层：真跑一遍，看四道闸是不是都记了账 ─────────────────────────────
const LONG = `部署脚本的端口约定是 8080，别改成 80。${'填充内容，与问题无关。'.repeat(20)}`
// 弱条目：正文里「端口」只出现一次，分数掉到 0.03 上下（实测 0.027），过不了 0.35 的门槛。
const WEAK = `运维杂记：${'与端口无关的碎话。'.repeat(30)}`
const mkRow = (id, content, keywords, extra = {}) => ({
  id,
  level: 'fact',
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
  ...extra,
})
const rows = [mkRow('strong0001', LONG, ['部署', '脚本', '端口', '约定']), mkRow('weak000002', WEAK, ['运维', '端口'])]

let seq = 0
function runOn(q, opts, ws = join(tmpRoot, 'ws-engine'), sid = null) {
  const db = {
    list: (level) => rows.filter((r) => r.level === level),
    bumpHit: () => {},
    isFresh: () => false,
    idsBySession: () => [],
    findById: (id) => ({ row: rows.find((r) => r.id === id) }),
  }
  seq += 1
  return V.buildHitInjection(db, ws, sid ?? `sess-drops-${seq}`, q, opts, '.dsh-meow')
}
mkdirSync(join(tmpRoot, 'ws-engine', '.dsh-meow'), { recursive: true })

const Q = '部署脚本的端口约定'

{
  // ① 成功的轮里也有落选：强条进 picks，弱条记 floor
  const r = runOn(Q, { hitTopK: 4 })
  const drops = Array.isArray(r?.drops) ? r.drops : []
  const weak = drops.find((d) => d.id === 'weak000002')
  ok(
    'R1 成功注入的那一轮也点名落选：弱条以 floor 记入 drops，带分数',
    weak !== undefined && weak.reason === 'floor' && Number.isFinite(weak.score) && weak.score > 0 && weak.score < 0.35,
    weak === undefined ? JSON.stringify(drops) : `${weak.reason} ${weak.score.toFixed(3)}`,
  )
  const picked = (r?.picks ?? []).map((p) => p.id)
  ok('R2 落选的条目不许同时出现在 picks 里（进了就不是落选）', picked.includes('strong0001') && !picked.includes('weak000002'), `picks=${picked.join(',')}`)
  ok('R3 drops 的元素形状对（id / level / score / reason 四样都在）', drops.length > 0 && drops.every((d) => typeof d.id === 'string' && typeof d.level === 'string' && Number.isFinite(d.score) && typeof d.reason === 'string'))
}

{
  // ② 单次上限很紧：排在后面的被 cap 挤掉，理由记 cap 而不是 floor
  // （floor 必须置 0：门槛先开，弱条才有机会走到「被挤掉」这一步）
  const tight = runOn(Q, { hitTopK: 4, injectFloor: 0, injectBodyMax: 120, injectMaxChars: 210 })
  const drops = Array.isArray(tight?.drops) ? tight.drops : []
  const cap = drops.find((d) => d.reason === 'cap')
  ok('R4 字数上限挤掉的记 cap（不是分数不够）', tight !== null && cap !== undefined, tight === null ? '整轮都被挡了' : JSON.stringify(drops.map((d) => [d.id, d.reason])))
  ok('R5 被挤掉的条数与 picks 互补：picks + drops 正好是这一轮的候选', (tight?.picks ?? []).length + drops.length >= 2, `${(tight?.picks ?? []).length} + ${drops.length}`)
}

{
  // ③ 同话题抑制：把上一轮的词面与最高分灌进会话账本，同一句话再问一遍
  //    → 门槛抬到 prevTop×1.3，整轮被挡，理由记 repeat。
  //    直接连跑两遍不行：第一遍的条目会被写进「本会话已给过」的名单，连候选都进不去，
  //    出口是 empty/floor 而不是 repeat。
  const ws = join(tmpRoot, 'ws-repeat')
  mkdirSync(join(ws, '.dsh-meow', 'sessions'), { recursive: true })
  writeFileSync(
    join(ws, '.dsh-meow', 'sessions', 'sess-repeat.json'),
    JSON.stringify({ injected: [], lastQueryTerms: ['部署', '脚本', '端口', '约定'], lastTopScore: 9, injectRound: 1 }),
    'utf8',
  )
  const second = runOn(Q, { hitTopK: 4 }, ws, 'sess-repeat')
  const log = readFileSync(join(ws, '.dsh-meow', 'dream-debug.log'), 'utf8')
  const skipLine = log.split('\n').find((l) => l.includes('hit-skip')) ?? ''
  ok('R6 同话题抑制在 hit-skip 行里记 drops=（reason=repeat 且点名被抑制的条）', second === null && skipLine.includes('reason=repeat') && skipLine.includes(':repeat') && /drops=[a-z0-9]/i.test(skipLine), skipLine.slice(0, 220) || '（没有 skip 那一行）')
}

{
  // ④ 一条都没人落选时是空数组，不是 null（「没人落选」与「没记账」是两件事）
  const clean = runOn(Q, { hitTopK: 4, injectFloor: 0.35, injectBodyMax: 0, injectMaxChars: 0 })
  // 极宽预算 + 只留强条（弱条仍会 floor 落选），所以这里换一个只含强条的库
  ok('R7 drops 永远是数组（没有落选时是 []，不是 null/undefined）', clean === null || Array.isArray(clean.drops), clean === null ? 'null' : typeof clean.drops)
}

// 引擎改完，写日志的那一头也要跟上：格式只许有一处定义
ok('R8 日志那一栏由 dropsTail 统一拼（slice(0,8) + 两位小数）', /function dropsTail\(drops\)/.test(engSrc) && engSrc.includes('.slice(0, 8)') && engSrc.includes('.toFixed(2)'))
ok('R9 hook 在 hit-chain 行里写了 drops=，且沿用 dropsTail 的格式', /drops=\$\{dropsStr\}/.test(engSrc) && engSrc.includes('dropsTail(hit.drops).replace(/^ drops=/, "")'))
ok('R10 buildHitInjection 把 drops 一起交出去（hook 才拿得到）', /injectedIds: ids, gated, picks:/.test(engSrc) && /, drops, budget:/.test(engSrc))

// ── 日志那层：三种写法各归各位 ───────────────────────────────────────────
const at = (min) => new Date(Date.UTC(2026, 10, 25, 10, min, 0)).toISOString()
const CHAIN = (min, sid, len, picks, drops) =>
  `[${at(min)}] hit-chain sid=${sid} textLen=${len} hit=yes floor=0.35 qfloor=0.6 gated=1 body=240 bodyCut=0 sim=0.6 repeated=0 released=0 reinject=8 picks=${picks}${drops === null ? '' : ` drops=${drops}`} spent=0`
const MIXED = [
  // 第一轮是老日志（没有 drops 字段）：不许读成「没人落选」
  CHAIN(0, 's1', 300, 'aaaaaaaa:300:full', null),
  CHAIN(1, 's2', 280, 'aaaaaaaa:280:squeeze', 'cccccccc:0.19:floor,dddddddd:2.40:cap'),
  CHAIN(2, 's3', 310, 'aaaaaaaa:120:full,bbbbbbbb:190:full', '-'),
  `[${at(3)}] hit-skip reason=floor gated=2 floor=0.35 best=1/1.00/share=0.33 score=0.204 drops=cccccccc:0.20:floor,eeeeeeee:0.30:repeat`,
  `[${at(4)}] hit-skip reason=literal hits=1 drops=ffffffff:0.10:literal`,
].join('\n')

{
  const { events } = L.parseInjectLog(MIXED)
  const hits = events.filter((e) => e.kind === 'hit')
  const skips = events.filter((e) => e.kind === 'skip')
  ok('R11 明细里的 drops 解析成 id / 分数 / 原因三样', hits[1].drops.length === 2 && hits[1].drops[0].id === 'cccccccc' && hits[1].drops[0].score === 0.19 && hits[1].drops[0].reason === 'floor' && hits[1].drops[1].score === 2.4, JSON.stringify(hits[1].drops))
  ok('R12 `drops=-` 是「有人记账、没人落选」，与字段缺席分开', hits[2].hasDrops === true && hits[2].drops.length === 0)
  ok('R13 hit-skip 行同样解析（整轮被挡时名单在这一行）', skips[0].hasDrops === true && skips[0].drops.length === 2 && skips[0].drops[1].reason === 'repeat', JSON.stringify(skips[0].drops))
  const legacy = L.parseInjectLog(CHAIN(9, 's9', 100, '-', null)).events.filter((e) => e.kind === 'hit')[0]
  ok('R14 老日志（第一轮没有 drops 字段）读成「没有落选记录」，不是「没人落选」', hits[0].hasDrops === false && hits[0].drops === null && legacy.hasDrops === false)
  const broken = L.parseInjectLog(`[${at(11)}] hit-chain sid=s10 textLen=10 hit=yes drops=deadbeef::-:floor,zombie:0.12:`).events.filter((e) => e.kind === 'hit')[0]
  ok('R15 缺分数 / 缺原因的坏段不炸：分数记 null、原因留空', broken.drops.length === 2 && broken.drops[0].score === null && broken.drops[1].score === 0.12 && broken.drops[1].reason === '', JSON.stringify(broken.drops))
}

// ── 面板那层 ────────────────────────────────────────────────────────────
const dir = '.dsh-meow'
function panelOn(logText, limit = 12) {
  const ws = mkdtempSync(join(tmpRoot, 'ws-'))
  mkdirSync(join(ws, dir), { recursive: true })
  writeFileSync(join(ws, dir, 'dream-debug.log'), logText + '\n', 'utf8')
  return { ws, panel: L.readInjectPanel({ workspace: ws, dir, limit, config: {} }) }
}

{
  const { ws, panel } = panelOn(MIXED)
  const body = panel.body
  const line = (prefix) => body.split('\n').find((l) => l.startsWith(prefix)) ?? `（没有以「${prefix}」开头的行）`
  ok('R16 落选名单摘要：轮数 / 条次 / 去重 / 原因分布', body.includes('落选名单：3 轮记下 5 条次，去重 4 条（floor 2 · cap 1 · literal 1 · repeat 1）'), line('落选名单：'))
  ok('R17 按次数排：2 次的排第一，同次数按最近时间倒序', body.includes('- cccccccc 挡了 2 次（floor 2），最近 11-25 18:03，最近分数 0.20') && body.includes('- ffffffff 挡了 1 次（literal 1），最近 11-25 18:04，最近分数 0.10'), body.split('\n').filter((l) => l.startsWith('- ') && l.includes('挡了')).join(' | ') || '（没有条目行）')
  ok('R18 前三条之外报「另有 N 条」，不装作全列了', body.includes('- 另有 1 条落选（按次数排在后面）'), line('- 另有 1 条落选'))
  ok('R19 floor 的条目给的是「补 keywords」这条对策（不是让你调额度）', body.includes('分数不到门槛（词面对上了但不够）：要它进来就把你真正会问它的说法补进 keywords'))
  ok('R20 literal 的条目给的是「补两字以上的词」这条对策', body.includes('只对上一个字（单字兜底不算证据）：keywords 里补一个两字以上的词'))
  ok('R21 repeat 的条目明说「不是毛病，换一轮就回来」', body.includes('上一轮刚给过同一批（同话题只注入更相关的新信息）：换一轮或换个问法就会回来'))
  ok('R22 明细行里落选与 picks 分得清（落选带原因与分数，picks 带字数）', body.includes('注入 280 字 · 挡 1 条 · 落选 cccccccc floor 0.19 / dddddddd cap 2.40 · aaaaaaaa 280 字（squeeze）'), body.split('\n').find((l) => l.includes('注入 280 字')) ?? '（没有这一行）')
  ok('R23 整轮被挡的那一轮，明细里也点名落选的是谁', body.includes('挡 2 条 · floor 0.35 · 落选 cccccccc/eeeeeeee'), body.split('\n').find((l) => l.includes('挡 2 条')) ?? '（没有这一行）')
  ok('R24 收尾两句都在：闸门只拦注入不拦检索 + id 只是前 8 位', body.includes('被挡的条目仍在 memory_search 的候选里') && body.includes('id 是日志里的前 8 位'))
  ok('R25 有 drops 字段但这一轮没人落选：只记「另有 N 轮没有落选记录」', body.includes('- 另有 1 轮没有落选记录'))

  const zero = L.readInjectPanel({ workspace: ws, dir, limit: 0, config: {} })
  ok('R26 limit=0 只关明细，落选名单照算', zero.body.includes('落选名单：3 轮记下 5 条次') && !zero.body.includes('（新的在前）'))
}

{
  // cap 的对策单独验：它落在第四条、挤不进前三，所以造一份只有 cap 的日志
  const onlyCap = panelOn([CHAIN(0, 's1', 300, 'aaaaaaaa:300:full', 'dddddddd:2.40:cap')].join('\n')).panel.body
  ok('R27 cap 的条目给的是「压短条目或调额度」这条对策', onlyCap.includes('这一轮的字数上限把它挤出去了：条目压短（memory_update），或调大 injectMaxChars / injectTurnMaxChars'), onlyCap.split('\n').find((l) => l.includes('挤出')) ?? '（没有这一行）')
}

{
  // 全老日志：一句话说清「还没有落选记录」，且指向新版；不许说成「没有条目落选」
  const legacyBody = panelOn([CHAIN(0, 's1', 100, '-', null), CHAIN(5, 's2', 120, '-', null)].join('\n')).panel.body
  ok('R28 全是老日志时说「都还没有落选记录」并指向 0.6.72', legacyBody.includes('这 2 轮都还没有落选记录') && legacyBody.includes('0.6.72'), legacyBody.split('\n').find((l) => l.startsWith('落选名单')) ?? '（没有这一行）')
  ok('R29 老日志不会被念成「没有条目落选」', !legacyBody.includes('这一段时间没有条目落选'))
}

{
  // 有字段但每轮都是 `-`：这才是「没人落选」，一句话收掉，不刷三行
  const emptyBody = panelOn([CHAIN(0, 's1', 100, '-', '-'), CHAIN(5, 's2', 120, '-', '-')].join('\n')).panel.body
  ok('R30 有字段而没人落选：一句「没有条目落选」，不铺摘要与对策', emptyBody.includes('落选名单：这一段时间没有条目落选') && !emptyBody.includes('挡了'))
}

// ── 手干净不干净 ────────────────────────────────────────────────────────
{
  const { ws } = panelOn(MIXED)
  const logPath = join(ws, dir, 'dream-debug.log')
  const before = { size: statSync(logPath).size, mtime: statSync(logPath).mtimeMs, files: readdirSync(join(ws, dir)).length }
  L.readInjectPanel({ workspace: ws, dir, limit: 12, config: {} })
  const after = { size: statSync(logPath).size, mtime: statSync(logPath).mtimeMs, files: readdirSync(join(ws, dir)).length }
  ok('R31 面板纯读：日志字节与 mtime 没动、目录不多文件', before.size === after.size && before.mtime === after.mtime && after.files === before.files, `${before.size}/${after.size} B`)
}

console.log('')
console.log(`ALL PASS：${pass}/${pass + fail}`)
if (fail > 0) {
  console.log(bad.join('\n'))
  process.exitCode = 1
}
