/**
 * [macro-fusion 0.6.68 / 0.6.69] 记忆库快照：把「库被写坏一次 = 记忆全灭」变成「退一份回去」。
 * 0.6.69 补的是另一半——**退之前先看清楚要退掉什么**（`compareWithLive` 只读做差，见文件下半段）。
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
 *    必须由人看着做（`tools/restore-live-db.mjs`，Windows 另有 `.ps1` 版），面板只给现成命令。
 *  - 任何失败都回在返回值里，不抛——快照是保险，不是主流程。
 */
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readSync, renameSync, rmSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import * as Meow from '../../vendor/meow-memory/lib/index.js'
import { isWindows } from './platform.js'
import { macroHome } from './store.js'

/**
 * `node:sqlite` 的取法（0.7.0 · mac 适配）：**不用顶层静态 import**。
 *
 * 静态 import 一个不存在的内置模块，会让整个插件在**加载阶段**就抛——连 8 个工具都注册不上，
 * 用户看到的是一句 `Cannot find module 'node:sqlite'`，而不是「快照这一层不可用」。
 * 这个模块是 Node 22.5 才加的（22.x 带实验标记、24 起稳定），而 DSH 桌面端各平台不是同一个
 * 构建：mac 版的 Electron/Node 与 Windows 版不保证一致（本机 Windows 宿主自带
 * v24.21.0，`node:sqlite` 在）。所以这里改成动态 import + 失败即降级：
 * 记忆读写、检索、注入一行都不受影响，只有「库快照」这一层明确说清「这台机器取不到」。
 *
 * 注意范围：引擎（`vendor/meow-memory/lib/index.js:12`）自己仍静态 import `node:sqlite` ——
 * 插件本体要求宿主 Node ≥ 22.5 这条底线由它决定，本文件只负责「快照层」不在这个前提之外
 * 再制造一个新的崩溃点。`tools/probe-platform.mjs` 会同时钉住这两件事。
 */
let DatabaseSyncCtor = null
let sqliteLoadError = ''
try {
  const mod = await import('node:sqlite')
  const ctor = mod?.DatabaseSync ?? mod?.default?.DatabaseSync ?? null
  if (typeof ctor === 'function') DatabaseSyncCtor = ctor
  else sqliteLoadError = 'node:sqlite 里没有 DatabaseSync 导出'
} catch (err) {
  sqliteLoadError = String(err?.message ?? err)
}

/** 这台机器的 Node 有没有 `node:sqlite`（自检与面板都问这一句，不各自 try/catch）。 */
export function sqliteAvailable() {
  return typeof DatabaseSyncCtor === 'function'
}

/** 不可用的原因（可用时是空串）——回执要能说清「为什么这次没有快照」。 */
export function sqliteReason() {
  return sqliteAvailable() ? '' : sqliteLoadError || '这一版 Node 没有内置 node:sqlite'
}

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

/**
 * 复原要人看着做：面板只给现成命令，不给「一键覆盖」。
 *
 * [0.7.0 · mac 适配] 命令按平台给：Windows 上是 `copy` / `del`，mac 与 Linux 上是
 * `cp` / `rm -f`。原先这里只写 `copy` / `del`，mac 用户照抄会得到
 * `copy: command not found`——「给了错命令」比「没给命令」更坏：他以为自己照着做了。
 * 脚本那一行也统一指向跨平台的 `tools/restore-live-db.mjs`（`.ps1` 只作 Windows 备选）。
 */
