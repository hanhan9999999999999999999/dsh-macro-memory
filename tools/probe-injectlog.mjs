/**
 * 探针：注入账本（0.6.46 · memory_admin(action="inject")）
 *
 * 为什么要有这一支：0.6.41 / 0.6.44 / 0.6.45 三道闸（单条正文上限、会话预算、同话题抑制、
 * 命中闸门）都在往 `dream-debug.log` 里写账，可**只有写口、没有读口**。用户问「这几小时
 * 到底注入了多少字、被挡的是哪一类、我该把哪个旋钮调大」时，唯一的办法是自己去翻几千行。
 * 这一支守的是「读口」的四条底线：
 *  ① 面板只念日志，不自己算：所有数字都能从行里验算出来（字数合计 = 各轮 textLen 之和）；
 *  ② 「没有账」和「读不出来」「旧格式读数不全」三件事分开说，绝不含糊成一句「0 轮」；
 *  ③ 认旧格式（0.6.43 及以前只有 textLen/hit）：字数照算，但必须当场说明挡下计数不全；
 *  ④ 闸门读数来自 config（用户真调过的那个值），不是面板写死的出厂值。
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'

import { root } from './_root.mjs'

const L = await import(pathToFileURL(join(root, 'lib', 'macro', 'injectledger.js')).href)
const A = await import(pathToFileURL(join(root, 'lib', 'macro', 'defs', 'admin.js')).href)
const P = await import(pathToFileURL(join(root, 'lib', 'macro', 'prompt.js')).href)
const adminSrc = readFileSync(join(root, 'lib', 'macro', 'defs', 'admin.js'), 'utf8')

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

// ── 夹具：一个临时工作区，两代日志（.old 在前、现文件在后） ──────────────────
const ws = join(root, '.probe-injectlog-ws')
rmSync(ws, { recursive: true, force: true })
mkdirSync(join(ws, '.dsh-meow'), { recursive: true })
const LOG = join(ws, '.dsh-meow', 'dream-debug.log')
const OLD = join(ws, '.dsh-meow', 'dream-debug.log.old')

const NEW_LINES = [
  '[2026-11-25T01:00:00.000Z] hit-chain pid=1 sid=abcd1234 textLen=268 hit=yes floor=0.35 gated=1 body=240 bodyCut=2 sim=0.25 repeated=0 spent=268/∞',
  '[2026-11-25T01:05:00.000Z] hit-skip reason=empty',
  '[2026-11-25T01:10:00.000Z] hit-skip reason=floor gated=3 floor=0.35',
  '[2026-11-25T01:15:00.000Z] hit-skip reason=budget spent=812/800',
  '[2026-11-25T01:20:00.000Z] hit-skip reason=repeat repeated=2 sim=0.25 prevTop=1.2',
  '[2026-11-25T01:25:00.000Z] hit-chain pid=1 sid=abcd1234 textLen=512 hit=yes floor=0.35 gated=0 body=240 bodyCut=0 sim=0.25 repeated=1 spent=780/∞',
  '[2026-11-25T01:26:00.000Z] hit-chain pid=1 sid=abcd1234 textLen=100 hit=yes',
  '[2026-11-25T01:27:00.000Z] pre-step pid=1 sid=abcd1234',
  '[2026-11-25T01:28:00.000Z] hit-skip reason=weird x=1',
].join('\n')
const OLD_LINES = '[2026-11-20T10:00:00.000Z] hit-chain pid=1 sid=zzzz textLen=300 hit=yes'
writeFileSync(LOG, NEW_LINES + '\n', 'utf8')
writeFileSync(OLD, OLD_LINES + '\n', 'utf8')

const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex')
const logHash = sha(LOG)
const oldHash = sha(OLD)

const panel = L.readInjectPanel({ workspace: ws, dir: '.dsh-meow', limit: 20, config: { injectSessionBudget: 800 } })
const body = panel.body

// ── I1 装配面：开关在表里，别处不另有一份枚举 ────────────────────────────────
{
  const spec = A.ACTIONS.inject
  ok('I1.1 ACTIONS.inject 在位且 kind=local', spec !== undefined && spec.kind === 'local', spec ? spec.kind : 'missing')
  ok('I1.2 label/hint/params/defaultLimit 齐全', spec?.label === '注入账本' && spec?.hint.includes('注入账') === true && Array.isArray(spec?.params) && spec.params.join(',') === 'limit' && spec?.defaultLimit === 12,
    JSON.stringify({ label: spec?.label, params: spec?.params, defaultLimit: spec?.defaultLimit }))
  const labels = Object.values(A.ACTIONS).map((s) => s.label)
  ok('I1.3 面板名不撞车', new Set(labels).size === labels.length, `labels=${labels.length}/uniq=${new Set(labels).size}`)
  ok('I1.4 PANEL_SUMMARY 自动带 inject', A.PANEL_SUMMARY.includes('inject 注入账'), A.PANEL_SUMMARY.slice(0, 60))
  ok('I1.5 手册运维列表含 inject', P.GUIDE_TEXT.includes('|inject|'), 'GUIDE_TEXT 里 action 列表')
  ok('I1.6 schema 的 limit 说明提到 inject', /action=hygiene\/cost\/dream\/links\/inject/.test(adminSrc), 'admin.js limit description')
}

// ── I2 解析：三态与旧格式，一个都不许糊 ──────────────────────────────────────
{
  const p = L.parseInjectLog(NEW_LINES)
  const yes = p.events.filter((e) => e.kind === 'hit' && e.hit === 'yes')
  ok('I2.1 新格式六键全读到', yes.length >= 1 && yes[0].floor === 0.35 && yes[0].gated === 1 && yes[0].bodyCut === 2 && yes[0].repeated === 0,
    JSON.stringify(yes[0] ?? null))
  ok('I2.2 spent 取除号前那一半（不是 NaN→0）', yes[0].spent === 268 && yes[1].spent === 780, `spent=${yes[0].spent}/${yes[1].spent}`)
  ok('I2.3 上限原样带出（∞ / 800）', yes[0].limit === '∞' && yes[2].limit === '', `limit=${JSON.stringify([yes[0].limit, yes[2].limit])}`)
  ok('I2.4 hit 三态：yes / 缺字段=unknown', yes.length >= 3 && yes[2].hit === 'yes', '第三条是旧格式但写了 hit=yes')
  const legacyRow = L.parseInjectLog('[2026-11-20T10:00:00.000Z] hit-chain pid=1 sid=a textLen=300 hit=yes')
  ok('I2.5 旧格式行标 legacy 且 floor=null', legacyRow.events[0].legacy === true && legacyRow.events[0].floor === null && legacyRow.legacy === 1,
    JSON.stringify(legacyRow.events[0]))
  const nullRow = L.parseInjectLog('[2026-11-21T11:30:09.380Z] hit-chain pid=1 sid=a textLen=21 hit=null')
  ok('I2.6 hit=null 不许读成 false/缺字段', nullRow.events[0].hit === 'null', nullRow.events[0].hit)
  const skipKinds = p.events.filter((e) => e.kind === 'skip').map((e) => e.reason)
  ok('I2.7 四种 reason 各归位', ['empty', 'floor', 'budget', 'repeat'].every((r) => skipKinds.includes(r)), skipKinds.join(','))
  ok('I2.8 不认识的 reason 原样留着（不许吞成空）', skipKinds.includes('weird'), skipKinds.join(','))
  ok('I2.9 普通行（pre-step）不记坏行', p.bad === 0, `bad=${p.bad}`)
  const broken = L.parseInjectLog('garbage hit-chain without bracket')
  ok('I2.10 长得像注入账却解析不出 → 计坏行', broken.bad === 1, `bad=${broken.bad}`)
}

// ── I3 面板正文：数字能验算，空态分得清 ─────────────────────────────────────
{
  // 注入的四轮：268 + 512 + 100 + 300(.old) = 1180；平均 295；中位 sorted([100,268,300,512])[2] = 300
  ok('I3.1 字数合计/平均/中位/最省/最多', body.includes('合计 1,180 字') && body.includes('平均 295 字每轮') && body.includes('中位 300') && body.includes('最省 100') && body.includes('最多 512'),
    (body.match(/字数：[^\n]*/) ?? [''])[0])
  ok('I3.2 出口轮数按两代日志合计', body.includes('9 轮里有 4 轮注入、5 轮挡下'), (body.match(/出口：[^\n]*/) ?? [''])[0])
  ok('I3.3 四类挡下各 1 轮，且用中文解释', body.includes('未命中（没有条目过搜索线）：1 轮') && body.includes('命中闸门（过搜索线但没过 floor）：1 轮') && body.includes('会话预算用尽：1 轮') && body.includes('同话题抑制（上轮已注入）：1 轮'), '四行'
  )
  ok('I3.4 不认识的 reason 也列出来', body.includes('- weird：1 轮'), '未知出口')
  ok('I3.5 挡下条数与压条数真的汇总', body.includes('闸门挡下的条目：1 条') && body.includes('正文被压：2 条'), 'gated/bodyCut')
  ok('I3.6 旧格式行数与「挡下计数不全」的说明', body.includes('另有 2 行是 0.6.43 及以前的旧格式') && body.includes('计数不全'),
    (body.match(/另有 \d+ 行是[^\n]*/) ?? [''])[0])
  ok('I3.7 两代日志都读了（含 .old）', body.includes('（含 1 份 .old）') && body.includes('9 行账'), (body.match(/日志：[^\n]*/) ?? [''])[0])
  ok('I3.8 明细新的在前、旧的在后', body.indexOf('[2026-11-25T01:26') === -1 && body.indexOf('11-25') > 0 && body.lastIndexOf('- 11-20') > body.indexOf('- 11-25'),
    '明细顺序')
  ok('I3.9 明细里说清「没注入」不是「注入 0 字」', body.includes('挡下：未命中'), '明细')

  const zero = L.readInjectPanel({ workspace: ws, dir: '.dsh-meow', limit: 0 }).body
  ok('I3.10 limit=0 不列明细但统计照算', zero.includes('limit=0') && zero.includes('合计 1,180 字') && !zero.includes('最近 4 轮'), 'limit=0')

  const nolog = L.readInjectPanel({ workspace: join(root, '.probe-injectlog-none'), dir: '.dsh-meow' }).body
  ok('I3.11 没有日志 → 说「还没有注入账」，不说「0 轮注入」', nolog.includes('还没有注入账') && !nolog.includes('0 轮'), nolog.slice(0, 40))

  const emptyWs = join(root, '.probe-injectlog-empty')
  rmSync(emptyWs, { recursive: true, force: true })
  mkdirSync(join(emptyWs, '.dsh-meow'), { recursive: true })
  writeFileSync(join(emptyWs, '.dsh-meow', 'dream-debug.log'), '[2026-11-25T01:00:00.000Z] check sid=a active=false idle=1s\n', 'utf8')
  const empty = L.readInjectPanel({ workspace: emptyWs, dir: '.dsh-meow' }).body
  ok('I3.12 日志在但没有账行 → 分开说（不是「空账本」）', empty.includes('一行注入账都没有') && empty.includes('日志在'), empty.slice(0, 40))
  rmSync(emptyWs, { recursive: true, force: true })
}

