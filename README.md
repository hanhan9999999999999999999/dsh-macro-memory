# 宏记忆 · Macro Memory

> 一个记忆插件，接管全部记忆能力：**8 个工具、一段 1,176 字符的常驻注入**，主库仍是 meow 的七层 SQLite，星图退成可重建的索引。
>
> 适用：DeepSeek Harness（DSH）。版本 **0.2.124** · 许可 MIT · 内置 meow-memory 与 dsh-memory-nebula 的完整副本（均为 MIT，见[第三方声明](#第三方声明与来源)）。

| 指标 | 融合前（三插件并存） | 现在（0.2.124） | 变化 |
| --- | --- | --- | --- |
| 工具 schema 合计 | 17 个工具 / 56,759 B | **8 个工具 / 11,697 B** | **−79.4%** |
| 常驻注入 | 4,085 字符（meow 3,396 + nebula 689） | **1,176 字符（1 段）** | **−71.2%** |
| 每轮固定开销 | 约 14–16K token | **约 2.2K token** | **−85%** |
| 面板 / 工具来源 | 三个插件各一套 | 一个插件两个面板 | 口径统一 |

---

## 目录

- [它解决什么问题](#它解决什么问题)
- [它是怎么搭起来的](#它是怎么搭起来的)
- [记忆怎么工作](#记忆怎么工作)
- [省 token 的账怎么算](#省-token-的账怎么算)
- [8 个工具](#8-个工具)
- [安装](#安装)
- [设置与热应用](#设置与热应用)
- [兼容与迁移](#兼容与迁移)
- [质量：怎么证明它没坏](#质量怎么证明它没坏)
- [目录结构](#目录结构)
- [第三方声明与来源](#第三方声明与来源)
- [English](#english)

---

## 它解决什么问题

记忆插件通常各干各的：一个存长期记忆、一个建关系图谱、一个做性格画像。装三套的代价不是磁盘，是**每一轮都要重付的上下文税**：

1. **工具 schema 税**：每个工具的参数说明都进请求前缀。三个插件 17 个工具，光 schema 就 56,759 B，约 14–16K token，占每轮固定开销八成以上——用户还没说话，钱已经花掉了。
2. **注入税**：每个插件都想在 system prompt 里讲一段「怎么用我」。三段叠加 4,085 字符，而且各自都写「先调用我」。
3. **口径税**：面板里三个名字、工具里两套命名、日志里三种前缀。模型照着 A 插件的注入去调 B 插件的工具，拿到「工具不存在」，接着开始乱试。

宏记忆的做法是**把工具面和注入面收上来**：两个引擎（meow 的记忆库、nebula 的星图）退到后面当内核，对外只有一套 8 个 `memory_*` 工具和一段注入。能力一条没砍，重的是壳，不是功能。

## 它是怎么搭起来的

![架构](docs/images/architecture.png)

三层，从上往下：

- **表面层（本插件）**：`lib/index.js` 装配 8 个统一工具 + 一段常驻注入 + 一张设置页；所有对外文案、品牌名、错误措辞都在这一层（`lib/macro/`）。
- **融合层**：`bridge` 负责「叫得动引擎、叫不动就说人话」；`linkflow` 负责写记忆时连不上星图的连线**不丢**（排队补连）；`brand` 负责把引擎输出里的旧工具名翻成新名字。
- **引擎层**：`vendor/meow-memory`（主库：七层 SQLite + 梦境巩固 + 反射）+ `vendor/dsh-memory-nebula`（索引：节点/边/强弱/枢纽），两者都在 `vendor/` 里带完整副本，随本包一起走，**不依赖用户另外安装**。

关键取舍：**主库只有一份，星图可以重建**。七层表有 `status`/`importance`/`keywords` 语义，星图节点只有 id 和文本；星图丢了能全量重建，主库丢一条就永远丢。所以写路径先落主库，再尽力更新星图，失败就排队。

## 记忆怎么工作

![记忆流](docs/images/memory-flow.png)

### 写入

```
memory_remember(content, level, project, keywords, importance, links)
  ├─ 落主库（.dsh-meow/memory.db，七层之一）
  ├─ 尽力把关联节点写进星图（links）
  └─ 连不上 → 落 $DSH_HOME/macro-memory/pending-links.jsonl 排队（上限 500、TTL 7 天）
```

`links` 失败**不会**让这次写入失败，也不会静默丢掉：进队列，之后任意一次 `memory_search` / `memory_read` / `memory_link` / `memory_admin` 顺手补连（节流 30s、预算 1.2s、单轮最多 8 条、星图整体不可用时立刻停手）。用户在 `memory_admin(action="links")` 里能看到「谁在等谁、等了多久、为什么没连上」。

### 读取

```
memory_search(query, mode=local|graph|bridge|similar)
  ├─ local：主库关键词检索（importance × 时间衰减）
  ├─ graph：沿星图关联扩散
  ├─ bridge：强相关但还没读过的邻居
  └─ similar：给一条记忆，找相似的
```

参数给错模式会**明说没生效**（「你给的 `expand` 在 graph 模式里没用上，扩散请用 graph」），不会先跑一遍别的检索再让你误读结果。

### 巩固

`memory_dream` 把本窗口建立/提取过的记忆封存成跨会话记忆，按七层归档，顺手补连线。梦境任务空转时只做巡检，不刷日志。

整理时还会挑出**疑似冲突**：同一主题（关键词至少共用两个）却写着不同的数字或版本，典型是「DSH 在 C 盘」对「已搬到 D 盘」。这类不合并、也不自动改——系统只把两条摆在一起，点名谁更新、各自独有什么，判决留给读的那一方。措辞不同而数字一致的算复述、归档的那条算已处置，都不报；账里同时记计数与明细，所以「这一轮没查到」和「这一版没查过」在面板上是两句话。

冲突块还会**认老账**：展开时会往回翻十来条更早的账，看这一对报过没有——新撞上的标「这一轮新报」，报过多次的写「之前报过（最早第 N 轮，加这次共 k 次）」，连报三次还挂着的会在明细后面点名催处置。报过没报过是两件事：一个是发现，一个是欠账。更早的账读不出来时一个字都不说，不拿「没读」冒充「新报」。

### 注入

每轮常驻的只有一段 1,176 字符的 L0（怎么用、有条目怎么找、没条目怎么办），**不随对话变化**——这是 prompt 缓存能命中的前提。真正的内容靠工具按需拉：变化的东西不进 system prompt 前缀。

## 省 token 的账怎么算

![token 账](docs/images/token-budget.png)

| 项 | 融合前 | 现在 | 说明 |
| --- | --- | --- | --- |
| 工具 schema | 56,759 B（17 个） | **11,697 B（8 个）** | `tools/probe-host.mjs` 实测 D2 判据 |
| 常驻注入 | 4,085 字符 | **1,176 字符** | 同一支探针 E2 判据，上限 1,300 |
| 旧工具名残留在注入里 | 有（`nebula_recall` 等） | **0** | E4 判据 |
| 别名工具 | — | 默认关闭 | 打开后 19 个工具，供老会话/老脚本过渡 |

按 JSON schema 约 3.9 B/token 折算：**每轮少付约 1.2 万 token**。会话越长越赚——这部分是**固定开销**，第 1 轮和第 200 轮一样要付。

省 token 的三刀，按收益排序：

1. **砍工具面**（17 → 8，−79.4%）：合并同义工具，`mode` 用一个枚举代替四个工具。
2. **压注入**（4,085 → 1,176 字符，−71.2%）：只留「怎么用 + 没找到怎么办」，全文手册改成 `memory_admin(action="guide")` 按需取，用完即弃。
3. **禁掉每轮自动邻域注入**（nebula 原来每轮把邻居关系塞进 prompt）：改成工具按需拉（`memory_search({mode:"graph"|"bridge"})`）。

## 8 个工具

| 工具 | 干什么 | 关键参数 |
| --- | --- | --- |
| `memory_remember` | 写一条记忆 | `content` / `level` / `project` / `keywords` / `importance` / `links` |
| `memory_search` | 检索（四种模式） | `query` / `mode` / `k` / `limit` / `expand` / `id` / `memory_ids` |
| `memory_read` | 读一条（连邻居一起带出） | `id` / `neighbors` |
| `memory_update` | 改内容/状态/关键词/归属 | `id` / `content` / `status` / `keywords` / `importance` / `project` / `links` |
| `memory_project` | 一个项目的全景 | `project` |
| `memory_link` | 星图连线：连/断/屏蔽/解释路径 | `action` / `a` / `b` / `note` / `maxHops` |
| `memory_dream` | 记忆整理（封存本窗口） | — |
| `memory_admin` | 运维面板 | `action` = home/stats/hygiene/sources/ingest/cost/links/guide |

七层：`soul`（AI 自身）/ `user`（用户与环境）/ `rules`（准则）/ `fact`（原子事实）/ `lesson`（经验）/ `topic`（一件事的来龙去脉）/ `project`（项目，含 overview/structure/decisions/quotes/ops/todo）。

## 安装

### 从插件市场

DSH → 设置 → 插件市场 → 索引源填本仓库的索引地址：

```
https://raw.githubusercontent.com/hanhan9999999999999999999/dsh-macro-memory/main/plugin-market/index.json
```

索引是 [格式 1](https://github.com/deepseek-ai/deepseek-harness) 的 JSON（`plugin-market/index.json`，随包校验：`tools/check-market.mjs`）。

国内网络拉不到 `raw.githubusercontent.com` 时，把索引源换成镜像（`plugin-market/index.cn.json`：与主索引逐字段相同，只有仓库地址带反代前缀，钉同一个 commit）：

```
https://gh-proxy.com/https:/raw.githubusercontent.com/hanhan9999999999999999999/dsh-macro-memory/main/plugin-market/index.cn.json
```

实测（2026-11-19，本机）：`raw.githubusercontent.com` / `cdn.jsdelivr.net` / `cdn.statically.io` 直连全部失败；`gh-proxy.com` 取索引 1.9 s、取图标 3.4 s。市场安装要 `git clone`，直连 GitHub 300 s 超时，走反代 23 s 拉完 164 个文件、checkout 到钉住的 commit 成功。

> 反代地址里的内层协议只写一个斜杠（`https:/github.com/...`）不是笔误：宿主校验 git 源时要求 `new URL(v).href === v`，写成 `https://` 会被压成 `/https://` 而被判「不是规范 URL」。

### 手动

```bash
# 1) 放进 vendor（或任意路径），装进 profile
cd <DSH_HOME>/vendor
git clone <THIS_REPO> dsh-macro-memory

# 2) profile 里登记（file: 协议，pnpm 不会在 install 时删掉它）
#    profiles/<名字>/package.json → dependencies
#    "dsh-macro-memory": "file:D:/dsh-home/vendor/dsh-macro-memory"

# 3) 只留一条 bundle
#    profiles/<名字>/cordis.patch.yml
- insert:
    - id: macro-memory
      name: 'dsh-macro-memory'
      config:
        homeDir: dsh-storage
        reflectTurns: 5
        promptLang: zh
        nebula: {}
```

**必须关掉原来的 `meow-memory` 与 `dsh-memory-nebula`**：本包 `vendor/` 里是它们的内核，再装原包会重复注册工具与客户端 UI。

重启 DSH 生效（不是刷新页面）。

## 设置与热应用

设置页的每一个字段都真能写，而且**写完就生效**：

| 改的是谁 | 生效方式 | 要重启吗 |
| --- | --- | --- |
| 融合层四键（`compatAliases` / `guideMaxChars` / `toolWaitMs` / `flushThrottleMs`） | 150ms 去抖后重建工具面与注入 | 不用 |
| 引擎字段（`hitTopK` / `reflectTurns` / `homeDir` / `dream` …） | 拆掉那只引擎重挂，再重建表面 | 不用重启进程，但扫描从头开始 |
| `nebula` 段 | 同上，只重挂星图 | 同上 |

一个坑写在这里省别人一轮：宿主给的配置是 **volatile 引用**，引擎只认普通对象——把引用直接喂给引擎，它装不起来却不报错，只会表现成「工具都不见了」。所以引擎永远拿 `resolveConfig()` 解包后的普通对象。

## 兼容与迁移

- **老配置形状**：`config.meow.{…}` 旧写法仍然认（根字段覆盖），启动时打一句 warn 点名哪些键被盖住。
- **老注入消息**：注入来源 `kind` 从 `plugin:meow-memory` 改成 `plugin:macro-memory`，但老值仍认得（`LEGACY_PLUGIN_KINDS`）。历史会话里的折叠、锚点、重放不受影响——`kind` 是数据契约，不是装饰。
- **老工具名**：默认不注册 `nebula_*` / `memory_find_similar` / `memory_home`；需要时把 `compatAliases` 打开（19 个工具）。引擎输出里出现的旧名字会被翻成新名字，**返回的记忆原文一个字不改**。
- **不改用户数据**：`.dsh/sessions` 里的历史消息不改写；旧库目录不搬，切 `homeDir` 只切指针。

## 质量：怎么证明它没坏

```bash
node tools/check-all.mjs          # 21 支自检，2,460 条断言，168s
node verify.mjs                   # 单支：宿主契约 + 浏览器装配
node tools/doctor.mjs             # 体检：两棵树字节一致、加载面、注入长度、队列、账本
```

- **21 支自检 / 2,460 条断言**，全部可执行，覆盖：宿主装配契约、真 vendor 端到端联动（含星图缺席降级）、真 meow 库 + 真 nebula 引擎的节点/边/生命周期、真 cordis + 真 ToolsService + 真 SystemPrompt、浏览器侧 UI 注册、17 个原工具 → 8 个统一工具的参数级覆盖审计、17 个原工具的清单与字面量体积、工具账本（每个脚本有归属）、口径总账（手册/schema 常量/对外文案同源）、召回校准（相关度优先 + 重要度进分数 + 相关度下限 min_rel）、合并账本（关键词并集 / 归属不搬 / 变短默认不换 / overwrite 才换）、跨层重复（写时点名另一层 / 检索折叠逐字级重复 / dedupe: false 看全量）、相似检索（基准与候选同一把尺子 / 本会话刚写的也算候选 / 端过的不再端）、两把尺子（相似度 cosine 与逐字重复度 Jaccard 并报 / 与写侧合并判据同源 / 长文嵌一句要点名）、记忆体检口径（「相似 N」是稀有词签名估算、判「同一句存两层」看 repeat、两把尺子靠一句口径说明指路）、dream 重复对（整理清单里点名逐字重复的对子 / 没对子一个字不加 / 短 id 在清单内互不撞前缀）、dream 跨轮次重复（同一句话一条 fact 一条 topic 也点名 / 一对只说一次 / 半边标「另一组」并说清怎么处置）、dream 重复详写（短摘录 + 长详写也算同一件事 / 覆盖度 ≥90% 且短条至少 8 个词 / 与逐字重复块互斥不重复点）、dream 合并处方（每个重复详写对下面点名短条里长条没有的词、最多 6 个 / 无损时明说「没有长条之外的词」/ 三把尺子各管一段：重复合并、相似不许合并）、dream 整理留痕（回执先说这一轮看到几轮几条 / 几对逐字重复 / 几对重复详写 / 几个词要补；收尾把同一份数字写进 dream_log 的 changes.plan 与 summary；念完即清 meta，下一轮读不到旧账）、整理留痕面板（`memory_admin(action="dream")` 照账本念，不现算；没工作区 / 还没建库 / 库读不开 / 账本为空四种来路各说各话；0.2.96 之前的老记录明说「比 0.2.96 早」，不冒充有规模）、整理走向（每条账带 `#k` 序号与「落库 是/否」，末尾一行趋势给最近几次的重复对/缺词合计与「在变多/在变少/持平」；可用记录不到 2 条不出这一行，不到 4 条自带「样本太少别当走势」，老记录跳过时点明几条没参与），都含阴性对照、整理中那一轮（dream 正在跑时面板第一行就报这一轮多大——规模读的是 `dreamdigest`，不是账本；不给这轮编 `#k`、也不进趋势；只有 lease 活着才算「进行中」，lease 一放掉第一行立刻消失；只有 lease 没有摘要就说「规模还没落 meta」，不拿当前清单现算；SSE 的 `dreaming` 事件同时带上这份规模，老消费方只认 `state` 照样工作）、整理留痕的翻页与单条展开（账本长了要能翻：`page` 从 1 起、编号「第几近」跨页连续、总数来自 `COUNT(*)` 不是本页条数、页越界退到最后一页并说清；`id` 摊开某一条的摘要 / 备注 / `changes` 原文，超长截断并报真实长度，老记录明说没有规模，坏行只说读不出来不拿摘要凑；`page`/`id` 给脏了当面打回，不静默退回默认；趋势与「整理进行中」只在第 1 页出）、账本按项目段翻账（`changes.plan.projects` 以前只被数了个数：第 1 页没筛时多一行「项目段：Alpha 3 次 · Beta 1 次」，只列前 5 个并说「还有 N 个没列」；`project=` 筛在 SQL 里做（`json_valid` + `json_each`），页面与总数共用一个筛子，坏行不许算成匹配、也不许带崩整本账；筛着时不再给分布、编号明说「是筛出来这几条里的第几近，不是全账本序号」，导航写「共 M 条（项目段「X」）」；筛空说「账本里没有项目段「X」的整理记录（全账本 N 条）」而不是「账本还是空的」，并点明项目名要按原样写；展开时补一句属于/不属于这个项目段，编号仍是全账本第几近；`project` 给成长句当面打回；写侧存名字不存个数——`changes.plan.projects` 从 0.2.102 起是真名字（trim / 去空 / 去重保序），个数另存 `projectCount`，老账本照个数念而不念成 0；`changes.plan.pairs` 把「跟谁撞了」也落账（短 id 与整理清单同一套，能直接 `memory_read` / `memory_update`；`cover` 带「合并会丢哪几个词」），一条账最多存 6 对明细，而「这一轮共几对」是真数不被上限截断；老账本「有数无明细」与「真没撞上」分开说）、账本记库规模（开工那一刻按层数一遍 `status = 'active'` 的条数，写进 `changes.plan.store`：只数在用、零层不写进 JSON、收尾不再数；面板展开多一行「库规模：开工时 N 条在用（fact 1 · lesson 1 · topic 1）」，老账明说「它写在 0.2.103 之前」且不许念成「0 条在用」，没有 plan 的账不再叠一层告示；趋势行给「库 开工时 2 → 3 条（多了 1 条）」，至少两次有数才敢讲，缺的几次单独提示「库规模只有 K 次有数」；探针 L9–L11 用真库验写侧数字、D37–D39 验面板真念，含「老账不补 0」「无 plan 不叠告示」两条阴性对照）、账本行的稳定引用（`#k` 是位置、会随新账往下挪，`r<N>` 是这一行自己的号：`dream_log.id` 是 AUTOINCREMENT，只增不减、删了也不复用，所以 `r128` 永远指同一轮整理——面板每行末尾印 `· 引用 r<N>`（老账行也印，否则最早的几轮永远回指不了），第 1 页只说一次「要回指就用 `id=r<N>`，`#k` 只是此刻排第几」；`id=r128` 按引用展开，正文照账念、另起一段说「它现在排第 K 近」，引用打不开时明说「这个号从来不会发给新账」并给按位置找 / 按内容搜两条路；「第几近」那条路也顺手回一句引用，省一次翻列表；`dreamRankOf` 与账本列表共用一把尺子（`run_at` 相同再比 id），否则引用和编号会静默指向不同的行；探针 L12–L14 用真 writer 验「再跑一轮：第几近 1→2 而 `runAt` 不变」，D40–D42 验面板真念，含「ref=0 不猜行」「每页都印提示」两条阴性对照）、账本按日期筛（`run_at` 是毫秒、人说的是日期，中间这座桥现在有了：`since` / `until` 写 `"2026-11-18"` 这种日期，**闭区间**——当天 `00:00:00.000` 与 `23:59:59.999` 都算在内，前 1 毫秒后 1 毫秒都在外；**本机时区**——按 `new Date(y, mo-1, d, …)` 解并回读年月日校验，绝不用 `Date.parse`（那是 UTC，东八区整体错 8 小时），`2026-02-31` 这种被 JS 滚到下个月的写法当面打回「这种写法不敢猜」；**行与总数同一把筛子**——筛留在 SQL 里，`recentDreamsPage` 与 `dreamCountOf` 共用一份 `parts`，否则翻页漏条、条数虚高；`since > until` 也打回，且打回发生在第一次读库之前。筛空时说「这段时间里没有整理记录——账本覆盖 A → B（本机时区 UTC+08:00）」并报「全账本 N 条都在这个区间外面」，不把「这段里没有」说成「账本里没有」；展开一条时补一句它不在区间里（写在几点），引用照旧展开、明说「日期筛选也不影响引用」；只按项目筛时老句式一字不变，日期是加上去的一层。探针 L15–L17 直接插 `run_at` 量边界与覆盖范围，D43–D45 验面板真念，含「旧账不混进来」「坏日期一次库都不查」两条阴性对照）、账本记整理前后的库规模（只念开工那一眼，永远算不出「这一轮让库变轻还是变重」：`finalizeDream` 收尾时再数一次 `dreamStoreScale(db)` 落进 `changes.plan.storeEnd`，并算出 `storeDelta = 收尾 - 开工`，只在两个点都有数时才算——老账没这一格就不猜，不拿 `NaN` 或负数当 0；收尾数只能在写侧取，面板渲染时库早变了，重算出来的是「看账那一刻」而不是「整理结束那一刻」；落库日志补 `store=A->B`，`summary` 上就能对账；面板展开念「库规模：开工时 2 条在用（fact 1 · topic 1） → 收尾 3 条在用（fact 2 · lesson 1），比开工多 1 条」，老账只念开工一眼、不编收尾也不补 0；差与因分开写成两句——`storeDelta` 是「库变了多少」，`stamped` 才是「这一轮封存/完结几条」，口径句明说这一点；趋势行补「收尾净增/净减 N 条（K 次有收尾数）」，缺收尾数的账不参与合计但要说几次；文案上把两层括号叠在一起的 `（fact 1）（-2）` 改成「层数进括号、差进句尾」，趋势 caveat 也改用破折号。探针 L18–L20 真开工→中途加两条归档一条→两次 `advanceDream` 真收尾（`store=2->3`、`delta=1` 是净变化不是新写条数、归档层不进收尾层数、老账两个字段都是 `undefined`），D46–D48 验面板真念，含「只有开工数不编收尾」「不叠两层括号」两条阴性对照）、账本分清收尾方式（以前只记「这行摘要怎么写」、记不住「这件事怎么结束的」：`window dream (done|aborted):` 里那一个词既是数据也是文案，`changes` 里没这一格；`groups` 只有分子没分母，「走了 1 组」说不出本来几组；补记账被念成「这条记录比 0.2.96 早」；连续失败止损封存只写调试日志、账本上等于没发生过。现在写侧落结构化 `changes.kind` 五态：`done` / `aborted`（带 `groupsDone` + `groupsTotal`，摘要印 `groups=1/2`）/ `recovered`（带 `groupsDone`）/ `gaveup`（带 `fails`）/ `sealed`（带 `fails`，首次进账本），`groupsDone` 取 `groupsCount - 1` 因为 `abortDream` 传的是「进行到第几组」；分母必须在 `finishDream` 删 `dreamplan` 之前读（收尾动作自己就把账要吃的数据删了）；`sealed` 与 `dream-debug.log` 两处都写、不互相替代（一个给排查、一个给回看）。读侧 `kindOf` 优先认 `changes.kind`（`stored: true`），认不出才退回摘要首词并明说「这一格是认出来的」，缺值是 `null` 不是 0（「走了 0 组」是假话）；`reasonOf` 跳过 `(interrupted)` / `(turn-failed)` 修饰语；行上与展开各念自己的话（`走了 1/2 组就停下`、`收尾方式：连续失败已封存（连续失败 3 次）`），只有真老账才念「比 0.2.96 早」，没跑完的轮在规模段与对子段两处改口；趋势与「比更早一条」只吃跑完的一轮（半轮的 `dup/cover/missing` 是扫到那儿的中间值，加进合计等于把半张成绩单当满分算），趋势另说「K 次没跑完，不进合计」，比对遇到半轮只回「数字不可比」。探针 L21–L24 用真引擎验四种收尾——`sealed` / `gaveup` 都先 `touchWindow` 钉住 `last_event_time`，否则 `recordDreamFailure` 每轮凭 `Date.now()` 开新范围、失败次数永远从 1 重数；D49–D53 + D11b 验面板真念，含「补记账不冒充老账」「半轮不比数字」两条阴性对照）、层走向（总条数的净变化只说「库重了多少」，说不出「哪一层在膨胀」：fact 一直涨、topic 一直掉，总分可能是 0 而库的结构在烂——一轮把 2 条 topic 降成 fact、lesson 掉一条、fact 涨两条，账本念「比开工多 0 条」，读的人松一口气。现在每轮收尾时的 `storeEnd.byLevel` 摊成一条走向：只认收尾层数（0.2.103～0.2.105 只有开工数，拿它占位等于把整理前的库贴到整理后的位置上，图整齐但全是假的）、写侧零层不写进 `byLevel` 所以「写了却没有那一层」= 那轮那层 0 条在用（缺 ≠ 没记，这句写进口径）、只吃跑完的轮（半轮的层数是扫到那儿的中间值）；每层念 `fact 2 → 3 → 3（+1）`／`topic 0 → 1 → 2（+2）`／`lesson 1 → 1 → 1（没变）`，按变化幅度排序只列 4 层（多的说「还有 N 层没列」），结论分涨/掉/都没变三支——没涨就不许编「涨得最多的是 fact（+0）」，那是把噪声讲成走势；少于两轮不出（一次是快照，不是走向），只在第 1 页出（它说的就是最近这几条）。探针 L25–L26 验写侧尺子按 `status='active'` 数、归档立刻掉出、零层不出现（两条 fact 的内容与关键词要刻意错开，否则写侧去重会把它们并成一条），D54–D57 验面板真念，含「单轮不出」「每层没变就说没变」两条阴性对照）、回执成本与预算（以前只说「查到了什么」、从不说「这一趟花了多少」，于是省 token 全靠调用方猜 `k`——给多了怕漏、给少了怕不够，最后总是给多：回执够大（≥500 token）时代价自带一行「≈N token（CJK 一字算 1、其余 4 字符算 1，是量级不是账单）」，1200 token 以上才缀「只想看骨架就加 budget=400」，小回执一个字不加；`budget=N` 让工具自己收紧——**先砍每条的字**（`content_max` 减半到 60）、**再砍条数**（`k` 减半到 1），每级都真改参数重查而不是截字符串（截断等于把一条记忆拦腰砍断，读者看到一句没有下半句的话，工具还说「收紧了」，那是骗人），装下就交代「收紧了 N 次、k A→B、content_max A→B」，四级之后仍装不下就**真取一次** `k=1、content_max=60` 的最小一份并写「实测」，不拿第四级的估计冒充最小；收紧排在星图段之前（顺序反了等于把邻居段落加在预算外，尾注说「按 400 收紧了」而回执仍超），星图退回本地兜底的两条路也照收；预算四态分开说（没给静默 / 不是数字 / 小于 80 / 超过 20000 按 20000 算），**给了却没生效绝不静默**，星图 / 相似两路明确说「体量由引擎的 limit / chars 决定，这次没缩」。探针 L27–L28 钉估算口径与预算四态（含可复算），D58–D61 钉出口收敛与「装不下」两条阴性对照）、预算贯通四路（`budget` 从「本地检索的参数」升级成「这次回执的约束」：本地先砍 `content_max` 再砍 `k`、星图先砍 `limit` 再砍 `hops`、补邻居先砍 `chars` 再砍 `limit`、相似先砍 `content_max` 再砍 `k`，顺序都是「先动只是少看一点细节的，再动真会少看到东西的」；预算传进来是对象，入口先摊成数字再比——拿对象比恒 false，会一路滑到「装不下」还印出「预算 [object Object]」；只报真动过的旋钮（`hops 2→2` 等于谎言），报「最小」之前把所有旋钮压到下限再量一次；本地 `expand` 的扩散段按 `remain = budget - 本地那一段`算，剩余不够就不拿并告诉读者两条出路；尾注不再声称「只有本地能收紧」。探针 D62–D66 钉四路各自收哪个旋钮与「装不下要量到下限」，D61 改成「没给预算就不缩也不说废话」两条阴性对照）、项目走向（层走向只说「哪一层在涨」，说不出「是谁在涨」：Alpha 加 3 条、Beta 删 3 条，fact 的净数没变，层走向念「fact 没变」而实际上一个项目在长肉、另一个在被清空——所以按项目再摊一条走向：只数带项目归属的 5 层（`project` / `fact` / `lesson` / `topic` / `rules` 有 `project` 列，`soul` / `user` 只有 `COMMON_COLS` 没这一格，口径句里明说，免得读者拿总条数一减以为 soul 的条目丢了）、跨层同名相加（读者问「这个项目多大」，不是「它的 fact 多大」）、NULL 与空串不算一个项目（否则每个全局条目都变成一个叫 `null` 的项目）、一个项目都没有时整格不写（空对象落进 JSON 会被读成「数过，零个项目」）、只认收尾那一刻的 `storeEnd.byProject`（0.2.111 之前的账没有这一格就不进走向，不补 0 让线看起来连续）、名字按写入时原样存所以改过名的会算成两行（口径句明说，不偷偷猜改名）、三支结论涨/掉/都没变——没涨就不许编「涨得最多的是 Alpha（+0）」，那是把噪声讲成走势。探针 L29–L31 用真库验跨层相加、全「全局」库不出现空名、归档后整个键消失，D67–D70 验面板真念，含「单轮不出」「每个项目都没变就说没变」两条阴性对照）、读也吃预算（read 是唯一一支回执里带「caller 点名要的东西」的工具，所以它不能像别的工具那样砍内容：正文一个字节都不截，能缩的只有邻居**条数**——给了 `budget` 就先从你要的条数往下试 6 / 3 / 1 / 0，每档都真取一次真量一次（估算与真实体量之间没有稳定比例，最多试三档，且绝不超过你自己要的数），装下就写「邻居 12→6 条才装下」；一条邻居都砍光了还装不下，就只给**骨架**：正文第一行（≤120 字）+ 缺口与三条出路（正文共多少字≈多少 token / 你给的预算是多少 / 把 budget 提到 ≥ 体量，或者先 `memory_search` 看摘要挑一条），因为「截一半给你」比「不给你」更坏——读者会把半条当成全文；连骨架那一行都超预算时再加一句「连上面那一行标题都超过你给的预算了」，宁可超几点 token 也不让形态被误认。尾注自己也要装进预算：砍过邻居必须交代（优先于预算），没砍就只在装得下时才加这一行；`budget` 给的不是数字或比 80 还小时照不限额给，但那句话一定带出来。探针 D71–D77 钉骨架不调星图、砍邻居真发生、装得下只问一次、`neighbors=0` 不问星图，含「非数字照给不限额」与「骨架那行也超预算」两条阴性对照）、项目走向的时间信息（净差只说「变了多少」，说不出「第几次才冒出来、哪一轮归零」：`Alpha 3 → 4 → 6（+3）` 里看不出它是第三次才出现、也看不出 Beta 从第二次起就没了——所以每个项目多两句点名，`firstLive` 找第一个大于 0 的位置念「第 N 次起有数，现在 M 条」（第一格就有数的是「一直在」，不许当新出现；数组下标 0 要换成人读的第 1 次），`lastLive` 倒着找最后一个大于 0 的位置，若它后面还有格子就念「第 N 次是最后的数：M 条」——报最后一次的数，不重复写「现在 0 条」；两类各最多点 3 个，多的写「还有 N 个没列」，两种同时出现时补一句「一存一失如果条数对得上，很可能只是改名——这条走向不替你猜，要确认就翻那一轮的账看项目段名字」，因为改名与「清空一个另起一个」在条数上一模一样，区别只在内容；序列本身也要省——`compactSeq` 在超过六轮（`SEQ_HEAD 2 + SEQ_TAIL 3 + 1`）时折成「头 2 … 尾 3」，阈值卡在「折一次至少省掉两个数」，否则省略号比它省下来的还长，折了几次必须报数（`序列太长，中间 3 次用 … 省略`），不然省略号会被读成「这几次没数」；顺序固定为抬头 → 序列 → 涨/掉/都没变 → 新出现 → 消失 → 改名线索，caveats 另起（还有 N 个项目没列 → 折了几次 → 没跑完的轮 → 常驻口径），先「看到了什么」再「没看到什么」。探针 D78–D82 验八轮折叠、新出现点名、消失点名、改名提示三要素，含「平稳走向不加戏」阴性对照）、疑似冲突（关键词至少共用两个而数字/版本不同 / 不合并不自动改 / 计数与明细分开 / 0 与没查分开）、冲突跨轮追踪（往回翻十条账认老账 / 新报与重提分开 / 连报三次点名催处置 / 读不到就不表态）、冲突去向（上一轮报的、这一轮不报了——已归档 / 正文改过 / 查不到 / 两条都没动过四种去向分开说，一次只摊三对）、取代关系（写新的同时把被顶掉的旧的降格：`memory_remember` 加 `supersedes`，旧条目只标 stale + 正文留一句「（已被取代：<新 id>「<新内容前 24 字>」，日期）」，不删、还读得到、可改回 active；找不到 / 已归档 / 已标过 / 短 id 多命中 / 写库失败五种「像成功」的失败各说一句，一次最多 5 条、超出的原样报回）、检索融合（本地检索与星图扩散两路名次合成一张榜 RRF k=60：同一条只占一个位置、三种来路分开说、两路都命中的排最前；本地命中带全文、星图独有只带「为什么相关」+ 摘要；截断报「另有 N 条没展开」；预算紧时先砍星图独有那几条；本地零命中 / 星图回执解析不出 / 预算装不下都退回原来的两段式，不硬凑半张榜）、注入体、加载器判据、组合产物、YAML 接线、市场索引、体检。
- **断言数基线**：`tools/baselines.json` 记每支的 PASS 条数——少了判红（有人删了东西），多了只提醒。
- **耗时预算**：每支 4×实测且不低于 30s，超时 SIGKILL；比基线慢 1.5 倍只提醒不判红（慢不等于坏）。
- **vendor 账本**：`vendor/VENDOR.json` 记两棵 vendor 树的文件数/字节/整树指纹，改过没重记就 FAIL；另有 89 条「我们故意打的补丁还在位」的内容断言。
- **阴性对照**：每轮都先把判据打红一次再还原，证明判据不是纸做的。

## 目录结构

```
lib/
  index.js            唯一入口：Config（平铺 volatile）、装配、热应用
  client.js           浏览器侧产物（build.mjs 从两个 vendor client 拼出）
  macro/
    bridge.js         收下与转调（createBridge / errText / wrapPlugin）
    facade.js         三个 Proxy：ctx.tools / ctx.systemPrompt / 最外层
    render.js         纯函数出文本，零 import
    tools.js          8 个统一工具的装配器
    defs/             一个工具一个文件（remember/search/read/update/project/link/dream/admin）
    linkflow.js       待补连线队列（排队、节流、补连、判永久失败）
    brand.js          名字级改口（不改返回正文）
    prompt.js         L0 注入文本 + 完整手册
    store.js          唯一碰 node:fs 与 DSH_HOME 的地方
    cost.js / links.js / shared.js / panel.js
vendor/
  meow-memory/        主库内核（MIT，见第三方声明）
  dsh-memory-nebula/  星图内核（MIT）
tools/                自检与探针（15 支 + 账本/体检）
plugin-market/        市场索引（格式 1）
DESIGN.md             设计取舍与教训（内部）
docs/                 INTERNAL.md 逐轮开发日志、images/ 配图
```

## 第三方声明与来源

本包 **MIT** 许可（见 [LICENSE](LICENSE)）。

内置两份第三方代码，均为 MIT，完整许可原文随包保留：

| 组件 | 来源 | 许可 | 说明 |
| --- | --- | --- | --- |
| `meow-memory@0.32.8` | [Phant0Meow/dsh-meow-memory](https://github.com/Phant0Meow/dsh-meow-memory) | MIT © 2026 Phant0Meow | 主库内核：七层 SQLite、梦境巩固、反射。`vendor/meow-memory/LICENSE` 为其原文 |
| `dsh-memory-nebula@1.11.74` | 本仓库作者 | MIT © 2026 主人 & 小代码酱 | 星图内核。`vendor/dsh-memory-nebula/LICENSE` |

改动说明（MIT 要求「显著修改需说明」，逐条记在 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)）：

- meow：注入消息的来源 `kind` 改为 `plugin:macro-memory`（老值仍认）；设置页文案与热应用说明改写；其余内核逻辑未改。
- nebula：`systemPrompt.context` 恒返回一条稳定 RULE（移除每轮自动邻域注入）；`recall` 过滤归档节点；工具归因表统一到 `plugin:macro-memory`。

两棵 vendor 树的可核指纹在 `vendor/VENDOR.json`，任何人都能验证「这是一份改了哪几处的副本，而不是另写的东西」。

## English

**Macro Memory** (DSH plugin, MIT) folds several memory plugins into one surface: **8 tools + a single 1,176-character standing injection**, while the storage engine stays meow-memory's seven-layer SQLite and the graph becomes a rebuildable index.

- Tool schemas: 17 tools / 56,759 B → **8 tools / 11,697 B** (−79.4%).
- Standing prompt: 4,085 chars → **1,176 chars** (−71.2%).
- Per-turn fixed cost: ~14–16K → **~2.2K tokens**.
- Nothing was dropped: every original tool is reachable through the unified surface (audited by `tools/coverage-audit.mjs` and `tools/param-audit.mjs`).
- Writes land in the main store first; graph links that cannot be written are **queued, not lost** (500 entries, 7-day TTL, auto-flushed).
- 21 self-check scripts / 2,198 assertions / `node tools/check-all.mjs`.

Bundled third-party code is MIT: `meow-memory` © 2026 Phant0Meow ([source](https://github.com/Phant0Meow/dsh-meow-memory)), `dsh-memory-nebula` © 2026 the authors. See `THIRD-PARTY-NOTICES.md` for the exact list of modifications.

---

<sub>内部开发日志（0.1.x 起逐轮记录，含每次事故与判据）在 [docs/INTERNAL.md](docs/INTERNAL.md)；设计取舍在 [DESIGN.md](DESIGN.md)。`lib/client.js` 为构建产物：163,239 B，sha256 `2F546AA8…`。</sub>
