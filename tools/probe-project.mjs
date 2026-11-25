/**
 * 项目全景的预算账（0.6.63）。
 *
 * 量的是什么：`memory_project` 是全部工具里最大的一支回执（真库账本 30 次调用平均
 * **11,581 字**，见 cost.jsonl），0.6.63 给它加了「目录 + 每条首句」的压缩视图。
 * 这个探针盯三件事：
 *   · **不削弱**：回执本来就短（≤ 上限）时逐字节原样返回；`budget=0` 逐字节等于旧行为；
 *     三类「空回答」（名字对不上 / 别的层还有 / 真没有）一个字都不压。
 *   · **压缩真发生**：超过上限时按组列目录，每条留完整 id + 层 + 首句，尾巴自报压了多少。
 *   · **出口都在**：`group=` 只看一组、`limit=` 每组几条、极小上限时不许假装是全景。
 *
 * 夹具自己建库（临时工作区 + 真 meow 引擎写表），不碰任何运行中的库。
 */
import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { root } from './_root.mjs'

const P = await import(pathToFileURL(join(root, 'lib/macro/defs/project.js')).href)
const C = await import(pathToFileURL(join(root, 'lib/macro/contract.js')).href)
const Meow = await import(pathToFileURL(join(root, 'vendor/meow-memory/lib/index.js')).href)

const WS = mkdtempSync(join(tmpdir(), 'probe-project-'))
mkdirSync(join(WS, '.dsh-meow'), { recursive: true })
const DIR = '.dsh-meow'
const PROJECT = '探针项目'
const NOW = Date.UTC(2026, 10, 25, 6, 0, 0)

const db = Meow.getDb(WS, DIR)
const insert = (table, row) =>
  db
    .p(
      `INSERT INTO ${table} (id, title, content, importance, keywords, status, hit_count, read_count, created_at, updated_at${table === 'project' ? ', project, subcategory' : ', project'}) VALUES (?,?,?,?,?,?,?,?,?,?${table === 'project' ? ',?,?' : ',?'})`,
    )
    .run(
      row.id,
      row.title ?? '',
      row.content,
      row.importance ?? 2,
      '["探针"]',
      row.status ?? 'active',
      0,
      0,
      NOW,
      NOW,
      row.project ?? PROJECT,
      ...(table === 'project' ? [row.subcategory ?? 'overview'] : []),
    )

// 决策 4 条 / 结构 2 条 / 待办 1 条 / 已完结待办 1 条 / 准则 1 条 —— 目录行加起来超过 3000 字。
for (let i = 1; i <= 4; i += 1) insert('project', { id: `0mprojdec${i}`, subcategory: 'decisions', content: `第 ${i} 条决策的第一句。后面还有一句不该出现在目录里。` })
for (let i = 1; i <= 2; i += 1) insert('project', { id: `0mprojstr${i}`, subcategory: 'structure', content: `第 ${i} 条结构说明。第二句同样不进目录。` })
insert('project', { id: '0mprojtod1', subcategory: 'todo', content: '还没做完的一件事。细节在这里。' })
insert('project', { id: '0mprojtod2', subcategory: 'todo', status: 'stale', content: '已经做完的一件事。细节在这里。' })
insert('rules', { id: '0mprojrul1', content: '这个项目的准则第一条。' })

const exec = { agent: { session: { header: { cwd: WS } } } }
/** 桩 flow：`memory_project` 的引擎回执由这里给（真库那份引擎渲染太短，撑不满压缩条件）。 */
const LONG = '【探针项目】全景原文。'.repeat(700) // ≈ 7700 字
const flow = (text) => ({ call: async () => ({ text }) })
// 配置走真实插件的形状：`projectMaxChars` 由 zod 默认值填进来，探针这里显式给同一个值。
const tool = (text, config = { projectMaxChars: P.PROJECT_MAX_CHARS }) => P.createProject({ flow: flow(text), config, meowDir: () => DIR })

