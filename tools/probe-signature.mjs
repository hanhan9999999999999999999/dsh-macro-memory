#!/usr/bin/env node
/**
 * [macro-fusion 0.6.10] 签名账——钉住「库没变时，不重复付签名钱」这件事。
 *
 * 病根：`indexSignature` 是**每问一次**都要算的固定开销，而它算的东西（「库还是不是上一张库」）
 * 绝大多数时候答案是「没变」。0.6.10 之前每问都要把整库重哈希一遍：每条切头 40、切尾 40、
 * 把关键词 join 成串（三次分配）+ 逐字符 `Math.imul` 混算。实测（660 / 2,000 / 5,000 / 10,000 条
 * 同构语料，`E:\Temp\cmp\scale010.mjs`）签名占一次热检索的 **28.8%–30.6%**，随条数线性涨
 * （0.96 / 2.84 / 7.04 / 14.16 ms）；记账后降到 **2.8%–3.5%**（0.06 / 0.19 / 0.53 / 1.20 ms），
 * 660 条热检索 3.24ms → 2.18ms、10,000 条 49.2ms → 37.6ms。
 *
 * 处方：以 doc 对象为键做 WeakMap 记账，存「条级哈希 + 参与计算的字段值快照」，
 * 下次先做值比较（字符串 `===` 在原生侧是 memcmp，比 JS 逐字符混算便宜一个量级），全等才复用。
 * 三条命门在这里逐条钉住：
 *   ① 比的是**值**不是对象身份——同一对象就地改 content / 改 keywords 元素，签名必须跟着变；
 *   ② 条级哈希必须与外部状态无关（老实现把每条一路滚进同一个值，同一条的贡献随「前面有谁」变，
 *      天然不可缓存）——所以拿参考实现横比条级哈希；
 *   ③ 判不了值有没有变的形状（字段是对象、keywords 元素不是标量）走直算，不许猜。
 *
 *   S1 条级哈希与参考实现逐位相同（200 种形状：超长 / 空 / 缺字段 / 逗号串 / JSON 串 / 等长改写）
 *   S2 同一批 docs 连算 5 次逐位相同，且第 2 次起「复用」在涨、「重算」不涨
 *   S3 就地等长改正文中间一个字 → 签名必变（缓存不许拿旧值答新库）
 *   S4 就地改 keywords 数组里的一个词 → 签名必变
 *   S5 就地改 title / updated_at / source_session / id 任一 → 签名必变
 *   S6 只换 docs 顺序（内容一字不改）→ 签名必变（顺序参与总账）
 *   S7 脏形状（null 行 / 缺 keywords / 逗号串 / JSON 串）不缓存但也稳定，且与参考实现一致
 *   S8 660 条 200 轮：记账后比参考实现快 5 倍以上（参考实现就是记账前的算法）
 *   S9 能红证明：本地「只按对象身份记账」的坏实现，必须过不了 S3 那种就地改
 *
 * 用法：node tools/probe-signature.mjs   （挂进 check-all；只读引擎，不写任何文件）
 */
import { root } from './_root.mjs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const enginePath = join(root, 'vendor', 'meow-memory', 'lib', 'index.js')
const V = await import(pathToFileURL(enginePath).href)

