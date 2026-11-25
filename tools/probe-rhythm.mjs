/**
 * 探针：注入节奏（0.6.44 · 会话累计预算 + 同话题延续）
 *
 * 为什么要有这一支：0.6.40 的 `injectFloor` 治的是**单轮**浪费（「跑一下测试」「继续」
 * 这类问句也注入）。剩下的浪费在**频率**上——一个会话里的追问是连续的，
 * 「注入上限怎么设 → 那默认多少 → 面板在哪」这种，每轮都会命中一批**新的**相近条目，
 * 而模型上一轮刚看过同一批东西。真库标定（824 条 / 16 问）：6 问已被 0.45 闸挡掉，
 * 剩下 10 轮平均 338 字——单轮体积不大，**轮次**才是账。
 *
 * 这一支守的五条底线：
 *  ① 两道闸默认都不生效（会话预算 0＝不限；同话题只在「上一轮真注入过」时才判），
 *     不传新字段必须与 0.6.43 逐位相同；
 *  ② 预算到顶就别白检索、也别注入（但账本一个字都不许被改坏）；
 *  ③ 同话题抑制只挡「不比上轮明显更相关」的条目，出现真新信息照样注入——省不能削能力；
 *  ④ 记账必须真的写进会话文件（累计字数 / 上轮词面 / 上轮最高分），否则下一轮判不准；
 *  ⑤ 五个配置面（默认值 / schema / 校验 / resolveConfig / 热生效白名单）+ 面板字段表
 *     一处不漏，不然「用户调了没反应」。
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { root } from './_root.mjs'

const V = await import(pathToFileURL(join(root, 'vendor', 'meow-memory', 'lib', 'index.js')).href)
const src = readFileSync(join(root, 'vendor', 'meow-memory', 'lib', 'index.js'), 'utf8')
const patchSrc = readFileSync(join(root, 'tools', 'patch-settings-fields.mjs'), 'utf8')

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

// ── 夹具：四条条目，关键词长度不同 → 同一问句上分数自然分档 ──────────────────
const NOW = Date.UTC(2026, 10, 24, 12, 0)
const mkRow = (id, level, kws, imp) => ({
  id, level, title: null, content: kws.join(' '), keywords: kws, importance: imp,
  status: 'active', source_session: 'other-session', project: '全局',
  created_at: NOW - 86400000, updated_at: NOW - 3600000, last_accessed_at: null,
})
const ROWS = [
  mkRow('rh000001', 'lesson', ['星图邻域', '强度下限', '邻居强度', 'neighborMinScore'], 3),
  mkRow('rh000002', 'fact', ['星图邻域', '邻居条数', 'neighborMax', '每轮几条'], 2),
  mkRow('rh000003', 'topic', ['星图邻域', '阈值', '门槛'], 2),
  mkRow('rh000004', 'fact', ['厨房', '酸菜鱼', '火候'], 1),
]
const Q_PREV = '星图邻域注入的强度下限怎么调'
const Q_SAME = '星图邻域注入的强度下限调高会怎样'
const Q_OTHER = '酸菜鱼的火候怎么掌握'

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

const wsRoot = mkdtempSync(join(tmpdir(), 'probe-rhythm-'))
mkdirSync(join(wsRoot, '.dsh-meow', 'sessions'), { recursive: true })

function seenFileOf(sid) {
  const safe = String(sid).replace(/[^A-Za-z0-9._-]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`)
  return join(wsRoot, '.dsh-meow', 'sessions', `${safe}.json`)
}
/** 预置一份会话账本（模拟「上一轮已经注入过」的状态）。 */
function seed(sid, extra) {
  writeFileSync(seenFileOf(sid), JSON.stringify({ injected: [], ...extra }), 'utf8')
}
function readSeen(sid) {
  try {
    return JSON.parse(readFileSync(seenFileOf(sid), 'utf8'))
  } catch {
    return null
  }
}
function run(q, opts, sid) {
  return V.buildHitInjection(stubDb(), wsRoot, sid, q, opts, '.dsh-meow')
}
const PREV_TERMS = V.injectTermsOf(Q_PREV)
// [0.6.73] 陪跑线关掉：这一支验节奏与额度，不同时验两道闸。
const baseOpts = { injectMaxChars: 0, injectFloor: 0, injectBodyMax: 240, injectMarginRatio: 0 }

