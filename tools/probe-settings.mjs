/**
 * 探针：设置面板里的注入与邻域旋钮（0.6.42）
 *
 * 为什么要有这一支：0.6.39 / 0.6.41 给引擎加了两个闸门（`injectFloor` / `injectBodyMax`），
 * 融合层本来就有四个邻域旋钮（`neighborInject` / `neighborMax` / `neighborChars` /
 * `neighborMinScore`）——**六个都能写配置文件，面板里一个都没有**。主人 2026-11-25 的原话：
 * 「长期记忆长度应该在设置里面加一个 user 可以自己调配的限制」。能力在、入口不在，等于没做。
 *
 * 这一支守的底线（每条都对应一种「看着有、其实不生效」）：
 *  1. **字段真在面板里**：六个 key 都进了 `FIELDS`，分组与类型对（bool 的必须是 bool）；
 *  2. **写的是根键**：这几条不许带 `sub:`——带 sub 会写进 `delegate` 那种子对象，
 *     而融合层 `resolveConfig` 是从**根**上读这几个键的（写了也白写）；
 *  3. **出厂值不许漂**：`CONFIG_DEFAULTS` 里那六个数必须与引擎 / 融合层默认值逐个相等，
 *     否则「恢复默认」会把用户写回一个我们自己都不用的值；
 *  4. **三语齐全且 zh 没有双转义**：词典里 zh 是 `\uXXXX`，一旦被 JSON.stringify 再过一遍
 *     就变成字面的 `\\u661F`，界面显示六个字符而不是一个字；
 *  5. **文案键清单齐全**：`UI_KEYS` 少一条，那一行就显示成 raw key。
 */
import { root } from './_root.mjs'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const clientPath = join(root, 'lib', 'client.js')
const client = readFileSync(clientPath, 'utf8')
const meowSrc = readFileSync(join(root, 'vendor', 'meow-memory', 'lib', 'client.js'), 'utf8')
const macroSrc = readFileSync(join(root, 'lib', 'index.js'), 'utf8')
const NB = await import(pathToFileURL(join(root, 'lib', 'macro', 'neighbor.js')).href)
const ENG = await import(pathToFileURL(join(root, 'vendor', 'meow-memory', 'lib', 'index.js')).href)

let pass = 0
let fail = 0
const bad = []
function ok(name, cond, detail) {
  if (cond) {
    pass++
    console.log('PASS ' + name + (detail ? '  ' + detail : ''))
  } else {
    fail++
    bad.push(name + '  ' + (detail ?? ''))
    console.log('FAIL ' + name + '  ' + (detail ?? ''))
  }
}

/** 取 client 里的 CONFIG_DEFAULTS 字面量：注释照留，对象字面量交给 Function 解析。
 *  里面引用了同文件的 `DEFAULT_RULES_REVIEW_DAYS`，所以把它当参数喂进去（否则解析必然抛）。 */
function configDefaultsOf(text) {
  const start = text.indexOf('var CONFIG_DEFAULTS = {')
  if (start < 0) return null
  const reviewDays = /var DEFAULT_RULES_REVIEW_DAYS = (\d+);/.exec(text)?.[1]
  if (reviewDays === undefined) return null
  const from = start + 'var CONFIG_DEFAULTS = '.length
  const end = text.indexOf('\n};', from)
  if (end < 0) return null
  try {
    return new Function('DEFAULT_RULES_REVIEW_DAYS', `return ${text.slice(from, end + 2)}`)(Number(reviewDays))
  } catch {
    return null
  }
}

const defaults = configDefaultsOf(client)

