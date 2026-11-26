# PLAN-UNIVERSAL：把宏记忆做成「任何 agent 都能用」的本地记忆层

> 写于 2026-11-26 22:1x（Asia/Shanghai）。性质：**方案稿，代码一个字未改**。
> 当前版本 0.7.1（门面版），仓库 `D:\dsh-home\vendor\dsh-macro-memory`，远端 main `5620c8a`，npm `latest = 0.7.1`。
> 本文件回答一个问题：把现在「DSH 插件」的形态，扩成「DSH 是其中一个宿主」的形态，需要做哪些、按什么顺序、怎么验收、怎么回滚。

---

## 0. 一句话

把「记忆引擎」从「DSH 插件外壳」里剥出来，做成零宿主依赖的内核（core），再用三条通用腿接到所有宿主：**MCP 给工具、文件围栏给注入、CLI/UI 给运维**。DSH 从「唯一宿主」降级为「适配器之一」，行为与现有读数不变。

成功的唯一判据：**干净机器、不装 DSH、不编译原生模块，`npx -y macro-memory mcp` 接上 Codex，说一句「记住 X」，关掉重开还答得出，另一台宿主查得到且标着 `agent:codex`。**

---

## 1. 现状盘点：哪些已有、哪些缺

### 1.1 已有的（不用重做）

| 能力 | 现状 | 位置 |
| --- | --- | --- |
| 七层存储 | soul / user / project / fact / lesson / topic / rules，单库 `.dsh-meow/memory.db` | `vendor/meow-memory` |
| 8 个统一工具 | remember / update / search / read / project / link / dream / admin | `lib/macro/defs/*.js` |
| 常驻注入 | L0 ≤1,300 字符，0.7.x 实测 1,266 字符 | `lib/macro/bridge.js` |
| 检索 | 本地 / 星图 / 补邻居 / 相似四路，预算可砍，p50 ≈ 2.9 ms | `lib/macro/defs/search.js` |
| 星图 | 可全量重建的派生索引 | `vendor/nebula` |
| 面板 | 记忆列表 / 星图 / 体检（iframe，190 KB 级） | `lib/client.js` |
| 平台层 | `platform.js` 收口路径与环境变量（0.7.0 起） | `lib/macro/platform.js` |
| 自检 | check-all 68 支 / 4,639 条（以当轮输出为准） | `tools/` |
| 市场 | 两份索引 + 详情页按 commit 读 README | `plugin-market/` |

### 1.2 缺的（本计划要补）

- core 与宿主耦合：`bridge.js` 直接拦 `ctx.tools` / `ctx.systemPrompt`，`platform.js` 仍读 `DSH_HOME`。
- 工具定义直接是 cordis 形态，没有中立声明，别的宿主拿不到。
- 没有 MCP 入口、没有 CLI、没有独立 UI。
- 库是单进程假设：没有写队列、没有 `owner` / `scope`、没有 `schema_version`。
- 没有「多 agent 看到彼此」这件事的任何字段与语义。
- 注入只有 DSH 一处；文件注入（`AGENTS.md`）与围栏规约不存在。
- 发行面只有 npm 单包（`dsh-macro-memory`），且包名带宿主前缀。
- mac 侧只做到路径层，二进制签名公证、launchd 策略、NFD 归一都没做。

---

## 2. 非目标（明确不做，写死在这里避免范围膨胀）

1. **不做云同步**。数据目录放 OneDrive / iCloud / 坚果云 / NAS 会坏库；跨机只给 `export` + 私有 git 配方。
2. **不做自动更新**。`update` 只检查、只提示；DSH 侧更新归插件市场。
3. **不做默认常驻**。`watch` 默认关；mac 上默认不写 LaunchAgent；Windows 上不装服务。
4. **不做每宿主一套原生界面**。只有一份本地 web UI，宿主内嵌即 iframe。
5. **不做自动 LLM 裁决/合并**。冲突显式留着，不花钱猜。
6. **不改 DSH 包名与市场条目 `name`**（已装用户的身份）。仓库与主页去 dsh 化，包名双轨。
7. **不为了「支持 N 个宿主」写 N 份存储或检索**。一份 core，适配器只做接线。

---

## 3. 架构：四层，依赖单向

