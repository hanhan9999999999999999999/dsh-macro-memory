// [macro-fusion 0.4.0] P3：自动 supersedes（默认只给建议，apply 才动库）。
//
// 病：`conflictCandidates`（vendor/meow-memory/lib/index.js:3692）已经在写侧认出「同一件事的另一种说法」，
// 但只印一句 ⚠️ 提醒，要不要标 stale 全靠人。长期库里最伤的不是重复措辞，是**旧结论冒充现状**：
// 四条 fact 并排写着「当前版本是 X」，检索时读到哪条算数没有答案。
//
// 为什么在 macro 侧判、而不是把 meow 的那个函数搬过来用：融合层只能通过 `flow.call` 走工具面，
// 拿不到 vendor 的内部函数。所以这里按同一套硬事实（版本号 / 日期 / 状态词 / 数值 / 路径）重写一份判据，
// 用两条判据把「漂移」钉住：①两处正则字面量必须逐字相同（verify 的 as: 块）；
// ②同一批 fixture 在两处跑出同一结论（tools/probe-supersede.mjs 的一致性对照）。
//
// 判据刻意窄（宁可漏，不可误杀）：只报「它写 A，你这次写 B」这种硬事实；相似度门槛 0.3；
// 数值与路径两类还要求逐字重复度 ≥ 0.5——同一句话的改写才比数字，否则「3 条」跟「5 条」到处撞。

export const SUPERSEDE_ROWS = 20
export const SUPERSEDE_MAX = 3
export const SUPERSEDE_SIM = 0.3
export const SUPERSEDE_REPEAT = 0.5

// 与 vendor/meow-memory/lib/index.js:3669-3670 逐字相同（verify 的 as: 块钉着这两行）。
const VERSION_TOKEN = /(?:^|[^\w.])(\d+\.\d+(?:\.\d+){0,2})(?![\w.])/g
const DATE_TOKEN = /(?:^|\D)(\d{4}-\d{2}-\d{2})(?!\d)/g
// 路径：`D:\a\b`、`./x/y`、`tools/foo.mjs` 都收；判据是「同一个文件名、不同目录」。
const PATH_TOKEN = /(?:[A-Za-z]:[\\/]|\.{1,2}[\\/]|[\w.-]+[\\/])[\w.\\/-]+/g
// 数值 + 单位：只说「同一个单位下两个不同的数」，跨单位不比（27 支 vs 26 条不是同一件事）。
const NUM_UNIT = /(\d[\d,]*)\s*(支|条|个|次|毫秒|ms|秒|%|B|KB|MB)/g
const DONE_WORDS = ['已落地', '已完成', '已合并', '已修复', '已上线', '开着', '启用着']
const TODO_WORDS = ['未开始', '未做', '未落地', '还没做', '关着', '禁用']

function numOf(text) {
  const n = Number(String(text).replace(/,/g, ''))
  return Number.isFinite(n) ? n : null
}

function basenameOf(path) {
  const parts = String(path).split(/[\\/]/).filter((one) => one !== '' && one !== '.' && one !== '..')
  return parts.length === 0 ? '' : parts[parts.length - 1]
}

export function tokensOf(text) {
  const s = String(text ?? '')
  const versions = new Set()
  const dates = new Set()
  const nums = new Map()
  const bases = new Map()
  let m
  VERSION_TOKEN.lastIndex = 0
  while ((m = VERSION_TOKEN.exec(s))) versions.add(m[1])
  DATE_TOKEN.lastIndex = 0
  while ((m = DATE_TOKEN.exec(s))) dates.add(m[1])
  NUM_UNIT.lastIndex = 0
  while ((m = NUM_UNIT.exec(s))) {
    const unit = m[2]
    const value = numOf(m[1])
    if (value === null) continue
    if (!nums.has(unit)) nums.set(unit, new Set())
    nums.get(unit).add(value)
  }
  PATH_TOKEN.lastIndex = 0
  while ((m = PATH_TOKEN.exec(s))) {
    const path = m[0].replace(/[.。，,;；:：]+$/, '')
    const base = basenameOf(path)
    if (base === '') continue
    if (!bases.has(base)) bases.set(base, new Set())
    bases.get(base).add(path)
  }
  return { versions, dates, nums, bases }
}

const only = (x, y) => [...x].filter((v) => !y.has(v))

function stateOf(text) {
  const s = String(text ?? '')
  const done = DONE_WORDS.find((w) => s.includes(w))
  const todo = todoHit(s)
  if (done && !todo) return { side: 'done', word: done }
  if (todo && !done) return { side: 'todo', word: todo }
  return null
}

function todoHit(s) {
  return TODO_WORDS.find((w) => s.includes(w))
}