let failures = 0
const ok = (cond, label, detail) => {
  if (!cond) failures += 1
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`)
}
const run = async (text, args, config) => String(await tool(text, config).execute({ project: PROJECT, ...args }, exec))

// P1 不削弱：本来就短的回执逐字节原样。
const short = '【探针项目】这个项目只有一句话。'
ok((await run(short, {})) === short, 'P1 短回执逐字节原样（压缩只在超上限时发生）')

// P2 压缩：超上限时按组列目录，每条留 id / 层 / 首句。
const big = await run(LONG, {})
ok(big.length <= P.PROJECT_MAX_CHARS + 120, 'P2 压缩回执不超上限', `${big.length} 字 ≤ ${P.PROJECT_MAX_CHARS}+尾巴`)
ok(/§ 决策 4 条/.test(big) && /§ 结构 2 条/.test(big) && /§ 准则 1 条/.test(big), 'P2 分组标题带条数（决策/结构/准则）')
ok(big.includes('0mprojdec1') && big.includes('0mprojrul1'), 'P2 每条留完整 id（memory_read 的把手）')
ok(big.includes('project ') || big.includes(' rules '), 'P2 每条留层名')
ok(!big.includes('后面还有一句不该出现在目录里'), 'P2 目录只留首句，不带第二句')
ok(/原文 \d+ 字 → 这份 \d+ 字/.test(big), 'P2 尾巴自报「原文多少 → 这份多少」')
ok(big.includes('budget=0') && big.includes('memory_read('), 'P2 尾巴给出全量与全文两条出口')

// P3 budget=0 逐字节等于旧行为。
ok((await run(LONG, { budget: 0 })) === LONG, 'P3 budget=0 逐字节原样（旧行为）')

// P4 group 只看一组。
const only = await run(LONG, { group: 'decisions' })
ok(/§ 决策 4 条/.test(only) && !/§ 结构/.test(only) && !only.includes('0mprojstr1'), 'P4 group=decisions 只列这一组')
ok(only.length < big.length, 'P4 只看一组比全组目录更短', `${only.length} < ${big.length}`)

// P5 limit 每组最多几条。
const lim = await run(LONG, { group: 'decisions', limit: 1 })
ok((lim.match(/^- \[0mprojdec\d\]/gm) ?? []).length === 1, 'P5 limit=1 每组只列一条')

// P6 极小上限：不许假装是全景。
const tiny = await run(LONG, { budget: 200 })
ok(/连一条目录都排不下/.test(tiny) || /还有 \d+ 条没列/.test(tiny), 'P6 上限过小时明说「装不下 / 还有几条没列」')
ok(tiny.length < 500, 'P6 极小上限的回执也短', `${tiny.length} 字`)

// P7 三类空回答一个字都不压（它们是结论，不是目录）。
for (const [tag, mark] of [
  ['名字对不上', C.PROJECT_NAME_NOT_FOUND_MARK],
  ['别的层还有', C.PROJECT_OTHER_LAYERS_MARK],
  ['真没有', C.PROJECT_TRULY_EMPTY_MARK],
]) {
  const text = `${LONG.slice(0, 4200)}\n${mark}`
  ok((await run(text, {})) === text, `P7 ${tag}：空回答不压缩`)
}

// P8 设置里关掉（projectMaxChars: 0）＝ 逐字节原样。
ok((await run(LONG, {}, { projectMaxChars: 0 })) === LONG, 'P8 projectMaxChars=0 退回原样全量')

// P9 组名写错：给原样 + 一句「这次没按组筛」，不许静默换组。
const bad = await run(LONG, { group: 'nothing' })
ok(bad.startsWith(LONG) && bad.includes('这次没按组筛'), 'P9 group 写错：原样 + 明说没筛')

// P10 首句口径：多句只取第一句；无句末标点的长句截断加省略号。
ok(P.compactProject({ project: 'P', groups: new Map([['decisions', [{ row: { id: '0mx', content: '第一句。第二句。' }, level: 'project' }]]]), cap: 3000 }).text.includes('第一句。')
  && !P.compactProject({ project: 'P', groups: new Map([['decisions', [{ row: { id: '0mx', content: '第一句。第二句。' }, level: 'project' }]]]), cap: 3000 }).text.includes('第二句'),
  'P10 目录只取首句')
const noStop = P.compactProject({ project: 'P', groups: new Map([['decisions', [{ row: { id: '0my', content: '甲'.repeat(200) }, level: 'project' }]]]), cap: 3000 }).text
ok(noStop.includes('…'), 'P10 无句末标点时截断加省略号')

// P11 已完结待办单独一档（与引擎 project.todoDone 同义）。
ok(/§ 已完结待办 1 条/.test(big) && big.includes('0mprojtod2'), 'P11 已完结待办单独列')

// P12 装不下时自报条数，不静默变短。
const capped = await run(LONG, { budget: 400 })
ok(/还有 \d+ 条没列/.test(capped), 'P12 装不下时自报「还有 N 条没列」', capped.split('\n').pop().slice(0, 40))

console.log(failures === 0 ? 'ALL PASS' : `FAILURES: ${failures}`)
if (failures !== 0) process.exitCode = 1
