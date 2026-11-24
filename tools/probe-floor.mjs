/**
 * 探针：命中闸门（0.6.40 · 省 token 不加噪声）
 *
 * 为什么要有这一支：长期记忆的「命中注入」是每轮都发生的固定开销，而 0.6.39 之前的
 * 逻辑是**有命中就注入**——`keywordHitScore` 没有任何分数下限，于是「跑一下测试」
 * 「继续」「帮我看看这个文件」这类问句也会把 0.30~0.42 分的条目正文搬进上下文，
 * 而每条被注入的正文都会留在历史里，之后每轮重新计费。
 *
 * 0.6.40 加一道闸门 `injectFloor`（默认 0.45，0 = 关）：分数不到线的命中不注入。
 * 这一支守的是五条底线：
 *  ① 闸门只拦注入、不拦检索——被挡的条目不许被记成「已注入」（不写 seen、不加 hit_count），
 *     下一轮真问到它时还能进来；模型要它也可以自己 memory_search。
 *  ② 该注入的必须照旧注入：真库实测 9 条记忆相关问句在 0.45 线下**全部**注入成功。
 *  ③ 0 = 关必须**逐位**回到 0.6.39：输出与 `renderHitEntries` 直接渲染一字不差。
 *  ④ 门槛可调且方向单调：抬高只会更少，不会忽然多注入。
 *  ⑤ 配置写坏（字符串 / 负数 / NaN）不许变成「闸门关了」——一律回默认 0.45。
 */
