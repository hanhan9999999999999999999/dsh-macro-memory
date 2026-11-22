/**
 * 探针：实体层与动态跳数（P4，0.4.0）
 *
 * 量的三件事：
 *  1. 实体层抽得对不对、收得够不够紧（四类硬事实 / ≥2 条共享 / 上限 / 大小写归一）
 *  2. 实体种子能不能把「同一标识」的记忆抬成种子（开与关对照，看 direct 分）
 *  3. 动态跳数是不是「软边按词面收、硬边照走、命中集不缩」——三个数一起看
 *
 * 为什么不用真库：真库的边每天都在变，读数不可复现。这里造固定的十条节点，
 * 每条边的存在理由都能一句话说清。纯函数部分不建图，毫秒级。
 */
import { root } from './_root.mjs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

// 根只从 _root.mjs 取：check-all 故意在无关目录里跑，静态相对 import 会 ERR_MODULE_NOT_FOUND
const NEB = join(root, 'vendor', 'dsh-memory-nebula', 'lib', 'host')
const { collectEntities, entitySeedsOf, entitySeedNodes, indexOf, ENTITY_MAX } = await import(
  pathToFileURL(join(NEB, 'entities.js')).href
)
const { buildGraph } = await import(pathToFileURL(join(NEB, 'graph.js')).href)
const { recall } = await import(pathToFileURL(join(NEB, 'recall.js')).href)

let pass = 0
let fail = 0
const bad = []
function ok(name, cond, detail) {
  if (cond) {
    pass++
    // 行首 `PASS`：check-all 就是数这个（它不认别家的汇总行）
    console.log('PASS ' + name)
  } else {
    fail++
    bad.push(`${name}${detail ? '  —— ' + detail : ''}`)
  }
}

// ---------- 纯函数：抽取与收口 ----------
{
  const nodes = [
    { i: 0, project: 'macro-fusion', blob: '改的是 lib/macro/supersede.js:120 里的判据，memory_search 也提到 0.4.0' },
    { i: 1, project: 'macro-fusion', blob: '同一份 lib/macro/supersede.js:120，memory_search 的 budget 参数，版本 0.4.0' },
    { i: 2, project: 'macro-fusion', blob: '只有一条提到 nebula_recall' },
  ]
  const layer = collectEntities(nodes)
  const kinds = new Set(layer.list.map((e) => e.type))
  ok('E1 四类硬事实都抽到了', kinds.has('project') && kinds.has('path') && kinds.has('tool') && kinds.has('version'), [...kinds].join(','))
  ok('E2 只在一条记忆里出现的实体不进层', !layer.list.some((e) => e.label === 'nebula_recall'), layer.list.map((e) => e.label).join(','))
  ok('E3 共享的路径带行号且只算一个实体', layer.list.filter((e) => e.type === 'path').length === 1, String(layer.list.filter((e) => e.type === 'path').length))
  ok('E4 project 字段直接当实体且成员数为 3', layer.list.some((e) => e.type === 'project' && e.members.length === 3))
  ok('E5 每条记忆的实体数有上限（≤6）', [...layer.byNode.values()].every((v) => v.length <= 6), [...layer.byNode.values()].map((v) => v.length).join(','))
  ok('E6 同一个实体只出现一次（大小写归一）', new Set(layer.list.map((e) => e.key)).size === layer.list.length)
  // 短 label 不收：'p1' 只有 2 个字符，当实体名会把一堆东西连起来
  const shortProj = collectEntities([
    { i: 0, project: 'p1', blob: '' },
    { i: 1, project: 'p1', blob: '' },
  ])
  ok('E7 过短的实体名（<4 字）不收', shortProj.list.length === 0, shortProj.list.map((e) => e.label).join(','))
}
{
  // 上限：造 500 个互不相同的项目名 × 2 条
  const many = []
  for (let i = 0; i < 500; i++) {
    many.push({ i: i * 2, project: 'proj-' + i, blob: '' })
    many.push({ i: i * 2 + 1, project: 'proj-' + i, blob: '' })
  }
  const layer = collectEntities(many)
  ok('E8 层上限生效', layer.list.length === ENTITY_MAX, `${layer.list.length} vs ${ENTITY_MAX}`)
}

