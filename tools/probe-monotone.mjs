#!/usr/bin/env node
/**
 * [macro-fusion 0.6.8] 单调式探针——钉住「会随时间前进的量，不许写成等值」。
 *
 * 病根（PLAN §12 #6）：版本号 / 支数 / 断言总数 / 耗时预算这几类量**每一版都在变**，
 * 一旦被写成 `===`，每升一版必红一次（0.2.31→32→34→35 各踩一遍；0.6.x 每版都在
 * 手工抬 `steps.length === 35 → 36`，还要连带改两处文档里的「N 支 / M 条」）。
 * 红一次不算事故，但「红」会训练人无视红——那才是真代价。
 *
 * 处方不是「记得去改」，而是**把断言写成单调式**：地板只许抬不许降，实际值用 `>=` 比。
 * 这个探针把这条规矩本身钉成一个可执行判据：静态扫源码里的等值写法，再拿真实文件
 * 与基线对账，最后用内存样本证明扫描器真的会红（不是永远 PASS 的摆设）。
 *
 *   M1 verify 里支数断言是单调式（有 `SUITE_FLOOR` 且用 `steps.length >= SUITE_FLOOR`）
 *   M2 全仓脚本里没有「把当前版本号写成字面量再等值比」的写法
 *   M3 扫描器能红证明：`steps.length === 36` 必须被扫出，`steps.length >= 36` 不许被扫出
 *   M4 文档里「现在」那个条数 = tools/baselines.json 的合计（当前事实，自动对账）
 *   M5 README 的版本阶梯单调：按文档顺序（新→旧）条数不许上升
 *   M6 历史里程碑保留自己那版的数字（不许被连带改成当前数）
 *   M7 耗时预算只许抬：每支 budgetMs >= ms，且不低于 30s 地板
 *   M8 扫描面完整：verify.mjs 与 tools/*.mjs 全扫过，条数与磁盘上的文件数相等
 *
 * 用法：node tools/probe-monotone.mjs   （挂进 check-all；只读文件，不写任何东西）
 */
import { root } from './_root.mjs'
import { join } from 'node:path'
import { readFileSync, readdirSync } from 'node:fs'

