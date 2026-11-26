/**
 * core 的路径事实：一套跨平台的数据目录规则，不读任何宿主变量。
 *
 * 优先级（从高到低）：
 *   1. 调用方显式给的 `dir`
 *   2. 环境变量 `MACRO_MEMORY_HOME`
 *   3. 平台默认：
 *        Windows  %APPDATA%\macro-memory
 *        macOS    ~/Library/Application Support/macro-memory
 *        Linux    $XDG_DATA_HOME/macro-memory（缺省 ~/.local/share/macro-memory）
 *
 * 与 DSH 的关系：DSH 侧仍由 `lib/macro/platform.js` 读 `DSH_HOME`（宿主规矩不变），
 * 本文件只服务「没有 DSH」的那一半。core 里出现 `DSH_HOME` 就是错，探针会咬。
 */

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { currentPlatform, pathFor as pathForOf, resolveMemoryHome } from '../macro/platform.js'

export const APP_DIR_NAME = 'macro-memory'

/** 按平台挑 path 实现：与 platform.js 同一份，不在 core 里再写一遍。 */
export { pathFor } from '../macro/platform.js'

/**
 * 平台默认数据目录。
 * @param {object} [opts]
 * @param {string} [opts.platform] 覆盖当前平台（自检用）
 * @param {object} [opts.env]      覆盖 process.env
 * @param {string} [opts.home]     覆盖家目录
 */
export function defaultDataDir(opts = {}) {
  const platform = opts.platform ?? currentPlatform()
  const env = opts.env ?? process.env
  const home = opts.home ?? homedir()
  const P = pathForOf(platform)
  const fromEnv = typeof env?.MACRO_MEMORY_HOME === 'string' ? env.MACRO_MEMORY_HOME.trim() : ''
  if (fromEnv.length > 0) return fromEnv
  if (platform === 'win32') {
    const appData = typeof env?.APPDATA === 'string' && env.APPDATA.trim().length > 0
      ? env.APPDATA.trim()
      : P.join(home, 'AppData', 'Roaming')
    return P.join(appData, APP_DIR_NAME)
  }
  if (platform === 'darwin') {
    return P.join(home, 'Library', 'Application Support', APP_DIR_NAME)
  }
  const xdg = typeof env?.XDG_DATA_HOME === 'string' ? env.XDG_DATA_HOME.trim() : ''
  const base = xdg.length > 0 ? xdg : P.join(home, '.local', 'share')
  return P.join(base, APP_DIR_NAME)
}

/** 解析最终生效的数据目录（显式 dir 最优先）。 */
export function resolveDataDir(opts = {}) {
  const explicit = typeof opts.dir === 'string' ? opts.dir.trim() : ''
  if (explicit.length > 0) return explicit
  return defaultDataDir(opts)
}

/** 引擎自己的库目录（meow 的 projectDir）。 */
export function dbDirOf(dataDir) {
  return pathForOf(currentPlatform()).join(dataDir, 'db')
}

/**
 * 全局记忆库目录的缺省值——**与 DSH 共用同一份**是这里的全部重点。
 *
 * `~/.dsh-meow` 是 meow 作为独立库的默认位置；装上 DSH 之后，宿主把 `homeDir` 设成
 * `'dsh-storage'`，真实全局库落在 `<DSH_HOME>/storages/meow-memory`。core 若还用
 * `~/.dsh-meow`，同一台机器上就有两个「全局库」：CLI 里记的 MCP 那边查不到，
 * 反之亦然——「一份真身」在全局层直接失效。
 *
 * 所以按「谁存在就用谁」判断，两个都没有时优先 DSH 的位置（装 DSH 是主流路径，
 * meow 会自己把这个目录建出来）。
 *
 * @param {object} [opts]
 * @param {string} [opts.platform] 覆盖当前平台（自检用）
 * @param {object} [opts.env]      覆盖 process.env
 * @param {string} [opts.home]     覆盖家目录
 * @param {Function} [opts.exists] 覆盖存在性判断（自检用）
 */
export function detectHomeDir(opts = {}) {
  const platform = opts.platform ?? currentPlatform()
  const env = opts.env ?? process.env
  const home = opts.home ?? homedir()
  const exists = typeof opts.exists === 'function' ? opts.exists : existsSync
  const storage = resolveMemoryHome({ platform, env, home })
  const legacy = pathForOf(platform).join(home, '.dsh-meow')
  if (exists(storage)) return storage
  if (exists(legacy)) return legacy
  return storage
}

/** 配置文件名（CLI 的 init 会写它）。 */
export const CONFIG_FILE = 'config.json'
