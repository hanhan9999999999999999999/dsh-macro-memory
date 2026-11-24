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

## 103 同一个名字，两种算法（0.2.91）

0.2.90 那轮刚立下「一个概念两把尺子就两个都摆出来」，这一轮撞上它的反面：**面板上的「相似」和工具里的
「逐字重复度」共用一个词，量的却不是同一个量**。而且面板那个数会顶格——`memory_admin(action="hygiene")`
打出 `疑似重复（1）… （相似 1）` 时，同一对内容 `memory_search` 报的是「相似度 0.624（逐字 0.42）」，
写侧 `memory_remember` 根本没判重复。

实测两对内容（同一个库里）：

| 场景 | 全文逐字 | 写侧回执 | 面板「相似」 |
| --- | --- | --- | --- |
| 近重复（改几个字） | 80.6% | 「重复度 81%」 | 1 |
| 共享前言 + 两个不同核心 | 42% | 不判重复 | 1 |

第二行是这一轮真正的坑：面板说 100%，工具说四成，写侧说不重复。**照着面板去归档，就是误删一条独立记忆。**

### 103.1 根因：近似算法换了量纲，名字没换

星图要扫全库，不能逐对比全文，于是每条记忆只留最稀有的 24 个词当签名（`vendor/dsh-memory-nebula/lib/host/graph.js`
的 `const SIG_N = 24`；只算 df≥2 的词，`c <= 1` 直接跳过；门槛 `hyJaccardAtLeast(..., 0.86)`）。
库小的时候，这 24 个词里有一大半是两边共有的高频短语，交集/并集接近 1 —— **不是算错了，是它量的那个量
在样本不足时退化了**。签名 Jaccard 在二十几条的库上，几乎不携带「是不是同一句」的信息。

而写侧 80% 合并判据、工具 `repeat`，量的是**全文词集 Jaccard**。三个数字同名不同物，跨工具读的人无从分辨。

### 103.2 选择：不重算，只把尺子说明放进抬头

第一反应是在融合层重算全文 Jaccard。做不到也不该做：融合层只拿到星图渲染好的文本
（`疑似重复（2）`、`A ⇄ B（相似 1）`），没有两条的正文；真要重算得进 `host/graph.js` 的扫描热路径
（`probe-graph` 一轮 97 秒），为一句尾注加一次全库扫描不划算。

所以 0.2.91 做的是**口径校准**：`lib/macro/defs/admin.js` 里 `hygieneRulerNote(body, args)` 在
「真列出了对子」（`text.includes('（相似 ')`）且 `kind` 是 `hygiene` 时，往尾注补一句——这个 N 是稀有词签名估算、
每条约 24 个稀有词、跟「逐字重复度」不是同一把尺子、库里条数少时常顶到 1 而全文逐字可能只有四成；
并指路：判「同一句存两层」看 `memory_search` 的 `repeat`（≥0.80 写侧就判重复），判「两条在说同一件事」看面板这个数。

三个约束顺带一起守：

1. **没对子不说**。空体检抬头只该有「没排上来」，不该挂一段算法说明。
2. **不顶掉既有尾注**。graph 分支从 `note: stray` 变成 `note: [ruler, stray].filter(Boolean).join(' · ')`，
   `call` / `local` 两条分发原样不动。
3. **文案里的常量跟实现绑死**。A91 直接对着 `graph.js` 断言 `const SIG_N = 24` 与 `0.86`——nebula 将来调参，
   自检先红，不会留下「文档说 24、代码是 32」的第二处安静错误。

### 103.3 教训 67：近似算法给出的数，不再是原来那个量

「优化了性能，结果不变」是个危险的默认。真实情况是：为了让扫描跑得动，你换了采样、换了权重、换了一道门槛，
**输出的数字仍然叫 Jaccard，但它量的已经是别的东西**。跨工具沿用同一个名字，等于把两个量当同一个用。

三个推论：

1. **近似值必须自带口径**。凡是「为了跑得动」而算出来的数，展示时就得能说清它近似了什么、什么时候会失效
   （这里是「库里条数少时顶格」）。没有这句，读者只能假设它是精确值。
2. **面板与工具上同名的数字必须能对上号**。对不上时，两条路只有一条是对的：要么统一实现（0.2.89 那把尺子），
   要么显式区分并在两边互指（这一轮）。**默认让读者自己猜是最坏的第三种。**
3. **算不出第二把尺子时，至少指路**。0.2.90 的做法是「两个都摆出来」；摆不出第二个时，就把「第一个是什么、
   第二个该去哪儿看」写清楚。收窄呈现必须带出口（教训 64/65/66 同一条）。

改的是融合层文案与探针，没动 vendor 的签名算法、没改 dup 门槛、没改面板截断；装进 profile 后要**重启 DSH** 才生效。

`vendor/` 未改动，两棵 vendor 树指纹不变：`vendor/meow-memory` 44 文件 / 1,729,945 B / `8ee925478ab6c9f7`。
### 103.4 教训 68：时间戳别手工拼，校验别靠余量

这一轮发版还撞了一个跟「近似值」无关、但同属「安静的错」的坑：时间戳由 PowerShell 的
`Get-Date -UFormat %s` 取，在这台 +08:00 的机器上它多算了 8 小时；而 `check-market` 的合理性判断是
`<= now + 86400`（一天容差）。两个「差不多」叠在一起，市场索引就带着一个 8 小时后的
`publishTimestamp` 上线了——详情页会把「更新时间」写成未来，而自检全绿。

两条推论：

1. **时间戳用会算错的东西去拼**，等于把错误藏进数据。取 epoch 只认一种来源（`Math.floor(Date.now()/1000)`），
   别在 shell 里转一手；跨时区转换的活儿交给库，不交给格式化字符串。
2. **校验的容差要能挡住「差一个时区」这个量级**。24 小时的松量放过了 8 小时的错；容差收到 5 分钟，
   既容得下发布耗时，也挡得住时区错误。**能让错误过关的阈值，等于没有阈值。**

顺带记下这一轮推送的两个技术事实（Git Data API 直推，`git push` 在这台机器上连接被重置）：
GitHub 的提交对象会把作者/提交时间**归一成 UTC（+0000）**，把消息**末尾换行去掉**——想让远端 SHA 与本地
逐字节相同，本地提交就必须是 `+0000` 且消息不带末尾换行（`git commit --cleanup=verbatim`）。
## 104 尺子算出来了，却没有递到要用的那只手上（0.2.92）

0.2.88 起，写侧就知道「同一句话存了两层」——`memory_remember` 会点名另一层那条几乎一样的条目，
重复度是全文词集 Jaccard（`DEDUP_THRESHOLD = 0.8`）。0.2.90 又把这个数搬到了检索结果里（每条命中一个 `repeat`）。
可 **dream**——全库唯一回头看旧条目、决定哪条该合并、该归档的地方——拿到的仍然只是一张清单：
哪两条其实是同一句话，全靠模型自己扫字面比。

于是同一个库里存在两种世界：写入路径知道「这两条是同一句」，整理路径不知道。判据有了，但没递到要用的手上。

### 104.1 改动：清单末尾多一段「逐字重复对」

`buildDreamMessage` 选完本组的行后，把这一组正文两两比一遍（`dreamDupPairs`，复用同一个
`overlapOfSets`、同一个 `DEDUP_THRESHOLD`），≥80% 的对子按重复度降序取前 5 对，单独成段：

```
【逐字重复对 1 对】（下面这两条正文的逐字重复度 ≥80%，与 memory_remember 判「重复」是同一把尺子）：
- 0mwo20yqb ⇄ 0mwo20yqt  0.81 · fact ⇄ lesson
处置：这多半是同一句话分别存进了两层——保留信息更全、层级更合适的那一条，另一条用 memory_update 把 status 设 archived。
```

三条约束同时守住：

1. **没有对子就一个字不加**（`dupBlock` 空串）。整洁的清单不该被「本组没有重复」占一行。
2. **门槛从常量算，不写死在文案里**（`String(Math.round(DEDUP_THRESHOLD * 100))`）。改门槛时不会出现
   「文案说 80、判的是 90」这种第二处安静错误——0.2.91 刚为同类问题写过校准。
3. **顺手把「相似度高」与「重复」分开说**。dream 里最容易被误用的正是这两个词：只被 cosine 拉高、
   逐字没到 80% 的，不算同一句——处置句后半段明说「相似是同一话题，repeat 才是同一句」。

### 104.2 顺手修：短 id 撞车（同一个 id，两种解析）

id 开头是 base36 时间戳，**同一批连写两条，前 8 位常常一模一样**。回执、清单、重复对都只印 `id.slice(0, 8)`：

```
- 0mwo1yus ⇄ 0mwo1yus  0.81 · fact ⇄ lesson
```

读起来是「一条自己和自己重复」。而拿它去 `memory_update` 更糟：`MemoryDb.update` 遇到歧义前缀
直接 `return false`（`if (matches.length > 1) return false`），外层回执却写成「未找到该记忆」——
**存在的东西看起来不存在**，这正是 0.2.91 教训 67 的同一家族：同一串字符，两种解析。

两处改：

- 清单内 `uniqueShortIdsAmong(rows)`：从 8 位起，与本清单任何另一个 id 撞前缀就往下延，一次算好。
- 跨层回执 `uniqueShortId(db, level, id)`：按层确认唯一（`update` 也按层解析，所以本层唯一就够）。

**只延到「足够区分」为止，不是一律印全 id**——短 id 的意义是能一眼扫、能照抄，长到 39 位就没人读了。

### 104.3 教训 69：判据算出来了，不等于它到了需要它的地方

功能齐全不等于口径统一。每加一个量（一个分数、一个判据、一个计数），都要问一句：
**还有谁该看这个数，却没在看？** 0.2.88 的跨层重复只在写入路径上喊了一声，dream 这一路就一直是哑的；
如果只在写入路径测，永远测不出这个缺口——它不在「算错」那一类，在「没送到」那一类。

推论：

1. **判据要放在「读的人能看到的地方」**。写侧回执是给写的人看的，整理侧清单是给回头看的人看的，
   两者不是同一批读者。
2. **阴性对照要覆盖「没有该出现的东西」**。D5 那条（只有一条的窗口不出现这一块）比 D1 更重要：
   缺了它，一段「永远出现、只是内容为空」的块能一路绿下去。
3. **短 id 的唯一样性属于显示契约**。凡是让人「照抄去改库」的标识，都必须在**打印它的那个作用域里**唯一，
   而不是「理论上 UUID 唯一」——8 位截断之后，理论就失效了。
## 105 分片是为了省 token，分片也让判据只看得到自己那一片（0.2.93）

0.2.92 把「逐字重复度」这把尺子递到了 dream 手上。递是递到了，可递的姿势有问题：
`dreamDupPairs(roundRows)` 只在**本轮的行**里两两比，而 `collectDreamRounds` 把整理范围切成了两次独立的
消息——`atomic`（project / fact / lesson / rules / soul / user，按 project 分组）一次，`topic` 一次。

于是同一句话一条记成 fact、一条记成 topic 时，两条从来不在同一轮里，重复对永远算不出来：

```
写侧 crossLevelDupe：扫全部层 → 当场点名「另一层已有几乎一样的条目（重复度 100%）」
dream 重复对：      只看本轮   → 一个字不提
```

写侧能抓、整理侧抓不到，这不是算力问题，是**视野问题**：判据需要的两条，被片边界分到了两个片里。

### 105.1 改动：对子在整窗口算，只由「先出现的那一轮」说

`rounds` 本来就是整个整理范围，直接从里面把全部行捞出来算：

```js
const allRows = rounds.filter((r) => Array.isArray(r.groups)).flatMap((r) => r.groups.flatMap((g) => g.rows));
const dupPairs = dreamDupPairs(allRows).filter((p) => dreamPairOwner(rounds, p) === idx);
const shortOf = uniqueShortIdsAmong(allRows);
```

`dreamPairOwner` 是纯函数：返回这一对在轮次里**先出现**的那一轮下标（没有则 -1）。只由那一轮负责展示，
理由有三，都写下来了而不是「本来就这样」：

1. **一对话只说一次**。两轮各印一遍，token 白烧一份，更要紧的是模型会以为库里有两对重复。
2. **清单仍然短**。分片的初衷（每条消息别太长、模型别晕）没被破坏——只是把「该在哪说」从「在哪算」里拆开了。
3. **短 id 的唯一性跟着扩到 `allRows`**。跨轮次印出来的两个 id 如果在各自片内唯一、跨片撞车，那还是同名。

配对的那条不在本轮时，行尾标「（另一组）」（`lbl3("dream.dup.crossRound")`，三语齐备）：

```
- 0mwo37jb ⇄ 0mwo37jc  1.00 · fact ⇄ topic（另一组）
```

### 105.2 半边的对子最容易被忽略，所以指引也要说

跨轮次对子有个真实的误读风险：模型在 atomic 那轮看到「fact ⇄ topic（另一组）」，而清单里只有 fact 那一条，
很自然地想「另一半不在我手上，跳过」。所以这一版把三语 `dream-atomic.md` / `dream-topic.md` 的处置句都补上：
标着（另一组）说明另一条在另一次整理里，**照样按同一处置办，同一对只处置一次**。

判据送达之后，还要送达「怎么用它」——0.2.91 的「相似 N」就是这个坑的另一个版本：数字对了、说法错了，
读者照样会按错的做。

### 105.3 教训 70：凡是按片喂给模型做判断的地方，先问「判据需要的两样会不会被分到两个片里」

分片（分轮次、分文件、分页、分窗口）永远是省 token 的手段，它从来不是无损的：它把「全局视图」换成
「局部视图」，而**任何一个需要两样东西才能下的判断**，都可能在边界上失效。

推论：

1. **在片边界之前算完，别留到片里算**。对子、冲突、前后继关系这类「成对」的判据，属于全局量；
   片里只做「展示 + 处置」，不做「有没有」。
2. **展示位置要显式决定**，不能默认「每片都印一遍」。默认会产生重复噪音；而重复噪音会让模型
   把一对当成两对——比不印更糟。
3. **片段里的半截信息必须自带上下文**。「（另一组）」是三个字，但它把「你看到的是半边」这件事说清楚了；
   不说，模型会按「只有这一条」去处置。
4. **阴性对照要换一个维度**。0.2.92 的 D5 验的是「没有对子时不出现」；这一版的 D9 验的是
   「同窗口里无关的那条不会被凑成对子」——同一个开关的两种错法（多印 / 乱印）必须各有一条。

## 106 同一句的第二个副本会缩水，尺子要量缩水后的形状（0.2.94）

### 106.1 三条取舍

**一、为什么在 dream 里做，不在写侧做。** 覆盖度判据（短的那条整句落在长的那条里）比 Jaccard 松得多：一条长 topic 只要引用了某条旧结论的整句，就会被判成重复。写侧拿它拒收，误伤面覆盖「引用、举例、复述」这些正常写法；而 dream 是盘点现场，判错一次的代价是模型多看一眼、决定不合并，不是一条记忆写不进去。**校验的松紧应当跟着「错了以后谁来兜」走**：写侧错了没人兜（拒收就是拒收），dream 错了有模型兜（它看得见两条正文）。

**二、为什么第一道闸用绝对词数。** 见 9.100.5：长度比 0.16 是真实案例的常态，拿它当下限等于把靶子挡在门外。绝对词数（≥8 个不同的词）挡的是另一件事——「短的那条自己没有信息量」，这才是真正的假阳来源。

**三、为什么和 ≥80% 的重复对互斥。** 两条都命中时模型会看到同一对出现在两个块里，处置冲突（一块说「保留一条归档另一条」，另一块说「合成一条」）。互斥让每个对子只有一种处置路径，也让「详写对」这一块的信噪比可解释：它列出来的每一对，repeat 必定 <80%。

### 106.2 覆盖度不是万能尺

覆盖度只回答「短的那条在不在长的那条里」，不回答「两条谁更新」。所以文案里不能写「保留长的那条」，只能写「保留信息更全的那条」——长文可能是一周前的旧版本，短文才是刚改过的结论。这也是判据与处置必须分开写的理由：判据只负责指出候选，处置要留给看得见内容的人。

同样地，覆盖度会把「引用了整句但结论相反」的两条凑成一对。这一轮不处理（模型看得见「结论相反」，它会自己判断），但如果以后要自动化处置，就必须给对子加一条方向性检查（分歧词、否定词），否则「合并」会把相反的结论合成一条。

### 106.3 教训 71 与三条推论

教训 71（见 9.100.5）：**门槛要按最坏形态定，不能按最好形态定**——同一把尺子量不了被折叠的东西时，问题在尺子，不在门槛高低。

推论：

1. **尺子要成对出现，并且互相说明。** 现在 dream 里有两块：≥80% 的逐字重复对、≥90% 覆盖度的详写对。文案必须各自说清「我是哪把尺子、为什么另一把没抓到你」——只给结论不给判据，模型会自己去猜，猜错就归档错。
2. **同一个数字不兼职。** 长度比只守「差不多长就别进这一块」，词数只守「短的那条有没有信息量」。一个阈值承担两个语义时，改一头必然伤另一头。
3. **阴性对照要成对进探针。** E4 同时验「无关那条没被凑进来」和「这一窗没有逐字重复块」——只验前者，互斥失效时探针还是绿的。

## 107 判据说「是同一件事」，处方还要说「合并不丢字」（0.2.95）

### 107.1 半个判断

0.2.94 之后 dream 能认出「一条短摘录 + 一条长详写」是同一件事了。可它认出来之后只说一句「合成一条」，剩下的交给模型。而「≥90% 覆盖」这句话本身就在提示：短条还有最多 10% 的词没进长条。模型面对一条 0.93 的对子，最省 token 的动作是「留长的、归档短的」——那 10% 就随着归档消失，而且没有任何痕迹说明丢过东西。

所以我们这轮不改尺子，改**处方**：每一对下面多一行，把短条里长条没有的词按词长降序点出来（最多 6 个）；一个都没有时也不留白，直接说「这次合并没有东西要补」。判据负责「是不是」，处方负责「怎么做才不丢」，两件事不能合并成一句话。

### 107.2 为什么是「点名具体的词」而不是「提醒注意细节」

- 「注意别丢细节」是一句无法核对的话：模型自己也无法确认自己丢没丢，读者更无法确认。点名 `TB7719` 之后，「有没有补进去」变成一个能一眼验完的检查。
- 词长降序是有取舍的排序：编号、长标识符、命令名是最容易在摘要化时被顺手删掉的东西，也最不该删——它们恰恰是下次复现时唯一能用的抓手。而「的、了、就是」这类高频短词即使丢了也不影响信息。
- 上限 6 个也是取舍：超过 6 个说明两条的差不是「补一句」，而是短条里另有一半内容是长条没有的——那种情况该做的是重写长条，不是逐字补。上限把「补」和「重写」分开。
- `keepNone` 分支不是凑数：它把「无损」变成一个可核对的结论。没有它，模型每次都要自己判断「还有没有漏的」，判断不了的默认动作还是「先归档再说」。

### 107.3 教训 72 与三条推论

**判据给出「是同一件事」，只完成了判断的一半；不给出「怎么合并不丢字」，模型就会用最省事的动作把差的那部分丢掉。**

推论：

1. 凡是「合并 / 归档 / 覆盖 / 覆盖写」类处置，都要顺手回答「会丢什么」；丢不了就明说丢不了。留白不是中立，留白等于把决定权交给「更省 token 的那条路」。
2. 阴性对照要防的是**过度触发**：本轮 F3 专门断言「本该无损时一个词都不许出现」——只有正例的探针只能证明它会喊，证明不了它不乱喊。
3. 造验证语料前先弄清 tokenizer 怎么切（CJK bigram、拉丁整词），否则「加一句话」和「加一个编号」在覆盖度上差好几倍，探针会一次一次踩空。

## 108 一次整理做完，得留下能对账的数字（0.2.96）

107 说的是「判据要说『是同一件事』，处方还要说『合并不丢字』」。108 再往外一层：**这一整套动作做完，
留下的痕迹得能让人回头核对**——不是「跑过了」四个字。

dream 原来的留痕只有 `groups` 与 `stamped`。这两个数回答不了最要紧的问题：这一轮到底翻了多少条？
有几对是真重复？有几对合并会丢字？于是「整理过了」和「整理对了」在账上长得一模一样——这正是可追溯性
缺口最典型的形态：不是没记账，而是账上只记了动作，没记内容。

修法不是往日志里多写一句自由文本，而是把清单先算成一串确定的数字（`dreamPlanDigest`），再让三个消费者
共用同一串数字：回执念给模型、`dream_log.changes.plan` 落库、`dream-debug.log` 留一行。三个出口同一个来源，
读者拿任何一个都能核对另外两个。

这里的取舍值得记一笔：摘要**不许**另立判据。它调的就是后面印块的那两个函数。多写一个「估算版」判据，
短期看不出问题，长期必然漂——一边说 2 对、一边印 1 对，读者第一反应是「这插件坏了」，而不是「两把尺子」。
宁可让 `dreamPlanDigest` 依赖 `dreamDupPairs` / `dreamCoverPairs`，也不要为了「摘要轻一点」去重写比较逻辑。

还有一条顺序纪律：**先确认要干活，再算成本**。摘要放在 `claimDream` 成功之后——被「已有 dream 在跑」
挡回来的那次，一个整理都不会发生，为它烧一遍分词是纯浪费。同样地，`sendFailed` 的那一支反而要把摘要
念出来：它证明「要整理的记忆还在」，规模就是证据。

最后是留白：面板还没读这条路，因为账本在 meow 手里，面板侧硬接一个 sqlite 句柄等于抄一份账。下一步该走
已有的事件通道（`DreamStateBroadcast`）把摘要带出去，而不是让面板自己去查库。

## 109 写完的账要有人念：读口和写口一样是产品（0.2.97）

0.2.96 给 dream 建了账本（`dream_log.summary` + `changes.plan`），但它只有写口。
数据完备不等于可追溯——抽屉里锁着的东西，对主人和模型都等于不存在。
这一版补的是读口，规矩三条：

1. **一个口径只有一个出口**：`readDreamLedger()` 是唯一读口，面板只是它的一个读者。
   以后加 UI（图标、CLI、导出）都走这里，不许各自 `SELECT` 一遍、各自算出点数。
2. **「没有账本」和「读不出来」必须分开**：`no-db`（工作区还没建库）、`read-failed`（库在但读不开）、
   `no-workspace`（会话没有 cwd）是三件事。合成一句「还没跑过 dream」，
   就把坏掉的东西说成了还没发生的事——这类谎最难查，因为它是「说得通」的。
3. **面板只念账、不算账**：`changes.plan` 是落库的字段，面板照念；老记录没有 plan 就明说没有。
   顺手把「目录从哪来」也定死：面板不写死 `.dsh-meow`，向引擎配置要 `meowDirReader()`。

附带一条工程上的收获：**判据只算一次**。开工时 `dreamPlanDigest()` 算一份、收尾落库，
面板念落库的那份；如果面板自己再算一遍，两处迟早会在「合并了几对」上打架，
而且谁也不会知道哪一份才是真的。

## 110 趋势是从账本里读出来的，不是从这一轮清单里算出来的（0.2.98）

面板要回答的问题升级了：从「这一次干了什么」到「是不是越做越干净」。这看起来只是多加一行，
实际上决定了这一行数字该从哪儿来。

一条铁的规矩：**趋势只念账本**。账本里的 `changes.plan` 是当时落库的事实，
`trendLine()` 把它按时间正序摊开、前后半段求均值、差值超过 0.5 才给走向词；
它不去碰当前这一轮的清单，也不重新分词。理由和 0.2.97 一样，只是方向反过来：
上一版禁止面板「拿现在的清单反推历史」，这一版禁止面板「拿历史预测现在」。
两边都守住，面板说的话才只有一个来源。

第二条：**能算就说，不能算就闭嘴**。可用记录不到 2 条，趋势行直接不出；
到了 4 条以下，行出来但必须自带「样本太少，只当参考」。
这不是谦虚，是把判据写进输出——一个在两次样本上宣称「重复在减少」的面板，
比一个什么都不说的面板更坏，因为它给了主人一个可以拿去做决定的错觉。

第三条：**跳过的东西要说出来**。老记录没有 `plan`，进不了合计；但如果不在括号里点明
「N 条记录早于 0.2.96，没有数字、不参与」，主人对不上账的时候只会怀疑面板算错了。
可追溯性不是「把对的数字摆出来」，是「让读者能自己核一遍」——包括核出被排除的部分。

附带一条界面上的收获：**编号把顺序变成可引用的东西**。`#1` 是最新，
一句话就能说「第三条那次没落库」，不用再靠时间去指。序号按当前列表编，
`limit=1` 的那一行既是「唯一」也是「最新」，两个身份并存不矛盾——
真正会出错的是把序号当全局行号，那会在换 limit 的瞬间开始骗人。


## 111 正在发生的事情也要能读，而不是只有历史（0.2.99）

「可追溯」这三个字很容易做成只朝后看：写一份账、留一行日志、给每条字句标上来源，然后以为追溯就做完了。0.2.96 到 0.2.98 三版就是这条路的三个台阶——先让 dream 写清自己看到多少，再让面板念这本账，最后让账本自己说出走向。三版都在回答同一个问题：**已经发生过的那一次整理，长什么样。**

但主人盯屏幕的那一刻，发生的事通常**还没结束**。呼吸灯在亮，面板上只有一个空账本，或者上一轮的旧账。这时候说「请等它收尾再来看」，等于把一个正在进行的作业藏进抽屉里——而抽屉里的东西（`dreamdigest`）明明在开工第一步就写好了。

所以 0.2.99 做的是另一件事：**把进行中的那一轮也抬到台面上**，并且明确它是「进行中」，不是账本里的一行。三处口径都遵守这一点：

1. SSE 的 `dreaming` 事件带上规模（`detail` 是可选参数，老消费方只看 `state` 一样能工作）——协议扩展必须是加法，不能逼别人跟着改。
2. 面板把那一行放在最前，但**不编 `#k` 序号**，也不进趋势。序号与趋势是历史的语法；把活的塞进去，等于提前宣布它已经落库。
3. 空账本时先说「正在整理」，再说「账本还是空的」。顺序反过来，主人就会以为这次整理什么都没看到。

这三条背后是同一条判据：**状态和结论不许混用一个容器**。「正在做什么」来自 lease + `dreamdigest`，「做完得到什么」来自 `dream_log`。两个数据源各自的失效方式不同（lease 会过期，账本会写入失败），合成一句「整理中：2 轮 / 2 条」听起来顺口，一旦 lease 过期就会把昨天那一轮说成进行时。

也是同一条判据的延伸：`readLiveDream` 的 `missing` 与 `readDreamLedger` 一样分三态。「没在工作区」「还没建库」「库读不开」三种来路各自有话说，因为它们的修法完全不同——补 cwd、等第一笔写入、去查文件。把三者合成「暂时没有进行中的整理」，是最难查的那种谎：它听起来像答案。

一个记忆系统的「效率」不只是检索快，还包括**不让人等一个本来就已知的答案**。这一版省下的不是 token，是「等它跑完再看」的那几分钟。

## 112 只看得见最近五条，等于账本只有五条（0.2.100）

0.2.97 给了账本一个读口，0.2.98 给了走向，0.2.99 给了「正在进行的那一轮」。三版之后，面板上永远只有五行——不是数据少，是读口只开了一个窗口。用户看到五行，会把它读成账本的全部。

这一版把读口拆成两条**用途不同**的通道：

- **扫**：翻页。要的是「一共几次、第几页、还有几条更早」。这里唯一容易错的地方是总数：`LIMIT/OFFSET` 只能告诉你这一页有几条，不能告诉你账本有几条。最后一页天然短，把页面长度当账本长度，就是在用排版冒充事实。所以总数单独查（`COUNT(*)`），页码先夹再读数，越界退到最后一页并且说出来。
- **读**：单条展开。要的是「那一次到底写了什么」。摘要、备注、`changes` 原文一字不改地摊开，超长就截断并报真实长度——「原文就这么多」和「我只给你看了这么多」必须能分辨。

设计上真正费了一点心思的是**编号**。账本里每行有 rowid，最省事的做法是直接印出来当句柄。但面板上已经有 `#k`（0.2.98 为了「第 3 条那次」而加的序号），两个编号并存，等于同一件东西有两种叫法——0.2.91 已经吃过一次这个亏（星图的「相似 N」和工具侧的「逐字重复度」差 0.58，面板说完全重复、工具说只有四成）。所以这里只留一个对外的口径：**第几近，1 = 最新，跨页连续**；rowid 只当内部句柄，不上正文。

还有两条判断，属于「宁可少给也不许误读」：

1. **趋势只出现在第 1 页。** 趋势的语义是「最近几次在往哪儿走」，翻到旧页还挂着它，人会把旧页的数字当成走势。
2. **脏参数打回。** `page=0` 悄悄当第一页，用户会读成「账本只有这一页」；`id=abc` 悄悄退回整本账，会读成「展开了，就长这样」。静默退默认在这个插件里已经被判过很多次死刑，没有理由在翻页这里复活。

最后记一条维护上的税：0.2.99 的 verify 块把版本号写成等号（`pkg.version === '0.2.99'`），一 bump 就红。版本一致性本来就由 doctor 的「单一来源」那条守着，历史块再钉一次等号，只会让每次发版都回头改历史断言。以后历史块一律写「不早于」。

而「翻页」这件事本身也提醒了一句：一个好的读口不是把数据全倒出来，而是让人**知道自己站在哪儿**——第几页、第几条、还有多少没看。

## 113 「有哪几个项目」和「某个项目的账」是两件事（0.2.101）

前三版把整理留痕做成了能翻页、能摊开的账本。但账本里一直躺着一个字段没人正经用过：`changes.plan.projects`。它只被数了个数——趋势行说「2 个项目段」，「整理进行中」说「2 个项目段」。

数得出来不等于看得见。用户想知道的是：**有哪几个项目段、各自几次；某个项目的账翻出来看看；这一条记的是哪几个项目。**

### 分布是分布，筛选是筛选

这是这一版最要紧的一条判断。两者都用同一份数据（`changes.plan.projects`），但回答的是不同问题：

- **分布**：全账本里有哪些项目段。所以它必须在**没筛**的时候给，而且只在第 1 页给——它是「账本的全貌」，不是「当前这一页的全貌」。
- **筛选**：只看某个项目段。筛的时候**不给分布**。理由很实在：筛完再报一行「项目段：Alpha 3 次 · Beta 1 次」，用户会把它读成「筛出来的分布」——那行数字明明是全账本的。宁可少给一行，也不给一个会被读错的行。

同理，`total` 在筛选时有两位数字：筛后几条、全账本几条。两个都写出来（`按项目段「X」筛：M 条（全账本 N 条）`），因为「筛到 0 条」有两种含义，只有把全账本的数摆出来才能分开。

### 编号只留一种口径，这次也没破例

0.2.100 定下的规则是：对外只有一个编号，「第几近，1 = 最新，跨页连续」，`rowid` 只当内部句柄。筛着的时候最省事的做法是把编号改成「筛后第几近」——列表确实变短了，参考系看起来跟着变。

没有这么做。理由是连续性问题：同一条账在筛与不筛两种视图下会有两个编号，而展开（`id=`）永远按全账本编号说话，两套编号必然在某一次调用里对不上。0.2.91 已经为「相似 N」和「逐字重复度」两个口径差 0.58 付过学费，这里不重犯。

所以：**筛选不改编号**，改的是说明。scope 里明写「#k 是筛出来这几条里的第几近，不是全账本序号」，展开时末尾补一句「这一条属于/不属于项目段「X」」。用户知道自己在哪，比数字整齐更重要。

### 坏行不许带崩整本账

`changes` 是 TEXT 列，理论上可以是半截 JSON。`json_extract` 在坏行上会抛错——一行坏账，整个面板变成「账本读不出来」。

所以每条走 JSON 的查询前面都加 `json_valid(changes)`。它同时也是一道语义守卫：坏行**不算匹配**，而不是「算不算不知道所以算上」。读不出来就明说读不出来，不许凑一个看起来完整的答案——这条在 0.2.100 的展开面板里已经立过一次（坏行只说读不出来，不拿摘要里的数字凑规模），这次是同一个判断换个地方。

### 顺手记一条维护上的账

`project` 给成长句（80 字以上、带换行）时，直接抛错。不静默当「没匹配到」——用户会以为「这个项目真的没有账」。插件里「静默退回默认」的写法已经被判过很多次死刑，翻页、展开那两处 0.2.100 刚改掉，这里没有理由复活。

而「按项目段原样匹配」这个口径，是产品的一部分，所以它必须出现在提示语里：`项目名要按 changes.plan.projects 里的原样写，别自己翻译。` 不做别名合并、不做大小写归一——那是另一件事，而且做一半比不做更糟。

## 114 「筛得到」和「存得对」是同一件事（0.2.102）

### 一个全绿但完全错的版本

0.2.101 加了按项目段筛账。SQL 写得挺漂亮：`json_each(json_extract(changes, '$.plan.projects'))`，`json_valid` 守着坏行，页面与总数共用一个筛子，探针 13 条全绿，绿链 21/21。

然后在真账本上问「Alpha 有过哪几次整理」，答案是「没有」。

原因不好笑：写侧那一格存的是**个数**。`json_each` 对数字不报错，它老老实实产出一行 `value = 3, type = 'integer'`，于是筛 `project = 'Alpha'` 一条都配不上，而筛 `project = '3'` 能配上——分布行里那个「3 次」就是这么冒出来的。

探针为什么没抓到：那 13 条探针手写 `changes` 时，很自然地写成了 `projects: ['Alpha']`。**它们验的是读侧，而读侧本来就是对的。** 错的是写侧，写侧的产物从来没进过这条链路。

这一版最贵的一条教训不是 SQL，是这件事：**凡是穿越格式边界的字段，至少要有一条探针从真 writer 出发。** 手写夹具验的是「我以为的格式」，不是「系统产出的格式」。现在的 `L1`/`L7` 就是这条规矩的落地——`V.dreamPlanDigest(realRounds)` → 落库 → `readDreamLedger(..., 'Alpha').total === 1`，整条链路一个假设都不留。

### 一个字段不能同时承担「事实」和「版面」

同一版里还顺手修了第二个：`dup` / `cover` 一直用 `dreamDupPairs(allRows).length`，而那个函数为了让清单不至于刷屏，内置了 `max = 5` 的截断。于是账本里记的「这一轮撞上几对」从来不是真数，最多 5。

这是典型的**一个值服务两个需求**：清单要短，账本要真。修法是把这个权限分开——函数多一个 `max` 参数，默认值仍是 5（老调用一行不改），摘要里显式传 `Infinity`。面板上写「对子（账里存了 6 对，这一轮共 21 对）」加一行「还有 15 对没落账」，两个数字各自诚实。

推而广之：**「存多少」和「印多少」是两个独立的决定**。合并成一个，早晚会在某一边撒谎。0.2.100 的翻页（`total` 来自 `COUNT(*)` 而不是本页长度）、0.2.101 的分布（`total` 走 `COUNT(DISTINCT)`）都是同一条判断，这是第三次。

### 老账本要能照实说，而不是假装统一

改格式最容易犯的错是「顺手回填」。这里没有回填：`changes` 是历史事实，回填等于改写当时那一轮到底做了什么。

于是面板有了三种念法，各说各话：

- 有名字 → `项目段：Alpha、Beta`
- 只有个数 → `项目段：这条账只记了个数（2 个），没记名字——它写在 0.2.102 之前。`
- 连 plan 都没有 → `这条账没有记项目段（老记录或这一轮没涉及项目）。`

第三种和第二种必须分开。第一种和第三种也必须分开——0.2.102 之前 `rowLine` 的写法是 `Array.isArray(plan.projects) ? plan.projects.length : 0`，对只有个数的账返回 0，于是「3 个项目段」被念成「0 个项目段」。**兼容旧格式不是把旧数据塞进新形状，是承认它有它自己的形状。**

### 让「看到」直接接得上「动手」

账本原来只存「撞了几对」。数字没错，但没有下文：看到「2 对」，然后呢？

0.2.102 把明细也存了：短 id、层级、分数，`cover` 还带「合并会丢哪几个词」。展开一条账，`cccc0001 ⇄ cccc0002 0.93 · fact ⇄ fact` 里的短 id 和整理清单里印的是同一套 —— 能直接 `memory_read`，也能直接 `memory_update`。

这条不是「多存点数据」，是**把观测和行动接到同一个坐标系里**。看不到 id 的统计只能让人焦虑；看得到 id 的统计能让人动手。上限仍然是 6 条：账本是索引，不是附件。

### 这一版留下的维护税

改签名（哪怕只是多一个带默认值的参数）会立刻打断历史断言里的等号匹配。0.2.92/0.2.94 那两处 `function dreamDupPairs(rows, threshold = DEDUP_THRESHOLD)` 就是这样红的。规矩定下来：**历史块的签名断言只匹配前缀（到逗号为止）**，理由和 0.2.101 那次一样——历史块要钉住的是「这个函数还在、还是纯函数、门槛还是具名常量」，不是「它有且仅有这几个参数」。
## 115 账本要回答两个问题：翻了几条、库有多大（0.2.103）

