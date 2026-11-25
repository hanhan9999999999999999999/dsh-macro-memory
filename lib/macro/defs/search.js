import { TEXT_OUT, pick } from '../shared.js'
import { recallAnswerKind } from '../contract.js'
import { cardTitle } from '../panel.js'
// [macro-fusion 0.2.109] 回执成本与预算：口径全在 tokencost.js（估算不是计量，够大才报）。
import { BUDGET_MIN, COST_HINT_MIN, COST_SHOW_MIN, budgetOf, costSentence, estTokens, fmtTokens } from '../tokencost.js'
// [macro-fusion 0.2.118] 检索融合：两路名次合成一张榜，重复条目只出现一次。
import { RRF_K, fuseRanked, fusedText, graphNodesOf } from '../fusion.js'
import { workspaceOfExec } from '../dreamledger.js'
import { shortIdsOf, shortenId } from '../shortid.js'
import * as Meow from '../../../vendor/meow-memory/lib/index.js'

// [macro-fusion 0.2.58] mode 不做白名单时，老代码 `String(args.mode ?? 'local')` 会把
// 所有不认识的值静默当成 local：写 `mode:"Graph"` 的人以为拿到的是沿关联扩散，其实拿到的是
// 关键词命中（读者会把它当成「图里就这么几条」）；写 `mode:"similar"` 漏一个字母，
// 反过来抛「本地检索需要 query」——教他改一个他明明写过的词。
const MODE_VALUES = ['local', 'graph', 'bridge', 'similar']

/** [macro-fusion 0.2.60] 卡片上的中文名：和 memory_admin 的动作表同一套规矩（键是给机器的，名字是给人的）。 */
const MODE_LABELS = { local: '本地检索', graph: '沿关联扩散', bridge: '补邻居', similar: '相似条目' }

/**
 * 只属于本地检索的那几个条件（0.2.66）。
 *
 * graph / bridge 走的是星图，星图侧只认 limit / hops / chars / min_weight：用户在 graph 模式
 * 里给了 `project` / `level` / `days` / `k`，星图那一路把它们全丢掉——一声不吭地丢掉，
 * 读者却以为结果已经按项目筛过。而星图没接上时，这一问偏偏退到本地检索，
 * 同样这几个参数**又真的生效了**。同一组参数在两条路径上一进一出，尾注得跟着路径说话。
 */
const LOCAL_ONLY_PARAMS = ['level', 'project', 'status', 'days', 'content_max', 'context', 'explain']

/** 归一 mode：空串/纯空格 = 没给（local），大小写不敏感；不合法时把原值留住。 */
function modeOf(args) {
  const raw = args.mode
  const text = typeof raw === 'string' ? raw.trim() : ''
  if (text.length === 0) return { name: 'local', bad: false, raw: '' }
  const name = text.toLowerCase()
  return { name, bad: !MODE_VALUES.includes(name), raw: String(raw) }
}

/** 模式名对不上时：一句都不查，并把「哪种意图对应哪个词」写出来。 */
function badModeText(mode) {
  return (
    `mode 没生效：你给的是「${mode.raw}」，这里只认 local / graph / bridge / similar` +
    '（大小写不敏感，前后空格会去掉）。这次一条都没查——这不是「记忆里没有」，是模式名没对上。\n' +
    '对应关系：沿关联扩散用 graph；强相关但没读过的邻居用 bridge；相似条目用 similar + id；普通关键词检索用 local（默认）。'
  )
}

/**
 * 参数给在了别的模式上：改动不了结果，但必须说一句，否则读者以为它生效了。
 *
 * [macro-fusion 0.2.65] 尾注不许撒谎：老写法对所有非 graph/bridge 模式一律说
 * 「limit 只在 graph / bridge 生效……这次没用上 limit」。可是 local 模式在「零命中自动扩散」
 * 或 `expand: true` 时，扩散那次呼叫读的正是 args.limit / args.hops 原值——
 * 条件被用上了，回执却告诉他没用上。于是 limit=0 的人看到「扩散没补到东西」，
 * 再看到「limit 这次没用上」，两句一起读成「星图里真没有」。这里按 flags.spread 说实话。
 */
