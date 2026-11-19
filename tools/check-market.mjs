/**
 * 市场索引体检：`plugin-market/index.json` 是不是一份**真能被 DSH 市场读进去**的索引。
 *
 * 为什么不是「JSON 语法过了就算」：DSH 市场详情页与安装按钮都走
 * `@deepseek-ai/dsh-plugin-market-index` 的 `parseMarketIndex`，它有一整套硬规则
 * （format 必须 1、LocalizedText 必须带 en、git 源必须是 https 规范 URL + 40 位小写 commit、
 *  icon 只能是 https 或同源相对引用、publishTimestamp 是 Unix 秒、版本必须降序且不重复……）。
 * 手写一份「看起来对」的索引，最容易错的就是 commit（假的 40 个 0）和相对 icon 解析。
 * 这里直接调宿主的真校验器 + 真 git，把「能不能装」问清楚。
 *
 * 用法：node tools/check-market.mjs
 *      DSH_APP="D:\\DSH\\DSH NEXT\\resources\\app" 可覆盖宿主目录
 */
import { root } from './_root.mjs'
import { existsSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const APP = process.env.DSH_APP || 'D:\\DSH\\DSH NEXT\\resources\\app'
const NM = join(APP, 'node_modules')
const INDEX_FILE = join(root, 'plugin-market', 'index.json')
/** 索引最终会被放在仓库的这个位置；相对 icon 就是相对它解析的。 */
const INDEX_URL = 'https://raw.githubusercontent.com/OWNER/REPO/main/plugin-market/index.json'

let failed = 0
const pass = (label, detail) => console.log(`PASS  ${label}${detail === undefined ? '' : `  ${detail}`}`)
const fail = (label, detail) => {
  failed += 1
  console.log(`FAIL  ${label}${detail === undefined ? '' : `  ${detail}`}`)
}
const check = (ok, label, detail) => (ok ? pass(label, detail) : fail(label, detail))
const warn = (label, detail) => console.log(`WARN  ${label}${detail === undefined ? '' : `  ${detail}`}`)

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

// ── 1. 文件与 JSON ──────────────────────────────────────────────────────────
if (!existsSync(INDEX_FILE)) {
  fail('索引文件存在', INDEX_FILE)
  console.log('\n1 FAILED')
  process.exit(1)
}
pass('索引文件存在', `${readFileSync(INDEX_FILE).length} B`)
let raw
try {
  raw = JSON.parse(readFileSync(INDEX_FILE, 'utf8'))
  pass('索引是合法 JSON')
} catch (error) {
  fail('索引是合法 JSON', error.message)
  console.log('\n1 FAILED')
  process.exit(1)
}

// ── 2. 用宿主的真校验器读一遍 ───────────────────────────────────────────────
const indexMod = await import(
  pathToFileURL(join(NM, '@deepseek-ai', 'dsh-plugin-market-index', 'lib', 'index.js')).href
)
let index
try {
  index = indexMod.parseMarketIndex(raw, INDEX_URL)
  pass('宿主校验器接受这份索引', 'parseMarketIndex 无异常')
} catch (error) {
  fail('宿主校验器接受这份索引', `${error.path ?? ''} ${error.reason ?? error.message}`.trim())
  console.log('\n1 FAILED')
  process.exit(1)
}

check(index.format === 1, 'format 是 1', String(index.format))
check(typeof index.title === 'object' && typeof index.title.en === 'string', '索引标题带 en（LocalizedText 硬要求）')
check(typeof index.title === 'object' && typeof index.title.zh === 'string', '索引标题带 zh')

// ── 3. 本插件那一条 ─────────────────────────────────────────────────────────
const entry = index.plugins.find((p) => p.name === pkg.name)
if (entry === undefined) {
  fail('索引里有本插件', pkg.name)
  console.log('\n1 FAILED')
  process.exit(1)
}
check(index.plugins.length === 1, '索引里只有本插件一条', `${index.plugins.length} 条`)
check(entry.name === pkg.name, '插件名与 package.json 一致', entry.name)

// 版本：市场装的是「某一条 versions」，装错版本号和写错都一样致命。
const versions = entry.versions.map((v) => v.version)
check(versions[0] === pkg.version, '索引最新版本 = package.json 版本', `${versions[0]} / ${pkg.version}`)
check(new Set(versions).size === versions.length, '版本不重复', versions.join(', '))
const desc = indexMod.marketInstallTarget(entry.name, entry.versions[0])
check(
  desc.spec === `git+${entry.versions[0].source.url}.git#${entry.versions[0].source.commit}`,
  '宿主算出来的安装命令是 commit 钉住的 git 地址',
  desc.spec,
)

// ── 4. git 源：commit 必须是真的，不能用 40 个 0 占位 ────────────────────────
const source = entry.versions[0].source
check(source.type === 'git', '安装源类型是 git', source.type)
check(/^[0-9a-f]{40}$/.test(source.commit), 'commit 是 40 位小写 hex', source.commit)
check(!/^0{40}$/.test(source.commit), 'commit 不是全 0 占位（这条是给「还没提交就发索引」设的闸）')

const git = (...args) => spawnSync('git', args, { cwd: root, encoding: 'utf8' })
const isRepo = git('rev-parse', '--git-dir').status === 0
check(isRepo, '本仓是 git 仓库（市场按 commit 拉代码）', root)
if (isRepo) {
  const has = git('cat-file', '-e', `${source.commit}^{commit}`)
  check(has.status === 0, 'commit 在本仓里真实存在', source.commit)
  const head = git('rev-parse', 'HEAD').stdout.trim()
  check(/^[0-9a-f]{40}$/.test(head), 'HEAD 有提交', head)
  const reachable = source.commit === head ? 0 : git('merge-base', '--is-ancestor', source.commit, 'HEAD').status
  check(reachable === 0, 'commit 是 HEAD 或它的祖先（拉下来能装到）', source.commit === head ? '就是 HEAD' : '在历史里')
  // 索引自己也得进仓库，否则远端拿不到这份索引
  const tracked = git('ls-files', '--error-unmatch', 'plugin-market/index.json')
  check(tracked.status === 0, '索引文件已被 git 跟踪', 'plugin-market/index.json')
  const dirty = git('status', '--porcelain', '--', 'plugin-market/index.json').stdout.trim()
  if (dirty !== '') warn('索引有未提交改动', dirty)
}
check(source.url === entry.repository?.url, '安装源地址与 repository.url 一致', source.url)
check((entry.homepage ?? '').startsWith(source.url), 'homepage 指向同一仓库', entry.homepage)

// ── 5. 展示字段：市场详情页直接展示这些 ─────────────────────────────────────
check(typeof entry.title?.en === 'string' && typeof entry.title?.zh === 'string', '插件标题中英都有')
check(
  typeof entry.description?.en === 'string' && typeof entry.description?.zh === 'string',
  '插件描述中英都有',
  `${(entry.description?.zh ?? '').length} 字符(zh)`,
)
check(typeof entry.author === 'string' && entry.author.length > 0, '作者字段有值', entry.author)
check(entry.metadata.keywords.length > 0, 'keywords 非空', `${entry.metadata.keywords.length} 个`)
check(entry.metadata.category === 'memory', 'category 用了索引里声明过的 memory', entry.metadata.category)
check(
  entry.metadata.labels.every((id) => Object.hasOwn(index.metadata.labels, id)),
  'labels 都是索引声明过的',
  entry.metadata.labels.join(', '),
)

// ── 6. 图标：相对引用会相对**索引 URL** 解析 ────────────────────────────────
const icon = entry.icon
check(typeof icon === 'string' && icon.length > 0, 'icon 字段有值', icon)
if (typeof icon === 'string') {
  check(/^https:/.test(icon) || !/:\/\//.test(icon), 'icon 是 https 或相对引用', icon)
  if (!/^https?:/i.test(icon)) {
    // 索引在 plugin-market/ 下，所以相对 icon 找的是 plugin-market/ 里的文件
    const iconPath = resolve(join(root, 'plugin-market'), icon)
    check(existsSync(iconPath), '相对 icon 指向的文件在仓库里', iconPath.replace(`${root}\\`, ''))
    if (existsSync(iconPath)) {
      const head = readFileSync(iconPath).subarray(0, 8)
      const isPng = head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47
      const isJpeg = head[0] === 0xff && head[1] === 0xd8
      const isWebp = head.subarray(0, 4).toString('latin1') === 'RIFF'
      check(isPng || isJpeg || isWebp, 'icon 真是 PNG / JPEG / WebP', `${readFileSync(iconPath).length} B`)
      check(readFileSync(iconPath).length <= 512 * 1024, 'icon 不超过 512 KiB（详情页加载体验）', `${readFileSync(iconPath).length} B`)
    }
  } else {
    check(indexMod.MAX_INLINE_ICON_BYTES === 32 * 1024, '宿主的内联 icon 上限仍是 32 KiB', String(indexMod.MAX_INLINE_ICON_BYTES))
  }
}

// ── 7. 时间戳：市场按 Unix 秒展示「更新时间」────────────────────────────────
const now = Math.floor(Date.now() / 1000)
check(
  Number.isInteger(entry.versions[0].publishTimestamp) && entry.versions[0].publishTimestamp <= now + 86400,
  'publishTimestamp 是合理的时间（不是毫秒、不在未来）',
  `${entry.versions[0].publishTimestamp}`,
)

// ── 8. 市场详情页会去仓库根读 README ────────────────────────────────────────
check(existsSync(join(root, 'README.md')), '仓库根的 README.md 存在（详情页读它）', 'README.md')
check(existsSync(join(root, 'LICENSE')), '仓库根的 LICENSE 存在（MIT 要随包）', 'LICENSE')

console.log(`\n索引：${INDEX_FILE}`)
console.log(`  插件 ${entry.name}@${versions[0]} · commit ${source.commit.slice(0, 12)}…`)
console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
