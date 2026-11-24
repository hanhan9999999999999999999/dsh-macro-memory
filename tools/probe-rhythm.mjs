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
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
const baseOpts = { injectMaxChars: 0, injectFloor: 0, injectBodyMax: 240 }

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
  const under = run(Q_SAME, { ...baseOpts, injectSessionBudget: 500 }, sid2)
  const after = readSeen(sid2)
  ok('R2 预算还没花完 → 注入，并把「已花多少 / 上限多少」带在读数里',
    under !== null && under.budget.spent === 400 + under.text.length && under.budget.sessionBudget === 500,
    under === null ? 'null' : `spent=${under.budget.spent}`)
  ok('R2 累计字数真的落进会话文件（下一轮接着算，不是每次从头）',
    after !== null && after.injectChars === 400 + under.text.length, `文件里 ${after?.injectChars}`)
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

rmSync(wsRoot, { recursive: true, force: true })

console.log('')
if (fail > 0) {
  console.log(`FAILED  passed ${pass} / failed ${fail}`)
  for (const b of bad) console.log('  ✗ ' + b)
  process.exitCode = 1
} else {
  console.log(`ALL PASS  probe-rhythm：${pass}/${pass}`)
}
