/**
 * 把 L0 写进宿主的「规矩文件」（AGENTS.md / CLAUDE.md / .cursor/rules/*）——
 * PLAN-UNIVERSAL §8.3 的文件围栏，唯一会碰用户文件的能力。
 *
 * 这一层只管读/写/删，语言与判断都留在 fence.js；CLI 只负责打印。三条不可越线：
 *  · 坏块（begin 在、end 不在）一律拒改，把决定权交回用户；
 *  · 写盘用 utf8 无 BOM，且保留文件原有的 BOM（如果本来有）；
 *  · 摘完只剩空白 → 删文件（留一个空 AGENTS.md 比不写更脏），并在回执里说清楚。
 */
import fs from 'node:fs'
import path from 'node:path'
import { spliceBlock, stripBlock, locate, looksEmpty, detectEol } from './fence.js'

/** 默认写 AGENTS.md：Codex、Cursor、Aider、大多数 MCP 宿主都认这个名字。 */
export const DEFAULT_TARGETS = ['AGENTS.md']

/** `--file a,b --file c` → ['AGENTS.md'…] 覆盖：rel 路径按工作区解析。 */
export function resolveTargets(cwd, { files } = {}) {
  const list = []
  const push = (v) => {
    if (typeof v !== 'string') return
    for (const piece of v.split(',')) {
      const s = piece.trim()
      if (s.length > 0) list.push(path.resolve(cwd, s))
    }
  }
  if (Array.isArray(files)) files.forEach(push)
  else push(files)
  if (list.length === 0) for (const t of DEFAULT_TARGETS) list.push(path.resolve(cwd, t))
  return [...new Set(list)]
}

function readTarget(p) {
  try {
    const raw = fs.readFileSync(p, 'utf8')
    return { exists: true, text: raw, bom: raw.startsWith('\uFEFF') }
  } catch (err) {
    if (err.code === 'ENOENT') return { exists: false, text: '', bom: false }
    throw err
  }
}

function writeTarget(p, text, bom) {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, (bom ? '\uFEFF' : '') + text, 'utf8')
}

/**
 * 写入或刷新块。返回 `{ path, action, chars, bytes, eol }`；
 * action ∈ created | appended | replaced。坏块抛错，不擅自修。
 */
export function applyBlock(p, l0) {
  const cur = readTarget(p)
  const hit = cur.exists ? locate(cur.text) : null
  if (hit?.broken) {
    const err = new Error(`${p} 里有 macro-memory 的 begin 标记但没有 end（多半被手改坏），先修好或删掉那半块再跑`)
    err.code = 'MACRO_FENCE_BROKEN'
    throw err
  }
  const res = spliceBlock(cur.text, l0)
  if (res.text !== cur.text) writeTarget(p, res.text, cur.bom)
  return {
    path: p,
    action: res.action,
    chars: l0.length,
    bytes: Buffer.byteLength(res.text, 'utf8'),
    eol: detectEol(cur.text),
  }
}

/**
 * 摘块。`{ path, status, deleted, broken }`；status ∈ removed | absent | skipped。
 * 摘完只剩空白就删文件——只有当我们真的改动了它才删。
 */
export function removeBlock(p) {
  const cur = readTarget(p)
  if (!cur.exists) return { path: p, status: 'absent', deleted: false, broken: false }
  const res = stripBlock(cur.text)
  if (res.broken) return { path: p, status: 'skipped', deleted: false, broken: true }
  if (!res.removed) return { path: p, status: 'absent', deleted: false, broken: false }
  if (looksEmpty(res.text)) {
    fs.unlinkSync(p)
    return { path: p, status: 'removed', deleted: true, broken: false }
  }
  writeTarget(p, res.text, cur.bom)
  return { path: p, status: 'removed', deleted: false, broken: false }
}

/** 只读检查：文件里有没有块、块是否完整——给 doctor / init 打印用。 */
export function inspectBlock(p) {
  const cur = readTarget(p)
  if (!cur.exists) return { path: p, exists: false, has: false, broken: false }
  const hit = locate(cur.text)
  return { path: p, exists: true, has: Boolean(hit), broken: Boolean(hit?.broken), bytes: Buffer.byteLength(cur.text, 'utf8') }
}
