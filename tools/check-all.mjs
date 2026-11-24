#!/usr/bin/env node
/**
 * 一条命令验收整个交付物：把十一支自检脚本按固定顺序跑一遍，给一行一个结论 + 一个退出码。
 *
 * 为什么要有它：README 第 4 节列了十一支脚本，发版前得手抄一遍循环；抄漏一支（最常漏的是
 * doctor 与 probe-graph）就会带着「两棵树不同步」或「星图没连上」的状态发出去。顺序也是知识：
 * doctor 必须最后跑，因为它要读两棵树与备份目录；probe-graph 要给真引擎留时间。
 *
 * 两个约束：
 * 1) **只读**。它自己不写产品文件；每支子脚本按自己的约定沙箱 DSH_HOME（verify A8 那条硬约定）。
 * 2) **不用管道收子进程输出**。本机沙箱下 Node 的 `stdio:'pipe'` 会 EPERM（无法开命名管道），
 *    所以这里把子进程的 stdout/stderr 都重定向到临时文件，再用 fd 交给 spawnSync。
 * 3) **断言数要记账**（0.2.18）。只看「绿/红」有个盲区：某支脚本被改坏一半、剩下的断言照样通过，
 *    结果仍然是绿的。所以每支的 `PASS` 行数会和 `tools/baselines.json` 比：掉了就是失败，
 *    多了就提醒你「确认是有意加的，然后 --update-baselines」。基线里没记的脚本只提醒、不判红。
 * 4) **耗时也要记账**（0.2.19）。没有上限时，一支脚本卡死会让整条验收命令停在那里，
 *    分不清「在跑」还是「挂了」。每支带一个 `budgetMs`，超了就直接杀掉并报「超时」，
 *    顺带把「这支变慢了 3 倍」变成一条能读的信号。
 * 5) **变慢要说话，但不用判红**（0.2.20）。预算只挡「卡死」，挡不住「慢慢变成两倍」——
 *    每次验收都慢一点的退化，最后只会表现为「预算被一路调大」。所以每支的耗时和
 *    `ms` 基线比：慢了 SLOW_FACTOR 倍就在那行下面补一句 `~`，汇总里单独列一段，退出码不动。
 *    慢不一定是坏（机器忙、首次跑、杀毒扫描），但「没人说」才是真的要命。
 *
 * 用法：
 *   node tools/check-all.mjs                # 全跑，人读
 *   node tools/check-all.mjs --only=doctor,verify
 *   node tools/check-all.mjs --json         # 机器读（汇总 JSON 到 stdout，进度到 stderr）
 *   node tools/check-all.mjs --verbose      # 每支都打全量输出
 *   node tools/check-all.mjs --update-baselines  # 有意增减断言之后，重记基线（含耗时预算）
 */
import { root } from './_root.mjs'
import { spawnSync } from 'node:child_process'
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const version = (() => {
  try {
    return JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version
  } catch {
    return '?'
  }
})()

