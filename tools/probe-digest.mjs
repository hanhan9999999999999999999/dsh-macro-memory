/**
 * 探针：条内摘要 + 中文句级选句（0.6.41 · 大文本注入不再整条灌进来）
 *
 * 为什么要有这一支：0.6.40 的闸门管的是「这一轮要不要注入」，但注入一条 1,500 字的
 * topic / project 全景时，整条正文照样每轮进上下文、之后每轮重新计费。0.6.38 的
 * `injectMaxChars` 是「整次注入的总字数」，而绝大多数人根本不设它（默认 0 = 不限）。
 *
 * 0.6.41 加第三条闸 `injectBodyMax`（单条正文上限，默认 240，0 = 不限）：超过上限的条目
 * 压成「首句 + 与问句重合的句子 + 硬信息句」，条目头一条不丢，正文后紧跟一行
 * `memory_read("<id>")` 指路。这一支守六条底线：
 *  ① 短条目不碰：正文没超上限就逐字原样，连标点都不许动。
 *  ② 首句必留：压到多短都从首句开始（首句是这条记忆的题眼）。
 *  ③ 中文选句真的能选：0.6.40 之前 injectTermsOf 把整串中文当一个词，句级打分对中文
 *     恒为 0，压缩永远退化成「只留首句」——这一支专门钉住「问句里的词能在正文中段
 *     把对应的那句捞出来」。
 *  ④ 硬信息句保底：带数字 / 版本 / 路径 / 反引号的句子加权重，哪怕与问句没有词面重合。
 *  ⑤ 0 = 关必须逐位回到 0.6.40：与 `renderHitEntries` 直接渲染一字不差、且没有指路行。
 *  ⑥ 坏值不许变成「整条灌进来」：非数字回 240；负数夹成 0（= 显式不限）。
 */
