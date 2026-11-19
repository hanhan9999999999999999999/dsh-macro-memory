/**
 * 跨插件的文字契约（0.2.29）
 *
 * ## 为什么要有这个文件
 *
 * 星图（`vendor/dsh-memory-nebula`）是另一个仓库、另一套版本节奏。它的工具**返回字符串**，
 * 不是结构化的 `{found:false}`，所以我们判断「连上了没有」「入图了没有」「这条还连得上吗」
 * 只能认字。认字本身没错，错的是把字散在三个文件里各写一遍：对面改一个词，三处各自静默退化，
 * 谁都不会报错，只有用户感觉「怎么老是排队」「怎么补连没动静」。
 *
 * 所以：每个字面量在这里出现一次、起一个名字，由 verify 拿名字去对 vendor 的源码
 * （`vendor/dsh-memory-nebula/lib/index.js`、`.../lib/host/nebula.js`）。
 * 对面一改词，断言先红，而不是等欠账堆起来才有人发现。
 *
 * ## 每条契约的原文出处
 *
 * | 常量 | 原文 | 出处 |
 * |---|---|---|
 * | `NODE_MISSING_MARK` | `星图里没有 id=${id} 的记忆。` | `lib/index.js` 的 `nebula_inspect` |
 * | `LINKED_MARK` | `已固化连线` | `lib/index.js` 的 `nebula_link` |
 * | `MISSING_PAIR_MARK` | `找不到这两条记忆：a / b` | `lib/host/nebula.js` 连线的 404 |
 * | `SELF_PAIR_MARK` | `不能把一条记忆和它自己配成一对：` | `lib/host/nebula.js` 自连检查 |
 * | `NOT_READY_MARK` | `这项能力还没就绪` | **我们自己的**（`bridge.js` 在工具未注册时抛） |
 * | `PATH_MISSING_NODES_MARK` | `找不到这两个节点：a / b` | `lib/host/nebula.js` 的 `path()`（解析不到节点） |
 * | `PATH_NOT_IN_GRAPH_MARK` | `节点不在当前星图里` | `lib/host/nebula.js` 的 `path()`（下标已失效） |
 * | `PATH_UNRELATED_MARK` | `没有关系就不编关系` | `lib/index.js` 的 `nebula_path`（**这是结论**，不是错误） |
 * | `PATH_ENGINE_STALE_MARK` | `还没带上路径搜索` | `lib/host/nebula.js` 的 `path()`（宿主跑旧代码） |
 * | `RECALL_EMPTY_GRAPH_MARK` | `星图里还没有节点（图是空的）` | `lib/index.js` 的 `nebula_recall`（0.2.39 的补丁） |
 * | `RECALL_NO_MATCH_MARK` | `星图里没有匹配` | `lib/index.js` 的 `nebula_recall`（**这是结论**） |
 * | `HYGIENE_EMPTY_GRAPH_MARK` | `这次体检等于没算` | `lib/index.js` 的 `nebula_hygiene`（0.2.40 的补丁） |
 * | `STATS_EMPTY_GRAPH_MARK` | `星图现在还是空的` | `lib/index.js` 的 `nebula_stats`（0.2.41 的补丁） |
 * | `INSPECT_EMPTY_GRAPH_MARK` | `这次 nebula_inspect 等于没算` | `lib/index.js` 的 `nebula_inspect`（0.2.42 的补丁） |
 * | `INSPECT_NOT_FOUND_MARK` | `这不等于「记忆没了」` | `lib/index.js` 的 `nebula_inspect`（**这是「没找到这一条」**） |
 * | `SOURCES_EMPTY_MARK` | `这句有两种意思` | `lib/index.js` 的 `nebula_sources`（0.2.43 的补丁） |
 * | `BRIDGE_EMPTY_MARK` | `这次没补到东西` | `lib/index.js` 的 `nebula_bridge`（0.2.44 的补丁） |
 * | `PATH_EMPTY_GRAPH_MARK` | `这次 nebula_path 等于没算` | `lib/index.js` 的 `nebula_path`（0.2.45 的补丁） |
 * | `SIMILAR_NOT_COMPUTED_MARK` | `相似检索没算成` | `vendor/meow-memory/lib/index.js` 的 `memory_find_similar`（0.2.46 的补丁） |
 * | `SIMILAR_NONE_MARK` | `这才是「记忆里没有相似的东西」` | 同上（**这是唯一允许出现的那句结论**） |
 * | `PROJECT_NAME_NOT_FOUND_MARK` | `这个名字在库里一条都对不上` | `vendor/meow-memory/lib/index.js` 的 `memory_project`（0.2.47 的补丁） |
 * | `PROJECT_OTHER_LAYERS_MARK` | `在别的层还有` | 同上（project 层空、别的层有） |
 * | `PROJECT_TRULY_EMPTY_MARK` | `这次是真没有` | 同上（**唯一允许把「这个项目没记忆」说出口的分支**） |
 * | `DREAM_NOTHING_MARK` | `没有需要整理的记忆（盘点过` | `vendor/meow-memory/lib/index.js` 的 `memory_dream` / `/dream`（0.2.48 的补丁） |
 * | `DREAM_BUSY_MARK` | `已经有一个 dream 在跑` | 同上（有记忆要整理，但租约被占） |
 * | `DREAM_NOT_STARTED_MARK` | `这次没启动成功` | 同上（消息没送进会话） |
 * | `UPDATE_NOTHING_MARK` | `这次什么都没改` | `vendor/meow-memory/lib/index.js` 的 `memory_update`（0.2.49 的补丁） |
 * | `UPDATE_PARTIAL_MARK` | `这是「部分生效」，不是全部` | 同上（写进去一部分，另有字段被过滤） |
 * | `UPDATE_NOT_FOUND_MARK` | `没有这个 id` | 同上（**唯一允许把「更新失败」说成「找不到」的分支**） |
 * | `REMEMBER_LEVEL_FALLBACK_MARK` | `这不是「按你说的层写好了」` | `vendor/meow-memory/lib/index.js` 的 `memory_remember`（0.2.50 的补丁） |
 * | `REMEMBER_DROPPED_MARK` | `这几个参数没生效` | 同上（字段给错了层，被过滤） |
 * | `REMEMBER_MERGED_MARK` | `这是「合并」，不是「新写一条」` | 同上（**唯一允许把这次写入说成「合并」的分支**） |
 * | `SEARCH_LEVEL_NONE_MARK` | `这次一条都没查：你给的层名` | `vendor/meow-memory/lib/index.js` 的 `memory_search`（0.2.51 的补丁） |
 * | `SEARCH_LEVEL_PARTIAL_MARK` | `这几个层名没生效` | 同上（一部分层名不认识，被静默丢掉） |
 * | `SEARCH_SCOPE_ONLY_MARK` | `这次只在` | 同上（层名都对但零命中：只在某几层里查过） |
 * | `SEARCH_NO_REPLY_MARK` | `检索这次没有任何回执` | **我们自己的**（`defs/search.js` 在本地检索拿回空串时兜底） |
 * | `READ_AMBIGUOUS_MARK` | `这个短 id 不止一条记忆` | `vendor/meow-memory/lib/index.js` 的 `memory_read`（0.2.52 的补丁） |
 * | `READ_NOT_FOUND_MARK` | `这个工作区里一条都没有` | 同上（拼错 / 位数不够 / 这条建在别的 cwd 工作区） |
 * | `READ_NO_REPLY_MARK` | `读取这次没有任何回执` | **我们自己的**（`defs/read.js` 在子插件一个字都不给时兜底） |
 * | `SIMILAR_AMBIGUOUS_MARK` | `相似检索这次一条都没比` | `vendor/meow-memory/lib/index.js` 的 `memory_find_similar`（0.2.53 的补丁） |
 * | `SIMILAR_NOT_FOUND_MARK` | `相似检索没起点` | 同上（基准 id 拼错 / 位数不够 / 这条建在别的 cwd 工作区） |
 *
 * 前四条看别人的脸色；最后一条是我们自己抛的，所以它其实是「内部约定」——
 * 但它同样只能认字（调用方拿到的就是一个字符串），放在一起才看得清全貌。
 */

