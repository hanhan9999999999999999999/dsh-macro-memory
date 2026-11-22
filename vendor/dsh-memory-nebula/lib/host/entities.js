/**
 * 实体层（P4）：把「同一件事的锚点」从记忆里单独抽出来，供星图按实体找。
 *
 * [macro-fusion 0.4.0] 这一段是我们加的，不在上游 dsh-memory-nebula 里；
 * 上游升级会整文件覆盖，冲掉之后召回不会报错、只会静默退回「只按词面找邻居」。
 *
 * 为什么单独成层，而不是把实体做成节点：
 *  - `nodes` 是「记忆」的口径：度数、聚类、orphans、面板条数、召回结果位全按它算。
 *    混进实体节点，`1804 条记忆` 会变成 `2200 条`，召回还得处处过滤——等于给每次读数
 *    加一个「这算不算记忆」的判断题。
 *  - 回滚只要一条配置：读层关掉，图里就当它不存在，一条记忆都不用重写、不用重建。
 *
 * 只收四类（都是硬事实，不是语义猜测）：
 *  - `project`：记忆自带的 `project` 字段（人写的，最可信）
 *  - `path`：`D:\x\y.js` / `lib/macro/defs/search.js:67` 这种带行号的文件路径
 *  - `tool`：`memory_search` / `nebula_recall` 这类工具名
 *  - `version`：`0.4.0` 这种三段版本号
 *
 * 刻意不收：人名、机构名、普通名词。那些要靠分词与统计，抽错一次就把两条无关记忆连上，
 * 而星图的错边比缺边贵得多——缺边只是少一条路，错边会让「关于 X 的一切」混进别的东西。
 */

/** 只有被 ≥2 条记忆共享的实体才进层：只出现一次的「实体」是索引噪声，只涨体积。 */
export const ENTITY_MIN_MEMBERS = 2
/** 层的上限：再多就不叫「锚点」了。按成员数排前 400 个。 */
export const ENTITY_MAX = 400
/** 实体当种子时的能量：低于文本种子（1.0），高于「弱关联」（0.2 以下会被当噪声）。 */
export const ENTITY_SEED = 0.6
/** 一条记忆最多贡献几个实体当种子（防「一条水词很多的记忆」把半个图点亮）。 */
export const ENTITY_PER_NODE = 6
/** 实体名短于这个长度不参与「查询里含实体名」的包含匹配（`0.4` 这种太短）。 */
export const ENTITY_MIN_LABEL = 4

/** 实体层收的类型（与 text.js 的 `type|value` 键前缀对齐）。 */
export const ENTITY_KINDS = new Set(['project', 'path', 'tool', 'version'])

/**
 * 带盘符或 ≥2 段斜杠的文件路径，末尾可带 `:行号`。
 * 例：`d:\a\b\c.js`、`lib/macro/defs/search.js:67`、`./docs/PLAN-0.4.md`
 */