// ── R0 形状：常量与出厂值 ──────────────────────────────────────────────────
{
  ok('R0 常量在位：同话题 0.25（实测线）/ 抬分 1.3 / 最少 4 个词面',
    src.includes('var INJECT_REPEAT_SIM_DEF = 0.25;') &&
      src.includes('var INJECT_REPEAT_BOOST_DEF = 1.3;') &&
      src.includes('var INJECT_REPEAT_MIN_TERMS = 4;'))
  ok('R0 CONFIG_DEFAULTS 里是字面值（模块求值早于常量）：预算 0 / 同话题 0.25',
    /injectSessionBudget: 0,[\s\S]{0,600}?injectRepeatSim: 0\.25,/.test(src))
  ok('R0 词面重合度函数的纯函数在（Jaccard，不用向量、不等 LLM）',
    src.includes('function termOverlapOf(a, b) {') && typeof V.buildHitInjection === 'function')
}

// ── R1 默认不生效：老会话 + 不传新字段 = 0.6.43 行为 ────────────────────────
{
  const sid = 'sess-r1-default'
  const r = run(Q_SAME, baseOpts, sid)
  ok('R1 不传两个新字段、会话文件里也没有节奏账 → 照常注入（默认不改变行为）',
    r !== null && r.injectedIds.length > 0, r === null ? 'null' : `${r.injectedIds.length} 条 / ${r.text.length} 字`)
  ok('R1 上轮最高分是 0 时绝不判同话题（没有上一轮就谈不上「延续」）',
    r !== null && r.budget.repeated === 0, `repeated=${r?.budget?.repeated}`)
  // 老会话文件（只有 injected）不迁移也不炸
  const sid2 = 'sess-r1-legacy'
  writeFileSync(seenFileOf(sid2), JSON.stringify({ injected: ['rh000001'], currentProject: null }), 'utf8')
  const r2 = run(Q_OTHER, baseOpts, sid2)
  ok('R1 0.6.43 的老会话文件（没有三个节奏字段）照样能用', r2 !== null && r2.injectedIds.length > 0,
    r2 === null ? 'null' : r2.injectedIds.join(','))
}

// ── R2 闸①：会话累计预算 ───────────────────────────────────────────────────
{
  const sid = 'sess-r2-budget'
  seed(sid, { injectChars: 1000 })
  const over = run(Q_SAME, { ...baseOpts, injectSessionBudget: 500 }, sid)
  ok('R2 累计已超预算 → 整轮不注入（也不写 seen / 不 bumpHit）',
    over === null && readSeen(sid).injected.length === 0 && bumped.length === 0, String(over))
  const off = run(Q_SAME, { ...baseOpts, injectSessionBudget: 0 }, sid)
  ok('R2 预算设 0＝不限：同样的账本照样注入（默认就是这档）', off !== null && off.injectedIds.length > 0,
    off === null ? 'null' : `${off.injectedIds.length} 条`)

  const sid2 = 'sess-r2-under'
  seed(sid2, { injectChars: 400 })
  const under = run(Q_SAME, { ...baseOpts, injectSessionBudget: 2000 }, sid2)
  const after = readSeen(sid2)
  ok('R2 预算还没花完 → 注入，并把「已花多少 / 上限多少」带在读数里',
    under !== null && under.budget.spent === 400 + under.text.length && under.budget.sessionBudget === 2000,
    under === null ? 'null' : `spent=${under.budget.spent}`)
  ok('R2 累计字数真的落进会话文件（下一轮接着算，不是每次从头）',
    after !== null && after.injectChars === 400 + under.text.length, `文件里 ${after?.injectChars}`)
  // [0.6.47] 「门槛只判进门不判出门」的回归：剩 100 字装不下一条像样的正文 →
  // 不是硬灌一条 300 字的，也不是灌个骨架，而是整轮不注入，并在日志里说清剩多少。
  const sid3 = 'sess-r2-remain'
  seed(sid3, { injectChars: 400 })
  const tight = run(Q_SAME, { ...baseOpts, injectSessionBudget: 500 }, sid3)
  ok('R2 剩余额度装不下一条正文 → 整轮不注入（不灌骨架、不顶穿上限）', tight === null, String(tight))
  const logText = readFileSync(join(wsRoot, '.dsh-meow', 'dream-debug.log'), 'utf8')
  ok('R2 这种挡法在日志里自述 remain（和「已经到顶」同一个出口）',
    /hit-skip reason=budget .*remain=100 /.test(logText), logText.split('\n').filter((l) => l.includes('reason=budget')).pop() ?? '没有 budget 行')
}