整理留痕这件事，最容易停在「记账」这一层：记下时间、记下翻了几条、记下撞了几对，看起来已经够对账了。0.2.96 到 0.2.102 一路做下来，账本确实越来越厚——项目段有了名字、对子有了明细、可以按项目筛。但有一格一直到 0.2.103 才补上，而它是所有数字的**分母**：库有多大。

「这一轮翻了 5 条」单独看是中性的。放在 500 条的库里，它说明整理只够着一个小角，剩下的没看；放在 8 条的库里，它说明几乎翻完了。同一条账、同一个数字，读者对「整理做得怎么样」的判断完全相反。不给出分母，账本就在鼓励读者用一个没有意义的数字下结论——这比不记账更糟，因为它看上去像是知道了。

补法的分寸比补什么更重要：

**一、数字必须和同一个时刻的其他数字对齐。** 库规模取「开工那一刻」，和「翻了几条」「撞了几对」同一瞬间。收尾再数当然更省事，但那一刻模型已经动过库了，两个数字对不上号，读者会顺手编出一个因果（「翻了 5 条怎么库还多了 5 条」）——账本一旦引导读者编因果，它就已经不是账本了。

**二、分母的口径要能被追问。** 只数 `active`，不数 `stale`/`archived`。这不是技术细节，是语义选择：归档的条目确实还在磁盘上，但它不在「库有多大」这个话题里。如果把它们算进去，趋势会一路下降，看上去像整理在不停删东西——而实际上只是条目被整理过一轮。

**三、老账不补零。** 0.2.103 之前写的账没有这一格，面板说「没记」，不说「0 条」。`0 条在用` 是一句可以被引用、被当成事实的话，而「没记」不是——一个系统最容易犯的错，就是把缺失渲染成零。

**四、缺口本身要能被看见。** 趋势行给出 `库 开工时 2 → 3 条` 的同时，也说明「只有 2 次有数」。数字少不等于不能说，但必须让读者知道这个区间是从几个点画出来的——否则一条两点连线会被当成走势。

**五、一次是快照，不是走势。** 至少两次才画区间，这一点与 `dup`/`cover` 的门槛（4 次才判断在变多/变少）是同一套克制：宁可说「样本太少、只当参考」，也不把噪声讲成趋势。

这五条合起来，说的其实是同一件事：**度量只有在和其他度量处在同一个坐标系里才有意义。** 时间对齐、口径一致、缺口可见、样本足够——少任何一条，账本就从「回答问题的记录」退化成「看起来很像答案的数字」。

下一步自然会长出来的东西也在这一格后面：真要让「整理让库变轻还是变重」成为可以下判断的结论，还缺「整理前后两次」的对照，而那需要重新设计 `finalizeDream` 的时序（见 9.109.4）。在那之前，本版只承诺一件更小的事：账本不再只说「翻了几条」，也说出「在哪翻的」。

## 116 位置是给人翻的，引用是给话说的（0.2.104）

账本翻页、按第几近展开、按项目筛账都齐了之后，剩下一个洞：**说不出「哪一轮」**。人能说出口的只有「第 2 近」和「三天前那次翻了 7 条的」，前者会挪，后者靠猜。0.2.104 让每一行带一个 `r<N>`，这个号跟着行走，不跟位置走。

这条决定**反转了 0.2.100 的口径**（当时写着「不暴露 rowid——对外的句柄只有一种口径」）。反转不是推翻，是发现了它的边界：那时要防的是「把存储实现焊进调用约定」，这个担心现在仍然成立；但当时没看见的是，**只有位置、没有身份，就只剩「看最近几条」，永远做不到「回指」**。而「回指某一轮」是主人给可追溯性提的第一条要求。

所以收窄地反转，四条边界：

1. **只多一个字段**：`dream_log.id`。不暴露 `rowid`、不暴露 `changes` 内部结构、不开放任何 SQL。
2. **写成 `r<N>`，不是裸数字**：参数里 `4` 和 `r4` 是两个意思 —— 一个说位置，一个说身份。混淆它们会静默指到别的账上，那是最坏的一种错，所以从形制上就先分开。
3. **两套口径并存、各管一件事**：`#k` = 这一页的第几近（翻页、展开照着念），`r<N>` = 这是哪一轮（回指、跨会话引用）。面板上两句话并排印，一句都不省。
4. **失效是单独一态**：引用打不开时明说「这个号不会发给新账，那一行可能已经不在了」，不退回空账本、不猜最新一条。**猜出来的引用比没有引用更坏。**

一条支撑这个决定的存储事实：`dream_log.id` 是 `INTEGER PRIMARY KEY AUTOINCREMENT`，删了也不复用。这一点是硬要求 —— 如果号会复用，「打开失败」就会变成「打开了另一条账」，静默地把错误读成结果。选 `AUTOINCREMENT` 而不是纯 `rowid` 的代价是多一张 `sqlite_sequence` 表，换来的是「引用永不转手」，值。

还要记住那个排序细节：`dreamRankOf` 的 `WHERE run_at > ? OR (run_at = ? AND id > ?)` 必须和 `recentDreamsPage` 的 `ORDER BY run_at DESC, rowid DESC` 同一把尺子。同一毫秒写进去的两条账，只有靠 `id` 破平两边才一致；一旦两边排序不同，`r4` 和第 4 近就会指向不同行，而这种错**不会报错，只会读错**。凡是要「同时给两个视角」的功能，第一件事是把尺子对齐，而不是各算一遍。

## 117 日期是给人说的，毫秒是给机器存的（0.2.105）

账本存 `run_at`（毫秒），人说的是「18 号那天」。中间这一步如果交给字符串解析，会安静地错 8 小时 —— 而安静是最坏的性质：结果照样出来，只是整体偏了一天。

所以 0.2.105 的三条口径不是三个「好习惯」，而是三个**一旦让路就必然出错**的点：

1. **闭区间**（`>=` / `<=`，`until` 取 23:59:59.999）。半开区间在「按天」这个场景里没有第二种合理解释：用户说「18 号」就是把 18 号这一整天算进来，端点在不在，不是风格问题，是答案对不对的问题。
2. **本机时区**（`new Date(y, mo - 1, d, ...)` + 回读校验）。`Date.parse('2026-11-18')` 是 UTC 语义，东八区一律偏 8 小时。反过来说，任何「用字符串解析日期」的写法在这个项目里都是错的，哪怕它今天看起来对。回读校验挡的是另一件事：`2026-02-31` 会被 JS 滚成 3 月 3 日，静默换成另一天。
3. **同一把筛子**（SQL 里筛，行与总数共用 `parts`）。这一条在 0.2.101 按项目筛时已经立过，日期只是又一种条件；如果这一版为了省事在面板里 `filter` 一遍，那 0.2.101 立的口径就当没立过。

还有一条是分寸上的：**「这段日子里没有」和「账本里没有」必须分开说**。前者要带「账本覆盖 A → B」，后者才是「还没跑过整理」。合并成一句「没有记录」会让用户以为整理从来没跑过，而这正好是可追溯性最不该出的一种误读。

日期写坏了怎么办？打回，不猜。猜一个日期去筛，用户看到的是「有账」，会以为那几天真的跑过整理 —— 错误被伪装成了证据。`2026-13-40`、`2026-02-31`、`18/11` 一律 `这种写法不敢猜`，一次库都不查。

和 0.2.104 的引用合起来看，账本现在有三个互不替代的坐标：`#k`（此刻第几近，会挪）、`r<N>`（哪一轮，不挪）、`A → B`（哪段日子，可筛）。三个各管一件事，谁也不许兼任。

## 118 两个观测点的差不是因果，但没有第二个点连问题都问不出来（0.2.106）

0.2.103 只数「开工那一刻」的库规模，理由是：收尾再数一次，人会顺手把差读成「这一轮改了几条」，而中间可能有别的会话在写。这个担心成立 —— 但它推出的是「必须把差和因分开写」，不是「不许有第二个点」。

一个观测点回答不了的问题很具体：**这一轮整理让库变轻了还是变重了？** 这是整理唯一的成绩单。没有它，账本只能证明「跑过」，证明不了「有没有用」。

所以 0.2.106 的立场是三条：

1. **能数就必须在那一刻数。** 收尾数写进 `changes.plan.storeEnd`，由 `finalizeDream` 在写侧取；面板渲染时库早就变了，任何「事后重算」数出来的都是看账那一刻，不是整理结束那一刻。观测点一旦可以补算，它就不再是观测点。
2. **差落库，不让读侧各减一遍。** `storeDelta` 在写侧算好，并且只在两个点都有数时才算（`Number.isFinite(before) && before >= 0`）。读侧只负责念 —— 否则迟早有人只减一半，比如忘了 `status='active'`。
3. **差与因分开，各自有名。** `storeDelta` = 库变了多少；`stamped` = 这一轮封存/完结了几条。展开一条账时，口径句必须紧跟库规模出现，否则那个 `+1` 会被当成「这一轮加了一条」。

关于「缺一个点怎么办」，答案是没有例外：**闭嘴，不猜，不补 0。** 0.2.103–0.2.105 的账只有开工数，就只念开工数；给老账补一个「收尾」等于把今天的库冒充那一刻的库，这是最坏的一种补全——它看起来像数据。

文案上留了一个具体的教训：第一版把差写成 `→ 收尾 1 条在用（fact 1）（-2）`，两层括号叠着，读的时候要数括号。改成「层数进括号、差进句尾」之后才是 `→ 收尾 1 条在用（fact 1），比开工少 2 条`。同一条毛病在趋势行的 caveat 上也有（`（A（B）；C）`），一并改成破折号。这类问题测试永远不报错，只会让人不想读 —— 面板的可用性就是靠这种地方攒出来的。

和 0.2.103 的关系是**承接而不是翻案**：那一版立的是「只数 active、缺格不补 0、老账不认领」，这一版只是把观测点从 1 个补到 2 个，规矩一条没松。反转的只是那句「收尾不再数」——而它当初的顾虑，现在由一行口径句承担。

## 119 只有跑完的一轮才是成绩单（0.2.107）

账本原来只认一件事：这行摘要怎么写的。`window dream (done|aborted):` 里那一个词既是数据也是文案，于是读账的人（面板、探针、我自己回看）都在解析自然语言 —— 摘要改一个字，协议就改一次。

0.2.107 把收尾方式落成 `changes.kind`，同时补掉三处「账本撒谎」：补记的账被念成比 0.2.96 早、半路停下的账说不出本来几组、连续失败止损封存的账压根不落账。最后那一处最要紧：**整理失败得最惨的那次，恰恰是账本上看不见的那次。**

立在后面的立场有四条。

1. **摘要给人看，结构化给机器算，两份都要有。** 只留结构化，翻日志的人要自己拼；只留摘要，机器要解析中文。谁想省一份，省掉的都是别人的路。这条 0.2.106 已经用过一次（`store=A->B` 既落 `changes.plan.storeEnd` 又印进摘要），0.2.107 把它变成规矩：新增的每一种收尾都同时出现在两处。
2. **半轮的数字是中间值，不是结论。** 中途放弃那一轮的 `dup/cover/missing` 是「扫到那儿为止」扫出来的，把它加进趋势合计，等于把半张成绩单当满分算；拿它跟跑完的一轮比，减出来的「变少了」是假象。所以趋势只吃 `done`，比对遇到半轮直接拒绝比 —— 拒绝比给一个数更负责。数字不可比的时候，正确输出是「不可比」。
3. **记下来的和认出来的都能念，但不能长得一样。** 0.2.107 之前的账没有 `kind`，只能靠摘要首词认。面板照念，但展开时必须说明「这一条没有 changes.kind，是从摘要首词认出来的」。同一条信息，可靠度不同，读的人有权知道差别 —— 这是账本的老规矩（`missing` 四态、`stored` 标记都是同一件事），这次只是把它用在收尾方式上。
4. **不落账的失败等于没发生。** 连续失败到上限时 `finishDream` 掉窗口、只写调试日志，结果账本上干干净净。调试日志是给排查的、会轮转、会被人删；账本是给人回看的、要长期在。两件事都得写，不能拿一件替另一件。

关于顺序，留一个具体的坑：想在 `finalizeDream` 里知道「本来几组」，必须在 `finishDream` 之前读 `dreamplan:${sessionId}` —— 收尾动作本身就把账要吃的数据删了。函数名叫 `finalizeDream`，直觉是先收尾再记账，写的时候正好反着。

文案上也留了一条：`groupsDone` 必须是 `groupsCount - 1`。`abortDream` 传的是「进行到第几组」（1-based），直接当「走完几组」用，会把半路停下说成「走完了那一组」—— 差一个 1，意思从「没跑完」变成「跑完了」，而这种错在账本上永远不会自己暴露。

## 120 总分是记分牌，分项才是体检报告（0.2.108）

0.2.106 让账本记了两个观测点，于是能答「这一轮让库变轻还是变重」。当时以为这就够了。
不够：净变化是一个总数，而总数会被抵消。

一轮整理把 2 条 topic 降成 fact、lesson 掉一条、fact 涨两条，总分 +0。
账本念「比开工多 0 条」，读的人松一口气——可库的结构在这轮里动了四处，
其中三处是同一个方向（抽象层被拆成事实层）。这不是「没变化」，这是「变化互相抵消」。

所以这一版给的是**分项**：每一轮收尾那一刻，每一层还有多少条在用，摊成一条走向。

四条立场：

1. **总分回答「重不重」，分项回答「哪里在烂」。** 两个都要，但不能拿一个替另一个。
   只给总分，读者会以为「+0 = 这轮白干」；只给分项，读者看半天不知道库到底大了还是小了。
2. **只认收尾数，不许拿开工数占位。** 0.2.103～0.2.105 只有开工层数，把它们排进走向，
   图会很整齐，但那不是走势，是把整理前的库贴到整理后的位置上。宁可样本少。
3. **零层不出现，缺层就是 0。** 写侧只写正数层，于是「写了 byLevel 却没有 topic」只有一种解释：
   那一轮 topic 是 0。这句话必须写在口径里，否则「缺」会被读成「没记」——那是两个相反的事实。
4. **没动就说没动。** 每一层都没变时，硬挑一个「涨得最多的是 fact（+0）」是把噪声讲成走势。
   读的人一旦发现这种句子，整条走向的可信度就没了。

顺序上还有个坑：`rows` 是最新在前（账本按 run_at 降序），走向要按时间念，进 `levelTrendLine` 前必须 reverse。
忘了这一步，箭头会倒着指，`+2` 会写成 `-2`，而且看起来完全正常——这类错最难抓，因为它不报错，只是把因果讲反。

分工照旧：**写侧只落事实**（`dreamStoreScale` 数什么、零层写不写），**读侧只管念与拒绝念**
（少于两轮不念、半轮不念、缺收尾数不念、没变就说不没变）。读侧不许反推写侧没记的东西，
一次快照也不许被讲成一条走向。

## 121 省 token 的前提是知道自己花了多少（0.2.109）

记忆系统有一个反直觉的成本结构：**检索越有用，越贵**。召回十条各带正文的记忆，往往比召回三条更有用（漏召回的那条你不知道它存在），但十条的字符数是三条的三倍多，而上下文窗口是这一轮做题的弹药。于是「效率」这一维不能只看快不快，还得看**这一次检索占掉多少**。

### 一、估算要有口径，口径要说在人能读到的地方

`estTokens` 不做精确计量：CJK 一字算 1、其余四字符算 1。这是刻意的粗糙——真 tokenizer 要绑模型版本、要背词表，换来的是一份精确到个位的账单，而这里要回答的问题是「这份回执是不是太大了」。粗糙的估算配上明说的口径（`CJK 一字算 1、其余 4 字符算 1，是量级不是账单`），比精确的估算配上沉默要诚实：后者会被当成账单去对，误差一露，整条成本信息就没人信了。

口径必须印在**每次**报成本的同一行里，而不是写进文档让人去查。人不会去查。

### 二、预算是工具的事，不是调用方的事

调用方不会算：它不知道十条各 300 字是多少 token，也不知道引擎的 `content_max` 剪在哪。所以「省 token」不能靠调用方少给 `k`——那是在没有信息的情况下押注。

`budget` 把这件事交回工具：调用方只说「这次最多 400 token」，工具自己砍、自己量、自己交代砍了什么。这条分工的判据是「谁掌握信息谁做决定」：参数对体量的影响只有引擎知道，所以收缩只能发生在引擎侧，而且必须**改参数重查**，不能截字符串——截断会把一条记忆拦腰砍断，读者看到一句没有下半句的话，工具还在尾注说「收紧了」，那是在骗人。

### 三、先砍字，再砍条数

十条各 30 字，读者知道有这十条、分别讲什么；三条各 300 字，只看到三条，另七条等于没召回。对记忆检索来说**漏召回比看不全更贵**——看不全的那条你知道它存在，可以再读一次；漏掉的那条你不知道它存在，也就不会去补。

所以 `fitBudget` 先把 `content_max` 减半直到 60，再动 `k`。这条顺序不是性能偏好，是**召回优先**的价值判断：记忆系统的第一义务是「该想起来的东西出现过」，第二才是「出现得够详细」。

### 四、最小就是最小，必须量到

四级重取之后还装不下，得回答「最小能给多少」。第一版拿第四级的估计值当最小值——报「最小」却从没试过最小。这类错特别隐蔽：数字看起来合理，文案也通顺，只是它是猜的。发现它的方式只有一个：**问「这个数是谁量出来的」**。答不出「某一次真实调用的返回值」，就不许把它印出去。

改法是装不下之后再真取一次 `k=1, content_max=60`，尾注里那句「实测」是有对应调用的。`probe-fusion` 的 D60 用「怎么砍都不变」的 stub 造出装不下的情形，同时钉住「有实测、没有『收紧了』」——两条一起才能排掉「拿估计冒充实测」与「没缩却说缩了」。

### 五、说了要缩，收缩就得真发生，而且要在对的位置

`budget` 的收紧插在本地检索之后、星图段之前。顺序反了，邻居段落加在已经缩到预算的那份后面，回执仍然超预算，而尾注说「按 400 token 收紧了」——数字与文案对不上，整条尾注作废，而且这种作废是**静默**的：读者不会去数字符。

同理，星图退回本地兜底的两条路也过同一道预算。一条路漏了，等于「同一个参数在一半情况下不生效」，而调用方从尾注上看不出差别。

分工照旧：**写侧只落事实，读侧只管念与拒绝念**。这一版里「写侧」是 `tokencost.js` 的三个纯函数（估、格式化、判预算），「读侧」是 `search.js` / `read.js` 的尾注——尾注只许念量出来的数和真发生过的收缩，不许念估计值、不许念没做的事。

## 122 预算是一条线，不是某个函数的特权（0.2.110）

### 122.0

0.2.109 让工具会报成本、也让预算真的会收缩——但只在一条路上。尾注老实写着另外几条路不缩。
诚实的缺功能仍然是缺功能：读者的上下文不按「你走了哪条路」打折，四段回执都要占位置。

这一版把 `budget` 从「本地检索的参数」提升成「这次回执的约束」。

### 122.1 旋钮名字不同，道理相同

每条路都有两个旋钮，一个是「每条多长」，一个是「几条」。收缩顺序一律是**先动那个只是少看一点细节
的，再动那个真的会少看到东西的**：

- 本地：先 `content_max`，后 `k`
- 星图：先 `limit`，后 `hops`
- 补邻居：先 `chars`，后 `limit`
- 相似：先 `content_max`，后 `k`

顺序不是审美，是召回质量的排序。少几个字，读者还能认出这条记忆；少几条，那条记忆就彻底不在场了。

### 122.2 类型错误的代价：一路滑到底还能自圆其说

`budget` 是 `{ value, note }`。第一版 `fitPath` 直接写 `est <= budget`——数字与对象比较恒为 `false`，
于是循环一次都收不住，最后稳稳落到「装不下」那个分支，而回执里印的是「预算 [object Object] token 装不下」。

这段代码没有崩、没有抛错、甚至读起来像正常工作。**它只是把一个错误的判断，用完全正确的句式说了出来。**
四个探针同时红才把它挖出来。入口摊成 `Number(budget.value)` 是这一版最便宜也最重要的一行。

### 122.3 报「砍了什么」只能报真发生的

`hops 2→2` 这种一行字最危险：它证明了工具在报账，却什么都没砍。读者的合理推断是「它被砍过了」。
所以 `show()` 只列 `value !== from` 的项，全都没动就说「没动到任何旋钮」。

同理，报「最小」之前必须把所有旋钮压到下限再量一次。停在第四级不叫最小，叫「我停下的地方」。

### 122.4 剩多少就给多少

`expand=true` 的回执是两段：本地结果 + 星图扩散。两段各自按同一个 `budget` 收缩，加起来必然超预算——
因为预算描述的是整份回执，不是每一段。

扩散段现在拿 `remain = budget - estTokens(本地那一段)`。剩余不够就**不拿**，并告诉读者两条出路
（关掉 expand、或把预算提上去）。预算若不能拦下内容，它就只是个建议。

## 123 一个总数背后的两个故事（0.2.111）

### 一、层走向与项目走向不是同一张图

0.2.108 让账本会说「哪一层在涨」，0.2.109 / 0.2.110 让它会说「这次花了多少 token」。
三者合起来仍然漏一件事：**涨的那三层，是谁的？**

Alpha 加 3 条、Beta 删 3 条，fact 的净数没变。层走向会诚实地念「fact 没变」——
这句话没错，但它省略了全部有意思的部分：一个项目在长肉，另一个在被清空。
**总数是 0 不等于结构没动**，正等于「票数一样不等于没换人」。

于是加第二条走向，用同一批行、同一套「只吃跑完的轮」的规矩，只换一个维度：
从「按层」换成「按项目」。

### 二、口径先于功能

在写任何代码之前先问：库里哪些层真的带项目归属？
答案在 `SCHEMAS` 里——`project` / `fact` / `lesson` / `topic` / `rules` 五张表有 `project` 列，
`soul` 与 `user` 只有 `COMMON_COLS`。

这个发现决定了三件事：
1. `PROJECT_LAYERS` 只列这五个，不为了「看起来完整」把 soul / user 也算进去（它们没有这一格，
   算进去只能靠猜）。
2. 口径句必须写出「只数 5 层」，否则读者拿总条数一减，会以为 soul 的条目丢了。
3. 「跨层相加」是唯一合理的读法：读者问「这个项目有多大」，不是「这个项目的 fact 有多大」。

**口径不是注释，是产品的一部分。** 一个数在没有口径的时候，会被读者按自己想象的口径解释，
然后得出相反的结论。

### 三、名字是字符串，改名会造出两行

项目名按写入时原样存。于是「改名」在这张图上的表现是：旧名一路掉到 0、新名从 0 冒起来。
看的人很容易读成「有人在批量删东西」。

处理方式不是去猜改名（那需要事件，或至少近似匹配，都会引入新的假阳），
而是**把这件事写进口径句**：「项目名按写入时原样——改过名的会算成两行」。
承认局限，比偷偷补一个可能错的推测更专业。

同理，`project: '全局'` 是 meow 的写入约定，它会作为一个正常的项目名出现。
不对劲的是读的人以为「全局」是「没有项目」，所以口径句里也不假装它是空的。

### 四、空不等于零

写侧只在真的数到项目时才写 `byProject`：

```js
if (Object.keys(byProject).length > 0) out.byProject = byProject
```

因为空对象一旦落进 JSON，读侧就无法区分「这一轮数过，零个项目」和「这一轮根本没数项目」。
这和 0.2.108 那条「每层是独立表、`byLevel` 里没有那一层就是那一轮那层 0 条」是同一条原则的
反面：**能写的零就写零，不能写的零就别写空壳。** 老的账（0.2.111 之前）没有这一格，
走向就把它们排除并在 caveat 里报数——不是补 0 让线看起来连续。

### 五、同一条规矩复用，而不是复制一份代码

项目走向与层走向共享三件事：只吃跑完的轮（`isFullRound`）、少于两轮不出、排除要交代。
实现上 `projectTrendLine` 与 `levelTrendLine` 是两个函数（数据结构不同、口径不同），
但**判断与文案结构完全对齐**——读者看到的两条走向，读起来是同一支笔写的。

这一版没做「按项目筛了再看向走」：筛子改变的是「看哪几页」，走向改变的是「怎么读这几页」，
两者合流要先想清楚「筛完再看走势」算不算另一种编辑历史。先不做，写进 INTERNAL 的「没做的事」。

## 124 不能缩的东西，换个维度缩

以前的省 token 设计都在同一个维度上：把内容变短（`content_max`）、把条数变少（`k` / `limit`）、把跳数变少（`hops`）。这三样都一样安全，因为读者拿到的每一条仍然是**完整的**一条。read 不一样：它的回执里有一段是 caller 点名要的东西，缩它就是给假货。

### 一、先分出「可缩」与「不可缩」

read 的回执由三段拼成：正文（meow 给的整条）、邻居段（星图给的若干条）、说明（这次的参数被怎么处理过）。正文不可缩；邻居段可缩，缩法是**条数**；说明越小越好但不能没有。于是这一支的预算落在邻居条数上，而不是落在「正文前多少字」上——同一条「省 token」的原则，在不可缩的对象上只能换维度执行。

### 二、阶梯不是二分

砍邻居时，为什么是 6 / 3 / 1 / 0 而不是二分查找？因为每一次试都要**真的调用一次星图**：二分看着优雅（log n 次），但那几条试出来的档位未必是读者想要的粒度，而他真正在乎的往往只有「全给」「给几条」「一条不给」三档。阶梯把最可能的档位放在前面，最多三次，且第一档永远是他自己给的那个数——先照办，再收。

这也是「装得下就一条都不砍」的实现：第一次试的就是完整请求，量出来没超就结束，绝不为了「看起来在省」去砍一点。

### 三、交代比省更贵，但只在被改过时必须交代

尾注（`≈1.9k token／预算 2000；邻居 12→6 条才装下`）本身就占 token，有时候刚好把一份「卡在预算线上」的回执顶过线。规则是两条不对称的：

- 改过他的条件（砍了邻居）→ 必须说，哪怕超几十 token；
- 没改（装得下）→ 能装下才说，装不下就一个字不加。

不对称的理由不是「省」，而是**改了不说等于骗**。省 token 从来不是目的，只是手段；把手段推到「让读者误以为拿到了他要的全部」那一步，就是拿正确性换字数。

### 四、骨架是路牌，不是摘要

「装不下就只给骨架」很容易滑成「只给前 200 字」——那就成了摘要，而摘要最大的问题是看起来像全文。所以骨架的内容刻意避开正文中段：只取第一行（认得出是哪条），然后立刻转成**元信息**——多少字、约多少 token、你给的预算是多少、怎么才能看到全文。读者拿到骨架时的结论应该是「这条我看不到，因为预算不够」，而不是「这条就这么短」。

### 五、预算的账也要装进预算

这是这一轮最小的一个决定，也是最容易漏的：报成本的尾注自己也要过 `estTokens` 检查。一个「省 token 的工具」如果每次为了报账多花 20 token，它在小回执上就是净亏损（0.2.109 已经用 `COST_SHOW_MIN` 挡过一次，这次挡的是「尾注顶破预算」这一种）。规则落在一行代码里：

```js
return estTokens(withTail) <= budget.value ? withTail : picked.text
```

省 token 的工具，第一件事是别把自己变成开销。

## 125 净差是一种压缩，压缩必然丢时间

### 一、两个项目都是 +2，说的不是一件事

三个项目、三轮收尾数摆在桌上：

```
Alpha  3 → 4 → 6   （+3）
Gamma  0 → 0 → 2   （+2）
Beta   1 → 2 → 0   （-2）
```

只看加号后面的数，Gamma 和「一个从 2 涨到 4 的项目」完全一样：都是 +2。可前者是**新长出来的一块地**，
后者是**旧的地又扩了**。Beta 的 -2 同样有两种读法：本来就只有 2 条、被修剪干净；或者本来有 2 条、
这一整块没人管了，直接消失。修剪和消失对记忆系统的意思是相反的——一个是「还在用、只是瘦了」，
一个是「这块地废了」。

这不是「走向写得不够细」，而是**净差这种压缩天生丢时间**。首尾相减（`last - first`）只保留两个端点，
中间的形状、出现的时刻、归零的时刻全被压平成一个数。压缩是必要的——不然账本每轮都要印一整条序列；
但压缩之后必须**另外补上被压掉的那部分里最有用的两项**：第一次有数在第几次，最后一次有数在第几次。

一个更普遍的判断：**任何把一段历史压成一个数的统计，都欠读者一句「这个数没告诉你什么」**。
净差的盲区是时间位置，所以补位置；平均值的盲区是分布，所以要补中位数或极值；占比的盲区是分母，
所以要补总数。补的位置选得对不对，取决于读者拿这个数去做什么判断。

### 二、省略必须报数，因为 `…` 和「没数」长得一样

序列长了要折起来，这是体量问题。但折起来会撞上一个更麻烦的问题：`1 → 2 → … → 6 → 7 → 8` 这个形状，
最自然的解释是「中间这几次没有数据」。而实际上有，只是我们没印。

同一个形状，两个完全不同的意思——这跟 0.2.109 的「检索被截断」、0.2.112 的「邻居被砍」是同一类
错误：**省略本身是一种信息丢失，如果读者不知道丢了，他就会按「没有」去理解**。所以省略必须带三个东西：

1. 丢了什么（中间那几次的序列）；
2. 丢了多少（`中间 3 次`，不是「若干」）；
3. 去哪拿（`要逐轮就展开那一轮看账`）。

少了第 2 项，「中间几次」会被读成「一两次」；少了第 3 项，读者知道有东西丢了却无从下手，
只能相信眼前这条被压缩过的线——那就等于逼他用压缩件当原件。

阈值也有讲究：`SEQ_HEAD + SEQ_TAIL + 1 = 6` 之后再折。七轮以下整条给，理由不是「短的好看」，
而是**折一次至少要省掉两个数**，否则省略号（一个字符加两个分隔符）比它省下来的还长。
省不出字符的省略只是让人多读一个符号。

### 三、改名这种事，走向只能给线索

项目名在库里就是一个字符串。改名在存储层看，就是「旧名字的行全没了、新名字的行出现了」——
和「清空一个项目、另起一个新项目」的账一模一样。唯一的区别是内容，而走向只数条数。

于是这里有一次明确的取舍：**在一个只看条数的地方，不许下「这是改名」的结论**。
能说的是：

- 一存一失同时出现了（这是观察）；
- 如果条数对得上，很可能是改名（这是推测，且条件写明）；
- 要确认就翻那一轮的账看项目段名字（这是核对路径，读者能自己做）。

三者分开写，比一句「检测到改名」有用得多。后者看起来更强，实际上是替读者做了一个他无法复核的判断——
而记忆系统里最贵的错误就是「看起来确定的错」。

### 四、结论的顺序也是口径的一部分

一条回执行里混着两类句子：**这次看到了什么**（序列、结论、新出现、消失、改名线索）和
**这次没看到什么**（还有几个项目没列、折了几次、几次没跑完、常驻口径）。两类必须分段放。

混在一起的后果不是难读，是**误读**：「还有 3 个项目没列」如果紧跟在「涨得最多的是 Alpha」后面，
读者很容易把它读成「Alpha 涨得最多，另外 3 个项目也涨了，只是没列」——而它们可能全在跌。
先结论、后口径，是让每句话都能被单独引用而不失真。

阴性对照同理：平稳的走向不许出现「新出现」「消失」「改名」。这三句都是**加分句**，
只在有证据时才加；没有证据就加，等于让读者为自己没看到的东西紧张。

## 126 两种病：一句话存两份，和一件事两种说法

### 一、重复可以机械处置，冲突不行

去重这件事一直是舒服的：逐字重复度 ≥80% 的两条，一定说的是同一句话，合并、归档一条，谁都不会有异议；
「短摘录 + 长详写」也一样，覆盖度 ≥90% 就是在说「短的那条整句都落在长的里面」，补字、归档短条，无损。
这两把尺子背后是同一件事——**被比较的两条在字面上几乎一样**，所以结论可以交给机器。

但记忆库里真正麻烦的是另一种：两条正文几乎不重叠，字面看是两件事，可它们**指着同一个主题给出彼此打架的数字**。

```
DSH 的记忆库在 C 盘的 .dsh 目录里，插件版本 0.1.x
DSH 已经搬到 D 盘 dsh-home，插件版本 0.2.113
```

逐字重复度不到 30%，覆盖度够不着——按前两把尺子，它们根本不算什么。可对读的人（和读的模型）来说，
这两条同时生效，等于库里同时说「在 C 盘」和「在 D 盘」。这才是最贵的一种脏：**不是冗余，是矛盾**。

而这两类病的处置方向是**相反**的：

- 重复 → **合并**。两份变一份，信息不损失，因为两份本来是同一条。
- 冲突 → **裁决**。挑一条当当前事实，另一条要么改写、要么设 stale——因为两份都是事实，
  只是一个过期了。**绝对不能合并**：把「C 盘」和「D 盘」合进一条，得到的是「在 C 盘，也在 D 盘」，
  一份看起来完整、实际全错的记忆。

把这两种病用同一把尺子处理，是这一版之前最大的风险——「相似 N 很高」被当成「该合并」，
而它有时其实是「该裁决」。判据必须能分开，处置建议也必须分开写。

### 二、系统只摊差异，判决留给写的那一刻

冲突最诱人的地方在于它看起来可以做自动处置：谁的时间戳新，谁赢；输的那条归档。规则手册里甚至就是这么写的
（「冲突以时间戳最新者为准」）。这条规则没错，但它只在**「两条说的是同一件事的先后状态」**时才成立。

数字不同不必然是矛盾。一条写「版本 0.2.113」、一条写「端口 59612」，两个数字都对；
一条写「2,267 条断言」、一条写「21 支自检」，也都对。这些条目在判据眼里和「C 盘 vs D 盘」长得一模一样：
同主题、各有数字、数字集不同。如果系统按「新者胜」自动归档，它会把一条完全正确的事实删掉。

系统凭什么分不出？因为它只看得见数字，看不见「这个数是版本号还是端口」——
**语义在写的那一刻才存在**，之后只剩字符串。所以正确的分工是：

- 系统负责**摊**：把这对条目共用什么关键词、各自独有哪几个数字、谁更新时间更晚，一条一行摆出来；
- 写的那一刻（整理的那一轮）负责**判**：这个差异是「同一件事的先后」，还是「两件不同的事共用了一个主题」；
- 两者都拿不准时，系统给的是**核对路径**（翻项目文件），不是结论。

这和 0.2.113 里「改名线索不替你猜」是同一条原则的第二次应用：**在一个看不见语义的地方，
只许给线索和核对路径，不许给结论**。给结论看起来更强，实际是把一个无法复核的判断塞给读者——
而记忆系统里最贵的错误就是「看起来确定的错」。

### 三、0 和「没查」必须能分开

这一版还有一处必须写死的分层：`conflicts === 0` 和「这条账根本没有这一格」是两件事。

前者是「查过，这一轮没有撞上」，后者是「0.2.114 之前的账，那一轮压根没查过冲突」。
两者在数字上完全相同（都是没有冲突可看），在信息上完全相反：一个是结论，一个是空白。
所以读侧对「非数组」返回 `null`、对「空数组」返回 `[]`，并在面板上分别说
「那一轮根本没查冲突，不是「查了没有」」和「这一轮没有「同一主题却写了不同数字」的条目」。

同一个原则在这个项目里已经出现过三次：截断要报数（0.2.109）、砍邻居要报数（0.2.112）、
省略要报数（0.2.113）。这次是第四次，形式稍变——**不是「丢了多少」，而是「有没有查过」**。
共同点始终是：**读者不该被形状骗**。空白的形状和「没有」的形状一样，就必须有一句话把它们分开。

### 四、判据要能被反驳

关键词 + 数字这套判据有个明显的好处：**它是可解释的**。读者看到「这两条撞上了」，
下面就直接跟着「共用关键词：dsh、路径」和「一条独有 0.1、一条独有 0.2.113」——
不同意的人可以立刻指着某一项说「这两个 0.1 根本不是一回事」，然后自己去改。

换成向量相似度，误报就无法反驳：它只会给一个数，说不出凭什么。对一个要长期自我进化的记忆系统来说，
**能被反驳的判据比更聪明的判据更值钱**——因为反驳本身就是一次校准，而无法反驳的分数只会让人绕过它。

这也是为什么这一版宁可接受 30%–40% 的误报率（把「版本号 vs 端口号」也列出来），
也不把门槛调高到只报「明显矛盾」。误报的代价是整理时多读两行、多写一句「这两条各留各的」；
漏报的代价是库里长期同时存在两个互相打架的事实，而没人知道。

## 127 报过和没报过，是两种病（0.2.115）

上一节把「一件事两种说法」摊了出来。这一节处理摊出来之后的事：**摊开不等于处置**。

