/**
 * 探针：星图邻域的「别将错就错」（0.6.38 · 主人第④条）
 *
 * 为什么要有这一支：`lib/macro/neighbor.js` 每轮把「这一轮的话在星图里连着谁」注入上下文。
 * 星图沿 1 跳扩散时会把「只沾一个词」的节点也带进来（强度 0.2 那种），旧实现照单全收——
 * 每轮塞 4 条噪声，比不注入更糟：模型会把它当本轮相关事实去推理，而且**改不了**：
 * 回执里没有来源 id，模型想断也断不掉，只能将错就错。
 *
 * 0.6.38 两刀：
 *  ① **弱邻居不注入**（`NEIGHBOR_MIN_SCORE = 0.35`，可配）：全弱就一个字都不注入，宁可空着；
 *  ② **注入块尾部给断边指引**：先用 `nebula_link(action="path")` 看这一跳怎么来的，
 *     再用 `action="mute"` 断掉（mute 是即时生效 + 重建不再连，所以注入侧不用再过滤）。
 *     配套：nebula 回执的 `why` 现在带来源 id，否则模型拿不到 a 端。
 *
 * 这一支守的底线：
 *  - 弱邻居过滤不能误杀强邻居，也不能因为过滤把「本轮该带的」清空后还硬凑；
 *  - 尾部指引不能挤掉条目（预算小的时候先保条目）；
 *  - 配置面（`neighborMinScore`）从 schema 到注入器一路接得上，改设置能真的生效。
 */
import { root } from './_root.mjs'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const NB = await import(pathToFileURL(join(root, 'lib', 'macro', 'neighbor.js')).href)
// 0.6.43 起邻域账本会落盘：探针必须把 DSH_HOME 指到临时目录，
// 否则每跑一次就在主人真库里留一堆 `n-0.xxxx.json`（第一版就是这样，还把 `gv-sess` 喂进了下一轮）。
const tmpHome = mkdtempSync(join(tmpdir(), 'macro-probe-neighbor-'))
process.env.DSH_HOME = tmpHome
const macroSrc = readFileSync(join(root, 'lib', 'index.js'), 'utf8')
const recallSrc = readFileSync(join(root, 'vendor', 'dsh-memory-nebula', 'lib', 'host', 'recall.js'), 'utf8')

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

// ── 夹具：nebula_recall 的真实回执形状（含强邻居 / 弱噪声 / 边界分 / 无 why） ──
const recall = [
  '星图邻域（1 跳，5 条）：',
  '',
  '1. [fact] dsh-macro-memory     强度 0.82 0.2.144 的交付态',
  '  id: ws:0mwq3aa9',
  '  为什么：经由「写入节流」的cooc关联扩散而来',
  '  摘要：交付态摘要',
  '2. [lesson] dsh-macro-memory     强度 0.61 判空别只判 undefined',
  '  id: 0mwq2ncq',
  '  为什么：经由「空值判定」的same-topic关联扩散而来',
  '3. [topic] 其他项目     强度 0.35 恰好卡在门槛上的那条',
  '  id: ws:0mabc123',
  '4. [fact] 无关项目     强度 0.20 只沾了一个词的噪声',
  '  id: ws:0mzzz999',
  '  为什么：经由「随便一个词」的cooc关联扩散而来',
  '5. [lesson] 无关项目     强度 0.08 更弱的一条',
  '  id: ws:0myyy888',
].join('\n')

// ── N0 形状：常量与导出 ────────────────────────────────────────────────────
{
  ok('N0 常量：门槛 0.35 / 尾部预留 150 / 原有四条没被挪动',
    NB.NEIGHBOR_MIN_SCORE === 0.35 &&
      NB.NEIGHBOR_TAIL_RESERVE === 150 &&
      NB.NEIGHBOR_DEFAULT_MAX === 4 &&
      NB.NEIGHBOR_DEFAULT_CHARS === 420 &&
      NB.NEIGHBOR_MIN_QUERY === 6,
    `min=${NB.NEIGHBOR_MIN_SCORE} reserve=${NB.NEIGHBOR_TAIL_RESERVE}`)
  ok('N0 渲染器仍在（纯函数，探针直接喂文本）', typeof NB.neighborBlockOf === 'function')
}

