/**
 * 探针：注入预算（0.6.38 · 能力版，不加能力的省）
 *
 * 为什么要有这一支：长期记忆注入是每轮都发生的固定开销，而绝大多数轮次里
 * 用户根本用不到注入的那几千字。0.6.38 给用户一个可调的字符预算
 * （`injectMaxChars`，默认 0＝不限，等于旧行为），超预算时按「条目整条留 / 整条不留」
 * 与「句子按相关度留」两把刀压下去，并且**压缩必自述**——不许模型把截断后的注入
 * 当成全部事实。
 *
 * 这一支守的是三条底线：
 *  ① 默认不限时必须与旧拼法**逐位相同**（不许偷偷改默认行为）；
 *  ② 设了上限就必须**真的不超**（含自述尾巴）；
 *  ③ 压缩时查询词所在的那句与首句要留住，条目头不许丢（能力不能因为省而掉）。
 */
import { root } from './_root.mjs'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const V = await import(pathToFileURL(join(root, 'vendor', 'meow-memory', 'lib', 'index.js')).href)
const src = readFileSync(join(root, 'vendor', 'meow-memory', 'lib', 'index.js'), 'utf8')

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

// ── 夹具：3 条 200 字左右的长条目，第 4 句才提到查询词 ──────────────────────
const SENTS = [
  '这句是开场，讲的是别的事情，跟降糖药没有关系，只是把上下文铺开而已。',
  '第二句继续铺垫，说的是季节与天气，秋天到了，风比上周凉，早晚要加一件外套。',
  '第三句讲工作节奏，本周的排期比上周松一些，下午基本能腾出一段时间来。',
  '第四句才是正题：降糖药第一次吃一般从最小剂量开始，按医生给的表往上加。',
  '第五句收尾，提醒复诊时要带上之前的记录，方便医生判断下一步怎么调。',
]
const LONG = SENTS.join('')
const ENTRIES = [
  { id: 'aaa11111', level: 'topic', project: '全局', updated_at: Date.UTC(2026, 10, 20, 3, 0), content: LONG },
  { id: 'bbb22222', level: 'fact', project: '全局', updated_at: Date.UTC(2026, 10, 21, 3, 0), content: LONG },
  { id: 'ccc33333', level: 'lesson', project: '全局', updated_at: Date.UTC(2026, 10, 22, 3, 0), content: LONG },
]
const Q = '降糖药 剂量'

// ── B0 形状：常量 / 函数 / 导出 ─────────────────────────────────────────────
{
  // [0.6.56] 自述尾巴改为「现场量最坏情况」预留，INJECT_NOTE_RESERVE 保留但只当标签
  // 缺失时的兜底——所以这里仍然钉它的值，同时钉住「量过才用」的那段代码在位。
  ok('B0 常量在位：正文上限 240 / 整条最小 60 / 自述兜底 120 / 预览档 36',
    src.includes('var INJECT_BODY_MIN = 60;') && src.includes('var INJECT_BODY_CAP = 240;') && src.includes('var INJECT_NOTE_RESERVE = 120;') && src.includes('var INJECT_BODY_PREVIEW_MIN = 36;') && src.includes('const tailWorstLong = budgeted'))
  ok('B0 渲染器与段级预算都在', src.includes('function renderHitEntries(entries, o, query) {') && src.includes('function budgetText(text, cap, label = \'\') {'))
  ok('B0 五个口子都导出（探针才测得动）',
    ['renderHitEntries', 'budgetText', 'squeezeBody', 'injectTermsOf', 'splitSentsOf'].every((k) => typeof V[k] === 'function'),
    ['renderHitEntries', 'budgetText', 'squeezeBody'].map((k) => typeof V[k]).join('/'))
  ok('B0 默认值是 0（不限＝旧行为）', /injectMaxChars: 0,/.test(src))
  ok('B0 配置进了热生效白名单', /LIVE_CONFIG_KEYS = \[[^\]]*"injectMaxChars"/.test(src))
  ok('B0 resolveConfig 落成非负整数', src.includes('Math.max(0, Math.floor(c.injectMaxChars))'))
  ok('B0 名次分配的两个比例在位（第一名 2 倍 / 其余 0.6 倍）',
    src.includes('var INJECT_BODY_TOP_RATIO = 2;') && src.includes('var INJECT_BODY_TAIL_RATIO = 0.6;') && src.includes('function rankBodyMax(base, i) {'))
}

