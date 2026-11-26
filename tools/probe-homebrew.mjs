/**
 * 验收：Homebrew tap（PLAN-UNIVERSAL §11.4 / P2-5）。
 *
 * 检的是「`brew install` 完能不能跑」，以及「formula 里的哈希有没有人抄错」：
 *   H1  formula 在位，class / desc / homepage / license 齐全
 *   H2  四个平台块都在（mac / linux × arm64 / x64），每块都有 url 与 sha256
 *   H3  formula 的 version 就是根 package.json 的版本（不许手填）
 *   H4  不拖 Node：没有 `depends_on "node"`，url 指向 Releases 里的单文件产物
 *   H5  `test do` 里有 `--version` 与 `--help`（brew audit 要求 formula 能自测）
 *   H6  产物名与 tools/build-sea.mjs 的 --target 同名（改一边不改另一边会红）
 *   H7  owner/repo 跟随 package.json（P2-3 改名之后 formula 也得跟着走）
 *   H8  生成器有 --apply 门、不发包、缺产物时保留占位而不是填猜的哈希
 *   H9  **真跑生成器**：喂它一份四个平台的假 SHA256SUMS，四个哈希都进了报告
 *   H10 不带 --sums 跑是只读的：formula 字节不变，且明说「体检模式」
 *   H11 README 里有那条 brew 安装命令（用户得找得到）
 *
 * 全部在临时目录里做，不写 formula、不碰真实库。
 * 用法：node tools/probe-homebrew.mjs
 */
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { root } from './_root.mjs'

let pass = 0
let fail = 0
function check(name, cond, detail = '') {
  if (cond) {
    pass += 1
    console.log(`PASS  ${name}  ${detail}`)
  } else {
    fail += 1
    console.log(`FAIL  ${name}  ${detail}`)
  }
}

const FORMULA = join(root, 'packaging', 'homebrew', 'macro-memory.rb')
const GEN = join(root, 'tools', 'gen-formula.mjs')
const BUILD_SEA = join(root, 'tools', 'build-sea.mjs')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const TARGETS = ['mac-arm64', 'mac-x64', 'linux-arm64', 'linux-x64']

const src = existsSync(FORMULA) ? readFileSync(FORMULA, 'utf8') : ''
const genSrc = existsSync(GEN) ? readFileSync(GEN, 'utf8') : ''
/** formula 去掉注释行后的正文——注释里举反例（「为什么不 depends_on node」）不算声明。 */
const body = src
  .split('\n')
  .filter((l) => !l.trimStart().startsWith('#'))
  .join('\n')

// H1 位置与元数据
check(
  'H1 formula 在位，class / desc / homepage / license 齐',
  /class MacroMemory < Formula/.test(src) &&
    /^\s+desc\s+"/m.test(src) &&
    /^\s+homepage\s+"https:\/\/github\.com\//m.test(src) &&
    /^\s+license\s+"MIT"/m.test(src),
  `packaging/homebrew/macro-memory.rb  ${src.length} B`
)

// H2 四个平台块
const blocks = TARGETS.map((t) => {
  const re = new RegExp(
    `url "https://github\\.com/[^"]+/releases/download/v#\\{version\\}/macro-memory-${t}"\\s*\\r?\\n\\s*sha256 "([^"]+)"`
  )
  return { target: t, hit: re.exec(src) }
})
const blocksOk = blocks.every((b) => b.hit)
check(
  'H2 四个平台块都在，每块都有 url 与 sha256',
  blocksOk && /on_macos do/.test(src) && /on_intel do/.test(src) && /on_arm do/.test(src) && /on_linux do/.test(src),
  blocksOk ? 'mac-arm64 / mac-x64 / linux-arm64 / linux-x64' : '缺：' + blocks.filter((b) => !b.hit).map((b) => b.target).join(', ')
)

// H3 版本跟随根 package.json
const verHit = /^\s+version\s+"([^"]*)"/m.exec(src)
check(
  'H3 formula 的 version 就是根 package.json 的版本',
  verHit?.[1] === pkg.version,
  `formula ${verHit?.[1] ?? '(没有)'} · 根 ${pkg.version}`
)

