/**
 * 口径总账探针（0.2.84）：同一件事只许有一种说法，而且说法必须和代码对得上。
 *
 * [macro-fusion 0.2.84] 为什么需要这一支：
 * 「8 个工具 / 五类体检 / 七个层级 / action 枚举 / 注入 1,085 字符」这些数字与说法，
 * 现在同时活在四个地方——注入手册（`lib/macro/prompt.js`）、工具 schema（`defs/*.js`）、
 * 代码常量（`shared.js` 的 LEVELS / PROJECT_SUBCATEGORIES）、对外文案（README 与两份市场索引）。
 * 以前它们靠人记得同时改；漏改的那一处不会报错，只会让模型照着手册去调一个不存在的东西，
 * 或者让用户在页面上读到一句已经不是事实的数字（教训 58：没人执行的路径等于不存在；
 * 教训 59：判据没被阴性对照打过 = 注释）。
 *
 * 这一支只做一件事：把事情**问一遍**——从代码里取出真值，再逐条比对每一处说法。
 * 不复制常量、不维护第二份清单；唯一的例外是「手册里应该出现 8」这个数字本身，
 * 因为那是产品承诺，不是实现细节。
 */
import { readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { root } from './_root.mjs'
import { createUnifiedTools, createAliasTools } from '../lib/macro/tools.js'
import { LEVELS, PROJECT_SUBCATEGORIES } from '../lib/macro/shared.js'
import { BRAND_MAP } from '../lib/macro/brand.js'
import { GUIDE_TEXT, NAV_TEXT } from '../lib/macro/prompt.js'
import { ACTIONS } from '../lib/macro/defs/admin.js'

// 这个探针只装配工具定义、不执行任何工具；仍然先把 DSH_HOME 指到临时目录，
// 保证「将来有人在这里顺手加一句 execute」也不会碰到主人的生产记忆库
// （verify 的「降级」判据就是查这一行在不在）。
process.env.DSH_HOME = process.env.DSH_HOME ?? join(tmpdir(), 'macro-words-home-' + process.pid)

let failures = 0
function ok(cond, label, detail) {
  if (!cond) failures++
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + label + (detail ? '  ' + detail : ''))
}

/**
 * 从一段对外文案里取「声明的注入字符数」。
 * 4,085 是融合前的对照值（README 里拿它算降幅），不是对现在的声明，所以跳过。
 */
function claimedGuideLengths(text) {
  const out = []
  for (const m of String(text).matchAll(/([\d,]{3,7})\s?(?:字符|-character)/g)) {
    const n = Number(m[1].replace(/,/g, ''))
    if (n !== 4085) out.push(n)
  }
  return out
}

/** 手册里提到的检索模式：`mode=graph|bridge`、`mode="similar"` 两种写法都认。 */
function modeTokens(text) {
  return [...String(text).matchAll(/mode\s*=\s*"?([a-z|]+)"?/g)].flatMap((m) => m[1].split('|').filter(Boolean))
}

/** 手册 level 那一行里的名字：`level（每条都要）：soul=AI 自身 / user=…`。 */
function levelTokens(text) {
  const line = (String(text).match(/level（每条都要）：([^。\n]+)/) ?? [])[1] ?? ''
  return [...line.matchAll(/(?:^|[/\s])([a-z]+)=/g)].map((m) => m[1])
}

const stub = { call: async () => ({ text: '' }), exec: async () => ({}) }

const tools = createUnifiedTools({ bridge: stub, config: {} })
const names = tools.map((t) => t.name)
const byName = Object.fromEntries(tools.map((t) => [t.name, t]))
const aliasNames = createAliasTools({ bridge: stub }).map((t) => t.name)
const defsDir = join(root, 'lib', 'macro', 'defs')

