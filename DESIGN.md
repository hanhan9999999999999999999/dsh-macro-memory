# dsh-macro-memory 设计方案

> 写于 2026-11-18 深夜，交接给下一个会话。
> 读者设定：已经会改 DSH 插件、看得懂 cordis、不需要再解释「什么是记忆插件」。
> 前置文档（按顺序读，别跳）：
> 1. `D:\document\DSH Memory Macro-Regulation System\meow-memory-彻底剖析.md`（10,385 行，meow 内部机理）
> 2. `D:\document\DSH Memory Macro-Regulation System\meow-memory-改造就绪手册.md`（构建链逐字配方、改动面地图）
> 3. `D:\dsh-home\vendor\dsh-macro-memory\README.md`（当前这个壳怎么拼起来的）

---

## 0. 一句话现状

两套插件已经被装进同一个壳 `dsh-macro-memory` 里**并排运行**（`ctx.plugin` 各自独立 fiber，vendor 副本原样承载，原两个包一字节未动）。
它们现在**互不知道对方存在**：两套工具名、两套注入、两份存储、两张图。壳只负责"一起启动"，不负责"一起思考"。

这一阶段是有意为之——主人要求「先不要融合，就是拼到一起」。本文档定义**下一步怎么真的融合**，以及为什么那样融合能省钱。

---

## 1. 现状盘点：缺点什么

### 1.1 结构（现在的样子）

```
                    ┌──────────────────────────────────────────┐
   宿主 ctx ────────▶│ dsh-macro-memory  lib/index.js (组合器)   │
                    │   ctx.plugin(Meow)   ctx.plugin(Nebula)  │
                    └────────┬──────────────────────┬──────────┘
                             │                      │
              ┌──────────────▼─────────┐  ┌─────────▼──────────────┐
              │ vendor/meow-memory     │  │ vendor/dsh-memory-nebula│
              │ 8 工具 memory_*        │  │ 9 工具 nebula_*         │
              │ systemPrompt order 130 │  │ systemPrompt order 960  │
              │ SQLite (.dsh-meow)     │  │ 星图 JSON (memory-nebula)│
              │ 首轮注入全文记忆       │  │ 每轮注入 RULE + 邻域     │
              └────────────────────────┘  └─────────────────────────┘
                   ▲                                    │
                   └───────── adapters/meow.js ─────────┘
                        （nebula 只读 meow 库当数据源）
```

关键事实：**依赖是单向的**。nebula 有 `lib/host/adapters/meow.js`（11,374 B）能读 meow 的 SQLite；meow 完全不知道 nebula 存在。这一点决定了后面 D1（主库选谁）。

### 1.2 成本现状（全部实测，非估算）

| 组成 | 体积 | 何时发送 | 缓存友好度 |
|---|---|---|---|
| meow 8 个工具 schema | **35,866 B**（35.0 KB，工厂返回字面量实测） | 每次请求 | 稳定 → 可命中 |
| nebula 9 个工具 schema | **20,893 B**（20.4 KB，`tools.register` 字面量实测） | 每次请求 | 稳定 → 可命中 |
| meow 手册 `system-guide.md` | **3,396 字符**，`order: 130`（`lib/index.js:4883`） | 每次请求 | 稳定 → 可命中 |
| nebula 常驻 `RULE` | **689 字符**，`order: 960`（`lib/index.js:36-45`, `:603-604`） | 每次请求 | 稳定 → 可命中 |
| nebula 邻域补充 | ≤900 字符/批 × 最多 2 批 = **≤1,800 字符** | 每轮（节流后） | **每轮内容不同 → 打碎前缀缓存** |
| meow 首轮快照 | ~700 字符（随库增长；当前 soul 0 / user 283 / 全局 rules 241） | 会话首轮 | 稳定 |
| 工具返回（检索/召回正文） | 不定 | 调用时 | 尾部，不伤前缀 |

**稳态固定税 ≈ 17–19 K token/请求**（工具 schema 字面量合计 **56,759 B / 55.4 KB**，按混合中英 3.5–4 字符/token 粗估 **14–16 K token**，加注入约 3 K），其中约 **84% 是 17 个工具的 JSON schema**。单是 meow 的 8 个工具（35.0 KB）就比 nebula 的 9 个（20.4 KB）更贵——`memory_search` 一个就 9,384 B。
用户原话（m01738）：「这个插件的目的就是上位平替所有记忆插件 还有可视化记忆神经网络；要达到的最终目的就是给agent记忆 **并且极致省钱省token**」。

→ 省 token 的第一刀不在注入文本上（注入才 4 K 字符），**在工具面（17 → 8）**。
→ 第二刀在**注入位置**：nebula 把每轮变化的内容塞进 system prompt（`order: 960`），等于每轮把整个前缀缓存废掉。动态内容必须挪出前缀。

实测脚本（可直接跑，输出现状数字）：

```powershell
node D:\dsh-home\vendor\dsh-macro-memory\tools\cost-baseline.mjs
node D:\dsh-home\vendor\dsh-macro-memory\tools\probe-toolsize.mjs
```

### 1.3 四个结构性问题

| # | 问题 | 后果 |
|---|---|---|
| P1 | 注入双写：meow guide（130）+ nebula RULE（960）各讲一套用法 | 模型要在两套术语间切换，4 K 字符里约 30% 是重复的"该怎么用" |
| P2 | 工具面重复：`memory_search` 与 `nebula_recall` 语义重叠；`memory_read` 与 `nebula_inspect` 重叠；`nebula_path`/`nebula_stats`/`nebula_hygiene` 三个诊断工具 | 17 个 schema 每次都发；模型选错工具的概率上升 |
| P3 | 星图**不含 meow 自己的节点**：nebula 把 meow 当 adapter 数据源，但 meow 的记忆没有边 | "可视化记忆神经网络"只画出了半张网 |
| P4 | 没有成本可见性：谁花了多少 token、注入占多大比例，全黑箱 | 无法验证"极致省钱"是否做到，也无法回归 |

---

## 2. 目标与不变量

### 2.1 五个目标（一句话版）

1. **一套存储** —— 记忆只有一处真相（canonical），另一处是可重建的索引。
2. **一套工具** —— 对外 8 个动词，内部路由到两套引擎。
3. **一份注入** —— system prompt 里只有一个记忆段落，且**只放稳定内容**。
4. **一张图** —— meow 的记忆就是星图节点，nebula 算出的边就是边，一张网。
5. **一本账** —— 每轮注入/调用/整理花了多少，落盘可查、可回归。

### 2.2 不变量（改坏了就是事故）

- **I1 原两个包只读**：`node_modules\meow-memory` 与 `node_modules\dsh-memory-nebula` 一字节不动，随时能回滚到独立加载。
- **I2 用户记忆不可丢**：任何迁移前先 `Copy-Item` 整库备份到 `D:\备份\<ts>-macro-migrate\`；SQLite 用 `.backup`，不要 `Copy-Item` 正在写的 WAL 库。
- **I3 降级即透明**：星图坏掉/未建好时，检索必须退回纯 BM25 并**照常返回结果**，不许抛错。
- **I4 注入可关**：`config.inject.enabled=false` 时插件仍能工作（只是不主动喂上下文）。
- **I5 幂等**：重复 `remember` 同内容仍走 DEDUP_THRESHOLD=0.8 合并（`vendor/meow-memory/lib/index.js:2322`），不许因统一层产生重复条目。
- **I6 可回滚到拼接态**：每个 M 阶段都有 `package.json` + `cordis.patch.yml` 的备份与还原脚本。
- **I7 不动 DSH 进程**：所有验证用独立 node 进程 + stub，绝不重启主人的 DSH（红线）。
- **I8 术语不倒退**：七层（soul/user/project/fact/lesson/topic/rules）与六子类（overview/structure/decisions/quotes/ops/todo）保持不变，这是主人用熟的。

---

## 3. 目标架构

### 3.1 四层

```
┌──────────────────────────────────────────────────────────────┐
│ Surface（对外）  memory_* 8 个工具 · 设置页 · 折叠条 · 星图面板 │
├──────────────────────────────────────────────────────────────┤
│ Policy（决策）   InjectionPolicy · ToolRouter · Budget          │
│                  决定「这一轮该喂什么、喂多少、放哪里」          │
├──────────────────────────────────────────────────────────────┤
│ Index（索引）    Graph：节点=记忆，边=关联，可完全重建          │
├──────────────────────────────────────────────────────────────┤
│ Kernel（内核）   Store：七层 SQLite = 唯一真相                  │
└──────────────────────────────────────────────────────────────┘
        ▲ 依赖方向单一：上层依赖下层，Kernel 不知道任何人
```

和现状的差别：现在是「两个平行业务插件」，目标是「一个内核 + 一层索引 + 一层策略 + 一层外壳」。**Kernel 与 Index 仍然是 meow 与 nebula 的代码**——我们不重写它们，只重新安排它们的角色。

### 3.2 三条数据流

**写路径**
```
memory_remember → Kernel.write(层, 内容) → 返回 id
                                    └→ Index.touch(id)    （标脏，异步增量重建）
```

**读路径**
```
memory_search(query) ─┬→ Kernel.bm25(query)      → 候选集 A（0.5–0.8 ms）
                      └→ Index.diffuse(query)    → 候选集 B（带边证据）
                          ↓ 合并打分 score = 0.6·bm25 + 0.4·edgeWeight，去重
                        返回：正文 + 为什么被带出来（边缘证据）
```

**注入路径（关键）**
```
每轮 systemPrompt：
  ┌ 稳定层 L0（永远不变，缓存友好）───────────────────────────┐
  │ 一段合并后的用法说明（≤1,200 字符，替掉 guide+RULE 的 4,085）│
  └───────────────────────────────────────────────────────────┘
  ┌ 会话层 L1（只在首轮，或记忆有变化时）──────────────────────┐
  │ 差分快照：soul + user + 全局 rules + 项目名 + (新增/变更条目)│
  └───────────────────────────────────────────────────────────┘
动态层 L2（邻域补充 / 相关记忆）：**不进 system prompt**
  → 出现在 memory_search 的返回里，作为「顺带读到的」段落
```

**这一条是整个方案省钱的核心**：把每轮变化的 1,800 字符从 system prompt 挪进工具返回，前缀从"每轮变"变成"整会话不变"，缓存命中率从 ~0 变成 ~100%。

### 3.3 八个统一工具（17 → 8）

| 新工具 | 合并了谁 | 关键参数 | 备注 ||---|---|---|---|
| `memory_remember` | meow 同名 | content / project / level / subcategory / keywords / importance / **links[]** | `links` 是新增：写完顺手连边 |
| `memory_search` | meow `memory_search` + nebula `nebula_recall` + `nebula_bridge` + `memory_find_similar` | query / level / project / k / **mode**(local/graph/bridge/similar) / **expand**(bool) / memory_ids[] / **similarTo**(id) | `mode` 缺省 local（走 meow 主库）；`expand=true` 或零命中时追加星图扩散段；`mode="similar"` 等价 `memory_find_similar(similarTo)` |
| `memory_read` | meow `memory_read` + nebula `nebula_inspect` | id / **neighbors**(bool, 默认 true) | 单条 + 邻居 + 每条边的证据 |
| `memory_link` | nebula `nebula_link` + `nebula_path` | action(link/unlink/mute/unmute/path) / a / b | `action="path"` 走最短证据链 |
| `memory_update` | meow 同名 | id / content / importance / status / project / keywords | status: active/stale/archived |
| `memory_project` | meow 同名 | project | 项目全景（六子类分组注入段） |
| `memory_dream` | meow 同名 | （无参） | 整理/封存 |
| `memory_admin` | meow `memory_home` + nebula `nebula_stats`/`nebula_hygiene`/`nebula_sources`/`nebula_ingest` | action(home/stats/hygiene/sources/ingest/cost) | 运维面收进一个口 |

**兼容别名**：`nebula_*` 与 `memory_find_similar` 默认**不注册**（省 schema），配置 `compatAliases: true` 时以一句话描述重新注册。默认关，因为模型看到 17 个工具时选择成本高。

> **实施偏离（2026-11-18 深夜，已落地）**：`similarTo` 没有放进 `memory_project`，而是以
> `memory_search({ mode: "similar", similarTo: "id" })` 的形式提供。理由：「找相似」本质是一次检索，
> 放在检索口才可能被模型自然发现；`memory_project` 的语义是「取某个项目的全景」，塞进一个检索
> 参数会让它的返回结构有两种形态（全景文本 vs 相似列表），违背「一个工具一个形态」。
> 代价：`memory_search` 的多了一个 `mode` 枚举，schema 涨约 130 B。

端口示意（`lib/index.js` 未来形态）：

```js
export const name = 'macro-memory'
export const inject = []
export function apply(ctx, config) {
  const kernel = createKernel(ctx, config)      // 挂 meow 的 store/tools（不注册 systemPrompt）
  const index  = createIndex(ctx, config)       // 挂 nebula 的 graph（不注册 systemPrompt）
  const policy = createPolicy({ kernel, index, config })
  mountSurface(ctx, { kernel, index, policy })  // 8 个统一工具 + 一个 systemPrompt 段
}
```

---

## 4. 关键决策（含为什么不选另一条）

### D1 主库 = meow 的七层 SQLite；星图 = 可重建索引
**理由**：① nebula 已经有 `adapters/meow.js` 能读 meow 库，反向不存在——顺着已有依赖走成本最低；② 七层表有 `status`/`importance`/`keywords` 等语义，星图节点只有 id+文本，表达力弱；③ 星图可以全量重建（`LiveEngine.ensure()` 就是干这个的），主库丢一条就永远丢了。
**被否**：以星图为真相（nebula 存储格式是 JSON/图缓存，无事务、无去重语义）。

### D2 工具面收敛到 8 个，默认不注册 17 个旧名
**理由**：17 个 schema 实测 56,759 B（55.4 KB）≈ 14–16 K token，占固定税约 84%。且 `memory_search`/`nebula_recall` 语义重叠会诱发选错工具。
**代价**：外部脚本或旧习惯调 `nebula_*` 会失效 → 用 `compatAliases` 兜。

### D3 注入单点：system prompt 里只留一段 ≤1,200 字符的稳定说明
现状 `meow guide 3,396 + nebula RULE 689 = 4,085`，其中重复的"该怎么用"约 1,200 字符。合并后目标 1,200。
**三条实现路线（M1 的 spike 要选一条）**：

| 路线 | 做法 | 风险 | 我倾向 |
|---|---|---|---|
| A. Proxy ctx | 给 `Meow.apply/apply` 传包装 ctx，拦截 `systemPrompt.context/section` 与 `tools.register` | cordis 内部可能按对象身份比较；需 `bind` 原对象 | 先试，改动最小 |
| B. 改 vendor 三行 | vendor 副本是我们自己的，把注入包 `if (!globalThis.__MACRO_POLICY__)` | 侵入 vendor，升级 vendor 时要重打 | 备选 |
| C. 配置关 | nebula `inject.json` 设 `maxRounds: 0`（只剩 689 字符 RULE）；meow guide 无开关 | 只能减一半，做不到合并 | 保底 |

**验收**：system prompt 里记忆段落字符数 ≤1,300；两套文档不再各说一套。

### D4 注入分三层（L0 稳定 / L1 差分 / L2 按需）
- L0：常量字符串，整会话不变 → 100% 可缓存。
- L1：首轮全量，之后只讲**增量**（新写入、被更新的条目），没变化就一个字符都不发。
- L2：不进 prompt，走工具返回。
**理由**：缓存按前缀算，只要前缀稳，重复部分几乎免费。

### D5 邻域注入默认关（`maxRounds: 0`），改由 `memory_search(expand:true)` 承担
**理由**：用户真正需要"顺带读到的邻居"的时刻，是他已经在查记忆的时候；不需要每轮无脑塞。这条单改配置就能生效，**不改一行代码**，是 M1 里最先落地、可立刻量化的收益。

### D6 星图节点统一：meow 的每条记忆 = 一个节点
现状 nebula 通过 adapter 读到 meow 记忆，但只在**召回时**用，节点身份可能用 `provider:uid` 拼。要统一成 `ws:level:id` 的规范 id，让 3D 页面能同时画 meow 节点与 nebula 自有节点。
**风险**：id 规范一改，历史边全废 → 需要一次性重建（`LiveEngine.ensure()` 可重算），并保留旧 id 的别名映射。

### D7 成本账本落盘：`$DSH_HOME/macro-memory/cost.jsonl`
每轮一行：`{ts, session, promptChars:{l0,l1,tools}, injectedIds, toolCalls, dreamChars}`。
**理由**：没有账就没法回答"到底省了多少"，也没法设回归阈值。

### D8 一切改动留在组合层（facade），vendor 保持只读（除 D3 路线 B 例外）
**理由**：vendor 是复制品，改了就与上游脱钩；组合层坏了可以回滚到拼接态（I6）。

---

## 5. 路线图 M0–M5

每个阶段都能单独发布、单独回滚。**顺序即收益顺序**。

### M0 · 测量（0.5 天，已完成 70%）
- 已做：`tools/cost-baseline.mjs`、`tools/probe-toolsize.mjs`。
- 待做：meow 每轮注入的真实字符（把它在 stub 环境跑一次 `buildInjection`）、缓存命中率基线（从 DSH 日志或 API 返回的 usage 里取）。
- **产出**：一张"改造前"账，写进本文档 §1.2 的表。
- 验收：数字可复现（同一脚本两次跑出同样结果）。

### M1 · 注入单点（2–3 天，收益最大）

> **2026-11-18 22:05 已落地一半**：nebula 侧不走配置、直接改 vendor —— `systemPrompt.context` 恒返回 689 字符 `RULE`，自动邻域注入与 `injectcfg` 依赖一并删除，邻域能力移到 `nebula_recall` / `nebula_bridge` 工具（详见 `README.md` 第 8 节、重放脚本 `tools/patch-nebula-noinject.mjs`、验收 `tools/probe-inject.mjs`）。
> 因此下面第 3 步（`inject.json` 写 `maxRounds: 0`）不再需要，`inject.json` 从此不影响任何行为；`D5`「邻域注入默认关」已以更强的方式实现（不是关掉开关，是没有开关）。
> 剩下的 M1 = 压 meow 侧 3,396 字符 guide + 首轮全文注入（第 1、2、4 步）。

改动点：
1. `lib/index.js` 增加 `policy/inject.js`：合并 guide+RULE 成 L0 文本（≤1,200 字符）。
2. 走 D3 选定路线，屏蔽 vendor 的 `systemPrompt.section/context` 注册。
3. `$DSH_HOME/memory-nebula/inject.json` 写 `maxRounds: 0`（即使路线失败也有保底）。
4. L1 差分：首轮调 meow 的 `buildInjection`（`vendor/meow-memory/lib/index.js:2020`），后续比对 `injectedIds` 与库内 `updated_at`，只发变化。
验收：
- system prompt 记忆段 ≤1,300 字符；
- 同一会话第 2 轮起前缀字节数稳定（可用 `verify.mjs` 扩展一项断言）；
- 检索功能不退化（跑 10 条已知 query，命中数与改造前一致）。
回滚：删 `policy/`、还原 `index.js`、`inject.json` 改回 `maxRounds: 2`。

### M2 · 工具面收敛（3–4 天）
- 新增 `surface/tools.js`：注册 8 个统一工具，内部调 vendor 暴露的函数。
- meow 侧可直接复用：`rememberTool/searchTool/...` 是 `lib/index.js:2323+` 的工厂函数，但**未在包导出里**（导出见 `:5578` 附近）→ 需要时用 `ctx.tools.register` 的原始定义对象，或在 vendor 加一行 `export`。
- nebula 侧：9 个工具定义在 `vendor/dsh-memory-nebula/lib/index.js:169/203/245/302/344/379/445/495/545`，是内联对象字面量 → 需要在 vendor 抽成可复用函数（**这属于改 vendor，需主人点头**），或者通过 `ctx.tools.register` 拦截拿到定义后改写 name/description 再注册。
验收：`tools` 数组里只剩 8 个 `memory_*`；schema 总量 ≤20 KB（8 个工具，参数更多但描述更短）；同一组任务（写 3 条、查 2 次、看图）工具调用次数不增加。
回滚：`compatAliases: true` 先救急，再整体还原。

### M3 · 星图并入 meow 节点（3 天）
- 统一 id 规范 `ws:level:<id>`（D6），改 `adapters/meow.js` 的 id 生成。
- 重建一次图，核对节点数 = meow active 行数 + nebula 自有行数。
- 3D 页面按 level 着色。
验收：随手打开 3D 页，能看到本轮刚写的记忆节点，且它与至少一条边相连。

### M4 · 存储收敛（2 天）
- nebula 图缓存降级为纯派生：删掉图上任何"只有图里才有"的信息（当前应该没有，需核）。
- 提供 `memory_admin(action:"rebuild")`：删缓存 → `LiveEngine.ensure()` 重建。
验收：删掉 `$DSH_HOME/memory-nebula/` 下的图缓存后，重建出来的召回结果与删前一致（除时间戳）。

### M5 · 成本看板 + 自动降级（2 天）
- `cost.jsonl`（D7）+ 设置页一个「本周记忆开销」小组件。
- 自动降级：当 L1 增量 > 2,000 字符时，改为只发"有 3 条以上变化的层"。
验收：连续 3 天真实使用，账本无空洞；单轮注入中位数 ≤800 字符。

**总量估计：12–16 个工作日**（按每天 4 小时有效投入算约一个月）。

---

## 6. 省钱账（改造前 vs 改造后）

| 项 | 改造前 | 改造后 | 省 |
|---|---|---|---|
| 工具 schema | 17 个 = 56.8 KB | 8 个 ≤20 KB | −65% |
| system prompt 记忆段 | 4,085 字符（含重复） | ≤1,200 字符 | −70% |
| 每轮动态注入 | ≤1,800 字符进前缀 | 0（挪进工具返回） | −100% 前缀污染 |
| 前缀缓存命中 | 被动态注入打碎 | 整会话稳定 | 命中部分按缓存价计费 |
| 首轮快照 | 全量 | 全量（不变） | — |

保守估计：**稳态固定税从 ~17 K token 降到 ~6 K token，且几乎全部命中缓存**。按 DeepSeek 缓存命中价（约为未命中的 1/10）粗算，实际计费开销降一个量级。

---

## 7. 风险与对策

| # | 风险 | 触发条件 | 对策 |
|---|---|---|---|
| R1 | Proxy ctx 破坏 cordis 生命周期 | D3 路线 A 试验时 `ctx.effect` 的 dispose 不执行 | 立刻退回路线 C（maxRounds:0），再试 B |
| R2 | 统一工具层丢掉 meow 的 DEDUP/去重语义 | 自写 remember 而未复用 vendor 函数 | 强制走 vendor 的 `rememberTool`，禁止重写写路径 |
| R3 | id 规范变更导致历史边全废 | M3 上线 | 保留 `legacyIdMap`，重建期间双读 |
| R4 | 两个 vendor 都要读 `$DSH_HOME` 下各自目录，homeDir 配置不一致 | 配置漂移 | macro 层统一解析 `homeDir` 后注入给两侧（现 meow 走 `config.meow.homeDir`，nebula 写死读 `$DSH_HOME/memory-nebula`） |
| R5 | 主人重启后发现功能缺失 | 任何 M 阶段 | 每个阶段先在 `verify.mjs` 扩展断言再交付；备份 + 一条回滚命令 |
| R6 | nebula 后台建图与 meow 写库并发 | 高频写入 | 接受最终一致；写入后标脏而非同步重建 |

---

## 8. 验收标准（整体）

1. `verify.mjs` 全绿（已按 0.2.0 重写：装配契约 + 8 工具 + 单段注入 + 别名开关）。
2. system prompt 记忆段 ≤1,300 字符，且第 2 轮起字节稳定。
3. `tools` 数组只有 8 个 `memory_*`。
4. 10 条基准 query 的召回结果与改造前一致或更好（列出对比表）。
5. 3D 页面能看到 meow 节点与边。
6. `cost.jsonl` 连续 3 天无空洞。
7. 一键回滚到拼接态，再一键回滚到两个独立插件。

---

## 9. 交接清单（新会话第一步）

1. **先确认运行状态**：主人是否已重启 DSH？日志里应有 `macro-memory` 的挂载记录。若未重启，插件尚未生效，先别改任何代码。
2. **读三份前置文档**（见页首），再读本文。
3. **跑一次基线**：
   ```powershell
   node D:\dsh-home\vendor\dsh-macro-memory\tools\cost-baseline.mjs
   node D:\dsh-home\vendor\dsh-macro-memory\tools\probe-toolsize.mjs
   node D:\dsh-home\vendor\dsh-macro-memory\verify.mjs
   ```
   三个结果与本文 §1.2 / §8 对上再动手。
4. **从 M1 开始**，先做 D3 路线 A 的 spike（半小时内能判断成败）。
5. **任何落盘前先备份**到 `D:\备份\<YYYYMMDD-HHMMSS>-macro-<阶段>\`，回滚命令写进交付回执。

### 关键定位索引

| 要看什么 | 去哪 |
|---|---|
| 组合器（当前实现） | `D:\dsh-home\vendor\dsh-macro-memory\lib\index.js` |
| 客户端三 id 注册 | `D:\dsh-home\vendor\dsh-macro-memory\lib\client.js`（由 `build.mjs` 生成，勿手改） |
| meow 工具工厂 | `vendor\meow-memory\lib\index.js:2323`（`rememberTool`）、`:2968-2974`（批量 register） |
| meow 首轮注入 | `vendor\meow-memory\lib\index.js:1986`（`buildInjectionBody`）、`:2020`（`buildInjection`） |
| meow guide 挂载 | `vendor\meow-memory\lib\index.js:4883`（`systemPrompt.section`, order 130） |
| meow 去重阈值 | `vendor\meow-memory\lib\index.js:2322`（`DEDUP_THRESHOLD = 0.8`） |
| nebula RULE | `vendor\dsh-memory-nebula\lib\index.js:36-45` |
| nebula 每轮注入 | `vendor\dsh-memory-nebula\lib\index.js:593-660`（`systemPrompt.context`, order 960） |
| nebula 注入预算 | `vendor\dsh-memory-nebula\lib\host\injectcfg.js`（`INJECT_DEFAULTS` / `INJECT_LIMITS`） |
| nebula 9 个工具 | `vendor\dsh-memory-nebula\lib\index.js:169,203,245,302,344,379,445,495,545` |
| nebula 读 meow 库 | `vendor\dsh-memory-nebula\lib\host\adapters\meow.js`（11,374 B） |
| 接线脚本 | `D:\dsh-home\vendor\dsh-macro-memory\tools\wire-profile.mjs`（`--status` / `--apply`） |
| 备份（拼接态） | `D:\备份\20261118-215337-macro-memory\` |

### 当前配置（`cordis.patch.yml` 里的 macro-memory 条目）

```yaml
- id: macro-memory
  name: 'dsh-macro-memory'
  disabled: false
  config:
    meow:
      homeDir: dsh-storage
      reflectTurns: 5
      promptLang: zh
      delegate: { model: "", effort: "" }
    nebula: {}
```

未来的配置会长成（M1/M2 之后）：

```yaml
    inject:
      enabled: true
      l0Budget: 1200      # 稳定段字符上限
      l1Diff: true        # 只发增量
      neighborhood: false # L2 不进 prompt（等价 maxRounds:0）
    tools:
      compatAliases: false
    cost:
      ledger: true
```

---

## 10. 一句话总结给下一个人

这个壳已经把两条鲸鱼装进来了，但它们还没学会一起呼吸。
下一步不是重写，是**重新分工**：meow 当内核（真相），nebula 当索引（线索），中间加一层策略决定"这一轮喂什么、喂多少、放哪里"，最后把 17 个工具收成 8 个、把 4,085 字符的说明收成 1,200、把每轮变化的注入从 system prompt 挪到工具返回。
做完这三件事，固定开销从 ~17 K token 掉到 ~6 K，并且全部命中缓存——这才是"极致省钱"能落地的地方。

---

## 11. 实施落点（0.2.0，2026-11-18 深夜落地）

§3.3 / D2 / D3 已实现，M1+M2 完成、M3 由 nebula 原生适配器承担、M5 账本已接。实际代码形状与 §3.3 的"kernel/index/policy"示意不同——**没有把 vendor 拆成内核，而是用 facade 把它们降级成引擎**：

```
lib/index.js           装配：wrapPlugin(meow) + wrapPlugin(nebula) → 8 个统一工具 → 一段 L0 注入
lib/macro/bridge.js    Proxy facade + 工具/注入捕获 + awaitTool/call/tryCall
lib/macro/tools.js     8 个统一工具 + compatAliases 补回 11 个旧名
lib/macro/prompt.js    L0 手册（949 字符）+ L2 按需手册（buildFullGuide 取 vendor 原文）
lib/macro/cost.js      $DSH_HOME/macro-memory/cost.jsonl + costReport
```

**facade 为什么是 Proxy 而不是改写 vendor**：cordis 传给子插件 `apply` 的 fiber ctx 由宿主创建，我们拿不到；能插入的只有 `ctx.plugin(mod, cfg)` 的 `mod`。所以把 `mod.apply` 包一层：`(c, cfg) => mod.apply(createFacade(c, bridge, vendor), cfg)`。
facade 只拦三处——`tools.register`（收进 bridge，不注册）、`systemPrompt.section|context`（收进 bridge，不注入）、`inject/plugin`（递归包壳）；其余属性 `Reflect.get` 并 `.bind(real)`，避免 cordis 内部把 Proxy 当 `this`。

**懒绑定**：统一工具的 `execute` 里 `await bridge.call('memory_search', …)`，内部 100 ms 轮询等 vendor 定义就绪（默认 30 s 上限），因此子插件注册顺序、异步 `apply`、`ctx.inject(['settings'])` 才注册工具这些都不影响装配。

**成本实测（0.2.0）**：8 个统一工具 schema 合计 **4,714 B**（原 56,759 B，−91.7%）；注入 **949 字符 / 1 段**（原 4,085 字符 / 2 段，−76.8%）；稳态固定税从 ~17–19 K token 降到 ~2.5–3 K。

**联动落点（这是"融合"与"拼接"的分界）**：
- `memory_remember` / `memory_update` 的 `links[]` → 写完顺手调 `nebula_link action=link`（12–14 s 等节点入图，未入图则如实告知并给出可复制的 `memory_link` 调用）。
- `memory_search` 默认查主库；`expand=true` 或零命中时追加星图扩散段；`memory_ids[]` 可把主库命中的 id 直接喂给星图做种子。
- `memory_read` 默认带邻居（`nebula_inspect` 的「## 连接到的记忆」段）。
- `memory_admin` 把两边的运维口（home/stats/hygiene/sources/ingest）与宏自己的 cost/guide 合成一个。

**已知边界**：nebula 的引擎实例是模块内局部变量（只作为实参传给 `registerRoutes`），facade 捕获不到 → **无法主动触发 rebuild**，只能依赖 `LiveEngine` 的 ~12 s 巡检 + 工具内「图空则 refresh」。所以新记忆进图有最长约 12 s 延迟，这是设计上的诚实降级，不是 bug。

**回滚**：`D:\备份\20261118-225745-macro-fusion` 整包还原即可回到拼接态；或用 git 恢复 `lib/index.js` + 删除 `lib/macro/`。

---

## 12. 0.2.1：表述归口 / 覆盖审计 / 真宿主探针（2026-11-18 深夜）

三件事，都是「融合」最后缺的那几块：

**12.1 文案归口（`lib/macro/brand.js`）**
工具面收成 8 个之后，子插件的返回文本里还写着 `nebula_recall` / `memory_find_similar` / `meow-memory` —— 这些名字在 `compatAliases=false` 时并不存在，等于给模型一封死指针信。`brand.js` 做**名字级**替换（不改措辞、不重写逻辑，守住 §7 R2）：

| 原文 | 换成 |
| --- | --- |
| `nebula_recall` | `memory_search（mode="graph"）` |
| `nebula_inspect` | `memory_read（neighbors>0）` |
| `nebula_bridge` | `memory_search（mode="bridge"）` |
| `nebula_link` / `nebula_path` | `memory_link` / `memory_link（action="path"）` |
| `nebula_stats/hygiene/sources/ingest` | `memory_admin（action=…）` |
| `memory_find_similar` / `memory_home` | `memory_search（mode="similar"）` / `memory_admin（action="home"）` |
| `meow-memory` | `macro-memory` |

落地位置：`createBridge({ brand })` → `call()` 渲染完先过一遍；`tryCall()` 的失败文本同样过；`memory_admin(guide)` 的整本手册过。**`compatAliases=true` 时不动原文**（那时旧名真能用，A/B 对比需要原样）。`bridge.call` 的「没就绪」报错也去掉了内部名，只留一句通用说明 + 一条 warn 日志。
实测：`memory_admin(guide)` 4281 字符里已无 `nebula_` / `meow-memory`，`nebula_recall` 变体全部换成宏的说法。

**12.2 覆盖审计（`tools/coverage-audit.mjs`）**
「功能全部搬过来」不能靠嘴说。脚本从 vendor 源码里点名 17 个原工具，逐条对到 8 个统一工具的**真实入口**上（`memory_search.mode` / `memory_admin.action` / `memory_link.action` 的枚举值），再用 spy bridge 真跑一遍 17 条调用路径，断言每个原工具都被走到。改动 vendor 或加工具时，这张表会立刻报错。

**12.3 真宿主探针（`tools/probe-host.mjs`）**
`verify.mjs` 用的是假 ctx，只能证明「我们以为自己注册成功了」。这个探针直接把 DSH 本体里的 `@deepseek-ai/cordis` + `ToolsService` + `SystemPrompt` 拉起来（`DSH_APP` 指到 `D:\DSH\DSH NEXT\resources\app`），再装我们的插件，让**宿主自己的校验**说话：

- `ToolsService.register` 的 `output.render` / `assertSupportedJsonSchema` / 保留名检查
- 真 `SystemPrompt.assemble({})` 里 `sections` 只有一段 `macro-memory:guide`（949 字符），nebula 的 RULE 根本没成段
- `projectToolSchema` 实测 8 工具 **7,719 B**（宿主投影后比原始参数更大，仍远低于 16 KB 线）
- 端到端：`memory_remember` → `memory_search` → `memory_admin(guide/cost/home/stats)` → `memory_link(action="path")` 全部走真服务执行，且输出里不含旧工具名

探针里踩到的两个真问题，都写成了代码注释：
1. `dsh-llm` 重定向只能对「宿主目录之外」的导入者生效——宿主的包自己要 `HarnessError` 等符号，一起劫持会当场炸。
2. nebula 声明 `inject = ['tools','systemPrompt','webServer','connection']`，**缺 webServer / connection 它就一直等，9 个星图工具根本不会注册**。宿主里由 dsh-web-server 提供；探针里用两个最小 `Service` 桩顶上（`WebServerStub.register()` 收下路由即可）。
   顺带确认：meow 的 `activeHomeDir()` 默认是 `~/.dsh-meow`（不是 `$DSH_HOME`），探针换成临时目录时必须显式 `setActiveHomeDir` + `enableWorkspaceTrust` + `trustWorkspace`，否则会撞「未信任的外部记忆库」闸门。

## 13. 参数级不退化（0.2.2）

### 13.1 为什么工具级审计不够
`coverage-audit.mjs` 只证明「17 个工具都有去处」。但融合层是多路复用的：`memory_search` 一个工具承载 4 个 mode，`memory_admin` 承载 7 个 action。**工具还在、参数被漏掉**是完全可能的静默退化——模型传 `chars` 进来被 `pick()` 过滤掉，调用成功、结果变差，没有任何报错。

所以补 `tools/param-audit.mjs`：真跑两个 vendor 的 `apply` 把 17 个工具的 `parameters` 原样捕获，与统一工具 schema 逐字段比对。

### 13.2 两类「看似退化其实可接受」要分开处理
1. **类型收窄**：nebula 的条数参数写 `number`，我们写 `integer`。这 9 个字段（`limit/hops/neighbors/maxHops/hubs/chars`）真实调用只传整数，收窄不丢能力，但脚本会打一行 INFO 记下来，不静默略过；哪天换成 `string→integer` 这种真会丢东西的，就照常 FAIL。
2. **合并导致的「条件必填」**：`memory_search.query` 原本必填，但统一工具里 `mode=similar` 要用 `id`、`mode=graph` 可以只给 `memory_ids`，schema 没法表达条件必填。做法是**在 `execute` 里守回来**，并且审计脚本真的调一次 `execute` 断言它会抛（缺 query/id/provider/items 四条）。只改 schema 不测运行时，等于把守卫写在注释里。

### 13.3 三态退化：星图没接上 ≠ 星图还没建好
`links[]` 回填要等星图把新条目建成节点（最长 ~12 s 巡检）。原先用「文本非空且不含『星图里没有』」判断就绪，二态逻辑把两种完全不同的情况糊成一种：

- 节点还没入图 → 等 12 s 就好（可恢复）
- 星图子插件这次没接上（缺 `webServer`/`connection`、或配置关闭）→ 等一辈子也不会好

现在 `graphState()` 返回 `ready / pending / unavailable`，判据是 `bridge.tryCall` 的 `entry === undefined`（工具定义根本没被捕获）。`unavailable` 直接告诉模型「星图这次没接上，关联已记在主库」，并给出稍后可用的 `memory_link` 调用；不再让模型干等，也不再让 12 条连线逐条超时。

### 13.4 `links[]` 支持带理由
`nebula_link` 原本有 `note` 参数，融合后我们原先写死一句固定文案，等于把这个能力砍了。现在 `links` 接受两种形态：

```json
"links": ["老id", { "id": "新id", "note": "同一次排查得出" }]
```

schema 用 `items.oneOf[string, object]`（宿主 schema 子集支持 exact-one `oneOf`），运行时 `normalizeLinks()` 归一；字符串形态仍用默认 note，向后兼容。

### 13.5 失败文案不再自指
`tryCall` 的失败文本原来拼的是子插件工具名，品牌化之后会变成「`memory_search（mode="graph"）未完成`」——模型正在调 `memory_search`，却被告知 `memory_search` 没完成。现在 `tryCall(name, args, exec, timeoutMs, label)` 多一个 `label`（如「星图扩散」「星图邻居」「星图连线」），失败文案说人话。

## 14. 待补连线队列（0.2.3）

### 14.1 问题：三态退化只做到了「说实话」，没做到「不丢」
0.2.2 把 `graphState` 拆成 ready/pending/unavailable 之后，退路是**把原因告诉模型**、再给一行 `memory_link` 让它自己回来补。这在真实会话里等于丢弃：模型下一秒就换了话题，不会为一条连线回头；用户更不会在 12 秒后重新说一遍「顺手把这两条连起来」。

而星图的延迟是结构性的——`LiveEngine.#load` 里 `next.startWatching(12000)`，引擎自己轮询 signature 才 refresh；`nebula` 的实例是 `apply()` 内的局部变量，facade 拿不到，外部无法主动 rebuild（0.2.0 就已经确认过）。**既然不能让它立刻连上，就必须保证想连的东西不会消失。**

### 14.2 设计：落盘队列 + 读路径自愈
`lib/macro/links.js`，落点 `$DSH_HOME/macro-memory/pending-links.jsonl`（与 `cost.jsonl` 同目录，便于一起备份/清理）。

写入侧（`applyLinks`）：

| 情况 | 处理 |
|---|---|
| `graphState = ready`，单条连上 | 不排队 |
| `graphState = ready`，单条报错 | 入队，理由 `连线失败待重试` |
| `graphState = pending` | 全部入队，理由 `节点待入图` |
| `graphState = unavailable` | 全部入队，理由 `星图未装配` |
| `memory_link(action="link")` 直接抛错 | 入队，理由 `memory_link 失败待重试`，并把异常折成一句可读提示 |

读出侧（`flushLinks`，挂在 `memory_search` / `memory_read` / `memory_link(link)` / `memory_admin(links)`）：
节流 30 s（`config.flushThrottleMs`，探针设 0）、单轮预算 1.2 s、最多 8 条、**星图整体不可用就立刻停手**。
连上一条就 `dropPending` 摘一条；连不上留着，等下一轮。

### 14.3 五条边界，都是「宁可少做也不要闯祸」
1. **不发明关系**：只补 `links` 里明确给过的 id，绝不按相似度自己连线——星图的边是「证据」，不是猜测的产物；
2. **不让读变慢**：节流 + 预算 + 条数上限，最坏情况多花 1.2 s；预算用尽就下一轮；
3. **有硬上限**：队列 ≤500 条（超了丢最老的）、每条 7 天 TTL——坏掉的星图不该把磁盘撑满；
4. **IO 全吞异常**：坏行跳过、写失败静默；队列永远只是锦上添花，坏了记忆功能照用；
5. **不重复排队**：同 `a→b` 已存在就只刷新时间与理由，避免一次会话把同一条连线堆 20 遍。

### 14.4 可观测性
`memory_admin(action="links")` 读面板（顺手补一轮）：条数、前 N 条 `a ↔ b`、排队时间（本地时间，不用 UTC，免得误判过期）、理由。工具面没有新增工具、没有新增必填项——只是给 `memory_admin` 多一个 action，这正是当初把运维合进一个工具的理由。节流窗口可配 `macro.flushThrottleMs`（默认 30 s，0 = 每次都补），与 `guideMaxChars` / `toolWaitMs` 同属 `MACRO_KEYS`。

### 14.5 验证
- `verify.mjs` A3：队列纯函数契约（去重、自连/空 id 拒绝、drop 只摘一条、TTL 过滤、坏行跳过、面板文案）；
- `tools/probe-fusion.mjs` F1–F5：星图缺席时排队并说明会自动补 → 读记忆触发补连后队列归零 → 连线失败留队 → 面板列出欠账并在星图恢复后补上 → 坏行/空文件不炸；
- `tools/probe-host.mjs` F4b：真宿主服务里 `memory_admin(action="links")` 能读队列。

## 15. 面板口径统一（0.2.4）

### 15.1 问题：宿主收成一个插件，界面还是两个

0.2.0–0.2.3 把工具面、注入面、成本面全收进了一个插件，但**用户看到的入口名**没人管：
meow 的设置节 label 是「喵记忆」，nebula 的侧栏图标 label 是「记忆星图」。用户视角等于装了两个插件，
「融合」这件事在 UI 上是不可见的。目标里的「统一所有面板口径」指的就是这一层。

### 15.2 契约：label 可以是 thunk，id 不能动

读 `@deepseek-ai/dsh-cordis-client-runner/lib/client.js` 里的 slot 契约注释，list 型 slot（`sidebar.panellist`、
`settings.section`…）的 `registerOptions` 是 `{ id, order?, label? }`，其中 `label` 类型是
`string | (() => string)`——**是函数就每次投影重读**，vendor 用它跟随语言切换。
所以归口只能改 `label`（和 `title`），`id`/`key`/`order`/`inject`/`comp` 一律原样：
宿主按 id 找面板，`sidebar.panellist.actions` 的 owner 过滤、用户书签、日志里的面板 id 全认它。

### 15.3 做法：client 侧也包一层 facade（与宿主侧同构）

`build.mjs` 模板里 `asPlugin(mod, name)` 的 `apply` 从 `mod.apply(ctx)` 改成 `mod.apply(brandCtx(ctx))`。
**这一处是本次唯一有坑的地方**：宿主 `ctx.plugin(child)` 传进来的 ctx 是宿主自己造的，组合层外面
没法拦截；归口必须发生在子插件 `apply` 的入口，也就是必须把 ctx 换掉再交出去。

`brandCtx` 用 `Proxy` 只做三件事：`slots` 换成 `{ register → brandMeta, inject → 包一层 scoped ctx }`；
`scope(name)` 返回递归 `brandCtx`；`get('slots')` 返回同一个 facade。其余一切（`get`/`on`/`effect`/`plugin`…）
bind 回原 ctx，不改变任何行为。整段包 try/catch，拿不到 Proxy 就原样返回——**面板名字不好看可以忍，面板注册不上不行**。

`brandLabel` 遇到函数返回一个新函数（`() => brandText(fn())`），不提前求值，否则语言切换后名字会钉死。

### 15.4 结果与边界

| 入口 | 原来 | 现在 |
|---|---|---|
| `settings.section#meow-memory` | 喵记忆 | **宏记忆** |
| `sidebar.panellist#memory-nebula` | 记忆星图 | **宏记忆 · 星图** |
| en locale | Meow Memory / Memory Nebula | **Macro Memory / Macro Memory · Graph** |

已知边界：面板**内部**标题（nebula 页头「记忆星图」）写在 vendor 的 164 KB web bundle 与
`lib/web/i18n.js` 词典里，归口要同时改两份打包产物的字符串表，收益不抵风险，保留原样。
验收：`tools/probe-client-ui.mjs` 的「口径」四条（设置页名、侧栏名、无旧名残留、id 未改写）。

## 16. 结构整理：工具定义一文件一个（0.2.5）

### 16.1 问题：装配器长成了巨石

`lib/macro/tools.js` 到 0.2.4 已是 25,991 B / 538 行，四类东西混在一个作用域里：8 个工具的
schema 与执行体、连线流程（`graphState`/`applyLinks`/`flushLinks`）、兼容别名、共用小工具。
后果是「加第九个工具」这种最正常的需求，要在一大段 schema 文本里找插入位置，还容易误碰
`lastFlush` 这类闭包状态；也让「meow 原功能不许砍」这条不变量缺一个可读的对照面——
想确认某个工具还在，只能全文搜名字。

### 16.2 切法：按「谁会变」分，不按「谁调用谁」分

| 文件 | 变的原因 |
|---|---|
| `lib/macro/shared.js` | 枚举 / 输出形状 / 取值工具变了才动（`LEVELS` 跟随 vendor） |
| `lib/macro/linkflow.js` | 连线策略变了才动（三态判定、排队、节流预算） |
| `lib/macro/defs/<tool>.js` | 单个工具的描述、参数、执行分支变了才动 |
| `lib/macro/tools.js` | 工具集合变了才动（装配 + 兼容别名） |

`defs/*.js` 的工厂签名统一为 `createXxx({ flow })`，`flow` 由 `createLinkFlow` 产出
（`call` / `tryCall` / `applyLinks` / `flushLinks` / `flushNow`）；`admin` 额外拿 `{ bridge, config }`，
因为它要吐 `guide` 全文与 `cost` 账本。这样 defs 只依赖三个下层模块，不反向依赖装配器。

### 16.3 两条结构纪律（verify.mjs A4 段机器守着）

1. `defs/` 不许出现 `from '../tools.js'`——否则就是又回到互相纠缠；
2. `tools.js` 不许直接写工具 schema（禁止出现 `additionalProperties: false`），体积 < 6 KB，
   且装配点恰好 8 个——防止「顺手把新工具写回装配器」。

### 16.4 为什么现在做、代价是什么

不是审美需求：0.2.0–0.2.4 每轮都在同一批文件里加分支，回归风险靠 8 个脚本兜着；拆开之后
「改一个工具只读一个文件」，脚本覆盖面不变，维护成本明显下降。代价是文件数从 6 → 16，
import 变多——用 `shared.js` 一次性收口形状常量抵消掉。行为面零变化：8 个工具的 description、
parameters、执行分支逐字迁移，`param-audit` 逐参数比对通过。

**顺手修掉的配置面漏洞**：`flushThrottleMs` 原本被 `tools.js` 读却不在 `MACRO_KEYS` 里，
配置上根本够不到（读了等于写死默认值）。0.2.5 把它补进 `MACRO_DEFAULTS` / `MACRO_KEYS` / README §3，
并立一条规矩：凡代码里 `??` 兜底的键，必须同时出现在这三处。

## 17. 交付物体检：把「两棵树不同步」变成一条命令（0.2.6）

### 17.1 单点脚本的结构性盲区

部署形态是 vendor 源码 + profile 实体拷贝（§11.3），这是**有意**的选择：profile 里必须是真文件，
不能是软链接，否则 DSH 打包/重装会带走链接。代价是同步靠手。

于是出现一类很阴的失败：改了 vendor、跑完 9 个脚本全绿、忘了 robocopy → 主人重启 DSH，加载的
还是旧版本，而「全绿」是在新树里测出来的，一句话都没错，结论却是错的。
`verify.mjs` 天然帮不上：它只验自己所在的那棵树；`check-yaml.mjs` 只看 profile 的 patch/bundles，
不看代码内容。

### 17.2 设计：只读、可解释、一个退出码

`tools/doctor.mjs` 不进产品运行时，只做六段核对，每行都以 PASS / WARN / FAIL 开头并带上实测值
（不是「OK」两个字），FAIL 计数决定退出码，`--strict` 让 WARN 也算失败。

| 段 | 手段 | 为什么放这儿 |
|---|---|---|
| 版本与身份 | 解析 `package.json` 与 `lib/index.js` 里的 version 字面量，比对 | 版本号双写是历史遗留，不同源就是发版事故 |
| 两棵树 | `lib/` + `tools/` + package.json/README/DESIGN/verify/build 逐字节 sha256，**双向**比 | 单向比漏「profile 里多出旧文件」；双向才叫一致 |
| 加载面 | profile `package.json` 的 `dsh.profile.bundles` 与 patch 里的 name 计数 | 「能加载」的最小充分条件 |
| 客户端产物 | `client.js` 字节数、sha256 前 12 位、三个 load id、`brandCtx` 是否存在 | 归口是否真的进了产物（§15） |
| 运行时 | 调 `clampGuide()` 量 L0 长度、`readPending()` 数队列、`ledgerPath()` 看账本 | 用真函数量，不用文档里的数字 |
| 文档声称 | README 提到的脚本是否存在、每个脚本是否有出处、产物字节数/sha 前缀/版本号能否在 README 找到原样字符串 | 文档里的数字最会悄悄过期，且过期后仍「看起来对」 |

备份段只报最新一份 `macro-fusion-*` 目录名，WARN 级别——没有备份不阻塞开发，但发版前该有。

**为什么把文档也当被测对象**（0.2.7）：代码有 8 个脚本守着，文档一个都没有。而文档恰恰是读者判断
「我手上是不是最新版」的第一依据——README 写 162,813 B，bundle 改了没改这行，读者按数字核对就得出
错误结论。做法是反向的：不解析语义，只要求「实际值能作为字符串在 README 里找到」。找不到就是 WARN，
不阻塞（文档可以晚一步补），但每次跑都会念一遍，不会沉底。首跑抓到两个漏记的脚本
（`cost-baseline.mjs`、`probe-toolsize.mjs`），已补进 README §4 并标明是 0.1.x 的一次性静态分析基线。

### 17.3 边界与自证

- **不修任何东西**：doctor 只报告不修复。修要人决定（robocopy 还是回滚备份），自动化修复会把
  「两边都错」的风险放大。
- **不重复实现断言**：注入覆盖、工具集合这些已经由 `verify.mjs` / `coverage-audit.mjs` 断言，
  doctor 只补它们结构上看不到的那一层（树间一致性、加载面、运行时实况）。
- **自证**：0.2.5 代码首跑，唯一 FAIL 是 `tools/doctor.mjs（profile 缺）`——它第一次运行就把自己
  这个未同步的文件抓了出来，然后同步后归零。这种「工具抓到自己」是最有说服力的验收。

## 18. 真引擎端到端：把「融合」从主张变成证据（0.2.8）

### 18.1 问题：最强的那个主张，恰恰最没被验过

前七版所有自检都在同一个「假 ctx」世界里：`verify.mjs` 用最小 ctx，`probe-fusion.mjs` 用真 vendor 但
nebula 是 stub（只记下 `nebula_link` 被调用了什么参数），`probe-host.mjs` 用真 ToolsService 但星图空着
（`记忆星图：0 条记忆`）。合起来能证明的是「我们把调用接上了」，而不是「星图里真的有这张图」。
而「meow 为主、nebula 为索引」整个设计的价值，全压在后者上。

### 18.2 三个必须真实的点

| 环节 | 假不了的原因 | 真值 |
|---|---|---|
| meow 库 | 写入走的是 meow 自己的 SQLite 库与信任闸 | 工作区下 `.dsh-meow/memory.db` |
| 星图怎么发现工作区 | 适配器读 `storages/workspace.json` 的注册表，不是猜路径 | `tables.workspaces[id].path` |
| meow 信任闸 | 未登记的工作区直接被拒（#64 外部记忆库） | `<homeDir>/window-index.json` 里登记过即 seed |

`homeDir` 也必须显式传——meow 的 home 默认是 `~/.dsh-meow`，不从 `DSH_HOME` 推；早期试过把信任
marker 手写进 `storages/meow-memory/trusted-workspaces/`，全无效，就是踩了这个。

### 18.3 顺带挖出来的真 bug：短 id 连不上线

真环境一跑就暴露：meow 的工具输出只给 8 位前缀（它自己 `findById` 支持前缀），星图 `resolveIds` 却只认
完整 id 或节点全 id。于是 `memory_remember(links=["0mwmbucj"])` 一定报「找不到这两条记忆」，然后按设计
排进队列——**排队机制本身把 bug 藏住了**：不报错、不崩，只是那条边永远补不上，7 天后静悄悄过期。

修法不是给星图放宽（那要改 vendor），而是在融合层归一：`resolveId` 用 `memory_read` 换完整 id（带进程内
缓存），归不出来就判定永久失败、当场摘掉。同时区分「工具没上线」（停手、保留队列）与「这次连不上」
（排队重试）——`tryCall` 在 execute 抛错时返回 `entry: undefined`，所以必须先判文案再判可用性，否则
「找不到节点」会被误读成「星图没装配」，队列就永远不动了。

### 18.4 验收

`tools/probe-graph.mjs` 八条断言（G1–G8）在真引擎上跑，约 15–30 秒；`probe-fusion.mjs` 同步补 F6–F8
把短 id 补全、永久失败摘除、`gone-` 目标在 stub 层也钉住。`verify.mjs` 的 A6 段只守「这支探针没被降级
回 stub」：文件成形、含真布局关键词、断言的是「连接数」而不是「文本非空」、跑完自清临时目录。

## 19. 带补丁的第三方引擎与它带来的两个连带问题（0.2.9）

### 19.1 一个口径不一致，暴露了两条没被验过的路径

0.2.8 的 G1–G8 只验了「写入 → 成节点 → 连线 → 读邻居」。把断言往生命周期上推一步（G9 改写、G10 归档、
G11 重建幂等），立刻撞到一件不该发生的事：**归档之后，`memory_search(mode="graph")` 仍然把那条记忆**（强度 1，
排第一）**返回给模型**；而 meow 自己的检索是排除 archived 的。

查下去发现这不是「nebula 没做过滤」，而是**同一套规则只做了三分之二**：

| 位置 | 对 archived 的处理 |
|---|---|
| `bridge.js` 的 `statusFactor`（推荐邻居） | `archived`/`deleted` → 0（等于不推荐） |
| `graph.js` 的 hygiene 分组 | `if (n.status !== 'active') continue` |
| `recall.js` 的检索主路径（`nebula_recall`，也就是 `mode="graph"`） | **没有任何过滤**，只给 `status` 字段原样带出 |

所以产品行为取决于「用户从哪条路问」：本地检索问不到，星图检索问得到。以 meow 为主的前提是两者口径一致，
否则模型读到的是用户已经明确说「不用了」的记忆。

### 19.2 为什么改 vendor，而不是在融合层过滤

融合层手上只有 `nebula_recall` 返回的**文本**（`N. [level] ws 强度 x label` + `id:` + `为什么：`），
没有结构化 hits，要过滤就得自己解析行、或者对每条命中再 `nebula_inspect` 查一次——前者脆、后者把一次检索
变成 N 次。而这条规则本来就是 nebula 自己的规则（`statusFactor` 与 hygiene 都是这么写的），补在 `recall()`
里是**补齐**不是**改写**：三处改动、每处一个 `[macro-fusion 0.2.9]` 标记，共约 10 行。

保留的行为是有意的：归档节点仍是图里的一条边、仍能在扩散时当中转（用户归档的是「这条别用了」，不是
「这条不存在」）、仍能被 `nebula_inspect` 按 id 打开、仍进 hygiene 统计。只是不许它自己占一个结果位。

### 19.3 补丁必须能被机器找回来

vendor 是拷进来的第三方源码：升级、重新取包、覆盖式 robocopy 都会静默把补丁冲掉。冲掉不会报错——只会让
行为退回上游（归档的记忆又开始冒出来），而这种退化没人会主动去测。所以补丁要三件事一起做：

1. **标记串**：每处改动带 `[macro-fusion 0.2.9]`，可 grep；
2. **账本**：`tools/doctor.mjs` 新增第七段「补丁账本」，按标记串检查在位，缺了 FAIL 并指到 README §9.14；
3. **守卫**：`verify.mjs` A7 段六条断言（标记、`includeInactive` 出口、`selectable` 同时排 archived/deleted、
   与 `statusFactor` 同口径、doctor 账本记着、探针有归档断言且不假通过）。

同时补了一个此前一直存在的盲区：doctor 的「两棵树同步」原来只比 `lib/`+`tools/`+5 个文档，**不含 `vendor/`**。
补丁打在 vendor 上之后，这个盲区会直接让「补丁只在 vendor 生效、profile 是旧引擎」这种状态静默通过。
现在 vendor 双向进比对（95 个文件 / 2.6 MB，sha256 一遍不到一瞬）。

### 19.4 探针自己的假通过

G9 第一版写的是「星图检索文本里包含 `已经被改写` 就算命中」。但星图「没命中」的文案是
`星图里没有匹配「已经被改写」的记忆。`——它把 query 回显了，于是判断恒真，G9 立刻「通过」，而实际上那一刻
星图还缓存着旧内容。这类断言比没有断言更危险：它让探针失去意义却照样打 PASS。

修法是把「命中」定义成「不是 miss 文案」，抽成 `const miss = (t) => t.includes('星图里没有匹配')` 统一使用，
并让 verify 守住这个写法（A7 里那条「不用 `includes(query)` 判命中」）。

### 19.5 验收

- `node tools/probe-graph.mjs`：24 条断言（G1–G11）全绿，含「归档后 `mode="graph"` 不再命中」；
- `node verify.mjs`：A7 六条全绿；
- `node tools/doctor.mjs`：七段全绿，且「两棵树同步」纳入 `vendor/` 后确实抓到 3 处待同步漂移
  （doctor.mjs / probe-graph.mjs / recall.js）——先抓到自己，再同步，最后两树一致。

## 20. 星图缺席时的降级：把「以 meow 为主」落到失败路径上（0.2.10）

### 20.1 主路径成立，失败路径不成立

0.2.0–0.2.9 的全部工作都在证明「两个引擎合起来比一个强」：8 个统一工具、一段注入、真引擎端到端、生命周期同步。
但这些证明有个共同前提——**星图装着、活着**。把星图拿掉（nebula 被配置关掉 / engine 还没起 / apply 抛错后
没注册工具），此前的行为是：

```
memory_search(mode="graph")        → throw  macro-memory：这项能力还没就绪…
memory_link(action="unlink")       → throw  同上
memory_admin(action="stats")       → throw  同上
```

这不是「报错」这么简单：模型是在注入里被明确告知「查关联用 `mode="graph"`」之后照着用的。工具面先教它用，
再用一个内部错误惩罚它，模型学到的结论是「这个工具面不可信」——这比少一个功能伤害大得多。

### 20.2 一句话约定

**星图是增强，不是前提；星图缺席时降级要说人话，而且不许把记忆弄丢。**

三条落地规则：

1. **能退回本地的就退回**：`mode="graph"` / `mode="bridge"` 有 `query` 时直接跑一次本地检索，前面加一行
   说明「星图这次没接上」，结果照给；
2. **只改星图的动作要承认失败但划清影响面**：`unlink/mute/unmute/path` 落不了盘就是落不了盘，
   但文案必须落到「记忆本身没受影响」；
3. **不可重试的写要排队**：`link` 与 `remember(links=[…])` 进待补队列，读记忆时自动补（0.2.3/0.2.8 已有）。

### 20.3 为什么现在做，代价是什么

降级路径的价值不在平时，而在**出问题时**——而 0.2.9 刚好证明了「出问题」会以什么形式出现（补丁被冲、引擎旧版）。
如果那时模型的面板开始抛内部错误，排障的人会先去怀疑融合层，而不是去看 vendor 漂移。

代价是一次性把 8 个入口的失败文案统一，以及引入一条硬约定：`lib/macro/**` 不许再对 `nebula_*` 直接 `flow.call`。
后者由 `verify.mjs` A8 段的十条守（其中这条是自动扫全树），`tools/probe-fusion.mjs` G1–G11 用一个
「只有 meow、没有星图」的 bridge 把每条路径走一遍。

顺带收掉一处重复实现：`memory_link(action="link")` 原来是 `try/catch`，与其它入口的 `tryCall` 各写一份
「怎么算失败、失败要不要排队」；同一个判断的两份实现早晚会岔，现在统一成 `tryCall` + 一个 `why` 变量。

还收掉一个自检污染：`coverage-audit.mjs` 会真执行 `memory_link`，但没沙箱 `DSH_HOME`，于是每跑一次审计，
真实账本里就多一条假欠账（`x ↔ y`），doctor 的运行时段随即报「有排队中的连线 1 条」——一条自检制造的
假象反过来污染了排障信号。这类问题不能靠记：`verify.mjs` A8 段扫 `tools/*.mjs`，凡是会真跑工具的脚本
都必须把 `DSH_HOME` 指到临时目录。

### 20.4 验收

- `node tools/probe-fusion.mjs`：G1–G11 全绿（graph/bridge 退回本地、没 query 时的兜底说法、similar 不依赖星图、
  unlink 的「记忆没受影响」、link 排队、读记忆只出正文、面板 / ingest 的缺席文案）；
- `node verify.mjs`：A8 段十条全绿，含「`lib/macro` 不再对 `nebula_*` 直接 call」的全树扫描；
- 两棵树 10 支脚本全绿，`tools/doctor.mjs` 七段 ALL PASS。

## 21. 显示名收口：门牌也是口径（0.2.11）

### 21.1 口径有两层，0.2.4 只做了外面那层

0.2.4 的归口对象是**入口**：`slots.register` 的 `meta.label`——侧栏那一行、设置节那个标题。这条边界当时是
被刻意画出来的（README §9.10 的「已知边界」）：面板**内部**的名字写在 vendor 的 164 KB web bundle 与 i18n
词典里，改它要动打包产物的字符串表。

问题是用户真正的感受路径是「点进去」：外面叫「宏记忆」，点进去页头写「记忆星图」，meow 的设置面板 `<h2>`
写「喵记忆」。同一个交付物，三个名字，其中两个还是旧名——**归口只做一半，比不做更容易让人以为是两个插件**，
因为用户会先看到新名字、再看到旧名字，形成「这里面还套了别的插件」的印象。

### 21.2 只动显示名，不动标识

改名的红线：**显示名可以改，标识不能改**。理由是标识被别的东西引用，改名会静默断链。

| 类别 | 例子 | 处理 |
|---|---|---|
| 显示名 | `<title>`、页头 `<b>`、i18n 词典值、画布水印、侧栏 `LABEL`、meow 的 `settings.title` | **改** |
| 人看得见的其它抬头 | 注入横幅、工具描述、stats 抬头、启动日志、口令页标题、离线快照标题、Markdown 导出抬头、CLI 抬头 | **改**（只要用户或模型会读到，就是门牌） |
| 内部标识 | `id` / `key` / 槽位 `memory-nebula` / 工具名 `nebula_*` / 文件路径 | 不动 |
| 意象文案 | 「正在点亮记忆星云…」「正在生长记忆星云…」 | 不动（星云是意象，不是产品名） |
| 注释 / 示例数据 / 上游挂牌 | `lib/host/graph.js` `http.js` `demo.js` 的注释与示例、`locale/*.json` 与 `market/index.json` 的商品条目 | 不动（改注释不产生用户价值，改上游挂牌等于替上游改名） |

`settings.title` 这个词条是个好例子：它在 meow 的词典里被 `<h2>` 用，也在启动日志与 aria 里用；改的是**值**，
键名一个字没动，所以任何按 key 取文案的代码不受影响。

### 21.3 两个引擎，两种改法

- **nebula（自有上游、已打过补丁）**：直接改文件，文件头打 `[macro-fusion 0.2.11]` 标记，写进 doctor 的
  补丁账本。代价是 vendor 升级会冲掉——这正是账本存在的意义（0.2.9 建立的机制第一次被复用）。
- **meow（词典在 164 KB 产物里）**：改在**构建期**。`build.mjs` 用 `replaceN(text, from, to, expected)`
  做带计数的替换，计数不符直接抛错。这条比「改完再看」强的地方在于：vendor 哪天把 `settings.title` 改名或
  换语言键，构建会**失败**而不是静默生成一份没改到位的产物。

产物 162,804 → 162,806 → 162,813 B：中文那条「喵记忆」→「宏记忆」字数字节都没变，+2 B 全来自英文值
`Meow memory`（11）→ `Macro Memory`（12）的两处各 +1；0.2.12 又 +7 B（版本号与降级文案）。**字节数变化必须同步进 README**，否则 doctor 的
「文档声称」段会红——这条也是 0.2.7 建立的机制在起作用。

### 21.4 改名会踩到「按名字匹配」的代码

这是本节唯一的真风险，也是实际踩到的一个：`lib/host/share.js` 生成单文件快照时，用
`put(out, '<title>记忆星图 · Memory Nebula</title>', '<title>… · 离线快照</title>', ' 标题')` 去页面里**按字面量**
找标题再替换，找不到就抛 `share: 页面结构变了，找不到 标题`。只改替换值、不改 needle，`buildShareHtml` 会在
这里抛错，把「分享快照」整条功能弄挂——而静态检查看不出来（两个字符串都合法，只是不再相等）。

处理方式不是「记得同时改两处」，而是**让机器验这一对相等**：`verify.mjs` A9 段断言
`share.js` 里的 needle 与 `lib/web/index.html` 的 `<title>` 一字不差（断言的是两者相等，不是各查各的）。
实测 `buildShareHtml` 输出 384,935 B 单文件快照、标题正确。

推广出来的规则：**凡是我们改了显示名，就要去找一遍「有没有代码用这个显示名当键」**——快照 needle、i18n 词典键
（`"宏记忆 · 星图": "Macro Memory · Graph"` 的键与调用处的字面量必须同改）、`data-zh` 属性。0.2.11 里 i18n 是
键值一起换的，所以一致；`share.js` 是唯一一处「两边都要改但只有一边在视野里」的地方。

### 21.5 验收

`verify.mjs` A9 段十六条：产物含 `"settings.title": "\u5B8F\u8BB0\u5FC6"` 且不含旧转义、英文值是 `Macro Memory`、
`build.mjs` 里钉着改名（含 `function replaceN(`）、i18n 带 0.2.11 标记、中英窗口标题都对、四个前端文件旧名
残留为零（`i18n.js` 允许留一处，但必须匹配文件头那句「原来叫「记忆星图」」）、水印是 `MACRO MEMORY`、侧栏
`var LABEL = '宏记忆 · 星图'`、注入横幅与工具描述/stats 抬头/口令页/快照 needle/导出与 CLI 抬头同名、融合层
`memory_link` 描述不再出现旧名、doctor 账本记着五条。`tools/doctor.mjs` 七段 ALL PASS。






## 22. 加料失败不许污染主语（0.2.12）

### 22.1 这类 bug 为什么最难被发现

0.2.10 的验收是「星图缺席时八个入口都不报错」。八个入口**确实**都不报错——`memory_search(mode="graph")` 退回本地、
`memory_link` 排队、`memory_read` 只出正文。但 `memory_search` 还有一条**不带 mode 的普通检索**：它带 `expand`
（或零命中自动扩散）时，扩散结果是被**直接拼上去**的：

```js
return `${main.text}\n\n— 星图关联扩散 —\n${spread.text}`
```

主语（本地检索）成功、加料（扩散）失败，于是**内部错误出现在一个成功的结果里**。它不会被「不报错」这类断言抓到：
工具没抛异常、返回值非空、主语内容也对。只有人把它当模型来读——「这条结果到底能不能信」——才会发现尾巴上那句
「这项能力还没就绪」会让人怀疑整个工具面。

**教训**：降级一旦按「入口」列清单，就会漏掉**同一条路径里的第二段**。0.2.10 的对照表是七行入口，0.2.12 补的是
第八行：「local 模式的 expand 段」。

### 22.2 两种失败，两种措辞

`tryCall` 兜住的失败被压成一句话，但它的**来源**有两种，处理方式必须不同：

| 来源 | 判据 | 该怎么说 |
|---|---|---|
| 星图没装配 / 被关掉 / 引擎没起 | `isNotReady()`：文案含 `bridge.call` 抛的「这项能力还没就绪」 | 环境问题，**不转述**，只说「星图这次没接上」，加料就直说「没加」 |
| 星图说这一步不行 | `isPermanentFailure()`：「找不到这两条记忆」「不能和自己配对」 | 内容问题，**转述原话**，因为用户要据此改 id 或改动作 |

0.2.11 之前两个判断各写各的（一个在 `defs/link.js` 里用 `includes` 认字符串），0.2.12 把它们一并收到
`lib/macro/links.js`：`NOT_READY_MARK` + `isNotReady()`，与 `isPermanentFailure()` 并列。判据只认 bridge 的原话——
这是**跨文件耦合**，所以 verify A10 里专门有一条断言 bridge 那句话还在（bridge 改文案时这里必须跟着改，否则
降级会静默失效，变成「没认出来 → 转述内部错误」）。

### 22.3 为什么这条靠探针而不是靠读代码

改完之后 `search.js` 多了一行 `if (!spread.entry) return …`，肉眼完全看不出它对不对——对不对取决于
「`tryCall` 失败时 `entry` 真的是 undefined 吗」「星图缺席时走的是这条路吗」。所以验收落在
`tools/probe-fusion.mjs` 的 **G12/G13**：拿一个「只有 meow、没有星图」的 bridge 真的跑一遍，断言结果里
**不含** `未完成` 与 `这项能力还没就绪`、**含**「关联扩散没做」。这也是 0.2.10 那批 G1–G11 的写法延续：
降级的验收标准是「模型读到的字」，不是「异常没抛」。

### 22.4 验收

`verify.mjs` **A10** 段六条：判据在 `links.js` 且与 `bridge.js` 原话一致；`search.js` 扩散失败有 `if (!spread.entry)`
分支且文案含「关联扩散没做」；`link.js` 排队分支走 `isNotReady`；探针里 G12/G13 两条断言存在。
`probe-fusion.mjs` **G12/G13** 实测通过。版本 0.2.12，`lib/client.js` 162,806 → 162,813 B。


## 23. 一条命令跑完所有自检，而且它真的抓到了自己（0.2.13）

### 23.1 漏跑一支脚本，等于漏掉一类回归

到 0.2.12 为止，发版前的验收动作是**手抄一段 PowerShell 循环**——十支脚本名写在临时命令里，跑完人读输出。
十支里没有 `tools/probe-inject.mjs`。于是从 0.2.11 起它就是红的：它断言「注入文本长度 = RULE（689 字符）」，
而 0.2.11 把星图改名叫「宏记忆 · 星图」，RULE 里几处各 +4 字符，实际 693。

**这条 bug 活了十个版本**，原因完全不是它难——是没人跑它。这也是「一套自检」和「一条命令跑自检」的区别：
前者是清单，后者是纪律。清单会漏，纪律不会。

### 23.2 断言的应该是性质，不是字数

修法不是把 689 改成 693——那会在下一次改名时再断一次。改成「仍是 RULE 量级（< 800 字符）」，因为这条断言
真正要守的是**「没把每轮邻域注入偷偷塞回来」**（旧版每轮注入是 KB 级，800 这个上限足够分辨），而「字数恰好是 689」
只是当时那版文本的偶然属性。

**教训**：写死的数字会把「改文案」变成「修探针」。探针里每个魔法数都要能回答「它代表哪条不许退化的性质」，
答不上来就该换成区间、换成结构断言、或换成与源码里的常量比对。

### 23.3 顺手修掉的第二个毛病：探针把临时数据建在工程目录里

`probe-inject.mjs` 原来的临时 `DSH_HOME` 是 `D:/dsh-home/vendor/dsh-macro-memory/.probe-home`——在**工程目录**
里。两个后果：doctor 的两棵树比对会把它当漂移；真实星图工具如果指错路径，会把探针数据当成用户的图。
现在统一 `mkdtempSync(join(tmpdir(), 'macro-inject-home-'))`。这也是 A8「会真跑工具的脚本必须沙箱 DSH_HOME」
那条硬约定的延伸：**沙箱要沙到系统临时区，不是沙到工程目录里**。

### 23.4 check-all 的四个设计点

1. **顺序是知识**：`doctor` 必须最后（要读两棵树同步与备份目录），`probe-graph` 要在前面（要给真引擎时间）。
   清单按字母排会毁掉这个知识。
2. **只读**：不调 `build.mjs`（那会写产物）。验收命令不许有副作用。
3. **不用管道收输出**：本机沙箱下 Node 的 `stdio: 'pipe'` 会 EPERM（开不了命名管道），所以子进程的
   stdout/stderr 一起重定向到临时文件：`spawnSync(node, [script], { stdio: ['ignore', fd, fd] })`。
   这条写进 verify A11——谁改回管道谁红。
4. **两个受众**：人读给「✓ 11/11 通过（用时 74.5s）」，机器读给 `--json` 的
   `{version, ok, total, failed, steps[]}`。

### 23.5 验收

`verify.mjs` **A11** 段八条：清单齐全十一支（列缺哪支）、`doctor` 排最后、走 fd 不走管道、`--json`/`--only` 都在、
不调 `build.mjs`、README 有出处、注入探针不再写死字数、注入探针不在工程目录留 `.probe-home`。
实测：vendor 与 profile 两棵树 `node tools/check-all.mjs` 都是 11/11 通过、退出码 0；`probe-inject` 17/17。
版本 0.2.13，`lib/client.js` 仍 162,813 B（本轮没动前端代码，版本号等长替换）。

## 24. 原文优先：检索结果不许被「表述归口」改口（0.2.14）

### 24.1 这条规则是从哪儿越界的

0.2.1 立「表述归口」的动机是对的：工具面收成 8 个之后，子插件返回文本里还写着 `nebula_recall`、
`memory_find_similar`、`meow-memory`，而这些名字在 `compatAliases=false` 时**根本没有注册**——模型照着调
只会拿到「工具不存在」。于是 `lib/macro/brand.js` 做了 `BRAND_MAP` 的**全局字符串替换**，作用点是
`bridge.call()` 渲染后的整段文本。

问题在于：`bridge.call()` 既是「界面文案」的出口，也是「记忆原文」的出口，两者共用同一个渲染函数。
把替换套在后者身上，就等于**插件改写用户的账本**。

### 24.2 为什么这类 bug 特别难发现

1. **它长得像正确行为**。输出里没有报错、没有异常、措辞通顺，只是名字变了——只有当你记得自己存了什么，
   才会发现不对。
2. **存储是干净的**。直接查 `ws/.dsh-meow/memory.db` 的 `content` 字段，原文一字未改；被改的只在渲染层。
   所以「数据有没有坏」这个问题会得到错误答案，除非你去查库。
3. **改口方向看起来「更好」**：`nebula_recall` → `memory_search（mode="graph"）` 正好是模型该用的名字。
   它把失真伪装成一次升级。
4. **读改写才致命**：`search → read → update` 是记忆插件的日常动作。被改口的文本一旦被写回，
   失真是永久性的，而且此后再查库也看不出来了。

### 24.3 判据：这个工具的返回值是「谁的字」

改口是否允许，只取决于一件事：**返回文本里的字是融合层的，还是用户的。**

| 类别 | 工具 | 处理 |
|---|---|---|
| 记忆原文 | `memory_search` / `memory_read` / `memory_remember` / `memory_update` / `memory_find_similar` / `nebula_recall` / `nebula_inspect` / `nebula_bridge` / `nebula_path` | **一字不动**，末尾追加旧名对照 |
| 界面文案 | `memory_admin`（stats / guide / links / cost / sources / hygiene）、`memory_link` 的回执、`memory_dream` | 照旧 `brandText` |

名单落在 `lib/macro/bridge.js` 的 `CONTENT_TOOLS`，分流只有一行：

```js
const decorate = CONTENT_TOOLS.has(name) ? hints : brand
```

`hints` 就是 `brand.withNameHints(text)`：正文原样，末尾补一句

```
（以上正文是记忆原文，一个字没动。里面的旧名字按宏记忆的说法是：nebula_recall → memory_search（mode="graph"）；
meow-memory → macro-memory——要调就调箭头右边的。）
```

这样 0.2.1 的初衷（别让模型拿着调不到的名字去死磕）与 0.2.14 的底线（别动用户的字）同时成立：
**改口从「替换」降级为「注释」**。

### 24.4 三个工程细节

1. **幂等靠标记**：`ORIGINAL_MARK = '一个字没动'`，`withNameHints` 见到它就原样返回。否则「读一次加一条」
   在多次渲染的链路上会越叠越长。
2. **`memory_remember` / `memory_update` 也算内容型**：它们的回执会**回显**关键词与项目名——回显被改口，
   用户会以为自己存进去的就是那个样子。回执也是账本的一部分。
3. **`compatAliases=true` 两条路径都短路**：A/B 对比要的是原味，注释也不要。

### 24.5 验收

`verify.mjs` **A12** 段十一条：`nameHints`/`withNameHints` 存在、幂等靠标记、`aliases` 短路、内容型名单六项齐全、
`CONTENT_TOOLS.has(name) ? hints : brand` 分流、`hints` 是 `createBridge` 的选项、`index.js` 接上、两支探针的
断言语、README 出处都在。

`tools/probe-fusion.mjs` **H1–H7** 用真引擎（真 meow + 临时 `DSH_HOME`）跑一遍完整链路：写入含旧名的记忆 →
检索正文仍是原文 → 读取**与写入时逐字一致** → 反复读只一条对照 → 界面文案该改口还得改口 →
`withNameHints` 幂等且 `aliases` 原样。

`tools/probe-host.mjs` 把原来那条「所有输出都不含旧工具名」拆成 **F5**（界面文案干净）与 **F5b**（正文里出现
旧名时必须带「一个字没动」的对照）。对正文来说「含旧名」本来就是对的，义务只是别改它——一条断言管两件事，
迟早会逼着下一个人做错选择。

## 25. 透传面：facade 的职责边界（0.2.15）

### 25.1 一个 Proxy 的两侧

`lib/macro/bridge.js` 的 `createFacade(real, bridge, vendor)` 是个 `Proxy`，`get` 里只有三条特判：
`tools`、`systemPrompt`、`get`。其余全部 `Reflect.get(real, prop)` 并 `bind(real)`。这个设计从 0.1 就在，
一直没出过事——因为它靠的是「不改 vendor」这个前提，而 vendor 是拷贝进仓库的固定版本。

风险是**两侧**的：

- **拦多了**：只要有一处 `get` 分支写错，meow 的 `/dream` 命令、dream 图标路由、会话钩子就全没了。
  融合层的工作方式是「在外面套一层」，最容易犯的错就是套得太紧、把人家的通风口一起糊住。
- **拦少了**：`ctx.get('tools')` 是 cordis 里拿工具服务的正规写法，facade 原样透传出去的是宿主的服务，
  于是子插件有一条完全合法的后门。

### 25.2 为什么这两类问题一直没被发现

因为**探针的假 ctx 比真 ctx 穷**。`tools/probe-fusion.mjs` 里 `on: () => noop`，`get` 只认两个服务——
于是「命令注册丢了」在探针里表现为「meow 注册了 0 条命令」，而探针从不数这个数字，它永远是 0，看上去
「本来就该是 0」。这类缺陷的共同特征：**观测面比缺陷面窄**。修法不是加断言，是先把观测面补宽
（给 meow 备上 `commands`/`webServer`/`sessionPersistence`，并记录 `ctx.on` 的每一次调用），断言才有意义。

顺带暴露出另一件事：假 ctx 缺服务时，meow 会走它自己的「等 20 秒再警告」的降级路径，探针白等 20 秒。
补上服务后 probe-fusion 从 ~20s 降到 **2.9s**。**观测面窄，往往同时也慢。**

### 25.3 口子只留一个

`get('tools')` 与 `ctx.tools` 必须指向**同一个** facade 对象，`get('systemPrompt')` 与 `ctx.systemPrompt` 同理。
「同一个入口」比「两个入口行为一致」更可靠：前者是恒等式，后者需要长期维护。

`ctx.get` 的其它名字一律 `real.get?.(name)`，不做任何包装——那些服务（`commands`、`webServer`、`settings`、
`connection`、`agentDefaultModel`…）的语义是 vendor 与宿主之间的事，融合层没有立场介入。探针 **I7** 用
`===` 钉住这一条：`ctx.get('commands')` 拿回来的必须就是宿主那个对象。

### 25.4 反向验证

断言「加了守卫生效」很容易，难的是证明「没这条守卫真的会坏」。做法是**临时拆掉再跑同一段代码**：
把 `if (name === 'tools') return toolsFacade` 删掉、写进临时模块 import 进来，再跑那个
`ctx.get('tools').register({name:'shadow_tool'})` 的合成插件——宿主当场收到 `["shadow_tool"]`；带守卫时
宿主收到空数组、工具落进 `bridge`（`names()` 里查得到）。这一步不进 CI（会改源码副本），但结论写进
README §9.20，作为「这条守卫为什么必须存在」的证据。

### 25.5 验收

`verify.mjs` **A13** 十一条锁住：`get('tools')` 走 facade、`get` 只特判 `systemPrompt`/`tools` 两个名字、
探针记录三条通道、探针备齐三个服务、I1–I7 的断言语、README 出处。`tools/probe-fusion.mjs` 新增
**I1–I7** 共八条断言，合计 **82 PASS**，2.9 秒。版本 0.2.15，`lib/client.js` 仍 162,813 B（本轮不动前端）。

## 26. 门牌：融合把三个面收进一个插件，说明书不能只写一个面（0.2.16）

### 26.1 工具中心病的成因

融合层的产出是「8 个工具 + 1 段注入」，于是所有的工程注意力天然落在工具上：参数审计查工具参数、
探针跑工具输出、文档按工具编号。久而久之，注入文本也只剩工具——`GUIDE_TEXT` 从 0.1 起就是「8 个工具怎么用」。

问题在于：**用户手上不是只有工具**。meow 原本还挂 `/dream`、`/meow-trust` 两条命令和两个面板。
0.2.15 的探针已经把「它们确实还挂在宿主上」钉住了（I1–I4），但注入里一句都没提。模型读者不知道，
就等于用户不知道；用户不知道，就等于那个功能对他不存在。

这是「不能砍 meow 原有功能」这条红线的一个容易被忽略的读法：**砍不一定是删代码，藏起来也是砍。**

### 26.2 两层说明书，各加一句

- **L0（每轮注入）**：加一句 60 字符的面位清单。它必须短——L0 每轮都付费，`GUIDE_MAX_CHARS = 1300`
  是硬预算，`clampGuide` 会在行边界截断兜底。
- **L2（按需手册）**：在 vendor 原文前加 `NAV_TEXT`。原文不改，因为它是对的（它讲自己的世界），
  我们缺的是门口的牌子，不是重写人家的书。

### 26.3 不该顺手「统一」的东西：命令名

看到 `/meow-trust` 与「宏记忆」不同名，第一反应是改成 `/macro-trust` 顺手注册一个别名。这一版明确不做：

- 命令名是**用户肌肉记忆**的一部分，改名收益是「整齐」，代价是「昨天还能用的东西今天没了」。
- 加别名则是「两个名字做同一件事」，长期要维护两套文档，还要回答「到底该敲哪个」。
- 0.2.11 改的是**显示名**（抬头、标题、面板 label）——那是我们自己的品牌面；命令名是 vendor 的 API 面，
  融合层没有立场动它。

判断写进 `NAV_TEXT` 本身，让模型也能讲清这件事。

### 26.4 门牌不许说谎

硬编码命令名 = 埋一颗「vendor 升级后手册指着不存在的命令」的雷。所以门牌与 vendor 源码做**交叉核对**：
`verify.mjs` A14 直接读 `vendor/meow-memory/lib/index.js`，断言 `name: "dream"` 与 `name: "meow-trust"` 都在；
`probe-fusion.mjs` J7 在运行时再核一次。vendor 改名 → 两处同时红，手册不会静默失真。

### 26.5 验收

`verify.mjs` **A14** 八条；`tools/probe-fusion.mjs` **J1–J8** 八条（三面、原文仍在、无内部错误、
L0 也点了三面、命令名一致、clamp 预算）。实测 `verify` **158 PASS**、`probe-fusion` **90 PASS**。
版本 0.2.16，`lib/client.js` 仍 162,813 B / `1bba6b5f`（只动服务端文案，前端零改动）。

## 27. vendor 账本：拷贝进来的第三方源码怎么证明「没被谁动过」（0.2.17）

### 27.1 问题的形状

本项目把两个子插件**当源码拷进** `vendor/`（§11.3 解释过原因：上游没有可用发布物、而且必须能在文件里打补丁）。
拷贝带来一个结构性缺陷：**它和上游之间没有任何可核对的关系**。

两种坏法方向相反：

| 方向 | 症状 | 已有防线 |
| --- | --- | --- |
| 上游升级重拷 → 冲掉我们的补丁 | 行为退回上游（归档记忆又出现在检索里） | 补丁账本（§9.14 / doctor `PATCHES` 7 条） |
| vendor 被整段换成别的东西 / 被手改半个字 | 补丁标记仍全在 → **全绿** | 无（0.2.17 前） |

第二行就是漏洞：所有断言都是「某个字符串在不在」，把整个文件换成一个仍含那些字符串的版本，断言全过。
**基于内容存在性的检查，防不住内容级别的替换。**

### 27.2 选择：树指纹而不是文件清单

账本 `vendor/VENDOR.json` 每条 6 个字段：`dir / name / version / files / bytes / sha256`。
`sha256` 是**整棵树的聚合指纹**：按路径排序，把每个文件的 `路径:sha256` 逐行拼起来，再哈希一次。

为什么不逐文件列 44 + 51 条：

- 账本会被 `doctor` 每次读、会被 git diff 看；95 条逐文件哈希会让「这次发版真的改了哪」淹没在噪声里。
- 聚合指纹改一个字节就变（实测给 `style.css` 追加 `/*x*/`：`bbfe1444…` → `fab0a0d4…`），
  防篡改能力足够；真要定位「哪个文件变了」，跑 `node tools/make-vendor-manifest.mjs --print` 前后对比即可。
- `files` / `bytes` 两个廉价计数保留下来：**文件被删掉一个但总字节碰巧相等**这种概率极低，但计数能
  在指纹之外给一条独立信号，且人眼可读。

### 27.3 三个工程约束

1. **算法只有一份实现**（`tools/vendor-hash.mjs` 的 `hashTree` / `listFiles` / `SKIP_DIRS` / `vendorPackage`）。
   生成方 `tools/make-vendor-manifest.mjs` 与核对方 `tools/doctor.mjs` 都 `import` 它。
   账本类功能最常见的死法是「生成按 A 算、核对按 B 算」，于是长期不一致、于是没人再信那个红。
2. **两个账本互补，不合并**。`VENDOR.json` 管「vendor 当前长这样」，`PATCHES` 管「我们故意打的那 7 处还在位」。
   合并成一个会同时丢掉两种能力之一：只有指纹时，改完文件重记账就把「补丁被改丢」洗白了；
   只有补丁时，整目录替换无人发现。
3. **反向核对**。doctor 除了遍历账本条目，还扫 `vendor/` 下的**目录名**，发现没记账的目录就 FAIL。
   「新拷一个插件进来但没人记账」比「改旧文件」更常见，而账本结构天生只看得见自己记过的东西。

### 27.4 账本不许自称可信

`VENDOR.json` 里没有任何签名、没有上游 URL、没有时间戳——它**只能证明「和上次记账时一样」**，
不能证明「和上游一样」。这个界限写进 README §9.22，避免以后有人把它当供应链证明用。
要真正对上上游，得重新拷一份上游源码做 diff，那是另一件事。

`verify.mjs` A15 顺手把账本自身的完整性也钉住：

- 版本号必须等于 `vendor/*/package.json` 里的 `version`（账本不能自己编一个版本）；
- `sha256` 必须是 **64 位十六进制**（防止「随手填个短串蒙过去」）；
- 六字段齐全、两个条目都在；
- 生成方与核对方都 import 同一份 `vendor-hash.mjs`。

### 27.5 验收

`doctor` 新增 `== vendor 账本 ==` 六条（条目数、两条版本的源码一致性、两条指纹一致性、未记账目录）；
`verify.mjs` **A15** 十一条。实测 `verify` **169 PASS**、`probe-fusion` 90 PASS、两树 `check-all` 11/11。
版本 0.2.17，`lib/client.js` 仍 162,813 B / `1bba6b5f`（本轮只动工具与文档，前端零改动）。

## 28. 断言数基线：让「绿」有第二个含义（0.2.18）

### 28.1 一个只靠退出码的验收体系，能骗过自己

`check-all` 的第一版语义是「十一支都没挂」。这语义有一个无法用断言补上的洞：

```
if (false) { ... 8 条断言 ... }   // 重构时先跳过
```

脚本依然 `ALL PASS`、依然 `exit 0`，`check-all` 依然 `11/11 通过`。
**退化的表现形式是「少了几条断言」，而退出码只看「有没有一条断言失败」**——两个维度，不重叠。

0.2.16 的 `probe-fusion` 从 82 涨到 90 是我们主动加；反过来的情况没人拦得住。
所以基线要记的不是「结果对不对」，而是**「断言还在不在」**。

### 28.2 为什么数 `PASS` 行，而不是让每支脚本报数字

理想解是每支脚本 `process.exit` 前打一行机器可读的 `#count 90`，全链路统一。代价是改十支脚本、并且
以后每加一支都得记得打——一个「记得就有效、忘了就静默失效」的约定，比没有更危险。

数行首 `PASS` 是**被动观测**：脚本什么都不用改。代价是它依赖输出格式，所以：

- 八支打 `PASS  …` 的脚本得到真实条数（verify 180、probe-fusion 90、probe-graph 26、probe-host 21、
  probe-client-ui 12、coverage-audit 7、param-audit 13、probe-inject 17、doctor 40）；
- `check-client-bundle`、`check-yaml` 只打 `ALL PASS`，读出来是 0，**照样记账**。
  0 不是「没有断言」，是「这一支的断言没有统一抬头」；记账的价值在变化时（0 → 12 会被 `↑` 抓到）。

选被动观测而不是主动上报，是刻意的取舍：**验收工具的可靠性不能依赖被验收者的配合**。

### 28.3 三态输出，而不是一态

| 变化 | 判定 | 为什么 |
| --- | --- | --- |
| 条数掉了 | 失败 | 只有这一种是「有人删了东西」，必须拦 |
| 条数多了 | 提醒 | 正常开发会加断言；判红会让人每天在红里工作，红就失去意义 |
| 未记账 | 提醒 | 新脚本第一次出现；判红会让「加一支脚本」变成改两个地方 |

输出用 `↓ / ↑ / !` 三个符号和跑挂的 `✗` 分开。**不同原因必须长得不一样**——否则使用者会用一个
错误的假设去修（把「断言少了」当成「环境挂了」，于是去重启 DSH）。

### 28.4 账本必须被另一个账本核对

`baselines.json` 有 `version` 字段，doctor 的第九段 `== 自检基线 ==` 强制它等于 `package.json`：

- 发版忘了 `--update-baselines` → 版本对不上 → 红；
- 新加一支脚本没记账 → 反向核对（读 `check-all.mjs` 的 STEPS 名单）→ 红；
- 条数写成字符串/负数 → 红。

这与 §9.22 的 vendor 账本是同一条原则：**任何「记录」如果不能被机器核对，它就会在下一次重构里
悄悄变成谎言**。基线自己也是断言的一部分，所以基线自己也要有断言。

### 28.5 验收

`tools/check-all.mjs`：`countPass`（`/^PASS/gm`）、三态判定、`--update-baselines`（`--only` 时合并旧账）；
`tools/doctor.mjs` 第九段三条；`verify.mjs` **A16** 十一条。实测 `verify` **183 PASS**、
两树 `check-all` 11/11（`断言数与基线一致（11 支，合计 410 条）`）。版本 0.2.18，
`lib/client.js` 仍 162,813 B / `1bba6b5f`（只动工具与文档）。

## 29. 耗时预算：把「卡住」变成一条能读的红（0.2.19）

### 29.1 无限等待是一种最坏的失败

验收脚本死等一个不会来的回调时，输出停在半行，退出码还没产生。此时使用者无法区分：

- 它还在算（`probe-graph` 真的需要 49.5 秒）；
- 它已经卡死（某个 `await` 永远不会 resolve）。

两种情况的**外部表现完全相同**，而处置方式完全相反（继续等 vs 立刻修）。所以「等多久算太久」
必须由机器判断，不能由人盯着屏幕猜。

### 29.2 预算 = max(30s, 4 × 上次实测)

三个数字都是被踩出来的，不是拍的：

| 参数 | 值 | 理由 |
| --- | --- | --- |
| 宽裕系数 | 4× | 同机不同负载能差一倍（扫盘、装包、冷缓存）。1.5× 会制造假红，假红让红失去意义 |
| 记账下限 | 30s | 0.1 秒的脚本给 0.4 秒预算，任何一次系统卡顿都误杀 |
| 首次预算 | 180s | 不知道它多慢时必须给足。第一版用 20s，第一跑就杀了 probe-graph(49.7s) 与 param-audit(20.6s) |

第四个数是隐含的：**超时那次不记耗时**。被杀掉的进程只证明「至少这么久」，
若拿来算预算，下一轮预算 = 4× 上次预算，会指数膨胀，直到预算失去意义。

### 29.3 停得下来，也要停得干净

```js
spawnSync(process.execPath, [join(root, file)], { …, timeout: budget, killSignal: 'SIGKILL' })
```

- 用 `SIGKILL` 而非默认 `SIGTERM`：等 I/O 的 Node 子进程不一定理会 `SIGTERM`，而我们要的是「一定停」。
- 超时在 `spawnSync` 的返回里表现为 `status === null` + `error.code === 'ETIMEDOUT'`，
  和「脚本自己 `process.exit(1)`」必须分开判：前者是**没跑完**，后者是**跑完了但结论是红**。
- 统一 `stdio: ['ignore', fd, fd]` 仍然有效：超时杀掉的进程，它已经写进文件的输出还在，
  可以照原样 tail 出来看它卡在哪一行。

### 29.4 三种原因，三个符号

| 符号 | 含义 | 人的下一步 |
| --- | --- | --- |
| `✗` | 脚本退出码非 0 | 看断言哪条红了 |
| `↓` | 断言少了 | 找「哪段被删/提前 return」 |
| `⏱` | 超过预算被杀 | 单独跑这一支看它卡在哪；确认本来就慢再重记预算 |

混成一个符号的代价是**人被引导去做错的事**——把卡死当成断言错，于是去改断言；
把断言少了当成环境问题，于是去重启。所以符号的数量等于原因的数量。

### 29.5 账本仍然要被核对

`doctor` 的 `== 自检基线 ==` 段多两条：每支都有 `budgetMs`；`budgetMs >= 2 × ms`
（有人手改小了 → 红）。这不是重复劳动：`baselines.json` 是手可编辑的 JSON，
如果没人核对，「预算」会在某次手改里悄悄变成 0 或者被删掉。

### 29.6 验收

`check-all`（`timeout`/`killSignal`/`ETIMEDOUT` 判定/三符号/首次 180s/超时不记耗时）、
`baselines.json` 的 `ms` 与 `budgetMs`、`doctor` 两条、`verify.mjs` **A17** 十二条。
实测两树 `check-all` 11/11；`probe-graph 49.6s / 预算 199s`，`param-audit 20.6s / 预算 83s`。
版本 0.2.19，`lib/client.js` 仍 162,813 B / `1bba6b5f`。

## 30. 耗时漂移：把「慢慢变慢」变成一句话（0.2.20）

### 30.1 预算挡不住的那种坏

0.2.19 的 `budgetMs` 是一道**上限**。上限只能说明「还没死」，说明不了「还健康」。
一支脚本从 2.7s 长到 20s，只要预算还是 199s，验收就一路全绿 —— 而人看到的「用时 75s」是一个
总量，它不会告诉你**是哪一支**长胖了。等哪天有人嫌慢去调预算，上限就变成了橡皮筋。

所以第二个问题不是「会不会卡死」，而是「有没有在变慢」。两者要分开答，因为**答案的性质不同**：
卡死是失败（判红），变慢是症状（要说话）。

### 30.2 为什么阈值取 1.5 而不是 2

- 2 倍时预算余量已经吃掉一半，那时候才知道，等于把发现时机推到「快满」；
- 1.5 倍在共享机器上会偶尔响。但这一声的代价是**一行 `~`**，不打断任何流程，也不改退出码；
- 反过来，漏掉一次真退化的代价是：它被写进基线、从此成为「正常」，再也响不了。

噪声下限 `SLOW_FLOOR_MS = 1_000` 是同一个思路的补丁：毫秒级脚本的倍率毫无意义，
0.1s→0.2s 报「慢 2 倍」只会训练人去忽略这个符号。

### 30.3 三个「不参与」

1. **超时不参与** —— 被杀的那次耗时是下界，拿它算漂移会让预算和漂移互相喂。
2. **没有 `ms` 记录不参与** —— 新脚本第一次跑没有参照，硬比只会报假警。
3. **不参与 `verdict`** —— `verdict` 仍然只看 `bad` 与 `regressed`。这条边界必须写死在代码里，
   否则「机器忙」就成了一次红。

### 30.4 记账要警告，因为记账就是改尺子

`--update-baselines` 会把当前实测写成新基线。这是必要的（换了机器、加了更严的校验），
但它同时也是**唯一能让漂移消失的操作**。所以它必须自己说一句：「你正在把 N 支变慢的记成新基线」。
这一句不是礼貌，是把「改尺子」这个动作从顺手变成有意识的。

### 30.5 交叉核对：两张表必须同名单

`ms` 与 `budgetMs` 是两张平行的表。任何一张少了某一支，漂移判定或预算判定会**静默失效**：
少了 `ms` 就永远「没有参照」，少了 `budgetMs` 就退回首次 180s 且不再有上限约束。
`doctor` 因此加了一条反向核对 —— 逐支比对两表是否有记录，不一致就红。
这类「两张表错位」是最难靠肉眼发现的一种，因为每一张单看都合法。

### 30.6 验收

`check-all`（`SLOW_FACTOR = 1.5`、`SLOW_FLOOR_MS = 1_000`、`ms > lastMs * SLOW_FACTOR`、
`!timedOut` 参与条件、行内 `~ 比基线慢`、汇总 `耗时变慢 N 支`、`verdict` 不变、JSON `slow` 字段、
记账警告）、`baselines.json` note、`doctor` 两条（阈值存在 / 两表同名单）、`verify.mjs` **A18** 十二条。
版本 0.2.20。

## 31. 存储层：把「路径」和「jsonl」从业务里拿出来（0.2.21）

### 31.1 那种「两边都对」的坏味道

坏味道最容易被忽略的一类，不是写错的代码，而是**两个各自都正确的文件之间的借用**：

```js
// lib/macro/links.js
import { macroHome } from './cost.js'
```

`links.js` 需要一个「数据目录」来算 `pending-links.jsonl` 的位置，而它刚好在 `cost.js` 里
看见一个 `macroHome()`。这行 import 不会报错、测试全绿、行为正确 —— 但它把两件无关的事
焊在了一起：**队列从此依赖成本账本的实现**。

判据很简单：**这个 import 能不能用一句话说成「A 是 B 的一部分」？**
「队列的成本目录」说不通，所以这行不该存在。

### 31.2 为什么「路径」必须只有一个出处

路径是那种**改了不会立刻炸、只会在别人机器上炸**的东西。它有两个出处时：

- 改 `macroHome()` 的算法（比如从 `~/.dsh` 换成 `$DSH_HOME`），只会改到自己抄的那份；
- 两份实现随版本漂移，最终一处写 `cost.jsonl`、另一处读 `cost.json`，两个文件都合法；
- 排查时你看的是「哪个函数算错了」，而真相是「有两个函数」。

所以定了一条硬约束：**全 `lib/` 里只有 `store.js` 允许出现 `process.env.DSH_HOME`**。
这条约束不需要人记 —— `doctor` 每次体检数一遍，多一个就红（`== 存储层 ==` 段）。

### 31.3 解析也只有一个出处

「读文件 → split → 逐行 `JSON.parse` → 跳过坏行」这段循环，在 cost 与 links 里各有一份。
两处都写着 `catch { /* 跳过坏行 */ }`，看起来一致，但只要有一处改成「坏行记日志」或
「坏行算一条空记录」，两份就会分叉 —— 而分叉的症状是「账本里少了几条」，没人会怀疑解析。

抽出 `readJsonl(file)` 之后，「坏行怎么办」这个问题只有一个答案，而且答案写在函数名旁边的注释里。

### 31.4 依赖方向要能被画出来

改完之后的依赖图是一棵树，不是网：

```
defs/*  →  linkflow.js  →  links.js  ┐
                       cost.js      ├→  store.js  →  node:fs
                                     ┘
```

`store.js` 在最底层，**不认识业务**：它不知道「成本」和「待补连线」是什么，只知道文件名与行格式。
这条边界带来的好处不是好看，而是：想给 macro 换一个数据目录（或改成用户可配置），
只需要改 `macroHome()` 一个函数，其余 15 个文件一行不动。

### 31.5 不改调用方，才算真的抽对了

`doctor` 与两个探针一直在用 `cost.ledgerPath()` 和 `links.pendingPath()`。
如果抽出 `store.js` 之后要去改这些调用，说明「抽的位置不对」——它们用的其实是**存储层的能力**，
只是以前从业务的门口借。所以 `cost.js` 保留 `export { ledgerPath }`、`links.js` 保留
`export { pendingPath }`：名字不变、位置不变，底层换了。

这也是验收里那条最容易漏的断言：**两个转发导出都在**。少了它，探针会静默换路径，
而它仍然全绿 —— 因为探针自己也是用新路径写的文件。

### 31.6 验收

`verify.mjs` **A19** 十二条：`store.js` 存在且五个入口齐全；全 `lib/` 只有 store 读
`process.env.DSH_HOME`；逐行 `JSON.parse(line)` 只有一份；`links` 不再 `import './cost.js'`；
`cost` 不再直接 `readFileSync`/`appendFileSync`；两条转发导出仍在；`doctor` 有「存储层」段；
README/DESIGN 有对应记录。
`doctor` 新增第十段（2 条），体检总段数 9 → 10。版本 0.2.21。

## 32. 动作表：枚举、分发、校验是同一份数据（0.2.22）

### 32.1 「合法但没实现」这种坏法

一个带枚举参数的工具，实际有三份清单：**schema 的 enum**、**execute 的 if/else**、
**自检脚本里手抄的期望列表**。三份都对得上时天下太平；只要漂一份，坏法就落在
最难受的位置上 —— **schema 承诺得最死的那一份（enum）** 漂了：

- 模型按 schema 选 action，选到一个「合法」值；
- execute 掉进 `未知 action=…`，模型只看到一句错误；
- 自检全绿：enum 没人核对，覆盖审计只跑它自己那几个。

这就是 0.2.22 之前的 `memory_admin`：`links` 在 enum 里，`tools/param-audit.mjs`
的期望列表里没有它（子集检查，所以 PASS）。**手抄的名单天生会漂，而且漂得悄无声息。**

### 32.2 判据：能不能把三份收成一份

一问就清楚：**这些值是不是「同一个东西」的三种写法？** 是 → 必须收成一份数据。
`enum` 与 `if/else` 描述的是同一件事（有哪些 panel），只是执行时机不同
（schema 校验时 / 调用时）。既然同一件事，就不该有两份。

```js
export const ACTIONS = { home: {…}, stats: {…}, … }
action: { enum: Object.keys(ACTIONS) }
```

于是「加一个面板」= 加一行，且只可能在唯一一处漂。

### 32.3 分发只认种类，不认名字

表之外，execute 里**不许出现任何具体 action 的名字**。三个种类：

| kind | 含义 | 失败时 |
|---|---|---|
| `call` | meow 自己的工具 | 必须成功，失败就是这个面板没有意义 |
| `graph` | 星图侧工具 | 走 `graphPanel` 降级，说清「这次看不了」 |
| `local` | 本地计算 | 不碰外部服务，也就没有降级分支 |

这条纪律有直接好处：0.2.10 定的「星图缺席要降级、不许把内部错误甩给模型」，
从此是**种类级**的承诺 —— 新加一个星图面板自动继承，不靠人记得。

`guard` 也挂到行上（`ingest` 的必填参数合并后 schema 收不住），分发代码里不再出现
`if (action === 'ingest')`。表里某行有、`local` 里没有实现，就当场报「在表里但没有实现」，
不许静默返回空串。

### 32.4 两类证据，缺一不可

- **源码层**（`verify.mjs` A20，十五条）：`enum: Object.keys(ACTIONS)`、
  **不存在**按 action 名写的 if/else、分发只按 `kind`、八行都有 `kind`、
  `ingest` 仍守必填、`graphPanel`/`tryCall` 还在、`guide` 的拼法没被重构改掉
  （0.2.16 的 A14 断言依赖那一行）。
- **执行层**（`tools/probe-fusion.mjs` K1–K5）：把 enum 里**每一个** action 真跑一遍，
  掉进「未知 action / 没有实现 / is not a function」就算死路；再验表外 action 明确报错。

只做源码层，重构后「表对、实现漏」照样过；只做执行层，enum 里多一个值
也能被跑挂抓到 —— 但抓不到「表与 enum 不是同一份数据」这件事。所以两层都要。

### 32.5 重构不许顺手改行为

重构的验收不是「测试还绿」，而是**逐条对得上**：

- 八个 action 的返回文本、降级文案、`ingest` 两条错误原文 —— 一字未改；
- `presentCall` 的卡片标题、`description` 的说明 —— 一字未改；
- 0.2.10（降级）、0.2.16（门牌）这两条旧承诺的断言 —— **没有一条被改写或删除**。

哪条旧断言需要动，就说明行为变了，得先说清为什么变。

### 32.6 验收

`probe-fusion` 95 PASS（原 90，+K1–K5）、`verify.mjs` 233 PASS（原 218，+A20 十五条，
其中「不再有按 action 的 if/else 链」用 `!/if \(action === '(home|stats|…)'\)/` 断言，
第一次就抓到 `guardIngest` 那一行残留 —— 纪律写成断言才守得住）。两树 `check-all` 11/11，
`doctor` 十段 ALL PASS。版本 0.2.22，`lib/client.js` 未动。

## 33. 加载面：判据的所有权——问 DSH，不抄它的规则（0.2.23）

### 33.1 为什么这件事不能靠我们自己的断言

体检里的「加载面」检查的是文本：`bundles` 数组里有没有 `dsh-macro-memory`、用户层 patch 里那条
`name: 'dsh-macro-memory'` 出现了几次。这两条都是必要的，但都只证明**文件这么写着**。

从「文件这么写着」到「会话里真的多出 8 个 `memory_*` 工具」，中间至少要过五道闸：

1. bundle 目录能不能解析出来（`resolveBundleDir`：安装锚点 → profile 自己的 node_modules）
2. `dsh.bundle` 声明在不在，`dsh.bundle.platforms` 允不允许本机
3. 版本兼容：`engines.dsh` 或 `peerDependencies` 里的 `@deepseek-ai/dsh-*` 范不范畴盖当前运行时
4. `dsh.bundle.patch` 指向的文件能不能被 DSH 的补丁解析器读成一个 patch 数组
5. 所有层装配完（bundle 层 + 用户层）之后，`macro-memory` 这条**还在、且没被禁用**

任何一道不过，症状都一样：装上了，但什么都没有，而且不报错。

### 33.2 判据归谁

这五道闸的判据全在 `@deepseek-ai/dsh-app-boot` 里。我们只有两个选择：

- 抄一份进自己的断言 → 上游改一次就悄悄过期，而且抄错了自己不知道（0.2.22 那三份清单的教训：
  `param-audit` 抄的期望列表少了 `links`，因为只做子集检查，一直绿）
- 直接 import 装好的那份，问它 → 判据永远和运行时同一份

选后者。`tools/probe-load.mjs` 只 import 一个模块，用它的导出函数说话：
`readProfileManifest`、`readProfileVersionExemptions`、`resolveBundleDir`、`bundlePatchPaths`、
`assertBundlePlatform`、`evaluatePluginCompatibility`、`pluginCompatibilityWarning`、
`loadOverlayPatches`、`composeEntries`、`getDshRuntimeVersion`。

### 33.3 为什么装好的那份和本仓源码都要问

DSH 加载的是 `profiles/desktop/node_modules/dsh-macro-memory`（我们靠 robocopy 同步过去的实体拷贝），
不是 `vendor/` 里的源码。只问装好的那份，清单写错要**先同步进 profile** 才会红——顺序刚好反了。
所以同一套判据问两遍：

- `DSH 加载的那份与本仓同版`：抓「改了忘了同步，DSH 在跑旧代码」
- `本仓这份源码按 DSH 的判据也兼容`：抓「`engines.dsh` / peer 写错」，同步之前就红

### 33.4 装配 ≠ 文本

第 5 道闸只能用 `composeEntries` 验：它是 boot 里那一次 `applyEntryPatches` 的同一实现，
输入是各 bundle 的补丁层 + 用户层，输出是最终条目列表。本机实测 222 条，我们那条是

```
{ id: 'macro-memory', name: 'dsh-macro-memory', disabled: false, config: { meow: {…}, nebula: {} } }
```

而它同时吐出的 17 条警告全在别的插件上（`patch: entry "redteam-store" not found` 这类）。
所以这一段的判红条件写得很窄：**只关心指向本插件的警告**，别人的问题只报数。
否则本仓会因为别人的 YAML 写错而红，那就变成噪音了。

### 33.5 只读，以及那个唯一的逃逸口

探针不写 profile 清单、不 apply 补丁、不 import 插件本体、不碰运行中的 DSH。
唯一的口子是 `PROBE_PATCH=<文件>`：把用户层换成指定文件，用来证明「被禁用」这条检查真会红。
平时不设，设了也只影响这一次进程的读路径。

找不到 DSH 安装时直接 FAIL（可用 `DSH_APP_DIR` 指过去）。理由很简单：这一条查不了的时候，
「能加载」这句话没有依据，不能因为查不了就写成绿。

### 33.6 验收

```
node tools/probe-load.mjs     # 14 条 PASS
node tools/check-all.mjs      # 12 支，含 probe-load
```

三条阴性对照都真跑过：`engines.dsh: ">=9.0.0"` → 红；`PROBE_PATCH` 里 `disabled: true` → 红；
删掉装好的那份 `lib/client.js` → 红。跑完都从原件还原，`probe-load` 回到「加载面成立」。

顺带一个反例教育：DSH 判兼容用的是 `semver.satisfies(runtime, range, { includePrerelease: true })`。
meow 的 peer `@deepseek-ai/dsh-llm: "*"` 在 `0.2.2-rc.3` 上是**成立**的。手抄规则的人很容易写成
「`*` 不匹配预发布」，然后就天天误报——判据只有一个出处，这条比任何一条断言都重要。

## 34. 运行态验收：别把日志轮转当启动时间（0.2.24）

### 34.1 两类问题，两把尺

`probe-load`（§33）问的是**能否加载**：给定清单、平台、版本、补丁，DSH 的判据怎么说。这是离线问题，
冷启动之前就有答案，所以在 `check-all` 里。

`accept-live` 问的是**现在这个进程在干什么**：宿主还在不在、前端产物有没有被发给页面、服务端代码这次
运行里跑过没有、日志里有没有指向本插件的 error、跑的是不是刚改完的这份。这是运行态问题，答案只存在于
那个活着的进程和它的日志里。

同一个仓库里两类尺子并排放，是刻意的：离线尺子防「以为能加载」，运行态尺子防「以为在跑」。

### 34.2 起点不能猜

第一版拿 `logs/desktop-next.log` 的创建时间当「这次运行的起点」，因为它看上去就是「本次运行开始的时刻」。
实测发现：进程 `22:48:26` 就起了，日志文件 `03:37` 才建——日志会轮转/重写。于是「启动时间晚于本仓
所有改动」被判成绿，而真话是「有 23 个文件在那次启动之后改过，跑的是旧代码」。

**错误的起点会让每一条依赖它的结论都反向。** 改法：问操作系统要进程创建时间
（`Get-Process -Name 'DSH NEXT' | Sort-Object StartTime | Select-Object -First 1`），问不到就
`INFO 查不到运行起点，这条不猜`——宁可少一条结论，不要多一条假绿。

### 34.3 只有两条判红

| 判红 | 理由 |
| --- | --- |
| 宿主不在跑 / 找不到日志 | 运行态无从查起，这时候说「通过」是撒谎 |
| 日志里出现指向本插件的 `[error]` | 有错就是有错 |

「服务端这次运行里没写过数据」「跑的是启动那一刻的快照」都只报告：前者刚起就没人调工具很正常，
后者是主人决定什么时候重启。**探针把事实说清楚，不替人做决定，也不催。**

### 34.4 不进 check-all

`check-all` 的语义是「代码现在什么状态」。`accept-live` 依赖「DSH 开着」，把环境依赖塞进代码体检，
结果是关掉 DSH 就红一片——那不是发现，那是噪音。要验收时手动跑，三秒出结论。

### 34.5 验收

```
node tools/accept-live.mjs    # 真实运行态：5 条 + 起点 INFO
```

本机实测：起点 `2026/11/18 22:48:26`；`pending-links.jsonl` 于 `00:48:44` 被写过（服务端那半截在那次
运行里真的执行过）；之后本仓改了 23 个文件，所以它明确说「要看到改动得重启 DSH」。

三条阴性对照（假 `DSH_HOME` + 旧日志）：日志 30 分钟没动 → 红；少了 client bundle 那行 → 红；
`[error] plugin dsh-macro-memory failed to load` → 红并回显原文。三次都只影响本来就该红的条目。

## 35. 面板口径：抬头、名字、默认值各一个出处（0.2.25）

### 35.1 坏味道：八个面板八套开头

`memory_admin` 的八个面板由三个不同的来源拼出来：meow 自己的 `memory_home`、星图的四个工具、本地的成本账本与待补队列。三种来源各有一套文案习惯，于是出现了三件本该一致却不一致的东西：

| 维度 | 以前 | 后果 |
| --- | --- | --- |
| 首行 | `# macro-memory 成本账本（…）` / `待补连线：N 条` / vendor 原文自己的开头 | 拿到一段文本不知道是哪个面 |
| 名字 | `action` 键、卡片标题、工具描述、手册四处各叫各的 | 同一件事四个名字，改一处漏三处 |
| 默认值 | `? 200 :` 与 `? 20 :` 散在两个方法里 | 换默认值要翻两处，且没有地方能一眼看全 |

这三件都不是「写得不好看」，而是**一个事实有多个出处**——和 0.2.21 的路径、0.2.22 的动作表是同一类问题，只是发生在文案层。

### 35.2 抬头为什么只加在上面，不改正文

正文是三种来源的原话：vendor 的手册与面板、meow 的 home、本地统计。**改正文等于改别人的话**，0.2.14 的原文优先在这里同样成立。所以抬头只做一件事：在正文之前插一行 `【宏记忆｜<面板名>】<口径说明>`。

这条设计的关键是：抬头**不携带任何数据**。它不说「共 222 条」「已连 17 条」——那些必须来自正文。抬头只说两件不出错的事：我是谁（名字），我的口径是什么（最近多少次、最多列几条）。

### 35.3 为什么手册不加抬头

八行里唯一 `wrap: false` 的是 `guide`。理由是它没有可报的口径：手册没有条数、没有时间窗；而且它的第一行必须是门牌（「宏记忆有三个面」），读者才不至于以为融合之后命令和面板都没了（0.2.16 的教训）。豁免写成一个字段 + 一行注释，而不是「忘了加」——**允许的例外必须写在代码里，不能只写在人的记忆里**。

### 35.4 名字只有一份

动作表每行多了 `label`（抬头与卡片标题用）和 `hint`（工具描述里那一句）。工具描述 `PANEL_SUMMARY` 由这两列拼出来：

```js
export const PANEL_SUMMARY =
  '宏记忆的运维面板：' + Object.entries(ACTIONS).map(([action, spec]) => `${action} ${spec.hint}`).join('；') + '。'
```

于是「加一个面板」的动作只剩一次：往表里写一行。枚举、分发、抬头、卡片标题、工具描述五处同时到位，不存在「schema 里有、描述里没写」或「描述写了、卡片还是键名」的缝。`presentCall` 也从 `记忆运维：${args.action}` 改成 `${PANEL_BRAND}：${ACTIONS[action].label}`——用户看到的是「宏记忆：星图概况」，不是「记忆运维：stats」。

### 35.5 默认值与参数说明

`defaultLimit` 写在表里，读取统一走 `panel.js` 的 `limitOf(spec, args)`：空值/非数/负数都回落到表里的默认值。以前两处 `args.limit === undefined ? …` 各自为政，还顺手暴露了另一处不一致——`limit` 的参数说明写的是「stats/hygiene/cost 的条数」，可 `links` 一直在读它（这正是 0.2.22 在 `param-audit` 里发现同一批清单漂移的同一个病）。

### 35.6 验收

- 结构：`lib/macro/panel.js` 只做三件纯事（抬头、包正文、读默认值），不认识任何具体 action。
- 证据（`tools/probe-fusion.mjs` L1–L6）：七个面抬头一致、八个名字两两不同、手册仍以门牌开头、正文没被顶掉、口径说明在、描述由表生成。
- 纪律（`verify.mjs` A23）：抬头字面量只允许出现在 `panel.js`；`wrap` 那一行**逐字**断言（阴性对照时改回直接返回正文，A23 与 L1/L5 同时红）；成本账本原来的汇总行必须还在。
- 反向对照证明这个抬头是唯一让八段文本长得一样的东西：把 `wrap` 去掉，探针打印出的正是八段互不相像的开头。

## 36. 桥拆三件事：按「A 是 B 的一部分」切，不按行数切（0.2.26）

### 36.1 坏味道：一个文件里三种改动频率

`lib/macro/bridge.js` 292 行，三件事的「改动频率」完全不同：

| 段 | 干什么 | 谁会来改它 |
| --- | --- | --- |
| `createBridge`（35–146） | 收下工具/注入、轮询等装配、转调、失败降级 | 加统一工具、改原文优先 |
| `createFacade`（182–285） | 三个 Proxy，把 `ctx` 换掉 | 几乎不动（动就是 ctx 契约变了） |
| `wrapPlugin`（288–292） | 把子插件包一层 | 几乎不动 |

问题不在行数，在**改 A 的人必须读懂 B**：改 `renderToolText` 的人眼前就是 `captureTool` 的 `tools` Map，很容易顺手「清理一下」，把有状态的东西碰坏。

### 36.2 切法：一句话能说清「它是谁的子集」才合并

- 桥：**有状态**（`tools` / `prompts` / `vendorTools` 三个容器），负责「收下与转调」。
- 换门：**无状态**，只负责「子插件看到的 ctx 长什么样」。
- 出文本：**纯函数**，输入 `(def, args, value)`，输出字符串。

三条各自独立成立，于是三个文件。反向检验：如果拆完 `render.js` 还得 `import` 桥，说明它其实不是纯函数，这个切法就错了——A24 直接把「`render.js` 不 import 任何东西」写成断言。

### 36.3 为什么必须保留转出（而不是去改 index.js 的 import）

拆结构的收益是「读的人少看无关代码」，代价不该转嫁给调用方。`lib/index.js:19` 一行不动，`bridge.js` 用 `export { createFacade, wrapPlugin } from './facade.js'` 和 `export { errText }` 转出。转出必须**是同一个函数**，不是同名副本——否则恒等比较会悄悄失效。M2 断言的正是恒等（`bridgeMod.errText === renderMod.errText`）。

### 36.4 一个曾经的坑：拆分不是「对半劈」

第一版想法是「前半 createBridge、后半 createFacade」，那只是把 292 行变成 146+146，读的人仍要读全部。判据得是语义：**「A 是 B 的一部分」说得通才放一起**，说不通就是两个文件。

### 36.5 验收

- `verify.mjs` A24 十二条：三个文件各只有一件主角、Proxy 只在 `facade.js`、`render.js` 无 import、无环（facade/render 不回头 import bridge）、`index.js` 的 import 未变、`bridge.js` 只转出不重复实现；
- `probe-fusion.mjs` M1–M5：入口齐全、转出恒等、换门后服务透传、出文本优先 vendor render、render 抛错退回 JSON；
- `doctor` 新增「结构」段四条（含「Proxy 不在 bridge.js」）。

## 37. 项目根的单一出处（0.2.27）

### 37.1 坏味道：同一个事实五套算法

`tools/` 下每个脚本都要读「本仓的文件」和「vendor 里的两个真引擎」。这么基础的一件事，
二十个脚本写出了五种算法：`dirname(dirname(fileURLToPath(…)))`、带 `/tools$` 的 replace、
`process.cwd()`、写死的 `D:/dsh-home/…`、`resolve(import.meta.dirname, '..')`。

前两种只是啰嗦（读代码的人要先在心里算一遍才敢确认它指哪）；后三种是真毛病：

- `process.cwd()`：**根变成运行时状态**。同一个脚本从两个目录跑，读的是两套文件，
  其中一套根本不存在（param-audit 实测 `ERR_MODULE_NOT_FOUND`）；
- 写死绝对路径：**根变成机器状态**。换台机器、换个安装位置，脚本当场废，而且废得很安静；
- `import.meta.dirname` + `resolve('..')`：等价于第一种，只是更隐蔽——
  你 grep `fileURLToPath` 的时候抓不到它。

### 37.2 为什么必须只留一处

判断「这个脚本从哪读文件」不该靠读它的实现。每加一个脚本就多一份真相，就等于每加一个脚本
都要重新回答一次「它算对了吗」。收成一处之后，这个问题在其它脚本里变成语法问题：
没有 `const root = …` 可写，只有 `import { root }` 可用。

单一出处不是「少写几行」，是把一个**每次都要人验的判断**换成一个**一次验完的接口**。

### 37.3 检查器不该替被检查者补环境

`check-all.mjs` 原来用 `cwd: root` 起子进程。这在直觉上是「贴心」——省得脚本自己找根；
在验收上是**假绿**：param-audit 拿 `process.cwd()` 当根，在 check-all 里永远是对的，
因为 check-all 把它放在仓根上跑。它自己的毛病要等到有人手动从别的目录跑一次才暴露。

一条检查器如果顺手把环境摆好，它检查的就不是脚本，而是「脚本 + 我补的场」。
所以现在 `cwd: neutralCwd`——一个与项目无关的空临时目录。**没人替它补环境，
依赖就无处可藏**：谁偷用 cwd，那一支立刻红。

### 37.4 例外要写进断言，不能只是「漏了」

`probe-inject` 只经相对 import 读 vendor，`check-yaml` 只读 DSH 安装与 profile——
这两支没有「仓内根」可算，不该被要求 import `_root.mjs`。但「不该」不能靠人记：
例外写进 verify 的 `NO_ROOT` 表，每条带理由，并且再验一次
「被豁免的脚本确实没碰 `root`」——否则这张表就是逃逸口，以后谁都能往里塞一条。

### 37.5 判据里不能引用反例原文

中性 cwd 那条最初的写法是「文本里不含 `cwd: root`」。它红了——
因为新加的注释里恰好写着「以前这里写 `cwd: root`」。拿整段文本判真假，
会被自己的说明文绊倒（0.2.23 那次断言里含 `probe-load` 是同一个坑）。
现在的判据只看**代码行**：去掉注释行之后再找。

### 37.6 验收

- verify **A25 十一条**：唯一出处、三种旧写法绝迹、`import.meta.dirname` 绝迹、
  十支取根 / 两支例外、例外表不藏私、中性 cwd、doctor 自己也按 root 拼、两处文档出处；
- doctor 结构段一条：`根只有一处出处（tools/_root.mjs）`；
- 实测：十二支在空目录里跑全绿（以前 param-audit 从别的目录跑必然 `ERR_MODULE_NOT_FOUND`）；
- 阴性对照：把某一支的 `root` 改回 `process.cwd()`、或把 `cwd` 改回 `root`，
  断言与 check-all 都要红。

## 38. 预算是一种承诺，不是一句注释（0.2.28）

### 38.1 坏味道：注释写了预算，代码只有「开始前比一次」

`flushPending` 的老结构是：

```js
for (const entry of list.slice(0, limit)) {
  if (Date.now() - started > budgetMs) { stopped = 'budget'; break }
  … await resolve(…)…
  … await tryCall(…)…
}
```

看起来是有预算的。实际上它约束的只是「**开始下一条**的时机」，
而每条里面那两三个 await 各自可以跑满自己的上限（`toolWaitMs` 默认 30s）。
预算 1.2s 的补连，最坏能跑成 1.2s + 若干次 30s。

更麻烦的是**注释与代码不一致**：读代码的人会以为读路径是有延迟上限的，
于是不在别处做保护（不在读路径加超时、不在调用方兜底）。这种不一致比没有预算更危险。

### 38.2 为什么 `tryCall` 的超时帮不上忙

`bridge.call(name, args, exec, timeoutMs)` 里的 `timeoutMs` 只交给 `awaitTool`——
它等的是「子插件把这个工具注册出来了没有」。工具一旦在 `tools` Map 里，
`await entry.def.execute(args, exec)` 就完全裸露，没有任何超时。
拆开看很合理（桥不该替子插件决定一次执行能跑多久），合起来看就出现缺口：
**没有任何一层对「一次读操作的总耗时」负责**。

0.2.28 让调用方（`links.flushPending`）负起这个责：它在每一次 await 外面套 `Promise.race`。

### 38.3 掐断要留，不能摘

超时和「永久失败」看起来都像「没连上」，但处置相反：

| 情况 | 处置 | 理由 |
|---|---|---|
| 超时 / 预算用完 | **留着**，下轮再补 | 只是这次没来得及，债还在 |
| 归不出完整 id | 摘掉 | 记忆已删/已合并，永远连不上 |
| 星图说「找不到这两条记忆」 | 摘掉 | 重试一万次同样结果 |
| 星图整体没接上 | 停手，**队列原样** | 环境问题，不是这条线的问题 |

代码上用一个独立 `Symbol` 当哨兵，就是为了让「超时」在类型层面不可能被当成 `null`（归不出）：
`ra === TIMED_OUT` 与 `ra === null` 是两条不同的分支，写在相邻两行，谁都改不错。

### 38.4 计数也要诚实

`tried` 原来报 `Math.min(list.length, limit)`。这个数不是「试了几条」，是「最多能试几条」。
被预算掐断时它仍然报满，面板上就变成「试了 8 条，一条没成」——把「没来得及」说成了「都失败了」。
现在 `tried += 1` 只在实际动手前加，掐断的那条会 `tried -= 1`。

### 38.5 用慢桩证明「真掐断」

快桩测不出预算：无论有没有 `withBudget`，快调用都能在预算内跑完，断言全绿。
所以 N 系列必须用**故意慢**的桩（`setTimeout` 800ms），并且同时断言两件事：

1. 返回值说的是 `stopped === 'budget'`；
2. **墙钟时间**小于那个慢调用的耗时（`ms < 700`）。

只断言第 1 条会假绿——把 `withBudget` 删掉，慢调用跑完 800ms 之后同样会走到某个分支，
只要那个分支被写成 `'budget'`，断言就过了。第 2 条才是「没有等它」的证据。

### 38.6 验收

- `probe-fusion` N1–N5；verify `A26` 八条；doctor 一条结构断言；
- 阴性对照两条：拆掉 `withBudget`（N1 的墙钟断言红）、`tried` 改回 `Math.min`（A26 红）；
- 一条连带的旧断言必须改：verify「队列: 归不出的条目被清掉」原来给 `budgetMs: 100`，
  加上 `MIN_STEP_MS = 120` 之后它一条都不试了——**测试的预算也得 ≥ 一条的发令时间**，
  并在注释里写明这条测的是「归不出 id 就摘」而不是预算。

## 39. 另一套仓库的文字，就是我们的接口（0.2.29）

### 39.1 问题不在「写死」，在「写死在三处」

`linkflow.js` 的 `graphState()` 要判断星图那边的状态，可星图的 `nebula_inspect` 返回的是一段给人看的文本
（`vendor/dsh-memory-nebula/lib/index.js:163` 的 `execute` 是 `return lines.join('\n')`，没有任何结构化值）。
所以「这条记忆还没入图」这个结论，只能从「星图里没有」这几个字里读出来。

0.2.29 之前，这句话在 `linkflow.js`、`links.js`、`bridge.js` 里各写一遍（后者写的是我们自己抛的
「这项能力还没就绪」）。三处、三个字面量、没有一处被断言盯着。**对面是另一个仓库、另一套版本节奏**，
它改词时我们不会崩，只会静默退化：`graphState()` 不再认出「没入图」，于是从「等 12 秒再连」
退成「立刻去连、失败就排队」。用户看到的是「补连好像变慢了/变笨了」，不是报错。

### 39.2 集中到一个文件只是「好改」，守门断言才是「不会坏」

`lib/macro/contract.js` 把五个措辞收成常量，每个常量旁边写着原文出处。这只解决「改的时候只改一处」。
真正让人放心的是 verify 里那两条**去读 vendor 源码**的断言：

```js
nebIndex.includes('星图里没有 id=${id} 的记忆') && nebIndex.includes('已固化连线：')
nebCore.includes("'找不到这两条记忆：'") && nebCore.includes("'不能把一条记忆和它自己配成一对：'")
```

对面一改词，我们的 verify 先红。这跟 0.2.26 拆桥是同一个思路的两种用法：
那边是「结构上不可能写错」（`facade.js` 没有状态，改换门的人碰不到 `captureTool`），
这边是「写错了立刻有人喊」（断言盯对面）。能靠结构解决的靠结构，只能靠约定的就配一条守门断言。

**守门断言必须盯「那一句」，不能盯「文件里有这几个字」**。`lib/index.js` 里「星图里没有」
出现 4 次（第 62 行 recall、第 163 行 inspect、第 248 行说明文、第 267 行另一句），
所以 `nebIndex.includes('星图里没有')` 这种写法在改掉关键那句后**仍然是绿的**——
0.2.29 第一次跑阴性对照时就是这么假绿的。现在按整句认（`星图里没有 id=${id} 的记忆`），
改一个字立刻红。**守门断言的正确性，只能由「改对面一个词、这里必须红」来证明**。

### 39.3 判据有稳的和脆的，顺序不能反

`graphState()` 有三种答案，其中两种靠得住：

| 状态 | 判据 | 稳不稳 |
|---|---|---|
| `'unavailable'` | `probe.entry === undefined`（桥没拿到工具） | 稳，结构 |
| `'ready'` | 文本非空 | 稳，结构 |
| `'pending'` | 文本里有「星图里没有」 | **脆，靠措辞** |

所以代码里结构那条**先判**（A27 有一条专门比对 `probe.entry === undefined` 与 `!saysMissing(text)` 的先后）。
万一哪天措辞认错，最坏结果是「本可以立刻连的，多等一轮」，而不是「把已经能连的判成环境坏了」。

### 39.4 期限要真的等于期限

`graphState()` 轮询原来固定睡 1500ms 再看一眼。探针给 300ms 期限时，实测墙钟 1513ms——
期限写得再小也只是「下限」，不是「上限」。改成：

```js
setTimeout(r, Math.min(1500, Math.max(0, deadline - Date.now())))
```

和 0.2.28 的 `withBudget` 是同一条教训：**时间和预算这类词，代码里出现几次就要真几次**。

### 39.5 验收

- `probe-fusion` O1–O4 七条（全部行为级）：三态各一条、措辞边界一条；
- verify `A27` 十二条，其中两条是盯 vendor 源码的守门断言；
- doctor 结构段一条：`跨插件措辞只有一处，且有断言盯 vendor`；
- 阴性对照两条：改 `vendor/dsh-memory-nebula/lib/index.js` 第 163 行 `nebula_inspect` 那句里的一个字
  → 守门断言红（第一次按子串查是绿的，见 39.2）；`saysMissing` 换回裸 `text.includes('星图里没有')`
  → A27 的「别处零字面量」红（输出 `NODE_MISSING_MARK`）；
- 一条连带的老断言必须改：verify「加料: links.js 有「没接上」的判据」原来查 `links.js` 里的字面量，
  现在改查 `contract.js`；「判据取的是 bridge 未注册工具时的原话」改成查 `bridge.js` 里用了 `NOT_READY_MARK`。

## 40. 同一句报错，按年龄分辨（0.2.30）

### 40.1 一句 404 背了两个意思

星图的 `nebula_link` 在两种完全不同的情况下回同一句话（`vendor/dsh-memory-nebula/lib/host/nebula.js:79`）：

1. **节点还没建进图**——记忆刚写完，引擎 12s 一轮巡检还没跑到它。这是**暂时的**，等一轮就好；
2. **记忆真的没了**——被删、被合并、id 写错。这是**永久的**。

字面一模一样。旧的 `isPermanentFailure` 把它们并成「永久失败」，于是第一种情况被判死刑：
用户写记忆时顺手连的邻居，在下一次读记忆触发补连时被当场摘掉，队列清零，**且不报错**。
这种坏法最难查——没有异常、没有日志、用户只会觉得「这个连线功能时灵时不灵」。

### 40.2 分不出来，就用年龄分

既然文案分不出来，就换一个维度：**这条请求在队列里待了多久**。
`MISSING_GRACE_MS = 10 * 60 * 1000`——建图一轮 12s，200k 条的库实测 24.5s 建完，
10 分钟是「再大的库也建完了」的量级。不足这个年龄的「找不到」先留着；超过还找不到，才认为真没了。

为什么不是「再 inspect 一次」：`nebula_inspect` 对没入图的节点同样回「星图里没有」，
拿它当第二判据只能得到同一个答案，白白多花一次跨插件调用（还要占补连预算）。
结构上也有更好的判据：`r.entry === undefined` 表示桥根本没拿到工具（星图没装配/被关掉），
那是环境问题、要停手，与「星图说这一步不行」是两件事（0.2.12 就分过一次）。

### 40.3 判据顺序就是结论

`flushPending` 里六条分支的**先后**不能随便调：

- `TIMED_OUT` 最先：它根本不是失败，只是「这一轮没来得及」，条目要留、`tried` 要减回去；
- `isLinked` 其次：成功就是成功；
- `isSelfPair` 第三：自己连自己换多少时间都一样，**不该有宽限期**——放它等 10 分钟纯属浪费队头；
- `saysMissingNodes` 第四：只有它有年龄判据；
- `r.entry === undefined` 第五：环境没了就停手，别继续消耗预算；
- 其余留着重试。

把「自己连自己」并进「找不到」，它就会白占 10 分钟；把「没接上」提到前面，
`stopped='budget'` 与 `stopped='unavailable'` 就会互相覆盖，面板上那句提示也就说错了。

### 40.4 写路径不能只说一句「找不到」

`memory_link` 与 `applyLinks` 遇到 404 时，旧文案直接把星图原话转给用户：
「找不到这两条记忆：a / b」——读起来像 id 写错了。现在：

- 排队（`queuePending(..., '节点待入图')`），读记忆时自动补；
- 文案说「星图还没建到它（约 12s 一轮巡检），已排队等补连」，并附一句「另有 N 条排队等补连」。

判据同样是 `saysMissingNodes`：只有「找不到」才这么说；其它失败照实转述星图原话，不猜。

### 40.5 验收

- 先量化：两个 measure 脚本证明「1 秒前刚排的连线被清零」「写路径队列 0 条」，改完再测一遍对照；
- `probe-fusion` P1–P6 七条 + F8 拆成两条（老语义「不重试，直接清掉」必须改口，否则探针自己会把错的行为钉死）；
- verify `A28` 十二条：宽限期量级、`isPermanentFailure` 彻底消失、判据顺序、两条写路径都排队、探针与文档；
- 阴性对照两条：去掉年龄判断 → P1/P2 红；拆掉 `applyLinks` 的 `queuePending` → P4 红。

## 41. 前台也要有期限：掐断一次，比挂死三十秒好（0.2.31）

### 41.1 预算以前只保护了「没人等」的那条路

0.2.28 把预算做真了，但只做在补连上：`flushLinks` 1.2s、`flushNow` 1.5s——这两条都是
**后台**或**面板**顺手做的事，慢一点用户看不见。而用户真在等的是
`memory_link` 和「写记忆顺手连线」，它们一直 `await tryCall(...)` 裸等。

`tryCall` 的 `timeoutMs` 管的是「等子插件把工具注册出来」，工具一旦注册，`execute`
慢多久都照等。于是星图在建图（一轮 12s，200k 条 24.5s）的时候点一下 `memory_link`，
模型就在那儿站二三十秒——这跟报错一样糟，甚至更糟，因为它看起来像「工具坏了」。

### 41.2 掐断不安全的前提是「重试会写脏数据」

排队的整个逻辑建立在「重试安全」上。这一条已经在源码里核过：
`vendor/dsh-memory-nebula/lib/host/store.js` 的 `addLink` 是
`INSERT INTO links … ON CONFLICT(id) DO UPDATE SET note = excluded.note, updated_at = excluded.updated_at`
（id = `x + '\u0000' + y`，x<y 排序），重复连同一条边幂等。

所以这里可以放心地「超时就排队」——但**必须真的排队**。掐断一次、然后什么都不做，
等于用户填的 `links` 被吞掉了，那比挂三十秒更坏。

### 41.3 超时不是失败：两种动作两种收尾

- **写连线**：超时 = 「这次没等到」，`queuePending(..., '星图太慢待重试')`，文案说清秒数；
- **只读（path）**：超时不能排队。队列是「欠账」，每次读记忆都会重试它，
  把只读动作塞进队列等于让队列越积越长、还把一次超时变成永久噪音。

这条区分跟 0.2.30 的判据顺序是同一个思路：**先问「这条动作有没有副作用」，再决定失败怎么处理**。

### 41.4 期限要说得出口

`describeMs`：`20000 → 「20 秒」`、`200 → 「200 毫秒」`。第一版直接用
`Math.round(callMs / 1000)`，探针用 200ms 期限跑出来是「星图 **0 秒**内没回应」——
数字是假的，用户按它判断「要不要再等等」就会判错。文案里的数必须真。

### 41.5 验收

- `probe-fusion` `Q1–Q6` 十四条（墙钟受控、条目留队、快路径不变、path 不留欠账、哨兵不外泄、文案数字真）；
- verify `A29` 十二条（期限量级 / 三个新出口 / 裸等消失 / `linkCallMs` 可配 / 探针 / 版本与文档）；
- 阴性对照：拆掉 `applyLinks` 的 `withBudget` → Q1 红；`isTimedOut` 恒 `false` → Q2/Q5 红。

## 42. 一批也要有总账，超出的排队而不是消失（0.2.32）

### 42.1 那个 12 不是「上限」，是「静默截断」

`applyLinks` 里原本是 `for (const target of items.slice(0, 12))`。写它的时候想的是
「别让一次写记忆连太多条」，落地成了：第 13 条开始**既不连、也不排队、也不出现在文案里**。
模型给了 15 条 `links`，回执是 12 行「已连上」，剩下 3 条边在用户不知情的前提下没了。
这类 bug 的可怕之处是它长得像成功：没有异常、没有日志、队列是空的。

### 42.2 单条有期限 ≠ 一批有期限

0.2.31 给单条连线加了 `LINK_CALL_MS = 20s`。看起来「挂死」被解决了，但那是**每一条**的上限：
12 条各挂 20 秒 = 4 分钟。用户在等的一次 `memory_write` 还是能挂到超时，只是从「一次长挂」
变成「十二次短挂」。所以一批需要自己的总账（`LINK_BATCH_MS = 30s`），每条取
`min(linkCallMs, 整批剩余)`——快的时候第一条就用满 20 秒也没问题，慢的时候总时长封顶。

### 42.3 超出的三种收尾都必须排队

「超条数」「超总时长」「星图还没就绪」是三个不同的原因，但结论一样：**这次没轮到，不是不要了**。
所以三条路都走 `queuePending`，只是 `reason` 不同（`本次没轮到待补` / `节点待入图` / `星图未装配`），
面板上能看出「为什么这条还挂着」。队列本身有 `PENDING_MAX = 500` 和 7 天 TTL，
不需要在调用点再加条数上限——在调用点截条数，只会把数据丢在用户看不见的地方。

### 42.4 三种情况说三句话

- `另有 N 条排队等补连`（通用于任何失败）
- `一次最多当场连 12 条，多出来的 N 条已排队`
- `整批最多连 30 秒，没连完的 N 条已排队`

只写「已连上」会让用户以为整批都连上了；只写「另有 N 条排队」又说不清为什么。
数字全部来自实际计数与 `describeMs`，不写死。

### 42.5 验收

- `probe-fusion` `R1–R6` 十五条（15→12+3、总账 500ms 下墙钟 < 900ms、快路径不多话、
  星图没就绪 15 条全排队、两个闸默认值与 config 覆盖）；
- verify `A30` 十二条（常量量级 / 静默截断消失 / 排队路径不截条数 / `min(linkCallMs, left)` /
  超出理由可分辨 / 两句文案 / 可配可读回 / 探针 / 版本与文档）。

## 43. 理由也是口径：同一个状况只有一种叫法（0.2.33）

### 43.1 面板诚实转述了两个名字

面板的待补连线列表一直是「诚实转述」：每行括号里照抄队列里的 `reason` 字段。问题不在转述，
在字段本身——同样是「连线失败」，写记忆那条路记 `连线失败待重试`，`memory_link` 那条路记
`memory_link 失败待重试`。于是用户看到 `2 条连线失败 + 1 条 memory_link 失败`，
在语义上是两件事，在事实上一件事。转述得越诚实，误导越稳定。

### 43.2 分组的价值在于「一眼看出是谁的问题」

一串明细里，五条理由长得都像 `（……待重试）`。分组之后多出的一行是：
`按理由：本次没轮到待补 2 · 节点待入图 3 · 星图太慢待重试 1`。这句话回答的是
「要不要我管」：`本次没轮到` 和 `节点待入图` 都会自己好，`连线失败` 才可能要人看一眼，
`星图未装配` 直接是环境问题。**顺序本身就是结论**（和 40.3 同一条道理）：
`REASON_ORDER` 从「会自己好」排到「要人管」，面板照这个顺序列。

### 43.3 期限散在三处，等于没有期限

`flushLinks` 里写 `1200, 8`，`flushNow` 的默认参数写 `1500, 20`，面板再自己传一遍
`{ budgetMs: 1500, limit: 20 }`。三处只要有一处改，另外两处就成了「另一个口径」，
而且**不会报错**——面板还是能跑，只是它跑的不是文档里那个数。这类漂移只有靠
「常量只在一处 + config 可覆盖 + 面板不传数」才能断根；断言再补一条
（`!adminSrc.includes('flow.flushNow(exec, { budgetMs')`）盯着面板别偷偷传回来。

### 43.4 不认识的理由不许合并进「其他」

旧队列里可能留着已经废弃的写法（`memory_link 失败待重试`）。归组时它当然不认识——
这时**照原样单列**，而不是塞进「其他」。合并会把「我们改了叫法」这件事藏起来，
而用户手上那条欠账还是真的。同理，理由为空的老条目列成「未记理由」，也不并。

### 43.5 验收

- `probe-fusion` `S1–S4` 十二条（理由表不重复 / 顺序覆盖 / 旧理由单列 / 空队列不加行 /
  面板按 `panelBudgetMs` 掐断并说清剩余 / 两条出口各取自己的数可读回）；
- verify `A31` 十二条（理由表 / 调用点无裸字面量 / `reasonCounts` / 五个期限常量 /
  config 出口 / 面板不写数 / 探针 / 版本与文档）。

## 44. 截断也要说话：上限不是排版问题（0.2.34）

### 44.1 一刀切下去，模型看见的是「另一份手册」

`macro-memory:guide` 每轮注入，上限 1300 字符。超过时旧实现按行边界切，切完返回。
从模型的视角看，它拿到的就是全部——没有任何迹象说明后面还有三段。**上限是硬约束
（每轮都花主人的钱），但「切」这个动作必须留下痕迹**：有上限和「本来就没写」必须在
输出里可区分，否则「手册」这个词就成了谎。

### 44.2 最可能被切掉的，恰好是唯一出口

行边界截断是「从尾部丢」。手册最后一行是 `完整手册见 memory_admin(action="guide")`——
它正是残本的唯一出路：模型知道自己缺东西时，唯一能自救的动作就是去取全文。
尾部丢弃先丢掉的就是它。所以尾巴不能是「被切掉的内容之一」，得是**预算里的固定成本**：
`budget = cap - TAIL.length - 1`，先给尾巴留座，再切正文。

### 44.3 余量是提前发现，不是事后补救

手册现在 1085 字符，余量 215。`GUIDE_MIN_HEADROOM = 120` 的意思是：余量掉到 120 以下时，
断言先红——**该删句子了**，而不是等某天悄悄触发截断后再靠尾巴兜。这和 42 段「一批也要有
总账」是同一类道理：真正的保护不在兜底那一步，而在「别走到兜底」的那一步。

### 44.4 放不下尾巴的极端情况

`cap <= GUIDE_TAIL_MARK.length` 时，任何「尾巴 + 正文」的组合都超限。这时只能硬切，
但**不许伪造完整**：返回原文前缀，长度等于 `cap`，不追加尾巴（追加反而超限）。
上限 0 返回空串。探针里专门测了这两个边界——边界不崩，才有资格说「任何上限都不静默截断」；
换句话说，43 段那条准则的**例外必须显式**（这里就是：上限本身装不下一句解释）。

### 44.5 顺带给注入补一句话

0.2.33 把待补队列按理由分好组了，但注入手册里没提——只有读过 README 的人知道
`memory_admin(action="links")` 能看。补上「排队欠账用 memory_admin(action="links") 看，
按理由分组」，43 字符，换模型在写记忆失败时知道去哪看欠账。

### 44.6 验收

- `probe-host` `E4b` / `E4c`（余量 ≥120、注入提到 links 面板且「按理由分组」）；
- verify `A32` 十条（正常文本不改 / 不触顶 / 余量 / 尾巴 / 长度 / 指针不丢 / 尾巴在最后 /
  极小上限不崩 / 版本与文档）；
- 阴性对照：把 `clampGuide` 换回「裸切」的实现，`A32` 必须红。

## 45. 判据也只有一份，而且每条都得能红（0.2.35）

### 45.1 两次检查不比一次检查更安全，可能更松

0.2.33 把「理由」收成 `PENDING_REASONS` 一份，理由变了样；但**判断理由有没有被抄回去的那段代码**
没跟着收：verify 的 A31 拿五个值逐个查调用点，doctor 的结构段手钉两个。两段都写着「检查」，
实际是两个标准。更麻烦的是方向：更松的那份在 `doctor` 里，而 `doctor` 是**用户唯一会自己跑的东西**
（`/体检`）。于是把 `'连线失败待重试'` 抄回 `linkflow.js`，verify 红、doctor 绿——
绿的那一刻，它替主人确认了一件它没真查的事。**检查项的可信度等于其中最松的那一份**。

### 45.2 判据是数据，不是代码副本

`tools/criteria.mjs` 里只有 `reasonChecklist({ ...源码, reasons, order })`：把事实喂进去，
回一张 `{id, label, ok, detail}[]`。它不读文件、不写文件、不 await 任何东西。
两个调用方各自负责「喂什么」和「怎么报」：

- verify：`for (const item of list) check(`口径清单: ${item.label}`, item.ok, item.detail)`——
  红一条就知道是哪条，不用去猜；
- doctor：`line(PASS/FAIL, '排队理由与期限的口径只此一份', summarizeChecklist(list))`——
  一行，红时说清哪几条、细节是什么。

这样两边不可能再分叉：要加一条判据，只能改 `criteria.mjs`，两边同时生效。

### 45.3 判据恒真是单一口径的代价

合并的代价很明确：**两份独立的检查互为对照，一份合并成一份之后就没人对照它了**。
如果 `no-bare` 哪天被写成 `ok: true`，verify 绿、doctor 绿、check-all 绿，一切照旧。
所以 `selfTestChecklist()` 是这套结构的一部分，不是彩蛋：给一条全绿样板，
再逐条造一个只该弄红那一条的输入（理由表里塞重复值、拔掉一条排队路径、把裸字面量塞回
flowSrc、面板重新传 1500……），任何一条「造坏了也没红」就直接算它不成立。

这也是第 43 段那条准则的延伸：**口径统一之后，要证明统一的那一份真的还在工作**。
写测试的人最容易骗自己的一句话是「这条判据显而易见」，而它恰恰从不触发。

### 45.4 顺带把 doctor 的两处手抄字面量删掉

doctor 里原来那句 `!flowSrc33.includes("'节点待入图'")` 就是第二份口径的遗迹。
现在它一个字面量都不留，verify 有一条断言钉住这件事（`doctorSrc` 里不许出现理由文本、
必须 `from './criteria.mjs'`）。删的是字面量，不是判据——判据在更合适的位置上。

### 45.5 验收

- verify：`A31` 十条判据逐条落成断言 + 清单十条 id 不重复 + doctor 确实读它 + 自检能打红；
- doctor：一行汇总，`10/10 全过`，红时列出哪几条；
- 阴性对照：旧写法抄回 `linkflow.js` → verify 两条红、doctor 指名；`no-bare` 改恒真 → 自检红。

## 46. 说一半的账比不说更糟：被什么掐的，得看得出来（0.2.36）

### 46.1 「还剩 12 条」这句话缺了主语

`memory_admin(action="links")` 会先手动补一轮（有预算），再把队列摊开。0.2.28 起预算
是真的，掐断时面板会说「这一轮预算用完，还剩 12 条下次读记忆时接着补」。这句话是对的，
**但缺了「被什么掐的」**：`flushPending` 只交出 `stopped` 与 `left`，取值范围本身
（`budgetMs` / `limit`）留在 `linkflow` 的配置里没出来。

于是用户读到「还剩 12 条」只有一个合理反应：再点一次。可再点一次，时间还是那 1.5 秒，
剩的还是那 12 条。**说一半的账比不说更糟**——不说时人会问，说一半时人以为自己懂了。

### 46.2 面板只许转述，不许自己写数

修法不是「面板里写 1.5 秒」，那会立刻变成 43.3 那类漂移（面板自己那份数不跟着 config 走）。
而是让 `flushPending` 把**它实际用的那两个数**一起交出来：

```js
if (list.length === 0) return { …, stopped: 'empty', budgetMs, limit }
return { tried, linked, dropped, left: readPending().length, stopped, budgetMs, limit }
```

面板再 `describeMs(round.budgetMs)` 转述。空队列那次也要带——空队列不是「没预算」，
下一轮读记忆时用的还是这个数，而且 `panelOf` 的探针正是靠这个数才证明「面板没写死 1500」。

### 46.3 秒与毫秒只能有一个出口

`describeMs` 在 0.2.31 就有了（41.4：第一版 `Math.round(200/1000)` 会说「星图 0 秒内没回应」）。
这里直接复用，不另写一套格式化——**同一件事的第二份实现，哪怕只有一行，也是下一次漂移的种子**。

### 46.4 新判据必须自己先能红

判据清单从十条变十一条（`panel-budget`）。按第 45 段的规矩，加一条判据的**同时**
要在 `selfTestChecklist` 里给它造一个只该弄红它的输入：把 `adminSrc` 换成
「有 `flushNow(exec)`、有 `还剩 N 条`、但没有 `describeMs(round.budgetMs)`」——
`panel-number` / `panel-left` 应当仍是绿的，只有 `panel-budget` 红。
没造这条 mutation 的判据，等于给清单加了一句永远为真的话。

### 46.5 验收

- `probe-fusion` `S3`（`panelBudgetMs: 300` → 抬头「300 毫秒」+「20 条」）、`S5`（空队列也说上限，
  且不冒充「用完」）；
- verify `A33` 六条（两个 return 都带 `budgetMs, limit` / 面板转述且无 `budgetMs: 1500` /
  `describeMs` 从 links.js 进 admin / 探针三句 / 版本 / 文档）；
- 判据清单 11 条 + 自检全过（`{"baseline":[],"survived":[]}`）；
- 阴性对照：把 `describeMs(round.budgetMs)` 从 note 里拿掉 → `panel-budget` 红、S3/S5 红。

## 47. 「还没算」不是「算完了没关系」（0.2.37）

### 47.1 星图把三件事说成一句话

`nebula_path` 的四句回答里，两句是事实、一句是结论、一句是环境不合格：

- `找不到这两个节点：a / b` —— 节点还没建进图（12s 一轮巡检），或者记忆真的没了；
- `节点不在当前星图里` —— 引擎解析过、下标已失效（图正在重建）；
- `这两条记忆在星图里没有连上（超过 6 跳）。没有关系就不编关系。` —— **这才是答案**；
- `这个引擎版本还没带上路径搜索（等宿主重启后生效）` —— 宿主跑的是旧代码。

前两句字面上像「它们没关系」，其实是「还没算」。0.2.30 修过一次同类问题：`memory_read` 的
「星图里没有这条记忆」既可能是刚写完还没入图，也可能是真删了，那时我们按**年龄**分辨。
这次没有年龄可看——所以只能靠**认出是哪一句话**。同一个坏法的第二个工具，说明这不再是偶发，
而是这类插件协作的固有形状：对面只有文字，文字里混着「现在算不出来」和「算完了是 0」。

### 47.2 翻译，不是改口径

我们插的这一步只做一件事：把「还没算」翻译成一句人话，告诉用户**等一轮再问**；
对「真没关系」则**原样转述**，一个字都不改。这不是客气——`没有关系就不编关系` 是星图的
诚实，我们替它改写成「暂时没关系」，反而把结论说软了。**能翻译的只有状态，不能翻译结论。**

### 47.3 归类顺序就是判据

`pathAnswerKind` 里三条 `if` 的顺序是有意的：先认「引擎旧」，再认「没入图」，最后才认
「没关系」。反过来的话，任何把「找不到这两个节点…没有关系就不编关系」拼在一起的文本都会被
判成结论——而它恰恰不是结论。A34 里专门有一条拼串用例钉这个顺序：**顺序不是排版，是判据的一部分。**

### 47.4 四句话不许在别处再写一遍

四句话都进 `contract.js`。`doctor` 的泄漏面从 3 个文件扩到 4 个（加 `defs/link.js`）——
因为最可能重写这些字面量的，正是那个做翻译的文件。判据扩面这一步比加常量更重要：
常量只是「有个地方放」，泄漏面才是「有没有人偷偷自己写」。

### 47.5 只读动作不许因为翻译长出欠账

`path` 是只读的：每次读记忆都会重试它，进了队列只会越积越多（0.2.31 已定「只读不进队列」）。
翻译分支里一条 `queuePending` 都不许有，探针 `T5` 走完三条翻译路径后队列必须还是 0 条。

### 47.6 验收

- 探针 `T1–T5`（归类表 5 例 + 拼串顺序 / 两种「还没算」不冒充结论且说清等一轮 / 真没关系原样 /
  旧引擎指出处 / 只读不进队列）；
- verify `A34` 九条（四个常量起名 / `defs/link.js` 无泄漏 / 归类唯一出口 / 七种输入归类 /
  翻译在 path 分支且无排队 / 探针 / 版本与文档）；
- 阴性对照：把 `pathAnswerKind` 的 `missing` 分支改成 `unrelated`，`A34` 与 `T2` 必须红。

## 48. 判据自己也会分成两处（0.2.38）

### 48.1 两次体检不比一次更安全

0.2.35 的结论是「判据只写一份」，但那一次只收了一族（排队理由）。跨插件措辞那一族还在原处：
verify 手写十行、doctor 手写一行（九个值又抄一遍、外加自己 `includes` 一次 verify 源码）。
于是同一个字面量改值，verify 红、doctor 绿——而 doctor 是主人唯一会自己按的那个按钮
（`/体检`）。**判据的可信度等于其中最松的那一份**，这条从未变过，只是这次犯在判据自己身上。

### 48.2 判据里的表也是数据

`CONTRACT_MARKS`（9 个常量 → 值）和 `CONTRACT_LEAK_FILES`（4 个调用方）都是数据。
verify 与 doctor 都不许再各自持有一份：它们只把源码传进来，读同一张表、拿同一份清单。

### 48.3 「源码里有这行」不是「导出了这个值」

`contractChecklist` 的 `runtime` 那条是这一轮唯一的新判据：源码文本能对上 `export const X = '…'`，
不代表模块真的导出了这个值——名字拼错、重复 `export`、后面被重新赋值覆盖，三种情况都能让
「按值起名」绿着、行为却是空的。所以调用方把 `import('./lib/macro/contract.js')` 的**模块本身**
传进去，逐个比 `runtime[name] === MARKS[name]`。

### 48.4 vendor 那两条为什么还算在清单里

它们不是「我们自己的同一份判据」，而是**对面源码的锚**：星图的回答只有文字，哪天对面把这句
改写了，我们的归类就静默失效。所以它们必须和常量表成对存在——常量是我们认的字，vendor 断言是
「这个字今天还印在对面」。两条一起看，才叫「认字」。

### 48.5 自检照样要有

`selfTestContract()` 给一份全绿样板，再逐条造一个只该弄红那一条的输入：
`marks`（改一个值）/ `runtime`（表对、导出错）/ `leak`（调用方抄了一句）/ `kind`（删掉归类）/
`vendor-index`（对面改写）/ `vendor-core`（对面删一句）。样板有红或某条打不红 → 这族判据不成立。

### 48.6 验收

- verify：`契约: 措辞判据清单六条且 id 不重复`、六条 `契约清单: …`、`措辞判据也只有一份（体检读同一张表）`、
  `每条措辞判据都验证过能被打红`；
- doctor：`跨插件措辞只有一处，且有断言盯 vendor  6/6 全过`；
- 阴性对照（A）把 `CONTRACT_MARKS.NODE_MISSING_MARK` 改成别的值 → `marks` 与 `leak`/`runtime` 一起红；
  （B）把 `runtime` 判据恒真 → 自检里 `runtime` 打不红。

## 49. 零命中不是证据：空图那半句会把「没算」变成「没有」（0.2.39）

### 49.1 一句话背两个意思，第三次

0.2.30 是 404 那句「星图里没有」，0.2.37 是 `nebula_path` 那四句。这次的句子更常见：
`nebula_recall` 空命中只有一句话，**「图还没建起来」与「图里真没有」共用它**。

### 49.2 两条空结果会互相作证

本地检索零命中 → `expand` 默认自动扩散 → 星图也空 → 我们把「星图里没有匹配」拼在本地结果后面。
两次零命中看起来是两份独立证据，其实第二份是**没算**。**证据的数量不等于证据的独立性**，
这是这一轮唯一新增的判断：只读路径里，凡是「没算」的结果都不许写成结论，也不许当结论摆在一起。

### 49.3 凭据得先证明它能分辨，才配进判据

第一版拿 `res.scanned` 当凭据：`scanned === 0` 判「图是空的」。
`probe-graph` G10（归档一条 → 等星图过滤掉 → 期望「没有匹配」）立刻打红：
`scanned = scored.length` 是**算进候选的条数**，查询词一个都对不上时它本来就是 0 ——
「图是空的」和「真没有」在它眼里是同一个数。用一个分不开的数去分辨两种状态，
判据必然有一半是错的，而且错的那一半恰好把「真结论」说成「没算」。

换成 `recall.js` 新增的 `nodes: n`（图里节点总数）才成立：`nodes === 0` 才是空图，
`nodes > 0` 且零命中就是真结论。**每个进判据的量，都要先举出两个取值不同的场景**；
举不出来，它只是「看着像凭据」。这一条是 G10 替我抓出来的，不是我想到的——
所以它也证明了一件事：判据写得比被测代码更粗时，是判据在说谎。

### 49.4 改 vendor 就要记账

这条补丁动了第三方源码（`lib/index.js` 的 `formatHits`），所以 doctor 的补丁账本加一条
`[macro-fusion 0.2.39]`，criteria 的 `vendor-recall` 再按整句盯一次。**升级能冲掉补丁，
冲掉之后不报错，只会让行为退回上游**——账本与判据一起才拦得住。

### 49.5 空图时以 meow 为主

星图没建完不该让用户「查不到记忆」。所以空图走的是**回退本地检索**这条路，不是报错、
也不是只解释一句。回退是 0.2.32 就定下的原则（星图缺席时以 meow 为主），这次只是把
「图是空的」也算进「星图此刻给不了答案」。

### 49.6 验收

- probe-fusion U1–U7：归类表、空图退本地、没 query 兜住、bridge 同源、自动扩散只附加注、真结论原样转述、队列不涨；
- verify「recall:」十一条：常量按值、归类唯一出口、无裸字面量、三种输入、vendor 两个分支、翻译三处、探针标签、版本、文档；
- 阴性对照：把 `recallAnswerKind` 的 `emptyGraph` 分支删掉（空图落到 `noMatch`）→ U1/U2/U4/U5 与 verify 一起红。

## 50. 「共 0 项」是最容易被信的那句假话（0.2.40）

### 50.1 第四次一句话背两意，这次背的是「安心」

0.2.30 是 404 那句「星图里没有」，0.2.37 是 `nebula_path` 四句，0.2.39 是 `nebula_recall` 空命中。
这次轮到体检：抬头写「共 N 项」，图还空着的时候 N 也是 0。

前三次的误读方向都是「以为没有」；这一次方向更坏——**「以为没问题」**。用户看到「共 0 项」，
不会再去查第二遍，也不会去补连接、合并重复。他得到的是一个不需要动作的结论，而这个结论是凭空来的。

### 50.2 凭据仍然是「图里有多少节点」

`h.total` 不能当凭据，它数的是「查出多少毛病」，空图和真干净都是 0。这和 0.2.39 的
`scanned` 是同一个坑，同一周踩了两次：

> 凡是拿来做判断的数，先问一句「它在我关心的两种情况下取值不同吗」。

`nodes.length` 才是：0 → 没算；> 0 → 算过了，0 项就是真干净。

### 50.3 判据必须能翻面

G1b 只证明了「空图时说没算」。如果这句话是写死的，G1b 永远绿而用户永远看不到体检结果——
所以必须有 G1c：写进一条记忆之后，同一句「等于没算」必须**消失**。
一条只在一侧成立的判据，测的是一个常量，不是一个行为。

### 50.4 改 vendor 的第四笔账

`[macro-fusion 0.2.40]` 进 doctor 的补丁账本（第 9 条），`vendor-hygiene` 进 criteria 的措辞判据清单
（第 8 条）。账本管「补丁还在不在」，`vendor/VENDOR.json` 管「除我们外没人动过 vendor」，两道一起。

### 50.5 验收

probe-graph G1b / G1c（真库、真引擎、真 12s 巡检）、probe-fusion V1–V3、verify「体检:」九条，
以及 `tools/criteria.mjs` 自检（八条判据各自都能被打红）。

## 51. 「0 条记忆」是唯一会让人去还原备份的一行字（0.2.41）

### 51.1 第五次一句话背两意，这次背的是「灾难」

0.2.30 / 0.2.37 / 0.2.39 / 0.2.40 四次的误读方向都是「以为没有」「以为干净」——共同点是**让人少做一件事**。
星图概况不一样：第一行是「0 条记忆 / 0 条连接」，它覆盖了三种状态（还没建起来 / 来源读不出来 / 真的一条都没有），
而用户的读法只有一种：**记忆丢了**。

这个方向的错误更贵。误以为干净，代价是少查一遍；误以为丢了，代价是一串**主动的破坏动作**——
翻备份还原、重灌数据库、甚至把库删了重来。恐慌不会自己消失，它会立刻变成操作。

### 51.2 原因要读出来，不能猜

同一句「这不是记忆丢了」后面必须接上**这次具体是哪一种**，否则它只是又一句安慰：

| 凭据 | 说什么 |
|---|---|
| `o.readErrors` 非空 | 有 N 个来源读不出来（点名）——不是丢了，是没读到 |
| `o.sources` 为空 | 一个来源都没接上（指向 `nebula_sources`） |
| 有来源但 0 节点 | 来源都连着，还没读进图里（12s 一轮，建完再问） |

三种都从 `overview()` 已有的字段里取，不额外探测、不加慢查询——**只读不长欠账**。

### 51.3 这次顺手抓到两处「判据自己也是数据」

- `contract.js` 文件头的表里，`HYGIENE_EMPTY_GRAPH_MARK` 那一行被抄了两遍（0.2.40 打补丁时重复追加）。
  没有任何断言会红：常量在、值也对，只是表里多一行。于是 `criteria` 加 `table` 一条——
  **每行只许出现一次，也不许缺常量**。
- 归类函数已经四族（path / recall / hygiene / stats），却只有 `pathAnswerKind` 被断言盯过。
  加 `kinds` 一条：四族必须都在 `contract.js` 里各有一处实现。

判据清单 8 → **11 条**，措辞表 12 → **13 个常量**。

### 51.4 判据必须能翻面（第二次强调）

G1d 只证明「空图时说不是丢了」，所以必须有 G1e：写进一条记忆之后，同一句「星图现在还是空的」必须消失。
`probe-graph` 现在两族都有成对的翻面判据（G1b/G1c、G1d/G1e）——这一条从经验变成惯例。

### 51.5 验收

probe-graph G1d / G1e（真库、真引擎）、probe-fusion W1–W3、verify「概况:」十条，
`tools/criteria.mjs` 自检（11 条判据各自都能被打红，`{"baseline":[],"survived":[]}`）。

## 52. 判据不能靠「对面没说不认识」推出「它认识」（0.2.42）

### 52.1 这句话的下游是一个判断，不是一双眼睛

前五轮修的都是给人读的句子，这一轮的句子还给**代码**读：

```js
// lib/macro/linkflow.js
if (text.length > 0 && !saysMissing(text)) return 'ready'
```

`graphState()` 拿 `nebula_inspect` 的返回当「这条记忆入图了没有」的凭据。写法是**反推**：
只要返回里没有「找不到」那几句，就算 ready。这个写法在文案稳定时是对的，
一旦空图有了新说法，它立刻变成「空图也 ready」——然后空图上每次写入都先去抢连、失败，
再落一条写错原因的欠账（「失败」而不是「节点待入图」）。

**否定式判据会把「没打补丁」误判成「正常」。** 改成正面判定：

```js
if (text.length > 0 && inspectAnswerKind(text) === 'ok') return 'ready'
```

### 52.2 兼容旧文案不是保守，是防「静默退化」

`inspectAnswerKind()` 的 `notFound` 同时认 `NODE_MISSING_MARK`（我们补丁前的原话）。
理由：补丁被上游升级冲掉时，`graphState` 必须还能把旧说法归成「没找到」；
否则它会归 `ok` → 又变成 ready——于是「记忆没了」会跟着变成「入图了」。
**判据要认「我们没打补丁时对面说什么」**，
这就是第一次跑 `probe-fusion` 时 O2 / R4 四条红给出来的教训（stub 用旧文案 → 判 ok → ready）。

### 52.3 试过但放弃真引擎断言

想让 `probe-graph` 在真引擎上验这两句，两次都失败：一是 `linkWaitMs` 默认 14s，
轮询到 ~12s 时星图把目标建好了；二是 `nebula_*` 在 `captureTool` 之后从对外工具面里被摘掉，
探针根本拿不到那个 def。要打通只能让 `apply()` 返回 bridge——那是给测试加的生产接口，
属于「没用的功能」。于是覆盖分层：`probe-fusion` X（stub 用真实文案）+ `criteria.vendor-inspect`
（盯 vendor 源码）+ verify 十条（钉契约与判据）。**宁可少一层，不为了测试长接口。**

### 52.4 验收

probe-fusion X1–X5、verify「inspect:」十条、`tools/criteria.mjs` 自检
（12 条判据各自都能被打红）、doctor 补丁账本第 11 条。

## 53. 第六次：连「来源」都在说同一句话（0.2.43）

### 53.1 这次不是「没有记忆」，是「没接上」

`nebula_sources` 的头一行是 `已接入 0 个来源，共读到 0 条记忆：`。三种情况共用它：
配置没建、探测关着、配了但读失败（`live.errors` 非空）。前两种是**没接**，
第三种是**接了没读到**——三种都被读成「记忆没了」。

到这一轮，「一句话背两意」已经是第六次（0.2.30 / 0.2.37 / 0.2.39 / 0.2.40 / 0.2.41 / 0.2.42），
而且全都集中在**空结果**这一格：空检索、空体检、空概况、空详情、空来源。
这不是巧合——空结果本来只有一种写法（0），却要承载四种意思：
**还没算 / 算过没有 / 没接上 / 真的没有**。

### 53.2 修法与上一次同构

三条凭据都从 `sourcesReport()` 已有的字段里取（`config.exists` / `config.autoDetect` / `live.errors`），
不额外探测、不加慢查询。补一句「来源接上了但读到 0 条」——空库和路径写错长得一样，
这一句是唯一的分辨点。

### 53.3 顺手把「条数断言」去掉了

`verify` 里原来写着 `list27.length === 12`，每加一条判据就得改两处（A27 一处、新小节一处），
漏一处红一下午。这一轮改成对**清单内容**：

```js
const expectIds = ['table', 'kinds', 'marks', 'runtime', 'leak', 'kind',
  'vendor-index', 'vendor-core', 'vendor-recall', 'vendor-hygiene',
  'vendor-stats', 'vendor-inspect', 'vendor-sources']
```

`expectIds.every(...)` + `id 不重复`——条数不是契约，内容才是。

### 53.4 验收

probe-fusion Y1–Y3、verify「sources:」八条、`tools/criteria.mjs` 自检
（13 条判据各自都能被打红）、doctor 补丁账本第 12 条。

## 54. 第七次：这次连「自己人」也被同一句话骗了（0.2.44）

### 54.1 没找到 ≠ 读过

`nebula_bridge` 空结果只有一句：`没有可补充的邻居（种子 N 条，候选 M 条都已读过或在冷却期）`。
`stats.seedCount` 是**图里实际解析到的种子数**，种子 0 条时它一样说「都已读过」——
把「一条都没找到」说成「都读过」，这不只是措辞问题：**它让用户以为自己在读记忆这件事上落后了**，
于是去重新搜、去重灌、去怀疑同步。前六次都是「以为没有」，这次是「以为有但都被我漏了」。

### 54.2 四支凭据，一条不从外面补

`totalB`（`nebula.graph.nodes.length`）/ `seedsB`（`stats.seedCount`）/
`consideredB`（`stats.considered`）/ 预算 —— 全在 `spread()` 已有的返回里，
`askedB` 只是把「你给的 N 个 id」和「查询『X』」分开说（这两种输入失败的补救办法完全不同：
一个去核 id，一个换关键词）。

### 54.3 说清楚话，还要保持「能被判读」

空图那支的文案里**故意保留** `星图里还没有节点（图是空的）`：`recallAnswerKind()` 靠它归成
`emptyGraph`，而 `lib/macro/defs/search.js` 的 bridge 模式就靠这个信号退本地检索兜底。
这是本轮最值得记的一条：**改文案时，先把「这句话还有谁在读」列出来**——
上一轮 `nebula_inspect` 的教训是它被 `graphState()` 读，这一轮是它被自己的兜底读。
两轮都是「文案即接口」。

### 54.4 验收

probe-fusion Z1–Z3（三种空归一类、空图那句仍算「没算」、bridge 模式退本地检索）、
verify「bridge:」九条（含「旧文案一个字都不留」这条反向断言）、
`tools/criteria.mjs` 自检（14 条判据各自都能被打红）、doctor 补丁账本第 13 条。

## 55. 第八次：这次的坏法不是「以为没有」，是「让你别再问」（0.2.45）

### 55.1 「没有关系就不编关系」是一句结论

`nebula_path` 空结果的原文是
`这两条记忆在星图里没有连上（<原因>）。没有关系就不编关系。`
前半句是原因，后半句是结论，中间没有分号也没有转折——四种情况共用：
图空着、节点解析不到、引擎还没带路径搜索、**真算过**。

前三种叫「没算」。把一个「没算」写成一句带结论的话，后果不是让人多跑一趟，
而是**让人停止追问**：`nebula_path` 在提示词里的用途就是「核对这两条记忆到底怎么连上的」，
它一说没关系，模型就会把这个推断划掉。前面七次都是「以为空」，这次是「被说服」。

### 55.2 0.2.37 只在上一层修过，这一层漏了

0.2.37 的修法是在 `memory_link(action="path")` 里翻译那四句（`defs/link.js`）。
但**兼容别名 `nebula_path` 是直连 vendor 的**，`compatAliases: true` 的用户
（以及第三方提示词里还写着 `nebula_path` 的）一直拿到原样那句。
同一个缺陷在两层各存在一份，只在其中一层修，另一层就是隐形的。
**「改名 + 翻译」不能替代「把原话改对」**——这也是这一轮先改 vendor 再动判据的原因。

### 55.3 归类顺序就是判据本身

`pathAnswerKind()` 新增 `emptyGraph`，且必须排在 `missing` 之前：图空时节点当然也解析不出来，
先认 `missing` 会说「这两条没入图」，而真实情况是「一条都还没建」。
这条纪律写进注释了，也写进 probe-fusion T6——**顺序错了，四种答案会挤成一种**。

### 55.4 验收

probe-fusion T6–T7（四句各归各的 / 结论只在一句 / 新文案的两种翻译不变）、
verify「path:」九条、`tools/criteria.mjs` 自检（15 条判据各自都能被打红）、
doctor 补丁账本第 14 条。

## 56. 第九次：这次连一个字都不给（0.2.46）

### 56.1 沉默不是「没有」，是「没说」

前八次都是「一句话背两个意思」。这次更糟：`memory_find_similar` 一条相似都没有时，
`render` 返回空数组，`lib/macro/render.js` 里 `texts.length === 0` 就退回 `JSON.stringify(value)`，
于是 `memory_search(mode="similar")` 的答案是一屏 `{"hits": []}`。

**一个字都不给**看起来比说错话安全，其实一样坏：读者要么把它读成「查过了，没有」，
要么读成「工具坏了」。而它真实的含义是第三种——**这次没算成**。沉默之所以更危险，
是因为它不留把柄：没有一句话可以去核对、去打红、去判读。

### 56.2 四种原因里三种是「没算」

`execute` 里空命中来自四处，全是现成变量，不需要额外探测：
`tfVector(tokenize(content)).size === 0`（基准没有可比的词）、`rows.length <= 1`（库里就这一条）、
`candidates.length === 0`（本会话新写的 + 已看过的都被过滤）、
以及真算过但 `cosine <= 0`（词汇零重叠）。
前三种写「相似检索没算成」，第四种才允许写「这才是『记忆里没有相似的东西』」。

顺带把 `output.schema` 加了一个可选 `note`——判据要读得到这句话，
就不能让它只活在 `render` 的临时变量里。

### 56.3 两层各存一份，就两层都修

融合层（`lib/macro/defs/search.js`）另有一层兜底：拿到空串或裸 `{"hits": []}` 时自己说话。
补丁在位时它用不到——留着是因为**上游随时可能把 vendor 换回去**，
而那时沉默会立刻回来。这正是 0.2.45 的教训（同一个缺陷在两层各存一份，只修上层会留暗处）。
兜底那句只说「没给出任何内容」，不下「没有相似」的结论。

### 56.4 判据要看得到另一个插件

`contractChecklist()` 多了一个入参 `meowIndexSrc`：此前所有 vendor 判据都盯 nebula，
这次缺陷在 meow 自己身上。判据清单 16 条、措辞表 20 个常量、doctor 账本第 15 条。

### 56.5 验收

probe-fusion AC1–AC3（三种「没算成」归 `notComputed`；真库上不再沉默；
子插件不给字时兜底那句在场）、verify「similar:」十条、
`tools/criteria.mjs` 自检（16 条判据各自都能被打红）、doctor 补丁账本第 15 条。

## 57. 第十次：这个项目「没有记忆」，还是这个名字「没有项目」（0.2.47）

### 57.1 查无此名会被当成「此项目空白」

`memory_project` 是注入里点名让模型「先查项目全景」的那个工具。它的空结果原来只有一句
`project.empty`：`【项目：X】该项目暂无记忆条目。`

而 `buildProjectSectionText()` 返回 `null` 有三种来路：名字一条都对不上；名字对得上但 project 层
六类子类与项目准则都空着（`fact`/`lesson`/`topic` 里却可能有几十条）；以及真的 active 为零。
只有第三种才配叫「这个项目没有记忆」。

前两种的后果不对称：第一种会让人**另建一个名字几乎一样的新项目**，于是同一件事被劈成两半、
以后再也不会互相注入；第二种会让人以为「这个项目没什么好记的」，而真相是**全景段落只覆盖
project 层与 rules 层**——机制问题被读成了事实问题。

### 57.2 把「凭据」摆到句子里

三支的判断都用现成调用，没有新增探测：`db.listProjectNames()`（已在 `reflect` 里用过）
给「库里现有哪些项目名」，`db.list('fact'|'lesson'|'topic', { status: 'active' })` 过一遍
`projectList(r.project).includes(project)` 给「别的层还有几条」。

- 别的层有东西 → 保留 `project.empty`（它没说错，只是**只说了一半**），紧跟
  「上面这句只说了一半：…别的层还有 N 条（fact 2 / lesson 1）」+ 捞法
  `memory_search(project="X", query=…)`
- 名字对不上 → **不许出现 `project.empty`**，改说「这个名字在库里一条都对不上」+ 现有项目名
  （最多 12 个），末尾「这不是『这个项目没有记忆』，是名字没对上」
- 真没有 → `project.empty` + 「查过七层表：…active 条目是 0 条，这次是真没有」

### 57.3 「只说了一半」比「说错」更难发现

第一支是这一轮唯一的新形态：原句**不是错的**，它只是把自己当成结论在用。
判据因此不能只查「有没有结论句」，还要查「有没有那句补白」——所以
`PROJECT_OTHER_LAYERS_MARK` 盯的是 `在别的层还有`，而不是 `null` 分支里有没有 `project.empty`。
保留原句也顺手保住了上游测试的兼容性：真正空的场景，输出前缀一个字都没变。

### 57.4 归类函数与判据

`projectAnswerKind()` 顺序 `nameNotFound → otherLayers → empty → ok`（「查无此名」最该被识别，
它最容易引出「新建一个重复项目」）。措辞表 23 个常量、判据清单 17 条（新增 `vendor-project`，
读 meow 源码）、doctor 补丁账本第 16 条、`probe-fusion` AD1–AD2、verify「project:」九条。

### 57.5 验收

`probe-fusion` AD1（对不上的名字不冒充「没记忆」且报出现有项目名）、AD2（只在 fact 层写一条时
说「别的层还有 1 条」）、verify「project:」九条（四句归类 / 三个分支互斥 / 补丁标记与凭据锚定 /
判据清单里有 `vendor-project`）、`tools/criteria.mjs` 自检（17 条判据各自都能被打红）。

## 58. 第十一次：dream 说「没有需要整理的记忆」，其实消息没送出去（0.2.48）

### 58.1 一个布尔值掩盖了四种停下

`startWindowDream()` 只回 `true` / `false`，所以 `memory_dream` 只能反推：

```js
const lease = getDb(workspace, dir).getDreamLease(sessionId)
note: lease !== null ? '已有 dream 任务在进行中（或待补收尾）' : '本窗口没有需要整理的记忆'
```

四个 `return false` 里，`noRounds`（盘点过真没有）说「没有记忆」是对的；`noSessionId`
（拿不到窗口标识）与 `claimed`（租约被占）各有各的因由；最要命的是 `sendFailed`——
`sendMemoryTurn()` 没把消息送进会话，函数已经 `db.releaseDream(sessionId)` 把租约放掉了，
于是 `lease === null` 恰好落进「没有需要整理的记忆」那一支。

于是「可重试的失败」被写成「结论」。这类错误最贵：**结论句会终止后续动作**。用户看到「没有需要
整理的记忆」，就不会再触发第二次，记忆从此停在未封存状态。

### 58.2 用 trace 收集器回传原因，而不是改返回值

返回值不能动（四个调用方都按布尔用），也不能让调用方各自再猜一遍。做法是加一个**可选的**
第 7 个参数 `trace`，函数内部把原因写进去：

```js
const say = (reason) => { if (trace != null) trace.reason = reason; return false }
if (!sessionId) return say("noSessionId")
if (rounds.length === 0) return say("noRounds")
if (!db.claimDream(...)) return say("claimed")
if (!sendMemoryTurn(...)) return say("sendFailed")
```

老调用方（心跳补收尾那两处）不传 `trace`，行为一个字不变。工具面与 `/dream` 命令面都读
`trace.reason` 分支说话，同一句「没送出去」在两个入口得到同一种诚实——这正是「统一面板口径」
的落地方式：**不是把两处文案改成一样的句子，而是让两处读同一份凭据**。

### 58.3 只有一支敢下结论

- `noRounds` → 「没有需要整理的记忆（盘点过：没有未封存的记忆轮次）」——**唯一**的结论句
- `claimed` → 「确实有记忆要整理，但已经有一个 dream 在跑…这次没启动」
- `sendFailed` → 「这次没启动成功…要整理的记忆还在，稍后再触发一次就行」
- `noSessionId` → 「这次没启动成功：拿不到这个窗口的标识」

后三支都显式带上「这不是『没有需要整理的记忆』」，因为读者只记住最后那半句。

### 58.4 融合层再守一层

`lib/macro/defs/dream.js` 原来直接 `return r.text`。子插件被上游换回去、或 `flow.call` 返回空串时，
工具会**一个字都不吐**——空串比错句更糟，它连「这次没算成」都不说。现在空回执自己补一句
「整理任务这次没有任何回执…这不是『没有需要整理的记忆』」。**文案即接口**：这句不带结论，
也不冒充 `DREAM_NOTHING_MARK`。

### 58.5 归类与判据

`dreamAnswerKind()` 顺序 `notStarted → busy → nothing → ok`（「没启动」先判，`nothing` 才允许
是结论）。措辞表 26 个常量、判据清单 18 条（新增 `vendor-dream`，读 meow 源码）、doctor 补丁账本
第 17 条、`probe-fusion` AE1–AE3、verify「dream:」十条。

### 58.6 验收

`probe-fusion` AE1（四支各归各的，「没送出去」那句自己否认了「没有需要整理的记忆」）、
AE2（真调用：探针的假 agent 送不出消息，走的正是 `sendFailed`，输出既不是空串也不是「没东西」）、
AE3（子插件沉默时融合层自己说话）。verify「dream:」十条（常量按值 / 六句归类 / 三支互斥 /
四个 `say(...)` 齐全 / 工具面与命令面都读 trace 且旧的 `getDreamLease` 反推已不存在 /
融合层兜底 / 判据清单有 `vendor-dream` / 版本与文档）。



## 59. 改记忆的回执：静默被丢掉的字段（0.2.49）

### 59.1 「已更新」是一句结论，不是一句回执

`memory_update` 的 execute 到 0.2.48 为止只回一个 `ok`。过滤逻辑本身是对的：
`goal` 只有 topic 层有、`user`/`soul` 层没有项目归属、`content` 给空串不能把整段清空。
问题在于过滤之后**没有人说话**：`patch` 空了，`ok` 仍取 `true`，render 照旧输出「✅ 已更新」。

这比沉默更坏。沉默会让人再查一次；**一个肯定的答复会让人不再查**。于是：写错层的字段、
拼空的关键词数组、空串的 content——全部被记成「改好了」，下一次读到旧内容时，人怀疑的是读的那一方。

### 59.2 三种「没改」各说各的话

- **一个字段都没写进库**：`这次什么都没改`——逐个点名 `dropped` 里的字段与原因（六种：
  `content` 空串 / `status` 越界 / `importance` 非数 / `goal` 层不对 / `project` 层不对 /
  `keywords` 归一后空），末尾一句「这不是『已经更新好了』」。
- **写进去一部分**：先说已更新哪几个，再说「但这几个字段没生效」，收尾「这是『部分生效』，不是全部」。
- **找到了但没写进库**：`找到了这条记忆，但没写进库`——不冒充「找不到」（那会让人去重建一条），
  也不冒充「已更新」。

### 59.3 ok 的语义收紧

`ok` 从「这次调用没抛错」收紧成「这次真有字段写进了库」：
`ok = changed.length > 0 && db.update(...) === true`。
这样上游任何一处 `if (value.ok)` 都不会再把「什么都没改」当成成功——**判据写在返回值上，不是写在文案里**。

### 59.4 归类顺序：partial 必须排在 ok 前面

`updateAnswerKind()` 顺序 `nothing → partial → notFound → ok`。
partial 的句子以「✅ 已更新」开头（它确实改了一部分，不该否认），与真·全部生效只差后半句，
所以它必须比 `ok` 先判；顺序写反了，这两种回执就永远分不开，判据也测不出来。

### 59.5 融合层不被空回执沉默

`defs/update.js` 原来只是管道：`return main.text`。子插件被上游换回去、或返回空串时，
render 会退回 `JSON.stringify(value)`——`{"ok":true,"id":"…"}` 读起来像一张收据，其实什么都没说。
现在空回执自己补一句「更新这次没有任何回执…这不是『已经更新好了』：先 memory_read 看一眼」。
同一条缺陷在两层各守一次（0.2.45 的教训：只修上层会留暗处）。

### 59.6 归类与判据

措辞表 29 个常量、判据清单 19 条（新增 `vendor-update`：三 mark + 「这不是『已经更新好了』」 +
`const changed = Object.keys(patch)` + `const dropped = []` + `note: { type: "string" }`）、
doctor 补丁账本第 18 条、`probe-fusion` AF1–AF5、verify「update:」十二条。

### 59.7 验收

`probe-fusion` AF1（四种回执各归各的，partial 不会被当成全部）、AF2（真调用：只给 id → 「这次什么都没改」，
并明确断言**不含**「✅ 已更新」）、AF3（goal 写给 fact 层 → 点名 `goal（只有 topic 层有目标句，这条是 fact）`）、
AF4（真改 importance → 报出改的是哪个字段；查无此 id → notFound 而不是另两种）、
AF5（子插件空回执 → 融合层自己说话）。verify「update:」十二条覆盖常量按值、四句归类、
partial 与 ok 的分界、两句互斥、旧谎的凭据（`? db.update(...) : true` 必须消失）、六种过滤原因、
`ok` 的收紧、融合层兜底、判据清单与版本文档。

## 60. 写记忆的回执：错层比丢字段更远（0.2.50）

### 60.1 六个参数被悄悄纠正，回执只有一句「已写入」

`memory_remember` 的 execute 里，`level` 不是枚举值就直接落 `fact`：

```js
const level = typeof parsed.level === "string" && LEVELS.includes(parsed.level) ? parsed.level : "fact";
```

过滤本身是对的（不能把 `goal` 写进 fact、不能让 `corrected` 污染 topic），错的是**过滤完不说话**。
`subcategory` / `goal` / `corrected` 给错层就丢，`importance` 小数被四舍五入，内容像旧条目就并进去。
五种情况共用一句 `✅ 记忆已写入（fact，id=…）`。

### 60.2 错层比丢字段更远，因为它是「之后再也找不到」

丢一个 `goal`，用户顶多发现目标句没生效；写错层，那条记忆就**住进了另一个房间**——
按 `memory_project`、按层检索、按 `level` 过滤都看不见它，而回执说「写好了」。
更远的是：`memory_update` 不改层，所以补救只能在正确的层重写一次，再把错层那条归档。

### 60.3 「合并」是另一种口径：不是多了一条，是旧的那条被改写

去重阈值 0.8 是 meow 原本的设计（商业标准要求保留），但回执原来把「合并」和「新写」都说成写入。
现在合并支单独说：并进了哪一条、原条目的内容被替换、`importance` 取较大值。

### 60.4 干净路径一个字都不改

只有「不干净」的句子才换行加注：`note` 为空时 render 仍返回原来那一行
`✅ 记忆已写入（level，id=xxxx）。项目：…。关键词：…。无需重复调用本工具。`
——老用户读到的字一个没变，判据也留着这条断言（细节被顺手改掉，比功能坏掉更难发现）。

### 60.5 归类与判据

`contract.js`：`REMEMBER_LEVEL_FALLBACK_MARK`（`这不是「按你说的层写好了」`）、
`REMEMBER_DROPPED_MARK`（`这几个参数没生效`）、`REMEMBER_MERGED_MARK`（`这是「合并」，不是「新写一条」`），
`rememberAnswerKind()` 顺序 `levelFallback → dropped → merged → ok`。
`tools/criteria.mjs`：`CONTRACT_MARKS` 32 个、归类函数 12 族、清单第 20 条 `vendor-remember`。
`verify.mjs`：A47 十三条。`tools/probe-fusion.mjs`：AG1–AG5（含真写一条层名拼错的、真写两遍同一句看合并）。

### 60.6 验收

- `check-all` 12/12；探针 AG1–AG5 全绿；A47 全绿；`vendor-remember` 绿。
- 阴性对照两刀：把 `rememberAnswerKind` 的 `levelFallback` 支改回 `ok`、把 vendor 的 `levelBad` 改成 `false`，
  探针与 verify 都要红。

## 61. 检索的层名过滤：空数组不是「没有」（0.2.51）

### 61.1 一行 filter 藏了三种静默

```js
const levels = parsed.level.split(',').map((s) => s.trim()).filter((s) => LEVELS.includes(s))
```

`filter` 的语义是「把不要的丢掉」，但在 `level` 这里它是**一把会咬人的刀**：全丢掉之后数组为空，`rows` 为空、`hits` 为空，回执只剩 `BASE_NOTE`（「如果冲突，以最新的为准」）。三种来路共用这一句：

- `level: "lessons"` —— 层名是复数，一个都不认识；
- `level: "fact,lessons"` —— 认识一半，另一半静默丢掉；
- `level: "fact"` —— 层名都对，但那层零命中（别的层里的同关键词根本不会被看到）。

前两种最坏：它把「层名没对上」卖成「记忆里没有」，于是有人会照着再写一条，或者以为写入失败。

### 61.2 为什么「一层都不查」也得说话

工具面是被模型读的。模型看到「零命中」+「如果冲突以最新的为准」时，没有信号告诉它「你给的参数根本没被接受」——它只会把零命中当成事实。所以修法不是「猜一个默认层去查」，而是**保持一层都不查**（这是用户的意思），同时把原因写在结果里：想查就把层名改对，再查一次。

### 61.3 三句话各管一种来路

| 分支 | 说话 |
|---|---|
| 全都不认识 | `这次一条都没查：你给的层名「lessons」不在七层里（…）。这不是「记忆里没有」，是层名没对上——换成真实层名再查一次。` |
| 认识一部分 | `这几个层名没生效：lessons（不在七层里）——这次只查了 fact 层。` |
| 都对但零命中 | `这次只在 fact 层里查了，零命中：别的层就算有同关键词也看不到——要全层查就去掉 level 参数（默认 fact / lesson / topic / rules）。` |

第三句是 0.2.51 顺手补的：它和「记忆里没有」差得很远，但过去同样只有一句 `BASE_NOTE`。

### 61.4 老话不动

没给 `level` 时那句 `本次零命中：默认检索范围是 fact/lesson/topic/rules，soul 与 user 层不参与关键词检索…` 是 0.2.39 之前就有的好句子，一个字都不改。判据里专门有一条钉住它（`AH5` / A48 的「没给 level 的老话一个字不变」）。

### 61.5 融合层再守一层

`lib/macro/defs/search.js` 在本地检索拿回空串（或 `{"hits": []}` 那种裸 JSON）时说：`检索这次没有任何回执（既没有条目，也没说为什么没有）——这不是「记忆里没有这条」…`。这守的是「上游补丁被冲掉」的情况，和 0.2.49 / 0.2.50 的做法一致：同一缺陷两层各守一处，不能只修上层留暗处。

### 61.6 归类与判据

`contract.js` 里 `searchAnswerKind(text)` 五支：`levelNone → levelPartial → noReply → scopeOnly → ok`。
`levelNone` 排最前，因为它最容易被读成结论；`noReply` 排在 `scopeOnly` 前，因为「一个字都没有」比「只查了几层」更没信息。

判据要同时盯住「话在不在」和「话有没有被拼进结果」——只断言常量存在会被「写了常量没人用」蒙过，所以 A48 里既有 `levelBad`/`levelValid` 的源码锚点，也有 `note` 拼装那一行的正则。

### 61.7 验收

- `CONTRACT_MARKS` 36 个，`contractChecklist` 21 条（`vendor-search` 为绿）
- `probe-fusion` AH1–AH6：五种归类、三种真实调用（`lessons` / `fact,lessons` / `fact` 零命中）、默认范围不受污染、桩 bridge 空回执兜底
- `verify` A48「search:」十条；`doctor` 补丁账本第 20 条
- 阴性对照：`searchAnswerKind` 的 `levelNone` 支改成 `ok` → AH1/AH2 与 A48 全红；vendor 的 `levelBad` 过滤改成恒空 → AH3 点名那句消失、A48 源码判据红

## 62. 读记忆的短 id：撞车不是「读到了」（0.2.52）

### 62.1 一行 findById 藏了三种来路

`memory_read` 的 execute 原来是 `const found = getDb(workspace, dir).findById(id);`。`findById` 对短 id 走 `WHERE id LIKE '<前缀>%'`，注释写得很坦白：「前缀碰撞时取第一个」——按 `LEVELS` 顺序跨表挑第一条。render 于是照样输出「[fact] 标题（active）」，语气与真读到一模一样。

于是三种来路共用一句输出：① 撞车（递来别人的正文）② 真没有（拼错 / 位数不够 / 建在别的 cwd）③ 真读到了。第 ① 种最坏：它**是错的，而且看起来是对的**。

### 62.2 撞车为什么不能「取第一条」

- 短 id 本来就是设计上的便利（前 8 位够用），前缀碰撞是必然事件，不是边缘情况——同一层里同前缀的两条、跨层同前缀，都会撞。
- 取第一条之后，用户手上没有任何信号：他会以为「改好了 / 就是这条」，然后基于别人的正文做决定。
- 更糟的是**写**路径（`memory_update`）遇到歧义是直接抛错的（`短 id 命中 N 条`）。读比写松，同一套 id 规则两种口径——写完不放心，读回来却不是那条。

所以读路径改成先数一遍：`if (matches.length > 1)` 就**一条都不读**，把候选列出来（前 5 条 + 「…等 N 条」），并明确写「不是我替你挑第一条」。要让机器挑第一条，得是调用方明确要求的事；默认的「帮你读」不许悄悄做选择。

### 62.3 「真没有」也得说清是哪种没有

原来只有一句「未找到该记忆。」它把三件事混成一件：拼错、位数不够、**这条记忆建在别的 cwd 会话里**。最后一种最容易被误判成「它被删了」——记忆库按 workspace 分库存（`getDb(workspace, dir)`），换个目录就是另一个库。所以那句话里必须同时出现：当前工作区名、位数要求（至少 8 位）、以及「用 memory_search 反查 id」的出路。

### 62.4 融合层不被空回执沉默

子插件的 `render` 万一返回空串（版本漂移、异常被吞），融合层不许把这个空串当正文交出去：空字符串会被读成「这条记忆是空的」。`defs/read.js` 在 `said.length === 0` 时自己说话，并否认「这条记忆是空的」。

### 62.5 归类与判据

`readAnswerKind()` 四支顺序 `ambiguous → notFound → noReply → ok`。**ambiguous 必须排在 notFound 前**：撞车那句里也含「一条都没读」，两支的措辞有交叠，顺序错了就会把「替你挑了第一条」归成「真没有」——两种都不对，但错法不同，判据要分得开。

判据清单第 22 条 `vendor-read` 同时钉住三句话、`findByIdAll` 的用法、`matches.length > 1` 的判断、`ambiguous` 字段与 render 的分支顺序；探针 AI1–AI5 用真库跑四种来路（真库里两位前缀必撞，实测命中 7 条）。

### 62.6 验收

- 判据：39 常量 / 14 族 / 22 条清单
- 探针：AI1–AI5（含「不递正文」「给出位数出路」「唯一 8 位照常读」）
- 阴性对照两刀：① `readAnswerKind` 的 ambiguous 支 → `ok`（撞车会被读成读到了）② `matches.length > 1` → `false`（退回静默取第一条）

## 63. 相似检索的基准：撞车的 id 不能拿来当尺子（0.2.53）

### 63.1 一处 `findById`，三种静默

`findSimilarTool` 的 execute 原来只有两行：

```js
const found = db.findById(id);
if (!found) throw new Error(`memory_find_similar: 未找到记忆 ${id.slice(0, 12)}`);
```

`findById` 的注释自己写着「前缀碰撞时取第一个」。于是同一句回执背了三种完全不同的来路：

1. **真找到了**（全 id，或 8 位前缀恰好唯一）——正常；
2. **撞上多条**（`0m` 这种两位前缀能撞七八条）——取第一条，然后**拿别人的正文当基准**算相似度；
3. **一条都没有**——`未找到记忆 0mzz`，读者会读成「记忆里没有相似的东西」。

第 2 种是这一轮要修的重点，因为它**看起来最正常**。读记忆读错了，你打开正文就发现不对；
相似检索拿错基准，回给你的是一串带 `相似度 0.xxx` 的条目，排序合理、格式完整，只有**内容全错**。

### 63.2 为什么读路径要和写路径一个口径

`memory_update` 早就是 `findByIdAll` + `matches.length > 1` 抛错（写错一行是要出事的）。
`memory_read` 在 0.2.52 也收了紧。剩下的 `memory_find_similar` 同样是「拿 id 去找一条记忆」，
口径必须一致——否则同一个短 id，写的时候报「命中 3 条」，相似检索却悄悄替你选了一条。

### 63.3 修法：先数一遍，再决定说不说

```js
const matches = typeof db.findByIdAll === "function" ? db.findByIdAll(id) : db.findById(id) ? [db.findById(id)] : [];
if (matches.length > 1) {
  // 列前 5 条候选 + 「…等 N 条」，一条都不比
  throw new Error(`memory_find_similar: 相似检索这次一条都没比：这个短 id 命中了 ${matches.length} 条（…）。不是我替你挑第一条——基准挑错，比出来的相似度全是错的。把 id 给够位数（至少 8 位，最好整条）再试。`);
}
const found = matches[0];
if (!found) {
  throw new Error(`memory_find_similar: 相似检索没起点——这个工作区里一条都没有：id「${id}」在七层表里都查不到（记忆库按工作区分开存，当前工作区 ${workspace}）。…`);
}
```

保留 `typeof db.findByIdAll === "function"` 的退路：老库没有这个方法时退回单条查找（不吞异常）。

### 63.4 「没比」和「没相似」是两件事

0.2.46 已经为「一条相似的都没有」写了四种原因与那句唯一的结论
（`这才是「记忆里没有相似的东西」`）。这一轮的两句话**都不许**碰那句结论：
撞车是「你没给我一把能用的尺子」，没起点是「这个工作区里没有这把尺子」，
两者都还没开始比，谈不上「没有相似」。

### 63.5 归类仍只有一个函数

`contract.js` 里 `similarAnswerKind` 是 0.2.46 建的。这一轮把两支并进去，顺序：

`ambiguous → notFound → notComputed → none → ok`

撞车排最前：一旦基准错了，后面三种说法（没算成 / 没有相似 / 算出来了）全都不成立。
（再声明一个同名函数会让整模块 `SyntaxError: Identifier 'similarAnswerKind' has already been declared`
——本轮真的踩了一次。）

### 63.6 判据与验收

- 判据 `vendor-similar-id`（0.2.46 的 `vendor-similar` 保留，管的是空命中那句）；
- 探针 AJ1–AJ4；
- verify `similar:` 十二条；
- 阳性：`check-all` 12 支全绿；`probe-fusion` ALL PASS 且连跑两次结果一致（探针自造的记忆带时间戳，不与上一轮合并）。

## 64. 连线归一：一处 `null` 藏了三种真相（0.2.54）

### 64.1 一处 `null` 三种来路

`linkflow.js` 的 `resolveId` 原来就一行判断：

```js
const full = r.value && r.value.found === true && typeof r.value.id === 'string' ? r.value.id : null
```

`null` 至少有三种来路：撞车（0.2.52 起 `memory_read` 会明确回 `ambiguous`）、没查成
（`tryCall` 拿不到工具，`entry` 是 `undefined`）、真没有（`found === false`）。
调用方拿到的却只有 `null`，于是三处都照着「它没了」说话：

- `defs/link.js`：`找不到这条记忆：…——id 可能写错了，或者它已经被合并/删除。`
- `linkflow.js` 的 `applyLinks`：`- ${id}：找不到这条记忆（id 写错了，或它已经被合并掉）`
- `links.js` 的 `flushPending`：`dropped += 1` 并 `done.push(entry)`，注释写着
  「归不出来的说明记忆已被删/合并，永远连不上，直接摘掉」；面板再报
  `清掉 N 条永远连不上的（记忆已合并/删除）`。

### 64.2 为什么必须现在修

0.2.52 刚把「读」分成四支，0.2.53 又把「相似检索的基准」分成五支——两处都在说
「撞车不是不存在，也不是没有」。可连线这条路还停在 0.2.30 之前的口径上：
一处 `null` 既当「没有」又当「没查到」。读的路由已经说实话，写与补连的路由还在撒谎，
这比两处都撒谎更容易让人相信错的那半边。

### 64.3 结构体而不是布尔

`resolveIdDetail` 回 `{ kind, id, note?, candidates? }`，四种 `kind` 直接对应四种事实。
`ambiguous` 原样带 meow 的 `note`/`candidates`：**候选清单只有一处口径**，这里不重写措辞
（重写过一次就会有两份说法，谁先改谁尴尬）。

### 64.4 队列的判断顺序

补连队列（`flushPending`）里 `norm()` 同时认结构体与老的 `id`/`null`（探针与外部调用可能还在用旧形状）。
判断顺序固定：

`ambiguous` → 留 → `unavailable` → 留 → `missing` → 摘。

摘的条件必须放在最后：只要不是「明确查无此条」，就不许删用户的队列条目。
删掉是**不可逆**的（没有审计日志），留着最坏只是多试一轮。

### 64.5 面板跟着一起说实话

`dropped` 的文案一个字没改——它现在只统计「真没有」的那些，那句话才成立。
新增两条：撞车多少条、没查成多少条，都说「原样留着 / 没连也没摘」。
面板要是只说 `dropped`，用户会以为那一轮把它们清掉了，其实它们还在队里。

### 64.6 判据与验收

- 判据 `link-resolve-three`：三常量在、`resolveIdDetail` 四种 `kind` 在、`defs/link.js` 走
  `flow.resolveIdDetail` 且旧那句已消失、`links.js` 两个 `+= 1` 后面跟 `continue`、
  `dropped` 只在 `da.kind !== 'ok' || db.kind !== 'ok'` 之后、返回形状带两个新计数。
- 探针 AK1–AK5（含面板不出「清掉」、老 `resolve=null` 仍摘）。
- verify `link:` 十三条。
- 阳性：`check-all` 12 支全绿；`probe-fusion` ALL PASS 连跑两次一致。

## 65. 「0 条」不等于「没有」：四个来路，一份空值（0.2.55）

### 65.1 一处 `[]` 四种来路

`store.js` 的老 `readJsonl` 长这样：

```js
let raw = ''
try { raw = readFileSync(file, 'utf8') } catch { return [] }
const out = []
for (const line of raw.split('\n')) { if (!line.trim()) continue; try { out.push(JSON.parse(line)) } catch {} }
return out
```

一个 `[]` 同时代表：文件不存在 / 读不出来（`EISDIR`、`EACCES`）/ 整份都是坏行 / 文件在但没内容。
`appendJsonl` 同形：`try { … return true } catch { return false }`，而所有调用方都把 `false` 丢掉。
于是「我写不进去」在整条链路上没有任何人知道，最后只剩面板那一句话可以说。

### 65.2 为什么必须现在修

0.2.52 – 0.2.54 三刀都在修同一族缺陷：**一个空值被用来表示多种真相**。
读路径（`memory_read`）、相似检索（`memory_find_similar`）、连线归一（`resolveIdDetail`）都改完了，
面板这两处还留着最早的一种，而且方向最坏——它把「本机的写入失败」说成「用户还没开始用」。
账本、队列都是本地文件，失败原因（`EISDIR: illegal operation on a directory`）本来就在手边，
只是被 `catch` 吃掉了。

### 65.3 为什么是 `Detail` 后缀、而不是改老函数签名

`readJsonl` / `appendJsonl` 有十几个调用方，其中多数真的只关心内容。
新增 `readJsonlDetail` / `appendJsonlDetail` 返回结构体，老函数退回成一行转发——
调用点零改动，需要说实话的两处（成本面板、队列面板）自己升级。
这与 0.2.54 的 `resolveId → resolveIdDetail` 是同一个形状：**兼容壳 + 明细函数**。

### 65.4 失败账为什么要清零

第一版只累加 `failures`，探针立刻暴露一个反向谎报：盘修好、账本删掉之后，面板还在喊
「一行都没写进去」。旧账不能冒充现在的状态，所以**写成功即清零**。
留在 `writeFail` 里的只有「连续失败次数 + 最后一次错误」，够诚实，也不至于变成一个需要持久化的指标系统。

### 65.5 队列这一侧更贵

`queuePending` 写盘失败返回 `false`，但调用方（`memory_remember` 的 `links`、`memory_link`）
照样报「已排队等补连」。0.2.54 之后「排队」是撞车 / 没查成时的**唯一**兜底，
所以这条无声失败等于把兜底也一起丢了。面板因此必须说「一条都没存下来」，
而不是「0 条，都连上了」。

### 65.6 判据与验收

- 判据 `store-fail-visible`（清单 25 条）：`readJsonlDetail` / `appendJsonlDetail` 在位、
  `ENOENT` 与别的错误分开、四支文案各自在、写成功清零、真没有那一支没丢。
- 探针 AL1–AL8：临时 `DSH_HOME` + 真文件系统故障（坏行 / `EISDIR` / 写入失败），
  八条各钉一个分支，AL8 钉「清零之后仍说原来那句」。

## 66. 「参数没生效」不等于「查了没有」（0.2.56）

### 66.1 一个 filter 吞掉四种错误

`filterSearchable(rows, opts)` 里只有一句 `statuses.includes(r.status)`。看起来无害，问题在上游：
`statusList` 是从用户字符串切出来的，**没有白名单**。用户写 `status: "done"`（很自然的猜测，因为 todo 完成就叫 done）时：

1. `db.list(lv)` 拿 `status: "done"` 去查 → 零行；
2. `filterSearchable` 再按 `done` 过滤 → 还是零行；
3. 回执走「零命中」分支 → `本次零命中：默认检索范围是 fact/lesson/topic/rules…`。

三步都没有错，合起来是一句谎话：它把「你给的状态值不存在」说成「这些层里没有」。读者照这句去补记忆，就会写出重复条目。
同一条路上还有三个兄弟：`days: 0`（过滤消失）、`k: 100`（夹成 50）、`content_max: -5`（夹成 0），
它们不产生零命中，但都在**替用户改条件**而不说。

### 66.2 为什么这一处比 level 更危险

`level` 写错（0.2.51）至少结果是「一条都没查」，用户看得见零命中，容易起疑。
`status: "done"` 更糟：如果库里有 `stale`（完成态）条目，用户以为查的就是它们，拿到零命中只会怪记忆库没存。
`days: 0` 反过来：**多给**了结果，用户以为限了时段，看到的却是全部——这种偏差不会自己冒出来。
所以这一轮的判定标准不是「有没有零命中」，而是「用户给的条件有没有被悄悄换掉」。

### 66.3 全错和部分错要分开

`status: "done"` → 一行都别查（`rows = []`），并明说「这次一条都没查」。
`status: "stale,done"` → 按 `stale` 正常查，但点名 `done` 没生效、这次只按 `stale` 过滤。
只做后者会让「全错」看起来像「查过了但没有」，只做前者会让「一半能用」整个作废。
两条都要，和 `level` 那一轮同构——同一套判断，不另发明口径。

### 66.4 静默夹边界也是谎报

`k: 100` 夹成 50、`content_max: -5` 夹成 0，都是「我替你把参数改了」。
改可以（保护库和上下文），但必须说出口：`k 给的是「100」，超出 1–50，这次按 50 条处理。`
判据里 `kClamped` / `cmClamped` 两个布尔就是为这句服务的——只在**真的改了**的时候才说话。

### 66.5 提示必须能互相排除（AM7 是防狼来了的那一刀）

加提示最容易犯的错是「一律加」。探针 AM7 用一组合法参数（`status: active, days: 30, k: 5, content_max: 100`）
跑真调用，断言四句提示**一句都不出现**，而且老口径（`本次零命中`）照旧在。
判据里也有对应的一条：`statusDead` 时才压制 `plain` 那句，其它情况不动。

### 66.6 判据与验收

- 判据 `vendor-search-param`（第 26 条）：白名单常量、`statusBad` / `statusList` / `statusDead` 三个派生量、四句提示原文、`rows = statusDead ? []` 短路、`note` 七项拼接顺序。
- probe 探针 AM1–AM7：全错 / 部分错 / `days: 0` / `k: 100` / `content_max: -5` / 合法参数不加料。
- verify A53 组 12 条把上面这些连同「版本 ≥0.2.56」「README 与 DESIGN 记了这一轮」一起钉住。

## 67. 「给 0 就照办 0」：数值参数不是布尔开关（0.2.57）

### 67.1 一句 `|| 默认值` 把三种情况压成一种

星图六个工具收参数都是同一句形状：`Math.max(min, Math.min(max, Number(args.x) || def))`。它一次做了三件事——转成数字、兜默认值、夹进边界——三件都不留痕迹：

- `0` 是 falsy。`min_weight: 0` 的语义是「**不要按权重过滤**」，被 `||` 判成「用户没给」，换成 0.5。于是本该回来的条目没回来，而回执（`nebula_bridge` / `nebula_recall`）在空结果时还会建议「把 min_weight 调低一点」——**用户按建议调了，调的还是 0**，永远调不动。这是这一轮最坏的一处：不只是不吭声，还给出一个照着做也没用的建议。
- 越界被 `Math.min/max` 夹住。`limit: 100` 变成 30，回执说「这就是全部 30 条」——数字是真的，**结论是假的**。
- 非数字（`"十"`）→ `Number` 得 NaN → `NaN || def` 得 def，静默退回默认。

### 67.2 为什么必须现在修（而不是「反正有默认值」）

默认值本身没错，错在**改了条件不说**。前几轮修的都是「空结果被解释成别的东西」，这一轮是「**输入**被解释成别的东西」——比输出撒谎更上游：读的人会拿着被改过的条件去判断「图里就这么多相关记忆」。而 macro 层的 `flow.tryCall` 原样返回 `r.text`，尾注能直接透到模型面，所以这里加一句话是有效投递，不是自嗨。

### 67.3 为什么是一个 `numParam()` 而不是六处各写一遍

六个工具、十个参数、三套边界，各写一遍必然漂移（第一版 `nebula_path` 里就有两处 `Number(args.maxHops) || 6`：入口一处、`!found` 分支一处，改漏一处就一半生效）。统一成 `numParam(name, raw, { min, max, def })` 返回 `{ value, note }` 之后：

- 判断规则只有一份：空值→默认；非有限数→默认 + 说；`Math.max(min, Math.min(max, n))`；`clamped === n` 时 `note: ''`（**正好等于边界的合法值不许报**，否则 `limit: 30` 天天喊「越界」就是狼来了）。
- 站点只负责把 `note` 贴到结果上，不负责判断。

### 67.4 尾注贴在哪：跟着「这次的结果」走

- `recall`：`notes` 拼在 `formatHits` 之后（`base + "\n" + notes`），因为命中列表要先给。
- `inspect` / `stats` / `hygiene`：`lines.push('', note)`，接在正文最后——它们的结果是「一份报告」，说明放在报告末尾读起来顺。
- `path`：**两个出口都贴**。没连上也可能是跳数被夹过（你给 0、按 1 算出来的「没有关系」并不等于你要的 0 跳结论）。
- `bridge`：空结果与成功两处都贴，且 budget 全用 `.value`（`maxItems/maxChars/minWeight/hops`）——bridge 最容易出现「条数被夹了还以为是全部邻居」。

### 67.5 判据与验收

- 判据第 27 条 `vendor-param-zero`：六个调用点必须都是 `numParam(...)` 且源码里不再出现 `Number(args.x) ||`。**踩坑**：我第一版判据用负向 `!includes('Number(args.limit) ||')`，而 numParam 的注释里恰好抄了老写法当反例 → 判据永远红、`detail` 却是 'ok'（它看的是 `function numParam(`）。修法：注释改写成不带字面量的描述，判据改成正向锚点（四条 `const pXxx = numParam(...)` 全串）。这条教训很实在——**判据和被判对象共享同一份文本时，注释也是判据的一部分**。
- 探针 `AN1–AN7` 走真工具面：`memory_search{mode:'graph'}`、`memory_search{mode:'bridge'}`、`memory_link{action:'path'}`（`nebula_*` 在模型面被 gate 摘掉了，探针直接 `run('nebula_recall')` 会抛「工具缺失」）。AN3 / AN4 / AN7 是反向哨兵：合法参数时一句提示都不许出现。
- 阴性对照两刀：cutA 把 `if (clamped === n)` 那行删掉 → 期望红「param: 统一出口 numParam()」；cutB 把 `numParam` 的越界分支改成直接 `return { value: clamped, note: '' }` → 期望红 AN2 / AN5 与判据。

## 68. 「模式名没对上」不等于「你要的那种检索」（0.2.58）

### 68.1 一句 `String(args.mode ?? 'local')` 把五种情况压成一种

老的 `memory_search` 是这样分派的：

```js
const mode = String(args.mode ?? 'local')
if (mode === 'graph' || mode === 'bridge') { … }
if (mode === 'similar') { … }
// 剩下的都当本地检索
```

分支只认三个字面量，**其它一切值（写错的、大小写不对的、中文的、空串的）都掉进最后那一支**。掉进去以后发生的事各有各的坏：

- `mode: "Graph"`：走本地检索。回了若干条关键词命中，读的人以为是沿关联扩散找到的邻居，还据此判断「图里就这么多」。
- `mode: " graph "`：同 `Graph`，只是原值多了两个空格。
- `mode: "相似"`：同 `Graph`，如果这时没给 query，还会抛「本地检索需要 query」。
- `mode: "similar"` 漏一个字母 → `similiar`：反过来抛「本地检索需要 query；只想沿星图扩散请用 mode="graph"，想找相似条目请用 mode="similar" + id」——**教他改一个他明明写过的词**，这段文案本身是对的，用在这里就成了误导。
- `mode: ""`：`?? ` 只挡 `undefined` / `null`，空串原样通过，于是「给了个空模式」也被当成「要本地检索」。

一句话：**执行层把「你要的是哪种检索」这一个问题，压成了「不是 graph、不是 bridge、不是 similar 的话就是本地」**。而这些问题里只有第一种是用户真想要的。

### 68.2 为什么必须现在修：它给出的是「另一种答案」，不是报错

前面二十来轮修的多是「回执说得不清楚」，这一处更贵一层：**它给的是另一种检索的结果，而结果是能用的**。本地命中看起来完全正常——有标题、有分数、有正文——所以没人会怀疑。等到他发现「明明连着的两条没有一起出现」，已经用这批结果做过判断了。

schema 里明明写了 `enum`，为什么还会发生？因为工具面的 `enum` 是给调用方看的描述，执行层并不保证校验；而且 `memory_search` 的 `mode` 要同时兼 `local` / `graph` / `bridge` / `similar` 四种意图，schema 的 `required` 又只能是 `[]`（`similar` 可以不写 query），校验的担子本来就落在执行层。`memory_link` 的 `action` 早就这么做了（白名单 + `throw new Error('memory_link：未知 action=')`），`memory_search` 只是漏了。

### 68.3 归一再判：`modeOf` 只做一件事

```js
function modeOf(args) {
  const raw = args.mode
  const text = typeof raw === 'string' ? raw.trim() : ''
  if (text.length === 0) return { name: 'local', bad: false, raw: '' }
  const name = text.toLowerCase()
  return { name, bad: !MODE_VALUES.includes(name), raw: String(raw) }
}
```

三个决定：

1. **空串 = 没给**。`?? ` 挡不住空串，这里显式把 `''` 与 `'   '` 归到默认值。理由是「空」和「没给」在执行层是同一件事，没必要为它造一句话。
2. **trim 之后再小写**。`Graph`、` GRAPH `、`graph` 是同一个模式名，用户不该为大小写付代价。**注意这里有反向风险**：如果只判 `bad` 不做归一，`Graph` 会被判成非法，那就等于把「用户拼错」和「用户大写」混为一谈——所以白名单判的是归一后的值，报错时说的是原值 `raw`。
3. **`raw` 留住**。报错要说「你给的是「expand」」，不能说我归一后的值，否则用户拿着自己没写过的词去对。

### 68.4 不合法的处置：先挡住，再说清，最后给对应关系

`badModeText(mode)` 的三段：

- 第一段说「没生效」与「只认哪四个」，并主动交代归一规则（大小写不敏感、前后空格会去掉）——用户不用猜；
- 第二段说「这次一条都没查——这不是「记忆里没有」，是模式名没对上」。这一句是 0.2.51 以来一直在写的那个意思：**没算过的事不许说得像算过了**；
- 第三段给对应关系（哪种意图用哪个词）。只报错不给出路，用户下一步还是瞎猜。

`execute` 里的顺序是死的：

```js
const mode = modeOf(args)
if (mode.bad) return badModeText(mode)
const text = await runSearch(flow, args, exec)
```

不能反过来——不能先跑一遍本地检索、再在结果后面附一句「其实模式没生效」。那时读者已经拿这份结果做过判断了，附注救不回来。

### 68.5 参数给在了别的模式上：`modeNotes` 的四条

`mode` 合法之后还有一类沉默：参数本身没问题，但**在这个模式下不起作用**。

| 参数 | 只在 | 说明了什么 |
| --- | --- | --- |
| `expand` | local | graph / bridge / similar 下说「没有额外的本地检索」 |
| `k` | local / similar | 在 graph / bridge 下说「这两个模式用 limit，这次按 10 / 4 条算」 |
| `limit` | graph / bridge | 在 local / similar 下说「本地检索的条数用 k，这次没用上 limit」 |
| `chars` / `min_weight` | bridge | 其它模式说「只在 bridge 生效，这次没用上」 |

为什么值得为这四条写字：`k` 与 `limit` 是**同一个概念的两个名字**，分段按模式起的名，读者很容易带错。带错了不会报错，只会「条数比我给的少」——而条数少，恰恰是最容易被解释成「就这么多」的那种现象。

### 68.6 尾注为什么只拼一次：十个 return 没有一个会说「你没用上」

老 `execute` 里有十个 `return`，每个各自成句。要把「参数没生效」这件事说全，得在十个出口各写一遍；写漏一处就是一处沉默，而漏掉的那处往往正是最常走的。

所以这一轮顺手把主体搬出去：

```js
async function runSearch(flow, args, exec) { …原主体… }

// 工具对象里只剩薄壳
async execute(args, exec) {
  const mode = modeOf(args)
  if (mode.bad) return badModeText(mode)
  const text = await runSearch(flow, args, exec)
  const notes = modeNotes(mode.name, args)
  return notes.length > 0 ? `${text}\n\n${notes.join('\n')}` : text
}
```

**踩坑记录**：第一版把主体写成对象方法 `async runSearch(args, exec) { … }`，然后在 `execute` 里裸调 `runSearch(...)`。对象字面量的方法不会进入外层作用域，`runSearch` 在那里解析成模块级的名字——不存在，直接 `ReferenceError`。要么 `this.runSearch(...)`（工具对象被解构调用时 `this` 就丢了），要么搬成模块级函数并显式传 `flow`。选后者：`flow` 本来就是 `createSearch({ flow })` 的闭包变量，传一层不增加耦合。

另一个副作用值得记：搬动之后 `import('./lib/macro/defs/search.js')` 仍然不能单独跑——它会顺着 `vendor/meow-memory/lib/index.js` 找 `@deepseek-ai/dsh-llm`，本仓没有这个包。**语法与行为只能靠 `node verify.mjs` / `node tools/probe-fusion.mjs`（它们自带桩）验证**，别指望一条 `node -e` 就能摸到。

### 68.7 判据与验收

- `tools/criteria.mjs` 第 28 条 `search-mode-whitelist`：白名单常量、`modeOf` 的归一三件、`bad` 分支在 `runSearch` 之前、四句尾注、薄壳里的 `runSearch(flow, …)` 与唯一一次 `notes.join`。**detail 只认 `function modeOf(`**——判据假红过两次，都是因为 detail 的判据和 ok 的判据读的不是同一个锚点。
- `tools/probe-fusion.mjs` `AO1–AO9` 全部走真工具面（`mode:'expand'`、`mode:'相似'`、`mode:' graph '`、`graph+k`、`local+limit`、`local+min_weight`、`graph+expand`）。其中 **AO4 是反向哨兵**：只差大小写与空格时必须照办、不许报「mode 没生效」。第一版 AO1 用的就是 `mode:'Graph'`，跑出来是绿的反面——它其实是合法值，正好证明了归一生效，但也说明**测试用例本身要先过一遍归一规则**。
- `AO9` 防狼来了：模式与参数都合法时，这五句提示一个字都不许出现。

阴性对照两刀：把 `if (mode.bad) return badModeText(mode)` 删掉 → AO1/AO3 与 verify 的 `badMode` 一起红；把 `modeOf` 里的 `text.toLowerCase()` 去掉 → AO4 红（`Graph` 被当成非法值）。两刀都恢复后全绿。

## 69.「缺参数」不是「环境问题」：连线的动作名与两端 id（0.2.59）

### 69.1 一句 `String(args.action)` 加一个不校验的 `a`/`b`

老代码只有一句：

```js
const action = String(args.action)
if (!['link', 'unlink', 'mute', 'unmute', 'path'].includes(action)) {
  throw new Error(`memory_link：未知 action=${action}`)
}
```

`a` / `b` 一个字符都不查。`resolveIdDetail(undefined)` 走的是「空 id」那一支，回 `{ kind: 'missing', id: '' }`；接着那句

```js
const missing = [ra === null ? args.a : null, rb === null ? args.b : null].filter(Boolean)
```

把 `undefined` 滤掉——**「缺参数」在这一行被抹成「两端都查到了」**。于是 payload 是 `{ a: null, b: null }`，星图回「连线未完成」，我们按「节点没入图 / 暂时没落图」处理，`queuePending(null, null, ...)` 落一条永远连不上的欠账，回执还写着「已排队，读记忆时会自动补」。

### 69.2 为什么必须现在修

- **假欠账**：每次模型忘了 `b`，队列就多一条垃圾，之后每轮读记忆都要去补一次连不上的线，面板还拿它当「欠账 N 条」。
- **归因反了**：缺参数是调用方的错，给的却是「星图还没建到（约 12s 一轮巡检）」——用户会去等、去重试、去怀疑星图。
- **口径不一致**：0.2.58 刚把 `memory_search` 的 `mode` 改成「不认识就一句都不查」，`memory_link` 是同一族的枚举参数，不能一边严一边松。

### 69.3 归一再判 + 缺哪端点哪端

动作名：`trim().toLowerCase()` 之后过 `LINK_ACTIONS`，空值单独算「没给」。不合法时三句话——给的是什么、只认哪五个、**星图和记忆都没动**（并附五个动作的对应关系，省一次来回）。

两端 id：`missingEnds()` 只认「非空字符串」，空串 / 纯空格 / `undefined` 一律算没给，缺哪个点名哪个，并写明「两端 id 没齐之前不会去动星图，也不会先排一条连不上的欠账」。

### 69.4 为什么是薄壳，而不是每个 return 各拼一句

`runLink` 有十几处 return（撞车 / 没查成 / 真没有 / 超时 / 自连 / 未入图 / path 四种翻译……）。把尾注塞进每一处，下一次改动必然漏一处——这正是 0.2.58 总结的「尾注只拼一次」。所以 `execute` 只做三件事：拦动作名、拦两端 id、调用主体，最后 `notes.length > 0 ? ... : text`。

主体因此必须搬成模块级函数并显式传 `flow`：在对象方法里裸调模块级函数会解析到外层作用域，`this` 在解构调用时会丢（0.2.58 的 ReferenceError 教训）。

### 69.5 判据与验收

- 判据 29 `link-action-and-ends`：出口三句话 + 薄壳顺序 + 「不再有 `const action = String(args.action)`」，任一处退回静默就红。
- 探针 AP1–AP8：缺 b 时**星图调用次数 0、队列 0 条**（这两条才是「没往下走」的硬证据，光看文案不算）；AP5 归一后照办；AP8 参数合适时不加尾注。

## 70. 卡片标题也是口径：为什么 `星图连线：path` 算缺陷（0.2.60）

### 70.1 抬头与卡片是同一件事的两面

正文抬头（`【宏记忆｜成本账本】`）在 0.2.25 就收口了：只由 `panel.js` 产，名字只从 `ACTIONS` 表来。但**卡片标题**一直散在八个 `presentCall` 里，各写各的模板串：

```js
title: `星图连线：${String(args.action ?? '')}`      // → 星图连线：path
title: `检索记忆：${String(args.query ?? args.mode ?? '')}` // → 检索记忆：graph
title: `项目全景：${String(args.project ?? '')}`      // → 项目全景：   ← 悬空冒号
title: `读取记忆 ${String(args.id ?? '')}`           // → 读取记忆      ← 尾空格
```

0.2.25 在 `memory_admin` 里已经明确写过「两套写法各走各的时候，卡片会变成『记忆运维：stats』这种谁也不认识的东西」——`memory_link` / `memory_search` 是同一处的漏网。

### 70.2 为什么这算缺陷，不算排版

- **键不是名字**：`path` / `graph` 是给模型填的参数值，用户看到的卡片上应该写「看证据链」「沿关联扩散」。写键等于要求用户知道枚举。
- **悬空冒号带着错误信息**：`项目全景：` 看起来像「这个项目没内容」，其实只是没给参数——和 0.2.58 那句「模式名没对上不是记忆里没有」同一类错。
- **kind 反了更贵**：`path` 是只读查询，却被标成 `write`。卡片上的「写」标签会影响用户判断这次调用会不会改动数据。
- **一行装不下**：检索词一长，标题跟着长；多行 query 会把两行塞进单行卡片，排版直接塌。

### 70.3 一条出口，三件小事

```js
export const CARD_DETAIL_MAX = 40
export function cardTitle(label, detail) { ...空→只有前缀；多行→压一行；超长→截断加省略号... }
```

细节为空返回前缀而不是 `${prefix}：`，这一条同时消灭了「悬空冒号」和「尾空格」两种历史写法（`读取记忆 0m1` 也因此变成 `读取记忆：0m1`，八个面板的冒号终于一致）。

### 70.4 名字表：键给机器，名字给人

`LINK_ACTION_LABELS`（五个动作）与 `MODE_LABELS`（四个模式）都是「只有一份」的表，跟 `ACTIONS` 表同一个道理。名字同时决定 kind：`path` → `read`，其余 → `write`。

兜底两句也算口径：「动作名没对上」「模式名没对上」——和正文里 0.2.59 / 0.2.58 的结论句对齐，卡片与正文不会各说各的。

### 70.5 验收

探针 AQ1–AQ10 直接调八个 `presentCall`（不碰外部服务）：形状、悬空分隔符、kind、中文名、截断、压行。源码侧 verify A57 组八条确保「没有第二处拼标题」——`!/title: \`/` 这条负向断言是这一轮的关键，它挡住的是「下次又有人顺手写个模板串」。

## 71.「给 0 就照办 0」在面板这条路上漏了一次（0.2.61）

### 71.1 0.2.57 修的是 vendor 侧，面板侧没跟着改

0.2.57 把星图那六个工具的数值参数统一收进 `numParam()`：给 0 就照办 0、越界与非数字带一句话出来。但 `memory_admin` 的两张本地面板（成本账本 / 待补连线）走的是另一条路——`panel.js` 的 `limitOf()`，那里还留着老写法：

```js
return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback
```

一句话把四种情况压成一个「回默认」：0、负数、非数字、非整数。用户拿着被换过的条数读「最近 200 次调用」，以为看的是自己要求的那一段。

### 71.2 为什么必须现在修：`slice(-0)` 会把「不列」变成「全列」

`costReport(limit)` 是 `detail.entries.slice(-limit)`。`limit = 0` 时是 `slice(-0)`——JS 里等于 `slice(0)`，整本账。于是面板出现最坏的那种组合：**抬头说「最近 0 次调用」，正文列出全部记录**。这不是措辞问题，是正文和抬头对着说。

`pendingReport` 是 `list.slice(0, limit)`：`limit = 0` 时一条不列，但下面 `more` 会说「… 还有 N 条」，读者得自己猜「是你要我不列，还是队列坏了」。

### 71.3 判定规则：跟 numParam 对齐，但 0 的含义不同

| 输入 | 处理 |
| --- | --- |
| 空值 | 表里的 `defaultLimit`，不加料 |
| 非数字 | 回默认 + 「不是数字——这次按默认 N 条算，不是你给的那个」 |
| 负数 | 回默认 + 「条数没有『从后往前数』这回事」 |
| `0` | **照办 0** + 「这次一条都不列——不是『一条都没有』，是你要求不列」 |
| 非整数 | 抹掉小数 + 「少掉的那半条不是你给的条件」 |

跟 `numParam` 的唯一区别：这里的 0 有明确含义（「一行都别列，我要抬头」），所以照办；`numParam` 那边的 0 也是照办（0 跳、0 权重）。两边一致的是那条底线——**能照办就照办，改了就说话**。

### 71.4 报告函数也要守住 0

`limitOf` 只保证「值是真的 0」，正文还得配合：`costReport(0)` 与 `pendingReport(0)` 各加一条早退，并且把库里真实的条数说出来。否则「照办 0」会变成「假装库里什么都没有」——那就把 0.2.55 好不容易分开的「空着四种来路」又糊回去了。

### 71.5 验收

探针 AR1–AR7 走真工具面（cost 面板纯本地，不需要星图），把 0、`"0"`、非数字、负数、非整数、正常值、缺省七种各钉一条；`verify.mjs` A58 组看源码出口与两个调用点的拼接方式；判据第 30 条 `admin-limit-zero` 保证这套口径不会在下次重构里悄悄退回去。

## 72. 「没有邻居」与「我没给对」长得一样（0.2.62）

### 72.1 一个参数，四种处境，两种结果

`memory_read` 的问题是它把用户给的条数当成了自己的内部开关：

```js
const want = args.neighbors === undefined ? 12 : Number(args.neighbors)
if (!Number.isFinite(want) || want <= 0) return said
```

这行代码读起来很安全（不是数字就退回正文），但它抹掉的东西比它保住的多：`'十'`（我没给对）、`-3`（我给了个不可能的）、`0`（我明确不要邻居）三种处境，对读回执的人来说完全一样——**没有邻居段**。

于是「这条记忆没有邻居」这个结论，既可能是事实，也可能只是我自己写错了参数。这就是 0.2.55 那四种「空着」的同族缺陷：**把「我没说清楚」混进「书里没有」**。

### 72.2 为什么这次不照 `limitOf` 抄

`limitOf` 那轮的 0 是「一条都别列，我要抬头」，所以 0 要配一句「这次一条都不列——不是没有，是你要求不列」。`neighbors` 的 0 是文档写明的『不带邻居』，语义干净，不需要解释。两边不是同一个参数，不能把文案照搬；能搬的只有那条底线：**能照办就照办，改了就要说话**。

### 72.3 一条出口：`countParam()`

`lib/macro/shared.js` 的 `countParam(name, raw, { min, max, def })` 把六种输入的返回值定死在一个地方：

| 输入 | `value` | 说不说 |
| --- | --- | --- |
| 空（`undefined` / `null` / `''`） | 默认值 | 不说 |
| 非数字 | 默认值 | 说：不是数字，按默认算 |
| 负数 | 默认值 | 说：条数没有「从后往前数」 |
| `0` | **0** | 不说（照办） |
| 非整数 | 抹小数 | 说：少掉的那半条不是你给的条件 |
| 超界 | 夹到 `[min, max]` | 说：结果是被改过的条件算出来的 |

「夹到边界」这条单独重要：以前 `999` 是被星图那边夹到 40 的，本层不知道，也不告诉人。现在夹的动作和说明在同一处发生，回执里必然带着那句「结果是被改过的条件算出来的」。

### 72.4 说明的位置是设计的一部分

`read.js` 的拼接顺序是：正文 → 邻居段（有就接）→ 说明（非空才接）。三件事分开，说明永远在最后。理由是读的人先要内容：把「参数被改过」的句子顶在最前面，等于用一句元信息拦住正文，比原来更糟。

### 72.5 验收

探针 AS1–AS10 走真工具面，除了文案还钉住**下游真的收到了什么**（`nebula_inspect` 收到的 `neighbors`）：非数字/负数 → 12，`3.7` → 3，`999` → 40，`0`/`'0'` → 根本不调，`5` → 5，缺省 → 12。`verify.mjs` A59 组看源码出口与拼接方式；判据第 31 条 `read-neighbors-param` 保证这套口径不会在下一次重构里悄悄退回去。

## 73. 零字注入：配置写坏时最不该发生的事（0.2.63）

### 73.1 为什么这一处比前两处更贵

前两处（0.2.61 的面板条数、0.2.62 的邻居条数）坏掉时，用户还能看到「结果怪怪的」。这一处坏掉时，**什么都没发生的样子**：整段 L0 注入变成空串，模型照常工作、只是没看到手册；日志没有报错，面板没有异常，回执也不会提。

而它的触发条件非常日常：`guideMaxChars: "4k"`（手滑写成带单位的字符串）、`-1`（想表达「越短越好」）、`null`（配置模板里留空）。三种都会被同一行 `|| 0` 读成 0。

### 73.2 「能照办就照办」不等于「0 永远是对的」

`guideMaxChars: 0` 的意思是「我不要注入」，这个要求本身合法，所以 `clampGuide(x, 0) === ''` 必须保留（verify 里本来就钉着这条）。但「配置写坏」不是「用户要求 0」——把两者混在一个兜底里，等于允许一个错字关掉整个功能。

所以出口按语义分开：**写坏 → 回默认并说明；显式 0 → 照办 0 并说明**。两条都不是沉默。

### 73.3 出口只有一个，三种消费方各取所需

`guideBudget(raw)` 只算「这次按多少字 + 该说什么」，不负责打印。三个消费方：

- `clampGuide` 拿 `value`（纯格式化，不产生副作用）；
- `installGuide` 拿 `note` 去 `logger.warn`（装注入那一刻就说）；
- `memory_admin(action="guide")` 把它显示在手册末尾那一行（用户自查的入口）。

好处是测试面清楚：探针量纯函数，verify 量源码出口，判据量「这套口径会不会退回去」。

### 73.4 为什么把「太小」也算一种要说话的情况

上限设成 5 是合法的（照办），但这时连收尾那句「已按上限截断，完整手册见 memory_admin(action="guide")」都放不下——`clampGuide` 会硬切 5 个字、不带指路。这不是错误，但它是一个**必须被知道**的状态：注入里既没有内容也没有出口。所以它单独带一句话。

### 73.5 验收

探针 AT1–AT11 走纯函数与真工具面；`verify.mjs` A60 组看源码出口与 warn 调用；判据第 32 条 `guide-budget-param` 守住「写坏 → 回默认并说明」。阴性对照：把非数字支改成「回 0 且不说明」时，AT2/AT8 与判据会同时红。

## 74. 「这一类是 0」与「这一类没查」长得一样（0.2.64）

### 74.1 枚举参数是最后一块裸地

0.2.59 开始，这一族缺陷修的都是「条件被静默纠偏」：`action` 裸传（0.2.59）、`neighbors` 非数字吞掉（0.2.62）、`guideMaxChars` 写坏变零字注入（0.2.63）。数值参数都上了出口函数，行动名上了白名单，剩下最后一处是**枚举**：`hygiene.kind`。

它比数值更危险，因为数值给错通常还能看出来（条数不对、字数不对），而枚举给错的结果是**空的**——空结果和「这一类确实干净」在界面上完全同形。

### 74.2 表里取不到就静默成空，是 JS 的默认行为

星图那边的写法是：

```js
const kinds = args.kind ? [args.kind] : Object.keys(NAME)
for (const k of kinds) {
  const arr = items[k] || []      // ← 不认识 → undefined → []
  const n = counts[k] || arr.length
  if (!n) { lines.push('', `${NAME[k]}（0）`); continue }
  ...
}
```

`items['dups']` 是 `undefined`，`|| []` 把它变成空数组，`!n` 成立，于是打出一行「（0）」。整条链路没有一处会报错，因为每一步都是「合法」的 JS。这类缺陷没法靠类型检查发现，只能靠「谁会读这行输出」来发现——读的人会把它当成结论。

### 74.3 为什么挡住比猜更好

第一反应是加一张别名表：`重复 → dup`、`dups → dup`、`孤立 → orphan`。有三个问题：

1. **猜错比不猜更贵。** 「重复」在中文里同时能指 `dup`（条目内容重复）和 `oversize`（单条太长）——映射到哪一边都是错的一半。
2. **别名表没有边界。** 加上中文名，下一个请求就是 `"dup "`、`"DUPS"`、`"d u p"`、`"重复项"`、`"duplicate"`。每加一个都在扩大「我替你猜」的面积。
3. **挡住只需要一次纠正。** 用户看到「只认 dup / stale / thin / oversize / unread / orphan」，下次就给对了；猜错则是每次都给一个错答案，而且用户不知道自己被猜过。

所以只做两件归一：大小写、前后空格。这两件不会产生歧义——`ORPHAN` 和小写 `orphan` 指的必然是同一个东西。空串单独处理：它是「没写」，与缺省同义，走全部六类概览。

### 74.4 「没跑」必须自己说出口

挡住时那句 `这次体检没有跑——别把「没跑」读成「这一类没有问题」` 是刻意写给模型看的。工具报错在会话里常常被转述成一句「体检没成」，而读者（人或模型）会自行补一个理由：「大概是空吧」。把「没跑」写在错误里，转述时至少有一半概率被带出去。

同一原则在 0.2.40（「0 项」不是「很干净」）、0.2.47（「没有需要整理的记忆」与「没算成」分开）已经用过，这次是它的第三种形态：**空结果必须能追溯到「查了什么」**。

### 74.5 兜底文案也不许编名字

星图那层原来打 `undefined（0）`——一个没有名字的类别。现在 `labelOf(k) = NAME[k] ?? String(k)`：不认识的键原样打出来。这不是为了好看，是为了让「这个名字它不认识」这件事在输出里留下痕迹。凡是输出里出现 `undefined` 的地方，都是某处「取不到就继续」留下的脚印，能改成原样打出来的都该改。

### 74.6 教训 ㉝

能报错的地方，不要给一个看起来像结论的默认值。空数组、空字符串、`0` 这三样在回执里都长得像「查过了，没有」，而它们同时也是「根本没查」的默认返回值——如果两者会走到同一个出口，就必须在出口处把它们分开，或者干脆不让错误输入走到出口。

## 75. 「条件没生效」与「条件生效但结果为空」——尾注是第三种骗法（0.2.65）

### 75.1 这次骗在哪

前两轮修的都是**参数入口**（邻居条数、注入上限、体检类别）：给错了值，被静默纠正，或者被静默当成别的意思。这一轮的入口是对的——`limit` 原样递给了 `nebula_recall`，星图照它执行。要说谎的是**回执**：`memory_search` 的尾注对所有非 `graph` / `bridge` 模式一律写：

```
limit 只在 graph / bridge 模式生效；本地检索的条数用 k，这次没用上 limit。
```

而 `local` 模式在「零命中自动扩散」和 `expand: true` 两种情况下，读的正是 `args.limit` 原值。于是 `limit: 0` 的人同时收到「扩散没补到东西」和「limit 这次没用上」——第一句是条件生效的结果，第二句是条件没生效的声明，合起来只能是「星图里真没有」。

这类错误的可怕之处在于**两句都是我们自己写的、单看都不算错**。单看尾注，它确实描述了「本地检索的条数用 k」这件事；单看空结果，它确实是一条都没有。错的是把两句放在一起没有核对它们指向同一个原因。

### 75.2 状态必须由执行路径回填

尾注看到的只有 `args`。用 `args.limit !== undefined` 判断「星图读没读它」是不成立的：

- 本地有命中 → 根本不扩散 → `limit` 确实没被读；
- 本地零命中 + 星图没接上 → 递过去了，但没参与结果；
- 本地零命中 + 星图接上 → 真读了。

三种情况 `args.limit` 一模一样。所以 `modeNotes` 加了第三个参数 `flags`，由 `runSearch` 在路径上打点：

```js
flags.spreadTried = true          // 调用之前：这次确实去扩散了
const spread = await flow.tryCall(...)
if (spread.entry) flags.spread = true   // 拿到 entry 之后：星图真的接了
```

两处置位之间隔着一次可能失败的调用——这就是「递过去」与「用上了」的分界，不能提前合并成一个布尔。这是本项目第二次强调同一件事（第一次是 0.2.61 的面板条数：`limitOf` 的 `note` 由出口给，不由调用点猜）。

### 75.3 三种文案，各自只说自己那种状态

| 状态 | 文案 |
| --- | --- |
| 真扩散 | `limit 平时是 graph / bridge 的条数；这次扩散真的用了它（limit=N）——本地检索自己的条数仍用 k。` |
| 没接上 | `limit 平时是 graph / bridge 的条数；这次本来要扩散（会用 limit=N），但星图没接上——它没参与这次结果。` |
| 没扩散 | `limit 是 graph / bridge 的条数；这次没有扩散，limit 没用上（本地检索的条数用 k）。` |

注意第二句仍然写出了 `N`：用户需要知道「如果它接上了，会用你给的 N」，这样「我给的 0 是不是被吞了」就不再需要猜。

### 75.4 0 不是「没给」

`args.limit ?? 5` 里 `??` 只挡 `undefined` / `null`。`0` 会被原样递给星图——这既是 nebula 侧的契约（`numParam` 对 0 的处理），也是本层的口径：**用户明确写的条件不许被默认值顶掉**。文档里写明的「0 = 不带」在 0.2.62（读记忆的邻居）、0.2.64（面板条数）已经钉过两次，这一轮是第三次。

### 75.5 教训 ㊱

**回执里的每一句都要能指明「这是哪一步的结果」。** 一句尾注如果描述的是「执行路径没走到 A」，那么它在路径真的走到 A 的时候必须消失——而不是永远挂着。展示层不许替执行层做判断，因为它看不到执行层看到的东西。

### 75.6 覆盖

- 判据第 34 条 `search-limit-used-note`（`tools/criteria.mjs`）：三态分支、置位位置、四句文案、负向断言；配套变异体把扩散那一句替换成老的「这次没用上 limit」，自己能被打红。
- 探针 AV1–AV9（`tools/probe-fusion.mjs`）：真工具面 + 假 bridge 桩，九条事实。
- 阴性对照（`tools/_neg65.mjs`）：`flags.spread = true` 提前到 `tryCall` 之前 → AV6 红；尾注退回无条件「没用上」→ AV2 / AV5 红。

## 76. 降级路径上，同一个参数换了一条腿走路（0.2.66）

### 76.1 这一轮骗在哪

上一轮（0.2.65）修的是 `local` 模式的尾注：扩散真的读了 `limit` / `hops`，尾注却说没用上。这一轮是同一个毛病的另一半——**`graph` / `bridge` 模式的尾注**，而它骗人的方式是「降级」。

`graph` / `bridge` 走星图，`pick()` 只把 `query` / `memory_ids` / `limit` / `hops` / `chars` / `min_weight` 递给星图。用户在 graph 模式里写 `project`、`level`、`days`、`k`、`content_max`、`explain`，这些条件在星图那一路**不会报错，也不会提示**——它们就是被过滤掉了，结果照样回来。读者看到的是一份「已经按项目筛过」的结果，其实一条都没筛。

更糟的是这些条件还会在另一种情况下复活：星图没接上（没装配 / 关掉 / 引擎没起）或图还是空的（还没建完），`runSearch` 会退到本地检索，而本地检索的 `pick` **正是**这几个参数。于是同一句尾注

```
k 是本地检索的条数；graph 模式用 limit，这次按 10 条算。
```

在走星图时是对的，在退本地时是假的：那一次结果就是按 `k` 取的，读者却被告知 `k` 没用上——进而把「本地按 k 给了 20 条」读成「星图里只有 10 条」。

### 76.2 为什么 `args` 判断不了

`modeNotes(mode, args)` 只看得到入参。`args.k` 在三种处境的取值一模一样：星图接上了（真没用上）、星图没接上退本地（真用上了）、星图没接上又没 query（谁都没参与）。所以判断依据不能是「模式名 + 入参」，只能是**这一问实际走了哪条路**。

这正是 0.2.65 那条经验的延伸：状态由执行路径回填（`flags`），展示层只负责措辞。区别在于上一轮的回填点是「扩散那次 tryCall 成没成」，这一轮的回填点是「本地兜底跑没跑」：

```js
flags.graphFellBack = true          // 退路一：星图缺席 / 空图，本地检索真的跑了
flags.graphAbsentNoLocal = true     // 退路二：星图缺席又没 query，连兜底都没做
```

### 76.3 三条路，三句话

`k` 与 `LOCAL_ONLY_PARAMS`（`level / project / status / days / content_max / explain`）分别按 flag 选句子：

| flag | `k` | 其余本地条件 |
| --- | --- | --- |
| 都没有（走星图） | `k 是本地检索的条数；graph 模式用 limit，这次按 10 条算。` | `只在本地检索生效；graph 走星图，这次没用上它们` |
| `graphFellBack` | `k 这次真的用上了：…按你给的 k 取的结果——它不是「星图里就这么几条」` | `…退到本地检索，它们真的用上了——但结果不是星图给的` |
| `graphAbsentNoLocal` | `k 这次没参与：星图没接上、又没给 query，这一问压根没算。` | `…这一问压根没算，它们谁都没参与` |

写的时候守两条：**能生效的地方不许说没用上**（否则读者会把降级结果当星图结论）；**没生效的地方不许沉默**（否则读者会把过滤掉的结果当筛过的结果）。

### 76.4 探针与判据

- `AW1–AW9`：星图三态桩 + 本地检索桩。AW1 走星图保住老那句；AW2 退本地必须承认 k / project 用上了；AW3 走星图但给了 project 必须说「只在本地检索生效」；AW4 没给本地条件不许多冒尾注；AW5 没 query 时说「压根没算」；AW6 空图那条退路也要承认；AW7 / AW9 负向（无中生有）；AW8 bridge 给 `min_weight` 是正当用法。
- 判据第 35 条 `graph-fallback-param-note`：三句话 + `LOCAL_ONLY_PARAMS` 表 + 两处 flag 打点（各出现两次）必须都在；变异体只删一句「k 这次真的用上了」，能把它打红。
- 老探针 `AO5` 的断言跟着改：它原来断言「graph 模式必然说 k 没用上」，而探针环境的星图是空的——这条路径现在说真话，老断言反而成了「要求工具撒谎」。

### 76.5 顺手记下的两件事

一，`pick()` 是**静默过滤器**。它按白名单从入参里拿字段，拿不到的就不传——这本身没错，错的是没有人替被丢掉的那几个字段说话。凡是用白名单转发参数的地方，都该同时有一句「这几个这次没跟过去」。

二，**降级路径比主路径更容易骗人**。主路径跑通了，读者至少还能从结果内容反推；降级路径给的是另一种检索的结果，长得跟主路径很像，只有尾注能区分。所以降级路径上打点要更细，不能只写「失败了，退回默认」。

### 76.6 教训 ㊲

> 参数可以按模式分组，回执不能按模式写死：同一个参数在降级路径上会换一条腿走路。写尾注时问的不是「这个模式用不用它」，而是「这一问实际走了哪条路」。

## 77. 第三张表：差集是有方向的（0.2.67）

### 77.1 这一轮骗在哪

0.2.65 说了 `local` 的尾注（扩散读了 `limit` / `hops` 却说没用上），0.2.66 说了 `graph` / `bridge` 的尾注（本地条件在退路里复活）。两轮都围着**两张表**转：本地检索、星图。

`memory_search` 其实有第三张表——`mode: 'similar'`，递到 meow 的 `memory_find_similar`。它的参数面窄得让人放松警惕：只有 `id`（必填）、`k`、`content_max`。macro 侧 `pick(args, ['id', 'k', 'content_max'])`，和 meow 的 schema 一字不差，看起来是「对齐了」。

问题不在递错，在**不递的时候不说话**。同一句调用里，`query` 被丢掉——这一条最致命：读者看到「相似记忆 3 条」，会理解成「按我说的句子找到的 3 条相似」；真相是「和 `id` 那条最像的 3 条」。两种结果的长度、格式、标题完全一样。`level` / `project` / `status` / `days` / `explain` 被丢掉，读者读成「这个项目里相似的只有 3 条」；`hops` / `memory_ids` 被丢掉，读者读成「扩散了两跳、从这几条出发」。

而 `modeNotes` 对 `similar` 只写过一句 `limit`——那是 0.2.65 顺手补的，只覆盖了一个参数。

### 77.2 差集不能照抄

0.2.66 引入了 `LOCAL_ONLY_PARAMS = ['level', 'project', 'status', 'days', 'content_max', 'explain']`，含义是「本地检索认、星图不认」。到了相似检索，最省事的写法是把这张表搬过来当「相似检索不认」的集合。

它错了。**两个差集的方向一样，边界不一样：**

| 参数 | 本地检索 | 星图 | 相似检索 |
| --- | --- | --- | --- |
| `k` | 认 | 不认 | 认 |
| `content_max` | 认 | 不认 | **认** |
| `level` / `project` / `status` / `days` / `explain` | 认 | 不认 | 不认 |
| `limit` | 不认 | 认 | 不认 |
| `query` | 认 | 认（当起点） | 不认 |
| `hops` / `memory_ids` | 不认 | 认 | 不认 |

`content_max` 落在两个差集的重叠区之外——它在 `LOCAL_ONLY_PARAMS` 里（对星图确实没用），但在相似检索里**算数**。照抄的结果是尾注自相矛盾，而且矛盾就在一句话里：

```
content_max 是本地检索的条件；相似检索只认 id / k / content_max，这次没用上它们
```

### 77.3 抓它的是探针，不是读代码

这行字读起来「挺对」——它确实说了相似检索只认三个参数，也确实说了别的条件没用上。人眼扫过去不会停。

`AX7` 停下来了。它的断言是「全参数时四句尾注齐 **且** 递给 meow 的键正好是 `content_max,id,k`」。第一次跑：`尾注四句=3/4`。这个 3/4 不是文案问题——它说明我对「相似检索认哪些参数」的理解和代码实际行为对不上。于是去翻 meow 的 schema（`vendor/meow-memory/lib/index.js:2691-2701`），确认 `content_max` 是认的，回来把集合算对：

```js
const similarIgnored = LOCAL_ONLY_PARAMS.filter((n) => n !== 'content_max' && args[n] !== undefined)
```

修完四句齐，`AX7` 绿。**探针的价值不是「跑一遍都绿」，而是它把「哪一句在什么输入下出现」写成了可执行的断言**——文案自相矛盾在这种断言下活不过一轮。

### 77.4 四句话，四段身份

`modeNotes` 的 `similar` 分支按「参数在相似检索里的身份」分句，而不是按「参数属于哪个模式」：

| 输入 | 尾注 |
| --- | --- |
| `query` 有值 | `query 在相似模式没用上：这一问是拿 id 指向的那条记忆去比，不是按你说的句子找——想按句子找请用 local（默认）` |
| 其余本地条件（去掉 `content_max`） | `… 是本地检索的条件；相似检索只认 id / k / content_max，这次没用上它们——这不是「没有相似」，是这几个条件压根没算` |
| `hops` | `hops 是 graph / bridge 的扩散跳数；相似检索不扩散，这次没用上` |
| `memory_ids` | `memory_ids 是 graph / bridge 的起点；相似检索只看 id 指向的那一条，这次没用上` |

第二句的尾巴是这一轮真正要立的规矩：**「没有相似」和「条件没算」必须分开说。** 前者是结论，后者是边界；混成一句，读者就会带着一个没被应用的条件去相信一个看起来很像结论的结果。这和 0.2.65 的「没有东西可扩散」、0.2.66 的「退到本地检索」是同一条线的第三次——每一次都是「结果为空 / 结果照旧」和「条件没生效」长得一样。

### 77.5 验法

- 探针 `AX1–AX10`：`memory_find_similar` 换成桩（`call` / `tryCall` 都记 args），四句各一条正向；`AX6`（只给 `id` / `k`）与 `AX8`（local 模式）是负向，专防「无中生有」；`AX7` 正向四句 + 递参键集合；`AX10` 专钉 `content_max` 不许误报；`AX9` 缺 `id` 必须报错。
- 判据第 36 条 `similar-mode-param-note`：源码里四句 + `similarIgnored` 那行同时在场才算绿；自测变异体只删 `query 在相似模式没用上`，判据必须红。
- 版本、文档、doctor 的 `PATCHES` 表一起走到 0.2.67。

### 77.6 教训 ㊳

**参数清单可以复用，差集不能复用。** 「A 认、B 不认」这种话是有方向的：换一个对照物（这里是「相似检索」而不是「星图」），重叠区就变了。把上一轮的差集直接搬过来，省下的是十行代码，付出的是一句自相矛盾的尾注——而且它读起来很顺，只有探针会停下来。

## 78. 参数归属：不读它，也要说它在谁手里（0.2.68）

### 78.1 同一个 schema，八种执行

`memory_admin` 是「一个工具八张面板」，schema 必须把所有面板的参数放在一起，因为 `additionalProperties: false`——不列出来就传不进去。可执行时每张面板只读自己那一列：

```js
const spec = ACTIONS[action]
if (spec.kind === 'call') return wrap(spec, { body: (await flow.call(spec.call, pick(args, spec.params), exec)).text })
if (spec.kind === 'graph') { spec.guard?.(args); ... pick(args, spec.params) ... }
```

`pick()` 是个正确的工具，但它只回答「传什么下去」，不回答「用户给的那几个去哪了」。于是「合法但无人读」的参数既不报错、也不留痕——这是本轮之前所有「静默丢弃」缺陷里最安静的一种：schema 越统一，沉默的面越大。

### 78.2 归属要算，不要抄

第二张表（「这个参数归谁」）如果手写，就又造出一个能和动作表漂开的地方——那正是 0.2.22 把枚举改成由表生成的原因。所以 `PARAM_OWNERS` 是从 `ACTIONS` 反算的：

```js
for (const [action, spec] of Object.entries(ACTIONS))
  for (const name of spec.params ?? []) map.get(name)?.push(action) ?? map.set(name, [action])
```

（真实实现用 `if (!map.has(name))` 显式建桶，这里只是示意。）一句话：**清单可以有第二份，出处不能有第二个。**

### 78.3 「没用上」这句话的三段式

单说「kind 这次没用上」不够——用户会问「那我该去哪给」。所以 `strayNote()` 的每一句都是三段：**点名 → 归属 → 态度**。

| 段 | 例子 | 少了它会怎样 |
| --- | --- | --- |
| 点名 | `kind` | 用户不知道是哪个参数没生效 |
| 归属 | `kind 是 hygiene 的` | 用户不知道正确的问法是 `action='hygiene', kind='dup'` |
| 态度 | `cost 不读它，这次一点没参与（别读成「结果已经按它收窄过」）` | 「没用上」会被读成「筛过了但没有匹配」——和 0.2.39 / 0.2.46 / 0.2.67 是同一族 |

### 78.4 例外只免形式，不免说话

`guide` 不加抬头是 0.2.25 就定下的唯一豁免（手册第一行必须是门牌，不然读者不知道这是什么）。但豁免的是**抬头**这个形式，不是「必须诚实」这条义务：`action='guide', limit=5` 以前一声不吭。现在 `wrap()` 对 `wrap:false` 也认 note，补在正文末尾。

判断标准可以写成一句话：**豁免只对「怎么排版」有效，不对「要不要说话」有效。** 任何一处「格式例外」都不该顺带变成「沉默例外」。

### 78.5 验法

- 探针 `AY1–AY9`（`tools/probe-fusion.mjs`）：正向七条 + 负向两条；`AY7` 专钉多参数时用「它们」且两句都点名；`AY5` 钉手册末尾；`AY9` 钉「尾注不许另起一行」。
- 判据第 37 条 `panel-param-owner-note`：源码必须有 `strayNote` / `PARAM_OWNERS` / 归属拼接 / 态度句 / 三条分发带 note / 手册兜底；变异体只删「一点没参与」即可打红。
- 这一轮踩到的坑：`AY9` 第一版用「两次调用的行数相同」当断言，红了——成本账本每调用一次就记一行，被比较的两个量本身在变。改成看结构（那句贴在抬头行、第二行起是正文）。

### 78.6 教训 ㊴

**「silently ignored」和「filtered to zero」在输出上长得一模一样。** 用户看到一份完整账本，无法区分「没有符合 kind 的调用」和「kind 根本没被读」。所以参数一旦合法就必须有回执：不是所有参数都能生效，但**所有参数都必须有下落**。这也是这三轮（0.2.66 / 0.2.67 / 0.2.68）其实是同一件事的原因——第三十一次同样的缺陷，换了一张表。

## 79. 参数是一张表，用途却是分片的（0.2.69）

### 79.1 现象

`memory_search` 有十五个参数，`mode` 有四种。参数表是一张，用途却分片：`k` 属本地、`limit`/`hops` 属星图、`chars`/`min_weight` 属 bridge、`id` 属 similar、`memory_ids` 属扩散。塞错片区的参数**不报错**，只是没参与。

### 79.2 这一轮补的两个口子

- `id`：只有 `mode=similar` 拿它当基准。写在 local / graph / bridge 里被丢掉，读者会把「按 query 检出来的结果」当成「以这条记忆为基准比出来的相似条目」，或者反过来以为「这条记忆被排除了」。
- `memory_ids`：只有扩散那一次才读。local 命中一条、没给 `expand` 时它完全没参与，读者却以为结果是从这几个 id 起跳的邻域。

### 79.3 措辞上的一条硬规矩：否定句

`X 这次没用上` 单独出现时是有歧义的：可能是「没读它」，也可能是「读了但没撞上」。所以每一句都得带**否定式澄清**——

- `id` → `这次没用上它——这不是「这条记忆被排除了」`
- `memory_ids` → `它没参与这次结果` / `这次没有扩散，它没用上`
- 相似模式（0.2.67）→ `这不是「没有相似」，是这几个条件压根没算`

这三句是同一个动作：**把「没做什么」和「做了什么但结果为空」分开**。0.2.39 起就在做这件事，只是每换一张表就要重做一遍。

### 79.4 三种处境的表

`memory_ids` 在同一次调用里有三种处境，尾注必须跟着**执行路径**走（0.2.65 的教训 ㊱）：

| 处境 | 判定 | 尾注态度 |
| --- | --- | --- |
| 真扩散了 | `flags.spread === true` | 这次真的用上了（并说明从你这几个 id 起跳） |
| 本要扩散、星图没接上 | `flags.spreadTried === true && !spread` | 它没参与这次结果 |
| 压根没扩散 | 两者皆假 | 这次没有扩散，它没用上 |

这正是 0.2.65 给 `limit` / `hops` 写的那张三态表，搬到 `memory_ids` 上原样成立——因为它们是同一个开关的三个出口。

### 79.5 验法

- 探针 `AZ1–AZ8`：三种处境各一条；`id` 在 local / graph 各一条（graph 那条还要验括号里写的是 graph）；`AZ3` 验「说的和做的一致」（尾注说用上了，就必须真把 `memory_ids` 递下去）；三条负向（graph 的 `memory_ids`、similar 的 `id`、只给 `query`）。
- 判据第 38 条 `search-id-memoryids-note`：两句措辞 + 否定句 + 两道 mode 闸同时在场才绿。
- 阴性对照三刀：把 `if (mode !== 'similar' ...)` 那道闸去掉 → similar 模式乱冒；把 `memory_ids` 那句删掉 → 沉默回潮；把三态压成一句 → `AZ1` / `AZ2` 必红。

### 79.6 教训 ㊶

**参数可以合法，但不能没有下落。** 合法的另一面不是「随便塞」，而是「塞哪儿都得有个回执」。判断标准极简：**同一张参数表被几条不同的执行路径读，就要有几套尾注**；一套尾注套所有路径，必然有一条在说反话。

这也是这四轮（0.2.66 / 0.2.67 / 0.2.68 / 0.2.69）其实是同一件事的第四次：第三十二次同款缺陷，换了一张表、换了一个方向。

## 80. 卡片是回执的第二种排版（0.2.70）

### 80.1 现象

`memory_admin` 的 `presentCall` 返回卡片标题，只有一行、40 字预算。它以前有两种写法：

```js
cardTitle(panelBrand, spec.label)   // 前缀塞品牌
```

细节位永远空着。于是三次不同的调用（`hygiene` / `hygiene kind=dup` / `hygiene kind=dup limit=5`）在会话里长得一模一样。**正文说清了，卡片没说**——可卡片是唯一不用点开就能看见的那层。

### 80.2 为什么算同一类缺陷

前面三十三次修的都是「参数进去了、结果出来了、回执却不说」。这一轮的位置换到卡片：

| 层 | 谁在读 | 前面几轮 | 这一轮 |
| --- | --- | --- | --- |
| 面板正文 | 点开的人 | 0.2.65–0.2.69 | — |
| 面板抬头 | 扫一眼的人 | 0.2.68（尾注贴抬头） | — |
| 卡片标题 | 会话列表里并排看的人 | — | 0.2.70 |

同一个坑，三种排版。**排版越多，「说话」这件事就要在每个排版上各做一遍。**

### 80.3 三条规则

1. 前缀只放面板中文名，品牌归面板抬头（`【宏记忆｜…】`）。0.2.60 写的是「`prefix` 是中文名」，这条老口径在卡片上被破了整整十轮。
2. 细节位放这一轮真给了的参数（`cardDetail(args)` 产 `k=v`），顺序按 `PARAM_OWNERS` 反查表——不另写一份参数表。
3. 没给的不进卡片；数组说条数；对象 `JSON.stringify`；未知 action 带上原值。

### 80.4 为什么不搬 vendor 的中文标签

「好看」和「不撒谎」在这件事上是对立的：抄 `HYGIENE_META` 会让 macro 依赖 vendor 内部常量（星图缺席 → load 失败），也造出第二份真值源（星图加 kind → 这边悄悄少中文名）。选 `k=v` 原值是**永不失配**：参数名本身就是最准的名字。

这是 0.2.66 那条「降级路径不许依赖被降级方」的同一个判断，只是这次降级的对象是「文案好看」。

### 80.5 验法

- 探针 `BA1–BA8`：三条规则各一条，外加「键序」「截断」「八个工具都不含品牌」。
- 判据第 39 条 `admin-card-detail`：五个锚 + 一条**否定锚**（`!includes('cardTitle(panelBrand')`）。否定锚在这类「换回来就算错」的改法里是必须的——只验新写法在场，旧写法回来也能全绿。
- 阴性对照：把 `presentCall` 换回 `cardTitle(panelBrand, spec.label)` → 探针 `BA1`/`BA8` 与判据同时红。

### 80.6 教训 ㊸

**一个输出有几种排版，就有几个撒谎的机会。** 正文、抬头、卡片是三张脸；修完正文不等于修完回执。反过来说，做尾注这类东西时要**先问它会长在哪儿**——长在正文里的尾注要贴抬头才不新增行（0.2.68），长在卡片里的一行字则要**先腾出细节位**（这一轮）。

顺带一条小的：`40` 字的预算**不是**留给品牌的。任何「前缀」都要先问它凭什么占这个位置。

## 81. 「默认值」和「上限」不是一回事（0.2.71）

### 81.1 缺陷的形状

星图概况的枢纽列表：`schema` 说上限 40，`numParam` 也照 min/max 校验，可它下游那一步写死 12：

```js
const top = this.graph.nodes
  .slice()
  .sort(...)
  .slice(0, 12)            // ← 参数在这一步之后就没意义了
  .map(...)
```

工具里又补了一刀 `o.hubs.slice(0, pHubs.value)`。于是 `hubs: 40` 与 `hubs: 13` 输出完全一样，`hubs: 10` 与不传也一样——**参数在三个值之间完全失去分辨力，而回执没有任何一句话承认这件事**。这是第 34 次同一个形状：参数合法、schema 齐全、校验也做了，就是没有下落。

### 81.2 一个差点写错的判据

第一版判据里我写了：

```js
!nebCoreSrc.includes('.slice(0, 12)')
```

用意是「枢纽列表不许再被钉死在 12」。它当场把这一轮判红——因为同一个文件里还有两处 `slice(0, 12)`，都是正当的（「被谁提到」的 top 列表、另一处详情摘要）。**全局否定式断言把「这一处的错」写成了「这些字不许存在」**：文件里只要有一处合法的同名调用，判据就是错的，而且它错得很难查——它红，但缺陷已经修好了。

改成两句话：

```js
nebCoreSrc.includes('.slice(0, hubSlots(opts.hubs))') &&
nebCoreSrc.split('hubSlots(opts.hubs)').length - 1 === 1
```

第一句钉住「枢纽列表按参数取」，第二句钉住「只有一个地方这么说」（防止旁边再长出一份平行实现）。**教训 ㊹：否定式断言要先确认这串字在别处是否合法存在；存在就用「定位 + 计数」代替「全局否定」。** 这和 ㉕（注释也算判据文本）、㊳（差集有方向）是同一族毛病：判据要盯着**这一处**，而不是盯着**整个文件**。

### 81.3 上限的唯一出处

```js
export function hubSlots(value, def = 12) {
  const n = Math.trunc(Number(value))
  if (!Number.isFinite(n) || n <= 0) return def
  return Math.min(40, n)
}
```

放在 `Nebula` 类之前导出，概览与异步概览共用它。**上限只在这一个函数里出现一次**——40 这个数字散在两个文件里，迟早会有一处先改。

### 81.4 三个调用者为什么不用动

`http.js`、`share.js`、`web/app.js` 都是 `overview({ hygiene: ... })`，不传 `hubs`。`hubSlots(undefined)` 回默认 12，版面与以前逐字一样。**修「参数不生效」不该顺手改「别人看到的默认」**：前者是 bug，后者是设计。

### 81.5 真跑，而不是读字符串

`hubSlots` 是纯函数，`verify.mjs` 里直接 `await import(...)` 跑五组值。判据能证明「字还在」，只有真跑能证明「算得对」——这也是本仓一贯的分工：判据守形状，探针守行为。

### 81.6 教训

- 参数校验齐全 ≠ 参数有用；`min/max/def` 只管「值合不合法」，管不了「值有没有被用」。
- 默认值属于**别人看到的界面**，上限属于**这一处实现**；两者写在一起时，先分清改哪个才算修 bug。
- 列表被截断而正文不说，是把「我列了前 N 条」读成「一共就 N 条」的最短路径——凡是 `slice`，旁边就得有一句「还有多少」。

## 82. 「没结果」的颗粒度就是排障的颗粒度（0.2.72）

### 82.1 一句话

同一个「没有结果」，如果两种成因共用一个句子，那句话就必然有一步是错的。

### 82.2 这一轮的病

`lib/macro/defs/admin.js` 的 `graphPanel` 原来只有两条路：

```js
const r = await flow.tryCall(name, payload, exec, what)
if (r.entry) return r.text
return `星图这次没接上，${miss}——等星图就绪再试一次就行。`
```

`tryCall` 兜住的错误至少有两类：`bridge.call` 等不到工具时抛的 `宏记忆：这项能力还没就绪（…）`，以及工具**真跑起来**以后抛的任何错误。两类都被压成同一句「这次没接上」，末尾还追加了一个下一步：「等就绪」。

实测两种情形的输出（`tools/_miss72.mjs`，`missing` 集合让 `awaitTool` 回 `undefined`，`thrower` 里配 `ENOENT: 读不到 nebula.db`）：

```
① 星图没装           → 星图这次没接上，星图概况这会儿看不了——等星图就绪再试一次就行。
② 星图报 ENOENT      → 星图这次没接上，星图概况这会儿看不了——等星图就绪再试一次就行。
```

一字不差。第 ② 种里那个 `ENOENT` 是唯一能让人动手修的信息，被吃掉了。

### 82.3 修法

```js
if (said.includes(NOT_READY_MARK)) return `星图这次没接上：${what}要的那个能力还没装配好（…）——${miss}，…`
const pre = `${what}未完成：`
const reason = said.startsWith(pre) ? said.slice(pre.length) : said
return `星图这次答不上来（${what}）：${reason}——${miss}，…重试之前先看这条错误：它是星图那边出的。`
```

三条约束，缺一条就退回去：

1. **判据只认一个常量**：`NOT_READY_MARK` 从 `contract.js` 引进来，面板里不许再出现它的字面量。抄第二份 = 两份都能改、迟早只改一份。
2. **原因原样带出**：`bridge` 那边把原因包成 `${who}未完成：${err}`，面板负责把这层包装剥掉——剥的是包装，不是内容。
3. **下一步必须对得上成因**：装配问题 → 装/开配置；执行问题 → 读错误本身。「等一等」只在「真的是慢」时才成立。

### 82.4 为什么不能合成一句「星图出问题了，请检查」

「检查」不指向任何东西。一句话里如果没有**只有这一种成因才会出现的细节**，它就不是信息，是噪音。这里那个细节是 `ENOENT: 读不到 nebula.db`——它同时告诉人「星图在」「是文件读不出」「去修那个文件」。

### 82.5 教训 ㊺

> 一个函数里如果有两条失败分支，把它们写成一个返回值，等于把「下一步」这一列抹成常数。
> 抹掉的那一列，恰恰是排障时唯一有用的东西。

同族的第 35 次（护栏 → 尾注 → 卡片 → 枢纽条数 → 这一次），每次换一层：这次的层是**错误分类**。

### 82.6 怎么钉住的

- 判据 41 `graph-miss-split`：`NOT_READY_MARK` 的唯一出处、`星图这次答不上来（${what}）` 的包装、`const reason = said.startsWith(pre) ? … : said` 这一行、`等星图就绪` 不许回来。
- 探针 CA1–CA6：六条，其中 CA6 专门盯「正常路径一个字都不加」——降级话术最容易顺手粘到成功路径上。
- 阴性对照三刀：① 分支判断改成 `false` → CA1/CA2 红；② 把 `reason` 换成固定串 → CA3 红；③ 把两句合并回旧话术 → 判据与 CA2 同时红。

## 83. 判据自己也得被验（0.2.73）

### 83.1 一个「全绿」是多少个判断的乘积

这套仓库的验收是 12 支脚本、1461 条断言。1461 条全绿说明什么？说明**这 1461 条断言各自都跑了、都没红**。它不说明第 1462 条——也就是「断言自己会不会算错」——是绿的。

`doctor.mjs` 里那 22 处 `line(<cond> ? 'PASS' : 'FAIL', true, …)` 就是第 1462 条：条件算对了，`FAIL` 也打出来了，只是没人把它算进结论。于是「一条红」在出口处被读成「零条红」，而下游（`check-all`）只看出口。整条链上没有任何一环「撒谎」——每一环都在忠实执行自己那句代码。

### 83.2 判决必须只有一个出处，而且那个出处要被测到

所以本轮做的不是「改 22 处调用」，是**把判决收成一处**：

- 判决规则 → `tools/doctor-verdict.mjs` 的 `makeVerdict()`，规则只有一句：`const failed = tag === 'FAIL' || (tag === 'PASS' && !ok)`。
- 判定 → `tag` 说了算。调用方写 `line(cond ? 'PASS' : 'FAIL', true, …)` 也好、`fail()` 也好，只要打了 `FAIL` 就算失败。
- 记账与出口 → `verdict.fails / verdict.warns`，结论句和 `process.exit` 都读它。

为什么要单独一个文件：`doctor.mjs` 顶层就 `readFileSync`、结尾就 `process.exit`，import 它就等于跑一遍体检。判决器抽出来才能被 verify 真 import、真喂值、真看账。**能被测到的判决，才配当判决。**

### 83.3 「tag 决定判决」而不是「第二参决定判决」

第二参 `ok` 的语义本来是「这一条过了没有」，可它和 tag 是同一个事实的两次表达。两次表达就有两个真相，写反一个就漏一条。现在留 tag 一个：它是要打到屏幕上的字，读者看的就是它——**屏幕上写 FAIL，账上就必须是失败**，两者不许分开。

保留 `ok` 参数是为了 46 处调用一行不改（0.2.26 那次拆 `bridge.js` 也是同样的取舍：转出不拆调用方）。但 `ok` 只剩两个用处：`PASS + false` 视为失败（声明通过却说没过），以及 `WARN` 之外的 `!ok` 记警告。

### 83.4 教训 ㊻：判据自己也得被验

前四十五次教训全在讲「输出要对读者说实话」。这一次是同一个病换了个位置：**输出对了，出口没说**。断言打红不等于验收失败——中间隔着一次计数。凡是「N 条全绿」这种聚合结论，都得有一条断言去问：红的那条真的被数进去了吗？

自检的口径：把判决规则改回旧写法（`if (!ok)`），或删掉 `tag === 'FAIL' ||`，探针/verify 必须当场打红。改不红，说明这条断言只是在复述实现。

### 83.5 遗留

`check-all.mjs` 读 doctor 的方式仍是「exit code + PASS 行计数」。exit code 现在可信了（这是本轮修的），但「计数」只说明跑了多少条、不说明红了几条——如果将来再加一支只打行不计账的脚本，同一个坑会换个门进来。已记进待办。

## 84. 一个列表，两处截断，三本账（0.2.74）

### 84.1 读者的算术

体检面板的每一段长这样：

```
孤立（100，这里只列前 40 条）
- …（6 行）
  …还有 94 条
```

抬头、正文、尾注各给了读者一个数字。读者会做三件自然的事：

1. 数正文 → 6 条。和抬头的「40」对不上。
2. 按尾注推 → 「看到 6 条，还差 94 条，共 100 条」。这步是对的。
3. 按抬头推 → 「前 40 条都在这儿」。这步是错的，而且会让人以为 `limit` 压根没生效。

只要一个数字对不上，读者对整段的不信任就会扩散到「那计数是不是也不准」。**面板的可信度是按最弱那个数字算的。**

### 84.2 为什么会长出三本账

因为截断真有两道闸，而老代码把两道闸分别报了一遍：

- 引擎侧 `HY_MAX = 40`：每类只把前 40 条塞进 payload（payload 有上限）。这是**内部实现约束**。
- 参数 `limit`（默认 6、上限 20）：用户要几条。这是**用户意图**。

抬头那句 `arr.length` 报的是第一道闸，正文行数由第二道闸决定，尾注 `n - limit` 又算了一遍第二道闸。读者只关心一件事：**你给我看了几条、还剩几条**。第一道闸不属于回答范围——它是「为什么我调到 40 也看不到 100」的答案，而那句话该由尾注来说（「每类最多列 N 条」）。

### 84.3 收敛成一个出口

`listTail(n, printed, limit)`：

- `printed = Math.min(limit, arr.length)` —— 正文实际列了多少，是真值，不是任何一种内部账。
- 抬头只剩 `（${n}）`，一个数字，真总数。
- 尾注 `n - printed`，与正文可加；并把 `limit` 说出来。
- `n ≤ printed` 时返回空串 —— 没截断就一个字都不多说。

这和 0.2.71 的 `hubSlots()`、0.2.62 的 `countParam()`、0.2.63 的 `guideBudget()` 是同一条路子：**凡是被改过的条件、被截断的列表，都必须有一个唯一的出口负责把它说清**。散在调用点的算术迟早会漂——这次漂的方式是「两个截断点各自报了名」。

### 84.4 教训 ㊼：同一次截断只许报一次，而且按「读者能数到的数」报

凡是输出里出现两个以上关于「条数」的数字，就必须能互相验算：抬头总数 = 正文行数 + 尾注剩余。做不到，就说明其中至少一个数字来自实现细节，而不是来自读者看得见的东西。**内部账不能上屏。**

配套的探针要求：要验这条，必须真的把某一类撑过引擎那道闸（45 条孤立记忆），否则 `arr.length === n`，两本账恰好相等，缺陷隐身。造数据时还得注意 `memory_remember` 的去重（相似度 ≥80% 合并），模板化的假数据会长不出节点——当时 45 次写入只多出 1 个。

### 84.5 怎么验的

- 判据第 42 条 `hygiene-count-ledger`：`listTail` 存在且被调用、`printed` 取两闸的较小者、老的 `这里只列前 ${arr.length} 条` 与 `if (n > limit) lines.push` 都不许回来。
- verify A74 八条：真 import `listTail`，喂 `(100,6,6) / (41,6,6) / (100,40,20)` 与三个「没截断」的组合。
- `tools/probe-graph.mjs` HD0–HD5：真引擎、真 45 条孤立记忆、真工具面 `memory_admin{action:'hygiene',kind:'orphan',limit:6}`，断言抬头 > 40 且不带「只列前」、正文 6 行、尾注 = 抬头 − 6、`limit` 调到 20 时正文 20 行且尾注同步。

## 85. 尾注的三本账：读者数得到的才算数（0.2.75）

### 85.1 一个「还剩多少」背后的三联式

一条截断的列表，读者能验算的等式只有一条：

```
总数 = 列出来的 + 没列出来的
```

只要这三个数里有一个不是「读者看得见的东西」，等式就只是个样子：`还有 2988 条没列` 里的 2988 不是「没列出来的枢纽数」，是「全图节点数 − 列出来的行数」，把两群完全不相干的记忆混在了一起。于是上下文里还得多长出一句「没列的不代表不是枢纽」——一句纯粹用来给前一个数字打补丁的话。补丁出现的地方，就是账算错的地方。

### 85.2 为什么是「有连接的记忆数」

枢纽的候选池是「在图里接了边的记忆」，不是「图里所有记忆」。`stats` 早就给了 `nodes` 与 `orphans`（`graph.js` 里 `const orphans = nodes.filter((node) => !degree.has(node.i)).length`），两者一减就是候选池，不用为了这句话再扫一遍图。这也解释了为什么旧写法错得那么自然：节点总数是最容易拿到的数，而它恰好是错的那个数。

### 85.3 一个数字三处抄，跟「两本账」是同一个病

「40」曾经同时出现在：

- `vendor/dsh-memory-nebula/lib/host/nebula.js`：`return Math.min(40, n)`
- `vendor/dsh-memory-nebula/lib/index.js`：`numParam('hubs', args.hubs, { min: 1, max: 40, def: 10 })`
- 正文的「（本次 N 条，上限 40）」以及 schema 描述里的「上限 40」

这与 0.2.74 的 `listTail()`、0.2.71 的 `hubSlots()`、0.2.62 的 `countParam()` 是同一条路子：**先让这个数只有一个出处，再让所有句子读它**。现在它是 `export const HUB_CAP = 40`，schema 描述也走模板串插值。宏记忆面板（`lib/macro/defs/admin.js`）保持自己的字面量——那一层是面向模型的工具说明，不该反向依赖星图引擎的内部常量。

### 85.4 教训 ㊽

> 尾注里的数字必须是读者能自己验算的那个数；不能验算的数字，一律不许出现在「还剩多少」这句话里。

配套两条：

1. 说不通就补一句安抚话，等于承认这句话是假的——发现自己在写「没列的不代表 X」，先回去看数字。
2. 探针要能造出「截断」这件事。`probe-graph` 前期图里只有两三个节点、且彼此都孤立，`hubs=1` 时池子还不够列，尾注正确地不出现——所以要验正例，得先写入几条带 `links` 的记忆把池子撑起来（HB 段就是这么做的：4 条边被牵出来后，`nodes − orphans = 7`，尾注说「全图 7 条…只取前 1 条」）。

### 85.5 怎么验的

`verify.mjs` A75 七条（静态锚 + 真 `import hubTail` 五种输入 + 判据 42 条仍全绿 + 探针锚点 + 版本 + 文档）；`tools/probe-graph.mjs` GB1–GB5（不截断时不出现尾注）与 HB0–HB6（真图牵边 → 尾注 = `nodes − orphans`、正文 1 行、不许出现「还有 N 条没列」）；判据 `stats-hubs-cap` 从「上限单一出处」收紧为「单一出处 + 旧假账与旧圆场话都不许回来」；阴性对照三刀分别打池子、打 `HUB_CAP`、打 schema。

## 86. 成本账本的三个数：报「算了几条」，不是「要了几条」（0.2.76）

### 86.1 一句话

抬头写的是请求参数（`limit`），正文写的是实际条数（`entries.length`）——两个数从头到尾没人对账。

### 86.2 为什么这句话最危险

成本面板的数字会被拿去做决定：

- 「最近 200 次调用合计 120 万 token」→ 读者默认这就是全部开销。
- 账本只有 5 条时，这句话仍然写 200 次，读者会以为「还有 195 次没看到」而去别处找。
- 账本 250 条时，更早的 50 条被 `slice(-200)` 悄悄切掉，合计偏小而抬头不改。
- `readJsonlDetail()` 丢掉坏行是有意的（不能因为一行烂掉就整本不算），但丢掉多少必须说出来。

三个数（要的 / 算的 / 账本里的）只说一个，剩下两个就会被读者自己编。

### 86.3 收成一个出口

`costScope(asked, counted, good, bad)`：

1. 四个入参各自 `Math.max(0, Math.trunc(Number(x) || 0))` 归一——参数脏了也不会漏出 NaN。
2. 基句只报「统计最近 N 次调用」，N 是**真算了的条数**，不是你要的条数。
3. 要的比算的多 → 补「你要的是 X 次，账本里能算的只有 N 条」。
4. 账本比算的多 → 补「更早的 K 条没进这次统计」（K = 账本 − 算的）。
5. 有坏行 → 补「另有 B 行解析不出来，一行都没算进去」。

和 0.2.71 的 `hubSlots()`、0.2.74 的 `listTail()`、0.2.75 的 `hubTail()` 是同一条路：同一次截断只许有一个出口，别的层只许引用它。

### 86.4 教训 ㊾

**别把请求参数当事实报给读者。**

「最近 200 次」里的 200 是意图，「账本里有 5 条」才是事实。面板可以受参数控制，但报数时必须以事实为主语；意图和事实不一致时，两个都写。

推论：只要一个数字出现在两处（抬头 + 正文），它们就必须来自同一个函数——否则版本一涨就会有一处忘改。

### 86.5 怎么验的

- A76 块逐字比对 `costScope()` 的四种输出，并断言 `defs/admin.js` 里不再有「最近 ${lim.value} 次调用」这个字面量。
- CB1–CB7 在临时 `DSH_HOME` 里造真账本（10/20 字符的记账行、可算准的入参字符数），走真面板出口验证，而不是只测纯函数。
- 判据 43 `cost-scope-count`：三个数的词句必须全在 `cost.js`，面板侧只许出现 `c.scope`。


## 87. 沉默不是答案：三种「没拿到」要说三种话（0.2.77）

### 87.1 一行三元表达式能吞掉多少信息

```js
const base = section ? `${said}\n\n${section}` : said
```

这一行看起来只是「有就拼、没有就算了」。可 `section` 是 `neighborSection(inspect.text)` 的结果，
而 `inspect.text` 在四种情况下都不是空的：星图报错时它是 `星图邻居未完成：…`；星图说没有这条记忆时
它是一整句「这不等于记忆没了」；格式变了时它是别的内容；只有真正查成且没有邻居时，它才有那一节
（内容是 `（0/0）`）。四种情况被 `neighborSection` 压成同一个 `''`，再被这一行压成「什么都没有」。

读者看到的不是「没查到」，是「没有」。这两个字在记忆系统里是**结论**，不是状态：结论会让人删记录、
放弃连线、或者相信一条孤立的记忆真的孤立。

### 87.2 三种状态，三句话

| 状态 | 读者该做什么 | 这句话 |
| --- | --- | --- |
| 这一问没查成 | 重试 / 查星图装配 | 星图这次没答上来（这一问没查成）… |
| 查成了，没这条记忆 | 确认 id，或等入图（12s 一轮） | 星图这次没查到这条记忆… |
| 查成了，回执没那一节 | 报格式问题（星图改了） | 星图的回执里没有「连接到的记忆」这一段… |
| 查成了，就是没邻居 | 不用管，继续写 | （只有 `（0/0）` 那一段，不补话） |

第四种**不加话**是刻意的：真没有邻居时补一句「可能没有邻居」，纯属噪音，而且会让第三种状态失去区分度。

### 87.3 为什么不把星图原文贴出来

`tryCall` 失败时返回的是 `星图邻居未完成：ENOENT…` 这种内部话术，直接贴给模型，模型会拿它当结论
（0.2.52 那次「空字符串被读成这条记忆是空的」是同一类病）。所以 `neighborGapNote` 只拿 `raw`
判一句「是不是没这条记忆」，其余一律用自己的话说。

### 87.4 教训 ㊿

**沉默不是答案。** 一条链路有三种「没拿到」，读者只会读出第四种「没有」，而第四种恰好是唯一不需要
他做任何事的那种。凡是「有就拿、没有就算了」的拼接，都要先问一句：没有的时候，读者会不会把
「没查到」当成「不存在」？

### 87.5 怎么验的

`neighborGapNote` 是纯函数，四种输入四种输出逐字比对（A77 块）；真面板那一侧用探针 CC1–CC6 走
`createUnifiedTools` 造六种星图：整块缺席、回执没那一节、正常、`neighbors: 0`、参数脏、
说没这条记忆。CC4 另外数了调用次数——`neighbors: 0` 不该去问星图。判据第 44 条钉住源码，
自测里把 `gap` 换成空串会立刻变红。

## 88. 静默 continue 比报错更贵：丢弃也要留账（0.2.78）

### 88.1 一行 `continue` 能吞掉多少信息

```js
const list = Array.isArray(links) ? links : []
for (const item of list) {
  if (typeof item === 'string' && item.trim()) { out.push(...); continue }
  if (item && typeof item.id === 'string' && item.id.trim()) { out.push(...); continue }
  // 掉到这里＝没了。没有计数、没有原因、没有回执。
}
```

这段代码「不会崩」——正因为不崩，缺陷活了很久：模型调用 `memory_write` 带 4 条 links，其中 3 条形状不对，面板说「关联已排队 1 条」。**1 条是真的，读者读成 4 条也是真的**。错误不在数字，在于少了「另外 3 条没了」这半句。

同族缺陷：`applyLinks` 开头 `if (items.length === 0 || !anchorId) return ''`。两个条件挤在一个 return 里，就把「没给 links」（正常，不该说话）和「给了 links 但不知道锚点」（异常，必须说话）合并成同一件事——这跟 0.2.77 那个 `section ? … : said` 是同一个毛病：**把不同状态塞进同一个空值**。

### 88.2 拆法：先分类，再措辞

`linkArgs()` 只做分类（`items` + `drop` 三个计数），`linkDropNote()` 只做措辞（计数 → 句子）。两个函数都可以单测，不用起面板；`applyLinks()` 里只剩「什么时候把这句话拼上去」。这是本仓库反复用的分法：**判断与表达分开，判断可测、表达可逐字钉**。

### 88.3 `{id:'  '}` 算空 id 还是形状不对

一开始我把它算进 `wrongShape`，verify 立刻红——不是断言写错，是分类错了：它有 `id` 字段、只是空的，跟「空串」是同一类错，读者要做的补救动作也一样（补个真 id）。所以 `typeof item.id === 'string'` 单独一支，trim 后为空就记 `blank`。**分类要按「读者接下来该做什么」分，不按代码形状分。**

### 88.4 教训 51

**丢弃不报账，等于谎报成功。** 只要代码里出现「这里筛掉一些、剩下的照做」，就必须同时产出「筛掉几条、为什么」——否则上层那句「已连上 N 条」在读者眼里就是「全部连上了」。

### 88.5 怎么验的

探针 CD1–CD5 从真面板入口打五种输入（含「上游没给 id」那条最隐蔽的路径，靠 stub 只返 `{ text }` 触发）；判据 45 条里第 45 条专治回退；verify A78 逐字钉四句话。阴性对照三刀（分类判据改 `false`、`anchorMissing` 传死 `false`、join 里漏掉 `gap` 位）分别打红 verify 与 probe，基线不红才收工。

## 89. 「不支持写入」是一种谎：宿主不认 Config 就没有设置页（0.2.79）

### 89.1 症状与归因

设置页显示「当前连接不支持设置写入（仅本机回环连接可编辑）」。按字面理解是权限/连接问题，于是我很自然地去查有没有 `settingsScope` 服务、有没有只读决策——查了一圈，**宿主根本不存在这个服务**，而 `dsh-settings` 里 `get writable() { return true }`，恒为可写。那句话是 meow 旧前端在 `snap.mode === 'memory'` 时自己写的，而我们的镜像快照字段只有 `{status, value, base, user, revision, writable}`——**`mode` 压根不存在**，所以这个分支永远进不去，读到的是另一条更早的分支：`draft.status === 'unavailable'`。

再往上追一层：`unavailable` 来自 `derive()` 里「`view` 缺失」。`view` 来自 `settings.describe()`，而 `describe()` 的第一句是：

```js
const schema = entry.fiber?.runtime?.Config
if (schema === undefined || ...) return []
```

**插件没有导出 `Config`，宿主就一个字都不返回。** 设置页于是永远停在 loading → unavailable。这不是权限问题，是「你没申报字段，宿主不敢替你编」。

### 89.2 为什么必须平铺到根

宿主写入口只给顶层字段名：`ConfigFormController.set(field, value)` → `mutate([{ op: 'set', path: [field], value }])`。如果 schema 是嵌套的 `{ meow: {...} }`，页面上每个开关都得拼成 `set('meow')` 再把整段对象塞回去——那不是「写一个字段」，是「用页面手里的旧对象覆盖整段」，并发写会互相吃。平铺之后「一个开关 = 一个顶层字段」，`isVolatilePath(['enabled'])` 直接命中根 volatile。

代价是兼容段必须显式申报：`write()` 里有 `const strip = (value, node, path = []) => isVolatilePath(schema, path) ? {} : …`，**没申报的键会被整段剃掉**。我们旧的 profile 是 `config: { meow: { homeDir: dsh-storage, … }, nebula: {} }`，如果不声明 `meow` / `nebula` 这两个 `z.any()` 段，第一次在页面上点任何开关就会把 `homeDir` 抹掉——记忆库从 `dsh-storage` 回退到用户主目录，用户完全不会察觉。这就是「顺手剃掉」比「报错」危险的地方：它不响。

### 89.3 根 volatile 与子字段 volatile 不能共存

第一版想「根不 volatile，每个字段自己 volatile」，被 schemastery 当场挡回：

```
ValidationError: $.nebula volatile fields require a fixed object path without an enclosing volatile field
```

既然字段本身都得可写，就照 meow 的做法整份声明成根 volatile（`Config.meta.volatile = true`），子字段全部普通。`isVolatilePath()` 遇根 volatile 直接 `return true`，语义上等价，且与引擎同构——**跟引擎一致比自创更省事，因为热更新路径 `equalExceptVolatile` 也是按这个语义写的**。

### 89.4 写入之后重建什么，不重建什么

`_commitVolatile()` 判定「唯一变化是 config」时**不重挂插件**，只 `updateVolatile` 再发 `loader/volatile-update`。这是宿主替我们留的热更新口子，但它只更新 ref，**不会重新执行 apply**——所以工具面不会自己变。

于是分两类处理：

1. 本插件 4 个键（`compatAliases` / `guideMaxChars` / `toolWaitMs` / `flushThrottleMs`）：150ms 去抖后 `stopSurface()` → `startSurface()`，重建工具集合与注入。品牌函数与注入文案读的是活的 `macroCfg`，所以这四个键连 `stopSurface` 之前就已经生效了新语义。
2. 引擎自己的字段（meow 的 14 个、`nebula` 段、`homeDir`）：**拆掉那一只引擎再重挂**，然后重建表面。因为引擎拿到的是装配时拍下的配置快照——它内部那层 `readConfigRoot(patch)` 读的是自己 fiber 上的 patch，热写碰不到。

第一版实现错在两点，两条都值得记下来：

- **以为「把根引用交给 meow 就热生效」**。它的 `readConfigRoot` 是鸭子类型（`typeof ref.get === 'function'`），宿主那种 `{ get, [Symbol.for('cosmokit.volatile.write')] }` 引用进不去，结果 meow 整个装不起来：8 个工具一个都没注册，统一工具每次调用等满 `toolWaitMs` 后抛「这项能力还没就绪」，`probe-host` 从 0.9 秒涨到 150 秒。**引擎只吃普通对象**。
- **`wrapPlugin` 用 `{ ...mod }` 整包拷贝**。我们自己导出 `Config` 之后，这个浅拷贝把 `Config` 也带给了包装后的 meow/nebula，宿主于是拿我们那张 21 键大 schema 去解析引擎的配置——又一次把它解析成引用。现在只挑 `name` / `inject` / `apply` / `reusable` 四项。

还有一条顺序要求：重挂引擎期间统一工具还挂在宿主上，它们指向的引擎正在 dispose——所以**先 `stopSurface()` 收工具面，再拆引擎，再装，最后 `startSurface()`**。

「配置变了」与「引擎要重启」确实不是同一件事，但也不是可以永远回避的事：融合层那四个键改了就只换表面；引擎字段改了就只能重挂那一只（meow 改了不重挂 nebula，反之亦然）。日志里会写清楚重挂的是谁、扫描会重启。

### 89.5 教训 52

**「不支持」这三个字必须能被证伪。** 用户看到「当前连接不支持设置写入」时，会去检查网络、检查权限、检查是不是远程——全部走错方向。真正的原因在插件里少了三行导出。写这类兜底文案时必须问一句：这句话指向的那个原因，我验证过吗？没验证过就别指名道姓，只说「设置页没拿到字段声明」。

同族：`snap.mode === 'memory'` 这种**读一个不存在的字段**的防御分支，永远为假，却让人以为「已经考虑过镜像只读的情况了」。**防御代码如果永远不触发，它就是注释，而且是会骗人的注释。**

### 89.6 怎么验的

verify A79 十三条走真机制不 mock 语义：自造 `root = { get: () => snap, [Symbol.for('cosmokit.volatile.write')]: v => snap = v }` 交给 `apply`，捕获 `loader/volatile-update` 的 handler 与每次 `ctx.plugin()` 的入参；先断言引擎拿到的是普通对象、包装子插件没带 `Config`；写 `compatAliases=true` 后手动 emit（模拟宿主），300ms 后断言别名工具 9 个回来、注入仍只有 1 段（旧的先拆再装）、8 个统一工具一个没丢；再写 `hitTopK` 断言 meow 那一只引擎被重挂（`plugins` 多一条、新配置 `hitTopK=5`）且工具面一个没丢；再写 `nebula` 断言只重挂星图；最后 `Config({ compatAliases: 'yes' })` 必须抛——设置页 decode 就靠这个判断能不能写。

端到端靠 `tools/probe-host.mjs`（真 cordis + 真 ToolsService + 真 SystemPrompt）：它才是这次回归的证人——只有它会因为「引擎没装起来」而让 F1/F2 抛 NOT_READY、耗时从 0.9 秒变成 150 秒。单跑 verify 全绿而 probe-host 全红，说明「我们自己的契约对、真宿主里装不起来」。

宿主写路径另外复刻验过：拿 `dsh-settings/lib/types/schema.js` 的真 `volatileForm/projectForm/isVolatilePath` 加手写 `strip/mergeLayers`，在旧写法 raw 与新写法 flat raw 上各跑 `set`/`unset`，确认兼容段被保住、`unset` 不 materialize 默认值、脏值抛 `ValidationError`。

## 90. 显示名与身份名（0.2.80）

### 90.1 那张卡上的字符串是别人写的

「上下文注入 · plugin:meow-memory」这句在聊天里出现了很久。第一反应是去插件里搜这个字符串——搜得到，改掉，看效果。但它显示在宿主 UI 上，说明有一只**读**它的代码：`dsh-client-ui-chat/src/client/conversation-nodes/event-projection.ts:60` 的 `contextProducer()`，只对 `session-reference` / `agent-instructions` / `skill-invocation` 三种 kind 特判出人话标签，其余走 `default: return { role: 'inject', label: kind }`，再由 `ContextInjectionRow.tsx:69` 原样贴出。

这是好设计（未知来源的来源名至少可见、可搜），但它意味着**面板文案的归属权在数据里，不在 UI 里**。要改就改 `source.kind`；改 UI 意味着每次 DSH 升级都要重新打补丁。0.2.80 选前者。

### 90.2 kind 是数据契约，不是装饰

改之前先查这个值除了显示还干什么。结果它还是**识别历史消息的钥匙**：`isMeowSource()` 拿 `record.kind === PLUGIN_KIND` 判「这条是不是记忆注入」，折叠、锚点、委派提示三处都靠它。老会话里落盘的 kind 是 `plugin:meow-memory`；如果只改新值，这些老消息在新版本里变成「不认识的消息」——折叠失效、锚点漂移，最坏情况是被当成普通用户发言再注入一遍。

所以改造方式是**加新值、留旧值**：`PLUGIN_KIND = "plugin:macro-memory"`，另加 `LEGACY_PLUGIN_KINDS`，`isMeowSource()` 先认新、再扫旧，最后保留更老的 `{kind:'plugin', plugin:'meow-memory'}` 形状（那是更早版本的落盘形状，重放老会话时还会出现）。

**任何「已经写进持久层、并且被读回来做判断」的字符串，都是数据契约。**改它要么迁移数据（等于改写用户历史，不做），要么两头都认。

### 90.3 身份名不动，只动显示名

`PLUGIN_NAME = "meow-memory"` 保留：日志前缀、`/meow-memory/dreamed-sessions` 与 `/meow-memory/skip-dreams` 两条 HTTP 路由、前端 `data-plugin` 属性都用它；`SETTINGS_NS_CANDIDATES` 里也留着它做兼容。改它没有任何界面收益，只会把路由与已存的前端状态一起打散。

**显示名与身份名分开**：「统一口径」统一的是人看见的那一层。身份名一改，兼容成本立刻从「多认一个字符串」升级成「迁移三处持久状态」。

### 90.4 顺手收掉同族的假话

同一轮翻字典时发现三句不成立的文案：

- `settings.loading`：「喵记忆配置加载中」——插件早改名叫宏记忆了。
- `settings.saved`：「已保存 ✓ 热重载/重启 meow-memory 插件后生效」——0.2.79 起真的是热应用（融合层重建表面、引擎字段重挂），这句话在教用户做一件不必要的事。
- `settings.unavailable`：「当前连接不支持设置写入（仅本机回环连接可编辑）」——它挂在 `snap.mode === 'memory'` 分支下，而这个字段宿主根本不发，分支永远不进。**永远不进的分支里的文案，比没有文案更坏**：它把「设置写不进去」的排查方向直接指向网络与权限，而真正的原因（插件没导出 `Config`）一个字都没提。见 §89.5 教训 52。

### 90.5 星图的工具调用画像

`vendor/dsh-memory-nebula/lib/host/transcripts.js` 的 `TOOL_OWNER` 把 `memory_*` 记成 `plugin:meow-memory`、`nebula_*` 记成 `plugin:dsh-memory-nebula`——融合包里这是**一个插件**，面板上却报出两个来源；而且原来那张表漏了 `nebula_sources` / `nebula_ingest` / `nebula_hygiene` / `nebula_bridge` 四个工具，它们在画像里一直算「无归属」。0.2.80 两张表并一张，全归 `plugin:macro-memory`。

这是同一件事的另一个面：**归因错，读数就错**。用户看到「两个插件各调了多少次」会以为装了两套东西。

### 90.6 教训 53

**改一个显示字符串之前，先查它是不是判据。**判据型字符串（kind、status、type 这类被 `===` 比对过、并且落过盘的）改法只有两种：两头都认，或者写迁移。前者便宜，后者要动用户数据。

同族：**「显示名」与「身份名」是两个字段，只是长得很像。**混用它们的人，最后总会在某个升级里发现「改名」变成了「迁移」。

### 90.7 怎么验的

verify A80 七条：用 `new Function` 把 vendor `index.js` 里 `var PLUGIN_NAME … isMeowSource` 那一段源码**抠出来真跑**，喂新 kind / 老 kind / 更老的 `{kind:'plugin',plugin:'meow-memory'}` / 别人家的 `plugin:hindsight` / `null`，五种结果都要对；客户端包里断言同一份定义还在（它是另一个构建产物，最容易被忘）；`transcripts.js` 断言三条映射都指向 `plugin:macro-memory` 且两个旧名字不再出现；三句文案用「非 ASCII 转 `\uXXXX` 再 `includes`」比对。

最后这条是这一节的技术要点：**源码里的中文是转义存的**（`\u5b8f\u8bb0\u5fc6`），直接 `includes('宏记忆')` 永远搜不到——写测试的人会以为文案改好了，其实只是测试没测。本项目里这条坑出现过不止一次，凡是断言中文文案的，先过 `esc()`。

---

## 91. 门面与账本（0.2.81）

0.2.81 不改一行运行时逻辑。它要解决的问题是：**这个东西怎么交给一个不认识它的人**。三个读者同时出现——GitHub 首页的陌生人、DSH 插件市场详情页、别人 `node_modules` 里的副本——而他们有同一个特点：**不会读源码，也不会读我们的开发日志**。

### 91.1 一份文件不能同时做门面与账本

0.2.80 收尾时根 `README.md` 是 **268,244 B / 3,914 行**。它是这个项目从 0.1.x 到 0.2.80 的逐轮账本：每一场事故、每一条判据、每个被推翻的决定（包括 0.2.79 那次「第一版就是错的」）。作为账本它值钱。

作为门面它是灾难，而且不是「不够好看」这种程度的问题：

1. **市场详情页直接渲染仓库根的 `README.md`。** `@deepseek-ai/dsh-plugin-market` 的 `detail-files.ts` 用 `README_NAMES` 在 `raw.githubusercontent.com/<owner>/repo/<ref>/` 下找 README 并原样呈现。268 KB 贴上去，第一屏是「0.2.5 修了层名过滤」——陌生人不会往下滚，也不需要往下滚，他要的是「这玩意比我现在用的强在哪」。
2. **同一份文件里的两套语气互相干扰。** 给外人看要断言式（「省 84.7%，实测」），给自己看要过程式（「这个数字之前算错过一次，因为……」）。混在一起，前者被稀释，后者被截断。

所以拆三份，各有各的读者：

| 文件 | 读者 | 判断标准 |
| --- | --- | --- |
| `README.md` | 陌生人（GitHub / 市场详情页） | 三十秒内能判断：是什么、强在哪、敢不敢装 |
| `docs/INTERNAL.md` | 我们自己 | 能不能照着这份日志复现当时的判断 |
| `DESIGN.md` | 我们自己（跨轮） | 下次遇到同类问题时，教训还在不在 |

拆分动作本身很便宜（`copyFileSync` + 重写门面），贵的是**让检查器跟着分开看**——见下一节。

### 91.2 检查器只认一份 README，会反过来污染门面

`tools/doctor.mjs` 原本只有一条路径：`join(root, 'README.md')`。它管三件事：脚本都得在文档里露过面、文档提到的脚本都得存在、文档得写当前版本号。合理——但它把「文档」和「根 README」画了等号。

于是出现一个反压：**门面里必须塞满 `tools/*.mjs` 的清单**，否则 5.2「每个脚本都必须在 README 露过面」打红。而门面正是最不该出现这些的地方。

改法是给检查器一个**优先路径 + 回退路径**：

```js
const internalPath = existsSync(join(root, 'docs', 'INTERNAL.md'))
  ? join(root, 'docs', 'INTERNAL.md')
  : join(root, 'README.md')
```

回退不是偷懒：别人 fork 出去、或者把包拉进 `node_modules` 时，`docs/` 可能被裁剪；那时候退回根 README 至少还能查到版本号，而不是整段跳过。**判据要能在残缺的副本里降级运行，而不是要么全对要么全崩。**

`verify.mjs` 那边更贵：**85 处**「README 必须提到这句话」的断言。它们测的东西其实不是 README，是「文档里写着这件事」——一个隐含契约。全部改成指向 `docs/INTERNAL.md`（44 处 `join(root, 'README.md')` + 41 处 read 助手的字符串），改完 `verify.mjs` 里 `README.md` 出现次数为 **0**。

**教训 54**：判断「文档里有没有写」的测试，测的是**文档路径**这个隐含契约。这个契约一变，几十条断言一起红，且红得毫无信息量（它们不是发现了 bug，是发现了搬家）。所以路径只能有一个出处——和根目录那些 `tools/_root.mjs` 一样的道理，只是这次对象是文档。

### 91.3 图里的数字不能是设计目标

要附图，本机没有 playwright / puppeteer / electron，GUI 在 `127.0.0.1:50753` 且要 token（直接 `Invoke-WebRequest` 是 403），截不了界面。做法：手写 SVG，用系统自带 Edge 无头转 PNG。

```bash
msedge --headless=new --disable-gpu --hide-scrollbars \
       --force-device-scale-factor=2 --default-background-color=FFFFFFFF \
       --window-size=1200,720 --screenshot=docs/images/architecture.png \
       file:///.../docs/images/_architecture.svg
```

三个参数都不是装饰：`--force-device-scale-factor=2` 出 2 倍图（GitHub 上 Retina 不糊），`--default-background-color=FFFFFFFF` 给白底（深色主题下透明底会把深色字吃掉），`--hide-scrollbars` 防止 1px 的布局抖动把右边裁掉。

真正要紧的是**图上的数字**：8,655 B / 1,085 字符 / 56,759 B / 4,085 字符——四个数分别来自 `tools/probe-host.mjs` 的 D2（8 工具 schema 合计）与 E2（注入字符数），以及 0.2.x 融合前的历史基线。**它们必须是实测值。**图是最容易被当成「大概意思」的东西，而一旦图上出现一个整数，读者就会当它是测量结果；写错一个数，整份门面就从「实测」降级成「宣传」。

同理，图的可编辑原件（`docs/images/_*.svg`）留在仓库里。用「导出 png 就删源文件」的方式做图，等于把「这张图怎么来的」这件事一起删了。

### 91.4 MIT 合规：保留原文，不是「在别处提一句」

这份包里有别人的代码（`vendor/meow-memory` 是 Phant0Meow 的 MIT 项目，`vendor/dsh-memory-nebula` 是更早的自有代码）。合规分三层做：

1. **根 `LICENSE`** —— 本仓库自己的 MIT。
2. **两份 `vendor/*/LICENSE` 原文一个字不动。** MIT 要求「保留版权声明与许可声明」，保留的意思是**原样保留在副本里**。把上游版权挪到自己的 NOTICES 里、删掉 vendor 里的 LICENSE，形式上「提到了」，实质上违反条款。
3. **`THIRD-PARTY-NOTICES.md`** —— 上游地址、版本、角色，以及**我们对副本做的全部改动**。MIT 不要求公开改动，所以这一层是我们自己加的账：这份副本里有一批「把静默失败改成明说」的改动（0.2.46–0.2.80 逐条），不说清楚，使用者会把我们的行为当成上游的行为，出问题时去上游报 bug。

改动分两类写，因为它们的性质不同：**A 类融合接线**（注入 `kind`、设置页三语文案、`PLUGIN_NAME` 不动）是我们加的接口；**B 类原地修掉的静默失败**是我们改的行为。前者必须写清楚（别人接这个包时要能预判），后者更要写清楚（它改变的是别人已经依赖的行为）。

### 91.5 别人的校验器才是规格

市场索引 `plugin-market/index.json` 遵循 format 1。只看 `src/types.ts` 会以为规则是「字段齐、类型对」，真正会拒绝你的那些条件都在 `src/index.ts` 的校验逻辑里。实际踩到的：

| 规则 | 为什么容易错 |
| --- | --- |
| `LocalizedText` 对象**必须含 `en`** | 只写 `zh` 类型完全合法，运行时才拒 |
| `source.url` 要 https **规范** URL 且路径 ≥2 段 | `https://github.com/OWNER` 看着像网址，少一段就被拒 |
| `commit` 是 **40 位小写 hex** | 短 SHA、大写、占位都能「看起来像」，格式闸只认长度与字符集 |
| `icon` 相对引用**相对索引 URL** 解析 | 直觉是相对包根/仓库根；实际 404 才知道 |
| 内联 icon ≤ **32 KiB**（base64 解码后） | 看代码是 `data:` 前缀检查，实际还量字节 |
| `publishTimestamp` 是 **Unix 秒** | 毫秒也能过 `[0, 10^11)` 区间，但详情页年份错到几万年 |
| `versions` 按 SemVer 降序、不重复 | 校验器会排序，但重复直接拒 |
| `category` / `labels` / `sortKey` 的 id 必须**先声明** | 引用完整性错误，报错文本是 `references undeclared id` |

**教训 55**：类型定义写的是「形状」，校验器写的是「规格」。凡是要给别人的系统喂数据，规格以它的校验器为准——读 `types.ts` 只能让你写出「能编译」的东西。

`tools/check-market.mjs` 因此不自己复述规则，而是**真 import 宿主的 `parseMarketIndex`** 跑一遍（真 import 而不是复制粘贴一份规则：复制的规则会随上游漂移，而且漂移时你是绿的那种漂）。另外四条是校验器管不到、但市场会因此装不上的：

- commit **不是 40 个 0**（给「还没提交就发索引」设的闸）；
- commit 在本仓**真实存在**、是 `HEAD` 或它的祖先（防止钉到一个未来的/别的分支的 SHA）；
- 索引文件已被 git 跟踪（防止「本地有、推上去没有」）；
- icon 文件真的存在、真的是 PNG/JPEG/WebP、≤512 KiB。

### 91.6 索引里的 commit：一个必须固化的鸡生蛋

市场装的是 **commit 钉住的 git 地址**（`git+https://…git#<sha>`），所以索引里的 SHA 必须是「包含全部代码的那次提交」。索引本身也在仓库里——这次提交的 SHA 在提交之前不可能知道。

固定解法，两步：

1. 第一次提交 `ec719eb…`：163 个文件，全部代码 + 门面 + 图 + 许可，索引里的 commit 先写真实的第一个 SHA 是不可能的，所以第一版占位/或先不钉；
2. 把索引里的 `commit` 改成 `ec719eb…`，连同 `.gitattributes` 一起提成第二次提交 `0942987…`。

第二次提交不改变代码，只改「指向哪次代码」。因为 `check-market` 断言的是「commit 是 HEAD 或祖先」，第二步之后仍然成立；而如果第一步之后忘了改，那条「不是全 0 / 必须真实存在」的闸会立刻打红。

**教训**：凡是「把自己的版本标识写进自己的内容里」的工程（锁文件、校验和、发布清单、CI 徽章），都需要这样一套「自引用提交」的固定套路，外加一条**守卫断言**。没有守卫时，这类占位符会安安静静地活到线上。

`.gitattributes` 里的 `* text=auto eol=lf` 是同一个思路的另一面：这个仓库有大量**按字节**比对的判据（`lib/client.js` 的 163,239 B、sha256 前缀、两棵树的 VENDOR 指纹），Windows 上默认 CRLF 会让克隆下来的副本假红一片。**判据越精确，环境越要钉死。**

### 91.7 这一轮的验收

- `node tools/check-market.mjs` → 48 条 ALL PASS（真校验器 + 真 git；含镜像索引 15 条与一条阴性对照）。
- `node tools/doctor.mjs` → 内部日志与门面两段各自过；根 `LICENSE` 是 MIT 原文；第三方声明三项（作者名 / 上游地址 / `MIT`）都在；门面引用的 3 张图都在。
- `node tools/check-all.mjs` → 13 支（新增第 11 支 `tools/check-market.mjs`）。

### 91.8 边界

- **推送用的是本机已存的 GitHub 凭据**（`~/.git-credentials` 里那条 `gho_`），不是我们新申请的。仓库是 `hanhan9999999999999999999/dsh-macro-memory`（public）；`gh` CLI 本机没有，建仓走的是 REST `POST /user/repos`。
- **索引里的 `OWNER/REPO` 已换成真值**（`plugin-market/index.json` 的 `homepage` / `repository.url` / `versions[0].source.url` 与门面里的索引 URL 四处）。换账号或改仓库名时要再改一遍这四处——它们**没有**共同出处，这是这一轮留下的唯一硬编码债。
- **没发 npm。** 市场支持 `source.type: 'npm'`，但这份包的价值有一半在 `vendor/`（两份引擎副本随包走），走 git 源最直接。

## 92. 可安装性是两个门（0.2.81）

### 92.1 索引能取到，不等于能装

市场安装的动作链有两段，各自独立的网络失败点：

1. **取索引**：`GET <索引 URL>`，拿到 format-1 JSON；
2. **装插件**：拿 `versions[0].source` 去 `git clone <url>` 并 checkout 到 `.git#<commit>`。

本机实测（2026-11-19，Node `fetch` 20 s 超时 / git 300 s 超时）：`raw.githubusercontent.com` 116 ms 就 `fetch failed`，`cdn.jsdelivr.net` 196 ms 失败，`cdn.statically.io` 10.3 s 失败；`api.github.com` 通（504 ms）；`gh-proxy.com` 取索引 1.9 s、取图标 3.4 s。`git clone` 直连 GitHub **300 s 超时**，走反代 29 s 拉完 164 文件。

所以只把索引 URL 换成反代，装到一半会死在 clone 上——而失败现场看起来像「市场坏了」，不像「网络坏了」。

### 92.2 于是要两份索引，而两份必须逐字段同步

新增 `plugin-market/index.cn.json`：`title` / `description` / `title.zh` 标「（国内镜像）」，`source.url` / `repository.url` / `homepage` 换成 `gh-proxy.com` 反代前缀，其余字段与主索引**逐字节相同**，钉**同一个 commit**。

两份索引是典型的「复制一份就会漂移」的结构。防漂移不能靠自觉，只能靠断言：`tools/check-market.mjs` 第 9 段共 15 条，其中「版本序列一致」「commit 相同」「`metadata` 逐字节相同」「`icon` 仍是同一个相对引用」四条就是漂移探测器。为什么 `icon` 比原始相对值而不是解析后的绝对值——因为 `icon` 是**相对索引 URL** 解析的，两份索引的 base 不同，解析结果天然不同，比绝对值只会假红。

### 92.3 反代地址要过别人的校验器（那个空段）

宿主 `gitUrl()`（`dsh-plugin-market-index/src/index.ts`）要两件事：`new URL(value).href === value`，且 `pathname` 匹配 `^(?:\/[^/]+){2,}$`。

直觉写法 `https://gh-proxy.com/https://github.com/a/b`：`href` 那关是过的，但 `pathname` = `/https://github.com/a/b`，内层那个 `//` 让 `[^/]+` 吃到一个**空段**，于是被拒，报的是 `must name a repository with at least two path segments`——听起来像「仓库路径不够深」，实际是空段。

正确写法是把它写成规范形式：`https://gh-proxy.com/https:/github.com/a/b`（内层协议只留一个斜杠），`pathname` = `/https:/github.com/a/b`，两关全过，且 `git clone` 照样成功（23 s）。

**这不是笔误，是契约。** 发现它的方式只有一个：**拿对方的校验器真跑**，别自己目测正则。为此在 `check-market` 里放了一条**阴性对照**：把地址改回双斜杠，`parseMarketIndex` 必须抛；它不抛，说明我们以为的规则是假的。

### 92.4 教训 56

1. **「能不能访问」是分层的**：索引、图标、`git clone` 各有各的通路，任何一层失败都表现为「装不上」。测可安装性要**按动作链逐段测**，不要只测第一个 URL。
2. **镜像索引是复制品，复制品必须被断言钉住**：主副两份之间每一条共享字段都要有对照断言，尤其 commit（钉不同就装到不同代码）。
3. **外部校验器是规格，正则直觉不是**：反代、镜像、代理地址这类「套一层」的字符串，必须用对方的解析器实测，并且把「错误写法必须被拒」写成阴性对照。
4. **相对引用要按相对语义比**：`icon` 比原值，不比解析值。

## 93. 调试仪器不能带上生产（0.2.81）

### 93.1 绿着的仪器，也是一种缺陷

`settings-diag.log` 一天长到 108,656 B，最后写入时间就是当天。它来自三轮排查「设置页写不进去」时加的仪器：包一层 `settings.write` / `configEditor.edit`、每次 `describe()` dump 命名空间列表、5 秒后再 dump 一次、把 `configEditor.entries()` 全量落盘。

问题不在它报错——它不报错。问题在**验证体系看不见它**：所有检查都是绿的，因为仪器不改变任何被断言的行为。于是「不报错的副作用」成了长期欠账：持续写用户目录、每个会话多挂定时器、把内部结构写进磁盘。

**教训 57：能被断言的行为才被保护；不能断言的行为会腐烂。** 要么给仪器加断言（默认关闭、有上限、字面量只有一处），要么它必然在某一轮里长歪。

### 93.2 收口成一个出口

```js
var SETTINGS_DIAG_ON = process.env.DSH_MEMORY_SETTINGS_DIAG === "1";
var SETTINGS_DIAG_MAX_BYTES = 256 * 1024;
function settingsDiag(line) {
  if (!SETTINGS_DIAG_ON) return;
  // mkdir → 超限先清空 → 追加一行
}
```

8 处直写收口到 `settingsDiag()`，`dumpDescribe()` 关闭时第一行 return。让 `settings-diag.log` 这个字面量在源码里只剩 1 次，是这个收口**可断言**的关键：计数就是判据（A81 第二条）。如果继续允许「各处自己拼路径」，任何断言都追不上。

### 93.3 「默认关」比「删掉」好

删掉会丢掉复现能力（0.2.18–0.2.20 正是靠它才发现宿主按 entry id 注册 config 命名空间）。正确做法是**把仪器变成可复现的仪器**：默认不出声，需要时一个环境变量打开，且自己有上限。

这是同一类判断的第三次出现：`debug` 日志、`probe-*` 探针、这次的 settings 诊断——**能随时打开、默认不产生副作用**，才是发布版里该有的形状。

### 93.4 验收

`node --check` 语法过；`verify.mjs` A81 五条（开关在、字面量唯一、dump 有 guard、上限在、打开仍写）；`make-vendor-manifest` 重记指纹 `d50b1c3c11a27934`；`doctor` 补丁账本多一条 `[macro-fusion 0.2.81]`。

## 94. 不跑的脚本会烂（0.2.82）

### 94.1 一行自由变量，三个月没人发现

`tools/probe-toolsize.mjs` 是 0.1.x 写的「数两套引擎工具 schema 字面量体积」脚本。这一轮顺手跑了一次：

```
const a = scan(root + '/meow-memory/lib/index.js', 'meow-memory')
                ^
ReferenceError: root is not defined
```

`root` 从来没被导入——文件头只有 `import { vendorDir } from './_root.mjs'`。也就是说从 `_root.mjs` 落地那次起（0.2.1x），这个脚本就已经死了。

要紧的是：**`node --check` 抓不到它**。语法完全合法，错在运行期的自由变量解析。所以「所有脚本都过了 --check」这种体检给不出任何保证，它保证的是这批文件能被解析，不是这批文件能跑。

### 94.2 它为什么能坏这么久

三个覆盖点同时缺席：

1. 它不在 `check-all` 的 `STEPS` 里（14 支里没它）；
2. 没有任何断言读它的输出（`verify.mjs` 里搜不到 `probe-toolsize`）；
3. 它不在 doctor 的补丁账本里（账本只登记我们改过的 vendor 文件，工具脚本不在其中）。

于是仓库里有一条**永远不会被执行、也不会被检查**的路径。它不产生红，也不产生任何信号——这正是 93.1 那类「不报错的欠账」的极端形态：0.2.81 那条是「一直在跑但没人断言」，这条是「压根没人跑」。

### 94.3 修法：让它自己出判决，然后进 check-all

只把 `root` 换成 `vendorDir` 是修一行；真正的修法是把「跑」这件事变成结构性的：

```js
const MEOW_TOOLS = ['memory_remember', 'memory_search', 'memory_find_similar', 'memory_read',
                    'memory_update', 'memory_project', 'memory_home', 'memory_dream']
const NEBULA_TOOLS = ['nebula_recall', 'nebula_inspect', 'nebula_link', 'nebula_path', 'nebula_stats',
                      'nebula_hygiene', 'nebula_bridge', 'nebula_sources', 'nebula_ingest']
const BUDGET_BYTES = 87326

ok(missingM.length === 0, '清单：meow 的 8 个原工具一个不少', '8/8')
ok(missingN.length === 0, '清单：星图的 9 个原工具一个不少', '9/9')
ok(sum <= BUDGET_BYTES, '体积：17 个工具字面量合计没有膨胀', sum + ' B ≤ ' + BUDGET_BYTES + ' B')
if (failures !== 0) process.exitCode = 1
```

三点设计：

1. **清单判据是硬需求的可执行版**。「meow 原有功能绝对不能砍」这句话在这里第一次变成断言：任何一个 `memory_*` / `nebula_*` 从 vendor 源码里消失，这一支就红。这比读文档、比人工检查都可靠。
2. **体积判据是上界而不是等号**。87,326 B 是当前实测值，`sum <= BUDGET_BYTES`：只许变瘦，不许悄悄长回去。
3. **它自己置 `exitCode`**，所以 `check-all` 不需要为它写特例——判据、出口、计数三件事都在脚本里。

插在 `param-audit` 之后成为第 12 支；`verify.mjs` 的「STEPS 一共几支」判据从 13 改成 14——这条判据的意义正在于此：**新增一支就必须同步改数，改不动就说明有人绕过了编排。**

### 94.4 教训 58

> 一条没有任何人执行的路径，等于不存在；但它占着「我有这个能力」的位置，所以比不存在更坏。
> 校验手段要问一句：它能不能发现「这段代码根本跑不起来」？语法检查不能。

推论两条：

- **脚本的生死线是「被编排」**。探针写出来只是半成品，进了 `check-all`（或至少有一条断言读它的输出）才算完成。
- **判据要贴着产品承诺写**。「不能砍原有功能」这种话，如果没有一条断言直接检查 17 个工具名，它就只是一句口号；有这条断言之后，砍掉任何一个工具都会在 2 分钟内变红。

### 94.5 验收

`node tools/probe-toolsize.mjs` → 三行 PASS + `ALL PASS`、`exit=0`（修前是 `ReferenceError` / `exit=1`）；`verify.mjs` A82 五条（进了 STEPS、取根走 `_root.mjs` 且无裸 `root`、清单判据在、体积判据在、失败置 `exitCode 1`），总断言 887 → 892；`check-all` → **14/14，1,663 条断言，118.2s**；`doctor` → 补丁账本多一条 `[macro-fusion 0.2.82]`，116 条全绿。

## 95. 装探测器，而不是再修一个脚本（0.2.83）

### 95.1 修完一例，立刻撞见第二例

94 章修好 `tools/probe-toolsize.mjs` 的裸 `root` 之后，把 `tools/` 下没被编排的脚本挨个跑了一遍，`tools/cost-baseline.mjs:8` 报出一字不差的同一个错：`ReferenceError: root is not defined`（它也只 `import { vendorDir }`）。

两个独立文件、同一个错、都躺了两个月——这已经不是「手滑」这个量级的解释。正确的结论是：**「没被执行的脚本」是一种状态，凡进入这个状态的东西都会烂**。修掉其中两个，只解决了两个样本。

顺带发现 `tools/*.mjs` 里有四个「孤儿」（既不在 check-all、也没被任何脚本 import）：`cost-baseline.mjs`、`wire-profile.mjs`、`patch-meow-settings-ns.mjs`、`patch-nebula-noinject.mjs`。它们三个是手动工具、一个是历史补丁，都不该删，但**没人知道它们还能不能跑**——这是「有意的」，还是「忘了」，仓库里看不出来。

### 95.2 账本：把「手动」变成一个显式状态

`tools/manual-tools.mjs` 只导出数据，六条，每条两个必填字段：

```js
{ file: 'tools/cost-baseline.mjs', smoke: true,  why: '只读两套引擎源码数静态开销，输出是人读报表' }
{ file: 'tools/patch-nebula-noinject.mjs', smoke: false, why: '按行号切片的一次性补丁，锚点已不存在，再跑必报错' }
```

- `smoke: true` 是**可执行承诺**：只读、随时能跑，探针会真跑一遍。不是「我觉得它没事」，是「它刚刚退出码 0」。
- `smoke: false` 必须写理由，且理由不许太短（判据卡 12 字）。理由短到「临时」两个字，等于没写。
- 数据与判据分开：账本不写逻辑，所以它不会自己长出一套规则；探针改判据不用改账本。

这一步的真正作用是**消除「有意的」和「忘了的」之间的模糊**。孤儿脚本以前默认等于「大概没人要」，现在必须有人在账本上签字；没签字又被探针发现 → 红。

### 95.3 三类归属与那个自由变量判据

`tools/probe-tools.mjs`（check-all 第 13 支，16 条判据）只做三件事：

1. **归类**：每个 `tools/*.mjs` 必须是 `STEPS` / `被 import` / `账本` 之一。判据里还有三条反作弊：账本文件必须存在、账本不许和 STEPS 重叠（记账不能撒谎）、`smoke` 不许是「没说」。
2. **自由变量**：把 `_root.mjs` 的导出名当白名单——脚本用了某名字却没导入、又没自己声明同名局部变量 → 红。这条判据就是 94 那个错，只不过从「这次修好了」升级成「以后不许再犯」。
3. **冒烟**：`smoke: true` 的真跑（`spawnSync` + 30 s 超时 + 非零退出即红）。

`node --check` 也跑，但只当语法兜底：它抓不到自由变量，别指望它。

### 95.4 教训 59

> 探测器最大的风险不是漏判，是「判了，但从来没人验它判得对」。
> 一条判据如果自己没有被阴性对照打过，它和注释没有区别。

第一版探针就写了三处假红：`doctor.mjs` 里 `what: '…改取 _root.mjs 的 vendorDir…'` 这段**字符串**被判成「用了 vendorDir 却没导入」；`wire-profile.mjs` 的 `const at = work.indexOf(anchor)` 被判成「白用 at」；连 `_root.mjs` 自己都被判「用了 root 没导入」。三处都是误伤——而误伤的代价是：人开始学会「这条红不用管」，然后真红也一起被忽略。

修法是两层：

- 结构上：`maskNonCode()` 把注释与 `'…'` / `"…"` / `` `…` `` 的字面量部分涂成空格（`${…}` 里还是代码，保留），跳过定义处，自己声明同名局部变量的放过；
- 制度上：**加阴性对照**——六条已知写坏/已知正常的片段必须分别判「抓」和「不抓」，三条归类对照（不存在的脚本→orphan、探针自己→step、账本自己→import）。判据从此有自己的测试。

这和 92 章镜像索引那条阴性对照是同一条方法论：**判据必须能证明它会红**。区别只是 92 是给别人的校验器做对照，这里给我们自己的探测器做对照。

### 95.5 验收

`probe-tools` → 16 条 ALL PASS（归类 26/26、账本 6 条、语法 26/26、自由变量干净、冒烟 3/3、自指 3 条、对照 9 条）；`cost-baseline` 修后真跑出 693 字符 RULE + 17 个工具 + 注入预算 + 数据库行数；`verify` A83 八条（账本是数据、每条带 smoke/why、探针进 STEPS、探针自带归属与自由变量判据、有阴性对照、冒烟真跑、cost-baseline 已修、cost-baseline 进账本），总断言 892 → 900；`check-all` → **15/15，1,671 条断言**；`doctor` 补丁账本多两条。

### 95.6 边界

只动 `tools/`、`verify.mjs`、文档与版本号：不碰 vendor、不需要重启 DSH。能自动跑的脚本一律进 check-all，账本只收「确实需要人手动跑」的；`patch-nebula-noinject.mjs` 以 `smoke: false` 留存，是历史证据，不是可重放工具。

## 96. 统一口径不是「记得统一」，是「有人替你问」（0.2.84）

### 96.1 四处一致，靠的是「我记得」

「统一所有面板口径」这个要求本身有个陷阱：它听起来像一次整理，其实是一个**持续状态**。同一件事（对外几个工具、动作有几个、注入多少字、体检分几类、旧名字还在不在）同时活在这几处：

| 处 | 例子 |
| --- | --- |
| 注入手册（模型读的那段字） | `memory_admin（action=home\|stats\|…）`、`level（每条都要）` |
| 工具 schema | `memory_search.mode`、`memory_link.action`、`memory_update.status` 的 enum |
| 常量表 | `ACTIONS` 键序与中文标签、`LEVELS`、`PROJECT_SUBCATEGORIES`、`NAV_TEXT` |
| 对外文案 | `README.md` 与两份市场索引里的「1,085 字符」「8 个统一工具」 |

这一轮进场时先把真值全查了一遍：四处**当时全都一致**，12 处「1,085 字符」全是实测值。所以本轮没有修错，修的是「我们没法知道它对不对」。

这两件事的差别在失效方式上：口径漂移不会抛异常，只会让模型照着一句已经过时的话去调一个已改名的工具，然后拿到「工具不存在」。**它坏起来完全安静，只有一条会主动发问的判据才看得见。**

### 96.2 探针要真 import，不能抄名单

`tools/probe-words.mjs`（check-all 第 14 支，20 条判据）的真值全部来自 import：`createUnifiedTools({ bridge: stub, config: {} })`、`createAliasTools`、`BRAND_MAP`、`GUIDE_TEXT` / `NAV_TEXT`、`ACTIONS`、`LEVELS`、`PROJECT_SUBCATEGORIES`，外加从 `lib/macro/defs/*.js` 正则读出的声明名。

判据分四类，都是「两处独立来源必须相等」：

1. **工具面**：defs 文件数 = 装配数 = 8；声明名 = 装配名；名字唯一。
2. **品牌映射**：右值里的 `memory_*` 必须是真工具（指向不存在的名字 = 死指针 → 红）；左值旧名集合必须等于 `createAliasTools` 名单（改一处不改另一处 → 红）。
3. **手册口径**：动作枚举与键序、动作中文标签唯一、`memory_link` 的 action 与 schema 同序、非默认 mode 全覆盖、level 集合与子类顺序、status、体检六类。
4. **对外数字**：README 与两份索引里所有「X 字符 / X-character」必须等于 `GUIDE_TEXT.length`（融合前的对照值 `4,085` 按设计跳过）。

另加两条「不要说漏嘴」的判据：说明与手册里不许出现 `nebula_*` / `memory_find_similar` / `memory_home` / `meow-memory`；每条工具说明必须单行、非空、≤200 字。

关键点在于手册是**自然语言**：判据必须能从那句话里读出 token（`claimedGuideLengths`、`modeTokens`、`levelTokens`），而不是另抄一份名单去对照。抄名单只能证明「两份抄件一样」，证明不了「说明和代码一样」。

### 96.3 教训 60

> 跨文件的一致性不算「知道」——它只是「这次恰好一致」。
> 一致性要么被一条判据问出来，要么就在下一次改动里静默失效。

推论有三条：

- **同一事实出现在 N 处，就有 N−1 个可能漂移的地方**；能收成一处就收，收不了（手册得是给人/给模型读的散文）就必须有判据盯着。
- **判据自己也会写错**：这轮 `modeTokens` 没按 `|` 拆（漏 `bridge`）、`levelTokens` 的正则撞中文停住（level 集合永远缺半），两条都是假红。假红比漏红更坏，因为它教人忽略探测器——所以照旧配 6 条阴性对照。
- **口径探针必须只读**：它 import 装配函数但不执行任何工具，同时把 `DSH_HOME` 指向临时目录；「将来有人顺手加一句 execute」也不该碰到主人的生产记忆库。

### 96.4 验收

`probe-words` → 20 条 ALL PASS；`verify` A84 七条（真值从 lib 取、不抄名单、三组比对、死指针、阴性对照、失败置 exitCode）；`check-all` → 16 支全绿；`doctor` 补丁账本多一条。

### 96.5 边界

只动 `tools/`、`verify.mjs`、文档与版本号：不碰 vendor 运行时代码、不需要重启 DSH。判据只管「说过的」与「代码里的」是否一致，不管措辞好坏；以后工具数或手册字数变了，README 与两份索引必须跟着改——这条判据会红，而那是应该的。

## 97. 一条记忆只能靠「排得对」被读到（0.2.85）

### 97.1 分数算对了，顺序却把它丢了

0.2.84 收的是「同一句话活在四处」，这一轮收的是**引擎自己算错**。合成语料在真引擎上跑，看到的是这样一组数：查询「部署」，`importance=4` 的铁律 `bm25=0.957`、`importance=1` 的随手记 `bm25=1.033`——铁律排在后面；而两条的 `score` 是 0.96 与 1.03，说明分数**算对了**，但**输出顺序与分数无关**。

读代码才看清是两件事叠在一起：

1. `search()` 里 `importance` 只出现在一个条件里（`importance < 3` 时豁免时间衰减），**从不进分数**；同一个文件里的 `keywordHitScore()` 却早有 `impW = 1 + (importance-1)*0.25`。同一引擎两套口径。
2. `searchTool` 渲染前 `sort((a, b) => (a.updated_at ?? 0) - (b.updated_at ?? 0))`：**按创建时间升序重排**，把相关度顺序整个盖掉。旁边 `BASE_NOTE` 的「如果冲突，以最新的为准」说的是**内容取舍**，却被这一行实现成了**排序**。

这就是「相关性」这一类缺陷的典型形态：不抛异常、不返回空、分数还都在，只是**读到的第一条永远是最旧那条**。用户感受到的是「它怎么又翻出那条没用的」，而日志里一切正常。

### 97.2 两条改法，各带一条边界

```js
const impW = 1 + (impOf(docs[di]) - 1) * 0.25;          // 与 keywordHitScore 同口径
score: raw[di] * w * impW,                               // 加成
explain: { bm25, importance, importanceWeight, recencyWeight, score }   // 三因子齐

const reordered = [...hits].sort((a, b) => (b.score - a.score) || ((b.updated_at ?? 0) - (a.updated_at ?? 0)));
```

- **加成，不碾压**：0.25 一级，`importance=4` 最多值 1.75 倍。BM25 回答「说的是不是这件事」，重要度回答「这件事对你有多要紧」；后者越权就会变成「凡是重要的话都相关」——那是另一种噪声。所以探针里专门有一条：强相关只有一条时，两条 `importance=4` 的沾边条目必须进不来。
- **三因子齐才算可解释**：`score = bm25 × recencyWeight × importanceWeight`。少一个因子，读者就没法判断「为什么它排前面」，排序重新变黑箱——可追溯性不是多打一行日志，是每个乘数都露在回执里。
- **只改「先读谁」，不改「选谁」**：`blind/fresh` 的选条、`bumpHit` 的计入、层/状态/时间过滤全都没动。相关性调优最怕顺手把召回面改了，那是两件事。

### 97.3 教训 61

> 一条判据如果去掉被测改动之后仍然 PASS，它就是注释。

`probe-recall` 里两条阴性对照就是照这句话写的：把语料里所有 `importance` 抹平成 1，引擎自己就会把首条翻回随手记；按 `updated_at` 升序重排，首条又变成另一条。**同一个查询、同一份语料，只改被测的那一处，答案必须变**——这才叫判据有区分力。

推论三条：

- **「有结果」不等于「结果对」**：这两处缺陷都带着完整的分数与解释，任何「有没有报错」的判据都抓不到；相关性只能靠**固定语料 + 已知正确答案**去问。
- **语料本身是判据的一半**：如果随手记不比铁律新，或者措辞不比铁律更贴题，「按时间排」和「按相关度排」就分不开，探针会恒真。所以 R0 里专门断言了时间序。
- **改引擎要连着改账本**：`make-vendor-manifest.mjs` 重跑、`doctor` 的补丁账本加一条、`VENDOR.json` 的字节数与哈希跟着变；否则「副本被改过没人知道」这件事下一次就查不出来。

### 97.4 验收

`probe-recall` → 24 条 ALL PASS（实测铁律 `bm25=1.032` / 随手记 `1.478`，加权后 `1.81 ≥ 1.48`，抹平重要度后首条翻回随手记）；`verify` A85 七条；`make-vendor-manifest` 重跑（44 文件 / 1,713,134 B / `296da68a7b3ab2fc`）；`check-all` → 17 支全绿；`doctor` 补丁账本多一条。

### 97.5 边界

**这一版改了 vendor 运行时代码**（`vendor/meow-memory/lib/index.js`）：装进 profile 之后要重启 DSH 才生效，正在跑的进程里仍是旧行为——重启交给主人。改动范围只有打分与渲染顺序两处，召回面（选谁）与过滤逻辑未动。

## 98. 排对了顺序，还得决定「多弱就别端上来」（0.2.86）

### 98.1 断崖在第二名与第三名之间

0.2.85 解决「谁排前面」。这一轮问的是另一半：**排对了之后，前十条全都要端上去吗**。30 条合成语料（6 话题 × 5 条）在真引擎上跑，把分数换成相对榜首的比例，形状非常稳定：

| 查询 | 相对分数（降序） |
| --- | --- |
| `数据库连接池 上限` | 1.000 / 0.572 / **0.334** / **0.334** / **0.309** |
| `发布 索引 版本` | 1.000 / 0.572 / **0.363** / **0.292** / **0.233** |
| `星图 延迟` | 1.000 / 0.507 / **0.298** / **0.298** / **0.289** |

第 2 条是同话题的另一个角度（该留）；第 3 条起是「只共享一个词」的条目（不该留）。**断崖不在尾巴，在 0.5 到 0.35 之间**——所以「尾巴要不要收」不是审美问题，是有明确分界的事实问题。

顺带记录一条被否掉的方案：按 Jaccard 折叠相似结果。真 `tokenize` 复算下来，一字不差 1.000、同义改写 0.150、同主题不同角度 0.056；写时阈值 `DEDUP_THRESHOLD = 0.8` 几乎只抓逐字重复。**折不掉的东西，折叠不省**，只会多一层误伤。

### 98.2 改法：比例、保底、说出来

```js
const minRel = relRaw !== void 0 ? Math.max(0, Math.min(1, relRaw)) : 0.35;   // 0 = 看全量
const topScore = ranked.length > 0 ? ranked[0].score : 0;
const aboveFloor = minRel > 0 && topScore > 0
  ? ranked.filter((h, i) => i === 0 || h.score >= topScore * minRel)
  : ranked;
```

- **按比例、不按绝对分**：BM25 带 idf，榜首可能是 14.08 也可能是 1.81，绝对值没有可比性；相对榜首的比例才有跨查询的统一含义。
- **第一位保底**：`i === 0`。下限的语义是「别把弱相关端上来」，不是「一条都不给」。把「没有强相关」实现成零命中，等于又踩回「零命中冒充『记忆里没有』」那个坑。
- **收掉的要说出来**：`另有 N 条相关度不到榜首的 35%（最高的 X 分，榜首 Y 分）没展开…要看全量就传 min_rel=0。` 静默收窄是替用户判断「这些不重要」，而用户连被收掉了什么都不知道。
- **越界不当作查不到**：`5` → `1`、`-1` → `0`，尾注写「不在 0–1 里，这次按 X 处理」。

参数面一共五处：vendor schema、macro 三处白名单（`pick()` 少一个键就静默丢参）、macro schema、三语文案。

### 98.3 教训 62

> 判据把「正当新增」也钉成红，等于在教人「红了就改判据」。

这一轮加一个参数，`verify` 一次红了 26 条，根因只有一处：`tools/criteria.mjs` 的 `vendor-search-param` 把 note 拼装**整行逐字**钉住（`[plain, levelNote, scopeNote, statusNote, daysNote, kNote, cmNote]`）。多加一个 `relNote` 就红，然后「清单仍全绿」的十几条断言跟着一起红。

更值得记的是修完之后还剩 14 条红，全带同一个 detail：`样板红 vendor-search-param`。判据变严之后，**判据自己的 `good` 样板不达标了**——样板里也抄着同一行。也就是说：一条判据有「被测代码」和「自测样板」两份契约，改一份不改另一份，红的是自测那条。

放宽的写法是「七个变量都在、顺序不变、后面可以接着加」：

```js
/\[plain, levelNote, scopeNote, statusNote, daysNote, kNote, cmNote(?:, \w+)*\]\.filter\(\(s\) => s\.length > 0\)\.join\("\\n"\)/
```

这次刻意**不加新判据 id**（仍 45 条），把下限的五件事并进同一条「检索参数给错了各说各的」里。理由不是省事：判据清单的条数被十几处断言引用，加一条要改十几处，而改的时候「四十五条」这些字会把注意力从「判据对不对」引到「数字对不对」。

推论三条：

- **判据要钉语义，不要钉字面**：钉「七个 note 都拼进去了」是语义；钉「这一行必须与今天这七个字一模一样」是字面，下一次正当新增就红。
- **严格度升级要连样板一起升**：判据、样板、阴性对照是一套三件；只升一件，红的是自己。
- **红 26 条时先找那一条根因**：26 条里 25 条是「清单仍全绿」的连带断言，它们的 detail 都是同一句。先按 detail 分组，再看组内第一个失败，比逐条查快一个数量级。

### 98.4 验收

`probe-recall` → 30 条 ALL PASS（R5 七条，含「传 0 尾巴回来」「0.99 仍留一条」「5 被夹回 1」）；`verify` → 918 条（A86 五条）；`probe-toolsize` 88,918 B ≤ 92,000 B；`probe-words` ALL PASS；`make-vendor-manifest` 重跑（44 文件 / 1,716,149 B / `ca708376bf2b55a7`）；`check-all` → 17/17，1,763 条，120.4s。

R5.6 也留了个小教训：一开始用「部署 备份」验「不误伤」，但随手记不含「备份」、本来就低于 0.35，判据假红。**阴性对照要选在没有被测机制时也成立的样本上**，否则验的是机制而不是对照。

### 98.5 边界

**改了 vendor 运行时代码**（`vendor/meow-memory/lib/index.js`），装进 profile 后要重启 DSH 才生效，重启交给主人。只改「端上来几条」：选谁（层 / 状态 / 天数 / 归档）、`blind`/`fresh` 分段、`bumpHit` 计入都没动；`min_rel: 0` 完全回到 0.2.85 的行为。备份：`D:\备份\20261120-012720-macro-fusion-0286-min-rel`（16 文件，从 `a37af1d` 导出的改动前状态，还原见 `MANIFEST.txt`）。

## 99 合并只做加法（0.2.87）

### 99.1 「合并」其实是「覆盖」，只是名字好听

`memory_remember` 撞上重复内容会合并。实现是一句 `db.update(level, merged.id, patch)`，`patch` 里带着 `content` 和 `keywords`——所以「合并」的真实语义是**用这次写的参数把旧条目整条盖一遍**，而不是「把新信息并进去」。

实测三处静默损失：旧关键词被整个换掉（`[部署,备份,铁律]` → `[上线]`，按旧词再也搜不到）、归属被搬到另一个项目（甲 → 乙，回执不提）、更短的新内容把旧细节吃掉（78 字 → 67 字，尾句「也不许只备份配置文件」消失）。

回执承认了第一半（「原条目的内容被替换成这次写的内容」），但对关键词与归属一个字没说。**「说了一半的真话」比不说更危险**：读到「替换了内容」的人会以为别的都没动。

### 99.2 改法：加法、不搬、变短不换、留出口

- 关键词 **取并集**（旧的永不被删）
- 归属 **不搬**：冲突时保留旧值，并说明「要换归属先归档再重写」
- 内容 **变短且非逐字默认不换**（`len` 变小 且 `sim < 0.98`）
- `overwrite: true` 是**唯一的**「我确实要压缩」出口
- 回执逐项报账：并了哪些词、importance 怎么取、内容换没换、归属为什么没改

`applyMerge` 放在工具字面量外——`probe-toolsize` 按源码切片量 17 个工具字面量的体积，说明书式的长句不该算进预算（这次实测：写在字面量里 91,600 B / 预算 92,000 B，搬出去 88,453 B）。

### 99.3 教训 63：**「默认更安全」必须自带出口，否则它就是「改不动」**

一个只防不许改的默认值，会比它要修的那个 bug 更难用：用户想压缩一条啰嗦的记忆，发现怎么都改不动，只能归档重写（还可能忘了重写）。

所以「更保守的默认」必须同时给三样东西：**一个明确的出口**（`overwrite: true`）、**一句说明默认改了什么**（回执报账）、**一个能红一次的对照**（probe-merge 的 M7：旧写法确实会丢东西）。缺任何一个，保守默认就只是把「静默损坏」换成了「静默拒绝」。

推论：
- 凡是要「保护某些数据」的默认行为，都要先问「那正当的修改怎么办」；
- 保护逻辑与业务逻辑分开写（`applyMerge` 独立成函数），保护范围才看得清——否则半年后没人知道这段 `if` 到底在护什么；
- 判据要成对：一条证「保护生效」，一条证「出口可用」，一条证「旧行为确实会坏」。

### 99.4 验收

`probe-merge` → 25 条 ALL PASS（M0–M8，含旧写法会丢关键词/截短内容的阴性对照）；`verify` → 925 条（A87 六条）；`probe-toolsize` 88,453 B ≤ 92,000 B；`probe-words` ALL PASS；`make-vendor-manifest`（44 文件 / 1,719,779 B / `43defb15f04df7fe`）；`check-all` → 18/18，1,795 条，122s。

探针自己也留了个教训：M7 起初和 M3 用同一层同一内容，两次写入被合并成一条，「自己和自己比」恒真。**阴性对照的语料必须与受测语料在存储上隔离**——合并/去重本身就是按内容判的，光靠「措辞不同」隔不开。

### 99.5 边界

改了 vendor 运行时代码（`vendor/meow-memory/lib/index.js`），装进 profile 后要重启 DSH 才生效，重启交给主人。只改合并分支：`similarity`、阈值 0.8、同层比较、`markWritten`、命中计数都没动；跨层同内容仍写两份（`fact`/`lesson` 各一条），只记录不修。备份：`D:\备份\20261120-022820-macro-fusion-0287-merge`（17 文件，从 `HEAD` 导出的改动前状态，还原见 `MANIFEST.txt`）。

## 100 同一句话不端两遍（0.2.88）

### 100.1 合法的重复，也是重复

0.2.87 把「合并」修成只做加法，顺手记下一条没修的：写入去重只比**同一层**（`db.list(level, ...)`），所以同一句话既记 `fact`、又记 `lesson` 会真的落下两份。

这不是 bug 意义上的「重复」——层各有分工（事实 vs 教训）本来就是设计。问题在**检索侧**：两条内容逐字相同、分数也完全相同（实测 1.280 / 1.280），并排端出来。读的人要把同一段字读两遍，并且重复的那条会**吃掉 k 名额**，把真正相关但分数略低的条目挤出榜单。全程没有任何提示。

判断标准很朴素：**重复的代价不是占磁盘，而是占读者的注意力与 k 名额**。所以修的位置不在写库，而在「端上来之前」。

### 100.2 两处，一处点名一处折叠

- **写侧只点名**（`crossLevelDupe` + `crossLevelNote`）：扫别的层，撞上 ≥80% 重复就照样写下，但回执点名「另一层已有几乎一样的条目（fact 0mwnwfhx，重复度 100%）」，并给两条出路——归档其中一条，或把措辞写开。**不硬拦**：拦掉就是替主人决定「这件事只能记一次」，而事实与教训本来可以是两条。
- **读侧折叠**（`foldNearDupes`）：按分数顺序保留，后面的逐字重复计入 `folded`；尾注报「另有 N 条内容几乎一样」并给 `dedupe: false`。

关键细节：`blind` / `fresh` 都从**折叠后**的 `unique` 切。如果照旧从 `aboveFloor` 切，折叠的结果就只是「少端一条」，空出来的名额白扔——那是假折叠。

### 100.3 折叠的门槛为什么敢设 0.8

`similarity` 是 Jaccard，实测口径：一字不差 1.000、补标点 1.000、同义改写 0.150、版本号不同 0.667、数字不同其余同 0.500、同主题不同角度 0.056。

0.8 落在「逐字级重复」与「同义改写」之间的巨大空档里，所以只会折「同一句话被写进两层」这种，同义改写不会被误折（`probe-dup` 的 M6 钉的就是这条）。**阈值敢设高，是因为相似度分布本身有明显的两极**——这也是 0.2.86 用同一套分数找 `min_rel` 断崖的同一个观察。

### 100.4 教训 64：**「另存一份」和「重复一遍」是两件事，修的人要分清哪一侧出问题**

一开始的判断是「跨层重复是数据问题，应该去写侧拦」。但层是用来分工的：`fact` 记「是什么」、`lesson` 记「怎么吃亏的」，同一件事在两层各留一句是**有用的冗余**（各自被不同查询召回）。真正没道理的是**同一次检索里把两句一起端上来**。

所以写侧只做提示（有信息量、不改变结果），读侧才做动作（折叠），并保留 `dedupe: false` 的出口。若一开始就去写侧硬拦，会把一个「读侧体验问题」误修成「写侧功能缺失」——这类错在融合层特别容易犯，因为两层都是我们自己的代码，看起来哪儿都能改。

推论：
- 判断一个重复该在哪一侧修：问「它是不是在某个使用场景下是正当的」——正当就留数据、修呈现；
- 折叠这类「呈现层的收窄」必须带出口（`dedupe: false`），否则等于替使用者删结果（0.2.87 教训 63 的同一条）；
- 折叠必须在**名额分配之前**做，否则收窄没有收益，只剩损失。

### 100.5 验收

`probe-dup` → 23 条 ALL PASS（M0–M8，含 `dedupe: false` 回两条的阴性对照、M6 不误折同义改写、M7 同层仍走合并）；`verify` → 933 条（A88 八条）；`probe-toolsize` 预算内；`probe-words` ALL PASS；`make-vendor-manifest`（44 文件 / 1,723,154 B / `aeb1fbd3acd8da42`）；`check-all` → 19/19，1,828 条断言，124s。

### 100.6 边界

改了 vendor 运行时代码，装进 profile 后要重启 DSH 才生效，重启交给主人。写侧只加提示、不改写入结果；折叠只在 `memory_search` 里生效，不删数据、不动 `memory_dream` / 面板 / `findSimilar` 的口径。已知仍未统一：写入侧 Jaccard 与 `findSimilar()` 的 TF cosine 是两套相似度；`memory_find_similar` 无阈值。备份：`D:\备份\20261120-024623-macro-fusion-0288-dedupe`。

## 101 同一把尺子量两边（0.2.89）

### 101.1 「相似」这件事，工具自己没对齐过

`memory_find_similar` 的语义是「这条跟库里哪些像」。实测发现它在两个地方没对齐，都不报错：

- **尺子不对齐**：基准取 `content`，候选取 `docText`（title + 正文 + keywords）。关键词是索引的一部分，候选可以用它得分、基准却不带它——只沾基准关键词的候选实测 0.000 分，被 `s <= 0` 直接丢掉，看起来像「库里没有」。
- **身份兼职去重**：候选过滤挂着 `r.source_session !== sessionId`。它想避免「把同一条重复端」，但 `seen` 已经在做那件事；这条过滤实际效果是把**本会话刚写的全部**排掉，于是「我刚记了三条，谁跟谁像」这个最自然的用法得到 0 命中，note 还说「等下一次会话再问」。

### 101.2 改法

1. 两侧都走 `docText`（基准、候选同一段文字），`noTarget` 兜底同样用 `docText`。
2. 候选只排除「自己」和 `seen`；会话身份不再参与去重。
3. 放开候选的代价必须付对价：命中里若有本会话刚写的，尾注明说「这是刚才那几条，不是库里积累的旧账，别当成已有依据」。
4. 空结果文案改成实际情况（「这一轮端过的都排除了」/「换基准或把 k 给大一点」），不许暗示「库里没有」。

### 101.3 教训 65：「去重」和「隔离」不是一回事，用身份兼职做去重会关掉工具

一个过滤条件写着「排除重复」，实际排除的是「一整类身份」——这类错最难发现，因为它看起来像在防什么，而防的东西早就有人管了（`seen`）。

推论：
- 写过滤条件前先问「这个条件排除的**是不是我想排除的那件事**」，还是排除了一整类（会话、来源、层级、时间窗）；
- 一个职责只能挂在一个机制上：`seen` 管「这次别重复端」，身份只管身份；
- 同一个工具内部，两边的输入必须**同构**——基准用什么字段，候选就得用什么字段，否则分数不可比，而且这种不可比会伪装成「没有相关条目」；
- 每次「放开一批候选」都要同时准备一句「这批候选为什么可能不该被当成依据」——放开和下注是一件事。

### 101.4 验收

`probe-similar` → 17 条 ALL PASS（含换会话不点名 fresh、正文口径零命中的阴性对照）；`verify` → 939 条（A89 六条）；`probe-toolsize` 预算内；`probe-words` ALL PASS；`make-vendor-manifest` 44 文件 / 1,725,569 B / `cd8648ab8c8db91d`；`check-all` → 20/20，1,852 条断言，125s。

### 101.5 边界

改了 vendor 运行时代码，装进 profile 后要重启 DSH 才生效，重启交给主人。本轮没加阈值、没改 `findSimilar` 的算法、没动 `memory_search` 的折叠。写入侧 Jaccard 与 `findSimilar()` 的 TF cosine 仍是两套相似度，本轮只保证同一工具内部两侧一致。

## 102 报两个数，排一个序（0.2.90）

`memory_find_similar` 一直只报一个 `similarity`。它其实是 cosine：对长文宽容，回答「话题有多近」。
而写侧 `memory_remember` 判「是不是同一句」用的是词集 Jaccard，80% 才合并。两把尺子量同一对内容：

- 近重复（改几个字）：Jaccard **81%** / cosine **0.944**
- 长条目里嵌着一模一样的短句：Jaccard **35%** / cosine **0.715**
- 同话题不同结论：Jaccard 2% / cosine 0.259

只有第一行是「这句记过了」。而读者手里只有 cosine，看到 0.715 就会得出结论「这句话早就记过了」——
这正是 0.2.88（跨层重复）和 0.2.89（同一把尺子）修完之后，**同一个盲区换了个位置**又冒出来：
上两轮修的是「库里存了两份没人说」，这一轮是「一条不是重复的东西被当成重复」。

### 102.1 为什么不是「换一把尺子」

最直接的修法是让 `findSimilar` 改用 Jaccard 排序，两把尺子并成一把。那是错的：
cosine 对长文宽容，在**排序**这件事上是优点——一条 300 字的长记忆只要主题对，就该排在短条目前面。
换成 Jaccard，长而相关的记忆会被整体压下去，0.2.89 修好的相关性当场又坏掉。

所以这一轮的取舍是：**报两个数、排一个序**。`similarity` 继续当唯一排序键，新增 `repeat` 供人判断性质。
多报一个数不改变任何既有行为，也不给不看的调用方添负担（新增字段，老读者忽略即无感）。

### 102.2 输入必须同源

第一版我让 `repeat` 跟着 cosine 一起走 `docText`（title + 正文 + keywords）。实测立刻暴露：
同一对内容写侧报 **81%**、读侧报 **71%**——差的正是几个关键词。

因为写侧合并判的是 `similarity(r.content, content)`，**纯正文**。要让读者能把两个数对上号，
`repeat` 也只能比正文：

```
function findSimilar(target, docs, k = 5, targetContent) {
  const repeatSet = new Set(tokenize(targetContent === undefined ? target : targetContent));
  ...
  repeat: Math.round(overlapOfSets(repeatSet, new Set(tokenize(d.content ?? ""))) * 1e3) / 1e3
}
```

调用点传 `findSimilar(docText(found.row), docs, k, found.row.content)`：
cosine 用 docText，repeat 用正文。两个数各有各的输入，各自说得清。

顺带把 Jaccard 收成一处实现 `overlapOfSets(sa, sb)`，`similarity()` 直接复用——
写侧和读侧以后再也不可能各漂各的。

### 102.3 两种误读，两句校准

报了两个数，还得说清哪个数管什么，否则读者照样挑顺眼的那个看。两句话，条件互斥：

- `similarity >= 0.5 && repeat < 0.5` → 「看着像、其实不是同一句：相似度 ≥0.50 但逐字重复度不到 50%（写侧要 80% 才算重复）——长条目里嵌了一句，或者只是同话题」
- `repeat >= 0.8` → 「逐字重复度 ≥80%：写侧会判重复，多半是同一句话分别存进了两层，用 memory_update 把其中一条 status 设 archived」

第一版判据写的是「相差 30 个点」（`similarity - repeat >= 0.3`）。实测长文嵌一句是差 36 个点能抓到，
但轻度重叠可能只差十几个点、却同样不是同一句——**绝对差**在这里不如**绝对门槛**贴近要说的事：
「逐字连一半都对不上」比「相差 30 点」更像人话，也不会随 cosine 的量纲漂移。

### 102.4 教训 66：一个概念两把尺子时，先把两把都摆出来，别急着合并

这轮差点犯的错是「统一成一把尺子」。真问题是：这两把尺子量的**不是同一个概念**——
cosine 量「相关性」，Jaccard 量「同一性」。相关性要宽容（不然长文全被埋），同一性要严格
（不然近重复漏合并）。它们本来就该是两个数。

三个推论：

1. **发现两个数不一致，先问它们量的是不是同一件事**。是同一件事 → 合并实现；不是 → 两个都报，并说清各自管什么。
2. **多报一个数必须与既有口径同源**。新增 `repeat` 若自己另定输入（含 keywords），它就成了第三把尺子，
   比不报更糟——读者会拿它跟写侧回执对号，对不上就是新的「安静的错」。
3. **收窄呈现要带出口**（教训 64/65 的同一条）：校准句只说「这条大概不是重复」，不说「所以不用看」；
   真要判定，`memory_update` 归档一条 / 传 `dedupe: false` 看全量，路都留着。

改的是 vendor 运行时代码，装进 profile 后要重启 DSH 才生效。

`vendor/meow-memory` 44 文件 / 1,729,945 B / `8ee925478ab6c9f7`。
