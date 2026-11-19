#!/usr/bin/env node
// 加载面探针：不问自己，问 DSH 自己。
//
// 为什么不手抄一份「DSH 认为什么叫能加载」：
// 判据在 DSH 的 app-boot 里 —— engines.dsh / peerDependencies 的版本范围、
// dsh.bundle.patch 必须存在且能被它自己的补丁解析器读懂、dsh.bundle.platforms 必须允许本机、
// bundle 必须能从安装锚点或 profile 里解析出目录。抄第二份就等于抄第二份真相，
// 上游一改就悄悄过期（0.2.22 的三份清单已经教过一次）。
//
// 所以这里直接 import 装好的 @deepseek-ai/dsh-app-boot，用它的函数问：
//   readProfileManifest / readProfileVersionExemptions / resolveBundleDir /
//   bundlePatchPaths / assertBundlePlatform / evaluatePluginCompatibility /
//   loadOverlayPatches / pluginCompatibilityWarning / getDshRuntimeVersion
// 全程只读：不写 profile 清单、不 apply 补丁、不启动插件、不碰运行中的 DSH。
//
// 找不到 DSH 安装 → FAIL（这一条查不了，不能假装绿；用 DSH_APP_DIR 指过去）。
// profile 用 DSH_PROFILE 覆盖，默认 desktop。

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { root } from './_root.mjs'
import { pathToFileURL } from 'node:url'

const BIN = 'dsh'
const PACKAGE = 'dsh-macro-memory'
const ENGINES = ['meow-memory', 'dsh-memory-nebula']

let fails = 0
const pass = (what, detail) => console.log(`PASS  ${what}${detail === undefined ? '' : `：${detail}`}`)
const fail = (what, detail) => {
  fails += 1
  console.log(`FAIL  ${what}${detail === undefined ? '' : `：${detail}`}`)
}

const home = process.env.DSH_HOME || join(homedir(), '.dsh')
const profileName = process.env.DSH_PROFILE || 'desktop'
const profileDir = join(home, 'profiles', profileName)

/** 找 DSH 安装根（含 resources/app/node_modules/@deepseek-ai/dsh-app-boot 的那一层）。 */
function findAppRoot() {
  const APP_BOOT = 'node_modules/@deepseek-ai/dsh-app-boot/lib/index.js'
  const fromEnv = process.env.DSH_APP_DIR
  if (fromEnv) return existsSync(join(fromEnv, APP_BOOT)) ? fromEnv : undefined
  const candidates = ['D:/DSH/DSH NEXT/resources/app', 'C:/Program Files/DSH/resources/app', 'C:/Program Files (x86)/DSH/resources/app']
  // 兜底：扫各盘根下一层的 <名字>/resources/app，够浅，不会把整盘走一遍。
  for (const drive of ['D:', 'C:']) {
    try {
      for (const name of readdirSync(`${drive}/`)) {
        if (/^\$|^System Volume Information$|^Windows$/i.test(name)) continue
        candidates.push(`${drive}/${name}/resources/app`, `${drive}/${name}/DSH/resources/app`)
      }
    } catch { /* 盘不可读就算了 */ }
  }
  return candidates.find((dir) => existsSync(join(dir, APP_BOOT)))
}

const appRoot = findAppRoot()
if (appRoot === undefined) {
  fail('找得到 DSH 安装', '没有找到含 @deepseek-ai/dsh-app-boot 的 resources/app（用 DSH_APP_DIR 指过去）')
  console.log(`\n结果：1/1 条失败 —— 加载面这一条查不了，不许当绿`)
  process.exit(1)
}
pass('找得到 DSH 安装', appRoot)

const mod = await import(pathToFileURL(join(appRoot, 'node_modules/@deepseek-ai/dsh-app-boot/lib/index.js')).href)
const runtimeVersion = mod.getDshRuntimeVersion()
pass('DSH 运行时版本取自 app-boot 自己的 package.json', runtimeVersion)

