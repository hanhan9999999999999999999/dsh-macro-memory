/**
 * probe-tools.mjs —— tools/ 自己的账本探测器（0.2.83）
 *
 * 为什么需要它：`tools/probe-toolsize.mjs` 和 `tools/cost-baseline.mjs` 都写着
 * `readFileSync(root + ...)`，而 `root` 从来没被导入过——两个脚本各自躺了两个月，
 * 一次都没跑过，`node --check` 也看不出问题（语法合法，错在运行期自由变量）。
 * 这不是「手滑一次」，是一整类：**没被任何东西执行的脚本会烂，而且烂得很安静**。
 *
 * 所以这里不修具体某个脚本，而是装一个探测器，盯三件事：
 *   1. 归类：tools/ 下每个脚本必须是「进 check-all」「被别的脚本 import」「在 manual-tools.mjs 登记」之一，
 *      三者都不是 → 红（新写的脚本再也不能悄悄变成幽灵）。
 *   2. 自由变量：`_root.mjs` 导出的名字（root / vendorDir / at）若在某脚本里被用到却没在导入清单里，
 *      → 红。这类错误就是把上面两个脚本写死的那个错，直接判它。
 *   3. 冒烟：manual-tools.mjs 里标了 `smoke: true` 的只读脚本真跑一遍，非零退出 → 红。
 *      「只读」是可执行承诺，不是文档里的一句话。
 *
 * 它自己也在 check-all 里，所以这套判据自己不会烂。
 *
 * [macro-fusion 0.2.83] 新增：工具账本探测器（归类 / 自由变量 / 冒烟）+ 阴性对照。
 * 同轮把 tools/cost-baseline.mjs 的裸 root 一并修掉——那是同一个错第二例。
 */
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { root } from './_root.mjs'
import { MANUAL_TOOLS } from './manual-tools.mjs'

let failures = 0
function ok(cond, label, detail) {
  if (!cond) failures++
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + label + (detail ? '  ' + detail : ''))
}

const TOOLS_DIR = join(root, 'tools')
const files = readdirSync(TOOLS_DIR)
  .filter((f) => f.endsWith('.mjs'))
  .sort()
  .map((f) => 'tools/' + f)

const read = (rel) => readFileSync(join(root, rel), 'utf8')
const checkAllSrc = read('tools/check-all.mjs')
const verifySrc = read('verify.mjs')

// ── 1. 归类 ────────────────────────────────────────────────────────────────
const orchestrated = new Set([...checkAllSrc.matchAll(/'tools\/([A-Za-z0-9_.-]+\.mjs)'/g)].map((m) => 'tools/' + m[1]))
const manual = new Map(MANUAL_TOOLS.map((m) => [m.file, m]))

const importedBy = new Map()
const sources = new Map(files.map((f) => [f, read(f)]))
sources.set('verify.mjs', verifySrc)
for (const [f, src] of sources) {
  const add = (dep) => importedBy.set(dep, [...(importedBy.get(dep) ?? []), f])
  for (const m of src.matchAll(/from '\.\/([A-Za-z0-9_.-]+\.mjs)'/g)) add('tools/' + m[1])
  for (const m of src.matchAll(/import\('\.\/([A-Za-z0-9_.-]+\.mjs)'\)/g)) add('tools/' + m[1])
  for (const m of src.matchAll(/join\([^)]{0,40}'tools', '([A-Za-z0-9_.-]+\.mjs)'\)/g)) add('tools/' + m[1])
}

const unclassified = files.filter((f) => !orchestrated.has(f) && !importedBy.has(f) && !manual.has(f))
ok(
  unclassified.length === 0,
  '归类：tools/ 下每个脚本都有归属（check-all / 被 import / 手动账本）',
  unclassified.length ? '未归类: ' + unclassified.join(', ') : files.length + ' 个脚本全归类',
)

const ghostEntries = [...manual.keys()].filter((f) => !existsSync(join(root, f)))
ok(ghostEntries.length === 0, '账本：登记的手动脚本都真实存在', ghostEntries.length ? '缺文件: ' + ghostEntries.join(', ') : manual.size + ' 条')

const lyingEntries = [...manual.keys()].filter((f) => orchestrated.has(f))
ok(lyingEntries.length === 0, '账本：登记为「手动」的不许同时在 check-all 里跑', lyingEntries.length ? '两边都有: ' + lyingEntries.join(', ') : '无重叠')

const thinWhy = MANUAL_TOOLS.filter((m) => typeof m.why !== 'string' || [...m.why].length < 12)
ok(thinWhy.length === 0, '账本：每条手动脚本都写了为什么不能自动跑', thinWhy.length ? '太短: ' + thinWhy.map((m) => m.file).join(', ') : manual.size + '/' + manual.size)

