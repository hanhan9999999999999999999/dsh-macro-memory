#!/usr/bin/env node
/**
 * 一次体检：交付物一致性 + 加载面 + 运行时账本，全部只读。
 *
 * 为什么需要它：本插件是「vendor 源码 + profile 实体拷贝」两处部署（DESIGN §11.3），
 * 最容易出的错不是代码写错，而是**两处不同步**——vendor 改了、profile 还是旧版，
 * DSH 重启后加载的是旧的那份，而所有单点脚本都是「在哪跑就只测哪」。
 * 这个脚本把两棵树按字节比一遍，并核对 profile patch/bundles 与产物 hash。
 *
 * 用法：node tools/doctor.mjs          # 本目录体检（自动识别是否 profile 拷贝）
 *       node tools/doctor.mjs --strict # 有 WARN 也返回非零（发版前用）
 */
import { root } from './_root.mjs'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, join, relative } from 'node:path'
import { pathToFileURL } from 'node:url'
import { makeVerdict } from './doctor-verdict.mjs'
import * as criteria from './criteria.mjs'

const VENDOR = 'D:\\dsh-home\\vendor\\dsh-macro-memory'
const PROFILE_HOME = 'D:\\dsh-home\\profiles\\desktop'
const PROFILE = join(PROFILE_HOME, 'node_modules', 'dsh-macro-memory')
const OLD_IDS = ['meow-memory', 'dsh-memory-nebula']
const STRICT = process.argv.includes('--strict')

// 判决与记账在 tools/doctor-verdict.mjs（0.2.73）：tag 说 FAIL 就算失败，
// 不再看第二参——以前 22 处 line(<cond> ? 'PASS' : 'FAIL', true, …) 的 FAIL 只是四个字母。
const verdict = makeVerdict()
const { line, pass, fail, warn } = verdict

const sha = (file) => createHash('sha256').update(readFileSync(file)).digest('hex')
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'))

/** 递归列出相对路径（跳过 node_modules / .probe-home / 临时文件）。 */
function walk(dir, base = dir, out = []) {
  if (!existsSync(dir)) return out
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.probe-home') continue
    const abs = join(dir, name)
    const st = statSync(abs)
    if (st.isDirectory()) walk(abs, base, out)
    else out.push(relative(base, abs).replace(/\\/g, '/'))
  }
  return out
}

// ── 1. 版本与身份 ───────────────────────────────────────────────────────────
console.log('== 版本与身份 ==')
const pkg = readJson(join(root, 'package.json'))
const here = sha(join(root, 'package.json')) === sha(join(PROFILE, 'package.json')) ? '与 profile 一致' : '与 profile 不同'
pass('name', `name=${pkg.name}`)
console.log(`      version=${pkg.version}（${here}）`)
const indexSrc = readFileSync(join(root, 'lib', 'index.js'), 'utf8')
const declared = indexSrc.match(/export const version = '([^']+)'/)?.[1]
line(declared === pkg.version ? 'PASS' : 'FAIL', true, 'version 单一来源', `package.json=${pkg.version} lib/index.js=${declared}`)
line(/inject\s*=\s*\[[^\]]*'tools'/.test(indexSrc) ? 'PASS' : 'FAIL', true, 'inject 含 tools')
line(/export function apply|export async function apply/.test(indexSrc) ? 'PASS' : 'FAIL', true, '导出 apply')
console.log(`      运行位置=${root === PROFILE ? 'profile 实体拷贝' : 'vendor 源码'}`)

// ── 2. 两棵树同步（谁跑谁比：vendor 跑就 vendor↔profile，profile 跑就 profile↔vendor）──
// 0.2.18 修：原来在 profile 里跑只是「跳过对比」，导致同一份代码在两棵树里数出来的断言条数不一样
// （40 vs 41），基线就永远差一条。对称比较后两边各一条 PASS，条数一致，基线才能只有一组数字。
console.log('\n== vendor ↔ profile 同步 ==')
const FILES_AT_ROOT = [
  'package.json', 'README.md', 'DESIGN.md', 'verify.mjs', 'build.mjs',
  // 0.2.81：发布物里有对外承诺的两份文件，两棵树都得有，否则 profile 里跑出来的产物会缺许可声明。
  'LICENSE', 'THIRD-PARTY-NOTICES.md',
]
function treeSync(aRoot, bRoot) {
  const list = (r) =>
    walk(join(r, 'lib'))
      .map((p) => `lib/${p}`)
      .concat(walk(join(r, 'tools')).map((p) => `tools/${p}`))
      // vendor/ 也要比：我们在这两个第三方引擎上打了极少数补丁（见下一段「补丁账本」），
      // 只比 lib/tools 的话，「vendor 改了忘了同步」会静默漏过去。
      .concat(walk(join(r, 'vendor')).map((p) => `vendor/${p}`))
      .concat(FILES_AT_ROOT.filter((f) => existsSync(join(r, f))))
  const mine = list(aRoot)
  const theirs = list(bRoot)
  const drift = []
  for (const rel of mine) {
    const b = join(bRoot, rel)
    if (!existsSync(b)) drift.push(`${rel}（对方缺）`)
    else if (sha(join(aRoot, rel)) !== sha(b)) drift.push(`${rel}（内容不同）`)
  }
  const extra = theirs.filter((rel) => !existsSync(join(aRoot, rel)))
  return { drift, extra, count: mine.length }
}
{
  const pair = root === PROFILE ? treeSync(PROFILE, VENDOR) : treeSync(root, PROFILE)
  if (pair.drift.length === 0 && pair.extra.length === 0) pass('两处字节一致', `${pair.count} 个文件`)
  else {
    fail('两处不一致', `${pair.drift.length} 个漂移 / ${pair.extra.length} 个多余`)
    for (const d of pair.drift.slice(0, 12)) console.log(`      drift: ${d}`)
    for (const e of pair.extra.slice(0, 12)) console.log(`      extra: ${e}`)
  }
}

