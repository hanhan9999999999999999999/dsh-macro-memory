/**
 * 仓库改名的**连带改写**（PLAN-UNIVERSAL §15.1 / P2-3）。
 *
 * GitHub 上把 `dsh-macro-memory` 改成 `macro-memory` 这一步只能由人按——它要凭据，
 * 而且按错一步 301 就死了（在旧名下新建占位仓库会把 301 杀掉）。这个脚本管的是
 * **按完之后必须跟着改的那些字**，以及「改之前先确认新地址真的活着」。
 *
 * 它改三处，别的一概不碰：
 *   1. `package.json` 的 `repository` / `homepage` / `bugs`
 *   2. `plugin-market/index.json` 与 `index.cn.json` 里所有 `https://github.com/<owner>/dsh-macro-memory`
 *      （`homepage`、`url`、以及 77 条 `versions[].source.url` 一起改）
 *   3. 两份索引描述文本里的 `npx -y -p dsh-macro-memory macro-memory mcp` → `npx -y macro-memory mcp`
 *
 * **不改**：市场条目的 `name`（还是 `dsh-macro-memory`，那是插件包名）、DSH 插件包名、
 * 装机目录名。改错这三样会让已装用户装不上更新。
 *
 * 默认只体检（dry-run），`--apply` 才写盘；写之前会 `git ls-remote` 探一次新地址，
 * 探不到就停下——宁可让人多按一次 `--force`，也不要让市场索引静悄悄指向 404。
 *
 * 用法：
 *   node tools/rename-brand.mjs                  # 体检：新地址活不活、要改多少处
 *   node tools/rename-brand.mjs --apply          # 改盘（先探新地址）+ 顺手改本仓 remote
 *   node tools/rename-brand.mjs --apply --force  # 新地址探不到也改（离线时用）
 *   node tools/rename-brand.mjs --json           # 结构化输出
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { root } from './_root.mjs'

const NEW_NAME = 'macro-memory'
const OLD_NAME = 'dsh-macro-memory'
const INDEXES = ['plugin-market/index.json', 'plugin-market/index.cn.json']
const PKG = 'package.json'

const args = process.argv.slice(2)
const apply = args.includes('--apply')
const force = args.includes('--force')
const asJson = args.includes('--json')

const out = (text) => {
  if (!asJson) process.stdout.write(`${text}\n`)
}
const report = { apply, force, findings: [], changed: [], remote: null, probe: null }

/** 读一份 JSON；坏了就记下来，不猜着修。 */
function readJson(file) {
  try {
    return JSON.parse(readFileSync(join(root, file), 'utf8'))
  } catch (err) {
    report.findings.push({ where: file, what: `读不动：${err?.message ?? err}` })
    return null
  }
}

/** 数一段文本里旧仓库地址出现几次。 */
const countOld = (text) => (text.split(`/${OLD_NAME}`).length - 1)

// ── 1. 先看现在的 remote 与 package.json 指向哪儿 ─────────────
const remote = spawnSync('git', ['remote', 'get-url', 'origin'], { cwd: root, encoding: 'utf8' })
const remoteUrl = (remote.stdout ?? '').trim()
report.remote = remoteUrl || null
if (remoteUrl === '') {
  report.findings.push({ where: 'git remote', what: '没有 origin（这台机器是克隆出来自己玩的？）' })
}
const owner = /github\.com[/:]([^/]+)\//.exec(remoteUrl)?.[1] ?? ''
if (owner === '') {
  report.findings.push({ where: 'git remote', what: `从 ${remoteUrl || '（空）'} 里认不出 GitHub 账号` })
}

// ── 2. 新地址活不活：这一条决定「现在能不能改」 ───────────────
const newRepo = owner === '' ? '' : `https://github.com/${owner}/${NEW_NAME}`
if (newRepo !== '') {
  const probe = spawnSync('git', ['ls-remote', '--exit-code', newRepo, 'HEAD'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 20000,
  })
  report.probe = { url: newRepo, ok: probe.status === 0, detail: (probe.stderr ?? '').trim().split('\n')[0] ?? '' }
} else {
  report.probe = { url: '', ok: false, detail: '认不出账号，没法探' }
}

// ── 3. 数清楚要改哪些字 ────────────────────────────────────
const pkg = readJson(PKG)
const pkgFields = []
if (pkg) {
  for (const key of ['repository', 'homepage', 'bugs']) {
    const v = pkg[key]
    const text = typeof v === 'string' ? v : v?.url
    if (typeof text === 'string' && text.includes(`/${OLD_NAME}`)) pkgFields.push(key)
  }
  if (pkgFields.length === 0) report.findings.push({ where: PKG, what: '三个字段里已经没有旧仓库名（改过了？）' })
}

const indexWork = []
for (const file of INDEXES) {
  if (!existsSync(join(root, file))) {
    report.findings.push({ where: file, what: '文件不在' })
    continue
  }
  const text = readFileSync(join(root, file), 'utf8')
  // 市场条目的 name 必须是插件包名，改了就装不上更新——先确认它没被顺手改掉。
  let entryName = ''
  try {
    const parsed = JSON.parse(text)
    const first = Array.isArray(parsed?.plugins) ? parsed.plugins[0] : null
    entryName = first?.name ?? ''
  } catch {
    /* 语法坏了：readJson 那边已经记过，这里只做文本替换 */
  }
  indexWork.push({ file, text, occurrences: countOld(text), entryName })
  if (entryName !== '' && entryName !== OLD_NAME) {
    report.findings.push({ where: file, what: `条目 name 变成了 ${entryName}——市场条目名不该跟着仓库名改` })
  }
}