// ── 一、工具面：defs 目录、装配结果、别名、品牌映射四处同一个名单 ──────────────
const defFiles = readdirSync(defsDir).filter((f) => f.endsWith('.js'))
const defNames = defFiles.map((f) => {
  const src = readFileSync(join(defsDir, f), 'utf8')
  const m = src.match(/name:\s*'(memory_[a-z_]+)'/)
  return m ? m[1] : ''
})
ok(defFiles.length === names.length, '工具面：defs 一个文件一个工具（文件数 = 装配数）', defFiles.length + ' = ' + names.length)
ok(defNames.every(Boolean) && new Set(defNames).size === defNames.length, '工具面：每个 defs 文件都声明了唯一的名字', defNames.length + ' 个')
ok(defNames.slice().sort().join() === names.slice().sort().join(), '工具面：defs 里声明的名字与装配出来的名字一致', '8/8')
ok(names.length === 8 && new Set(names).size === 8, '工具面：对外正好 8 个 memory_* 工具', names.length + ' 个')

const brandLeft = BRAND_MAP.map(([from]) => from)
const brandRightNames = [...new Set(BRAND_MAP.flatMap(([, to]) => [...String(to).matchAll(/memory_[a-z_]+/g)].map((m) => m[0])))]
const ghost = brandRightNames.filter((n) => !names.includes(n))
ok(ghost.length === 0, '品牌映射：箭头右边指的都是真工具（不是死指针）', ghost.length ? '悬空: ' + ghost.join(',') : brandRightNames.length + ' 个名字全在')

const brandToolLeft = brandLeft.filter((n) => n.startsWith('nebula_') || n === 'memory_find_similar' || n === 'memory_home')
ok(brandToolLeft.slice().sort().join() === aliasNames.slice().sort().join(), '品牌映射：旧工具名清单 = 兼容别名清单（改一处必须改另一处）', brandToolLeft.length + ' vs ' + aliasNames.length)

// ── 二、手册口径：注入里说的动作 / 模式 / 层级，必须和 schema 与常量一模一样 ──────
const actionsInGuide = (GUIDE_TEXT.match(/memory_admin（action=([a-z|]+)）/) ?? [])[1] ?? ''
const actionKeys = Object.keys(ACTIONS).join('|')
ok(actionsInGuide === actionKeys, '手册：memory_admin 的 action 枚举与动作表顺序一致', actionsInGuide === actionKeys ? actionsInGuide : '手册=' + actionsInGuide + ' 代码=' + actionKeys)
ok(Object.values(ACTIONS).every((a) => typeof a.label === 'string' && a.label.length > 0) && new Set(Object.values(ACTIONS).map((a) => a.label)).size === Object.keys(ACTIONS).length, '手册：动作表的中文标签唯一且非空（面板抬头只有一套名字）', Object.keys(ACTIONS).length + ' 个')

const linkEnum = byName.memory_link.parameters.properties.action.enum.join('|')
const linkInGuide = (GUIDE_TEXT.match(/memory_link（action=([a-z|]+)）/) ?? [])[1] ?? ''
ok(linkEnum === linkInGuide, '手册：memory_link 的 action 与 schema 枚举一致', linkEnum)

const modeEnum = byName.memory_search.parameters.properties.mode.enum
const modesInGuide = modeTokens(GUIDE_TEXT)
ok(modesInGuide.every((m) => modeEnum.includes(m)) && modeEnum.filter((m) => m !== 'local').every((m) => modesInGuide.includes(m)), '手册：memory_search 的 mode 每个非默认值都被手册提到、且都能用', modeEnum.join('/'))

const levelNames = LEVELS.join('/')
const levelsInGuide = levelTokens(GUIDE_TEXT)
ok(
  levelsInGuide.length === LEVELS.length && LEVELS.every((l) => levelsInGuide.includes(l)),
  '手册：七个 level 与 LEVELS 常量一致（顺序可以不同，名单必须一样）',
  levelsInGuide.length ? levelNames : '手册里一个都没认出',
)

const subInGuide = GUIDE_TEXT.includes(PROJECT_SUBCATEGORIES.join('|'))
ok(subInGuide, '手册：project 子类与 PROJECT_SUBCATEGORIES 一致', PROJECT_SUBCATEGORIES.join('|'))

const statusEnum = byName.memory_update.parameters.properties.status.enum.join('|')
ok(GUIDE_TEXT.includes(statusEnum), '手册：memory_update 的 status 与 schema 枚举一致', statusEnum)

