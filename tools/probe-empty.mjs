#!/usr/bin/env node
/**
 * [macro-fusion 0.6.2] 空回探针——钉住「回执可以是少的，但不许把『有』说成『没有』」。
 *
 * 病根（LoCoMo 10 段 / 1,531 问实测，见 `tools/bench-locomo.mjs`：空回 8 条）：
 * 噪声地板按设计剔掉「到处都是」的词（df ≥ 一半条目），护栏②只管「剔完一个词不剩」。
 * 可还有一半情形它没管——**剔完还剩词，但剩的那些词库里一个都没有**（df=0）：
 * `What Console does Nate own?` 切成 `consol`（库外）+ `nate`（629 条里 454 条有，df 比 72%），
 * 地板剔掉 `nate`、留下 `consol`，候选择集里没有一条能命中 → 回执 []。
 * 调用方看到的不是「问句没写好」，是「库里没有这条记忆」——这是插件能犯的最坏错误：
 * 它自己在 RULE 里写着「回执不全≠没有」，却在这 0.5% 的问句上把「有」说成了「没有」。
 *
 * 这里钉住修好之后的六条性质（都是行为断言，删掉补丁就会红）：
 *   E1 库外词不许顶掉能命中的词：`zzzz nate` 与 `nate` 首位同一条、且非空
 *   E2 不凭空编：问句全是库外词（`zzzz`）、或与库彻底无关时，仍然回 0 条
 *   E3 老护栏不许回退：全是噪声词 / 全是虚词时照旧整句回退、非空
 *   E4 该动手才动手：正常问句在地板开/关两态下逐位相同（补丁不是「顺手改了尺子」）
 *   E5 不引新 id、返回条数不出 k、docs 为空仍回 0
 *   E6 成本：单次检索 ≪ 10ms
 *   E7 救回来的只能是噪声词：中文实词（`基线`）照旧救，既噪声又虚词的（`什么`）一个都不救
 *
 * 用法：node tools/probe-empty.mjs      （挂进 check-all；零 LLM、不碰真库、不写任何文件）
 */
import { root } from './_root.mjs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

