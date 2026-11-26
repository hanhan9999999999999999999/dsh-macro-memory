/**
 * 验收：CI 矩阵（PLAN-UNIVERSAL §16 / P2-6）。
 *
 * 检的是「三平台全绿才发版」这条纪律有没有落在文件里，而不是落在口头：
 *   C1  两个 workflow 在位（ci.yml / release.yml）
 *   C2  矩阵是三个平台 × Node 主版本，且那个版本满足 package.json 的 engines
 *   C3  每个 job 都有 timeout-minutes；测试 job 有 checkout 与 setup-node
 *   C4  ci.yml 里没有 publish——发版只在 release.yml，且由 tag 触发
 *   C5  ci.yml 可被复用（workflow_call），release 才能等它跑完
 *   C6  没有 continue-on-error（不掩盖失败）；mac 上的 SEA 用 runner.os 守卫，不是「忽略失败」
 *   C7  release.yml：tag 只有 v*、publish 依赖 test、复用的就是 ci.yml
 *   C8  release.yml：tag 与 package.json 版本必须同号（先判再发）
 *   C9  release.yml：凭据只从 secrets 取，没有凭据时明说「这次不发」而不是静默成功
 *   C10 release.yml：两个 npm 包都发（同一份代码的两个名字）+ Release 附件带 SHA256SUMS
 *   C11 失败时把日志带走（upload-artifact + if: failure()）
 *   C12 旧仓库名仍能解析（改名后 301；这条是 PLAN §16 第 2 条要求的）
 *   C13 ci.yml 的 --only 名单里每个名字都能在 check-all 的 STEPS 里找到（改名后不许静默跑空集）
 *   C14 YAML 形状：没有 tab、没有行尾空格、缩进是 2 的倍数
 *
 * 诚实说明：这一支是**静态判据**——它证「文件里该有的都在」，证不了「GitHub 上跑得过」。
 * 第一次 push 之后的真实运行记录才算数（与 build-sea 那次同样的教训：静态判据证材料对）。
 *
 * 用法：node tools/probe-ci.mjs
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
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

const CI_PATH = join(root, '.github', 'workflows', 'ci.yml')
const REL_PATH = join(root, '.github', 'workflows', 'release.yml')
const ci = existsSync(CI_PATH) ? readFileSync(CI_PATH, 'utf8') : ''
const rel = existsSync(REL_PATH) ? readFileSync(REL_PATH, 'utf8') : ''
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const checkAllSrc = readFileSync(join(root, 'tools', 'check-all.mjs'), 'utf8')

// C1
check(
  'C1 两个 workflow 在位',
  ci.length > 0 && rel.length > 0,
  `ci.yml ${ci.length} B · release.yml ${rel.length} B`
)

// C2 矩阵与 engines 对齐
const osList = (ci.match(/^\s+os:\s*\[([^\]]*)\]/m)?.[1] ?? '').split(',').map((s) => s.trim()).filter(Boolean)
const nodeList = (ci.match(/^\s+node:\s*\[([^\]]*)\]/m)?.[1] ?? '').split(',').map((s) => s.trim().replace(/['"]/g, '')).filter(Boolean)
const engineMin = Number((String(pkg.engines?.node ?? '').match(/(\d+)/) ?? [])[1] ?? 0)
const nodeOkEverywhere = nodeList.length > 0 && nodeList.every((v) => Number(v.split('.')[0]) >= engineMin)
const platOk = ['windows', 'macos', 'ubuntu'].every((k) => osList.some((o) => o.toLowerCase().startsWith(k)))
check(
  'C2 矩阵是三个平台 × Node 主版本，且满足 engines',
  platOk && nodeOkEverywhere,
  `os ${osList.join('/')} · node ${nodeList.join('/')} · engines ${pkg.engines?.node}`
)

// C3 超时与基本步骤（复用别人的 job 不能设 timeout，只要求「有 steps 的 job 都设了」）
function jobsOf(text) {
  const seg = text.split(/^jobs:\s*$/m)[1] ?? ''
  const out = []
  let cur = null
  for (const line of seg.split('\n')) {
    const m = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line)
    if (m) {
      cur = { name: m[1], lines: [] }
      out.push(cur)
      continue
    }
    if (cur) cur.lines.push(line)
  }
  return out.map((j) => ({ name: j.name, body: j.lines.join('\n') }))
}
const allJobs = jobsOf(ci).concat(jobsOf(rel))
const withSteps = allJobs.filter((j) => /\n\s+steps:/.test('\n' + j.body))
const missingTimeout = withSteps.filter((j) => !/timeout-minutes:\s*\d+/.test(j.body)).map((j) => j.name)
check(
  'C3 有 steps 的 job 都设了 timeout-minutes；测试 job 有 checkout 与 setup-node',
  withSteps.length >= 2 && missingTimeout.length === 0 && /uses: actions\/checkout@/.test(ci) && /uses: actions\/setup-node@/.test(ci),
  `${allJobs.length} 个 job（${withSteps.length} 个带 steps）${missingTimeout.length ? '，缺 timeout：' + missingTimeout.join(', ') : ''}`
)

// C4 CI 里不发版
check(
  'C4 ci.yml 里没有 publish（发版只在 release.yml，且由 tag 触发）',
  !/npm\s+publish/.test(ci) && /tags:\s*\['v\*'\]/.test(rel) && /npm\s+publish/.test(rel),
  'ci 只验，release 才发'
)

// C5 可被复用
check(
  'C5 ci.yml 可被复用（workflow_call），release 才能等它跑完',
  /workflow_call:/.test(ci) && /uses:\s*\.\/\.github\/workflows\/ci\.yml/.test(rel),
  'release 的 test job 就是这一份'
)

// C6 不掩盖失败
const noContinueOnError = !/continue-on-error/.test(ci) && !/continue-on-error/.test(rel)
const macGuard = /if:\s*runner\.os\s*!=\s*'macOS'/.test(ci)
check(
  'C6 没有 continue-on-error；mac 上的 SEA 用 runner.os 守卫',
  noContinueOnError && macGuard,
  noContinueOnError ? '没有「忽略失败」的开关' : '出现了 continue-on-error'
)

// C7 release 结构
check(
  'C7 release.yml：publish 依赖 test（全绿才发版）',
  /needs:\s*\[test\]/.test(rel) && /^ {2}test:\s*$/m.test(rel) && /^ {2}publish:\s*$/m.test(rel),
  'needs: [test]'
)

// C8 tag 与版本同号
check(
  'C8 release.yml：tag 与 package.json 版本必须同号，先判再发',
  /GITHUB_REF_NAME#v/.test(rel) && /require\('\.\/package\.json'\)\.version/.test(rel) && /test "\$tag" = "\$ver"/.test(rel),
  '改版本再打 tag'
)

// C9 凭据只在 secrets，没有就不发
check(
  'C9 凭据只从 secrets 取；没有凭据时明说「这次不发」而不是静默成功',
  /NODE_AUTH_TOKEN:\s*\$\{\{\s*secrets\.NPM_TOKEN\s*\}\}/.test(rel) &&
    /if \[ -z "\$\{NODE_AUTH_TOKEN:-\}" \]/.test(rel) &&
    /这次不发 npm/.test(rel),
  '不猜、不静默、不假装发过'
)

// C10 两包 + Release 附件
check(
  'C10 两个 npm 包都发，Release 附件带 SHA256SUMS',
  /build-dual\.mjs --apply --pack/.test(rel) && /for tgz in/.test(rel) && /gh release create|gh release upload/.test(rel) && /SHA256SUMS\.txt/.test(rel),
  '两个名字 + 每个平台一份产物'
)

// C11 失败日志
check(
  'C11 失败时把日志带走（upload-artifact + if: failure()）',
  /uses: actions\/upload-artifact@/.test(ci) && /if:\s*failure\(\)/.test(ci),
  '否则 runner 一销毁就只剩一行红'
)

// C12 旧名 URL
check(
  'C12 旧仓库名仍能解析（改名后 301，链接不许 404）',
  /github\.com\/[^\s"']+\/macro-memory/.test(ci) && /200\|301\|302/.test(ci),
  'PLAN §16 第 2 条'
)

// C13 --only 名单与 check-all 的 STEPS 对得上
const onlyList = (ci.match(/--only=([^\s\\]+)/)?.[1] ?? '').split(',').filter(Boolean)
const knownSteps = [...checkAllSrc.matchAll(/'tools\/([A-Za-z0-9_.-]+\.mjs)'/g)].map((m) => m[1])
const unknown = onlyList.filter((n) => !knownSteps.some((f) => f.includes(n)))
check(
  'C13 ci.yml 的 --only 名单每个名字都能在 check-all 的 STEPS 里找到',
  onlyList.length >= 5 && unknown.length === 0,
  `${onlyList.length} 个名字${unknown.length ? '，认不出：' + unknown.join(', ') : '，全部对得上'}`
)

// C14 YAML 形状
const shape = []
for (const [file, text] of [['ci.yml', ci], ['release.yml', rel]]) {
  text.split('\n').forEach((line, i) => {
    if (/\t/.test(line)) shape.push(`${file}:${i + 1} 有 tab`)
    if (/\s+$/.test(line) && line.trim() !== '') shape.push(`${file}:${i + 1} 行尾有空格`)
    const indent = line.length - line.trimStart().length
    if (line.trim() !== '' && indent % 2 !== 0) shape.push(`${file}:${i + 1} 缩进 ${indent} 不是 2 的倍数`)
  })
}
check('C14 YAML 形状：没有 tab、没有行尾空格、缩进是 2 的倍数', shape.length === 0, shape.slice(0, 3).join(' · ') || '干净')

console.log('')
if (fail === 0) {
  console.log(`ALL PASS  probe-ci：${pass}/${pass}`)
  console.log('注：这是静态判据，第一次 push 之后的真实运行记录才算数。')
  process.exit(0)
}
console.log(`FAILED  probe-ci：${pass} PASS / ${fail} FAIL`)
process.exit(1)