// ── B1 默认不限：与旧拼法逐位相同 ───────────────────────────────────────────
{
  const header = (V.labels && V.labels.inject && V.labels.inject.hitHeader) || ''
  const r0 = V.renderHitEntries(ENTRIES, { injectMaxChars: 0, injectBodyMax: 0, titleMax: 40 }, Q)
  const rUndef = V.renderHitEntries(ENTRIES, { injectBodyMax: 0, titleMax: 40 }, Q)
  ok('B1 默认 0：三条全量、无人被压', r0.modes.every((m) => m === 'full') && r0.dropped === 0, r0.modes.join(',') + ' drop ' + r0.dropped)
  ok('B1 不传字段等同传 0（老配置对象不会被改变行为）', r0.text === rUndef.text, `len ${r0.text.length} vs ${rUndef.text.length}`)
  // [macro-fusion 0.6.48] 默认 240 不再是「每条 240」，而是「基准 240」：第一名两倍、其余六成。
  {
    const rb = V.renderHitEntries(ENTRIES, { injectBodyMax: 240 }, Q)
    ok('B1b 名次分配：第一条整条给出、后面两条被压到六成份额',
      rb.modes[0] === 'full' && rb.modes.slice(1).every((m) => m === 'squeeze'), rb.modes.join(','))
    const seg = (i) => String(rb.text).split('[' + ENTRIES[i].id + ']')[1].split('\n\n')[0]
    ok('B1b 第一条拿的是两倍基准（条目 170 字 < 480，整条全留）', seg(0).length > 120 && seg(0).includes('第五句收尾'), 'len ' + seg(0).length)
    ok('B1b 第二条只拿六成基准（正文 ≤ 144 字，正题句仍在）',
      seg(1).length <= 144 && seg(1).includes('降糖药第一次吃一般从最小剂量开始'), 'len ' + seg(1).length)
    ok('B1b 名次分配不改变「有没有压」的记账：bodyCut 数的是被压条数', rb.bodyCut === 2, 'bodyCut ' + rb.bodyCut)
  }
  ok('B1 默认输出含全部三条 id 与全部正文',
    ENTRIES.every((e) => r0.text.includes(e.id) && r0.text.includes(e.content)) && r0.text.length > 600,
    `len ${r0.text.length}`)
  ok('B1 默认输出没有自述尾巴（没压缩就不许吓唬模型）', !r0.text.includes('按上限'))
  if (header === '') console.log('NOTE labels 未就绪，B1 的 header 比对跳过')
}

// ── B2 设了上限就必须真的不超 ───────────────────────────────────────────────
{
  const caps = [1200, 800, 600, 400, 300, 240, 180, 120, 60]
  const over = []
  for (const cap of caps) {
    const r = V.renderHitEntries(ENTRIES, { injectMaxChars: cap }, Q)
    if (r.text.length > cap) over.push(`${cap}→${r.text.length}`)
  }
  ok('B2 九个档位全部严格 ≤ 上限（自述尾巴也算在内）', over.length === 0, over.length ? over.join(' ') : caps.join('/'))
}

// ── B3 条目头：够就全给，不够就给前缀，绝不打乱顺序 ─────────────────────────
{
  const r600 = V.renderHitEntries(ENTRIES, { injectMaxChars: 600 }, Q)
  const ids600 = ENTRIES.filter((e) => r600.text.includes(e.id)).map((e) => e.id)
  const r1200 = V.renderHitEntries(ENTRIES, { injectMaxChars: 1200 }, Q)
  ok('B3 预算紧时也留住了前两条（不是只给一条就收工）', ids600.length >= 2, ids600.join(','))
  ok('B3 预算很宽时仍是三条全量（不会因为开预算反而丢）', ENTRIES.every((e) => r1200.text.includes(e.id)) && r1200.dropped === 0)
  const r300 = V.renderHitEntries(ENTRIES, { injectMaxChars: 300 }, Q)
  const kept = ENTRIES.map((e, i) => (r300.text.includes(e.id) ? i : -1)).filter((i) => i >= 0)
  ok('B3 预算不足时留下的是前缀（按相关度顺序，不跳着留）',
    kept.length === 0 || kept.every((v, i) => v === i),
    `kept ${kept.join(',')} · drop ${r300.dropped}`)
}