/** 顺序是知识，不是字母序：doctor 最后（要读两棵树与备份），probe-graph 前面（要给真引擎时间）。 */
const STEPS = [
  ['verify.mjs', '宿主 + 浏览器装配契约'],
  ['tools/probe-fusion.mjs', '真 vendor 端到端联动（含星图缺席降级 G1–G13）'],
  ['tools/probe-graph.mjs', '真 meow 库 + 真 nebula 引擎：节点/边/生命周期 G1–G11'],
  ['tools/probe-host.mjs', '真 cordis + 真 ToolsService + 真 SystemPrompt'],
  ['tools/probe-client-ui.mjs', '浏览器侧四类 UI 向 slots 注册'],
  ['tools/coverage-audit.mjs', '17 个原工具 → 8 个统一工具的覆盖审计'],
  ['tools/param-audit.mjs', '参数级覆盖：原参数与必填都没退化'],
  ['tools/probe-toolsize.mjs', '工具清单与体积：17 个原工具一个不少、参数没有膨胀'],
  ['tools/probe-tools.mjs', '工具账本：每个脚本有归属、_root 导出不许白用、只读脚本真跑一遍'],
  ['tools/probe-words.mjs', '口径总账：手册、schema、常量、对外文案说的是不是同一件事'],
  ['tools/probe-recall.mjs', '召回校准：相关度优先、重要度进分数、死条目/层过滤/长句召回'],
  ['tools/probe-merge.mjs', '合并账本：关键词并集、归属不搬、变短默认不换、overwrite 才换'],
  ['tools/probe-dup.mjs', '跨层重复：写时点名另一层、检索折叠逐字级重复、dedupe:false 看全量'],
  ['tools/probe-similar.mjs', '相似检索：基准与候选同一把尺子、本会话刚写的也算候选、端过的不再端'],
  ['tools/probe-ruler.mjs', '两把尺子：相似度（cosine）与逐字重复度（词集 Jaccard）并报、与写侧合并判据同源、长文嵌一句要点名'],
  ['tools/probe-gold.mjs', '准确率量尺：40 条真实样张 × 45 条自然问句，hit@1 / hit@3 / MRR 三档 + 阴性对照'],
  ['tools/probe-mq.mjs', '查询分解量尺：20 条双实体问句上 off/conservative 两态（原榜前 3 不动、名次不变差、有增量、阴性对照）'],
  ['tools/probe-consolidate.mjs', '写入端巩固量尺：桩 flow 数调用——off 不发 search / suggest 不写库 / write 恰好多 1 条 / 语义层满只提示并条'],
  ['tools/probe-hygiene.mjs', '写入端通胀量尺：真库数 read_count（检索不冒充读）/ 自证率与层通胀的阳性与阴性对照'],
  ['tools/probe-supersede.mjs', '自动取代量尺：桩 flow 数调用——off 不检索 / suggest 一个字不写库 / apply 才标 stale / 五类判据各有阴性对照'],
  ['tools/probe-entity.mjs', '实体层与动态跳数量尺：四类硬事实 / 层不进图 / 软边第二跳按词面收 / 硬边照走 / 缓存往返自愈'],
  ['tools/probe-cooc.mjs', '共现自学习扩词量尺：词源是 keywords 不是切片 / 同条 2 跨文档 1 / 三道门 / 真进召回 / 库越大越准 / 开关与缓存口径位'],
  ['tools/probe-adapt.mjs', '跨领域适应力量尺：5 个陌生领域 × 12 条，换场景换说法 hit@3 / 阴性与消融 / 两遍只补位不翻盘'],
  ['tools/probe-decl.mjs', '声明对端账：同域词面干扰三条（md01 / tw01 / yy07）——平权与字段加成的落差、歧义类名折扣、对照表不吃加成、单字桥只补 OOV 且不参与已有字面证据、四开关归位逐位退回 0.6.38'],
  ['tools/probe-cost.mjs', '效率量尺：三档语料（40 / 400 / 1200）的 p50/p95、结果快照、缓存只许省时间'],
  ['tools/probe-idf.mjs', '规模自适应 idf 的开关账：默认关 / 小池不动 / λ=0 等价 / 闸门与旋钮真接上 / 成本 ≤2ms'],
  ['tools/probe-empty.mjs', '空回账：库外词不顶掉能命中的词、不凭空编、老护栏不回退、正常问句两态逐位相同'],
  ['tools/probe-determinism.mjs', '定序账：同一问句同一答案——重复/跨进程/打乱插入顺序都逐位相同，并列按更新时间与 id 自然序'],
  ['tools/probe-literal.mjs', '单字问句账：一个汉字切不出词也不许说「没有」（keywords 也认、停用词不开口、定序不看插入顺序、挖掉兜底即红）'],
  ['tools/probe-dirty.mjs', '脏记忆账：一条缺 keywords / 一条 null 行都不许把整次检索打成异常（逗号串也当词表、坏元素不凭空命中、挖掉归一化或入口闸即红）'],
  ['tools/probe-monotone.mjs', '单调式账：版本 / 支数 / 断言总数 / 耗时预算这类会随时间前进的量，只许写成单调式（地板只抬不降、历史里程碑保留自己那版的数字、扫描器能红）'],
  ['tools/probe-rigor.mjs', '量尺账：连跑 3 次 std=0、语料与问句换顺序读数逐位相同、独立 scorer 交叉验一致、注入位置偏置必红（这把尺子不许自己先抖）'],
  ['tools/probe-signature.mjs', '签名账：库没变时不许重付签名钱（按条记账、比的是值不是对象身份、就地等长改写与改 keywords 元素都要变、脏形状走直算、记账后快 5 倍以上、只按身份记账的坏实现必红）'],
  ['tools/probe-verbatim.mjs', '原样匹配账：库没变时不许重拼 haystack（懒建+随索引缓存、改正文/project/keywords 都要跟着变、与现拼口径逐位等价、无标识符问句一条不建、只按条数缓存必红）'],
  ['tools/probe-order.mjs', '定序账：只排前 k 不许改任何一名的顺序（与全量排序逐位对拍、截断长度、档位同步、k<=0 退回全序、并列按 id 自然序、指认档恒 -1、换序不变、丢档位筛选必红）'],
  ['tools/probe-hotpath.mjs', '热路账：回执对象不许先挂后摘（不再用 delete、平行数组不跨查询残留、原样补分/层级意图/断言密度只落在该落的那条上、自适应换尺子要清缓存）'],
  ['tools/probe-cover.mjs', '覆盖度账：顺倒排往回加，不再每条×每个问句词重算（两条路对拍逐位相同、覆盖度语义没变、空手问句不留 NaN、换尺子那趟先重记账）'],
  ['tools/probe-score.mjs', '打分账：顺倒排打分，不再每条×每个问句词查表（倒排记着词频与字段命中位、两条路对拍逐位相同、字段权重仍按每问参数算、换尺子那趟候选先重铺）'],
  ['tools/probe-hydrate.mjs', '水化账：扫描期只铺够定档的瘦回执，入选的 k 条截断后再水化（两条完整路对拍逐字节相同含键序、_di 不泄漏、trimmed 属性在、可选字段照旧省略）'],
  ['tools/probe-cand.mjs', '候选账：倒排下标并集不再用 Set（位图 + 首见序候选表、两处去重、与 Set 算法对拍、倒排开/关两路逐位相同、扩词那条路真的被走到）'],
  ['tools/probe-band.mjs', '定档账：阈值定档不再全量排序（桶计数排序 + 段扫、桶 0 特判、小端退路只排前 n 个、与排序链 500 组逐位相同、同桶比值 ≥ 0.85、复用缓冲不串味）'],
  ['tools/probe-sigrow.mjs', '签名账：条级哈希校验改按数组下标对齐的侧表（只在同一数组第 2 次访问才铺行、与每次新建数组那条路逐位相同、计数口径不变、八种改法必被看见、脏值不合并）'],
  ['tools/probe-docid.mjs', '身份账：检索入口每问现造的文档对象会打掉引擎的签名缓存（行按「id + 十字段指纹」复用文档对象、表按「逐引用相同」还回或就地换格、签名与现造逐字相同、脏行不炸、生产口径含 bumpHit 那轮也要快 5 倍以上）'],
  ['tools/probe-sigseal.mjs', '签章账：每问一次的整表签名校验改成「只认版本章」（稳定数组自己记内容变没变、la/importance 等非签名字段变了不重算、签名字段一变必盖章、换格不比指针、长度变化必盖章、生产口径含 bumpHit 也要快 1.4 倍以上）'],
  ['tools/probe-terms.mjs', '术语对照桥：库里的「口语＝术语」条目既当同义词源又当降权对象（五域五条全判出、18 对全挖到、真库零误伤、问事情时对照表不许抢第一、问术语时免降权、明确声明优先于统计共现、关桥换说法 hit@1 塌一半、同词池一处不动、冷域换说法 hit@1 ≥65% 钉基线）'],
  ['tools/probe-lex.mjs', '词法账：分类不再逐字符跑两条 Unicode 正则（BMP 表由那两条正则自己扫出、惰性建一次、单码点快路 + 星外退路、全 1,112,064 码点与旧正则相同、切段与语料逐串相同）'],
  ['tools/probe-cold.mjs', '冷建账：建索引不再把同一批字段切两遍（切词拆成分段 + 成词两段、字段各分段一遍单趟填 plainToks·bodyLen·titleSets、每条不再配 seen Set、分段与成词都与整串口径逐 token 相同、五张表与老表达式逐条相同）'],
  ['tools/check-client-bundle.mjs', '组合产物 11 项'],
  ['tools/probe-inject.mjs', 'nebula 常驻注入只剩稳定 RULE'],
  ['tools/check-yaml.mjs', 'profile patch 与 bundles 体检'],
  ['tools/check-market.mjs', '市场索引：宿主校验器真读一遍 + commit 是真提交'],
  ['tools/probe-load.mjs', 'DSH 自己的加载器判据说能不能加载（含装配后的条目）'],
  ['tools/probe-nebula.mjs', '星图面板层：引力换算、局部图 N 跳、标签淡出与面板接线'],
  ['tools/probe-budget.mjs', '注入预算账：默认不限与旧拼法逐位相同、设上限后九档一律不超、压缩留查询句与首句、条目头不丢、压了必自述、极小上限只给骨架、段级预算保头尾、两档省 55%/65% 钉基线'],
  ['tools/probe-floor.mjs', '命中闸门账：默认 0.45 线下弱命中被挡而强命中照旧注入、关闸逐字回到 0.6.39、被挡的条目不进 seen 也不加 hit_count（下一轮还能来）、门槛可调且方向单调、非数字回默认/负数夹成 0、回执与日志都看得见 floor 与挡了几条'],
  ['tools/probe-digest.mjs', '条内摘要账：默认 240 只压超长条目、短条目逐字不动、首句必留且与问句重合的中段句能被选出来（中文按 2-gram 切词，不再是「只留首句」）、硬信息句保底、0＝不限时逐位回到 0.6.40 且无指路行、与 injectMaxChars 叠加取较小者、坏值非数字回 240/负数夹成 0'],
  ['tools/probe-neighbor.mjs', '邻域纠错账：弱邻居（<0.35）不注入也不硬凑、强邻居与卡门槛的一条不少、尾部教 nebula_link(path→mute) 断错边、尾部不挤掉条目、minScore 调 0 弱邻居回来（阴性对照）、配置面 schema/白名单/注入器一路接上'],
  ['tools/doctor.mjs', '体检：两棵树同步 + 加载面 + 注入长度 + 队列 + 备份'],
]