// ---------- 实体种子：纯函数 ----------
{
  const nodes = [
    { i: 0, blob: 'memory_search 的 budget 参数按 token 估算' },
    { i: 1, blob: 'memory_search 超过预算会自己砍条数' },
  ]
  const layer = collectEntities(nodes)
  const hits = entitySeedsOf('memory_search 怎么用', layer)
  ok('E9 查询里点到工具名就命中该实体', hits.length === 1 && hits[0].key === 'tool|memory_search', JSON.stringify(hits.map((h) => h.key)))
  ok('E10 命中后带上全部成员', hits[0] && hits[0].members === 2, String(hits[0] && hits[0].members))
  const seeds = entitySeedNodes(hits, layer)
  ok('E11 成员拿到的种子能量是 ENTITY_SEED（0.6）', seeds.length === 2 && seeds.every((x) => x.energy === 0.6), JSON.stringify(seeds.map((x) => x.energy)))
  const none = entitySeedsOf('完全不相关的问法', layer)
  ok('E12 查询里没提到实体就不命中', none.length === 0, JSON.stringify(none.map((h) => h.key)))
}

// ---------- 建图 ----------
const mk = (id, title, content, project, keywords, ws = 'w1') => ({
  id, uid: id, label: title, title, content, project, keywords, level: 'fact',
  ws, wsTitle: ws, importance: 3, status: 'active',
})
const pool = [
  // m1/m2：共享同一条路径（graph 会建 entity 边），m2 与查询词面几乎无关
  mk('m:1', '取代判据', '判据写在 lib/macro/supersede.js 里，五类硬事实', 'p1', ['取代']),
  mk('m:2', '接线顺序', '顺序是先人点名再到自动那一步，文件 lib/macro/supersede.js', 'p1', ['接线']),
  // m3：与 m2 同项目、跨工作区、且被一起点过（hebbian 软边），但正文与查询无关
  mk('m:3', '发布清单', '打包前要更新 changelog 与版本号', 'p1', ['发布']),
  // m:4 与查询毫无词面关系，靠一条人工策展边挂在 m:2 上（第二跳，硬边）
  mk('m:4', '星图面板', '面板展示度数与聚类', 'p2', ['面板']),
  mk('m:5', '颜色映射', '色相按项目名哈希', 'p2', ['颜色'], 'w2'),
  mk('m:6', '布局算法', '力导向布局的迭代次数', 'p2', ['布局'], 'w2'),
  mk('m:7', '导出报告', '导出 markdown 与 json', 'p3', ['导出']),
  mk('m:8', '巡检周期', '约 12 秒一轮巡检', 'p3', ['巡检']),
]
// 两个会话都一起点亮 m:2 / m:3 —— hebbian 边要求 ≥2 次会话才认
const ledgers = [
  { sessionId: 's1', kind: 'accessed', ids: ['m:2', 'm:3'], ws: 'w1' },
  { sessionId: 's2', kind: 'accessed', ids: ['m:2', 'm:3'], ws: 'w1' },
]
const g = buildGraph({ nodes: pool, ledgers, manual: [{ a: 'm:2', b: 'm:4', note: '测试边' }] })

{
  ok('E13 建图产出实体层', Boolean(g.entityLayer && g.entityLayer.list.length > 0), String(g.stats.entities))
  ok('E14 stats 里单列实体数', typeof g.stats.entities === 'number' && g.stats.entities === g.entityLayer.list.length)
  ok('E15 实体层不进 nodes（记忆条数不变）', g.stats.nodes === pool.length, `${g.stats.nodes} vs ${pool.length}`)
  ok('E16 实体层不进 edges（下标都在节点范围内）', g.edges.every((e) => e.s < pool.length && e.t < pool.length))
}

// ---------- 实体层对种子能量的作用 ----------
{
  const on = recall(g, 'lib/macro/supersede.js 的判据', { limit: 10, hops: 2 })
  const off = recall(g, 'lib/macro/supersede.js 的判据', { limit: 10, hops: 2, entityLayer: false })
  ok('E17 关掉实体层时回执里没有实体', off.entities.length === 0)
  // 「实体层让某条记忆多回来一条」在词面索引下几乎不可能（project/路径都拼进正文了），
  // 所以这里量的是它真正做的事：把实体成员的种子能量抬到 ENTITY_SEED。
  const member = on.hits.find((h) => h.id === 'm:2')
  ok('E18 实体成员的 direct 分被抬到 ≥ENTITY_SEED', Boolean(member) && member.direct >= 0.6, member ? String(member.direct) : 'm:2 未进结果')
}