function modeNotes(mode, args, flags = {}) {
  const notes = []
  const spread = flags.spread === true
  const tried = flags.spreadTried === true && !spread
  if (mode !== 'local' && args.expand === true) {
    notes.push(`expand 只在 local 模式生效（这次是 ${mode}），没有额外的本地检索。`)
  }
  // [macro-fusion 0.2.66] 星图接上了 → 这一问走星图，本地那几个条件真的没用上；
  // 星图没接上 → 这一问退到本地检索，同一批条件**真的生效了**（同一句老文案在这里说反话）。
  // 连「没给 query 就没算」也要分开：那时谁都没参与，不是「星图里只有这么多」。
  const fell = flags.graphFellBack === true
  const absent = flags.graphAbsentNoLocal === true
  if ((mode === 'graph' || mode === 'bridge') && args.k !== undefined) {
    const def = mode === 'graph' ? 10 : 4
    notes.push(
      fell
        ? `k 这次真的用上了：星图没接上，这一问退到本地检索，按你给的 k 取的结果——它不是「星图里就这么几条」。`
        : absent
          ? 'k 这次没参与：星图没接上、又没给 query，这一问压根没算。'
          : `k 是本地检索的条数；${mode} 模式用 limit，这次按 ${def} 条算。`,
    )
  }
  if (mode === 'graph' || mode === 'bridge') {
    const localOnly = LOCAL_ONLY_PARAMS.filter((n) => args[n] !== undefined)
    if (localOnly.length > 0) {
      const list = localOnly.join(' / ')
      notes.push(
        fell
          ? `${list} 这些是本地检索的条件：星图没接上，这一问退到本地检索，它们真的用上了——但结果不是星图给的。`
          : absent
            ? `${list} 这些是本地检索的条件：星图没接上、又没给 query，这一问压根没算，它们谁都没参与。`
            : `${list} 只在本地检索生效；${mode} 走星图，这次没用上它们（星图侧认的是 limit / hops / chars / min_weight 那几个）。`,
      )
    }
  }
  if (mode === 'local' && args.limit !== undefined) {
    notes.push(
      spread
        ? `limit 平时是 graph / bridge 的条数；这次扩散真的用了它（limit=${flags.spreadLimit}）——本地检索自己的条数仍用 k。`
        : tried
          ? `limit 平时是 graph / bridge 的条数；这次本来要扩散（会用 limit=${flags.spreadLimit}），但星图没接上——它没参与这次结果。`
          : 'limit 是 graph / bridge 的条数；这次没有扩散，limit 没用上（本地检索的条数用 k）。',
    )
  }
  if (mode === 'local' && args.hops !== undefined) {
    notes.push(
      spread
        ? `hops 平时是 graph / bridge 的扩散跳数；这次扩散真的用了它（hops=${flags.spreadHops}）。`
        : tried
          ? `hops 平时是 graph / bridge 的扩散跳数；这次本来要扩散（会用 hops=${flags.spreadHops}），但星图没接上——它没参与这次结果。`
          : 'hops 是 graph / bridge 的扩散跳数；这次没有扩散，hops 没用上。',
    )
  }
  if (mode === 'similar' && args.limit !== undefined) {
    notes.push('limit 只在 graph / bridge 生效；相似检索的条数用 k，这次没用上 limit。')
  }
  // [macro-fusion 0.2.67] 相似模式原来只有 limit 一句话，别的参数全沉默：
  // 它只认 id / k / content_max（meow 的 memory_find_similar 就这三个），
  // 于是 `query`（最危险——用户以为在按句子找）、level/project/status/days/explain、hops、memory_ids
  // 都被丢掉且一声不吭。0.2.66 把「本地条件在星图那条路上」说明白了，这张第三张表还没人管。
  if (mode === 'similar') {
    if (args.query !== undefined && String(args.query).trim() !== '') {
      notes.push(
        'query 在相似模式没用上：这一问是拿 id 指向的那条记忆去比，不是按你说的句子找——' +
          '想按句子找请用 local（默认），相似检索只认 id / k / content_max。',
      )
    }
    // 注意 content_max：它在 LOCAL_ONLY_PARAMS 里，但相似检索**认**它（meow 的
    // memory_find_similar 收 id / k / content_max）。第一版把它算进「没用上」，
    // 尾注当场自相矛盾——同一句里既说相似检索只认 content_max，又说它没参与。
    // 探针 AX7 就是抓这个的（全参数下要求四句齐），第一跑 3/4。所以这里先把它摘掉。
    const similarIgnored = LOCAL_ONLY_PARAMS.filter((n) => n !== 'content_max' && args[n] !== undefined)
    if (similarIgnored.length > 0) {
      notes.push(
        `${similarIgnored.join(' / ')} 是本地检索的条件；相似检索只认 id / k / content_max，` +
          '这次没用上它们——这不是「没有相似」，是这几个条件压根没算。',
      )
    }
    if (args.hops !== undefined) {
      notes.push('hops 是 graph / bridge 的扩散跳数；相似检索不扩散，这次没用上。')
    }
    if (args.memory_ids !== undefined) {
      notes.push('memory_ids 是 graph / bridge 的起点；相似检索只看 id 指向的那一条，这次没用上。')
    }
  }
  // [macro-fusion 0.2.69] 0.2.67 把「相似模式认不认别人」说清了，反过来还有两个口子没人管：
  // ① `id` 只有 mode=similar 当基准，写在别的模式里一声不吭地被丢掉；
  // ② `memory_ids` 的活是「扩散的起点」——local 模式零命中（或 expand=true）时会真的拿它起跳，
  //    可一旦这次没扩散，它就完全没参与，回执里却是空的。上面 hops 那三支正是这个参数的同族。
  if (mode !== 'similar' && typeof args.id === 'string' && args.id.trim() !== '') {
    notes.push(
      `id 只在 mode=similar 里当基准（这一问是 ${mode}），这次没用上它——这不是「这条记忆被排除了」。` +
        '想拿它当基准找相似条目，用 mode=similar 再问一次。',
    )
  }
  if (mode === 'local' && args.memory_ids !== undefined) {
    notes.push(
      spread
        ? 'memory_ids 这次真的用上了：关联扩散就是从你给的这几个 id 起跳的。'
        : tried
          ? 'memory_ids 平时是扩散的起点；这次本来要扩散（会用你给的 id），但星图没接上——它没参与这次结果。'
          : 'memory_ids 只在扩散时当起点（graph / bridge，或 local 加 expand）；这次没有扩散，它没用上。',
    )
  }
  const bridgeOnly = ['chars', 'min_weight'].filter((n) => args[n] !== undefined)
  if (bridgeOnly.length > 0 && mode !== 'bridge') {
    notes.push(`${bridgeOnly.join(' / ')} 只在 bridge 模式生效，这次没用上。`)
  }
  return notes
}

/**
 * [macro-fusion 0.2.109] 预算不是劝告，是约束：给了 budget 就自己收缩，并如实交代缩了什么。
 *
 * 收缩顺序有讲究：先砍 content_max（每条的字），再砍 k（条数）。反过来会先丢掉
 * 「还有别的相关记忆」这个信息，而砍字最坏只是让人自己再读一次——成本更低的那一步先动。
 *
 * 每一步都**真的重查一遍上游**，不是把字符串截短：截出来的半句会破坏条目结构，
 * 读者拿到「看着完整、其实被腰斩」的回执，比超预算更糟。
 */
async function fitBudget(flow, exec, baseArgs, main, budget) {
  const first = estTokens(main.text)
  if (first <= budget) return { main, note: `按 ${budget} token 预算给：实际 ≈${fmtTokens(first)} token，没缩。` }
  // [macro-fusion 0.2.124] 窗口是最贵的那一块：每条命中带 2N 条邻居，N=1 就能让回执翻倍。
  // 装不下时先把它关掉（context 1→0），再走「先砍字再砍条数」——关窗口只是让读者自己
  // 再查一次，砍字/砍条数会让答案直接消失。
  const rawCtx = Number(baseArgs.context ?? 0)
  const ctx0 = Number.isFinite(rawCtx) && rawCtx > 0 ? Math.min(3, Math.floor(rawCtx)) : 0
  if (ctx0 > 0) {
    const noCtx = await flow.call('memory_search', { ...baseArgs, context: 0 }, exec)
    const noCtxEst = estTokens(noCtx.text)
    if (noCtxEst <= budget) {
      return {
        main: noCtx,
        note: `按 ${budget} token 预算收紧了 1 次：context ${ctx0}→0（邻居先不铺开），实际 ≈${fmtTokens(noCtxEst)} token。`,
      }
    }
  }
  const rawK = Number(baseArgs.k ?? 10)
  const rawCm = Number(baseArgs.content_max ?? 300)
  const k0 = Number.isFinite(rawK) && rawK > 0 ? Math.floor(rawK) : 10
  // content_max=0 在 meow 侧是「全文」，不是「零个字」：这里给它一个够大的起点再往下砍。
  const cmLabel0 = rawCm === 0 ? '全文' : String(Number.isFinite(rawCm) && rawCm > 0 ? Math.floor(rawCm) : 300)
  let k = k0
  let cm = rawCm === 0 ? 2400 : Number.isFinite(rawCm) && rawCm > 0 ? Math.floor(rawCm) : 300
  let best = main
  let bestEst = first
  let tried = 0
  const take = async (args2) => {
    tried += 1
    const r = await flow.call('memory_search', args2, exec)
    return { r, est: estTokens(r.text) }
  }
  for (let i = 0; i < 4; i += 1) {
    if (cm > 60) cm = Math.max(60, Math.floor(cm / 2))
    else if (k > 1) k = Math.max(1, Math.floor(k / 2))
    else break
    const { r, est } = await take({ ...baseArgs, k, content_max: cm })
    if (est < bestEst) {
      best = r
      bestEst = est
    }
    if (est <= budget) {
      return {
        main: r,
        note: `按 ${budget} token 预算收紧了 ${tried} 次：k ${k0}→${k}、content_max ${cmLabel0}→${cm}，实际 ≈${fmtTokens(est)} token。`,
      }
    }
  }
  // [macro-fusion 0.2.109] 四级收紧还没装下，就把「能缩到的最小一份」真的拿一次。
  // 这里曾经靠猜：说「最小一次 ≈X、再小就只剩标题」，而那次 X 是第四级的估计值——
  // 也就是说，报「最小」的时候其实没试过最小。要么量到，要么不说。
  const { r: smallest, est: smallestEst } = await take({ ...baseArgs, k: 1, content_max: 60 })
  if (smallestEst <= budget) {
    return {
      main: smallest,
      note: `按 ${budget} token 预算收到了最小的一份：k ${k0}→1、content_max ${cmLabel0}→60，实际 ≈${fmtTokens(smallestEst)} token（再砍就只剩标题）。`,
    }
  }
  return {
    main: smallestEst < bestEst ? smallest : best,
    note: `预算 ${budget} token 装不下：最小一份（k=1、content_max=60）实测 ≈${fmtTokens(smallestEst)} token——再小就只剩标题，问不出东西；要么把预算提上去，要么换个更窄的 query。`,
  }
}