/** 星图说「还没这条记忆」（新写入要等一轮建图才有节点）。 */
export const NODE_MISSING_MARK = '星图里没有'

/** 连线成功。 */
export const LINKED_MARK = '已固化连线'

/** 永久失败之一：要连的两条里有一条在星图里不存在。 */
export const MISSING_PAIR_MARK = '找不到这两条记忆'

/** 永久失败之二：拿一条记忆和它自己连。 */
export const SELF_PAIR_MARK = '不能把一条记忆和它自己配成一对'

/** 子插件还没把这个工具注册出来（bridge 抛的那句）。 */
export const NOT_READY_MARK = '这项能力还没就绪'

/**
 * `nebula_path` 的四句话（0.2.37）
 *
 * 这四个以前散在「不判断、原样转述」的路径里：`memory_link(action="path")` 直接把星图的话
 * 交给用户。问题是 `nebula_path` 对**完全不同的三件事**都在说「没连上」：
 *
 * | 星图原话 | 真实含义 | 用户该做的 |
 * |---|---|---|
 * | `找不到这两个节点：a / b` | 节点还没建进图（刚写完，12s 一轮巡检）或记忆真没了 | 等一轮再问 |
 * | `节点不在当前星图里` | 引擎解析过、但下标已失效（图正在重建） | 等一轮再问 |
 * | `这两条记忆在星图里没有连上（超过 6 跳）。没有关系就不编关系。` | **这就是答案**：确实没有关系 | 不用做什么 |
 * | `这个引擎版本还没带上路径搜索（等宿主重启后生效）` | 宿主跑的是旧代码 | 重启宿主 |
 *
 * 前两种字面上像「它们没关系」，但那是**还没算**，不是**算完了没关系**——
 * 和 0.2.30 那句 404 背两个意思是同一类坏法，只是换了个工具。
 */
