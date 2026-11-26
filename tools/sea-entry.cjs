/**
 * 单文件二进制的引导器（被 tools/build-sea.mjs 打进 SEA 主脚本位）。
 *
 * 为什么是 `.cjs` 而不是 `.mjs`：Node 的 SEA 把内嵌主脚本按 CommonJS 加载，
 * `.mjs` 主脚本在这台机器的 Node 24.17 上会报
 * 「Failed to load the ES module … set "type": "module"」——
 * 而单文件产物里没有外层 package.json 可以设 type。写成 CJS、用 `await import()`
 * 去加载解包出来的真入口，两种情况都成立。
 *
 * 它做四件事，别的什么都不做：
 *   1. 从自身拿记忆包（`node:sea` 的 `getAsset('bundle.mmb')`）；
 *   2. 校验包头 `MMB1` 并解出 manifest；
 *   3. 解到临时目录（按包的 sha256 前 16 位分目录，同一版只解一次）；
 *   4. 归一 `process.argv`（SEA 里 argv[1] 就是 exe 自己，会让 `slice(2)` 少一个参数）
 *      然后 `import()` 真正的 bin/macro-memory.mjs。
 */

const { createRequire } = require('node:module')
const { existsSync, mkdirSync, writeFileSync } = require('node:fs')
const { createHash } = require('node:crypto')
const { tmpdir } = require('node:os')
const { dirname, join } = require('node:path')
const { pathToFileURL } = require('node:url')

const ASSET = 'bundle.mmb'

function die(msg, code) {
  process.stderr.write(String(msg) + '\n')
  process.exit(code)
}

async function boot() {
  const req = createRequire(process.execPath)
  let asset
  try {
    asset = req('node:sea').getAsset(ASSET)
  } catch (err) {
    die('macro-memory：这个可执行文件里没有记忆包（不是用 tools/build-sea.mjs 打出来的？）\n' + String((err && err.message) || err), 2)
  }

  const buf = Buffer.from(asset)
  const nl1 = buf.indexOf(0x0a)
  const nl2 = nl1 < 0 ? -1 : buf.indexOf(0x0a, nl1 + 1)
  if (nl1 < 0 || nl2 < 0 || buf.subarray(0, nl1).toString('utf8') !== 'MMB1') {
    die('macro-memory：记忆包头坏了（MMB1 标记不在）', 2)
  }

  let manifest
  try {
    manifest = JSON.parse(buf.subarray(nl1 + 1, nl2).toString('utf8'))
  } catch (err) {
    die('macro-memory：记忆包 manifest 不是 JSON\n' + String((err && err.message) || err), 2)
  }
  if (!manifest || !Array.isArray(manifest.files)) die('macro-memory：记忆包 manifest 里没有 files', 2)

  const dataStart = nl2 + 1
  const stamp = createHash('sha256').update(buf).digest('hex').slice(0, 16)
  const base = join(tmpdir(), 'macro-memory-sea-' + stamp)
  const entry = join(base, 'bin', 'macro-memory.mjs')

  if (!existsSync(entry)) {
    for (const f of manifest.files) {
      const abs = join(base, String(f.path))
      mkdirSync(dirname(abs), { recursive: true })
      writeFileSync(abs, buf.subarray(dataStart + f.offset, dataStart + f.offset + f.size))
    }
  }

  // SEA 里 argv = [exe, exe, ...用户参数]；直接 slice(2) 会少一个参数。
  const argv = process.argv.slice()
  if (process.env.MACRO_MEMORY_SEA_DEBUG === '1') process.stderr.write('ARGV ' + JSON.stringify(argv) + '\n')
  const skip = argv.length > 1 && argv[1] === process.execPath ? 2 : 1
  const userArgs = argv.slice(skip)
  process.argv.length = 0
  process.argv.push(process.execPath, entry, ...userArgs)

  await import(pathToFileURL(entry).href)
}

boot().catch((err) => {
  die('macro-memory 启动失败：' + String((err && err.stack) || err), 2)
})