const unmarkedSmokeFalse = MANUAL_TOOLS.filter((m) => m.smoke !== true && m.smoke !== false)
ok(unmarkedSmokeFalse.length === 0, '账本：smoke 只能是 true / false（默认不许是「没说」）', unmarkedSmokeFalse.length ? unmarkedSmokeFalse.map((m) => m.file).join(', ') : 'ok')

// ── 2. 语法：全部 node --check ─────────────────────────────────────────────
const syntaxBad = []
for (const f of files) {
  const r = spawnSync(process.execPath, ['--check', join(root, f)], { encoding: 'utf8', timeout: 20000 })
  if (r.status !== 0) syntaxBad.push(f + ': ' + (r.stderr || '').split('\n').find((l) => l.trim()) ?? '')
}
ok(syntaxBad.length === 0, '语法：tools/ 下每个脚本 node --check 过', syntaxBad.length ? syntaxBad.join(' | ') : files.length + '/' + files.length)

// ── 3. 自由变量：_root.mjs 的导出，用了就必须 import ───────────────────────
const rootMod = read('tools/_root.mjs')
const rootExports = [
  ...rootMod.matchAll(/export (?:const|function|class) ([A-Za-z0-9_$]+)/g),
].map((m) => m[1])

/**
 * 把「非代码」全部涂成空格：注释、'…'、"…"、`…` 的字面量部分（`${…}` 里还是代码，保留）。
 * 为什么要这么费劲：第一版只剥注释，于是 `what: '…改取 _root.mjs 的 vendorDir…'` 这种
 * 描述性字符串被判成「用了 vendorDir 却没导入」，而 `const at = hay.indexOf(…)` 这种
 * 自有同名局部变量又被判成「白用 at」。假红比漏红更坏——它教人忽略探测器。
 */
function maskNonCode(src) {
  let out = ''
  let i = 0
  const n = src.length
  while (i < n) {
    const ch = src[i]
    if (ch === '/' && src[i + 1] === '/') {
      while (i < n && src[i] !== '\n') { out += ' '; i++ }
      continue
    }
    if (ch === '/' && src[i + 1] === '*') {
      out += '  '; i += 2
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { out += ' '; i++ }
      if (i < n) { out += '  '; i += 2 }
      continue
    }
    if (ch === "'" || ch === '"') {
      const q = ch
      out += ' '; i++
      while (i < n && src[i] !== q) {
        if (src[i] === '\\') { out += ' '; i++ }
        if (i < n) { out += ' '; i++ }
      }
      out += ' '; i++
      continue
    }
    if (ch === '`') {
      out += ' '; i++
      while (i < n && src[i] !== '`') {
        if (src[i] === '\\') { out += '  '; i += 2; continue }
        if (src[i] === '$' && src[i + 1] === '{') {
          out += '${'; i += 2
          let depth = 1
          while (i < n && depth > 0) {
            if (src[i] === '{') depth++
            else if (src[i] === '}') depth--
            out += src[i]; i++
          }
          continue
        }
        out += ' '; i++
      }
      out += ' '; i++
      continue
    }
    out += ch; i++
  }
  return out
}

/**
 * 判一件真事：这段源码用了 `_root.mjs` 的哪个导出却没导入。
 * 单独抽成函数，是为了能拿「已知写坏的片段」反过来验它自己（见下面的阴性对照）——
 * 探测器最大的风险不是漏判，是「判了但从来没人验它判得对」。
 *
 * [0.2.113 记一笔] 这个探测器是单遍状态机，认不出正则字面量：`/…'…/` 里的引号会把后面的
 * 引号奇偶带反，于是 `what: "…"` 里的长描述可能被当成代码。踩到的形状是描述里写了
 * `{ name, at: f + 1 }`，于是被判「用了 at 却没 import」。补丁说明里别把 `_root.mjs` 的
 * 导出名（root / vendorDir / at）当裸词写进去，就绕开了；真要修状态机，得先能分清正则与除号，
 * 改错一次就是漏判（更坏），所以这次只记一笔不改。
 */
function findFreeVars(raw) {
  const importMatch = raw.match(/import \{([^}]*)\} from '\.\/_root\.mjs'/)
  const code = maskNonCode(raw)
  const imported = new Set(
    (importMatch?.[1] ?? '')
      .split(',')
      .map((s) => s.trim().split(/\s+as\s+/).pop())
      .filter(Boolean),
  )
  const bad = []
  for (const name of rootExports) {
    if (!new RegExp('(?<![\\w.$])' + name + '\\b').test(code)) continue
    if (imported.has(name)) continue
    // 自己声明过同名局部变量（`const at = …`）不算白用
    if (new RegExp('(?:const|let|var|function|class)\\s+' + name + '\\b').test(code)) continue
    bad.push(name)
  }
  return bad
}