const kindEnum = byName.memory_admin.parameters.properties.kind.enum
const kindWords = (ACTIONS.hygiene.hint.match(/（([^）]+)）/) ?? [])[1] ?? ''
ok(kindEnum.length === 6 && kindWords.split('/').length === 6, '手册：体检六类（schema 枚举 = 提示词里的六个中文类目）', kindEnum.length + ' vs ' + kindWords.split('/').length)

// ── 三、对外数字：README 与两份市场索引里写的常驻注入字符数，必须等于实测 ────────
const guideLen = GUIDE_TEXT.length
const claimed = new Map()
for (const file of [join(root, 'README.md'), join(root, 'plugin-market', 'index.json'), join(root, 'plugin-market', 'index.cn.json')]) {
  for (const n of claimedGuideLengths(readFileSync(file, 'utf8'))) {
    claimed.set(n, (claimed.get(n) ?? 0) + 1)
  }
}
const wrong = [...claimed.keys()].filter((n) => n !== guideLen)
ok(wrong.length === 0, '对外数字：注入字符数每处都是实测值（不是记下来的旧值）', wrong.length ? '错: ' + wrong.join(',') + '，实测 ' + guideLen : guideLen + ' 字符 × ' + [...claimed.values()].reduce((a, b) => a + b, 0) + ' 处')

// ── 四、没留下死指针：工具说明与注入手册里不该再出现旧名字 ────────────────────
const OLD = ['nebula_', 'memory_find_similar', 'memory_home', 'meow-memory']
const descText = tools.map((t) => t.description).join('\n')
const deadDesc = OLD.filter((k) => descText.includes(k))
ok(deadDesc.length === 0, '死指针：8 个工具的说明里没有旧工具名/旧插件名', deadDesc.length ? deadDesc.join(',') : '干净')
const deadGuide = OLD.filter((k) => GUIDE_TEXT.includes(k) || NAV_TEXT.includes(k))
ok(deadGuide.length === 0, '死指针：注入手册里没有旧名字（模型照着调会拿到「工具不存在」）', deadGuide.length ? deadGuide.join(',') : '干净')

// 说明只许一行、不许膨胀：卡片title/面板都是一行的地方，多行说明会被折叠成看不懂的碎片。
const longDesc = tools.filter((t) => typeof t.description !== 'string' || t.description.length === 0 || t.description.length > 200 || /[\r\n]/.test(t.description))
ok(longDesc.length === 0, '可读性：每个工具说明都是单行、非空、≤200 字', longDesc.length ? longDesc.map((t) => t.name).join(',') : '8/8')

const navCount = Number((NAV_TEXT.match(/①工具——(\d+)\s*个 memory_\*/) ?? [])[1] ?? -1)
ok(navCount === names.length, '手册：导航里的「N 个 memory_*」= 实际装配数', 'nav=' + navCount + ' 实际=' + names.length)

// ── 五、阴性对照：证明上面这些判据真的会红（教训 59）─────────────────────────
// 一个「永远 PASS」的判据等于注释。这里用合成的坏输入，看解析器会不会照单抓出来。
const ctl = []
ctl.push(['modeTokens 认得 graph|bridge 的连写', modeTokens('mode=graph|bridge 走关联').join(',') === 'graph,bridge'])
ctl.push(['modeTokens 在没写模式时不出声', modeTokens('这里没有模式').length === 0])
ctl.push(['levelTokens 只认 k=v 形式', levelTokens('level（每条都要）：soul=AI / fact=原子。').join(',') === 'soul,fact'])
ctl.push(['字符数会说谎：1,086 会被当成声明值抓出来', claimedGuideLengths('常驻注入 1,086 字符').join(',') === '1086'])
ctl.push(['融合前对照值 4,085 不算声明', claimedGuideLengths('4,085 字符（旧值）').length === 0])
ctl.push(['死指针检测能认出旧名', ['nebula_'].some((k) => '先调 nebula_recall'.includes(k))])
const badCtl = ctl.filter(([, pass]) => !pass)
ok(badCtl.length === 0, '阴性对照：解析器与检测器都能抓住坏输入', badCtl.length ? '失效: ' + badCtl.map(([n]) => n).join(' / ') : ctl.length + '/' + ctl.length)

console.log(failures === 0 ? 'ALL PASS' : 'FAILURES: ' + failures)
if (failures !== 0) process.exitCode = 1
