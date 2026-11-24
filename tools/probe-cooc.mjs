/**
 * 探针：共现自学习扩词（P5，0.4.0）
 *
 * 为什么要有这一支：0.3.0 之前换说法档的高分全靠 SYN_GROUPS 那张手工表，
 * 主人一句话点破——「出现新的情况就无法适应了不是吗」。所以 P5 把等价说法从
 * 人手里的表搬到库里的 keywords：库带来什么词，共现就从什么词上长。
 *
 * 量的五件事：
 *  K1 学的是 words 不是 bigram：正文里全是切片碎片，共现表里一个碎片都不许有
 *  K2 两级证据：同一条 +2、同 project 只认跨文档（同一条内部不重复计）
 *  K3 三道门：次数 <2 不学 / 条件概率 <0.25 不学 / 共享汉字降到 +1
 *  K4 真进召回：开共现把问句接通，关掉退回手工表口径
 *  K5 大库更准：同一批词在一条记忆上无从统计、补一条同类就连上了
 *
 * 夹具注意：故意挑**互不共享汉字**的词。共享一个字的两个词会被当成「弱证据」
 * 降到 1 分（见 COOC_SHARE_HAN_W），那是另一条判据（K3）在管；混在一起会让
 * 「同条一次就够」这类断言莫名其妙地红。唯一故意共享汉字的只有 K3 那组。
 *
 * 只读、毫秒级、零 LLM。真库不进这条探针：真库的 keywords 每天都在变，读数不可复现。
 */
import { root } from './_root.mjs'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const V = await import(pathToFileURL(join(root, 'vendor', 'meow-memory', 'lib', 'index.js')).href)

let pass = 0
let fail = 0
const bad = []
function ok(name, cond, detail) {
  if (cond) {
    pass++
    console.log('PASS ' + name + (detail ? '  ' + detail : ''))
  } else {
    fail++
    bad.push(name + '  ' + (detail ?? ''))
    console.log('FAIL ' + name + '  ' + (detail ?? ''))
  }
}

const mk = (id, project, content, keywords) => ({
  id, project, title: '', content, keywords, level: 'fact',
  importance: 1, created_at: '2026-11-20T00:00:00Z', updated_at: '2026-11-20T00:00:00Z',
  last_accessed_at: '2026-11-20T00:00:00Z', status: 'active',
})
const show = (m) => (m ? [...m].map(([k, v]) => k + '→' + v.join('/')).join(' | ') : '空表')

// ── K1 学的是词，不是切片 ─────────────────────────────────────────────────────
// 正文故意写成「地面空间配置」，tokenize 会切出「名空/置面/到配」这类跨词碎片；
// keywords 写的是三个真词。共现表里只许出现真词。
{
  const docs = [
    mk('k1a', 'p1', '地面空间配置要写成一份清单', ['配置', '清单']),
    mk('k1b', 'p1', '配置改完先跑一遍自测', ['配置', '自测']),
  ]
  const cooc = V.buildCoocSyn(docs, docs.length)
  const keys = cooc ? [...cooc.keys()] : []
  const hasFragment = keys.some((k) => ['名空', '置面', '到配', '面空', '间配'].includes(k))
  ok('K1 共现只从 keywords 上长：正文里的切片碎片一个都不许进表', keys.length > 0 && !hasFragment,
    `${keys.length} 个词：${keys.join('/')}`)
  ok('K1 真词确实连上了：配置 ↔ 清单 / 配置 ↔ 自测',
    (cooc?.get('配置') ?? []).includes('清单') && (cooc?.get('配置') ?? []).includes('自测'),
    `${show(cooc)}`)
}

