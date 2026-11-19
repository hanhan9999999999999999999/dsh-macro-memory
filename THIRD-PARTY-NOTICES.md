# 第三方代码与来源说明 · Third-Party Notices

本仓库（`dsh-macro-memory`，MIT）**内置两份第三方代码的副本**，两份都是 MIT 许可，许可原文随包保留。以下逐项说明来源、版权、以及我们对副本做的**全部**改动。

本文件对应版本：**0.2.80**。

---

## 1. meow-memory

| 项 | 内容 |
| --- | --- |
| 组件 | `meow-memory`（包内 `vendor/meow-memory/`） |
| 版本 | 0.32.8 |
| 上游 | <https://github.com/Phant0Meow/dsh-meow-memory> |
| 作者 / 版权 | Copyright (c) 2026 **Phant0Meow** |
| 许可 | MIT，原文见 `vendor/meow-memory/LICENSE` |
| 在本项目中的角色 | **主库内核**：七层 SQLite（`.dsh-meow/memory.db`）、写入/检索/更新、梦境巩固、反射、`/meow-memory/*` 命令与路由 |

### MIT 合规说明

MIT 只要求「保留版权声明与许可声明」。我们额外做了两件事，方便任何人核对：

1. `vendor/meow-memory/LICENSE` 原文保留，未改一字；
2. 上游文件名、目录结构基本不动，改动处一律带 `// [macro-fusion <版本>]` 注释，说明**为什么改**。

### 我们对 meow-memory 做的改动（全量清单）

改动分两类：**A. 融合所需的最小接线**；**B. 在原地修掉「静默失败 / 说假话」的缺陷**。两类都只改行为与文案，不删功能、不改数据格式（旧库直接可用）。

#### A. 融合接线

| 位置 | 改动 |
| --- | --- |
| `lib/index.js`（约 3205 行）、`lib/client.js`（约 687 行） | 注入消息的 `source.kind` 由 `plugin:meow-memory` 改为 `plugin:macro-memory`；新增 `LEGACY_PLUGIN_KINDS`，`isMeowSource()` **先认新值、再认两个旧值**（`plugin:meow-memory` 与更老的 `{kind:'plugin', plugin:'meow-memory'}`），保证历史会话里的注入仍能被折叠、锚定、重放 |
| `lib/client.js` 设置页文案（en / zh / pt 三份字典） | 「喵记忆配置加载中」→「宏记忆配置加载中」；「已保存 ✓ 热重载/重启 meow-memory 插件后生效」→「已保存 ✓ 已生效」（融合后设置是真热应用的）；「当前连接不支持设置写入（仅本机回环连接可编辑）」→ 改成陈述事实的写法，不再暗示「这是设计如此」 |
| 未改 | `PLUGIN_NAME = "meow-memory"` 保留为**内部身份名**：日志前缀、`/meow-memory/dreamed-sessions`、`/meow-memory/skip-dreams` 路由、`data-plugin` 属性。显示名与身份名分开——改名会让老会话与老脚本失联 |

#### B. 原地修掉的静默失败（逐条都有对应判据）

| 版本 | 改动 |
| --- | --- |
| 0.2.46 | 空检索结果不再返回「什么都没有」的空数组：说清是「库里没有」「只在某几层里查」「过滤后为空」还是「图还没建完」 |
| 0.2.47 | `memory_project` 的空全景不再只有一句「该项目暂无记忆条目」，补上子类覆盖情况 |
| 0.2.48 | `dream` 的四种停下原因（有 lease / 没有可整理的 / 预算用完 / 没送出去）分别说清，命令面与工具面共用同一套原因 |
| 0.2.49 | `update` 回执加上「改了什么 / 哪些字段被流水线过滤掉」两张表，字段被静默丢弃时不再只回 `ok: true` |
| 0.2.50 | `remember` 七个参数不再被静默过滤：层名写错会明说（原来直接落进 `fact`） |
| 0.2.51 | 层名过滤不再静默：拼错 / 复数 / 一个都不认识 → 明说，而不是返回空结果 |
| 0.2.52 | `read` 短 id 撞车时不再「静默取第一条」（原来会拿别人的正文当基准），改为明说撞车并列出候选 |
| 0.2.53 | `similar` 同样不再在撞车时静默取第一条 |
| 0.2.56 | 状态值 / 时段 / 条数 / 截断长度给错时各说各的，不混进「本次零命中」 |
| 0.2.71 / 0.2.74 / 0.2.75 | （nebula 侧同类问题，见下一节） |

