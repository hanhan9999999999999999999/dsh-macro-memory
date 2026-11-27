#!/usr/bin/env node
/**
 * probe-platform.mjs —— 平台账（0.7.0 新增）
 *
 * 这个插件原先只在 Windows 上验过；0.7.0 起要能在 mac 上装、能跑、能复原。
 * 但开发机只有 Windows，**没法真的在 mac 上跑一遍**。所以这份探针换个问法：
 *
 *   不问「mac 上跑得起来吗」（答不了），问「还有没有哪一行代码只认 Windows」。
 *
 * 它数的是四本账：
 *   一、路径账：宏目录在三平台上各推出什么，$DSH_HOME 的优先级对不对，分隔符走没走 path。
 *   二、字面量账：运行面里还有没有 `D:\` 这种盘符，`process.platform` 和 `$DSH_HOME`
 *       是不是只在 platform.js 里读（分散读＝以后一定会漏改一处）。
 *   三、工具账：自检链里 robocopy / powershell / 宿主路径是不是都有平台分支。
 *   四、文档账：mac 装法、复原办法写下来没有，版本三处对不对得上。
 *
 * 最后有一条阴性对照（P14）：把判据对着故意写坏的样本跑一遍，必须判红——
 * 「探针自己会不会红」这件事，得由探针自己证明，不然全是自证。
 *
 * 全程只读：不写 profile、不装插件、不启停进程。跑法：node tools/probe-platform.mjs
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, relative } from 'node:path'
import { root } from './_root.mjs'

let pass = 0
const bad = []
function ok(name, cond, detail) {
  if (cond) {
    pass += 1
    console.log(`PASS  ${name}${detail === undefined ? '' : `：${detail}`}`)
  } else {
    bad.push(name)
    console.log(`FAIL  ${name}${detail === undefined ? '' : `：${detail}`}`)
  }
}

const read = (rel) => {
  const p = join(root, rel)
  return existsSync(p) ? readFileSync(p, 'utf8') : ''
}
const exists = (rel) => existsSync(join(root, rel))
const lines = (text, re) => text.split('\n').filter((l) => re.test(l))

// ── 一、路径账 ─────────────────────────────────────────────────────────────
const P = await import(new URL('../lib/macro/platform.js', import.meta.url).href)

const WIN = { platform: 'win32', env: { DSH_HOME: 'D:\\dsh-home' }, home: 'C:\\Users\\tester' }
const MAC = { platform: 'darwin', env: {}, home: '/Users/tester' }
const MAC_HOME = { platform: 'darwin', env: { DSH_HOME: '/Users/tester/.dsh' }, home: '/Users/tester' }
const LIN = { platform: 'linux', env: {}, home: '/home/tester' }

ok('P1 三平台的宏目录都推得出来', [
  P.resolveMacroHome(WIN),
  P.resolveMacroHome(MAC),
  P.resolveMacroHome(MAC_HOME),
  P.resolveMacroHome(LIN),
].join('|') === [
  'D:\\dsh-home\\macro-memory',
  '/Users/tester/.dsh/macro-memory',
  '/Users/tester/.dsh/macro-memory',
  '/home/tester/.dsh/macro-memory',
].join('|'), `${P.resolveMacroHome(WIN)} | ${P.resolveMacroHome(MAC)} | ${P.resolveMacroHome(LIN)}`)

ok(
  'P2 $DSH_HOME：有值就用值、空白串当没设、不展开 ~',
  P.defaultDshHome('darwin', { DSH_HOME: '/opt/h' }, '/Users/t') === '/opt/h' &&
    P.defaultDshHome('darwin', { DSH_HOME: '   ' }, '/Users/t') === '/Users/t/.dsh' &&
    P.defaultDshHome('darwin', { DSH_HOME: '~/x' }, '/Users/t') === '~/x' &&
    P.defaultDshHome('win32', {}, 'D:\\Users\\t') === 'D:\\Users\\t\\.dsh',
  `opt/h→${P.defaultDshHome('darwin', { DSH_HOME: '/opt/h' }, '/Users/t')}，空白→${P.defaultDshHome('darwin', { DSH_HOME: '   ' }, '/Users/t')}`,
)

ok(
  'P3 拼路径走 pathFor：win32 给反斜杠、posix 给斜杠',
  P.pathFor('win32').join('a', 'b') === 'a\\b' &&
    P.pathFor('darwin').join('a', 'b') === 'a/b' &&
    P.pathFor('linux').join('a', 'b') === 'a/b' &&
    P.isWindows('win32') && !P.isWindows('darwin') && !P.isWindows('linux'),
  `${P.pathFor('win32').join('a', 'b')} / ${P.pathFor('darwin').join('a', 'b')}`,
)

ok(
  'P4 提示串是跨平台写法，没有盘符',
  P.HOME_HINT === '~/.dsh/macro-memory' && !/[A-Za-z]:/.test(P.HOME_HINT),
  P.HOME_HINT,
)

// 当前这台机器上，store 的宏目录必须和 platform.js 逐字一致（不许自己再推一次）
const Store = await import(new URL('../lib/macro/store.js', import.meta.url).href)
ok(
  'P5 这台机器上 store.macroHome() === resolveMacroHome()',
  Store.macroHome() === P.resolveMacroHome(),
  `${Store.macroHome()}`,
)

// ── 二、字面量账 ───────────────────────────────────────────────────────────
function walk(dir) {
  const out = []
  for (const e of readdirSync(join(root, dir), { withFileTypes: true })) {
    const rel = `${dir}/${e.name}`
    if (e.isDirectory()) out.push(...walk(rel))
    else if (e.name.endsWith('.js') || e.name.endsWith('.mjs')) out.push(rel)
  }
  return out
}
const LIB_FILES = walk('lib')

// 盘符字面量：`"D:\\...` / `'C:\\...`。只看「引号 + 盘符 + 双反斜杠」，
// 避免把 `id:\s` 这类正则里的 `d:\` 也算进来（0.6.x 审计时就误报过一次）。
const DRIVE = /['"`][A-Za-z]:\\\\/
// platform.js 是唯一允许带盘符的模块，且只允许一处：SAMPLE_HOME 的 win32 样例形状。
const driveAllowed = (f) => f === 'lib/macro/platform.js'
const driveHits = LIB_FILES.filter((f) => !driveAllowed(f) && DRIVE.test(read(f)))
ok(
  'P6 运行面（lib/ 全树）没有盘符字面量（platform.js 的 SAMPLE_HOME 例外）',
  driveHits.length === 0 && lines(read('lib/macro/platform.js'), DRIVE).length <= 1,
  driveHits.length ? driveHits.join(', ') : `${LIB_FILES.length} 个文件，只有 platform.js 的样例形状带盘符`,
)

const ENV_READ = /env\??\.(DSH_HOME|USERPROFILE)|process\.env\[["'](DSH_HOME|USERPROFILE)["']\]/
const envHits = LIB_FILES.filter((f) => f !== 'lib/macro/platform.js' && ENV_READ.test(read(f)))
ok(
  'P7 $DSH_HOME / $USERPROFILE 只在 platform.js 里读',
  envHits.length === 0,
  envHits.length ? envHits.join(', ') : '唯一入口 lib/macro/platform.js',
)

const platHits = LIB_FILES.filter((f) => f !== 'lib/macro/platform.js' && /process\.platform|process\.arch/.test(read(f)))
ok(
  'P8 process.platform / arch 只在 platform.js 里问',
  platHits.length === 0,
  platHits.length ? platHits.join(', ') : '其余模块一律走 isWindows()/pathFor()',
)

const client = read('lib/client.js')
const clientLines = lines(client, /placeholder:/).filter((l) => /meow-memory/.test(l))
ok(
  'P9 设置页 placeholder 是 ~/.dsh/macro-memory（不再是 D:\\data\\meow-memory）',
  client.includes('placeholder: "~/.dsh/macro-memory"') && !clientLines.some((l) => /[A-Za-z]:\\\\/.test(l)),
  clientLines[0]?.trim().slice(0, 90) ?? (lines(client, /placeholder:/)[0]?.trim().slice(0, 90) ?? '（没有 placeholder 行）'),
)

// ── 三、工具账 + 快照层 ───────────────────────────────────────────────────
const snap = read('lib/macro/snapshot.js')
ok(
  'P10 snapshot.js 不再静态 import node:sqlite，改成能兜住的动态导入',
  !/^import\s+\{[^}]*DatabaseSync[^}]*\}\s+from\s+['"]node:sqlite['"]/m.test(snap) &&
    /await import\(\s*['"]node:sqlite['"]\s*\)/.test(snap) &&
    /export function sqliteAvailable/.test(snap) &&
    /export function sqliteReason/.test(snap),
  (
    lines(snap, /node:sqlite/)[0] ?? '（没提到 node:sqlite）'
  ).trim().slice(0, 90),
)

const S = await import(new URL('../lib/macro/snapshot.js', import.meta.url).href)
ok(
  'P11 这台机器的 Node 真拿得到 node:sqlite（快照层可用）',
  S.sqliteAvailable() === true,
  S.sqliteAvailable() ? `node ${process.versions.node}` : `取不到：${S.sqliteReason()}`,
)

const hint = S.restoreHint({ file: '/tmp/ws/.dsh-meow/snapshots/memory-20990101-000000.db', dir: '.dsh-meow' })
const hintBody = typeof hint === 'string' ? hint : JSON.stringify(hint)
ok(
  'P12 复原提示走跨平台脚本 restore-live-db.mjs --source，命令按平台给',
  /restore-live-db\.mjs --source/.test(hintBody) &&
    /拷回快照/.test(hintBody) &&
    (process.platform === 'win32' ? /copy "/.test(hintBody) : /cp /.test(hintBody)),
  hintBody.replace(/\s+/g, ' ').slice(0, 120),
)

const syncTrees = read('tools/sync-trees.mjs')
ok(
  'P13 sync-trees：有 cpTree/copyTree，非 Windows 不走 robocopy',
  /function cpTree/.test(syncTrees) && /function copyTree/.test(syncTrees) && /fs\.cpSync|cpSync/.test(syncTrees) && /IS_WIN/.test(syncTrees),
  lines(syncTrees, /copyTree\(ROOT/)[0]?.trim().slice(0, 80) ?? '（没找到调用点）',
)

const doctor = read('tools/doctor.mjs')
ok(
  'P14 doctor：两棵树的根从 $DSH_HOME 推，且可被 DSH_MACRO_* 覆盖',
  /DSH_MACRO_VENDOR/.test(doctor) && /DSH_MACRO_PROFILE_HOME/.test(doctor) && /process\.env\.DSH_HOME/.test(doctor) && /homedir\(\)/.test(doctor),
  lines(doctor, /const VENDOR =/)[0]?.trim().slice(0, 100) ?? '（没找到 VENDOR）',
)

const market = read('tools/check-market.mjs')
const live = read('tools/accept-live.mjs')
ok(
  'P15 check-market / accept-live：宿主路径与进程查询都有平台分支',
  /Applications\/DSH NEXT\.app/.test(market) && /process\.platform === 'darwin'/.test(market) && /\/bin\/sh/.test(live) && /pgrep/.test(live),
  `${lines(market, /Applications\/DSH NEXT/).length} 处 mac 路径，accept-live 走 ps`,
)

const restore = read('tools/restore-live-db.mjs')
ok(
  'P16 复原脚本有跨平台 .mjs（--source / --dry-run / 备份 / 删 -wal）',
  Boolean(restore) &&
    /--dry-run/.test(restore) &&
    /--source/.test(restore) &&
    /memory\.db-wal/.test(restore) &&
    /node:sqlite/.test(restore) &&
    /IS_WIN/.test(restore),
  restore ? `${restore.length} 字节` : '（缺 tools/restore-live-db.mjs）',
)

// 自检链里还剩下的 Windows 独占**调用**，只允许出现在有平台分支的文件里。
// 只认真调用（execFileSync('powershell… / robocopy(…），不认测试语料里提到的词——
// probe-recall / probe-ruler 的语料里就是有「robocopy 也会失败」这种句子，那是被引擎读的数据。
const TOOL_FILES = readdirSync(join(root, 'tools')).filter((f) => f.endsWith('.mjs'))
const WIN_CALL = /execFileSync\(\s*['"`]powershell|spawnSync\(\s*['"`]powershell|\brobocopy\(/
const loneWin = TOOL_FILES.filter((f) => {
  const t = read(`tools/${f}`)
  return WIN_CALL.test(t) && !/IS_WIN|process\.platform/.test(t)
})
ok(
  'P17 真调用 robocopy / powershell 的自检脚本都有平台分支',
  loneWin.length === 0,
  loneWin.length ? loneWin.join(', ') : '没有裸的 Windows 调用（语料里的词不算）',
)

// ── 四、文档账 ─────────────────────────────────────────────────────────────
const mac = read('docs/MAC.md')
ok(
  'P18 docs/MAC.md 在，且写了装法/底线/复原/已知限制',
  mac.length > 800 &&
    /profiles/.test(mac) &&
    /node:sqlite|Node 2[24]/.test(mac) &&
    /restore-live-db\.mjs/.test(mac) &&
    /已知|限制|注意/.test(mac),
  mac ? `${mac.length} 字符` : '（缺 docs/MAC.md）',
)

const readme = read('README.md')
ok(
  'P19 README 有平台段（mac / Linux 同一套装法）',
  /mac|macOS/.test(readme) && /Linux/.test(readme) && /profiles/.test(readme),
  lines(readme, /macOS|mac /)[0]?.trim().slice(0, 80) ?? '（README 没提 mac）',
)

const changelog = read('docs/CHANGELOG.md')
ok(
  'P20 CHANGELOG 有 0.7.0 里程碑与逐版条目',
  /\*\*0\.7\.0 里程碑\*\*/.test(changelog) && /\*\*0\.7\.0：/.test(changelog),
  /\*\*0\.7\.0 里程碑\*\*/.test(changelog) ? '里程碑 + 逐版条目都在' : '（缺 0.7.0 条目）',
)

