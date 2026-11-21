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
  ['tools/check-client-bundle.mjs', '组合产物 11 项'],
  ['tools/probe-inject.mjs', 'nebula 常驻注入只剩稳定 RULE'],
  ['tools/check-yaml.mjs', 'profile patch 与 bundles 体检'],
  ['tools/check-market.mjs', '市场索引：宿主校验器真读一遍 + commit 是真提交'],
  ['tools/probe-load.mjs', 'DSH 自己的加载器判据说能不能加载（含装配后的条目）'],
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
const budgetFor = (file) => {
  const saved = baselines.budgetMs?.[file]
  // 写得更小也按 30s 跑：预算的意义是「别卡死」，不是「卡得越紧越好」
  if (Number.isInteger(saved) && saved > 0) return Math.max(saved, MIN_BUDGET_MS)
  const last = baselines.ms?.[file]
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
const results = []
const t0 = Date.now()

for (const [file, what] of steps) {
  const outFile = join(home, `${file.replace(/[\\/]/g, '_')}.log`)
  const fd = openSync(outFile, 'w')
  const budget = budgetFor(file)
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
  const base = baselines.counts?.[file]
  const lastMs = baselines.ms?.[file]
  // 被杀掉的那次耗时不参与漂移判定：它只是「至少这么久」，不是真实用时
  const slow =
    !timedOut && Number.isInteger(lastMs) && lastMs > 0 && ms >= SLOW_FLOOR_MS && ms > lastMs * SLOW_FACTOR
  results.push({ file, what, ok: !failed && !timedOut, code: run.status, ms, pass, base, budget, timedOut, lastMs, slow, output })

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
        Number.isInteger(baselines.ms?.[file]) ? `（上次实测 ${(baselines.ms[file] / 1000).toFixed(1)}s）` : '（没有上次实测，用的是首次预算）'
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

const bad = results.filter((r) => !r.ok)
const regressed = results.filter((r) => r.base !== undefined && r.pass < r.base)
const grown = results.filter((r) => r.base !== undefined && r.pass > r.base)
const unreported = results.filter((r) => r.base === undefined && r.pass > 0)
const timedOutSteps = results.filter((r) => r.timedOut)
const slowSteps = results.filter((r) => r.slow)

if (updateBaselines) {
  // --only 时保留没跑到的那几支：半次运行不该把基线写残
  const counts = { ...(baselines.counts ?? {}) }
  const ms = { ...(baselines.ms ?? {}) }
  const budgetMs = { ...(baselines.budgetMs ?? {}) }
  for (const r of results) {
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
  say(`基线已更新：${Object.keys(counts).length} 支（断言数 + 耗时预算）→ tools/baselines.json（macro-memory ${version}）`)
  // 慢的时候记账等于把尺子改短：先把话说明白，别让它顺手发生
  if (slowSteps.length > 0)
    say(
      `  ⚠ 你正在把 ${slowSteps.length} 支「变慢了」的耗时记成新基线：${slowSteps.map((r) => r.file).join('，')}——确认是环境噪声，不是退化。`,
    )
}

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
