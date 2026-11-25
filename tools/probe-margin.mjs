/**
 * 探针：陪跑线（0.6.73）。
 *
 * 病：`hitTopK` 默认 2，每轮固定要两条。可第一名把手头这句问句解释掉之后，第二名常常只是
 * 沾了同一个泛词——它过了 floor、分数看着也不低，灌进去却是纯噪声，而那 200–400 字进了
 * 历史还要每一轮重新计费。0.6.40 的 floor 是**绝对**门槛（够不够格），管不了这种情况：
 * 它问的是「比零高多少」，没人问「比第一名差多远」。
 *
 * 这一版补的是**相对**门槛：`injectMarginRatio`（0–1，0 = 关，默认 0.2）。第二名的分数
 * 不到「第一名 × 这个比例」就不注入，记成第五种落选原因 `margin`，面板照旧点名、给对策。
 *
 * 探针按四层问：
 *  1. 引擎那层：真跑 `buildHitInjection`——陪跑被砍、并列第一不被砍、关掉闸两条都在、
 *     第一名永远保留、被砍的条目不算「已注入」（不写 seen、不加 hit_count）；
 *  2. 配置面那层：常量 / CONFIG_DEFAULTS / zod / reqNum / resolveConfig / 白名单 /
 *     pre-step 透传 / 日志 `margin=` 一处不落（少一处就是「面板有旋钮，引擎不认」）；
 *  3. 面板那层：`margin` 有中文出口名、有对策句、分布与点名行里看得见；
 *  4. 手干净不干净：面板纯读，日志一个字节不动、目录里不多出文件。
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { root } from './_root.mjs'

const tmpRoot = mkdtempSync(join(tmpdir(), 'macro-probe-margin-'))
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
const panelSrc = readFileSync(join(root, 'lib', 'macro', 'injectledger.js'), 'utf8')
const clientSrc = readFileSync(join(root, 'lib', 'client.js'), 'utf8')

// ── 夹具：一条强命中 + 一条只沾两个泛词的陪跑 ────────────────────────────────
const STRONG = '部署脚本的端口约定是 8080，改端口要同步改反向代理。'
const MATE = '端口约定'
const mkRow = (id, content, keywords) => ({
  id,
  level: 'fact',
  content,
  title: content.slice(0, 16),
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
const ROWS = [
  mkRow('margin0001', STRONG, ['部署', '脚本', '端口', '约定', '8080']),
  mkRow('margin0002', MATE, ['端口', '约定']),
  // 第三条与第一条关键词完全相同：两条并列第一，谁都不该被陪跑线砍。
  mkRow('margin0003', STRONG, ['部署', '脚本', '端口', '约定', '8080']),
]
const Q = '部署脚本的端口约定是多少'

function runOn(q, opts, sid) {
  const bumps = []
  const db = {
    list: (level) => ROWS.filter((r) => r.level === level),
    bumpHit: (level, id) => bumps.push(id),
    isFresh: () => false,
    idsBySession: () => [],
    findById: (id) => ({ row: ROWS.find((r) => r.id === id) }),
  }
  const id = sid ?? 'sess-margin-' + Math.random().toString(36).slice(2, 8)
  const out = V.buildHitInjection(db, join(tmpRoot, 'ws-engine'), id, q, opts, '.dsh-meow')
  return { out, bumps, sid: id }
}
mkdirSync(join(tmpRoot, 'ws-engine', '.dsh-meow'), { recursive: true })

const isMarginDrop = (d) => d.reason === 'margin'

// ── 1) 引擎：陪跑被砍 ──────────────────────────────────────────────────────
{
  const { out, bumps, sid: firstSid } = runOn(Q, { injectFloor: 0, hitTopK: 3 })
  const picks = out === null ? [] : out.picks
  const drops = out === null ? [] : out.drops
  const margins = drops.filter(isMarginDrop)
  ok(
    'M1 陪跑被砍：三候选里只进顶尖那几条，砍下的记成 margin',
    out !== null && picks.length >= 1 && margins.length >= 1 && picks.length + margins.length === 3,
    picks.map((p) => p.id).join(',') + ' / margin=' + margins.map((d) => `${d.id}:${Number(d.score).toFixed(2)}`).join(','),
  )
  ok(
    'M2 第一名永远保留（陪跑线不会把一轮砍空）',
    picks.some((p) => p.id === 'margin0001' || p.id === 'margin0003'),
    picks.map((p) => p.id).join(','),
  )
  ok(
    'M3 把线降到 5% 它就进来（0.2 这条线正好卡在噪声与真相关之间的空带里）',
    (() => {
      const { out: low } = runOn(Q, { injectFloor: 0, hitTopK: 3, injectMarginRatio: 0.05 })
      return low !== null && (low.drops ?? []).filter(isMarginDrop).length === 0 && (low.picks ?? []).some((p) => p.id === 'margin0002')
    })(),
    margins.length === 1 ? `陪跑分数 ${Number(margins[0].score).toFixed(3)}` : '没砍',
  )
  ok(
    'M4 回执里带这一轮砍了几条（budget.margin）',
    out !== null && out.budget && out.budget.margin === margins.length,
    out === null ? 'null' : String(out.budget?.margin),
  )
  ok(
    'M5 被砍的条目不算「已注入」（不 bumpHit）',
    !bumps.includes('margin0002'),
    bumps.join(','),
  )
  // 只读这一轮自己的会话账本（同目录里还有别的 run 的账，混读会把它们算进来）
  const seenDir = join(tmpRoot, 'ws-engine', '.dsh-meow', 'sessions')
  let injectedIds = []
  try {
    const mine = readdirSync(seenDir).filter((f) => f.startsWith(firstSid) && f.endsWith('.json'))
    injectedIds = mine.flatMap((f) => JSON.parse(readFileSync(join(seenDir, f), 'utf8')).injected ?? [])
  } catch {
    injectedIds = []
  }
  ok('M6 被砍的条目没写进 seen（下一轮还能当第一名进来）', !injectedIds.includes('margin0002'), injectedIds.join(','))
}

// ── 2) 引擎：关掉闸 / 并列第一 ──────────────────────────────────────────────
{
  const { out } = runOn(Q, { injectFloor: 0, hitTopK: 3, injectMarginRatio: 0 })
  const picks = out === null ? [] : out.picks
  ok(
    'M7 marginRatio=0 = 关：三条候选全部照旧注入',
    picks.length === 3 && (out.drops ?? []).filter(isMarginDrop).length === 0,
    picks.map((p) => `${p.id}:${p.chars}`).join(','),
  )
  const { out: eq } = runOn(Q, { injectFloor: 0, hitTopK: 3 })
  const eqDrops = (eq?.drops ?? []).filter(isMarginDrop).map((d) => d.id)
  ok(
    'M8 并列第一不被砍：分数相同的两条都留着，只有陪跑那条被砍',
    eq !== null && (eq.picks ?? []).filter((p) => p.id === 'margin0001' || p.id === 'margin0003').length === 2 && !eqDrops.includes('margin0003'),
    'picks=' + (eq?.picks ?? []).map((p) => p.id).join(',') + ' margin=' + eqDrops.join(','),
  )
  const { out: off } = runOn(Q, { injectFloor: 0, hitTopK: 3, injectMarginRatio: 1 })
  ok(
    'M9 marginRatio=1 只留并列第一：第二名的分比第一名低就砍',
    off !== null && (off.drops ?? []).filter(isMarginDrop).some((d) => d.id === 'margin0002'),
    (off?.picks ?? []).map((p) => p.id).join(','),
  )
}

// ── 3) 配置面：八处一处不落 ────────────────────────────────────────────────
{
  ok('M10 常量在位（0.2）', engSrc.includes('var INJECT_MARGIN_RATIO_DEF = 0.2;'))
  ok('M11 CONFIG_DEFAULTS 里是字面值 0.2（模块求值早于常量赋值）', /injectMarginRatio: 0\.2,/.test(engSrc))
  ok(
    'M12 DEFAULT_OPTS 带上它',
    /var DEFAULT_OPTS = \{[^}]*injectMarginRatio: INJECT_MARGIN_RATIO_DEF[^}]*\};/.test(engSrc),
  )
  ok('M13 zod 默认跟常量走、夹在 0–1', engSrc.includes('injectMarginRatio: z.number().min(0).max(1).default(INJECT_MARGIN_RATIO_DEF),'))
  ok('M14 设置页校验会挡坏值', engSrc.includes('reqNum("injectMarginRatio");'))
  ok(
    'M15 resolveConfig 落成 0–1 并回默认',
    engSrc.includes('injectMarginRatio: Number.isFinite(c.injectMarginRatio) ? Math.min(1, Math.max(0, c.injectMarginRatio)) : INJECT_MARGIN_RATIO_DEF,'),
  )
  ok('M16 进了热生效白名单', /LIVE_CONFIG_KEYS = \[[^\]]*"injectMarginRatio"/.test(engSrc))
  ok('M17 pre-step 把它透传下去', engSrc.includes('injectMarginRatio: resolved.injectMarginRatio'))
  ok('M18 日志里有这一轮砍了几条（margin=）', /repeated=\$\{[^}]*\} margin=\$\{[^}]*\}/.test(engSrc))
}

// ── 4) 面板：五种原因都有名字、有对策 ──────────────────────────────────────
{
  ok('M19 面板认 margin 这个原因（有中文出口名）', /case 'margin':\s*\n\s*return '陪跑/.test(panelSrc))
  ok('M20 有对策句，且指向「补 keywords / 调低陪跑线」', /margin: '陪跑（第一名比它强太多[^']*keywords[^']*陪跑线/.test(panelSrc))

  const ws = join(tmpRoot, 'ws-panel')
  const logDir = join(ws, '.dsh-meow')
  mkdirSync(logDir, { recursive: true })
  const log =
    '[2026-11-25T10:00:00.000Z] hit-chain sid=aaaaaaaa textLen=280 hit=yes floor=0.35 qfloor=0.6 gated=0 body=240 bodyCut=0 sim=0.25 repeated=0 margin=1 released=0 reinject=12 picks=cccccccc:280:full drops=dddddddd:0.07:margin spent=280/∞\n' +
    '[2026-11-25T10:01:00.000Z] hit-chain sid=aaaaaaaa textLen=300 hit=yes floor=0.35 qfloor=0.6 gated=0 body=240 bodyCut=0 sim=0.25 repeated=0 margin=0 released=0 reinject=12 picks=cccccccc:300:full drops=- spent=580/∞\n'
  const file = join(logDir, 'dream-debug.log')
  writeFileSync(file, log)
  const before = statSync(file).size
  const dirBefore = readdirSync(logDir).sort().join(',')
  const panel = L.readInjectPanel({ workspace: ws, dir: '.dsh-meow' })
  const body = panel.body
  ok('M21 落选名单的分布里点了 margin', body.includes('margin 1'), body.split('\n').filter((l) => l.startsWith('落选名单')).join(' | '))
  ok('M22 点名的条目行里看得到「margin 1」', /- dddddddd 挡了 1 次（margin 1）/.test(body), (body.match(/- dddddddd[^\n]*/) ?? [''])[0])
  ok('M23 对策句跟着条目走（写的是陪跑线）', (body.match(/\n\s+陪跑（第一名比它强太多/g) ?? []).length === 1, '')
  ok('M24 明细行里也念得出「陪跑」', body.includes('落选 dddddddd margin 0.07'), (body.match(/- \d\d-\d\d[^\n]*落选[^\n]*/) ?? [''])[0])
  ok('M25 面板纯读：日志一个字节没动', statSync(file).size === before && readFileSync(file, 'utf8') === log)
  ok('M26 面板不多写文件（目录没变）', readdirSync(logDir).sort().join(',') === dirBefore, readdirSync(logDir).sort().join(','))
}