import { root } from './_root.mjs'
import { readFileSync, mkdtempSync, mkdirSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const V = await import(pathToFileURL(join(root, 'vendor', 'meow-memory', 'lib', 'index.js')).href)
const src = readFileSync(join(root, 'vendor', 'meow-memory', 'lib', 'index.js'), 'utf8')

let pass = 0
let fail = 0
const bad = []
function ok(name, cond, detail) {
  if (cond) {
    pass++
    console.log('PASS ' + name + (detail ? '  ' + detail : ''))
  } else {
    fail++
    bad.push(name + '  ' + (detail ?? ''))
    console.log('FAIL ' + name + '  ' + (detail ?? ''))
  }
}

// ── 夹具：三条条目，强命中 1.32 分、弱命中 0.09 分（都实测过，不是猜的）────────
const NOW = Date.UTC(2026, 10, 24, 12, 0)
const mkRow = (id, level, kws, imp) => ({
  id, level, title: null, content: kws.join(' '), keywords: kws, importance: imp,
  status: 'active', source_session: 'other-session', project: '全局',
  created_at: NOW - 86400000, updated_at: NOW - 3600000, last_accessed_at: null,
})
const ROWS = [
  mkRow('gate0001', 'lesson', ['注入闸门', 'injectFloor', '命中分数下限', '省 token'], 3),
  mkRow('gate0002', 'fact', ['测试', '脚本', '跑一下', '单元测试', '日志', '格式化', '重构'], 1),
  mkRow('gate0003', 'topic', ['星图', '邻域', 'nebula_link', 'mute', '断边'], 2),
]
const Q_MIX = '注入闸门的测试怎么写' // → gate0001 ≈1.324、gate0002 ≈0.089
const Q_STRONG = '星图 mute 怎么断边' // → gate0003 ≈1.839
const Q_OFF = '把注释补上' // → 无命中

let bumped = []
function stubDb() {
  bumped = []
  return {
    list: (level) => ROWS.filter((r) => r.level === level),
    bumpHit: (level, id) => { bumped.push(id) },
    isFresh: () => false,
    idsBySession: () => [],
    findById: (id) => ({ row: ROWS.find((r) => r.id === id) }),
  }
}

const wsRoot = mkdtempSync(join(tmpdir(), 'probe-floor-'))
mkdirSync(join(wsRoot, '.dsh-meow'), { recursive: true })
function run(q, opts, sid = 'sess-floor-' + Math.random().toString(36).slice(2, 8)) {
  return V.buildHitInjection(stubDb(), wsRoot, sid, q, opts, '.dsh-meow')
}
function seenOf(sid) {
  const dir = join(wsRoot, '.dsh-meow', 'sessions')
  let files = []
  try { files = readdirSync(dir) } catch { return [] }
  const out = []
  for (const f of files) {
    try {
      const j = JSON.parse(readFileSync(join(dir, f), 'utf8'))
      if (Array.isArray(j.injected)) out.push(...j.injected)
    } catch { /* 坏行不算 */ }
  }
  return out
}

// ── F1 形状：常量 / 默认值 / 配置面五处 / 观测字段 ────────────────────────────
{
  ok('F1 默认分线常量在位（0.45）', src.includes('var INJECT_FLOOR_DEF = 0.45;'))
  ok('F1 DEFAULT_OPTS 带上闸门（0.6.44 起还带注入节奏两项：会话预算 0 / 同话题 0.6）',
    /var DEFAULT_OPTS = \{ hitTopK: 2, titleMax: 40, injectMaxChars: 0, injectFloor: INJECT_FLOOR_DEF, injectBodyMax: INJECT_BODY_MAX_DEF, injectSessionBudget: 0, injectRepeatSim: INJECT_REPEAT_SIM_DEF \};/.test(src))
  ok('F1 CONFIG_DEFAULTS 里是字面 0.45（模块求值早于常量赋值）', /injectFloor: 0\.45,/.test(src))
  ok('F1 zod schema 默认跟常量走', src.includes('injectFloor: z.number().min(0).default(INJECT_FLOOR_DEF),'))
  ok('F1 设置页校验会挡坏值', src.includes('reqNum("injectFloor");'))
  ok('F1 resolveConfig 落成非负小数并回默认', src.includes('injectFloor: Number.isFinite(c.injectFloor) ? Math.max(0, c.injectFloor) : INJECT_FLOOR_DEF,'))
  ok('F1 配置进了热生效白名单', /LIVE_CONFIG_KEYS = \[[^\]]*"injectFloor"/.test(src))
  ok('F1 pre-step 把闸门透传下去', src.includes('injectFloor: resolved.injectFloor'))
  ok('F1 日志里看得见这一轮的线与挡了几条', /hit-chain[^`]*floor=\$\{resolved\.injectFloor\} gated=/.test(src))
  ok('F1 闸门判断只有一处（分数比较不许散落）', (src.match(/h\.score < floor/g) ?? []).length === 1)
}

// ── F2 默认 0.45：该挡的挡、该留的留 ────────────────────────────────────────
{
  const r = run(Q_MIX, {})
  ok('F2 默认线下：强命中照旧注入', r !== null && r.injectedIds.length === 1 && r.injectedIds[0] === 'gate0001',
    r === null ? 'null' : r.injectedIds.join(','))
  ok('F2 默认线下：弱命中被挡，且挡了几条写在回执里', r !== null && r.gated === 1, 'gated ' + (r?.gated ?? '—'))
  ok('F2 默认线下：回执里带 floor 与 gated（观测面不许空）',
    r !== null && r.budget.floor === 0.45 && r.budget.gated === 1)
  const rs = run(Q_STRONG, {})
  ok('F2 另一条强命中（星图断边）也照旧注入', rs !== null && rs.injectedIds[0] === 'gate0003' && rs.gated === 0)
  ok('F2 完全无关的问句不注入（连空壳都不发）', run(Q_OFF, {}) === null)
}

// ── F3 0 = 关：逐位回到 0.6.39 ───────────────────────────────────────────────
{
  const q = Q_MIX
  const off = run(q, { injectFloor: 0 })
  const fresh = V.keywordHitScore(q, ROWS.map((r) => ({
    id: r.id, level: r.level, title: r.title, content: r.keywords.join(' '), keywords: r.keywords,
    project: r.project, importance: r.importance, status: r.status, updated_at: r.updated_at, created_at: r.created_at,
  })), { k: 2 })
  const byId = new Map(ROWS.map((r) => [r.id, r]))
  const same = fresh.map((h) => ({
    id: h.id, level: h.level, content: byId.get(h.id)?.content ?? h.content,
    project: byId.get(h.id)?.project ?? null, updated_at: byId.get(h.id)?.updated_at ?? null,
  }))
  const legacy = V.renderHitEntries(same, { injectMaxChars: 0, titleMax: 40 }, q).text
  ok('F3 关闸后两条都进来（闸门是唯一变量）', off !== null && off.injectedIds.length === 2 && off.gated === 0,
    off === null ? 'null' : off.injectedIds.join(','))
  ok('F3 关闸后的正文与旧渲染器逐字相同（没有任何字段被改动）', off !== null && off.text === legacy,
    off === null ? 'null' : `len ${off.text.length} vs ${legacy.length}`)
  ok('F3 关闸后不写 gated 统计（省 token 的账只算真挡过的）', off !== null && off.budget.gated === 0)
}

// ── F4 被挡的条目不带后遗症：不进 seen、不加 hit_count ───────────────────────
{
  const sid = 'sess-floor-gated'
  rmSync(join(wsRoot, '.dsh-meow'), { recursive: true, force: true })
  mkdirSync(join(wsRoot, '.dsh-meow'), { recursive: true })
  const r = V.buildHitInjection(stubDb(), wsRoot, sid, Q_MIX, {}, '.dsh-meow')
  const seen = seenOf(sid)
  ok('F4 注入成功时只把真注入的那条记成已注入', r !== null && seen.includes('gate0001'), seen.join(',') || '—')
  ok('F4 被挡的条目不许进 seen（下一轮真问到它还得能进来）', !seen.includes('gate0002'))
  ok('F4 被挡的条目不许加 hit_count', bumped.join(',') === 'gate0001', bumped.join(',') || '—')
  // 第二轮：把带 gate0002 的问句单独问一次，它必须还能进来
  const r2 = V.buildHitInjection(stubDb(), wsRoot, sid, '测试 脚本 跑一下 单元测试 日志 格式化 重构', { injectFloor: 0 }, '.dsh-meow')
  ok('F4 被挡过的条目下一轮仍可被注入（闸门不是黑名单）', r2 !== null && r2.injectedIds.includes('gate0002'),
    r2 === null ? 'null' : r2.injectedIds.join(','))
}

// ── F5 门槛可调、方向单调 ────────────────────────────────────────────────────
{
  const at = (f) => {
    const r = run(Q_MIX, { injectFloor: f })
    return r === null ? 0 : r.injectedIds.length
  }
  ok('F5 门槛 0 → 2 条', at(0) === 2, String(at(0)))
  ok('F5 门槛 0.45 → 1 条', at(0.45) === 1, String(at(0.45)))
  ok('F5 门槛 1.5 → 0 条（强命中 1.324 也被挡）', at(1.5) === 0, String(at(1.5)))
  ok('F5 方向单调：0 ≥ 0.45 ≥ 1.5', at(0) >= at(0.45) && at(0.45) >= at(1.5))
  ok('F5 门槛很小但非零（0.05）时弱命中能进来', run(Q_MIX, { injectFloor: 0.05 })?.injectedIds.includes('gate0002') === true)
}

// ── F6 配置写坏的两种待遇：非数字回默认，负数夹成 0（显式关闸）──────────────
{
  const bad1 = run(Q_MIX, { injectFloor: Number.NaN })
  const bad2 = run(Q_MIX, { injectFloor: '0.9' })
  ok('F6 非数字（NaN / 字符串）按默认 0.45 走：弱命中仍被挡',
    [bad1, bad2].every((r) => r !== null && r.gated === 1),
    [bad1, bad2].map((r) => (r === null ? 'null' : `g${r.gated}`)).join('/'))
  ok('F6 非数字时回执里的 floor 仍是有效数字 0.45', [bad1, bad2].every((r) => r !== null && r.budget.floor === 0.45))
  const neg = run(Q_MIX, { injectFloor: -1 })
  ok('F6 负数夹成 0＝显式关闸：两条都进、且回执里的 floor 是 0',
    neg !== null && neg.injectedIds.length === 2 && neg.gated === 0 && neg.budget.floor === 0,
    neg === null ? 'null' : `floor ${neg.budget.floor} ids ${neg.injectedIds.join(',')}`)
}

// ── F7 读数量级（写进文档的数字从这儿来）─────────────────────────────────────
{
  console.log('')
  console.log('MEASURE 夹具上「注入闸门开/关」的条数与字数：')
  for (const [q, label] of [[Q_MIX, '混合问句'], [Q_STRONG, '强命中'], [Q_OFF, '无关问句']]) {
    const on = run(q, {})
    const off = run(q, { injectFloor: 0 })
    const fmt = (r) => (r === null ? '不注入' : `${r.injectedIds.length} 条 / ${r.text.length} 字${r.gated ? ` / 挡 ${r.gated}` : ''}`)
    console.log(`  ${label.padEnd(6, '　')} 开=${fmt(on)}　关=${fmt(off)}`)
  }
  console.log('')
}

try { rmSync(wsRoot, { recursive: true, force: true }) } catch { /* 临时目录清不掉不影响判定 */ }

console.log('')
if (fail === 0) console.log(`ALL PASS · probe-floor ${pass}/${pass}`)
else {
  console.log(`FAILED ${fail} / ${pass + fail}`)
  for (const b of bad) console.log('  ✗ ' + b)
}
process.exit(fail === 0 ? 0 : 1)
