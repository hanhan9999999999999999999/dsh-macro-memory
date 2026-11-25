/**
 * 平台事实 —— 插件在 Windows / macOS / Linux 上「路径从哪来、分隔符怎么拼」的唯一出口。
 *
 * 为什么单开一层（0.7.0 · mac 适配）：
 *   这个插件原先只在 Windows 上被真跑过。运行时其实没有一处 Windows-only API，
 *   但「没有」是查出来的、不是保证的：`store.js` 里 `join(homedir(), '.dsh')`、
 *   设置页文案里写着 `D:\data\meow-memory`、自检链里 spawn 的是 `robocopy` 和
 *   `powershell.exe`。前两类在 mac 上仍能跑（只是文案误导），第三类直接跑不起来。
 *   把「平台」收成一个可注入的小模块，好处有三：
 *     1. **可测**：在 Windows 上就能算出 darwin / linux 的路径，不必等一台 mac 到手；
 *     2. **可断言**：探针能挖掉「按平台选 path 实现」这一行，看判定是不是真的会红；
 *     3. **可解释**：用户问「我的库在哪」，`hostFacts()` 直接给出这台机器的答案。
 *
 * 三条约定（改这个文件之前先读）：
 *   1. **`$DSH_HOME` 只在这里读一次**。运行面其余文件一律经 `resolveMacroHome()` 取路径，
 *      「换个 home 只改一处」这条约定从 0.2.21 起没变，只是把「一处」从 store.js 挪到了这里。
 *   2. **平台参数必须能注入**。所有函数都接受 `platform`，默认 `process.platform`；
 *      传 `'darwin'` 时用的是 `path.posix`，所以在 Windows 上也能验证 mac 的推导。
 *   3. **不展开 `~`**。DSH 自己也不展开（`DSH_HOME` 原样当路径用），这里跟着宿主走：
 *      设了就用设的那个字符串，没设才落到 `<home>/.dsh`。擅自展开会让「用户写错了」
 *      变成「看起来能用、其实写到别处」。
 */
import path from 'node:path'
import { homedir } from 'node:os'

/** 三平台里我们承诺支持的两个半：Windows、macOS、Linux（Linux 只承诺「路径与 API 层面成立」）。 */
export const PLATFORMS = ['win32', 'darwin', 'linux']

/**
 * 按平台挑 path 实现。
 * Windows 用 `path.win32`（反斜杠、盘符），其余用 `path.posix`——这也是 Node 在那些平台上
 * `node:path` 的真实行为，所以「在 Windows 上算 mac 路径」得到的字符串与真 mac 上一致。
 */
export function pathFor(platform = process.platform) {
  return platform === 'win32' ? path.win32 : path.posix
}

export function isWindows(platform = process.platform) {
  return platform === 'win32'
}

/** 人类可读的平台名，用在回执与自检输出里。 */
export function platformName(platform = process.platform) {
  if (platform === 'win32') return 'Windows'
  if (platform === 'darwin') return 'macOS'
  if (platform === 'linux') return 'Linux'
  return String(platform)
}

/**
 * 三平台家目录的**样例形状**：只在「推演非当前平台」时用（自检、探针、文档示例），
 * 绝不写进任何真实路径。探针允许整个 lib/ 只有这一行带盘符——这一行就是许可清单。
 */
export const SAMPLE_HOME = {
  win32: 'C:\\Users\\tester',
  darwin: '/Users/tester',
  linux: '/home/tester',
}

/**
 * 这台机器上「家目录」在哪；平台不是当前平台时给一个**形状正确**的样例值。
 * 样例值只用于推演与自检，绝不写进任何真实路径。
 */
export function homeFor(platform = process.platform) {
  if (platform === process.platform) return homedir()
  return SAMPLE_HOME[platform] ?? SAMPLE_HOME.linux
}

/**
 * DSH 的家目录：`$DSH_HOME` 优先，否则 `<home>/.dsh`。
 *
 * 与宿主同一套规则（`D:\DSH\DSH NEXT\resources\app.asar` 里
 * `config.dshHome ?? process.env["DSH_HOME"] ?? join(homedir(), ".dsh")`）——
 * 插件不能比宿主更聪明：宿主认 `DSH_HOME`，插件就认；宿主没设就退回家目录。
 * 空串按「没设」处理（`DSH_HOME=` 这种写法在 shell 里很常见，当路径用会写到当前目录）。
 */
export function defaultDshHome(platform = process.platform, env = process.env, home) {
  const P = pathFor(platform)
  const set = typeof env?.DSH_HOME === 'string' ? env.DSH_HOME.trim() : ''
  if (set.length > 0) return set
  return P.join(home ?? homeFor(platform), '.dsh')
}

/**
 * 插件的运行数据目录：`<DSH_HOME>/macro-memory`（成本账本、待补连线、邻域账、快照都在下面）。
 * 这是运行面唯一的路径入口；`store.js` 的 `macroHome()` 只是它的别名。
 */
export function resolveMacroHome({ platform = process.platform, env = process.env, home } = {}) {
  return pathFor(platform).join(defaultDshHome(platform, env, home), 'macro-memory')
}

/** 设置页里「自定义库位置」的示例文案：三平台都读得懂，不再写死盘符。 */
export const HOME_HINT = '~/.dsh/macro-memory'

/**
 * 这台机器的平台事实，给自检与面板念用。
 * 全是读出来的值，没有推测：`explicitHome` 说的就是「用户有没有自己设 DSH_HOME」。
 */
export function hostFacts() {
  const env = process.env
  const explicitHome = typeof env.DSH_HOME === 'string' && env.DSH_HOME.trim().length > 0
  return {
    platform: process.platform,
    platformName: platformName(),
    isWindows: isWindows(),
    home: homedir(),
    dshHome: defaultDshHome(),
    macroHome: resolveMacroHome(),
    explicitHome,
    node: process.versions.node,
  }
}