export function restoreHint(workspace, dir = '.dsh-meow', file = '') {
  let dbPath = ''
  try {
    dbPath = Meow.memoryDbPath(workspace, dir)
  } catch {
    dbPath = join(String(workspace ?? ''), dir, 'memory.db')
  }
  const src = file === '' ? '<快照文件>' : file
  const win = isWindows()
  const copyLine = win ? `copy "${src}" "${dbPath}"` : `cp "${src}" "${dbPath}"`
  const rmLine = win ? `del "${dbPath}-wal" "${dbPath}-shm"` : `rm -f "${dbPath}-wal" "${dbPath}-shm"`
  return [
    '复原（先退出 DSH，别让进程握着库）：',
    `  1) 备份现状：把 ${dbPath}（连同 -wal / -shm）复制到别处`,
    `  2) 拷回快照：${copyLine}`,
    `  3) 删掉旧日志：${rmLine}（留着会被回放，覆盖回来的库又变坏）`,
    '仓库里有一份做了同样三件事的脚本：node tools/restore-live-db.mjs --source "<快照文件>"（先加 --dry-run 看一眼）。',
  ].join('\n')
}

/**
 * [macro-fusion 0.6.69] 退之前先看清楚要退掉什么。
 *
 * 病：0.6.68 让「库坏了」有了退路，但**退哪一份、退掉多少、会不会把今天写的东西一起扔掉**，
 * 全要人去猜。9.268 的边界④就是这么写的：「真丢了只能退到上一份，退完之后的增量照样没了」——
 * 事故现场最需要的恰恰是这一句读数：快照 2,197 条、现库 2,202 条，退回去丢掉 5 条（哪 5 条）。
 *
 * 处方：**只读**地把两份库各数一遍，按 id 做差。三条边界：
 *  - 快照用独立的 `DatabaseSync(file, { readOnly: true })` 打开：不碰引擎的缓存连接、不上写锁，
 *    它是一份静止的库文件，没有任何理由让它参与 WAL 那一套；
 *  - 现库走引擎已经开着的那个连接（`meow.getDb`），不另开一个写句柄去抢锁；开之前先
 *    `existsSync` 判一下——引擎的 `getDb` 会顺手建库，面板不该有副作用；
 *  - 差集只报「多了/少了多少条、按层分布、前几条标题」，**不做内容级 diff**：
 *    面板是拿来做「退还是不退」这决定的，不是拿来看逐字改动。
 */
/** 库里的七张表（层）。顺序与引擎 `LEVELS` 一致：面板按这个顺序念，读起来跟体检/星图一个口味。 */
export const SNAPSHOT_LEVELS = ['soul', 'user', 'project', 'fact', 'lesson', 'topic', 'rules']

/** 只读打开一个库文件（快照用）。失败只回 `{status:'error'}`，不抛。 */
export function openReadOnly(file) {
  if (!existsSync(file)) return { status: 'no-file' }
  // 先认文件头：SQLite 库以 `SQLite format 3\0` 开头。少了这一步，坏文件（空壳、被别的
  // 东西写过的 4 KB）也能「打开成功」——每张表都查不出来、`readShape` 就回 0 条，
  // 面板于是念成「快照 0 条、之后新写 2,202 条」。**坏快照读成空库，比读不出来更坏。**
  try {
    const fd = openSync(file, 'r')
    try {
      const head = Buffer.alloc(16)
      const got = readSync(fd, head, 0, 16, 0)
      if (got < 16 || head.subarray(0, 16).toString('latin1') !== 'SQLite format 3\u0000') {
        return { status: 'error', error: '不是 SQLite 库（文件头不对）' }
      }
    } finally {
      closeSync(fd)
    }
  } catch (err) {
    return { status: 'error', error: String(err?.message ?? err) }
  }
  // [0.7.0 · mac 适配] 取不到 `node:sqlite` 时**不抛**：快照是保险，不是主流程。
  // 走到这里说明文件在、头也对，缺的是运行时能力——必须说清是哪一种，别让面板念成「库坏了」。
  if (!sqliteAvailable()) {
    return { status: 'error', error: `这台机器的 Node 取不到 node:sqlite（${sqliteReason()}），快照层这次不工作` }
  }
  try {
    const db = new DatabaseSyncCtor(file, { readOnly: true })
    // 头对了也可能半张表：真查一次 sqlite_master，查不动就是坏库。
    db.prepare('SELECT COUNT(*) AS n FROM sqlite_master').get()
    return { status: 'ok', db }
  } catch (err) {
    return { status: 'error', error: String(err?.message ?? err) }
  }
}

