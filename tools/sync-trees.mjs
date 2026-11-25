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

// 这两个是运行时数据目录（星图库、分析产物），源树没有、也不该往源树同步，
// 统计「对方多」时直接跳过，免得 2,000 多个文件把真正要同步的差异埋掉。
const SKIP_DIRS = new Set(['node_modules', '.git', '.analysis', '.dsh-meow'])
const SKIP_FILES = new Set(['.DS_Store', 'Thumbs.db'])

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
    [src, dst, '/E', '/XD', ...SKIP_DIRS, '/NFL', '/NDL', '/NJH', '/NJS', '/R:1', '/W:1'],
    { stdio: 'inherit' },
  )
  // 排除表与 diffOf 的 SKIP_DIRS 同源：只排 node_modules / .git 时，robocopy 会去复制
  // `.dsh-meow/` 里那份活着的 SQLite（-wal/-shm 被别的进程 map 着），报 ERROR 1224 并整趟判失败。
  // robocopy：0 = 没变化，1 = 有复制，2/3 = 有额外/复制+额外，>=8 = 出错
  const code = r.status === null ? 16 : r.status
  return { code, ok: code < 8 }
}

let bad = 0
for (const t of TARGETS) {
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