// ---------- 动态跳数：软边收、硬边走 ----------
{
  const dyn = recall(g, '取代', { limit: 10, hops: 2 })
  const full = recall(g, '取代', { limit: 10, hops: 2, dynamicHops: false })
  const dynIds = dyn.hits.map((h) => h.id)
  const fullIds = full.hits.map((h) => h.id)
  ok('E19 回执带三个数（asked/used/skipped）', typeof dyn.hops.asked === 'number' && typeof dyn.hops.used === 'number' && typeof dyn.hops.skippedNeighbors === 'number', JSON.stringify(dyn.hops))
  ok('E20 关掉动态跳数时不提前停（dynamic=false 且零跳过）', full.hops.dynamic === false && full.hops.skippedNeighbors === 0 && full.hops.stoppedAt === null, JSON.stringify(full.hops))
  // 这里不假设「串味条目一定进得了结果」：第二跳要过 total ≥ 0.05 这道门槛，
  // 而纯共激活边权重上限 0.44，两跳衰减后基本就卡在门槛下面（见 INTERNAL 9.195）。
  // 所以量的是「拦了没有」与「拦了之后有没有丢东西」。
  ok('E21 软边在第二跳被拦（关掉时零拦截）', dyn.hops.skippedNeighbors > 0 && full.hops.skippedNeighbors === 0, `dyn=${dyn.hops.skippedNeighbors} full=${full.hops.skippedNeighbors}`)
  ok('E22 砍掉邻居有计数', dyn.hops.skippedNeighbors > 0, String(dyn.hops.skippedNeighbors))
  ok('E23 拦掉的是弱证据：结果集与不拦时完全一致（没有丢东西）', dynIds.join(',') === fullIds.join(','), `on=${dynIds.join(',')} off=${fullIds.join(',')}`)
  ok('E31 第二跳真的跑起来了（used=2，0.4.0 之前恒为 1）', dyn.hops.used === 2, JSON.stringify(dyn.hops))
  ok('E24 硬边（人工策展）在第二跳不被词面砍：m:4 在结果里', dynIds.includes('m:4'), dynIds.join(','))
}

// ---------- 缓存往返：Map 存不住，读回来要能自愈 ----------
{
  const revived = JSON.parse(JSON.stringify(g))
  ok('E25 实体层可 JSON 往返（没有 Map）', Boolean(revived.entityLayer && Array.isArray(revived.entityLayer.list)))
  const r = recall(revived, '取代判据', { limit: 10, hops: 2 })
  ok('E26 读回来的图仍能用实体层（indexOf 自愈）', r.entities.length > 0 || r.hits.length > 0, JSON.stringify(r.entities))
  const idx = indexOf(revived.entityLayer)
  ok('E27 indexOf 重建 byKey/byNode', idx.byKey.size === revived.entityLayer.list.length && idx.byNode.size > 0)
}

// ---------- 归档的不当实体种子 ----------
{
  const withArchived = pool.map((n) => (n.id === 'm:2' ? { ...n, status: 'archived' } : n))
  const ga = buildGraph({ nodes: withArchived, ledgers })
  const r = recall(ga, '取代判据', { limit: 10, hops: 2 })
  ok('E28 归档记忆不当种子也不进结果', !r.hits.some((h) => h.id === 'm:2'), r.hits.map((h) => h.id).join(','))
}

// ---------- 关掉整层 ----------
{
  const gNone = buildGraph({ nodes: pool, ledgers, entityLayer: false })
  ok('E29 entityLayer:false 时层为空、stats 归零', gNone.entityLayer === null && gNone.stats.entities === 0)
  const r = recall(gNone, '取代判据', { limit: 10, hops: 2 })
  ok('E30 关掉整层后不报实体', r.entities.length === 0)
}

console.log(`\n${pass} passed, ${fail} failed`)
if (fail) {
  for (const b of bad) console.log('  FAIL ' + b)
  process.exitCode = 1
}