一个只报不改的检测器，第三轮就会被读的人自动忽略。这不是使用者不认真，而是它的输出没有变化——
每一轮都是同样几条，长得跟第一次报警一模一样。人的注意力是有限的，一份永远在报同一个问题的面板，
最终只能换来「哦，又来了」。

### 两种相反的情形，长得一样

- **新撞上的**：这一轮第一次出现，需要马上看，看完可能就要动手改。
- **老欠账**：已经报了五轮，一直没人动。它需要的不是「再看一眼」，而是「这次必须做个决定」。

前者是发现，后者是决策。面板把它们印成同一行，等于把决策伪装成发现。

### 追踪只能靠账本，不能靠重算

最省事的做法是「拿现在库里的两条记忆再算一遍，看它们还冲突吗」。这条路的根本问题是：
**记忆是可更新的**。上一轮报的那一对，如果人已经把其中一条改对了，重算就什么都看不到——
于是「处置过了」和「从来没报过」在面板上没有任何区别。而这两件事的含义正好相反：
一个是你已经做完了，一个是还没轮到。

所以追踪读的是**更早那几轮的账**：那些账记着「那一轮看见了什么」，它不会因为后来人的改动而变。
这也顺带解释了为什么必须是「同一张表、同一把尺子」——如果读账的次序和面板的编号对不上，
「第 3 轮」就会指向另一条账，整个追踪就成了一串无法核对的数字。

### 读不到，就别说话

更早的账可能读不出来：库刚建、库坏了、或者这一条本来就已经是最早的一轮。这时正确的输出是
**什么都不说**——不写「这一轮新报」（那是把未知说成结论），也不写「没报过」（那是把未知说成否定）。
一行里少一句，比一句错话便宜得多。

这和上一版「0 与没查必须分开」是同一条原则的两个面：**「没有」和「不知道」在面板上永远是两句话。**

### 催办的门槛

报过两次不催，报过三次才催。理由不在算法，在人：只隔了一两轮，很可能只是还没来得及处理。
第三次还挂着，说明它被反复看见、却始终没人碰——这时候需要有人明确地说一句「这一对要么处置，
要么承认它是两件事」。
催办也只点最严重的一对：一次列五条「快去处理」，只会让人把整块跳过，连新发现的那条也一并跳过。

### 这一版换来的东西

冲突块从「每轮都要从头读一遍的清单」变成了「有变化的清单」：新出现的标新报，老账标它挂了几轮，
挂到第三次点名。**面板的价值不在于它记了多少，而在于它每一轮和上一轮有什么不一样。**

## 128 消失也是一种证词，只是它不说话（0.2.116）

127 解决了「这一对报过几次」，留下一个反向的洞：**上一轮报的那一对，这一轮从账上消失了**。
面板上它只有一种表情——不在——底下却是三件相反的事。

### 三种消失

- **真处置了**：取了新说法，关键词不再撞，检测自然不响。这是好消息。
- **条目没了**：一条被归档或删除，连比都没得比。这是干净的坏消息。
- **只是错开了**：有人改了正文，数字改一致了、关键词删了一个，两条还在、结论其实没统一，
  只是闸门刚好不响。这是**最危险的一种**，因为它跟第一种长得一模一样。

第三种才是这一版存在的理由。一个只看「报没报」的系统，会把「动了半下」全部记成「做完了」。

### 判据为什么只能是"看现状"

最直觉的做法是拿现在的库再跑一遍冲突检测，看这一对还冲不冲突。这条路在 127 里已经被否掉一次
（拿今天的库去猜昨天的判断），在这里还多一层问题：**「现在不冲突」和「以前被处置过」是两件事**。
把正文里的数字改成一致的，确实是处置；把关键词悄悄删掉让检测错开，也是「现在不冲突」。
两者在重算的结果上完全一样。

所以这一版看的是**那两条现在的样子**：还在不在、`status` 是什么、`updated_at` 有没有动过。
这不是判决，只是证词。人打开正文，判决才发生。

### 「没动过」必须显式说出来

这一版最容易做错的地方是留白。如果一对照样还在、谁都没碰过，只是检测不响了，最自然的实现是
**什么也不写**——因为它「没有异常」。但读者看到的是「不在了」，会自动补成「解决了」。
零信息量的一格留白，会被读成一句好消息。

所以三种尾巴必须分开写：读不到就说读不到；一点没动就说「多半是关键词 / 数字刚好错开，不是处置」；
动过就说「上面只是后来动过什么，不等于这一对真解决了」。**没有一句话可以省略，因为省略本身就是断言。**

### 一次只摊三对

消失的对子可能很多，但一屏里列五条「这一对没了」只会让人把整块跳过。所以只摊前三对，
剩下的写「还有 N 对没列」。和 127 的催办只点最严重一对是同一条编排原则：
**面板要让人看得下去，才有机会被读。**

### 这一版换来的东西

冲突这一条线从「报了什么」走到了「报了之后怎么样了」：发现 → 挂了几轮 → 这一轮去哪儿了。
三段都在账本里，一段都不靠记忆，一段都不靠重算。而每一段都刻意停在事实边界上：
系统只负责把「哪一条动过」摆出来，谁对谁错、要不要动手，仍然是人打开正文之后的事。

## 129 删除是最省事的答案，也是最不可逆的那个（0.2.117）

写记忆这件事，大部分插件到最后都会遇到同一个动作：这条旧的不对了，处理掉。Mem0 的顺序是 ADD /
UPDATE / DELETE / NOOP，四种里 DELETE 最干净——库里不留痕，检索时也不会再冒出来。干净是优点，
但**在记忆库里，干净常常就是「信息被你亲手杀掉了」**。真实的记忆里，一个人不会因为改了主意就
忘掉自己以前怎么想的；他记得「我以前是这么认为的，后来不是了」。后一种状态比前一种信息量大得多：
它同时告诉了你现在的结论，和这个结论是从哪来的。

所以这一版没有做遗忘，做的是**降格**：旧条目改 `status = stale`，正文末尾追加一句
`（已被取代：<新 id>「<新内容前 24 字>」，<日期>）`，别的一个字都不动。它还在库里、还读得到、
检索还找得到，只是不再算「在用」。

### 为什么不是「删掉更省事」

三个具体的理由，不是道德上的：

1. **判错的代价不对称。** 该取代的没取代，代价是库里多一条 stale 条目，检索时排在后面——
   一次小小的噪声。不该取代的取代了，代价是一条真记忆消失，而且**没有任何地方能查回来**。
   两个代价差了一个数量级，所以默认动作只能是保守的那个。
2. **「后来改主意了」本身是知识。** 一条决策记忆的价值不止在结论，还在「它替换了什么」。
   写下来之后，下一次有人问「为什么当初不这么做」，答案就在正文里那半句话里。
3. **删除会让账本说谎。** 0.2.115 / 0.2.116 做的跨轮追踪和去向，都是靠「这条还在、状态变了」
   推出来的。真删掉之后，「这一对不再报了」和「这一对被解决了」在数据上完全一样——
   那两版的功夫就白费了。

### 为什么要一句「已被取代」

只改 `status` 是不够的：`stale` 只说明「完结了」，不说明**被什么完结**。下一个人打开这条记忆，
看到的就是一段孤零零的旧结论，没有任何线索指向新的那条。所以正文里必须留一句带 id 的指针——
它是这条记忆唯一的出口。

这句话刻意做得很短（24 字 + 8 位 id + 日期）、格式固定、用全角括号包住：**它要能被 grep，
也要能在中文正文里读得顺。** 短到不喧宾夺主，长到能认出是谁顶掉的。

### 为什么挂在 memory_remember 上，而不是新起一个工具

工具分工要清楚：`memory_remember` 就是「往库里写」，`memory_update` 就是「改一条已有的」。
「写新的，同时把旧的降格」是**写**这件事的一部分，不是第六件事。新起一个 `memory_supersede`
会带来三个麻烦：调用方得多记一个工具名；两个工具之间可能出现「新的写失败了、旧的已经被降格」
这种半截状态；以及面板上又多一种卡片要维护。

一个参数就够，而且它天然带着「这次写的是谁」这个上下文——取代句里的新 id 不用调用方再传一遍。

### 为什么每个失败都要单独说

`markSuperseded` 里最长的部分是分支，不是主路径。因为这一串分支里，**有五种「看起来像成功」**：
没找到、已归档、已经标过、短 id 撞了、写库失败。如果统一回一句「处理完成」，调用方会以为旧条目
已经被处置，而它其实还好好地排在召回位里——**下一次 dream 又把这一对报出来，而人会以为已经修过。**

（写库失败那一条尤其：`memory_update` 返回非 ok 的时候，如果不单独说，整段回执里就只剩
「新条目写好了」，读者会自动补成「旧的也处理了」。）

### 没做的那件事：判决

这一版所有判断都是机械的：id 对不对得上、状态是不是 archived、正文里有没有那句标记。
「这两条是不是同一件事」不归它判——那是人（或读账的模型）的事。

学 Mem0 用 LLM 做 ADD/UPDATE/DELETE 看着更聪明，但代价是把「哪条记忆没了」交给一个不可复现的
判断。记忆库是要被人翻旧账的地方，翻旧账时最不能接受的就是「不知道当初为什么这么改」。

### 补记：短 id 不是身份，读出来才算

这一版快收尾时被一个时红时绿的探针拦住，原因值得单独写一段：**meow 的 id 前缀是时间编码**，
同一秒里先后写下的两条，前 8 位一模一样。于是「拿刚写那条的 id 前 8 位去取代前一条」——
最自然的那个用法——会把新的自己也命中。

当时的实现是先用字符串前缀判「这是不是我自己」：

```
if (asked === newId || String(newId).startsWith(asked)) → 跳过
```

逻辑上没错，事实上错了：**前缀是推测，不是身份。** 两条不同的记忆可以共享同一个前缀，
而「是不是同一条」这件事，库里明明有权威答案——`memory_read` 读出来的 `id` 字段。
用推测去替代一次查询，省下的是一毫秒，赔进去的是一整次处置（用户以为旧的降格了，实际一个字没动）。

修法因此不是「加点判断」，而是**把顺序倒过来：先读，读出来再判**。撞车时还有个额外收获——
`memory_read` 的歧义回执里本来就列着候选 id，把「刚写的那条」排除掉之后如果只剩一条，
那不是替你挑，是**排除法**；照办，但要把「为什么是这条」写进回执，否则读起来仍像我擅自做主。

这条教训可以推广：**凡是能从库里读出来的事实，就不要用字符串去猜。** 猜错的成本永远是静默的。

## 130 名次是唯一能跨两路比较的东西（0.2.118）

一次检索问了两个系统：本地按关键词算一遍，星图沿关联走一遍。两边各自排了名次回来，然后把两段
文本上下拼起来交给读者——同一堆记忆出现两遍，第二遍白花 token；而「两条路都命中了同一条」
这件事，恰是相关性最硬的证据，拼在一起之后反而看不见了。

融合的第一反应通常是拿分数加权。但两路的分数不同源：一边是词频×重要度×时间衰减，一边是
直接命中加沿边扩散的强度。同一个 0.8 在两边的意思不同，两组分布也对不齐。这时候加权求和，
得到的是一个看起来精确、其实没有依据的数字——**精确不等于正确，算得出来不等于算得对**。

所以只合名次：`1 / (60 + rank)` 两路相加。名次是两条路都确实说过的话，跨路可比；分数不是。
k=60 把头部差距压平，让「两路都命中」稳定地排在「单路第一」之上——交叉验证胜过单路自信，
这本来就是集成方法里最朴素的道理，不需要新理论。

写下来三条通用的话：

1. **要合两个系统，先找它们真的共有的量。** 名次共有，分数往往不是。硬合不可比的量，
   不是融合，是把噪声搅匀。
2. **证据要说出来，不能只是存在。** 「两路都命中」在数据里是有的，在回执里是看不见的；
   看得见的证据才会影响下一次判断。
3. **改上游的契约 vs 在自己这一层解析**：前者会连带改掉别人的 render、别人的断言；
   后者只在形状变了的时候静默退回。选后者，并且把窄解析写成「认不出就退回」，而不是猜。

补记：融合是「回答方式的改变」，不是「数据形状的改变」。凡是为了一个新特性去改别人已经公开的
出参，都要先问一句：这份代价买回来的是不是只有我这一层的好处。

## 131 检索不是索引，它得能自答（0.2.121）

一次 `memory_search` 回执只有抬头：项目、层级、id、时间、关键词。要正文？再 `memory_read` 一次。
十条命中就是十一次往返，而模型读完抬头根本不知道哪十条该细读——它只有关键词。

这不是排版问题，是**定位错了**：把自己当成了索引。索引的任务是「指路」，但记忆检索要交的是
**答案本身**。判断一个检索系统好不好，第一条是「召回的信息是对的」，那就得让读者看见信息，
而不是看见信息的地址。

更难看的是那个旋钮。`content_max` 一直在 `execute` 里乖乖截断正文，预算收缩也一直在调它——
可回执里没有正文，于是「调 content_max」这个动作对读者零影响，尾注却认真写着「content_max
300→60」。**一个不产生效果的参数，比没有这个参数更坏**：它让人以为省了 token。

修法朴素到没什么可说的：已经截好的正文印出来，截了就明说截了，指一条取全文的路。顺手把
`keywords` 里的 `YYYY-MM-DD` 抬到抬头——`relativeTime` 只在 30 天前才落到绝对日期，「5 分钟前」
回答不了「那天是几号」，而时间类问题要的正是那个绝对日期。

同轮还补了另外两处「排得对却答不出」。一是词干：`tokenize` 原来按**会话语言**决定要不要做词干，
中文会话里英文记忆永不归一，`researching ≠ research`，一题问「研究什么」就永远差一个词——
语言是文本的属性，不是会话的属性。二是元数据：`search()` 出来的命中把 `keywords / project /
created_at / source_session` 全丢了，每个下游各自按 id 回查一遍，这些重复实现迟早有一方错。

三条通用的话：

1. **回执的形状决定它能被怎么用。** 只给地址的回执只能当索引用；要它当答案，就得给答案。
2. **参数没有效果，本身就是缺陷。** 每次改完一个旋钮，都该问：拉扯它，读者看到的东西变了吗？
   没变就是空旋钮，而空旋钮会被人当成省了钱。
3. **判断「这段文本属于什么」，看文本，别看上下文。** 会话语言、工作区、用户偏好都是环境的属性；
   文本自己的属性只能从文本里读。

代价要说清：正文进回执是本轮唯一变贵的地方，每条最多 300 字。但贵的那一段现在真的能被 `budget`
压下去，而压下去的时候尾注会写出砍了什么——**可控的贵**和**说不清的贵**是两件事。

## 132 检索要先问一句：这条记忆在讲谁（0.2.122）

问「Caroline 研究什么」，BM25 返回的是「谁提到了 research」。这两个问题长得像，答案不一样：
一条三次提到 Caroline、却没提到 research 的近邻条目，会输给一条满篇 research、与 Caroline 毫无
关系的段落。

这就是纯词频检索的天花板：它衡量的是**措辞重合**，而人要的是**讲的是不是那件事**。实体是这两者
之间最便宜的一道桥——专有名词几乎不会因为换种说法而消失，Caroline 就写 Caroline。

落地只有十几行：从问句里认出专有名词（跳过句首那个「只是大写」的词），用同一套 tokenize 归一到
`carolin`，然后 `s *= 1 + 0.8 * 覆盖率`。1,540 题上 hit@20 0.7331 → 0.7526、MRR 0.4551 → 0.4792。

有意思的是**没用的那几条**：短语加成、日期加成、伪相关反馈、子句拆分、共现实体扩散，都试了，
全是零或负。它们不是坏主意，是已经被 `min_rel`、近似重复折叠、blind/fresh 那套机制吃掉的东西，
再叠一层只是在噪声上加噪声。

三条通用的话：

1. **先验要乘性、要能恒等。** 乘性保证「只调整同批候选的相对次序」，没有信号时乘 1 恒等——
   这才敢默认开启。加性先验既会改变量纲，也会让「没命中任何实体」的文档无端掉队。
2. **得有总闸。** `entityPrior: false` 不只是排障开关：没有它，「加了没变化」和「加了没生效」
   在观测上完全一样，而这正是检索类改动最容易骗过自己的地方。
3. **负结果比正结果值钱。** 五个改法里只有一个是真的，另外四个如果没被记下来，下一轮还会再试
   一遍。检索优化的成本大头从来不是想点子，是重复验证旧点子。

## 133 一条记忆不是一句话，是一段对话里的一句（0.2.123）

我们一直把「检索单位」当成理所当然：一条记忆 = 一行 = 一个可以被单独读懂的事实。可真实写入的东西
不长这样——对话里的一句「好，几点集合？」离开上一句就什么也不是，而下一句才是答案。

0.2.122 的实体先验把「这条在讲谁」做进了分数，0.2.123 换了个问法：**一条命中该算多大？**
离线台给出的答案是「前后各一条」，hit@20 从 0.7526 抬到 0.8656，MRR 从 0.4792 抬到 0.5856，
而排序一分没动。这不是调参，是换了度量单位：从「句子」换成「句子 + 它的邻居」。

代价必须明说：token。所以 `context` 默认 0，开的时候由调用方付费，回执里 `↑`/`↓` 标清楚哪几句
是邻居、哪一句是命中。上下文不是召回扩容，别拿它替代 k。

## 134 参数不是「写进 meow 就算数」：融合层有它自己的一扇门

0.2.123 给 meow 加了 `context`，探针全绿，我就以为功能上线了。可 D2 的体积一个字节没动——
那不是「宿主投影不吃描述」，是**融合层的 `memory_search` 根本不看 meow 的 schema**：
它自己写了一份参数表，参数不在 `pick` 列表里就传不下去。直调 meow 有窗口，走统一工具没有。

这是双引擎架构的结构性风险：**每一层都有自己的门，功能要过两道门才算上线**。所以判据不能只打
子插件，必须从统一工具打进去（CT5/CT6 就是这么写的）；也不能只看「体积变了没」，
体积不动本身就是一种信号——要么没生效，要么走到了另一条路上。

顺带定下预算的次序：装不下时先关窗口，再砍字。窗口只是让读者多查一次，砍字是让答案消失。

## 135 检索给的那句话，得自报「这是哪天说的」

端到端台上最刺眼的一组数：材料里没有日期时，时间类问题只有 3.1%；把会话日期贴上，同一批题
跳到 17.1%。检索没问题——命中的就是那一句；缺的是「这一句是什么时候说的」。相对时间
（「5 分钟前」「2 年前」）在这类问题面前等于没说。

所以日期不是装饰，是记忆的一部分：`updated_at` 一直都在，只是没人把它印出来。补上它只用两行，
换来的是 4.3pt（单条）与「时间类从近乎全错到能答」。顺带把邻居行也带上日期——窗口的意义是
「这段话前后在说什么」，前后各自是哪天，同样得说清楚。

## 136 重复印一遍不是保守，是让模型把同一条读三遍

窗口解决的是「一句话不够」，可窗口会互相重叠：命中挨着时，上一条的下文就是下一条本身。
于是同一句话在回执里出现两三次——花的不是存储，是模型的注意力，而且读到第三遍时它开始
补细节、把「后天」说成「明天」。所以去重的对象不是文本，而是**条目身份**：`level:id` 印过
就不再印，命中体永远由它自己的表头负责。同一把尺子量出了另一个洞：窗口没有预算，8 条命中
× ±3 能把回执撑到比材料还长。离线台给的答案是 24 行——和 ±1 逐条一样多的字，多 2.6pt；
再砍到 16 行就掉 4pt，因为多跳题的第二条线索正好在第 17 行之外。省 token 和少给东西是两件
事：前者可以悄悄做，后者必须留一行说明还剩多少没铺开。


## 137 「多给一点」不等于「给对了」：时间重排与二轮检索都被全量否掉
直觉上有两个便宜的升级：材料按时间排好、检索跑两轮。两者都在 1,193 题上同题配对测过，都输。
时间重排（39.0% vs 39.2%）把「哪条最相关」的名次暗示冲掉了，多跳题涨的 2.2pt 被 cat3/cat4 丢的
更多抵掉；二轮检索（38.5%）捞回来的只是同义噪声。真正有效的仍然是「让每条命中带上它在对话里
的位置」——窗口，+8.0pt。

而窗口给多少行，也不是越多越好：16→24 显著（p=0.027），24→32 不显著、还要多 28% 字符，
32→48 持平。所以 24 是曲线拐点，不是审美。判断一个参数该定多少，标准是「再加一档还能不能
买回分数」，不是「看起来更完整」。

## 138 「精确到分」不是细节，是让两条记忆可比

回执曾经只给日期。于是在同一天里，两条互相修正的记忆在模型眼里一样新，先后只能靠名次猜——而名次是按相关度排的，
不是按时间。这不是「信息少了一点」，是「给了个会误导人的相等」。

修法不是把所有地方都加上时间。试过逐行加（S 臂 40.4% / 3,796 字符）、只加时分（M 臂 42.4% / 3,605 字符），都不如
把块头整体归一成 `2023-05-08 13:56`（N 臂 44.3% / 3,414 字符）。原因很朴素：同一段对话的邻居本来就在同一天，逐行
重复分钟数只是占地方；真正需要精确到分的只有「这一条」——命中自己。

一条经验：**同一个事实在回执里出现几次，就该有几份价值**。重复印一遍是噪声（9.130），重复印一遍的时间也是噪声。
判断该不该加字段，看的是「加了之后模型能多做哪个判断」，不是「看起来更完整」。

## 139 「比大小」是一种能力，不是一条信息

给模型更多时间信息不等于让它更会算先后。omni11–omni14 四轮、每题配对的结果很干脆：
每条都补上分钟（40.4%）、每块补「比最早那条晚 N 天」（42.9%）、把时间轴换成正文前十个字（43.9%）——
都不如「一行按早到晚排好、带编号」的那版（46.5%，p<0.0001）。

差别不在信息量，在**可比性**：模型不需要知道每条的时间，它需要一眼看出「[3] 在 [1] 之前」。
一行时间轴把「八次比较」压成「一次顺序」，而编号是把那一眼钉到具体段落上的钩子——没有钩子，时间轴退回成装饰。
顺手得到的纪律：这类能力只在被问到时才值得花钱（问句含时间词才印），否则单跳题反而掉分。

## 140 「不知道」是最贵的答案，这句话挂哪儿决定了它值多少

同一句提示，写在 system prompt 里值 +8.3 个百分点（45.9%→54.2%，答「不知道」的比例 25.6%→0.3%）；写在回执开头或结尾只值 +1.4（47.4%）与 +1.3（47.3%）。

模型不是在读材料时决定要不要答，而是在自己的指令层决定要不要答。材料里的旁白只是「材料」，指令层的话才是「命令」。所以：

- 想改**回答行为**，就把话放进 system prompt；meow 的入口是 `lib/prompts/*/system-guide.md`（经 `getMemoryGuide()` 进 `meow-memory:guide` 段），不是工具描述，更不是每次回执多印一行——后者既多花 token，又几乎不起作用。
- 想改**检索结果**，才动回执。

顺带的教训：我先前为「材料不够」做了两轮剪枝（会话剪段、窗口重排），一次 −21（p=0.0040）一次净 −2（p=0.96）；而一句 0 字节材料成本的提示拿了 +108。**先问瓶颈在谁的决策上，再决定动哪一层。**
## 141 材料不是越多越好，是越准越好

0.2.130 之后我把材料侧的旋钮全拧了一遍：窗口放宽（±3、±4）、候选加多（k12）、按会话分多样性、把问句的实体词再搜一遍、把问句实词再搜一遍、给没覆盖的会话补一段、窗口级重排、会话级 IDF 覆盖排序——十来个版本，1,193 题同题配对，**一条显著为正的都没有**。这不是运气问题，是这些旋钮都在同一个维度上：词法的召回。

真正说明问题的是那个 oracle：把检索换成数据集标注的证据位，同样 24 行、同一句提示，准确率 54.6%→62.4%，材料从 3,453 字符掉到 1,102 字符。也就是说，**现在的回执里三分之二是噪声，而模型有能力从更少的材料里答得更准**。我们过去每一次「多给几行」都在涨，是因为多给的那几行里恰巧有证据；一旦预算固定，继续加行就等于用噪声换证据。

所以「材料侧还剩多少油水」这个问题的答案不是「再加点」，而是「挑准点」——而那需要一种词法给不出的判别：这段文字到底回答了这个问题没有。词法只能判「像不像」，判不了「够不够」。这也解释了为什么模型挑段（omni19 H2）能 +2.2pt，而所有词法重排都是 0：收益不在排序，在删掉那些「像但没用」的段。

还有一条反例值得记住：cat2（时间题）在 oracle 下反而从 48.3 掉到 32.4。时间题的答案往往不在证据那一行里，而在「哪一次会话、什么时候」这个上下文里——把它剪成一条证据，就把时间线剪断了。**同一套剪裁策略对不同题性不是同号**，所以「按证据剪」不能变成全局规则。

## 142 原子条目的命中面是一条隐藏预算

omni32 之前，我一直把「记忆写得越原子越好」当成不需要论证的事——一条记忆讲一件事，检索、更新、删都方便。可把它放进 LoCoMo 的同一把尺子里，原子条目一败涂地：同样的检索器、同样的 24 行预算、同样的提示词，原始对话行 60.5%，模型抽的原子条目 37.5%，而且原子条目连预算都填不满（2,050 字符 vs 3,659）。

原因不是「写得不好」，是**命中面**：问句通常只有三四个实词，一条 120 字的原子条目能接住一个已经算运气好；而一段五行窗口里有说话人、有前后语气、有同义改写，idf 累加面天然更宽。词法检索吃的是「词撞上」，条目越短，撞上的概率越低——这不是噪声问题，是我们把「会被问到哪些词」这件事从条目里剪掉了。

补上会话级门牌号词（那一段对话里 tf-idf 最高的十二个实词）能把 S 从 37.5 拉回 46.9，cat4 从 45.2 拉回 64.5——机制被证实。但它追不回原始长文本：`she`、`they`、`the week before` 这些指代，只有邻行在场才解得开，原子化把它们连同答案一起剪走了。

所以「原子化」不是免费的，它的账单开在召回上，付款方式是「条目里要替读者留好门牌号」。这条规律对产品和对基准同样成立：给 agent 写记忆时，一条事实该带的是「以后问它时可能出现的那些词」，而不是「当时说这句话时用的那个词」。

## 143 写记忆的人写不出「以后会被问到的词」，但语料算得出来

上一节（142）留下的账单是「条目里要替读者留好门牌号」。我试过最自然的付款方式：把这条写进写入提示词，让模型每次写记忆时自己补上「以后可能被问到的说法」。两轮、两个规模、同题配对，值是 +2（p=0.9310）和 +10（p=0.1986）——都在噪声里，而关键词数确实从 4.9 涨到 5.9，条目的字符数只多了 6 个。模型很听话，可它补出来的是「当时那句话的别的说法」，不是「这一段对话到底在讲什么」。

同一批条目上，把这 12 个词换成机械算出来的会话 tf-idf 前十二，值 +48（p<0.0001），而且和「随便补 12 个全局高频词」（+38 的差，p<0.0001）划得清界限。也就是说：**值钱的是词的来源，不是词的数量**。

这条区分很关键，因为它划定了提示词能买什么、买不到什么。提示词能买「行为」——先备份再动手、查不到要说明、问时间就印时间轴；这些都不依赖数据，模型读一遍就能改。提示词买不到「统计」——哪些词在这个语料里罕见而在这段里反复出现，模型没有语料级视角，它只看得见自己正在写的那一句。把统计问题写成纪律，得到的是模型的语言习惯，不是语料的分布。

所以引擎该做的不是「教模型多写词」，而是「在检索时替它算好词」。这件事零写入成本、零迁移代价（老条目没有 `source_session` 就整段惰性），也天然可关。顺带一条工程经验：改 vendored 大文件必须保住行尾——我把 CRLF 洗成 LF 之后，34 条断言一起红，而真相是全文行尾变了，不是逻辑坏了。
## 144 行数不是预算，是匹配问句类型的旋钮

0.2.126 把邻居封在 24 行，理由是「再多花字不换分」。0.2.132 的一个发现把这条推翻了一半：
24 行的上限在**问时间的题**上是对的，在**不问时间的题**上低了整整一档。

三次独立复跑（LoCoMo 1,193 题，同题配对）：「时间题 24 行、其余 48 行」57.6 / 57.5 / 58.2，
「一律 24 行」54.4 / 54.9 / 55.4，净 +31~+38，p≤0.0001。而「一律 48 行」56.9 / —
时间题被拉低 4pt：多出来的段落把日期稀释了，答案里那个锚点反而找不到了。

两个反直觉的点：

- **中间档不存在**。36 行（+50% 字符）净 −4，p=0.85。40 行不会「拿到一半的增益」，
  要么给到 48 行，要么维持 24 行。
- **加段数没用**。24 段各 ±1 行和 8 段各 ±2 行一模一样（净 −4）。命中条数翻倍不换分——
  材料里真正值钱的是「命中前后那几句」，不是「再多几条命中」。

于是工程上只做一件事：把邻居行预算绑到**同一个时间词闸门**上。那个闸门 0.2.129 就有
（`TIMELINE_CUE`，时间轴只在问句问时间时印），现在它同时决定两件事——印不印时间轴、
邻居铺几行。一个问句只看一次「是不是在问时间」，面板和回执不会出现两套口径。

省 token 这一侧不让步：行数放开到 48，字符数锁在 7,000，谁先到谁停。截断提示写的是
当下这一档的行数，读者不会以为自己看到的是全部。

## 145 一个词刷十遍，不如五个词各一次

记忆的条目形态和文档不一样：正文很短，真正值钱的是那 8~13 个「用户以后会怎么问」的关键词。
可 BM25 是为长文档设计的：把 title、正文、keywords 拼成一个字符串，等权地数词频。
于是库里出现了两种荒谬的排序——

1. 一条把「面板」写了十二遍的随手记，压过一条「面板和口径不一致」的复盘；因为加法式打分没有覆盖度概念，
   十个词里命中一个、命中十次，就赢了命中五个词各一次。
2. 一条认真写了 13 个关键词的条目，正文被长度归一稀释得最狠；**写得越全，越捞不上来**。

这两条的修法都不是「调大某个权重」，而是把打分器缺的那两件事补上：覆盖度是乘法闸（`1 - 0.35 + 0.35 * cover`），
字段是乘法加成（title +0.6 / keywords +0.35），长度只量正文。三条都只做乘法、都不筛候选，所以排序变了、召回集合没变，
随时能单独关掉回退。

真正被记住的一课是探针的写法：拿「1 个 token 的正文」当对照，补丁的效果会被长度项整个盖掉，
七条断言红了三条，看起来像补丁没用。**对照组的正文长度必须对齐，否则你测的是归一化，不是补丁。**

顺带修掉的反思闸门暴露了同一类毛病：判定条件写的是「连续几个非记忆工具步」，
而干完活收尾那步几乎总是写记忆——**于是最该反思的一轮，恰好被「你刚写过记忆」这个理由豁免**。
条件写成「最后一步不是什么」的时候，先问一句：收尾那一步通常是什么？

## 146 事故不是被用户说出来的，是被工具失败说出来的

反思什么时候该发生，这件事很容易被做成「定时器 + 关键词」：攒够 N 步看一眼，用户骂人了就立刻看一眼。
两个都很便宜，两个都不对。

错的不是参数，是代理量。**步数**代理「干了多少活」，可干得多不等于出了事——一次顺畅的十步重构不该
被叫停；**骂人**代理「出了事」，可事故先发生、骂后发生，中间隔着一段没人反思的时间，而人心情不好
也可能只是心情不好。

真正的信号一直在场，就在工具结果里：`isError: true`。它不猜、不迟到、不看语气。于是判据可以写成
一句朴素的话：**这一轮有没有东西坏了；坏了几个；坏在谁身上；同一个坏了两次还是三次。**

两档而不是一档，因为「坏了」不等于「出事了」。一次 `exit 1` 通常是命令写错一个引号，模型下一步就能
自己修；同一把工具连挂两次、一轮挂三次、记忆工具自己挂掉、整轮以 error 收场——才值得当场打断任务
去反思。前者压到 3 步（提前但不打断），后者 1 步（当场）。这两档还都只能往前压：用户把轮数调小，
事故不许把它反而推后——否则「更敏感」的配置会变成「更迟钝」的行为。

还有一条容易被漏掉的：**插件自己的工具挂了，账要先记在自己头上。** `memory_search` 报错不是环境的
问题，是这个插件的 bug，它比任何外部失败都更该触发一次反思——那正是「下次怎么早发现」的原材料。

最后是报文。叫醒了却不说为什么，等于让模型凭空猜「我刚才是不是做错了」；把事故事实（几次、哪个工具、
是不是整轮出错）连同「先判真假事故、抖动不要新建条目」一起递过去，反思才落在事上，而不是落在情绪上。
## 147 第一次是意外，第二次是模式

反思这件事最容易做成「每出事一次，就诚恳一次」。第一次这么写没问题：报文说清事故、要求写 lesson，
模型回一段像样的文字，收工。问题在于**同一件事第二次发生时，系统还是那个反应**——语气一样、要求一样、
甚至是否当场打断都一样。意思是：它没有记忆，只有条件反射。

「第几次」没法从单轮上下文里读出来：反思在轮末跑，前几轮的失败早就滚出窗口了。要么加一个跨轮计数器
（会话级，换会话就清零，正好丢掉最该警惕的那一类——「上次也是这样」），要么落一本账。选了账：
一行一次硬档事故，纯文本 jsonl，200 行封顶，24 小时窗口。它可以被 `cat`、被 grep、被主人直接看。
状态文件一旦需要「专门的工具才读得懂」，排障那天就会变成没人敢碰的黑盒。

两个刻意的取舍：**只记硬档**（soft 的零星失败写进去，账本会变成噪声，噪声会把「第二次」淹掉）；
**只认工具名**（不认句子、不认人，同一把工具反复坏才是可修的东西）。

另一半是闭环。反思是一条发出去的消息，发出去就算完成——这是整条链路里最松的一环。加一张待验卡：
发反思时写下 `{t, kinds, tool}`，下一轮收尾先结算，看这一轮有没有真的调用 `memory_remember` /
`memory_update`。没有，就记一笔 `no-followup`，等下次事故时在报文里直接点出来：
「上次你也反思过，但什么都没写进记忆。」

这里坚持用**工具调用**做判据，而不是看模型说了什么。文本判断「他是不是真的反思了」永远会被
一句漂亮的总结骗过去；而「库里有没有新东西」是硬事实。**能落地的反思，一定在库里留下了痕迹。**

一句话：事故要分级（0.2.134），事件要跨轮（账本），反思要验收（闭环）。三级都成立，
「下次怎么早发现」才不是一句口号。


## 148 重复是措辞问题，冲突是结论问题

去重解决的是「同一句话写了两遍」，冲突解决的是「同一件事写了两遍，但结论不一样」。前者可以靠字面相似度
合并，后者不能——0.2.132 和 0.2.135 两条交付态，字面只有四成相同，一合并就把两个版本搅成一句胡话。
所以冲突判据必须是**硬事实**：版本号、日期这类不可含糊的 token，加一个低门槛的相似度（0.3）圈出候选，
两边 token 集合不同才点名。

三条设计取舍：
1. **只提醒，不改库。** 谁对谁错插件不知道，只有写的人知道。插件的职责是把两个值并排摆出来，
   让人（或模型）在三秒内判断，而不是替人下结论。
2. **出口必须写在提醒里。** 只说「有冲突」是半句话；`supersedes` 与 `memory_update` 两条路要一起给，
   否则读者只能干看着。
3. **窄。** 没有硬事实的重叠一律不报。写记忆是高频动作，一个会误报的检查比没有检查更快地变成噪声——
   用户会学会无视它。

一句话：事故要分级，事件要跨轮，反思要验收，写入要认账。四条合起来，库才不会在几百条之后变成
一堆「都写着当前」的平行世界。
## 149 写的人知道该改哪条，所以更该提醒他

0.2.136 修的是「写新条目时发现旧结论还在」。0.2.137 补的是另一半：**人已经动手改了**。

后者更值得提醒，原因有点反直觉：动手改的人掌握的信息最多，也最容易以为自己已经整理干净了。
他改掉 A 的版本号，B 还停在上一版——B 不在他的视野里，但检索时 B 和 A 一样有资格被召回。
于是「整理过」的库比「没整理」的库更危险：前者只剩一个错误结论没被看见，后者两个都还摆着。

三条取舍：

1. **只认硬事实，两种说法分开说。** 版本号与日期是结论的坐标，措辞相似但坐标一致就是同一件事的
   不同说法，不需要提醒。写新条目和改旧条目用同一套判据，只说不同的话——「写下来了」和
   「落库了」是两种责任：前者是「多了条记录」，后者是「你替换了旧结论」。
