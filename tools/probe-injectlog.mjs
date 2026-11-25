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
  ok('I3.2 出口轮数按两代日志合计', body.includes('9 轮里有 4 轮注入、5 轮没注入'), (body.match(/出口：[^\n]*/) ?? [''])[0])
  ok('I3.3 四类挡下各 1 轮，且用中文解释', body.includes('未命中（没有条目过搜索线）：1 轮') && body.includes('命中闸门（过搜索线但没过 floor）：1 轮') && body.includes('会话预算用尽：1 轮') && body.includes('同话题抑制（上轮已注入）：1 轮'), '四行'
  )
  ok('I3.4 不认识的 reason 也列出来', body.includes('- weird：1 轮'), '未知出口')
  // 挡下的轮，gated 只写在 hit-skip 行上（floor 那行 gated=3）；旧算法只数 hit=yes 的行，
  // 于是「闸最生效的时候面板显示 0」——这里要求两边一起加：1（成功轮）+ 3（floor 挡下那轮）。
  ok('I3.5 挡下条数与压条数真的汇总（挡下轮的 gated 也计进来）', body.includes('闸门挡下的条目：4 条') && body.includes('正文被压：2 条'),
    (body.match(/闸门挡下的条目：[^\n]*/) ?? [''])[0] + ' / ' + (body.match(/正文被压：[^\n]*/) ?? [''])[0])
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

  // 0.6.47：同一轮会写两行（hit-skip 说原因 + hit-chain 说结果），旧算法两行各算一轮。
  const pairWs = join(root, '.probe-injectlog-pair')
  rmSync(pairWs, { recursive: true, force: true })
  mkdirSync(join(pairWs, '.dsh-meow'), { recursive: true })
  writeFileSync(join(pairWs, '.dsh-meow', 'dream-debug.log'), [
    '[2026-11-25T02:00:00.100Z] hit-skip reason=floor gated=2 floor=0.35 sid=p1',
    '[2026-11-25T02:00:00.180Z] hit-chain pid=1 sid=p1 textLen=40 hit=null floor=0.35 gated=0 spent=0/∞',
    '[2026-11-25T02:00:01.100Z] hit-skip reason=repeat repeated=3 sim=0.31 prevTop=1.2 sid=p1',
    '[2026-11-25T02:00:01.160Z] hit-chain pid=1 sid=p1 textLen=40 hit=null floor=0.35 gated=0 spent=0/∞ repeated=0',
  ].join('\n') + '\n', 'utf8')
  const pairBody = L.readInjectPanel({ workspace: pairWs, dir: '.dsh-meow', limit: 0 }).body
  ok('I3.13 同一轮的两行（hit-skip + hit-chain）只算一轮', pairBody.includes('2 轮里有 0 轮注入、2 轮没注入'),
    (pairBody.match(/出口：[^\n]*/) ?? [''])[0])
  ok('I3.14 全被挡下的会话里，挡下条数 / 同话题抑制仍然看得见（不是 0）',
    pairBody.includes('闸门挡下的条目：2 条') && pairBody.includes('同话题抑制：3 条'),
    pairBody.split('\n').filter((l) => l.includes(' 条')).join(' | '))
  rmSync(pairWs, { recursive: true, force: true })
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

// ── I7 老条目放回：released= / reinject= 要读得出来（0.6.49）─────────────────
{
  const lines = [
    '[2026-11-25T02:00:00.000Z] hit-chain pid=1 sid=abcd1234 textLen=300 hit=yes floor=0.35 gated=0 body=240 bodyCut=0 sim=0.25 repeated=0 released=2 reinject=12 spent=300/∞',
    '[2026-11-25T02:05:00.000Z] hit-skip reason=empty released=5 reinject=12',
    '[2026-11-25T02:10:00.000Z] hit-chain pid=1 sid=abcd1234 textLen=120 hit=yes floor=0.35 gated=0 body=240 bodyCut=0 sim=0.25 repeated=0 released=0 reinject=12 spent=420/∞',
  ]
  writeFileSync(LOG, lines.join('\n') + '\n', 'utf8')
  const body = L.readInjectPanel({ workspace: ws, dir: '.dsh-meow', config: {} }).body
  ok('I7.1 面板单列一行「老条目放回」（命中轮 2 条 + 挡下轮 5 条 = 7 条）',
    /老条目放回：7 条/.test(body), (body.match(/老条目放回：[^\n]*/) ?? [''])[0])
  ok('I7.2 这一行把窗口轮数写出来（不是只给个数字）',
    /隔 12 轮没再给过/.test(body), (body.match(/老条目放回：[^\n]*/) ?? [''])[0])
  ok('I7.3 闸门口径里带上重放窗口', /重放 12 轮/.test(body), (body.match(/闸门：[^\n]*/) ?? [''])[0])
  ok('I7.4 released=0 的轮不吹成「放回了」', !/放回 0\b/.test(body) && /放回 2\b/.test(body),
    (body.match(/放回 \d+ 条/) ?? [''])[0])
}