// ── S0 补丁真的落到产物里（而不是只写在 tools/ 里） ─────────────────────────
{
  ok('S0 产物里有 0.6.42 / 0.6.44 的补丁痕迹（八个 key 全在）',
    ['injectFloor', 'injectBodyMax', 'injectSessionBudget', 'injectRepeatSim', 'neighborInject', 'neighborMax', 'neighborChars', 'neighborMinScore']
      .every((k) => client.includes(`"settings.field.${k}.label"`)))
  ok('S0 vendored meow bundle 没被手改（补丁在构建期，上游可升级）',
    !meowSrc.includes('settings.field.neighborMax.label') && !meowSrc.includes('injectBodyMax:'),
    meowSrc.includes('settings.field.neighborMax.label') ? 'vendor 里出现了新字段' : 'vendor 干净')
  ok('S0 CONFIG_DEFAULTS 能解析出来', defaults !== null)
}

// ── S1 字段真在 FIELDS 里，分组与类型对 ────────────────────────────────────
{
  const fieldsOf = (key) => {
    const re = new RegExp(`\\{ key: "${key}"[^}]*\\}`)
    const m = client.match(re)
    return m === null ? null : m[0]
  }
  const spec = (key) => fieldsOf(key)
  const typeOf = (key) => {
    const s = spec(key)
    return s === null ? null : (/type: "(\w+)"/.exec(s)?.[1] ?? null)
  }
  ok('S1 八个字段都进了 FIELDS', ['injectFloor', 'injectBodyMax', 'injectSessionBudget', 'injectRepeatSim', 'neighborInject', 'neighborMax', 'neighborChars', 'neighborMinScore']
    .every((k) => spec(k) !== null))
  ok('S1 类型对：neighborInject 是 bool，其余七个是 num',
    typeOf('neighborInject') === 'bool' &&
      ['injectFloor', 'injectBodyMax', 'injectSessionBudget', 'injectRepeatSim', 'neighborMax', 'neighborChars', 'neighborMinScore'].every((k) => typeOf(k) === 'num'),
    `neighborInject=${typeOf('neighborInject')}`)
  ok('S1 都不带 sub（写的是根键，融合层才读得到）',
    ['injectFloor', 'injectBodyMax', 'injectSessionBudget', 'injectRepeatSim', 'neighborInject', 'neighborMax', 'neighborChars', 'neighborMinScore']
      .every((k) => !/sub:/.test(spec(k) ?? '')),
    '')
  ok('S1 新的一组插在「反思」前面（顺序：注入 → 邻域 → 反思）',
    client.indexOf('title: "settings.group.neighbor"') > client.indexOf('title: "settings.group.inject"') &&
      client.indexOf('title: "settings.group.neighbor"') < client.indexOf('title: "settings.group.reflect"'))
  ok('S1 四个邻域字段都挂在新组里（组标题之后、反思组之前）', (() => {
    const a = client.indexOf('title: "settings.group.neighbor"')
    const b = client.indexOf('title: "settings.group.reflect"')
    const seg = a < 0 || b < 0 ? '' : client.slice(a, b)
    return ['neighborInject', 'neighborMax', 'neighborChars', 'neighborMinScore'].every((k) => seg.includes(`key: "${k}"`))
  })())
}

// ── S2 出厂值 = 引擎 / 融合层默认值（漂了就红） ────────────────────────────
{
  const d = defaults ?? {}
  ok('S2 injectFloor 出厂值 = 引擎默认',
    d.injectFloor === ENG.CONFIG_DEFAULTS.injectFloor,
    `面板 ${d.injectFloor} / 引擎 ${ENG.CONFIG_DEFAULTS.injectFloor}`)
  ok('S2 injectBodyMax 出厂值 = 引擎默认',
    d.injectBodyMax === ENG.CONFIG_DEFAULTS.injectBodyMax,
    `面板 ${d.injectBodyMax} / 引擎 ${ENG.CONFIG_DEFAULTS.injectBodyMax}`)
  ok('S2 neighborMax / neighborChars / neighborMinScore 出厂值 = 融合层默认',
    d.neighborMax === NB.NEIGHBOR_DEFAULT_MAX &&
      d.neighborChars === NB.NEIGHBOR_DEFAULT_CHARS &&
      d.neighborMinScore === NB.NEIGHBOR_MIN_SCORE,
    `${d.neighborMax}/${d.neighborChars}/${d.neighborMinScore}`)
  ok('S2 neighborInject 出厂值是开（默认每轮带邻域）', d.neighborInject === true, String(d.neighborInject))
  ok('S2 injectSessionBudget 出厂值 = 引擎默认（0＝会话累计不限）',
    d.injectSessionBudget === ENG.CONFIG_DEFAULTS.injectSessionBudget,
    `面板 ${d.injectSessionBudget} / 引擎 ${ENG.CONFIG_DEFAULTS.injectSessionBudget}`)
  ok('S2 injectRepeatSim 出厂值 = 引擎默认（0.25 实测线）',
    d.injectRepeatSim === ENG.CONFIG_DEFAULTS.injectRepeatSim,
    `面板 ${d.injectRepeatSim} / 引擎 ${ENG.CONFIG_DEFAULTS.injectRepeatSim}`)
}

