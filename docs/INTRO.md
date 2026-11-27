# 0.9.0：一份记忆，任何 agent 都能用——而且用得踏实

> 这篇是给「第一次听说它」和「准备把它接上」的人看的。
> 想直接动手：跳到 [三分钟接上](#三分钟接上)。想问「凭什么信」：看 [自证](#自证79-支自检4812-条断言三平台全绿)。

---

## 一句话

**给任何 agent 的本地记忆层。** 一套引擎管住一个 agent 的全部记忆：8 个工具、常驻注入只占 1,266 字符、检索 2.9 毫秒。

接得上 DSH、Codex、Claude Code、Cursor，以及任何说 MCP 的宿主——**库只有一份，谁接进来读的都是它**。

---

## 这一版真正发生的事

0.8 干了一件事：把**引擎装配**从 DSH 宿主里剥出来，让同一套工具能给任意 agent 用。
0.9 干的是另一件事：**把「能用」变成「用得踏实」**——多 agent 共用一份库，最先出事的从来不是「跑不起来」，而是「跑起来之后动了不该动的东西」。

九处硬骨头，每一处都有一支自检盯着：

| # | 问题 | 0.9 的答案 | 判据 |
| --- | --- | --- | --- |
| 1 | 往你文件里写注入，怎么还回去 | `init --agents` 写 `AGENTS.md` / `CLAUDE.md` / `.cursorrules`，`uninstall` 摘干净 | **卸载后逐字节还原**，连原文结尾的空行都算数；坏块一律拒改 |
| 2 | 打开别人写的库，结构比我这版新 | 读写全停，回执说清谁比谁新、为什么停、两条出路 | 版本号走 SQLite 原生 `PRAGMA user_version`，不新建元表、不改表结构 |
| 3 | 几个 agent 共用一个库，谁写的 | 每条记 `owner`，回执印 `[self]` / `[agent:codex]` / `[global]` | 改内容不换主人；没归属的老条目一个标签都不加（不写「未知」那种假话） |
| 4 | 三种 scope 塞一个池子比绝对值 | 按 `private` / `workspace` / `global` 切三段各自打分，再用 RRF 只吃名次融合 | 只有一段时一个字都不改；`rrf: false` 整个退回单池 |
| 5 | 两个 agent 同时写 | `macro-memory serve` 起唯一写者，FIFO 一条一短事务，`requestId` 幂等 | 服务被 kill 时客户端**不偷偷自己写**，落 `pending.jsonl` 排队，回来自动补交 |
| 6 | 看不见就不敢信 | `macro-memory ui` 七页本地窗：只听 `127.0.0.1`、端口系统挑、一次性令牌 | **它不是第二个写者**：探到 `serve` 就借它，探不到临时起一个且不写发现文件 |
| 7 | 一个包讨好两类人 | 两个名字、一份代码：`macro-memory`（MCP/CLI/core/ui）+ `dsh-macro-memory`（DSH 插件） | `build-dual` 逐字节验 `lib`/`bin`/`vendor` 三棵树一致，再各打一次 tarball |
| 8 | 「接得上」得反过来证 | 真起子进程跑 `macro-memory mcp`，stdio 发 JSON-RPC | 写一条，**另一个引擎实例当场检索得到**；stdout 上只准有 JSON-RPC |
| 9 | 机器上没有 Node 也得能用 | 单文件 SEA 二进制（`MMB1` 容器 → Node SEA） | 包解开后 **185 个文件逐个与源比 sha256**，一字节都没被改写；包里不许有 `tools/`、`docs/` |

---

## 全 agent 适配：一张表看清适配到哪一步

| 宿主 | 工具面 | 常驻注入 | 归一化 | 星图 | 归属 | 证据 |
| --- | --- | --- | --- | --- | --- | --- |
| **DSH**（插件 / desktop / web / headless） | ✅ 8 个 `memory_*` | ✅ 全套 | ✅ | ✅ | ✅ | `probe-dual`、`probe-monotone`、`doctor` |
| **任何 MCP 宿主** | ✅ `npx -y macro-memory mcp` | ✅ `instructions` 里就是那段 L0 | ✅ 按 scope 三档 | ◐ 用 `ui` | ✅ 取 `initialize` 的客户端名 | `probe-mcp` 11 条 |
| **Codex CLI** | ✅ 同上 | ✅ 同 `AGENTS.md` 围栏 | ✅ | ◐ 用 `ui` | ✅ `[agent:codex]` | `probe-mcp` + `probe-fence` 11 |
| **Claude Code** | ✅ 同上 | ✅ 围栏换 `CLAUDE.md` | ✅ | ◐ 用 `ui` | ✅ | 同上 |
| **Cursor** | ✅ 同上 | ◐ 围栏换 `.cursorrules`（只做块围栏） | ✅ | ◐ 用 `ui` | ✅ | 同上 |
| **脚本 / CI** | ✅ `npx -y macro-memory search "…"` | — | ✅ | ◐ | ✅ 记 `cli` | `probe-platform` |
| **单文件二进制** | ✅ `macro-memory-<平台>-<架构> mcp` | ✅ | ✅ | ◐ | ✅ | `probe-sea` |

「库只有一份」不是口号，是同一个路径算出来的：

- workspace 库：`<工作区>/.dsh-meow/memory.db`
- 全局库：`~/.dsh-meow`（装了 DSH 就是 `$DSH_HOME/storages/meow-memory`）
- 平台数据目录（Windows `%APPDATA%\macro-memory`、mac `~/Library/Application Support/macro-memory`、linux `$XDG_DATA_HOME/macro-memory`）只放配置、注入块与日志，**不放记忆正文**

所以：**在 DSH 里记的东西，Codex 当场就查得到。**

---

## 自证：79 支自检、4,812 条断言、三平台全绿

这套东西的可信度不建立在「我觉得对」上，建立在能跑红的断言上。

| 指标 | 0.9.0 |
| --- | --- |
| 自检支数 | **79 支** |
| 可执行断言 | **4,812 条** |
| 三平台 CI | ubuntu / macos / windows × Node 24，**全绿** |
| 常驻注入 | **1,266 字符** |
| 检索耗时 | **2.9 毫秒** |
| 归属覆盖 | 每条写入都记 owner/scope/visibility；检索行直接印标签 |

三条规矩撑着这套数字：

1. 任何检查项**只写一份实现**，且必须被证明过「能红」；
2. 改中文文件只走编辑器或 node 脚本（`Get-Content | Set-Content` 会变乱码还检测不出来）；
3. 断言数掉了是唯一「有人删了东西」的信号——掉了就红。

---

## 三分钟接上

### DSH 里（插件）

```bash
dsh plugin install dsh-macro-memory@0.9.0
```

装完在会话里直接说「记住这个」，`memory_*` 八个工具就在。

### 任何 MCP 宿主（Codex / Claude Code / Cursor）

```bash
npx -y macro-memory mcp
```

挂进宿主配置即可。`initialize` 阶段会自己把那段 1,266 字符的 L0 手册塞进 `instructions`，客户端不用拼提示词；`tools/list` 给八个工具与完整 schema。

顺手把注入写进项目文件（想让它常驻）：

```bash
npx -y macro-memory init --agents            # AGENTS.md
npx -y macro-memory init --agents --file CLAUDE.md,.cursorrules
npx -y macro-memory refresh                  # 原地刷新
npx -y macro-memory uninstall                # 摘干净，逐字节还原
```

### 不想开 agent，只想查一眼

```bash
npx -y macro-memory search "上次那个 bug 是怎么修的"
npx -y macro-memory ui                       # 七页本地窗，只在 127.0.0.1
```

### 机器上没有 Node

```bash
# GitHub Release 里下对应平台的那一个，双击就跑
./macro-memory-linux-x64 --version
./macro-memory-linux-x64 mcp
```

### mac / Linux 包管理

```bash
brew install hanhan9999999999999999999/tap/macro-memory
```

---

## 两个名字，一份代码

| 包 | 给谁 | 入口 |
| --- | --- | --- |
| `dsh-macro-memory` | DSH 插件与市场 | 插件装配（`cordis.patch.yml` + `dsh` 字段） |
| `macro-memory` | 通用宿主 | MCP / CLI / core / ui |

仓库里只有一份 `lib/`、`bin/`、`vendor/`；通用包由 `tools/build-dual.mjs` 从同一份源现长出来，按白名单复制、把根版本号灌进模板，然后**逐字节验三棵树一致**，再各打一次 tarball 确认不带自检家底。

---

## 这一版修掉的一个真 bug（值得单独说）

发版前三天，CI 三平台红在「不需要宿主的那批自检」。根不在 CI：**记忆 id 的短形态是 base36 毫秒时间戳**，前 8 位只有 **36 毫秒**精度——同一窗口里连写两条，回执上的 8 位前缀会一模一样，归属账的 UPDATE 就互相覆盖，后写的那条把前一条的 owner/scope 改掉。

Windows 上每条写入跨毫秒，永远撞不上；Linux CI 连写三条落在同一窗口，一撞就红。

修法是三层一起改：回执印**完整 id**；归属查询统一走 `id LIKE '片段%'`；标签只在「撞车的那几条 owner/scope 一致」时才敢标——**宁可这一条不标，也不说假话**。

修完还顺带发现：判据自己也在用 8 位前缀比身份，`probe-share` 的 S13 于是用独立内存库手工造出同前缀的 id，把这条钉住。这类「自己验自己也犯同一个错」的坑，写进了 [内部日志 9.292](INTERNAL.md)。

---

## 不说满的地方

- `private` 挡住了检索与直读，**没挡住所有出口**：`memory_project` 面板、星图扩散、`memory_dream` 整理账仍可能露出正文。当「别顺手读别人的私事」的护栏够用，当权限边界还早一步。
- `serve` 的 `--install-agent`（LaunchAgent / 计划任务）这一版**没做**，得手动起。
- dream 的定时接管没做。
- mac 产物的真机签名与公证、tap 仓库推送，这一版没有——脚本四步齐全（`codesign` → 自验 → `notarytool` → `staple` → `spctl`），但没有开发者账号照样能跑，只是别人第一次打开要右键「打开」。
- CI 的真机矩阵只覆盖 ubuntu / macos / windows 的 Node 24；Node 22 不适用（`engines.node >= 24.0.0`）。

这些都明码写在 [PLAN-UNIVERSAL.md](PLAN-UNIVERSAL.md) 里，做完一件划掉一件。

---

## 事实清单

| 项 | 值 |
| --- | --- |
| 版本 | 0.9.0 |
| npm | `dsh-macro-memory@0.9.0`、`macro-memory@0.9.0` |
| GitHub Release | `v0.9.0`：`macro-memory-linux-x64` + `SHA256SUMS.txt` |
| 许可 | MIT（内置 `meow-memory@0.32.8`、`dsh-memory-nebula@1.11.74`，逐条改动见 `THIRD-PARTY-NOTICES.md`） |
| 自检 | 79 支 / 4,812 条 / 三平台全绿 |

想看得更深：[版本历史](CHANGELOG.md) · [内部日志](INTERNAL.md) · [评测口径](EVAL-CLAIMS.md) · [跨平台](MAC.md)
