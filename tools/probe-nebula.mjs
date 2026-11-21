/**
 * 验收（0.2.158）：星图面板层——引力可调、局部图 N 跳、标签随距离淡出。
 *
 * 三件事分开验，因为坏的方式不一样：
 * 1) **纯函数**（space3d.js 里 neighborhoodIds / forceParams / labelAlpha）——在 vm 沙箱里
 *    真跑一遍，给边界值。这三个函数是「面板画成什么样」的唯一依据，写错了画面就是错的，
 *    但没有任何抛错会提醒你。
 * 2) **接线**（app.js / space3d.js 源码形状）——滑杆接上了吗、拖动时是不是每一像素都重排、
 *    存的值下次打开还生效吗。这些是「功能在但没人能用」的典型，只能靠断言源码。
 * 3) **单一来源**——面板的默认值来自渲染器导出的 FORCE_BASE，不和 create() 里那份 FORCE
 *    各写一遍。两份数字早晚分叉，分叉之后滑杆回到默认位置反而把布局弄坏。
 *
 * 面板是 iframe 里的静态文件，一个字节都不进请求前缀——所以这支探针也不启动 DSH、不碰真库。
 * 用法：node tools/probe-nebula.mjs
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import vm from 'node:vm'

import { root } from './_root.mjs'

const WEB = join(root, 'vendor', 'dsh-memory-nebula', 'lib', 'web')
const results = []
const check = (label, ok, extra = '') => {
  results.push({ label, ok, extra })
  console.log((ok ? 'PASS ' : 'FAIL ') + label + (extra ? '  ' + extra : ''))
}

// Web 侧文件是 CRLF 落盘的：正则里写换行之前先归一，否则带换行的接线断言会假红
const norm = (s) => s.replace(/\r\n/g, '\n')
const spaceSrc = norm(readFileSync(join(WEB, 'space3d.js'), 'utf8'))
const appSrc = norm(readFileSync(join(WEB, 'app.js'), 'utf8'))
const cssSrc = norm(readFileSync(join(WEB, 'style.css'), 'utf8'))

// ── 1. 在沙箱里把 space3d.js 跑起来，拿出它导出的纯函数 ────────────────────
// 只给 window：这个文件顶层只往 window.NebulaSpace 挂东西，碰 document 的部分都在 create() 里。
const noop = () => {}
const store = new Map()
const sandbox = {
  window: {},
  localStorage: {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  },
  document: { createElement: () => ({ style: {}, getContext: () => null, addEventListener: noop }) },
  requestAnimationFrame: () => 0,
  cancelAnimationFrame: noop,
  performance: { now: () => 0 },
  console,
}
sandbox.globalThis = sandbox
sandbox.self = sandbox.window

let NS = null
try {
  vm.runInNewContext(spaceSrc, sandbox, { filename: 'space3d.js' })
  NS = sandbox.window.NebulaSpace
} catch (err) {
  check('space3d.js 能在纯 window 沙箱里跑起来', false, String(err && err.message))
}
check('space3d.js 能在纯 window 沙箱里跑起来', !!NS)
check(
  '导出了三个纯函数与 FORCE_BASE',
  !!NS && typeof NS.neighborhoodIds === 'function' && typeof NS.forceParams === 'function' && typeof NS.labelAlpha === 'function' && !!NS.FORCE_BASE,
)

if (NS) {
  // ── 局部图：N 跳邻域 ────────────────────────────────────────────────────
  // A─B─C─D 一条链 + X─Y 一对孤岛 + Z 完全孤立
  const edges = [
    { a: 'A', b: 'B' },
    { a: 'B', b: 'C' },
    { a: 'C', b: 'D' },
    { a: 'X', b: 'Y' },
  ]
  const nb1 = NS.neighborhoodIds(edges, 'A', 1)
  check('1 跳：只到直接邻居', !!nb1 && [...nb1].sort().join(',') === 'A,B', nb1 ? [...nb1].sort().join(',') : 'null')
  const nb2 = NS.neighborhoodIds(edges, 'A', 2)
  check('2 跳：链上再走一格', !!nb2 && [...nb2].sort().join(',') === 'A,B,C', nb2 ? [...nb2].sort().join(',') : 'null')
  const nb3 = NS.neighborhoodIds(edges, 'A', 3)
  check('3 跳：整条链', !!nb3 && nb3.size === 4, nb3 ? String(nb3.size) : 'null')
  check('走不到的那对孤岛不会被拉进来', !!nb3 && !nb3.has('X') && !nb3.has('Y'))
  const nbIso = NS.neighborhoodIds(edges, 'Z', 4)
  check('完全孤立的点只留它自己（不是空图）', !!nbIso && nbIso.size === 1 && nbIso.has('Z'))
  check('depth = 0 返回 null（意思是回全图，不是空集合）', NS.neighborhoodIds(edges, 'A', 0) === null)
  check('没给 id 返回 null', NS.neighborhoodIds(edges, '', 3) === null)
  // vm 沙箱里造出来的 Set 和宿主的 Set 不是同一个构造器：只认「有没有 size」，不认 instanceof
check('边表是空的也不炸（只剩起点自己）', (() => { const nb = NS.neighborhoodIds([], 'A', 2); return !!nb && typeof nb.has === 'function' && nb.size === 1 && nb.has('A') })())
  check('坏边（缺端点 / null）被跳过', NS.neighborhoodIds([null, { a: 'A' }, { a: 'A', b: 'B' }], 'A', 1).size === 2)

  // ── 引力：界面值 → 力常数 ───────────────────────────────────────────────
  const dft = NS.forceParams({})
  check(
    '空参数回默认值',
    dft.repulse === NS.FORCE_BASE.repulse && dft.springRest === NS.FORCE_BASE.springRest && dft.clusterPull === NS.FORCE_BASE.clusterPull && dft.damping === NS.FORCE_BASE.damping,
  )
  check('越界往下夹（斥力 999999 → 20000）', NS.forceParams({ repulse: 999999 }).repulse === 20000)
  check('越界往上夹（弹簧 1 → 30）', NS.forceParams({ springRest: 1 }).springRest === 30)
  check('向心夹到 0.08', NS.forceParams({ clusterPull: 5 }).clusterPull === 0.08)
  check('阻尼夹到 0.96', NS.forceParams({ damping: 5 }).damping === 0.96)
  check('非数字回默认（不是 NaN）', NS.forceParams({ repulse: 'abc' }).repulse === NS.FORCE_BASE.repulse)
  check('null / undefined 值回默认', NS.forceParams({ damping: null }).damping === NS.FORCE_BASE.damping)

  // ── 标签透明度：一段曲线，不是开关 ─────────────────────────────────────
  check('近处全亮（500 < 1100）', NS.labelAlpha(500, 1100, 1900) === 1)
  check('窗口正中 0.5', Math.abs(NS.labelAlpha(1500, 1100, 1900) - 0.5) < 1e-9)
  check('远处全灭（2500 > 1900）', NS.labelAlpha(2500, 1100, 1900) === 0)
  check('边界上仍是 1 / 0', NS.labelAlpha(1100, 1100, 1900) === 1 && NS.labelAlpha(1900, 1100, 1900) === 0)
  check('窗口给反了不返回负数（退化成按近端一刀切）', NS.labelAlpha(1500, 1900, 1100) === 1 && NS.labelAlpha(2000, 1900, 1100) === 0)
  check('距离是 NaN 时返回 0（不写进去一堆 NaN alpha）', NS.labelAlpha(NaN, 1100, 1900) === 0)

  // ── 单一来源：create() 里那份 FORCE 与导出的 FORCE_BASE 必须同数 ────────
  const forceLit = spaceSrc.match(/const FORCE = \{[\s\S]*?\n    \}/)
  const lit = forceLit ? forceLit[0] : ''
  const grab = (k) => {
    const m = lit.match(new RegExp(`${k}:\\s*([\\d.]+)`))
    return m ? Number(m[1]) : NaN
  }
  check(
    'FORCE_BASE 与 create() 里的 FORCE 同数（面板默认值不另写一份）',
    grab('repulse') === NS.FORCE_BASE.repulse && grab('springRest') === NS.FORCE_BASE.springRest && grab('clusterPull') === NS.FORCE_BASE.clusterPull && grab('damping') === NS.FORCE_BASE.damping,
    `lit=${grab('repulse')}/${grab('springRest')}/${grab('clusterPull')}/${grab('damping')}`,
  )
}

// ── 2. space3d.js 的接线 ───────────────────────────────────────────────────
check('局部图在 visible() 里收口（不各自为政）', /if \(state\.local && !state\.local\.has\(n\.id\)\) return false/.test(spaceSrc))
check('setLocal 走 neighborhoodIds，并记下 localId', /setLocal\(id, depth\) \{[\s\S]{0,400}neighborhoodIds\(state\.edges, id, depth\)[\s\S]{0,200}state\.localId = /.test(spaceSrc))
check('localInfo 给出「裁到几条」', /localInfo\(\) \{[\s\S]{0,200}count: state\.local\.size/.test(spaceSrc))
check('setForce 改的是真 FORCE 对象（不是另存一份）', /setForce\(ui\) \{[\s\S]{0,400}FORCE\.repulse = p\.repulse[\s\S]{0,200}FORCE\.springRest = p\.springRest/.test(spaceSrc))
check('setForce 之后丢掉布局缓存并重新收敛', /setForce\(ui\) \{[\s\S]{0,700}localStorage\.removeItem\(cacheKey\(\)\)[\s\S]{0,400}layout\(\)/.test(spaceSrc))
check('标签层接进了 drawLabels', /drawClusterLabels\(\)\n\s+drawFocusLabel\(\)\n\s+drawNodeLabels\(\)/.test(spaceSrc))
check('标签数量有上限（不是每颗星都写名字）', /rank >= 14/.test(spaceSrc))
check('悬停/选中的那颗不受上限限制', /if \(focus\) \{[\s\S]{0,200}cands\.indexOf\(f\) < 0/.test(spaceSrc))
check('标签文字截断（长标题不糊一行）', /function clipLabel\(text\) \{[\s\S]{0,200}slice\(0, 17\)/.test(spaceSrc))

// ── 3. app.js 的面板接线 ───────────────────────────────────────────────────
// 面板的兜底数字（渲染器还没加载时滑杆先显示的那几个数）必须与 FORCE_BASE 同数。
// 允许这份镜像存在，是因为 buildFilters 可能早于 space3d.js 加载；不允许它悄悄漂。
if (NS) {
  const fb = appSrc.match(/const base = \(NS && NS\.FORCE_BASE\) \|\| \{([^}]*)\}/)
  const nums = {}
  if (fb) for (const m of fb[1].matchAll(/(\w+):\s*([\d.]+)/g)) nums[m[1]] = Number(m[2])
  check(
    '面板兜底值与 FORCE_BASE 同数（漂了就是两套默认值）',
    fb && ['repulse', 'springRest', 'clusterPull', 'damping'].every((k) => nums[k] === NS.FORCE_BASE[k]),
    fb ? JSON.stringify(nums) : 'pattern-miss',
  )
}

check('四个引力滑杆的规格表在（key 全对）', ['repulse', 'springRest', 'clusterPull', 'damping'].every((k) => new RegExp(`key: '${k}'`).test(appSrc)))
check('引力存本机（localStorage）', /const FORCE_KEY = 'nebula\.force'/.test(appSrc) && /localStorage\.setItem\(FORCE_KEY/.test(appSrc))
check('拖动时只改数字，不重排（oninput 里没有 applyForceToStage）', (() => {
  const m = appSrc.match(/inp\.oninput = \(\) => \{[\s\S]*?\n      \}/)
  return !!m && !/applyForceToStage|setForce/.test(m[0])
})())
check('松手（onchange）才落盘 + 重排', /inp\.onchange = \(\) => \{[\s\S]{0,400}saveForceUI\(forceUI\)\n\s+applyForceToStage\(\)/.test(appSrc))
check('默认值从渲染器取（调 forceDefaults 里读 FORCE_BASE）', /const base = \(NS && NS\.FORCE_BASE\)/.test(appSrc))
check('存坏了不拦人（JSON.parse 包在 try 里）', /try \{\n\s+saved = JSON\.parse\(localStorage\.getItem\(FORCE_KEY\)/.test(appSrc))
check('建好渲染器就套用存下来的引力', /if \(state\.space3d\) applyForceToStage\(\)/.test(appSrc))
check('局部图滑杆 0–4 跳（0 = 全图）', /rangeL\.min = '0'[\s\S]{0,200}rangeL\.max = '4'/.test(appSrc))
check('局部图只对三维渲染器接线（r === state.space3d）', /if \(r === state\.space3d\) applyLocal\(id\)/.test(appSrc))
check('没选中就拖局部图会说一句（不静默）', /先点一颗星，局部图才知道从谁出发/.test(appSrc))
check('applyLocal 用 null 表示全图（不是空集合）', /state\.space3d\.setLocal\(null, 0\)/.test(appSrc))
check('两段控件都能折叠（attachFold）', /attachFold\(sectF, 'f:force'\)/.test(appSrc) && /attachFold\(sectL, 'f:local'\)/.test(appSrc))
check('滑杆前的名字有样式（不然四个数字看不出是什么）', /\.slider \.k \{/.test(cssSrc))

// ── 4. 阴性对照：判据不是纸做的 ────────────────────────────────────────────
// 在内存里把源码改一处，断言那一条判据真的会红；磁盘上的文件一个字节都不动。
const forceJudge = (s) => {
  const fb = s.match(/const base = \(NS && NS\.FORCE_BASE\) \|\| \{([^}]*)\}/)
  const nums = {}
  if (fb) for (const m of fb[1].matchAll(/(\w+):\s*([\d.]+)/g)) nums[m[1]] = Number(m[2])
  return !!fb && ['repulse', 'springRest', 'clusterPull', 'damping'].every((k) => nums[k] === NS.FORCE_BASE[k])
}
{
  const negs = [
    {
      name: '局部图收口',
      src: spaceSrc,
      mutate: (s) => s.replace('if (state.local && !state.local.has(n.id)) return false', ''),
      judge: (s) => /if \(state\.local && !state\.local\.has\(n\.id\)\) return false/.test(s),
    },
    {
      name: '松手才重排',
      src: appSrc,
      // 往「第一根滑杆的 oninput」里塞一次重排：判据必须因此变红
      mutate: (s) => {
        const m = s.match(/inp\.oninput = \(\) => \{[\s\S]*?\n      \}/)
        if (!m) return s
        return s.replace(m[0], m[0].replace(/\n      \}$/, '\n        applyForceToStage()\n      }'))
      },
      judge: (s) => {
        const m = s.match(/inp\.oninput = \(\) => \{[\s\S]*?\n      \}/)
        return !!m && !/applyForceToStage|setForce/.test(m[0])
      },
    },
    {
      name: '兜底数字漂一位',
      src: appSrc,
      mutate: (s) =>
        s.replace(
          /(const base = \(NS && NS\.FORCE_BASE\) \|\| \{[^}]*repulse:\s*)(\d+)/,
          (m, head, digits) => head + (Number(digits) + 1),
        ),
      judge: forceJudge,
    },
  ]
  for (const one of negs) {
    const broken = one.mutate(one.src)
    check(
      `阴性对照：${one.name} 判据真的会红`,
      broken !== one.src && one.judge(broken) === false,
      broken === one.src ? 'mutate-miss' : '',
    )
  }
}

// ── 汇总 ───────────────────────────────────────────────────────────────────
const failed = results.filter((r) => !r.ok)
console.log('---')
console.log(`结果：${results.length - failed.length}/${results.length} PASS`)
if (failed.length) {
  console.log('失败项：')
  for (const f of failed) console.log('  - ' + f.label + (f.extra ? '  ' + f.extra : ''))
}
process.exit(failed.length ? 1 : 0)