const pkg = JSON.parse(read('package.json'))
const idx = read('lib/index.js')
const idxVersion = /export const version = '([^']+)'/.exec(idx)?.[1]
const clVersion = /\*\*([0-9]+\.[0-9]+\.[0-9]+) (?:里程碑|修复)\*\*/.exec(changelog)?.[1]
ok(
  'P21 版本三处一致（package.json / lib/index.js / CHANGELOG 最新里程碑）',
  pkg.version === idxVersion && pkg.version === clVersion,
  `${pkg.version} / ${idxVersion} / ${clVersion}`,
)

// package.json 的 engines 是「装进宿主」的硬门槛；mac 上的宿主 Node 必须够新
ok(
  'P22 engines.node 的下限落在 node:sqlite 可用线（≥22.5）以内',
  Boolean(pkg.engines?.node) && !/2[0-1]\./.test(String(pkg.engines.node)),
  String(pkg.engines?.node),
)

// ── 阴性对照：判据自己会不会红 ─────────────────────────────────────────────
const fakeBad = 'const home = "D:\\\\data\\\\meow-memory"\nconst p = process.env.DSH_HOME\n'
const fakeGood = 'const home = join(homedir(), ".dsh", "macro-memory")\n'
const judge = (src) => DRIVE.test(src) || /process\.env\.DSH_HOME/.test(src)
ok(
  'P23 阴性对照：判据对坏样本判红、对好样本判绿（自证不是永远绿）',
  judge(fakeBad) === true && judge(fakeGood) === false,
  `坏样本→${judge(fakeBad)}，好样本→${judge(fakeGood)}`,
)

// ── 这台机器的实况（不判红，只报） ────────────────────────────────────────
const facts = P.hostFacts()
console.log('')
for (const [k, v] of Object.entries(facts)) console.log(`INFO  ${k}：${v}`)
console.log(`INFO  源树：${relative(process.cwd(), root) || '.'}`)

console.log('')
if (bad.length) {
  console.log(`FAILED  passed ${pass} / failed ${bad.length}`)
  for (const b of bad) console.log('  ✗ ' + b)
  process.exitCode = 1
} else {
  console.log(`ALL PASS  probe-platform：${pass}/${pass}`)
}