export const PATH_MISSING_NODES_MARK = '找不到这两个节点'
export const PATH_NOT_IN_GRAPH_MARK = '节点不在当前星图里'
export const PATH_UNRELATED_MARK = '没有关系就不编关系'
export const PATH_ENGINE_STALE_MARK = '还没带上路径搜索'
/**
 * 0.2.45 补的一支：图是空的时候连 `resolveIds` 都无从谈起，
 * 原来那句会说成「这两条记忆在星图里没有连上」。图空着与「有关系/没关系」无关。
 */
export const PATH_EMPTY_GRAPH_MARK = '这次 nebula_path 等于没算'

/**
 * 把 `nebula_path` 的回答归类（0.2.37，0.2.45 补 emptyGraph 一支）。
 *
 * 只做一件事：把「还没算」与「算完了没关系」分开。顺序有意义——先认「没入图」，
 * 再看「没关系」；反过来的话，「找不到这两个节点…没有关系就不编关系」这种拼接文本
 * 会被判成结论，而它恰恰不是结论。
 *
 * `emptyGraph` 必须排在 `missing` 前面：图空时节点当然也解析不出来，
 * 但那时该说的是「还没建」，不是「这两条没入图」。
 */
export function pathAnswerKind(text) {
  const s = String(text ?? '')
  if (s.includes(PATH_ENGINE_STALE_MARK)) return 'engineStale'
  if (s.includes(PATH_EMPTY_GRAPH_MARK)) return 'emptyGraph'
  if (s.includes(PATH_MISSING_NODES_MARK) || s.includes(PATH_NOT_IN_GRAPH_MARK)) return 'missing'
  if (s.includes(PATH_UNRELATED_MARK)) return 'unrelated'
  return 'ok'
}

