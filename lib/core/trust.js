/**
 * core/trust —— workspace 记忆库的信任门。
 *
 * 为什么 core 自己要管这件事：meow 有一个 #64 的防护——**工作区里自带的外部记忆库**
 * （`.dsh-meow` 不是本机创建的）默认关掉读写，免得 clone 一个别人的仓库就被塞一嘴
 * 别人写的「记忆」。DSH 里的解法是让主人手打 `/meow-trust`；可 MCP / CLI 场景没有
 * 斜杠命令，只剩一堵墙。所以 core 把同一套 marker 搬到可编程的一侧：
 *
 *   <activeHomeDir>/trusted-workspaces/<sha256(规范化路径)>.json
 *   { path, trustedAt, trustedSource }
 *
 * 与 meow 完全同一格式、同一哈希（小写 + 正斜杠 + 去尾斜杠），所以：
 *   - core 信任过的目录，DSH 那边立刻也认（不需要两边各点一次）；
 *   - 反之亦然。
 *
 * 默认策略 `auto`：只在「这个库目录不存在，或者存在但里面只有本插件的产物」时自动
 * 信任——这正是 meow 自己 `created-empty` 的口径。目录里有别的东西（说明库是别人带来
 * 的），一律不猜，回一句「跑 macro-memory trust」让人自己决定。
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

/**
 * meow 创建库时允许出现的文件：这些不算「外部内容」。
 *
 * `sessions` / `archived-sessions` 这两项是 0.9.0 补的，踩出来的：meow 会把每个会话的
 * 状态快照写进 `<workspace>/<库目录>/sessions/`，于是一个**本机建、本机用**的库在第二个
 * 进程眼里就成了「目录里有不是本插件产生的文件」。多 agent 场景下这件事一天能撞十次：
 * DSH 里用的库，轮到 MCP / CLI / 管理界面接手时全被判成「别处带来的库」。
 * 凡是本插件自己会写的名字都要在这里，否则护栏会把自己人拦在门外。
 */
export const CREATION_IGNORE = new Set([
  'memory.db',
  'memory.db-wal',
  'memory.db-shm',
  'memory.db.tmp',
  'memory.db.bak',
  'dream-debug.log',
  'dream-debug.log.old',
  'sessions',
  'archived-sessions',
  'nebula.db',
  'nebula.db-wal',
  'nebula.db-shm',
  'nebula.db.tmp',
])

/** 带后缀的变体（`memory.db.20260101.bak`、`nebula.db.tmp` 这类）按前缀认。 */
export const CREATION_PREFIX = ['memory.db.', 'nebula.db.', 'dream-debug.log.']

/** 这个目录项是不是本插件自己的产物？护栏只该拦「不是我们的」。 */
export function isCreationArtifact(name) {
  const n = String(name ?? '')
  if (CREATION_IGNORE.has(n)) return true
  return CREATION_PREFIX.some((p) => n.startsWith(p))
}

/** 与 meow 的 normalizeWorkspacePath 一致：Windows 大小写不敏感，统一小写 + 正斜杠。 */
export function normalizeWorkspacePath(p) {
  return String(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

export function markersDirOf(homeDir) {
  return path.join(homeDir, 'trusted-workspaces')
}

export function markerPathOf(workspace, homeDir) {
  const hash = crypto.createHash('sha256').update(normalizeWorkspacePath(workspace)).digest('hex')
  return path.join(markersDirOf(homeDir), `${hash}.json`)
}

/** 读 marker（读不出来就当没有，绝不抛）。 */
export function readTrustMarker(workspace, homeDir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(markerPathOf(workspace, homeDir), 'utf8'))
    if (parsed === null || typeof parsed !== 'object' || typeof parsed.path !== 'string') return null
    return parsed
  } catch {
    return null
  }
}

export function isTrusted(workspace, homeDir) {
  if (!homeDir) return true // 没配 home 时 meow 自己也不启信任门（markersDir=null）
  const marker = readTrustMarker(workspace, homeDir)
  return marker !== null && typeof marker.trustedAt === 'number'
}

export function trustWorkspace(workspace, { homeDir, source = 'macro-memory-trust' } = {}) {
  if (!homeDir) return false
  const dir = markersDirOf(homeDir)
  fs.mkdirSync(dir, { recursive: true })
  const file = markerPathOf(workspace, homeDir)
  const existing = readTrustMarker(workspace, homeDir)
  if (existing !== null && typeof existing.trustedAt === 'number') return true
  const body = { ...(existing ?? {}), path: workspace, trustedAt: Date.now(), trustedSource: source }
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(body, null, 1), 'utf8')
  fs.renameSync(tmp, file)
  return true
}

export function untrustWorkspace(workspace, homeDir) {
  try {
    fs.rmSync(markerPathOf(workspace, homeDir), { force: true })
    return true
  } catch {
    return false
  }
}

/** 列出所有被信任的工作区（按信任时间倒序）。 */
export function listTrusted(homeDir) {
  const dir = markersDirOf(homeDir)
  let files = []
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'))
  } catch {
    return []
  }
  const rows = []
  for (const f of files) {
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))
      if (typeof parsed?.path === 'string') {
        rows.push({ path: parsed.path, trustedAt: Number(parsed.trustedAt ?? 0), source: parsed.trustedSource ?? '' })
      }
    } catch {
      /* 坏文件跳过，不让一条烂账拖死列表 */
    }
  }
  return rows.sort((a, b) => b.trustedAt - a.trustedAt)
}

/**
 * 决定这个工作区能不能写，必要时按策略自动信任。
 *
 * @param {object} opts
 * @param {string} opts.workspace  工作区绝对路径（工具 exec 里的 cwd）
 * @param {string} opts.homeDir    meow 的 activeHomeDir（markers 落点）
 * @param {string} [opts.projectDir='.dsh-meow'] 工作区内的库目录名
 * @param {'auto'|'always'|'never'} [opts.policy='auto']
 * @returns {{trusted:boolean, created:boolean, reason:string, dir:string, leftovers?:string[]}}
 */
export function ensureTrust({ workspace, homeDir, projectDir = '.dsh-meow', policy = 'auto' }) {
  const dir = path.join(workspace, projectDir)
  if (isTrusted(workspace, homeDir)) {
    return { trusted: true, created: false, reason: 'marker', dir, workspace }
  }
  if (policy === 'never') {
    return { trusted: false, created: false, reason: 'policy-never', dir, workspace }
  }
  if (policy === 'always') {
    trustWorkspace(workspace, { homeDir, source: 'macro-memory:always' })
    return { trusted: true, created: false, reason: 'policy-always', dir, workspace }
  }
  // auto：库目录不存在，或存在但只有本插件的产物 → 视为「本机新建」
  let leftovers = null
  if (fs.existsSync(dir)) {
    try {
      leftovers = fs.readdirSync(dir).filter((n) => !isCreationArtifact(n))
    } catch (err) {
      return { trusted: false, created: false, reason: `unreadable:${err.message}`, dir, workspace }
    }
    if (leftovers.length > 0) {
      return { trusted: false, created: false, reason: 'external', dir, workspace, leftovers }
    }
  }
  trustWorkspace(workspace, { homeDir, source: 'macro-memory:created-empty' })
  return { trusted: true, created: true, reason: 'created-empty', dir, workspace }
}
