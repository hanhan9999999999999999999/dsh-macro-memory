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
 * 一行账：`- #1 11-20 08:14 · 整理完成 · 2 轮 / 2 条 · 逐字重复 0 对 · 重复详写 1 对 · 缺 1 个词`
 * 没有 plan 的老记录只报「groups=…」（那是 summary 里本来就有的数），并说明为什么没有规模。
 *
 * [macro-fusion 0.2.98] 行首补 `#k`（1 = 最新）：同一份账在会话里会反复出现，
 * 有编号才好在后面说「第 3 条那次 stamped=false」。行尾补「落库 是/否」——
 * stamped 是「这一轮的结论真的写进库了吗」，整理完却没写进库，和没整理过是两件事。
 */
function rowLine(row, index) {
  const reason = reasonOf(row.summary)
  const seq = Number.isFinite(index) ? `#${index} ` : ''
  const head = `${seq}${stamp(row.runAt)} · ${REASON_TEXT[reason] ?? (reason === '' ? '原因未记' : reason)}`
  const plan = row.changes?.plan
  if (plan === undefined || plan === null) {
    const groups = Number(row.changes?.groups)
    const tail = Number.isFinite(groups) ? ` · ${groups} 组` : ''
    return `${head}${tail} · 这条记录比 0.2.96 早，当时还没写规模数字`
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
  const projects = Array.isArray(plan.projects) ? plan.projects.length : 0
  if (projects > 0) parts.push(`${projects} 个项目段`)
  const stamped = row.changes?.stamped
  if (typeof stamped === 'boolean') parts.push(`落库 ${stamped ? '是' : '否'}`)
  return `${head} · ${parts.join(' · ')}`
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
  const projects = Array.isArray(plan.projects) ? plan.projects.length : 0
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
  if (names === '') lines.push('项目段：这条账没有记项目段（老记录或这一轮没涉及项目）。')
  else lines.push(`项目段：${names}`)

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
 * @param {{workspace?: string, dir?: string, limit?: number, page?: number, id?: number, project?: string}} opts
 * @returns {{body: string, scope: string}}
 */
export function readDreamPanel({ workspace = '', dir = '.dsh-meow', limit = 5, page = 1, id = 0, project = '' } = {}) {
  const asked = Math.trunc(Number(limit))
  const want = Number.isFinite(asked) && asked > 0 ? Math.min(50, asked) : 5
  const askedPage = Math.trunc(Number(page))
  const wantPage = Number.isFinite(askedPage) && askedPage > 0 ? askedPage : 1
  const askedId = Math.trunc(Number(id))
  const wantId = Number.isFinite(askedId) && askedId > 0 ? askedId : 0
  const wantProject = String(project ?? '').trim()

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
    return {
      body: filterNote === '' ? expandPanel(rec, wantId) : `${expandPanel(rec, wantId)}\n\n${filterNote}`,
      scope:
        `展开第 ${wantId} 条（共 ${rec.total} 条）；原文照账本念，不重算这一轮清单` +
        (wantProject === '' ? '' : `；展开的编号仍是全账本的第几近（筛选不改编号）`),
    }
  }

  const offset = (wantPage - 1) * want
  const ledger = Meow.readDreamLedger(workspace, dir, want, offset, wantProject)
  const allTotal = wantProject === '' ? 0 : Meow.readDreamLedger(workspace, dir, 1, 0, '').total
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
    effectivePage === wantPage ? ledger.rows : Meow.readDreamLedger(workspace, dir, want, (effectivePage - 1) * want, wantProject).rows
  const firstRank = (effectivePage - 1) * want + 1
  const lines = rows.map((row, i) => rowLine(row, firstRank + i))
  const lastRank = firstRank + rows.length - 1
  if (liveText !== '') lines.unshift(liveText, '')

  const scopeParts = []
  const filtered = wantProject !== ''
  if (wantPage > lastPage) {
    scopeParts.push(`账本只有 ${total} 条，第 ${wantPage} 页早过最后一页（第 ${lastPage} 页），这里给的是最后一页`)
  }
  if (wantPage === 1) {
    if (filtered) {
      scopeParts.push(
        `按项目段「${wantProject}」筛：${total} 条（全账本 ${allTotal} 条），列最近 ${rows.length} 条；` +
          '#k 是筛出来这几条里的第几近，不是全账本序号',
      )
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
    if (!filtered) {
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
  } else {
    scopeParts.push('趋势行只在第 1 页出——它说的是最近几次，翻到旧页看它对不上号')
  }
  if (total > want) {
    const nav = []
    if (effectivePage > 1) nav.push(`上一页 page=${effectivePage - 1}`)
    if (effectivePage < lastPage) nav.push(`下一页 page=${effectivePage + 1}`)
    nav.push(filtered ? `共 ${total} 条（项目段「${wantProject}」）· 每页 ${want} 条` : `共 ${total} 条 · 每页 ${want} 条`)
    lines.push('', nav.join(' · '))
    scopeParts.push(`翻页口径：page 从 1 起，每页 ${want} 条，编号 ${firstRank}–${lastRank} 跨页连续`)
  }
  if (liveText !== '') scopeParts.push('第一行是正在整理的那一轮，规模读的是 dreamdigest，不是账本')
  return { body: lines.join('\n'), scope: scopeParts.join('；') }
}