2. **只改状态不查。** `status: "stale"` 是收尾动作，不是新结论。对着旧正文反复报警，会让人
   学会忽略这条提示——提醒一旦变成噪声，就等于没有。
3. **文案也是接口。** 中文写死在代码里的提示，在英文会话里就是一行难以理解的字。三语 labels +
   `safeKeyed` 兜底，既让人看懂，也不许因为缺一个键就把写入炸掉。

一句话：事故要分级，事件要跨轮，反思要验收，写入要认账，**改动也要认账**。

## 150 记忆是有履历的，别让它每次都从零说话

0.2.136 解决「同一件事两种说法并排睡」，0.2.137 解决「改的人不知道自己留下了第二种说法」。
0.2.138 处理的是第三种情况：**说法已经被收拾过了，但收拾的痕迹只有一条碑文。**

旧条目上那句「（已被取代：0mwxxxxx「…」）」是写给历史看的。它没有回答使用者真正关心的两个问题：
这条链还有没有更后面的人？我手上这条是活的还是退位的？于是出现两种误判——
拿着退位结论当真话用（因为它正文更完整），或者对一条早就被别人接手的条目再改一次
（改完两条都觉得自己是当前）。

三条取舍：

1. **读，不建。** 链是正文里的标记，不是新表。加 `superseded_by` 列当然更整洁，但那意味着
   迁移、意味着旧库要一次性回填、意味着又一次「升级后第一次检索报错」。既然标记已经写在
   每次 `supersedes` 的正文里，就地解析就够；`existsSync` 在 `getDb` 之前，是为了让
   「没有库」保持「没有库」，而不是为了报一句链顺手造一个空库出来。
2. **先读链，再改。** 改正文会把碑文一起换掉——顺序错了，链就在最该看见它的那一刻消失。
   这类顺序问题没法靠测试覆盖兜底，只能靠一句话把它钉在代码里：**读链发生在动之前。**
3. **近似要说出来。** id 前 8 位同秒会撞，这条链天然是近似的。与其因为不精确就不做，
   不如把口径写在代码注释和文档里：可能点错一条，但绝不会假装没有链。

一句话：事故要分级，事件要跨轮，反思要验收，写入要认账，改动也要认账，**履历要能读**。

## 151 说「大概是谁」的时候，得让人知道有多大概

0.2.138 让链能被读出来，0.2.139 承认它是近似。这两件事必须一起做：
一条**看起来确定**的近似链，比没有链更坏——人会照着它去改一条改不到的条目，
或者以为库里只有一条同前缀的行。

三条取舍：

1. **状态进数据，语气进文案。** `exact / absent / ambiguous` 是 `successionOf` 的返回值，
   不是模板里现拼的词。这样「链指向哪里」可以被测试，「怎么说」才留给写法。
2. **判据抽成纯函数。** `prefixState(ids, prefix)` 没有任何依赖：真库里造不出同前缀的两条，
   但「撞车算几条」这件事必须能单测。测试不该被造数据的难度绑架。
3. **不删信息，只加不确定。** 撞车时仍然把找到的那几条列出来，只是在尾巴上补一句
   「可能记的是它们之一」。闭嘴省 token 的诱惑很大，可这一句正是读者决定要不要信的依据。

一句话：事故要分级，事件要跨轮，反思要验收，写入要认账，改动也要认账，履历要能读，
**读出来的履历还要标明它有多准**。

补一句 0.2.139 里最值钱的发现：**近似不是边角，是默认**。meow 的 id 前半段就是写入时刻，
同一秒写的条目必然撞前缀——所以「8 位前缀」从设计那天起就不是唯一键。
取代句里那个「开头」当初只是为了让人看懂「谁接手了我」，结果它成了唯一的消歧证据：
读的人靠它认人，代码也得靠它认人。可追溯性最后落在「同一件事的两种说法能不能对上」上。

## 152 排序是结论，过滤只是范围

0.2.140 修的是一个很容易被忽略的错位：状态被当成了「范围」的一部分，只决定查不查得到，
不参与「谁先说」。可记忆系统的使用者不是在做档案检索，是在找现在该信哪条——一个被自己标成
stale 的旧结论排在接手它的那条前面，比查不到更糟：查不到会再问一次，排错了会直接照着做。

三条取舍：
1. **降权不隐藏**。历史是证据，删掉就失去了「为什么改成这样」的来路；所以给权重，不给删除。
2. **两个打分器同口径**。BM25 与关键词两路是同一张榜的两半，一边降一边不降，等于按查询长度
   随机决定要不要降权。
3. **权重看得到状态才有意义**。docs 里不带 status，`statusWeight` 就永远是 1——这条教训比
   权重本身更值钱，写进了 verify 的源码锚点。

收尾还是那句：事故要分级，事件要跨轮，反思要验收，写入要认账，改动要认账，**排序也要认账**。

## 153 去重去的是重复，不是结论

0.2.141 之前，检索侧折叠的规则只有一条：榜上先来的留下。榜按分数排，于是它实际上等价于
「写得最像这次提问的那条留下」。问题在于——**同一件事被写了两次，通常不是因为它重要到值得写两次，
而是因为它先被写成结论、后来被修正过**。留下措辞漂亮的那条、悄悄折掉接手它的那条，
是这个系统里最坏的一种安静：回执没错、条数没错、结论错了。

三条取舍：
1. **状态先于时间，时间先于分数**。分数量的是贴合，不是有效。让「还用不用」排在最前，
   等于把去重从「文本相似」这件事里彻底摘出来，交回给记忆本身的状态机。
2. **折了谁要写出来**。去重的价值一半在「少看几条」，另一半在「知道少了哪几条」。只报条数
   不报 id 的去重，等于把追溯性拿去换 token，这笔买卖不值。
3. **出口不动**。`dedupe: false` 从第一天就在，这次一个字符都没改——凡是收窄都要带出口，
   这条规矩不因为「默认变聪明了」而放松。

一句话收尾：事故要分级，事件要跨轮，反思要验收，写入要认账，改动要认账，排序要认账，
**去重也要认账**。

## 154 指向别人的那句话，没人替它核对

记忆里唯一一种**跨条**的引用，是取代句：一条正文末尾写着「（已被取代：<id8>「<开头>」，<日期>）」，
意思是「我退位了，接手我的是那条」。它平时不出声，只有在整理时才有用；也正因为它平时不出声，
它坏了很久也没人发现——那个 id8 可能指向一条已经被删、被搬走、或者同秒写入撞成一堆的记录。

到这里为止，系统在三个地方提过断链的可能：写入时给 `supersedes` 点名、检索时回执里那句「这条已被人接手」、
以及链的诚实那一版把「大概是谁」说成三态。唯独 dream——那个专门负责「把记忆整理干净」的地方——
一直只看正文像不像，从不回头看这些指向还成不成立。也就是说：**系统唯一会坏在引用上，而清理工只看文本。**

三条取舍：
1. **断链不是「该整理」，是「已经整理坏了」**。它必须和第 148 条那种「两条并列，你来挑」的问题分开写，
   否则现成的处置句会被照抄一次，而它恰恰是此刻做不到的那件事。
2. **「不在」和「认不出」不是一回事**。库里 0 条命中，说明那条真的没了；撞了一堆、开头对不上，
   说明它可能好好的、只是没人能证明是哪一条。前者要给重写通道，后者只能让人自己去核对。
   把两者混成一个 `absent`，文案就会替不存在的事实作证。
3. **不加固定开销**。dream 每个窗口都跑，新检查必须做到「没有任何指向就一分钱不花」——
   先扫本轮、见到第一条取代句才去建索引。新功能最容易犯的错是把常驻成本当成零。

一句话收尾：事故要分级，事件要跨轮，反思要验收，写入要认账，改动要认账，排序要认账，去重要认账，
**引用也要对得上账**。

## 155 分数线切掉的不该是「下一步该看的东西」

检索的收窄有两个旋钮：`k`（拿几条）和 `min_rel`（相关度下限）。两个都按分数切，而分数量的是一件事：
**这次提问的字面有多贴**。记忆里却有另一件事跟字面无关：这条还在不在用、谁接了它的班。
两个旋钮都用错了尺子，只是错法不同——`k` 切掉的是尾巴，`min_rel` 切掉的是「不那么像但可能更新」的那一段。

0.2.143 只补了最坏的那一处：被下限切掉的条目里，凡是**榜上某条亲口点名的接班者**，一律提上来。
三条取舍：

1. **破例要有据**。不是「新条目优先」，而是「有取代句指名道姓」。没有证据就不动——
   下限的可预测性比「可能更相关」值钱。
2. **破例要说清**。几条、哪几条、为什么破例，一句话讲完。省下的 token 不能从这里省。
3. **破例有上限**。上限是 `LIFT_MAX`，不是「有多少提多少」：一个旋钮被绕过三次以上，
   说明该调的是旋钮本身的默认值，而不是继续加例外。

一句话收尾：事故要分级，事件要跨轮，反思要验收，写入要认账，改动要认账，排序要认账，去重要认账，
引用要对得上账，**分数线也要认得出班**。

## 156 重复是唯一一种「写错了不会红」的错

冲突会让人犹豫，断链会指不到人，过时会答错——这三种都有代价，代价会在下一次读取时显形。重复没有代价：两条都合法、都能召回、都说得对，只是库胖了一圈。所以它从来没人管，也从来不会红。

**一、只看本轮，还是看全库。** dream 的检测器最初是按「这一轮写了什么」组织的：把它写成「这一轮内部的矛盾」，实现最简单，一次 `flatMap` 就够。但它要回答的问题其实是「库里现在有没有已经写过这件事」，答案必须包含那些在这一轮之前就躺下的条目。范围选错，检测器再准也只能报出一半。

**二、全比，还是建索引。** 2,700 条两两比在纸面上是 370 万次 Jaccard，实测也就几秒——但 dream 不是跑一次就完的工具，它每轮都跑，跑在用户会话里。真正该问的不是「算不算得完」，而是「这一轮值得为它花多少」。索引（正文前缀 + 关键字）不是优化，是把成本从「库的平方」压回「这一轮的条数 × 40」。

**三、报「重复」，还是报「怎么处理」。** 两条几乎一样的条目，处理方向完全取决于对方的状态：对方在用，就并进去再指过去；对方已退位，就先回答「这是复活还是新结论」。同一句「这两条很像」在两个方向上都是错的建议。清单的价值不在「我发现了一个事实」，在「下一步该按哪个键」。

结论只有一句：去重要认账，引用要对得上账，**重复也要有人记账**。

## 157 省下的每一笔，都要问一句「省掉的是钱还是能力」

0.2.18 砍掉每轮自动邻域注入时，账是漂亮的：每轮少付一段固定开销。半年后回头看，真正被砍掉的不是 token，是**检索的默认路径**。记忆系统的价值不在「库里存了多少」，在「该用的时候它在不在场」。一个只在被点名时才出现的记忆库，用得越久越像摆设。

**一、「按需」是一种理想状态。** 按需拉取的前提是调用方知道自己该拉。人不知道，模型也不知道——它不知道自己不知道什么。自动注入的意义不是替模型省一次调用，是替它补上「你不知道有这条」。所以省 token 与记忆强度不是同一条轴上的两个刻度，取消自动注入根本不是一次「优化」，是一次能力下调。

**二、代价可以封顶，能力不能打折。** 邻域注入真正的成本结构是「每轮 × 不可预测长度」，而失控的从来不是条数而是长度。封顶之后（4 条 / 420 字符 / 不带重复），它是可预算的固定项，而不是一个随对话膨胀的开口。能封顶的成本，不该用「关掉」来省。

**三、进哪个位置，比进多少更重要。** 同样的内容塞进 system prompt，每轮重算整段前缀；追加在用户消息尾部，前缀一个字节不变。很多「注入太贵」的结论，其实是「注入位置错了」的结论。先问位置，再问分量。

**四、自动带来的东西必须自报家门。** 当一段话不是用户说的、却被放在用户的位置上，模型就会把它当事实引用。来源标记、块首声明、读全文的出口，这三样不是礼貌，是让「自动」不至于变成「造谣」的唯一办法。

结论：省 token 是亮点，**记忆在场才是本事**；能封顶的成本用封顶解决，别用取消解决。

## 158 停用词表的缺席，是一种沉默的精度损失

**一、精度损失有两种，只有一种会响。** 给错的加分会被看见——回执上明摆着一条不相干的东西。对的不给分也会被看见——查不到就是查不到。第三种没人看见：**所有候选都拿到一点点分**，于是回执上八条看起来都沾边，读者以为「大概是这些」，然后自己去猜。停用词表的缺席属于第三种，它从来不报错，只让每一条看起来都差不多。

**二、阈值要找一条不需要人来维护的线。** 中文停用词表是最容易开始、也最容易腐烂的东西：口癖、混语言、项目黑话，永远补不完，而且每次补都无从验证。df 反过来问——「这个词在你这一库里到处都是」，这个判断不需要任何人维护，因为它由库自己回答。**能被数据回答的问题，不要用词表回答。**

**三、「更严格」和「更难满足」是两件事。** 把噪声词从分子里剔掉、却留在分母里，覆盖度门槛就原地抬高：真正相关的那条也因为「没覆盖满」被裁。表面上检索变严了，实际是问句变难了。任何缩窄动作都要问一句：分母跟着动了吗？

**四、不说出来的口径变化，等于埋雷。** 剔掉哪些词、为什么剔，必须写进 `explain`。一个不解释的口径变化，下一任维护者只有两个选项：照抄，或者不敢碰。

结论：**静默的精度损失最难发现，因为它的症状不是错，是「都差不多」。**

## 159 分词器不认识的东西，检索就永远装不认识

**一、切词是检索的第一次解释，而解释会丢掉东西。** 中文没有空格，二元组切分是个实用的妥协：它让「星图建图」和「星图 建图」等价，代价是**任何本该整体的东西都会被切碎**。版本号变成三个数字，文件名变成前缀加扩展名，路径变成一串段名。切碎之后，BM25 仍然算得很起劲——它不知道自己在算什么。

**二、所以判据不能靠词表，要靠「形状」。** 加一张「哪些词不要切」的表，等于让维护者去枚举人类的所有命名习惯：版本号、日期、commit、kebab、snake、带扩展名的文件、带盘符的路径……这张表永远差一条，而每差一条都是一次静默的失效。形状判据反过来：**问句里长得像标识符的那一段，就按整段去候选文本里找**。找得到就是 1，找不到就降级找 basename，还找不到就认 0。不猜，只比。

**三、证据有强弱，就别用一个布尔值糊过去。** 「id 就是这一条」比「正文提到这个标识符」强得多，「只有文件名对上」比「整串对上」弱得多。这三档如果都按「命中」算，最弱的那种证据会和最强的那种换来同样的分，而用户读回执时看不出区别。0.2.147 把它们分成 1 / 0.7 / 0.5，并且**在回执里标出「(局部)」**——读者有权知道这条是被文件名勾出来的。

**四、加法是唯一能让「原来进不了榜」变成「进榜」的运算。** 乘法修饰的是已经存在的分数，它只能让本来有分的更高；而标识符失效的典型症状恰恰是**分为 0**：id 不在正文里，路径被切碎，版本号三段全是常见词。乘在 0 上还是 0。加法承认这件事：先有一个「单位分数」，再把这个证据叠上去。叠加之后仍然要能被噪声压住——所以权重不高（0.6 / 1.5），只在词侧几乎放弃（分很低或为 0）的时候才真正翻盘。

结论：**能被切碎的东西，都得有一条不被切碎的路。** 分词器是手段，不是世界的边界；当手段解释不了输入的时候，正确的做法是加一条旁路，而不是要求输入长得更像词。

## 160 同一件事的两条证据，不能在最后一步被权重改判

**一、加法写在哪里，决定了它是不是加法。** 把一笔证据加进「词分」，看起来已经是加法；但只要后面还有 `score = raw × 权重` 这道乘法，这笔证据就会跟着被乘一遍。于是「问一条 id」这种最强的证据，反而被「importance 更高的一条措辞命中」压下去。位置错了，顺序就错了；顺序错了，用户看到的是系统明明认出来了却不肯说。

**二、权重量的是「这条值不值得看」，不是「用户问的是不是它」。** 重要度、新鲜度、生命周期都是**在同题竞争里决定谁先读**的系数。它们的作用域应该是「同样沾边的几条之间」。一条被逐字指认的记忆，根本不在这场比赛里——它是答案本身。把答案丢进比赛里排位，就是用相对的标准处理绝对的事。

**三、单位取「榜有多高」，不取「词分有多高」。** 补分的量纲如果跟词分对齐，就得假设两个量纲可比；而 BM25 的分布没有绝对刻度（这一库普遍弱、那一库普遍强）。取榜首的实际分数当单位，等于承认「这次匹配整体有多难」，让指认跟着库的难度缩放，而不是凭空造一个绝对值。凡是需要假设「两个不同来源的分数可比」的地方，都是在编数。

**四、临时状态要有明确的死期。** `_vb` 存在的时间是「push 到补分之间」，补完立刻删。内部字段漏进回执，比少一个字段更糟：读的人会以为那是给他看的，而它迟早会变。

结论：**证据的价值是它本身决定的，证据的排位是最后一刻决定的——两件事不能混在一步里算。**

## 161 没有尺子的优化，是把「我觉得更准」当成了「更准」

**一、机制正确不等于结果正确。** 一支探针能证明「加分落在乘法之后」，证明不了「问一句答得对不对」。前者的失败是局部的、看得见的；后者的失败是整体的、沉默的——它表现为「用户觉得这个记忆系统不太行」，而没有任何一行日志会红。凡是没有整体读数的系统，退步都以「感觉」的形式出现，而感觉无法追责。

**二、语料必须来自真实库，问句必须不是正文。** 合成语料证明机制，真实样张证明准确率；抄正文措辞的问句，测的是「能不能把问句原样找回来」，不是「能不能听懂人话」。这两条一破，尺子就只会给你想要的读数。

**三、三档聚合，缺一档就会被一种失败骗过去。** 只有 hit@1 会掩盖「差一点就对」的可修问题；只有 hit@3 会掩盖排位退化；只有 MRR 会掩盖尾部全崩。三个数一起看，才知道该修哪一类。

**四、尺子第一次量出来的，往往是自己不想听的。** 0.2.149 首跑：抹平重要度，hit@1 反而 +0.022。四轮改动都建立在「重要度该进分数」这个前提上，尺子说在这套语料上它是负收益。**读数的价值恰恰在于它可能否掉你刚做过的决定**——如果一把尺子只会确认你，它不是尺子，是回音。

结论：**先有尺子，再动刀；尺子报的方向，不许由动刀的人来定。**

## 162 分数算得对，不代表排位排得对

1. **证据和先验是两种东西。** 词分回答「说的是不是这件事」，重要度、新鲜度、状态回答「这条平时值多少」。前者由这一句查询决定，后者与查询无关。用乘法把两种东西混在一起，等于让「平时值多少」参与裁决「是不是这件事」。
2. **乘法会碾压，加法不会，但光换运算符不够。** 只要先验还进总分，1.75 倍在词分差 1.8 倍的地方就翻盘；反过来把先验改成加法，它又会在另一头失效。真正的分界不是加还是乘，是**谁跟谁比**。
3. **先按证据分档，档内才谈权重。** 相邻两条词分差不到 17% 就算同一档，权重只能在档内改判顺序。档是硬的：分数再高也越不过一档。这样「平时更值钱」永远只能在同一件事里挑先后，不能替另一件事赢。
4. **时间折扣需要下限，指认需要越权。** 旧记忆该变暗，但 0.08 倍等于删除——下限 0.6 是「还看得见」的界线。而「问的正是这条 id」不是先验，是最强证据，必须站在所有档之前。

先验可以决定同分谁先开口，不能决定谁有资格开口。
## 163 没有答案的时候，回执也要有胆子是空的

一、记忆系统最容易被骗过的指标是「回复率」。问什么都给几条，看起来勤奋，实际上是拿用户的时间替引擎
的胆怯买单。空回执不是失败，硬凑才是。

二、噪声有两种，长得完全不一样：「到处都是的词」（df 高）和「哪都没有却毫无信息的词」（df 低、
idf 高）。前者靠统计就能认出来，后者只能靠词法——**越罕见的虚词越像证据**，这是 BM25 的天然伪装。

三、停用词表不是过时的做法，是问句侧的第一道闸。英文早就有（EN_STOPWORDS），中文这边空了很久，
空着的时候它不报错，只是悄悄把「怎么」「什么」「用的」写进了证据栏。

四、闸门要留三个出口：一句问话只由虚词组成时不能空手；标识符和英文内容词不能误伤；
一键能关回旧口径。**能关掉的闸门才是闸门，关不掉的叫事故。**

## 164 关键词是标签，不是正文

一、索引里放什么，就决定了它会用「什么」去找东西。把 keywords 摊进正文，等于让标签冒充正文：写得越多、
标签越全的条目，正文被稀释得越厉害，而它本来只是「这条大概讲什么」的速记。0.2.133 给关键词写了 0.35 的字段
加成——那是在补偿一个自己造的伤。

二、尺子必须先被怀疑一次。0.2.149 的 40 条样张 keywords 全是空的，0.2.150 在同一份料上分档，0.2.151 又量了
虚词——三刀都「通过」，因为尺子看不见关键词。真库里 40/40 都带关键词（平均 9.2 个）。一条从没被量到的旋钮
等于不存在，而一份看不见问题域的语料，比没有语料更危险：它给你通过的绿灯。

三、两路 tf，一条 df。关键词的计数打折（0.25），正文的计数照算，df 取并集——候选资格一点不掉，分数不再被
标签冒充。既不是「关键词不算数」（那会丢掉桥接：只在 tags 里提过「部署」的铁律就再也进不了榜），也不是
「关键词等权」（那是让标签投票决定谁是真身）。

四、代价要写在读数旁边。语料补真之后，无关问句的空手从 12/14 掉到 9/14——三条问句真能在 keywords 里找到桥接。
桥能过车，也能过噪声；第二道闸（只标签命中、正文无命中怎么办）必须用同一把尺子量，不许凭感觉加。

## 165 快不是把活干少，是把活干一次

一、慢的检索不是「想得久」，是「每次都想一遍」。1200 条要 107ms，拆开看没有一处聪明：切词 30ms、
建表 36ms、打分 42ms——每一问都把整库从头 tokenize 一次，问十个问题就付十次同样的钱。**同一段正文在一个
会话里被切十遍，第十遍不产生任何新信息。**

二、优化要先有尺子。这一刀先写 `probe-cost`（三档语料、p50/p95、结果快照），再动代码；读数从 107.2ms
到 2.9ms 不是「感觉快了」，是同一把尺子前后各量一次。没有快照的优化最危险：它可能顺手改了答案，而你还
以为只是变快——所以 C5 把 top-5 的 `id:score` 逐位钉住，只许时间变。

三、缓存的前提是「知道库变没变」，而这件事必须便宜且可靠。只看长度会被「等长改写」骗过（同一秒、
字数一样、换了个词），于是指纹取头 40 + 尾 40 + 标题 + 关键词 + 会话：比全量哈希便宜一个量级，
又把撞车压到几乎不可能。**可信的缓存要能回答「凭什么说这是同一张库」，而不是「上次结果是这个」。**

四、能被关掉的快才敢用。`cache:false` / `inverted:false` / `opts.index` 三个出口都在，阴性对照才证明得了
每一层真在起作用；上限 4 张则保证「快了」不会变成「内存一直涨」。**快是一种预算，不是一种感觉。**


## 166 多一路信号不是为了多一个旋钮，是为了少一次猜

一、两把尺子的刻度不能相加，只能换名次。余弦在 0.5–0.9 之间晃，BM25 能到 4.2；把这两个数加起来，等于让「谁的单位大」决定排序——实测直接相加时照抄池从 0.911 掉到 0.867。RRF 只读名次，两路各自的名次才是同一种货币。

二、可选性不是缺点，是让好东西能进门的条件。稠密这一路要 22.9 MB 模型和 371.9 MB 运行时，默认装上就是把「一键安装」变成「先下 400 MB」。做成可选、缺了就退回，才能既让想要的人拿到换说法池 +0.143 的命中率，也不让其余的人为它付一分钱。

三、关得掉的开关才算开关。`MEOW_DENSE=0` 起初只在一个入口认，实测等于没关——关掉之后结果照样变。一个开关如果只关掉一半，它比没有更糟：它让人相信一件没有发生的事。

四、不装也能用，才配叫「可选」。判据不是「写得像可选」，而是「拆掉它，输出逐位不变」——顺序和分数都要一样。这条钉在 G13/G14 里，且**在有模型和没模型两种机器上都各打一行**：可选的另一面是，两种机器都得各自被量到。

## 167 敢说「不知道」，比多答一条更像记忆

- **沉默不是失败，是信息**：一条凑出来的回执要花 token、要被当真、还要被后来的自己去纠正；一次明确的「这件事库里没有」只花一句话。
- **判据要换个刻度**：词法只知道「词对不对得上」，语义分才知道「是不是一件事」。用错的刻度判，越调越偏。
- **先在能判的地方判**：全库都有向量才判，是「宁可不说，也不猜」——判据自己也不许拿半份数据下结论。
- **关得掉的判决才算判决**：闸门能关、门槛能调、挡下来时把原因写清，读者才有资格不同意它。

## 168 谁写的、为什么在、还有人用吗——可信度是查出来的，不是信出来的

一、**没有读口的字段等于没有这个字段**。`source_session` / `hit_count` / `last_accessed_at` / `corrected` 在库里躺了上千条，`dream_log` 与 `windows` 两张表也一直在记账；但 `memory_read` 只印标题、项目、正文，最后一句还把人赶去翻聊天记录。写了却读不到，等于把可追溯性做成了「看我写过」。

二、**来路不同，可信度就不同，所以不许合成一句**。老库迁移的条目追不回原话、整理封存的是压缩过的、会话直写的当时人还在场、没记来源的只能说「没记」——四种混成「来源：会话」看似整齐，实际把「能追」和「追不回」抹成一样。

三、**读元数据不许顺手改元数据**。来源行只读不写，尤其不 `markAccessed`：否则「还有人用吗」这一栏会被读它的人自己污染，越查越像「最近用过」。

四、**「没有这一行」也是一种回答**。没工作区、没库、库里没这条——一律空串，且先 `existsSync` 判存在。为了一句「来源未知」去 `getDb` 建一个空库，是拿读者的库换一句废话。

## 169 能被改坏的记忆，必须先有退路

一、**改是常态，取代是少数**。真库 513 条 active 里 412 条被改过，正文带取代句的只有 2 条——「更新」在这里几乎总是**正文重写**。设计更新路径时按「重写」算成本，别按「追加」算：一条 2,000 字的教训改一个版本号要重发 2,000 字，这不是模型懒，是接口逼的。

二、**局部修改的价值不在省字符，在「只碰该碰的那一处」**。整段重写会把无关段落一起重打一遍，每一遍都是一次被改坏的机会；`{find, replace}` 唯一命中只动那一句，找不到或命中多处就一个字都不写。宁可这次不改，也不猜着改。

三、**留底要留「上一版」，不是留「所有版」**。留无穷版是把存储问题推给未来，留一版又退不回第二次；三版是「改一次、再改一次、发现第一次就错了」的实际深度。逐字相同的旧正文不重复记，留底才不会被自己的流水账淹没。

四、**退回也是一次改动**。`restore` 之前把当前这版再留一次底，才敢说「退回去」不是单向门——否则退回本身就是新的不可逆操作，等于把问题换个方向。

五、**闸门要拦「整段删」，不拦「改短」**。缩水三成以上才拦，40 字以下不拦。判据不是「变短了没有」，是「变得像不像事故」。

## 170 「可调」不是把参数暴露出去，是让调整能被看见

一、**能拧的旋钮要少而有界**。四个（斥力 / 弹簧 / 向心 / 阻尼）就够说明「这张图是弹性的」；每个都给上下夹，越界不是报错而是夹住——旋钮的职责是让画面可读，不是让人把画面拧坏。夹值逻辑放一个纯函数里，面板和探针调同一份，第二份实现就是第二个 bug。

二、**手感是判据的一部分**。「拖动只改数字、松手才重排」不是优化，是正确性：每像素重排一次，用户看到的是一张卡死的图，然后他会得出「这个面板做坏了」的结论——功能没错，体验错了，功能也就等于没有。

三、**只裁「看得见」的那一处**。局部图必须落在渲染器的可见性收口里（`visible()`），绝不能顺手改检索、计数、导出：一旦「看不到」被理解成「不存在」，用户点一下局部图就会以为邻居推荐坏了。视觉范围与计算范围是两个数，混起来会同时错两边。

四、**默认值只有一份**。参数的面板与渲染器必然各存一份（一个还没加载、一个已经加载），允许镜像，但不允许漂移——探针逐位比对，漂一位就红。系统里最贵的 bug 不是算错，是两处「同一件事」算出两个答案。

五、**零成本的一层要优先用**。面板走 iframe 静态文件，不进请求前缀、不进工具 schema、不进常驻注入。同样的「可读性」收益，放在这一层是 0 字节，放在工具参数里是每轮都付的 token。

## 171 问句里的日期是条件，不是噪声

一、**「现在」是默认时区，不是唯一时区**。所有排序都有隐含的时间基准：新鲜度折、状态折、recency 地板，默认全按「今天」算。可问句一旦自带 `0.2.146`、`2026-11-21`，用户就是在说「把时钟拨到那一刻」。听懂这句话的成本是一个正则，听不懂的代价是正解排第二。

二、**豁免要窄，窄到能一句话说清**。只免两样：新鲜度、状态。词分不动、覆盖度不动、分档不动。判据是「这两样本来就是为了回答『现在』才存在的，问句不问现在，它们就该让位」；词分是问句与文档的匹配度，跟时间无关，动它就是改判据而不是改口径。

三、**逐条判胜过整句判，即使分数一样**。整句一刀切会在「问句带日期」时把所有 stale 一起免折，包括那些压根没提这个日期的条目；两种做法在评测池上同分，但在真库上差一条。**同分时选解释得通的那个**——分数只说明当下没亏，语义决定以后亏不亏。

四、**开销要能被证伪**。判据里必须有一条「关掉它就变差」（0.911 < 0.933），否则这条功能可能只是被顺带写进代码、从没起过作用。功能自带阴性对照，是它敢留在仓库里的前提。

五、**别为了排名改事实**。免折的是「排序时的折扣」，不是「这条已经过期」这件事：`status` 仍是 stale，只是这一次不折它。让排名好看的做法如果顺手洗掉了状态，下一个人看到的就是一个假库。

一句：**问「哪一刻」的话，别按「现在」答。**

## 172 分低就说清

一、**给不出好答案时，最好的产品行为是说实话，不是凑排名**。换说法池 hit@1 只有 0.500，词一个都对不上时，任何加分、改档、调权重都是在猜。能确定的事只有一件：这次证据薄。那就把这件事说出来。

二、**判据要用无量纲的比值**。`cover`（榜首覆盖了问句 idf 权重的几成）与 `gap`（第二名／第一名）在任何规模的语料上都量同一件事；绝对分会随语料长大而漂，阈值就没法带走。

三、**说清不等于吓人**。回执里给的是「榜首只覆盖了问句的 15%，先看正文确认」，不是「这条不准」；再附上「库里是这么说的：key、花钱、预算」——**把换词的成本降到一次重问**，而不是让人自己去猜措辞。

四、**强命中必须零字节**。不弱就返回空串，被 note 数组的 `.filter(len > 0)` 吃掉。一条只在 30% 的检索里出现的提示，不该让另外 70% 付一个字。

五、**误报要认账，并写进措辞**。真库上 7% 的检索「本来就排对了却也被提醒」，因为 `cover` 低是事实、答案恰好对了。所以文案不能说「这不是库里没有」——那句在真没有的时候是假的；只说能量到的证据。

一句：**排序改不动的时候，把「这次证据薄」告诉问的人，比硬凑一个更像答案的排名诚实。**

## 173 关键词是唯一长在数据里的标签

一、**别为空转的权重找活干，先看清哪一列真的有内容**。真库 569 条 `title` 全是 null，引擎里那 0.6 的标题权重一直在空转；真正有内容的是用户自己写的 `keywords`，却只拿 0.25 倍词频和 +0.35 加成。**结构上顺序反了**，这跟调参无关。

二、**给「没有的东西」补数据是最坏的省事**。试过拿正文首句当伪标题：真库 7 条换说法全部变差，keywords 自找从 0.940 掉到 0.933。截断的首句既不是标题也不是正文，还挤占词分——宁可承认这列是空的。

三、**读数打平时，选不破老规矩的那个**。tf 0.5/0.6 与 tf 0.35/0.6 三池读数一分不差，但前者会把「只在 keywords 里提到的条目」压过「正文命中的条目」——0.2.152 立的「标签是提示、不是证据」当场变红。打分打平的时刻，老规矩才值钱：**同样的准确率，选那个没有把已有约定弄坏的参数**。

四、**一个数只能有一个来源**。`kwTfW` 的兜底散在三处，其中一处在索引缓存键里；只改两处，缓存就会在换权重后继续喂旧表。常量抬到模块级、导出、探针与验收共用同一个数——这是「可追溯」在代码里的样子。

五、**「读数不亏」不能拿规矩去换**。把参数一路抬到 0.5 时，三池读数看起来完美，代价是 0.2.152 的两条老断言变红——如果只看读数，这次改动就会以「指标更好」的名义把一条正确规则悄悄废掉。**扫描可行域、把老断言一起当成约束，才是真正的验收**。

六、**收益可以很小，但方向必须对**。这一版照抄池一处不动、换说法 +0.003、锚点进一条。可它把「用户自己写的摘要」放回了它该有的位置——下次加新信号时，顺序至少不是反的。

一句：**调参之前先问「这一列到底有没有内容」，比把参数扫一遍有用。**

## 174 只做加法的桥

一、**词面零交集是结构问题，不是排序问题**。换说法池 hit@1 卡在 0.500 好几版，每一轮都在排序上找原因——分档、时间折扣、keywords 加成、弱命中提示，都能挪动一两条，都挪不动这个数。拆开看才发现：`反省` 与 `反思` 在二元组这一层是**两套互不相干的词**。没有可比的词，再怎么排序都是白排。**卡住的指标要先问「是不是根本没有可比的东西」**。

二、**只做加法，别动判据**。同义词只加进问句、只加分，`qIdfSum`（覆盖度分母）一个字节不动，分档、折扣、排序全都不碰。这样「开桥」与「关桥」的差别就只有一件事，出问题时能一刀切回去（`synBridge:false`）。**一条改动要能一句话说清它动了什么**——说不清，就不是一条改动。

三、**帮忙的权重必须小于顶替的权重**。`SYN_W` 扫到 1.0 能多救一条题，但那意味着「同义词命中」与「原话命中」同权。取 0.6——平台的起点。**「多救一条」不是理由，除非它能变成一条规律**。

四、**表要能对齐检索的那一层**。第一版表里写了单字的 `门`、`笨`、`慢`；分词器只产二元组，这些条目永远命不中，写了等于没写。验收当场变红才改。**任何手工表都要有一条断言去核对它「能不能被检索到」**，否则表会慢慢变成注释。

五、**扩词必须并候选集**。只把同义词加进打分循环是不够的：候选集是按原词 postings 剪出来的，只在同义词上命中的条目连打分函数都进不去。**「加了分」和「进了场」是两件事**，两件都要做。

六、**收益小也要如实说**。fixture 上 0.500→0.714，真库上 0.399→0.405 且一进一退。两个数都写进文档，不拿 fixture 的涨幅去暗示真库也这样。**只报能量的证据**，这条比任何一次涨点都重要。

一句：**先问「有没有可比的词」，再问「排得对不对」。**

## 175 覆盖度：先问「占了几成」，再问「排第几」

一、**「沾了话题」和「答了问题」是两件事，区别在覆盖度**。一条 102 字的规矩正文只提到「评测台」，一条 611 字的记录正文里有「评测台 + 封存」——问「为什么封存」时，第二条才是答案。词分把它们算成 13.4 对 7.3，是因为字段加成把前者放大了 2.2 倍。**覆盖度早就该是硬证据，不是装饰**。

二、**调一个数之前，先问它乘在哪一层**。`COORD_W` 乘在 `raw` 里，而 `bandize` 按 `raw` 分档，所以「跨档不许越级」这条规矩意味着：**不改进 raw，就改不动排名**。反过来，改 raw 的代价是可能连累所有档。**位置决定代价，不是权重决定代价**。

三、**一个数一个来源**。`COORD_W_DEF`、`COORD_POW_DEF` 各定义一次，`lib/macro` 里别处不许再写「覆盖度算多重」。0.2.161 的空转权重、0.2.162 的表与权重，都是这条。

四、**平台起点才是可交付点**。0.45–0.6 之间真库收益早就吃满，差别在 fixture 掉不掉；0.55 起照抄池就开始掉条目。取 0.5——**能同时说清「向上会掉什么」的那个点**，而不是读数最高的那个点。

