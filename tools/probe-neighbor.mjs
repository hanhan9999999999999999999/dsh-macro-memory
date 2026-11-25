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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
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
  ok('N0 常量：门槛 0.35 / 尾部预留 130（0.6.61 随尾注一起瘦）/ 原有四条没被挪动',
    NB.NEIGHBOR_MIN_SCORE === 0.35 &&
      NB.NEIGHBOR_TAIL_RESERVE === 130 &&
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

// ── N4 尾部：0.6.44 起是「一步式」——直接教 mute，不再要模型先 path ──────────
{
  const blk = NB.neighborBlockOf(recall, { max: 4, chars: 420 })
  const t = blk?.text ?? ''
  const tail = t.split('\n').pop() ?? ''
  ok('N4 尾部直接教 nebula_link(action="mute")，不再绕两步去 path',
    t.includes('nebula_link(action="mute"') && !t.includes('action="path"'), tail.slice(0, 70))
  ok('N4 尾部交代 a/b 两端各填什么（a=why 里的来源 id / b=行首那 8 位）',
    t.includes('why 里那个来源 id') && t.includes('行首那 8 位'), tail.slice(0, 90))
  ok('N4 尾部仍保留读全文的办法（原有能力不许因为加指引而丢）',
    t.includes('memory_read("0mwq3aa9")') && t.includes('看全文'))
  ok('N4 尾部把判断标准写清：断的是错边，不是「这轮用不上」',
    t.includes('断的是错边') && t.includes('不用问用户') && t.includes('这轮用不上就别动'), tail.slice(-70))
  ok('N4 不给 query 时没有任何条被打标记（词面闸没开就不该有「未沾词」）',
    blk !== null && blk.flagged === 0 && !t.includes(NB.NEIGHBOR_UNRELATED_MARK), `flagged=${blk?.flagged}`)
  ok('N4 neighborSourceIdOf 能从「经由…(8 位)」抠出 a 端；直接命中档返回空串',
    NB.neighborSourceIdOf('经由「写入节流」 (0mwq3aa9) 的cooc关联扩散而来') === '0mwq3aa9' &&
      NB.neighborSourceIdOf('直接命中查询词（跨工作区/普通）') === '' &&
      NB.neighborSourceIdOf(undefined) === '')
}

// ── N4b 框架瘦身（0.6.61）：头 + 尾不许比条目还长 ────────────────────────────
{
  const blk = NB.neighborBlockOf(recall, { max: 4, chars: 420 })
  const rows = String(blk?.text ?? '').split('\n')
  const head = rows[0] ?? ''
  const tail = rows.length > 1 ? rows[rows.length - 1] : ''
  const body = rows.filter((l) => l.startsWith('- [')).join('\n')
  ok('N4b 头句压到 19 字上下，但「不是用户原话」这条归属护栏不许丢',
    head.length <= 22 && head.includes('不是用户原话'), `${head.length} 字：${head}`)
  ok('N4b 三条目时尾注 ≤ 130 字（0.6.60 是 160 字的长教学）',
    tail.length <= 130 && tail.includes('nebula_link(action="mute"'), `${tail.length} 字`)
  const single = ['1. [fact] dsh-macro-memory     强度 0.82 只有一条强邻居', '  id: ws:0mwq3aa9'].join('\n')
  const one = NB.neighborBlockOf(single, { max: 4, chars: 420 })
  const oneTail = String(one?.text ?? '').split('\n').pop() ?? ''
  ok('N4b 只有一条邻居且无可疑跳时走短尾注（≤ 95 字），命令格式一字不少',
    one !== null &&
      oneTail.length <= 95 &&
      oneTail.includes('nebula_link(action="mute"') &&
      oneTail.includes('不用问用户'),
    `${oneTail.length} 字`)
  ok('N4b 整块不再头重脚轻：头 + 尾 ≤ 条目长度 × 2（三条目这一档）',
    head.length + tail.length <= body.length * 2,
    `头 ${head.length} + 尾 ${tail.length} vs 条目 ${body.length}`)
}


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
  ok('N6 带过的（裸 id）不再带、首条换成新的第一个，尾注跟着换成新首条且仍是一步式',
    skipped !== null &&
      !skipped.ids.includes('0mwq3aa9') &&
      skipped.text.includes('memory_read("0mwq2ncq")') &&
      skipped.text.includes('nebula_link(action="mute"'),
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

// ── N10 纠错闭环：把「这条我自己也没底」标出来，并给出点得动的 mute 命令 ─────
{
  // 三条：第 1 条沾词（备份目录 / 备份），第 2、3 条强度 0.40 / 0.42 但一个词都不沾。
  // 词面闸配额只留 1 条 → 留下的那条打「未沾词」，尾注据此拼出现成的 mute 命令。
  const offRecall = [
    '1. [fact] 备份目录     强度 0.80 硬链接增量备份的落地位置',
    '  id: ws:0mhit001',
    '  为什么：经由「备份策略」 (0mhit000) 的cooc关联扩散而来',
    '2. [fact] 酸菜鱼的火候 强度 0.40 跟本轮毫无关系的厨房话题',
    '  id: ws:0moff002',
    '  为什么：经由「腌制」 (0mzzz999) 的cooc关联扩散而来',
    '3. [fact] 另一条厨房话 强度 0.42 同样不沾词',
    '  id: ws:0moff003',
    '  为什么：经由「炖汤」 (0myyy777) 的cooc关联扩散而来',
  ].join('\n')
  const q = '备份目录放哪了'
  const blk = NB.neighborBlockOf(offRecall, { max: 4, chars: 900, query: q })
  const t = blk?.text ?? ''
  ok('N10 零重合的两条只留 1 条（配额），另一条记在 offtopic 里',
    blk !== null && blk.ids.includes('0moff002') && !blk.ids.includes('0moff003') && blk.offtopic === 1,
    blk === null ? 'null' : `${blk.ids.join(',')} / offtopic=${blk.offtopic}`)
  ok('N10 靠配额留下的那条行尾打「未沾词」，flagged 记一笔（模型才知道这条自己没底）',
    blk !== null && blk.flagged === 1 && t.includes(`- [fact] [0moff002]`) && t.includes(NB.NEIGHBOR_UNRELATED_MARK),
    `flagged=${blk?.flagged}`)
  ok('N10 尾注给出**现成**的 mute 命令：a=它的来源 id、b=它自己的 8 位 id',
    t.includes('nebula_link(action="mute", a="0mzzz999", b="0moff002")'), t.split('\n').pop()?.slice(0, 120))
  ok('N10 沾词的那条不打标记（没被标 = 不是这次要复核的对象）',
    t.includes('- [fact] [0mhit001]') && !/\[0mhit001\][^\n]*未沾词/.test(t))
  // 反向对照：不沾词的那条强度够高（≥0.5）时免检照带、也不打标记 —— 词面零重合 ≠ 无关。
  // （同批里另一条 0.42 仍然零重合，会顶掉配额位置，所以只盯 0moff002 这一条。）
  const strongOff = offRecall.replace('强度 0.40', '强度 0.90')
  const blk2 = NB.neighborBlockOf(strongOff, { max: 4, chars: 900, query: q })
  ok('N10 强度 ≥0.5 的零重合条目免检照带、不打标记（别把换说法当噪声）',
    blk2 !== null && blk2.ids.includes('0moff002') && !/\[0moff002\][^\n]*未沾词/.test(blk2.text),
    `flagged=${blk2?.flagged} ids=${blk2?.ids.join(',')}`)
}

// ── N11 账本治理：只进不出的缓存会长成垃圾场（0.6.44）─────────────────────────
{
  const ST = await import(pathToFileURL(join(root, 'lib', 'macro', 'store.js')).href)
  const seenDir = join(tmpHome, 'macro-memory', 'neighbor-seen')
  rmSync(seenDir, { recursive: true, force: true })

  ok('N11 上限常量在位（单个账本 400 条）', ST.NEIGHBOR_SEEN_MAX_IDS === 400, String(ST.NEIGHBOR_SEEN_MAX_IDS))

  // 目录还不存在时清理是空操作、不抛（新装用户第一次 decide 就会走这里）
  const r0 = ST.pruneNeighborSeen()
  ok('N11 目录还不存在时清理是空操作（新装用户不挨一份错误日志）',
    r0.scanned === 0 && r0.removedByAge === 0 && r0.removedByCount === 0 && r0.error === '',
    JSON.stringify(r0))

  mkdirSync(seenDir, { recursive: true })
  const now = Date.UTC(2026, 10, 25, 4, 0)
  const mk = (name, daysAgo) => {
    const f = join(seenDir, name)
    writeFileSync(f, JSON.stringify({ sid: name, ids: [] }), 'utf8')
    const t = (now - daysAgo * 86400000) / 1000
    utimesSync(f, t, t)
    return f
  }
  const old1 = mk('old-a.json', 45)
  const old2 = mk('old-b.json', 40)
  for (let i = 0; i < 8; i++) mk(`fresh-${i}.json`, i * 0.1)
  writeFileSync(join(seenDir, 'not-a-ledger.txt'), 'leave me', 'utf8')

  const r1 = ST.pruneNeighborSeen({ maxAgeDays: 30, maxFiles: 0, now })
  ok('N11 按天数删：40 天前的两个删掉、最近的不动、非 .json 文件一个都不碰',
    r1.removedByAge === 2 && !existsSync(old1) && !existsSync(old2) && existsSync(join(seenDir, 'fresh-0.json')) &&
      existsSync(join(seenDir, 'not-a-ledger.txt')),
    JSON.stringify(r1))

  const r2 = ST.pruneNeighborSeen({ maxAgeDays: 0, maxFiles: 3, now })
  const left = readdirSync(seenDir).filter((n) => n.endsWith('.json'))
  ok('N11 按文件数删：只留最近 3 个（maxAgeDays 0 表示不按天算）',
    r2.removedByCount === 5 && left.length === 3 && left.includes('fresh-0.json') && left.includes('fresh-1.json') && left.includes('fresh-2.json'),
    `${r2.removedByCount} / 剩 ${left.sort().join(',')}`)

  // 写盘裁剪：账本里超过上限时只留最近的（源码断言——这条路径要造 400 条邻居太重，
  // 而它唯一的失败方式是「忘了裁」，看代码就能断定）。
  const neighborSrc = readFileSync(join(root, 'lib', 'macro', 'neighbor.js'), 'utf8')
  ok('N11 写盘时按上限裁剪（只留最近 400 条，不是把整个 Set 倒出去）',
    neighborSrc.includes('set.size > NEIGHBOR_SEEN_MAX_IDS') &&
      neighborSrc.includes('slice(set.size - NEIGHBOR_SEEN_MAX_IDS)'))
  ok('N11 清理只在进程内第一次 decide 时跑一次（不是每轮都列目录）',
    /if \(!pruned\) \{\s*pruned = true\s*const r = pruneNeighborSeen\(\)/.test(neighborSrc))
}

// ── N12 邻域注入落账：花掉的字要在面板上看得见（0.6.50）──────────────────────
// 病根：0.6.46 给命中注入做了面板，邻域这一层却一行账都不写——同一份上下文里花掉的字，
// 一半来自邻域，面板上却是 0。这一块守四件事：有真会话才写、每个出口都有 reason、
// 成功那行记的是「真正进了上下文的那一块」、面板能把两段分开念。
{
  const IL = await import(pathToFileURL(join(root, 'lib', 'macro', 'injectledger.js')).href)
  const ws = join(tmpHome, 'ws-n12')
  const LOG = join(ws, '.dsh-meow', 'dream-debug.log')
  const RECALL = [
    '星图邻域（1 跳，2 条）：',
    '',
    '1. [fact] dsh-macro-memory     强度 0.82 0.2.144 的交付态',
    '  id: ws:0mwq3aa9',
    '  为什么：经由「写入节流」的cooc关联扩散而来',
    '  摘要：交付态摘要',
    '2. [fact] 别的项目     强度 0.08 噪声一条',
    '  id: 0myyy888',
    '  id: 0myyy888',
  ].join('\n')
  const mkInj = (opts) => NB.createNeighborInjector({
    ctx: { on: () => () => {} },
    bridge: { tryCall: async () => ({ text: RECALL }) },
    config: opts.config ?? {},
    meowDir: () => '.dsh-meow',
    logger: () => {},
    loadLlm: opts.loadLlm ?? (async () => ({ createUserMessage: (o) => o })),
    ...(opts.bridge ? { bridge: opts.bridge } : {}),
  })
  const user = { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '写入节流那个窗口后来怎么定的' }] }
  const shortUser = { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '嗯' }] }
  const enter = (sid, msgs = [user]) => ({ kind: 'enter', messages: msgs })
  const payload = (sid, withCwd) => ({ agent: { session: { id: sid, header: withCwd ? { cwd: ws } : {} } } })
  const logText = () => (existsSync(LOG) ? readFileSync(LOG, 'utf8') : '')
  const lastLine = () => logText().trim().split('\n').slice(-1)[0] ?? ''

  // ① 没有 workspace（探针 / 单测 / 没开会话）就一个字节都不写：账本不能落到别人的库里
  const inj0 = mkInj({})
  await inj0.decide(payload('n12-nows', false), enter('n12-nows'))
  ok('N12 没有 workspace 时不写账（探针跑完磁盘上一个字节都不多）',
    !existsSync(LOG), logText().length + ' B')

  // ② 成功一轮：记的是「真正进了上下文的那一块」+ 三道闸各自的读数
  const inj = mkInj({})
  await inj.decide(payload('n12-a', true), enter('n12-a'))
  const chain = lastLine()
  ok('N12 注入成功写 neighbor-chain：条数 / 字数 / 闸位读数都在（与引擎同一行格式）',
    /\] neighbor-chain pid=\d+ sid=n12-a ids=1 chars=\d+ weak=\d+ offtopic=\d+ flagged=\d+ deduped=\d+ max=4 cap=420 minScore=0\.35 turnCap=0 turnSpent=0 solo=[01]$/.test(chain),
    chain)

  // ③ 同一个会话再问：已经带过的条目由跨层按 id 挡掉，写 reason=empty
  await inj.decide(payload('n12-a', true), enter('n12-a'))
  ok('N12 这一轮没有可带的邻居时写 neighbor-skip reason=empty（不是静默返回）',
    /\] neighbor-skip pid=\d+ reason=empty sid=n12-a$/.test(lastLine()), lastLine())

  // ④ 短问不猜，也要留一笔
  await inj.decide(payload('n12-b', true), enter('n12-b', [shortUser]))
  ok('N12 问句太短写 reason=short（窗口里看得见「为什么这几轮邻域是空的」）',
    /\] neighbor-skip pid=\d+ reason=short$/.test(lastLine()), lastLine())

  // ⑤ 两条失败路径各有各的 reason，不许都糊成一个 failed
  const boom = mkInj({ bridge: { tryCall: async () => { throw new Error('nebula down') } } })
  await boom.decide(payload('n12-c', true), enter('n12-c'))
  const toolLine = lastLine()
  const noLlm = mkInj({ loadLlm: async () => ({}) })
  await noLlm.decide(payload('n12-d', true), enter('n12-d'))
  const llmLine = lastLine()
  ok('N12 工具失败与消息工厂取不到分开记（reason=tool / reason=llm）',
    /reason=tool sid=n12-c$/.test(toolLine) && /reason=llm sid=n12-d$/.test(llmLine), toolLine + ' | ' + llmLine)

  // ⑥ 配置面也记进账：改了 neighborMax / neighborChars，账行要跟着变
  const tight = mkInj({ config: { neighborMax: 2, neighborChars: 300 } })
  await tight.decide(payload('n12-e', true), enter('n12-e'))
  ok('N12 账行带上这一轮生效的 max / cap（调小之后账上还能对回来）',
    /max=2 cap=300/.test(lastLine()), lastLine())

  // ⑦ 面板念得出这一半：邻域段 + 出口名 + 明细，与命中那段分开算
  const body = IL.readInjectPanel({ workspace: ws, dir: '.dsh-meow', limit: 20, config: {} }).body
  ok('N12 memory_admin(inject) 念得出邻域这一段（轮数 / 字数 / 没带的原因 / 明细）',
    /邻域注入：\d+ 轮里/.test(body) && /没带的原因：/.test(body) && /问句太短/.test(body) &&
      /邻域 \d+ 条 · \d+ 字/.test(body) && /星图没查成/.test(body),
    (body.match(/邻域注入：[^\n]*/) ?? [''])[0])
}
// ── N13 错边账：连标三轮先不带、AI 断掉当场销账、不理就放回（0.6.54）──────────
// 病根：模型在注入块尾部拿到了 mute 指引，但「标了未沾词」这件事本身不留痕——同一跳可以
// 连着二十轮被标、每轮都占一份上下文，而图上什么都没有；用户不主动 mute 就永远这样。
// 这一块守四件事：连标够轮数才压住（一次误标不算）、压住时图不动而账留着、
// 真 mute 之后当场销账（下一轮立刻放回）、三轮没再被标自动放回（不搞永久降级）。
{
  const R = [
    '星图邻域（1 跳，1 条）：',
    '',
    '1. [fact] 另一条线     强度 0.42 完全不相干的一条',
    '  id: ws:0msus001',
    '  为什么：经由「另一条线」(0msus001)的cooc关联扩散而来',
    '  摘要：说的是别的行业的排期口径',
  ].join('\n')
  const ws2 = join(tmpHome, 'ws-n13')
  const LOG2 = join(ws2, '.dsh-meow', 'dream-debug.log')
  const mk = (opts = {}) => NB.createNeighborInjector({
    ctx: { on: () => () => {} },
    bridge: { tryCall: async () => ({ text: R }) },
    config: opts.config ?? {},
    meowDir: () => '.dsh-meow',
    logger: () => {},
    loadLlm: async () => ({ createUserMessage: (o) => o }),
  })
  // 问句与那一条一个字面都不沾（不然不会被打「未沾词」标记）。
  const ask = { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '今天这个天气真好啊' }] }
  const pl = (sid) => ({ agent: { session: { id: sid, header: { cwd: ws2 } } } })
  const enter2 = (sid) => ({ kind: 'enter', messages: [ask] })
  const text2 = () => (existsSync(LOG2) ? readFileSync(LOG2, 'utf8') : '')
  const last2 = () => text2().trim().split('\n').slice(-1)[0] ?? ''

  const inj2 = mk()
  await inj2.decide(pl("n13-1"), enter2("n13-1"))
  const one = NB.readSuspectLedger(ws2)
  ok('N13 第一轮被标未沾词：错边账落下一条 n=1（图没动，只是记了一笔）',
    one.edges['0msus001|0msus001']?.n === 1, JSON.stringify(one.edges))
  await inj2.decide(pl("n13-2"), enter2("n13-2"))
  await inj2.decide(pl("n13-3"), enter2("n13-3"))
  const three = NB.readSuspectLedger(ws2)
  ok('N13 连标三轮：n 攒到 3、轮次号跟着工作区走（不是按会话）',
    three.edges['0msus001|0msus001']?.n === 3 && three.round === 3, JSON.stringify(three))

  // 第四轮：连标够轮数了 → 这一跳先不带；这一轮没有别的邻居，于是整轮空着但留一笔账
  await inj2.decide(pl("n13-4"), enter2("n13-4"))
  const supLine = last2()
  ok('N13 连标够轮数后这一轮不带它，出口写 reason=suspect（不是 empty，别让它看起来像图上没东西）',
    /\] neighbor-skip pid=\d+ reason=suspect sid=n13-4 withheld=1 turns=3 ids=0msus001$/.test(supLine), supLine)

  // 销账：走**真的** memory_link(mute) 那条路（不是直接调 clearSuspectEdge）——
  // 闭环要验证的是「模型照着尾注动手之后，账当场就没了、还留了一行痕」，
  // 只测内部函数会把「工具没接上」这种真故障漏过去。
  const LINK = await import(pathToFileURL(join(root, 'lib', 'macro', 'defs', 'link.js')).href)
  const execN13 = { agent: { session: { header: { cwd: ws2 } } } }
  const linkTool = LINK.createLink({
    flow: {
      resolveIdDetail: async (id) => ({ kind: 'ok', id }),
      tryCall: async () => ({ entry: true, text: '已屏蔽这一跳（重建也不会再连）' }),
      flushLinks: async () => {},
    },
    meowDir: () => '.dsh-meow',
  })
  await linkTool.execute({ action: 'mute', a: '0msus001', b: '0msus001' }, execN13)
  ok('N13 真走 memory_link(mute)：错边账当场清掉（不留到过期）',
    Object.keys(NB.readSuspectLedger(ws2).edges).length === 0,
    JSON.stringify(NB.readSuspectLedger(ws2).edges))
  ok('N13 mute 顺手写一行 neighbor-fix（面板才念得出「AI 已断一跳」）',
    /\] neighbor-fix pid=\d+ a=0msus001 b=0msus001 via=mute cleared=1$/.test(text2().trim().split('\n').slice(-1)[0] ?? ''),
    text2().trim().split('\n').slice(-1)[0] ?? '')
  ok('N13 再销一次是 0（幂等：重复 mute 不该报错也不该再写账）', NB.clearSuspectEdge(ws2, '0msus001', '0msus001') === 0)
  ok("N13 销账后账上真的空了（不是留一条 n=0 的骨灰）", Object.keys(NB.readSuspectLedger(ws2).edges).length === 0)
  await inj2.decide(pl("n13-5"), enter2("n13-5"))
  ok('N13 断掉之后立刻恢复：下一轮正常带（不用等重启、不用等轮次）',
    /\] neighbor-chain pid=\d+ sid=n13-5 /.test(last2()), last2())

  // 面板读得出：压住那几跳要能解释「为什么这几轮是空的」，断过的要留痕
  const IL2 = await import(pathToFileURL(join(root, "lib", "macro", "injectledger.js")).href)
  const body2 = IL2.readInjectPanel({ workspace: ws2, dir: '.dsh-meow', limit: 20, config: {} }).body
  ok('N13 面板把错边这一支单独念出来（暂时不带几跳 / AI 已断几跳）',
    /- 错边：暂时不带 \d+ 跳/.test(body2), (body2.match(/- 错边：[^\n]*/) ?? [""])[0])
  ok('N13 明细里「断开一跳」有 a ↔ b 与销账条数（点得回是哪一跳）',
    /断开一跳：0msus001 ↔ 0msus001（mute，销账 1 条）/.test(body2), (body2.match(/- [^\n]*断开一跳[^\n]*/) ?? [''])[0])

  // 0＝整层关：逐位退回 0.6.53 的行为（连标一百轮也照带）
  const ws3 = join(tmpHome, "ws-n13-off")
  const mk3 = () => NB.createNeighborInjector({
    ctx: { on: () => () => {} },
    bridge: { tryCall: async () => ({ text: R }) },
    config: { neighborSuspectTurns: 0 },
    meowDir: () => ".dsh-meow",
    logger: () => {},
    loadLlm: async () => ({ createUserMessage: (o) => o }),
  })
  const inj3 = mk3()
  const pl3 = (sid) => ({ agent: { session: { id: sid, header: { cwd: ws3 } } } })
  for (const sid of ["n13o-1", "n13o-2", "n13o-3", "n13o-4"]) await inj3.decide(pl3(sid), enter2(sid))
  const LOG3 = join(ws3, ".dsh-meow", "dream-debug.log")
  const t3 = existsSync(LOG3) ? readFileSync(LOG3, "utf8") : ""
  ok('N13 neighborSuspectTurns: 0 时整层关（第四轮照带，且一行错边账都不写）',
    /sid=n13o-4 /.test(t3) && !/neighbor-suspect|reason=suspect/.test(t3) &&
      Object.keys(NB.readSuspectLedger(ws3).edges).length === 0, String(t3.length))
}

