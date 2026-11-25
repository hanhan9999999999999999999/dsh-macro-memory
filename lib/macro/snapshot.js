/**
 * [macro-fusion 0.6.68] 记忆库快照：把「库被写坏一次 = 记忆全灭」变成「退一份回去」。
 *
 * 病（2026-11-25 的真事，见 docs/INTERNAL.md 9.267）：16:38 一个开发脚本把 4,096 字节的空壳
 * fixture 库盖到了活库上，2,613 条记忆当场只剩一个空 schema。引擎自己有一个
 * `backupMemoryDb()`（dream 收尾时 `VACUUM INTO` 成 `memory.db.bak`），但它的配置默认
 * `backup: { enabled: false }`——事故前**一个字节的备份都没有**，最后靠翻 174MB 会话转写与
 * 半年前的分析快照，才把 2,202 条抠回来。
 *
 * 三条处方，各自只解决一件事：
 *  ① **不复用那一个 `.bak`**。单份备份在「连续几次写坏」面前等于没有：第二份坏库一来，
 *     唯一的好备份就被盖掉了。这里按时间戳一份一份留（默认 7 份），谁坏都还有别的。
 *  ② **取快照只走 `VACUUM INTO`**，不做文件复制。库正被写时直接复制出来是撕裂的；
 *     而撕裂的快照比没有快照更坏——它会让人以为「退得回去」。
 *  ③ **便宜到可以每轮问一次**：先 stat（`memory.db` 与 `-wal` 的 mtime、最新快照的 mtime），
 *     库没变就一个字节都不写、连库都不打开；真变了才 VACUUM，且默认一小时最多一次。
 *
 * 边界（改这个文件之前先读）：
 *  - 快照目录在 `$DSH_HOME/macro-memory/snapshots/<工作区尾部>`，**不放进 `.dsh-meow`**：
 *    那里是记忆引擎的地盘，我们的缓存不该跟库混在一起（也躲开同步器/宿主清理）。
 *  - 这里**只写快照，不做复原**。复原要停进程、要删 `-wal`/`-shm`，属于危险动作，
 *    必须由人看着做（`tools/restore-live-db.ps1`），面板只给现成命令。
 *  - 任何失败都回在返回值里，不抛——快照是保险，不是主流程。
 */
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import * as Meow from '../../vendor/meow-memory/lib/index.js'
import { macroHome } from './store.js'

/** 默认留几份。7 份 ≈ 一周（一天一次到几次），够退到「出事之前」。 */
export const SNAPSHOT_KEEP = 7
/** 两次快照的最小间隔：库每轮都在写，不设间隔等于每轮 VACUUM 一次。 */
export const SNAPSHOT_GAP_MS = 60 * 60 * 1000
/** 快照文件名里的时间戳格式，也是排序依据（字典序＝时间序）。 */
const NAME_RE = /^memory-(\d{4})(\d\d)(\d\d)-(\d\d)(\d\d)(\d\d)\.db$/

const pad = (n) => String(n).padStart(2, '0')

/** 快照文件名里的本地时间戳（和人对表，不用 UTC）。 */
export function stampOf(ms) {
  const d = new Date(ms)
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
}

/** 时间戳 → 毫秒（解析不出来回 0，排序时自然沉底）。 */
function msOf(name) {
  const m = NAME_RE.exec(name)
  if (m === null) return 0
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])).getTime()
}

/**
 * 快照目录：一个工作区一个子目录，名字取工作区路径尾部 96 字符（绝对路径含 `:` `\` `/`，
 * 直接当目录名在 Windows 上写不进去；同一台机器上尾部才是区分度所在，与 neighbor-suspect 同口径）。
 */
export function snapshotDir(workspace) {
  const raw = String(workspace ?? '').trim()
  const safe = raw.replace(/[^A-Za-z0-9_.-]+/g, '_').slice(-96)
  return join(macroHome(), 'snapshots', safe === '' ? 'unknown' : safe)
}

/**
 * 盘上的快照清单，最新在前。
 * 目录不存在 → 空数组；单个文件 stat 失败 → 跳过（一行坏文件不该让清单读不出来）。
 */