### 指纹

`vendor/VENDOR.json` 记录整棵 vendor 树的文件数、字节数与整树指纹（sha256 前 16 位），并配 25 条「补丁是否还在位」的内容断言（`node tools/doctor.mjs` 会核）。任何人都能验证：这是一份**改了哪几处、其余原样**的副本，而不是另写的东西。

---

## 2. dsh-memory-nebula

| 项 | 内容 |
| --- | --- |
| 组件 | `dsh-memory-nebula`（包内 `vendor/dsh-memory-nebula/`） |
| 版本 | 1.11.74 |
| 作者 / 版权 | Copyright (c) 2026 **主人 & 小代码酱** |
| 许可 | MIT，原文见 `vendor/dsh-memory-nebula/LICENSE` |
| 在本项目中的角色 | **星图索引**：节点 / 边 / 权重 / 枢纽、四模式检索里的 graph 与 bridge、星图面板与离线快照 |

这部分代码由本仓库作者自己维护（上游即本项目），列在这里是为了让索引与内核的来源同样可查。

### 关键改动

| 版本 | 改动 |
| --- | --- |
| 0.2.9 | `recall` 过滤归档/删除节点：归档的记忆不该再作为检索结果出现，也不该当扩散种子 |
| 0.2.11 | 显示名统一为「宏记忆 · 星图」（宿主插件、面板、导出抬头、离线快照标题、i18n） |
| 0.2.39 | 空命中分两种：图里真没有 / 图还没建完（空图、重建中）——两种情况用户该做的事相反 |
| 0.2.41–0.2.45 | 「0 条记忆」「已接入 0 个来源」这类容易被读成「记忆丢了」的句子，各自补上它到底在说什么 |
| 0.2.57 | 数值参数不再被 `Number(x) \|\| 默认值` 吃掉（`0` 是合法值） |
| 0.2.64 | 不认识的类别不再打成 `undefined（0）` |
| 0.2.71 / 0.2.74 / 0.2.75 | 枢纽上限「一个数字三处写」收敛成 `HUB_CAP`：夹参数、正文尾注、schema 描述读同一个数；列表被截断时明说「全图几条、这里列了几条」 |
| 0.2.80 | 工具归因表 `TOOL_OWNER` 统一到 `plugin:macro-memory`，并补齐此前漏记的 `nebula_sources` / `nebula_ingest` / `nebula_hygiene` / `nebula_bridge` |
| 融合层相关 | `systemPrompt.context` 恒返回一条**稳定**的 RULE（不再每轮把邻居关系灌进 prompt）；邻域改由 `memory_search({mode:'graph'\|'bridge'})` 按需拉 |

---

## 3. 运行时依赖

本插件不依赖任何第三方 npm 运行时包：`lib/` 只用 Node 内置模块与宿主注入的 `@deepseek-ai/*`（由 DSH 自身提供，不随包分发）。`vendor/` 下的 node_modules 不随仓库发布（`.gitignore` 已排除）。

---

## 4. 如果你要再分发

再分发本仓库时，请保留：

- 根 `LICENSE`（本仓库，MIT © 2026 主人 & 小代码酱）；
- `vendor/meow-memory/LICENSE`（MIT © 2026 Phant0Meow）；
- `vendor/dsh-memory-nebula/LICENSE`（MIT © 2026 主人 & 小代码酱）；
- 本文件（改动说明）。

MIT 不要求公开改动，但我们认为「改了别人的代码却不说改了哪里」是欠账。