// ── N14 一轮总上限：命中先花、邻域只花剩下的（0.6.55）──────────────────────────
// 病根：三个上限各管一段（命中 injectMaxChars / 邻域 neighborChars / 会话累计），
// 用户想「每轮最多 600 字」时没有任何一个数对得上；邻域每轮还要另花 200~400 字，
// 于是「每轮几乎都注入」变成了两份账单。这一块守五件事：
// 上限关着时逐位照旧、开了之后邻域只拿余额、余额不够就整块不带（不塞半块）、
// 「这一轮已花」只算本轮（上一轮的注入不算）、面板念得出这笔账。
{
  const R2 = [
    '星图邻域（1 跳，2 条）：',
    '',
    '1. [fact] dsh-macro-memory     强度 0.82 0.2.144 的交付态',
    '  id: ws:0mcap001',
    '  为什么：经由「写入节流」的cooc关联扩散而来',
    '  摘要：交付态摘要',
    '2. [fact] 别的项目     强度 0.70 交付节奏',
    '  id: 0mcap002',
    '  为什么：经由「写入节流」的cooc关联扩散而来',
    '  摘要：另一条摘要',
  ].join('\n')
  const ws4 = join(tmpHome, 'ws-n14')
  const LOG4 = join(ws4, '.dsh-meow', 'dream-debug.log')
  const mk4 = (cfg) => NB.createNeighborInjector({
    ctx: { on: () => () => {} },
    bridge: { tryCall: async () => ({ text: R2 }) },
    config: cfg,
    meowDir: () => '.dsh-meow',
    logger: () => {},
    loadLlm: async () => ({ createUserMessage: (o) => o }),
  })
  const user4 = { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '写入节流那个窗口后来怎么定的' }] }
  // 上一层（meow 命中 / 重放）已经注入的那一块：只认 source.kind，不认内容。
  const carriedMsg = (n) => ({ role: 'user', source: { kind: 'plugin:macro-memory' }, content: [{ type: 'text', text: 'x'.repeat(n) }] })
  const pl4 = (sid) => ({ agent: { session: { id: sid, header: { cwd: ws4 } } } })
  const text4 = () => (existsSync(LOG4) ? readFileSync(LOG4, 'utf8') : '')
  const last4 = () => text4().trim().split('\n').slice(-1)[0] ?? ''

  // ① 上限关着（默认 0）：一个字都不变，账行写 turnCap=0 —— 与 0.6.54 逐位相同
  const off = mk4({})
  await off.decide(pl4('n14-off'), { kind: 'enter', messages: [user4, carriedMsg(5000)] })
  ok('N14 上限默认 0（不限）：照旧注入，账行写 turnCap=0 turnSpent=0（老行为一位不变）',
    /] neighbor-chain pid=\d+ sid=n14-off .*turnCap=0 turnSpent=0 solo=[01]$/.test(last4()), last4())

  // ② 上限很宽：邻域照旧吃满自己的 neighborChars，不被总上限无故削
  const wide = mk4({ injectTurnMaxChars: 900 })
  await wide.decide(pl4('n14-wide'), { kind: 'enter', messages: [user4] })
  ok('N14 上限比单层预算还宽：邻域照旧吃满 cap=420（不因为开了总上限就变小）',
    /chars=\d+ .*cap=420 minScore=0\.35 turnCap=900 turnSpent=0 solo=[01]$/.test(last4()), last4())

  // ③ 上限收紧：邻域只能花余额（600 - 350 = 250），块本身跟着缩
  const tight = mk4({ injectTurnMaxChars: 600 })
  await tight.decide(pl4('n14-tight'), { kind: 'enter', messages: [user4, carriedMsg(350)] })
  const tightLine = last4()
  const tightChars = Number((tightLine.match(/chars=(\d+)/) ?? [])[1] ?? -1)
  ok('N14 命中已花 350 时，邻域这一块只拿剩下的 250（块字数真的缩了，不是只在账上写）',
    tightChars > 0 && tightChars <= 250 && /turnCap=600 turnSpent=350 solo=[01]$/.test(tightLine), tightLine)

  // ④ 余额不够开一块：整块不带，写 reason=turncap，decision 原样返回
  const over = mk4({ injectTurnMaxChars: 400 })
  const res = await over.decide(pl4('n14-over'), { kind: 'enter', messages: [user4, carriedMsg(400)] })
  ok('N14 余额不足（400-400）：这一轮一条邻居都不带，出口写 reason=turncap 并带上账',
    /\] neighbor-skip pid=\d+ reason=turncap sid=n14-over turnSpent=400 turnCap=400 left=0$/.test(last4()), last4())
  ok('N14 被上限挡住时 decision 原样返回（消息一条没多，绝不塞半块进去）',
    Array.isArray(res?.messages) && res.messages.length === 2 && over.stats().capped === 1,
    String(res?.messages?.length) + ' / capped=' + String(over.stats().capped))

  // ⑤ 「这一轮已花」只算本轮：用户消息之前的注入（上一轮）不进账
  ok('N14 已花字数只数最后一条用户消息之后的注入（上一轮的不算，否则第二轮就永远顶满）',
    NB.injectedCharsOf([carriedMsg(100), user4, carriedMsg(30)]) === 30 &&
      NB.injectedCharsOf([user4]) === 0,
    String(NB.injectedCharsOf([carriedMsg(100), user4, carriedMsg(30)])))

  // ⑥ 面板念得出这笔账（最近一轮设了上限的是 ③：命中 350 + 邻域 tightChars）
  const IL3 = await import(pathToFileURL(join(root, 'lib', 'macro', 'injectledger.js')).href)
  const body3 = IL3.readInjectPanel({ workspace: ws4, dir: '.dsh-meow', limit: 30, config: {} }).body
  ok('N14 面板念得出「一轮总上限 N 字：命中 X + 邻域 Y = Z（还剩 R）」',
    /- 一轮总上限 600 字：最近一轮 命中 350 \+ 邻域 \d+ = \d+（还剩 \d+ 字）/.test(body3),
    (body3.match(/- 一轮总上限[^\n]*/) ?? [''])[0])
  ok('N14 撞上限的轮在「没带的原因」里念得出来（不是一句 None）',
    /撞一轮总上限（本轮剩余不够开一块） 1 轮/.test(body3),
    (body3.match(/- 没带的原因[^\n]*/) ?? [''])[0])
}