export function listSnapshots(workspace) {
  const dir = snapshotDir(workspace)
  let names = []
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  const out = []
  for (const name of names) {
    if (!NAME_RE.test(name)) continue
    const file = join(dir, name)
    try {
      const st = statSync(file)
      out.push({ name, file, bytes: st.size, at: st.mtimeMs, stamp: msOf(name) })
    } catch {
      /* 一个读不到的文件不参与清单 */
    }
  }
  out.sort((a, b) => b.stamp - a.stamp)
  return out
}

/**
 * 只留最近 `keep` 份，多出来的删掉（先删最老的）。
 * 返回删掉的份数；任何一步失败都只落在返回值里。
 */
export function pruneSnapshots(workspace, keep = SNAPSHOT_KEEP) {
  const list = listSnapshots(workspace)
  if (keep <= 0 || list.length <= keep) return 0
  let removed = 0
  for (const item of list.slice(keep)) {
    try {
      rmSync(item.file, { force: true })
      removed += 1
    } catch {
      /* 删不掉就留着，下次再删 */
    }
  }
  return removed
}

/** 库文件本身的时间戳（`memory.db` 与它的 `-wal` 取最大——有 WAL 时新内容在 WAL 里）。 */
function dataMtimeOf(dbPath) {
  let ms = 0
  for (const p of [dbPath, `${dbPath}-wal`]) {
    try {
      ms = Math.max(ms, statSync(p).mtimeMs)
    } catch {
      /* 没有这个文件 */
    }
  }
  return ms
}

/**
 * 取一份快照（按需：库没变、或距上一份不到 `gapMs`，就什么都不做）。
 *
 * @returns {{status:string, file?:string, bytes?:number, removed?:number, skipped?:string, error?:string}}
 *   status: `taken` 真存了 / `fresh` 库没变或刚存过 / `no-ws` 拿不到工作区 /
 *   `no-db` 这个工作区还没有库 / `error` 存失败（`error` 里是原话）
 */
export function takeSnapshot({
  workspace = '',
  dir = '.dsh-meow',
  keep = SNAPSHOT_KEEP,
  gapMs = SNAPSHOT_GAP_MS,
  now = Date.now(),
  force = false,
  meow = Meow,
} = {}) {
  const ws = String(workspace ?? '').trim()
  if (ws === '') return { status: 'no-ws' }
  let dbPath
  try {
    dbPath = meow.memoryDbPath(ws, dir)
  } catch (err) {
    return { status: 'error', error: String(err?.message ?? err) }
  }
  if (!existsSync(dbPath)) return { status: 'no-db' }
  const list = listSnapshots(ws)
  const last = list[0]
  if (!force && last !== undefined) {
    // 两条闸：①库自上一份之后没再写过 → 存了也是同一份；②刚存过 → 别每轮都存。
    if (last.at >= dataMtimeOf(dbPath)) return { status: 'fresh', file: last.file, skipped: 'unchanged' }
    if (now - last.at < gapMs) return { status: 'fresh', file: last.file, skipped: 'gap' }
  }
  const outDir = snapshotDir(ws)
  let file = join(outDir, `memory-${stampOf(now)}.db`)
  if (existsSync(file)) {
    // 同一秒里存两次：文件名只到秒，硬存就会盖掉前一份。非强制时认已有的那份（不另起名）；
    // `force` 是「现在就要一份新的」，那就把时间戳往后挪到下一个空位——最多挪 60 秒，
    // 挪满还撞就当这一秒已经存过，绝不覆盖已有快照。
    if (!force) return { status: 'fresh', file, skipped: 'same-second' }
    let step = 0
    while (step < 60 && existsSync(file)) {
      step += 1
      file = join(outDir, `memory-${stampOf(now + step * 1000)}.db`)
    }
    if (existsSync(file)) return { status: 'fresh', file, skipped: 'same-second' }
  }
  const tmp = `${file}.tmp`
  try {
    mkdirSync(outDir, { recursive: true })
    // `VACUUM INTO` 要求目标文件不存在；上次中途失败可能留下 .tmp，先清掉。
    if (existsSync(tmp)) rmSync(tmp, { force: true })
    meow.getDb(ws, dir).vacuumInto(tmp)
    renameSync(tmp, file)
  } catch (err) {
    try {
      rmSync(tmp, { force: true })
    } catch {
      /* 清理失败不影响结论 */
    }
    return { status: 'error', error: String(err?.message ?? err) }
  }
  const removed = pruneSnapshots(ws, keep)
  let bytes = 0
  try {
    bytes = statSync(file).size
  } catch {
    /* 刚写完就 stat 失败：字节数留 0，不影响「存下来了」这个结论 */
  }
  return { status: 'taken', file, bytes, removed }
}

