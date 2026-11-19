// 口径清单：一件事只写一份判据（0.2.35）
//
// 为什么有这个文件：`verify.mjs` 的 A31 与 `tools/doctor.mjs` 的结构段本来各写一遍
// 同样的几条判据，而且宽严不一样——verify 会拿理由表里的五个值逐个查调用点有没有裸字面量，
// doctor 只钉了其中两个（`'节点待入图'`、`'星图太慢待重试'`）。于是把 `'连线失败待重试'`
// 抄回 linkflow 里，verify 红、doctor 绿：体检说「理由或期限仍有第二处写法」的那一行
// 反而成了唯一看不见的地方。
//
// 这里只有判据本身，没有读写文件、没有副作用：调用方把源码与运行时表传进来。
// verify 逐条落成断言（红一条就知道是哪条），doctor 汇总成一行（红时列出哪几条）。

/** 理由的五个键：少一个就有一类欠账说不清。 */
export const REASON_KEYS = ['notReady', 'notBuilt', 'slow', 'failed', 'deferred']

/** 已经被理由表取代的旧写法：出现即代表又有人手抄了一份口径。 */
export const LEGACY_REASON_TEXT = ['memory_link 失败待重试']

/**
 * 理由与期限的口径判据。
 *
 * @param {object} input
 * @param {string} [input.linksSrc]  `lib/macro/links.js` 源码
 * @param {string} [input.flowSrc]   `lib/macro/linkflow.js` 源码
 * @param {string} [input.linkSrc]   `lib/macro/defs/link.js` 源码
 * @param {string} [input.adminSrc]  `lib/macro/defs/admin.js` 源码
 * @param {object} [input.reasons]   `PENDING_REASONS`
 * @param {string[]} [input.order]   `REASON_ORDER`
 * @returns {{ id: string, label: string, ok: boolean, detail: string }[]}
 */
export function reasonChecklist({
  linksSrc = '',
  flowSrc = '',
  linkSrc = '',
  adminSrc = '',
  reasons = {},
  order = [],
} = {}) {
  const values = Object.values(reasons ?? {})
  const bare = values.filter((r) => flowSrc.includes(`'${r}'`) || linkSrc.includes(`'${r}'`))
  const legacy = LEGACY_REASON_TEXT.filter((t) => flowSrc.includes(t) || linkSrc.includes(t))
  const missingKeys = REASON_KEYS.filter((k) => typeof reasons?.[k] !== 'string')
  const unordered = values.filter((r) => !(order ?? []).includes(r))
  const missingPaths = REASON_KEYS.filter((k) => !flowSrc.includes(`PENDING_REASONS.${k}`))
  const panelNoNumber = adminSrc.includes('await flow.flushNow(exec)') && !adminSrc.includes('flow.flushNow(exec, { budgetMs')

  return [
    {
      id: 'table',
      label: '理由表五行齐全、值不重复',
      ok: values.length === REASON_KEYS.length && new Set(values).size === values.length,
      detail: values.join(' / ') || '空的',
    },
    {
      id: 'keys',
      label: '五类理由都在（未装配/待入图/太慢/失败/没轮到）',
      ok: missingKeys.length === 0,
      detail: missingKeys.length ? `缺 ${missingKeys.join(',')}` : Object.keys(reasons ?? {}).join(','),
    },
    {
      id: 'order',
      label: '面板顺序覆盖全部理由',
      ok: values.length > 0 && unordered.length === 0,
      detail: unordered.length ? `未排序 ${unordered.join(' / ')}` : `${(order ?? []).length} 个`,
    },
    {
      id: 'paths',
      label: '四条排队路径都走常量',
      ok: missingPaths.length === 0,
      detail: missingPaths.length ? `缺 ${missingPaths.join(',')}` : 'ok',
    },
    {
      id: 'no-bare',
      label: 'linkflow 与 defs/link 不再写理由字面量',
      ok: bare.length === 0,
      detail: bare.join(' / ') || '干净',
    },
    {
      id: 'legacy',
      label: '同一个失败只有一种叫法（旧写法不许回来）',
      ok: legacy.length === 0,
      detail: legacy.length ? `还在：${legacy.join(' / ')}` : '已统一',
    },
    {
      id: 'grouped',
      label: '面板按理由分组（不认识的理由也照原样列）',
      ok: linksSrc.includes('export function reasonCounts') && linksSrc.includes('按理由：${groups}'),
      detail: linksSrc.includes('export function reasonCounts') ? 'reasonCounts' : '没找到 reasonCounts',
    },
    {
      id: 'empty',
      label: '空队列不加「按理由」那一行',
      ok: /list\.length === 0/.test(linksSrc),
      detail: /list\.length === 0/.test(linksSrc) ? 'ok' : '空队列分支不在',
    },
    {
      id: 'panel-number',
      label: '面板不自己传数（期限只有一个出口）',
      ok: panelNoNumber,
      detail: panelNoNumber ? 'ok' : adminSrc.includes('budgetMs: 1500') ? '面板还在传数' : '面板没走 flushNow(exec)',
    },
    {
      id: 'panel-left',
      label: '面板说清还剩几条',
      ok: adminSrc.includes('还剩 ${round.left} 条'),
      detail: adminSrc.includes('还剩 ${round.left} 条') ? 'ok' : '没说还剩几条',
    },
    {
      id: 'panel-budget',
      label: '面板说清这一轮的上限（多久、几条）',
      ok: adminSrc.includes('describeMs(round.budgetMs)') && adminSrc.includes('round.limit'),
      detail:
        adminSrc.includes('describeMs(round.budgetMs)') && adminSrc.includes('round.limit')
          ? 'ok'
          : '被掐断时看不出是被时间掐的还是被条数掐的',
    },
  ]
}

/** 一句话汇总（doctor 用）：全过给「N/N」，否则列出红的那几条。 */
export function summarizeChecklist(list = []) {
  const bad = list.filter((c) => !c.ok)
  if (bad.length === 0) return `${list.length}/${list.length} 全过`
  return bad.map((c) => `${c.label}（${c.detail}）`).join('；')
}

// ── 第二族：跨插件措辞（contract.js）────────────────────────────────────────
//
// 0.2.38 之前这一族有两份实现：verify 的 A27 手写十条、doctor 一行手写（bareMarks 九项
// 又抄了一遍值、外加自己查一次 verify 源码）。两份都叫「跨插件措辞只有一处」——
// 而判据自己就是两处。同一个字面量改值，一边红一边绿，等于体检又一次替主人确认没查的事。
//
// 这里把「常量 → 值」的表变成唯一一份；verify 与 doctor 都只传源码进来。

/** 跨插件措辞：常量名 → 星图源码里的那一段字。改值只改这里与 contract.js。 */
export const CONTRACT_MARKS = {
  NODE_MISSING_MARK: '星图里没有',
  LINKED_MARK: '已固化连线',
  MISSING_PAIR_MARK: '找不到这两条记忆',
  SELF_PAIR_MARK: '不能把一条记忆和它自己配成一对',
  NOT_READY_MARK: '这项能力还没就绪',
  PATH_MISSING_NODES_MARK: '找不到这两个节点',
  PATH_NOT_IN_GRAPH_MARK: '节点不在当前星图里',
  PATH_UNRELATED_MARK: '没有关系就不编关系',
  PATH_ENGINE_STALE_MARK: '还没带上路径搜索',
  // 0.2.39：空命中的两种说法。后者是结论，前者是「还没算」。
  RECALL_EMPTY_GRAPH_MARK: '星图里还没有节点（图是空的）',
  RECALL_NO_MATCH_MARK: '星图里没有匹配',
  // 0.2.40：体检的空结果。「共 0 项」在空图上会被读成「很干净」。
  HYGIENE_EMPTY_GRAPH_MARK: '这次体检等于没算',
  // 0.2.41：星图概况的空图。「0 条记忆」会被读成「记忆丢了」。
  STATS_EMPTY_GRAPH_MARK: '星图现在还是空的',
  // 0.2.42：读单条记忆的空结果。「没找到」会被读成「记忆没了」；后者也喂 graphState。
  INSPECT_EMPTY_GRAPH_MARK: '这次 nebula_inspect 等于没算',
  INSPECT_NOT_FOUND_MARK: '这不等于「记忆没了」',
  // 0.2.43：来源体检的「0 个来源」。「没接上」会被读成「记忆没了」。
  SOURCES_EMPTY_MARK: '这句有两种意思',
  // 0.2.44：补邻居的空结果。「种子一条都没找到」被说成「都读过」。
  BRIDGE_EMPTY_MARK: '这次没补到东西',
  // 0.2.45：解释证据链的空结果。图空着时原来也说「这两条记忆没有连上」。
  PATH_EMPTY_GRAPH_MARK: '这次 nebula_path 等于没算',
  // 0.2.46：相似检索的空结果。子插件原来一个字都不给（融合层只剩 {"hits": []}）。
  // 前者是「没算成」（三种原因），后者是唯一允许出现的结论。
  SIMILAR_NOT_COMPUTED_MARK: '相似检索没算成',
  SIMILAR_NONE_MARK: '这才是「记忆里没有相似的东西」',
  // 0.2.47：项目全景的空结果。「查无此项目名」会被读成「这个项目没记忆」，
  // 于是要么漏掉 fact/lesson/topic 里那一堆，要么新建一个重复项目。
  PROJECT_NAME_NOT_FOUND_MARK: '这个名字在库里一条都对不上',
  PROJECT_OTHER_LAYERS_MARK: '在别的层还有',
  PROJECT_TRULY_EMPTY_MARK: '这次是真没有',
  // 0.2.48：整理任务没启动的四种原因。原来「消息没送出去」被说成「没有需要整理的记忆」。
  DREAM_NOTHING_MARK: '没有需要整理的记忆（盘点过',
  DREAM_BUSY_MARK: '已经有一个 dream 在跑',
  DREAM_NOT_STARTED_MARK: '这次没启动成功',
  // 0.2.49：改记忆的回执。「一次都没改」与「改了一半」原来都只说「✅ 已更新」——
  // 拿到肯定答复的人不会再检查，于是被静默丢掉的字段永远没人知道。
  UPDATE_NOTHING_MARK: '这次什么都没改',
  UPDATE_PARTIAL_MARK: '这是「部分生效」，不是全部',
  UPDATE_NOT_FOUND_MARK: '没有这个 id',
  // 0.2.50：写记忆的回执。层名写错会悄悄落进 fact、subcategory/goal/corrected 给错层会丢、
  // importance 小数会被四舍五入、内容像旧条目会并进去——五种情况原来共用「✅ 记忆已写入」。
  REMEMBER_LEVEL_FALLBACK_MARK: '这不是「按你说的层写好了」',
  REMEMBER_DROPPED_MARK: '这几个参数没生效',
  REMEMBER_MERGED_MARK: '这是「合并」，不是「新写一条」',
  // 0.2.51：检索的 level 过滤。层名写错时过滤后数组空掉，零命中只说「以最新的为准」——
  // 「层名没对上」被卖成「记忆里没有」，随后就会有人重复写一条。
  SEARCH_LEVEL_NONE_MARK: '这次一条都没查：你给的层名',
  SEARCH_LEVEL_PARTIAL_MARK: '这几个层名没生效',
  SEARCH_SCOPE_ONLY_MARK: '这次只在',
  // 0.2.51：融合层再守一层——上游一个字都不给时，「空」不许被读成「没有」。
  SEARCH_NO_REPLY_MARK: '检索这次没有任何回执',
  // 0.2.52：读的短 id 撞车。findById 走 LIKE 前缀，撞上多条就静默取第一条（按 LEVELS 顺序），
  // 回执却写成「[fact] 标题（active）」——把另一条记忆的正文当成你要的那条递过来。
  READ_AMBIGUOUS_MARK: '这个短 id 不止一条记忆',
  READ_NOT_FOUND_MARK: '这个工作区里一条都没有',
  READ_NO_REPLY_MARK: '读取这次没有任何回执',
  SIMILAR_AMBIGUOUS_MARK: '相似检索这次一条都没比',
  SIMILAR_NOT_FOUND_MARK: '相似检索没起点',
}

