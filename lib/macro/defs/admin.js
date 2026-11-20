import { TEXT_OUT, pick } from '../shared.js'
import { NOT_READY_MARK } from '../contract.js'
import { brandText } from '../brand.js'
import { GUIDE_TEXT, buildFullGuide, NAV_TEXT, clampGuide, guideBudget } from '../prompt.js'
import { readCost } from '../cost.js'
import { readDreamPanel, workspaceOfExec } from '../dreamledger.js'
import { describeMs, pendingReport } from '../links.js'
import { cardTitle, limitOf, panelText } from '../panel.js'

// 动作表：一行一个面板（0.2.22）。
// 这张表同时是三样东西的唯一出处：参数的 action 枚举、execute 里的分发、以及
// 「这个动作到底要不要外部服务」。以前它是一条 if/else 链 + 一份手写枚举，
// 两处各改各的，最容易出的坏法是「枚举里列了、一调就掉进未知 action」——
// 模型照着 schema 选，选到就报错，而自检全绿（枚举没人核对）。
//
// 每行只能有一种实现：
//   kind: 'call'  —— meow 自己的工具，必须成功；失败=这个面板没有意义
//   kind: 'graph' —— 星图侧的工具，缺席时降级说明，不许把内部错误甩给模型
//   kind: 'local' —— 本地计算（成本账本 / 待补队列 / 手册），不碰外部服务
// params 只列这个动作真正读的参数，其余参数一概不往子工具里传。
// [macro-fusion 0.2.68] 但「不往下传」不等于「可以不说话」：schema 八个参数对每个
// action 都合法，用户给 cost 配个 kind 时，那个 kind 就这样消失了。所以下面另有一张
// PARAM_OWNERS 反查表 + strayNote()，把「这个面板不读的那几个」在抬头里点出来。
//
// 0.2.25 起每行还带三样「口径」：label（面板的中文名，抬头与卡片标题都用它）、
// hint（工具描述里那一句）、defaultLimit（条数上限的默认值）。名字只写这一遍。
export const ACTIONS = {
  home: { kind: 'call', label: '记忆库位置', hint: '记忆库位置/切换', call: 'memory_home', params: ['target'] },
  stats: { kind: 'graph', label: '星图概况', hint: '星图概况', graph: 'nebula_stats', params: ['hubs'], what: '星图概况', miss: '星图概况这会儿看不了' },
  hygiene: { kind: 'graph', label: '记忆体检', hint: '记忆体检（重复/该更新/关系凑数/超重/没人读/孤立）', graph: 'nebula_hygiene', params: ['kind', 'limit'], what: '记忆体检', miss: '记忆体检这会儿做不了', guard: guardHygiene },
  sources: { kind: 'graph', label: '记忆来源', hint: '记忆来源', graph: 'nebula_sources', params: ['verbose'], what: '记忆来源', miss: '记忆来源这会儿看不了' },
  ingest: { kind: 'graph', label: '外部记忆推入', hint: '推入外部记忆', graph: 'nebula_ingest', params: ['provider', 'items'], what: '外部记忆推入', miss: '这批外部记忆一条都没推进去', guard: guardIngest },
  cost: { kind: 'local', label: '成本账本', hint: '成本账本', params: ['limit'], defaultLimit: 200 },
  // [macro-fusion 0.2.97] dream 的账本原来只有写口（dream_log），没有读口：整理完看到几条、
  // 点出几对、缺几个词，全躺在 sqlite 里。这一行把它摆上面板——数字念的是账本，不是现算。
  dream: {
    kind: 'local',
    label: '整理留痕',
    hint: '最近几次整理看到几条、点出几对、缺几个词',
    params: ['limit', 'page', 'id'],
    defaultLimit: 5,
  },
  links: { kind: 'local', label: '待补连线', hint: '待补连线队列（写记忆时没连上的连线，读记忆时会自动补）', params: ['limit'], defaultLimit: 20 },
  // wrap: false —— 全表唯一豁免：手册是长文，没有「条数/时间窗」这种口径可报，
  // 而且要让它第一行就是门牌（「宏记忆有三个面」），多加一行抬头反而把它埋了。
  guide: { kind: 'local', label: '完整手册', hint: '完整手册全文（含星图规则）', params: [], wrap: false },
}

