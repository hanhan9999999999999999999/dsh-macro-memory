#!/usr/bin/env node
/**
 * 一次体检：交付物一致性 + 加载面 + 运行时账本，全部只读。
 *
 * 为什么需要它：本插件是「vendor 源码 + profile 实体拷贝」两处部署（DESIGN §11.3），
 * 最容易出的错不是代码写错，而是**两处不同步**——vendor 改了、profile 还是旧版，
 * DSH 重启后加载的是旧的那份，而所有单点脚本都是「在哪跑就只测哪」。
 * 这个脚本把两棵树按字节比一遍，并核对 profile patch/bundles 与产物 hash。
 *
 * 用法：node tools/doctor.mjs          # 本目录体检（自动识别是否 profile 拷贝）
 *       node tools/doctor.mjs --strict # 有 WARN 也返回非零（发版前用）
 */
import { root } from './_root.mjs'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, join, relative } from 'node:path'
import { pathToFileURL } from 'node:url'
import { makeVerdict } from './doctor-verdict.mjs'
import * as criteria from './criteria.mjs'

const VENDOR = 'D:\\dsh-home\\vendor\\dsh-macro-memory'
const PROFILE_HOME = 'D:\\dsh-home\\profiles\\desktop'
const PROFILE = join(PROFILE_HOME, 'node_modules', 'dsh-macro-memory')
const OLD_IDS = ['meow-memory', 'dsh-memory-nebula']
const STRICT = process.argv.includes('--strict')

// 判决与记账在 tools/doctor-verdict.mjs（0.2.73）：tag 说 FAIL 就算失败，
// 不再看第二参——以前 22 处 line(<cond> ? 'PASS' : 'FAIL', true, …) 的 FAIL 只是四个字母。
const verdict = makeVerdict()
const { line, pass, fail, warn } = verdict

const sha = (file) => createHash('sha256').update(readFileSync(file)).digest('hex')
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'))

/** 递归列出相对路径（跳过 node_modules / .probe-home / 临时文件）。 */
function walk(dir, base = dir, out = []) {
  if (!existsSync(dir)) return out
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.probe-home') continue
    const abs = join(dir, name)
    const st = statSync(abs)
    if (st.isDirectory()) walk(abs, base, out)
    else out.push(relative(base, abs).replace(/\\/g, '/'))
  }
  return out
}

// ── 1. 版本与身份 ───────────────────────────────────────────────────────────
console.log('== 版本与身份 ==')
const pkg = readJson(join(root, 'package.json'))
const here = sha(join(root, 'package.json')) === sha(join(PROFILE, 'package.json')) ? '与 profile 一致' : '与 profile 不同'
pass('name', `name=${pkg.name}`)
console.log(`      version=${pkg.version}（${here}）`)
const indexSrc = readFileSync(join(root, 'lib', 'index.js'), 'utf8')
const declared = indexSrc.match(/export const version = '([^']+)'/)?.[1]
line(declared === pkg.version ? 'PASS' : 'FAIL', true, 'version 单一来源', `package.json=${pkg.version} lib/index.js=${declared}`)
line(/inject\s*=\s*\[[^\]]*'tools'/.test(indexSrc) ? 'PASS' : 'FAIL', true, 'inject 含 tools')
line(/export function apply|export async function apply/.test(indexSrc) ? 'PASS' : 'FAIL', true, '导出 apply')
console.log(`      运行位置=${root === PROFILE ? 'profile 实体拷贝' : 'vendor 源码'}`)

// ── 2. 两棵树同步（谁跑谁比：vendor 跑就 vendor↔profile，profile 跑就 profile↔vendor）──
// 0.2.18 修：原来在 profile 里跑只是「跳过对比」，导致同一份代码在两棵树里数出来的断言条数不一样
// （40 vs 41），基线就永远差一条。对称比较后两边各一条 PASS，条数一致，基线才能只有一组数字。
console.log('\n== vendor ↔ profile 同步 ==')
const FILES_AT_ROOT = [
  'package.json', 'README.md', 'DESIGN.md', 'verify.mjs', 'build.mjs',
  // 0.2.81：发布物里有对外承诺的两份文件，两棵树都得有，否则 profile 里跑出来的产物会缺许可声明。
  'LICENSE', 'THIRD-PARTY-NOTICES.md',
]
function treeSync(aRoot, bRoot) {
  const list = (r) =>
    walk(join(r, 'lib'))
      .map((p) => `lib/${p}`)
      .concat(walk(join(r, 'tools')).map((p) => `tools/${p}`))
      // vendor/ 也要比：我们在这两个第三方引擎上打了极少数补丁（见下一段「补丁账本」），
      // 只比 lib/tools 的话，「vendor 改了忘了同步」会静默漏过去。
      .concat(walk(join(r, 'vendor')).map((p) => `vendor/${p}`))
      .concat(FILES_AT_ROOT.filter((f) => existsSync(join(r, f))))
  const mine = list(aRoot)
  const theirs = list(bRoot)
  const drift = []
  for (const rel of mine) {
    const b = join(bRoot, rel)
    if (!existsSync(b)) drift.push(`${rel}（对方缺）`)
    else if (sha(join(aRoot, rel)) !== sha(b)) drift.push(`${rel}（内容不同）`)
  }
  const extra = theirs.filter((rel) => !existsSync(join(aRoot, rel)))
  return { drift, extra, count: mine.length }
}
{
  const pair = root === PROFILE ? treeSync(PROFILE, VENDOR) : treeSync(root, PROFILE)
  if (pair.drift.length === 0 && pair.extra.length === 0) pass('两处字节一致', `${pair.count} 个文件`)
  else {
    fail('两处不一致', `${pair.drift.length} 个漂移 / ${pair.extra.length} 个多余`)
    for (const d of pair.drift.slice(0, 12)) console.log(`      drift: ${d}`)
    for (const e of pair.extra.slice(0, 12)) console.log(`      extra: ${e}`)
  }
}