// ── I4 闸门读数来自 config，不是面板写死 ─────────────────────────────────────
{
  const withCfg = L.readInjectPanel({ workspace: ws, dir: '.dsh-meow', config: { injectFloor: 0.45, injectBodyMax: 160, injectSessionBudget: 800, injectRepeatSim: 0.4, hitTopK: 3 } }).body
  ok('I4.1 五个旋钮全按 config 念', withCfg.includes('floor 0.45') && withCfg.includes('单条 160 字') && withCfg.includes('会话累计 800 字') && withCfg.includes('同话题 0.4') && withCfg.includes('每轮最多 3 条'),
    (withCfg.match(/闸门：[^\n]*/) ?? [''])[0])
  const noCfg = L.readInjectPanel({ workspace: ws, dir: '.dsh-meow', config: {} }).body
  ok('I4.2 没配置时回出厂值且「不限」说得出来', noCfg.includes('floor 0.35') && noCfg.includes('会话累计 不限'), (noCfg.match(/闸门：[^\n]*/) ?? [''])[0])
  const dirty = L.readInjectPanel({ workspace: ws, dir: '.dsh-meow', config: { injectFloor: 'abc', injectSessionBudget: -5 } }).body
  ok('I4.3 脏配置回出厂值（不打印 NaN）', dirty.includes('floor 0.35') && !dirty.includes('NaN') && dirty.includes('会话累计 不限'), (dirty.match(/闸门：[^\n]*/) ?? [''])[0])
}