/** 用 DSH 的判据算一个目录「能不能作为 bundle 加载」，返回问题描述或 undefined。 */
function loadIssue(dir, exemptions) {
  let manifest
  try {
    manifest = mod.readProfileManifest(BIN, dir)
  } catch (error) {
    return String(error)
  }
  const bundle = manifest.dsh?.bundle
  if (bundle === undefined) return 'package.json 里没有 dsh.bundle'
  try {
    mod.assertBundlePlatform(bundle.platforms, process.platform)
  } catch (error) {
    return String(error)
  }
  const issue = mod.evaluatePluginCompatibility(manifest, exemptions)
  if (issue !== undefined && !issue.exempted) return mod.pluginCompatibilityWarning(issue)
  try {
    for (const file of mod.bundlePatchPaths(dir, bundle)) {
      const patches = mod.loadOverlayPatches(BIN, file)
      if (!Array.isArray(patches)) return `补丁不是数组：${file}`
    }
  } catch (error) {
    return String(error)
  }
  return undefined
}

const installed = mod.readProfileManifest(BIN, profileDir)
const bundles = installed.dsh?.profile?.bundles ?? []
if (bundles.includes(PACKAGE)) pass('profile 清单里列了本插件', `${profileName}：${bundles.length} 个 bundle`)
else {
  fail('profile 清单里列了本插件', `bundles=${JSON.stringify(bundles)}`)
  console.log(`\n结果：${fails} 条失败 —— 清单里没有它，后面查什么都没意义`)
  process.exit(1)
}

const exemptions = mod.readProfileVersionExemptions(profileDir)
const resolved = mod.resolveBundleDir(BIN, PACKAGE, join(appRoot, 'package.json'), profileDir)
pass('DSH 能把 bundle 解析到目录', resolved)

// DSH 加载的是 profile 里装好的那一份（我们靠 robocopy 同步），不是 vendor 源码本身。
// 所以这里不问「是不是同一个目录」，只问「装的那份是不是本仓这一版」——目录一致性由
// doctor 的「两处字节一致」负责，这里管的是加载面自己的事。
const repoVersion = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version
const installedVersion = JSON.parse(readFileSync(join(resolved, 'package.json'), 'utf8')).version
if (installedVersion === repoVersion) pass('DSH 加载的那份与本仓同版', `${installedVersion} @ ${resolved}`)
else fail('DSH 加载的那份与本仓同版', `装的是 ${installedVersion}，本仓是 ${repoVersion} —— DSH 会跑旧代码，先同步`)

const issue = loadIssue(resolved, exemptions)
if (issue === undefined) pass('DSH 自己的判据说这个 bundle 能加载', `运行时 ${runtimeVersion}，engines.dsh / peerDependencies 都满足，补丁能读`)
else fail('DSH 自己的判据说这个 bundle 能加载', issue)

// 同一套判据也问一遍本仓源码：装好的那份是同步过去的，等它红了才知道就太晚
// （要先把错清单同步进 profile，DSH 才看得见它不兼容）。
const repoIssue = loadIssue(root, exemptions)
if (repoIssue === undefined) pass('本仓这份源码按 DSH 的判据也兼容', '同步之前就能发现 engines / peer 写错')
else fail('本仓这份源码按 DSH 的判据也兼容', repoIssue)

// 入口文件：DSH 会 import exports{"."}，前端会取 exports{"./client"}，缺一个都是「装上了但起不来」。
const manifest = JSON.parse(readFileSync(join(resolved, 'package.json'), 'utf8'))
const entries = [manifest.main, manifest.exports?.['.'], manifest.exports?.['./client'], manifest.exports?.['./cordis.patch.yml']].filter((v) => typeof v === 'string')
const missing = entries.filter((rel) => !existsSync(join(resolved, rel)))
if (missing.length === 0) pass('入口文件都在（main / exports . / ./client / ./cordis.patch.yml）', entries.join(' '))
else fail('入口文件都在', `缺 ${missing.join(', ')}`)