五、**幂次是口径，不是魔法**。线性覆盖度对「缺一半词」太宽容（掉 50% 就该掉 50%），凸一点让缺口更疼。但它会让低覆盖的条目整体下沉，所以必须配一条断言：同一协调权重下「高/低覆盖分差」要变大。**兜底常量也要有守卫**（`coordPow > 0`），别让 0 或负数把覆盖度关成黑箱。

六、**读数分开报，别拿 fixture 的 0 变动冒充收益**。这一版 fixture 三池 0 处变动、真库 3 好 1 坏。写「三池不亏、真库净 +2」——不是「准确性提升」。**没解决的那条要写进已知边界**（`评测台为什么封存` 仍是第二名，根在字段加成与跨档）。

七、**放过自己救不回来的那一格**。这一版本来想顺手翻掉 9.170.1 那条，扫到 `coordW = 1` 才勉强翻一条，代价是整个照抄池掉到 0.867。**方向对但力道不够时，换一层动手，别在同一层加到破规矩**。

一句：**先问「这条答了几成」，再问「它该排第几」。**

## 176 读数工具自己也是被测对象

一、**难看的读数先怀疑量具**。0.2.161 到 0.2.163 三版，每一版都拿「真库 150 问自找回」当第二块验货台，读数一直是 0.860 / 0.953。三版都在这个数上做决策。第四版开头重搭台子，才发现台子搭错了：`SELECT *` 拿回来的是原始行，`keywords` 列是 JSON 文本字符串，而引擎三处都按 `Array.isArray` 判空——关键词通道整条静默失效。纠正后同一个引擎是 **0.993**。三个版本的「真库收益」全部作废。

坏量具的特征是「错得不出声」：不抛错、不告警，只是安静地把一半输入当空。所以**判据卡在边界上时，第一个要查的不是参数，是那个数怎么来的**。

二、**取数口径要跟生产走同一条路，不能「差不多」**。生产路径是 `db.listSearchable(lv)` → `db.list()` → `fromRow()`（里面对 `keywords` 做 `JSON.parse`）；诊断脚本图省事写 `db.p('SELECT *')`，就绕过了唯一的反序列化点。这不是「代码风格差异」——**行的形状就是接口契约**，谁绕过去谁量的是另一个系统。

三、**饱和的池子没有信号，别拿它当方向盘**。纠正后「真库自找」在 12 组参数下恒为 148/150：一位不动。在这种池子上调权重，等于闭眼开车——读数稳如磐石，不是因为方向对，是因为这条路已经走到头了。**先看池子的方差，再决定要不要在这池子上扫参数**；有信号的只有 14 条换说法的 top5（10/11/12/9 起伏）。

四、**同一族参数出现「平台反转」时，选能说清代价的那一格**。0.2.163 在坏台子上挑了 `0.5/1.2`；干净台子上它是这一族的**倒数第一**（top5 只有 9，旧口径 10、本版 12）。平台不是「读数最高点」，是「再往上会掉什么，说得出名字的那一点」——0.55 起照抄池掉条目，所以取 0.45。

五、**收益为零的旋钮要诚实关掉**。`coordPow` 在 0.45 下 p=1 / 1.1 / 1.15 读数完全一致，p=1.2 只把 top5 从 12 打回 11。既然没有增量，就**默认回线性 1、旋钮留着做对照**——「上个版本用过它」不是留成默认的理由。

六、**逐题只看「进没进 top5」，不看名次漂移**。这一版三池 0 处变动，真库换说把三条边缘问句从「找不到」推进 top5。这类收益必须按「进/不进」报，不能把 3→4 说成进步：**名次在 top5 内的漂移对用户没有意义**。

七、**还没解决的那条要指名道姓地写下来**。`评测台为什么封存` 在所有参数下名次恒为第二，根在字段加成 fw 2.2 与分档跨档——写进已知边界，而不是「本版继续优化了排序」。下一版若动它，得换一层（字段加成或分档），不是继续调覆盖度。

一句：**读数难看时，先问「这个数是怎么来的」，再问「参数该怎么调」。**
---

### 177. 回执不是越大越好：算得准，也要捞得少（0.2.165）

排序层这一族已经量到平台（0.2.164），于是把尺子从「第几名」挪到「回几条」。
第一次量就发现一个荒谬的事实：`bandize` 早就在算「这条和榜首是不是一个量级」，
而回执完全没看它——真库 150 问上，**正解 100% 落在 band 0，而每问的 band 0 平均只有 1.08 条，
回执却照样搬回 9.80 条**。多出来的八条不是「备选」，是「同一批沾边尾货」，而且是要付 token 的。

三条原则：

一、**已经算出来的判断，别让它只活在一个地方**。档位过去只服务排序，现在同时服务「捞几条」。
同一套 `IMP_BAND` 一档两用，不许为回执另立一套阈值——**两个阈值就是两套世界**。

二、**省 token 的刀要落在「本来就不该给」的东西上，不是「看起来分数低」的东西**。
按分数阈值截断要人挑阈值、换个语料就换意思；按档截断是「和榜首同一量级」这一步已有的结论，
不新增旋钮。这也是为什么五池 hit@1 / top5 一位不动——**这一刀动的是交付量，不是判断**。

三、**下限是取舍点，要指名道姓地量出来**。`minKeep = 3` 更省（回执均值 2.99）却让真库换说池
掉两条；`minKeep = 5` 五池零损失、省一半。选 5 不是拍的，是「再往下就会丢东西」的边界；
这条边界必须写进文档，否则下一个人会以为 3 更优。

四、**退路也要走同一个口径**。`searchHybrid` 的 `dense: false` 分支、`denseRes` 为空的分支，
都必须回同一个 `trimByBand`——两路各裁一次，就会出现「关掉稠密后条数变了」这种没人能解释的漂移。

一句：**回执的长度也是判据的一部分；能少给一条而不丢东西，就该少给一条。**


### 178. 强通道旁边的新通道：只许补盲区，不许并列投票（0.2.166）

排序层量到平台之后，剩下最容易想到的一招是「上向量」。这版把这一招拆成两半，结论很难看：

一、**并列投票会打散已经排好的强序**。0.2.154 的 RRF 融合在当时是正收益（换说法 0.500 → 0.571），
但那时词法只有 0.500。同一段代码在词法 0.798 的今天跑出来是 0.738、锚点 0.883 → 0.825、
真库自找 0.997 → 0.954。**通道之间不是「多一票更民主」，是「弱的一方给强的一方加噪」**；
旧结论的正确性绑定在当时的能力水平上，能力一涨它就要重测。

二、**先量「它自己承认不行」长什么样，再谈让它说话**。词法 miss 的题有一个非常干净的征兆：
查询 top1 的覆盖度 0.072–0.142，命中题中位 1.00。于是闸门不是「分数低就让位」这种要人挑线的写法，
而是**复用已有的覆盖度结论**：`cover < 0.2` 才允许稠密介入。这是 9.173 的判据，不是新阈值。

三、**补位要保序**。词法前 4 名原样不动、只重排尾巴，实测 hit@1 与 hit@3 一条不动、top5 三池各 +1。
反过来「让稠密从头重排」就是第一条那个结果。**救场的定义是「别把已经对的弄坏」，不是「换一套判断」。

四、**能关掉的能力才敢默认开**。`denseRescue: false` 逐位回到纯词法、`rescueCover: 0` 全关、
`rescueHead`/`rescueCos` 可调、老融合用 `denseFuse: true` 显式开回来。这四道门是同一个意思：
新通道的所有权限都必须能在调用点收回，且收回后与没有它时**逐位相同**。

五、**默认路径的变化要在读数上看见，不能靠想象**。第一版只加了 rescue 分支，默认仍走 RRF，
真库自找悄悄从 149 掉到 138。**「新功能没触发」与「老路径没变」是两件事**，必须分别量。

一句：**省下来的算力，花在自己承认不行的地方；其余时候，闭嘴就是贡献。**

## 179 欠账要报，报要给出口

这个系统里最贵的错不是算错分，是**悄悄少给**。回执从 10 条变成 5 条，读者不会去问「另外 5 条去哪了」，
他会直接得出「库里只有这 5 条」。这个结论一旦形成，后面所有召回都被它打折。所以这一轮改的不是排序，
是把已经切了两版的刀摆到台面上，并量清楚到底是谁在切。

一、**刀切在别人身上，就得让人看见刀**。0.2.165 的置信档收口上线两版，切完一声不响。
读者看到 5 条，既不知道同档之外还有多少，也不知道该不该要全量。这不是优雅的省略，是**静默截断**——
rules 里明写着不许。

二、**报「短了多少」，别报「池子多大」**。内部为了排序拿全量候选（`k = docs.length`，500 上下），
这件事与读者无关；第一版把「另有 78 条没展开」「k 已给到 505」印进回执，读感是噪声。
改成只在 `hits.length < k` 时说一句「这次回了 N 条，没到你要的 k 条」，回执给满时一个字都不花。

三、**账要能算，协议要不脏**。计数挂在返回数组上，`enumerable: false`：`JSON.stringify`、
`Object.keys`、`for...of` 全都看不见它。于是「多记一笔账」没有让任何一条既有断言的
逐位相同性失效——**改口径不许顺手改协议**，否则下游每次都得跟着改一遍。

四、**能关掉才敢默认开**（0.2.166 的教训原样复用）。`band_keep: false` 是出口，`min_rel: 0` 是它的搭档，
两个都要写进回执本身——只给出口不给用法，等于没有出口。

顺带一个教训，值得单列：**同一件事在两个路径上的读数可以差一倍**。API 层 k=10 平均给 4.97 条，
工具回执平均只有 2.35 条，因为工具路径上还叠着相关度地板与折叠。文档里写「回执从 9.80 收到 4.97」
时，我以为是 band 的功劳；量完才知道工具路径根本没有 9.80，收口只占 0.7 条，主导的是
`min_rel=0.35` 那道地板。**在错的路径上量，量得再准也是错的结论。**

一句：**读者不需要知道你省了，只需要知道你还剩多少没给。**

## 180. 隐形的一层比排错的题更贵

上一节留下的账是「谁在切回执」。顺着修地板之前，我搭了一把更基础的尺子：**回执里到底有没有正解**。
建完之后问题换了位置——8 题召唤不到正解，而那 8 条全在 `user` 层，一个默认检索根本不看的层。
API 层每题都是第 1 名，说明排序一直是对的，**只是那些条目从来没被交给排序器**。

四条：

**一、默认范围要覆盖「最该被想起的那一层」，不是「最规整的那几层」。**
`fact / lesson / topic / rules` 是「知识」，`user` 是「这个人怎么做事」。后者在真库只有 8 条，
但每一条都在回答「我该怎么给他干活」。把「知识」默认为全集、「人」默认为附加项，是把成本算在了错的地方：
查不到一条事实，读者会换个词再查；查不到一条偏好，读者根本不知道自己漏了。

**二、排错看得见，没收进来永远看不见。**
名次错能读出来（第 3 名、首位不是它），读者会怀疑并重试；三层之外的条目连候选都不是，
回执里也没有一个字提示「别的层还有东西」。**沉默的失败比响亮的失败贵得多**——前者连纠正的机会都不给。
所以边界要么进默认，要么在零命中那句话里点名（0.2.168 之后那句话写的是「soul 与 project 层不参与」，
不再是含糊的「默认检索范围是 …」）。

**三、边界要用读数画，不能靠直觉画。**
把七层全塞进默认看着最「全」，实测换说池首位从 5 掉到 4：`project` 层放的是整个项目的概览，
它天生跟任何问句都沾一点，一进候选池就抢首位。**「多给一点」从来不是免费的**——
每一层的入场都要交一次抢位费，交得起才让它进来。

**四、阈值在受控语料上定完，要到真库上复核一次。**
`min_rel = 0.35` 是 30 条语料上定的（那时尾部断崖在 0.33）。真库 545 条上它砍到正解：
换说池 9/13，降到 0.30 变成 10/13，代价只有 0.31 条。**受控语料能定「机制对不对」，
定不了「阈值该多高」**——阈值是分布的属性，而分布的尾巴只有真库才有。

一句：**先问「这一层有没有资格进来」，再问「进来之后排第几」。**


## 181. 静默降级比错误的默认更贵

一条判据写错，功能不会消失，只会**看起来在**：加载那行把包名当路径，抛错、被 catch、状态落成 off，
于是「语义补位」和「不沾边就弃权」在半年里一次都没跑过，而所有文档、断言、发版记录都说它在。
错的那行不报错，所以没人修——**能被 catch 掉的错误，最容易活成架构。**

所以功能要么有行为探针，要么就当它不存在。契约断言（常量在、文案在）只能防「代码被删」，
防不了「路径根本没走到」。

**开一半的功能比没开更危险。** 它不是「没效果」，是「只在某些条件下有效果，而没人知道是哪几种」。
真开起来之后读数立刻分叉：换说池 10/13 → 11/13，稠密单独却只有 3/13。两个检索器的错法不同，
互补是对的；但「互补」只有在两个都真跑着的时候才是结论，否则只是想象。

**命中率要跟回执长度一起看。** 只盯命中，第一版就是正确答案：不限量能把 11/13 拿到，
代价是回执从 4.54 条涨到 8.23 条、943 字涨到 1746 字——一条正解换三四条陪跑。
加上限、把词法尾部折掉之后，命中不变，回执反而比不开更短。**省与全是同一个动作**，这话在补位上也成立。

**来路不同的数不能混成一个。** 词法尾部折 13 条、补位补 2 条，混在一笔账里就会报出「折了 11 条」
这种自相矛盾的数——读者算不平，就会连真的那个数一起不信。分开记，各自报名。

一句话：**读者数不平账，比少看一条更伤；不让读者数错账，比让他多看一条更值。**


## 182. 词切错了，再好的打分也救不回来

1. **中文没有空格，按整词列的虚词表挡得住词、挡不住碎片。**「什么时候」被切成「什么 / 么时 / 时候」，
   表里有前两个、没有第三个。碎片 df 低、idf 高，一个假词就够把错的那条顶到榜首。
   检查一张虚词表够不够，不看它收了多少词，看它**切完之后还剩几个碎片**。
2. **疑问框架是语法，不是证据。**「什么时候」「怎么办」「是不是」只说明你在问，不说明问的是哪件事。
   它们该在进倒排之前就离开问句，而不是进榜之后再指望打分器把它们压下去。
3. **新刀一开，老刀的阴性对照先假红。** 关掉 A 刀之后读数没变，不代表 A 刀无效——可能 B 刀已经先把词拿走了。
   对照组的正确写法是「只关被测的那一把」，其余全开。五处假红（NF/VT/G9/GW/VW10）全出在这上面。
4. **剥完太短要回退。** 问句只由疑问词组成（「为什么」「什么时候」）时，剥完是空串。宁可带噪声给一条回执，
   不许凭空空手——空手是最贵的错，因为它连「我可能错了」都不给你。
5. **改问句这件事必须说出来。** 剥离对读者是隐形的手：默认回执不花字节，但 explain 里要看见「剥了什么」，
   关掉时要看见「没剥」。悄悄改口径比改错更伤。

收句：读者的问句被改写却不被告知，和答案排错了名次，是同一件事。

## 183. 过期不是删掉，是「换一种身份留在库里」

1. **推翻一条结论，不等于它没发生过。** 版本交付 fact 被下一版取代成 stale，是「它不再是
   现在的结论」，不是「它从没写过」。检索层把 stale 一律挡在候选外，等于替读者决定了
   「这段历史不值得看」——而读者问「0.2.148 改了什么」时，要的正是那段历史。

2. **但要挡住它冒充现在。** 放宽必须有条件：问句点了名（版本号 / 路径 / 短 id / commit），
   才去 stale 里找含这个标识符的条目；补进来的每一条都带「已被后续版本取代」，并且给
   `include_stale: false` 一个出口。**默认口径不动，是因为主人拍过板**——「其他类别过时
   不检索」是对的，它防的是旧结论混进当期答案；它不该防的，是历史问题。

3. **最强的那类证据，必须能跨过所有中间层。** 标识符补分只进 `score` 不进 `_raw`，分档
   那一层就把它当没发生过——这不是打分不准，是证据在半路被一个不认它的中间层吃掉了。
   凡是「分档 / 截断 / 收口」这类中间层，都要问一句：**上一层认定的强证据，到了这里还认
   吗？** 不认，就得让它也进这个中间层读的那个数。

4. **同一批条目里挑前 N，不能按库里的顺序挑。** `db.list` 的顺序是写入顺序，不是相关度；
   第一版按顺序取两条，把真正的正解挤到了第 3。按顺序取，等于「先来的赢」——那和检索
   一点关系都没有。

5. **新刀一开，老刀的阴性对照第一个假红。** identBand 一开，关键词权重的旧口径在锚点池
   上「看起来没变差」，因为另一把刀在替它干活。这不是回归，是对照组混进了新变量——修法
   永远是「对照组只关被测的那一把」，不是去调阈值。

读者要的不是「库里有没有」，是「那段历史你替我留住了没有、又有没有骗我说它还在」。



## 184. 能靠档说清的事，别用权重硬顶

一、**权重是一条连续的线，档位是一条离散的界。** 有些判断本来就是离散的：「这条记忆的主语是不是问句问的那个东西」——是，或者不是。用权重去表达它，等于把「是」摊成 0.1、0.2……0.9，再指望某处恰好跨过去。2.4 不过、2.5 过，不是判据变强了，是数值碰巧越了界。

二、**凡是要靠「再加一点」才生效的规矩，都在等下一批语料把它推翻。** 档位不需要调：`bandOf.set(h, -1)` 说完就完，换语料也还是第一档。0.2.158 的分档规则已经写好了「跨档不许越级」，那就该让主语位**进档**，而不是让它的分数去撞档。

三、**词分只数次数，不分位置。** 「0.2.148」在正解里是主语，在某条教训里是引文，BM25 看见的是两个 token 命中。位置这件事必须单独说，说的话就得说在能一次说完的地方（正文开头），而不是散在权重里。

四、**一个恒等于 0 的加成，比没有更坏。** 标题加成调了三十多个版本，加成乘的是空串——库里所有条目 `title` 都是 `""`。它不报错、不告警，只是静静地让所有关于「标题很重要」的推理失效。判据落在空地上时，扫描会给出「七档读数完全相同」这种最容易被误读成「参数还没到位」的信号。

五、**探针要测哪一层，就在哪一层断言。** 隔一层能测到的只有「不崩」，测不到「它对」。R10 第一版隔着工具层读 `explain.band`，读到 `undefined` 却把「关掉后仍第 1」当成了阴性对照通过——假绿比红更贵，因为它替你签了字。

收句：读者不问你的分档函数写了几个 if，他只问「我问的是这个版本，你第一条答的是不是它」。

## 185. 问句的语法形状是意图，不是噪声

一、**「问什么」和「答什么」错位时，词分再高也是错的。** #21 那条教训里「反思」「触发」一个不缺，词分甚至更高——因为它更短、词更密。可用户问的是「该由什么触发」，要的是一条**规矩**，不是一段「上次我是怎么想的」。这类错配靠调 BM25 永远修不好，得让问句的**语法形状**（「要不要」「该由」「怎么跑」「改了什么」）去指认层级。

二、**软偏好必须能和硬门槛分工。** 分档是硬门槛（跨档不许越级），层级意图是软偏好。软的东西直接进硬门槛就会出事——第一版就是这么把一条 1.435 分的条目抬到 2.545 分前面的。后来分成两段：`_raw` 负责「够不够格进这一档」（带比率门，只帮本来就近的），score 负责「进了这一档排多前」。一件事一个层，别让一个数同时干两件事。

三、**「参数没生效」要先怀疑作用域，再怀疑数值。** 乘法段写进了 `if (verbHay !== null)` 分支里，受控语料没有 verbatim 命中，于是整段没跑；表面症状和「权重太小」一模一样。先把「这段代码跑没跑」钉死，再谈调参。

四、**分数变了要认账，名次没变也要说。** 这一版让 13 个问句的分数 ×1.3（层级命中就是在调相关性，这本来就该改分），但名次一个没动。换代快照时两边都要写清楚：名次 0 变化、分数按系数放大——只说「换代了」等于把「答案有没有变」这个读者最关心的问题糊过去。

五、**放弃也要写明。** #26 那条 lesson 32.53 分太强，比率门按设计挡住了层级加成，正解仍排第二。这不是「没修好」，是「按规则不该修」——写进文档，比偷偷调一个刚好能过线的 `lvRatio` 诚实。

一句话：读者问「该不该」，你答「我上次是怎么做的」，那不是在回答问题，是在炫耀经历。

## 186. 结论有形状：断言词是「这条答的是不是问的那个」

一段记忆里有两种句子：一种是「结论」（`必须/一律/只认/只有/至少/不许/绝不/禁止/都要/统一/固定为`），一种是「背景」（这东西有两套、当时是这么来的、顺便说一句）。问句是求值型的时候——「该写什么值」「要改几个文件」「要跑几轮才收敛」——用户要的只有前者，而 BM25 看不出来：两边都命中了问句里的词，两边都在同一档。

于是给「结论性」单开一项证据，但它必须同时满足三个条件才可信：

1. **形状**：断言词是一串看得见的词，不是「句子短」「语气强」这种主观判断。
2. **位置**：只看开头 60 字。写在第五段的 `必须` 不是这条的结论，是举例。
3. **问句形状**：只在问句本身是求值型时开。问「来龙去脉」「为什么」时，背景才是答案，这时候抬断言就是把正解压下去。

还有一个反直觉的地方：**「只在不是榜首时生效」这种门看着保守，实际是伤害源**。榜首已经是对的时候，把旁边的铺垫抬起来，反超的正是它。正确做法是无条件按密度加成——如果榜首本身是结论，它的密度高，谁也追不上；如果榜首是背景，它就该被超。

最后一条：**想改顺序的项，要落在分档上，也要落在分数上**。`_raw` 只决定「够不够进这一档」，进了这一档之后排多前，看的是 `score`。只写一处，同档内的名次一点不动，探针会显示「加了权重毫无反应」，而那不是权重太小，是这一项根本没参与排序。

一句话：**问的是结论，就给结论；背景再华丽，也只是背景。**
## 187. 小房间里谁都认得出来，考场要按真实大小摆

一、**量具的房间大小就是结果的一部分。** 同一批问句，在 40 条样张的池子里 hit@1 = 0.933，在 146 条里掉到照抄不变、换说法 0.714、时间锚 0.700；而在真库 578 条里，照抄档又掉到 0.889。三个数说的是同一件事，差别只在「房间里站了多少人」。拿小房间的成绩当指标，等于给优等生发了张「永远不会退步」的证书。

二、**冻结才能当指纹。** 宽池必须是从真库抽出来的**快照文件**，不是每次跑时现查库。现查库的探针今天 0.933、下周 0.917，那它不是判据，是天气预报。可复现性的代价是它与真库越来越不一样——这个代价要照着付：快照过期时靠「重新导出 + 换代记账」解决，不是每次跑时去摸真库。

三、**每一档守卫线都要配一道「它必须变难」的对照。** 宽池加了 106 条，如果读数一条不动，有两种可能：引擎真的稳，或者宽池没接进去。分不清就等于没测。`wideP.hit1 < narrowP.hit1` 这一行才是「宽池确实生效」的证据——它红了不代表退步，代表探针坏了，而这两件事必须能分开。

四、**取数口径不能有第二套。** 诊断脚本自己写一份 `ALS` 漏掉 project 层，让四道题假死三个版本，账上写成「gold 过期」。凡是要复算的读数，池子的层、状态、字段都得从 fixture 或生产那一处来——自己另立一套，量出来的不是引擎的问题，是自己的疏漏。

一句话：**小房间里人人都认得出来；要证明眼睛好，得把人放到大街上。**


## 188. 有些问题不该问词面：状态是「仓」，不是「词」

词法检索的隐含假设是「答案和问题用同一批词」。这个假设在语料里写满标识符时依然成立
（问 `0.2.148` 就答 `0.2.148`），但它对一类问句彻底失效：**问局面的问句**。

「现在主线推进到哪一版」——答案得是那条「项目现状」，可它和问句一个词都不重。
这不是「排得不够准」，是**问句问的层级变了**：它不问「哪句话讲了这件事」，
它问「现在什么情况」。而「现在什么情况」写在固定的几个仓里。

所以正确的做法不是继续调权重，是**认出问句的类别，然后去对的仓取**。
权重只管「同一批候选里谁靠前」，管不了「候选里根本没有它」。

### 三条约束，缺一条就会自己咬自己

1. **只能认「局面词」，不能认「时间词」。** 「现在 / 当前 / 最新」是对象问句里最常见的修饰
   ——「现在推送欠账什么规矩」问的还是那条规矩。放了时间词，现状仓会把所有带「现在」的问句都抢过来。
   局面词是「到哪一版 / 推进到 / 当前待办 / 项目现状」，它们本身就描述了「在问局面」。
2. **问原因、问方法要让路。** 「评测线为什么封存」里有「封存」这种局面词，可它问的是缘由。
   这种情况交回普通检索——现状仓能给「是什么」，给不了「为什么」。
3. **同仓要么全抬、要么别抬。** 只抬最新一条，读到的是被整理过几次的旧稿。
   这个仓里的条目本来就互为版本，一起上浮才是「这个仓现在说什么」。

### 分数要跟榜首走，不能跟自己的词分走

被抬的那条词分通常是 0。若按「自己的分 × 系数」算，抬完还是 0。所以要取**当下榜首的实际分数**
乘一个 1.15 的系数——意思是「比现在最好的答案再好一头」，而不是「按它的证据强度给分」。
它本来就没有证据强度，它的强度来自「它是那个仓」。

### 否决也是一等结论

这一版顺带把稠密检索正式否掉：三档全输（0.933→0.644 / 0.714→0.357 / 0.700→0.500），
任何 RRF 权重都补不回来。理由不是「模型不好」，是**这个库的性质**——条目里全是标识符，
稠密对标识符不敏感，而 BM25 对它精确。结论写进 INTERNAL 并加断言锁住，
是为了下一个版本不再花两小时重新探一遍同样的路。

**一句话：权重决定「谁排前面」，「认类别」决定「谁在候选里」。这两件事必须分开做。**

## 189. 词法检索不懂「同一件事」，那就把「同一件事」写下来

词法检索的世界里只有字。问句说「远端仓库」、正文写「上传到远端」，它看到的是两组毫不相干的字，
覆盖度直接归零——不是权重没调好，是它根本没有「这两句在说同一件事」这个维度。

补这个维度的路只有两条：让机器算相似度（稠密向量），或者让人把同一件事的几种说法写下来（同义词表）。
0.2.176 用宽池 146 条把第一条路走完了：三档全输，任何融合权重都补不回来，
因为这个库的条目满是标识符，而稠密对标识符最不敏感。于是只剩第二条。

第二条路看着笨，但它有一个向量给不了的性质：**可读、可 diff、可以被人指出写错了**。
一张十八组的表，谁都能扫一眼说「这组不该并」。二十万个向量维度，没人能指出哪一维错了。

代价是这张表是全局的：组里混进一个泛词，全库的问句互相拉分。
所以它必须配硬阴性对照——不是「读数涨了就好」，而是「关掉桥之后，这条分数必须明显更低」。
涨分可以是巧合，掉分不可能是。

**一句话：算法补不上的缺口，要么让机器学会，要么让人写下来；写下来的一定要能被指出写错了。**

## 190. 同一串字，有时是坐标，有时是主语

问句里写着 `0.2.148`，这串字的意思可能是两件事：

- 「**在 0.2.148 那个时候**，基线收敛了两轮吗」——它在给出一个时间坐标，
  答案是那一刻发生的**过程**，跟这串字本身无关；
- 「**0.2.148 那一版**交付了什么」——它就是主语，答案必须是那一条记录。

检索器分不清这两件事，就会做一件很蠢的事：谁把这串字写进了自己头上，谁就最相关。
于是「0.2.148 已交付」这种条目，在**任何**提到 0.2.148 的问句下都排第一，
哪怕问的是那时的过程、那时的心情、那时的教训。

这不是排序参数的问题，是**语义角色**的问题。词法检索天生看不见角色：它只看见这串字出现过。
所以只能人工给「角色」写一处判据——

> 后面跟着「的时候 / 当时 / 那会儿」，这串字就是坐标；
> 后面跟着「那一版 / 的交付 / 本身」，它就是主语。

判据必须落在**结构词**上。这件事在 0.2.176 已经学过一遍：那一版认「状态问句」的时候，
第一版把「现在 / 当前 / 最新」也算进去了，结果「现在推送欠账什么规矩」这种对象问句被现状仓抢答。
泛时间词看着无害，其实到处都是。这里是同一条道理：**判据要认句子的形状，不认句子里的高频词**。

还有一处值得记住：这一刀真正生效的地方不是「减分」，是「不许加分」。
特权档、词分加成、加法补分是三条独立的路，只掐一条，另外两条会把结论顶回去——
探针第一版就红在这里，`band` 明明已经是 0，分数还是被补分顶着。

**否决也是设计的一部分**。这一版试了三个机制都没成：因果证据（问原因就给「因为」加分）、
长度封顶（限制 BM25 的长度归一化）、新鲜度不看重要度。三个都在文档里留了读数。
以后再有人（包括我自己）觉得「给因果加点分应该有帮助」，先看这三行数字。

## 191. 问「为什么」和问「该怎么做」不是同一件事

记忆里同一个实体常常同时出现在两种记录里：一种是「它当时怎么了」，一种是「关于它有什么规矩」。
问句也是两种：问「为什么封存」「还能跑吗」，要的是前者；问「上限怎么设」，要的才是后者。

词法检索看不见这个区别。它只看见「评测台」三个字在两条里都出现，而规矩那条更短、词面更密、
importance 更高——于是但凡问句里提到这个实体，规矩条就压上来。用户问「评测线为什么封了」，
拿到的是一条「禁止无预算花 key」：**话题对了，问题没答**。

所以层级不只是「有多重要」，还是**回答仓**：project / topic 是叙述层（发生过什么、为什么），
rules 是规矩层（该怎么做）。问缘由时去叙述层取，问做法时去规矩层取。

判据同样是**句子形状**，不是关键词打分：只有缘由句（为什么 / 缘由 / 经过）与现状句
（还能用 / 还在不在 / 封存 / 现状）走这条，普通问句一刀不切。0.2.178 与 0.2.176 都栽在同一处——
想用「一组词」表达「一种问法」，结果那组词在别的地方到处都是。

还有一处值得记：这一版的机制在**主动注入**通道里被有意关掉。
检索答错就是噪声，注入多提一句常常是好事——同一个信号在两条路上的取舍可以相反，
不该为了「统一口径」把它抹平。

## 192. 两套秩序：谁进哪一档，和谁排第一

排序不是一条直线。先是分档——谁的证据更硬；档内再比分数。折价如果只乘在分数上，
就是在**一个看不见的账本上打折**：乘数确实乘上了，分数确实小了，可档位没动，名次也不动。
实测过一次：把乘数压到 0.1，那条的分数只剩 2.385，仍然排在那条 9.131 的前面。

所以任何「压低某类记忆」的机制，先要回答一个问题：**它压的是分数，还是档位？**
只压分数，只在同一个档位内部有效；一旦被压的那条本该掉出这一档，就必须连分档所用的量
（这里是 `_raw`）一起压。三条路要同源，才能保证「压了就是压了」——一个 helper（`ruleFoldOf(di)`）、三处引用，
比三处各写一遍乘子可靠得多。

判据也要跟着这件事改。守「压过之后名次变没变」，别守「乘数有没有乘上」——后者是自证，
前者才是效果。而「逐位相同」这种判据在读数已经满分之后会自动反转意思：
它从「机制无害」变成「机制无效」，该换成不等式。

## 193. 0.3 的承诺形状：只加不删

版本号不是流水号，是**承诺的粒度**。0.2.x 的一百八十个补丁版说的是「还在改，接口随时可能变」；
0.3 说的是另一件事：**接口面不再删**。落成四条具体的话：

1. **工具面冻结**：8 个 `memory_*` 工具的名字、参数、返回字段不改。要加就加新的可选参数、新的返回字段。
2. **注入面冻结**：常驻注入保持一段、1,235 字符。不因为加了功能就把它撑大——注入是每轮付费的，涨一个字就是每轮都涨。
3. **库面冻结**：七层 SQLite 与 format-1 索引。升级只许加列、加表、加迁移步骤，不许改既有列的含义。
4. **读数封版**：`tools/baselines.json` 记下每支自检的条数，少一条判红。这是「0.3 是什么样」的可执行定义——
   不是文档里说的样子，是跑出来的样子。

第 4 条是这一版的骨架。前面 180 个补丁版攒下的判据（1,700+ 条）如果只是「现在都绿」，那下一个改动能悄悄拆掉十条而没人知道；
记进基线之后，「拆掉」本身就是一次红色。0.2.176 起做的「探针量比值、不量名次」是同一件事的前半段：
比值能在机制调整后仍然成立，名次不能。基线把「成立」这件事也钉住了。

**发布面是同一份承诺的三个入口**：npm（`npm i dsh-macro-memory`）、GitHub（仓库与 tag）、
awesome-dsh-plugin 目录（`category: memory` 的一条 yml）。三处写的东西必须一致——
目录站的评审会读仓库，npm 页面会读 `repository` 字段，README 里的读数会被对着 `baselines.json` 数。
一处虚，三处都塌。

还有一件容易忽略的事：**版本下限断言别把主版本写死**（INTERNAL 9.188）。承诺是「不早于」，不是「等于 0.2」。
把偶然值当成语义，下一次跳版本号就要改 61 处——那是把版本号的代价算在了断言头上。

## 194. 数字的时效是工程问题，不是写作问题

一个数字跑出来之后，只有一次是「现状」，之后就一直是「历史」——但它不会自己带上这个标签。
0.3 之前留下的最贵的一笔债就是这个：2026-11-20 那次端到端 LLM-judge 的 71.95，是 omni3、deepseek-chat 判分、
0.2.x 时期的 meow 核心跑出来的；此后检索层又动了上百个版本（同义词桥、覆盖度打折、分档收口、dedupe、cap、
实体先验、日期回传），到 0.3.0 接口面冻结又是一次大改。**这期间没有重跑过端到端评测**，但那个数字仍然被当成
「现在的水平」到处引用——包括我自己拿它去排下一阶段的优先级。

病根不是算错了，是**口径没有落盘**。所以做法不是「下次注意」，是给它一个可执行的定义：`docs/EVAL-CLAIMS.md`。

1. **两张表分家**：表 A 是能引用的现状读数（带日期 + 版本/commit + 复核命令），表 B 是历史读数（带口径）。
   一个数字要么在 A 里能跑出来，要么在 B 里带着出处躺着，不许有第三态「我记得大概是」。
2. **三件套**：日期 + 版本/commit + 数据集口径。缺一项就当场写成「历史读数」，不许靠上下文暗示。
3. **过期不等于没用**：版本之间的**差值**（0.5351 → 0.5987 → 0.7195）在口径不变时可以继续当方向参考，
   绝对数不行。判据是「换没换那套尺子」，不是「旧不旧」。
4. **不许把闸门当广告**：`probe-gold` / `probe-recall` 的断言是仓库回归闸门，不是端到端效果。混着讲，
   读者会把「40 条样张上 hit@1 1.000」读成「真实问句有 100% 命中」。
5. **重测要人点头**：判分走外部模型、要花钱、要一段稳定时间，属于「代价可观的验证」，不是随手能跑的脚本。

落成文件而不是塞进 README，是因为两者的读者不同：README 的读者要一句「这些数字哪来的、信不信得过」，
一张指路牌就够；口径单的读者是改代码的人，需要能照着复现。README 那一节现在写明「本节只放仓库闸门读数，
LLM-judge 那类在 EVAL-CLAIMS.md」。自查不用 grep 手心算：`Select-String -Path README.md,docs\*.md -Pattern "71\.95"`，
每条命中都得同句带口径。

## 195. 查询分解：原榜一个字不动，才敢说「这把刀有用」

multi-hop 一直是弱类。但检索侧的 hit@20 已经有 0.740——**正解常常已经在池子里，是单条 query 的排序把它压下去**。
于是最自然的下一步是「把问句拆成几个子问句，各查一遍再合并」。

难点不在拆，在合并。只要允许子问句改变原榜的顺序，开关「开」与「关」就不再是同一把尺子：
A/B 读数会变成「两个系统谁更好」，而不是「这个机制值不值」，后者才是要回答的问题。所以合并写成硬约束：

1. **原榜 append-only**：原 query 的 `hits` 一条不动、顺序不动，子问句的结果只往后追加。
   `value.hits = [...baseHits, ...子问句新补的]`，判据里直接钉这一行。
2. **子问句走放宽档位**：`min_rel: 0, band_keep: false`——原榜被「档位收口」压掉的条目正是要捞的东西，
   拿收紧的尺子去捞等于白跑。
3. **三道闸门**：`score > 0`、每问最多 2 行、最多 3 段。规则拆句会切错（单字段、无并列焦点的句子），
   闸门的作用是让「切错了」退化成「没补到东西」，而不是「补进来一堆噪声」。