/** 工具描述：面板清单由表生成，少写一遍就少一处能漂的地方。 */
export const PANEL_SUMMARY =
  '宏记忆的运维面板：' + Object.entries(ACTIONS).map(([action, spec]) => `${action} ${spec.hint}`).join('；') + '。'

/**
 * [macro-fusion 0.2.68] 参数归属反查表：一个参数名 → 哪些 action 真的读它。
 *
 * 这张表和 ACTIONS 是同一份数据算出来的，不是又抄一遍。它存在的理由只有一句：
 * 面板收到不认识的参数时，能顺手告诉用户「这个参数是谁的」，而不是只丢一句「没用上」。
 */
export const PARAM_OWNERS = (() => {
  const map = new Map()
  for (const [action, spec] of Object.entries(ACTIONS)) {
    for (const name of spec.params ?? []) {
      if (!map.has(name)) map.set(name, [])
      map.get(name).push(action)
    }
  }
  return map
})()

/**
 * [macro-fusion 0.2.68] 「这个面板不读的那几个参数」要说出来。
 *
 * 八个参数（target / limit / kind / hubs / verbose / provider / items）在 schema 上对
 * 每个 action 都合法，执行时却只取 spec.params 里列的那几个——以前剩下的就这么没了：
 * 用户给 `action='cost'` 配 `kind='dup'`，看到一份完整账本，会读成「按 dup 筛过的账本」；
 * 给 `action='stats'` 配 `limit=5`，看到十个枢纽，会读成「这五个就是全部」。
 * 面板本身没算错，错的是它一个字都没提这事。
 *
 * 所以这里返回一句抬头尾注：点名每个没被读的参数、它归谁管，并明确「这次一点没参与」。
 * 只报用户真的给了的（undefined 不算），一个都不给时返回空串——正常调用一个字都不多。
 */
export function strayNote(action, spec, args) {
  const own = spec?.params ?? []
  const stray = Object.keys(Object.fromEntries(PARAM_OWNERS)).filter(
    (name) => !own.includes(name) && args?.[name] !== undefined,
  )
  if (stray.length === 0) return ''
  const parts = stray.map((name) => `${name} 是 ${(PARAM_OWNERS.get(name) ?? []).join(' / ')} 的`)
  const it = stray.length > 1 ? '它们' : '它'
  return `${parts.join('；')}——${action} 不读${it}，这次一点没参与（别读成「结果已经按${it}收窄过」）。`
}
/**
 * [macro-fusion 0.2.70] 卡片细节：把这一轮**真给了**的参数写成 `k=v`。
 *
 * 卡片标题的细节位从 0.2.60 起就有（`cardTitle(label, detail)`），七个工具都在用：
 * `检索记忆：本地检索 · 部署`、`读取记忆：0m1abc`。只有运维面板一直空着——
 * `action='hygiene'` 和 `action='hygiene', kind='dup', limit=5` 的卡片一字不差，
 * 两轮并排放在会话里，用户分不清哪张是只看重复、哪张是全量体检。
 *
 * 三条约定：
 *   1. 只列用户真给了的（`undefined` / `null` / 空串不算），没给就返回空串，不留悬空冒号。
 *   2. 顺序按 PARAM_OWNERS 的键序（那张表由 ACTIONS 算出来，不是又抄一份）。
 *   3. 数组说条数（`items=3 条`），不许把 `[object Object]` 贴上卡片。
 * 描述的是**输入**而不是执行：stray 参数也照列，面板抬头那句会说明它没参与。
 */
export function cardDetail(args) {
  const parts = []
  for (const name of PARAM_OWNERS.keys()) {
    const v = args?.[name]
    if (v === undefined || v === null || v === '') continue
    if (Array.isArray(v)) {
      parts.push(`${name}=${v.length} 条`)
      continue
    }
    if (typeof v === 'object') {
      parts.push(`${name}=${JSON.stringify(v)}`)
      continue
    }
    parts.push(`${name}=${String(v)}`)
  }
  return parts.join(' ')
}


// nebula_ingest 原本 provider/items 都是必填；合并进 action 枚举后 schema 收不住，
// 只能在运行时守（守不住的话星图那边只会回一句听不懂的报错）
function guardIngest(args) {
  if (typeof args.provider !== 'string' || args.provider.trim().length === 0) {
    throw new Error('memory_admin：action="ingest" 需要 provider（来源名，例如 hindsight / openviking）。')
  }
  if (!Array.isArray(args.items) || args.items.length === 0) {
    throw new Error('memory_admin：action="ingest" 需要 items（记忆条目数组，每条至少给 title 或 content）。')
  }
}

