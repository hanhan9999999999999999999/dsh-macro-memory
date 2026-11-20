/**
 * 整理留痕面板（0.2.97）：`memory_admin(action="dream")` 的正文从这里出。
 *
 * 为什么要有这个面板：dream 在 0.2.96 起会把自己这一轮看到什么、点出几对、缺几个词
 * 写进 `dream_log`（summary 一行 + `changes.plan` 一份结构），但**只有写、没有读**——
 * 账本躺在 sqlite 里，主人在面板上看不到。一个只有写口没有读口的账本，
 * 等于把「可追溯」做成了「看我写过」。
 *
 * 三条规矩：
 *  1. 面板只念账本，不自己算：数字全部来自 `changes.plan`（0.2.96 起才有），
 *     老记录没有 plan 就明说「这条记的时候还没有规模」，不许拿现在的清单反推。
 *  2. 「没有账本」和「读不出来」必须分开说：前者是这窗口还没跑过 dream，
 *     后者是库在但坏了——把后者说成前者，是最难查的那种谎。
 *  3. 抬头（面板名 + 条数）由 panel.js 统一加，这里只给正文与口径说明。
 */
import * as Meow from '../../vendor/meow-memory/lib/index.js'

/** 会话工作区：和 meow 的 workspaceOf() 同一条取法（exec.agent.session.header.cwd）。 */
export function workspaceOfExec(exec) {
  const cwd = exec?.agent?.session?.header?.cwd
  return typeof cwd === 'string' && cwd.length > 0 ? cwd : ''
}

/** 时间戳 → 「MM-DD HH:mm」（面板只给到分钟：秒在这里没有信息量）。 */
function stamp(at) {
  const t = Number(at)
  if (!Number.isFinite(t) || t <= 0) return '时间不明'
  const d = new Date(t)
  const p = (n) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/**
 * [macro-fusion 0.2.105] 「2026-11-18」→ 那一天**本机** 00:00 的毫秒。
 *
 * 坑：绝对不能用 `Date.parse('2026-11-18')`——那是按 UTC 解释的，东八区会整体错开 8 小时，
 * 于是「18 号那天的账」会把 17 号 16:00 之后的一起捞进来、把 18 号 16:00 之后的漏掉。
 * 这里用 `new Date(y, m-1, d)` 让运行时按本机时区算，再用年月日回读校验（2026-02-31 这种要打回）。
 */
function dayStartOf(raw) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(raw ?? '').trim())
  if (m === null) return null
  const y = Number(m[1])
  const mo = Number(m[2])
  const d = Number(m[3])
  const t = new Date(y, mo - 1, d, 0, 0, 0, 0)
  if (t.getFullYear() !== y || t.getMonth() !== mo - 1 || t.getDate() !== d) return null
  return t.getTime()
}

/** 那一天本机 23:59:59.999（闭区间：until 这天写的账也算在「这段时间」里）。 */
function dayEndOf(raw) {
  const s = dayStartOf(raw)
  return s === null ? null : s + 86400000 - 1
}

/** 本机时区标签（`UTC+08:00`）：按日期筛账必须先交代时区，否则「18 号」是哪个 18 号都说不清。 */
function tzLabel() {
  const off = -new Date().getTimezoneOffset()
  const abs = Math.abs(off)
  const sign = off >= 0 ? '+' : '-'
  return `UTC${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`
}

/**
 * [macro-fusion 0.2.105] since / until 两个可选日期 → 一个闭区间。
 * 三态：都不给 → 不筛（since=until=0）；给了 → 解成毫秒；写坏了 → 打回并说清怎么写。
 * 打回是刻意的：2026-13-40 这种在手边猜一个日期，读出来的结论比不筛更糟。
 */
function rangeOf(sinceRaw, untilRaw) {
  const sinceText = String(sinceRaw ?? '').trim()
  const untilText = String(untilRaw ?? '').trim()
  if (sinceText === '' && untilText === '') return { since: 0, until: 0, label: '', bad: '' }
  const since = sinceText === '' ? 0 : dayStartOf(sinceText)
  const until = untilText === '' ? 0 : dayEndOf(untilText)
  if (sinceText !== '' && since === null) {
    return { since: 0, until: 0, label: '', bad: `since 要写成「2026-11-18」这种日期（按本机时区 ${tzLabel()} 算一整天）——给的是「${sinceText}」，这种写法不敢猜。` }
  }
  if (untilText !== '' && until === null) {
    return { since: 0, until: 0, label: '', bad: `until 要写成「2026-11-18」这种日期（按本机时区 ${tzLabel()} 算一整天）——给的是「${untilText}」，这种写法不敢猜。` }
  }
  if (since > 0 && until > 0 && since > until) {
    return { since: 0, until: 0, label: '', bad: `since「${sinceText}」比 until「${untilText}」还晚——这样筛不出任何一条。两个日期换一下再来。` }
  }
  return { since: since || 0, until: until || 0, label: `${sinceText || '账本最早'} → ${untilText || '现在'}`, bad: '' }
}

/**
 * [macro-fusion 0.2.105] 展开一条时，这条到底在不在你筛的那段时间里。
 * 只说位置，不改结论：编号与引用都按全账本算（和项目筛同一条分寸），
 * 但「我筛 19 号，怎么翻出 15 号的账」这种困惑必须有句话对上。
 */
function rangeNoteOf(row, range) {
  if (!(range.since > 0 || range.until > 0)) return ''
  const at = Number(row?.runAt) || 0
  const inside = at > 0 && (range.since === 0 || at >= range.since) && (range.until === 0 || at <= range.until)
  if (inside) return `这一条写在 ${range.label} 这段时间里，正是你筛的那几天。`
  return `这一条不在 ${range.label} 这段时间里（它写在 ${stamp(at)}）——展开照账念，只是别把它当成那段时间的账。`
}