// ── B4/B5 压缩时的能力：首句必留 + 查询词所在句必留 ────────────────────────
{
  const r = V.renderHitEntries(ENTRIES, { injectMaxChars: 600 }, Q)
  const squeezed = r.modes.filter((m) => m !== 'full').length
  ok('B4 600 档确实发生了正文压缩（否则这组断言没意义）', squeezed > 0, `压缩 ${squeezed} 条 · modes ${r.modes.join(',')}`)
  ok('B4 压缩后查询词所在句被留住', r.text.includes('降糖药第一次吃一般从最小剂量开始'), '第 4 句在位')
  ok('B5 压缩后首句也在（开场白是这条的定位句）', r.text.includes('这句是开场'), '第 1 句在位')
  // 只有「被压缩的那条」才该丢铺垫句；整条全量留下的那条五句都在是正常。
  const squeezedIdx = r.modes.findIndex((m) => m !== 'full')
  const squeezedSeg = squeezedIdx >= 0 ? r.text.split(ENTRIES[squeezedIdx].id)[1].split('\n\n')[0] : ''
  ok('B5 被压缩的那条丢的是铺垫句（第 2/3 句）而不是正题',
    squeezedIdx >= 0 && !squeezedSeg.includes('第二句继续铺垫') && squeezedSeg.includes('这句是开场'),
    squeezedIdx >= 0 ? `第 ${squeezedIdx + 1} 条 mode=${r.modes[squeezedIdx]}` : '没有条目被压缩')
}

// ── B6 压缩必自述：说清上限、压了几条、去哪取全文 ──────────────────────────
{
  const r = V.renderHitEntries(ENTRIES, { injectMaxChars: 600 }, Q)
  ok('B6 自述尾巴在位并写清上限数字', r.text.includes('按上限') && r.text.includes('600'))
  ok('B6 自述里给了 memory_read 的取全文指引', /memory_read\("?[a-z0-9]{8}"?\)/i.test(r.text) || r.text.includes('memory_read'))
  // [0.6.59] 预览档（36 字）把「一条都列不出」的临界点往下推了：同样的 200 字，
  // 现在能列出第一条的一句，于是 dropOnly 尾巴要另找一个更小的档来验（150 字）。
  const rTiny = V.renderHitEntries(ENTRIES, { injectMaxChars: 150 }, Q)
  ok('B6 上限只够骨架时自述改成「N 条没列出 + memory_search 去查」', rTiny.text.includes('没列出') && rTiny.text.includes('memory_search'), `len ${rTiny.text.length} · drop ${rTiny.dropped}`)
}

// ── B7 极小上限：只给骨架，绝不假装注入完整 ─────────────────────────────────
{
  for (const cap of [60, 95, 120]) {
    const r = V.renderHitEntries(ENTRIES, { injectMaxChars: cap }, Q)
    const noBody = r.modes.length === 0
    ok(`B7 上限 ${cap}：不塞半条正文（要么整条留，要么一条都不留）`,
      noBody || r.modes.every((m) => m === 'full' || m === 'squeeze'),
      `modes ${r.modes.join(',') || '(空)'} · drop ${r.dropped} · len ${r.text.length}`)
    ok(`B7 上限 ${cap}：长度不超且没有出现正文片段`, r.text.length <= cap && !r.text.includes('第四句才是正题'), `${r.text.length} ≤ ${cap}`)
  }
}