/**
 * [macro-fusion 0.2.64] 体检的类别是枚举，给错不许「照跑一遍全部再挑一类空结果」。
 *
 * 星图那边收到不认识的 kind 不会报错：它按 key 去取条目，取不到就是空数组，
 * 于是回执里那一行会变成「（0）」——而抬头还写着「共 N 项」。用户要查「孤立」，
 * 看到的是「共 12 项 + 一行 0」，会读成「孤立这一类是 0 条」，真实是「这一类根本没查」。
 * 所以在入口按白名单校验并归一（大小写、前后空格），不认识的一次都不往下发。
 */
const HYGIENE_KINDS = ['dup', 'stale', 'thin', 'oversize', 'unread', 'orphan']

/**
 * [macro-fusion 0.2.91] 体检里的「相似 N」和工具里的「逐字重复度」不是同一个量。
 *
 * 实测（同一条前言 + 两个不同核心，两条各 40 余字）：
 *   星图体检 → `疑似重复（1）…（相似 1）`；
 *   memory_search 的 similar → `相似度 0.624（逐字 0.42）`，写侧也没判重复。
 * 两个数差 0.58，方向还是「面板说完全重复、工具说只有四成」，照着面板去归档就等于删掉一件
 * 独立的事。原因不在谁算错了：星图为了能扫全库，用的是**稀有词签名**（每条约留最稀有的
 * 24 个词，且只算在两条以上出现过的词），门槛 0.86；库里条数少时这个签名会退化成
 * 「两边共有的词」，于是 Jaccard 顶到 1。工具侧的 repeat 是全文词集，跟写侧合并门槛同源。
 *
 * 所以这里不重算（融合层拿不到正文），只把两把尺子摆到抬头里：说清这个 N 是什么、
 * 什么时候会顶格、要判「同一句存了两层」该看哪个数。
 * 只在真列出了对子时说——没对子（0 条 / 星图缺席）时这句话就是噪音。
 */
export function hygieneRulerNote(body, args) {
  const asked = typeof args?.kind === 'string' ? args.kind.trim().toLowerCase() : ''
  if (asked !== '' && asked !== 'dup') return ''
  const text = String(body ?? '')
  if (!text.includes('（相似 ')) return ''
  return (
    '这里的「相似 N」是星图的稀有词签名估算（每条约留最稀有的 24 个词，只算在两条以上出现过的词），' +
    '跟 memory_search 报的「逐字重复度」不是同一把尺子——库里条数少的时候签名常顶到 1，' +
    '而全文逐字可能只有四成。判「同一句存了两层」看 memory_search 的 repeat（≥0.80 写侧就判重复）；' +
    '判「两条在说同一件事」看这里。'
  )
}

/**
 * [macro-fusion 0.2.100] dream 面板的两个数字参数：page（第几页）、id（展开第几近）。
 *
 * 都不许静默退回默认——这是和 0.2.68 那条「不往下传不等于可以不说话」同一个理由：
 * 用户写了 page=3 却看到第一页，会读成「账本只有这一页」；写了 id="abc" 却看到整本账，
 * 会读成「展开失败但账本长这样」。所以脏值直接打回，并说清这次什么都没按你说的做。
 * id 收 "#3" 和 "3" 两种写法：面板上印的就是 #k，人照着抄最省事。
 */
function pageOf(raw) {
  if (raw === undefined || raw === null || raw === '') return 1
  const n = Math.trunc(Number(raw))
  if (!Number.isFinite(n) || n < 1) {
    throw new Error(
      `memory_admin：action="dream" 的 page 只认从 1 起的整数（每页 limit 条），给的是「${String(raw)}」。\n` +
        '要第一页就不传 page。这次没有列账——别把「没列」读成「账本里只有这几条」。',
    )
  }
  return Math.min(100000, n)
}

