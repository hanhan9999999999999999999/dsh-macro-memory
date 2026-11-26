# 宏记忆 · Macro Memory

**给任何 agent 的本地记忆层。**

一套引擎管住一个 agent 的全部记忆：8 个工具、常驻注入只占 **1,266 字符**、检索 **2.9 毫秒**。记得住事，也记得住分寸——该进的进来，不该进的写明为什么。

接得上 DSH、Codex、Claude Code、Cursor，以及任何说 MCP 的宿主（[能力矩阵](#一张表看清适配到哪一步)把每一格都标了证据）。**库只有一份**：谁接进来，读的都是它。

![version](https://img.shields.io/npm/v/macro-memory?color=3BAEF0) ![license](https://img.shields.io/npm/l/macro-memory?color=2BD9C3) ![node](https://img.shields.io/badge/node-%E2%89%A524-0B1B2B) ![mcp](https://img.shields.io/badge/MCP-2025--06--18-3BAEF0) ![platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-2BD9C3)

![宏记忆](docs/images/hero.png)

> 同类插件大多把「记得多」当目标。这里的目标是**记得准、说得清、付得起**：每一轮记忆都落成一笔账——进了哪几条、各多少字、被谁挡下、最近分数多少。库坏了能救，插件坏了不连累宿主。

## 目录

- **为什么需要它**：五类真实症状与对应解法
- **它怎么工作**：一轮对话里记忆只做四件事，四道闸各管一段
- **八个工具**：一份手册、一套 schema、附调用示例
- **三张对外面**：工具、命令、两块面板
- **能力矩阵**：宿主 × 工具 / 注入 / 面板 / 命令 / hooks，每一格都标了证据与降级路
- **安装**：DSH 插件 / `npx` / Homebrew / 单文件二进制，四条路都通
- **读数**：注入字符、schema 字节、延迟、命中率、自检规模
- **不说满的地方**：口径、样本量、还没做的事
- **常见问题 / 技术规格 / 文档 / 许可**

---

## 它解决的不是「存不下」，是「记不住、记太贵、说不清」

| 你遇到的 | 它怎么答 |
| --- | --- |
| 聊到第三轮，它忘了第一轮说好的端口和路径 | 七层库里按关键词 × 重要度 × 时间打分，够格的一律进上下文；隔久了还会主动「放回」老条目 |
| 一开记忆插件，每轮先烧一万多 token 讲「怎么用记忆」 | 常驻手册压到 1,266 字符，命中条目按你给的额度整句挤压，长句咬断接上 |
| 它这次没提那条，你也不知道为什么 | 每一轮都落账：进了哪几条、各多少字、谁被挡、挡在哪道闸、最近分数多少 |
| 库一坏，几万条记忆变成 4 KB 空壳 | 自动快照 + 退之前先只读比一次：会丢几条、能找回几条，说清楚才让你换 |
| 记忆插件装了两三个，指令互相打架 | 8 个统一工具、一份手册；旧名字与旧工具不再漏进宿主 |

---

## 一轮对话里，记忆只做四件事

![一轮四步](docs/images/memory-flow.png)

**① 取候选**　本地检索（无 LLM 参与）+ 星图邻域 + 共现自学习扩词。库 1,200 条时 p50 是 2.9ms，热问句不重拼索引。

**② 过闸**　四道闸各管一段，挡下就记下原因：

| 闸 | 管什么 | 挡下时你会看到 |
| --- | --- | --- |
| 字面兜底 | 只对上一个单字（「的」「了」）不算命中 | 整轮不注入，账上写 `literal` |
| 分数线 | 换说法的问题自动降档（真问句走 0.21 的线） | `floor` + 最近分数，提示补 keywords |
| 同话题 | 不在这一轮的话题里就不占名额 | 不记落选（它不是被分数挡的） |
| 陪跑线 | 不到第一名 ×0.2 的不进来 | `margin`，说明第一名比它强多少 |

**③ 注入**　常驻手册 + 命中条目，按字数挤而不是按条数堆；单条上限与会话预算双层保险，每轮总额可调（默认不限）。

**④ 落账**　`picks=` 写每条真实字数，`drops=` 写五种落选原因，面板照旧念得出对策。

![注入账](docs/images/token-budget.png)

---

## 只有一份真身

![三层](docs/images/architecture.png)

- **七层主库是唯一真源**：`soul`（自我）/ `rules`（准则）/ `user`（主人）/ `project`（项目）/ `topic`（来龙去脉）/ `fact`（原子事实）/ `lesson`（经验教训）。分层不是装饰，是「先问准则、再问人、最后问细节」的读取口径。
- **星图只是索引**：邻居、共现、实体提及都在这儿；坏了删掉重算就行，真身一个字不动。连错的边能一键摘掉，重建也不会再连回来。
- **快照是兜底**：开工前存一致副本（每小时最多一份，留 7 份）；复原前先比一次。读到坏库就明说「读不出来」，不猜、不编。

一句话记住三条边界：**写入只写主库；星图读不到就降级并说明原因；任何「没找到」都要分清是「图空 / 没入图 / 引擎旧 / 真没关系」这四种里的哪一种。**

---

## 八个工具，一份手册

| 工具 | 你用它做什么 |
| --- | --- |
| `memory_remember` | 记一条：内容、层级、项目、关键词、重要度；相近的自动合并，顶掉的旧条目标 stale 并留一句「已被取代」 |
| `memory_search` | 检索：默认本地打分 + 沿星图扩散；`mode=graph` 只看关联，`bridge` 找强相关未读，`similar` 找相似条目 |
| `memory_read` | 读全文，顺手带出星图邻居（`neighbors=0` 可关），带预算时只砍邻居、正文一字不截 |
| `memory_update` | 改内容 / 状态 / 关键词；`patch` 只改一句，`append` 补一段，`restore` 退回上一版 |
| `memory_link` | 连与摘：手工连线、解释两条记忆怎么连上的（最短证据链）、把自动连错的边静音 |
| `memory_project` | 项目全景：overview / structure / decisions / quotes / ops / todo 六组 |
| `memory_dream` | 整理本窗口：把这一轮建的、提的记忆逐轮封存成跨会话记忆 |
| `memory_admin` | 运维面板：库位置、星图体检、记忆体检（九类）、来源、成本、注入账、额度、错边、快照、待补连线 |

注入给模型的手册是同一份：`level` 七个、项目六子类、`memory_admin` 十二个动作——手册、schema、常量三处必须是同一件事，错一处就有一条自检红。

### 用起来是什么样

```js
// ① 记一条：层级 + 归属 + 关键词 + 重要度，四样都在了才召回得动
memory_remember({
  content: '发版前先清空 http_proxy，否则 git push 会 600 秒零输出假死',
  level: 'lesson', corrected: true, project: 'my-plugins',
  keywords: ['git push', '代理', '假死', '发版'],
  importance: 4,
})
// → 已记下（与既有条目高度相似时自动合并；被顶掉的标 stale，正文留一句「已被取代：…」）

// ② 问回来：默认本地打分，够预算就沿星图扩散一层
memory_search({ query: 'push 卡住怎么办', budget: 800 })
// → 命中 1 条 · lesson · 关键词 4 个 · 重要度 4（不够格时它会说「档位没到」，不会假装没有）

// ③ 顺着邻居往下读：预算只砍邻居，正文一字不截
memory_read({ id: '0mww…', neighbors: 6, budget: 1200 })

// ④ 改一句而不是重写整条
memory_update({ id: '0mww…', patch: [{ find: '600 秒', replace: '十分钟' }] })
```

参数写坏不会静默变成「库里没有」：枚举值不认、数字越界、id 撞车，都会当场说明是哪一种。

---

## 三张对外面

| 面 | 名字 | 用途 |
| --- | --- | --- |
| 工具 | `memory_*` 八个 | 模型侧唯一的记忆入口 |
| 命令 | `/dream`、`/meow-trust` | 立刻整理本窗口 / 查看改写信任名单（命令名保持原样，改名会让肌肉记忆失效） |
| 面板 | 「宏记忆」、「宏记忆 · 星图」 | 体检、来源、成本、注入账、快照、待补连线；星图可视化 + 证据链 |

面板是静态 iframe：**不进请求前缀、不进工具 schema、不进常驻注入**——同样的信息放在面板里是 0 字节。

---

## 一份记忆，任意 agent 都能用（0.8 起）

到 0.7.x 为止，这套东西长在 DSH 宿主上：换到 Codex、Claude Code、Cursor，同一台机器上那份 `memory.db` 就只是一堆没人读的字节。0.8.0 把**引擎装配**从宿主里剥了出来，于是同一套工具、同一段注入、同一张星图，可以给任意 agent 用——**库还是那一份，位置一个字节没挪**：

| 接法 | 一句话 | 谁适合 |
| --- | --- | --- |
| **DSH 插件** | 市场装 `macro-memory`，重启即生效 | 用 DSH 的人——面板、`/dream`、`/meow-trust` 都在，体验最全 |
| **MCP 服务器** | `npx -y macro-memory mcp` | Codex / Claude Code / Cursor 等一切支持 MCP 的宿主 |
| **CLI** | `npx -y macro-memory search "…"` | 脚本、CI、不想开 agent 只想查一眼的时候 |

挂进任何 MCP 宿主的配置就三行：

```json
{
  "mcpServers": {
    "macro-memory": {
      "command": "npx",
      "args": ["-y", "macro-memory", "mcp"],
      "env": { "MACRO_MEMORY_WORKSPACE": "/你的/项目目录" }
    }
  }
}
```

接上之后发生的事：`initialize` 阶段就把那段 1,266 字符的 L0 手册塞进 `instructions`（客户端不用自己拼提示词），`tools/list` 给出八个 `memory_*` 及完整 schema，`tools/call` 走同一套四道闸。**在 DSH 里记的东西，Codex 当场就查得到**——因为两边算的是同一个路径：workspace 库 `<工作区>/.dsh-meow/memory.db`、全局库 `~/.dsh-meow`（装了 DSH 就是 `$DSH_HOME/storages/meow-memory`）。平台数据目录（Windows `%APPDATA%\macro-memory`、mac `~/Library/Application Support/macro-memory`、linux `$XDG_DATA_HOME/macro-memory`）只放配置、注入块与日志，**不放记忆正文**。

**信任门也搬到了命令行这一侧。** meow 有个 #64 的保护：工作区里躺着一个不是本机创建的记忆库时（clone 了别人的仓库），默认关掉读写，免得被塞一嘴别人的「记忆」。DSH 里的解法是手打 `/meow-trust`；MCP / CLI 没有斜杠命令，所以 core 复刻了**完全同一张表**（`<全局目录>/trusted-workspaces/<sha256(规范化路径)>.json`）。放进来的库（目录里有不是本插件产生的文件）一律不自动信任，只回一段能直接粘的命令：

```bash
npx -y macro-memory trust "/你的/项目目录"
```

信任过的目录，DSH 那边立刻也认，反之亦然——**不需要两边各点一次**。

### 一张表看清「适配到哪一步」

「支持 MCP」这四个字很好写，所以这张表把每一格拆开，并标出证据。「✅」= 本机探针真跑过；「◐」= 按同一份契约实现、本机没装那个宿主，没跑过真机；「❌」= 那个宿主本来就没有这一面，右列写降级路。

| 宿主 | 8 个工具 | 常驻注入 | 本地面板 | 斜杠命令 | 生命周期 hooks | 证据 |
| --- | --- | --- | --- | --- | --- | --- |
| **DSH 插件** | ✅ `memory_*` | ✅ L0 常驻 + 面板/星图 | ✅ 「宏记忆」「宏记忆 · 星图」 | ✅ `/dream`、`/meow-trust` | ✅ 会话生命周期 | `probe-share` 23 / `probe-ui` 12 / `probe-tools` |
| **DSH（走 MCP）** | ✅ | ✅ `instructions` | ◐ 用 `macro-memory ui` | ❌ 宿主没有斜杠命令 | ❌ | `probe-mcp` 11 |
| **Codex CLI** | ✅ | ✅ `instructions`；`init --agents` 写 `AGENTS.md` 围栏 | ◐ 用 `ui` | ❌ | ❌ | `probe-mcp`（协议层）+ `probe-fence` 11 |
| **Claude Code** | ✅ | ✅ 同上；围栏文件换 `CLAUDE.md` | ◐ 用 `ui` | ❌ | ❌ | 同上 |
| **Cursor** | ✅ | ◐ 围栏文件换 `.cursorrules`（格式更松，只做块围栏） | ◐ 用 `ui` | ❌ | ❌ | 同上 |
| **任何 MCP 宿主** | ✅ | ✅ | ◐ | ❌ | ❌ | `probe-mcp` 11 条（真起子进程发 JSON-RPC） |
| **CLI / CI** | ✅ 命令行子命令 | — | — | ✅ `init`/`remember`/`search`/`read`/`project`/`injection`/`refresh`/`uninstall`/`migrate`/`serve`/`attach`/`detach`/`share`/`ui`/`doctor`/`stats` | — | `probe-core` 30 |

三条读法：

1. **工具面是唯一不降级的**。8 个工具、同一套 schema、同一套四道闸（信任门 / 版本门 / 可见性 / 写路径），MCP 与 DSH 走的是同一份 `lib/core`，不是两套实现。
2. **「面板」在非 DSH 宿主里降级成浏览器**：`macro-memory ui` 只听 `127.0.0.1`、一次性令牌放 URL，七页一样在。它**不是第二个写者**——探到在跑的 `serve` 就借，探不到就临时起一个且不写发现文件。
3. **hooks 是宿主能力，不是这套东西的短板**：MCP 没有「会话开始 / 结束」的回调，所以 dream 整理与快照在非 DSH 侧只能靠定时（还没做）或手动 `memory_dream`。

mac / Linux 目前只做到「路径 + 探针就绪」，Windows 是真机跑过的那个。


### 0.9 起：不只是「能用了」，还得「用得踏实」

一份库给多个 agent 用，最先出事的从来不是「跑不起来」，而是「跑起来之后动了不该动的东西」。0.9 补的就是这九处：

1. **往你的文件里写东西，得能还回去。** `init --agents` 把那段 L0 常驻注入写进 `AGENTS.md`（`CLAUDE.md`、`.cursorrules` 同一条路；`--file` 可多次出现或逗号分隔），`refresh` 原地刷新，`uninstall` 摘干净。判据不是「写进去了」，是**卸载后逐字节还原**——连你原文结尾那几个空行都算数。为此「当初插了几个换行」记在块标记里（`<!-- macro-memory:begin sep="2" v="1" -->`），而不是记在我们自己的某个账本上：卸载可能来自另一个进程、另一个工作区、另一台机器，只有文件自己带着「我是怎么被放进去的」才靠得住。坏块（只有 begin 没有 end）一律拒改，一个文件都不动——比自动猜边界、顺手删掉你半页笔记安全。
2. **打开别人写的库，不许猜。** 库的 schema 比适配层新（说明被更新版本写过）时，读写一律停，回执说清谁比谁新、为什么停、两条真出路（升级 `dsh-macro-memory`，或确认后跑 `migrate`）。版本号用 SQLite 原生的 `PRAGMA user_version`——meow 自己从不碰它，所以不新建元表、不改表结构，老库「看起来没被改过」；写版本号只发生在你显式跑 `migrate` 的那一刻，且先 `vacuumInto` 出一份一致副本。
3. **几个 agent 共用一个库，得知道这谁写的。** 写进去的每一条都记归属（MCP 拿 `initialize` 里的客户端名，CLI 记 `cli`），读的时候回执里直接印 `` `[self]` `` / `` `[agent:codex]` `` / `` `[global]` ``；`memory_update` 改内容**不换主人**，只把「最后动过的人」换掉；没有归属记录的老条目一个标签都不加，不写「未知」那种假话。归属登记失败不影响写入——增强功能永远不该变成前置条件。

4. **三种 scope 的条目，别塞进一个池子里比绝对值。** `private`（我这个 agent 的私事）、`workspace`（这个工作区的共同事实）、`global`（跨工作区都成立）的可比性完全不同，而词法分的绝对刻度受池子大小与 idf 分布支配——塞进一个池子排序，等于拿三把尺子量同一张桌子。现在按 scope 切三段**各自打分**，再用 RRF（只吃名次）融合；只有一段时一个字都不改，`rrf: false` 整个退回单池。默认对本 agent 的 `private` 给 ×1.3 偏置（`private_boost: 0` 关掉）——**代价也写在明处**：RRF 里每段第一名都从 rank 1 起算，段小就占便宜，`private` 段通常只有几条，所以它的榜首天然压过 `workspace` 的榜首；这也是偏置只取 1.3 而不是 3 的原因。

5. **两个 agent 同时写，只能有一个写者。** `macro-memory serve` 起一个前台常驻的单写者：所有走这套 core 的 agent 都把它当唯一写连接（发现文件是 `<数据目录>/serve.json`，带一次性令牌），写按 FIFO 一条一个短事务，请求带 `requestId`——重发同一条 id 只算一次写。它同时也是唯一跑 dream、唯一打快照的那个。**默认不装任何常驻**（LaunchAgent / 计划任务得显式调用，这一版还没做），停掉 `serve` 就回落直连，四个命令之外的功能一条不少：`serve` 起服务、`attach` 加入共享并补交、`detach` 退回直连、`share` 看状态。服务要是被 kill，`serve.json` 还在，客户端**不偷偷自己写**——这一条落进 `pending.jsonl` 排队，回执明说「这次没写进库」，服务回来自动补交。宁可让用户多敲一次 `serve`，也不让两条连接各写一半。

6. **看得见，才敢信。** `macro-memory ui` 开一扇窗：只听 `127.0.0.1`、端口由系统挑、一次性令牌放在 URL 里，关掉窗口进程与端口一起消失。七页——概览（三档 scope 与七层分布、注入体积、写手）、记忆（搜索 + 点 id 看全文）、星图（graph 模式扩散）、注入预览（这一轮真的会被塞进上下文的那段字）、agent（谁写过、什么时候）、共享（层 × scope 矩阵、谁是写者、队列多长）、运维（体检 / 统计 / 快照 / 整理账）。**它不是第二个写者**：界面自己不直连库，探到在跑的 `serve` 就借它，探不到就在本进程里临时起一个且**不写发现文件**——所以开着界面永远不会把一个共享服务变成两个写者，关掉界面也不会带走别人的服务。判据照这条来：`probe-ui` 里「界面写一条，另一个引擎实例下次检索立刻读到」，以及「关掉之后端口不再接受连接」。


7. **两个名字，一份代码。** 同一个包要同时讨好两类人：DSH 里装的是插件（要 `cordis.patch.yml`、要 `dsh` 字段），而 Codex / Claude Code / Cursor 只想 `npx -y macro-memory mcp` 一条命令。所以 npm 上有两个名字——`macro-memory`（通用入口：MCP / CLI / core / ui）与 `dsh-macro-memory`（DSH 插件与市场条目）——但**仓库里只有一份 `lib/`、`bin/`、`vendor/`**。通用包由 `tools/build-dual.mjs` 从同一份源现长出来：按白名单复制、把根的版本号灌进 `packages/macro-memory/package.json` 这份模板（模板里写的是 `0.0.0`，手填就会漂），然后**逐字节验** `lib` / `bin` / `vendor` 三棵树一致，再各打一次 tarball 确认不带自检家底。`probe-dual` 10 条盯着这件事，其中两条是这一刀真正的价值：**「装上去 `import 'macro-memory/core'` 真解析得了」**（exports 写错了要等到用户装完才发现），和**「脚本里没有 publish 调用」**——发包要有凭据、要有人看着版本号，这一步不该被脚本代劳。

8. **接得上，才算适配。** 前面七条都是「我们这边做对了」，MCP 这一面得反过来证：**别的宿主接进来，真的读写同一份库**。`probe-mcp` 11 条不造假：真起一个子进程跑 `macro-memory mcp`，用 stdio 发 JSON-RPC——`initialize` 回来的名字与版本跟根 `package.json` 同一个号，`instructions` 就是那段 1,266 字符的 L0 正文（宿主不用自己拼提示词），`tools/list` 的 8 个 schema 与引擎 IR 逐字段一致（不是另抄一份）；接着 `tools/call memory_remember` 写一条，**另一个引擎实例当场检索得到**，库里记的 owner 是客户端自报的名字。另外还有三条防「看起来能用」的：stdout 上只准出现 JSON-RPC 报文（一行杂音就够客户端把连接判死）、坏报文回 -32700 / 未知方法 -32601 / 未知工具 -32602 且列出可选项、工具自己出错走 `result.isError` 而不炸协议层。

9. **一个文件，双击就跑。** 上面八条都假设机器上有 Node、有 npm、能联网。`tools/build-sea.mjs` 把 `package.json` + `bin/` + `lib/` + `vendor/` 打进一个自定义容器（`MMB1`），交给 Node 的 SEA 塞进一份 node 可执行文件：产物是一个 92 MB 的 `macro-memory-win-x64.exe`，没有 npm、没有先装依赖，`--version` 报版本、`mcp` 直接能被 Codex / Claude Code 接上。**打进去的就是仓库里那份**——`probe-sea` 把包解开，185 个文件逐个与源比 sha256，一个字节都没被改写；包里也不许有 `tools/`、`docs/`，自检家底不该发给用户。CJS 引导器（`tools/sea-entry.cjs`）运行时把包解到临时目录（按包哈希分目录，同一版只解一次），并**抹平 SEA 的 argv 怪癖**（那里 `argv[1]` 就是 exe 自己，直接 `slice(2)` 会吃掉第一个参数）。mac 的签名与公证是单独一步 `tools/sign-mac.sh`（`codesign --options runtime` → 自验 → `notarytool submit --wait` → `stapler staple` → `spctl -a -vv`），因为那一步只能在 mac 上跑、要 Apple 开发者账号——**没有账号照样能跑，只是别人第一次打开要右键「打开」**。判据只验到「脚本四步齐全」这一层，`spctl` 通不通只有真机能答。

10. **`brew install` 一行，装的是同一个文件。** mac 与 Linux 上还有第三条路：Homebrew。formula 在 [`packaging/homebrew/macro-memory.rb`](packaging/homebrew/macro-memory.rb)，四个平台块各自一个 `url` + `sha256`，装的就是第 9 条那个单文件产物——**不 `depends_on "node"`**，所以装上就有 `macro-memory`，机器上不必先有 Node，也不必担心宿主的 Node 版本够不够 `node:sqlite`。版本号与四个哈希都不手抄：`node tools/gen-formula.mjs --apply --sums <产物目录>` 从 `SHA256SUMS.txt` 灌进去（92 MB 的产物每打一次哈希都不同，手抄一次就等于把上一次的哈希发给下一次的下载者）；缺哪个平台的产物，那个占位就留着并在报告里点名「半份 sha 的 formula 装不了，别发」。`test do` 里钉了两条——`--version` 报得出号、`--help` 提得到 `mcp`，`brew audit` 与用户拿到手最先做的事是同一件。tap 仓库 `hanhan9999999999999999999/homebrew-tap` 得人推，`brew audit --strict --new` 与真正的 `brew install` 只能在 mac 上按。

11. **三平台全绿才算发版。** `.github/workflows/ci.yml` 是一张矩阵：`windows-latest` / `macos-latest` / `ubuntu-latest` × Node 24（`engines` 写的就是 24），零依赖、不装任何东西，直接跑那批**不需要宿主**的自检。宿主契约（`verify.mjs`）与本机流程备份（`doctor.mjs` 的备份段）在 runner 上不存在——硬跑只会把「环境没有」当成「代码坏了」，这两支留给人自己的机器。mac 上打 SEA 产物要先 `codesign --remove-signature`，所以那一支用 `runner.os != 'macOS'` 守卫，**不是 `continue-on-error`**：不许有「失败了但放过」的开关。`release.yml` 只由 tag 触发，`needs: [test]`（复用的就是 ci.yml 那一份），先判「tag 与 `package.json` 版本同号」，再打两个包、两个名字分别 publish，附上二进制与 `SHA256SUMS.txt`；凭据只从 `secrets.NPM_TOKEN` 取，**没有凭据时脚本会说「这次不发 npm，只出二进制」然后正常退出**——不猜、不静默、不假装发过。CI 里还有一条 PLAN 要求的检查：**两个仓库名都探一遍**——当前名必须活着（200/301/302），改名目标允许还是 404（改名之前不判红，只钉「两个名字不许同时死」；新名一旦生效还会顺手警告「旧名没跟着 301」）。这条写错过一次：第一版只探了改名目标，于是**第一次真跑三平台全红**，而本地 14 条判据全绿（教训写进 [`docs/INTERNAL.md`](docs/INTERNAL.md) 的 9.291 第 4 个坑：静态判据证材料对，真跑证成立）。

十一条各有自检支盯着：`probe-fence` 11 条、`probe-core` 的版本门 2 条、`probe-share` 23 条（归属 13 条 + 隔离 6 条 + 撞车 4 条）、`probe-rrf` 8 条、`probe-serve` 17 条（含**两个真实子进程各写 200 条**的并发判据）、`probe-ui` 12 条（含**界面改一条、宿主下次检索立刻读到**）、`probe-dual` 10 条（含**两包逐字节同源**与**子路径 import 真能解析**）、`probe-mcp` 11 条（含**另一个引擎实例当场读到 MCP 写的条目**与**stdout 零杂音**）、`probe-sea` 20 条（含**真打一个产物并让它当 MCP 服务器握手**与**包内 185 个文件逐字节对回仓库**）、`probe-homebrew` 11 条（含**真喂四个平台的假 SHA256SUMS 看四个哈希都进报告**与**不带 `--apply` 时 formula 一个字节都不动**）、`probe-ci` 14 条（含**ci 与 release 的分工**、**没有 `continue-on-error`**、**`--only` 名单每个名字都对得上**——改名后不许静默跑空集）。

不开 agent 也能自证：

```bash
npx -y macro-memory doctor
# 版本 0.8.1 / 数据目录 … / 工作区 … / 库 … / 信任：已信任
# 引擎 meow=就绪 nebula=就绪 / 子工具 17 / 注入 L0 1266 字符
# 结果：一切正常
```

边界说在前面：0.8.x 交付的是「同一个引擎能被别的 agent 用起来」这一层地基；**0.9 把地基上的房子都盖了**——三档模式（`standalone` / `shared` / `readonly`）、每条记忆的 `owner` / `scope` / `visibility`、单写者 `serve` 写队列、七页本地 UI、双包 `macro-memory` + `dsh-macro-memory`、MCP 面的真机自证、能双击跑的单文件二进制、`brew install` 的 formula、三平台 CI 与「全绿才发版」，**每一件都有一支自检盯着**（见上面十一条）。还没做的都在 [`docs/PLAN-UNIVERSAL.md`](docs/PLAN-UNIVERSAL.md) 里明码写着：`serve` 的 `--install-agent`（装成 LaunchAgent / 计划任务）、dream 的定时接管、mac 产物的真机签名与公证与 tap 仓库推送、CI 的第一次真实运行记录——这几件这一版没做就是没做。

**0.8.1 把这条路的地基补实了**：0.8.0 发到 npm 后 `npx` 其实起不来——两处断点。第一处是名字：npm 包叫 `dsh-macro-memory`、bin 叫 `macro-memory`，`npx -y macro-memory …` 会被当成「找一个叫 macro-memory 的包」，而那个包当时不存在，于是报 `'macro-memory' is not recognized`；0.8.1 的正确写法是 `npx -y -p dsh-macro-memory macro-memory mcp`（0.9 起通用包 `macro-memory` 自己上架，直接 `npx -y macro-memory mcp` 即可，本页其余命令已按 0.9 的写法）。第二处更深：`vendor/meow-memory` 里有 4 处裸名 `import` 伸进 DSH 的私有包（`@deepseek-ai/dsh-llm` × 3、`@deepseek-ai/schemastery` × 1），在本仓能跑只是因为 Node 向上解析撞见了 DSH 的 `node_modules`。0.8.1 把它们换成自带实现（`lib/core/compat/dsh-llm.js`，约 75 行）与自带整包（`vendor/schemastery` + `vendor/cosmokit`），于是**没有 node_modules 也能跑**。判据不是「本机通过」，而是裸包：把 `bin` / `lib` / `vendor` 照 `files` 白名单复制到一个空目录跑 `doctor`，引擎照样两个就绪、八个工具照样在、L0 照样 1,266 字符——这条已经钉进自检（`probe-core` 的 `C11` 与 `C12`）。0.8.0 在 npm 上已标 `deprecated`，请用 0.8.1。

---

## 安装（三分钟）

1. 在 DSH 市场装 `macro-memory`（或 `npm i dsh-macro-memory`），重启 DSH 生效。
2. 什么都不用配：默认就会记、会检索、会落账。
3. 觉得注入太多或太少，一句话调额度（按轮总额、单条上限、会话预算都能单独设）。

### 不装 DSH 也能用：三条路

记忆层不只给 DSH 用。三条路装的是同一份代码、读的是同一个库（数据目录按平台落在同一处），所以可以混着用——brew 装的 `macro-memory mcp` 与 DSH 插件记的是同一段记忆。

| 路子 | 命令 | 适合谁 |
| --- | --- | --- |
| npm（最省事） | `npx -y macro-memory mcp` | 有 Node 的任何宿主：Codex、Claude Code、Cursor、任何说 MCP 的 |
| Homebrew | `brew install hanhan9999999999999999999/tap/macro-memory` | mac / Linux，不想让记忆层拖着 Node |
| 单文件二进制 | 从 [Releases](https://github.com/hanhan9999999999999999999/dsh-macro-memory/releases) 下 `macro-memory-<平台>`，`chmod +x`（Windows 直接双击） | 机器上没有 Node、也没有网 |

- Homebrew 的 formula 在 [`packaging/homebrew/macro-memory.rb`](packaging/homebrew/macro-memory.rb)：`version` 与四个平台的 `sha256` 不手抄，由 `node tools/gen-formula.mjs --apply --sums <产物目录>` 从 `SHA256SUMS.txt` 灌进来——92 MB 的产物每打一次哈希都不同，手抄一次就等于把上一次的哈希发给下一次的下载者。缺哪个平台的产物，那个平台的占位就留着，脚本会点名「半份 sha 的 formula 装不了，别发」。
- tap 仓库是 `hanhan9999999999999999999/homebrew-tap`，把 formula 放成 `Formula/macro-memory.rb` 即可。`brew audit --strict --new` 与真正的 `brew install` 要在 mac 上按。
- 三条路的产物都自报同一个版本号（`macro-memory --version`），装错了立刻看得出。

### 三个平台，同一套装法

Windows、macOS、Linux 装的是同一份包、同一套代码：**没有原生依赖，也没有 install 脚本**，SQLite 直接用宿主自带的 `node:sqlite`。

| 平台 | 宏记忆默认落在哪 | 说明 |
| --- | --- | --- |
| Windows | `%DSH_HOME%\macro-memory`（常见是 `D:\dsh-home\macro-memory`） | 与宿主同一套规则 |
| macOS | `~/.dsh/macro-memory` | `$DSH_HOME` 有值时以它为准 |
| Linux | `~/.dsh/macro-memory` | 同上 |

- 宿主 Node ≥ 24（`node:sqlite` 从 22.5 起有，本插件的 `engines` 写在 24）。宿主自己带的 runtime 就是 24.21.0，不用另装。
- mac 上 DSH 的 `app.asar` 带完整性校验（`ElectronAsarIntegrity`），插件不改宿主，走 `profiles` 安装面——和 Windows 一样。
- 库要复原：先 `node tools/restore-live-db.mjs --dry-run` 体检，核对无误再去掉 `--dry-run`（**先退出 DSH**）；脚本自动备份三件套并删掉旧的 `-wal`/`-shm`。
- 平台细节、装法、排障、mac 真机冒烟清单：[docs/MAC.md](docs/MAC.md)。

---

## 读数：用事实说话

同一台机器、同一份冻结语料，只换被测对象。所有数字都能用仓库里的脚本复算。

### 省在哪

| 项 | 0.2.x | 现在 | 怎么量的 |
| --- | --- | --- | --- |
| 常驻注入（每轮模型都要看的全部手册） | 4,085 字符 | **1,266 字符**（−69%） | `probe-cost` 逐字计字符，含标题与空行 |
| 8 个工具 schema | 56,759 B | **15,153 B**（−74.5%） | 序列化 `ctx.tools` 的定义后计字节 |
| 每轮固定开销 | ≈ 2.2K token | **≈ 0.4K token** | 上面的字符数 ÷ 3 估 token |
| 检索延迟（1,200 条库，p50） | 6.1 ms | **2.9 ms** | 本机 Windows 11，热问句不重拼索引 |

### 准在哪

自建 gold：**146 条**（含 **106 条干扰**），四档问法各跑一遍，`hit@1`：

| 档位 | 0.2.x | 0.4.0 | 现在 |
| --- | --- | --- | --- |
| 照抄（原话原词） | 0.977 | 1.000 | **1.000** |
| 换说法（同义不同词） | 0.929 | 1.000 | **1.000** |
| 时间锚（问「上个月那条」） | 0.833 | 0.889 | **0.889** |
| 误伤（不该命中的反例） | 0 | 0 | **0** |

### 自己怎么验自己

| 版本 | 自检支数 | 可执行断言 |
| --- | --- | --- |
| 0.3.0 | 25 | 3,341 |
| 0.4.0 | 30 | 3,511 |
| 0.5.0 | 31 | 3,522 |
| 0.6.0 | 32 | 3,536 |
| 0.6.73 | 67 | 4,616 |
| 0.7.0 | 68 | 4,639 |
| 0.8.0 | 69 | 4,663 |
| **0.8.1** | **69** | **4,671** |
| 0.9.0（开发中） | 79 | 4,810 |

断言只用一套实现（`tools/criteria.mjs`），每条都要能「被打红」才算成立：给它造一个只该弄红那一条的输入，没红就说明这条判据是恒真的。

---

## 不说满的地方

- **gold 是自己造的**。146 条宽池由我和主人一起写，106 条干扰是故意放的近邻。它证明「同一把尺子上变好了」，不证明「比别家强」——没跑过任何公开榜单。
- **端到端判分是历史读数**。LoCoMo 1,540 题、deepseek-chat 判分的 71.95% 是 2026-11-20 用 0.2.x 代码跑的，与现在的版本不同口径，**不并排比较**。要新数字得重跑，那要花 token，需要主人点头。
- **延迟是单机 p50**，不是集群基准；1,200 条库也不是「十万条也这样」的承诺。
- **mac / Linux 只做到「路径 + 探针就绪」**，真机 gold 复跑还没做。
- **换说法档的边界**：桥词必须真的在库里出现过（`df > 0`）；从没人写下过的说法，它也学不到。
- **`private` 挡住了检索与直读，没挡住所有出口**。0.9 起，别人的 `private` 条目不会进你的 `memory_search` 候选池（不占 k、不上时间轴），`memory_read` 也读不到，回执会明说「这是另一个 agent 的 private 记忆，不给你看」。但 `memory_project` 的面板、星图扩散、`memory_dream` 的整理账还没过这道滤——那几处仍可能露出正文。当「别顺手读别人的私事」的护栏够用，当权限边界还早一步。

口径与错例的完整清单：[docs/EVAL-CLAIMS.md](docs/EVAL-CLAIMS.md)。

---

## 常见问题

**会不会很贵？** 每轮固定开销约 0.4K token（比 0.2.x 少约 85%），检索本身 2.9ms 且不调用任何模型。命中条目按额度挤压，预算花在内容上而不是说明书上。

**会不会记脏？** 写入有层级与项目口径；重复的合并、被取代的标 stale 但不删；体检面板能查出重复、该更新、凑数、超重、没人读、孤立、自证、召回没读、写多收少九类。

**会不会跟别的记忆插件打架？** 它接管记忆面：旧工具名与旧插件名不进宿主，8 个工具的单行说明都 ≤200 字。

**数据在哪？** 本地 SQLite，每个工作区一份（`<工作区>/.dsh-meow/memory.db`），不联网、不上传。

**库坏了怎么办？** 面板只报「读不出来」并指去看快照；复原前先只读比一次，4 KB 空壳快照会单独警告（退它等于清库）。

**能看它怎么想的吗？** 能。注入账写每轮进了哪几条、各多少字、被谁挡；星图面板能点开一条记忆看它跟谁连着、为什么连（最短证据链）。

---

## 技术规格

| 项 | 现在 |
| --- | --- |
| 版本 | 0.9.0（开发中；最新发布 0.8.1） |
| 自证规模 | **79 支自检 / 4,810 条可执行断言** |
| 常驻注入 | 1,266 字符（模型每轮看到的全部手册） |
| 工具 schema | 8 个，合计 15,153 B |
| 检索 | 2.9 ms（p50，1,200 条库；热问句不重拼索引） |
| 每轮固定开销 | 约 0.4K token |
| 对外检索口径 | gold 宽池 146 条：照抄 1.000 / 换说法 1.000 / 时间锚 0.889 |
| lib/client.js | 190,368 B，sha256 `CBDE145F…` |
| 存储 | 本地 SQLite（每工作区一份）+ 可重建星图索引 + 自动快照 |
| 许可 | MIT |

---

## 参与开发

```bash
node tools/check-all.mjs      # 79 支自检，全绿才算改完
node tools/doctor.mjs         # 交付物体检：版本、字节数、图、市场索引
node tools/check-market.mjs   # 市场索引能不能被宿主接受
```

三条规矩：①任何检查项只写一份实现，且必须被证明过「能红」；②改中文文件只用编辑器/node 脚本，不走 `Get-Content | Set-Content`（会变乱码且检测不出来）；③断言数掉了是唯一「有人删了东西」的信号，掉了就红。

---

## 文档

- [版本历史](docs/CHANGELOG.md)：每一版改了什么、读数多少、判据为什么这么画。
- [内部日志](docs/INTERNAL.md)：逐轮开发记录与处方。
- [评测口径](docs/EVAL-CLAIMS.md)：对外能说的数字，以及它怎么量出来的。
- [设计](DESIGN.md)：内部分层、注入、星图、快照的取舍。
- [跨平台](docs/MAC.md)：mac / Linux 的装法、路径规则、复原办法与真机冒烟清单。

---

## 许可与第三方

本包 **MIT**（见 [LICENSE](LICENSE)）。内置两套 MIT 组件，改动逐条说明在 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)：

| 组件 | 来源 | 用途 |
| --- | --- | --- |
| `meow-memory@0.32.8` | [Phant0Meow/dsh-meow-memory](https://github.com/Phant0Meow/dsh-meow-memory) | 检索与记忆内核 |
| `dsh-memory-nebula@1.11.74` | 本仓库作者 | 星图内核 |

Bundled third-party code is MIT: `meow-memory` © 2026 Phant0Meow, `dsh-memory-nebula` © 2026 主人 & 小代码酱.