const totalOcc = indexWork.reduce((n, w) => n + w.occurrences, 0)
report.plan = {
  packageFields: pkgFields,
  indexes: indexWork.map((w) => ({ file: w.file, occurrences: w.occurrences })),
  totalOccurrences: totalOcc,
  npxRewrite: indexWork.reduce((n, w) => n + (w.text.split(`npx -y -p ${OLD_NAME} ${NEW_NAME} mcp`).length - 1), 0),
}

// ── 4. 该不该动手 ──────────────────────────────────────────
const probeOk = report.probe.ok === true
if (apply) {
  if (!probeOk && !force) {
    report.findings.push({
      where: 'probe',
      what: `${newRepo || '新地址'} 探不到（${report.probe.detail || '没法连'}）——GitHub 那边还没改名，或者这台机器离线。确认过要改就加 --force`,
    })
  } else {
    // (a) package.json 三个字段
    if (pkg && pkgFields.length > 0) {
      const next = { ...pkg }
      for (const key of pkgFields) {
        if (typeof next[key] === 'string') next[key] = next[key].split(`/${OLD_NAME}`).join(`/${NEW_NAME}`)
        else if (next[key]?.url) next[key] = { ...next[key], url: next[key].url.split(`/${OLD_NAME}`).join(`/${NEW_NAME}`) }
      }
      writeFileSync(join(root, PKG), `${JSON.stringify(next, null, 2)}\n`, 'utf8')
      report.changed.push({ file: PKG, fields: pkgFields })
    }
    // (b) 两份索引：只换 github 地址与 npx 那一段，不动条目 name
    for (const work of indexWork) {
      let text = work.text
      text = text.split(`https://github.com/${owner}/${OLD_NAME}`).join(`https://github.com/${owner}/${NEW_NAME}`)
      text = text.split(`npx -y -p ${OLD_NAME} ${NEW_NAME} mcp`).join(`npx -y ${NEW_NAME} mcp`)
      if (text !== work.text) {
        writeFileSync(join(root, work.file), text, 'utf8')
        report.changed.push({ file: work.file, occurrences: work.occurrences })
      }
    }
    // (c) 本仓 remote：改完就不用每次手动 -u 了；旧地址留在报告里，回滚就一行
    if (remoteUrl !== '' && remoteUrl.includes(`/${OLD_NAME}`)) {
      const oldUrl = remoteUrl
      const set = spawnSync('git', ['remote', 'set-url', 'origin', newRepo], { cwd: root, encoding: 'utf8' })
      if (set.status === 0) report.changed.push({ file: 'git remote origin', from: oldUrl, to: newRepo })
      else report.findings.push({ where: 'git remote', what: `改不动：${(set.stderr ?? '').trim()}` })
    }
  }
}

// ── 5. 报告 ──────────────────────────────────────────────
if (asJson) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
} else {
  out(`仓库改名连带改写（PLAN §15.1）——${apply ? '应用模式' : '体检模式（加 --apply 才写盘）'}`)
  out(`  旧名 → 新名：${OLD_NAME} → ${NEW_NAME}`)
  out(`  当前 remote：${remoteUrl || '（没有）'}`)
  out(`  新地址探活：${report.probe.ok ? '活着' : '探不到'}${report.probe.detail ? `（${report.probe.detail}）` : ''}  ${newRepo}`)
  out('')
  out(`  要改：package.json 的 ${pkgFields.length > 0 ? pkgFields.join(' / ') : '（三处都已是新名）'}`)
  for (const w of indexWork) {
    out(`         ${w.file}：${w.occurrences} 处 github 地址${w.entryName ? `（条目 name 保持 ${w.entryName}）` : ''}`)
  }
  if (report.plan.npxRewrite > 0) out(`         两份索引描述里的 npx 写法：${report.plan.npxRewrite} 处`)
  out(`  合计：${totalOcc} 处地址`)
  out('')
  if (report.changed.length > 0) {
    out('  已改：')
    for (const c of report.changed) {
      out(`    · ${c.file}${c.fields ? `（${c.fields.join(' / ')}）` : ''}${c.occurrences ? `（${c.occurrences} 处）` : ''}${c.from ? `：${c.from} → ${c.to}` : ''}`)
    }
  } else if (apply) {
    out('  一处都没改（看上面的「没改的理由」）。')
  }
  if (report.findings.length > 0) {
    out('')
    out('  要注意：')
    for (const f of report.findings) out(`    ! ${f.where}：${f.what}`)
  }
  out('')
  out('  改完复核：node tools/check-market.mjs && node tools/doctor.mjs')
  out(`  回滚：git remote set-url origin ${remoteUrl || `https://github.com/${owner}/${OLD_NAME}`} && git checkout -- package.json plugin-market/`)
}

process.exit(report.findings.some((f) => f.where === 'probe') && !report.changed.length && apply ? 1 : 0)