// ── N1 弱邻居不注入；强邻居一条不少 ────────────────────────────────────────
{
  const blk = NB.neighborBlockOf(recall, { max: 4, chars: 420 })
  ok('N1 强度 0.20 / 0.08 的噪声不进注入块',
    blk !== null && !blk.ids.includes('0mzzz999') && !blk.ids.includes('0myyy888'),
    blk === null ? 'null' : blk.ids.join(','))
  ok('N1 强邻居（0.82 / 0.61）与卡门槛的 0.35 都留着（判据是「小于」，不是「不大于」）',
    blk !== null && blk.ids.length === 3 && blk.ids[0] === '0mwq3aa9' && blk.ids[2] === '0mabc123',
    blk === null ? 'null' : `${blk.ids.length} 条`)
  ok('N1 被刷掉的条数记在 weak 里（不是静默丢）', blk !== null && blk.weak === 2, String(blk?.weak))
}

// ── N2 全弱：一个字都不注入（宁可空着，也不硬凑） ──────────────────────────
{
  const weakOnly = ['1. [fact] 别的项目     强度 0.12 噪声甲', '  id: ws:0maaa111', '2. [fact] 别的项目     强度 0.30 噪声乙', '  id: 0mbbb222'].join('\n')
  ok('N2 整批都是弱邻居时返回 null（不是空串、不是只有标题）', NB.neighborBlockOf(weakOnly, {}) === null)
  const half = NB.neighborBlockOf(recall, { max: 2, minScore: 0.9 })
  ok('N2 minScore 调高到 0.9 时同一批回执也全灭', half === null, half === null ? 'null' : half.ids.join(','))
}

// ── N3 阴性对照：门槛调成 0 时弱邻居又回来了（证明判据真的会红） ────────────
{
  // 字符上限放到 3000：这一条只验「门槛」，不许被 bodyCap 的排版上限搅进来。
  const loose = NB.neighborBlockOf(recall, { max: 5, chars: 3000, minScore: 0 })
  ok('N3 阴性对照：minScore=0 时 5 条全带（过滤确实由门槛决定，不是解析出了别的问题）',
    loose !== null && loose.ids.length === 5 && loose.weak === 0,
    loose === null ? 'null' : `${loose.ids.length} 条 / weak ${loose.weak}`)
}

// ── N4 尾部：给「看路径 + 断边」的指引，且用第一个 id 当 b 端 ──────────────
{
  const blk = NB.neighborBlockOf(recall, { max: 4, chars: 420 })
  const t = blk?.text ?? ''
  ok('N4 尾部教模型用 nebula_link(action="path") 看路径',
    t.includes('nebula_link(action="path"') && t.includes('b="0mwq3aa9"'), t.split('\n').pop()?.slice(0, 60))
  ok('N4 尾部教模型用 action="mute" 断掉错的那一跳',
    t.includes('action="mute"') && t.includes('重建也不再连'), '')
  ok('N4 尾部仍保留读全文的办法（原有能力不许因为加指引而丢）', t.includes('memory_read("0mwq3aa9")') && t.includes('别把上面的摘要当原文引用'))
  ok('N4 来源 id 从 why 里能抠出来（回执带「经由…」时模型才知道 a 端填谁）',
    t.includes('经由') , '')
}

// ── N5 预算：尾部不能挤掉条目；预算太小先保条目 ────────────────────────────
{
  const wide = NB.neighborBlockOf(recall, { max: 4, chars: 420 })
  ok('N5 默认 420 字符内：条目 + 尾部都在，且整块不超限',
    wide !== null && wide.text.length <= 420 && wide.text.includes('action="mute"'),
    wide === null ? 'null' : `${wide.text.length} ≤ 420`)
  const tight = NB.neighborBlockOf(recall, { max: 4, chars: 120 })
  ok('N5 120 字符档：先保条目（至少 1 条）且不超限',
    tight !== null && tight.ids.length === 1 && tight.text.length <= 120,
    tight === null ? 'null' : `${tight.ids.length} 条 / ${tight.text.length} 字`)
  ok('N5 120 档装不下尾部时就不加尾部（不是硬塞到超限，也不是为了尾部清零条目）',
    tight !== null && !tight.text.includes('action="mute"'), tight === null ? 'null' : String(tight.text.length))
  const reserved = NB.neighborBlockOf(recall, { max: 4, chars: 300 })
  ok('N5 300 字符档：尾部在位（预留 150 真的留出了位置）',
    reserved !== null && reserved.text.includes('action="mute"') && reserved.text.length <= 300,
    reserved === null ? 'null' : `${reserved.text.length} ≤ 300`)
}