/**
 * 一个库的形状：每条 id 属于哪一层、有没有标题、总共几条、最近一次写入。
 * 表不在（老库、半张 schema、坏库）就跳过那张表——**坏一张不该让整份读数作废**。
 */
export function readShape(handle) {
  const byLevel = {}
  const ids = new Map()
  const titles = new Map()
  let total = 0
  let newest = 0
  for (const table of SNAPSHOT_LEVELS) {
    let rows = []
    try {
      rows = handle.prepare(`SELECT id, title, content, updated_at FROM ${table}`).all()
    } catch {
      continue
    }
    byLevel[table] = rows.length
    for (const row of rows) {
      const id = String(row.id ?? '')
      if (id === '') continue
      ids.set(id, table)
      const title = typeof row.title === 'string' && row.title.trim() !== '' ? row.title.trim() : String(row.content ?? '').trim()
      titles.set(id, title)
      total += 1
      const at = Number(row.updated_at)
      if (Number.isFinite(at) && at > newest) newest = at
    }
  }
  return { total, byLevel, ids, titles, newest }
}

/** 两份形状做差：现库多出来的（快照之后写的）、快照有现库没有的（退回去会带回来的）。 */
export function shapeDiff(live, snap) {
  const added = []
  const removed = []
  for (const [id, level] of live.ids) if (!snap.ids.has(id)) added.push({ id, level, title: live.titles.get(id) ?? '' })
  for (const [id, level] of snap.ids) if (!live.ids.has(id)) removed.push({ id, level, title: snap.titles.get(id) ?? '' })
  const tally = (list) => {
    const out = {}
    for (const item of list) out[item.level] = (out[item.level] ?? 0) + 1
    return out
  }
  return { added, removed, addedByLevel: tally(added), removedByLevel: tally(removed) }
}

/**
 * 挑一份「真能打开」的快照：默认最新在前找第一份读得动的；给了 `file` 就用它。
 * 为什么要挑：坏掉的那一份常常正好是最新的（写到一半断电、盘满、被别的程序写过）——
 * 面板如果把复原命令指向它，等于让人往坑里跳。
 * @returns {{item?:object, list:object[], skipped:object[], explicit:boolean}}
 */
export function pickSnapshot(workspace, { file = '' } = {}) {
  const list = listSnapshots(workspace)
  if (file !== '') {
    const found = list.find((x) => x.file === file)
    return { item: found ?? { file, at: 0, stamp: 0, bytes: 0, name: basename(file) }, list, skipped: [], explicit: true }
  }
  const skipped = []
  for (const item of list) {
    const probe = openReadOnly(item.file)
    if (probe.status === 'ok') {
      try {
        probe.db.close()
      } catch {
        /* 关不掉不影响判断 */
      }
      return { item, list, skipped, explicit: false }
    }
    skipped.push({ name: item.name, file: item.file, error: probe.error ?? probe.status })
  }
  return { item: undefined, list, skipped, explicit: false }
}

/**
 * 拿最新一份「读得动」的快照（或指定那一份）与现库对比。
 *
 * @returns {{status:string, file?:string, live?:object, snapshot?:object, added?:object, removed?:object, skipped?:object[], error?:string}}
 *   `ok` / `no-ws` / `no-snapshot`（一份都没有）/ `no-usable-snapshot`（有文件但全读不动）/
 *   `no-db` / `snapshot-error`（指定那一份读不动）/ `snapshot-empty`（能读但一条都没有）/ `error`
 */
