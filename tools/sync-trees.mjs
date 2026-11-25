#!/usr/bin/env node
/**
 * sync-trees.mjs — 把本仓同步到另外两棵「读者树」，一条命令做完，别再靠记性。
 *
 * 为什么要有这一支（2026-11-23 之后补）：
 *   本仓有三份活拷贝，职责不同：
 *     1) 源树 / 工作树   D:\dsh-home\vendor\dsh-macro-memory          —— 这里改代码、跑闸门、提交
 *     2) 阅读树          D:\document\DSH Memory Macro-Regulation System —— 人读的副本
 *     3) 装机树          %DSH_HOME%\profiles\desktop\node_modules\dsh-macro-memory
 *                        —— **DSH 真正加载的那份**，doctor 的「两处比较」与 probe-load 都看它
 *   少同步一棵树的后果，这一轮踩了五六次：doctor 报 `两处不一致 1 个漂移`、
 *   probe-load 报 `装的是 0.5.0，本仓是 0.6.0 —— DSH 会跑旧代码`。
 *
 * 用法：
 *   node tools/sync-trees.mjs            # 只体检：三棵树差多少文件，不写盘（默认）
 *   node tools/sync-trees.mjs --apply    # 真同步（robocopy /E，只增改，**从不删**）
 *   node tools/sync-trees.mjs --apply --target=inst   # 只同步装机树（doc / inst / all）
 *
 * 纪律：
 *   - 一律 `robocopy /E`（只复制），**绝不用 /MIR /PURGE**——批量删除要先问主人。
 *   - 跳过 `node_modules` 与 `.git`：前者是 junction/安装产物，后者各树各自的历史。
 *   - 同步完不会自动跑 make-vendor-manifest / doctor：这两步会改文件、会判红，
 *     留给调用者按顺序做（脚本末尾会把命令打出来）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const APPLY = process.argv.includes('--apply')
const targetArg = (process.argv.find((a) => a.startsWith('--target=')) || '').slice('--target='.length) || 'all'

const DSH_HOME = process.env.DSH_HOME || 'D:\\dsh-home'
const TARGETS = [
  { key: 'doc', label: '阅读树', dir: 'D:\\document\\DSH Memory Macro-Regulation System' },
  { key: 'inst', label: '装机树', dir: path.join(DSH_HOME, 'profiles', 'desktop', 'node_modules', 'dsh-macro-memory') },
].filter((t) => targetArg === 'all' || targetArg === t.key)

if (!TARGETS.length) {
  console.error(`[sync] --target 只能是 doc / inst / all，收到：${targetArg}`)
  process.exit(2)
}

// 运行时数据目录：里面是活的数据库、日志、会话与附件——**任何情况下都不搬**。
// 2026-11-25 16:38 的事故就是这一条缺失造成的：robocopy 只排 node_modules/.git，
// 于是把源树里那份 4,096 字节的空壳 fixture `memory.db`（+152,472 字节 fixture WAL）
// 覆盖到了阅读树的活库上，活库当场报废、2,600 多条记忆只剩能从句读转写里抠回来的部分。
// 教训：**代码同步器不许碰运行时数据，一个字节都不碰**，排除表要跟 SKIP_DIRS 同源。
const RUNTIME_DIRS = ['.dsh-meow', '.analysis', 'sessions', 'attachments', 'logs']
const SKIP_DIRS = new Set(['node_modules', '.git', ...RUNTIME_DIRS])
const SKIP_FILES = new Set(['.DS_Store', 'Thumbs.db'])
// 兜底：只要长得像数据库（含 SQLite 的 -wal/-shm 伴生文件），无论躺在哪个目录里都不复制。
const RUNTIME_FILE_RE = /(\.(db|db-wal|db-shm|db-journal|sqlite|sqlite3|s3db))$/i
const RUNTIME_FILE_GLOBS = ['*.db', '*.db-wal', '*.db-shm', '*.db-journal', '*.sqlite', '*.sqlite3']

function walk(dir, out = [], prefix = '') {
  let ents
  try {
    ents = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of ents) {
    const rel = prefix ? prefix + '/' + e.name : e.name
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue
      walk(path.join(dir, e.name), out, rel)
    } else if (e.isFile()) {
      if (SKIP_FILES.has(e.name)) continue
      if (RUNTIME_FILE_RE.test(e.name)) continue
      out.push(rel)
    }
  }
  return out
}

/** 差多少：只比大小与修改时间，够判断「要不要同步」了。 */
function diffOf(srcDir, dstDir) {
  const src = walk(srcDir)
  const srcSet = new Set(src)
  let changed = 0
  let missing = 0
  let same = 0
  for (const rel of src) {
    const a = path.join(srcDir, rel)
    const b = path.join(dstDir, rel)
    let sa, sb
    try {
      sa = fs.statSync(a)
    } catch {
      continue
    }
    try {
      sb = fs.statSync(b)
    } catch {
      missing++
      continue
    }
    if (sa.size !== sb.size || Math.abs(sa.mtimeMs - sb.mtimeMs) > 1000) changed++
    else same++
  }
  let extra = 0
  for (const rel of walk(dstDir)) if (!srcSet.has(rel)) extra++
  return { total: src.length, same, changed, missing, extra }
}