// ── I5 真调用：抬头由 panel.js 加，面板只给正文 ──────────────────────────────
{
  const admin = A.createAdmin({ flow: {}, bridge: {}, config: {}, meowDir: () => '.dsh-meow' })
  const exec = { agent: { session: { header: { cwd: ws } } } }
  const text = await admin.execute({ action: 'inject', limit: 3 }, exec)
  ok('I5.1 抬头是【宏记忆｜注入账本】', typeof text === 'string' && text.startsWith('【宏记忆｜注入账本】'), String(text).slice(0, 24))
  ok('I5.2 抬头带上覆盖范围口径', typeof text === 'string' && text.split('\n')[0].includes('覆盖'), String(text).split('\n')[0])
  // 明细行与「四类挡下」列表同样以「- 」开头，所以只数「最近 N 轮」这一节之后的行。
  const detailSection = typeof text === 'string' ? text.slice(text.indexOf('最近 3 轮（新的在前）：')) : ''
  ok('I5.3 limit 只出 3 条明细', typeof text === 'string' && text.includes('最近 3 轮（新的在前）：') && (detailSection.match(/^- /gm) ?? []).length === 3,
    `明细行=${(detailSection.match(/^- /gm) ?? []).length}`)
  const dirtyLimit = await admin.execute({ action: 'inject', limit: 'abc' }, exec)
  ok('I5.4 脏 limit 会说话（不是静默退回默认）', typeof dirtyLimit === 'string' && dirtyLimit.includes('不是数字'), String(dirtyLimit).split('\n')[0].slice(0, 80))
  const noSid = await admin.execute({ action: 'inject' }, {})
  ok('I5.5 拿不到工作区时不炸（照实说没有账）', typeof noSid === 'string' && noSid.includes('还没有注入账'), String(noSid).slice(0, 30))
}

// ── I6 只读：面板一个字节都不许改日志 ───────────────────────────────────────
{
  ok('I6.1 现文件字节不变', sha(LOG) === logHash, `${logHash.slice(0, 8)}`)
  ok('I6.2 .old 字节不变', sha(OLD) === oldHash, `${oldHash.slice(0, 8)}`)
  ok('I6.3 面板不新增文件', existsSync(LOG) && existsSync(OLD) && !existsSync(join(ws, '.dsh-meow', 'dream-debug.log.new')), 'dir ok')
}

rmSync(ws, { recursive: true, force: true })

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILED'} ${pass}/${pass + fail}`)
if (fail > 0) {
  console.log('--- 失败明细 ---')
  for (const b of bad) console.log('  ' + b)
  process.exitCode = 1
}