import { root } from './_root.mjs'
import { readFileSync, mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const V = await import(pathToFileURL(join(root, 'vendor', 'meow-memory', 'lib', 'index.js')).href)
const src = readFileSync(join(root, 'vendor', 'meow-memory', 'lib', 'index.js'), 'utf8')
const zhLabels = readFileSync(join(root, 'vendor', 'meow-memory', 'lib', 'prompts', 'zh', 'labels.md'), 'utf8')
const enLabels = readFileSync(join(root, 'vendor', 'meow-memory', 'lib', 'prompts', 'en', 'labels.md'), 'utf8')

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

// ── 夹具 ────────────────────────────────────────────────────────────────────
const NOW = Date.UTC(2026, 10, 24, 12, 0)
const mkRow = (id, level, content, kws, imp = 2) => ({
  id, level, title: null, content, keywords: kws, importance: imp,
  status: 'active', source_session: 'other-session', project: '全局',
  created_at: NOW - 86400000, updated_at: NOW - 3600000, last_accessed_at: null,
})

// 长条目：首句是题眼；第 2 段有一句与问句词面重合；末句带硬信息（数字 + 反引号）。
const S_HEAD = '星图邻域注入是每轮自动带来的参考，不是本轮指令。'
const S_MID = '邻域默认最多 4 条、合计 420 字，超了就从分低的开始丢。'
const S_FILL = '这条记忆里塞了很多与问题无关的背景，目的是把正文撑过单条上限。'.repeat(10)
const S_TAIL = '边界：设 `injectBodyMax: 0` 就整条给，默认 240 只摘要超长条目。'
const LONG = S_HEAD + S_FILL + S_MID + S_FILL + S_TAIL
const SHORT = '备份目录固定放在 D:\\备份，一次一个时间戳子目录。'
const Q_LONG = '星图邻域默认几条' // 命中 S_MID 的关键词「邻域 / 默认 / 4 条」

const ROWS_LONG = [mkRow('digest001', 'topic', LONG, ['星图', '邻域', '注入', '预算'], 3)]
const ROWS_SHORT = [mkRow('digest002', 'fact', SHORT, ['备份', '目录', '时间戳'], 2)]

const wsRoot = mkdtempSync(join(tmpdir(), 'probe-digest-'))
mkdirSync(join(wsRoot, '.dsh-meow'), { recursive: true })

function runOn(rows, q, opts) {
  const db = {
    list: (level) => rows.filter((r) => r.level === level),
    bumpHit: () => {},
    isFresh: () => false,
    idsBySession: () => [],
    findById: (id) => ({ row: rows.find((r) => r.id === id) }),
  }
  const sid = 'sess-digest-' + Math.random().toString(36).slice(2, 8)
  return V.buildHitInjection(db, wsRoot, sid, q, opts, '.dsh-meow')
}
const blockOf = (text, id) => {
  const lines = String(text ?? '').split('\n')
  const i = lines.findIndex((l) => l.includes('[' + id + ']'))
  return i < 0 ? '' : lines.slice(i + 1, i + 3).join('\n')
}

// ── D1 形状：常量 / 默认值 / 配置面五处 / 标签 / 中文切词 ─────────────────────
{
  ok('D1 单条上限常量在位（240）', src.includes('var INJECT_BODY_MAX_DEF = 240;'))
  ok('D1 DEFAULT_OPTS 带上单条上限（0.6.44 起还带注入节奏两项）', /var DEFAULT_OPTS = \{[^}]*injectBodyMax: INJECT_BODY_MAX_DEF[^}]*injectSessionBudget: 0[^}]*injectRepeatSim: INJECT_REPEAT_SIM_DEF[^}]*\};/.test(src))
  ok('D1 CONFIG_DEFAULTS 里是字面 240（模块求值早于常量赋值）', /injectBodyMax: 240,/.test(src))
  ok('D1 zod schema 默认跟常量走', src.includes('injectBodyMax: z.number().min(0).default(INJECT_BODY_MAX_DEF),'))
  ok('D1 设置页校验会挡坏值', src.includes('reqNum("injectBodyMax");'))
  ok('D1 resolveConfig 落成非负整数并回默认', src.includes('injectBodyMax: Number.isFinite(c.injectBodyMax) ? Math.max(0, Math.floor(c.injectBodyMax)) : INJECT_BODY_MAX_DEF,'))
  ok('D1 配置进了热生效白名单', /LIVE_CONFIG_KEYS = \[[^\]]*"injectBodyMax"/.test(src))
  ok('D1 pre-step 把单条上限透传下去', src.includes('injectBodyMax: resolved.injectBodyMax'))
  ok('D1 日志里看得见这一轮的单条上限与本轮压了几条', /hit-chain[^`]*body=\$\{resolved\.injectBodyMax\} bodyCut=/.test(src))
  ok('D1 指路行中英两份标签都在', zhLabels.includes('inject.bodyNote:') && enLabels.includes('inject.bodyNote:'))
  ok('D1 中文按 2-gram 展开（不再是整串当一个词）', src.includes('han.slice(i, i + 2)'))
  ok('D1 「要不要摘要」只在一处判断', (src.match(/contentLen > per/g) ?? []).length === 1)
}

// ── D2 默认 240：长条目被摘要，短条目逐字不动 ───────────────────────────────
{
  // 这一组量的是「单条上限的默认值」，所以把 0.6.40 的命中闸门显式关掉（injectFloor: 0），
  // 免得闸门把夹具挡了、读成「摘要没生效」。闸门自己的账在 probe-floor 里。
  const r = runOn(ROWS_LONG, Q_LONG, { injectFloor: 0 })
  const text = r === null ? '' : r.text
  const body = blockOf(text, 'digest001')
  ok('D2 长条目仍被注入（摘要不等于丢条）', r !== null && r.injectedIds.includes('digest001'))
  ok('D2 回执里能看出压了几条', r !== null && r.budget.bodyCut === 1, 'bodyCut ' + (r?.budget?.bodyCut ?? '—'))
  ok('D2 单条正文被压到首条份额 480 字以内（基准 240 × 2）', body.length > 0 && body.replace(/\n.*memory_read.*$/, '').length <= 480 + 60, 'body ' + body.length + ' 字')
  ok('D2 首句必留', body.includes(S_HEAD))
  ok('D2 与问句重合的那句被捞出来了', body.includes('邻域默认最多 4 条'))
  ok('D2 正文后面跟着 memory_read 指路行', /memory_read\("digest001"\)/.test(text))
  ok('D2 条目头（id / 项目 / level）一条不丢', text.includes('[全局 : topic] [digest001]'))

  const rs = runOn(ROWS_SHORT, '备份放在哪', { injectFloor: 0 })
  const stext = rs === null ? '' : rs.text
  ok('D2 短条目逐字不动', stext.includes(SHORT))
  ok('D2 短条目不加指路行', !/memory_read\("digest002"\)/.test(stext))
  ok('D2 短条目不记 bodyCut', rs !== null && rs.budget.bodyCut === 0)
}

// ── D3 0 = 关：逐位回到 0.6.40 ──────────────────────────────────────────────
{
  const r = runOn(ROWS_LONG, Q_LONG, { injectBodyMax: 0, injectFloor: 0 })
  const direct = V.renderHitEntries(ROWS_LONG.map((x) => ({ id: x.id, level: x.level, content: x.content, project: x.project, updated_at: x.updated_at })), { injectMaxChars: 0, injectBodyMax: 0 }, Q_LONG)
  ok('D3 关掉后与渲染器直接渲染逐字相同（len 相等）', r !== null && r.text === direct.text, (r?.text.length ?? -1) + ' vs ' + direct.text.length)
  ok('D3 关掉后没有指路行', r !== null && !r.text.includes('memory_read("digest001")'))
  ok('D3 关掉后 bodyCut 是 0', r !== null && r.budget.bodyCut === 0)
}

// ── D4 中文选句：中段的句子能被选出来（0.6.40 的缺陷是恒只留首句）────────────
{
  const terms = V.injectTermsOf === undefined ? null : null // 私有函数不导出：只从行为验证
  const r = runOn(ROWS_LONG, Q_LONG, { injectFloor: 0 })
  const body = blockOf(r === null ? '' : r.text, 'digest001')
  ok('D4 摘要里出现首句之后的内容（不再只有首句）', body.split(S_HEAD).length === 2 && body.replace(S_HEAD, '').trim().length > 20, '尾长 ' + (body.length - S_HEAD.length))
  ok('D4 选中的是含问句词的那一句，而不是随便一句', body.includes(S_MID) || body.includes(S_TAIL))
  ok('D4 摘出来的句子保持原文顺序（首句在前）', body.indexOf(S_HEAD) === 0 || body.trimStart().startsWith(S_HEAD))
}

// ── D5 硬信息句保底：问句里的词哪句都不沾，带数字/反引号的那句也要留一句 ─────
{
  // 「星图」只出现在首句（首句本来就必留）；S_MID / S_TAIL 与它零词面重合。
  // 所以这一组考的是：没有任何软句子能靠词面被选中时，硬信息句还留不留。
  const Q_HARD = '星图'
  const r = runOn(ROWS_LONG, Q_HARD, { injectFloor: 0, injectBodyMax: 240, hitTopK: 1 })
  ok('D5 词面不指向任何句子时仍然压（不是「没命中就不压」）', r !== null && r.budget.bodyCut === 1, 'bodyCut ' + (r?.budget?.bodyCut ?? '—'))
  const body = blockOf(r === null ? '' : r.text, 'digest001')
  ok('D5 与问句词、与首句都无关的软句子没被留下', !body.includes('与问题无关的背景'), body.slice(0, 80))
  ok('D5 带数字 / 反引号的硬信息句保住了', body.includes('240') || body.includes('`injectBodyMax: 0`'), body.slice(0, 80))
}

// ── D6 与 injectMaxChars 叠加：取较小者 ────────────────────────────────────
{
  const r = runOn(ROWS_LONG, Q_LONG, { injectFloor: 0, injectMaxChars: 300, injectBodyMax: 240 })
  ok('D6 两层上限同时生效时总长仍不超总预算', r !== null && r.text.length <= 300, (r?.text.length ?? -1) + ' ≤ 300')
  const r2 = runOn(ROWS_LONG, Q_LONG, { injectFloor: 0, injectMaxChars: 3000, injectBodyMax: 240 })
  const body2 = blockOf(r2 === null ? '' : r2.text, 'digest001')
  ok('D6 总预算宽时单条仍按基准两倍（480）压', body2.length > 0 && body2.length <= 480 + 60 + 20, 'body ' + body2.length)
}

// ── D7 坏值：非数字回 240，负数夹成 0 ──────────────────────────────────────
{
  const nan = runOn(ROWS_LONG, Q_LONG, { injectFloor: 0, injectBodyMax: NaN })
  ok('D7 非数字（NaN）回默认 240：仍然摘要', nan !== null && nan.budget.bodyCut === 1 && nan.budget.bodyMax === 240, 'bodyMax ' + (nan?.budget?.bodyMax ?? '—'))
  const str = runOn(ROWS_LONG, Q_LONG, { injectFloor: 0, injectBodyMax: '240' })
  ok('D7 字符串当坏值：回默认 240 而不是「整条灌」', str !== null && str.budget.bodyCut === 1)
  const neg = runOn(ROWS_LONG, Q_LONG, { injectFloor: 0, injectBodyMax: -1 })
  ok('D7 负数夹成 0＝显式不限：不摘要、bodyMax 是 0', neg !== null && neg.budget.bodyCut === 0 && neg.budget.bodyMax === 0)
}

// ── D8 读数 ────────────────────────────────────────────────────────────────
{
  const a0 = runOn(ROWS_LONG, Q_LONG, { injectFloor: 0, injectBodyMax: 0 })
  const a1 = runOn(ROWS_LONG, Q_LONG, { injectFloor: 0 })
  console.log('')
  console.log('MEASURE 长条目（' + LONG.length + ' 字）单条注入：')
  console.log('  不限（0）　　　' + (a0 === null ? '—' : a0.text.length + ' 字') + '　全文整条')
  console.log('  默认（240 → 首条 480）' + (a1 === null ? '—' : a1.text.length + ' 字') + '　压成首句 + 相关句 + 硬信息句 + 指路行')
  if (a0 !== null && a1 !== null) {
    console.log('  省　' + (100 * (1 - a1.text.length / a0.text.length)).toFixed(1) + '%')
  }
}

console.log('')
if (fail === 0) console.log(`ALL PASS  probe-digest：${pass}/${pass}`)
else console.log(`FAILED ${fail} / ${pass + fail}\n  ` + bad.map((x) => '✗ ' + x).join('\n  '))
process.exitCode = fail === 0 ? 0 : 1