/**
 * `nebula_recall` 的空结果（0.2.39）
 *
 * 空命中本来只有一句话：`星图里没有匹配「q」的记忆。`——但这句也背两个意思：
 * 「图里确实没有」和「图还没建完 / 正空着」。重建期（12s 一轮巡检）搜什么都空，
 * 于是本地检索零命中 + 星图零命中，读者会当成「两边都确认没有」。
 *
 * 凭据是**图里一共有多少节点**（`recall.js` 补丁 `[macro-fusion 0.2.39]` 新增 `nodes`）。
 * 不能用 `scanned`：它是「算进候选的条数」，查询词一个都对不上时本来就是 0，
 * 拿它分辨等于把「真没有」也判成「没算」——`probe-graph` G10 现场抓到过这一错。
 *
 * | 星图原话 | 真实含义 | 用户该做的 |
 * |---|---|---|
 * | `星图里还没有节点（图是空的），这一问等于没算。` | 图还没建起来 | 等一轮，或先走本地检索 |
 * | `星图里没有匹配「q」的记忆（图里 N 条节点，一条都对不上）。` | **这是答案**：图里真没有 | 不用做什么 |
 */
export const RECALL_EMPTY_GRAPH_MARK = '星图里还没有节点（图是空的）'
export const RECALL_NO_MATCH_MARK = '星图里没有匹配'

/**
 * 把 `nebula_recall` 的空回答归类（0.2.39）。
 *
 * 「没算」先于「没有」——空图那句话里不含「没有匹配」，但顺序仍按道理写：
 * 判据的顺序应当读得出因果关系，而不是靠字符恰好不重叠。
 */
export function recallAnswerKind(text) {
  const s = String(text ?? '')
  if (s.includes(RECALL_EMPTY_GRAPH_MARK)) return 'emptyGraph'
  if (s.includes(RECALL_NO_MATCH_MARK)) return 'noMatch'
  return 'ok'
}

/**
 * `nebula_hygiene` 的空结果（0.2.40）
 *
 * 体检的抬头是「共 N 项」。图还没建起来的时候 N 也是 0，于是
 * **「一条毛病都没有」与「一条都没算」共用「共 0 项」**——而且它还比空检索更危险：
 * 检索空着，用户会怀疑；体检说「共 0 项」，用户会放心。
 *
 * 凭据只能是「图里有多少节点」（`nebula.graph.nodes.length`），因为 `h.total`
 * 数的是「查出多少毛病」，两种情况下都可能是 0。
 */
export const HYGIENE_EMPTY_GRAPH_MARK = '这次体检等于没算'

/**
 * 把 `nebula_hygiene` 的回答归类（0.2.40）。
 *
 * 只有两种：空图（没算）与正常（算过了，0 项就是真干净）。
 */
export function hygieneAnswerKind(text) {
  const s = String(text ?? '')
  if (s.includes(HYGIENE_EMPTY_GRAPH_MARK)) return 'emptyGraph'
  return 'ok'
}

/**
 * `nebula_stats` 的空图（0.2.41）
 *
 * 前四次都是「把没算说成没有或很干净」，方向是**让人放心**。这一次方向反过来：
 * 星图概况的第一行是「0 条记忆 / 0 条连接」，而「还没建起来」「来源读不出来」「真的一条都没有」
 * 三种情况都长这同一行。用户读到「0 条记忆」的第一反应是**记忆丢了**，然后去翻备份——
 * 比误以为干净更贵，因为恐慌会带来一串不该做的动作（还原、重灌、删库）。
 *
 * 凭据仍然是「图里有多少节点」，原因则从 `o.readErrors` 与 `o.sources` 里取：
 * 有读失败的来源就先说读失败，一个来源都没有就说没接上，其余说还没建完。
 */
export const STATS_EMPTY_GRAPH_MARK = '星图现在还是空的'

/**
 * 把 `nebula_stats` 的回答归类（0.2.41）。
 *
 * 只有两种：空图（原因已写在正文里）与正常。
 */
export function statsAnswerKind(text) {
  const s = String(text ?? '')
  if (s.includes(STATS_EMPTY_GRAPH_MARK)) return 'emptyGraph'
  return 'ok'
}