4. **顺序钉死**：预算收紧 → 分解补充 → 星图扩散。反过来的话，收紧那步会拿原参数再查一次，
   把刚补进去的段落冲掉——这类错误在代码里读不出来，只能靠一条位置断言守。
5. **不猜**：没有并列焦点（连接词 / 多问号）就返回空数组，不硬拆；开关写错一律当 off（只认 `conservative`
   与 `off`，大小写与前后空格不敏感，其余任何值都退成 `off`），不猜用户想要什么。

拆句本身是纯规则，不调模型：先按多问号切，没有再按 `以及 / 还有 / 和 / 跟 / 与 / 、` 贪心切（顿号允许单字，
其它连接词要求两侧至少 2 字），再剥疑问词壳（`为什么` / `有什么区别` / `哪个更…`），剥完不足 2 字就丢。
这套规则拆不动的句子会被闸门吃掉——这正是它的边界，也是为什么开关默认 `off`：**没验证过的能力不许默认改变行为**。

判据在 `verify.mjs` 的 A58b 块（9 条）。它们故意不进 `tools/criteria.mjs` 那 45 条清单：
那份清单被四处 `list.length === 45` 数着，加一条会连带红四个无关判据——判据的代价要算在改动头上，不能转移。

## 196. 巩固要的是信号，不是计数

「同一话题写第 4 条起触发巩固」——这句话听起来在守「重复」，其实守的是「勤奋」。
一天里写四条不相干的事会触发，同一件事连写三条反而不触发；阈值数的是条数，不是模式。**计数可以调，信号才能被反驳。**

改成三条件同时成立：

1. **重复模式**：同 `project` 内、`keywords` 与本次交集 ≥ 2 的条目在近 7 天里 ≥ 3 条。这才叫同一件事反复出现。
2. **慢路有空位**：该 `project` 近 7 天的语义层（`rules` + `fact`）少于 8 条。有空位才准新增语义条目；
   满了说明这一层不缺条目，该并进已有的那条——**「并条」和「再写一条同义摘要」是两件事，只有前者不制造重复**。
3. **未巩固**：这批正文里还没有巩固句。这是幂等锁，防同一批材料每轮都触发一次。

为什么默认 `suggest` 而不是 `write`：真库里有主人的真实记忆，一条自动摘要冒充「结论」的代价，
远大于它省下的那点笔头功夫。`suggest` 只把材料端出来（哪几条、日期、首句、现成的模板），
写不写由人决定。这不是谨慎，是**成本不对称**：多写一条的代价是永久的，少写一条的代价是下一次再问一句。

`write` 态也不写 `supersedes`。哪一条承载了这件事，规则判不出来；随便挑一条并进去，
比不并更糟（读者会以为那条被合并了，而它其实只是被挑中）。所以「并条」只作为提示出现。
巩固句 `（已巩固进：<新id8>「<摘要头 24 字>」，<日期>）` 复用取代句的机制——同一形状、同样不改 `status`——
因为**「巩固」不是「作废」**：被巩固的那条仍然是当时最准确的说法，它只是多了一个指向后来的入口。

## 197. 内部诊断不能替用户「看过」

巩固检查在每次写入后打两枪检索。这两枪在计数上都对，在状态上是破坏性的：meow 的成功路径会顺手
`bumpHit`（抬召回次数）并 `markSearched`（记进「本会话已端给你看过」）。于是用户写完一条记忆、
紧接着问「跟这条像的有哪些」，会得到一句「候选一条都没有」——因为**刚刚是插件自己把它们都看过了**。

这个 bug 是被一条更早的判据（相似检索的 H6：面板的相似度与工具的相似度必须对得上）抓到的，
而不是被「巩固检查有没有发查询」抓到的。差别在尺子：前者的尺子量的是**状态**（候选还在不在），
后者量的是**次数**（发了两枪）。所以任何「调用了几次」的断言都证明不了「这次调用没副作用」。

修法不是撤销那两枪，而是给检索加一个内部开关：`internal: true` 时跳过 `bumpHit` 与 `markSearched`，
默认 `false` 照旧记账。模型侧拿不到这个参数（`tools/param-audit.mjs` 的 `WITHHELD` 白名单记着
「为什么故意不暴露」，并用 `1.1b` 双向钉住——白名单里的必须真的被扣下，被扣下的必须真的在名单里）。

一般化：**「读」不是无副作用的操作**。任何把查询当探针用的地方，都要先问一句
「这次读会不会被记成用户读过」。记错了账，后面所有基于账的判断（相似候选、召回闭环率、
「这条还没人读过」）都会一起错。

## 198. 谁先进库谁在前，等于让存储布局回答问题（0.6.3）

排序这件事，写了一辈子 `sort` 反而最容易漏掉一把钥匙：**并列**。`hits.sort((a, b) => (bandOf.get(a) - bandOf.get(b)) || (b.score - a.score))`
在分数不同的时候完全正确，可分数一样时它返回 0，而 V8 的 `Array.prototype.sort` 是稳定排序——稳定的意思是
**保留原顺序**，也就是保留语料里「谁先进库」。同一份 40 条同构语料，原序问出 `t-00..t-04`，
打乱（seed=1）问出 `t-31,t-23,t-28,t-38,t-27`：同一个问题，两个答案。

这类缺陷的坏处不在「排序差一点」，而在**它把外部变量偷偷接进了答案**。docs 的顺序不是调用方给的，
是存储层给的：更新会改 rowid、`VACUUM` 会重排、分页会换顺序、换一台机器重放一次快照又是另一个顺序。
于是任何对外读数都只是「抽到的那一次」，任何「问两遍结果一样吗」的抽查都靠运气通过。

修法是补齐三把钥匙，让定序只依赖数据本身的属性：**分档 → 分数 → 更新得更晚的在前 → id 自然序**。
`stampOf` 把 `updated_at`（数字或 ISO 串）统一成可比值，并列时后来者在前（用户刚改的那条该被看见）；
`cmpText` 是码元序但**数字段按数值比**，于是 `D1:2` 排在 `D1:10` 前面。最后那一把必须存在，因为前两把
都可能全等：同一天写、同一句话写两条，除了 id 没有任何东西能区分它们——那就用 id，但要用**人读得懂的顺序**。

自然序不是审美，是被读数逼出来的。第一版用了纯字典序（`d.id < e.id`），LoCoMo 立刻掉：
hit@1 0.3932→0.3926、hit@5 0.6192→0.6179、hit@20 0.7511→0.7505、MRR 0.4958→0.4953。
原因是 LoCoMo 的 dia_id 是 `D1:2 … D1:10 …`，字典序把 `D1:10` 排到 `D1:2` 之前，正好与时间序相反——
并列的候选被倒着排回去。把数字段按数值比之后，读数一位不差回到原值，确定性上去、分数没让，
所以这条自然序是**用两套读数夹出来的**，不是拍出来的。

同类的暗桩还有两处，一起收掉：`searchAdaptive` 挑簇原来写 `order.sort((x, y) => raw[y] - raw[x] || x - y)`，
`x - y` 是**语料下标**，注释里写着「稳定」，实际上是把「谁是第几条」当成了第二把钥匙；
两处合并排序用 `String(id).localeCompare(...)`，而 locale 随 ICU 与机器变——换台机器，答案就换。
前者的替代是 `laterFirst(docs, x, y)`（同一套「更新更晚」的判断，按下标版），后者换成 `cmpText`。
全文件仍留两处 `localeCompare`，都在会话名/项目分组这种**显示层**，不参与检索定序；判据 D7 的白名单只放过它们。

教训：**并列不是边界情况，是常态**。任何「按分数排序」的检索都会在重复语料、同构条目、
模板化记忆上大面积并列；只要比较函数在相等时返回 0，你就把决定权交给了数组顺序，
而数组顺序你控制不了。写比较函数时最后那把钥匙必须是**稳定、可复现、与输入顺序无关**的。

（判据：`tools/probe-determinism.mjs`，九条 D1–D8。其中 D8 是能红证明——把梯子换回两跳再编译，
同一语料打乱即换前十；这条红线只能在**没 import 过真引擎的子进程**里量，否则同进程里已加载的那份引擎
会让红模块也「看起来确定」，量出来是假绿。全过程见 `docs/INTERNAL.md` 9.202。）

---

## 199. 分词器的粒度不是用户的粒度（0.6.4）

一个汉字进来，系统说「没有」。这不是检索算错了分，是**它在第一步就没把这句问句当成问题**。

`tokenize` 处理中日韩时只产出二元组（`if (run.length >= 2)`）。于是：

```
tokenize('读')     → []                  ← 一个汉字，切不出词
tokenize('读两遍') → ['读两','两遍']      ← 两个汉字以上，正常
```

`search()` 的第一道门是 `if (q.length === 0 && idents.length === 0) return []`——它本来是合理的
（空问句不该检索），但它把「**切不出词**」和「**没有内容**」当成了一回事。而这两件事的区别，
正是这个插件存在的意义：`回执不全 ≠ 库里没有`。切不出词是**分词器的局限**，不是库的状态。

这类错误特别难被发现，因为它在正常读数的噪声里完全隐形：LoCoMo 的 1,531 问里没有一道是单字问句，
真库 52 问也没有。它是扫边界（`E:\Temp\cmp\edge.mjs` 拿空串、标点、正则元字符、超长、null、
emoji 挨个试）试出来的——**边界扫雷的价值不在「不崩」，而在「不崩但答错」**。

处方窄到只治这一件事：问句切不出任何词、**且问句本身就是一个汉字**时，按原文子串在
title / content / keywords 里数命中次数，分数仍然交回四把钥匙定序。三个设计取舍：

1. **闸门是「一个码点 + 汉字」，不是「短」**。`the`、`a` 也短，但它们被停用词吃掉后做子串匹配
   是纯噪声——`probe-gold` 的 G8「没有的事就空手」就是专门抓硬凑的，实测改完仍是空手 10/14。
2. **扫 title + content + keywords，不只扫 content**。关键词里写着的字也是「库里有」。
3. **两条打分路径一起改**（`search` 与 `keywordHitScore`）。只改一条，就会出现「换个入口答案就没了」，
   比原来更坏——那种不一致最难被用户归因。

读数一个字没动（LoCoMo 全指标与真库三档逐位相同），因为兜底只在**原本必然回空**的问句上生效。
这就是「修漏洞不开新门」的标准形态：能红证明（挖掉兜底 → `读`/`花` 立刻回空）比涨分更重要。
（判据：`tools/probe-literal.mjs`，十一条 L1–L8；账见 `docs/INTERNAL.md` 9.203。）

## 200. 用户打的是问句，不是测试用例（0.6.5）

0.6.4 的单字兜底把「一个汉字」从空手里救了回来，闸门写的是「正好一个码点」。探针一上真形状就露了：`读` 中、`读？` 空。合成语料里的问句是干净的，键盘上的问句从不干净——标点是语气，不是内容。

三个设计取舍：

1. **剥外壳，不剥语义**。闸门先按 `\p{P}` 与 `\s` 把非汉字切出去，再要求剩下的汉字集合大小恰为 1。`读？`、`「读」`、`读…`、`读 读` 都归到同一个 `needle1`；`读1`、`读x`、`读$` 被挡在门外——多出来的不是标点，是别的东西。
2. **闸门守「一个汉字」，不守「短」**。放行短串做子串匹配是最省事的写法，也是最容易把「没有的事」凑成有事的写法：英文停用词、单字母、单个数字全部会漏进来，G8 立刻红。宁可少救一类，也不开噪声门。
3. **修可达性不碰排序**。分数仍是命中次数，定序仍交给 0.6.3 的四把钥匙；读数因此又是一位没动。洞和分要分开记账——不然「读数没涨」就会被误读成「白干」，而这一版真正买回来的是「问得出就答得上」。

一个可复用的判据形状：**能红证明要退回上一版的闸门，而不是删掉整个函数**。`L13` 在子进程里把闸门换回 `if (cps.length !== 1) return [];`，得到 `1,0`——`读` 仍中、`读？` 回空。这比「函数不存在 → 全空」精确得多：它证明的是「这一行闸门正是那一格」。

（判据：`tools/probe-literal.mjs` L9–L13；账见 `docs/INTERNAL.md` 9.204。）

## 201. 数据有坏形状，代码不能变成异常（0.6.6）

记忆库不是只有一个写入者。这个插件的库里有：自己写的行（`keywords` 是数组）、导入的历史行、别的插件写的行、以及调用方在内存里自己拼的 `docs`。它们的 `keywords` 可能是缺字段、`null`、`'浇花, 施肥'`。三种坏形状都不该让检索崩，因为**「这条数据不好」和「库里没有答案」是两个完全不同的答复**。

三个设计取舍：

1. **归一化写成唯一入口 `kwList(d)`，不是每个调用点各写一份 `Array.isArray`**。引擎里四处把 `keywords` 当词表（`docText` / `kwToks` / `kwSets` / `keywordHitScore` 的 `content`），各写一份的结果是迟早漏一处——而漏的那一处就是这次崩的那一处。
2. **逗号串要真的进 tf-idf，不能只是「不崩」**。原来 `kwToks` 用 `Array.isArray(...) ? ... : []` 把字符串形态静默判成空表，等于老数据的关键词一直隐形。修「不崩」很容易顺手把这条也修了，但它需要单独一条断言钉住（`DT066` 的第二条），否则下次重构又会退回去。
3. **缓存签名必须覆盖归一化后的值**（`mix(kwList(d).join('\u0001'))`）。签名原来对字符串形态一律记 `-1`：词表改写、签名不变 → 拿旧索引答新库。这条与 0.6.3 的定序账同源——**缓存的键要覆盖所有影响结果的东西**。

这类缺陷最麻烦的地方是它不在读数里：LoCoMo 1,531 问、真库 52 问，全程 `keywords` 要么是数组要么缺失，读数因此**一位没动**。它不是被评测发现的，是被「写另一个探针时脚本自己崩了」发现的。所以判据的价值也更直接：`probe-dirty` 摆的是**七种坏形状同时进池**，D5 专门量「脏条目有没有改写干净问句的第一名」——脏数据可以存在，但不许有话语权。

（判据：`tools/probe-dirty.mjs` D1–D8；账见 `docs/INTERNAL.md` 9.205。）


## 202. 元素本身也可能是坏的（0.6.7）

0.6.6 治的是**字段的形状**：`keywords` 缺失 / `null` / 逗号串。这一版治的是**元素本身**：`docs` 数组里混进一条 `null`、`undefined` 或标量（半写的行、导入被截断、调用方把 id 和对象搞混），`docText(d)` 的 `d.title` 立刻 `TypeError: Cannot read properties of null (reading 'title')`；`docs` 整个不是数组时死在 `docs.length`。同一族病、两种崩法，后果一样：**不是少一条命中，是一个回执都拿不回来**。

三个取舍：

1. **闸放在入口，不撒在每个函数里**。`docText` 被 `findSimilar` / `topicDrift` / `verbatimInputs` 共用，`keywordHitScore` 又自己遍历一遍；在每处加 `d &&` 是「记得住才行」的写法，下一处新调用点照样漏。所以只有一个入口闸 `liveDocs(docs)`，`search` 与 `keywordHitScore` 各一行 `docs = liveDocs(docs);`（`searchAdaptive` 走 `search`，自动同口径）。
2. **干净路径不许付代价**。先扫一遍「有没有坏」，全好就**原样返回同一个引用**；脏了才 `filter` 出新数组。这条不只是省内存：干净路径不产生任何行为差，读数才可能一位不动。
3. **闸不许打掉缓存**。索引缓存的键本来就是内容签名（`indexPathKey` = `${indexSignature(docs)}|开关位`），不靠数组身份，所以入口过滤不会让缓存失效；反过来说，0.6.4 记过的那条否决（「缺 id 的脏主键在入口过滤 → 每次造新数组、缓存全失效」）在内容签名落地之后不再成立，判据 D9 就是量这件事：坏元素在位时干净问句的第一名不许变。

全是坏行时回空数组，不把 `null` 当一条记忆去打分——**脏数据的存在不等于脏数据有话语权**（与 0.6.6 的 D5 同一条原则）。

（判据：`tools/probe-dirty.mjs` D9–D13；账见 `docs/INTERNAL.md` 9.206。）

## 203. 判据也会过期（0.6.8）

这一版不改引擎，改的是**判据自己的寿命**。版本号 / 支数 / 断言总数 / 耗时预算都是「会随时间前进的量」，写成等值就等于给自己埋了一颗每版必响的雷：`0.2.31→35` 踩过四遍版本等值，`0.6.2→0.6.7` 每版都在手工抬 `steps.length === 35 → 36`，还要连带改两处文档里手抄的「N 支 / M 条」。红一次不算事故，但每次「不该红的红了」都在训练人无视红——那才是真代价。

三个取舍：

1. **地板代替等值**。`const SUITE_FLOOR = 37` + `steps.length >= SUITE_FLOOR`：减支立刻红（删套件、忘了注册进 `check-all` 都要拦），加支不必动判据。抬地板是「这一版起承诺有这么多支」的明确动作，与「今天恰好几支」分开记。等值把这两件事混成一件，于是每次真变化都伪装成故障。
2. **文档数字由事实对账，不由人手抄**。探针读 `tools/baselines.json` 的 `counts` 求和，再比 README 自证规模行与 `EVAL-CLAIMS` 健康基线行。数字错了会红，但红的是「文档与事实不符」——这恰好是我想让它红的那件事；而「版本升了」这种正常事件不再触发任何改动。
3. **历史里程碑冻结，阶梯按版本号比**。旧里程碑保留自己那版的数字（0.6.6 里仍是 3,616），否则「版本阶梯」会变成一条恒等线、看不出增长；比较按版本号两两进行（不按版面顺序），因为 README 的排版历史上乱过。

判据 `tools/probe-monotone.mjs` 9 条（M1 地板 / M2 静态扫描 50 个脚本 / M3 扫描器能红也认绿 / M4+M4b 两处文档对账 / M5 阶梯单调 / M6 旧账冻结 / M7 耗时预算 / M8 扫描面完整），`verify.mjs` 的 `MT068` 五条钉住「这条规矩本身还在」。账见 `docs/INTERNAL.md` 9.207。

## 204. 量尺自己也得先量（0.6.9）

0.3.0 起的每个对外读数都是「单次、单序」量出来的：语料按库里顺序、问句按夹具顺序、跑一遍记一个数。这一路上我们用这些数**否决**过三个候选（英文词形归一 0.7511→0.7198、MMR +0.66pt 噪声级、覆盖率重排 −2.4pt）。问题在于：如果量尺对顺序敏感，那些负数里就掺着量尺自己的噪声，而「有证据地不做」这个结论也就不成立了。所以 0.6.9 不动引擎，只量尺子。

三个取舍：

1. **判据必须是「两个数一模一样」，不是「差不多」**。用 `===` 而不是容差：检索层是纯确定性计算（0.6.3 已把定序梯子钉死），任何抖动都该是本轮引入的缺陷，而不是「浮点误差」。上容差等于给抖动留后门。
2. **互换要换三个方向，不只换语料**。语料倒序、语料打乱（seed 3/11/42）、问句倒序是三条独立的失败通道：前者抓「谁先进库谁在前」，后者抓「idf 预热与缓存命中顺序影响读数」。只换语料会漏掉后者，而后者恰恰是「跑一遍取一个数」最容易骗人的地方。
3. **独立 scorer，而不是同一个函数跑两遍**。第二套实现按「want 反查最早名次」写，与主 scorer 的「先取 ids 再比对」是两条代码路径；两套同时写错才可能一起错。这条是给聚合值上保险——对外引用的就是聚合值。

判据 `tools/probe-rigor.mjs` R1–R6（见 INTERNAL 9.208）；R5 是「能红」：给 scorer 注入「同分按语料序」，A/B 互换后第一名命中数必然不同（23 → 15），证明这条判据真在盯东西。


## 205. 每问一次都在重算「库没变」（0.6.10）

索引缓存的键是**内容签名**（0.6.7 起刻意不靠数组身份，这样入口闸过滤出来的新数组不会打掉缓存）。代价是：签名要在**每一次检索**上重算一遍，而它回答的问题——「这库还是不是我上次建表的那个库」——绝大多数时候答案是「没变」。这一版没有动打分，只动这笔固定开销。

钱花在两处。①每条都要 `content.slice(0, 40)`、`content.slice(-40)`、`kwList(d).join('\u0001')`，三次分配；②逐字符 `Math.imul` 的 FNV 混算。实测（660 / 2,000 / 5,000 / 10,000 条同构语料）签名占一次热检索的 **28.8%–30.6%**，0.96 / 2.84 / 7.04 / 14.16 ms —— 与「库多大」线性相关，却与「问什么」完全无关。

三个取舍：

1. **按条记账，而不是按整库记账**。整库记账得快，但判等只能靠「数组身份 + 长度」这类弱信号，弱信号漏判就是拿旧表答新库。按条记账把判等降到「这条的字段值有没有变」，强度与重新哈希同级（字符串 `===` 是 memcmp）。
2. **必须把条级哈希从滚动值里拆出来**。老实现把每条一路 XOR/imul 进同一个滚动值，同一条的贡献随「前面有谁」变化，天然不可缓存。拆成「每条先算自己的 32 位哈希，再折进总账」之后，条级值只由这条自己决定——这是能缓存的前提，不是为了好看。拆的代价是签名数值整体变了（它只是内部键，没有任何东西依赖它的具体值）。
3. **判不出有没有变的形状，走直算**。字段是对象、`keywords` 元素不是标量时，`String()` 的结果可能随对象自身状态变，值比较判不出来；这种条目干脆不记账。缓存只接「值比较就能判断」的条目——宁可对少数形状慢，不许对任何形状错。

能红证明落在两处：S3/S4/S5 是「就地改必须变」（同一对象、同一数组、等长改写），S9 是反证——本地复刻一个「只按对象身份记账」的坏实现，它在同一组用例上当场漏判。性能侧 S8 要求记账后比记账前快 5 倍以上（实测 14.5×），这样「慢了但对了」不能混过去。判据全表见 INTERNAL 9.209。

## 206. 原样匹配也要记账（0.6.11）

0.6.10 把签名那笔钱省下来之后，接着把剩下的大头点名。做法不是继续猜「哪里慢」，而是**按通道开账**：同一批语料、同一批问句，只把一条通道关掉（`{ verbatim: false }`），差值就是这条通道的钱。结果很干净——原样匹配占了 **35.7%–50.6%**，而且随条数涨得比别的都快。

原因不是匹配贵，是**造字符串贵**。原样匹配要回答的是「这条里有没有原样出现这个标识符」，实现上却每问一次先跑 `docs.map((d) => textOf(d).toLowerCase())`：`id + project + title + content + keywords.join(' ')` 拼一遍再整体小写。10,000 条时这是 2.03 MB 的字符串，每次检索重建一遍；而真正的扫描只要 0.51ms，造串要 5.78ms —— **九成的钱花在造零件上**。

处方沿用 0.6.10 的形状：这笔钱算的是「库里有什么」，跟签名、切词表一样，**库没变就不该重付**。于是 haystack 搬进索引缓存，`hayAt(di)` 懒建（用得上才建，建过就复用），并记账（`built` / `reused`）。三个取舍：

1. **跟着索引走，不另起缓存**。索引缓存的键已经是内容签名，haystack 的生命周期与切词表完全一致；另立一个缓存就得再维护一套失效逻辑，而失效逻辑重复两遍迟早有一遍漏。
2. **懒建，且没有标识符就问都不问**。问句里一个标识符都没有时这条通道本来就不参与打分（0.6.10 的 `hayOf === null` 语义），此时一条都不许建——否则「不在路上」也会变成「顺手付钱」。V8 盯的就是这个。
3. **搬进索引，就必须被签名覆盖**。这一条是被现实抓出来的：haystack 里含 `project`，而 `project` 从来没进过签名。老实现每问现拼，所以「改 `project` 拿旧串」在现实中看不出来；搬进索引之后它就成了真 bug。修法是把 `project` 补进 `sigDocHash` 与值比较，并新增 S10（就地改 `project` 签名必变）把它钉住。**凡是搬进索引的字段，都得先进签名**——这是这一族改动的通用规矩，不是这一条的特例。

读数（全量检索，ms）：660 **2.04 → 1.62**、2,000 **5.04 → 4.20**、5,000 **11.88 → 9.12**、10,000 **24.45 → 18.82**；原样匹配份额降到 18.6%–34.9%。排序没动一位（LoCoMo 1,531 问与真库 52 问逐位不变），因为这条通道只决定「有没有原样出现」，从来没参与定序。判据全表见 INTERNAL 9.210。

## 207. 定序只排前 k（0.6.12）

按通道开账开到 0.6.11，剩下的钱用 cpu-prof 按函数归因：`bandize` 与它的两个比较器合计 **40.3%**，约 11 ms/问，比扫文档（11.3%）还贵。原因不是比较器写得慢，而是**比了不该比的东西**：`bandize` 对全量命中排两遍——先按 `_raw` 排一遍只为算档位，再按 `(档位, 分数, 更新时间, id)` 排一遍定次序；而它的三个调用点在排完之后**只取前 5 条**。10,000 条语料上，每次检索都在为 5 条答案给 9,995 条陪跑排队。

处方三条，都不动「档位怎么算」，只动「怎么把前 k 捞出来」：

1. **档号落字段，不再走 Map**。`Map<对象, 档>` 每问要建、要查、要扔；hit 对象本来就是这个问句的临时物，档号挂在 `h._bandTmp` 上等于把两次哈希换成一次属性写。
2. **比较器抽成一条梯子**。`orderOf(a, b)` = 档位 → 分数 → 更新得更晚的在前 → id 自然序——四个键全是数据本身的属性，全序路径与堆路径共用它。梯子只有一处，就不会改半条。
3. **有界最大堆选前 k**。容量 `want` 的堆，根是入选里最差的那条，新来的更好就顶掉根。`want >= total`（小库、`k` 很大、`k=Infinity`）整段退回原来的全量排序，行为逐位不变——**新路径只在「真的有东西可省」时才走**。

为什么截断安全：档位本身按**全量** raw 算，阈值链与排序无关，「进不进第一档」不因截断改变；堆只在档位已定的前提下挑前 k，比较器与全序同源，所以前 k 与「全量排完再切」逐位相同（O1 用 500 组随机语料 × k∈{1,2,5,8,20,∞} 对拍）。**唯一的语义变化是返回条数**：以前回全量、调用方自己 `slice`，现在自己截——三个调用点本来就只取前 k，对成交付不变。

读数（10,000 条 / 300 问）：`search` **27.377 → 19.985 ms（−27.0%）**、产品走的 `searchAdaptive` **31.086 → 23.097 ms（−25.7%）**；定序份额 **40.3% → 21.5%**，`orderOf` 自身只占 0.9%。质量一位没动：真库 52 问 0.921 / 0.417 / 0.500、LoCoMo 0.3932 / 0.6192 / 0.6924 / 0.7511 与各项 MRR、recall 逐位不变，返回条数合计 1,500 不变。判据与账见 INTERNAL 9.211。

## 208. 定档不再靠全量排序（0.6.13）

0.6.12 把定序截到前 k，复测发现剩下最大的一块**还是排序**，而且比定序更没必要：`bandize` 里那句 `hits.slice().sort((a, b) => b[rawKey] - a[rawKey])` 只为**算档位**——档位是「相对榜首的 85% 三分法」，它只需要知道「raw 值排完之后，谁落在哪一档」，并不需要把 10,000 个**对象**按 raw 排成一行。cpu-prof 里那 21.5%（比较器逐对读对象字段、逐对相减）全花在这件本可以用数值做的事上。

处方三步，口径一字不改：

1. **把 raw 抄进 `Float64Array`，用原生 `.sort()`**。TypedArray 的默认排序是纯数值升序、不调 JS 比较器，一次拷贝比一万次回调便宜得多。
2. **阈值链只走一遍**。从最大值往下扫，遇到「小于 `0.85 × 当前锚点`」才开新档、更新锚点——这正是老循环在做的事，只是现在扫的是排好的数值数组，不再扫对象。
3. **二分查档**。锚点表升序排好，每条拿自己的 raw 二分出「第一个 ≥ v 的锚点下标 `lo`」，档号 = `m - 1 - lo`（第 0 档的锚点最大，落在表尾）。每条一次 `log m` 比较，总体 `O(n log m)`，且没有任何对象字段访问。

**退回路是这一版最要紧的一笔**：阈值链的正确性建立在「锚点严格下降」上（`a_{i+1} < 0.85·a_i < a_i`），而这前提在两种数据上不成立——raw 为负数时 `0.85·a > a`，链会往上走；raw 为 `NaN` / `undefined` / `null` / `Infinity` 时比较根本不成立。这两种情况直接 **不猜**：`setBandsByThreshold` 返回 `false`，`bandize` 退回 0.6.12 的老全量排序 `setBandsBySort`（老代码原样保留成独立函数，逐位可对照）。指认档（`_ident` / `_subj === 1`）照旧恒 −1，且**不进阈值链**——老代码是 `continue`，跳过它就等于不让它当锚点，这条语义在数值版里靠「先筛出参与排序的条目」保下来。

读数（10,000 条 / 300 问）：`search` **19.985 → 16.329 ms（−18.3%）**、`searchAdaptive` **23.097 → 18.812 ms（−18.6%）**；定档那一块 **21.5% → 7.8%**（`setBandsByThreshold` 7.0% + `bandize` 其余 0.8%），`orderOf` 1.1%、索引热命中 0.70 ms/问、冷建 273 ms。答案一位没动：真库 52 问与 LoCoMo 全项逐位不变。判据 `probe-order` O1–O10 与 `verify.mjs` OR073，账见 INTERNAL 9.212。

## 209. 热路上不留痕（0.6.14）

0.6.13 把定档那块从 21.5% 压到 7.8% 之后，`--cpu-prof` 再点一次名，最大的一块回到了 `search` 自证（45.8%）与 `scanDoc`（17.8%）。按行摊开就看出问题不在算法上：`delete h._lv;` 一行 **791.5ms**，`delete h._vb;` 与 `delete h._sr;` 另 **353ms**——总采样 5,671.8ms 里有 **1.14s** 花在「把刚挂上去的临时值摘下来」。

原因在 V8 的对象形状：`search` 给每条候选人建一个 hit 对象，四个「先用后摘」的中间值（`_vb` 原样命中位、`_sr` 句式比、`_lv` 层级意图、`_tr` 断言密度）以前直接挂在对象上，收尾时 `delete`。`delete` 一旦发生，对象就进**字典模式**——此后每次属性读写都走哈希表，而不是固定的 inline cache。而这个对象接下来还要被 0.6.13 刚优化过的 `bandize` 反复读 `_raw`、被 `orderOf` 读分数与 `updated_at`：先挂后摘省下的那点赋值，反手把整条热路降级了。

处方两条，口径一字不改：

1. **临时值进平行数组**。`vbTmp` / `srTmp` / `lvTmp` / `trTmp` 与 `hits` 同下标、push 紧挨 `hits.push`，收尾段改成按 `hi` 下标读数组。回执对象的字段集合与以前完全一致（`_subj` / `_raw` / `cover` / `_band` 都在，`explain` 一条不少），只是不再有中间字段可摘。
2. **idf 每趟记一次账**。`scanDoc` 里每条候选人、每个查询词都要调一次 `idfOf(term)`，而 idf 只由词的 df 决定、同一趟里是常量——每问建 `idfCache` + `idfAt(t)`，值逐位相同（同一个 `Math.log`，只是不再重复算）；自适应 idf 换尺子时清账（`idfCache = new Map();`），否则第二遍会拿旧尺子的数。

顺带收掉两笔每问一次的固定开销：`raw.slice()` 只在 `explain === true` 时留（关掉时没人看），`Math.max(...raw)` 换成循环（10k 参数展开会真的把实参表铺开）。

读数（10,000 条 / 300 问）：`search` **16.329 → 11.567 ms（−29.2%；相对 0.6.12 的 27.377ms 是 −57.7%）**、`searchAdaptive` **18.812 → 13.520 ms（−28.1%）**、热路 `delete` 零处；索引热命中 0.679 ms/问、冷建 275 ms。答案一位没动：真库 52 问与 LoCoMo（1,531 问）全项逐位不变。判据 `probe-hotpath` H1–H6 与 `verify.mjs` OR074，账见 INTERNAL 9.213。

## 210. 覆盖度不再逐条重算（0.6.15）

0.6.14 收掉那 1.14s 的 `delete` 之后，`--cpu-prof` 第三次点名（总采样 4,143.7ms）：`search` 自证 40.6%、`scanDoc` 18.8%（1,003.6 → 777.5ms）。按行摊开，`scanDoc` 里最贵的一行是覆盖度那句：

```js
for (const term of qKept) if (tfi.has(term)) cover += idfAt(term);
```

单行 **573.9ms / 300 问**（1.9ms 一问）。它算的是一件很朴素的账——「这条命中了几成问句词（按 idf 加权）」——但算法是**二维**的：对每条候选人（最多 10,000 条），把问句词表（最多几十个）从头问一遍 `Map.has`。而倒排 `postings` 里本来就记着「每个词出现在哪些条里」，同一笔账**顺着倒排往回加一遍**就够：工作量从「候选数 × 问句词数」降到「这些词的出现次数之和」。

处方三条，口径一字不改：

1. **问句词表的 idf 每趟记一次**。`qKeptIdf` / `qLoopIdf` 两个 `Float64Array` + `refreshQidf()` 一趟填好；打分循环里 `const idf = qLoopIdf[qi]`，不再每词一次 `idfAt`（0.6.14 只是把这笔账从「每条 × 每词」降到「每词」，这里再降到「每问」）。
2. **覆盖度顺倒排记账**。`coverAcc` 按 `docs.length` 开一张零表，`buildCoverAcc()` 按 qKept **原序**把 `qKeptIdf[qi]` 加到 `postings.get(term)` 的每一条上；`scanDoc` 里只剩 `coverOf[di] = Math.min(1, coverAcc[di] / qIdfSum)`。加法的**顺序仍是 qKept 原序**，所以每条的浮点和逐位不变——这是这一刀能过对拍的前提。
3. **倒排缺席时退回原路**。`opts.inverted === false`（探针与阴性对照用）或问句带标识符时 `postings === null`，`coverAcc` 直接是 `null`，`scanDoc` 走逐条查表的老路（`buildCoverAcc` 头一行 `if (coverAcc === null) return;`）。退回路一个字没动。

顺带把 `const dOf = docs[di];` 提到候选循环头：这一条下面要读十来次同一条记录的字段（`level` / `importance` / `status` / `content` / 两个时间戳 / 回执透传的七个字段），原先每次都在重算下标。

**换尺子那趟必须重记两笔账**：自适应 idf 换的是「词的重要度尺子」，`qKeptIdf` / `qLoopIdf` 与 `coverAcc` 都得跟着换，否则第二遍扫描会拿旧尺子的数——顺序钉死为「清 idf 缓存 → `refreshQidf()` → `buildCoverAcc()` → `raw.fill(0)` 重扫」（探针 C3 直接对源码顺序断言，因为这一支在小夹具上物理上触发不了：`idfClusterOf` 要 top-8 里有区分词、`adaptiveLamOf` 要榜首分差落在 0.05–0.15，同分小语料恒 `lam = 0`）。

读数（10,000 条 / 300 问，五次取中位）：`search` **11.567 → 10.673 ms（−7.8%；相对 0.6.12 的 27.377ms 累计 −61.0%）**、`searchAdaptive` **13.520 → 12.522 ms（−7.4%）**、覆盖度那一行 **573.9 → 14.9 ms**、`scanDoc` 自证 **23.8% → 18.8%**；索引热命中 0.698 ms/问、冷建 271 ms。答案一位没动：真库 52 问与 LoCoMo（1,531 问）全项逐位不变。判据 `probe-cover` C0–C5 与 `verify.mjs` OR075，账见 INTERNAL 9.214。

## 211. 打分不再逐条查表（0.6.16）

覆盖度那一刀下去之后，`--cpu-prof` 第四次点名（总采样 **3,295.9ms**，0.6.15 是 4,143.7ms）：`scanDoc` 已经不是热点，新的头号一行换成了打分循环里那句：

```js
const f = tfi.get(term);
```

单行 **535.3ms / 300 问**。它算的是 BM25 那套：**这个词在这条里出现了几次** × **这个词有多稀罕** × **命中的是标题还是关键词**。三个输入里，前两个（词频、字段命中）在建索引时就已定死，第三个里的字段权重 `FIELD_KW_W` 是**每问参数**（`opts.fieldKwW`）。可老实现把它们全留在热路上：对每条候选人、每个问句词，先 `tf[di].get(term)` 查词频，再 `titleSet.has(term)` / `kwSet.has(term)` 查字段——三次哈希查找，其中**大多数还是「这个词这条根本没有」的空手**。倒排 `postings` 里本来就有「词 → 哪些条」，这件事倒过来扫就够。