/** `window dream done: …` / `window dream aborted: …` → `done` / `aborted` / `''`。 */
function reasonOf(summary) {
  const m = String(summary ?? '').match(/^window dream ([a-z]+):/)
  return m === null ? '' : m[1]
}

const REASON_TEXT = {
  done: '整理完成',
  aborted: '中途放弃',
  recovered: '上次被打断，这次补记',
}

/**
 * [macro-fusion 0.2.102] `plan.projects` 有两种形态，读的时候都得认：
 *  - 0.2.96～0.2.101 写的是**个数**（数字，sum 各轮 projects 数组长度）；
 *  - 0.2.102 起写的是**名字数组**（去重保序）。
 * 以前这里只认数组，于是老账本一行行都念成「0 个项目段」——数就在账本里，被读丢了。
 */
function projectCountOf(plan) {
  if (Array.isArray(plan?.projects)) return plan.projects.length
  const legacy = Number(plan?.projects)
  if (Number.isFinite(legacy) && legacy > 0) return legacy
  const counted = Number(plan?.projectCount)
  return Number.isFinite(counted) && counted > 0 ? counted : 0
}


/**
 * [macro-fusion 0.2.103] 库规模：`plan.store = { active, byLevel }`，0.2.103 之前写的账没有这一格。
 * 读的时候三态要分清：没有 store（老账，别念成 0 条）／有 store 但 active 不是正数（写了但没数清）／正常。
 * 返回 null 表示「这条账没记」，调用方据此决定是闭嘴还是解释，不许自己补 0。
 */
function storeOf(plan) {
  const store = plan?.store
  if (store === undefined || store === null || typeof store !== 'object') return null
  const active = Number(store.active)
  if (!Number.isFinite(active) || active < 0) return null
  const byLevel = {}
  if (store.byLevel !== undefined && store.byLevel !== null && typeof store.byLevel === 'object') {
    for (const [level, n] of Object.entries(store.byLevel)) {
      const v = Number(n)
      if (Number.isFinite(v) && v > 0) byLevel[level] = v
    }
  }
  return { active, byLevel }
}

/**
 * [macro-fusion 0.2.106] 收尾规模：`plan.storeEnd = { active, byLevel }`，0.2.106 之前写的账没有这一格。
 * 与 storeOf 同一套读法（正数才认、只留非零层），但语义不同：store 是「开工前多大」，
 * storeEnd 是「这一轮结束后多大」。差（storeDelta）只在两个点都有数时才有，缺一个就不猜。
 */
function storeEndOf(plan) {
  return storeOf({ store: plan?.storeEnd })
}

function storeDeltaOf(plan) {
  const start = storeOf(plan)
  const end = storeEndOf(plan)
  if (start === null || end === null) return null
  return { start, end, delta: end.active - start.active }
}

/** [macro-fusion 0.2.106] `（fact 2 · lesson 1）`；一层都没有就给空串，别留一对空括号。 */
function levelsText(store) {
  const levels = Object.entries(store.byLevel).map(([level, n]) => `${level} ${n}`)
  return levels.length === 0 ? '' : `（${levels.join(' · ')}）`
}

/**
 * 一行账：`- #1 11-20 08:14 · 整理完成 · 2 轮 / 2 条 · 逐字重复 0 对 · 重复详写 1 对 · 缺 1 个词`
 * 没有 plan 的老记录只报「groups=…」（那是 summary 里本来就有的数），并说明为什么没有规模。
 *
 * [macro-fusion 0.2.98] 行首补 `#k`（1 = 最新）：同一份账在会话里会反复出现，
 * 有编号才好在后面说「第 3 条那次 stamped=false」。行尾补「落库 是/否」——
 * stamped 是「这一轮的结论真的写进库了吗」，整理完却没写进库，和没整理过是两件事。
 */
/**
 * [macro-fusion 0.2.104] 账本行的稳定引用：dream_log.id 只增不减、删了也不复用，
 * 所以「r128」永远指同一轮整理；而「#3」只是它此刻排第几——下次再跑一次 dream，
 * #3 就换人了。两个号并存：翻开时看 #k（这一页的第几近），回指时用 r<N>。
 */
function refOfRow(row) {
  const id = Number(row?.id)
  return Number.isFinite(id) && id > 0 ? `r${id}` : ''
}

/** 把「r128」这种引用写法解析成 128；数字、「#3」、乱写一律返回 0（走「第几近」那条路，由调用方打回）。 */
function refIdOf(raw) {
  if (raw === undefined || raw === null) return 0
  const m = /^[rR](\d{1,9})$/.exec(String(raw).trim())
  if (m === null) return 0
  const n = Number(m[1])
  return Number.isFinite(n) && n > 0 ? n : 0
}