// 返回 null 或 { kind, mine, theirs }：mine 是「这次写的」，theirs 是「库里那条写的」。
export function conflictOf(content, oldText) {
  const A = tokensOf(content)
  const B = tokensOf(oldText)
  // 版本号：两侧都有、且各不相同。
  const mineV = only(A.versions, B.versions)
  const theirV = only(B.versions, A.versions)
  if (mineV.length > 0 && theirV.length > 0) return { kind: '版本', mine: mineV, theirs: theirV }
  // 日期：同上。
  const mineD = only(A.dates, B.dates)
  const theirD = only(B.dates, A.dates)
  if (mineD.length > 0 && theirD.length > 0) return { kind: '日期', mine: mineD, theirs: theirD }
  // 状态词反转：一边说做完了、另一边说没做——这是结论互斥，比数字更要紧。
  const a = stateOf(content)
  const b = stateOf(oldText)
  if (a && b && a.side !== b.side) return { kind: '状态', mine: [a.word], theirs: [b.word] }
  // 数值：同一个单位、两侧都有、集合不相交。
  for (const [unit, setA] of A.nums) {
    const setB = B.nums.get(unit)
    if (!setB || setB.size === 0) continue
    const mineN = only(setA, setB)
    const theirN = only(setB, setA)
    if (mineN.length > 0 && theirN.length > 0) {
      return { kind: '数值', unit, mine: mineN.map(String), theirs: theirN.map(String) }
    }
  }
  // 路径：同一个文件名、不同目录（「同一主语换了地方」）。
  for (const [base, setA] of A.bases) {
    const setB = B.bases.get(base)
    if (!setB || setB.size === 0) continue
    const mineP = only(setA, setB)
    const theirP = only(setB, setA)
    if (mineP.length > 0 && theirP.length > 0) return { kind: '路径', mine: [...mineP], theirs: [...theirP] }
  }
  return null
}

export function supersedeMode(config = {}) {
  const raw = config?.autoSupersede
  // 与 consolidateMode 同一条纪律：没配就是默认那一档（suggest）；显式写错退到 off（不动库最安全）。
  if (raw === undefined || raw === null) return 'suggest'
  const mode = typeof raw === 'string' ? raw.trim().toLowerCase() : ''
  return mode === 'off' || mode === 'suggest' || mode === 'apply' ? mode : 'off'
}

export function conflictCandidatesOf({ hits = [], content = '', newId = '', skipIds = [], max = SUPERSEDE_MAX } = {}) {
  const skip = new Set([newId, ...skipIds].filter((one) => typeof one === 'string' && one !== ''))
  const out = []
  for (const h of hits) {
    if (!h || typeof h.id !== 'string' || h.id === '') continue
    // 人已经点名要取代的那几条不重复建议——短 id 与完整 id 两种写法都认。
    if (skip.has(h.id) || skip.has(h.id.slice(0, 8))) continue
    const sim = Number(h.similarity ?? h.sim ?? NaN)
    if (!Number.isFinite(sim) || sim < SUPERSEDE_SIM) continue
    const rep = Number(h.repeat ?? NaN)
    const c = conflictOf(content, String(h.content ?? ''))
    if (!c) continue
    // 数值与路径两类天生容易撞（「3 条」「tools/x.mjs」满库都是），要求两条本来就是同一句话的改写。
    if ((c.kind === '数值' || c.kind === '路径') && !(Number.isFinite(rep) && rep >= SUPERSEDE_REPEAT)) continue
    out.push({
      id: h.id,
      id8: h.id.slice(0, 8),
      level: String(h.level ?? ''),
      sim: Math.round(sim * 1e3) / 1e3,
      repeat: Number.isFinite(rep) ? Math.round(rep * 1e3) / 1e3 : null,
      kind: c.kind,
      mine: c.mine,
      theirs: c.theirs,
    })
  }
  out.sort((a, b) => b.sim - a.sim)
  return out.slice(0, max)
}

function oneLine(c) {
  const mine = c.mine.join('/')
  const theirs = c.theirs.join('/')
  const unit = c.unit ? `${c.unit} ` : ''
  const where = c.level ? `${c.level} ` : ''
  return `- ${where}${c.id8}（${c.kind}）：它写 ${unit}${theirs}，你这次写 ${unit}${mine}`
}

export function supersedeSuggestNote(cands = []) {
  if (cands.length === 0) return ''
  const lines = [
    `⚠️ 这几条像是同一件事的旧说法（autoSupersede: suggest——只建议，一个字没动库）：`,
    ...cands.map(oneLine),
    `确认要被取代就重写一次带 supersedes: [${cands.map((c) => `'${c.id8}'`).join(', ')}]（旧条会标 stale 并留一句「已被取代」，不删除）；若说的是不同对象，忽略这段。`,
  ]
  return lines.join('\n')
}

// apply 态：真正动库前先说清「要动谁、为什么」，动完由调用方把 markSuperseded 的结果接在后面。
export function supersedeApplyLead(cands = []) {
  if (cands.length === 0) return ''
  return [
    `自动取代（autoSupersede: apply）：${cands.length} 条旧说法要被降格（不删除，可 memory_update(status:'active') 反悔）`,
    ...cands.map(oneLine),
  ].join('\n')
}

// 打一枪同层近邻检索（internal: true：这是我自己判「要不要取代」用的，不替用户记账、不抬召回次数）。
export async function supersedeAdvice({ flow, exec, content = '', project = '', level = '', keywords = [], newId = '', skipIds = [] } = {}) {
  const words = [...new Set((Array.isArray(keywords) ? keywords : []).map((k) => String(k).trim()).filter(Boolean))]
  const query = words.length > 0 ? words.join(' ') : String(content).slice(0, 60).trim()
  if (query === '') return []
  const base = { query, level: level || 'fact', k: SUPERSEDE_ROWS, status: 'active', content_max: 0, internal: true }
  const proj = typeof project === 'string' ? project.trim() : ''
  if (proj !== '') base.project = proj
  const got = await flow.tryCall('memory_search', base, exec, '取代检查：同层近邻')
  const hits = Array.isArray(got?.value?.hits) ? got.value.hits : []
  return conflictCandidatesOf({ hits, content, newId, skipIds })
}