处方三条，口径一字不改：

1. **倒排值从「下标数组」扩成 `{ d, f, t }`**：`d` 下标、`f` 该条该词的词频（含 `kwTfW` 的关键词加成）、`t` 字段命中位（`1 = 标题`、`2 = 关键词`，取位或）。`f` / `t` 在同一条 doc 循环末尾按 `m` 的插入序 push，而 `m` 的插入序与首见序一致，所以 `f` / `t` 与 `d` **同下标对齐**。字段权重值本身**不预乘**——`opts.fieldKwW` 是每问参数，烧进索引就等于「索引缓存按权重分裂」。
2. **打分倒过来扫词**：`scoreCandSet` 先把每个候选的常数备好（`coverOf[di]`、`kDen[di] = k1 * (1 - bEff + bEff * len / dl)`、协调项 `cvr`），再按 `qLoop` **原序**让每个词只碰它真出现过的条，把 `idf0 * fw * (f * (k1 + 1) / (f + kDen[di]))` 直接加进 `raw[di]`（`fw = 1 + (fl & 1 ? FIELD_TITLE_W : 0) + (fl & 2 ? FIELD_KW_W : 0)`，加法顺序与老实现逐字一致）。收尾才按候选表补 `synOf` / 协调项 / 实体层——与老实现同一份算式。每条拿到的加数顺序仍是 qLoop 原序，所以**浮和逐位不变**；`qLoop` 词的倒排条天然是候选集的子集，热路不需要再判成员。
3. **逐条扫的退路一个字没动**：倒排关掉（`opts.inverted === false`）或问句带标识符（`verbOn`，走原样匹配通道）时 `candSet === null`，仍走 `scanDoc`——首趟与换尺子那趟两处都留着。

**换尺子那趟必须先重铺候选**：`scoreCandSet` 开头 `candArr.length = 0;`。少了这一句，自适应第二趟会把候选再 push 一遍，收尾循环对同一条算两遍（`synOf` / 协调项 / 实体层叠乘）——第一次实测就是这样：非自适应路逐位相同，只有 `0.6.0 开` 换说法 hit@3 0.750 → 0.833、MRR 0.569 → 0.583，指纹非常明确（同一函数被调两次）。

读数（10,000 条 / 300 问，三次取中位）：`search` **10.67 → 8.35 ms（−21.8%；相对 0.6.12 的 27.377ms 累计 −69.5%）**、`searchAdaptive` **12.52 → 10.16 ms（−18.9%）**、总采样 **4,143.7 → 3,295.9ms**；索引热命中 0.692 ms/问。代价只有一条、且只付在冷建上：**269 → ~300ms（约 +11%）**，倒排每个词多存两个数组。答案一位没动：真库 52 问与 LoCoMo（1,531 问）全项逐位不变。判据 `probe-score` S0–S5 与 `verify.mjs` OR076，账见 INTERNAL 9.215。

## 212. 命中对象先瘦后水化（0.6.17）

打分改成顺倒排累加之后，`--cpu-prof` 第五次点名（总采样 **1,808.2ms**，0.6.16 是 3,295.9ms）：`search` 自证从 48.0% 掉到 **9.0%**，剩下的最贵几行不是算法——是**回执对象的字面量本身**：

```js
hits.push({
  _subj: ...,
  _raw: raw[di] * (...),
  cover: ...,
  ...(anchored ? { anchored: true } : {}),
  id: dOf.id,
  level: dOf.level,
  ...
  ...dOf.keywords === void 0 ? {} : { keywords: dOf.keywords },
  ...
  score: ...,
  explain: ...
});
```

十四字段 + 四个条件展开 spread，行级各 **134–176ms**、合计 **约 1.07s / 300 问**（`vendor/meow-memory/lib/index.js:3858-3883`）。它给**每条 raw>0 的候选**都建一份完整对象，可 `bandize` 定档、`trimByBand` 截断最后只留前 k 条——绝大部分对象的字段根本没人读。扫 10,000 条、k=8 时，等于为 9,992 条注定被丢掉的东西付整份对象钱（还额外付 GC）。

处方三条，口径一字不改：

1. **扫描期只铺定档要用的六样加一个下标**：`leanHit = opts.explain !== true && opts.keepBand !== true` 时 `hits.push({ _subj, _raw, cover, id: dOf.id, updated_at: dOf.updated_at, score: raw[di] * w * impW * stW * foldOf, _di: di })`。这六样正好是定档与定序的全部输入：`_subj` / `_raw` 定档，`score` / `updated_at` / `id` 定序（并列时比更新时间与 id 字典序）。`_di` 只是回查下标，不进回执。
2. **截断之后再水化**：`const outHits = trimByBand(hits, k, opts);` 之后把入选的 k 条按 `matHitOf(h, di)` 原地换回完整对象——键序与原字面量**逐字一致**（`_subj` → `cover` → 可选 `anchored` → `id` → `level` → `title` → `content` → `importance` → `updated_at` → 五个可选字段 → `score`），所以 `JSON.stringify` 与老实现逐字节相同（含键序）。`score` 直接取瘦对象上那份：它已经被标识符补分、层级意图、断言密度、现状仓改过，重算会把补分丢掉。水化是**原地替换数组元素**，不换数组——`trimmed` / `rescueAdded` 是挂在数组上的非枚举属性，换数组就丢。
3. **`explain` 与 `keepBand` 两条路照旧走完整字面量**：前者要在对象上就地打补丁（identBonus / subjBonus / levelIntent / tipAssert / statusDigest），后者要把 `_band` 留给 searchHybrid 融合。statusDig 推入的 `{ ...d, _raw, cover, score }` 没有 `_di`，水化时 `if (di === void 0) continue;` 跳过它。

读数（10,000 条 / 300 问，三次取中位）：`search` **8.35 → 3.5 ms（−58%；相对 0.6.12 的 27.377ms 累计 −87%）**、`searchAdaptive` **10.16 → 4.5 ms（−54%）**、总采样 **3,295.9 → 1,808.2ms**；索引热命中 0.688 ms/问、冷建 288–301ms（与 0.6.16 同量级，瘦对象不改建索引）。答案一位没动：真库 52 问与 LoCoMo（1,531 问）全项逐位不变。判据 `probe-hydrate` H0–H5 与 `verify.mjs` OR077，账见 INTERNAL 9.216。

## 213. 候选集不再用 Set：位图 + 首见序候选表（0.6.18）

命中对象先瘦后水化之后，`--cpu-prof` 第六次点名（单次 `search` 3.49ms，总采样 **1,808.2ms**）：前五名里第四位是**候选集那段立即执行函数**（**137.4ms / 7.6%**），紧随其后是 `scoreCandSet` 的 **112.2ms**。两处是同一件事的两个半场：

```js
const candSet = postings === null || verbOn ? null : (() => {
  const set = new Set();
  for (const term of qKept) {
    const p = postings.get(term);
    if (p === void 0) continue;
    for (const di of p.d) set.add(di);
  }
  // …扩词那一段同样 set.add(di)
  return set;
})();
// 打分时：
for (const di of candSet) { … }
```

`Set.add` 每个下标都要算哈希、找桶、查重；而候选量在 10,000 条的库上本身就是万级。查重这件事，整数下标不需要哈希表——每条 doc 只有「进没进过候选」两种状态。

处方两条 + 一条不动：

1. **位图去重**：`const candAt = postings === null || verbOn ? null : new Uint8Array(docs.length);`，去重退化成 `if (candAt[di] === 0) { candAt[di] = 1; candList.push(di); }`——一次 TypedArray 读、一次写、一次 push，没有哈希、没有桶。
2. **候选表保首见序**：`const candList = candAt === null ? null : [];`，按「先问句词、后 `synOf` 扩词」两段依次 push。**首见序就是 Set 的插入序**，所以 `candArr` 的铺法、扫描顺序、浮点加法顺序、回执顺序全部逐位不变；打分循环也从 `for (const di of candSet)`（迭代器）换成 `for (let ci = 0; ci < candList.length; ci++) { const di = candList[ci]; }`（下标）。
3. **退路一个字没动**：倒排关着（`opts.inverted === false`）或问句带标识符（`verbOn`，走原样匹配）时 `postings === null`，`candAt` / `candList` 都是 `null`，两处 `if (candList === null) {` 照旧逐条扫全库。`kDen` / `cvrOf` / `candArr` 的判空跟着从 `candSet === null` 改成 `candList === null`。

读数（10,000 条 / 300 问，三次取中位）：`search` **3.49 → 3.01 ms（−13.7%；相对 0.6.12 的 27.377ms 累计 −89%）**、总采样 **1,808.2 → 1,678.4ms（−7.2%）**，候选集那段已掉出前 20；索引热命中 0.688 ms/问、冷建 291–308ms。答案一位没动：真库 52 问（`0.6.0 关` 与 v0.5.0 仍逐位相同）与 LoCoMo（1,531 问）全项逐位不变。判据 `probe-cand` C0–C5 与 `verify.mjs` OR078，账见 INTERNAL 9.217。

踩坑：C3「扩词那条路真的被走到」连红两次，两次都不是实现错，而是**信号选错**——①`df` 是含 `keywords` 的文档频次，扩词有 df 上限 `cap = max(1, floor(n × 0.35))`，小库（n=7）里 `df(beta)=3 > cap=1`，扩词被门挡掉；②把库垫到 39 条后扩词生效，但被桥接回来的那条分低、**被 `trimByBand` 剪掉**，回执里永远看不出多一条。最终判据改看 `trimmed` 属性（开桥 1 / 关桥 `undefined`）与回执条序，不看分数——桥会顺带给「keywords 里有该词」的条目加分，那是扩词自己的账，不是这次改动的账。

## 214. 定档不再排序：桶计数排序 + 段扫（0.6.19）

候选集改成位图之后，`--cpu-prof` 第七次点名（单次 `search` 2.98ms，总采样 **1,678.4ms**）：第二名是 `setBandsByThreshold`，**235.6ms / 14.0%**；按行摊开，最贵的一行是 `vals.sort()`，**164.9ms**，占这个函数七成。它要干的事是「把一万条 raw 从大到小走一遍，每遇到「< `IMP_BAND × 上一个锚点`」就开新档」：

```js
const vals = new Float64Array(plain);
for (let i = 0, j = 0; i < total; i++) { … vals[j++] = h[rawKey]; }
vals.sort();                       // ← 164.9ms：为「从大到小扫」付一整趟比较排序
const anchors = [];
let anchor = -1;
for (let i = plain - 1; i >= 0; i--) {
  const v = vals[i];
  if (anchors.length === 0 || v < IMP_BAND * anchor) { anchors.push(v); anchor = v; }
}
anchors.reverse();
```

锚点链只用到**排序后的不同值**，而「从大到小」并不意味着「必须全序」。

处方三条 + 一条退路：

1. **桶键取位模式的高 32 位**。非负有限 double 的 IEEE 位模式与数值同序，所以 `rawkBucketOf(v)` 只需把 64 位看重的高字取出来右移：`rawkBits[0] = v; return rawkBitsU[1] >>> RAWK_SHIFT;`（`RAWK_SHIFT = 16`，`RAWK_NB = 1 << 16`）。16 位桶意味着桶宽是**尾数的高 16 位**，同桶最坏差 6.25%——同桶任意两值的比值 ≥ **0.941**，远大于 `1 - IMP_BAND = 15%`，因此**同一桶里最多落一个锚点**；桶内不必排，取最大值就够。
2. **计数排序攒段 + 沿桶号从高到低走一趟**。先把每个值按桶号攒进连续区间（`out[rawkHist[rawkBucketOf(v)]++] = v;`，`rawkHist` 是 `Uint32Array(RAWK_NB)`，先计数再前缀和），然后从 `top` 桶往下：桶 b 的区间是 `[b === 0 ? 0 : rawkHist[b - 1], rawkHist[b])`，扫这一段取「`< anchor < 0 ? Infinity : IMP_BAND * anchor`」的最大值当锚点；整桶都 ≥ 阈值就 `continue`（这一桶没有值能当锚点）。
3. **桶 0 特判**。0 与全部次正规数同落桶 0（指数位全零），这一段相对跨度**没有上界**（0 与 5e-324 之间能塞进整条次正规数轴），同桶一个锚点的前提在这里不成立——单独把这一段拷进 `rawkTail`、`sort()` 之后按同一条链走。语料跨 1e±300 时全靠它。
4. **小端缺席的退路**：位模式与数值同序的前提是**本机小端**（`RAWK_LE` 在模块加载时用 1.0 = `0x3FF0000000000000` 验一遍）。不成立就直接 `vals.subarray(0, n).sort()` 走老的 `anchorChainSorted`。**只排前 n 个**——`rawkVals` 是跨调用复用的缓冲，尾巴上是上一轮残值，整段排会把残值混进前 n 个。

**为什么逐位不变**：锚点链的定义一个字没改（「从大到小、遇到 < 0.85×上一锚点就开档」），桶只改「读值的顺序」；同桶不可能有第二个锚点，桶内取的是最大值而不是排序结果；桶 0 那一桶就是真排序。定档侧仍是原来的二分 `m - 1 - lo`（`lo` = 第一个 ≥ v 的锚点下标），一个字符没动。

读数（10,000 条 / 300 问，三次取中位）：`search` **2.982 → 2.52 ms（−15.4%；相对 0.6.12 的 27.377ms 累计 −90.8%）**、`searchAdaptive` **4.105 → 3.51 ms（−14.5%）**、`setBandsByThreshold` **235.6 → 74.0 ms（14.0% → 4.9%）**、新函数 `anchorChainOf` 自己 28.5ms（1.9%）、总采样 **1,678.4 → 1,520.9ms（−9.4%）**，索引热命中同前、冷建 292–299ms（同量级）。答案一位没动：真库 52 问（`0.6.0 关` 与 v0.5.0 仍逐位相同）与 LoCoMo（1,531 问）全项逐位不变。判据 `probe-band` B0–B6 与 `verify.mjs` OR079，账见 INTERNAL 9.218。

踩坑：①`new ArrayBuffer(8)` 不能下标赋值，必须 `new Uint8Array(b)[7] = …`；②小端判定要写 `u[6] = 0xf0; u[7] = 0x3f;`（1.0 的高字是 `0x3FF00000`），只写 byte7 会得到 `RAWK_LE === false`、静默走退路（慢但不报错）；③退路忘了 `subarray(0, n)` 时 `probe-order` 一次红掉 O1/O4/O6/O7/O9/O10 六条——复用缓冲的残值混进前 n 个，正是「缓冲复用」的指纹；④B4 第一次红是我的**参考实现写错**：用「数一遍锚点 > v」当参考，而引擎是 `m - 1 - lo`，两者在「落在 0.85 阈值缝里」的值上差一档——参考必须照 `setBandsBySort` 的字面语义（从大到小走、遇阈值才开档）写。

## 215. 签名校验不再查 WeakMap：按数组下标对齐的行缓存（0.6.20）

定档换成桶计数排序之后，`--cpu-prof` 第八次点名（单次 `search` 2.52ms，总采样 **1,624.0ms**）：第一名换成了 `sigDocOf`，**265.5ms / 16.4%**。它要回答的只有一句「这张库还是刚才那张库吗」——`indexSignature(docs)` 沿着文档数组走一遍，每条比八个字段，合成一个 FNV 风格的总签名，再拿这个签名当 `searchIndexCache` 的键：

```js
function indexSignature(docs) {
  sigStats.calls++;
  let h = 2166136261 >>> 0;
  h ^= docs.length;
  h = Math.imul(h, 16777619) >>> 0;
  for (const d of docs) {
    h ^= sigDocOf(d);                 // ① 先 WeakMap.get(d) 取上次那份条级记录 ② 再逐字段比
    h = Math.imul(h, 16777619) >>> 0;
  }
  return `${docs.length}:${h >>> 0}`;
}
```

条级记录本身早就缓存了（`SIG_DOC_CACHE`，键是文档对象），所以字段比较是便宜的——贵的是**取**：10,000 条的库，每问 10,000 次哈希表查找。而同一个数组第 2 次进来时，`docs[i]` 连位置都没变。

处方两条 + 三条不动：

1. **对齐行缓存**。新增 `const SIG_ROW_CACHE = new WeakMap();`，键是**文档数组**，值是 `{ n, visits, row }`；`row = new Array(n)` 与下标一一对齐，行里放的就是 `SIG_DOC_CACHE` 里那份条级记录（同一个对象，不是副本）。取值从「按对象查哈希表」变成「按下标取数组元素」：`function sigDocOfRow(row, i, d)`，命中判据与原来逐字段一致（`id` / `updated_at` / `updatedAt` / `content` / `title` / `source_session` / `project`，再加上关键词逐元素比 `sigKwSame`）。
2. **只在第 2 次访问才铺行**。`slot.visits++` 之后 `if (slot.row === null && slot.visits >= 2) slot.row = new Array(n);`。真库里调用方常常每次新建一个数组（`docs.slice()` / 每次从库里读一批），那时铺一张一万格的空表等于反过来变慢——首访只记一格计数、不分配，第二次才铺。

三条不许省的：

- **合并顺序不能动**。行缓存只换「取值方式」不换「合并顺序」：`h ^= …; h = Math.imul(h, 16777619) >>> 0;` 仍按文档顺序逐条合并，签名才与原来逐位相同（否则 `searchIndexCache` 的键、`probe-signature` 的断言会一起崩）。
- **计数口径不能动**。行命中照旧 `sigStats.hashed++` / `sigStats.reused++`，与走 `sigDocOf` 时完全同口径；非对象、字段非标量、关键词元素非标量的条目**行里留空**、照旧现算（`row[i] = fresh === void 0 ? void 0 : fresh;`），否则两条形状不同的脏值会被认成同一条。
- **非数组的可迭代物走旧路**。`if (Array.isArray(docs))` 才走行缓存，`for (const d of docs)` 的循环一字未动——数组以外的东西（生成器、array-like）没有「下标对位」这回事。

顺带把 `searchIndexOf` 里「一问算两遍签名」收成一遍：`const sig = indexSignature(docs);` 之后 `const key = indexPathKey(docs, opts, sig);` 与 `given.__sig === sig &&` 共用同一份结果。

读数（10,000 条 / 300 问，三次取中位）：`search` **2.52 → 2.04 ms（−19.0%；相对 0.6.12 的 27.377ms 累计 −92.5%）**、`searchAdaptive` **3.51 → 2.59 ms（−26.1%）**、总采样 **1,624.0 → 1,433.5ms（−11.7%）**、`sigDocOf` 从榜单掉出（活并进 `indexSignature`，116.3ms / 8.1%）；「每次新建数组」那条路 **2.58 → 2.60ms**（噪声内，不退化）。答案一位没动：LoCoMo locomo10 十个样本 / 5,882 条轮次 / **1,986 问**逐问比对新旧引擎 top-20 —— **0 处不同**；真库 52 问（`0.6.0 关` 与 v0.5.0 仍逐位相同）三档 0.921 / 0.417 / 0.500 照旧。判据 `probe-sigrow` R0–R5 与 `verify.mjs` OR080，账见 INTERNAL 9.219。

踩坑：①R2 第一次红是**测量顺序**不是口径——两条路共用一批文档对象时，先跑的那条会把条级缓存填满，后跑的自然是全 `reused`，两路必须各用一份互不相干的同形库；②`sigDocOfRow` 第一版用 `e.id === d?.id` 逐项比，`d` 是 `null` / 字符串 / 数字时全部字段都 `undefined` 且相等，会把两条脏值认成同一条——补上 `d !== null && typeof d === 'object'` 这一道门；③`indexSignature` 换下标循环之后，`docs.length` 必须只取一次（`const n = docs.length;`），旧写法在循环里读 `docs.length`，遇到边算边改数组的调用方会读到中间态。


## 216. 词法分类不再逐字符跑正则：BMP 表 + 惰性建一次（0.6.21）

0.6.20 把签名校验换成对齐行缓存之后，`--cpu-prof` 的行视图（`E:\Temp\cmp\profline.mjs`，输入 `E:\Temp\cmp\prof20c\CPU.20261124.095937.14676.0.001.cpuprofile`，10,000 条 / 300 问，总采样 1,433.5ms）把第一名指到了 `classify`：

| 行 | 自证 | 干什么 |
| --- | --- | --- |
| `vendor/meow-memory/lib/index.js:1631` | **71.4ms / 5.0%** | `if (CJK.test(cp)) return "cjk";` |
| `vendor/meow-memory/lib/index.js:1632` | **16.2ms / 1.1%** | `if (WORD.test(cp)) return "word";` |

函数合计 **88.7ms / 6.2%**。它每调一次就过两道 Unicode 属性正则（`\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\u3005\u30fc` 与 `\p{L}\p{N}`），而 `tokenize` 对每个码点都要问一次、每段还要再问一次边界——建库时一万条正文、每问若干次，过的全是同一批码点。分类结果只由码点决定，这是纯查表问题，却在热路上反复跑正则引擎。

旧码（0.6.20）：

```js
var CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\u3005\u30fc]/u;
var WORD = /[\p{L}\p{N}]/u;
function classify(cp) {
  if (CJK.test(cp)) return "cjk";
  if (WORD.test(cp)) return "word";
  return "skip";
}
```

处方两条，口径一字不改：

1. **BMP 表**：`CLS_SKIP = 0` / `CLS_CJK = 1` / `CLS_WORD = 2`，`buildClsBmp()` 把 0x0000–0xFFFF 拼成一个大串（65,536 个码点），再用**那两条正则自己**扫出连续段填进 `new Uint8Array(65536)`：先 `new RegExp(CJK.source + "+", "gu")` 填 1，再 `WORD.source + "+"` 只补还是 `CLS_SKIP` 的格子——**语义等价是构造出来的，不是手抄区间猜出来的**。
2. **惰性建一次**：`var clsBmp = null;`，`clsCode(cp)` 里 `cp.length === 1` 才查表（`t[cp.charCodeAt(0)]`），星外码点（`cp.length === 2`）与孤立代理项照旧走 `CJK.test` / `WORD.test`；表在第一次分类时才建，一次 64KB、实测 **3.5ms**，此后一次下标取数。

```js
function clsCode(cp) {
  if (cp.length === 1) {
    var t = clsBmp === null ? (clsBmp = buildClsBmp()) : clsBmp;
    return t[cp.charCodeAt(0)];
  }
  if (CJK.test(cp)) return CLS_CJK;
  if (WORD.test(cp)) return CLS_WORD;
  return CLS_SKIP;
}
```

`tokenize` 改吃数值（`cls === CLS_SKIP` / `cls === CLS_CJK`、`while (j < nCp && clsCode(cps[j]) === cls) j++`），不再比字符串；`classify(cp)` 留成 `'cjk'/'word'/'skip'` 的字符串包装，对外名一个字没改。

三条不许省的：

- **表必须由正则扫出来**：手抄 Han/Hiragana/Katakana 区间看着简单，但 `\u3005`（々）与 `\u30fc`（ー）是 Common 脚本，`\p{L}` 又收了一堆符号外的字母——抄漏一个就是切词变化，而这种错不会报错，只会悄悄改变召回。
- **优先级照旧**：先 cjk 后 word，word 只补空格（同属两者的码点必须归 cjk）。
- **星外不许进表**：`Uint8Array(65536)` 只有 BMP，`cp.length === 2` 的形状必须原路返回，否则代理对会被拆成两个半个码点。

读数（10,000 条 / 300 问，三次取中位）：`search` **2.04 → 2.00ms（−2.1%；相对 0.6.12 的 27.377ms 累计 −92.7%）**、`searchAdaptive` **2.59 → 2.53ms（−2.5%）**、**冷建 292 → 233.5ms（−20%）**（tokenize 的大头在冷建）、总采样 **1,433.5 → 1,337.0ms（−6.7%）**，`classify` 从前 20 名掉出去。

踩坑：①这一刀真正的收益在**冷建**不在热问——热问每问只切几个短句，省下的 88.7ms 摊在 300 问里看不见；读数要同时看 `coldMs`，否则会误判「改了没用」。②`buildClsBmp()` 里那个大串必须用 `String.fromCharCode` 逐个数拼成 6.5 万个码点（`String.fromCodePoint` 会产出代理对，破坏了「一个下标一个码点」的对齐）。③判据不能只测几个样本：`probe-lex` 的 L1 把全 1,112,064 个码点逐点与旧正则对拍，一次跑完约 1.5s，比任何抽样都便宜。

## 217. 建索引不再把同一批字段切两遍：分段 + 成词两趟，`seen` 退场（0.6.22）

**症状**（0.6.21 之后，`--cpu-prof`，10,000 条 / 300 问，总采样 1,337.0ms）。热查那条链已经压到 2.00ms，贵的地方全挪到了冷建：

| 位置 | 自证 | 干什么 |
| --- | --- | --- |
| `vendor/meow-memory/lib/index.js:3331` | 23.1ms | `buildSearchIndex` 的字段预处理 |
| `vendor/meow-memory/lib/index.js:3370` | 21.0ms | `m.set(t, (m.get(t) ?? 0) + 1)` 词频累加 |
| `vendor/meow-memory/lib/index.js:3397` | 17.8ms | `postings.get(t)` 铺倒排 |
| `vendor/meow-memory/lib/index.js:3373` | 13.6ms | `df.set(t, …)` 记文档频率 |
| `vendor/meow-memory/lib/index.js:3399` | 11.5ms | `p.t.push(…)` 记字段命中位 |

函数级：`buildSearchIndex` **138.3ms / 10.3%**、`bumpIn` 65.8、`buildCoocSyn` 43.0、`coocShareHan` 29.7。

**病根两条**：

1. **同一批字段被切了两遍**。`plainToks` 切 content（`dText` 那一趟），`bodyLen` 又 `tokenize(String(d.content ?? ''))` 切一遍；`plainToks` 切 title，`titleSets` 又切一遍；keywords 在 `kwToks` 与 `kwSets` 两处写着一字不差的两份 `docs.flatMap((d) => kwList(d).flatMap((w) => tokenize(String(w ?? ''))))`。
2. **每条配一个 `seen` Set**。每个（条, 词）对要先 `seen.has(t)` 再 `seen.add(t)`，只为回答「这个词在这条里是不是第一次出现」。加上词频那句的 `m.get` / `m.set`，一个对子四次哈希查找。

**处方两条**：

1. **把切词拆成两段**。`tokenize` 原来是「逐码点切段 + 按整表成分决定要不要英文化」两步，现在拆开：

```js
function tokenizeSegs(text) { /* 原逐码点循环：二元组 / 整词小写 / 跳过 */ }
function finishToks(list) { return isMostlyLatin(list) ? normalizeEn(list) : list; }
function tokenize(text) { return finishToks(tokenizeSegs(text)); }
```

建索引时 title / content **各只 `tokenizeSegs` 一次**，三张表全在这两份分段上就地成词：

```js
const ts = tokenizeSegs(String(d.title ?? ''));
const cs = tokenizeSegs(String(d.content ?? ''));
const body = finishToks(cs);
bodyLen[i] = body.length > 0 ? body.length : 1;
plainToks[i] = kwSep ? finishToks(ts.concat(cs)) : finishToks(ts.concat(cs, kwList(d).flatMap((w) => tokenizeSegs(String(w ?? '')))));
if (titleSets !== null) titleSets[i] = new Set(finishToks(ts));
```

keywords 只成词一趟给 `kwFlatArr`，`kwToks`（`kwSeparate` 真）与 `kwSets`（`fieldBoost` 真）都从它派生。

2. **`seen` 退场，首见判据换成 `m.get`**：

```js
const cur = m.get(t);
if (cur === void 0) {
  m.set(t, 1);
  df.set(t, (df.get(t) ?? 0) + 1);
  const p = postings?.get(t);
  if (p === void 0) postings?.set(t, { d: [di], f: [], t: [] });
  else p.d.push(di);
} else m.set(t, cur + 1);
```

关键词支路同形，首见写 `kwTfW` 而不是 1。`m` 里「键不存在」本来就等价于「这个词在这条里第一次出现」——两次写入都是 `m.set`，只增不减，`seen` 是纯冗余。

**为什么逐位不变**（三条，缺一条就会错）：

- **分段可交换**：`tokenizeSegs` 是纯函数，空格与标点都是 `skip`、不跨词合并，所以 `segs(a) ++ segs(b)` 与 `segs(a + ' ' + b)` 逐 token 相同。
- **成词不可交换**：`finishToks` 看的是**整表成分比例**，只能在拼好的整表上跑一次。第一版实现图省事，直接逐段 `tokenize` 再 concat，被新旧对拍当场抓出 **52 处不一致**（`avgdl 14.6 vs 14.5`，doc#6 `keywords,as,string` vs `keyword,string`）——标题单看是 mostly-Latin，停用词被砍、词尾被归一；拼上中文正文之后整表不再是 mostly-Latin，两个口径就分叉了。
- **首见等价**：`seen` 判的「第一次」与 `m.get(t) === void 0` 判的是同一件事，且 `df` / `postings` 只在首见写、`m` 只累加。

**读数**（同进程新旧交替 9 轮取中位，`node_modules\.tmp-diff\warmab22.mjs`）：冷建 **236.28 → 200.3ms（−15.2%）**、热查 **1.849 → 1.878ms**（噪声内，不退化）。官方表 `coldMs` **233.5 → 204–221ms**；`--cpu-prof`（`E:\Temp\cmp\prof22\CPU.20261124.111434.12552.0.001.cpuprofile`）总采样 **1,337.0 → 1,254.2ms（−6.2%）**，`buildSearchIndex` 138.3 → 135.2、`bumpIn` 65.8 → 64.0，切词那段搬成独立函数 `tokenizeSegs` 43.2ms。

**踩坑三条**：