// ── 5) 设置面：出厂值与三语文案都在 ────────────────────────────────────────
{
  ok('M27 设置页出厂值 = 引擎默认（0.2）', /injectMarginRatio: 0\.2,/.test(clientSrc))
  ok(
    'M28 字段进了 FIELDS（num，挂注入组）',
    clientSrc.includes('{ key: "injectMarginRatio", label: "settings.field.injectMarginRatio.label", type: "num", hint: "settings.field.injectMarginRatio.hint" }'),
  )
  const labels = clientSrc.match(/"settings\.field\.injectMarginRatio\.label"/g) ?? []
  const hints = clientSrc.match(/"settings\.field\.injectMarginRatio\.hint"/g) ?? []
  // 三语各一条 + UI_KEYS 一条 + FIELDS 里的引用一条 = 5
  ok('M29 三语 label + hint 齐全（含 UI_KEYS 与 FIELDS 的引用）', labels.length === 5 && hints.length === 5, `label=${labels.length} hint=${hints.length}`)
  ok('M30 中文文案是真中文（不是 u 转义残留）', /"settings\.field\.injectMarginRatio\.label": "\\u966A\\u8DD1\\u7EBF"/.test(clientSrc) || clientSrc.includes('"settings.field.injectMarginRatio.label": "陪跑线"'))
}

console.log('')
console.log(`ALL ${fail === 0 ? 'PASS' : 'FAIL'}：${pass}/${pass + fail}`)
if (fail > 0) {
  console.log('失败：')
  for (const b of bad) console.log(' - ' + b)
  process.exitCode = 1
}
try {
  V.closeAllDbs?.()
} catch {
}