function rowLine(row, index) {
  const reason = reasonOf(row.summary)
  const seq = Number.isFinite(index) ? `#${index} ` : ''
  const ref = refOfRow(row)
  const tailRef = ref === '' ? '' : ` · 引用 ${ref}`
  const head = `${seq}${stamp(row.runAt)} · ${REASON_TEXT[reason] ?? (reason === '' ? '原因未记' : reason)}`
  const plan = row.changes?.plan
  if (plan === undefined || plan === null) {
    const groups = Number(row.changes?.groups)
    const tail = Number.isFinite(groups) ? ` · ${groups} 组` : ''
    return `${head}${tail} · 这条记录比 0.2.96 早，当时还没写规模数字${tailRef}`
  }
  const num = (v) => {
    const n = Number(v)
    return Number.isFinite(n) ? n : 0
  }
  const parts = [
    `${num(plan.rounds)} 轮 / ${num(plan.rows)} 条`,
    `逐字重复 ${num(plan.dup)} 对`,
    `重复详写 ${num(plan.cover)} 对`,
  ]
  if (num(plan.missing) > 0) parts.push(`缺 ${num(plan.missing)} 个词`)
  const projects = projectCountOf(plan)
  if (projects > 0) parts.push(`${projects} 个项目段`)
  const stamped = row.changes?.stamped
  if (typeof stamped === 'boolean') parts.push(`落库 ${stamped ? '是' : '否'}`)
  return `${head} · ${parts.join(' · ')}${tailRef}`
}

/**
 * [macro-fusion 0.2.98] 趋势行：只念账本，不猜。
 *
 * 主人真正会问的问题是「整理是不是越做越干净」，而单看某一行回答不了——
 * 五条记录一行一个数字，扫完也记不住走向。所以把最近几次的
 * 逐字重复 / 重复详写 / 缺词 各自合计，再比「后半段均值 vs 前半段均值」说在变多还是变少。
 *
 * 四条克制：
 *  1. 可用记录 < 2 条就不出这一行（一条记录没有「趋势」，硬算等于编）。
 *  2. 老格式（没有 plan）的行不参与，但要说清有几条被跳过——否则合计对不上账。
 *  3. 次数 < 4 时补一句「次数太少，只当参考」：样本不足时不许把噪声说成走势。
 *  4. 变化量不足 0.5 就说「持平」，不许把 1.4 → 1.2 讲成「在变少」。
 */
function trendLine(rows) {
  const withPlan = rows.filter((r) => r.changes?.plan !== undefined && r.changes?.plan !== null)
  const skipped = rows.length - withPlan.length
  if (withPlan.length < 2) return ''
  const ordered = withPlan.slice().reverse() // 账本是「最新在前」，趋势要「最早→最新」
  const pick = (r, key) => {
    const n = Number(r.changes.plan?.[key])
    return Number.isFinite(n) ? n : 0
  }
  const sum = (key) => ordered.reduce((acc, r) => acc + pick(r, key), 0)
  const half = Math.floor(ordered.length / 2)
  const trendOf = (key) => {
    if (ordered.length < 4) return '持平'
    const early = ordered.slice(0, half).reduce((a, r) => a + pick(r, key), 0) / half
    const late = ordered.slice(ordered.length - half).reduce((a, r) => a + pick(r, key), 0) / half
    if (late - early >= 0.5) return '在变多'
    if (early - late >= 0.5) return '在变少'
    return '持平'
  }
  const parts = [
    `逐字重复 合计 ${sum('dup')} 对，${trendOf('dup')}`,
    `重复详写 合计 ${sum('cover')} 对，${trendOf('cover')}`,
    `缺词 合计 ${sum('missing')} 个，${trendOf('missing')}`,
  ]
  const caveats = []
  // [macro-fusion 0.2.103] 库规模：只有至少两次账记了 store 才敢讲区间；一次是快照，不是走势。
  const storeRows = ordered.map((r) => storeOf(r.changes?.plan)).filter((s) => s !== null)
  if (storeRows.length >= 2) {
    const first = storeRows[0].active
    const last = storeRows[storeRows.length - 1].active
    const delta = last - first
    const word = delta > 0 ? `多了 ${delta} 条` : delta < 0 ? `少了 ${-delta} 条` : '没变'
    parts.push(`库 开工时 ${first} → ${last} 条（${word}）`)
    if (storeRows.length < ordered.length) {
      caveats.push(`库规模只有 ${storeRows.length} 次有数——更早的账写在 0.2.103 之前，没有这一格`)
    }
  }
  // [macro-fusion 0.2.106] 有收尾数的那几次，把净变化合起来——整理总体上在让库变大还是变小，
  // 只有把每一轮的「开工 → 收尾」加起来才答得出。缺收尾数的账不参与，但要说清少了几次。
  const spans = ordered.map((r) => storeDeltaOf(r.changes?.plan)).filter((s) => s !== null)
  if (spans.length > 0) {
    const net = spans.reduce((acc, s) => acc + s.delta, 0)
    const word = net > 0 ? `净增 ${net} 条` : net < 0 ? `净减 ${-net} 条` : '净变化为 0'
    parts.push(`收尾${word}（${spans.length} 次有收尾数）`)
    if (spans.length < storeRows.length) {
      caveats.push(`${storeRows.length - spans.length} 次只有开工数、没有收尾数——0.2.106 之前的账没有这一格`)
    }
  }
  if (skipped > 0) caveats.push(`${skipped} 条记录早于 0.2.96，没有数字、不参与`)
  if (ordered.length < 4) caveats.push(`${ordered.length} 次样本太少，只当参考、别当走势`)
  const tail = caveats.length > 0 ? `（${caveats.join('；')}）` : ''
  return `趋势：最近 ${ordered.length} 次（最早→最新）· ${parts.join(' · ')}${tail}`
}


/**
 * 这一轮正在整理什么（0.2.99）：账本是事后对账，活的那一轮要从 lease + dreamdigest 读。
 * 只念一句，不占账本的位置——收尾之后它就会变成上面的一行历史。
 */
