import { TEXT_OUT, pick } from '../shared.js'
import { recallAnswerKind } from '../contract.js'
import { cardTitle } from '../panel.js'
// [macro-fusion 0.2.109] 回执成本与预算：口径全在 tokencost.js（估算不是计量，够大才报）。
import { BUDGET_MIN, COST_HINT_MIN, COST_SHOW_MIN, budgetOf, costSentence, estTokens, fmtTokens } from '../tokencost.js'

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
const LOCAL_ONLY_PARAMS = ['level', 'project', 'status', 'days', 'content_max', 'explain']

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

async function runSearch(flow, args, exec, flags = {}, budget = { value: null, note: '' }) {
  const mode = modeOf(args).name
  const query = typeof args.query === 'string' ? args.query : ''

  await flow.flushLinks(exec)

  if (mode === 'graph' || mode === 'bridge') {
    const tool = mode === 'graph' ? 'nebula_recall' : 'nebula_bridge'
    const payload =
      mode === 'graph'
        ? pick(args, ['query', 'memory_ids', 'limit', 'hops'])
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
        const fallbackArgs = pick(args, ['query', 'level', 'project', 'status', 'days', 'k', 'content_max', 'explain', 'min_rel', 'dedupe'])
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
    const localArgs = pick(args, ['query', 'level', 'project', 'status', 'days', 'k', 'content_max', 'explain', 'min_rel', 'dedupe'])
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

  const localArgs = pick(args, ['query', 'level', 'project', 'status', 'days', 'k', 'content_max', 'explain', 'min_rel', 'dedupe'])
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
  const hits = Array.isArray(main.value?.hits) ? main.value.hits.length : 0
  const wantExpand = args.expand === true || (args.expand !== false && hits === 0)
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

export function createSearch({ flow }) {
  return {
    name: 'memory_search',
    description:
      '查宏记忆。默认本地检索（关键词×重要度×时间衰减）；expand=true 顺带沿星图扩散；mode=graph 只在星图里按关联扩散；mode=bridge 找强相关但还没读过的邻居；mode=similar 找与某条记忆相似的条目。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string', description: '检索词/句子（similar 模式可省）。' },
        mode: { type: 'string', enum: ['local', 'graph', 'bridge', 'similar'], description: '检索模式，默认 local。' },
        id: { type: 'string', description: 'mode=similar 时的基准记忆 id。' },
        memory_ids: { type: 'array', items: { type: 'string' }, description: '已知记忆 id（graph/bridge 用；会沿关联扩散）。' },
        expand: { type: 'boolean', description: 'local 模式是否追加一次星图扩散；不填时零命中会自动扩散。' },
        level: { type: 'string', description: '限定层级，逗号多选：fact,lesson,topic,rules,project,soul,user。' },
        project: { type: 'string', description: '按项目名过滤（逗号多选）。' },
        status: { type: 'string', description: '按状态过滤：active/archived/stale/all。' },
        days: { type: 'integer', description: '只看最近 N 天创建的条目。' },
        k: { type: 'integer', description: '返回条数上限（默认 10，1–50）。' },
        content_max: { type: 'integer', description: '每条内容截断长度（默认 300，0=全文）。' },
        budget: {
          type: 'integer',
          description:
            `回执的 token 预算（最少 ${BUDGET_MIN}，最多 20000）。四条路都听：本地先砍每条的字、再砍条数；星图先砍条数、再砍跳数；补邻居先砍字符预算、再砍条数；相似先砍字、再砍条数。砍了什么写进尾注，装不下会说最小能给多少。不给则只报成本。`,
        },
        min_rel: { type: 'number', description: '相关度下限（0–1，默认 0.35）：只展开分数不低于榜首这个比例的条目，更弱的尾巴收掉并在尾注里报出；传 0 = 看全量。' },
        dedupe: { type: 'boolean', description: '同类折叠（默认开）：内容几乎一样（逐字级重复）的条目只列一条，折了几条写进尾注；传 false = 每条都列。' },
        explain: { type: 'boolean', description: '附带分项得分，排查「为什么召回它」。' },
        limit: { type: 'integer', description: 'graph/bridge 模式返回条数（默认 10 / 4）。' },
        hops: { type: 'integer', description: 'graph/bridge 扩散跳数。' },
        chars: { type: 'integer', description: 'bridge 模式文本预算（字符）。' },
        min_weight: { type: 'number', description: 'bridge 模式最低关联权重。' },
      },
    },
    output: TEXT_OUT,
    // [macro-fusion 0.2.58] 模式名先过白名单（不合法就一句都不查），再把「参数给错模式」的
    // 尾注统一贴在出口上——原来十个 return 各说各的，没有一个会说「你这个参数根本没用上」。
    async execute(args, exec) {
      const mode = modeOf(args)
      if (mode.bad) return badModeText(mode)
      // [macro-fusion 0.2.65] flags 让 runSearch 把「这次到底用没用上 limit / hops」告诉尾注，
      // 而不是让尾注自己猜（猜的那一版对 local 自动扩散说了反话）。
      const flags = {}
      // [macro-fusion 0.2.109] 预算在出口解析一次、传到底：四处 return 各自解析会写出四种口径。
      const budget = budgetOf(args.budget)
      const text = await runSearch(flow, args, exec, flags, budget)
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