/**
 * [macro-fusion 0.2.110] 每条路径有它自己的旋钮。
 *
 * 0.2.109 只在本地这一路上落了预算，尾注老实写着「星图 / 相似两路不缩」——一句诚实的
 * 缺功能。可四路回执都是要进上下文的，凭什么只有一路能被约束。
 *
 * 旋钮名字各不相同（星图认 limit / hops，补邻居认 chars / limit，相似认 content_max / k），
 * 但收缩的道理是同一条：**先动「只是少看一点」的那个，再动「少给几条线索」的那个**。
 * 所以本地先砍字再砍条数、星图先砍条数再砍跳数、补邻居先砍字符预算再砍条数、
 * 相似先砍字再砍条数。min 用上游 schema 的下限，不自己发明地板。
 */
const PATH_KNOBS = {
  graph: [
    { key: 'limit', min: 1, def: 10 },
    { key: 'hops', min: 0, def: 2 },
  ],
  bridge: [
    { key: 'chars', min: 200, def: 900 },
    { key: 'limit', min: 1, def: 4 },
  ],
  similar: [
    { key: 'content_max', min: 60, def: 300 },
    { key: 'k', min: 1, def: 10 },
  ],
}

/**
 * [macro-fusion 0.2.110] 星图 / 补充 / 相似三路的预算：同一套「真重查、不截断」的循环。
 *
 * 和本地那一路（fitBudget）刻意不合并：本地那支的手感是 0.2.109 定的、有断言钉着，
 * 两套旋钮抽象成一套反而会把「先砍字再砍条数」这句容易犯错的话埋进通用代码里。
 * 代价是十几行重复，换来的是两条路各自说得清自己砍了什么。
 */
async function fitPath(flow, exec, { tool, baseArgs, main, budget, knobs, what }) {
  if (!budget || budget.value === null) return { main, note: '' }
  // 预算是 {value, note} 一份东西，不是数字：这里先摊成 cap，免得把对象直接拼进文案、
  // 也免得拿预算对象直接去比（那等于永远比不成立，一路滑到「装不下」）。
  const cap = Number(budget.value)
  if (!Number.isFinite(cap)) return { main, note: '' }
  const first = estTokens(main.text)
  const dials = knobs.map((kn) => {
    const raw = Number(baseArgs[kn.key])
    const from = Number.isFinite(raw) && raw >= kn.min ? Math.floor(raw) : kn.def
    return { ...kn, from, value: from }
  })
  // 只报真动过的旋钮：`hops 2→2` 这种「报了但没变」只会让读者以为它被砍了。
  const show = () => dials.filter((d) => d.value !== d.from).map((d) => `${d.key} ${d.from}→${d.value}`).join('、') || '没动到任何旋钮'
  const argsOf = () => {
    const a = { ...baseArgs }
    for (const d of dials) a[d.key] = d.value
    return a
  }
  if (first <= cap) {
    return { main, note: `${what}这一路按 ${cap} token 预算给：实际 ≈${fmtTokens(first)} token，没缩。` }
  }
  let best = main
  let bestEst = first
  let tried = 0
  for (let guard = 0; guard < 6; guard += 1) {
    const d = dials.find((x) => x.value > x.min)
    if (!d) break
    d.value = Math.max(d.min, Math.floor(d.value / 2))
    tried += 1
    const r = await flow.call(tool, argsOf(), exec)
    const est = estTokens(r.text)
    if (est < bestEst) {
      best = { text: r.text, value: r.value }
      bestEst = est
    }
    if (est <= cap) {
      return {
        main: { text: r.text, value: r.value },
        note: `${what}这一路按 ${cap} token 预算收紧了 ${tried} 次：${show()}，实际 ≈${fmtTokens(est)} token。`,
      }
    }
  }
  // 「最小」也要真量到：把所有旋钮压到下限再问一次，量出来才敢说「装不下」。
  for (const d of dials) d.value = d.min
  const smallest = await flow.call(tool, argsOf(), exec)
  const smallestEst = estTokens(smallest.text)
  const floorText = dials.map((d) => `${d.key}=${d.min}`).join('、')
  if (smallestEst <= cap) {
    return {
      main: { text: smallest.text, value: smallest.value },
      note: `${what}这一路收到了最小的一份：${show()}，实际 ≈${fmtTokens(smallestEst)} token（再砍就只剩标题）。`,
    }
  }
  return {
    main: smallestEst < bestEst ? { text: smallest.text, value: smallest.value } : best,
    note: `预算 ${cap} token 装不下：${what}这一路最小一份（${floorText}）实测 ≈${fmtTokens(smallestEst)} token——再小就只剩标题，问不出东西；要么把预算提上去，要么换个更窄的问法。`,
  }
}

/**
 * [macro-fusion 0.2.109] 星图那两路退回本地兜底时，预算同样要生效——
 * 兜底也是一次真检索，凭什么它就能超预算。tryCall 没拿到东西就原样放过。
 */