function liveLine(live) {
  const ids = Array.isArray(live?.sessionIds) ? live.sessionIds : []
  if (ids.length === 0) return ''
  const num = (v) => {
    const n = Number(v)
    return Number.isFinite(n) ? n : 0
  }
  const plan = live?.plans?.[ids[0]]
  const head = `整理进行中${ids.length > 1 ? `（还有 ${ids.length - 1} 个会话在排队等整理）` : ''}`
  if (plan === undefined || plan === null) {
    return `${head}：这一轮的规模还没落 meta（刚 claim，摘要算完就有了）——收尾之后这里会变成账本里的一行历史`
  }
  const parts = [`${num(plan.rounds)} 轮 / ${num(plan.rows)} 条`, `逐字重复 ${num(plan.dup)} 对`, `重复详写 ${num(plan.cover)} 对`]
  if (num(plan.missing) > 0) parts.push(`缺 ${num(plan.missing)} 个词`)
  const projects = projectCountOf(plan)
  if (projects > 0) parts.push(`${projects} 个项目段`)
  return `${head}：${parts.join(' · ')}——收尾之后这里会变成账本里的一行历史`
}

/**
 * [macro-fusion 0.2.101] 项目段的分布：账本里到底有哪几个项目、各出现在几次整理里。
 * 行首就用它，是因为「按项目翻账」得先知道有哪几个项目可筛——不然用户只能瞎猜名字。
 * 只列前几条时把「还有几个没列」说出来，别让「没列」被读成「没有」。
 */
function projectsLine(got) {
  const items = Array.isArray(got?.items) ? got.items : []
  if (items.length === 0) return ''
  const parts = items.map((it) => `${it.project} ${it.n} 次`)
  const total = Number(got.total) || 0
  const rest = total - items.length
  const tail = rest > 0 ? `（还有 ${rest} 个项目段没列）` : ''
  return `项目段：${parts.join(' · ')}${tail}`
}

/** 某一条账自己的项目段（展开时摊出来）：有就点名，没有就说没有，不拿摘要里的字凑。 */
function projectNames(row) {
  const list = row?.changes?.plan?.projects
  if (!Array.isArray(list) || list.length === 0) return ''
  return list.map((p) => String(p)).filter((p) => p !== '').join('、')
}

/**
 * [macro-fusion 0.2.102] 对子明细：账本从这一版起记「跟谁撞」，摊开一条账就能直接动手合并。
 *
 * 四条克制：
 *  1. `pairs` 字段不存在 ≠ 没有对子：老账本（0.2.102 之前）不存明细，只能念数，得明说是「没存」。
 *  2. 账里说撞上 N 对、明细却是空的：说明这一轮的真值超出了落库上限，别把「没列」读成「没有」。
 *  3. 短 id 与整理清单里印的是同一套（uniqueShortIdsAmong），能直接拿去 memory_read / memory_update。
 *  4. 重复详写对要念「会丢几个词」——合并时最容易被丢掉的就是这些词。
 */
function pairLine(p) {
  const cover = p?.kind === 'cover'
  const head = `- ${p?.a ?? '?'} ${cover ? '⊂' : '⇄'} ${p?.b ?? '?'}  ${Number(p?.score) || 0} · ${p?.levelA ?? '?'} ${cover ? '⇒' : '⇄'} ${p?.levelB ?? '?'}`
  if (!cover) return head
  const missing = Number(p?.missing) || 0
  if (missing === 0) return `${head} · 合并无损`
  const words = (Array.isArray(p?.words) ? p.words : []).map((w) => String(w)).filter((w) => w !== '')
  return `${head} · 会丢 ${missing} 个词${words.length === 0 ? '' : `：${words.join('、')}`}`
}

function pairsBlock(row) {
  const plan = row?.changes?.plan
  if (plan === undefined || plan === null) {
    return '对子：这条账没有 changes.plan（它写在 0.2.96 之前），谈不上对子。'
  }
  const stored = Array.isArray(plan.pairs) ? plan.pairs : null
  const dup = Number(plan.dup) || 0
  const cover = Number(plan.cover) || 0
  if (stored === null) {
    return '对子：这条账没有存对子明细（0.2.102 之前的记录）——上面那行数是真数，但跟谁撞了要回去翻那次整理的消息。'
  }
  if (stored.length === 0) {
    return dup + cover === 0
      ? '对子：这一轮没撞上对子，没有可合并的。'
      : `对子：账里记着 ${dup + cover} 对，却没有一条明细——别把「没列」读成「没有」。`
  }
  const dups = stored.filter((p) => p?.kind !== 'cover')
  const covers = stored.filter((p) => p?.kind === 'cover')
  const lines = [`对子（账里存了 ${stored.length} 对，这一轮共 ${dup + cover} 对）：`]
  if (dups.length > 0) lines.push('逐字重复：', ...dups.map(pairLine))
  if (covers.length > 0) lines.push('重复详写：', ...covers.map(pairLine))
  if (stored.length < dup + cover) {
    lines.push(`- 还有 ${dup + cover - stored.length} 对没落账（一条账只存前几对）——数是真数，点名只到前几对。`)
  }
  lines.push('短 id 和整理清单里印的是同一套，可以直接拿去 memory_read / memory_update。')
  return lines.join('\n')
}