const PATH_RE = /(?:[a-z]:[\\/]|\.{1,2}[\\/]|(?:^|[\s(（`'"[{])[\w@.-]+[\\/])[\w@.\\/-]{2,}\.(?:js|mjs|cjs|ts|tsx|jsx|json|jsonc|md|mdx|py|rs|go|java|kt|cs|cpp|cc|h|hpp|sql|yml|yaml|toml|ini|cfg|sh|ps1|bat|cmd|html|css|db|sqlite|log)(?::\d{1,5})?/g

/** 工具名：`memory_*` / `nebula_*` 这类下划线命名的专名。 */
const TOOL_RE = /\b(?:memory|nebula|macro|dsh)_[a-z][a-z0-9_]{2,28}\b/g

/** 版本号：三段或四段，`v` 前缀可有。 */
const VERSION_RE = /\bv?\d+\.\d+\.\d+(?:-[0-9a-z.]{1,12})?\b/g

/** 尾巴上的标点剪掉（路径后面常跟着逗号、右括号）。 */
function trimTail(s) {
  let end = s.length
  while (end > 0) {
    const c = s.charCodeAt(end - 1)
    if (c === 44 || c === 46 || c === 59 || c === 58 || c === 41 || c === 93 || c === 125 || c === 34 || c === 39 || c === 96 || c === 92) end--
    else break
  }
  return end === s.length ? s : s.slice(0, end)
}

/**
 * 从一条记忆里抽四类实体。
 * @param {object} node buildGraph 产出的节点（有 `blob` 小写全文与 `project` 字段）
 * @returns {Map<string,string>} `type|value` -> type
 */
export function entitiesOfNode(node) {
  const out = new Map()
  const put = (type, raw) => {
    const v = trimTail(String(raw || '').trim().toLowerCase())
    if (v.length < ENTITY_MIN_LABEL) return
    if (type === 'version' && !/^\d+\.\d+\.\d+/.test(v.replace(/^v/, ''))) return
    out.set(type + '|' + v, type)
  }
  const project = typeof node?.project === 'string' ? node.project.trim() : ''
  if (project) put('project', project)
  const blob = typeof node?.blob === 'string' ? node.blob : ''
  if (blob) {
    for (const m of blob.matchAll(PATH_RE)) put('path', m[0])
    for (const m of blob.matchAll(TOOL_RE)) put('tool', m[0])
    for (const m of blob.matchAll(VERSION_RE)) put('version', m[0])
  }
  return out
}

/**
 * 建整层：哪些实体被哪几条记忆提到。
 *
 * @param {object[]} nodes buildGraph 的节点（已带 `i` 下标与 `blob`）
 * @param {{minMembers?:number,max?:number}} [opts]
 * @returns {{list:object[],byKey:Map<string,object>,byNode:Map<number,string[]>,stats:object}}
 */
export function collectEntities(nodes, opts = {}) {
  const minMembers = opts.minMembers ?? ENTITY_MIN_MEMBERS
  const max = opts.max ?? ENTITY_MAX
  /** @type {Map<string,{key:string,type:string,label:string,members:number[]}>} */
  const byKey = new Map()
  /** @type {Map<number,string[]>} */
  const byNode = new Map()

  for (const node of nodes || []) {
    if (!node || typeof node.i !== 'number') continue
    const ents = entitiesOfNode(node)
    const mine = []
    for (const [key, type] of ents) {
      const cut = key.indexOf('|')
      const label = cut < 0 ? key : key.slice(cut + 1)
      let rec = byKey.get(key)
      if (!rec) {
        rec = { key, type, label, members: [] }
        byKey.set(key, rec)
      }
      rec.members.push(node.i)
      mine.push(key)
    }
    if (mine.length) byNode.set(node.i, mine)
  }

  // 成员数不够的整条丢掉（只在一条记忆里出现 = 索引噪声）
  const list = [...byKey.values()].filter((e) => e.members.length >= minMembers)
  list.sort((a, b) => b.members.length - a.members.length || a.label.localeCompare(b.label))
  const kept = list.slice(0, max)
  const keepKeys = new Set(kept.map((e) => e.key))
  const byKeyKept = new Map(kept.map((e) => [e.key, e]))

  // byNode 也收紧到留下的实体；并且每条记忆最多 ENTITY_PER_NODE 个（按实体成员数降序）
  /** @type {Map<number,string[]>} */
  const byNodeKept = new Map()
  for (const [i, keys] of byNode) {
    const alive = keys.filter((k) => keepKeys.has(k))
    if (!alive.length) continue
    alive.sort((a, b) => (byKeyKept.get(b)?.members.length || 0) - (byKeyKept.get(a)?.members.length || 0))
    byNodeKept.set(i, alive.slice(0, ENTITY_PER_NODE))
  }

  const byType = {}
  for (const e of kept) byType[e.type] = (byType[e.type] || 0) + 1

  return {
    list: kept,
    byKey: byKeyKept,
    byNode: byNodeKept,
    stats: {
      entities: kept.length,
      dropped: byKey.size - kept.length,
      byType,
      mentioned: byNodeKept.size,
    },
  }
}

/**
 * 从 `list` 重建索引（`byKey` / `byNode`）。
 *
 * 为什么要这一步：图的缓存是 JSON——Map 存不住，落盘再读回来只剩 `list`。
 * 400 个实体的索引重建是微秒级，比给缓存加一套 Map 序列化协议便宜得多，
 * 也让「盘上读回来的图」与「刚建好的图」走同一条代码。
 */
export function indexOf(layer) {
  const byKey = new Map()
  const byNode = new Map()
  for (const e of layer?.list || []) {
    byKey.set(e.key, e)
    for (const i of e.members || []) {
      const arr = byNode.get(i)
      if (arr) arr.push(e.key)
      else byNode.set(i, [e.key])
    }
  }
  return { byKey, byNode }
}

/** 拿到可用的索引：已在就用，缺了现建。 */
export function ensureLayer(layer) {
  if (!layer || !Array.isArray(layer.list)) return null
  if (layer.byKey instanceof Map) return layer
  return { ...layer, ...indexOf(layer) }
}

/**
 * 查询里出现了哪些实体名？命中的实体把成员节点全带上。
 *
 * 匹配规则故意保守：要求「查询里包含完整的实体名」（label 在 query 里，且 label ≥ 4 字）。
 * 反向包含（query 在 label 里）只在 query ≥ 3 字时允许——否则问「星图」会把
 * `nebula_recall` 之类的长实体全拉进来，把一次精确提问变成一次泛泛扩散。
 *
 * @param {string} query
 * @param {object} layer collectEntities 的产物
 * @param {{limit?:number}} [opts]
 * @returns {{i:number,key:string,label:string,type:string,members:number,weight:number}[]}
 */
export function entitySeedsOf(query, layer, opts = {}) {
  const q = String(query || '').trim().toLowerCase()
  const ready = ensureLayer(layer)
  if (!q || !ready || ready.list.length === 0) return []
  const limit = Math.max(1, Math.min(20, opts.limit ?? 8))
  const out = []
  for (const e of ready.list) {
    const label = e.label
    if (label.length < ENTITY_MIN_LABEL) continue
    const forward = q.includes(label)
    const backward = !forward && q.length >= 3 && label.includes(q)
    if (!forward && !backward) continue
    // 正向命中（查询里点名了这个实体）比反向（只沾到一段）可信
    const weight = forward ? 1 : 0.6
    out.push({ i: -1, key: e.key, label, type: e.type, members: e.members.length, weight })
  }
  out.sort((a, b) => b.weight - a.weight || b.members - a.members)
  return out.slice(0, limit)
}

/**
 * 让实体种子落到具体节点上（查询命中的实体 → 它的成员）。
 * @param {object[]} hits entitySeedsOf 的结果
 * @param {object} layer
 * @returns {{i:number,key:string,label:string,energy:number}[]}
 */
export function entitySeedNodes(hits, layer) {
  const ready = ensureLayer(layer)
  const out = []
  const seen = new Set()
  for (const hit of hits || []) {
    const rec = ready?.byKey?.get(hit.key)
    if (!rec) continue
    for (const i of rec.members) {
      if (seen.has(i)) continue
      seen.add(i)
      out.push({ i, key: hit.key, label: rec.label, energy: ENTITY_SEED * (hit.weight || 1) })
    }
  }
  return out
}