function robocopy(src, dst) {
  fs.mkdirSync(dst, { recursive: true })
  const r = spawnSync(
    'robocopy',
    [
      src, dst, '/E',
      '/XD', ...SKIP_DIRS,
      '/XF', ...RUNTIME_FILE_GLOBS,
      '/NFL', '/NDL', '/NJH', '/NJS', '/R:1', '/W:1',
    ],
    { stdio: 'inherit' },
  )
  // 排除表与 diffOf 的 SKIP_DIRS / RUNTIME_FILE_RE 同源：
  // 少排一个 `.dsh-meow` 就会去复制活着的 SQLite（-wal/-shm 被别的进程 map 着，
  // 报 ERROR 1224 整趟失败）；更糟的是**它会真的覆盖过去**——2026-11-25 16:38 就是这么
  // 用源树里的 fixture 空壳库盖掉了阅读树的活库。所以这里既排目录也排文件。
  // robocopy：0 = 没变化，1 = 有复制，2/3 = 有额外/复制+额外，>=8 = 出错
  const code = r.status === null ? 16 : r.status
  return { code, ok: code < 8 }
}

/**
 * 运行时数据的指纹（每个目标树的 .dsh-meow 三件套 + 其它库文件）。
 * 同步前后各取一次：**一旦变了就是同步器动了不属于它的东西**，当场判失败、不许往下走。
 */
function runtimeSnapshot(dir) {
  const out = {}
  const meow = path.join(dir, '.dsh-meow')
  let ents = []
  try {
    ents = fs.readdirSync(meow, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of ents) {
    if (!e.isFile()) continue
    if (!RUNTIME_FILE_RE.test(e.name)) continue
    try {
      const s = fs.statSync(path.join(meow, e.name))
      out['.dsh-meow/' + e.name] = `${s.size}@${Math.round(s.mtimeMs)}`
    } catch {
      out['.dsh-meow/' + e.name] = 'missing'
    }
  }
  return out
}

/** 源树里混进运行时数据的检查：walk 已经跳过这些文件，这里只负责「有没有」并告警。 */
function strayRuntimeFiles(dir) {
  const hits = []
  const walkAll = (d, prefix = '') => {
    let ents = []
    try {
      ents = fs.readdirSync(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of ents) {
      const rel = prefix ? prefix + '/' + e.name : e.name
      if (e.isDirectory()) {
        if (e.name === 'node_modules' || e.name === '.git') continue
        walkAll(path.join(d, e.name), rel)
      } else if (e.isFile() && RUNTIME_FILE_RE.test(e.name)) {
        hitAdd(rel)
      }
    }
  }
  const hitAdd = (rel) => hits.push(rel)
  walkAll(dir)
  return hits
}

let bad = 0

// 源树里混进来的运行时数据库：先点名（它们不会被复制，但要知道自己踩了什么）。
const strays = strayRuntimeFiles(ROOT)
if (strays.length) {
  console.log(`[sync] 源树里有 ${strays.length} 个运行时数据库文件，一律不复制：`)
  for (const s of strays.slice(0, 6)) console.log(`       ${s}`)
  if (strays.length > 6) console.log(`       …还有 ${strays.length - 6} 个`)
}

for (const t of TARGETS) {
  const beforeRt = runtimeSnapshot(t.dir)
  const d = diffOf(ROOT, t.dir)
  const head = `[sync] ${t.label} ${t.dir}`
  console.log(head)
  console.log(
    `       源 ${d.total} 个文件 → 同名同大小 ${d.same}｜内容/时间不同 ${d.changed}｜对方缺 ${d.missing}｜对方多 ${d.extra}`,
  )
  if (!APPLY) {
    if (d.changed + d.missing > 0) console.log('       （未写盘；加 --apply 才复制）')
    continue
  }
  const r = robocopy(ROOT, t.dir)
  console.log(`       robocopy exit=${r.code} ${r.ok ? '已同步（/E，只增改，不删除）' : '失败'}`)
  if (!r.ok) bad++
  const afterRt = runtimeSnapshot(t.dir)
  const touched = [...new Set([...Object.keys(beforeRt), ...Object.keys(afterRt)])].filter(
    (k) => beforeRt[k] !== afterRt[k],
  )
  if (touched.length) {
    console.log(`       ! 运行时数据被动了（同步器越界）：${touched.join('、')}`)
    bad++
  } else {
    console.log('       运行时数据未被动过（.dsh-meow 的库文件大小/时间戳逐项一致）')
  }
  const after = diffOf(ROOT, t.dir)
  if (after.changed + after.missing > 0) {
    console.log(`       同步后仍有差异：内容/时间不同 ${after.changed}｜对方缺 ${after.missing}`)
    bad++
  }
}

if (APPLY) {
  console.log('\n[sync] 下一步（顺序别换）：')
  console.log('  node tools/make-vendor-manifest.mjs   # 只有 vendor 里两个引擎变动时才需要，跑完重记指纹')
  console.log('  node tools/doctor.mjs                 # 期望「结果：ALL PASS」')
  if (bad) {
    console.log(`\n[sync] ${bad} 个目标没同步干净。`)
    process.exit(1)
  }
}