let total = 0
let failures = 0
function check(label, ok, extra) {
  total++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra === undefined || extra === '' ? '' : `  ${extra}`}`)
  if (!ok) failures++
}

const read = (rel) => readFileSync(join(root, rel), 'utf8')

// ── 规则表：把「会随时间前进的量」按形状找出来 ───────────────────────────────────
// 只认「拿当前体量去比等值」的写法：支数等值（0 除外——「一支都没有」是真的条件，
// 不是体量断言）、版本字面量等值、总数等值、耗时等值。样本数据里的 `=== '0.4.1'`
// 是造出来的题干（`sp.conflictOf('当前 0.4.1', …)`），不在此列，故意不扫。
const RULES = [
  { name: '支数等值', re: /(?:steps|suites)\.length\s*===\s*[1-9]\d*/ },
  { name: '版本字面量等值', re: /(?:version|Version|VERSION)[\w.]*\s*===\s*['"]0\.\d+\.\d+['"]/ },
  { name: '断言总数等值', re: /(?:assertions|totalCount|合计)\s*===\s*\d{3,}/ },
  { name: '耗时等值', re: /elapsed\s*===\s*\d+/ },
]
function scanMonotone(text) {
  const hits = []
  for (const line of text.split('\n')) {
    const code = line.replace(/\/\/.*$/, '').replace(/^\s*\*.*$/, '')
    for (const r of RULES) {
      if (r.re.test(code)) hits.push(r.name)
    }
  }
  return hits
}

// ── M1：verify 的支数断言必须是单调式 ──────────────────────────────────────────
const verifySrc = read('verify.mjs')
const hasFloor = /const SUITE_FLOOR\s*=\s*\d+/.test(verifySrc)
const usesFloor = /steps\.length\s*>=\s*SUITE_FLOOR/.test(verifySrc)
const oldEq = /steps\.length\s*===\s*\d+/.test(verifySrc)
check(
  'M1 verify 的支数断言是单调式（`SUITE_FLOOR` 地板 + `steps.length >= SUITE_FLOOR`）',
  hasFloor && usesFloor && !oldEq,
  `floor=${hasFloor} 用=${usesFloor} 旧等值=${oldEq}`,
)

// ── M2：全仓脚本里不许有「当前体量写成等值」 ─────────────────────────────────────
// 扫描器自己例外：它的规则表与红样本本身就是这些形状（扫自己必然红，且红得毫无信息）。
const SELF = 'tools/probe-monotone.mjs'
const scriptFiles = ['verify.mjs']
for (const f of readdirSync(join(root, 'tools'))) {
  if (f.endsWith('.mjs')) scriptFiles.push(`tools/${f}`)
}
const scanned = scriptFiles.filter((f) => f !== SELF)
const offenders = []
for (const f of scanned) {
  const hits = scanMonotone(read(f))
  if (hits.length > 0) offenders.push(`${f}: ${hits.join('/')}`)
}
check('M2 全仓脚本里没有把版本 / 支数 / 总数写成等值', offenders.length === 0, offenders.join('；') || `${scanned.length} 个脚本`)

// ── M3：扫描器能红也认绿（内存样本，不靠子进程） ────────────────────────────────
const redSample = scanMonotone('if (steps.length === 36 && ok) {}')
const greenSample = scanMonotone('if (steps.length >= 36 && ok) {}')
const verRed = scanMonotone("if (pkg.version === '0.6.7') {}")
check(
  'M3 扫描器能红证明：等值写法被扫出、单调式放行',
  redSample.includes('支数等值') && greenSample.length === 0 && verRed.includes('版本字面量等值'),
  `等值=${redSample.join('+') || '(漏)'} / 单调=${greenSample.length === 0 ? '放行' : greenSample.join('+')} / 版本=${verRed.join('+') || '(漏)'}`,
)

// ── M4：文档「现在」的条数 = 基线合计 ──────────────────────────────────────────
// 这里有个先有鸡还是先有蛋：新加一支套件时，基线里还没有它的条数，而它自己正
// 被 `--update-baselines` 这一趟跑着——于是「文档 = 基线合计」在记账之前必然差
// 一支。为此不加宽判据，而是**把这两种状态分开说**：
//   · 基线已覆盖 check-all 的每一支 → 严格相等，差一条就红；
//   · 基线还缺某支（正在记账）→ 只要求「文档数 >= 基线合计」并把缺的那支点名，
//     等 `--update-baselines` 跑完自动转回严格态（缺支已由 check-all 自己报出来）。
const base = JSON.parse(read('tools/baselines.json'))
const baseTotal = Object.values(base.counts).reduce((a, n) => a + n, 0)
const baseSuites = Object.keys(base.counts).length
const registered = Object.keys(base.counts)
// 「正在记账」只看 check-all 真正跑的那些支：tools 下还有一堆只给人工跑的
// 辅助脚本（sync-trees / make-vendor-manifest / bench-locomo…），它们永远不
// 会有基线——拿它们判「缺支」会让严格态永远不生效。
const checkAllSrc = read('tools/check-all.mjs')
const suiteSteps = [...checkAllSrc.matchAll(/\[\s*'(verify\.mjs|tools\/[\w-]+\.mjs)'/g)].map((m) => m[1])
const absent = suiteSteps.filter((f) => !registered.includes(f))
const readme = read('README.md')
// 里程碑从 README 搬到了 docs/CHANGELOG.md（0.6.74）：README 是产品页，只讲现在能做什么；
// 历史阶梯留在 CHANGELOG，判据照样守着——「新版本的支数与条数不许少于旧版本」这条不放松。
const changelog = read('docs/CHANGELOG.md')
const scaleRow = (readme.match(/^\| 自证规模 \| \*\*(\d+) 支自检 \/ ([\d,]+) 条可执行断言\*\*/m) ?? []).slice(1)
const rowSuites = Number(scaleRow[0])
const rowTotal = Number((scaleRow[1] ?? '').replace(/,/g, ''))
const strict = absent.length === 0
check(
  `M4 README 自证规模行与基线合计一致${strict ? '' : '（记账中：只要求不少于合计）'}`,
  strict ? rowSuites === baseSuites && rowTotal === baseTotal : rowTotal >= baseTotal && rowSuites >= baseSuites,
  `README ${rowSuites} 支 / ${rowTotal} 条 · 基线 ${baseSuites} 支 / ${baseTotal} 条${absent.length ? ` · 还没记账 ${absent.join(',')}` : ''}`,
)
const claimsSrc = read('docs/EVAL-CLAIMS.md')
const claimRow = (claimsSrc.match(/^\| 健康基线 \| (\d+) 支 suite \/ \*\*([\d,]+) 断言\*\*/m) ?? []).slice(1)
const claimSuites = Number(claimRow[0])
const claimTotal = Number((claimRow[1] ?? '').replace(/,/g, ''))
check(
  `M4b EVAL-CLAIMS 健康基线行与基线合计一致${strict ? '' : '（记账中：只要求不少于合计）'}`,
  strict ? claimSuites === baseSuites && claimTotal === baseTotal : claimTotal >= baseTotal && claimSuites >= baseSuites,
  `EVAL-CLAIMS ${claimRow[0] ?? '?'} 支 / ${claimRow[1] ?? '?'} 条`,
)

// ── M5：CHANGELOG 的版本阶梯按「版本号」单调（新版本条数不许少于旧版本） ───────────
// 按版面顺序扫会被里程碑的排版顺序绊倒（历史上有把 0.4.0 里程碑排到 0.6.x 上面的时候），
// 所以只认「同一条里既有版本号又有条数」的行，再按版本号两两比较——这才是单调式的本意。
const ladder = []
for (const line of changelog.split('\n')) {
  const v = line.match(/(0\.\d+\.\d+) 里程碑/)
  const n = line.match(/(\d+) 支自检 \/ ([\d,]+) 条/)
  if (v && n) ladder.push({ v: v[1], suites: Number(n[1]), n: Number(n[2].replace(/,/g, '')) })
}
const cmp = (a, b) => {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i]
  return 0
}
const undone = []
for (const hi of ladder) {
  for (const lo of ladder) {
    if (cmp(hi.v, lo.v) > 0 && hi.n < lo.n) undone.push(`${hi.v}(${hi.n}) < ${lo.v}(${lo.n})`)
    if (cmp(hi.v, lo.v) > 0 && hi.suites < lo.suites) undone.push(`${hi.v}(${hi.suites} 支) < ${lo.v}(${lo.suites} 支)`)
  }
}
check(
  'M5 CHANGELOG 的版本阶梯单调：新版本的支数与条数都不许少于旧版本',
  ladder.length >= 3 && undone.length === 0,
  `${ladder.length} 级 ${undone.join(',')}`,
)

// ── M6：历史里程碑保留自己那版的数字 ──────────────────────────────────────────
// 只能按「那一行」取：里程碑都是单行长文，跨行抓会把后面几版的数字一起吞进来。
const m066Line = changelog.split('\n').find((l) => l.startsWith('> **0.6.6 里程碑**')) ?? ''
const m066 = (m066Line.match(/\*\*(\d+) 支自检 \/ ([\d,]+) 条断言\*\*/) ?? []).slice(1)
check(
  'M6 CHANGELOG 里的 0.6.6 里程碑保留自己那版的数字（不被连带改成当前数）',
  m066.length === 2 && Number(m066[1].replace(/,/g, '')) === 3616,
  m066.length === 2 ? `${m066[0]} 支 / ${m066[1]} 条` : '(没找到)',
)

// ── M7：耗时预算只许抬 ────────────────────────────────────────────────────────
const tight = Object.entries(base.budgetMs ?? {}).filter(([k, b]) => !(b >= Math.max(30000, base.ms?.[k] ?? 0)))
check('M7 每支的耗时预算都不低于实测与 30s 地板', tight.length === 0, tight.map(([k, b]) => `${k}=${b}`).join(',') || `${Object.keys(base.budgetMs ?? {}).length} 支`)

// ── M8：扫描面完整（不许只扫白名单） ──────────────────────────────────────────
const toolFiles = readdirSync(join(root, 'tools')).filter((f) => f.endsWith('.mjs'))
check(
  'M8 扫描面完整：tools/*.mjs（除扫描器自己）与 verify.mjs 全扫过',
  scanned.length === toolFiles.length && scanned.includes('verify.mjs') && !scanned.includes(SELF),
  `${scanned.length} 个脚本 = tools ${toolFiles.length} - 自己 1 + verify 1`,
)

console.log(failures === 0 ? `\nALL PASS  probe-monotone：${total}/${total}` : `\n${failures} 条失败（共 ${total}）`)
process.exit(failures === 0 ? 0 : 1)