// ── I8 邻域注入也进这本账：两段分开算，不相加（0.6.50）──────────────────────
// 病根：邻域注入每轮往上下文里塞一段，账上一行都没有；面板只念命中那一半，
// 用户看到「注入了 240 字」其实是两条路径合起来的消耗。这一块守：邻域段单独出、
// 出口名是邻域自己的那套、明细能一条一条对回来、没有邻域行时不出空段。
{
  const lines = [
    '[2026-11-25T03:00:00.000Z] hit-chain pid=1 sid=s1 textLen=240 hit=yes floor=0.35 gated=0 body=240 bodyCut=0 sim=0.25 repeated=0 released=0 reinject=12 spent=240/∞',
    '[2026-11-25T03:01:00.000Z] neighbor-chain pid=1 sid=s1 ids=3 chars=812 weak=1 offtopic=1 flagged=1 deduped=2 max=4 cap=420 minScore=0.35',
    '[2026-11-25T03:02:00.000Z] neighbor-skip pid=1 sid=s1 reason=short',
    '[2026-11-25T03:03:00.000Z] neighbor-skip pid=1 sid=s1 reason=tool',
    '[2026-11-25T03:04:00.000Z] neighbor-chain pid=1 sid=s1 ids=2 chars=401 weak=0 offtopic=0 flagged=0 deduped=0 max=4 cap=420 minScore=0.35',
  ]
  writeFileSync(LOG, lines.join('\n') + '\n', 'utf8')
  const body = L.readInjectPanel({ workspace: ws, dir: '.dsh-meow', limit: 20, config: {} }).body
  ok('I8.1 面板单出一段「邻域注入」：轮数 / 合计字数 / 平均 / 中位 / 条数',
    /邻域注入：4 轮里 2 轮带进上下文/.test(body) && /合计 1,213 字/.test(body) && /共 5 条/.test(body),
    (body.match(/邻域注入：[^\n]*/) ?? [''])[0])
  ok('I8.2 没带的原因用邻域自己的出口名（short / tool 不是命中那四种）',
    /没带的原因：/.test(body) && /问句太短/.test(body) && /星图没查成/.test(body),
    (body.match(/- 没带的原因：[^\n]*/) ?? [''])[0])
  ok('I8.3 去重 / 未沾词 / 强度 / 打标四个读数各占一行（砍掉的条数不是黑箱）',
    /跨层去重：跳过 2 条/.test(body) && /未沾词：1 条/.test(body) &&
      /强度不够：1 条/.test(body) && /打标记：1 条/.test(body))
  ok('I8.4 明细里邻域行与命中行并排，各自说自己那一轮（不相加、不互相顶掉）',
    /邻域 3 条 · 812 字 · 未沾词 1 · 去重 2 · 打标 1/.test(body) && /邻域没带：问句太短/.test(body) &&
      /注入 240 字/.test(body))
  ok('I8.5 抬头写明邻域轮数（与出口轮数分开两个口径）',
    /邻域 4 轮/.test(L.readInjectPanel({ workspace: ws, dir: '.dsh-meow', config: {} }).scope))
  // 只有命中行的旧日志：不许凭空生出「邻域注入：0 轮」这种段（没数据就说没数据）
  writeFileSync(LOG, '[2026-11-25T03:10:00.000Z] hit-chain pid=1 sid=s1 textLen=100 hit=yes floor=0.35 gated=0 body=240 bodyCut=0 sim=0.25 repeated=0 spent=100/∞\n', 'utf8')
  const oldBody = L.readInjectPanel({ workspace: ws, dir: '.dsh-meow', config: {} }).body
  ok('I8.6 一行邻域账都没有时不出邻域段（旧日志照旧读，不伪造 0）',
    !/邻域注入：/.test(oldBody) && /注入 100 字/.test(oldBody), oldBody.split('\n').length + ' 行')
}
// ── I9 一轮合计：命中与邻域在同一轮里要合账（0.6.51）──────────────────────────
// 病根：0.6.50 把两段分开念之后，「这一轮上下文到底被塞了多少字」谁也答不出。
// 这一块守：只有两边都配上的轮才合计（单边轮不硬凑）、明细里并成一行、
// 配不上的邻域行照旧单列、没有邻域行时不出这一行。
{
  const lines = [
    '[2026-11-25T03:20:00.000Z] hit-chain pid=1 sid=s1 textLen=240 hit=yes floor=0.35 gated=0 body=240 bodyCut=0 sim=0.25 repeated=0 released=0 reinject=12 spent=240/∞',
    '[2026-11-25T03:20:01.000Z] neighbor-chain pid=1 sid=s1 ids=3 chars=320 weak=0 offtopic=0 flagged=0 deduped=0 max=4 cap=420 minScore=0.35',
    '[2026-11-25T03:25:00.000Z] hit-chain pid=1 sid=s1 textLen=300 hit=yes floor=0.35 gated=0 body=240 bodyCut=0 sim=0.25 repeated=0 released=0 reinject=12 spent=540/∞',
    '[2026-11-25T03:25:02.000Z] neighbor-chain pid=1 sid=s1 ids=1 chars=100 weak=0 offtopic=0 flagged=0 deduped=0 max=4 cap=420 minScore=0.35',
    '[2026-11-25T03:30:00.000Z] hit-chain pid=1 sid=s2 textLen=120 hit=yes floor=0.35 gated=0 body=240 bodyCut=0 sim=0.25 repeated=0 released=0 reinject=12 spent=120/∞',
    '[2026-11-25T03:35:00.000Z] neighbor-chain pid=1 sid=s3 ids=1 chars=60 weak=0 offtopic=0 flagged=0 deduped=0 max=4 cap=420 minScore=0.35',
  ]
  writeFileSync(LOG, lines.join('\n') + '\n', 'utf8')
  const body = L.readInjectPanel({ workspace: ws, dir: '.dsh-meow', limit: 20, config: {} }).body
  ok('I9.1 单列一行「一轮合计」：轮数 / 合计字数 / 平均 / 最多 / 邻域占比（960 = 240+320+300+100）',
    /一轮合计：命中与邻域都有账的 2 轮里，一起花 960 字（平均 480 字 \/ 最多 560 字；其中邻域 420 字，占 44%）/.test(body),
    (body.match(/一轮合计：[^\n]*/) ?? [''])[0])
  ok('I9.2 明细里同一轮并成一行（命中字数 + 邻域条数字数 + 合计）',
    /注入 240 字 · 邻域 3 条 320 字（合计 560 字）/.test(body), (body.match(/- [^\n]*合计 560 字[^\n]*/) ?? [''])[0])
  ok('I9.3 并进合计的那条邻域行不再重复出现（邻域行只剩配不上的那条）',
    (body.match(/· 邻域 \d+ 条/g) ?? []).length === 2 && /邻域 1 条 · 60 字/.test(body),
    (body.match(/· 邻域 \d+ 条/g) ?? []).length + ' 处')
  ok('I9.4 单边轮不硬凑（s2 只有命中、s3 只有邻域，都不进合计）',
    !/合计 1,080 字/.test(body) && !/合计 1,020 字/.test(body) && !/平均 360 字/.test(body), '单边轮')
  // 只有命中行的日志：不许凭空造一行「一轮合计：0 轮」
  writeFileSync(LOG, '[2026-11-25T03:40:00.000Z] hit-chain pid=1 sid=s1 textLen=100 hit=yes floor=0.35 gated=0 body=240 bodyCut=0 sim=0.25 repeated=0 spent=100/∞\n', 'utf8')
  const onlyHit = L.readInjectPanel({ workspace: ws, dir: '.dsh-meow', config: {} }).body
  ok('I9.5 没有邻域行时不出「一轮合计」（没数据就说没数据，不写 0 轮）',
    !/一轮合计/.test(onlyHit) && /注入 100 字/.test(onlyHit), onlyHit.split('\n').length + ' 行')
}