// ── 3. 加载面：profile patch + bundles + 客户端产物 ────────────────────────
console.log('\n== 加载面 ==')
const profilePkg = join(PROFILE_HOME, 'package.json')
if (!existsSync(profilePkg)) warn('找不到 profile package.json', profilePkg)
else {
  const pp = readJson(profilePkg)
  const bundles = pp?.dsh?.profile?.bundles ?? []
  line(bundles.includes('dsh-macro-memory') ? 'PASS' : 'FAIL', true, 'bundles 含 dsh-macro-memory', `${bundles.length} 项`)
  const bad = OLD_IDS.filter((id) => bundles.includes(id))
  line(bad.length === 0 ? 'PASS' : 'FAIL', true, 'bundles 不含旧 id', bad.join(',') || '无')

  const patchFile = pp?.dsh?.profile?.patch ?? 'cordis.patch.yml'
  const patchPath = join(PROFILE_HOME, patchFile)
  if (!existsSync(patchPath)) warn('找不到 patch 文件', patchPath)
  else {
    const src = readFileSync(patchPath, 'utf8')
    const macroHits = (src.match(/name:\s*'?"?dsh-macro-memory/g) ?? []).length
    line(macroHits === 1 ? 'PASS' : 'FAIL', true, 'patch 里恰好 1 条 dsh-macro-memory', String(macroHits))
    for (const id of OLD_IDS) {
      const n = (src.match(new RegExp(`name:\\s*'?"?${id}`, 'g')) ?? []).length
      line(n === 0 ? 'PASS' : 'FAIL', true, `patch 不含 ${id}`, String(n))
    }
  }
  // 这一段只看文本：文本写着 ≠ 装配后活着。真判据在 DSH 自己的 app-boot 里，
  // 由 tools/probe-load.mjs 去问（0.2.23）。这里只确认那条路还在，避免它被悄悄摘掉。
  line(existsSync(join(root, 'tools', 'probe-load.mjs')) ? 'PASS' : 'FAIL', true, '加载面还有 probe-load 去问 DSH 自己', 'tools/probe-load.mjs')
}

const clientFile = join(root, 'lib', 'client.js')
if (!existsSync(clientFile)) fail('lib/client.js 不存在（先跑 node build.mjs）')
else {
  const buf = readFileSync(clientFile)
  const src = buf.toString('utf8')
  pass('lib/client.js', `${buf.length} B  sha256=${createHash('sha256').update(buf).digest('hex').slice(0, 12)}…`)
  for (const id of ['dsh-macro-memory', 'dsh-macro-memory-meow', 'dsh-macro-memory-nebula']) {
    line(src.includes(id) ? 'PASS' : 'FAIL', true, `产物含 ${id}`)
  }
  (src.includes('brandCtx') ? pass : warn)('产物含 panel 归口（brandCtx）')
}

// ── 4. 补丁账本：vendor 里是我们拷进来的第三方引擎，改动必须记账 ──────────────
// 为什么单独一段：vendor 升级/重新拷贝会静默把补丁冲掉，而补丁没了不会报错，
// 只会让行为退回上游（例如归档的记忆又出现在检索结果里）。补丁必须能被机器找回来。
console.log('\n== 补丁账本 ==')
const PATCHES = [
  {
    marker: '[macro-fusion 0.2.111]',
    file: 'vendor/meow-memory/lib/index.js',
    what: "[macro-fusion 0.2.111] 账本多一条「项目走向」：层走向只说哪一层在涨，说不出是谁在涨。①写侧 vendor/meow-memory/lib/index.js 新增 PROJECT_LAYERS 五层表（project/fact/lesson/topic/rules）与 dreamStoreProjects(db)，每层 SELECT project AS name, COUNT(*) AS n FROM ${level} WHERE status='active' GROUP BY project，name trim 后为空跳过、跨层同名相加，dreamStoreScale 返回 { active, byLevel, byProject? }（byProject 只在非空时出现，空对象会被读成「数过，零个项目」），并把 dreamStoreProjects 一并导出；soul / user 没有 project 列，口径句必须写「只数 5 层」。②读侧 lib/macro/dreamledger.js 的 storeOf 多解一格 byProject（正数才认、名字 trim），新增 projectSeriesOf(plan)（只认 plan?.storeEnd.byProject，老账没有这一格就是没有，不补 0）与 projectTrendLine(rows)（isFullRound 过滤、kept.length < 2 返回空、kept.reverse()、按 |delta| 排序取前 4、三支结论：每个项目的条数都没变 / 涨得最多的是 X（+N）/ 掉得最多的是 X（-N），caveats 报「还有 N 个项目没列」「N 次没跑完」「N 次没有收尾项目数（0.2.111 之前的账没有这一格）」，常驻口径「只数带项目归属的 5 层（soul / user 没有这一格），项目名按写入时原样——改过名的会算成两行」）。③readDreamPanel 第 1 页紧跟 levelTrendLine 之后 push 项目走向，并补 scope 句「项目走向按每一轮收尾时的 storeEnd.byProject 数，只有 0.2.111 之后的账有这一格」。④探针 tools/probe-ruler.mjs L29–L31（真库跨层相加 3 / 1、全「全局」库不出现 null 或空名、归档后 Beta 键整个消失）、tools/probe-fusion.mjs D67–D70（三轮摊开 +3 / -2、口径三条、单轮不出、全没变就说没变）；verify.mjs 新增 0.2.111 块 10 条，并把老断言「写侧真的去数库」的 return { active, byLevel } 改成 const out = … / return out。⑤文档 docs/INTERNAL.md 9.117、DESIGN.md 123。",
  },
  {
    marker: '[macro-fusion 0.2.110]',
    file: 'lib/macro/defs/search.js',
    what: "0.2.110 预算贯通四路：0.2.109 只让本地检索听 budget，尾注老实写着星图 / 相似两路不缩——一句诚实的缺功能，四段回执却都要占上下文。① PATH_KNOBS 把四条路的旋钮与下限集中一处：本地 content_max→k（60/1）、星图 limit→hops（1/0）、补邻居 chars→limit（200/1）、相似 content_max→k（60/1），顺序一律「先动只是少看一点细节的，再动真会少看到东西的」。② 通用收缩 fitPath：入口先 `const cap = Number(budget.value)` 把预算对象摊成数字（拿对象去比恒 false，会一路滑到「装不下」还印出「预算 [object Object]」，四个探针同时红才挖出来）；每次按 1/2 砍、至少剁到下限，装下就报「收紧了 N 次 + 只列真动过的旋钮」。③ show() 只列 value !== from 的项，全都没动就写「没动到任何旋钮」——`hops 2→2` 这种一行字等于谎言。④ 报「最小」之前 for (const d of dials) d.value = d.min，把所有旋钮压到下限再量一次，用（limit=1、hops=0）实测把地板摊开。⑤ 本地 expand 的扩散段改成按剩余预算算：remain = budget - estTokens(本地那一段)，remain < BUDGET_MIN 就直接不拿，并说清「要扩散就 expand=false，或者把预算提上去」——预算不能拦下内容就只是个建议。⑥ costTail 去掉 mode 参数与「预算只在本地生效」那句尾注；「没派上用场」改成四路通用（零命中 / 空图 / 本来没展开）。⑦ schema 的 budget 描述改成四条路各砍什么，避免模型以为它只管本地；GUIDE_TEXT 1,156 → 1,176 字符（四路都听），上限 1,300、余量 124 ≥ 120。⑧ 探针：probe-fusion 的 stub 新增 nebula_recall / nebula_bridge / memory_find_similar（体量跟着各自旋钮走），D61 改口为「没给预算就不缩也不说废话」，新增 D62 星图收 limit、D63 补邻居先砍 chars、D64 相似先砍 content_max、D65 星图 rigid 报（limit=1、hops=0）实测、D66 本地展开按剩余预算；probe-fusion 538 → 543 条。⑨ verify 新增 12 条（旋钮表顺序 / cap 摊平且 fitPath 段内无 `<= budget` / 三处 fitPath 调用 / 只报真动过的旋钮 / 最小实测 / 剩余预算与拦下 / 出口不再声称只有本地 / schema 四路 / 手册四路且未触顶 / 探针进线 / 版本与文档），并改两处 0.2.109 老断言（wrapper 的 costTail 签名、出口那句「星图两路不吃预算」）。⑩ 文档：INTERNAL 9.116（250,325 → 253,623）、DESIGN 122（209,944 → 211,056）。⑪ 这一版没做：分段估算仍是量级不是账单；没动星图 hops=0 的语义；没给 read 路加 budget（体量由 id 决定，砍了就没内容可读）。",
  },
  {
    marker: '[macro-fusion 0.2.109]',
    file: 'lib/macro/defs/search.js',
    what: "只说「查到了什么」、从来不说「这一趟花了多少」，于是省 token 全靠调用方猜（0.2.109）：六维里准确性、相关性、可追溯性、可更新性、抗噪性都已有数有文案，唯独效率没有数——探针知道每条断言跑多少毫秒，可「这一次 `memory_search` 往上下文里塞了多少字」没人量过。一次本地检索默认 `k=10`、`content_max=300`，十条各带标题、层名、关键词、日期、项目与一段正文，回执轻易两三万字符，而上下文窗口是这一轮做事的弹药；看不见成本，就没有省的动作，调用方只能凭感觉少给 `k`——给多了怕漏、给少了怕不够，最后总是给多。现在①新增 `lib/macro/tokencost.js`，只做三件事：`estTokens` 估、`fmtTokens` 格式化、`budgetOf` 判预算；估算口径一句话能背——CJK 与全角标点一个字符算 1、其余四个字符算 1（向上取整）、空串 0，字符类覆盖 `\\u3000-\\u303f`／`\\u3040-\\u30ff`／`\\u3400-\\u4dbf`／`\\u4e00-\\u9fff`／`\\uac00-\\ud7af`／`\\uff00-\\uffef`；②不接真 tokenizer 是刻意的：真 tokenizer 要绑模型版本、要在插件里背几十兆词表，换来的是一份精确到个位的账单，而这里要回答的只是「这份回执是不是太大了」——粗糙的估算配上明说的口径（`是量级不是账单`）比精确的估算配上沉默更诚实，后者一旦被拿去对账、误差一露，整条成本信息就没人信了；③三个阈值 `COST_SHOW_MIN = 500`、`COST_HINT_MIN = 1200`、`BUDGET_MIN = 80`（上限 20000）全部集中在一处，散落到 `search.js`／`read.js`／`prompt.js` 各写一遍，改一个忘两个是迟早的事——500 以下不念成本（一条 `memory_read` 常两三百 token，每句缀一行等于拿噪声盖正文）、500～1200 只报不劝（劝得太早像在推销参数）、1200 以上才缀「只想看骨架就加 budget=400」；④`budgetOf(raw, {max})` 四态：没给静默、非数字说「预算要是数字：给了 abc，这次按没给预算处理」、小于 80 说「最小给 80」、超过 20000 说「最多按 20000 算」——四态里只有第一态可以不出声，**给了参数而参数没生效却什么都不说，是最坏的一种**，调用方以为省了 token、实际拿回三万字符，下次还会这么给；⑤`budget` 在 `execute` 出口只解析一次（`const budget = budgetOf(args.budget)`），一路传进 `runSearch`／`fitBudget`／`costTail`，解析两次就会得到两个不一致的 `note`；⑥`fitBudget(flow, exec, baseArgs, main, budget)` 不做字符串截断，而是**改参数重查**：装得下也要说一句「按 N token 预算给：实际 ≈N token，没缩」（不说，调用方就不知道预算是生效了还是被忽略了），装不下最多四级、每级真调一次 `flow.call('memory_search', args2, exec)` 并重新量，`if (cm > 60) cm = Math.max(60, Math.floor(cm / 2)); else if (k > 1) k = Math.max(1, Math.floor(k / 2)); else break`——**先砍每条的字、再砍条数**；理由不是性能偏好而是召回优先：十条各 30 字读者知道有这十条，三条各 300 字只看到三条、另七条等于没召回，而漏掉的那条你不知道它存在、也就不会去补；`content_max = 0`（全文）进预算从 2400 起砍、标签仍写「全文」（`全文→1200→600→300` 比 `0→1200` 明白）；⑦装下时交代「收紧了 N 次：k A→B、content_max A→B，实际 ≈N token」，不截断的理由是截断会把一条记忆拦腰砍断、读者看到一句没有下半句的话，而工具还在尾注说收紧了，那是骗人；⑧四级之后仍装不下，**必须真取一次最小一份**（`const { r: smallest, est: smallestEst } = await take({ ...baseArgs, k: 1, content_max: 60 })`）再回答「最小能给多少」——第一版拿第四级的估计值当最小值，报「最小」却从没试过最小，这类错特别隐蔽：数字合理、文案通顺，只是它是猜的；发现它的唯一方式是问「这个数是谁量出来的」，答不出「某一次真实调用的返回值」就不许印出去，所以尾注写「最小一份（k=1、content_max=60）**实测** ≈N token」；⑨收紧必须插在本地检索之后、`const wantExpand =` 之前：顺序反了，星图段会加在已经缩到预算的那份后面，回执仍超预算而尾注说「按 400 token 收紧了」——数字与文案对不上，整条尾注作废，而且这种作废是静默的，读者不会去数字符；星图退回本地兜底的两条路（`graphFellBack`）也过同一道预算（新增 `maybeFit(flow, exec, baseArgs, got, budget, flags)`，`await maybeFit(` 出现 2 次），漏一条路等于「同一个参数在一半情况下不生效」而调用方看不出差别；⑩`costTail(body, {mode, budget, flags})` 按固定顺序拼预算四态说明 → `flags.budgetNote` 交代表 → 非本地 mode 的「budget 只有本地检索能收紧：星图 / 相似两路的体量由引擎自己的 limit / chars 说了算，这次没缩」→ 本地且没有 `budgetNote` 的「budget N 这次没派上用场：你给的条件下一开始就没有可缩的东西」→ 成本行（`budget.value !== null || est >= COST_SHOW_MIN`）→ 骨架提示（`budget.value === null && est >= COST_HINT_MIN`）——第③④句是能力边界与事实交代两种意思，合成一句会让读者以为预算坏了；⑪`read.js` 只接成本不接预算（`return readCostTail([said, section, gap, nb.note].filter(Boolean).join('\\n\\n'))`，1200 以上缀「只要骨架就少给几条邻居（neighbors=0 或 3）」）：单条记忆的体量由这条记忆本身决定，能砍的只有邻居条数，所以给旋钮而不是自动预算，且 `execute` 里 `modeNotes` 的注与 `costTail` 各拼一次（把 `costTail` 挪进 `runSearch` 会在「零回执」那条提前返回里丢掉成本行）；⑫手册 `GUIDE_TEXT` 加一句「回执够大时自带成本尾注；想省上下文就给 budget=N，工具自己砍字、砍条数并交代砍了什么」，1091 → 1156 字符，`GUIDE_MAX_CHARS = 1300` 余量 144 仍高于 `GUIDE_MIN_HEADROOM = 120`、`clampGuide() === GUIDE_TEXT` 成立——新参数不进手册等于没这个参数，但手册也不能无限长（截断位置不可控），每加一句都要报余量。基准在 `tools/probe-ruler.mjs` 的 L27–L28（估算口径四条可复算：`estTokens('中文四个字') === 5`、`'hello world' === 3`、`'' === 0`、`'中文abc' === 3`；预算四态：没给／`abc`／`20`／`30000`／`400`）与 `tools/probe-fusion.mjs` 的 D58–D61（stub 桥 + 真 `createUnifiedTools` 装配：大回执报成本且 1200 以上劝骨架、给预算真的重取多次、`rigid` 模式下「装不下」带「实测」且不含「收紧了」、小回执不报成本而 graph 模式不收预算而是说清——后两条是阴性对照）。顺手修掉四处因签名与薄壳改形而红的老断言，且都保持「还能被打红」：`tools/criteria.mjs` 的 `search-mode-whitelist` 放宽成 `runSearch(flow, args, exec, flags(?:, budget)?)`、`verify.mjs` A55 的 badMode 正则放宽成 `{0,400}`／`{0,600}` 并要求五参调用、wrapper 断言改成「`modeNotes` 拼 body、`costTail` 拼尾注」三段、legacy 断言改成带 `budget = { value: null, note: '' }` 默认值的新签名。",
  },
  {
    marker: '[macro-fusion 0.2.108]',
    file: 'lib/macro/dreamledger.js',
    what: '总分只答「库重了多少」，答不了「哪一层在膨胀」（0.2.108）：0.2.106 让账本记了开工/收尾两个观测点，于是能算净变化；可净值是一个总数，而总数会被抵消——一轮把 2 条 topic 降成 fact、lesson 掉一条、fact 涨两条，总分 +0，账本念「比开工多 0 条」，读的人松一口气，其实库的结构在这轮里动了四处、其中三处同一个方向。总分是记分牌，不是体检报告。现在①读侧新增 `levelSeriesOf(plan)`：只认 `plan.storeEnd.byLevel`，`storeEnd` 缺失或 `byLevel` 不是对象就返回 `null`——0.2.103～0.2.105 的账只有开工层数（`store.byLevel`），把开工数当收尾数排进走向等于把「整理前的库」贴到「整理后的库」的位置上，图很整齐，全是假的，宁可少几次样本；②`levelSeriesOf` 还会过一遍 `storeOf({ store: raw })`（同一套读法：正数才认、零层不留），于是「这一轮真写了 byLevel 却没有那一层」只有一个解释：那一轮那层 0 条在用——写侧 `dreamStoreScale` 只把正数层写进 `byLevel`，这条前提必须写进口径句，否则「缺」会被读成「没记」，那是两个相反的事实；③新增 `levelTrendLine(rows)`：先按 0.2.107 的规矩只吃跑完的轮（`isFullRound`），半轮但带 `storeEnd` 的记 `half`、跑完却没有 `storeEnd` 的记 `noEnd`，两笔分开计、两条 caveat 分开说（合成一句「N 次没算」会让「最近 3 次收尾」与账本行数对不上，读者以为漏账）；④窗口必须是两轮以上（`kept.length < 2` 返回空串）——一次是快照，不是走向，单轮硬算等于编；⑤顺序坑：`rows` 是最新在前，进走向前必须 `kept.reverse()`，忘了这一步箭头会倒着指、`+2` 会写成 `-2`，而且不报错、看起来完全正常；⑥按层收集序列后 `delta = last - seq[0]`，排序用 `Math.abs(b.delta) - Math.abs(a.delta) || b.last - a.last`（先看谁动得厉害，一样厉害看最后一轮谁多），每格念成 `名字 a → b → c（+N / -N / 没变）`；⑦只列 4 层，多的说「还有 N 层没列」——六层全摊开是一堵墙，读者反而不看；⑧结论三支缺一支就会编：有涨念 `涨得最多的是 X（+N）`，没涨只有掉念 `掉得最多的是 X（-N）`，一个都没动念 `每一层的条数都没变`——「涨得最多的是 fact（+0）」是把噪声讲成走势，读的人一旦发现这种句子，整条走向的可信度就没了；⑨常驻口径句 `只数 status=\'active\'；这一轮写了 byLevel 而里面没有那一层，就是那一轮那层 0 条在用`（前句交代尺子——归档/stale 不算库有多大，后句交代缺层含义）；⑩面板只在第 1 页出这条（它说的就是最近这几条账，翻到旧页数字对不上号），并往 scope 里补一句数据来路 `层走向按每一轮收尾时的 storeEnd.byLevel 数，只有 0.2.106 之后的账有这一格`。分工照旧：写侧只落事实（数什么、零层写不写），读侧只管念与拒绝念（少于两轮不念、半轮不念、缺收尾数不念、没变就说没变），读侧不许反推写侧没记的东西。基准在 `tools/probe-ruler.mjs` 的 L25–L26（真引擎写 3 条记忆 → `dreamStoreScale` 得 `active 3 / fact 2 / lesson 1`，`topic`/`soul` 不出现；把一条 fact 归档后 `active 3 → 2`、`fact 2 → 1`，按状态数不是按行数；坑：两条 fact 的内容与关键词必须刻意错开，写侧有去重、长得像的两条会被合成一条，探针就验不出「同一层里两条是两条」）与 `tools/probe-fusion.mjs` 的 D54–D57（五条合成账 done×3 → aborted → 只有 store 无 storeEnd：走向与结论、两条排除说明与口径、单轮不出、每层没变就说没变且不硬凑涨跌）。',
  },
  {
    marker: '[macro-fusion 0.2.107]',
    file: 'vendor/meow-memory/lib/index.js',
    what: "只记「这行摘要怎么写」、记不住「这件事怎么结束的」（0.2.107）：`window dream (done|aborted): …` 里那一个词既是数据也是文案，于是读账的人都在解析中文，四个洞——①收尾方式只有摘要首词，`changes` 里没有这一格，摘要改一个字就等于改协议；②`groups` 只有分子没有分母，「走了 1 组」说不出是本来组还是一组只走了第一步，而中途放弃最有价值的信息恰恰是分母；③`recoverInterruptedDream` 只写 `{ stamped }` 没有 `plan`，面板走「没有规模数字」那支，把 0.2.96 之后才有的补记账念成「这条记录比 0.2.96 早，当时还没写规模数字」——一句时间上的假话；④`handleMemoryTurnFailure` 连续失败到 `DREAM_MAX_ATTEMPTS = 3` 止损封存时只写 `dream-debug.log`、不落账本，整理失败最惨的那次在面板上等于没发生过。现在①写侧把收尾方式落成结构化 `changes.kind` 五态：`done`／`aborted`（带 `groupsDone` + `groupsTotal`，摘要印 `groups=1/2`）／`recovered`（带 `groupsDone`）／`gaveup`（带 `fails`）／`sealed`（带 `fails`，且首次落账本），摘要同时把数字印出来——结构化给人算、摘要给人看，两份都要有；②`groupsDone` 取 `Math.max(0, groupsCount - 1)`，因为 `abortDream` 传的是「进行到第几组」（1-based），差一个 1 就把「没跑完」说成「跑完了」；③分母必须在 `finishDream` 之前读——`finishDream` 会 `delDreamMeta('dreamplan:…')`，收尾动作本身就把账要吃的数据删了，读不到就 `groupsTotal = 0`、摘要退回 `groups=N`（不印 `/0`、不猜数）；④`recoverInterruptedDream` 的 `fails` 提到函数级（原来 `const fails` 在 `if` 块里，落账那行读不到），零进展走 `gaveup`、有进展走 `recovered`，摘要里 `fails=N` 只在实际有失败次数时才印；⑤`handleMemoryTurnFailure` 封存分支在 `finishDream` 之后补 `db.logDream(...)`，调试日志照写、账本另写一条（一个给排查，一个给回看，不合并）；⑥读侧 `kindOf(row)` 优先认 `changes.kind`（`stored: true`），认不出才退回 `reasonOf(summary)`（`stored: false`，三个数一律 `null`）；`numOf` 只认 `Number.isFinite && >= 0`，缺值不许当 0——「走了 0 组」是假话，「这一条没记走到第几组」是真话；⑦`reasonOf` 正则放宽成 `/^window dream ([a-z]+)[^:]*:/`，跳过 `(interrupted)`／`(turn-failed)` 修饰语，否则会被认成「原因未记」；⑧`rowLine` 无 plan 时先试 `kindTail`（`走了 1/2 组就停下`／`补记时已走完 N 组`／`连续 N 次没进展，被封存`／`连续失败 N 次，被封存`），只有真老账才照旧念「比 0.2.96 早」；⑨新增 `kindBlock` 进展开第一行（`收尾方式：连续失败已封存（连续失败 3 次）`），`stored === false` 时补「这一条没有 changes.kind，是从摘要首词认出来的」，没跑完的轮在规模段与对子段两处都要改口（「这一轮不是跑完的整理（中途放弃），没有规模数字可念／没有对子明细可念」），不许再冒充老账；⑩趋势与「比更早一条」只吃跑完的一轮（`isFullRound`：有 kind 只认 `done`，老账只要不是 `aborted` 就算跑完），趋势另加 caveat「K 次没跑完（中途放弃 / 待补记 / 已封存），不进合计」，比对遇到半轮只回「这一条不是完整的一轮（没跑完 / 已封存），数字不可比」——半轮的 `dup/cover/missing` 只是扫到那儿的中间值，加进合计等于把半张成绩单当满分算，减出来的「变少了」是假象。基准在 `tools/probe-ruler.mjs` 的 L21–L24（真引擎四种收尾：中途放弃落 kind+分母、被打断后补记、连续失败达上限 sealed 进账本、连续没进展 gaveup；sealed 与 gaveup 两条都先 `db.touchWindow` 钉住 `last_event_time`，否则 `recordDreamFailure` 每轮凭 `Date.now()` 开新范围、失败次数永远从 1 重数）与 `tools/probe-fusion.mjs` 的 D49–D53 + D11b（面板真念四种收尾、半轮不比数字、趋势只合计整轮、补记账不冒充老账、封存账进面板；D11 另插一条 SQL 直写的真老账，让「比 0.2.96 早」这句只归老账）。",
  },
  {
    marker: '[macro-fusion 0.2.106]',
    file: 'vendor/meow-memory/lib/index.js',
    what: '只念开工那一眼，永远算不出「这一轮让库变轻还是变重」（0.2.106）：0.2.103 只数开工，还在注释里写了「收尾不再数」，怕人把「库变了」读成「这一轮改的」——顾虑成立，代价是整理唯一的成绩单（是否在收敛）无从计算，趋势行那句「库 开工时 2 → 3 条」比的还是不同轮的开工数。现在①finalizeDream 收尾时再数一次 dreamStoreScale(db) 落进 changes.plan.storeEnd，并算出 storeDelta = storeEnd.active - 开工数（只在两个点都有数时才算：Number.isFinite(before) && before >= 0，老账没这一格就不猜，不拿 NaN 或负数当 0）；②收尾数只能在写侧取——面板渲染时库早变了，重算出来的是「看账那一刻」，不是「整理结束那一刻」；③落库日志补 store=A->B，探针与 doctor 在 summary 上就能对账，不必先解 JSON；④面板 storeEndOf 与 storeOf 同一套读法（正数才认、零层不留），storeDeltaOf 缺一个点返回 null，storeBlock 四态：没 plan 闭嘴 / 没 store 说「写在 0.2.103 之前」/ 只有开工数就只念一眼（不编收尾、不补 0）/ 两个点都有就连起来念「开工时 A → 收尾 B，比开工多/少 K 条」；⑤文案层修两处括号套括号：差进句尾（「（fact 1）（-2）」→「（fact 1），比开工少 2 条」），趋势 caveat 改破折号（「库规模只有 K 次有数——更早的账…」），并新增 levelsText 统一层数格式化；⑥差与因必须分开写：storeDeltaNote 紧跟库规模说清 ±N 是「库变了多少」不是「这一轮改了几条」，归因看 changes.stamped；⑦趋势行补「收尾净增/净减 N 条（K 次有收尾数）」，缺收尾数的账不参与合计但要说几次（「K 次只有开工数、没有收尾数——0.2.106 之前的账没有这一格」）。基准在 tools/probe-ruler.mjs 的 L18–L20（真开工→中途加两条归档一条→两次 advanceDream 真收尾：store=2->3、delta=1 是净变化不是新写条数、归档层不进收尾层数、老账 storeEnd/storeDelta 都是 undefined）与 tools/probe-fusion.mjs 的 D46–D48（面板真念两个点且不叠两层括号、口径句点明「不是这一轮改了几条」、只有开工数的账只念一眼、趋势同时说「次有收尾数」与「次只有开工数」两条）。',
  },
  {
    marker: '[macro-fusion 0.2.105]',
    file: 'vendor/meow-memory/lib/index.js',
    what: '账本会答「翻了几条」，答不了「这几天整理得怎么样」（0.2.105）：run_at 是毫秒、人说的是日期，中间没有桥；问「上周那几天跑没跑」只能一页页翻日期自己数，翻到第 4 页看见空白也不敢确定是「没有」还是「没翻到」。现在①recentDreamsPage(limit, offset, project, since, until) 与 dreamCountOf(project, since, until) 改成 parts/args 拼 WHERE（项目段那段原样保留，只多 run_at >= ? / run_at <= ?），行与总数共用同一份筛子——筛留在 SQL 里，不搬回 JS，否则「第几页」与「一共几条」各算一套、翻页漏条；②新增 dreamsSpan()（SELECT MIN(run_at), MAX(run_at)）与模块级 readDreamSpan(workspace, dir)，给「账本覆盖 A → B」用，missing 四态与读口一致；③readDreamLedger 多收 since/until，total 也跟着筛（否则「共 N 条」是全账本的数）；④面板 dayStartOf 按本机时区 new Date(y, mo-1, d, 0,0,0,0) 并回读年月日校验（2026-02-31 会被 JS 滚成 3 月 3 日，静默换成另一天），绝不 Date.parse（UTC 语义，东八区整体错 8 小时），dayEndOf = 当天 23:59:59.999 形成闭区间；⑤rangeOf 四态：都空不进日期分支、坏日期「这种写法不敢猜」、反序「比 until 还晚」、正常给 label（缺一端写「账本最早」/「现在」），打回发生在第一次读库之前（坏日期不该先查库再拒绝）；⑥筛空要说「这段时间里没有整理记录——账本覆盖 A → B（本机时区 UTC+08:00）」，并报「全账本 N 条都在这个区间外面」——「这段里没有」与「账本里没有」必须分开说，合并成人会以为整理从没跑过；⑦展开一条时 rangeNoteOf 说清它不在区间里（写在几点），但编号与引用口径不变，引用路补「日期筛选也不影响引用」；⑧admin 只 String(args.since/until).trim() 原样传给面板（解析只写一份，免得 admin 认一种、面板认另一种），param-audit 放行两个新参数，schema 写明按本机时区算整天、写坏了会打回。基准在 tools/probe-ruler.mjs 的 L15–L17（直接插 run_at 量边界：00:00:00.000 与 23:59:59.999 在内、前后 1 毫秒在外、行数=总数、叠项目段、覆盖范围等于最早/最新）与 tools/probe-fusion.mjs 的 D43–D45（面板真念：since=今天不混旧账、同日 since=until 得 1 条且行上时间对、坏日期与反序都打回、空区间带覆盖范围）。',
  },
  {
    marker: '[macro-fusion 0.2.104]',
    file: 'vendor/meow-memory/lib/index.js',
    what: '「第几近」会随新账往下挪，回指不了某一轮（0.2.104）：账本有了翻页、按项目筛账、第几近展开，仍然说不出「上一轮那个计划再给我看一眼」——#3 今天指这一轮，跑完下一轮就换人，跨会话、隔天都指不回去；0.2.100 当初明写「不暴露 rowid——对外的句柄只有一种口径」，防的是把存储实现焊进调用约定，但没看见「只有位置、没有身份，就只剩看最近几条」。现在①MemoryDb.dreamById(id) 按 id 取一条账（changes 解析失败记 null 但行照出，不许让坏原文把「这一轮整理过」抹掉；id 非正直接 null，不去 LIMIT 1 凑一条），dreamRankOf(id) 用 WHERE run_at > ? OR (run_at = ? AND id > ?) 算第几近——必须与 recentDreamsPage 的 ORDER BY run_at DESC, rowid DESC 同一把尺子，否则「引用」与「编号」静默指向不同的行；②模块级 readDreamRecordByRef(workspace, dir, ref) 在四态之外多一个 no-row，成功带 {row, prev, rank, total}，prev 复用 recentDreamsPage(2, rank-1) 不另写 SQL；③面板 refOfRow(row)/refIdOf(raw) 把 dream_log.id 写成 r<N>，rowLine 两个分支（含 0.2.96 之前的老账）末尾都拼「· 引用 r<N>」，列表第 1 页只说一次「回指就用 r<N>；#k 会挪」（每页都印等于拿 token 换噪音）；④readDreamPanel 先认 r<N> 再认第几近（r4 里的 4 绝不当成第 4 近——那会静默指到另一条账上），引用失效时明说「这个号不会发给新账，那一行可能已经不在了（库被重建 / 手工删过）」并给按位置/按内容两条替代路，展开成功时把「它现在排第 K 近」与引用并排印且交代引用不受项目筛选影响，第几近那条路也顺手回一句「引用 rX，要回指就用 id=rX」；⑤admin 的 idOf 认两种写法，r0 抛「id 引用要从 r1 起」、乱写抛「只认两种写法」，schema 写清两支分工。这是有意反转 0.2.100 的口径，四条边界（只多一个字段、写成 r<N> 不写裸数字、两套口径并存、失效是单独一态）记在 DESIGN 116。基准在 tools/probe-ruler.mjs 的 L12–L14（真 writer 记下 r<N> 再跑一轮：第几近 1→2 而 dreamById 的 runAt 不变；不存在的引用 no-row；ref=0 不猜行）与 tools/probe-fusion.mjs 的 D40–D42（列表带引用、又跑一轮后按引用展开仍指同一条、引用+项目段的归属句与 no-row 文案）。',
  },
  {
    marker: '[macro-fusion 0.2.102]',
    file: 'vendor/meow-memory/lib/index.js',
    what: '项目段存成了个数，按名字筛账就永远筛不到：0.2.101 的筛选读的是 changes.plan.projects 里的名字，而写侧 dreamPlanDigest 一直是 rounds.reduce(...) 算出的「个数」——json_each 对数字不报错，只产出一行 value=3 / type=integer，于是真账本上按项目名筛回「没有这个项目段的账」（假阴性），分布行里还会冒出一个叫「3」的项目；0.2.101 的探针手写 changes 时恰好写成数组，所以整条链路全绿没露出来。现在①写侧 projects 改为 dreamPlanProjectNames(rounds) 的名字数组（trim、去空名、去重保序，按原样配），个数另存 projectCount（老格式照实数念，不念成 0 个项目段）；②dreamDupPairs / dreamCoverPairs 加 max 参数（默认 DREAM_DUP_MAX 不变，老调用一行不改），摘要里显式传 Infinity——「这一轮撞上几对」是真数，「印出来几对」是版面，两件事不共用一个上限；③新增 var DREAM_PLAN_PAIR_CAP = 6 与 dreamPlanPairs(allRows)，把「跟谁撞了」落进 changes.plan.pairs（短 id 走 uniqueShortIdsAmong，与整理清单同一套，能直接拿去 memory_read / memory_update；cover 带 missing 与 words，合并会丢哪些词是决策依据）；④SQL 三处加文本闸（dreamProjects 两个查询 AND je.type = \'text\'、dreamCountOf 与 recentDreamsPage 的 WHERE json_each.type = \'text\' AND json_each.value = ?）——老账本里的数字不许冒充项目名、也不许进分布；⑤面板 projectCountOf(plan) 统一认三种形态（数组取长度、数字照念、退 plan.projectCount），rowLine 与 liveLine 共用，不再有「数组才叫有项目」；展开按「项目段 → 对子 → 比更早一条 → 原文」排，对子块四态各说各话（没 plan / 没存明细 / 真没撞上 / 有数无明细），超上限写「还有 N 对没落账」。基准在 tools/probe-ruler.mjs 的 L1–L8（从真 writer 出发验写侧）与 tools/probe-fusion.mjs 的 D32–D36（含「老格式只念个数不念成 0」「没存明细 ≠ 没撞上」「明细超上限报差额」「老账本的 2 不是项目名」四条阴性对照）',
  },
  {
    marker: '[macro-fusion 0.2.101]',
    file: 'vendor/meow-memory/lib/index.js',
    what: '项目段写在账本里却只被数了个数：changes.plan.projects 从 0.2.96 起一直在写，但面板只用它报「N 个项目段」，问不出「有哪几个项目、各自几次」「某个项目的账翻出来看看」「这一条动了哪几个项目」。现在①MemoryDb.recentDreamsPage(limit, offset, project) 可按项目段筛，条件走 SQLite JSON1：json_valid(changes) AND EXISTS(SELECT 1 FROM json_each(json_extract(dream_log.changes, \'$.plan.projects\')) WHERE json_each.value = ?)——筛留在 SQL 里，不许取全量再在 JS 里 filter（否则页面与总数各算一套，翻页翻出空页），坏行先被 json_valid 挡掉（不许一行坏账把面板带成「读不出来」，也不许把它悄悄算成匹配）；②dreamCountOf(project) 给筛后的总数，空项目直接走 dreamCount()，与不筛时口径一致，readDreamLedger 里 total 与页面共用同一个筛子；③dreamProjects(limit) 给分布 {items:[{project,n}], total}：次数降序、同数次按名字，total 是 COUNT(DISTINCT je.value) 不是 items.length（只列前几个时「没列」不等于「没有」）；④新增模块级 readDreamProjects(workspace, dir, limit)，missing 三态 no-workspace / no-db / read-failed 与账本读口同样分开说；⑤面板第 1 页且没筛时多一行「项目段：Alpha 3 次 · Beta 1 次」，筛着时不再给分布（筛完再报分布会被当成「分布也筛过了」）；project= 时 scope 明写「M 条（全账本 N 条）」与「#k 是筛出来这几条里的第几近，不是全账本序号」，导航写「共 M 条（项目段「X」）· 每页 L 条」，越界重读也带同一个筛子；筛空时说「账本里没有项目段「X」的整理记录（全账本 N 条）」而不是「账本还是空的」（两句话分开说，并点明项目名要按原样写）；展开时补一句「属于/不属于这个项目段」但编号仍是全账本第几近（筛选不改编号）；⑥project 给成长句（80 字以上或带换行）当面打回，不静默当「没匹配到」。基准在 tools/probe-ruler.mjs 的 K1–K7 与 tools/probe-fusion.mjs 的 D26–D31（含「分布只在没筛时给」「筛空不等于账本空」「页 2 编号接上筛后顺序」「脏 project 打回」「分页也在 SQL 里筛」五条阴性对照）',
  },
  {
    marker: '[macro-fusion 0.2.100]',
    file: 'vendor/meow-memory/lib/index.js',
    what: '账本一长就只看得见最近五条：0.2.97–0.2.99 三版回答了「最近几次整理长什么样」，但面板永远只念 5 条、每行只有一句规模，问不出「那一次到底写了什么」、也看不出还有多少条更早。现在①MemoryDb.recentDreamsPage(limit, offset) 带 OFFSET，排序 ORDER BY run_at DESC, rowid DESC（同一毫秒的两条也有稳定次序，翻页不漏不重），行里带内部 id；dreamCount() 单独给总数——最后一页天然短，不拿页面长度当账本长度；②模块级 readDreamRecord(workspace, dir, rank) 在原来四态之外多一个 no-row（账本在、就是没有第 k 条），并顺手带出「更早一条」供比较；③readDreamLedger 多收 offset、返回 total；④对外的句柄只有一种口径「第几近」（1 = 最新，跨页连续），rowid 只当内部句柄不进正文；⑤面板 readDreamPanel 支持 page 与 id：翻页编号跨页连续、页越界退到最后一页并说清、趋势行与「整理进行中」只在第 1 页出；展开把 summary / note / changes JSON 原文摊开（超 1200 字符截断并报真实长度），老记录明说没有 changes.plan，坏行只说读不出来不拿摘要凑规模，并给「比更早一条」的差（只报真变了的段）；⑥page / id 给脏了当面打回（page=0 不悄悄当第一页、id=abc 不退回整本账），错误里写清「这次什么都没按你说的做」。基准在 tools/probe-ruler.mjs 的 J1–J6 与 tools/probe-fusion.mjs 的 D20–D25（含「总数不是本页条数」「第二页编号接上」「页越界不返回空白页」「展开第 99 条说没有」「脏参数打回」五条阴性对照）',
  },
  {
    marker: '[macro-fusion 0.2.103]',
    file: 'vendor/meow-memory/lib/index.js',
    what: '账本只知道翻了几条、不知道库有多大（0.2.103）：展开一条账只能看到「2 轮 / 5 条 · 逐字重复 2 对 …」，问「这一轮是在多大的库上整理的」答不出，而「翻 5 条」在 500 条的库和 8 条的库里是两个意思——分母缺了，数字就没有意义。现在 dreamStoreScale(db) 在开工那一刻数一次库（只数 status=\'active\'，按 LEVELS 七张表拆，零层不写进 JSON 免得被读成「空层也算数」），startWindowDream 在算完 digest 之后、落 dream_meta 之前挂 digest.store，live 广播与落库共用同一份（不在收尾再数：那时模型已经改过库，两个数字对不上号会被读者编出假因果）；面板 storeOf(plan) 三态分明（没有这一格 / active===0 空库 / 正常条数），storeBlock(row) 只在这条账真有 plan 时才说话（0.2.96 那句已经解释过老账，不叠两层告示），展开顺序 项目段 → 对子 → 库规模 → 比更早一条 → 原文；趋势行按最早→最新补「库 开工时 2 → 3 条（多了 1 条）」，至少两次有数才敢讲区间，缺口进同一份 caveats（「库规模只有 N 次有数」），样本不足照旧说「只当参考」。基准在 tools/probe-ruler.mjs 的 L9–L11（只数 active、空库 byLevel 是空对象、真开工后 dream_meta 里的 store 与 trace 同一份）与 tools/probe-fusion.mjs 的 D37–D39（展开念真数、老账不念 0、趋势给区间与缺口）。',
  },
  {
    marker: '[macro-fusion 0.2.99]',
    file: 'vendor/meow-memory/lib/index.js',
    what: '整理正在进行时面板只剩空账本：0.2.96–0.2.98 三版都在回答「已经发生过的整理」，dream 正在跑时 SSE 只有 state、面板只能念历史，而 dreamdigest:<sid> 早在 claim 成功那一步就写进了 dream_meta。现在①DreamStateBroadcast.broadcast(sessionId, state, detail) 与 host 侧 signalDreamState 都把 detail 并进事件（加法，老消费方只认 state 照样工作），startWindowDream 在算完 digest 后用 onDreamState?.(sessionId, "dreaming", { plan: digest }) 广播同一份摘要，不另立口径；②collectDreamStates 返回 {dreamed, dreaming, plans}，plans 只对活 lease 解析 dreamdigest，解析失败静默跳过、两个老字段原样；③新增模块级 readLiveDream(workspace, dir)：只认 Date.now() - lease.progress_at <= DREAM_LEASE_MS（看 progress_at 不看 T，心跳会推它），三态 no-workspace / no-db / read-failed 与 readDreamLedger 分开说，规模只从 dreamdigest 读、没有就报「规模还没落 meta」绝不现算；④融合层面板把它排成第一行、不编 #k 序号、不进趋势，空账本时先说进行中再说「账本还是空的」，多会话只念第一条并报「还有 N 个在排队」。基准在 tools/probe-ruler.mjs 的 I0–I5 与 tools/probe-fusion.mjs 的 D18–D19（含「lease 放掉立刻不再报」「只有 lease 没有 digest 不编规模」「没有工作区与没建库分开」三条阴性对照）',
  },
  {
    marker: '[macro-fusion 0.2.97]',
    file: 'vendor/meow-memory/lib/index.js',
    what: 'dream 的账本只有写口：0.2.96 起每轮整理都把规模和合并候选写进 dream_log（summary 一行 + changes.plan），但库里没有任何读口——memory_admin 面板上没有一行念它，主人想知道上一轮看到几条、点出几对，只能去翻 sqlite；一个只有写口的账本等于把「可追溯」做成了「看我写过」。现在①新增 MemoryDb.recentDreams(limit=5)：LIMIT 1..50、最新在前、返回 {runAt, summary, changes, note}，changes 解析失败记 null 但该行照列（一行坏账不吞整本账）；②新增模块级 readDreamLedger(workspace, dir, limit)：先分 no-workspace / no-db / read-failed 三种没念出账的来路（「还没建库」与「库在但读不开」不许合成一句），再把库交给 recentDreams；③融合层面板加 memory_admin(action="dream")：逐行念 时间 · 收尾原因 · N 轮/M 条 · 逐字重复/重复详写/缺词/项目段，数字只念 changes.plan，老记录明说「比 0.2.96 早」；④面板不写死 .dsh-meow：lib/index.js 的 meowDirReader() 从引擎配置现读 projectDir，随重挂更新。基准在 tools/probe-ruler.mjs 的 H 段与 tools/probe-fusion.mjs 的 D9–D14（含「空账本、坏账、没有会话工作区都不许凭空报数」三条阴性对照）',
  },
  {
    marker: '[macro-fusion 0.2.96]',
    file: 'vendor/meow-memory/lib/index.js',
    what: 'dream 整理完不留痕：claimDream 只防重复整理、logDream 只记「done + 轮数+封存数」，主人在面板与回执里都看不到这一轮翻了多少条、撞上几对、有几对合并会丢字——模型自己也无从预判规模。现在①新增 dreamPlanDigest：用后面真正印块的那两个判据函数（dreamDupPairs / dreamCoverPairs，不另立口径）把清单算成 {rounds, groups, rows, dup, cover, missing, projects}；②起 dream 时存进 dream_meta 的 dreamdigest:<sid>，回执（memory_dream 与 /dream 同源）先用三语 labels 的 dream.plan 念一遍规模，真有字要补时再加一句 dream.plan.missing；③收尾（done/aborted/中断恢复都走 finalizeDream）把同一份摘要写进 dream_log.changes.plan 与 summary 的 plan rows=/dup=/cover=/missing=，念完删 meta，不留下一轮读的旧账；④顺带把「同一批行算三遍词集」收成 rowTokenSet 按 id+updated_at 记忆，三个消费者共用一张词表。基准在 tools/probe-ruler.mjs 的 G 段（含「数字与真印出来的块逐项相等」「干净清单不加 missing 那句」两条阴性对照）',
  },
  {
    file: 'vendor/dsh-memory-nebula/lib/host/recall.js',
    marker: '[macro-fusion 0.2.9]',
    what: '归档/删除的记忆不进检索结果（与 bridge.js statusFactor 同口径）',
  },
  {
    file: 'vendor/dsh-memory-nebula/lib/web/i18n.js',
    marker: '[macro-fusion 0.2.11]',
    what: '星图应用对外只叫「宏记忆 · 星图」（显示名，不动逻辑）',
  },
  {
    file: 'vendor/dsh-memory-nebula/lib/client.js',
    marker: "var LABEL = '宏记忆 · 星图'",
    what: '侧栏/iframe 标签与星图显示名一致',
  },
  {
    file: 'vendor/dsh-memory-nebula/lib/index.js',
    marker: '宏记忆 · 星图 · 宿主插件 [macro-fusion 0.2.11]',
    what: '注入横幅 / 工具描述 / stats 抬头都叫同一个名字',
  },
  {
    file: 'vendor/dsh-memory-nebula/lib/host/http.js',
    marker: '记忆星图的 HTTP 接口 + 静态页面。[macro-fusion 0.2.11]',
    what: '口令页标题叫「宏记忆 · 星图 · 需要口令」',
  },
  {
    file: 'vendor/dsh-memory-nebula/lib/host/share.js',
    marker: '[macro-fusion 0.2.11]',
    what: '离线快照标题与 index.html 的 <title> 同字（put 的 needle 一起改）',
  },
  {
    file: 'vendor/dsh-memory-nebula/lib/index.js',
    marker: '[macro-fusion 0.2.39]',
    what: '空命中也说清「图还是空的」还是「图里真没有」（带上图里的节点总数）',
  },
  {
    file: 'vendor/dsh-memory-nebula/lib/index.js',
    marker: '[macro-fusion 0.2.40]',
    what: '空图时体检说「等于没算」，不冒充「共 0 项」',
  },
  {
    file: 'vendor/dsh-memory-nebula/lib/index.js',
    marker: '[macro-fusion 0.2.41]',
    what: '空图时星图概况说清「这不是记忆丢了」，并给出原因',
  },
  {
    file: 'vendor/dsh-memory-nebula/lib/index.js',
    marker: '[macro-fusion 0.2.42]',
    what: '读单条记忆的空结果分「图还空着」与「图里没这条」（这句 graphState 也要读）',
  },
  {
    file: 'vendor/dsh-memory-nebula/lib/index.js',
    marker: '[macro-fusion 0.2.43]',
    what: '来源体检的「0 个来源」说清是没接上还是没读到（三种原因）',
  },
  {
    file: 'vendor/dsh-memory-nebula/lib/index.js',
    marker: '[macro-fusion 0.2.44]',
    what: '补邻居的空结果分四种原因，不再把「没找到种子」说成「都读过」',
  },
  {
    file: 'vendor/dsh-memory-nebula/lib/index.js',
    marker: '[macro-fusion 0.2.45]',
    what: '解释证据链只在真算过的时候才说「没有关系」，图空/没入图/引擎旧都单独说',
  },
  {
    file: 'vendor/meow-memory/lib/index.js',
    marker: '[macro-fusion 0.2.46]',
    what: '相似检索一条都没有的时候也说话：三种「没算成」分原因，只有词汇零重叠才说「没有相似」',
  },
  {
    file: 'vendor/meow-memory/lib/index.js',
    marker: '[macro-fusion 0.2.47]',
    what: '项目全景的空结果分三支：「名字对不上」不再冒充「这个项目没记忆」，别的层还有东西也要说',
  },
  {
    file: 'vendor/meow-memory/lib/index.js',
    marker: '[macro-fusion 0.2.48]',
    what: 'dream 没启动的四种原因分开说：消息没送出去不再冒充「没有需要整理的记忆」（工具面与 /dream 命令面同一套）',
  },
  {
    file: 'vendor/meow-memory/lib/index.js',
    marker: '[macro-fusion 0.2.49]',
    what: '改记忆的回执说清「改了什么 / 哪些字段没生效」：只给 id 或字段被过滤时不再回「✅ 已更新」',
  },
  {
    file: 'vendor/meow-memory/lib/index.js',
    marker: '[macro-fusion 0.2.50]',
    what: '写记忆的回执说清「层名被改过 / 哪些参数没生效 / 是合并不是新写」：层名拼错不再静默落进 fact',
  },
  {
    file: 'vendor/meow-memory/lib/index.js',
    marker: '[macro-fusion 0.2.51]',
    what: '检索的空结果说清「层名没对上 / 只在某几层里查过」：level 写错不再过滤成空数组冒充「记忆里没有」',
  },
  {
    file: 'vendor/meow-memory/lib/index.js',
    marker: '[macro-fusion 0.2.52]',
    what: '读记忆的短 id 撞车时不替你挑第一条：先数一遍（>1 就拒绝读并列出候选），查无此 id 时说清工作区与位数',
  },
  {
    marker: '[macro-fusion 0.2.53]',
    file: 'vendor/meow-memory/lib/index.js',
    what: '相似检索的基准短 id 撞车时一条都不比：不拿别人的正文当基准算相似度，没起点时说清工作区与位数',
  },
  {
    marker: '[macro-fusion 0.2.54]',
    file: 'lib/macro/linkflow.js',
    what: '连线归一不再只回「id 或 null」：短 id 撞车、这次没查成、真没有各说各的，前两种不摘补连队列',
  },
  {
    marker: '[macro-fusion 0.2.55]',
    file: 'lib/macro/store.js',
    what: '账本与队列的「空」分四种来路：没写过 / 写不进去 / 读不出来 / 全坏行，写成功即清零失败账',
  },
  {
    marker: '[macro-fusion 0.2.56]',
    file: 'vendor/meow-memory/lib/index.js',
    what: '检索参数给错了各说各的：状态值白名单、days 非正数、k / content_max 越界，都不许冒充「本次零命中」',
  },
  {
    marker: '[macro-fusion 0.2.57]',
    file: 'vendor/dsh-memory-nebula/lib/index.js',
    what: '数值参数统一走 numParam()：给 0 就照办 0，越界与非数字带一句话出来，不再被 Number(x) || 默认值 吃掉',
  },
  {
    marker: '[macro-fusion 0.2.58]',
    file: 'lib/macro/defs/search.js',
    what: '检索模式名归一后过白名单：写错就一句都不查（不再静默走本地检索），参数给错模式逐条说「这次没用上」',
  },
  {
    marker: '[macro-fusion 0.2.59]',
    file: 'lib/macro/defs/link.js',
    what: '连线先校验动作名与两端 id：缺参数不再被读成「暂时没落图，已排队」，也不排假欠账；maxHops / note 给错动作要说「这次没用上」',
  },
  {
    marker: '[macro-fusion 0.2.60]',
    file: 'lib/macro/panel.js',
    what: '卡片标题统一走 cardTitle()：动作键与模式键换成中文名、path 标成只读、空细节不留悬空冒号、多行压一行、超 40 字截断',
  },
  {
    marker: '[macro-fusion 0.2.61]',
    file: 'lib/macro/panel.js',
    what: '面板条数统一走 limitOf() 的 { value, note }：给 0 就照办 0（成本/待补两张面板要说清库里其实有多少行），负数与非数字回默认、非整数抹小数，都要带一句话出来',
  },
  {
    marker: '[macro-fusion 0.2.62]',
    file: 'lib/macro/shared.js',
    what: '条数参数统一走 countParam() 的 { value, note }：给 0 照办「不带」（读记忆的邻居），非数字与负数回默认、小数抹掉、超界夹住，三种都要说出口——不许悄悄变成「这条记忆没有邻居」',
  },
  {
    marker: '[macro-fusion 0.2.78]',
    file: 'lib/macro/linkflow.js',
    what: '写入时给的 links 先用 linkArgs 分两半：能连的条目 + 丢了几条（整份不是数组 / 空 id / 形状不对），再由 linkDropNote 说出来；不知道锚点是谁时另说一句「连排队都没法排」，不许 applyLinks 首行 `!anchorId` 直接吞掉整批',
  },
  {
    marker: '[macro-fusion 0.2.77]',
    file: 'lib/macro/shared.js',
    what: '读记忆的邻居段没拿到时收成 neighborGapNote(section, reachable, raw)：没查成 / 没查到这条记忆 / 回执里没这一段，三种状态三句话，都不许沉默成「这条记忆没有邻居」；defs/read.js 不许再用 `section ? … : said` 把失败说明拼掉',
  },
  {
    marker: '[macro-fusion 0.2.76]',
    file: 'lib/macro/cost.js',
    what: '成本面板的「最近 N 次」收成 costScope()：基句只报真算了的条数，再按需补「你要的是 X 次，账本里能算的只有 N 条」「更早的 K 条没进这次统计」「另有 B 行解析不出来」。readCost() 一次给 { body, scope }，costReport() 留成薄壳；defs/admin.js 不许再自己拼「最近 N 次调用」',
  },
  {
    marker: '[macro-fusion 0.2.75]',
    file: 'vendor/dsh-memory-nebula/lib/index.js',
    what: '枢纽榜的尾注收成 hubTail()：只说读者数得到的三个数（这段列了几条 / 有连接的记忆共几条 / hubs 上限几条），池子按 nodes − orphans 算；上限只剩 HUB_CAP 一个数（夹参数、尾注、schema 都读它）。不许再拿 nodes − top.length 当「还有 N 个枢纽没列」，也不许再补一句「没列的不代表是枢纽」打圆场',
  },
  {
    marker: '[macro-fusion 0.2.74]',
    file: 'vendor/dsh-memory-nebula/lib/index.js',
    what: '体检的条数账收成一个出口 listTail()：抬头只报全量计数，正文按 min(limit, 已取条数) 列，尾注 = 总数 − 已列并写明每类上限，三个数字必须能互相验算；不许再出现「这里只列前 N 条」那种把引擎内部截断写到抬头的老写法',
  },
  {
    marker: '[macro-fusion 0.2.73]',
    file: 'tools/doctor-verdict.mjs',
    what: '体检的判决只看 tag：屏幕写 FAIL 就必须计失败（tag 决定判决，第二参只补「声明通过却说没过」与 WARN）。判决器不许再搬回 doctor.mjs 自己记账，也不许改回 if (!ok)，否则 22 处 line(cond ? PASS : FAIL, true, …) 打红不红、体检照样 exit 0',
  },
  {
    marker: '[macro-fusion 0.2.70]',
    file: 'lib/macro/defs/admin.js',
    what: '卡片是回执的第二种排版：前缀只放面板中文名（品牌归抬头）、细节位按 PARAM_OWNERS 列这一轮真给了的参数（k=v，数组说条数），未知 action 带上用户写的原值；别再塞品牌回去',
  },
  {
    marker: '[macro-fusion 0.2.72]',
    file: 'lib/macro/defs/admin.js',
    what: '星图面板的「没结果」必须分两种说：装配没完成（等不到工具/被配置关掉）说「还没装配好」并指向配置，星图那边报错就把原因原样带出——别再合成一句「这次没接上，等就绪再试」，那会把 ENOENT 这类真实原因吃掉；判据只认 contract 的 NOT_READY_MARK，别抄字面量',
  },
  {
    marker: '[macro-fusion 0.2.71]',
    file: 'vendor/dsh-memory-nebula/lib/host/nebula.js',
    what: '枢纽条数的上限只许有一个出处（hubSlots，1..40）：概览按调用方要的条数取，默认 12 是给别人看的版面、不许被顺手改；stats 正文在列表被截断时要说「只列前 N 条 / 还有多少没列 / 上限 40」',
  },
  {
    marker: '[macro-fusion 0.2.69]',
    file: 'lib/macro/defs/search.js',
    what: 'id 只有 mode=similar 当基准、memory_ids 只有扩散时当起点：写在别的模式里被丢掉时必须说话——id 那句要带「这不是这条记忆被排除了」并给出正确用法，memory_ids 按真扩散 / 星图没接上 / 压根没扩散三种处境分开说',
  },
  {
    marker: '[macro-fusion 0.2.68]',
    file: 'lib/macro/defs/admin.js',
    what: '面板不读的参数不许悄悄消失：八个参数对每个 action 都合法，执行只取表里那一行列的——strayNote() 按 PARAM_OWNERS 反查点名「这参数归哪个 action」，并说清这次一点没参与（别读成「结果已经按它收窄过」）；手册那条 wrap:false 只免抬头，不免说话',
  },
  {
    marker: '[macro-fusion 0.2.67]',
    file: 'lib/macro/defs/search.js',
    what: '相似检索只认 id / k / content_max：query（读者以为在按句子找）、level / project / status / days / explain、hops、memory_ids 被丢掉时必须逐条说明「这次没用上」，并说清「这不是没有相似，是这几个条件压根没算」；content_max 是它认的，不许误报成没用上',
  },
  {
    marker: '[macro-fusion 0.2.66]',
    file: 'lib/macro/defs/search.js',
    what: 'graph / bridge 的本地条件（level / project / status / days / k / content_max / explain）按执行路径说话：走星图时说明「只在本地检索生效」，星图没接上退到本地检索时说明「它们真的用上了」，连兜底都没做时说「这一问压根没算」——不许拿走星图那一句去说退路',
  },
  {
    marker: '[macro-fusion 0.2.65]',
    file: 'lib/macro/defs/search.js',
    what: '检索尾注按「执行路径真的做了什么」说话：local 扩散用了 limit / hops 就说「真的用了它（limit=N）」，星图没接上就单独说「本来要扩散但没接上」，只有根本没扩散才说「这次没用上」——不许对所有非 graph/bridge 模式一律说没用上',
  },
  {
    marker: '[macro-fusion 0.2.64]',
    file: 'lib/macro/defs/admin.js',
    what: '体检的类别按白名单守（dup / stale / thin / oversize / unread / orphan）：大小写与前后空格归一，空串当没给，不认识就挡住并说清「这次体检没有跑」——不许照跑一遍全部、把「没查这一类」打成「这一类是 0」',
  },
  {
    marker: '[macro-fusion 0.2.64]',
    file: 'vendor/dsh-memory-nebula/lib/index.js',
    what: '体检的类别名取不到时原样打出来（labelOf），不再出现「undefined（0）」这种没有名字的 0',
  },
  {
    marker: '[macro-fusion 0.2.63]',
    file: 'lib/macro/prompt.js',
    what: '注入上限统一走 guideBudget() 的 { value, note }：写坏（"4k"、负数、null）回默认 1300 并进日志与手册末行，只有明确给 0 才照办 0——不许静默变成「零字注入」',
  },
  {
    file: 'vendor/dsh-memory-nebula/lib/host/nebula.js',
    marker: '宏记忆 · 星图导出',
    what: 'Markdown 导出抬头同名',
  },
  {
    marker: '[macro-fusion 0.2.79]',
    file: 'lib/index.js',
    what: '导出平铺到根的 volatile Config（设置页写入的唯一入口）：meow 的 14 个字段平铺 + 三个兼容段，写入走 loader/volatile-update，只重建工具面与注入，子插件不重挂',
  },
  {
    marker: '[macro-fusion 0.2.80]',
    file: 'vendor/meow-memory/lib/index.js',
    what: '注入消息的来源 kind 改成 plugin:macro-memory（宿主聊天卡直接显示这个字符串），老 kind plugin:meow-memory 仍然认得',
  },
  {
    marker: '[macro-fusion 0.2.80]',
    file: 'vendor/meow-memory/lib/client.js',
    what: '客户端同一份 kind 定义 + 设置页文案改成「宏记忆 / 已保存 ✓ 已生效」，不再谎称要重启插件',
  },
  {
    marker: '[macro-fusion 0.2.80]',
    file: 'vendor/dsh-memory-nebula/lib/host/transcripts.js',
    what: '工具调用画像把我家工具统一归到 plugin:macro-memory，不再分两个插件',
  },
  {
    marker: '[macro-fusion 0.2.81]',
    file: 'vendor/meow-memory/lib/index.js',
    what: '设置链路诊断默认不出声：DSH_MEMORY_SETTINGS_DIAG=1 才写 settings-diag.log，且有 256 KiB 上限（原先每调一次 describe 就追加几十行）',
  },
  {
    marker: '[macro-fusion 0.2.82]',
    file: 'tools/probe-toolsize.mjs',
    what: '修掉裸 root（ReferenceError，脚本 0.2.7x 起就跑不动）：改取 _root.mjs 的 vendorDir，并自己判「17 个原工具一个不少 + 字面量不膨胀」，进 check-all 第 12 支',
  },
  {
    marker: '[macro-fusion 0.2.83]',
    file: 'tools/probe-tools.mjs',
    what: '工具账本探测器：每个脚本必须有归属（STEPS / 被 import / 手动账本）、_root 导出不许白用、只读手动脚本真跑一遍；自带阴性对照，进 check-all 第 13 支',
  },
  {
    marker: '[macro-fusion 0.2.83]',
    file: 'tools/manual-tools.mjs',
    what: '手动脚本账本（6 条，每条带 smoke 与 why）：把「有意的」「忘了的」分开，账本不写逻辑',
  },
  {
    marker: '[macro-fusion 0.2.84]',
    file: 'tools/probe-words.mjs',
    what: '口径总账探针：手册 / schema / 常量 / README / 两份索引说的是不是同一件事（工具数、动作枚举、七个 level、体检六类、注入字符数、死指针），进 check-all 第 14 支，自带 6 条阴性对照',
  },
  {
    marker: '[macro-fusion 0.2.85]',
    file: 'vendor/meow-memory/lib/index.js',
    what: '召回校准（两处都在打分/排序里，坏起来一声不响）：① search() 的 importance 以前只豁免时间衰减、从不进分数，现在按 keywordHitScore 同口径 0.25 加成并写进 explain.importanceWeight；② 渲染前按 updated_at 升序把相关度整个丢掉，改成相关度降序、时间只做次级。基准在 tools/probe-recall.mjs（真引擎，含两条阴性对照）',
  },
  {
    marker: '[macro-fusion 0.2.86]',
    file: 'vendor/meow-memory/lib/index.js',
    what: '检索的相关度下限 min_rel（默认 0.35）：30 条语料的实测里有分数断崖（榜首 14 分时第 3 条起只剩 0.33，全是只沾一个词的），以前这些尾巴照样占 k 名额、照样被当成相关读。现在按榜首的比例收掉，收掉几条写进尾注并给 min_rel=0 的出路；排序第一位永远留着，下限再高也不许把结果收空。基准在 tools/probe-recall.mjs 的 R5 组',
  },
  {
    marker: '[macro-fusion 0.2.87]',
    file: 'vendor/meow-memory/lib/index.js',
    what: '合并账本：同一条内容再写一次会「合并」，而合并以前是拿这次的参数把旧条目整条盖掉——关键词被整个换掉（检索就漏）、归属被搬到另一个项目（回执不提）、更短的新内容把旧细节吃掉（实测 78 字 → 67 字，尾句直接消失）。现在只做加法：关键词取并集、归属冲突保留旧的并说明、内容变短且非逐字默认不换（overwrite: true 才换），回执逐项报账。基准在 tools/probe-merge.mjs（含旧写法会丢东西的阴性对照）',
  },
  {
    marker: '[macro-fusion 0.2.88]',
    file: 'vendor/meow-memory/lib/index.js',
    what: '跨层重复：写去重只在同一层里比（db.list(level)），所以同一句话既记 fact 又记 lesson 会真的落下两份——实测检索时两条分数一模一样（1.280 / 1.280）并排端出来，白占一个 k 名额、同一段字让模型读两遍，全程一声不响。现在①写的时候扫别的层，撞上了照样写（层各有分工是合法的）但回执点名「另一层已有（层名 + 短 id + 重复度）」并给归档/改写两条出路；②检索时 foldNearDupes 折掉逐字级重复（只折 ≥80% 的，改写过的照旧），折几条写进尾注，dedupe: false 看全量。基准在 tools/probe-dup.mjs（含 dedupe:false 回两条的阴性对照）',
  },
  {
    marker: '[macro-fusion 0.2.89]',
    file: 'vendor/meow-memory/lib/index.js',
    what: '相似检索（memory_find_similar）两处口径错位：① 候选过滤原来带 r.source_session !== sessionId，把「本会话刚写的」整批排掉——可「我刚写了这几条，谁跟谁像」正是它最自然的用法，实测三条相关记忆写完，回执是「可比的候选一条都没有……等下一次会话再问」，等于把工具在自己最该用的时刻关掉；② 基准只拿 found.row.content 去比、候选取的却是 docText（title + 正文 + keywords），同一把尺子两边量的字不一样：实测只沾基准 keywords 的候选在正文口径下 0.000 分（被 s<=0 直接丢掉），基准也走 docText 才 0.228。现在两侧都走 docText，会话身份不再兼职做去重（seen 仍然排除——「别重复端」是 seen 的活），命中里若有本会话刚写的会在尾注点名「不是库里积累的旧账」。基准在 tools/probe-similar.mjs（含换会话不再点名、正文口径零命中的阴性对照）',
  },
  {
    marker: '[macro-fusion 0.2.90]',
    file: 'vendor/meow-memory/lib/index.js',
    what: '相似检索只报一把尺子：「相似度」一直是 cosine（对长文宽容），而写侧 80% 合并门槛量的是词集 Jaccard——两个数能差一个量级：实测长条目里嵌着一模一样的短句是 cosine 0.715 / 逐字 0.354，近重复（改几个字）0.944 / 0.808，同话题不同结论 0.134 / 0.025。只报 cosine，读者会把「同话题」当成「同一句」，也没法跟 memory_remember 回执里那句「重复度 N%」对上号。现在①每条命中同时报 repeat（词集 Jaccard，只比正文——和写侧 similarity(r.content, content) 同一个输入、同一把尺子，实测写侧 81% vs 读侧 0.808）；②Jaccard 收成一处实现 overlapOfSets，similarity() 直接复用，防两套口径漂移；③两种典型误读当场给校准句：相似度 ≥0.50 但逐字重复度不到 50% 的说「看着像、其实不是同一句」，逐字 ≥80% 的说「写侧会判重复，多半是同一句话存进了两层」；④融合层 mode=similar 的兜底文案删掉过期的「等下一次会话」（0.2.89 起本会话新写的也算候选）。基准在 tools/probe-ruler.mjs（含写侧/读侧同口径、tokenize 复算一致两条阴性对照）',
  },
  {
    marker: '[macro-fusion 0.2.91]',
    file: 'lib/macro/defs/admin.js',
    what: '面板与工具各说一套话：星图体检报「疑似重复（N）…（相似 1）」用的是**稀有词签名**近似（每条约留最稀有的 24 个词、只算 df≥2 的词、门槛 0.86），库小的时候签名退化成「两边共有的词」，Jaccard 会顶到 1；而工具里的「逐字重复度」是全文词集，跟写侧 80% 合并判据同源。实测同一对内容（共享前言 + 两个不同核心、各 40 余字）：面板说「相似 1」、memory_search 说「相似度 0.624（逐字 0.42）」、写侧压根没判重复——三个口径三个答案，方向还是「把两件独立的事判成一件」，照着面板去归档等于误删。融合层拿不到正文、算不出第二把尺子，所以不重算：只在真列出对子时（kind 省略或 dup、且正文里有「（相似 」）把校准句并进抬头，说清这个 N 是什么、什么时候会顶格、要判「同一句存了两层」去看 memory_search 的 repeat（≥0.80）。基准在 tools/probe-graph.mjs 的 H 段（含写侧不判重复、kind=stale 不掺两条阴性对照）',
  },
  {
    marker: '[macro-fusion 0.2.92]',
    file: 'vendor/meow-memory/lib/index.js',
    what: 'dream 拿不到「重复」这把尺子：memory_remember 写的时候算得出逐字重复度（0.2.88 跨层点名、0.2.90 检索里报 repeat），可 dream——全库唯一回头看旧条目的地方——只给清单，哪两条其实是同一句话全靠模型自己扫字面比。现在①collectDreamRounds 选出来的每一组行两两算正文词集 Jaccard（和写侧 DEDUP_THRESHOLD 同一个门槛、同一个 overlapOfSets），≥80% 的对子按重复度降序取前 5 对，在清单末尾单独列一段「【逐字重复对 N 对】」并给处置（保留信息更全的、另一条 status=archived；只是相似度高的不算）；②没有对子时一个字不加（干净清单不加噪音）；③顺手修短 id 撞车：id 开头是 base36 时间戳，同一批连写两条前 8 位常常一模一样（实测 BASE/NEAR 都截成 0mwo20eo），清单与跨层回执原来都印 slice(0,8)，读者拿着它去 memory_update 会撞上 MemoryDb.update 的歧义拒绝、报成「未找到该记忆」——现在清单内用 uniqueShortIdsAmong 保证互不撞前缀，回执用 uniqueShortId 按层确认唯一。基准在 tools/probe-ruler.mjs 的 D 段（含「成员正好是那一对」「单条目不出块」两条阴性对照）',
  },
  {
    marker: '[macro-fusion 0.2.95]',
    file: 'vendor/meow-memory/lib/index.js',
    what: '覆盖度只回答「是不是同一件事」，不回答「合并会不会漏字」：≥90% 的意思是短条最多还有 10% 的词没落进长条，而指引只喊「合成一条」，模型多半把短条整条扔掉，那 10% 就跟着没了。现在每一个重复详写对下面多印一行处方：短条里长条没有的词按词长降序（最多 DREAM_MERGE_WORDS = 6 个）逐字点出来，告诉模型合并时要把它们补进长条；一个都没有时不留白，直接说「短条没有长条之外的词，这次合并没有东西要补」，把「这次合并是无损的」也变成可核对的结论。三语 labels 的 dream.cover.keep / dream.cover.keepNone 提供文案，三语六份 dream 指引同时写清「怎么合并」与三把尺子的分工——逐字重复 ≥80%（同一句话两个副本）与覆盖度 ≥90%（摘要 + 全文）属于「重复」，该合并归档；体检的「相似 N」与 memory_search 的 mode="similar"（稀有词签名）属于「相似」，同一话题的两句不同的话不许合并，最多互相补一句指针。基准在 tools/probe-ruler.mjs 的 F1–F4 段（含无损分支与「不硬凑词」的阴性对照）',
  },
  {
    marker: '[macro-fusion 0.2.94]',
    file: 'vendor/meow-memory/lib/index.js',
    what: '逐字重复度这把尺子天生抓不到「一条短摘录 + 一条长详写」：实测 15 词对 92 词只有 0.16，对 32 词也只有 0.47，全都落在 80% 门槛外面，可它们说的是同一件事，只是叠成了「摘要 + 全文」。写侧 DEDUP_THRESHOLD 与 dream 的重复对都只认 Jaccard，于是同一个知识点永久存两层、首轮注入多付一份钱。现在 dream 清单另开一块「重复详写对」：判据换成覆盖度（分母取小集合，短的那条几乎整句都在长的那条里），配两道闸——短的那条至少 8 个不同的词（拦住一个短语碰巧撞进长文；这条不能用长度比挡，最常见的形态就是 15 词 ⇄ 92 词、比值 0.16）、长度比 ≤0.75（拦住两条差不多长、本就该各说各的）；与 ≥80% 的重复对互斥，同一对不印两遍。处置写的是「合成一条、保留信息更全的那条、另一条 archived」，三语 labels 的 dream.cover.title / dream.cover.rule 提供文案，三语六份指引都说清「repeat 低也可能是同一件事」。基准在 tools/probe-ruler.mjs 的 E1–E5 段（含方向、阴性对照、与逐字重复块互斥）',
  },
  {
    marker: '[macro-fusion 0.2.93]',
    file: 'vendor/meow-memory/lib/index.js',
    what: 'dream 的重复对只在「本轮的行」里比，可 atomic 与 topic 是**两次独立的消息**：同一句话一条记成 fact、一条记成 topic 时，两条永远不在一轮里，重复对就永远算不出来——写侧 crossLevelDupe 扫全部层、早就能抓，dream 又漏一次（同一把尺子只在写入方向上装好，回头看时又没刻度）。现在把整个 dream 范围的行（allRows，含 atomic 与 topic 两轮）一起算对子，只由「在轮次里先出现的那一轮」负责展示：同一对只印一次，不在两轮消息里各印一遍（否则白烧一份 token，还会让模型以为有两对）；配对的那条不在本轮时，行尾标「（另一组）」并由三语 labels 的 dream.dup.crossRound 提供，三语 dream-atomic / dream-topic 指引同时说清「看不见对方也得照同一处置办，同一对只处置一次」。基准在 tools/probe-ruler.mjs 的 D8/D9/D10 段（含「整轮只印一次」「无关那条不配对」两条阴性对照）',
  },
]
for (const p of PATCHES) {
  const abs = join(root, p.file)
  if (!existsSync(abs)) fail('补丁目标不存在', p.file)
  else {
    const src = readFileSync(abs, 'utf8')
    line(src.includes(p.marker) ? 'PASS' : 'FAIL', true, `补丁在位：${p.what}`, p.file)
    if (!src.includes(p.marker)) console.log('      vendor 升级会冲掉补丁；按 README §9.14 重新打上再跑 verify')
  }
}

// ── 5. vendor 账本：拷进来的第三方源码有没有被改过（0.2.17）───────────────────
// 补丁账本管「我们打的补丁还在不在」，这一段管「除我们之外没人动过 vendor」。
// 两者互补：只有账本，会漏掉「补丁被自己改丢」；只有补丁，会漏掉「vendor 被整段换掉」。
console.log('\n== vendor 账本 ==')
{
  const manifestPath = join(root, 'vendor', 'VENDOR.json')
  if (!existsSync(manifestPath)) {
    fail('vendor 账本不存在', '跑 node tools/make-vendor-manifest.mjs')
  } else {
    const manifest = readJson(manifestPath)
    const { hashTree, vendorPackage, listFiles } = await import(pathToFileURL(join(root, 'tools', 'vendor-hash.mjs')).href)
    const listed = Array.isArray(manifest.vendors) ? manifest.vendors : []
    line(listed.length > 0 ? 'PASS' : 'FAIL', true, '账本里有 vendor 条目', String(listed.length))
    for (const v of listed) {
      const abs = join(root, v.dir)
      if (!existsSync(abs)) {
        fail(`账本指向的目录不存在`, v.dir)
        continue
      }
      const pkg = vendorPackage(abs)
      line(pkg?.version === v.version ? 'PASS' : 'FAIL', true, `账本版本与源码一致：${v.name}`, `账本=${v.version} 源码=${pkg?.version ?? '无 package.json'}`)
      const now = hashTree(abs)
      const same = now.files === v.files && now.bytes === v.bytes && now.sha256 === v.sha256
      line(same ? 'PASS' : 'FAIL', true, `账本指纹一致：${v.dir}`, same ? `${now.files} 文件 / ${now.bytes} B / ${now.sha256.slice(0, 16)}` : `账本 ${v.files}/${v.bytes}/${String(v.sha256).slice(0, 16)} ≠ 实际 ${now.files}/${now.bytes}/${now.sha256.slice(0, 16)}`)
      if (!same) console.log('      vendor 被改过：确认是自己改的就重跑 node tools/make-vendor-manifest.mjs，否则按 README §9.22 还原')
    }
    // 反向核对：vendor 下有没有目录没记账（新拷一个进来却没人发现，比改旧文件更常见）
    const onDisk = existsSync(join(root, 'vendor'))
      ? readdirSync(join(root, 'vendor')).filter((n) => statSync(join(root, 'vendor', n)).isDirectory())
      : []
    const known = new Set(listed.map((v) => v.dir.replace(/^vendor[\\/]/, '')))
    const unlisted = onDisk.filter((n) => !known.has(n) && n !== 'node_modules')
    line(unlisted.length === 0 ? 'PASS' : 'FAIL', true, 'vendor 下没有未记账的目录', unlisted.join(',') || `${onDisk.length} 个目录全部记账`)
  }
}

// ── 6. 自检基线：每支脚本「应该有多少条断言」也要记账（0.2.18）───────────────
// 为什么单开一段：check-all 拿 baselines.json 做「断言数回退」判定，基线本身过期就会误红或漏红。
// 最常见的过期方式是发版忘了 --update-baselines：版本号变了、条数也变了，但基线还写着上一个版本。
console.log('\n== 自检基线 ==')
{
  const baselinesPath = join(root, 'tools', 'baselines.json')
  if (!existsSync(baselinesPath)) {
    fail('基线文件不存在', '跑 node tools/check-all.mjs --update-baselines')
  } else {
    const base = readJson(baselinesPath)
    const counts = base.counts ?? {}
    line(base.version === pkg.version ? 'PASS' : 'FAIL', true, '基线版本与当前版本一致', `基线=${base.version} 当前=${pkg.version}`)
    if (base.version !== pkg.version) console.log('      发版后忘了重记：node tools/check-all.mjs --update-baselines')
    // 反向核对：check-all 里列的每一支都得有计数，否则新加的脚本永远不被记账
    const listed = [...readFileSync(join(root, 'tools', 'check-all.mjs'), 'utf8').matchAll(/^\s*\['([^']+\.mjs)'/gm)].map((m) => m[1])
    const missing = listed.filter((f) => counts[f] === undefined)
    line(listed.length > 0 && missing.length === 0 ? 'PASS' : 'FAIL', true, '基线覆盖 check-all 里的每一支', missing.join(',') || `${listed.length} 支`)
    const bad = Object.entries(counts).filter(([, n]) => !Number.isInteger(n) || n < 0)
    line(bad.length === 0 ? 'PASS' : 'FAIL', true, '基线条数都是非负整数', bad.map(([f, n]) => `${f}=${n}`).join(',') || `${Object.keys(counts).length} 支`)
    const total = Object.values(counts).reduce((n, v) => n + (Number.isInteger(v) ? v : 0), 0)
    console.log(`      基线条数合计 ${total} 条（断言数掉了 check-all 会判红；多了会提醒重记）`)

    // 耗时预算（0.2.19）：没有预算的脚本一旦卡死，整条验收命令就停在那里，
    // 分不清「还在跑」和「已经挂了」。所以每一支都必须有预算，而且要大于上次实测。
    const budgets = base.budgetMs ?? {}
    const lastMs = base.ms ?? {}
    const noBudget = listed.filter((f) => !Number.isInteger(budgets[f]) || budgets[f] <= 0)
    line(noBudget.length === 0 ? 'PASS' : 'FAIL', true, '每支都有耗时预算', noBudget.join(',') || `${Object.keys(budgets).length} 支`)
    const tooTight = listed.filter((f) => Number.isInteger(budgets[f]) && Number.isInteger(lastMs[f]) && budgets[f] < lastMs[f] * 2)
    line(
      tooTight.length === 0 ? 'PASS' : 'FAIL',
      true,
      '预算至少是上次实测的两倍',
      tooTight.map((f) => `${f} 预算${Math.round(budgets[f] / 1000)}s/实测${(lastMs[f] / 1000).toFixed(1)}s`).join(',') ||
        `最紧的一支 ${Math.round(Math.min(...listed.map((f) => (budgets[f] ?? 0) / Math.max(lastMs[f] ?? 1, 1))) * 10) / 10}×`,
    )
    const slowest = listed
      .filter((f) => Number.isInteger(lastMs[f]))
      .sort((a, b) => lastMs[b] - lastMs[a])
      .slice(0, 2)
      .map((f) => `${f} ${(lastMs[f] / 1000).toFixed(1)}s`)
    console.log(`      最慢的两支：${slowest.join('，') || '（还没记耗时）'}`)

    // 耗时漂移（0.2.20）：预算只挡「卡死」，挡不住「每次验收都慢一点」的退化。
    // 这里不重算漂移（那要跑一遍），只核对尺子还在：check-all 里必须有阈值常量，
    // 且 ms 与 budgetMs 覆盖同一批脚本——两张表错位时漂移判定会静默失效。
    const checkAllSrc = readFileSync(join(root, 'tools', 'check-all.mjs'), 'utf8')
    const hasFactor = /const SLOW_FACTOR = 1\.5/.test(checkAllSrc) && /const SLOW_FLOOR_MS = 1_000/.test(checkAllSrc)
    line(hasFactor ? 'PASS' : 'FAIL', true, '耗时漂移有阈值（1.5 倍、1s 以下不比）', hasFactor ? 'SLOW_FACTOR/SLOW_FLOOR_MS 在' : '常量缺失')
    const msOnly = listed.filter((f) => Number.isInteger(lastMs[f]) !== Number.isInteger(budgets[f]))
    line(
      msOnly.length === 0 ? 'PASS' : 'FAIL',
      true,
      '耗时表与预算表覆盖同一批脚本',
      msOnly.map((f) => `${f} ms=${lastMs[f] ?? '—'} budget=${budgets[f] ?? '—'}`).join(',') || `${Object.keys(lastMs).length} 支`,
    )
  }
}

// ── 6b. 存储层：路径只有一个出处（0.2.21）───────────────────────────────────
// 为什么单开：`$DSH_HOME` 一旦被多处读，就会出现「换个 home 之后账本写一边、队列写另一边」这种
// 只在别人的机器上复现的错。这里只做一件事：全 lib 数一遍谁读了 DSH_HOME，多一个就红。
console.log('\n== 存储层 ==')
{
  const libRoot = join(root, 'lib')
  const jsFiles = []
  const walkJs = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name)
      if (e.isDirectory()) walkJs(p)
      else if (e.name.endsWith('.js')) jsFiles.push(p)
    }
  }
  walkJs(libRoot)
  const readers = jsFiles.filter((f) => readFileSync(f, 'utf8').includes('process.env.DSH_HOME'))
  const rel = readers.map((f) => f.slice(root.length + 1).replace(/\\/g, '/'))
  line(
    rel.length === 1 && rel[0] === 'lib/macro/store.js' ? 'PASS' : 'FAIL',
    true,
    '路径只有一个出处（lib/macro/store.js）',
    rel.join(',') || '没人读 DSH_HOME',
  )
  const parsers = jsFiles.filter((f) => /JSON\.parse\(line\)/.test(readFileSync(f, 'utf8')))
  line(
    parsers.length <= 1 ? 'PASS' : 'FAIL',
    true,
    'jsonl 逐行解析没有第二份',
    parsers.map((f) => f.slice(root.length + 1).replace(/\\/g, '/')).join(',') || '无',
  )
  // 数据目录不在这里再算一遍：路径唯一出处在 store.js，第 7 段会直接打印 pendingPath()
}