```
packaging   npm 双包 / brew / 单文件二进制 / Docker
   │
surfaces    dsh（cordis 插件）· mcp（stdio server）· cli · ui（web）· sdk
   │
adapters    宿主能力探测 · 注入策略选择 · 工具注册 · 事件接线
   │
core        引擎（七层 + 星图 + 检索 + 注入计划 + dream + 快照）
```

硬规矩：

- **core 里不许出现** `ctx.`、`cordis`、`DSH_HOME`、`/dream`、`iframe` 这些词；判据是一条静态扫描（`probe-core-purity`），扫到即红。
- **依赖方向单向**：adapters 可以 import core，core 不 import adapters；packaging 只描述入口。
- core 的单测在纯 `node` 里跑，不加载任何宿主 SDK。
- 现有 `lib/index.js` 保留为 DSH 组合器，改成 `core + dsh adapter` 的装配，不重写引擎。

---

## 4. 数据模型：加三列 + 两个表，七层不动

### 4.1 条目新增字段

| 字段 | 取值 | 谁写 |
| --- | --- | --- |
| `owner` | `agentId`（如 `dsh:desktop`、`codex:cli`、`claude:code`） | 服务端自动填，**任何工具参数改不动** |
| `ownerLabel` | 显示名（`codex` / `claude-code` / `dsh`） | 注册时给，默认取 agentId 前缀 |
| `scope` | `private` / `workspace` / `global` | 工具参数可指定，受能力位约束 |
| `visibility` | 默认继承 scope，特殊条目可收紧为 `owner-only` | 工具参数 |
| `lastEditor` | 最后修改者 | `memory_update` 自动写，**不覆盖 `owner`** |

### 4.2 新表

- `agents(id, label, capabilities_json, first_seen, last_seen)`——能力位：`canWriteGlobal`、`canPurge`、`canReadPrivateOf`。
- `schema_version(version, applied_at)`——任一入口启动先校验，库版本高于适配层就只读降级。
- `audit(id, ts, agent_id, action, target_id, diff_json)`——谁在什么时候改了什么。

### 4.3 默认 scope 映射（分层语义不变，只叠作用域）

| 层 | 默认 scope | 说明 |
| --- | --- | --- |
| soul | private | 人格是本 agent 的 |
| user | private（可改 global） | 用户偏好通常该共享，agent 自己的调用习惯不共享 |
| rules | workspace | 团队规矩共享；个体补充用 private 覆盖 |
| fact / lesson / topic / project | workspace | 共享主战场 |

### 4.4 幂等

唯一索引 `(scope, content_hash)`，`content_hash` = 规范化文本（去空白与标点）的 sha256。
命中不是 insert 而是 merge：keywords 取并集、importance 取大、`created_at` 留最早、`updated_at` 刷新、`lastEditor` 更新。
**相似度绝不当唯一键**——相似的两条独立事实必须都能留下。

---

## 5. 运行模式：三档，自动升降级

| 模式 | 触发 | 行为 |
| --- | --- | --- |
| `standalone` | 探测不到 `serve` | 直连本地库；先拿 `.write.lock`（文件锁）；dream 与快照自己跑 |
| `shared` | 探测到 `serve`（UDS 或 `127.0.0.1`） | 写走服务队列；能读别的 agent 的共享条目；dream/快照归服务 |
| `readonly` | 锁被别人占着，或库 `schema_version` 高于本适配层 | 只读，回执写明原因与一条可执行命令 |

三条纪律：

1. **三档共用同一库文件、同一 schema**，切模式零迁移。
2. **共享是可选升级**：不装服务、不配任何东西，记 / 查 / 注入 / dream 全套可用。
3. **回落不丢队列**：`shared → standalone` 时待写先落 `pending.jsonl`，下次连上补交。

---

## 6. 单写者服务 `serve`

职责：唯一写连接、唯一 dream 执行者、唯一快照点。