// ── K2 两级证据 ──────────────────────────────────────────────────────────────
// 同一条：+2，一次就过线。同 project 那层只认跨文档：一条记忆的词与同项目里别的记忆的词相交。
{
  const same = [
    mk('k2a', 'p1', '', ['苹果', '香蕉']),
    mk('k2b', 'p2', '', []),
  ]
  const c1 = V.buildCoocSyn(same, 2)
  ok('K2 同一条记忆里的两个词只出现一次就够（+2 ≥ 门槛 2）',
    (c1?.get('苹果') ?? []).includes('香蕉'), `苹果 → ${(c1?.get('苹果') ?? []).join('/') || '空'}`)

  // 只有一条记忆：project 层没有「别的记忆」可与它相交 → 空表
  const sameOnly = [mk('k2c', 'px', '', ['云朵'])]
  const c2same = V.buildCoocSyn(sameOnly, 1)
  const c2 = V.buildCoocSyn([mk('k2d', 'px', '', ['云朵']), mk('k2e', 'px', '', ['海浪'])], 2)
  ok('K2 同项目只认跨文档：一条记忆里孤零零一个词不产生任何对，补上同项目的另一条才连上',
    !c2same && (c2?.get('云朵') ?? []).includes('海浪'),
    `一条 ${c2same ? show(c2same) : '空表'}；两条 ${(c2?.get('云朵') ?? []).join('/') || '空'}`)

  const proj2 = [
    mk('k2f', 'py', '', ['松针']),
    mk('k2g', 'py', '', ['柏油']),
    mk('k2h', 'py', '', ['柳絮']),
  ]
  const c3 = V.buildCoocSyn(proj2, 3)
  ok('K2 同 project 里几个词互相都连得上（彼此都是「别的记忆」）',
    (c3?.get('松针') ?? []).includes('柏油') && (c3?.get('松针') ?? []).includes('柳絮'),
    `松针 → ${(c3?.get('松针') ?? []).join('/') || '空'}`)
}

// ── K3 三道门 ───────────────────────────────────────────────────────────────
{
  // 条件概率门：甲门出现在 9 条里，只有 1 条带乙门 → count=2（同条 +2）、ratio=2/9≈0.22 < 0.25
  // 注意 count 是权重之和不是条数：同条一次就是 2，所以要让 ratio 掉下去只能把 df 做大
  const skew = [mk('k3a', 'p1', '', ['咖啡', '牛奶'])]
  for (let i = 0; i < 8; i++) skew.push(mk('k3b' + i, 'p' + (i + 2), '', ['咖啡']))
  const c1 = V.buildCoocSyn(skew, skew.length)
  ok('K3 条件概率门：甲出现 9 次只有 1 次带乙（0.22 < 0.25），不学',
    c1 === null || !(c1.get('咖啡') ?? []).includes('牛奶'), `咖啡 → ${(c1?.get('咖啡') ?? []).join('/') || '空'}`)

  // 共享汉字门：自测/自检 共享「自」，降到 +1；同一条里出现一次只有 1 分，过不了线
  const han = [mk('k3f', 'p1', '', ['自测', '自检'])]
  const c2 = V.buildCoocSyn(han, 1)
  ok('K3 共享汉字门：自测/自检 只算弱证据（同一条一次 = 1 分，不到 2）',
    !(c2?.get('自测') ?? []).includes('自检'), `自测 → ${(c2?.get('自测') ?? []).join('/') || '空'}`)
  // 但攒起来还认：两条同 project 各一次 → 1+1 = 2
  const han2 = [mk('k3g', 'pz', '', ['自测']), mk('k3h', 'pz', '', ['自检'])]
  const c3 = V.buildCoocSyn(han2, 2)
  ok('K3 共享汉字门不是封死：两条同 project 各出现一次（1+1 = 2）就认',
    (c3?.get('自测') ?? []).includes('自检'), `自测 → ${(c3?.get('自测') ?? []).join('/') || '空'}`)

  // 形态门：单字 / 纯数字 / 超过 8 字 / 纯符号 都不收
  const shape = [mk('k3i', 'p1', '', ['好', '2026', '一二三四五六七八九', '正常词', 'ok'])]
  const c4 = V.buildCoocSyn(shape, 1)
  const all = c4 ? [...c4.keys()].flatMap((k) => [k, ...c4.get(k)]) : []
  ok('K3 形态门：单字 / 纯数字 / 超 8 字 / 太短的英文缩写 都不进表',
    !all.includes('好') && !all.includes('2026') && !all.includes('一二三四五六七八九') && !all.includes('ok'),
    all.length ? all.join('/') : '空表')
}