// ── I10 本场会话累计：按 sid 把一场会话并起来（0.6.52）──────────────────────
// 病根：0.6.51 只答得出「这一轮花了多少」，答不出「这场聊下来一共花了多少」。
// 这一块守：按最近一场会话算、命中与邻域各自求和再合计、长 sid 截短、没有 sid 的老账不进这一行。
{
  const lines = [
    '[2026-11-25T04:00:00.000Z] hit-chain pid=1 sid=sa textLen=240 hit=yes floor=0.35 gated=0 body=240 bodyCut=0 sim=0.25 repeated=0 released=0 reinject=12 spent=240/∞',
    '[2026-11-25T04:00:01.000Z] neighbor-chain pid=1 sid=sa ids=3 chars=320 weak=0 offtopic=0 flagged=0 deduped=0 max=4 cap=420 minScore=0.35',
    '[2026-11-25T04:05:00.000Z] hit-chain pid=1 sid=sa textLen=300 hit=yes floor=0.35 gated=0 body=240 bodyCut=0 sim=0.25 repeated=0 released=0 reinject=12 spent=540/∞',
    '[2026-11-25T04:10:00.000Z] hit-chain pid=1 sid=sb textLen=120 hit=yes floor=0.35 gated=0 body=240 bodyCut=0 sim=0.25 repeated=0 released=0 reinject=12 spent=120/∞',
  ]
  writeFileSync(LOG, lines.join('\n') + '\n', 'utf8')
  const body = L.readInjectPanel({ workspace: ws, dir: '.dsh-meow', limit: 20, config: {} }).body
  ok('I10.1 只算「最近一场会话」：sb 的 1 轮 120 字，不带上前一场的 540',
    /本场会话（sb）：命中注入 1 轮 \/ 120 字，邻域 0 轮 \/ 0 字，合计 120 字/.test(body),
    (body.match(/本场会话：[^\n]*/) ?? body.match(/本场会话[^\n]*/) ?? [''])[0])
  // 把最新一条换成 sa：同一场里的两轮命中 + 一轮邻域都要并进来
  writeFileSync(LOG, lines.slice(0, 3).join('\n') + '\n', 'utf8')
  const saBody = L.readInjectPanel({ workspace: ws, dir: '.dsh-meow', limit: 20, config: {} }).body
  ok('I10.2 同一场里命中 2 轮 540 字 + 邻域 1 轮 320 字 = 860 字',
    /本场会话（sa）：命中注入 2 轮 \/ 540 字，邻域 1 轮 \/ 320 字，合计 860 字/.test(saBody),
    (saBody.match(/本场会话[^\n]*/) ?? [''])[0])
  // 长 sid 截成前 8 位 + 省略号（别把整串 uuid 铺在面板里）
  writeFileSync(LOG, '[2026-11-25T04:20:00.000Z] hit-chain pid=1 sid=0123456789abcdef textLen=100 hit=yes floor=0.35 gated=0 body=240 bodyCut=0 sim=0.25 repeated=0 spent=100/∞\n', 'utf8')
  const longBody = L.readInjectPanel({ workspace: ws, dir: '.dsh-meow', config: {} }).body
  ok('I10.3 长 sid 截成前 8 位加省略号', /本场会话（01234567…）：/.test(longBody), (longBody.match(/本场会话[^\n]*/) ?? [''])[0])
  // 没有 sid 的老账：不许造一行「本场会话（）」
  writeFileSync(LOG, '[2026-11-25T04:30:00.000Z] hit-chain pid=1 textLen=100 hit=yes floor=0.35 gated=0 body=240 bodyCut=0 sim=0.25 repeated=0 spent=100/∞\n', 'utf8')
  const noSid = L.readInjectPanel({ workspace: ws, dir: '.dsh-meow', config: {} }).body
  ok('I10.4 没有 sid 的账不进这一行（空括号不写；.old 里带 sid 的账照旧念）', !/本场会话（）：/.test(noSid) && /本场会话（zzzz）：/.test(noSid), (noSid.match(/本场会话[^\n]*/) ?? [''])[0])
}