async function maybeFit(flow, exec, baseArgs, got, budget, flags) {
  if (!budget || budget.value === null) return got
  if (String(got.text ?? '').trim().length === 0) return got
  const fit = await fitBudget(flow, exec, baseArgs, { text: got.text, value: got.value }, budget.value)
  flags.budgetNote = fit.note
  return { ...got, text: fit.main.text, value: fit.main.value }
}

/**
 * [macro-fusion 0.2.109] 出口上的一段成本账：先说你给的条件怎么了（预算没被采纳 / 这次没东西可缩），
 * 再报这一回的量级。够小就不报——省 token 的工具自己先要省。
 *
 * [macro-fusion 0.2.110] 那句「预算只在本地生效」的尾注删了：四路都听预算了。
 * 留下的只剩真话——这一路没缩，是因为这条路上本来就没有可缩的东西。
 */
function costTail(body, { budget, flags }) {
  const parts = []
  if (budget.note !== '') parts.push(budget.note)
  if (flags.budgetNote) parts.push(flags.budgetNote)
  if (budget.value !== null && !flags.budgetNote) {
    parts.push(`budget ${budget.value} 这次没派上用场：这条路上没有可缩的东西（比如零命中、空图，或本来就没展开）。`)
  }
  const est = estTokens(body)
  if (budget.value !== null || est >= COST_SHOW_MIN) {
    const hint =
      budget.value === null && est >= COST_HINT_MIN
        ? '；只想看骨架就加 budget=400（工具会自己砍条数、砍字数，并交代砍了什么）'
        : ''
    parts.push(`${costSentence(body)}${hint}`)
  }
  return parts.length > 0 ? `${body}\n\n${parts.join(' ')}` : body
}