// ── B8 段级预算（项目全景 / 重放注入用） ───────────────────────────────────
{
  const blocks = ['# 项目：宏记忆', 'a'.repeat(200), 'b'.repeat(200), 'c'.repeat(200), '尾段：以上只是参考，全文用 memory_search 查。']
  const text = blocks.join('\n\n')
  const same = V.budgetText(text, 0)
  ok('B8 上限 0 时原样返回（默认不裁段）', same.text === text && same.dropped === 0, `len ${same.text.length}`)
  const wide = V.budgetText(text, 5000)
  ok('B8 文本没超上限时也原样返回', wide.text === text && wide.dropped === 0)
  const tight = V.budgetText(text, 600, '宏记忆')
  ok('B8 超上限时保住头段与尾段（标题与指路句不能丢）',
    tight.text.startsWith('# 项目：宏记忆') && tight.text.includes('尾段：以上只是参考'), `drop ${tight.dropped} · len ${tight.text.length}`)
  ok('B8 超上限时总长仍 ≤ 上限', tight.text.length <= 600, `${tight.text.length} ≤ 600`)
  ok('B8 裁剪后带自述（说清压了几段）', tight.text.includes('「宏记忆」') && /压|丢|省|上限/.test(tight.text))
}

// ── B9 读数：三档预算各能省多少（这一行就是本版的答卷） ────────────────────
{
  const r0 = V.renderHitEntries(ENTRIES, { injectMaxChars: 0 }, Q)
  const r400 = V.renderHitEntries(ENTRIES, { injectMaxChars: 400 }, Q)
  const r300 = V.renderHitEntries(ENTRIES, { injectMaxChars: 300 }, Q)
  const pct = (x) => (Math.round(x * 1000) / 10).toFixed(1) + '%'
  const save = (r) => pct(1 - r.text.length / r0.text.length)
  console.log(`MEASURE 注入长度：不限 ${r0.text.length} 字 · 400 → ${r400.text.length} 字（省 ${save(r400)}，留 ${r400.modes.length}/${ENTRIES.length} 条）· 300 → ${r300.text.length} 字（省 ${save(r300)}，留 ${r300.modes.length} 条）`)
  ok('B9 400 档省下三成以上且仍留下至少一条完整正文', r400.text.length <= 400 && r400.modes.length >= 1 && r400.text.length <= r0.text.length * 0.7,
    `${r400.text.length} 字 / 留 ${r400.modes.length} 条`)
  ok('B9 300 档把省做到一半以上', r300.text.length <= r0.text.length * 0.5, `${r300.text.length} ≤ ${Math.round(r0.text.length * 0.5)}`)
}

// ── B10 上限就是上限（0.6.57）：极端正文也不许「说好 N 实际 N+1」 ────────────
// 旧记账少算了「块间空行」与拼装换行，cap 240 上实测吐出 241——差 1 个字看起来无所谓，
// 但用户按 240 调的就是要 240；这一支把边缘钉死，别再回退。
{
  const flat = { id: '0mprobe001', content: 'a'.repeat(2000), level: 'fact', project: null, title: null, importance: 3, status: 'active', keywords: [], updatedAt: Date.now() }
  const over = []
  for (const cap of [200, 240, 300, 480, 600]) {
    for (const bodyMax of [0, cap, Math.floor(cap / 2)]) {
      const r = V.renderHitEntries([flat], { injectMaxChars: cap, injectBodyMax: bodyMax }, Q)
      if (r.text.length > cap) over.push(`cap ${cap}/body ${bodyMax} → ${r.text.length}`)
    }
  }
  ok('B10 无标点长正文：任何上限都不许多吐一个字', over.length === 0, over.join(' · ') || '5 档 × 3 种单条上限全部 ≤ cap')
}

// ── B11 同一句话只说一遍（0.6.57）：模板化长文里整句重复不许占两份预算 ──────
{
  // 正文要够长才会走压缩：满编（full）时一律原样呈现，去重只管压缩态。
  const dup = {
    id: '0mprobe002',
    content: '开头一句铺垫，说的是别的事情，只是把上下文铺开而已。' + 'injectBodyMax 是 240 字。'.repeat(6) + '收尾一句，讲的是还要补一句别人不关心的背景，凑长度用。',
    level: 'fact', project: null, title: null, importance: 3, status: 'active', keywords: [], updatedAt: Date.now(),
  }
  const r = V.renderHitEntries([dup], { injectMaxChars: 240, injectBodyMax: 240 }, 'injectBodyMax 是多少')
  const body = r.text.split('\n').filter((l) => !l.startsWith('[') && !/本条还有/.test(l) && !/^（以上为长期记忆/.test(l) && !/^…（本次注入按上限/.test(l)).join(' ')
  const twice = (body.match(/injectBodyMax 是 240 字/g) ?? []).length
  ok('B11 重复句在正文里只出现一次', twice <= 1, `出现 ${twice} 次 · 正文 ${body.trim().length} 字`)
  ok('B11 去重后仍留住正题句（不是靠少说话省字）', body.includes('240'))
}