// ── 3. 加载面：profile patch + bundles + 客户端产物 ────────────────────────
console.log('\n== 加载面 ==')
const profilePkg = join(PROFILE_HOME, 'package.json')
if (!existsSync(profilePkg)) warn('找不到 profile package.json', profilePkg)
else {
  const pp = readJson(profilePkg)
  const bundles = pp?.dsh?.profile?.bundles ?? []
  line(bundles.includes('dsh-macro-memory') ? 'PASS' : 'FAIL', true, 'bundles 含 dsh-macro-memory', `${bundles.length} 项`)
  const bad = OLD_IDS.filter((id) => bundles.includes(id))
  line(bad.length === 0 ? 'PASS' : 'FAIL', true, 'bundles 不含旧 id', bad.join(',') || '无')

  const patchFile = pp?.dsh?.profile?.patch ?? 'cordis.patch.yml'
  const patchPath = join(PROFILE_HOME, patchFile)
  if (!existsSync(patchPath)) warn('找不到 patch 文件', patchPath)
  else {
    const src = readFileSync(patchPath, 'utf8')
    const macroHits = (src.match(/name:\s*'?"?dsh-macro-memory/g) ?? []).length
    line(macroHits === 1 ? 'PASS' : 'FAIL', true, 'patch 里恰好 1 条 dsh-macro-memory', String(macroHits))
    for (const id of OLD_IDS) {
      const n = (src.match(new RegExp(`name:\\s*'?"?${id}`, 'g')) ?? []).length
      line(n === 0 ? 'PASS' : 'FAIL', true, `patch 不含 ${id}`, String(n))
    }
  }
  // 这一段只看文本：文本写着 ≠ 装配后活着。真判据在 DSH 自己的 app-boot 里，
  // 由 tools/probe-load.mjs 去问（0.2.23）。这里只确认那条路还在，避免它被悄悄摘掉。
  line(existsSync(join(root, 'tools', 'probe-load.mjs')) ? 'PASS' : 'FAIL', true, '加载面还有 probe-load 去问 DSH 自己', 'tools/probe-load.mjs')
}

const clientFile = join(root, 'lib', 'client.js')
if (!existsSync(clientFile)) fail('lib/client.js 不存在（先跑 node build.mjs）')
else {
  const buf = readFileSync(clientFile)
  const src = buf.toString('utf8')
  pass('lib/client.js', `${buf.length} B  sha256=${createHash('sha256').update(buf).digest('hex').slice(0, 12)}…`)
  for (const id of ['dsh-macro-memory', 'dsh-macro-memory-meow', 'dsh-macro-memory-nebula']) {
    line(src.includes(id) ? 'PASS' : 'FAIL', true, `产物含 ${id}`)
  }
  (src.includes('brandCtx') ? pass : warn)('产物含 panel 归口（brandCtx）')
}

// ── 4. 补丁账本：vendor 里是我们拷进来的第三方引擎，改动必须记账 ──────────────
// 为什么单独一段：vendor 升级/重新拷贝会静默把补丁冲掉，而补丁没了不会报错，
// 只会让行为退回上游（例如归档的记忆又出现在检索结果里）。补丁必须能被机器找回来。
console.log('\n== 补丁账本 ==')
const PATCHES = [
  {
    file: 'vendor/dsh-memory-nebula/lib/host/recall.js',
    marker: '[macro-fusion 0.2.9]',
    what: '归档/删除的记忆不进检索结果（与 bridge.js statusFactor 同口径）',
  },
  {
    file: 'vendor/dsh-memory-nebula/lib/web/i18n.js',
    marker: '[macro-fusion 0.2.11]',
    what: '星图应用对外只叫「宏记忆 · 星图」（显示名，不动逻辑）',
  },
  {
    file: 'vendor/dsh-memory-nebula/lib/client.js',
    marker: "var LABEL = '宏记忆 · 星图'",
    what: '侧栏/iframe 标签与星图显示名一致',
  },
  {
    file: 'vendor/dsh-memory-nebula/lib/index.js',
    marker: '宏记忆 · 星图 · 宿主插件 [macro-fusion 0.2.11]',
    what: '注入横幅 / 工具描述 / stats 抬头都叫同一个名字',
  },
  {
    file: 'vendor/dsh-memory-nebula/lib/host/http.js',
    marker: '记忆星图的 HTTP 接口 + 静态页面。[macro-fusion 0.2.11]',
    what: '口令页标题叫「宏记忆 · 星图 · 需要口令」',
  },
  {
    file: 'vendor/dsh-memory-nebula/lib/host/share.js',
    marker: '[macro-fusion 0.2.11]',
    what: '离线快照标题与 index.html 的 <title> 同字（put 的 needle 一起改）',
  },
  {
    file: 'vendor/dsh-memory-nebula/lib/index.js',
    marker: '[macro-fusion 0.2.39]',
    what: '空命中也说清「图还是空的」还是「图里真没有」（带上图里的节点总数）',
  },
  {
    file: 'vendor/dsh-memory-nebula/lib/index.js',
    marker: '[macro-fusion 0.2.40]',
    what: '空图时体检说「等于没算」，不冒充「共 0 项」',
  },
  {
    file: 'vendor/dsh-memory-nebula/lib/index.js',
    marker: '[macro-fusion 0.2.41]',
    what: '空图时星图概况说清「这不是记忆丢了」，并给出原因',
  },
  {
    file: 'vendor/dsh-memory-nebula/lib/index.js',
    marker: '[macro-fusion 0.2.42]',
    what: '读单条记忆的空结果分「图还空着」与「图里没这条」（这句 graphState 也要读）',
  },
  {
    file: 'vendor/dsh-memory-nebula/lib/index.js',
    marker: '[macro-fusion 0.2.43]',
    what: '来源体检的「0 个来源」说清是没接上还是没读到（三种原因）',
  },
  {
    file: 'vendor/dsh-memory-nebula/lib/index.js',
    marker: '[macro-fusion 0.2.44]',
    what: '补邻居的空结果分四种原因，不再把「没找到种子」说成「都读过」',
  },
  {
    file: 'vendor/dsh-memory-nebula/lib/index.js',
    marker: '[macro-fusion 0.2.45]',
    what: '解释证据链只在真算过的时候才说「没有关系」，图空/没入图/引擎旧都单独说',
  },
  {
    file: 'vendor/meow-memory/lib/index.js',
    marker: '[macro-fusion 0.2.46]',
    what: '相似检索一条都没有的时候也说话：三种「没算成」分原因，只有词汇零重叠才说「没有相似」',
  },
  {
    file: 'vendor/meow-memory/lib/index.js',
    marker: '[macro-fusion 0.2.47]',
    what: '项目全景的空结果分三支：「名字对不上」不再冒充「这个项目没记忆」，别的层还有东西也要说',
  },
  {
    file: 'vendor/meow-memory/lib/index.js',
    marker: '[macro-fusion 0.2.48]',
    what: 'dream 没启动的四种原因分开说：消息没送出去不再冒充「没有需要整理的记忆」（工具面与 /dream 命令面同一套）',
  },
  {
    file: 'vendor/meow-memory/lib/index.js',
    marker: '[macro-fusion 0.2.49]',
    what: '改记忆的回执说清「改了什么 / 哪些字段没生效」：只给 id 或字段被过滤时不再回「✅ 已更新」',
  },
  {
    file: 'vendor/meow-memory/lib/index.js',
    marker: '[macro-fusion 0.2.50]',
    what: '写记忆的回执说清「层名被改过 / 哪些参数没生效 / 是合并不是新写」：层名拼错不再静默落进 fact',
  },
  {
    file: 'vendor/meow-memory/lib/index.js',
    marker: '[macro-fusion 0.2.51]',
    what: '检索的空结果说清「层名没对上 / 只在某几层里查过」：level 写错不再过滤成空数组冒充「记忆里没有」',
  },
  {
    file: 'vendor/meow-memory/lib/index.js',
    marker: '[macro-fusion 0.2.52]',
    what: '读记忆的短 id 撞车时不替你挑第一条：先数一遍（>1 就拒绝读并列出候选），查无此 id 时说清工作区与位数',
  },
  {
    marker: '[macro-fusion 0.2.53]',
    file: 'vendor/meow-memory/lib/index.js',
    what: '相似检索的基准短 id 撞车时一条都不比：不拿别人的正文当基准算相似度，没起点时说清工作区与位数',
  },
  {
    marker: '[macro-fusion 0.2.54]',
    file: 'lib/macro/linkflow.js',
    what: '连线归一不再只回「id 或 null」：短 id 撞车、这次没查成、真没有各说各的，前两种不摘补连队列',
  },
  {
    marker: '[macro-fusion 0.2.55]',
    file: 'lib/macro/store.js',
    what: '账本与队列的「空」分四种来路：没写过 / 写不进去 / 读不出来 / 全坏行，写成功即清零失败账',
  },
  {
    marker: '[macro-fusion 0.2.56]',
    file: 'vendor/meow-memory/lib/index.js',
    what: '检索参数给错了各说各的：状态值白名单、days 非正数、k / content_max 越界，都不许冒充「本次零命中」',
  },
  {
    marker: '[macro-fusion 0.2.57]',
    file: 'vendor/dsh-memory-nebula/lib/index.js',
    what: '数值参数统一走 numParam()：给 0 就照办 0，越界与非数字带一句话出来，不再被 Number(x) || 默认值 吃掉',
  },
  {
    marker: '[macro-fusion 0.2.58]',
    file: 'lib/macro/defs/search.js',
    what: '检索模式名归一后过白名单：写错就一句都不查（不再静默走本地检索），参数给错模式逐条说「这次没用上」',
  },
  {
    marker: '[macro-fusion 0.2.59]',
    file: 'lib/macro/defs/link.js',
    what: '连线先校验动作名与两端 id：缺参数不再被读成「暂时没落图，已排队」，也不排假欠账；maxHops / note 给错动作要说「这次没用上」',
  },
  {
    marker: '[macro-fusion 0.2.60]',
    file: 'lib/macro/panel.js',
    what: '卡片标题统一走 cardTitle()：动作键与模式键换成中文名、path 标成只读、空细节不留悬空冒号、多行压一行、超 40 字截断',
  },
  {
    marker: '[macro-fusion 0.2.61]',
    file: 'lib/macro/panel.js',
    what: '面板条数统一走 limitOf() 的 { value, note }：给 0 就照办 0（成本/待补两张面板要说清库里其实有多少行），负数与非数字回默认、非整数抹小数，都要带一句话出来',
  },
  {
    marker: '[macro-fusion 0.2.62]',
    file: 'lib/macro/shared.js',
    what: '条数参数统一走 countParam() 的 { value, note }：给 0 照办「不带」（读记忆的邻居），非数字与负数回默认、小数抹掉、超界夹住，三种都要说出口——不许悄悄变成「这条记忆没有邻居」',
  },
  {
    marker: '[macro-fusion 0.2.78]',
    file: 'lib/macro/linkflow.js',
    what: '写入时给的 links 先用 linkArgs 分两半：能连的条目 + 丢了几条（整份不是数组 / 空 id / 形状不对），再由 linkDropNote 说出来；不知道锚点是谁时另说一句「连排队都没法排」，不许 applyLinks 首行 `!anchorId` 直接吞掉整批',
  },
  {
    marker: '[macro-fusion 0.2.77]',
    file: 'lib/macro/shared.js',
    what: '读记忆的邻居段没拿到时收成 neighborGapNote(section, reachable, raw)：没查成 / 没查到这条记忆 / 回执里没这一段，三种状态三句话，都不许沉默成「这条记忆没有邻居」；defs/read.js 不许再用 `section ? … : said` 把失败说明拼掉',
  },
  {
    marker: '[macro-fusion 0.2.76]',
    file: 'lib/macro/cost.js',
    what: '成本面板的「最近 N 次」收成 costScope()：基句只报真算了的条数，再按需补「你要的是 X 次，账本里能算的只有 N 条」「更早的 K 条没进这次统计」「另有 B 行解析不出来」。readCost() 一次给 { body, scope }，costReport() 留成薄壳；defs/admin.js 不许再自己拼「最近 N 次调用」',
  },
  {
    marker: '[macro-fusion 0.2.75]',
    file: 'vendor/dsh-memory-nebula/lib/index.js',
    what: '枢纽榜的尾注收成 hubTail()：只说读者数得到的三个数（这段列了几条 / 有连接的记忆共几条 / hubs 上限几条），池子按 nodes − orphans 算；上限只剩 HUB_CAP 一个数（夹参数、尾注、schema 都读它）。不许再拿 nodes − top.length 当「还有 N 个枢纽没列」，也不许再补一句「没列的不代表是枢纽」打圆场',
  },
  {
    marker: '[macro-fusion 0.2.74]',
    file: 'vendor/dsh-memory-nebula/lib/index.js',
    what: '体检的条数账收成一个出口 listTail()：抬头只报全量计数，正文按 min(limit, 已取条数) 列，尾注 = 总数 − 已列并写明每类上限，三个数字必须能互相验算；不许再出现「这里只列前 N 条」那种把引擎内部截断写到抬头的老写法',
  },
  {
    marker: '[macro-fusion 0.2.73]',
    file: 'tools/doctor-verdict.mjs',
    what: '体检的判决只看 tag：屏幕写 FAIL 就必须计失败（tag 决定判决，第二参只补「声明通过却说没过」与 WARN）。判决器不许再搬回 doctor.mjs 自己记账，也不许改回 if (!ok)，否则 22 处 line(cond ? PASS : FAIL, true, …) 打红不红、体检照样 exit 0',
  },
  {
    marker: '[macro-fusion 0.2.70]',
    file: 'lib/macro/defs/admin.js',
    what: '卡片是回执的第二种排版：前缀只放面板中文名（品牌归抬头）、细节位按 PARAM_OWNERS 列这一轮真给了的参数（k=v，数组说条数），未知 action 带上用户写的原值；别再塞品牌回去',
  },
  {
    marker: '[macro-fusion 0.2.72]',
    file: 'lib/macro/defs/admin.js',
    what: '星图面板的「没结果」必须分两种说：装配没完成（等不到工具/被配置关掉）说「还没装配好」并指向配置，星图那边报错就把原因原样带出——别再合成一句「这次没接上，等就绪再试」，那会把 ENOENT 这类真实原因吃掉；判据只认 contract 的 NOT_READY_MARK，别抄字面量',
  },
  {
    marker: '[macro-fusion 0.2.71]',
    file: 'vendor/dsh-memory-nebula/lib/host/nebula.js',
    what: '枢纽条数的上限只许有一个出处（hubSlots，1..40）：概览按调用方要的条数取，默认 12 是给别人看的版面、不许被顺手改；stats 正文在列表被截断时要说「只列前 N 条 / 还有多少没列 / 上限 40」',
  },
  {
    marker: '[macro-fusion 0.2.69]',
    file: 'lib/macro/defs/search.js',
    what: 'id 只有 mode=similar 当基准、memory_ids 只有扩散时当起点：写在别的模式里被丢掉时必须说话——id 那句要带「这不是这条记忆被排除了」并给出正确用法，memory_ids 按真扩散 / 星图没接上 / 压根没扩散三种处境分开说',
  },
  {
    marker: '[macro-fusion 0.2.68]',
    file: 'lib/macro/defs/admin.js',
    what: '面板不读的参数不许悄悄消失：八个参数对每个 action 都合法，执行只取表里那一行列的——strayNote() 按 PARAM_OWNERS 反查点名「这参数归哪个 action」，并说清这次一点没参与（别读成「结果已经按它收窄过」）；手册那条 wrap:false 只免抬头，不免说话',
  },
  {
    marker: '[macro-fusion 0.2.67]',
    file: 'lib/macro/defs/search.js',
    what: '相似检索只认 id / k / content_max：query（读者以为在按句子找）、level / project / status / days / explain、hops、memory_ids 被丢掉时必须逐条说明「这次没用上」，并说清「这不是没有相似，是这几个条件压根没算」；content_max 是它认的，不许误报成没用上',
  },
  {
    marker: '[macro-fusion 0.2.66]',
    file: 'lib/macro/defs/search.js',
    what: 'graph / bridge 的本地条件（level / project / status / days / k / content_max / explain）按执行路径说话：走星图时说明「只在本地检索生效」，星图没接上退到本地检索时说明「它们真的用上了」，连兜底都没做时说「这一问压根没算」——不许拿走星图那一句去说退路',
  },
  {
    marker: '[macro-fusion 0.2.65]',
    file: 'lib/macro/defs/search.js',
    what: '检索尾注按「执行路径真的做了什么」说话：local 扩散用了 limit / hops 就说「真的用了它（limit=N）」，星图没接上就单独说「本来要扩散但没接上」，只有根本没扩散才说「这次没用上」——不许对所有非 graph/bridge 模式一律说没用上',
  },
  {
    marker: '[macro-fusion 0.2.64]',
    file: 'lib/macro/defs/admin.js',
    what: '体检的类别按白名单守（dup / stale / thin / oversize / unread / orphan）：大小写与前后空格归一，空串当没给，不认识就挡住并说清「这次体检没有跑」——不许照跑一遍全部、把「没查这一类」打成「这一类是 0」',
  },
  {
    marker: '[macro-fusion 0.2.64]',
    file: 'vendor/dsh-memory-nebula/lib/index.js',
    what: '体检的类别名取不到时原样打出来（labelOf），不再出现「undefined（0）」这种没有名字的 0',
  },
  {
    marker: '[macro-fusion 0.2.63]',
    file: 'lib/macro/prompt.js',
    what: '注入上限统一走 guideBudget() 的 { value, note }：写坏（"4k"、负数、null）回默认 1300 并进日志与手册末行，只有明确给 0 才照办 0——不许静默变成「零字注入」',
  },
  {
    file: 'vendor/dsh-memory-nebula/lib/host/nebula.js',
    marker: '宏记忆 · 星图导出',
    what: 'Markdown 导出抬头同名',
  },
  {
    marker: '[macro-fusion 0.2.79]',
    file: 'lib/index.js',
    what: '导出平铺到根的 volatile Config（设置页写入的唯一入口）：meow 的 14 个字段平铺 + 三个兼容段，写入走 loader/volatile-update，只重建工具面与注入，子插件不重挂',
  },
  {
    marker: '[macro-fusion 0.2.80]',
    file: 'vendor/meow-memory/lib/index.js',
    what: '注入消息的来源 kind 改成 plugin:macro-memory（宿主聊天卡直接显示这个字符串），老 kind plugin:meow-memory 仍然认得',
  },
  {
    marker: '[macro-fusion 0.2.80]',
    file: 'vendor/meow-memory/lib/client.js',
    what: '客户端同一份 kind 定义 + 设置页文案改成「宏记忆 / 已保存 ✓ 已生效」，不再谎称要重启插件',
  },
  {
    marker: '[macro-fusion 0.2.80]',
    file: 'vendor/dsh-memory-nebula/lib/host/transcripts.js',
    what: '工具调用画像把我家工具统一归到 plugin:macro-memory，不再分两个插件',
  },
  {
    marker: '[macro-fusion 0.2.81]',
    file: 'vendor/meow-memory/lib/index.js',
    what: '设置链路诊断默认不出声：DSH_MEMORY_SETTINGS_DIAG=1 才写 settings-diag.log，且有 256 KiB 上限（原先每调一次 describe 就追加几十行）',
  },
  {
    marker: '[macro-fusion 0.2.82]',
    file: 'tools/probe-toolsize.mjs',
    what: '修掉裸 root（ReferenceError，脚本 0.2.7x 起就跑不动）：改取 _root.mjs 的 vendorDir，并自己判「17 个原工具一个不少 + 字面量不膨胀」，进 check-all 第 12 支',
  },
  {
    marker: '[macro-fusion 0.2.83]',
    file: 'tools/probe-tools.mjs',
    what: '工具账本探测器：每个脚本必须有归属（STEPS / 被 import / 手动账本）、_root 导出不许白用、只读手动脚本真跑一遍；自带阴性对照，进 check-all 第 13 支',
  },
  {
    marker: '[macro-fusion 0.2.83]',
    file: 'tools/manual-tools.mjs',
    what: '手动脚本账本（6 条，每条带 smoke 与 why）：把「有意的」「忘了的」分开，账本不写逻辑',
  },
  {
    marker: '[macro-fusion 0.2.84]',
    file: 'tools/probe-words.mjs',
    what: '口径总账探针：手册 / schema / 常量 / README / 两份索引说的是不是同一件事（工具数、动作枚举、七个 level、体检六类、注入字符数、死指针），进 check-all 第 14 支，自带 6 条阴性对照',
  },
  {
    marker: '[macro-fusion 0.2.85]',
    file: 'vendor/meow-memory/lib/index.js',
    what: '召回校准（两处都在打分/排序里，坏起来一声不响）：① search() 的 importance 以前只豁免时间衰减、从不进分数，现在按 keywordHitScore 同口径 0.25 加成并写进 explain.importanceWeight；② 渲染前按 updated_at 升序把相关度整个丢掉，改成相关度降序、时间只做次级。基准在 tools/probe-recall.mjs（真引擎，含两条阴性对照）',
  },
]
for (const p of PATCHES) {
  const abs = join(root, p.file)
  if (!existsSync(abs)) fail('补丁目标不存在', p.file)
  else {
    const src = readFileSync(abs, 'utf8')
    line(src.includes(p.marker) ? 'PASS' : 'FAIL', true, `补丁在位：${p.what}`, p.file)
    if (!src.includes(p.marker)) console.log('      vendor 升级会冲掉补丁；按 README §9.14 重新打上再跑 verify')
  }
}

// ── 5. vendor 账本：拷进来的第三方源码有没有被改过（0.2.17）───────────────────
// 补丁账本管「我们打的补丁还在不在」，这一段管「除我们之外没人动过 vendor」。
// 两者互补：只有账本，会漏掉「补丁被自己改丢」；只有补丁，会漏掉「vendor 被整段换掉」。
console.log('\n== vendor 账本 ==')
{
  const manifestPath = join(root, 'vendor', 'VENDOR.json')
  if (!existsSync(manifestPath)) {
    fail('vendor 账本不存在', '跑 node tools/make-vendor-manifest.mjs')
  } else {
    const manifest = readJson(manifestPath)
    const { hashTree, vendorPackage, listFiles } = await import(pathToFileURL(join(root, 'tools', 'vendor-hash.mjs')).href)
    const listed = Array.isArray(manifest.vendors) ? manifest.vendors : []
    line(listed.length > 0 ? 'PASS' : 'FAIL', true, '账本里有 vendor 条目', String(listed.length))
    for (const v of listed) {
      const abs = join(root, v.dir)
      if (!existsSync(abs)) {
        fail(`账本指向的目录不存在`, v.dir)
        continue
      }
      const pkg = vendorPackage(abs)
      line(pkg?.version === v.version ? 'PASS' : 'FAIL', true, `账本版本与源码一致：${v.name}`, `账本=${v.version} 源码=${pkg?.version ?? '无 package.json'}`)
      const now = hashTree(abs)
      const same = now.files === v.files && now.bytes === v.bytes && now.sha256 === v.sha256
      line(same ? 'PASS' : 'FAIL', true, `账本指纹一致：${v.dir}`, same ? `${now.files} 文件 / ${now.bytes} B / ${now.sha256.slice(0, 16)}` : `账本 ${v.files}/${v.bytes}/${String(v.sha256).slice(0, 16)} ≠ 实际 ${now.files}/${now.bytes}/${now.sha256.slice(0, 16)}`)
      if (!same) console.log('      vendor 被改过：确认是自己改的就重跑 node tools/make-vendor-manifest.mjs，否则按 README §9.22 还原')
    }
    // 反向核对：vendor 下有没有目录没记账（新拷一个进来却没人发现，比改旧文件更常见）
    const onDisk = existsSync(join(root, 'vendor'))
      ? readdirSync(join(root, 'vendor')).filter((n) => statSync(join(root, 'vendor', n)).isDirectory())
      : []
    const known = new Set(listed.map((v) => v.dir.replace(/^vendor[\\/]/, '')))
    const unlisted = onDisk.filter((n) => !known.has(n) && n !== 'node_modules')
    line(unlisted.length === 0 ? 'PASS' : 'FAIL', true, 'vendor 下没有未记账的目录', unlisted.join(',') || `${onDisk.length} 个目录全部记账`)
  }
}

// ── 6. 自检基线：每支脚本「应该有多少条断言」也要记账（0.2.18）───────────────
// 为什么单开一段：check-all 拿 baselines.json 做「断言数回退」判定，基线本身过期就会误红或漏红。
// 最常见的过期方式是发版忘了 --update-baselines：版本号变了、条数也变了，但基线还写着上一个版本。
console.log('\n== 自检基线 ==')
{
  const baselinesPath = join(root, 'tools', 'baselines.json')
  if (!existsSync(baselinesPath)) {
    fail('基线文件不存在', '跑 node tools/check-all.mjs --update-baselines')
  } else {
    const base = readJson(baselinesPath)
    const counts = base.counts ?? {}
    line(base.version === pkg.version ? 'PASS' : 'FAIL', true, '基线版本与当前版本一致', `基线=${base.version} 当前=${pkg.version}`)
    if (base.version !== pkg.version) console.log('      发版后忘了重记：node tools/check-all.mjs --update-baselines')
    // 反向核对：check-all 里列的每一支都得有计数，否则新加的脚本永远不被记账
    const listed = [...readFileSync(join(root, 'tools', 'check-all.mjs'), 'utf8').matchAll(/^\s*\['([^']+\.mjs)'/gm)].map((m) => m[1])
    const missing = listed.filter((f) => counts[f] === undefined)
    line(listed.length > 0 && missing.length === 0 ? 'PASS' : 'FAIL', true, '基线覆盖 check-all 里的每一支', missing.join(',') || `${listed.length} 支`)
    const bad = Object.entries(counts).filter(([, n]) => !Number.isInteger(n) || n < 0)
    line(bad.length === 0 ? 'PASS' : 'FAIL', true, '基线条数都是非负整数', bad.map(([f, n]) => `${f}=${n}`).join(',') || `${Object.keys(counts).length} 支`)
    const total = Object.values(counts).reduce((n, v) => n + (Number.isInteger(v) ? v : 0), 0)
    console.log(`      基线条数合计 ${total} 条（断言数掉了 check-all 会判红；多了会提醒重记）`)

    // 耗时预算（0.2.19）：没有预算的脚本一旦卡死，整条验收命令就停在那里，
    // 分不清「还在跑」和「已经挂了」。所以每一支都必须有预算，而且要大于上次实测。
    const budgets = base.budgetMs ?? {}
    const lastMs = base.ms ?? {}
    const noBudget = listed.filter((f) => !Number.isInteger(budgets[f]) || budgets[f] <= 0)
    line(noBudget.length === 0 ? 'PASS' : 'FAIL', true, '每支都有耗时预算', noBudget.join(',') || `${Object.keys(budgets).length} 支`)
    const tooTight = listed.filter((f) => Number.isInteger(budgets[f]) && Number.isInteger(lastMs[f]) && budgets[f] < lastMs[f] * 2)
    line(
      tooTight.length === 0 ? 'PASS' : 'FAIL',
      true,
      '预算至少是上次实测的两倍',
      tooTight.map((f) => `${f} 预算${Math.round(budgets[f] / 1000)}s/实测${(lastMs[f] / 1000).toFixed(1)}s`).join(',') ||
        `最紧的一支 ${Math.round(Math.min(...listed.map((f) => (budgets[f] ?? 0) / Math.max(lastMs[f] ?? 1, 1))) * 10) / 10}×`,
    )
    const slowest = listed
      .filter((f) => Number.isInteger(lastMs[f]))
      .sort((a, b) => lastMs[b] - lastMs[a])
      .slice(0, 2)
      .map((f) => `${f} ${(lastMs[f] / 1000).toFixed(1)}s`)
    console.log(`      最慢的两支：${slowest.join('，') || '（还没记耗时）'}`)

    // 耗时漂移（0.2.20）：预算只挡「卡死」，挡不住「每次验收都慢一点」的退化。
    // 这里不重算漂移（那要跑一遍），只核对尺子还在：check-all 里必须有阈值常量，
    // 且 ms 与 budgetMs 覆盖同一批脚本——两张表错位时漂移判定会静默失效。
    const checkAllSrc = readFileSync(join(root, 'tools', 'check-all.mjs'), 'utf8')
    const hasFactor = /const SLOW_FACTOR = 1\.5/.test(checkAllSrc) && /const SLOW_FLOOR_MS = 1_000/.test(checkAllSrc)
    line(hasFactor ? 'PASS' : 'FAIL', true, '耗时漂移有阈值（1.5 倍、1s 以下不比）', hasFactor ? 'SLOW_FACTOR/SLOW_FLOOR_MS 在' : '常量缺失')
    const msOnly = listed.filter((f) => Number.isInteger(lastMs[f]) !== Number.isInteger(budgets[f]))
    line(
      msOnly.length === 0 ? 'PASS' : 'FAIL',
      true,
      '耗时表与预算表覆盖同一批脚本',
      msOnly.map((f) => `${f} ms=${lastMs[f] ?? '—'} budget=${budgets[f] ?? '—'}`).join(',') || `${Object.keys(lastMs).length} 支`,
    )
  }
}

// ── 6b. 存储层：路径只有一个出处（0.2.21）───────────────────────────────────
// 为什么单开：`$DSH_HOME` 一旦被多处读，就会出现「换个 home 之后账本写一边、队列写另一边」这种
// 只在别人的机器上复现的错。这里只做一件事：全 lib 数一遍谁读了 DSH_HOME，多一个就红。
console.log('\n== 存储层 ==')
{
  const libRoot = join(root, 'lib')
  const jsFiles = []
  const walkJs = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name)
      if (e.isDirectory()) walkJs(p)
      else if (e.name.endsWith('.js')) jsFiles.push(p)
    }
  }
  walkJs(libRoot)
  const readers = jsFiles.filter((f) => readFileSync(f, 'utf8').includes('process.env.DSH_HOME'))
  const rel = readers.map((f) => f.slice(root.length + 1).replace(/\\/g, '/'))
  line(
    rel.length === 1 && rel[0] === 'lib/macro/store.js' ? 'PASS' : 'FAIL',
    true,
    '路径只有一个出处（lib/macro/store.js）',
    rel.join(',') || '没人读 DSH_HOME',
  )
  const parsers = jsFiles.filter((f) => /JSON\.parse\(line\)/.test(readFileSync(f, 'utf8')))
  line(
    parsers.length <= 1 ? 'PASS' : 'FAIL',
    true,
    'jsonl 逐行解析没有第二份',
    parsers.map((f) => f.slice(root.length + 1).replace(/\\/g, '/')).join(',') || '无',
  )
  // 数据目录不在这里再算一遍：路径唯一出处在 store.js，第 7 段会直接打印 pendingPath()
}