// ── N6 原有语义一条不动：max=0 / skip / 空回执 ─────────────────────────────
{
  ok('N6 max=0 回 null', NB.neighborBlockOf(recall, { max: 0 }) === null)
  const skipped = NB.neighborBlockOf(recall, { skip: ['0mwq3aa9'] })
  ok('N6 带过的（裸 id）不再带，且尾部 b 端换成新的第一个',
    skipped !== null && !skipped.ids.includes('0mwq3aa9') && skipped.text.includes('b="0mwq2ncq"'),
    skipped === null ? 'null' : skipped.ids.join(','))
  ok('N6 空回执 / 解析不出节点 → null',
    NB.neighborBlockOf('', {}) === null && NB.neighborBlockOf('星图里没找到相关记忆', {}) === null)
}

// ── N7 接线：配置面一路接得上（schema / 白名单 / 注入器） ──────────────────
{
  ok('N7 宏记忆层 schema 里有 neighborMinScore（0–1）',
    macroSrc.includes('neighborMinScore: z.number().min(0).max(1).default(MACRO_DEFAULTS.neighborMinScore)'))
  ok('N7 MACRO_KEYS 白名单里也有（不然设置页写了不生效）',
    /MACRO_KEYS\s*=\s*\[[^\]]*'neighborMinScore'/s.test(macroSrc))
  ok('N7 注入器读 config.neighborMinScore 并传给渲染器',
    macroSrc.includes('neighborMinScore: NEIGHBOR_MIN_SCORE') &&
      readFileSync(join(root, 'lib', 'macro', 'neighbor.js'), 'utf8').includes('config.neighborMinScore'))
  ok('N7 星图回执的 why 带来源短 id（不然模型不知道该 mute 哪一端）',
    recallSrc.includes("split(':').pop().slice(0, 8)"))
}

// ── N8 端到端：配置改门槛 → 注入块真的少了那些弱邻居 ──────────────────────
{
  const mkRt = (text) => {
    const calls = []
    return {
      calls,
      bridge: {
        tryCall: async (name, args) => {
          calls.push({ name, args })
          return { text }
        },
      },
    }
  }
  const mkCtx = () => ({ on: () => () => {} })
  const make = ({ content, source }) => ({ content, source })
  const user = { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '写入节流那个窗口后来怎么定的' }] }
  const run = async (config) => {
    const rt = mkRt(recall)
    const inj = NB.createNeighborInjector({
      ctx: mkCtx(), bridge: rt.bridge, config, logger: () => {}, loadLlm: async () => ({ createUserMessage: make }),
    })
    const out = await inj.decide({ agent: { session: { id: 'n-' + Math.random() } } }, { kind: 'enter', messages: [user] })
    return { out, rt, stats: inj.stats() }
  }
  const def = await run({})
  const injected = def.out.messages.length === 2 ? def.out.messages[1].content[0].text : ''
  ok('N8 默认配置：注入 3 条（弱邻居被刷掉），多要 4 条给过滤留余量',
    def.out.messages.length === 2 && def.rt.calls[0].args.limit === NB.NEIGHBOR_DEFAULT_MAX + 4 &&
      !injected.includes('0mzzz999') && def.stats.injected === 1,
    `${injected.split('\n').length - 1} 行 / limit ${def.rt.calls[0]?.args?.limit}`)
  const strict = await run({ neighborMinScore: 0.9 })
  ok('N8 门槛调到 0.9：全弱 → 不注入，记一笔 skipped（不是 failed）',
    strict.out.messages.length === 1 && strict.stats.skipped === 1 && strict.stats.failed === 0,
    JSON.stringify(strict.stats))
  // 字符上限也一起放开：这一条只验「门槛」，排版上限不许掺进来（默认 420 只装得下 3 条）。
  const loose = await run({ neighborMinScore: 0, neighborChars: 3000 })
  const looseText = loose.out.messages.length === 2 ? loose.out.messages[1].content[0].text : ''
  // 0.6.43 起 decide 会带上问句（词面闸），所以「门槛调到 0」不再等于「5 条全带」：
  // 与问句一个二元组都不沾、强度又不到 0.5 的条目由 NEIGHBOR_OFFTOPIC_KEEP 配额管。
  // 这里验的是**强度闸确实被门槛放开**——弱邻居不再记 weak（判据最干净的一处）。
  // 0.6.43 起 decide 会带上问句（词面闸），所以「门槛调到 0」不再等于「5 条全带」：
  // 强度闸放开之后，零重合的弱条目由词面闸接管（NEIGHBOR_OFFTOPIC_KEEP 配额）。
  ok('N8 门槛调到 0：强度闸放开后由词面闸接管——0.08 / 0.20 那两条仍不进（不是没人管）',
    loose.out.messages.length === 2 && !looseText.includes('0myyy888') && !looseText.includes('0mzzz999') &&
      loose.stats.offtopic >= 2,
    JSON.stringify(loose.stats))
  const noQuery = NB.neighborBlockOf(recall, { minScore: 0, max: 5, chars: 3000 })
  ok('N8 阴性对照：不给 query 时渲染器仍按旧口径全带 5 条（词面闸是可选参数，不是硬编码）',
    noQuery !== null && noQuery.ids.length === 5 && noQuery.skipped === 0,
    noQuery === null ? 'null' : `${noQuery.ids.length} 条`)
}