// ── I11 其他场次：同一份账里不止一场会话（0.6.53）────────────────────────────
// 病根：0.6.52 只念最近一场，多窗口 / 多工作目录并发时别的场次花掉的字完全看不见。
// 这一块守：新的在前、最多 3 场、零字的场次不列、多出来的说清还有几场、只有一场时不出这一行。
{
  const lines = [
    '[2026-11-25T04:00:00.000Z] hit-chain pid=1 sid=sa textLen=100 hit=yes floor=0.35 gated=0 body=240 bodyCut=0 sim=0.25 repeated=0 spent=100/∞',
    '[2026-11-25T04:10:00.000Z] hit-chain pid=1 sid=sb textLen=200 hit=yes floor=0.35 gated=0 body=240 bodyCut=0 sim=0.25 repeated=0 spent=200/∞',
    '[2026-11-25T04:20:00.000Z] hit-chain pid=1 sid=sc textLen=300 hit=yes floor=0.35 gated=0 body=240 bodyCut=0 sim=0.25 repeated=0 spent=300/∞',
    '[2026-11-25T04:25:00.000Z] hit-chain pid=1 sid=se textLen=50 hit=null floor=0.35 gated=0 body=240 bodyCut=0 sim=0.25 repeated=0 spent=0/∞',
    '[2026-11-25T04:30:00.000Z] neighbor-chain pid=1 sid=sd ids=2 chars=400 weak=0 offtopic=0 flagged=0 deduped=0 max=4 cap=420 minScore=0.35',
  ]
  writeFileSync(LOG, lines.join('\n') + '\n', 'utf8')
  const body = L.readInjectPanel({ workspace: ws, dir: '.dsh-meow', limit: 20, config: {} }).body
  const line = (body.match(/其他场次：[^\n]*/) ?? [''])[0]
  ok('I11.1 其他场次新的在前、每场给合计与两轮数（sc 300 · sb 200 · sa 100）',
    /其他场次：sc 300 字（命中 1 轮 \/ 邻域 0 轮） · sb 200 字（命中 1 轮 \/ 邻域 0 轮） · sa 100 字（命中 1 轮 \/ 邻域 0 轮）/.test(line),
    line)
  ok('I11.2 最近一场（sd）只在本场会话那一行出现，不在其他场次里重复',
    /本场会话（sd）：命中注入 0 轮 \/ 0 字，邻域 1 轮 \/ 400 字/.test(body) && !/其他场次：[^\n]*sd/.test(line), line)
  ok('I11.3 零字的场次不列（se 记的是挡下，不是注入）', !/其他场次：[^\n]*se/.test(line), line)
  ok('I11.4 超过 3 场时把「还有几场」说出来（spare 来自 .old 的 zzzz）',
    /另有 1 场未列/.test(line), line)
  // 只有一场会话：这一行根本不出现
  const oneWs = join(root, '.probe-injectlog-one')
  mkdirSync(join(oneWs, '.dsh-meow'), { recursive: true })
  writeFileSync(join(oneWs, '.dsh-meow', 'dream-debug.log'),
    '[2026-11-25T05:00:00.000Z] hit-chain pid=1 sid=solo textLen=90 hit=yes floor=0.35 gated=0 body=240 bodyCut=0 sim=0.25 repeated=0 spent=90/∞\n', 'utf8')
  const oneBody = L.readInjectPanel({ workspace: oneWs, dir: '.dsh-meow', config: {} }).body
  ok('I11.5 只有一场会话时不出「其他场次」（不写空行、不写 0 场）',
    /本场会话（solo）/.test(oneBody) && !/其他场次/.test(oneBody), oneBody.split('\n').length + ' 行')
  rmSync(oneWs, { recursive: true, force: true })
}