/**
 * [macro-fusion 0.2.106] 库规模一格：原来只说「开工时多大」，现在两个观测点都念。
 *
 * 为什么值得反转 0.2.103 的口径（当时明写「收尾不再数」）：只念开工那一眼，读的人永远算不出
 * 这一轮让库变轻还是变重——而「整理是不是真在收敛」正是整理这件事唯一的成绩单。
 * 两个数都是一轮里真数出来的（收尾那次在 stampDream 之后、日志落库之前取），
 * 但**差不是因果**：中间可能有别的会话在写、也可能有归档把 active 挪走。
 * 所以这里只给数，归因留给 stamped（这一轮封存/完结了几条），口径句单独一行说清。
 *
 * 四条规矩照旧：①老账没有这一格就明说没有，不补 0；②没有 plan 的账前面已经解释过 0.2.96，这里闭嘴；
 * ③0 条也照念（空库整理是事实，不是错误）；④层名与 memory_* 的 level 一致，不加中文译名。
 * 新增第五：有开工没收尾（0.2.106 之前的账）照旧只念开工，不假装知道后来变成多少。
 */
function storeBlock(row) {
  const plan = row?.changes?.plan
  if (plan === undefined || plan === null) return ''
  const store = storeOf(plan)
  if (store === null) {
    return '库规模：这条账没有记库规模（它写在 0.2.103 之前）——别把「没记」读成「库是空的」。'
  }
  const head = `库规模：开工时 ${store.active} 条在用${levelsText(store)}`
  const span = storeDeltaOf(plan)
  if (store.active === 0 && span === null) return '库规模：开工时库里 0 条在用记忆——这一轮是在空库上整理的。'
  if (span === null) return head
  // 差放在句尾当结论，层数夹在括号里——别写成「（fact 2）（+1）」两层括号叠在一起。
  const word = span.delta > 0 ? `比开工多 ${span.delta} 条` : span.delta < 0 ? `比开工少 ${-span.delta} 条` : '和开工时一样'
  return `${head} → 收尾 ${span.end.active} 条在用${levelsText(span.end)}，${word}`
}

/**
 * [macro-fusion 0.2.106] 规模差的口径句：只在两个观测点都有数时才出。
 * 一句话把「差」和「因」分开——这是这一格唯一容易读错的地方。
 */
function storeDeltaNote(row) {
  const plan = row?.changes?.plan
  const span = storeDeltaOf(plan)
  if (span === null) return ''
  const stamped = Number(row?.changes?.stamped)
  const tail = Number.isFinite(stamped) ? `这一轮封存/完结 ${stamped} 条（changes.stamped）` : '这条账没记 stamped'
  return `规模差口径：开工与收尾都只数 status='active'，两个点之间可能有别的会话也在写，所以 ${span.delta >= 0 ? '+' : ''}${span.delta} 是「库变了多少」，不是「这一轮改了几条」——${tail}。`
}

/**
 * 单条展开：把这一条的原文摊出来，别让人只能看一行摘要。
 *
 * 三件事分开写，因为它们是三种不同来源的信息：
 *  - 「这一轮」= changes.plan（0.2.96 起才有）；老记录没有，就明说没有，不拿摘要里的数字凑。
 *  - 「摘要」「备注」= summary / note 原文，一字不改（这是账本里的原话）。
 *  - 「变化原文」= changes 的 JSON 原文，摊开是为了能对账；太长就截断并报真实长度。
 * 再加一句「比更早一条」，因为单条数字看不出变化——0.2.98 的趋势行只给整体，
 * 摊到某一条时，人想问的正是「这条和上一条比，是多了还是少了」。
 */
function expandPanel(rec, rank) {
  const row = rec.row
  const lines = [rowLine(row, rank)]
  const plan = row.changes?.plan
  if (plan !== undefined && plan !== null) {
    lines.push('这一轮的数字就是上面这一行，全部来自 changes.plan。')
  } else {
    lines.push('这一条没有 changes.plan：它写在 0.2.96 之前，当时还没有记规模。')
  }
  const summary = String(row.summary ?? '').trim()
  lines.push(`摘要：${summary === '' ? '（这一条没有摘要）' : summary.replace(/\s+/g, ' ')}`)
  const note = String(row.note ?? '').trim()
  lines.push(`备注：${note === '' ? '（这一条没写备注）' : note}`)
  const names = projectNames(row)
  if (names === '') {
    // 老账本只记了个数：数不能丢，但名字确实没存，别拿摘要里的字凑一个。
    const legacy = projectCountOf(plan)
    lines.push(
      legacy > 0
        ? `项目段：这条账只记了个数（${legacy} 个），没记名字——它写在 0.2.102 之前。`
        : '项目段：这条账没有记项目段（老记录或这一轮没涉及项目）。',
    )
  } else lines.push(`项目段：${names}`)
  lines.push(pairsBlock(row))
  const storeLine = storeBlock(row)
  if (storeLine !== '') lines.push(storeLine)
  const storeNote = storeDeltaNote(row)
  if (storeNote !== '') lines.push(storeNote)

  const prev = rec.prev
  if (prev !== null && prev !== undefined) {
    const cmp = compareLine(row, prev, rank + 1)
    if (cmp !== '') lines.push(cmp)
  }

  const raw = row.changes === null || row.changes === undefined ? '' : JSON.stringify(row.changes, null, 2)
  if (raw === '') {
    lines.push('变化原文：这条 changes 读不出来（坏行），所以只念它自己的摘要——不猜里面写了什么。')
  } else {
    const CAP = 1200
    if (raw.length > CAP) {
      lines.push(`变化原文（前 ${CAP} 字符，共 ${raw.length} 字符）：`)
      lines.push(raw.slice(0, CAP))
      lines.push('…')
    } else {
      lines.push('变化原文：')
      lines.push(raw)
    }
  }
  return lines.join('\n')
}