/**
 * `nebula_inspect` 的空结果（0.2.42）
 *
 * 这个工具的「没找到」比前几次更要紧——它不只被用户读，还被**我们自己读**：
 * `linkflow.graphState()` 靠它决定「这条记忆入图了没有」。原话是
 * `星图里没有 id=… 的记忆。可以先用 nebula_recall 搜一下。`，两种状态共用一句：
 *
 * | 星图原话 | 真实含义 | `graphState` 该返回 |
 * |---|---|---|
 * | `星图里还没有节点（图是空的），这次 nebula_inspect 等于没算…` | 图还没建起来 | `pending`（等一轮） |
 * | `星图里没有 id=… 的记忆。这不等于「记忆没了」：图里现有 N 条节点…` | 图里确实没有这一条 | `pending`（等一轮或 id 不对） |
 * | （正常正文） | 已入图 | `ready` |
 *
 * **判据的顺序在这里尤其重要**：空图那句话不含 `星图里没有`（是「还没有」），
 * 但如果哪天文案改成「星图里没有节点」，先认 missing 就会把「没算」当成「没这条」——
 * 两者对 `graphState` 都是 pending，可对**用户**完全不是一回事。
 */
export const INSPECT_EMPTY_GRAPH_MARK = '这次 nebula_inspect 等于没算'
export const INSPECT_NOT_FOUND_MARK = '这不等于「记忆没了」'

/** 把 `nebula_inspect` 的空回答归类（0.2.42）。「没算」先于「没找到」。 */
export function inspectAnswerKind(text) {
  const s = String(text ?? '')
  if (s.includes(INSPECT_EMPTY_GRAPH_MARK)) return 'emptyGraph'
  // 也认旧文案（`NODE_MISSING_MARK` = `星图里没有`）：vendor 没打补丁、或被上游升级冲掉时，
  // 我们拿到的还是那句老话——它该被当成「没找到这一条」，而不是「已入图」。
  // 判据不能只认自己写的新词，否则补丁一丢，这里就从 pending 静默变成 ready。
  if (s.includes(INSPECT_NOT_FOUND_MARK) || s.includes(NODE_MISSING_MARK)) return 'notFound'
  return 'ok'
}

/**
 * 来源体检（`nebula_sources`）的「0 个来源」也背两意（0.2.43）。
 *
 * | 回答 | 意思 |
 * |---|---|
 * | `已接入 0 个来源，共读到 0 条记忆——这句有两种意思：` | `emptyStores`：没接上（配置没建 / 探测关着 / 读失败），**不是**「记忆没了」 |
 * | 其余 | `ok`：正常报表 |
 *
 * 和 `stats` 的区别：那个是「图里 0 节点」，这个是「一个来源都没接」。
 * 两者都会被人读成「记忆丢了」，但原因完全不同——来源没接上时，图当然也是空的。
 */
export const SOURCES_EMPTY_MARK = '这句有两种意思'

/** 把 `nebula_sources` 的回答归类（0.2.43）。 */
export function sourcesAnswerKind(text) {
  const s = String(text ?? '')
  if (s.includes('已接入 0 个来源') && s.includes(SOURCES_EMPTY_MARK)) return 'emptyStores'
  return 'ok'
}

/**
 * 补邻居（`nebula_bridge`）的空结果也背两意（0.2.44）。
 *
 * 旧文案 `没有可补充的邻居（种子 0 条，候选 0 条都已读过或在冷却期）` 把
 * 「种子一条都没找到」说成了「都读过」——**没找到 ≠ 读过**。四种情况现在分开：
 * 图是空的 / 种子 0 条 / 有种子但邻居被过滤 / 有候选但进不了预算。
 *
 * 注意空图那支里含 `星图里还没有节点（图是空的）`，所以 `recallAnswerKind()`
 * 也会把它归成 `emptyGraph`——这是故意的：`defs/search.js` 的 bridge 模式
 * 靠这一句决定「要不要退本地检索兜底」，加了新词不能把兜底弄丢。
 */
export const BRIDGE_EMPTY_MARK = '这次没补到东西'
export const BRIDGE_NOT_EMPTY_MEMORY_MARK = '这不是「图里没有相关记忆」'

/** 把 `nebula_bridge` 的空回答归类（0.2.44）。 */
export function bridgeAnswerKind(text) {
  const s = String(text ?? '')
  if (s.includes(BRIDGE_EMPTY_MARK)) return 'empty'
  return 'ok'
}

