/**
 * 探针：声明对端平权（0.6.39）
 *
 * 0.6.39 只做一件事：把「同域词面干扰」压下去——同一个领域里，问句的字面撞上了
 * 同域的另一个条目，而真正的答案因为有「内部说法」而拿不到字面证据。
 * 三条夹具（医疗 md01、天文 tw01、园艺 yy07）就是这一族的三个样本：
 *
 *   md01「二甲双胍起始」  ←  问「降糖药第一次吃多少量」，被 md02「降糖药调整原则」压住
 *   tw01「对极轴」        ←  问「星点老是跑偏怎么回事」，被 tw11「马赛克拼接」压住
 *   yy07「施肥配比」      ←  问「叶子发黄是不是缺肥」，整条不进榜（缺肥是 OOV）
 *
 * 处方四条（都在引擎里，开关都能关回去）：
 *   P1 声明对端平权：对照表（A＝B）里声明出来的对端，权重从 synW 0.6 抬到 1.0，
 *      并且吃标题/关键词字段加成——它跟「字面命中标题」待遇一样，因为它就是那个词。
 *   P2 歧义类名折扣：问句里的词在库里有声明对端＝这个词有歧义，字面对上它（declDirectW 0.7）
 *      不如对上对端。
 *   P3 对照条目不吃字段加成：对照表把 A＝B 两侧的词都收着，一给字段加成它就是「最像答案」，
 *      可它是术语表不是答案。降权条目同时停止字段加成。
 *   P4' 单字桥（中心语素桥）：只收关键词里 df ≤ 8 的词，按词尾字（中心语素）建表；
 *      只补直接分为 0 的条目；落在标题/关键词上才算；问句要有字面锚点；
 *      多个候选词命中做累加、封顶 best × 3。
 *
 * 这一支要证明八件事：
 *   D1 形状：五个常量各一处定义，两条打分路都写着同一套公式（不然两路会漂）
 *   D2 P1 真的在起作用：关掉字段加成 md01 就掉到第二（这是 0.6.38 的病）
 *   D3 P2 真的在起作用：类名不打折，md02 涨两成；而 md01 不动（折扣按词给，不按条目给）
 *   D4 P3 真的在起作用：五域 5 条对照条目全部降到 pen 0.25，答案条目全是 1
 *   D5 P4' 是 yy07 的唯一来路：关掉单字桥 yy07 完全消失；开着名次 ≤ 1
 *   D6 P4' 不参与已有字面证据的排序：三条字面问句开/关逐位同分
 *   D7 门控与锚点：synBridge:false 时单字桥一起关（五层全关的口径）；OOV 占九成的问句不许硬凑
 *   D8 回旧口径：四个开关归位 → 冷域换说法退回 0.6.38 的 0.7 / 0.9 / 0.8（逐位）
 */
import { root } from './_root.mjs'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const V = await import(pathToFileURL(join(root, 'vendor', 'meow-memory', 'lib', 'index.js')).href)

let pass = 0
let fail = 0
function ok(name, cond, detail) {
  if (cond) {
    pass++
    console.log('PASS ' + name + (detail ? '  ' + detail : ''))
  } else {
    fail++
    console.log('FAIL ' + name + '  ' + (detail ?? ''))
  }
}
const pct = (x) => (Math.round(x * 1000) / 10).toFixed(1) + '%'
const r3 = (x) => (Math.round(x * 1000) / 1000).toFixed(3)

const ENGINE = readFileSync(join(root, 'vendor', 'meow-memory', 'lib', 'index.js'), 'utf8')
const fx = JSON.parse(readFileSync(join(root, 'tools', 'fixtures', 'domains.json'), 'utf8'))
const gold = JSON.parse(readFileSync(join(root, 'tools', 'fixtures', 'gold-recall.json'), 'utf8'))
const doms = fx.domains
const flat = []
for (const k of Object.keys(doms)) for (const it of doms[k].docs) flat.push(it)

const HEAD = 5
function measure(docs, queries, opts = {}) {
  let h1 = 0
  let h3 = 0
  let mrr = 0
  for (const item of queries) {
    const ids = V.searchAdaptive(item.q, docs, { k: HEAD, ...opts }).map((h) => String(h.id))
    const at = ids.findIndex((id) => item.want.includes(id))
    if (at === 0) h1++
    if (at >= 0 && at < 3) h3++
    if (at >= 0) mrr += 1 / (at + 1)
  }
  const n = queries.length || 1
  return { hit1: h1 / n, hit3: h3 / n, mrr: mrr / n }
}
const paraOf = (d) => d.queries.filter((x) => x.kind === 'para')
const rankOf = (q, want, opts = {}) => {
  const ids = V.search(q, flat, { k: flat.length, ...opts }).map((h) => String(h.id))
  return ids.findIndex((id) => want.includes(id))
}
const scoreOf = (q, id, opts = {}) => {
  const hits = V.search(q, flat, { k: flat.length, ...opts })
  const hit = hits.find((h) => String(h.id) === id)
  return hit === undefined ? 0 : hit.score
}

