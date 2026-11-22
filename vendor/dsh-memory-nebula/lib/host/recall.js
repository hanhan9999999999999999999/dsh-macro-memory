/**
 * 扩散激活检索（spreading activation）—— 星图的「神经元」那一半。
 *
 * 朴素 RAG：query → top-k 记忆。这里不是。
 * 这里：query → 种子节点（直接命中）→ 沿星图上的边衰减扩散 → 二次命中。
 * 于是「项目 A 里记的事」能把「项目 B 里记的另一半」一起带出来，
 * 并且每条带出来的记忆都会附上「为什么带它出来」的证据链。
 */
import { tokenize, idf, clip } from './text.js'
// [macro-fusion 0.4.0 · P4] 实体层：查询里点了名（比如「memory_search 的 budget 怎么算」）
// 就把那个实体下面的记忆全带上。它只加种子能量，不改 nodes/edges，关掉不留痕。
import { entitySeedsOf, entitySeedNodes } from './entities.js'

/** 扩散衰减系数：一跳打这个折，二跳再打一次。 */
const HOP_DECAY = 0.58
/** 最多扩散几跳。 */
const MAX_HOPS = 2
/** 每跳最多从多少个高能节点继续传。 */
const FRONTIER_WIDTH = 110
/**
 * [macro-fusion 0.4.0 · P4] 动态跳数的门槛：目标节点与查询的词面重合低于这个值，
 * 第二跳就不再走过去。0.2 = 六个词里至少沾一个。
 * 这条门槛只在 hop≥1 生效：第一跳是「直接邻居」，那是星图最基本的语义，不该被砍。
 */
const DYNAMIC_MIN_MATCH = 0.2
/**
 * [macro-fusion 0.4.0 · P4] 硬边：这些边本身就是「同一件事」的证据（人工策展、同一标识、
 * 跨工作区同项目），不需要再看词面。动态跳数只对软边（关键词/语义/共激活）要求匹配——
 * 否则「这条记忆写的是半个句子」会被当成「没关系」，把真正的另一半砍掉。
 */
const HARD_EDGE = new Set(['explicit', 'entity', 'project'])

/**
 * 归一化一组 memory id：允许传完整 node id，也允许传 meow 的裸 uid。
 * @param {object[]} nodes
 * @param {string[]} ids
 */
const TOKEN_CACHE = new WeakMap()
// 正在算的那一趟（同一个 graph 只允许一趟，见 ensureTokenCacheAsync）
const TOKEN_INFLIGHT = new WeakMap()
const ADJ_CACHE = new WeakMap()

/**
 * 词频表（生成器）：每 6ms 让一次，5 万条上整段约 1.3 秒。
 * 结果挂进 TOKEN_CACHE，同步壳与异步壳共用同一份。
 */
function* tokenCacheSteps(graph) {
  const nodes = graph.nodes || []
  const n = nodes.length
  const hit = TOKEN_CACHE.get(graph)
  if (hit && hit.n === n) return hit
  const df = new Map()
  const tokensOf = new Array(n)
  let sliceAt = Date.now()
  for (let i = 0; i < n; i++) {
    const node = nodes[i]
    // buildGraph 产出的节点已经带 tokens（title/正文/项目/关键词），直接复用；
    // 手工构造的图（测试、demo）没有，就现场分一次词。
    const bag = node.tokens instanceof Set ? node.tokens : new Set()
    if (!bag.size) {
      for (const k of node.keywords || []) bag.add(String(k).toLowerCase())
      const body = String(node.content || node.preview || node.label || '')
      for (const t of tokenize(node.title || '')) bag.add(t)
      for (const t of tokenize(body)) bag.add(t)
      for (const t of tokenize(node.project || '')) bag.add(t)
    }
    tokensOf[i] = bag
    for (const t of bag) df.set(t, (df.get(t) || 0) + 1)
    if (Date.now() - sliceAt >= 6) {
      sliceAt = Date.now()
      yield 'tokens'
    }
  }
  const value = { n, df, tokensOf }
  TOKEN_CACHE.set(graph, value)
  return value
}

