/**
 * core/config —— 磁盘上的那一份 `config.json`。
 *
 * 为什么 core 需要自己的配置文件：DSH 侧的配置由 cordis schema 管（主人的 UI 里改），
 * 而「不装 DSH 的那一半」（MCP / CLI）没有 UI，只有一张纸。写在 `dataDir/config.json`，
 * 人可读、可 diff、可进 git，脚本也能直接改。
 *
 * 三条规矩：
 *  1. **读不懂就说不懂**：JSON 坏了就报错并把原文留在原地，绝不「悄悄用默认值覆盖」——
 *     那会把主人手写的配置吃掉，而且看不出来。
 *  2. **写要原子**：先写 `config.json.tmp` 再 rename。写到一半断电，旧文件还在。
 *  3. **不认识就留着**：本文件只认自己那几段，其余键原样保留（向前兼容：新版本写的
 *     字段被老版本读到，不该被删掉）。
 */

import fs from 'node:fs'
import path from 'node:path'
import { CONFIG_FILE, resolveDataDir } from './paths.js'

/** 配置格式版本。改结构时 +1，并在这里写迁移。 */
export const CONFIG_VERSION = 1

/** 默认配置：正是 `macro-memory init` 写出来的样子。 */
export function defaultConfig(overrides = {}) {
  return {
    version: CONFIG_VERSION,
    /** workspace 内的库目录名（与 DSH 侧同名 = 同一份库）。 */
    projectDir: '.dsh-meow',
    /** 全局库目录，空串 = meow 默认（~/.dsh-meow）。 */
    homeDir: '',
    /** 这个 agent 是谁：写进 owner 与回执里的「（codex 记）」。 */
    agent: { id: '', label: '' },
    /** 各引擎的覆盖配置，形状与 DSH 侧一致（meow 的键原样透传）。 */
    engines: { meow: {}, nebula: {} },
    /** 融合层（注入字符数、回执语言等）。 */
    macro: {},
    ...overrides,
  }
}

function configPathOf(opts) {
  const dataDir = resolveDataDir(typeof opts === 'string' ? { dir: opts } : opts ?? {})
  return { dataDir, file: path.join(dataDir, CONFIG_FILE) }
}

/**
 * 读配置。
 * @returns {{file:string, dataDir:string, exists:boolean, config:object, raw:string|null}}
 * @throws 文件存在但不是合法 JSON 对象时抛错（调用方自己决定是提示还是退出）
 */
export function loadConfig(opts = {}) {
  const { dataDir, file } = configPathOf(opts)
  if (!fs.existsSync(file)) {
    return { file, dataDir, exists: false, config: defaultConfig(), raw: null }
  }
  const raw = fs.readFileSync(file, 'utf8')
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    throw new Error(`${file} 不是合法 JSON：${err.message}（文件没动，改好再跑）`)
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${file} 顶层必须是对象，现在是 ${Array.isArray(parsed) ? '数组' : typeof parsed}`)
  }
  return { file, dataDir, exists: true, config: { ...defaultConfig(), ...parsed }, raw }
}

/** 合并式改写：`patch` 只覆盖它提到的键，其余原样。 */
export function mergeConfig(current, patch) {
  const out = { ...current }
  for (const [k, v] of Object.entries(patch ?? {})) {
    if (v === undefined) continue
    const cur = out[k]
    if (v !== null && typeof v === 'object' && !Array.isArray(v)
      && cur !== null && typeof cur === 'object' && !Array.isArray(cur)) {
      out[k] = mergeConfig(cur, v)
    } else {
      out[k] = v
    }
  }
  return out
}

/**
 * 写配置（原子）。
 * @returns {string} 落盘路径
 */
export function writeConfigFile(opts, config) {
  // 两种调用姿势：writeConfigFile(config) / writeConfigFile(dataDirOrOpts, config)
  const isConfigOnly = config === undefined
  const target = isConfigOnly ? {} : opts
  const body = isConfigOnly ? opts : config
  const { dataDir, file } = configPathOf(target)
  fs.mkdirSync(dataDir, { recursive: true })
  const next = { ...defaultConfig(), ...(body ?? {}), version: CONFIG_VERSION }
  // 键排序：stable stringify，主人 diff 时不会因为键序抖动看到假改动
  const text = `${JSON.stringify(sortKeys(next), null, 2)}\n`
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, text, 'utf8')
  fs.renameSync(tmp, file)
  return file
}

/** 存一下（读旧的、合新的、写回去）。 */
export function saveConfig(opts, patch) {
  const { config } = loadConfig(opts)
  return writeConfigFile(opts, mergeConfig(config, patch))
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value === null || typeof value !== 'object') return value
  const out = {}
  for (const k of Object.keys(value).sort()) out[k] = sortKeys(value[k])
  return out
}