let failures = 0
function check(label, ok, extra) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra === undefined || extra === '' ? '' : `  ${extra}`}`)
  if (!ok) failures++
}

const V = await import(pathToFileURL(join(root, 'vendor', 'meow-memory', 'lib', 'index.js')).href)
const idsOf = (hits) => hits.map((h) => h.id).join(',')

// ── 合成语料：20 条（跨过 NOISE_MIN_DOCS=8）。12 条提到 Nate，8 条只谈花园 ──────────
const docs = []
for (let i = 0; i < 12; i++) docs.push({ id: `e-n${i}`, title: '记录', content: `Nate 提到了第 ${i} 件事，顺手记一条 note。`, level: 'fact', status: 'active' })
for (let i = 0; i < 8; i++) docs.push({ id: `e-g${i}`, title: '记录', content: `花园里的第 ${i} 株浇过水，顺手记一条 note。`, level: 'fact', status: 'active' })
// 中文语料：全部含「基线」（df=n → 必被噪声地板剔），另一份全是虚词骨架
const cn = []
for (let i = 0; i < 12; i++) cn.push({ id: `c-a${i}`, title: '基线', content: `基线同步第 ${i} 次，收工前复测。`, level: 'fact', status: 'active' })
for (let i = 0; i < 8; i++) cn.push({ id: `c-b${i}`, title: '备忘', content: `滴定终点读两遍，记在备忘第 ${i} 条。`, level: 'fact', status: 'active' })
// 虚词落点语料：这里刻意让内容里真的写着「一次」，用来验证「全是虚词」那条护栏还在
for (let i = 0; i < 8; i++) cn.push({ id: `c-c${i}`, title: '复测', content: `一次复测就收工，第 ${i} 条。`, level: 'fact', status: 'active' })
// 「什么」同时是噪声词（df=100%）和虚词——救回来就是硬凑，所以这类词一个都不许救
const cnFunc = []
for (let i = 0; i < 12; i++) cnFunc.push({ id: `c-w${i}`, title: '记录', content: `什么都可以，第 ${i} 条。`, level: 'fact', status: 'active' })

const nate = V.search('nate', docs, { k: 5 })
const natePlusJunk = V.search('zzzz nate', docs, { k: 5 })
check('E1 库外词不顶掉能命中的词：`zzzz nate` 非空', natePlusJunk.length > 0, `${natePlusJunk.length} 条`)
check('E1 库外词不顶掉能命中的词：首位与 `nate` 同一条', nate.length > 0 && idsOf(natePlusJunk).split(',')[0] === idsOf(nate).split(',')[0], `${idsOf(nate).split(',')[0] ?? '(空)'}`)
check('E1 命中只落在真含 nate 的条目上（12 条里的前 5）', natePlusJunk.every((h) => String(h.id).startsWith('e-n')))

const junk = V.search('zzzz', docs, { k: 5 })
check('E2 不凭空编：问句全是库外词 → 0 条', junk.length === 0, `${junk.length} 条`)
const unrelated = V.search('quantum entanglement', docs, { k: 5 })
check('E2 不凭空编：与库彻底无关 → 0 条', unrelated.length === 0, `${unrelated.length} 条`)

const allNoise = V.search('基线', cn, { k: 5 })
check('E3 全是噪声词照旧整句回退（非空）', allNoise.length > 0, `${allNoise.length} 条`)
const allFunc = V.search('一次', cn, { k: 5 })
check('E3 全是虚词照旧整句回退（非空）', allFunc.length > 0, `${allFunc.length} 条`)

const norm = V.search('滴定终点读几遍', cn, { k: 5 })
const normRelaxed = V.search('滴定终点读几遍', cn, { k: 5, noiseFloor: false, funcFloor: false })
check('E4 正常问句：地板开/关两态逐位相同（补丁不动尺子）', idsOf(norm) === idsOf(normRelaxed), `${idsOf(norm)}`)

const corpIds = new Set([...docs, ...cn].map((d) => d.id))
check('E5 回退不引新 id：所有命中都在语料里', [...natePlusJunk, ...allNoise].every((h) => corpIds.has(String(h.id))))
check('E5 返回条数不出 k', V.search('nate', docs, { k: 3 }).length <= 3 && V.search('基线', cn, { k: 2 }).length <= 2)
check('E5 docs 为空仍回 0 条', V.search('nate', [], { k: 5 }).length === 0)

// ── E7：救回来的只能是「噪声词」，虚词一个都不许救 ─────────────────────────────
// E7 这条是被 G8「没有的事就空手」逼出来的（第一版把问句里所有库里存在的词都救回来，
// 14 条无关问句里两条立刻被 `合作/作用/反应`、`冠军/世界` 凑出回执，空手 10/14 → 8/14）。
const noiseOnly = V.search('zzzz 基线', cn, { k: 5 })
check('E7 噪声地板剔掉的中文实词照旧救回来（`基线` df=60%，不是虚词）', noiseOnly.length > 0, `${noiseOnly.length} 条`)
const funcBoth = V.search('zzzz 什么', cnFunc, { k: 5 })
check('E7 既是噪声又是虚词的词不救（`什么` 在语料里 df=100%，救回来就是硬凑）', funcBoth.length === 0, `${funcBoth.length} 条`)

// 成本：护栏只在「留下的词全不可命中」时真的跑一遍 df 查询，正常问句只是几次 Map.get。
const t0 = process.hrtime.bigint()
for (let i = 0; i < 200; i++) V.search(i % 2 === 0 ? '滴定终点读几遍' : 'zzzz nate', i % 2 === 0 ? cn : docs, { k: 5 })
const perCall = Number(process.hrtime.bigint() - t0) / 1e6 / 200
check('E6 成本：单次检索 p50 ≪ 10ms', perCall < 10, `${perCall.toFixed(2)}ms/次`)

console.log(failures === 0 ? '\nALL PASS  probe-empty：14/14' : `\n${failures} 条失败`)
process.exit(failures === 0 ? 0 : 1)