// H4 不拖 Node
const noNodeDep = !/depends_on\s+["']node["']/.test(body)
check(
  'H4 不拖 Node：正文里没有 depends_on "node"，装的是单文件产物',
  noNodeDep && /releases\/download/.test(src),
  noNodeDep ? '用户装完就有 macro-memory，机器上不必先有 Node' : '正文里出现了 depends_on "node"'
)

// H5 test do 能自测
const testBlock = /test do([\s\S]*?)\n\s+end/.exec(src)?.[1] ?? ''
check(
  'H5 test do 里有 --version 与 --help（brew audit 要 formula 能自测）',
  testBlock.includes('--version') && testBlock.includes('--help'),
  testBlock ? `${testBlock.trim().split('\n').length} 行` : '没有 test do'
)

// H6 产物名与 build-sea 的 --target 同名（formula 只管 mac/linux，build-sea 多出 Windows 不算错）
const seaSrc = existsSync(BUILD_SEA) ? readFileSync(BUILD_SEA, 'utf8') : ''
const seaTargets = [...seaSrc.matchAll(/'(mac|linux|win)-(arm64|x64)':/g)].map((m) => `${m[1]}-${m[2]}`)
const notInSea = TARGETS.filter((t) => !seaTargets.includes(t))
const winTargets = seaTargets.filter((t) => t.startsWith('win-'))
check(
  'H6 formula 的四个平台都被 build-sea 认（build-sea 多出的 Windows 那两份 brew 不管）',
  seaTargets.length > 0 && notInSea.length === 0 && winTargets.length === 2,
  `build-sea ${seaTargets.length} 个 target（含 win ${winTargets.length}）· formula ${TARGETS.length} 个`
)

// H7 owner/repo 跟随 package.json
const repoUrl = String(pkg.repository?.url ?? pkg.homepage ?? '')
const m = repoUrl.match(/github\.com[/:]([^/]+)\/([^/.]+)/)
const want = m ? `${m[1]}/${m[2]}` : null
const inFormula = [...new Set([...src.matchAll(/github\.com\/([^/]+)\/([^/"]+)/g)].map((x) => `${x[1]}/${x[2]}`))]
check(
  'H7 formula 的 owner/repo 跟随 package.json（改名那天不会漏掉这一份）',
  want !== null && inFormula.length > 0 && inFormula.every((p) => p === want),
  `package.json ${want} · formula ${inFormula.join(', ') || '(没有)'}`
)

// H8 生成器纪律
check(
  'H8 生成器：--apply 才写、不发包、缺产物时保留占位不填猜的哈希',
  /flag\('apply'\)/.test(genSrc) &&
    !/npm\s+publish|spawnSync\([^)]*publish/.test(genSrc) &&
    /if \(!sha\) \{/.test(genSrc) &&
    /占位/.test(genSrc),
  `${genSrc.split('\n').length} 行`
)

// H9 真跑生成器：喂四个平台的假 SHA256SUMS
const tmp = mkdtempSync(join(tmpdir(), 'macro-brew-'))
const fake = TARGETS.map((t, i) => `${String(i + 1).repeat(64).slice(0, 64)}  macro-memory-${t}`).join('\n') + '\n'
writeFileSync(join(tmp, 'SHA256SUMS.txt'), fake, 'utf8')
const run = spawnSync(process.execPath, [GEN, '--sums', tmp], { cwd: root, encoding: 'utf8', timeout: 60_000 })
const out = `${run.stdout ?? ''}${run.stderr ?? ''}`
const allSeen = TARGETS.every((t) => {
  const sha = (String(TARGETS.indexOf(t) + 1).repeat(64)).slice(0, 16)
  return out.includes(t) && out.includes(sha)
})
check(
  'H9 真跑生成器：四个平台的哈希都灌进了报告（不是只认第一个）',
  run.status === 0 && allSeen,
  run.status === 0 ? '喂了 4 行假 sha，报告里 4 个都出现' : `exit=${run.status} ${out.slice(0, 160)}`
)

// H10 不带 --sums 跑是只读的
const before = readFileSync(FORMULA, 'utf8')
const run2 = spawnSync(process.execPath, [GEN], { cwd: root, encoding: 'utf8', timeout: 60_000 })
const after = readFileSync(FORMULA, 'utf8')
check(
  'H10 不带 --apply 只读：formula 一个字节都没动，且明说体检模式',
  run2.status === 0 && before === after && /体检模式/.test(String(run2.stdout)),
  before === after ? '字节未变' : '被写了'
)

// H11 README 里找得到那条命令
const readme = readFileSync(join(root, 'README.md'), 'utf8')
check(
  'H11 README 里有那条 brew 安装命令',
  /brew install \S+\/tap\/macro-memory/.test(readme) && /npx -y macro-memory mcp/.test(readme),
  '用户视角：三条路都写在同一张表里'
)

console.log('')
if (fail === 0) {
  console.log(`ALL PASS  probe-homebrew：${pass}/${pass}`)
  process.exit(0)
}
console.log(`FAILED  probe-homebrew：${pass} PASS / ${fail} FAIL`)
process.exit(1)