// ── 6c. 结构：桥拆三件事，各一个文件（0.2.26）──────────────────────────────
// 为什么单开：`bridge.js` 曾把「收下工具/注入」「换门（Proxy）」「出文本」混在 292 行里。
// 这里只数位置：Proxy 只许在 facade.js，纯函数只许在 render.js，桥本身不许自己换门。
console.log('\n== 结构 ==')
{
  const src = (rel) => readFileSync(join(root, rel), 'utf8')
  const bridgeSrc = src('lib/macro/bridge.js')
  const facadeSrc = src('lib/macro/facade.js')
  const renderSrc = src('lib/macro/render.js')
  line(
    bridgeSrc.includes('export function createBridge') && !bridgeSrc.includes('new Proxy(') ? 'PASS' : 'FAIL',
    true,
    '桥只管收下与转调（Proxy 不在 bridge.js）',
    'lib/macro/bridge.js',
  )
  line(
    /export function createFacade/.test(facadeSrc) && facadeSrc.includes('new Proxy(') ? 'PASS' : 'FAIL',
    true,
    '换门只在 facade.js',
    'lib/macro/facade.js',
  )
  line(
    /export function renderToolText/.test(renderSrc) && !/^\s*import /m.test(renderSrc) ? 'PASS' : 'FAIL',
    true,
    '出文本是纯函数（render.js 不 import）',
    'lib/macro/render.js',
  )
  line(
    bridgeSrc.includes("from './facade.js'") && bridgeSrc.includes('export { errText }') ? 'PASS' : 'FAIL',
    true,
    '旧引用仍能从 bridge.js 转出（调用方不改）',
    'bridge.js → facade.js / render.js',
  )
}
  // 0.2.27：根只许在 _root.mjs 算一次。以前 13 种写法，其中两条把 D:/dsh-home 写死，
  // 还有一条拿 process.cwd() 当根——换个目录跑就找错地方（param-audit 会 ERR_MODULE_NOT_FOUND）。
  const otherTools = readdirSync(join(root, 'tools')).filter((n) => n.endsWith('.mjs') && n !== '_root.mjs')
  const rederived = otherTools.filter((n) => {
    const t = readFileSync(join(root, 'tools', n), 'utf8')
      .split('\n')
      .filter((l) => !/^\s*(\/\/|\*|\/\*|\*\/)/.test(l))
      .join('\n')
    return /const\s+root\s*=\s*(dirname\(|process\.cwd\(\)|['"]D:)/.test(t)
  })
  line(
    /export const root = dirname\(dirname\(fileURLToPath\(import\.meta\.url\)\)\)/.test(
      readFileSync(join(root, 'tools', '_root.mjs'), 'utf8'),
    ) && rederived.length === 0
      ? 'PASS'
      : 'FAIL',
    true,
    '根只有一处出处（tools/_root.mjs）',
    rederived.length ? rederived.join(', ') : 'tools/_root.mjs',
  )

// 补连预算是真的（0.2.28）：不是「星图恰好快」，而是每一次 await 都被剩余预算包着。
// tryCall 的 timeoutMs 只管「等工具注册」，execute 本身慢多久都照等——读路径最怕这个。
const linksBudgetSrc = readFileSync(join(root, 'lib', 'macro', 'links.js'), 'utf8')
const budgetWrapped = (linksBudgetSrc.match(/withBudget\(/g) ?? []).length
line(
  linksBudgetSrc.includes('export const MIN_STEP_MS') && budgetWrapped >= 4 ? 'PASS' : 'FAIL',
  true,
  '补连预算是真的（慢调用会被掐断，不是恰好快）',
  `withBudget ×${budgetWrapped}`,
)

// 跨插件措辞只有一处（0.2.29 / 0.2.38）：星图的回答只有文字，认字就是唯一的判据。
// 判据本身也只写一份——常量表在 tools/criteria.mjs，这里只把源码丢进去汇总成一行。
// （0.2.37 之前这里有第二份 bareMarks 手抄表；改一个值要改两处，一处红一处绿。）
const contractSrc = readFileSync(join(root, 'lib', 'macro', 'contract.js'), 'utf8')
const contractModule = await import(pathToFileURL(join(root, 'lib', 'macro', 'contract.js')).href)
const macroRead = (f) => readFileSync(join(root, 'lib', 'macro', f), 'utf8')
const contractList = criteria.contractChecklist({
  contractSrc,
  sources: {
    ...Object.fromEntries(criteria.CONTRACT_LEAK_FILES.map((f) => [f, macroRead(f)])),
    // 0.2.55：「空的四种来路」横跨存储层与两个面板，判据要读得到这三个文件
    'store.js': macroRead('store.js'),
    'cost.js': macroRead('cost.js'),
    // 0.2.61：面板条数的口径在 panel.js（limitOf）与 defs/admin.js（两处调用点）里
    'panel.js': macroRead('panel.js'),
    'defs/admin.js': macroRead(join('defs', 'admin.js')),
    // 0.2.62：条数出口在 shared.js（countParam），调用点在 defs/read.js
    'shared.js': macroRead('shared.js'),
    'defs/read.js': macroRead(join('defs', 'read.js')),
    // 0.2.63：注入上限的口径在 prompt.js（guideBudget），调用点在 lib/index.js 与 defs/admin.js
    'prompt.js': macroRead('prompt.js'),
  },
  runtime: contractModule,
  nebIndexSrc: readFileSync(join(root, 'vendor', 'dsh-memory-nebula', 'lib', 'index.js'), 'utf8'),
  nebCoreSrc: readFileSync(join(root, 'vendor', 'dsh-memory-nebula', 'lib', 'host', 'nebula.js'), 'utf8'),
  meowIndexSrc: readFileSync(join(root, 'vendor', 'meow-memory', 'lib', 'index.js'), 'utf8'),
})
line(
  contractList.every((c) => c.ok) ? 'PASS' : 'FAIL',
  true,
  '跨插件措辞只有一处，且有断言盯 vendor',
  criteria.summarizeChecklist(contractList),
)

// 「找不到这两条记忆」按年龄分辨（0.2.30）：星图的 404 既可能是「节点还没建进图」，也可能是「记忆真的没了」。
// 旧代码一律当永久失败摘掉，代价是刚写完记忆顺手连的线被清空，且不报错。
const graceSrc = readFileSync(join(root, 'lib', 'macro', 'links.js'), 'utf8')
const flowSrc30 = readFileSync(join(root, 'lib', 'macro', 'linkflow.js'), 'utf8')
// 0.2.33：理由表与面板（判据在下面「排队理由只有一份」那一行）
const linksSrc33 = readFileSync(join(root, 'lib', 'macro', 'links.js'), 'utf8')
const linksRuntime = await import(pathToFileURL(join(root, 'lib', 'macro', 'links.js')).href)
const flowSrc33 = flowSrc30
const linkSrc33 = readFileSync(join(root, 'lib', 'macro', 'defs', 'link.js'), 'utf8')
const adminSrc33 = readFileSync(join(root, 'lib', 'macro', 'defs', 'admin.js'), 'utf8')
const graceAged = /Date\.now\(\) - entry\.ts >= MISSING_GRACE_MS/.test(graceSrc)
const queueBothWays = flowSrc30.includes('saysMissingNodes(r.text)') && flowSrc30.includes('PENDING_REASONS.notBuilt')
const noOneShot = !graceSrc.includes('isPermanentFailure') && !flowSrc30.includes('isPermanentFailure')
line(
  graceAged && queueBothWays && noOneShot ? 'PASS' : 'FAIL',
  true,
  '同一句「找不到」按年龄分辨，写路径会排队',
  graceAged ? 'MISSING_GRACE_MS 生效' : '缺年龄判据',
)

// 前台写路径也有期限（0.2.31）：0.2.28 的预算只管后台补连，前台 memory_link / applyLinks 一直裸等
// execute，星图建图争锁时调用会挂几十秒。判据两条：期限常量在、两条前台调用都套了 withBudget。
const linkSrc31 = readFileSync(join(root, 'lib', 'macro', 'defs', 'link.js'), 'utf8')
const boundedWrite = flowSrc30.includes("withBudget(tryCall('nebula_link'") && linkSrc31.includes("withBudget(flow.tryCall('nebula_link', payload")
const noBareWait = !flowSrc30.includes("const r = await tryCall('nebula_link'")
line(
  boundedWrite && noBareWait ? 'PASS' : 'FAIL',
  true,
  '前台写连线也有期限，超时排队不挂死',
  boundedWrite ? 'LINK_CALL_MS 生效' : '前台仍裸等 execute',
)

// 一批连线两道闸（0.2.32）：单条期限管不了「12 条各挂 20 秒 = 4 分钟」，
// 而旧的 `items.slice(0, 12)` 会把第 13 条起悄悄吃掉。判据：两道闸都在、静默截断消失、超出会排队。
const batchGated = flowSrc30.includes('const deadline = Date.now() + linkBatchMs') && flowSrc30.includes('Math.min(linkCallMs, left)')
const noSilentCut = !flowSrc30.includes('items.slice(0, 12)') && flowSrc30.includes('[...overflow, ...later]')
line(
  batchGated && noSilentCut ? 'PASS' : 'FAIL',
  true,
  '一批连线有总账，超出的排队不消失',
  batchGated ? 'LINK_BATCH_MS 生效' : '缺整批总账',
)

// 理由与期限各只有一份（0.2.33）：同一个「连线失败」以前两种叫法，面板按理由分组就多一组；
// 1200/1500/8/20/1500 以前散在三处，面板还自己传一遍数。
//
// 0.2.35：判据本身也只有一份 —— 以前这段与 verify 的 A31 各写一遍，宽严还不一致
// （verify 拿五个值逐个查裸字面量，这里只钉了两个），把 `'连线失败待重试'` 抄回去会
// verify 红、doctor 绿。现在两边都读 tools/criteria.mjs，红的时候这里直接说清哪几条。
const list = criteria.reasonChecklist({
  linksSrc: linksSrc33,
  flowSrc: flowSrc33,
  linkSrc: linkSrc33,
  adminSrc: adminSrc33,
  reasons: linksRuntime.PENDING_REASONS ?? {},
  order: linksRuntime.REASON_ORDER ?? [],
})
const bad = list.filter((c) => !c.ok)
line(
  bad.length === 0 ? 'PASS' : 'FAIL',
  true,
  '排队理由与期限的口径只此一份（判据见 tools/criteria.mjs）',
  criteria.summarizeChecklist(list),
)

// ── 7. 运行时：注入长度、队列、账本 ─────────────────────────────────────────
console.log('\n== 运行时 ==');
const prompt = await import(pathToFileURL(join(root, 'lib', 'macro', 'prompt.js')).href)
const guide = prompt.clampGuide(prompt.GUIDE_TEXT, prompt.GUIDE_MAX_CHARS)
line(guide.length <= prompt.GUIDE_MAX_CHARS ? 'PASS' : 'FAIL', true, 'L0 注入不超上限', `${guide.length}/${prompt.GUIDE_MAX_CHARS} 字符`)
// 0.2.34：上限本身不是问题，问题是「切了不说」。余量掉到下限以下就该删句子；
// 真要截断时尾巴必须把「去哪看全文」留住。
const headroom = prompt.GUIDE_MAX_CHARS - guide.length
const truncates = guide === prompt.GUIDE_TEXT ? false : guide.includes(prompt.GUIDE_TAIL_MARK)
line(
  headroom >= prompt.GUIDE_MIN_HEADROOM ? 'PASS' : 'FAIL',
  true,
  'L0 注入留有余量，不贴上限',
  `余量 ${headroom} / 下限 ${prompt.GUIDE_MIN_HEADROOM} 字符`,
)
const longProbe = prompt.clampGuide('x'.repeat(4000), 400)
line(
  truncates || (longProbe.length <= 400 && longProbe.includes('memory_admin(action="guide")')) ? 'PASS' : 'FAIL',
  true,
  '注入被截断时会自己说出来（尾巴留住全文入口）',
  longProbe.includes('memory_admin(action="guide")') ? 'GUIDE_TAIL_MARK 生效' : '截断后出口丢了',
)
for (const tool of ['memory_remember', 'memory_admin']) {
  line(guide.includes(tool) ? 'PASS' : 'FAIL', true, `注入覆盖 ${tool}`)
}

const cost = await import(pathToFileURL(join(root, 'lib', 'macro', 'cost.js')).href)
console.log(`      macro home = ${linksRuntime.pendingPath()}`)
const pending = linksRuntime.readPending()
line(pending.length <= linksRuntime.PENDING_MAX ? 'PASS' : 'FAIL', true, '待补连队列未溢出', `${pending.length}/${linksRuntime.PENDING_MAX}`)
// 同理（0.2.55）：这一条也永远算一条断言，别让「前面探针排了一条补连」把断言数顶高
if (pending.length > 0) line('PASS', true, '有排队中的连线（读记忆会自动补）', `${pending.length} 条`)
else line('PASS', true, '当前没有排队中的连线', '0 条')
const ledger = cost.ledgerPath()
// 这一条永远算一条断言（0.2.55）：原先「账本在 → PASS 一行 / 不在 → 只 console.log」，
// 于是同一次 check-all 里账本先被前面的探针写过、后又被清掉，断言数就会 77/78 跳一格。
if (existsSync(ledger)) line('PASS', true, '成本账本存在', `${statSync(ledger).size} B`)
else line('PASS', true, '成本账本还没生成（还没调用过工具）', '0 B')

// ── 6. 文档声称（文档写了什么，就得是什么）────────────────────────────────
// 0.2.81：文档拆成两份。根 README.md 是给外面看的门面（DSH 市场详情页直接拿它渲染），
// docs/INTERNAL.md 是逐轮开发日志（原来那份 268 KB 的 README）。判据各管各的：
// 「脚本有没有出处」属于内部日志；「版本号 / 产物字节数 / 许可 / 图」两份都得对得上。
console.log('\n== 文档声称 ==')
const internalPath = existsSync(join(root, 'docs', 'INTERNAL.md'))
  ? join(root, 'docs', 'INTERNAL.md')
  : join(root, 'README.md')
if (!existsSync(internalPath)) warn('找不到 docs/INTERNAL.md')
else {
  const md = readFileSync(internalPath, 'utf8')
  // 6.1 内部日志提到的 tools/<x>.mjs 都得真的存在
  const mentioned = [...new Set([...md.matchAll(/tools\/([A-Za-z0-9._-]+\.mjs)/g)].map((m) => m[1]))]
  const ghost = mentioned.filter((n) => !existsSync(join(root, 'tools', n)))
  if (ghost.length === 0) pass('内部日志提到的脚本都存在', `${mentioned.length} 个`)
  else fail('内部日志提到的脚本不存在', ghost.join(','))
  // 6.2 反向：tools/ 下每个脚本都要在内部日志里露过面（临时脚本以 _ 开头不算）
  const onDisk = readdirSync(join(root, 'tools')).filter((n) => n.endsWith('.mjs') && !n.startsWith('_'))
  const undocumented = onDisk.filter((n) => !mentioned.includes(n))
  if (undocumented.length === 0) pass('脚本都有文档出处', `${onDisk.length} 个`)
  else warn('脚本缺文档出处', `${undocumented.length}/${onDisk.length} 未记录：${undocumented.join(',')}`)
  // 6.3 版本号
  if (md.includes(pkg.version)) pass('内部日志提到当前版本号', pkg.version)
  else warn('内部日志未提当前版本号', pkg.version)
}

// 6.4 对外门面：这一份会被市场详情页与 GitHub 首页直接展示，缺一句话就是对外缺一句话。
const publicPath = join(root, 'README.md')
if (!existsSync(publicPath)) fail('找不到公开 README.md', publicPath)
else {
  const face = readFileSync(publicPath, 'utf8')
  pass('公开 README 存在', `${readFileSync(publicPath).length} B`)
  if (face.includes(pkg.version)) pass('公开 README 提到当前版本号', pkg.version)
  else warn('公开 README 未提当前版本号', pkg.version)
  // 产物数字：门面上写的是「这个包现在长什么样」，过时就是假话。
  if (existsSync(clientFile)) {
    const bytes = readFileSync(clientFile).length
    const human = bytes.toLocaleString('en-US')
    const hex = createHash('sha256').update(readFileSync(clientFile)).digest('hex')
    if (face.includes(human)) pass('公开 README 的 client.js 字节数是最新的', human)
    else warn('公开 README 的 client.js 字节数过时', `实际 ${human}`)
    if (new RegExp(hex.slice(0, 8), 'i').test(face)) pass('公开 README 的 sha256 前缀是最新的', `${hex.slice(0, 8).toUpperCase()}…`)
    else warn('公开 README 的 sha256 前缀过时', `实际 ${hex.slice(0, 8).toUpperCase()}…`)
  }
  // 门面里每一张图都得真的在仓库里——市场详情页不会替我们兜住一个空图片框。
  const images = [...face.matchAll(/!\[[^\]]*\]\(([^)\s]+)\)/g)]
    .map((m) => m[1])
    .filter((p) => !/^https?:/i.test(p))
  const missing = images.filter((p) => !existsSync(join(root, p)))
  if (images.length > 0 && missing.length === 0) pass('公开 README 引用的图都在', `${images.length} 张`)
  else fail('公开 README 引用的图缺失', missing.join(',') || '一张图都没引用')
}

// 6.5 许可与第三方声明：MIT 要留着别人的版权声明，这事不能只写在口头。
const licensePath = join(root, 'LICENSE')
if (existsSync(licensePath) && /^MIT License/.test(readFileSync(licensePath, 'utf8'))) pass('根 LICENSE 是 MIT 原文')
else fail('根 LICENSE 缺失或不是 MIT', licensePath)
const noticesPath = join(root, 'THIRD-PARTY-NOTICES.md')
if (existsSync(noticesPath)) {
  const notes = readFileSync(noticesPath, 'utf8')
  const needs = [
    ['Phant0Meow', 'meow 原作者署名'],
    ['https://github.com/Phant0Meow/dsh-meow-memory', 'meow 上游地址'],
    ['MIT', '许可类型'],
  ]
  const lacking = needs.filter(([text]) => !notes.includes(text)).map(([, what]) => what)
  if (lacking.length === 0) pass('第三方声明留着原作者署名与上游地址', `${needs.length} 项都在`)
  else fail('第三方声明缺项', lacking.join('、'))
} else fail('找不到 THIRD-PARTY-NOTICES.md', noticesPath)

// 6.6 市场索引：文件得在（内容合不合格式由 tools/check-market.mjs 用真校验器判）
const indexPath = join(root, 'plugin-market', 'index.json')
if (existsSync(indexPath)) pass('市场索引文件存在', `${readFileSync(indexPath).length} B`)
else fail('找不到 plugin-market/index.json', indexPath)

// ── 7. 备份 ─────────────────────────────────────────────────────────────────
console.log('\n== 备份 ==')
const backupRoot = 'D:\\备份'
if (existsSync(backupRoot)) {
  const latest = readdirSync(backupRoot)
    .filter((n) => n.includes('macro-fusion'))
    .sort()
    .at(-1)
  if (latest) pass('存在流程备份', latest)
  else warn('还没建过流程备份', backupRoot)
} else warn('备份目录不存在', backupRoot)

console.log(
  failuresSummary(),
)
function failuresSummary() {
  return verdict.fails === 0
    ? `\n结果：${verdict.warns === 0 ? 'ALL PASS' : `PASS（${verdict.warns} 条 WARN）`}`
    : `\n${verdict.fails} FAILURE(S) / ${verdict.warns} WARN`
}
process.exit(verdict.fails > 0 || (STRICT && verdict.warns > 0) ? 1 : 0)