/** 两条账的差：只说真正变了的段；一样就说一样（不硬凑一句好听的话）。 */
function compareLine(row, prev, prevRank) {
  const pick = (r, key) => {
    const n = Number(r.changes?.plan?.[key])
    return Number.isFinite(n) ? n : null
  }
  const keys = [
    ['dup', '逐字重复'],
    ['cover', '重复详写'],
    ['missing', '缺词'],
    ['rows', '条数'],
  ]
  const moved = []
  let comparable = 0
  for (const [key, name] of keys) {
    const a = pick(prev, key)
    const b = pick(row, key)
    if (a === null || b === null) continue
    comparable += 1
    if (a !== b) moved.push(`${name} ${a}→${b}${b > a ? '（多了）' : '（少了）'}`)
  }
  if (comparable === 0) return `比更早一条（#${prevRank}）：两边都没有规模数字，不比较。`
  if (moved.length === 0) return `比更早一条（#${prevRank}）：逐字重复 / 重复详写 / 缺词 / 条数都没变。`
  return `比更早一条（#${prevRank}）：${moved.join('、')}。`
}

/**
 * 面板正文 + 口径。
 * [macro-fusion 0.2.101] project：按项目段翻账（匹配 changes.plan.projects 里的名字）。
 *  - 只在 SQL 里筛一次，页面和总数都来自同一个筛子，别在 JS 里再挑一遍（那样翻页会漏条）。
 *  - 筛选生效时 #k 是「筛出来那几条里的第几近」，不是全账本的第几近——口径变了就得说清。
 *  - 项目名一个都匹配不上，要报全账本有几条，而不是「账本还是空的」。
 * [macro-fusion 0.2.105] since / until：按日期区间筛（本机时区，闭区间，写 `2026-11-18`）。
 *  - 行与总数一起过同一个筛子（SQL 里筛），否则「第几页」「一共几条」会各算一套。
 *  - 筛空了要说清「这段时间里没有」还是「账本里根本没有这段」，所以带上账本覆盖范围。
 *  - 时区必须交代：账本里存的是毫秒时间戳，屏幕上印的是本机时间，不写时区就没法核对。
 * @param {{workspace?: string, dir?: string, limit?: number, page?: number, id?: number, project?: string, since?: string, until?: string}} opts
 * @returns {{body: string, scope: string}}
 */