// ── N15 边缘单条隔轮带：一块只活下来一条、强度又低，就带一轮歇一轮（0.6.62）──────
// 病根（bench37 量出来的）：17 条操作型话术里 11 条只活下来 1 条邻居，强度 0.36–0.54、
// weak=7（recall 给 8 条、7 条被刷）。这种块 193 字，每轮都带，而那条邻居大半轮用不上。
// 这一块守四件事：边缘单条第一轮照带（不砍线索）、下一轮让路并把原因写出来、
// 再下轮照带（隔轮不是关掉）、线以上或一块两条时不降频。
// 注意：邻居 id 按前 8 位认同一跳（sameId），下面每条边的前 8 位都刻意不同，否则会先被
// 「已经带过」挡掉、测不到降频闸。
{
  const ws6 = join(tmpHome, 'ws-n15')
  const LOG6 = join(ws6, '.dsh-meow', 'dream-debug.log')
  /** 造一份「1 跳」回执：id 与强度可换，模拟每轮问到的是别的邻居。 */
  const one = (id, score) => [
    '星图邻域（1 跳，1 条）：',
    '',
    `1. [fact] 一条边缘线     强度 ${score} 沾一点边`,
    `  id: ws:${id}`,
    `  为什么：经由「另一条线」(${id})的cooc关联扩散而来`,
    '  摘要：说的是别的事的排期',
  ].join('\n')
  /** 造一份「2 条」回执。 */
  const two = (a, b, sa, sb) => [
    '星图邻域（1 跳，2 条）：',
    '',
    `1. [fact] 一条边缘线     强度 ${sa} 沾一点边`,
    `  id: ws:${a}`,
    `  为什么：经由「另一条线」(${a})的cooc关联扩散而来`,
    '  摘要：说的是别的事的排期',
    `2. [fact] 另一条     强度 ${sb} 也一般`,
    `  id: ws:${b}`,
    `  为什么：经由「另一条线」(${b})的cooc关联扩散而来`,
    '  摘要：另一条摘要',
  ].join('\n')

  // recall 可变：换轮要换新 id，否则先被「已经带过」的 id 账挡掉，测不到降频闸。
  const mk6 = (box, opts = {}) => NB.createNeighborInjector({
    ctx: { on: () => () => {} },
    bridge: { tryCall: async () => ({ text: box.text }) },
    config: opts.config ?? {},
    meowDir: () => '.dsh-meow',
    logger: () => {},
    loadLlm: async () => ({ createUserMessage: (o) => o }),
  })
  const user6 = { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '那条边缘线后来怎么算的' }] }
  const pl6 = (sid) => ({ agent: { session: { id: sid, header: { cwd: ws6 } } } })
  const enter6 = (sid) => ({ kind: 'enter', messages: [user6] })
  const text6 = () => (existsSync(LOG6) ? readFileSync(LOG6, 'utf8') : '')
  const last6 = () => text6().trim().split('\n').slice(-1)[0] ?? ''

  // ① 第一轮：照带，账行标 solo=1（这一块是边缘单条，下一轮让路）
  const box1 = { text: one('0ma1edge1', '0.38') }
  const s1 = mk6(box1)
  const r1 = await s1.decide(pl6('n15-a'), enter6('n15-a'))
  const l1 = last6()
  ok('N15 边缘单条第一轮照带（不砍线索），账行标 solo=1',
    Array.isArray(r1?.messages) && r1.messages.length === 2 && /ids=1/.test(l1) && /solo=1$/.test(l1), l1)

  // ② 第二轮：又只活下来一条新的边缘邻居 → 让路，出口写 reason=edgeturn（带分数与块字数）
  box1.text = one('0mb2edge2', '0.38')
  const r2 = await s1.decide(pl6('n15-a'), enter6('n15-a'))
  const l2 = last6()
  ok('N15 下一轮让路：写 neighbor-skip reason=edgeturn（带分数与块字数，窗口里看得见为什么空）',
    /\] neighbor-skip pid=\d+ reason=edgeturn sid=n15-a score=0\.38 chars=\d+$/.test(l2), l2)
  ok('N15 让路时 decision 原样返回（一条消息都不多，绝不塞半块）',
    Array.isArray(r2?.messages) && r2.messages.length === 1, String(r2?.messages?.length))
  ok('N15 让路记进 state.edged（自证数得出来，不是只有日志）',
    s1.stats().edged === 1 && s1.stats().injected === 1,
    `edged=${s1.stats().edged} injected=${s1.stats().injected}`)

  // ③ 第三轮：隔轮不是关掉 —— 再来一条边缘单条照带（让过的那一轮不记账）
  box1.text = one('0mc3edge3', '0.38')
  const r3 = await s1.decide(pl6('n15-a'), enter6('n15-a'))
  ok('N15 隔轮只歇一轮：再下一轮照带（同一会话里 带→歇→带）',
    Array.isArray(r3?.messages) && r3.messages.length === 2 && /ids=1/.test(last6()) && /solo=1$/.test(last6()), last6())

  // ④ 线以上不降频：0.68 那种单条是真线索（`suspect 账几天清一次`），每轮都带
  const box4 = { text: one('0ma4str01', '0.68') }
  const s4 = mk6(box4)
  await s4.decide(pl6('n15-b'), enter6('n15-b'))
  const l4a = last6()
  box4.text = one('0mb5str02', '0.68')
  await s4.decide(pl6('n15-b'), enter6('n15-b'))
  const l4b = last6()
  ok('N15 强度在线以上的单条不降频（0.68 每轮照带，账行 solo=0）',
    /ids=1/.test(l4a) && /solo=0$/.test(l4a) && /ids=1/.test(l4b) && !/reason=edgeturn/.test(l4b), l4a + ' | ' + l4b)

  // ⑤ 一块带两条时不降频：多条说明这条线有结构。
  //    （两条都弱的情况本来就会被词面闸压成一条——NEIGHBOR_OFFTOPIC_KEEP=1，所以这里用两条过线的。）
  const box5 = { text: two('0ma6pair1', '0mb7pair2', '0.62', '0.68') }
  const s5 = mk6(box5)
  await s5.decide(pl6('n15-c'), enter6('n15-c'))
  const l5a = last6()
  box5.text = two('0mc8pair3', '0md9pair4', '0.62', '0.68')
  await s5.decide(pl6('n15-c'), enter6('n15-c'))
  const l5b = last6()
  ok('N15 一块带两条时不降频（账行 ids=2 solo=0，下一轮照带）',
    /ids=2/.test(l5a) && /solo=0$/.test(l5a) && /ids=2/.test(l5b) && !/reason=edgeturn/.test(l5b), l5a + ' | ' + l5b)

  // ⑥ 旋钮 0 = 关：边缘单条退回每轮都带（老行为一位不变）
  const box6 = { text: one('0ma1off11', '0.38') }
  const s6 = mk6(box6, { config: { neighborSoloEdge: 0 } })
  await s6.decide(pl6('n15-d'), enter6('n15-d'))
  const l6a = last6()
  box6.text = one('0mb2off22', '0.38')
  await s6.decide(pl6('n15-d'), enter6('n15-d'))
  const l6b = last6()
  ok('N15 neighborSoloEdge: 0 时整层关（边缘单条照旧每轮带，一行 edgeturn 都不写）',
    /ids=1/.test(l6a) && /solo=0$/.test(l6a) && /ids=1/.test(l6b) && !/reason=edgeturn/.test(l6b), l6a + ' | ' + l6b)

  // ⑦ 面板把出口念成人话（不是把 edgeturn 原样吐给主人）
  const IL6 = await import(pathToFileURL(join(root, 'lib', 'macro', 'injectledger.js')).href)
  const body6 = IL6.readInjectPanel({ workspace: ws6, dir: '.dsh-meow', limit: 40, config: {} }).body
  ok('N15 面板把 edgeturn 念成人话（边缘单条歇一轮 · 下轮照带）',
    /边缘单条歇一轮（下轮照带）/.test(body6),
    (body6.match(/- 没带的原因[^\n]*/) ?? [''])[0])

  // ⑧ 源码断言：scores 与 ids 同序（降频闸读「这一块第一条的强度」，错位就误判）
  const src6 = readFileSync(join(root, 'lib', 'macro', 'neighbor.js'), 'utf8')
  const idsAt = src6.indexOf('ids.push(bare)')
  const scAt = src6.indexOf('scores.push(Number.isFinite(node.score) ? node.score : 0)')
  ok('N15 scores 与 ids 同序（在同一处配对 push，读数一一对应）',
    idsAt > 0 && scAt > idsAt && scAt - idsAt < 400, `ids@${idsAt} scores@${scAt}`)
}