// ── R3 闸②：同话题延续 ────────────────────────────────────────────────────
{
  // 上一轮注入时最高分 9.0：这一轮候选（≤ 3 分左右）全部低于 9.0×1.3 → 整轮省掉。
  const sid = 'sess-r3-same'
  seed(sid, { lastQueryTerms: PREV_TERMS, lastTopScore: 9.0, injectChars: 300 })
  const same = run(Q_SAME, baseOpts, sid)
  ok('R3 同话题 + 候选都不比上轮明显更相关 → 这一轮不注入（省的是重复，不是能力）',
    same === null, same === null ? 'null' : `${same.injectedIds.join(',')} / ${same.text.length} 字`)
  // 换个独立会话：同样账本、把闸关掉，必须又注入（证明挡它的就是这道闸）。
  const sidOff = 'sess-r3-off'
  seed(sidOff, { lastQueryTerms: PREV_TERMS, lastTopScore: 9.0, injectChars: 300 })
  const open = run(Q_SAME, { ...baseOpts, injectRepeatSim: 1 }, sidOff)
  ok('R3 把同话题调成 1（关）→ 同样的账本又注入了（证明挡它的就是这道闸）',
    open !== null && open.injectedIds.length > 0, open === null ? 'null' : `${open.injectedIds.length} 条`)

  // 换话题：词面重合度不到 0.25，不该被抑制。
  const sidOther = 'sess-r3-other'
  seed(sidOther, { lastQueryTerms: PREV_TERMS, lastTopScore: 9.0, injectChars: 300 })
  const other = run(Q_OTHER, baseOpts, sidOther)
  ok('R3 换了一个话题（「酸菜鱼的火候」）→ 不判同话题，照常注入',
    other !== null && other.injectedIds.includes('rh000004'), other === null ? 'null' : other.injectedIds.join(','))

  // 上轮最高分很低 → 抬分门槛也低，真新信息照样进来（省不能削能力）。
  const sid2 = 'sess-r3-cheap'
  seed(sid2, { lastQueryTerms: PREV_TERMS, lastTopScore: 0.01, injectChars: 300 })
  const cheap = run(Q_SAME, baseOpts, sid2)
  ok('R3 上轮最高分很低时同话题也照常注入（门槛跟着上轮实际水平走，不是硬压）',
    cheap !== null && cheap.injectedIds.length > 0, cheap === null ? 'null' : `${cheap.injectedIds.length} 条`)

  // 短句不判同话题：词面少于 4 条时重合度不可信。
  const sid3 = 'sess-r3-short'
  seed(sid3, { lastQueryTerms: PREV_TERMS, lastTopScore: 9.0, injectChars: 300 })
  const short = run('星图', { ...baseOpts, injectFloor: 0 }, sid3)
  ok('R3 短句（去虚词后词面不足 4 条）不判同话题——一个词不构成「话题延续」的证据',
    short !== null, short === null ? 'null' : `${short.injectedIds.length} 条`)
}