const freeVarBad = []
for (const f of files) {
  if (f === 'tools/_root.mjs') continue // 它就是定义处
  for (const name of findFreeVars(sources.get(f))) freeVarBad.push(f + ' 用了 ' + name + ' 但没导入')
}
ok(
  freeVarBad.length === 0,
  '自由变量：_root.mjs 的导出（' + rootExports.join('/') + '）用了就必须 import',
  freeVarBad.length ? freeVarBad.join(' | ') : files.length + ' 个脚本都干净',
)

// ── 4. 阴性对照：拿已知写坏的片段验探测器自己 ──────────────────────────────
ok(findFreeVars("const a = readFileSync(root + '/x', 'utf8')").includes('root'), '对照：裸用 root 会被抓（就是 probe-toolsize / cost-baseline 那个错）', 'caught')
ok(findFreeVars("import { vendorDir } from './_root.mjs'\nconst a = root + '/x'").includes('root'), '对照：只导入了别的名字也算白用', 'caught')
ok(findFreeVars("import { root } from './_root.mjs'\nconst a = root + '/x'").length === 0, '对照：正常导入不误报', 'clean')
ok(findFreeVars("const at = hay.indexOf(x)\nwhile (at !== -1) at++").length === 0, '对照：自有同名局部变量不误报（wire-profile 的 at）', 'clean')
ok(findFreeVars("const s = 'root vendorDir at'\nconsole.log(s)").length === 0, '对照：字符串里的名字不误报（doctor 的 what 文案）', 'clean')
ok(findFreeVars('const s = `x ${root} y`').includes('root'), '对照：模板字面量里的插值按代码算', 'caught')

const classify = (name) =>
  orchestrated.has(name) ? 'step' : manual.has(name) ? 'manual' : importedBy.has(name) ? 'import' : 'orphan'
ok(classify('tools/__nope__.mjs') === 'orphan', '对照：不存在的脚本归为 orphan', classify('tools/__nope__.mjs'))
ok(classify('tools/probe-tools.mjs') === 'step', '对照：本探针归为 step', classify('tools/probe-tools.mjs'))
ok(classify('tools/manual-tools.mjs') === 'import', '对照：账本自己是库（被探索器 import），不需要单独归类', classify('tools/manual-tools.mjs'))


// ── 4. 冒烟：只读手动脚本真跑一遍 ──────────────────────────────────────────
const smokeList = MANUAL_TOOLS.filter((m) => m.smoke === true)
const smokeBad = []
for (const m of smokeList) {
  if (!existsSync(join(root, m.file))) continue
  const r = spawnSync(process.execPath, [join(root, m.file), ...(m.args ?? [])], {
    cwd: root,
    encoding: 'utf8',
    timeout: 30000,
  })
  if (r.status !== 0) {
    const tail = (r.stderr || '').split('\n').filter((l) => l.trim()).slice(0, 2).join(' / ')
    smokeBad.push(m.file + ' exit=' + String(r.status) + (tail ? ' ' + tail : ''))
  }
}
ok(
  smokeBad.length === 0,
  '冒烟：标了 smoke 的只读脚本都能真跑起来',
  smokeBad.length ? smokeBad.join(' | ') : smokeList.length + '/' + smokeList.length + ' 个退出码 0',
)

// ── 5. 账本自身别忘登记（探针、账本必须被编排）─────────────────────────────
ok(orchestrated.has('tools/probe-tools.mjs'), '自指：这个探针自己在 check-all 的 STEPS 里', orchestrated.has('tools/probe-tools.mjs') ? 'ok' : '没有')
ok(importedBy.has('tools/manual-tools.mjs'), '自指：账本被探针 import', (importedBy.get('tools/manual-tools.mjs') ?? []).join(',') || '没人 import')
ok(statSync(join(root, 'tools/manual-tools.mjs')).size > 0, '自指：账本不是空文件', String(statSync(join(root, 'tools/manual-tools.mjs')).size) + ' B')

console.log('\n归类：' + files.length + ' 个脚本 = check-all ' + orchestrated.size + ' + 手动账本 ' + manual.size + ' + 仅被 import ' + files.filter((f) => !orchestrated.has(f) && !manual.has(f) && importedBy.has(f)).length)
console.log(failures === 0 ? 'ALL PASS' : 'FAILURES: ' + failures)
if (failures !== 0) process.exitCode = 1