- 端点：`POST /write`（单条或批量）、`GET /search`、`GET /read`、`POST /attach`、`POST /detach`、`GET /stats`、`GET /events`（SSE，UI 用）。
- 传输：优先 UDS（`<dataDir>/serve.sock`），Windows 用命名管道或 `127.0.0.1:PORT`；端口写进 `serve.json` 供探测。
- 写队列：FIFO，每条一个短事务；请求带 `requestId`，重发同 id 视为同一次写。
- 读：多连接并发，SQLite WAL。
- 崩溃语义：agent 死 → 服务与库不受影响；服务死 → agent 进 `readonly`，恢复后补交队列。
- 常驻纪律：默认前台运行，`--install-agent`（mac launchd / Windows 计划任务 / linux systemd --user）必须显式调用，`uninstall --purge` 能清干净。

---

## 7. 工具面：中立 IR + 四个注册器

### 7.1 中立声明

每个工具一份 IR：`{ name, title, description_en, description_zh, inputSchema, handler }`。

- `description` 面向模型，**不带宿主词**（不出现「面板」「星图」「/dream」）；宿主特有话只出现在给用户看的回执里。
- 现有 `defs/*.js` 的 cordis 形态保留，加一层 `toIR()` 转换；DSH 侧由 adapter 把 IR 转回 cordis，行为逐字不变。

### 7.2 注册器

| 注册器 | 目标 | 备注 |
| --- | --- | --- |
| `registerMcp(server, catalog)` | MCP stdio / SSE | 主路径，一次覆盖多数宿主 |
| `registerOpenAI(catalog)` | function calling | 返回 `tools` 数组与 dispatcher |
| `registerAnthropic(catalog)` | tool use | 同上，schema 字段名不同 |
| `registerCordis(ctx, catalog)` | DSH | 与今天等价，断言必须逐字不变 |

### 7.3 命名冲突

别的 MCP server 也叫 `memory_*` 时，`--prefix` 可改前缀（`macromem_` / 自定义）；检测到同 session 已存在同名工具就提示改名，不静默双写。

---

## 8. 注入面：五种策略 + 围栏规约

### 8.1 策略

| 策略 | 形态 | 适用 |
| --- | --- | --- |
| `systemPrefix` | 整会话稳定的前缀 | DSH、自建 loop |
| `firstTurn` | 首条 user message 附一段 | 多数聊天式宿主 |
| `perTurnTail` | 每轮只发差分尾巴 | 长会话 |
| `fileDrop` | 写 `AGENTS.md` / `.cursor/rules` 围栏块 | Codex、Cursor、Aider |
| `hooks` | 宿主 hook 调 CLI | Claude Code 类 |

### 8.2 硬约束（沿用现有，不许松）

1. 变化的内容不进稳定前缀（会每轮打碎 prompt cache）。
2. L0 ≤1,300 字符，以字符计并可测；多接 agent 后**这个数不许涨**。
3. L0 只放 `global` + 本 agent `private`；别人的记忆只经检索进场。
4. 每条非本人记忆在注入文本里带「（`codex` 记）」小尾巴，不新增行。

### 8.3 文件围栏规约（唯一会碰用户文件的动作）

- 只追加一个块：`<!-- macro-memory:begin --> … <!-- macro-memory:end -->`，块外一个字节不碰。
- `refresh` 只改块内；块上限约 1,500 字符，超了先砍条数。
- 已有同名块 → 原地替换，不叠第二个。
- 默认只写仓库级文件；用户级（`~/.codex/AGENTS.md` 等）必须显式 `--user`。
- `uninstall --purge` 精确切除该块 + 删数据目录 + 删 MCP 配置条目 + 删 LaunchAgent/Cache。

---

## 9. 检索面：三段召回 + RRF + 来源标注

- 一次 `memory_search` 拆三路：`private`（本 agent）、`workspace`、`global`，各自打分后 RRF 融合，不塞进一个池子排序。
- 每条结果带 `owner` 与 `scope`：`[self]` / `[agent:codex]` / `[global]`。
- 默认排序偏置：本 agent `private` ×1.3（可关、可调、可解释；调之前先量）。
- 星图仍只在 `graph` / `bridge` 模式参与；`local` 模式不加载。
- 现有 gold 与探针口径保留；**新语料（代码库、工单）必须重配 gold，旧 hit@1 读数不许跨语料复用**。

---

## 10. 管理界面：一份 UI 走所有宿主

`macro-memory ui`：只监听 `127.0.0.1`，启动生成一次性 token 放 URL；它是 `serve` 的客户端，不直连库。