export function compareWithLive({ workspace = '', dir = '.dsh-meow', file = '', sample = 3, meow = Meow } = {}) {
  const ws = String(workspace ?? '').trim()
  if (ws === '') return { status: 'no-ws' }
  const picked = pickSnapshot(ws, { file })
  if (picked.item === undefined) {
    return picked.list.length === 0
      ? { status: 'no-snapshot' }
      : { status: 'no-usable-snapshot', skipped: picked.skipped }
  }
  const target = picked.item
  const skipped = picked.skipped
  let dbPath = ''
  try {
    dbPath = meow.memoryDbPath(ws, dir)
  } catch {
    dbPath = ''
  }
  if (dbPath === '' || !existsSync(dbPath)) return { status: 'no-db', file: target.file, skipped }
  const snap = openReadOnly(target.file)
  if (snap.status !== 'ok') return { status: 'snapshot-error', file: target.file, error: snap.error ?? snap.status, skipped }
  try {
    const snapShape = readShape(snap.db)
    let liveHandle
    try {
      liveHandle = meow.getDb(ws, dir)
    } catch (err) {
      return { status: 'error', file: target.file, error: String(err?.message ?? err) }
    }
    const liveShape = readShape(liveHandle.db)
    // 9.267 的现场就是这种库：文件是好的 SQLite（4,096 字节，`sqlite_master` 查得动），
    // 但七张表一条都没有。**退它等于把现库清空**，所以不能报成「之后新写 2,202 条」，
    // 得单独说一句「这一份是空的」。
    if (snapShape.total === 0 && liveShape.total > 0) {
      return {
        status: 'snapshot-empty',
        file: target.file,
        at: target.at ?? 0,
        skipped,
        live: { total: liveShape.total, byLevel: liveShape.byLevel, newest: liveShape.newest },
        snapshot: { total: 0, byLevel: snapShape.byLevel, newest: 0 },
      }
    }
    const diff = shapeDiff(liveShape, snapShape)
    const limit = Math.max(0, Math.floor(Number(sample) || 0))
    const brief = (list2, byLevel) => ({
      total: list2.length,
      byLevel,
      sample: list2.slice(0, limit).map((x) => ({ id: x.id, level: x.level, title: x.title })),
    })
    return {
      status: 'ok',
      file: target.file,
      at: target.at ?? 0,
      skipped,
      live: { total: liveShape.total, byLevel: liveShape.byLevel, newest: liveShape.newest },
      snapshot: { total: snapShape.total, byLevel: snapShape.byLevel, newest: snapShape.newest },
      added: brief(diff.added, diff.addedByLevel),
      removed: brief(diff.removed, diff.removedByLevel),
    }
  } catch (err) {
    return { status: 'error', file: target.file, error: String(err?.message ?? err) }
  } finally {
    try {
      snap.db.close()
    } catch {
      /* 关不掉不影响读数 */
    }
  }
}

/** 「按层分布」说成人话：`fact 3 · lesson 2`（顺序固定，只列有条的层）。 */
export function levelTally(byLevel = {}) {
  const parts = []
  for (const level of SNAPSHOT_LEVELS) {
    const n = Number(byLevel?.[level]) || 0
    if (n > 0) parts.push(`${level} ${n}`)
  }
  return parts.join(' · ')
}

/** 标题截短（面板一行）：去掉换行、超长咬断。 */
function shortTitle(text) {
  const one = String(text ?? '').replace(/\s+/g, ' ').trim()
  return one.length <= 24 ? one : `${one.slice(0, 24)}…`
}

/**
 * 对比读数 → 面板那几行。`ok` 时一定给「快照多少条 → 现库多少条 + 新写几条」，
 * 有样本就再给一行标题；`removed > 0` 单独说一句「退回去会带回来」。
 */