let total = 0
let failures = 0
function check(label, ok, extra) {
  total++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra === undefined || extra === '' ? '' : `  ${extra}`}`)
  if (!ok) failures++
}

// ── 参考实现：与引擎里 `sigDocHash` 逐字同构的写法（记账前的算法） ─────────────────
// 它不缓存、每条从头算，所以是「慢但对」的基准：引擎里的条级哈希必须跟它逐位相同。
function refDocHash(d) {
  let h = 2166136261 >>> 0
  const put = (s) => {
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i)
      h = Math.imul(h, 16777619) >>> 0
    }
  }
  const sep = () => {
    h ^= 0x7c
    h = Math.imul(h, 16777619) >>> 0
  }
  const kwOf = (doc) => {
    const raw = doc?.keywords
    if (Array.isArray(raw)) return raw.filter((w) => typeof w === 'string' && w.length > 0)
    if (typeof raw !== 'string') return []
    const s = raw.trim()
    if (s === '') return []
    if (s.startsWith('[')) {
      try {
        const parsed = JSON.parse(s)
        if (Array.isArray(parsed)) return parsed.filter((w) => typeof w === 'string' && w.length > 0)
      } catch { /* 不是 JSON 就按分隔符切 */ }
    }
    return s.split(/[,，、;；]/).map((w) => w.trim()).filter((w) => w.length > 0)
  }
  put(String(d?.id ?? '')); sep()
  put(String(d?.updated_at ?? d?.updatedAt ?? '')); sep()
  const content = String(d?.content ?? '')
  put(String(content.length)); sep()
  put(content.slice(0, 40)); sep()
  put(content.slice(-40)); sep()
  put(String(d?.title ?? '')); sep()
  const kw = kwOf(d)
  for (let i = 0; i < kw.length; i++) {
    if (i > 0) put('\u0001')
    put(String(kw[i] ?? ''))
  }
  sep()
  put(String(d?.source_session ?? '')); sep()
  return h >>> 0
}
function refSignature(docs) {
  let h = 2166136261 >>> 0
  h ^= docs.length
  h = Math.imul(h, 16777619) >>> 0
  for (const d of docs) {
    h ^= refDocHash(d)
    h = Math.imul(h, 16777619) >>> 0
  }
  return `${docs.length}:${h >>> 0}`
}

// ── 造形状：覆盖「干净 / 超长 / 空 / 缺字段 / 逗号串 / JSON 串 / 脏元素」 ────────────
function rnd(seed) {
  let s = seed >>> 0 || 1
  return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296
}
const WORDS = ('记忆 检索 插件 引擎 打分 索引 缓存 语料 评测 夹具 版本 提交 断言 探针 库 文档 ' +
  '词表 标签 项目 会话 回执 时间 顺序 名次 命中 覆盖 权重').split(/\s+/)
function shape(i) {
  const r = rnd(i + 1)
  const pick = () => WORDS[Math.floor(r() * WORDS.length)]
  const long = i % 7 === 0
  const n = long ? 400 : 1 + Math.floor(r() * 20)
  const words = []
  for (let k = 0; k < n; k++) words.push(pick())
  const content = words.join('，') + (i % 11 === 0 ? '' : '。')
  const base = {
    id: i % 13 === 0 ? undefined : 'd-' + i,
    title: i % 5 === 0 ? '' : '标题 ' + pick(),
    content,
    updated_at: i % 3 === 0 ? undefined : 1700000000000 + i * 7,
  }
  const kw = i % 6
  if (kw === 0) base.keywords = words.slice(0, 3)
  else if (kw === 1) base.keywords = words.slice(0, 3).join('，')
  else if (kw === 2) base.keywords = JSON.stringify(words.slice(0, 2))
  else if (kw === 3) base.keywords = null
  else if (kw === 4) base.keywords = []
  // kw === 5 完全不给这个字段
  if (i % 4 === 0) base.source_session = 'sess-' + i
  if (i % 9 === 0) base.updatedAt = 1800000000000 + i
  return base
}

V.resetIndexSignatureStats()
const shapes = []
for (let i = 0; i < 200; i++) shapes.push(shape(i))

// ── S1：条级哈希与参考实现逐位相同 ──────────────────────────────────────────────
{
  const bad = []
  for (const d of shapes) {
    const got = V.indexSignature([d])
    const want = refSignature([d])
    if (got !== want) bad.push(`${d.id ?? '(无 id)'}: ${got} ≠ ${want}`)
  }
  check('S1 条级哈希与参考实现逐位相同（200 种形状：超长 / 空 / 缺字段 / 逗号串 / JSON 串）',
    bad.length === 0, bad.slice(0, 3).join(' | ') || '200/200 一致')
}

// ── S2：同一批连算 5 次逐位相同，且第 2 次起复用涨、重算不涨 ─────────────────────
{
  const docs = shapes.slice(0, 40)
  V.resetIndexSignatureStats()
  const sigs = []
  const stats = []
  for (let i = 0; i < 5; i++) {
    sigs.push(V.indexSignature(docs))
    stats.push(V.indexSignatureStats())
  }
  const stable = sigs.every((s) => s === sigs[0])
  const rebuiltStable = stats[1].rebuilt === stats[4].rebuilt
  const reusedGrew = stats[4].reused > stats[1].reused
  check('S2 连算 5 次逐位相同，且第 2 次起只复用不重算',
    stable && rebuiltStable && reusedGrew,
    `签名 ${sigs[0]} · 重算 ${stats[1].rebuilt}→${stats[4].rebuilt} · 复用 ${stats[1].reused}→${stats[4].reused}`)
}

// ── S3：就地等长改正文中间一个字 → 签名必变 ────────────────────────────────────
{
  const doc = { id: 'x', title: '发布方式', content: '发布方式：蓝绿切换，切完观察五分钟。', keywords: ['发布', '切换'], updated_at: 1 }
  const before = V.indexSignature([doc])
  const mid = Math.floor(doc.content.length / 2)
  doc.content = doc.content.slice(0, mid) + (doc.content[mid] === '观' ? '看' : '观') + doc.content.slice(mid + 1)
  const after = V.indexSignature([doc])
  check('S3 同一对象就地等长改正文中间一个字 → 签名必变', before !== after,
    `${before} → ${after}（字数 ${doc.content.length} 不变）`)
}

// ── S4：就地改 keywords 数组里的一个词 → 签名必变 ───────────────────────────────
{
  const kw = ['发布', '切换', '灰度']
  const doc = { id: 'y', title: 't', content: 'c' + 'x'.repeat(80), keywords: kw, updated_at: 2 }
  const before = V.indexSignature([doc])
  kw[1] = '回滚'
  const after = V.indexSignature([doc])
  check('S4 就地改 keywords 数组里的一个词（数组还是那个数组）→ 签名必变', before !== after, `${before} → ${after}`)
}

// ── S5：就地改 title / updated_at / source_session / id 任一 → 签名必变 ─────────
{
  const fields = [
    ['title', (d) => { d.title = d.title + '!' }],
    ['updated_at', (d) => { d.updated_at += 1 }],
    ['source_session', (d) => { d.source_session = 'other-sess' }],
    ['id', (d) => { d.id = d.id + 'z' }],
  ]
  const bad = []
  for (const [name, mutate] of fields) {
    const d = { id: 'z', title: '标', content: '正文' + 'y'.repeat(60), keywords: ['甲'], updated_at: 3, source_session: 's' }
    const before = V.indexSignature([d])
    mutate(d)
    const after = V.indexSignature([d])
    if (before === after) bad.push(name)
  }
  check('S5 就地改 title / updated_at / source_session / id 任一 → 签名必变', bad.length === 0,
    bad.length === 0 ? '4/4 都变' : `没变：${bad.join(',')}`)
}

// ── S6：只换顺序 → 签名必变 ────────────────────────────────────────────────────
{
  const a = { id: 'a', content: '甲'.repeat(60), keywords: ['甲'] }
  const b = { id: 'b', content: '乙'.repeat(60), keywords: ['乙'] }
  check('S6 只换 docs 顺序（内容一字不改）→ 签名必变', V.indexSignature([a, b]) !== V.indexSignature([b, a]),
    `${V.indexSignature([a, b])} vs ${V.indexSignature([b, a])}`)
}

// ── S7：脏形状不缓存但也稳定 ───────────────────────────────────────────────────
{
  const docs = [null, undefined, 'scalar', { id: 'n', title: null, content: null, keywords: null }, shape(3), shape(4)]
  const a = V.indexSignature(docs)
  const b = V.indexSignature(docs)
  const c = V.indexSignature(docs.map((d) => d))
  check('S7 脏形状（null 行 / 缺字段 / 逗号串）不缓存但也稳定、与参考实现一致',
    a === b && a === c && a === refSignature(docs), `${a}`)
}

// ── S8：性能——记账后比参考实现快 5 倍以上 ─────────────────────────────────────
{
  const docs = []
  for (let i = 0; i < 660; i++) docs.push(shape(i))
  const reps = 200
  V.indexSignature(docs) // 预热：把 660 条都记上账
  const t0 = process.hrtime.bigint()
  for (let i = 0; i < reps; i++) V.indexSignature(docs)
  const fast = Number(process.hrtime.bigint() - t0) / 1e6 / reps
  const t1 = process.hrtime.bigint()
  for (let i = 0; i < 40; i++) refSignature(docs)
  const slow = Number(process.hrtime.bigint() - t1) / 1e6 / 40
  check('S8 660 条 200 轮：记账后比记账前（参考实现）快 5 倍以上', slow / fast >= 5,
    `${fast.toFixed(3)}ms vs ${slow.toFixed(3)}ms（${(slow / fast).toFixed(1)}×）`)
}

// ── S9：能红证明——只按对象身份记账的坏实现，必须过不了 S3 那种就地改 ─────────────
{
  const BAD = new WeakMap()
  const badSig = (docs) => {
    let h = 2166136261 >>> 0
    h ^= docs.length
    h = Math.imul(h, 16777619) >>> 0
    for (const d of docs) {
      let dh = d && typeof d === 'object' ? BAD.get(d) : void 0
      if (dh === void 0) {
        dh = refDocHash(d)
        if (d && typeof d === 'object') BAD.set(d, dh)
      }
      h ^= dh
      h = Math.imul(h, 16777619) >>> 0
    }
    return `${docs.length}:${h >>> 0}`
  }
  const doc = { id: 'r', title: '发布', content: '发布方式：蓝绿切换，切完观察五分钟。', keywords: ['发布'], updated_at: 5 }
  const badBefore = badSig([doc])
  doc.content = doc.content.replace('蓝绿', '红黑')
  const badAfter = badSig([doc])
  const realBefore = V.indexSignature([{ ...doc, content: '发布方式：红黑切换，切完观察五分钟。' }])
  check('S9 能红证明：只按对象身份记账的坏实现看不见就地改（真实现看得见）',
    badBefore === badAfter && V.indexSignature([doc]) === realBefore,
    `坏实现 ${badBefore} = ${badAfter}（漏了）· 真实现看见改变`)
}

console.log(failures === 0 ? `\nALL PASS  probe-signature：${total}/${total}` : `\n${failures} 条失败（共 ${total}）`)
process.exit(failures === 0 ? 0 : 1)
