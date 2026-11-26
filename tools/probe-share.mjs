/**
 * 验收：归属账（PLAN-UNIVERSAL §4.1 / P1-2 / 判据 U6）。
 *
 * 检的是「几个 agent 共用一个库时，还分得清谁写的」：
 *   S1 A 写的条目，B 搜到时带 `[agent:A]`
 *   S2 自己搜到自己带 `[self]`
 *   S3 B 改 A 的条目：owner 不动，只换 last_editor（改内容≠改主人）
 *   S4 没有归属记录的老条目**不加标签**（不写「未知」那种假话）
 *   S5 scope 默认：人格/用户 → private，规矩/事实 → workspace；显式 global 标 `[global]`
 *   S6 标签只印在行首 id 上，正文里同形的 8 位串不被误标
 *   S7 归属账打不开时记忆照旧能写（归属是增强，不是前置条件）
 *   S8 别人的 private：检索里一条都看不见（连候选池都不进，不占 k）
 *   S9 别人的 private：直读被拒，且说的是「不给你看」不是「查不到」
 *   S10 自己写的 private：搜得到也读得到（隔离不是自己关自己）
 *   S11 owner 为空的 private 不误挡（0.9 之前的老条目一挡就是整库消失）
 *
 * 全部在临时目录里做，不碰真实库。
 * 用法：node tools/probe-share.mjs
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { root } from './_root.mjs'

const mod = (p) => import(pathToFileURL(join(root, p)).href)

let pass = 0
let fail = 0
function check(name, cond, detail = '') {
  if (cond) {
    pass += 1
    console.log(`PASS  ${name}  ${detail}`)
  } else {
    fail += 1
    console.log(`FAIL  ${name}  ${detail}`)
  }
}

const tmp = mkdtempSync(join(tmpdir(), 'macro-share-'))
const ws = join(tmp, 'ws')
const home = join(tmp, 'home')
const dataDir = join(tmp, 'data')
for (const d of [ws, home, dataDir]) mkdirSync(d, { recursive: true })

// 与 probe-core 同样的隔离：meow 的 switchHomeDir 会把全局目录指针写进 <DSH_HOME>/storages，
// 不隔离就等于改宿主的真实指针。先把指针写成「当前就是本支 home」，迁移不发生。
process.env.DSH_HOME = join(tmp, 'dsh-home')
mkdirSync(join(process.env.DSH_HOME, 'storages'), { recursive: true })
writeFileSync(join(process.env.DSH_HOME, 'storages', 'meow-memory-home.json'), JSON.stringify({ homeDir: home }))

const { createMacroEngine } = await mod('lib/core/engine.js')
const { createOwnerStore } = await mod('lib/core/owner.js')
const Meow = await mod('vendor/meow-memory/lib/index.js')

const eng = await createMacroEngine({ dataDir, homeDir: home, projectDir: '.dsh-meow', meow: { autoMigrate: false } })
const as = (agentId) => ({ cwd: ws, agentId })

// ── S1/S2 A 写 B 读 ────────────────────────────────────────────
const KEY = '归属账炮台词'
const wrote = await eng.call(
  'memory_remember',
  { content: '归属账：这条是 codex 写的，用来验证别的 agent 读到时能看见是谁写的。', level: 'fact', keywords: [KEY, '归属账'], importance: 2, project: 'share' },
  as('codex'),
)
const idA = wrote.value?.id ?? /id\s*=\s*([0-9a-z][0-9a-z-]{5,})/.exec(wrote.text)?.[1] ?? ''
check('S0 codex 写入成功并拿到 id', idA !== '', idA)

const seenByB = await eng.call('memory_search', { query: KEY, k: 5 }, as('claude'))
check('S1 B 搜到 A 写的条目，行首带 [agent:codex]', seenByB.text.includes('[agent:codex]'), seenByB.text.split('\n').find((l) => l.includes('[agent:codex]')) ?? seenByB.text.slice(0, 160))

const seenByA = await eng.call('memory_search', { query: KEY, k: 5 }, as('codex'))
check('S2 自己搜到自己带 [self]', seenByA.text.includes('[self]'), seenByA.text.split('\n').find((l) => l.includes('[self]')) ?? seenByA.text.slice(0, 160))

// ── S3 update 不改主人 ────────────────────────────────────────
await eng.call('memory_update', { id: idA, content: '归属账：这条被 claude 改过一次，主人还是 codex。' }, as('claude'))
const db = Meow.getDb(ws, '.dsh-meow')
const store = createOwnerStore(db)
const row = store.ownersOf([idA]).get(idA)
check('S3 改内容后 owner 仍是 codex', row?.owner === 'codex', String(row?.owner))
check('S3 last_editor 换成 claude', row?.last_editor === 'claude', String(row?.last_editor))

// ── S5 scope 默认与显式 ──────────────────────────────────────
const soul = await eng.call('memory_remember', { content: '归属账：人格层的私事，默认该是 private。', level: 'soul', project: 'share', keywords: [KEY], importance: 2 }, as('codex'))
const idSoul = soul.value?.id ?? /id\s*=\s*([0-9a-z][0-9a-z-]{5,})/.exec(soul.text)?.[1] ?? ''
const rules = await eng.call('memory_remember', { content: '归属账：规矩是工作区的，默认 workspace。', level: 'rules', project: 'share', keywords: [KEY], importance: 2 }, as('codex'))
const idRules = rules.value?.id ?? /id\s*=\s*([0-9a-z][0-9a-z-]{5,})/.exec(rules.text)?.[1] ?? ''
const glob = await eng.call('memory_remember', { content: '归属账：这条显式声明给所有 agent 看。', level: 'fact', project: 'share', scope: 'global', keywords: [KEY], importance: 2 }, as('codex'))
const idGlob = glob.value?.id ?? /id\s*=\s*([0-9a-z][0-9a-z-]{5,})/.exec(glob.text)?.[1] ?? ''

// ── S12 回执印的必须是完整 id（36 ms 窗口那次真 bug 的判据）────
// 只印前 8 位时，同一毫秒里连写的两条 id 前缀一模一样；探针再从回执里捞 id，
// 就会把两条当成同一条，owner 表互相覆盖——0.9.0 之前 Linux CI 上真发生过
// （probe-share S5 把 soul/rules 读成 global，probe-rrf Q4/Q6 同源）。
// docs/INTERNAL.md 9.292 记着这件事。这条判据盯住「回执够不够长」，
// 让人以后再想 `.slice(0, 8)` 时先被这里拦一次。
const fullId = /id\s*=\s*([0-9a-z][0-9a-z-]{5,})/.exec(soul.text)?.[1] ?? ''
check('S12 回执印的是完整 id，不是 8 位前缀', fullId.includes('-') && fullId.length >= 16, fullId || '(回执里没找到 id=)')

const rows = store.ownersOf([idSoul, idRules, idGlob])
check('S5 soul 默认 private', rows.get(idSoul)?.scope === 'private', String(rows.get(idSoul)?.scope))
check('S5 rules 默认 workspace', rows.get(idRules)?.scope === 'workspace', String(rows.get(idRules)?.scope))
check('S5 显式 global 生效', rows.get(idGlob)?.scope === 'global', String(rows.get(idGlob)?.scope))
const globalSeen = await eng.call('memory_search', { query: '显式声明给所有 agent', k: 5 }, as('claude'))
check('S5 global 条目在别人那儿标 [global]', globalSeen.text.includes('[global]'), globalSeen.text.split('\n').find((l) => l.includes('[global]')) ?? globalSeen.text.slice(0, 160))

// ── S4 没有归属记录的老条目不乱标 ────────────────────────────
db.p('DELETE FROM mem_owner WHERE id = ?').run(idA)
const seenNoOwner = await eng.call('memory_search', { query: KEY, k: 5 }, as('claude'))
const lineA = seenNoOwner.text.split('\n').find((l) => l.includes(idA.slice(0, 8))) ?? ''
check('S4 删掉归属记录后那条不再有 agent 标签', lineA !== '' && !/\[agent:|\[self\]|\[global\]/.test(lineA), lineA.slice(0, 120))

// ── S6 正文里的 8 位串不被误标 ──────────────────────────────
const tricky = await eng.call(
  'memory_remember',
  { content: '归属账：正文里提到一个构建号 ab12cd34 和一个哈希 deadbeef，它们不是记忆 id。', level: 'fact', project: 'share', keywords: [KEY], importance: 1 },
  as('codex'),
)
const idTricky = tricky.value?.id ?? /id\s*=\s*([0-9a-z][0-9a-z-]{5,})/.exec(tricky.text)?.[1] ?? ''
const trickySeen = await eng.call('memory_search', { query: '构建号 ab12cd34', k: 5 }, as('claude'))
const bodies = trickySeen.text.split('\n').filter((l) => l.includes('ab12cd34'))
check('S6 正文里的 ab12cd34 后面没有跟着标签', bodies.length > 0 && bodies.every((l) => !/ab12cd34`?\[/.test(l)), bodies[0]?.slice(0, 140) ?? '没找到')
check('S6 那条自己的行首 id 仍然带标签', trickySeen.text.includes('[agent:codex]'), trickySeen.text.split('\n').find((l) => l.includes('[agent:codex]'))?.slice(0, 120) ?? '')

// ── S8–S11 可见性：别人的 private 看不见 ────────────────────
// 这一组要在 S7 之前跑：S7 会把 mem_owner 整张表 DROP 掉。
const idOf = (r) => r.value?.id ?? /id\s*=\s*([0-9a-z][0-9a-z-]{5,})/.exec(r.text)?.[1] ?? ''
const priv = await eng.call(
  'memory_remember',
  { content: '归属账：这条是 codex 的私事，别人不该看见（私有炮台词）。', level: 'fact', project: 'share', keywords: ['私有炮台词'], importance: 2, scope: 'private' },
  as('codex'),
)
const idPriv = idOf(priv)
check('S8 一条 private 写进去了', idPriv !== '', idPriv)

const privByB = await eng.call('memory_search', { query: '私有炮台词', k: 5 }, as('claude'))
check(
  'S8 别人搜不到这条 private（连候选都不占）',
  !privByB.text.includes(idPriv.slice(0, 8)),
  privByB.text.split('\n').slice(0, 2).join(' | ').slice(0, 150),
)

const privBySelf = await eng.call('memory_search', { query: '私有炮台词', k: 5 }, as('codex'))
check(
  'S9 自己搜得到，并带 [self]',
  privBySelf.text.includes(idPriv.slice(0, 8)) && privBySelf.text.includes('[self]'),
  privBySelf.text.split('\n').find((l) => l.includes(idPriv.slice(0, 8)))?.slice(0, 130) ?? '',
)

const readByB = await eng.call('memory_read', { id: idPriv }, as('claude'))
check(
  'S9 别人直读被拒，且说的是「private 不给你看」不是「查不到」',
  /private 记忆|不给你看/.test(readByB.text) && !/在七层表里都查不到/.test(readByB.text),
  readByB.text.split('\n')[0]?.slice(0, 130) ?? '',
)

const readBySelf = await eng.call('memory_read', { id: idPriv }, as('codex'))
check(
  'S10 自己直读拿到正文（隔离不关自己）',
  readBySelf.text.includes('私有炮台词') && !/private 记忆|不给你看/.test(readBySelf.text),
  readBySelf.text.split('\n')[0]?.slice(0, 120) ?? '',
)

// owner 为空的 private：0.9 之前写的老条目没有归属记录，一挡就是「整库消失」。
db.p("INSERT OR REPLACE INTO mem_owner (id, owner, scope, visibility, level, last_editor, created_at, updated_at) VALUES (?, NULL, 'private', 'private', 'fact', NULL, ?, ?)")
  .run(idRules, Date.now(), Date.now())
const orphanSeen = await eng.call('memory_search', { query: '规矩是工作区的', k: 5 }, as('claude'))
check(
  'S11 owner 为空的 private 不误挡（老条目不该被藏）',
  orphanSeen.text.includes(idRules.slice(0, 8)),
  orphanSeen.text.split('\n').find((l) => l.includes(idRules.slice(0, 8)))?.slice(0, 120) ?? '',
)

// ── S7 归属账坏了也不挡写入 ─────────────────────────────────
db.db.exec('DROP TABLE mem_owner')
const stillWrites = await eng.call(
  'memory_remember',
  { content: '归属账：表被我删了，这条照样得写进去。', level: 'fact', project: 'share', keywords: [KEY], importance: 2 },
  as('codex'),
)
check('S7 mem_owner 表没了，记忆照旧写入成功', stillWrites.refused !== true && /写入|已记|✅/.test(stillWrites.text), stillWrites.text.split('\n')[0]?.slice(0, 120) ?? '')

console.log(`\n${pass} PASS / ${fail} FAIL`)
await eng.close()
process.exit(fail === 0 ? 0 : 1)