export function compareLines(cmp, { stamp = '' } = {}) {
  const when = stamp === '' ? '最新快照' : `最新快照（${stamp}）`
  if (cmp === undefined || cmp === null) return [`  · 与${when}对比：这次没读到（不是「一模一样」）`]
  if (cmp.status === 'no-snapshot') return []
  if (cmp.status === 'snapshot-empty') {
    return [
      `  · 与${when}比：这一份里一条记忆都没有（空 schema / 坏库）——**退它等于把现库 ${cmp.live?.total ?? 0} 条全清掉**`,
    ]
  }
  if (cmp.status !== 'ok') {
    const why =
      cmp.status === 'no-db'
        ? '这个工作区还没有库'
        : cmp.status === 'no-ws'
          ? '拿不到工作区'
          : cmp.status === 'no-usable-snapshot'
            ? `盘上有 ${cmp.skipped?.length ?? 0} 份快照，但一份都打不开——这时候没有退路，先别动库`
            : `读不出来：${cmp.error ?? cmp.status}`
    return [`  · 与${when}对比没做成：${why}`]
  }
  const before = cmp.snapshot.total
  const after = cmp.live.total
  const added = cmp.added?.total ?? 0
  const removed = cmp.removed?.total ?? 0
  const lines = []
  if (added === 0 && removed === 0) {
    lines.push(`  · 与${when}一致：${after} 条，之后没有新写、也没有丢条`)
  } else {
    const arrow = `快照 ${before} 条 → 现库 ${after} 条`
    lines.push(`  · 与${when}比：${arrow}${added > 0 ? `，之后新写 ${added} 条（${levelTally(cmp.added.byLevel)}）` : ''}`)
    if (added > 0 && Array.isArray(cmp.added.sample) && cmp.added.sample.length > 0) {
      lines.push(`    新写的例如：${cmp.added.sample.map((x) => shortTitle(x.title)).filter(Boolean).join(' / ')}`)
    }
    if (removed > 0) {
      lines.push(
        `    快照里有 ${removed} 条现库没有了（${levelTally(cmp.removed.byLevel)}）——退到这一份会把它们带回来`,
      )
    }
  }
  return lines
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
  compare = true,
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
  // [macro-fusion 0.6.69] 「退之前先看清楚要退掉什么」：只读地与最新那份比一次。
  // 只在库和快照都在的时候比；任何失败都只落成一行说明，不影响上面那些读数。
  let cmp
  if (compare && list.length > 0 && dbBytes > 0) {
    try {
      cmp = compareWithLive({ workspace: ws, dir })
    } catch (err) {
      cmp = { status: 'error', error: String(err instanceof Error ? err.message : err) }
    }
    const usable = typeof cmp?.file === 'string' && cmp.file !== '' ? cmp.file : list[0].file
    const at = list.find((x) => x.file === usable)?.stamp ?? list[0].stamp
    for (const line of compareLines(cmp, { stamp: humanStamp(at) })) lines.push(line)
    if (Array.isArray(cmp?.skipped) && cmp.skipped.length > 0) {
      lines.push(
        `    另有 ${cmp.skipped.length} 份读不出来，已跳过（退的时候别选它们）：${cmp.skipped.map((x) => x.name).join(' / ')}`,
      )
    }
  }
  lines.push('')
  if (list.length === 0) {
    lines.push('快照：还没有。库第一次变动后（下一轮注入时）会自己存第一份；也可以现在手动存：memory_admin(action="snapshot", limit=…)。')
  } else {
    lines.push(`快照（${Math.min(limit, list.length)}/${list.length} 份，新→旧）：`)
    for (const item of list.slice(0, Math.max(0, limit))) {
      const bad = Array.isArray(cmp?.skipped) && cmp.skipped.some((x) => x.file === item.file)
      lines.push(
        `  ${humanStamp(item.stamp)} · ${humanBytes(item.bytes)} · ${agoText(item.stamp, now)} · ${item.name}${bad ? '（读不出来）' : ''}`,
      )
    }
    if (list.length > limit) lines.push(`  …更早的 ${list.length - limit} 份没列（加快 limit）`)
    lines.push('')
    // 复原命令指向「最新一份读得动的」：坏掉的那份常常就是最新的，指错等于让人往坑里跳。
    const usable = typeof cmp?.file === 'string' && cmp.file !== '' ? cmp.file : ''
    if (usable === '' && cmp !== undefined && cmp.status === 'no-usable-snapshot') {
      lines.push('复原：盘上的快照一份都打不开，现在没有能退的东西——先别动库，找一份外部备份。')
    } else {
      lines.push(restoreHint(ws, dir, usable === '' ? list[0].file : usable))
    }
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