// ── 6c. 结构：桥拆三件事，各一个文件（0.2.26）──────────────────────────────
// 为什么单开：`bridge.js` 曾把「收下工具/注入」「换门（Proxy）」「出文本」混在 292 行里。
// 这里只数位置：Proxy 只许在 facade.js，纯函数只许在 render.js，桥本身不许自己换门。
console.log('\n== 结构 ==')
{
  const src = (rel) => readFileSync(join(root, rel), 'utf8')
  const bridgeSrc = src('lib/macro/bridge.js')
  const facadeSrc = src('lib/macro/facade.js')
  const renderSrc = src('lib/macro/render.js')
  line(
    bridgeSrc.includes('export function createBridge') && !bridgeSrc.includes('new Proxy(') ? 'PASS' : 'FAIL',
    true,
    '桥只管收下与转调（Proxy 不在 bridge.js）',
    'lib/macro/bridge.js',
  )
  line(
    /export function createFacade/.test(facadeSrc) && facadeSrc.includes('new Proxy(') ? 'PASS' : 'FAIL',
    true,
    '换门只在 facade.js',
    'lib/macro/facade.js',
  )
  line(
    /export function renderToolText/.test(renderSrc) && !/^\s*import /m.test(renderSrc) ? 'PASS' : 'FAIL',
    true,
    '出文本是纯函数（render.js 不 import）',
    'lib/macro/render.js',
  )
  line(
    bridgeSrc.includes("from './facade.js'") && bridgeSrc.includes('export { errText }') ? 'PASS' : 'FAIL',
    true,
    '旧引用仍能从 bridge.js 转出（调用方不改）',
    'bridge.js → facade.js / render.js',
  )
}
  // 0.2.27：根只许在 _root.mjs 算一次。以前 13 种写法，其中两条把 D:/dsh-home 写死，
  // 还有一条拿 process.cwd() 当根——换个目录跑就找错地方（param-audit 会 ERR_MODULE_NOT_FOUND）。
  const otherTools = readdirSync(join(root, 'tools')).filter((n) => n.endsWith('.mjs') && n !== '_root.mjs')
  const rederived = otherTools.filter((n) => {
    const t = readFileSync(join(root, 'tools', n), 'utf8')
      .split('\n')
      .filter((l) => !/^\s*(\/\/|\*|\/\*|\*\/)/.test(l))
      .join('\n')
    return /const\s+root\s*=\s*(dirname\(|process\.cwd\(\)|['"]D:)/.test(t)
  })
  line(
    /export const root = dirname\(dirname\(fileURLToPath\(import\.meta\.url\)\)\)/.test(
      readFileSync(join(root, 'tools', '_root.mjs'), 'utf8'),
    ) && rederived.length === 0
      ? 'PASS'
      : 'FAIL',
    true,
    '根只有一处出处（tools/_root.mjs）',
    rederived.length ? rederived.join(', ') : 'tools/_root.mjs',
  )

// 补连预算是真的（0.2.28）：不是「星图恰好快」，而是每一次 await 都被剩余预算包着。
// tryCall 的 timeoutMs 只管「等工具注册」，execute 本身慢多久都照等——读路径最怕这个。
const linksBudgetSrc = readFileSync(join(root, 'lib', 'macro', 'links.js'), 'utf8')
const budgetWrapped = (linksBudgetSrc.match(/withBudget\(/g) ?? []).length
line(
  linksBudgetSrc.includes('export const MIN_STEP_MS') && budgetWrapped >= 4 ? 'PASS' : 'FAIL',
  true,
  '补连预算是真的（慢调用会被掐断，不是恰好快）',
  `withBudget ×${budgetWrapped}`,
)

// 跨插件措辞只有一处（0.2.29 / 0.2.38）：星图的回答只有文字，认字就是唯一的判据。
// 判据本身也只写一份——常量表在 tools/criteria.mjs，这里只把源码丢进去汇总成一行。
// （0.2.37 之前这里有第二份 bareMarks 手抄表；改一个值要改两处，一处红一处绿。）
const contractSrc = readFileSync(join(root, 'lib', 'macro', 'contract.js'), 'utf8')
const contractModule = await import(pathToFileURL(join(root, 'lib', 'macro', 'contract.js')).href)
const macroRead = (f) => readFileSync(join(root, 'lib', 'macro', f), 'utf8')
const contractList = criteria.contractChecklist({
  contractSrc,
  sources: {
    ...Object.fromEntries(criteria.CONTRACT_LEAK_FILES.map((f) => [f, macroRead(f)])),
    // 0.2.55：「空的四种来路」横跨存储层与两个面板，判据要读得到这三个文件
    'store.js': macroRead('store.js'),
    'cost.js': macroRead('cost.js'),
    // 0.2.61：面板条数的口径在 panel.js（limitOf）与 defs/admin.js（两处调用点）里
    'panel.js': macroRead('panel.js'),
    'defs/admin.js': macroRead(join('defs', 'admin.js')),
    // 0.2.62：条数出口在 shared.js（countParam），调用点在 defs/read.js
    'shared.js': macroRead('shared.js'),
    'defs/read.js': macroRead(join('defs', 'read.js')),
    // 0.2.63：注入上限的口径在 prompt.js（guideBudget），调用点在 lib/index.js 与 defs/admin.js
    'prompt.js': macroRead('prompt.js'),
  },
  runtime: contractModule,
  nebIndexSrc: readFileSync(join(root, 'vendor', 'dsh-memory-nebula', 'lib', 'index.js'), 'utf8'),
  nebCoreSrc: readFileSync(join(root, 'vendor', 'dsh-memory-nebula', 'lib', 'host', 'nebula.js'), 'utf8'),
  meowIndexSrc: readFileSync(join(root, 'vendor', 'meow-memory', 'lib', 'index.js'), 'utf8'),
})
line(
  contractList.every((c) => c.ok) ? 'PASS' : 'FAIL',
  true,
  '跨插件措辞只有一处，且有断言盯 vendor',
  criteria.summarizeChecklist(contractList),
)

// 「找不到这两条记忆」按年龄分辨（0.2.30）：星图的 404 既可能是「节点还没建进图」，也可能是「记忆真的没了」。
// 旧代码一律当永久失败摘掉，代价是刚写完记忆顺手连的线被清空，且不报错。
const graceSrc = readFileSync(join(root, 'lib', 'macro', 'links.js'), 'utf8')
const flowSrc30 = readFileSync(join(root, 'lib', 'macro', 'linkflow.js'), 'utf8')
// 0.2.33：理由表与面板（判据在下面「排队理由只有一份」那一行）
const linksSrc33 = readFileSync(join(root, 'lib', 'macro', 'links.js'), 'utf8')
const linksRuntime = await import(pathToFileURL(join(root, 'lib', 'macro', 'links.js')).href)
const flowSrc33 = flowSrc30
const linkSrc33 = readFileSync(join(root, 'lib', 'macro', 'defs', 'link.js'), 'utf8')
const adminSrc33 = readFileSync(join(root, 'lib', 'macro', 'defs', 'admin.js'), 'utf8')
const graceAged = /Date\.now\(\) - entry\.ts >= MISSING_GRACE_MS/.test(graceSrc)
const queueBothWays = flowSrc30.includes('saysMissingNodes(r.text)') && flowSrc30.includes('PENDING_REASONS.notBuilt')
const noOneShot = !graceSrc.includes('isPermanentFailure') && !flowSrc30.includes('isPermanentFailure')
line(
  graceAged && queueBothWays && noOneShot ? 'PASS' : 'FAIL',
  true,
  '同一句「找不到」按年龄分辨，写路径会排队',
  graceAged ? 'MISSING_GRACE_MS 生效' : '缺年龄判据',
)

// 前台写路径也有期限（0.2.31）：0.2.28 的预算只管后台补连，前台 memory_link / applyLinks 一直裸等
// execute，星图建图争锁时调用会挂几十秒。判据两条：期限常量在、两条前台调用都套了 withBudget。
const linkSrc31 = readFileSync(join(root, 'lib', 'macro', 'defs', 'link.js'), 'utf8')
const boundedWrite = flowSrc30.includes("withBudget(tryCall('nebula_link'") && linkSrc31.includes("withBudget(flow.tryCall('nebula_link', payload")
const noBareWait = !flowSrc30.includes("const r = await tryCall('nebula_link'")
line(
  boundedWrite && noBareWait ? 'PASS' : 'FAIL',
  true,
  '前台写连线也有期限，超时排队不挂死',
  boundedWrite ? 'LINK_CALL_MS 生效' : '前台仍裸等 execute',
)

// 一批连线两道闸（0.2.32）：单条期限管不了「12 条各挂 20 秒 = 4 分钟」，
// 而旧的 `items.slice(0, 12)` 会把第 13 条起悄悄吃掉。判据：两道闸都在、静默截断消失、超出会排队。
const batchGated = flowSrc30.includes('const deadline = Date.now() + linkBatchMs') && flowSrc30.includes('Math.min(linkCallMs, left)')
const noSilentCut = !flowSrc30.includes('items.slice(0, 12)') && flowSrc30.includes('[...overflow, ...later]')
line(
  batchGated && noSilentCut ? 'PASS' : 'FAIL',
  true,
  '一批连线有总账，超出的排队不消失',
  batchGated ? 'LINK_BATCH_MS 生效' : '缺整批总账',
)

// 理由与期限各只有一份（0.2.33）：同一个「连线失败」以前两种叫法，面板按理由分组就多一组；
// 1200/1500/8/20/1500 以前散在三处，面板还自己传一遍数。
//
// 0.2.35：判据本身也只有一份 —— 以前这段与 verify 的 A31 各写一遍，宽严还不一致
// （verify 拿五个值逐个查裸字面量，这里只钉了两个），把 `'连线失败待重试'` 抄回去会
// verify 红、doctor 绿。现在两边都读 tools/criteria.mjs，红的时候这里直接说清哪几条。
const list = criteria.reasonChecklist({
  linksSrc: linksSrc33,
  flowSrc: flowSrc33,
  linkSrc: linkSrc33,
  adminSrc: adminSrc33,
  reasons: linksRuntime.PENDING_REASONS ?? {},
  order: linksRuntime.REASON_ORDER ?? [],
})
const bad = list.filter((c) => !c.ok)
line(
  bad.length === 0 ? 'PASS' : 'FAIL',
  true,
  '排队理由与期限的口径只此一份（判据见 tools/criteria.mjs）',
  criteria.summarizeChecklist(list),
)

// ── 7. 运行时：注入长度、队列、账本 ─────────────────────────────────────────
console.log('\n== 运行时 ==');
const prompt = await import(pathToFileURL(join(root, 'lib', 'macro', 'prompt.js')).href)
const guide = prompt.clampGuide(prompt.GUIDE_TEXT, prompt.GUIDE_MAX_CHARS)
line(guide.length <= prompt.GUIDE_MAX_CHARS ? 'PASS' : 'FAIL', true, 'L0 注入不超上限', `${guide.length}/${prompt.GUIDE_MAX_CHARS} 字符`)
// 0.2.34：上限本身不是问题，问题是「切了不说」。余量掉到下限以下就该删句子；
// 真要截断时尾巴必须把「去哪看全文」留住。
const headroom = prompt.GUIDE_MAX_CHARS - guide.length
const truncates = guide === prompt.GUIDE_TEXT ? false : guide.includes(prompt.GUIDE_TAIL_MARK)
line(
  headroom >= prompt.GUIDE_MIN_HEADROOM ? 'PASS' : 'FAIL',
  true,
  'L0 注入留有余量，不贴上限',
  `余量 ${headroom} / 下限 ${prompt.GUIDE_MIN_HEADROOM} 字符`,
)
const longProbe = prompt.clampGuide('x'.repeat(4000), 400)
line(
  truncates || (longProbe.length <= 400 && longProbe.includes('memory_admin(action="guide")')) ? 'PASS' : 'FAIL',
  true,
  '注入被截断时会自己说出来（尾巴留住全文入口）',
  longProbe.includes('memory_admin(action="guide")') ? 'GUIDE_TAIL_MARK 生效' : '截断后出口丢了',
)
for (const tool of ['memory_remember', 'memory_admin']) {
  line(guide.includes(tool) ? 'PASS' : 'FAIL', true, `注入覆盖 ${tool}`)
}

const cost = await import(pathToFileURL(join(root, 'lib', 'macro', 'cost.js')).href)
console.log(`      macro home = ${linksRuntime.pendingPath()}`)
const pending = linksRuntime.readPending()
line(pending.length <= linksRuntime.PENDING_MAX ? 'PASS' : 'FAIL', true, '待补连队列未溢出', `${pending.length}/${linksRuntime.PENDING_MAX}`)
// 同理（0.2.55）：这一条也永远算一条断言，别让「前面探针排了一条补连」把断言数顶高
if (pending.length > 0) line('PASS', true, '有排队中的连线（读记忆会自动补）', `${pending.length} 条`)
else line('PASS', true, '当前没有排队中的连线', '0 条')
const ledger = cost.ledgerPath()
// 这一条永远算一条断言（0.2.55）：原先「账本在 → PASS 一行 / 不在 → 只 console.log」，
// 于是同一次 check-all 里账本先被前面的探针写过、后又被清掉，断言数就会 77/78 跳一格。
if (existsSync(ledger)) line('PASS', true, '成本账本存在', `${statSync(ledger).size} B`)
else line('PASS', true, '成本账本还没生成（还没调用过工具）', '0 B')

// ── 6. 文档声称（文档写了什么，就得是什么）────────────────────────────────
// 0.2.81：文档拆成两份。根 README.md 是给外面看的门面（DSH 市场详情页直接拿它渲染），
// docs/INTERNAL.md 是逐轮开发日志（原来那份 268 KB 的 README）。判据各管各的：
// 「脚本有没有出处」属于内部日志；「版本号 / 产物字节数 / 许可 / 图」两份都得对得上。
console.log('\n== 文档声称 ==')
const internalPath = existsSync(join(root, 'docs', 'INTERNAL.md'))
  ? join(root, 'docs', 'INTERNAL.md')
  : join(root, 'README.md')
if (!existsSync(internalPath)) warn('找不到 docs/INTERNAL.md')
else {
  const md = readFileSync(internalPath, 'utf8')
  // 6.1 内部日志提到的 tools/<x>.mjs 都得真的存在
  const mentioned = [...new Set([...md.matchAll(/tools\/([A-Za-z0-9._-]+\.mjs)/g)].map((m) => m[1]))]
  const ghost = mentioned.filter((n) => !existsSync(join(root, 'tools', n)))
  if (ghost.length === 0) pass('内部日志提到的脚本都存在', `${mentioned.length} 个`)
  else fail('内部日志提到的脚本不存在', ghost.join(','))
  // 6.2 反向：tools/ 下每个脚本都要在内部日志里露过面（临时脚本以 _ 开头不算）
  const onDisk = readdirSync(join(root, 'tools')).filter((n) => n.endsWith('.mjs') && !n.startsWith('_'))
  const undocumented = onDisk.filter((n) => !mentioned.includes(n))
  if (undocumented.length === 0) pass('脚本都有文档出处', `${onDisk.length} 个`)
  else warn('脚本缺文档出处', `${undocumented.length}/${onDisk.length} 未记录：${undocumented.join(',')}`)
  // 6.3 版本号
  if (md.includes(pkg.version)) pass('内部日志提到当前版本号', pkg.version)
  else warn('内部日志未提当前版本号', pkg.version)
}

// 6.4 对外门面：这一份会被市场详情页与 GitHub 首页直接展示，缺一句话就是对外缺一句话。
const publicPath = join(root, 'README.md')
if (!existsSync(publicPath)) fail('找不到公开 README.md', publicPath)
else {
  const face = readFileSync(publicPath, 'utf8')
  pass('公开 README 存在', `${readFileSync(publicPath).length} B`)
  if (face.includes(pkg.version)) pass('公开 README 提到当前版本号', pkg.version)
  else warn('公开 README 未提当前版本号', pkg.version)
  // 产物数字：门面上写的是「这个包现在长什么样」，过时就是假话。
  if (existsSync(clientFile)) {
    const bytes = readFileSync(clientFile).length
    const human = bytes.toLocaleString('en-US')
    const hex = createHash('sha256').update(readFileSync(clientFile)).digest('hex')
    if (face.includes(human)) pass('公开 README 的 client.js 字节数是最新的', human)
    else warn('公开 README 的 client.js 字节数过时', `实际 ${human}`)
    if (new RegExp(hex.slice(0, 8), 'i').test(face)) pass('公开 README 的 sha256 前缀是最新的', `${hex.slice(0, 8).toUpperCase()}…`)
    else warn('公开 README 的 sha256 前缀过时', `实际 ${hex.slice(0, 8).toUpperCase()}…`)
  }
  // 门面里每一张图都得真的在仓库里——市场详情页不会替我们兜住一个空图片框。
  const images = [...face.matchAll(/!\[[^\]]*\]\(([^)\s]+)\)/g)]
    .map((m) => m[1])
    .filter((p) => !/^https?:/i.test(p))
  const missing = images.filter((p) => !existsSync(join(root, p)))
  if (images.length > 0 && missing.length === 0) pass('公开 README 引用的图都在', `${images.length} 张`)
  else fail('公开 README 引用的图缺失', missing.join(',') || '一张图都没引用')
}

// 6.5 许可与第三方声明：MIT 要留着别人的版权声明，这事不能只写在口头。
const licensePath = join(root, 'LICENSE')
if (existsSync(licensePath) && /^MIT License/.test(readFileSync(licensePath, 'utf8'))) pass('根 LICENSE 是 MIT 原文')
else fail('根 LICENSE 缺失或不是 MIT', licensePath)
const noticesPath = join(root, 'THIRD-PARTY-NOTICES.md')
if (existsSync(noticesPath)) {
  const notes = readFileSync(noticesPath, 'utf8')
  const needs = [
    ['Phant0Meow', 'meow 原作者署名'],
    ['https://github.com/Phant0Meow/dsh-meow-memory', 'meow 上游地址'],
    ['MIT', '许可类型'],
  ]
  const lacking = needs.filter(([text]) => !notes.includes(text)).map(([, what]) => what)
  if (lacking.length === 0) pass('第三方声明留着原作者署名与上游地址', `${needs.length} 项都在`)
  else fail('第三方声明缺项', lacking.join('、'))
} else fail('找不到 THIRD-PARTY-NOTICES.md', noticesPath)

// 6.6 市场索引：文件得在（内容合不合格式由 tools/check-market.mjs 用真校验器判）
const indexPath = join(root, 'plugin-market', 'index.json')
if (existsSync(indexPath)) pass('市场索引文件存在', `${readFileSync(indexPath).length} B`)
else fail('找不到 plugin-market/index.json', indexPath)

// ── 7. 备份 ─────────────────────────────────────────────────────────────────
console.log('\n== 备份 ==')
// 这一条刻意两种结果都走 pass：断言条数必须稳定（0.2.86 踩过——备份建成之前走 warn、建成之后走 pass，
// 于是 doctor 的 PASS 条数在 120/121 之间跳，基线就一直是「少 1 条」的假红）。备份有无不是体检结论，只是信息。
const backupRoot = 'D:\\备份'
const hasBackupRoot = existsSync(backupRoot)
const latestBackup = hasBackupRoot
  ? readdirSync(backupRoot)
      .filter((n) => n.includes('macro-fusion'))
      .sort()
      .at(-1)
  : null
if (latestBackup) pass('存在流程备份', latestBackup)
else pass('还没有流程备份（不算异常，只是还没建过）', hasBackupRoot ? backupRoot : '备份目录不存在')

console.log(
  failuresSummary(),
)
function failuresSummary() {
  return verdict.fails === 0
    ? `\n结果：${verdict.warns === 0 ? 'ALL PASS' : `PASS（${verdict.warns} 条 WARN）`}`
    : `\n${verdict.fails} FAILURE(S) / ${verdict.warns} WARN`
}
process.exit(verdict.fails > 0 || (STRICT && verdict.warns > 0) ? 1 : 0)