/** 同步壳：一次跑完。 */
/**
 * 这张图的词频表算好了吗。
 *
 * 只给单测与探针用：预热是后台行为，界面上无从观察，测试得能问一句「好了没」。
 * @param {object} graph
 */
export function tokenCacheReady(graph) {
  return TOKEN_CACHE.has(graph)
}

export function ensureTokenCache(graph) {
  const it = tokenCacheSteps(graph)
  let r = it.next()
  while (!r.done) r = it.next()
  return r.value
}

/**
 * 异步壳：每次 yield 后 setImmediate，事件循环不被按住。
 *
 * 正在算的时候再有人要（后台预热还没算完，用户就先搜了），**共用同一趟**：
 * 以前这里每叫一次就从头再跑一遍，于是「预热正在进行 + 第一次搜索」是两份全量分词在抢 CPU，
 * 五万条要 3.5 秒（1.11.33 修：单趟 1.3 秒、两趟互相拖到 3.5 秒）。
 */
export function ensureTokenCacheAsync(graph) {
  const done = TOKEN_CACHE.get(graph)
  if (done) return Promise.resolve(done)
  const running = TOKEN_INFLIGHT.get(graph)
  if (running) return running
  const p = (async () => {
    const it = tokenCacheSteps(graph)
    let r = it.next()
    while (!r.done) {
      await new Promise((resolve) => setImmediate(resolve))
      r = it.next()
    }
    return r.value
  })()
  TOKEN_INFLIGHT.set(graph, p)
  // 注意这里是普通函数、不是 async：async 会给每个调用包一层新 promise，
  // 那样「两处同时要」虽然只算一遍，却拿到两个不同的 promise（单测就抓到了这一点）。
  const clear = () => {
    if (TOKEN_INFLIGHT.get(graph) === p) TOKEN_INFLIGHT.delete(graph)
  }
  p.then(clear, clear)
  return p
}

/**
 * 异步检索：先把词频表分片灌满，再走同步逻辑。
 * 第一次查 5 万条的库时，这一步原本会整段按住 1.3 秒。
 */
export async function recallAsync(graph, query, opts = {}) {
  await ensureTokenCacheAsync(graph)
  return recall(graph, query, opts)
}

export function resolveIds(nodes, ids) {
  const out = []
  const byId = new Map()
  const byUid = new Map()
  for (const node of nodes) {
    byId.set(node.id, node)
    const list = byUid.get(node.id.split(':').pop())
    if (list) list.push(node)
    else byUid.set(node.id.split(':').pop(), [node])
  }
  for (const raw of ids || []) {
    const key = String(raw || '').trim()
    if (!key) continue
    if (byId.has(key)) {
      out.push(byId.get(key))
      continue
    }
    const list = byUid.get(key)
    if (list && list.length === 1) out.push(list[0])
    else if (list && list.length > 1) out.push(list[0]) // 同一 id 多库时取第一个，够用
  }
  return out
}

/**
 * 文本打分的字段权重：标题/关键词命中比正文命中更有指向性。
 */
const FIELD_WEIGHT = { title: 3, keyword: 2.6, project: 1.8, entity: 2.2, content: 1 }

/**
 * 扩散激活检索。
 *
 * @param {object} graph  buildGraph 的产物
 * @param {string} query
 * @param {object} [opts]
 * @param {number} [opts.limit=12]
 * @param {string[]} [opts.seedIds]  外部工具返回的记忆 id（会当成满能种子）
 * @param {number} [opts.hops=2]
 * @param {boolean} [opts.crossWorkspace=true]
 * @param {string[]} [opts.exclude]  需要排除的 id
 */
