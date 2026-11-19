/**
 * 真引擎端到端探针：真 cordis 式 ctx + 真 meow 库 + 真 nebula 引擎。
 *
 * 为什么要这一支：`probe-host.mjs` 用的是真 ToolsService（真宿主契约），但星图那半边是空的；
 * `probe-fusion.mjs` 里 nebula 是 stub。于是「meow 写的记忆真的进了星图、links 真的成了边」
 * 这条最关键的融合主张一直没被机器验过——这里把它补上。
 *
 * 做法：临时 DSH_HOME + 临时工作区，按生产布局建 `.dsh-meow/memory.db`，
 * 把工作区登记进 `storages/workspace.json`，让 nebula 的 meow 适配器真的扫到它；
 * 然后只通过 macro 的 8 个工具操作，最后去问星图「现在几条记忆、几条连接」。
 *
 * 只读断言、不碰真实 DSH_HOME，跑完删临时目录。
 */
import { root } from './_root.mjs'
import { registerHooks } from 'node:module'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const home = mkdtempSync(join(tmpdir(), 'macro-graph-home-'))
process.env.DSH_HOME = home

// meow 依赖 @deepseek-ai/dsh-llm 的两个纯函数；探针里不需要真模型
const stubDir = mkdtempSync(join(tmpdir(), 'macro-graph-stub-'))
const stubFile = join(stubDir, 'dsh-llm.mjs')
writeFileSync(
  stubFile,
  'export function createUserMessage(init){return {role:"user",...init}}\nexport function boundContextSummary(t){return String(t).slice(0,120)}\nexport default {createUserMessage, boundContextSummary}\n',
)
registerHooks({ resolve: (s, c, next) => (s === '@deepseek-ai/dsh-llm' ? { url: pathToFileURL(stubFile).href, shortCircuit: true } : next(s, c)) })