| 页 | 内容 |
| --- | --- |
| 概览 | 各层条数、agent 列表与在线态、注入体积账、共享开关 |
| 记忆 | 七层浏览 + 过滤（agent / scope / 层 / 状态 / 时间）+ 搜索 + 单条编辑 + 合并 |
| 星图 | 按 agent 着色、按权重收放、点线看证据链 |
| 注入预览 | 选一个 agent，看这一轮会注入哪些字、字符数、被哪道闸挡掉几条 |
| agent | 注册、能力位、吊销、lastSeen |
| 共享 | 层与 scope 的共享矩阵、redact 开关与命中记录、导出/导入 |
| 运维 | dream 触发与历史、快照与回滚、doctor 一键体检、锁与队列状态 |

约束：UI 不是必需路径（不开界面，宿主功能一条不少）；首屏 ≤200 KB 传输；星图页按需加载，节点 >2,000 降级渲染；关掉后进程与端口全消失。

---

## 11. 发行与打包

### 11.1 双包

| 包 | 用途 | 版本策略 |
| --- | --- | --- |
| `macro-memory` | 通用入口（MCP / CLI / core / ui） | 从 `0.8.0` 起 |
| `dsh-macro-memory` | DSH 插件与市场条目，依赖前者 | 从 `0.7.x` 继续做兼容修 |

两者同一份 core，不 fork 代码；发版脚本一次发两个包并校验版本映射。

### 11.2 `exports`

```json
{
  ".": "./lib/core/index.js",
  "./core": "./lib/core/index.js",
  "./mcp": "./lib/mcp/stdio.js",
  "./cli": "./bin/macro-memory.mjs",
  "./ui": "./lib/ui/server.js",
  "./dsh": "./lib/index.js"
}
```

### 11.3 零编译

只用 `node:sqlite`，`engines: {"node": ">=22"}`；不引入任何需要 node-gyp 的原生模块。`init` 先探测 Node 版本，低了给一句人话 + 一条安装建议。

### 11.4 三条安装路径

1. `npx -y macro-memory mcp`
2. Homebrew tap（mac）
3. 单文件二进制：win-x64 / mac-arm64 / mac-x64 / linux-x64，发 GitHub Releases，附 sha256。

二进制在 mac 上必须 `codesign --deep --options runtime` + notarize，否则首次运行被 Gatekeeper 拦。

---

## 12. 平台差异

