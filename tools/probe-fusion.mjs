/**
 * 融合探针：真 vendor + 假 ctx，不启动 DSH、不碰真记忆库。
 *
 *   A. 插件形状：name / inject / 无 Config
 *   B. 装配结果：宿主只看到 8 个 memory_*；nebula_*、memory_find_similar、memory_home 不进宿主
 *   C. 注入单点：只有 macro-memory:guide 一段（order 130、≤1300 字符），nebula 的 RULE 被吞掉
 *   D. 端到端联动：remember → search(本地) → read(带邻居) → link → admin(cost/guide/stats)
 *
 * 用法：node tools/probe-fusion.mjs
 */
import { root } from './_root.mjs'
import { registerHooks } from 'node:module'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'


// ── 临时 DSH_HOME：记忆库、星图、成本账本全部落在里面 ────────────────────────
const home = mkdtempSync(join(tmpdir(), 'macro-fusion-home-'))
process.env.DSH_HOME = home

// ── dsh-llm stub（真实运行时由 profile 提供，本机没有实体）──────────────────
const stubDir = mkdtempSync(join(tmpdir(), 'macro-fusion-stub-'))
const stubFile = join(stubDir, 'dsh-llm.mjs')
writeFileSync(
  stubFile,
  `export function createUserMessage(init) { return { role: 'user', ...init } }
export function boundContextSummary(text) { return String(text).slice(0, 120) }
export default { createUserMessage, boundContextSummary }
`,
  'utf8',
)
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@deepseek-ai/dsh-llm') return { url: pathToFileURL(stubFile).href, shortCircuit: true }
    return nextResolve(specifier, context)
  },
})

let failures = 0
function check(label, ok, extra) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra === undefined ? '' : '  ' + extra}`)
  if (!ok) failures++
}

const noop = () => {}
const disposers = []

// ── 假 ctx（模仿 cordis 的用法面）──────────────────────────────────────────
const tools = new Map()
const prompts = []
const pluginCalls = []
// 录点：meow 除了工具之外还往宿主挂「命令 / 路由 / 生命周期钩子」，这些也必须原样到达（0.2.15）
const registeredCommands = []
const registeredRoutes = []
const ctxEvents = []
const services = {
  commands: {
    register(def) {
      registeredCommands.push(def)
      return noop
    },
    list: () => registeredCommands,
  },
  webServer: {
    register(route) {
      registeredRoutes.push(route)
      return noop
    },
    registerRoutes: () => noop,
    route: () => noop,
  },
  sessionPersistence: { list: async () => [] },
  tools: {
    register(def) {
      tools.set(def.name, def)
      return () => tools.delete(def.name)
    },
    get: (name) => tools.get(name),
    list: () => [...tools.keys()],
  },
  systemPrompt: {
    section(decl) {
      prompts.push({ kind: 'section', decl })
      return noop
    },
    context(decl) {
      prompts.push({ kind: 'context', decl })
      return noop
    },
    tools: noop,
    variable: noop,
  },
}

function makeCtx(parent = null) {
  const base = {
    get: (name) => services[name],
    effect(fn) {
      const d = typeof fn === 'function' ? fn() : undefined
      if (typeof d === 'function') disposers.push(d)
      return () => {}
    },
    on(event) {
      ctxEvents.push(event)
      return noop
    },
    inject(deps, cb) {
      if (typeof cb !== 'function') return ctx
      return cb(makeCtx(base))
    },
    plugin(mod, cfg) {
      pluginCalls.push({ name: mod?.name, inject: mod?.inject, cfg })
      const apply = typeof mod === 'function' ? mod : mod?.apply
      if (typeof apply === 'function') {
        try {
          return apply(makeCtx(base), cfg)
        } catch (err) {
          console.log(`  (子插件 ${mod?.name} apply 抛错，探针继续：${err.message})`)
        }
      }
      return undefined
    },
    tools: services.tools,
    systemPrompt: services.systemPrompt,
    logger: { debug: noop, info: noop, warn: (m) => console.log('  [warn]', m), error: noop },
    webServer: { registerRoutes: () => noop, route: () => noop },
    connection: { on: () => noop },
    settings: { get: () => undefined, set: noop, watch: () => noop },
    configEditor: { register: () => noop },
    reflect: { get: () => undefined },
    session: null,
  }
  const ctx = new Proxy(base, {
    get(t, k) {
      if (k in t) return t[k]
      return noop
    },
  })
  return ctx
}

// ── A. 插件形状 ────────────────────────────────────────────────────────────
const host = await import(pathToFileURL(join(root, 'lib', 'index.js')).href)
check('host: name', host.name === 'macro-memory', host.name)
check('host: version', typeof host.version === 'string', host.version)
check('host: inject = [tools]', JSON.stringify(host.inject) === JSON.stringify(['tools']), JSON.stringify(host.inject))
// 0.2.79：设置页能不能写，全看宿主拿不拿得到 Config——取不到就整条不返回，页面永远 unavailable。
check('host: 导出 Config（否则宿主设置页整条不返回）', typeof host.Config?.toJSON === 'function', typeof host.Config)
check('host: Config 根就是 volatile（设置页写入的唯一入口）', host.Config?.meta?.volatile === true)
check('host: Config 平铺到根（客户端只写顶层字段名）', host.Config?.dict?.enabled !== undefined && host.Config?.dict?.meow !== undefined, Object.keys(host.Config?.dict ?? {}).length + ' 个字段')

// ── B/C. 装配：真 vendor 走 facade ─────────────────────────────────────────
const fake = makeCtx()
const workspace = join(home, 'ws')
const storeDir = join(home, 'store')
mkdirSync(workspace, { recursive: true })
mkdirSync(storeDir, { recursive: true })
const ret = host.apply(fake, { meow: { homeDir: storeDir, promptLang: 'zh' }, nebula: {} })
if (ret && typeof ret.then === 'function') await ret
await new Promise((r) => setTimeout(r, 2000))

// 模拟真实会话开场：meow 在建库时把「新建的空工作区」记进信任名单，
// 探针里没有会话钩子，就自己开一次库，等价于会话第一条消息到达时的行为。
const Meow = await import(pathToFileURL(join(root, 'vendor', 'meow-memory', 'lib', 'index.js')).href)
try {
  Meow.getDb(workspace, '.dsh-meow')
} catch (err) {
  check('探针：建库失败', false, err.message)
}

check('装配：两个子插件都被挂上', pluginCalls.length === 2, pluginCalls.map((p) => p.name).join(' + '))

const hostTools = [...tools.keys()].sort()
const expected = [
  'memory_admin',
  'memory_dream',
  'memory_link',
  'memory_project',
  'memory_read',
  'memory_remember',
  'memory_search',
  'memory_update',
]
check('宿主工具面 = 8 个 memory_*', JSON.stringify(hostTools) === JSON.stringify(expected), hostTools.join(','))
check('nebula_* 未进宿主', !hostTools.some((n) => n.startsWith('nebula_')), hostTools.filter((n) => n.startsWith('nebula_')).join(','))
check('memory_find_similar 未进宿主', !hostTools.includes('memory_find_similar'))
check('memory_home 未进宿主', !hostTools.includes('memory_home'))

const guideCap = (await import(pathToFileURL(join(root, 'lib/macro/prompt.js')).href)).GUIDE_MAX_CHARS
const guideSections = prompts.filter((p) => p.kind === 'section')
check('注入段数 = 1', guideSections.length === 1, String(guideSections.length))
check('注入名 = macro-memory:guide', guideSections[0]?.decl?.name === 'macro-memory:guide', String(guideSections[0]?.decl?.name))
check('注入 order = 130', guideSections[0]?.decl?.order === 130, String(guideSections[0]?.decl?.order))
const guideText = guideSections[0]?.decl?.text
check('注入文本是字符串', typeof guideText === 'string', typeof guideText)
check(`注入 ≤${guideCap} 字符`, typeof guideText === 'string' && guideText.length <= guideCap, String(guideText?.length))
check('nebula RULE 未单独注入', !prompts.some((p) => String(p.decl?.name ?? '').includes('memory-nebula')))
check('注入提到 macro-memory', typeof guideText === 'string' && guideText.includes('macro-memory'))

// ── D. 端到端联动 ─────────────────────────────────────────────────────────
const exec = { agent: { session: { header: { cwd: workspace, id: 'sess-probe' } } } }
const run = (name, args) => tools.get(name).execute(args, exec)
const text = (v) => (typeof v === 'string' ? v : JSON.stringify(v))

try {
  const w1 = await run('memory_remember', {
    content: '探针记忆：融合层把 meow 与 nebula 缝成一套 memory_* 工具。',
    project: '探针项目',
    keywords: ['探针', '融合', 'macro', 'memory', 'nebula', 'meow', '统一工具', '星图', '联动'],
    importance: 2,
    level: 'fact',
  })
  check('D1 remember 成功', text(w1).includes('记忆已写入') || text(w1).includes('已合并'), text(w1).split('\n')[0])

  const w2 = await run('memory_search', { query: '探针 融合' })
  check('D2 search 命中', text(w2).includes('探针'), text(w2).split('\n')[0])
  if (process.env.PROBE_VERBOSE === '1') console.log(text(w2).slice(0, 1200))

  const idLine = text(w2).match(/\[([\w-]{5,})\]/) ?? text(w2).match(/id=([\w-]{5,})/)
  const id = idLine ? idLine[1] : undefined
  check('D2 抽出记忆 id', typeof id === 'string', String(id))

  if (id) {
    const r = await run('memory_read', { id, neighbors: 3 })
    check('D3 read 返回正文', text(r).includes('探针记忆'), text(r).split('\n')[0])

    const p = await run('memory_link', { action: 'path', a: id, b: 'nonexistent-node' })
    check('D4 link/path 有响应（星图缺节点也不炸）', text(p).length > 0, text(p).split('\n')[0])

    const upd = await run('memory_update', { id, importance: 3 })
    check('D5 update 成功', text(upd).length > 0, text(upd).split('\n')[0])
  }

  const g = await run('memory_admin', { action: 'guide' })
  check('D6 admin guide 吐出手册', text(g).length > 200, `${text(g).length} 字符`)
  check('D6 guide 含星图规则段', text(g).includes('星图规则') || text(g).includes('nebula_recall'), '')
  check('D6 guide 含记忆手册段', text(g).includes('记忆手册') || text(g).includes('memory_remember'), '')

  const cost = await run('memory_admin', { action: 'cost' })
  check('D7 成本账本有记录', text(cost).includes('最近'), text(cost).split('\n')[0])

  const stats = await run('memory_admin', { action: 'stats' })
  check('D8 星图统计可用', text(stats).length > 0, text(stats).split('\n')[0])

  // [macro-fusion 0.2.97] 整理留痕面板。先看空账本（阴性对照：这时候一个数字都不许报），
  // 再往真库里写两条账（一条带 0.2.96 的 plan、一条老格式），面板必须照账念、不自己算。
  const dreamEmpty = text(await run('memory_admin', { action: 'dream' }))
  check('D9 空账本只说没跑过', dreamEmpty.includes('整理留痕') && dreamEmpty.includes('还是空的'), dreamEmpty.split('\n').slice(1, 2).join(''))
  check('D9 空账本不凭空报数', !/\d+ 轮 \/ \d+ 条/.test(dreamEmpty), '')

  const dreamDb = Meow.getDb(workspace, '.dsh-meow')
  dreamDb.logDream(
    'window dream done: sess-probe-97 groups=2 stamped=true plan rows=2 dup=0 cover=1 missing=1 T=2026-11-20T00:00:00.000Z',
    { stamped: true, groups: 2, plan: { rounds: 2, groups: 2, rows: 2, dup: 0, cover: 1, missing: 1, projects: ['探针项目'] } },
  )
  dreamDb.logDream('window dream aborted: sess-probe-96 groups=1 stamped=false T=2026-11-19T00:00:00.000Z', { stamped: false, groups: 1 })
  // [macro-fusion 0.2.107] 一条真正的老账（0.2.96 之前，没有 plan 也没有 kind）：只有它才该念「比 0.2.96 早」，
  // 而上面那条 aborted 是 0.2.96 之后的账，念成「更早的账」是误报。run_at 压在 aborted 之后，别打乱 D13 的「只列一条」。
  dreamDb.db
    .prepare('INSERT INTO dream_log (run_at, summary, changes, note) VALUES (?, ?, ?, ?)')
    .run(
      Date.now() - 5000,
      'window dream done: sess-probe-95 groups=1 stamped=true T=2026-11-18T00:00:00.000Z',
      JSON.stringify({ stamped: true, groups: 1 }),
      '',
    )

  const dreamPanel = text(await run('memory_admin', { action: 'dream' }))
  check(
    'D10 面板照账念出规模',
    dreamPanel.includes('2 轮 / 2 条') && dreamPanel.includes('重复详写 1 对') && dreamPanel.includes('缺 1 个词'),
    dreamPanel.split('\n').slice(1, 2).join(''),
  )
  check('D11 老记录不冒充有规模', dreamPanel.includes('1 组 · 这条记录比 0.2.96 早，当时还没写规模数字'), '')
  check(
    'D11b 中途放弃的账不冒充老账：说「半路停下，这一条没记走到第几组」，不再念「比 0.2.96 早」',
    dreamPanel.includes('半路停下，这一条没记走到第几组'),
    '',
  )
  check('D12 两种收尾都点出来路', dreamPanel.includes('整理完成') && dreamPanel.includes('中途放弃'), '')
  const dreamOne = text(await run('memory_admin', { action: 'dream', limit: 1 }))
  check('D13 limit 真的只列一条', dreamOne.includes('列最近 1 次整理记录') && !dreamOne.includes('2 轮 / 2 条'), dreamOne.split('\n').slice(0, 3).join(' | '))
  const dreamNoWs = text(await tools.get('memory_admin').execute({ action: 'dream' }, {}))
  check('D14 没有会话工作区时说清没有账本', dreamNoWs.includes('没有工作区'), dreamNoWs.split('\n').slice(1, 2).join(''))

  // ── SS. 取代关系（0.2.117）：写新的同时把旧的降格，不删 ─────────────────────
  // 主人在这一版定的口径：记忆插件不需要「遗忘」，需要的是对过期/错误的**矫正**。
  // 这一串会真写十几条记忆，所以给它自己的临时工作区——写进共用库会污染后面那些
  // 「零命中」「库里只有一条可比较」的断言（0.2.117 第一版就是这么把 AC2 / AH4 / AH5 / AM7 弄红的）。
  const ssWs = mkdtempSync(join(tmpdir(), 'macro-probe-supersede-'))
  // 信任门（#64）：新工作区必须在**第一次写之前**先建一次库——meow 建库时会把「空目录」记进信任
  // 名单（registerCreatedWorkspace），没有会话钩子的探针得手动等价这一步（主工作区在 164 行也是这么做的）。
  // 反过来，先写再建库会被当成「外部记忆库」拒掉，所以这一行必须留在第一个 ssRun 之前。
  const ssDb = Meow.getDb(ssWs, '.dsh-meow')
  const ssExec = { agent: { session: { header: { cwd: ssWs, id: 'sess-ss' } } } }
  const ssRun = (name, args) => tools.get(name).execute(args, ssExec)
  const ssIdOf = (like) => String(ssDb.db.prepare('SELECT id FROM fact WHERE content LIKE ?').get(like)?.id ?? '')
  const ssA = { project: '取代探针', keywords: ['取代', 'supersede', '旧条目', '矫正', '不删除', 'stale', '探针', '口径', '发布节奏'], importance: 2, level: 'fact' }
  const ssB = { project: '取代探针', keywords: ['取代', 'supersede', '新条目', '接管', '版本', '探针', '口径', '发布节奏', '变更'], importance: 2, level: 'fact' }

  const ssOld = text(await ssRun('memory_remember', { ...ssA, content: '取代探针甲：旧规则是每周一固定发布。' }))
  check('SS1 旧条目先写进去（没被合并）', !ssOld.includes('已合并'), ssOld.split('\n')[0])
  const ssOldId = ssIdOf('%取代探针甲%')
  check('SS1 拿到旧条目 id', ssOldId.length >= 8, ssOldId)

  const ssNew = text(await ssRun('memory_remember', { ...ssB, content: '取代探针甲：改成分支合并即发布，周一这条取消。', supersedes: [ssOldId] }))
  check('SS2 回执报出取代段', ssNew.includes('取代（新写的') && ssNew.includes('已标 stale'), ssNew.split('\n').slice(-1)[0])
  check('SS2 回执点明不删、可反悔', ssNew.includes('旧条目一条都没删') && ssNew.includes('反悔办法'), '')

  const ssOldRead = text(await ssRun('memory_read', { id: ssOldId, neighbors: 0 }))
  check('SS3 旧条目正文留下取代句', ssOldRead.includes('（已被取代：') && ssOldRead.includes('每周一'), ssOldRead.split('\n')[0])
  check('SS3 旧条目状态变 stale', ssOldRead.includes('（stale）'), ssOldRead.split('\n')[0])
  check('SS4 旧条目没被删，正文还在', ssOldRead.includes('每周一固定发布'), '')

  const ssAgain = text(await ssRun('memory_remember', { ...ssB, content: '取代探针甲：第三次改口径，还是指向同一条旧的。', supersedes: [ssOldId] }))
  check('SS5 重复取代不重复追加', ssAgain.includes('已经有一句「已被取代」，没重复追加'), ssAgain.split('\n').find((l) => l.includes('没重复追加')) ?? '')
  const ssOldRead2 = text(await ssRun('memory_read', { id: ssOldId, neighbors: 0 }))
  const ssMarks = (ssOldRead2.match(/（已被取代：/g) ?? []).length
  check('SS5 正文里取代句只有一句', ssMarks === 1, String(ssMarks))

  const ssMiss = text(await ssRun('memory_remember', { ...ssB, content: '取代探针乙：指向一个查不到的旧 id。', supersedes: ['ffff0000'] }))
  check('SS6 找不到的旧 id 说清没改', ssMiss.includes('没找到（可能已归档或删除）——它没有被改'), '')
  check('SS6 新条目照样写成', ssIdOf('%取代探针乙%').length >= 8, '')

  await ssRun('memory_remember', { ...ssA, content: '取代探针丙：这条等一下会被作废。' })
  const ssArcId = ssIdOf('%取代探针丙%')
  await ssRun('memory_update', { id: ssArcId, status: 'archived' })
  const ssArc = text(await ssRun('memory_remember', { ...ssB, content: '取代探针丁：指向一条已经作废的。', supersedes: [ssArcId] }))
  check('SS7 已作废的不动', ssArc.includes('已经是 archived（作废），没动它'), ssArc.split('\n').find((l) => l.includes('archived')) ?? '')

  await ssRun('memory_remember', { ...ssA, content: '取代探针戊：这条先标 stale 再被接管。' })
  const ssStaleId = ssIdOf('%取代探针戊%')
  await ssRun('memory_update', { id: ssStaleId, status: 'stale' })
  const ssStale = text(await ssRun('memory_remember', { ...ssB, content: '取代探针己：接管一条本来就 stale 的。', supersedes: [ssStaleId] }))
  check('SS8 本来就 stale 的只补一句', ssStale.includes('本来就是 stale，只补了一句'), ssStale.split('\n').find((l) => l.includes('本来就 stale')) ?? '')

  const ssEmpty = text(await ssRun('memory_remember', { ...ssB, content: '取代探针庚：supersedes 给的全是空白。', supersedes: ['   '] }))
  check('SS9 归一后为空就不起取代段', !ssEmpty.includes('取代（新写的'), ssEmpty.split('\n')[0])

  const ssOver = text(
    await ssRun('memory_remember', {
      ...ssB,
      content: '取代探针辛：一次给八条，看它报不报没处理的那几条。',
      supersedes: ['aaaa0001', 'aaaa0002', 'aaaa0003', 'aaaa0004', 'aaaa0005', 'aaaa0006', 'aaaa0007', 'aaaa0008'],
    }),
  )
  check('SS10 超出上限就报出没处理的那几条', ssOver.includes('超出 5 条上限的 3 条这次没有处理'), ssOver.split('\n').find((l) => l.includes('超出')) ?? '')
  check('SS10 上限内那五条各有一句交代', (ssOver.match(/没找到（可能已归档或删除）/g) ?? []).length === 5, String((ssOver.match(/没找到（可能已归档或删除）/g) ?? []).length))

  // SS11：短 id 给得太短（这里给 '0m'——库里的 id 全都以它开头）时，只能报歧义，不能替我挑一条。
  const ssWide = text(await ssRun('memory_remember', { ...ssB, content: '取代探针壬：短 id 给得太短，命中不止一条。', supersedes: ['0m'] }))
  check('SS11 短 id 命中多条时不挑，只报条数', /短 id 命中 \d+ 条，没替你挑一条——换成完整 id 再来一次/.test(ssWide), ssWide.split('\n').find((l) => l.includes('短 id 命中')) ?? '')
  check('SS11 报的条数不是 0（candidates 是给人看的字符串，条数得从里面数出来）', !/短 id 命中 0 条/.test(ssWide), '')

  // SS12：自己取代自己——同一条内容再写一次会合回原条目，这时 supersedes 指的正是刚拿到的新 id。
  await ssRun('memory_remember', { ...ssA, content: '取代探针癸：这条会被写两遍。' })
  const ssSelfId = ssIdOf('%取代探针癸%')
  const ssSelf = text(await ssRun('memory_remember', { ...ssA, content: '取代探针癸：这条会被写两遍。', supersedes: [ssSelfId] }))
  check('SS12 一条记忆不能取代自己', ssSelf.includes('就是这次刚写的那一条，跳过了（一条记忆不能取代自己）'), ssSelf.split('\n').find((l) => l.includes('不能取代自己')) ?? '')

  // [macro-fusion 0.2.98] 趋势行：五条带 plan 的账（重复详写 3→2→2→1→1，缺词 2→1→1→0→0），
  // 面板要给合计并说「在变少」；只有一条时一行都不许出（一条没有走势）。
  const trendWs = mkdtempSync(join(tmpdir(), 'macro-probe-trend-'))
  const trendDb = Meow.getDb(trendWs, '.dsh-meow')
  const P = (dup, cover, missing) => ({ rounds: 2, groups: 2, rows: 2, dup, cover, missing, projects: ['p'] })
  for (const [dup, cover, missing] of [
    [1, 3, 2],
    [1, 2, 1],
    [0, 2, 1],
    [0, 1, 0],
    [0, 1, 0],
  ]) {
    trendDb.logDream('window dream done: sess-trend groups=2 stamped=true', { stamped: true, groups: 2, plan: P(dup, cover, missing) })
  }
  const trendPanel = text(await tools.get('memory_admin').execute({ action: 'dream', limit: 5 }, { agent: { session: { header: { cwd: trendWs } } } }))
  check(
    'D15 趋势行给合计并报走向',
    trendPanel.includes('趋势：最近 5 次') &&
      trendPanel.includes('重复详写 合计 9 对，在变少') &&
      trendPanel.includes('缺词 合计 4 个，在变少'),
    trendPanel.split('\n').slice(-1)[0],
  )
  check('D15 每条账带序号且最新是 #1', trendPanel.includes('#1 ') && trendPanel.includes('#5 ') && !trendPanel.includes('#6 '), '')
  check('D15 账本行说清落库了没有', trendPanel.includes('落库 是'), '')
  check('D15 趋势行不混进账本行', !/^趋势：/.test(trendPanel.split('\n').slice(0, 5).join('\n')), '')

  const trendOnePanel = text(await tools.get('memory_admin').execute({ action: 'dream', limit: 1 }, { agent: { session: { header: { cwd: trendWs } } } }))
  check('D16 只有一条账时不编走势', !trendOnePanel.includes('趋势：'), trendOnePanel)

  const trendOldWs = mkdtempSync(join(tmpdir(), 'macro-probe-trendold-'))
  const trendOldDb = Meow.getDb(trendOldWs, '.dsh-meow')
  trendOldDb.logDream('window dream done: sess-old groups=1 stamped=true', { stamped: true, groups: 1 })
  for (const cover of [2, 1, 1]) {
    trendOldDb.logDream('window dream done: sess-new groups=1 stamped=true', { stamped: true, groups: 1, plan: { rounds: 2, groups: 1, rows: 2, dup: 0, cover, missing: 0, projects: ['p'] } })
  }
  const trendOldPanel = text(await tools.get('memory_admin').execute({ action: 'dream', limit: 5 }, { agent: { session: { header: { cwd: trendOldWs } } } }))
  check('D17 老记录不进趋势，但说清跳过几条', trendOldPanel.includes('1 条记录早于 0.2.96') && trendOldPanel.includes('重复详写 合计 4 对'), trendOldPanel.split('\n').slice(-1)[0])
  check('D17 样本不足时明说别当走势', trendOldPanel.includes('样本太少'), '')
  // [macro-fusion 0.2.99] 正在整理的那一轮：面板第一行念活 lease + dreamdigest，
  // 但绝不把它混成账本里的一行；lease 放掉之后立刻不再念。
  const liveWs = mkdtempSync(join(tmpdir(), 'macro-probe-live-'))
  const liveDb = Meow.getDb(liveWs, '.dsh-meow')
  liveDb.logDream('window dream done: sess-live-old groups=1 stamped=true', { stamped: true, groups: 1, plan: { rounds: 2, groups: 1, rows: 2, dup: 0, cover: 0, missing: 0, projects: ['p'] } })
  liveDb.setDreamMeta('dreamdigest:sess-live', JSON.stringify({ rounds: 4, groups: 4, rows: 6, dup: 1, cover: 3, missing: 2, projects: ['p', 'q'] }))
  liveDb.claimDream('sess-live', `owner-probe-${process.pid}`, Date.now(), 120000)
  const livePanel = text(await tools.get('memory_admin').execute({ action: 'dream', limit: 5 }, { agent: { session: { header: { cwd: liveWs } } } }))
  check(
    'D18 整理中：第一行念这一轮的规模（来自 dreamdigest，不是账本）',
    livePanel.includes('整理进行中：4 轮 / 6 条 · 逐字重复 1 对 · 重复详写 3 对 · 缺 2 个词 · 2 个项目段') &&
      livePanel.indexOf('整理进行中') < livePanel.indexOf('#1 '),
    livePanel.split('\n').find((l) => l.includes('整理进行中')) ?? livePanel.split('\n')[0],
  )
  check(
    'D18 整理中：不给这轮编序号，账本行仍从 #1 起',
    /整理进行中/.test(livePanel) && !/^#1 .*整理进行中/.test(livePanel) && livePanel.includes('#1 '),
    '',
  )
  liveDb.releaseDream('sess-live')
  const liveGone = text(await tools.get('memory_admin').execute({ action: 'dream', limit: 5 }, { agent: { session: { header: { cwd: liveWs } } } }))
  check(
    'D19 lease 放掉后第一行消失（不把收尾的那轮一直挂着）',
    !liveGone.includes('整理进行中') && liveGone.includes('#1 '),
    liveGone.split('\n')[0],
  )
  liveDb.claimDream('sess-live', `owner-probe2-${process.pid}`, Date.now(), 120000)
  liveDb.delDreamMeta('dreamdigest:sess-live')
  const liveNoPlan = text(await tools.get('memory_admin').execute({ action: 'dream', limit: 5 }, { agent: { session: { header: { cwd: liveWs } } } }))
  check(
    'D19 只有 lease 没有 digest：说「规模还没落 meta」，不编数字',
    liveNoPlan.includes('规模还没落 meta') && !/整理进行中：\d+ 轮/.test(liveNoPlan),
    liveNoPlan.split('\n')[0],
  )


  // [macro-fusion 0.2.100] 页与条：账本长了要能翻，某一条要看原文。
  // 三条口径在这里钉死：编号「第几近」跨页连续、总数不是「这一页几条」、展开只念原文不重算。
  const pageWs = mkdtempSync(join(tmpdir(), 'macro-probe-page-'))
  const pageDb = Meow.getDb(pageWs, '.dsh-meow')
  for (let i = 1; i <= 7; i += 1) {
    pageDb.logDream(`window dream done: sess-p${i} 第${i}次 stamped=true`, {
      stamped: true,
      plan: { rounds: 1, groups: 1, rows: i, dup: i % 3, cover: i % 2, missing: i % 2, projects: ['翻页项目'] },
    }, i === 2 ? '第 2 次那次写了备注' : '')
  }
  const pageCtx = { agent: { session: { header: { cwd: pageWs } } } }
  const p1 = text(await tools.get('memory_admin').execute({ action: 'dream', limit: 3, page: 1 }, pageCtx))
  check(
    'D20 第一页：列出 3 条、编号从 #1 起、并报出账本共 7 条（总数不是本页条数）',
    p1.includes('#1 ') && p1.includes('#3 ') && !p1.includes('#4 ') && p1.includes('共 7 条'),
    p1.split('\n').slice(0, 2).join(' | '),
  )
  check('D20 第一页给前进入口，不给「上一页」', p1.includes('下一页 page=2') && !p1.includes('上一页'), p1.split('\n').slice(-1)[0])
  const p2 = text(await tools.get('memory_admin').execute({ action: 'dream', limit: 3, page: 2 }, pageCtx))
  check(
    'D21 第二页：编号接上（#4–#6，不重不漏），且这一页不再出趋势行',
    p2.includes('#4 ') && p2.includes('#5 ') && p2.includes('#6 ') && !p2.includes('#1 ') && !p2.includes('趋势：'),
    p2.split('\n').slice(0, 2).join(' | '),
  )
  check('D21 第二页：上一页/下一页都给，页码口径写在抬头里', p2.includes('上一页 page=1') && p2.includes('下一页 page=3') && p2.includes('第 2 页'), '')
  const p99 = text(await tools.get('memory_admin').execute({ action: 'dream', limit: 3, page: 99 }, pageCtx))
  check(
    'D22 页码越过最后一页：退到最后一页并说清（不返回空白页）',
    p99.includes('#7 ') && p99.includes('早过最后一页') && !p99.includes('#8 '),
    p99.split('\n').slice(-1)[0],
  )
  const one = text(await tools.get('memory_admin').execute({ action: 'dream', limit: 5, id: '#2' }, pageCtx))
  check(
    'D23 展开第 2 近：摊开摘要与 changes 原文，并给出与更早一条的差（比的是 #3）',
    one.includes('#2 ') && one.includes('第6次') && one.includes('变化原文') && one.includes('比更早一条（#3）'),
    one.split('\n').slice(1, 2).join(''),
  )
  const withNote = text(await tools.get('memory_admin').execute({ action: 'dream', limit: 5, id: '6' }, pageCtx))
  check(
    'D23 备注原样念出来（有就念，没有就不编）',
    withNote.includes('第 2 次那次写了备注') && withNote.includes('#6 '),
    withNote.split('\n').find((l) => l.includes('备注')) ?? '',
  )
  check('D23 展开也是「只念账本」：明说数字来自 changes.plan', one.includes('全部来自 changes.plan'), '')
  const oldOne = text(await tools.get('memory_admin').execute({ action: 'dream', limit: 5, id: '4' }, { agent: { session: { header: { cwd: trendOldWs } } } }))
  check(
    'D24 展开一条老记录：明说它写在 0.2.96 之前（不给它编规模）',
    oldOne.includes('没有 changes.plan') && oldOne.includes('0.2.96 之前'),
    oldOne.split('\n').slice(1, 2).join(''),
  )
  const missingOne = text(await tools.get('memory_admin').execute({ action: 'dream', limit: 5, id: '99' }, pageCtx))
  check(
    'D24 要一条不存在的：说清「没有第 99 条」并报总数（不是「账本读不出来」）',
    missingOne.includes('没有第 99 条') && missingOne.includes('一共 7 条'),
    missingOne.split('\n')[0],
  )
  let dirtyId = ''
  try {
    await tools.get('memory_admin').execute({ action: 'dream', id: 'abc' }, pageCtx)
  } catch (e) {
    dirtyId = String(e.message)
  }
  check(
    'D25 id 给脏了当面打回（不静默退回整本账）',
    dirtyId.includes('只认两种写法') && dirtyId.includes('r128') && dirtyId.includes('这次没有展开任何一条'),
    dirtyId.split('\n')[0],
  )
  let dirtyPage = ''
  try {
    await tools.get('memory_admin').execute({ action: 'dream', page: 0 }, pageCtx)
  } catch (e) {
    dirtyPage = String(e.message)
  }
  check('D25 page 给脏了也打回（0 不悄悄当第一页）', dirtyPage.includes('从 1 起的整数') && dirtyPage.includes('这次没有列账'), dirtyPage.split('\n')[0])

  // [macro-fusion 0.2.101] 按项目段翻账：项目名一直在 changes.plan.projects 里，以前只念了个数。
  // 三条口径：筛在 SQL 里做（页面与总数同一个筛子）、计数与筛选都不改老口径、筛空了不等于账本空。
  const projWs = mkdtempSync(join(tmpdir(), 'macro-probe-proj-'))
  const projDb = Meow.getDb(projWs, '.dsh-meow')
  const logProj = (rows, projects, note = '') =>
    projDb.logDream(`window dream done: sess-${rows} 第${rows}次 stamped=true`, {
      stamped: true,
      plan: { rounds: 1, groups: 1, rows, dup: 0, cover: 0, missing: 0, projects },
    }, note)
  logProj(1, ['Alpha', 'Beta'])
  logProj(2, ['Alpha'])
  logProj(3, ['其他'])
  projDb.logDream('window dream done: sess-old stamped=true', { stamped: true, groups: 1 }, '老记录')
  logProj(5, ['Alpha'])
  const projCtx = { agent: { session: { header: { cwd: projWs } } } }
  const projAll = text(await tools.get('memory_admin').execute({ action: 'dream', limit: 5 }, projCtx))
  check(
    'D26 第 1 页给项目分布：Alpha 3 次 · Beta 1 次（老记录与空数组不进分布）',
    projAll.includes('项目段：Alpha 3 次 · Beta 1 次 · 其他 1 次') && !projAll.includes('项目段：Alpha 3 次 · Beta 1 次 · 其他 1 次 ·'),
    projAll.split('\n').find((l) => l.startsWith('项目段：')) ?? projAll.split('\n')[0],
  )
  const projAlpha = text(await tools.get('memory_admin').execute({ action: 'dream', limit: 5, project: 'Alpha' }, projCtx))
  check(
    'D27 project=Alpha：只列 Alpha 那 3 条，并报出全账本几条（筛后的数与全账本的数都在）',
    projAlpha.includes('#1 ') && projAlpha.includes('#3 ') && !projAlpha.includes('#4 ') &&
      projAlpha.includes('按项目段「Alpha」筛：3 条（全账本 5 条）'),
    projAlpha.split('\n')[0],
  )
  check(
    'D27 筛着的时候不再给项目分布（筛完再报分布会被当成「分布也筛过了」）',
    !projAlpha.includes('项目段：Alpha 3 次'),
    '',
  )
  const projNone = text(await tools.get('memory_admin').execute({ action: 'dream', limit: 5, project: 'Gamma' }, projCtx))
  check(
    'D28 筛一个不存在的项目：说清「没有这个项目段」并报全账本条数（不是「账本还是空的」）',
    projNone.includes('没有项目段「Gamma」') && projNone.includes('全账本 5 条') && !projNone.includes('账本还是空的'),
    projNone.split('\n')[0],
  )
  const projNot = text(await tools.get('memory_admin').execute({ action: 'dream', id: '2', project: 'Alpha' }, projCtx))
  const projYes = text(await tools.get('memory_admin').execute({ action: 'dream', id: '5', project: 'Alpha' }, projCtx))
  check(
    'D29 展开时项目对不上要说清（照账念，但别当成筛选结果）',
    projNot.includes('不属于项目段「Alpha」') && projYes.includes('属于项目段「Alpha」'),
    projNot.split('\n').filter((l) => l.includes('项目段「Alpha」')).join(' | '),
  )
  check(
    'D29 展开的编号仍是全账本第几近（筛选不改编号，口径写在 note 里）',
    projNot.includes('#2 ') && projNot.includes('筛选不改编号'),
    projNot.split('\n')[0],
  )
  let dirtyProj = ''
  try {
    await tools.get('memory_admin').execute({ action: 'dream', project: 'x'.repeat(90) }, projCtx)
  } catch (e) {
    dirtyProj = String(e.message)
  }
  check(
    'D30 project 给成长句当面打回（不把它当「没匹配到」）',
    dirtyProj.includes('只认一个项目段的名字') && dirtyProj.includes('这次没有筛任何账'),
    dirtyProj.split('\n')[0],
  )
  const projPage2 = text(await tools.get('memory_admin').execute({ action: 'dream', limit: 2, page: 2, project: 'Alpha' }, projCtx))
  check(
    'D31 筛 + 翻页：编号接着筛出来的顺序（第 2 页给 #3），导航写明是「项目段」的条数',
    projPage2.includes('#3 ') && projPage2.includes('共 3 条（项目段「Alpha」）'),
    projPage2.split('\n').slice(-1)[0],
  )

  // [macro-fusion 0.2.102] 落库的摘要要能回放「跟谁撞了」，并且项目段得真的存成名字。
  // 这里一律用真 writer（Meow.dreamPlanDigest）造账，不再手写 changes——0.2.101 就是手写数组把问题盖住了。
  const digWs = mkdtempSync(join(tmpdir(), 'macro-probe-digest-'))
  const digDb = Meow.getDb(digWs, '.dsh-meow')
  // [macro-fusion 0.2.103] 库规模也得从真库里数：先落两条记忆，再让 dreamStoreScale 去数，
  // 跟 startWindowDream 里「digest 算完再挂 store」是同一种拼法（不是手写 {active:2}）。
  digDb.insert({ level: 'fact', content: '探针库里的第一条事实', keywords: ['probe', 'scale'] })
  digDb.insert({ level: 'lesson', content: '探针库里的第一条教训', keywords: ['probe', 'scale'] })
  const mkRow = (id, level, content) => ({ id, level, content })
  const dupOne = '默认用 pnpm 装依赖 不要混用 npm 和 yarn 锁文件只提交一个'
  const dupTwo = '默认用 pnpm 装依赖 不要混用 npm 和 yarn 锁文件只提交一个副本'
  const digRounds = [
    {
      kind: 'atomic',
      groups: [{ name: '', rows: [mkRow('eeee0001aa', 'fact', dupOne), mkRow('eeee0002aa', 'fact', dupTwo)] }],
      projects: ['Alpha', 'Beta'],
    },
    {
      kind: 'topic',
      groups: [{
        name: 't',
        rows: [
          mkRow('eeee0003aa', 'topic', '探针里不要用 ^ 锚定面板首行 因为首行是抬头'),
          mkRow('eeee0004aa', 'fact', '探针里不要用 ^ 锚定面板首行 因为首行是抬头 否则断言必然打红'),
        ],
      }],
      projects: [],
    },
  ]
  // 最早的一条就带库规模（开工时 2 条），后一条带 3 条——趋势行要能念出「2 → 3」。写在最前面，
  // 这样它排到队尾，#1~#4 的既有编号一个都不动。
  digDb.logDream('window dream done: sess-digest-old stamped=true', { stamped: true, groups: 2, plan: { ...Meow.dreamPlanDigest(digRounds), store: Meow.dreamStoreScale(digDb) } }, '更早的一次')
  digDb.insert({ level: 'topic', content: '探针库里的第一条主题', keywords: ['probe', 'scale'] })
  const digPlan = { ...Meow.dreamPlanDigest(digRounds), store: Meow.dreamStoreScale(digDb) }
  digDb.logDream('window dream done: sess-noplan stamped=true', { stamped: true, groups: 1 }, '极老记录')
  digDb.logDream('window dream done: sess-legacy stamped=true', { stamped: true, groups: 1, plan: { rounds: 1, groups: 1, rows: 3, dup: 0, cover: 0, missing: 0, projects: 2 } }, '老格式')
  digDb.logDream('window dream done: sess-digest stamped=true', { stamped: true, groups: 2, plan: digPlan }, '新格式')
  // 对子存不下的时候：7 条几乎一样的行 = 21 对，账里只存前 6 对，面板必须把差额说出来。
  const manyRows = Array.from({ length: 7 }, (_, i) => mkRow(`ffff000${i}aa`, 'fact', `${dupOne} 第${i}份`))
  const manyPlan = Meow.dreamPlanDigest([{ kind: 'atomic', groups: [{ name: '', rows: manyRows }], projects: ['Alpha'] }])
  digDb.logDream('window dream done: sess-many stamped=true', { stamped: true, groups: 1, plan: manyPlan }, '对子超上限')
  const digCtx = { agent: { session: { header: { cwd: digWs } } } }
  // 账本是「最新在前」：四条按写入顺序是 noplan / legacy / digest / many，所以 #1=many、#2=digest、#3=legacy、#4=noplan。
  const digOne = text(await tools.get('memory_admin').execute({ action: 'dream', id: '2' }, digCtx))
  check(
    'D32 展开一条新账：对子摊成清单，短 id 与层级都在（能直接拿去 memory_read）',
    digOne.includes('对子（账里存了 2 对，这一轮共 2 对）') && digOne.includes('逐字重复：') &&
      digOne.includes('重复详写：') && digOne.includes('⇄') && digOne.includes('⊂') &&
      digOne.includes('短 id 和整理清单里印的是同一套'),
    digOne.split('\n').filter((l) => l.startsWith('- ') || l.startsWith('对子')).join(' | '),
  )
  check(
    'D32 展开时项目段念的是名字（不是个数）',
    digOne.includes('项目段：Alpha、Beta'),
    digOne.split('\n').find((l) => l.startsWith('项目段：')) ?? '',
  )
  const digTwo = text(await tools.get('memory_admin').execute({ action: 'dream', id: '3' }, digCtx))
  check(
    'D33 老格式的账：个数照念（2 个），并说清名字没存过（不念成「0 个项目段」）',
    digTwo.includes('只记了个数（2 个）') && !digTwo.includes('0 个项目段'),
    digTwo.split('\n').find((l) => l.startsWith('项目段：')) ?? '',
  )
  check(
    'D33 没有对子明细就说没有，不冒充「这一轮没撞上对子」',
    digTwo.includes('没有存对子明细') && !digTwo.includes('这一轮没撞上对子'),
    digTwo.split('\n').find((l) => l.includes('对子')) ?? '',
  )
  const digThree = text(await tools.get('memory_admin').execute({ action: 'dream', id: '4' }, digCtx))
  check(
    'D34 连 plan 都没有的账：直说 0.2.96 之前没记规模，对子无从谈起',
    digThree.includes('没有 changes.plan（它写在 0.2.96 之前），谈不上对子'),
    digThree.split('\n').find((l) => l.includes('对子')) ?? '',
  )
  const digMany = text(await tools.get('memory_admin').execute({ action: 'dream', id: '1' }, digCtx))
  check(
    'D35 对子超出落库上限：报「还有 N 对没落账」，数仍然是真的（21 对）',
    digMany.includes('这一轮共 21 对') && digMany.includes('还有 15 对没落账'),
    digMany.split('\n').find((l) => l.startsWith('对子')) ?? '',
  )
  const digFiltered = text(await tools.get('memory_admin').execute({ action: 'dream', project: 'Alpha', limit: 5 }, digCtx))
  check(
    'D36 从写侧到面板一路通：真摘要落库后按项目名筛得到（0.2.101 漏的就是这一环）',
    digFiltered.includes('按项目段「Alpha」筛：3 条（全账本 5 条）') && digFiltered.includes('#1 ') && !digFiltered.includes('#4 '),
    digFiltered.split('\n')[0],
  )
  check(
    'D36 老账本里的数字不会被当成项目名（分布里没有「2 次的那个 2」）',
    !digFiltered.includes('项目段：Alpha 2 次 · 2 ') && !digFiltered.includes('· 2 0 次'),
    '',
  )
  // [macro-fusion 0.2.103] 库规模：账本要能回答「这一轮开工时库有多大」，因为「翻 20 条」在 800 条的
  // 库和 40 条的库里不是一个意思。写侧真数、面板真念，老账不补 0，没 plan 的账不重复解释。
  const digScaleLine = digOne.split('\n').find((l) => l.startsWith('库规模：')) ?? ''
  check(
    'D37 展开新账念库规模：开工时真条数 + 分层明细（与 dreamStoreScale 数出来的同一份）',
    digScaleLine === `库规模：开工时 ${digPlan.store.active} 条在用（fact 1 · lesson 1 · topic 1）` && digPlan.store.active === 3,
    digScaleLine,
  )
  check(
    'D37 库规模排在项目段与对子之后、变化原文之前（先讲这一轮，再讲库，最后摊原文）',
    digOne.indexOf('库规模：') > digOne.indexOf('对子') &&
      digOne.indexOf('库规模：') > digOne.indexOf('项目段：') &&
      (digOne.indexOf('变化原文') === -1 || digOne.indexOf('库规模：') < digOne.indexOf('变化原文')),
    `对子@${digOne.indexOf('对子')} 项目段@${digOne.indexOf('项目段：')} 库@${digOne.indexOf('库规模：')}`,
  )
  const digOldStore = digTwo.split('\n').find((l) => l.startsWith('库规模：')) ?? ''
  check(
    'D38 老账（没有 store 这一格）明说没记，且不许念成 0 条',
    digOldStore.includes('没有记库规模（它写在 0.2.103 之前）') && !digOldStore.includes('0 条在用'),
    digOldStore,
  )
  check(
    'D38 连 plan 都没有的账不再多念一句库规模（0.2.96 那句已经解释过了，别叠两层老账告示）',
    !digThree.includes('库规模'),
    digThree.split('\n').find((l) => l.startsWith('库规模')) ?? '（没有这一行）',
  )
  const digTrend = digFiltered.split('\n').find((l) => l.startsWith('趋势：')) ?? ''
  check(
    'D39 趋势行带上库规模区间（最早→最新），并说清只有几次有数',
    digTrend.includes('库 开工时 2 → 3 条（多了 1 条）') && digTrend.includes('库规模只有 2 次有数'),
    digTrend,
  )

  // [macro-fusion 0.2.104] 账本行的稳定引用：列表每行末尾印 r<N>，回指用它；「第几近」照旧按位置算。
  // 这一段的关键动作是「先拿到引用，再让账本往前走一格」，验证引用没挪、编号挪了。
  const digListed = Meow.readDreamLedger(digWs, '.dsh-meow', 10, 0)
  const digDigestId = digListed.rows[1].id
  const digRef = `r${digDigestId}`
  const digPanelList = text(await tools.get('memory_admin').execute({ action: 'dream', limit: 5 }, digCtx))
  check(
    'D40 列表每行都带账本引用 r<N>（引用是行自己的号，不是位置），并说一次「回指就用它」',
    digPanelList.includes(`· 引用 r${digListed.rows[0].id}`) &&
      digPanelList.includes(`· 引用 ${digRef}`) &&
      digPanelList.includes('引用：每行末尾的 r<N> 是这一行的固定号'),
    digPanelList.split('\n').filter((l) => l.startsWith('#')).slice(0, 2).join(' | '),
  )
  const digPanelPage2 = text(await tools.get('memory_admin').execute({ action: 'dream', limit: 2, page: 2 }, digCtx))
  check(
    'D40 引用提示只在第 1 页说一次（每页都印等于拿 token 换噪音），但行上的 r<N> 每页都在',
    !digPanelPage2.includes('引用：每行末尾的 r<N> 是这一行的固定号') && digPanelPage2.includes('· 引用 r'),
    digPanelPage2.split('\n')[0],
  )
  // 又跑一轮：全新的一条排到最前面，digest 那一条从 #2 挪到 #3——引用还必须是同一个号。
  digDb.logDream('window dream done: sess-after-ref stamped=true', { stamped: true, groups: 2, plan: digPlan }, '后来的一轮')
  // 面板返回的是「【抬头】口径\n正文」一整串：按行断言得先剥抬头，别拿整串 startsWith。
  const digRefRes = await tools.get('memory_admin').execute({ action: 'dream', id: digRef }, digCtx)
  const digRefText = String(digRefRes?.body ?? digRefRes)
  const digRefLines = digRefText.split('\n')
  const digRefBody = digRefLines.slice(1).join('\n')
  const digRefNote = digRefLines[0].replace(/^【[^】]*】/, '')
  check(
    'D41 又跑了一轮之后按引用展开：还指着同一条账（备注仍是「新格式」），只是它现在排第 3 近',
    digRefBody.includes('备注：新格式') &&
      digRefBody.includes(`引用 ${digRef}`) &&
      digRefBody.includes('它现在排第 3 近') &&
      digRefBody.startsWith('#3 '),
    digRefBody.split('\n')[0],
  )
  check(
    'D41 按引用展开的口径写明「按引用 …（现在第 K 近）」，并交代原文照账念',
    digRefNote.includes(`按引用 ${digRef} 展开（现在第 3 近）`) && digRefNote.includes('原文照账本念'),
    digRefNote,
  )
  const digRefAlphaRes = await tools.get('memory_admin').execute({ action: 'dream', id: digRef, project: 'Alpha' }, digCtx)
  const digRefAlphaText = String(digRefAlphaRes?.body ?? digRefAlphaRes)
  const digRefAlphaLines = digRefAlphaText.split('\n')
  const digRefAlphaBody = digRefAlphaLines.slice(1).join('\n')
  const digRefAlphaNote = digRefAlphaLines[0].replace(/^【[^】]*】/, '')
  check(
    'D42 引用 + 项目段：这条属于 Alpha 就直说属于（引用照念，不拿筛选把它藏起来）',
    digRefAlphaBody.includes('这一条属于项目段「Alpha」') &&
      digRefAlphaBody.includes(`引用 ${digRef}`) &&
      digRefAlphaNote.includes('引用不受项目筛选影响'),
    digRefAlphaBody.split('\n').filter((l) => l.includes('项目段「Alpha」')).join(' | '),
  )
  const digRefGone = text(await tools.get('memory_admin').execute({ action: 'dream', id: `r${digDigestId + 900}` }, digCtx))
  check(
    'D42 引用不存在：明说这个号不会发给新账（不是「账本是空的」），并给出按位置/按内容两条替代路',
    digRefGone.includes(`账本里没有引用 r${digDigestId + 900} 的那一条（一共 6 条）`) &&
      digRefGone.includes('翻 page 看 #k') &&
      digRefGone.includes('用摘要里的字眼去搜'),
    digRefGone.split('\n')[0],
  )

  // D43–D45（0.2.105）：按日期筛账。账本里现有的 6 条都是「现在」写的，
  // 要量「按天筛」就得塞两条旧账——直接插 run_at，logDream 只会写现在。
  const digDayKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  const digNowDay = new Date()
  const digDaysAgo = (n) => {
    const d = new Date(digNowDay.getFullYear(), digNowDay.getMonth(), digNowDay.getDate() - n, 10, 0, 0, 0)
    return d
  }
  const digTenAgo = digDaysAgo(10)
  const digThreeAgo = digDaysAgo(3)
  const digMidGap = digDaysAgo(6)
  const digIns = digDb.db.prepare('INSERT INTO dream_log (run_at, summary, changes, note) VALUES (?, ?, ?, ?)')
  digIns.run(digTenAgo.getTime(), 'window dream done: sess-ten-ago stamped=true', JSON.stringify({ stamped: true, groups: 1, plan: digPlan }), '十天前')
  digIns.run(digThreeAgo.getTime(), 'window dream done: sess-three-ago stamped=true', JSON.stringify({ stamped: true, groups: 1, plan: digPlan }), '三天前')
  const digTodayKey = digDayKey(digNowDay)
  const digTenKey = digDayKey(digTenAgo)
  const digThreeKey = digDayKey(digThreeAgo)
  const digGapKey = digDayKey(digMidGap)
  const digSinceToday = text(await tools.get('memory_admin').execute({ action: 'dream', since: digTodayKey, limit: 10 }, digCtx))
  check(
    'D43 since=今天：只列今天的账（全账本 8 条、筛后 6 条），旧账一条都不混进来，口径里写清筛子与时区',
    digSinceToday.includes(`按时间 ${digTodayKey} → 现在 筛：6 条（全账本 8 条）`) &&
      digSinceToday.includes('UTC') &&
      !digSinceToday.includes('十天前') &&
      !digSinceToday.includes('三天前'),
    digSinceToday.split('\n')[0],
  )
  const digStampOf = (d) => `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} 10:00`
  const digOneDay = text(await tools.get('memory_admin').execute({ action: 'dream', since: digThreeKey, until: digThreeKey }, digCtx))
  check(
    'D43 同一天当 since 和 until = 这一天整天（筛出 1 条旧账，行上时间就是那天 10:00，不是 0 条也不是全账本）',
    digOneDay.includes(digStampOf(digThreeAgo)) &&
      digOneDay.includes(`按时间 ${digThreeKey} → ${digThreeKey} 筛：1 条（全账本 8 条）`) &&
      digOneDay.includes('#1 ') &&
      !digOneDay.includes('#2 '),
    digOneDay.split('\n')[0],
  )
  const digBadDay = text(await tools.get('memory_admin').execute({ action: 'dream', since: '2026-13-40' }, digCtx))
  const digReversed = text(await tools.get('memory_admin').execute({ action: 'dream', since: digTodayKey, until: digTenKey }, digCtx))
  check(
    'D44 日期写坏了就打回：不猜一个日期去筛（猜出来的结论比不筛更误导），反着写也直接说反了',
    digBadDay.includes('这种写法不敢猜') &&
      digBadDay.includes('这次没有列账') &&
      digReversed.includes('还晚') &&
      digReversed.includes('这次没有列账'),
    digBadDay.split('\n')[0],
  )
  const digUntilTen = text(await tools.get('memory_admin').execute({ action: 'dream', until: digTenKey, limit: 10 }, digCtx))
  const digGapDay = text(await tools.get('memory_admin').execute({ action: 'dream', since: digGapKey, until: digGapKey }, digCtx))
  check(
    'D45 空区间要说清「这段里没有」而不是「账本里没有」：带上账本覆盖范围与全账本条数；只给 until 时挑得出那天之前那一条',
    digUntilTen.includes(digStampOf(digTenAgo)) &&
      digUntilTen.includes(`筛：1 条（全账本 8 条）`) &&
      !digUntilTen.includes(digStampOf(digThreeAgo)) &&
      digGapDay.includes('这段时间里没有') &&
      digGapDay.includes('账本覆盖') &&
      digGapDay.includes('全账本 8 条'),
    digGapDay.split('\n')[0],
  )

  // D46–D48（0.2.106）：整理前后两个观测点。老账只有开工数，就别假装知道收尾；有收尾数时，
  // 面板要把「开工 → 收尾」连起来念，并单独一行说清「差不是因」。
  const digStorePlan = (start, end) =>
    JSON.stringify({
      stamped: 1,
      groups: 1,
      plan: {
        rows: 2,
        dup: 0,
        cover: 0,
        missing: 0,
        store: { active: start, byLevel: { fact: start } },
        storeEnd: { active: end, byLevel: { fact: end } },
        storeDelta: end - start,
      },
    })
  const digStoreIns = digDb.db.prepare('INSERT INTO dream_log (run_at, summary, changes, note) VALUES (?, ?, ?, ?)')
  digStoreIns.run(Date.now() + 1000, '收尾：两个点都记了', digStorePlan(3, 1), '两个点')
  const digStoreOne = text(await tools.get('memory_admin').execute({ action: 'dream', id: 1, limit: 10 }, digCtx))
  const digStoreLine = digStoreOne.split('\n').find((l) => l.startsWith('库规模')) ?? '(无)'
  check(
    'D46 有收尾数时念两个点：`开工时 3 条在用 → 收尾 1 条在用，比开工少 2 条`，层数夹在括号里不叠两层括号',
    digStoreLine.includes('开工时 3 条在用') &&
      digStoreLine.includes('→ 收尾 1 条在用') &&
      digStoreLine.includes('比开工少 2 条') &&
      !digStoreLine.includes('）（'),
    digStoreLine,
  )
  const digDeltaNote = digStoreOne.split('\n').find((l) => l.startsWith('规模差口径')) ?? '(无)'
  check(
    'D47 差与因分开：口径句明说 ±N 是「库变了多少」不是「这一轮改了几条」，并指出归因看 stamped',
    digDeltaNote.includes('不是「这一轮改了几条」') && digDeltaNote.includes('stamped') && digDeltaNote.includes('-2'),
    digDeltaNote,
  )
  digStoreIns.run(
    Date.now() + 2000,
    '老账：只记了开工',
    JSON.stringify({ stamped: 1, plan: { rows: 1, dup: 0, cover: 0, missing: 0, store: { active: 2, byLevel: { fact: 2 } } } }),
    '只有一个点',
  )
  const digStoreOld = text(await tools.get('memory_admin').execute({ action: 'dream', id: 1, limit: 10 }, digCtx))
  const digStoreOldLine = digStoreOld.split('\n').find((l) => l.startsWith('库规模')) ?? '(无)'
  const digStoreTrend = text(await tools.get('memory_admin').execute({ action: 'dream', limit: 10 }, digCtx))
  const digStoreTrendLine = digStoreTrend.split('\n').find((l) => l.startsWith('趋势')) ?? '(无)'
  check(
    'D48 只有开工数的老账不许编收尾（也不补 0）：只念开工一眼、没有「→ 收尾」、没有口径句；趋势里说清几次缺收尾数',
    digStoreOldLine.includes('开工时 2 条在用') &&
      !digStoreOldLine.includes('收尾') &&
      !digStoreOld.includes('规模差口径') &&
      digStoreTrendLine.includes('次有收尾数') &&
      digStoreTrendLine.includes('次只有开工数、没有收尾数'),
    `${digStoreOldLine} / ${digStoreTrendLine}`,
  )

  // D49–D53（0.2.107）：收尾方式。半路停下 / 补记 / 封存都不能再冒充「比 0.2.96 早」，
  // 趋势与「比更早一条」也只吃跑完的一轮——半轮的数字是扫到那儿的中间值。
  const kindWs = mkdtempSync(join(tmpdir(), 'macro-probe-kind-'))
  const kindDb = Meow.getDb(kindWs, '.dsh-meow')
  const kindCtx = { agent: { session: { header: { cwd: kindWs } } } }
  const kindIns = kindDb.db.prepare('INSERT INTO dream_log (run_at, summary, changes, note) VALUES (?, ?, ?, ?)')
  const kindPlan = (dup) => ({ rows: 3, rounds: 2, dup, cover: 0, missing: 0, projects: [] })
  const kindBase = Date.now() - 600000
  const kindOf = (kind, plan) => JSON.stringify(plan === undefined ? { stamped: 1, kind } : { stamped: 1, groups: kind.groupsDone ?? 2, kind, plan })
  kindIns.run(kindBase, 'window dream done: k1 groups=2 stamped=1 T=2026-11-20T04:00:00.000Z', kindOf({ kind: 'done' }, kindPlan(3)), '')
  kindIns.run(kindBase + 1000, 'window dream done: k2 groups=2 stamped=1 T=2026-11-20T04:01:00.000Z', kindOf({ kind: 'done' }, kindPlan(2)), '')
  kindIns.run(
    kindBase + 2000,
    'window dream aborted: k3 groups=1/2 stamped=1 T=2026-11-20T04:02:00.000Z',
    kindOf({ kind: 'aborted', groupsDone: 1, groupsTotal: 2 }, kindPlan(0)),
    '',
  )
  const kindOne = text(await tools.get('memory_admin').execute({ action: 'dream', id: '#1', limit: 10 }, kindCtx))
  check(
    'D49 中途放弃的行与展开都念「走了 1/2 组就停下」，并提醒那行数字只是中间值',
    kindOne.includes('中途放弃') && kindOne.includes('走了 1/2 组就停下') && kindOne.includes('别跟跑完的轮一起算'),
    kindOne.split('\n').slice(0, 2).join(' | '),
  )
  check(
    'D50 半轮不配跟整轮比数字：说「这一条不是完整的一轮……数字不可比」（否则比出来的「变少了」是假象）',
    kindOne.includes('这一条不是完整的一轮（没跑完 / 已封存），数字不可比'),
    kindOne.split('\n').find((l) => l.startsWith('比更早')) ?? '(无)',
  )
  const kindTrendLine = text(await tools.get('memory_admin').execute({ action: 'dream', limit: 10 }, kindCtx))
    .split('\n')
    .find((l) => l.startsWith('趋势')) ?? '(无)'
  check(
    'D51 趋势只拿跑完的轮做合计：最近 2 次 / 合计 5 对（半轮的 0 对不进），并说清 1 次没跑完不进合计',
    kindTrendLine.includes('最近 2 次') && kindTrendLine.includes('逐字重复 合计 5 对') && kindTrendLine.includes('1 次没跑完（中途放弃 / 待补记 / 已封存），不进合计'),
    kindTrendLine,
  )
  kindIns.run(
    kindBase + 3000,
    'window dream recovered (interrupted): k4 stamped=1 groups=1 T=2026-11-20T04:03:00.000Z',
    JSON.stringify({ stamped: 1, groups: 1, kind: { kind: 'recovered', groupsDone: 1 } }),
    '',
  )
  const kindRec = text(await tools.get('memory_admin').execute({ action: 'dream', id: '#1', limit: 10 }, kindCtx))
  check(
    'D52 补记账不冒充老账：念「补记时已走完 1 组」，不再念「比 0.2.96 早」（0.2.96 之后才有补记账）',
    kindRec.includes('补记时已走完 1 组') && !kindRec.includes('比 0.2.96 早'),
    kindRec.split('\n').slice(0, 2).join(' | '),
  )
  kindIns.run(
    kindBase + 4000,
    'window dream sealed (turn-failed): k5 fails=3 stamped=1 T=2026-11-20T04:04:00.000Z',
    JSON.stringify({ stamped: 1, kind: { kind: 'sealed', fails: 3 } }),
    '',
  )
  const kindSeal = text(await tools.get('memory_admin').execute({ action: 'dream', id: '#1', limit: 10 }, kindCtx))
  check(
    'D53 封存账进面板：念「连续失败已封存（连续失败 3 次）」，且不说它写在 0.2.96 之前',
    kindSeal.includes('连续失败已封存') &&
      kindSeal.includes('连续失败 3 次') &&
      !kindSeal.includes('它写在 0.2.96 之前，当时还没有记规模'),
    kindSeal.split('\n').slice(0, 2).join(' | '),
  )

  // D54–D57（0.2.108）：层走向。总条数只说「库重了多少」，说不出「哪一层在膨胀」——
  // fact 一直涨、topic 一直掉，总数可能是 0，而库的结构在烂。层走向就是这句话的证据。
  const lvWs = mkdtempSync(join(tmpdir(), 'macro-probe-levels-'))
  const lvDb = Meow.getDb(lvWs, '.dsh-meow')
  const lvCtx = { agent: { session: { header: { cwd: lvWs } } } }
  const lvIns = lvDb.db.prepare('INSERT INTO dream_log (run_at, summary, changes, note) VALUES (?, ?, ?, ?)')
  const lvScale = (byLevel) => ({ active: Object.values(byLevel).reduce((a, b) => a + b, 0), byLevel })
  const lvPlan = (end, start) => ({
    rounds: 1,
    rows: 2,
    dup: 0,
    cover: 0,
    missing: 0,
    store: start === undefined ? lvScale({ fact: 2, lesson: 1 }) : start,
    ...(end === null ? {} : { storeEnd: end }),
  })
  const lvBase = Date.now() - 600000
  lvIns.run(lvBase, 'window dream done: v1 groups=1 stamped=1 T=2026-11-20T04:10:00.000Z', JSON.stringify({ stamped: 1, groups: 1, kind: { kind: 'done' }, plan: lvPlan(lvScale({ fact: 2, lesson: 1 }), lvScale({ fact: 2, lesson: 1 })) }), '')
  lvIns.run(lvBase + 1000, 'window dream done: v2 groups=1 stamped=1 T=2026-11-20T04:11:00.000Z', JSON.stringify({ stamped: 1, groups: 1, kind: { kind: 'done' }, plan: lvPlan(lvScale({ fact: 3, lesson: 1, topic: 1 })) }), '')
  lvIns.run(lvBase + 2000, 'window dream done: v3 groups=1 stamped=1 T=2026-11-20T04:12:00.000Z', JSON.stringify({ stamped: 1, groups: 1, kind: { kind: 'done' }, plan: lvPlan(lvScale({ fact: 3, lesson: 1, topic: 2 })) }), '')
  lvIns.run(
    lvBase + 3000,
    'window dream aborted: v4 groups=0/2 stamped=1 T=2026-11-20T04:13:00.000Z',
    JSON.stringify({ stamped: 1, groups: 0, kind: { kind: 'aborted', groupsDone: 0, groupsTotal: 2 }, plan: lvPlan(lvScale({ fact: 9 })) }),
    '',
  )
  lvIns.run(lvBase + 4000, 'window dream done: v5 groups=1 stamped=1 T=2026-11-20T04:14:00.000Z', JSON.stringify({ stamped: 1, groups: 1, kind: { kind: 'done' }, plan: lvPlan(null) }), '')
  const lvPanel = text(await tools.get('memory_admin').execute({ action: 'dream', limit: 10 }, lvCtx))
  const lvLine = lvPanel.split('\n').find((l) => l.startsWith('层走向')) ?? '(无)'
  check(
    'D54 层走向按每一轮收尾的 byLevel 摊开：topic 0 → 1 → 2（+2）· fact 2 → 3 → 3（+1）· lesson 没变（总数看不出哪层在膨胀）',
    lvLine.includes('层走向：最近 3 次收尾（最早→最新）') &&
      lvLine.includes('topic 0 → 1 → 2（+2）') &&
      lvLine.includes('fact 2 → 3 → 3（+1）') &&
      lvLine.includes('lesson 1 → 1 → 1（没变）') &&
      lvLine.includes('涨得最多的是 topic（+2）'),
    lvLine,
  )
  check(
    'D55 排除了谁要说清：半轮 1 次、缺收尾层数 1 次都不进走向，并交代「只数 active / 缺层就是 0 条」',
    lvLine.includes('1 次没跑完（中途放弃 / 待补记 / 已封存），不进这条走向') &&
      lvLine.includes('1 次没有收尾层数（0.2.106 之前的账没有这一格），不进这条走向') &&
      lvLine.includes("只数 status='active'") &&
      lvLine.includes('那一轮那层 0 条在用'),
    lvLine,
  )
  const lvOneWs = mkdtempSync(join(tmpdir(), 'macro-probe-levels-one-'))
  const lvOneDb = Meow.getDb(lvOneWs, '.dsh-meow')
  lvOneDb.db
    .prepare('INSERT INTO dream_log (run_at, summary, changes, note) VALUES (?, ?, ?, ?)')
    .run(Date.now() - 1000, 'window dream done: o1 groups=1 stamped=1 T=2026-11-20T04:20:00.000Z', JSON.stringify({ stamped: 1, groups: 1, kind: { kind: 'done' }, plan: lvPlan(lvScale({ fact: 1 })) }), '')
  const lvOnePanel = text(await tools.get('memory_admin').execute({ action: 'dream', limit: 10 }, { agent: { session: { header: { cwd: lvOneWs } } } }))
  check(
    'D56 只有一轮不出层走向：一次是快照，不是走向（硬算等于编）',
    !lvOnePanel.includes('层走向'),
    lvOnePanel.split('\n').slice(0, 3).join(' | '),
  )
  const lvFlatWs = mkdtempSync(join(tmpdir(), 'macro-probe-levels-flat-'))
  const lvFlatDb = Meow.getDb(lvFlatWs, '.dsh-meow')
  const lvFlatIns = lvFlatDb.db.prepare('INSERT INTO dream_log (run_at, summary, changes, note) VALUES (?, ?, ?, ?)')
  const lvFlatPlan = lvScale({ fact: 2, lesson: 1 })
  lvFlatIns.run(Date.now() - 2000, 'window dream done: f1 groups=1 stamped=1 T=2026-11-20T04:30:00.000Z', JSON.stringify({ stamped: 1, groups: 1, kind: { kind: 'done' }, plan: lvPlan(lvFlatPlan) }), '')
  lvFlatIns.run(Date.now() - 1000, 'window dream done: f2 groups=1 stamped=1 T=2026-11-20T04:31:00.000Z', JSON.stringify({ stamped: 1, groups: 1, kind: { kind: 'done' }, plan: lvPlan(lvFlatPlan) }), '')
  const lvFlatPanel = text(await tools.get('memory_admin').execute({ action: 'dream', limit: 10 }, { agent: { session: { header: { cwd: lvFlatWs } } } }))
  const lvFlatLine = lvFlatPanel.split('\n').find((l) => l.startsWith('层走向')) ?? '(无)'
  check(
    'D57 每层都没变就说没变：不硬凑一句「涨得最多」（噪声不许讲成走势）',
    lvFlatLine.includes('每一层的条数都没变') && !lvFlatLine.includes('涨得最多') && !lvFlatLine.includes('掉得最多'),
    lvFlatLine,
  )

  // D67–D69（0.2.111）：项目走向。层走向只说「fact 在涨」，说不出「哪个项目在涨」——
  // Alpha 涨 3 条、Beta 掉 3 条，层走向念「fact 没变」，而实际上一个项目在膨胀、另一个在被清空。
  const pjWs = mkdtempSync(join(tmpdir(), 'macro-probe-projects-'))
  const pjDb = Meow.getDb(pjWs, '.dsh-meow')
  const pjCtx = { agent: { session: { header: { cwd: pjWs } } } }
  const pjIns = pjDb.db.prepare('INSERT INTO dream_log (run_at, summary, changes, note) VALUES (?, ?, ?, ?)')
  const pjScale = (byLevel, byProject) => ({
    active: Object.values(byLevel).reduce((a, b) => a + b, 0),
    byLevel,
    ...(byProject === undefined ? {} : { byProject }),
  })
  const pjPlan = (end, start, endProject) => ({
    rounds: 1,
    rows: 2,
    dup: 0,
    cover: 0,
    missing: 0,
    store: start,
    ...(end === null ? {} : { storeEnd: end }),
  })
  const pjStart = pjScale({ fact: 4, topic: 1 }, { Alpha: 3, Beta: 2 })
  const pjBase = Date.now() - 600000
  pjIns.run(pjBase, 'window dream done: p1 groups=1 stamped=1 T=2026-11-20T05:10:00.000Z', JSON.stringify({ stamped: 1, groups: 1, kind: { kind: 'done' }, plan: pjPlan(pjStart, pjStart) }), '')
  pjIns.run(pjBase + 1000, 'window dream done: p2 groups=1 stamped=1 T=2026-11-20T05:11:00.000Z', JSON.stringify({ stamped: 1, groups: 1, kind: { kind: 'done' }, plan: pjPlan(pjScale({ fact: 5, topic: 1 }, { Alpha: 4, Beta: 2 })) }), '')
  // 这一轮 fact 净增 2、Beta 掉到 0：层走向会说 fact 在涨，项目走向要能指出是 Alpha 涨、Beta 空。
  pjIns.run(pjBase + 2000, 'window dream done: p3 groups=1 stamped=1 T=2026-11-20T05:12:00.000Z', JSON.stringify({ stamped: 1, groups: 1, kind: { kind: 'done' }, plan: pjPlan(pjScale({ fact: 6, topic: 1 }, { Alpha: 6 })) }), '')
  pjIns.run(pjBase + 3000, 'window dream done: p4 groups=1 stamped=1 T=2026-11-20T05:13:00.000Z', JSON.stringify({ stamped: 1, groups: 1, kind: { kind: 'done' }, plan: pjPlan(pjScale({ fact: 6, topic: 1 })) }), '')
  const pjPanel = text(await tools.get('memory_admin').execute({ action: 'dream', limit: 10 }, pjCtx))
  const pjLine = pjPanel.split('\n').find((l) => l.startsWith('项目走向')) ?? '(无)'
  check(
    'D67 项目走向按每一轮收尾的 byProject 摊开：Alpha 3 → 4 → 6（+3）· Beta 2 → 2 → 0（-2）（层走向只会说 fact 在涨）',
    pjLine.includes('项目走向：最近 3 次收尾（最早→最新）') &&
      pjLine.includes('Alpha 3 → 4 → 6（+3）') &&
      pjLine.includes('Beta 2 → 2 → 0（-2）') &&
      pjLine.includes('涨得最多的是 Alpha（+3）'),
    pjLine,
  )
  check(
    'D68 口径要说全：只数带项目归属的 5 层（soul / user 没有这一格）、项目名按原样（改名算两行）、缺这一格的账不进走向',
    pjLine.includes('只数带项目归属的 5 层') &&
      pjLine.includes('soul / user 没有这一格') &&
      pjLine.includes('改过名的会算成两行') &&
      pjLine.includes('1 次没有收尾项目数（0.2.111 之前的账没有这一格），不进这条走向'),
    pjLine,
  )
  const pjOneWs = mkdtempSync(join(tmpdir(), 'macro-probe-projects-one-'))
  const pjOneDb = Meow.getDb(pjOneWs, '.dsh-meow')
  pjOneDb.db
    .prepare('INSERT INTO dream_log (run_at, summary, changes, note) VALUES (?, ?, ?, ?)')
    .run(Date.now() - 1000, 'window dream done: q1 groups=1 stamped=1 T=2026-11-20T05:20:00.000Z', JSON.stringify({ stamped: 1, groups: 1, kind: { kind: 'done' }, plan: pjPlan(pjScale({ fact: 2 }, { Alpha: 2 })) }), '')
  const pjOnePanel = text(await tools.get('memory_admin').execute({ action: 'dream', limit: 10 }, { agent: { session: { header: { cwd: pjOneWs } } } }))
  check(
    'D69 只有一轮不出项目走向：一次是快照，不是走向（硬算等于编）',
    !pjOnePanel.includes('项目走向'),
    pjOnePanel.split('\n').slice(0, 3).join(' | '),
  )
  const pjFlatWs = mkdtempSync(join(tmpdir(), 'macro-probe-projects-flat-'))
  const pjFlatDb = Meow.getDb(pjFlatWs, '.dsh-meow')
  const pjFlatIns = pjFlatDb.db.prepare('INSERT INTO dream_log (run_at, summary, changes, note) VALUES (?, ?, ?, ?)')
  const pjFlatScale = pjScale({ fact: 3 }, { Alpha: 2, Beta: 1 })
  pjFlatIns.run(Date.now() - 2000, 'window dream done: g1 groups=1 stamped=1 T=2026-11-20T05:30:00.000Z', JSON.stringify({ stamped: 1, groups: 1, kind: { kind: 'done' }, plan: pjPlan(pjFlatScale) }), '')
  pjFlatIns.run(Date.now() - 1000, 'window dream done: g2 groups=1 stamped=1 T=2026-11-20T05:31:00.000Z', JSON.stringify({ stamped: 1, groups: 1, kind: { kind: 'done' }, plan: pjPlan(pjFlatScale) }), '')
  const pjFlatPanel = text(await tools.get('memory_admin').execute({ action: 'dream', limit: 10 }, { agent: { session: { header: { cwd: pjFlatWs } } } }))
  const pjFlatLine = pjFlatPanel.split('\n').find((l) => l.startsWith('项目走向')) ?? '(无)'
  check(
    'D70 每个项目都没变就说没变：不硬凑一句「涨得最多」（噪声不许讲成走势）',
    pjFlatLine.includes('每个项目的条数都没变') && !pjFlatLine.includes('涨得最多') && !pjFlatLine.includes('掉得最多'),
    pjFlatLine,
  )

  // D78–D81（0.2.113）：项目走向的两处升级。①首尾净差说不出「第几次才冒出来、哪一轮归零」；
  // ②轮数一多，序列会把回执那一行撑满——省 token 的口径在这里也要成立。
  const pjLongWs = mkdtempSync(join(tmpdir(), 'macro-probe-projects-long-'))
  const pjLongDb = Meow.getDb(pjLongWs, '.dsh-meow')
  const pjLongIns = pjLongDb.db.prepare('INSERT INTO dream_log (run_at, summary, changes, note) VALUES (?, ?, ?, ?)')
  const pjLongBase = Date.now() - 900000
  for (let i = 0; i < 8; i += 1) {
    pjLongIns.run(
      pjLongBase + i * 1000,
      `window dream done: h${i + 1} groups=1 stamped=1 T=2026-11-20T06:0${i}:00.000Z`,
      JSON.stringify({ stamped: 1, groups: 1, kind: { kind: 'done' }, plan: pjPlan(pjScale({ fact: i + 1 }, { Alpha: i + 1 })) }),
      '',
    )
  }
  const pjLongLine = text(await tools.get('memory_admin').execute({ action: 'dream', limit: 10 }, { agent: { session: { header: { cwd: pjLongWs } } } }))
    .split('\n')
    .find((l) => l.startsWith('项目走向')) ?? '(无)'
  check(
    'D78 八轮的序列不许整条摆出来：留头两个、尾三个，中间用 … 并报出省略了几次（省略不等于没数）',
    pjLongLine.includes('Alpha 1 → 2 → … → 6 → 7 → 8（+7）') &&
      pjLongLine.includes('序列太长，中间 3 次用 … 省略') &&
      !pjLongLine.includes('1 → 2 → 3 → 4 → 5'),
    pjLongLine,
  )

  const pjMoveWs = mkdtempSync(join(tmpdir(), 'macro-probe-projects-move-'))
  const pjMoveDb = Meow.getDb(pjMoveWs, '.dsh-meow')
  const pjMoveIns = pjMoveDb.db.prepare('INSERT INTO dream_log (run_at, summary, changes, note) VALUES (?, ?, ?, ?)')
  const pjMoveBase = Date.now() - 600000
  pjMoveIns.run(pjMoveBase, 'window dream done: m1 groups=1 stamped=1 T=2026-11-20T06:10:00.000Z', JSON.stringify({ stamped: 1, groups: 1, kind: { kind: 'done' }, plan: pjPlan(pjScale({ fact: 4 }, { Alpha: 3, Beta: 1 })) }), '')
  pjMoveIns.run(pjMoveBase + 1000, 'window dream done: m2 groups=1 stamped=1 T=2026-11-20T06:11:00.000Z', JSON.stringify({ stamped: 1, groups: 1, kind: { kind: 'done' }, plan: pjPlan(pjScale({ fact: 6 }, { Alpha: 4, Beta: 2 })) }), '')
  pjMoveIns.run(pjMoveBase + 2000, 'window dream done: m3 groups=1 stamped=1 T=2026-11-20T06:12:00.000Z', JSON.stringify({ stamped: 1, groups: 1, kind: { kind: 'done' }, plan: pjPlan(pjScale({ fact: 8 }, { Alpha: 6, Gamma: 2 })) }), '')
  const pjMoveLine = text(await tools.get('memory_admin').execute({ action: 'dream', limit: 10 }, { agent: { session: { header: { cwd: pjMoveWs } } } }))
    .split('\n')
    .find((l) => l.startsWith('项目走向')) ?? '(无)'
  check(
    'D79 新出现的要报第几次起有数：Gamma 前两次不在库里，净差里只看得出 +2，看不出「什么时候来的」',
    pjMoveLine.includes('这条走向里新出现：Gamma（第 3 次起有数，现在 2 条）'),
    pjMoveLine,
  )
  check(
    'D80 消失的要报最后一次是多少：Beta 上一轮还在 2 条，归零只写 -2 会让人以为「本来就没有」',
    pjMoveLine.includes('这条走向里消失：Beta（第 2 次是最后的数：2 条）'),
    pjMoveLine,
  )
  check(
    'D81 一存一失同时出现时点出「可能是改名」，但不替他断定：走向给线索，核对要人去翻那一轮的账',
    pjMoveLine.includes('很可能只是改名') && pjMoveLine.includes('不替你猜') && pjMoveLine.includes('翻那一轮的账'),
    pjMoveLine,
  )
  const pjStillLine = pjFlatLine
  check(
    'D82 没有新出现也没有消失就别加这两句（阴性对照：平稳的走向不许自己长戏）',
    !pjStillLine.includes('这条走向里新出现') && !pjStillLine.includes('这条走向里消失') && !pjStillLine.includes('改名'),
    pjStillLine,
  )

  // [macro-fusion 0.2.114] 疑似冲突：账本里能摊出「同一件事的两种说法」
  // 三件事要看见：①行里点出对数；②摊开看见差在哪些数字、共用哪些关键词、谁更新；
  // ③0.2.114 之前的账没查过冲突，得说「没查」，不能说「查了没有」。
  const cfWs = mkdtempSync(join(tmpdir(), 'macro-probe-conflict-'))
  const cfDb = Meow.getDb(cfWs, '.dsh-meow')
  const cfRowOf = (id, content, keywords, updated_at, status = 'active', level = 'fact') => ({
    id, level, content, keywords, updated_at, created_at: updated_at - 100, status,
  })
  const cfA = cfRowOf('cccc0001aa', 'DSH 的记忆库在 C 盘的 .dsh 目录里，插件版本 0.1.x，配置文件也在 C 盘', ['DSH', '路径'], 1760000000000)
  const cfB = cfRowOf('cccc0002bb', 'DSH 已经搬到 D 盘 dsh-home，插件版本 0.2.113，所有配置与插件数据都在 D 盘', ['DSH', '路径'], 1760000600000)
  const cfRounds = [{ kind: 'atomic', groups: [{ name: '', rows: [cfA, cfB] }], projects: ['Alpha'] }]
  const cfDigest = Meow.dreamPlanDigest(cfRounds)
  cfDb.logDream('window dream done: sess-conflict-legacy stamped=true', {
    stamped: true, groups: 1,
    plan: { rounds: 1, groups: 1, rows: 2, dup: 0, cover: 0, missing: 0, projects: 0, pairs: [] },
  }, '老格式：0.2.114 之前没有冲突这一格')
  cfDb.logDream('window dream done: sess-conflict stamped=true', { stamped: true, groups: 1, plan: cfDigest }, '疑似冲突')
  const cfCtx = { agent: { session: { header: { cwd: cfWs } } } }
  const cfNew = text(await tools.get('memory_admin').execute({ action: 'dream', id: '1' }, cfCtx))
  check(
    'D83 摊开一条带冲突的账：对数、短 id、共用关键词、各自独有、谁更新全在',
    cfNew.includes('疑似冲突（账里存了 1 对，这一轮共 1 对）：') &&
      cfNew.includes('- cccc0001 ⇄ cccc0002') &&
      cfNew.includes('共用关键词：dsh、路径') &&
      cfNew.includes('cccc0001 独有 0.1') &&
      cfNew.includes('cccc0002 独有 0.2.113') &&
      /cccc0002 更新（\d{2}-\d{2} \d{2}:\d{2}）/.test(cfNew),
    cfNew.split('\n').filter((l) => l.startsWith('疑似冲突') || l.startsWith('- cccc')).join(' | '),
  )
  const cfNewRow = cfNew.split('\n').find((l) => l.startsWith('#') && l.includes('疑似冲突')) ?? ''
  check(
    'D84 行里就点出「疑似冲突 N 对」，不用展开才知道这一轮撞上了',
    cfNewRow.includes('疑似冲突 1 对'),
    cfNewRow || cfNew.split('\n').slice(0, 3).join(' | '),
  )
  const cfLegacy = text(await tools.get('memory_admin').execute({ action: 'dream', id: '2' }, cfCtx))
  check(
    'D85 老账（0.2.114 之前）明说「没查过冲突」，不是「查了没有」',
    cfLegacy.includes('没有存这一格') && cfLegacy.includes('根本没查冲突') && cfLegacy.includes('不是「查了没有」'),
    cfLegacy.split('\n').filter((l) => l.startsWith('疑似冲突')).join(' | '),
  )
  cfDb.logDream('window dream done: sess-conflict-hollow stamped=true', {
    stamped: true, groups: 1,
    plan: { rounds: 1, groups: 1, rows: 2, dup: 0, cover: 0, missing: 0, projects: 0, conflicts: 2, conflictPairs: [] },
  }, '有数没明细')
  const cfHollow = text(await tools.get('memory_admin').execute({ action: 'dream', id: '1' }, cfCtx))
  check(
    'D86 账里记着 2 对却一条明细都没有：别把「没列」读成「没有」',
    cfHollow.includes('账里记着 2 对，却没有一条明细') && cfHollow.includes('别把「没列」读成「没有」'),
    cfHollow.split('\n').filter((l) => l.startsWith('疑似冲突')).join(' | '),
  )
  cfDb.logDream('window dream done: sess-conflict-clip stamped=true', {
    stamped: true, groups: 1,
    plan: {
      rounds: 1, groups: 1, rows: 6, dup: 0, cover: 0, missing: 0, projects: 0,
      conflicts: 5,
      conflictPairs: [{ kind: 'conflict', a: 'cccc0001', b: 'cccc0002', levelA: 'fact', levelB: 'fact', shared: ['dsh', '路径'], sharedTotal: 2, onlyA: ['0.1'], onlyB: ['0.2.113'], onlyACount: 1, onlyBCount: 1, newer: 'b', newerAt: 1760000600000 }],
    },
  }, '明细超上限')
  const cfClip = text(await tools.get('memory_admin').execute({ action: 'dream', id: '1' }, cfCtx))
  check(
    'D87 只存了前几对：差额要说出来（数是真数，点名只到前几对）',
    cfClip.includes('账里存了 1 对，这一轮共 5 对') && cfClip.includes('- 还有 4 对没落账'),
    cfClip.split('\n').filter((l) => l.startsWith('疑似冲突') || l.startsWith('- 还有')).join(' | '),
  )
  const cfQuiet = Meow.dreamPlanDigest([{ kind: 'atomic', groups: [{ name: '', rows: [cfB] }], projects: [] }])
  cfDb.logDream('window dream done: sess-conflict-none stamped=true', { stamped: true, groups: 1, plan: cfQuiet }, '没有冲突')
  const cfNone = text(await tools.get('memory_admin').execute({ action: 'dream', id: '1' }, cfCtx))
  const cfNoneRow = cfNone.split('\n').find((l) => l.startsWith('#')) ?? ''
  check(
    'D88 阴性对照：这一轮没有两种说法就明说没有，行里也不多一个「疑似冲突 0 对」',
    cfNone.includes('这一轮没有「同一主题却写了不同数字」的条目') && !cfNoneRow.includes('疑似冲突'),
    cfNone.split('\n').filter((l) => l.startsWith('疑似冲突')).join(' | ') + ' || ' + cfNoneRow,
  )

  // [macro-fusion 0.2.115] 冲突跨轮追踪：同一对是不是老账重提，得看得出来。
  // 三件事：①抬头点出「其中几对之前就报过、最早第几轮」；②每行结一句「这一轮新报」或「共 k 次」；
  // ③连报三次还在账上，点名催处置——不然每轮安静地重提一遍，等于把噪音当成了工作。
  const ctWs = mkdtempSync(join(tmpdir(), 'macro-probe-trail-'))
  const ctDb = Meow.getDb(ctWs, '.dsh-meow')
  const ctPair = {
    kind: 'conflict', a: 'cccc0001', b: 'cccc0002', levelA: 'fact', levelB: 'fact',
    shared: ['dsh', '路径'], sharedTotal: 2, onlyA: ['0.1'], onlyB: ['0.2.113'],
    onlyACount: 1, onlyBCount: 1, newer: 'b', newerAt: 1760000600000,
  }
  const ctPairNew = { ...ctPair, a: 'dddd0003', b: 'dddd0004' }
  const ctPlan = (list) => ({
    rounds: 1, groups: 1, rows: 2, dup: 0, cover: 0, missing: 0, projects: 0,
    conflicts: list.length, conflictPairs: list,
  })
  ctDb.logDream('window dream done: sess-trail-oldest stamped=true', { stamped: true, groups: 1, plan: ctPlan([ctPair]) }, '第 3 轮')
  ctDb.logDream('window dream done: sess-trail-mid stamped=true', { stamped: true, groups: 1, plan: ctPlan([ctPair]) }, '第 2 轮')
  ctDb.logDream('window dream done: sess-trail-newest stamped=true', { stamped: true, groups: 1, plan: ctPlan([ctPair, ctPairNew]) }, '第 1 轮')
  const ctCtx = { agent: { session: { header: { cwd: ctWs } } } }
  const ctTop = text(await tools.get('memory_admin').execute({ action: 'dream', id: '1' }, ctCtx))
  const ctTopPairs = ctTop.split('\n').filter((l) => l.startsWith('疑似冲突') || l.startsWith('- cccc') || l.startsWith('- dddd'))
  check(
    'D89 老账重提：抬头点出「其中 1 对之前就报过，最早第 3 轮」，行尾写「加这次共 3 次」',
    ctTop.includes('疑似冲突（账里存了 2 对，这一轮共 2 对；其中 1 对之前就报过，最早第 3 轮）：') &&
      ctTop.includes('cccc0001 ⇄ cccc0002') &&
      ctTop.includes('之前报过（最早第 3 轮，加这次共 3 次）'),
    ctTopPairs.join(' | '),
  )
  check(
    'D90 同一轮里新发现的那对标「这一轮新报」，不跟老账混成一堆',
    /dddd0003 ⇄ dddd0004[^\n]*· 这一轮新报/.test(ctTop),
    ctTopPairs.filter((l) => l.startsWith('- dddd')).join(' | '),
  )
  check(
    'D91 连报三次还挂在账上：点名催处置（同一对不会因为多报几次变得清楚）',
    ctTop.includes('- cccc0001 ⇄ cccc0002 已经第 3 次出现在账上（最早第 3 轮）') &&
      ctTop.includes('同一对不会因为多报几次变得清楚'),
    ctTop.split('\n').filter((l) => l.includes('已经第')).join(' | '),
  )
  const ctMid = text(await tools.get('memory_admin').execute({ action: 'dream', id: '2' }, ctCtx))
  check(
    'D92 只报过两次：说「共 2 次」，还不到催办门槛就不催——催得太早也是噪音',
    ctMid.includes('之前报过（最早第 3 轮，加这次共 2 次）') && !ctMid.includes('已经第 3 次'),
    ctMid.split('\n').filter((l) => l.startsWith('疑似冲突') || l.includes('之前报过') || l.includes('已经第')).join(' | '),
  )
  const ctOldest = text(await tools.get('memory_admin').execute({ action: 'dream', id: '3' }, ctCtx))
  check(
    'D93 最早那一轮没有更早的账可比：两对都算「这一轮新报」，抬头不提「之前就报过」',
    ctOldest.includes('疑似冲突（账里存了 1 对，这一轮共 1 对）：') &&
      ctOldest.includes('这一轮新报') &&
      !ctOldest.includes('之前就报过') &&
      !ctOldest.includes('已经第'),
    ctOldest.split('\n').filter((l) => l.startsWith('疑似冲突') || l.includes('这一轮新报')).join(' | '),
  )

  // [macro-fusion 0.2.116] 上一轮报的对这一轮不见了，得说清是处置了还是只是错开了。
  // 四种去向：已归档 / 正文改过 / 查不到了 / 两条都没动过（这条最容易被误读成「解决了」）。
  const stPlan = (list) => ({
    rounds: 1, groups: 1, rows: 2, dup: 0, cover: 0, missing: 0, projects: 0,
    conflicts: list.length, conflictPairs: list,
  })
  const stRow = (id, content, keywords, status, updatedAt) => ({
    id, level: 'fact', content, keywords, status, updated_at: updatedAt, created_at: 1600000000000,
    importance: 2, project: null, title: null,
  })
  const stPair = (a, b) => ({
    kind: 'conflict', a, b, levelA: 'fact', levelB: 'fact',
    shared: ['dsh', '路径'], sharedTotal: 2, onlyA: ['0.1'], onlyB: ['0.2.115'],
    newer: 'b', newerAt: 1760000600000,
  })
  const stScene = (tag, rows, prevPairs, nowPairs) => {
    const ws = mkdtempSync(join(tmpdir(), `macro-probe-settled-${tag}-`))
    const db = Meow.getDb(ws, '.dsh-meow')
    for (const r of rows) db.insert(r)
    db.logDream('window dream done: sess-settled-prev stamped=true', { stamped: true, groups: 1, plan: stPlan(prevPairs) }, '上一轮')
    db.logDream('window dream done: sess-settled-now stamped=true', { stamped: true, groups: 1, plan: stPlan(nowPairs) }, '这一轮')
    return { ws, db, ctx: { agent: { session: { header: { cwd: ws } } } } }
  }
  const stA = stRow('aaaa1111-0000-4000-8000-0000000000a1', 'DSH 在 C 盘 0.1', ['DSH', '路径'], 'active', 1600000000000)
  const stB = stRow('bbbb2222-0000-4000-8000-0000000000b2', 'DSH 在 D 盘 0.2.115', ['DSH', '路径'], 'active', 1600000000000)
  const stC = stRow('cccc3333-0000-4000-8000-0000000000c3', '旧结论（已被取代：D 盘）', ['DSH', '路径'], 'archived', 1600000000000)

  const stMixed = stScene('mixed', [stA, stC], [stPair('aaaa1111', 'cccc3333')], [])
  const stMixedText = text(await tools.get('memory_admin').execute({ action: 'dream', id: '1' }, stMixed.ctx))
  check(
    'D94 上一轮报过、这一轮不报：说清去向（已归档），并点出这一轮 0 对',
    stMixedText.includes('上一轮（第 2 轮）报了 1 对，这一轮不再报的有 1 对：') &&
      stMixedText.includes('cccc3333 已归档') &&
      stMixedText.includes('这一轮没有「同一主题却写了不同数字」的条目') &&
      stMixedText.includes('上面只是「后来动过什么」，不等于这一对真解决了'),
    stMixedText.split('\n').filter((l) => l.includes('上一轮') || l.includes('⇄') || l.includes('上面只是')).join(' | '),
  )

  const stMoved = stScene('moved', [stA, stB], [stPair('aaaa1111', 'bbbb2222')], [])
  stMoved.db.update('fact', 'aaaa1111-0000-4000-8000-0000000000a1', { content: 'DSH 已搬到 D 盘 0.2.115（已确认）' })
  const stMovedText = text(await tools.get('memory_admin').execute({ action: 'dream', id: '1' }, stMoved.ctx))
  check(
    'D95 上一轮之后正文被改过：写「正文改过」并带时间，不笼统说「动过」',
    /aaaa1111 正文改过（\d{2}-\d{2} \d{2}:\d{2}）/.test(stMovedText) &&
      stMovedText.includes('不等于这一对真解决了'),
    stMovedText.split('\n').filter((l) => l.includes('⇄')).join(' | '),
  )

  const stStill = stScene('still', [stA, stB], [stPair('aaaa1111', 'bbbb2222')], [])
  const stStillText = text(await tools.get('memory_admin').execute({ action: 'dream', id: '1' }, stStill.ctx))
  check(
    'D96 两条都没动过：明说「多半是关键词 / 数字刚好错开，不是处置」，不给假安心',
    stStillText.includes('两条都还在、也都没动过') && stStillText.includes('不是处置'),
    stStillText.split('\n').filter((l) => l.includes('⇄') || l.includes('两条都还在')).join(' | '),
  )

  const stGone = stScene('gone', [stA], [stPair('eeee9999', 'ffff8888')], [])
  const stGoneText = text(await tools.get('memory_admin').execute({ action: 'dream', id: '1' }, stGone.ctx))
  check(
    'D97 两条都查不到了：说「查不到了（归档或删除）」，不编成「已处置」',
    stGoneText.includes('eeee9999 查不到了（归档或删除）') && stGoneText.includes('ffff8888 查不到了'),
    stGoneText.split('\n').filter((l) => l.includes('⇄')).join(' | '),
  )

  const stKeep = stScene('keep', [stA, stB], [stPair('aaaa1111', 'bbbb2222')], [stPair('aaaa1111', 'bbbb2222')])
  const stKeepText = text(await tools.get('memory_admin').execute({ action: 'dream', id: '1' }, stKeep.ctx))
  check(
    'D98 这一轮还在报：只说「还都在报」，不列去向也不催',
    stKeepText.includes('上一轮（第 2 轮）报了 1 对，这一轮还都在报。') && !stKeepText.includes('不再报的有'),
    stKeepText.split('\n').filter((l) => l.includes('上一轮')).join(' | '),
  )
  const stNone = stScene('none', [stA], [], [])
  const stNoneText = text(await tools.get('memory_admin').execute({ action: 'dream', id: '1' }, stNone.ctx))
  check(
    'D99 上一轮本来就没报过对：一个字都不加（不写「还都在报」，也不写「0 对不再报」）',
    !stNoneText.includes('上一轮（第'),
    stNoneText.split('\n').filter((l) => l.includes('上一轮')).join(' | ') || '（没有这一块）',
  )

  const stRefText = text(await tools.get('memory_admin').execute({ action: 'dream', id: 'r2' }, stMixed.ctx))
  check(
    'D100 按引用展开也带去向：两条路径同一套说法，不出现「列表有、引用没有」',
    stRefText.includes('上一轮（第 2 轮）报了 1 对') && stRefText.includes('cccc3333 已归档'),
    stRefText.split('\n').filter((l) => l.includes('上一轮') || l.includes('⇄')).join(' | '),
  )

  // D58–D61（0.2.109）：回执成本 + budget。六个维度里「效率」以前没有数——
  // 有条数、有耗时，没有「这次检索占了多少上下文」，于是「多查几次也无所谓」永远是一句空话。
  const { createUnifiedTools: costTools } = await import(pathToFileURL(join(root, 'lib/macro/tools.js')).href)
  const costStore = { calls: [], rigid: false }
  function costTool() {
    const entries = new Map()
    const add = (name, fn) => entries.set(name, { name, vendor: 'stub', def: { name, execute: fn }, options: {} })
    add('memory_search', async (a) => {
      costStore.calls.push({ k: a.k, content_max: a.content_max })
      // rigid：回执体量不跟着参数走（模拟「引擎自己给的体量」），用来验「装不下就直说」。
      if (costStore.rigid) return `固定长回执：${'内容'.repeat(1000)}`
      const k = Number(a.k ?? 10)
      const cm = Number(a.content_max ?? 300)
      let out = ''
      for (let i = 0; i < k; i += 1) out += `- ${i + 1}. ${'内容'.repeat(Math.max(1, Math.ceil((cm || 300) / 2)))}\n`
      return out
    })
    add('memory_read', async () => `【标题】长记忆\n\n${'正文一句。'.repeat(300)}`)
    // [macro-fusion 0.2.110] 星图 / 补邻居 / 相似三路也要能被预算约束：stub 的体量必须跟着
    // 各自的旋钮走（limit / chars / content_max+k），否则「收紧了」这句话验不出真假。
    add('nebula_recall', async (a) => {
      costStore.calls.push({ tool: 'recall', limit: a.limit, hops: a.hops })
      if (costStore.rigid) return `固定长星图：${'节点'.repeat(900)}`
      const limit = Number(a.limit ?? 10)
      let out = '沿关联：'
      for (let i = 0; i < limit; i += 1) out += `${i ? ' → ' : ''}节点${i}（${'说明'.repeat(40)}）`
      return out
    })
    add('nebula_bridge', async (a) => {
      costStore.calls.push({ tool: 'bridge', chars: a.chars, limit: a.limit })
      if (costStore.rigid) return `固定长邻居：${'邻居'.repeat(900)}`
      const chars = Number(a.chars ?? 900)
      const limit = Number(a.limit ?? 4)
      let out = ''
      for (let i = 0; i < limit; i += 1) out += `- 邻居${i}. ${'邻居内容'.repeat(Math.max(1, Math.ceil(chars / limit / 4)))}\n`
      return out
    })
    add('memory_find_similar', async (a) => {
      costStore.calls.push({ tool: 'similar', k: a.k, content_max: a.content_max })
      if (costStore.rigid) return `固定长相似：${'相似'.repeat(900)}`
      const k = Number(a.k ?? 10)
      const cm = Number(a.content_max ?? 300)
      let out = '['
      for (let i = 0; i < k; i += 1) {
        out += `${i ? ',' : ''}{"id":"x${i}","content":"${'相似'.repeat(Math.max(1, Math.ceil(cm / 2)))}"}`
      }
      return `${out}]`
    })
    const bridge = {
      has: (n) => entries.has(n),
      get: (n) => entries.get(n),
      names: () => [...entries.keys()],
      awaitTool: async (n) => entries.get(n),
      async call(name, args) {
        const e = entries.get(name)
        if (!e) throw new Error(`stub 没有 ${name}`)
        const value = await e.def.execute(args)
        return { entry: e, def: e.def, value, text: typeof value === 'string' ? value : JSON.stringify(value) }
      },
      async tryCall(name, args) {
        try {
          return await bridge.call(name, args)
        } catch (err) {
          return { entry: undefined, def: undefined, value: undefined, text: `${name}未完成：${err.message}` }
        }
      },
      promptDeclarations: () => [],
    }
    return costTools({ bridge, config: { toolWaitMs: 10, linkWaitMs: 10 } }).find(
      (t) => t.name === 'memory_search',
    )
  }
  const costSearch = costTool()
  const costRun = async (args) => String((await costSearch.execute(args, {})) ?? '')

  const costBig = await costRun({ query: '大', k: 10, content_max: 300, expand: false })
  check(
    'D58 大回执自带成本尾注，并说过 1200 才建议收紧：省 token 先要知道花了多少',
    costBig.includes('成本 ≈') && costBig.includes('是量级不是账单') && costBig.includes('只想看骨架就加 budget=400'),
    costBig.slice(-120),
  )
  costStore.calls = []
  const costFit = await costRun({ query: '大', k: 10, content_max: 300, expand: false, budget: 400 })
  check(
    'D59 给了预算就自己收紧，并交代砍了什么（先砍字、再砍条数）',
    costStore.calls.length > 1 &&
      costFit.includes('按 400 token 预算收紧了') &&
      costFit.includes('content_max 300→') &&
      /实际 ≈[\d.]+k? token/.test(costFit),
    `调用 ${costStore.calls.length} 次 · ${costFit.slice(-140)}`,
  )
  costStore.rigid = true
  const costTiny = await costRun({ query: '大', k: 10, content_max: 300, expand: false, budget: 80 })
  costStore.rigid = false
  check(
    'D60 缩到底也装不下就直说，并给实测最小值：报「最小」之前必须真的试过最小',
    costTiny.includes('预算 80 token 装不下') && costTiny.includes('（k=1、content_max=60）实测') && !costTiny.includes('收紧了'),
    costTiny.slice(-160),
  )
  const costSmall = await costRun({ query: '小', k: 1, content_max: 40, expand: false })
  const costNoBudget = await costRun({ mode: 'graph', query: 'x' })
  check(
    'D61 小回执不报成本、没给预算就不缩也不说废话：省 token 的工具自己先要省',
    !costSmall.includes('成本 ≈') &&
      !costNoBudget.includes('收紧了') &&
      !costNoBudget.includes('只有本地检索能收紧'),
    `small=${costSmall.slice(0, 30)} | graph=${costNoBudget.slice(-80)}`,
  )

  // D62–D65（0.2.110）：预算原来只落在本地这一路，尾注老实写着「星图 / 相似两路不缩」——
  // 一句诚实的缺功能。四路回执都进上下文，凭什么只有一路能被约束。
  costStore.calls = []
  const costGraphFit = await costRun({ mode: 'graph', query: 'x', budget: 300 })
  check(
    'D62 星图这一路也按预算收紧，并说清动了哪个旋钮（limit 而不是 k）',
    costGraphFit.includes('沿关联扩散这一路按 300 token 预算收紧了') &&
      /limit 10→\d+/.test(costGraphFit) &&
      !costGraphFit.includes('k 10→'),
    `调用 ${costStore.calls.length} 次 · ${costGraphFit.slice(-140)}`,
  )
  costStore.calls = []
  const costBridgeFit = await costRun({ mode: 'bridge', query: 'x', budget: 300 })
  check(
    'D63 补邻居先砍字符预算再砍条数：字符预算是这一路的「每条的字」',
    costBridgeFit.includes('补邻居这一路按 300 token 预算收紧了') && /chars 900→\d+/.test(costBridgeFit),
    `调用 ${costStore.calls.length} 次 · ${costBridgeFit.slice(-140)}`,
  )
  costStore.calls = []
  const costSimilarFit = await costRun({ mode: 'similar', id: 'abc', budget: 300 })
  check(
    'D64 相似这一路按预算收字（content_max），不是只砍条数',
    costSimilarFit.includes('相似条目这一路按 300 token 预算收紧了') && /content_max 300→\d+/.test(costSimilarFit),
    `调用 ${costStore.calls.length} 次 · ${costSimilarFit.slice(-140)}`,
  )
  costStore.rigid = true
  const costGraphTiny = await costRun({ mode: 'graph', query: 'x', budget: 200 })
  costStore.rigid = false
  check(
    'D65 星图路装不下也要量到下限（limit=1、hops=0）再说：报「最小」之前必须真试过最小',
    costGraphTiny.includes('预算 200 token 装不下') &&
      costGraphTiny.includes('（limit=1、hops=0）实测') &&
      !costGraphTiny.includes('收紧了'),
    costGraphTiny.slice(-160),
  )
  const costExpand = await costRun({ query: 'q', k: 6, content_max: 200, expand: true, budget: 900 })
  check(
    'D66 本地展开时扩散按「剩余预算」算，不是各自算一遍：读者付的是整份回执',
    costExpand.includes('星图扩散按剩余') && costExpand.includes('预算算'),
    costExpand.slice(-150),
  )

  // D71–D76（0.2.112）：读也吃预算。这一支最尴尬——正文是 caller 要的东西，砍了就成假货，
  // 于是只能砍邻居；砍到底还装不下就只给骨架 + 指路。不许截半截正文冒充全文。
  const readStore = { calls: [] }
  function readTool() {
    const entries = new Map()
    const add = (name, fn) => entries.set(name, { name, vendor: 'stub', def: { name, execute: fn }, options: {} })
    add('memory_read', async () => `【fact】长记忆\n\n${'正文一句。'.repeat(300)}`)
    add('nebula_inspect', async (a) => {
      readStore.calls.push(a.neighbors)
      const n = Number(a.neighbors ?? 12)
      let out = '## 连接到的记忆\n'
      for (let i = 0; i < n; i += 1) out += `- 邻居${i}（${'关联'.repeat(30)}）\n`
      return out
    })
    const bridge = {
      has: (n) => entries.has(n),
      get: (n) => entries.get(n),
      names: () => [...entries.keys()],
      awaitTool: async (n) => entries.get(n),
      async call(name, args) {
        const e = entries.get(name)
        if (!e) throw new Error(`stub 没有 ${name}`)
        const value = await e.def.execute(args)
        return { entry: e, def: e.def, value, text: typeof value === 'string' ? value : JSON.stringify(value) }
      },
      async tryCall(name, args) {
        try {
          return await bridge.call(name, args)
        } catch (err) {
          return { entry: undefined, def: undefined, value: undefined, text: `${name}未完成：${err.message}` }
        }
      },
      promptDeclarations: () => [],
    }
    return costTools({ bridge, config: { toolWaitMs: 10, linkWaitMs: 10 } }).find((t) => t.name === 'memory_read')
  }
  const readOne = readTool()
  const readRun = async (args) => String((await readOne.execute(args, {})) ?? '')

  const readFree = await readRun({ id: 'x' })
  check(
    'D71 读不给预算就是老样子：正文 + 邻居 + 成本尾注，不缩也不多说',
    readFree.includes('正文一句。') && readFree.includes('邻居11') && readFree.includes('成本 ≈'),
    readFree.slice(-110),
  )
  readStore.calls = []
  const readSkel = await readRun({ id: 'x', budget: 800 })
  check(
    'D72 正文都装不下就只给骨架：一个字都不裁给你，而且不去问星图（正文放不下，邻居是白花钱）',
    !readSkel.includes('正文一句。') &&
      readSkel.split('\n')[0] === '【fact】长记忆' &&
      readSkel.includes('截一半你会把它当成全文') &&
      readStore.calls.length === 0,
    `星图调用 ${readStore.calls.length} 次 · ${readSkel.slice(-150)}`,
  )
  check(
    'D73 骨架要报缺口并指路：正文多少字、≥多少才看得全、或者先搜摘要挑一条',
    readSkel.includes('正文共 ') && /把 budget 提到 ≥\d+/.test(readSkel) && readSkel.includes('memory_search 看摘要'),
    readSkel.split('\n')[2]?.slice(0, 90),
  )
  readStore.calls = []
  const readCut = await readRun({ id: 'x', budget: 2000 })
  check(
    'D74 正文装得下、邻居装不下：逐级砍邻居并交代砍到几条（正文一个字节没动）',
    readCut.includes('正文一句。') &&
      /邻居 12→\d+ 条才装下/.test(readCut) &&
      readStore.calls.length > 1 &&
      readStore.calls[0] === 12,
    `调用 ${JSON.stringify(readStore.calls)} · ${readCut.slice(-110)}`,
  )
  readStore.calls = []
  const readFit = await readRun({ id: 'x', budget: 4000 })
  check(
    'D75 装得下就一条都不砍：只问一次星图，尾注只说装下，不编「收紧了」',
    readFit.includes('邻居11') && readStore.calls.length === 1 && !readFit.includes('砍到'),
    `调用 ${JSON.stringify(readStore.calls)} · ${readFit.slice(-90)}`,
  )
  const readJunk = await readRun({ id: 'x', budget: 'abc' })
  const readSmall = await readRun({ id: 'x', budget: 10 })
  check(
    'D76 budget 的四种情形在读上也成立：不是数字 / 太小 → 按不限额给，但那句话必须带出来（不许悄悄忽略他给的数）',
    readJunk.includes('不是数字') && readJunk.includes('正文一句。') &&
      readSmall.includes('最小可用预算 80') && readSmall.includes('正文一句。'),
    `junk=${readJunk.slice(-60)} | small=${readSmall.slice(-60)}`,
  )
  readStore.calls = []
  const readZero = await readRun({ id: 'x', budget: 1600, neighbors: 0 })
  check(
    'D77 neighbors=0 时给预算也不去问星图：0 条本来就没东西可带',
    readZero.includes('正文一句。') && readStore.calls.length === 0,
    `调用 ${readStore.calls.length} 次 · ${readZero.slice(-80)}`,
  )

  if (process.env.PROBE_LINK === '1' && id) {
    // 星图靠 12s 巡检重建：等它把上面那条记忆建成节点，再验证 links 联动。
    const w3 = await run('memory_remember', {
      content: '探针记忆 2：带 links 写入，验证「写条目」与「星图连线」的联动。',
      project: '探针项目',
      keywords: ['探针', 'links', '联动', '星图连线', 'macro', 'memory', 'nebula', 'meow'],
      importance: 1,
      level: 'fact',
      links: [id],
    })
    const tailText = text(w3)
    check('D9 links 联动（连线或如实告知还没建图）', /星图连线|星图还建/.test(tailText), tailText.split('\n').slice(-1)[0])
  }
} catch (err) {
  check('D* 端到端未抛错', false, err.message)
}

// ── E. 退化与连线细节（不依赖 12s 巡检）──────────────────────────────
{
  const { createUnifiedTools } = await import(pathToFileURL(join(root, 'lib/macro/tools.js')).href)

  /** 造一个只有 meow、没有 nebula 的 bridge：用来验「星图没接上」时的说法。 */
  function stubBridge({ nebula }) {
    const calls = []
    const entries = new Map()
    const add = (name, fn) => entries.set(name, { name, vendor: 'stub', def: { name, execute: fn }, options: {} })
    add('memory_remember', async () => ({ id: 'mem-1' }))
    // 短 id 归一行走 meow 的 memory_read：stub 里一律「找得到」，返回同一个 id
    add('memory_read', async (args) => ({ found: true, id: String(args.id) }))
    if (nebula) {
      add('nebula_inspect', async (args) => ({
        id: args.id,
        neighbors: [args.neighbors],
        text: '## 连接到的记忆\n- node-x',
      }))
      add('nebula_link', async (args) => {
        calls.push(args)
        return { ok: true, action: args.action }
      })
    }
    const bridge = {
      has: (n) => entries.has(n),
      get: (n) => entries.get(n),
      names: () => [...entries.keys()],
      awaitTool: async (n) => entries.get(n),
      async call(name, args) {
        const e = entries.get(name)
        if (!e) throw new Error('not ready')
        const value = await e.def.execute(args)
        return { entry: e, def: e.def, value, text: typeof value === 'string' ? value : JSON.stringify(value) }
      },
      async tryCall(name, args, exec, ms, label) {
        try {
          return await bridge.call(name, args)
        } catch (err) {
          return { entry: undefined, def: undefined, value: undefined, text: `${label ?? name}未完成：${err.message}` }
        }
      },
      promptDeclarations: () => [],
    }
    return { bridge, calls }
  }

  // E1: 星图完全没接上 → 必须说「没接上」，不能糊成「等 12 秒」
  {
    const { bridge } = stubBridge({ nebula: false })
    const tool = createUnifiedTools({ bridge, config: { toolWaitMs: 10, linkWaitMs: 10 } }).find(
      (t) => t.name === 'memory_remember',
    )
    const out = await tool.execute({ content: 'x', project: 'p', keywords: ['a'], importance: 1, links: ['node-y'] }, {})
    check('E1 星图缺席时如实说「没接上」', out.includes('星图模块这次没接上'), out.split('\n').slice(-1)[0])
    check('E1 不再误报「等 12s 就好」', !out.includes('星图还没建到'), '')
  }

  // E2/E3: links 的 {id,note} 形态 → note 原样写进星图连线
  {
    const { bridge, calls } = stubBridge({ nebula: true })
    const tool = createUnifiedTools({ bridge, config: { toolWaitMs: 10, linkWaitMs: 10 } }).find(
      (t) => t.name === 'memory_remember',
    )
    const out = await tool.execute(
      { content: 'x', project: 'p', keywords: ['a'], importance: 1, links: [{ id: 'node-z', note: '同一次排查得出' }, 'node-w'] },
      {},
    )
    check('E2 连线真的调了 nebula_link（两条）', calls.length === 2, JSON.stringify(calls.map((c) => c.b)))
    check('E3 {id,note} 的 note 透传下去', calls[0]?.note === '同一次排查得出', String(calls[0]?.note))
    check('E3 字符串形态仍用默认 note', /macro-memory/.test(String(calls[1]?.note)), String(calls[1]?.note))
    check('E3 输出按条列结果', out.includes('星图连线'), out.split('\n')[0])
  }

  // E4: 本地检索缺 query 必须报错，不能静默空结果
  {
    const { bridge } = stubBridge({ nebula: false })
    const tool = createUnifiedTools({ bridge, config: {} }).find((t) => t.name === 'memory_search')
    let msg = ''
    try {
      await tool.execute({ query: '   ' }, {})
    } catch (err) {
      msg = String(err.message)
    }
    check('E4 本地检索缺 query 报得清楚', msg.includes('query'), msg.slice(0, 80))
  }
}

// ── CA. 星图「没接上」的两种情形必须分开说（0.2.72）─────────────────────
// 以前装配没完成 与 星图那边报错 压成同一句「星图这次没接上……等星图就绪再试一次就行」，
// 顺手把 ENOENT 这类原因吃掉——「库文件读不出来」于是被读成「等会儿就好」。
{
  const { createUnifiedTools } = await import(pathToFileURL(join(root, 'lib/macro/tools.js')).href)
  const { NOT_READY_MARK } = await import(pathToFileURL(join(root, 'lib/macro/contract.js')).href)
  const NOT_READY = `macro-memory：${NOT_READY_MARK}（对应子模块尚未装配完成，或被配置关闭），请稍后重试。`

  function stub({ missing = [], thrower = {} } = {}) {
    const gone = new Set(missing)
    const entries = new Map()
    const add = (name, fn) => entries.set(name, { name, vendor: 'stub', def: { name, execute: fn }, options: {} })
    for (const name of ['nebula_stats', 'nebula_hygiene', 'nebula_sources', 'nebula_ingest']) {
      add(name, async () => {
        if (thrower[name]) throw new Error(thrower[name])
        return 'STUB 面板正文'
      })
    }
    const bridge = {
      has: (n) => entries.has(n) && !gone.has(n),
      get: (n) => (gone.has(n) ? undefined : entries.get(n)),
      names: () => [...entries.keys()].filter((n) => !gone.has(n)),
      awaitTool: async (n) => (gone.has(n) ? undefined : entries.get(n)),
      async call(name, args) {
        const e = gone.has(name) ? undefined : entries.get(name)
        if (!e) throw new Error(NOT_READY)
        const value = await e.def.execute(args)
        return { entry: e, def: e.def, value, text: typeof value === 'string' ? value : JSON.stringify(value) }
      },
      async tryCall(name, args, exec, ms, label) {
        try {
          return await bridge.call(name, args)
        } catch (err) {
          return { entry: undefined, def: undefined, value: undefined, text: `${label ?? name}未完成：${err.message}` }
        }
      },
      promptDeclarations: () => [],
    }
    const admin = createUnifiedTools({ bridge, config: { toolWaitMs: 10, linkWaitMs: 10 } }).find(
      (t) => t.name === 'memory_admin',
    )
    return async (args) => {
      const r = await admin.execute(args, {})
      return String(r?.text ?? r)
    }
  }

  const MISSING = ['nebula_stats', 'nebula_hygiene', 'nebula_sources', 'nebula_ingest']

  // CA1/CA2: 装配没完成 → 说「还没装配好 + 去看配置」，不许再说「等星图就绪」
  {
    const run = stub({ missing: MISSING })
    const out = await run({ action: 'stats' })
    check('CA1 装配没完成时说「还没装配好」并指向配置', out.includes('还没装配好') && out.includes('星图插件'), out.split('\n')[1] ?? '')
    check('CA2 装配没完成时不再许诺「等星图就绪」', !out.includes('等星图就绪') && !out.includes('请稍后重试就行'), '')
  }

  // CA3/CA4: 星图在但报错 → 原因原样带出，且不许说成装配问题
  {
    const run = stub({ thrower: { nebula_stats: 'ENOENT: 读不到 nebula.db' } })
    const out = await run({ action: 'stats' })
    check('CA3 星图报错时把原因原样带出来', out.includes('ENOENT: 读不到 nebula.db'), out.split('\n')[1] ?? '')
    check('CA4 星图报错时不说成「还没装配好」', !out.includes('还没装配好') && !out.includes('等星图就绪'), '')
  }

  // CA5: 四个面板各自的那句 miss 还在（没被统一成一句空话）
  {
    const run = stub({ missing: MISSING })
    const seen = []
    for (const [action, args] of [
      ['stats', {}],
      ['hygiene', {}],
      ['sources', {}],
      ['ingest', { provider: 'p', items: [{ title: 'a' }] }],
    ]) {
      seen.push(await run({ action, ...args }))
    }
    const each = ['星图概况这会儿看不了', '记忆体检这会儿做不了', '记忆来源这会儿看不了', '这批外部记忆一条都没推进去']
    check('CA5 四个面板的 miss 各说各的', each.every((s, i) => seen[i].includes(s)), each.filter((s, i) => !seen[i].includes(s)).join(' | '))
  }

  // CA6: 星图正常时一个字都不加（别把降级话术粘在成功路径上）
  {
    const run = stub()
    const out = await run({ action: 'stats' })
    check('CA6 星图正常时不出现降级话术', out.includes('STUB 面板正文') && !out.includes('星图这次'), out.split('\n').join(' / '))
  }
}

// ── F. 待补连线队列：连不上的连线不能丢，读记忆时自动补 ──────────────────
{
  const { createUnifiedTools } = await import(pathToFileURL(join(root, 'lib/macro/tools.js')).href)
  const links = await import(pathToFileURL(join(root, 'lib/macro/links.js')).href)

  /** 清空队列，让每段各测各的。 */
  function resetQueue() {
    for (const e of links.readPending()) links.dropPending(e.a, e.b)
  }

  function stub({ linked, fail }) {
    const entries = new Map()
    const add = (name, fn) => entries.set(name, { name, vendor: 'stub', def: { name, execute: fn }, options: {} })
    add('memory_remember', async () => ({ id: 'mem-A' }))
    add('memory_search', async () => ({ hits: [{ id: 'mem-B' }], text: '命中 1 条' }))
    add('memory_read', async (args) => ({ found: !String(args.id).startsWith('gone-'), id: String(args.id) }))
    add('nebula_inspect', async (args) => ({ id: args.id, text: '## 连接到的记忆\n- node' }))
    add('nebula_link', async (args) => {
      if (fail) throw new Error('星图引擎正在建图')
      return linked ? `已固化连线：${args.a} ↔ ${args.b}` : '没找到节点'
    })
    add('nebula_path', async () => 'path ok')
    const bridge = {
      has: (n) => entries.has(n),
      get: (n) => entries.get(n),
      names: () => [...entries.keys()],
      awaitTool: async (n) => entries.get(n),
      async call(name, args) {
        const e = entries.get(name)
        if (!e) throw new Error('not ready')
        const value = await e.def.execute(args)
        return { entry: e, def: e.def, value, text: typeof value === 'string' ? value : JSON.stringify(value) }
      },
      async tryCall(name, args, exec, ms, label) {
        try {
          return await bridge.call(name, args)
        } catch (err) {
          return { entry: undefined, def: undefined, value: undefined, text: `${label ?? name}未完成：${err.message}` }
        }
      },
      promptDeclarations: () => [],
    }
    return { bridge, entries }
  }

  // F1: 写入时星图没接上 → 连线排队落盘，文案说「已排队」而不是让模型自己记着回来补
  resetQueue()
  {
    const { bridge, entries } = stub({ linked: true })
    entries.delete('nebula_inspect')
    entries.delete('nebula_link')
    const tool = createUnifiedTools({ bridge, config: { toolWaitMs: 10, linkWaitMs: 10, flushThrottleMs: 0 } }).find(
      (t) => t.name === 'memory_remember',
    )
    const out = await tool.execute({ content: 'x', project: 'p', keywords: ['a'], importance: 1, links: ['node-Q'] }, {})
    check('F1 星图缺席时连线排队', links.pendingCount() === 1, String(links.pendingCount()))
    check('F1 文案说明「已排队 + 会自动补」', out.includes('已排队') && out.includes('自动补连'), out.split('\n').slice(-1)[0])
  }

  // F2: 之后星图回来了 → 一次普通读操作就把队列补上（不需要模型记得）
  {
    const { bridge } = stub({ linked: true })
    const tool = createUnifiedTools({ bridge, config: { toolWaitMs: 10, linkWaitMs: 10, flushThrottleMs: 0 } }).find(
      (t) => t.name === 'memory_search',
    )
    await tool.execute({ query: 'x' }, {})
    check('F2 读记忆时自动补连、队列清空', links.pendingCount() === 0, String(links.pendingCount()))
  }

  // F3: 连线失败（引擎在建图）→ 留在队列里，不看运气
  resetQueue()
  {
    const { bridge } = stub({ linked: false, fail: true })
    const tool = createUnifiedTools({ bridge, config: { toolWaitMs: 10, linkWaitMs: 10, flushThrottleMs: 0 } }).find(
      (t) => t.name === 'memory_link',
    )
    const out = await tool.execute({ action: 'link', a: 'mem-A', b: 'mem-B', note: 'n' }, {})
    check('F3 memory_link 失败也排队，不吞掉', links.pendingCount() === 1, String(links.pendingCount()))
    check('F3 输出说明「已排队」', out.includes('已排队'), out.slice(0, 80))
  }

  // F4: memory_admin(action="links") 能看欠账，也能顺手补；坏了也不炸
  {
    const { bridge } = stub({ linked: false })
    const tool = createUnifiedTools({ bridge, config: { toolWaitMs: 10, linkWaitMs: 10, flushThrottleMs: 0 } }).find(
      (t) => t.name === 'memory_admin',
    )
    const waiting = await tool.execute({ action: 'links' }, {})
    check('F4 links 面板列出欠账', waiting.includes('待补连线：1 条'), waiting.split('\n')[0])
    check('F4 列出是哪一条', waiting.includes('mem-A') && waiting.includes('mem-B'), waiting.split('\n')[1])

    const okTool = createUnifiedTools({
      bridge: stub({ linked: true }).bridge,
      config: { toolWaitMs: 10, linkWaitMs: 10, flushThrottleMs: 0 },
    }).find((t) => t.name === 'memory_admin')
    const cleared = await okTool.execute({ action: 'links' }, {})
    check('F4 面板顺手补连后队列归零', links.pendingCount() === 0, cleared.split('\n')[0])
  }

  // F5: 坏行/空文件不炸（账本与队列都不能影响记忆主功能）
  resetQueue()
  {
    const { writeFileSync } = await import('node:fs')
    writeFileSync(links.pendingPath(), 'not-json\n{"a":"","b":"x"}\n', 'utf8')
    check('F5 坏行被跳过', links.readPending().length === 0, String(links.readPending().length))
    check('F5 面板不炸', typeof links.pendingReport() === 'string')
  }
  resetQueue()

  // F6: 短 id → 完整 id（meow 输出只给 8 位前缀，星图 resolveIds 只认完整 id）
  const FULL_A = '0mwmbucj-5c1f7c2e9a4b4f0d8e3a6b1c2d'
  const FULL_B = '0mwmbugf-1a2b3c4d5e6f708192a3b4c5d6'
  function stubShortId() {
    const entries = new Map()
    const calls = []
    const add = (name, fn) => entries.set(name, { name, vendor: 'stub', def: { name, execute: fn }, options: {} })
    add('memory_read', async (args) => {
      const raw = String(args.id)
      if (raw === FULL_A.slice(0, 8) || raw === FULL_A) return { found: true, id: FULL_A }
      if (raw === FULL_B.slice(0, 8) || raw === FULL_B) return { found: true, id: FULL_B }
      return { found: false }
    })
    add('nebula_inspect', async (args) => ({ id: args.id, text: '## 连接到的记忆\n- node' }))
    add('nebula_link', async (args) => {
      calls.push(args)
      return `已固化连线：${args.a} ↔ ${args.b}`
    })
    const bridge = {
      has: (n) => entries.has(n),
      get: (n) => entries.get(n),
      names: () => [...entries.keys()],
      awaitTool: async (n) => entries.get(n),
      async call(name, args) {
        const e = entries.get(name)
        if (!e) throw new Error('not ready')
        const value = await e.def.execute(args)
        return { entry: e, def: e.def, value, text: typeof value === 'string' ? value : JSON.stringify(value) }
      },
      async tryCall(name, args) {
        try {
          return await bridge.call(name, args)
        } catch (err) {
          return { entry: undefined, def: undefined, value: undefined, text: `未完成：${err.message}` }
        }
      },
      promptDeclarations: () => [],
    }
    return { bridge, calls }
  }
  {
    const { bridge, calls } = stubShortId()
    const tool = createUnifiedTools({ bridge, config: { toolWaitMs: 10, linkWaitMs: 10, flushThrottleMs: 0 } }).find(
      (t) => t.name === 'memory_link',
    )
    const out = await tool.execute({ action: 'link', a: FULL_A.slice(0, 8), b: FULL_B.slice(0, 8), note: 'n' }, {})
    check('F6 短 id 被补全成完整 id 再连线', calls[0]?.a === FULL_A && calls[0]?.b === FULL_B, JSON.stringify(calls[0]))
    check('F6 连线成功文案原样返回', out.includes('已固化连线'), out.slice(0, 60))
    check('F6 成功不排队', links.pendingCount() === 0, String(links.pendingCount()))
  }

  // F7: 永远连不上的（记忆已被删/合并）当场摘掉，不留在队列里烂 7 天
  resetQueue()
  {
    links.queuePending(FULL_A, 'gone-000000', 'n', '节点待入图')
    const { bridge } = stubShortId()
    const tool = createUnifiedTools({ bridge, config: { toolWaitMs: 10, linkWaitMs: 10, flushThrottleMs: 0 } }).find(
      (t) => t.name === 'memory_admin',
    )
    const out = await tool.execute({ action: 'links' }, {})
    check('F7 归不出完整 id 的条目被清掉', links.pendingCount() === 0, String(links.pendingCount()))
    check('F7 面板说明清掉了几条', out.includes('永远连不上'), out.split('\n').slice(-1)[0])
  }

  // F8: nebula 说「找不到这两条记忆」——这句有两种含义，按年龄分（0.2.30）。
  //     旧代码把这句一律当永久失败摘掉，于是「刚写完记忆、顺手连邻居」的连线白写：
  //     星图 12s 一轮巡检还没建到节点 → 回 404 → 队列清零，用户看不到任何报错。
  resetQueue()
  {
    const notFound = () => {
      const { bridge } = stubShortId()
      bridge.get('nebula_link').def.execute = async () => {
        throw new Error('找不到这两条记忆：x / y')
      }
      return bridge
    }
    const panel = async (bridge) => {
      const tool = createUnifiedTools({ bridge, config: { toolWaitMs: 10, linkWaitMs: 10, flushThrottleMs: 0 } }).find(
        (t) => t.name === 'memory_admin',
      )
      return tool.execute({ action: 'links' }, {})
    }

    // F8a 刚排进去（建图还没跑到）→ 必须留着
    links.queuePending(FULL_A, FULL_B, 'n', '节点待入图')
    await panel(notFound())
    check('F8 刚排队的「找不到」不当永久失败（节点还没建进图）', links.pendingCount() === 1, String(links.pendingCount()))

    // F8b 排队已超过宽限期（记忆真的没了）→ 摘掉，别让死条目占着队头
    writeFileSync(
      links.pendingPath(),
      `${JSON.stringify({ a: FULL_A, b: FULL_B, note: 'n', ts: Date.now() - links.MISSING_GRACE_MS - 1000, reason: '节点待入图' })}\n`,
      'utf8',
    )
    await panel(notFound())
    check('F8 过了宽限期还「找不到」才摘', links.pendingCount() === 0, String(links.pendingCount()))
  }
  // ── N. 补连预算是不是真的（0.2.28）────────────────────────────────────
  // 读路径承诺「宁可不补，也不把一次读拖成几十秒」。这个承诺以前只在注释里：
  // budgetMs 只在每条目开始前比一次，而 tryCall 的超时只管「等工具注册」，
  // 工具一旦注册好，execute 慢多久都照等。这里用慢桩把它钉住。
  {
    const slow = (ms, text) => async () => {
      await new Promise((r) => setTimeout(r, ms))
      return text
    }

    // N1: 单次 nebula_link 慢 800ms、预算 200ms → 必须掐断，不能等它跑完
    links.queuePending(FULL_A, FULL_B, 'n', '节点待入图')
    {
      const t0 = Date.now()
      const round = await links.flushPending({
        tryCall: async () => ({ entry: { name: 'nebula_link' }, text: await slow(800, '已固化连线')() }),
        isLinked: links.isLinkedText,
        budgetMs: 200,
        limit: 8,
      })
      const ms = Date.now() - t0
      check('N1 慢调用被预算掐断', round.stopped === 'budget', `${round.stopped} / ${ms}ms`)
      check('N1 掐断就不等它跑完（<700ms）', ms < 700, `${ms}ms`)
      check('N1 掐断的条目留在队列里', links.pendingCount() === 1, String(links.pendingCount()))
    }

    // N2: 短 id 归一（resolve → memory_read）慢，同样吃预算
    for (const e of links.readPending()) links.dropPending(e.a, e.b)
    links.queuePending(FULL_A, FULL_B, 'n', '节点待入图')
    {
      const t0 = Date.now()
      const round = await links.flushPending({
        tryCall: async () => ({ entry: { name: 'nebula_link' }, text: '已固化连线' }),
        isLinked: links.isLinkedText,
        resolve: slow(800, FULL_A),
        budgetMs: 200,
        limit: 8,
      })
      const ms = Date.now() - t0
      check('N2 归一 id 也走预算（不例外）', round.stopped === 'budget' && ms < 700, `${round.stopped} / ${ms}ms`)
      check('N2 归一超时不误判成永久失败', links.pendingCount() === 1, String(links.pendingCount()))
    }

    // N3: 快路径不受影响（别把预算做成一律少补）
    for (const e of links.readPending()) links.dropPending(e.a, e.b)
    links.queuePending(FULL_A, FULL_B, 'n', '节点待入图')
    {
      const round = await links.flushPending({
        tryCall: async () => ({ entry: { name: 'nebula_link' }, text: '已固化连线：A ↔ B' }),
        isLinked: links.isLinkedText,
        budgetMs: 1200,
        limit: 8,
      })
      check('N3 快的时候照常补上', round.linked === 1 && links.pendingCount() === 0, `${round.linked}/${links.pendingCount()}`)
      check('N3 快的时候不报预算', round.stopped === '', round.stopped)
    }

    // N4: 星图没接上 → 立刻停手，只探一次（不把队列当靶子打）
    links.queuePending(FULL_A, FULL_B, 'n', '节点待入图')
    links.queuePending(FULL_A, 'other-00000000', 'n', '节点待入图')
    {
      let probes = 0
      const round = await links.flushPending({
        tryCall: async () => {
          probes += 1
          return { entry: undefined, text: '未完成：这项能力还没就绪' }
        },
        isLinked: links.isLinkedText,
        budgetMs: 1200,
        limit: 8,
      })
      check('N4 星图没接上只探一次', probes === 1, String(probes))
      check('N4 停手后队列原样留着', round.stopped === 'unavailable' && links.pendingCount() === 2, `${round.stopped}/${links.pendingCount()}`)
    }

    // N5: 剩余预算连一条都不够 → 一个请求都不发
    {
      const round = await links.flushPending({
        tryCall: async () => ({ entry: { name: 'nebula_link' }, text: '已固化连线' }),
        isLinked: links.isLinkedText,
        budgetMs: links.MIN_STEP_MS - 10,
        limit: 8,
      })
      check('N5 预算不足一条就一个请求都不发', round.tried === 0 && round.stopped === 'budget', `${round.tried}/${round.stopped}`)
      check('N5 一条都没动，队列不动', links.pendingCount() === 2, String(links.pendingCount()))
    }
  }

  // ── O. graphState 三态：结构判「没接上」，措辞判「还没入图」（0.2.29）──────
  {
    const linkflow = await import(pathToFileURL(join(root, 'lib/macro/linkflow.js')).href)
    const fake = (tryCall) => linkflow.createLinkFlow({ bridge: { call: async () => ({}), tryCall }, config: { linkWaitMs: 100 } })

    // O1: 桥根本没拿到这个工具 → 结构判据 → unavailable，且立刻返回（不轮询）
    {
      let calls = 0
      const flow = fake(async () => {
        calls += 1
        return { entry: undefined, text: '未完成：这项能力还没就绪' }
      })
      const t0 = Date.now()
      const state = await flow.graphState('mem-x', {})
      check('O1 星图没接上判 unavailable（看结构不是看文案）', state === 'unavailable', `${state} / ${calls} 次`)
      check('O1 没接上就立刻返回，不轮询等 12 秒', calls === 1 && Date.now() - t0 < 500, `${calls} 次 / ${Date.now() - t0}ms`)
    }

    // O2: 星图回「星图里没有」→ 措辞判据 → 等到期限才判 pending（等得起，稍后再连）
    {
      let calls = 0
      const flow = fake(async () => {
        calls += 1
        return { entry: { name: 'nebula_inspect' }, text: '星图里没有 id=mem-x 的记忆。可以先用 nebula_recall 搜一下。' }
      })
      const t0 = Date.now()
      const state = await flow.graphState('mem-x', {}, 300)
      const ms = Date.now() - t0
      check('O2 还没入图判 pending（等得起）', state === 'pending', `${state} / ${calls} 次`)
      check('O2 pending 会重试到期限为止', calls >= 2 && ms >= 300 && ms < 1200, `${calls} 次 / ${ms}ms`)
    }

    // O3: 有内容 → ready
    {
      const flow = fake(async () => ({ entry: { name: 'nebula_inspect' }, text: '# 标题\n层级 fact · 连接 3' }))
      check('O3 有内容判 ready', (await flow.graphState('mem-x', {})) === 'ready')
    }

    // O4: 认措辞的边界要说清楚：换了说法我们认不出来，只会退化成「立刻去连」。
    //     这条断的不是「不会退化」，而是「退化点在哪」——vendor 一改措辞，verify 先红。
    check('O4 saysMissing 只认那一句，换了说法就认不出', linkflow.saysMissing('星图里没有 id=x 的记忆') === true && linkflow.saysMissing('not found') === false)
    check('O4 措辞常量与 vendor 源码同源（改词要改这一处）', linkflow.NODE_MISSING_MARK === '星图里没有', linkflow.NODE_MISSING_MARK)
  }

  // ── P. 同一句「找不到这两条记忆」有两种含义，按年龄分辨（0.2.30）──────────
  {
    const links = await import(pathToFileURL(join(root, 'lib/macro/links.js')).href)
    const linkflow = await import(pathToFileURL(join(root, 'lib/macro/linkflow.js')).href)
    const NOT_FOUND = '找不到这两条记忆：aaaa / bbbb'
    // 星图的 404 是 execute **抛错**，桥把它变成「entry undefined + 原话文本」——旧代码就栽在这个形状上
    const notFound = async () => ({ entry: undefined, text: NOT_FOUND })
    const seed = (ts) => writeFileSync(links.pendingPath(), `${JSON.stringify({ a: 'aaaa', b: 'bbbb', note: '', ts, reason: '节点待入图' })}\n`, 'utf8')
    const round = (tryCall, budgetMs = 2000) =>
      links.flushPending({ tryCall, isLinked: links.isLinkedText, resolve: async (id) => id, exec: {}, budgetMs, limit: 5 })

    // P1 刚排进去 1 秒：建图一轮 12s 还没跑到它 → 必须留着
    seed(Date.now() - 1000)
    const r1 = await round(notFound)
    check('P1 刚排队就报「找不到」不当永久失败', r1.dropped === 0 && r1.left === 1, `dropped=${r1.dropped} left=${r1.left}`)

    // P2 过了宽限期仍然是「找不到」→ 真的没了，摘掉（否则死条目占着队头不走）
    seed(Date.now() - links.MISSING_GRACE_MS - 1000)
    const r2 = await round(notFound)
    check('P2 过了宽限期还「找不到」就摘掉', r2.dropped === 1 && r2.left === 0, `dropped=${r2.dropped} left=${r2.left}`)

    // P3 自己连自己：换多少时间都一样，年轻的也当场摘
    seed(Date.now() - 1000)
    const r3 = await round(async () => ({ entry: undefined, text: '不能把一条记忆和它自己配成一对：aaaa' }))
    check('P3 「自己连自己」不管多年轻都当场摘', r3.dropped === 1 && r3.left === 0, `dropped=${r3.dropped}`)

    // P4 写路径：刚写完就顺手连线、星图还没建到 → 必须排队，不能只回一句「找不到」
    {
      const bridge = {
        async call(name) {
          if (name === 'memory_read') return { entry: { name }, value: { found: true, id: 'f'.repeat(36) } }
          if (name === 'nebula_inspect') return { entry: { name }, text: '# 某条记忆\n层级 fact · 连接 3' }
          return { entry: { name }, text: NOT_FOUND }
        },
        async tryCall(name, args, exec, wait, label) {
          try {
            return await this.call(name, args)
          } catch (e) {
            return { entry: undefined, text: String(e?.message ?? e) }
          }
        },
      }
      resetQueue()
      const flow = linkflow.createLinkFlow({ bridge, config: { linkWaitMs: 100 } })
      const said = await flow.applyLinks('f'.repeat(36), [{ id: 'e'.repeat(36), note: 'n' }], {}, '测试')
      check('P4 写路径遇到「还没建进图」要排队，不能丢用户的 links', links.readPending().length === 1, `${links.readPending().length} 条`)
      check('P4 文案照实说「还没建到」，不赖用户 id 写错', said.includes('还没建到') && !said.includes('写错'), String(said.split('\n')[1] ?? '').slice(0, 60))
    }

    // P5 桥没接上（工具都没拿到）→ 停手，队列原样，不误摘
    seed(Date.now() - 1000)
    const r5 = await round(async () => ({ entry: undefined, text: 'macro-memory：这项能力还没就绪（对应子模块尚未装配完成或被配置关闭），请稍后重试。' }))
    check('P5 星图没接上就停手，队列原样', r5.stopped === 'unavailable' && r5.left === 1 && r5.dropped === 0, `${r5.stopped} / left=${r5.left}`)

    // P6 连线阶段被预算掐断：这条根本没动过手，tried 不许虚报（0.2.28 的语义要贯彻到每个分支）
    seed(Date.now())
    const r6 = await round(() => new Promise((r) => setTimeout(() => r({ entry: {}, text: '已固化连线：a ↔ b' }), 800)), 200)
    check('P6 连线被预算掐断时 tried 不虚报', r6.stopped === 'budget' && r6.tried === 0, `tried=${r6.tried} stopped=${r6.stopped}`)
  }

  // ── Q. 前台写路径也有期限：用户在等的那条路不能跟着星图建图一起挂（0.2.31）──
  {
    const links = await import(pathToFileURL(join(root, 'lib/macro/links.js')).href)
    const linkflow = await import(pathToFileURL(join(root, 'lib/macro/linkflow.js')).href)
    const { createLink } = await import(pathToFileURL(join(root, 'lib/macro/defs/link.js')).href)
    const FULL = (c) => c.repeat(36)
    const sleep = (ms, v) => new Promise((r) => setTimeout(() => r(v), ms))

    /** delay>0 时 nebula_link 慢得像在建图；delay=0 就是正常星图。 */
    const bridgeOf = (delay) => ({
      async call(name) {
        if (name === 'memory_read') return { entry: { name }, value: { found: true, id: FULL('a') } }
        if (name === 'nebula_inspect') return { entry: { name }, text: '# 某条记忆\n层级 fact · 连接 0' }
        if (name === 'nebula_path') return { entry: { name }, text: delay > 0 ? await sleep(delay, '证据链') : '证据链' }
        return { entry: { name }, text: delay > 0 ? await sleep(delay, '已固化连线：a ↔ b') : '已固化连线：a ↔ b' }
      },
      async tryCall(name, args) {
        try {
          return await this.call(name, args)
        } catch (e) {
          return { entry: undefined, text: String(e?.message ?? e) }
        }
      },
    })

    // Q1 记忆写入时的顺手连线：星图 800ms 不回、期限 200ms → 墙钟必须受控，条目必须留
    {
      resetQueue()
      const flow = linkflow.createLinkFlow({ bridge: bridgeOf(800), config: { linkWaitMs: 100, linkCallMs: 200, flushThrottleMs: 0 } })
      const t0 = Date.now()
      const said = await flow.applyLinks(FULL('a'), [{ id: FULL('b'), note: 'n' }], {}, '测试')
      const ms = Date.now() - t0
      check('Q1 写路径连线超时按期限掐断，不跟着星图挂', ms < 500, `${ms}ms`)
      check('Q1 掐断后条目留队，用户填的 links 不丢', links.readPending().length === 1, `${links.readPending().length} 条`)
      check('Q1 文案说清「没回应」而不是「连不上」', said.includes('没回应') && !said.includes('写错'), String(said.split('\n')[1] ?? '').slice(0, 60))
    }

    // Q2 前台 memory_link：同一个期限，同一个结论（排队，不报失败）
    {
      resetQueue()
      const flow = linkflow.createLinkFlow({ bridge: bridgeOf(800), config: { linkWaitMs: 100, linkCallMs: 200, flushThrottleMs: 0 } })
      const tool = createLink({ flow })
      const t0 = Date.now()
      const said = await tool.execute({ action: 'link', a: FULL('a'), b: FULL('b'), note: 'n' }, {})
      const ms = Date.now() - t0
      check('Q2 memory_link 前台调用也被期限包住', ms < 500, `${ms}ms`)
      check('Q2 超时的连线进队列', links.readPending().length === 1, `${links.readPending().length} 条`)
      check('Q2 文案带上真实的期限数字', said.includes('200 毫秒') || said.includes('秒内没回应'), String(said).slice(0, 40))
    }

    // Q3 快路径一个字都不许变：星图正常回话时，照旧是星图的原话，队列不留欠账
    {
      resetQueue()
      const flow = linkflow.createLinkFlow({ bridge: bridgeOf(0), config: { linkWaitMs: 100, linkCallMs: 2000, flushThrottleMs: 0 } })
      const tool = createLink({ flow })
      const said = await tool.execute({ action: 'link', a: FULL('a'), b: FULL('b'), note: 'n' }, {})
      check('Q3 正常路径原样转述星图的话', String(said).includes('已固化连线'), String(said).slice(0, 30))
      check('Q3 正常路径不留欠账', links.readPending().length === 0, `${links.readPending().length} 条`)
    }

    // Q4 path 是只读的：超时只要说清楚「这次没做成」，不许进队列（它会随每次读重试，越积越多）
    {
      resetQueue()
      const flow = linkflow.createLinkFlow({ bridge: bridgeOf(800), config: { linkWaitMs: 100, linkCallMs: 200, flushThrottleMs: 0 } })
      const tool = createLink({ flow })
      const t0 = Date.now()
      const said = await tool.execute({ action: 'path', a: FULL('a'), b: FULL('b') }, {})
      const ms = Date.now() - t0
      check('Q4 path 超时也受期限约束', ms < 500, `${ms}ms`)
      check('Q4 path 超时不留队列欠账', links.readPending().length === 0, `${links.readPending().length} 条`)
      check('Q4 path 文案说「记忆没受影响」', said.includes('记忆本身没受影响'), String(said).slice(0, 40))
    }

    // Q5 哨兵不许外泄：调用方只能通过谓词问，永远拿不到 Symbol 本身
    {
      const cut = await links.withBudget(new Promise(() => {}), 50)
      check('Q5 isTimedOut 只认掐断，别的东西一律 false', links.isTimedOut(cut) === true && links.isTimedOut({ entry: undefined, text: '' }) === false && links.isTimedOut(null) === false)
      check('Q5 默认期限是 20 秒（比建图一轮 12s 松，比「挂几十秒」紧）', links.LINK_CALL_MS === 20000, String(links.LINK_CALL_MS))
    }

    // Q6 期限说得出口：20000 要写成「20 秒」，200 不能写成「0 秒」
    {
      check('Q6 期限文案不出现「0 秒」', links.describeMs(200) === '200 毫秒' && links.describeMs(20000) === '20 秒', `${links.describeMs(200)} / ${links.describeMs(20000)}`)
    }

    // ── R. 一批连线：条数 + 总时长两道闸，超出的排队，一条都不许悄悄消失（0.2.32）──
    {
      // R1: 给 15 条，单批最多 12 条 → 多的 3 条必须进队列，文案要说清
      {
        resetQueue()
        const flow = linkflow.createLinkFlow({ bridge: bridgeOf(0), config: { linkWaitMs: 100, linkCallMs: 2000, flushThrottleMs: 0 } })
        const list = Array.from({ length: 15 }, (_, i) => ({ id: FULL(String.fromCharCode(98 + i)), note: `n${i}` }))
        const said = await flow.applyLinks(FULL('a'), list, {}, '测试')
        const done = said.split('\n').filter((l) => l.endsWith('已连上')).length
        check('R1 单批当场最多连 LINKS_PER_WRITE 条', done === 12, `${done} 条`)
        check('R1 多出来的 3 条进队列，不许消失', links.readPending().length === 3, `${links.readPending().length} 条`)
        check('R1 文案说清「多出来的已排队」', said.includes('多出来的 3 条已排队'), String(said.split('\n').pop()).slice(0, 60))
      }

      // R2: 一批的总时长也有限：6 条各 200ms、总账 500ms → 墙钟受控，剩下的排队
      {
        resetQueue()
        const flow = linkflow.createLinkFlow({ bridge: bridgeOf(200), config: { linkWaitMs: 100, linkCallMs: 5000, linkBatchMs: 500, flushThrottleMs: 0 } })
        const list = Array.from({ length: 6 }, (_, i) => ({ id: FULL(String.fromCharCode(98 + i)), note: `n${i}` }))
        const t0 = Date.now()
        const said = await flow.applyLinks(FULL('a'), list, {}, '测试')
        const ms = Date.now() - t0
        const done = said.split('\n').filter((l) => l.endsWith('已连上')).length
        check('R2 一批的总时长受 linkBatchMs 约束', ms < 900, `${ms}ms / 连上 ${done} 条`)
        check('R2 没轮到的进队列，一条不丢', links.readPending().length === 6 - done, `${links.readPending().length} 条`)
        check('R2 文案说清「整批最多连多久」', said.includes('整批最多连 500 毫秒'), String(said.split('\n').pop()).slice(0, 60))
      }

      // R3: 正常路径一个字不变：3 条快连，队列 0、不出现「排队」
      {
        resetQueue()
        const flow = linkflow.createLinkFlow({ bridge: bridgeOf(0), config: { linkWaitMs: 100, linkCallMs: 2000, flushThrottleMs: 0 } })
        const list = Array.from({ length: 3 }, (_, i) => ({ id: FULL(String.fromCharCode(98 + i)), note: `n${i}` }))
        const said = await flow.applyLinks(FULL('a'), list, {}, '测试')
        check('R3 正常路径三条都连上', said.split('\n').filter((l) => l.endsWith('已连上')).length === 3)
        check('R3 正常路径不进队列、也不多说一句', links.readPending().length === 0 && !said.includes('排队'), String(said.split('\n').pop()).slice(0, 40))
      }

      // R4: 星图还没建到节点时，排队这条路也不许有上限：15 条全部留下
      {
        resetQueue()
        const bridge = {
          async call(name) {
            if (name === 'memory_read') return { entry: { name }, value: { found: true, id: FULL('a') } }
            if (name === 'nebula_inspect') return { entry: { name }, text: '星图里没有 id=mem-x 的记忆。可以先用 nebula_recall 搜一下。' }
            return { entry: { name }, text: '已固化连线：a ↔ b' }
          },
          async tryCall(name, args) {
            return this.call(name, args)
          },
        }
        const flow = linkflow.createLinkFlow({ bridge, config: { linkWaitMs: 50, linkCallMs: 2000, flushThrottleMs: 0 } })
        const list = Array.from({ length: 15 }, (_, i) => ({ id: FULL(String.fromCharCode(98 + i)), note: `n${i}` }))
        const said = await flow.applyLinks(FULL('a'), list, {}, '测试')
        check('R4 星图没就绪时 15 条全排队（这条路上不设条数上限）', links.readPending().length === 15, `${links.readPending().length} 条`)
        check('R4 排队文案给的是真数', said.includes('关联已排队 15 条'), String(said).slice(0, 40))
      }

      // R5: 两个闸都是常量、都能被 config 覆盖，且能读回来
      {
        const flow = linkflow.createLinkFlow({ bridge: bridgeOf(0), config: { linksPerWrite: 3, linkBatchMs: 1234 } })
        check('R5 两条闸的默认值', links.LINKS_PER_WRITE === 12 && links.LINK_BATCH_MS === 30000, `${links.LINKS_PER_WRITE}/${links.LINK_BATCH_MS}`)
        check('R5 两条闸都能从 config 覆盖并读回', flow.linksPerWrite === 3 && flow.linkBatchMs === 1234, `${flow.linksPerWrite}/${flow.linkBatchMs}`)
      }

      // R6: 单条比整批总账还慢时，也必须按整批掐断——不能「第一条就吃掉全部预算还多挂两秒」
      {
        resetQueue()
        const flow = linkflow.createLinkFlow({ bridge: bridgeOf(2000), config: { linkWaitMs: 100, linkCallMs: 5000, linkBatchMs: 400, flushThrottleMs: 0 } })
        const list = [{ id: FULL('b'), note: 'n0' }, { id: FULL('c'), note: 'n1' }]
        const t0 = Date.now()
        const said = await flow.applyLinks(FULL('a'), list, {}, '测试')
        const ms = Date.now() - t0
        check('R6 单条比整批总账慢时按整批掐断', ms < 900, `${ms}ms`)
        check('R6 掐断后两条都在队列里', links.readPending().length === 2, `${links.readPending().length} 条`)
        check('R6 文案里的期限是整批的剩余，不是单条的 5 秒', said.includes('400 毫秒') && !said.includes('5 秒'), String(said.split('\n').pop()).slice(0, 60))
      }
    }
  }

  // ── S. 面板口径：理由只有一份、按理由分组、面板不写数（0.2.33）──
  {
    const links = await import(pathToFileURL(join(root, 'lib/macro/links.js')).href)
    const linkflow = await import(pathToFileURL(join(root, 'lib/macro/linkflow.js')).href)
    const { createUnifiedTools } = await import(pathToFileURL(join(root, 'lib/macro/tools.js')).href)
    const sleep = (ms, v) => new Promise((r) => setTimeout(() => r(v), ms))
    const FULL = (c) => String(c).repeat(36)
    const R = links.PENDING_REASONS
    const clear = () => {
      for (const e of links.readPending()) links.dropPending(e.a, e.b)
    }
    /** delay>0 时 nebula_link 慢得像在建图。 */
    const bridgeOf = (delay) => ({
      async call(name) {
        if (name === 'memory_read') return { entry: { name }, value: { found: true, id: FULL('a') } }
        if (name === 'nebula_inspect') return { entry: { name }, text: '# 某条记忆\n层级 fact · 连接 0' }
        return { entry: { name }, text: delay > 0 ? await sleep(delay, '已固化连线：a ↔ b') : '已固化连线：a ↔ b' }
      },
      async tryCall(name, args) {
        try {
          return await this.call(name, args)
        } catch (e) {
          return { entry: undefined, text: String(e?.message ?? e) }
        }
      },
    })
    const panelOf = (bridge, config) =>
      createUnifiedTools({ bridge, config: { toolWaitMs: 10, linkWaitMs: 50, flushThrottleMs: 0, ...config } }).find(
        (t) => t.name === 'memory_admin',
      )

    // S1 理由表只有一份：五个键、值互不相同、面板顺序覆盖全部
    {
      const vals = Object.values(R)
      check('S1 理由表五个键齐全且值不重复', vals.length === 5 && new Set(vals).size === 5, JSON.stringify(vals))
      check(
        'S1 面板顺序覆盖全部理由',
        links.REASON_ORDER.length === 5 && vals.every((v) => links.REASON_ORDER.includes(v)),
        String(links.REASON_ORDER.length),
      )
    }

    // S2 面板多一行「按理由」的账：顺序固定，旧写法的理由照原样单列、不吞
    {
      clear()
      links.queuePending(FULL('a'), FULL('b'), '', R.slow)
      links.queuePending(FULL('c'), FULL('d'), '', R.deferred)
      links.queuePending(FULL('e'), FULL('f'), '', 'memory_link 失败待重试')
      const text = links.pendingReport(20)
      const line = text.split('\n').find((l) => l.startsWith('按理由：')) ?? ''
      check('S2 面板先给一句「按理由」的账', line.length > 0, String(text.split('\n')[1] ?? ''))
      check('S2 已知理由按固定顺序（没轮到的排在慢之前）', line.includes(R.deferred) && line.indexOf(R.deferred) < line.indexOf(R.slow), line)
      check(
        'S2 旧写法的理由照原样单列在已知之后，不吞',
        line.includes('memory_link 失败待重试') && line.indexOf(R.slow) < line.indexOf('memory_link 失败待重试'),
        line,
      )
      clear()
      const empty = links.pendingReport(20)
      check('S2 空队列只说一句 0 条，不加「按理由」', empty.includes('0 条') && !empty.includes('按理由'), empty)
    }

    // S3 面板不写数：预算与条数取 flow 配置；掐断时说清「还剩几条」
    {
      clear()
      links.queuePending(FULL('a'), FULL('b'), '', R.notBuilt)
      links.queuePending(FULL('c'), FULL('d'), '', R.notBuilt)
      const tool = panelOf(bridgeOf(600), { panelBudgetMs: 300, panelLimit: 20 })
      const t0 = Date.now()
      const out = await tool.execute({ action: 'links' }, {})
      const ms = Date.now() - t0
      check('S3 面板补连按 panelBudgetMs 掐断，不跟着星图挂', ms < 1200, `${ms}ms`)
      check('S3 掐断后说清还剩几条', out.includes('还剩 2 条'), String(out.split('\n').pop()).slice(0, 80))
      check('S3 面板按理由分组给出条数', out.includes(`${R.notBuilt} 2`), String(out.split('\n')[1] ?? ''))
      // 0.2.36：被掐断时得看得出「被什么掐的」——1.5 秒还是 20 条，两个数都要在抬头里
      check(
        'S3 面板说清这一轮的上限（时间与条数都来自 config）',
        String(out.split('\n')[0]).includes('300 毫秒') && String(out.split('\n')[0]).includes('20 条'),
        String(out.split('\n')[0]).slice(0, 90),
      )
    }

    // S5 队列为空也把这一轮的上限说出来（空队列不是「没预算」）
    {
      clear()
      const tool = panelOf(bridgeOf(50), { panelBudgetMs: 800 })
      const out = await tool.execute({ action: 'links' }, {})
      const head = String(out.split('\n')[0] ?? '')
      check('S5 空队列也说清这一轮的上限', head.includes('800 毫秒') && head.includes('20 条'), head.slice(0, 90))
      check('S5 空队列不冒充「有预算在用」', !head.includes('用完') && !out.includes('用完'), head.slice(0, 90))
    }

    // S4 两条出口各用自己的数：后台 flushBudgetMs / 面板 panelBudgetMs / 轮询 pollStepMs
    {
      clear()
      links.queuePending(FULL('a'), FULL('b'), '', R.notBuilt)
      const flow = linkflow.createLinkFlow({
        bridge: bridgeOf(600),
        config: { flushBudgetMs: 100, panelBudgetMs: 800, flushLimit: 8, panelLimit: 7, pollStepMs: 40, linkCallMs: 5000 },
      })
      const t0 = Date.now()
      await flow.flushLinks({})
      const back = Date.now() - t0
      check('S4 后台补连用 flushBudgetMs，到点就收手', back < 400, `${back}ms`)
      check('S4 后台掐断后条目还在队列里', links.readPending().length === 1, String(links.readPending().length))
      check(
        'S4 两套数各归各的，都能读回',
        flow.flushBudgetMs === 100 && flow.panelBudgetMs === 800 && flow.flushLimit === 8 && flow.panelLimit === 7 && flow.pollStepMs === 40,
        `${flow.flushBudgetMs}/${flow.panelBudgetMs}/${flow.flushLimit}/${flow.panelLimit}/${flow.pollStepMs}`,
      )
    }

    // ── T. path 的四种回答要分辨：两种是「还没算」，一种是「算完了没关系」（0.2.37）──
    {
      const contract = await import(pathToFileURL(join(root, 'lib/macro/contract.js')).href)
      const { createLink } = await import(pathToFileURL(join(root, 'lib/macro/defs/link.js')).href)

      /** 星图原话 → 我们回给用户的话。别的动作（link/unlink/mute）也得照样原样转述。 */
      const sayPath = async (text) => {
        const flow = linkflow.createLinkFlow({
          bridge: {
            async call(name) {
              return { entry: { name }, text }
            },
            async tryCall(name, args) {
              return this.call(name, args)
            },
          },
          config: { linkWaitMs: 100, linkCallMs: 2000, flushThrottleMs: 0 },
        })
        const tool = createLink({ flow })
        return { said: String(await tool.execute({ action: 'path', a: FULL('a'), b: FULL('b') }, {})), tool, flow }
      }

      // T1 归类表：四种原话各认各的，认错了整条链路都白做
      const kinds = [
        ['找不到这两个节点：a / b', 'missing'],
        ['节点不在当前星图里', 'missing'],
        ['这个引擎版本还没带上路径搜索（等宿主重启后生效）', 'engineStale'],
        ['这两条记忆在星图里没有连上（超过 6 跳）。没有关系就不编关系。', 'unrelated'],
        ['a → b（1 跳）\n每一步都来自建图时算出的边', 'ok'],
      ]
      const wrong = kinds.filter(([text, want]) => contract.pathAnswerKind(text) !== want)
      check('T1 四类回答各归各的（顺序对了才不会把「没算」判成结论）', wrong.length === 0, wrong.map(([t, w]) => `${w}:${t.slice(0, 8)}`).join(' / ') || `${kinds.length}/${kinds.length}`)
      check(
        'T1 拼接文本先认「没入图」（顺序即判据）',
        contract.pathAnswerKind(`找不到这两个节点：a / b。没有关系就不编关系。`) === 'missing',
        contract.pathAnswerKind(`找不到这两个节点：a / b。没有关系就不编关系。`),
      )

      // T2 「还没建到」不许说成「没关系」，并且要把「等一轮」说出口
      {
        resetQueue()
        for (const text of ['找不到这两个节点：a / b', '节点不在当前星图里']) {
          const { said } = await sayPath(text)
          check(`T2 「${text.slice(0, 6)}」不冒充结论`, !said.includes('没有关系就不编关系') && said.includes('这不是「没关系」的答案'), said.slice(0, 40))
          check(`T2 「${text.slice(0, 6)}」说清等一轮再问`, said.includes('12s') && said.includes('再问一次'), said.slice(-30))
        }
      }

      // T3 真没关系照原样转述：星图的答案就是答案，我们只补上下文、不改结论
      {
        resetQueue()
        const text = '这两条记忆在星图里没有连上（超过 6 跳）。没有关系就不编关系。'
        const { said } = await sayPath(text)
        check('T3 真没关系原样转述（不替星图下结论）', said.includes('没有关系就不编关系'), said.slice(0, 40))
        check('T3 成功路径也原样转述', (await sayPath('a → b\n每一步都来自建图时算出的边')).said.includes('每一步都来自建图时算出的边'))
      }

      // T4 旧引擎那条要指出去处（重启宿主），不能说成「没关系」
      {
        resetQueue()
        const { said } = await sayPath('这个引擎版本还没带上路径搜索（等宿主重启后生效）')
        check('T4 旧引擎说清「要重启宿主」而不是「没关系」', said.includes('重启') && !said.includes('没有关系就不编关系'), said.slice(0, 40))
      }

      // T6 (0.2.45)：vendor 换新文案之后，四句还得各归各的——图空着不能被认成「节点没入图」
      {
        const P_EMPTY = '星图里还没有节点（图是空的），这次 nebula_path 等于没算——这不是「这两条记忆没有关系」。等星图建起来（约 12s 一轮巡检）再问一次；记忆本身没受影响。'
        const P_MISSING = '这次没算成：找不到这两个节点：a / b（图里现在有 3 条节点）。这不等于「这两条记忆没有关系」——可能是刚写还没入图（约 12s 一轮巡检），也可能 id 不对（裸 id 给前 12 位就够）。等一轮再问一次就行。'
        const P_STALE = '这次没算成：这个引擎版本还没带上路径搜索（等宿主重启后生效）。这不是「这两条记忆没有关系」——重启宿主后再问一次就行，记忆本身没受影响。'
        const P_UNRELATED = '这两条记忆在星图里确实没有连上：6 跳以内一条可走的边都没有（图里现有 3 条节点）。没有关系就不编关系。'
        const four = [
          [P_EMPTY, 'emptyGraph'],
          [P_MISSING, 'missing'],
          [P_STALE, 'engineStale'],
          [P_UNRELATED, 'unrelated'],
        ]
        const bad = four.filter(([text, want]) => contract.pathAnswerKind(text) !== want)
        check('T6 新文案四句各归各的（图空着不等于「节点没入图」）', bad.length === 0, bad.map(([t, w]) => `${w}:${t.slice(0, 10)}`).join(' / ') || '4/4')
        check(
          'T6 「确实没关系」是唯一带结论的那一句',
          four.filter(([text]) => text.includes('没有关系就不编关系')).length === 1 &&
            P_UNRELATED.includes('没有关系就不编关系'),
          '结论句只有 1 句',
        )

        // T7：memory_link(action="path") 拿新文案时的两条翻译都不许冒充结论
        resetQueue()
        const saidEmpty = (await sayPath(P_EMPTY)).said
        check('T7 图空着时原样转述并说「没算」', saidEmpty.includes('等于没算') && !saidEmpty.includes('没有关系就不编关系'), saidEmpty.slice(0, 40))
        const saidMissing = (await sayPath(P_MISSING)).said
        check(
          'T7 新「没算成」文案仍被翻成「还没建到这两条记忆」',
          saidMissing.includes('还没建到这两条记忆') && !saidMissing.includes('没有关系就不编关系'),
          saidMissing.slice(0, 40),
        )
        const saidStale = (await sayPath(P_STALE)).said
        check('T7 新「引擎旧」文案仍指出去处（重启宿主）', saidStale.includes('重启') && !saidStale.includes('没有关系就不编关系'), saidStale.slice(0, 40))
        check('T7 翻译路径不写队列（只读语义不变）', links.readPending().length === 0, `${links.readPending().length} 条`)
      }

      // T5 path 全程只读：三条翻译路径都不许往队列里塞欠账
      {
        resetQueue()
        for (const text of ['找不到这两个节点：a / b', '节点不在当前星图里', '这个引擎版本还没带上路径搜索']) await sayPath(text)
        check('T5 翻译不改只读语义：队列一条都不许涨', links.readPending().length === 0, `${links.readPending().length} 条`)
      }
    }
  }

  resetQueue()
}

// ── G. 星图缺席时的降级：以 meow 为主，记忆照样要能查 ────────────────────
{
  const { createUnifiedTools } = await import(pathToFileURL(join(root, 'lib/macro/tools.js')).href)
  const links = await import(pathToFileURL(join(root, 'lib/macro/links.js')).href)
  for (const e of links.readPending()) links.dropPending(e.a, e.b)

  /** 只有 meow、没有星图：nebula 没装配 / 被配置关掉 / 引擎还没起。 */
  function meowOnly({ similar = true } = {}) {
    const entries = new Map()
    const add = (name, fn) => entries.set(name, { name, vendor: 'stub', def: { name, execute: fn }, options: {} })
    add('memory_search', async () => '本地命中 1 条：mem-B')
    add('memory_read', async (args) => ({ found: true, id: String(args.id) }))
    if (similar) add('memory_find_similar', async () => '相似 1 条：mem-C')
    const bridge = {
      has: (n) => entries.has(n),
      get: (n) => entries.get(n),
      names: () => [...entries.keys()],
      awaitTool: async (n) => entries.get(n),
      async call(name, args) {
        const e = entries.get(name)
        if (!e) throw new Error('macro-memory：这项能力还没就绪')
        const value = await e.def.execute(args)
        return { entry: e, def: e.def, value, text: typeof value === 'string' ? value : JSON.stringify(value) }
      },
      async tryCall(name, args, exec, ms, label) {
        try {
          return await bridge.call(name, args)
        } catch (err) {
          return { entry: undefined, def: undefined, value: undefined, text: `${label ?? name}未完成：${err.message}` }
        }
      },
      promptDeclarations: () => [],
    }
    return { bridge }
  }

  const cfg = { toolWaitMs: 10, linkWaitMs: 10, flushThrottleMs: 0 }
  const tools = createUnifiedTools({ bridge: meowOnly().bridge, config: cfg })
  const tool = (n) => tools.find((t) => t.name === n)

  // G1/G2: 星图缺席 → graph/bridge 都不能报错，退回本地检索并说清为什么
  {
    const out = await tool('memory_search').execute({ mode: 'graph', query: '拼接' }, {})
    check('G1 星图缺席时 mode=graph 退回本地检索', out.includes('星图这次没接上') && out.includes('本地命中 1 条'), out.split('\n')[0])
    check('G1 不把「能力还没就绪」原样甩给模型', !out.includes('这项能力还没就绪'), '')
    const out2 = await tool('memory_search').execute({ mode: 'bridge', query: '拼接' }, {})
    check('G2 星图缺席时 mode=bridge 同样退回', out2.includes('星图这次没接上') && out2.includes('本地命中 1 条'), out2.split('\n')[0])
  }

  // G3: 没 query 时 mode=graph 只扩散——退回不了，但要说清怎么兜
  {
    const out = await tool('memory_search').execute({ mode: 'graph' }, {})
    check('G3 没 query 时讲清「给个 query 就能本地兜住」', out.includes('给个 query'), out.slice(0, 80))
  }

  // G4/G5: similar 走的是 meow 自己的工具，星图缺席无关；工具缺了也不能崩
  {
    const out = await tool('memory_search').execute({ mode: 'similar', id: 'mem-A' }, {})
    check('G4 mode=similar 不依赖星图', out.includes('相似 1 条'), out.slice(0, 60))
    const bare = createUnifiedTools({ bridge: meowOnly({ similar: false }).bridge, config: cfg })
    let msg = ''
    try {
      msg = await bare.find((t) => t.name === 'memory_search').execute({ mode: 'similar', id: 'mem-A' }, {})
    } catch (err) {
      msg = `THREW:${err.message}`
    }
    check('G5 similar 工具缺席时给说法而不是崩', !msg.startsWith('THREW:') && msg.includes('相似检索未完成'), msg.slice(0, 60))
  }

  // G6/G7: 改星图自己的动作（unlink/mute/path）缺席时说法要落到「记忆没受影响」；只有 link 能排队
  {
    const out = await tool('memory_link').execute({ action: 'unlink', a: 'mem-A', b: 'mem-C' }, {})
    check('G6 星图缺席时 unlink 说明记忆没受影响', out.includes('记忆本身没受影响'), out.slice(0, 80))
    const out2 = await tool('memory_link').execute({ action: 'link', a: 'mem-A', b: 'mem-C', note: 'n' }, {})
    check('G7 link 缺席时排队而不是报错', out2.includes('已排队') && links.pendingCount() === 1, String(links.pendingCount()))
  }

  // G8/G9: 读记忆与运维面板也不能被星图缺席带崩
  {
    const out = await tool('memory_read').execute({ id: 'mem-A', neighbors: 5 }, {})
    check('G8 星图缺席时读记忆只出正文', out.includes('mem-A') && !out.includes('未完成') && !out.includes('连接到的记忆'), out.slice(0, 60))
    const panel = await tool('memory_admin').execute({ action: 'links' }, {})
    check('G9 面板说清队列去向', panel.includes('队列原样留着') || panel.includes('没有待补') || panel.includes('待补连线'), panel.split('\n')[0])
    const stats = await tool('memory_admin').execute({ action: 'stats' }, {})
    check('G10 星图面板缺席时不甩内部错误', stats.includes('星图概况这会儿看不了'), stats.slice(0, 60))
    const pushed = await tool('memory_admin').execute({ action: 'ingest', provider: 'hindsight', items: [{ title: 't' }] }, {})
    check('G11 推入外部记忆缺席时说清「一条都没进去」', pushed.includes('一条都没推进去'), pushed.slice(0, 60))
  }

  // G12/G13: 加料失败不能污染主语。local 检索带 expand 时扩散是「加料」，
  // 加不上只许说一句「没加」，不许把 tryCall 的「星图扩散未完成：…这项能力还没就绪…」拼进结果。
  {
    const out = await tool('memory_search').execute({ query: '拼接', expand: true }, {})
    check('G12 local+expand 星图缺席时仍给本地结果', out.includes('本地命中 1 条'), out.split('\n')[0])
    check(
      'G12 扩散失败不把内部错误塞进成功结果',
      !out.includes('这项能力还没就绪') && !out.includes('未完成') && out.includes('关联扩散没做'),
      out.split('\n').slice(-1)[0],
    )
    const linked = await tool('memory_link').execute({ action: 'link', a: 'mem-A', b: 'mem-C', note: 'n' }, {})
    check(
      'G13 连线排队文案是「星图这次没接上」而不是内部错误',
      linked.includes('星图这次没接上') && !linked.includes('这项能力还没就绪'),
      linked.slice(0, 80),
    )
  }
  for (const e of links.readPending()) links.dropPending(e.a, e.b)
}

// ── U. 空命中有两种：图里真没有，和图还没建完（0.2.39）──────────────────────
// 重建期（约 12s 一轮巡检）搜什么都空。以前两种情况都只回一句「星图里没有匹配」，
// 于是本地零命中 + 星图零命中被读成「两边都确认没有这条记忆」——而星图那边一次都没算。
{
  const { createUnifiedTools } = await import(pathToFileURL(join(root, 'lib/macro/tools.js')).href)
  const contractU = await import(pathToFileURL(join(root, 'lib/macro/contract.js')).href)
  const linksU = await import(pathToFileURL(join(root, 'lib/macro/links.js')).href)
  for (const e of linksU.readPending()) linksU.dropPending(e.a, e.b)

  const EMPTY_GRAPH = 'nebula_recall: 星图里还没有节点（图是空的），这一问等于没算。'
  const NO_MATCH = 'nebula_recall: 星图里没有匹配「拼接」的记忆（图里 128 条节点，一条都对不上）。'

  /** 星图在场，但召回那句话由我们指定；本地库是不是零命中也能指定。 */
  function starSays(recallText, { localHits = 0 } = {}) {
    const entries = new Map()
    const add = (name, fn) => entries.set(name, { name, vendor: 'stub', def: { name, execute: fn }, options: {} })
    add('memory_search', async () => ({
      hits: Array.from({ length: localHits }, (_, i) => ({ id: `local-${i}` })),
      text: localHits === 0 ? '本地 0 条（库里一条都没有）' : `本地命中 ${localHits} 条：mem-B`,
    }))
    add('nebula_recall', async () => recallText)
    add('nebula_bridge', async () => recallText)
    const bridge = {
      has: (n) => entries.has(n),
      get: (n) => entries.get(n),
      names: () => [...entries.keys()],
      awaitTool: async (n) => entries.get(n),
      async call(name, args) {
        const e = entries.get(name)
        if (!e) throw new Error('macro-memory：这项能力还没就绪')
        const value = await e.def.execute(args)
        return { entry: e, def: e.def, value, text: typeof value === 'string' ? value : value.text }
      },
      async tryCall(name, args) {
        return bridge.call(name, args)
      },
      promptDeclarations: () => [],
    }
    return { bridge }
  }
  const toolsU = (opts) => createUnifiedTools({ bridge: starSays(opts.text ?? EMPTY_GRAPH, opts).bridge, config: { toolWaitMs: 10, linkWaitMs: 10, flushThrottleMs: 0 } })
  const callU = async (opts, args) => String(await toolsU(opts).find((t) => t.name === 'memory_search').execute(args, {}))

  // U1 归类表：两种空命中各归各的，正常结果不动
  {
    const kinds = [
      [EMPTY_GRAPH, 'emptyGraph'],
      [NO_MATCH, 'noMatch'],
      ['— 星图关联扩散 —\n命中 2 条：mem-A、mem-B', 'ok'],
      ['', 'ok'],
    ]
    const wrong = kinds.filter(([t, want]) => contractU.recallAnswerKind(t) !== want)
    check('U1 两种空命中各归各的（图是空的 ≠ 没有匹配）', wrong.length === 0, wrong.map(([t, w]) => `${w}:${t.slice(0, 6)}`).join(' / ') || `${kinds.length}/${kinds.length}`)
  }

  // U2 「图是空的」不许说成「没有这条记忆」，而且要退回本地检索（以 meow 为主）
  {
    const out = await callU({}, { mode: 'graph', query: '拼接' })
    check('U2 空图时 mode=graph 退回本地检索', out.includes('本地 0 条') && out.includes('星图现在还是空的'), out.split('\n')[0])
    check('U2 空图不是「没有这条记忆」的答案', !out.includes('没有匹配') && out.includes('这不是「没有这条记忆」的答案'), out.slice(0, 90))
    check('U2 空图时说清多久之后会变（12s 一轮）', out.includes('12s'), out.split('\n')[0])
  }

  // U3 没 query 时退不回本地，但要说清怎么兜
  {
    const out = await callU({}, { mode: 'graph' })
    check('U3 空图 + 没 query 时给个 query 就能兜住', out.includes('给个 query') && !out.includes('没有匹配'), out.slice(0, 90))
  }

  // U4 bridge 同样：补充邻居这一问没算，不许冒充「没有相关邻居」
  {
    const out = await callU({}, { mode: 'bridge', query: '拼接' })
    check('U4 空图时 mode=bridge 也退回本地并说清没算', out.includes('本地 0 条') && out.includes('补充邻居这次没算'), out.slice(0, 90))
  }

  // U5 local 零命中自动扩散：空图不能给「确认没有」加假证据
  {
    const out = await callU({}, { query: '拼接' })
    check('U5 本地零命中时自动扩散仍然发生（但要说清没算）', out.includes('关联扩散这次没算'), out.split('\n').slice(-1)[0])
    check('U5 不把空图那半截原样拼成佐证', !out.includes('星图里没有匹配') && !out.includes('— 星图关联扩散 —'), out.split('\n').slice(-1)[0])
  }

  // U6 真·没有匹配照原样转述：那是算过的结论，不许被我们改写
  {
    const out = await callU({ text: NO_MATCH, localHits: 2 }, { mode: 'graph', query: '拼接' })
    check('U6 真没有匹配时原样转述（不改结论）', out.includes('一条都对不上') && !out.includes('星图现在还是空的'), out.slice(0, 90))
    const local = await callU({ text: NO_MATCH }, { query: '拼接' })
    check('U6 有结论时扩散照原样附加', local.includes('— 星图关联扩散 —') && local.includes('一条都对不上'), local.split('\n').slice(-1)[0])
  }

  // U7 空命中这条路径也全是只读：不许往补连队列里塞东西
  {
    await callU({}, { mode: 'graph', query: '拼接' })
    await callU({}, { query: '拼接' })
    check('U7 空命中的翻译不改只读语义：队列一条都不许涨', linksU.readPending().length === 0, `${linksU.readPending().length} 条`)
  }
  for (const e of linksU.readPending()) linksU.dropPending(e.a, e.b)
}

// ── V. 体检的空结果也一样：空图说「没算」，有节点说「干净」（0.2.40）────────────
// 「共 0 项」在空图上读起来就是「很干净」——比空检索更危险：检索空着用户会怀疑，体检说干净用户会放心。
{
  const { createUnifiedTools } = await import(pathToFileURL(join(root, 'lib/macro/tools.js')).href)
  const contractV = await import(pathToFileURL(join(root, 'lib/macro/contract.js')).href)

  const EMPTY_HYGIENE =
    '记忆体检：星图里还没有节点（图是空的），这次体检等于没算——「0 项」不是「很干净」。等星图建起来（约 12s 一轮巡检）再查一次；记忆本身没受影响。'
  const CLEAN = '记忆体检：共 0 项（只诊断，不动任何记忆）\n\n疑似重复（0）'

  /** 星图在场，体检那句话由我们指定。 */
  function starHygiene(text) {
    const entries = new Map()
    const add = (name, fn) => entries.set(name, { name, vendor: 'stub', def: { name, execute: fn }, options: {} })
    add('nebula_hygiene', async () => text)
    const bridge = {
      has: (n) => entries.has(n),
      get: (n) => entries.get(n),
      names: () => [...entries.keys()],
      awaitTool: async (n) => entries.get(n),
      async call(name, args) {
        const e = entries.get(name)
        if (!e) throw new Error('macro-memory：这项能力还没就绪')
        const value = await e.def.execute(args)
        return { entry: e, def: e.def, value, text: typeof value === 'string' ? value : value.text }
      },
      async tryCall(name, args) {
        return bridge.call(name, args)
      },
      promptDeclarations: () => [],
    }
    return { bridge }
  }
  const callV = async (text, args) =>
    String(
      await createUnifiedTools({
        bridge: starHygiene(text).bridge,
        config: { toolWaitMs: 10, linkWaitMs: 10, flushThrottleMs: 0 },
      })
        .find((t) => t.name === 'memory_admin')
        .execute(args, {}),
    )

  check('V1 体检的空结果被归成「没算」', contractV.hygieneAnswerKind(EMPTY_HYGIENE) === 'emptyGraph', contractV.hygieneAnswerKind(EMPTY_HYGIENE))
  check('V1 「共 0 项」不算没算（有节点时它就是干净）', contractV.hygieneAnswerKind(CLEAN) === 'ok', contractV.hygieneAnswerKind(CLEAN))

  {
    const out = await callV(EMPTY_HYGIENE, { action: 'hygiene' })
    check('V2 面板把「等于没算」原样交给用户', out.includes('这次体检等于没算') && out.includes('不是「很干净」'), out.split('\n')[0])
  }
  {
    const out = await callV(CLEAN, { action: 'hygiene' })
    check('V3 真干净时不许加「没算」的噪声', out.includes('共 0 项') && !out.includes('等于没算'), out.split('\n').find((l) => l.includes('共')) ?? '')
  }
}

// ── W. 星图概况的空图不许让人以为「记忆丢了」（0.2.41）───────────────────────
{
  const contractW = await import(pathToFileURL(join(root, 'lib/macro/contract.js')).href)
  const { createUnifiedTools } = await import(pathToFileURL(join(root, 'lib/macro/tools.js')).href)
  const EMPTY_STATS = [
    '宏记忆 · 星图现在还是空的：0 条记忆 / 0 条连接。',
    '来源都连着，但目前一条都没读进图里（建图一轮约 12s，建完再问一次）——这不是「记忆丢了」。',
    '记忆本身没受影响：这里只是「图里没有节点」，不等于库里没有记忆。',
  ].join('\n')
  const FULL_STATS =
    '宏记忆 · 星图：28 条记忆 / 41 条连接 / 3 个工作区 / 2 个会话账本\n平均连接度 2.93，孤立记忆 1 条，构建耗时 214ms'

  /** 星图在场，概况那句话由我们指定。 */
  function starStats(text) {
    const entries = new Map()
    const add = (name, fn) => entries.set(name, { name, vendor: 'stub', def: { name, execute: fn }, options: {} })
    add('nebula_stats', async () => text)
    const bridge = {
      has: (n) => entries.has(n),
      get: (n) => entries.get(n),
      names: () => [...entries.keys()],
      awaitTool: async (n) => entries.get(n),
      async call(name, args) {
        const e = entries.get(name)
        if (!e) throw new Error('macro-memory：这项能力还没就绪')
        const value = await e.def.execute(args)
        return { entry: e, def: e.def, value, text: typeof value === 'string' ? value : value.text }
      },
      async tryCall(name, args) {
        return bridge.call(name, args)
      },
      promptDeclarations: () => [],
    }
    return { bridge }
  }
  const callW = async (text) =>
    String(
      await createUnifiedTools({
        bridge: starStats(text).bridge,
        config: { toolWaitMs: 10, linkWaitMs: 10, flushThrottleMs: 0 },
      })
        .find((t) => t.name === 'memory_admin')
        .execute({ action: 'stats' }, {}),
    )

  check('W1 概况的空图被归成「空图」', contractW.statsAnswerKind(EMPTY_STATS) === 'emptyGraph', contractW.statsAnswerKind(EMPTY_STATS))
  check('W1 有节点的概况不是空图', contractW.statsAnswerKind(FULL_STATS) === 'ok', contractW.statsAnswerKind(FULL_STATS))

  {
    const out = await callW(EMPTY_STATS)
    check(
      'W2 面板把「不是记忆丢了」原样交给用户',
      out.includes('这不是「记忆丢了」') && out.includes('星图现在还是空的'),
      out.split('\n')[0],
    )
  }
  {
    const out = await callW(FULL_STATS)
    check('W3 有节点时不许加「记忆丢了」的噪声', !out.includes('记忆丢了') && out.includes('28 条记忆'), out.split('\n')[0])
  }
}

// ── X. inspect 的空结果也分两种：图还是空的，还是真没这条（0.2.42）─────────────
{
  const contractX = await import(pathToFileURL(join(root, 'lib/macro/contract.js')).href)
  const { createUnifiedTools } = await import(pathToFileURL(join(root, 'lib/macro/tools.js')).href)
  const links = await import(pathToFileURL(join(root, 'lib/macro/links.js')).href)

  const EMPTY_GRAPH = [
    '星图里还没有节点（图是空的），这次 nebula_inspect 等于没算——这不是「这条记忆不存在」。',
    '等星图建起来（约 12s 一轮巡检）再查一次；记忆本身没受影响。',
  ].join('')
  const NOT_FOUND = [
    '星图里没有 id=mem-A 的记忆。这不等于「记忆没了」：图里现有 28 条节点，',
    '可能是刚写还没入图（约 12s 一轮巡检），也可能是 id 不对（裸 id 给前 12 位就够）。',
    '可以先用 nebula_recall 搜关键词确认。',
  ].join('')
  const OLD_NOT_FOUND = '星图里没有 id=mem-A 的记忆。可以先用 nebula_recall 搜一下。'
  const READY = '## 连接到的记忆（1/1）\n- [same-project 0.90] 某条  ·  ws  ·  fact'

  check('X1 空图归成「没算」', contractX.inspectAnswerKind(EMPTY_GRAPH) === 'emptyGraph', contractX.inspectAnswerKind(EMPTY_GRAPH))
  check('X1 没找到归成「没这条」', contractX.inspectAnswerKind(NOT_FOUND) === 'notFound', contractX.inspectAnswerKind(NOT_FOUND))
  check(
    'X1 旧文案也归成「没这条」（vendor 没打补丁时不能退化成 ready）',
    contractX.inspectAnswerKind(OLD_NOT_FOUND) === 'notFound',
    contractX.inspectAnswerKind(OLD_NOT_FOUND),
  )
  check('X1 正常正文才是 ok', contractX.inspectAnswerKind(READY) === 'ok', contractX.inspectAnswerKind(READY))

  /** 造一套「写入 + 连线」的桥，inspect 的文案由这一条决定。 */
  function makeBridge(inspectText, linked) {
    const entries = new Map()
    const add = (name, fn) => entries.set(name, { name, vendor: 'stub', def: { name, execute: fn }, options: {} })
    add('memory_remember', async () => ({ id: 'mem-A' }))
    // 0.2.54 起归一有三种真相：这里给「查到了」的那一种（短 id mem-B 就是它自己）。
    // 少了这个桩，融合层会如实报「没查成」并按新规则排队——那是另一件事，不该由这一段来测。
    add('memory_read', async (args) => ({ found: true, id: String(args.id) }))
    add('nebula_inspect', async (args) => ({ id: args.id, text: inspectText }))
    add('nebula_link', async (args) => (linked ? `已固化连线：${args.a} ↔ ${args.b}` : '没找到节点'))
    const bridge = {
      has: (n) => entries.has(n),
      get: (n) => entries.get(n),
      names: () => [...entries.keys()],
      awaitTool: async (n) => entries.get(n),
      async call(name, args) {
        const e = entries.get(name)
        if (!e) throw new Error('not ready')
        const value = await e.def.execute(args)
        return { entry: e, def: e.def, value, text: typeof value === 'string' ? value : JSON.stringify(value) }
      },
      async tryCall(name, args) {
        try {
          return await bridge.call(name, args)
        } catch (err) {
          return { entry: undefined, def: undefined, value: undefined, text: `未完成：${err.message}` }
        }
      },
      promptDeclarations: () => [],
    }
    return bridge
  }

  async function writeWithLink({ inspectText, linked }) {
    for (const e of links.readPending()) links.dropPending(e.a, e.b)
    const tool = createUnifiedTools({
      bridge: makeBridge(inspectText, linked),
      config: { toolWaitMs: 10, linkWaitMs: 10, flushThrottleMs: 0 },
    }).find((t) => t.name === 'memory_remember')
    const out = await tool.execute({ content: 'x', project: 'p', keywords: ['a'], importance: 1, links: ['mem-B'] }, {})
    return { out, pending: links.readPending() }
  }

  {
    const { out, pending } = await writeWithLink({ inspectText: EMPTY_GRAPH, linked: true })
    check(
      'X2 空图时写入：连线排队，理由是「节点待入图」而不是「失败」',
      pending.length === 1 && pending[0].reason === '节点待入图',
      `${pending.length} 条 / ${pending[0]?.reason ?? '—'}`,
    )
    check('X2 空图时文案仍是「已排队 + 会自动补」', out.includes('已排队') && out.includes('自动补连'), out.split('\n').slice(-1)[0])
  }
  {
    const { pending } = await writeWithLink({ inspectText: NOT_FOUND, linked: true })
    check(
      'X3 「没找到这一条」也排队等入图，不抢跑去连',
      pending.length === 1 && pending[0].reason === '节点待入图',
      `${pending.length} 条 / ${pending[0]?.reason ?? '—'}`,
    )
  }
  {
    const { pending } = await writeWithLink({ inspectText: OLD_NOT_FOUND, linked: true })
    check(
      'X4 vendor 没打补丁（旧文案）时行为不变：排队等入图',
      pending.length === 1 && pending[0].reason === '节点待入图',
      `${pending.length} 条 / ${pending[0]?.reason ?? '—'}`,
    )
  }
  {
    const { pending } = await writeWithLink({ inspectText: READY, linked: true })
    check('X5 真入图了就当场连上，不排队', pending.length === 0, `${pending.length} 条`)
  }
}

// ── Y. 来源体检的「0 个来源」也分两种：没接上，还是接了没读到（0.2.43）──────────
{
  const contractY = await import(pathToFileURL(join(root, 'lib/macro/contract.js')).href)
  const { createUnifiedTools } = await import(pathToFileURL(join(root, 'lib/macro/tools.js')).href)

  const EMPTY_SOURCES = [
    '配置：/home/u/.dsh/nebula.json（还没有，可新建）',
    '自动探测：开',
    '',
    '已接入 0 个来源，共读到 0 条记忆——这句有两种意思：',
    '  配置文件还没建（/home/u/.dsh/nebula.json）——所以一个来源都没接上。这不等于「记忆没了」。',
    '',
    '可用适配器：',
    '- meow（sqlite）meow-memory：读 meow 的库',
  ].join('\n')
  const FULL_SOURCES = [
    '配置：/home/u/.dsh/nebula.json',
    '自动探测：开',
    '',
    '已接入 1 个来源，共读到 128 条记忆：',
    '- [sqlite] meow · 512KB · 有会话账本',
    '  /home/u/.dsh/nebulagraph.sqlite',
    '',
    '星图：128 节点 / 203 边 / 3 工作区 / 2 会话',
    '',
    '可用适配器：',
    '- meow（sqlite）meow-memory：读 meow 的库',
  ].join('\n')

  check('Y1 「0 个来源」被归成「没接上」', contractY.sourcesAnswerKind(EMPTY_SOURCES) === 'emptyStores', contractY.sourcesAnswerKind(EMPTY_SOURCES))
  check('Y1 正常报表不是空来源', contractY.sourcesAnswerKind(FULL_SOURCES) === 'ok', contractY.sourcesAnswerKind(FULL_SOURCES))
  check('Y1 空串不瞎猜', contractY.sourcesAnswerKind('') === 'ok', contractY.sourcesAnswerKind(''))

  /** 星图在场，来源报表由这一条决定。 */
  function starSources(text) {
    const entries = new Map()
    const add = (name, fn) => entries.set(name, { name, vendor: 'stub', def: { name, execute: fn }, options: {} })
    add('nebula_sources', async () => text)
    const bridge = {
      has: (n) => entries.has(n),
      get: (n) => entries.get(n),
      names: () => [...entries.keys()],
      awaitTool: async (n) => entries.get(n),
      async call(name, args) {
        const e = entries.get(name)
        if (!e) throw new Error('macro-memory：这项能力还没就绪')
        const value = await e.def.execute(args)
        return { entry: e, def: e.def, value, text: typeof value === 'string' ? value : value.text }
      },
      async tryCall(name, args) {
        return bridge.call(name, args)
      },
      promptDeclarations: () => [],
    }
    return { bridge }
  }
  const callY = async (text) =>
    String(
      await createUnifiedTools({ bridge: starSources(text).bridge, config: { toolWaitMs: 10, linkWaitMs: 10, flushThrottleMs: 0 } })
        .find((t) => t.name === 'memory_admin')
        .execute({ action: 'sources' }, {}),
    )

  {
    const out = await callY(EMPTY_SOURCES)
    check(
      'Y2 面板把「这句有两种意思」与原因原样交给用户',
      out.includes('这句有两种意思') && out.includes('这不等于「记忆没了」'),
      out.split('\n')[3] ?? out.split('\n')[0],
    )
  }
  {
    const out = await callY(FULL_SOURCES)
    check(
      'Y3 有来源时不许加「记忆没了」的噪声',
      !out.includes('记忆没了') && !out.includes('这句有两种意思') && out.includes('128 条记忆'),
      out.split('\n')[3] ?? out.split('\n')[0],
    )
  }
}

// ── Z. 补邻居的空结果四种原因分开说，且空图仍退本地兜底（0.2.44）─────────────────
{
  const contractZ = await import(pathToFileURL(join(root, 'lib/macro/contract.js')).href)
  const { createUnifiedTools } = await import(pathToFileURL(join(root, 'lib/macro/tools.js')).href)

  const Z_EMPTY_GRAPH = [
    'nebula_bridge：这次没补到东西。',
    '  星图里还没有节点（图是空的），这次 nebula_bridge 等于没算（不是「没有相关记忆」）。',
    '这不是「图里没有相关记忆」。',
  ].join('\n')
  const Z_NO_SEED = [
    'nebula_bridge：这次没补到东西。',
    '  你给的 2 个 id 一条都没在图里找到种子——可能是刚写还没入图（约 12s 一轮巡检），',
    '也可能 id 不对（裸 id 给前 12 位就够）。先用 memory_search 确认 id 再问。',
    '这不是「图里没有相关记忆」。',
  ].join('\n')
  const Z_FILTERED = [
    'nebula_bridge：这次没补到东西。',
    '  有 3 条种子，但邻居都被过滤掉了（已读过 / 冷却期 / 权重低于 min_weight / 归档）。',
    '这不是「图里没有相关记忆」。',
  ].join('\n')
  const Z_OK = 'nebula_bridge：从 3 条种子扩散，候选 12 条，选出 4 条（820 字）\n- [same-project 0.90] …'

  check('Z1 空图/没种子/被过滤都归成「没补到」', [Z_EMPTY_GRAPH, Z_NO_SEED, Z_FILTERED].every((t) => contractZ.bridgeAnswerKind(t) === 'empty'), [
    Z_EMPTY_GRAPH,
    Z_NO_SEED,
    Z_FILTERED,
  ].map((t) => contractZ.bridgeAnswerKind(t)).join(','))
  check('Z1 补到东西时不是空', contractZ.bridgeAnswerKind(Z_OK) === 'ok', contractZ.bridgeAnswerKind(Z_OK))
  check(
    'Z2 空图那句仍被 recallAnswerKind 认成「没算」（bridge 模式的本地兜底靠它）',
    contractZ.recallAnswerKind(Z_EMPTY_GRAPH) === 'emptyGraph',
    contractZ.recallAnswerKind(Z_EMPTY_GRAPH),
  )

  {
    // mode=bridge 走 nebula_bridge：空图时必须退本地检索，而不是把「没补到」当结论。
    const entries = new Map()
    const add = (name, fn) => entries.set(name, { name, vendor: 'stub', def: { name, execute: fn }, options: {} })
    add('nebula_bridge', async () => Z_EMPTY_GRAPH)
    add('memory_search', async () => '[1] 本地命中：星图没起来时的兜底结果')
    const bridge = {
      has: (n) => entries.has(n),
      get: (n) => entries.get(n),
      names: () => [...entries.keys()],
      awaitTool: async (n) => entries.get(n),
      async call(name, args) {
        const e = entries.get(name)
        if (!e) throw new Error('macro-memory：这项能力还没就绪')
        const value = await e.def.execute(args)
        return { entry: e, def: e.def, value, text: typeof value === 'string' ? value : value.text }
      },
      async tryCall(name, args) {
        return bridge.call(name, args)
      },
      promptDeclarations: () => [],
    }
    const tools = await createUnifiedTools({ bridge, config: { toolWaitMs: 10, linkWaitMs: 10, flushThrottleMs: 0 } })
    const out = String(await tools.find((t) => t.name === 'memory_search').execute({ mode: 'bridge', query: '星图' }, {}))
    check(
      'Z3 空图时 bridge 模式退本地检索，并说清「这次没算」',
      out.includes('星图现在还是空的') && out.includes('先给本地结果') && out.includes('本地命中'),
      out.split('\n')[0],
    )
  }
}

// ── AC. 相似检索的空结果：一条都没有的时候也得说话（0.2.46）────────────────────
{
  const contractAC = await import(pathToFileURL(join(root, 'lib', 'macro', 'contract.js')).href)
  const { createUnifiedTools } = await import(pathToFileURL(join(root, 'lib', 'macro', 'tools.js')).href)
  const SIM_NO_TARGET = '相似检索没算成：这条记忆没有可用于比较的词（内容全是符号/数字/停用词）。这不是「记忆里没有相似的东西」。'
  const SIM_FEW = '相似检索没算成：库里就只有这一条可比的记忆，没有别的条目可以比较。这不是「记忆里没有相似的东西」。'
  const SIM_FILTERED = '相似检索没算成：可比的候选一条都没有（库里 12 条，本会话新写的和这一轮已看过的都被排除了）。这不是「记忆里没有相似的东西」——换一条基准，或等下一次会话再问。'
  const SIM_NONE = '这次真算过了：5 条候选里没有一条和它有共同词汇（相似度全是 0）。这才是「记忆里没有相似的东西」。'
  const SIM_HIT = '[lesson 0mwm1] 相似度 0.412 有共同词汇的条目'
  const pairs = [
    [SIM_NO_TARGET, 'notComputed'],
    [SIM_FEW, 'notComputed'],
    [SIM_FILTERED, 'notComputed'],
    [SIM_NONE, 'none'],
    [SIM_HIT, 'ok'],
  ]
  const wrong = pairs.filter(([t, want]) => contractAC.similarAnswerKind(t) !== want)
  check(
    'AC1 三种「没算成」都归 notComputed，只有真算过那句归 none',
    wrong.length === 0,
    wrong.map(([t, want]) => `${want}→${contractAC.similarAnswerKind(t)}`).join(',') || 'ok',
  )

  // 真库：写入一条基准后问「和它相似的」，此时库里没有别的可比条目
  const wroteAC = await run('memory_remember', {
    content: '相似检索的基准：一条只属于这个探针的记忆。',
    project: '全局',
    keywords: ['相似检索基准', '探针', 'similarAnswerKind', '空结果', '0.2.46'],
    importance: 1,
    level: 'fact',
  })
  const seeded = await run('memory_search', { query: '相似检索的基准' })
  const seedId = (text(seeded).match(/\[([\w-]{5,})\]/) ?? [])[1]
  check('AC2 基准记忆写进去了', Boolean(seedId), text(wroteAC).split('\n')[0])
  const saidAC = text(await run('memory_search', { mode: 'similar', id: seedId }))
  check(
    'AC2 空结果不再沉默（给的是话，不是 {"hits": []}）',
    saidAC.trim().length > 0 && !saidAC.trim().startsWith('{'),
    saidAC.split('\n')[0].slice(0, 60),
  )
  check(
    'AC2 说的是「没算成」，不是「没有相似的东西」',
    contractAC.similarAnswerKind(saidAC) === 'notComputed',
    contractAC.similarAnswerKind(saidAC),
  )
  check(
    'AC2 给的是这一种原因，不是那句谁都能用的兜底',
    !saidAC.includes('这次没有可比较的对象'),
    saidAC.includes('这次没有可比较的对象') ? '用到了兜底句（note 没传到 render）' : 'ok',
  )

  // 兜底：子插件补丁被上游冲掉时（render 返回空数组），融合层还得说话
  const legacyAC = {
    async call(name) {
      if (name === 'memory_find_similar') return { text: '{"hits": []}', value: { hits: [] } }
      return { text: '本地命中：星图没起来时的兜底结果', value: { hits: [{}] } }
    },
    async tryCall(name, args) {
      return legacyAC.call(name, args)
    },
    promptDeclarations: () => [],
  }
  const toolsAC = await createUnifiedTools({
    bridge: legacyAC,
    config: { toolWaitMs: 10, linkWaitMs: 10, flushThrottleMs: 0 },
  })
  const bareAC = String(
    await toolsAC.find((t) => t.name === 'memory_search').execute({ mode: 'similar', id: 'mem-A' }, {}),
  )
  check(
    'AC3 子插件一个字都不给时，融合层自己说「没算成」',
    bareAC.includes('相似检索这次没给出任何内容') && !bareAC.includes('这才是「记忆里没有相似的东西」'),
    bareAC.slice(0, 60),
  )
}

// ── AD. 项目全景的空结果：名字没对上，还是真没有（0.2.47）──────────────────────
{
  const saidNoStore = text(await run('memory_project', { project: '这个项目名-根本不存在-0247' }))
  check(
    'AD1 对不上的项目名说「一条都对不上」，不冒充「这个项目没有记忆」',
    saidNoStore.includes('这个名字在库里一条都对不上') && !saidNoStore.trimEnd().endsWith('该项目暂无记忆条目。'),
    saidNoStore.split('\n')[0].slice(0, 60),
  )
  check(
    'AD1 顺带报出库里现有的项目名（好让人挑一个）',
    saidNoStore.includes('库里现有的项目名：') || saidNoStore.includes('一个项目名都还没有'),
    saidNoStore.split('\n')[1]?.slice(0, 50) ?? '',
  )

  // 只在 fact 层写一条：project 层空、但库里有东西——这才是「上半句只说了一半」那一支
  const onlyFact = 'AD 探针：这条只写在 fact 层，project 层一条都没有。'
  await run('memory_remember', {
    content: onlyFact,
    project: 'AD探针项目0247',
    keywords: ['AD探针', '项目全景', 'fact 层', 'project 层空', '0.2.47', '探针', '空结果', '分支'],
    importance: 1,
    level: 'fact',
  })
  const saidHalf = text(await run('memory_project', { project: 'AD探针项目0247' }))
  check(
    'AD2 只有 fact 层有东西时，说清「别的层还有 N 条」，不是「暂无记忆条目」了事',
    saidHalf.includes('在别的层还有') && saidHalf.includes('fact 1') && saidHalf.includes('memory_search(project='),
    saidHalf.split('\n')[1]?.slice(0, 70) ?? saidHalf.slice(0, 70),
  )
  check(
    'AD2 那句「不是这个项目没有记忆」在',
    saidHalf.includes('这不是「这个项目没有记忆」'),
    saidHalf.includes('不是「这个项目没有记忆」') ? 'ok' : '缺',
  )

  // 归类函数：三种空各归各的，正常有内容的别被归类成空（0.2.47）
  const contractAD = await import(pathToFileURL(join(root, 'lib/macro/contract.js')).href)
  const kindsAD = [
    [saidNoStore, 'nameNotFound'],
    [saidHalf, 'otherLayers'],
    ['【项目：X】该项目暂无记忆条目。\n查过七层表：project 字段正好写着这个名字的 active 条目是 0 条，这次是真没有（已归档/已完结的不算）。', 'empty'],
    ['【项目：X】\n\n项目概述\n- fact 0mwmxj9o 一句话', 'ok'],
  ]
  const wrongAD = kindsAD.filter(([t, want]) => contractAD.projectAnswerKind(t) !== want)
  check(
    'AD3 三种空各归各的，正常有内容的仍归 ok',
    wrongAD.length === 0,
    wrongAD.length
      ? wrongAD.map(([t, want]) => `${want}→${contractAD.projectAnswerKind(t)}`).join(',')
      : kindsAD.map(([, w]) => w).join(','),
  )
}

// ── AE. 整理任务没启动：是没东西可整理，还是消息没送到（0.2.48）────────────────
{
  const contractAE = await import(pathToFileURL(join(root, 'lib', 'macro', 'contract.js')).href)
  const { createUnifiedTools: createUnifiedToolsAE } = await import(
    pathToFileURL(join(root, 'lib', 'macro', 'tools.js')).href
  )
  const D_NOTHING = '本窗口没有需要整理的记忆（盘点过：没有未封存的记忆轮次）——这一次是真没有，不是 dream 坏了。'
  const D_BUSY = '本窗口确实有记忆要整理，但已经有一个 dream 在跑（或上一轮还在待补收尾）——这次没启动，等它收尾后再触发就行。'
  const D_FAILED = '这次没启动成功：整理任务的消息没送进会话（会话正忙或被中断）。要整理的记忆还在，稍后再触发一次就行——这不是「没有需要整理的记忆」。'
  const D_NOID = '这次没启动成功：拿不到这个窗口的标识，所以没法开工（这不是「没有需要整理的记忆」）。'
  const D_OK = '🧠 dream 已触发：整理任务已在后台运行，会话流中的任务气泡会显示进度与完成状态。'
  const pairsAE = [
    [D_NOTHING, 'nothing'],
    [D_BUSY, 'busy'],
    [D_FAILED, 'notStarted'],
    [D_NOID, 'notStarted'],
    [D_OK, 'ok'],
  ]
  const wrongAE = pairsAE.filter(([t, want]) => contractAE.dreamAnswerKind(t) !== want)
  check(
    'AE1 四种没启动各归各的，只有「盘点过为空」归 nothing',
    wrongAE.length === 0,
    wrongAE.map(([t, want]) => `${want}→${contractAE.dreamAnswerKind(t)}`).join(',') || 'ok',
  )
  check(
    'AE1 「消息没送出去」那句自己就否认了「没有需要整理的记忆」，不会两者都说',
    contractAE.dreamAnswerKind(D_FAILED) === 'notStarted' && D_FAILED.includes('这不是「没有需要整理的记忆」'),
    contractAE.dreamAnswerKind(D_FAILED),
  )

  // 真调用：探针里的假 agent 送不出消息 → 走的正是 sendFailed 那一支（原来会被说成「没有需要整理的记忆」）
  const saidAE = text(await run('memory_dream', {}))
  const kindAE = contractAE.dreamAnswerKind(saidAE)
  check('AE2 dream 不是沉默（给的是话，不是空串）', saidAE.trim().length > 0, saidAE.split('\n')[0].slice(0, 70))
  check(
    'AE2 探针的假 agent 送不出消息，所以必须说「没送出去」，不许退回谁也说不清的兜底',
    kindAE === 'notStarted',
    `${kindAE}：${saidAE.split('\n')[0].slice(0, 50)}`,
  )
  check(
    'AE2 送不出去时不许说成「没有需要整理的记忆」',
    kindAE !== 'notStarted' || !saidAE.includes('没有需要整理的记忆（盘点过'),
    saidAE.includes('没有需要整理的记忆（盘点过') ? '两种说法混在一句里' : 'ok',
  )

  // 兜底：子插件一个字都不给时，融合层自己说话
  const legacyAE = {
    async call() {
      return { text: '', value: { ok: false } }
    },
    async tryCall() {
      return legacyAE.call()
    },
    promptDeclarations: () => [],
  }
  const toolsAE = await createUnifiedToolsAE({
    bridge: legacyAE,
    config: { toolWaitMs: 10, linkWaitMs: 10, flushThrottleMs: 0 },
  })
  const bareAE = String(await toolsAE.find((t) => t.name === 'memory_dream').execute({}, {}))
  check(
    'AE3 子插件一个字都不给时，融合层自己说「没有回执」',
    bareAE.includes('没有任何回执') && !bareAE.includes('没有需要整理的记忆（盘点过'),
    bareAE.slice(0, 60),
  )
}

// ── AF. 改记忆的回执：改了什么、哪些字段没生效（0.2.49）──────────────────────
{
  const contractAF = await import(pathToFileURL(join(root, 'lib', 'macro', 'contract.js')).href)
  const { createUnifiedTools: createUnifiedToolsAF } = await import(
    pathToFileURL(join(root, 'lib', 'macro', 'tools.js')).href
  )
  const U_NOTHING = '这次什么都没改：一个能写进库的字段都没有。（只给了 id，别的字段一个都没带。）要改就带上 fact 层支持的字段再调一次——这不是「已经更新好了」。'
  const U_PARTIAL = '✅ 已更新（fact 0mwmy2qi）：content。但这几个字段没生效：goal（只有 topic 层有目标句，这条是 fact）——这是「部分生效」，不是全部。'
  const U_NOTFOUND = '更新失败：没有这个 id（七层表里都找不到）。短 id 给前 8 位就够，但要能唯一命中；请先用 memory_search / memory_read 确认 id。'
  const U_OK = '✅ 已更新（fact 0mwmy2qi）：importance。'
  const pairsAF = [
    [U_NOTHING, 'nothing'],
    [U_PARTIAL, 'partial'],
    [U_NOTFOUND, 'notFound'],
    [U_OK, 'ok'],
  ]
  const wrongAF = pairsAF.filter(([t, want]) => contractAF.updateAnswerKind(t) !== want)
  check(
    'AF1 四种回执各归各的：什么都没改 / 改了一半 / 查无此 id / 真改成了',
    wrongAF.length === 0,
    wrongAF.map(([t, want]) => `${want}→${contractAF.updateAnswerKind(t)}`).join(',') || pairsAF.map(([, w]) => w).join(','),
  )
  check(
    'AF1 「什么都没改」那句自己就否认了「已经更新好了」，不会两者都说',
    contractAF.updateAnswerKind(U_NOTHING) === 'nothing' && U_NOTHING.includes('这不是「已经更新好了」'),
    contractAF.updateAnswerKind(U_NOTHING),
  )
  check(
    'AF1 「部分生效」不会被当成全部生效（它的句子从头就带 ✅，只能靠后半句分开）',
    contractAF.updateAnswerKind(U_PARTIAL) === 'partial' && !U_PARTIAL.includes('这次什么都没改'),
    contractAF.updateAnswerKind(U_PARTIAL),
  )

  // 真调用：先写一条，再只拿 id 去改——原来这里会回「✅ 已更新」，其实一个字段都没动
  const afContent = 'AF 探针：这条只用来试「改记忆的回执」，别当真记忆。'
  await run('memory_remember', {
    content: afContent,
    project: 'AF探针项目0249',
    keywords: ['AF探针', '改记忆', '回执', '什么都没改', '0.2.49', '探针', '部分生效', '字段过滤'],
    importance: 1,
    level: 'fact',
  })
  const afHit = await run('memory_search', { query: 'AF 探针：改记忆的回执' })
  const afId = (text(afHit).match(/\[([\w-]{5,})\]/) ?? [])[1]
  check('AF2 探针能取到刚写那条的 id', typeof afId === 'string' && afId.length >= 5, afId ?? '没取到')

  if (afId) {
    const afBare = text(await run('memory_update', { id: afId }))
    check(
      'AF2 只给 id 不带任何字段时，说「这次什么都没改」，不许回「✅ 已更新」',
      contractAF.updateAnswerKind(afBare) === 'nothing' && !afBare.includes('✅ 已更新'),
      `${contractAF.updateAnswerKind(afBare)}：${afBare.slice(0, 60)}`,
    )
    check(
      'AF2 并说清「这不是已经更新好了」（拿到肯定答复的人不会再检查）',
      afBare.includes('这不是「已经更新好了」'),
      afBare.includes('已经更新好了') ? 'ok' : '缺',
    )

    // 字段被这一层过滤掉：goal 只有 topic 层有，fact 层给了也只能丢——但必须说出来
    const afGoal = text(await run('memory_update', { id: afId, goal: '这个目标句写不进 fact 层' }))
    check(
      'AF3 字段被过滤时点名是哪个字段、为什么（goal 只有 topic 层有）',
      afGoal.includes('这次什么都没改') && afGoal.includes('goal（只有 topic 层有目标句'),
      afGoal.slice(0, 70),
    )

    const afReal = text(await run('memory_update', { id: afId, importance: 2 }))
    check(
      'AF4 真改成一个字段时才说已更新，并报出改的是哪个字段',
      contractAF.updateAnswerKind(afReal) === 'ok' && afReal.includes('✅ 已更新') && afReal.includes('importance'),
      afReal.slice(0, 60),
    )
    const afMissing = text(await run('memory_update', { id: 'zzzzzzzz-0249-不存在', importance: 2 }))
    check(
      'AF4 查无此 id 时说「没有这个 id」，不冒充「已更新」也不冒充「什么都没改」',
      contractAF.updateAnswerKind(afMissing) === 'notFound',
      `${contractAF.updateAnswerKind(afMissing)}：${afMissing.slice(0, 50)}`,
    )
  }

  // 兜底：子插件一个字都不给时，融合层自己说话（同 0.2.48 的 dream 那种守法）
  const legacyAF = {
    async call() {
      return { text: '', value: { ok: true, id: 'abcdefgh' } }
    },
    async tryCall() {
      return legacyAF.call()
    },
    promptDeclarations: () => [],
  }
  const toolsAF = await createUnifiedToolsAF({
    bridge: legacyAF,
    config: { toolWaitMs: 10, linkWaitMs: 10, flushThrottleMs: 0 },
  })
  const bareAF = String(await toolsAF.find((t) => t.name === 'memory_update').execute({ id: 'abcdefgh' }, {}))
  check(
    'AF5 子插件一个字都不给时，融合层自己说「没有任何回执」，不许让 ok:true 冒充满分',
    bareAF.includes('没有任何回执') && bareAF.includes('这不是「已经更新好了」'),
    bareAF.slice(0, 60),
  )
}

// ── AG. 写记忆的回执：层名被改过、参数被丢掉、是合并不是新写（0.2.50）────────────
{
  const contractAG = await import(pathToFileURL(join(root, 'lib', 'macro', 'contract.js')).href)
  const { createUnifiedTools: createUnifiedToolsAG } = await import(
    pathToFileURL(join(root, 'lib', 'macro', 'tools.js')).href
  )
  const R_LEVEL =
    '✅ 记忆已写入（fact，id=abcd1234）。\n写成 fact 了：你给的层名「lessons」不在七层里（soul / user / project / fact / lesson / topic / rules），这条记忆被记进了 fact——这不是「按你说的层写好了」。要放进正确的层，得在那一层重新 remember 一次，再把这条归档（memory_update 不改层）。'
  const R_DROPPED =
    '✅ 记忆已写入（fact，id=abcd1234）。\n这几个参数没生效：goal（只有 topic 层有目标句，这条是 fact）；corrected（只有 lesson 层记「被纠正」，这条是 fact）。\n项目：AG探针项目0250。'
  const R_MERGED =
    '✅ 已合并到已有条目（fact，id=abcd1234）。\n这条并进了已有条目 abcd1234（与它的内容重复度 ≥80%）：原条目的内容被替换成这次写的内容，importance 取两者较大值。这是「合并」，不是「新写一条」。'
  const R_OK = '✅ 记忆已写入（fact，id=abcd1234）。项目：AG探针项目0250。关键词：AG探针 / 写入回执。无需重复调用本工具。'
  const pairsAG = [
    [R_LEVEL, 'levelFallback'],
    [R_DROPPED, 'dropped'],
    [R_MERGED, 'merged'],
    [R_OK, 'ok'],
  ]
  const wrongAG = pairsAG.filter(([t, want]) => contractAG.rememberAnswerKind(t) !== want)
  check(
    'AG1 四种回执各归各的：层名被改过 / 参数没生效 / 合进旧条目 / 真按原样写入',
    wrongAG.length === 0,
    wrongAG.map(([t, want]) => `${want}→${contractAG.rememberAnswerKind(t)}`).join(',') || pairsAG.map(([, w]) => w).join(','),
  )
  check(
    'AG1 层名被改过的那句自己就否认「按你说的层写好了」，也点出被写进了哪一层',
    contractAG.rememberAnswerKind(R_LEVEL) === 'levelFallback' &&
      R_LEVEL.includes('这不是「按你说的层写好了」') &&
      R_LEVEL.includes('被记进了 fact'),
    contractAG.rememberAnswerKind(R_LEVEL),
  )
  check(
    'AG1 「合并」不会被当成「新写一条」',
    contractAG.rememberAnswerKind(R_MERGED) === 'merged' && R_MERGED.includes('这是「合并」，不是「新写一条」'),
    contractAG.rememberAnswerKind(R_MERGED),
  )
  check(
    'AG1 干净写入不会冒出任何一种警告',
    contractAG.rememberAnswerKind(R_OK) === 'ok' &&
      !R_OK.includes('没生效') &&
      !R_OK.includes('合并'),
    contractAG.rememberAnswerKind(R_OK),
  )

  // 真调用：层名写错（lessons 是 lesson 的复数）——原来静默落进 fact，回执照说「✅ 记忆已写入」
  const agLevelContent = 'AG 探针：层名写错的一条，用来试「记忆写进哪一层」。'
  const agLevel = String(
    await run('memory_remember', {
      content: agLevelContent,
      project: 'AG探针项目0250',
      keywords: ['AG探针', '层名写错', 'lessons', 'fact', '写入回执', '0.2.50', '探针', '错层'],
      importance: 1,
      level: 'lessons',
    }),
  )
  check(
    'AG2 层名写错时回执点名「不在七层里」，并说这条被记进了 fact',
    contractAG.rememberAnswerKind(agLevel) === 'levelFallback' &&
      agLevel.includes('不在七层里') &&
      agLevel.includes('被记进了 fact'),
    `${contractAG.rememberAnswerKind(agLevel)}：${agLevel.slice(0, 60)}`,
  )
  check(
    'AG2 并否认「按你说的层写好了」（否则读者以为 lesson 层多了一条）',
    agLevel.includes('这不是「按你说的层写好了」') && !agLevel.includes('（lessons'),
    agLevel.includes('按你说的层写好了') ? 'ok' : '缺',
  )

  // 真调用：给错层的字段（goal / corrected）必须点名，不许一声不响地丢
  const agDropContent = 'AG 探针：字段给错层的一条，用来看「哪些参数没生效」。'
  const agDrop = String(
    await run('memory_remember', {
      content: agDropContent,
      project: 'AG探针项目0250',
      keywords: ['AG探针', '参数没生效', 'goal', 'corrected', 'fact', '写入回执', '0.2.50', '错层'],
      importance: 1,
      level: 'fact',
      goal: 'fact 层没有目标句',
      corrected: true,
    }),
  )
  check(
    'AG3 给错层的 goal / corrected 逐条点名，并说清只有哪一层认它',
    agDrop.includes('这几个参数没生效') && agDrop.includes('goal（只有 topic 层有目标句') && agDrop.includes('corrected（只有 lesson 层记「被纠正」'),
    agDrop.slice(0, 80),
  )
  check(
    'AG3 参数没生效时不会说「按你说的层写好了」（层没错，但字段被丢了）',
    !agDrop.includes('按你说的层写好了') && !agDrop.includes('被记进了'),
    agDrop.includes('按你说的层写好了') ? '越界说了' : 'ok',
  )

  // 真调用：同一句话再写一遍 → 并进旧条目，回执必须说「这是合并」
  const agMergeContent = 'AG 探针：这句话故意写两遍，用来试「合并」与「新写一条」的分界。'
  const agFirst = String(
    await run('memory_remember', {
      content: agMergeContent,
      project: 'AG探针项目0250',
      keywords: ['AG探针', '合并', '重复', '写入回执', '0.2.50', '探针', '新写一条', '分界'],
      importance: 1,
      level: 'fact',
    }),
  )
  const agSecond = String(
    await run('memory_remember', {
      content: agMergeContent,
      project: 'AG探针项目0250',
      keywords: ['AG探针', '合并', '重复', '写入回执', '0.2.50', '探针', '新写一条', '分界'],
      importance: 1,
      level: 'fact',
    }),
  )
  const idOf = (t) => (t.match(/id=([\w-]{5,})/) ?? [])[1]
  check(
    'AG4 第一次是新写一条（没有那句「这是合并，不是新写一条」）',
    contractAG.rememberAnswerKind(agFirst) === 'ok' && !agFirst.includes('这是「合并」，不是「新写一条」'),
    `${contractAG.rememberAnswerKind(agFirst)}：${agFirst.slice(0, 50)}`,
  )
  check(
    'AG4 同样的话再写一遍时明说「合并」，并指出并进了哪一条、原内容被替换',
    contractAG.rememberAnswerKind(agSecond) === 'merged' &&
      agSecond.includes('这是「合并」，不是「新写一条」') &&
      agSecond.includes(idOf(agFirst) ?? '@@'),
    `${contractAG.rememberAnswerKind(agSecond)}：${agSecond.slice(0, 50)}`,
  )

  // 兜底：子插件一个字都不给时，融合层自己说话
  const legacyAG = {
    async call() {
      return { text: '', value: { ok: true, id: 'abcdefgh', level: 'fact' } }
    },
    async tryCall() {
      return legacyAG.call()
    },
    promptDeclarations: () => [],
  }
  const toolsAG = await createUnifiedToolsAG({
    bridge: legacyAG,
    config: { toolWaitMs: 10, linkWaitMs: 10, flushThrottleMs: 0 },
  })
  const bareAG = String(
    await toolsAG.find((t) => t.name === 'memory_remember').execute({ content: 'x', project: 'AG', keywords: ['a'], importance: 1 }, {}),
  )
  check(
    'AG5 子插件一个字都不给时，融合层自己说「没有任何回执」，不许让 ok:true 冒充满分',
    bareAG.includes('没有任何回执') && bareAG.includes('这不是「已经记住了」'),
    bareAG.slice(0, 60),
  )
}

// ── AH. 检索的空结果：层名没对上、只在某几层里查过、上游没回执（0.2.51）────────
{
  const contractAH = await import(pathToFileURL(join(root, 'lib', 'macro', 'contract.js')).href)
  const { createUnifiedTools: createUnifiedToolsAH } = await import(
    pathToFileURL(join(root, 'lib', 'macro', 'tools.js')).href
  )
  const BASE_AH = '如果冲突，以最新的为准。时间戳较旧的条目可作为事情发展过程的参考。'
  const R_LEVEL_NONE = `${BASE_AH}\n这次一条都没查：你给的层名「lessons」不在七层里（soul / user / project / fact / lesson / topic / rules）。这不是「记忆里没有」，是层名没对上——换成真实层名再查一次。`
  const R_LEVEL_PART = `${BASE_AH}\n这几个层名没生效：lessons（不在七层里）——这次只查了 fact 层。`
  const R_SCOPE = `${BASE_AH}\n这次只在 fact 层里查了，零命中：别的层就算有同关键词也看不到——要全层查就去掉 level 参数（默认 fact / lesson / topic / rules）。`
  const R_NOREPLY =
    '检索这次没有任何回执（既没有条目，也没说为什么没有）——这不是「记忆里没有这条」：换个关键词再查一次，或先用 memory_project 看一眼这个项目里到底有什么。'
  const pairsAH = [
    [R_LEVEL_NONE, 'levelNone'],
    [R_LEVEL_PART, 'levelPartial'],
    [R_SCOPE, 'scopeOnly'],
    [R_NOREPLY, 'noReply'],
    [`${BASE_AH}\n[fact] [0mwmxj9o] [刚刚] 关于：探针 / 记忆`, 'ok'],
  ]
  const wrongAH = pairsAH.filter(([t, want]) => contractAH.searchAnswerKind(t) !== want)
  check(
    'AH1 五种空结果各归各的：层名全错 / 部分层名失效 / 只在某几层查过 / 上游没回执 / 正常',
    wrongAH.length === 0,
    wrongAH.map(([t, want]) => `${want}→${contractAH.searchAnswerKind(t)}`).join(',') || pairsAH.map(([, w]) => w).join(','),
  )
  check(
    'AH1 层名全错那句自己就否认「记忆里没有」，并给出七层真名',
    contractAH.searchAnswerKind(R_LEVEL_NONE) === 'levelNone' &&
      R_LEVEL_NONE.includes('这不是「记忆里没有」') &&
      R_LEVEL_NONE.includes('不在七层里'),
    contractAH.searchAnswerKind(R_LEVEL_NONE),
  )

  // 真调用：层名写错（lessons 是 lesson 的复数）——原来过滤成空数组，零命中只说「以最新的为准」
  const ahNone = String(await run('memory_search', { query: 'AG探针', level: 'lessons' }))
  check(
    'AH2 层名一个都不认识时说「这次一条都没查」，并点出七层真名',
    contractAH.searchAnswerKind(ahNone) === 'levelNone' && ahNone.includes('不在七层里') && ahNone.includes('你给的层名'),
    `${contractAH.searchAnswerKind(ahNone)}：${ahNone.slice(0, 60)}`,
  )
  check(
    'AH2 并否认「记忆里没有」（否则读者以为库里真没有，回头再写一条重复的）',
    ahNone.includes('这不是「记忆里没有」') && !ahNone.includes('本次零命中'),
    ahNone.includes('记忆里没有') ? 'ok' : '缺',
  )

  // 真调用：一部分层名对、一部分不认识 → 只查了认识的，必须点名丢掉了哪些
  const ahPart = String(await run('memory_search', { query: 'AG探针', level: 'fact,lessons' }))
  check(
    'AH3 部分层名不认识时点名「这几个层名没生效」，并说清这次只查了哪几层',
    contractAH.searchAnswerKind(ahPart) === 'levelPartial' &&
      ahPart.includes('这几个层名没生效') &&
      ahPart.includes('lessons') &&
      ahPart.includes('这次只查了 fact 层'),
    `${contractAH.searchAnswerKind(ahPart)}：${ahPart.slice(0, 60)}`,
  )

  // 真调用：层名都对但零命中 → 说清「只在这几层里查过」，不是「库里没有」
  const ahScope = String(await run('memory_search', { query: '绝对不存在的词-0251-x', level: 'fact' }))
  check(
    'AH4 显式限定层却零命中时说「这次只在 fact 层里查了」，并给出「去掉 level 就全层查」的出路',
    contractAH.searchAnswerKind(ahScope) === 'scopeOnly' &&
      ahScope.includes('这次只在 fact 层里查了') &&
      ahScope.includes('去掉 level 参数'),
    `${contractAH.searchAnswerKind(ahScope)}：${ahScope.slice(0, 60)}`,
  )

  // 不显式给 level 的那条老话不能被顶掉
  const ahDefault = String(await run('memory_search', { query: '绝对不存在的词-0251-x' }))
  check(
    'AH5 没给 level 时仍是原来那句「本次零命中：默认检索范围是 fact/lesson/topic/rules」',
    contractAH.searchAnswerKind(ahDefault) === 'ok' && ahDefault.includes('本次零命中'),
    ahDefault.slice(0, 60),
  )

  // 兜底：上游一个字都不给时，融合层自己说话
  const silentAH = {
    async call() {
      return { text: '', value: { hits: [], note: '' } }
    },
    async tryCall() {
      return silentAH.call()
    },
    promptDeclarations: () => [],
  }
  const toolsAH = await createUnifiedToolsAH({
    bridge: silentAH,
    config: { toolWaitMs: 10, linkWaitMs: 10, flushThrottleMs: 0 },
  })
  const bareAH = String(await toolsAH.find((t) => t.name === 'memory_search').execute({ query: 'x' }, {}))
  check(
    'AH6 子插件一个字都不给时，融合层自己说「没有任何回执」，不许让空串冒充满分',
    bareAH.includes('检索这次没有任何回执') && bareAH.includes('这不是「记忆里没有这条」'),
    bareAH.slice(0, 60),
  )
}

// ── AM. 检索参数给错了：状态 / 时段 / 条数 / 截断各说各的（0.2.56）────────
{
  // 状态值拼错：原来 db.list 拿空 → 零命中，回执还按「默认检索范围」解释，读者以为记忆里没有
  const amStatus = String(await run('memory_search', { query: 'AG探针', status: 'done' }))
  check(
    'AM1 状态值一个都不认识时说「这次一条都没查」，并点明状态值没对上',
    amStatus.includes('状态值没对上') && amStatus.includes('你给的状态值「done」'),
    amStatus.slice(0, 80),
  )
  check(
    'AM2 并不许冒充「本次零命中：默认检索范围…」（那是另一件事）',
    amStatus.includes('这不是「记忆里没有」') && !amStatus.includes('本次零命中'),
    amStatus.includes('本次零命中') ? '又混进默认口径' : 'ok',
  )

  // 一半认识一半不认识：只按认识的过滤，但必须点名丢掉了哪个
  const amPart = String(await run('memory_search', { query: 'AG探针', status: 'stale,done' }))
  check(
    'AM3 部分状态值不认识时点名「这几个状态值没生效」，并说清只按哪些过滤',
    amPart.includes('这几个状态值没生效') && amPart.includes('done') && amPart.includes('这次只按 stale 过滤'),
    amPart.slice(0, 80),
  )

  // days 给 0 / 负数：过滤条件静默消失，读者以为限了时段
  const amDays = String(await run('memory_search', { query: 'AG探针', days: 0 }))
  check(
    'AM4 days 给 0 时说「这个过滤没生效，等于查了全部时段」',
    amDays.includes('days 给的是「0」') && amDays.includes('不是正数') && amDays.includes('没生效'),
    amDays.slice(0, 80),
  )

  // k / content_max 被夹到边界：一声不吭地换了数
  const amK = String(await run('memory_search', { query: 'AG探针', k: 100 }))
  check(
    'AM5 k 超出上限时说清这次按 50 条处理（不是默默改数）',
    amK.includes('k 给的是「100」') && amK.includes('超出 1–50') && amK.includes('按 50 条处理'),
    amK.slice(0, 80),
  )
  const amCm = String(await run('memory_search', { query: 'AG探针', content_max: -5 }))
  check(
    'AM6 content_max 越界时说清这次按 0 处理',
    amCm.includes('content_max 给的是「-5」') && amCm.includes('超出 0–5000') && amCm.includes('按 0 处理'),
    amCm.slice(0, 80),
  )

  // 参数都合法时不许冒出这些提示（否则天天喊狼来了）。用查不到的词，避免命中正文里自带这些字
  const amOk = String(await run('memory_search', { query: '绝对不存在的词-0256-ok', status: 'active', days: 30, k: 5, content_max: 100 }))
  const amOkBad = ['状态值没对上', '这几个状态值没生效', 'days 给的是', 'k 给的是', 'content_max 给的是'].filter((m) => amOk.includes(m))
  check(
    'AM7 参数都合法时一条提示都不加（老口径原样）',
    amOkBad.length === 0 && amOk.includes('本次零命中'),
    amOkBad.length === 0 ? 'ok' : amOkBad.join(','),
  )
}

// ── AO. 检索模式名给错了：不许静默换成另一种检索（0.2.58）──────────────────
{
  // 模式名拼错 / 大小写不对 / 用中文：老代码一律落进本地检索分支，
  // 写 graph 的人以为拿到的是沿关联扩散，实际拿到关键词命中——他会把它读成「图里就这么多」。
  const aoGraph = String(await run('memory_search', { query: 'AG探针', mode: 'expand' }))
  check(
    'AO1 mode 不认识时说「这次一条都没查」，并点明模式名没对上（不是「记忆里没有」）',
    aoGraph.includes('mode 没生效') && aoGraph.includes('「expand」') && aoGraph.includes('不是「记忆里没有」'),
    aoGraph.slice(0, 80),
  )
  check(
    'AO2 并给出对应关系（哪种意图用哪个词），而不是只报错',
    aoGraph.includes('沿关联扩散用 graph') && aoGraph.includes('similar + id'),
    aoGraph.includes('沿关联扩散用 graph') ? 'ok' : aoGraph.slice(0, 80),
  )

  const aoCn = String(await run('memory_search', { query: 'AG探针', mode: '相似' }))
  check(
    'AO3 中文模式名同样不执行、不静默降级',
    aoCn.includes('mode 没生效') && aoCn.includes('「相似」') && aoCn.includes('这次一条都没查'),
    aoCn.slice(0, 80),
  )

  // 只差大小写和前后空格：这是同一个模式名，必须照办，不许反过来骂人
  const aoTrim = String(await run('memory_search', { query: 'AG探针', mode: ' Graph ' }))
  check(
    'AO4 只差大小写与前后空格时当合法值：不许报「mode 没生效」',
    !aoTrim.includes('mode 没生效'),
    aoTrim.slice(0, 80),
  )

  // 参数给在了别的模式上：改动不了结果，但必须说一句
  const aoK = String(await run('memory_search', { query: 'AG探针', mode: 'graph', k: 20 }))
  check(
    'AO5 graph 模式给了 k：必须说清 k 这一问的处境（走星图没用到 / 空图退本地时真用上了），不许沉默',
    (aoK.includes('k 是本地检索的条数') || aoK.includes('k 这次真的用上了')) && !aoK.includes('k 这次没参与'),
    aoK.split('\n').slice(-1)[0].slice(0, 90),
  )
  const aoLimit = String(await run('memory_search', { query: 'AG探针', limit: 20, expand: false }))
  check(
    'AO6 本地检索给了 limit：说清它是 graph / bridge 的条数（0.2.65 起不再一律说「这次没用上 limit」）',
    aoLimit.includes('limit 是 graph / bridge 的条数') &&
      !aoLimit.includes('limit 只在 graph / bridge 模式生效'),
    aoLimit.slice(-140),
  )
  // 0.2.133 起扩散默认开：同一句 limit 的说法必须跟着默认值走，不能说成「没用上」
  const aoLimitOn = String(await run('memory_search', { query: 'AG探针', limit: 20 }))
  check(
    'AO6b 默认扩散下给了 limit：说清它这次真的被扩散用上了',
    aoLimitOn.includes('这次扩散真的用了它') && !aoLimitOn.includes('这次没有扩散'),
    aoLimitOn.slice(-140),
  )
  const aoWeight = String(await run('memory_search', { query: 'AG探针', min_weight: 0.3 }))
  check(
    'AO7 本地检索给了 min_weight：说清它只在 bridge 生效',
    aoWeight.includes('min_weight 只在 bridge 模式生效'),
    aoWeight.slice(0, 80),
  )
  const aoExpand = String(await run('memory_search', { query: 'AG探针', mode: 'graph', expand: true }))
  check(
    'AO8 graph 模式给了 expand：说清 expand 只在 local 生效',
    aoExpand.includes('expand 只在 local 模式生效'),
    aoExpand.slice(0, 80),
  )

  // 参数都合法、模式也没写错时，一句提示都不许冒（否则天天喊狼来了）
  const aoOk = String(await run('memory_search', { query: '绝对不存在的词-0258-ok' }))
  const aoNoise = ['mode 没生效', 'k 是本地检索的条数', 'limit 只在 graph', '只在 bridge 模式生效', 'expand 只在 local']
  check(
    'AO9 模式与参数都合法时，这些提示一句都不加',
    aoNoise.every((w) => !aoOk.includes(w)),
    aoNoise.filter((w) => aoOk.includes(w)).join(' / ') || 'ok',
  )
}

// ── AI. 读记忆：短 id 撞车不许替你挑一条 / 真没有说清工作区与位数（0.2.52）────────
{
  const contractAI = await import(pathToFileURL(join(root, 'lib', 'macro', 'contract.js')).href)
  const { createUnifiedTools: createUnifiedToolsAI } = await import(
    pathToFileURL(join(root, 'lib', 'macro', 'tools.js')).href
  )
  const R_AMB = '这个短 id 不止一条记忆：命中了 3 条（fact 0mwmz5l2「…」；lesson 0mwmzq74「…」；topic 0mwm6xoq「…」）。所以这次一条都没读——不是我替你挑第一条。把 id 给够位数（至少 8 位，最好整条）再读一次。'
  const R_NF = '这个工作区里一条都没有：id「0mzz」在七层表里都查不到。可能是拼错了、位数不够（短 id 至少 8 位）。'
  const R_NOREPLY =
    '读取这次没有任何回执（既没有正文，也没说为什么没有）——这不是「这条记忆是空的」：先用 memory_search 或 memory_project 确认 id，再读一次。'
  const pairsAI = [
    [R_AMB, 'ambiguous'],
    [R_NF, 'notFound'],
    [R_NOREPLY, 'noReply'],
    ['[fact] 标题（active）\n项目：x\n正文…\n如果冲突，以最新的为准。', 'ok'],
  ]
  const wrongAI = pairsAI.filter(([t, want]) => contractAI.readAnswerKind(t) !== want)
  check(
    'AI1 四种读结果各归各的：短 id 撞车 / 工作区里真没有 / 上游没回执 / 真读到了',
    wrongAI.length === 0,
    wrongAI.map(([t, want]) => `${want}→${contractAI.readAnswerKind(t)}`).join(',') || pairsAI.map(([, w]) => w).join(','),
  )
  check(
    'AI1 撞车那句自己否认「替你挑了第一条」，并要求给够位数',
    contractAI.readAnswerKind(R_AMB) === 'ambiguous' &&
      R_AMB.includes('不是我替你挑第一条') &&
      R_AMB.includes('至少 8 位'),
    contractAI.readAnswerKind(R_AMB),
  )

  // 真调用：两位前缀会撞上一堆记忆——原来静默取第一条，把别人的正文递回来
  const aiAmb = String(await run('memory_read', { id: '0m' }))
  check(
    'AI2 两位前缀撞车时明说「不止一条」「不是我替你挑第一条」，且不递正文',
    contractAI.readAnswerKind(aiAmb) === 'ambiguous' &&
      aiAmb.includes('不是我替你挑第一条') &&
      !aiAmb.includes('（active）'),
    `${contractAI.readAnswerKind(aiAmb)}：${aiAmb.slice(0, 50)}`,
  )
  check(
    'AI2 并给出够位数/整条 id 的出路（而不是让人继续猜）',
    aiAmb.includes('至少 8 位') && aiAmb.includes('命中了'),
    aiAmb.slice(0, 40),
  )

  // 真调用：压根不存在的 id
  const aiNf = String(await run('memory_read', { id: '0mzzzzzz-0252' }))
  check(
    'AI3 查无此 id 时说「这个工作区里一条都没有」，并点出工作区隔离与位数',
    contractAI.readAnswerKind(aiNf) === 'notFound' &&
      aiNf.includes('这个工作区里一条都没有') &&
      aiNf.includes('别的 cwd 会话') &&
      aiNf.includes('至少 8 位'),
    `${contractAI.readAnswerKind(aiNf)}：${aiNf.slice(0, 50)}`,
  )
  check(
    'AI3 不再把「拼错 / 别的工作区 / 已删除」混进一句没有信息量的「未找到」',
    aiNf.includes('记忆库按工作区分开存') && !aiNf.includes('这个短 id 不止一条记忆'),
    '工作区说明在场',
  )

  // 真调用：唯一 id 正常读，正文与项目都在（不能因为加了口径把正常路径弄坏）
  const aiWrote = String(await run('memory_remember', { content: 'AI 探针 0252：读记忆的短 id 撞车口径', level: 'fact', project: 'AI探针项目0252', importance: 1, keywords: ['短id', '撞车', '歧义', '读记忆', '口径', '前缀', '工作区', '探针'] }))
  const aiId = (aiWrote.match(/id=([\w-]{5,})/) ?? [])[1] ?? ''
  const aiOk = String(await run('memory_read', { id: aiId.slice(0, 8) }))
  check(
    'AI4 唯一 8 位前缀照常读出正文（口径收紧不误伤正常读）',
    contractAI.readAnswerKind(aiOk) === 'ok' && aiOk.includes('AI 探针 0252') && aiOk.includes('AI探针项目0252'),
    `${contractAI.readAnswerKind(aiOk)}：${aiOk.slice(0, 50)}`,
  )

  // 兜底：上游一个字都不给时，融合层自己说话
  const silentAI = {
    async call() {
      return { text: '', value: { found: true } }
    },
    async tryCall() {
      return silentAI.call()
    },
    promptDeclarations: () => [],
  }
  const toolsAI = await createUnifiedToolsAI({
    bridge: silentAI,
    config: { toolWaitMs: 10, linkWaitMs: 10, flushThrottleMs: 0 },
  })
  const bareAI = String(await toolsAI.find((t) => t.name === 'memory_read').execute({ id: 'x' }, {}))
  check(
    'AI5 子插件一个字都不给时，融合层自己说「没有任何回执」，不许让空串冒充满分',
    bareAI.includes('读取这次没有任何回执') && bareAI.includes('这不是「这条记忆是空的」'),
    bareAI.slice(0, 50),
  )
}

// ── AJ. 相似检索的基准：短 id 撞车不许拿别人的正文当基准（0.2.53）────────────
{
  const contractAJ = await import(pathToFileURL(join(root, 'lib', 'macro', 'contract.js')).href)
  const S_AMB =
    '相似检索未完成：memory_find_similar: 相似检索这次一条都没比：这个短 id 命中了 3 条（fact 0mwmz5l2「…」；lesson 0mwmzq74「…」；topic 0mwm6xoq「…」）。不是我替你挑第一条——基准挑错，比出来的相似度全是错的。把 id 给够位数（至少 8 位，最好整条）再试。'
  const S_NF =
    '相似检索未完成：memory_find_similar: 相似检索没起点——这个工作区里一条都没有：id「0mzz」在七层表里都查不到（记忆库按工作区分开存，当前工作区 x）。'
  const pairsAJ = [
    [S_AMB, 'ambiguous'],
    [S_NF, 'notFound'],
    ['[fact 0mwmz5l2] 相似度 0.731 标题 正文…\n如果冲突，以最新的为准。', 'ok'],
  ]
  const wrongAJ = pairsAJ.filter(([t, want]) => contractAJ.similarAnswerKind(t) !== want)
  check(
    'AJ1 三种相似检索结果各归各的：基准撞车 / 基准没起点 / 真比出来了',
    wrongAJ.length === 0,
    wrongAJ.map(([t, want]) => `${want}→${contractAJ.similarAnswerKind(t)}`).join(',') || pairsAJ.map(([, w]) => w).join(','),
  )
  check(
    'AJ1 撞车那句自己说清「基准挑错，分数全是错的」，不冒充「没有相似」',
    contractAJ.similarAnswerKind(S_AMB) === 'ambiguous' &&
      S_AMB.includes('基准挑错，比出来的相似度全是错的') &&
      !S_AMB.includes('记忆里没有相似'),
    contractAJ.similarAnswerKind(S_AMB),
  )

  // 真调用：两位前缀必撞——原来静默取第一条，拿别人的正文当基准算相似度，结果看着完全正常
  const ajAmb = String(await run('memory_search', { mode: 'similar', id: '0m' }))
  check(
    'AJ2 基准短 id 撞车时明说「一条都没比」，并点出基准挑错会算错分数',
    contractAJ.similarAnswerKind(ajAmb) === 'ambiguous' &&
      ajAmb.includes('相似检索这次一条都没比') &&
      ajAmb.includes('基准挑错，比出来的相似度全是错的'),
    `${contractAJ.similarAnswerKind(ajAmb)}：${ajAmb.slice(0, 60)}`,
  )
  check(
    'AJ2 且不给出任何「相似度 0.xxx」的假分数（宁可不比，也不比错的）',
    !/相似度\s*0\.\d+/.test(ajAmb) && ajAmb.includes('至少 8 位'),
    ajAmb.slice(0, 60),
  )

  // 真调用：压根不存在的 id
  const ajNf = String(await run('memory_search', { mode: 'similar', id: '0mzzzzzz-0253' }))
  check(
    'AJ3 基准查无此 id 时说「相似检索没起点」，并点出工作区隔离与位数',
    contractAJ.similarAnswerKind(ajNf) === 'notFound' &&
      ajNf.includes('相似检索没起点') &&
      ajNf.includes('记忆库按工作区分开存') &&
      ajNf.includes('先用 memory_search 反查 id'),
    `${contractAJ.similarAnswerKind(ajNf)}：${ajNf.slice(0, 60)}`,
  )

  // 正常路径：给到整条 id 时照常比（口径收紧不误伤）
  const ajWrote = String(
    await run('memory_remember', {
      content: `AJ 探针 0253：相似检索的基准短 id 撞车口径 ${Date.now()}`,
      level: 'fact',
      project: 'AJ探针项目0253',
      importance: 1,
      keywords: ['相似检索', '基准', '短id', '撞车', '歧义', '口径', '探针', '分数'],
    }),
  )
  const ajHit = String(await run('memory_search', { query: 'AJ 探针 0253', project: 'AJ探针项目0253' }))
  const ajId = (ajHit.match(/\[([\w-]{8,})\]/) ?? [])[1] ?? ajWrote.match(/id=([\w-]{5,})/)?.[1] ?? ''
  const ajOk = String(await run('memory_search', { mode: 'similar', id: ajId }))
  const ajOkKind = contractAJ.similarAnswerKind(ajOk)
  check(
    'AJ4 整条 id 照常走到「比了一遍」（没被误判成基准撞车/没起点）',
    (ajOkKind === 'ok' || ajOkKind === 'notComputed' || ajOkKind === 'none') &&
      !ajOk.includes('相似检索这次一条都没比') &&
      !ajOk.includes('相似检索没起点'),
    `${ajOkKind}：${ajOk.slice(0, 60)}`,
  )
}

// ── AK. 连线归一：撞车 / 没查成 / 真没有，三句各说各的（0.2.54）──────────────
{
  const { createUnifiedTools } = await import(pathToFileURL(join(root, 'lib/macro/tools.js')).href)
  const linksAK = await import(pathToFileURL(join(root, 'lib/macro/links.js')).href)
  const ID_AK = '0mwmz5l2-ak54-0000-0000-00000000ak54'
  const AMB_NOTE =
    '这个短 id 不止一条记忆：命中了 3 条（fact 0mwmz5l2「甲」；lesson 0mwmzq74「乙」；topic 0mwm6xoq「丙」）。所以这次一条都没读——不是我替你挑第一条。把 id 给够位数（至少 8 位，最好整条）再读一次。'

  /** readKind: 'ambiguous' 撞车 / 'down' 没接上 / 'missing' 真没有 */
  function stubAK({ readKind }) {
    const entries = new Map()
    const calls = []
    const add = (name, fn) => entries.set(name, { name, vendor: 'stub', def: { name, execute: fn }, options: {} })
    add('memory_read', async (args) => {
      if (readKind === 'down') throw new Error('memory_read 没装配')
      if (readKind === 'ambiguous')
        return {
          found: false,
          ambiguous: true,
          id: String(args.id),
          candidates: 'fact 0mwmz5l2「甲」；lesson 0mwmzq74「乙」；topic 0mwm6xoq「丙」',
          note: AMB_NOTE,
        }
      return { found: false }
    })
    add('nebula_inspect', async (args) => ({ id: args.id, text: '## 连接到的记忆\n- node' }))
    add('nebula_link', async (args) => {
      calls.push(args)
      return `已固化连线：${args.a} ↔ ${args.b}`
    })
    const bridge = {
      has: (n) => entries.has(n),
      get: (n) => entries.get(n),
      names: () => [...entries.keys()],
      awaitTool: async (n) => entries.get(n),
      async call(name, args) {
        const e = entries.get(name)
        if (!e) throw new Error('not ready')
        const value = await e.def.execute(args)
        return { entry: e, def: e.def, value, text: typeof value === 'string' ? value : JSON.stringify(value) }
      },
      async tryCall(name, args) {
        try {
          return await bridge.call(name, args)
        } catch (err) {
          return { entry: undefined, def: undefined, value: undefined, text: `未完成：${err.message}` }
        }
      },
      promptDeclarations: () => [],
    }
    return { bridge, calls }
  }
  const resetAK = () => {
    for (const e of linksAK.readPending()) linksAK.dropPending(e.a, e.b)
  }
  const toolAK = (bridge, name) =>
    createUnifiedTools({ bridge, config: { toolWaitMs: 10, linkWaitMs: 10, flushThrottleMs: 0 } }).find((t) => t.name === name)

  // AK1: 短 id 撞车 → 一条都不连，且不许说成「它没了」
  resetAK()
  {
    const { bridge, calls } = stubAK({ readKind: 'ambiguous' })
    const out = String(await toolAK(bridge, 'memory_link').execute({ action: 'link', a: '0m1', b: '0m2' }, {}))
    check(
      'AK1 连线时短 id 撞车：明说「这次没做」，并要你补够位数',
      out.includes('星图连线这次没做') && out.includes('至少 8 位') && out.includes('连错一条比没连上更难发现'),
      out.split('\n')[0].slice(0, 70),
    )
    check(
      'AK1 且不冒充「这条记忆不存在」，星图一次都没被调',
      !out.includes('没有这条记忆') && !out.includes('找不到这条记忆') && calls.length === 0,
      `calls=${calls.length}`,
    )
  }

  // AK2: meow 没接上（连「有没有」都不知道）→ 不许说成「它没了」
  resetAK()
  {
    const { bridge, calls } = stubAK({ readKind: 'down' })
    const out = String(await toolAK(bridge, 'memory_link').execute({ action: 'link', a: ID_AK, b: '0m2' }, {}))
    check(
      'AK2 读记忆的工具没接上：说「这次没查成」，并否认「这条记忆不存在」',
      out.includes('这次没查成') && out.includes('这不是「这条记忆不存在」') && calls.length === 0,
      out.split('\n').slice(0, 2).join(' / ').slice(0, 100),
    )
  }

  // AK3: 补连队列遇撞车 → 留着（原来 `resolve===null` 就摘，还报「永远连不上」）
  resetAK()
  {
    linksAK.queuePending(ID_AK, '0m2', 'n', '节点待入图')
    const round = await linksAK.flushPending({
      tryCall: async () => ({ entry: {}, text: '已固化连线：x ↔ y' }),
      isLinked: linksAK.isLinkedText,
      resolve: async () => ({ kind: 'ambiguous', id: '0m2', note: AMB_NOTE }),
      budgetMs: 1200,
      limit: 5,
    })
    check(
      'AK3 撞车的条目留在队列里，且单独计数（不算 dropped）',
      round.ambiguous === 1 && round.dropped === 0 && linksAK.pendingCount() === 1,
      JSON.stringify(round),
    )
    const panel = String(await toolAK(stubAK({ readKind: 'ambiguous' }).bridge, 'memory_admin').execute({ action: 'links' }, {}))
    check(
      'AK3 面板如实报「没连也没摘」，不报「清掉」',
      panel.includes('短 id 不止一条记忆') && panel.includes('没连也没摘') && !panel.includes('清掉'),
      panel.split('\n').slice(-1)[0].slice(0, 90),
    )
  }

  // AK4: 补连队列遇「没查成」→ 留着
  resetAK()
  {
    linksAK.queuePending(ID_AK, '0m2', 'n', '节点待入图')
    const round = await linksAK.flushPending({
      tryCall: async () => ({ entry: {}, text: '已固化连线：x ↔ y' }),
      isLinked: linksAK.isLinkedText,
      resolve: async () => ({ kind: 'unavailable', id: '0m2', note: 'memory_read 没装配' }),
      budgetMs: 1200,
      limit: 5,
    })
    check(
      'AK4 没查成的条目也留在队列里，单独计数',
      round.unavailable === 1 && round.dropped === 0 && linksAK.pendingCount() === 1,
      JSON.stringify(round),
    )
    const panel = String(await toolAK(stubAK({ readKind: 'down' }).bridge, 'memory_admin').execute({ action: 'links' }, {}))
    check(
      'AK4 面板说「原样留着下次再试」，不报「清掉」',
      panel.includes('原样留着下次再试') && !panel.includes('清掉'),
      panel.split('\n').slice(-1)[0].slice(0, 90),
    )
  }

  // AK5: 真没有还是照摘（口径收紧不误伤），老的 resolve=null 也认
  resetAK()
  {
    linksAK.queuePending(ID_AK, '0m2', 'n', '节点待入图')
    const round = await linksAK.flushPending({
      tryCall: async () => ({ entry: {}, text: '已固化连线：x ↔ y' }),
      isLinked: linksAK.isLinkedText,
      resolve: async (id) => (String(id) === '0m2' ? null : String(id)),
      budgetMs: 1200,
      limit: 5,
    })
    check(
      'AK5 真没有的条目照旧摘掉（旧 resolve=null 的那条路没被这一刀弄坏）',
      round.dropped === 1 && round.ambiguous === 0 && round.unavailable === 0 && linksAK.pendingCount() === 0,
      JSON.stringify(round),
    )
  }
  resetAK()
}

// ── AL. 账本 / 队列「空着」的四种来路（0.2.55）──────────────────────────────
// 这一段的判据不在源码里，在**文件系统上**：把 DSH_HOME 指到临时目录，再故意造出
// 「从没写过」「整份坏行」「读不出来（目录当文件）」「写不进去」四种现实故障。
// 以前的实现只有一句「还没记过账 / 0 条，都连上了」，四种来路共用它。
{
  const costMod = await import(pathToFileURL(join(root, 'lib', 'macro', 'cost.js')).href)
  const linksMod = await import(pathToFileURL(join(root, 'lib', 'macro', 'links.js')).href)
  const oldHome = process.env.DSH_HOME
  const alHome = mkdtempSync(join(tmpdir(), 'probe-al55-'))
  mkdirSync(join(alHome, 'macro-memory'), { recursive: true })
  process.env.DSH_HOME = alHome
  try {
    const costFile = costMod.ledgerPath()
    const queueFile = linksMod.pendingPath()

    // AL1 真的从没记过账
    const al1 = costMod.costReport()
    check(
      'AL1 从没记过账时说「还没记过账」，不冒充「写不进去」',
      al1.includes('还没记过账') && !al1.includes('写不进去'),
      al1.split('\n')[0].slice(0, 60),
    )

    // AL2 账本在，但整份是坏行
    writeFileSync(costFile, 'not json\n{broken\n', 'utf8')
    const al2 = costMod.costReport()
    check(
      'AL2 账本整份坏行时说「一行都解析不出来」，不说没记过账',
      al2.includes('一行都解析不出来') && !al2.includes('还没记过账'),
      al2.split('\n')[0].slice(0, 60),
    )

    // AL3 账本在，但这次读不出来（把账本位置做成目录：读是 EISDIR）
    rmSync(costFile, { force: true })
    mkdirSync(costFile)
    const al3 = costMod.costReport()
    check(
      'AL3 账本读不出来时说「不是账本是空的」',
      al3.includes('这次读不出来') && al3.includes('不是账本是空的') && !al3.includes('还没记过账'),
      al3.split('\n')[0].slice(0, 60),
    )

    // AL4 调用发生了，但一行都写不进去
    costMod.recordCall({ tool: 'memory_search', ok: true, argsChars: 1, resultChars: 1, ms: 1 })
    const al4 = costMod.costReport()
    check(
      'AL4 记账写不进去时说「不是你还没调用工具」',
      al4.includes('一行都没写进去') && al4.includes('这不是「你还没调用工具」'),
      al4.split('\n')[0].slice(0, 60),
    )
    rmSync(costFile, { recursive: true, force: true })

    // AL5 队列在，但整份是坏行
    writeFileSync(queueFile, 'bad\n', 'utf8')
    const al5 = linksMod.pendingReport()
    check(
      'AL5 队列整份坏行时说「不是没有欠账，是队列坏了」',
      al5.includes('一行都解析不出来') && al5.includes('不是没有欠账'),
      al5.split('\n')[0].slice(0, 60),
    )

    // AL6 队列在，但这次读不出来
    rmSync(queueFile, { force: true })
    mkdirSync(queueFile)
    const al6 = linksMod.pendingReport()
    check(
      'AL6 队列读不出来时说「不是都连上了、没有欠账」',
      al6.includes('这次读不出来') && al6.includes('不是「都连上了、没有欠账」'),
      al6.split('\n')[0].slice(0, 60),
    )

    // AL7 排队发生了，但一条都没存下来
    linksMod.queuePending('0m1', '0m2', 'n', '节点待入图')
    const al7 = linksMod.pendingReport()
    check(
      'AL7 队列写不进去时说「一条都没存下来」，不说没有欠账',
      al7.includes('一条都没存下来') && al7.includes('不是「没有欠账」'),
      al7.split('\n')[0].slice(0, 60),
    )

    // AL8 写成功之后旧账要清零：真的空队列仍走原来那句
    rmSync(queueFile, { recursive: true, force: true })
    linksMod.queuePending('0m3', '0m4', 'n', '节点待入图')
    rmSync(queueFile, { force: true })
    const al8 = linksMod.pendingReport()
    check(
      'AL8 写成功过之后，真空队列仍说原来那句「0 条」',
      al8.includes('待补连线：0 条（星图那边都连上了，没有欠账）'),
      al8.split('\n')[0].slice(0, 60),
    )
  } finally {
    if (oldHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = oldHome
    rmSync(alHome, { recursive: true, force: true })
  }
}

// ── AP. 连线的动作名与两端 id：缺了先挡住，给错动作的参数要说没用上（0.2.59）──────
{
  const { createUnifiedTools: makeAP } = await import(pathToFileURL(join(root, 'lib/macro/tools.js')).href)
  const linksAP = await import(pathToFileURL(join(root, 'lib/macro/links.js')).href)
  const ID_A = '0mwmz5l2-ap59-0000-0000-00000000ap59'
  const ID_B = '0mwm6xoq-ap59-0000-0000-00000000ap59'

  const stubAP = () => {
    const entries = new Map()
    const calls = []
    const add = (name, fn) => entries.set(name, { name, vendor: 'stub', def: { name, execute: fn }, options: {} })
    add('memory_read', async (args) => ({ found: true, id: String(args.id), text: '正文' }))
    add('nebula_link', async (args) => {
      calls.push(args)
      return `已固化连线：${args.a} ↔ ${args.b}`
    })
    add('nebula_path', async (args) => {
      calls.push(args)
      return '这两条记忆之间没有连上的证据链。'
    })
    const bridge = {
      has: (n) => entries.has(n),
      get: (n) => entries.get(n),
      names: () => [...entries.keys()],
      awaitTool: async (n) => entries.get(n),
      async call(name, args) {
        const e = entries.get(name)
        if (!e) throw new Error('not ready')
        const value = await e.def.execute(args)
        return { entry: e, def: e.def, value, text: typeof value === 'string' ? value : JSON.stringify(value) }
      },
      async tryCall(name, args) {
        try {
          return await bridge.call(name, args)
        } catch (err) {
          return { entry: undefined, def: undefined, value: undefined, text: `未完成：${err.message}` }
        }
      },
      promptDeclarations: () => [],
    }
    return { bridge, calls }
  }
  const resetAP = () => {
    for (const e of linksAP.readPending()) linksAP.dropPending(e.a, e.b)
  }
  const toolAP = (bridge, name) =>
    makeAP({ bridge, config: { toolWaitMs: 10, linkWaitMs: 10, flushThrottleMs: 0 } }).find((t) => t.name === name)

  // AP1: 少给 b —— 原来这句会变成「暂时没落图，已排队」，还排一条永远连不上的欠账
  resetAP()
  {
    const { bridge, calls } = stubAP()
    const out = String(await toolAP(bridge, 'memory_link').execute({ action: 'link', a: ID_A }, {}))
    check(
      'AP1 少给 b：明说「这次一条都没动」并点名缺 b',
      out.includes('memory_link(link) 这次一条都没动') && out.includes('缺 b'),
      out.split('\n')[0].slice(0, 70),
    )
    check('AP1 不许冒充「已排队」', !out.includes('已排队'), out.split('\n')[0].slice(0, 60))
    check('AP1 星图一次都没被调', calls.length === 0, String(calls.length))
    check('AP1 也没排欠账', linksAP.readPending().length === 0, String(linksAP.readPending().length))
  }

  // AP2: 两端都给成空串
  resetAP()
  {
    const { bridge } = stubAP()
    const out = String(await toolAP(bridge, 'memory_link').execute({ action: 'link', a: '  ', b: '' }, {}))
    check(
      'AP2 空串也算没给：缺 a、缺 b 都要点出来',
      out.includes('缺 a') && out.includes('缺 b'),
      out.split('\n')[0].slice(0, 70),
    )
  }

  // AP3: 动作名写错
  {
    const { bridge, calls } = stubAP()
    const out = String(await toolAP(bridge, 'memory_link').execute({ action: 'delete', a: ID_A, b: ID_B }, {}))
    check(
      'AP3 动作名写错：说清给的是什么、只认哪五个、星图和记忆都没动',
      out.includes('action 给的是「delete」') && out.includes('只认 link / unlink / mute / unmute / path') && out.includes('星图和记忆都没动'),
      out.split('\n')[0].slice(0, 70),
    )
    check('AP3 附上五个动作的对应关系', out.includes('解释两条记忆之间的证据链用 path'), out.split('\n').slice(-1)[0].slice(0, 50))
    check('AP3 星图一次都没被调', calls.length === 0, String(calls.length))
  }

  // AP4: 连 action 都没给
  {
    const { bridge } = stubAP()
    const out = String(await toolAP(bridge, 'memory_link').execute({ a: ID_A, b: ID_B }, {}))
    check('AP4 没给 action：说不许空着，并列出五个动作', out.includes('没给 action') && out.includes('link / unlink / mute / unmute / path'), out.split('\n')[0].slice(0, 70))
  }

  // AP5: 只差大小写与空格 —— 归一后照办，不许报「没动」
  resetAP()
  {
    const { bridge, calls } = stubAP()
    const out = String(await toolAP(bridge, 'memory_link').execute({ action: ' LINK ', a: ID_A, b: ID_B }, {}))
    check('AP5 只差大小写与空格时照办，不报「一条都没动」', !out.includes('这次一条都没动') && calls.length === 1, out.split('\n')[0].slice(0, 60))
  }

  // AP6/AP7/AP8: 参数给错了动作要说「没用上」，合法时一句都不加
  resetAP()
  {
    const { bridge } = stubAP()
    const out = String(await toolAP(bridge, 'memory_link').execute({ action: 'link', a: ID_A, b: ID_B, maxHops: 4 }, {}))
    check('AP6 maxHops 给了 link：说清只有 path 用得上', out.includes('maxHops 只在 path 这个动作生效'), out.split('\n').slice(-1)[0].slice(0, 60))
  }
  resetAP()
  {
    const { bridge } = stubAP()
    const out = String(await toolAP(bridge, 'memory_link').execute({ action: 'unlink', a: ID_A, b: ID_B, note: '理由' }, {}))
    check('AP7 note 给了 unlink：说清只有 link / mute 会存', out.includes('note 只有 link / mute 会存下来'), out.split('\n').slice(-1)[0].slice(0, 60))
  }
  resetAP()
  {
    const { bridge } = stubAP()
    const out = String(await toolAP(bridge, 'memory_link').execute({ action: 'link', a: ID_A, b: ID_B, note: 'n' }, {}))
    check(
      'AP8 参数都合适时一句尾注都不加（防狼来了）',
      !out.includes('maxHops 只在') && !out.includes('note 只有 link'),
      out.split('\n')[0].slice(0, 60),
    )
  }
  resetAP()
}

// ── AQ. 卡片抬头：动作键不许冒充名字，只读的 path 不许标成写（0.2.60）────────────
{
  const { createUnifiedTools: makeAQ } = await import(pathToFileURL(join(root, 'lib/macro/tools.js')).href)
  const panelAQ = await import(pathToFileURL(join(root, 'lib/macro/panel.js')).href)
  const bridgeAQ = {
    has: () => false,
    get: () => undefined,
    names: () => [],
    awaitTool: async () => undefined,
    async call() {
      throw new Error('这个探针不碰外部服务')
    },
    async tryCall() {
      return { entry: undefined, def: undefined, value: undefined, text: '未完成：这个探针不碰外部服务' }
    },
    promptDeclarations: () => [],
  }
  const listAQ = makeAQ({ bridge: bridgeAQ, config: { toolWaitMs: 10, linkWaitMs: 10, flushThrottleMs: 0 } })
  const card = (name, args) => {
    const t = listAQ.find((x) => x.name === name)
    if (!t || typeof t.presentCall !== 'function') throw new Error(`找不到 ${name} 的 presentCall`)
    return t.presentCall(args ?? {})
  }
  const eight = [
    ['memory_remember', { project: '探针项目' }],
    ['memory_update', { id: '0m1abc' }],
    ['memory_search', { query: '探针' }],
    ['memory_read', { id: '0m1abc' }],
    ['memory_project', { project: '探针项目' }],
    ['memory_link', { action: 'link', a: '0m1abc', b: '0m2def' }],
    ['memory_dream', {}],
    ['memory_admin', { action: 'cost' }],
  ]
  const cards = eight.map(([n, a]) => [n, card(n, a)])

  check(
    'AQ1 八个工具都有卡片标题，且都没有 undefined / null 这类裸值',
    cards.every(([, c]) => typeof c.title === 'string' && c.title.length > 0) &&
      !cards.some(([, c]) => /undefined|null|NaN/.test(c.title)),
    cards.map(([n, c]) => `${n}=${c.title}`).join(' | ').slice(0, 120),
  )
  check(
    'AQ2 标题不留悬空冒号（参数没给时只剩前缀）',
    !cards.some(([, c]) => /[：:]\s*$/.test(c.title)) && card('memory_read', {}) .title === '读取记忆' && card('memory_project', {}).title === '项目全景',
    cards.map(([, c]) => c.title).join(' | ').slice(0, 120),
  )
  check(
    'AQ3 连线的 path 是只读：标题说人话，kind 不许标成 write',
    card('memory_link', { action: 'path', a: '0m1abc', b: '0m2def' }).kind === 'read' &&
      card('memory_link', { action: 'path', a: '0m1abc', b: '0m2def' }).title.includes('看证据链') &&
      !card('memory_link', { action: 'path', a: '0m1abc', b: '0m2def' }).title.includes('path'),
    card('memory_link', { action: 'path', a: '0m1abc', b: '0m2def' }).title,
  )
  check(
    'AQ4 连线的写动作：中文名 + 两端 id，kind=write',
    card('memory_link', { action: 'link', a: '0m1abc', b: '0m2def' }).kind === 'write' &&
      card('memory_link', { action: 'link', a: '0m1abc', b: '0m2def' }).title.includes('连一条手工线') &&
      card('memory_link', { action: 'link', a: '0m1abc', b: '0m2def' }).title.includes('0m1abc ↔ 0m2def'),
    card('memory_link', { action: 'link', a: '0m1abc', b: '0m2def' }).title,
  )
  check(
    'AQ5 连线动作名没对上：标题不许冒出参数键或 undefined',
    card('memory_link', {}).title.includes('动作名没对上') && !/undefined/.test(card('memory_link', {}).title),
    card('memory_link', {}).title,
  )
  check(
    'AQ6 检索的模式是中文名：graph 不许原样贴上卡片',
    card('memory_search', { mode: 'graph', query: '探针' }).title.includes('沿关联扩散') &&
      !card('memory_search', { mode: 'graph', query: '探针' }).title.includes('graph') &&
      card('memory_search', {}).title === '检索记忆：本地检索',
    card('memory_search', { mode: 'graph', query: '探针' }).title,
  )
  check(
    'AQ7 检索模式写错时卡片说「模式名没对上」，不给英文键',
    card('memory_search', { mode: 'expand' }).title.includes('模式名没对上'),
    card('memory_search', { mode: 'expand' }).title,
  )
  const longQ = '词'.repeat(60)
  const longTitle = card('memory_search', { query: longQ }).title
  check(
    'AQ8 长检索词截断到一行（40 字 + 省略号），别把卡片撑爆',
    longTitle === panelAQ.cardTitle('检索记忆', `本地检索 · ${longQ}`) &&
      longTitle.length <= panelAQ.CARD_DETAIL_MAX + 20 &&
      longTitle.endsWith('…'),
    `${longTitle.length} 字：${longTitle.slice(0, 45)}`,
  )
  check(
    'AQ9 运维面板用表里的中文名，不给 action 键',
    card('memory_admin', { action: 'cost' }).title.includes('成本账本') && !card('memory_admin', { action: 'cost' }).title.includes('cost'),
    card('memory_admin', { action: 'cost' }).title,
  )
  check(
    'AQ10 多行参数压成一行（不留换行把卡片顶成两行）',
    !card('memory_search', { query: '第一行\n第二行' }).title.includes('\n'),
    JSON.stringify(card('memory_search', { query: '第一行\n第二行' }).title),
  )
}

// ── H. 原文优先：检索/读取返回的记忆正文一个字都不能被改口（0.2.14）───────────
const brandMod = await import(pathToFileURL(join(root, 'lib', 'macro', 'brand.js')).href)
const CONTENT = '原文保真：nebula_recall 和 meow-memory 这两个名字不许被改口。'
const wrote = await run('memory_remember', {
  content: CONTENT,
  project: 'meow-memory',
  keywords: ['原文保真', 'nebula_recall', 'meow-memory', '改口', 'brand', '探针', '诊断', 'macro'],
  importance: 1,
  level: 'fact',
})
check('H1 写入含旧名的记忆成功', text(wrote).includes('记忆已写入') || text(wrote).includes('已合并'), text(wrote).split('\n')[0])

const found = await run('memory_search', { query: '原文保真' })
check('H2 search 的正文里仍是原文（nebula_recall / meow-memory 都在）', text(found).includes('nebula_recall') && text(found).includes('meow-memory'), text(found).slice(0, 80))
check('H2 search 末尾带上「原文没被改」的说明', text(found).includes(brandMod.ORIGINAL_MARK))

const foundId = (text(found).match(/\[([\w-]{5,})\]/) ?? [])[1]
if (foundId) {
  const got = await run('memory_read', { id: foundId })
  const body = text(got).split('\n').filter((l) => l.includes('原文保真')).join(' ')
  check('H3 read 的记忆正文与写入时逐字一致', body.includes(CONTENT), body.slice(0, 90))
  check('H3 read 也带上「原文没被改」的说明', text(got).includes(brandMod.ORIGINAL_MARK))
  const again = await run('memory_read', { id: foundId })
  check('H4 反复读不会把对照说明叠成两条', (text(again).match(/一个字没动/g) ?? []).length === 1)
}

check('H5 界面文案该改口还得改口', brandMod.brandText('nebula_recall') === 'memory_search（mode="graph"）', brandMod.brandText('nebula_recall'))
check('H6 原文路径不改口、且只加一条对照', (() => {
  const once = brandMod.withNameHints('nebula_recall 在库里')
  const twice = brandMod.withNameHints(once)
  return once.includes('nebula_recall 在库里') && once !== 'nebula_recall 在库里' && once === twice
})())
check('H7 compatAliases 开着时原样返回', brandMod.withNameHints('nebula_recall', { aliases: true }) === 'nebula_recall')

// ── I. 透传面：meow 的非工具能力不许被 facade 吞掉，也不许绕过融合层直挂宿主（0.2.15）──
const bridgeMod = await import(pathToFileURL(join(root, 'lib', 'macro', 'bridge.js')).href)

check('I1 meow 的命令还挂得上宿主（/dream 与 /trust 至少两条）', registeredCommands.length >= 2, String(registeredCommands.length))
check('I2 /dream 命令里有 dream 字样', JSON.stringify(registeredCommands).includes('dream'))
check('I3 dream 图标数据路由还挂得上宿主', registeredRoutes.some((r) => String(r?.path).includes('/meow-memory/dreamed-sessions')), registeredRoutes.map((r) => r?.path).join(','))
check('I3b dream 事件路由也挂上了', registeredRoutes.some((r) => String(r?.path).includes('/meow-memory/dream-events')))
check('I4 meow 的会话钩子原样到达宿主', ctxEvents.includes('session/event') && ctxEvents.includes('agent/pre-step') && ctxEvents.includes('agent/turn-stopping'), ctxEvents.join(','))

// 合成一个「想绕过融合层」的子插件：走 ctx.get('tools') / ctx.get('systemPrompt') 直挂
const shadowTools = []
const shadowPrompts = []
const shadowBridge = bridgeMod.createBridge({})
let shadowCtx = null
const shadowPlugin = bridgeMod.wrapPlugin(
  {
    apply(ctx) {
      shadowCtx = ctx
      ctx.get('tools').register({ name: 'shadow_tool', description: '想绕过融合层', execute: async () => ({ ok: true }) })
      ctx.get('systemPrompt').section({ name: 'shadow_section', text: '想绕过注入归口' })
      return undefined
    },
  },
  shadowBridge,
  'meow',
)
shadowPlugin.apply(
  new Proxy(
    {
      get: (name) => (name === 'tools' ? { register: (d) => (shadowTools.push(d.name), noop) } : name === 'systemPrompt' ? { section: (d) => (shadowPrompts.push(d.name), noop) } : undefined),
      effect: (fn) => (fn(), noop),
      logger: { debug: noop, info: noop, warn: noop, error: noop },
    },
    { get: (t, k) => (k in t ? t[k] : noop) },
  ),
  undefined,
)
check('I5 ctx.get("tools").register 被桥接收走，宿主的工具表没多出 shadow_tool', shadowBridge.has('shadow_tool') && shadowTools.length === 0, shadowTools.join(','))
check('I6 ctx.get("systemPrompt").section 也被桥接收走，没直挂宿主', shadowBridge.promptDeclarations().length === 1 && shadowPrompts.length === 0, shadowPrompts.join(','))
check('I7 非工具类服务照常透传（get 不是什么都拦）', (() => {
  let seenCommands
  const p = bridgeMod.wrapPlugin({ apply: (ctx) => { seenCommands = ctx.get('commands') } }, bridgeMod.createBridge({}), 'meow')
  p.apply(new Proxy({ get: (n) => (n === 'commands' ? services.commands : undefined), effect: (fn) => (fn(), noop), logger: { warn: noop } }, { get: (t, k) => (k in t ? t[k] : noop) }), undefined)
  return seenCommands === services.commands && shadowCtx !== null
})())

// ── J. 手册的门牌：三个面（工具 / 命令 / 面板）都得写清（0.2.16）────────────────
const promptMod = await import(pathToFileURL(join(root, 'lib', 'macro', 'prompt.js')).href)
const guide = text(await run('memory_admin', { action: 'guide' }))

check('J1 手册开头讲清三个面', guide.startsWith('宏记忆有三个面'), guide.slice(0, 24))
check('J2 手册写明命令名 /dream 与 /meow-trust', guide.includes('/dream') && guide.includes('/meow-trust'))
check('J3 手册写明两个面板', guide.includes('设置里的「宏记忆」') && guide.includes('「宏记忆 · 星图」'))
check('J4 vendor 的手册原文仍然原样接在后面', guide.includes('记忆手册') || guide.includes('星图规则'), guide.length + ' 字符')
check('J5 手册里不夹内部错误', !guide.includes('还没就绪') && !guide.includes('未完成'))
check('J6 每轮注入的 L0 也点了三个面', promptMod.GUIDE_TEXT.includes('/dream') && promptMod.GUIDE_TEXT.includes('宏记忆 · 星图'))
check('J7 手册里的命令名与 vendor 实际注册名对得上', (() => {
  const src = readFileSync(join(root, 'vendor', 'meow-memory', 'lib', 'index.js'), 'utf8')
  return promptMod.NAV_TEXT.includes('/dream') && promptMod.NAV_TEXT.includes('/meow-trust') && src.includes('name: "dream"') && src.includes('name: "meow-trust"')
})())
check('J8 L0 仍在预算内（clampGuide 兜底）', promptMod.clampGuide(promptMod.GUIDE_TEXT).length <= promptMod.GUIDE_MAX_CHARS, String(promptMod.GUIDE_TEXT.length))

// ── K. 动作表：schema 里能选到的，一个都不许是死路（0.2.22）──────────────────
// 这类坏法以前抓不到：枚举是手写的、分发是 if/else 链，两边不同步时，模型照着
// schema 选到一个「合法但没实现」的 action，一调就炸，而所有自检仍然全绿。
const adminMod = await import(pathToFileURL(join(root, 'lib', 'macro', 'defs', 'admin.js')).href)
const adminEnum = tools.get('memory_admin').parameters.properties.action.enum
const tableKeys = Object.keys(adminMod.ACTIONS)
check('K1 枚举就是动作表本身（同一份数据）', JSON.stringify(adminEnum) === JSON.stringify(tableKeys), adminEnum.join('/'))
// 0.2.97：多了 dream 一行（整理留痕），八行变九行。
check('K2 动作表十行，一个不多一个不少', tableKeys.length === 10 && ['home', 'stats', 'hygiene', 'sources', 'ingest', 'cost', 'inject', 'dream', 'links', 'guide'].every((k) => tableKeys.includes(k)), tableKeys.join('/'))
check('K3 每个动作恰好一种实现', tableKeys.every((k) => ['call', 'graph', 'local'].filter((kind) => adminMod.ACTIONS[k].kind === kind).length === 1) && tableKeys.every((k) => adminMod.ACTIONS[k].kind), tableKeys.map((k) => `${k}:${adminMod.ACTIONS[k].kind}`).join(' '))
const deadEnds = []
for (const action of adminEnum) {
  const args = action === 'ingest' ? { action, provider: 'hindsight', items: [{ title: 'k' }] } : { action }
  try {
    await run('memory_admin', args)
  } catch (e) {
    if (/未知 action|没有实现|is not a function/.test(String(e?.message ?? e))) deadEnds.push(`${action}: ${String(e?.message ?? e).slice(0, 60)}`)
  }
}
check('K4 枚举里每个 action 都真的能走通（不掉进未知 action）', deadEnds.length === 0, deadEnds.join('；') || `${adminEnum.length} 个全部走通`)
check('K5 表外的 action 仍然明确报错', await (async () => {
  try {
    await run('memory_admin', { action: 'nope' })
    return false
  } catch (e) {
    return /未知 action=nope/.test(String(e?.message ?? e))
  }
})())

// ── L. 面板口径：九个面板一个抬头，名字只有一份（0.2.25；0.2.97 起含整理留痕）────────
// 抬头以前各写各的（`# macro-memory 成本账本`、`待补连线：N 条`、星图原文自己的开头），
// 模型拿到哪段都得自己猜这是哪个面；「空」也分不清是没数据还是没接上。
const panelMod = await import(pathToFileURL(join(root, 'lib', 'macro', 'panel.js')).href)
const panels = []
for (const action of adminEnum) {
  const args = action === 'ingest' ? { action, provider: 'hindsight', items: [{ title: 'k' }] } : { action }
  let body
  try {
    body = text(await run('memory_admin', args))
  } catch (e) {
    body = `THREW: ${String(e?.message ?? e)}`
  }
  panels.push({ action, first: String(body).split('\n')[0], body: String(body) })
}
const headPanels = panels.filter((p) => p.action !== 'guide')
const badHead = headPanels.filter((p) => !p.first.startsWith(panelMod.panelHead(adminMod.ACTIONS[p.action].label)))
check(
  'L1 九个统计面板的抬头同一个样（名字取自动作表）',
  badHead.length === 0 && headPanels.length === 9,
  badHead.map((p) => `${p.action}: ${p.first.slice(0, 40)}`).join(' | ') || `${headPanels.length} 个一致`,
)
check(
  'L2 每个面板名两两不同（不会两个面撞一个名）',
  new Set(adminEnum.map((a) => adminMod.ACTIONS[a].label)).size === adminEnum.length,
  adminEnum.map((a) => `${a}=${adminMod.ACTIONS[a].label}`).join(' '),
)
const guidePanel = panels.find((p) => p.action === 'guide')
check('L3 手册不加抬头（唯一豁免，第一行仍是门牌）', adminMod.ACTIONS.guide.wrap === false && guidePanel.first.startsWith('宏记忆有三个面'), guidePanel.first.slice(0, 30))
check(
  'L4 抬头只是加在上面，正文一个字没动',
  panels.find((p) => p.action === 'cost').body.includes('合计：') && panels.find((p) => p.action === 'links').body.includes('待补连线'),
  panels.find((p) => p.action === 'cost').body.split('\n')[1]?.slice(0, 40),
)
check(
  'L5 条数上限有口径说明（真算了几次 / 最多几条）',
  /统计最近 \d+ 次调用/.test(panels.find((p) => p.action === 'cost').first) &&
    panels.find((p) => p.action === 'links').first.includes(`最多列 ${adminMod.ACTIONS.links.defaultLimit} 条`),
  panels.find((p) => p.action === 'cost').first,
)
check(
  'L6 工具描述由表生成（八个面板一个不落、跟着表改）',
  adminEnum.every((a) => adminMod.PANEL_SUMMARY.includes(`${a} ${adminMod.ACTIONS[a].hint}`)) && adminMod.PANEL_SUMMARY.startsWith('宏记忆的运维面板：'),
  adminMod.PANEL_SUMMARY.slice(0, 40),
)

// ── M. 桥拆成三件事之后，行为一条都不许变（0.2.26）────────────────────────
{
  const facadeMod = await import(pathToFileURL(join(root, 'lib', 'macro', 'facade.js')).href)
  const renderMod = await import(pathToFileURL(join(root, 'lib', 'macro', 'render.js')).href)
  check(
    'M1 桥拆成三个文件后入口一个不少（桥 / 换门 / 出文本）',
    typeof bridgeMod.createBridge === 'function' &&
      typeof facadeMod.createFacade === 'function' &&
      typeof facadeMod.wrapPlugin === 'function' &&
      typeof renderMod.errText === 'function' &&
      typeof renderMod.renderToolText === 'function',
    [bridgeMod.createBridge, facadeMod.createFacade, facadeMod.wrapPlugin, renderMod.errText, renderMod.renderToolText]
      .map((f) => typeof f)
      .join(' '),
  )
  // 旧引用还落在 bridge.js 上（index.js 一行都不用改）：拆结构不许改调用方
  check(
    'M2 bridge.js 仍转出 errText / wrapPlugin / createFacade（调用方不用改 import）',
    bridgeMod.errText === renderMod.errText &&
      bridgeMod.wrapPlugin === facadeMod.wrapPlugin &&
      bridgeMod.createFacade === facadeMod.createFacade,
    `errText=${bridgeMod.errText === renderMod.errText} wrapPlugin=${bridgeMod.wrapPlugin === facadeMod.wrapPlugin}`,
  )
  // 拆完 facade 仍然只换门：拿一个「有 commands 但没有 tools」的假 ctx 走一遍
  const mBridge = bridgeMod.createBridge({})
  let mMeta = null
  const mPlugin = facadeMod.wrapPlugin(
    {
      apply(ctx) {
        mMeta = { sameTools: ctx.get('tools') !== undefined, service: ctx.get('commands')?.tag, reg: typeof ctx.tools.register }
      },
    },
    mBridge,
    'meow',
  )
  const mReal = { get: (name) => (name === 'commands' ? { tag: 'real-service' } : undefined), register: () => {} }
  mPlugin.apply(mReal, {})
  check(
    'M3 换门之后其余服务照样透传（拆文件没把透传漏掉）',
    mMeta?.service === 'real-service' && mMeta?.reg === 'function' && mMeta?.sameTools === true,
    JSON.stringify(mMeta),
  )
  // 出文本仍是「先用子插件自己的 render，再退回 JSON」
  const rendered = renderMod.renderToolText({ output: { render: () => [{ text: '子插件渲染的' }] } }, {}, {})
  const fellBack = renderMod.renderToolText({}, {}, { a: 1 })
  check(
    'M4 出文本仍优先子插件 render、没有就退回 JSON',
    rendered === '子插件渲染的' && fellBack.includes('"a": 1'),
    `${rendered} / ${fellBack.replace(/\n/g, ' ')}`,
  )
  check(
    'M5 渲染炸了也不吞掉结果（退回 JSON 而不是空串）',
    renderMod.renderToolText(
      {
        output: {
          render: () => {
            throw new Error('render 炸了')
          },
        },
      },
      {},
      { b: 2 },
    ).includes('"b": 2'),
  )
}

// ── 收尾 ──────────────────────────────────────────────────────────────────
// ── AR. 面板条数：给 0 就照办 0，改了就说话（0.2.61）────────────────────────
{
  const { createUnifiedTools } = await import(pathToFileURL(join(root, 'lib/macro/tools.js')).href)
  // cost 面板是纯本地计算（不碰外部服务），给个什么都不做的 bridge 就够
  const deadBridge = {
    has: () => false,
    get: () => undefined,
    names: () => [],
    awaitTool: async () => undefined,
    async call() {
      throw new Error('cost 面板不该碰外部服务')
    },
    async tryCall() {
      return { entry: undefined, def: undefined, value: undefined, text: '' }
    },
    promptDeclarations: () => [],
  }
  const adminTool = () => createUnifiedTools({ bridge: deadBridge, config: { toolWaitMs: 10, linkWaitMs: 10, flushThrottleMs: 0 } }).find((t) => t.name === 'memory_admin')
  const cost = async (extra) => (await adminTool().execute({ action: 'cost', ...extra }, {}))

  const zero = await cost({ limit: 0 })
  check(
    'AR1 条数给 0 就照办 0，并说清「不是一条都没有」',
    zero.includes('limit 给的是 0') &&
      zero.includes('一条都不列') &&
      !zero.includes('统计最近 0 次调用') &&
      !zero.includes('最近 200 次调用'),
    zero.split('\n')[0].slice(0, 120),
  )
  const str0 = await cost({ limit: '0' })
  check('AR2 字符串 "0" 也是 0（不算「不是数字」）', str0.includes('一条都不列') && !str0.includes('不是数字'), str0.split('\n')[0].slice(0, 90))
  const nan = await cost({ limit: '十' })
  check(
    'AR3 非数字回默认，且说清按默认算',
    nan.includes('不是数字') && nan.includes('按默认 200 条算') && /统计最近 \d+ 次调用/.test(nan),
    nan.split('\n')[0].slice(0, 120),
  )
  const neg = await cost({ limit: -3 })
  check(
    'AR4 负数回默认，且说清条数没有「从后往前数」',
    neg.includes('是负数') && neg.includes('按默认 200 条算'),
    neg.split('\n')[0].slice(0, 120),
  )
  const frac = await cost({ limit: 2.7 })
  check(
    'AR5 非整数只抹掉小数，口径跟着说 2 条',
    frac.includes('只能是整数') && frac.includes('按 2 条算') && frac.includes('统计最近 2 次调用'),
    frac.split('\n')[0].slice(0, 120),
  )
  const plain = await cost({ limit: 5 })
  check(
    'AR6 正常条数不加料（不喊「给的是」）',
    plain.includes('统计最近 5 次调用') && !plain.includes('limit 给的是'),
    plain.split('\n')[0].slice(0, 90),
  )
  const dflt = await cost({})
  check(
    'AR7 不给 limit 走表里的默认值，也不加料',
    /统计最近 \d+ 次调用/.test(dflt) && !dflt.includes('limit 给的是'),
    dflt.split('\n')[0].slice(0, 90),
  )
}

// ── CB. 成本面板的三个数：算了几条 / 要了几条 / 账本里还有几行（0.2.76）────────
// 这一段也在文件系统上判：把 DSH_HOME 指到临时目录，造出「不够 / 够多 / 夹坏行」三种账本，
// 再看抬头那句话与正文合计说是不是同一件事。以前抬头永远「最近 200 次」，正文只算剩下的几条。
{
  const costMod = await import(pathToFileURL(join(root, 'lib', 'macro', 'cost.js')).href)
  const { createUnifiedTools } = await import(pathToFileURL(join(root, 'lib/macro/tools.js')).href)
  const oldHome = process.env.DSH_HOME
  const atHome = mkdtempSync(join(tmpdir(), 'probe-au76-'))
  mkdirSync(join(atHome, 'macro-memory'), { recursive: true })
  process.env.DSH_HOME = atHome
  const row = (i) =>
    JSON.stringify({ ts: new Date().toISOString(), tool: `t${i}`, ok: true, argsChars: 10, resultChars: 20, ms: 5 })
  const writeLedger = (rows) => writeFileSync(costMod.ledgerPath(), `${rows.join('\n')}\n`, 'utf8')
  const deadBridge = {
    has: () => false,
    get: () => undefined,
    names: () => [],
    awaitTool: async () => undefined,
    async call() {
      throw new Error('cost 面板不该碰外部服务')
    },
    async tryCall() {
      return { entry: undefined, def: undefined, value: undefined, text: '' }
    },
    promptDeclarations: () => [],
  }
  const panel = async (extra) =>
    createUnifiedTools({ bridge: deadBridge, config: { toolWaitMs: 10, linkWaitMs: 10, flushThrottleMs: 0 } })
      .find((t) => t.name === 'memory_admin')
      .execute({ action: 'cost', ...extra }, {})
  try {
    // CB1 账本只有 5 条，却要 200 次：口径说「能算的只有 5 条」，正文也只合计这 5 次
    writeLedger([row(1), row(2), row(3), row(4), row(5)])
    const one = await panel({ limit: 200 })
    check(
      'CB1 要 200 次但只有 5 条时，抬头说「能算的只有 5 条」',
      one.includes('统计最近 5 次调用') &&
        one.includes('你要的是 200 次，账本里能算的只有 5 条') &&
        one.includes('入参 50 字符'),
      one.split('\n')[0].slice(0, 120),
    )

    // CB2 账本 250 条只算最近 200 次：说清「更早的 50 条没进」，合计只算 200 行
    writeLedger(Array.from({ length: 250 }, (_, i) => row(i)))
    const two = await panel({ limit: 200 })
    check(
      'CB2 账本 250 条只算最近 200 时，说清「更早的 50 条没进」',
      two.includes('统计最近 200 次调用') && two.includes('更早的 50 条没进这次统计') && two.includes('入参 2000 字符'),
      two.split('\n')[0].slice(0, 120),
    )

    // CB3 中间夹坏行：坏行一条都没算，必须说出来（以前只要还剩一条好行就完全无声）
    writeLedger([row(1), row(2), 'not json', row(3), '{broken', row(4), row(5)])
    const three = await panel({ limit: 200 })
    check(
      'CB3 坏行不再无声：说「另有 2 行解析不出来」',
      three.includes('统计最近 5 次调用') && three.includes('另有 2 行解析不出来，一行都没算进去'),
      three.split('\n')[0].slice(0, 140),
    )

    // CB4 账本全进统计、没有坏行：口径只报条数，不堆附加句
    writeLedger(Array.from({ length: 7 }, (_, i) => row(i)))
    const four = costMod.readCost(7)
    check('CB4 账本全进统计时口径只报条数，不堆附加句', four.scope === '统计最近 7 次调用', four.scope)

    // CB5 老接口不变：costReport() 仍是字符串（外部调用点与 probe 靠它）
    check(
      'CB5 costReport() 仍返回字符串，正文与 readCost().body 一致',
      typeof costMod.costReport(200) === 'string' && costMod.costReport(200) === costMod.readCost(200).body,
      typeof costMod.costReport(200),
    )

    // CB6 参数脏了按整数归一（与 listTail / hubTail 同一套）
    check(
      'CB6 costScope 参数脏了按整数归一',
      costMod.costScope('2', '9', '0') === '统计最近 9 次调用' && costMod.costScope(0, 0, 0, 3) === '',
      JSON.stringify([costMod.costScope('2', '9', '0'), costMod.costScope(0, 0, 0, 3)]),
    )

    // CB7 limit=0：抬头闭嘴，由正文解释——别在口径里写「统计最近 0 次」
    const seven = await panel({ limit: 0 })
    check(
      'CB7 limit=0 时抬头不写「统计最近 0 次」',
      !seven.includes('统计最近 0 次调用') && seven.includes('一条都不列'),
      seven.split('\n')[0].slice(0, 100),
    )
  } finally {
    process.env.DSH_HOME = oldHome
    rmSync(atHome, { recursive: true, force: true })
  }
}

// ── CC. 读记忆的邻居段：没拿到时要分三种话说（0.2.77）─────────────────────────
{
  const { createUnifiedTools } = await import(pathToFileURL(join(root, 'lib/macro/tools.js')).href)

  function stubCC(inspect) {
    const entries = new Map()
    const add = (name, fn) => entries.set(name, { name, vendor: 'stub', def: { name, execute: fn }, options: {} })
    add('memory_read', async (args) => ({ found: true, id: String(args.id), text: '正文-CC' }))
    if (inspect) add('nebula_inspect', inspect)
    const bridge = {
      has: (n) => entries.has(n),
      get: (n) => entries.get(n),
      names: () => [...entries.keys()],
      awaitTool: async (n) => entries.get(n),
      async call(name, args) {
        const e = entries.get(name)
        if (!e) throw new Error('macro-memory：这项能力还没就绪')
        const value = await e.def.execute(args)
        return { entry: e, def: e.def, value, text: typeof value === 'string' ? value : JSON.stringify(value) }
      },
      async tryCall(name, args) {
        try {
          return await bridge.call(name, args)
        } catch (err) {
          return { entry: undefined, def: undefined, value: undefined, text: '星图邻居未完成：' + err.message }
        }
      },
      promptDeclarations: () => [],
    }
    return { bridge }
  }
  const runCC = async (inspect, extra = {}) => {
    const tools = createUnifiedTools({ bridge: stubCC(inspect).bridge, config: { toolWaitMs: 10, linkWaitMs: 10, flushThrottleMs: 0 } })
    const out = await tools.find((t) => t.name === 'memory_read').execute({ id: 'mem-cc-01', neighbors: 12, ...extra }, {})
    return String(out)
  }

  // CC1 星图整块缺席：邻居没带到 ≠ 这条记忆没有邻居
  const absent = await runCC(undefined)
  check(
    'CC1 星图缺席时说出「没答上来」，不假装没有邻居',
    absent.includes('星图这次没答上来') && absent.includes('这不是「这条记忆没有邻居」'),
    absent.split('\n').slice(-1)[0].slice(0, 120),
  )
  check('CC1 不把内部错误原样甩给模型', !absent.includes('这项能力还没就绪') && !absent.includes('未完成'), absent.slice(-90))

  // CC2 星图接了，但回执里没有邻居那一段（格式变了）：也不许沉默
  const noSec = await runCC(async () => ({ id: 'mem-cc-01', text: '星图：这条记忆在，什么都没说' }))
  check(
    'CC2 回执里没有邻居段时说清「这次没带到」',
    noSec.includes('回执里没有「连接到的记忆」这一段') && noSec.includes('这不是「这条记忆没有邻居」'),
    noSec.split('\n').slice(-1)[0].slice(0, 120),
  )

  // CC3 正常拿到邻居段：原样带出，一句废话都不加
  const okSec = await runCC(async (args) => ({ id: args.id, text: '## 连接到的记忆（2/2）\n- node-1\n- node-2' }))
  check(
    'CC3 拿到邻居段时原样带出，不冒「没答上来」',
    okSec.includes('## 连接到的记忆（2/2）') && okSec.includes('- node-2') && !okSec.includes('星图这次没答上来') && !okSec.includes('回执里没有'),
    okSec.split('\n').slice(-1)[0].slice(0, 120),
  )

  // CC4 neighbors=0 是文档写明的「不带」：不问星图，也不出这句
  let askedCC = 0
  const zeroCC = await runCC(
    async (args) => {
      askedCC += 1
      return { id: args.id, text: '## 连接到的记忆（1/1）\n- node-1' }
    },
    { neighbors: 0 },
  )
  check(
    'CC4 neighbors=0 不查星图也不冒这句',
    askedCC === 0 && !zeroCC.includes('星图这次没答上来') && !zeroCC.includes('## 连接到的记忆'),
    `asked=${askedCC}`,
  )

  // CC5 参数脏了：照旧给口径，别把 gap 句和口径混成一句
  const dirty = await runCC(async (args) => ({ id: args.id, text: '## 连接到的记忆（1/1）\n- node-1' }), { neighbors: 'abc' })
  check('CC5 neighbors 给脏了照样能读，并带出一句口径', dirty.includes('正文-CC') && dirty.includes('neighbors'), dirty.split('\n').slice(-1)[0].slice(0, 120))

  // CC6 星图答上来了，但答的是「没这条记忆」：第三种话，不能套「格式变了」
  const missing = await runCC(async (args) => ({ id: args.id, text: `星图里没有 id=${args.id} 的记忆。这不等于「记忆没了」：图里现有 7 条节点。` }))
  check(
    'CC6 星图说没这条记忆时，说的是「没查到」而不是「格式变了」',
    missing.includes('星图这次没查到这条记忆') && !missing.includes('改了格式') && missing.includes('这不是「它没有邻居」'),
    missing.split('\n').slice(-1)[0].slice(0, 120),
  )
}

// ── CD. 写入时给的 links：用不了的要数出来，不许悄悄丢（0.2.78）───────────────
{
  const { createUnifiedTools } = await import(pathToFileURL(join(root, 'lib/macro/tools.js')).href)

  function stubCD(reply) {
    const entries = new Map()
    const add = (name, fn) => entries.set(name, { name, vendor: 'stub', def: { name, execute: fn }, options: {} })
    add('memory_remember', async () => reply)
    // 星图整块缺席：graphState 会判 unavailable，正常条目该走「排队」
    const bridge = {
      has: (n) => entries.has(n),
      get: (n) => entries.get(n),
      names: () => [...entries.keys()],
      awaitTool: async (n) => entries.get(n),
      async call(name, args) {
        const e = entries.get(name)
        if (!e) throw new Error('macro-memory：这项能力还没就绪')
        const value = await e.def.execute(args)
        return { entry: e, def: e.def, value, text: typeof value === 'string' ? value : value.text ?? JSON.stringify(value) }
      },
      async tryCall(name, args) {
        try {
          return await bridge.call(name, args)
        } catch (err) {
          return { entry: undefined, def: undefined, value: undefined, text: '未完成：' + err.message }
        }
      },
      promptDeclarations: () => [],
    }
    return { bridge }
  }
  const runCD = async (reply, args) => {
    const tools = createUnifiedTools({ bridge: stubCD(reply).bridge, config: { toolWaitMs: 10, linkWaitMs: 10, flushThrottleMs: 0 } })
    const out = await tools.find((t) => t.name === 'memory_remember').execute({ content: '正文-CD', project: '探针', keywords: ['a'], importance: 1, ...args }, {})
    return String(out)
  }
  const written = { id: 'mem-cd-w1', text: '✅ 记忆已写入（fact，id=mem-cd-w1）' }

  // CD1 links 给成字符串（不是数组）：整份用法没生效，必须说出来
  const notArray = await runCD(written, { links: 'mem-cd-a' })
  check(
    'CD1 links 给成字符串时说清「这 N 条没法用」',
    notArray.includes('没法用') && notArray.includes('不是数组'),
    notArray.split('\n').slice(-1)[0].slice(0, 140),
  )

  // CD2 数组里混了坏条目：一条要连的照连，坏的要数出来
  const mixed = await runCD(written, { links: ['mem-cd-a', '', { note: '没 id' }, 42] })
  check(
    'CD2 数组里混了坏条目时数出来（空 id / 形状不对）',
    mixed.includes('没法用') && mixed.includes('这 3 条') && mixed.includes('空 id') && mixed.includes('既不是 id 字符串'),
    mixed.split('\n').slice(-1)[0].slice(0, 160),
  )

  // CD3 上游没给 id：连「排队」都没法排，必须说清不是「已经连上了」
  const noId = await runCD({ text: '已写入（没给 id）' }, { links: ['mem-cd-a', 'mem-cd-b'] })
  check(
    'CD3 上游没给 id 时说清「一条都没连、也没排队」',
    noId.includes('一条都没连上') && noId.includes('写入回执里没给 id') && noId.includes('连排队都没法排') && noId.includes('memory_link'),
    noId.split('\n').slice(-1)[0].slice(0, 160),
  )

  // CD4 全好：不许冒出「没法用」
  const good = await runCD(written, { links: ['mem-cd-a', { id: 'mem-cd-b', note: '同类' }] })
  check(
    'CD4 links 全部可用时不冒「没法用」',
    !good.includes('没法用') && good.includes('关联已排队 2 条'),
    good.split('\n').slice(-1)[0].slice(0, 140),
  )

  // CD5 没给 links：什么都不加
  const none = await runCD(written, {})
  check('CD5 没给 links 时一个字都不加', none.trim() === written.text && !none.includes('没法用'), none.slice(0, 80))
}

// ── AS. 读记忆的 neighbors：给错就说出口，不许悄悄「没有邻居」（0.2.62）──────────
{
  const { createUnifiedTools } = await import(pathToFileURL(join(root, 'lib/macro/tools.js')).href)

  function stubAS() {
    const entries = new Map()
    const seen = []
    const add = (name, fn) => entries.set(name, { name, vendor: 'stub', def: { name, execute: fn }, options: {} })
    add('memory_read', async (args) => ({ found: true, id: String(args.id), text: '正文-AS' }))
    add('nebula_inspect', async (args) => {
      seen.push(args.neighbors)
      return { id: args.id, text: '## 连接到的记忆\n- node-as' }
    })
    const bridge = {
      has: (n) => entries.has(n),
      get: (n) => entries.get(n),
      names: () => [...entries.keys()],
      awaitTool: async (n) => entries.get(n),
      async call(name, args) {
        const e = entries.get(name)
        if (!e) throw new Error('not ready')
        const value = await e.def.execute(args)
        return { entry: e, def: e.def, value, text: typeof value === 'string' ? value : JSON.stringify(value) }
      },
      async tryCall(name, args) {
        try {
          return await bridge.call(name, args)
        } catch (err) {
          return { entry: undefined, def: undefined, value: undefined, text: '未完成：' + err.message }
        }
      },
      promptDeclarations: () => [],
    }
    return { bridge, seen }
  }

  const setupAS = () => {
    const { bridge, seen } = stubAS()
    const tools = createUnifiedTools({ bridge, config: { toolWaitMs: 10, linkWaitMs: 10, flushThrottleMs: 0 } })
    const read = tools.find((t) => t.name === 'memory_read')
    return { seen, run: (extra) => read.execute({ id: '0mwmz5l2-as62-0000-0000-0000000as620', ...extra }, {}) }
  }
  const tailAS = (t) => t.split('\n').filter((x) => x.trim().length > 0).slice(-1)[0].slice(0, 120)

  const nan = setupAS()
  const nanText = await nan.run({ neighbors: '十' })
  check(
    'AS1 neighbors 不是数字：回默认 12 条，并把原值与原因写出来',
    nanText.includes('neighbors 给的是「十」') && nanText.includes('不是数字') && nanText.includes('按默认 12 条算'),
    tailAS(nanText),
  )
  check('AS2 非数字时邻居段照旧带出来（不再被读成「没有邻居」）', nanText.includes('## 连接到的记忆'))
  check('AS3 非数字时交给星图的是默认 12', nan.seen.length === 1 && nan.seen[0] === 12, String(nan.seen[0]))

  const neg = setupAS()
  const negText = await neg.run({ neighbors: -3 })
  check(
    'AS4 负数回默认 12 条，并说清「条数没有从后往前数」',
    negText.includes('是负数') && negText.includes('按默认 12 条算') && neg.seen[0] === 12,
    tailAS(negText),
  )

  const zero = setupAS()
  const zeroText = await zero.run({ neighbors: 0 })
  check(
    'AS5 neighbors=0 是文档写明的「不带」，照办且不加料',
    !zeroText.includes('neighbors 给的是') && !zeroText.includes('## 连接到的记忆') && zero.seen.length === 0,
    tailAS(zeroText),
  )
  const zeroStr = setupAS()
  const zeroStrText = await zeroStr.run({ neighbors: '0' })
  check(
    'AS6 字符串 "0" 同样照办 0（不当成「不是数字」）',
    !zeroStrText.includes('不是数字') && zeroStr.seen.length === 0,
    tailAS(zeroStrText),
  )

  const frac = setupAS()
  const fracText = await frac.run({ neighbors: 3.7 })
  check(
    'AS7 小数只抹掉小数部分，并说清少掉的那半条',
    fracText.includes('只能是整数') && fracText.includes('按 3 条算') && frac.seen[0] === 3,
    tailAS(fracText),
  )

  const big = setupAS()
  const bigText = await big.run({ neighbors: 999 })
  check(
    'AS8 超出上界夹到 40，并说清这是被改过的条件算出来的',
    bigText.includes('超出 0–40') && bigText.includes('按 40 条算') && big.seen[0] === 40,
    tailAS(bigText),
  )

  const plain = setupAS()
  const plainText = await plain.run({ neighbors: 5 })
  check(
    'AS9 正常条数不加料（反向哨兵）',
    !plainText.includes('neighbors 给的是') && plain.seen[0] === 5 && plainText.includes('## 连接到的记忆'),
    tailAS(plainText),
  )
  const dflt = setupAS()
  const dfltText = await dflt.run({})
  check(
    'AS10 不给 neighbors 走默认 12 条，也不加料',
    !dfltText.includes('neighbors 给的是') && dflt.seen[0] === 12,
    tailAS(dfltText),
  )
}

// ── AT. 注入上限：配置写错要回默认并说话，0 才照办 0（0.2.63）──────────────
{
  const promptAT = await import(pathToFileURL(join(root, 'lib/macro/prompt.js')).href)
  const { createUnifiedTools } = await import(pathToFileURL(join(root, 'lib/macro/tools.js')).href)

  const b1 = promptAT.guideBudget(undefined)
  check(`AT1 没给上限：按默认 ${promptMod.GUIDE_MAX_CHARS} 字，且不多一句话`, b1.value === promptMod.GUIDE_MAX_CHARS && b1.note === '', `${b1.value}/${b1.note.length}`)
  const b2 = promptAT.guideBudget('4k')
  check(
    `AT2 上限写成 "4k"：回默认 ${promptMod.GUIDE_MAX_CHARS} 并说「不是数字」——绝不落成 0（＝不注入）`,
    b2.value === promptMod.GUIDE_MAX_CHARS && b2.note.includes('不是数字') && b2.note.includes('注入没有变成空的'),
    `${b2.value} ${b2.note.slice(0, 40)}`,
  )
  const b3 = promptAT.guideBudget(-5)
  check(`AT3 上限给负数：回默认 ${promptMod.GUIDE_MAX_CHARS} 并说「上限没有从后往前数」`, b3.value === promptMod.GUIDE_MAX_CHARS && b3.note.includes('是负数'), `${b3.value}`)
  const b4 = promptAT.guideBudget(0)
  check(
    'AT4 上限给 0：照办 0，并说清「不是手册空了」',
    b4.value === 0 && b4.note.includes('一个字都不注入') && b4.note.includes('不是「手册空了」'),
    `${b4.value} ${b4.note.slice(0, 30)}`,
  )
  const b5 = promptAT.guideBudget(900.7)
  check('AT5 上限给小数：抹到 900 并说「少掉的那半字不是你给的条件」', b5.value === 900 && b5.note.includes('只能是整数'), `${b5.value}`)
  const b6 = promptAT.guideBudget(5)
  check('AT6 上限小到放不下尾巴：照办 5，并说「没有指路」', b6.value === 5 && b6.note.includes('尾巴都放不下'), `${b6.value}`)
  const b7 = promptAT.guideBudget(1000)
  check('AT7 上限正常：照办 1000，一个字都不多说', b7.value === 1000 && b7.note === '', `${b7.value}`)
  const longAT = 'x'.repeat(4000)
  const badCap = promptAT.clampGuide(longAT, '4k')
  check(
    'AT8 真函数上：上限写坏时仍然吐出「带尾巴的截断文本」，不是空串',
    badCap.length > 1200 && badCap.endsWith(promptAT.GUIDE_TAIL_MARK),
    `${badCap.length} 字符`,
  )
  check('AT9 0 仍照办 0（既有契约不变）', promptAT.clampGuide(longAT, 0) === '', `${promptAT.clampGuide(longAT, 0).length}`)

  const deadBridgeAT = {
    has: () => false,
    get: () => undefined,
    names: () => [],
    awaitTool: async () => undefined,
    async call() {
      throw new Error('手册面板不该碰外部服务')
    },
    async tryCall() {
      return { entry: undefined, def: undefined, value: undefined, text: '' }
    },
    promptDeclarations: () => [],
  }
  const guideOf = async (guideMaxChars) => {
    const tool = createUnifiedTools({ bridge: deadBridgeAT, config: { guideMaxChars, toolWaitMs: 10, linkWaitMs: 10, flushThrottleMs: 0 } }).find((t) => t.name === 'memory_admin')
    return tool.execute({ action: 'guide' }, {})
  }
  const g1 = await guideOf('4k')
  check(
    `AT10 memory_admin(guide) 末尾带一行「L0 注入：现在 N/${promptMod.GUIDE_MAX_CHARS} 字」，写坏时把那句话一起带出来`,
    g1.includes('L0 注入：现在') && g1.includes(`/${promptMod.GUIDE_MAX_CHARS} 字`) && g1.includes('不是数字'),
    g1.split('\n').slice(-1)[0].slice(0, 80),
  )
  const g2 = await guideOf(1000)
  check(
    'AT11 上限正常时那行只有事实，不带任何纠偏声明',
    g2.includes('L0 注入：现在') && g2.includes('/1000 字') && !g2.includes('不是数字') && !g2.includes('guideMaxChars 给的是'),
    g2.split('\n').slice(-1)[0].slice(0, 80),
  )
}

  // ── AU. 体检的类别是枚举：给错不许「照跑一遍全部再挑一类空结果」（0.2.64）──
  // 星图收到不认识的 kind 不会报错：按 key 取条目取不到就是空数组，那一行打成
  // 「（0）」而抬头还写「共 N 项」——用户要查「孤立」，读成「孤立是 0 条」。
  {
    const { createUnifiedTools } = await import(pathToFileURL(join(root, 'lib/macro/tools.js')).href)
    const HYGIENE_TEXT = '记忆体检：共 3 项（只诊断，不动任何记忆）'
    const mkAdmin = () => {
      const seen = []
      const bridge = {
        has: (n) => n === 'nebula_hygiene',
        get: () => undefined,
        names: () => ['nebula_hygiene'],
        awaitTool: async () => ({ name: 'nebula_hygiene' }),
        call: async (name, args) => {
          seen.push({ name, args })
          return { entry: { name }, text: HYGIENE_TEXT }
        },
        tryCall: async (name, args) => {
          seen.push({ name, args })
          return { entry: { name }, text: HYGIENE_TEXT }
        },
        promptDeclarations: () => [],
      }
      const tools = createUnifiedTools({ bridge, config: { toolWaitMs: 10, linkWaitMs: 10, flushThrottleMs: 0 } })
      const admin = tools.find((t) => t.name === 'memory_admin')
      return { admin, seen }
    }
    const runAdmin = async (args) => {
      const { admin, seen } = mkAdmin()
      let text = ''
      let error = ''
      try {
        const r = await admin.execute(args, {})
        text = String(r?.text ?? r ?? '')
      } catch (e) {
        error = String(e?.message ?? e)
      }
      return { text, error, seen }
    }

    // AU1: 拼错的类别一次都不往下发，且不许伪造体检结果
    {
      const r = await runAdmin({ action: 'hygiene', kind: 'dups' })
      check(
        'AU1 体检的 kind 给错：挡住并列出六个键，一次都不问星图（不许打成「这一类是 0」）',
        r.error.includes('只认 dup / stale / thin / oversize / unread / orphan') &&
          r.error.includes('给的是「dups」') &&
          r.error.includes('这次体检没有跑') &&
          !r.error.includes('记忆体检：共') &&
          r.seen.length === 0,
        `${r.seen.length} ${r.error.slice(0, 60)}`,
      )
    }
    // AU2: 大小写归一后照办
    {
      const r = await runAdmin({ action: 'hygiene', kind: 'ORPHAN' })
      check('AU2 kind 写成大写也认，归一成小写再发', r.error === '' && r.seen[0]?.args?.kind === 'orphan', `${r.error.slice(0, 40)}|${r.seen[0]?.args?.kind}`)
    }
    // AU3: 前后空格也去掉
    {
      const r = await runAdmin({ action: 'hygiene', kind: '  thin  ' })
      check('AU3 kind 前后带空格也认，去掉再发', r.error === '' && r.seen[0]?.args?.kind === 'thin', `${r.error.slice(0, 40)}|${r.seen[0]?.args?.kind}`)
    }
    // AU4: 不给 kind＝全部概览，不硬塞一个进去
    {
      const r = await runAdmin({ action: 'hygiene' })
      check('AU4 不给 kind 就走全部概览，别塞一个默认类别', r.error === '' && r.seen[0]?.args?.kind === undefined, `${r.error.slice(0, 40)}|${r.seen[0]?.args?.kind}`)
    }
    // AU5: 空串＝没给（不报错、也不发一个空类别）
    {
      const r = await runAdmin({ action: 'hygiene', kind: '' })
      check('AU5 kind 给空串当没给：不报错，也不发一个空类别过去', r.error === '' && (r.seen[0]?.args?.kind ?? '') === '', `${r.error.slice(0, 40)}|${r.seen[0]?.args?.kind}`)
    }
    // AU6: 中文类别名不猜——猜错比不猜更贵
    {
      const r = await runAdmin({ action: 'hygiene', kind: '重复' })
      check('AU6 中文类别名不猜，照样挡住并列出六个键', r.error.includes('给的是「重复」') && r.seen.length === 0, r.error.slice(0, 50))
    }
    // AU7: 挡住时的措辞不许冒充结论
    {
      const r = await runAdmin({ action: 'hygiene', kind: 'zzz' })
      check(
        'AU7 挡住时说清「没跑」而不是「这一类没有问题」',
        r.error.includes('别把「没跑」读成「这一类没有问题」') && !r.error.includes('（0）'),
        r.error.slice(0, 60),
      )
    }
    // AU8: 合规的类别照常出面板（抬头与正文都在）
    {
      const r = await runAdmin({ action: 'hygiene', kind: 'dup' })
      check('AU8 合规类别照常出面板，抬头与正文都在', r.error === '' && r.text.includes('记忆体检') && r.text.includes('共 3 项'), `${r.error.slice(0, 40)}|${r.text.slice(0, 40)}`)
    }
  }

  // ── AV. 尾注不许撒谎：local 扩散真的读了 limit / hops，就不许说「没用上」（0.2.65）──
  // 老写法对所有非 graph/bridge 模式一律说「limit 只在 graph / bridge 生效……这次没用上 limit」，
  // 可 local 在「零命中自动扩散」或 expand:true 时，扩散那次呼叫读的正是 args.limit 原值。
  // limit=0 的人会同时看到「扩散没补到东西」和「limit 这次没用上」，两句一起读成「星图里真没有」。
  {
    const { createUnifiedTools } = await import(pathToFileURL(join(root, 'lib/macro/tools.js')).href)
    const HIT_TEXT = '检索到 3 条记忆：\n- [m1] 第一条\n- [m2] 第二条\n- [m3] 第三条'
    const SPREAD_TEXT = '— 星图里的邻居 —\n- node-a（同一实体）'
    const mkSearch = ({ hits = 0, connected = true } = {}) => {
      const seen = []
      const bridge = {
        has: (n) => n === 'memory_search' || n === 'nebula_recall',
        get: () => undefined,
        names: () => ['memory_search', 'nebula_recall'],
        awaitTool: async (n) => ({ name: n }),
        call: async (name, args) => {
          seen.push({ name, args })
          return { entry: { name }, value: { hits: new Array(hits).fill(0) }, text: hits > 0 ? HIT_TEXT : '一条都没有：库里没有匹配「泡泡」。' }
        },
        tryCall: async (name, args) => {
          seen.push({ name, args })
          if (!connected) return { entry: undefined, def: undefined, value: undefined, text: '' }
          return { entry: { name }, value: undefined, text: SPREAD_TEXT }
        },
        promptDeclarations: () => [],
      }
      const tools = createUnifiedTools({ bridge, config: { toolWaitMs: 10, linkWaitMs: 10, flushThrottleMs: 0 } })
      return { search: tools.find((t) => t.name === 'memory_search'), seen }
    }
    const runSearch = async (opts, args) => {
      const { search, seen } = mkSearch(opts)
      const text = String(await search.execute(args, {}))
      return { text, seen, spreadCalls: seen.filter((s) => s.name === 'nebula_recall') }
    }

    // AV1: 零命中自动扩散，没给 limit —— 用默认 5，且不许冒出任何 limit 尾注
    {
      const r = await runSearch({ hits: 0 }, { query: '泡泡' })
      check(
        'AV1 零命中自动扩散用默认 limit=5 / hops=2，没给参数就别多说一句',
        r.spreadCalls.length === 1 && r.spreadCalls[0].args.limit === 5 && r.spreadCalls[0].args.hops === 2 && !r.text.includes('limit 是 graph') && !r.text.includes('没用上 limit'),
        `${r.spreadCalls.length} ${r.text.split('\n').slice(-1)[0].slice(0, 60)}`,
      )
    }
    // AV2: 零命中 + limit 给了 —— 尾注必须承认「这次扩散真的用了它」
    {
      const r = await runSearch({ hits: 0 }, { query: '泡泡', limit: 5 })
      check(
        'AV2 扩散真的读了 limit 时，尾注说「这次扩散真的用了它（limit=5）」，不许说没用上',
        r.text.includes('这次扩散真的用了它（limit=5）') && !r.text.includes('没用上 limit'),
        r.text.split('\n').slice(-1)[0].slice(0, 90),
      )
    }
    // AV3: limit=0 照原样递过去（不许悄悄换回默认），尾注如实写 0
    {
      const r = await runSearch({ hits: 0 }, { query: '泡泡', limit: 0 })
      check(
        'AV3 limit 给 0 照原样递给星图（0 不是「没给」），尾注也照写 0',
        r.spreadCalls[0]?.args?.limit === 0 && r.text.includes('这次扩散真的用了它（limit=0）'),
        `${r.spreadCalls[0]?.args?.limit}|${r.text.split('\n').slice(-1)[0].slice(0, 60)}`,
      )
    }
    // AV4: 本地有命中、没扩散 —— 这才该说「没用上 limit」
    {
      const r = await runSearch({ hits: 3 }, { query: '泡泡', limit: 7, expand: false })
      check(
        'AV4 本地有结果、没触发扩散时说「这次没有扩散，limit 没用上」才对',
        r.spreadCalls.length === 0 && r.text.includes('这次没有扩散，limit 没用上'),
        `${r.spreadCalls.length} ${r.text.split('\n').slice(-1)[0].slice(0, 70)}`,
      )
    }
    // AV5: expand:true 主动扩散时 hops 一样要说实话
    {
      const r = await runSearch({ hits: 3 }, { query: '泡泡', expand: true, hops: 3 })
      check(
        'AV5 expand:true 主动扩散时，hops 也说「这次扩散真的用了它（hops=3）」',
        r.spreadCalls.length === 1 && r.spreadCalls[0].args.hops === 3 && r.text.includes('这次扩散真的用了它（hops=3）'),
        `${r.spreadCalls[0]?.args?.hops}|${r.text.split('\n').slice(-1)[0].slice(0, 60)}`,
      )
    }
    // AV6: 星图没接上 —— 第三种状态：本来要用，但没参与结果
    {
      const r = await runSearch({ hits: 0, connected: false }, { query: '泡泡', limit: 9 })
      check(
        'AV6 星图没接上时这么说：本来要扩散（会用 limit=9），但没参与这次结果',
        r.text.includes('本来要扩散（会用 limit=9）') && r.text.includes('但星图没接上') && !r.text.includes('真的用了它'),
        r.text.split('\n').slice(-1)[0].slice(0, 90),
      )
    }
    // AV7: similar 模式的条数是 k，别说成「本地检索的条数用 k」
    {
      const r = await runSearch({ hits: 0 }, { mode: 'similar', id: 'm1', limit: 4 })
      check(
        'AV7 similar 模式说清「相似检索的条数用 k」，别拿本地检索的说法套上去',
        r.text.includes('相似检索的条数用 k') && r.text.includes('这次没用上 limit'),
        r.text.split('\n').slice(-1)[0].slice(0, 70),
      )
    }
    // AV8: graph 模式本来就用 limit，不许再补一句「没用上 / 真的用了它」
    {
      const r = await runSearch({ hits: 0 }, { mode: 'graph', query: '泡泡', limit: 6 })
      check(
        'AV8 graph 模式本来就用 limit，不补多余的尾注',
        r.spreadCalls.length === 1 && r.spreadCalls[0].args.limit === 6 && !r.text.includes('没用上 limit') && !r.text.includes('真的用了它'),
        r.text.split('\n').slice(-1)[0].slice(0, 60),
      )
    }
    // AV9: 一个都不给时，三条尾注一条都不许出现
    {
      const r = await runSearch({ hits: 3 }, { query: '泡泡' })
      check(
        'AV9 limit / hops 都没给时，尾注里一条都不出现（别无中生有）',
        !r.text.includes('limit') && !r.text.includes('hops'),
        r.text.split('\n').slice(-1)[0].slice(0, 60),
      )
    }
  }

  // ── AW. 同一组参数在两条路径上一进一出：星图接上时它们没用上，星图没接上时它们真的生效了（0.2.66）──
  {
    const { createUnifiedTools } = await import(pathToFileURL(join(root, 'lib/macro/tools.js')).href)
    const LOCAL_TEXT = '检索到 2 条记忆：\n- [m1] 第一条\n- [m2] 第二条'
    const GRAPH_TEXT = '— 星图里的邻居 —\n- node-a（同一实体）'
    const EMPTY_GRAPH_TEXT = '星图里还没有节点（图是空的）——关联扩散无从开始。'
    const mkTools = ({ graph = 'ok' } = {}) => {
      const seen = []
      const bridge = {
        has: (n) => n === 'memory_search' || n === 'nebula_recall' || n === 'nebula_bridge',
        get: () => undefined,
        names: () => ['memory_search', 'nebula_recall', 'nebula_bridge'],
        awaitTool: async (n) => ({ name: n }),
        call: async (name, args) => {
          seen.push({ name, args })
          return { entry: { name }, value: { hits: [0, 0] }, text: LOCAL_TEXT }
        },
        tryCall: async (name, args) => {
          seen.push({ name, args })
          if (graph === 'absent') return { entry: undefined, def: undefined, value: undefined, text: '' }
          if (graph === 'empty') return { entry: { name }, value: undefined, text: EMPTY_GRAPH_TEXT }
          return { entry: { name }, value: undefined, text: GRAPH_TEXT }
        },
        promptDeclarations: () => [],
      }
      const tools = createUnifiedTools({ bridge, config: { toolWaitMs: 10, linkWaitMs: 10, flushThrottleMs: 0 } })
      return { search: tools.find((t) => t.name === 'memory_search'), seen }
    }
    const run = async (opts, args) => {
      const { search, seen } = mkTools(opts)
      const text = String(await search.execute(args, {}))
      return { text, seen }
    }

    // AW1: 星图接上了，k 真的没用上 —— 原有那句「这次按 10 条算」必须还在
    {
      const r = await run({ graph: 'ok' }, { mode: 'graph', query: '泡泡', k: 3 })
      check(
        'AW1 graph 走星图时 k 是本地条件：照旧说「这次按 10 条算」',
        r.text.includes('k 是本地检索的条数；graph 模式用 limit，这次按 10 条算。') && !r.text.includes('k 这次真的用上了'),
        r.text.split('\n').slice(-1)[0].slice(0, 90),
      )
    }
    // AW2: 星图没接上，退到本地检索 —— 同一句老文案在这里说反话，必须改成「真的用上了」
    {
      const r = await run({ graph: 'absent' }, { mode: 'graph', query: '泡泡', k: 3, project: 'femo' })
      const fellToLocal = r.seen.some((s) => s.name === 'memory_search')
      check(
        'AW2 星图没接上、退到本地检索时，k / project 必须承认「真的用上了」',
        fellToLocal &&
          r.text.includes('k 这次真的用上了') &&
          r.text.includes('project 这些是本地检索的条件') &&
          r.text.includes('退到本地检索') &&
          !r.text.includes('这次按 10 条算'),
        r.text.split('\n').slice(-1)[0].slice(0, 90),
      )
    }
    // AW3: 星图接上了但给了 project —— 这是真没用上，得说清（不许沉默）
    {
      const r = await run({ graph: 'ok' }, { mode: 'graph', query: '泡泡', project: 'femo' })
      check(
        'AW3 graph 走星图时 project 被丢掉不能沉默：说「只在本地检索生效」',
        r.text.includes('project 只在本地检索生效') && !r.text.includes('真的用上了'),
        r.text.split('\n').slice(-1)[0].slice(0, 90),
      )
    }
    // AW4: 星图没接上又没给本地参数 —— 一句本地条件都不许冒出来
    {
      const r = await run({ graph: 'absent' }, { mode: 'graph', query: '泡泡' })
      check(
        'AW4 没给本地条件时不许多冒尾注（别无中生有）',
        !r.text.includes('这些是本地检索的条件') && !r.text.includes('k 这次') && r.text.includes('先只给本地检索结果'),
        r.text.split('\n').slice(-1)[0].slice(0, 90),
      )
    }
    // AW5: 星图没接上 + 没 query：连本地兜底都没做，k 谁都没参与
    {
      const r = await run({ graph: 'absent' }, { mode: 'graph', k: 2 })
      check(
        'AW5 星图没接上又没 query 时，「这一问压根没算」，不许说 k 用上了',
        r.text.includes('k 这次没参与') && !r.text.includes('真的用上了') && !r.seen.some((s) => s.name === 'memory_search'),
        r.text.split('\n').slice(-1)[0].slice(0, 90),
      )
    }
    // AW6: 星图在但图是空的 + 有 query —— 这条也退到本地检索，条件同样真的生效
    {
      const r = await run({ graph: 'empty' }, { mode: 'graph', query: '泡泡', k: 4, days: 7 })
      check(
        'AW6 空图退本地检索时，k / days 也要承认用上了',
        r.text.includes('k 这次真的用上了') && r.text.includes('days 这些是本地检索的条件') && !r.text.includes('这次按 10 条算'),
        r.text.split('\n').slice(-1)[0].slice(0, 90),
      )
    }
    // AW7: graph 一个本地条件都不给 —— 尾注一条都不许有
    {
      const r = await run({ graph: 'ok' }, { mode: 'graph', query: '泡泡', limit: 6 })
      check(
        'AW7 graph 没给本地条件时，尾注里不许出现「这些是本地检索的条件」',
        !r.text.includes('这些是本地检索的条件') && !r.text.includes('k 是本地检索的条数'),
        r.text.split('\n').slice(-1)[0].slice(0, 90),
      )
    }
    // AW8: bridge 模式给 min_weight 是正当的 —— 不许提示「只在 bridge 生效」
    {
      const r = await run({ graph: 'ok' }, { mode: 'bridge', query: '泡泡', min_weight: 0.6 })
      check(
        'AW8 bridge 模式给 min_weight 是正当用法，不许提示「这次没用上」',
        !r.text.includes('min_weight 只在 bridge 模式生效') && !r.text.includes('这些是本地检索的条件'),
        r.text.split('\n').slice(-1)[0].slice(0, 90),
      )
    }
    // AW9: local 模式不该被这条新尾注碰到
    {
      const r = await run({ graph: 'ok' }, { query: '泡泡', k: 3, project: 'femo' })
      check(
        'AW9 local 模式不冒「这些是本地检索的条件」（这条只属于 graph / bridge）',
        !r.text.includes('这些是本地检索的条件') && !r.text.includes('只在本地检索生效'),
        r.text.split('\n').slice(-1)[0].slice(0, 90),
      )
    }
  }

  // ── AX. 相似模式的那张表：只认 id / k / content_max，别的参数不许沉默（0.2.67）──
  {
    const { createUnifiedTools } = await import(pathToFileURL(join(root, 'lib/macro/tools.js')).href)
    const SIMILAR_TEXT = '相似记忆 2 条：\n- [m1] 第一条\n- [m2] 第二条'
    const mkTools = () => {
      const seen = []
      const bridge = {
        has: (n) => n === 'memory_find_similar',
        get: () => undefined,
        names: () => ['memory_find_similar'],
        awaitTool: async (n) => ({ name: n }),
        call: async (name, args) => {
          seen.push({ name, args })
          return { entry: { name }, value: { hits: [{}] }, text: SIMILAR_TEXT }
        },
        tryCall: async (name, args) => {
          seen.push({ name, args })
          return { entry: { name }, value: { hits: [{}] }, text: SIMILAR_TEXT }
        },
        promptDeclarations: () => [],
      }
      const tools = createUnifiedTools({ bridge, config: { toolWaitMs: 10, linkWaitMs: 10, flushThrottleMs: 0 } })
      return { search: tools.find((t) => t.name === 'memory_search'), seen }
    }
    const run = async (args) => {
      const { search, seen } = mkTools()
      const text = String(await search.execute(args, {}))
      return { text, seen }
    }
    const tail = (t) => t.split('\n').slice(-1)[0].slice(0, 96)

    // AX1: similar + query —— 最危险的一种：用户以为在按句子找
    {
      const r = await run({ mode: 'similar', id: 'abc12345', query: '部署' })
      check(
        'AX1 smaller 模式给了 query 不能沉默：必须说「这一问是拿 id 去比，不是按句子找」',
        r.text.includes('query 在相似模式没用上') && r.text.includes('不是按你说的句子找'),
        tail(r.text),
      )
    }
    // AX2: similar + 本地条件 —— 一条都不许丢在沉默里
    {
      const r = await run({ mode: 'similar', id: 'abc12345', project: 'femo', days: 30 })
      check(
        'AX2 相似模式给了 project / days 要说「这次没用上它们」',
        r.text.includes('project / days 是本地检索的条件') && r.text.includes('这次没用上它们'),
        tail(r.text),
      )
    }
    // AX3: similar + hops
    {
      const r = await run({ mode: 'similar', id: 'abc12345', hops: 3 })
      check(
        'AX3 相似模式给了 hops 要说「相似检索不扩散，这次没用上」',
        r.text.includes('hops 是 graph / bridge 的扩散跳数；相似检索不扩散，这次没用上。'),
        tail(r.text),
      )
    }
    // AX4: similar + memory_ids
    {
      const r = await run({ mode: 'similar', id: 'abc12345', memory_ids: ['x'] })
      check(
        'AX4 相似模式给了 memory_ids 要说「只看 id 指向的那一条」',
        r.text.includes('memory_ids 是 graph / bridge 的起点'),
        tail(r.text),
      )
    }
    // AX5: 老的那句 limit 尾注不许被新代码挤掉
    {
      const r = await run({ mode: 'similar', id: 'abc12345', limit: 5 })
      check(
        'AX5 相似模式给 limit 仍说「相似检索的条数用 k，这次没用上 limit」',
        r.text.includes('limit 只在 graph / bridge 生效；相似检索的条数用 k，这次没用上 limit。'),
        tail(r.text),
      )
    }
    // AX6: 什么都不多给 —— 一条尾注都不许冒（因为没东西被丢）
    {
      const r = await run({ mode: 'similar', id: 'abc12345', k: 3 })
      check(
        'AX6 相似模式只给 id / k 时不许冒出「没用上」的尾注',
        !r.text.includes('没用上') && !r.text.includes('没用上它们'),
        tail(r.text),
      )
    }
    // AX7: 全给 —— 四句齐，而且递给 meow 的只有 id / k / content_max
    {
      const r = await run({ mode: 'similar', id: 'abc12345', k: 4, content_max: 120, query: '泡泡', project: 'femo', hops: 2, memory_ids: ['y'], limit: 9 })
      const sent = r.seen.find((s) => s.name === 'memory_find_similar')
      const keys = sent ? Object.keys(sent.args).sort().join(',') : ''
      check(
        'AX7 相似模式全参数时四句尾注齐，且只把 id / content_max / k 递给 meow',
        r.text.includes('query 在相似模式没用上') &&
          r.text.includes('project 是本地检索的条件') &&
          r.text.includes('相似检索不扩散') &&
          r.text.includes('memory_ids 是 graph / bridge 的起点') &&
          keys === 'content_max,id,k',
        `尾注四句=${['query 在相似模式没用上', 'project 是本地检索的条件', '相似检索不扩散', 'memory_ids 是 graph / bridge 的起点'].filter((x) => r.text.includes(x)).length}/4 递给=${keys}`,
      )
    }
    // AX10: content_max 在 LOCAL_ONLY_PARAMS 里，但相似检索认它 —— 不许打成「没用上」
    {
      const r = await run({ mode: 'similar', id: 'abc12345', content_max: 80 })
      check(
        'AX10 相似模式给 content_max 是正当的（meow 的相似检索就收它），不许说「没用上」',
        !r.text.includes('content_max 是本地检索的条件') && !r.text.includes('没用上它们'),
        tail(r.text),
      )
    }
    // AX8: local 模式不许被这条新尾注碰到
    {
      const r = await run({ query: '泡泡' })
      check(
        'AX8 local 模式不冒「query 在相似模式没用上」（这条只属于相似检索）',
        !r.text.includes('query 在相似模式没用上') && !r.text.includes('相似检索不扩散'),
        tail(r.text),
      )
    }
    // AX9: 相似模式缺 id —— 必须报错，不许静默拿空 id 去比
    {
      let message = ''
      const { search } = mkTools()
      try {
        await search.execute({ mode: 'similar' }, {})
      } catch (err) {
        message = String(err?.message ?? err)
      }
      check(
        'AX9 相似模式缺 id 时报错说清「需要 id」，不许静默比一场空',
        message.includes('mode=similar 需要 id'),
        message.slice(0, 96),
      )
    }
  }

// ── AY. 面板不读的参数不许悄悄消失（0.2.68）────────────────────────────
// 八个参数对每个 action 都合法，执行时只取表里那一行列的。剩下的以前就这么没了：
// `action='cost', kind='dup'` 会给人一份「看起来按 dup 筛过」的账本。
{
  const first = (t) => String(t).split('\n')[0]

  const costStray = text(await run('memory_admin', { action: 'cost', kind: 'dup' }))
  check(
    'AY1 cost 配了 kind：抬头必须点名「kind 是 hygiene 的」，并说这次一点没参与',
    first(costStray).includes('kind 是 hygiene 的') &&
      first(costStray).includes('cost 不读它') &&
      first(costStray).includes('一点没参与'),
    first(costStray).slice(0, 140),
  )

  const statsStray = text(await run('memory_admin', { action: 'stats', limit: 5 }))
  check(
    'AY2 stats 配了 limit：要说清 limit 归 hygiene / cost / inject / dream / links，stats 不读它',
    first(statsStray).includes('limit 是 hygiene / cost / inject / dream / links 的') && first(statsStray).includes('stats 不读它'),
    first(statsStray).slice(0, 140),
  )

  const homeStray = text(await run('memory_admin', { action: 'home', limit: 3 }))
  check(
    'AY3 home 配了 limit：必须被点出来（不许因为「反正读了一个参数」就整句吞掉）',
    first(homeStray).includes('limit 是 hygiene / cost / inject / dream / links 的') && first(homeStray).includes('home 不读它'),
    first(homeStray).slice(0, 140),
  )

  const costClean = text(await run('memory_admin', { action: 'cost', limit: 50 }))
  check(
    'AY4 正常调用不许冒出这句（cost 本来就读 limit）',
    !costClean.includes('不读它') && !costClean.includes('一点没参与'),
    first(costClean).slice(0, 120),
  )

  const guideStray = text(await run('memory_admin', { action: 'guide', limit: 5 }))
  check(
    'AY5 手册豁免抬头但不豁免说话：末尾补 limit 那句，第一行仍是门牌',
    guideStray.startsWith('宏记忆有三个面') && guideStray.includes('limit 是 hygiene / cost / inject / dream / links 的'),
    guideStray.split('\n').slice(-1)[0].slice(0, 120),
  )

  const sourcesStray = text(await run('memory_admin', { action: 'sources', verbose: true, kind: 'dup' }))
  check(
    'AY6 sources 配了 verbose + kind：verbose 是它读的，只有 kind 该被点名',
    first(sourcesStray).includes('kind 是 hygiene 的') && !first(sourcesStray).includes('verbose 是'),
    first(sourcesStray).slice(0, 140),
  )

  const multiStray = text(
    await run('memory_admin', { action: 'ingest', provider: 'hindsight', items: [{ title: 'k' }], kind: 'dup', hubs: 3 }),
  )
  check(
    'AY7 一次给两个不相干的参数：两句都点名，且用「它们」',
    first(multiStray).includes('kind 是 hygiene 的') &&
      first(multiStray).includes('hubs 是 stats 的') &&
      first(multiStray).includes('ingest 不读它们'),
    first(multiStray).slice(0, 170),
  )

  const hygClean = text(await run('memory_admin', { action: 'hygiene', kind: 'dup', limit: 3 }))
  check('AY8 hygiene 本来就读 kind + limit：一个字都不许多', !hygClean.includes('一点没参与'), first(hygClean).slice(0, 120))

  // 行数不能拿两次调用比（成本账本自己会记账，多调一次就多一行）——看结构：
  // 那句必须贴在抬头那一行上，不许自己另起一行把正文顶下去。
  const costStray2 = text(await run('memory_admin', { action: 'cost', kind: 'dup' }))
  check(
    'AY9 尾注不另起一行：贴在抬头那行，第二行起仍是正文',
    first(costStray2).startsWith('【宏记忆｜成本账本】') &&
      first(costStray2).includes('kind 是 hygiene 的') &&
      !String(costStray2.split('\n')[1] ?? '').includes('kind 是'),
    String(costStray2.split('\n')[1] ?? '').slice(0, 80),
  )
}

// ── AZ. 还剩两个口子：id 只在 similar 有用，memory_ids 只在扩散时有用（0.2.69）────
// 0.2.67 把「相似模式认不认别人」说清了，反向两个口子还沉默着：`id` 写在 local/graph/bridge
// 里被丢掉；`memory_ids` 一旦这次没扩散就完全没参与——读者会以为「就是从这几个 id 起跳的」。
{
  const { createUnifiedTools } = await import(pathToFileURL(join(root, 'lib/macro/tools.js')).href)
  const LOCAL_TEXT = '命中 1 条：\n- [m1] 第一条'
  const mk = ({ recall = 'ok', hits = 1 } = {}) => {
    const seen = []
    const bridge = {
      has: () => true,
      get: () => undefined,
      names: () => ['memory_search', 'nebula_recall'],
      awaitTool: async (n) => ({ name: n }),
      call: async (name, args) => {
        seen.push({ name, args })
        return { entry: { name }, value: { hits: Array.from({ length: hits }, () => ({})) }, text: LOCAL_TEXT }
      },
      tryCall: async (name, args) => {
        seen.push({ name, args })
        if (name === 'nebula_recall' && recall === 'absent') return { entry: null, text: '星图扩散未完成：星图没接上' }
        if (name === 'nebula_recall') return { entry: { name }, value: {}, text: '— 星图关联扩散 —\n- [m9] 第九条' }
        return { entry: { name }, value: { hits: Array.from({ length: hits }, () => ({})) }, text: LOCAL_TEXT }
      },
      promptDeclarations: () => [],
    }
    const tools = createUnifiedTools({ bridge, config: { toolWaitMs: 10, linkWaitMs: 10, flushThrottleMs: 0 } })
    return { search: tools.find((t) => t.name === 'memory_search'), seen }
  }
  const run = async (opts, args) => {
    const { search, seen } = mk(opts)
    return { text: String(await search.execute(args, {})), seen }
  }
  const tail = (t) => t.split('\n').slice(-1)[0].slice(0, 100)

  // AZ1: local + memory_ids 但没扩散（命中 1 条、没给 expand）
  {
    const r = await run({}, { query: '泡泡', memory_ids: ['aaaa1111'], expand: false })
    check(
      'AZ1 local 命中后不扩散时给了 memory_ids：必须说「这次没有扩散，它没用上」',
      r.text.includes('memory_ids 只在扩散时当起点') && r.text.includes('这次没有扩散，它没用上'),
      tail(r.text),
    )
  }
  // AZ2: local + expand 但星图没接上
  {
    const r = await run({ recall: 'absent' }, { query: '泡泡', memory_ids: ['aaaa1111'], expand: true })
    check(
      'AZ2 本来要扩散、星图没接上：memory_ids 要说「没参与这次结果」',
      r.text.includes('memory_ids') && r.text.includes('星图没接上') && r.text.includes('它没参与这次结果'),
      tail(r.text),
    )
  }
  // AZ3: local + expand 真的扩散了
  {
    const r = await run({}, { query: '泡泡', memory_ids: ['aaaa1111'], expand: true })
    const sent = r.seen.find((s) => s.name === 'nebula_recall')
    check(
      'AZ3 真的扩散了：memory_ids 要说「这次真的用上了」，且它真被当成起点传下去',
      r.text.includes('memory_ids 这次真的用上了') &&
        Array.isArray(sent?.args?.memory_ids) &&
        sent.args.memory_ids[0] === 'aaaa1111',
      `${tail(r.text)} 起点=${JSON.stringify(sent?.args?.memory_ids)}`,
    )
  }
  // AZ4: local + id —— id 只属于相似模式
  {
    const r = await run({}, { query: '泡泡', id: 'abc12345' })
    check(
      'AZ4 local 模式给了 id：必须说「id 只在 mode=similar 里当基准」',
      r.text.includes('id 只在 mode=similar 里当基准') && r.text.includes('这次没用上它'),
      tail(r.text),
    )
  }
  // AZ5: graph + id —— 同样点名
  {
    const r = await run({}, { mode: 'graph', query: '泡泡', id: 'abc12345' })
    check(
      'AZ5 graph 模式给了 id：也要点名（这次是 graph）',
      r.text.includes('id 只在 mode=similar 里当基准') && r.text.includes('（这一问是 graph）'),
      tail(r.text),
    )
  }
  // AZ6: graph + memory_ids 是正当的 —— 不许冒 local 那句
  {
    const r = await run({}, { mode: 'graph', query: '泡泡', memory_ids: ['aaaa1111'] })
    check(
      'AZ6 graph 模式给 memory_ids 正当（它就是起点），不许冒「只在扩散时当起点」',
      !r.text.includes('memory_ids 只在扩散时当起点') && !r.text.includes('memory_ids 这次真的用上了'),
      tail(r.text),
    )
  }
  // AZ7: similar + id 是主语 —— 不许被 AZ4 那条碰到（回归）
  {
    const r = await run({}, { mode: 'similar', id: 'abc12345' })
    check(
      'AZ7 similar 模式给 id 是正当的，不许冒「id 只在 mode=similar 里当基准」',
      !r.text.includes('id 只在 mode=similar 里当基准'),
      tail(r.text),
    )
  }
  // AZ8: 只给 query —— 一句尾注都不许多
  {
    const r = await run({}, { query: '泡泡' })
    check(
      'AZ8 只给 query 时不许冒出任何新尾注',
      !r.text.includes('id 只在 mode=similar') && !r.text.includes('memory_ids 只在扩散时当起点'),
      tail(r.text),
    )
  }
}

// ── BA. 运维面板的卡片：前缀是面板名、细节是这一轮的参数（0.2.70）──────────────
// 卡片不是回执，它是会话里并排躺着的那一行标题：两轮只差一个 kind，标题却一字不差，
// 用户就没法靠它认出「哪张是只看重复的」。这里钉住三件事：前缀不带品牌、细节是输入、
// 顺序与预算都由 panel.js 管。
{
  const adminTool = tools.get('memory_admin')
  const cardAdmin = (args) => adminTool.presentCall(args ?? {})
  const t1 = cardAdmin({ action: 'cost' }).title
  check(
    'BA1 前缀就是面板中文名，不带品牌（抬头已经有【宏记忆｜…】）',
    t1 === '成本账本' && !t1.includes('宏记忆') && !t1.includes('cost'),
    t1,
  )
  check(
    'BA2 给了 kind 就进卡片：两轮不再长得一样',
    cardAdmin({ action: 'hygiene', kind: 'dup' }).title === '记忆体检：kind=dup' &&
      cardAdmin({ action: 'hygiene' }).title === '记忆体检',
    cardAdmin({ action: 'hygiene', kind: 'dup' }).title,
  )
  check(
    'BA3 多个参数按 PARAM_OWNERS 的键序排（kind 在 limit 前，与 schema 写法无关）',
    cardAdmin({ action: 'hygiene', limit: 5, kind: 'dup' }).title === '记忆体检：kind=dup limit=5',
    cardAdmin({ action: 'hygiene', limit: 5, kind: 'dup' }).title,
  )
  check(
    'BA4 没给的参数不进卡片（不留悬空冒号、不留多余空格）',
    cardAdmin({ action: 'stats' }).title === '星图概况' &&
      !/：\s*$/.test(cardAdmin({ action: 'stats', hubs: 3 }).title) &&
      cardAdmin({ action: 'stats', hubs: 3 }).title === '星图概况：hubs=3',
    cardAdmin({ action: 'stats', hubs: 3 }).title,
  )
  check(
    'BA5 数组说条数，不许把 [object Object] 贴上去',
    cardAdmin({ action: 'ingest', provider: 'hindsight', items: [{ title: 'a' }, { title: 'b' }] }).title ===
      '外部记忆推入：provider=hindsight items=2 条',
    cardAdmin({ action: 'ingest', provider: 'hindsight', items: [{ title: 'a' }, { title: 'b' }] }).title,
  )
  check(
    'BA6 未知 action：卡片带上用户写的值，不给「未知动作」四个字就完事',
    cardAdmin({ action: 'nope' }).title === '未知动作：nope' && cardAdmin({}).title === '未知动作',
    cardAdmin({ action: 'nope' }).title,
  )
  const longTarget = `D:\\${'很长的目录名'.repeat(12)}`
  const longCard = cardAdmin({ action: 'home', target: longTarget }).title
  check(
    'BA7 长参数仍受 40 字预算约束（截断加省略号，不把卡片撑爆）',
    longCard.endsWith('…') && longCard.length <= 40 + '记忆库位置：'.length + 1,
    `${longCard.length} 字`,
  )
  const allCards = [
    ['memory_remember', { project: '探针项目' }],
    ['memory_update', { id: '0m1abc' }],
    ['memory_search', { query: '探针' }],
    ['memory_read', { id: '0m1abc' }],
    ['memory_project', { project: '探针项目' }],
    ['memory_link', { action: 'link', a: '0m1abc', b: '0m2def' }],
    ['memory_dream', {}],
    ['memory_admin', { action: 'cost' }],
  ].map(([n, a]) => tools.get(n).presentCall(a).title)
  check(
    'BA8 八个工具的卡片口径一致：没有一个把品牌写进标题',
    allCards.every((t) => !t.includes('宏记忆')) && allCards.every((t) => typeof t === 'string' && t.length > 0),
    allCards.join(' | ').slice(0, 140),
  )
}


// ── F. 检索融合：两路名次合成一张榜（0.2.118）────────────────────────────────
// 老做法把本地结果与星图回执上下拼两段：同一堆记忆出现两遍，第二遍白花 token，
// 而「两条路都命中」这条最硬的相关性证据没人指出来。这里只按**名次**合（RRF）——
// 两路分数不同源（BM25 与星图强度），比大小等于编结论。
{
  const { createUnifiedTools } = await import(pathToFileURL(join(root, 'lib/macro/tools.js')).href)
  const fusionF = await import(pathToFileURL(join(root, 'lib/macro/fusion.js')).href)
  const tokF = await import(pathToFileURL(join(root, 'lib/macro/tokencost.js')).href)

  const GRAPH_TEXT = [
    'nebula_recall「检索融合」→ 3 条（扫描 42 条候选，2 跳）',
    '1. [fact] dsh-macro-memory     强度 0.82 检索融合 RRF',
    '   id: dsh-macro-memory:0mfa1111-1111222233334444555566667777aaaa',
    '   为什么：直接命中关键词「融合」',
    '   摘要：把本地检索与星图扩散按名次合成一张榜，重复条目只出现一次。',
    '2. [lesson] dsh-macro-memory     强度 0.61 名次不是分数',
    '   id: dsh-macro-memory:0mfa1111-bbbb2222333344445555666677778888',
    '   为什么：经由「RRF」的关键词关联',
    '   摘要：两路分数不同源，比大小是在编结论。',
    '3. [fact] other-ws     强度 0.95 分数最高但排第三',
    '   id: other-ws:0mfa1111-cccc2222333344445555666677779999',
    '   为什么：共同邻居「记忆」',
    '   摘要：与当前问题弱相关。',
  ].join('\n')

  const HIT_A = {
    id: '0mfa1111-1111222233334444555566667777aaaa',
    level: 'fact',
    title: '检索融合',
    content: '本地给全文：把本地检索与星图扩散按名次合成一张榜。',
    keywords: ['融合', 'RRF'],
  }
  const HIT_B = {
    id: '0mfa1111-dddd2222333344445555666677770000',
    level: 'fact',
    title: '本地独有',
    content: '只在本地出现的条目。',
    keywords: ['本地'],
  }
  const LOCAL_NOTE = '默认检索范围是 fact/lesson/topic/rules。'
  const LOCAL_TEXT = `${LOCAL_NOTE}\n1. [fact] 检索融合\n2. [fact] 本地独有`

  const bridgeF = (hits, graphText) => {
    const entries = new Map()
    const add = (name, fn) => entries.set(name, { name, vendor: 'stub', def: { name, execute: fn }, options: {} })
    add('memory_search', async () => ({ hits, note: LOCAL_NOTE }))
    add('nebula_recall', async () => graphText)
    const bridge = {
      has: (n) => entries.has(n),
      get: (n) => entries.get(n),
      names: () => [...entries.keys()],
      awaitTool: async (n) => entries.get(n),
      async call(name) {
        const e = entries.get(name)
        if (!e) throw new Error('macro-memory：这项能力还没就绪')
        const value = await e.def.execute({})
        return { entry: e, def: e.def, value, text: typeof value === 'string' ? value : LOCAL_TEXT }
      },
      async tryCall(name) {
        return bridge.call(name)
      },
      promptDeclarations: () => [],
    }
    return bridge
  }
  const callF = async (hits, graphText, args) => {
    const tools = createUnifiedTools({ bridge: bridgeF(hits, graphText), config: { toolWaitMs: 10, linkWaitMs: 10, flushThrottleMs: 0 } })
    return String(await tools.find((t) => t.name === 'memory_search').execute(args, {}))
  }

  const nodes = fusionF.graphNodesOf(GRAPH_TEXT)
  check(
    'F1 解析得动真实那三行格式（排名/层级/强度/标题/为什么/摘要）',
    nodes.length === 3 &&
      nodes[0].rank === 1 &&
      nodes[0].level === 'fact' &&
      nodes[0].score === 0.82 &&
      nodes[0].label.includes('检索融合') &&
      nodes[1].why.includes('RRF') &&
      nodes[2].preview.includes('弱相关'),
    nodes.map((n) => `${n.rank}:${n.level}:${n.score}`).join(' '),
  )
  check(
    'F2 星图 id 带工作区前缀，裸 id 取最后一段',
    fusionF.uidOf(nodes[0].id) === '0mfa1111-1111222233334444555566667777aaaa',
    fusionF.uidOf(nodes[0].id),
  )

  const fused = fusionF.fuseRanked({ localHits: [HIT_A, HIT_B], graphNodes: nodes })
  check(
    'F3 两路都命中的只算一行（3 个星图节点 + 2 条本地命中，重复 1 条 → 4 行）',
    fused.both === 1 && fused.graphOnly === 2 && fused.localOnly === 1 && fused.rows.length === 4,
    `both=${fused.both} graphOnly=${fused.graphOnly} localOnly=${fused.localOnly} rows=${fused.rows.length}`,
  )
  check(
    'F4 交叉验证的那条排第一（两路都命中是 RRF 分最高的组合）',
    fused.rows[0].localRank === 1 && fused.rows[0].graphRank === 1 && fused.rows[0].rrf > fused.rows[1].rrf,
    `${fused.rows[0].localRank}/${fused.rows[0].graphRank} ${fused.rows[0].rrf.toFixed(5)} > ${fused.rows[1].rrf.toFixed(5)}`,
  )
  const cIdx = fused.rows.findIndex((r) => r.uid.startsWith('0mfa1111-cccc'))
  check(
    'F5 名次说了算，分数再高也不许插队（0.95 但排第三就排第三）',
    cIdx === fused.rows.length - 1 && nodes[2].score > nodes[0].score,
    `第 ${cIdx + 1}/${fused.rows.length} 位，星图分 ${nodes[2].score} 对 ${nodes[0].score}`,
  )
  const shortFuse = fusionF.fuseRanked({ localHits: [{ id: '0mfa1111-bbbb2222' }], graphNodes: nodes })
  check(
    'F6 星图只给前 12 位也认得出是同一条（前缀不是另一条记忆）',
    shortFuse.both === 1 && shortFuse.rows.filter((r) => r.uid.startsWith('0mfa1111-bbbb')).length === 1,
    `both=${shortFuse.both} rows=${shortFuse.rows.length}`,
  )

  const fusedBody = fusionF.fusedText({ note: LOCAL_NOTE, rows: fused.rows, k: 2, graphShown: 5, dropped: 0 })
  check(
    'F7 榜上每条只出现一次，也不再另起「星图关联扩散」那一段',
    (fusedBody.match(/0mfa1111-1111222233334444555566667777aaaa/g) || []).length === 1 &&
      (fusedBody.match(/0mfa1111-bbbb2222333344445555666677778888/g) || []).length === 1 &&
      !fusedBody.includes('— 星图关联扩散 —'),
    `${fusedBody.split('\n').length} 行`,
  )
  check(
    'F8 本地条目带全文，星图独有的只带「为什么相关」+ 摘要',
    fusedBody.includes('本地给全文：把本地检索与星图扩散按名次合成一张榜。') &&
      fusedBody.includes('（本地没命中，靠关联进来：经由「RRF」的关键词关联）') &&
      fusedBody.includes('两路分数不同源，比大小是在编结论。'),
    fusedBody.split('\n')[4] ?? '',
  )
  check(
    'F9 每条都写明它从哪一路来（本地#n / 星图#m / 两路）',
    fusedBody.includes('本地#1 + 星图#1') && fusedBody.includes('本地#2 ·') && fusedBody.includes('星图#3（本地没命中'),
    fusedBody.split('\n')[1] ?? '',
  )
  const cut = fusionF.fusedText({ note: '', rows: fused.rows, k: 2, graphShown: 1, dropped: 1 })
  check(
    'F10 星图独有被截断时说清「另有几条没展开」',
    cut.includes('另有 1 条星图带回来的没有展开') && cut.includes('只够前 1 条'),
    cut.split('\n').slice(-1)[0],
  )

  const out = await callF([HIT_A, HIT_B], GRAPH_TEXT, { query: '融合', expand: true })
  check(
    'F11 端到端：expand=true 时给的是融合榜，不是两段拼接',
    out.includes('融合榜（本地 # / 星图 # 两路按名次合并') &&
      out.includes('两路都命中 1 条') &&
      !out.includes('— 星图关联扩散 —'),
    out.split('\n')[0]?.slice(0, 90) ?? '',
  )
  check(
    'F12 端到端：本地那条正文只出现一次（融合确实省了重复的 token）',
    (out.match(/本地给全文：把本地检索与星图扩散按名次合成一张榜。/g) || []).length === 1,
    `${(out.match(/本地给全文/g) || []).length} 次`,
  )
  const legacy = await callF([HIT_A, HIT_B], '— 星图关联扩散 —\n- [m9] 第九条', { query: '融合', expand: true })
  check(
    'F13 星图回执解析不出节点时退回两段式（不硬凑半张榜）',
    legacy.includes('— 星图关联扩散 —') && !legacy.includes('融合榜'),
    legacy.split('\n').slice(-1)[0],
  )
  const oldStyle = `${LOCAL_TEXT}\n\n— 星图关联扩散 —\n${GRAPH_TEXT}`
  const fusedCost = tokF.estTokens(fusedBody)
  const oldCost = tokF.estTokens(oldStyle)
  check(
    'F14 融合确实省 token：同一堆记忆只出现一次，星图独有只带证据',
    fusedCost < oldCost,
    `融合 ≈${fusedCost} token < 两段式 ≈${oldCost} token（省 ${Math.round((1 - fusedCost / oldCost) * 100)}%）`,
  )
}

// ── SR. 检索回执要能自答：正文 / 日期 / 截断交代（0.2.121）─────────────────────
// 0.2.120 之前 render 只印 `关于：关键词`，正文一个字不给：检索排前面却读不到内容，
// 每条命中都要再 memory_read 一次；content_max 在 execute 里截好了，却没人打印——
// 预算那套「砍 content_max」的旋钮因此是空的（砍了回执一字不变）。
// 这里从**统一工具**打进去（renderToolText → 子插件 render 这条路），不是直接调 vendor。
{
  const LONG = '词干归一是检索的地基：researching 与 research 不归一，多跳题就永远差一个词。'.repeat(12)
  const tailSrc = (t) => t.split('\n').filter((l) => l.trim() !== '').slice(-1)[0]
  const wrote = await run('memory_remember', {
    content: LONG,
    project: '渲染探针',
    keywords: ['2026-03-14', 'tokenize', '词干', '归一'],
    importance: 3,
    level: 'lesson',
  })
  check('SR0 写入一条长正文（带日期关键词）', text(wrote).includes('记忆已写入') || text(wrote).includes('已合并'), text(wrote).split('\n')[0])

  const got = text(await run('memory_search', { query: '词干 归一 tokenize research', k: 3, content_max: 300 }))
  check('SR1 回执带正文（不是只有「关于：关键词」）', got.includes('词干归一是检索的地基'), got.slice(0, 80))
  check('SR2 抬头带日期（keywords 里的 YYYY-MM-DD 落到抬头）', /\[[^\]]+ · 2026-03-14\]/.test(got), got.split('\n').find((l) => l.includes('2026-03-14')) ?? '没找到')
  check('SR3 截断有交代（已截断 + 指到 memory_read）', got.includes('已截断') && got.includes('memory_read'), tailSrc(got))

  const full = text(await run('memory_search', { query: '词干 归一 tokenize research', k: 3, content_max: 0 }))
  check('SR4 content_max=0 时不标截断、正文齐全', !full.includes('已截断') && full.includes(LONG.slice(0, 200)), `${full.length} 字`)

  // 阴性对照：老渲染（只印抬头）在这几条判据上必须红——判据真的能红。
  const legacyLike = '[渲染探针 : lesson] [0m…] [刚刚] 关于：2026-03-14, tokenize, 词干, 归一'
  check(
    'SR4b 阴性对照：只印抬头的老格式过不了 SR1/SR3',
    !legacyLike.includes('词干归一是检索的地基') && !legacyLike.includes('已截断'),
  )

  // 真 vendor 工具的 value 层：day / truncated / content 长度 三个字段各就各位。
  const srHome = mkdtempSync(join(tmpdir(), 'macro-probe-render-'))
  const srWs = join(srHome, 'ws')
  mkdirSync(srWs, { recursive: true })
  const T = new Map()
  Meow.registerMemoryTools((t) => T.set(t.name, t), '.dsh-meow')
  // 新工作区要先开一次库（等价于会话第一条消息到达），否则 #64 的信任闸会把写入挡掉。
  Meow.getDb(srWs, '.dsh-meow')
  const srExec = { agent: { session: { header: { cwd: srWs, id: 'sess-sr' } } } }
  const srRun = (name, args) => T.get(name).execute(args, srExec)
  await srRun('memory_remember', { content: LONG, project: '渲染探针', keywords: ['2026-03-14', '词干'], importance: 2, level: 'lesson' })
  const srValue = await srRun('memory_search', { query: '词干', k: 3, content_max: 300 })
  const srHit = srValue.hits[0]
  check('SR5 value 里 content 已按 content_max 截断（300 字）', srHit.content.length === 300, String(srHit.content.length))
  check('SR5 value 里 truncated=true（原文更长）', srHit.truncated === true, String(srHit.truncated))
  check('SR5 value 里 day 从 keywords 派生', srHit.day === '2026-03-14', JSON.stringify(srHit.day))
  const srFull = await srRun('memory_search', { query: '词干', k: 3, content_max: 0 })
  check('SR5 content_max=0 时 value 不标截断（截断标记要跟旋钮走）', srFull.hits[0].truncated === undefined, JSON.stringify(srFull.hits[0].truncated))
  try {
    rmSync(srHome, { recursive: true, force: true })
  } catch {
    /* ignore */
  }

  // 预算旋钮不再是空的：budget 收紧要么真的把正文变短、要么明说没派上用场。
  const loose = text(await run('memory_search', { query: '词干 归一', k: 10, content_max: 300 }))
  const tight = text(await run('memory_search', { query: '词干 归一', k: 10, content_max: 300, budget: 260 }))
  check('SR6 预算收紧时回执真的变短（content_max 旋钮不再是空的）', tight.length < loose.length || tight.includes('没派上用场'), `${loose.length} → ${tight.length}`)
  check('SR6 砍了什么都写在尾注里', tight.includes('预算') && (tight.includes('content_max') || tight.includes('k ')), tailSrc(tight))
}

// ── ER. 实体先验：问句里的专有名词要能压过措辞（0.2.122）─────────────────────
{
  const erDocs = [
    { id: 'a', level: 'fact', content: 'Caroline: I am researching adoption agencies.', keywords: [], importance: 1, updated_at: 1, last_accessed_at: 1 },
    { id: 'b', level: 'fact', content: 'Melanie: research is exhausting, I research all day.', keywords: [], importance: 1, updated_at: 1, last_accessed_at: 1 },
  ]
  const erQ = 'What did Caroline research?'
  const on = Meow.search(erQ, erDocs, { k: 2, now: null, explain: true })
  const off = Meow.search(erQ, erDocs, { k: 2, now: null, entityPrior: false, explain: true })
  const pick = (hs, id) => hs.find((h) => h.id === id)
  check('ER0 实体问句抓到 1 个实体（句首那个大写词不算）', on[0]?.explain?.entities === 1, String(on[0]?.explain?.entities))
  check('ER1 实体问句：提到实体的那条压过只提到其余词的', on[0]?.id === 'a', on.map((h) => h.id).join(','))
  check(
    'ER3 关掉先验后实体那条正好回到 1/1.8（加成只来自这条先验，不是别的巧合）',
    Math.abs(pick(on, 'a').score / pick(off, 'a').score - 1.8) < 0.005,
    `${pick(on, 'a').score.toFixed(4)} / ${pick(off, 'a').score.toFixed(4)}`,
  )
  check(
    'ER2 不含实体的那条分数一位都没动（先验不许外溢到别的文档）',
    pick(on, 'b').score === pick(off, 'b').score,
    `${pick(on, 'b').score} vs ${pick(off, 'b').score}`,
  )
  const plainQ = 'research agencies adoption'
  const plainOn = Meow.search(plainQ, erDocs, { k: 2, now: null })
  const plainOff = Meow.search(plainQ, erDocs, { k: 2, now: null, entityPrior: false })
  check(
    'ER4 阴性对照：问句里没有专有名词时，开与关逐位相同（含分数）',
    JSON.stringify(plainOn.map((h) => [h.id, h.score])) === JSON.stringify(plainOff.map((h) => [h.id, h.score])),
    plainOn.map((h) => `${h.id}:${h.score.toFixed(3)}`).join(' '),
  )
}

// ── CT. 上下文窗口：命中是「一句话」，答案常在它前后（0.2.123）─────────────────
{
  const ctHome = mkdtempSync(join(tmpdir(), 'macro-probe-ctx-'))
  const ctWs = join(ctHome, 'ws')
  mkdirSync(ctWs, { recursive: true })
  const CT = new Map()
  Meow.registerMemoryTools((t) => CT.set(t.name, t), '.dsh-meow')
  Meow.getDb(ctWs, '.dsh-meow')
  const ctExec = { agent: { session: { header: { cwd: ctWs, id: 'sess-ct' } } } }
  const ctRun = (name, args) => CT.get(name).execute(args, ctExec)
  await ctRun('memory_remember', { content: 'Alice: 我们明天去看鲸鱼。', project: '上下文探针', keywords: ['鲸鱼', '前'], importance: 2, level: 'fact' })
  await ctRun('memory_remember', { content: 'Bob: 好，几点集合？', project: '上下文探针', keywords: ['鲸鱼', '命中'], importance: 2, level: 'fact' })
  await ctRun('memory_remember', { content: 'Alice: 早上七点，码头见。', project: '上下文探针', keywords: ['鲸鱼', '后'], importance: 2, level: 'fact' })
  const ctOld = await ctRun('memory_search', { query: '几点集合', k: 1 })
  check('CT0 context=0 时回执与老格式逐字相同', ctOld.hits[0].context === undefined, JSON.stringify(ctOld.hits[0].context ?? null).slice(0, 40))
  const ctOn = await ctRun('memory_search', { query: '几点集合', k: 1, context: 1 })
  const win = ctOn.hits[0].context
  check(
    'CT1 context=1 带出前后各一条',
    (win?.before?.[0]?.content ?? '').includes('看鲸鱼') && (win?.after?.[0]?.content ?? '').includes('码头见'),
    JSON.stringify([win?.before?.length, win?.after?.length]),
  )
  const ctText = CT.get('memory_search').output.render({ context: 1 }, ctOn).map((t) => t.text).join('\n')
  check('CT1 回执里 ↑ 印前、↓ 印后（各自带写入日期）', /\u2191 \d{4}-\d{2}-\d{2} Alice/.test(ctText) && /\u2193 \d{4}-\d{2}-\d{2} Alice/.test(ctText), ctText.split('\n').slice(1, 4).join(' / '))
  // 跨层不串味：相邻写一条 lesson，fact 的邻居里不许出现它
  await ctRun('memory_remember', { content: '教训：七点太早，下次改九点。', project: '上下文探针', keywords: ['鲸鱼', '教训'], importance: 2, level: 'lesson' })
  const ctCross = await ctRun('memory_search', { query: '几点集合', k: 1, context: 3, level: 'fact' })
  const flat = JSON.stringify(ctCross.hits[0].context ?? {})
  check('CT3 跨层不串味：fact 的邻居不会把 lesson 拼进来', !flat.includes('七点太早'), flat.slice(0, 80))
  // archive 掉后一句，它要从窗口里消失
  const afterId = win?.after?.[0]?.id
  await ctRun('memory_update', { id: afterId, status: 'archived' })
  const ctGone = await ctRun('memory_search', { query: '几点集合', k: 1, context: 1 })
  check('CT2 邻居被 archive 后不再出现在上下文里', !JSON.stringify(ctGone.hits[0].context ?? {}).includes('码头见'), JSON.stringify(ctGone.hits[0].context ?? {}).slice(0, 60))
  const ctBig = await ctRun('memory_search', { query: '几点集合', k: 1, context: 9 })
  check(
    'CT4 context 上限 3（传 9 只取 3 条）',
    (ctBig.hits[0].context?.before?.length ?? 0) <= 3 && (ctBig.hits[0].context?.after?.length ?? 0) <= 3,
    JSON.stringify([ctBig.hits[0].context?.before?.length, ctBig.hits[0].context?.after?.length]),
  )
  try {
    rmSync(ctHome, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
}

// ── CT5/CT6. 融合层：context 要能穿过统一工具，预算紧时先关窗口（0.2.124）──────
// CT0–CT4 打的是 meow 自己的工具；这条打的是**统一工具**——它有自己的 schema，
// 参数不在 pick 列表里就一个字节都传不下去（第一版就漏在主路上，窗口永远空）。
{
  const P = '融合窗口探针'
  const tailOf = (t) => t.split('\n').filter((l) => l.trim() !== '').slice(-1)[0]
  await run('memory_remember', { content: '融合探针：Alice 说明天去看鲸鱼。', project: P, keywords: ['鲸鱼', '融合前'], importance: 2, level: 'fact' })
  await run('memory_remember', { content: '融合探针：Bob 问几点集合？', project: P, keywords: ['鲸鱼', '融合中'], importance: 2, level: 'fact' })
  await run('memory_remember', { content: '融合探针：Alice 说七点码头见。', project: P, keywords: ['鲸鱼', '融合后'], importance: 2, level: 'fact' })

  const plain = text(await run('memory_search', { query: '几点集合', k: 1, project: P }))
  check('CT5a 融合层 context 默认 0：回执里没有 ↑（一个字节都不多花）', !plain.includes('\u2191'), `${plain.length} 字`)

  const withCtx = text(await run('memory_search', { query: '几点集合', k: 1, context: 1, project: P }))
  check(
    'CT5 融合层：context=1 穿到 meow，回执带 ↑ 前 / ↓ 后',
    /\u2191 \d{4}-\d{2}-\d{2} 融合探针：Alice 说明天去看鲸鱼。/.test(withCtx) && /\u2193 \d{4}-\d{2}-\d{2} 融合探针：Alice 说七点码头见。/.test(withCtx),
    withCtx.split('\n').slice(-3).join(' / '),
  )

  // 预算紧到装不下带窗口的那一份：先关窗口，不砍字、不砍条数。
  const tight = text(await run('memory_search', { query: '几点集合', k: 1, context: 1, project: P, budget: 120 }))
  check(
    'CT6 融合层：装不下时先关窗口（context 1→0），字和条数一个没动',
    tailOf(tight).includes('context 1→0') && !tight.includes('\u2191'),
    tailOf(tight).slice(0, 90),
  )
}

// ── DT. 同一条不印两遍 + 邻居行封顶（0.2.126，0.2.132 分档）────────────────────────────────
{
  const dtHome = mkdtempSync(join(tmpdir(), 'macro-probe-dedupe-'))
  const dtWs = join(dtHome, 'ws')
  mkdirSync(dtWs, { recursive: true })
  const DT = new Map()
  Meow.registerMemoryTools((t) => DT.set(t.name, t), '.dsh-meow')
  Meow.getDb(dtWs, '.dsh-meow')
  const dtExec = { agent: { session: { header: { cwd: dtWs, id: 'sess-dt' } } } }
  const dtRun = (name, args) => DT.get(name).execute(args, dtExec)
  const render = (value, args = {}) => DT.get('memory_search').output.render(args, value).map((t) => t.text).join('\n')
  const bodyOnly = (tx) => tx.split('\n').filter((l) => l.trim().length > 0 && !l.startsWith('[')).join('\n')
  const countIn = (hay, needle) => hay.split(needle).length - 1

  for (const content of [
    'Dana: 我们周六去潜水。',
    'Dana: 潜水装备要提前租。',
    'Dana: 租装备的地方在码头二楼。',
    'Dana: 下午三点才开门。',
  ]) {
    await dtRun('memory_remember', { content, project: '去重探针', keywords: ['潜水', '装备'], importance: 2, level: 'fact' })
  }
  const two = await dtRun('memory_search', { query: '潜水 装备 租 开门', k: 3, context: 1, min_rel: 0, project: '去重探针' })
  const txTwo = render(two, { context: 1 })
  check(
    'DT0 相邻两条命中：同一句只印一遍（上一条的 ↓ 不再重复下一条的正文）',
    countIn(bodyOnly(txTwo), '潜水装备要提前租') === 1 && countIn(bodyOnly(txTwo), '码头二楼') === 1,
    JSON.stringify([countIn(bodyOnly(txTwo), '潜水装备要提前租'), countIn(bodyOnly(txTwo), '码头二楼')]),
  )
  check('DT0 真正的邻居照样印（前一句 / 后一句都在）', txTwo.includes('我们周六去潜水') && txTwo.includes('下午三点才开门'))

  const topics = ['潮汐', '码头', '气瓶', '脚蹼', '船期', '教练', '夜潜', '保暖衣', '接驳车', '保险费']
  const songs = [
    '鲸歌录音时长三分半，水听器放在船尾。',
    '傍晚风小的时候最容易听到鲸歌，海面几乎没浪。',
    '录到的鲸歌属于座头鲸，低频段重复三次。',
    '鲸歌的音量在深水区比浅水区高出一截。',
    '鲸歌样本存进了硬盘的第三个分区。',
  ]
  let k = 0
  // 64 条：深档 48 行的闸门才会真的顶住（40 条时可用邻居只有 30 行，不触发截断说明）
  for (let i = 0; i < 64; i++) {
    const isHit = i % 8 === 0 && k < songs.length
    const content = isHit ? songs[k++] : `第 ${i} 条：${topics[i % topics.length]}的记录（不相关）。`
    await dtRun('memory_remember', { content, project: '封顶探针', keywords: isHit ? ['鲸歌', '录音'] : [topics[i % topics.length]], importance: 2, level: 'fact' })
  }
  const spread = await dtRun('memory_search', { query: '鲸歌 录音 水听器', k: 8, context: 3, min_rel: 0, project: '封顶探针' })
  const txSpread = render(spread, { context: 3, query: '鲸歌 录音 水听器' })
  const ctxRows = txSpread.split('\n').filter((l) => /^\s+[\u2191\u2193] /.test(l)).length
  check('DT1 邻居行封顶：不问时间的题铺到 48 行（0.2.132）', ctxRows > 24 && ctxRows <= 48, `${ctxRows} 行`)
  const txNarrow = render(spread, { context: 3, query: '我们什么时候去听鲸歌？' })
  const narrowRows = txNarrow.split('\n').filter((l) => /^\s+[\u2191\u2193] /.test(l)).length
  check('DT1b 邻居行封顶：问时间的题只铺 24 行（日期不被稀释）', narrowRows === 24, `${narrowRows} 行`)
  // 截断说明只在真被闸门挡下时才有：这一组 30 行邻居，窄档（24）正好挡下 6 行，深档（48）不挡
  check(
    'DT2 截断时留一行说明还剩几行（省 token 不许悄悄少给）',
    /邻居还有 \d+ 行没铺开/.test(txNarrow) &&
      txNarrow.includes('memory_read') &&
      txNarrow.includes('一次最多 24 行') &&
      !txSpread.includes('没铺开'),
    txNarrow.split('\n').slice(-1)[0].slice(0, 80),
  )

  const plain = render(await dtRun('memory_search', { query: '潜水 装备', k: 3, project: '去重探针' }), {})
  check('DT3 context 默认 0：回执里一个 ↑ / ↓ 都没有', !plain.includes('\u2191') && !plain.includes('\u2193'), `${plain.length} 字`)

  // DT4/DT5（0.2.128）：命中行的时间到分，邻居行只到天。
  // 期望值在这里照同一套规则现算一份（写入时间整点零点时才只有日期），
  // 这样「改用 stampDay」会立刻红，又不依赖跑探针的时刻。
  const expectWhen = (ms) => {
    const d = new Date(Number(ms))
    const p2 = (v) => String(v).padStart(2, '0')
    const day = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`
    return d.getHours() === 0 && d.getMinutes() === 0 ? day : `${day} ${p2(d.getHours())}:${p2(d.getMinutes())}`
  }
  const whenHit = two.hits.find((h) => String(h.content).includes('潜水装备'))
  check(
    'DT4 命中行的时间到分（比「哪条更早」时看得出先后）',
    !!whenHit && whenHit.day === expectWhen(whenHit.updated_at),
    `${String(whenHit?.day ?? '空')} vs 期望 ${expectWhen(whenHit?.updated_at ?? 0)}`,
  )
  // 判据写成「所有邻居行都不带分钟」而不是「↑ 行必须存在」：排名一变，榜首可能正好是会话第一条，
  // 那么这条查询就只有 ↓ 邻居——旧写法会空转成假红（0.2.152 关键词权重改过之后就是这样）。
  const nbLines = txTwo.split('\n').filter((l) => l.includes('\u2191') || l.includes('\u2193'))
  const nbWithMinute = nbLines.filter((l) => l.includes('\u2191') || l.includes('\u2193')).filter((l) => /\d{4}-\d{2}-\d{2} \d{2}:\d{2} /.test(l))
  check(
    'DT5 邻居行只到天（不给每一行都加分钟，字省下来留给正文）',
    nbLines.length > 0 && nbLines.every((l) => /\d{4}-\d{2}-\d{2} /.test(l)) && nbWithMinute.length === 0,
    `${nbLines.length} 条邻居行${nbLines.length > 0 ? '：' + nbLines[0].trim().slice(0, 40) : '（一条都没有，判据空转）'}`,
  )
  // TL0–TL3（0.2.129）：问句问时间时才印一行时间轴，编号与命中抬头同一套。
  const mkHit = (i, day, extra = {}) => ({
    id: `tl${i}`,
    level: 'fact',
    content: `第 ${i} 条正文`,
    project: '全局',
    keywords: ['潜水'],
    day,
    updated_at: 0,
    score: 10 - i,
    ...extra,
  })
  const tlHits = [mkHit(1, '2023-05-08 13:56'), mkHit(2, '2023-05-09 09:00'), mkHit(3, '2023-05-07 18:30')]
  const tlText = render({ note: '', hits: tlHits }, { query: '我们什么时候去潜水？' })
  const tlLine = tlText.split('\n').find((l) => l.includes('时间轴')) ?? ''
  check(
    'TL0 问句问时间：回执顶部印一行时间轴，按早到晚排',
    tlLine.includes('[3] 2023-05-07 18:30') &&
      tlLine.includes('[1] 2023-05-08 13:56') &&
      tlLine.includes('[2] 2023-05-09 09:00') &&
      tlLine.indexOf('[3]') < tlLine.indexOf('[1]') &&
      tlLine.indexOf('[1]') < tlLine.indexOf('[2]'),
    tlLine.slice(0, 120),
  )
  check(
    'TL0 命中抬头带序号，与时间轴编号同一套',
    /^\[1\] \[.* : fact\] \[tl1\] /m.test(tlText) && /^\[3\] \[.* : fact\] \[tl3\] /m.test(tlText),
    tlText.split('\n').filter((l) => /^\[\d\] \[/.test(l)).slice(0, 3).join(' / ').slice(0, 120),
  )
  const tlQuiet = render({ note: '', hits: tlHits }, { query: '潜水装备在哪租' })
  check('TL1 问句不问时间：一个字都不印（省 token 也不打扰）', !tlQuiet.includes('时间轴'), `${tlQuiet.length} 字`)
  const tlFew = render({ note: '', hits: tlHits.slice(0, 2) }, { query: '我们什么时候去潜水？' })
  check('TL2 命中不到三条：不印时间轴（两条比大小看不出趋势）', !tlFew.includes('时间轴'))
  const tlManyHits = Array.from({ length: 10 }, (_, i) => mkHit(i + 1, `2023-05-${String(10 + i).padStart(2, '0')} 09:00`))
  const tlMany = render({ note: '', hits: tlManyHits }, { query: '第一次潜水是什么时候' })
  const manyLine = tlMany.split('\n').find((l) => l.includes('时间轴')) ?? ''
  check(
    'TL3 超过 8 条：只铺最早 8 条，尾注说明还剩几条',
    manyLine.includes('…另有 2 条') && (manyLine.match(/\[\d+\] 2023-/g) ?? []).length === 8,
    manyLine.slice(-60),
  )
  try {
    rmSync(dtHome, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
}

// RI0-RI10（0.2.134）：反思不再等轮数——这一轮自己出的事故就是触发条件。
{
  const ev = (type, data) => ({ type, data })
  const tc = (id, name) => ev('assistant/message', { message: { content: [{ type: 'tool-call', id, name }] } })
  const rOk = (id) => ev('tool/result', { message: { isError: false, toolCallId: id } })
  const rBad = (id) => ev('tool/result', { message: { isError: true, toolCallId: id } })
  const riEvents = [ev('turn/start', {}), tc('c1', 'pwsh'), tc('c2', 'memory_search'), rBad('c1'), rBad('c1'), rBad('c2'), rOk('c1')]
  const ri = Meow.scanTurn(riEvents)
  check(
    'RI0 事故计数：三次失败一个不漏，成功的 tool/result 不算',
    ri.toolErrors === 3 && ri.memoryErrors === 1 && ri.worstTool === 'pwsh' && ri.worstFail === 2,
    `errors=${ri.toolErrors} memory=${ri.memoryErrors} worst=${ri.worstTool}×${ri.worstFail}`,
  )
  check(
    'RI1 事故计数：按失败次数排序，只留前四个工具',
    JSON.stringify(ri.failedTools) === JSON.stringify([['pwsh', 2], ['memory_search', 1]]),
    JSON.stringify(ri.failedTools),
  )
  const riEmpty = Meow.scanTurn([ev('turn/start', {}), tc('x1', 'pwsh'), rOk('x1')])
  check('RI2 一次都没挂：计数为零、不编造工具名', riEmpty.toolErrors === 0 && riEmpty.worstTool === undefined && riEmpty.failedTools.length === 0)
  const riNoId = Meow.scanTurn([ev('turn/start', {}), ev('tool/result', { message: { isError: true } })])
  check(
    'RI3 拿不到名字的失败也要计数（宁可说不出是谁，不能当没发生）',
    riNoId.toolErrors === 1 && typeof riNoId.worstTool === 'string' && riNoId.worstTool.length > 0,
    String(riNoId.worstTool),
  )

  const clean = Meow.incidentOf({ toolErrors: 0 }, 'stop')
  const soft = Meow.incidentOf({ toolErrors: 1, worstFail: 1, worstTool: 'pwsh' }, 'stop')
  const retry = Meow.incidentOf({ toolErrors: 2, worstFail: 2, worstTool: 'pwsh' }, 'stop')
  const mem = Meow.incidentOf({ toolErrors: 1, worstFail: 1, worstTool: 'memory_link', memoryErrors: 1 }, 'stop')
  const burst = Meow.incidentOf({ toolErrors: 3, worstFail: 1, worstTool: 'pwsh' }, 'stop')
  const turnErr = Meow.incidentOf({ toolErrors: 0 }, 'error')
  const cue = Meow.incidentOf({ toolErrors: 0, cue: 1 }, 'stop')
  const all = [clean, soft, retry, mem, burst, turnErr, cue]
  check(
    'RI4 分级：无事 0 / 零星一次 1 / 连挂·记忆工具挂·整轮出错·主人发火 都是 2',
    all.map((x) => x.level).join(',') === '0,1,2,2,2,2,2',
    all.map((x) => `${x.level}:${x.kinds.join('+') || '-'}`).join(' | '),
  )
  check(
    'RI5 分级：事故种类点得出来（记忆工具挂了自己认账）',
    mem.kinds.includes('memory-error') &&
      retry.kinds.includes('retry-storm') &&
      burst.kinds.includes('error-burst') &&
      cue.kinds.includes('user-cue') &&
      turnErr.kinds.includes('turn-error'),
    `${mem.kinds} / ${retry.kinds} / ${burst.kinds}`,
  )
  check(
    'RI6 阈值：硬档当场 1 步、软档 3 步、没事照旧 cadence',
    Meow.reflectNeed(retry, 7) === 1 && Meow.reflectNeed(soft, 7) === 3 && Meow.reflectNeed(clean, 7) === 7,
    `${Meow.reflectNeed(retry, 7)}/${Meow.reflectNeed(soft, 7)}/${Meow.reflectNeed(clean, 7)}`,
  )
  check(
    'RI7 阈值：软档不许反过来比 cadence 慢（cadence=2 还是 2）',
    Meow.reflectNeed(soft, 2) === 2 && Meow.reflectNeed(soft, 1) === 1 && Meow.reflectNeed(clean, 0) === 7,
  )
  const lines = Meow.incidentLines({ level: 2, kinds: ['retry-storm'], toolErrors: 2, worstFail: 2, worstTool: 'pwsh', failedTools: [['pwsh', 2]] })
  const joined = lines.join('\n')
  check(
    'RI8 报文：说清「是插件自己叫的」+ 挂几次 + 先判真假事故',
    joined.includes('插件自己') && joined.includes('pwsh ×2') && joined.includes('工具失败 2 次'),
    joined.slice(0, 160).replace(/\n/g, ' / '),
  )
  check('RI9 报文：没事故时一个字都不加', Meow.incidentLines(clean).length === 0)
  const langs = ['zh', 'en', 'pt-br']
  const keys = ['incidentHead', 'incidentTools', 'incidentDetail', 'incidentTurnError', 'incidentCue', 'incidentAsk', 'unknownTool']
  const missing = langs.filter((lg) => {
    const t = readFileSync(join(root, 'vendor', 'meow-memory', 'lib', 'prompts', lg, 'labels.md'), 'utf8')
    return !keys.every((k) => t.includes(`- reflect.${k}:`))
  })
  check('RI10 三语：事故文案七个键在 zh/en/pt-br 都在（换语言不炸成 undefined）', missing.length === 0, missing.join(',') || 'zh/en/pt-br 全在')
}

// RJ0-RJ16（0.2.135）：一次事故可能是抖动，第二次就不是了；反思了却没写进任何东西更要命。
{
  const rjWs = mkdtempSync(join(tmpdir(), 'meow-incident-'))
  const rjDir = '.dsh-meow'
  const rjInc = { level: 2, kinds: ['retry-storm'], worstTool: 'pwsh', toolErrors: 2, memoryErrors: 0, failedTools: [['pwsh', 2]] }
  const rjEmpty = Meow.readIncidentLedger(rjWs, rjDir)
  check('RJ0 账本：还没有文件时给空账并说明是没账本', rjEmpty.rows.length === 0 && rjEmpty.missing === 'no-ledger')
  check(
    'RJ1 账本：软档（只挂一次）不记账——抖动不值得留痕',
    Meow.recordIncident(rjWs, rjDir, { ...rjInc, level: 1, kinds: ['tool-error'] }) === false,
  )
  check('RJ2 账本：硬档写一行', Meow.recordIncident(rjWs, rjDir, rjInc, 'sess-abcdefghijkl') === true)
  const rjRows = Meow.readIncidentLedger(rjWs, rjDir).rows
  check(
    'RJ3 账本：行里带工具名与事故种类（下一轮认得出是同一件事）',
    rjRows.length === 1 && rjRows[0].tool === 'pwsh' && rjRows[0].kinds.includes('retry-storm'),
    JSON.stringify(rjRows[0] ?? null),
  )
  const rjRep = Meow.incidentRepeatOf(rjWs, rjDir, rjInc)
  check('RJ4 重复检测：同工具再来一次就数得到（24 小时窗）', rjRep?.count === 1 && rjRep?.windowHours === 24, JSON.stringify(rjRep))
  check('RJ5 重复检测：换了工具不算同一件事', Meow.incidentRepeatOf(rjWs, rjDir, { ...rjInc, worstTool: 'write_file' }) === undefined)
  const rjLines = Meow.incidentLines(rjInc, rjRep).join('\n')
  check('RJ6 报文：点名「这不是第一次」并写出工具与次数', rjLines.includes('pwsh') && rjLines.includes('不是第一次'), rjLines.replace(/\n/g, ' / ').slice(0, 120))
  check('RJ7 报文：重复提醒排在「先判断」之前（先给事实再给做法）', rjLines.indexOf('不是第一次') < rjLines.indexOf('先判断'))
  for (let rjI = 0; rjI < 210; rjI++) Meow.recordIncident(rjWs, rjDir, rjInc)
  check('RJ8 账本：只留最近 200 行，不会无限堆成拖累', Meow.readIncidentLedger(rjWs, rjDir).rows.length === 200)
  const rjFile = join(rjWs, rjDir, 'incident-ledger.jsonl')
  writeFileSync(rjFile, `not json\n{"t":"x"}\n{"t":0}\n${readFileSync(rjFile, 'utf8')}`)
  check('RJ9 账本：坏行只丢那一行，不当成事故', Meow.readIncidentLedger(rjWs, rjDir).rows.length === 200)
  check('RJ10 窗口：25 小时前的账不再点名', Meow.incidentRepeatOf(rjWs, rjDir, rjInc, Date.now() + 25 * 60 * 60 * 1e3) === undefined)
  Meow.writeReflectPending(rjWs, rjDir, rjInc)
  check('RJ11 闭环：反思发了、这一轮却没写记忆 -> 判定没落地', Meow.settleReflect(rjWs, rjDir, 0)?.ok === false)
  check('RJ12 闭环：没落地进账本（kinds=no-followup）', Meow.readIncidentLedger(rjWs, rjDir).rows.some((r) => r.kinds.includes('no-followup')))
  const rjRep2 = Meow.incidentRepeatOf(rjWs, rjDir, rjInc)
  check(
    'RJ13 闭环：下次再出事故，账本能说出「上次反思等于白做」',
    rjRep2?.unfixed === 1 && Meow.incidentLines(rjInc, rjRep2).join('\n').includes('反思过'),
    JSON.stringify(rjRep2),
  )
  Meow.writeReflectPending(rjWs, rjDir, rjInc)
  check(
    'RJ14 闭环：反思后真写了记忆 -> 不留痕、清掉待验卡',
    Meow.settleReflect(rjWs, rjDir, 1)?.ok === true && Meow.readReflectPending(rjWs, rjDir) === undefined,
  )
  const rjKeys = ['incidentRepeat', 'incidentNoFollowup']
  const rjMissing = ['zh', 'en', 'pt-br'].filter((lg) => {
    const t = readFileSync(join(root, 'vendor', 'meow-memory', 'lib', 'prompts', lg, 'labels.md'), 'utf8')
    return !rjKeys.every((k) => t.includes(`- reflect.${k}:`))
  })
  check('RJ15 三语：重复提醒与「反思白做」两句话 zh/en/pt-br 都在', rjMissing.length === 0, rjMissing.join(',') || 'zh/en/pt-br 全在')
  const rjSoft = Meow.scanTurn([{ type: 'assistant/message', data: { message: { content: [{ type: 'tool-call', id: 'm1', name: 'memory_remember' }] } } }])
  check('RJ16 计数：写记忆的那一步被单独数出来（闭环判据靠它）', rjSoft.memoryWrites === 1 && rjSoft.sawNonMemory === false, `writes=${rjSoft.memoryWrites}`)
  try {
    rmSync(rjWs, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
}

// RK0-RK9（0.2.136）：库里躺着四条「当前版本是 X」——重复度不够合并、层也不同，检索时没人知道哪条算数。
// 这类不是措辞重复，是结论互斥：靠版本号 / 日期这两个硬事实认出来，写进去照旧，但回执点名「它写 A 你写 B」。
{
  const rkWs = mkdtempSync(join(tmpdir(), 'meow-conflict-'))
  Meow.trustWorkspace(rkWs)
  const rkExec = { agent: { session: { header: { cwd: rkWs, id: 'sess-conflict' } } } }
  const rkRun = (name, args) => tools.get(name).execute(args, rkExec)
  const rkText = (v) => (typeof v === 'string' ? v : JSON.stringify(v))
  const rkKw = ['冲突探针', '版本', '交付态', '断言数', '记忆写入', '冲突雷达', '硬事实', '版本号', '日期', '探针']
  const rkOld = await rkRun('memory_remember', {
    content: '冲突探针甲：0.2.132 交付态，check-all 21/21、合计 2,530 条断言。',
    project: '探针冲突',
    keywords: rkKw,
    importance: 2,
    level: 'fact',
  })
  check('RK0 写入：旧版本那条先落库，此时没人可冲突', rkText(rkOld).includes('记忆已写入') && !rkText(rkOld).includes('另一种说法'), rkText(rkOld).split('\n')[0])
  const rkNew = await rkRun('memory_remember', {
    content: '冲突探针甲：0.2.135 交付态，check-all 21/21、合计 2,606 条断言。',
    project: '探针冲突',
    keywords: rkKw,
    importance: 2,
    level: 'fact',
  })
  const rkNewText = rkText(rkNew)
  check('RK1 冲突：同一件事写了新版本，回执点名「另一种说法」', rkNewText.includes('另一种说法'), rkNewText.split('\n')[0])
  check(
    'RK2 冲突：把两边的版本号并排报出来（它写 0.2.132，你写 0.2.135）',
    rkNewText.includes('0.2.132') && rkNewText.includes('0.2.135') && rkNewText.includes('版本'),
    rkNewText.slice(0, 200).replace(/\n/g, ' / '),
  )
  check('RK3 冲突：告诉人怎么收场（supersedes / stale），不是只提醒不给出路', rkNewText.includes('supersedes') && rkNewText.includes('stale'))
  check('RK4 冲突：提醒不改写入行为（新条目照样落库）', rkNewText.includes('记忆已写入'))
  const rkOther = rkRun('memory_remember', {
    content: '冲突探针乙：另一个项目里写的 0.2.140 交付态，check-all 21/21、合计 2,700 条断言。',
    project: '探针别的项目',
    keywords: [...rkKw, '别的项目'],
    importance: 1,
    level: 'fact',
  })
  check('RK5 冲突：项目不同就不算同一件事（跨项目不打扰）', !rkText(await rkOther).includes('另一种说法'))
  const rkDate = await rkRun('memory_remember', {
    content: '冲突探针丙：复盘会定在 2026-11-02，结论是账本要看 24 小时窗。',
    project: '探针冲突',
    keywords: [...rkKw, '复盘', '日期'],
    importance: 1,
    level: 'fact',
  })
  const rkDate2 = await rkRun('memory_remember', {
    content: '冲突探针丙：复盘会改到 2026-11-09，结论是账本要看 24 小时窗。',
    project: '探针冲突',
    keywords: [...rkKw, '复盘', '日期'],
    importance: 1,
    level: 'fact',
  })
  const rkDateText = rkText(rkDate2)
  check(
    'RK6 冲突：日期也是硬事实（会议从 11-02 改到 11-09 要被认出来）',
    rkDateText.includes('日期') && rkDateText.includes('2026-11-02') && rkDateText.includes('2026-11-09'),
    rkDateText.slice(0, 200).replace(/\n/g, ' / '),
  )
  const rkNoTok = await rkRun('memory_remember', {
    content: '冲突探针丁：反思这条线要按事故分级、跨轮记账、事后验收，三段都要。',
    project: '探针冲突',
    keywords: [...rkKw, '反思线'],
    importance: 1,
    level: 'fact',
  })
  const rkNoTok2 = await rkRun('memory_remember', {
    content: '冲突探针丁：反思这条线要按事故分级、跨轮记账、事后验收，三段都要——这次补上「抖动别留痕」。',
    project: '探针冲突',
    keywords: [...rkKw, '反思线'],
    importance: 1,
    level: 'fact',
  })
  check(
    'RK7 抗噪：没有版本号 / 日期的近似说法不报冲突（闲聊不该被拦）',
    !rkText(rkNoTok2).includes('另一种说法') && rkText(rkNoTok).length > 0,
    rkText(rkNoTok2).split('\n')[0],
  )
  const rkRows = [
    { id: 'aaaaaaaa1111', level: 'fact', project: 'p', content: '0.2.132 交付态 check-all 21/21 合计 2,530 条断言' },
    { id: 'bbbbbbbb2222', level: 'fact', project: 'p', content: '0.2.129 交付态 check-all 19/19 合计 2,400 条断言' },
    { id: 'cccccccc3333', level: 'fact', project: 'p', content: '0.2.141 交付态 check-all 22/22 合计 2,700 条断言' },
    { id: 'dddddddd4444', level: 'fact', project: 'p', content: '0.2.150 交付态 check-all 23/23 合计 2,800 条断言' },
    { id: 'eeeeeeee5555', level: 'fact', project: 'p', content: '今天海面很平静，风从东边来' },
  ]
  const rkCand = Meow.conflictCandidates(rkRows, '0.2.135 交付态 check-all 21/21 合计 2,606 条断言', 'p')
  check('RK8 上限：最多点名 3 条（不能让回执变成一堵墙）', rkCand.length === 3, String(rkCand.length))
  check('RK9 排序：相似度高的排前面', rkCand.every((c, i) => i === 0 || rkCand[i - 1].sim >= c.sim), rkCand.map((c) => c.sim).join(','))
  const rkTok = Meow.factTokens('0.2.120 到 0.2.135，日期 2026-11-21 与 2026-11-02')
  check(
    'RK10 抽取：多个版本号与日期都认得（不只看第一个）',
    rkTok.versions.size === 2 && rkTok.dates.size === 2,
    `${[...rkTok.versions].join('/')} | ${[...rkTok.dates].join('/')}`,
  )
  const rkSrc = readFileSync(join(root, 'vendor', 'meow-memory', 'lib', 'index.js'), 'utf8')
  check(
    'RK11 源码：判据写成常量（相似度门槛、点名上限），不是散在逻辑里的魔法数',
    rkSrc.includes('var CONFLICT_SIM = 0.3;') && rkSrc.includes('var CONFLICT_MAX = 3;'),
  )
  try {
    rmSync(rkWs, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
}

// RL0-RL7（0.2.137）：冲突雷达原来只装在写新条目那条路上——可「把旧条目改成新版本号」
// 才是最常走、也最容易留下两个版本并排睡的那条路。这一组走 memory_update 验。
{
  const rlWs = mkdtempSync(join(tmpdir(), 'meow-conflict-upd-'))
  Meow.trustWorkspace(rlWs)
  const rlExec = { agent: { session: { header: { cwd: rlWs, id: 'sess-conflict-upd' } } } }
  const rlRun = (name, args) => tools.get(name).execute(args, rlExec)
  const rlText = (v) => (typeof v === 'string' ? v : JSON.stringify(v))
  const rlKw = ['改动冲突探针', '版本号', '交付态', '断言数', '冲突雷达', '覆盖', '改内容', '收场路', '日期', '探针']
  const rlB = await rlRun('memory_remember', {
    content: '改动冲突探针：0.2.132 交付态，check-all 21/21、合计 2,530 条断言。',
    project: '探针改冲突',
    keywords: rlKw,
    importance: 2,
    level: 'fact',
  })
  const rlA = await rlRun('memory_remember', {
    content: '改动冲突探针：0.2.135 交付态，check-all 21/21、合计 2,606 条断言。',
    project: '探针改冲突',
    keywords: rlKw,
    importance: 2,
    level: 'fact',
  })
  // macro 那层把回执换成文本了，id 得从库里认回来（按内容里的版本号找）
  const rlDb = Meow.getDb(rlWs, '.dsh-meow')
  const rlRows = rlDb.list('fact', { status: 'active' })
  const rlIdOf = (needle) => String(rlRows.find((r) => String(r.content ?? '').includes(needle))?.id ?? '')
  const rlAId = rlIdOf('0.2.135')
  const rlBId = rlIdOf('0.2.132')
  check('RL0 准备：同项目里先有两条不同版本的说法', rlAId.length > 0 && rlBId.length > 0, `${rlAId.slice(0, 8)} / ${rlBId.slice(0, 8)}`)
  const rlUpd = await rlRun('memory_update', {
    id: rlAId,
    content: '改动冲突探针：0.2.137 交付态，check-all 21/21、合计 2,700 条断言。',
  })
  const rlUpdText = rlText(rlUpd)
  check('RL1 改动侧：改完回执自己说「库里还有另一种说法」', rlUpdText.includes('改完之后') && rlUpdText.includes('另一种说法'), rlUpdText.slice(0, 60).replace(/\n/g, ' / '))
  check('RL2 改动侧：两个版本号并排摆出来（它写 0.2.132，你这次写 0.2.137）', rlUpdText.includes('0.2.132') && rlUpdText.includes('0.2.137'))
  check('RL3 改动侧：给了收场路（supersedes / stale），不是只提醒', rlUpdText.includes('supersedes') && rlUpdText.includes('stale'))
  check('RL4 改动侧：提醒不改写入（已更新照旧），改完的内容真进去了', rlUpdText.includes('已更新') && rlUpdText.includes('0.2.137'))
  const rlRead = await rlRun('memory_read', { id: rlAId, neighbors: 0 })
  check('RL5 改动侧：库里读回来是新内容（提醒不是「没改成」的借口）', rlText(rlRead).includes('0.2.137'), rlText(rlRead).slice(0, 40).replace(/\n/g, ' '))
  const rlStatusOnly = await rlRun('memory_update', { id: rlBId, status: 'stale' })
  check('RL6 改动侧：只改状态（不带 content）不查冲突——别为无关改动报警', !rlText(rlStatusOnly).includes('另一种说法'), rlText(rlStatusOnly).slice(0, 40).replace(/\n/g, ' '))
  const rlC = await rlRun('memory_remember', {
    content: '改动冲突探针乙：0.2.132 交付态，另一个项目里的独苗。',
    project: '探针改冲突空',
    keywords: [...rlKw, '独苗'],
    importance: 1,
    level: 'fact',
  })
  const rlCId = String(rlDb.list('fact', { status: 'active' }).find((r) => String(r.content ?? '').includes('0.2.132') && String(r.project ?? '') === '探针改冲突空')?.id ?? '')
  const rlCUpd = await rlRun('memory_update', {
    id: rlCId,
    content: '改动冲突探针乙：0.2.200 交付态，另一个项目里的独苗。',
  })
  check('RL7 改动侧：项目里没有同类就不打扰（跨项目不误报）', !rlText(rlCUpd).includes('另一种说法'), rlText(rlCUpd).slice(0, 40).replace(/\n/g, ' '))
  try {
    rmSync(rlWs, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
}

// RL8-RL11（0.2.137）：这套文案不能只写死在代码里——三语各有模板，用户改 prompts 时缺键也不能炸。
{
  const rlKeys = ['conflict.item', 'conflict.head', 'conflict.headUpdate', 'conflict.kindVersion', 'conflict.kindDate', 'conflict.join']
  const rlMissing = ['zh', 'en', 'pt-br'].filter((lg) => {
    const t = readFileSync(join(root, 'vendor', 'meow-memory', 'lib', 'prompts', lg, 'labels.md'), 'utf8')
    return !rlKeys.every((k) => t.includes(`- ${k}:`))
  })
  check('RL8 三语：冲突文案六个键 zh/en/pt-br 都在', rlMissing.length === 0, rlMissing.join(',') || 'zh/en/pt-br 全在')
  const rlEn = readFileSync(join(root, 'vendor', 'meow-memory', 'lib', 'prompts', 'en', 'labels.md'), 'utf8')
  check('RL9 三语：英文模板是英文说法，不是把中文搬过去', rlEn.includes('it says {theirs}') && rlEn.includes('version'))
  const rlOne = Meow.conflictWarn([{ id: 'abcdef123456', level: 'fact', sim: 0.5, kind: '版本', mine: ['0.2.137'], theirs: ['0.2.136'] }])
  const rlTwo = Meow.conflictWarn([{ id: 'abcdef123456', level: 'fact', sim: 0.5, kind: '版本', mine: ['0.2.137'], theirs: ['0.2.136'] }], undefined, 'update')
  check('RL10 两种说法不混：写入说「这条照样写下了」，改动说「这条改动照样落库了」', rlOne.includes('写下来了') && rlTwo.includes('落库') && !rlTwo.includes('写下了'))
  check('RL11 空表：没有冲突就没有这句提醒（返回空串，不占回执）', Meow.conflictWarn([]) === '' && Meow.conflictWarn(undefined) === '')
}

// RL12（0.2.137）：源码锚点——两张路都要走同一个函数，别各写一份文案。
{
  const rlSrc = readFileSync(join(root, 'vendor', 'meow-memory', 'lib', 'index.js'), 'utf8')
  check(
    'RL12 源码：改动侧调用同一个 conflictWarn，只是多带一个 update 模式',
    rlSrc.includes('conflictWarn(conflictCandidates(siblings, patch.content, projNow), db, "update")') && rlSrc.includes('db.list(found.level, { status: "active" })'),
  )
}

// RM0-RM9（0.2.138）：取代句从 0.2.117 起就写在旧条目正文里，可没有任何人在读它——
// 改一条退位的记忆时回执照样说「已更新」，读一条退位的记忆时也看不出该去读哪条。
// 这一组走真工具验「链在回执里说得出来」。
{
  const rmWs = mkdtempSync(join(tmpdir(), 'meow-succession-'))
  Meow.trustWorkspace(rmWs)
  const rmExec = { agent: { session: { header: { cwd: rmWs, id: 'sess-succession' } } } }
  const rmRun = (name, args) => tools.get(name).execute(args, rmExec)
  const rmText = (v) => (typeof v === 'string' ? v : JSON.stringify(v))
  const rmKw = ['取代链探针', '交付态', '接手', '退位', '账本', '回执', '可追溯', '探针', '版本号', '链路']
  await rmRun('memory_remember', {
    content: '取代链探针：0.2.136 交付态，冲突雷达只装在写入侧。',
    project: '探针取代链',
    keywords: rmKw,
    importance: 2,
    level: 'fact',
  })
  const rmDb = Meow.getDb(rmWs, '.dsh-meow')
  const rmOldId = String(rmDb.list('fact', { status: 'active' }).find((r) => String(r.content ?? '').includes('0.2.136 交付态'))?.id ?? '')
  check('RM0 准备：旧条目已写下', rmOldId.length > 0, rmOldId.slice(0, 8))
  const rmNew = await rmRun('memory_remember', {
    content: '取代链探针：0.2.138 交付态，取代句要有人读——回执点名链上位置。',
    project: '探针取代链',
    keywords: rmKw,
    importance: 2,
    level: 'fact',
    supersedes: [rmOldId],
  })
  const rmNewId = String(rmDb.list('fact', { status: 'active' }).find((r) => String(r.content ?? '').includes('0.2.138 交付态'))?.id ?? '')
  const rmNewShort = rmNewId.slice(0, 8)
  const rmOldShort = rmOldId.slice(0, 8)
  check('RM1 准备：新条目接手了旧条目（supersedes 生效）', rmNewId.length > 0 && rmText(rmNew).includes('取代') === true)

  const rmReadOld = rmText(await rmRun('memory_read', { id: rmOldId, neighbors: 0 }))
  check('RM2 读旧条：说出「这条已被人接手」并点名接手的那条', rmReadOld.includes('⛓ 这条已被人接手') && rmReadOld.includes(rmNewShort), rmReadOld.split('\n').find((l) => l.includes('⛓')) ?? '（没有 ⛓ 行）')
  const rmReadNew = rmText(await rmRun('memory_read', { id: rmNewId, neighbors: 0 }))
  check('RM3 读新条：说出「这条接手过」并点名被它顶掉的旧条', rmReadNew.includes('⛓ 这条接手过 1 条') && rmReadNew.includes(rmOldShort), rmReadNew.split('\n').find((l) => l.includes('⛓')) ?? '（没有 ⛓ 行）')
  check('RM4 读新条：旧条的状态一起说清楚（stale，只作史证）', rmReadNew.includes('stale') && rmReadNew.includes('史证'))

  const rmUpdOld = rmText(await rmRun('memory_update', { id: rmOldId, content: '取代链探针：0.2.136 交付态，改了一条早就退位的话。' }))
  check('RM5 改旧条：回执既说「已更新」也当场说「这是退位的那条」（两条都是真的）', rmUpdOld.includes('已更新') && rmUpdOld.includes('⛓ 这条已被人接手'))
  check('RM6 改旧条：告诉人正确做法是改接手的那条', rmUpdOld.includes('就去改那条') || rmUpdOld.includes('supersedes'))

  await rmRun('memory_remember', {
    content: '取代链探针丙：一条没有谱系的独苗，回执里不该多出链。',
    project: '探针取代链空',
    keywords: [...rmKw, '独苗'],
    importance: 1,
    level: 'fact',
  })
  const rmLonelyId = String(rmDb.list('fact', { status: 'active' }).find((r) => String(r.content ?? '').includes('独苗'))?.id ?? '')
  const rmLonely = rmText(await rmRun('memory_read', { id: rmLonelyId, neighbors: 0 }))
  check('RM7 无链不提：没有谱系的条目不许多一行（省 token）', rmLonely.length > 0 && !rmLonely.includes('⛓'))

  const chainMod = await import(pathToFileURL(join(root, 'lib/macro/chain.js')).href)
  check('RM8 解析：取代句拆成 id / 开头 / 日期三段', (() => {
    const got = chainMod.supersededBy('正文在这里（已被取代：abc12345「旧开头」, 2026-11-21）尾巴')
    return got !== null && got.id8 === 'abc12345' && got.head === '旧开头' && got.day.length > 0
  })())
  check('RM9 闭嘴：没工作区 / 没库时不编链', chainMod.successionNote({ workspace: '', id: rmOldId }) === '' && chainMod.successionNote({ workspace: join(tmpdir(), 'no-such-ws-138'), id: rmOldId }) === '')
  // RM10-RM13（0.2.139）：链是 8 位前缀近似出来的，近似就得说清楚。
  // ① 接手它的那条可能已经不在库里（删了/搬走了）——只念 id 会让人以为还能改到它；
  // ② 同秒写入的条目前缀会撞——念一个 id 会让人以为那是唯一一条。
  // 重新造一对：RM4 改过旧条正文，那句「已被取代」已经跟着正文一起换掉了（这正是 0.2.138 要「改之前读」的原因）。
  await rmRun('memory_remember', {
    content: '链诚实探针甲：0.2.139 之前，链只念前缀不管在不在。',
    project: '探针取代链',
    keywords: rmKw,
    importance: 2,
    level: 'fact',
  })
  const rmZ1Id = String(rmDb.list('fact', { status: 'active' }).find((r) => String(r.content ?? '').includes('链诚实探针甲'))?.id ?? '')
  await rmRun('memory_remember', {
    content: '链诚实探针乙：0.2.139 交付态，链要说出接手者还在不在、前缀撞不撞。',
    project: '探针取代链',
    keywords: rmKw,
    importance: 2,
    level: 'fact',
    supersedes: [rmZ1Id],
  })
  const rmChain = chainMod.successionOf({ workspace: rmWs, id: rmZ1Id })
  // 注意：meow 的 id 前半段就是写入时刻，同一秒写的条目**必然**撞前缀——所以这一条验的正是「撞了也能认出是谁」。
  check(
    'RM10 精确：前缀撞了也能只认一条（用取代句里的开头消歧）',
    rmChain.mine?.state === 'exact' && rmChain.mine?.hits >= 1,
    JSON.stringify(rmChain.mine),
  )
  const rmGhost = await rmRun('memory_remember', {
    content: '链诚实探针：这条写着（已被取代：0mzzzzz9「早就不在库里的接手者」，2026-11-21）。',
    project: '探针取代链',
    keywords: rmKw,
    importance: 2,
    level: 'fact',
  })
  const rmGhostId = String(rmDb.list('fact', { status: 'active' }).find((r) => String(r.content ?? '').includes('0mzzzzz9'))?.id ?? '')
  const rmGhostRead = rmText(await rmRun('memory_read', { id: rmGhostId }))
  check(
    'RM11 缺席：接手者不在库里就直说，不许假装能改到它',
    rmGhostId.length > 0 && rmGhostRead.includes('不在库里') && !rmGhostRead.includes('检索时说话的是接手它的那条'),
    rmGhostRead.slice(0, 80),
  )
  check(
    'RM12 撞车：前缀命中几条就说几条（纯函数三态）',
    chainMod.prefixState(['0mwabcde-1', '0mwabcde-2', '0mwxyz'], '0mwabcde') === 2 &&
      chainMod.prefixState(['0mwabcde-1'], '0mwabcde') === 1 &&
      chainMod.prefixState(['0mwabcde-1'], '0mzzzzz9') === 0,
  )
  const rmZ2Id = String(rmDb.list('fact', { status: 'active' }).find((r) => String(r.content ?? '').includes('链诚实探针乙'))?.id ?? '')
  const rmZ2Read = rmText(await rmRun('memory_read', { id: rmZ2Id }))
  // 读回执里的 blur 是 successionNote 按**它自己那条**算的 selfHits，不是 rmZ1 的——两个对象别混着比。
  const rmZ2Chain = chainMod.successionOf({ workspace: rmWs, id: rmZ2Id })
  check(
    'RM13 自撞：自己前缀撞车时，认出来的那几条要说明「是按开头核对过的」',
    /接手过 \d+ 条/.test(rmZ2Read) && ((rmZ2Chain.selfHits ?? 0) <= 1 || rmZ2Read.includes('按开头核对过')),
    `selfHits(Z2)=${rmZ2Chain.selfHits}｜${rmZ2Read.replace(/\s+/g, ' ').slice(0, 200)}`,
  )
  try {
    rmSync(rmWs, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
}

// RP0-RP5（0.2.140）：状态以前只在过滤里起作用，不进打分——默认 status=null 时 stale 与 archived
// 全都参与检索，一条被你标成 stale 的旧结论只要措辞更贴就排在接手者前面，回执上只差一个「（stale）」。
// 这一组验「降权真的发生、真的按序、真的说出口」，并且验历史仍可召回（只降权不隐藏）。
{
  const rpWs = mkdtempSync(join(tmpdir(), 'meow-statusw-'))
  Meow.trustWorkspace(rpWs)
  const rpExec = { agent: { session: { header: { cwd: rpWs, id: 'sess-statusw' } } } }
  const rpRun = (name, args) => tools.get(name).execute(args, rpExec)
  const rpKw = ['状态权重探针', '降权', 'stale', 'archived', '排序', '在用', '结论', '可召回', '回执', '准确率']
  await rpRun('memory_remember', {
    content: '状态权重探针：当前交付态是 0.2.100，旧结论。',
    project: '探针状态权重',
    keywords: rpKw,
    importance: 2,
    level: 'fact',
  })
  const rpDb = Meow.getDb(rpWs, '.dsh-meow')
  const rpOldId = String(rpDb.list('fact', { status: 'active' }).find((r) => String(r.content ?? '').includes('0.2.100，旧结论'))?.id ?? '')
  await rpRun('memory_remember', {
    content: '状态权重探针：当前交付态是 0.2.140，旧结论已被这条接手。',
    project: '探针状态权重',
    keywords: rpKw,
    importance: 2,
    level: 'fact',
    supersedes: [rpOldId],
  })
  check('RP0 纯函数：三档权重写死在一处（active 1 / stale 0.6 / archived 0.35）', Meow.statusWeight('active') === 1 && Meow.statusWeight('stale') === 0.6 && Meow.statusWeight('archived') === 0.35 && Meow.statusWeight(void 0) === 1)
  // 宏层 memory_search 给的是渲染好的文本（TEXT_OUT），不是 {note, hits} 对象——按文本验。
  const rpAllText = String((await rpRun('memory_search', { query: '状态权重探针 当前交付态', status: 'all', k: 5, content_max: 80 })) ?? '')
  check(
    'RP1 降权真的发生：退位那条还在结果里（可追溯），但排在接手者后面',
    rpAllText.includes('0.2.140') &&
      rpAllText.includes('0.2.100，旧结论') &&
      rpAllText.indexOf('0.2.140') < rpAllText.indexOf('0.2.100，旧结论'),
    rpAllText.replace(/\s+/g, ' ').slice(0, 200),
  )
  check(
    'RP2 降权要说出口：回执点名有几条不是在用的，并给出降权倍数',
    rpAllText.includes('不是在用的') && rpAllText.includes('0.6'),
    rpAllText.replace(/\s+/g, ' ').slice(0, 260),
  )
  const rpActiveText = String((await rpRun('memory_search', { query: '状态权重探针 当前交付态', status: 'active', k: 5, content_max: 80 })) ?? '')
  check(
    'RP3 只要在用的：status=active 时退位那条不出现，回执也不再报降权',
    rpActiveText.includes('0.2.140') && !rpActiveText.includes('0.2.100，旧结论') && !rpActiveText.includes('不是在用的'),
    rpActiveText.replace(/\s+/g, ' ').slice(0, 200),
  )
  const rpExplainDocs = [
    { id: 'x', level: 'fact', content: '可解释权重探针：同题两种说法', keywords: [], importance: 3, updated_at: Date.now(), status: 'active' },
    { id: 'y', level: 'fact', content: '可解释权重探针：同题两种说法', keywords: [], importance: 3, updated_at: Date.now(), status: 'stale' },
  ]
  const rpExplain = Meow.search('可解释权重探针 同题两种说法', rpExplainDocs, { k: 5, now: Date.now(), explain: true })
  check(
    'RP4 可解释：explain 里能看见 statusWeight（否则读者不知道它为什么掉下去了）',
    rpExplain.length === 2 && rpExplain[0].explain?.statusWeight === 1 && rpExplain[1].explain?.statusWeight === 0.6,
    rpExplain.map((h) => `${h.id}:${h.explain?.statusWeight}`).join(' '),
  )
  const rpDocs = [
    { id: 'a', level: 'fact', content: '同一条正文，只有状态不同', keywords: [], importance: 3, updated_at: Date.now(), status: 'active' },
    { id: 'b', level: 'fact', content: '同一条正文，只有状态不同', keywords: [], importance: 3, updated_at: Date.now(), status: 'stale' },
    { id: 'c', level: 'fact', content: '同一条正文，只有状态不同', keywords: [], importance: 3, updated_at: Date.now(), status: 'archived' },
  ]
  const rpPure = Meow.search('同一条正文 只有状态不同', rpDocs, { k: 5, now: Date.now() })
  const rpRatio = rpPure.length === 3 ? rpPure[1].score / rpPure[0].score : 0
  check('RP5 权重就是分数比：正文与时间都一样时，stale / archived 的分数正好是 0.6 / 0.35 倍', rpPure.map((h) => h.id).join('') === 'abc' && Math.abs(rpRatio - 0.6) < 1e-6 && Math.abs(rpPure[2].score / rpPure[0].score - 0.35) < 1e-6, rpPure.map((h) => `${h.id}:${Math.round(h.score * 1e3) / 1e3}`).join(' '))
  try {
    rmSync(rpWs, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
}

// RQ0-RQ4（0.2.141）：折叠以前是「谁分高留谁」——一条退位的旧说法只要措辞更贴，就能把接手它的
// 新说法折掉，回执只留一句「多半是同一句既存了 fact 又存了 lesson」。这一组验「挑对留下哪条」
// 与「折了谁要说得出来」。
{
  const rqWs = mkdtempSync(join(tmpdir(), 'meow-fold-'))
  Meow.trustWorkspace(rqWs)
  const rqExec = { agent: { session: { header: { cwd: rqWs, id: 'sess-fold' } } } }
  const rqRun = (name, args) => tools.get(name).execute(args, rqExec)
  const rqDb = Meow.getDb(rqWs, '.dsh-meow')
  const rqText = (v) => (typeof v === 'string' ? v : JSON.stringify(v))
  const rqBody = '折叠探针：同一句被写了两次，只有状态与时间不同，用来验折叠留哪一条。'
  const rqKw = ['折叠探针', '同句两写', '留下哪条', '在用优先', '较新优先', '分高优先', '可追溯', '去重', '回执', '点名']
  const rqStale = rqDb.insert({ level: 'fact', content: rqBody, keywords: rqKw, importance: 2, project: '探针折叠' })
  const rqFresh = rqDb.insert({ level: 'fact', content: rqBody, keywords: rqKw, importance: 2, project: '探针折叠' })
  rqDb.update('fact', rqStale.id, { status: 'stale' })
  rqDb.p('UPDATE fact SET updated_at = ? WHERE id = ?').run(Date.now() - 86400000, rqStale.id)
  const rqStaleShort = String(rqStale.id).slice(0, 8)
  const rqFreshShort = String(rqFresh.id).slice(0, 8)
  const rqRows = rqDb.list('fact', {}).filter((r) => String(r.content ?? '').includes('折叠探针'))
  const rqDocs = rqRows.map((r) => ({ ...r, keywords: r.keywords ?? [] }))
  const rqGroups = Meow.foldNearDupes(rqDocs, new Map(rqDocs.map((r) => [r.id, r])))
  check(
    'RQ0 纯函数：同组里挑「在用优先 → 较新优先」，不挑那条更旧的退位说法',
    rqGroups.kept.length === 1 && String(rqGroups.kept[0].id) === String(rqFresh.id) && rqGroups.folded === 1,
    `kept=${String(rqGroups.kept[0]?.id ?? '').slice(0, 8)} folded=${rqGroups.folded}`,
  )
  check(
    'RQ1 纯函数：被折掉的是谁要记在结果里（含它被谁接手）',
    (rqGroups.dropped ?? []).length === 1 &&
      String(rqGroups.dropped[0].id) === String(rqStale.id) &&
      String(rqGroups.dropped[0].keep) === String(rqFresh.id),
    JSON.stringify(rqGroups.dropped ?? []).slice(0, 160),
  )
  const rqSearch = rqText(await rqRun('memory_search', { query: '折叠探针 同一句 被写了两次', status: 'all', k: 5, content_max: 60 }))
  check(
    'RQ2 回执：留下的与被折的都点名（追溯得到，不用翻 dedupe:false 才看得见）',
    rqSearch.includes(rqFreshShort) && rqSearch.includes(rqStaleShort) && rqSearch.includes('留下的是') && rqSearch.includes('被折掉的是'),
    rqSearch.replace(/\s+/g, ' ').slice(0, 260),
  )
  const rqAll = rqText(await rqRun('memory_search', { query: '折叠探针 同一句 被写了两次', status: 'all', k: 5, content_max: 60, dedupe: false }))
  check(
    'RQ3 退路还在：dedupe:false 时两条都列出来（折叠只是默认行为，不是删除）',
    rqAll.includes(rqFreshShort) && rqAll.includes(rqStaleShort) && !rqAll.includes('被折掉的是'),
    rqAll.replace(/\s+/g, ' ').slice(0, 200),
  )
  const rqPick = Meow.pickKeeper(
    [
      { id: 'old', score: 99, content: 'x', status: 'active', updated_at: 1 },
      { id: 'new', score: 1, content: 'x', status: 'active', updated_at: 2 }
    ],
    null,
  )
  check('RQ4 分高但更旧：分不压时间（措辞贴不贴，不代表还用不用）', rqPick.id === 'new')
  try {
    rmSync(rqWs, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
}

// RS0-RS8（0.2.142）：一条正文写着「（已被取代：xxxx）」，可那个 xxxx 现在不在库、
// 或前 8 位撞了一堆认不出是谁——上面三块（逐字重复 / 重复详写 / 疑似冲突）比的是正文像不像，
// 这种断法一对都抓不到。这一组验三态判定、干净清单零成本、文案落地与三语。
{
  const rsLang = (k, p) => Meow.fillTemplate(Meow.keyedValue('labels', k), p) ?? `MISSING:${k}`
  const rsRow = (content, extra = {}) => ({ id: 'aaa11111-1', level: 'fact', content, updated_at: 5, ...extra })
  const rsClaim = '落地口径（已被取代：bbb22222「新说法正文」，2026-11-21）'
  const rsEmptyDb = { list: () => [] }
  const rsAbsent = Meow.dreamChainIssues([rsRow(rsClaim)], rsEmptyDb)
  check(
    'RS0 absent：前缀在库里 0 条就说「那条不在了」，取代句里的前缀/开头/日期都拆出来了',
    rsAbsent.total === 1 &&
      rsAbsent.list[0].state === 'absent' &&
      rsAbsent.list[0].hits === 0 &&
      rsAbsent.list[0].who === 'bbb22222' &&
      rsAbsent.list[0].day === '2026-11-21' &&
      rsAbsent.list[0].head === '新说法正文',
    JSON.stringify(rsAbsent.list[0] ?? {}).slice(0, 220),
  )
  const rsAmbDb = {
    list: (lv) => (lv === 'fact' ? [{ id: 'bbb22222-9', content: '完全不同的甲' }, { id: 'bbb22222-8', content: '完全不同的乙' }] : []),
  }
  const rsAmb = Meow.dreamChainIssues([rsRow(rsClaim)], rsAmbDb)
  check(
    'RS1 ambiguous：前缀撞了 2 条且开头对不上，是「认不出是谁」，不是「那条不在了」',
    rsAmb.total === 1 && rsAmb.list[0].state === 'ambiguous' && rsAmb.list[0].hits === 2,
    `state=${rsAmb.list[0]?.state} hits=${rsAmb.list[0]?.hits}`,
  )
  const rsExactDb = {
    list: (lv) => (lv === 'fact' ? [{ id: 'bbb22222-9', content: '新说法正文' }, { id: 'bbb22222-8', content: '完全不同的乙' }] : []),
  }
  const rsExact = Meow.dreamChainIssues([rsRow(rsClaim)], rsExactDb)
  check('RS2 链是好的一个字不报：撞车但开头能对上（exact）不进清单', rsExact.total === 0 && rsExact.list.length === 0, JSON.stringify(rsExact))
  let rsScans = 0
  const rsSpy = {
    list: () => {
      rsScans++
      return []
    },
  }
  const rsClean = Meow.dreamChainIssues([rsRow('没有链的普通正文')], rsSpy)
  check('RS3 干净清单零成本：没有取代句就一次库都不扫（不给每轮 dream 加固定开销）', rsClean.total === 0 && rsScans === 0, `scans=${rsScans}`)
  const rsText = Meow.dreamChainBlock({ list: rsAbsent.list, total: 3 }, null, rsLang)
  check(
    'RS4 文案：断链块说清「不在库里」，并交代还有几条没列',
    rsText.includes('链断了 3 条') && rsText.includes('不在库里') && rsText.includes('还有 2 条'),
    rsText.replace(/\s+/g, ' ').slice(0, 220),
  )
  const rsAmbText = Meow.dreamChainBlock({ list: rsAmb.list, total: 1 }, null, rsLang)
  check(
    'RS5 ambiguous 文案指向「按开头核对」：撞车是常态，别照着前缀改错人',
    rsAmbText.includes('撞') && rsAmbText.includes('按开头') && rsAmbText.includes('2 条'),
    rsAmbText.replace(/\s+/g, ' ').slice(0, 220),
  )
  const rsNone = Meow.dreamChainBlock({ list: [], total: 0 }, null, rsLang)
  check('RS6 没有断链时块是空串（干净清单不加噪音）', rsNone === '', JSON.stringify(rsNone))
  const rsWs = mkdtempSync(join(tmpdir(), 'meow-chain-'))
  Meow.trustWorkspace(rsWs)
  const rsDb = Meow.getDb(rsWs, '.dsh-meow')
  rsDb.insert({ level: 'fact', content: '真库探针（已被取代：0mzzzzz9「谁也不知道」，2026-11-21）', keywords: ['链探针'], importance: 2, project: '探针链' })
  const rsRealRows = rsDb.list('fact', {}).filter((r) => String(r.content ?? '').includes('真库探针'))
  const rsReal = Meow.dreamChainIssues(rsRealRows, rsDb)
  check(
    'RS7 真库一遍：从库里读出来的条目一样判得出 absent（判据不依赖探针手搓的行）',
    rsReal.total === 1 && rsReal.list[0].state === 'absent' && String(rsReal.list[0].id).length > 8,
    JSON.stringify(rsReal.list[0] ?? {}).slice(0, 200),
  )
  try {
    rmSync(rsWs, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
  const rsKeys = ['dream.chain.title', 'dream.chain.absent', 'dream.chain.ambiguous', 'dream.chain.more', 'dream.chain.rule']
  const rsLangs = ['zh', 'en', 'pt-br']
  const rsMissing = []
  for (const lang of rsLangs) {
    const body = readFileSync(join(root, 'vendor', 'meow-memory', 'lib', 'prompts', lang, 'labels.md'), 'utf8')
    for (const key of rsKeys) if (!body.includes(`- ${key}:`)) rsMissing.push(`${lang}:${key}`)
  }
  check('RS8 文案三语都在（zh / en / pt-br 各 5 条链体检键）', rsMissing.length === 0, rsMissing.join(' '))
}

// RT0-RT5（0.2.143）：相关度下限按分数裁，可分数排的是「措辞贴不贴这次提问」，不是「谁接了班」。
// 退位的旧说法字面很贴就能进榜，接手它的新说法措辞朴素、掉到下限以下被裁掉——读者只看到作废的那条。
// 这一组验「被裁的接班者要提上来、提上来要说出来、认不出就不动、min_rel=0 时不多此一举」。
{
  const rtShown = [{ id: 'old11111-1', content: '口径（已被取代：new22222「新说法正文」，2026-11-21）' }]
  const rtCut = [{ id: 'new22222-9', content: '新说法正文' }]
  check('RT0 纯函数：被裁的那条正是榜上某条的接手者 → 提上来', Meow.liftSuccessors(rtShown, rtCut).length === 1 && Meow.liftSuccessors(rtShown, rtCut)[0].id === 'new22222-9')
  const rtAmb = [
    { id: 'new22222-9', content: '完全不同的甲' },
    { id: 'new22222-8', content: '完全不同的乙' },
  ]
  check('RT1 认不出是谁就不动：同前缀多条、开头都对不上 → 一条都不提（提错人比不提更坏）', Meow.liftSuccessors(rtShown, rtAmb).length === 0)
  const rtMany = [
    { id: 'a1111111-1', content: 'x（已被取代：b1111111「甲」，2026-11-21）' },
    { id: 'a2222222-1', content: 'y（已被取代：b2222222「乙」，2026-11-21）' },
    { id: 'a3333333-1', content: 'z（已被取代：b3333333「丙」，2026-11-21）' },
    { id: 'a4444444-1', content: 'w（已被取代：b4444444「丁」，2026-11-21）' },
  ]
  const rtCut4 = [
    { id: 'b1111111-9', content: '甲' },
    { id: 'b2222222-9', content: '乙' },
    { id: 'b3333333-9', content: '丙' },
    { id: 'b4444444-9', content: '丁' },
  ]
  check('RT2 有上限：四对也只提三条（下限是省 token 的旋钮，不是越多越好）', Meow.liftSuccessors(rtMany, rtCut4).length === 3)
  const rtWs = mkdtempSync(join(tmpdir(), 'meow-lift-'))
  Meow.trustWorkspace(rtWs)
  const rtExec = { agent: { session: { header: { cwd: rtWs, id: 'sess-lift' } } } }
  const rtRun = (name, args) => tools.get(name).execute(args, rtExec)
  const rtText = (v) => (typeof v === 'string' ? v : JSON.stringify(v))
  const rtDb = Meow.getDb(rtWs, '.dsh-meow')
  const rtOld = rtDb.insert({
    level: 'fact',
    content: '海沟折叠口径 三档权重 排序 结论 海沟折叠口径 三档权重 排序 结论 海沟折叠口径 三档权重 排序 结论 这一段故意写很长，用来把榜首压住。',
    keywords: ['海沟折叠口径', '三档权重', '排序', '结论'],
    importance: 3,
    project: '探针提升',
  })
  const rtNew = rtDb.insert({ level: 'fact', content: '新说法：口径已改成按状态排。', keywords: ['结论'], importance: 2, project: '探针提升' })
  rtDb.update('fact', rtOld.id, {
    status: 'stale',
    content: `海沟折叠口径 三档权重 排序 结论 海沟折叠口径 三档权重 排序 结论 海沟折叠口径 三档权重 排序 结论 这一段故意写很长，用来把榜首压住。（已被取代：${String(rtNew.id).slice(0, 8)}「新说法：口径已改成按状态排。」，2026-11-21）`,
  })
  const rtOldShort = String(rtOld.id).slice(0, 8)
  const rtNewShort = String(rtNew.id).slice(0, 8)
  const rtSearch = rtText(await rtRun('memory_search', { query: '海沟折叠口径 三档权重 排序 结论', status: 'all', k: 5, content_max: 200 }))
  check(
    'RT3 真工具：接手者本来在下限以下，这次被提上来（榜上不只那条退位的）',
    rtSearch.includes(rtOldShort) && rtSearch.includes(rtNewShort) && rtSearch.includes('并展开'),
    rtSearch.replace(/\s+/g, ' ').slice(0, 300),
  )
  check('RT4 真工具：提上来时明说「上面那条已被取代，别再当结论用」', rtSearch.includes('别再当结论用') && rtSearch.includes(rtNewShort))
  const rtAll = rtText(await rtRun('memory_search', { query: '海沟折叠口径 三档权重 排序 结论', status: 'all', k: 5, content_max: 200, min_rel: 0 }))
  check('RT5 min_rel=0 时不多此一举：没有东西被裁，也就没有「一并展开」这句', !rtAll.includes('并展开'))
  try {
    rmSync(rtWs, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
  const rtMissing = []
  for (const lang of ['zh', 'en', 'pt-br']) {
    const body = readFileSync(join(root, 'vendor', 'meow-memory', 'lib', 'prompts', lang, 'labels.md'), 'utf8')
    if (!body.includes('- search.floorLift:')) rtMissing.push(lang)
  }
  check('RT6 文案三语都在', rtMissing.length === 0, rtMissing.join(' '))
}

// ── RU. 这轮写的，库里早有了（0.2.144）──────────────────────────────────────────
// dream 前三块（逐字重复 / 重复详写 / 疑似冲突）都只在本轮行里互相比：新写一条与三个月前那条一字不差，
// dream 一句话都不说。这一段验的是「本轮某条 ⇔ 全库某条」这一侧。
{
  const ruOld = {
    id: '0mru0001',
    level: 'fact',
    project: '重复探针',
    status: 'active',
    updated_at: Date.now() - 40 * 864e5,
    keywords: ['重复', '探针'],
    content: '重复探针：记忆写入之前要先用关键字把库查一遍，别把同一条存第二次',
  }
  const ruNew = {
    id: '0mru0002',
    level: 'fact',
    project: '重复探针',
    status: 'active',
    updated_at: Date.now(),
    keywords: ['重复', '探针'],
    content: '重复探针：记忆写入之前要先用关键字把库查一遍，别把同一条存第二次',
  }
  const ruStub = (rows, counter) => ({
    list: (level) => {
      counter.n++
      return rows.filter((r) => r.level === level)
    },
  })

  const ruC1 = { n: 0 }
  const ruRep = Meow.dreamRepeatIssues([ruNew], ruStub([ruOld], ruC1))
  check(
    'RU0 库里那条被点出来（本轮只有新条）',
    ruRep.list.length === 1 && String(ruRep.list[0].otherId) === '0mru0001' && ruRep.list[0].repeat >= 0.8,
    JSON.stringify(ruRep),
  )
  check('RU0b 干净时也走了一遍库（scanned>0），不是没查就报没事', ruRep.scanned === 1, String(ruRep.scanned))

  const ruC2 = { n: 0 }
  const ruSame = Meow.dreamRepeatIssues([ruOld, ruNew], ruStub([ruOld, ruNew], ruC2))
  check(
    'RU1 两条都在本轮时不算「库里早有了」：本轮内部交给 dupPairs，这里不重复报',
    ruSame.list.length === 0 && ruSame.scanned === 0,
    JSON.stringify(ruSame),
  )

  const ruC3 = { n: 0 }
  const ruEmpty = Meow.dreamRepeatIssues([], ruStub([ruOld], ruC3))
  check('RU2 本轮一行都没有时一次库调用都不做', ruEmpty.list.length === 0 && ruC3.n === 0, JSON.stringify(ruEmpty))

  const ruKwOnly = {
    id: '0mru0003',
    level: 'fact',
    project: '重复探针',
    status: 'active',
    updated_at: Date.now(),
    keywords: ['重复', '探针'],
    content: '完全不同的一句话：验证码识别要先切图再做模板匹配',
  }
  const ruC4 = { n: 0 }
  const ruNo = Meow.dreamRepeatIssues([ruKwOnly], ruStub([ruOld], ruC4))
  check('RU3 只是关键字撞上、正文不一样，不当重复', ruNo.list.length === 0, JSON.stringify(ruNo.list))

  const ruNoKw = { ...ruNew, id: '0mru0004', keywords: [] }
  const ruC5 = { n: 0 }
  const ruHead = Meow.dreamRepeatIssues([ruNoKw], ruStub([ruOld], ruC5))
  check(
    'RU3b 一条关键字都没有时，靠正文前缀也认得出',
    ruHead.list.length === 1 && String(ruHead.list[0].otherId) === '0mru0001',
    JSON.stringify(ruHead.list),
  )

  const ruStaleOther = Meow.dreamRepeatIssues([ruNew], ruStub([{ ...ruOld, status: 'stale' }], { n: 0 }))
  check('RU3c 对方已退位也要报（这轮是重写还是复活，得有人问）', ruStaleOther.list.length === 1 && ruStaleOther.list[0].otherStatus === 'stale', JSON.stringify(ruStaleOther.list))

  const ruShort = new Map([
    ['0mru0001', '0mru0001'],
    ['0mru0002', '0mru0002'],
  ])
  const ruLbl = (key, vars = {}) => {
    const line = readFileSync(join(root, 'vendor', 'meow-memory', 'lib', 'prompts', 'zh', 'labels.md'), 'utf8')
      .split('\n')
      .find((one) => one.startsWith(`- ${key}:`))
    if (line === void 0) return ''
    return line.slice(key.length + 3).trim().replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m))
  }
  const ruBlock = Meow.dreamRepeatBlock({ list: ruRep.list, total: ruRep.total + 2 }, ruShort, ruLbl)
  check('RU4 块标题报总数、不是「列了几条」', ruBlock.includes('库里已经有了 3 条'), ruBlock.split('\n')[1] ?? '')
  check('RU4b 每条都有重复度与对方 id', ruBlock.includes('0mru0002') && ruBlock.includes('0mru0001') && ruBlock.includes('重复度 100%'), ruBlock.replace(/\s+/g, ' ').slice(0, 200))
  check('RU4c 对方还在用时给的是「并进它 + 标 stale」', ruBlock.includes('并进 0mru0001') && ruBlock.includes('标 stale'), '')
  check('RU4d 多出来的条数要说出来', ruBlock.includes('还有 2 条'), '')

  const ruRevive = Meow.dreamRepeatBlock({ list: ruStaleOther.list, total: 1 }, ruShort, ruLbl)
  check('RU5 对方已退位时换另一套说法（复活 or 新结论）', ruRevive.includes('已退位') && ruRevive.includes('复活'), ruRevive.replace(/\s+/g, ' ').slice(0, 160))
  check('RU5b 没有重复时这一整段是空串', Meow.dreamRepeatBlock({ list: [], total: 0 }, ruShort, ruLbl) === '', '')

  // 真库一遍：走真的 db.list（不是 stub），索引必须建得起来、认得出现有条目。
  const ruWs = mkdtempSync(join(tmpdir(), 'macro-probe-repeat-'))
  const ruDb = Meow.getDb(ruWs, '.dsh-meow')
  const ruExec = { agent: { session: { header: { cwd: ruWs, id: 'sess-ru' } } } }
  const ruRun = (name, args) => tools.get(name).execute(args, ruExec)
  const ruText = (res) => text(res)
  await ruRun('memory_remember', {
    content: '重复探针真库：这条清单里叫 0.99 版口径，写入前先查库',
    project: '重复探针',
    keywords: ['重复', '真库', '探针'],
    importance: 2,
    level: 'fact',
  })
  const ruRealId = String(ruDb.db.prepare('SELECT id FROM fact WHERE content LIKE ?').get('%重复探针真库%')?.id ?? '')
  const ruRealRows = ruDb.list('fact', {})
  const ruRealRow = ruRealRows.find((r) => String(r.id) === ruRealId) ?? {}
  const ruReal = Meow.dreamRepeatIssues([{ ...ruRealRow, id: '0mru9999', keywords: [] }], ruDb)
  check(
    'RU6 真库：现有条目被索引起来、能认出来（不靠 stub）',
    ruReal.list.length === 1 && String(ruReal.list[0].otherId) === ruRealId && ruReal.scanned > 0,
    JSON.stringify(ruReal),
  )
  const ruRealBlock = Meow.dreamRepeatBlock({ list: ruReal.list, total: ruReal.total }, ruShort, ruLbl)
  check('RU6b 真库那一遍的标题也说得出来', ruRealBlock.length > 0, ruRealBlock.replace(/\s+/g, ' ').slice(0, 160))

  try {
    rmSync(ruWs, { recursive: true, force: true })
  } catch {
    /* ignore */
  }

  const ruMissing = []
  for (const lang of ['zh', 'en', 'pt-br']) {
    const body = readFileSync(join(root, 'vendor', 'meow-memory', 'lib', 'prompts', lang, 'labels.md'), 'utf8')
    for (const key of ['dream.repeat.title', 'dream.repeat.line', 'dream.repeat.keep', 'dream.repeat.revive', 'dream.repeat.more', 'dream.repeat.rule']) {
      if (!body.includes(`- ${key}:`)) ruMissing.push(`${lang}:${key}`)
    }
  }
  check('RU7 文案六键三语都在（中文标题已含「库里已经有了」）', ruMissing.length === 0, ruMissing.join(' '))
  check('RU7b 中文标题确实是这一句', readFileSync(join(root, 'vendor', 'meow-memory', 'lib', 'prompts', 'zh', 'labels.md'), 'utf8').includes('- dream.repeat.title: 这轮写的东西，库里已经有了'), '')
}

// ── RV. 每轮星图邻域注入（0.2.145）────────────────────────────────────────
{
  const nb = await import(pathToFileURL(join(root, 'lib', 'macro', 'neighbor.js')).href)
  // nebula_recall 的回执（真实形状见 fusion.js 的 NODE_HEAD / ID_LINE / WHY_LINE）
  const recall = [
    '星图邻域（1 跳，3 条）：',
    '',
    '1. [fact] dsh-macro-memory     强度 0.82 0.2.144 的交付态',
    '  id: ws:0mwq3aa9',
    '  为什么：同一条线',
    '  摘要：交付态摘要',
    '2. [lesson] dsh-macro-memory     强度 0.61 判空别只判 undefined',
    '  id: 0mwq2ncq',
    '3. [topic] 其他项目     强度 0.55 别的项目的一件事',
    '  id: ws:0mabc123',
  ].join('\n')

  check(
    'RV0 常量：一次最多 4 条 / 420 字符 / 少于 6 字符不猜 / 走 nebula_recall / 来源标 macro-memory:neighbor',
    nb.NEIGHBOR_DEFAULT_MAX === 4 &&
      nb.NEIGHBOR_DEFAULT_CHARS === 420 &&
      nb.NEIGHBOR_MIN_QUERY === 6 &&
      nb.NEIGHBOR_SEEN_MAX === 200 &&
      nb.NEIGHBOR_TOOL === 'nebula_recall' &&
      nb.NEIGHBOR_SOURCE_KIND === 'macro-memory:neighbor',
    '',
  )

  // ── 取「这一轮用户说的话」：只看 source.kind === 'user'
  const msgs = [
    { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '上一轮的话' }] },
    { role: 'user', source: { kind: 'macro-memory:neighbor' }, content: [{ type: 'text', text: '上一轮注入的东西' }] },
    {
      role: 'user',
      source: { kind: 'user' },
      content: [{ type: 'text', text: '这一轮想找回以前那个写入节流怎么定的' }, { type: 'image' }],
    },
  ]
  check(
    'RV1 取最后一条用户消息的文本块（跳过自己注入的、跳过图片块）',
    nb.neighborQueryOf(msgs) === '这一轮想找回以前那个写入节流怎么定的',
    nb.neighborQueryOf(msgs),
  )
  check(
    'RV1b 没有用户消息 / 空列表都给空串',
    nb.neighborQueryOf([{ role: 'user', source: { kind: 'tool' } }]) === '' && nb.neighborQueryOf([]) === '',
    '',
  )

  // ── 渲染
  const blk = nb.neighborBlockOf(recall, { max: 4, chars: 420 })
  check(
    'RV2 渲染 3 条、标题自报来路、带强度与 8 位短 id、多前缀 id 认得出裸 id',
    blk !== null &&
      blk.ids.length === 3 &&
      blk.text.startsWith('【星图邻域 · 自动带来的】') &&
      blk.text.includes('- [fact] [0mwq3aa9]') &&
      blk.text.includes('强度 0.82') &&
      blk.ids[1] === '0mwq2ncq',
    blk === null ? 'null' : blk.text.split('\n')[1],
  )
  check(
    'RV2b 收尾给读全文的办法，并提醒别把摘要当原文',
    blk !== null && blk.text.includes('memory_read("0mwq3aa9")') && blk.text.includes('看全文'),
    '',
  )
  check('RV2c 上限生效：max=2 只带 2 条', (nb.neighborBlockOf(recall, { max: 2 })?.ids.length ?? 0) === 2, '')
  check('RV2d max=0 一条都不带（回 null，不是空串）', nb.neighborBlockOf(recall, { max: 0 }) === null, '')
  check(
    'RV2e 空回执 / 解析不出节点都不注入',
    nb.neighborBlockOf('', {}) === null && nb.neighborBlockOf('星图里没找到相关记忆', {}) === null,
    '',
  )
  const tight = nb.neighborBlockOf(recall, { max: 4, chars: 120 })
  check(
    'RV2f 字符上限真的管用：120 字符只装得下 1 条，且整块不超限',
    tight !== null && tight.ids.length === 1 && tight.text.length <= 120,
    tight === null ? 'null' : `${tight.ids.length} 条 / ${tight.text.length} 字`,
  )
  const skipped = nb.neighborBlockOf(recall, { skip: ['0mwq3aa9'] })
  check(
    'RV3 带过的（裸 id 或 ws: 前缀都认）不再带',
    skipped !== null && skipped.ids.length === 2 && !skipped.ids.includes('0mwq3aa9'),
    skipped === null ? 'null' : skipped.ids.join(','),
  )
  check(
    'RV3b 全都带过就什么都不注入',
    nb.neighborBlockOf(recall, { skip: ['0mwq3aa9', '0mwq2ncq', '0mabc123'] }) === null,
    '',
  )

  // ── 决策函数：追加在**后面**，前缀一个字节不动
  const mkAgent = (origin, sid = 'rv-sess-1') => ({ session: { id: sid, header: { origin } } })
  const mkUser = (text) => ({
    role: 'user',
    source: { kind: 'user' },
    content: [{ type: 'text', text }],
  })
  const mkRt = (text, { throws = false } = {}) => {
    const calls = []
    const bridge = {
      tryCall: async (name, args) => {
        calls.push({ name, args })
        if (throws) throw new Error('星图挂了')
        return { text }
      },
    }
    return { bridge, calls }
  }
  const mkCtx = () => {
    const events = []
    return {
      events,
      on: (name, handler) => {
        events.push({ name, handler })
        return () => events.push({ name: `${name}:disposed` })
      },
    }
  }

  const rt1 = mkRt(recall)
  const ctx1 = mkCtx()
  const inj1 = nb.createNeighborInjector({ ctx: ctx1, bridge: rt1.bridge, config: {}, logger: () => {} })
  const base = { kind: 'enter', messages: [mkUser('写入节流那个窗口后来怎么定的')] }
  const out1 = await inj1.decide({ agent: mkAgent('cli') }, base)
  check(
    'RV4 决定函数把邻域追加到末尾（原来的消息一条不动、顺序不变）',
    out1.messages.length === 2 && out1.messages[0] === base.messages[0] && out1.messages[1] !== base.messages[0],
    `${out1.messages.length} 条`,
  )
  check(
    'RV4b 注入消息自带来路（source.kind + 摘要里说几条）',
    out1.messages[1].source?.kind === nb.NEIGHBOR_SOURCE_KIND &&
      String(out1.messages[1].source?.summary ?? '').includes('3'),
    JSON.stringify(out1.messages[1].source ?? {}),
  )
  check(
    // 0.6.38 起多要 4 条（原来是 max+2）：强度过滤会刷掉一部分，回执只按 limit 裁剪，
    // 不多要就只能拿到「过滤后不足 max 条」。这条断言钉的是「多要」这个决定本身。
    'RV4c 查星图只带 query / limit=max+4（给强度过滤留余量）/ hops=1',
    rt1.calls.length === 1 &&
      rt1.calls[0].name === 'nebula_recall' &&
      rt1.calls[0].args.hops === 1 &&
      rt1.calls[0].args.limit === nb.NEIGHBOR_DEFAULT_MAX + 4 &&
      typeof rt1.calls[0].args.query === 'string',
    JSON.stringify(rt1.calls[0]?.args ?? {}),
  )
  check(
    'RV4d 注入器挂在 agent/pre-step 上（只挂这一个事件）',
    ctx1.events.length === 1 && ctx1.events[0].name === 'agent/pre-step' && typeof inj1.dispose === 'function',
    ctx1.events.map((e) => e.name).join(','),
  )

  // 同一会话第二轮：同样的邻居不再带
  const out2 = await inj1.decide({ agent: mkAgent('cli') }, base)
  check(
    'RV5 同一会话第二轮不重复带（这些 id 已经带过了）',
    out2.messages.length === 1 && inj1.stats().skipped === 1 && inj1.stats().injected === 1,
    JSON.stringify(inj1.stats()),
  )

  inj1.dispose()
  check(
    'RV5b dispose 真的把钩子摘了（不是空函数）',
    ctx1.events.length === 2 && ctx1.events[1].name === 'agent/pre-step:disposed',
    ctx1.events.map((e) => e.name).join(','),
  )

  // subagent 不注入
  const rt2 = mkRt(recall)
  const inj2 = nb.createNeighborInjector({ ctx: mkCtx(), bridge: rt2.bridge, config: {}, logger: () => {} })
  const out3 = await inj2.decide({ agent: mkAgent('subagent') }, base)
  check('RV6 子代理会话不注入（它有自己的活要干）', out3.messages.length === 1 && rt2.calls.length === 0, '')

  // 关掉开关
  const rt3 = mkRt(recall)
  const inj3 = nb.createNeighborInjector({ ctx: mkCtx(), bridge: rt3.bridge, config: { neighborInject: false }, logger: () => {} })
  const out4 = await inj3.decide({ agent: mkAgent('cli') }, base)
  check('RV6b 关掉开关就一次都不查星图', out4.messages.length === 1 && rt3.calls.length === 0, '')

  // 话太短不猜
  const rt4 = mkRt(recall)
  const inj4 = nb.createNeighborInjector({ ctx: mkCtx(), bridge: rt4.bridge, config: {}, logger: () => {} })
  const out5 = await inj4.decide({ agent: mkAgent('cli') }, { kind: 'enter', messages: [mkUser('嗯')] })
  check('RV7 「嗯」「继续」这种不猜（短于 6 字符直接放过）', out5.messages.length === 1 && rt4.calls.length === 0, '')

  // 星图挂了 / 空回执 / 取不到消息工厂：都不许挡住这一轮
  const rt5 = mkRt(recall, { throws: true })
  const inj5 = nb.createNeighborInjector({ ctx: mkCtx(), bridge: rt5.bridge, config: {}, logger: () => {} })
  const out6 = await inj5.decide({ agent: mkAgent('cli') }, base)
  check('RV8 星图报错不影响这一轮（原样返回，记一笔 failed）', out6.messages.length === 1 && inj5.stats().failed === 1, JSON.stringify(inj5.stats()))

  const rt6 = mkRt('星图里没找到相关记忆')
  const inj6 = nb.createNeighborInjector({ ctx: mkCtx(), bridge: rt6.bridge, config: {}, logger: () => {} })
  const out7 = await inj6.decide({ agent: mkAgent('cli') }, base)
  check('RV8b 空回执不注入（记一笔 skipped）', out7.messages.length === 1 && inj6.stats().skipped === 1, '')

  const rt7 = mkRt(recall)
  const inj7 = nb.createNeighborInjector({
    ctx: mkCtx(),
    bridge: rt7.bridge,
    config: {},
    logger: () => {},
    loadLlm: async () => {
      throw new Error('宿主里没有 dsh-llm')
    },
  })
  // 0.6.43 起账本会落盘：RV5 已经用 rv-sess-1 记过这一条，后面的「装配路径」断言得换会话，
  // 否则新注入器（= 重启）一进来就按账本把这轮挡空，测的就不是装配而是去重了。
  const out8 = await inj7.decide({ agent: mkAgent('cli', 'rv-sess-8c') }, base)
  check('RV8c 取不到宿主消息工厂时也不抛（原样返回，记一笔 failed）', out8.messages.length === 1 && inj7.stats().failed === 1, '')

  // 默认 loadLlm 走真 import：探针里由 registerHooks 指向 stub，能造出消息才说明运行时这条路通
  const rt8 = mkRt(recall)
  const inj8 = nb.createNeighborInjector({ ctx: mkCtx(), bridge: rt8.bridge, config: {}, logger: () => {} })
  const out9 = await inj8.decide({ agent: mkAgent('cli', 'rv-sess-9') }, base)
  check(
    'RV9 默认懒加载 @deepseek-ai/dsh-llm 能造出真消息（探针 stub 与宿主同形）',
    out9.messages.length === 2 && out9.messages[1].role === 'user' && typeof out9.messages[1].content[0].text === 'string',
    '',
  )
}

for (const d of disposers) {
  try {
    d()
  } catch {
    /* ignore */
  }
}
console.log('---')
console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`)
console.log(`临时 DSH_HOME：${home}`)
if (failures === 0) {
  try {
    rmSync(home, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
}
process.exit(failures === 0 ? 0 : 1)