async function runSearch(flow, args, exec, flags = {}, budget = { value: null, note: '' }, mqConfig = {}, shorten = null) {
  const mode = modeOf(args).name
  const query = typeof args.query === 'string' ? args.query : ''

  await flow.flushLinks(exec)

  if (mode === 'graph' || mode === 'bridge') {
    const tool = mode === 'graph' ? 'nebula_recall' : 'nebula_bridge'
    const payload =
      mode === 'graph'
        ? pick(args, ['query', 'memory_ids', 'limit', 'hops', 'entity', 'dynamic_hops'])
        : pick(args, ['query', 'memory_ids', 'limit', 'chars', 'min_weight', 'hops'])
    const r = await flow.tryCall(tool, payload, exec, mode === 'graph' ? '星图检索' : '星图补充')
    if (r.entry) {
      // 0.2.39：空命中也背两个意思——「图里真没有」和「图还没建完」。
      // 后者这一问等于没算，绝不能原样转述成「没有匹配」，那等于替用户确认了一件没算的事。
      if (recallAnswerKind(r.text) === 'emptyGraph') {
        const what = mode === 'graph' ? '沿关联扩散' : '补充邻居'
        if (query.trim().length === 0) {
          // [macro-fusion 0.2.66] 星图在、但空图 + 没 query：连本地兜底都没做。
          // 尾注得说「这一问没算」，而不是替它报「星图里就这么几条」。
          flags.graphAbsentNoLocal = true
          return `星图现在还是空的（还没建完，约 12s 一轮巡检），${what}这一问等于没算——给个 query 我就能先用本地检索兜住；记忆本身没受影响。`
        }
        const fallbackArgs = pick(args, ['query', 'level', 'project', 'status', 'days', 'k', 'content_max', 'context', 'explain', 'min_rel', 'dedupe', 'band_keep'])
        let local = await flow.tryCall('memory_search', fallbackArgs, exec, '本地检索')
        local = await maybeFit(flow, exec, fallbackArgs, local, budget, flags)
        flags.graphFellBack = true
        return `星图现在还是空的（还没建完，约 12s 一轮巡检），${what}这次没算——这不是「没有这条记忆」的答案。先给本地结果：\n\n${local.text}`
      }
      // [macro-fusion 0.2.110] 星图这一路的回执同样进上下文：给了预算就按它自己的旋钮收紧。
      const fitted = await fitPath(flow, exec, {
        tool,
        baseArgs: payload,
        main: { text: r.text, value: r.value },
        budget,
        knobs: PATH_KNOBS[mode],
        what: MODE_LABELS[mode],
      })
      if (fitted.note !== '') flags.budgetNote = fitted.note
      return fitted.main.text
    }
    // 星图缺席（没装配 / 被配置关掉 / 引擎还没起）：以 meow 为主，记忆照样要查得到。
    // 这里不能把「这项能力还没就绪」原样甩给模型——它刚被告知用 mode=graph，报错等于教它别信工具面。
    if (query.trim().length === 0) {
      flags.graphAbsentNoLocal = true
      return `星图这次没接上，而 ${mode === 'graph' ? '沿关联扩散' : '补充邻居'}只走星图；给个 query 我就能先用本地检索兜住。`
    }
    const localArgs = pick(args, ['query', 'level', 'project', 'status', 'days', 'k', 'content_max', 'context', 'explain', 'min_rel', 'dedupe', 'band_keep'])
    let main = await flow.tryCall('memory_search', localArgs, exec, '本地检索')
    main = await maybeFit(flow, exec, localArgs, main, budget, flags)
    flags.graphFellBack = true
    const head =
      mode === 'graph'
        ? '星图这次没接上，先只给本地检索结果（沿关联扩散等星图就绪后再试）：'
        : '星图这次没接上，先只给本地检索结果（补充邻居等星图就绪后再试）：'
    return `${head}\n\n${main.text}`
  }
  if (mode === 'similar') {
    if (typeof args.id !== 'string' || args.id.length === 0) {
      throw new Error('memory_search：mode=similar 需要 id（基准记忆 id）。')
    }
    const r = await flow.tryCall('memory_find_similar', pick(args, ['id', 'k', 'content_max']), exec, '相似检索')
    const said = String(r.text ?? '')
    // 0.2.46：meow 老的 render 在「一条都没有」时返回空数组，这里就只剩 `{"hits": []}`——
    // 一句解释都没有，读者分不清「没有相似」和「没比」。子插件补丁在位时这句兜底不会被用到，
    // 它守的是「上游把补丁冲掉」这一种情况；说的是「没算成」，不替它下「没有相似」的结论。
    if (said.trim() === '' || /^\s*\{\s*"hits"\s*:\s*\[\s*\]\s*\}\s*$/.test(said)) {
      // [macro-fusion 0.2.90] 末句原来写「或等下一次会话」——那是 0.2.88 及以前的行为（候选按会话整批排除）。
      // 0.2.89 起本会话新写的条目也算候选，「等下一次会话」就成了过期的劝告，会把读者指向一个假原因。
      return (
        '相似检索这次没给出任何内容：可能是这条记忆拆不出可比的词、库里就只有这一条，' +
        '或者这一轮已经端给你看过的都排除了、剩下的 k 又太小——这不是「记忆里没有相似的东西」。' +
        '换一条基准、把 k 给大一点再问。'
      )
    }
    // [macro-fusion 0.2.110] 相似这一路也是进上下文的回执，预算同样要落。
    const fitted = await fitPath(flow, exec, {
      tool: 'memory_find_similar',
      baseArgs: pick(args, ['id', 'k', 'content_max']),
      main: { text: said, value: r.value },
      budget,
      knobs: PATH_KNOBS.similar,
      what: MODE_LABELS.similar,
    })
    if (fitted.note !== '') flags.budgetNote = fitted.note
    return fitted.main.text
  }

  const localArgs = pick(args, ['query', 'level', 'project', 'status', 'days', 'k', 'content_max', 'context', 'explain', 'min_rel', 'dedupe', 'band_keep'])
  // 原 memory_search 的 query 是必填。统一工具因为要兼 mode=similar/graph 没法在 schema 里写死，
  // 就在这里把「本地检索必须给 query」守回来——否则会静默返回空结果，比报错更难查。
  if (query.trim().length === 0) {
    throw new Error('memory_search：本地检索需要 query；只想沿星图扩散请用 mode="graph"，想找相似条目请用 mode="similar" + id。')
  }
  let main = await flow.call('memory_search', localArgs, exec)
  // [macro-fusion 0.2.51] 上游一个字都不给时，空字符串会被读成「一条都没有」。
  // 同 0.2.49 / 0.2.50：没有回执不等于没有结果，这里把「没说话」和「没东西」分开。
  if (String(main.text ?? '').trim().length === 0) {
    return (
      '检索这次没有任何回执（既没有条目，也没说为什么没有）——这不是「记忆里没有这条」：' +
      '换个关键词再查一次，或先用 memory_project 看一眼这个项目里到底有什么。'
    )
  }
  // [macro-fusion 0.2.109] 预算在这里落：先按你给的条件拿一遍，超了再逐级收紧——
  // 顺序上必须排在 expand 之前，否则星图扩散那一段会加在「已经超预算」的本地结果后面。
  if (budget.value !== null) {
    const fit = await fitBudget(flow, exec, localArgs, main, budget.value)
    main = fit.main
    flags.budgetNote = fit.note
  }
  // [macro-memory 0.4.0 P1] 查询分解：排在预算收紧之后、扩散之前——
  // 收紧那一步会拿 localArgs 重查一次（补充段会被重查冲掉），而扩散要用合并后的 value.hits。
  if (multiQueryMode(mqConfig) !== 'off') {
    main = await augmentByDecompose({ flow, exec, main, localArgs, query, flags, budget, shorten })
  }
  const hits = Array.isArray(main.value?.hits) ? main.value.hits.length : 0
  // [macro-fusion 0.2.133] 主人 2026-11-21 明令：默认关闭的有用能力要全开，不要急着省 token。
  // 以前要 expand=true 或本地零命中才扩散——可星图那一路提供的是「跨会话、跨项目才看得见」的线索，
  // 本地命中越多反而越用不上它，等于把最有用的一半藏起来。现在默认扩散，只有显式 expand:false 才关。
  const wantExpand = args.expand !== false
  if (!wantExpand) return main.text
  if (query.length === 0 && !Array.isArray(args.memory_ids)) return main.text

  // [macro-fusion 0.2.65] 这次扩散真的读了 limit / hops，把用上的值记下来——
  // 尾注据此说实话（老写法在这里用上了参数，尾注却声明「没用上」）。
  // 三种状态要分开：真的扩散了 / 本要扩散但星图没接上 / 根本没走到扩散。
  const spreadLimit = args.limit ?? 5
  const spreadHops = args.hops ?? 2
  flags.spreadLimit = spreadLimit
  flags.spreadHops = spreadHops
  flags.spreadTried = true
  const spread = await flow.tryCall(
    'nebula_recall',
    { query, memory_ids: args.memory_ids, limit: spreadLimit, hops: spreadHops },
    exec,
    '星图扩散',
  )
  if (spread.entry) flags.spread = true
  // 本地检索是主语，扩散只是加料。加不上就说一句「没加」，绝不把 tryCall 的失败文案
  // （`星图扩散未完成：macro-memory：这项能力还没就绪…`）拼进一个本来成功的结果里
  if (!spread.entry) return `${main.text}\n\n（星图这次没接上，关联扩散没做——先把本地结果给你。）`
  // 空图时的「没有匹配」不是佐证，是没算：不说明的话，本地零命中 + 星图零命中
  // 读起来像「两边都确认没有这条记忆」，而其实星图那边一次都没算。
  if (recallAnswerKind(spread.text) === 'emptyGraph') {
    return `${main.text}\n\n（星图现在还是空的（还没建完），关联扩散这次没算——上面的本地结果就是全部，这不是「确认没有」，过几分钟再搜一次。）`
  }
  // [macro-fusion 0.2.118] 两路都算出来了 → 先试着合成一张榜。
  // 老做法是把两段文本上下拼在一起：同一堆记忆在两段里各出现一次（第二遍白花 token），
  // 而「两条路都命中」这件事本身是最强的相关性证据，却没有任何人替读者指出来。
  // 融合只按**名次**合（RRF），因为两路的分数不同源，拿分数线不同的两组数比大小是在编结论。
  const fusedHead = await fusedPart({ localValue: main.value, graphText: spread.text, spreadLimit, budget, flags, shorten })
  if (fusedHead !== null) return fusedHead
  // [macro-fusion 0.2.110] 扩散这一段也在同一份回执里，预算到这儿还没花完——
  // 那就按**剩余**预算去要它：整份回执的总量才是读者的成本，分段各算一遍等于自欺。
  if (budget.value !== null) {
    const used = estTokens(main.text)
    const remain = budget.value - used
    if (remain < BUDGET_MIN) {
      const said = `budget ${budget.value} token 已经被本地结果用掉（≈${fmtTokens(used)} token），星图扩散这一段按剩余预算拿不出来：要扩散就用 expand=false 关掉它，或者把预算提上去。`
      flags.budgetNote = flags.budgetNote ? `${flags.budgetNote} ${said}` : said
      return main.text
    }
    const spreadFit = await fitPath(flow, exec, {
      tool: 'nebula_recall',
      baseArgs: { query, memory_ids: args.memory_ids, limit: spreadLimit, hops: spreadHops },
      main: { text: spread.text, value: spread.value },
      budget: { value: remain },
      knobs: PATH_KNOBS.graph,
      what: MODE_LABELS.graph,
    })
    if (spreadFit.note !== '') {
      const said = `（星图扩散按剩余 ${remain} token 预算算：${spreadFit.note}）`
      flags.budgetNote = flags.budgetNote ? `${flags.budgetNote} ${said}` : said
    }
    return `${main.text}\n\n— 星图关联扩散 —\n${spreadFit.main.text}`
  }
  return `${main.text}\n\n— 星图关联扩散 —\n${spread.text}`
}