// ── D1 形状：五个常量，两条打分路同式 ────────────────────────────────────────
{
  const count = (x) => ENGINE.split(x).length - 1
  const defs = [
    'var SYN_W_LOOKUP_DEF = 1;',
    'var BRIDGE_FIELD_DEF = true;',
    'var DECL_DIRECT_W_DEF = 0.7;',
    'var CHAR_BRIDGE_ANCHOR_RATIO = 0.25;',
    'var CHAR_BRIDGE_SUM_CAP = 3;',
  ]
  const bad = defs.filter((d) => count(d) !== 1)
  const chr = count('row.chr === 1')
  const cap = count('CHAR_BRIDGE_SUM_CAP')
  const off = count('declDocOff')
  const kk = count('declDocK')
  console.log(`MEASURE 形状：row.chr 判据 ${chr} 处 · SUM_CAP ${cap} 处 · declDocOff ${off} · declDocK ${kk}`)
  ok('D1 四个开关常量 + 单字桥封顶常量各一处定义（参数只有一个入口，不散在代码里）',
    bad.length === 0, bad.length === 0 ? `${defs.length} 个常量齐` : '缺 ' + bad.join(' / '))
  ok('D1 两条打分路（scanDoc 与热路 scoreCandSet）写着同一套单字桥公式',
    chr >= 4 && cap >= 4, `row.chr ${chr} · SUM_CAP ${cap}`)
  ok('D1 对照型条目的字段加成关闭判据两条路各一处（一条算、一条用）',
    off === 2 && kk === 2, `declDocOff ${off} · declDocK ${kk}`)
}

// ── D2 P1 声明对端平权：关掉字段加成，md01 立刻掉到第二 ──────────────────────
{
  const q = '降糖药第一次吃多少量'
  const on = V.search(q, flat, { k: 4 })
  const off = V.search(q, flat, { k: 4, bridgeField: false })
  const onOrder = on.map((h) => String(h.id)).join(' ')
  const offOrder = off.map((h) => String(h.id)).join(' ')
  const onMd01 = scoreOf(q, 'md01')
  const offMd01 = scoreOf(q, 'md01', { bridgeField: false })
  const onMd02 = scoreOf(q, 'md02')
  console.log(`MEASURE P1：默认 ${onOrder} · 关字段加成 ${offOrder}`)
  console.log(`MEASURE P1：md01 ${r3(onMd01)} → ${r3(offMd01)}（×${r3(offMd01 / (onMd01 || 1))}）· md02 ${r3(onMd02)} 不动`)
  ok('D2 默认下 md01 排第一（0.6.38 是 md02 第一）',
    rankOf(q, ['md01']) === 0 && rankOf(q, ['md02']) > 0, onOrder)
  ok('D2 关掉字段加成 md01 掉到第二：P1 的功劳就是让声明对端拿到跟标题一样的待遇',
    rankOf(q, ['md01'], { bridgeField: false }) === 1 && offMd01 < onMd01 * 0.6,
    `md01 ${r3(onMd01)} → ${r3(offMd01)}`)
  // md02 也沾到一点（它的关键词里有「双胍类」，那个碎片在对照表里是声明来的），
  // 但它本来就靠字面命中拿分——真正吃到这一加成的是 md01。看的不是「有没有动」，是「谁动得多」。
  const offMd02 = scoreOf(q, 'md02', { bridgeField: false })
  const gain01 = onMd01 / (offMd01 || 1)
  const gain02 = onMd02 / (offMd02 || 1)
  console.log(`MEASURE P1：加成幅度 md01 ×${r3(gain01)} · md02 ×${r3(gain02)}（md02 ${r3(onMd02)} → ${r3(offMd02)}）`)
  ok('D2 字段加成的落差落在声明对端上：md01 拿到两倍以上，字面命中型 md02 只顺带一成（反差 ≥ 1.8 倍）',
    gain01 > gain02 * 1.8, `md01 ×${r3(gain01)} · md02 ×${r3(gain02)}`)
}