export function readDreamPanel({ workspace = '', dir = '.dsh-meow', limit = 5, page = 1, id = 0, project = '', since = '', until = '' } = {}) {
  const asked = Math.trunc(Number(limit))
  const want = Number.isFinite(asked) && asked > 0 ? Math.min(50, asked) : 5
  const askedPage = Math.trunc(Number(page))
  const wantPage = Number.isFinite(askedPage) && askedPage > 0 ? askedPage : 1
  // [macro-fusion 0.2.104] id 有两种写法：「3」/「#3」= 第几近（会随新账挪），「r128」= 账本引用（不挪）。
  const wantRef = refIdOf(id)
  const askedId = Math.trunc(Number(String(id ?? '').replace(/^#/, '')))
  const wantId = wantRef > 0 ? 0 : Number.isFinite(askedId) && askedId > 0 ? askedId : 0
  const wantProject = String(project ?? '').trim()
  // [macro-fusion 0.2.105] 日期写坏了就地打回：猜一个日期筛出来的结论，比不筛更误导。
  const range = rangeOf(since, until)
  if (range.bad !== '') return { body: `${range.bad}这次没有列账。`, scope: '按时间筛的写法被打回，账本一条没动' }
  const ranged = range.since > 0 || range.until > 0

  // 按稳定引用展开：编号会挪，引用不挪，所以两条路分开走、也分开说。
  if (wantRef > 0) {
    const rec = Meow.readDreamRecordByRef(workspace, dir, wantRef)
    if (rec.missing === 'no-workspace') {
      return {
        body: '这个会话没有工作区（会话头里没有 cwd），读不到 dream 账本——账本按工作区存放（<工作区>/.dsh-meow/memory.db），没有工作区就没有账本可念。',
        scope: '',
      }
    }
    if (rec.missing === 'no-db') {
      return { body: `这个工作区还没有记忆库（${rec.path}）——不是 dream 跑过却没留痕，是这个窗口还没建过库。`, scope: '' }
    }
    if (rec.missing === 'no-row') {
      return {
        body:
          `账本里没有引用 r${wantRef} 的那一条（一共 ${rec.total} 条）——引用是账本行的固定号，只增不减，` +
          '从来不会把老号发给新账。所以要么这个号压根没写过，要么那一行已经不在了（库被重建 / 手工删过）。' +
          '要按位置找，就翻 page 看 #k；要按内容找，就用摘要里的字眼去搜。',
        scope: `账本共 ${rec.total} 条，要的是引用 r${wantRef}`,
      }
    }
    if (rec.missing !== '') {
      return {
        body: `dream 账本读不出来（${rec.path}）：${rec.missing.replace(/^read-failed: /, '')}——这不是「没跑过 dream」，是库在但读不开。`,
        scope: '',
      }
    }
    const names = projectNames(rec.row)
    const listed = names === '' ? [] : names.split('、')
    const filterNote =
      wantProject === ''
        ? ''
        : listed.includes(wantProject)
          ? `这一条属于项目段「${wantProject}」。`
          : `这一条不属于项目段「${wantProject}」——它记的是${names === '' ? '没有项目段' : `「${names}」`}。展开还是照账念，只是别把它当成筛选结果。`
    const rankNow = rec.rank > 0 ? rec.rank : 0
    const tail = `引用 r${wantRef}：这个号跟着这一行走，账本再长几轮也不挪（删了也不会被别人占用）；${
      rankNow > 0 ? `它现在排第 ${rankNow} 近——「#k」会随新账往下挪，回指请用引用。` : '这次没算出它现在排第几近（账本刚被别的进程改过）。'
    }`
    const body = [expandPanel(rec, rankNow > 0 ? rankNow : undefined), tail, rangeNoteOf(rec.row, range), filterNote]
      .filter((s) => s !== '')
      .join('\n\n')
    return {
      body,
      scope:
        `按引用 r${wantRef} 展开${rankNow > 0 ? `（现在第 ${rankNow} 近）` : ''}，共 ${rec.total} 条；原文照账本念，不重算这一轮清单` +
        (wantProject === '' ? '' : '；引用不受项目筛选影响') +
        (ranged ? '；日期筛选也不影响引用' : ''),
    }
  }

  // 单条展开：口径是「第几近」，1 = 最新，和列表里的 #k 同一个编号（翻页也不改）。
  if (wantId > 0) {
    const rec = Meow.readDreamRecord(workspace, dir, wantId)
    if (rec.missing === 'no-workspace') {
      return {
        body: '这个会话没有工作区（会话头里没有 cwd），读不到 dream 账本——账本按工作区存放（<工作区>/.dsh-meow/memory.db），没有工作区就没有账本可念。',
        scope: '',
      }
    }
    if (rec.missing === 'no-db') {
      return { body: `这个工作区还没有记忆库（${rec.path}）——不是 dream 跑过却没留痕，是这个窗口还没建过库。`, scope: '' }
    }
    if (rec.missing === 'no-row') {
      return {
        body:
          `账本里没有第 ${wantId} 条（一共 ${rec.total} 条）——编号按「第几近」算，1 是最新的一条。` +
          '要展开更早的，先把 page 翻到更早那几页看编号。',
        scope: `账本共 ${rec.total} 条，要的是第 ${wantId} 条`,
      }
    }
    if (rec.missing !== '') {
      return {
        body: `dream 账本读不出来（${rec.path}）：${rec.missing.replace(/^read-failed: /, '')}——这不是「没跑过 dream」，是库在但读不开。`,
        scope: '',
      }
    }
    const names = projectNames(rec.row)
    const listed = names === '' ? [] : names.split('、')
    const filterNote =
      wantProject === ''
        ? ''
        : listed.includes(wantProject)
          ? `这一条属于项目段「${wantProject}」。`
          : `这一条不属于项目段「${wantProject}」——它记的是${names === '' ? '没有项目段' : `「${names}」`}。展开还是照账念，只是别把它当成筛选结果。`
    const rowRef = refOfRow(rec.row)
    const body = [expandPanel(rec, wantId), rangeNoteOf(rec.row, range), filterNote].filter((s) => s !== '').join('\n\n')
    return {
      body,
      scope:
        `展开第 ${wantId} 条（共 ${rec.total} 条${rowRef === '' ? '' : `；引用 ${rowRef}，要回指就用 id=${rowRef}`}）；原文照账本念，不重算这一轮清单` +
        (wantProject === '' ? '' : `；展开的编号仍是全账本的第几近（筛选不改编号）`) +
        (ranged ? `；要按时间筛就翻 page 看 list` : ''),
    }
  }

  const offset = (wantPage - 1) * want
  const ledger = Meow.readDreamLedger(workspace, dir, want, offset, wantProject, range.since, range.until)
  // 「全账本」= 既不看项目段、也不看日期：筛完再报「全账本 N 条」时，那个 N 不能是筛后的数。
  const allTotal = wantProject === '' && !ranged ? 0 : Meow.readDreamLedger(workspace, dir, 1, 0, '', 0, 0).total
  if (ledger.missing === 'no-workspace') {
    return {
      body:
        '这个会话没有工作区（会话头里没有 cwd），读不到 dream 账本——' +
        'dream 的账本按工作区存放（<工作区>/.dsh-meow/memory.db），没有工作区就没有账本可念。',
      scope: '',
    }
  }
  if (ledger.missing === 'no-db') {
    return {
      body:
        `这个工作区还没有记忆库（${ledger.path}）——不是 dream 跑过却没留痕，是这个窗口还没建过库。` +
        '写几条记忆、再整理一次之后再看。',
      scope: '',
    }
  }
  if (ledger.missing !== '') {
    return {
      body: `dream 账本读不出来（${ledger.path}）：${ledger.missing.replace(/^read-failed: /, '')}——这不是「没跑过 dream」，是库在但读不开。`,
      scope: '',
    }
  }
  const total = Number(ledger.total) || 0
  const live = wantPage === 1 ? Meow.readLiveDream(workspace, dir) : { sessionIds: [] }
  const liveText = liveLine(live)
  if (total === 0) {
    // [macro-fusion 0.2.105] 按日期筛空了，和「账本还是空的」「没这个项目段」都要分开：
    // 这段空结果到底是「这几天没跑」还是「跑过但不在你这几天里」，只能靠账本覆盖范围说清。
    if (ranged) {
      const span = Meow.readDreamSpan(workspace, dir)
      const cover =
        span.missing === '' && span.first > 0
          ? `账本覆盖 ${stamp(span.first)} → ${stamp(span.last)}（本机时区 ${tzLabel()}）`
          : '账本里还没有任何一条'
      const who = wantProject === '' ? '' : `项目段「${wantProject}」的`
      const body =
        `${range.label} 这段时间里没有${who}整理记录——${cover}。` +
        (allTotal > 0
          ? `全账本 ${allTotal} 条都在这个区间外面（since / until 按本机时区算整天，两端都含）。换一段日期再看，或者干脆不带日期翻全账本。`
          : '')
      return { body, scope: `按时间 ${range.label} 筛：0 条（全账本 ${allTotal} 条）` + (wantProject === '' ? '' : `；项目段「${wantProject}」这段时间里一条都没有`) }
    }
    // [macro-fusion 0.2.101] 筛了个没人用过的项目名，和「账本还是空的」不是一回事：
    // 前者说明白「全账本有 N 条，只是没有这个项目段」，后者才叫还没整理过。
    if (wantProject !== '') {
      const body =
        allTotal === 0
          ? `这个工作区的 dream 账本还是空的（${ledger.path}），项目段「${wantProject}」自然也还没有记录。`
          : `账本里没有项目段「${wantProject}」的整理记录（全账本 ${allTotal} 条）——项目名要按 changes.plan.projects 里的原样写，别自己翻译。`
      return { body, scope: `按项目段「${wantProject}」筛：0 条（全账本 ${allTotal} 条）` }
    }
    const empty = `这个工作区的 dream 账本还是空的（${ledger.path}）——还没跑完过 dream。在会话里触发一次整理，之后这里就会留下这一轮看到什么。`
    if (liveText !== '') return { body: `${liveText}\n\n${empty}`, scope: '正在整理的那一轮还没收尾，账本里暂时没有历史' }
    return { body: empty, scope: '' }
  }

  // 页码越过最后一页：不返回空白页，退到最后一页并把话说清（「页码大」不等于「没有账」）。
  const lastPage = Math.max(1, Math.ceil(total / want))
  const effectivePage = Math.min(wantPage, lastPage)
  const rows =
    effectivePage === wantPage
      ? ledger.rows
      : Meow.readDreamLedger(workspace, dir, want, (effectivePage - 1) * want, wantProject, range.since, range.until).rows
  const firstRank = (effectivePage - 1) * want + 1
  const lines = rows.map((row, i) => rowLine(row, firstRank + i))
  const lastRank = firstRank + rows.length - 1
  if (liveText !== '') lines.unshift(liveText, '')

  const scopeParts = []
  const filtered = wantProject !== ''
  if (wantPage > lastPage) {
    scopeParts.push(`账本只有 ${total} 条，第 ${wantPage} 页早过最后一页（第 ${lastPage} 页），这里给的是最后一页`)
  }
  // [macro-fusion 0.2.105] 筛口径要一次说全：筛了什么、筛出几条、筛子之外还有几条、时区是哪儿。
  const sieve = [filtered ? `项目段「${wantProject}」` : '', ranged ? `时间 ${range.label}` : ''].filter((s) => s !== '').join(' + ')
  if (wantPage === 1) {
    if (filtered || ranged) {
      scopeParts.push(
        `${ranged ? `按${sieve} 筛` : `按${sieve}筛`}：${total} 条（全账本 ${allTotal} 条），列最近 ${rows.length} 条；` +
          '#k 是筛出来这几条里的第几近，不是全账本序号',
      )
      if (ranged) scopeParts.push(`日期按本机时区 ${tzLabel()} 算整天，since / until 两端都含`)
    } else if (total <= want) {
      scopeParts.push(`账本里一共 ${total} 次整理记录（你要的是 ${want} 条）`)
    } else {
      scopeParts.push(`列最近 ${rows.length} 次整理记录（共 ${total} 条）`)
    }
  } else {
    scopeParts.push(`第 ${effectivePage} 页（每页 ${want} 条）：第 ${firstRank}–${lastRank} 条`)
  }
  if (wantPage === 1) {
    // 项目分布只在没筛的时候给：筛完再报分布，会让人以为「分布也筛过了」。
    // [macro-fusion 0.2.105] 按日期筛时同理：分布是全账本的，不是这段日子的。
    if (!filtered && !ranged) {
      const projects = projectsLine(Meow.readDreamProjects(workspace, dir, 5))
      if (projects !== '') {
        lines.push('', projects)
        scopeParts.push('项目分布按 changes.plan.projects 数出现次数，只列前 5 个；要看某个项目的账就用 project= 筛')
      }
    }
    const trend = trendLine(rows)
    if (trend !== '') {
      lines.push('', trend)
      scopeParts.push('趋势行只念最近这几条账里的 plan 数字，不重算这一轮清单')
    }
    // [macro-fusion 0.2.104] 只在这一页说一次：账本越长越需要「叫得住的名字」，
    // 但每行都解释一遍等于拿 token 换噪音。
    if (rows.some((r) => refOfRow(r) !== '')) {
      lines.push('', '引用：每行末尾的 r<N> 是这一行的固定号——要回指某一轮就写 id=r<N>；#k 只是它此刻排第几，新账一来就挪。')
      scopeParts.push('引用 r<N> 只增不减，回指某一轮用它；#k 是当下的第几近')
    }
  } else {
    scopeParts.push('趋势行只在第 1 页出——它说的是最近几次，翻到旧页看它对不上号')
  }
  if (total > want) {
    const nav = []
    if (effectivePage > 1) nav.push(`上一页 page=${effectivePage - 1}`)
    if (effectivePage < lastPage) nav.push(`下一页 page=${effectivePage + 1}`)
    nav.push(sieve === '' ? `共 ${total} 条 · 每页 ${want} 条` : `共 ${total} 条（${sieve}）· 每页 ${want} 条`)
    lines.push('', nav.join(' · '))
    scopeParts.push(`翻页口径：page 从 1 起，每页 ${want} 条，编号 ${firstRank}–${lastRank} 跨页连续`)
  }
  if (liveText !== '') scopeParts.push('第一行是正在整理的那一轮，规模读的是 dreamdigest，不是账本')
  return { body: lines.join('\n'), scope: scopeParts.join('；') }
}