function idOf(raw) {
  if (raw === undefined || raw === null || raw === '') return 0
  const text = String(raw).trim().replace(/^#/, '')
  const n = Math.trunc(Number(text))
  if (!Number.isFinite(n) || n < 1) {
    throw new Error(
      `memory_admin：action="dream" 的 id 只认「3」或「#3」这种「第几近」编号（1 = 最新，和列表里的 #k 一致），给的是「${String(raw)}」。\n` +
        '这次没有展开任何一条——别把「没展开」读成「这条账不存在」。',
    )
  }
  return Math.min(1000000, n)
}

function guardHygiene(args) {
  if (args.kind === undefined || args.kind === null) return
  const raw = String(args.kind)
  const name = raw.trim().toLowerCase()
  // 空串＝没给：星图那边只判真假，空串会走「全部概览」，与缺省同义。
  if (name === '') return
  if (!HYGIENE_KINDS.includes(name)) {
    throw new Error(
      `memory_admin：action="hygiene" 的 kind 只认 ${HYGIENE_KINDS.join(' / ')}（大小写不敏感，前后空格会去掉），给的是「${raw}」。\n` +
        '不传 kind 就返回全部六类概览。\n' +
        '这次体检没有跑——别把「没跑」读成「这一类没有问题」。',
    )
  }
  args.kind = name
}

export function createAdmin({ flow, bridge, config = {}, meowDir = () => '.dsh-meow' }) {
  // 本地面板：不依赖外部服务，也就不该有降级分支。
  // 返回 { body, note }：抬头由 panel.js 统一加，这里只负责正文和口径说明（0.2.25）。
  const local = {
    cost(args) {
      const lim = limitOf(ACTIONS.cost, args)
      // [macro-fusion 0.2.76] 抬头以前无条件写「最近 N 次调用」，正文却只算了账本里剩下的那几条。
      // 现在口径由 cost.js 的 costScope() 一处产出：真算了几条、你要几条、更早几条没进、几行读不出来。
      const c = readCost(lim.value)
      return { body: c.body, note: [c.scope, lim.note].filter(Boolean).join(' · ') }
    },
    // [macro-fusion 0.2.97] 整理留痕：正文与口径都在 dreamledger.js，这里只负责把「这次是谁在问」
    // （工作区）和「读到哪本账」（meow 现在生效的 projectDir）交进去。
    dream(args, exec) {
      const lim = limitOf(ACTIONS.dream, args)
      const dir = typeof meowDir === 'function' ? meowDir() : meowDir
      // [macro-fusion 0.2.100] 翻页与单条展开：两个数字参数各有各的「不许悄悄退回默认」。
      // page / id 给脏了就说清这次没按你说的做——静默退回第 1 页最容易让人以为「账本就这几条」。
      const page = pageOf(args.page)
      const id = idOf(args.id)
      const panel = readDreamPanel({
        workspace: workspaceOfExec(exec),
        dir: typeof dir === 'string' && dir.length > 0 ? dir : '.dsh-meow',
        limit: lim.value,
        page,
        id,
      })
      return { body: panel.body, note: [panel.scope, lim.note].filter(Boolean).join(' · ') }
    },
    async links(args, exec) {
      const lim = limitOf(ACTIONS.links, args)
      // 面板不写数（0.2.33）：预算与条数都在 linkflow 的配置里，面板和后台走同一条出口。
      // 以前这里传 { budgetMs: 1500, limit: 20 }，改了默认值面板不知道，两处各说各的。
      const round = await flow.flushNow(exec)
      const panel = pendingReport(lim.value)
      const notes = []
      if (round.linked > 0) notes.push(`这一轮补上 ${round.linked} 条`)
      if (round.dropped > 0) notes.push(`清掉 ${round.dropped} 条永远连不上的（记忆已合并/删除）`)
      // 0.2.54：撞车与没查成一律不摘队列，面板要说清它们还在，别让人以为「那一轮把它们清掉了」
      if (round.ambiguous > 0) {
        notes.push(`另有 ${round.ambiguous} 条短 id 不止一条记忆，没连也没摘——把 id 补到 8 位以上再说`)
      }
      if (round.unavailable > 0) {
        notes.push(`另有 ${round.unavailable} 条这次没查成（读记忆的工具没接上），原样留着下次再试`)
      }
      if (round.stopped === 'unavailable') notes.push('星图这次没接上，队列原样留着')
      // 预算是真的（0.2.28）：掐断了就说清还剩几条，别让面板看起来像「补完了一轮」
      if (round.stopped === 'budget') notes.push(`这一轮预算用完，还剩 ${round.left} 条下次读记忆时接着补`)
      // 0.2.36：note 里带上这一轮真正用了多少预算、几条上限（来自 config，不是面板自己写的数）。
      // 以前只说「最多列 N 条」，用户看到「还剩 12 条」时分不清是被 1.5 秒掐的还是被 20 条掐的。
      const cap = `这一轮补连最多 ${describeMs(round.budgetMs)}、${round.limit} 条`
      // 0.2.61：limit 被换成默认值时要说出来（0 照办 0、负数与非数字回默认、半条抹掉半条）
      const note = [`最多列 ${lim.value} 条`, cap, lim.note].filter(Boolean).join(' · ')
      return { body: notes.length > 0 ? `${panel}\n（${notes.join('；')}）` : panel, note }
    },
    guide() {
      // 门牌在前、vendor 原文在后：手册里全是子插件自己的话，读者光看正文不知道命令和面板也还在
      // （0.2.16）。所以先讲三个面，再把两段原文原样接上。
      // 0.2.63：末尾补一行「L0 现在多少字 / 上限是多少」。上限被配置写坏时那句话也一起带出来——
      // 否则 `guideMaxChars: 0`（或写成 `"4k"`）会让整段注入消失，而在这里看一切正常。
      const budget = guideBudget(config.guideMaxChars)
      const fit = clampGuide(GUIDE_TEXT, budget.value).length
      const tail = `L0 注入：现在 ${fit}/${budget.value} 字${budget.note ? `。${budget.note}` : '。'}`
      return {
        body: brandText(`${NAV_TEXT}\n\n---\n\n${buildFullGuide(bridge)}\n\n---\n\n${tail}`, { aliases: config.compatAliases === true }),
      }
    },
  }

  return {
    name: 'memory_admin',
    description: PANEL_SUMMARY,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        // 枚举和执行表是同一份数据：加一行 ACTIONS 就多一个能选的 action，
        // 不存在「schema 里有、分发里没有」的缝。
        action: { type: 'string', enum: Object.keys(ACTIONS), description: '要看的运维面板。' },
        target: { type: 'string', description: 'action=home：目标位置（预设名 default/dsh-storage/plugin-root 或绝对路径）。' },
        limit: { type: 'integer', description: 'action=hygiene/cost/dream/links 的条数（默认：cost 200、links 20、dream 5，hygiene 由星图定）。' },
        kind: { type: 'string', enum: ['dup', 'stale', 'thin', 'oversize', 'unread', 'orphan'], description: 'action=hygiene 只看某一类。' },
        page: { type: 'integer', description: 'action=dream 翻到第几页（从 1 起，每页 limit 条；越过最后一页会退到最后一页并说出来）。' },
        id: { type: 'string', description: 'action=dream 展开第几近的一条（写 "3" 或 "#3"，1 = 最新，和列表里的 #k 同一个编号；摊开摘要、备注与 changes 原文）。' },
        hubs: { type: 'integer', description: 'action=stats 列几个枢纽记忆，默认 10，上限 40。' },
        verbose: { type: 'boolean', description: 'action=sources 是否列出适配器字段说明。' },
        provider: { type: 'string', description: 'action=ingest 的来源名。' },
        items: {
          type: 'array',
          description: 'action=ingest 的记忆条目数组。',
          items: {
            type: 'object',
            additionalProperties: true,
            properties: {
              uid: { type: 'string' },
              title: { type: 'string' },
              content: { type: 'string' },
              level: { type: 'string' },
              keywords: { type: 'array', items: { type: 'string' } },
              project: { type: 'string' },
              importance: { type: 'number' },
              status: { type: 'string' },
              ws: { type: 'string' },
              createdAt: { type: 'number' },
            },
          },
        },
      },
      required: ['action'],
    },
    output: TEXT_OUT,
    async execute(args, exec) {
      const action = String(args.action)
      const spec = ACTIONS[action]
      if (!spec) throw new Error(`memory_admin：未知 action=${action}`)
      // 星图侧的面板：缺席时说清「这次看不了」而不是把内部错误甩给模型（以 meow 为主，但 meow 的
      // 本地功能不依赖星图；只有这些面板本身是星图的）
      // [macro-fusion 0.2.72] 两种「没结果」必须分开说：
      //  - 装配没完成（星图没装 / 这项被配置关掉）→ 等一等有用，但一直这样就要去看配置；
      //  - 星图那边出错（引擎崩、文件读不出来）→ 等和重试都没用，原因必须原样带出来。
      // 以前两种情形共用一句话，还许诺「等一等就好」，顺手把 ENOENT 这类原因吃掉，
      // 于是「库文件读不出来」被读成「等会儿就好」。
      const graphPanel = async (name, payload, what, miss) => {
        const r = await flow.tryCall(name, payload, exec, what)
        if (r.entry) return r.text
        const said = String(r.text ?? '')
        if (said.includes(NOT_READY_MARK)) {
          return `星图这次没接上：${what}要的那个能力还没装配好（星图插件没装，或这一项被配置关掉了）——${miss}，但这不是「星图里没有数据」。装好之后再问一次；一直是这句就别再等了，去看星图插件的配置。`
        }
        const pre = `${what}未完成：`
        const reason = said.startsWith(pre) ? said.slice(pre.length) : said
        return `星图这次答不上来（${what}）：${reason}——${miss}，但这不是「星图里没有数据」，也不是你问错了。重试之前先看这条错误：它是星图那边出的。`
      }
      // 三种 kind 走同一个抬头（0.2.25）：面板名只从表里取，正文原样。
      // wrap:false 的那一行（手册）不加抬头，理由写在那行注释里。
      // [macro-fusion 0.2.68] 手册例外只免「抬头」，不免「说话」：它拿到不认识的参数时
      // 一样要在末尾补一句，否则 `action='guide', limit=5` 就成了全表唯一的静默角落。
      const wrap = (spec, { body, note }) => {
        if (spec.wrap === false) {
          const text = String(body ?? '')
          const extra = String(note ?? '').trim()
          return extra.length > 0 ? `${text}\n\n${extra}` : text
        }
        return panelText(spec.label, body, note)
      }
      // [macro-fusion 0.2.68] 这个面板不读的那几个参数：一声不吭地丢掉，用户会把结果读窄。
      const stray = strayNote(action, spec, args)
      if (spec.kind === 'call') {
        const r = await flow.call(spec.call, pick(args, spec.params), exec)
        return wrap(spec, { body: r.text, note: stray })
      }
      if (spec.kind === 'graph') {
        // 参数校验也挂在表上（guard 字段），分发这边不认识任何具体 action 的名字
        spec.guard?.(args)
        const text = await graphPanel(spec.graph, pick(args, spec.params), spec.what, spec.miss)
        // [macro-fusion 0.2.91] 体检的「相似」是近似签名，不是工具里的逐字重复度；两把尺子要摆到抬头里
        const ruler = action === 'hygiene' ? hygieneRulerNote(text, args) : ''
        return wrap(spec, { body: text, note: [ruler, stray].filter(Boolean).join(' · ') })
      }
      const impl = local[action]
      if (typeof impl !== 'function') throw new Error(`memory_admin：action=${action} 在表里但没有实现`)
      const out = await impl(args, exec)
      return wrap(spec, { body: out.body, note: [out.note, stray].filter(Boolean).join(' · ') })
    },
    presentCall(args) {
      // 卡片标题用表里的中文名：模型读到的 action 是 home/cost 这类键，用户看到的是面板名，
      // 两套写法各走各的时候，卡片会变成「记忆运维：stats」这种谁也不认识的东西（0.2.25）
      // [macro-fusion 0.2.60] 标题统一走 cardTitle()：空细节不留悬空冒号。
      // [macro-fusion 0.2.70] 前缀只放面板中文名——0.2.60 写的就是「prefix 是中文名」，
      // 这里却塞了品牌在里头（卡片上多了两个字），全表唯一一处；品牌本该只在抬头那一行，
      // 那几个字白占了 40 字的细节预算。细节位改成这一轮真给了的参数（cardDetail）。
      const shown = typeof args?.action === 'string' ? args.action.trim() : ''
      const spec = ACTIONS[shown]
      if (!spec) return { card: 'generic', title: cardTitle('未知动作', shown), kind: 'read' }
      return { card: 'generic', title: cardTitle(spec.label, cardDetail(args)), kind: 'read' }
    },
  }
}