export function recall(graph, query, opts = {}) {
  const nodes = graph.nodes || []
  const edges = graph.edges || []
  const limit = Math.max(1, Math.min(50, opts.limit || 12))
  const hops = Math.max(0, Math.min(3, opts.hops ?? MAX_HOPS))
  const crossWorkspace = opts.crossWorkspace !== false
  const exclude = new Set(opts.exclude || [])
  // [macro-fusion 0.2.9] 归档/删除的记忆不该再作为检索结果出现。
  // 与 bridge.js 的 statusFactor（active 1 / stale 0.7 / archived 0）同一条口径：
  // 归档等于「用户说这条不用了」，但它仍然可以被 hygiene、nebula_inspect 按 id 看到，
  // 也仍然能在扩散时当中转（见 §4），只是不许自己占一个结果位。
  const includeInactive = opts.includeInactive === true
  /** 这条记忆能不能占一个检索结果位／当种子。 */
  const selectable = (node) => {
    if (includeInactive) return true
    const st = String(node.status ?? 'active').toLowerCase()
    return st !== 'archived' && st !== 'deleted'
  }

  const n = nodes.length
  const energy = new Float64Array(n)
  const seedE = new Float64Array(n)
  /** @type {(null|{from:number,type:string,w:number})[]} */
  const via = new Array(n).fill(null)
  const matchedTerms = new Array(n).fill(null)

  // 词频表只跟这张图有关：同一张图会被连续查很多次，
  // 每次重新分词/建邻接等于把 1 万条记忆重读一遍。用 WeakMap 挂在图上，
  // 图重建（新对象）时自然失效，不会读到上一版的数据。
  // 5 万条上这一次要 1.3 秒，所以它也是分片的：异步壳先把它灌满再查。
  const { df, tokensOf } = ensureTokenCache(graph)
  const weightOf = (t) => idf(df.get(t) || 1, Math.max(2, n))

  // ---------- 1. 文本种子 ----------
  const qTokens = tokenize(query || '')
  let unknownTerms = []
  if (qTokens.size > 0) {
    // 语料里根本没有的词（比如刚起名的项目）不参与覆盖率分母，
    // 否则一个「谁都没提过」的词会把整条查询的命中率压成 0。
    const qList = [...qTokens].filter((t) => (df.get(t) || 0) > 0)
    // «短语» 这种合成 token 只用于标题整串加权，不该出现在「没见过的词」里
    const unknownTermsLocal = [...qTokens].filter((t) => !t.startsWith('«') && (df.get(t) || 0) === 0)
    unknownTerms = unknownTermsLocal
    const knownRatio = qTokens.size > 0 ? qList.length / qTokens.size : 0
    const totalWeight = qList.reduce((sum, t) => sum + weightOf(t), 0) || 1
    const qLower = String(query || '').toLowerCase().trim()
    /** @type {Array<{i:number,coverage:number,score:number,matched:string[]}>} */
    const cands = []
    for (let i = 0; i < n; i++) {
      const node = nodes[i]
      if (!selectable(node)) continue // [macro-fusion 0.2.9] 归档的不当种子
      const bag = tokensOf[i]
      const matched = []
      let matchedWeight = 0
      for (const t of qList) {
        if (!bag.has(t)) continue
        matchedWeight += weightOf(t)
        matched.push(t)
      }
      if (matched.length === 0) continue
      const coverage = matchedWeight / totalWeight
      // 覆盖率：只命中查询里的一个小词，不该被当成强种子
      let score = Math.pow(coverage, 1.35) * (0.55 + 0.45 * knownRatio)
      const titleText = String(node.title || node.label || '').toLowerCase()
      if (qLower.length >= 3 && titleText.includes(qLower)) score += 0.22
      // 稀有词恰好落在 keywords 里，是强提示
      for (const k of node.keywords || []) {
        if (qTokens.has(String(k).toLowerCase())) {
          score += 0.12
          break
        }
      }
      cands.push({ i, coverage, score: Math.min(1, score), matched })
    }

    // 阈值分级：先严后松，保证「查得到」但不让一个通用词污染整张网。
    const tiers = qList.length <= 3 ? [0.5, 0.34, 0.2] : [0.32, 0.22, 0.12]
    let chosen = []
    for (const tier of tiers) {
      chosen = cands.filter((c) => c.coverage >= tier)
      if (chosen.length >= 3) break
    }
    if (chosen.length === 0) chosen = cands.slice()
    chosen.sort((a, b) => b.score - a.score)
    chosen = chosen.slice(0, 80)
    for (const c of chosen) {
      seedE[c.i] = c.score
      energy[c.i] = c.score
      matchedTerms[c.i] = c.matched.slice(0, 6)
    }
  }

  // ---------- 2. 外部种子（别的记忆工具刚查出来的） ----------
  const seedNodes = resolveIds(nodes, opts.seedIds || [])
  for (const node of seedNodes) {
    const i = node.i
    seedE[i] = Math.max(seedE[i], 1)
    energy[i] = Math.max(energy[i], 1)
    via[i] = via[i] || { from: -1, type: 'seed', w: 1 }
  }

  // ---------- 2.5 来源节点当种子 ----------
  // 查「meow-memory」这种名字时，最该亮起来的是那个来源节点本身，
  // 再由它的 mentions 边把「用过它的记忆」全部带出来。
  const qNorm = String(query || '').trim().toLowerCase()
  if (qNorm) {
    for (let i = 0; i < n; i++) {
      const node = nodes[i]
      if (node.level !== 'source') continue
      const title = String(node.title || node.label || '').toLowerCase()
      if (!title) continue
      const exact = title === qNorm
      const inside = !exact && qNorm.includes(title) && title.length >= 4
      if (!exact && !inside) continue
      const e = exact ? 1 : 0.72
      if (e > seedE[i]) {
        seedE[i] = e
        energy[i] = Math.max(energy[i], e)
        via[i] = via[i] || { from: -1, type: 'seed', w: 1 }
      }
      // 文本种子也可能已经命中它（标题里的词），这里保证它出现在 seeds 列表里，
      // 调用方才知道「这次是从哪个来源炸开的」
      if (seedNodes.indexOf(node) === -1) seedNodes.push(node)
    }
  }

  // ---------- 2.6 实体种子（P4） ----------
  // 「关于 memory_search 的一切」这种问法，词面命中只能捞到正文里恰好写了全名的那几条；
  // 实体层知道哪些记忆共享同一个工具名/路径/项目/版本，一次就能把另一半带上来。
  // 能量比文本种子低（ENTITY_SEED = 0.6）：实体是「同一件事」的证据，但不如「正文直接命中」硬。
  const entityOn = opts.entityLayer !== false && qNorm.length > 0
  const entityHits = entityOn ? entitySeedsOf(query, graph.entityLayer, { limit: 8 }) : []
  const entityPairs = entityHits.length ? entitySeedNodes(entityHits, graph.entityLayer) : []
  /** 实体成员集合：动态跳数用它给「同一实体的邻居」放行。 */
  const entityMember = new Set()
  for (const s of entityPairs) {
    if (!(s.i >= 0 && s.i < n)) continue
    if (entityMember.has(s.i)) continue
    const node = nodes[s.i]
    if (!selectable(node)) continue
    entityMember.add(s.i)
    if (s.energy > seedE[s.i]) {
      seedE[s.i] = s.energy
      energy[s.i] = Math.max(energy[s.i], s.energy)
      via[s.i] = via[s.i] || { from: -1, type: 'entity', w: Math.round(s.energy * 1000) / 1000 }
    }
  }

  // ---------- 3. 邻接表 ----------
  let adjCached = ADJ_CACHE.get(graph)
  if (!adjCached || adjCached.n !== n || adjCached.m !== edges.length) {
    const adj = new Array(n)
    for (let i = 0; i < n; i++) adj[i] = []
    for (let e = 0; e < edges.length; e++) {
      const edge = edges[e]
      adj[edge.s].push({ to: edge.t, w: edge.w, type: edge.type, e })
      adj[edge.t].push({ to: edge.s, w: edge.w, type: edge.type, e })
    }
    adjCached = { n, m: edges.length, adj }
    ADJ_CACHE.set(graph, adjCached)
  }
  const { adj } = adjCached

  // ---------- 4. 扩散 ----------
  const propagate = new Float64Array(n)
  // [macro-fusion 0.4.0 · P4] 动态跳数：不再「跳满 hops 为止」，而是每跳先问
  // 「这个邻居与本次查询还有没有关系」。没有就停——省下的不只是预算，
  // 更是不让第二跳把同项目里那些只因为「同一个工作区」而被连上的记忆一起点亮。
  const dynamicHops = opts.dynamicHops !== false && qTokens.size > 0
  const qCap = Math.max(1, Math.min(qTokens.size, 6))
  const matchOf = (j) => {
    if (entityMember.has(j)) return 1
    const bag = tokensOf[j]
    if (!bag) return 0
    let hit = 0
    for (const t of qTokens) if (bag.has(t)) hit++
    return hit / qCap
  }
  let hopsUsed = 0
  let hopsStopped = ''
  let skipped = 0
  let frontier = []
  for (let i = 0; i < n; i++) if (energy[i] > 0) frontier.push(i)
  frontier.sort((a, b) => energy[b] - energy[a])
  frontier = frontier.slice(0, FRONTIER_WIDTH)

  for (let hop = 0; hop < hops; hop++) {
    const next = new Map()
    for (const from of frontier) {
      const src = nodes[from]
      // [macro-fusion 0.4.0 · P4] 第一跳用种子能量，第二跳起用上一跳给它的那份能量。
      // 原来这里一律读 energy[]，而 energy[] 只在种子里写过——于是第二跳每个节点的 e0 都是 0，
      // 被下面那道 `< 0.06` 直接跳过，next 恒空、循环立刻 break。
      // 也就是说 `hops: 2` 从来没有真的走过第二跳，MAX_HOPS 与「二跳再打一次」的注释都是空的。
      const e0 = hop === 0 ? energy[from] : propagate[from] || 0
      if (e0 < 0.06) continue
      // 来源节点是「标签」不是「记忆」：能量落在它身上是对的（能看出这条记忆用过什么），
      // 但不能让它当一个超级中转站，把 20 多条记忆一视同仁地全点亮。
      const fromDamp = src.level === 'source' ? 0.5 : 1
      for (const link of adj[from]) {
        const target = nodes[link.to]
        if (!crossWorkspace && target.ws !== src.ws) continue
        const damp = target.level === 'source' ? 0.55 : 1
        let gain = e0 * link.w * HOP_DECAY * fromDamp * damp
        if (dynamicHops && !HARD_EDGE.has(link.type)) {
          const m = matchOf(link.to)
          // 第二跳起：与查询毫无词面关系的邻居不再走过去（第一跳不受限，见 DYNAMIC_MIN_MATCH）
          if (hop >= 1 && m < DYNAMIC_MIN_MATCH) {
            skipped++
            if (!hopsStopped) hopsStopped = `跳 ${hop + 1}`
            continue
          }
          // 有关系也不是全给：词面各占一半，剩下的看关系本身
          gain *= 0.45 + 0.55 * m
        }
        if (gain < 0.02) continue
        const prev = next.get(link.to) || 0
        if (gain > prev + 1e-6) {
          next.set(link.to, gain)
          if (!via[link.to] || gain > (propagate[link.to] || 0)) {
            via[link.to] = { from, type: link.type, w: link.w }
          }
        }
        if (propagate[link.to] < gain) propagate[link.to] = gain
      }
    }
    if (next.size === 0) break
    hopsUsed = hop + 1
    frontier = [...next.entries()].sort((a, b) => b[1] - a[1]).slice(0, FRONTIER_WIDTH).map((x) => x[0])
  }

  // ---------- 5. 合成 ----------
  // 跨工作区的桥：同一个项目在不同工作区的记忆，正是「检索 A 连带读出 B」要的东西，
  // 所以给它们一点额外能量，别被本地的强邻居全挤掉。
  const seedWs = new Set()
  for (let i = 0; i < n; i++) if (seedE[i] > 0) seedWs.add(nodes[i].ws)
  // 主工作区 = 最强的那颗种子所在的项目。结果里凡是跑到别的项目去的，
  // 都算「跨工作区」，这样用户一眼能看出「这条不是我这个项目的记忆」。
  let primaryWs = ''
  let bestSeed = 0
  for (let i = 0; i < n; i++) {
    if (nodes[i].ws && seedE[i] > bestSeed) {
      bestSeed = seedE[i]
      primaryWs = nodes[i].ws
    }
  }
  const scored = []
  for (let i = 0; i < n; i++) {
    if (nodes[i].id && exclude.has(nodes[i].id)) continue
    // [macro-fusion 0.2.9] 归档/删除的状态过滤（同 bridge.js statusFactor）
    if (!selectable(nodes[i])) continue
    const direct = seedE[i]
    const spread = propagate[i]
    if (direct <= 0 && spread <= 0) continue
    let total = direct + spread * 0.62
    if (total < 0.05) continue
    // 能量加成仍然只给「种子集合之外的工作区」，避免同一项目里重复计数
    const outsideSeeds = crossWorkspace && seedWs.size > 0 && !seedWs.has(nodes[i].ws)
    if (outsideSeeds) total *= 1.22
    const across = Boolean(primaryWs) && nodes[i].ws !== primaryWs
    scored.push({ i, total, direct, spread, across })
  }
  scored.sort((a, b) => b.total - a.total)

  // 保证结果里至少出现 2 条跨工作区的「另一半」，否则连带读取就名不副实。
  const picked = scored.slice(0, limit)
  if (crossWorkspace && seedWs.size > 0) {
    const have = picked.filter((x) => x.across).length
    if (have < 2) {
      for (const cand of scored) {
        if (picked.length >= limit) break
        if (!cand.across || picked.includes(cand)) continue
        picked.push(cand)
        if (picked.filter((x) => x.across).length >= 2) break
      }
      picked.sort((a, b) => b.total - a.total)
    }
  }

  const hits = picked.map(({ i, total, direct, spread, across }) => {
    const node = nodes[i]
    const link = via[i]
    const chain = []
    if (link && link.from >= 0) {
      const fromNode = nodes[link.from]
      chain.push({
        fromId: fromNode.id,
        fromLabel: fromNode.label || fromNode.title,
        type: link.type,
        weight: link.w,
      })
    }
    return {
      id: node.id,
      uid: node.id.split(':').pop(),
      ws: node.wsTitle,
      level: node.level,
      label: node.label,
      title: node.title,
      preview: clip(node.preview, 220),
      importance: node.importance,
      project: node.project,
      status: node.status,
      keywords: (node.keywords || []).slice(0, 8),
      score: Math.round(total * 1000) / 1000,
      direct: Math.round(direct * 1000) / 1000,
      spread: Math.round(spread * 1000) / 1000,
      why:
        direct > 0.15
          ? across
            ? '直接命中查询词（跨工作区）'
            : '直接命中查询词'
          : link
            ? `经由「${clip(nodes[link.from].label || nodes[link.from].title, 18)}」的${link.type}关联${across ? '跨工作区' : ''}扩散而来`
            : '关联扩散',
      across,
      chain,
    }
  })

  return {
    query: query || '',
    seeds: seedNodes.map((x) => ({ id: x.id, label: x.label })),
    unknown: unknownTerms,
    hits,
    scanned: scored.length,
    // [macro-fusion 0.4.0 · P4] 三个数一起报：命中集、平均跳数、被砍掉的串味邻居。
    // 只看「省了预算」不算数——跳数下降如果伴随命中集下降，那是变笨不是变省。
    hops: { asked: hops, used: hopsUsed, stoppedAt: hopsStopped || null, skippedNeighbors: skipped, dynamic: dynamicHops },
    entities: entityHits.map((x) => ({ label: x.label, type: x.type, members: x.members })),
    // [macro-fusion 0.2.39] 图里一共多少节点：空命中要能分清「图是空的」和「图里真没有」。
    // scanned 是「算进候选的条数」，查询词一个都对不上时它本来就是 0——拿它当凭据会把两种空命中混成一种。
    nodes: n,
  }
}

/**
 * 给外挂工具用：从一批 id 出发，返回「连着它们的记忆」。
 * @param {object} graph
 * @param {string[]} ids
 * @param {number} [limit]
 */
export function neighborsOf(graph, ids, limit = 20) {
  const base = resolveIds(graph.nodes || [], ids)
  if (base.length === 0) return { seeds: [], hits: [] }
  return recall(graph, '', { seedIds: base.map((n) => n.id), limit, hops: 2 })
}