/**
 * [macro-fusion 0.2.118] 两路合一张榜；合不了就返回 null，让调用方走原来的两段式。
 *
 * 什么时候「合不了」：本地一条没命中（那就没有榜，只有星图的关联线索，两段式更好读）、
 * 星图回执解析不出节点（形状变了 / 补丁被冲掉）、或者预算紧到连本地那部分都装不下——
 * 这三种都退回老路径，而不是硬凑一张半张的榜。
 *
 * 融合省下的是 token：同一堆记忆不再出现两遍，星图独有的只带「为什么相关」+ 摘要，
 * 不带全文（全文在本地命中里已经有了）。多出来的是那句「两路都命中 N 条」——
 * 两条互不相干的检索方式同时捞到同一条，是这条记忆与当前处境相关的**最硬**的证据。
 */
async function fusedPart({ localValue, graphText, spreadLimit, budget, flags, shorten = null }) {
  const localHits = Array.isArray(localValue?.hits) ? localValue.hits : []
  const nodes = graphNodesOf(graphText)
  if (localHits.length === 0 || nodes.length === 0) return null
  const fused = fuseRanked({ localHits, graphNodes: nodes })
  if (fused.rows.length === 0) return null

  const asked = Number(spreadLimit)
  const graphCap = Number.isFinite(asked) ? Math.max(0, asked) : 5
  const noteHead = String(localValue?.note ?? '').trim()
  const rankNote =
    fused.both > 0
      ? `融合榜（本地 # / 星图 # 两路按名次合并，RRF k=${RRF_K}）：两路都命中 ${fused.both} 条、本地独有 ${fused.localOnly} 条、星图独有 ${fused.graphOnly} 条——重复的条目只出现一次，两路都命中的排在最前。`
      : `融合榜（本地 # / 星图 # 两路按名次合并，RRF k=${RRF_K}）：这次两路没有重叠（本地 ${localHits.length} 条、星图 ${nodes.length} 条），按名次排在一起。`
  const head = [rankNote, noteHead].filter((x) => x !== '').join('\n')
  const build = (shown) =>
    fusedText({
      note: head,
      rows: fused.rows,
      k: localHits.length,
      graphShown: shown,
      shorten: typeof shorten === 'function' ? shorten : undefined,
      dropped: Math.max(0, fused.graphOnly - shown),
    })

  let graphShown = Math.min(graphCap, fused.graphOnly)
  let text = build(graphShown)
  if (budget.value !== null && estTokens(text) > budget.value) {
    // 先砍星图的独有条目：它们只是「为什么相关」的线索，本地命中的全文是答案本身。
    let shown = graphShown
    while (shown > 0 && estTokens(build(shown)) > budget.value) shown -= 1
    if (estTokens(build(shown)) > budget.value) return null
    const said = `（融合榜按 ${budget.value} token 预算收紧：星图独有的条目从 ${graphShown} 条压到 ${shown} 条。）`
    flags.budgetNote = flags.budgetNote ? `${flags.budgetNote} ${said}` : said
    graphShown = shown
    text = build(shown)
  }
  flags.fused = true
  flags.fusedBoth = fused.both
  return text
}

/**
 * [macro-memory 0.4.0 P1] 查询分解：一句话里塞了两件事时，本地检索按整句算一次 BM25，
 * 两边的词互相稀释，可能双双掉出榜——multi-hop 是四类题里最低的一类（0.5887，2026-11-20）。
 *
 * 这一层只做「补空位」，和「重排」一点关系都没有：
 *   · 原榜的条目、名次、正文一个字不动；
 *   · 并列焦点拆成子问句各查一次，只把原榜没给出的条目追加在末尾一段；
 *   · 每条都标明是哪一问捞到的，读者自己判断要不要读全文；
 *   · 一条都没补到就什么都不追加（连标题都不出现）——误切的代价只是多一次本地检索。
 *
 * 纯规则、不调模型：切错也是可复现、可复算的切错。
 */
