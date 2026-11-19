#!/usr/bin/env node
/**
 * 生成 vendor 账本 `vendor/VENDOR.json`：这两个子插件是**拷贝**进来的源码，不是 npm 依赖，
 * 所以「它有没有被谁改过、改的是不是我们」只能靠账本记住。
 *
 * 用法：node tools/make-vendor-manifest.mjs          # 重写账本
 *       node tools/make-vendor-manifest.mjs --print  # 只打印，不写盘
 *
 * 注意：`tools/doctor.mjs` 的 PATCHES 是我们**故意**打的补丁（按内容断言在位），账本记的是
 * 「vendor 目录当前长这样」，两者互补：账本防外人乱改，PATCHES 防我们改丢。
 */
import { root } from './_root.mjs'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { hashTree, vendorPackage } from './vendor-hash.mjs'

const MANIFEST = 'vendor/VENDOR.json'

/** 账本要盯的目录（写死，避免「新拷贝一个目录进来但没人记账」；doctor 会反向核对有没有漏账）。 */
export const VENDOR_DIRS = ['vendor/meow-memory', 'vendor/dsh-memory-nebula']

const vendors = []
for (const rel of VENDOR_DIRS) {
  const abs = join(root, rel)
  if (!existsSync(abs)) throw new Error(`vendor 目录不存在：${rel}`)
  const pkg = vendorPackage(abs)
  const tree = hashTree(abs)
  vendors.push({
    dir: rel,
    name: pkg?.name ?? null,
    version: pkg?.version ?? null,
    files: tree.files,
    bytes: tree.bytes,
    sha256: tree.sha256,
  })
}

const manifest = {
  note: 'vendor 账本：这里的源码是从上游拷贝进来的（不是 npm 依赖）。改了就重跑 tools/make-vendor-manifest.mjs；doctor 会核对。',
  generatedBy: 'tools/make-vendor-manifest.mjs',
  hashedBy: 'tools/vendor-hash.mjs',
  vendors,
}

const text = JSON.stringify(manifest, null, 2) + '\n'
if (process.argv.includes('--print')) {
  process.stdout.write(text)
} else {
  writeFileSync(join(root, MANIFEST), text, 'utf8')
  for (const v of vendors) console.log(`记账：${v.dir}  ${v.name}@${v.version}  ${v.files} 文件 / ${v.bytes} B / ${v.sha256.slice(0, 16)}`)
  console.log(`写入 ${MANIFEST}`)
}