// ── B12 自述让位（0.6.58）：小上限时逐条自述先让位，但整批尾巴绝不许一起消失 ──
// 每条只分到 60–80 字时，一句 40 多字的「全文用 memory_read 取」会把正文挤成 0；
// 让位可以，静默不行——尾巴必须还在（用户得知道这轮被压了、怎么取全文）。
{
  // 让位是真的会发生的：额度和整批尾巴先吃掉一部分，后面那条只剩几十字，
  // 这时 40 多字的指路话就该让给正文（前面那条预算宽裕，照旧自述）。
  const rows = [0, 1].map((i) => ({
    id: `0mprobe00${3 + i * 2}`,
    content: '先说一句铺垫，讲的是别的事。' + '这一段讲的是怎么调上限、上限调小之后会发生什么，说了很多遍。'.repeat(8),
    level: 'fact', project: null, title: null, importance: 3, status: 'active', keywords: [], updatedAt: Date.now(),
  }))
  const r = V.renderHitEntries(rows, { injectMaxChars: 340, injectBodyMax: 0 }, '上限调小 铺垫')
  const notes = (r.text.match(/本条还有 \d+ 字未展开/g) ?? []).length
  const hasTail = r.text.includes('按上限') && r.text.includes('memory_read')
  ok('B12 两条都要压时，后面那条不再逐条自述（把字数让给正文）', notes < rows.length, `自述 ${notes} 条 / 列出 ${rows.length} 条`)
  ok('B12 但整批尾巴必须在位（压了几条 + 怎么取全文）', hasTail, hasTail ? '尾巴在位' : '尾巴丢了：' + r.text.slice(-80))
  ok('B12 让位之后正文仍有内容（不是靠少说话省字）', r.modes.every((m) => m !== 'full') && r.text.length > 200, `${r.modes.join(',')} · ${r.text.length} 字`)
}

// ── B13 长句接续（0.6.58）：整句装不下时按分截断接在后头，别让预算空着 ────────
// 「一句 300 字、预算只够 200」是常有的真情况（真库 90 个关键句里 9 个属这类）。
// 旧写法直接跳过，于是这一条只剩开场铺垫；现在要在预算尾部咬掉一段，且不超过上限。
{
  const hard = {
    id: '0mprobe004',
    content: '预算上限这件事得从头说。' + '上限怎么算、算到哪一步、算完了又怎么调，这里一口气讲清楚不留余地，'.repeat(12) + '。',
    level: 'fact', project: null, title: null, importance: 3, status: 'active', keywords: [], updatedAt: Date.now(),
  }
  const r = V.renderHitEntries([hard], { injectMaxChars: 300, injectBodyMax: 0 }, '上限怎么算')
  // [0.6.59] 尾巴有长短两版，取正文时按前缀整行剔掉（短版以 `…（上限 300 字：` 开头）。
  const body = r.text.split('\n').filter((l) => !l.startsWith('[') && !/本条还有/.test(l) && !/^（以上为长期记忆/.test(l) && !/^…（/.test(l) && l.trim() !== '').join(' ')
  ok('B13 长句装不下时咬一段接上（正文里出现该句的开头）', body.includes('上限怎么算、算到哪一步'), '正文 ' + body.trim().length + ' 字')
  ok('B13 咬断处有省略号收尾（别让人以为句子就到此为止）', /…\s*$/.test(body.trim()), JSON.stringify(body.trim().slice(-20)))
  ok('B13 接续之后仍然不超上限', r.text.length <= 300, r.text.length + ' ≤ 300')
}