// ── S3 三语齐全，且 zh 是真中文（不是双转义的六个字符） ────────────────────
{
  const matches = (key) => {
    const re = new RegExp(`"${key}": ("(?:[^"\\\\]|\\\\.)*")`, 'g')
    return [...client.matchAll(re)].map((m) => {
      try {
        return JSON.parse(m[1])
      } catch {
        return null
      }
    })
  }
  const group = matches('settings.group.neighbor')
  ok('S3 分组标题三语齐全', group.length === 3, group.join(' / '))
  ok('S3 分组标题 zh 是「星图邻域」（u 转义被正确解回一个字，不是字面反斜杠）',
    group[1] === '星图邻域', JSON.stringify(group[1]))
  const keys = ['injectFloor', 'injectBodyMax', 'injectSessionBudget', 'injectRepeatSim', 'neighborInject', 'neighborMax', 'neighborChars', 'neighborMinScore']
  const missing = []
  for (const k of keys) {
    for (const suffix of ['label', 'hint']) {
      const vals = matches(`settings.field.${k}.${suffix}`)
      if (vals.length !== 3 || vals.some((v) => typeof v !== 'string' || v.length === 0)) missing.push(`${k}.${suffix}:${vals.length}`)
    }
  }
  ok('S3 八组 label/hint 三语齐全且都非空', missing.length === 0, missing.join(','))
  const zhHints = keys.map((k) => matches(`settings.field.${k}.hint`)[1] ?? '')
  ok('S3 zh 文案确实是中文（每条都含汉字）', zhHints.every((t) => /[\u4E00-\u9FFF]/.test(t)), '')
  ok('S3 没有双转义残留（\\u 被写成字面反斜杠的那种）', !/\\\\u[0-9A-Fa-f]{4}/.test(client), '')
}

// ── S4 文案键清单齐全（少一条就显示成 raw key） ────────────────────────────
{
  const keys = ['settings.group.neighbor']
  for (const k of ['injectFloor', 'injectBodyMax', 'injectSessionBudget', 'injectRepeatSim', 'neighborInject', 'neighborMax', 'neighborChars', 'neighborMinScore']) {
    keys.push(`settings.field.${k}.label`, `settings.field.${k}.hint`)
  }
  const uiStart = client.lastIndexOf('var UI_KEYS = [')
  const uiSeg = uiStart < 0 ? '' : client.slice(uiStart, client.indexOf('];', uiStart))
  const miss = keys.filter((k) => !uiSeg.includes(`"${k}"`))
  ok('S4 UI_KEYS 里 17 条文案键一条不少', uiSeg !== '' && miss.length === 0, miss.join(','))
}