// ── N9 0.6.43 三刀：词面闸 / 跨层去重 / 账本落盘 ──────────────────────────
// 守的底线：三道闸各自「该拦的拦、不该拦的放过」，并且都能在端到端链路上真的生效。
{
  const STORE = await import(pathToFileURL(join(root, 'lib', 'macro', 'store.js')).href)
  const q = NB.neighborTokens('星图 mute 怎么用')
  ok('N9 词面指纹：汉字取二元组、拉丁取整词，单字不参与（否则「的」恒真）',
    q.has('星图') && q.has('怎么') && q.has('mute') && !q.has('的') && !q.has('星'),
    [...q].slice(0, 8).join(' '))

  const one = (score, label, id) => ['星图邻域（1 跳，1 条）：', '', `1. [fact] 别的项目     强度 ${score} ${label}`, `  id: ws:${id}`].join('\n')
  // 强度免检：0.9 但一个词都不沾，仍然要带——换说法不等于无关。
  const strong = NB.neighborBlockOf(one(0.9, '完全另一个话题', '0mstr001'), { max: 2, chars: 700, query: '星图 mute 怎么用' })
  ok('N9 强度 ≥ 0.5 的词面零重合条目照带（免检，不误杀换了说法的强邻居）',
    strong !== null && strong.ids.length === 1 && strong.offtopic === 0,
    strong === null ? 'null' : `${strong.ids.join(',')} offtopic=${strong.offtopic}`)
  // 配额：两条「不沾词 + 强度一般」只留一条，另一条记 offtopic。
  const pair = [
    '星图邻域（1 跳，2 条）：', '',
    '1. [fact] 甲项目     强度 0.40 换个说法的弱条目', '  id: ws:0mweak01',
    '2. [fact] 乙项目     强度 0.42 又一个不沾词的', '  id: ws:0mweak02',
  ].join('\n')
  const quota = NB.neighborBlockOf(pair, { max: 4, chars: 700, query: '星图 mute 怎么用' })
  ok('N9 零重合且强度 < 0.5：只留 1 条（配额），另一条记 offtopic 而不是硬塞',
    quota !== null && quota.ids.length === 1 && quota.offtopic === 1,
    quota === null ? 'null' : `${quota.ids.join(',')} offtopic=${quota.offtopic}`)

  // 跨层去重：meow 的命中注入消息里是**长 id**，星图给 8 位，两边要按前缀认成同一条。
  const hitMsg = {
    role: 'user',
    source: { kind: 'plugin:macro-memory' },
    content: [{ type: 'text', text: '1. [dsh-macro-memory : fact] [0mwq3aa9-429d8a1f2b3c4d5e] 0.2.144 的交付态\n   摘要：…' }],
  }
  const ids = NB.injectedIdsOf([hitMsg])
  ok('N9 从 meow 命中注入里抠出 id（长形式、`[项目 : level]` 头一起认）',
    ids.has('0mwq3aa9-429d8a1f2b3c4d5e') && !NB.injectedIdsOf([{ role: 'user', source: { kind: 'user' }, content: [] }]).size,
    [...ids].join(','))
  ok('N9 普通用户消息里的方括号不算「已注入」（不然随便一句话就把邻域全关了）',
    NB.injectedIdsOf([{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '看 [0mwq3aa9] 这条' }] }]).size === 0)

  // 账本路径：会话 id 可能带冒号/斜杠，直接当文件名在 Windows 上写不进去。
  const seenPath = STORE.neighborSeenPath('probe:0643/x y')
  ok('N9 账本路径：非法字符换成下划线、落在 macroHome()/neighbor-seen/ 下',
    /neighbor-seen[\\/]probe_0643_x_y\.json$/.test(seenPath) && seenPath.includes('macro-memory'),
    seenPath)

  // 端到端：先注入一次 → 账本落盘 → 换一个注入器（模拟宿主重启）同会话不再带同一条。
  const sid = 'probe-0643-' + Math.random().toString(36).slice(2, 8)
  const file = STORE.neighborSeenPath(sid)
  const mkInj = () => {
    const rt = {
      calls: [],
      bridge: {
        tryCall: async (name, args) => {
          rt.calls.push({ name, args })
          return { text: recall }
        },
      },
    }
    const inj = NB.createNeighborInjector({
      ctx: { on: () => () => {} },
      bridge: rt.bridge,
      config: { neighborInject: true },
      logger: () => {},
      loadLlm: async () => ({ createUserMessage: ({ content, source }) => ({ content, source }) }),
    })
    return { rt, inj }
  }
  const user = { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '写入节流那个窗口后来怎么定的' }] }
  const a = mkInj()
  const outA = await a.inj.decide({ agent: { session: { id: sid } } }, { kind: 'enter', messages: [user] })
  const textA = outA.messages.length === 2 ? outA.messages[1].content[0].text : ''
  const onDisk = (() => {
    try {
      return JSON.parse(readFileSync(file, 'utf8'))
    } catch {
      return null
    }
  })()
  ok('N9 注入成功后账本立刻落盘（宿主重启不会把「带过谁」忘掉）',
    onDisk !== null && Array.isArray(onDisk.ids) && onDisk.ids.includes('0mwq3aa9') && textA.includes('0mwq3aa9'),
    onDisk === null ? '没写出文件' : `${onDisk.ids.length} 条`)

  const b = mkInj()
  const outB = await b.inj.decide({ agent: { session: { id: sid } } }, { kind: 'enter', messages: [user] })
  ok('N9 新注入器（= 重启）同会话：上轮带过的全被账本挡住 → 这一轮一个字都不注入',
    outB.messages.length === 1 && b.inj.stats().skipped === 1 && b.inj.stats().injected === 0,
    JSON.stringify(b.inj.stats()))

  // 只带过一部分的对照：账本里先塞一条，剩下两条必须照带，且 deduped 记一笔（不是全军覆没）。
  const sid2 = 'probe-0643-' + Math.random().toString(36).slice(2, 8)
  writeFileSync(STORE.neighborSeenPath(sid2), JSON.stringify({ sid: sid2, ids: ['0mwq3aa9'] }), 'utf8')
  const e = mkInj()
  const outE = await e.inj.decide({ agent: { session: { id: sid2 } } }, { kind: 'enter', messages: [user] })
  const textE = outE.messages.length === 2 ? outE.messages[1].content[0].text : ''
  ok('N9 账本只记了一部分时：记过的不带、没记过的照带，deduped 记一笔',
    textE !== '' && !textE.includes('0mwq3aa9') && textE.includes('0mwq2ncq') && e.inj.stats().deduped === 1,
    JSON.stringify(e.inj.stats()))
  rmSync(STORE.neighborSeenPath(sid2), { force: true })

  const c = mkInj()
  const outC = await c.inj.decide({ agent: { session: { id: sid } } }, { kind: 'enter', messages: [hitMsg, user] })
  const textC = outC.messages.length === 2 ? outC.messages[1].content[0].text : ''
  ok('N9 跨层去重：命中注入当轮已带的条，邻域这一轮不再带第二遍（也不写进邻域账本当新账）',
    !textC.includes('0mwq3aa9'),
    textC === '' ? '（这一轮没注入）' : textC.split('\n').slice(1, 3).join(' | '))

  // 坏账本不能挡路：写一行坏 JSON 进去，注入照常。
  writeFileSync(file, '{坏掉的 json', 'utf8')
  const d = mkInj()
  const outD = await d.inj.decide({ agent: { session: { id: sid } } }, { kind: 'enter', messages: [user] })
  ok('N9 账本坏了不挡这一轮（读不动就当空账，注入照旧）', outD.messages.length === 2, `messages=${outD.messages.length}`)
  rmSync(file, { force: true })
}

rmSync(tmpHome, { recursive: true, force: true })

console.log('')
if (fail > 0) {
  console.log(`FAILED  passed ${pass} / failed ${fail}`)
  for (const b of bad) console.log('  ✗ ' + b)
  process.exitCode = 1
} else {
  console.log(`ALL PASS  probe-neighbor：${pass}/${pass}`)
}