| 项 | Windows | macOS | Linux |
| --- | --- | --- | --- |
| 数据目录 | `%APPDATA%\macro-memory\` | `~/Library/Application Support/macro-memory/` | `$XDG_DATA_HOME/macro-memory/` |
| 后台服务 | 计划任务（显式安装） | launchd `~/Library/LaunchAgents`（显式） | `systemd --user`（显式） |
| 打开浏览器 | `start` | `open` | `xdg-open` |
| 文件锁 | `flock` 兼容实现 | `flock` | `flock` |
| 特有坑 | BOM、中文路径、PATH 含空格 | GUI 进程 PATH 极短、路径 NFD、Gatekeeper | 权限位、容器内 `/proc` 缺失 |

mac 三条专属处理：

1. 外部命令（`node` / `npx`）用「绝对路径优先 + `/bin/zsh -lc 'command -v node'` 探测」并缓存——Finder / Electron 拉起的进程 PATH 极短。
2. 所有路径比较先 `normalize('NFC')`；库里存的 workspace 路径按 NFC 存。
3. 不依赖大小写差异做判断（APFS 默认不区分大小写）。

### 12.1 库位置：一个字节都不挪（0.8.0 实测钉死，改它就是断真身）

上表那个数据目录**不是库目录**。这条 0.8.0 已经踩实了，写在这里防以后手快：

| 库 | 路径 | 谁在用 |
| --- | --- | --- |
| workspace 库 | `<工作区>/.dsh-meow/memory.db` | DSH 插件 / MCP / CLI 三方算出来是同一个文件 |
| 全局库 | `<activeHomeDir>/.dsh-meow/memory.db` | 同上 |
| 平台数据目录 | `%APPDATA%\macro-memory\` 等 | **只放** `config.json`、注入块、日志、快照清单；记忆正文一条都不许进来 |

`activeHomeDir` 由 meow 自己解析，core 只做一件事：**缺省值要跟 DSH 落在同一处**（`lib/core/paths.js` 的 `detectHomeDir()`）：

1. 显式 `homeDir` / `MEOW_MEMORY_HOME` / `MACRO_MEMORY_HOME` 优先；
2. 否则 `<DSH_HOME>/storages/meow-memory`（装了 DSH 的机器，DSH 侧用的就是它）存在就用它；
3. 否则退 `~/.dsh-meow`（meow 作为独立库的历史默认）。

三条由此推出的判断，已经写进 `tools/probe-core.mjs` 的 C3 / C10：

- **dataDir 里出现 `.db` 就是错**——那是把库搬出了真身；
- **装了 DSH 却把全局库算成 `~/.dsh-meow` 就是错**——CLI 记的东西 MCP 查不到，同机器两个「全局库」；
- **不许自己解析 `DSH_HOME`**：只经 `lib/macro/platform.js` 的 `resolveMemoryHome()` 拿（`probe-platform` 的 P7 会咬）。

切库只有一个开关：指针文件 `<DSH_HOME>/storages/meow-memory-home.json`（meow 的 `switchHomeDir()` 写）。两个坑都实测过：①**它必须是无 BOM 的 JSON**，带 BOM 时 `JSON.parse` 抛错、meow 静默回退默认目录，指针「看着改了其实没生效」；②自检若在临时目录里换 `homeDir`，`switchHomeDir()` 会把旧库 copy 过去并**改写这个真实指针**——所以 `probe-core.mjs` 在第一行把 `process.env.DSH_HOME` 指到临时目录，指针随 temp 一起消失。

### 12.2 信任门：同一张表，两个入口

meow 的 #64 保护（工作区自带非本机创建的记忆库时拒绝读写）在 DSH 里靠 `/meow-trust` 解；MCP / CLI 没有斜杠命令，core 复刻了**逐字节相同的表**：`<activeHomeDir>/trusted-workspaces/<sha256(规范化路径)>.json`，内容 `{path, trustedAt, trustedSource}`，路径规范化 `replace(/\\/g,"/").replace(/\/+$/,"").toLowerCase()`。于是 core 写进去的信任，DSH 立刻认，反之亦然，**不需要两边各点一次**。

策略 `auto`（默认）只信任「库目录不存在」或「目录里只有本插件产物」的工作区；目录里有别人的文件就返回 `refused` 并给一条能直接粘的 `npx -y macro-memory trust "<工作区>"`。`always` / `never` 留给脚本。

### 12.3 冷启代价：星图第一枪 3 秒，别当故障

`createMacroEngine()` 装配 258 ms（两个引擎的工具都在几百毫秒内挂上——meow 的 `apply` 是 async，所以引擎尾部用 `bridge.awaitTool('memory_remember')` 等它，最多 5 s）。第一次检索要建星图，实测 **3,354 ms**；之后 58 / 32 ms，无关词 51 ms。CLI 侧因此提供 `--no-nebula`：只查本地层、不要星图时，把这三秒省掉（代价是 `mode=graph` / `bridge` 不可用）。

---

## 13. 性能预算（上限，且要能量）

| 指标 | 上限 | 量法 |
| --- | --- | --- |
| agent 侧 RSS | ≤30 MB | `doctor --mem` 报 RSS，与任务管理器对得上 |
| `serve` RSS | ≤60 MB，且唯一常驻进程 | 同上 |
| attach 启动 | ≤50 ms，不加载全量星图 | 启动日志打毫秒，进耗时基线 |
| 检索延迟 | 热 ≤10 ms p50 / ≤30 ms p95；冷 ≤80 ms | `probe-perf` |
| 每轮固定税 | 注入 ≤1,300 字符、工具 schema ≤15 KB，不许涨 | 现有零成本断言继续守 |
| 空闲 CPU | 5 分钟采样 = 0，无轮询 | `probe-perf --idle 300` |
| UI 首屏 | ≤200 KB、可交互 ≤1 s | 打开时量 |
| 关闭后残留 | 进程 0 / 端口 0 / 临时文件 0 / 锁 0 | 逐项查 |

四类不许付的开销：轮询唤醒、每轮全库扫描、注入路径上的重活（序列化/正则重扫）、UI 与引擎同进程。

---

## 14. 安全与隐私

- **redact**：写库前匹配密钥与 PII 模式（`sk-`、`ghp_`、Bearer、私钥块、手机号/身份证），命中打码并在回执说明「有 N 处已打码」。
- **purge**：按 `agentId` / `scope` / 时间范围彻底删除（不是标 archived）。
- **零出网**：除 `npx` 拉包与显式 `update` 检查外，无任何网络请求；遥测默认关，连匿名统计都不发；`doctor --privacy` 列出所有可能出网的动作。
- **审计**：`audit` 表记写入者与修改；UI 可按 agent 过滤。
- **能力位**：新注册 agent 默认只有 workspace 写权；`canWriteGlobal` / `canPurge` 需显式授予。

---

## 15. 品牌与文档

### 15.1 仓库改名（已批准 · 按 P2-3 三联条件执行）

> 主人 2026-11-26 已允许改名。执行条件仍是「core 剥离完成 + MCP 跑通 + README 首句去 dsh 化」三件同批，缺一不动 remote。名字批准 ≠ 现在改。

- GitHub 仓库 `dsh-macro-memory` → `macro-memory`（rename 自动 301）。
- 改开发机 remote、`package.json` 的 `repository` / `homepage` / `bugs`、两份市场索引的 url 与 `versions[].source.url`（77 条历史条目一起改，hash 不受影响）。
- **不改**：市场条目 `name`、DSH 插件包名、装机目录名。
- 别在旧名下新建仓库占位（会杀掉 301）。
- 时机：与「MCP 能跑通 + README 首句去 dsh 化」同批完成，避免名不副实。

### 15.2 README 首句

改成「给任何 agent 的本地记忆层」，DSH 降为支持列表里的一行；徽章全部用 npm 维度（包名比仓库名稳定）。

### 15.3 能力矩阵

一张表：宿主 × 工具 / 注入 / 面板 / 命令 / hooks，未支持的写明降级行为。这张表是「是否真的适配」的唯一对外证据。

---

## 16. 路线图

### P0（先做，做完就能让 Codex 用起来）

| 步骤 | 动作 | 落点 | 验收 | 回滚 |
| --- | --- | --- | --- | --- |
| P0-1 | 抽 `MemoryEngine(options)`，core 不读环境变量 | 新 `lib/core/`；`platform.js` 降为 DSH adapter 的配置源 | `probe-core-purity` 零命中；core 单测纯 node 跑通 | 保留旧 `lib/index.js` 路径，删新目录即回退 |
| P0-2 | 工具 IR + `registerMcp` | `lib/core/catalog.js`、`lib/mcp/stdio.js` | MCP Inspector 里 8 个工具全在、schema 与 IR 一致 | 入口不生效，DSH 侧不受影响 |
| P0-3 | CLI 最小集：`init` / `remember` / `search` / `doctor` | `bin/` | 干净目录 init 后 remember → search 命中 | 删 bin 即回退 |
| P0-4 | 数据目录按平台，`--data-dir` 可覆盖 | `lib/core/paths.js` | 三平台路径探针 | 配置项回退默认 |
| P0-5 | `schema_version` + 迁移脚本框架 | `lib/core/migrate.js` | 版本门判据（库高→只读） | 迁移只在显式 `migrate` 时跑 |

### P1（多 agent 共享 + 注入面）

| 步骤 | 动作 | 验收 | 回滚 |
| --- | --- | --- | --- |
| P1-1 | `serve`：写队列 + UDS/端口 + attach/detach | 两进程各写 200 条，400 条不丢不重 | 停服回落 standalone |
| P1-2 | `owner` / `scope` / `visibility` / 幂等索引 | 伪造 owner 被拒；A 写 B 读到带 `agent:A` | 列默认值回填，scope 默认 workspace |
| P1-3 | 三段召回 + RRF + 来源标注 | private 对他人零命中（阴性对照验过） | 开关关闭=单池旧行为 |
| P1-4 | 注入五策略 + 围栏 `init` / `refresh` / `uninstall` | 块外零改动；purge 切干净 | 关开关，恢复纯 DSH 注入 |
| P1-5 | `probe-share` 四组判据进 check-all | 全绿；条数与基线一致 | 探针可单跑 |

### P2（发行面与体验）

| 步骤 | 动作 | 验收 |
| --- | --- | --- |
| P2-1 ✅ | 一份 UI（七页：概览 / 记忆 / 星图 / 注入预览 / agent / 共享 / 运维）——`macro-memory ui`，`lib/ui/server.js` + `lib/ui/page.js`，`probe-ui` 12 条 | UI 改一条，宿主下次检索立刻读到（U6）✅；关 UI 功能一条不少（单写者纪律不破：界面是 serve 的客户端，临时服务 `publish:false`）✅ |
| P2-2 ✅ | 双包：`macro-memory`（通用入口）+ `dsh-macro-memory`（DSH 插件）——`packages/macro-memory/package.json` 模板 + `tools/build-dual.mjs` 构建 + `probe-dual` 10 条 | 两包同源（`lib`/`bin`/`vendor` 183 个文件逐字节 + 清单都比）✅；版本映射（模板留 `0.0.0`、脚本灌根版本）✅；npm 两处可查 ⏳（要凭据，`npm publish` 由人来按，脚本只 `npm pack`） |
| P2-3 ◐ | 仓库改名 + README 首句 + 能力矩阵 | 三联条件里本地两件已做完：README 首句去 dsh 化 + 能力矩阵 ✅（`probe-mcp` 11 条把「MCP 跑通」从纸面变成真子进程）；**remote 改名待主人按**（需 GitHub 凭据，连带改写交给 `tools/rename-brand.mjs`，默认 dry-run，`--apply` 前先探新地址） |
| P2-4 ◐ | 单文件二进制 + mac 签名公证 | 单文件 ✅：`tools/build-sea.mjs`（MMB1 容器 + `node --experimental-sea-config` + `postject` 注入）+ `tools/sea-entry.cjs`（CJS 引导器：取包 / 校验包头 / 解临时目录 / 抹平 SEA 的 argv）+ `tools/probe-sea.mjs` 20 条——真打出 `macro-memory-win-x64.exe`（92 MB，包 4.23 MB），`--version` 报 0.8.1、当 MCP 服务器握得上手、185 个文件逐字节与源一致；mac ⏳：`tools/sign-mac.sh` 四步齐全（`codesign --options runtime` → 自验 → `notarytool submit --wait` → `stapler staple` → `spctl -a -vv`），但 `spctl` 通不通要 Apple 开发者账号与真机，判据只能验到脚本层 |
| P2-5 | Homebrew tap | `brew install` 后 `mcp` 可跑 |
| P2-6 | CI 矩阵 win/mac/linux × Node 22/24 × 有/无 DSH | 全绿才发版 |

---

## 17. 判据清单（每条都要能被打红）

- U1 core 静态扫描：`lib/core/**` 里零 `ctx.` / `cordis` / `DSH_HOME` / `iframe`。
- U2 工具面等价：DSH adapter 注册出的 8 个工具，name / schema / 回执与 0.7.1 逐字相同。
- U3 注入零成本：接 3 个 agent 前后，单 agent L0 字符数逐字不变。
- U4 幂等：同 `content_hash` 写两次 → 1 条，keywords 并集、`created_at` 不变。
- U5 隔离：A 的 private 条目，B 检索零命中。
- U6 来源可见：A 写的条目，B 读到时带 `agent:A`；update 后 `owner` 不变、`lastEditor` 变。
- U7 并发：两进程各 200 条并发写，0 丢失、0 重复、无锁死。
- U8 版本门：库版本高于适配层 → 只读 + 明确回执，`INSERT` 次数 0。
- U9 断连：kill agent 不影响服务；kill 服务后 agent 只读、恢复后补交队列。
- U10 围栏：`init` 在已有 `AGENTS.md` 上只追加块；`uninstall --purge` 后文件回到原字节。
- U11 常驻：默认不装 LaunchAgent / 计划任务；`--install-agent` 才装，且能卸。
- U12 性能：RSS / attach / 检索 / 空闲 CPU / UI 首屏 五项都在 §13 预算内。
- U13 隐私：全流程零出网（除 npx）；`doctor --privacy` 列表与代码一致。
- U14 迁移：0.7.1 的库被 0.8.0 直接打开，条目数与 status 分布不变。
- U15 降级：星图缺席时 `graph` 退回本地检索并说明原因（四分类）。
- U16 排版：三平台数据目录、路径归一（NFC）、中文路径下 init/search/export 正常。

新增探针要进 `tools/check-all.mjs` 与 `tools/manual-tools.mjs` 账本（probe-tools 会咬「未归类」）。

---

## 18. 风险与已知坑

1. **MCP 只解决工具，不解决注入**。只做 MCP 会得到「能查但不会主动记」的半成品，注入面必须同期做。
2. **改名与能力不同步**：仓库叫通用名、README 还是「DSH 插件」= 名不副实，用户当场走。改名与 README 同批。
3. **prompt cache**：注入一旦进稳定前缀就不要动；差分内容进尾部或工具返回。
4. **`node:sqlite` 的 Node 门槛**：Node 22 以下直接给出人话与替代路径，不许「大概能跑」。
5. **多进程写同一库**：不上 WAL + 队列 + 版本门，第一次「同时开两个 IDE」就坏库。
6. **库放同步盘**：必坏。文档先写死正确做法。
7. **mac GUI 的 PATH**：外部命令解析不做探测，插件在 mac 上必然 `ENOENT`。
8. **旧读数跨语料复用**：现在的 hit@1 是在 DSH 会话语料上量的，换代码库语料即作废。
9. **文件围栏没做**：`init` 直接往 `AGENTS.md` 追加，卸载时会把用户自己的内容搅乱——这是本计划里最容易造成「用户数据损失」的一处。
10. **工具名冲突**：`memory_*` 在 MCP 生态里不唯一，需要 `--prefix` 与冲突提示。

---

## 19. 决策状态

### 19.1 已定（主人 2026-11-26 22:35 点头，原话「1 2都允许 然后先别开始改」）

| # | 决策 | 结论 | 执行约束 |
| --- | --- | --- | --- |
| D1 | 仓库改名时机 | **允许改名**，时机仍锁在 P2-3：core 剥离完成 + MCP 跑通 + README 首句去 dsh 化，三件同批 | 单改仓库名不算完成，三项缺一就不动 remote |
| D2 | 首发版本 | **`macro-memory@0.8.0` 与 core 剥离同版发出**；`dsh-macro-memory` 留 0.7.x 只做兼容修 | 两包同源、一次发版、版本映射由发版脚本校验 |

一句话：**方向批准，开工时间未定**——主人明确「先别开始改」，所以 0.8.0 的第一行代码要等下一句「开工」。

### 19.2 仍待定

| # | 决策 | 选项 | 默认倾向 |
| --- | --- | --- | --- |
| D3 | `serve` 是否默认随 `init` 起 | 否 / 是（需明确告知常驻） | 否 |
| D4 | 单文件二进制是否首版就给 | 否（P2 后）/ 是（工作量大） | 否 |
| D5 | 私有 embedding reranker | 默认关的 P2 可选 / 不做 | 不做 |

### 19.3 批准带来的两处文档修订

1. §15.1 改名从「一次性窗口」升级为「**已批准、按 P2-3 三联条件执行**」；URL 改写清单不变（remote / package.json 三个字段 / 两份市场索引 url 与 77 条 `versions[].source.url`）。
2. §16 P2-2 与 P2-3 的验收改为「两包同版发布 + 改名生效 + 301 跟随」，并在 P2-6 CI 里加一条「旧名 URL 仍可解析」的检查。

代码、索引、remote、版本号：**全部未动**。

---

## 20. 交接第一步

下一个会话接手时按这个顺序：

1. 读本文件 §1、§3、§16 的 P0 表。
2. 跑 `node tools/check-all.mjs` 确认当前 68 支 / 条数与基线一致（任何数字变化先查是不是有并发改动）。
3. 备份 `D:\备份\<时间戳>-universal-core\`（`lib/`、`tools/`、`package.json`、`plugin-market/`）。
4. 从 P0-1 开始：新 `lib/core/` 只搬不改，`lib/index.js` 保持旧路径可用，直到 `probe-core-purity` 与 U2 同时绿。
5. 每一步只交付一个可回滚的小台阶，别一次性大重构。