/** 字面量不许再出现的文件（相对 lib/macro）。 */
export const CONTRACT_LEAK_FILES = ['links.js', 'bridge.js', 'linkflow.js', 'defs/link.js', 'defs/search.js']

/**
 * 跨插件措辞的判据。
 *
 * @param {object} input
 * @param {string} [input.contractSrc]   `lib/macro/contract.js` 源码
 * @param {Record<string,string>} [input.sources]  泄漏面：文件名 → 源码
 * @param {object} [input.runtime]       `contract.js` 的运行时导出（防「源码有、导出没」）
 * @param {string} [input.nebIndexSrc]   `vendor/dsh-memory-nebula/lib/index.js` 源码
 * @param {string} [input.nebCoreSrc]    `vendor/dsh-memory-nebula/lib/host/nebula.js` 源码
 * @returns {{ id: string, label: string, ok: boolean, detail: string }[]}
 */
export function contractChecklist({
  contractSrc = '',
  sources = {},
  runtime = {},
  nebIndexSrc = '',
  nebCoreSrc = '',
  meowIndexSrc = '',
} = {}) {
  const names = Object.keys(CONTRACT_MARKS)
  const notNamed = names.filter((n) => !contractSrc.includes(`export const ${n} = '${CONTRACT_MARKS[n]}'`))
  const leak = []
  for (const [file, src] of Object.entries(sources ?? {})) {
    for (const [name, mark] of Object.entries(CONTRACT_MARKS)) {
      if (String(src ?? '').includes(`'${mark}'`)) leak.push(`${file}:${name}`)
    }
  }
  const drift = names.filter((n) => runtime?.[n] !== CONTRACT_MARKS[n])
  const hasKind = /export function pathAnswerKind\(/.test(contractSrc)
  const linkTakesKind = String(sources?.['defs/link.js'] ?? '').includes('pathAnswerKind(')
  // 文件头那张「常量 → 原文 → 出处」表也是数据（0.2.41）：同一行被抄两遍不会让任何断言变红，
  // 只会让人以为有两个常量。这张表本来就该和 CONTRACT_MARKS 一一对应。
  const rowNames = String(contractSrc)
    .split('\n')
    // 表在 JSDoc 里，每行前面有 ` * `——先剥掉注释前缀再判，否则一张表会被当成不存在
    .map((l) => l.replace(/^\s*\*?\s?/, '').trim())
    .filter((l) => /^\|\s*`[A-Z_]+`\s*\|/.test(l))
    .map((l) => l.replace(/^\|\s*`([A-Z_]+)`[\s\S]*$/, '$1'))
  const dupRows = [...new Set(rowNames.filter((n, i) => rowNames.indexOf(n) !== i))]
  const missingRows = names.filter((n) => !rowNames.includes(n))
  const kinds = ['pathAnswerKind', 'recallAnswerKind', 'hygieneAnswerKind', 'statsAnswerKind', 'inspectAnswerKind', 'sourcesAnswerKind', 'bridgeAnswerKind', 'similarAnswerKind', 'projectAnswerKind', 'dreamAnswerKind', 'updateAnswerKind', 'rememberAnswerKind', 'searchAnswerKind', 'readAnswerKind', 'similarAnswerKind']
  const missingKinds = kinds.filter((k) => !new RegExp(`export function ${k}\\(`).test(contractSrc))
  // 0.2.54：连线归一那一族（撞车 / 没查成 / 真没有）横跨三个文件，判据只能读源码
  const flowSrcL = String(sources?.['linkflow.js'] ?? '')
  const linksSrcL = String(sources?.['links.js'] ?? '')
  const linkDefSrcL = String(sources?.['defs/link.js'] ?? '')
  // 0.2.58：检索模式名与「参数给错模式」——模式写错原来会静默走本地检索，一个字都不说
  const searchDefSrcS = String(sources?.['defs/search.js'] ?? '')
  // 0.2.55：存储层与两个面板，「空着」有四种来路——读侧要看它带回原因，写侧要看失败账
  const storeSrcS = String(sources?.['store.js'] ?? '')
  const costSrcS = String(sources?.['cost.js'] ?? '')
  const linksSrcS2 = String(sources?.['links.js'] ?? '')
  // 0.2.61：面板条数（成本账本 / 待补连线）原来把 0 与负数一声不吭换成默认值
  const panelSrcP = String(sources?.['panel.js'] ?? '')
  const adminSrcP = String(sources?.['defs/admin.js'] ?? '')
  const costSrcP = String(sources?.['cost.js'] ?? '')
  const pendingSrcP = String(sources?.['links.js'] ?? '')
  // 0.2.62：读记忆的 neighbors 给错就悄悄「没有邻居」——条数的唯一出口搬到了 shared.js
  const sharedSrcN = String(sources?.['shared.js'] ?? '')
  const readDefSrcN = String(sources?.['defs/read.js'] ?? '')
  // 0.2.63：注入上限写坏会变成「零字注入」——上限的唯一出口搬进了 prompt.js
  const promptSrcQ = String(sources?.['prompt.js'] ?? '')
  const storeBad = [
    !/export function readJsonlDetail\(/.test(storeSrcS) && 'store: 少了 readJsonlDetail（读不出来的原因没带出来）',
    !/export function appendJsonlDetail\(/.test(storeSrcS) && 'store: 少了 appendJsonlDetail（写不进去的原因没带出来）',
    !/ENOENT/.test(storeSrcS) && 'store: ENOENT 和其他错误没分开',
    !costSrcS.includes('一行都没写进去') && 'cost: 没区分「写不进去」',
    !costSrcS.includes('这不是「你还没调用工具」') && 'cost: 写失败时没否认「你还没调用」',
    !costSrcS.includes('一行都解析不出来') && 'cost: 没区分「全坏行」',
    !costSrcS.includes('不是账本是空的') && 'cost: 没区分「读不出来」',
    !costSrcS.includes('还没记过账') && 'cost: 真没有那一支丢了',
    !linksSrcS2.includes('一条都没存下来') && 'links: 没区分「写不进去」',
    !linksSrcS2.includes('不是「没有欠账」') && 'links: 写失败时没否认「没有欠账」',
    !linksSrcS2.includes('不是「都连上了、没有欠账」') && 'links: 读不出来时没否认「都连上了」',
    !linksSrcS2.includes('待补连线：0 条（星图那边都连上了，没有欠账）') && 'links: 真没有那一支丢了',
    !/writeFail\.failures = 0/.test(costSrcS + linksSrcS2) && 'store: 写成功没清零旧账',
  ].filter(Boolean)

  return [
    {
      id: 'table',
      label: '文件头那张表的每一行只出现一次，也不缺常量',
      ok: dupRows.length === 0 && missingRows.length === 0,
      detail:
        dupRows.length || missingRows.length
          ? [dupRows.length ? `重复 ${dupRows.join(',')}` : '', missingRows.length ? `缺 ${missingRows.join(',')}` : '']
              .filter(Boolean)
              .join('；')
          : `${rowNames.length} 行`,
    },
    {
      id: 'kinds',
      label: `${kinds.length} 族归类函数都在 contract.js 里（各只一处实现）`,
      ok: missingKinds.length === 0,
      detail: missingKinds.length ? `缺 ${missingKinds.join(',')}` : `${kinds.length}/${kinds.length}`,
    },
    {
      id: 'marks',
      label: `跨插件措辞 ${names.length} 个都在 contract.js 按值起名`,
      ok: notNamed.length === 0,
      detail: notNamed.length ? `缺 ${notNamed.join(',')}` : `${names.length}/${names.length}`,
    },
    {
      id: 'runtime',
      label: '运行时的值和这张表一致（源码有、导出也得有）',
      ok: drift.length === 0,
      detail: drift.length ? `不一致 ${drift.join(',')}` : 'ok',
    },
    {
      id: 'leak',
      label: '这些字在调用方一个字都不许再写',
      ok: leak.length === 0,
      detail: leak.join(' / ') || `干净（${Object.keys(sources ?? {}).length} 个文件）`,
    },
    {
      id: 'kind',
      label: '归类只有一处实现，调用方从 contract 取',
      ok: hasKind && linkTakesKind,
      detail: hasKind ? (linkTakesKind ? 'ok' : 'defs/link.js 没用 pathAnswerKind') : 'contract.js 没有 pathAnswerKind',
    },
    {
      id: 'vendor-index',
      label: '星图入口里真的还有那两句（按整句认）',
      ok: nebIndexSrc.includes('星图里没有 id=${id} 的记忆') && nebIndexSrc.includes('已固化连线：'),
      detail: nebIndexSrc ? `${nebIndexSrc.length} 字符` : '没读到 vendor 源码',
    },
    {
      id: 'vendor-core',
      label: '引擎里真的还有那两句永久失败（按整句认）',
      ok: nebCoreSrc.includes("'找不到这两条记忆：'") && nebCoreSrc.includes("'不能把一条记忆和它自己配成一对：'"),
      detail: nebCoreSrc ? `${nebCoreSrc.length} 字符` : '没读到 vendor 源码',
    },
    {
      id: 'vendor-hygiene',
      label: '体检的空结果也说清「等于没算」（补丁在位）',
      ok:
        nebIndexSrc.includes('这次体检等于没算') &&
        nebIndexSrc.includes('「0 项」不是「很干净」') &&
        /nodes\?\.length[\s\S]{0,80}=== 0/.test(nebIndexSrc),
      detail: nebIndexSrc.includes('这次体检等于没算')
        ? 'ok'
        : 'vendor 又被换回去了：空图体检只回「共 0 项」，读起来就是很干净',
    },
    {
      id: 'vendor-stats',
      label: '星图概况的空图说清「这不是记忆丢了」（补丁在位）',
      ok:
        nebIndexSrc.includes('星图现在还是空的') &&
        nebIndexSrc.includes('这不是「记忆丢了」') &&
        /\breadErrors\b/.test(nebIndexSrc),
      detail: nebIndexSrc.includes('这不是「记忆丢了」')
        ? 'ok'
        : 'vendor 又被换回去了：空图概况只回「0 条记忆」，读起来就是记忆丢了',
    },
    {
      id: 'vendor-recall',
      label: '空命中的那句真的带上了节点总数（补丁在位）',
      ok: nebIndexSrc.includes('星图里还没有节点（图是空的），这一问等于没算。') && nebIndexSrc.includes('一条都对不上'),
      detail: nebIndexSrc.includes('这一问等于没算')
        ? 'ok'
        : 'vendor 又被换回去了：空命中只剩一句话，分不清「没算」和「没有」',
    },
    {
      id: 'vendor-inspect',
      label: '读一条记忆的空结果也分「图还是空的」和「图里没这条」（补丁在位）',
      ok:
        nebIndexSrc.includes('这次 nebula_inspect 等于没算') &&
        nebIndexSrc.includes('这不等于「记忆没了」') &&
        /nebula\.graph\?\.nodes\?\.length \?\? 0\) === 0/.test(nebIndexSrc),
      detail: nebIndexSrc.includes('这不等于「记忆没了」')
        ? 'ok'
        : 'vendor 又被换回去了：inspect 只回「星图里没有 id=… 的记忆」，空图和真没有共用一句',
    },
    {
      id: 'vendor-sources',
      label: '来源体检的「0 个来源」也说清是哪一种没接上（补丁在位）',
      ok:
        nebIndexSrc.includes('这句有两种意思') &&
        nebIndexSrc.includes('这不等于「记忆没了」') &&
        /live\.stores\.length === 0/.test(nebIndexSrc) &&
        /r\.config\.exists === false/.test(nebIndexSrc),
      detail: nebIndexSrc.includes('这句有两种意思')
        ? 'ok'
        : 'vendor 又被换回去了：「已接入 0 个来源，共读到 0 条记忆」分不清「没接」和「没读到」',
    },
    {
      id: 'vendor-bridge',
      label: '补邻居的空结果不再把「种子没找到」说成「都读过」（补丁在位）',
      ok:
        nebIndexSrc.includes('这次没补到东西') &&
        nebIndexSrc.includes('一条都没在图里找到种子') &&
        /stats\?\.seedCount \?\? 0/.test(nebIndexSrc),
      detail: nebIndexSrc.includes('这次没补到东西')
        ? 'ok'
        : 'vendor 又被换回去了：bridge 只回「没有可补充的邻居（种子 0 条…都已读过或在冷却期）」',
    },
    {
      id: 'vendor-path',
      label: '解释证据链只在真算过的时候才说「没有关系」（补丁在位）',
      ok:
        nebIndexSrc.includes('这次 nebula_path 等于没算') &&
        nebIndexSrc.includes('确实没有连上') &&
        nebIndexSrc.includes('没有关系就不编关系') &&
        !/没有连上（\$\{r\?\.error/.test(nebIndexSrc),
      detail: nebIndexSrc.includes('这次 nebula_path 等于没算')
        ? 'ok'
        : 'vendor 又被换回去了：path 把「图空着 / 节点没入图 / 引擎旧」和「确实没关系」压成一句',
    },
    {
      id: 'vendor-similar',
      label: '相似检索一条都没有的时候也给字（补丁在位）',
      ok:
        meowIndexSrc.includes('相似检索没算成') &&
        meowIndexSrc.includes('这才是「记忆里没有相似的东西」') &&
        /note: \{ type: "string" \}/.test(meowIndexSrc) &&
        /hits\.length === 0\) \{\n\s+return \[\{/.test(meowIndexSrc),
      detail: meowIndexSrc.includes('相似检索没算成')
        ? 'ok'
        : 'meow 又被换回去了：memory_find_similar 空命中时 render 返回空数组，上层只剩 {"hits": []}',
    },
    {
      id: 'vendor-project',
      label: '项目全景的空结果分了三种原因（名字对不上 / 别的层还有 / 真没有）',
      ok:
        meowIndexSrc.includes('这个名字在库里一条都对不上') &&
        meowIndexSrc.includes('在别的层还有') &&
        meowIndexSrc.includes('这次是真没有') &&
        meowIndexSrc.includes('这不是「这个项目没有记忆」') &&
        /if \(text === null\) \{\n\s+\/\/ \[macro-fusion 0\.2\.47\]/.test(meowIndexSrc),
      detail: meowIndexSrc.includes('这个名字在库里一条都对不上')
        ? 'ok'
        : 'meow 又被换回去了：memory_project 空全景只剩「该项目暂无记忆条目」，把「查无此名」说成「无记忆」',
    },
    {
      id: 'vendor-dream',
      label: 'dream 没启动时说清是哪一种（没东西可整理 / 已有在跑 / 消息没送到）',
      ok:
        meowIndexSrc.includes('没有需要整理的记忆（盘点过') &&
        meowIndexSrc.includes('已经有一个 dream 在跑') &&
        meowIndexSrc.includes('这次没启动成功') &&
        meowIndexSrc.includes('这不是「没有需要整理的记忆」') &&
        /return say\("sendFailed"\)/.test(meowIndexSrc) &&
        /\.reason === "claimed"/.test(meowIndexSrc),
      detail: meowIndexSrc.includes('这次没启动成功')
        ? 'ok'
        : 'meow 又被换回去了：startWindowDream 只回 false，dream 工具把「消息没送出去」说成「没有需要整理的记忆」',
    },
    {
      id: 'vendor-update',
      label: '改记忆的回执说清「改了什么 / 哪些没生效」（不再一句 ✅ 已更新）',
      ok:
        meowIndexSrc.includes('这次什么都没改') &&
        meowIndexSrc.includes('这是「部分生效」，不是全部') &&
        meowIndexSrc.includes('没有这个 id') &&
        meowIndexSrc.includes('这不是「已经更新好了」') &&
        /const changed = Object\.keys\(patch\)/.test(meowIndexSrc) &&
        /const dropped = \[\]/.test(meowIndexSrc) &&
        /note: \{ type: "string" \}/.test(meowIndexSrc),
      detail: meowIndexSrc.includes('这次什么都没改')
        ? 'ok'
        : 'meow 又被换回去了：memory_update 只回 ok，字段被静默丢掉（或一个都没给）时也说「✅ 已更新」',
    },
    {
      id: 'vendor-remember',
      label: '写记忆的回执说清「层名被改过 / 哪些参数没生效 / 是合并不是新写」',
      ok:
        meowIndexSrc.includes('这不是「按你说的层写好了」') &&
        meowIndexSrc.includes('这几个参数没生效') &&
        meowIndexSrc.includes('这是「合并」，不是「新写一条」') &&
        meowIndexSrc.includes('不在七层里') &&
        /const levelBad = /.test(meowIndexSrc) &&
        /const noteOf = \(extra\) =>/.test(meowIndexSrc) &&
        /note: \{ type: "string" \}/.test(meowIndexSrc),
      detail: meowIndexSrc.includes('这不是「按你说的层写好了」')
        ? 'ok'
        : 'meow 又被换回去了：memory_remember 把层名拼错的一条静默写进 fact，回执只说「✅ 记忆已写入」',
    },
    {
      id: 'vendor-search',
      label: '检索的空结果说清「层名没对上 / 只在某几层里查过」，不冒充「记忆里没有」',
      ok:
        meowIndexSrc.includes('这次一条都没查：你给的层名') &&
        meowIndexSrc.includes('这几个层名没生效') &&
        meowIndexSrc.includes('这次只在') &&
        meowIndexSrc.includes('这不是「记忆里没有」') &&
        /const levelBad = levelAsked\.filter\(\(s\) => !LEVELS\.includes\(s\)\)/.test(meowIndexSrc) &&
        /const levelValid = levelAsked\.filter\(\(s\) => LEVELS\.includes\(s\)\)/.test(meowIndexSrc),
      detail: meowIndexSrc.includes('这次一条都没查：你给的层名')
        ? 'ok'
        : 'meow 又被换回去了：memory_search 的 level 写错会被过滤成空数组，零命中只说「以最新的为准」',
    },
    {
      id: 'vendor-search-param',
      label: '检索参数（状态 / 时段 / 条数 / 截断）给错了各说各的，不冒充「本次零命中」',
      ok:
        meowIndexSrc.includes('const STATUS_VALUES = ["active", "stale", "archived"]') &&
        /const statusDead = statusAsked\.length > 0 && statusList\.length === 0/.test(meowIndexSrc) &&
        meowIndexSrc.includes('状态值没对上') &&
        meowIndexSrc.includes('这几个状态值没生效') &&
        meowIndexSrc.includes('days 给的是') &&
        meowIndexSrc.includes('k 给的是') &&
        meowIndexSrc.includes('content_max 给的是') &&
        /const rows = statusDead \? \[\] : levels\.flatMap/.test(meowIndexSrc) &&
        /\[plain, levelNote, scopeNote, statusNote, daysNote, kNote, cmNote\]/.test(meowIndexSrc),
      detail: meowIndexSrc.includes('状态值没对上')
        ? 'ok'
        : 'meow 又被换回去了：status 拼错时一行都查不到，零命中却按「默认检索范围」解释；days / k / content_max 被静默纠正',
    },
    {
      id: 'vendor-read',
      label: '读记忆的「短 id 撞车」不再替你挑第一条，真没有时也说清是工作区/位数',
      ok:
        meowIndexSrc.includes('这个短 id 不止一条记忆') &&
        meowIndexSrc.includes('这个工作区里一条都没有') &&
        meowIndexSrc.includes('不是我替你挑第一条') &&
        /const matches = typeof db\.findByIdAll === "function"/.test(meowIndexSrc) &&
        /if \(matches\.length > 1\) \{/.test(meowIndexSrc) &&
        /ambiguous: \{ type: "boolean" \}/.test(meowIndexSrc),
      detail: meowIndexSrc.includes('这个短 id 不止一条记忆')
        ? 'ok'
        : 'meow 又被换回去了：memory_read 用 findById 静默取前缀撞车的第一条，回执照写「[fact] 标题（active）」',
    },
    {
      id: 'vendor-similar-id',
      label: '相似检索的基准短 id 撞车时一条都不比，不拿别人的正文当基准',
      ok:
        meowIndexSrc.includes('相似检索这次一条都没比') &&
        meowIndexSrc.includes('相似检索没起点') &&
        meowIndexSrc.includes('不是我替你挑第一条') &&
        meowIndexSrc.includes('基准挑错，比出来的相似度全是错的') &&
        /const matches = typeof db\.findByIdAll === "function"/.test(meowIndexSrc) &&
        /if \(matches\.length > 1\) \{\s*\n\s*const shown = matches\.slice\(0, 5\)[\s\S]{0,400}?memory_find_similar: 相似检索这次一条都没比/.test(
          meowIndexSrc,
        ),
      detail: meowIndexSrc.includes('相似检索这次一条都没比')
        ? 'ok'
        : 'meow 又被换回去了：memory_find_similar 用 findById 静默取撞车的第一条，拿别人的正文当基准算相似度',
    },
    {
      id: 'link-resolve-three',
      label: '连线归一把「短 id 撞车 / 这次没查成 / 真没有」分开说，前两种不摘补连队列',
      ok:
        flowSrcL.includes('async function resolveIdDetail(') &&
        flowSrcL.includes("kind: 'unavailable'") &&
        flowSrcL.includes("kind: 'ambiguous'") &&
        flowSrcL.includes('LINK_AMBIGUOUS_LINE') &&
        flowSrcL.includes('LINK_UNAVAILABLE_LINE') &&
        flowSrcL.includes('LINK_MISSING_LINE') &&
        linkDefSrcL.includes('flow.resolveIdDetail(') &&
        linkDefSrcL.includes('这不是「这条记忆不存在」') &&
        linksSrcL.includes("da.kind === 'ambiguous' || db.kind === 'ambiguous'") &&
        linksSrcL.includes('ambiguous += 1') &&
        linksSrcL.includes('unavailable += 1') &&
        /dropped \+= 1/.test(linksSrcL) &&
        /return \{ tried, linked, dropped, ambiguous, unavailable,/.test(linksSrcL),
      detail:
        flowSrcL.includes('async function resolveIdDetail(') && linksSrcL.includes('ambiguous += 1')
          ? 'ok'
          : '融合层又把「撞车 / 没查成 / 真没有」压成一句「找不到这条记忆」了：读的路径与队列都会跟着撒谎',
    },
    {
      id: 'store-fail-visible',
      label: '账本与队列的「空着」四种来路各说各的：没写过 / 写不进去 / 读不出来 / 全坏行',
      ok: storeBad.length === 0,
      detail: storeBad.length === 0 ? 'ok' : storeBad.join('；'),
    },
    {
      id: 'vendor-param-zero',
      label: '数值参数（条数 / 跳数 / 权重）给 0 就照办 0，越界与非数字要带一句话出来',
      ok:
        nebIndexSrc.includes('function numParam(name, raw, { min, max, def })') &&
        nebIndexSrc.includes('const n = Number(raw)') &&
        nebIndexSrc.includes('if (!Number.isFinite(n))') &&
        nebIndexSrc.includes('不是数字——这次按默认') &&
        nebIndexSrc.includes('超出 ${min}–${max}，这次按 ${clamped} 算') &&
        nebIndexSrc.includes("numParam('limit'") &&
        nebIndexSrc.includes("numParam('hops'") &&
        nebIndexSrc.includes("numParam('min_weight'") &&
        nebIndexSrc.includes("numParam('maxHops'") &&
        nebIndexSrc.includes("numParam('hubs'") &&
        nebIndexSrc.includes("numParam('neighbors'") &&
        nebIndexSrc.includes("const pLimit = numParam('limit', args.limit, { min: 1, max: 30, def: 10 })") &&
        nebIndexSrc.includes("const pHops = numParam('hops', args.hops, { min: 0, max: 3, def: 2 })") &&
        nebIndexSrc.includes("const pWeight = numParam('min_weight', args.min_weight, { min: 0, max: 1, def: 0.5 })") &&
        nebIndexSrc.includes("const pMh = numParam('maxHops', args.maxHops, { min: 1, max: 12, def: 6 })"),
      detail:
        nebIndexSrc.includes('function numParam(')
          ? 'ok'
          : '星图的数值参数又被 `Number(x) || 默认值` 吃掉了：0 被当成「没给」（min_weight 偷偷变 0.5），越界被夹也不吭声',
    },
    {
      id: 'search-mode-whitelist',
      label: '检索模式只认白名单那四个，写错就一句都不查；参数给错模式要说清没用上',
      ok:
        searchDefSrcS.includes("const MODE_VALUES = ['local', 'graph', 'bridge', 'similar']") &&
        /function modeOf\(args\)/.test(searchDefSrcS) &&
        /bad: !MODE_VALUES\.includes\(name\)/.test(searchDefSrcS) &&
        searchDefSrcS.includes('mode 没生效：你给的是「${mode.raw}」') &&
        searchDefSrcS.includes('这次一条都没查——这不是「记忆里没有」，是模式名没对上') &&
        searchDefSrcS.includes('沿关联扩散用 graph') &&
        searchDefSrcS.includes('expand 只在 local 模式生效') &&
        searchDefSrcS.includes('k 是本地检索的条数') &&
        searchDefSrcS.includes('limit 是 graph / bridge 的条数') &&
        searchDefSrcS.includes('只在 bridge 模式生效，这次没用上') &&
        /if \(mode\.bad\) return badModeText\(mode\)/.test(searchDefSrcS) &&
        /const text = await runSearch\(flow, args, exec, flags\)/.test(searchDefSrcS) &&
        /const notes = modeNotes\(mode\.name, args, flags\)/.test(searchDefSrcS),
      detail: searchDefSrcS.includes('function modeOf(')
        ? 'ok'
        : '检索模式又变成「不认识就当本地检索」了：写 mode=graph 的人会拿到关键词命中，还以为是沿关联扩散',
    },
    {
      id: 'link-action-and-ends',
      label: '连线的动作名与两端 id 缺了先挡住（不许冒充「已排队」），参数给错动作要说清没用上',
      ok:
        linkDefSrcL.includes("const LINK_ACTIONS = ['link', 'unlink', 'mute', 'unmute', 'path']") &&
        /function linkActionOf\(args\)/.test(linkDefSrcL) &&
        /raw\.trim\(\)\.toLowerCase\(\)/.test(linkDefSrcL) &&
        linkDefSrcL.includes('没给 action') &&
        linkDefSrcL.includes('action 给的是「${act.raw}」') &&
        linkDefSrcL.includes('星图和记忆都没动') &&
        /function missingEnds\(args\)/.test(linkDefSrcL) &&
        linkDefSrcL.includes('缺 ${e.key}') &&
        /if \(ends\.length > 0\) return missingEndsText\(act, ends\)/.test(linkDefSrcL) &&
        /async function runLink\(flow, action, args, exec\)/.test(linkDefSrcL) &&
        /const notes = linkNotes\(act\.name, args\)/.test(linkDefSrcL) &&
        linkDefSrcL.includes('maxHops 只在 path 这个动作生效') &&
        linkDefSrcL.includes('note 只有 link / mute 会存下来') &&
        /if \(act\.bad\) return badActionText\(act\)/.test(linkDefSrcL),
      detail: linkDefSrcL.includes('function missingEnds(')
        ? 'ok'
        : '连线又在缺参数时往下走了：`resolveIdDetail(undefined)` 回「missing 且 id 空」，那个空 id 又被 filter(Boolean) 滤掉，于是「你没给 a」变成「暂时没落图，已排队」——还排下一条永远连不上的欠账',
    },
    {
      id: 'admin-limit-zero',
      label: '面板的条数给 0 就照办 0（负数与非数字回默认但要说出口），别拿被换过的条数当结论',
      ok:
        /export function limitOf\(spec, args\)/.test(panelSrcP) &&
        panelSrcP.includes("return { value: fallback, note: '' }") &&
        panelSrcP.includes('不是数字——这次按默认 ${fallback} 条算') &&
        panelSrcP.includes('是负数——条数没有「从后往前数」这回事') &&
        panelSrcP.includes('limit 给的是 0，这次一条都不列') &&
        panelSrcP.includes('条数只能是整数，这次按 ${whole} 条算') &&
        panelSrcP.includes('return { value: whole, note: ') &&
        adminSrcP.includes('const lim = limitOf(ACTIONS.cost, args)') &&
        adminSrcP.includes('const lim = limitOf(ACTIONS.links, args)') &&
        adminSrcP.includes('const c = readCost(lim.value)') &&
        adminSrcP.includes('[c.scope, lim.note].filter(Boolean).join') &&
        adminSrcP.includes('[`最多列 ${lim.value} 条`, cap, lim.note].filter(Boolean).join') &&
        costSrcP.includes('n <= 0') &&
        costSrcP.includes('这次一条都不列（账本里其实有 ${detail.lines} 行') &&
        pendingSrcP.includes('这次一条都不列（队列里其实有 ${list.length} 条'),
      detail: panelSrcP.includes('limit 给的是 0，这次一条都不列')
        ? 'ok'
        : '面板条数又在静默纠偏：`limit: 0` 被换成默认值（成本账本甚至会 slice(-0) 列出全部），用户拿着被改过的条数读「最近 N 次」',
    },
    {
      id: 'read-neighbors-param',
      label: '读记忆的 neighbors 给错要说出口（不许悄悄变成「这条记忆没有邻居」），0 是文档写明的「不带」照办',
      ok:
        /export function countParam\(name, raw, \{ min = 0, max = Number\.POSITIVE_INFINITY, def \} = \{\}\)/.test(sharedSrcN) &&
        sharedSrcN.includes("if (raw === undefined || raw === null) return { value: def, note: '' }") &&
        sharedSrcN.includes('不是数字——这次按默认 ${def} 条算') &&
        sharedSrcN.includes('是负数——条数没有「从后往前数」这回事') &&
        sharedSrcN.includes('if (n === 0) return { value: 0, note: \'\' }') &&
        sharedSrcN.includes('少掉的那半条不是你给的条件') &&
        sharedSrcN.includes('结果是被改过的条件算出来的') &&
        readDefSrcN.includes("countParam('neighbors', args.neighbors, { min: 0, max: 40, def: 12 })") &&
        /if \(nb\.value <= 0\) return nb\.note\.length > 0/.test(readDefSrcN) &&
        /neighbors: nb\.value/.test(readDefSrcN) &&
        !/args\.neighbors === undefined \? 12 : Number\(args\.neighbors\)/.test(readDefSrcN) &&
        !/!Number\.isFinite\(want\) \|\| want <= 0/.test(readDefSrcN),
      detail: readDefSrcN.includes('countParam(')
        ? 'ok'
        : '读记忆的 neighbors 又在静默吞条件：非数字与负数被一句 `if (!Number.isFinite(want) || want <= 0) return said` 压成「没有邻居段」，读的人只会以为这条记忆没有邻居',
    },
    {
      id: 'guide-budget-param',
      label: '注入上限写坏不许变成「零字注入」：回默认并说出口，只有明确给 0 才照办 0',
      ok:
        /export function guideBudget\(raw\)/.test(promptSrcQ) &&
        promptSrcQ.includes("if (raw === undefined || raw === null || raw === '') return { value: GUIDE_MAX_CHARS, note: '' }") &&
        promptSrcQ.includes('不是数字——这次按默认 ${GUIDE_MAX_CHARS} 字算') &&
        promptSrcQ.includes('是负数——上限没有「从后往前数」这回事') &&
        promptSrcQ.includes('一个字都不注入') &&
        promptSrcQ.includes('少掉的那半字不是你给的条件') &&
        promptSrcQ.includes('尾巴都放不下') &&
        /const cap = guideBudget\(maxChars\)\.value/.test(promptSrcQ) &&
        adminSrcP.includes('guideBudget(config.guideMaxChars)') &&
        adminSrcP.includes('L0 注入：现在') &&
        !/Math\.max\(0, Number\(maxChars\)/.test(promptSrcQ),
      detail: promptSrcQ.includes('guideBudget(')
        ? 'ok'
        : '注入上限又在静默纠偏：`guideMaxChars` 写坏（"4k"、-5、null）会被读成 0，整段 L0 注入变成空串，日志与面板一个字都不说',
    },
    {
      id: 'admin-hygiene-kind',
      label: '体检的类别是枚举：给错要挡住并列出六个键（不许照跑一遍、把「没查」打成「这一类是 0」）',
      ok:
        adminSrcP.includes("const HYGIENE_KINDS = ['dup', 'stale', 'thin', 'oversize', 'unread', 'orphan']") &&
        /function guardHygiene\(args\)/.test(adminSrcP) &&
        /const name = raw\.trim\(\)\.toLowerCase\(\)/.test(adminSrcP) &&
        adminSrcP.includes('if (!HYGIENE_KINDS.includes(name))') &&
        adminSrcP.includes('只认 ${HYGIENE_KINDS.join(\' / \')}') &&
        adminSrcP.includes('这次体检没有跑') &&
        adminSrcP.includes('别把「没跑」读成「这一类没有问题」') &&
        /args\.kind = name/.test(adminSrcP) &&
        adminSrcP.includes('guard: guardHygiene') &&
        String(nebIndexSrc ?? '').includes('const labelOf = (k) => NAME[k] ?? String(k)') &&
        String(nebIndexSrc ?? '').includes('${labelOf(k)}（0）') &&
        !String(nebIndexSrc ?? '').includes('${NAME[k]}（0）'),
      detail: adminSrcP.includes('guardHygiene')
        ? 'ok'
        : '体检的 kind 又在裸传给星图：不认识的类别不会报错，那一行打成「（0）」、抬头仍写「共 N 项」，用户会把「没查这一类」读成「这一类是 0 条」',
    },
    {
      id: 'search-limit-used-note',
      label: '尾注不许撒谎：local 扩散真的读了 limit / hops 就不许说「没用上」，星图没接上也不许说「真的用了」',
      ok:
        /function modeNotes\(mode, args, flags = \{\}\)/.test(searchDefSrcS) &&
        searchDefSrcS.includes('const spread = flags.spread === true') &&
        searchDefSrcS.includes('flags.spreadTried = true') &&
        searchDefSrcS.includes('if (spread.entry) flags.spread = true') &&
        searchDefSrcS.includes('这次扩散真的用了它（limit=${flags.spreadLimit}）') &&
        searchDefSrcS.includes('这次本来要扩散（会用 limit=${flags.spreadLimit}），但星图没接上') &&
        searchDefSrcS.includes('这次没有扩散，limit 没用上') &&
        searchDefSrcS.includes('相似检索的条数用 k，这次没用上 limit') &&
        !searchDefSrcS.includes('limit 只在 graph / bridge 模式生效'),
      detail: searchDefSrcS.includes('flags.spreadTried')
        ? 'ok'
        : '检索尾注又在替用户猜条件：local 自动扩散明明读了 limit / hops（limit=0 也照递），尾注却一律说「这次没用上 limit」——读者把「星图没补到东西」和「条件没生效」两句合成「星图里真没有」',
    },
    {
      id: 'graph-fallback-param-note',
      label: '同一组参数两条路径：星图接上时本地条件没用上、退本地时真的生效——尾注跟着路径说话',
      ok:
        searchDefSrcS.includes("const LOCAL_ONLY_PARAMS = ['level', 'project', 'status', 'days', 'content_max', 'explain']") &&
        searchDefSrcS.includes('const fell = flags.graphFellBack === true') &&
        searchDefSrcS.includes('const absent = flags.graphAbsentNoLocal === true') &&
        searchDefSrcS.includes('k 这次真的用上了') &&
        searchDefSrcS.includes('k 这次没参与') &&
        searchDefSrcS.includes('这些是本地检索的条件') &&
        searchDefSrcS.includes('只在本地检索生效') &&
        searchDefSrcS.includes('flags.graphFellBack = true') &&
        searchDefSrcS.includes('flags.graphAbsentNoLocal = true'),
      detail: searchDefSrcS.includes('graphFellBack')
        ? 'ok'
        : 'graph / bridge 的本地条件又在替用户猜：星图接上时 project / level / days / k 被静默丢掉（读者以为筛过），星图没接上退到本地检索时它们真的生效了，尾注却照旧说「这次按 10 条算」',
    },
    {
      id: 'similar-mode-param-note',
      label: '相似模式只认 id / k / content_max：query 与本地条件被丢掉时必须说话（含 content_max 不许误报）',
      ok:
        searchDefSrcS.includes("const similarIgnored = LOCAL_ONLY_PARAMS.filter((n) => n !== 'content_max' && args[n] !== undefined)") &&
        searchDefSrcS.includes('query 在相似模式没用上') &&
        searchDefSrcS.includes('不是按你说的句子找') &&
        searchDefSrcS.includes('相似检索只认 id / k / content_max') &&
        searchDefSrcS.includes('这不是「没有相似」，是这几个条件压根没算') &&
        searchDefSrcS.includes('相似检索不扩散，这次没用上') &&
        searchDefSrcS.includes('相似检索只看 id 指向的那一条，这次没用上'),
      detail: searchDefSrcS.includes('similarIgnored')
        ? 'ok'
        : '相似模式的参数又在沉默：它只认 id / k / content_max，query（读者以为在按句子找）、level / project / status / days / explain、hops、memory_ids 全被丢掉且一声不吭——读者把「按 id 比出来的几条」当成「按项目和日期筛过的相似」',
    },
    {
      id: 'panel-param-owner-note',
      label: '面板不读的参数不许悄悄消失：抬头要点名它归哪个 action，并说清这次没参与（手册例外只免抬头）',
      ok:
        adminSrcP.includes('export function strayNote(action, spec, args) {') &&
        adminSrcP.includes('export const PARAM_OWNERS = (() => {') &&
        adminSrcP.includes("(PARAM_OWNERS.get(name) ?? []).join(' / ')") &&
        adminSrcP.includes('不读${it}，这次一点没参与') &&
        adminSrcP.includes('别读成「结果已经按${it}收窄过」') &&
        adminSrcP.includes('const stray = strayNote(action, spec, args)') &&
        adminSrcP.split('note: stray').length - 1 === 2 &&
        adminSrcP.includes('[out.note, stray].filter(Boolean).join(') &&
        adminSrcP.includes('return extra.length > 0 ? '),
      detail: adminSrcP.includes('strayNote')
        ? 'ok'
        : '面板参数又在沉默：八个参数对每个 action 都合法，执行时只取表里那一行列的，剩下的被静默丢掉——给 cost 配 kind 会读成「按 dup 筛过的账本」，给 stats 配 limit 会读成「这几个枢纽就是全部」',
    },
    {
      id: 'search-id-memoryids-note',
      label: 'id 只有 similar 当基准、memory_ids 只有扩散当起点：写到别的模式里必须说话（三种处境分开说）',
      ok:
        searchDefSrcS.includes("if (mode !== 'similar' && typeof args.id === 'string' && args.id.trim() !== '')") &&
        searchDefSrcS.includes('id 只在 mode=similar 里当基准') &&
        searchDefSrcS.includes('这次没用上它——这不是「这条记忆被排除了」') &&
        searchDefSrcS.includes("if (mode === 'local' && args.memory_ids !== undefined)") &&
        searchDefSrcS.includes('memory_ids 这次真的用上了') &&
        searchDefSrcS.includes('memory_ids 平时是扩散的起点') &&
        searchDefSrcS.includes('memory_ids 只在扩散时当起点'),
      detail: searchDefSrcS.includes('id 只在 mode=similar 里当基准')
        ? 'ok'
        : '两个参数又在沉默：`id` 只有 mode=similar 当基准，写在 local / graph / bridge 里被静默丢掉（读者会以为这条记忆被排除了）；`memory_ids` 一旦这次没扩散就完全没参与，回执里却一个字都没有（读者会以为结果就是从这几个 id 起跳的）',
    },
    {
      id: 'admin-card-detail',
      label: '运维面板的卡片：前缀只放面板中文名（不带品牌），细节位放这一轮真给了的参数',
      ok:
        adminSrcP.includes('export function cardDetail(args) {') &&
        adminSrcP.includes('for (const name of PARAM_OWNERS.keys()) {') &&
        adminSrcP.includes('${name}=${v.length} 条') &&
        adminSrcP.includes('cardTitle(spec.label, cardDetail(args))') &&
        adminSrcP.includes("cardTitle('未知动作', shown)") &&
        !adminSrcP.includes('cardTitle(panelBrand'),
      detail: adminSrcP.includes('cardDetail')
        ? 'ok'
        : '运维面板的卡片还是老样子：前缀塞了品牌（全表唯一一处，0.2.60 写的是「prefix 是中文名」），细节位永远空着——`hygiene` 与 `hygiene kind=dup limit=5` 两张卡片一字不差，会话里分不清哪张是只看重复的',
    },
    {
      id: 'stats-hubs-cap',
      label: '星图概况的 hubs 是参数不是摆设：上限只有一处（HUB_CAP），且「没排上来的」不许说成「还有 N 条没列」',
      ok:
        nebCoreSrc.includes('export const HUB_CAP = 40') &&
        nebCoreSrc.includes('export function hubSlots(value, def = 12)') &&
        nebCoreSrc.includes('return Math.min(HUB_CAP, n)') &&
        nebCoreSrc.includes('.slice(0, hubSlots(opts.hubs))') &&
        nebCoreSrc.split('hubSlots(opts.hubs)').length - 1 === 1 &&
        nebCoreSrc.includes('async overviewAsync(opts = {})') &&
        nebIndexSrc.includes('overviewAsync({ hubs: pHubs.value })') &&
        nebIndexSrc.includes("numParam('hubs', args.hubs, { min: 1, max: HUB_CAP, def: 10 })") &&
        nebIndexSrc.includes('export function hubTail(printed, pool, cap)') &&
        nebIndexSrc.includes('const pool = Math.max(0, (s.nodes || 0) - (s.orphans || 0))') &&
        nebIndexSrc.includes('const hubNote = hubTail(top.length, pool, HUB_CAP)') &&
        !nebIndexSrc.includes('还有 ${s.nodes - top.length} 条没列') &&
        !nebIndexSrc.includes('没列的不代表不是枢纽') &&
        !nebIndexSrc.includes('上限 40') &&
        !nebIndexSrc.includes('o.hubs.slice(0, pHubs.value)'),
      detail: nebCoreSrc.includes('hubSlots')
        ? 'ok'
        : '枢纽又成了「全图减去已列」：把孤立记忆也算成「没列出的枢纽」，尾注按 s.nodes - top.length 报「还有 N 条没列」，还得靠一句「没列的不代表不是枢纽」打圆场；上限 40 也又散回了参数夹取与正文两处字面量',
    },
    {
      id: 'graph-miss-split',
      label: '星图面板的两种「没结果」分开说：装配没完成 ≠ 星图那边报错，原因要原样带出来',
      ok:
        adminSrcP.includes("import { NOT_READY_MARK } from '../contract.js'") &&
        adminSrcP.includes('said.includes(NOT_READY_MARK)') &&
        adminSrcP.includes('要的那个能力还没装配好') &&
        adminSrcP.includes('星图这次答不上来（${what}）') &&
        adminSrcP.includes('const reason = said.startsWith(pre) ? said.slice(pre.length) : said') &&
        !adminSrcP.includes('等星图就绪'),
      detail: adminSrcP.includes('NOT_READY_MARK')
        ? 'ok'
        : '星图面板又把「没装配好」和「星图报错」压成同一句话：两种情形都被说成「这次没接上」，真正的错误（ENOENT 之类）被吃掉，读者拿到的是错的下一步——等一个永远不会来的「就绪」',
    },
    {
      id: 'hygiene-count-ledger',
      label: '体检的条数只有一本账：抬头给全量计数，「列了几条 / 还剩几条」按正文实列数算',
      ok:
        nebIndexSrc.includes('export function listTail(n, printed, limit)') &&
        nebIndexSrc.includes('const printed = Math.min(limit, arr.length)') &&
        nebIndexSrc.includes('for (const it of arr.slice(0, printed))') &&
        nebIndexSrc.includes('const tail = listTail(n, printed, limit)') &&
        nebIndexSrc.includes('…还有 ${left} 条') &&
        nebIndexSrc.includes('没列的不代表不存在') &&
        !nebIndexSrc.includes('这里只列前 ${arr.length} 条') &&
        !nebIndexSrc.includes('if (n > limit) lines.push'),
      detail: nebIndexSrc.includes('listTail')
        ? 'ok'
        : '体检又按两本账报数：抬头用引擎那本（每类最多留 40 条）写「这里只列前 40 条」，正文只列 limit 行，尾注又按 limit 减——三个数字各说各的，读者拿哪个都算不对',
    },
    {
      id: 'cost-scope-count',
      label: '成本面板的「最近 N 次」按真算了的条数报：要了几次、算了几条、更早几条没进、几行读不出来',
      ok:
        costSrcP.includes('export function costScope(asked, counted, good, bad = 0)') &&
        costSrcP.includes('统计最近 ${got} 次调用') &&
        costSrcP.includes('你要的是 ${want} 次，账本里能算的只有 ${got} 条') &&
        costSrcP.includes('更早的 ${older} 条没进这次统计') &&
        costSrcP.includes('另有 ${broken} 行解析不出来') &&
        costSrcP.includes('export function readCost(limit = 200)') &&
        costSrcP.includes('return { body: lines.join') &&
        costSrcP.includes('scope: costScope(n, entries.length, detail.entries.length, detail.badLines)') &&
        adminSrcP.includes('const c = readCost(lim.value)') &&
        adminSrcP.includes('[c.scope, lim.note]') &&
        !adminSrcP.includes('最近 ${lim.value} 次调用'),
      detail: costSrcP.includes('costScope')
        ? 'ok'
        : '成本面板又把「最近 200 次」当成事实：抬头写你要的次数，正文只算账本里剩下的几条，坏行夹在中间连数都不进——三个数（要的 / 算的 / 账本里的）只说一个，读者拿合计去估成本会当成整本账',
    },
    {
      id: 'read-neighbor-gap',
      label: '读记忆的邻居段没拿到时要说三种话：没查成 / 没查到这条 / 回执里没这一段——不许沉默',
      ok:
        sharedSrcN.includes("export function neighborGapNote(section, reachable, raw = '')") &&
        sharedSrcN.includes('星图这次没答上来（这一问没查成）') &&
        sharedSrcN.includes('星图这次没查到这条记忆') &&
        sharedSrcN.includes('星图的回执里没有「连接到的记忆」这一段') &&
        sharedSrcN.includes('这不是「这条记忆没有邻居」') &&
        readDefSrcN.includes('const gap = neighborGapNote(section, inspect.def !== undefined, inspect.text)') &&
        readDefSrcN.includes('[said, section, gap, nb.note].filter(Boolean).join') &&
        !readDefSrcN.includes('const base = section ?'),
      detail: sharedSrcN.includes('neighborGapNote')
        ? 'ok'
        : '读记忆要了邻居、却没拿到那一段时一声不吭：星图报错、星图说没这条记忆、回执改了格式，三种情形全被拼掉，读者只看得到正文——于是把「没带到」读成「这条记忆没有邻居」',
    },
    {
      id: 'link-args-drop',
      label: '写入时给的 links，用不了的条目要数出来（整份不是数组 / 空 id / 形状不对），不许悄悄丢',
      ok:
        String(sources?.['linkflow.js'] ?? '').includes('export function linkArgs(links)') &&
        String(sources?.['linkflow.js'] ?? '').includes('export function linkDropNote(drop, anchorMissing = false)') &&
        String(sources?.['linkflow.js'] ?? '').includes('links 里这 ${total} 条没法用：') &&
        String(sources?.['linkflow.js'] ?? '').includes('条是空 id') &&
        String(sources?.['linkflow.js'] ?? '').includes('条既不是 id 字符串，也不是 {id, note}') &&
        String(sources?.['linkflow.js'] ?? '').includes('所以连排队都没法排') &&
        String(sources?.['linkflow.js'] ?? '').includes('const { items, drop } = linkArgs(links)') &&
        !String(sources?.['linkflow.js'] ?? '').includes('const items = normalizeLinks(links)'),
      detail: String(sources?.['linkflow.js'] ?? '').includes('linkArgs')
        ? 'ok'
        : '写入时给的 links 被筛掉也没人说：整份不是数组、条目是空 id 或者根本不是 {id, note} 时，面板上跟没给 links 一样，调用者以为都连上了；上游没给 id 时更糟——一条不连、也不排队',
    },
  ]
}

/**
 * 跨插件措辞那一族也要能被打红（同 selfTestChecklist 的道理）。
 *
 * @returns {{ baseline: string[], survived: string[] }}
 */
export function selfTestContract() {
  const marksSrc = Object.keys(CONTRACT_MARKS)
    .map((n) => `export const ${n} = '${CONTRACT_MARKS[n]}'`)
    .join('\n')
  const tableSrc = Object.keys(CONTRACT_MARKS)
    .map((n) => `| \`${n}\` | \`${CONTRACT_MARKS[n]}\` | 出处 |`)
    .join('\n')
  const good = {
    contractSrc: `${tableSrc}
${marksSrc}
export function pathAnswerKind(text) { return 'ok' }
export function recallAnswerKind(text) { return 'ok' }
export function hygieneAnswerKind(text) { return 'ok' }
export function statsAnswerKind(text) { return 'ok' }
export function inspectAnswerKind(text) { return 'ok' }
export function sourcesAnswerKind(text) { return 'ok' }
export function bridgeAnswerKind(text) { return 'ok' }
export function similarAnswerKind(text) { return 'ok' }
export function projectAnswerKind(text) { return 'ok' }
export function dreamAnswerKind(text) { return 'ok' }
export function updateAnswerKind(text) { return 'ok' }
export function rememberAnswerKind(text) { return 'ok' }
export function searchAnswerKind(text) { return 'ok' }
export function readAnswerKind(text) { return 'ok' }`,
    sources: {
      'links.js': [
        "da.kind === 'ambiguous' || db.kind === 'ambiguous'",
        'ambiguous += 1',
        'unavailable += 1',
        'dropped += 1',
        'return { tried, linked, dropped, ambiguous, unavailable,',
        '待补连线：一条都没存下来',
        '这不是「没有欠账」',
        '不是「都连上了、没有欠账」',
        '待补连线：0 条（星图那边都连上了，没有欠账）。',
        '这次一条都不列（队列里其实有 ${list.length} 条',
      ].join('\n'),
      'bridge.js': '',
      'linkflow.js': [
        'const k = inspectAnswerKind(t)',
        'async function resolveIdDetail(id, exec) {}',
        "kind: 'unavailable'",
        "kind: 'ambiguous'",
        'LINK_AMBIGUOUS_LINE LINK_UNAVAILABLE_LINE LINK_MISSING_LINE',
        'export function linkArgs(links)',
        'export function linkDropNote(drop, anchorMissing = false)',
        'links 里这 ${total} 条没法用：',
        '条是空 id',
        '条既不是 id 字符串，也不是 {id, note}',
        '所以连排队都没法排',
        'const { items, drop } = linkArgs(links)',
      ].join('\n'),
      'defs/link.js': [
        'const k = pathAnswerKind(t)',
        'await flow.resolveIdDetail(args.a, exec)',
        '这不是「这条记忆不存在」',
        "const LINK_ACTIONS = ['link', 'unlink', 'mute', 'unmute', 'path']",
        'function linkActionOf(args) {',
        'raw.trim().toLowerCase()',
        '没给 action',
        'action 给的是「${act.raw}」',
        '星图和记忆都没动',
        'function missingEnds(args) {',
        '缺 ${e.key}',
        'if (ends.length > 0) return missingEndsText(act, ends)',
        'async function runLink(flow, action, args, exec) {',
        'const notes = linkNotes(act.name, args)',
        'maxHops 只在 path 这个动作生效',
        'note 只有 link / mute 会存下来',
        'if (act.bad) return badActionText(act)',
      ].join('\n'),
      'defs/search.js': [
        "const MODE_VALUES = ['local', 'graph', 'bridge', 'similar']",
        'function modeOf(args) {',
        'return { name, bad: !MODE_VALUES.includes(name), raw: String(raw) }',
        'mode 没生效：你给的是「${mode.raw}」，这里只认 local / graph / bridge / similar',
        '这次一条都没查——这不是「记忆里没有」，是模式名没对上。',
        '沿关联扩散用 graph；强相关但没读过的邻居用 bridge；相似条目用 similar + id',
        'expand 只在 local 模式生效',
        'k 是本地检索的条数；',
        'limit 是 graph / bridge 的条数；这次没有扩散，limit 没用上（本地检索的条数用 k）。',
        '这次扩散真的用了它（limit=${flags.spreadLimit}）',
        '这次本来要扩散（会用 limit=${flags.spreadLimit}），但星图没接上',
        '相似检索的条数用 k，这次没用上 limit。',
        '只在 bridge 模式生效，这次没用上。',
        'if (mode.bad) return badModeText(mode)',
        'function modeNotes(mode, args, flags = {}) {',
        'const flags = {}',
        'const text = await runSearch(flow, args, exec, flags)',
        'const notes = modeNotes(mode.name, args, flags)',
        'const spread = flags.spread === true',
        'flags.spreadTried = true',
        'if (spread.entry) flags.spread = true',
        "const LOCAL_ONLY_PARAMS = ['level', 'project', 'status', 'days', 'content_max', 'explain']",
        'const fell = flags.graphFellBack === true',
        'const absent = flags.graphAbsentNoLocal === true',
        'k 这次真的用上了',
        'k 这次没参与',
        '这些是本地检索的条件',
        '只在本地检索生效',
        'flags.graphFellBack = true',
        'flags.graphAbsentNoLocal = true',
        "const similarIgnored = LOCAL_ONLY_PARAMS.filter((n) => n !== 'content_max' && args[n] !== undefined)",
        'query 在相似模式没用上',
        '不是按你说的句子找',
        '相似检索只认 id / k / content_max',
        '这不是「没有相似」，是这几个条件压根没算',
        '相似检索不扩散，这次没用上',
        '相似检索只看 id 指向的那一条，这次没用上',
        "if (mode !== 'similar' && typeof args.id === 'string' && args.id.trim() !== '')",
        'id 只在 mode=similar 里当基准',
        '这次没用上它——这不是「这条记忆被排除了」',
        "if (mode === 'local' && args.memory_ids !== undefined)",
        'memory_ids 这次真的用上了',
        'memory_ids 平时是扩散的起点',
        'memory_ids 只在扩散时当起点',
      ].join('\n'),
      'store.js': "export function readJsonlDetail(file) {}\nexport function appendJsonlDetail(file, entry) {}\nerr && err.code === 'ENOENT'",
      'cost.js':
        '成本账本一行都没写进去：最近 1 次记账都失败了\n这不是「你还没调用工具」\n一行都解析不出来\n不是账本是空的\n成本账本还没记过账\nwriteFail.failures = 0\nif (Number.isFinite(n) && n <= 0) {\n这次一条都不列（账本里其实有 ${detail.lines} 行' +
        '\nexport function costScope(asked, counted, good, bad = 0) {}' +
        '\n统计最近 ${got} 次调用' +
        '\n你要的是 ${want} 次，账本里能算的只有 ${got} 条' +
        '\n更早的 ${older} 条没进这次统计' +
        '\n另有 ${broken} 行解析不出来' +
        '\nexport function readCost(limit = 200) {' +
        "\nreturn { body: lines.join('\\n'), scope: costScope(n, entries.length, detail.entries.length, detail.badLines) }",
      // 0.2.61：面板条数的口径（panel.js 的 limitOf + defs/admin.js 的两处调用点）
      'panel.js': [
        'export function limitOf(spec, args) {',
        "return { value: fallback, note: '' }",
        '不是数字——这次按默认 ${fallback} 条算',
        '是负数——条数没有「从后往前数」这回事',
        'limit 给的是 0，这次一条都不列',
        '条数只能是整数，这次按 ${whole} 条算',
        'return { value: whole, note: ',
      ].join('\n'),
      'defs/admin.js': [
        'const lim = limitOf(ACTIONS.cost, args)',
        'const lim = limitOf(ACTIONS.links, args)',
        '[`最多列 ${lim.value} 条`, cap, lim.note].filter(Boolean).join',
        'const c = readCost(lim.value)',
        '[c.scope, lim.note].filter(Boolean).join',
        'const budget = guideBudget(config.guideMaxChars)',
        'L0 注入：现在',
        "const HYGIENE_KINDS = ['dup', 'stale', 'thin', 'oversize', 'unread', 'orphan']",
        'function guardHygiene(args) {',
        'const name = raw.trim().toLowerCase()',
        'if (!HYGIENE_KINDS.includes(name)) {',
        "只认 ${HYGIENE_KINDS.join(' / ')}",
        '这次体检没有跑',
        '别把「没跑」读成「这一类没有问题」',
        'args.kind = name',
        'guard: guardHygiene',
        'export function strayNote(action, spec, args) {',
        'export const PARAM_OWNERS = (() => {',
        "(PARAM_OWNERS.get(name) ?? []).join(' / ')",
        '不读${it}，这次一点没参与',
        '别读成「结果已经按${it}收窄过」',
        'const stray = strayNote(action, spec, args)',
        'note: stray',
        'note: stray',
        '[out.note, stray].filter(Boolean).join(',
        'return extra.length > 0 ? ',
        'export function cardDetail(args) {',
        'for (const name of PARAM_OWNERS.keys()) {',
        '${name}=${v.length} 条',
        'cardTitle(spec.label, cardDetail(args))',
        "cardTitle('未知动作', shown)",
        // 0.2.72：星图面板的两种「没结果」分开说
        "import { NOT_READY_MARK } from '../contract.js'",
        'said.includes(NOT_READY_MARK)',
        '要的那个能力还没装配好',
        '星图这次答不上来（${what}）',
        'const reason = said.startsWith(pre) ? said.slice(pre.length) : said',
      ].join('\n'),
      // 0.2.62：条数的唯一出口（shared.js 的 countParam）+ 读记忆那一处调用点
      'shared.js': [
        'export function countParam(name, raw, { min = 0, max = Number.POSITIVE_INFINITY, def } = {}) {',
        "if (raw === undefined || raw === null) return { value: def, note: '' }",
        '不是数字——这次按默认 ${def} 条算',
        '是负数——条数没有「从后往前数」这回事',
        "if (n === 0) return { value: 0, note: '' }",
        '少掉的那半条不是你给的条件',
        '结果是被改过的条件算出来的',
        // 0.2.77：邻居段没拿到时的三种话（没查成 / 没查到这条 / 回执里没这一段）
        "export function neighborGapNote(section, reachable, raw = '') {",
        '星图这次没答上来（这一问没查成）',
        '星图这次没查到这条记忆',
        '星图的回执里没有「连接到的记忆」这一段',
        '这不是「这条记忆没有邻居」',
      ].join('\n'),
      'defs/read.js': [
        "const nb = countParam('neighbors', args.neighbors, { min: 0, max: 40, def: 12 })",
        'if (nb.value <= 0) return nb.note.length > 0 ? `${said}\\n\\n${nb.note}` : said',
        '{ id: args.id, neighbors: nb.value }',
        'const section = neighborSection(inspect.text)',
        'const gap = neighborGapNote(section, inspect.def !== undefined, inspect.text)',
        "[said, section, gap, nb.note].filter(Boolean).join('\\n\\n')",
      ].join('\n'),
      // 0.2.63：注入上限的唯一出口（prompt.js 的 guideBudget）+ 手册末尾那行现状
      'prompt.js': [
        'export function guideBudget(raw) {',
        "if (raw === undefined || raw === null || raw === '') return { value: GUIDE_MAX_CHARS, note: '' }",
        '不是数字——这次按默认 ${GUIDE_MAX_CHARS} 字算',
        '是负数——上限没有「从后往前数」这回事',
        '一个字都不注入',
        '少掉的那半字不是你给的条件',
        '尾巴都放不下',
        'const cap = guideBudget(maxChars).value',
      ].join('\n'),
    },
    runtime: { ...CONTRACT_MARKS },
    nebIndexSrc:
      '星图里没有 id=${id} 的记忆\n已固化连线：\n星图里还没有节点（图是空的），这一问等于没算。\n一条都对不上\n这次体检等于没算——「0 项」不是「很干净」\nif ((nebula.graph?.nodes?.length ?? 0) === 0) {\n宏记忆 · 星图现在还是空的：0 条记忆 / 0 条连接。\n这不是「记忆丢了」，是没读到。\no.readErrors\n这次 nebula_inspect 等于没算\n这不等于「记忆没了」\nif ((nebula.graph?.nodes?.length ?? 0) === 0) {\n已接入 0 个来源，共读到 0 条记忆——这句有两种意思：\nif (r.live.stores.length === 0) {\n r.config.exists === false\n这次没补到东西\n一条都没在图里找到种子\nres?.stats?.seedCount ?? 0\n这次 nebula_path 等于没算\n确实没有连上\n没有关系就不编关系\nfunction numParam(name, raw, { min, max, def })\nconst n = Number(raw)\nif (!Number.isFinite(n))\n不是数字——这次按默认\n超出 ${min}–${max}，这次按 ${clamped} 算\nnumParam(\'limit\'\nnumParam(\'hops\'\nnumParam(\'min_weight\'\nnumParam(\'maxHops\'\nnumParam(\'hubs\'\nnumParam(\'neighbors\'\nconst pLimit = numParam(\'limit\', args.limit, { min: 1, max: 30, def: 10 })\nconst pHops = numParam(\'hops\', args.hops, { min: 0, max: 3, def: 2 })\nconst pWeight = numParam(\'min_weight\', args.min_weight, { min: 0, max: 1, def: 0.5 })\nconst pMh = numParam(\'maxHops\', args.maxHops, { min: 1, max: 12, def: 6 })\nconst labelOf = (k) => NAME[k] ?? String(k)\n${labelOf(k)}（0）\noverviewAsync({ hubs: pHubs.value })\nnumParam(\'hubs\', args.hubs, { min: 1, max: HUB_CAP, def: 10 })\nconst pool = Math.max(0, (s.nodes || 0) - (s.orphans || 0))\nconst hubNote = hubTail(top.length, pool, HUB_CAP)\nexport function hubTail(printed, pool, cap)\nexport function listTail(n, printed, limit)\nconst printed = Math.min(limit, arr.length)\nfor (const it of arr.slice(0, printed))\nconst tail = listTail(n, printed, limit)\n…还有 ${left} 条\n没列的不代表不存在',
    nebCoreSrc:
      "'找不到这两条记忆：' '不能把一条记忆和它自己配成一对：'\nexport const HUB_CAP = 40\nexport function hubSlots(value, def = 12)\nreturn Math.min(HUB_CAP, n)\n.slice(0, hubSlots(opts.hubs))\nasync overviewAsync(opts = {})",
    meowIndexSrc:
      '相似检索没算成：库里就只有这一条可比的记忆。\n这才是「记忆里没有相似的东西」。\nnote: { type: "string" }\nif (hits.length === 0) {\n          return [{\n这个名字在库里一条都对不上\n在别的层还有 3 条记忆\n这次是真没有\n这不是「这个项目没有记忆」\nif (text === null) {\n        // [macro-fusion 0.2.47]\n没有需要整理的记忆（盘点过：没有未封存的记忆轮次）\n已经有一个 dream 在跑（或上一轮还在待补收尾）\n这次没启动成功：整理任务的消息没送进会话\n这不是「没有需要整理的记忆」。\nreturn say("sendFailed")\nif (trace.reason === "claimed") {\n这次什么都没改：一个能写进库的字段都没有。\n这是「部分生效」，不是全部。\n更新失败：没有这个 id\n这不是「已经更新好了」。\nconst changed = Object.keys(patch)\nconst dropped = []\nnote: { type: "string" }\n这不是「按你说的层写好了」\n这几个参数没生效：goal（只有 topic 层有目标句，这条是 fact）。\n这是「合并」，不是「新写一条」。\n不在七层里\nconst levelBad = \nconst noteOf = (extra) =>\n这次一条都没查：你给的层名「lessons」不在七层里（fact / lesson / topic / rules / project / soul / user）。\n这不是「记忆里没有」，是层名没对上。\n这几个层名没生效：lessons（不在七层里）\n这次只在 fact 层里查了，零命中\nconst levelBad = levelAsked.filter((s) => !LEVELS.includes(s))\nconst levelValid = levelAsked.filter((s) => LEVELS.includes(s))\n这个短 id 不止一条记忆：命中了 2 条\n这个工作区里一条都没有\n不是我替你挑第一条\nconst matches = typeof db.findByIdAll === "function"\nif (matches.length > 1) {\nambiguous: { type: "boolean" }\n相似检索这次一条都没比：这个短 id 命中了 2 条（fact 0m1「x」）。不是我替你挑第一条——基准挑错，比出来的相似度全是错的。\n相似检索没起点——这个工作区里一条都没有\nif (matches.length > 1) {\n        const shown = matches.slice(0, 5)\n记忆 memory_find_similar: 相似检索这次一条都没比\nconst STATUS_VALUES = ["active", "stale", "archived"]\nconst statusDead = statusAsked.length > 0 && statusList.length === 0\n状态值没对上\n这几个状态值没生效\ndays 给的是\nk 给的是\ncontent_max 给的是\nconst rows = statusDead ? [] : levels.flatMap\n[plain, levelNote, scopeNote, statusNote, daysNote, kNote, cmNote]',
  }
  const baseline = contractChecklist(good).filter((c) => !c.ok).map((c) => c.id)
  const mutations = {
    table: {
      ...good,
      // 同一行抄两遍：值不变、导出也不变，只有这一条能发现
      contractSrc: good.contractSrc.replace(
        `| \`LINKED_MARK\` | \`已固化连线\` | 出处 |`,
        `| \`LINKED_MARK\` | \`已固化连线\` | 出处 |\n| \`LINKED_MARK\` | \`已固化连线\` | 出处 |`,
      ),
    },
    kinds: { ...good, contractSrc: good.contractSrc.replace(/export function statsAnswerKind[\s\S]*$/, '') },
    'vendor-stats': { ...good, nebIndexSrc: '星图里没有 id=${id} 的记忆\n已固化连线：' },
    'vendor-inspect': { ...good, nebIndexSrc: '星图里没有 id=${id} 的记忆\n已固化连线：' },
    'vendor-sources': { ...good, nebIndexSrc: '星图里没有 id=${id} 的记忆\n已固化连线：' },
    'vendor-bridge': { ...good, nebIndexSrc: '星图里没有 id=${id} 的记忆\n已固化连线：' },
    'vendor-path': { ...good, nebIndexSrc: '星图里没有 id=${id} 的记忆\n已固化连线：' },
    'vendor-similar': { ...good, meowIndexSrc: '' },
    'vendor-search-param': { ...good, meowIndexSrc: '' },
    'vendor-param-zero': { ...good, nebIndexSrc: '' },
    'search-mode-whitelist': {
      ...good,
      sources: { ...good.sources, 'defs/search.js': 'const k = recallAnswerKind(t)' },
    },
    'link-action-and-ends': {
      ...good,
      sources: { ...good.sources, 'defs/link.js': 'const k = pathAnswerKind(t)\nawait flow.resolveIdDetail(args.a, exec)' },
    },
    'admin-limit-zero': {
      ...good,
      sources: { ...good.sources, 'panel.js': 'export function limitOf(spec, args) { return Number(x) || 200 }' },
    },
    'read-neighbors-param': {
      ...good,
      sources: {
        ...good.sources,
        'defs/read.js':
          'const want = args.neighbors === undefined ? 12 : Number(args.neighbors)\nif (!Number.isFinite(want) || want <= 0) return said',
      },
    },
    'vendor-update': { ...good, meowIndexSrc: '' },
    'admin-hygiene-kind': {
      ...good,
      sources: { ...good.sources, 'defs/admin.js': 'const kinds = args.kind ? [args.kind] : Object.keys(NAME)' },
    },
    'panel-param-owner-note': {
      ...good,
      sources: { ...good.sources, 'defs/admin.js': good.sources['defs/admin.js'].replace('一点没参与', '') },
    },
    'search-id-memoryids-note': {
      ...good,
      sources: {
        ...good.sources,
        'defs/search.js': good.sources['defs/search.js'].replace('id 只在 mode=similar 里当基准', ''),
      },
    },
    'admin-card-detail': {
      ...good,
      sources: {
        ...good.sources,
        'defs/admin.js': good.sources['defs/admin.js'].replace('cardTitle(spec.label, cardDetail(args))', 'cardTitle(panelBrand, spec.label)'),
      },
    },
    'stats-hubs-cap': { ...good, nebCoreSrc: good.nebCoreSrc.replace('.slice(0, hubSlots(opts.hubs))', '.slice(0, 12)') },
    'graph-miss-split': {
      ...good,
      sources: {
        ...good.sources,
        'defs/admin.js': good.sources['defs/admin.js'].replace('星图这次答不上来（${what}）', '星图这次没接上'),
      },
    },
    'hygiene-count-ledger': {
      ...good,
      nebIndexSrc: good.nebIndexSrc.replace('const tail = listTail(n, printed, limit)', "const tail = n > limit ? `…还有 ${n - limit} 条` : ''"),
    },
    'cost-scope-count': {
      ...good,
      sources: {
        ...good.sources,
        'cost.js': good.sources['cost.js'].replace(
          'scope: costScope(n, entries.length, detail.entries.length, detail.badLines)',
          'scope: `最近 ${n} 次调用`',
        ),
      },
    },
    'read-neighbor-gap': {
      ...good,
      sources: {
        ...good.sources,
        'defs/read.js': good.sources['defs/read.js'].replace(
          'const gap = neighborGapNote(section, inspect.def !== undefined, inspect.text)',
          "const gap = ''",
        ),
      },
    },
    'link-args-drop': {
      ...good,
      sources: {
        ...good.sources,
        'linkflow.js': good.sources['linkflow.js'].replace('const { items, drop } = linkArgs(links)', 'const items = normalizeLinks(links)'),
      },
    },
    'similar-mode-param-note': {
      ...good,
      sources: { ...good.sources, 'defs/search.js': good.sources['defs/search.js'].replace('query 在相似模式没用上', '') },
    },
    'graph-fallback-param-note': {
      ...good,
      sources: { ...good.sources, 'defs/search.js': good.sources['defs/search.js'].replace('k 这次真的用上了', '') },
    },
    'search-limit-used-note': {
      ...good,
      sources: {
        ...good.sources,
        'defs/search.js': good.sources['defs/search.js'].split('这次扩散真的用了它（limit=${flags.spreadLimit}）').join('这次没用上 limit'),
      },
    },
    'guide-budget-param': {
      ...good,
      sources: { ...good.sources, 'prompt.js': 'export function clampGuide(text, maxChars) { const cap = Math.max(0, Number(maxChars) || 0) }' },
    },
    'vendor-remember': { ...good, meowIndexSrc: '' },
    'vendor-search': { ...good, meowIndexSrc: '' },
    'vendor-read': { ...good, meowIndexSrc: '' },
    'vendor-similar-id': { ...good, meowIndexSrc: good.meowIndexSrc.replaceAll('相似检索这次一条都没比', '相似检索一条都没比') },
    'link-resolve-three': { ...good, sources: { ...good.sources, 'links.js': good.sources['links.js'].replace('ambiguous += 1', '') } },
    'store-fail-visible': {
      ...good,
      sources: { ...good.sources, 'cost.js': good.sources['cost.js'].replace('不是账本是空的', '') },
    },
    'vendor-project': { ...good, meowIndexSrc: '' },
    'vendor-dream': { ...good, meowIndexSrc: '' },
    marks: { ...good, contractSrc: good.contractSrc.replace(`'找不到这两个节点'`, `'找不到两个节点'`) },
    runtime: { ...good, runtime: { ...CONTRACT_MARKS, LINKED_MARK: '已经连上了' } },
    leak: { ...good, sources: { ...good.sources, 'linkflow.js': "'星图太慢待重试' '没有关系就不编关系'" } },
    kind: { ...good, contractSrc: marksSrc },
    'vendor-index': { ...good, nebIndexSrc: '星图里没有……（对面改写了这句）' },
    'vendor-core': { ...good, nebCoreSrc: "'找不到这两条记忆：'" },
    'vendor-recall': { ...good, nebIndexSrc: '星图里没有 id=${id} 的记忆\n已固化连线：' },
    'vendor-hygiene': { ...good, nebIndexSrc: '星图里没有 id=${id} 的记忆\n已固化连线：\n这次体检等于没算' },
  }
  const survived = []
  for (const [id, input] of Object.entries(mutations)) {
    const got = contractChecklist(input).find((c) => c.id === id)
    if (!got || got.ok) survived.push(id)
  }
  return { baseline, survived }
}

/**
 * 自检：每条判据都要能被打红。
 *
 * 单一口径最大的风险是「判据恒真」——两边都读它，它要是不响，验和体检就一起瞎。
 * 这里给出一条全绿的样板输入，再逐条造一个只该弄红那一条的输入；
 * 样板本身有红（baseline）或某条造坏了都没红（survived），都算这条判据不成立。
 *
 * @returns {{ baseline: string[], survived: string[] }}
 */
export function selfTestChecklist() {
  const reasons = {
    notReady: '星图未装配',
    notBuilt: '节点待入图',
    slow: '星图太慢待重试',
    failed: '连线失败待重试',
    deferred: '本次没轮到待补',
  }
  const order = [reasons.deferred, reasons.notBuilt, reasons.slow, reasons.failed, reasons.notReady]
  const pathsSrc = REASON_KEYS.map((k) => `PENDING_REASONS.${k}`).join(' ')
  const good = {
    linksSrc: 'export function reasonCounts(list) {}\n`按理由：${groups}`\nif (list.length === 0) {}',
    flowSrc: pathsSrc,
    linkSrc: '',
    adminSrc: 'await flow.flushNow(exec)\n`还剩 ${round.left} 条`\n`这一轮补连最多 ${describeMs(round.budgetMs)}、${round.limit} 条`',
    reasons,
    order,
  }
  const baseline = reasonChecklist(good).filter((c) => !c.ok).map((c) => c.id)
  const mutations = {
    table: { ...good, reasons: { ...reasons, slow: reasons.notReady } },
    keys: { ...good, reasons: Object.fromEntries(REASON_KEYS.slice(0, 4).map((k) => [k, reasons[k]])) },
    order: { ...good, order: [] },
    paths: { ...good, flowSrc: '没有任何排队路径' },
    'no-bare': { ...good, flowSrc: `${pathsSrc} '\u661f\u56fe\u592a\u6162\u5f85\u91cd\u8bd5'` },
    legacy: { ...good, linkSrc: 'memory_link 失败待重试' },
    grouped: { ...good, linksSrc: '' },
    empty: { ...good, linksSrc: 'export function reasonCounts`按理由：${groups}`' },
    'panel-number': { ...good, adminSrc: 'flow.flushNow(exec, { budgetMs: 1500 })' },
    'panel-left': { ...good, adminSrc: 'await flow.flushNow(exec)' },
    'panel-budget': { ...good, adminSrc: 'await flow.flushNow(exec)\n`还剩 ${round.left} 条`' },
  }
  const survived = []
  for (const [id, input] of Object.entries(mutations)) {
    const got = reasonChecklist(input).find((c) => c.id === id)
    if (!got || got.ok) survived.push(id)
  }
  return { baseline, survived }
}