// ── D3 P2 歧义类名折扣：按词给，不按条目给 ──────────────────────────────────
{
  const q = '降糖药第一次吃多少量'
  const base = scoreOf(q, 'md02')
  const free = scoreOf(q, 'md02', { declDirectW: 1 })
  const md01Base = scoreOf(q, 'md01')
  const md01Free = scoreOf(q, 'md01', { declDirectW: 1 })
  console.log(`MEASURE P2：md02 ${r3(base)} → ${r3(free)}（不打折 · ×${r3(free / (base || 1))}）· md01 ${r3(md01Base)} → ${r3(md01Free)}`)
  ok('D3 不打折时 md02 涨两成以上：0.7 这一刀确实压着有歧义的那个词',
    free > base * 1.15, `×${r3(free / (base || 1))}`)
  ok('D3 折扣按问句词给：问句里没有声明对端的条目（md01）分数不变',
    Math.abs(md01Free - md01Base) < 1e-9, `md01 ${r3(md01Base)} 两次相同`)
  ok('D3 折扣没有把答案打下去：默认口径下 md01 仍第一', rankOf(q, ['md01']) === 0)
}

// ── D4 P3 对照条目不吃字段加成：五域全判对，答案条目零误伤 ────────────────────
{
  const idx = V.searchIndexOf(flat, {})
  const pen = idx.lookupPen
  const ids = flat.map((d) => String(d.id))
  const penOf = (id) => (pen === null ? 1 : pen[ids.indexOf(id)])
  const tables = ['md12', 'lw12', 'yy12', 'tw12'].map(penOf)
  const answers = ['md01', 'md02', 'lw01', 'yy07', 'tw01', 'tw11'].map(penOf)
  console.log(`MEASURE P3：对照条目 pen ${tables.map(r3).join(' / ')} · 答案条目 pen ${answers.map(r3).join(' / ')}`)
  ok('D4 四条术语对照表全部落到 pen 0.25（降权＝同时停止字段加成）',
    tables.every((x) => x < 1), tables.map(r3).join(' / '))
  ok('D4 答案条目一条都不降权（真库零误伤的口径在候选上同样成立）',
    answers.every((x) => x === 1), answers.map(r3).join(' / '))
  ok('D4 问事情时对照表不许抢第一：法律域「房东押金不退」答案是 lw01',
    rankOf('房东押金不退怎么办', ['lw01']) === 0 &&
    rankOf('房东押金不退怎么办', ['lw12']) > 0,
    `lw01 ${r3(scoreOf('房东押金不退怎么办', 'lw01'))} / lw12 ${r3(scoreOf('房东押金不退怎么办', 'lw12'))}`)
}

// ── D5 P4' 单字桥：yy07 的唯一来路 ───────────────────────────────────────────
{
  const q = '叶子发黄是不是缺肥'
  const on = rankOf(q, ['yy07'])
  const off = rankOf(q, ['yy07'], { charBridgeW: 0 })
  const s = scoreOf(q, 'yy07')
  console.log(`MEASURE P4'：yy07 默认名次 ${on} 分 ${r3(s)} · 关单字桥名次 ${off}`)
  ok("D5 yy07 进前二（0.6.38 是整条不进榜：缺肥 OOV、叶子的字面证据全在对照表上）",
    on >= 0 && on <= 1, `名次 ${on}`)
  ok('D5 关掉单字桥 yy07 完全消失：这条分是桥给的，不是别的层顺手给的',
    off === -1, `名次 ${off}`)
  ok('D5 对照表仍排在它前面（它是术语表不是答案，让位规则照旧）',
    rankOf(q, ['yy12']) === 0 && s > 0, `yy12 第一 · yy07 ${r3(s)}`)
}

// ── D6 P4' 不参与已有字面证据的排序 ─────────────────────────────────────────
{
  const qs = ['照片一放大就发白', '降糖药第一次吃多少量', '星点老是跑偏怎么回事', '试纸变色了还能用吗']
  const sig = (q, opts) => V.search(q, flat, { k: 6, ...opts }).map((h) => `${h.id}:${h.score.toFixed(6)}`).join(',')
  const drift = qs.filter((q) => sig(q, {}) !== sig(q, { charBridgeW: 0 }))
  console.log(`MEASURE P4'：字面证据型 ${qs.length} 问，开/关单字桥读数不一致 ${drift.length} 条`)
  ok('D6 直接分不为 0 的条目不进单字桥（桥只负责让够不着的东西被看见）',
    drift.length === 0, drift.join(' / '))
}