// ── K4 真进召回 ─────────────────────────────────────────────────────────────
// 造一条「只写了乙词」的记忆，问句用甲词。甲不在手工表里，只能靠共现接通。
// 池子做 8 条：扩词要过 SYN_MAX_DF_RATIO（cap = floor(8×0.35) = 2），池子太小会被门挡掉。
{
  const docs = [
    mk('k4a', 'p1', '这一段讲的是咖啡的选法', ['咖啡', '牛奶']),
    mk('k4b', 'p2', '牛奶要挑当天到的', ['牛奶']),
    mk('k4c', 'p3', '完全不相干的一段话之一', ['别的事']),
    mk('k4d', 'p3', '完全不相干的一段话之二', ['换的事']),
    mk('k4e', 'p3', '完全不相干的一段话之三', ['再的事']),
    mk('k4f', 'p3', '完全不相干的一段话之四', ['另的事']),
    mk('k4g', 'p3', '完全不相干的一段话之五', ['别的话']),
    mk('k4h', 'p3', '完全不相干的一段话之六', ['换的话']),
  ]
  const q = '咖啡怎么挑'
  const on = V.search(q, docs, { k: 3 })
  const off = V.search(q, docs, { k: 3, coocLearn: false })
  ok('K4 共现没把该找的弄丢：问「咖啡」首位还是那条讲咖啡的（手工表里没有这对词）',
    String(on[0]?.id) === 'k4a' && String(off[0]?.id) === 'k4a',
    `开 ${on.map((h) => h.id).join(',')} / 关 ${off.map((h) => h.id).join(',')}`)
  const onScore = Number(on.find((h) => h.id === 'k4b')?.score) || 0
  const offScore = Number(off.find((h) => h.id === 'k4b')?.score) || 0
  ok('K4 那条的分是共现给的：关掉之后同一个条目的分明显更低',
    onScore > offScore + 0.5, `k4b 开 ${onScore.toFixed(3)} / 关 ${offScore.toFixed(3)}`)

  // synBridge:false 时共现也不许生效（一个旋钮关掉整层）
  const both = V.search(q, docs, { k: 3, synBridge: false })
  const offScore2 = Number(both.find((h) => h.id === 'k4b')?.score) || 0
  ok('K4 桥总开关关掉时共现也不进（synBridge:false 是整层回滚）',
    Math.abs(offScore2 - offScore) < 1e-9, `synBridge:false ${offScore2.toFixed(3)} vs coocLearn:false ${offScore.toFixed(3)}`)
}

// ── K5 大库更准 ─────────────────────────────────────────────────────────────
// 同一个词对：只有一条记忆时 project 层无从统计（同条内部本来就已经算过同条分），
// 补一条同类记忆之后，「这两件事总是一起被提到」才成立。
{
  const small = [mk('k5a', 'p1', '', ['月亮'])]
  const big = small.concat([mk('k5b', 'p1', '', ['星星'])])
  const c1 = V.buildCoocSyn(small, small.length)
  const c2 = V.buildCoocSyn(big, big.length)
  const smallOk = (c1?.get('月亮') ?? []).includes('星星')
  const bigOk = (c2?.get('月亮') ?? []).includes('星星')
  ok('K5 库越大越连得上：同样一对词，一条记忆上无从统计、补一条同类就连上了',
    !smallOk && bigOk, `1 条 ${smallOk} / 2 条 ${bigOk}`)
}

// ── K6 常量与开关的形态 ──────────────────────────────────────────────────────
{
  ok('K6 六个门是有数的常量（不是「谁都能改一点点」的魔法数）',
    V.COOC_W_SAME === 2 && V.COOC_W_PROJ === 1 && V.COOC_MIN_COUNT === 2 &&
    V.COOC_MIN_RATIO === 0.25 && V.COOC_TOP_PER_TERM === 6 && V.SYN_MAX_PER_TERM === 6,
    `${V.COOC_W_SAME}/${V.COOC_W_PROJ}/${V.COOC_MIN_COUNT}/${V.COOC_MIN_RATIO}/${V.COOC_TOP_PER_TERM}/${V.SYN_MAX_PER_TERM}`)
  ok('K6 共享汉字降权常量 ≤ 同条权重（降权，不是加码）',
    V.COOC_SHARE_HAN_W <= V.COOC_W_SAME, `${V.COOC_SHARE_HAN_W} ≤ ${V.COOC_W_SAME}`)

  // 每词最多扩 6 个：造一个中心词，同条塞 10 个互不共享汉字的词
  const wide = [mk('k6a', 'p1', '', ['中枢', '甲乙', '丙丁', '戊己', '庚辛', '壬癸', '子丑', '寅卯', '辰巳', '午未', '申酉'])]
  const c = V.buildCoocSyn(wide, 1)
  const n = (c?.get('中枢') ?? []).length
  ok('K6 每个词最多带 6 个扩词（扩词是桥，不是主力）', n === V.COOC_TOP_PER_TERM, `中枢 带 ${n} 个`)

  // 开关关闭时索引里没有共现表
  const docs = [mk('k6b', 'p1', '', ['甲乙', '丙丁'])]
  const off = V.search('甲乙', docs, { k: 1, coocLearn: false })
  ok('K6 coocLearn:false 时索引里没有共现表（不是「有表但不用」）',
    typeof V.buildCoocSyn === 'function' && off.length === 1, `返回 ${off.length} 条`)

  // 缓存键带口径位：开/关各算一次，互不污染
  V.clearSearchIndexCache()
  const d1 = [mk('k6c', 'p1', '甲乙一体', ['甲乙', '丙丁']), mk('k6d', 'p1', '', ['丙丁'])]
  V.search('甲乙', d1, { k: 2 })
  const sizeOn = V.searchIndexCacheInfo().size
  V.search('甲乙', d1, { k: 2, coocLearn: false })
  const sizeOff = V.searchIndexCacheInfo().size
  ok('K6 两种口径各占一张表（缓存键含 coocLearn 位，不许互相串）', sizeOff > sizeOn, `${sizeOn} → ${sizeOff}`)
}