// ── N16 [0.6.64] 行首 id 的显示形式：交给上层给（最短唯一前缀），缺省仍是 8 位 ──────
{
  const long = (id) => `${id}LONG`
  const blk = NB.neighborBlockOf(recall, { max: 4, chars: 3000, shorten: long })
  ok('N16 行首 id 用上层给的形式（撞车的 8 位前缀必须能加长）',
    blk !== null && blk.text.includes('[0mwq3aa9LONG]') && !blk.text.includes('[0mwq3aa9] '),
    blk === null ? 'null' : blk.text.split('\n')[1].slice(0, 40))
  ok('N16 尾注里 memory_read / mute 的 id 一起换（命令照抄就能用，不留半截）',
    blk !== null && blk.text.includes('memory_read("0mwq3aa9LONG")') && !/memory_read\("0mwq3aa9"\)/.test(blk.text))
  const plain = NB.neighborBlockOf(recall, { max: 4, chars: 420 })
  ok('N16 不传 shorten 时还是 8 位切法（老调用方与老回执不受影响）',
    plain !== null && plain.text.includes('[0mwq3aa9]'))
}


// ── N17 [0.6.65] 一次摘一批：压住好几跳时给一条批量命令，错边账能自己翻出来 ──────
// 病根：0.6.61 的尾注只给**第一跳**的现成命令，账上攒下的第 2～N 跳谁也没提；
// 模型想清干净得自己拼 id，实际就是不清——错边留在图上继续每轮占上下文。
// 这一块守四件事：压住 ≥2 跳时尾注一次给全（≤3 对，剩下的指路）、
// memory_link(pairs=…) 逐对做且逐对报成败（一成一半也照样把成的那些摘掉）、
// 断掉的那几跳当场销账（不留到过期）、错边账有面板可翻（不是只能从注入块里猜）。
{
  // 一条邻居的召回文本形状（与 nebula_recall 一致：编号行 / id / why 带来源 id）。
  // id 一律 8 位：回执里的 id 本来就是最短唯一前缀（0.6.64 起），超过 8 位会被切，夹具跟着这个口径。
  const node = (n, label, id, src, score) => [
    `${n}. [fact] ${label}     强度 ${score} ${label}的描述`,
    `  id: ws:${id}`,
    `  为什么：经由「${label}」 (${src}) 的cooc关联扩散而来`,
  ]
  const text = [
    '星图邻域（1 跳，5 条）：',
    '',
    ...node(1, '写入节流', '0mwit001', '0mwit000', '0.82'),
    ...[1, 2, 3, 4].map((i) => node(i + 1, '别的线' + i, '0msup00' + i, '0msrc00' + i, '0.40')).flat(),
  ].join('\n')
  const blk = NB.neighborBlockOf(text, {
    max: 6,
    chars: 3000,
    query: '写入节流那个窗口后来怎么定的',
    suspect: new Set(['0msup001', '0msup002', '0msup003', '0msup004']),
    suspectTurns: 3,
  })
  const bt = blk?.text ?? ''
  ok('N17 压住 4 跳时尾注一次给 3 对现成命令（不再只提第一跳）',
    blk !== null && blk.suspect === 4 && bt.includes('另有 4 跳连续 3 轮标了「未沾词」') &&
      bt.includes('pairs=[["0msrc001","0msup001"],["0msrc002","0msup002"],["0msrc003","0msup003"]]'),
    (bt.match(/另有[^\n]*/) ?? [''])[0].slice(0, 200))
  ok('N17 剩下那 1 跳指路到面板（不是静默丢掉，也不是硬塞第 4 对）',
    bt.includes('（还有 1 跳用 memory_admin(action="suspect") 看）') && !bt.includes('0msup004'))
  ok('N17 批量尾注没把 read 命令挤掉（条目 + 命令都还在）',
    blk !== null && blk.ids.length === 1 && bt.includes('memory_read("0mwit001")'),
    bt.split('\n').slice(0, 3).join(' / '))

  // 面板：空账 / 拿不到工作区 / 有压着，三种都要说人话
  const empty = NB.readSuspectPanel({ workspace: join(tmpHome, 'ws-n17-empty') })
  ok('N17 空账念「错边账是空的」并解释什么才算（不是一句 None）',
    /错边账是空的/.test(empty.body) && /账上 0 跳/.test(empty.scope), empty.scope)
  const noWs = NB.readSuspectPanel({ workspace: '' })
  ok('N17 拿不到工作区时明说「不是账空」（别让人以为错边账没了）',
    /拿不到工作区/.test(noWs.body), noWs.body.slice(0, 40))

  // 账上攒两跳（各连标 3 轮）→ 面板把两跳都摆出来，并给一条两对的命令
  const ws7 = join(tmpHome, 'ws-n17')
  const LOG7 = join(ws7, '.dsh-meow', 'dream-debug.log')
  const only = (label, id, src, score) => ['星图邻域（1 跳，1 条）：', '', ...node(1, label, id, src, score)].join('\n')
  let body7 = only('另一条线甲', '0msusa01', '0msusa01', '0.42')
  const inj7 = NB.createNeighborInjector({
    ctx: { on: () => () => {} },
    bridge: { tryCall: async () => ({ text: body7 }) },
    config: {},
    meowDir: () => '.dsh-meow',
    logger: () => {},
    loadLlm: async () => ({ createUserMessage: (o) => o }),
  })
  const ask7 = { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '今天这个天气真好啊' }] }
  const pl7 = (sid) => ({ agent: { session: { id: sid, header: { cwd: ws7 } } } })
  for (const sid of ['n17-a1', 'n17-a2', 'n17-a3']) await inj7.decide(pl7(sid), { kind: 'enter', messages: [ask7] })
  body7 = only('另一条线乙', '0msusb01', '0msusb01', '0.42')
  for (const sid of ['n17-b1', 'n17-b2', 'n17-b3']) await inj7.decide(pl7(sid), { kind: 'enter', messages: [ask7] })
  const panel7 = NB.readSuspectPanel({ workspace: ws7 })
  ok('N17 面板列得出压着的每一跳（不是只报个数）',
    /现在压着 2 跳/.test(panel7.body) && /0msusa01 ↔ 0msusa01/.test(panel7.body) &&
      /0msusb01 ↔ 0msusb01/.test(panel7.body) && /账上 2 跳/.test(panel7.scope),
    panel7.scope)
  ok('N17 面板顺手给一条能整批摘掉的命令（模型不用自己拼 id）',
    /memory_link\(action="mute", pairs=\[\["0ms[a-z0-9]+","0ms[a-z0-9]+"\],\["0ms[a-z0-9]+","0ms[a-z0-9]+"\]\]\)/.test(panel7.body),
    (panel7.body.match(/一次摘掉：[^\n]*/) ?? [''])[0].slice(0, 120))

  // 真走 memory_link(pairs=…)：一支能断、一支不存在 → 逐对报成败，成的那跳当场销账
  const LINK7 = await import(pathToFileURL(join(root, 'lib', 'macro', 'defs', 'link.js')).href)
  const calls7 = []
  const exec7 = { agent: { session: { header: { cwd: ws7 } } } }
  const link7 = LINK7.createLink({
    flow: {
      resolveIdDetail: async (id) => (/^0msusa/.test(String(id)) ? { kind: 'ok', id } : { kind: 'missing', id }),
      tryCall: async (name, payload) => {
        calls7.push(payload)
        return { entry: true, text: '已屏蔽这一跳（重建也不会再连）' }
      },
      flushLinks: async () => {},
    },
    meowDir: () => '.dsh-meow',
  })
  const out7 = await link7.execute({ action: 'mute', pairs: [['0msusa01', '0msusa01'], ['0msusb01', '0msusb01']] }, exec7)
  ok('N17 批量回执先说清成了几跳、给了几对（一眼看得出有没漏）',
    out7.startsWith('摘掉 1 跳，1 跳没成（一共给了 2 对）：0msusa01 ↔ 0msusa01'), out7.split('\n')[0])
  ok('N17 没成的那跳带星图原话（重试时只给它们就行）',
    /- 0msusb01 ↔ 0msusb01：这个工作区里没有这条记忆：/.test(out7),
    (out7.match(/^- 0msusb01[^\n]*/m) ?? [''])[0].slice(0, 80))
  ok('N17 只对真能断的那跳打星图（查不存在的跳不再白打一次）', calls7.length === 1, String(calls7.length))
  ok('N17 断掉的当场销账、没断的留在账上（不留到过期，也不假装清空）',
    !Object.keys(NB.readSuspectLedger(ws7).edges).some((k) => k.includes('msusa')) &&
      Object.keys(NB.readSuspectLedger(ws7).edges).some((k) => k.includes('msusb')),
    JSON.stringify(Object.keys(NB.readSuspectLedger(ws7).edges)))
  ok('N17 销账那几跳在邻域账里留一行痕（面板念得出「AI 已断」）',
    /a=0msusa01 b=0msusa01 via=mute cleared=1$/.test(readFileSync(LOG7, 'utf8').trim().split('\n').slice(-1)[0] ?? ''),
    readFileSync(LOG7, 'utf8').trim().split('\n').slice(-1)[0] ?? '')

  // 越界与形状：不静默丢（丢掉会被读成「那几对也摘了」）
  const many = Array.from({ length: 21 }, (_, i) => ['0msusa' + String(i).padStart(2, '0'), '0msusa99'])
  const cap7 = await link7.execute({ action: 'mute', pairs: many }, exec7)
  ok('N17 一次 20 跳封顶：超了只做前 20 对并说明剩下怎么再来一次',
    /摘掉 20 跳/.test(cap7) && /一次最多 20 对（给了 21 对）/.test(cap7), cap7.split('\n')[0])
  const badShape = await link7.execute({ action: 'mute', pairs: [['0msusa01'], ['0msusa02', '0msusa02']] }, exec7)
  ok('N17 形状不对的那组单独说出来（能做的照做，不整批作废）',
    /有 1 对形状不对（每组要两个 id，空值也算没给），这几对没动。/.test(badShape) &&
      badShape.includes('已屏蔽这一跳'),
    badShape.replace(/\n/g, ' / ').slice(0, 120))
  const notArray = await link7.execute({ action: 'mute', pairs: '0msusa01|0msusa01' }, exec7)
  ok('N17 pairs 不是数组时也交代清楚（不是一句「缺 a」把人引去补 a/b）',
    /要给成 \[\[a1,b1\],\[a2,b2\]\] 这种「一对一组」的数组（这次给的不是数组），这几对没动/.test(notArray),
    notArray.split('\n')[0].slice(0, 80))

  ok('N17 只给一对 pairs 时归一回单对路径（回执里没有批量抬头）',
    await (async () => {
      const t = await link7.execute({ action: 'mute', pairs: [['0msusa01', '0msusa01']] }, exec7)
      return t.includes('已屏蔽这一跳') && !/摘掉 \d+ 跳/.test(t)
    })())
  ok('N17 pairs 用在 mute 以外的动作上时明确说没动（不静默忽略）',
    await (async () => {
      const t = await link7.execute({ action: 'path', a: '0msusa01', b: '0msusa01', pairs: [['0msusa01', '0msusa01']] }, exec7)
      return /pairs 只在 mute 生效（这次是 path），这几对一条都没动。/.test(t)
    })())
  ok('N17 卡片标题念成「一次摘 N 跳」（写操作，不再是单个动作名）',
    /一次摘 2 跳/.test(link7.presentCall({ action: 'mute', pairs: [['a', 'b'], ['c', 'd']] }).title),
    link7.presentCall({ action: 'mute', pairs: [['a', 'b'], ['c', 'd']] }).title)

  // 过期放回：连标轮数调到 9 时账上那跳就不算压着了（「有记录」≠「压住」）
  ok('N17 面板对「有记录但没压住」也解释得清（不把观察记录说成压住）',
    /都没到连标|已经三轮没再被标/.test(NB.readSuspectPanel({ workspace: ws7, turns: 9 }).body),
    NB.readSuspectPanel({ workspace: ws7, turns: 9 }).body.split('\n')[0].slice(0, 60))
}

// 那个句柄在 Windows 上会占住临时工作区，不关就删不掉（EPERM）。收尾前统一关掉。
const MeowMod = await import(pathToFileURL(join(root, 'vendor/meow-memory/lib/index.js')).href)
MeowMod.closeAllDbs()
rmSync(tmpHome, { recursive: true, force: true })

console.log('')
if (fail > 0) {
  console.log(`FAILED  passed ${pass} / failed ${fail}`)
  for (const b of bad) console.log('  ✗ ' + b)
  process.exitCode = 1
} else {
  console.log(`ALL PASS  probe-neighbor：${pass}/${pass}`)
}
