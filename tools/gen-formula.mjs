#!/usr/bin/env node
/**
 * 把一次构建的 SHA256SUMS 灌进 Homebrew formula（PLAN-UNIVERSAL §11.4 / P2-5）。
 *
 *   node tools/gen-formula.mjs                                  体检：四个占位现在是什么
 *   node tools/gen-formula.mjs --sums <目录>                     体检：用那个目录的 SHA256SUMS 算一遍
 *   node tools/gen-formula.mjs --apply --sums <目录>             真写 packaging/homebrew/macro-memory.rb
 *
 * 它只做一件事：把 `version` 与四个平台的 `sha256`（还有 url 里的 owner 与仓库名）
 * 从「根 package.json + SHA256SUMS.txt」同步进 formula。
 *
 * 纪律：
 *   - 默认不写盘，`--apply` 才写；
 *   - **缺哪个平台的产物就保留那个占位**，并在报告里点名——半份 sha 的 formula 修不了，
 *     只能等那个平台打出来；宁可让它明着是占位，也不许填一个猜的哈希；
 *   - **永不 publish、永不 push**：tap 仓库由人推，`brew install` 也用不到脚本。
 *
 * 为什么 sha256 不能手抄：92 MB 的产物每打一次都不一样（postject 注入的段与时间戳
 * 都会变），手抄一次就等于把「上一次的哈希」发给下一次的下载者。
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const FORMULA = path.join(ROOT, 'packaging', 'homebrew', 'macro-memory.rb')

/** 四个平台，与 tools/build-sea.mjs 的 --target 同名。 */
const TARGETS = ['mac-arm64', 'mac-x64', 'linux-arm64', 'linux-x64']
const placeholderOf = (target) => '__SHA256_' + target.replace(/-/g, '_').toUpperCase() + '__'

const args = process.argv.slice(2)
const flag = (name) => args.includes('--' + name)
const opt = (name) => {
  const i = args.indexOf('--' + name)
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : null
}

const apply = flag('apply')
const sumsDir = opt('sums')

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}
const pkg = readJson(path.join(ROOT, 'package.json'))

/** 从 owner/repo 推出 formula 里的两个替换目标。 */
function repoInfo() {
  const url = String(pkg.repository?.url ?? pkg.homepage ?? '')
  const m = url.match(/github\.com[/:]([^/]+)\/([^/.]+)/)
  if (!m) throw new Error('package.json 里找不到 github 的 owner/repo：先看 repository.url')
  return { owner: m[1], repo: m[2] }
}

/** 读 SHA256SUMS.txt（`<sha>  <文件名>`，也容忍 `<sha> *<文件名>` 与 CRLF）。 */
function readSums(dir) {
  const file = path.join(dir, 'SHA256SUMS.txt')
  if (!fs.existsSync(file)) throw new Error(`--sums 目录里没有 SHA256SUMS.txt：${file}`)
  const map = new Map()
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.trim().match(/^([0-9a-fA-F]{64})\s+\*?(\S+)$/)
    if (m) map.set(path.basename(m[2]), m[1].toLowerCase())
  }
  return map
}

function main() {
  if (!fs.existsSync(FORMULA)) throw new Error(`formula 不在：${FORMULA}`)
  const src = fs.readFileSync(FORMULA, 'utf8')
  const { owner, repo } = repoInfo()
  const sums = sumsDir ? readSums(sumsDir) : null

  const notes = []
  let next = src

  // 1. 版本号：formula 的 version 永远跟根 package.json 走。
  const versionRe = /^(\s*version\s+")([^"]*)(")/m
  const verMatch = next.match(versionRe)
  if (!verMatch) throw new Error('formula 里没有 version 这一行')
  const changedVersion = verMatch[2] !== pkg.version
  next = next.replace(versionRe, `$1${pkg.version}$3`)
  notes.push({ item: 'version', from: verMatch[2], to: pkg.version, changed: changedVersion })

  // 2. owner / repo：仓库改名之后 formula 也得跟着走（P2-3 的连带项）。
  const oldRepo = /github\.com\/([^/]+)\/([^/]+)\/releases/g
  const seen = new Set()
  let m
  while ((m = oldRepo.exec(src))) seen.add(`${m[1]}/${m[2]}`)
  for (const pair of seen) {
    if (pair !== `${owner}/${repo}`) {
      next = next.split(`github.com/${pair}/`).join(`github.com/${owner}/${repo}/`)
      notes.push({ item: 'owner/repo', from: pair, to: `${owner}/${repo}`, changed: true })
    } else {
      notes.push({ item: 'owner/repo', from: pair, to: pair, changed: false })
    }
  }

  // 3. 四个 sha256：有产物就换，没产物就保留占位并点名。
  const shaState = []
  for (const target of TARGETS) {
    const file = `macro-memory-${target}`
    const sha = sums?.get(file) ?? null
    const re = new RegExp(`(macro-memory-${target}"\\s*\\r?\\n\\s*sha256 ")([^"]*)(")`)
    const hit = next.match(re)
    if (!hit) {
      shaState.push({ target, sha, changed: false, prev: null })
      continue
    }
    const prev = hit[2]
    if (!sha) {
      shaState.push({ target, sha: null, changed: false, prev })
      continue
    }
    if (prev !== sha) {
      next = next.replace(re, `$1${sha}$3`)
      shaState.push({ target, sha, changed: true, prev })
    } else {
      shaState.push({ target, sha, changed: false, prev })
    }
  }
  const missing = shaState.filter((s) => !s.sha).map((s) => s.target)
  const stillPlaceholder = TARGETS.filter((t) => next.includes(placeholderOf(t)))

  return { next, notes, shaState, missing, stillPlaceholder, owner, repo }
}

try {
  const r = main()
  const changed = r.next !== fs.readFileSync(FORMULA, 'utf8')
  console.log('formula：' + path.relative(ROOT, FORMULA))
  console.log('  仓库：' + r.owner + '/' + r.repo + ' · 版本：' + pkg.version)
  for (const n of r.notes) console.log(`  ${n.changed ? '改' : '不变'} ${n.item}：${n.from} → ${n.to}`)
  for (const s of r.shaState) {
    console.log(`  ${s.sha ? (s.changed ? '改' : '不变') : '缺'} sha256 ${s.target}：${s.sha ? s.sha.slice(0, 16) + '…' : '这个平台的产物还没打出来，占位保留'}`)
  }
  if (r.missing.length) console.log('  缺产物的平台：' + r.missing.join(', ') + '（等 tools/build-sea.mjs 打出来再灌）')
  if (r.stillPlaceholder.length) console.log('  仍是占位的：' + r.stillPlaceholder.join(', ') + '——半份 sha 的 formula 装不了，别发')

  if (!apply) {
    console.log(changed ? '\n体检模式：会改（加 --apply 才写）' : '\n体检模式：什么都不用改')
    process.exit(0)
  }
  if (!changed) {
    console.log('\n没有可写的变化')
    process.exit(0)
  }
  fs.writeFileSync(FORMULA, r.next, 'utf8')
  console.log('\n已写：' + path.relative(ROOT, FORMULA))
  console.log('复核：brew audit --strict --new packaging/homebrew/macro-memory.rb（要在 mac 上跑）')
  console.log('回滚：git checkout -- packaging/homebrew/macro-memory.rb')
  process.exit(0)
} catch (err) {
  console.error('✗ ' + String(err?.message ?? err))
  process.exit(2)
}