/**
 * `memory_search(mode="similar")` 的空结果（0.2.46）。
 *
 * 为什么需要：`memory_find_similar` 的 render 原来在「一条都没有」时返回空数组，
 * 融合层只剩 `{"hits": []}`——`mode=similar` 这一支直接把这句话端给读者，
 * 于是一次**没算成**的检索读起来像「记忆里确实没有相似的东西」。
 *
 * 子插件补丁（`[macro-fusion 0.2.46]`）给了四种原因，前三种都是「没算」：
 *   ① 基准记忆没有可比较的词（内容全是符号/数字/停用词）
 *   ② 库里就只有这一条可比记忆
 *   ③ 候选都被过滤（本会话新写的 + 这一轮已看过的）
 *   ④ 真算过，候选之间词汇零重叠 —— 只有这一种才是「没有相似的东西」
 *
 * 判据只认①–③的同一句开头（`相似检索没算成`）和④的结论句。④的结论句单独成一个常量，
 * 因为它就是那个**唯一允许出现**的结论，别处出现即等于替用户确认了一件没算的事。
 */
export const SIMILAR_NOT_COMPUTED_MARK = '相似检索没算成'
export const SIMILAR_NONE_MARK = '这才是「记忆里没有相似的东西」'
// [macro-fusion 0.2.53] 基准本身没站住：短 id 撞车（一条都没比）/ 基准不在这个工作区。
export const SIMILAR_AMBIGUOUS_MARK = '相似检索这次一条都没比'
export const SIMILAR_NOT_FOUND_MARK = '相似检索没起点'

/** 把 `memory_search(mode="similar")` 的回答归类（0.2.46 建，0.2.53 补基准两种）。 */
export function similarAnswerKind(text) {
  const s = String(text ?? '')
  // 基准没站住比「算过了但没有相似」更靠前：撞车时那些「没算成 / 没有相似」的说法都不成立。
  if (s.includes(SIMILAR_AMBIGUOUS_MARK)) return 'ambiguous'
  if (s.includes(SIMILAR_NOT_FOUND_MARK)) return 'notFound'
  if (s.includes(SIMILAR_NOT_COMPUTED_MARK)) return 'notComputed'
  if (s.includes(SIMILAR_NONE_MARK)) return 'none'
  return 'ok'
}

/**
 * 项目全景（`memory_project`）的空回答（0.2.47）。
 *
 * 原来只有一句 `【项目：X】该项目暂无记忆条目。`，三种情况共用：
 *   ① 名字一条都对不上（拼错 / 大小写 / 中英混写）——这不是「这个项目没有记忆」
 *   ② 名字对得上，但 project 层六类子类与项目准则都空着，而 fact/lesson/topic 里还有 N 条
 *      ——全景段落是空的，不等于这个项目没东西
 *   ③ 七层表查过，project 字段正好写着这个名字的 active 条目是 0 条——只有这种才是结论
 *
 * `PROJECT_NAME_NOT_FOUND_MARK` 专门给①，因为①最容易让模型把「查无此名」当成「此项目无记忆」
 * 而去新建重复项目。
 */
export const PROJECT_NAME_NOT_FOUND_MARK = '这个名字在库里一条都对不上'
export const PROJECT_OTHER_LAYERS_MARK = '在别的层还有'
export const PROJECT_TRULY_EMPTY_MARK = '这次是真没有'

/** 把 `memory_project` 的空回答归类（0.2.47）。 */
export function projectAnswerKind(text) {
  const s = String(text ?? '')
  if (s.includes(PROJECT_NAME_NOT_FOUND_MARK)) return 'nameNotFound'
  if (s.includes(PROJECT_OTHER_LAYERS_MARK)) return 'otherLayers'
  if (s.includes(PROJECT_TRULY_EMPTY_MARK)) return 'empty'
  return 'ok'
}

