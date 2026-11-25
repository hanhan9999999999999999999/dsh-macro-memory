/**
 * macro-memory 的注入层：L0（每轮常驻的最小手册）+ L2（按需吐回的完整手册）。
 *
 * 设计：整段注入只有一处（section `macro-memory:guide`，order 130），
 * 内容 ≤ GUIDE_MAX_CHARS；详细手册（meow 的 system-guide 全文 + 星图规则）
 * 不在每轮注入，改由 memory_admin(action="guide") 按需取回 —— 省钱的核心。
 */

export const GUIDE_NAME = 'macro-memory:guide'
export const GUIDE_ORDER = 130
/**
 * [macro-fusion 0.2.130] 1300 → 1400。
 *
 * 加的是「回执没写全不等于没有」这句（回答准则）——它只在 system prompt 层起作用：
 * LoCoMo 1,193 题同题对照，同一句话挂在 system prompt 里 45.9%→54.2%，
 * 挂在回执里只值 +1.4pt（见 docs/INTERNAL.md 9.134）。而融合层把子插件的 section 全吞了，
 * 子插件 system-guide 里写的那句到不了模型眼前，只能由这段 L0 带过去。
 * 100 字符的代价留在常驻前缀里（缓存后边际成本近乎为 0），换的是整整 8 个点。
 */
export const GUIDE_MAX_CHARS = 1400
/** 上限之下要留的余量：低于这个数说明手册已经贴到边，该删句子了而不是等它被截。 */
export const GUIDE_MIN_HEADROOM = 120
/** 真的超上限时的收尾——截断必须自己说出来，而且必须把「去哪看全文」留住。 */
export const GUIDE_TAIL_MARK = '…（已按上限截断，完整手册见 memory_admin(action="guide")）'

export const GUIDE_TEXT = `【宏记忆 macro-memory】跨会话记忆与记忆星图由 macro-memory 统一提供：memory_* 工具管条目，星图管条目之间的关联（跨会话、跨工作区已验证的连线）。不必再找别的记忆插件。

level（每条都要）：soul=AI 自身 / user=用户与设备环境 / rules=准则 / fact=原子事实 / lesson=经验教训 / topic=一件事的来龙去脉 / project=项目（子类 overview|structure|decisions|quotes|ops|todo）。

memory_remember（content、project、keywords、importance 必填）：keywords 给 8–13 个，按「用户提到哪些词时该召回它」反过来想；importance 4=红线致命 3=主人强调 2=抽象决策 1=琐碎；已有相近条目先 memory_update，或把旧的标 stale/archived，别堆重复。写入时可用 links=[邻居 id] 顺手把关联固化进星图。
memory_update（id, …）：改内容/状态/关键词/归属，status=active|stale|archived。
memory_search（query, budget）：默认本地检索；expand=true 沿星图扩散；mode=graph|bridge 走关联，mode=similar 找相似；memory_project 看项目全景；memory_read（id, neighbors=12, budget）连邻居一起读——预算不够先砍邻居、正文一字不截、砍到底只给骨架。回执够大自带成本尾注（≈N token）；想省上下文就给 budget=N，五路都吃（本地/星图/补邻居/相似/读），工具自己砍并交代砍了什么。
memory_link（action=link|unlink|mute|unmute|path）：path 看两条记忆怎么连上的；mute 断掉错的关联（重建也不会再连）；写记忆时没连上的连线会排队，读记忆时自动补；排队欠账用 memory_admin(action="links") 看，按理由分组。
整理：memory_dream。运维与体检：memory_admin（action=home|stats|hygiene|sources|ingest|cost|inject|budget|suspect|snapshot|dream|links|guide）。

纪律：一条一事、保持最新；冲突以时间戳最新者为准；注入的记忆可能无关或过时，发现就更新它。回执没写全≠没有：只提到一部分也给最可能答案，完全无关才说不记得（回执层只值 +1.4pt，这一层值 +8.3pt）。三面都在：工具 / 命令（/dream、/meow-trust）/ 面板（宏记忆、宏记忆 · 星图）。完整手册见 memory_admin(action="guide")。`

/**
 * L2 手册的「门牌」：融合之后用户能碰到的三面——工具、命令、面板。
 *
 * 命令名（`/dream`、`/meow-trust`）是 vendor 实际注册的名字，这里硬编码但由 verify A14 与
 * `vendor/meow-memory/lib/index.js` 交叉核对：vendor 改名而这里没跟，脚本会红，手册不会说谎。
 * 为什么不把命令改成 `/macro-dream` 之类更整齐的名字：用户敲字的习惯比整齐值钱，改名的收益
 * 远小于「昨天还在用的命令今天不见了」的代价。
 */
export const NAV_TEXT = `宏记忆有三个面，工具只是其中之一：①工具——8 个 memory_*，下面这本手册讲的就是它们；②命令——用户自己敲的 /dream（手动唤起一次记忆整理）与 /meow-trust（信任当前工作区自带的记忆库）；③面板——设置里的「宏记忆」，以及独立的「宏记忆 · 星图」。融合之后这三面一件都没少；命令名沿用 vendor 的注册名，没为了整齐去改它。`

