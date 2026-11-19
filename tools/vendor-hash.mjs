/**
 * vendor 账本的共用算法：目录清单 + 逐文件 sha256 + 聚合指纹。
 *
 * 生成方（tools/make-vendor-manifest.mjs）与核对方（tools/doctor.mjs）必须用**同一份实现**，
 * 否则「我算出来的和你算出来的不一样」会变成两个脚本各说各话——这正是账本类功能最容易烂掉的地方。
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

/** 这些目录不是 vendor 的交付内容，账本不记。 */
export const SKIP_DIRS = new Set(['node_modules', '.git', '.probe-home'])

/** 递归列出相对路径（posix 风格），跳过 SKIP_DIRS。 */
export function listFiles(dir, base = dir, out = []) {
  if (!existsSync(dir)) return out
  for (const name of readdirSync(dir).sort()) {
    if (SKIP_DIRS.has(name)) continue
    const abs = join(dir, name)
    const st = statSync(abs)
    if (st.isDirectory()) listFiles(abs, base, out)
    else out.push(relative(base, abs).replace(/\\/g, '/'))
  }
  return out
}

export const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')

/**
 * 一棵目录树的指纹：文件数、总字节、以及「按路径排序后 `rel:sha` 逐行拼接」的 sha256。
 * 聚合指纹只用 16 位前缀写进账本（够防篡改，又不至于让人以为那是可验证签名）。
 */
export function hashTree(dir) {
  const files = listFiles(dir).sort()
  const agg = createHash('sha256')
  let bytes = 0
  for (const rel of files) {
    const buf = readFileSync(join(dir, rel))
    bytes += buf.length
    agg.update(`${rel}:${sha256(buf)}\n`)
  }
  return { files: files.length, bytes, sha256: agg.digest('hex') }
}

/** 读某个 vendor 目录里的 package.json（没有就返回 null）。 */
export function vendorPackage(dir) {
  const p = join(dir, 'package.json')
  if (!existsSync(p)) return null
  try {
    const pkg = JSON.parse(readFileSync(p, 'utf8'))
    return { name: pkg.name, version: pkg.version }
  } catch {
    return null
  }
}
