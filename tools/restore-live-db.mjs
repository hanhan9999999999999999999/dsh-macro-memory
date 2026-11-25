#!/usr/bin/env node
/**
 * restore-live-db.mjs —— 把一份干净的记忆库放回活库位置（跨平台，0.7.0 新增）
 *
 * 来历：2026-11-25 的记忆库事故。当时的复原开关是 `tools/restore-live-db.ps1`，
 * 只有 Windows 能跑；mac / Linux 上要手工 `cp` + `rm`，还得自己记得删 `-wal`。
 * 这份 .mjs 就是同一件事的跨平台版：Windows、mac、Linux 走同一套命令，
 * 自检也不再借 python（直接用宿主自带的 `node:sqlite`）。
 * 两份脚本并存：`.ps1` 保留给习惯 PowerShell 的人，`.mjs` 是主入口。
 *
 * 用法（**必须先把 DSH 完全退出**，否则文件被占用、覆盖会失败）：
 *   node tools/restore-live-db.mjs --dry-run                       # 只体检，不写盘
 *   node tools/restore-live-db.mjs                                 # 真复原（用默认源库）
 *   node tools/restore-live-db.mjs --source <别的库> [--workspace <工作区>]
 *   node tools/restore-live-db.mjs --backup <备份放哪>             # 默认 D:\备份 / ~/DSH-备份
 *
 * 它做四件事（和 .ps1 一模一样）：
 *   1) 拒绝在 DSH 还活着的时候动手（避免和活进程抢同一次 checkpoint）
 *   2) 把现有 .dsh-meow 三件套备份到 `<备份根>\<时间戳>-before-restore-live\`
 *   3) 覆盖 memory.db，**并删掉 -wal / -shm**（旧 WAL 里可能是坏盐帧，留着会被回放）
 *   4) 事后自检：文件大小、只读打开 integrity_check、七层计数
 *
 * 退出码：0 = 成了；1 = 中止（原因打在 stderr 上一行）。
 */
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, statSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { root } from './_root.mjs'

const IS_WIN = process.platform === 'win32'
const LEVELS = ['soul', 'user', 'project', 'fact', 'lesson', 'topic', 'rules']
const SIDE_FILES = ['memory.db', 'memory.db-shm', 'memory.db-wal']

const argv = process.argv.slice(2)
/** `--name value` 与 `--name=value` 都认 */
function opt(name, fallback) {
  const withEq = argv.find((a) => a.startsWith(`${name}=`))
  if (withEq) return withEq.slice(name.length + 1)
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback
}
const has = (name) => argv.includes(name)

if (has('--help') || has('-h')) {
  console.log(`用法：node tools/restore-live-db.mjs [--source <库>] [--workspace <目录>] [--backup <目录>] [--dry-run]`)
  process.exit(0)
}

const workspace = resolve(opt('--workspace', root))
const meowDir = join(workspace, '.dsh-meow')
const liveDb = join(meowDir, 'memory.db')
const source = resolve(opt('--source', join(meowDir, 'restore', '20261125-restored-memory.db')))
const backupRoot = resolve(opt('--backup', process.env.DSH_BACKUP || (IS_WIN ? 'D:\\备份' : join(homedir(), 'DSH-备份'))))
const dryRun = has('--dry-run')

const say = (msg) => console.log(`[restore] ${msg}`)
const die = (msg) => {
  console.error(`[restore] 中止：${msg}`)
  process.exit(1)
}
const fmt = (n) => n.toLocaleString('en-US')
const sizeOf = (p) => {
  try {
    return statSync(p).size
  } catch {
    return null
  }
}

/** DSH 主进程在不在跑：Windows 问 tasklist，mac / Linux 问 pgrep。查不到就当没跑。 */
function hostProcesses() {
  const name = process.env.DSH_LIVE_PROCESS || 'DSH NEXT'
  try {
    if (IS_WIN) {
      const out = execFileSync('tasklist', ['/FI', `IMAGENAME eq ${name}.exe`, '/NH'], {
        encoding: 'utf8',
        timeout: 15000,
      })
      // tasklist 的行形如 `DSH NEXT.exe   23328 Console   1   345,678 K`——只认「镜像名 + 第一列数字」，
      // 别用 /(\d+)/ 去捞：内存列里也有数字，会把 pid 认错（实测过）。
      const head = `^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.exe\\s+(\\d+)`
      return [...out.matchAll(new RegExp(head, 'gm'))].map((m) => m[1])
    }
    const out = execFileSync('/bin/sh', ['-c', `pgrep -f '${name}' 2>/dev/null || true`], {
      encoding: 'utf8',
      timeout: 15000,
    }).trim()
    return out ? out.split('\n').map((s) => s.trim()).filter(Boolean) : []
  } catch {
    return []
  }
}