/**
 * 整理任务（`memory_dream` / `/dream`）没启动时的四种原因（0.2.48）。
 *
 * `startWindowDream()` 的四个 `return false` 原来只回一个布尔值，调用方只好看「有没有 lease」猜，
 * 于是 `sendMemoryTurn()` 失败（消息没送进会话）被说成「本窗口没有需要整理的记忆」——
 * 一句话把「没送出去」说成「没东西」，谁看到都不会再试第二次。
 *
 * 三种「没启动」里只有 `noRounds` 是结论；`claimed`（已有 dream 在跑）与
 * `sendFailed`（消息没送到）都必须说「要整理的东西还在」。
 */
export const DREAM_NOTHING_MARK = '没有需要整理的记忆（盘点过'
export const DREAM_BUSY_MARK = '已经有一个 dream 在跑'
export const DREAM_NOT_STARTED_MARK = '这次没启动成功'

/** 把 `memory_dream` 的未启动回答归类（0.2.48）。 */
export function dreamAnswerKind(text) {
  const s = String(text ?? '')
  if (s.includes(DREAM_NOT_STARTED_MARK)) return 'notStarted'
  if (s.includes(DREAM_BUSY_MARK)) return 'busy'
  if (s.includes(DREAM_NOTHING_MARK)) return 'nothing'
  return 'ok'
}

/**
 * 改一条记忆的回执：三个布尔盖住五种情况（0.2.49）
 *
 * `memory_update` 的 execute 只回一个 `ok`。过滤是必要的——`goal` 只有 topic 层有、
 * `user`/`soul` 层没有项目归属、`content` 给空串不能整段清空——但过滤掉的字段原来
 * 一声不响：`patch` 空了 `ok` 仍然是 true，于是「一个字段都没写进去」被说成
 * 「✅ 已更新」。比没说更坏的是：调用方拿到肯定答复，就不会再检查。
 *
 * 所以三种「没改」都得自己说话，且只有真写进库（或只带真写进去的那几个字段）才配说已更新。
 */
export const UPDATE_NOTHING_MARK = '这次什么都没改'
export const UPDATE_PARTIAL_MARK = '这是「部分生效」，不是全部'
export const UPDATE_NOT_FOUND_MARK = '没有这个 id'

/** 把 `memory_update` 的回执归类（0.2.49）。 */
export function updateAnswerKind(text) {
  const s = String(text ?? '')
  if (s.includes(UPDATE_NOTHING_MARK)) return 'nothing'
  if (s.includes(UPDATE_PARTIAL_MARK)) return 'partial'
  if (s.includes(UPDATE_NOT_FOUND_MARK)) return 'notFound'
  return 'ok'
}

/**
 * 写一条记忆的回执：参数被改过、被丢掉，回执照样说「✅ 记忆已写入」（0.2.50）
 *
 * `memory_remember` 的七个参数里有六个会被悄悄纠正：
 *   ① `level` 写错（拼错、复数、中英混写）→ 直接落进 `fact`，回执只说 `✅ 记忆已写入（fact…）`
 *   ② `subcategory` 给到非 project 层 → 丢掉；给错值 → 也丢掉
 *   ③ `goal` 给到非 topic 层 → 丢掉
 *   ④ `corrected` 给到非 lesson 层 → 丢掉
 *   ⑤ `importance` 不是整数 → 四舍五入
 *   ⑥ 内容与已有条目 ≥80% 相似 → **并进旧条目**，原内容被替换
 *
 * ①最坏：记忆进了错层，之后按层看就永远找不到；⑥次之：读者以为多了一条，其实旧的那条被改写了。
 * 五种情况原来共用同一句「✅ 记忆已写入」，所以只有真的按原参数落库才配说已写入。
 */
export const REMEMBER_LEVEL_FALLBACK_MARK = '这不是「按你说的层写好了」'
export const REMEMBER_DROPPED_MARK = '这几个参数没生效'
export const REMEMBER_MERGED_MARK = '这是「合并」，不是「新写一条」'

/** 把 `memory_remember` 的回执归类（0.2.50）。 */
export function rememberAnswerKind(text) {
  const s = String(text ?? '')
  if (s.includes(REMEMBER_LEVEL_FALLBACK_MARK)) return 'levelFallback'
  if (s.includes(REMEMBER_DROPPED_MARK)) return 'dropped'
  if (s.includes(REMEMBER_MERGED_MARK)) return 'merged'
  return 'ok'
}