const MQ_MAX_SUBS = 3
const MQ_MAX_ROWS_PER_SUB = 2
const MQ_ROW_CHARS = 110
const MQ_MAX_CONSENSUS = 3
/** 连接词：长的在前，否则「以及」会先被「与/和」切成半截。 */
const MQ_JOINERS = ['以及', '还有', '和', '跟', '与', '、']
/** 标点/空白一律不算信息量：`A 和 B` 能不能切，取决于两侧有没有真字符，而不是汉字数。 */
const MQ_PUNCT = /[\s，,。？?！!、；;：:“”"'‘’（）()《》〈〉【】\[\]…—－-]/g
/** 子问句开头的疑问词：剥掉之后剩下的才是真正的焦点（剥完不足两个字就整段丢弃）。 */
const MQ_ASK_PREFIX = /^(?:为什么|为何|怎么|怎样|如何|什么|啥|是不是|有没有|能不能|可不可以|哪些|哪个|多少|是否|请问|我想问|那么|那|然后|所以|另外|顺便)/
/** 子问句结尾的虚词与套话：`B 有什么区别` → `B`，`A 呢` → `A`。 */
const MQ_ASK_SUFFIX = /(?:有什么区别|有区别吗|之间的区别|之间|分别是什么|是什么|分别|呢|吗|吧|啊|呀|了|的)$/

/** [macro-memory 0.4.0 P1] 开关只认 off / conservative；写别的（含大小写错的）一律 off。 */
export function multiQueryMode(config) {
  const raw = config?.multiQuery
  const text = typeof raw === 'string' ? raw.trim().toLowerCase() : ''
  return text === 'conservative' ? 'conservative' : 'off'
}

/** 信息量 = 去掉标点空白后的字符数（汉字、字母、数字都算）。 */
function infoLen(text) {
  return String(text ?? '').replace(MQ_PUNCT, '').length
}

/** 只取第一个「两侧都够长」的连接词切一刀。顿号是硬并列，单字也认（`A、B`）。 */
function cutOnce(text, joiner) {
  const min = joiner === '、' ? 1 : 2
  let at = text.indexOf(joiner)
  while (at > 0) {
    const left = text.slice(0, at).trim()
    const right = text.slice(at + joiner.length).trim()
    if (infoLen(left) >= min && infoLen(right) >= min) return [left, right]
    at = text.indexOf(joiner, at + joiner.length)
  }
  return null
}

/** 贪心多刀：每个连接词过一遍，切够段数就停（`A、B 和 C` → 三段），最后截到上限。 */
function splitByJoiners(text) {
  let parts = [text]
  for (const joiner of MQ_JOINERS) {
    const next = []
    for (const part of parts) {
      const cut = cutOnce(part, joiner)
      if (cut !== null) next.push(...cut)
      else next.push(part)
    }
    parts = next
    if (parts.length >= MQ_MAX_SUBS) break
  }
  return parts.slice(0, MQ_MAX_SUBS)
}

function cleanPiece(piece) {
  let text = String(piece ?? '')
    .replace(/^[\s，,。？?！!、；;：:“”"'（）()]+|[\s，,。？?！!、；;：:“”"'（）()]+$/g, '')
    .trim()
  text = text.replace(MQ_ASK_PREFIX, '').trim()
  text = text.replace(MQ_ASK_SUFFIX, '').trim()
  // 比较句的尾巴：`反式脂肪哪个更伤心脏` → `反式脂肪`（实体是重点，比较的是问句的壳）。
  text = text.replace(/(?:哪个|哪一个|谁)(?:更|最)[\u4e00-\u9fff]{0,6}$/, '').trim()
  return infoLen(text) >= 2 ? text : null
}

/**
 * 拆出子问句。返回 [] 表示「这句话没有并列焦点」——不猜、不硬拆。
 *
 * 两种切法，按可靠程度排：
 *   1) 多个问号：`A？B？` 天然就是两问，不需要任何句法判断；
 *   2) 连接词：`以及 / 还有 / 和 / 跟 / 与 / 、`，两侧都要有 ≥2 个真字符，
 *      最多切到 3 段（再多就是在猜句子结构了）。
 */
export function decomposeQuery(query) {
  const text = String(query ?? '').trim()
  if (infoLen(text) < 4) return []
  const byAsk = text
    .split(/[？?]+/)
    .map((one) => cleanPiece(one))
    .filter((one) => one !== null)
  if (byAsk.length >= 2 && byAsk.length <= MQ_MAX_SUBS) {
    return byAsk.filter((one) => one !== text).slice(0, MQ_MAX_SUBS)
  }
  const subs = splitByJoiners(text)
    .map((one) => cleanPiece(one))
    .filter((one) => one !== null && one !== text)
  return subs.length >= 2 ? subs.slice(0, MQ_MAX_SUBS) : []
}

/**
 * [0.6.67] 这个工作区的「最短唯一前缀」读取口。拿不到工作区/库时返回 null——
 * 调用方据此退回 8 位（老行为），绝不让回执因为这一步报错。
 * 为什么要它：0.6.64 起命中注入、邻域、项目目录都印最短唯一前缀，只有检索回执
 * （融合榜与子问句补充段）还在印 8 位/36 字全 id；真库 1,121 条里 8 位前缀撞 13 组，
 * 撞车的短 id 拿去 read / update / mute 会因歧义被拒，读起来像「那条记忆不见了」。
 */
function shortenerOf(exec, meowDir) {
  try {
    const workspace = workspaceOfExec(exec)
    if (workspace === '') return null
    const dir = typeof meowDir === 'function' ? meowDir() : '.dsh-meow'
    const index = shortIdsOf(Meow.getDb(workspace, dir))
    return (id) => shortenId(index, id)
  } catch {
    return null
  }
}

function id8(id) {
  const text = String(id ?? '')
  return text.length > 8 ? text.slice(0, 8) : text
}

function clipBody(text) {
  const one = String(text ?? '').replace(/\s+/g, ' ').trim()
  return one.length > MQ_ROW_CHARS ? `${one.slice(0, MQ_ROW_CHARS)}…` : one
}

/** 补充段的正文：先说「原榜没动」，再逐条标明哪一问捞到的，最后是两问共识。 */
function supplementText(rows, subs, consensus = [], shorten = null) {
  const show = typeof shorten === 'function' ? shorten : id8
  const head =
    `— 问句拆开再查一遍（原榜一个字没动）—\n` +
    `这句话有多个焦点，拆成「${subs.join('」「')}」各查了一次（子问句放宽了档位收口，才捞得到原榜压掉的条目）；下面这些原榜没给出：`
  const lines = rows.map((one) => {
    const hit = one.hit ?? {}
    const level = hit.level ?? 'memory'
    const body = String(hit.title ?? '').trim() !== '' ? hit.title : clipBody(hit.content)
    return `- 「${one.sub}」[${level}] ${show(hit.id)} · ${clipBody(body)}`
  })
  const tail = []
  if (consensus.length > 0) {
    tail.push(`- 多个子问句都命中、原榜里也有的：${consensus.map(show).join(', ')}（上面已列，这是它们真的相关的硬证据）`)
  }
  tail.push('（只截前一句；读全文用 memory_read(id)。）')
  return [head, ...lines, ...tail].join('\n')
}

/**
 * 拿原榜没给出的条目补在末尾。失败一律当「没补」（不把异常拼进一份本来成功的回执）。
 * 返回新的 main；没补到东西时返回原 main（引用不变，调用方据此判断）。
 */
async function augmentByDecompose({ flow, exec, main, localArgs, query, flags, budget, shorten = null }) {
  const subs = decomposeQuery(query)
  if (subs.length === 0) return main
  const baseHits = Array.isArray(main.value?.hits) ? main.value.hits : []
  const order = baseHits.map((hit) => String(hit?.id ?? '')).filter((one) => one !== '')
  const seen = new Set(order)
  const consensus = new Set()
  const rows = []
  for (const sub of subs) {
    let got = null
    try {
      got = await flow.call(
        'memory_search',
        // [macro-memory 0.4.0 P1] 子问句**放宽档位收口**：原榜的 min_rel / band_keep 会把
        // 「分数低一档但其实对」的条目整段收掉，而子问句只需要「这一问里它在不在前排」。
        // 放宽的代价由下面「每问最多两行 + score>0」两道闸门兜住。
        { ...localArgs, query: sub, k: MQ_MAX_ROWS_PER_SUB + 2, content_max: MQ_ROW_CHARS, min_rel: 0, band_keep: false },
        exec,
      )
    } catch {
      continue
    }
    const hits = Array.isArray(got?.value?.hits) ? got.value.hits : []
    let added = 0
    for (const hit of hits) {
      const id = String(hit?.id ?? '')
      if (id === '') continue
      const score = Number(hit?.score)
      if (Number.isFinite(score) && score <= 0) continue
      if (seen.has(id)) {
        // 子问句命中了原榜里已有的条目：不是新东西，但这是「它真的相关」的硬证据（和融合层 fused.both 同一套道理）。
        consensus.add(id)
        continue
      }
      seen.add(id)
      rows.push({ sub, hit })
      added += 1
      if (added >= MQ_MAX_ROWS_PER_SUB) break
    }
  }
  const agree = order.filter((id) => consensus.has(id)).slice(0, MQ_MAX_CONSENSUS)
  if (rows.length === 0 && agree.length === 0) return main

  let shown = rows
  let text = supplementText(shown, subs, agree, shorten)
  if (budget.value !== null) {
    const base = estTokens(main.text)
    while (shown.length > 1 && base + estTokens(text) > budget.value) {
      shown = shown.slice(0, shown.length - 1)
      text = supplementText(shown, subs, agree, shorten)
    }
    if (base + estTokens(text) > budget.value) {
      flags.multiQuerySkipped = true
      return main
    }
  }
  flags.multiQuery = subs.join(' | ')
  flags.multiQueryRows = shown.length
  flags.multiQueryAgree = agree.length
  return {
    ...main,
    text: `${main.text}\n\n${text}`,
    value:
      main.value !== null && typeof main.value === 'object'
        ? { ...main.value, hits: [...baseHits, ...shown.map((one) => one.hit)] }
        : main.value,
  }
}

export function createSearch({ flow, config = {}, meowDir = () => '.dsh-meow' }) {
  return {
    name: 'memory_search',
    description:
      '查宏记忆。默认本地检索（关键词×重要度×时间衰减）；默认沿星图扩散，expand:false 关；mode=graph 只在星图里按关联扩散；mode=bridge 找强相关未读邻居；mode=similar 找与某条记忆相似的条目。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string', description: '检索词/句子（similar 模式可省）。' },
        mode: { type: 'string', enum: ['local', 'graph', 'bridge', 'similar'], description: '检索模式，默认 local。' },
        id: { type: 'string', description: 'mode=similar 时的基准记忆 id。' },
        memory_ids: { type: 'array', items: { type: 'string' }, description: '已知记忆 id（graph/bridge 用；会沿关联扩散）。' },
        expand: { type: 'boolean', description: '是否追加星图扩散；默认扩散，expand:false 关。' },
        level: { type: 'string', description: '限定层级，逗号多选：fact,lesson,topic,rules,project,soul,user（默认 fact,lesson,topic,rules,user；soul 与 project 不默认，要查请显式传）。' },
        project: { type: 'string', description: '按项目名过滤（逗号多选）。' },
        status: { type: 'string', description: '按状态过滤：active/archived/stale/all。' },
        days: { type: 'integer', description: '只看最近 N 天创建的条目。' },
        k: { type: 'integer', description: '返回条数上限（默认 10，1–50）。' },
        content_max: { type: 'integer', description: '每条内容截断长度（默认 300，0=全文）。' },
        // [macro-fusion 0.2.124] 命中常常只是「一句话」，答案在前一句或后一句里：给每条命中
        // 带上同层前后各 N 条（meow 0.2.123 的 adjacentWindows）。默认 0——一个字节都不多花。
        // [macro-fusion 0.2.127] 说清「什么时候值得开」：LoCoMo 1,193 题同题对照 +8.0 个百分点，
        // 开 1 时回执 1.4k→3.5k 字符。多跳/时间题不给这几行的代价，比多花 300 token 大得多。
        context: { type: 'integer', description: '相邻上下文：给每条命中带同层前后各 N 条（1–3，默认 0=不带）。问「什么时候」「谁先谁后」「之前/之后」，或一条命中说不清、要串两条线索时开 1–2：LoCoMo 1,193 题实测 +8.0 个百分点（26.9%→34.9%），回执 1.4k→3.5k 字符。一次最多铺 24 行，铺不下会说明剩下的用 memory_read 读。' },
        budget: {
          type: 'integer',
          description:
            `回执的 token 预算（最少 ${BUDGET_MIN}，最多 20000）。四条路都听：本地先砍每条的字、再砍条数；星图先砍条数、再砍跳数；补邻居先砍字符预算、再砍条数；相似先砍字、再砍条数。砍了什么写进尾注，装不下会说最小能给多少。不给则只报成本。`,
        },
        min_rel: { type: 'number', description: '相关度下限（0–1，默认 0.30）：只展开分数不低于榜首这个比例的条目，更弱的尾巴收掉并在尾注里报出；传 0 = 看全量。' },
        dedupe: { type: 'boolean', description: '同类折叠（默认开）：内容几乎一样（逐字级重复）的条目只列一条，折了几条写进尾注；传 false = 每条都列。' },
        band_keep: { type: 'boolean', description: '按置信档收口（默认开）：只给和榜首同一量级的命中，回执短于 k 时尾注会说明并给出出口；传 false = 连低分候选一起展开。' },
        explain: { type: 'boolean', description: '附带分项得分，排查「为什么召回它」。' },
        limit: { type: 'integer', description: 'graph/bridge 模式返回条数（默认 10 / 4）。' },
        hops: { type: 'integer', description: 'graph/bridge 扩散跳数。' },
    entity: { type: 'boolean', description: 'graph 是否按实体带邻居（默认开）。' },
    dynamic_hops: { type: 'boolean', description: 'graph 第二跳是否按词面收（默认开）。' },
        chars: { type: 'integer', description: 'bridge 模式文本预算（字符）。' },
        min_weight: { type: 'number', description: 'bridge 模式最低关联权重。' },
      },
    },
    output: TEXT_OUT,
    // [macro-fusion 0.2.58] 模式名先过白名单（不合法就一句都不查），再把「参数给错模式」的
    // 尾注统一贴在出口上——原来十个 return 各说各的，没有一个会说「你这个参数根本没用上」。
    async execute(args, exec) {
    // [0.6.67] 一次调用建一次短 id 索引：回执里所有 id 都走同一个口径。
    const shorten = shortenerOf(exec, meowDir)
      const mode = modeOf(args)
      if (mode.bad) return badModeText(mode)
      // [macro-fusion 0.2.65] flags 让 runSearch 把「这次到底用没用上 limit / hops」告诉尾注，
      // 而不是让尾注自己猜（猜的那一版对 local 自动扩散说了反话）。
      const flags = {}
      // [macro-fusion 0.2.109] 预算在出口解析一次、传到底：四处 return 各自解析会写出四种口径。
      const budget = budgetOf(args.budget)
      const text = await runSearch(flow, args, exec, flags, budget, config, shorten)
      const notes = modeNotes(mode.name, args, flags)
      const body = notes.length > 0 ? `${text}\n\n${notes.join('\n')}` : text
      return costTail(body, { budget, flags })
    },
    presentCall(args) {
      // [macro-fusion 0.2.60] 卡片标题不贴参数键：`检索记忆：graph` 是给机器看的。
      const mode = modeOf(args)
      const name = mode.bad ? '模式名没对上' : MODE_LABELS[mode.name]
      const q = typeof args.query === 'string' ? args.query.trim() : ''
      return { card: 'generic', title: cardTitle('检索记忆', q === '' ? name : `${name} · ${q}`), kind: 'read' }
    },
  }
}