- `kwFlatArr` 的判空不能写成 `kwSep || useField ? … : null`：`kwSeparate` 与 `fieldBoost` 双关时 `plainToks` 仍要用它，第一次跑就 `TypeError: Cannot read properties of null (reading '0')`。它有三个读者（`kwToks` / `plainToks` / `kwSets`），条件要覆盖三个。
- `tokenize` 的拆分让 `tools/probe-lex.mjs` 的 L0 取函数体失效（原来从 `function tokenize(text) {` 取，现在只剩一行包装）——改成从 `tokenizeSegs` 取循环体、另取 `wrapperBody` 断言包装仍是一行。
- 做新旧对拍的临时副本必须放 `node_modules\.tmp-diff\`：引擎有 33 条静态 `import`，只有这个位置的祖先链能找到 `@deepseek-ai/*`；`buildSearchIndex` 未导出，副本末尾补一句 `export { buildSearchIndex as __buildSearchIndexProbe };`。

## 218. 共现表与会话主题不再白跑一遍：词对记忆 + 词表只解一遍 + 内层提行（0.6.23）

**症状**（0.6.22 之后，冷建专项 `--cpu-prof`：10,000 条、三轮清缓存重建 + 一趟预热，总采样 **970.5ms**，约 4 次建索引；`E:\Temp\cmp\prof23cold\CPU.20261124.114408.2028.0.001.cpuprofile`）。上一版把切词那条链收干净之后，剩下的贵处全落在**共现自学习与会话主题**这两段：

| 位置 | 自证 | 每次建索引折算 | 干什么 |
| --- | --- | --- | --- |
| `vendor/meow-memory/lib/index.js:3257` | 81.1ms | 20.3ms | `cur.set(b, (cur.get(b) ?? 0) + w)` 共现权重累加 |
| `vendor/meow-memory/lib/index.js:3255` | 30.9ms | 7.7ms | `const cur = map.get(a)` 回表取行 |
| `vendor/meow-memory/lib/index.js:3244` | 39.2ms | 9.8ms | `for (const ch of a) if (b.includes(ch))` 共享汉字逐字比 |
| `vendor/meow-memory/lib/index.js:3243` | 37.1ms | 9.3ms | 两条 `/[\u4e00-\u9fff]/.test` 判中文 |
| `vendor/meow-memory/lib/index.js:1992` | 38.7ms | 9.7ms | 会话主题：为 `sessDf` 单独走一遍全部 token |
| `vendor/meow-memory/lib/index.js:2012` | 26.2ms | 6.6ms | 会话主题：`tf.set(t, (tf.get(t) ?? 0) + 1)` |
| `vendor/meow-memory/lib/index.js:2005` | 24.1ms | 6.0ms | 会话主题：`seen.add(t)` 每会话一个 Set |

函数级：`buildCoocSyn` **85.9ms / 8.9%**、`coocShareHan` **76.4ms / 7.9%**、`bumpIn` **114.2ms / 11.8%**、`sessionTopicTerms` **94.3ms / 9.7%**。三项加起来占冷建的四分之一还多。

**病根三条**：

1. **同一个词对被反复判「共享汉字」**。`coocShareHan(a, b)` 是纯函数、只看这两个词，但项目层里它被调用的次数是「每对（本条文, 项目并集里的别的词）」——真库一个项目几十条、每条十个关键词，同一对词要被重算几十次，每次两条正则加一趟逐字包含。
2. **每条的词表在同一趟里解了两遍**。同条层 `pairUp(coocWordsOf(d))` 一遍，项目层 `byProject` 又 `coocWordsOf(d)` 一遍；真库里 keywords 是逗号串或 JSON 串时，等于把同一份字符串解析两遍。
3. **会话主题把同一批 token 走了两趟**。第一趟只为算「这个词跨了几个会话」（`sessDf`，每会话先造一个 `Set` 再去重），第二趟才按会话累词频；两趟读的是同一个 `docToks[i]`。

**处方三条 + 一条**：

1. **共享汉字按词对记忆一次**。`buildCoocSyn` 里加一张两层账，对外的判据函数一个字不改：

```js
const hanMemo = new Map();
const shareHan = (a, b) => {
  let row = hanMemo.get(a);
  if (row === void 0) { row = new Map(); hanMemo.set(a, row); }
  let got = row.get(b);
  if (got === void 0) { got = coocShareHan(a, b); row.set(b, got); }
  return got;
};
```

表里只存**布尔**（是不是共享汉字），降权后的权重仍由调用点给基数——同条层 `Math.min(w, COOC_SHARE_HAN_W)`、项目层 `Math.min(COOC_W_PROJ, COOC_SHARE_HAN_W)`。这一条是刻意的：权重进了记忆表，两层就没法用各自的基数，同条 +2 / 项目 +1 的分级会一起消失。

2. **每条的词表只解一遍**。`const wordsArr = docs.map((d) => coocWordsOf(d));` 提到两个循环之前，同条层与项目层都改下标循环读 `wordsArr[i]`。

3. **项目层内层提行**。`a` 那一行在这一圈里要被写 `others.length` 次（真库几十次），回表取行只该取一次；对称那行（`b`）每次都不同，照旧 `bumpIn`。**建行的时机不变**——第一次真要写这一行时才建 —— 所以键的插入序与老写法逐位相同：

```js
let rowA = projPairs.get(a);
for (const b of others) {
  const ww = shareHan(a, b) ? Math.min(COOC_W_PROJ, COOC_SHARE_HAN_W) : COOC_W_PROJ;
  if (rowA === void 0) { rowA = new Map([[b, ww]]); projPairs.set(a, rowA); }
  else rowA.set(b, (rowA.get(b) ?? 0) + ww);
  bumpIn(projPairs, b, a, ww);
}
```

4. **会话主题一趟算完**。`sessDf` 与 `tf` 吃同一批 token，合成一趟；判重不再每会话造 `Set`，改成一张带会话序号的戳表——`stamp.get(t) !== ord` 就等于「这个词在这个会话里第一次见」：

```js
const stamp = new Map();
let ord = 0;
for (const [sess, idxs] of bySess) {
  ord++;
  const tf = idxs.length < SESS_TOPIC_MIN ? null : new Map();
  for (const i of idxs) {
    const toks = docToks[i];
    for (let k = 0; k < toks.length; k++) {
      const t = toks[k];
      if (tf !== null) tf.set(t, (tf.get(t) ?? 0) + 1);
      if (stamp.get(t) !== ord) { stamp.set(t, ord); sessDf.set(t, (sessDf.get(t) ?? 0) + 1); }
    }
  }
  if (tf !== null) tfBySess.set(sess, tf);
}
```

排名那一段一个字没动（`ranked` 表达式仍是 `f * Math.log(1 + total / (sessDf.get(t) ?? 1))`），只是 `tf` 改成从 `tfBySess.get(sess)` 取、取不到就 `continue`。一个 `Map` 顶掉 N 个 `Set`：`sessDf` 的键集合与每个词的会话数都不变。

**为什么逐位不变**（三条，缺一条就对不上）：

- **`coocShareHan` 是纯函数**：只看 `a`、`b` 两个字符串，与顺序、与调用次数都无关，记忆表只是把「同一个问题问第二遍」变成查表。
- **建行时机 = 键插入序**：`out` 的键序来自 `new Set([...pairs.keys(), ...projPairs.keys()])`，而 `projPairs` 的行内键序来自「第一次写入」，所以提行不能提前建行、也不能延后；`rowA` 在 `b` 循环外只取不清，正是为此。
- **跨会话判据是「会话数」不是「出现次数」**：`stamp` 用会话序号而不是布尔，一个词在同一个会话里出现 N 次只加 1；`tf` 与它互不干扰（`tf` 只在够 `SESS_TOPIC_MIN` 条的会话里建）。

**读数**：

- 同一份冷建量具（`node --cpu-prof`，三轮重建 + 一趟预热）总采样 **970.5 → 819.6ms（−15.5%）**；函数级 `bumpIn` 114.2 → 53.1、`coocShareHan` 76.4 → 判据搬进闭包后新帧 `shareHan` 26.7、`buildCoocSyn` 85.9 → 71.4、`sessionTopicTerms` 94.3 → 83.9、`buildSearchIndex` 251.5 → 240.6。
- 同进程新旧交替 7 轮取中位（`node_modules\.tmp-diff\warmab23.mjs`）：冷建 **201.06 → 177.21ms（−11.9%）**、热查 **1.813 → 1.864ms**（噪声内）。
- 官方表 `coldMs` **204–221ms → 168–175ms**（三次 `E:\Temp\cmp\prof012b.mjs`：175 / 170.35 / 168.05）；`perMs` 当日机器偏慢（2.41–2.66ms vs 上一版 2.00–2.04），热路代码没动，属噪声。
- 质量一张不差：`E:\Temp\cmp\ab22.mjs` **1,986 题 / 5,882 条 → mismatches 0**；`E:\Temp\cmp\final.mjs` 与 v0.5.0 基线逐行一致（0.921 / 0.417 / 0.500 三档不动）；新旧引擎全字段对拍 `node_modules\.tmp-diff\colddiff23.mjs` **462 项 0 不一致**（20 条合成 + 1,451 条 LoCoMo、11 组开关 + 直接对拍 `buildCoocSyn` 的 learn 开/关，比的是 `coocSyn` 的键序、`docToks`、`postings`、`tf`、`df`、`titleSets`、`kwSets`、`hayAt`）。

**探针**：`tools/probe-cooc.mjs` 加 K7 四档（`18 → 22` 条）——K7a 词表只解一遍（`keywords` 写成 getter 数次数，老写法 4 次、新写法 2 次，两条记忆）；K7b 共现表与一把「朴素尺子」逐键逐值逐序相同（尺子不记忆、不提行，四组夹具：共享汉字簇 / 多项目 + 单条项目 / 重复关键词 / 空 keywords 混排）；K7c 会话主题一趟算完后仍按「跨几个会话」走（够 3 条的会话每条追加同一串、不足 3 条一条都不追加，靠 `sessionTopic:false` 那一趟作差分）。

**不许省的三条**：

- **记忆表只存布尔**。存权重就丢了两层基数（同条 2 / 项目 1），K3 会红。
- **提行不许改建行时机**。`projPairs.set(a, rowA)` 必须发生在「真要写这一行」那一刻，否则 `out` 的键序变、`coocSyn` 的 JSON 序列化就不等了（`colddiff23` 比的就是这个序）。
- **会话主题的判据是会话数**。改成布尔 `Set` 或者按出现次数累加，`sessDf` 口径立刻变，主题词会往「同一段里反复出现的词」偏。

**踩坑两条**：

- **PowerShell 生成对拍脚本会把自己坑进去**。`-replace "eng0621.mjs","eng0622.mjs" -replace "eng0622.mjs","eng0623.mjs"` 是链式的——第二跳把刚换好的也换了，`OLD` 与 `NEW` 都指向新引擎，对拍「全绿」但毫无意义；顺手还把中文注释写成 mojibake。改文本一律 `write`/`edit`。
- **「少读一遍」用眼睛看不出来，得让代码自己报数**。K7a 把 `keywords` 写成 getter 才量到「老写法 4 次 / 新写法 2 次」；否则这条判据只能读源码形状，红不红全靠猜。

## 219. 建索引不再回头查第二次：倒排条目当场记住 + df 由长度摊出来 + 切词不再造字符数组（0.6.24）

**症状**（0.6.23 之后，冷建专项 `--cpu-prof`：10,000 条、三轮清缓存重建 + 一趟预热，总采样 **819.6ms**，约 4 次建索引；`E:\Temp\cmp\prof23cold\CPU.20261124.114729.4304.0.001.cpuprofile`）。共现那一层收干净之后，最贵的几行全落在**建倒排主循环**和**切词的第一行**上：

| 位置 | 自证 | 每次建索引折算 | 干什么 |
| --- | --- | --- | --- |
| `vendor/meow-memory/lib/index.js:3447` | 36.0ms | 9.0ms | `df.set(t, (df.get(t) ?? 0) + 1)` 首见时数「这个词出现在几条」 |
| `vendor/meow-memory/lib/index.js:3474` | 26.5ms | 6.6ms | `const p = postings.get(t)` 收尾那趟回头取倒排条目 |
| `vendor/meow-memory/lib/index.js:3476` | 22.3ms | 5.6ms | `p.t.push(...)` 逐词两趟 `Set.has` 判字段命中 |
| `vendor/meow-memory/lib/index.js:3446` | 21.2ms | 5.3ms | `m.set(t, 1)` 首见写下词频 |
| `vendor/meow-memory/lib/index.js:3448` | 15.9ms | 4.0ms | 首见分支里的 `postings.set(t, …)` |
| `vendor/meow-memory/lib/index.js:3444` | 14.8ms | 3.7ms | 主循环头 |
| `vendor/meow-memory/lib/index.js:2017` | 21.5ms | 5.4ms | 会话主题 `tf.set(t, (tf.get(t) ?? 0) + 1)` |
| `vendor/meow-memory/lib/index.js:2018` | 16.1ms | 4.0ms | 会话主题 `if (stamp.get(t) !== ord)` 判重 |
| `vendor/meow-memory/lib/index.js:1681` | 38.5ms | 9.6ms | 切词 `Array.from(text.normalize("NFKC"))` |

函数级：`buildSearchIndex` **240.6ms / 29.4%**、`sessionTopicTerms` **83.9ms**、`tokenizeSegs` **76.9ms**、GC **73.3ms**。

**病根三条**：

1. **同一个「第一次见」被记了三遍**。一个（条, 词）对首见时要付 `m.get` 判首见、`df.get` + `df.set` 数条数、`postings.get` 取条目——四笔哈希。可 `df[t]` 与 `postings[t].d.length` 恒等：两边都只在「这条第一次见」时各 +1。df 是白记一遍，而且记的是同一个数。
2. **收尾那趟又回头看第二次**。落 `p.f`（词频）与 `p.t`（字段命中位）时按词再 `postings.get(t)` 一次，只为拿到首见那一瞬间手里就已经有的指针。
3. **切词把整串拆成一堆单字符**。`Array.from` 只为了按下标判类；一万条 × 三个字段 × 每字段三十字上下，单字符字符串对象、随后的 `slice(i, j)` 与 `join("")` 全是白造，还各自变成 GC 的账。

**处方三条**：

- **倒排条目当场记住**：加一只复用的 `refs` 数组，首见时把 `p` 记进去，下标正好等于 `m` 的插入序；收尾那趟按下标直接取，不回查。

```js
  const refs = postings === null ? null : [];
  for (let di = 0; di < docToks.length; di++) {
    const m = new Map();
    let refN = 0;
    …
        m.set(t, 1);
        if (refs === null) df.set(t, (df.get(t) ?? 0) + 1);
        else {
          let p = postings.get(t);
          if (p === void 0) { p = { d: [di], f: [], t: [] }; postings.set(t, p); }
          else p.d.push(di);
          refs[refN++] = p;          // 首见那一刻就把指针收好
        }
    …
    if (postings !== null) {
      let k = 0;
      for (const [t, v] of m) { const p = refs[k++]; p.f.push(v); p.t.push(…); }
      refs.length = 0;               // 同一只数组，每换一条只把长度归零
    }
```

- **df 由倒排长度摊出来**：有倒排时不再逐词 `df.get` + `df.set`，循环结束后一次摊平；关掉倒排（`opts.inverted === false`）那条支路保留内联计数。

```js
  if (postings !== null) for (const [t, p] of postings) df.set(t, p.d.length);
```

- **切词改成按下标走**：`codePointAt` 判码点宽度（> 0xFFFF 的星外字符占两位），段边界按「连续同类码点」推进，`s.slice(i, j)` 直接切出来；汉字段仍在段内按码点两两成词。

```js
function tokenizeSegs(text) {
  const s = text.normalize("NFKC");
  const out = [];
  const nS = s.length;
  let i = 0;
  while (i < nS) {
    const w0 = s.codePointAt(i) > 65535 ? 2 : 1;
    const cls = clsCode(w0 === 1 ? s[i] : s.slice(i, i + 2));
    if (cls === CLS_SKIP) { i += w0; continue; }
    let j = i + w0;
    while (j < nS && clsCode(s.codePointAt(j) > 65535 ? s.slice(j, j + 2) : s[j]) === cls) {
      j += s.codePointAt(j) > 65535 ? 2 : 1;
    }
    if (cls === CLS_CJK) { /* 段内按码点两两成词 */ } else out.push(s.slice(i, j).toLowerCase());
    i = j;
  }
  return out;
}
```

顺带把会话主题那张戳表也收了：`tf` 每跨一个会话就是新的，`tf.get(t) === void 0` 本身就等于「这个词在这个会话第一次见」，一次查找兼两用，`stamp` 与 `ord` 两个变量一起消失（不足门槛的会话照样只借 tf 当判重账、不登记进 `tfBySess`）。

**为什么逐位不变**：

- **`refs` 的下标就是 `m` 的插入序**。`m` 的每一个键都对应一次首见，而首见必然 `refN` +1；正文支路与关键词支路共用同一只 `refN`，所以 `for (const [t, v] of m)` 走到的第 k 个键，正好是 `refs[k]`。`p.f` / `p.t` 的落盘顺序与老写法按词回查的顺序完全一致。
- **`df[t] === postings[t].d.length` 是恒等式**。`d` 只在首见 push 一次（新条目 `d: [di]` 也算一次），df 也只在首见 +1；键序两边都是首次出现顺序，所以摊出来的 Map 逐键逐值逐序相同。
- **切词的语义由分类函数定义，不由遍历方式定义**。`Array.from` 的每个元素是「一个码点」，下标版用 `codePointAt` 判宽 + `slice` 取同样的一段；孤立代理项在两边都是「宽度 1 的一个元素」，`> 65535` 的判断不会把它误当成两宽（0xD800–0xDFFF 的码点值是它自己，不是组合后的星外码点）。

**读数**（同一台机器、同一天，先跑对拍再跑量具）：

| 量具 | 0.6.23 | 0.6.24 | 变化 |
| --- | --- | --- | --- |
| `warmab24.mjs` 冷建中位（同进程交替 7 轮，N=10,000） | 174.46ms | **149.27ms** | **−14.4%** |
| 热查中位（Q=300，每问） | 1.892ms | 1.916ms | 噪声内（索引内容逐位相同，工总量不变） |
| `prof012b.mjs` `coldMs` 三趟 | 168.05 / 170.35 / 175.00 | **147.51 / 146.68 / 157.09** | −12% 上下 |
| `prof012b.mjs` `totalMs` 三趟 | 724.2 / 785.9 / 726.5 | **637.1 / 617.1 / 622.7** | −13% 上下 |
| `prof012b.mjs` `perMs` 三趟 | 2.414 / 2.620 / 2.422 | **2.124 / 2.057 / 2.076** | 随冷建与机器状态同步 |
| 冷建专项总采样 | 819.6ms | **741.7ms** | −9.5% |

函数级变化：`tokenizeSegs` 87.1 → **61.7ms**、`sessionTopicTerms` 83.9 → **54.7ms**、`buildSearchIndex` 240.6 → **195.8ms**；`df.set(t, p.d.length)` 那一行（`:3519`）连行视图前 34 都进不去（< 4.4ms），`postings.get` 只剩首见那一段的 25.3ms（`:3471`），收尾那趟的 26.5ms 彻底消失。

**质量**：`E:\Temp\cmp\final.mjs` 与 v0.5.0 逐行一致（照抄 0.921 / 换说法 0.417 / 时间锚 0.500，两条 `#2 → #1` 不变，「0.6.0 关 与 v0.5.0 逐位相同？ true」）；`E:\Temp\cmp\ab22.mjs` 1,986 题 × 5,882 条 **0 mismatch**；`colddiff24.mjs`（0.6.23 引擎 vs 0.6.24 引擎，20 条合成 + 1,451 条 LoCoMo，11 组开关）**462 项 0 mismatch**；`tokdiff24.mjs`（切词逐位：0.6.23 的 Array.from 版当尺子）**15,810 项 0 mismatch**。

**判据**：

- `tools/probe-cold.mjs` 加 **C6 / C7** 两档（6 → 8 条，`8/8`）：C6 切词逐位（52 例 · 440 token，含星外字、emoji、孤立代理项、NFKC 全角合字、超长串）+ 「不再造字符数组」的形状；C7 df 摊出来（df 恒等于倒排长度、与关掉倒排那条支路逐位相同、`f`/`t` 与 `d` 同下标、每条只回查一次倒排的形状）。
- `verify.mjs` 加 **OR084 六条**：C6/C7 在位与挂线 / 引擎五件（倒排条目只查一次、收尾按下标回填、df 由倒排长度摊出来、切词不再造字符数组、会话主题借 tf 判重）/ 进程内切词逐位（用引擎自己的 `classify` 配一份 `Array.from` 老实现当尺子，另单钉「星外二元组按码点拼」）/ 进程内 df 恒等与开合支路一致 / 文档在位 / 版本号不低于 0.6.24。
- 顺带把 0.6.23 那条判据里跟着源码走的一处改到新形状：`会话主题一趟算完` 原来断言 `stamp.get(t) !== ord`，0.6.24 把 `stamp` 收掉了，断言改成 `const c = tf.get(t);` + `} else tf.set(t, c + 1);`——**语义（tf 与跨会话数一趟算完）没动，改的是源码形状**。

**不许省的三条**：

- **`refs` 必须是同一只数组、每换一条只归零**。给每条配一只小数组的话，一万次分配会把首见路径省下的查找钱吃掉一大半（省的是哈希，不是分配）。
- **df 只能有一个来源**。开着倒排时若还在首见段里写 df，`df[t]` 与 `postings[t].d.length` 就有两个写者，关倒排与开倒排两条支路的 df 会分叉，C7 立刻红。
- **星外字必须按码点宽走**。按 UTF-16 单元切片会把 `𠀀` 拼成半个代理项，二元组全变；`> 65535 ? 2 : 1` 这一判不能省。

**踩坑两条**：

- **形状判据得先剥注释**。注释里明写着「不再 `Array.from(...)`」，`includes('Array.from(')` 直接红；C6/C7 都先滤掉 `//` 开头的行再看代码。同理 `postings.get(t)` 的计数也被注释里的提及污染过。
- **孤立代理项不能当两宽**。`'\ud800'.codePointAt(0)` 返回 `0xD800`（不是组合码点），宽度必须按 `> 65535` 判、不能按 `>= 0xD800` 判；这一条被 `tokdiff24` 的 `'\uD800\uDFFF\uD800a'` 用例钉住。

## 220. 共现内层不再回表、成词不再拼临时串也不再付正则（0.6.25）

**症状**（0.6.24 之后，冷建专项 `--cpu-prof`：10,000 条、三轮清缓存重建 + 一趟预热，总采样 741.7ms）。建索引主循环那一刀（0.6.24）落完之后，账面上还剩三块「同一件事付两次钱」：

| 位置 | 自证 | 每次建索引折算 | 干什么 |
| --- | --- | --- | --- |
| `vendor/meow-memory/lib/index.js:3307` | 43.5ms | 10.9ms | `bumpIn` 内层 `cur.set(b, (cur.get(b) ?? 0) + w)` 累加共现权重 |
| `vendor/meow-memory/lib/index.js:3309` | — | — | `pairUp` 每写一个 (a,b) 都先 `pairs.get(a)` 回表一次 |
| `vendor/meow-memory/lib/index.js:1686` | 30.5ms | 7.6ms | 切词 `text.normalize("NFKC")`（这一行留着，见下） |
| `RegExp: ^[a-z]+$` | 8.8ms | 2.2ms | 每个词判一次「纯小写拉丁」 |
| `isMostlyLatin` | 8.3ms | 2.1ms | 每条把词表数完一遍才判 |

**病根三条**：

1. **同一行被回表两次**。`pairUp` 内层对每个 (a,b) 都 `bumpIn(pairs, a, b, ww)`——而 `bumpIn` 第一句就是 `pairs.get(a)`。一个 a 有 k 个邻居，这一行就被取 k 次。项目层（0.6.23）早把「a 那一行」提到 b 循环外了，这一层当时漏了；更里一层 `cur.get(b)` 才是真正的钱，但那是「一次写入一次哈希」，省不掉。
2. **二元组是拼出来的**。汉字段的二元组写法是「上一段 + 这一段」：每个二元组造三只短字符串（`prev`、`cur`、拼接结果），而它其实就是**连续切片的相邻两码点那一段**——`s.slice(ps, k + w)`。一万条正文 × 三十字上下，白造两万只字符串，全变 GC 账。
3. **成词那一趟在跑正则**。`/^[a-z]+$/` 对每个词建一只 RegExp 匹配上下文；`isMostlyLatin` 还把词表整个数完才判，其实过半就够了。

**处方四条**：

- **共现内层提行**：一个 a 只取一次行，行在「第一次真要写」时才建（键插入序与老写法逐位相同）。

```js
  const a = list[i];
  let rowA = pairs.get(a);
  for (let j = i + 1; j < ln; j++) {
    const b = list[j];
    if (a === b) continue;
    const ww = shareHan(a, b) ? Math.min(COOC_W_SAME, COOC_SHARE_HAN_W) : COOC_W_SAME;
    if (rowA === void 0) { rowA = /* @__PURE__ */ new Map([[b, ww]]); pairs.set(a, rowA); }
    else rowA.set(b, (rowA.get(b) ?? 0) + ww);
    bumpIn(pairs, b, a, ww);
  }
```

- **二元组按连续切片**：`let ps = i; let k = i + w0; while (k < j) { const w = s.codePointAt(k) > 65535 ? 2 : 1; out.push(s.slice(ps, k + w)); ps = k; k += w; }`——相邻子串拼接恒等于连续切片，逐位同串，省掉 `prev` / `cur` 与拼接。
- **拉丁判据走码点**：`function isLatinToken(t)` 一个 `charCodeAt` 区间判（97–122），替掉 `/^[a-z]+$/`；`isMostlyLatin` 过半即 `return true`（并列过半算拉丁，见下表）。
- **标题集合先取、词表就地接上正文**：`titleSets[i] = new Set(finishToks(ts))` 提到拼接之前（取的是「还没接正文」的那份），`ts.push(cs[k])` 就地接，不再 `finishToks(ts.concat(cs))` 每条造一只新数组。

**读数（本机同一脚本，15 轮交替，10,000 条 / 300 问）**：

| 量 | 0.6.24 | 0.6.25 | 变化 |
| --- | --- | --- | --- |
| 冷建中位 | 154.38ms | **139.32ms** | −9.8% |
| 冷建三趟采样（专项脚本） | 149.4 / 145.9 / 142.4 | 151.0 / 145.9 / 142.4 | 噪声内 |
| 冷建 `--cpu-prof` 总采样 | 741.7ms | **726.6ms** | −2.0% |
| `bumpIn` 函数自证 | 58.1ms | 43.8ms | −14.3ms |
| `RegExp ^[a-z]+$` | 8.8ms | 0（不见了） | −8.8ms |
| 热查（单问） | 2.122ms | 1.894ms | 噪声内（改的不是热路） |

`--cpu-prof` 还剩的贵处（下一版候选）：`buildSearchIndex` 177.1ms、`buildCoocSyn` 87.9ms、GC 78.6ms、`tokenizeSegs` 73.5ms、`sessionTopicTerms` 63.2ms、`shareHan` 31.6ms、`sigDocHash` 19.0ms；行级 `bumpIn:3324` 35.7ms、`buildCoocSyn:3384` 31.9ms、`buildSearchIndex:3542` 20.5ms（字段命中位两趟 `Set.has`）、`tokenizeSegs:1703` 24.5ms（`normalize("NFKC")`）。

**等价性怎么证**：

- `colddiff25`：同一批 10,000 条 + 12 组构造夹具，0.6.24 与 0.6.25 两份引擎的 `docToks` / `df` / `tf` / `postings` / `titleSets` / `kwSets` / `coocSyn` 逐位对比，**462 项 0 不一致**。
- `tokdiff25`：15,810 条构造文本逐 token 对比切词结果（含星外字、孤立代理项、全角合字、`kwSeparate` 两路），**0 不一致**。
- `probe-cooc` K8a/K8b：形状六件 + 40 组随机夹具（长表 / 共享汉字 / 多项目 / 去重后关键词）跟朴素尺子逐键逐值逐序相同。
- `probe-cold` C8：`isLatinToken` 与 `/^[a-z]+$/` 逐例对拍 261 例，`isMostlyLatin` 早退与「数完再比」逐例同值。

**不许省的三条**：

- **建行时机不许动**。`rowA` 只能在「第一次真要写这一行」时建：提前 `pairs.set(a, new Map())` 会让空行也进键序，`coocSyn` 的键序与并列先后会变（K8b 就是钉这个）。
- **对称侧照旧回表**。`bumpIn(pairs, b, a, ww)` 不能跟着提行——b 那一行每轮都不一样，提出来等于错位写入。
- **`$` 是严格串尾**。JS 的 `/^[a-z]+$/` 不比 Python 松：`"ab\n"` 判 false。给 `isLatinToken` 加「末尾换行折掉」的兼容会让 C8 立刻红（`["a","ab\n","ab\n"] want false got true`）——兼容是错的，删除。

**踩坑两条**：

- **形状判据得先剥注释**。0.6.25 的注释里正写着「老写法 `ts.concat(cs)`」「`pairs.get(a)` 每个词对回表一次」「不再逐词跑 `/^[a-z]+$`」，`includes` 直接撞上；C0/C6/C8、OR085 都先滤 `//` 行再看代码，`^[a-z]+$` 的计数也只数代码行。
- **朴素尺子要跟引擎同口径**。K8b 的随机夹具一开始每条关键词带重复（如 `重复重复` 出现两次），尺子按「按位置写两遍」算、引擎按「同一条去重后写一遍」算，40 组里 39 组只差同分并列的先后——看着像提行改坏了，其实尺子口径没对齐。夹具去重后 40 组全同。
## 221. 共现层内部只认整数词号（0.6.26）

### 221.1 症状：三层表都拿词本身当键

0.6.25 的冷建剖面（`--cpu-prof`，一万条记忆，总采样 726.6ms）里，共现这一层还占着：

| 位置 | 采样 | 在干什么 |
| --- | --- | --- |
| `buildCoocSyn` | 87.9ms | 整层建表 |
| `bumpIn`（`:3324`） | 43.8ms | 内层 `cur.set(b, (cur.get(b) ?? 0) + w)` |
| `shareHan`（`:3314`） | 21.4ms | 「这两个词共享汉字吗」 |
| `buildCoocSyn`（`:3298`） | 19.8ms | `pairs.get(a)` 回表 |

`bumpIn` 的 43.8ms 里几乎全部来自共现内层——项目层那一段当时已经提过行，剩下的钱全在这一层。

### 221.2 病根：每写一对都在算串哈希

1. **键是词本身**：`pairs`、`projPairs`、`kwDf` 三层都是 `Map<string, …>`，每写一对 (a,b) 要算两次字符串哈希，读一次再算一次。而这一层的键域其实很小——一万条记忆的词表也就几百个词，翻来覆去都是同一批串。
2. **`hanMemo` 是两级表**：`Map<string, Map<string, bool>>`，「a 这一行」要先按串找一次行，再按串找一次列。行的身份明明是「第几个词」，却用串来表达。
3. **内层热循环每个词对都回表两次**：`pairs.get(a)` 与 `hanMemo.get(a)`（0.6.25 已经把前者提出去了，后者还在里面）。

### 221.3 处方：发词号，层内只认整数

进这一层先发号，按第一次出现的顺序：

```js
const wid = new Map();
const wById = [];
const idOf = (w) => {
  let id = wid.get(w);
  if (id === void 0) {
    id = wById.length;
    wid.set(w, id);
    wById.push(w);
  }
  return id;
};
```

- 共享汉字记忆表从「串→行」的两级 Map 改成**下标数组**：`const hanMemo = [];` + `hanRow(a)` 建行、`hanHas(row, a, b)` 查列（真算的时候才把词号换回词去调 `coocShareHan`）。
- `pairUp` 内层进 b 循环前先 `const rowH = hanRow(a);`，内层判据变成 `hanHas(rowH, a, b) ? Math.min(w, COOC_SHARE_HAN_W) : w`——一个 a 只找一次行。
- `wordsArr` 改成 `docs.map((d) => coocWordsOf(d).map(idOf))`，`kwDf` 按词号累加。
- **出门那一刻换回原词**：

```js
const words = list.slice(0, COOC_TOP_PER_TERM).map((id) => wById[id]);
out.set(wById[a], words);
```

这里必须用 `.map`，不许写 `const arr = new Array(k)` 再逐位赋值——后者造出来的是 holey 数组，热路读它要多做洞检查，省下的哈希钱会从这里漏回去。

### 221.4 读数

| 量的是什么 | 0.6.25 | 0.6.26 | 变化 |
| --- | --- | --- | --- |
| 共现层单独建表（隔离 A/B，15 轮交替） | 40.09ms | **29.90ms** | −25.4% |
| 冷建全量（21 轮交替中位） | 135.67ms | **122.81ms** | −9.5% |
| 剖面总采样 | 726.6ms | **679.1ms** | −6.5% |
| `bumpIn` | 43.8ms | **8.3ms** | −81% |
| `buildCoocSyn` | 87.9ms | 72.3ms | −18% |
| 热查（单引擎分进程） | 1.851 / 1.847ms | 1.865 / 1.827ms | 噪声内，没动 |

热查这条读数有个坑：两个引擎的索引同时活着交替测，会互相污染（GC / 堆），读出来是 +11~19% 的假退化；建造顺序对调也一样。只有「单引擎、各自一个进程」的能量出真值——那时两边同量级。

### 221.5 等价性

- `colddiff26`：462 项对拍（0.6.25 引擎 vs 0.6.26 引擎，同一批夹具）**0 不一致**。
- `tokdiff26`：15,810 项切词对拍 **0 不一致**。
- `probe-cooc` K9a/K9b：层内只认词号、出门换回原词；表的键与值的每个元素都还是词本身，键集合与朴素尺子相同。
- `probe-cooc` K8b / K7b：共现表与朴素尺子逐键逐值逐序相同（K8b 40 组随机夹具）。
- `probe-cold` 9/9、`probe-lex` 6/6 全绿（本版没碰切词与索引填表）。

### 221.6 不许省的三件事

1. **不许省 `.map`**：换回原词那一步用 `new Array` + 逐位赋值会造 holey 数组，见 221.3。
2. **不许把词号漏出去**：`out` 的键、值数组里的每个元素都必须是词本身；词号只活在这一层的函数体里。
3. **不许把 `hanMemo` 改回 Map**：行的身份是词号，做成「词号→行」的 Map 等于把下标数组换回一次哈希查找。

### 221.7 复盘

这一刀和 0.6.23 的项目层提行、0.6.25 的共现内层提行是同一笔钱的三截：先把「回表」提出循环（0.6.25），再把「表的键」从串换成整数（0.6.26），剩下的才是 `coocShareHan` 本身。三层表一起换，`bumpIn` 从 43.8ms 掉到 8.3ms——**热循环里最贵的从来不是算术，是键**。

## 222. 建索引的三笔固定开销：给一个码点分类、签名每条现造闭包、会话主题每个 token 查两次表（0.6.27）

### 222.1 症状：冷建的钱全在「为一个小动作付对象」

0.6.26 的冷建剖面（`--cpu-prof`，一万条记忆、300 问，总采样 679.1ms）还排着这样一张表：

| 位置 | 采样 | 在干什么 |
| --- | --- | --- |
| `buildSearchIndex` | 206.4ms · 29.4% | 整趟填表 |
| `buildCoocSyn` | 98.0ms | 共现层 |
| GC | 70.1ms | 收临时对象 |
| `tokenizeSegs` | 69.7ms | 切词（`:1703` 的 `normalize` 22.6ms 占大头） |
| `sessionTopicTerms` | 60.1ms | 会话主题（`:2050` 20.5ms / `:2054` 10.3ms 都是串键 Map） |
| `sigDocHash` | 24.0ms | 条级签名 |
| `bumpIn` | 19.7ms | 共现内层 |

行视图里最贵的几条，除了 `buildSearchIndex:3581`（36.9ms）这种「整趟」开销，几乎全是**为一个小动作造一只对象**：

- `tokenizeSegs` 内层每次判断一个字属于哪类，`clsCode(w0 === 1 ? s[i] : s.slice(i, i + 2))`——`s[i]` 造单字符字符串，星外字还要 `s.slice`；同一个下标在「起头」和「往后走」两处各判一次，一个字至少造一只。
- `sigDocHash` 每条现造两只闭包（`put` / `sep`），content 的首 40 与尾 40 各 `slice` 出一只临时串。
- `sessionTopicTerms` 每个 token 付 `tf.get` + `tf.set` 两次字符串键哈希（真库几千个词、十万级 token）。
- 项目层每条造一只 `self = new Set(ws)` 与一只 `others = unionArr.filter(...)`（一万条 = 两万只临时对象，filter 每条还要把整个项目并集扫一遍）。

### 222.2 病根：分类、混算、计数都用了「比它本身更贵」的表达

1. **「这个字是哪一类」被写成了「造一个字符串再分类」**。分类表的键是码点数值（`Uint8Array[65536]`），本来就只要一个 `charCodeAt`；却先造一只单字符字符串、再 `charCodeAt(0)` 查表，绕了一圈还落一只对象在堆上。
2. **「按字段顺序混算」被写成了「每条现造两只闭包」**。`h` 是滚动值，闭包只是为了少传一个参数；一万条就是两万只闭包，全进 GC。
3. **「这个词这个会话出现几次」被写成了两次串哈希**。词域只有几千个，键却还是串；而且第一版把打分与计数放在同一圈里，`sdf` 还没累完全部会话就打分——切词结果直接错（`colddiff27` 35 处不一致）。
4. **「跳掉自己那几个词」被写成了「造一份别人」**。并集顺序才是键序，`filter` 出来的数组既没用到顺序、又造了一只新数组。

### 222.3 处方：把「造对象」换成「按下标取」

**一、按下标分类**（`lib/index.js:1657` `clsAt`）：

```js
function clsAt(s, i) {
  var c = s.charCodeAt(i);
  if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
    var d = s.charCodeAt(i + 1);
    if (d >= 0xdc00 && d <= 0xdfff) return clsCode(s.slice(i, i + 2));
  }
  var t = clsBmp === null ? (clsBmp = buildClsBmp()) : clsBmp;
  return t[c];
}
```

只有「高位代理 + 紧跟低位代理」这一种情况才走原来的码点路径，BMP 一律 `charCodeAt` 直接查表。`tokenizeSegs` 内层两处（起头、往后走）都换成 `clsAt(s, i)` / `clsAt(s, j) === cls`。

**二、签名混算提成模块级纯函数、首尾按区间混**（`:3103`–`:3120`）：

```js
function sigMixStr(h, s) { for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } return h; }
function sigMixRange(h, s, from, to) { for (let i = from; i < to; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } return h; }
function sigSep(h) { h ^= 0x7c; return Math.imul(h, 16777619) >>> 0; }
```

`sigDocHash` 里 `h = sigSep(sigMixRange(h, content, 0, min(40, len)))`、`h = sigSep(sigMixRange(h, max(0, len - 40), len))`——不再 `slice`，不再造闭包。算术一位没动（同乘同异或），所以签名逐位相同。

**三、会话主题换整数词号 + 两轮**（`:2041` `sessionTopicTerms`）：`tid`（词→词号）+ `tById` + `cnt` + `sdf` 四个下标结构；每个 token 只 `tid.get(t)` 一次；`if (cnt[id] === 0) { sdf[id] += 1; touched.push(id); } cnt[id] += 1;`；会话切换只复位 `touched` 里的词号；够门槛（≥3 条）的会话把 `touched.slice()` 与计数快照留着；**第二轮**再按最终 `sdf` 定分 `cs[k] * Math.log(1 + total / sdf[ids[k]])`。

**四、项目层去 self Set**（`:3456`）：先判 `onlySelf`（自己的词是否覆盖整个并集，等价于老写法的 `others.length === 0 → continue`），再按并集顺序走、`if (ws.indexOf(b) >= 0) continue;` 跳掉自己那几个词。

### 222.4 读数

| 量的是什么 | 0.6.26 | 0.6.27 | 变化 |
| --- | --- | --- | --- |
| 整趟冷建（21 轮交替中位） | 119.18ms | **114.39ms** | −4.0% |
| 剖面总采样（三次取中位） | 679.1ms | **669.5ms** | −1.4% |
| `sigDocHash`（层内隔离 A/B，9 轮交替） | 18.49ms | **3.59ms** | −80.6% |
| `sessionTopicTerms`（同上） | 11.36ms | **8.61ms** | −24.2% |
| `buildCoocSyn`（同上） | 31.7ms | **30.01ms** | −5.3% |
| 切词 30,000 串（同上） | 17.38ms | **14.25ms** | −18.0% |
| 热查（单引擎分进程） | 1.817ms | 1.851ms | +1.9%，见 222.6 |

### 222.5 等价性

- `colddiff27`：462 项对拍（0.6.26 引擎 vs 0.6.27 引擎）**0 不一致**；`tokdiff27`：15,810 项切词对拍 **0 不一致**。
- `layers27`（层内隔离）：`sessionTopicTerms` 输出相同、`buildCoocSyn` 相同、`sigDocHash` 10,000/10,000 相同、`tokenize` 30,000/30,000 相同。
- `probe-cold` **10/10**：新增 C9——`clsAt` 与「按码点跑 Unicode 正则」的尺子逐下标同值（15 串 · 245 下标 · 13 码点对拍）。
- `probe-cooc` **28/28**：新增 K10a/K10b——项目层不再造 `self`/`others`，五组夹具（覆盖全集 / 子集 / 同词表 / 重复词 / 空表混排）与朴素尺子逐键逐值逐序相同。
- `verify.mjs` OR087 七条：探针在位 / 按下标分类 / 签名混算三件 / 会话主题词号两轮 / 项目层 onlySelf / 进程内签名口径没动 / 进程内会话主题与朴素两趟尺子逐会话逐词逐序相同。

### 222.6 热查那 2% 怎么判

单引擎分进程读：0.6.26 **1.827 / 1.803 / 1.809 / 1.828**（25 轮 ×4），0.6.27 **1.852 / 1.859 / 1.849 / 1.844**，稳定差 +1.9%；换顺序也一样。于是做了两件事：

1. 把 `tokenizeSegs` 换回 0.6.26 的写法（其余不动）→ 1.879 / 1.906，与本版 1.899 / 1.907 相同：**不是切词那一刀**。
2. 热查剖面 4 秒定点：0.6.26 总采样 5,040.5ms、0.6.27 **4,994.1ms**（本版还低 0.9%），各函数之间是此消彼长（`scoreCandSet` 811.7 → 735.8）。

结论：这一版**没打算动热查**，读到的 +1.9% 落在「同一台机器、不同进程、毫秒级中位」的噪声带里（同一份代码连跑四趟，自身波动就有 ±1%）。如实记在这里，不写成「热查变快」，也不据此回头改。

顺带量出一件下一版该干的事：热查里 `indexSignature` 占 **19~20%**（961.9 / 5,040.5）——每次 search 都要把一万条的字段值重新比一遍，WeakMap 只省了哈希、没省遍历与字符串比较。

### 222.7 不许省的三件事

1. **不许把 `clsAt` 的内联分支拆回字符串**：`s[i]` 与 `s.slice(j, j + 2)` 就是这笔钱本身。
2. **不许把签名混算搬回闭包**：闭包是为了少传一个 `h`，而这个 `h` 本来就在局部变量里。
3. **不许把会话主题的打分与计数并回一圈**：`sdf` 是「跨几个会话」，必须等全部会话数完才定；并回去就是 35 处不一致。

### 222.8 复盘

这一刀的共同点：**每次省下的都不是算法，而是一只对象**。分类不要字符串、混算不要闭包、计数不要串键、跳自己不要副本——四处加起来冷建 −4.0%，其中 `sigDocHash` 一项就 −80.6%，因为它原来每条要造四只对象、只算八十个字符。

下一版的靶子已经量出来了：热查的 `indexSignature`（19~20%），以及 `tokenizeSegs` 里那句 `normalize("NFKC")`（`:1717` 24.6ms）——注意 Fast-Path 已经试过并否掉了（先扫一遍再决定归一，收益≈0，中文正文带全角标点时必须归一）。