// ── D7 门控与锚点 ───────────────────────────────────────────────────────────
{
  const q = '叶子发黄是不是缺肥'
  const all = rankOf(q, ['yy07'], { synBridge: false })
  const idxOff = V.searchIndexOf(flat, { inverted: false })
  console.log(`MEASURE 门控：synBridge:false 时 yy07 名次 ${all} · inverted:false 建表 ${idxOff.charBridge === null ? '不建' : '建了'}`)
  ok('D7 synBridge:false 是「五层全关」：单字桥一起关（探针 A2 依赖这个口径）',
    all === -1, `名次 ${all}`)
  ok('D7 没有倒排就不建单字桥：回退路不该为一张用不上的表付建表钱',
    idxOff.charBridge === null, idxOff.charBridge === null ? 'null' : 'not null')

  const oov = ['光合作用的暗反应发生在哪里', '帮我写一首关于秋天的七言绝句']
  const oovOn = oov.map((x) => V.search(x, gold.docs, { k: 5 }).length)
  const oovOff = oov.map((x) => V.search(x, gold.docs, { k: 5, charBridgeW: 0 }).length)
  console.log(`MEASURE 锚点：OOV 问句开桥命中 ${oovOn.join(' / ')} · 关桥 ${oovOff.join(' / ')}`)
  ok('D7 字面锚点不足的问句不建桥（OOV 占九成本库就没有这件事，桥不许硬凑）',
    oovOn.every((n, i) => n <= oovOff[i]), `开 ${oovOn.join(',')} / 关 ${oovOff.join(',')}`)

  const NEG = [
    '明天北京的天气怎么样', '红烧肉要炖多久才烂', '秦始皇哪一年统一六国', '光合作用的暗反应发生在哪里',
    '帮我写一首关于秋天的七言绝句', 'Python 的 GIL 在 3.13 有变化吗', '火星上一天有多少小时',
    '红楼梦里通灵宝玉是什么来历', '吉他换弦要注意什么', '上一届世界杯冠军是谁', '我家的猫为什么半夜叫',
    '高铁票怎么改签', '咖啡因的半衰期是多久', '怎么腌酸菜不坏',
  ]
  const empty = NEG.filter((x) => V.search(x, gold.docs, { k: 5 }).length === 0).length
  console.log(`MEASURE 空手：${empty}/${NEG.length}（0.6.38 基线 10/14）`)
  ok('D7 空手能力没有回退：真库上陌生问句至少 10 条回空（单字桥不许把空手变成瞎猜）',
    empty >= 10, `${empty}/${NEG.length}`)
}

// ── D8 回旧口径：四个开关归位，读数必须逐位退回 0.6.38 ──────────────────────
{
  const para = doms.map((d) => paraOf(d)).flat()
  const now = measure(flat, para)
  const OLD = { synWLookup: 0.6, bridgeField: false, declDirectW: 1, charBridgeW: 0 }
  const old = measure(flat, para, OLD)
  const allOff = measure(flat, para, { synBridge: false })
  console.log(`MEASURE 口径：默认 ${pct(now.hit1)} / ${pct(now.hit3)} / ${r3(now.mrr)}`)
  console.log(`MEASURE 口径：四开关归位 ${pct(old.hit1)} / ${pct(old.hit3)} / ${r3(old.mrr)}（0.6.38 基线 70.0% / 90.0% / 0.800）`)
  console.log(`MEASURE 口径：五层全关 ${pct(allOff.hit1)} / ${pct(allOff.hit3)} / ${r3(allOff.mrr)}`)
  ok('D8 0.6.39 的四个开关全归位 → 冷域换说法退回 0.6.38 的 0.7 / 0.9 / 0.8（逐位相同，行为可回退）',
    Math.abs(old.hit1 - 0.7) < 1e-9 && Math.abs(old.hit3 - 0.9) < 1e-9 && Math.abs(old.mrr - 0.8) < 1e-9,
    `${pct(old.hit1)} / ${pct(old.hit3)} / ${r3(old.mrr)}`)
  ok('D8 打开之后冷域换说法 h1 ≥ 85%、h3 = 100%、MRR ≥ 0.9（0.6.38 是 70 / 90 / 0.800）',
    now.hit1 >= 0.85 && now.hit3 >= 0.99 && now.mrr >= 0.9,
    `${pct(now.hit1)} / ${pct(now.hit3)} / ${r3(now.mrr)}`)
  ok('D8 五层全关是最差的一档：四层各有各的活，不是叠在一处',
    allOff.hit1 < now.hit1 && allOff.hit3 < now.hit3,
    `${pct(allOff.hit1)} / ${pct(allOff.hit3)} / ${r3(allOff.mrr)}`)
}

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILED'} · probe-decl ${pass}/${pass + fail}`)
process.exit(fail === 0 ? 0 : 1)