// ── R4 记账：上轮词面与最高分写回会话文件 ──────────────────────────────────
{
  const sid = 'sess-r4-ledger'
  const r = run(Q_SAME, baseOpts, sid)
  const seen = readSeen(sid)
  ok('R4 注入后文件里记下本轮词面（下一轮比它判同话题）',
    seen !== null && Array.isArray(seen.lastQueryTerms) && seen.lastQueryTerms.length >= 4 &&
      seen.lastQueryTerms.includes('星图') && seen.lastQueryTerms.includes('邻域'),
    seen === null ? '没文件' : seen.lastQueryTerms.slice(0, 6).join(','))
  ok('R4 记下本轮最高分（下一轮的抬分门槛 = 它 × 1.3）',
    seen !== null && Number.isFinite(seen.lastTopScore) && seen.lastTopScore > 0 && seen.lastTopScore >= (r?.budget ? 0 : 0),
    `lastTopScore=${seen?.lastTopScore}`)
  ok('R4 词面最多存 60 条（账本别被长问句撑爆）',
    seen !== null && seen.lastQueryTerms.length <= 60, String(seen?.lastQueryTerms.length))
}

// ── R5 配置面与面板：五个口子 + 字段表 ─────────────────────────────────────
{
  ok('R5 zod schema：预算 min(0) / 同话题 0–1', /injectSessionBudget: z\.number\(\)\.min\(0\)\.default\(0\),/.test(src) &&
    /injectRepeatSim: z\.number\(\)\.min\(0\)\.max\(1\)\.default\(INJECT_REPEAT_SIM_DEF\),/.test(src))
  ok('R5 设置页校验认这两项', src.includes('reqNum("injectSessionBudget");') && src.includes('reqNum("injectRepeatSim");'))
  ok('R5 resolveConfig：预算非负整数、同话题夹到 [0,1]',
    src.includes('injectSessionBudget: Number.isFinite(c.injectSessionBudget) ? Math.max(0, Math.floor(c.injectSessionBudget)) : 0,') &&
      src.includes('injectRepeatSim: Number.isFinite(c.injectRepeatSim) ? Math.min(1, Math.max(0, c.injectRepeatSim)) : INJECT_REPEAT_SIM_DEF,'))
  ok('R5 两项都在热生效白名单里', /LIVE_CONFIG_KEYS = \[[^\]]*"injectSessionBudget"[^\]]*"injectRepeatSim"/.test(src))
  ok('R5 pre-step 把两项透传下去', src.includes('injectSessionBudget: resolved.injectSessionBudget') &&
    src.includes('injectRepeatSim: resolved.injectRepeatSim'))
  ok('R5 观测：dream-debug.log 的 hit-chain 行带 repeated / spent / 上限',
    /hit-chain[^`]*repeated=\$\{hit === null \? 0 : hit\.budget\?\.repeated \?\? 0\}/.test(src))
  ok('R5 面板字段表里有这两项（构建期补丁，三语各 4 条）',
    patchSrc.includes("{ key: 'injectSessionBudget', type: 'num', group: 'inject' }") &&
      patchSrc.includes("{ key: 'injectRepeatSim', type: 'num', group: 'inject' }") &&
      (patchSrc.match(/settings\.field\.injectSessionBudget\.hint/g) ?? []).length === 4 &&
      (patchSrc.match(/settings\.field\.injectRepeatSim\.hint/g) ?? []).length === 4)
  ok('R5 面板出厂值与引擎默认逐个相等（0 / 0.25）',
    patchSrc.includes('injectSessionBudget: 0,') && patchSrc.includes('injectRepeatSim: 0.25,'))
  const client = readFileSync(join(root, 'lib', 'client.js'), 'utf8')
  ok('R5 产物 bundle 里真的有这两组文案（重建过，不是只改了补丁）',
    client.includes('injectSessionBudget') && client.includes('injectRepeatSim') &&
      /injectRepeatSim\.hint/.test(client))
}

// ── R6 日志轮转：项目目录的 dream-debug.log 不许无限长 ──────────────────────
{
  const logPath = join(wsRoot, '.dsh-meow', 'dream-debug.log')
  ok('R6 轮转阈值是个常量（2MB，和 perf.log 同一套思路）',
    (src.match(/var DREAM_LOG_ROTATE_BYTES = 2 \* 1024 \* 1024;/g) ?? []).length === 1)
  ok('R6 写入口只有一个（appendDreamLog），没有裸写 dream-debug.log 的地方',
    src.includes('function appendDreamLog(workspace, dir, line) {') &&
      (src.match(/appendFileSync2\(\s*join9\([^)]*dream-debug\.log/g) ?? []).length === 0)
  const calls = (src.match(/appendDreamLog\(/g) ?? []).length
  ok('R6 全部写入口都走 appendDreamLog（pre-step / hit-chain / hit-skip / dream / turn 都算）',
    calls >= 9, `${calls} 处`)
  // 行为：真造一个 2MB 文件，再触发一次「这一轮没注入」的写 → 必须轮转出 .old
  writeFileSync(logPath, 'x'.repeat(2 * 1024 * 1024 + 1024), 'utf8')
  const sid = 'sess-r6-rotate'
  seed(sid, { injectChars: 100000 })
  const r = run(Q_SAME, { ...baseOpts, injectSessionBudget: 100 }, sid)
  ok('R6 预置 2MB 日志后这一轮的判定照旧（轮转不许影响注入逻辑）', r === null, String(r))
  const oldPath = `${logPath}.old`
  const oldSize = existsSync(oldPath) ? statSync(oldPath).size : -1
  const newSize = existsSync(logPath) ? statSync(logPath).size : -1
  ok('R6 超阈后旧日志改名成 .old（不是删掉，留一份给排查）', oldSize > 2 * 1024 * 1024, `old ${oldSize} B`)
  ok('R6 轮转后新日志只装这一轮的行（不继承旧体积）', newSize >= 0 && newSize < 4096, `new ${newSize} B`)
  // 第二代：再写满一次，.old 必须被覆盖而不是攒成 .old.1
  writeFileSync(logPath, 'y'.repeat(2 * 1024 * 1024 + 2048), 'utf8')
  const sid2 = 'sess-r6-rotate2'
  seed(sid2, { injectChars: 100000 })
  run(Q_SAME, { ...baseOpts, injectSessionBudget: 100 }, sid2)
  const oldSize2 = existsSync(oldPath) ? statSync(oldPath).size : -1
  const siblings = readdirSync(join(wsRoot, '.dsh-meow')).filter((f) => f.startsWith('dream-debug.log.'))
  ok('R6 第二次轮转覆盖上一代（只留两代，不攒 .old.1 / .old.2）',
    oldSize2 > 2 * 1024 * 1024 && siblings.length === 1, `${oldSize2} B / ${siblings.join('|')}`)
}

// ── R7 出门那道闸：剩余额度就是本轮硬上限（0.6.47）────────────────────────
// 病根：闸①只在开头判「花光了没有」，于是「还剩一点」的那一轮会把整条注入照灌，
// injectMaxChars 默认 0 时连边都没有——一轮就能把上限顶穿好几倍，用户调的旋钮等于摆设。
{
  const filler = '细节'.repeat(500)
  const longRow = (id, kws) => ({
    id, level: 'topic', title: null, content: `${kws.join(' ')}。${filler}`, keywords: kws, importance: 3,
    status: 'active', source_session: 'other-session', project: '全局',
    created_at: NOW - 86400000, updated_at: NOW - 3600000, last_accessed_at: null,
  })
  const LONG = [longRow('lg000001', ['星图邻域', '强度下限', '门槛']), longRow('lg000002', ['星图邻域', '邻居条数', '每轮几条'])]
  let bumpedLong = []
  const longDb = () => ({
    list: (level) => LONG.filter((r) => r.level === level),
    bumpHit: (level, id) => { bumpedLong.push(id) },
    isFresh: () => false,
    idsBySession: () => [],
    findById: (id) => ({ row: LONG.find((r) => r.id === id) }),
  })
  const base = { injectMaxChars: 0, injectFloor: 0, injectBodyMax: 0, injectMarginRatio: 0 }

  const free = V.buildHitInjection(longDb(), wsRoot, 'sess-r7-free', Q_SAME, base, '.dsh-meow')
  ok('R7 不计预算、不限单条时两条长条目整条进来（这是对照：正文真长，会顶穿小额度）',
    free !== null && free.injectedIds.length === 2 && free.text.length > 1800, free === null ? 'null' : `${free.text.length} 字 / ${free.injectedIds.length} 条`)

  const wide = V.buildHitInjection(longDb(), wsRoot, 'sess-r7-wide', Q_SAME, { ...base, injectSessionBudget: 3000 }, '.dsh-meow')
  ok('R7 额度宽裕时逐位不变（没触发夹的动作，不许自己改输出）',
    wide !== null && wide.text === free.text, wide === null ? 'null' : `${wide.text.length} vs ${free.text.length}`)

  bumpedLong = []
  // 额度 250 是 0.6.58 之后重新标的：自述让位后同样 340 字已经能装下两条的「第一句」，
  // 那时「被挤掉的那条」根本不存在，这条断言就测不到东西了——把额度调回真的只够一条的位置。
  const tight = V.buildHitInjection(longDb(), wsRoot, 'sess-r7-tight', Q_SAME, { ...base, injectSessionBudget: 250 }, '.dsh-meow')
  const seenTight = readSeen('sess-r7-tight')
  ok('R7 额度只剩 250 → 本轮注入不超过 250 字（旧写法会把两条 1000+ 全灌进来）',
    tight !== null && tight.text.length <= 250 && tight.text.length < free.text.length,
    tight === null ? 'null' : `${tight.text.length} 字（不计预算 ${free.text.length}）`)
  ok('R7 被挤掉的那条不许标成「已注入」（否则它下一轮再也不出现）',
    tight !== null && tight.injectedIds.length === 1 && seenTight !== null &&
      seenTight.injected.length === 1 && bumpedLong.length === 1,
    tight === null ? 'null' : `ids=${tight.injectedIds.join(',')} seen=${seenTight?.injected.join(',')} bumped=${bumpedLong.join(',')}`)
  // 关掉「同话题延续」再看一次：上一轮真有同话题闸也会把它挡住，这里只验 seen 账。
  const back = V.buildHitInjection(longDb(), wsRoot, 'sess-r7-tight', Q_SAME, { ...base, injectRepeatSim: 0 }, '.dsh-meow')
  ok('R7 下一轮把额度放开 → 上一轮被挤掉的那条还在候选里，照常进来',
    back !== null && back.injectedIds.includes('lg000002'), back === null ? 'null' : back.injectedIds.join(','))

  const capOnly = V.buildHitInjection(longDb(), wsRoot, 'sess-r7-cap1', Q_SAME, { ...base, injectMaxChars: 600, injectSessionBudget: 4000 }, '.dsh-meow')
  ok('R7 单次上限 600、剩余额度 4000 → 按 600 走（更紧的那个说了算）',
    capOnly !== null && capOnly.text.length <= 600, capOnly === null ? 'null' : `${capOnly.text.length} 字`)
  const budOnly = V.buildHitInjection(longDb(), wsRoot, 'sess-r7-cap2', Q_SAME, { ...base, injectMaxChars: 600, injectSessionBudget: 400 }, '.dsh-meow')
  ok('R7 单次上限 600、剩余额度 400 → 按 400 走（额度更紧时额度说话）',
    budOnly !== null && budOnly.text.length <= 400, budOnly === null ? 'null' : `${budOnly.text.length} 字`)
}

// ── R8 挡下也要让账本前进 / 骨架不许注入（0.6.47）──────────────────────────
{
  // 病根一：lastQueryTerms / lastTopScore 只在注入成功时写 → 同话题一旦被挡，
  // 下一轮仍拿「上一次成功那一轮」的旧账来比，门槛永远够不着，整个会话从此静默。
  const sid = 'sess-r8-repeat'
  seed(sid, { lastQueryTerms: PREV_TERMS, lastTopScore: 9.0, injectChars: 300 })
  const blocked = run(Q_SAME, baseOpts, sid)
  const seen = readSeen(sid)
  const sameTerms = V.injectTermsOf(Q_SAME).slice(0, 60)
  ok('R8 同话题被挡下 → 仍然整轮不注入（闸的结论不变）', blocked === null, String(blocked))
  ok('R8 被挡时把本轮词面写回账本（下一轮比「上一轮」，不是比「上一次成功那轮」）',
    seen !== null && Array.isArray(seen.lastQueryTerms) && seen.lastQueryTerms.join() === sameTerms.join(),
    seen === null ? '没文件' : `${seen.lastQueryTerms.length} 条`)
  ok('R8 被挡时把「本轮最好的候选」记成下一轮基准（门槛跟着候选水平走，不被旧高位钉死）',
    seen !== null && Number.isFinite(seen.lastTopScore) && seen.lastTopScore > 0 && seen.lastTopScore < 9.0,
    `lastTopScore=${seen?.lastTopScore}`)

  // 病根二：单次上限小到只剩骨架时，旧写法照样把「标题 + 边界句」灌进去，却一条 id 都不记，
  // 下一轮同一批再算一遍。现在改成整轮不注入，日志里说清是哪一道上限卡住的。
  // [0.6.59] 预览档（36 字）把「能列一条」的临界点往下推了：200 字现在能列一条带正文的，
  // 那就不算骨架，该注入。真正只剩骨架的档在这里是 120 字。
  const tiny = run(Q_SAME, { ...baseOpts, injectMaxChars: 120 }, 'sess-r8-tiny')
  ok('R8 上限小到只剩骨架 → 整轮不注入（不灌一行没有正文的标题）', tiny === null, String(tiny))
  const logText = readFileSync(join(wsRoot, '.dsh-meow', 'dream-debug.log'), 'utf8')
  ok('R8 骨架挡法在日志里带 cap（与「会话额度花光」同一个出口，但看得清是哪一道）',
    /hit-skip reason=budget .*cap=120 /.test(logText), logText.split('\n').filter((l) => l.includes('cap=120')).pop() ?? '没有 cap 行')
}

// ── R9 老条目放回：本会话给过的，隔 N 轮又能进候选（0.6.49）──────────────────
// 病根：hitQuery 一行 `!seenState.injected.includes(r.id)` 把本会话注入过的条目**永久**拉黑。
// 短会话没事；长会话里话题绕回来时，最贴问的那条还是它，却再也进不来——回执只能给次选或空着。
{
  ok('R9 五个配置面都在：常量 12 / 默认值 / schema / 校验 / resolveConfig / 热生效白名单',
    src.includes('var INJECT_REINJECT_TURNS_DEF = 12;') &&
      src.includes('injectReinjectTurns: INJECT_REINJECT_TURNS_DEF, injectQuestionFloor: INJECT_QUESTION_FLOOR_RATIO, injectMarginRatio: INJECT_MARGIN_RATIO_DEF }') &&
      src.includes('injectReinjectTurns: z.number().min(0).default(INJECT_REINJECT_TURNS_DEF)') &&
      src.includes('reqNum("injectReinjectTurns")') &&
      src.includes('injectReinjectTurns: Number.isFinite(c.injectReinjectTurns)') &&
      src.includes('"injectRepeatSim", "injectMarginRatio", "injectReinjectTurns", "reflect"'))

  const sid = 'sess-r9-fresh'
  const first = run(Q_PREV, baseOpts, sid)
  const after1 = readSeen(sid)
  ok('R9 注入成功时给这一轮盖章（轮次 1 + 每条都盖上「给过的那一轮」）',
    first !== null && after1 !== null && after1.injectRound === 1 &&
      first.injectedIds.every((id) => after1.injectSeenAt?.[id] === 1),
    first === null ? 'null' : `round=${after1?.injectRound} stamp=${JSON.stringify(after1?.injectSeenAt)}`)

  const again = run(Q_PREV, { ...baseOpts, injectRepeatSim: 0 }, sid)
  ok('R9 刚给过的条目不再进候选（同一问句紧接着再问，回执里没有它们）',
    again === null || again.injectedIds.every((id) => !first.injectedIds.includes(id)),
    again === null ? 'null' : again.injectedIds.join(','))
  ok('R9 挡下时的回执带上 released=0 与重放窗口（读数是「没放回」，不是没写）',
    again === null || (again.budget?.reinjectTurns === 12 && again.budget?.released === 0),
    again === null ? 'null（整轮不注入，已由上一条覆盖）' : `released=${again.budget?.released} reinject=${again.budget?.reinjectTurns}`)

  const sid2 = 'sess-r9-expire'
  seed(sid2, { injected: ['rh000001', 'rh000003'], injectRound: 20, injectSeenAt: { rh000001: 3, rh000003: 3 } })
  const back = run(Q_PREV, { ...baseOpts, injectRepeatSim: 0 }, sid2)
  ok('R9 隔了 17 轮（> 12）→ 老条目重新进候选，账上记 released=2',
    back !== null && back.injectedIds.includes('rh000001') && back.budget?.released === 2,
    back === null ? 'null' : `ids=${back.injectedIds.join(',')} released=${back.budget?.released}`)
  const seen2 = readSeen(sid2)
  ok('R9 放回之后重新盖章（新轮次 21，不是留着旧章 3）',
    seen2 !== null && seen2.injectSeenAt?.rh000001 === 21,
    `stamp=${JSON.stringify(seen2?.injectSeenAt)}`)

  const sid3 = 'sess-r9-off'
  seed(sid3, { injected: ['rh000001', 'rh000003'], injectRound: 20, injectSeenAt: { rh000001: 3, rh000003: 3 } })
  const off = run(Q_PREV, { ...baseOpts, injectRepeatSim: 0, injectReinjectTurns: 0 }, sid3)
  ok('R9 窗口设 0 → 逐位回到「永久拉黑」（一条都不放回，也不记放回）',
    (off === null || !off.injectedIds.includes('rh000001')) && (off?.budget?.released ?? 0) === 0,
    off === null ? 'null' : `ids=${off.injectedIds.join(',')} released=${off.budget?.released}`)

  const sid4 = 'sess-r9-legacy'
  seed(sid4, { injected: ['rh000001', 'rh000003'] })
  const legacy = run(Q_PREV, { ...baseOpts, injectRepeatSim: 0 }, sid4)
  const seen4 = readSeen(sid4)
  ok('R9 升级前的老账（没盖轮次章）这一轮仍然挡，但要补章——不是永久拉黑',
    (legacy === null || !legacy.injectedIds.includes('rh000001')) &&
      seen4 !== null && Number.isFinite(seen4.injectSeenAt?.rh000001),
    `ids=${legacy === null ? 'null' : legacy.injectedIds.join(',')} stamp=${JSON.stringify(seen4?.injectSeenAt)}`)
}

rmSync(wsRoot, { recursive: true, force: true })

console.log('')
if (fail > 0) {
  console.log(`FAILED  passed ${pass} / failed ${fail}`)
  for (const b of bad) console.log('  ✗ ' + b)
  process.exitCode = 1
} else {
  console.log(`ALL PASS  probe-rhythm：${pass}/${pass}`)
}