const clientRel = manifest.exports?.['./client']
if (typeof clientRel === 'string' && existsSync(join(resolved, clientRel))) {
  pass('前端产物存在', `${clientRel} ${statSync(join(resolved, clientRel)).size} B`)
}

// 两个引擎：macro 是外壳，真干活的是 vendor 里的 meow / nebula。它们被判不兼容，macro 也白装。
for (const name of ENGINES) {
  const dir = join(resolved, 'vendor', name)
  if (!existsSync(dir)) { fail(`引擎在包里：${name}`, `${dir} 不存在`); continue }
  const engineIssue = loadIssue(dir, exemptions)
  if (engineIssue === undefined) pass(`引擎也能被 DSH 加载：${name}`, mod.readProfileManifest(BIN, dir).version)
  else fail(`引擎也能被 DSH 加载：${name}`, engineIssue)
}

// 装配：把每个 bundle 的补丁层和 profile 的用户层，按 boot 里那一次 applyEntryPatches 合成一遍，
// 再看我们那条还在不在、有没有被谁 disabled。文件里「写着 1 条」只能证明文本存在；
// 装配一次才知道它真落进条目列表、没被后面的层删掉或改掉。
const layers = []
const composeWarns = []
for (const name of bundles) {
  try {
    const dir = mod.resolveBundleDir(BIN, name, join(appRoot, 'package.json'), profileDir)
    const bundleManifest = mod.readProfileManifest(BIN, dir)
    layers.push(...mod.bundlePatchPaths(dir, bundleManifest.dsh.bundle).flatMap((file) => mod.loadOverlayPatches(BIN, file)))
  } catch { /* 坏掉的别的插件跳过：它们会不会红由上面对账报数，这里只管把能读的都装进来 */ }
}
// PROBE_PATCH：把用户层换成指定文件，只为证明「被禁用」这条检查真的会红（平时不设）。
const userPatchFile = process.env.PROBE_PATCH ?? join(profileDir, installed.dsh?.profile?.patch ?? 'cordis.patch.yml')
if (existsSync(userPatchFile)) layers.push(...mod.loadOverlayPatches(BIN, userPatchFile))
const composed = mod.composeEntries([layers], (message) => composeWarns.push(message))
const mine = composed.filter((entry) => entry !== null && typeof entry === 'object' && (entry.id === 'macro-memory' || entry.name === PACKAGE))
if (mine.length === 1) pass('装配后条目里恰好 1 条 macro-memory', `共 ${composed.length} 条，disabled=${mine[0].disabled === true}`)
else fail('装配后条目里恰好 1 条 macro-memory', `装配出 ${mine.length} 条（0 = 补丁没落进去或被删了，>1 = 会重复注册工具）`)
if (mine.length === 1 && mine[0].disabled !== true) pass('装配后它不是被禁用的', 'disabled 不是 true')
else if (mine.length === 1) fail('装配后它不是被禁用的', 'disabled: true —— 装了但不会起')
const mineWarns = composeWarns.filter((message) => /macro-memory|dsh-macro-memory/.test(message))
if (mineWarns.length === 0) pass('装配过程没有一条警告指向本插件', `全场 ${composeWarns.length} 条警告都在别的条目上`)
else fail('装配过程没有一条警告指向本插件', mineWarns.slice(0, 3).join(' / '))

// 其余 bundle 只报数不判红：别的插件坏了不该让本仓红。
const others = bundles.filter((name) => name !== PACKAGE)
const broken = others.filter((name) => {
  try { return loadIssue(mod.resolveBundleDir(BIN, name, join(appRoot, 'package.json'), profileDir), exemptions) !== undefined }
  catch { return true }
})
console.log(`      其余 ${others.length} 个 bundle：按同一套判据有 ${broken.length} 个不能加载${broken.length === 0 ? '' : `（${broken.join(', ')}）`}——不判红，只报数`)

console.log(fails === 0 ? '\n结果：加载面成立（用 DSH 自己的代码问的，不是我抄的规则）' : `\n结果：${fails} 条失败`)
process.exit(fails === 0 ? 0 : 1)