/** 字节数说成人话（面板用；不进判定）。 */
export function humanBytes(n) {
  const v = Number(n)
  if (!Number.isFinite(v) || v <= 0) return '0 B'
  if (v < 1024) return `${v} B`
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`
  return `${(v / (1024 * 1024)).toFixed(2)} MB`
}

/** 复原要人看着做：面板只给现成命令，不给「一键覆盖」。 */
export function restoreHint(workspace, dir = '.dsh-meow', file = '') {
  let dbPath = ''
  try {
    dbPath = Meow.memoryDbPath(workspace, dir)
  } catch {
    dbPath = join(String(workspace ?? ''), dir, 'memory.db')
  }
  const src = file === '' ? '<快照文件>' : file
  return [
    '复原（先退出 DSH，别让进程握着库）：',
    `  1) 备份现状：把 ${dbPath}（连同 -wal / -shm）复制到别处`,
    `  2) 拷回快照：copy "${src}" "${dbPath}"`,
    `  3) 删掉旧日志：del "${dbPath}-wal" "${dbPath}-shm"（留着会被回放，覆盖回来的库又变坏）`,
    '仓库里有一份做了同样三件事的脚本：tools\\restore-live-db.ps1 -Source "<快照文件>"（先 -DryRun 看一眼）。',
  ].join('\n')
}

/** 面板口径说明（`scope` 那一段）。 */
export function snapshotScope({ list = [], keep = SNAPSHOT_KEEP, dbBytes = 0 } = {}) {
  if (list.length === 0) {
    return dbBytes > 0 ? '还没有快照（库在，但没到存的条件，或刚装上）' : '还没有快照'
  }
  const total = list.reduce((n, x) => n + x.bytes, 0)
  return `${list.length} 份 · 共 ${humanBytes(total)} · 最多留 ${keep} 份`
}

/** 人对表用的时间：`2026-11-25 17:50`。 */
export function humanStamp(ms) {
  const v = Number(ms)
  if (!Number.isFinite(v) || v <= 0) return '—'
  const d = new Date(v)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 「多久以前」，只做量级（面板用；不进判定）。 */
function agoText(ms, now) {
  const d = Math.max(0, now - ms)
  if (d < 60 * 1000) return '刚刚'
  if (d < 60 * 60 * 1000) return `${Math.floor(d / 60000)} 分钟前`
  if (d < 24 * 60 * 60 * 1000) return `${Math.floor(d / 3600000)} 小时前`
  return `${Math.floor(d / 86400000)} 天前`
}

/**
 * 面板正文：库现状 + 快照清单 + 复原入口。数字全部念盘上的东西，面板不自己算「应该有几份」。
 * 只读：绝不在这里顺手存一份（存快照的唯一出口是 `takeSnapshot`，面板要存就显式调）。
 */
export function readSnapshotPanel({
  workspace = '',
  dir = '.dsh-meow',
  keep = SNAPSHOT_KEEP,
  limit = 7,
  now = Date.now(),
} = {}) {
  const ws = String(workspace ?? '').trim()
  if (ws === '') {
    return { body: '拿不到工作区——快照是按工作区存的，这次一份都列不出来（不是「没有快照」）。', scope: '' }
  }
  let dbPath = ''
  try {
    dbPath = Meow.memoryDbPath(ws, dir)
  } catch {
    dbPath = ''
  }
  let dbBytes = 0
  let dbAt = 0
  if (dbPath !== '') {
    try {
      const st = statSync(dbPath)
      dbBytes = st.size
      dbAt = st.mtimeMs
    } catch {
      /* 库不在或读不到：下面按「没有库」说 */
    }
  }
  const list = listSnapshots(ws)
  const lines = []
  lines.push(`库：${dbPath === '' ? '（路径取不到）' : dbPath}`)
  if (dbBytes > 0) {
    const verdict =
      list.length === 0
        ? '· 库里还没有任何快照'
        : list[0].at >= dbAt
          ? '· 快照不比库旧'
          : `· 库比最新快照还新（差 ${Math.max(1, Math.round((dbAt - list[0].at) / 60000))} 分钟）`
    lines.push(`  ${humanBytes(dbBytes)} · 最后写入 ${humanStamp(dbAt)} ${verdict}`)
  } else {
    lines.push('  这个工作区还没有记忆库——没有可快照的东西。')
  }
  lines.push('')
  if (list.length === 0) {
    lines.push('快照：还没有。库第一次变动后（下一轮注入时）会自己存第一份；也可以现在手动存：memory_admin(action="snapshot", limit=…)。')
  } else {
    lines.push(`快照（${Math.min(limit, list.length)}/${list.length} 份，新→旧）：`)
    for (const item of list.slice(0, Math.max(0, limit))) {
      lines.push(`  ${humanStamp(item.stamp)} · ${humanBytes(item.bytes)} · ${agoText(item.stamp, now)} · ${item.name}`)
    }
    if (list.length > limit) lines.push(`  …更早的 ${list.length - limit} 份没列（加快 limit）`)
    lines.push('')
    lines.push(restoreHint(ws, dir, list[0].file))
    lines.push('')
    lines.push(
      `什么时候会自动存下一份：库里再有写入、且距最新这份满 ${Math.round(SNAPSHOT_GAP_MS / 60000)} 分钟（最多留 ${keep} 份，多了删最老的）。`,
    )
  }
  let scope = snapshotScope({ list, keep, dbBytes })
  scope += ` · 间隔 ${Math.round(SNAPSHOT_GAP_MS / 60000)} 分钟`
  return { body: lines.join('\n'), scope }
}

/**
 * 每轮问一次「库变了没有」，变了才存。
 *
 * 为什么挂在 `agent/pre-step` 而不是写入路径：记忆库不是只有 memory_* 工具在写（dream、合并、
 * 邻域读时补连线都在写），在工具出口挂会漏掉一半；挂在每轮的入口，问的是同一件事
 * 「这一轮开始时库是什么样」，而那一下只是两次 stat——库没变就一个字节都不写。
 *
 * 为什么 `next()` 之后才动手：快照要读整库，别挡在这一轮的第一个 token 前面；
 * 但也不等 `await` 完再存（那会把快照拖到下一轮），`next()` 返回后同步做完即可。
 * 失败只记一行日志，绝不影响这一轮——保险不该变成单点。
 */
export function createSnapshotGuard({ ctx, meowDir, logger, keep = SNAPSHOT_KEEP, gapMs = SNAPSHOT_GAP_MS } = {}) {
  const quiet = (msg) => {
    try {
      logger?.(msg)
    } catch {
      /* 日志也不能反咬 */
    }
  }
  let busy = false
  const attempt = (payload) => {
    if (busy) return
    const ws = typeof payload?.agent?.session?.header?.cwd === 'string' ? payload.agent.session.header.cwd : ''
    if (ws === '') return
    busy = true
    try {
      const raw = typeof meowDir === 'function' ? meowDir() : meowDir
      const dir = typeof raw === 'string' && raw.length > 0 ? raw : '.dsh-meow'
      const r = takeSnapshot({ workspace: ws, dir, keep, gapMs })
      if (r.status === 'taken') {
        quiet(`[macro-memory] 库快照已存：${r.file}（${humanBytes(r.bytes)}${r.removed > 0 ? `，清掉 ${r.removed} 份旧的` : ''}）`)
      } else if (r.status === 'error') {
        quiet(`[macro-memory] 库快照没做成（不影响这一轮）：${r.error}`)
      }
    } catch (err) {
      quiet(`[macro-memory] 库快照出错（不影响这一轮）：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      busy = false
    }
  }
  if (typeof ctx?.on !== 'function') return { attempt, dispose: () => {} }
  const dispose = ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    attempt(payload)
    return decision
  })
  return { attempt, dispose: typeof dispose === 'function' ? dispose : () => {} }
}