// ── B14 记账让位（0.6.59）：紧预算先薄头行与尾巴，正文才是钱 ──────────────────
// 真库量下来 cap 300 时 66% 花在头行（90 字/条）和尾巴（72 字/轮）上，正文只有 34%。
// 处方是分级：头行完整 → 去绝对时间 → 去 project；尾巴换短文案。信息不删，只让位。
{
  const one = {
    id: '0mprobe013',
    content: '上限这件事要讲清楚。' + '每段都讲上限怎么算。'.repeat(20),
    level: 'topic', project: 'dsh-macro-memory', title: null, importance: 3, status: 'active', keywords: [],
    updated_at: Date.now() - 7200e3,
  }
  const tight = V.renderHitEntries([one], { injectMaxChars: 240, injectBodyMax: 0 }, '上限怎么算')
  const roomy = V.renderHitEntries([one], { injectMaxChars: 900, injectBodyMax: 0 }, '上限怎么算')
  const headOf = (r) => r.text.split('\n').find((l) => l.startsWith('[')) ?? ''
  const tightHead = headOf(tight)
  const roomyHead = headOf(roomy)
  ok('B14 紧上限下头行不写绝对时间戳（省 18 字/条）', tightHead !== '' && !/\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(tightHead), tightHead)
  ok('B14 但 id 与相对时间必须在（还要能 memory_read）', tightHead.includes('0mprobe013') && /\[\d+ 分钟前\]|\[\d+ 小时前\]/.test(tightHead), tightHead)
  ok('B14 预算宽时绝对时间要回来（只让位，不删信息）', /\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(roomyHead), roomyHead)
  ok('B14 紧上限下尾巴换短文案', tight.text.includes('全文用上面各条 id 调 memory_read') && !tight.text.includes('本次注入按上限'), (tight.text.split('\n').pop() ?? '').slice(0, 46))
  ok('B14 薄了之后仍然不超上限', tight.text.length <= 240, `${tight.text.length} ≤ 240`)
}

// ── B15 预览档（0.6.59）：分不到 60 字也别整条丢掉，36 字换一个「它在讲什么」──
// 0.6.56 起的 60 字门槛在紧预算下会变成「一条都列不出、全进『N 条未列出』」，
// 模型连「有这么几条」都不知道。36–59 字之间列一句预览 + id，要全文再 memory_read。
{
  const mk = (id) => ({
    id,
    content: '先说一句铺垫，讲的是别的事。' + '这一段讲的是怎么调上限、上限调小之后会发生什么，说了很多遍。'.repeat(8),
    level: 'fact', project: null, title: null, importance: 3, status: 'active', keywords: [], updatedAt: Date.now(),
  })
  const rows = [mk('0mprobe011'), mk('0mprobe012')]
  const preview = V.renderHitEntries(rows, { injectMaxChars: 288, injectBodyMax: 0 }, '上限调小 铺垫')
  const squeezed = V.renderHitEntries(rows, { injectMaxChars: 240, injectBodyMax: 0 }, '上限调小 铺垫')
  ok('B15 分不到 60 字也列（36 字以上就给一句预览）', preview.modes.length === 2 && preview.dropped === 0, `${JSON.stringify(preview.modes)} · 漏 ${preview.dropped}`)
  ok('B15 预览档不留逐条自述（省下的字全给正文）', (preview.text.match(/本条还有/g) ?? []).length < 2, `自述 ${(preview.text.match(/本条还有/g) ?? []).length} 条 / 列出 ${preview.modes.length} 条`)
  ok('B15 预算真不够时照旧整条不列（不是无条件扩列）', squeezed.modes.length < 2 && squeezed.dropped > 0, `${JSON.stringify(squeezed.modes)} · 漏 ${squeezed.dropped}`)
  ok('B15 预览档一样不超上限', preview.text.length <= 288 && squeezed.text.length <= 240, `${preview.text.length} ≤ 288 · ${squeezed.text.length} ≤ 240`)
}

console.log('')
if (fail > 0) {
  console.log(`FAILED  passed ${pass} / failed ${fail}`)
  for (const b of bad) console.log('  ✗ ' + b)
  process.exitCode = 1
} else {
  console.log(`ALL PASS  probe-budget：${pass}/${pass}`)
}