let failures = 0
let checks = 0
function check(name, ok, detail = '') {
  checks += 1
  if (!ok) failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`)
}

const noop = () => {}
const tools = new Map()
const services = {
  tools: { register: (d) => (tools.set(d.name, d), () => tools.delete(d.name)), get: (n) => tools.get(n), list: () => [...tools.keys()] },
  systemPrompt: { section: noop, context: noop, tools: noop, variable: noop },
}
const makeCtx = () => {
  const base = {
    get: (n) => services[n],
    effect(fn) {
      const d = typeof fn === 'function' ? fn() : undefined
      return typeof d === 'function' ? d : () => {}
    },
    on: () => noop,
    inject(deps, cb) {
      return typeof cb === 'function' ? cb(makeCtx()) : makeCtx()
    },
    plugin(mod, cfg) {
      const a = typeof mod === 'function' ? mod : mod?.apply
      if (typeof a === 'function') {
        try {
          return a(makeCtx(), cfg)
        } catch (e) {
          console.log('  (子插件抛错)', mod?.name, e.message)
        }
      }
    },
    tools: services.tools,
    systemPrompt: services.systemPrompt,
    logger: { debug: noop, info: noop, warn: noop, error: noop },
    webServer: { registerRoutes: () => noop, route: () => noop },
    connection: { on: () => noop },
    settings: { get: () => undefined, set: noop, watch: () => noop },
    configEditor: { register: () => noop },
    reflect: { get: () => undefined },
    session: null,
  }
  return new Proxy(base, { get: (t, k) => (k in t ? t[k] : noop) })
}

const ws = join(home, 'ws')
mkdirSync(ws, { recursive: true })
mkdirSync(join(home, 'storages', 'meow-memory'), { recursive: true })

// 建库（等价于这个工作区第一次开会话）
const Meow = await import(pathToFileURL(join(root, 'vendor', 'meow-memory', 'lib', 'index.js')).href)
Meow.getDb(ws, '.dsh-meow')
// 信任闸：window-index 里登记过的窗口在启动时会被 seed 成受信任工作区
const meowHome = join(home, 'storages', 'meow-memory')
writeFileSync(join(meowHome, 'window-index.json'), JSON.stringify({ 'sess-graph': ws }), 'utf8')
// 星图的工作区来源 = 注册表（生产就是这个文件）
writeFileSync(
  join(home, 'storages', 'workspace.json'),
  JSON.stringify({ unit: { name: 'workspace', version: 2 }, tables: { workspaces: { 'ws-probe': { path: ws, title: 'probe-ws' } } } }),
  'utf8',
)

const host = await import(pathToFileURL(join(root, 'lib', 'index.js')).href)
const panelMod = await import(pathToFileURL(join(root, 'lib', 'macro', 'panel.js')).href)
await host.apply(makeCtx(), { meow: { promptLang: 'zh', homeDir: meowHome }, nebula: {}, flushThrottleMs: 0 })
await new Promise((r) => setTimeout(r, 2000))

const exec = { agent: { session: { header: { cwd: ws, id: 'sess-graph' } } } }
const text = (v) => (typeof v === 'string' ? v : JSON.stringify(v))
async function run(name, args) {
  const def = tools.get(name)
  if (!def) throw new Error(`工具缺失：${name}`)
  return def.execute(args, exec)
}
// 面板抬头（0.2.25）之后，正文不再是第一行：剥掉抬头再按行读（stripHead 是这层契约的唯一出口）
const stat = async () => panelMod.stripHead(text(await run('memory_admin', { action: 'stats' }))).split('\n')[0]
const num = (line, unit) => Number((line.match(new RegExp(`(\\d+)\\s*[条个]${unit}`)) || [])[1] ?? -1)
// 星图的「没命中」文案是 `星图里没有匹配「<query>」的记忆。`，会回显 query，
// 所以判命中必须排掉这句，否则 includes(query) 永远为真（写成假通过）。
const miss = (t) => t.includes('星图里没有匹配')

/** 等星图把库里的变化建进去（引擎 12s 一轮巡检，这里给到 40s）。 */
async function waitFor(pred, label, timeoutMs = 40000) {
  const t0 = Date.now()
  let last = ''
  while (Date.now() - t0 < timeoutMs) {
    last = await stat()
    if (pred(last, num)) return last
    await new Promise((r) => setTimeout(r, 2000))
  }
  console.log(`  (等不到 ${label}：${last})`)
  return last
}

// G1: 装配面——真引擎接上之后，暴露给模型的仍然只有 8 个统一工具
{
  const names = [...tools.keys()].filter((n) => n.startsWith('memory_')).sort()
  check('G1 工具面是 8 个统一工具', names.length === 8, names.join(','))
  check('G1 星图工具没有漏进宿主面', !names.some((n) => n.startsWith('nebula_')))
}

// G1b: 图还空着的时候，体检不许说「共 0 项」——那是没算，不是干净（0.2.40）
{
  const body = panelMod.stripHead(text(await run('memory_admin', { action: 'hygiene' })))
  check('G1b 空图时体检说「等于没算」，不是「共 0 项」', body.includes('这次体检等于没算') && !body.includes('共 0 项'), body.split('\n')[0])
  check('G1b 空图时体检点明这不是「很干净」', body.includes('不是「很干净」'), body.split('\n')[0])
}

// G1d: 图还空着的时候，星图概况不许只回「0 条记忆 / 0 条连接」——那句话会被读成「记忆丢了」（0.2.41）
{
  const body = panelMod.stripHead(text(await run('memory_admin', { action: 'stats' })))
  check('G1d 空图时星图概况说清「星图现在还是空的」', body.includes('星图现在还是空的'), body.split('\n')[0])
  check('G1d 空图时星图概况点明「这不是记忆丢了」', body.includes('这不是「记忆丢了」'), body.split('\n')[0])
  check('G1d 空图时星图概况说清记忆本身没受影响', body.includes('记忆本身没受影响'), body.split('\n')[0])
}

// G2: 真 meow 写入 → 星图真的把它建成节点
const firstWrite = text(
  await run('memory_remember', {
    content: '图谱探针：星图应该从 meow 库读到这一条。',
    project: '图谱探针',
    keywords: ['图谱', '星图', '探针', 'meow', 'nebula', '融合', '联动', '索引'],
    importance: 2,
    level: 'fact',
  }),
)
const line2 = await waitFor((l, n) => n(l, '记忆') >= 1, '1 条记忆')
check('G2 写入后星图出现节点', num(line2, '记忆') >= 1, line2)
check('G2 工作区被扫到（不是 0 个）', num(line2, '工作区') >= 1, line2)
check('G2 会话账本被读到', num(line2, '会话账本') >= 1, line2)

// G1c: 有了节点之后，同一句话必须翻面（否则「等于没算」就是恒真的噪声）
{
  const body = panelMod.stripHead(text(await run('memory_admin', { action: 'hygiene' })))
  check('G1c 有节点后体检不再说「等于没算」', !body.includes('这次体检等于没算') && body.includes('共'), body.split('\n')[0])
}

// G1e: 概况也一样要翻面（同一句「星图现在还是空的」在图有节点后必须消失）
{
  const body = panelMod.stripHead(text(await run('memory_admin', { action: 'stats' })))
  check('G1e 有节点后星图概况不再说「还是空的」', !body.includes('星图现在还是空的') && num(body.split('\n')[0], '记忆') >= 1, body.split('\n')[0])
}

// 工具输出只给 8 位前缀，完整 id 去库里取（memory_link 内部也会补全，见 G5）
const { DatabaseSync } = await import('node:sqlite')
const db = new DatabaseSync(join(ws, '.dsh-meow', 'memory.db'))
const firstId = db.prepare('SELECT id FROM fact ORDER BY created_at ASC LIMIT 1').get()?.id
db.close()
check('G2 拿到第一条的完整 id', typeof firstId === 'string' && firstId.length >= 36, String(firstId))

// G3: links 直连——写第二条时顺手连上第一条，星图里真的多一条边
{
  const out = text(
    await run('memory_remember', {
      content: '图谱探针：第二条，带 links 指向第一条。',
      project: '图谱探针',
      keywords: ['第二条', '连线', '图谱', '探针', '边', '星图', '融合', '索引'],
      importance: 2,
      level: 'fact',
      links: [firstId],
    }),
  )
  check('G3 写入时就报「已连上」', out.includes('已连上'), out.split('\n').slice(-1)[0])
  const line3 = await waitFor((l, n) => n(l, '连接') >= 1, '1 条连接')
  check('G3 星图里真的多了一条边', num(line3, '连接') >= 1, line3)
  check('G3 队列没有欠账', !text(await run('memory_admin', { action: 'links' })).includes('待补连线：1'), '')
}

// H: 体检的「相似」和工具的「逐字重复度」是两把尺子（0.2.91）
// 语料：同一条前言 + 两个完全不同的核心。全文逐字四成左右，而星图的稀有词签名会顶到 1。
// 这一组存在的理由：面板说「相似 1」、工具说「逐字 0.42」，用户照着面板归档就是删掉一件独立的事。
{
  const P = '发版之前必须先把当前树备份到 D 盘，出问题先还原备份再排查。'
  const A = `${P}另外记住：数据库迁移之前要先跑一次 dry-run，确认回滚脚本可用。`
  const B = `${P}另外记住：前端配色统一用深蓝配米白，别再用灰色卡片。`
  const wa = text(
    await run('memory_remember', {
      content: A,
      project: '口径探针',
      keywords: ['口径', '重复', '体检', '签名', '幂等'],
      importance: 2,
      level: 'fact',
    }),
  )
  const wb = text(
    await run('memory_remember', {
      content: B,
      project: '口径探针',
      keywords: ['口径', '重复', '签名', '门槛', '幂等'],
      importance: 2,
      level: 'lesson',
    }),
  )
  check('H1 两条核心不同的都写下了', wa.includes('已写入') && wb.includes('已写入'), '')
  check('H2 写侧没把这两条判成重复（全文逐字远低于 80%）', !wb.includes('另一层已有几乎一样的条目'), wb.split('\n').slice(-1)[0].slice(0, 32))
  await waitFor((l, n) => n(l, '记忆') >= 3, '3 条记忆')

  const dbH = new DatabaseSync(join(ws, '.dsh-meow', 'memory.db'))
  const aId = dbH.prepare("SELECT id FROM fact WHERE content LIKE '%dry-run%' ORDER BY created_at DESC LIMIT 1").get()?.id
  const bId = dbH.prepare("SELECT id FROM lesson WHERE content LIKE '%前端配色%' ORDER BY created_at DESC LIMIT 1").get()?.id
  dbH.close()

  const full = text(await run('memory_admin', { action: 'hygiene', kind: 'dup' }))
  const headH = full.split('\n')[0]
  const sim = Number((full.match(/（相似 ([\d.]+)）/) || [])[1])
  check(
    'H3 体检把这一对列成疑似重复（按 id 找，不靠条数）',
    full.includes('疑似重复') && full.includes(String(aId).slice(0, 8)) && full.includes(String(bId).slice(0, 8)),
    full.split('\n').find((l) => l.startsWith('疑似重复')) ?? '',
  )
  check('H4 体检的「相似」在小编里顶到接近 1（签名退化成共有词）', Number.isFinite(sim) && sim >= 0.85, String(sim))
  check('H5 抬头点明是稀有词签名，不是逐字重复度', headH.includes('稀有词签名') && headH.includes('逐字重复度'), headH.slice(-40))

  const near = text(await run('memory_search', { mode: 'similar', id: aId, k: 5 }))
  const rep = Number((near.match(/逐字 ([\d.]+)/) || [])[1])
  check(
    'H6 同一对在工具里逐字只有四成，与面板的「相似」差 ≥0.4',
    Number.isFinite(rep) && rep > 0 && rep < 0.5 && sim - rep >= 0.4,
    `面板 ${sim} / 工具 ${rep}`,
  )

  const stale = text(await run('memory_admin', { action: 'hygiene', kind: 'stale' }))
  check('H7 只看别的类别时不掺这句话（不制造噪音）', !stale.includes('稀有词签名'), stale.split('\n')[0].slice(0, 30))
}

// GB: 星图概况的 hubs 参数（0.2.71）——给多少列多少
// 0.2.75: 尾注只报读者能数到的三个数（这段列了几条 / 有连接的共几条 / 上限几条），
// 不许再把「全图减这一撮」说成「还有 N 个枢纽没列」
{
  const oneLine = panelMod.stripHead(text(await run('memory_admin', { action: 'stats', hubs: 1 })))
  const bodyLines = oneLine.split('\n')
  const hubIdx = bodyLines.findIndex((l) => l.startsWith('枢纽记忆'))
  const listed = bodyLines.filter((l) => l.startsWith('- [')).length
  check('GB1 hubs=1 就只列 1 条', listed === 1, String(listed))
  check(
    'GB2 hubs=1 时抬头是固定那句，不再在抬头里自己报「只列前几条」',
    hubIdx >= 0 && bodyLines[hubIdx] === '枢纽记忆（按连接度 × 重要性排）：',
    hubIdx >= 0 ? bodyLines[hubIdx] : '没有枢纽记忆段',
  )
  const head = bodyLines.find((l) => l.startsWith('宏记忆 · 星图')) || ''
  const sub = bodyLines.find((l) => l.includes('孤立记忆')) || ''
  const nodesN = Number((head.match(/星图：(\d+) 条记忆/) || [])[1])
  const orphN = Number((sub.match(/孤立记忆 (\d+) 条/) || [])[1])
  const tailLine = bodyLines.find((l) => l.includes('条记忆彼此有连接')) || ''
  check(
    'GB3 有连接的记忆多于要列的条数时才出尾注（不截断就别说「没排上来」）',
    Number.isFinite(nodesN) && Number.isFinite(orphN) && (nodesN - orphN <= 1 ? tailLine === '' : tailLine.includes('没排上来')),
    `节点 ${nodesN} 孤立 ${orphN} 尾注 ${tailLine || '（无）'}`,
  )
  check('GB4 仍不许出现「还有 N 条没列」那种假账', !/还有 \d+ 条没列/.test(oneLine), '')
  const all = panelMod.stripHead(text(await run('memory_admin', { action: 'stats' })))
  check('GB5 没截断时整段不提「没排上来」', !all.includes('没排上来'), '')
}

// G4: 边是可读的——读第一条能看到「连接到的记忆」和连线理由
{
  const out = text(await run('memory_read', { id: firstId }))
  check('G4 读记忆带出邻居段', out.includes('连接到的记忆'), '')
  check('G4 邻居是第二条', out.includes('第二条'), '')
  check('G4 连线理由是写入时那条', out.includes('写入时顺手固化的关联'), '')
}

// G5: 短 id 也能连（工具输出只给 8 位前缀，模型照着抄是常态）
{
  const short = String(firstId).slice(0, 8)
  const out = text(await run('memory_link', { action: 'link', a: short, b: short, note: '自己连自己' }))
  check('G5 短 id 能识别出「自己不能连自己」', out.includes('不能把一条记忆和它自己配成一对'), out.slice(0, 80))
  check('G5 永久失败的连线不进队列', !text(await run('memory_admin', { action: 'links' })).includes('待补连线：1'), '')
}

// G6: 排队自愈——先排队，读一次就把队列清掉（不指望模型回来补）
{
  const linksMod = await import(pathToFileURL(join(root, 'lib', 'macro', 'links.js')).href)
  for (const e of linksMod.readPending()) linksMod.dropPending(e.a, e.b)
  const id2 = (() => {
    const d = new DatabaseSync(join(ws, '.dsh-meow', 'memory.db'))
    const r = d.prepare('SELECT id FROM fact ORDER BY created_at DESC LIMIT 1').get()?.id
    d.close()
    return r
  })()
  linksMod.queuePending(firstId, id2, '探针：排队后应被自动补上', '节点待入图')
  check('G6 排队进去了', linksMod.pendingCount() === 1, String(linksMod.pendingCount()))
  await run('memory_search', { query: '图谱探针', limit: 3 })
  check('G6 读一次就补上、队列清零', linksMod.pendingCount() === 0, String(linksMod.pendingCount()))
  const line6 = await stat()
  check('G6 连接数仍然 ≥1（没有乱连）', num(line6, '连接') >= 1, line6)
}

// G7: 永远连不上的条目不会烂在队列里
{
  const linksMod = await import(pathToFileURL(join(root, 'lib', 'macro', 'links.js')).href)
  linksMod.queuePending(firstId, 'gone-0000000000000000', '探针：目标不存在', '节点待入图')
  const out = text(await run('memory_admin', { action: 'links' }))
  check('G7 目标不存在的条目被清掉', linksMod.pendingCount() === 0, String(linksMod.pendingCount()))
  check('G7 面板说明清掉了', out.includes('永远连不上') || out.includes('0 条'), out.split('\n').slice(-1)[0])
}

// G9: 改写已有记忆 → 星图（12s 一轮巡检）真的把节点内容换掉，且不会长出重复节点
{
  const before = num(await stat(), '记忆')
  const out = text(
    await run('memory_update', { id: firstId, content: '图谱探针：这一条已经被改写，星图应该跟着更新。', keywords: ['图谱', '改写', '星图', '更新', '探针', '融合', '索引', '同步'] }),
  )
  check('G9 更新走通了', !/找不到/.test(out), out.split('\n')[0])
  // 星图是轮询式同步：这里等它自己把旧内容换掉，而不是立刻断言（立刻断言只能证明缓存旧）
  let seen = ''
  const t0 = Date.now()
  while (Date.now() - t0 < 40000) {
    seen = text(await run('memory_search', { query: '已经被改写', mode: 'graph', limit: 5 }))
    if (seen.includes('已经被改写') && !miss(seen)) break
    await new Promise((r) => setTimeout(r, 2000))
  }
  check('G9 星图节点内容跟着改写（不是永远缓存旧内容）', seen.includes('已经被改写') && !miss(seen), seen.split('\n').slice(0, 2).join(' / '))
  const after = await stat()
  check('G9 节点数不变（改写没有长出重复节点）', num(after, '记忆') === before, after)
}

// G10: 归档一条 → 星图检索不再返回它（节点留着但被状态过滤），记忆总数不涨
{
  const before = num(await stat(), '记忆')
  await run('memory_update', { id: firstId, status: 'archived' })
  let hit = ''
  const t0 = Date.now()
  while (Date.now() - t0 < 40000) {
    hit = text(await run('memory_search', { query: '已经被改写', mode: 'graph', limit: 5 }))
    if (miss(hit)) break
    await new Promise((r) => setTimeout(r, 2000))
  }
  check('G10 归档后星图检索不再命中', miss(hit), hit.split('\n').slice(0, 2).join(' / '))
  const after = await stat()
  check('G10 归档不会制造新节点', num(after, '记忆') <= before, after)
  // 恢复现场，后面的用例还要用它
  await run('memory_update', { id: firstId, status: 'active' })
}

// G11: 同一条重复写 → 星图不会重复计数（重建是幂等的）
{
  const before = num(await stat(), '记忆')
  await run('memory_remember', {
    content: '图谱探针：星图应该从 meow 库读到这一条。',
    project: '图谱探针',
    keywords: ['图谱', '星图', '探针', 'meow', 'nebula', '融合', '联动', '索引'],
    importance: 2,
    level: 'fact',
  })
  const after = await waitFor((l, n) => n(l, '记忆') === before + 1, '新增 1 个节点', 20000)
  check('G11 新写入只增加 1 个节点（重建幂等）', num(after, '记忆') === before + 1, `${before} → ${after}`)
}

// ── AN. 数值参数：0 是值不是「没给」，越界要被说出来（0.2.57）
// 老写法 `Math.max(1, Math.min(30, Number(args.limit) || 10))` 有两个坑：
//   ① `min_weight: 0`（明确要求不过滤）是 falsy → 被换成 0.5，结果少了还被劝「调低一点」；
//   ② 越界被夹住后一个字都不说，用户拿着被改过的条件读结论。
// 这里走的是**真工具面**（memory_search 的 graph / bridge 两个模式、memory_link 的 path），
// 不是桩：nebula_* 由 macro 内部持有，模型面看不到，参数只能从这三个入口进来。
{
  const g0 = text(await run('memory_search', { query: '图谱探针', mode: 'graph', limit: 0 }))
  check(
    'AN1 越界的 limit 被夹住，但说出来',
    g0.includes('limit 给的是「0」') && g0.includes('超出 1–30') && g0.includes('按 1 算'),
    g0.split('\n').slice(-1)[0],
  )
  const g9 = text(await run('memory_search', { query: '图谱探针', mode: 'graph', hops: 9 }))
  check('AN2 越界的 hops 也说出来', g9.includes('hops 给的是「9」') && g9.includes('按 3 算'), g9.split('\n').slice(-1)[0])
  const gz = text(await run('memory_search', { query: '图谱探针', mode: 'graph', hops: 0 }))
  check('AN3 hops 给 0 就照办 0（不当成没给）', !gz.includes('hops 给的是') && !gz.includes('按默认'), gz.split('\n').slice(-1)[0])
  const b0 = text(await run('memory_search', { query: '图谱探针', mode: 'bridge', min_weight: 0 }))
  check('AN4 min_weight 给 0 就照办 0（老代码会偷偷换成 0.5）', !b0.includes('min_weight 给的是'), b0.split('\n').slice(-1)[0])
  const b5 = text(await run('memory_search', { query: '图谱探针', mode: 'bridge', min_weight: 5 }))
  check(
    'AN5 越界的 min_weight 说出被夹到 1',
    b5.includes('min_weight 给的是「5」') && b5.includes('按 1 算'),
    b5.split('\n').slice(-1)[0],
  )
  const db2 = new DatabaseSync(join(ws, '.dsh-meow', 'memory.db'))
  const pair = db2.prepare('SELECT id FROM fact ORDER BY created_at ASC LIMIT 2').all().map((r) => r.id)
  db2.close()
  const p0 = text(await run('memory_link', { action: 'path', a: pair[0], b: pair[1], maxHops: 0 }))
  check('AN6 path 的 maxHops 越界要说出来', p0.includes('maxHops 给的是「0」') && p0.includes('按 1 算'), p0.split('\n').slice(-1)[0])
  const pOk = text(await run('memory_link', { action: 'path', a: pair[0], b: pair[1], maxHops: 4 }))
  check('AN7 合法 maxHops 一句都不加（防狼来了）', !pOk.includes('maxHops 给的是'), pOk.split('\n').slice(-1)[0])
}

// ── HD. 体检的条数账：抬头、正文、尾注得是同一本账（0.2.74）
// 列表有两道闸：引擎每类最多留 40 条（payload 有上限），参数 limit 再截一道。
// 老写法三处各报一个数——抬头按引擎那本账写「这里只列前 40 条」、正文按 limit 列 6 行、
// 尾注按 limit 减。「列了几条」这句话于是是假的。造 45 条互不相似的孤立记忆逼出 counts > 40。
{
  const SEED = 45
  // 45 条必须**互不相似**：memory_remember 有去重（内容相似度 ≥80% 会并进已有条目，
  // 只把原文替换掉、不新增节点），第一条模板化内容试过——45 次写入只长出 1 个节点。
  // 所以每条用不同的两字词组合，共享的大片段只留末尾那一小截。
  const SUBJ = ['鲸落', '潮汐', '盐雾', '礁石', '海沟', '沙洲', '暗流', '浮游', '冰川']
  const VERB = ['观察', '记录', '采样', '复原', '归档']
  const before = num(await stat(), '记忆')
  for (let i = 0; i < SEED; i += 1) {
    await run('memory_remember', {
      content: `${SUBJ[i % SUBJ.length]}${VERB[Math.floor(i / SUBJ.length)]}·hd74case${i} —— 孤立样本`,
      project: '体检条数探针',
      keywords: [`hd74-${i}-x`, `hd74-${i}-y`, `hd74-${i}-z`],
      importance: 1,
      level: 'fact',
    })
  }
  const line = await waitFor((l, n) => n(l, '记忆') >= before + SEED, `新增 ${SEED} 个节点`, 90000)
  check('HD0 这批孤立记忆都进了星图', num(line, '记忆') >= before + SEED, `${before} → ${line}`)

  const body = panelMod.stripHead(text(await run('memory_admin', { action: 'hygiene', kind: 'orphan', limit: 6 })))
  const head = Number((body.match(/孤立（(\d+)/) || [])[1] ?? -1)
  const rows = body.split('\n').filter((x) => x.startsWith('- [')).length
  const tail = Number((body.match(/…还有 (\d+) 条/) || [])[1] ?? -1)
  check('HD1 抬头只给全量计数，不谎报「只列前 40 条」', head > 40 && body.includes(`孤立（${head}）`) && !body.includes('只列前'), (body.split('\n')[1] || '').trim())
  check('HD2 正文列的条数就是 limit', rows === 6, `rows=${rows}`)
  check('HD3 尾注按正文实列算，三处数字能对上', tail === head - rows, `计数 ${head} = 列表 ${rows} + 尾注 ${tail}`)
  check('HD4 尾注说清这次上限是多少', body.includes('每类最多列 6 条'), (body.match(/…还有 \d+ 条（[^）]*）/) || [''])[0])
  const wide = panelMod.stripHead(text(await run('memory_admin', { action: 'hygiene', kind: 'orphan', limit: 20 })))
  const wrows = wide.split('\n').filter((x) => x.startsWith('- [')).length
  const wtail = Number((wide.match(/…还有 (\d+) 条/) || [])[1] ?? -1)
  check('HD5 limit 调大就多列，尾注跟着变', wrows === 20 && wtail === head - 20, `rows=${wrows} tail=${wtail}`)
}

// ── HB. 枢纽榜的尾注：只报读者数得到的三个数（0.2.75）
// 老写法把 `s.nodes - top.length` 当成「还有 N 条没列」——那 N 条里大多连一条边都没有，
// 等于在说「还有 N 个枢纽没给你看」。现在尾注报的是：列了几条 / 有连接的共几条 / 上限几条。
// 要验就必须让「有连接的记忆」多于「列出来的条数」，所以先牵几条边出来。
{
  const dbH = new DatabaseSync(join(ws, '.dsh-meow', 'memory.db'))
  const seeds = dbH
    .prepare("SELECT id FROM fact WHERE content LIKE '%hd74case%' ORDER BY created_at ASC LIMIT 4")
    .all()
    .map((r) => r.id)
  dbH.close()
  check('HB0 找得到四条孤立样本当底', seeds.length === 4, seeds.join(','))
  const cBefore = num(await stat(), '连接')
  const w1 = text(
    await run('memory_remember', {
      content: '枢纽探针：甲，由两条孤立样本牵出来的一条。',
      project: '体检条数探针',
      keywords: ['枢纽探针甲', 'hb75', '星图', '连接', '融合', '索引', '探针', '尾巴'],
      importance: 1,
      level: 'fact',
      links: [seeds[0], seeds[1]],
    }),
  )
  const w2 = text(
    await run('memory_remember', {
      content: '枢纽探针：乙，接着另外两条孤立样本的一条。',
      project: '体检条数探针',
      keywords: ['枢纽探针乙', 'hb75', '星图', '连接', '融合', '索引', '探针', '尾巴'],
      importance: 1,
      level: 'fact',
      links: [seeds[2], seeds[3]],
    }),
  )
  check(
    'HB1 两条带 links 的写入都说连上了',
    w1.includes('已连上') && w2.includes('已连上'),
    `${w1.split('\n').slice(-1)[0]} | ${w2.split('\n').slice(-1)[0]}`,
  )
  await waitFor((l, n) => n(l, '连接') >= cBefore + 4, '连接数 +4', 90000)
  const body = panelMod.stripHead(text(await run('memory_admin', { action: 'stats', hubs: 1 })))
  const bodyLines = body.split('\n')
  const head = bodyLines.find((l) => l.startsWith('宏记忆 · 星图')) || ''
  const sub = bodyLines.find((l) => l.includes('孤立记忆')) || ''
  const nodesN = Number((head.match(/星图：(\d+) 条记忆/) || [])[1])
  const orphN = Number((sub.match(/孤立记忆 (\d+) 条/) || [])[1])
  const tailLine = bodyLines.find((l) => l.includes('条记忆彼此有连接')) || ''
  const tailN = Number((tailLine.match(/全图 (\d+) 条记忆彼此有连接/) || [])[1])
  const rows = bodyLines.filter((l) => l.startsWith('- [')).length
  check('HB2 有连接的记忆够多时，尾注才出现', tailLine !== '', tailLine || '（没出现）')
  check(
    'HB3 尾注的「有连接的共几条」= 全图节点 − 孤立记忆（不是节点总数）',
    tailN === nodesN - orphN && tailN > 1,
    `节点 ${nodesN} 孤立 ${orphN} 尾注 ${tailN}`,
  )
  check(
    'HB4 尾注说清只取了几条、上限几条',
    tailLine.includes('排在最前的 1 条') && tailLine.includes('hubs 上限 40'),
    tailLine,
  )
  check('HB5 正文还是只列 1 条', rows === 1, `rows=${rows}`)
  check('HB6 没说成「还有 N 条没列」', !/还有 \d+ 条没列/.test(body), '')
}

// 尾巴：引擎真的在临时目录里跑起来了（不是读的什么缓存）
{
  const dirs = readdirSync(join(home, 'memory-nebula'))
  check('G8 引擎数据面落在临时 DSH_HOME', dirs.includes('nebula.db') && dirs.includes('engine'), dirs.join(','))
}

console.log('---')
console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`)
console.log(`临时 DSH_HOME：${home}`)
if (failures === 0) {
  try {
    rmSync(home, { recursive: true, force: true })
    rmSync(stubDir, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
}
process.exit(failures === 0 ? 0 : 1)