const argv = process.argv.slice(2)
const flag = (name) => argv.includes(`--${name}`)
const opt = (name) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`))
  return hit === undefined ? undefined : hit.slice(name.length + 3)
}

const json = flag('json')
const verbose = flag('verbose')
const updateBaselines = flag('update-baselines')
const only = (opt('only') ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)

const steps = only.length === 0 ? STEPS : STEPS.filter(([file]) => only.some((k) => file.includes(k)))
if (steps.length === 0) {
  console.error(`没有匹配 --only=${only.join(',')} 的脚本；可选：${STEPS.map(([f]) => f).join(', ')}`)
  process.exit(2)
}

const say = (line) => (json ? process.stderr.write(`${line}\n`) : console.log(line))

/** 数一支脚本的断言条数：统一数行首 `PASS`（十支里有八支这么打，另两支只打 ALL PASS）。 */
const countPass = (text) => (text.match(/^PASS/gm) ?? []).length

const BASELINES = join(root, 'tools', 'baselines.json')
const baselines = existsSync(BASELINES) ? JSON.parse(readFileSync(BASELINES, 'utf8')) : { counts: {} }

/** 耗时预算：基线里记的数乘以宽裕系数（同一台机器不同负载会晃，卡太紧等于制造假红）。 */
const BUDGET_FACTOR = 4
/** 记账时的下限：再快的脚本也给 30s，因为一次冷启动 + 杀毒软件扫盘就可能慢十倍。 */
const MIN_BUDGET_MS = 30_000
/**
 * 完全没有预算记录的脚本（新加的、或第一次跑）给 3 分钟。
 * 这里踩过：第一版用 20s 下限，直接把自己两支慢脚本（probe-graph 49.7s、param-audit 20.6s）杀了——
 * 「不知道它多慢」的时候必须给足余量，否则第一跑就制造两条假红。
 */
const FIRST_RUN_BUDGET_MS = 180_000
/**
 * 耗时漂移的容忍倍数（0.2.20）：比基线慢到这么多就提醒。
 * 取 1.5 而不是 2：2 倍时已经吃掉一半预算余量，等到那时才说话太晚；
 * 1.5 倍在正常负载波动里偶尔会响，但响了只是 `~` 一行，成本低于漏掉一次真退化。
 */
const SLOW_FACTOR = 1.5
/** 不到 1s 的脚本不参与漂移判定：0.1s→0.2s 也是 2 倍，纯噪声。 */
const SLOW_FLOOR_MS = 1_000
const budgetFor = (base, file) => {
  const saved = base.budgetMs?.[file]
  // 写得更小也按 30s 跑：预算的意义是「别卡死」，不是「卡得越紧越好」
  if (Number.isInteger(saved) && saved > 0) return Math.max(saved, MIN_BUDGET_MS)
  const last = base.ms?.[file]
  if (Number.isInteger(last) && last > 0) return Math.max(MIN_BUDGET_MS, Math.ceil((last * BUDGET_FACTOR) / 1000) * 1000)
  return FIRST_RUN_BUDGET_MS
}

const home = mkdtempSync(join(tmpdir(), 'macro-check-all-'))
/**
 * 每一支都在这个「与自己无关的目录」里跑（0.2.27）。
 *
 * 以前这里写 `cwd: root`：看起来贴心，实际上把「脚本偷偷依赖 cwd」这件事盖住了——
 * param-audit 用 `process.cwd()` 当项目根，在 check-all 里永远是绿的，
 * 单独从别的目录跑就 ERR_MODULE_NOT_FOUND。检查器不该替被检查者补环境。
 * 现在根只有 tools/_root.mjs 一个出处，cwd 故意给一个无关的空目录：
 * 谁再偷用 cwd，这一支立刻红。
 */
const neutralCwd = mkdtempSync(join(tmpdir(), 'macro-neutral-cwd-'))
const t0 = Date.now()

/** 跑一支：预算、超时、断言条数、耗时都按传入的基线算（收敛轮会传刚写盘的新基线）。 */
const measure = (file, what, bl) => {
  const outFile = join(home, `${file.replace(/[\\/]/g, '_')}.log`)
  const fd = openSync(outFile, 'w')
  const budget = budgetFor(bl, file)
  const started = Date.now()
  const run = spawnSync(process.execPath, [join(root, file)], {
    cwd: neutralCwd,
    // 关键：不用 'pipe'（沙箱下 EPERM），把两个流都交给同一个文件 fd
    stdio: ['ignore', fd, fd],
    env: { ...process.env },
    windowsHide: true,
    // 超过预算直接杀掉：宁可给一条「超时」的红，也不要让整条验收命令停在那里
    timeout: budget,
    killSignal: 'SIGKILL',
  })
  closeSync(fd)
  const ms = Date.now() - started
  const output = readFileSync(outFile, 'utf8')
  // spawnSync 被 timeout 杀掉时 status 为 null、error.code 为 ETIMEDOUT
  const timedOut = run.error?.code === 'ETIMEDOUT' || (run.signal !== null && run.signal !== undefined)
  const failed = run.status !== 0 && !timedOut
  const pass = countPass(output)
  const base = bl.counts?.[file]
  const lastMs = bl.ms?.[file]
  // 被杀掉的那次耗时不参与漂移判定：它只是「至少这么久」，不是真实用时
  const slow =
    !timedOut && Number.isInteger(lastMs) && lastMs > 0 && ms >= SLOW_FLOOR_MS && ms > lastMs * SLOW_FACTOR
  return { file, what, ok: !failed && !timedOut, code: run.status, ms, pass, base, budget, timedOut, lastMs, slow, output }
}

/**
 * 打一支的结果行（超时、变慢、失败尾巴都在这里）。
 * 抽成函数是因为收敛轮要把刚重跑的那几支再打一遍——同一份格式，两处不许各写一套。
 */
const showStep = (r) => {
  const { file, what, ms, pass, base, budget, timedOut, lastMs, slow, output } = r
  const failed = !r.ok && !timedOut
  const mark = timedOut ? '⏱' : failed ? '✗' : '✓'
  const secs = (ms / 1000).toFixed(1)
  // 断言数变化用单独符号，避免和「这支跑挂了」混成一种红
  const drift =
    base === undefined ? (pass > 0 ? ' !' : '  ') : pass === base ? '  ' : pass < base ? ' ↓' : ' ↑'
  say(
    `${mark} ${file.padEnd(30)} ${secs.padStart(5)}s/${String(Math.round(budget / 1000)).padStart(3)}s ${String(pass).padStart(4)} 条${drift}  ${what}`,
  )
  if (timedOut)
    say(
      `    ⏱ 超过 ${Math.round(budget / 1000)}s 预算，已杀掉${
        Number.isInteger(lastMs) ? `（上次实测 ${(lastMs / 1000).toFixed(1)}s）` : '（没有上次实测，用的是首次预算）'
      }`,
    )
  if (slow)
    say(
      `    ~ 比基线慢 ${(ms / lastMs).toFixed(1)} 倍（上次 ${(lastMs / 1000).toFixed(1)}s，这次 ${secs}s）——不判红，先看是不是机器忙`,
    )
  if (failed || (timedOut && verbose) || verbose) {
    const lines = output.trimEnd().split('\n')
    const shown = failed && !verbose ? lines.slice(-16) : lines
    for (const line of shown) say(`    ${line}`)
  }
}

const results = []
for (const [file, what] of steps) {
  const r = measure(file, what, baselines)
  results.push(r)
  showStep(r)
}

let bad = results.filter((r) => !r.ok)
let regressed = results.filter((r) => r.base !== undefined && r.pass < r.base)
let grown = results.filter((r) => r.base !== undefined && r.pass > r.base)
const unreported = results.filter((r) => r.base === undefined && r.pass > 0)
const timedOutSteps = results.filter((r) => r.timedOut)
const slowSteps = results.filter((r) => r.slow)

const versionBefore = baselines.version

/** 记账：把这一轮（或收敛轮里重跑的那几支）的断言数与耗时写进基线。--only 时保留没跑到的那几支。 */
const record = (rs) => {
  const onDisk = existsSync(BASELINES) ? JSON.parse(readFileSync(BASELINES, 'utf8')) : {}
  const counts = { ...(onDisk.counts ?? {}) }
  const ms = { ...(onDisk.ms ?? {}) }
  const budgetMs = { ...(onDisk.budgetMs ?? {}) }
  const skipped = []
  for (const r of rs) {
    // 红的那一支不记账：它 FAIL 那一路会少走一段，条数比它正常时少，
    // 记进去等于把「坏状态」当新尺子（doctor 因为三棵树不同步而 FAIL 时正是这样少 1 条）。
    if (!r.ok) {
      skipped.push(r.file)
      continue
    }
    counts[r.file] = r.pass
    // 超时那次不记耗时：被杀掉的进程跑的时间只是「至少这么久」，拿来算预算会越滚越大
    if (!r.timedOut) {
      ms[r.file] = r.ms
      budgetMs[r.file] = Math.max(MIN_BUDGET_MS, Math.ceil((r.ms * BUDGET_FACTOR) / 1000) * 1000)
    }
  }
  writeFileSync(
    BASELINES,
    JSON.stringify(
      {
        note: '断言数与耗时基线：counts=每支自检脚本的 PASS 条数，ms=上次实测耗时，budgetMs=超时就杀的上限（约 4×ms，最低 30s），实际耗时超过 ms 的 1.5 倍只提醒不判红。故意增减断言、或确认某支本来就该这么慢之后，跑 node tools/check-all.mjs --update-baselines 重记。',
        generatedBy: 'tools/check-all.mjs --update-baselines',
        version,
        counts,
        ms,
        budgetMs,
      },
      null,
      2,
    ) + '\n',
    'utf8',
  )
  return { counts, ms, budgetMs, skipped }
}

/** 这一轮「数出来与手里那份基线不同」的那几支：最可能自己被基线影响（版本对不上时少走一段）。 */
const unstable = () => results.filter((r) => r.ok && r.base !== undefined && r.pass !== r.base)

if (updateBaselines) {
  const written = record(results)
  say(`基线已更新：${Object.keys(written.counts).length} 支（断言数 + 耗时预算）→ tools/baselines.json（macro-memory ${version}）`)
  if (written.skipped.length > 0)
    say(`  跳过 ${written.skipped.length} 支（这一趟是红的，条数不可信，保留旧账）：${written.skipped.join('，')}`)
  // 慢的时候记账等于把尺子改短：先把话说明白，别让它顺手发生
  if (slowSteps.length > 0)
    say(
      `  ⚠ 你正在把 ${slowSteps.length} 支「变慢了」的耗时记成新基线：${slowSteps.map((r) => r.file).join('，')}——确认是环境噪声，不是退化。`,
    )

  /*
   * 收敛轮（0.6.1 补，同一件事踩过两次：0.6.0 与 0.6.1 各多花了三趟 210s 才稳）。
   *
   * 病根：有几条断言是**基线自己先对上才会出现**的——`verify.mjs` 与 `tools/doctor.mjs` 里的
   * 「基线版本与 package.json 一致」。版本号刚升时它是 FAIL，FAIL 那一路少走一段，于是这轮数出来
   * 比绿态少 1 条；把它记进基线后版本对上了、那条断言回来了，又变成多 1。人不重跑就只看到
   * 「断言数回退 3 支」，误以为代码坏了——这正是「记账记在红态」的老坑。
   *
   * 现在：凡本次「数与基线不一致」的那几支，记完账**就地用新基线重跑**（不重跑全套），
   * 每轮记账，最多 3 轮；还晃就如实说，不假装稳定。
   */
  let rounds = 0
  for (;;) {
    const shakey = unstable()
    if (shakey.length === 0 || rounds >= 3) break
    rounds += 1
    say(`  收敛第 ${rounds} 轮：${shakey.map((r) => r.file).join('，')} 的数与基线不同，按新基线重跑这几支（有些断言要基线先对上才出现）`)
    const onDisk = existsSync(BASELINES) ? JSON.parse(readFileSync(BASELINES, 'utf8')) : {}
    const fresh = []
    for (const r of shakey) {
      const again = measure(r.file, r.what, onDisk)
      showStep(again)
      fresh.push(again)
      const i = results.findIndex((x) => x.file === again.file)
      if (i >= 0) results[i] = again
    }
    record(fresh)
  }
  const left = unstable()
  if (rounds > 0)
    say(
      left.length === 0
        ? `  已收敛（${rounds} 轮重跑）：基线与本轮实测逐支一致`
        : `  ⚠ 重跑了 ${rounds} 轮仍有 ${left.length} 支在晃（${left.map((r) => r.file).join('，')}）——先查这几支为什么时多时少`,
    )
}

// 收敛轮会换掉个别条目，报表与判决都按最终结果重算一遍（用收敛前的数去下结论是另一种假绿）
bad = results.filter((r) => !r.ok)
regressed = results.filter((r) => r.base !== undefined && r.pass < r.base)
grown = results.filter((r) => r.base !== undefined && r.pass > r.base)

try {
  rmSync(home, { recursive: true, force: true, maxRetries: 5 })
} catch {
  /* 临时目录删不掉不影响结论 */
}

const secs = ((Date.now() - t0) / 1000).toFixed(1)

const verdict = bad.length === 0 && regressed.length === 0

if (json) {
  console.log(
    JSON.stringify(
      {
        version,
        ok: verdict,
        total: results.length,
        failed: bad.map((r) => r.file),
        regressed: regressed.map((r) => ({ file: r.file, from: r.base, to: r.pass })),
        grown: grown.map((r) => ({ file: r.file, from: r.base, to: r.pass })),
        timedOut: timedOutSteps.map((r) => ({ file: r.file, budgetMs: r.budget, ms: r.ms })),
        slow: slowSteps.map((r) => ({ file: r.file, lastMs: r.lastMs, ms: r.ms, ratio: Number((r.ms / r.lastMs).toFixed(2)) })),
        seconds: Number(secs),
        steps: results.map((r) => ({
          file: r.file,
          ok: r.ok,
          code: r.code,
          ms: r.ms,
          budgetMs: r.budget,
          lastMs: r.lastMs ?? null,
          slow: r.slow,
          pass: r.pass,
          baseline: r.base ?? null,
        })),

      },
      null,
      2,
    ),
  )
} else {
  console.log('')
  if (bad.length === 0) {
    console.log(`汇总：${results.length}/${results.length} 通过（macro-memory ${version}，用时 ${secs}s）`)
  } else {
    console.log(`汇总：${results.length - bad.length}/${results.length} 通过，${bad.length} 支失败（用时 ${secs}s）`)
    for (const r of bad) console.log(`  ${r.timedOut ? '⏱' : '✗'} ${r.file}${r.timedOut ? '（超时被杀）' : `（exit=${r.code}）`}`)
  }
  const counted = results.filter((r) => r.base !== undefined).length
  if (regressed.length > 0) {
    console.log(`断言数回退 ${regressed.length} 支（基线 ${counted} 支）：`)
    for (const r of regressed) console.log(`  ↓ ${r.file}  ${r.base} → ${r.pass}（少 ${r.base - r.pass} 条）`)
    console.log('  说明：脚本仍是绿的，但断言少了——多半是某段被删/提前 return。确认是有意的再 --update-baselines。')
  } else if (counted > 0) {
    console.log(`断言数与基线一致（${counted} 支，合计 ${results.reduce((n, r) => n + (r.base ?? 0), 0)} 条）`)
  }
  if (grown.length > 0) {
    console.log(`断言数增加 ${grown.length} 支：${grown.map((r) => `${r.file} ${r.base}→${r.pass}`).join('，')}（确认后 --update-baselines）`)
  }
  if (unreported.length > 0) {
    console.log(`基线里还没记：${unreported.map((r) => r.file).join('，')}（跑 --update-baselines 记账）`)
  }
  if (timedOutSteps.length > 0) {
    console.log(`超时被杀 ${timedOutSteps.length} 支：${timedOutSteps.map((r) => `${r.file}（>${Math.round(r.budget / 1000)}s）`).join('，')}`)
    console.log('  说明：被杀掉的那支要单独跑一次看它卡在哪；确认它本来就该这么慢，再 --update-baselines 调大预算。')
  }
  if (slowSteps.length > 0) {
    console.log(
      `耗时变慢 ${slowSteps.length} 支：${slowSteps
        .map((r) => `${r.file} ${(r.lastMs / 1000).toFixed(1)}s→${(r.ms / 1000).toFixed(1)}s（${(r.ms / r.lastMs).toFixed(1)}×）`)
        .join('，')}`,
    )
    console.log('  说明：这一条不判红，退出码不受影响。先看是不是机器忙/首次跑/杀毒在扫；真的每次都慢就去查是哪一段退化，')
    console.log('        别直接 --update-baselines 把「慢」记成「正常」——那等于把尺子改短。')
  }
}

process.exit(verdict ? 0 : 1)