// ── S5 面板 ↔ 配置面接得上（不然「改了不生效」） ──────────────────────────
{
  ok('S5 融合层 schema 有四个邻域键（根上）',
    ['neighborInject', 'neighborMax', 'neighborChars', 'neighborMinScore'].every((k) => new RegExp(`${k}: z\\.`).test(macroSrc)))
  ok('S5 MACRO_KEYS 白名单里也有四个邻域键', (() => {
    const m = /const MACRO_KEYS = \[([\s\S]*?)\]/.exec(macroSrc)
    return m !== null && ['neighborInject', 'neighborMax', 'neighborChars', 'neighborMinScore'].every((k) => m[1].includes(`'${k}'`))
  })())
  ok('S5 两个注入闸门在 meow 的 Config 里（所以面板写它们不会被宿主 strip 掉）',
    ['injectFloor', 'injectBodyMax'].every((k) => new RegExp(`${k}: z\\.`).test(readFileSync(join(root, 'vendor', 'meow-memory', 'lib', 'index.js'), 'utf8'))))
  ok('S5 设置写入会触发融合层重建（volatile-update → syncSurface）',
    /loader\/volatile-update/.test(macroSrc) && /syncSurface\(\)/.test(macroSrc))
  ok('S5 邻域注入器读的是这四个旋钮（不是硬编码常量）',
    ['neighborInject', 'neighborMax', 'neighborChars', 'neighborMinScore'].every((k) => readFileSync(join(root, 'lib', 'macro', 'neighbor.js'), 'utf8').includes(`config.${k}`)))
}

// ── S6 面板写入的形状真能被融合层读回（根键 vs 旧嵌套写法） ────────────────
{
  const MAC = await import(pathToFileURL(join(root, 'lib', 'index.js')).href)
  const base = MAC.resolveConfig({})
  ok('S6 不写设置时，四个邻域旋钮落在融合层默认值上',
    base.macro.neighborInject === true &&
      base.macro.neighborMax === NB.NEIGHBOR_DEFAULT_MAX &&
      base.macro.neighborChars === NB.NEIGHBOR_DEFAULT_CHARS &&
      base.macro.neighborMinScore === NB.NEIGHBOR_MIN_SCORE,
    `${base.macro.neighborMax}/${base.macro.neighborChars}/${base.macro.neighborMinScore}`)
  const written = MAC.resolveConfig({
    neighborInject: false, neighborMax: 2, neighborChars: 300, neighborMinScore: 0.5,
    injectFloor: 0, injectBodyMax: 0,
    injectSessionBudget: 3000, injectRepeatSim: 0.5,
  })
  ok('S6 面板写根键后，四个邻域旋钮都真的变了（不是写了个没人读的字段）',
    written.macro.neighborInject === false && written.macro.neighborMax === 2 &&
      written.macro.neighborChars === 300 && written.macro.neighborMinScore === 0.5,
    JSON.stringify([written.macro.neighborInject, written.macro.neighborMax, written.macro.neighborChars, written.macro.neighborMinScore]))
  ok('S6 两个注入闸门的根键也透到 meow 段（0＝关闸 / 整条）',
    written.meow.injectFloor === 0 && written.meow.injectBodyMax === 0,
    JSON.stringify([written.meow.injectFloor, written.meow.injectBodyMax]))
  ok('S6 两个节奏旋钮的根键也透到 meow 段（3000 字 / 0.5）',
    written.meow.injectSessionBudget === 3000 && written.meow.injectRepeatSim === 0.5,
    JSON.stringify([written.meow.injectSessionBudget, written.meow.injectRepeatSim]))
  ok('S6 旧的嵌套写法仍然认（macro: 段铺底、根键覆盖）',
    MAC.resolveConfig({ macro: { neighborMax: 3 } }).macro.neighborMax === 3 &&
      MAC.resolveConfig({ macro: { neighborMax: 3 }, neighborMax: 1 }).macro.neighborMax === 1)
}

console.log('')
if (fail > 0) {
  console.log(`FAILED  passed ${pass} / failed ${fail}`)
  for (const b of bad) console.log('  ✗ ' + b)
  process.exitCode = 1
} else {
  console.log(`ALL PASS  probe-settings：${pass}/${pass}`)
}