// ── 源库体检 ────────────────────────────────────────────────────────────────
say(`源库 ${source}`)
if (!existsSync(source)) die(`找不到源库（用 --source 指定；默认位置是 ${join('.dsh-meow', 'restore', '20261125-restored-memory.db')}）`)
const srcSize = sizeOf(source) ?? 0
say(`源库大小 ${fmt(srcSize)} 字节`)
if (srcSize < 1024 * 1024) die(`源库只有 ${fmt(srcSize)} 字节，像空壳库，不像整顿过的那份`)

// ── 1. 宿主还活着就别动手 ───────────────────────────────────────────────────
const pids = hostProcesses()
if (pids.length) {
  const who = `${pids.length} 个进程（${pids.join(',')}）`
  if (dryRun) say(`提示：DSH 在跑（${who}），真复原前要退出`)
  else die(`DSH 还在跑（${who}）——先完全退出 DSH 再跑本脚本`)
}

// ── 现有活库长什么样 ────────────────────────────────────────────────────────
say('现有活库')
for (const f of SIDE_FILES) {
  const p = join(meowDir, f)
  const size = sizeOf(p)
  say(size === null ? `         ${f}  （没有）` : `         ${f}  ${fmt(size)} 字节`)
}

if (dryRun) {
  say('--dry-run：只体检，不写盘。计划：备份三件套 → 覆盖 memory.db → 删 -wal/-shm → 自检')
  process.exit(0)
}

// ── 2. 备份三件套 ──────────────────────────────────────────────────────────
const pad = (n) => String(n).padStart(2, '0')
const now = new Date()
const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
const backupDir = join(backupRoot, `${stamp}-before-restore-live`)
mkdirSync(backupDir, { recursive: true })
let saved = 0
for (const f of SIDE_FILES) {
  const p = join(meowDir, f)
  if (!existsSync(p)) continue
  copyFileSync(p, join(backupDir, f))
  saved += 1
}
say(`已备份到 ${backupDir}（${saved} 个文件）`)

// ── 3. 先删伴生文件，再覆盖 ────────────────────────────────────────────────
// SQLite 见到旧 -wal 会尝试回放；坏盐帧会把刚放进去的好库带歪。
for (const f of ['memory.db-shm', 'memory.db-wal']) {
  const p = join(meowDir, f)
  if (!existsSync(p)) continue
  unlinkSync(p)
  say(`已删除 ${f}`)
}
copyFileSync(source, liveDb)
say(`已覆盖 memory.db（${fmt(sizeOf(liveDb) ?? 0)} 字节）`)

// ── 4. 自检：只读打开 + integrity_check + 七层计数 ────────────────────────
let DatabaseSyncCtor = null
try {
  const mod = await import('node:sqlite')
  DatabaseSyncCtor = mod.DatabaseSync ?? null
} catch {
  DatabaseSyncCtor = null
}
if (!DatabaseSyncCtor) {
  say('这台机器的 Node 取不到 node:sqlite，跳过 SQL 自检（大小已核对）')
} else {
  let db = null
  try {
    db = new DatabaseSyncCtor(liveDb)
    db.exec('PRAGMA query_only = ON')
    const integrity = db.prepare('PRAGMA integrity_check').get()
    const verdict = Object.values(integrity ?? {})[0]
    say(`integrity_check：${verdict}`)
    let total = 0
    for (const t of LEVELS) {
      const n = Number(db.prepare(`SELECT count(*) AS n FROM ${t}`).get()?.n ?? 0)
      total += n
      say(`  ${t.padEnd(8)} ${n}`)
    }
    say(`七层合计 ${total} 条`)
    if (verdict !== 'ok') die('integrity_check 不是 ok —— 这份源库自身有问题，先换一份')
  } catch (e) {
    die(`SQL 自检失败：${e?.message ?? e}`)
  } finally {
    try {
      db?.close()
    } catch {
      /* 关不掉就算了，进程马上退出 */
    }
  }
}

console.log('')
say('完成。现在重新启动 DSH，记忆库即生效。')
say(`备份（出问题先还原它）：${backupDir}`)
say('还原办法：退出 DSH → 把备份目录里的 memory.db / -wal / -shm 拷回 .dsh-meow/ → 启动。')