/**
 * `memory_search` 的 `level` 过滤（0.2.51）：层名写错时原来一声不响。
 *
 * `const levels = parsed.level.split(',').filter((s) => LEVELS.includes(s))` 看着温和，
 * 但「拼错 / 写复数 / 一个都不认识」时过滤后的数组是 **空的**——于是 `rows` 为空、`hits` 为空，
 * 回执只剩「如果冲突，以最新的为准」，读者自然把它读成「记忆里没有」。三种来路共用这句：
 *
 *   ① 全都不是层名（`level: "lessons"`）→ 一条都没查
 *   ② 一部分认识（`level: "fact,lessons"`）→ 只查了认识的，其余静默丢掉
 *   ③ 层名都对、但那几层零命中 → 只在某几层里查，别的层里的同关键词看不到
 *
 * ① 最坏：它把「层名没对上」卖成「没有这条记忆」，接着就会有人重复写一条。
 */
export const SEARCH_LEVEL_NONE_MARK = '这次一条都没查：你给的层名'
export const SEARCH_LEVEL_PARTIAL_MARK = '这几个层名没生效'
export const SEARCH_SCOPE_ONLY_MARK = '这次只在'
export const SEARCH_NO_REPLY_MARK = '检索这次没有任何回执'

/** 把 `memory_search` 的空结果归类（0.2.51）。 */
export function searchAnswerKind(text) {
  const s = String(text ?? '')
  if (s.includes(SEARCH_LEVEL_NONE_MARK)) return 'levelNone'
  if (s.includes(SEARCH_LEVEL_PARTIAL_MARK)) return 'levelPartial'
  if (s.includes(SEARCH_NO_REPLY_MARK)) return 'noReply'
  if (s.includes(SEARCH_SCOPE_ONLY_MARK)) return 'scopeOnly'
  return 'ok'
}

/**
 * `memory_read` 的「没读到」（0.2.52）。
 *
 * 原来读只有一句：`未找到该记忆。`，而短 id 撞车时更糟——`findById` 拿 LIKE 前缀
 * 撞到多条就**静默取第一条**（按 LEVELS 顺序跨表），回执写成「[fact] 标题（active）」，
 * 读起来像「你要的就是这条」。三种来路共用这一句/这一条：
 *
 *   ① 短 id 不止一条（跨层或跨条目）→ 替你挑了一条，而且不说
 *   ② 真没有：拼错 / 位数不够 / **这条记忆建在别的 cwd 工作区**（记忆库按工作区分库存）
 *   ③ 读到了（原来的正常路径）
 *
 * ① 最坏：它给的是别人（另一条记忆）的正文，却被当成你要的那条读下去。
 * 写路径 `memory_update` 早就会拒绝歧义，读路径比写路径松，两边口径就不统一了。
 */
export const READ_AMBIGUOUS_MARK = '这个短 id 不止一条记忆'
export const READ_NOT_FOUND_MARK = '这个工作区里一条都没有'
export const READ_NO_REPLY_MARK = '读取这次没有任何回执'

/** 把 `memory_read` 的结果归类（0.2.52）。 */
export function readAnswerKind(text) {
  const s = String(text ?? '')
  if (s.includes(READ_AMBIGUOUS_MARK)) return 'ambiguous'
  if (s.includes(READ_NOT_FOUND_MARK)) return 'notFound'
  if (s.includes(READ_NO_REPLY_MARK)) return 'noReply'
  return 'ok'
}

/**
 * `memory_find_similar` 的基准（0.2.53）。
 *
 * 它也要吃短 id，而且比 `memory_read` 更怕撞车：撞了之后不是「显示错了」，
 * 是**拿别人的正文当基准**去算相似度——分数、排序、命中全都错，而结果看起来完全正常。
 * 以前只有一句 `未找到记忆 <id>`，撞车时则一声不响（`findById` 取第一条）。
 * 这两个常量连同归类分支并进了上面 0.2.46 那个 `similarAnswerKind`（同一个工具只能有一个
 * 归类函数，否则模块里会「already been declared」）。
 */