/**
 * 把注入文本压到上限内。
 *
 * 以前是「超了就在行边界切一刀」——切完什么也没说：模型以为手册就这么多，
 * 而最可能被切掉的恰恰是最后那行「完整手册见 memory_admin(action="guide")」。
 * 现在截断必须带尾巴：既承认被截了，又把去哪看全文留住；尾巴本身也算在上限里。
 */
/**
 * 注入上限的唯一出口：把配置里那个 `guideMaxChars` 解析成「这次真的按多少字算」，
 * 并带上「改过就要说话」的那句话。
 *
 * [macro-fusion 0.2.63] 以前先把 maxChars 塞进 Number()，再用「不是有限数就用 0」兜底：
 * 配置写错一个字（`guideMaxChars: "4k"`、`-5`、`null`）都会被读成 0，
 * 而 0 在这条路上等于**整段 L0 注入变成空串**——插件最显眼的那段东西消失了，
 * 日志、面板、回执一个字都不说。这不是「上限很严」，是「配置错了但看起来像没配」。
 *
 * 语义按「能不能照办」分：
 *   - 缺省 / 空串 → 默认值，不吭声
 *   - 非数字     → 回默认，说明给的是什么（绝不落成 0）
 *   - 负数       → 回默认，说明上限没有「从后往前数」
 *   - 0          → **照办 0**（明确不要注入），但要说清「不是手册空了」
 *   - 非整数     → 抹掉小数，说明少掉的那半字不是你给的条件
 *   - 太小       → 照办，但说明连「被截断了」的尾巴都放不下、注入没有指路
 */
export function guideBudget(raw) {
  if (raw === undefined || raw === null || raw === '') return { value: GUIDE_MAX_CHARS, note: '' }
  const n = Number(raw)
  if (!Number.isFinite(n)) {
    return {
      value: GUIDE_MAX_CHARS,
      note: `guideMaxChars 给的是「${String(raw)}」，不是数字——这次按默认 ${GUIDE_MAX_CHARS} 字算，不是你给的那个（注入没有变成空的）。`,
    }
  }
  if (n < 0) {
    return {
      value: GUIDE_MAX_CHARS,
      note: `guideMaxChars 给的是「${n}」，是负数——上限没有「从后往前数」这回事，这次按默认 ${GUIDE_MAX_CHARS} 字算。`,
    }
  }
  if (n === 0) {
    return { value: 0, note: 'guideMaxChars 给的是 0，这次一个字都不注入——不是「手册空了」，是你把上限设成了 0。' }
  }
  const whole = Math.floor(n)
  if (whole !== n) {
    return { value: whole, note: `guideMaxChars 给的是「${n}」，上限只能是整数，这次按 ${whole} 字算——少掉的那半字不是你给的条件。` }
  }
  if (whole <= GUIDE_TAIL_MARK.length) {
    return {
      value: whole,
      note: `guideMaxChars 给的是 ${whole}，连「被截断了，完整手册见 …」这句尾巴都放不下——注入只剩硬切的前 ${whole} 字，没有指路。`,
    }
  }
  return { value: whole, note: '' }
}

export function clampGuide(text = GUIDE_TEXT, maxChars = GUIDE_MAX_CHARS) {
  const t = String(text)
  const cap = guideBudget(maxChars).value
  if (t.length <= cap) return t
  // 上限小到连一句「被截断了」都放不下时，只能硬切——但绝不返回空串以外的东西假装完整。
  if (cap <= GUIDE_TAIL_MARK.length) return t.slice(0, cap)
  const budget = cap - GUIDE_TAIL_MARK.length - 1
  const cut = t.slice(0, budget)
  const line = cut.lastIndexOf('\n')
  const head = line > budget * 0.6 ? cut.slice(0, line) : cut
  return `${head}\n${GUIDE_TAIL_MARK}`
}

/**
 * L2 按需手册：直接复用两个子插件自己产出的注入原文（不复制、不改写），
 * 所以 memory_admin(action="guide") 吐出来的永远和 vendor 一致。
 */
export function buildFullGuide(bridge) {
  const parts = []
  for (const item of bridge.promptDeclarations()) {
    const text = resolveDeclText(item?.decl?.text)
    if (typeof text === 'string' && text.trim().length > 0) {
      const title = item.vendor === 'nebula' ? '星图规则' : '记忆手册'
      parts.push(`## ${title} — ${String(item.decl?.name ?? '')}\n\n${text.trim()}`)
    }
  }
  if (parts.length === 0) return '（子插件尚未提供手册：可能还没装配完成，或对应功能被关闭。）'
  return parts.join('\n\n---\n\n')
}

function resolveDeclText(text) {
  try {
    return typeof text === 'function' ? text() : text
  } catch {
    return undefined
  }
}