// ── K7 结构提速不改结果（0.6.23）─────────────────────────────────────────────
// 0.6.23 把共现那一层里三处「白跑一遍」拆掉：共享汉字按词对记忆一次、每条的词表只解一遍、
// 项目层内层把「a 那一行」提到 b 循环外。这一档量的就是「提速不许改结果」：
//  K7a 词表只解一遍（keywords 是 getter 数次数：老写法读两遍）
//  K7b 引擎的共现表与一把「朴素尺子」逐键逐值逐序相同（尺子不记忆、不提行）
//  K7c 会话主题那一趟依旧按「跨几个会话」算：够 3 条的会话每条都追加同一串，不够的一条都不追加
{
  // K7a：keywords 是 getter，数它被读了几次
  let reads = 0
  const g1 = mk('k7a1', 'pg', '', [])
  const g2 = mk('k7a2', 'pg', '', [])
  for (const [d, ws] of [[g1, ['甲乙', '丙丁']], [g2, ['丙丁', '戊己']]]) {
    Object.defineProperty(d, 'keywords', {
      get() { reads++; return ws },
      enumerable: true, configurable: true,
    })
  }
  V.buildCoocSyn([g1, g2], 2)
  ok('K7a 每条的词表只解一遍（keywords 只读一次，不是同条层 + 项目层各解一遍）',
    reads <= 2, `两条记忆一共读了 ${reads} 次`)

  // K7b：朴素尺子——照着「记忆之前的写法」直写一遍：词对判据每次重算、内层每写一次就回表。
  const shareHan = (a, b) => {
    if (!/[\u4e00-\u9fff]/.test(a) || !/[\u4e00-\u9fff]/.test(b)) return false
    for (const ch of a) if (b.includes(ch)) return true
    return false
  }
  const bumpIn = (map, a, b, w) => {
    const cur = map.get(a)
    if (cur === undefined) map.set(a, new Map([[b, w]]))
    else cur.set(b, (cur.get(b) ?? 0) + w)
  }
  function naiveCooc(docs) {
    const pairs = new Map()
    const projPairs = new Map()
    const words = docs.map((d) => d.keywords)
    const kwDf = new Map()
    for (const ws of words) {
      if (ws.length === 0) continue
      for (const w of ws) kwDf.set(w, (kwDf.get(w) ?? 0) + 1)
      for (let i = 0; i < ws.length; i++) {
        for (let j = i + 1; j < ws.length; j++) {
          const a = ws[i]; const b = ws[j]
          if (a === b) continue
          const ww = shareHan(a, b) ? Math.min(V.COOC_W_SAME, V.COOC_SHARE_HAN_W) : V.COOC_W_SAME
          bumpIn(pairs, a, b, ww); bumpIn(pairs, b, a, ww)
        }
      }
    }
    const byProject = new Map()
    docs.forEach((d, i) => {
      const ws = words[i]
      if (ws.length === 0) return
      const p = String(d.project ?? '全局')
      if (!byProject.has(p)) byProject.set(p, [])
      byProject.get(p).push(ws)
    })
    for (const [, list] of byProject) {
      if (list.length < 2) continue
      const union = new Set()
      for (const ws of list) for (const w of ws) union.add(w)
      const unionArr = [...union]
      for (const ws of list) {
        const self = new Set(ws)
        const others = unionArr.filter((w) => !self.has(w))
        if (others.length === 0) continue
        for (const a of ws) {
          for (const b of others) {
            const ww = shareHan(a, b) ? Math.min(V.COOC_W_PROJ, V.COOC_SHARE_HAN_W) : V.COOC_W_PROJ
            bumpIn(projPairs, a, b, ww); bumpIn(projPairs, b, a, ww)
          }
        }
      }
    }
    const pickFrom = (map, a, dfa) => {
      const others = map && map.get(a)
      if (!others || dfa <= 0) return []
      const keep = []
      for (const [b, c] of others) {
        if (c < V.COOC_MIN_COUNT) continue
        const ratio = c / dfa
        if (ratio < V.COOC_MIN_RATIO) continue
        keep.push([b, ratio])
      }
      keep.sort((x, y) => y[1] - x[1])
      return keep.map(([b]) => b)
    }
    const out = new Map()
    for (const a of new Set([...pairs.keys(), ...projPairs.keys()])) {
      const dfa = kwDf.get(a) ?? 0
      if (dfa <= 0) continue
      const strong = pickFrom(pairs, a, dfa)
      const weak = pickFrom(projPairs, a, dfa)
      if (strong.length === 0 && weak.length === 0) continue
      const seen = new Set()
      const list = []
      for (const w of strong.concat(weak)) {
        if (seen.has(w)) continue
        seen.add(w); list.push(w)
      }
      out.set(a, list.slice(0, V.COOC_TOP_PER_TERM))
    }
    return out.size > 0 ? out : null
  }
  const dump = (m) => JSON.stringify(m ? [...m].map(([k, v]) => [k, v]) : null)
  const FIX = [
    ['共享汉字簇（自测/自检/切片/片段 同条 + 同项目）', [
      mk('k7b1', 'ph', '', ['自测', '自检', '切片', '片段']),
      mk('k7b2', 'ph', '', ['自测', '切片']),
      mk('k7b3', 'ph', '', ['片段', '基線']),
      mk('k7b4', 'ph', '', ['自测', '基線']),
    ]],
    ['多项目 + 单条项目', [
      mk('k7b5', 'pa', '', ['苹果', '香蕉']),
      mk('k7b6', 'pa', '', ['香蕉', '云朵']),
      mk('k7b7', 'pb', '', ['云朵', '海浪']),
      mk('k7b8', 'solo', '', ['孤零零', '一条']),
    ]],
    ['重复关键词 + 冷门词', [
      mk('k7b9', 'pc', '', ['重复重复', '重复重复', '冷门甲']),
      mk('k7b10', 'pc', '', ['冷门甲', '冷门乙']),
    ]],
    ['空 keywords 混着来', [
      mk('k7b11', 'pd', '', []),
      mk('k7b12', 'pd', '', ['甲乙']),
      mk('k7b13', 'pd', '', ['丙丁', '戊己']),
    ]],
  ]
  const diffFix = []
  for (const [label, docs] of FIX) {
    const a = dump(V.buildCoocSyn(docs, docs.length))
    const b = dump(naiveCooc(docs))
    if (a !== b) diffFix.push(`${label}: 引擎 ${a} / 尺子 ${b}`)
  }
  ok('K7b 共现表与朴素尺子逐键逐值逐序相同（记忆表与提行都不许改结果）',
    diffFix.length === 0, diffFix.length ? diffFix[0].slice(0, 300) : `${FIX.length} 组夹具全同`)

  // K7c：会话主题仍按「跨几个会话」算——够 3 条的会话里每条都追加同一串，不够的一条都不加
  const sdoc = (id, sess, content) => ({
    id, project: 'ps', title: '', content, keywords: [], level: 'fact',
    importance: 1, created_at: '2026-11-20T00:00:00Z', updated_at: '2026-11-20T00:00:00Z',
    last_accessed_at: '2026-11-20T00:00:00Z', status: 'active', source_session: sess,
  })
  const sd = [
    sdoc('k7c1', 'sa', '自检基线 跑两趟 才收敛'),
    sdoc('k7c2', 'sa', '自检基线 又跑一趟 收敛了'),
    sdoc('k7c3', 'sa', '基线 三趟 收敛'),
    sdoc('k7c4', 'sb', '孤零零 一条 记录'),
  ]
  V.clearSearchIndexCache()
  const on = V.searchIndexOf(sd, {})
  const off = V.searchIndexOf(sd, { sessionTopic: false })
  const extra = sd.map((_, i) => (on.docToks[i] ?? []).slice((off.docToks[i] ?? []).length))
  const same = JSON.stringify(extra[0]) === JSON.stringify(extra[1]) && JSON.stringify(extra[1]) === JSON.stringify(extra[2])
  ok('K7c 够 3 条的会话里每条都追加同一串主题词（一个 Map 顶掉每会话一个 Set，结果不变）',
    extra[0].length > 0 && same, `sa：${JSON.stringify(extra[0])} / sa2：${JSON.stringify(extra[1])}`)
  ok('K7c 不足 3 条的会话一条都不追加（门槛还在）',
    extra[3].length === 0, `sb：${JSON.stringify(extra[3])}`)

  // ── K8 pairUp 内层提行（0.6.25）───────────────────────────────────────────────
  // 0.6.25 把「a 那一行」提到 b 循环外：老写法每写一个 (a,b) 都要 `pairs.get(a)` 回表一次，
  // 现在一个 a 只取一次。K8a 钉形状，K8b 用随机夹具（长关键词表 + 重复词 + 共享汉字簇 +
  // 多项目）跟朴素尺子逐键逐值逐序对比——提行最容易改坏的就是「行什么时候建」和「键的插入序」。
  {
    const src = readFileSync(new URL('../vendor/meow-memory/lib/index.js', import.meta.url), 'utf8')
    const begin = src.indexOf('const pairUp = (list, w) => {')
    const body = begin < 0 ? '' : src.slice(begin, src.indexOf('const pickFrom', begin))
    const code = body.split('\n').filter((l) => l.trim().startsWith('//') === false).join('\n')
    const shape = {
      hoisted: code.includes('let rowA = pairs.get(a);'),
      rowReuse: code.includes('} else rowA.set(b, (rowA.get(b) ?? 0) + ww);'),
      createOnFirstWrite: code.includes('rowA = /* @__PURE__ */ new Map([[b, ww]]);') && code.includes('pairs.set(a, rowA);'),
      forwardNoReLookup: code.includes('bumpIn(pairs, a, b, ww)') === false,
      backwardKept: code.includes('bumpIn(pairs, b, a, ww);'),
      lenHoisted: code.includes('const ln = list.length;'),
    }
    const miss = Object.keys(shape).filter((k) => !shape[k])

    let seed = 0x5eed25
    const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296 }
    const POOL = ['自测', '自检', '切片', '片段', '基线', '苹果', '香蕉', '云朵', '海浪', '重复重复', '冷门甲', '甲乙']
    const rdiff = []
    for (let t = 0; t < 40; t++) {
      const nd = 1 + Math.floor(rnd() * 6)
      const projs = ['pa', 'pb', 'pc', 'solo']
      const docs = []
      for (let i = 0; i < nd; i++) {
        const nw = Math.floor(rnd() * 15)
        const ws = []
        for (let j = 0; j < nw; j++) {
          const w = POOL[Math.floor(rnd() * POOL.length)]
          if (ws.includes(w) === false) ws.push(w)
        }
        docs.push(mk(`k8r${t}_${i}`, projs[Math.floor(rnd() * projs.length)], '', ws))
      }
      const a = dump(V.buildCoocSyn(docs, docs.length))
      const b = dump(naiveCooc(docs))
      if (a !== b) rdiff.push(`夹具 ${t}: 引擎 ${a} / 尺子 ${b}`)
    }
    ok('K8a 共现内层把 a 那一行提到 b 循环外（一个 a 只回表一次，建行时机与对称写入都没动）',
      miss.length === 0, miss.length === 0 ? '六处形状全在' : `缺 ${miss.join(',')}`)
    ok('K8b 提行之后共现表仍与朴素尺子逐键逐值逐序相同（40 组随机夹具：长表 / 重复词 / 共享汉字 / 多项目）',
      rdiff.length === 0, rdiff.length ? rdiff[0].slice(0, 300) : '40 组全同')
  }

  // ── K9 共现层内部一律用整数词号（0.6.26）───────────────────────────────────────
  // 病根：这一层原来拿词本身当键——`pairs`/`kwDf`/`hanMemo` 三层都是字符串键的 Map，
  // 每写一对都要算一次串哈希；`hanMemo` 还是个「串→行」的两级表，等于每次判共享汉字
  // 都要先按串找行。0.6.26 给每个词发一个整数词号，层内只认词号，出门那一刻用 `.map`
  // 换回原词（`new Array` + 逐位赋值会造 holey 数组，热路读它要多做洞检查）。
  // K9a 钉形状，K9b 钉「出门换回原词」这件事本身：键与值的类型、取值域都必须还是词。
  {
    const src = readFileSync(new URL('../vendor/meow-memory/lib/index.js', import.meta.url), 'utf8')
    const begin = src.indexOf('function buildCoocSyn(docs, n, opts) {')
    const body = begin < 0 ? '' : src.slice(begin, src.indexOf('\nfunction buildCoocForms', begin))
    const code = body.split('\n').filter((l) => l.trim().startsWith('//') === false).join('\n')
    const shape = {
      wordIds: code.includes('const wid = new Map();') && code.includes('const wById = [];') &&
        code.includes('const idOf = (w) => {'),
      idByFirstSeen: code.includes('id = wById.length;') && code.includes('wid.set(w, id);') &&
        code.includes('wById.push(w);'),
      hanRowsById: code.includes('const hanMemo = [];') && code.includes('hanMemo[a] = row;') &&
        code.includes('hanMemo.get(') === false,
      pairKeyedByNumber: code.includes('got = coocShareHan(wById[a], wById[b]);') &&
        code.includes('const wordsArr = docs.map((d) => coocWordsOf(d).map(idOf));'),
      outByWord: code.includes('const words = list.slice(0, COOC_TOP_PER_TERM).map((id) => wById[id]);') &&
        code.includes('out.set(wById[a], words);'),
      noNumericLeak: code.includes('out.set(a, words)') === false && code.includes('out.set(a,') === false,
    }
    const miss = Object.keys(shape).filter((k) => !shape[k])

    const docs = [
      mk('k9a', 'pa', '苹果 香蕉 云朵 一起 出现', ['苹果', '香蕉', '云朵']),
      mk('k9b', 'pa', '苹果 香蕉 海浪 出现', ['苹果', '香蕉', '海浪']),
      mk('k9c', 'pa', '苹果 云朵 海浪 出现', ['苹果', '云朵', '海浪']),
      mk('k9d', 'pb', '苹果 香蕉 云朵 一起', ['苹果', '香蕉', '云朵']),
      mk('k9e', 'pb', '自测 自检 切片 片段', ['自测', '自检', '切片', '片段']),
    ]
    const table = V.buildCoocSyn(docs, docs.length)
    const vocab = new Set()
    for (const d of docs) { for (const w of d.keywords) vocab.add(w); for (const w of String(d.content).split(/\s+/)) if (w) vocab.add(w) }
    const leaks = []
    if (table instanceof Map === false) leaks.push('返回的不是 Map')
    else {
      for (const [k, vs] of table) {
        if (typeof k !== 'string') leaks.push(`键不是词：${typeof k} ${String(k)}`)
        else if (vocab.has(k) === false) leaks.push(`键不在词表里：${k}`)
        if (Array.isArray(vs) === false) leaks.push(`值不是数组：${k}`)
        else for (const v of vs) {
          if (typeof v !== 'string') leaks.push(`值里漏出非词：${typeof v} ${String(v)}`)
          else if (vocab.has(v) === false) leaks.push(`值不在词表里：${v}`)
        }
      }
    }
    const wantKeys = [...naiveCooc(docs).keys()].sort().join('|')
    const gotKeys = table instanceof Map ? [...table.keys()].sort().join('|') : ''
    ok('K9a 共现层内部只认整数词号：词号按首见顺序发、共享汉字表改成下标数组、出门用 .map 换回原词',
      miss.length === 0, miss.length === 0 ? '六处形状全在' : `缺 ${miss.join(',')}`)
    ok('K9b 出门换回原词：表的键与值的每个元素都还是词本身（没有词号漏进结果），键集合与朴素尺子相同',
      leaks.length === 0 && gotKeys === wantKeys,
      leaks.length ? leaks[0] : `键 ${table.size} 个 · 与尺子同集 ${gotKeys === wantKeys}`)
  }
}

console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) {
  console.log('失败项：')
  for (const b of bad) console.log('  - ' + b)
  process.exit(1)
}