// ── I12 错边账也念得出来：压住几跳、断掉几跳（0.6.54）────────────────────────
// 病根：错边账写进日志之后，面板还只念「邻域带了几条」——用户看不到那几跳被压住了、
// 也看不到模型真断过；「AI 修了、账上没修」与「账上压着、面板不提」是同一种不闭环。
// 这一块守：汇总行两支各自成立、明细点得回哪一跳、同轮两行不重复、没发生就不出行。
{
  const edgeWs = join(root, '.probe-injectlog-edge')
  mkdirSync(join(edgeWs, '.dsh-meow'), { recursive: true })
  const EDGE_LOG = join(edgeWs, '.dsh-meow', 'dream-debug.log')
  const L1 = [
    '[2026-11-25T06:00:00.000Z] neighbor-chain pid=1 sid=e1 ids=2 chars=300 weak=0 offtopic=1 flagged=1 deduped=0 max=4 cap=420 minScore=0.35',
    '[2026-11-25T06:00:00.000Z] neighbor-suspect pid=1 sid=e1 withheld=2 turns=3 ids=aa111111,bb222222',
    '[2026-11-25T06:00:01.000Z] neighbor-skip pid=1 sid=e1 reason=suspect withheld=2 turns=3 ids=aa111111,bb222222',
    '[2026-11-25T06:00:10.000Z] neighbor-suspect pid=1 sid=e1 withheld=3 turns=3 ids=aa111111,bb222222,cc333333',
    '[2026-11-25T06:00:20.000Z] neighbor-fix pid=1 a=aa111111 b=bb222222 via=mute cleared=1',
    '[2026-11-25T06:00:30.000Z] neighbor-fix pid=1 a=cc333333 b=dd444444 via=mute cleared=2',
  ].join('\n') + '\n'
  writeFileSync(EDGE_LOG, L1, 'utf8')
  const edgeBody = L.readInjectPanel({ workspace: edgeWs, dir: '.dsh-meow', limit: 20, config: {} }).body
  const sum = (edgeBody.match(/- 错边：[^\n]*/) ?? [""])[0]
  ok('I12.1 错边汇总行两支都在：压住几跳（取最新一条）+ AI 已断几跳（按销账条数累加）',
    /暂时不带 3 跳（连标 3 轮还没修，图没动、账留着）/.test(sum) && /AI 已断 3 跳（mute 之后当场销账）/.test(sum), sum)
  ok('I12.2 明细点得回是哪一跳：a ↔ b + via + 销账几条',
    /断开一跳：aa111111 ↔ bb222222（mute，销账 1 条）/.test(edgeBody) &&
      /断开一跳：cc333333 ↔ dd444444（mute，销账 2 条）/.test(edgeBody),
    (edgeBody.match(/- [^\n]*断开一跳[^\n]*/g) ?? []).join(' | '))
  ok('I12.3 同一轮「整轮没带」与「压住哪几跳」说的是同一件事：只出一行（取信息多的那条）',
    (edgeBody.match(/错边压住：\d+ 跳先不带/g) ?? []).length === 1,
    String((edgeBody.match(/错边压住：\d+ 跳先不带/g) ?? []).length))
  ok('I12.4 出口名念得出来（不是 reason 原文当中文摆着）',
    /没带的原因：[^\n]*错边压住（连续标了未沾词，先不带） 1 轮/.test(edgeBody),
    (edgeBody.match(/没带的原因：[^\n]*/) ?? [''].slice(0, 1))[0])

  // 只有断过、没压住过：不许凭空写「暂时不带 0 跳」
  const fixOnly = join(root, '.probe-injectlog-edge2')
  mkdirSync(join(fixOnly, '.dsh-meow'), { recursive: true })
  writeFileSync(join(fixOnly, '.dsh-meow', 'dream-debug.log'),
    '[2026-11-25T06:10:00.000Z] neighbor-chain pid=1 sid=e2 ids=1 chars=120 weak=0 offtopic=0 flagged=0 deduped=0 max=4 cap=420 minScore=0.35\n' +
      '[2026-11-25T06:10:05.000Z] neighbor-fix pid=1 a=aa111111 b=bb222222 via=mute cleared=1\n', 'utf8')
  const fixBody = L.readInjectPanel({ workspace: fixOnly, dir: '.dsh-meow', config: {} }).body
  const fixSum = (fixBody.match(/- 错边：[^\n]*/) ?? [""])[0]
  ok('I12.5 只断过没压过：只写「AI 已断」，不写「暂时不带 0 跳」',
    /AI 已断 1 跳/.test(fixSum) && !/暂时不带/.test(fixSum), fixSum)

  // 一类都没有：连「错边」这两个字都不出现（没发生的事不占行）
  const cleanWs = join(root, '.probe-injectlog-edge3')
  mkdirSync(join(cleanWs, '.dsh-meow'), { recursive: true })
  writeFileSync(join(cleanWs, '.dsh-meow', 'dream-debug.log'),
    '[2026-11-25T06:20:00.000Z] hit-chain pid=1 sid=e3 textLen=120 hit=yes floor=0.35 gated=0 body=240 bodyCut=0 sim=0.25 repeated=0 spent=120/∞\n', 'utf8')
  const cleanBody = L.readInjectPanel({ workspace: cleanWs, dir: '.dsh-meow', config: {} }).body
  ok('I12.6 没有错边账时一个字都不提（不写空段、不写 0 跳）', !/错边/.test(cleanBody), cleanBody.split('\n').length + ' 行')
  rmSync(edgeWs, { recursive: true, force: true })
  rmSync(fixOnly, { recursive: true, force: true })
  rmSync(cleanWs, { recursive: true, force: true })
}

rmSync(ws, { recursive: true, force: true })

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILED'} ${pass}/${pass + fail}`)
if (fail > 0) {
  console.log('--- 失败明细 ---')
  for (const b of bad) console.log('  ' + b)
  process.exitCode = 1
}
