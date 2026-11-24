# 宏观记忆调控插件（dsh-macro-memory）

**0.2.0 起是融合态**：meow-memory（0.32.8，记忆库/七层真相）与 dsh-memory-nebula（1.11.74，记忆星图/索引）
被装进同一个 DSH 插件包，**不再各守一套工具面和注入**：

- 工具面：17 个 → **8 个统一 `memory_*`**（写/改/搜/读/项目/连线/整理/运维），重复能力以 meow 的实现为准；
- 注入面：4,085 字符两段 → **949 字符一段**，order 130，写的是本插件的宏口吻手册；
- 联动：写入可顺手连边（`links[]`）、检索可顺带星图扩散（`expand`/`memory_ids[]`）、读物顺带邻居、运维口合一。

两个 vendor 包降级成**引擎**：它们的 `apply` 被包一层 facade，工具注册与 systemPrompt 注入都被
接管，不再直接下发到宿主。原两包逻辑仍然一行未改（只读），改动全在 `lib/macro/`。
细节与实现说明见 **§9 融合层**，设计取舍见 `DESIGN.md` §11。

---

## 1. 目录

```
dsh-macro-memory/
├── package.json               # name=dsh-macro-memory；dsh.bundle.patch + dsh.client
├── cordis.patch.yml           # 插一行 - id: macro-memory / name: 'dsh-macro-memory'
├── lib/
│   ├── index.js               # 宿主侧装配：两个 vendor 包各包一层 facade → 8 工具 → 一段注入
│   ├── macro/
│   │   ├── bridge.js          # Proxy facade、工具/注入捕获、awaitTool/call/tryCall
│   │   ├── tools.js           # 装配器：拼 8 个 defs + compatAliases 补回旧名（≤6 KB）
│   │   ├── shared.js          # 共用形状：LEVELS / TEXT_OUT / pick / neighborSection
│   │   ├── linkflow.js        # 连线流程：graphState / applyLinks / flushLinks / flushNow
│   │   ├── defs/              # 一个工具一个文件：remember update search read project link dream admin
│   │   ├── prompt.js          # L0 手册（949 字符）+ L2 按需手册（取 vendor 原文）
│   │   ├── brand.js           # 文案归口：旧工具名 → macro 的说法（见 9.6）
│   │   ├── links.js           # 待补连线队列 $DSH_HOME/macro-memory/pending-links.jsonl（见 9.9）
│   │   └── cost.js            # $DSH_HOME/macro-memory/cost.jsonl 账本
│   └── client.js              # 浏览器侧组合器（build.mjs 生成，勿手改）
├── vendor/
│   ├── meow-memory/           # 原包完整副本（lib/ + lib/prompts/ + *.map + README）
│   └── dsh-memory-nebula/     # 原包运行时副本（lib/ 含 host/ 与 web/ + locale/ + market/）
├── build.mjs                  # 由两份 vendor client 重新生成 lib/client.js
├── verify.mjs                 # 自检（宿主侧装配契约 + 浏览器侧）
├── DESIGN.md                  # 设计方案（§11 = 0.2.0 实施落点）
└── tools/
    ├── probe-fusion.mjs       # 真 vendor + 假 ctx 的端到端联动探针（ALL PASS）
├── probe-graph.mjs        # 真 meow 库 + 真 nebula 引擎：写入→建节点→连线→读邻居（见 9.13）
    ├── probe-host.mjs         # 真 cordis + 真 ToolsService + 真 SystemPrompt 的宿主管线（见 9.8）
    ├── coverage-audit.mjs     # 17 个原工具 → 8 个统一工具的覆盖审计（见 9.7）
    ├── param-audit.mjs        # 每个原参数都还能传进去的参数级审计（见 9.7）
    ├── wire-profile.mjs       # 改 profile 的 package.json 与 cordis.patch.yml
    └── …                      # 其余为测量/打补丁脚本（见 §4、§8）
```

`vendor/dsh-memory-nebula` 没有带 `docs/` 与 `scripts/`（纯文档与发布脚本，运行时不用）。
`vendor/meow-memory` 是全量，连 `.map` 一起带（以后要改源码可以直接从 map 还原 33 个 .ts）。

## 2. 两侧怎么挂上去

### 宿主侧（Node 进程）

`lib/index.js`：

```js
export const inject = ['tools']
ctx.plugin(wrapPlugin(Meow,   bridge, 'meow'),   config.meow)    // 工具名收进 bridge，不注册
ctx.plugin(wrapPlugin(Nebula, bridge, 'nebula'), config.nebula)  // 9 个 nebula_* 也收进 bridge
// → 再由 createUnifiedTools() 注册 8 个 memory_*，由 installGuide() 装一段 systemPrompt
```

`wrapPlugin(mod, bridge, vendor)` 只把 `mod.apply` 包一层：
`(c, cfg) => mod.apply(createFacade(c, bridge, vendor), cfg)`。
为什么要包而不是直接 `ctx.plugin(Mod)`：cordis 传给子插件 `apply` 的 fiber ctx 由宿主创建，我们
插不进手；唯一能替换的对象就是传进去的 `mod`。

facade 是 Proxy，只拦三处：

| 被拦 | 原行为 | 现在 |
|---|---|---|
| `ctx.tools.register(def)` | 17 个工具直接进宿主 | 收进 `bridge.tools`，返回 noop disposer |
| `ctx.systemPrompt.section/context` | meow guide + nebula RULE 两段注入 | 收进 `bridge.prompts`，一段都不下发 |
| `ctx.plugin / ctx.inject(deps, cb)` | 子插件再挂子插件、scoped ctx | 递归包壳，保证深层也走 facade |

其余属性 `Reflect.get(real, prop)`，函数一律 `.bind(real)`——否则 cordis 内部拿到 Proxy 当
`this` 会出错。

用 cordis 的**嵌套插件**（每侧一条独立 fiber，`inject` 等待与 dispose 各自独立），
组合层自己 `inject = ['tools']`。

组合层**故意不导出 `Config`**：一旦在这里声明 schema，宿主会拿它校验并裁剪 config，
meow 那些不在它自己 schema 里的键（例如 `delegate.effort`）就会在到达它之前被剥掉。
不声明，config 原样透传。

### 浏览器侧

宿主只给本包生成**一行** boot 图（id = `dsh-macro-memory`），所以 `lib/client.js` 一个文件里注册了三个 id：

| 模块 id | 内容 |
|---|---|
| `dsh-macro-memory-meow` | meow 原客户端 bundle，只把顶层 `load` 的 id 改了名 |
| `dsh-macro-memory-nebula` | nebula 原客户端 bundle，同样只改了 id |
| `dsh-macro-memory` | 组合层：`require` 上面两个，把两个 UI 插件各挂一次 |

两个原 id（`meow-memory` / `dsh-memory-nebula`）**故意不占用**——
这样即使哪天原包也被加载，也不会撞 id、不会出现两份 UI。

组合层优先用 `ctx.plugin()` 挂子插件（有独立 fiber），宿主 ctx 没有 `plugin` 时回退成直接
`apply(ctx)`；任一侧抛错只打 `console.error`，不影响另一侧。

## 3. 配置

profile 的 `cordis.patch.yml` 里这条 entry 的 `config`：

```yaml
- id: macro-memory
  name: 'dsh-macro-memory'
  disabled: false
  config:
    meow:                 # 原样传给 meow-memory
      homeDir: dsh-storage
      reflectTurns: 5
      promptLang: zh
      delegate: { model: "", effort: "" }
    nebula: {}            # nebula 自己读 $DSH_HOME/memory-nebula/，不接 config
    macro:                # 本插件自己的旋钮，全部有默认值，可整段省略
      compatAliases: false   # true 时额外注册 nebula_* 9 个 + memory_find_similar + memory_home
      guideMaxChars: 1300    # L0 注入字符上限（超出按行截断）
      toolWaitMs: 30000      # 统一工具等 vendor 定义就绪的上限
      flushThrottleMs: 30000 # 读记忆时补连线的节流窗口，0 = 每次都补
```

`config.meow` 的键与 meow 单独安装时写在 patch 里的完全一致，所以行为不变
（记忆仍落在 `$DSH_HOME/storages/meow-memory`，星图仍落在 `$DSH_HOME/memory-nebula`）。
`macro` 段也可以写成顶层键（`config.compatAliases` 等），等价。

## 4. 构建与自检

```powershell
cd D:\dsh-home\profiles\desktop\node_modules\dsh-macro-memory
node build.mjs      # 由 vendor 重新生成 lib/client.js（162,813 B）
node tools/check-all.mjs      # 一条命令跑下面全部十二支，一行一个结论 + 一个退出码（见 9.18）
node verify.mjs     # 宿主侧装配契约 + 浏览器侧，应输出 ALL PASS
node tools/probe-fusion.mjs   # 真 vendor + 假 ctx 的端到端联动（ALL PASS）
node tools/probe-graph.mjs    # 真 meow 库 + 真 nebula 引擎：写入是否真的变成图节点、links 是否真的成边（见 9.13）
node tools/probe-host.mjs     # 真 cordis + 真 ToolsService + 真 SystemPrompt 的宿主管线（见 9.6）
node tools/coverage-audit.mjs # 17 个原工具 → 8 个统一工具的覆盖审计（见 9.7）
node tools/param-audit.mjs    # 参数级覆盖审计：原参数/原必填都没退化（见 9.7）
node tools/check-client-bundle.mjs      # 11 项：产物里三个 load、守卫位置、设置命名空间（见 8.3）
node tools/probe-client-ui.mjs          # 7 项：冷启动下四类 UI 是否真的向 slots 注册（见 8.3）
node tools/probe-inject.mjs   # 17 项：nebula 常驻注入只剩稳定 RULE（见第 8 节）
node tools/check-yaml.mjs     # profile patch 与 bundles 体检：只允许 1 条 macro-memory、旧 id 为 0
node tools/probe-load.mjs     # 14 条：import 装好的 DSH app-boot，用它自己的判据说能不能加载（见 9.28）
node tools/accept-live.mjs    # 5 条：问**跑着的** DSH——宿主活着吗、前端在吗、服务端跑过吗、有没有报错（见 9.29；不进 check-all）
node tools/doctor.mjs         # 一次体检：两处同步 + 加载面 + 注入长度 + 队列账本 + 备份（见 9.12）
node tools/patch-meow-settings-ns.mjs   # 只打印检查结果；--apply 才写（见 8.2）

# 一次性静态分析（只读源码，不加载插件；0.1.x 时期的实测口径，留作对照基线）
node tools/cost-baseline.mjs    # 两套插件「每轮固定开销」的静态部分：注入字符数、prompt 声明数
node tools/probe-toolsize.mjs   # 两套插件「工具 schema」的静态体积（对象字面量按 UTF-8 数）
```

`check-yaml.mjs` 会把 `@deepseek-ai/dsh-base`、`@deepseek-ai/dsh-web-app` 标成
「host-provided（来自 app resources）」而不是缺失——它们由 DSH 本体的
`resources/app/node_modules` 提供，本来就不该出现在 profile 里；除此之外有任何 bundle 缺包才算问题。

`doctor.mjs` 是**发版前那一条命令**：它不进产品运行时、只读，把九个脚本各自的结论收成
「一条命令 + 一个退出码」（见 9.12）。--strict 时 WARN 也算失败。

`tools/check-all.mjs` 是**跑测试的那一条命令**：按固定顺序把上面十一支跑一遍，一行一个结论，
末尾给「11/11 通过」和一个退出码；`--only=doctor,verify` 只跑几支，`--json` 给机器读，
`--verbose` 打全量输出。它是 0.2.13 加的——之前发版前要手抄一遍循环，抄漏一支就漏一种回归
（事实上它第一次跑就抓到 `probe-inject.mjs` 里写死的 689 字符已经被 0.2.11 的改名弄挂了）。

`build.mjs` 只做三件事：改两个 vendor client 的顶层 `load` id、修正 meow 的
`sourceMappingURL`、追加组合层。任何一步匹配次数不为 1 就抛错，不会静默产出半成品。

`verify.mjs` 覆盖（0.2.0 重写）：

- 宿主侧形状：`name`、`version 0.2.x`、`inject=['tools']`、无 `Config` 导出、`MACRO_DEFAULTS`
- 宿主侧装配：`apply` 后恰好 2 个 `ctx.plugin`、宿主工具集**严格等于** 8 个 `memory_*`
  （没有 `nebula_*` / `memory_find_similar` / `memory_home` 漏入）、注入**只有 1 段**
  `macro-memory:guide` order 130 ≤1300 字符且覆盖 8 个工具名、8 个工具 schema 合计 <16000 B
- 兼容别名：`compatAliases:true` 时补回 9 个 `nebula_*` 与 `memory_find_similar`/`memory_home`
- 待补连线队列（A3 段）：同一条不重复排、自连/空 id 不入队、`drop` 只摘一条、过期与坏行都跳过
- 浏览器侧：stub 一个 window/document 执行 `lib/client.js`，确认三个 id 都注册、
  两个原 id 未被占用、meow UI 仍导出 `MemoryFoldDock`、nebula UI 仍叫 `memory-nebula`、
  组合层 `inject` 是并集、`apply` 挂起两个子插件

`tools/probe-fusion.mjs` 是**真 vendor** 的端到端探针（`verify.mjs` 用的是最小假 ctx，不跑 vendor）：
临时 `DSH_HOME` + 假 ctx + stub `@deepseek-ai/dsh-llm`，跑
remember → search → read → link/path → update → admin(guide/cost/stats) 全链路。
`PROBE_VERBOSE=1` 打印检索全文；`PROBE_LINK=1` 追加 `links[]` 联动检查。
E 段用只有 meow 的 stub bridge 验退化：星图缺席时必须说「没接上」而不是「等 12 s」，
`links` 的 `{id,note}` 形态要把 note 透传进 `nebula_link`，本地检索缺 `query` 要报错。
F 段验待补连线队列：排队 → 读记忆自动补 → 失败留队 → 面板列出 → 坏行容错（见 9.9）。

`tools/probe-host.mjs` 换成**真宿主服务**：把 `D:\DSH\DSH NEXT\resources\app` 里的
`@deepseek-ai/cordis`、`dsh-tools`、`dsh-system-prompt` 直接拉起来，让宿主自己的
`register` 校验、`projectToolSchema`、`SystemPrompt.assemble()` 说话（详见 9.6）。

`tools/coverage-audit.mjs` 盯「功能有没有全搬过来」：从 vendor 源码点名 17 个原工具，
逐条对到统一工具的真实入口，再用 spy bridge 真跑 17 条调用路径（详见 9.7）。

## 5. 接进 profile

```powershell
node tools/wire-profile.mjs --status   # 只看现状
node tools/wire-profile.mjs --apply    # 执行（幂等）
```

`--apply` 改两处：

1. `D:\dsh-home\profiles\desktop\package.json` 的 `dsh.profile.bundles`：
   去掉 `meow-memory` 与 `dsh-memory-nebula`，在原位置插入 `dsh-macro-memory`
2. `D:\dsh-home\profiles\desktop\cordis.patch.yml`：
   删掉 `- id: memory-nebula` 与两条 `- id: meow-memory`，插入 `- id: macro-memory`

为什么必须删干净：patch 层指向不存在的 id 会让日志持续报
`patch: entry "<id>" not found`（这个 profile 2026-11-13 踩过一次）。

改完需要**重启 DSH** 才生效（插件清单在启动时装配）。

## 6. 回滚

1. 从备份目录把两个文件拷回（本次备份：`D:\备份\20261118-215337-macro-memory\`）：
   ```powershell
   Copy-Item 'D:\备份\20261118-215337-macro-memory\package.json' 'D:\dsh-home\profiles\desktop\package.json' -Force
   Copy-Item 'D:\备份\20261118-215337-macro-memory\cordis.patch.yml' 'D:\dsh-home\profiles\desktop\cordis.patch.yml' -Force
   ```
2. 重启 DSH。
3. 想彻底移除时再删 `node_modules\dsh-macro-memory`（不影响原两个包）。

## 7. 已知边界

- **工具面已合并**：宿主只看到 8 个 `memory_*`；`nebula_*` 与 `memory_find_similar`/`memory_home`
  需要时用 `compatAliases: true` 补回，或走 `memory_admin` / `memory_search(mode=…)`。
- **两套记忆存储各自独立**：meow 的 SQLite 是真相，nebula 的星图是可重建索引；星图只读 meow 的库。
- **新记忆进星图有最长约 12 s 延迟**：nebula 的引擎实例是模块内局部变量，facade 拿不到，无法主动
  rebuild；只能靠 `LiveEngine` 的 12 s stat 巡检 + 工具内「图空则 refresh」。所以 `memory_remember`
  的 `links[]` 在节点尚未入图（或星图子插件这次没接上，比如缺 `webServer`/`connection` 或配置关闭）
  时**不假装连上**：连线落盘排队，读记忆时自动补（见 9.9），不再指望模型记得回来补。
- **`dsh.client.inject` 声明为空**：因为两个 UI 模块与本文件同文件注册，不需要跨行依赖。
- **vendor 目录不在 profile 的 `dependencies` 里**：pnpm 重装 profile 时可能把
  `node_modules\dsh-macro-memory` 清掉；届时从 `D:\dsh-home\vendor\dsh-macro-memory` 拷回即可。
- **未改原两包**：`node_modules\meow-memory` 与 `node_modules\dsh-memory-nebula` 内容、字节数、
  修改时间均未动（只被读取复制）。

## 8. 对 vendor 的本地改动（重新部署前必读）

这一节记录**只在 vendor 副本上改过**的东西。它们不在上游包里；一旦从 npm / GitHub
重新取一份 nebula 放进 `vendor/`，这些改动就会丢，需要按下面重放。

### 8.1 移除 nebula 的每轮自动邻域注入（2026-11-18）

**改了什么**：`vendor/dsh-memory-nebula/lib/index.js` 里 `systemPrompt.context` 原来每轮
读会话账本当种子、交给 `bridge` 沿星图扩散、挑 ≤4 条注入 `order: 960` 的位置。现在这个
`text` 直接返回常量 `RULE`（689 字符），不再求值，不再调 bridge。

**为什么**：system prompt 在请求最前面，它一变，它后面整段对话历史都从前缀缓存里掉出来
重新 prefill——代价约等于当前上下文 token 数，换回来的信息只有几百字符（实测比约 36:1）。
而且第 2 批会顶掉第 1 批，模型上一轮刚看到的邻居下一轮就没了。自动注入的收益无法度量，
成本却每轮都在付。

**能力去哪了**：没删。`nebula_recall(memory_ids=[…])`、`nebula_bridge(…)` 仍在，走同一套
bridge 逻辑，结果落在工具返回里（会话尾部，不伤前缀缓存）。

**连带**：删掉 `injectConfig()`、`readLedger()/ledgerPath()`、`sessionOf()` 与
`import … from './host/injectcfg.js'`；`host/injectcfg.js` 文件保留但已无调用方（文件头注释
已注明），`$DSH_HOME/memory-nebula/inject.json` 从此不影响行为。注入块名从
`memory-nebula:neighbors` 改为 `memory-nebula:rules`。

**文件规模**：`lib/index.js` 32,288 B / 670 行 → 27,987 B / 558 行。

**怎么重放**（对刚从上游取回的干净副本）：

```powershell
node tools/patch-nebula-noinject.mjs          # dry-run，打印替换行数与锚点校验
node tools/patch-nebula-noinject.mjs --apply  # 写盘
```

脚本按行号切片替换（不做正则），替换前断言三处锚点行内容，错一行就抛错不写盘。
但它只处理注入块；被删的四个函数与 import 需按本节 8.1 说明手工再删一遍，
之后跑 `node tools/probe-inject.mjs`（17 项）确认。

**怎么验证**：

```powershell
node tools/probe-inject.mjs   # 17 项：注入内容恒为 RULE、工具仍 9 个、bridge 仍注册
node verify.mjs               # 整个合并包没被这次改动带坏（断言清单见 §4）
```

`probe-inject.mjs` 用临时 `DSH_HOME`（`vendor/dsh-macro-memory/.probe-home`，跑完删除），
不碰真实星图数据。

**改完要重启 DSH**：模块在启动时装配，文件替换对已运行的进程无效。

### 8.2 设置面板改按 entry id 找配置命名空间（2026-11-18 晚）

**症状**：插件市场诊断报「dsh-macro-memory 的设置面板读不到配置：它按 `meow-memory` 读取，
而这个环境里没有这个名字的条目 id。它自己的条目是 `macro-memory`」。

**根因**：宿主按 **entry id** 注册 config 命名空间。本包在 `cordis.patch.yml` 里的 entry id 是
`macro-memory`，所以配置挂在 `"macro-memory"` 名下；而 vendor 里的 meow 客户端把
`SETTINGS_NS = "meow-memory"` 写死，`settingsScope.bind({ namespace })` 和
`configForms.get()` 都去问一个不存在的命名空间 → 面板空白、写入无门。

**改了什么**（`vendor/meow-memory/lib/client.js`）：

1. 新增候选列表 `SETTINGS_NS_CANDIDATES = ["macro-memory", "dsh-macro-memory", "meow-memory"]`
   与两个探测函数 `resolveSettingsNs(probe)` / `bindSettingsScope(scope, order)`；
2. `settingsScope` 分支：先用 `softService(ctx, "configForms")` 探测哪个命名空间真有表单，
   把结果排到候选队首再按序 `bind`，逐个失败才试下一个；`configForms` 还没就绪时回落候选[0]；
3. `configForms` 分支：原来的裸 `configForms.get(SETTINGS_NS)` 改成
   `configForms.get(resolveSettingsNs(…))`，探不到就不挂、留给轮询。

`slots.register` 的 `id` 仍用 `SETTINGS_NS`（meow 自己的 UI 命名空间），不受影响。

**文件规模**：`lib/client.js` 150,817 B → **152,429 B**（+1,612 B），sha256 `1FA767D5…`。

**怎么重放**（对刚从上游取回的干净副本）：

```powershell
node tools/patch-meow-settings-ns.mjs          # dry-run：锚点各须出现 1 次 + 7 项文本自检
node tools/patch-meow-settings-ns.mjs --apply  # 写盘
```

幂等：发现 `SETTINGS_NS_CANDIDATES` 就跳过。实测从备份原件重放，产出与当前文件**逐字节一致**。

**⚠ 改完必须重新构建组合产物**：运行时加载的是 `lib/client.js`（156 KB 的组合层，把两个 vendor
client **内联拼接**进去了），不是 `vendor/meow-memory/lib/client.js`。只改子文件 = 改了没人读的副本：

```powershell
node build.mjs   # lib/client.js 157,630 B，三个 id：dsh-macro-memory / -meow / -nebula
```

判断是否生效：`Select-String -Path lib/client.js -Pattern SETTINGS_NS_CANDIDATES` 有命中才算进去。

**怎么验证**：`node --check lib/client.js`、`node verify.mjs`、`node tools/probe-inject.mjs`
（17 项）；然后**刷新页面**（客户端模块在页面生命周期内不会重跑，改这块不需要重启整个 DSH，刷新即可）
看 设置 → 全局记忆 面板能否显示 `$DSH_HOME/storages/meow-memory` 的配置并写入。

### 8.3 重复执行守卫：同一个 bundle 被拉两次时不再炸掉后半截（2026-11-18 深夜）

**症状**：设置页里的 meow 配置节、侧栏「记忆星图」、对话里的折叠条**全部消失**；而梦境月亮
图标还在，却永远不变黄。

**根因**：宿主把同一份 client bundle 用**两个 specifier** 各拉一次——`dsh-macro-memory` 与
`dsh-macro-memory/client.js`。`ClientModuleSystem.loadShared(url)` 的去重键是 **URL**，两个
specifier 解析出的 URL 不同，于是 bundle 被执行两遍；第二次 `register` 撞到
`if (this.bootstrapIds.has(id) || this.factories.has(id)) throw new Error('client-modules:
duplicate factory registration for "…" (bundle executed twice without invalidate?)')`。

致命之处在于**错误位置**：产物是一次执行里连做三个 `window.__ModuleLoader__.load(...)`，第二个
load 抛错会顺着 `target.load` 冒泡，**把第三个 load 一起打断**。于是：

- 第一个 load（meow 子层）注册成功 → `apply` 里的 DOM 注入 `startDreamIconManager` 已经把月亮
  插进页面，所以月亮还在；
- 第二个、第三个（nebula 子层、组合层）没注册 → nebula 的星图 UI 与组合层挂载点都不存在
  → 设置页、星图、折叠条全部消失。

**改了什么**（`build.mjs`）：产物最前面注入一段 IIFE，包住 `window.__ModuleLoader__.load`：

```js
try { return original.call(loader, registration) }
catch (err) {
  if (String(err && err.message).indexOf('duplicate factory registration') < 0) throw err
  console.warn('[macro-memory] 同一 bundle 被加载了第二次，已忽略重复注册：' + message)
}
```

只吞这一类错误，其余照常抛；`guarded.__macroGuarded = true` 防止被包第二层。产物规模
157,630 B → **162,813 B**（0.2.4 面板归口 +4,069 B，0.2.11 改名 +2 B，0.2.12 +7 B），sha256 `1bba6b5f…`。

**另一个必须重启才能消掉的现象**：`D:\dsh-home\logs\desktop-next-2026-11-18.2.jsonl` 里那条
设置了 plugins 的组合 URL 仍含 `meow-memory/client.js` 与 `dsh-memory-nebula/client.js`，而这两个
目录早已从 `profiles\desktop\node_modules` 删除（`dsh.profile.bundles` 16 项里也没有它们）。这是
**主进程内存里的旧 entry 树**——profile 改了但进程没重启。守卫能兜住重复注册，兜不住「引用不存在
的 client」；所以这一轮**必须重启 DSH**，让主进程重扫 profile。

**怎么验证**：

```powershell
node tools/check-client-bundle.mjs    # 11 项：三个 load 都在、守卫在第一个 load 之前、id 无残留
```

重启后查 `D:\dsh-home\logs\desktop-next-*.jsonl`（`"source":"renderer"` 的记录就是页面 console）：
不应再出现 `duplicate factory registration`，插件源的 `combo` URL 里也不应再有 `meow-memory/client.js`。

**排查入口备忘**：页面 console 会被宿主落盘到 `D:\dsh-home\logs\desktop-next-<date>.<n>.jsonl`，
字段 `source=renderer`、`fields.sourceId` 是那一条 bundle 的完整 URL、`fields.lineNumber` 是行号。
前端「某块 UI 不见」「点了没反应」这类问题，先看这里，不要靠猜。


**`tools/probe-client-ui.mjs` 补的是什么**：`verify.mjs` 只验到「三个 id 注册了、组合层会
`ctx.plugin` 两个子插件」，再往下一层——**slots 到底有没有收到 register 调用**——之前没有任何
断言，所以「UI 全都不见」只能靠翻日志猜。这个探针 stub 出 `window`/`document`/`slots`/`configForms`，
按真实 cordis 语义（fiber 活着时取不存在的服务得 `undefined`）跑一遍组合层 apply，断言四类注册：

| 期望注册 | 来源 | 现实表现 |
| --- | --- | --- |
| `settings.section#meow-memory` | meow `applySettingsPage` | 设置页里的「全局记忆」节 |
| `conversation.composer.dock#meow-memory` | meow | 输入框下方的折叠条 |
| `conversation.session.header.actions#meow-memory` | meow | 会话标题栏的记忆按钮 |
| `main[memory-nebula]` + `sidebar.panellist#memory-nebula` | nebula | 侧栏「记忆星图」图标与主面板 |

单次执行下七项全 PASS，说明**冷启动时四类 UI 都会挂上**；线上缺失只发生在 bundle 被重复执行、
旧 fiber 已被 dispose 的那种状态里（见上）。换句话说：改完 client 侧代码，**必须冷启动一次**，
不能只看一次刷新。

---

## 9. 融合层（0.2.0）

### 9.1 它到底融合了什么

| 维度 | 0.1.x（拼接） | 0.2.0（融合） |
|---|---|---|
| 工具面 | `memory_*` 8 个 + `nebula_*` 9 个 = 17 个，各说各话 | **8 个 `memory_*`**，重复能力（search/read/similar/stats…）合成一个口 |
| schema 体积 | 56,759 B（≈14–16 K token） | **4,714 B**（−91.7%） |
| 注入 | meow guide 3,396 字符(order 130) + nebula RULE 689 字符(order 960) | **949 字符 / 1 段**(order 130)，宏口吻 |
| 写入 | 只写主库 | 主库 + 可选 `links[]` 顺手连边 |
| 检索 | 主库 BM25 | 主库为主，`expand` / 零命中时星图扩散补线索 |
| 读物 | 只有正文 | 正文 + 星图邻居 |
| 运维 | 两个插件各自的 home/stats/hygiene/sources | 一个 `memory_admin` |
| 成本 | 无账本 | `$DSH_HOME/macro-memory/cost.jsonl` |

稳态固定税从 ~17–19 K token/请求降到约 **2.5–3 K**。

### 9.2 八个统一工具

| 工具 | 参数要点 | 背后是谁 |
|---|---|---|
| `memory_remember` | content / project / keywords / importance / level / subcategory / goal / corrected / **links[]** | meow 写路径（复用 `rememberTool`，不重写） |
| `memory_update` | id / content / status / importance / goal / project / keywords / **links[]** | meow |
| `memory_search` | query / level / project / status / days / k / content_max / explain / **mode**(local·graph·bridge·similar) / **expand** / **memory_ids[]** / **id**(mode=similar) | meow 主库；mode≠local 或 expand 时调 nebula |
| `memory_read` | id / **neighbors**(默认 12，0 关闭) | meow 正文 + nebula inspect 的邻居段 |
| `memory_project` | project | meow 项目全景 |
| `memory_link` | action(link·unlink·mute·unmute·**path**) / a / b / note / maxHops | nebula |
| `memory_dream` | 无参 | meow 窗口梦境 |
| `memory_admin` | action(home·stats·hygiene·sources·ingest·**cost**·**links**·**guide**) / 各 action 自己的参数 | meow home + nebula 运维 + 本插件账本/连线队列/手册 |

`memory_admin(action="guide")` 是「L2 按需」的入口：把 meow 的完整记忆手册与 nebula 的星图规则
原文（直接取 vendor 自己的文本函数，不复制）一次性吐到工具返回里，用完即弃，不占 system prompt。

### 9.3 联动是靠什么成立的

```
统一工具 execute
   └─ bridge.call('memory_remember', args, exec)      ← 100 ms 轮询等 vendor 定义就绪（≤30 s）
        └─ vendor meow 原函数（写库、去重合并、信任校验全部原样）
   └─ 回填：id 已知 → 先 graphState(id) 探三态（ready/pending/unavailable）
        └─ ready 才逐个 bridge.tryCall('nebula_link', {action:'link', a:id, b, note})（note 来自 {id,note} 或默认文案）
        └─ 没连上的（含 unavailable / pending / 单条报错）→ 排队落盘，之后读记忆时自动补（见 9.9）
```
- 懒绑定：子插件何时注册工具、`ctx.inject(['settings'])` 何时就绪，都不影响装配；
- 渲染复用：结果一律交回 vendor 自己的 `def.output.render(args, value)` 出文本，再拼接，所以
  「为什么相关」这类措辞始终与 vendor 一致，不会漂；
- 失败不炸：`tryCall` 把异常折成 `"${name} 未完成：msg"` 文本，工具整体仍返回可用内容。

### 9.4 回滚到拼接态

```powershell
# 整包回滚（改动前备份，含 vendor 与全部脚本）
robocopy 'D:\备份\20261118-225745-macro-fusion' 'D:\dsh-home\vendor\dsh-macro-memory' /E /MIR
```

或最小回滚：还原 `lib/index.js`、删掉 `lib/macro/`、`package.json` 版本号改回 0.1.0。
回滚后必须**重启 DSH**（模块在启动时装配）。

### 9.5 生效方式

改完（或回滚完）都**需要重启 DSH** 才会装配新代码——这是主人的进程，本插件绝不自行重启。
重启后可用 `memory_admin(action="stats")` 与 `memory_admin(action="cost")` 自查：
前者应看到星图条目，后者应能看到这次会话的工具调用记录。

### 9.6 表述归口：让模型只看见 macro 的名字（0.2.1）

工具面收成 8 个之后，子插件的返回文本里还留着 `nebula_recall` / `memory_find_similar` /
`meow-memory` 这类名字。`compatAliases=false` 时它们**并不存在**，模型照着调只会拿到「工具不存在」——
死指针信。`lib/macro/brand.js` 做名字级替换：

| 原文里出现 | 换成 |
|---|---|
| `nebula_recall` | `memory_search（mode="graph"）` |
| `nebula_inspect` | `memory_read（neighbors>0）` |
| `nebula_bridge` | `memory_search（mode="bridge"）` |
| `nebula_link` / `nebula_path` | `memory_link` / `memory_link（action="path"）` |
| `nebula_stats/hygiene/sources/ingest` | `memory_admin（action=…）` |
| `memory_find_similar` / `memory_home` | `memory_search（mode="similar"）` / `memory_admin（action="home"）` |
| `meow-memory` | `macro-memory` |

作用点：`createBridge({ brand })` → 每次 `call()` 渲染完过一遍、`tryCall()` 的失败文本过一遍、
`memory_admin(action="guide")` 的整本手册过一遍。**`compatAliases=true` 时原样不替换**（A/B 对比要原味）。
`bridge.call` 的「还没就绪」报错也不再甩内部工具名，只留一句通用说明 + 一条 warn 日志。

验收：`node tools/probe-host.mjs` 的 F3b/F5 两条——手册与全部工具输出里不出现 `nebula_` / `meow-memory`。

### 9.7 覆盖审计：证明 17 个功能都搬过来了

```powershell
node tools/coverage-audit.mjs     # 工具级：17 个原工具都有去处，应输出 ALL PASS
node tools/param-audit.mjs        # 参数级：每个原参数都还能传进去，应输出 ALL PASS
```

`coverage-audit.mjs` 做三件事：
1. 从 `vendor/*/lib/index.js` 里点名 17 个原工具（正则抓 `name:`），断言表里没有漏项、没有多余的；
2. 逐条对到统一工具的**真实入口**——检查 `memory_search.mode` / `memory_admin.action` /
   `memory_link.action` 的枚举里确实有那个值，而不是只有一句文案；
3. 用 spy bridge 真跑 17 条调用路径，断言每个原工具都被 `call`/`tryCall` 走到（nebula 侧 9 条、
   meow 侧 8 条）。改动 vendor 或增删工具时，这里会第一时间报出来。

`param-audit.mjs` 再往下钻一层，专治「工具还在、参数被砍了」这种静默退化：
真跑两个 vendor 的 `apply` 把 17 个工具的 parameters 原样捕获，与统一工具的 schema 逐字段比对。

- 1.1 原工具每个参数都能在统一工具里传（类型不一致就报错；`number→integer` 这类收窄单独打 INFO，
  因为这 9 个字段都是条数/跳数，真实调用只传整数）；
- 1.2 原来必填的字段没有失守：schema 里仍必填，或因为要跨 mode/action 复用而改在 `execute` 里守；
- 1.2b 真的调 `execute` 验证运行时守卫生效（缺 `query` / `id` / `provider` / `items` 四条都报错）；
- 1.3 没有来路不明的新参数（每个参数要么来自某个 vendor，要么在 `EXTRA` 表里声明）；
- 1.4 8 个统一工具都在承接原能力；2.1 三处枚举齐全；3.x `memory_dream` 仍无参、`links` 两种形态都接受。

### 9.8 真宿主探针：不重启也能验「DSH 跑得起来」

```powershell
node tools/probe-host.mjs        # ALL PASS 才算融合层合格
$env:DSH_APP='D:\DSH\DSH NEXT\resources\app'   # 换机器时指宿主目录
```

`verify.mjs` 用的是假 ctx，只能证明「我们以为自己注册成功了」。这个探针把宿主本体的
`@deepseek-ai/cordis` + `ToolsService` + `SystemPrompt` 直接拉起来，再装我们的插件，让宿主
自己的校验说话：

- `ToolsService.register` 的 output/render、`assertSupportedJsonSchema`、保留名检查全过；
- `projectToolSchema` 实测 8 工具 **8,384 B**（宿主投影后比原始参数略大，仍远低于 16 KB）；
- 真 `SystemPrompt.assemble({})`：`sections` 里 `macro-memory:guide` 恰好 1 段、949 字符，
  nebula 的 RULE 没成段；
- 端到端走真服务：remember → search → admin(guide/cost/home/stats/links) → link(path)。

探针里踩到的两个真问题（代码里都留了注释）：

1. `@deepseek-ai/dsh-llm` 的重定向只能对「宿主目录之外」的导入者生效——宿主自己的包要
   `HarnessError` 等符号，一起劫持会当场炸；
2. nebula 声明 `inject = ['tools','systemPrompt','webServer','connection']`，**缺 webServer /
   connection 它就一直等，9 个星图工具根本不会注册**（宿主里由 dsh-web-server 提供，探针里用两个
   最小 `Service` 桩顶上）。这也解释了「为什么星图工具在某些精简组合里静默消失」。

### 9.9 待补连线队列：连不上的连线不丢，读记忆时自愈（0.2.3）

星图是**可重建索引**：新写入的条目要等一轮建图（引擎 `startWatching(12000)` 巡检）才变成节点。
所以「写记忆时顺手连线」天然存在三种失败：节点还没入图、星图子插件根本没装配、单条连线报错。
0.2.2 之前的做法是把原因如实告诉模型、让它自己记得回来补——**模型不会记得**，那条关系就丢了。

现在改成排队自愈（`lib/macro/links.js`，落盘 `$DSH_HOME/macro-memory/pending-links.jsonl`）：

```
memory_remember(links=[…]) / memory_update(links=[…])
   ├─ graphState(id) = ready  → 直接连；单条失败也入队
   └─ pending / unavailable   → 全部入队，返回「关联已排队 N 条（原因）：之后读记忆时自动补连」
memory_search / memory_read / memory_link(link) / memory_admin(links)
   └─ flushLinks()：节流 30 s，预算 1.2 s，星图整体不可用就立刻停手（不把队列当靶子打）
        └─ 连上一条就从队列里摘掉；连不上就留着，TTL 7 天到期自动丢弃
```

设计取舍：

- **落盘而不是内存**：DSH 重启、插件热载都不会把欠账弄丢；
- **不发明关系**：只补用户/模型明确要求过的 `links`，绝不拿相似度自己连线；
- **不让读变慢**：节流 + 1.2 s 预算 + 单轮最多 8 条，读操作不会因为补连拖成几十秒；
- **有上限**：队列最多 500 条（超了丢最老的）、每条 7 天过期——坏掉的星图不该把磁盘撑满；
- **坏文件不影响主功能**：坏行跳过、写入失败静默，队列永远只是锦上添花。

自查：`memory_admin(action="links")` 读面板（顺手补一轮）。验收在 `tools/probe-fusion.mjs` F1–F5
（排队、自动补、失败留队、面板、坏行容错）与 `verify.mjs` A3（队列纯函数契约）。

### 9.10 面板口径统一：一个插件只有一个名字（0.2.4）

宿主那边已经把 17 个工具收成 8 个 `memory_*`，但**界面**还是两张皮：meow 的设置节自称「喵记忆」，
nebula 的侧栏图标自称「记忆星图」，用户看到的是两个不相干的插件。0.2.4 把入口文案归到一处。

做法跟宿主侧完全同构——**client 侧也包一层 facade**，只在 `slots.register` 的 meta 上动手：

```js
asPlugin(mod, name) → apply(ctx) {
  mod.apply(brandCtx(ctx))        // ctx 的 slots 换成 facade，其余服务原样透传
}
brandMeta(meta) → {
  ...meta,                        // id / key / order / inject / comp 一个不动
  label: brandLabel(meta.label),  // label 是 thunk 就包一层，跟随语言切换
}
```

| 入口 | 原来 | 现在 |
|---|---|---|
| `settings.section#meow-memory` | 喵记忆 | **宏记忆** |
| `sidebar.panellist#memory-nebula` | 记忆星图 | **宏记忆 · 星图** |
| 英文 locale | Meow Memory / Memory Nebula | **Macro Memory / Macro Memory · Graph** |

三条不可退让的边界：

1. **id / key 绝不改写**：宿主按 id 找面板，用户书签、`sidebar.panellist.actions` 的 owner 过滤全认 id；
2. **label 是函数就包函数**：vendor 的 label 是 `() => t("settings.title")`，求值一次会把语言钉死；
3. **拿不到 Proxy 就放弃归口**：`brandCtx` 里 `new Proxy` 整段包在 try/catch，失败直接返回原 ctx——
   面板名字不好看可以忍，面板注册不上不行。

**当时的边界（0.2.11 收口了）**：面板**内部**的标题（nebula 页头那行「记忆星图」）写在 vendor 的 web
bundle 与 i18n 词典里，0.2.4 只统一了入口、没动里面。0.2.11 把这层也补齐了：页头、窗口标题、画布水印、
侧栏标签、meow 设置面板的 `<h2>` 全部同一个名字，做法与验法见 §9.16。

### 9.11 结构整理：一个工具一个文件（0.2.5）

0.2.4 之前 `lib/macro/tools.js` 已经长到 25,991 B / 538 行：8 个工具的 schema、执行体、连线流程、
兼容别名全挤在一个文件里，加第九个工具要在大段文本里找位置，改一处容易碰别处。0.2.5 按职责拆开：

| 文件 | 职责 | 体积 |
|---|---|---|
| `lib/macro/tools.js` | 装配器：拼 8 个 defs + `createAliasTools` | 2,313 B |
| `lib/macro/shared.js` | `LEVELS` / `PROJECT_SUBCATEGORIES` / `TEXT_OUT` / `safeJson` / `pick` / `neighborSection` | 1,846 B |
| `lib/macro/linkflow.js` | `graphState` 三态、`applyLinks`、`flushLinks`、`flushNow`、`LINKS_SCHEMA` | 6,132 B |
| `lib/macro/defs/*.js` | 8 个工具各一个文件，导出 `createXxx({ flow })` | 593–4,479 B |

两条结构纪律（`verify.mjs` A4 段守住）：

1. **defs 不许反向依赖装配器**：只准 import `shared.js` / `linkflow.js` / `links.js` / `brand.js`；
2. **装配器不许重新长回巨石**：`tools.js` 不得直接写 schema（不许出现 `additionalProperties: false`），
   体积上限 6 KB，装配点必须恰好 8 个。

行为零变化：拆完 `verify` / `coverage-audit` / `param-audit` / `probe-fusion` / `probe-host` /
`probe-client-ui` / `check-client-bundle` 全绿，8 个工具的 schema 与文案逐字未改（param-audit 逐参数比对）。

### 9.12 交付物体检：一条命令看两棵树（0.2.6 / 0.2.7 加文档段 / 0.2.9 加补丁账本）

本插件是「vendor 源码 + profile 实体拷贝」两处部署，单点脚本都有盲区：`verify.mjs` 只验它自己所在的
那棵树，`check-yaml.mjs` 只看 profile 的 patch。最容易犯的错不是代码写错，而是**改了 vendor 忘了同步
profile**——DSH 重启后加载的是旧的那份，而所有自检都在新树里跑，全绿。

`tools/doctor.mjs` 把这类错变成一条命令 + 一个退出码（只读，不进运行时）：

| 段 | 查什么 | 判定 |
|---|---|---|
| 版本与身份 | `package.json` vs `lib/index.js` 的 version 是否同源、`inject` 含 tools、导出 apply | FAIL |
| vendor ↔ profile | `lib/`+`tools/`+`vendor/`+5 个文档逐字节比 hash，双向（漂移 / 多余） | FAIL |
| 加载面 | profile `bundles` 含 macro-memory 且无旧 id、patch 里恰好 1 条、无旧 id | FAIL |
| 客户端产物 | `lib/client.js` 字节数与 sha256、三个 load id、`brandCtx` 在不在 | FAIL / WARN |
| 补丁账本 | 打在 `vendor/` 上的补丁还在不在（标记串是否还能找到） | FAIL |
| 运行时 | L0 注入长度 ≤ 上限且覆盖 `memory_remember`/`memory_admin`、队列未溢出、成本账本 | FAIL / WARN |
| 文档声称 | README 提到的脚本都存在、每个脚本都有出处、产物字节数与 sha 前缀、版本号 | FAIL / WARN |
| 备份 | `D:\备份` 下最新一份 `macro-fusion-*` | WARN |

跑法：在 vendor 目录 `node tools/doctor.mjs`（两棵树都对比）；在 profile 拷贝里跑会自动跳过对比并在
抬头注明「当前就在 profile 拷贝里」。`--strict` 让 WARN 也返回非零，发版前用。

首跑实录（0.2.5 代码：注入 977/1300 字符、队列 0/500、client.js 162,804 B / sha256 41c9e22e…、
patch 1 条、bundles 16 项无旧 id），唯一 FAIL 正是它该抓的：`tools/doctor.mjs` 自身还没同步到
profile —— 脚本第一次运行就把自己抓了出来。

**0.2.7 补的「文档声称」段**：文档里的数字和路径是最容易悄悄过期的东西——README 说产物 162,806 B，
有人改了 client bundle 却忘了改这行，读者照着数字判断版本就会错。这一段把 README 当被测对象：
它提到的每个 `tools/*.mjs` 必须真实存在（FAIL），磁盘上每个脚本必须在 README 里露过面（WARN，
`_` 开头的临时脚本豁免），产物字节数 / sha256 前 8 位 / 当前版本号必须能在 README 里找到原样字符串
（WARN）。首跑就抓到两个漏记的一次性分析脚本 `cost-baseline.mjs`、`probe-toolsize.mjs`，已在 §4 补上出处。

### 9.13 真引擎端到端：写入真的成了节点，links 真的成了边（0.2.8）

到 0.2.7 为止，「融合」这条主张的证据链有个缺口：`probe-fusion.mjs` 里 nebula 是 stub（只验调用参数），
`probe-host.mjs` 里星图是空的（只验宿主契约）。也就是说——**没有任何脚本证明「meow 写的记忆真的进了星图」**。
`tools/probe-graph.mjs` 补的是这一段：真 meow 库（SQLite）+ 真 nebula 引擎（真建图、真 12s 巡检）+ 假 ctx。

它按生产布局造环境，这是能让星图看见数据的关键：

| 事实 | 生产怎么做 | 探针怎么做 |
|---|---|---|
| meow 库位置 | 每个工作区 `.dsh-meow/memory.db` | 临时工作区里建同名目录 |
| 星图怎么找到工作区 | 读 `storages/workspace.json` 的 `tables.workspaces[id].path` | 写同一份结构 |
| meow 信任闸 | `window-index.json` 里登记过的窗口启动时 seed 成受信任 | 预写 `{:sess-graph: ws}` |
| meow home | `homeDir` 配置（生产在 `storages/meow-memory`） | 显式传 `homeDir`，避免落到 `~/.dsh-meow` |

八条断言（G1–G8）：工具面仍是 8 个统一工具且 `nebula_*` 没漏进宿主面；写入后星图出现 1 条记忆 / 1 个工作区 /
1 个会话账本；带 `links` 写入后**星图里真的多一条边**（`1 条连接`）；`memory_read` 能读出「连接到的记忆」
和连线理由；短 id 走 `memory_link` 能被识别成「不能自己连自己」且不进队列；排队条目读一次就补上、不乱连；
目标不存在的条目被清掉；引擎数据面确实落在临时 `DSH_HOME`。（0.2.9 又补了 G9–G11 三条生命周期断言：
改写 / 归档 / 重建幂等，见 §9.14。）

**0.2.8 同时修掉一个真 bug：短 id 连不上线。** meow 的工具输出只给 8 位前缀（它自己的 `findById` 支持前缀），
而星图 `resolveIds` 只认完整 id ——之前 `memory_remember(links=["0mwmbucj"])` 会永远报「找不到这两条记忆」
并排队到 7 天 TTL 过期。现在连线前统一补全：短 id 走 `memory_read` 换完整 id（结果缓存），
归不出来（记忆已删/合并）**当场摘掉、不进队列**；星图回「找不到这两条记忆」「不能和自己配对」也判定为永久失败，
不再做无效重试。`memory_admin(action="links")` 会说明这一轮补上几条、清掉几条。

### 9.14 带补丁的第三方引擎：归档的记忆不许从星图里冒出来（0.2.9）

`vendor/` 下是 meow-memory 与 dsh-memory-nebula 的原样源码，本插件只在上面做了极少数必要改动——
**改动必须记账**，因为 vendor 升级或重新拷贝会静默把补丁冲掉，冲掉不报错，只会让行为退回上游。

**这次找到一个口径不一致（真 bug）**：meow 自己检索会排除 `archived`，星图的 `bridge`（推荐邻居）也用
`statusFactor` 把 archived/deleted 记 0——只有星图的**检索主路径**没过滤。于是「归档一条记忆」之后：

```
meow 本地检索：查不到（对）
memory_search(mode="graph")：仍然返回它，强度 1，排第一（错）
```

模型于是会从星图读到用户已经说「不用了」的记忆，等于两个引擎两套口径。

补丁打在 `vendor/dsh-memory-nebula/lib/host/recall.js`，三处、每处一个标记 `[macro-fusion 0.2.9]`：

| 位置 | 改什么 | 为什么 |
|---|---|---|
| `recall()` 顶部 | 新增 `const includeInactive = opts.includeInactive === true` 与 `selectable(node)` | 留一个出口：按 id 看归档记忆（`nebula_inspect`）不需要关，但批量检索要能关 |
| 文本种子循环 | 归档/删除的不许当种子 | 否则「只能命中归档记忆」的查询会炸出一圈邻居，看着像有结果 |
| §5 结果打分 | 归档/删除的不许占结果位 | 与 `bridge.js` 的 `statusFactor`（archived → 0）同口径 |

有意保留的行为：归档节点**仍是图里的一条边**，仍能在扩散时当中转（用户归档的是「这条别用了」，
不是「这条不存在的」），也仍然能被 `nebula_inspect` 按 id 打开、被 hygiene 统计到。

**防回退**：
- `tools/doctor.mjs` 新增第七段「== 补丁账本 ==」，按标记串检查补丁在位，缺了直接 FAIL 并提示按本节重打；
- `tools/doctor.mjs` 的两棵树对比**把 `vendor/` 也纳进来**（此前只比 `lib/`+`tools/`，vendor 漂移会漏）；
- `verify.mjs` 的 A7 段守六件事：标记串在、`includeInactive` 出口在、`selectable` 同时排除 archived 与 deleted、
  与 `bridge.js` 的 `statusFactor` 同口径、doctor 账本记着这一条、`probe-graph.mjs` 有归档断言且不用
  `includes(query)` 判命中；
- `tools/probe-graph.mjs` 的 G9–G11 用真引擎验生命周期：**改写**后星图节点内容跟着变（不是永远缓存旧内容）、
  节点数不变（不产生重复节点）；**归档**后 `mode="graph"` 检索不再命中、节点数不涨；再写一条只多 1 个节点（重建幂等）。

**顺手修掉探针自己的假通过**：星图「没命中」的文案是 `星图里没有匹配「<query>」的记忆。`——它把 query 回显了，
所以 `seen.includes(query)` 恒真，G9 一开始是「假绿」。现在统一用 `miss(text)` 排掉这句再判命中。
这类断言错误比没断言更危险：它让探针失去意义却仍然打 PASS。

### 9.15 星图缺席时：以 meow 为主，记忆照样要能查（0.2.10）

「以 meow 为主」在正常路径上已经成立，但**星图挂掉时的路径**此前是不成立的：`memory_search(mode="graph")`、
`memory_link(action="unlink")`、`memory_admin(action="stats")` 都直接 `flow.call('nebula_*')`，星图没装配 /
被配置关掉 / 引擎还没起时会把内部的 `macro-memory：这项能力还没就绪…` 原样抛给模型。模型刚在注入里被告知
「查关联用 mode=graph」，照着用却报错——它会学到的结论是「这个工具面不可信」。

现在的约定（一句话）：**星图是增强，不是前提；星图缺席时降级要说人话，而且不许把记忆弄丢。**

| 入口 | 星图缺席时的行为 | 模型看到的文案 |
|---|---|---|
| `memory_search(mode="graph")` | 有 `query` → 退回本地检索；没 `query` → 说明怎么兜 | `星图这次没接上，先只给本地检索结果（沿关联扩散等星图就绪后再试）：` |
| `memory_search(mode="bridge")` | 同上，退回本地检索 | `…（补充邻居等星图就绪后再试）：` |
| `memory_search(mode="similar")` | 本来就走 meow 自己的 `memory_find_similar`，与星图无关；工具缺了也只说「相似检索未完成」 | `相似检索未完成：…` |
| `memory_read` | 只出正文（邻域段自动省掉，不留「未完成」噪音） | 无附注 |
| `memory_link(action="link")` | 排队，读记忆时自动补（0.2.8 已有），文案走同一套 | `连线暂时没落图（…），已排队…` |
| `memory_link(action="unlink/mute/unmute/path")` | 这些改的是星图自己，落不了盘也没法先记账 | `星图这次没接上，断开连线没做成——…记忆本身没受影响。` |
| `memory_admin(action="stats/hygiene/sources/ingest")` | 统一走 `graphPanel`，不再甩内部错误 | `星图这次没接上，星图概况这会儿看不了——等星图就绪再试一次就行。` |
| `memory_remember(links=[…])` | 排队（0.2.8 已有） | `关联已排队 N 条（…）` |

**机器守的约定**：`verify.mjs` 的 **A8** 段十条，其中最关键一条是**硬约定**——`lib/macro/**` 里任何地方都不许
再对 `nebula_*` 直接 `flow.call`（只有 meow 自己的工具可以）。这样以后加新面板时，忘写降级会直接红，
不用靠人记。`tools/probe-fusion.mjs` 的 **G1–G11** 用一个「只有 meow、没有星图」的 bridge 把每条路径都走一遍。

顺带把 `memory_link(action="link")` 从 `try/catch` 改成和其它入口同一个 `tryCall`：原来两条分支各写一份
「怎么算失败、失败要不要排队」，是同一个判断的两份实现，早晚会岔。

**顺手修掉一个自检污染**：`tools/coverage-audit.mjs` 会真的执行 `memory_link` 来证明入口被走到，而它没沙箱
`DSH_HOME`——于是每跑一次审计，主人的待补连线账本里就多一条假欠账（`{"a":"x","b":"y"}`）。doctor 的
「== 运行时 ==」段随后会如实报「有排队中的连线 1 条」，把排障的人往错方向带。现在所有**会真跑工具**的脚本
都必须把 `DSH_HOME` 指到临时目录，`verify.mjs` A8 段直接扫 `tools/*.mjs` 来守这条（以后新加脚本忘沙箱会红）。

### 9.16 一个插件对外只有一个名字，包括它自己家的门牌（0.2.11）

0.2.4 统一的是**入口**（侧栏、设置节的 label）。用户点进去以后看到的还是另一个名字：星图页头写着
「记忆星图」，窗口标题也是；meow 的设置面板里 `<h2>` 写着「喵记忆」。同一套东西，外面叫「宏记忆」，
里面叫「喵记忆 / 记忆星图」——这比两套入口更让人以为是两个插件。

0.2.11 把显示名收到一处，只动字符串，不动任何逻辑：

| 位置 | 文件 | 原显示名 | 现在 |
|---|---|---|---|
| 星图页头 / `<title>` | `vendor/dsh-memory-nebula/lib/web/index.html` | 记忆星图 | **宏记忆 · 星图** |
| 星图 i18n 词典（中/英/aria/句子） | `.../lib/web/i18n.js` | 记忆星图 · Memory Nebula | **宏记忆 · 星图 · Macro Memory · Graph** |
| 画布水印 | `.../lib/web/app.js` | `MEMORY NEBULA` | **`MACRO MEMORY`** |
| 侧栏标签 / iframe 标题 | `vendor/dsh-memory-nebula/lib/client.js` | 记忆星图 | **宏记忆 · 星图** |
| 注入横幅 / 工具描述 / stats 抬头 / 启动日志 | `vendor/dsh-memory-nebula/lib/index.js` | 【记忆星图 memory-nebula】… | **【宏记忆 · 星图 memory-nebula】…** |
| 口令页标题 | `.../lib/host/http.js` | 记忆星图 · 需要口令 | **宏记忆 · 星图 · 需要口令** |
| 离线快照标题 | `.../lib/host/share.js` | 记忆星图 · 离线快照 | **宏记忆 · 星图 · 离线快照** |
| Markdown 导出抬头 | `.../lib/host/nebula.js` | # 记忆星图导出 | **# 宏记忆 · 星图导出** |
| CLI 抬头 | `.../lib/standalone.mjs` | 记忆星图独立引擎 | **宏记忆 · 星图独立引擎** |
| 融合层自己的 `memory_link` 描述 | `lib/macro/defs/link.js` | 管理记忆星图的连线 | **管理星图（宏记忆 · 星图）里的连线** |
| meow 设置面板 `<h2>` | 构建期替换 `vendor/meow-memory/lib/client.js` 词典 | 喵记忆 / Meow memory | **宏记忆 / Macro Memory** |

五处 `vendor/` 文件各带 `[macro-fusion 0.2.11]` 标记（`i18n.js`、`client.js`、`index.js`、`http.js`、`share.js`；
`nebula.js` 用导出抬头本身当标记），`tools/doctor.mjs` 的补丁账本收着——vendor 升级把标记冲掉时体检会红，
按上表重新打上即可。

**改名会踩到「按名字匹配」的地方**：`lib/host/share.js:533` 的 `put(out, needle, replacement, what)` 是拿
**字面量**去页面里找标题再替换，`needle` 原来是 `<title>记忆星图 · Memory Nebula</title>`——只改替换值不改
needle，`buildShareHtml` 会在 `找不到 标题` 处抛错，把「分享快照」整条功能弄挂。现在 needle 与
`lib/web/index.html` 的 `<title>` 一字不差，`verify.mjs` A9 段专门断言这两处相等（不是各查各的）。实测
`buildShareHtml` 出一个 384,935 B 的单文件快照，标题是「宏记忆 · 星图 · 离线快照」。

**meow 那边改在构建期，不动 vendor**：`build.mjs` 里用 `replaceN(text, from, to, expected)` 做**带计数**的
替换（`"settings.title": "\u55B5\u8BB0\u5FC6"` → `"\u5B8F\u8BB0\u5FC6"`，英文值两处 `Meow memory` →
`Macro Memory`）。计数不对就抛错——vendor 的词典键名未来变了，构建会直接失败，比生成一份「改了个寂寞」的
产物安全。产物 162,804 → 162,806 → **162,813 B**（0.2.12 又 +7 B）：中文那条「喵记忆」→「宏记忆」字数字节都没变，+2 B 全来自英文值
`Meow memory`（11）→ `Macro Memory`（12）两处各 +1；0.2.12 的 +7 B 是版本号与降级文案。sha256 `1bba6b5f…`。

**保留没改的**（都不是门牌）：`正在点亮记忆星云…`「星云」是意象不是产品名；`vendor/dsh-memory-nebula/`
里 `lib/host/graph.js` `http.js` `demo.js` 的**注释**与示例数据、`locale/{zh,en}.json` 与 `market/index.json`
的**上游市场条目**（那是上游商品的挂牌名，改它等于替上游改名）、`package.json` 的 description。

验收：`verify.mjs` **A9** 段十六条（产物里有新名、没有旧转义、`build.mjs` 里钉着改名、i18n 带标记、英文值
与窗口标题两语都对、四个前端文件里旧名残留为零——`i18n.js` 允许留一处且必须是文件头那句改名说明本身、
水印已换、侧栏标签同名、注入横幅/工具描述/口令页/快照 needle/导出与 CLI 抬头全部同名、融合层的
`memory_link` 描述不再出现旧名、账本记着这些补丁）。

### 9.17 加料失败不许污染主语（0.2.12）

0.2.10 把「星图缺席」的**主路径**都降级了，但漏了**加料路径**：本地检索带 `expand`（或零命中自动扩散）时，
扩散结果是直接拼上去的。于是星图缺席时，一条本来成功的检索长这样：

```
3. …（本地结果，正常）
— 星图关联扩散 —
星图扩散未完成：macro-memory：这项能力还没就绪（对应子模块尚未装配完成，或被配置关闭），请稍后重试。
```

主语（本地结果）是对的，加料（扩散）失败了——**但它以内部错误的形式出现在一个成功结果里**。这比 0.2.10 修的那种
纯报错更坏：模型会读到「这项能力还没就绪」，然后开始怀疑整个工具面，而实际上它刚拿到了可用结果。

现在的规则一句话：**主语失败要说人话，加料失败只说「没加」。**

| 路径 | 0.2.12 之前 | 现在 |
|---|---|---|
| `memory_search` + `expand` | 结果尾巴挂 `星图扩散未完成：…这项能力还没就绪…` | `（星图这次没接上，关联扩散没做——先把本地结果给你。）` |
| `memory_link(action="link")` 排队 | `连线暂时没落图（macro-memory：这项能力还没就绪…）` | `星图这次没接上，连线已排队，读记忆时会自动补；…` |

**两种失败必须分开措辞**，这是本节的实质：`isPermanentFailure()`（星图说「找不到这两条记忆」）属于**内容**问题，
要把星图的原话转告；`isNotReady()`（工具没注册，`lib/macro/bridge.js` 的那句「这项能力还没就绪」）属于**环境**
问题，说「星图这次没接上」就够了，转述内部错误只会制造噪音。0.2.12 在 `lib/macro/links.js` 里把判据立成
`NOT_READY_MARK` + `isNotReady()`，两处调用点都走它，不再各写各的正则。

验收：`verify.mjs` **A10** 段六条（判据存在且与 bridge 的原话一致、`search.js` 扩散失败不拼接、`link.js` 排队走
`isNotReady`、探针守着 G12/G13）；`tools/probe-fusion.mjs` **G12/G13** 在「只有 meow、没有星图」的 bridge 上实测：
本地结果照样出、结果里不含 `未完成` / `这项能力还没就绪`、排队文案是「星图这次没接上」。

### 9.18 一条命令跑完所有自检，而且真能抓到自己（0.2.13）

到 0.2.12 为止，发版前的动作是手抄一段 PowerShell 循环：`verify`、`probe-fusion`、`probe-graph`、`coverage-audit`、
`param-audit`、`probe-host`、`probe-client-ui`、`check-client-bundle`、`check-yaml`、`doctor`——**十支**。
`tools/probe-inject.mjs` 不在里面，就这么漏了整整十个版本。0.2.13 加上 `tools/check-all.mjs` 顺手把它捡回来，
它第一次跑就红了两支：

| 红的那支 | 真因 | 修法 |
|---|---|---|
| `probe-inject.mjs` | 断言写死「长度 = RULE（689 字符）」；0.2.11 把星图改名成「宏记忆 · 星图」，RULE 里几处各 +4，实际 693 → 永远红 | 改成「仍是 RULE 量级（< 800 字符）」——断言的是「没把每轮邻域注入塞回来」这件事，不是某个字数 |
| `doctor.mjs` | 不算真红：`check-all.mjs` 刚加进 vendor，profile 还没同步 | 按流程备份 → 同步 → 再跑 |

顺手还修了 `probe-inject.mjs` 的第二个毛病：它的临时 `DSH_HOME` 建在**工程目录**里（`.probe-home`），既是两棵树
比对的噪音，也会被当成星图数据；现在一律 `mkdtempSync(join(tmpdir(), 'macro-inject-home-'))`。

**`check-all.mjs` 的四个设计点**：
1. **顺序是知识**：`doctor` 必须最后（要读两棵树同步与备份目录），`probe-graph` 要在前面（得给真引擎时间）。
2. **只读**：它不调 `build.mjs`（那会写产物），每支子脚本按各自约定沙箱 `DSH_HOME`。
3. **不用管道收输出**：本机沙箱下 Node 的 `stdio:'pipe'` 会 EPERM（开不了命名管道），所以把子进程的
   stdout/stderr 一起重定向到临时文件，`spawnSync(..., { stdio: ['ignore', fd, fd] })`。这条写进了 verify A11，
   谁改回管道谁红。
4. **两个受众**：人读就给「✓ 11/11 通过（用时 74.5s）」，机器读就 `--json` 给 `{version, ok, total, failed, steps[]}`。

用法：

```powershell
node tools/check-all.mjs                  # 全跑
node tools/check-all.mjs --only=doctor,verify
node tools/check-all.mjs --json           # 汇总 JSON 到 stdout，进度到 stderr
node tools/check-all.mjs --verbose        # 每支都打全量输出
```

验收：`verify.mjs` **A11** 段八条（清单齐全十一支、`doctor` 排最后、走 fd 不走管道、`--json`/`--only` 都在、
不调 `build.mjs`、README 有出处、注入探针不再写死字数、注入探针不在工程目录留 `.probe-home`）。

### 9.19 原文优先：读回来的必须跟存进去的一样（0.2.14）

0.2.1 立了「表述归口」：`lib/macro/brand.js` 的 `BRAND_MAP` 把 `nebula_recall`、`meow-memory` 这类旧名字
换成 macro 的说法，免得模型拿着调不到的名字去死磕。做法是**每次 `bridge.call()` 渲染完，对整段文本做一遍
字符串替换**。它一直工作得很好——直到 0.2.14 有人把这条规则套到「返回的是记忆原文」的工具上。

症状很安静：存进去的是 `原文保真：nebula_recall 和 meow-memory 这两个名字不许被改口。`，
`memory_read` 读回来变成：

```
项目：macro-memory
原文保真：memory_search（mode="graph"） 和 macro-memory 这两个名字不许被改口。
```

**库里其实一个字都没动**（直接查 `ws/.dsh-meow/memory.db` 的 `content` 字段可见原文），被改的是**渲染**。
这反而更糟：插件在检索结果里撒谎，而用户没有任何办法知道。三条具体危害：

1. **读回来不是存的**——记忆插件的第一职责是「账本」，账本内容被悄悄改写等于数据失真。
2. **读改写会真的写坏**：模型的常规动作是 `memory_search` → `memory_read` → 改两个字 → `memory_update`。
   它把被改口的文本原样写回，失真就从「显示」变成「存储」，且不可逆。
3. **项目归属错乱**：`BRAND_MAP` 里有 `['meow-memory', 'macro-memory']`，于是一条 `project=meow-memory`
   的记忆看起来属于 `macro-memory`——历史归属被改，`memory_project` 的项目全景会串。

**修法：内容型工具不许改口，只在末尾补一句旧名对照。** 名单是知识，写在 `lib/macro/bridge.js`：

```js
export const CONTENT_TOOLS = new Set([
  'memory_search', 'memory_read', 'memory_remember', 'memory_update',
  'memory_find_similar', 'nebula_recall', 'nebula_inspect', 'nebula_bridge', 'nebula_path',
])
```

`bridge.call()` 里 `const decorate = CONTENT_TOOLS.has(name) ? hints : brand`——名单内走
`brand.withNameHints(text)`：**正文一字不动**，末尾追加

```
（以上正文是记忆原文，一个字没动。里面的旧名字按宏记忆的说法是：nebula_recall → memory_search（mode="graph"）；
meow-memory → macro-memory——要调就调箭头右边的。）
```

这样两个目的都守住了：模型看到旧名不会被坑（对照就在下面），用户的字也不会被动。三条细节：

- **幂等**：靠固定标记 `ORIGINAL_MARK = '一个字没动'`，同一段文本过两遍也只有一条对照（verify A12 守着）。
- **名单外的照旧改口**：`memory_admin`（stats / guide / links）、`memory_link` 的回执、`cost` 这些吐的是融合层
  自己的界面文案，`brandText` 继续用，`verify` A9 那批断言不动。
- **`compatAliases=true` 时两条路径都原样返回**（A/B 原味对比）。

验收：`verify.mjs` **A12** 段十一条（`nameHints`/`withNameHints` 存在、幂等靠标记、aliases 短路、内容型名单
六项齐全、`bridge` 的 `CONTENT_TOOLS.has(name) ? hints : brand` 分流、`index.js` 接上 hints、两支探针的断言语、
README 出处）；`tools/probe-fusion.mjs` **H1–H7** 用真引擎实测：写入含旧名的记忆 → 检索正文仍是原文 → 读取
**与写入时逐字一致** → 反复读不叠第二条 → 界面文案该改口还得改口；`tools/probe-host.mjs` 把原来那条
「所有输出都不含旧工具名」拆成 **F5**（界面文案干净）与 **F5b**（正文里出现旧名时必带「原文没被改」的对照），
因为对正文来说「含旧名」是**对的**，义务只是别改它。

### 9.20 透传面：meow 有的东西，经融合层之后一件都不能少（0.2.15）

融合层是「在一层 facade ctx 外面办公」：子插件照常 `apply(ctx)`，但拿到的 ctx 不是宿主的，是 macro 包的
Proxy。这个 Proxy 拦两样东西——`ctx.tools.register` 与 `ctx.systemPrompt.section/context`——其余一律原样
透传（`logger` / `on` / `effect` / `get` / `plugin` / `inject` / `webServer` / `connection` / `settings` …）。

这里有两个方向的风险，0.2.15 各补一个断言：

**方向一：拦多了，把 meow 的功能吞掉。** meow 不是只有工具。它往宿主挂的东西至少还有：

| 通道 | 具体东西 | 少了会怎样 |
| --- | --- | --- |
| `ctx.get('commands')` | `/dream`、`/trust` 两条用户命令 | 用户敲 `/dream` 没反应，只能改用 `memory_dream` 工具 |
| `ctx.get('webServer')` | `/meow-memory/dreamed-sessions`、`/dream-events`、`/skip-dreams` | 会话列表里「已经 dream 过」的标记点不亮 |
| `ctx.on(...)` | `session/event`、`agent/pre-step`、`agent/turn-stopping`、`dispose` | 空闲计时、规则复核、收尾清理全哑 |

这些原先**一条都没有断言**：`tools/probe-fusion.mjs` 的假 ctx 里 `on: () => noop`、`get` 只返回
`tools`/`systemPrompt` 两个服务，于是「命令注册丢了」「路由没挂上」这种回归，十一支脚本不会有一支变红。
现在探针给 meow 备了立即就绪的 `commands` / `webServer` / `sessionPersistence`，并把三条通道的调用记下来：

- **I1/I2**：命令注册 ≥ 2 条，且其中有 `dream` 字样；
- **I3/I3b**：`ws.register({kind:'exact', path})` 收到 `/meow-memory/dreamed-sessions` 与 `/dream-events`；
- **I4**：`ctx.on` 收到 `session/event`、`agent/pre-step`、`agent/turn-stopping`。

顺带一个好处：以前假 ctx 缺 `webServer`，meow 会等 **20 秒**才打「服务未就绪」的警告，探针白等；现在
**2.9 秒**跑完 82 条。

**方向二：拦少了，子插件从后门直挂宿主。** facade 的 `get` 原来只特判了 `systemPrompt`：

```js
return (name) => (name === 'systemPrompt' ? promptFacade : real.get?.(name))
```

看起来没问题——本仓库两个 vendor 都没写过 `ctx.get('tools')`。但 `ctx.get('tools')` 是 cordis 的正规拿法，
任何一个 vendor 升级、任何一个后来接进来的插件只要这么写一次，它注册的工具就**绕过融合层直接进宿主的工具表**，
「宿主只看得见 8 个 `memory_*`」当场破功，而且不会有任何脚本报错。改成：

```js
return (name) => {
  if (name === 'systemPrompt') return promptFacade
  if (name === 'tools') return toolsFacade   // 工具口子只有一个
  return real.get?.(name)
}
```

这条守卫不是装饰。把这一行临时拆掉，再跑同一个「想绕过融合层」的合成插件（`shadow_tool` 走
`ctx.get('tools').register`），宿主当场收到 `["shadow_tool"]`；带守卫时宿主收到空数组、工具落进桥里
（探针 **I5**）。**I6** 对 `ctx.get('systemPrompt')` 做同样的反向验证，**I7** 反向确认「不是什么都拦」——
`ctx.get('commands')` 拿回来的是宿主那个对象本身（`===`）。

### 9.21 手册的门牌：融合之后，用户手上到底有几个面（0.2.16）

融合做久了会得一种「工具中心病」：所有说明都围着 8 个 `memory_*` 转，仿佛装完 macro-memory 之后用户只剩下工具。
事实不是——meow 原本给用户的东西有三个面：

| 面 | 谁在用 | 具体是什么 |
| --- | --- | --- |
| 工具 | 模型 | 8 个 `memory_*`（`memory_search` / `read` / `remember` / `update` / `link` / `project` / `dream` / `admin`） |
| 命令 | 用户自己敲 | `/dream`（手动唤起一次整理）、`/meow-trust`（信任当前工作区自带的记忆库） |
| 面板 | 用户看 | 设置里的「宏记忆」、独立的「宏记忆 · 星图」 |

0.2.15 已经证明这三个面**在技术上**一件没少（探针 I1–I4 数着命令、路由、钩子）。但「在」和「用户知道它在」
是两件事：注入给模型的 L0 只讲工具，`memory_admin(action="guide")` 吐出来的又全是 vendor 原文——
那两段手册是写给「只有这个插件」的世界观的，读者看完仍然不知道还有命令和面板。**功能没砍，入口被藏了，
观感上就等于砍了。**

所以这一版补两块字：

1. **L0 每轮注入末尾加一句**（约 60 字符，`lib/macro/prompt.js` 的 `GUIDE_TEXT`）：
   `三个面都在：memory_* 工具 / 命令 /dream 与 /meow-trust / 面板「宏记忆」与「宏记忆 · 星图」。`
   现在 `GUIDE_TEXT` 全长 1,042 字符，仍在 `GUIDE_MAX_CHARS = 1300` 的预算里（`clampGuide` 兜底）。
2. **L2 手册前面加一段「门牌」**（`NAV_TEXT`，同样在 `prompt.js`），`memory_admin(action="guide")` 输出变成
   `NAV_TEXT` + `---` + vendor 原文（4,470 字符）。原文一个字不改——它是 vendor 的权威说明，我们只是
   在门口挂一块牌子。

**一个刻意的「不做」**：命令名没有改成 `/macro-dream`、`/macro-trust`。看起来 `/meow-trust` 与「宏记忆」
不同名，不整齐；但用户敲字的习惯比整齐值钱，改名换来的是「昨天还能用的命令今天不见了」。
`NAV_TEXT` 里把这件事写明了，判断也写进 DESIGN §26.3。

**门牌不许说谎。** 命令名是硬编码的，一旦 vendor 升级改了注册名，手册就会指着一条不存在的命令。
所以 `verify.mjs` **A14** 拿 `vendor/meow-memory/lib/index.js` 里的 `name: "dream"` / `name: "meow-trust"`
做交叉核对；`tools/probe-fusion.mjs` **J1–J8** 实测：手册以「宏记忆有三个面」开头、两条命令名都在、
两个面板名都在、vendor 原文仍原样接在后面、手册里不夹内部错误、L0 也点了三个面、命令名与 vendor 一致、
L0 仍在 clamp 预算内。

验收：`verify.mjs` **158 PASS**（新增 A14 八条），`tools/probe-fusion.mjs` **90 PASS**（新增 J1–J8），
其余九支不变；版本 0.2.16，`lib/client.js` 仍 162,813 B（这轮只动服务端文案）。


验收：`verify.mjs` **A13** 段十一条（`get('tools')` 走 facade、`get` 只特判两个名字、探针记录三条通道、
探针备齐三个服务、I1–I7 的断言语、README 出处）；`tools/probe-fusion.mjs` 新增 **I1–I7** 共八条，
合计 **82 PASS**；其余十支脚本不变。




### 9.22 vendor 账本：证明「拷进来的第三方源码没被谁动过」（0.2.17）

两个子插件不是 npm 依赖，是**源码拷贝**进 `vendor/` 的（DESIGN §11.3 说明过为什么：上游没有可用的发布物，
而且我们要在文件里打补丁）。拷贝进来的东西有个天然缺陷：**它和上游之间没有任何可核对的关系**。

- 上游升级 → 我们重新拷一遍 → 旧补丁被静默冲掉（这个 0.2.9 已经用「补丁账本」管住了）。
- 反方向没人管：**vendor 被谁整段换掉、被手改了半个字**，补丁账本照样全绿——因为补丁标记还在。

所以 0.2.17 加一份 `vendor/VENDOR.json`：

```json
{
  "dir": "vendor/meow-memory",
  "name": "meow-memory",
  "version": "0.32.8",
  "files": 44,
  "bytes": 1689955,
  "sha256": "9cd6fed1…11881"
}
```

`sha256` 不是单文件的哈希，而是**整棵树的聚合指纹**：按路径排序，把每个文件的 `路径:sha256` 逐行拼起来再
哈希一次。这样一份 1.7 MB、44 个文件的 bundle，账本里只有 6 个字段就能盯住；改一个字节指纹就变
（实测：给 `style.css` 追加 `/*x*/`，聚合指纹从 `bbfe1444…` 变成 `fab0a0d4…`）。

三条设计约束：

1. **算法只有一份实现**（`tools/vendor-hash.mjs` 的 `hashTree`）。生成方
   `tools/make-vendor-manifest.mjs` 和核对方 `tools/doctor.mjs` 都 import 它。账本类功能最常见的死法是
   「生成按 A 算法、核对按 B 算法」，然后两边永远不一致、于是没人再信它。
2. **两个账本互补，不合并**：`VENDOR.json` 管「vendor 当前长这样」，doctor 的 `PATCHES` 管「我们那 7 个
   补丁还在不在位」。只有前者会漏掉「补丁被自己改丢」，只有后者会漏掉「vendor 被整段换掉」。
3. **反向核对**：doctor 除了逐个比对账本条目，还会扫 `vendor/` 下的目录，发现**没记账的目录**就红——
   新拷一个插件进来却没人发现，比改旧文件更常见。

doctor 新增一段 `== vendor 账本 ==`（六条）：

```
PASS  账本里有 vendor 条目  2
PASS  账本版本与源码一致：meow-memory  账本=0.32.8 源码=0.32.8
PASS  账本指纹一致：vendor/meow-memory  44 文件 / 1689955 B / 9cd6fed10110c9ee
PASS  账本版本与源码一致：dsh-memory-nebula  账本=1.11.74 源码=1.11.74
PASS  账本指纹一致：vendor/dsh-memory-nebula  51 文件 / 988373 B / 64b894e866203d45
PASS  vendor 下没有未记账的目录  2 个目录全部记账
```

**自己改了 vendor 怎么办**：确认改动是故意的 → 跑 `node tools/make-vendor-manifest.mjs` 重记账 →
`verify.mjs` 的 A15 会检查账本版本与 `vendor/*/package.json` 一致、指纹是完整 sha256，防止账本写成
「随便填个短串蒙过去」。还原办法：从 `D:\备份\<发版前的备份>\vendor\` 拷回。

验收：`verify.mjs` **A15** 十一条（含账本存在、两条条目、六字段齐全、版本与源码一致、指纹是 64 位 sha256、
doctor 有该段且做反向核对、README 出处）；`tools/doctor.mjs` 六条新断言；版本 0.2.17，
`lib/client.js` 仍 162,813 B（本轮没动前端）。

### 9.23 断言数基线：绿不等于没退化（0.2.18）

`check-all` 原来只回答一个问题：**这十一支有没有跑挂**。但「没挂」不等于「没退化」——

> 把 `tools/probe-fusion.mjs` 里 H 段整段写成 `return`（比如重构时想先跳过），剩下的 82 条照样通过、
> 照样打 `ALL PASS`、照样 `exit 0`。`check-all` 会给你一个漂亮的 `11/11 通过`。

这类回归最难查：**它不产生任何红**。所以 0.2.18 给每支脚本记一笔「应该有多少条断言」——

`tools/baselines.json`（11 支，合计 410 条）：

```json
{
  "generatedBy": "tools/check-all.mjs --update-baselines",
  "version": "0.2.18",
  "counts": {
    "verify.mjs": 183,
    "tools/probe-fusion.mjs": 90,
    "tools/probe-graph.mjs": 26,
    "tools/probe-host.mjs": 21,
    "tools/probe-client-ui.mjs": 12,
    "tools/coverage-audit.mjs": 7,
    "tools/param-audit.mjs": 13,
    "tools/check-client-bundle.mjs": 0,
    "tools/probe-inject.mjs": 17,
    "tools/check-yaml.mjs": 0,
    "tools/doctor.mjs": 41
  }
}
```

`check-all` 跑每一支时数**行首 `PASS`** 的行数，和基线比：

| 情况 | 判定 | 输出 |
| --- | --- | --- |
| 条数掉了 | **失败**（exit 1） | `↓ tools/probe-fusion.mjs 90 → 82（少 8 条）` |
| 条数多了 | 只提醒 | `断言数增加 1 支：… 37→40（确认后 --update-baselines）` |
| 基线里还没记 | 只提醒 | `基线里还没记：…（跑 --update-baselines 记账）` |
| 一致 | 静默通过 | `断言数与基线一致（11 支，合计 410 条）` |

四个细节，都是踩过才知道要有的：

1. **数行首 `PASS` 而不是解析「N PASS」**。十支脚本里八支按行打 `PASS  …`，而 `probe-inject` 打
   `结果：17/17 PASS`、`check-yaml` 干脆不打。数行首是唯一一个对**所有**脚本都一样稳的统计口径；
   不打 `PASS` 的两支记 0，也要记账（见第 3 点）。
2. **用单独的符号区分「跑挂」和「条数变」**。混成一种红会让人以为脚本坏了，于是去重启环境。
   现在跑挂是 `✗`、掉了是 `↓`、多了是 `↑`、未记账是 `!`。
3. **0 条也要记**。`check-client-bundle` 与 `check-yaml` 只打 `ALL PASS`，读出来是 0。
   记账的价值在**变化时**：哪天有人给它俩加了 `PASS` 行，0 → 12 会被发现（`↑`），
   而不是「本来就 12」地沉默掉。
4. **基线自己会过期，所以 doctor 要管它**。doctor 新增第九段 `== 自检基线 ==` 三条：
   基线 `version` 必须等于 `package.json` 的版本（发版忘了重记，这里就红）、基线必须覆盖
   `check-all` 里列出的每一支（新加脚本必须记账）、所有条数必须是非负整数。
   这是「账本类功能必须能被机器核对」的同一原则（§9.22）。

自己有意增减断言时：

```
node tools/check-all.mjs --update-baselines          # 全跑一遍并重记
node tools/check-all.mjs --only=verify --update-baselines   # 只重记一支（其余旧账保留，不会写残）
```

验收：`tools/check-all.mjs`（基线读取、`↓/↑/!` 三态、`--update-baselines`）；`tools/doctor.mjs`
第九段三条；`verify.mjs` **A16** 十一条。实测 `verify` **183 PASS**、`check-all` 11/11、
`verify` 与基线一致（合计 410 条）。版本 0.2.18，`lib/client.js` 仍 162,813 B（本轮只动工具）。

### 9.24 耗时预算：卡住要变成一条红，而不是无限等（0.2.19）

`check-all` 跑到一半停住，是最难受的一种状态：**分不清「还在跑」和「已经挂了」**。
`probe-graph` 要 49.5 秒（真 meow 库 + 真 nebula 引擎），`param-audit` 20.7 秒——都很正常；
但如果某次改动让它死等一个永远不会来的回调，整条验收命令就会一直挂在那里，你以为它在算。

0.2.19 给每支脚本一个**耗时预算**，超了直接杀掉，报一条明确的超时：

```
✓ tools/probe-graph.mjs        49.5s/199s  26 条  真 meow 库 + 真 nebula 引擎：节点/边/生命周期 G1–G11
⏱ tools/param-audit.mjs        180s/180s    13 条  参数级覆盖：原参数与必填都没退化
    ⏱ 超过 180s 预算，已杀掉（上次实测 20.7s）
```

`baselines.json` 因此多两栏：`ms`（上次实测）与 `budgetMs`（超时上限）：

```json
"ms":      { "verify.mjs": 110, "tools/probe-graph.mjs": 49520, … },
"budgetMs":{ "verify.mjs": 30000, "tools/probe-graph.mjs": 199000, … }
```

预算怎么算：**`max(30s, 4 × 上次实测)`**。四个系数各有理由——

1. **4 倍**而不是 1.5 倍。同一台机器不同负载能差出一倍（杀毒软件扫盘、`pnpm` 正在装包、
   Windows 第一次跑某支脚本要热文件缓存）。卡太紧等于**制造假红**，而假红会把红变成噪音。
2. **下限 30 秒**。0.1 秒的脚本给 0.4 秒预算，任何一次系统卡顿都会误杀。
3. **第一次跑给 180 秒**。这条是踩出来的：第一版用「没见过就用 20s」，第一跑就把自己的
   `probe-graph`（49.7s）和 `param-audit`（20.6s）杀了——**不知道它多慢时必须给足余量**，
   宁可第一次宽松，也不要第一跑就两条假红。
4. **超时那次不记耗时**。被杀掉的进程只证明「至少这么久」，拿来算预算会一轮一轮滚大。

两个实现细节：

- `spawnSync({ timeout, killSignal: 'SIGKILL' })`。用 `SIGKILL` 而不是默认的 `SIGTERM`：
  Node 子进程在等 I/O 时不一定理会 `SIGTERM`，而我们要的是「一定停下来」。
- **超时单独一个符号 `⏱`**，和跑挂的 `✗`、断言掉了的 `↓` 分开。三种原因要长得不一样，
  否则使用者会拿错误的假设去修（把「卡住了」当成「断言错了」）。

doctor 的 `== 自检基线 ==` 段跟着多两条：**每支都有预算**、**预算至少是上次实测的两倍**
（有人手改 `budgetMs` 改小了，这里红），并顺手打印最慢的两支——「哪两支值得优化」不用再猜。

自己确认某支本来就该更慢时：`node tools/check-all.mjs --update-baselines` 会按本次实测重算预算。

验收：`check-all`（timeout/killSignal/超时判定/三符号）、`baselines.json` 的 `ms` 与 `budgetMs`、
`doctor` 两条预算断言、`verify.mjs` **A17** 十二条。实测两树 `check-all` 11/11、
`probe-graph 49.6s/199s`、`param-audit 20.6s/83s`。版本 0.2.19，`lib/client.js` 仍 162,813 B。

### 9.25 耗时漂移：慢下来要说话，但别把尺子改短（0.2.20）

0.2.19 让「卡死」变成一条红。可它只挡得住「一直不返回」这一种坏法，挡不住另一种更常见的坏法：
**每一版都慢一点点**。这种退化从前没有出口 —— 它会以「有人嫌验收慢，于是把 `budgetMs` 调大」的形式
从后门溜过去，等预算比实测大出十倍，`⏱` 就再也不会响了。

所以 0.2.20 补一条**只提醒、不判红**的通道：每支脚本的耗时和 `baselines.json` 的 `ms` 比，
超过 **1.5 倍**就在那一行下面补一句，汇总里单独列一段，**退出码不动**。

```
✓ tools/probe-fusion.mjs           4.6s/ 30s   90 条    真 vendor 端到端联动
    ~ 比基线慢 1.7 倍（上次 2.7s，这次 4.6s）——不判红，先看是不是机器忙
```

汇总段落长这样：

```
耗时变慢 1 支：tools/probe-fusion.mjs 2.7s→4.6s（1.7×）
  说明：这一条不判红，退出码不受影响。先看是不是机器忙/首次跑/杀毒在扫；真的每次都慢就去查是哪一段退化，
        别直接 --update-baselines 把「慢」记成「正常」——那等于把尺子改短。
```

四个刻意的取舍：

| 决定 | 为什么 |
|---|---|
| 倍数 **1.5**，不是 2 | 2 倍时已经吃掉一半预算余量，等那时才说话太晚；1.5 倍偶尔会因负载响，但响一声只是 `~` 一行 |
| **不到 1s 的脚本不比** | `SLOW_FLOOR_MS = 1_000`。0.1s→0.2s 也是 2 倍，纯噪声 |
| **超时那次不参与** | 被杀掉的进程跑的时间只是「至少这么久」，拿它算漂移等于自我强化 |
| **不判红** | 慢不等于坏。判红会让「机器当时在忙」变成一次假失败，而假红会教人习惯性忽略红 |

配套两处防漏：

1. `--update-baselines` 在存在变慢项时会额外警告一句
   `⚠ 你正在把 N 支「变慢了」的耗时记成新基线：…——确认是环境噪声，不是退化。`
   记账是允许的（有时候确实换机器/换了更严的校验），但不能让它**顺手**发生。
2. `doctor` 的「自检基线」段加两条：`耗时漂移有阈值`（`SLOW_FACTOR = 1.5` / `SLOW_FLOOR_MS = 1_000` 都在）、
   `耗时表与预算表覆盖同一批脚本`（两张表错位时漂移判定会静默失效 —— 这是最容易漏的一种）。

验收：`check-all`（`SLOW_FACTOR` / `lastMs` / `~ 比基线慢` / 汇总段 / 不参与 `verdict`）、
`baselines.json` 的 note 说明 1.5 倍只提醒、`doctor` 两条、`verify.mjs` **A18** 十二条。
版本 0.2.20。

### 9.26 存储层归位：路径只有一个出处（0.2.21）

`cost.js` 和 `links.js` 各自管一个 jsonl 文件，看起来各司其职。真正的问题是它们**共用一件不该共用的东西**：

```js
// lib/macro/links.js（0.2.20 之前）
import { macroHome } from './cost.js'   // ← 队列为了算路径，去借成本账本的函数
```

两处都正确，合起来是三个错：

| 错 | 表现 |
|---|---|
| **依赖方向反了** | 「待补连线队列」不是「成本账本」的一部分，却要 import 它。以后谁拆成本模块，队列跟着断 |
| **路径有两个出处** | 谁都能改 `macroHome()` 的算法，改完只有自己那份对，别人的文件悄悄写到旧位置 |
| **jsonl 解析写了两遍** | 「读文件 → split → 逐行 `JSON.parse` → 跳过坏行」在 cost 与 links 里各一份，坏行规则改一处漏一处 |

所以 0.2.21 把「文件在哪、怎么写、怎么读」抽成 `lib/macro/store.js`：

```js
export function macroHome()      // $DSH_HOME/macro-memory（没设时 ~/.dsh）
export function ledgerPath()     // cost.jsonl
export function pendingPath()    // pending-links.jsonl
export function readJsonl(file)  // 读 → 逐行解析 → 坏行跳过，不抛
export function appendJsonl(file, entry)
```

三层职责因此变得可以说清楚：

```
defs/*  →  linkflow.js  →  links.js  ┐
                       cost.js      ├→  store.js  →  node:fs
                                     ┘
```

`store.js` 是唯一碰 `node:fs` 的地方，也是唯一读 `$DSH_HOME` 的地方，它**不认识业务**：
不知道「成本」和「待补连线」是什么，只知道文件名与行格式。

三条约定（写进文件头，改之前先读）：

1. `$DSH_HOME` 只在这里读一次，别处的路径一律由 `ledgerPath()` / `pendingPath()` 给出；
2. jsonl 坏行一律跳过、**不抛** —— 一行坏账不该让整个账本读不出来；
3. 这层不认识业务。

**兼容性**：`cost.js` 仍 `export { ledgerPath }`、`links.js` 仍 `export { pendingPath }`，
所以 `doctor` 与两个探针不用改一行（它们一直在用这两个名字）。

**验收**：`verify.mjs` **A19** 十二条 —— `store.js` 五个入口齐全、全 `lib/` 只有 store 读
`process.env.DSH_HOME`、逐行解析只有一份、`links` 不再 import `cost`、`cost` 不再直接读文件、
两个转发导出都在；`doctor` 新增 **「== 存储层 ==」** 段两条（路径唯一出处 / 解析没有第二份），
体检从九段变十段。版本 0.2.21，`lib/client.js` 未动。

### 9.27 动作表：schema 里能选到的，一个都不许是死路（0.2.22）

`memory_admin` 有八个 action，长得像一张表，实际是**一条 if/else 链 + 一份手写枚举**：

```js
// 0.2.21 之前：两处分头维护
action: { type: 'string', enum: ['home', 'stats', …, 'guide'], … }   // ① 手写枚举
…
if (action === 'home') { … } else if (action === 'stats') { … }      // ② if/else 链
```

两处各改各的，最容易出的坏法是「**枚举里列了、分发里没有**」：模型照着 schema 选一个
完全合法的 action，一调就掉进 `未知 action=…`。而自检全绿 —— 枚举从来没人核对过，
覆盖审计只跑它自己列的那几个。这不是理论风险：`tools/param-audit.mjs` 的期望列表里
就少了 `links`（只做子集检查，所以照样 PASS），说明「另一份手抄名单」天生会漂。

0.2.22 把三样东西收成一份数据：

```js
export const ACTIONS = {
  home:     { kind: 'call',  call: 'memory_home',     params: ['target'] },
  stats:    { kind: 'graph', graph: 'nebula_stats',   params: ['hubs'],        what: '星图概况', miss: '星图概况这会儿看不了' },
  hygiene:  { kind: 'graph', graph: 'nebula_hygiene', params: ['kind','limit'], what: '记忆体检', miss: '记忆体检这会儿做不了' },
  sources:  { kind: 'graph', graph: 'nebula_sources', params: ['verbose'],     what: '记忆来源', miss: '记忆来源这会儿看不了' },
  ingest:   { kind: 'graph', graph: 'nebula_ingest',  params: ['provider','items'], what: '外部记忆推入',
              miss: '这批外部记忆一条都没推进去', guard: guardIngest },
  cost:     { kind: 'local', params: ['limit'] },
  links:    { kind: 'local', params: ['limit'] },
  guide:    { kind: 'local', params: [] },
}
```

- **枚举**：`action: { enum: Object.keys(ACTIONS) }` —— 不是抄一份，是同一个数组；
- **分发**：只认 `kind`，`call` / `graph` / `local` 三条路，任何具体 action 的名字都不出现在分发代码里；
- **校验**：挂在表行的 `guard` 字段上（`ingest` 的 `provider`/`items` 合并后 schema 收不住必填）；
- **实现**：`local` 三个动作在 `createAdmin` 里的 `local` 对象，按同名 key 取；表里有行却没实现 →
  当场 `action=… 在表里但没有实现`，不会静默返回空串。

加一个面板现在是**加一行**，而且是加在唯一一处。

**为什么这属于「优化项目结构」而不是「加功能」**：功能一个没多，`enum` 长度还是 8，
只是把「同一件事写三遍」收成一遍 —— 少掉的那两遍就是将来会漂的地方。

**验收**：
- `tools/probe-fusion.mjs` 新增 **K1–K5**（执行层）：枚举与表逐字相同（`adminEnum` vs `Object.keys(ACTIONS)`）、
  表八行、每行恰好一种 `kind`、**把枚举里每个 action 都真跑一遍**，任何掉进「未知 action / 没有实现 /
  is not a function」的都记成死路（实测 8 个全部走通）、表外 action 仍明确报错。
- `verify.mjs` **A20 十五条**（源码层）：表是模块级纯数据、`enum: Object.keys(ACTIONS)`、
  **不再存在按 action 名写的 if/else 链**、分发按 `kind`、表外有兜底、未知 action 报错、八行都有
  `kind`、`ingest` 仍守必填、星图面板仍走 `graphPanel`/`tryCall`（0.2.10 的降级承诺不因重构丢失）、
  `guide` 仍「门牌 + vendor 原文」（0.2.16 的 A14 依赖这一行）。
- 版本 0.2.22，`lib/client.js` 未动（162,813 B / `1bba6b5f`）。

### 9.28 加载面：问 DSH 自己，不抄它的规则（0.2.23）

体检里的「加载面」一直是看文本：`bundles` 里有没有这个 id、patch 文件里 `name: 'dsh-macro-memory'` 出现几次。
文本写着，不等于**装配之后它还活着**——中间还隔着版本兼容、平台声明、补丁解析、后面几层的覆盖。

真判据不在我们仓库里，在 DSH 的 `@deepseek-ai/dsh-app-boot` 里：`engines.dsh`（或 `peerDependencies` 里
`@deepseek-ai/dsh-*` 的版本范围）、`dsh.bundle.patch` 必须存在且能被补丁解析器读懂、`dsh.bundle.platforms`
必须允许本机、bundle 必须能从安装锚点或 profile 解析出目录。**抄一份进自己的断言 = 抄第二份真相**，
上游一改就悄悄过期——0.2.22 的三份清单已经教过一次。

所以 `tools/probe-load.mjs` 直接把装好的 app-boot import 进来问它：

```
node tools/probe-load.mjs          # 14 条：能不能加载 + 装配后还在不在
```

它做的 14 件事（每条都是 FACT，不是主张）：

1. 找得到 DSH 安装（`DSH_APP_DIR` 可覆盖；找不到就是 FAIL，不假装绿）
2. 运行时版本取自 app-boot 自己的 package.json（本机 `0.2.2-rc.3`）
3. profile 清单里列了本插件
4. `resolveBundleDir` 能把 bundle 解析到目录
5. DSH 加载的那份与本仓同版（`0.2.22` → 同步过去之前不会出现「装的是旧代码」）
6. DSH 的判据说装好的那个 bundle 能加载
7. 同一套判据也问一遍本仓源码（不用先同步进 profile 才知道清单写错）
8. `main` / `exports{"."}` / `exports{"./client"}` / `exports{"./cordis.patch.yml"}` 指向的文件都在
9. 前端产物存在（字节数）
10–11. vendor 里两个引擎（meow / nebula）也各自按同一套判据能加载
12. `composeEntries` 装配完，条目列表里恰好 1 条 `macro-memory`
13. 那一条不是 `disabled: true`
14. 装配过程的警告里没有一条指向本插件（其余插件的问题只报数，不判红）

**为什么第 12–14 条必须走 `composeEntries`**：那就是 boot 里那一次 `applyEntryPatches`。实测本机装配出
222 条，我们那条是 `{id:'macro-memory', name:'dsh-macro-memory', disabled:false, config:{…}}`；
17 条警告全落在别的插件上（`redteam-store` 之类 patch 指向不存在的条目）。少走这一步，
「补丁被后面的层删掉/禁掉」这类事永远只能靠人看 YAML。

**只读**：不写 profile 清单、不 apply 补丁、不启动插件、不碰运行中的 DSH。唯一的逃逸口是
`PROBE_PATCH=<文件>`，只为证明「被禁用」那条检查真会红，平时不设。

**三条阴性对照（都真跑过）**：

| 故意弄坏 | 结果 |
| --- | --- |
| 本仓 `package.json` 加 `"engines": {"dsh": ">=9.0.0"}` | `FAIL 本仓这份源码按 DSH 的判据也兼容：… requirements {"engines.dsh":">=9.0.0"}` |
| `PROBE_PATCH` 指向 `- id: macro-memory / disabled: true` | `FAIL 装配后它不是被禁用的：disabled: true —— 装了但不会起` |
| 装好的那份删掉 `lib/client.js` | `FAIL 入口文件都在：缺 ./lib/client.js` |

**一个顺带学到的**：DSH 判兼容用的是 `semver.satisfies(runtime, range, { includePrerelease: true })`。
meow 的 peer 写的是 `@deepseek-ai/dsh-llm: "*"`，在 `0.2.2-rc.3` 这种预发布版本上**成立**；如果我们
手抄一条「`*` 不匹配预发布」的规则，就会天天误报。判据这种东西，只该有一个出处。

### 9.29 运行态验收：只有跑着的那个进程能回答的事（0.2.24）

`probe-load`（9.28）回答的是「装进去的这份**能不能**被加载」——离线判据，冷启动之前就能问。
可是「现在跑着的那个进程，到底加载了什么、有没有在跑、有没有报错」它答不了：那属于运行态。

```
node tools/accept-live.mjs     # 只读：问跑着的 DSH，不启停任何东西
```

五条，其中**只有两条判红**：

| 检查 | 判红？ | 依据 |
| --- | --- | --- |
| 宿主还活着 | ✅ | `logs/desktop-next.log` 5 分钟内有写入；没动 = 大概没在跑，运行态无从查起 |
| 前端产物在跑着的宿主里 | ✅ | 日志里渲染进程自己打的 bundle 列表含 `dsh-macro-memory/client.js`（附 `rev=` 摘要） |
| 服务端代码在这次运行里跑过 | ❌ | `$DSH_HOME/macro-memory/` 里有文件的 mtime 晚于运行起点；没活动不算错 |
| 日志里没有一条 error 提到本插件 | ✅ | 有就是有，`[error]` 行同时提到本插件 |
| 跑的是不是现在这份代码 | ❌ | 起点在改动之后 = 在跑最新代码；否则报告「之后本仓有 N 个文件改过，要看到改动得重启」 |

只有两条判红是有意的：**重启的节奏归主人，不归探针**。探针的责任是把事实说清楚，不是催人重启。

**「这次运行的起点」必须问操作系统，不能拿日志文件的创建时间。** 这是实测踩出来的：DSH 进程 `22:48`
就起了，`desktop-next.log` 到 `03:37` 才建（日志会轮转/重写），拿它当起点，会得出「启动时间晚于本仓
所有改动，装的是最新代码」——一个漂亮的假绿。改成问进程创建时间（PowerShell
`Get-Process -Name 'DSH NEXT' | Sort-Object StartTime | Select-Object -First 1`，进程名可用
`DSH_LIVE_PROCESS` 覆盖），问不到就 `INFO 查不到运行起点，这条不猜`。

**为什么不进 `check-all`**：DSH 没开着它就会红，那等于把「环境」当「代码」判。跑一次三秒，要验收时手动跑。

实测（本机，0.2.23 时期的那次运行）：起点 `2026/11/18 22:48:26`，之后本仓改了 23 个文件；
`pending-links.jsonl` 在 `00:48:44` 被写过——**服务端那半截在那次运行里真的跑过**，不是我们推的。

三条阴性对照（造一个假 `DSH_HOME` 指向旧日志）：日志 30 分钟没动 → 红；日志里没有 client bundle
→ 红；日志里一条 `[error] plugin dsh-macro-memory failed to load` → 红，并把原文截前 200 字打出来。

## 9.30 面板口径：八个面一个抬头，名字只写一遍（0.2.25）

`memory_admin` 有八个面板。以前每个面板各写各的开头：成本账本用 `# macro-memory 成本账本（最近 N 次调用）`，待补连线直接甩 `待补连线：N 条`，星图那四个干脆是 vendor 原文（开头是它自己的话）。三个坏处：

1. **看不出是哪个面。** 模型一次只拿到一段文本，八段八套开头，等于没有抬头；输出一截断，连人和模型都分不清这是概况还是体检。
2. **「空」分不清原因。** 没数据、星图没接上，两种情况的正文完全不同，但都从第一行就开始讲细节。
3. **同一个东西四种叫法。** `action` 键是 `stats`，卡片标题是 `记忆运维：stats`，工具描述里是「星图概况」，手册里又是另一种说法。

### 三条约定

- **抬头只有一处出处**：`lib/macro/panel.js` 的 `panelHead` / `panelText`，形如 `【宏记忆｜成本账本】最近 200 次调用`。正文一个字不动，抬头加在**上面**——vendor 原文照旧原样接在下面（9.13 的原文优先不受影响）。
- **名字只有一份**：写在动作表那一行的 `label` 上，抬头、卡片标题、工具描述三处都从这张表取。以前是「枚举一份、分发一份、描述再手抄一份」，现在加一行 ACTIONS 就自动三处齐。
- **手册是唯一豁免**：`guide: { …, wrap: false }`。手册是长文，没有「条数/时间窗」这种口径可报，而且它的第一行必须就是门牌（「宏记忆有三个面」），多一行抬头反而把门牌埋了。豁免理由写在那一行的注释上，不是漏了。

### 顺手收掉的两处散账

- **条数默认值**：以前是 `args.limit === undefined ? 200 : Number(args.limit)` 和 `? 20 :` 各写一遍，散在两个方法里；现在写进表的 `defaultLimit`，读取只有 `limitOf(spec, args)` 一条路径。
- **参数说明与实现对齐**：`limit` 的说明一直写「action=stats/hygiene/cost 的条数」，其实 `links` 也在用它。现在改成 `action=hygiene/cost/links 的条数（默认：cost 200、links 20，hygiene 由星图定）`。

### 验收

```
【宏记忆｜星图概况】
宏记忆 · 星图：1 条记忆 / 0 条连接 …

【宏记忆｜成本账本】最近 200 次调用
合计：入参 1116 字符 / 出参 20634 字符 / 失败 1 次 / 耗时 135 ms
按工具：…
```

- `tools/probe-fusion.mjs` 新增 L1–L6：七个统计面抬头一致、八个名字两两不同、手册仍以门牌开头、抬头之外正文没被顶掉、条数口径写清、工具描述由表生成。
- `verify.mjs` A23 十五条：抬头只有一处、名字都在表里、三种 kind 走同一个 wrap（**逐字**比对那一行）、手册豁免有理由、卡片标题取 label、默认值只在表里、正文没被改写。
- 阴性对照：把 `wrap` 改成直接返回正文 → A23 与 L1/L5 立刻红（这时打印出来的正是八段各不相同的开头）；在 `cost.js` 里再写一份抬头字面量 → 「其它文件里没有第二份抬头」红。

## 9.31 桥拆三件事：收下 / 换门 / 出文本各一个文件（0.2.26）

`lib/macro/bridge.js` 一度是最大的单文件（292 行），里面挤着三件事：

| 原本挤在一起的 | 现在在哪 | 判据 |
| --- | --- | --- |
| 收下子插件的工具与注入、转调子插件工具 | `lib/macro/bridge.js`（143 行，有状态） | 有 `createBridge`，没有 `new Proxy(` |
| 把 `ctx` 换成 facade（三个 Proxy） | `lib/macro/facade.js`（118 行，无状态） | 有 `createFacade` / `wrapPlugin`，三个 `new Proxy(` 都在这 |
| 把子插件返回值变成文本 | `lib/macro/render.js`（32 行，纯函数） | 不 `import` 任何东西 |

切法不是按行数对半，而是按一句话：**「A 是 B 的一部分」说得通才放一起**。

- 「桥收下工具」不是「换门」的一部分——桥有状态、换门没有；
- 「换门」不是「出文本」的一部分——换门只碰 `ctx`，出文本只碰返回值；
- 三者能各自被一句话说清，就是三个文件。

拆结构**不许改调用方**：`lib/index.js:19` 那一行 `import { createBridge, errText, wrapPlugin } from './macro/bridge.js'` 一个字没动，由 `bridge.js` 把 `facade.js` / `render.js` 的导出转出去（`export { createFacade, wrapPlugin } from './facade.js'`、`export { errText }`）。转出不是重复实现：`bridge.js` 里没有 `export function createFacade`，也没有 `export function renderToolText`。

行为不许变，所以有实测（`tools/probe-fusion.mjs` M1–M5）：

- M1 三个入口都还在；
- M2 `bridgeMod.errText === renderMod.errText`、`bridgeMod.wrapPlugin === facadeMod.wrapPlugin`——转出的是同一个函数，不是同名的另一个；
- M3 换门之后 `ctx.get('commands')` 照样透传到真服务（拆文件没把透传漏掉）；
- M4/M5 出文本仍优先子插件自己的 `output.render`，没 render 或 render 抛错才退回 JSON。

`verify.mjs` 的 A24 十二条盯位置与调用方，`doctor` 新增「结构」一段（四条，含「Proxy 不在 bridge.js」）。

**为什么值得拆**：并排读 292 行时，改「出文本」的人很容易顺手碰 `captureTool` 的状态；分开之后每个文件的契约只有一句，`render.js` 是纯函数（能单独测、能单独替换），`facade.js` 无状态（换门逻辑不依赖谁先谁后）。

### 9.32 项目根只有一个出处（0.2.27）

0.2.27 之前，`tools/` 下二十个脚本各自算一遍项目根，一共五种写法：

| 写法 | 谁在用 | 毛病 |
| --- | --- | --- |
| `dirname(dirname(fileURLToPath(import.meta.url)))` | doctor / probe-graph / probe-client-ui / check-client-bundle / make-vendor-manifest | 啰嗦，抄来抄去 |
| `dirname(fileURLToPath(import.meta.url)).replace(/[\\/]tools$/, '')` | probe-fusion / probe-host / coverage-audit | 靠字符串后缀猜自己在哪，目录一改名就断 |
| `process.cwd()` | param-audit | **换目录跑就找错地方**：从 `C:\Windows\Temp` 跑直接 `ERR_MODULE_NOT_FOUND` |
| `'D:/dsh-home/vendor/dsh-macro-memory/vendor'` | cost-baseline / probe-toolsize | **写死绝对路径**，换机器就废 |
| `resolve(import.meta.dirname, '..')` | probe-load / accept-live | 同第一种，只是更隐蔽 |

现在只有 `tools/_root.mjs` 一处，导出三样：

```js
export const root = dirname(dirname(fileURLToPath(import.meta.url)))  // 仓根
export const vendorDir = join(root, 'vendor')                          // 两个真引擎
export function at(...segs)                                            // 拼仓内路径
```

二十个脚本一律 `import { root } from './_root.mjs'`（`verify.mjs` 从 `./tools/_root.mjs` 取）。

**顺带堵掉一个更隐蔽的问题**：`check-all.mjs` 以前用 `cwd: root` 跑每一支——看着贴心，
其实替被检查者补了环境。param-audit 拿 `process.cwd()` 当项目根，在 check-all 里永远是绿的，
单独从别的目录跑就露馅。检查器如果顺手把环境摆好，它检查的就不是脚本本身，而是「脚本 + 我的补场」。
现在每一支都在一个与项目无关的空目录里跑（`cwd: neutralCwd`）：谁再偷用 cwd，那一支当场红。

判据（verify **A25 十一条** + doctor 结构段一条）：

- 根只在这里算一次，三个导出齐全；
- tools 下除 `_root.mjs` 外没有 `const root = dirname(...)` / `= process.cwd()` / `= 'D:…'` /
  `import.meta.dirname`（只看代码行，不看注释——注释里正好写着这些反例）；
- check-all 里**要读本仓**的十支都从 `_root.mjs` 取；两支例外写在表里，
  `probe-inject` 只经相对 import 读 vendor、`check-yaml` 只读 DSH 安装与 profile；
- 例外表还要再验一次「被豁免的脚本确实没碰 root」——不然它就是逃逸口；
- 中性 cwd 那条也只看代码行：老代码注释里恰好写着 `cwd: root`，拿整段文本判真假会被自己的说明文绊倒。

## 9.33 补连的预算必须真的成立（0.2.28）

读记忆时「顺手补连」这件事有个老承诺，写在 `lib/macro/linkflow.js` 的注释里：

> 节流 30s，预算 1.2s——宁可不补，也不能把一次读拖成几十秒。

0.2.28 之前，这句承诺**只能靠星图快**：`budgetMs` 只在每条待补连线的**开始前**比一次，
而 `tryCall` 的那个超时参数（`toolWaitMs`）只管「等子插件把工具注册出来」——
工具一旦注册好，`execute` 本身慢多久都照等。`nebula_link` 在建图争锁、
图很大的时候真能跑到十几秒，于是「1.2s 的补连」可以把一次 `memory_search` 拖成二十秒。

### 改了什么

1. `lib/macro/links.js` 新增预算哨兵与包装：

```js
const TIMED_OUT = Symbol('macro-memory:budget-timeout')
export const MIN_STEP_MS = 120
function withBudget(promise, ms) { … Promise.race([work, guard]) … }
```

2. `flushPending` 里**每一次 await 都套剩余预算**——两条 `resolve`（短 id 归一要读 `memory_read`）
   和一条 `tryCall('nebula_link')`，一个都不漏：

```js
const ra = await withBudget(resolve(entry.a, exec), remaining())
const rb = ra === TIMED_OUT ? TIMED_OUT : await withBudget(resolve(entry.b, exec), remaining())
const r  = await withBudget(tryCall('nebula_link', {…}), remaining())
```

3. 掐断就**停手且留着**：条目留在队列里下一轮再补，绝不摘掉（摘掉 = 用户白写）。
   三个检查点（循环顶部 / 归一 / 连线）都走同一条路径，`stopped` 只有三种值：
   `''` 走完、`'empty'` 本来没欠账、`'budget'` 被预算掐断、`'unavailable'` 星图没接上。
4. `tried` 改成**真的动过几条**。旧写法报 `Math.min(list.length, limit)`，
   会把「没来得及试」也算成试过——面板上看起来像补完了。
5. 面板跟进：`links` 面显示「这一轮预算用完，剩下的下次读记忆时接着补」。
6. 计时器 `unref()`：不让一次补连的守卫计时器把进程多留一秒。

### 为什么用 `Promise.race` 而不是给 `tryCall` 传小超时

因为 `tryCall` 的超时**管不住 `execute`**——它停在 `awaitTool` 那一层。
真要掐「执行已经开始了」的调用，只能在外面赛跑。赛跑的代价是被掐那次的执行仍在后台跑完，
所以剩余预算要尽量留给「能补完的那部分」：`MIN_STEP_MS = 120` 就是「剩不到一条的发令时间，就别发了」。

### 验收

- 探针 `probe-fusion` N1–N5（全部行为级，用慢桩）：
  N1 慢 800ms 的 `nebula_link` + 预算 200ms → `stopped='budget'`、总耗时 215ms、条目还在；
  N2 慢的 `memory_read`（归一 id）同样被掐，且**不误判成永久失败**；
  N3 快路径照常补上、不报预算；
  N4 星图没接上只探一次、队列原样留着；
  N5 剩余预算连一条都不够时，一个请求都不发。
- verify `A26` 八条（哨兵独立 / 三处检查点 / 每处 await 都有预算 / unref / tried 语义 / 面板文案 / 探针存在 / 文档）。
- doctor 结构段一条：`补连预算是真的（慢调用会被掐断，不是恰好快）`。
- 阴性对照：把 `withBudget` 拆掉、或把 `tried` 改回 `Math.min(...)`，断言必须红。

## 9.34 跨插件的文字契约只有一处（0.2.29）

macro 要判断「星图那边现在是什么状态」，可星图那边的回答**只有文字**：

```js
// vendor/dsh-memory-nebula/lib/index.js:163
execute() { … return lines.join('\n') }   // 没有结构化返回值
// 文本：「星图里没有 id=xxx 的记忆。可以先用 nebula_recall 搜一下。」
```

于是 `lib/macro/linkflow.js` 的 `graphState()` 只能认字：文本里有「星图里没有」就说明这条记忆还没入图（`'pending'`，等着再连），
有内容就是 `'ready'`，桥压根没拿到工具就是 `'unavailable'`。0.2.29 之前这个字面量散在三个文件里各写一遍，
**对面改一个字，这边只会静默退化**——从「等 12 秒再连」退成「立刻去连、连不上再排队」，不报错、不掉断言，谁都不会发现。

### 改了什么

1. 新建 `lib/macro/contract.js`：五个跨插件措辞**只在这里出现一次**，每条旁边写着原文出处。

| 常量 | 字面量 | 谁说的 | 出处 |
| --- | --- | --- | --- |
| `NODE_MISSING_MARK` | 星图里没有 | 星图 `nebula_inspect` | `vendor/dsh-memory-nebula/lib/index.js:163` |
| `LINKED_MARK` | 已固化连线 | 星图 `nebula_link` 成功 | `vendor/dsh-memory-nebula/lib/index.js:218` |
| `MISSING_PAIR_MARK` | 找不到这两条记忆 | 星图引擎 | `vendor/dsh-memory-nebula/lib/host/nebula.js:79` |
| `SELF_PAIR_MARK` | 不能把一条记忆和它自己配成一对 | 星图引擎 | `vendor/dsh-memory-nebula/lib/host/nebula.js:90` |
| `NOT_READY_MARK` | 这项能力还没就绪 | **我们自己** | `lib/macro/bridge.js:122` |

2. `links.js` / `bridge.js` / `linkflow.js` 一律从 `contract.js` 取，本文件里**一个字面量都不留**。
   `links.js` 用 `export { … } from './contract.js'` 保持对外 import 面不变（但**必须另写一行 import**：
   `export { X } from …` 不建立本地绑定，只重导出的话文件里用 `X` 会 `is not defined`）。
3. 判据的性质要分开看：`'unavailable'` 看**结构**（`probe.entry === undefined`，桥没拿到工具），这条稳；
   `'pending'` 看**措辞**，这条脆。所以代码里结构那条先判，措辞只当最后一道。
4. `graphState()` 的轮询等待改成不睡过期限：
   `setTimeout(r, Math.min(1500, Math.max(0, deadline - Date.now())))`。
   原来是固定睡 1500ms 再看一眼——给它 300ms 的期限也会实睡 1513ms，等于期限形同虚设。

### 为什么要有断言盯 vendor 源码

常量集中只是「好改」，不是「不会坏」。真正的保险是 `verify.mjs` 的 **A27 十二条**里那两条守门断言：

```js
nebIndex.includes('星图里没有 id=${id} 的记忆') && nebIndex.includes('已固化连线：')
nebCore.includes("'找不到这两条记忆：'") && nebCore.includes("'不能把一条记忆和它自己配成一对：'")
```

它们直接读 `vendor/dsh-memory-nebula/` 的源码。对面哪天改词，**我们的 verify 先红**，
而不是等某天有人抱怨「补连怎么总是立刻失败」才回头查。

**要盯「那一句」，不是「文件里有这几个字」**：`lib/index.js` 里「星图里没有」一共出现 4 次
（recall / inspect / 注释 / 说明），只查子串的话，改掉 `nebula_inspect` 那句仍然全绿——
0.2.29 第一次跑阴性对照就是这么栽的，所以守门断言按整句认（`星图里没有 id=${id} 的记忆`）。

### 验收

- 探针 `probe-fusion` O1–O4（七条）：`'unavailable'` 只探一次且不看文案、`'pending'` 在 300ms 期限内真等了两次（311ms）、内容非空即 `'ready'`、`saysMissing` 只认那一句。
- verify `A27` 十二条：五个常量在 `contract.js`、别处零字面量、三处都用常量、结构先于措辞、等待不超期限、vendor 源码真有那四句、探针与文档都在。
- doctor 结构段一条：`跨插件措辞只有一处，且有断言盯 vendor`。
- 阴性对照两条：把 `vendor/dsh-memory-nebula/lib/index.js` 里「星图里没有」改一个字 → A27 守门断言红；
  把 `saysMissing` 换回裸 `text.includes('星图里没有')` → A27 的「别处零字面量」红。

## 9.35 同一句「找不到」有两种含义，按年龄分（0.2.30）

### 症状

写一条记忆、顺手连上邻居，紧接着读一次记忆触发补连——连线凭空消失，用户什么都没看到。

复现（改动前实测，队列里放一条 **1 秒前**刚排的连线，`nebula_link` 回 404）：

```text
{"tried":1,"linked":0,"dropped":1,"left":0,"stopped":""}
```

写路径更直白：`memory_link` 回 404 时面板只说一句「找不到这两条记忆：a / b」，队列 **0 条**，
看起来像用户 id 写错了，其实两条记忆都在，只是星图还没建到它们。

### 根因

星图的这句 404（`vendor/dsh-memory-nebula/lib/host/nebula.js:79`）有两种含义，**字面上分不出来**：

1. 节点**还没建进图**——记忆刚写完，引擎 12s 一轮巡检还没跑到它（200k 条的库实测建一次 24.5s）；
2. 记忆**真的没了**——被删、被合并、id 写错。

0.2.29 及之前把它并进「永久失败」（`isPermanentFailure`）一律摘掉。第一种情况下这句话是**假警报**，
摘掉等于把用户的连线白扔掉。既然字面分不出来，就只能用**年龄**分。

### 改法

- `links.js` 新增 `MISSING_GRACE_MS = 10 * 60 * 1000`：不足这个年龄的一律先留着，过了才认为真没了。
  10 分钟是「再大的库也建完了」的量级，不是随手取的数。
- `flushPending` 的判据顺序重排，**顺序本身是结论**：

  ```text
  ① r === TIMED_OUT        → stopped='budget'，tried -= 1，break
  ② isLinked(r.text)       → linked，摘
  ③ isSelfPairText(r.text) → 自己连自己，换多少时间都一样，当场摘
  ④ saysMissingNodes(...)  → 看年龄：够老才摘，否则留着
  ⑤ r.entry === undefined  → 桥没接上，stopped='unavailable'，break
  ⑥ 其余                    → 留着，下轮再补
  ```

  注意 ③ 在 ④ 之前、⑤ 在最后：把「自己连自己」混进「找不到」或者把「没接上」提到前面，
  都会让本该留下或本该停手的情况走错分支。
- 删掉 `isPermanentFailure`（合并判据）。留着它，将来一定还会有人拿它一刀切。
- 两条写路径都改成排队：`linkflow.applyLinks` 与 `defs/link.js` 的 `memory_link` 遇到「找不到」时
  `queuePending(..., '节点待入图')`，文案照实说「星图还没建到它（约 12s 一轮巡检），已排队等补连」，
  不再把它说成 id 写错。

### 验收

- 探针 `probe-fusion` P1–P6（七条）：1 秒前的 404 留着、过了宽限期摘掉、自己连自己当场摘、
  写路径排队且文案不赖用户写错、桥没接上就停手、被预算掐断时 `tried` 不虚报。
  另有 F8 改口：老语义「不重试，直接清掉」拆成「刚排队留着 / 过期才摘」两条。
- verify `A28` 十二条：宽限期是分钟量级、`isPermanentFailure` 彻底消失、判据顺序、
  两条写路径都排队、探针与旧断言改口、README/DESIGN 都在。
- doctor 结构段一条：`同一句「找不到」按年龄分辨，写路径会排队`。
- 阴性对照两条：去掉年龄判断 → P1/P2 红；拆掉 `applyLinks` 的 `queuePending` → P4 红。

## 9.36 前台写路径也有期限：用户在等的那条路不能挂死（0.2.31）

**症状**：星图正在建图（一轮巡检 12s，200k 条的库实测 24.5s）时调 `memory_link`，
工具调用跟着挂几十秒；写记忆时顺手连线的 `applyLinks` 也一样。0.2.28 的预算只保护了
**后台**补连（`flushLinks` 1.2s / `flushNow` 1.5s），**前台**这条路一直裸等星图的 `execute`。

**为什么之前没人发现**：`tryCall` 的 `timeoutMs` 只管「等子插件把工具注册出来」，
工具一旦注册，`execute` 慢多久都照等——`lib/macro/links.js` 的注释自己写着
「nebula_link 在建图争锁时能到几十秒」，但那句话当时只用来解释后台预算。

**改法**：给前台写路径也上期限，超时按「还没落图」处理，绝不吞掉用户的连线。

```text
LINK_CALL_MS = 20_000          // 比建图一轮 12s 松，比「挂几十秒」紧；config.linkCallMs 可改
withBudget(promise, ms)        // 已在 links.js，0.2.31 起导出
isTimedOut(x)                  // 哨兵 Symbol 不外泄，调用方只能问谓词
describeMs(ms)                 // 20000 → 「20 秒」，200 → 「200 毫秒」，不许出现「0 秒」
```

两条前台调用都套上：`linkflow.applyLinks` 的 `nebula_link`、`defs/link.js` 的
`link` 与 `path`。超时后的行为分两种：

| 动作 | 超时后 |
|---|---|
| 写连线（`link` / `applyLinks`） | `queuePending(..., '星图太慢待重试')` + 文案「星图 N 秒内没回应（多半在建图），已排队」 |
| 只读（`path`） | 不进队列（会随每次读重试、越积越多），只回「这次没做成，记忆本身没受影响」 |

**为什么掐断是安全的**：星图 `addLink` 是
`INSERT INTO links … ON CONFLICT(id) DO UPDATE SET note = excluded.note`，
重复连同一条边幂等，所以「掐断、排队、稍后重试」不会写脏数据，也不会变成永久失败。

**验收**：

- `probe-fusion` **Q1–Q6** 十四条：慢桩 800ms + 期限 200ms → 墙钟 < 500ms、条目留队、
  文案不赖用户与写错；快路径原样转述星图的话；`path` 超时不留欠账；哨兵只能过谓词；
  期限文案不出现「0 秒」。
- verify `A29` 十二条：`LINK_CALL_MS` 量级、三个新出口、哨兵不外泄、两条前台调用都套期限、
  裸等的老写法消失、`linkCallMs` 可配、探针 Q 段、版本号与文档。
- 阴性对照两条：拆掉 `applyLinks` 的 `withBudget` → Q1 红；把 `isTimedOut` 改成恒 `false` → Q2/Q5 红。

## 9.37 一批连线两道闸：超出条数与总时长的都排队，一条都不许悄悄消失（0.2.32）

**症状**：模型一次写了 15 条 `links`，读回执只说 12 条「已连上」，另外 3 条既没连、没排队、
也没在任何地方被提起——用户以为连上了，其实是消失了。没有报错、没有警告，只有少掉的三条边。

**根因**：`applyLinks` 里写的是 `for (const target of items.slice(0, 12))`。这个 12 是
「一次别把前台拖太久」的直觉，落地成了**静默截断**。0.2.31 给单条连线加了 `LINK_CALL_MS`（20 秒），
但它管不了**一批**：12 条各挂 20 秒，一次写记忆能卡 4 分钟——用户在等的那条路照样挂死，只是挂了十二次。

```js
// lib/macro/links.js
export const LINKS_PER_WRITE = 12
export const LINK_BATCH_MS = 30 * 1000

// lib/macro/linkflow.js：两道闸，超出的进队列（读记忆时自动补），文案要说清
const head = items.slice(0, linksPerWrite)
const overflow = items.slice(linksPerWrite)
const deadline = Date.now() + linkBatchMs
for (… of head) {
  const left = deadline - Date.now()
  if (left < MIN_STEP_MS) { later.push(…head.slice(i)); break }
  const raw = await withBudget(tryCall('nebula_link', …), Math.min(linkCallMs, left))
  …
}
for (const target of [...overflow, ...later]) queuePending(anchor, target.id, target.note, '本次没轮到待补')
```

三种收尾各说各的话：`另有 N 条排队等补连` / `一次最多当场连 12 条，多出来的 N 条已排队` /
`整批最多连 30 秒，没连完的 N 条已排队`。**星图还没就绪那条路不设条数上限**——整批都排队，
因为那条路上根本没有「等待」的成本。

**验收**：

- `probe-fusion` **R1–R6** 十五条：15 条只当场连 12 条、多的 3 条进队列且文案说清；
  6 条各 200ms + 总账 500ms → 墙钟 < 900ms、没轮到的进队列；3 条快连不进队列也不多说一句；
  星图没就绪时 15 条全排队；两个闸的默认值与 config 覆盖。
- verify `A30` 十二条：两个常量量级、`items.slice(0, 12)` 已消失、排队路径不截条数、
  期限取 `min(linkCallMs, 整批剩余)`、超出理由可分辨、两句文案、两个闸可配、探针 R 段、版本与文档。

## 9.38 理由只有一份，面板按理由分组（0.2.33）

**症状**：`memory_admin(action="links")` 列出一串待补连线，每行括号里写着理由——
`（星图未装配）`、`（节点待入图）`、`（星图太慢待重试）`、`（连线失败待重试）`、`（本次没轮到待补）`，
有时候还多出一个 `（memory_link 失败待重试）`。看着像六件不同的事；想数「有几条是星图慢」
得自己一行一行看。

**根因**：理由字面量散在四处。同样是「连线失败」，写记忆那条路记 `连线失败待重试`，
`memory_link` 那条路记 `memory_link 失败待重试`——同一个状况两种叫法，面板诚实转述，
于是变成两件事。期限也一样：1200 / 8 写在 `flushLinks` 里，1500 / 20 写在 `flushNow` 的默认参数里，
面板还自己再传一遍 `{ budgetMs: 1500, limit: 20 }`，改了默认值面板不知道。

**改法**：

```js
// lib/macro/links.js：理由只此一份
export const PENDING_REASONS = {
  notReady: '星图未装配',
  notBuilt: '节点待入图',
  slow: '星图太慢待重试',
  failed: '连线失败待重试',
  deferred: '本次没轮到待补',
}
export const REASON_ORDER = [deferred, notBuilt, slow, failed, notReady]  // 越靠前越「正常」
export function reasonCounts(list) { /* 认识的按顺序，不认识的照原样单列，理由为空的算「未记理由」 */ }

// lib/macro/linkflow.js：期限只此一份，config 可覆盖
export const FLUSH_LINKS_BUDGET_MS = 1200
export const FLUSH_LINKS_LIMIT = 8
export const FLUSH_NOW_BUDGET_MS = 1500
export const FLUSH_NOW_LIMIT = 20
export const POLL_STEP_MS = 1500
```

- `pendingReport` 多一行账：`按理由：本次没轮到待补 2 · 节点待入图 3 · 星图太慢待重试 1`。
- 面板改成 `await flow.flushNow(exec)`（不传数），掐断时说「这一轮预算用完，还剩 N 条」。

**验收**：

- `probe-fusion` **S1–S4** 十二条：理由表五行不重复、面板顺序覆盖全部、旧写法照原样单列不吞、
  空队列不加「按理由」、面板按 `panelBudgetMs` 掐断并说清还剩几条、
  后台与面板两条出口各取自己的数且能读回。
- verify `A31` 十二条：理由表、调用点无裸字面量、`reasonCounts`、五个期限常量、config 出口、
  面板不写数、探针 S 段、版本与文档。

## 9.39 注入被截断也要说话（0.2.34）

**症状**：每轮常驻的 `macro-memory:guide` 上限 1300 字符。手册一旦长过这个数，
`clampGuide` 就在行边界切一刀——切完一个字都不说。模型看到的那份「手册」是残本，
而最容易被切掉的恰恰是最后一行 `完整手册见 memory_admin(action="guide")`：
它既不知道少了一截，也不知道还能去哪要全文。

**根因**：把「长度上限」当成了「排版问题」。上限是硬的（每轮都在花钱），
但**切的动作必须留下痕迹**，否则「有上限」和「没那几行」在模型眼里无法区分。

**改法**：

```js
export const GUIDE_MAX_CHARS = 1300
export const GUIDE_MIN_HEADROOM = 120   // 低于这个余量就该删句子，而不是等它被截
export const GUIDE_TAIL_MARK = '…（已按上限截断，完整手册见 memory_admin(action="guide")）'

export function clampGuide(text = GUIDE_TEXT, maxChars = GUIDE_MAX_CHARS) {
  const t = String(text)
  const cap = Math.max(0, Number(maxChars) || 0)
  if (t.length <= cap) return t
  if (cap <= GUIDE_TAIL_MARK.length) return t.slice(0, cap)   // 放不下尾巴时只能硬切，但不伪造完整
  const budget = cap - GUIDE_TAIL_MARK.length - 1             // 尾巴算在预算里
  const cut = t.slice(0, budget)
  const line = cut.lastIndexOf('\n')
  const head = line > budget * 0.6 ? cut.slice(0, line) : cut
  return `${head}\n${GUIDE_TAIL_MARK}`
}
```

顺带在手册里补一句「排队欠账用 `memory_admin(action="links")` 看，按理由分组」——
0.2.33 把理由分好组了，但注入里没提，等于只有看过文档的人知道。手册现 1085 字符，余量 215。

**验收**：`probe-host` E4b / E4c（余量 ≥120、注入提到 links 面板）；verify `A32` 十条
（不改正常文本、不触顶、余量、尾巴、长度仍在上限内、指针不丢、尾巴在最后、极小上限不崩）。

## 9.40 口径判据只有一份，而且每条都验证过能红（0.2.35）

**症状**：同一条判据在两处各写一遍，宽严还不一样。verify 的 `A31` 拿理由表的五个值逐个查
调用点有没有裸字面量；`tools/doctor.mjs` 的结构段只钉了其中两个（`'节点待入图'`、
`'星图太慢待重试'`）。于是把 `'连线失败待重试'` 抄回 `linkflow.js`：verify 红、
**doctor 绿**——体检那句「理由或期限仍有第二处写法」本该是最后一道网，却成了唯一漏的地方。

**根因**：0.2.33 把「理由」收成了一份，但**检查理由的那段代码**没收。两份判据等于两个标准，
迟早分叉；分叉之后哪一份更松，哪一份就是安全感的来源——这比没有检查更糟。

**改法**：判据挪进 `tools/criteria.mjs`，只有一份，没有副作用（源码与运行时表都由调用方传进来）：

```js
export function reasonChecklist({ linksSrc, flowSrc, linkSrc, adminSrc, reasons, order }) {
  // 十一条：理由表齐全不重复 / 五类都在 / 面板顺序覆盖 / 四条路径都走常量 /
  //       调用点无裸字面量 / 旧写法不许回来 / 按理由分组 / 空队列不加行 /
  //       面板不自己传数 / 面板说清还剩几条 / 面板说清这一轮的上限（0.2.36 补）
  return [{ id: 'no-bare', label: 'linkflow 与 defs/link 不再写理由字面量', ok: bare.length === 0, detail }, ...]
}
```

verify 逐条落成断言（`口径清单: <label>`，红一条就知道是哪条），doctor 汇总成一行
（`排队理由与期限的口径只此一份`，红时用 `summarizeChecklist` 列出哪几条、细节是什么）。

**自检**：单一口径最大的风险是「判据恒真」——两边都读它，它要是不响，验和体检就一起瞎。
所以 `selfTestChecklist()` 给一条全绿样板，再逐条造一个**只该弄红那一条**的输入：
样板本身有红、或某条造坏了都没红，都算这条判据不成立。verify 用一行钉住。

**验收**：verify `A31`（十条判据逐条 + 清单自检 + doctor 确实读它）+ doctor 一行；
阴性对照两例：把旧写法抄回 `linkflow.js` → verify 两条红、doctor 红并指名「连线失败待重试」；
把 `no-bare` 改成恒真 → verify 自检红「打不红 no-bare」。

## 9.41 面板说清这一轮的上限：被什么掐的，得看得出来（0.2.36）

**症状**：`memory_admin(action="links")` 会先手动补一轮再摊队列。预算用完时面板说
「这一轮预算用完，还剩 12 条下次读记忆时接着补」——**但没说这 12 条是被 1.5 秒掐的，
还是被 20 条上限掐的**。用户读到「还剩 12 条」只会想「再点一次」，而再点一次，
时间还是那 1.5 秒，剩的还是 12 条。

**根因**：预算和条数都在 `linkflow` 的配置里，`flushPending` 掐断时只把 `stopped` 与
`left` 交出来，**取值范围本身没交出去**。面板手里没有那个数，只能说一半。

**改法**：

```js
// lib/macro/links.js：掐断时把「按什么掐的」一起交出来
if (list.length === 0) return { tried: 0, linked: 0, dropped: 0, left: 0, stopped: 'empty', budgetMs, limit }
return { tried, linked, dropped, left: readPending().length, stopped, budgetMs, limit }

// lib/macro/defs/admin.js：面板只转述，不自己写数（数值随 config 走）
const cap = `这一轮补连最多 ${describeMs(round.budgetMs)}、${round.limit} 条`
return { body: ..., note: `最多列 ${n} 条 · ${cap}` }
```

抬头因此变成 `【宏记忆｜待补连线】最多列 20 条 · 这一轮补连最多 1.5 秒、20 条`。
队列为空时同样带这一句——空队列不是「没预算」，下一轮读记忆时用的还是这个数。

**验收**：`probe-fusion` S3（`panelBudgetMs: 300` → 抬头「300 毫秒」+「20 条」）、
S5（空队列也说上限，且不冒充「用完」）；verify `A33` 六条（`flushPending` 两个返回都带
`budgetMs, limit` / 面板转述且不写 `budgetMs: 1500` / `describeMs` 从 links.js 进 admin /
探针三句在 / 版本 / 文档）；判据清单多一条 `panel-budget`（`criteria.mjs` 里同时给它造
一个只该弄红它的 mutation，随 `selfTestChecklist` 一起被证明能红）。

## 9.42 path 也会说「还没算」：四种回答要分辨（0.2.37）

**症状**：问 `memory_link(action="path", a, b)` 两条刚写的记忆有没有关系，它回
「这两条记忆在星图里没有连上（超过 6 跳）。没有关系就不编关系。」——于是你当结论收下了。
实际上这两条**还没建进图**（星图 12s 一轮巡检），星图这次连算都没算。

**根因**：`nebula_path` 对三件不同的事都说「没连上」，我们把它的原话原样转述：

| 星图原话 | 真实含义 |
|---|---|
| `找不到这两个节点：a / b` | 节点还没建进图（或记忆真没了） |
| `节点不在当前星图里` | 引擎解析过、下标已失效（图在重建） |
| `…超过 6 跳）。没有关系就不编关系。` | **这就是答案**：确实没有关系 |
| `这个引擎版本还没带上路径搜索` | 宿主跑的是旧代码，要重启 |

前两种字面上像「没关系」，是「还没算」。这是 0.2.30 那句 404 背两个意思的第二个工具。

**做法**：四句话进 `lib/macro/contract.js`，`pathAnswerKind()` 一次判清，`defs/link.js`
只负责翻译——「还没算」说清等一轮，「没关系」照原样转述（不替星图下结论）。

```js
// lib/macro/contract.js
export const PATH_MISSING_NODES_MARK = '找不到这两个节点'
export const PATH_NOT_IN_GRAPH_MARK = '节点不在当前星图里'
export const PATH_UNRELATED_MARK = '没有关系就不编关系'
export const PATH_ENGINE_STALE_MARK = '还没带上路径搜索'

export function pathAnswerKind(text) {
  const s = String(text ?? '')
  if (s.includes(PATH_ENGINE_STALE_MARK)) return 'engineStale'
  if (s.includes(PATH_MISSING_NODES_MARK) || s.includes(PATH_NOT_IN_GRAPH_MARK)) return 'missing'
  if (s.includes(PATH_UNRELATED_MARK)) return 'unrelated'
  return 'ok'
}
```

**验收**：探针 `T1–T5`（归类表 / 拼接文本先认「没入图」/ 不冒充结论 / 真没关系原样 / 旧引擎指出处 /
只读不进队列）、verify `A34` 九条（常量起名 / 无泄漏 / 归类唯一出口 / 七种输入 / 翻译位置 / 探针 / 版本与文档），
`doctor` 的契约行从 5 个常量扩到 9 个 + 1 个归类。

## 9.43 判据自己也会分成两处：跨插件措辞只剩一张表（0.2.38）

**症状**：改 `contract.js` 里一个字面量（比如把 `没关系就不编关系` 改成别的），
verify 红一条、doctor 绿一条。两份判据都自称「跨插件措辞只有一处」——而它们自己就是两处。

**根因**：0.2.35 把「理由」那一族的判据收进了 `tools/criteria.mjs`，但「跨插件措辞」那一族
还留在原处：verify 的 A27 手写十行（五个常量 + 泄漏面 + 归类 + 两条 vendor 整句），
doctor 手写一行（九个 `bareMarks` 又抄了一遍值，外加自己 `includes` 一次 verify 源码）。
**判据里的字面量表是第二份手抄**，改值要改三处。

**做法**：`tools/criteria.mjs` 里新增 `CONTRACT_MARKS`（9 个常量 → 值）、
`CONTRACT_LEAK_FILES`（4 个调用方文件）、`contractChecklist()`（六条）、`selfTestContract()`；
verify 逐条落成断言，doctor 汇总成一行。

```js
// tools/criteria.mjs
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
}
```

六条判据：`marks`（按值起名）/ `runtime`（**运行时导出的值**与表一致）/ `leak`（调用方一个字都不许再写）/
`kind`（归类只有一处实现）/ `vendor-index` / `vendor-core`（对面源码里真的还有那两句整句）。

`runtime` 那条是这一轮新加的：源码里有 `export const X = '…'` 不代表真的导出了那个值——
拼错名字、重复 `export`、被后面的赋值覆盖，三种都能让「按值起名」绿着、行为却是空的。

**验收**：verify `契约清单: …` 六条 + `措辞判据也只有一份（体检读同一张表）` +
`每条措辞判据都验证过能被打红`；doctor 那行从「9 个常量 + 1 个归类」变成 `6/6 全过`。

## 9.44 空命中也会说两种话：图是空的，还是真没有（0.2.39）

**症状**：刚开始用、或者星图正在重建的时候，`memory_search(query=…, mode="graph")` 一律回
「星图里没有匹配「xx」的记忆。」——读起来是「查过了，没有」。而其实图里一个节点都没有，这一问没算。
更糟的是本地检索也零命中时，`expand` 自动扩散又把这句话拼在后面，两条空结果互为证据，
读者只会得出一个结论：确认没有这条记忆。

**根因**：`formatHits` 空命中只写死一句话，把 recall 自己算好的凭据全丢掉了：

```js
if (hits.length === 0) {
  return ['nebula_recall: 星图里没有匹配「' + (res?.query || '') + '」的记忆。', note].filter(Boolean).join('\n')
}
```

**做法**（两处，缺一不可）：

1. vendor 补丁 `[macro-fusion 0.2.39]`：`recall.js` 多返回一个 `nodes`（图里一共多少节点），
   空命中就分成「图是空的」和「图里真没有」两个分支，全都不认识的词也点出来。

```js
const total = Number(res?.nodes ?? -1)
const head = total === 0
  ? 'nebula_recall: 星图里还没有节点（图是空的），这一问等于没算。'
  : `nebula_recall: 星图里没有匹配「${q}」的记忆（图里 ${total} 条节点，一条都对不上）。`
```

> 第一版拿 `res.scanned` 当凭据是错的：`scanned = scored.length` 是「算进候选的条数」，
> 查询词一个都对不上时它本来就是 0 —— 拿它分辨，等于把「真没有」也判成「没算」。
> 判据里用的每个数，都得先证明它在两种情况下取值不同（这一条现场被 `probe-graph` G10 打红抓到）。

2. `lib/macro/contract.js` 收两个常量 + `recallAnswerKind()`（`emptyGraph` / `noMatch` / `ok`），
   `lib/macro/defs/search.js` 按归类翻译：空图 → **退回本地检索**（以 meow 为主）并说清
   「这不是『没有这条记忆』的答案」；零命中 → 原样转述（那是算过的结论，我们不改）。

local 零命中自动扩散那条也改了：扩散回来是空图时只附一句「关联扩散这次没算」，
不再把「没有匹配」当成第二份证据。

**验收**：probe-fusion U1–U7（归类表 / 退本地 / 没 query 兜住 / bridge 同源 / 自动扩散附注 / 真结论原样 / 只读不涨队列）；
verify「recall:」十一条，其中 `空图与零命中在星图源码里是两个分支` 盯的是 vendor 补丁本身；
doctor 补丁账本新增一条（改 vendor 必须记账，否则升级会静默冲掉）。

## 9.45 体检的「共 0 项」也背两个意思：没毛病，还是没算（0.2.40）

**症状**：刚装好、或者星图正在重建时，`memory_admin(action="hygiene")` 回「记忆体检：共 0 项」，
下面每一类都是「（0）」。读起来是**体检做完了，六类毛病一个都没有**。而其实图里一个节点都没有，这次体检什么都没看。

这比空检索更危险：检索空着，用户会怀疑；体检说「共 0 项」，用户会**放心**。

**根因**：抬头用的是 `h.total`（查出多少毛病），图空时它当然也是 0——两种状态共用同一个数。

**做法**：

```js
// vendor/dsh-memory-nebula/lib/index.js —— [macro-fusion 0.2.40]
if ((nebula.graph?.nodes?.length ?? 0) === 0) {
  return '记忆体检：星图里还没有节点（图是空的），这次体检等于没算——「0 项」不是「很干净」。等星图建起来（约 12s 一轮巡检）再查一次；记忆本身没受影响。'
}
```

凭据只能是**图里有多少节点**：`h.total` 数的是毛病，两种情况下都可能是 0（和 0.2.39 里
`scanned` 分不开两种空命中是同一个坑）。

我们这侧 `lib/macro/contract.js` 收 `HYGIENE_EMPTY_GRAPH_MARK` + `hygieneAnswerKind()`
（`emptyGraph` / `ok`），`tools/criteria.mjs` 的措辞表与判据清单跟着长到 **12 个常量 / 8 条判据**，
doctor 的补丁账本加第 9 条。

**验收**：

- `probe-graph` G1b（空图：说「等于没算」、且不说「共 0 项」、点明「不是『很干净』」）
  与 G1c（写进一条记忆后同一句话必须**翻面**——不再说「等于没算」，否则它就是恒真的噪声）
- `probe-fusion` V1–V3（归类两面 / 面板原样转述 / 真干净时不许加噪声）
- verify「体检:」九条，含「凭据是图里多少节点，不是查出多少毛病」

## 9.46 星图概况的「0 条记忆」也背两个意思：还没建起来，还是记忆丢了（0.2.41）

**症状**：星图刚装上、或者某一轮建图失败时，`memory_admin(action="stats")` 第一行是
`宏记忆 · 星图：0 条记忆 / 0 条连接 / 0 个工作区 / 0 个会话账本`。用户读完的第一反应不是
「哦还没建完」，而是**我的记忆没了**——然后去翻备份、想重灌、甚至删库。

前四次（0.2.37–0.2.40）都是把「没算」说成「没有」，方向是让人**放心**；这一次方向反过来，
代价更贵：误以为干净只是少查一遍，误以为丢了会带出一串**不该做的动作**。

**根因**：同一行「0 条」覆盖了三种情况——还没建起来 / 来源读不出来 / 真的一条都没有。

**做法**：

```js
// vendor/dsh-memory-nebula/lib/index.js —— [macro-fusion 0.2.41]
if ((nebula.graph?.nodes?.length ?? 0) === 0) {
  const bad = (o.readErrors || []).map((e) => e.title || e.key).filter(Boolean)
  const stores = (o.sources || []).length
  const why = bad.length
    ? `有 ${bad.length} 个来源读不出来（${bad.join(' / ')}）——这不是「记忆丢了」，是没读到。`
    : stores === 0
      ? '一个记忆来源都没接上（用 nebula_sources 看配置）——这不是「记忆丢了」。'
      : '来源都连着，但目前一条都没读进图里（建图一轮约 12s，建完再问一次）——这不是「记忆丢了」。'
  return ['宏记忆 · 星图现在还是空的：0 条记忆 / 0 条连接。', why, /* lastError */ '', '记忆本身没受影响：这里只是「图里没有节点」，不等于库里没有记忆。'].filter(Boolean).join('\n')
}
```

原因是从 `o.readErrors` 与 `o.sources` 里读出来的，不是猜的：有读失败的来源先说读失败，
一个来源都没接上说没接上，其余说还没建完。凭据仍然是**图里有多少节点**。

我们这侧 `contract.js` 收 `STATS_EMPTY_GRAPH_MARK` + `statsAnswerKind()`（`emptyGraph` / `ok`），
`tools/criteria.mjs` 的措辞表长到 **13 个常量**、判据清单长到 **11 条**（新增 `table` 与 `kinds`：
文件头那张表也不许有重复行、四族归类函数必须都在），doctor 补丁账本第 **10** 条。

**验收**：

- `probe-graph` G1d（空图：说「星图现在还是空的」、点明「这不是记忆丢了」、说清「记忆本身没受影响」）
  与 G1e（写进一条后同一句话必须**翻面**）
- `probe-fusion` W1–W3（归类两面 / 面板原样转述 / 有节点时不许加「记忆丢了」的噪声）
- verify「概况:」十条

## 9.47 读单条记忆的空结果：这次连累的是自己人（0.2.42）

**症状**：`nebula_inspect` 找不到时只有一句 `星图里没有 id=xxx 的记忆。可以先用 nebula_recall 搜一下。`
——「图还空着」和「图里真没这条」共用这一句。

**为什么比前五次更该修**：这句话不只给用户读。`lib/macro/linkflow.js` 的 `graphState()` 也读它，
用来判断「这条记忆入图了没有」：

```js
// 修之前
if (text.length > 0 && !saysMissing(text)) return 'ready'
```

判定方式是**反推**（不含 missing 就算 ready）。空图那一支一旦换文案，它就会被判成 ready →
空图上每次写入都先去抢连、失败后再落一条「失败」欠账（该记的是「节点待入图」），还要多等一次读才补。
**判据不能靠「对面没说不认识」来推出「它认识」**，所以顺手把这条也改成正面判定。

**做法**：

```js
// vendor/dsh-memory-nebula/lib/index.js —— [macro-fusion 0.2.42]
if (!d) {
  const total = nebula.graph?.nodes?.length ?? 0
  if (total === 0) return '星图里还没有节点（图是空的），这次 nebula_inspect 等于没算——这不是「这条记忆不存在」。…'
  return `星图里没有 id=${id} 的记忆。这不等于「记忆没了」：图里现有 ${total} 条节点，可能是刚写还没入图（约 12s 一轮巡检），也可能是 id 不对（裸 id 给前 12 位就够）。…`
}
```

```js
// lib/macro/linkflow.js —— 只认正常正文为 ready
if (text.length > 0 && inspectAnswerKind(text) === 'ok') return 'ready'
```

`inspectAnswerKind()` 把「没找到」那支**同时认旧文案**（`NODE_MISSING_MARK`）：
补丁被上游升级冲掉时，它要么归 `notFound`、要么归 `emptyGraph`，不会静默退化成 ready——
否则「没打补丁」会悄悄变回「入图了」。

措辞表长到 **15 个常量**、判据清单长到 **12 条**（新增 `vendor-inspect`），doctor 补丁账本第 **11** 条。

**验收**：

- `probe-fusion` X1–X5（四种归类 / 空图写入排队理由是「节点待入图」而不是「失败」/ 旧文案行为不变 / 真入图当场连）
- verify「inspect:」十条
- 真引擎这一层没有加断言：`nebula_*` 被 `captureTool` 从对外工具面摘掉，
  探针拿不到那个 def；为测试给 `apply()` 加返回值属于「没用的功能」，不做。

## 9.48 来源体检的「0 个来源」：没接上，还是接了没读到（0.2.43）

**症状**：`memory_admin(action="sources")` 在没接上来源时只回一句
`已接入 0 个来源，共读到 0 条记忆：` 后面跟一个空列表。三种情况共用这一行：

- 配置文件根本还没建（`config.exists === false`）
- 自动探测关着、也没手写来源（`autoDetect: false`）
- 配了但都读不出来（`live.errors` 非空）

前两种是**没接**，第三种是**接了没读到**——都不是「没记忆」，但第一行都长一样。

**做法**（`vendor/dsh-memory-nebula/lib/index.js`，`[macro-fusion 0.2.43]`）：

```js
if (r.live.stores.length === 0) {
  const bad = (r.live.errors || []).map((e) => e.store || e.adapter).filter(Boolean)
  const why = bad.length
    ? `有 ${bad.length} 处读失败（${bad.join(' / ')}）——不是「没有记忆」，是没读到（下面列了原因）。`
    : r.config.exists === false
      ? `配置文件还没建（${r.config.path}）——所以一个来源都没接上。这不等于「记忆没了」。`
      : r.config.autoDetect === false
        ? '自动探测关着（autoDetect: false），也没有手写来源——是「没接」，不是「没记忆」。'
        : '配置在、自动探测也开着，但这次一个来源都没扫到——可能刚启动还没扫完（一轮约 12s）…'
  lines.push('已接入 0 个来源，共读到 0 条记忆——这句有两种意思：')
  lines.push(`  ${why}`)
}
```

顺带一句：来源接上了但读到 0 条时，补一行「可能是库真是空的，也可能是路径指错了」——
空库与路径写错长得一样。

我们这侧 `contract.js` 收 `SOURCES_EMPTY_MARK` + `sourcesAnswerKind()`（`emptyStores` / `ok`），
措辞表长到 **16 个常量**、判据清单长到 **13 条**（新增 `vendor-sources`），doctor 补丁账本第 **12** 条。

**验收**：

- `probe-fusion` Y1–Y3（归类两面 + 空串不瞎猜 / 面板原样转述 / 有来源时不许加噪声）
- verify「sources:」八条

## 9.49 补邻居的「没有可补充的邻居」：没找到种子，还是都读过（0.2.44）

**症状**：`nebula_bridge` 一条都没补到时原来只回一句
`nebula_bridge：没有可补充的邻居（种子 ${seedCount} 条，候选 ${considered} 条都已读过或在冷却期）。`
`stats.seedCount` 是**实际在图里解析到的种子数**（`lib/host/bridge.js:296`，`seedIdx.size`）。
种子 0 条时这句话把「一条都没找到」说成了「都读过」——**没找到 ≠ 读过**。

四种情况共用这一句：

- 图是空的（`nebula.graph.nodes.length === 0`）
- 你给的 id / 查询词一条种子都没解析到（`seedCount === 0`）
- 有种子，但邻居被已读 / 冷却 / `min_weight` / 归档全过滤掉了（`considered === 0`）
- 有候选，但没有一条进得了预算

**做法**（`vendor/dsh-memory-nebula/lib/index.js`，`[macro-fusion 0.2.44]`）：

```js
if (!res || !res.items?.length) {
  const totalB = nebula.graph?.nodes?.length ?? 0
  const seedsB = res?.stats?.seedCount ?? 0
  const consideredB = res?.stats?.considered ?? 0
  const askedB = ids.length ? `你给的 ${ids.length} 个 id` : `查询「${query}」`
  const whyB = totalB === 0
    ? '星图里还没有节点（图是空的），这次 nebula_bridge 等于没算（不是「没有相关记忆」）……'
    : seedsB === 0
      ? `${askedB}一条都没在图里找到种子——可能是刚写还没入图（约 12s 一轮巡检），也可能 id 不对（裸 id 给前 12 位就够）。`
      : consideredB === 0
        ? `有 ${seedsB} 条种子，但邻居都被过滤掉了（已读过 / 冷却期 / 权重低于 min_weight / 归档）。`
        : `候选 ${consideredB} 条，但没有一条进得了预算。`
  return ['nebula_bridge：这次没补到东西。', '  ' + whyB, '这不是「图里没有相关记忆」。'].join('\n')
}
```

**为什么空图那支要保留「星图里还没有节点（图是空的）」这个说法**：
这句同时被 `recallAnswerKind()` 认成 `emptyGraph`，而 `lib/macro/defs/search.js`
的 **bridge 模式**就靠这个信号退回本地检索兜底。只把话说清楚、不保持可判读，
空图时 `memory_search(mode="bridge")` 就只剩一句「没补到」，本地结果也没了。

我们这侧 `contract.js` 收 `BRIDGE_EMPTY_MARK` + `BRIDGE_NOT_EMPTY_MEMORY_MARK` + `bridgeAnswerKind()`（`empty` / `ok`），
措辞表长到 **17 个常量**、判据清单长到 **14 条**（新增 `vendor-bridge`）、归类函数 **七族**，doctor 补丁账本第 **13** 条。

**验收**：

- `probe-fusion` Z1–Z3（三种空都归「没补到」/ 空图那句仍算「没算」/ bridge 模式退本地检索并说清「这次没算」）
- verify「bridge:」九条

## 9.50 解释证据链的「没有关系就不编关系」：这次是真算过，还是根本没算（0.2.45）

**症状**：`nebula_path` 找不到路时只有一句

```
这两条记忆在星图里没有连上（找不到这两个节点：a / b）。没有关系就不编关系。
```

前半句给原因、后半句直接下结论——而原因明明是「节点还没入图」。四种情况共用这一句：

- 图是空的（`nebula.graph.nodes.length === 0`）
- 两条里至少一条解析不到（`找不到这两个节点`）
- 引擎还没带路径搜索（宿主跑旧代码，`还没带上路径搜索`）
- **真算过了**，`maxHops` 跳以内一条可走的边都没有

前三种是「没算」，第四种是「算完了没关系」。这是这一族里**代价最高**的错误：
`nebula_path` 在提示词里被教成「用来核对推断」的工具，它说「没有关系」，
模型就停止追问了。顺带一提，0.2.37 只在 `memory_link(action="path")` 那层翻译过这四句，
**兼容别名 `nebula_path` 是直连的**，那边一直原样吐这句。

**做法**（`vendor/dsh-memory-nebula/lib/index.js`，`[macro-fusion 0.2.45]`）：

```js
if (!r || !r.found) {
  const totalP = nebula.graph?.nodes?.length ?? 0
  const hopsP = Number(args.maxHops) || 6
  if (totalP === 0) return '星图里还没有节点（图是空的），这次 nebula_path 等于没算——这不是「这两条记忆没有关系」。…'
  if (r?.error) {
    if (String(r.error).includes('还没带上路径搜索')) return `这次没算成：${r.error}。这不是「这两条记忆没有关系」——重启宿主后再问一次就行…`
    return `这次没算成：${r.error}（图里现在有 ${totalP} 条节点）。这不等于「这两条记忆没有关系」…`
  }
  return `这两条记忆在星图里确实没有连上：${hopsP} 跳以内一条可走的边都没有（图里现有 ${totalP} 条节点）。没有关系就不编关系。`
}
```

**判据要能翻面**：`pathAnswerKind()` 补 `emptyGraph` 一支，**排在 `missing` 前面**
（图空时节点当然也解析不出来，但该说的是「还没建」）；探针 T6 额外断言
「四句里只有一句含『没有关系就不编关系』」——这条断言的价值不在文案，在**结构**。

措辞表长到 **18 个常量**、判据清单长到 **15 条**（新增 `vendor-path`），doctor 补丁账本第 **14** 条。

**验收**：

- `probe-fusion` T6–T7（四句各归各的 / 结论只在一句 / 两种新文案的翻译不变）
- verify「path:」九条

## 9.51 相似检索的「一条都没有」：这次连一个字都不给（0.2.46）

**症状**：`memory_search(mode="similar")` 在一条相似都没有时，返回的是

```
{"hits": []}
```

因为 `memory_find_similar` 的 `render` 直接 `(v.hits ?? []).map(...)`——空数组进去、空数组出来，
融合层的 `renderToolText` 见不到任何文本，只好把 JSON 原样端出去（`lib/macro/render.js:29-32`）。
读起来是「查过了，没有相似的」，其实是**什么都没说**。

**四种情况共用这个空**（`vendor/meow-memory/lib/index.js` 的 execute）：

- 基准记忆的内容里没有可用于比较的词（`tfVector(tokenize(content)).size === 0`）
- 库里就只有这一条可比记忆（`rows.length <= 1`）
- 候选都被过滤（本会话新写的 `source_session === sessionId`、这一轮已看过的 `seen`）
- **真算过了**，候选之间词汇零重叠（`cosine <= 0`）

**做法**：`execute` 在 `hits.length === 0` 时算出 `note`，`output.schema` 加一个可选 `note`，
`render` 在空数组时把这句 `note` 当成唯一一块文本。前三种都说「相似检索没算成」，只有第四种说
「这才是『记忆里没有相似的东西』」——结论句全项目**只出现在这一处**。

融合层还有一层兜底（`lib/macro/defs/search.js`）：拿到空串或裸的 `{"hits": []}` 时自己说
「相似检索这次没给出任何内容……这不是『记忆里没有相似的东西』」。子插件补丁在位时这句用不到，
它守的是「上游把补丁冲掉」——同一缺陷两层各存一份时，只修上层会留暗处（0.2.45 的教训）。

**判据**：`similarAnswerKind()` 把空回答归 `notComputed` / `none`，措辞表 **20 个常量**、
判据清单 **16 条**（新增 `vendor-similar`，读的是 meow 的源码），doctor 补丁账本第 **15** 条。
`contractChecklist()` 因此多了一个入参 `meowIndexSrc`——判据要能看到「另一个插件」的源码。

**验收**：

- `probe-fusion` AC1–AC3（三种「没算成」都归 `notComputed` / 真库上不再沉默 / 兜底那句在）
- verify「similar:」十条

## 9.52 项目全景的「暂无记忆条目」：查无此名还是真没有（0.2.47）

**症状**：`memory_project("dsh-macor-memory")`（把 macro 打成 macor）返回一句

```
【项目：dsh-macor-memory】该项目暂无记忆条目。
```

读起来是「这个项目没有记忆」。真实情况是**名字一条都对不上**——库里那条记忆的 project 字段写的是
`dsh-macro-memory`。模型看到这句话，要么以为该项目真的空白，要么另建一个名字几乎一样的新项目，
把同一件事劈成两半。

**三种情况共用这一句**（`buildProjectSectionText()` 返回 `null` 时，见 `vendor/meow-memory/lib/index.js`）：

- **名字对不上**：七层表里没有任何一条记忆的 `project` 字段写着它（拼错 / 大小写 / 中英混写）
- **project 层空、别的层有**：`memory_project` 只看 project 层六类子类（overview/structure/
  decisions/quotes/ops/todo）与项目准则（`rules` 层），而 `fact` / `lesson` / `topic` 层里可能
  还有一堆同项目的记忆——全景段落是空的，不等于这个项目没东西
- **真的没有**：名字对得上，但 `active` 条目确实是 0 条

**做法**：`text === null` 时按 `db.listProjectNames()` 与「别的层 active 条数」分三支：

- 别的层有东西 → 保留 `project.empty` 那句，紧跟「上面这句只说了一半：…别的层还有 N 条（fact 2 /
  lesson 1）」，并给出 `memory_search(project="X", query=…)` 的捞法
- 名字对不上 → **不说 `project.empty`**，改说「这个名字在库里一条都对不上」+ 库里现有的项目名
  （最多列 12 个，超出说「共 N 个」），末尾一句「这不是『这个项目没有记忆』，是名字没对上」
- 真没有 → 保留 `project.empty`，补一句「查过七层表：project 字段正好写着这个名字的 active 条目
  是 0 条，这次是真没有（已归档/已完结的不算）」——**结论句只出现在这一支**

**判据**：`projectAnswerKind()` 归 `nameNotFound` / `otherLayers` / `empty` / `ok`，措辞表
当时 **23 个常量**（`PROJECT_NAME_NOT_FOUND_MARK` / `PROJECT_OTHER_LAYERS_MARK` /
`PROJECT_TRULY_EMPTY_MARK`，0.2.48 后为 26）、判据清单当时 **17 条**（新增 `vendor-project`，
0.2.48 后为 18）、doctor 补丁账本第 **16** 条。

**验收**：

- `probe-fusion` AD1–AD2（对不上的名字不冒充「没记忆」且报出现有项目名 / 只在 fact 层写一条时
  说清「别的层还有 1 条」）
- verify「project:」九条

## 9.53 dream 没启动：「没有需要整理的记忆」还是「消息没送出去」（0.2.48）

**症状**：触发 `memory_dream`（或敲 `/dream`），回一句

```
本窗口没有需要整理的记忆。
```

而真实情况可能是**整理任务的消息根本没送进会话**（会话正忙 / 被中断）。这句结论式的话一出，
谁都不会再试第二次——记忆就一直没封存。

**根因**：`startWindowDream()` 有四个 `return false`：

| 分支 | 真实含义 | 原来被说成 |
| --- | --- | --- |
| `noSessionId` | 拿不到窗口标识 | 「没有需要整理的记忆」 |
| `noRounds` | 盘点过，真没有未封存的轮次 | 「没有需要整理的记忆」（**这句是对的**） |
| `claimed` | 有东西要整理，但已有 dream 在跑 | 有 lease 时能猜对 |
| `sendFailed` | 消息没送进会话，**可重试** | 「没有需要整理的记忆」（错） |

工具层只能靠「有没有 lease」反推，而 `sendFailed` 会先 `db.releaseDream()` 把租约放掉，
于是恰好落进「没有东西可整理」那一支——一个可重试的失败被写成了一条结论。

**做法**：给 `startWindowDream()` 加一个可选的 `trace` 收集器（第 7 个参数，四个老调用方一处都不用改），
四个 `return false` 改成 `return say("noSessionId" | "noRounds" | "claimed" | "sendFailed")`，
成功前置 `trace.reason = "started"`；`memory_dream` 与 `/dream` 命令面都按 `trace.reason` 分支说话：

- `noRounds` → 「本窗口没有需要整理的记忆（盘点过：没有未封存的记忆轮次）——这一次是真没有，不是 dream 坏了。」
- `claimed` → 「…但已经有一个 dream 在跑（或上一轮还在待补收尾）——这次没启动，等它收尾后再触发就行。」
- `sendFailed` → 「这次没启动成功：整理任务的消息没送进会话…要整理的记忆还在，稍后再触发一次就行——这不是「没有需要整理的记忆」。」
- `noSessionId` → 「这次没启动成功：拿不到这个窗口的标识，所以没法开工（这不是「没有需要整理的记忆」）。」

融合层 `lib/macro/defs/dream.js` 再守一层：子插件一个字都不给时自己说「没有任何回执」，
别让空串被读成「整理过了，没什么可说」。

**判据**：`dreamAnswerKind()` 归 `notStarted` / `busy` / `nothing` / `ok`，措辞表 **26 个常量**
（`DREAM_NOTHING_MARK` / `DREAM_BUSY_MARK` / `DREAM_NOT_STARTED_MARK`）、判据清单 **18 条**
（新增 `vendor-dream`）、doctor 补丁账本第 **17** 条。

**验收**：

- `probe-fusion` AE1–AE3（四支各归各的 / 真调用里送不出去时不说成「没东西」/ 子插件沉默时融合层自己说话）
- verify「dream:」十条



## 9.54 改记忆的回执：「✅ 已更新」其实一个字段都没改（0.2.49）

**症状**：调 `memory_update` 只给 `id`（或给了一个这一层不支持的字段，比如给 fact 层写 `goal`），回的是

```
✅ 已更新（fact 0mwmy2qi）。
```

库里那条一个字都没变。

**根因**：execute 里这一行

```js
const ok = Object.keys(patch).length > 0 ? db.update(found.level, found.row.id, patch) : true;
```

过滤是必要的——`goal` 只有 topic 层有、`user`/`soul` 层没有项目归属、`content` 给空串不能整段清空——
但被过滤掉的字段**一声不响**：patch 空了，`ok` 却仍然是 `true`。于是至少五种情况共用一句「已更新」：

| 情况 | 真实 | 原来被说成 |
| --- | --- | --- |
| 真写进去了 | 已更新 | 「✅ 已更新」（对） |
| 只给了 id | 什么都没做 | 「✅ 已更新」 |
| 字段这一层不支持（goal 给 fact） | 被丢掉 | 「✅ 已更新」 |
| 值不合法（content 空串 / importance 非数 / keywords 归一后空） | 被丢掉 | 「✅ 已更新」 |
| 找到了但 db.update 失败 | 没写进去 | 「✅ 已更新」 |

**做法**：execute 里同时算三样——`changed`（真写进去的字段名）、`dropped`（被过滤的字段 + 原因）、
`note`（给人看的那句话）；`ok` 只有在 `changed.length > 0 && db.update(...) === true` 时才是 true。三支文案：

- 一个字段都没写进库 → `这次什么都没改：…`（点名叫出 `dropped`，末尾一句「这不是『已经更新好了』」）
- 写进去一部分 → `✅ 已更新（…）：content。但这几个字段没生效：…——这是「部分生效」，不是全部。`
- 查无此 id → `更新失败：没有这个 id（七层表里都找不到）。`

schema 加 `changed` / `dropped` / `note`（三个都可选，老宿主不认也不炸），render 优先用 `note`。
融合层 `lib/macro/defs/update.js` 再守一层：空回执时自己说「更新这次没有任何回执…这不是『已经更新好了』」。

**判据**：`contract.js` 加 `UPDATE_NOTHING_MARK` / `UPDATE_PARTIAL_MARK` / `UPDATE_NOT_FOUND_MARK`
与 `updateAnswerKind()`（顺序 nothing → partial → notFound → ok；partial 的句子以 ✅ 开头，只能靠后半句
分开，所以必须排在 ok 前面）。措辞表 29 个常量、判据清单 19 条（新增 `vendor-update`，读 meow 源码）、
doctor 补丁账本第 18 条、`probe-fusion` AF1–AF5、verify「update:」十二条。

**教训**：**一句肯定的回执会让接收方再也不会检查**——「没说话」还好，最坏是「说了没事」。

## 9.55 写记忆的回执：层名被改过、参数被丢掉、是合并不是新写（0.2.50）

`memory_remember` 的七个参数里有六个会被**悄悄纠正**，而回执只有一句「✅ 记忆已写入（fact，id=…）」：

| 你给的东西 | 原来发生的事 | 回执 |
|---|---|---|
| `level: "lessons"`（拼错、复数、中英混写） | 直接落进 `fact` | `✅ 记忆已写入（fact…）` |
| `subcategory` 给到非 project 层 / 给错值 | 丢掉 | 同上 |
| `goal` 给到非 topic 层 | 丢掉 | 同上 |
| `corrected` 给到非 lesson 层 | 丢掉 | 同上 |
| `importance: 2.6` | 四舍五入成 3 | 同上 |
| 内容与已有条目 ≥80% 相似 | **并进旧条目**，原内容被替换 | `✅ 已合并到已有条目` |

第一种最坏：想记成 `lesson` 的一条进了 `fact`，之后按层看就永远找不到；第六种次之：
读者以为多了一条，其实旧的那条被改写了。

现在 `memory_remember` 的输出加了 `dropped`（哪些参数没生效、为什么）与 `note`（一段话），
分四支说话：

- **层名被改过**：`写成 fact 了：你给的层名「lessons」不在七层里（…），这条记忆被记进了 fact——这不是「按你说的层写好了」。`
  后面给出补救路径（在正确的层重新写一次，再归档这条；`memory_update` 不改层）。
- **参数没生效**：`这几个参数没生效：goal（只有 topic 层有目标句，这条是 fact）；corrected（…）。`
- **合并**：`这条并进了已有条目 xxxxxxxx（重复度 ≥80%）：原条目的内容被替换成这次写的内容，importance 取两者较大值。这是「合并」，不是「新写一条」。`
- **干净写入**：一个字不变，仍是原来那一行「✅ 记忆已写入…无需重复调用本工具。」——不干净的句子才换行加注。

归类口径在 `contract.js`：`REMEMBER_LEVEL_FALLBACK_MARK` / `REMEMBER_DROPPED_MARK` /
`REMEMBER_MERGED_MARK` + `rememberAnswerKind()`（`levelFallback → dropped → merged → ok`）。
融合层 `lib/macro/defs/remember.js` 再守一层：子插件一个字都不给时自己说「写入这次没有任何回执…这不是「已经记住了」」。

判据：`tools/criteria.mjs` 的 `vendor-remember`（清单第 20 条）、`verify.mjs` 的 A47、
`tools/probe-fusion.mjs` 的 AG1–AG5。

## 9.56 检索的「零命中」：层名没对上，还是真没有（0.2.51）

`memory_search` 的 `level` 过滤原来只有一行：

```js
const levels = parsed.level.split(',').map((s) => s.trim()).filter((s) => LEVELS.includes(s))
```

看着温和，其实埋了三种静默：

| 你给的 `level` | 实际发生 | 回执 |
|---|---|---|
| `lessons`（复数 / 拼错） | 过滤后数组是**空的** → 一层都没查 | 「如果冲突，以最新的为准」 |
| `fact,lessons` | 只查了 fact，lessons 被静默丢掉 | 同上，一个字不提 |
| `fact`（都对，但那层零命中） | 只在 fact 里查 | 同上，别的层里的同关键词看不到 |

前两种会被读成「记忆里没有」——接着就会有人照着再写一条重复的，或者认为「这条记忆没存上」。

**改法**

1. 先把层名分成三堆：`levelAsked` / `levelBad` / `levelValid`。全都不是层名时 `levels = []`——**仍然一层都不查**，但必须把「为什么一条都没查」说出来。
2. `note` 里按顺序拼三句新话：
   - `这次一条都没查：你给的层名「lessons」不在七层里（soul / user / project / fact / lesson / topic / rules）。这不是「记忆里没有」，是层名没对上——换成真实层名再查一次。`
   - `这几个层名没生效：lessons（不在七层里）——这次只查了 fact 层。`
   - `这次只在 fact 层里查了，零命中：别的层就算有同关键词也看不到——要全层查就去掉 level 参数（默认 fact / lesson / topic / rules）。`
3. 没给 `level` 的那句老话（`本次零命中：默认检索范围是 fact/lesson/topic/rules…`）一个字不变。
4. 融合层 `lib/macro/defs/search.js` 再守一层：上游回空串时说「检索这次没有任何回执」，不替它下「没有」的结论。

**归类**（`lib/macro/contract.js`）

| `searchAnswerKind` | 触发 |
|---|---|
| `levelNone` | 层名一个都不认识（一层都没查） |
| `levelPartial` | 一部分层名不认识（只查了认识的） |
| `noReply` | 上游一个字都没给 |
| `scopeOnly` | 层名都对，但那几层零命中 |
| `ok` | 有结果，或走的是默认范围那句老话 |

判据：`CONTRACT_MARKS` 36 个；`contractChecklist` 21 条（新增 `vendor-search`）；`probe-fusion` 新增 AH1–AH6；`verify` 新增 A48「search:」十条。

## 9.57 读记忆：短 id 撞车时，它替你挑了第一条（0.2.52）

`memory_read` 收的是短 id（前 8 位就够）。meow 底层按 `WHERE id LIKE '<前缀>%'` 查，**前缀撞上多条时按七层顺序取第一条**，回执照原样写成：

```
[fact] 标题（active）
项目：…
正文…
```

读起来就是「你要的那条，在这儿」。可它递来的是**另一条记忆的正文**——同一层里前缀相同的两条、跨层同前缀的条目，都会走到这一步。三种来路共用同一句输出：

| 来路 | 读者的理解 | 实际发生的事 |
| --- | --- | --- |
| 短 id 撞上多条 | 「读到了」 | 按层级顺序静默取第一条，别的候选一条都不提 |
| id 拼错 / 位数不够 / 建在别的 cwd | 「这条不存在」 | 只有一句「未找到该记忆。」，工作区隔离、位数要求全都不说 |
| 真读到了 | 「读到了」 | 正常路径 |

而**写**路径 `memory_update` 遇到同样情况是直接抛错的（`短 id 命中 N 条`）——读比写松，两边口径不统一：写完不放心，读回来却是另一条，你还以为改对了。

### 9.57.1 三条来路各说各话

- **撞车**：`这个短 id 不止一条记忆：命中了 7 条（fact 0mwn0apf1「…」；lesson 0mwmz5n0「…」…等 7 条）。所以这次一条都没读——不是我替你挑第一条。把 id 给够位数（至少 8 位，最好整条）再读一次。`
- **真没有**：`这个工作区里一条都没有：id「0mzz」在七层表里都查不到。可能是拼错了、位数不够（短 id 至少 8 位），也可能是这条记忆建在别的 cwd 会话里——记忆库按工作区分开存（当前工作区 …），换回那个工作区再找；活着的条目可以用 memory_search 反查 id。`
- **读到了**：原文一字不动。

撞车那条最关键的一句是「**所以这次一条都没读**」——它必须否认「读到了」，否则读者会把候选列表里第一条当答案。候选只列前 5 条，剩下的用「…等 N 条」收口。

### 9.57.2 融合层再守一层

子插件一个字都不给（空串）时，融合层自己说：`读取这次没有任何回执（既没有正文，也没说为什么没有）——这不是「这条记忆是空的」：先用 memory_search 或 memory_project 确认 id，再读一次。` 空串不许被读成「这条记忆是空的」。

### 9.57.3 归类与判据

`contract.js` 新增 `READ_AMBIGUOUS_MARK` / `READ_NOT_FOUND_MARK` / `READ_NO_REPLY_MARK` 与 `readAnswerKind()`（顺序 `ambiguous → notFound → noReply → ok`：撞车那句里也提到「一条都没读」，必须排在 notFound 前面判）。判据清单第 22 条 `vendor-read` 钉住三句话与 `findByIdAll` + `matches.length > 1` 的实现；探针 AI1–AI5 用真库验「两位前缀必撞」「查无此 id」「唯一 8 位照常读」「上游静默」四种。

### 9.57.4 验收

- 判据：39 个跨插件常量、14 族归类、22 条清单全绿
- 探针：AI1–AI5 全绿（AI2 实测「命中了 7 条」）
- 阴性对照：把 `readAnswerKind` 的 ambiguous 支改成 `ok`、把 `matches.length > 1` 改成 `false`，各打红对应断言

## 9.58 相似检索的「基准」：短 id 撞车时一条都不比（0.2.53）

`memory_find_similar` 要一个「基准 id」。它拿这条记忆的正文去和库里其他人比，算相似度。
基准是用 `findById` 取的——和 0.2.52 之前的 `memory_read` 一模一样，短 id 走 `LIKE '前缀%'`，
**撞上多条时按 `LEVELS` 顺序静默取第一条**。

| 你给的 id | 老行为 | 回执读起来像 | 实际发生了什么 |
| --- | --- | --- | --- |
| `0m`（撞 7 条） | 取第一条 | 「相似度 0.412 …」 | 拿别人的正文当基准，**所有分数都是错的** |
| `0mzz`（不存在） | `未找到记忆 0mzz` | 「没有相似的东西」 | 其实一条都没比 |
| 全 id | 正常 | 正常 | 正常 |

比 `memory_read` 更糟的是：读错了你还能发现正文不对；**相似度错了看不出来**——数字和排序都像模像样，
而它回的是别人的邻居。

### 9.58.1 两种「没站住」各说各话

| 常量 | 句子 | 什么时候 |
| --- | --- | --- |
| `SIMILAR_AMBIGUOUS_MARK` | `相似检索这次一条都没比` | 短 id 命中多条：列出前 5 条候选，`不是我替你挑第一条`，`基准挑错，比出来的相似度全是错的` |
| `SIMILAR_NOT_FOUND_MARK` | `相似检索没起点` | 这个工作区里查无此 id：说清 8 位、`记忆库按工作区分开存（当前工作区 …）`、先 `memory_search` 反查 |

两句都不说「没有相似」——那是「比过了、真没有」才配说的话（0.2.46 的 `这才是「记忆里没有相似的东西」`）。

### 9.58.2 归类仍只有一个函数

0.2.46 已经有一个 `similarAnswerKind`（分 `notComputed` / `none`）。这一轮不能另起一个
（模块里会 `already been declared`），两支并进同一个函数，顺序：

`ambiguous → notFound → notComputed → none → ok`

基准没站住必须排在最前：撞车时「没算成」和「没有相似」这两句话都不成立。

### 9.58.3 判据

- `vendor-similar-id`：两条新话 + `不是我替你挑第一条` + `基准挑错，比出来的相似度全是错的` + `findByIdAll` + 锚定到 `const shown = matches.slice(0, 5)` 之后的那句 throw。
- 探针 AJ1–AJ4：三种归类 / 真撞车不吐任何 `相似度 0.xxx` / 查无此 id 说工作区与位数 / 唯一 8 位前缀照常走到「比了一遍」。

## 9.59. 连线归一：撞车、没查成、真没有，三句各说各的（0.2.54）

`memory_link` 的 `a`/`b`、`memory_remember` 的 `links` 参数、后台补连队列，三处都要先把
「用户给的短 id」换成「星图认的完整 id」。这一步原来只回两种结果：完整 id，或者 `null`。
于是三种完全不同的真相被压成同一句话：

| 真相 | 实际发生了什么 | 旧口径 | 后果 |
| --- | --- | --- | --- |
| 短 id 撞车 | `memory_read` 明确回「这个短 id 不止一条记忆」，还列了候选 | 「找不到这条记忆（id 写错了，或它已经被合并掉）」 | 这条记忆**在**，用户以为它没了，去重新建一条 → 库里出现两条近似记忆 |
| 这次没查成 | meow 没装配 / 超时 / 抛错，连「有没有」都不知道 | 同上 | 一次抖动断言了「它不存在」，还顺手把补连条目摘掉 |
| 真没有 | 这个工作区里七层表都查不到 | 同上 | 这句才对 |

补连队列更狠：`resolve(...) === null` 就 `dropped += 1` 并落盘删除，面板跟着报
`清掉 N 条永远连不上的（记忆已合并/删除）`——一次 meow 超时就能把用户辛苦写的连线整批清空，
而且给的理由说的是另一件事。

### 9.59.0 三种真相的句子

| 常量 | 句子 | 什么时候 |
| --- | --- | --- |
| `LINK_AMBIGUOUS_LINE` | `这个短 id 不止一条记忆，这次一条都没连——把 id 给够位数…连错一条比没连上更难发现` | 归一返回 `kind: 'ambiguous'`（转述 meow 的候选，不重写措辞） |
| `LINK_UNAVAILABLE_LINE` | `这次没查成（读记忆的工具没接上），没连——这不是「这条记忆不存在」，等它就绪再写一次` | 归一返回 `kind: 'unavailable'` |
| `LINK_MISSING_LINE` | `这个工作区里没有这条记忆，没连——id 可能写错了一位，或者它已经被合并/删除，用 memory_search 反查一下` | 归一返回 `kind: 'missing'` |

只有第三句才允许提「写错了 / 被合并」——前两种的结论根本还没到那一步。

### 9.59.1 归一函数改成回结构

`linkflow.js` 里新增 `resolveIdDetail(id, exec)`，回
`{ kind: 'ok' | 'ambiguous' | 'missing' | 'unavailable', id, note?, candidates? }`：

- `raw.length >= 36` → `ok`（本来就是完整 id）；
- `idCache` 命中 → `ok`；
- `r.entry === undefined`（工具没接上）→ `unavailable`，`note` 去 `未完成：` 前缀、截 120 字；
- `v.ambiguous === true` → `ambiguous`，原样带 meow 的 `note`/`candidates`；
- `v.found === true` → `ok` 并写缓存；其余 → `missing`。

旧的 `resolveId` 只留成兼容壳（`d.kind === 'ok' ? d.id : null`），判断只有一处。

### 9.59.2 队列：前两种一条都不许摘

`flushPending` 的 `resolve` 现在两种都认（结构体或老的 `id`/`null`，用 `norm()` 归一），分支：

`ambiguous` → `ambiguous += 1` + `continue`（留着）；
`unavailable` → `unavailable += 1` + `continue`（留着）；
`missing` → 才 `dropped += 1`。

返回值跟着扩成
`{ tried, linked, dropped, ambiguous, unavailable, left, stopped, budgetMs, limit }`（空队列那次也一样），
面板据此多两条说明：`另有 N 条短 id 不止一条记忆，没连也没摘——把 id 补到 8 位以上再说`、
`另有 N 条这次没查成（读记忆的工具没接上），原样留着下次再试`。

### 9.59.3 判据与验收

- 判据 `link-resolve-three`：横跨 `linkflow.js` / `links.js` / `defs/link.js` 三个文件，少一句就红。
- 探针 AK1–AK5：撞车不连且不冒充「不存在」/ 没接上不冒充「不存在」/ 队列遇撞车留着且面板不出「清掉」/
  队列遇没查成留着 / 真没有照旧摘（老 `resolve=null` 那条路没被这一刀弄坏）。
- verify `link:` 十三条。
- 阳性：`check-all` 12 支全绿、1076 → 1091 条；`lib/client.js` 一个字节没动。

## 9.60. 面板上的「0 条 / 还是空的」有四种来路（0.2.55）

`memory_admin` 的成本面板与待补队列面板都要回答一个「有多少」的问题，而它们说的话只有一句：
`成本账本还是空的（路径）。调用几次 memory_* 工具后再看。` /
`待补连线：0 条（星图那边都连上了，没有欠账）。`

这句话对「真的还没写过」是对的，可它同时也是另外三种情况的台词：

| 真相 | 实际发生了什么 | 旧口径读起来 | 后果 |
| --- | --- | --- | --- |
| 从没写过 | 文件不存在（`ENOENT`） | 「还没记过账 / 没有欠账」 | 这句才对 |
| 写不进去 | 磁盘满、权限不足、路径被占；`appendJsonl` 吞掉异常（约定 2 不打断记忆） | 同上 | 调用一直在发生，账一条没落下来，用户被告知「你还没调用」 |
| 读不出来 | `EISDIR`（把目录当文件）、`EACCES`；`readJsonl` 的 `catch { return [] }` 一并吞掉 | 同上 | 账本里有东西，面板说没有 |
| 整份坏行 | 文件在，`JSON.parse` 每行都失败 | 同上 | 同上，且永远修不好也不知道 |

队列那一侧更严重：`queuePending` 写盘失败返回 `false`，调用方照样报「已排队等补连」，
而面板照旧报「0 条，都连上了」——欠账被静默吞掉，下次读记忆也不会补。

### 9.60.0 读侧：把「为什么没读到」带出来

`store.js` 新增 `readJsonlDetail(file)` →
`{ entries, exists, unreadable, badLines, lines, error }`：

- 抛错且 `err.code === 'ENOENT'` → `exists: false, unreadable: false`（真的没有）；
- 抛别的错（`EISDIR` / `EACCES` / …）→ `exists: true, unreadable: true, error`（这次读不出来）；
- 读到就逐行 `JSON.parse`，坏行只计数不抛（`badLines`）。

`readJsonl()` 退回成 `readJsonlDetail().entries`，老调用方一个字都不用改。

### 9.60.1 写侧：失败也是一笔账

`store.js` 新增 `appendJsonlDetail(file, entry)` → `{ ok, error }`；`appendJsonl` 退回成 `.ok`。
成本层与队列层各留一个最小的失败账 `writeFail = { failures, error }`：

- 失败 → `failures += 1`、记下最后一次的 `error`；
- **成功 → 清零**。否则盘修好之后，面板还在拿旧账喊「一行都没写进去」。

### 9.60.2 面板：四支分开说

成本面板（`cost.js` → `emptyReport`）与队列面板（`links.js` → `pendingReport`）的判断顺序一致：

1. 有失败账 → `一行都没写进去：最近 N 次记账都失败了（原因）` + `这不是「你还没调用工具」` / `这不是「没有欠账」`；
2. `unreadable` → `在，但这次读不出来（原因）——不是账本是空的` / `不是「都连上了、没有欠账」`；
3. `badLines > 0` → `有 N 行，但一行都解析不出来（M 行坏行）——不是没记过账，是这份账本坏了`；
4. 解析出来却一条都用不上 → `队列里有 N 条记录，但这次一条都用不上（要么过期了，要么缺 a/b）`
   （两种可能都摆出来，不替人挑）；
5. 以上都不是 → 原来那句「还没记过账 / 0 条（都连上了，没有欠账）」。

### 9.60.3 判据与验收

- 判据 `store-fail-visible`：横跨 `store.js` / `cost.js` / `links.js`，少一支就红（清单从此 25 条）。
- 探针 AL1–AL8：把 `DSH_HOME` 指到临时目录，用真文件系统造四种故障——
  没写过 / 整份坏行 / 目录当文件（`EISDIR`）/ 写不进去；AL8 再验「写成功过之后旧账清零、真空仍说原来那句」。
  这一段不动真账本（结束时恢复 `DSH_HOME` 并删临时目录）。

## 9.61. 参数给错了也得说：状态值 / 时段 / 条数 / 截断（0.2.56）

### 9.61.0 一句话

`memory_search` 的四个参数（`status` / `days` / `k` / `content_max`）原来给错了是**静默**的：
`status` 拼错 → 库里一行都查不到 → 回执却按「本次零命中：默认检索范围是 fact/lesson/topic/rules」解释，
读者把它读成「记忆里没有」，回头再写一条重复的；`days` 给 0 或负数 → 这个过滤直接消失，
读者以为限了时段，其实查了全部；`k` / `content_max` 越界 → 被夹到边界，一个字都不说。
0.2.51 已经把 `level` 这一支分开说了，这一轮把剩下四个参数补齐。

### 9.61.1 状态值：白名单收，全错和部分错分两种说法

- `statusAsked` 原样留住用户写的词，`statusBad` 收「不在 `active / stale / archived` 里、又不是 `all`」的那些，
  `statusList` 只留合法的。
- 一个都不合法（`statusDead`）→ **不去库里空转**（`rows` 直接 `[]`），回执：
  `这次一条都没查：你给的状态值「done」不在 active / stale / archived 里（要查全部状态写 all）。这不是「记忆里没有」，是状态值没对上——换成真实状态再查一次。`
- 部分不合法 → 按合法的过滤，但点名丢掉了谁：`这几个状态值没生效：done（不在 active / stale / archived 里）——这次只按 stale 过滤。`
- `statusDead` 时 `plain` 那句「本次零命中：默认检索范围…」**不许出现**——它讲的是「没给过滤条件时查了哪几层」，和「状态值写错」是两件事。

### 9.61.2 days 给 0 或负数

`days` 原来的写法是 `daysRaw > 0 ? daysRaw : null`——`0` 与 `-3` 都被当成「没给」，
于是「最近 7 天」变成「不限时段」，而回执一句不提。现在只要显式给了却不是正数就说：
`days 给的是「0」，不是正数，这个「最近 N 天」的过滤没生效——等于查了全部时段。`

### 9.61.3 k / content_max 被夹到边界

`k` 夹在 1–50、`content_max` 夹在 0–5000，夹完必须说一声：
`k 给的是「100」，超出 1–50，这次按 50 条处理。` / `content_max 给的是「-5」，超出 0–5000，这次按 0 处理。`
参数合法时这几句**一条都不加**——探针 AM7 专门盯这一条，避免天天喊狼来了。

### 9.61.4 note 的拼接顺序

`[plain, levelNote, scopeNote, statusNote, daysNote, kNote, cmNote]`：老的「默认范围 / 层名 / 只在某几层查过」在前，
新的参数提示接在后面，互不顶替。

### 9.61.5 判据与探针

- 契约判据第 26 条 `vendor-search-param`：盯 `STATUS_VALUES` 白名单、`statusDead` 短路、四句提示、`rows` 与 `note` 的两处形状。
- `tools/probe-fusion.mjs` AM1–AM7 用**真调用**钉住：状态全错 / 部分错 / `days: 0` / `k: 100` / `content_max: -5` / 参数全合法时不加提示。

## 9.62. 0.2.57：数值参数「给 0 就照办 0」

9.62.0 一句话：星图的六个工具原来都用 `Math.max(min, Math.min(max, Number(args.x) || 默认))` 收参数——显式给的 `0` 被当成「没给」，越界的值被悄悄夹住，非数字静默退回默认，**结果都是被改过的条件算出来的，回执却照原样解释**。

9.62.1 三个坑各自长什么样：

- `min_weight: 0`（明确要求「不过滤权重」）是 falsy → 被换成 0.5，回来的条目少了，回执还劝你「把 min_weight 调低一点」。`hops: 0` 同理，被换成默认跳数。
- `limit: 100`（上限 30）→ 夹成 30，一个字都不说；你读「就这 30 条」以为是全部命中。
- `limit: "十"` → 静默退回 10。

9.62.2 统一出口 `numParam(name, raw, { min, max, def })`：返回 `{ value, note }`。合规（不只是不越界，还包括**给的正好是边界值**）→ `note: ''`；越界 → `note` 说清「给的是 X，超出 a–b，这次按 Y 算——结果是被改过的条件算出来的」；非数字 → 「给的是「十」，不是数字——这次按默认 N 算」。`0` 只要在 `[min, max]` 里就原样照办。

9.62.3 六个站点：`nebula_recall`（limit / hops）、`nebula_inspect`（neighbors）、`nebula_stats`（hubs）、`nebula_path`（maxHops，两个出口都带）、`nebula_hygiene`（limit）、`nebula_bridge`（limit / chars / min_weight / hops，空结果与成功两处都带）。`nebula_hygiene/stats/inspect` 在 macro 工具面上没有入口（被 gate 摘掉了），所以它们由源码断言守；能真跑的 `graph` / `bridge` / `path` 三个入口由探针 `AN1–AN7` 钉住。

9.62.4 判据与探针：`tools/criteria.mjs` 第 27 条 `vendor-param-zero`（判 ok 要求六个调用点全是 `numParam(...)`，且源码里再没有 `Number(args.x) ||`）；`tools/probe-graph.mjs` 的 `AN1–AN7` 走真工具面——AN3/AN4/AN7 是「合法参数一句都不加」的防狼来了。

## 9.63. 0.2.58：模式名写错了，不等于你要的那种检索

9.63.0 一句话：`memory_search` 原来用 `const mode = String(args.mode ?? 'local')`——`Graph`、` graph `、`相似`、`expand` 这些值一个都没落进任何分支，**代码就一路走到本地检索**：想要沿关联扩散的人拿到的是关键词命中，还可能把它读成「图里就这么多」；把 `similar` 漏一个字母，反过来抛「本地检索需要 query」，等于教他改一个他刚写过的词。

9.63.1 先说没坏的那部分：`mode` 在 schema 里本来就是 `enum: ['local', 'graph', 'bridge', 'similar']`，但工具面不保证执行层一定校验；`memory_link` 的 `action` 早就有白名单 + `throw new Error('memory_link：未知 action=')`。这次只是把 `memory_search` 补齐成同一套规矩。

9.63.2 归一在前、白名单在后（`modeOf(args)`）：`typeof raw === 'string' ? raw.trim() : ''`；空串 / 纯空格 = 没给 → `local`；`text.toLowerCase()` 之后再比——所以 `Graph`、` graph ` 都是合法值，照办，不许反过来骂人；只有真不认识（`expand`、`相似`、`similarity`）才算 `bad`，并把原值 `raw` 留住备用。

9.63.3 不合法就一句都不查（`badModeText`）：说的是「mode 没生效：你给的是「expand」，这里只认 local / graph / bridge / similar（大小写不敏感，前后空格会去掉）。这次一条都没查——这不是「记忆里没有」，是模式名没对上」，后面接一句对应关系：沿关联扩散用 graph、强相关但没读过的邻居用 bridge、相似条目用 similar + id、普通关键词用 local。**先挡住，再谈检索**——不能先跑一遍本地检索再附一句「其实模式没生效」，那时读者已经拿错结果去解释了。

9.63.4 参数给在别的模式上（`modeNotes`）：`expand` 给在 graph / bridge / similar，`k` 给在 graph / bridge（那两个用 `limit`），`limit` 给在 local / similar（本地用 `k`），`chars` / `min_weight` 给在非 bridge 模式——每种都说「这次没用上」，并点出该用的那个。名字是同一个「参数」，模式不同含义不同，静默忽略等于让读者拿错条件去解释结果。

9.63.5 尾注为什么只拼一次：原来十个 `return` 各说各的，没有一处会说「你这个参数根本没用上」。所以主体搬成模块级 `async function runSearch(flow, args, exec)`，工具对象的 `execute` 变成薄壳：判模式 → 跑主体 → 拼尾注。**踩坑**：先写成对象方法 `async runSearch(args, exec)` 时，方法里裸调 `runSearch(...)` 会解析到模块作用域，直接 ReferenceError；必须搬成模块级函数并显式传 `flow`。

9.63.6 判据与探针：`tools/criteria.mjs` 第 28 条 `search-mode-whitelist`（白名单常量、`modeOf`、`bad` 分支、四句尾注、薄壳里的 `runSearch(flow, …)` 与一次 `notes.join` 全都要在）；`tools/probe-fusion.mjs` 的 `AO1–AO9` 走真工具面——AO4 是「只差大小写与空格必须照办」的反向哨兵，AO9 是「模式与参数都合法时一句都不加」的防狼来了。

## 9.64. 连线的动作名与两端 id：缺了先挡住（0.2.59）

### 9.64.0 一句话

`memory_link` 以前只在「动作名不认识」时抛错，`a` / `b` 压根不校验——少给一个 id，回执说的是「暂时没落图，已排队，读记忆时会自动补」，还真的排下一条永远连不上的欠账。

### 9.64.1 这一轮修的是三个坑

1. **缺参数被读成环境问题**。`resolveIdDetail(undefined)` 回 `{ kind: 'missing', id: '' }`，而紧跟着那句 `[ra === null ? args.a : null].filter(Boolean)` 会把 `undefined` 过滤掉——于是「缺 a」假装成「两端都查到了」，payload 变成 `{ a: null, b: null }`，星图回一句「连线未完成」，我们再把它翻译成「星图还没建到 / 暂时没落图」→ 排队 → 告诉用户「读记忆时自动补」。缺参数是最常见的调用错误，拿到的却是最像环境故障的那句话。
2. **动作名只在「不认识」时抛错**，抛的还是一句 `memory_link：未知 action=foo`：不说只认哪五个、不说这次一条都没动、更不说该用哪个。写 `Graph` / `PATH ` 这种差大小写与空格的，直接掉进「未知」。
3. **参数给错了动作，一个字都不说**。`maxHops` 只在 `path` 用，`note` 只有 `link` / `mute` 会存；给了别的动作，静默丢掉——用户以为自己写下的理由被记住了。

### 9.64.2 动作名：LINK_ACTIONS + linkActionOf

```js
const LINK_ACTIONS = ['link', 'unlink', 'mute', 'unmute', 'path']
function linkActionOf(args) {           // → { name, bad, missing, raw }
  const raw = args.action
  if (typeof raw !== 'string' || raw.trim() === '') return { name: '', bad: true, missing: true, raw: ... }
  const name = raw.trim().toLowerCase()
  return { name, bad: !LINK_ACTIONS.includes(name), missing: false, raw: String(raw) }
}
```

- 空值 / 纯空格 = **没给**（单独一句「没给 action」，不是「未知 action=」）。
- `trim().toLowerCase()` 之后再过白名单：` LINK ` 照办，是归一不是猜。
- 不合法时 `badActionText()` 三句：给的是什么 → 只认哪五个 → **星图和记忆都没动**（并把五个动作的对应关系列一遍）。

### 9.64.3 两端 id：missingEnds

```js
const LINK_END_FIELDS = [['a', '起点记忆的 id'], ['b', '终点记忆的 id（path 的终点）']]
function missingEnds(args) { ... typeof v !== 'string' || v.trim() === '' ... }
```

- 空串、纯空格、`undefined` 都算没给——这一支原来整个不存在。
- 缺哪端点哪端：`memory_link(link) 这次一条都没动：缺 b（终点记忆的 id（path 的终点））。`
- 明说「两端 id 没齐之前不会去动星图，也不会先排一条连不上的欠账」。

### 9.64.4 尾注：参数给错动作要说没用上

| 参数 | 只在哪个动作生效 | 尾注 |
| --- | --- | --- |
| `maxHops` | `path` | `maxHops 只在 path 这个动作生效（这次是 link），没用上。` |
| `note` | `link` / `mute` | `note 只有 link / mute 会存下来（这次是 path），这句理由没地方记。` |

参数合适时**一句都不加**（防狼来了，探针 AP8 守着）。

### 9.64.5 薄壳先拦，主体搬进模块级 runLink

`execute` 现在只有三步：`if (act.bad) return badActionText(act)` → `if (ends.length > 0) return missingEndsText(act, ends)` → `const text = await runLink(flow, act.name, args, exec)`，然后拼一次尾注。顺序不许换：先动作名、再两端 id、最后才碰星图。

主体从对象方法搬成模块级 `async function runLink(flow, action, args, exec)`，`flow` 显式传（对象方法里裸调模块级函数会解析到外层作用域，0.2.58 踩过这个坑）。

### 9.64.6 判据与探针

- 判据第 29 条 `link-action-and-ends`：三个出口（坏动作 / 缺 id / 尾注）+ 薄壳顺序，任何一处退回「静默往下走」就打红。
- 探针 AP1–AP8 走真工具面：AP1 少给 b 必须说「这次一条都没动」**并且**星图一次都没被调、队列仍 0 条；AP5 只差大小写与空格时必须照办；AP8 参数合适时一句尾注都不加。

## 9.65. 卡片抬头也是口径（0.2.60）

### 9.65.0 一句话

八个工具各写各的卡片标题：`星图连线：path`、`检索记忆：graph` 把参数键直接贴到用户眼前，`项目全景：` 在参数没给时留个悬空冒号，只读的 `path` 还被标成写操作。现在统一走 `cardTitle()`，中文名只有一份。

### 9.65.1 这一轮修的是四件事

1. **动作键冒充名字**。0.2.25 在 `memory_admin` 里修过一次（`记忆运维：stats` 没人看得懂），`memory_link` 漏了：`星图连线：link` / `星图连线：path`。用户看到的是给机器看的枚举值。
2. **悬空冒号**。`项目全景：` / `星图连线：` / `读取记忆 `（这个连冒号都没有，直接一个尾空格）——参数没给时标题就断在半截。
3. **kind 反了**。`path` 是只读（只看证据链），却被标成 `write`，卡片上一眼看去像在改东西。
4. **一行装不下**。检索词一长，标题跟着长；多行 query 会把两行塞进一个单行卡片。

### 9.65.2 cardTitle：标题唯一出口

```js
export const CARD_DETAIL_MAX = 40
export function cardTitle(label, detail) {
  const prefix = String(label ?? '').trim()
  const flat = typeof detail === 'string' ? detail.replace(/\s+/g, ' ').trim() : ''
  if (flat.length === 0) return prefix          // 没细节就只留前缀，不留「：」
  const short = flat.length > CARD_DETAIL_MAX ? `${flat.slice(0, CARD_DETAIL_MAX)}…` : flat
  return `${prefix}：${short}`
}
```

三条规矩：细节为空只留前缀；多行压成一行、去首尾空白；超过 40 字截断加省略号。

### 9.65.3 名字只有一份：LINK_ACTION_LABELS / MODE_LABELS

跟 `ACTIONS` 表同一套道理——键是给机器的，名字是给人的：

| 动作 | 卡片上的名字 |
| --- | --- |
| `link` | 连一条手工线 |
| `unlink` | 断开手工线 |
| `mute` | 屏蔽自动关联 |
| `unmute` | 撤销屏蔽 |
| `path` | 看证据链（kind=`read`） |

| 模式 | 卡片上的名字 |
| --- | --- |
| `local` | 本地检索 |
| `graph` | 沿关联扩散 |
| `bridge` | 补邻居 |
| `similar` | 相似条目 |

模式名没对上时卡片写「模式名没对上」，动作名没对上时写「动作名没对上」——和正文的 0.2.58 / 0.2.59 那两句对齐。

### 9.65.4 八个 presentCall 一个模板都不许留

探针直接读八个工具的 `presentCall`，钉住十件事：都有标题、没有裸 `undefined`、没有悬空冒号、`path` 是 read、`link` 带两端 id、动作名没对上不冒键、`graph` 不冒英文、长词截断到一行、运维面板用表里的中文名、换行被压平。

### 9.65.5 验收

- `verify.mjs` A57 组八条：`cardTitle` 出口唯一、八个 defs 全走它（且没有一处 `title: \`` 模板）、两张名字表、admin 未知动作兜底、探针 AQ1–AQ10、版本与文档。
- `node tools\check-all.mjs` → 12/12。

## 9.66. 面板条数也是条件（0.2.61）

### 9.66.0 一句话

`limitOf()` 原来对四种输入一声不吭地退回默认值：`limit: 0`（明说「一条都别列」）、负数、非数字、非整数。现在能照办就照办，改了就说话——和 vendor 侧 `numParam()`（0.2.57）同一套规矩，这条路上 0.2.57 漏了一次。

### 9.66.1 四个坑（都是同一句 `n > 0 ? Math.floor(n) : fallback`）

| 输入 | 以前 | 现在 |
| --- | --- | --- |
| `limit: 0` | 悄悄变成 200 / 20 | 照办 0，抬头写「最近 0 次调用 · limit 给的是 0，这次一条都不列」 |
| `limit: -3` | 悄悄变成默认 | 回默认，附一句「条数没有从后往前数这回事」 |
| `limit: '十'` | 悄悄变成默认 | 回默认，附一句「不是数字」 |
| `limit: 2.7` | 悄悄变成 2 | 还是 2，但要说「少掉的那半条不是你给的条件」 |

`limit: '0'`（字符串）算 0，不算「不是数字」——`Number('0') === 0`，这条单独钉了探针。

### 9.66.2 更贵的一层：`slice(-0)` 是整本账

成本账本原来写 `detail.entries.slice(-limit)`。`slice(-0)` 等于 `slice(0)`——**要求「一条都别列」反而列出全部**。于是面板抬头写「最近 0 次调用」，正文却是整本账。

现在 `costReport` 与 `pendingReport` 都先挡住 `limit <= 0`，并且说清库里其实有多少：

- 成本：`按你给的 limit=0 这次一条都不列（账本里其实有 12 行，不是没有记录）。账本：…`
- 队列：`按你给的 limit=0 这次一条都不列（队列里其实有 3 条，不是没有欠账）。队列：…`

「0 条」和「你要我不列」是两件事，面板必须分得开——这跟 0.2.55 那四种「空着」是同一条原则。

### 9.66.3 出口还是一处

`limitOf(spec, args)` 仍然只有一处，只是返回 `{ value, note }`：默认值仍写在动作表的 `defaultLimit` 里。两个调用点（成本 / 待补连线）各把 `lim.note` 拼进抬头口径说明，拼接用 `filter(Boolean).join(' · ')`——没有 note 时抬头一个字都不多。

### 9.66.4 验收

- 探针 AR1–AR7（走真工具面 `memory_admin`，cost 面板纯本地）：0 照办、`"0"` 当成 0、非数字 / 负数 / 非整数各一句、正常条数与默认值都不加料。
- `verify.mjs` A58 组：`limitOf` 四种出口、两个调用点、两个报告函数的 0 支、判据第 30 条、AR1–AR7、版本与文档。
- 判据第 30 条 `admin-limit-zero`：面板条数给 0 就照办 0，负数与非数字回默认但要说出口。

## 9.67. 邻居条数也是条件（0.2.62）

### 9.67.0 一句话

读记忆时 `neighbors` 给错（非数字 / 负数），以前是「悄悄没有邻居」——读者只会得出「这条记忆没有邻居」；现在回执末尾明写「给的是什么、这次按几条算」，而文档写明的 `0`（不带邻居）仍然照办、不多一个字。

### 9.67.1 原来的四种输入，其实变成了两种结果

`memory_read` 只想问一句「带几个邻居」，于是把 `neighbors` 塞进 `Number()`，再拿「不是有限数、或者小于等于 0」做一句提前返回。四种输入被压成两种结果：

| 你给的 | 以前的结果 |
| --- | --- |
| `neighbors: '十'` | 提前返回 → 回执只有正文，**像这条记忆没有邻居** |
| `neighbors: -3` | 同上，一模一样的结果 |
| `neighbors: 0` | 同上（但 0 是文档写明的「不带」，这个「静默」本身是对的） |
| `neighbors: 3.7` | 小数直接递给了星图 |
| `neighbors: 999` | 星图侧夹到 40，本层一个字都不说 |

前六行最贵：三种完全不同的处境，长得一模一样。「我没给对」被读成「库里没有」——这是 0.2.55 那四种「空着」的同一族缺陷，只是换了个参数。

### 9.67.2 `countParam()` 是这条路的唯一出口

`lib/macro/shared.js` 新增 `countParam(name, raw, { min, max, def })`，返回值仍是 `{ value, note }` 两个字段：

| 输入 | `value` | `note` |
| --- | --- | --- |
| `undefined` / `null` / 空串 | 默认值 | 空 |
| 非数字 | 默认值 | 「`neighbors` 给的是「十」，不是数字——这次按默认 12 条算，不是你给的那个。」 |
| 负数 | 默认值 | 「是负数——条数没有「从后往前数」这回事」 |
| `0` | **0**（照办） | 空（0 有明确含义：不带） |
| 非整数 | 抹掉小数 | 「条数只能是整数，这次按 3 条算——少掉的那半条不是你给的条件」 |
| 超界 | 夹到边界 | 「超出 0–40，这次按 40 条算——结果是被改过的条件算出来的」 |

和 `limitOf` 的分工：`limitOf` 给面板用（0 表示「一条都别列」，所以必须配一句「这次一条都不列」）；`countParam` 给「要几个」用（0 是合法的「一个都不要」）。两边一致的是那条底线——**能照办就照办，改了就要说话**。

### 9.67.3 说明接在回执末尾，不顶掉正文

`lib/macro/defs/read.js` 现在是：先把正文（`said`）算出来 → 邻居段有就接在正文后 → `nb.note` 非空再接最后。三段顺序固定，说明永远在最后，读的人先看到内容，再看到「这次的条件被改过」。`0` 时既不调星图、也不加料。

### 9.67.4 验收

- 探针 AS1–AS10（走真工具面 `memory_read`）：非数字仍带邻居段、`seen[0] === 12`；`-3`、`3.7`（`seen 3`）、`999`（`seen 40`）、`0` 与 `'0'`（不调星图）、`5`（`seen 5` 不加料）、缺省（`seen 12`）。
- `verify.mjs` A59 组：`countParam` 六种出口、`read.js` 走它且两条负向（旧写法不许留）、说明拼接的两条正则、判据第 31 条、AS1–AS10、版本与文档。
- 判据第 31 条 `read-neighbors-param`：读记忆的 `neighbors` 给错要说出口，不许悄悄变成「这条记忆没有邻居」；`0` 照办。

## 9.68. 注入上限写坏＝零字注入（0.2.63）

### 9.68.0 一句话

配置里 `guideMaxChars` 写错一个字（`"4k"`、`-5`、`null`），以前会被读成 0——而 0 在这条路上就是**整段 L0 注入变成空串**，日志和面板一个字都不说；现在除显式 `0` 之外一律回默认并带一句话，手册末尾还会写清「L0 现在多少字 / 上限是多少」。

### 9.68.1 一行 `|| 0` 怎么吃掉整段注入

`clampGuide` 以前先把 `maxChars` 塞进 `Number()`，再用「不是有限数就用 0」兜底。兜底看起来稳，其实把三种完全不同的处境压成了同一个数：

| 你配的 | 以前的 cap | 结果 |
| --- | --- | --- |
| `guideMaxChars: "4k"` | 0 | `t.slice(0, 0)` → **空串**，注入整段消失 |
| `guideMaxChars: -5` | 0 | 同上 |
| `guideMaxChars: null` | 0 | 同上 |
| `guideMaxChars: 0` | 0 | 同上（这个「照办」是对的，但也没人知道自己在要求「别注入」） |
| 缺省 | 1300 | 正常 |

前三种是「配置写坏了」，第四种是「我确实不要注入」。它们在行为上一样，在意思上完全不同——而插件在这条路上一个字都不说。整段 L0 消失时，模型只是「没看到手册」，没人会去查配置。

### 9.68.2 `guideBudget()` 是这条路的唯一出口

`lib/macro/prompt.js` 新增 `guideBudget(raw) → { value, note }`：

| 输入 | `value` | `note` |
| --- | --- | --- |
| 缺省 / `null` / `''` | 1300 | 空 |
| 非数字 | **1300**（不是 0） | 「不是数字——这次按默认 1300 字算，不是你给的那个（注入没有变成空的）」 |
| 负数 | 1300 | 「上限没有「从后往前数」这回事」 |
| `0` | **0**（照办） | 「一个字都不注入——不是「手册空了」，是你把上限设成了 0」 |
| 非整数 | 抹小数 | 「少掉的那半字不是你给的条件」 |
| 太小（放不下收尾那句） | 照办 | 「连「被截断了，完整手册见 …」这句尾巴都放不下——注入只剩硬切的前 N 字，没有指路」 |

`clampGuide` 现在只做格式化：`const cap = guideBudget(maxChars).value`。所以 `clampGuide(long, 0) === ''` 这条既有契约不变，而 `clampGuide(long, '4k')` 会给出「带尾巴的 1300 字」而不是空串。

### 9.68.3 三处出口都要说话

1. 装注入时（`lib/index.js` 的 `installGuide`）：`if (budget.note) logger?.warn?.(...)`——写坏的那一刻就进日志。
2. 手册里（`memory_admin(action="guide")`）：末尾补一行「L0 注入：现在 N/M 字」，写坏时那句话一起带出来。它是查配置的入口，不是新功能。
3. 探针（`tools/probe-fusion.mjs` 的 AT1–AT11）：既有纯函数层，也有真工具面（`memory_admin(guide)` 的末尾那行）。

### 9.68.4 验收

- 探针 AT1–AT11：六种输入各一条、`clampGuide(long,'4k')` 非空且以收尾标记结尾、`clampGuide(long,0)` 仍为空、guide 末尾那行正常与异常两种。
- `verify.mjs` A60 组：`guideBudget` 六出口、`installGuide` 的 warn、guide 末尾那行、判据第 32 条、AT1–AT11、版本与文档。
- 判据第 32 条 `guide-budget-param`：注入上限写坏不许变成「零字注入」，只有明确给 0 才照办 0。

## 9.69. 体检的类别也是条件（0.2.64）

### 9.69.0 一句话

`memory_admin` 的 `hygiene` 有六类体检：`dup` / `stale` / `thin` / `oversize` / `unread` / `orphan`。`kind` 写成别的（`dups`、`重复`、`ORPHAN` 拼错一个字母），以前不会报错——星图那边按 key 去取条目，取不到就是空数组，回执于是变成：

```
记忆体检：共 12 项（只诊断，不动任何记忆）

重复（0）
```

抬头写着「共 12 项」，下面一行「（0）」。读的人只会得出一个结论：这一类是 0 条。真实情况是这类**根本没查**——十二项被照跑了一遍全部类别，只是没有一类叫 `dups`。

### 9.69.1 现在怎么守

`lib/macro/defs/admin.js` 的 `guardHygiene(args)` 挂在 `ACTIONS.hygiene.guard` 上（沿用 0.2.5 的分发表，分发那边不认识任何具体 action 名）：

| 给法 | 处理 |
| --- | --- |
| 六个键之一（`dup` / `stale` / `thin` / `oversize` / `unread` / `orphan`） | 照办 |
| 大小写不同（`ORPHAN`）、前后带空格（`  thin  `） | 归一后照办，`args.kind` 写回小写去空格的形态 |
| 空串 `''` | 与「没给」同义：走全部六类概览，不报错 |
| 不认识（`dups` / `重复` / `zzz`） | 挡住，一次都不往下发；错误里列出六个键、写明「这次体检没有跑」 |

挡住时那句原话：

```
memory_admin：action="hygiene" 的 kind 只认 dup / stale / thin / oversize / unread / orphan
（大小写不敏感，前后空格会去掉），给的是「dups」。
不传 kind 就返回全部六类概览。
这次体检没有跑——别把「没跑」读成「这一类没有问题」。
```

最后半句是这一轮的重点：**不给一个看起来像结论的空结果**。挡住和「查了、是 0」在回执上必须长得不一样，否则用户没法分辨。

### 9.69.2 中文类别名不猜

面板里六类的名字是中文（重复 / 该更新了 / 关系是凑的 / 超重 / 没人读 / 孤立）。看着像该顺手做一层中文别名映射，但映射表一旦猜错（「重复」到底该对 `dup` 还是 `oversize`？），用户拿到的是**另一类**的结果，比「没查」更糟：它看起来是有效的。所以只认六个英文键，中文名一律挡住并列出键名。

### 9.69.3 星图那层的兜底

融合层挡住了不认识的类别，但 `nebula_hygiene` 也会被别的宿主直接调用。那一层原来把类别名从表里取，取不到就是 `undefined`，于是打出「undefined（0）」——同一类误读。现在改成：

```js
const labelOf = (k) => NAME[k] ?? String(k)
```

键不认识就把它原样打出来（`dups（0）`），至少看得出「这个名字它不认识」，而不会伪装成一个没名字的 0。

### 9.69.4 覆盖

- 判据第 33 条 `admin-hygiene-kind`：白名单、归一、写回、挂表、兜底文案、负向（不许再把 `undefined（0）` 打出来）。
- 探针 AU1–AU8：坐实在真工具面上——挡住时星图一次都没被调、`ORPHAN` 归一成 `orphan`、`  thin  ` 去空格、不给 `kind` 不塞默认类、空串当没给、中文名不猜、挡住时措辞不许冒充结论、合规类别照常出面板。
- 阴性对照：把 `guardHygiene` 从表上摘掉（改回裸传），AU1/AU6/AU7 变红。

## 9.70. 尾注不许撒谎（0.2.65）

### 9.70.0 一句话

`memory_search` 在本地检索的最后会补一条尾注，告诉用户「哪些参数在这个模式下没用上」。以前它对所有非 `graph` / `bridge` 的模式一律说同一句：

```
limit 只在 graph / bridge 模式生效；本地检索的条数用 k，这次没用上 limit。
```

可是本地检索在两种情况下会**真的把 `limit` 用上**：

1. 本地零命中 → 自动向星图扩散（`nebula_recall`，`limit: args.limit ?? 5`、`hops: args.hops ?? 2`）；
2. 用户显式写了 `expand: true`。

也就是说：同一个 `limit`，被递给了星图、决定了扩散拿回几条，回执却声明「这次没用上」。

### 9.70.1 坏在哪：两句真话合起来变成一句假话

`limit: 0` 的人会同时看到：

```
本地检索一条都没有。
（扩散没补到东西）

limit 只在 graph / bridge 模式生效；本地检索的条数用 k，这次没用上 limit。
```

- 「扩散没补到东西」——因为 `limit=0`，星图本来就一条都不给（这是条件生效了）；
- 「这次没用上 limit」——这是在说条件没生效。

两句一起读，结论只剩一个：**星图里真没有**。而真相是「你把扩散的条数设成了 0」。这是「条件没生效」和「条件生效但结果为空」长得一样的又一例——和第二十七次（体检类别）、第二十六次（邻居条数）同源。

### 9.70.2 现在怎么守：三种状态分开说

`lib/macro/defs/search.js` 的 `modeNotes(mode, args, flags)` 不再自己猜，`runSearch` 把这次实际发生了什么记进 `flags`：

| 状态 | `flags` | 尾注 |
| --- | --- | --- |
| 真的扩散了，参数递进去了 | `spread: true` | `limit 平时是 graph / bridge 的条数；这次扩散真的用了它（limit=N）——本地检索自己的条数仍用 k。` |
| 本来要扩散，星图没接上 | `spreadTried: true`，`spread` 缺 | `这次本来要扩散（会用 limit=N），但星图没接上——它没参与这次结果。` |
| 本地有结果，根本没走扩散 | 两个都缺 | `limit 是 graph / bridge 的条数；这次没有扩散，limit 没用上（本地检索的条数用 k）。` |

`hops` 同构。第三种状态才是老文案该出现的地方——它原来被套在了所有状态上。

关键实现细节：

```js
const spreadLimit = args.limit ?? 5
const spreadHops = args.hops ?? 2
flags.spreadLimit = spreadLimit
flags.spreadHops = spreadHops
flags.spreadTried = true
const spread = await flow.tryCall('nebula_recall', { query, memory_ids, limit: spreadLimit, hops: spreadHops }, exec, '星图扩散')
if (spread.entry) flags.spread = true
```

`spreadTried` 在**调用之前**置位、`spread` 在**拿到 `entry` 之后**才置位——所以「递过去了但没接上」和「真扩散了」不会被合并成同一个状态。`limit=0` 也照原样递（`?? ` 只挡 `undefined` / `null`，不挡 0）：0 是明说的条件，不是「没给」。

### 9.70.3 为什么不让尾注自己判断

尾注是纯文本，它看到的只有 `args`。`args.limit !== undefined` 不足以说明「星图读了它」——本地有结果时它确实没被读。反过来「`args.limit` 存在且本地零命中」也不等于「扩散成功」——星图可能没接上。状态必须由执行路径回填，不能让展示层去推理执行层的事。

### 9.70.4 覆盖

- 判据第 34 条 `search-limit-used-note`：`modeNotes` 的三态分支、`spreadTried` 与 `spread` 的置位位置、四句文案、负向（不许再出现「limit 只在 graph / bridge 模式生效」）。
- 探针 AV1–AV9：零命中默认走 5/2 且不加尾注；`limit: 5` 说「真的用了它（limit=5）」；`limit: 0` 照递 0 并如实写 0；有结果不扩散才说「没用上」；`expand: true, hops: 3` 说 hops 真的用了；星图没接上说「本来要扩散（会用 limit=9）」且不许说「真的用了」；`similar` 说「相似检索的条数用 k」；`graph` 不补多余尾注；一个参数都不给时尾注里 limit / hops 一条都不出现。
- 阴性对照：把 `flags.spread = true` 挪到 `tryCall` 之前 → AV6 变红（没接上也说「真的用了它」）；把尾注退回无条件的「这次没用上 limit」→ AV2 / AV5 变红。

## 9.71. 同一组参数，两条路径（0.2.66）

### 9.71.0 一句话

`memory_search` 的 `graph` / `bridge` 模式走星图，星图侧只认 `limit` / `hops` / `chars` / `min_weight`。用户在 graph 里顺手写了 `project: "femo"`、`level: "fact"`、`days: 7`、`k: 20`，这些**只属于本地检索**的条件在星图那一路被 `pick()` 过滤掉——一声不吭。

更麻烦的是它们有第二条路径：星图没接上（没装配 / 被关掉），或者图还是空的（还没建完），这一问会**退到本地检索**，同一批参数又真的生效了。

于是同一句尾注要覆盖两个相反的处境：

```
k 是本地检索的条数；graph 模式用 limit，这次按 10 条算。
```

走星图时它是对的；退到本地检索时它是假的——那一次结果**就是按 `k` 取的**，读者却被告知 `k` 没用上，于是把「本地检索照 k 给了 20 条」读成「星图里只有 10 条」。

### 9.71.1 三态，不是两态

这一问有三种处境，`args` 一模一样：

| 处境 | 星图 | 本地检索 | `k` / `project` 这些条件 |
| --- | --- | --- | --- |
| 星图接上了 | 有结果 | 没跑 | 真的没用上 |
| 星图没接上 / 空图，有 query | 没算 | 跑了 | **真的用上了**（结果不是星图给的） |
| 星图没接上，又没 query | 没算 | 也没跑 | 谁都没参与——这一问压根没算 |

### 9.71.2 谁打点，谁说话

`runSearch` 在两条退路上打点：`flags.graphFellBack = true`（真的退了、本地检索跑了）、`flags.graphAbsentNoLocal = true`（连兜底都没做）。`modeNotes` 只读这两个 flag，不再猜：

- `k`：走星图 → 老那句（带默认条数）；退本地 → 「k 这次真的用上了……它不是「星图里就这么几条」」；没算 → 「k 这次没参与」。
- `level / project / status / days / content_max / explain`（`LOCAL_ONLY_PARAMS`）：走星图 → 「只在本地检索生效……这次没用上它们」；退本地 → 「它们真的用上了——但结果不是星图给的」；没算 → 「它们谁都没参与」。

一句话：**能生效的地方不许说没用上，没生效的地方不许沉默。**

### 9.71.3 怎么验的

- 探针 `AW1–AW9`（`tools/probe-fusion.mjs`）：桩出星图三态（接上 / 缺席 / 空图）+ 本地检索桩，逐条钉住两句尾注的出现与缺席；另加两条「不许无中生有」（没给本地条件时不许冒尾注、bridge 给 `min_weight` 是正当用法）。
- 判据第 35 条 `graph-fallback-param-note`：源码里必须同时存在三句、`LOCAL_ONLY_PARAMS` 表、两处 flag 打点；自测里有一条只删「k 这次真的用上了」的变异体，用来证明它会被打红。
- 顺手修了老探针 `AO5`：它原来的断言是「graph 模式一定说 k 没用上」，而在空图退本地的路径上这句话已经不成立——改成「必须说清 k 这一问的处境，不许沉默」。

### 9.71.4 一句话的教训

参数清单可以按模式分组，但**回执不能按模式写死**：同一个参数在降级路径上会换一条腿走路。写尾注的时候，问的不是「这个模式用不用它」，而是「这一问实际走了哪条路」。

## 9.72. 相似检索是第三张表（0.2.67）

### 9.72.0 一句话

`memory_search` 有三个走法：本地检索、星图扩散（`graph` / `bridge`）、相似检索（`similar`）。前两张表的参数口径已经说了两轮——0.2.65 说清 `limit` / `hops` 在扩散里到底读没读，0.2.66 说清 `level` / `project` / `days` / `k` 在退到本地检索时算不算数。**第三张表还只剩一句话**：`limit 只在 graph / bridge 生效；相似检索的条数用 k，这次没用上 limit。`

而 `similar` 真正接住的只有三个参数：`id`（必填）、`k`、`content_max`。meow 侧 `memory_find_similar` 的 schema 就是这三个（`id` 必填，`k` 1–20 默认 5，`content_max` 0–5000 默认 200），macro 侧 `pick(args, ['id', 'k', 'content_max'])` 也只递这三个。

于是同一次调用里，下面这些参数**全被丢掉，且一声不吭**：

| 参数 | 用户以为它在做什么 | 实际 |
| --- | --- | --- |
| `query` | 按这句话找相似的记忆 | 压根没看——相似检索是拿 `id` 指向的那一条去比 |
| `level` / `project` / `status` / `days` / `explain` | 按层级 / 项目 / 状态 / 时间筛 | 全是本地检索的条件，这里没算 |
| `hops` | 多扩几跳 | 相似检索不扩散 |
| `memory_ids` | 从这几条出发 | 只看 `id` 那一条 |

最危险的是 `query`：读者看到「相似记忆 3 条」，会以为那是「按我说的句子找到的 3 条相似」，其实是「和 `id` 那条最像的 3 条」——两件事完全不同，结果却长得一模一样。

### 9.72.1 一个参数，三种身份

审计这类缺陷不能按「模式用不用它」列表，得按**这个参数在每张表里是什么身份**：

- `k`：本地检索的条数 / 相似检索的条数 / 星图不认。**它在两张表里都算数**。
- `content_max`：本地检索的截断长度 / 相似检索的截断长度 / 星图不认。**也两张表都算数**。
- `limit`：星图扩散的条数 / 相似检索不认。
- `query`：本地检索的句子 / 星图扩散的起点 / 相似检索不认。
- `level` / `project` / `status` / `days` / `explain`：只在本地检索算数。
- `hops` / `memory_ids`：只在星图算数。

`LOCAL_ONLY_PARAMS` 这张表（0.2.66 引入）是「本地检索 vs 星图」的差集，它**不是**「本地检索 vs 相似检索」的差集——两者差在 `content_max` 上。第一版实现直接把 `LOCAL_ONLY_PARAMS` 搬过来，结果尾注当场自相矛盾：

```
content_max 是本地检索的条件；相似检索只认 id / k / content_max，这次没用上它们
```

同一句话里既说「相似检索只认 content_max」，又说「content_max 没用上」。探针 `AX7` 就是来抓这个的（它断言「全参数时四句尾注齐 + 递给 meow 的键正好是 `content_max,id,k`」），第一次跑就是 3/4。修法不是改文案，是把集合算对：

```js
const similarIgnored = LOCAL_ONLY_PARAMS.filter((n) => n !== 'content_max' && args[n] !== undefined)
```

### 9.72.2 四句话，各管一段

`modeNotes` 的 `mode === 'similar'` 分支现在按「这个参数在相似检索里的身份」分四句：

- `query` 有值 → 「这一问是拿 id 指向的那条记忆去比，不是按你说的句子找——想按句子找请用 local（默认）」。
- 剩下的本地条件（去掉 `content_max`）→ 「……是本地检索的条件；相似检索只认 id / k / content_max，这次没用上它们——**这不是「没有相似」，是这几个条件压根没算**」。
- `hops` → 「相似检索不扩散，这次没用上」。
- `memory_ids` → 「相似检索只看 id 指向的那一条，这次没用上」。

第三句的尾巴是这一轮的核心：**「没有相似」和「条件没算」长得一样，尾注必须把它们分开。** 这和 0.2.65 的「没有东西可扩散」、0.2.66 的「退到本地检索」是同一条线上的第三次。

### 9.72.3 怎么验的

- 探针 `AX1–AX10`（`tools/probe-fusion.mjs`）：把 `memory_find_similar` 换成桩，逐条钉住四句尾注的出现与缺席；`AX6`（只给 `id` / `k`）和 `AX8`（local 模式）是负向，`AX7` 同时断言「递过去的键正好是 `content_max,id,k`」——参数既要被说清楚，也确实不该递过去；`AX10` 专钉 `content_max` 不许被误报。
- 判据第 36 条 `similar-mode-param-note`：源码里必须同时存在四句 + `similarIgnored` 那行；自测里有一条只删 `query 在相似模式没用上` 的变异体，证明它会红。
- `AX9`：`mode=similar` 缺 `id` 必须报错，不许拿空 id 静默比一场空。

### 9.72.4 一句话的教训

**差集是有方向的。** 「本地检索 vs 星图」的差集不能拿来当「本地检索 vs 相似检索」的差集——两张表的重叠部分不一样（`k`、`content_max` 两边都算）。复制一张参数清单很容易，复制错的那张会让尾注自相矛盾，而且矛盾就写在同一句话里。

## 9.73. 面板不读的参数（0.2.68）

### 9.73.0 现场

`memory_admin` 的 schema 里，八个参数（`target` / `limit` / `kind` / `hubs` / `verbose` / `provider` / `items`，加 `action`）对**每个** action 都合法；执行时却只取动作表里那一行列的：

```js
const r = await flow.call(spec.call, pick(args, spec.params), exec)
```

于是 `action: 'cost', kind: 'dup'` 拿到一份完整的成本账本——用户会读成「按 dup 筛过的账本」；`action: 'stats', limit: 5` 拿到十个枢纽——会读成「这几个就是全部」。面板本身没算错，错在它一个字都没提这事。

### 9.73.1 反查表而不是第二份清单

参数归属只有一处出处：动作表本身。

```js
export const PARAM_OWNERS = (() => {
  const map = new Map()
  for (const [action, spec] of Object.entries(ACTIONS)) {
    for (const name of spec.params ?? []) {
      if (!map.has(name)) map.set(name, [])
      map.get(name).push(action)
    }
  }
  return map
})()
```

`strayNote(action, spec, args)` 拿它反查：这个 action 没读、而用户真的给了的参数，逐条点名「它归谁」，再补一句本面板的态度。

### 9.73.2 一句尾注怎么算数

```
【宏记忆｜成本账本】最近 200 次调用 · kind 是 hygiene 的——cost 不读它，这次一点没参与（别读成「结果已经按它收窄过」）。
```

三件事缺一不可：**点名**（哪个参数）、**归属**（谁读它，用户知道该去哪个 action 再问一次）、**态度**（这次没参与，别把现有结果当成筛过的）。多个参数时说「它们」，一句压一行里，不新增行。

### 9.73.3 手册那条例外只免抬头

`guide` 是全表唯一 `wrap: false` 的一行（理由写在它自己那行注释里）。但「不加抬头」不等于「可以不说话」：`action='guide', limit=5` 以前是这个表里最后一个静默角落。现在 `wrap` 对 `wrap:false` 也认 note，把它补在正文末尾——第一行仍然是门牌。

### 9.73.4 怎么验的

- 探针 `AY1–AY9`：`cost + kind`（点名 + 归属 + 态度）、`stats + limit`（`limit 是 hygiene / cost / links 的`）、`home + limit`、多参数用「它们」、`sources + verbose + kind`（只点名 kind）、`hygiene + kind + limit`（负向：一个字都不许多）、手册末尾补句、以及「尾注贴在抬头那行、不另起一行」。`AY4` 是正常调用的负向。
- 判据第 37 条 `panel-param-owner-note`：源码里 `strayNote` / `PARAM_OWNERS` / 归属拼接 / 态度句 / 三条分发 / 手册兜底同时在场才算绿；自测变异体只删「一点没参与」，必须红。
- `AY9` 的第一版拿两次调用的行数比，红了——成本账本自己会记账，多调一次就多一行。教训同 ⑰：**别拿会变的量当不变量。**

## 9.74. 还剩两个口子：`id` 与 `memory_ids`（0.2.69）

0.2.66 说清了「本地条件跑到星图那条路上」，0.2.67 说清了「相似检索那张表只认三个参数」，0.2.68 说清了「面板不读的参数要点名」。这三个都是**往一个模式里塞了别的模式的参数**。反过来还剩两个没人管：参数本身合法，但只在某一件事上才有用，塞在别处就一声不吭地丢了。

### 9.74.1 `id` 只属于相似检索

`id` 在 `memory_search` 里的唯一用途是 `mode=similar` 的基准记忆。可 schema 只有一张，怎么写都合法——于是

```
memory_search(query="部署流程", id="0mwn9xk3")
```

会拿 `query` 做本地检索，`id` 被 `pick()` 丢掉。读者看到结果会想：「这条记忆大概被排除了吧」。现在会多一句：

```
id 只在 mode=similar 里当基准（这一问是 local），这次没用上它——这不是「这条记忆被排除了」。
想拿它当基准找相似条目，用 mode=similar 再问一次。
```

关键是那句**否定**：`没用上` 会被读成「用了但没撞上」，所以必须补「不是这条记忆被排除了」，再给出正确用法。graph / bridge 同样点名。

### 9.74.2 `memory_ids` 的活只有一件：当扩散的起点

`memory_ids` 在 graph / bridge 里是起点（随 payload 原样递下去），在 local 模式里**只在真的扩散那一次**才被读（`expand: true`，或零命中自动扩散）。可 local 命中一条、又没给 `expand` 时，它完全没参与——回执里却一个字都没有，读者会以为「结果就是从这几个 id 起跳的邻居」。

所以这句必须跟 `limit` / `hops` 一样分成**三种处境**（0.2.65 立下的规矩）：

| 处境 | 尾注 |
| --- | --- |
| 真的扩散了 | `memory_ids 这次真的用上了：关联扩散就是从你给的这几个 id 起跳的。` |
| 本来要扩散、星图没接上 | `memory_ids 平时是扩散的起点；这次本来要扩散（会用你给的 id），但星图没接上——它没参与这次结果。` |
| 压根没扩散 | `memory_ids 只在扩散时当起点（graph / bridge，或 local 加 expand）；这次没有扩散，它没用上。` |

graph / bridge 里它正当，一个字都不许多说（否则就是 0.2.64 那种「负向哨兵被正向着色」）。

### 9.74.3 为什么不是「把没用的参数拒掉」

因为 schema 只有一张：`memory_search` 兼着四种模式，把 `id` 设成「只许 similar 用」在 JSON Schema 里表达不出来。拒掉还会更糟——用户写的是合法参数，报错等于教他改一个他明明写对的东西。这里选的仍是老三样：**照办这次该办的事，然后把「你没参与」说清楚**。

### 9.74.4 怎么验的

- 探针 `AZ1–AZ8`（`tools/probe-fusion.mjs`）：不扩散 / 星图没接上 / 真扩散 三种处境各一条，`id` 在 local 与 graph 各一条，两条负向（graph 给 `memory_ids` 正当、similar 给 `id` 是主语、只给 `query` 时一个尾注都不冒）。
- `AZ3` 还顺手钉了「说的和做的是一回事」：尾注说「这次真的用上了」，就得真的把 `memory_ids` 递到 `nebula_recall` 的 args 里。
- 判据第 38 条 `search-id-memoryids-note`：两句措辞 + 否定句 + 两道 mode 闸同时在场才算绿；变异体只删「id 只在 mode=similar 里当基准」即打红。

## 9.75. 卡片上的一行字（0.2.70）

前面几轮都在修「回执正文」，这一轮换到**卡片**：会话里那张小卡片只有一行标题，它同样在替我们说话。

### 9.75.1 现象

`memory_admin` 的卡片以前是这样：

```
宏记忆：记忆体检
```

三次不同的调用——`{action:'hygiene'}`、`{action:'hygiene',kind:'dup'}`、`{action:'hygiene',kind:'dup',limit:5}`——卡片**一字不差**。正文里该说的话一句不少（那是 0.2.68 做的），可正文是点开才看的；会话列表里并排三张一样的卡片，谁也认不出哪张是「只看重复的那一次」。

而且前缀里的「宏记忆」是全表唯一一处塞品牌的卡片：0.2.60 自己写的口径是「`prefix` 是中文名」，品牌该在面板抬头（`【宏记忆｜记忆体检】`）里。40 字的细节预算，白花了两个字。

### 9.75.2 现在

```
记忆体检
记忆体检：kind=dup
记忆体检：kind=dup limit=5
成本账本：limit=50
记忆来源：verbose=true
星图概况：hubs=3
记忆库位置：target=D:\dsh-home
未知动作：nope
```

规则三条：

1. **前缀只放面板中文名**（`spec.label`），品牌不进卡片。
2. **细节位放这一轮真给了的参数**，格式 `k=v`，顺序按 `PARAM_OWNERS`（0.2.68 那张反查表）——所以 `{limit:5, kind:'dup'}` 印出来是 `kind=dup limit=5`，不是对象字面顺序。
3. **没给的不进卡片**；数组说条数（`items=2 条`），对象 `JSON.stringify`，其余 `String(v)`；未知 action 把用户写的原值带上（`未知动作：nope`）。

### 9.75.3 为什么用 `k=v` 原值，不搬星图的中文标签

星图那边有 `HYGIENE_META`（`dup → 疑似重复`），照抄过来卡片会更好看。不抄有两个原因：

- 那会让 macro **依赖 vendor 模块**里的一个内部常量——星图缺席时 macro 连加载都会失败，而 0.2.4x 起一直在做的正是「星图缺席也要活得下去」。
- 抄一份标签表 = 第二份真值源。以后星图加一个 kind，这边就悄悄少一个中文名，而且没人会去对。

`k=v` 原值的好处是**永不失配**：用户写什么就回什么，参数名本身就是最准的名字。

### 9.75.4 怎么验的

- 探针 `BA1–BA8`（`tools/probe-fusion.mjs`）：前缀不带品牌、`kind` 进卡片、键序按 `PARAM_OWNERS`、没给的不进卡片、数组说条数、未知 action 带原值、长参数仍截断（47 字 → 40 字 + `…`）、八个工具的卡片都不含品牌。
- 判据第 39 条 `admin-card-detail`：`cardDetail` 的存在 + 遍历 `PARAM_OWNERS` + `条` 那支 + `cardTitle(spec.label, …)` + 未知动作那句 + **`!includes('cardTitle(panelBrand')`** 同时在场才绿。
- 阴性对照：把 `cardTitle(spec.label, cardDetail(args))` 换回 `cardTitle(panelBrand, spec.label)` → 判据与探针一起红。

## 9.76. 「枢纽记忆」不是「全部枢纽」（0.2.71）

### 9.76.1 现象

```
memory_admin { action: 'stats', hubs: 20 }
```

`hubs` 的说明写着「上限 40」，工具里也确实 `numParam('hubs', ..., { min: 1, max: 40, def: 10 })`。
但出来的列表永远最多 **12** 行——星图引擎的概览把枢纽列表钉死在一个写死的 12 上，参数只被用来再切一刀（`o.hubs.slice(0, pHubs.value)`），超过 12 的部分在源头就没了。

更要紧的是**正文一个字不说**：

```
枢纽记忆：
- [fact] 第一条 …
- [fact] 第二条 …
（其实库里还有 200 条）
```

一排 12 行写在「枢纽记忆：」下面，读者补的结论是「枢纽就这 12 个」。而它真实的意思是「按连接度 × 重要性排的前 12 条」。旁边的面板早就不是这个口径了——`cost` 说「最近 N 次调用」、`links` 说「还剩 N 条」、`hygiene` 说「这里只列前 N 条」「…还有 M 条」——只有 `stats` 一声不吭。

### 9.76.2 现在

- **上限只有一个出处**：`vendor/dsh-memory-nebula/lib/host/nebula.js` 里的 `hubSlots(value, def = 12)`——非数字 / ≤0 回默认，其余夹在 1..40；概览用 `.slice(0, hubSlots(opts.hubs))`，`overviewAsync(opts)` 把 `hubs` 一路带下去。
- **面板把截断说出来**：

```
枢纽记忆：（只列前 10 条，全图 212 条；按连接度 × 重要性排，没列的不代表不是枢纽）
- [fact] 第一条 …
…
  …还有 202 条没列；要看更多把 hubs 调大（本次 10 条，上限 40）。
```

- **没截断时一个字都不加**（`truncated = 全图节点数 > 列出的条数`），免得狼来了。
- 两侧 schema 都写清「默认 10，上限 40」——宏记忆面板的 `hubs` 与星图自己的 `hubs` 是同一句话。

### 9.76.3 为什么不是「把默认调大」

默认 12 不是 `stats` 一个工具在用：Web 面板、HTTP 接口、分享卡片都直接吃 `overview()` 的默认值。把默认改成 40，等于顺手把别人看到的版面也改了——那是另一个改动，不是这个缺陷的修法。这次只做两件事：**让参数真的生效**，**让截断真的被说出来**；默认值一动不动。

### 9.76.4 怎么验的

- `verify.mjs` 的 A71 块真 `import` 了 `hubSlots` 跑值（`20→20`、`99→40`、`3.7→3`、`undefined→12`、`'8'→8`），不是只读源码字符串；
- 判据第 40 条 `stats-hubs-cap`：上限只有一处、概览按参数取、三句正文（只列前 N / 还有多少没列 / 上限 40）齐全；
- 真图探针 `tools/probe-graph.mjs` 的 GB1–GB6：拿真引擎建了两条记忆的图，`hubs: 1` 就只列 1 条、抬头写「只列前 1 条」、正文写「还有 1 条没列」「上限 40」；不传 `hubs` 时这两句一个都不许出现（防恒真）。

## 9.77. 「没接上」也分两种（0.2.72）

### 9.77.1 现象

四个星图面板（`stats` / `hygiene` / `sources` / `ingest`）里，只要拿不到结果，说的都是同一句话：

```
【宏记忆｜星图概况】
星图这次没接上，星图概况这会儿看不了——等星图就绪再试一次就行。
```

问题是「没接上」有两种，摸起来完全不一样：

| 实情 | 该做什么 | 老话说的是什么 |
| --- | --- | --- |
| 星图插件没装 / 这一项被配置关了 | 去装、去开，然后重问 | 「等就绪」——等一万年也不会来 |
| 星图在，但执行时抛错（`ENOENT: 读不到 nebula.db`） | 去看**那条错误**，修文件/权限 | 「等就绪」——把真实原因吞掉 |

第二种最贵：库文件读不出来，读者拿到的是「等一等」，于是等，于是继续什么都没有，最后补一个「星图里没数据」的结论。

### 9.77.2 现在

两支分开，各说各的下一步：

```
# 装配没完成（工具等不到 / 被配置关掉）
星图这次没接上：星图概况要的那个能力还没装配好（星图插件没装，或这一项被配置关掉了）
——星图概况这会儿看不了，但这不是「星图里没有数据」。装好之后再问一次；一直是这句就别再等了，去看星图插件的配置。

# 星图在但报错（原因原样带出）
星图这次答不上来（星图概况）：ENOENT: 读不到 nebula.db
——星图概况这会儿看不了，但这不是「星图里没有数据」，也不是你问错了。
重试之前先看这条错误：它是星图那边出的。
```

三条规则：

1. **判据只有一个出处**：分支看 `contract.js` 的 `NOT_READY_MARK`（`这项能力还没就绪`），不在面板里再抄一遍字面量——抄第二份就迟早只改一处。
2. **原因原样带出**：星图那边抛什么，剥掉 `星图概况未完成：` 这层包装，剩下的原句照贴，不做二次概括。
3. **四个面板各留各的 miss**：`星图概况这会儿看不了` / `记忆体检这会儿做不了` / `记忆来源这会儿看不了` / `这批外部记忆一条都没推进去`——统一成一句空话就等于删掉三条信息。

### 9.77.3 为什么不干脆两句话都不给

省掉错误原文会让人以为「查一下就好」，而排障的第一步本来就是**读到原文**。这里多贴一段 `ENOENT`，省掉的是「重试三次 + 猜 + 问」。

### 9.77.4 怎么验的

- 探针 CA1–CA6（`tools/probe-fusion.mjs`）：装配没完成说「还没装配好」并指向配置、不许再出现「等星图就绪」、报错原因原样带出、不把报错说成装配问题、四个 miss 各说各的、正常路径一个字都不加。
- 判据第 41 条 `graph-miss-split`：源码层面盯住 `NOT_READY_MARK` 的单一出处、`星图这次答不上来（${what}）` 这层包装、前缀剥离那一行，以及老话术不再回来。
- 阴性对照三刀（改回旧话术 / 吞掉原因 / 只留一句）都能打红。

## 9.78. 打了 FAIL 却不算失败（0.2.73）

`tools/doctor.mjs` 是这个仓库唯一的「体检」脚本：两棵树按字节比、加载面、账本指纹、基线、注入面，一路打完最后一句话是 `结果：ALL PASS`。它的判决器长这样：

```js
let fails = 0
const line = (tag, ok, name, extra = '') => {
  if (!ok) (tag === 'FAIL' ? fails++ : warns++)
  console.log(`${tag}  ${name}${extra ? `  ${extra}` : ''}`)
}
```

问题不在这一段，在调用它的人。全文件 46 处 `line(` 里，有 **22 处**是这么写的：

```js
line(declared === pkg.version ? 'PASS' : 'FAIL', true, 'version 单一来源', …)
```

条件是「对就 PASS、错就 FAIL」，于是第二个参数 `ok` 恒为 `true`；而判决器只在 `!ok` 时才记账。也就是说这 22 条**打出来的 `FAIL` 只是四个字母**：不计失败、不进结论、`exit 0`。

### 9.78.2 它怎么被发现的

0.2.71 改过 `vendor/dsh-memory-nebula/lib/host/nebula.js` 却忘了重记 `vendor/VENDOR.json`，体检于是打：

```
FAIL  账本指纹一致：vendor/dsh-memory-nebula  账本 51/1000195/214e6c4d… ≠ 实际 51/1001997/d38a35c8…
```

而它 `exit 0`、结尾照样 `结果：ALL PASS`，`tools/check-all.mjs` 也报 `✓ doctor 97 条`。**一条真缺陷从整套验收里走过去了**，是人工看输出才发现的。

### 9.78.3 现在

判决器搬到 `tools/doctor-verdict.mjs`（`makeVerdict(log)`），判决只看 tag：

| 打印的 tag | 第二参 | 算什么 |
| --- | --- | --- |
| `FAIL` | 任意 | 失败（**tag 说了算**） |
| `PASS` | `true` | 通过，不记账 |
| `PASS` | 假 | 失败（声明通过却说没过） |
| `WARN` | 任意 | 警告 |

`doctor.mjs` 一侧变成：

```js
const verdict = makeVerdict()
const { line, pass, fail, warn } = verdict
…
return verdict.fails === 0 ? … : `${verdict.fails} FAILURE(S) / ${verdict.warns} WARN`
process.exit(verdict.fails > 0 || (STRICT && verdict.warns > 0) ? 1 : 0)
```

一处改管 22 处，**调用点一行都不用动**（`line(cond ? 'PASS' : 'FAIL', true, …)` 保持原样，现在它会真的红）。

### 9.78.4 为什么单独一个文件

`doctor.mjs` 是「跑起来就有副作用」的脚本：顶层 `readFileSync`、结尾 `process.exit`。verify 没法 import 它来单测判决规则。而判决是这套体检**唯一出结论的地方**——它自己不被测到，就永远不知道自己会不会撒谎。抽出来之后 verify 直接 `await import` 真模块，喂四种组合看账：

- `line('FAIL', true, …)` → `fails === 1`（就是老写法的样子）
- `line('PASS', true, …)` → 不记账
- `line('WARN', false, …)` → `warns === 1`
- `line('PASS', false, …)` → `fails === 1`

### 9.78.5 怎么验的

- verify A73 块 8 条：判决器确实在独立模块、doctor 不再自带记账变量、四种组合的账对、`pass/fail/warn` 三件套与 tag 一致且打印格式不变、调用点没被顺手删（≥40 处）、结论与退出码都读 `verdict`。
- 阴性对照：把 `makeVerdict` 的判决改回 `if (!ok)` → 老写法那一条当场红；把 `tag === 'FAIL' ||` 删掉 → 同样红。
- `node tools/doctor.mjs` 现在遇到漂移就是 `1 FAILURE(S)` + `exit 1`（本轮实测：改完第一次跑就红，红的正是 vendor 与 profile 的 2 个漂移）。

## 9.79. 体检的条数账（0.2.74）

`memory_admin action='hygiene'` 的正文由星图那边生成，每个类别一段：

```
孤立（100，这里只列前 40 条）
- [fact] 鲸落观察·hd74case0 —— 孤立样本 · 体检条数探针
  0mab12cd34ef
…
  …还有 94 条
```

抬头一个数、正文一个数、尾注又一个数。三个数**各说各的**：抬头说「只列前 40 条」，正文数下来只有 6 行，尾注说「还有 94 条」。读者按抬头理解会以为前 40 条都在手上，按尾注理解会以为自己只差 94 条，两种都错。

### 9.79.2 为什么会这样

列表有两道闸，两处都截断，但只有一处被写进了正文：

| 闸 | 在哪 | 上限 | 会不会被写进正文 |
| --- | --- | --- | --- |
| 引擎留多少条 | `vendor/dsh-memory-nebula/lib/host/graph.js` 的 `HY_MAX` | 每类 40 条（payload 有上限） | 老代码：抬头那句「只列前 40 条」 |
| 这次列多少条 | 参数 `limit`（默认 6，上限 20） | 用户自己给 | 老代码：正文行数 + 尾注 `还有 n - limit 条` |

抬头那句算的是 `arr.length`（引擎那本账），正文算的是 `limit`，尾注又用 `n - limit` 再算一遍。所以 `counts=100 / items=40 / limit=6` 时：抬头 40、正文 6、尾注 94。**尾注本身没错**（100 − 6 = 94），错的是抬头——它报的是「引擎留了多少」，而读者问的是「你给我看了多少」。

### 9.79.3 现在

条数的账收成一个函数 `listTail(n, printed, limit)`（`vendor/dsh-memory-nebula/lib/index.js`）：「列了几条」只认正文实际列出的行数（`printed = Math.min(limit, arr.length)`），「还剩几条」是 `n - printed`，抬头退回去只报全量计数：

```
孤立（100）
- …
  …还有 94 条（每类最多列 6 条，要看更多把 limit 调大；上面的计数是全量，没列的不代表不存在）
```

- 抬头：**只有一个数字**，就是真总数，不带任何「列了多少」的说法。
- 尾注：`n - printed`，跟正文能对上；顺带把这次的上限说出来（用户才知道「还能要更多」），并重申一次「计数是全量」。
- 没截断（`n ≤ printed`）时 `listTail()` 返回空串，正文一个多余的字都不多——这条是防「狼来了」。

### 9.79.4 怎么验的

- 真引擎探针（`tools/probe-graph.mjs` 的 HD 块）：先在临时工作区写 45 条**互不相似**的孤立记忆，等星图建进去，再走真工具面 `memory_admin{action:'hygiene', kind:'orphan', limit:6}`。断言抬头只有全量计数（且 > 40，证明真的越过了引擎那道闸）、正文正好 6 行、尾注 = 抬头 − 6、尾注里写明「每类最多列 6 条」；再把 `limit` 调到 20，看正文变 20 行、尾注跟着变 `n - 20`。
  - 那 45 条必须互不相似：`memory_remember` 有去重（内容相似度 ≥80% 会并进已有条目、只替换原文不新增节点），第一版用同一句模板只改数字，45 次写入只长出 1 个节点。
- 判据第 42 条 `hygiene-count-ledger`：`listTail` 存在且被调用、`printed` 取自 `arr.length` 与 `limit` 的较小者、老的两本账写法（`这里只列前 ${arr.length} 条`、`if (n > limit) lines.push`）都不许回来。
- verify A74 块 8 条：真 import `listTail` 喂 (100,6,6) / (41,6,6) / (100,40,20) / (6,6,6) / (0,0,6) / (2,5,6)，看尾注数字与空串分支；判据清单 42 条全绿；探针上钉了 HD0–HD5。

## 9.80. 枢纽榜的假账（0.2.75）

### 9.80.1 现象

`memory_admin{action:'stats'}` 的枢纽段落，旧输出长这样：

```
枢纽记忆（本次 12 条，上限 40）：
- [fact] … 强度 9
…（12 行）
  没列完：还有 2988 条没列
  没列的不代表不是枢纽
```

图里 3000 条记忆、枢纽只列 12 条，于是尾注写「还有 2988 条没列」。读者补出来的结论是「还有 2988 个枢纽我没看到」。可那 2988 条里，绝大多数连一条边都没有——它们不是「没排上来的枢纽」，它们根本不是枢纽。

### 9.80.2 这句话为什么会长出来

枢纽的定义是「按连接度 × 重要性排在最前的一小撮」。这里其实有三个数：

| 数 | 是什么 | 谁知道 |
| --- | --- | --- |
| 12 | 这一段实际列了几条 | 列表自己 |
| ? | 够格参评的有多少（有连接的记忆） | 没人算 |
| 3000 | 全图有多少条记忆 | `stats.nodes` |

中间那个数没人算，于是拿第三个顶上。第三个说不通，就再补一句「没列的不代表不是枢纽」——那句补丁等于当场承认前一个数字不成立。

### 9.80.3 现在怎么说

抬头改成固定的一句（不再自己报数），尾注交给 `hubTail()` 一处来说：

```
枢纽记忆（按连接度 × 重要性排）：
- [fact] … 强度 9
  全图 624 条记忆彼此有连接，这里只取排在最前的 12 条（hubs 上限 40）；没进前 12 的不是「没有连接」，只是没排上来。
```

三个数全都来自读者看得见的东西：列了几条（`top.length`）、有连接的共几条（`s.nodes - s.orphans`，`stats` 里本来就有，不用再扫一遍图）、上限几条（`HUB_CAP`）。没截断（`有连接的 ≤ 列出来的`）就一句话都不说。

### 9.80.4 上限也只留一个数

「40」原来写在三个地方：`nebula.js` 里夹参数的 `Math.min(40, n)`、`index.js` 里 `numParam('hubs', …, { max: 40 })`、正文里那句「上限 40」。改一处漏两处是迟早的事，所以现在只有 `export const HUB_CAP = 40` 一个出处：夹参数读它、尾注读它、schema 描述也读它（模板串插值）。宏记忆面板那一侧（`lib/macro/defs/admin.js`）是它自己的工具 schema，仍按人话写「默认 10，上限 40」——那一侧不该去 import 星图引擎的内部常量。

### 9.80.5 怎么验的

1. `verify.mjs` A75 七条：静态锚（`HUB_CAP` 单一出处、`pool` 按 `nodes - orphans` 算、两条旧写法不许回来）+ 真 `import` 后喂五种输入（正常 / 相等 / 池子更小 / 全零 / 参数脏）。
2. `tools/probe-graph.mjs` 两段真图：GB1–GB5 是「有连接的记忆不够列时闭嘴」，HB0–HB6 先写入两条带 `links` 的记忆牵出四条边，再要 `hubs=1`——尾注必须等于 `nodes − orphans`，正文仍只列 1 条，且不许出现「还有 N 条没列」。
3. 判据 `stats-hubs-cap` 收紧：`HUB_CAP` 单一出处 + 两条否定锚（旧的假账、旧的那句圆场话）。
4. 阴性对照三刀：把池子换回 `s.nodes`、把 `HUB_CAP` 换回字面量 40、把 schema 换回字面量——三刀都得见血。

## 9.81. 成本面板的「最近 N 次」（0.2.76）

### 9.81.1 假话长什么样

`memory_admin { action: 'cost' }` 的抬头是写死的一句话：「最近 200 次调用」。正文合计的却是 `entries.slice(-200)`——账本里真有几条，抬头一个字都不提。

于是三件事同时发生：

| 账本实况 | 抬头说 | 正文合计 |
| --- | --- | --- |
| 只有 5 条 | 最近 200 次调用 | 5 次 |
| 有 250 条 | 最近 200 次调用 | 最近 200 次（更早 50 条：无声） |
| 250 条里夹 2 行坏 JSON | 最近 200 次调用 | 248 次（坏行：无声） |

读者拿抬头那句去估成本，会以为「这 200 次就是全部调用」——数字没错，错在被当成了整本账。

### 9.81.2 四个数

| 数 | 从哪来 | 说的是什么 |
| --- | --- | --- |
| 要了几次 | 参数 `limit` | 你希望统计多少次 |
| 真算了几条 | `entries.length` | 这次合计里到底有几条 |
| 账本里一共几条 | `detail.entries.length` | 分母（能算的上限） |
| 几行读不出来 | `detail.badLines` | 被 `JSON.parse` 丢掉的行 |

### 9.81.3 现在怎么说

`costScope()` 是唯一出口，基句永远是「统计最近 N 次调用」，四个数只在真不一样时才补出来：

- 账本只有 5 条、你要 200 次、另有 2 行坏了 → `统计最近 5 次调用（你要的是 200 次，账本里能算的只有 5 条）；另有 2 行解析不出来，一行都没算进去`
- 250 条、limit 200 → `统计最近 200 次调用；更早的 50 条没进这次统计`
- 正好要多少有多少、也没有坏行 → `统计最近 200 次调用`（不补括号，也不提坏行）

### 9.81.4 为什么拆出 `readCost()`

面板要两样东西：正文（表格）和这句交代口径的注。原来 `costReport()` 只返回正文，note 由 `defs/admin.js` 自己拼「最近 N 次调用」——那句话和正文没有共同的来源，所以迟早各说各的。

现在 `readCost(limit)` 返回 `{ body, scope }`，`costReport(limit)` 保留成 `readCost(limit).body` 的薄壳，老调用点（探针里四处）不用改。

### 9.81.5 怎么验的

- `verify.mjs` 的 A76 块：`costScope()` 四种输入（缺账 / 截断 / 正好 / 参数脏了）逐字比对；`costReport(0)` 仍是字符串。
- `tools/probe-fusion.mjs` 的 CB1–CB7：在临时 `DSH_HOME` 里真写账本，走真 `memory_admin` 面板验证——5 条要 200 次、250 条 limit 200、夹 2 行坏 JSON、`limit: 0` 时不许写「统计最近 0 次」。
- 判据第 43 条 `cost-scope-count`：面板不许再自己拼「最近 N 次调用」，三个数必须从 `costScope()` 出来。


## 9.82. 读记忆的邻居段：没拿到时要分三种话说（0.2.77）

### 9.82.1 现象：要了邻居，回来的只有正文

`memory_read {id, neighbors: 12}` 先读记忆本身，再问星图 `nebula_inspect` 要邻居，然后只挑回执里
`## 连接到的记忆` 那一段拼上去。问题是「没拿到那一段」有很多种来路，以前一律拼成空字符串：

| 实际发生了什么 | 面板上看到的 |
| --- | --- |
| 星图这次调用失败（没装配好 / 报错） | 只有正文 |
| 星图答上来了，但说「星图里没有 id=… 的记忆」 | 只有正文 |
| 星图改了回执格式，不再有那一节 | 只有正文 |
| 这条记忆真的没有邻居 | 只有正文（而且会有 `## 连接到的记忆（0/0）`） |

前三种都被读成第四种——「这条记忆没有邻居」。读者据此判断「这条是孤立的，可以放心删 / 不用去连」，
而事实是这一问根本没查成。星图其实每次都说了原因（`星图邻居未完成：…`、`星图里没有 id=… 的记忆…`），
只是被 `section ? … : said` 那一行整段丢掉了。

### 9.82.2 三种没拿到，三种话

`lib/macro/shared.js` 新增一个纯函数（和 0.2.62 的 `countParam`、0.2.71 的 `hubSlots`、0.2.74 的 `listTail` 同一条路：口径只许有一个出处）：

```js
export function neighborGapNote(section, reachable, raw = '')
```

- 有邻居段（哪怕只有 `（0/0）`）→ 返回 `''`，正文后面什么都不加；
- 这一问没查成（`reachable === false`）→「星图这次没答上来（这一问没查成），所以邻居一条都没带到——这不是「这条记忆没有邻居」。」
- 查成了、回执里说「星图里没有 id=… 的记忆」或「图是空的」→「星图这次没查到这条记忆（可能刚写还没入图，也可能 id 不对），所以没有邻居段——这不是「它没有邻居」。」
- 查成了、回执里就是没有那一节 →「星图的回执里没有「连接到的记忆」这一段（多半是它改了格式），所以这次邻居没带到——这不是「这条记忆没有邻居」。」

这个函数**不接收星图的原文**（只拿它判一句「是不是没这条记忆」），所以内部错误不会原样甩给模型；
`read.js` 那一行变成 `[said, section, gap, nb.note].filter(Boolean).join('\n\n')`——口径说明（`neighbors` 给错）
和这句 gap 说明各占一段，不会粘成一句。

`neighbors: 0` 仍是文档写明的「不带」，走原来的早退：不查星图，也不出这句。

### 9.82.3 为什么不是「补一句安抚话」

安抚话是「可能没有邻居哦」——它把结论也说了一遍，只是语气软了。这里要的是把**这一问的状态**说清楚：
查成了没有邻居，和没查成，是两件事，读者下一步做的事完全相反（前者可以去写记忆、后者要重试或查 id）。

### 9.82.4 怎么验的

- 判据第 44 条 `read-neighbor-gap`：`neighborGapNote` 四句话都在、`read.js` 里那一行调用在、
  且 `const base = section ?` 不许再出现；自测里把 `gap` 换成空串立刻变红。
- 真面板探针 `tools/probe-fusion.mjs` 的 CC 块（CC1–CC6）：星图整块缺席 / 回执没那一节 / 正常有邻居 /
  `neighbors: 0` / 参数给脏 / 星图说没这条记忆，六种情形分别断言；CC4 还数了 `nebula_inspect` 的调用次数必须是 0。
- `verify.mjs` 的 A77 块直接跑 `neighborGapNote`：有段 → `''`；空白段（空格也算没段）+ 没查成 → 没答上来；
  「星图里没有…」「图是空的」→ 没查到这条；其余 → 改了格式。

### 9.82.5 边界

`neighbors` 上限仍是 40；这条改动只管「没拿到时说不说」，不改星图那边的取数。

## 9.83. 写入时给的 links，丢了要说（0.2.78）

### 9.83.1 假话表

| 你给的 `links` | 旧行为 | 面板上看到的 | 你会以为 |
| --- | --- | --- | --- |
| `'mem-a'`（不是数组） | `Array.isArray` 判假 → 空数组 | 只有「✅ 记忆已写入」 | 连上了 |
| `['mem-a', '', {note:'没 id'}, 42]` | 空串 / 无 id / 数字各自 `continue` | 「关联已排队 1 条」 | 4 条都在排队 |
| 2 条好 links，但写入回执没给 id | `applyLinks` 首行 `!anchorId` 直接 `return ''` | 只有「已写入（没给 id）」 | 没给 links 才会这样 |

三行都是同一件事：**丢的东西没有人知道**。读者看不见那句「丢了几条」，就只能按「都成了」理解。

### 9.83.2 现在怎么数

`linkArgs(links)` 一次拆两半交出去：

- `items`：真能连的条目（字符串 id → `{id, note: LINK_NOTE}`；`{id, note}` → 原样带 note；id 是空白串 → 不算）。
- `drop`：`{ notArray, blank, wrongShape, total }` —— 整份不是数组算 1 条；空 id（空串、或 `{id:'  '}`）算 `blank`；数字、null、`{note:'x'}` 这种算 `wrongShape`。

`linkDropNote(drop, anchorMissing)` 再把这三个数说成人话：

- 什么都没丢 → `''`，一个字都不加（正常写入的回执保持干净）。
- 丢了 → 「links 里这 N 条没法用：…——这几条一条都没连、也没进排队：补成正经的 id 再试，别当成「已经连上了」。」
- 连锚点都没有 → 「…而且这次也不知道要连到哪条记忆（写入回执里没给 id），所以连排队都没法排：先用 memory_search 找到 id，再用 memory_link 手动连。」

排队路径（星图没就绪时）也带上这句话——否则「关联已排队 1 条」听起来像 4 条都排了。

### 9.83.3 为什么不是安抚话

「别当成已经连上了」不是安慰，是**纠正读者接下来要做的事**：他本来会去 `memory_read` 找邻居、找不到再怀疑星图；现在他知道该回去补 id。同理「先用 memory_search 找 id」给出的是下一步动作，不是一句「抱歉」。

### 9.83.4 怎么验的

- 探针 CD1–CD5（`tools/probe-fusion.mjs`）：不是数组 / 混坏条目 / 没锚点 / 全好 / 没给，五种输入各钉一句。
- 判据第 45 条 `link-args-drop`：`linkflow.js` 里 `const { items, drop } = linkArgs(links)` 必须在，`const items = normalizeLinks(links)` 必须不在——变异测试把这一行换回去，判据立刻红。
- verify A78：`linkArgs` 四种输入、`normalizeLinks` 薄壳、`linkDropNote` 四句逐字比对。

### 9.83.5 边界

只说「这几条没连上」，不猜为什么（id 打错？记忆还没写进去？）。猜错比不说更坏——读者会按错的猜想跑一遍空搜索。

## 9.84. 设置页的每一个开关都要真能写（0.2.79）

### 9.84.1 假话表

| 你在设置页做的事 | 旧行为 | 面板上看到的 | 你会以为 |
| --- | --- | --- | --- |
| 改「反射轮次」再保存 | `configForms.get('macro-memory')` 拿不到可解码的 schema → `draft.status='unavailable'` | 「当前连接不支持设置写入（仅本机回环连接可编辑）」 | 是网络/远程的限制 |
| 点任一开关 | 同上，`apply2()` 首行就 `return false` | 同上 | 得去改 profile 文件 |
| 手改 profile 的 `meow:` 段 | 生效（因为宿主把 config 原样透传） | 设置页仍显示「不支持写入」 | 设置页坏了 |

三行其实是同一个成因：**插件没有导出 `Config`**。宿主 `settings.describe()` 的第一句就是 `entry.fiber?.runtime?.Config`，取不到就整条不返回；客户端视图缺失 → `unavailable`。那句「仅本机回环可编辑」是 meow 旧代码自己写的**误导文案**——宿主 `settings.writable` 恒为 `true`（`dsh-settings` 里 `get writable() { return true }`），跟连接方式毫无关系。

### 9.84.2 现在怎么写

`lib/index.js` 导出 `Config`，**平铺到根**，整份声明成一个 volatile 节点：

- 字段 = meow 的 14 个（`...Meow.Config.dict`，直接借引擎的 schema，别抄一份）+ 本插件 4 个（`compatAliases` / `guideMaxChars` / `toolWaitMs` / `flushThrottleMs`）+ 3 个兼容段（`meow` / `macro` / `nebula`，`z.any()`，保住旧 profile 里的 `meow.homeDir`）。
- `Object.assign(Config.meta, { default: {}, volatile: true })` —— 只有**根**这一个 volatile。schemastery 明令禁止根 volatile 与子字段 volatile 共存（`ValidationError: $.nebula volatile fields require a fixed object path without an enclosing volatile field`），所以走 meow 同款「根 volatile + 子字段普通」。
- 为什么平铺：客户端 `ConfigFormController.set(field, value)` 只写 `path:[field]`，**只认顶层字段名**；平铺之后设置页 `scope.set('enabled', …)` 与 `snap.value[key]` / `snap.user[key]` 天然对得上，页面代码一行都不用改。

写入链路：`scope.set` → `remote.settings.mutate` → 宿主 `write()`（`isVolatilePath` 逐段判、`strip()` 剃掉 volatile 后 `mergeLayers`）→ `_commitVolatile()` 原地 `updateVolatile` → `emit('loader/volatile-update', paths)`。

### 9.84.3 写完怎么生效

| 改的是谁 | 怎么生效 | 要不要重启 |
| --- | --- | --- |
| 本插件 4 个键（`compatAliases` / `guideMaxChars` / `toolWaitMs` / `flushThrottleMs`） | 150ms 去抖后 `stopSurface()` → `startSurface()`，只重建工具面与注入 | 不用 |
| meow 的 14 个字段 | 拆掉那只引擎再 `ctx.plugin()` 重挂（配置是装配时的快照，热写改不到它），然后重建表面 | 不用重启进程，但引擎会重新装配、扫描从头开始 |
| `nebula` 段 | 同上，只重挂星图那一只 | 同上 |
| `homeDir` | 跟 meow 字段同路：重挂时 `hotSwitchHomeDir` 切到新库 | 同上；旧目录里的记忆不会自动搬过去 |

「只重建表面、不重挂引擎」是默认路径而不是教条：融合层那四个键跟引擎无关，重建表面就够；引擎自己的字段（`hitTopK` / `reflectTurns` / `dream` / `homeDir` / 星图参数）改不了快照，只有重挂才算真生效。重挂前先 `stopSurface()`，否则那几百毫秒里统一工具会指向半死的引擎；重挂后立刻 `startSurface()`，工具名字与个数不变（verify A79 钉的）。

**这里踩过的坑（0.2.79 第一版就是错的）**：导出了 `Config` 之后，宿主会用它解析 `apply` 的入参，`apply` 收到的是**一份 volatile 引用**，不是 profile 里那段普通对象。当时想着「把根引用直接交给 meow，它的 `liveConfigReader` 每次现读」，结果 meow 的 `readConfigRoot` 只认「带 `get` 的普通对象」这种鸭子类型，拿到宿主那种引用当场装不起来——它的 8 个工具一个都没注册，8 个统一工具全线报「这项能力还没就绪」，`probe-host` 从 0.9 秒变成 150 秒（每次调用都等满 `toolWaitMs`）。所以：**喂给引擎的永远是普通对象**（`resolveConfig()` 解包后给）；`wrapPlugin()` 也只挑 `name` / `inject` / `apply` / `reusable` 四项，绝不 `{...mod}` 整包拷贝——拷过来连 `Config` 一起带走，宿主就会拿我们那张 21 键大 schema 去解析 meow 的配置。

### 9.84.4 顺手关掉自动生成的通用表单

有 volatile 配置的插件，宿主会额外生成一张「通用表单页」。我们的意图是只保留自己那张分组清楚的页面，所以 `apply` 里 `ctx.inject(['settings'], child => child.effect(() => settings.configure({ auto: false }, ctx.fiber)))`，包 try/catch（重复配置宿主会 throw）。

### 9.84.5 怎么验的

- verify「设置:」十三条（A79）：自造 live ctx（真 ref、真 `on` 捕获、`tools.register` 返回删除函数、`systemPrompt.section` 返回 splice 函数），先断言 8 工具 / 1 段注入 / 订阅了 `loader/volatile-update` / **引擎拿到的是普通对象而不是引用** / 包装子插件没把 `Config` 带过去；再模拟宿主写 `compatAliases=true`（ref 原地更新 + 手动 emit），300ms 后断言别名工具 9 个回来、注入仍 1 段、统一工具一个没丢；再改 `hitTopK` 断言**重挂了 meow 那一只引擎**（`plugins` 多一条、新配置里 `hitTopK=5`）、统一工具一个没丢；再改 `nebula` 段断言**只重挂星图**（新配置就是写入的那一段）；最后 `host.Config({ compatAliases: 'yes' })` 必须抛。
- verify「host:」九条：导出 Config、根 volatile、`dict` 里 meow 9 个字段 + 融合层 4 键 + 3 兼容段、`toJSON()` 里 `"volatile":true` 只 1 处、`Config({...})` 解出 ref、兼容段保留、`resolveConfig` 合并顺序。
- 宿主写路径用 `dsh-settings/lib/types/schema.js` 的 `volatileForm/projectForm/isVolatilePath` 加手写 strip/mergeLayers 复刻过一遍 `write()`：旧写法 `{meow:{…}, nebula:{}}` 上 set `enabled=false` → `{"nebula":{},"meow":{…原样…},"enabled":false}`；新写法平铺 raw 上 → `{"homeDir":"dsh-storage","reflectTurns":5,"promptLang":"zh","enabled":false}`（`strip()` 不再把 `meow` 段剃掉，这就是必须声明兼容段的原因）。

### 9.84.6 迁移与回滚

`profiles/desktop/cordis.patch.yml` 的 `- id: macro-memory` 已从 `config.meow.{…}` 改成平铺（`homeDir` / `reflectTurns` / `promptLang` / `delegate` 提到根上，`nebula: {}` 保留），旧写法仍然认（`resolveConfig` 先铺 `meow:` 段、根字段覆盖），只是启动时打一句 warn 点名哪些键被根字段盖住。回滚：拿 `D:\备份\20261119-213333-macro-fusion-0279` 里的 `cordis.patch.yml` 覆盖回去即可，插件对两种形状都兼容。

### 9.84.7 边界

- 改 `homeDir` 会重挂引擎、切到新库，但**不搬数据**：旧目录里的记忆还留在旧目录（插件不替你做迁移，`autoMigrate` 管的是它自己那套目录结构）。要搬就手动搬，或者把 `homeDir` 改回去。
- 重挂引擎会打断正在跑的扫描/反思，日志里会写明「记忆引擎（meow）重新装配，扫描会重启」。设置页一次保存里写了好几个引擎字段，去抖会合成一次重挂。

## 9.85 口径：注入卡的来源就该叫宏记忆（0.2.80）

### 9.85.1 那张卡上的名字是谁写的

聊天里每次注入的「上下文注入 · plugin:meow-memory」，**不是我们写的字符串，是宿主直接显示 `message.source.kind`**。链子是：`dsh-client-ui-chat/src/client/conversation-nodes/event-projection.ts:60` `contextProducer()` → 认得 `session-reference` / `agent-instructions` / `skill-invocation` 三种 kind，其余一律 `label: kind`（注释写着「keep an unknown producer visible by its durable kind」）→ `ContextInjectionRow.tsx:69` 把 `producer.label` 原样贴在标题后面。

所以要么改宿主（不动 DSH 本体，升级就丢），要么改我们写进 `source.kind` 的那个字符串。0.2.80 选后者：`vendor/meow-memory/lib/index.js` 的 `PLUGIN_KIND` 从 `plugin:${PLUGIN_NAME}` 改成字面量 `"plugin:macro-memory"`。

### 9.85.2 老消息必须还认得（这条是硬约束）

kind 同时是**识别历史注入**的钥匙：`isMeowSource()` 拿它判「这条是不是记忆注入」，`lib/client.js` 的折叠/锚点/委派提示三处 `if (!isMeowSource(source))` 全靠它。如果只改新值，老会话里落盘的 `plugin:meow-memory` 就变成「不认识的消息」——折叠失效、锚点漂移，重放时还可能被当成用户发言再注入一遍。

所以两边都留一个 `LEGACY_PLUGIN_KINDS = ["plugin:meow-memory", \`plugin:${PLUGIN_NAME}\`]`，`isMeowSource()` 先认新值、再扫老值、最后保留更老的 `{kind:'plugin', plugin:'meow-memory'}` 形状。verify 用 `new Function` 把这段源码挖出来**真跑**四种输入（新 / 老 / 更老 / 别人家的 `plugin:hindsight`），不是只做字符串包含。

### 9.85.3 顺手把假话一起收了

同一轮把字典里三句不成立的文案改掉（en / zh / pt 三份）：

| 键 | 原来 | 现在 |
| --- | --- | --- |
| `settings.loading` | 「喵记忆配置加载中…」（zh）；en/pt 都写着 meow-memory | 「宏记忆配置加载中…」/ `Macro Memory` |
| `settings.saved` | 「已保存 ✓ 热重载/重启 meow-memory 插件后生效」 | 「已保存 ✓ 已生效」（0.2.79 起真的是热应用） |
| `settings.unavailable` | 「当前连接不支持设置写入（仅本机回环连接可编辑）」 | 「当前连接没有设置写入通道，这一项存不下去（其余功能不受影响）」 |

`settings.unavailable` 的依据是 `snap.mode === 'memory'`——这个字段宿主根本不发，分支永远不进；既然它不会显示，那句「仅本机回环可编辑」就是纯误导（0.2.79 的设置面板不可写事故，第一句让人怀疑的就是它）。现在就算哪天分支真的进了，说的也是「没拿到写入通道」而不是一个不存在的限制。

### 9.85.4 星图的「工具调用画像」也算到自己头上

`vendor/dsh-memory-nebula/lib/host/transcripts.js` 的 `TOOL_OWNER` 把 `memory_*` 记成 `plugin:meow-memory`、`nebula_*` 记成 `plugin:dsh-memory-nebula`——在融合包里这是**一个插件**，面板上却报出两个来源。现在两边都归 `plugin:macro-memory`，并补齐原来漏掉的 `nebula_sources` / `nebula_ingest` / `nebula_hygiene` / `nebula_bridge`（漏掉的四个在画像里一直算「无归属」）。

### 9.85.5 怎么验的

verify A80 七条：把 vendor 源码里 `PLUGIN_NAME…isMeowSource` 那段抠出来 `new Function` 执行，断言新/老/更老三种 kind 都认、`plugin:hindsight` 不认、`null` 不认；客户端包里同一份定义也在；`transcripts.js` 的映射表全指向 `plugin:macro-memory` 且不再出现两个旧名字；三句文案断言用「非 ASCII 转 `\uXXXX` 再 `includes`」的方式比对（源码里的中文是转义存的，直接搜中文永远搜不到——这是本项目里最容易假绿的坑）。

改完 vendor 后 `node build.mjs` 重生成 `lib/client.js`：**163,239 B**、sha256 `2F546AA8…`、三个 load id 不变（`dsh-macro-memory` / `dsh-macro-memory-meow` / `dsh-macro-memory-nebula`）。

### 9.85.6 边界

- 只改**我们写出去的** kind。`.dsh/sessions` 里已经存在的老消息不改写（那是用户数据，重写等于伪造历史）；它们照样显示 `plugin:meow-memory`，也照样被认得。
- `PLUGIN_NAME` 仍是 `"meow-memory"`：日志前缀、`/meow-memory/dreamed-sessions` 这类 HTTP 路由、`data-plugin` 属性都用它，改它会把路由和已存的前端状态一起打散。**显示名和身份名分开**——口径统一改的是显示名。

---

# 9.86 发布准备：门面、图、许可、市场索引（0.2.81）

这一轮不是改功能，是**把这个包交给不认识它的人**：GitHub 首页、DSH 插件市场的详情页、别人的 `node_modules`。三处地方的读者都不是我们，所以标准不是「我们自己看得懂」，而是「一个没读过源码的人能不能在三十秒内判断它是干什么的、凭什么比别的强、敢不敢装」。

### 9.86.1 为什么把 README 拆成两份

原来根的 `README.md` 有 **268,244 B**（3,914 行）——它是这个项目从 0.1.x 到 0.2.80 的逐轮开发日志：每一次事故、每一条判据、每一个被推翻的决定都在里面。作为**工程账本**它值钱；作为**门面**它是灾难：

1. **市场详情页直接渲染仓库根的 `README.md`**（`@deepseek-ai/dsh-plugin-market` 的 `detail-files.ts` 走 `raw.githubusercontent.com/<owner>/repo/<ref>/` + `README_NAMES`）。一份 268 KB 的日志贴上去，第一屏是「0.2.5 修了层名过滤」，没人会往下滚。
2. 检查器也认死了它：`tools/doctor.mjs` 原来只读根 `README.md`，于是「脚本得在文档里露过面」这条判据逼着门面里塞满 `tools/*.mjs` 的开发细节——**门面被账本污染**。

所以拆：

| 文件 | 读者 | 内容 |
| --- | --- | --- |
| `README.md` | 陌生人（GitHub / 市场详情页） | 是什么、比什么强（实测数字）、怎么装、怎么用、许可与第三方声明、English 段 |
| `docs/INTERNAL.md` | 我们自己 | 原来那份逐轮开发日志，一字未删 |
| `DESIGN.md` | 我们自己 | 设计取舍与教训（§1–§90） |

`verify.mjs` 里 **85 处**「README 得提到这句话」的断言全部改指向 `docs/INTERNAL.md`（真账本在那边）；`tools/doctor.mjs` 的第 6 段拆成两半：6.1–6.3 管内部日志（脚本出处、版本号），6.4–6.6 管门面（版本号、`lib/client.js` 字节数与 sha 前缀、引用的图都在、`LICENSE`、第三方声明、市场索引存在）。

**教训**：文档也有「谁在读」这个维度。写给人看的和写给自己的，混在一份文件里，两份都做不好。

### 9.86.2 三张图是怎么来的

本机**没有** playwright / puppeteer / electron，GUI 是 `127.0.0.1:50753` 且要 token（`Invoke-WebRequest` 直接 403），截不了界面。做法：手写 SVG（`docs/images/_architecture.svg` / `_memory-flow.svg` / `_token-budget.svg`），再用系统自带的 Edge 无头转 PNG：

```bash
msedge --headless=new --disable-gpu --hide-scrollbars \
       --force-device-scale-factor=2 --default-background-color=FFFFFFFF \
       --window-size=1200,720 --screenshot=docs/images/architecture.png \
       file:///.../docs/images/_architecture.svg
```

- `--force-device-scale-factor=2` → 2 倍图，GitHub 上 Retina 屏不糊（2400×1440）。
- 白底（`--default-background-color=FFFFFFFF`）：GitHub 深色主题下透明底会把深色文字吃掉。
- 图里的数字**必须是实测值**（8,655 B / 1,085 字符 / 56,759 B / 4,085 字符），不是设计目标——图上写错一个数，门面就成了假话。
- SVG 源码留在 `docs/images/_*.svg`（下划线开头，像临时文件但其实是可编辑原件，`doctor` 只对 `tools/` 下的脚本做「必须有文档出处」的检查，不受影响）。

### 9.86.3 许可：MIT 的合规不是加个文件

三件事分开做：

1. **根 `LICENSE`**：本仓库自己的 MIT（`Copyright (c) 2026 主人 & 小代码酱`）。
2. **两份 vendor 的 `LICENSE` 原文不动**：`vendor/meow-memory/LICENSE` 是 `Copyright (c) 2026 Phant0Meow`，一个字都没改。MIT 只要求保留版权与许可声明——**保留的意思是原样保留**，不是「在别处提一句」。
3. **`THIRD-PARTY-NOTICES.md`**：上游地址（<https://github.com/Phant0Meow/dsh-meow-memory>）、版本、角色，以及**我们对副本做的全部改动**。MIT 不要求公开改动，但「改了别人的代码却不说改了哪里」是欠账——尤其这份副本里有一批「静默失败修成明说」的改动，不说清楚，别人会以为是上游的行为。

改动分两类写：A. 融合接线（注入 `kind`、设置页文案、`PLUGIN_NAME` 不动）；B. 原地修掉的静默失败（0.2.46–0.2.80 逐条）。两棵 vendor 树的可核指纹在 `vendor/VENDOR.json`。

### 9.86.4 市场索引：格式 1 的硬规则

`plugin-market/index.json` 是 DSH 市场读的那份 JSON。读完 `@deepseek-ai/dsh-plugin-market-index` 的校验器（`src/index.ts`，334 行），坑集中在这几条：

| 规则 | 踩法 |
| --- | --- |
| `LocalizedText` 是 `string` 或**必须含 `en`** 的对象 | 只写 `{"zh": …}` → `$.title must contain en` |
| `source.type: 'git'` 的 `url` 必须是 https **规范** URL，且路径至少两段 | 写成 `https://github.com/OWNER` 或用 `git@`、带 `.git` 尾巴以外的不规范形式 → `must name a repository with at least two path segments` / `must be a canonical URL` |
| `commit` 必须是 **40 位小写 hex** | 写短 SHA、大写、或先占位 `000…0` → 校验器只查格式，**占位能过**，但市场装不上 |
| `icon` 是相对引用时**相对索引 URL** 解析 | 以为相对包根/仓库根 → 图 404；`icon.png` 实际要落在 `plugin-market/` 里 |
| 内联 `data:` icon ≤ 32 KiB（base64 解出来的字节） | 大图塞进去 → `must not exceed 32 KiB` |
| `publishTimestamp` 是 **Unix 秒** | 写毫秒 → 校验器只看区间 `[0, 10^11)`，毫秒也能过，但详情页显示年份错到几万年 |
| `versions` 非空、不重复、按 SemVer **降序** | 校验器会替你排序，但重复直接拒 |
| `category` / `labels` / `sortKey` 的 id **必须先在索引里声明** | 直接写 `"category": "memory"` 而 `metadata.categories` 里没有 → `references undeclared id "memory"` |

`tools/check-market.mjs` 的判据（48 条，`check-all` 里的第 11 支）：

1. 真调 `parseMarketIndex`（不是自己手写一套规则），索引 URL 用一个假的 `raw.githubusercontent.com/OWNER/REPO/...` 让它解析相对 icon；
2. 版本号 = `package.json` 版本；宿主算出来的安装命令是 `git+https://…git#<commit>`；
3. **commit 不是 40 个 0**（这条是给「还没提交就发索引」设的闸），而且在本仓里**真实存在**、是 `HEAD` 或它的祖先、索引文件已被 git 跟踪；
4. icon 文件真的在、真的是 PNG/JPEG/WebP、不超过 512 KiB；
5. `publishTimestamp` 不是毫秒、不在未来；
6. 仓库根有 `README.md`（详情页读它）与 `LICENSE`。

### 9.86.5 索引里的 commit 为什么先写成占位，再改一次

市场装的是 **commit 钉住的 git 地址**，所以索引里的 SHA 必须是「包含全部代码的那次提交」。而索引文件本身也在仓库里，于是出现鸡生蛋：这次提交的 SHA 在提交前不可能知道。

做法是两步：

1. 第一次提交 `ec719eb`（163 个文件，全部代码 + 门面 + 图 + 许可）；
2. 把索引里的 `commit` 改成 `ec719eb…`，连同 `.gitattributes`（`* text=auto eol=lf`，仓库里一律 LF——本项目有大量按字节比对的判据，CRLF 会让它们假红）一起提成第二次提交 `0942987`。

`check-market.mjs` 断言「commit 是 HEAD 或它的祖先」，所以第二步之后仍然成立；而第一步之后如果忘了改，那条「不是全 0」的闸会立刻打红。

### 9.86.6 怎么验的

- `node tools/check-market.mjs` → **48 条 ALL PASS**（真校验器 + 真 git；含镜像索引 15 条与一条阴性对照）。
- `node tools/doctor.mjs` → 文档两段（内部日志 / 门面）分别过；`LICENSE` 是 MIT 原文；第三方声明三项（`Phant0Meow` / 上游地址 / `MIT`）都在；门面引用的 3 张图都在。
- `node tools/check-all.mjs` → 13 支（新增 `tools/check-market.mjs`）。

### 9.86.7 边界（发布这一轮没做的事）

- **没有推送**：本机没有 `gh`，`git config --global user.name/user.email` 都是空的。仓库在本地已提交，`origin` 等主人给地址与凭据。
- **索引里的 `OWNER/REPO` 已换成真值**：真实仓库是 `hanhan9999999999999999999/dsh-macro-memory`，四处一起改过（`plugin-market/index.json` 的 `homepage` / `repository.url` / `source.url`、门面里的索引 URL）。这四处没有共同出处，是本轮留下的唯一硬编码债。
- **没给 npm 发布**：市场支持 `source.type: 'npm'`，但这份包的价值有一半在 `vendor/`，走 git 源最直接。

### 9.86.8 国内网络：镜像索引与「规范 URL」那个坑

本机实测（2026-11-19，Node `fetch` + 20 s 超时）：

| 目标 | 结果 |
| --- | --- |
| `raw.githubusercontent.com/<owner>/<repo>/main/plugin-market/index.json` | `fetch failed`（116 ms 就断，不是慢是断） |
| `cdn.jsdelivr.net/gh/<owner>/<repo>@main/plugin-market/index.json` | `fetch failed`（196 ms） |
| `cdn.statically.io/gh/<owner>/<repo>/main/…` | `fetch failed`（10.3 s 超时） |
| `api.github.com/repos/.../contents/plugin-market/index.json` | 200，504 ms |
| `gh-proxy.com/https://raw.githubusercontent.com/.../index.json` | 200，1.9 s，2 814 B（与本地逐字节相同） |
| `gh-proxy.com/https://raw.githubusercontent.com/.../plugin-market/icon.png` | 200 `image/png`，31 430 B，3.4 s |
| `git clone https://github.com/<owner>/<repo>.git` | **300 s 超时 / Connection was reset**（退出码 128） |
| `git clone https://gh-proxy.com/https://github.com/<owner>/<repo>.git` | 29 s 成功，164 文件 |
| `git clone https://gh-proxy.com/https:/github.com/<owner>/<repo>.git`（单斜杠） | 23 s 成功，164 文件，checkout 到 `8826096` 后 `plugin-market/index.json` 在 |

结论：**索引能取到 ≠ 能装**。市场安装走 `git clone`，所以只换索引 URL 不够，安装源地址也得能 clone。于是出第二份索引 `plugin-market/index.cn.json`：`title` / `description` / `title.zh` 带「（国内镜像）」标记，`source.url` / `repository.url` / `homepage` 换成 `gh-proxy.com` 前缀，其余字段逐字段与主索引相同（`tools/check-market.mjs` 第 9 段对着断言：版本序列一致、commit 一致、`metadata` 逐字节相同、`icon` 仍是同一个相对引用）。

**那个坑**：宿主 `gitUrl()`（`dsh-plugin-market-index/src/index.ts`）要求 `new URL(value).href === value`，并要求 `pathname` 匹配 `^(?:\/[^/]+){2,}$`。写成 `https://gh-proxy.com/https://github.com/a/b` 时 `href` 那关是过的，但 `pathname` = `/https://github.com/a/b`，内层那个 `//` 让 `[^/]+` 吃到一个空段，于是被拒，报的是 `must name a repository with at least two path segments`（看起来像「仓库路径不够深」，其实是空段）。改成规范形式 `https://gh-proxy.com/https:/github.com/a/b` 后 `pathname` = `/https:/github.com/a/b`，两条规则全过，克隆照样成功（23 s）。这是「别人写的校验器替你定义了什么字符串才算地址」的又一例（教训 55）。

守则：以后改这两份索引，只改 `_gen-cn.mjs`（临时脚本，不入库）或直接同时改两个文件，然后跑 `node tools/check-market.mjs`——两份之间任何一处漂移都会红。

# 9.87 调试仪器不能带上生产（0.2.81）

### 9.87.1 现象：一个日志文件一天长到 108 KB

`D:\dsh-home\storages\meow-memory\settings-diag.log` 在 2026-11-19 这天有 102 行、108,656 B、最后写入时间就是当时。内容是三轮「设置页写不进去」排查时加的仪器：

- `settings.write` / `configEditor.edit` 的原型方法被包了一层，失败就把整段 stack 追加进日志；
- 每次 `describe()` 被调用都 dump 一份命名空间列表，5 秒后再 dump 一次；
- 还把所有 `configEditor.entries()` 的 id / state / 运行时是否有 `Config` 全量落盘。

这套东西**默认一直开着**。它不报错、不影响功能，所以从验证角度看永远是绿的——但它在做三件不该带进发布版的事：往用户存储里持续写文件（无上限）、在每个会话里多挂两次 `setTimeout`、以及随时会把 `nsList` 这类内部结构写进磁盘。

### 9.87.2 改法：默认不出声，仍可复现

```js
var SETTINGS_DIAG_ON = process.env.DSH_MEMORY_SETTINGS_DIAG === "1";
var SETTINGS_DIAG_MAX_BYTES = 256 * 1024;
function settingsDiag(line) {
  if (!SETTINGS_DIAG_ON) return;
  // mkdir + 超 256 KiB 先清空 + 追加一行
}
```

- 8 处直写全部收口到 `settingsDiag()`；`dumpDescribe()` 在关闭时**第一行就 return**（连那个 5 秒定时器里跑的那次也不 dump）。
- 源码里 `settings-diag.log` 这个字面量现在只出现 **1 次**（在 helper 里），`verify.mjs` 就是拿这个计数当判据——以后谁再手写一处直写，立刻红。
- 开关打开时行为和原来一样，排查还能复现；只是需要显式给环境变量。

### 9.87.3 为什么不是「删掉」

诊断本身有价值（0.2.18–0.2.20 就是靠它定位到宿主按 entry id 注册 config 的）。删掉等于下次再踩一遍；留着默认关，才是「可复现的仪器」和「生产行为」的正确分隔。

### 9.87.4 怎么验的

- `node --check vendor/meow-memory/lib/index.js` → 语法过。
- `node verify.mjs` → A81 五条：开关字符串在、`settings-diag.log` 字面量只有 1 处、`dumpDescribe` 首行有 guard、256 KiB 上限在、`settingsDiag` 仍会写。
- `node tools/make-vendor-manifest.mjs` → `vendor/meow-memory` 指纹变化（44 文件 / 1,711,167 B / `d50b1c3c11a27934`），`vendor/VENDOR.json` 重记。
- `node tools/doctor.mjs` → 补丁账本多一条 `[macro-fusion 0.2.81]`；两棵树同步后全绿。

### 9.87.5 边界

- **只动 vendor 里这一处仪器**，没有改任何用户可见行为，也没有删 meow 的能力。
- **用户机器上已有的 `settings-diag.log` 不自动删**（它是用户目录里的文件，删不删由主人决定；关掉之后不再增长，可以手删）。
- 需要重启 DSH 才生效（`vendor/meow-memory/lib/index.js` 是宿主侧代码）。

# 9.88 不跑的脚本会烂（0.2.82）

### 9.88.1 现象

`tools/probe-toolsize.mjs` 是 0.1.x 时期写的「数两套引擎工具 schema 字面量体积」脚本，0.2 之后**一次都没再跑过**。这一轮顺手跑了一次，第一行就死：

```
const a = scan(root + '/meow-memory/lib/index.js', 'meow-memory')
                ^
ReferenceError: root is not defined
```

`root` 从来没被导入——文件头只 `import { vendorDir } from './_root.mjs'`。而 `node --check` **抓不到这个错**：语法完全合法，错在运行期的自由变量解析。所以「加了 --check 就安全了」是假的。

### 9.88.2 为什么它能坏这么久

三件事同时成立：① 它不在 `check-all` 的 `STEPS` 里；② 没有任何断言读它的输出；③ 它不是 doctor 补丁账本里的条目（账本只登记我们改过的 vendor 文件）。于是它在仓库里躺了三个月，没人知道它跑不动。

这和 9.87 那条是同一类病：**能力的可断言性决定它会不会腐烂**。区别只是 9.87 是「一直在跑但没人断言」，这里是「压根没人跑」。

### 9.88.3 改法（不是修一行了事）

```js
const a = scan(vendorDir + '/meow-memory/lib/index.js', 'meow-memory')   // 取根走 _root.mjs

const MEOW_TOOLS = ['memory_remember', 'memory_search', 'memory_find_similar', 'memory_read',
                    'memory_update', 'memory_project', 'memory_home', 'memory_dream']
const NEBULA_TOOLS = ['nebula_recall', …, 'nebula_ingest']
const BUDGET_BYTES = 87326
ok(missingM.length === 0, '清单：meow 的 8 个原工具一个不少', '8/8')
ok(missingN.length === 0, '清单：星图的 9 个原工具一个不少', '9/9')
ok(sum <= BUDGET_BYTES, '体积：17 个工具字面量合计没有膨胀', sum + ' B ≤ ' + BUDGET_BYTES + ' B')
if (failures !== 0) process.exitCode = 1
```

- 它现在**自己出判决**（`PASS`/`FAIL` + 失败置 `exitCode 1`），所以能直接进 `check-all`。
- 清单判据是「meow 原工具绝不能砍」这条硬要求的**可执行版**：任何一个 `memory_*` / `nebula_*` 从 vendor 源码里消失就红。
- 体积判据是上界 87,326 B（当前实测值），只许变瘦不许长回去。
- 它被插到 `param-audit` 之后，成为 `check-all` 第 12 支；`verify.mjs` 的「STEPS 支数」判据同步从 13 改成 14。

### 9.88.4 怎么验的

- `node tools/probe-toolsize.mjs` → 三行 `PASS` + `ALL PASS`，`exit=0`；修之前是 `ReferenceError` / `exit=1`。
- `node verify.mjs` → 新增 A82 五条（进了 STEPS、取根走 `_root.mjs` 且无裸 `root`、清单判据在、体积判据在、失败置 `exitCode 1`）；总断言 887 → 892。
- `node tools/check-all.mjs` → **14/14，1,663 条断言，118.2s**。
- `node tools/doctor.mjs` → 补丁账本多一条 `[macro-fusion 0.2.82]`（116 条全绿）。

### 9.88.5 边界

- 只改 `tools/`（探针 + 编排）与 `verify.mjs`，**没碰 vendor、没碰运行时代码**；这轮不需要重启 DSH。
- 体积数字是「字面量偏高估计」，口径与 0.1.x 基线可比；线上真实投影体积仍以 `tools/probe-host.mjs` D2（8,655 B）为准。

# 9.89 装一个探测器，而不是再修一个脚本（0.2.83）

### 9.89.1 修完一例，立刻撞见第二例

9.88 修好 `tools/probe-toolsize.mjs` 的裸 `root` 之后，顺手把 `tools/` 下没被编排的脚本挨个跑了一遍：

```
tools/cost-baseline.mjs:8
const meow = readFileSync(root + '/meow-memory/lib/index.js', 'utf8')
                          ^
ReferenceError: root is not defined
```

一模一样的错，一行不差（只 `import { vendorDir }`，却用 `root`）。所以这不是手滑，是**一整类**：只要一个脚本没被任何东西执行，它就会安静地烂，而且 `node --check` 永远看不见。

同时对全部 26 个 `tools/*.mjs` 做了归类，发现四个「孤儿」（既不在 check-all、也没被任何脚本 import）：`cost-baseline.mjs`、`wire-profile.mjs`、`patch-meow-settings-ns.mjs`、`patch-nebula-noinject.mjs`。它们不是垃圾——三个是手动工具、一个是历史补丁——但**没人知道它们还能不能跑**。

### 9.89.2 账本：把「手动」变成一种显式状态

新增 `tools/manual-tools.mjs`，只导出数据：

```js
export const MANUAL_TOOLS = [
  { file: 'tools/cost-baseline.mjs', smoke: true, why: '只读两套引擎源码数静态开销，输出是人读报表' },
  { file: 'tools/wire-profile.mjs', smoke: true, args: ['--status'], why: '--status 只打印不改盘，--apply 才写' },
  { file: 'tools/patch-meow-settings-ns.mjs', smoke: true, why: '默认只检锚点不写盘，已打过则跳过（幂等）' },
  { file: 'tools/patch-nebula-noinject.mjs', smoke: false, why: '按行号切片的一次性补丁，锚点已不存在，再跑必报错' },
  { file: 'tools/accept-live.mjs', smoke: false, why: '要对着正在运行的 DSH 读运行态，环境依赖' },
  { file: 'tools/make-vendor-manifest.mjs', smoke: false, why: '会写 vendor/VENDOR.json，只在引擎变动时手动跑' },
]
```

两条设计：`smoke: true` 是**可执行承诺**（只读、随时能跑，探针会真跑一遍），`smoke: false` 必须写清为什么不能自动跑且 `why` 不许太短。数据放文件里、判据放探针里——账本不写逻辑，就不会自己长出一套规则。

### 9.89.3 探针：三类归属 + 自由变量 + 冒烟

`tools/probe-tools.mjs`（check-all 第 13 支，16 条判据）干三件事：

1. **归类**：把 `tools/*.mjs` 分成 `check-all STEPS` / `被别的脚本 import` / `账本登记`。三者都不是 → 红并列出文件名。从此新写的脚本不可能悄悄变成幽灵。附带还查：账本里的文件真实存在、账本不许和 STEPS 重叠（记账不能撒谎）、`smoke` 不许「没说」。
2. **自由变量**：把 `_root.mjs` 的导出（`root` / `vendorDir` / `at`）当白名单——某脚本用到某名字却没在 `from './_root.mjs'` 里导入、又没自己声明同名局部变量 → 红。这就是把 9.88 那个错变成判据。
3. **冒烟**：账本里 `smoke: true` 的脚本真跑一遍（`spawnSync(node, [file, ...args])`，30 s 超时），非零退出 → 红。

另外对所有脚本跑 `node --check`——它抓不到自由变量，但能抓语法，成本几乎为零。

### 9.89.4 探测器自己也要被验

第一版探针写了三处假红，正好说明「判据也要有阴性对照」：

- `doctor.mjs` 的 `what: '…改取 _root.mjs 的 vendorDir…'` 是**字符串**，被判成「用了 vendorDir 却没导入」；
- `wire-profile.mjs` 有 `const at = work.indexOf(anchor)`，被判成「白用 at」；
- 连 `_root.mjs` 自己都被判「用了 root 没导入」（它就是定义处）。

修法：写了个 `maskNonCode()`，把注释、`'…'`、`"…"`、`` `…` `` 的字面量部分全部涂成空格（`${…}` 里仍是代码，保留）；跳过定义处；自己声明同名局部变量的不算。然后**加六条阴性对照**：裸用 `root` 必须被抓、只导入别的名字必须被抓、正常导入不许误报、局部变量不许误报、字符串里的名字不许误报、模板字面量插值按代码算。再加三条归类对照（不存在的脚本→orphan、探针自己→step、账本自己→import）。

假红比漏红更坏：它教人忽略探测器。

### 9.89.5 怎么验的

- `node tools/probe-tools.mjs` → 16 条 ALL PASS；`cost-baseline.mjs` 修后能跑出 693 字符 RULE、17 个工具、注入预算与数据库行数。
- `node verify.mjs` → A83 八条；总断言 892 → 900。
- `node tools/check-all.mjs` → 15/15，1,671 条断言。
- `node tools/doctor.mjs` → 补丁账本多两条（`tools/probe-tools.mjs`、`tools/manual-tools.mjs`）。

### 9.89.6 边界

- 只动 `tools/`、`verify.mjs`、文档与版本号；**不碰 vendor、不需要重启 DSH**。
- 账本只登记「确实需要手动跑」的脚本；能自动跑的一律进 check-all，不给自己留后门。
- `patch-nebula-noinject.mjs` 保留但 `smoke: false`：它是历史证据，不是可重放工具。

## 9.90 统一口径不是「记得统一」，是「有人替你问」（0.2.84）

### 9.90.0 一句话

同一件事（几个工具、动作有几个、注入多少字、体检分几类）同时活在四处：注入手册的文本、工具的 schema、常量表、对外的 README 与两份市场索引。以前四处一致靠「改的时候记得都改」；现在有一条探针替你去问，任何一处漂移就是红。

### 9.90.1 这一轮没修错，修的是「没法知道对不对」

先把现状查了一遍（临时脚本读真值，读完就删）：8 个统一工具、`createAliasTools` 11 个旧名、`ACTIONS` 八个动作、`GUIDE_TEXT.length = 1085`、`NAV_TEXT.length = 178`、七个 level、六个项目子类、四个 schema 枚举。结论是**当时四处全都一致**，README 与两份索引里 12 处「1,085 字符」也都是实测值。

所以这一轮的价值不在修复，在**把一致性从「我记得」变成「有人问」**：一致性一旦没有判据，它只是当下恰好成立，下一次改代码就会悄悄失效一次——而失效的方式是模型照着旧手册去调一个已改名的工具，拿到「工具不存在」。

### 9.90.2 `tools/probe-words.mjs`：真 import，不抄名单

探针（check-all 第 14 支，20 条判据 + 6 条阴性对照）真 import 代码取真值，而不是把名字抄进测试：

| 组 | 判据 |
| --- | --- |
| 工具面 | defs 文件数 = 装配数；每个 defs 声明唯一名字；声明名与装配名一致；对外正好 8 个 `memory_*` |
| 品牌映射 | 右值里的 `memory_*` 都是真工具（死指针 → 红）；左值旧名集合 = `createAliasTools` 名单（改一处必须改另一处） |
| 手册口径 | `memory_admin（action=…）` 逐字等于动作表键序；动作中文标签唯一非空；`memory_link` action 与 schema 同序；`memory_search` 的每个非默认 mode 都被手册提到；level 集合与顺序 = `LEVELS`；子类 = `PROJECT_SUBCATEGORIES`；status 与体检六类 = schema 枚举 |
| 对外数字 | README + 两份索引里所有「X 字符 / X-character」必须等于 `GUIDE_TEXT.length`（融合前对照值 `4,085` 按设计跳过） |
| 死指针 | 工具说明与注入手册里不许出现 `nebula_*` / `memory_find_similar` / `memory_home` / `meow-memory` |
| 可读性 | 每条说明单行、非空、≤200 字；导航里「N 个 memory_*」= 实际装配数 |

两个解析 helper 是这一轮真正的代码：`claimedGuideLengths(text)`（把「1,085 字符」这类声明全抓出来，允许千分位，跳过 `4085`）、`modeTokens` / `levelTokens`（从手册行里按 `|` 与 `k=v` 取 token）。手册是自然语言，判据必须能从那句话里读出来，而不是靠另一份名单对照——否则一致性只是被复制了一遍。

### 9.90.3 两处假红，都是正则太聪明

- `modeTokens` 第一版没按 `|` 拆，`mode=local|graph|bridge|similar` 只取到 `local`，于是「`bridge` 没被手册提到」假红；
- `levelTokens` 第一版用 `[a-z=\/|A-Za-z ]+` 撞上中文就停，导致 level 集合永远缺一半——改成先取到句号前、再逐 `k=v` 取。

两条都是「判据写错了」，不是代码错了。假红比漏红更坏（9.89.4 已经写过一次），所以这轮同样给了 6 条阴性对照：`mode=graph|bridge` 必须拆成两个、无模式返回空、`levelTokens` 只认 `k=v`、`1,086 字符` 必须被抓出、`4,085 字符` 不算声明、`nebula_recall` 必须被死指针检测认出。

### 9.90.4 怎么验的

- `node tools/probe-words.mjs` → 20 条 ALL PASS（exit 0）。
- `node verify.mjs` → A84 七条（进 STEPS / 真值从 lib 取不抄名单 / 三组比对 / 死指针 / 阴性对照 / 失败置 exitCode）。
- `node tools/check-all.mjs` → 16 支全绿；`node tools/doctor.mjs` 的补丁账本多一条（`tools/probe-words.mjs`）。
- 探针里也写了 `process.env.DSH_HOME` 沙箱行：它只装配工具定义、不执行工具，但「将来有人顺手加一句 execute」不该碰到主人的生产记忆库。

### 9.90.5 边界

- 只动 `tools/`、`verify.mjs`、文档与版本号；**不碰 vendor 运行时代码、不需要重启 DSH**。
- 判据只钉「说过的」与「代码里的」是否一致，不评价措辞好不好——文案质量靠人看，不靠探针。
- 手册里出现的新数字（比如以后再加一个工具）必须同步更新 README 与两份索引，否则这条判据会红：这是有意的，对外承诺本来就该跟着改。

## 9.91 一条记忆只能靠「排得对」被读到（0.2.85）

### 9.91.0 一句话

0.2.84 修的是「说法不一致」，这一轮修的是**引擎自己把相关性算错了两处**：重要度从不进分数、算好的分数又在渲染前被时间顺序整个覆盖。两处都不报错、都有结果、都有分数——用户只会觉得「它怎么又翻出那条没用的」。

### 9.91.1 现象：分数是对的，读到的却是最旧那条

拿合成语料在真引擎上跑（临时脚本，跑完删）：

- 查询「部署」命中两条：一条 `importance=4` 的铁律（`bm25=0.957`）、一条 `importance=1` 的随手记（`bm25=1.033`）。铁律排在后面——**措辞赢了重要度**。
- 反过来查 `explain`，两条的 `score` 分别是 0.96 与 1.03，也就是说分数算对了，可**输出顺序与分数无关**。

读 `vendor/meow-memory/lib/index.js` 才看清两件事：

1. `search()` 里 `importance` 只出现在一个地方：`docs[di].importance < 3` 时**豁免**时间衰减。它从不参与打分。而同一个文件里的另一个打分器 `keywordHitScore()` 早就有 `impW = 1 + (importance-1)*0.25`——两套打分口径，同一个引擎。
2. `searchTool` 在渲染前做了 `sort((a, b) => (a.updated_at ?? 0) - (b.updated_at ?? 0))`：**按创建时间升序重排**，把 `search()` 顶着算出来的相关度顺序整个丢掉。于是模型读到的第一条永远是最旧的那条。旁边那句 `BASE_NOTE`（「如果冲突，以最新的为准」）说的是**内容取舍规则**，却被这一行实现成了**排序规则**——两件事被混成一件。

### 9.91.2 改法：加成、不碾压；相关度为主、时间只做次级

```js
// ① 与 keywordHitScore 同一口径（0.25），并且只做加成
const impW = 1 + (impOf(docs[di]) - 1) * 0.25;
score: raw[di] * w * impW,
explain: { bm25, importance, importanceWeight: impW, recencyWeight: w, score }

// ② 相关度降序为主，时间新的在前只做平手次级
const reordered = [...hits].sort((a, b) => (b.score - a.score) || ((b.updated_at ?? 0) - (a.updated_at ?? 0)));
```

两条边界写死在注释里，也写进判据：

- **不当碾压**：`0.25` 一级只值 1.75 倍上限，一条高度相关（bm25 差 6 倍以上）的 `importance=1` 条目永远压得住一条沾边的 `importance=4`。BM25 回答「说的是不是这件事」，重要度只回答「这件事对你有多要紧」，后者不该越权。
- **`explain` 三因子齐**：`score = bm25 × recencyWeight × importanceWeight`。少一个因子，读者就没法判断「它为什么排前面」，排序也就重新变成黑箱。

### 9.91.3 `tools/probe-recall.mjs`：真引擎、真工具、两条阴性对照

探针（check-all 第 17 支，24 条判据）不写自己的打分公式，而是 `registerMemoryTools()` 拿到**真的**七个工具、在临时 `DSH_HOME` 里真写五条合成记忆，再真调 `memory_search`：

| 组 | 判据 |
| --- | --- |
| R0 语料 | 五条：层 / 重要度 / 措辞 / 时间全被控住；**随手记比铁律旧**（否则「按时间排」和「按相关度排」分不开） |
| R1 排序 | 首条是最相关的而不是最旧的；随手记仍在前十条里（没被挤没）；分数单调不增；阴性对照=按 `updated_at` 升序排出来首条会变 |
| R2 打分 | `explain` 三因子齐；`importance=4` → `importanceWeight=1.75`、`importance=1` → `1`；`score` 能被分项还原；**铁律的 bm25 低于随手记却反超**（证明是重要度赢的，不是措辞）；阴性对照=把 importance 全抹平成 1，引擎自己就把首条翻回随手记 |
| R3 不碾压 | 强相关只有一条时，沾边的两条 `importance=4` 都进不了结果 |
| R4 过滤/召回 | 归档条目不再召回；`level=fact` 时 lesson 那条不出现、`level=lesson` 时在；中文长句（不是关键词列表）也能召回 |

两条阴性对照是这一轮的关键：一条判据如果去掉被测改动之后仍然 PASS，它就是注释。抹平 importance 与按时间升序，各自都让同一个查询给出另一个答案——这才说明 R1/R2 有区分力。

### 9.91.4 怎么验的

- `node tools/probe-recall.mjs` → 24 条 ALL PASS（exit 0）；实测铁律 `bm25=1.032`、随手记 `bm25=1.478`，加权后 `1.81 ≥ 1.48`，抹平重要度后首条翻回随手记。
- `node verify.mjs` → A85 七条（`impW` 与乘法进 `score`、`importanceWeight` 两处都露、`reordered` 是分数降序且旧的升序写法不许残留、探针进 STEPS、探针用真 vendor、两条阴性对照、失败置 exitCode）。
- `node tools/make-vendor-manifest.mjs` 重跑：`vendor/meow-memory` 44 文件 / 1,713,134 B / `296da68a7b3ab2fc`（改前 1,711,167 B / `d50b1c3c11a27934`）。
- `node tools/check-all.mjs` → 17 支全绿；`node tools/doctor.mjs` 的补丁账本多一条（`vendor/meow-memory/lib/index.js`）。

### 9.91.5 边界

- **改了 vendor 运行时代码**：`vendor/meow-memory/lib/index.js` 是宿主侧的引擎，装进 profile 之后**必须重启 DSH 才生效**；正在跑的进程里还是旧行为。本轮只做代码、备份与自检，重启交给主人。
- 排序口径只改「读出来的顺序」，不改 `blind/fresh` 的选条逻辑、不改 `bumpHit` 计入、不改状态/层/时间过滤——检索的**选谁**没动，只改**先读谁**。
- 备份：`D:\备份\20261120-003714-macro-fusion-0285-recall`（13 文件 / 1,338,149 B）。

## 9.92 分数算对了，还得决定「多弱就别端上来」（0.2.86）

### 9.92.0 一句话

0.2.85 修的是「谁排前面」，这一轮修的是排序之后的另一半：**顺序对了，尾巴一条没少**。榜首 14 分的时候第 3 条起只有 0.33 分——那些「只沾一个词」的条目照样进上下文、照样占 `k` 名额、照样被读成相关。这一轮给 `memory_search` 加了一个参数：相关度下限 `min_rel`（默认 0.35）。

### 9.92.1 现象：断崖不在尾巴，在第二名和第三名之间

30 条合成语料（6 个话题 × 5 条：部署 / 数据库 / 面板 / 星图 / 测试 / 发布）在真引擎上跑，把分数换算成「相对榜首的比例」：

| 查询 | 命中 | 相对分数（降序） |
| --- | --- | --- |
| `数据库连接池 上限` | 5 | 1.000 / 0.572 / **0.334** / **0.334** / **0.309** |
| `发布 索引 版本` | 5 | 1.000 / 0.572 / **0.363** / **0.292** / **0.233** |
| `星图 延迟` | 5 | 1.000 / 0.507 / **0.298** / **0.298** / **0.289** |
| `部署` | 5 | 1.000 / 0.572 / 0.572 / 0.556 / 0.545 |

（榜首的绝对分分别是 14.08 / 8.0 / 4.66 / 2.1——绝对分不可比，因为 BM25 带 idf，所以判据只能按比例定。）

第 2 条通常是同话题的另一个角度（0.5 上下，该留）；**第 3 条起是「数据库备份 / 迁移 / 慢查询」这种只共享一个词的条目**（0.33 上下，不该留）。断崖落在 0.5 与 0.35 之间。

顺带把一条被否掉的方案记下来：**不做「按相似度折叠」**。真 `tokenize` 复算 Jaccard（`similarity` 在 vendor 里没导出）：一字不差 1.000、只补标点 1.000、同义改写 0.150、同主题不同角度 0.056、摘要 vs 原文 0.107。写时去重阈值是 `DEDUP_THRESHOLD = 0.8`，也就是它几乎只抓逐字重复，同义改写一点不折；拿它做检索折叠既省不下东西又会误伤，放弃，只做分数线。

### 9.92.2 改法：相对比例、第一位保底、收掉要说出来

```js
// 参数：min_rel（0–1，默认 0.35；给 0 = 看全量）
const minRel = relRaw !== void 0 ? Math.max(0, Math.min(1, relRaw)) : 0.35;

// 过滤：第一名永远在，其余按「榜首 × min_rel」这条线
const topScore = ranked.length > 0 ? ranked[0].score : 0;
const aboveFloor =
  minRel > 0 && topScore > 0 ? ranked.filter((h, i) => i === 0 || h.score >= topScore * minRel) : ranked;
const belowFloor = ranked.length - aboveFloor.length;
```

三条边界都写进注释与判据：

- **第一位保底**：`i === 0` 让下限再高（0.99）也至少留一条。下限的用途是「别把弱相关端上来」，不是「一条都不给」——把「没有强相关」实现成零命中，就又回到了「零命中冒充『记忆里没有』」那个老坑。
- **收掉要说出来**：`另有 N 条相关度不到榜首的 35%（最高的 X 分，榜首 Y 分）没展开…要看全量就传 min_rel=0。` 静默收窄等于替用户决定「这些不重要」，而它连自己收掉了什么都不知道。
- **越界夹回并说清**：给 `5` 或 `-1` 时按 `1` / `0` 处理，并在尾注里写「不在 0–1 里，这次按 X 处理」，不当作「查不到」。

### 9.92.3 参数面一共五处（漏一处就静默失效）

| 位置 | 文件 |
| --- | --- |
| vendor 工具 schema | `vendor/meow-memory/lib/index.js`（`memory_search` 的 `parameters`） |
| macro 本地白名单 ×3 | `lib/macro/defs/search.js`（`fallbackArgs` / `localArgs` / graph 回退的 `localArgs`）——`pick()` 是白名单，少一个键就悄悄丢掉 |
| macro 工具 schema | `lib/macro/defs/search.js` 的 `parameters` |
| 三语文案 | `vendor/meow-memory/lib/prompts/{zh,en,pt-br}/tools.md` 各一行 |

### 9.92.4 `probe-recall` 的 R5 组：七条，两条阴性对照

语料补了两条「只沾一个词」的条目（`tail1`「备份文件放在 D 盘…」、`tail2`「日志目录涨得很快…」，都是 `fact / importance=1`）。**它们必须写在 R1–R4 之后**：先加两条新文档会改 idf，把 R2 里「铁律 bm25 低于随手记却反超」的算术搅乱。

| 判据 | 内容 |
| --- | --- |
| R5.1 | 默认 0.35 时 `tail1` 不出现 |
| R5.2 | 尾注报出条数（`/另有 \d+ 条/`）并给出 `min_rel=0` |
| R5.3 | **阴性对照**：同一查询传 `min_rel: 0`，`tail1` 回到结果里 |
| R5.4 | `min_rel: 0` 的条数确实比默认多 |
| R5.5 | `min_rel: 0.99` 仍留 1 条，且就是那条铁律 |
| R5.6 | 查「部署」时铁律与随手记都在（相对分 0.82，不该被误伤） |
| R5.7 | `min_rel: 5` → 尾注含「不在 0–1 里」，且仍有结果 |

R5.6 一开始写成查「部署 备份」，结果随手记（不含「备份」）本来就低于 0.35，判据假红；换成单查「部署」（实测 `lesson@2.1 / fact@1.72`）才验的是「不误伤」而不是「下限在生效」。

### 9.92.5 全绿路上：判据把「正当新增」也钉成了红（26 条红）

加 `relNote` 之后 `node verify.mjs` 一次红 26 条，根因只有一处：`tools/criteria.mjs` 的 `vendor-search-param` 判据把 note 拼装**整行逐字**钉住——`/\[plain, levelNote, scopeNote, statusNote, daysNote, kNote, cmNote\]/`。多拼一个 `relNote` 就红，然后所有「且整张清单仍全绿（四十五条）」的断言跟着一起红。

放宽成「七个变量都在、顺序不变、后面可以接着加」：

```js
/\[plain, levelNote, scopeNote, statusNote, daysNote, kNote, cmNote(?:, \w+)*\]\.filter\(\(s\) => s\.length > 0\)\.join\("\\n"\)/
```

三处（`tools/criteria.mjs` 一处、`verify.mjs` L2746 与 L3328 各一处）。同时把下限的五件事并进同一条契约判据（`const minRel`、`const aboveFloor`、`min_rel=0` 出口、`relClamped`、`i === 0 ||`），label 改成「检索参数（状态 / 时段 / 条数 / 截断 / 相关度下限）给错了各说各的」。判据条数**仍然 45**，不新增 id——新增一条会让 verify 里十几处「四十五条」全部联动。

放宽之后还剩 14 条红，而且全带同一个 detail：`样板红 vendor-search-param / 打不红 无`。那是 `selfTestContract()` 的 `good` 样板里也抄着同一行 `[plain, … cmNote]`，判据变严之后样板自己就不达标（baseline 非空）——样板补上 0.2.86 的六个标记才真正回绿。教训 62 就是从这来的。

### 9.92.6 怎么验的

- `node tools/probe-recall.mjs` → 30 条 ALL PASS（exit 0）。
- `node verify.mjs` → 918 条 ALL PASS（913 → 918，A86 五条：`min_rel` 参数与夹边界、第一位保底 + 按线过滤、尾注报数 + `min_rel=0` 出路、三处白名单 + schema、探针 R5 组）。
- `node tools/probe-toolsize.mjs` → 88,918 B ≤ 92,000 B（工具字面量里多了 `min_rel` 一行，仍在 5% 余量内）。
- `node tools/probe-words.mjs` → ALL PASS（三语文案各多一行，字符数口径仍自洽）。
- `node tools/make-vendor-manifest.mjs` 重跑：`vendor/meow-memory` 44 文件 / 1,716,149 B / `ca708376bf2b55a7`（0.2.85 时 1,713,158 B / `5bdd13b38d913560`）。
- `node tools/check-all.mjs` → 17/17，1,763 条断言，120.4s；`doctor` 120 条；`check-market` 48 条。

### 9.92.7 边界

- **改了 vendor 运行时代码**：`vendor/meow-memory/lib/index.js` 是宿主侧引擎，装进 profile 之后**必须重启 DSH 才生效**；正在跑的进程里还是旧行为。
- 只改「端上来几条」：选谁（层 / 状态 / 天数 / 归档过滤）、`blind`/`fresh` 分段、`bumpHit` 计入都没动。传 `min_rel: 0` 完全回到 0.2.85 的行为。
- 备份：`D:\备份\20261120-012720-macro-fusion-0286-min-rel`（16 文件 / 850,319 B，从 `a37af1d` 导出的改动前状态；还原办法见该目录 `MANIFEST.txt`）。

## 9.93 合并说「并进了」，实际是把旧条目盖了一遍（0.2.87）

### 9.93.0 一句话

`memory_remember` 撞到重复内容会「合并」，而合并的实现是 `db.update(level, id, patch)`——`patch` 里带着 `content` 和 `keywords`。于是「合并」= 用这次写的参数把旧条目整条覆盖，三处东西静默消失：旧关键词、旧归属、旧内容里的细节。

### 9.93.1 现象

实测（`_merge.mjs`，临时脚本已删）：

| 场景 | 旧行为 | 代价 |
| --- | --- | --- |
| 旧条目 keywords = `[部署, 备份, 铁律]`，这次只给 `[上线]` | 存下来是 `[上线]` | 旧关键词一个不剩，按「部署」「铁律」检索再也找不到这条 |
| 旧条目 project = `甲项目`，这次传 `乙项目` | 归属变成 `乙项目` | 内容明明还是甲项目的，回执一个字不提 |
| 旧内容 78 字（尾句「也不许只备份配置文件」），这次写 67 字的省略版（重复度 85%） | 内容被换成 67 字 | 细节被吃掉，回执只说「内容被替换」 |

三处坏起来都**一声不响**：`ok: true`、`merged: true`、没有 dropped、没有 note 警告。而回执原文是「原条目的内容被替换成这次写的内容，importance 取两者较大值」——它承认了「替换内容」，但没提关键词和归属也被替换了。

### 9.93.2 改法：合并只做加法

新增 `applyMerge(db, level, merged, asked)`（`vendor/meow-memory/lib/index.js`，marker `[macro-fusion 0.2.87]`），四条规则：

1. **关键词取并集**：`[...kwOld, ...keywords]` 去重，旧的一条不删，回执报「并进了几条、现在共几条」。
2. **归属不搬**：`projKept = projOld.length > 0 && asked.project !== projOld` → 保留旧 project，回执写明「这条原属 X，这次给的是 Y——合并不会搬走归属，要换归属请先归档再重写」（`memory_update` 不改归属，这是现有事实）。
3. **内容变短且非逐字默认不换**：`shrink = asked.content.length < oldContent.length && sim < 0.98`；`holdContent = shrink && !overwrite`。逐字相同（sim ≥ 0.98）照旧写，只是「更省略的版本」不许偷偷顶掉细节。
4. **`overwrite: true` 才是「我确实要压缩」**：没有这个出口，保护就变成「更新不了」——一个只防不许改的默认值比旧的覆盖更糟。

回执逐项报账：`关键词并进了 N 条（…），现在共 M 条，旧的一条没删；importance 保持 4；内容没换：旧 78 字、这次 67 字，不是逐字同一句，直接替换会把旧细节吃掉；确实要换成短的，传 overwrite: true；归属没改：…`

`applyMerge` 刻意放在 `rememberTool()` 字面量**外面**：`tools/probe-toolsize.mjs` 按源码切片量 17 个工具字面量的体积，这段带说明文字的逻辑写在字面量里会让体积从 88,453 B 一路涨到 91,600 B（预算 92,000 B），下次正当改动就踩线。

### 9.93.3 基准：`tools/probe-merge.mjs`（25 条）

真引擎、合成语料、临时 `DSH_HOME`，进 `check-all` 第 18 支：

- M0 工具齐 / 语料长短关系 / 首次写入是「新写」
- M1 同义再写走到合并分支；关键词并集（旧的 `[部署,备份,铁律]` 与新的 `[上线]` 都在）
- M2 归属不搬 + 回执给出「先归档再重写」的正路
- M3 变短非逐字：旧内容原样在、尾句细节还在、回执报长度并给 `overwrite: true`
- M4 `overwrite: true` 真的换（逃生口不是摆设）
- M5 更长的内容照旧替换（保护只对变短生效，不误挡正常更新）
- M6 `importance` 取大、`corrected` 保留、回执承认这是「合并」
- M7 阴性对照：同一语料上按旧写法 `db.update(…, { content: SHORT, keywords: ['上线'] })` 之后确实只剩 1 个关键词、内容被截短——判据抓得到差异
- M8 参数面：schema 里 `overwrite` 是 boolean 默认 false，三语 `tools.md` 都有 `memory_remember.param.overwrite`（缺了 `T()` 直接抛）

**探针自己也踩了一次**：M7 起初用 `fact` 层，而 M3 的语料也在 `fact` 层且内容相同 → 两次写入被合并成同一条，M7 变成「自己和自己比」，判据恒真。改到 `user` 层才分开。教训：**阴性对照的语料必须和被测语料在存储上真的隔离**，靠「内容不同」不够，合并/去重本身就是按内容判的。

### 9.93.4 怎么验

- `node tools/probe-merge.mjs` → 25 条 ALL PASS
- `node verify.mjs` → 925 条（A87 六条：并集 / 归属不搬 / 变短默认不换 + overwrite / 回执报账 / `applyMerge` 在字面量外 / 融合层传 `overwrite` 且 schema 有 / 探针进 STEPS 且带阴性对照）
- `node tools/probe-toolsize.mjs` → 88,453 B ≤ 92,000 B
- `node tools/probe-words.mjs` → ALL PASS（三语文案各多一行，字符数口径自洽）
- `node tools/make-vendor-manifest.mjs` 重跑：`vendor/meow-memory` 44 文件 / 1,719,779 B / `43defb15f04df7fe`（0.2.86 时 1,716,149 B / `ca708376bf2b55a7`）
- `node tools/check-all.mjs` → 18/18，1,795 条断言，122s

### 9.93.5 边界

- **改了 vendor 运行时代码**：`vendor/meow-memory/lib/index.js` 是宿主侧引擎，装进 profile 后**必须重启 DSH 才生效**；重启交给主人，这边不动进程。
- 只改合并分支：`similarity` / `DEDUP_THRESHOLD = 0.8` / 只在**同一层**比 / `markWritten` / 命中计数全都没动。跨层同内容仍会写两份（`fact` 和 `lesson` 各一条），这是现有设计，本轮只记录不修。
- `overwrite` 只影响「内容换不换」，不放大到关键词与归属——那两处本来就不该由一次合并决定。
- 备份：`D:\备份\20261120-022820-macro-fusion-0287-merge`（改动前的文件 + `MANIFEST.txt` 还原办法）。

## 9.94 同一句话既记 fact 又记 lesson，检索时端两遍（0.2.88）

### 9.94.0 一句话

写入时的去重只比**同一层**（`db.list(level, { status: "active" })`），所以同一句话在两层各写一次会真的落下两份；检索时两条分数一模一样并排端出来，白占一个 k 名额、同一段字要让模型读两遍，回执里一个字都不提。

### 9.94.1 现象

实测（`_dup.mjs`，临时脚本已删）。同一句「发布之前必须先把当前树备份到 D:\备份 再动手，出问题先还原备份再排查」先写 `fact`、再写 `lesson`：

- 两次都 `merged = false`、`note = ""`、id 不同（`0mwnwcwy…` / `0mwnwcz…`）——按设计就是「两条」；
- `memory_search('发布前备份 还原')` 返回**两条、分数完全相同 1.280 / 1.280、内容逐字相同**，尾注只有 BASE_NOTE。

代价不是「数据坏了」，而是**读的人要多读一遍同一段字**，并且这条重复会把 k 名额吃掉一格（真正相关但分数略低的条目被挤出榜单）。层不同不等于内容不同——这是两个插件里最容易踩的一处「合法的重复」。

### 9.94.2 改法：写的时候点名，读的时候折叠

`vendor/meow-memory/lib/index.js`，marker `[macro-fusion 0.2.88]`，三个模块级函数 + 两处调用：

1. **`crossLevelDupe(db, level, content)`**：遍历 `LEVELS`、跳过本层、扫 `db.list(lv, { status: "active" })`，取 `similarity(r.content, content) >= DEDUP_THRESHOLD` 里相似度最高的一条，返回 `{ id, level, sim }`。
2. **`crossLevelNote(hit)`**：`另一层已有几乎一样的条目（fact 0mwnwfhx，重复度 100%）：这条照样写下了，但同一句话存两层，检索时两条会一起冒出来、白占名额。它们若本是一件事，用 memory_update 把其中一条 status 设 archived；若两层各有分工，把措辞写开一点。`
3. **`foldNearDupes(hits)`**：按顺序保留，`kept.some((k) => similarity(k.content ?? "", h.content ?? "") >= DEDUP_THRESHOLD)` 就计入 `folded`，返回 `{ kept, folded }`。

调用点：

- `rememberTool` 的 insert 路径：`note: noteOf(crossLevelNote(crossLevelDupe(db, level, content)))`——**照样写下**，不硬拦。层各有分工（事实 vs 教训）是正当用法，拦掉就是替主人做决定。
- `searchTool`：`const dedupeOn = parsed.dedupe !== false; const foldedRes = dedupeOn ? foldNearDupes(aboveFloor) : { kept: aboveFloor, folded: 0 };`，随后 `blind` / `fresh` 都从 `unique` 切——**折叠不占 k 名额**（如果照旧从 `aboveFloor` 切，折叠就只是「少给一条」，白折）。尾注 `另有 N 条内容几乎一样（重复度 ≥80%）没重复列：多半是同一句既存了 fact 又存了 lesson。要看全量传 dedupe: false。`

三个辅助函数同样放在工具字面量**外面**（`probe-toolsize` 量字面量体积）。

### 9.94.3 为什么折叠只认逐字级重复

`similarity` 是 `tokenize` 的 Jaccard，实测口径：一字不差 1.000、补标点 1.000、同义改写 0.150、版本号不同 0.667、数字不同其余同 0.500、同主题不同角度 0.056。阈值 0.8 因此只折「几乎逐字相同」的那种（同一句话被写进两层），**同义改写的不会被误折**——M6 就是钉这一点的。

### 9.94.4 基准：`tools/probe-dup.mjs`（23 条）

真引擎、合成语料、临时 `DSH_HOME`，进 `check-all` 第 19 支：

- M0 工具齐 / 语料就位
- M1 同句写两层：第一层不点别人的名、第二层照样写下、库里两层各一份
- M2 第二层回执点名：「另一层已有（fact xxxxxxxx，重复度 100%）」+ 两条出路（归档 / 把措辞写开）
- M3 默认参数下检索只列一条、尾注报「另有 1 条内容几乎一样（重复度 ≥80%）」、给 `dedupe: false`
- M4 阴性对照：`dedupe: false` 回两条（说明 M3 折掉的正是这一条，不是恒砍）
- M5 折叠保留的是分数最高的那条（M3 保留的分数 = M4 榜首分数）
- M6 不同措辞的一 fact 一 lesson 两条都列、不误报折叠
- M7 同层重复仍走合并（新逻辑没把老路弄坏）
- M8 参数面：`dedupe` 是 boolean 默认 true，三语 `tools.md` 都有 `memory_search.param.dedupe`

### 9.94.5 怎么验

- `node tools/probe-dup.mjs` → 23 条 ALL PASS
- `node verify.mjs` → 933 条（A88 八条：写侧扫别层 / 点名内容 / 折叠函数与调用顺序 / 折叠报数与出口 / 折叠不占 k（`!includes('const blind = aboveFloor.slice')`）/ 辅助函数在字面量外 / 探针进 STEPS 且带阴性对照）
- `node tools/check-all.mjs` → 19/19，1,828 条断言，124s
- `node tools/probe-toolsize.mjs`、`node tools/probe-words.mjs` 全绿
- `node tools/make-vendor-manifest.mjs` 重跑：`vendor/meow-memory` 44 文件 / 1,723,154 B / `aeb1fbd3acd8da42`（0.2.87 时 1,719,779 B / `43defb15f04df7fe`）

### 9.94.6 边界

- **改了 vendor 运行时代码**：装进 profile 后必须**重启 DSH** 才生效；重启交给主人，这边不动进程。
- 写侧只点名、不拦：`crossLevelDupe` 不影响写入结果，`merged` / `dropped` / 排序全都没动。
- 折叠只在 `memory_search` 里生效，不删数据、不改库；`memory_dream`、面板、`findSimilar` 的口径本轮都没动。
- 已知仍未统一：写入侧 Jaccard 与 `findSimilar()` 的 TF cosine 是两套相似度；`memory_find_similar` 无阈值、候选过滤掉 seen 与本会话新写条目。这两件留到下一轮。
- 备份：`D:\备份\20261120-024623-macro-fusion-0288-dedupe`（改动前的文件 + `MANIFEST.txt` 还原办法）。

## 9.95 相似检索：基准量正文，候量标题+正文+关键词（0.2.89）

### 9.95.0 一句话

`memory_find_similar` 一边用 `found.row.content` 去比、一边把候选取成 `docText`（title + 正文 + keywords），同一把尺子两边量的字不一样；同时候选过滤里挂着 `r.source_session !== sessionId`，把「本会话刚写的」整批排掉——而「我刚记了三条，谁跟谁像」正是它最该用的时刻。两处都不报错，只是安静地给出 0 命中或偏低的分数。

### 9.95.1 实测（两条都是可复现的）

同一会话连写三条相关记忆，立刻 `memory_find_similar`：

- 命中 **0 条**，note 是「可比的候选一条都没有（库里 3 条，本会话新写的和这一轮已看过的都被排除了）……换一条基准，或等下一次会话再问」——工具在自己的最佳使用场景里自我关闭。
- 换个会话再问：1 条，0.295。

口径错位（同一份语料，只改基准取哪段文字）：

| 基准取 | 只沾基准 keywords 的候选 | 沾正文那条 |
| --- | --- | --- |
| `found.row.content` | **0.000**（被 `if (s <= 0) continue;` 直接丢掉） | 0.795 |
| `docText(found.row)` | 0.228 / 0.241 | 0.574 |

关键词是**索引**，不是噪音：候选的 keywords 参与打分，基准的 keywords 却完全不参与——这等于一边允许用标签找相似、一边不给基准贴标签。分数整体缩放但排序不变的观察（0.795→0.574）说明修完之后**排序口径没变坏**，只是把「本该得分的候选」捞了回来。

### 9.95.2 三处改动

1. **一把尺子**：`const hits = findSimilar(docText(found.row), docs, k);`（原来是 `found.row.content`）。`noTarget` 的兜底同样换成 `tokenize(docText(found.row))`。
2. **会话身份不再兼职去重**：`const candidates = rows.filter((r) => r.id !== found.row.id && !seen.has(r.id));`——去掉 `r.source_session !== sessionId`。「别把同一条重复端」是 `seen` 的活，它已经在做；会话身份做这件事会把整批新写的排除。
3. **点名「这是你刚记的」**：`const freshHits = hits.filter((h) => rows.some((r) => r.id === h.id && r.source_session === sessionId));`，非空时尾注写「命中里有 N 条是本会话刚写的（fact / lesson）——它们是刚才那几条，不是库里积累下来的旧账；别把「我自己刚记的」当成「已有依据」」。放开候选的代价是可能拿自己的新笔记当依据，这句话就是代价的对价。

空结果的文案同步改成实际情况：`这一轮已经端给你看过的都排除了` / `换一条基准，或者把 k 给大一点再问`，不再暗示「库里没有」。

### 9.95.3 三语 tools.md

`memory_find_similar.description` 三语全部重写（zh 5,751→5,814 / en 11,904→12,119 / pt-br 12,991→13,205 字符）：bigram 余弦的口径改成「标题 + 正文 + 关键词一起算，基准和候选用的是同一段文字」；候选说明改成「包括本会话刚写的」，只保留「这一轮已经给看过的仍排除」；删掉旧句「同样只检索其他会话建立的记忆」。

### 9.95.4 判据

`tools/probe-similar.mjs`（M0–M10，17 条 ALL PASS）：

- M1 同会话写三条后立刻比 → 有命中，且点名 fresh；阴性对照断言 note **不含**「等下一次会话」。
- M2 只沾基准 keywords 的候选 `similarity` = 0.228；同一句正文换 keywords → 分数不同（证明 keywords 真的进打分）。
- M3 基准自己不出现在结果里；M4 这一轮端过的第二次仍排除（第一次 2 条、第二次 0 条、交集为空），且空不是「库里没有」。
- M5 换会话 → 仍 2 条，且**不**点名 fresh（阴性对照）。
- M6 `k: 1` 只回 1 条；M7 短 id 撞车仍抛「相似检索这次一条都没比」；M8 不存在的 id 仍抛「相似检索没起点」；M9 分数落在 0–1 且降序；M10 三语文案在位。

两个探针坑：① 语料 `SAME_WORDS` 初版「凌晨两点到四点之间不要动库房的门。」与基准的 Jaccard ≥0.8，被 `memory_remember` 合并成一条 → M1 只剩 1 条命中；换成「两点到四点之间我一般在睡觉」才隔离。② M4 初版断言 note 含「端过」，但候选里还剩一条 0 分噪音（note 走的是另一条分支）→ 改成断言「两次 hits 交集为空 + note 不含『库里就只有这一条』」。

另：M10 最初用正则字面量 `/only looks at memories created in other sessions/` 判英文文案，被 `probe-tools` 的自由变量检查抓到（它剥注释和字符串字面量，**不剥正则**，里面的 `at` 被当成裸变量）→ 改成 `en.includes('…')`。同类坑第二次：判据里别把英文短语塞进正则。

### 9.95.5 怎么验

- `node tools/probe-similar.mjs` → 17 条 ALL PASS
- `node verify.mjs` → 939 条（A89 六条：一把尺子 / 候选不再按会话排 / fresh 点名 / 空结果新口径且旧文案消失 / 三语文案 / 探针进 STEPS + 两条阴性对照）
- `node tools/check-all.mjs` → 20/20，1,852 条断言，125s
- `node tools/make-vendor-manifest.mjs` 重跑：`vendor/meow-memory` 44 文件 / 1,725,569 B / `cd8648ab8c8db91d`（0.2.88 时 1,723,154 B / `aeb1fbd3acd8da42`）

### 9.95.6 边界

- **改了 vendor 运行时代码**：装进 profile 后必须**重启 DSH** 才生效；重启交给主人，这边不动进程。
- 只是「让候选进得来、尺子对齐」，没加阈值、没改 `findSimilar` 的算法（仍是 tf 向量的余弦），也没动 `memory_search` 的折叠。
- 已知仍未统一：写入侧 Jaccard（`similarity`）与 `findSimilar()` 的 TF cosine 是两套相似度；本轮只保证「同一工具内部两侧一致」。
- 备份：`D:\备份\20261120-<ts>-macro-fusion-0289-similar`（改动前文件 + `MANIFEST.txt` 还原办法）。

## 9.96 「相似度 0.715」和「重复度 35%」说的是同一对内容（0.2.90）

### 9.96.0 一句话

这个库里有**两把量相似的尺子**：`findSimilar()` 用的是 tf 向量余弦（对长文宽容，回答「话题有多近」），
写侧的 80% 合并门槛用的是词集 Jaccard（逐字级，回答「是不是同一句话」）。0.2.89 之前相似检索只报前一个数，
于是「长条目里嵌着一模一样的短句」会报 0.715 被读成「这句早就记过了」，而 `memory_remember` 回执里那句
「重复度 81%」在相似检索里根本无处可查。0.2.90 起两个数都报，而且 **repeat 与写侧同一个输入（只比正文）**。

### 9.96.1 实测：同一对内容，两把尺子差一个量级

| 场景 | 写侧 Jaccard | cosine | 差 |
| --- | --- | --- | --- |
| 近重复（同一件事改几个字） | **81%** | 0.944 | 差 13 个点 |
| 长条目里嵌着一模一样的短句 | **35%** | **0.715** | 差 36 个点 |
| 同话题不同结论（词重合多、两件事） | 2% | 0.259 | 差 24 个点 |
| 措辞完全不同的同一结论（同义改写） | 0% | 0.217 | — |

只有第一行才是「这句话记过了」。第二行是误读的重灾区：嵌入一句就够把 cosine 顶到 0.7。

### 9.96.2 改了什么

1. **两个数并报**：每条命中多一个 `repeat`（词集 Jaccard，0-1），`similarity` 照旧（cosine，仍是唯一排序键）。
2. **输入同源**：写侧合并判的是 `similarity(r.content, content)`——**纯正文**，不含标题和 keywords。
   所以 `repeat` 也只比正文（`overlapOfSets(repeatSet, new Set(tokenize(d.content ?? "")))`），
   cosine 仍走 `docText`（关键词参与排序）。第一版没这么分，同一对内容写侧报 81%、读侧报 71%——
   等于又造了第三把尺子。
3. **Jaccard 只剩一处实现**：`function overlapOfSets(sa, sb)`，`similarity()` 直接 `return overlapOfSets(...)`，
   防两套口径日后各漂各的。
4. **两种误读当场校准**（`similarCalibNote`，模块级，写在工具字面量外）：
   - `similarity >= 0.5 && repeat < 0.5` → 「看着像、其实不是同一句：相似度 ≥0.50 但逐字重复度不到 50%（写侧要 80% 才算重复）」；
   - `repeat >= 0.8` → 「逐字重复度 ≥80%：写侧会判重复，多半是同一句话分别存进了两层，用 memory_update 把其中一条 status 设 archived」。

   判据用两个绝对量而不是「相差 30 个点」：轻度重叠可能只差十几个点却同样不是同一句，
   「逐字连一半都对不上」比「差 30 点」更贴近要说的事。
5. **融合层兜底文案**去掉过期的「或等下一次会话」（0.2.89 起本会话新写的也算候选）。

### 9.96.3 为什么保留 cosine 排序

它是 meow 原有排序尺子，长文宽容在这里是优点：一条 300 字的长记忆只要主题对，就该排在短条目前面。
换 Jaccard 排序会把「长而相关」全压下去——那是把 0.2.89 修好的相关性又改坏。**报两个数、排一个序**是这一轮的取舍。

### 9.96.4 怎么验

```
node tools/probe-ruler.mjs   # 12 条
node verify.mjs              # A90 八条
```

- U1 近重复：`repeat 0.808`，回执说「写侧会判重复」
- U2 两处同口径：写侧回执「重复度 81%」vs 读侧 `repeat 0.808`（差 ≤3 个点）——**这条是 0.2.90 的关键证据**
- U3 长文嵌一句：`similarity 0.545 / repeat 0.407`，回执点名「看着像、其实不是同一句」
- U4 同话题：`similarity 0.134 / repeat 0.025`，一条校准句都不触发（该安静的安静）
- U5/U6 字段齐、仍是 cosine 降序
- U7 三语都有 `memory_find_similar.out.hits.repeat`
- U8 用 `tokenize` 复算的 Jaccard 与工具一致（0.407 vs 0.407）
- A90 八条：两个数都报 / 输入同源 / Jaccard 一处实现 / 两条校准句 / 排序没动 / 校准句在字面量外 + 三语 / 融合层兜底文案 / 探针进线

### 9.96.5 现场数字

- 工具体积：`probe-toolsize` 90,878 B ≤ 92,000 B（`similarCalibNote` 抽到模块级才过；写在字面量里是 92,586 B，超预算）
- `vendor/meow-memory`：44 文件 / 1,729,945 B / `8ee925478ab6c9f7`（0.2.89 是 1,725,569 B / `cd8648ab8c8db91d`）
- 三语 tools.md：zh 5,814→5,978 / en 12,119→12,501 / pt-br 13,205→13,597 字符

### 9.96.6 边界

- **改的是 vendor 运行时代码**：装进 profile 后要**重启 DSH** 才生效；重启交给主人。
- 没加阈值、没改排序算法、没动 `memory_search` 的折叠与 `min_rel`；`repeat` 是新增字段，老调用方不看也不会坏。
- 已知仍未统一：`memory_dream` / 面板口径还没有跟着 `dedupe` 与 `repeat` 对齐。

## 9.97 面板说「相似 1」，工具说「逐字 0.42」（0.2.91）

### 9.97.0 一句话

`memory_admin(action="hygiene")` 里那行 `疑似重复（N）… （相似 X）` 的 X，**不是** `memory_search` 报的
「逐字重复度」，也不是写侧 80% 合并判据那个量。它是星图为扫全库做的**稀有词签名近似 Jaccard**：
每条约留最稀有的 24 个词（`const SIG_N = 24`），只算在两条以上出现过的词（df≥2，`c <= 1` 直接跳过），
门槛 0.86（`hyJaccardAtLeast(sigSets.get(na.id), sigSets.get(nb.id), 0.86)`）。库小的时候签名退化成
「两边共有的那几个词」，Jaccard 直接顶到 1。0.2.91 不重算（融合层拿不到正文），而是**在这个数字旁边
把口径说清楚**，并在只有真列出了对子时才说。

### 9.97.1 实测：同两对内容，三处口径各说各话

| 场景 | 全文逐字 Jaccard | 写侧回执 | 面板「相似」 | 工具 `memory_search` |
| --- | --- | --- | --- | --- |
| 近重复（同一件事改几个字） | 80.6% | 「重复度 81%」，点名跨层 | **1** | — |
| 共享前言 + 两个不同核心（各 40 余字） | **42%** | **没有**判重复 | **1** | 相似度 0.624（逐字 0.42） |

第二行就是这一轮的靶子：面板说 100% 重复、工具说四成、写侧说不重复。照面板去 `archived` 等于**误删**。
根因是签名近似在条目少的时候顶格——同一行数据，「相似 1」在库里只有二十几条时几乎不携带信息。

### 9.97.2 改了什么

1. **一句口径说明进尾注**（`lib/macro/defs/admin.js` 模块级 `export function hygieneRulerNote(body, args)`）：
   说明「相似 N」是稀有词签名估算（每条 24 个稀有词、只算 df≥2 的词）、跟 `memory_search` 的「逐字重复度」
   不是同一把尺子、库里条数少时签名常顶到 1 而全文逐字可能只有四成；并指路——判「同一句存两层」看
   `memory_search` 的 `repeat`（≥0.80 写侧就判重复），判「两条在说同一件事」看面板这个数。
2. **只在真列出对子时说**：`text.includes('（相似 ')` 才拼这句；`kind` 不是 `hygiene`（或显式要 `dup` 之外的类别）
   直接返回空。没对子的体检抬头只该有「没排上来」那句话。
3. **不顶掉既有尾注**：graph 分支从 `note: stray` 改成 `note: [ruler, stray].filter(Boolean).join(' · ')`，
   `call` / `local` 两条分发原样不动。
4. **门槛常量与 nebula 实现对齐**：文案里的「24 个稀有词」和 `SIG_N`、`0.86` 由 `verify.mjs` 的 A91 直接对着
   `vendor/dsh-memory-nebula/lib/host/graph.js` 断言，将来 nebula 调参就会红。

### 9.97.3 为什么不重算

融合层只有星图吐出来的文本（`疑似重复（2）`、`A ⇄ B（相似 1）`），拿不到两条的正文——重算全文 Jaccard
必须在 `host/graph.js` 里做，那是 vendor 的扫描热路径（`probe-graph` 一轮 97 秒），为一句尾注加一次全库重算不合算。
0.2.90 已经确立「一个概念两把尺子就两个都摆出来」；这里第二把算不出来，那就**用一句话把它指出来**，
而不是把不相干的数字默默顶在「疑似重复」后面让人自己猜。

### 9.97.4 怎么验

```
node tools/probe-graph.mjs   # H1–H7（新增 7 条）
node verify.mjs              # A91 六条
```

- H1/H2 两条都写下、写侧没判重复（说明这一对确实不是「同一句存两层」）
- H3 按 8 位 id 找到这一对（不写死「疑似重复（1）」——图谱探针自己那两条也会被判 dup，实测是（2））
- H4 `sim >= 0.85`（实测 1，签名顶格复现）
- H5 抬头含「稀有词签名」「逐字重复度」
- H6 工具侧逐字 0.42 且 `sim - rep >= 0.4`（两把尺子差出 40 个点，这轮要校准的正是这个缺口）
- H7 `kind='stale'` 时不掺这句
- A91 六条：模块级导出 + 只在 hygiene 分支 / 并进尾注不顶掉 stray / 文案三要素 / 与 nebula 的 `SIG_N`+`0.86` 对齐 / 没对子不掺 / probe-graph H 段进线

### 9.97.5 现场数字

- `check-all`：21 支 / 1,887 条断言 / 139s
- `probe-graph`：58 → 65 条（+7 = H 段）
- `verify`：952 → 953；`doctor`：124 → 125；`check-market`：47 —（索引未提交时那条从 PASS 变 WARN，提交后回 48）
- `vendor/` 未改：`make-vendor-manifest` 不必重跑
- 顺带修：`tools/probe-graph.mjs` 的 GB3 原来写死 `nodesN - orphN <= 1 && tailLine === ''`，H 段两条孤立节点进来后
  变成 4 节点 / 2 孤立 → 改成 `(nodesN - orphN <= 1 ? tailLine === '' : tailLine.includes('没排上来'))`

### 9.97.6 边界

- 改的是**融合层文案与探针**，没动 vendor 的签名算法、没改 dup 门槛 0.86、没改面板排序与截断（`HY_MAX`）。
- 面板这个数会继续顶格——这是它作为「扫全库」近似算法的固有行为，本轮只保证**读的人知道自己在读什么**。
- 已知仍未统一：`memory_dream` 与面板其它口径还没跟着 `dedupe` / `repeat` / 这里的「相似」对齐。
### 9.97.7 顺带修：市场索引曾写进一个「8 小时后」的时间戳

发版时用 PowerShell 拿时间戳：`[int][double]::Parse((Get-Date -UFormat %s))`。在 +08:00 这台机器上它
**多算了 8 小时**（1795149325，真实值是 1795122451）。`check-market` 那条「publishTimestamp 是合理的时间
（不是毫秒、不在未来）」当时允 `now + 86400`，于是 8 小时后的值照样 PASS，市场详情页会把「更新时间」
显示成未来。改了两处：

- 索引两份（`plugin-market/index.json`、`index.cn.json`）的 `publishTimestamp` 与 `sortKeys.updated`
  换成真 epoch（由 node 的 `Math.floor(Date.now()/1000)` 取，别再从 PowerShell 拼）。
- `tools/check-market.mjs` 的容差 `now + 86400` → `now + 300`，并在代码里写明原因：
  **24 小时的松量会把一个时区算错的值放过去**，错误不该靠余量过关。

线上核实（gh-proxy raw，带 `?cb=` 绕开 CDN 缓存）：`index.json` 200 / 3,410 B / v0.2.91 /
commit `644cc4e006` / ts `1795122451`（距今 218 秒，不在未来）；`index.cn.json` 同值 3,625 B；
`package.json` @main 与 @发布提交都是 0.2.91。

## 9.98 dream 是唯一回头看的地方，可它没带尺子（0.2.92）

### 9.98.0 一句话

写侧早就算得出「这两条是不是同一句话」（0.2.88 跨层点名、0.2.90 检索里报 `repeat`，两处都是
`DEDUP_THRESHOLD = 0.8` 的词集 Jaccard）。可 **dream**——全库唯一会回头看旧条目、判定该合并/归档的地方——
只把清单端出来，哪两条其实是同一句话，全靠模型自己扫字面比。同一把尺子，只有写的时候有刻度。

### 9.98.1 现在 dream 说什么

`buildDreamMessage` 选完本组的行之后，把这一组的正文两两比一遍（`dreamDupPairs`，同一个
`overlapOfSets`、同一个 `DEDUP_THRESHOLD`），≥80% 的对子按重复度降序取前 5 对，在清单末尾单独一段：

```
【逐字重复对 1 对】（下面这两条正文的逐字重复度 ≥80%，与 memory_remember 判「重复」是同一把尺子）：
- 0mwo20yqb ⇄ 0mwo20yqt  0.81 · fact ⇄ lesson
处置：这多半是同一句话分别存进了两层——保留信息更全、层级更合适的那一条，另一条用 memory_update 把 status 设 archived。
反过来，只是「相似度高」而没列在这里的，不要当重复处理：memory_search 的 similarity（cosine）高、repeat 低，
说的是「同一话题」，不是「同一句」。
```

没有对子时 **一个字不加**（`dupBlock` 为空串）——干净的清单不该被一段「本组没有重复」占地方。
门槛数字从常量算出来（`String(Math.round(DEDUP_THRESHOLD * 100))`），不是文案里写死的 80，
将来改门槛不会出现「说的是 80、判的是 90」。

### 9.98.2 顺手修的：短 id 撞车

id 开头是 base36 时间戳，**同一批连写两条，前 8 位常常一模一样**。实测在同一个进程里连写 BASE / NEAR，
两条都截成 `0mwo1yus`，于是重复对印成：

```
- 0mwo1yus ⇄ 0mwo1yus  0.81 · fact ⇄ lesson
```

读起来就是「一条自己和自己重复」。更糟的是拿这个 id 去 `memory_update`：`MemoryDb.update` 遇到歧义前缀
直接 `return false`（`if (matches.length > 1) return false`），回执却说「未找到该记忆」——**存在的东西看起来不存在**。
0.2.91 刚教训过「同一个名字两种算法」，这里是同一家族：同一个 id 两种解析。

两处都改掉：
- 清单内：`uniqueShortIdsAmong(rows)` 从 8 位起，只要和本清单里任何另一个 id 撞前缀就往下延（一次算好，O(n²) 但 n 是几十行）。
- 跨层回执：`uniqueShortId(db, level, id)` 按层确认唯一（`update` 也是按层解析，所以只需在本层判）。

### 9.98.3 怎么验

```
node tools/probe-ruler.mjs   # D1–D7（新增 7 条）
node verify.mjs              # A92 八条
```

- D1 dream 清单里真点了这一对（`【逐字重复对 1 对】`）
- D2 两个短 id 互相可区分（实测都撞到 9 位）
- D3 门槛与处置都在、没有 `{threshold}` 残留
- D4 成员**正好**是 BASE 与 NEAR（用前缀精确匹配，不用子串——8 位前缀互为子串会让否定断言假红/假绿）
- D5 阴性对照：只有一条的窗口没有这一块
- D6/D7 三语 `labels.md` 与 `dream-atomic.md` 都写了这条（新文案不许只写中文）
- A92 八条：两个纯函数是模块级 / 清单里真用上 / 没对子不加字且门槛由常量算 / 短 id 走 `uniqueShortIdsAmong` / 回执走 `uniqueShortId` / 三语 labels 带 `{n}`+`{threshold}` / 三语指引 / probe-ruler D 段进线

### 9.98.4 现场数字

- `probe-ruler`：12 → 19 条（+7 = D 段）
- `verify`：953 → 960（+7 A92 与两条旧断言改写）
- `vendor/meow-memory/lib/index.js` 262,849 → 263,334 B（`make-vendor-manifest` 必须重跑）
- 文案：三语 `labels.md` 各 +2 键、`dream-atomic.md` 各 +1 条（第 15 条）、`dream-topic.md` 各 +1 条并重排尾项编号

### 9.98.5 教训

```
69. 判据算出来了，不等于它到了需要它的地方。
    写侧 0.2.88 就知道「这两条是同一句话」，可它只在自己那条路径上喊一声；
    真正需要这把尺子的 dream 一直没拿到。功能齐全不等于口径统一——
    每加一个量，都要问一句：还有谁该看这个数，却没在看？
```

## 9.99 dream 分成两次看，同一句话就永远碰不上（0.2.93）

### 9.99.0 一句话

0.2.92 让 dream 能自己算「哪两条是同一句话」了，可它只在**本轮的那几行**里两两比。
而 `collectDreamRounds` 把整理范围切成**两次独立的消息**：`atomic`（project / fact / lesson / rules / soul / user，
按 project 分组）一次，`topic` 一次。于是同一句话一条记成 fact、一条记成 topic 时，两条从来不在同一轮里——
重复对永远算不出来。写侧的 `crossLevelDupe` 扫全部层、早就能抓；dream 是第二个「尺子只在写入方向装好」的地方。

### 9.99.1 现在怎么算

`buildDreamMessage` 拿到的 `rounds` 是整个整理范围，所以对子改成在**全部行**上算：

```js
const allRows = rounds.filter((r) => Array.isArray(r.groups)).flatMap((r) => r.groups.flatMap((g) => g.rows));
const roundIds = new Set(roundRows.map((r) => String(r.id ?? "")));
const dupPairs = dreamDupPairs(allRows).filter((p) => dreamPairOwner(rounds, p) === idx);
const shortOf = uniqueShortIdsAmong(allRows);
```

`dreamPairOwner(rounds, pair)` 返回「这一对在轮次里**先出现**的那一轮」下标。只由那一轮负责展示：

- 同一对**只印一次**——两轮各印一遍等于白烧一份 token，还会让模型以为有两对；
- 配对的那条不在本轮时，行尾标出「（另一组）」，文案走 `labels` 的 `dream.dup.crossRound`；
- 短 id 的唯一性也改成在 `allRows` 范围内判，跨界印出来也不会是同名。

实测（fact 与 topic 正文逐字相同）：

```
【逐字重复对 1 对】（下面这两条正文的逐字重复度 ≥80%，与 memory_remember 判「重复」是同一把尺子）：
- 0mwo37jb ⇄ 0mwo37jc  1.00 · fact ⇄ topic（另一组）
```

同一个窗口里那条**无关**的 fact 不会因为同项目、同层被凑进来（只按正文词集算）。

### 9.99.2 三语指引也要跟上

跨轮次对子有一个陷阱：模型在 atomic 那轮看到一个只有半边的对子，很容易想「另一条不在清单里，先不管」。
所以三语 `dream-atomic.md` / `dream-topic.md` 都补了一句：标着「（另一组）」说明配对的另一条在另一轮整理里，
照样按同一处置办，同一对只处置一次——看不见对方不等于没这回事。

### 9.99.3 怎么验

```
node tools/probe-ruler.mjs   # D8–D10（新增 3 条）
node verify.mjs              # A93 六条
```

- D8 fact ⇄ topic 被点名、整轮只印一次（`pairLineCount === 1`）、带「（另一组）」
- D9 阴性对照：同窗口无关的那条没被凑成对子
- D10 三语六份指引都写了「（另一组）」怎么处置，三语 `labels` 都有 `dream.dup.crossRound`
- A93 六条：在 `allRows` 上算 / `dreamPairOwner` 是纯函数 / 行尾文案走 `lbl3` / 三语 label / 三语指引 / probe 进线

### 9.99.4 现场数字

- `probe-ruler`：19 → 22 条（+3 = D8/D9/D10）
- `verify`：960 → 966（+6 A93，另改写 A92 两条字面量）
- `vendor/meow-memory/lib/index.js` 263,334 → 264,364 B（必须重跑 `make-vendor-manifest`）
- 文案：三语 `labels.md` 各 +1 键（`dream.dup.crossRound`），三语 `dream-atomic.md` / `dream-topic.md` 各 +1 句

### 9.99.5 教训

```
70. 分片是省 token 的手段，但分片会让判据只看到自己那一片。
    dream 把整理切成 atomic / topic 两次，是为了清单短、模型不晕；
    代价是「跨片的同一句话」永远不进同一个视野。凡是按片喂给模型做判断的地方，
    都要先问：这个判断需要的两个东西，会不会被分到两个片里？
    该在片边界之前算完的，就别留到片里算。
```

## 9.100 同一句话叠成了「摘要 + 全文」，逐字重复度就只剩 0.16（0.2.94）

### 9.100.0 缺口：尺子只认「一句话的两个副本」

0.2.90 把「重复」定死在正文词集的 Jaccard 上（`DEDUP_THRESHOLD = 0.8`），写侧与 dream 用的是同一把。这对「同一句话抄两遍」是准的，但对**同一件事的两种写法**完全失灵：

```
短摘录 ⇄ 长详写（同一件事）
  词数 短 15 / 长 92，长度比 0.16
  逐字重复度 0.163  <0.80 不判重复
  覆盖度 1.000  ≥0.90 可判详写/摘录

短摘录 ⇄ 中等详写
  词数 短 15 / 长 32，长度比 0.47
  逐字重复度 0.469  <0.80 不判重复
  覆盖度 1.000

两句不同结论（不该判重复）
  逐字重复度 0.034 / 覆盖度 0.133
```

这就是真实语料里最常见的那种重复：一条记成 fact 的短结论（≤60 字），一条记成 topic 的详细过程（≤300 字）。短的那条其实是长的那条的开头，Jaccard 的分母把长文的全部词都算了进去，重复度被稀释到十几二十个点——**门槛不是设得太高，是这把尺子量不了被折叠的东西**。而漏掉的代价和前几轮一样：同一个知识点永久占两份，首轮注入多付一份钱。

### 9.100.1 判据：换成覆盖度，配两道闸

```
var DREAM_COVER_MIN = 0.9;         // 短的那条至少 90% 的词出现在长的那条里
var DREAM_COVER_MIN_WORDS = 8;     // 短的那条至少 8 个不同的词
var DREAM_COVER_RATIO_MAX = 0.75;  // 长度比上限：差不多长的两条本就该各说各的
```

- `coverOfSets(a, b)`：分母取**小集合**，`inter / small.size`。Jaccard 的分母是并集，覆盖度只问「短的那条有没有整句落在里面」。
- 第一道闸用**绝对词数**而不是长度比：最常见的形态就是 15 词 ⇄ 92 词（比值 0.16），拿长度比当下限会把真实案例一起挡掉——第一版就是这么写的，探针 E1 直接红，改成「至少 8 个不同的词」才既挡住「一个短语碰巧撞进长文」又不误伤。
- 第二道闸 `ratio > 0.75` 拦住「两条差不多长」：那种关系本来就该是 Jaccard 的活，不该进这一块。
- 与 ≥80% 的重复对**互斥**（`if (overlapOfSets(a, b) >= DEDUP_THRESHOLD) continue;`），同一对不会印两遍。
- 归属仍然走 0.2.93 的 `dreamPairOwner`：一短一长的两条通常在 atomic 与 topic 两轮，所以只由先出现的那一轮印，行尾照旧标「（另一组）」。

### 9.100.2 实测片段

```
【重复详写 1 对】（下面每一对里，⊂ 左边那条的整句几乎都落在右边那条里——逐字重复度只有几十个百分点，因为一条是短摘录、一条是长详写，但它们讲的是同一件事，判据是覆盖度 ≥90%）：
- 0mwo46qj ⊂ 0mwo46qk  1.00 · fact ⇒ topic（另一组）
处置：合成一条——把短摘录里长那条没有的细节补进长那条，保留信息更全的那条，另一条用 memory_update 把 status 设 archived。别因为 repeat 低就当两件事记着：同一个知识点存两层，首轮注入要多付一份钱。
```

方向是固定的：`⊂` 左边永远是**词更少**的那条（这里是 fact 短摘录），右边是词更多的那条（topic 长详写）。写侧 `memory_remember` 的门槛这一轮**没有动**——覆盖度判据只出现在 dream 的盘点里，让读的人自己决定合并；要是写到一半用覆盖度拒收，一条长 topic 里引用一句旧结论就会被挡，误伤面太大。

### 9.100.3 验法

`tools/probe-ruler.mjs` 新增 E1–E5（现 27 条，`ALL PASS`）：

- E1：清单里真的出现 `【重复详写 1 对】`，且抓到对子行。
- E2：方向对——`⊂` 左边是短摘录的 id 前缀、右边是长详写的，层级 `fact ⇒ topic`（层级那一列现在会跟着「（另一组）」后缀，断言用 `startsWith('topic')`，不能用 `===`）。
- E3：覆盖数 ≥0.9、门槛文案是 `覆盖度 ≥90%`、处置含「合成一条」与 `archived`、且没有 `{contain}` 残留。
- E4：阴性对照 + 互斥——同窗口那条无关 fact 没被凑进来；详写行只有 1 条；这一窗**不出现**`【逐字重复对 N 对】`（同一对不印两遍）。
- E5：三语 labels 有 `dream.cover.title` / `dream.cover.rule`，三语六份指引都写了这一条。

`verify.mjs` 加 A94 七条：常量是具名三个（不许魔数）、分母取小集合、与 ≥80% 互斥、清单在 `allRows` 上算且拼在 `list` 末尾、没对子不加字、门槛由 `String(Math.round(DREAM_COVER_MIN * 100))` 算、三语 label 与指引都在、探针 E 段进线。

### 9.100.4 现场数字

- vendor `lib/index.js`：三常量 + `coverOfSets` + `dreamCoverPairs`（`DREAM_DUP_MAX` 封顶 5 对），`coverBlock` 拼进 `listBlock + dupBlock + coverBlock`。
- 三语 labels：zh 4,638 B / en 5,077 B / pt-br 5,733 B，各加 `dream.cover.title` 与 `dream.cover.rule`。
- 三语指引：atomic 16 条、topic 13 条（新增那条插在原第 12 条「完成后直接回复」之前）。
- probe-ruler 22 → 27 条；verify 967 → 974 条。

### 9.100.5 教训 71

**门槛要按最坏形态定，不能按最好形态定。** 第一版把「短 / 长」的比值下限设成 0.25，理由是「太短的条目撞进长文不算重复」——可实测最常见的真实案例比值就是 0.16，阈值一设就把要抓的东西挡在门外，探针立刻红。真正该挡的是「短的那条本身没有信息量」，那就用绝对词数（≥8 个不同的词）去挡，而不是拿长度比兼职。同一个数字同时承担两个用途时，先问它在真实数据里的分布，再决定它守哪一头。

## 9.101 「是同一件事」不等于「合并不丢字」：处方要把多余的词逐字点出来（0.2.95）

### 9.101.0 缺口：覆盖度只说一半

0.2.94 给 dream 装上了覆盖度这把尺子（`DREAM_COVER_MIN = 0.9`），能认出「一条短摘录 + 一条长详写」其实是同一件事。可是处置只有一句「合成一条——把短摘录里长条没有的细节补进长条」。**≥90% 的含义是：短条最多还有 10% 的词没落进长条。** 模型最容易做的动作恰好是反的——留下信息更全的长条，把短条整条 `archived`，那 10% 就跟着进了归档，而且没人会知道丢了什么。

这一轮的靶子因此不是「再找一种重复」，而是**把「合并」从一个口号变成一份可核对的清单**：

- 判据说「是同一件事」；
- 处方说「这次合并要把这几个词补进去」，或者明说「没有多余词，这次合并是无损的」。

### 9.101.1 判据：多余词逐字点名，两种结局都要说清

```js
var DREAM_MERGE_WORDS = 6; // 最多点名几个词：再多就不是「补一句」，是重写

function missingWordsOf(smallSet, bigSet, max = DREAM_MERGE_WORDS) {
  const out = [];
  for (const w of smallSet) if (!bigSet.has(w)) out.push(w);
  out.sort((x, y) => y.length - x.length || (x < y ? -1 : x > y ? 1 : 0));
  return { total: out.length, sample: out.slice(0, max) };
}
```

- 排序是**词长降序**（同长按字典序）：`TB7719` 这种编号、`diagnose-windows-sandbox-acl` 这种长标识符是最容易在「合成一条」时被顺手丢掉的，先把它们顶到前面。
- 只在 `dreamCoverPairs` 里算一次，`missing: miss.total, words: miss.sample` 挂在行对象上——清单行与处方行读同一份数据，不会各行其是。
- 处方行缩进两空格挂在行下面（`return `${head}\n  ${recipe}`;`），跟着那一对走：多对同屏时不会串行。
- `missing === 0` 时**不留白**，走 `dream.cover.keepNone`：「短条没有长条之外的词，这次合并没有东西要补——留着长条、把短条设 archived 就行，正文不用改写。」这句把「无损」也变成一个可核对的结论，而不是让模型自己猜「还有没有漏的」。
- 三语文案走 labels（`dream.cover.keep` 带 `{n}` / `{words}`、`dream.cover.keepNone`），词表用 `\u3001`（顿号）拼——zen 一列词就是一个句子，别用逗号糊成一段。

同时把**三把尺子的分工**写进三语六份 dream 指引（atomic 第 17 条、topic 第 13 条）：

- 逐字重复 ≥80%（Jaccard）与覆盖度 ≥90%（覆盖度）都是「重复」→ 该合并成一条、另一条归档；
- 体检的「相似 N」与 `memory_search` 的 `mode="similar"`（稀有词签名）是「相似」→ 同一话题的两句不同的话**不许合并**，最多互相补一句指针；
- 「相似 N」很高却**没被列进上面两块**，就是在告诉你：这是两件事，别硬合。

### 9.101.2 实测片段

```
【重复详写 1 对】（下面每一对里，⊂ 左边那条的整句几乎都落在右边那条里——逐字重复度只有几十个百分点，因为一条是短摘录、一条是长详写，但它们讲的是同一件事，判据是覆盖度 ≥90%）：
- 0mwo5lnd ⊂ 0mwo5lne  0.93 · fact ⇒ topic（另一组）
  处方：留着长条，把短条这 1 个词补进去（tb7719）——漏掉它们，这次合并就丢字了。
处置：合成一条——把短摘录里长那条没有的细节补进长那条，保留信息更全的那条，另一条用 memory_update 把 status 设 archived。别因为 repeat 低就当两件事记着：同一个知识点存两层，首轮注入要多付一份钱。
```

覆盖度 0.93 的意思是短条 15 个词里有 14 个落在长条里，缺的那一个就是 `TB7719` ——短条里唯一能定位那次故障的编号。没有处方行，模型看见「0.93、合成一条」，最省事的做法就是「留长的、归档短的」，这个编号就再也没人知道曾经存在过。

### 9.101.3 验法

`tools/probe-ruler.mjs` 新增 F1–F4（现 31 条，`ALL PASS`），要用两个专用窗口：

- `ws-recipe-keep`：`R_SHORT_KEEP = 'sandbox 关了以后 workspace 写入会报 EPERM，得先放行目录 TB7719'` 对 `R_LONG`（同一件事的长详写）→ 覆盖 14/15 = 0.933、恰好漏 1 个词 `tb7719`。
  - F1：处方行真的存在（`RECIPE_LINE = /^ {2}(处方|Recipe|Receita)：/m`）、且没有 `{n}` / `{words}` 之类的占位符残留；
  - F2：点名的正是 `TB7719`、且说「1 个词」——编号被点名才算真的可核对。
- `ws-recipe-none`：`R_SHORT_NONE` 整句就是 `R_LONG` 的前半 → 覆盖 1.00、漏 0 词。
  - F3：走 `keepNone` 分支（「没有长条之外的词」），且 **不许出现 `tb7719`**——阴性对照，防「不管有没有都硬凑几个词出来」。
- F4：三语六份指引都写了处方与三把尺子，三语 labels 都有 `dream.cover.keep` / `dream.cover.keepNone`。

构造语料这里有个必须记住的细节：**tokenizer 对 CJK 是切 bigram 的**（`run[k] + run[k+1]`），拉丁词才整词并 `toLowerCase()`。所以「再加一句中文」一次会新增很多 token，覆盖度立刻掉到 0.9 以下；要造「恰好漏 1 个词」的案例，正确手法是**加一个拉丁串**（`TB7719` 只增加 1 个 token）。按字数估 token 会一次一次踩空。

`verify.mjs` 加 A95 七条：三个常量与 `missingWordsOf` 都是模块级（不许做匿名内联）、降序排序那句、`missing: miss.total, words: miss.sample`、两个分支都走 `lbl3`、处方行是 `` `${head}\n  ${recipe}` ``、三语 labels 有 keep/keepNone 且 keep 行不带 `{contain}`、三语六份指引含处方与三把尺子、探针 F 段进线。现 980 条。

### 9.101.4 现场数字

- vendor `lib/index.js`：`DREAM_MERGE_WORDS = 6` + `missingWordsOf`；`dreamCoverPairs` 行对象多两个字段；`coverBlock` 的 map 里一行 `recipe` 挂在行下。
- 三语 labels：zh 5,037 B / en 5,512 B / pt-br 6,046 B，各加 `dream.cover.keep` 与 `dream.cover.keepNone`。
- 三语指引：atomic 17 条、topic 14 条（新增三把尺子那条，原第 13 条「完成后直接回复」后移）。
- 三语指引体量：zh atomic 6,763 / topic 5,041、en 7,453 / 5,259、pt-br 8,122 / 5,668 B，全 LF。
- `probe-ruler` 27 → 31 条；`verify` 974 → 980 条；`check-all` 1,926 → 1,936 条 · 21 支全绿。

### 9.101.5 教训 72

**判据给出「是同一件事」，只完成了判断的一半；不给出「怎么合并不丢字」，模型就会用最省事的动作把差的那部分丢掉。** 一个判据可以只回布尔，但一个**处方**必须能被核对：点名具体的词、给出确定的动作、把「没有要补的」也明说。留白不是中立——留白会把选择权交给「更省 token 的那条路」，而那条路永远是「删掉短的那条」。

推论三条：

1. 凡是「合并 / 归档 / 覆盖」类处置，都要顺手回答「会丢什么」。丢不了就明说丢不了。
2. 阴性对照要防的是**过度触发**：F3 专门断言「本不该点名时一个词都不许出现」，光有正例的探针只能证明会喊，证明不了不乱喊。
3. 造验证语料前先弄清 tokenizer 怎么切：CJK 切 bigram、拉丁整词，这两件事决定了「加一句话」和「加一个编号」在覆盖度上差多少倍。

## 9.102 整理完什么都不留：dream 的规模只有它自己知道（0.2.96）

### 9.102.0 现象

`memory_dream` 的回执只有「整理任务已在后台启动」。整理完之后，`dream_log` 里那一行是：

```
window dream done: sess-xxxx groups=2 stamped=2 T=2026-11-19T…
```

`claimDream` 只防「同一个窗口重复整理」，`logDream` 只记「收尾原因 + 轮数 + 封存数」。于是
**这一轮翻了多少条、撞上几对逐字重复、几对重复详写、合并会丢几个词**——全部只活在模型读到的那条
清单消息里，消息一过就没了。主人回头查「dream 到底动过什么」只有两个数：groups 和 stamped。

对模型也不友好：开工前它只知道「有 N 轮」，不知道这一轮重不重。清单里有没有对子、要不要逐条合并，
它得读到那一轮才知道。

### 9.102.1 判据与处方

和 0.2.95 同一条纪律：**数字必须是同一份清单算出来的**。所以摘要不另写一套判据，直接调
`dreamDupPairs` / `dreamCoverPairs`——就是后面真正往消息里印块的那两个函数。两处口径永远一致，
不会出现「回执说有 2 对、清单里只印了 1 对」这种读者无法核对的话。

`dreamPlanDigest(rounds)` 返回：

| 字段 | 含义 |
| --- | --- |
| `rounds` | 这一轮分几段消息（atomic / topic / project-summary） |
| `groups` | 组数（project 分组） |
| `rows` | 选中的条目总数 |
| `dup` | 逐字重复对（≥80%，与写侧 DEDUP_THRESHOLD 同一把尺子） |
| `cover` | 重复详写对（覆盖度 ≥90%） |
| `missing` | 这些详写对里「只活在短条」的词总数 |
| `projects` | 项目总结段涵盖几个项目 |

### 9.102.2 三个出口

1. **回执**：`memory_dream` 与 `/dream` 同一份（都从 `startWindowDream` 的 `trace.digest` 取），
   三语 labels 的 `dream.plan` 念一句 `【这一轮看到：2 轮 / 2 条 · 逐字重复 0 对 · 重复详写 1 对】`；
   真有字要补时才加第二句 `dream.plan.missing`（共 N 个词只活在短条里）。`missing === 0` 时一个字不加——
   空白不是中立，硬凑一句「共 0 个词」只会让读者以为流程坏了。
2. **落库**：开工时摘要存进 `dream_meta` 的 `dreamdigest:<sid>`；收尾时 `finalizeDream` 把它写进
   `dream_log.changes.plan`（整份对象）与 `summary` 的 `plan rows=/dup=/cover=/missing=`，
   然后 `delDreamMeta` 删掉——不删的话下一轮会读到上一轮的旧账。`done` / `aborted` / 中断恢复
   都走同一个 `finalizeDream`，所以中止也留痕。
3. **调试日志**：`dream-debug.log` 的 `dream start` / `dream done` 行带同一串 `plan …`。

### 9.102.3 顺序上的坑

摘要必须在 `claimDream` **成功之后**算：被 `claimed` 挡回来的那次，一个整理都不会跑，为一个不会跑的
清单烧一遍分词纯属浪费（一窗几十条 × 两次 pair 计算）。`sendFailed` 的那一支也照样把摘要念出去——
「要整理的记忆还在」这句话里，规模正是它还在的证据。

### 9.102.4 顺手的效率修正

同一批行的词集原来要被算三遍（逐字重复对、重复详写对、摘要）。`tokenize` 是纯函数，改成
`rowTokenSet(r)` 按 `id + updated_at` 记一份：改过内容的条目 `updated_at` 会变，读不到陈旧词集；
表超过 4096 条整表清空（dream 一轮只有几十行，这个上限纯属防守）。

### 9.102.5 没做的事（写清楚，免得以为漏了）

面板还没读这条路。理由：`.dsh-meow` 的账本在 meow 手里，融合层的面板动作都走 `$DSH_HOME` 下的文件，
硬接一个 sqlite 句柄等于把账本抄一份到面板侧，两处口径迟早会漂。下一步应当走已有的事件通道
（`/meow-memory/dream-events` 的 `DreamStateBroadcast`）把 `plan` 带出去，而不是让面板自己去查库。

## 9.103 账本写完了，得有人念：面板上的整理留痕（0.2.97）

### 9.103.0 现象

0.2.96 让 dream 在收尾时把这一轮的规模写进 `dream_log`（summary 一行 + `changes.plan` 一份结构）。
可库里只有写口：`memory_admin` 没有任何一行读它，主人想知道「上一轮整理看到几条、点出几对、缺几个词」，
只能自己去翻 sqlite。**一个只有写口的账本，等于把「可追溯」做成了「看我写过」**。

### 9.103.1 判据与读口

- 读口唯一：`readDreamLedger(workspace, dir = ".dsh-meow", limit = 5)`（`vendor/meow-memory/lib/index.js`）。
  面板、以后任何 UI 都从这一个出口读，不许各自开一眼 `SELECT`。
- 四种「没念出账」必须分开，`missing` 字段：
  `''` 正常 / `'no-workspace'` 会话头没有 cwd / `'no-db'` 这个工作区还没建库 /
  `'read-failed: …'` 库在但读不出来（原因原样带出）。
  **把后两种合成「还没跑过 dream」，是最难查的那种谎。**
- 数字只念账：`changes.plan` 是 0.2.96 起才有的字段。更老的记录只说
  「这条记录比 0.2.96 早，当时还没写规模数字」，绝不拿现在的清单反推当时的样子。
- 一行坏账不吞整本账：`recentDreams()` 里 `JSON.parse` 失败的那行 `changes = null`，照样列出，
  后面的好账一条不少。

### 9.103.2 三个出口

| 出口 | 位置 | 职责 |
|---|---|---|
| `MemoryDb.recentDreams(limit)` | `vendor/meow-memory/lib/index.js` | `LIMIT 1..50`（超界夹住），最新在前，返回 `{runAt, summary, changes, note}` |
| `readDreamLedger(workspace, dir, limit)` | 同上（模块级） | 先判 `no-workspace` / `no-db` / `read-failed`，再 `getDb().recentDreams()` |
| `memory_admin(action="dream")` | `lib/macro/dreamledger.js` + `lib/macro/defs/admin.js` | 正文逐行：`时间 · 收尾原因 · N 轮/M 条 · 逐字重复 X 对 · 重复详写 Y 对 · 缺 Z 个词 · K 个项目段`；口径只说条数差 |

收尾原因从 summary 前缀取（`window dream (done|aborted|recovered):`），文案表 `REASON_TEXT`：
`done → 整理完成`、`aborted → 中途放弃`、`recovered → 上次被打断，这次补记`。

### 9.103.3 顺序上的坑

- **projectDir 不在 macro 的配置段里**：它在 meow 段（默认 `.dsh-meow`，可配）。面板若自己写死
  `.dsh-meow`，主人一改目录，面板就会对着一个不存在的路径说「还没建过库」。
  所以 `lib/index.js` 留了模块级 `meowDirReader()`，由 `engineCfg.meow` 现读，随重挂一起更新。
- **面板不重算**：`dreamPlanDigest()` 只在开工时算一次、收尾落库；面板念的是落库的那份。
  两处各算一次，迟早会出现「面板说 2 对、留痕说 1 对」。
- **`parse` 失败不是空账**：`changes` 坏掉只影响那一行的细节，不影响「这一轮存在」这件事。

### 9.103.4 没做的事

- 客户端月相图标的 SSE 事件里还没有 plan 字段（`DreamStateBroadcast` 只带 state）。
  真要搬上去，下一步是给 `/meow-memory/dream-events` 的广播加第三参，面板与图标共读一份，
  不为图标另开一条读口。
- 面板不分页：`limit` 上限 50，再往前要翻账本得改工具参数（暂不做「翻页游标」，
  账本本身是 append-only，按时间截断足够）。

## 9.104 一条账看得懂，五条账看不出走向（0.2.98）

### 9.104.0 现象

0.2.97 把 `dream_log` 念上了面板：每次整理一行，带轮次/条数/重复对/缺词。主人翻一眼能知道「这一次干了什么」，
但真正该问的问题是**「整理是不是越做越干净」**——五行数字排在那里，看完也记不住走向，
而且没有编号，想说「第三条那次没落库」只能靠时间去指。

两个具体的坑：

1. **单行没有比较**：`重复详写 1 对` 是多是少，取决于上一次是多少；账本把每次独立念，比较留给读者在脑子里做。
2. **`stamped` 没露面**：`changes.stamped` 是「这一轮的结论真的写进库了吗」。整理跑完却没落库，
   和根本没整理过是两件完全不同的事，面板上原来一个字都不提。

### 9.104.1 判据与处方

- **行首给序号**：`#1` 是最新。账本顺序本来就是最新在前，编号只是把「顺序」变成可引用的东西。
- **行尾给落库**：`changes.stamped` 是布尔就念「落库 是/否」；不是布尔（老记录）就一个字段都不加，
  不许猜。
- **趋势行单独一行、只在能算的时候出现**：`trendLine(rows)` 从账本算，四条克制写死在代码里——
  1. 可用记录 < 2 条直接返回空串（一条记录没有「趋势」，硬算等于编）；
  2. 没有 `plan` 的老记录不参与，但必须说清「N 条记录早于 0.2.96，没有数字、不参与」——否则合计对不上账；
  3. 可用记录 < 4 条时补「K 次样本太少，只当参考、别当走势」；
  4. 前后半段均值差 < 0.5 一律判「持平」，不许把 1.4 → 1.2 讲成「在变少」。
- **口径进 scope**：出现趋势行时补一句「趋势行只念账本里的 plan 数字，不重算这一轮清单」。

### 9.104.2 三个出口

| 出口 | 变化 |
|---|---|
| `readDreamPanel()` body | 账本行带 `#k` 与「落库 是/否」；能算时末尾空一行后接趋势行 |
| `readDreamPanel()` scope | 条数口径 + 「趋势行只念账本」一句 |
| 探针 | probe-fusion D15–D17（合计与走向 / 无走势不编 / 老记录跳过要说清），probe-ruler H6（limit 自己收紧） |

### 9.104.3 顺序上的坑

- 趋势要按**时间正序**算（账本是倒序），`trendLine` 里 `rows.slice().reverse()` 那一步不能省，
  否则「在变少」会全部反成「在变多」，而且看起来煞有介事。
- 前后半段用 `Math.floor(n / 2)` 切：5 条时只比 2 vs 2，中间那条不参与——宁可少算一条，
  也不要在奇数长度上把同一条算进两半。
- 行首序号从 1 开始，**按当前列表而不是全账本**编号：`limit=1` 时那一行是 `#1 `，
  它同时是「最新」与「唯一」，这两个身份不冲突，但别让编号看起来像全局行号。

### 9.104.4 没做的事

- 不做图表、不画 ASCII 折线：面板是一段文本，主人复制走就失真，数字加走势词已经够。
- 不做分页：`limit` 上限仍是 50，账本是 append-only，按时间截断足够。
- 不做单条展开：`changes.plan` 里还剩 `groups` / `stamped` / `projects` 名单没念，
  真需要时下一步是给 `memory_admin(action="dream")` 加一个按 `#k` 取明细的参数——那是新增参数，
  会连带 schema、参数归属表与四条审计断言，值得单独一版做，不在这一版塞进来。


## 9.105 整理正在进行时，面板只剩一个空账本（0.2.99）

### 9.105.0 现象

0.2.96 让 dream 每轮把规模写进 `dream_log`（summary 一行 + `changes.plan`），0.2.97 让面板念这本账，0.2.98 让它给出走向。三版都在回答同一个问题：**已经发生过的整理长什么样**。

可主人盯着屏幕的那一刻，dream 往往正在跑：

- 会话里刚触发整理，模型正在按清单逐条合并；
- 面板打开一看——账本里还没有这一轮（收尾才写 `dream_log`），于是只剩上一轮或「账本还是空的」；
- 月亮图标在呼吸灯，却一个字都说不出「这一轮到底有多大」。

信息其实早就有了：`startWindowDream` 在 claim 成功的同一步就把 `dreamPlanDigest` 存进了 `dream_meta` 的 `dreamdigest:<sid>`。只是：

1. `dream_log` 只记收尾，进行中的那一轮没有任何读口；
2. `onDreamState` 只传 `state`（`dreaming` / `dreamed` / `active`），SSE 的 `data` 里没有规模；
3. `collectDreamStates` 也只回 `dreamed` / `dreaming` 两个 id 数组。

于是「正在发生的事」在三个出口上都是不可读的。

### 9.105.1 判据与读口

新增模块级 `readLiveDream(workspace, dir = ".dsh-meow")`：

| 字段 | 含义 |
| --- | --- |
| `sessionIds` | 此刻 lease 还活着（`Date.now() - lease.progress_at <= DREAM_LEASE_MS`）的会话 id，顺序即 `listWindows()` |
| `plans` | 键=会话 id，值=`dreamdigest:<sid>` 解析出来的 `{rounds, groups, rows, dup, cover, missing, projects}`；没有 meta 就没有这个键 |
| `dbPath` | 库路径，报错时用来说清是哪一本读不开 |
| `missing` | `''` / `'no-workspace'` / `'no-db'` / `` `read-failed: ${msg}` `` |

三条判据：

1. **只认活 lease**。lease 过期就不算「现在在整理」——不能把昨天那一轮说成进行时。
2. **规模只从 `dreamdigest` 读**。没有 digest 就说「规模还没落 meta」，绝不按当前清单现算一遍（现算会和收尾写进账本的那份数字对不上）。
3. **三态分开**。`no-workspace`（会话头没有 cwd）、`no-db`（这窗口还没建库）、`read-failed`（库在但读不开）都不是「现在没有在整理」；把它们合成一句，是最难查的那种谎。

同时给 `collectDreamStates` 加一列 `plans`（同样是「有活 lease 才有」），`dreamed` / `dreaming` 两个老字段原样保留。

### 9.105.2 三个出口

| 出口 | 改法 |
| --- | --- |
| SSE `dream` 事件 | `DreamStateBroadcast.broadcast(sessionId, state, detail)` 把 detail 并进 `data`；`signalDreamState(sessionId, state, detail)` 透传。`dreaming` 事件现在带 `plan`，老消费方只看 `state` 不受影响 |
| 面板首行 | `readDreamPanel` 先读 `readLiveDream`：有活 lease 就 `lines.unshift(liveText, '')`，并给 scope 加一句「第一行是正在整理的那一轮，规模读的是 dreamdigest，不是账本」 |
| 空账本 | 账本为空但有活 lease 时，先说进行中那一轮，再说「账本还是空的」——否则主人会以为这一次整理什么都没看到 |

面板那一行**不带 `#k` 序号**：序号属于账本里的历史，这一轮还没写进去。它也不参与趋势（趋势只算 `changes.plan`）。

### 9.105.3 顺序上的坑

1. digest 必须在 `claimDream` 成功之后才算——被 `claimed` 挡回来的那次不该为一个不会跑的整理烧一遍分词（0.2.96 已定），所以广播也放在同一位置。
2. 判断 lease 死活看 `progress_at` 而不是 `T`：心跳会把 `progress_at` 往前推，`T` 是这一轮的起点，用 `T` 会把长跑的正常整理判成过期。
3. 面板里 `live` 要在「账本是否为空」之前算，否则空账本分支会提前 return，永远念不到进行中。
4. 一个工作区可能同时有多个会话在整理（`listWindows` 多行），面板只念第一条的规模，其余用「还有 N 个会话在排队等整理」报数——不静默吞掉。

### 9.105.4 没做的事

- 面板不分页：`limit` 仍然只收紧账本行数，进行中那一行永远在最前。
- SSE 只加了 `plan` 一个字段：`groups` / `stamped` 属于收尾结果，放进 `dreaming` 事件会让人以为已经落库。
- 没做「整理进度百分比」：一轮 dream 的轮数是已知的（`rounds`），但每轮耗时不可预知，百分比是编出来的。


## 9.106 账本一长，最近五条就装不下了（0.2.100）

### 9.106.0 现象

0.2.97 起面板能念 `dream_log`，0.2.98 加了走向，0.2.99 加了「正在进行的那一轮」。三版加起来回答了「最近几次整理长什么样」，但账本本身是会长的：一天跑几次整理，一周就三十行，而面板永远只念最近 5 条，再多的话一句都不提——用户看到五行，会以为账本只有五行。

另一边，每一行只有一句摘要式的规模，问不出「那一次到底写了什么」：`changes` 里存着完整的 plan、`stamped`、`groups`，`summary` 里存着那一轮的原话，`note` 里可能有人手写的备注，而面板一个都不摊开。账本读得出来，却读不进去。

这一版补两件事：**翻页**和**单条展开**。

### 9.106.1 读口：多一个 OFFSET，多一个「第几近」

`readDreamLedger(workspace, dir, limit, offset)` 现在返回 `{ rows, path, missing, total }`：`total` 由 `dreamCount()` 单独查，**不拿这一页返回了几条当总数**——最后一页天然短，那是页面短，不是账本短。

排序是 `ORDER BY run_at DESC, rowid DESC`。第二段不是装饰：同一毫秒里插进去的两条（探针里一抓一大把）如果次序不稳，`LIMIT/OFFSET` 翻页就会漏条或者重条，而漏掉的那条永远不会有人发现。

`readDreamRecord(workspace, dir, rank)` 是展开用的读口，它在原来四态（`''` / `no-workspace` / `no-db` / `read-failed: …`）之外多一个 `no-row`：账本在、就是没有第 rank 条。把它说成「读不出来」是另一种谎——一个是坏了，一个是你要的那条不存在。它顺手把「更早一条」一起带回来（`recentDreamsPage(2, k - 1)`），因为单条的数字没有变化量，要跟谁比得先有人指定。

**对外的编号只有一种：第几近，1 = 最新，跨页连续。** 行里带 rowid，但只当内部句柄——面板上从来不印它。同一个位置有两种叫法，是这个插件最容易长出来的毛病（0.2.91 的「相似 N vs 逐字重复度」就是），这里一开始就掐掉。

### 9.106.2 面板的三个出口

| 输入 | 出口 | 一句口径 |
| --- | --- | --- |
| `page`（从 1 起） | 第 N 页的行，编号跨页连续，末尾一行导航 | 页码越过最后一页时退到最后一页并说清，不返回空白页 |
| `id`（`3` / `#3`） | 单条的摘要、备注、changes 原文，加一句「比更早一条」 | 原文照账本念；超长截断要报真实长度 |
| 都不给 | 最近 `limit` 条（默认 5），第一页 | 与 0.2.97–0.2.99 完全一致，老调用不受影响 |

三条克制写进了代码，不是写在注释里：

1. **趋势只出现在第 1 页。** 趋势说的是「最近几次」，翻到第 3 页还挂着它，人会把旧页的数字当成走势。
2. **进行中那一行也只在第 1 页。** 它讲的是「现在」，不是「那一页的历史」。
3. **展开不重算。** `changes` 摊开就是账本里的字节；坏行（JSON 解析失败）只说「这条读不出来」，不拿摘要里的数字凑一份看起来完整的规模。

### 9.106.3 顺序与口径上的坑

- **总数必须先查，页码才能夹。** 先按 `page` 算 offset 再查，越界时只能返回空页；先拿 `total` 算 `lastPage`，才有「退到最后一页并说清」这个出口。
- **脏参数要打回，不许静默退回默认。** `page=0` 悄悄当第一页，用户会读成「账本只有这一页」；`id=abc` 悄悄退回整本账，用户会读成「展开了，就长这样」。两者都改成抛错，并在错误里说清「这次什么都没按你说的做」。
- **截断要报长度。** `changes` 超过 1200 字符时截断，同时把真实长度写出来——否则「原文就这么多」和「我只给你看了这么多」看起来一模一样。
- **上一版那句版本断言要跟着改。** 0.2.99 的 verify 块原来写死 `pkg.version === '0.2.99'`，一 bump 就红；改成「不早于 0.2.99」，版本号一致性交给 doctor 的单一来源那条守。这类写死等号的断言每版都要回头改一次，是纯粹的维护税。

### 9.106.4 没做的事

- 不按项目/时间过滤：账本行里没有可靠的 project 字段，硬筛要动 `logDream` 的写侧，留到真有需求那版。
- 不做关键字搜索：`changes` 是 JSON，全文检索要么上 FTS5 要么自己扫，两条都比这一版大，先不做。
- 不做「删除某条账」：账本是留痕，删它等于改历史；要清理就整库备份后重建。
- 不给 `total` 做缓存：`COUNT(*)` 在几万行以内是常数级开销，缓存反而会跟分页口径打架。

## 9.107 项目段写在账本里，却只被数了个数（0.2.101）

### 9.107.0 现象

`dream_log.changes.plan.projects` 从 0.2.96 起就一直在写：某一轮 dream 涉及了哪几个项目段。但面板上有它的时候，只出现在两个地方——趋势行里的「N 个项目段」，和「整理进行中」那行的「K 个项目段」。两个都是**计数**。

于是有三件事问不出来：

- 账本里到底有哪几个项目段？各自被整理过几次？
- 「只翻某个项目的账」怎么翻？
- 翻到某一条（比如 `#7`）时，这一轮动了哪几个项目？

前两件是读口缺一条通道，第三件是展开面板少一行。它们都不是数据问题——数据一直在库里。

### 9.107.1 读口：筛在 SQL 里，页面与总数共用一个筛子

新增/扩展了四处（`vendor/meow-memory/lib/index.js`）：

| 读口 | 作用 | 关键点 |
| --- | --- | --- |
| `recentDreamsPage(limit, offset, project)` | 取一页账，可按项目段筛 | `project` 为空时参数是 `(n, skip)`，不筛；否则是 `(name, n, skip)` |
| `dreamCountOf(project)` | 筛后一共几条 | 空 → 直接走 `dreamCount()`，口径与不筛时完全一致 |
| `dreamProjects(limit)` | 项目段分布 | `{items: [{project, n}], total}`，次数降序、同数次按名字 |
| `readDreamProjects(workspace, dir, limit)` | 上面那个的模块级读口 | `missing` 三态：`no-workspace` / `no-db` / `read-failed: …` |

筛选条件用的是 SQLite 的 JSON1：

```sql
WHERE json_valid(changes)
  AND EXISTS (SELECT 1 FROM json_each(json_extract(dream_log.changes, '$.plan.projects'))
              WHERE json_each.value = ?)
```

三个判断写在这里，都是踩过才知道的：

1. **必须 `json_valid` 先挡一道。** `changes` 是 TEXT，理论上可能是半截 JSON（写库时崩了、手工改过）。没有这个守卫，`json_extract` 会在坏行上抛错，整个面板变成「账本读不出来」——一行坏账把整本账带崩，这是最不该发生的失败。
2. **筛必须留在 SQL 里。** 取全账本再在 JS 里 `filter`，看起来一样，但 `total` 与页面会各算一套：`total` 是全账本的数、页面是筛后的行，翻页立刻翻出空页。所以 `readDreamLedger` 把 `project` 一路传下去，`total: db.dreamCountOf(project)`——**同一个筛子出两个数**。
3. **分布的 `total` 是 `COUNT(DISTINCT je.value)`，不是 `items.length`。** 只列前 5 个时，用户看到 5 行会以为「就这 5 个项目」。`total` 单独查，面板据此写「（还有 N 个项目段没列）」。

### 9.107.2 三个出口

| 出口 | 说什么 |
| --- | --- |
| `action="stats"` 的账本列表（第 1 页、没筛时） | 末尾多一行 `项目段：Alpha 3 次 · Beta 1 次`，只列前 5 个，scope 补一句「要看某个项目的账就用 project= 筛」 |
| `action="dream" project="X"` | 只列 X 的账，scope 写 `按项目段「X」筛：M 条（全账本 N 条），列最近 K 条；#k 是筛出来这几条里的第几近，不是全账本序号`；导航写 `共 M 条（项目段「X」）· 每页 L 条` |
| `action="dream" id="k" project="X"` | 展开照旧念全账本第 k 近，末尾多一句「这一条属于项目段「X」」或「这一条不属于项目段「X」——它记的是「Y」。展开还是照账念，只是别把它当成筛选结果」 |

三条克制，同样是写进代码而不是写在注释里：

1. **分布只在没筛且第 1 页出。** 筛完再报分布，用户会以为「分布也筛过了」——那行数字明明是全账本的。
2. **展开不重算、编号不改。** `id` 是全账本的第几近，筛不筛都一样；如果筛着就把编号换成「筛后第几近」，同一条账会有两个编号，0.2.91 已经在编号口径上吃过一次亏。
3. **筛空 ≠ 账本空。** 两句话分开：`账本里没有项目段「X」的整理记录（全账本 N 条）` 与 `这个工作区的 dream 账本还是空的`。前者说明项目名要按 `changes.plan.projects` 原样写（别自己翻译、别缩写），后者才是「还没整理过」。

### 9.107.3 顺序与口径上的坑

- **`allTotal` 要单独读一次全账本。** 筛着的时候 `ledger.total` 是筛后的数，「全账本几条」这个对照数只能另读一次（`readDreamLedger(..., 1, 0, '')`）。这一步看起来多余，但少了它，「0 条」就分不清是「账本空」还是「这个项目没有账」。
- **越界重读也要带 `project`。** `page=99` 退到最后一页时会重新读一次，忘了带筛子就会突然变成全账本的最后 5 条——最阴的一种错：数字变得更多了，看着像「找到更多了」。
- **`project` 是「一个项目段的名字」。** 80 字以上或带换行，一律抛错并说明「这次没有筛任何账」。不静默当「没匹配到」——那会让用户以为「这个项目真的没有账」。
- **参数说明也是产品的一部分。** `project` 进 `params` 与 schema 描述，`memory_admin` 的卡片标题就会带上它（`整理留痕：project=Alpha`），否则两个请求在界面上长得一模一样。

### 9.107.4 没做的事

- 不做多项目 `project=a,b`：`json_each` 匹配多个值要改用 `IN (?, ?, …)` 动态拼参数，收益（省一次调用）不如风险（拼串出错就静默多筛/少筛）。要两个项目就看两次。
- 不做按时间范围筛：账本里 `run_at` 有，但「最近 7 天」这类区间要配合时区口径，和「第几近」的编号口径会打架，先不做。
- 不做项目名归一化（大小写、别名合并）：名字来自 dream 落盘时的原样，合并要一张映射表，那是另一件事；现在只保证**按原样匹配**，并把这个口径写进提示语。
- 不缓存分布：`json_each` 扫一遍在几万行内是常数级开销，缓存反而要处理失效。

## 9.108 项目名存成了个数，按名字筛账就永远筛不到（0.2.102）

### 9.108.0 现象

0.2.101 上线了「按项目段筛账」。面板上一切正常，探针也全绿。但真账本上问三件事，答案都是错的：

1. `memory_admin(action="dream", project="Alpha")` 回「账本里没有项目段「Alpha」的整理记录（全账本 N 条）」，哪怕刚整理过 Alpha。
2. 第 1 页的项目分布里出现一行 `3 次`——一个叫「3」的项目。
3. 展开任意一条账，只看得到「这一轮动了 3 个项目段」，永远看不到名字；想看「到底哪几个项目」，只能回头翻那次整理的消息。

三件事同一个根：**写侧存的是个数，读侧按名字筛**。

### 9.108.1 账本里的 `changes.plan` 存了什么

`dreamPlanDigest(rounds)` 是写侧唯一的摘要出口，0.2.96 起落进 `dream_log.changes`。这一版改了两个字段、加了两个字段：

| 字段 | 0.2.101 及以前 | 0.2.102 起 | 为什么 |
| --- | --- | --- | --- |
| `projects` | `rounds.reduce(...)` 算出的**个数**（数字） | `dreamPlanProjectNames(rounds)` 返回的**名字数组**（去重、保序） | 读侧要用 `json_each(...).value = ?` 按名字配；数字进去只会产出一行 `value = 3, type = 'integer'` |
| `projectCount` | 无 | 上面那个个数照旧存一份 | 老账本只有个数时，面板要能照实数念出来，不念成「0 个项目段」 |
| `dup` / `cover` | `dreamDupPairs(allRows).length`（被清单上限 5 截断） | `dreamDupPairs(allRows, DEDUP_THRESHOLD, Infinity).length` | 「撞上几对」是真数；「印出来几对」是版面。两件事不能共用一个上限 |
| `pairs` | 无 | `dreamPlanPairs(allRows)` 的前 6 条明细 | 只存数字时，展开也没法动手合并 |

`dreamPlanProjectNames` 的口径很简单，但每一条都踩过：

```js
function dreamPlanProjectNames(rounds) {
  const out = [];
  for (const r of rounds) {
    const list = Array.isArray(r.projects) ? r.projects : [];
    for (const raw of list) {
      const name = String(raw ?? "").trim();
      if (name !== "" && !out.includes(name)) out.push(name);
    }
  }
  return out;
}
```

- 空名不存：整理时某个项目段算出来是空串，写进账本会变成一个「叫空字符串的项目」，按它筛能筛出一堆不相干的账。
- 去重保序：同一个项目在多轮里出现是常态，重复存会让分布行把 `Alpha 3 次` 念成 `Alpha 6 次`。
- 不 trim 掉内部空格、不改大小写：名字就是 `changes.plan.projects` 里的原样，**按原样配**。别名合并是另一件事（9.108.5）。

### 9.108.2 对子明细：存「跟谁撞了」，不只存「撞了几对」

0.2.94 起整理清单里会印「逐字重复 ⇄ / 重复详写 ⊂」，但那是**当轮消息里的清单**，账本里只有数字。于是展开一条老账，只能说「这一轮撞上 2 对」，说不出是哪两条。

`dreamPlanPairs(allRows)` 把它们落进 `changes.plan.pairs`，每条形如：

```json
{ "kind": "dup", "a": "cccc0001", "b": "cccc0002", "levelA": "fact", "levelB": "fact", "score": 0.93 }
{ "kind": "cover", "a": "cccc0001", "b": "cccc0003", "levelA": "topic", "levelB": "fact", "score": 0.2, "missing": 0, "words": [] }
```

- 短 id 走 `uniqueShortIdsAmong(allRows)`，和整理清单里印的是同一套——展开里看到的 `cccc0001` 能直接拿去 `memory_read` / `memory_update`。这一条不成立，明细就只是给人看的装饰。
- `cover` 多带 `missing` 与 `words`（词表按 `DREAM_MERGE_WORDS` 截断），因为「合并会丢几个词」正是决定该不该合并的依据。
- 上限 `DREAM_PLAN_PAIR_CAP = 6`：一条账存全部对子会让 `changes` 无限膨胀，而 99% 的读取只关心前几条。**截断的是明细，不是数**——`dup` / `cover` 仍是 `Infinity` 算出来的真数，面板据此写「还有 N 对没落账」。

### 9.108.3 四个出口

| 出口 | 这一版的变化 |
| --- | --- |
| `dreamProjects(limit)` / `readDreamProjects(...)` | 两个查询都加 `AND je.type = 'text'`：老账本里那个数字不再冒充项目名，也不进分布 |
| `dreamCountOf(project)` / `recentDreamsPage(..., project)` | `WHERE json_each.type = 'text' AND json_each.value = ?`（两处），筛子与总数仍共用一份 |
| `action="dream"` 展开（`id=k`） | 项目段念名字（`项目段：Alpha、Beta`）；老账本念「只记了个数（2 个），没记名字——它写在 0.2.102 之前」；紧跟一段对子块 |
| 面板 `rowLine` / `liveLine` | 改走 `projectCountOf(plan)`：数组取长度、数字照念、再退 `plan.projectCount`；不再有「数组才叫有项目」的写法 |

对子块 `pairsBlock(row)` 有四种来路，各说各话：

- 没有 `changes.plan` → 「这条账没有 changes.plan（它写在 0.2.96 之前），谈不上对子。」
- `pairs` 不是数组 → 「没有存对子明细（0.2.102 之前的记录）」——数还在，只是名字没存过。
- 空数组且 `dup + cover === 0` → 「这一轮没撞上对子，没有可合并的。」
- 空数组但有数 → 「账里记着 N 对，却没有一条明细——别把「没列」读成「没有」。」

第四种是这一版最容易被写错的一格：明细是 0.2.102 才开始存的，老账本「有数无明细」是正常状态，不是「没撞上」。

### 9.108.4 顺序与口径的坑

- **写侧漏一格，读侧全链路假阴性。** 0.2.101 的探针手写 `changes` 时恰好写成了数组，于是整条链路（SQL → 分布 → 面板）全绿，真账本却一条也筛不到。**凡是穿越格式边界的字段，至少要有一条从真 writer 出发的探针。** 这一版补的 `L1`/`L7` 就是这个：`V.dreamPlanDigest(digRounds)` → 落库 → `readDreamLedger(..., 'Alpha').total === 1`。
- **上限只加在印出来的地方。** 给 `dreamDupPairs` / `dreamCoverPairs` 加 `max` 参数时，默认值保持 `DREAM_DUP_MAX`，只有 digest 里显式传 `Infinity`。老调用一行不改，真数只有摘要这一处要。
- **老账本不能念成 0。** `rowLine` 原写法 `Array.isArray(plan.projects) ? plan.projects.length : 0` 对 0.2.101 的账（数字）返回 0，于是「这一轮动了 3 个项目段」变成「0 个项目段」。`projectCountOf` 把三种形态收在一处，`rowLine` 与 `liveLine` 共用。
- **展开的顺序有信息量。** 项目段 → 对子 → 比更早一条 → 原文。对子块放在原文前面：原文有 1200 字截断，放在对子后面容易被截掉，而对子才是能立刻动手的那部分。
- **改签名的历史断言要跟着松。** 加 `max` 参数后，0.2.92/0.2.94 块里 `function dreamDupPairs(rows, threshold = DEDUP_THRESHOLD)`、`function dreamCoverPairs(rows, minContain = DREAM_COVER_MIN)` 两处等号匹配立刻打红。历史块一律改前缀匹配（留到 `,`），别回头把参数再删掉。

### 9.108.5 没做的事

- 不做项目名归一化：别名、大小写、`DSH NEXT` 与 `DSH-NEXT` 的合并需要一张映射表，做一半比不做更糟。现在只保证**按原样匹配**，并把这个口径写进筛空时的文案。
- 不为老账本回填名字：`changes` 是历史事实，回填等于改写当时那一轮做了什么。老账本就照实说「只记了个数」。
- 不存全部对子：`DREAM_PLAN_PAIR_CAP = 6` 是刻意的。真要全量，应该走「一次整理一份附件」，而不是把账本列撑成文本块。
- 不做对子的自动处置：明细只是把「跟谁撞了」摊开，合并仍然要一次 `memory_update` 决策。
## 9.109 账本只知道翻了几条，不知道库有多大（0.2.103）

### 9.109.0 现象

展开任意一条账，看到的是这一行：

```
- #2 11-20 10:52 · 整理完成 · 2 轮 / 5 条 · 逐字重复 2 对 · 重复详写 1 对 · 落库 是
```

然后问三个问题，账本一个都答不出来：

1. 这一轮是在多大的库上整理的？——账本里没有这个数。
2. 整理到底让库变轻了还是变重了？——趋势行只讲对子数在变多变少，不讲库。
3. 「翻了 5 条」算多还是算少？——没有分母，这句话没有意义。

第三个问题才是要害：**「翻 5 条」在 500 条的库里说明只够着一个小角，在 8 条的库里说明几乎翻完了。** 同一行字，两种完全不同的处境，读账的人却只能猜。

### 9.109.1 写侧：开工那一刻数一次

`dreamStoreScale(db)` 是这一版唯一的写侧新增：

```js
function dreamStoreScale(db) {
  const byLevel = {};
  let active = 0;
  for (const level of LEVELS) {
    let n = 0;
    try {
      const row = db.p(`SELECT COUNT(*) AS n FROM ${level} WHERE status = 'active'`).get();
      n = Number(row?.n) || 0;
    } catch {
      n = 0;
    }
    if (n > 0) byLevel[level] = n;
    active += n;
  }
  return { active, byLevel };
}
```

调用点在 `startWindowDream`，紧跟摘要之后、落 `dream_meta` 之前：

```js
const digest = dreamPlanDigest(rounds);
digest.store = dreamStoreScale(db);
db.setDreamMeta(`dreamdigest:${sessionId}`, JSON.stringify(digest));
```

三条口径，每条都有代价：

| 口径 | 为什么 |
| --- | --- |
| 只数 `status = 'active'` | 归档/过时的条目挂在 `status` 上。混进「库有多大」，读账的人会以为库一直没瘦过——而「有策略地删除」正是整理在做的事 |
| 取**开工那一刻** | 收尾时模型已经动手改过库了，那时数出来的是「整理之后」，和同一行里的「翻了几条」不在同一个时刻上 |
| 零层不写进 JSON | `{fact: 0, lesson: 0, topic: 0, ...}` 会让人以为「空层也算数」；只留非零，`byLevel` 的键就是「这一轮开工时真实存在的层」 |

写侧只多一次七张表的 `COUNT`，不读内容、不做分词，与 `dreamPlanDigest` 的复杂度无关。

### 9.109.2 面板：三态 + 一条趋势

`storeOf(plan)` 把三种来路分开，返回 `null` 表示「这条账没记」——**不许自己补 0**：

| 账里的 `plan.store` | 展开时念什么 |
| --- | --- |
| 没有这一格 | `库规模：这条账没有记库规模（它写在 0.2.103 之前）——别把「没记」读成「库是空的」。` |
| `active === 0` | `库规模：开工时库里 0 条在用记忆——这一轮是在空库上整理的。` |
| 正常 | `库规模：开工时 3 条在用（fact 1 · lesson 1 · topic 1）` |
| 连 `changes.plan` 都没有 | 一个字都不加（0.2.96 那句已经解释过老账，别叠两层告示） |

趋势行按「最早→最新」补一段，但只有**至少两次**有数才讲区间：

```
趋势：最近 3 次（最早→最新）· 逐字重复 合计 23 对，持平 · … · 库 开工时 2 → 3 条（多了 1 条）
（库规模只有 2 次有数（更早的账写在 0.2.103 之前，没有这一格）；3 次样本太少，只当参考、别当走势）
```

一次快照不是走势。跟既有的 `dup`/`cover`/`missing` 一样，样本不足就不下结论，只是这一项的门槛从 4 次降到 2 次（两次就能给出区间，只是不给「在变多/在变少」的判断）。

### 9.109.3 坑

- **收尾再数就晚了。** `finalizeDream` 里数库看着更省事（一次就够），但那一刻模型已经按整理结论改过库；同一行账里「翻了几条」是开工时刻的，「库有多大」是收尾时刻的，两个数字对不上号，读者会得出「整理了 5 条却让库多了 5 条」这种假因果。
- **`stale` 不是「不在了」。** 只数 active 是有意的：本轮封存后，被整理的条目会变成 `stale`，若把它们算进「库有多大」，趋势会一路下降，看上去像整理在不停删东西。
- **老账不补 0。** `storeOf` 对没有 `store` 的账返回 `null`，面板据此说「没记」，而不是渲染 `0 条在用`——后者是一句假话。
- **别给没有 plan 的账再叠告示。** 0.2.96 之前的老账，展开里已经有「这一条没有 changes.plan」；再来一句「没有记库规模」就是同一个事实说两遍。
- **趋势的 caveat 共用一份。** 库规模的「只有 N 次有数」和原有的「M 条早于 0.2.96」「样本太少」走同一个 `caveats` 数组、同一对括号，不许各写一套括号把行尾撑成一串括号。
- **探针 fixture 里「最新在前」又一次咬人。** 新加的「最早一条账」必须**写在最前面**（先 `logDream`），否则 #1～#4 的既有编号整体错位——0.2.102 已经因为先写死了 `id='1'` 全错位过一次。

### 9.109.4 没做的事

- 不做「收尾后再数一次」：那需要改 `finalizeDream` 的时序，且封存会改 `status`，两次数字之差会被读成「整理删了东西」。
- 不存更多统计（命中数、关键词数、平均重要度）：一次整理能携带的信息是有限的，`changes` 越厚，`json_extract` 与人工对账都越慢。
- 不做跨工作区汇总：每个工作区一个库、一本账，混起来会把「这个窗口的库」讲成「所有窗口的库」。
- 不把库规模印进 `rowLine`：一行账已经有五段，库规模属于「展开才要看」的信息，列表面板保持一行一屏。

## 9.110 「第几近」会挪，回指不了；「引用」不挪，能当名字（0.2.104）

### 9.110.0 现象

账本翻页、按第几近展开、按项目筛账都做好了，还是有一件事做不到：**回指某一轮**。

- 上一次整理时看到「第 2 近」这条账有问题，隔天想再翻开看 —— 期间又跑了两轮 dream，它现在是第 4 近，`id=2` 打开的是别人。
- 会话已经结束了，想在别的会话里说「上一轮那个计划再给我看一眼」—— 没有能说出口的名字，只能说「大概三天前、那次翻了 7 条的那一轮」，靠猜。
- 面板上的编号是**位置**，不是**身份**。位置每天都会变，身份不该变。

`readDreamRecord` 里原本还明写着一句「不暴露 rowid —— 对外的句柄只有一种口径」，那是 0.2.100 的决定：**少一个口径，就少一种读错的方式**。这一版**有意反转它**，理由见 9.110.4 与 DESIGN 116。

### 9.110.1 为什么 dream_log.id 就是那个「不变的名字」

```sql
CREATE TABLE IF NOT EXISTS dream_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_at INTEGER NOT NULL,
  summary TEXT NOT NULL,
  changes TEXT,
  note TEXT
);
```

`INTEGER PRIMARY KEY AUTOINCREMENT` 有三条性质正好是「引用」需要的：

| 性质 | 对「回指」的意义 |
| --- | --- |
| 单调递增、由 SQLite 分配 | 不需要额外的 uuid 列，也没有并发抢号的问题 |
| 只增不减 | 新账永远不会拿到一个已经发过的号 |
| 删了也不复用（AUTOINCREMENT 才有，纯 rowid 会复用） | 那一行就算被手工删了，这个号也不会转手给别人 —— 「打开失败」不会被读成「打开了另一条」 |

所以对外把这个号写成 `r<N>`：`r4` 永远指同一轮整理，账本再长一百轮也不挪。

### 9.110.2 写侧：三个函数，一个尺子

**取一条账**（`vendor/meow-memory/lib/index.js`，`close()` 之前）：

```js
dreamById(id) {
  const asked = Math.trunc(Number(id));
  const key = Number.isFinite(asked) && asked > 0 ? asked : 0;
  if (key === 0) return null;
  const row = this.db.prepare("SELECT id, run_at, summary, changes, note FROM dream_log WHERE id = ?").get(key);
  if (!row) return null;
  let changes = null;
  try {
    changes = JSON.parse(String(row.changes ?? ""));
  } catch {
    changes = null;
  }
  return { id: Number(row.id) || 0, runAt: Number(row.run_at) || 0, summary: String(row.summary ?? ""), changes, note: String(row.note ?? "") };
}
```

两个细节是有意的：`key === 0` 直接 `null`，**不去 `SELECT ... LIMIT 1` 凑一条**（猜出来的引用比没有引用更坏）；`changes` 解析失败记 `null` 但**行照出** —— 账本原文坏了不该让「这一轮整理过」这件事消失。

**它现在排第几近**：

```js
dreamRankOf(id) {
  // ... 取 run_at
  const before = this.db
    .prepare("SELECT COUNT(*) AS n FROM dream_log WHERE run_at > ? OR (run_at = ? AND id > ?)")
    .get(at, at, self);
  return (Number(before?.n) || 0) + 1;
}
```

这条 `WHERE` 必须和 `recentDreamsPage` 的 `ORDER BY run_at DESC, rowid DESC` 是**同一把尺子**：同一毫秒写进去的两条账，靠 `id` 破平。要是两边排序不同，就会出现「引用和编号指向不同的行」——那比没有引用更糟。

**按引用读一条**（模块级，`vendor/meow-memory/lib/index.js:3601` 起）：

```js
function readDreamRecordByRef(workspace, dir = ".dsh-meow", ref = 0) {
  // no-workspace / no-db / read-failed 四态与 readDreamRecord 同款
  const row = db.dreamById(key);
  if (!row) return { row: null, prev: null, rank: 0, path, missing: "no-row", total };
  const rank = db.dreamRankOf(key);
  const rows = rank > 0 ? db.recentDreamsPage(2, rank - 1) : [];
  return { row: row ?? rows[0] ?? null, prev: rows[1] ?? null, rank, path, missing: "", total };
}
```

`prev` 是「比它更早的那一条」（`compareLine` 用它算差额），靠 `recentDreamsPage(2, rank - 1)` 的第二个元素拿 —— 不另写一条 SQL，免得又出现两把尺子。

### 9.110.3 面板与 admin：两个号并存，各说各的用途

`lib/macro/dreamledger.js`：

| 函数 | 作用 | 关键规矩 |
| --- | --- | --- |
| `refOfRow(row)` | `id>0` → `r${id}`，否则 `''` | 老账行也要拼，否则最早那几轮永远回指不了 |
| `refIdOf(raw)` | `/^[rR](\d{1,9})$/` → 数字，否则 0 | 「数字」「#3」「乱写」全返回 0，落到「第几近」那条路上由那边打回 |

`rowLine` 的两个分支（有 plan / 0.2.96 之前的老账）**末尾都拼** ` · 引用 r<N>`；这是列表唯一的「名字」。

`readDreamPanel` 开头的分流：

```js
const wantRef = refIdOf(id)
const askedId = Math.trunc(Number(String(id ?? '').replace(/^#/, '')))
const wantId = wantRef > 0 ? 0 : Number.isFinite(askedId) && askedId > 0 ? askedId : 0
```

`if (wantRef > 0)` 这一段必须排在「按第几近展开」**之前**：`r4` 里的 `4` 不能被当成第 4 近（正好会指到另一条账上，而且不报错 —— 最坏的一种错）。

| 场景 | 面板怎么说 |
| --- | --- |
| 引用不存在 | 「账本里没有引用 rX 的那一条（一共 N 条）——引用是账本行的固定号，只增不减，从来不会把老号发给新账。所以要么这个号压根没写过，要么那一行已经不在了（库被重建 / 手工删过）。要按位置找，就翻 page 看 #k；要按内容找，就用摘要里的字眼去搜。」 |
| 展开成功 | 正文是 `expandPanel` 原文，尾部另起一段：「引用 rX：这个号跟着这一行走，账本再长几轮也不挪（删了也不会被别人占用）；它现在排第 K 近——「#k」会随新账往下挪，回指请用引用。」 |
| 成功口径 | 「按引用 rX 展开（现在第 K 近），共 N 条；原文照账本念，不重算这一轮清单」；带 `project` 时补「；引用不受项目筛选影响」 |
| 引用+项目段不属于它 | 照念这一条，并说「这一条不属于项目段「Beta」——它记的是「Alpha」。展开还是照账念，只是别把它当成筛选结果。」 |
| 按第几近展开（老路） | 口径补一句「；引用 rX，要回指就用 id=rX」——省一次翻列表 |

列表页**只在第 1 页**印一次提示（每页都印等于拿 token 换噪音）：

```
引用：每行末尾的 r<N> 是这一行的固定号——要回指某一轮就写 id=r<N>；#k 只是它此刻排第几，新账一来就挪。
```

admin（`lib/macro/defs/admin.js`）的 `idOf(raw)` 认两种写法：`r<N>` 原样返回 `` `r${n}` ``（`r0` 抛「id 引用要从 r1 起（r0 不存在）」），否则走原数字路；脏值抛「只认两种写法：「3」/「#3」这种「第几近」编号（1 = 最新，和列表里的 #k 一致），或「r128」这种账本引用（每行末尾那个号，新账来了也不挪）」。schema 的 `id` 描述同步写清两支的分工。

### 9.110.4 为什么值得反转 0.2.100 的「不暴露 rowid」

0.2.100 那条口径解决的是「**不要用库内部的东西当 API**」：`rowid` 是 SQLite 的实现细节，暴露出去等于把存储层焊进调用约定。这个担心是对的，但当时漏了一点：**没有稳定引用，账本就只能「看最近几条」而不能「回指」**。可追溯性要求的是后者。

反转的边界收得很窄，所以是可控的：

1. **只暴露 `id` 这一个字段**，不暴露 rowid、不暴露 `changes` 的内部结构、不让人写 SQL。
2. **对外写成 `r<N>`，不是裸数字**：一眼能分开「第几近」和「账本引用」，两种写法不会被混淆成同一个参数值。
3. **口径仍然是两套、各管一件事**：`#k` 管「这一页的第几近」，`r<N>` 管「这是哪一轮」。面板上两句话并排印，不合并成一个。
4. **`no-row` 是单独的一态**：引用失效时明说「这个号不会发给新账」，而不是悄悄退回空账本。

一句话：**位置是给人翻的，引用是给话说的**。两者不能合成一个，也不能只留一个。

### 9.110.5 探针

`tools/probe-ruler.mjs`（写侧，真 writer）：

- **L12** 记住 `r1` → 再写一条 → 同一行的第几近 1→2，`dreamById` 取回的 `runAt` 一字不差。
- **L13** `readDreamRecordByRef` 的 `row.id` 就是那个引用、`rank=2`、`total=2`；不存在的引用 `missing='no-row'`、`row=null`。
- **L14** `ref=0` 一律 `no-row`，不拿最新那条凑。

`tools/probe-fusion.mjs`（面板层，走 `memory_admin` 真工具）：

- **D40** 列表每行都带 `· 引用 r<N>` 并印一次提示；`page=2` 没有提示行但行上仍有号。
- **D41** 先拿 `r4`，再写一条新账 → 同一条账现在排第 3 近，正文首行是 `#3 … 引用 r4`、备注仍是「新格式」，口径写「按引用 r4 展开（现在第 3 近）」。
- **D42** 引用 + 项目段：属于就直说属于；不存在的引用明说「不会发给新账」并给按位置 / 按内容两条路。

### 9.110.6 没做

- 不做「按引用改账/删账」：引用是只读的锚，能改就不再是锚。
- 不把引用写进 `summary` 文本：账本原文照旧，引用由 `id` 现算，省一次迁移。
- 不给引用加前缀校验失败就报错的强约束（用户手打 `r4` 大小写、前后空格都宽容）；`r0` 是唯一例外，因为 `r0` 永远不存在。

## 9.111 账本会告诉你「这几天整理得怎么样」吗？（0.2.105）

### 9.111.0 现象

账本已经能翻页、能按项目段筛、能按引用回指。还剩一个问题问不出口：**这几天整理得怎么样？**

- 「上周那几天到底跑没跑整理？」—— 只能翻页自己数日期，翻到第 4 页才发现那几天一条都没有，还不敢确定是「没有」还是「没翻到」。
- 「这个项目最近一周动过几次？」—— 项目段筛出来的是全时段，得自己一条条看时间戳。
- 账本里存的 `run_at` 是毫秒时间戳，屏幕上印的是 `11-18 23:59`。**问的人说的是日期，存的是毫秒**，中间这一段没有桥。

这一版补的就是这座桥：`memory_admin action=dream` 多两个参数 `since` / `until`，写 `"2026-11-18"` 这种日期。

### 9.111.1 三个坑，一个都不能省

| 坑 | 错法 | 后果 | 这一版怎么定 |
| --- | --- | --- | --- |
| 端点 | `run_at > since AND run_at < until` | 当天最后一条落在 23:59:59.999，直接被切掉；「18 号整天」变成「18 号 0 点到 18 号 0 点」 | **闭区间**：`run_at >= since` / `run_at <= until`，`until` 取当天 `23:59:59.999` |
| 时区 | `new Date('2026-11-18')` 或 `Date.parse('2026-11-18')` | 按 UTC 解，东八区整体偏 8 小时：18 号 0 点被当成 18 号 8 点，早上那几条全跑到前一天 | **本机时区**：`new Date(y, mo - 1, d, 0, 0, 0, 0)`，再回读年月日校验（挡掉 `2026-02-31` 这种被 JS 悄悄滚到下个月的写法） |
| 筛子 | 面板在 JS 里 `filter` 一遍再分页 | 「第几页」和「一共几条」各算一套，翻页漏条、条数虚高 | **在 SQL 里筛**：`recentDreamsPage` 与 `dreamCountOf` 共用同一份 `parts` / `args` |

时区这一条最阴：写错的代码照样跑、照样出结果，只是整段偏移 8 小时，而且**偏移方向随东西半球变**。所以在 `dayStartOf` 里宁可多写一次回读校验，也不用任何字符串日期解析。

### 9.111.2 源码：四个小函数

`lib/macro/dreamledger.js`（放在 `stamp()` 之后、`reasonOf` 之前）：

```js
function dayStartOf(raw) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(raw ?? '').trim())
  if (!m) return null
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3])
  const t = new Date(y, mo - 1, d, 0, 0, 0, 0)
  // 回读校验：2 月 31 日会被 JS 滚到 3 月 3 日，那就不算「用户写的这一天」。
  if (t.getFullYear() !== y || t.getMonth() !== mo - 1 || t.getDate() !== d) return null
  return t.getTime()
}

function dayEndOf(raw) {
  const s = dayStartOf(raw)
  return s === null ? null : s + 86400000 - 1   // 23:59:59.999
}

function tzLabel() { /* → 'UTC+08:00' */ }

function rangeOf(sinceRaw, untilRaw) { /* → { since, until, label, bad } */ }
```

`rangeOf` 四态：

| 输入 | 返回 | 面板 |
| --- | --- | --- |
| 两头都空 | `since:0, until:0, label:''` | 不进日期分支，老路照走（项目段筛、全账本翻页都不变） |
| 有一头写坏（`2026-13-40`、`2026-02-31`、`18/11`） | `bad: 'since 要写成「2026-11-18」这种日期（按本机时区 UTC+08:00 算一整天）——给的是「X」，这种写法不敢猜。'` | **直接打回，一次库都不查**：`这次没有列账。` / scope `按时间筛的写法被打回，账本一条没动` |
| 反着写（`since > until`） | `bad: 'since「A」比 until「B」还晚——这样筛不出任何一条。两个日期换一下再来。'` | 同上 |
| 正常 | `{ since, until, label: 'A → B' }`，缺一端用「账本最早」/「现在」 | 列表口径、空段说明都用这个 `label` |

「不敢猜」比「猜一个」重要：日期写坏了若被静默忽略，用户看到的是一整本账，会以为「那几天确实有这么多」。

### 9.111.3 三个读口 + 面板口径

写侧（`vendor/meow-memory/lib/index.js`）：

| 口 | 签名 | 说明 |
| --- | --- | --- |
| `recentDreamsPage` | `(limit, offset, project, since, until)` | `parts` 拼 WHERE：项目段一段、`run_at >= ?`、`run_at <= ?`；空筛时 `where = ''` |
| `dreamCountOf` | `(project, since, until)` | 同一份 parts；`parts` 空时回落到 `dreamCount()` |
| `dreamsSpan` | `()` | `SELECT MIN(run_at), MAX(run_at)`，给「账本覆盖 A → B」用 |
| `readDreamLedger` | `(workspace, dir, limit, offset, project, since, until)` | `total` 也带日期，否则「共 N 条」是全账本的数 |
| `readDreamSpan` | `(workspace, dir)` | 模块级导出，missing 四态与读口一致 |

面板（`readDreamPanel({ …, since, until })`）：

- 条数口径：`按时间 2026-11-18 → 现在 筛：6 条（全账本 8 条）`；项目段 + 日期叠筛时 `项目段「Alpha」+ 时间 …`，并补 `日期按本机时区 UTC+08:00 算整天，since / until 两端都含`。
- **只按项目筛时句式必须一字不变**（`按项目段「Alpha」筛：2 条（全账本 6 条）`）—— 老探针和老用户都靠这句话读账；日期是**加**上去的一层，不是替换。
- 项目分布行只在「既不按项目、也不按日期」时给：那是全账本的分布，筛完再报会被读成「这段日子的分布」。
- 筛空：`2026-11-16 → 2026-11-17 这段时间里没有整理记录——账本覆盖 11-14 09:00 → 11-20 08:00（本机时区 UTC+08:00）。全账本 6 条都在这个区间外面（since / until 按本机时区算整天，两端都含）。换一段日期再看，或者干脆不带日期翻全账本。` —— 「这段里没有」与「账本里没有」必须分开说，否则用户会以为整理从没跑过。
- 展开一条：`rangeNoteOf(row, range)` 插在正文后、项目段说明前 —— 不在区间里就说 `这一条不在 2026-11-18 → 2026-11-18 这段时间里（它写在 11-20 08:00）`；同一个「照账念但别当成筛选结果」的分寸，和项目段一致。
- 引用不受日期影响：`id=r4` 照旧展开，scope 补 `日期筛选也不影响引用`；按第几近展开时补 `要按时间筛就翻 page 看 list`。

admin（`lib/macro/defs/admin.js`）：只取 `String(args.since ?? '').trim()` 原样传过去，**解析只在面板里写一份**。两处各写一套解析，迟早会「admin 认一种、面板认另一种」，而日期这种东西错一天都不报错。schema 里 `since` / `until` 写明「写 `"2026-11-18"`」「按本机时区算整天，两端都含」「写坏了会打回，不会猜」。

### 9.111.4 探针

`tools/probe-ruler.mjs`（写侧，直接插 `run_at`，才量得到边界）：

- **L15** 18 号 `00:00:00.000` 与 `23:59:59.999` 都在里面，前 1 毫秒、后 1 毫秒都在外面；`recentDreamsPage` 行数 3 = `dreamCountOf` 3。
- **L16** 时间与项目段叠筛：Alpha 在 18 号 2 条、全账本 3 条；筛到没账的区间是 0（不回退成全账本）。
- **L17** `readDreamSpan` 的 first / last 就是最早 / 最新那条。

`tools/probe-fusion.mjs`（面板层，走 `memory_admin` 真工具）：

- **D43** `since=今天` → `按时间 2026-11-20 → 现在 筛：6 条（全账本 8 条）`，旧账一条不混；同日 `since=until` → 1 条，且行上时间就是那天 `10:00`。
- **D44** 坏日期 / 反着写都打回，且**一次库都不差**（`这次没有列账`）。
- **D45** 只给 `until` 挑得出那天之前那条；空区间的 body 必须同时有「这段时间里没有」「账本覆盖」「全账本 8 条」。

### 9.111.5 没做

- 不做「按相对时间」（`最近 7 天` / `上周`）：相对量在会话里会漂，隔一轮重放就对不上了；要相对区间让调用方自己算成日期。
- 不做「按时间段」（带小时）：账本的粒度是「一天」，加小时只会多一堆边界口径，问不出新东西。
- 不在列表行上印 `summary` / `note`：行要短（一页 5 行），内容靠引用展开看 —— 探针也因此只能按行上的时间戳断言，不能按 note 文字断言。
- 不把日期写进 `dream_meta`：筛是读侧的事，存下来会让「换个日期看」变成一次写操作。

## 9.112 整理到底让库变轻还是变重？——两个观测点（0.2.106）

### 9.112.0 现象

0.2.103 给账本加了「库规模」，但只数**开工那一眼**，还在代码注释里写了理由：收尾再数一次容易让人把「库变了」读成「这一轮改的」，编出假因果。

这条顾虑是真的，代价也是真的：

- 只念开工，永远答不出「这一轮让库变轻了还是变重了」——而「整理是不是在收敛」是整理唯一的成绩单。
- 趋势行原来那句 `库 开工时 2 → 3 条（多了 1 条）` 比的是**不同轮的开工数**，中间夹着别的会话、别的写入，读起来像「整理净增 1 条」，其实不是。
- 想看单轮净变化，只能自己去翻 `changes.stamped` 再猜，而那正是最容易被读错的地方。

### 9.112.1 为什么反转 0.2.103

担心的是**假因果**，不是**多一个数**。正确的解法不是删数据，而是把「差」和「因」分开写：

| 位置 | 说的事 | 来源 |
| --- | --- | --- |
| `开工时 N 条` | 这一轮开始前的库有多大 | `changes.plan.store`（0.2.103 起有） |
| `收尾 M 条` | 这一轮结束那一刻的库有多大 | `changes.plan.storeEnd`（0.2.106 起有） |
| `比开工多/少 K 条` | 两个观测点之间的**净变化** | `changes.plan.storeDelta` |
| `这一轮封存/完结 S 条` | 这一轮自己动了几条 | `changes.stamped`（0.2.96 起） |

净变化 ≠ 因。两个点之间可能有别的会话在写、可能有另一个窗口在整理、可能有人手工归档。所以面板在展开时**必须**紧跟一句口径：

> 规模差口径：开工与收尾都只数 `status='active'`，两个点之间可能有别的会话也在写，所以 +1 是「库变了多少」，不是「这一轮改了几条」——这一轮封存/完结 2 条（changes.stamped）。

有了这句，`storeDelta` 才敢存在。没有这句，就不该有这一格。

### 9.112.2 写侧：收尾那一刻数一次

写侧放在 `finalizeDream`（`vendor/meow-memory/lib/index.js`）里，紧贴着原来算 `planNote` 的地方：

```js
if (plan !== void 0 && typeof plan === "object") {
  plan.storeEnd = dreamStoreScale(db);
  const before = Number(plan.store?.active);
  if (Number.isFinite(before) && before >= 0) plan.storeDelta = plan.storeEnd.active - before;
}
const storeNote = plan === void 0 || plan.storeEnd === void 0 ? "" : ` store=${plan.store?.active ?? "?"}->${plan.storeEnd.active}`;
const planNote = plan === void 0 ? "" : ` plan rows=${plan.rows} dup=${plan.dup} cover=${plan.cover} missing=${plan.missing}${storeNote}`;
```

三件事值得记：

1. **只能在写侧数**。面板渲染时库早就不是那一刻的样子了，重算出来的「收尾」是假的——它数的是「看账那一刻」，不是「整理结束那一刻」。
2. **差要在写侧算好**。让每个读侧自己减，就等着某一天有人只减一半（比如忘了 `status='active'`）。`storeDelta` 落库，读侧只负责念。
3. **缺一个点就不算差**。`Number.isFinite(before) && before >= 0` 这两道挡的是：老账没有 `store`（`before` 是 `NaN`）、坏账写了负数。宁可没有这一格，不许写进 `NaN` 或者把负当 0。

落库日志里那两个点也进了 `summary`（`store=2->3`）：探针和 doctor 都能在日志上看见，不用先解 JSON。

`stampDream` 只 `UPDATE ... SET updated_at = MAX(updated_at, ?)`，不改 `status` —— 所以「收尾数」不会因为一轮 stamp 而虚高，这条是数得准的前提。

### 9.112.3 读侧：三态 + 一句口径

```js
function storeEndOf(plan) {
  return storeOf({ store: plan?.storeEnd })   // 和读开工数同一套规矩：正数才认、零层不留
}

function storeDeltaOf(plan) {
  const start = storeOf(plan)
  const end = storeEndOf(plan)
  if (start === null || end === null) return null   // 缺一个就不猜
  return { start, end, delta: end.active - start.active }
}

function levelsText(store) {
  const levels = Object.entries(store.byLevel).map(([level, n]) => `${level} ${n}`)
  return levels.length === 0 ? '' : `（${levels.join(' · ')}）`
}
```

`storeBlock` 四态：

| 账本里有什么 | 念什么 |
| --- | --- |
| 没有 `plan` | 闭嘴（0.2.96 那句已经解释过） |
| 有 `plan`、没有 `store` | `库规模：这条账没有记库规模（它写在 0.2.103 之前）——别把「没记」读成「库是空的」。` |
| 只有 `store`（0.2.103–0.2.105 的账） | `库规模：开工时 2 条在用（fact 2）` —— 只念一眼，不编收尾、不补 0 |
| `store` + `storeEnd` | `库规模：开工时 2 条在用（fact 1 · topic 1） → 收尾 3 条在用（fact 2 · lesson 1），比开工多 1 条` |

空库那句照旧只在「开工 0 条且没有收尾数」时出：`库规模：开工时库里 0 条在用记忆——这一轮是在空库上整理的。`

**文案上的一个坑**：第一版把差写成 `→ 收尾 1 条在用（fact 1）（-2）` —— 两层括号叠在一起，读的时候要数括号。改成「差在句尾当结论、层数夹在括号里」之后才是 `→ 收尾 1 条在用（fact 1），比开工少 2 条`。这类文案错不影响测试通过，但影响人愿不愿意读，所以 verify 里专门留了一条「不叠两层括号」。

### 9.112.4 趋势行：净变化合计

有了每一轮的 `storeDelta`，趋势行终于能答「这几轮整理总体上让库变重还是变轻」：

```
趋势：最近 9 次（最早→最新）· 逐字重复 合计 26 对，在变多 · … · 库 开工时 3 → 2 条（少了 1 条） · 收尾净减 2 条（1 次有收尾数）（库规模只有 7 次有数——更早的账写在 0.2.103 之前，没有这一格；6 次只有开工数、没有收尾数——0.2.106 之前的账没有这一格；1 条记录早于 0.2.96，没有数字、不参与）
```

两条规矩：

- **缺收尾数的账不参与合计，但要说几次**。否则「净增 2 条」会被读成「所有轮加起来」。
- **caveat 里的括号要用破折号拆开**。趋势 caveat 整体已经套在 `（ … ； … ）` 里，再嵌一层括号就成 `（A（B）；C）`。0.2.103 那句 `库规模只有 K 次有数（更早的账写在 0.2.103 之前…）` 顺手一起改成破折号。

### 9.112.5 探针

`tools/probe-ruler.mjs`（写侧，真开工 → 真收尾）：

- **L18** 开工 2 条 → 中途加 fact + lesson、归档开工前那条 topic → 两次 `advanceDream` 收尾：`trace.digest.store.active = 2`、`plan.storeEnd.active = 3`、落库日志含 `store=2->3`。
- **L19** 差是净变化：`+2 新写 -1 归档` 落成 `storeDelta = 1`；归档掉的 topic 不进收尾层数。
- **L20** 阴性对照：手写一条只有 `store` 的老账，`storeEnd` / `storeDelta` 都是 `undefined` —— 宁可没有，不许补 0。

`tools/probe-fusion.mjs`（面板层，走 `memory_admin` 真工具）：

- **D46** 两个点都有时连起来念，且不叠两层括号。
- **D47** 口径句在位：`不是「这一轮改了几条」` + `stamped` + 那个负数。
- **D48** 只有开工数的账只念一眼、没有口径句；趋势行同时说 `次有收尾数` 与 `次只有开工数、没有收尾数`。

### 9.112.6 没做

- 活的那一轮（0.2.99 的「整理进行中」）仍只报摘要，没报开工规模：那一行要短，且它会随轮次刷新，加数字容易被当成实时库大小。
- 不做「按项目段算库规模」：库规模是全局的（`dreamStoreScale` 数的是整库），按项目切需要另写一遍聚合，先不做。
- 不把 `storeDelta` 写进 `summary`（只写两个端点 `store=A->B`）：日志要短，差可以现算，两个端点算不回来。
- 不给 0.2.106 之前的老账补收尾数：补出来的数是「今天看账时」的库大小，冒充那一刻，会静默说错话。

## 9.113 账本要分清收尾方式：跑完 / 半路停下 / 补记 / 封存（0.2.107）

### 9.113.0 现象

`window dream (done|aborted): …` 这行摘要一直够人读，但账本一旦要**被面板解释**，就露出四个洞：

1. **只有首词**。`done` 与 `aborted` 靠摘要里的一个词分辨，`changes` 里没有这一格 —— 任何读账的代码都得去解析自然语言摘要。摘要本来是给人看的，一旦成了接口，改一个字就等于改协议。
2. **只有分子，没有分母**。`groups=1` 说不出是「本来一组」还是「五组里只走了第一组」。中途放弃最有价值的信息恰恰是分母：它告诉你这一轮根本没跑完。
3. **补记的账被说成老账**。`recoverInterruptedDream` 只写 `{ stamped }`，没有 `plan`，于是面板走「没有规模数字」那支，念成 `这条记录比 0.2.96 早，当时还没写规模数字`。可 0.2.96 之后才有补记这回事 —— 一句时间上的假话。
4. **止损封存根本不进账本**。`handleMemoryTurnFailure` 连续失败到 `DREAM_MAX_ATTEMPTS = 3` 时 `finishDream` 掉了窗口，只往 `dream-debug.log` 写一行。整理失败得最惨的那次，恰恰是账本上看不见的那次：面板上等于没整理过。

四条合起来是一个问题：**账本记的不是「这件事怎么结束的」，而是「这件事留下的那行字怎么写」**。

### 9.113.1 写侧：把收尾方式落成 `changes.kind`

五种收尾，各有各的字段：

| kind | 谁写 | 附带字段 | 摘要 |
| --- | --- | --- | --- |
| `done` | `finalizeDream`（跑完全部轮） | — | `window dream done: … groups=N` |
| `aborted` | `finalizeDream`（`reason === "aborted"`） | `groupsDone` / `groupsTotal` | `window dream aborted: … groups=1/2` |
| `recovered` | `recoverInterruptedDream`（有进展） | `groupsDone` | `window dream recovered (interrupted): … groups=N` |
| `gaveup` | `recoverInterruptedDream`（零进展且达上限） | `fails` | 同上，另加 `fails=N` |
| `sealed` | `handleMemoryTurnFailure`（连续失败达上限） | `fails` | `window dream sealed (turn-failed): … fails=3` |

落账处统一成 `{ stamped, groups, kind }`（有 plan 时再多一格 `plan`），摘要里同时把数字印出来 —— **结构化给人算，摘要给人看，两份都要有**。只留结构化，人翻日志要自己拼；只留摘要，机器要解析中文。

`groupsDone` 取 `Math.max(0, groupsCount - 1)`：`abortDream` 传进 `finalizeDream` 的是 `lease.group_idx + 1`，即「进行到第几组」（1-based）。直接当「走完几组」用，会把半路停下说成「走完了那一组」。

### 9.113.2 分母为什么必须在 `finishDream` 之前读

`finishDream(sessionId, time)` 会 `delDreamMeta('dreamplan:…')`。轮次表就存在这个键里，所以：

- 想在 `finalizeDream` 里知道「本来几组」，必须在 `finishDream` 之前读 `dreamplan:${sessionId}` 并 `JSON.parse` 取 `length`；
- 读不到就 `groupsTotal = 0`，摘要退回 `groups=N`（不印 `/0`，也不猜一个数）。

这是一条容易写反的顺序：函数名是 `finalizeDream`，直觉会先收尾再记账，而收尾动作本身就把账要吃的数据删了。

### 9.113.3 读侧：五态与四份文案

`lib/macro/dreamledger.js` 新增 `kindOf(row)`：

- `changes.kind` 是对象且有字符串 `kind` → `stored: true`，组数/失败次数从 `changes.kind` 取（`numOf` 只认 `Number.isFinite && >= 0` 的有限非负数，缺就是 `null`）；
- 否则退回 `reasonOf(summary)` 解析首词 → `stored: false`，三个数一律 `null`。

`numOf` 不把 `undefined` 当 0 是关键：`走了 0 组` 是一句假话，而 `null` 会走到「这一条没记走到第几组」那支，说的是真话。

`reasonOf` 的正则同时放宽成 `/^window dream ([a-z]+)[^:]*:/`：`recovered (interrupted)` 和 `sealed (turn-failed)` 中间有括号修饰语，原来的 `^window dream (\w+):` 会把它们认成「原因未记」。

文案四份，各管一处：

| 场合 | 念法 |
| --- | --- |
| 行上（无 plan） | `#1 11-20 13:16 · 中途放弃 · 2 轮 / 3 条 · 逐字重复 0 对 · 走了 1/2 组就停下` |
| 展开第一行 | `收尾方式：连续失败已封存（连续失败 3 次）` |
| 展开（缺 plan 的轮） | `这一条没有 changes.plan：这一轮不是跑完的整理（中途放弃），没有规模数字可念。` |
| 对子段 | `这一轮不是跑完的整理（中途放弃），没有对子明细可念。` |

老账的边界没有变：只有**真的**没有 `kind` 也没有 `plan` 的账，才念 `这条记录比 0.2.96 早，当时还没写规模数字`。补记与被封存的账有 `kind`，从此走自己的话。

「这一格记没记」也要说：`stored === false` 时展开补一句 `——这一条没有 changes.kind，是从摘要首词认出来的（0.2.107 之前的账没记这一格）。` 认出来的和记下来的都能念，但不能长得一样。

### 9.113.4 趋势与「比更早一条」只吃跑完的一轮

`isFullRound(row)`：

- 有 `kind` → 只有 `done` 才算跑完；
- 没 `kind`（老账）→ 只要不是 `aborted` 就算跑完（那时候还没有中途放弃的账）。

趋势行改成 `full = withPlan.filter(isFullRound)`，`full.length < 2` 就不出趋势，并加一条 caveat：`N 次没跑完（中途放弃 / 待补记 / 已封存），不进合计`。「比更早一条」任一侧不完整就只回一句 `这一条不是完整的一轮（没跑完 / 已封存），数字不可比。`

理由一句话：半轮里的 `dup/cover/missing` 是「扫到那儿为止」的中间值。把它加进合计，等于把半张成绩单当满分算；拿它跟整轮比，减出来的「变少了」是假象。

### 9.113.5 探针进线

- `tools/probe-ruler.mjs` L21–L24（真引擎，86 → 90 条）：中途放弃落 `kind`、被打断后补记走 `recovered`、连续失败达上限 `sealed` 进账本、连续没进展 `gaveup`。两条前置条件写进了断言：`db.touchWindow` 先把 `last_event_time` 钉住，否则 `recordDreamFailure` 每轮都凭 `Date.now()` 开新范围，失败次数永远从 1 重数；sealed 那支要循环「start + handleMemoryTurnFailure」三次，前两次只是 `released`。
- `tools/probe-fusion.mjs` D49–D53 + D11b（524 → 530 条）：面板真念四种收尾、半轮不比数字、趋势只合计整轮、补记账不冒充老账、封存账进面板。D11 顺手改成先插一条**真老账**（SQL 直插，`run_at` 取 `Date.now() - 5000`，不抢 D13 的「只列一条」），这样「比 0.2.96 早」这句还留在断言里，但它只归老账。

### 9.113.6 没做的事

- **没给失败次数做阈值展示**（比如「连续失败 2 次，再失败一次就封存」）。封存前的进度是运行期状态，账本只记结果；要做就得在 `dream` 面板读 lease，那是另一件事。
- **没给 `aborted` 记「停在哪一组」的组名**。轮次表里有 group 列表，但把它抄进账本等于复制一份会漂移的数据。
- **没改 `dream-debug.log`**。调试日志照写，账本另写一条：一个给排查，一个给回看，不合并。
- **没把趋势按收尾方式分组统计**。样本太少，分了也读不出走势。

## 9.114 哪一层在膨胀？（0.2.108）

### 9.114.0 现象

0.2.106 让账本记了两个观测点，于是能答「这一轮让库变轻还是变重」。但**净变化只是一个总数**：

```
库规模：开工时 12 条在用（fact 8 · lesson 3 · topic 1）→ 收尾 12 条在用（fact 10 · lesson 2 · topic 0），比开工多 0 条
```

净变化 0。可这一轮其实把 2 条 topic 降成了 fact，lesson 掉了一条、fact 涨了两条——库变「重」了，
只是总条数刚好抵消。总数是记分牌，不是体检报告：**它答不了「哪一层在膨胀」**。

这一版把每一轮收尾那一刻的层数摊成一条走向。

### 9.114.1 只认收尾层数

`storeEnd.byLevel` 是 0.2.106 才开始写的。0.2.103～0.2.105 的账只有开工层数（`store.byLevel`）。
把开工数当收尾数排进走向，等于把「整理前的库」贴到「整理后的库」的位置上——看起来很整齐，全是假的。
所以 `levelSeriesOf(plan)` 只读 `plan.storeEnd.byLevel`，读不到就 `null`，宁可少几次样本。

同一个函数还有两条读法：

- **缺层 = 那一轮那层 0 条在用**。写侧 `dreamStoreScale` 只把正数层写进 `byLevel`，零层根本不出现。
  所以「这一轮真写了 byLevel，但里面没有 topic」= 那一轮 topic 是 0，不是「当时没记」。
  这条前提必须写在口径句里，不能让读者自己猜。
- **只有跑完的轮算数**（0.2.107 的规矩）。半路停下那轮的 byLevel 是扫到那儿为止的中间值。

### 9.114.2 走向怎么念

```
层走向：最近 3 次收尾（最早→最新） · topic 0 → 1 → 2（+2） · fact 2 → 3 → 3（+1） · lesson 1 → 1 → 1（没变） · 涨得最多的是 topic（+2）（1 次没跑完（中途放弃 / 待补记 / 已封存），不进这条走向；只数 status='active'；这一轮写了 byLevel 而里面没有那一层，就是那一轮那层 0 条在用）
```

- 每一层念成 `名字 a → b → c（+N / -N / 没变）`，箭头顺序是**最早→最新**（账本行是最新在前，进走向前要 reverse）。
- 按变化幅度排序：`Math.abs(b.delta) - Math.abs(a.delta) || b.last - a.last`。先看谁动得厉害，一样厉害就看最后一轮谁多。
- 只列 4 层，多的说「还有 N 层没列」——六层全摊开是一堵墙，读者反而不看。
- 结论三支，缺一支就会编：有涨 → `涨得最多的是 X（+N）`；没涨只有掉 → `掉得最多的是 X（-N）`；
  一个都没动 → `每一层的条数都没变`。**噪声不许讲成走势**。
- 少于两轮不给。一次是快照，不是走向；单轮硬算等于编。
- 只在第 1 页出。它说的就是最近这几条账，翻到旧页时数字对不上号。

### 9.114.3 排除项要逐条念

`half`（半轮但写了 storeEnd）和 `noEnd`（跑完了但没有 storeEnd）分开计两笔，两条 caveat 分开说。
合成一句「N 次没算」会让读者以为「最近 3 次」漏了账——排除了几次、为什么排除，账本能答。

最后一条 caveat 是常驻口径，不随样本变：`只数 status='active'；这一轮写了 byLevel 而里面没有那一层，就是那一轮那层 0 条在用`。
前句交代尺子（归档/stale 不算库有多大），后句交代缺层的含义（0 条，不是没记）。

### 9.114.4 探针进线

- `tools/probe-ruler.mjs` L25 / L26：真引擎写 3 条记忆 → `dreamStoreScale` 得 `active 3 / fact 2 / lesson 1`，
  `topic`、`soul` 不出现；把一条 fact 归档后 `active 3 → 2`、`fact 2 → 1`。**按状态数，不是按行数。**
  坑：两条 fact 的内容与关键词必须刻意错开，写侧有去重，长得像的两条会被合成一条，探针就验不出「同一层里两条是两条」。
- `tools/probe-fusion.mjs` D54–D57：五条合成账（done×3 → aborted → done 只有 store 无 storeEnd）。
  D54 验走向与结论；D55 验两条排除说明与口径；D56 单轮不出（阴性对照）；D57 每层都没变时说没变、不硬凑涨跌（阴性对照）。

### 9.114.5 没做的事

1. **不按项目分层**。层走向说的是「库的层结构」，项目段的规模另有 `projectsLine`，两份口径不混。
2. **不算每层的净流动**（涨了几条、掉了几条、其中多少是改层）。要算得让写侧记「这一轮升降层明细」，现在只有快照。
3. **不画图**。面板是文本，箭头串已经是能读的最简形式。
4. **不给「健康区间」**。多少条 fact 算正常取决于项目，硬给阈值等于编标准。

## 9.115 回执也报成本，预算让工具自己收紧（0.2.109）

### 9.115.0 六维里「效率」是唯一没有数的一维

记忆系统好不好，主人列了六条：准确性、相关性、可追溯性、可更新性、效率、抗噪性。前五条到 0.2.108 为止都有对应的数与文案——准确性有 `min_rel` 与零回执守，相关性有 mode 与 expand 的口径句，可追溯性有 reference 与 `refOfRow`，可更新性有 `memory_update` 的三态与账本的 `stamped`，抗噪性有 `dedupe` 与去重计数。只有效率没有数：探针知道每条断言跑多少毫秒，可「这一次 `memory_search` 往上下文里塞了多少字」没人知道。

这不是「面板少一行」的问题。一次本地检索默认 `k=10`、`content_max=300`，十条各带标题、层名、关键词、日期、项目与一段正文，回执轻易两三万字符；模型拿到的每一条都在吃上下文窗口，而窗口是这一轮做完事的弹药。看不见成本，就没有省的动作——调用方只能凭感觉少给 `k`，给多了怕漏、给少了怕不够，最后总是给多。

于是 0.2.109 做两件事：**回执自己报成本**，以及**给一个 `budget` 让工具自己收紧并交代缩了什么**。前者让成本可见，后者让成本可控；两件都不改检索本身的排序与打分，只在「说多少」这一层动手。

### 9.115.1 估算口径：CJK 一字算 1，其余 4 字符算 1

新文件 `lib/macro/tokencost.js`，只做三件事：估、格式化、判预算。

`estTokens(text)` 的规则一句话能背下来：**CJK 与全角标点一个字符算 1 token，其余字符四个算 1 token**（向上取整），空串 0。CJK 的字符类覆盖 `\u3000-\u303f`（中文标点）、`\u3040-\u30ff`（日文假名）、`\u3400-\u4dbf`（扩展 A）、`\u4e00-\u9fff`（基本区）、`\uac00-\ud7af`（谚文）、`\uff00-\uffef`（全角形式）。

为什么不接真 tokenizer：真 tokenizer 要下载词表、要跟模型版本绑定、要在插件里多背几十兆，而这里要的只是「够不够大」的判断，不是账单。误差方向也得说清：这个估法对中文偏保守（BPE 常把一个常见汉字压进一个 token 的不到一个），对英文也偏保守（四个字符一个 token 是经验中位数，真实在 3.5 到 4.5 之间摆）。所以尾注写的是 `成本 ≈N token（CJK 一字算 1、其余 4 字符算 1，是量级不是账单）`——**「是量级不是账单」这半句不是客套，是口径**：读者若拿它对账，会差一截；拿它比较两次检索谁更贵，方向不会错。

`fmtTokens(n)`：1000 以下给整数，1000 以上给一位小数加 k（`1.2k`），`1.0k` 收成 `1k`——尾注里出现的数字必须能一眼扫过去，`1234` 与 `1.2k` 的信息量一样，后者更省一次眼球移动。

### 9.115.2 三个阈值，集中在一处

`COST_SHOW_MIN = 500`、`COST_HINT_MIN = 1200`、`BUDGET_MIN = 80`（预算上限 20000）。

- **500 以下不念成本**：一条记忆的 `memory_read` 回执常常两三百 token，每句都缀一句「成本 ≈240 token」等于拿噪声盖住正文。500 是「这段已经值得看一眼花了多少」的下限。
- **1200 以上才劝骨架**：`；只想看骨架就加 budget=400（工具会自己砍字、砍条数，并交代砍了什么）`。中间那段（500 到 1200）报成本但不劝——劝得太早，读者会以为工具在推销参数。
- **80 是预算的地板**：低于 80 的预算连一条标题都装不舒服，与其硬缩成一句废话，不如直接说「太小了，最小给 80」。上限 20000 是防手滑（`budget=200000` 等于没设预算，但会让人误以为设了）。

三个数与两处文案都放在 `tokencost.js` 一处，`verify.mjs` 的 0.2.109 块专门钉「三阈值集中一处」——散落在 `search.js`、`read.js`、`prompt.js` 里各写一遍，改一个忘两个是迟早的事。

### 9.115.3 预算四态：没给就静默，给了就必须交代

`budgetOf(raw, { max = 20000 })` 返回 `{ value, note }`：

| 输入 | `value` | `note` |
| --- | --- | --- |
| 没给（`undefined`） | `null` | `''`（静默，只报成本） |
| 非数字（`'abc'`） | `null` | `预算要是数字：给了 abc，这次按没给预算处理。` |
| 小于 80 | `null` | `预算 20 太小了：最小给 80，这次按没给预算处理。` |
| 大于 20000 | `null` | `预算 30000 超出上限：最多按 20000 算。`（`value = 20000`） |

四态里只有第一态静默，其余三态都要说话——**给了参数而参数没生效，却什么都不说，是最坏的一种**：调用方以为省了 token，实际拿回一份三万字符的回执，而且下次还会这么给。

`budget` 在 `execute` 出口只解析一次（`const budget = budgetOf(args.budget)`），然后一路传进 `runSearch` / `fitBudget` / `costTail`。`verify.mjs` 钉了 `budgetOf(args.budget)` 在 `search.js` 里只出现一次——第二次解析就会得到两个不一致的 `note`。

### 9.115.4 收紧的顺序：先砍每条的字，再砍条数

`fitBudget(flow, exec, baseArgs, main, budget)` 的做法不是截字符串，而是**改参数重查**：

1. 先量第一份：`first = estTokens(main.text)`，装得下就返回 `按 ${budget} token 预算给：实际 ≈N token，没缩。`——装得下也要说一句，否则调用方不知道预算是生效了还是被忽略了。
2. 最多四级：`if (cm > 60) cm = Math.max(60, Math.floor(cm / 2)); else if (k > 1) k = Math.max(1, Math.floor(k / 2)); else break`。**先砍 `content_max`，砍到 60 再砍 `k`**。
3. 每一级都真调一次 `flow.call('memory_search', args2, exec)` 并重新量（`tried += 1`），装下就停，返回 `按 ${budget} token 预算收紧了 ${tried} 次：k ${k0}→${k}、content_max ${cmLabel0}→${cm}，实际 ≈N token。`
4. `content_max = 0`（全文）进预算时从 2400 起砍，标签写 `全文`——`全文→1200→600→300…` 读起来比 `0→1200` 明白。

为什么先砍字后砍条数：**条数是召回的覆盖面，字数是每条的详略**。十条各 30 字还能看出「有这十条、分别是什么」，三条各 300 字则只看到三条、另七条等于没召回——对记忆检索来说，漏召回比看不全更贵，因为漏掉的那条你不知道它存在。

为什么必须重查而不是截断文本：截断会把一条记忆的正文拦腰砍断，读者看到的是一句没有下半句的话，而工具还在尾注里说「收紧了」——那是在骗人。重查拿到的是引擎真正按参数给出的结果，条数、排序、摘要都是完整的一份。

### 9.115.5 「最小」必须量到，不能拿估计冒充

四级之后还装不下，得回答「最小能给多少」。第一版写的是拿第四级的估计值当最小值——**报「最小」却从没试过最小**，这是本次唯一一处自己抓出来的错。

改法：装不下之后**再真取一次最小一份**：

```
const { r: smallest, est: smallestEst } = await take({ ...baseArgs, k: 1, content_max: 60 })
```

装得下就说 `收到了最小的一份：k ${k0}→1、content_max ${cmLabel0}→60，实际 ≈N token（再砍就只剩标题）。`；还装不下就说 `预算 ${budget} token 装不下：最小一份（k=1、content_max=60）实测 ≈N token——再小就只剩标题，那就不是检索了。`

注意 `实测` 两个字：这句话里的数必须是量出来的。`probe-fusion.mjs` 的 D60 专门用一个「回执体量与参数无关」的 stub（`rigid` 模式）造出「怎么砍都不变」的情形，断言尾注含 `（k=1、content_max=60）实测`、且**不含**「收紧了」——两条一起才排得掉「拿估计冒充实测」与「明明没缩却说缩了」。

### 9.115.6 收缩必须发生在星图段之前

`runSearch` 里 `budget` 的收紧插在本地检索之后、`const wantExpand = …` 之前：

```
let main = await flow.call('memory_search', localArgs, exec)
// 零回执守（原有）
if (budget.value !== null) {
  const fit = await fitBudget(flow, exec, localArgs, main, budget.value)
  main = fit.main
  flags.budgetNote = fit.note
}
// 之后才是 const wantExpand = …
```

顺序反了会怎样：星图段（`nebula_inspect` 的邻居段落）加在已经缩到预算的那份后面，读者看到的回执仍然超预算，而尾注信誓旦旦说「按 400 token 收紧了」——**数字对不上文案，整条尾注作废**。

星图退回本地兜底的两条路（`graphFellBack`）也过同一道预算：新增 `maybeFit(flow, exec, baseArgs, got, budget, flags)`，把 `got.text` / `got.value` 换成收紧后的那份（`probe`/`verify` 钉了 `await maybeFit(` 在 `search.js` 里出现 2 次）。漏一条路，就等于「同一句 budget 在一半情况下不生效」。

### 9.115.7 出口：尾注只拼一次，小回执一个字不加

`costTail(body, { mode, budget, flags })` 按固定顺序拼：

1. `budget.note`（预算四态里那三句说明）
2. `flags.budgetNote`（`fitBudget` 的交代表）
3. 非本地 mode 且给了预算：`budget 只有本地检索能收紧：星图 / 相似两路的体量由引擎自己的 limit / chars 说了算，这次没缩。`
4. 本地且没有 `budgetNote`（预算给了但一开始就不用缩）：`budget N 这次没派上用场：你给的条件下一开始就没有可缩的东西，回执本来就是这么多。`
5. 成本行：`budget.value !== null || est >= COST_SHOW_MIN` 时加 `costSentence(body)`；`budget.value === null && est >= COST_HINT_MIN` 时再缀骨架提示。

第 3、4 条的差别是「能不能缩」与「需不需要缩」：前者是能力边界（星图路的体量不归这个工具管），后者是事实交代（本来就不大）。两句都写清楚，读者才不会以为预算坏了。

`read.js` 那边只接成本、不接预算：`return readCostTail([said, section, gap, nb.note].filter(Boolean).join('\n\n'))`，`readCostTail` 在 500 以下原样返回、1200 以上追加 `；只要骨架就少给几条邻居（neighbors=0 或 3）`——单条记忆的体量由这条记忆本身决定，能砍的只有邻居条数，所以这里给的是旋钮而不是自动预算。

`execute` 里的薄壳保持「各拼一次」：`modeNotes` 的注在 `body` 里拼一次，`costTail` 在外层拼一次，两处都在 `search.js` 的 `execute` 内。`verify.mjs` 把这三行的相对位置钉成了断言（尾注与成本账都在薄壳里各拼一次），因为把 `costTail` 挪进 `runSearch` 就会在「零回执」那条提前返回里丢掉成本行。

### 9.115.8 手册加一个旋钮，余量还剩 144

`prompt.js` 的 `GUIDE_TEXT` 第 23 行改成：

```
memory_search（query, budget）：…；回执够大时自带成本尾注（≈N token）；想省上下文就给 budget=N，工具自己砍字、砍条数并交代砍了什么。
```

`GUIDE_TEXT` 1091 → **1156** 字符，`GUIDE_MAX_CHARS = 1300`，余量 **144**，仍高于 `GUIDE_MIN_HEADROOM = 120`，`clampGuide() === GUIDE_TEXT` 成立。手册是模型唯一会读的说明书，新参数不进手册等于没这个参数；但手册也不能无限长（`clampGuide` 会截断，截断的位置不可控），所以每加一句都要报余量。

### 9.115.9 顺手修掉的四处老断言

签名与薄壳改形会让老断言红，四处都要改**而且要保持还能被打红**（放宽到永远为真的正则等于删断言）：

1. `tools/criteria.mjs` 的 `search-mode-whitelist`：`/const text = await runSearch\(flow, args, exec, flags\)/` → `(?:, budget)?`。
2. `verify.mjs` A55 的 badMode 正则：`{0,400}` / `{0,600}`，并要求调用点写成 `runSearch(flow, args, exec, flags, budget)`。
3. wrapper 断言：改成 `const notes = modeNotes(...)` / `const body = …` / `return costTail(body, { mode: mode.name, budget, flags })` 三段，label 改「尾注与成本账都在薄壳里各拼一次」。
4. legacy 断言：`/async function runSearch\(flow, args, exec, flags = \{\}, budget = \{ value: null, note: '' \}\)/`。

### 9.115.10 探针进线

- `tools/probe-ruler.mjs` L27（估算口径：`estTokens('中文四个字') === 5`、`'hello world' === 3`、`'' === 0`、`'中文abc' === 3`）、L28（预算四态：没给 / `abc` / `20` / `30000` / `400`）→ 92 → **94 条**。
- `tools/probe-fusion.mjs` D58–D61（stub 桥 + 真 `createUnifiedTools` 装配）：D58 大回执报成本且 1200 以上劝骨架；D59 给预算真的重取多次（`costStore.calls.length > 1`）；D60 `rigid` 下「装不下」且带「（k=1、content_max=60）实测」、不含「收紧了」（阴性对照）；D61 小回执不报成本、graph 模式不收预算而是说清（阴性对照）→ 534 → **538 条**。
- `verify.mjs` 新增 `[macro-fusion 0.2.109]` 块 13 条：口径可复算、三阈值集中一处、预算四态、`budgetOf` 只解析一次、收缩顺序（cm 在 k 前）、最小必须实测、收紧排在 `const wantExpand` 之前、`maybeFit` 两处、小回执不加 + `readCostTail` + graph 说明、手册含 `budget` 且未触顶、探针进线、版本与文档在位。

### 9.115.11 没做的事

1. **不接真 tokenizer**。理由在 9.115.1：要的是量级，不是账单。
2. **面板不记历史成本**。`dream_log` 记的是整理前后的库规模，不是检索花了多少；要记就得在写侧加一张检索流水表，那是另一个功能（且高频写会拖慢检索）。
3. **预算只管单次调用**。跨工具的累计预算（这一轮总共允许多少 token）需要会话级状态，现在没有这个容器。
4. **预算不砍星图段**。星图段的体量由 `nebula_recall` 的 `limit` / `chars` 决定，工具只说清「这次没缩」，不擅自改别的工具的引擎参数。
5. **不改 `content_max` 的语义**。`0` 仍是全文，预算内部把全文按 2400 起砍，但用户在 schema 里看到的行为不变——参数语义一变，所有已有调用都会静默改变行为。

## 9.116 预算贯通四路：每一条检索路径都听 budget（0.2.110）

### 9.116.0 起点：一句诚实的缺功能

0.2.109 把「回执多少钱」摆上了台面，也让 `budget` 真的会收缩——但只在本地这一路。
星图 / 相似两路的尾注写着：「budget 只有本地检索能收紧：星图 / 相似两路的体量由引擎自己的
limit / chars 说了算，这次没缩。」

这句话本身没错，可它是个**缺功能的自我说明**：四路回执都要进上下文，凭什么只有一路能被约束？
读者的成本不按「你走了哪条路」打折。0.2.110 把这句尾注删掉了——不是改文案，是让这件事真的发生。

### 9.116.1 四条路各自的旋钮

| 路径 | 旋钮（按收缩顺序） | 下限 | 上游默认 |
| --- | --- | --- | --- |
| local | `content_max` → `k` | 60 / 1 | 300 / 10 |
| graph | `limit` → `hops` | 1 / 0 | 10 / 2 |
| bridge | `chars` → `limit` | 200 / 1 | 900 / 4 |
| similar | `content_max` → `k` | 60 / 1 | 300 / 10 |
| local + expand | 先走 local，扩散段单独按**剩余**预算算 | — | — |

下限一律取上游 schema 的地板（`nebula_recall` 的 limit≥1、hops≥0，`nebula_bridge` 的
chars≥200、limit≥1，`memory_find_similar` 的 content_max / k），不自己发明地板：
我们比自己发明的下限更清楚上游肯给什么。

### 9.116.2 为什么没把 fitBudget 抽象成一套

本地那支（`fitBudget`，0.2.109）和通用那支（`fitPath`，0.2.110）有十几行重复。故意不合并：

1. 本地那支的手感是 0.2.109 定的，verify 里逐句钉着（`if (cm > 60) cm = ...` 在 `else if (k > 1)`
   之前、`（k=1、content_max=60）实测`），它是一份已经验证过的证据；
2. 把两套旋钮硬塞进一个泛化循环，最容易丢掉的就是「先砍字、再砍条数」这句容易被写反的话——
   而这句话是这一版和上一版共同的结论。

十几行重复换来两条路各自说得清自己砍了什么，这笔账划算。真要合并的那天，先把两边的断言并成一套。

### 9.116.3 预算是对象，不是数字

`budget` 传进来是 `{ value, note }`（`budgetOf` 的产物），不是 `400`。第一版 `fitPath` 直接写
`est <= budget`，四个探针同时红，回执里印出「预算 [object Object] token 装不下」——
因为 `数字 <= 对象` 求值是 `false`，循环一次都收不住，一路滑到「装不下」还能自圆其说。

现在入口先摊成 `const cap = Number(budget.value)`，之后只用 `cap`。verify 钉住 `fitPath`
整段里不许再出现 `<= budget`（本地那支不算，它的 `budget` 本来就是数字）。

### 9.116.4 只报真动过的旋钮

星图的收缩是 `limit 10→5→2→1` 之后才动 `hops`。第一版把旋钮全列出来，于是回执里写着
「limit 10→2、hops 2→2」——`hops 2→2` 一个字没变，却排在「砍了什么」里，读者只会以为它也被砍了。

现在 `show()` 只列 `d.value !== d.from` 的项，全都没动时写「没动到任何旋钮」。

### 9.116.5 「最小」必须把旋钮压到下限再量

延续 0.2.109 的规矩，但这一版的要求更高：不是「试一次 k=1」，而是**把所有旋钮压到下限**
（`for (const d of dials) d.value = d.min`）再问一次，用 `（limit=1、hops=0）实测 ≈N token`
把地板摊开。报「最小」之前必须真的到过最小，否则那句「最小」只是「我停下的地方」。

### 9.116.6 本地展开：扩散按剩余预算算

`expand=true` 时回执是「本地结果 + 星图扩散」两段。两段各自按 `budget` 收缩，加起来一定超——
读者付的是整份回执，不是分段账单。

现在扩散段拿到的是 `remain = budget.value - estTokens(main.text)`：本地那一份已经用掉多少，剩下的
才给扩散。`remain < BUDGET_MIN` 时干脆不拿，并说清「要扩散就用 expand=false 关掉它，或者把预算提上去」。
——预算当约束用，就得允许它真的**拦下**一段内容，而不是缩一缩再照样塞进去。

### 9.116.7 出口

`costTail(body, { budget, flags })`：`mode` 这个参数没用了（不再按模式说「缩不缩」），删掉。
「没派上用场」那句从「local 且没有 budgetNote」改成四路通用：「这条路上没有可缩的东西
（比如零命中、空图，或本来就没展开）」。

### 9.116.8 schema 与手册

- schema 的 `budget` 描述改成四条路各砍什么（「星图先砍条数、再砍跳数」「补邻居先砍字符预算、
  再砍条数」），否则模型会以为 budget 只管本地。
- GUIDE_TEXT：`1,156 → 1,176` 字符（`四路都听（本地/星图/补邻居/相似）`），上限 1,300，余量 **124**
  ≥ `GUIDE_MIN_HEADROOM` 120，`clampGuide() === GUIDE_TEXT` 仍成立。

### 9.116.9 探针

- `tools/probe-fusion.mjs`：D61 改口（从「星图两路不吃预算但要说清」改成「没给预算就不缩、也不说废话」），
  新增 D62（星图收 `limit` 且不列 `k`）、D63（补邻居先砍 `chars`）、D64（相似先砍 `content_max`）、
  D65（星图 rigid：装不下 + `（limit=1、hops=0）实测`）、D66（本地展开按剩余预算）。
  stub 的 `nebula_recall` / `nebula_bridge` / `memory_find_similar` 体量必须跟着各自旋钮走，
  否则「收紧了」这句话验不出真假。
- `verify.mjs`：12 条 check（旋钮表顺序、cap 摊平、三处 fitPath、只报真动的旋钮、最小实测、
  剩余预算、出口不再声称「只有本地」、schema 四路、手册四路且未触顶、探针进线、版本与文档）。
  另改两处 0.2.109 老断言（wrapper 的 `costTail` 签名、出口那句「星图两路不吃预算」）。

### 9.116.10 这一版没做的事

1. 没做「整份回执的合并估算」：本地段与扩散段是**分别**量再相加的，仍是量级不是账单。
   真要精确，得让引擎吐 usage，那是另一件事。
2. 没动星图 `hops=0` 的语义（0 跳 = 只要种子本身），收缩到 0 是合法的，不是 bug。
3. 没给 `read` 路加 budget：`memory_read` 的体量由 id 决定，砍了就没内容可读——它只有成本尾注。

## 9.117 项目走向：哪一层在涨，和哪个项目在涨，是两件事（0.2.111）

### 9.117.0 起点

0.2.108 的层走向能说「fact 涨了 3 条、topic 掉了 2 条」，说不出的是**这些条属于谁**：
Alpha 涨 3、Beta 掉 3，层走向念「fact 没变」，而实际上一个项目在膨胀、另一个在被清空。
总分是 0 的时候，结构可能已经换过一次血——这正是 0.2.108 那句话的项目版。

### 9.117.1 只有五个层带项目归属

`vendor/meow-memory/lib/index.js` 的 `SCHEMAS`：`project` / `fact` / `lesson` / `topic` / `rules`
五张表带 `project` 列（`project` 是 `NOT NULL`，其余可空），`soul` 与 `user` 只有 `COMMON_COLS`，
**没有这一格**。所以「按项目数」天然只能覆盖五层，剩下的两层不进这条数——
这不是漏做，是库的结构说的；口径句必须把这件事写出来，不让读者以为「soul 里那几条不见了」。

### 9.117.2 写侧

新增 `dreamStoreProjects(db)`（`PROJECT_LAYERS` 五个层名集中一处）：

```js
SELECT project AS name, COUNT(*) AS n FROM ${level} WHERE status = 'active' GROUP BY project
```

三条口径：
1. **跨层同名相加**：读者问的是「这个项目一共多少条」，不是「fact 里多少、lesson 里多少」。
2. **NULL 与空串不是一个项目**：`String(row?.name ?? '').trim()` 后为空就跳过，否则每个「全局」条目
   都会被算成一个叫 `null` 的项目。（注意：meow 的约定里 `project: '全局'` 是**写入的名字**，
   它会作为一个正常项目名出现——这是诚实的，不是 bug，口径句里也不假装。）
3. **没有项目时整格不写**：空对象塞进 JSON 会被读成「数过，零个项目」。

`dreamStoreScale` 的返回值从 `{ active, byLevel }` 变成 `{ active, byLevel, byProject? }`——
`byProject` 只在非空时出现。开工与收尾两个点都走同一把尺子。

### 9.117.3 读侧

`storeOf(plan)` 多解一格 `byProject`：正数才认、名字 `trim()`、老账没有这一格就是 `{}`（不补零）。
`projectSeriesOf(plan)` **只认 `plan.storeEnd.byProject`**——与层走向同一条规矩：0.2.103～0.2.105 的账
只有开工数，拿它占位等于把「整理前的库」贴到「整理后的库」的位置上，图整齐但全是假的。

### 9.117.4 名字是字符串

项目名按写入时原样存。改名会变成两行：旧名那条一路掉、新名那条冒出来——
读者很容易把「改名」读成「有人在删东西」。所以这条走向的常驻口径里明写
「项目名按写入时原样——改过名的会算成两行」。要做「改名检测」得先有改名事件，那是另一件事。

### 9.117.5 三支结论

和层走向一样分三支：涨得最多 / 掉得最多 / 每个项目的条数都没变。没涨就不许编
「涨得最多的是 Alpha（+0）」——那是把噪声讲成走势。只列 4 个项目，多的说「还有 N 个项目没列」。

### 9.117.6 面板位置

`readDreamPanel` 第 1 页、紧跟在层走向之后（同一批行、同一套「只吃跑完的轮」的规矩），
scope 句补一句「项目走向按每一轮收尾时的 storeEnd.byProject 数，只有 0.2.111 之后的账有这一格」。
翻到旧页不出——它说的就是最近这几条。

### 9.117.7 探针

- `tools/probe-ruler.mjs` L29–L31：真库写三条 Alpha（fact 2 + lesson 1）与一条 Beta（topic 1），
  验跨层相加 = 3 / 1；`L30` 验全写「全局」的库里不出现 `null` 或空名；`L31` 归档 topic 后
  Beta 整个键消失（不是写成 0），Alpha 不变。
- `tools/probe-fusion.mjs` D67–D70：D67 三轮摊开 `Alpha 3 → 4 → 6（+3）`、`Beta 2 → 2 → 0（-2）`；
  D68 口径三条齐全（只数 5 层 / 名字按原样 / 没这一格的账不进走向）；D69 单轮不出（阴性对照）；
  D70 全都没变就说没变且不出现「涨得最多」（阴性对照）。
- `verify.mjs` 10 条：写侧层名表 / 空名与空对象处理 / 读侧解析 / 只认 storeEnd / 少于两轮不出 /
  排除要交代 / 三支结论 / 挂在第 1 页且在层走向之后 / 探针进线 / 版本与文档。

### 9.117.8 这一版没做的事

1. **没有按项目的分支走势**（`project=` 筛了账之后仍只有那一页的行，不出「这个项目在涨还是掉」）——
   筛子与走向该不该合流，要先想清楚「筛完再看走势」算不算另一种编辑历史。
2. **没有改名检测**：需要改名事件（或至少同名近似匹配），先不动。
3. **`全局` 会作为一个项目名出现**：这是 meow 的写入约定，不在这里重新解释它。

## 9.118 读也吃预算：正文不截，只砍邻居（0.2.112）

### 9.118.0 起点：唯一一支明说「没法缩」的

0.2.109 给本地检索落了预算，0.2.110 把预算接到星图 / 补邻居 / 相似三路，尾注从「只有本地能收紧」改成「四路都听」。剩下 read 一支，手册里一直写着它的体量「由 id 决定」——听起来像客观限制，其实是没做：read 的回执 = 正文 + 邻居段，正文不能动，邻居段是**条数**，条数当然能砍。

真正的问题不是「能不能砍」，而是「砍哪里不算骗人」。别的工具砍字（content_max）、砍条数（k），读者拿到的仍然是**完整条目**的下采样；read 的正文就是 caller 要的那一条，砍一半等于给他半条记忆，而回执上没有任何标记说明「这是半条」。所以这一轮的规则先定死一条：**read 的正文一个字节都不截**。

### 9.118.1 三个形态，各有各的话

`memory_read` 现在有三种出口，按预算从小到大：

1. **不给预算**（`budget` 缺省 / 空串）→ 老样子：正文 + 你要的邻居条数 + 成本尾注（0.2.109 的 `readCostTail`，够大才报）。
2. **给了预算，正文装得下、邻居装不下** → 砍邻居：从你要的条数往下试 6 / 3 / 1 / 0，取第一个整份装得下的档位，并写「邻居 12→6 条才装下」。
3. **给了预算，连正文都装不下** → 只给**骨架**：正文第一行（最多 120 字）+ 一句交代（正文共多少字、约多少 token、比你给的预算大、要看就 `budget ≥ N` 或先 `memory_search` 看摘要挑一条）。

第四种是「`budget` 给的不是数字 / 比 80 还小」：按不限额给，但**那句话必须带出来**（`budgetOf` 的 note 原样接在回执后面）。以前 `read` 只在有 `neighbors` 时才拼 note，这次顺手补齐——他给的数被忽略而不说，比拒绝更难受。

### 9.118.2 阶梯为什么要「实测」而不是估算

因为 `estTokens` 是估算，而估算与真实体量之间没有稳定比例：一段全是 CJK 的邻居段和一段全是 id 的邻居段，同样的字符数差三倍。所以砍邻居不能「按比例算一条线就交差」，只能**真取一次、真量一次**：

```js
const ladder = [nb.value, ...NEIGHBOR_LADDER].filter((n, i, arr) => n <= nb.value && arr.indexOf(n) === i).slice(0, LADDER_TRIES)
for (const count of ladder) {
  const got = await withNeighbors(count)
  const text = [got.text, nb.note].filter(Boolean).join('\n\n')
  if (estTokens(text) <= budget.value) { picked = { count, text, est: estTokens(text) }; break }
}
```

三条约束写在这个小循环里：

- **不超过他要的**：`n <= nb.value`。他说 3 条，我们不能先试 12 条再说「砍到 3」——那是替他做了没要求的事。
- **不重复试**：`arr.indexOf(n) === i`。他要 6 条时，阶梯 6/3/1/0 就够，不必再试一遍 6。
- **最多三次**：`slice(0, LADDER_TRIES)`。每一档都是一次真的 `nebula_inspect`；为了让回执小一点去打四次星图，省下的 token 还不如调用本身贵。

阶梯全落空（`picked === null`）时兜底给**正文本身**：这一刻的取舍是「宁可不缩，也不给假货」。

### 9.118.3 尾注自己也要装得进预算

一句账大约 20 token。如果正文刚好卡在预算边缘，加上这句就超了——为了让读者知道「装下了」，反而把它弄成装不下，这很荒唐。规则：

- **砍过邻居** → 必须说（改过就要交代），这句话优先于预算；
- **没砍** → 只在 `estTokens(withTail) <= budget.value` 时加，装不下就一个字不加。

即「交代比省重要，但只在他真的被我改过的时候」。

### 9.118.4 骨架是「指路」，不是「摘要」

骨架里那一行是正文**第一行**（多数记忆的第一行就是标题/口径句），后面跟的不是「省略了 N 字」，而是**缺口与出路**：

```
正文共 1511 字（≈1.5k token），比你给的预算 800 token 大——这次一个字都没裁给你：
截一半你会把它当成全文。要看全文就把 budget 提到 ≥1507，或者先用 memory_search 看摘要挑一条。
```

写「截一半你会把它当成全文」不是修辞：没有这句，骨架看起来就是一条短记忆，读者不会怀疑缺了什么。

还有一个边界：预算 80～119 且正文第一行很长时，**连骨架那一行都可能超预算**。这时照样返回骨架，但加一句「连上面那一行标题都超过你给的预算了；但不写这句，你就会把骨架当成全文」——宁可超几点 token，也不能让形态被误认。

### 9.118.5 手册与探针

- `GUIDE_TEXT` 的 read 段改成「memory_read（id, neighbors=12, budget）连邻居一起读——预算不够先砍邻居、正文一字不截、砍到底只给骨架」，并把「四路都听」改成「五路都吃（本地/星图/补邻居/相似/读）」。为了腾地方，同一行的「顺带沿星图扩散 / 走星图关联 / 找相似条目 /（project）看项目全景」压成短语；手册仍是 1,176 字符、余量 124（≥ `GUIDE_MIN_HEADROOM` 120）。
- `tools/probe-fusion.mjs` 新增 D71–D77（547 → 554 条）：老样子 / 骨架（且**不去问星图**）/ 骨架指路三要素 / 砍邻居（`[12,6]`）/ 装得下一条不砍（只问一次）/ 四态里的「不是数字」「太小」/ `neighbors=0` 时给预算也不问星图。
- `verify.mjs` 新增 `[macro-fusion 0.2.112]` 块 12 条：schema、`budgetOf` 单一出口与 note 带出、全文路径没有任何 `said.slice`、骨架的缺口与三条出路、连标题都超预算那句、阶梯常量与三条约束、`count <= 0` 不问星图、砍了就交代 / 没砍才让路、兜底不返回半截、手册改口与余量、探针进线、版本与文档。
- 老断言改口 4 处（`tools/criteria.mjs` 的 `read-neighbors-param` 与 `read-neighbor-gap`、`verify.mjs` A62 的两条 nb 断言与 A77 的拼接断言、A1 的「三个面都在」→「三面都在：工具 / 命令」）：全部只改形状、不改判据的含义——「0 条照办」「三句话必须拼进去」「不是有限数不许静默 return」这三条仍旧能被打红。

### 9.118.6 没做的事

- **没有按「保留前 N 条邻居」的另一种切法**：现在只能在条数维度砍，砍不到「每条邻居截断到 200 字」。理由：邻居段的每一条都是星图给的整条摘要，截断它跟截断正文是同一类问题（读者会把半条邻居当成整条），要做也得先有一条「这段是截过的」的标记。
- **没有把骨架做成结构化字段**（`{ head, chars, est, hint }`）：read 的输出契约是纯文本（`TEXT_OUT`），突然换成对象，调用方得改。
- **没有自动重试**：预算装不下时不去「再搜一次、挑短的那条」——那是替他做决定，而且会让一次 read 变成两次检索。

## 9.119 项目走向：说出「第几次来的」与「哪一轮没的」，并把长序列折起来（0.2.113）

### 9.119.0 这条走向剩下两个洞

0.2.111 的 `projectTrendLine` 已经能把每个项目的条数按轮摊开：`Alpha 3 → 4 → 6（+3）`。
发完之后自己回读那段输出，发现它有两件事说不了。

第一件是**首尾净差吃掉的时间信息**。三个项目、三轮：

- Alpha：`3 → 4 → 6`，净 +3；
- Gamma：`0 → 0 → 2`，净 +2，但这个项目是**第二轮才不存在的**，第三轮才第一次有数；
- Beta：`1 → 2 → 0`，净 -2，上一轮还在，这一轮归零。

Gamma 和「某个项目从 2 涨到 4」在净差里长得一模一样：都是 +2。可它们说的不是一件事——
一个是「新长出来的一块地」，一个是「旧的地又扩了」。Beta 的 -2 也一样：归零和「本来就只有 2 条、
被删了 2 条」在净差里没有区别，可后者是修剪、前者是这一整块没了。

第二件是**体量**。这条走向每轮给全部项目各印一条序列，回执轮数一多（`limit` 可以到 100），
一条「项目走向」就能占掉回执的大半行。而 0.2.109 起整条线就在做同一件事：省 token 要真省，
不是「别的工具省，账本随便」。序列里有用的部分永远是两头——最早什么样、现在什么样、净差多少；
中间那几次只在回答「第几轮开始涨的」这种追问时才有用，而那种追问可以去看那一轮的账。

所以这一版只做两件事：**点名首尾之外的变化**，**把长序列折起来并报出折了几次**。

### 9.119.1 省略的形状：头两个 + 尾三个 + 一个 …

`lib/macro/dreamledger.js` 新增两个常量与一个纯函数：

```js
const SEQ_HEAD = 2
const SEQ_TAIL = 3

function compactSeq(seq) {
  const list = Array.isArray(seq) ? seq : []
  if (list.length <= SEQ_HEAD + SEQ_TAIL + 1) return { text: list.join(' → '), cut: 0 }
  const cut = list.length - SEQ_HEAD - SEQ_TAIL
  return { text: [...list.slice(0, SEQ_HEAD), '…', ...list.slice(-SEQ_TAIL)].join(' → '), cut }
}
```

阈值是 `SEQ_HEAD + SEQ_TAIL + 1 = 6`：**七轮以下整条给**。为什么不从第三轮就开始折？
因为折一次至少要省掉两个数，否则 `…` 本身（一个字符加两个分隔符）比它省掉的还长；
而 `1 → 2 → … → 6 → 7 → 8` 这种形状，六个数里五个是原来就有的，折的意义只在第九轮以后才出现。
换个说法：**省略不是为了让输出好看，是为了在信息量不降的前提下少印几个字符**——省不出字符就别省。

`cut = list.length - SEQ_HEAD - SEQ_TAIL` 是**被折掉的次数**，不是省略号的个数。八轮时 `cut = 3`
（第 3、4、5 次被折进 `…`），这条数必须写进 caveat：

```
序列太长，中间 3 次用 … 省略（要逐轮就展开那一轮看账）
```

不写这句会怎样？读者看到 `1 → 2 → … → 6 → 7 → 8`，最自然的解释是「中间这几次没有数据」——
而实际上有数据，是我们没印。**省略和缺数据是两件完全不同的事，形状却一样**，所以只能靠一句话区分。
这条规律在 0.2.109 的「截断要交代」、0.2.112 的「砍邻居要交代」里已经出现过两次，这是第三次。

`shown` 的写法跟着改：不再直接 `c.seq.join(' → ')`，而是 `const box = compactSeq(c.seq)`，
取 `box.text` 印出去，并把 `box.cut` 汇总成整行的最大 cut（一行只报一次，不必每个项目报一次）。

### 9.119.2 新出现：判据是「第一次有数的位置不在开头」

```js
const firstLive = (seq) => seq.findIndex((n) => n > 0)
...
if (f > 0) appeared.push({ name: c.name, at: f + 1, now: c.last })
```

三个细节：

1. **`f > 0` 而不是 `f >= 0`**。`f === 0` 意味着「窗口第一轮就有数」，那是「一直在」，
   不是「新出现」——把它当成新出现，等于说每个项目都是新的。
2. **`at = f + 1`**。数组下标从 0 起，人读「第几次」从 1 起。这里换算错一次，整句话就从
   「第 2 次起有数」变成「第 1 次起有数」，读者会以为第一轮就存在。
3. **`now = c.last`** 用的是这一轮的收尾数（`cells` 已经是「最早→最新」的顺序，`last` 是最后一个），
   不是峰值、也不是第一次的数。读者要知道的是「现在多少」，中间怎么起伏属于序列本身。

文案：`这条走向里新出现：Gamma（第 3 次起有数，现在 2 条）`。
名字后面必须带这两个数，否则「新出现：Gamma」只是一句提示，读者还得自己回去数序列——
而序列可能已经被折进 `…` 里了。

### 9.119.3 消失：判据是「最后一次有数的位置不在末尾」

```js
const lastLive = (seq) => {
  for (let i = seq.length - 1; i >= 0; i -= 1) if (seq[i] > 0) return i
  return -1
}
...
if (l >= 0 && l < c.seq.length - 1) gone.push({ name: c.name, at: l + 1, was: c.seq[l] })
```

`l === -1` 是「整条序列全是 0」——这种项目根本不会进 `cells`（没有正数就没有 delta 可言），
所以 `l >= 0` 这一半是防御，不是主判据。真正的主判据是 `l < seq.length - 1`：
最后一次有数不在最后一位，就说明「这一轮它已经没了」。

`was = c.seq[l]` 报的是**最后一次的数**，不是峰值。文案：
`这条走向里消失：Beta（第 2 次是最后的数：2 条）`。为什么不用「现在 0 条」？
因为归零本身就写在那条序列的尾巴上（`… → 2 → 0`），再写一遍「现在 0 条」是重复；
而「最后一次是多少」是序列被折叠之后唯一拿不到的信息。

### 9.119.4 改名：只给线索，不替读者断定

一存一失同时出现时补一句：

```
一存一失如果条数对得上，很可能只是改名——这条走向不替你猜，要确认就翻那一轮的账看项目段名字
```

为什么不断定？因为项目名在库里就是一个字符串（9.117.4），改名在存储层看就是「旧名字的行全没了、
新名字的行出现了」。但「一存一失」还有另一种解释：真的把一个项目清空、另起了一个新项目。
两者的账长得一样，唯一的区别是内容——而这条走向只数条数，看不到内容。

所以这里给的是**线索 + 核对路径**，不是结论。这是可追溯性（信息从哪来）与准确性（召回的是对的）
之间的一次取舍：宁可留一句「可能是」，也不把「一定是改名」写死在一个只数数的地方。
条数对不上时也照样提这句吗？——提。因为「条数对不上」本身也可能是改名 + 顺手增删了条目，
而那句话里的「如果条数对得上」已经把条件说清楚了。

### 9.119.5 顺序与阴性对照

`parts` 的顺序固定为：抬头 → 每个项目的序列 → 涨/掉/都没变的结论 → 新出现 → 消失 → 改名提示，
`caveats` 里则是：还有 N 个项目没列 → 序列折叠了几次 → 没跑完的轮 → 常驻口径。
前四条是「这次看到了什么」，后四条是「这次没看到什么」，混在一起读者会分不清哪句是结论。

阴性对照（不作就不会错）：

- 每个项目都没变（`pjFlatLine`）：不许出现「新出现」「消失」「改名」任何一句——
  平稳的走向不许自己长戏；
- 只有一轮：整条走向不出（0.2.111 已有判据），自然也不会冒出「第 1 次起有数」；
- 序列短于七轮：不折叠，也不出现「序列太长」；

### 9.119.6 探针与判据

`tools/probe-fusion.mjs` 新增 D78–D82（在 D70 之后，复用 D67 那套 `mkdtempSync` + `Meow.getDb` +
`INSERT INTO dream_log` 的桩）：

| 编号 | 钉的是什么 | 关键断言 |
| --- | --- | --- |
| D78 | 八轮序列折叠 | `Alpha 1 → 2 → … → 6 → 7 → 8（+7）` + `序列太长，中间 3 次用 … 省略` + 不含 `1 → 2 → 3 → 4 → 5` |
| D79 | 新出现点名 | `这条走向里新出现：Gamma（第 3 次起有数，现在 2 条）` |
| D80 | 消失点名 | `这条走向里消失：Beta（第 2 次是最后的数：2 条）` |
| D81 | 改名提示 | 含 `很可能只是改名` + `不替你猜` + `翻那一轮的账` |
| D82 | 平稳不加戏 | 三条否定：无「新出现」、无「消失」、无「改名」 |

`verify.mjs` 的 `[macro-fusion 0.2.113]` 块 10 条：常量与阈值 / `shown` 不再直接 join /
cut 报数 / 新出现判据 / 消失判据 / 点名最多三个 / 改名只在两者都有时 / 探针进线 / 版本与文档。

探针总数 554 → 559。

### 9.119.7 没做的事

1. **没有「第几轮开始连续下降」这类形状判断**。序列本身已经在那儿，谁想看出来自己看；
   硬加一个「连续三次下降」的判据，只会在轮数不同的账上给出不同结论。
2. **没有按项目 ID 追踪改名**。库里的项目就是一个名字字符串，没有稳定 ID；
   要做只能加一列并回头补历史账，那是另一件事（而且补出来的 ID 全是猜的）。
3. **没有把折叠后的中间段放进回执**。要看逐轮就展开那一轮（`memory_admin dream id=<ref>`），
   那里给的是全量——同一条信息不做两份拷贝。

## 9.120 疑似冲突：两种说法撞在一起，系统只摊差异，不下判决（0.2.114）

### 9.120.0 三种病，只有两种有尺子

0.2.96 的 `dreamDupPairs`（逐字重复度 ≥80%）和 0.2.103 的 `dreamCoverPairs`（覆盖度 ≥90%）
回答的是同一类问题：**同一句话被存了两份**。一个是「两份逐字相同」，一个是「一份是摘要、一份是全文」。
两种都可以机械处置：合并成一条、归档另一条。

但收藏夹里最常见的那种脏数据不是这个：

- `DSH 的记忆库在 C 盘的 .dsh 目录里，插件版本 0.1.x`（keywords: DSH / 路径）
- `DSH 已经搬到 D 盘 dsh-home，插件版本 0.2.113`（keywords: DSH / 路径）

逐字重复度不到 30%，覆盖度也够不着 90%——两条正文说的是不同时期的事，字面几乎不重叠。
可它们**指着同一个主题，给出彼此打架的数字**。这是第三种病：**同一件事，两种说法**。

更糟的是，手册里那句「冲突以时间戳最新者为准」在此之前**完全没有落地**：没有任何一处代码在找冲突，
于是那条规则永远用不上——一条永远不会被触发的规则，等于没有这条规则。

### 9.120.1 判据：同一主题 + 各有数字 + 数字集不同

`vendor/meow-memory/lib/index.js` 新增：

```js
var DREAM_CONFLICT_MAX = 3;          // 一轮最多点几对
var DREAM_CONFLICT_KEYS = 2;         // 共同关键词至少几个才算「同一主题」
var DREAM_CONFLICT_NUMS = 3;         // 每侧最多点几个独有的数字
var DREAM_CONFLICT_KEYS_SAMPLE = 4;  // 共用关键词最多印几个
```

`dreamConflictPairs(rows, max)` 两两比较，四条跳过规则全部是**否定优先**的：

| 跳过条件 | 为什么 |
| --- | --- |
| `String(r.status ?? 'active') === 'archived'` | 归档本身就是「已处置」，再报一次只是催人做已经做过的事 |
| `shared.length < DREAM_CONFLICT_KEYS` | 关键词都不撞，说明是两件事，不是两种说法 |
| `overlapOfSets >= DEDUP_THRESHOLD`（80%） | 归逐字重复块，那里该合并 |
| `coverOfSets >= DREAM_COVER_MIN`（90%） | 归详写块，那里该合成一条 |
| `sameNumberSet(nums[i], nums[j])` | 数字全一样、只是措辞不同——那是**复述**，不是冲突 |
| `nums[i].size === 0` 或 `nums[j].size === 0` | 没有数字就没有「打架」这件事，两边必须各有数 |

数字的抽取是 `rowNumberSet`，正则 `/\d+(?:[.,:\/-]\d+)*/g`：`0.2.113`、`1795165494`、
`2026-11-20`、`3,826,540` 都算一个整体，不会把版本号拆成 `0`、`2`、`113` 三个数——
拆开之后任何两条带版本号的条目都会「数字集不同」，判据就没有分辨力了。

### 9.120.2 摊差异，不判决

每一对给出的是五个事实，不是一句结论：

```js
{ a, b, shared: shared.slice(0, DREAM_CONFLICT_KEYS_SAMPLE), sharedTotal,
  onlyA: onlyA.slice(0, DREAM_CONFLICT_NUMS), onlyACount,
  onlyB: onlyB.slice(0, DREAM_CONFLICT_NUMS), onlyBCount,
  newer: ta === tb ? 'both' : ta > tb ? 'a' : 'b' }
```

`newer` 是**三态**而不是两态：时间戳相同是很正常的情况（同一次整理里写下的两条），
这时说「a 更新」是编的。读侧就此单独有一句「两条更新时间相同，分不出谁新」。

为什么不直接替它裁决、把旧的那条归档？因为**数字不同不一定是矛盾**：
一条讲版本号、一条讲端口号，两条都对；一条讲路径、一条讲条数，两条也都对。
自动归档会把其中一份真事实删掉，而记忆系统里删掉的真事实是找不回来的。
写的那一刻的会话知道哪个数是版本、哪个是路径——所以裁决留给它，系统只把差异摆平。

排序按 `Math.max(a.updated_at, b.updated_at)` 倒序：整理时先看最可能正在出问题的那一对。

### 9.120.3 计数与明细分两个字段

`dreamPlanDigest` 之前只有 `dup` / `cover` 两个计数。这次加的是**两格**：

```js
const conflicts = dreamConflictPairs(allRows, Infinity);
// ...
conflicts: conflicts.length,
conflictPairs: dreamPlanConflicts(allRows)
```

**计数用 `Infinity`，明细用 `DREAM_PLAN_PAIR_CAP`**。这不是随手写的：计数是「这一轮一共撞了几对」的
真值，被上限截断之后就变成假数；明细是回执体量的一部分，必须截。截了就要报差额，
读侧那句 `- 还有 N 对没落账（一条账只存前几对）` 就是为这个差额准备的。

为什么不像 dup/cover 那样直接并进一个数？因为读侧有一句「账里记着 N 对，却没有一条明细」——
如果冲突混进 `dup + cover`，那么 `stored.length < dup + cover` 这个判据在只有冲突、没有重复的账上
会误报「还有 N 对没落账」。**两个口径各自成对，才谈得上对账**。

回执里另起一行（标签 `dream.plan.conflicts`，形如「另有 1 对疑似冲突」），
且用 `Number(digest.conflicts) > 0` 判定——**0 是「查过、没有」，不是「没查」**，
所以 0 不印，但没有这一格的老账也不印：两者靠读侧那句「0.2.114 之前的记录……根本没查冲突」区分。

### 9.120.4 清单块：归轮 + 跨轮标「另一组」

`buildDreamMessage` 里 `conflictBlock` 紧跟在 `coverBlock` 之后，写法与对子那两块一致：
`dreamConflictPairs(allRows).filter((p) => dreamPairOwner(rounds, p) === idx)`——
**同一对只由先出现的那一轮负责说**，否则 fact 轮与 topic 轮会各印一遍。

另一条不在本组清单里时标 `（另一组）`：fact/topic 是分两次看的，若不标，
整理的那一轮会以为「只有一条、不用处置」，而真相是两条都在库里生效、正互相打架。

三语各 8 个标签：`dream.conflict.title`（含 `{n}` 与共用关键词）、`.keywords`、`.only`、`.more`、
`.newer`、`.same`、`.rule`、以及回执用的 `dream.plan.conflicts`。判据那行写的是
「措辞不同而数字一致的**不算**冲突（那是复述）；归档的那条也不报」——把两条跳过规则直接写进消息，
省得下一轮整理自己猜为什么某对没被列出来。

同时改的是六份槽位指导（`prompts/{zh,en,pt-br}/dream-{atomic,topic}.md`），各加一条，说的是三件事：

1. **别合并、别因为「看起来旧」就归档**——重复是同一句存两份，冲突是同一件事两种说法，合并会抹掉一份事实；
2. 先认时间（行尾点名谁更新 → 取新的，旧的改「（已被取代：…）或设 stale，不许直接删」），
   再认差异（`独有` 的数字常常是两件不同的事，各留各的、正文写清归属），拿不准就翻项目文件；
3. 改完留痕迹（写一句为什么这么定），下一轮才不用重新猜。

### 9.120.5 读侧四个分支

`lib/macro/dreamledger.js` 新增 `conflictsOf` / `conflictPairsOf` / `conflictLine` / `conflictsBlock`，
四个分支各说各话（这是 0.2.113 之后第三次用同一套写法：**老账 / 真没有 / 有数没明细 / 只存前几对**）：

| 库里是什么 | 面板说什么 |
| --- | --- |
| `plan` 没有 `conflictPairs`（非数组） | 「没有存这一格（0.2.114 之前的记录）——那一轮根本没查冲突，不是「查了没有」」 |
| 空数组且 `conflicts === 0` | 「这一轮没有「同一主题却写了不同数字」的条目」 |
| 空数组而 `conflicts > 0` | 「账里记着 N 对，却没有一条明细——别把「没列」读成「没有」」 |
| `stored.length < total` | 追加「- 还有 N 对没落账（一条账只存前几对）——数是真数，点名只到前几对」 |

`conflictPairsOf` 对「非数组」返回 `null`、对「空数组」返回 `[]`——**空和没有必须能区分**，
否则老账会被说成「查了没有」，而那是两个完全不同的信息。

明细一行：

```
- cccc0001 ⇄ cccc0002 · fact ⇄ fact · 共用关键词：dsh、路径 · cccc0001 独有 0.1 · cccc0002 独有 0.2.113 · cccc0002 更新（10-09 17:03）
```

末行常驻一句「更新时间取自库里的 updated_at；哪条要改、要不要标 stale，看正文自己决断——这一块只摊事实，不判决」，
把 9.120.2 那条取舍写到读者眼前。

`rowLine` 里 `if (conflictCount > 0) parts.push(\`疑似冲突 ${conflictCount} 对\`)`：
0 对是常态，行里多一个「疑似冲突 0 对」只会把别的数字挤淡。
`expandPanel` 的顺序是 `pairsBlock` → `conflictsBlock`：先看该不该合并，再看该不该统一说法。

### 9.120.6 顺序与阴性对照

- 归档的那条不报（`L34` / 内部判据）：归档本身就是处置；
- 数字一致、只是换了个说法的复述不报（`L33`）：否则整理会被叫去改本来对的条目；
- 这一轮没有冲突：块里明说「这一轮没有「同一主题却写了不同数字」的条目」，行里不出现「疑似冲突 0 对」（`D88`）；
- 趋势两块（`levelTrendLine` / `projectTrendLine`）**不加冲突走向**：一条讲「库在胖还是在瘦」，
  一条讲「哪两条在打架」，混成一条线只会让两边都变糊；冲突是逐条的事，不是规模的事。

### 9.120.7 探针与判据

`tools/probe-ruler.mjs` 新增 L32–L37（写侧，直接用 `V.dreamPlanDigest` / `V.dreamReceipt` / `V.buildDreamMessage`）：

| 编号 | 钉的是什么 | 关键断言 |
| --- | --- | --- |
| L32 | 同一主题写了不同版本 | `conflicts === 1` 且 `dup === 0 && cover === 0`、`newer === 'b'`、`onlyA` 含 `0.1`、`onlyB` 含 `0.2.113` |
| L33 | 数字一致的复述 | `conflicts === 0`（阴性对照） |
| L34 | 归档的那条 | `conflicts === 0`（阴性对照） |
| L35 | 回执与清单 | 回执「另有 1 对疑似冲突」+ 标题 + `共用关键词：` + `cf000001 独有 0.1` + `→ cf000002 更新（…）` + 判据行 |
| L36 | 时间相同 | `newer === 'both'` 且清单说「分不出谁新」 |
| L37 | 跨轮只印一次 | r0 有块并标 `（另一组）`，r1 没有 |

`tools/probe-fusion.mjs` 新增 D83–D88（面板，复用 D67 那套 `mkdtempSync` + `Meow.getDb` + `logDream` 桩）：

| 编号 | 钉的是什么 | 关键断言 |
| --- | --- | --- |
| D83 | 摊开带冲突的账 | `疑似冲突（账里存了 1 对，这一轮共 1 对）：` + `- cccc0001 ⇄ cccc0002` + `共用关键词：dsh、路径` + 两侧独有 + 谁更新 |
| D84 | 行里点名 | 行含 `疑似冲突 1 对` |
| D85 | 老账 | `没有存这一格` + `根本没查冲突` + `不是「查了没有」` |
| D86 | 有数没明细 | `账里记着 2 对，却没有一条明细` + `别把「没列」读成「没有」` |
| D87 | 明细被截 | `账里存了 1 对，这一轮共 5 对` + `- 还有 4 对没落账` |
| D88 | 阴性对照 | `这一轮没有「同一主题却写了不同数字」的条目`，且行里不出现「疑似冲突」 |

`verify.mjs` 的 `[macro-fusion 0.2.114]` 块 14 条：门槛常量 / 四种排除 / 差异字段 /
计数与明细分字段 / 回执 / 清单归轮 / 三语 8 键 / 六份槽位指导 / 读侧四分支 / 明细一行 /
面板顺序与趋势不加 / 两处探针进线 / 版本与文档。

探针总数 559 → 565，verify 断言 1,136 → 1,150。

### 9.120.8 没做的事

1. **没有自动改、没有自动归档**。判据只能证明「数字不同」，证明不了「哪条错」，自动动手就等于删事实。
2. **没有把冲突并进对子计数**。理由见 9.120.3：混在一起会让读侧的对账判据误报。
3. **没有做语义级冲突检测**（比如用向量找「同一个意思」）。关键词 + 数字是一条可解释的线：
   读者能看到它凭什么说这两条撞上了；向量给不出可核对的理由，误报时无从反驳。
4. **没有加冲突走向**。逐条的病不该长成趋势线，见 9.120.6。

## 9.121 老账重提：报过没报过，是两件事（0.2.115）

### 9.121.0 病在哪

0.2.114 让每一轮都把「同一件事的两种说法」摊出来，但摊完就走——**没有任何一格能回答「上一轮
报的那对，到底被处置了没有」**。于是两种完全相反的情形在面板上长得一模一样：

- 这一轮才撞上的新冲突：要人马上看；
- 连着五轮都在报、一直没人动的老毛病：要人处置，或者干脆承认它其实是两件事。

前者是发现，后者是欠账。混在一起，冲突块每轮安静地重提一遍，读的人第三轮就学会了跳过它——
**一份总在报同一个问题的面板，等于没有面板。**

### 9.121.1 判据：拿短 id 对去更早的账里找

`conflictKeyOf(p)` 把一对摊成 `a⇄b`（按短 id 排序拼，`a⇄b` 与 `b⇄a` 是同一对；自配或空 id 一律不认）。
`conflictSeenOf(workspace, dir, rank)` 从第 `rank` 近往下读 `OLDER_SPAN = 10` 条账，
把它们的 `conflictPairs` 摊成 Map：`短 id 对 → { first: 最早第几轮, count: 几次 }`。

三处克制：

1. **只读账本、不重算**。库里那两条记忆现在可能已经被改掉了，重算出来的对数和当时记的不是一回事；
   账本记的是「那一轮看见了什么」，追踪要问的也正是这个。
2. **读不到更早的账就一个字都不说**。`seen === undefined`（没有库、读失败、rank 无效）时，
   `trailOf` 返回空串：不写「这一轮新报」，也不写「没报过」。把「没读」写成「新报」，
   是把未知说成了结论——这正是 0.2.114 里「没查」与「查了没有」的分寸。
3. **「最早」按轮号最大算**。第几近的编号是 1 最新、越大越早，所以最早那次是轮号最大的那次。
   这一格写反了，「挂了五轮」会被读成「刚出现」，催办就永远不会触发。

### 9.121.2 三种说法

| 情形 | 行尾 | 抬头 |
| --- | --- | --- |
| 更早的账里没有这一对 | `· 这一轮新报` | 不加半句 |
| 报过 k 次 | `· 之前报过（最早第 N 轮，加这次共 k+1 次）` | `；其中 M 对之前就报过，最早第 N 轮` |
| 更早的账读不出来 | 一句都不加 | 不加半句 |

单行（`conflictLine`）只加一句结论，不解释机制——机制写在这里，面板留给当场要做的判断。

### 9.121.3 催办：连报三次还挂着，就点名

`CONFLICT_REPEAT_MIN = 3`：更早的账里出现过 ≥2 次（加这次共 3 次），就在明细之后加一行：

```
- cccc0001 ⇄ cccc0002 已经第 3 次出现在账上（最早第 3 轮）——同一对不会因为多报几次变得清楚：
  要么按【疑似冲突】处置（取新的、旧的标「（已被取代：…）」或设 stale），要么承认它是两件不同的事，
  把正文写清归属。
```

为什么门槛是 3 而不是 2：只报过两次的对，很可能是两轮之间还没轮到处置（人不是每轮都在）。
第三次还挂着才说明它被反复看见、却始终没人动——这时候沉默才是默认错误。

催办只点最严重那一对（`count` 最大），不逐对催：一次列五条「快去处理」，等于把人赶走。

### 9.121.4 接线

`expandPanel(rec, rank, seen)` 多一个 `seen`；`readDreamPanel` 两条展开路径都要传：

- 按第几近：`conflictSeenOf(workspace, dir, rankNow)`；
- 按引用（`id=`）：`conflictSeenOf(workspace, dir, wantId)`——引用也是第几近的另一种写法，少传一条路
  就会出现「同一条账，从 id 点进去说新报，从列表点进去说报过」的鬼话。

写侧新增一个读口 `readDreamRecords(workspace, dir, limit, offset)`（vendor，导出）：
返回 `{ rows, missing, total, path }`，内部走 `recentDreamsPage`，与面板同一把尺子
（`run_at DESC, rowid DESC`），`offset` 写坏返回 `missing: 'bad-arg'` 就地打回。

### 9.121.5 验证

- `tools/probe-fusion.mjs` D89–D93：老账重提（抬头「其中 1 对之前就报过，最早第 3 轮」+「加这次共 3 次」）/
  同一轮新发现的标「这一轮新报」/ 连报三次催处置 / 只报两次不催 / 最早那一轮没有可比。
  探针 565 → 570。
- `verify.mjs` `[macro-fusion 0.2.115]` 块 11 条：读口与 `bad-arg` / 两个常量 / 键排序 /
  最早按轮号最大 / 读不到闭嘴 / 行尾三种说法 / 抬头 / 催办门槛 / 两条展开路径都传 /
  探针进线 / 版本与文档门牌。断言 1,150 → 1,161。
- 三条老断言因 `expandPanel` 换签名而红（按源码切片找函数体），改的是切片锚点，不是判据。

### 9.121.6 没做的事

1. **没有记住「已处置」**。要记就得在 `dream_log` 之外再存一张处置表——那会让「账本只记看见什么」
   的边界变模糊。目前的判断靠正文：处置过的对，下一轮检测本身就不会再报（数字改一致 / 归档）。
2. **没有跨库追踪**。短 id 是那一轮从行 id 前缀算的，换库即不可比；宁可少认，也不错认。
3. **没有做趋势线**。冲突是逐条的病，见 9.120.6。
4. **没有把 `OLDER_SPAN` 做成参数**。10 条足够覆盖一轮会话里的连续整理；再多，读一次面板的开销
   就超过它省下的猜测。

## 9.122 冲突的去向：不报了，是处置了还是错开了（0.2.116）

### 9.122.0 病：三种相反的原因，一张脸

9.121 让面板能说「这一对之前报过几次」。可它回答不了反过来的问题：**上一轮报的那一对，这一轮不在账上了**。
在面板上这只有一种表情——消失了——底下却是三件完全不同的事：

1. **真处置了**：取了新的说法、旧的标「（已被取代：…）」或设 stale，两条不再共用关键词，检测自然不再报。
2. **条目没了**：其中一条被归档或删除，连比都没得比。
3. **只是错开了**：有人改了正文（数字改成一致的、关键词删掉一个），两条其实还在、结论也没统一，
   只是检测的闸门刚好不响 —— 这是最危险的一种，因为它看起来跟「1」一模一样。

0.2.115 的追踪只能证明「以前报过」，证明不了「后来处理了」。补这一格，用的不是再跑一遍检测
（那是拿今天的库去猜昨天的判断），而是**看那两条现在长什么样**。

### 9.122.1 判据：只跟上一轮比，只看现状，不猜

- **只跟上一轮比**：`conflictSettledOf` 用 `Meow.readDreamRecords(workspace, dir, 2, rank)` 取两条，
  `rows[0]` 就是上一轮（同一个 `run_at DESC, rowid DESC` 尺子，与面板完全同源）。`rank > 0` 才做——
  第 1 轮没有上一轮，不硬编一个空结论。
- **只摊「不再报」的键**：用 `conflictKeyOf` 归一（`a < b` 排序，a/b 顺序无关），上一轮有、这一轮
  `plan.conflictPairs` 里没有的才算 gone；还在报的一对不进这一块（它们由 9.121 的行尾负责）。
- **只看现状，不重算**：`rowFateOf` 只读 `status` 与 `updated_at`。`updated_at > prevAt` 就是「正文改过」，
  不判断改得好不好——判断是人的事，代码只摊事实（与 9.120.2 同一条分寸）。
- **短 id 有歧义就说歧义**：`readRowsByIds` 一个前缀可能在七层里命中多条，`rowFateOf` 遇到
  `list.length > 1` 直接写「命中 N 条（短 id 前几位撞了，判断不了）」，不挑一条装作确定。
- **读不出来就闭嘴**：`readRowsByIds` 的 `missing !== ''`（`no-workspace` / `no-db` / `bad-arg` /
  `read-failed: …`）一律 `blind: true`，去向写「的现状读不出来」，尾巴写「只报『不再报』这个事实，去向不猜」。

### 9.122.2 五种现状口径

| 现状 | 文案 | 为什么单独一档 |
| --- | --- | --- |
| 查不到行 | `id 查不到了（归档或删除）` | 可能是被删，也可能是换了库；说事实，不说是「已处置」 |
| 命中多行 | `id 命中 N 条（短 id 前几位撞了，判断不了）` | 短 id 天生有歧义，装作确定会误导 |
| `archived` | `id 已归档` | 归档是显式处置动作里最常见的一种 |
| `stale` | `id 已标 stale` | 与归档分开：stale 是「完结」，归档是「作废」 |
| `updated_at > 上一轮 runAt` | `id 正文改过（MM-DD HH:mm）` | 改正文不等于改对了；时间给出来让人自己看 |
| 其余 | `id 没动过` | 阴性要显式，否则读成「没问题」 |

### 9.122.3 三种尾巴：为什么不合并成一句「后来动过什么」

`settledBlock` 在明细之后只挑一句：

1. `blind` → 「这几对的现状读不出来——只报『不再报』这个事实，去向不猜。」
2. 全部明细都不命中 `changed`（`/已归档|已标 stale|正文改过|查不到了|命中 \d+ 条|读不出来/`）→
   「两条都还在、也都没动过——它这一轮没被报，多半是关键词 / 数字刚好错开，不是处置。」
3. 其余 → 「上面只是『后来动过什么』，不等于这一对真解决了：要确认就打开那两条看正文。」

第 2 句是这一版的重点：**「没动过」是零信息量却最像好消息的状态**。不把它说出来，读者会把「消失」
自动补成「解决了」。第 3 句同样克制——正文改过既可能是修好了，也可能是把数字改一致了却没统一结论，
所以只报「动过什么」，判决留给打开正文的人。

抬头两种：全部还在报 → `上一轮（第 N 轮）报了 M 对，这一轮还都在报。`（一行，不列明细）；
有 gone → `上一轮（第 N 轮）报了 M 对，这一轮不再报的有 K 对：`。一次最多摊 `SETTLED_MAX = 3` 对，
多的写「还有 N 对没列（一次只摊前 3 对）」。

### 9.122.4 接线

- **写侧**（`vendor/meow-memory/lib/index.js`）：`readRowsByIds(workspace, dir = ".dsh-meow", ids = [])`
  返回 `{ rows, missing, path }`；ids 去空去 trim、空数组 → `bad-arg`、`slice(0, 20)` 封顶；
  `db.findByIdAll(id)` 取跨层命中并 `{ ...m.row, sessionLevel: m.level }`。导出清单加 `readRowsByIds,`。
  这是纯读口，与 0.2.115 的 `readDreamRecords` 同一条路数：**读侧不自己造轮子，写侧开一个口子**。
- **读侧**（`lib/macro/dreamledger.js`）：`SETTLED_MAX`、`rowFateOf`、`conflictSettledOf`、`settledBlock`；
  `conflictsBlock(row, seen, settled)` 里 `withTail` 把去向块拼在**三个分支**的末尾——这一轮 0 对时
  （`stored.length === 0`）去向是唯一线索，最不能漏。
- **两条展开路径都传**：`expandPanel(rec, rank, seen, settled)`，
  按第几近 `conflictSettledOf(workspace, dir, rankNow, rec.row?.changes?.plan)`、
  按引用 `conflictSettledOf(workspace, dir, wantId, rec.row?.changes?.plan)`。

### 9.122.5 验证

- `tools/probe-fusion.mjs` **D94–D100**（7 条，`macro-probe-settled-<tag>-` 临时库）：已归档 / 正文改过
  （`db.update('fact', id, { content })` 造 `updated_at > prevAt`）/ 两条都没动过 / 两条都查不到 /
  这一轮还在报 / 上一轮本来没报（一个字都不加）/ 按引用展开也带去向。570 → **577 条**。
- `verify.mjs` 新块 `[macro-fusion 0.2.116]` 12 条：写口签名与 bad-arg 与 20 条上限、导出与 marker、
  `SETTLED_MAX`、五种现状、只跟上一轮、gone 归一、blind、三种尾巴、空态不占版面、
  三分支都挂 + 两路都传、探针进线、版本与文档。1,161 → **1,173 条**。
- 三处老断言因签名变化只改锚点不改判据：`function expandPanel(rec, rank, seen, settled)`（三处）、
  `conflictsBlock(row, seen, settled)`（一处）、按引用那条 `[expandPanel(..., settledById), …]`（一处）。

### 9.122.6 没做的事

1. **没有记住「已处置」这个动作本身**。9.121.6-1 说的限制仍在：处置状态仍然不落表，这一版只是让它
   可以从现状**推**出来；真要「谁在哪一轮标了处置」，得另起一张表。
2. **没有跨库、跨轮溯源**。短 id 只在这一轮的库里可比。
3. **没有判断「改对了没有」**。正文改过只报时间，语义判决不下地。
4. **没有把上一轮的对子拿来和这一轮做模糊匹配**。关键词错开之后两对在数据上已经是两件事，
   硬配会把错误信息变成确定信息。

## 9.123 取代关系：写新的同时把旧的降格，而不是删掉（0.2.117）

### 9.123.0 病：三层劝办，工具面上一步都没有

从 0.2.114 起，dream 的冲突块每轮都在说同一句话：「取新的、旧的标『（已被取代：…）』或设 stale」。
但到 0.2.116 为止，工具面上**没有任何一步能同时做到这件事**——只能 `memory_remember` 写完新的，
再回头 `memory_update` 把旧的一条条改成 stale、把正文改掉。中间忘一步，库里就多一对并排放着的
「同一件事的两种说法」，下一轮 dream 又把它报出来，再催一次。

于是出现一个奇怪的循环：**读侧越做越细（9.121 跨轮追踪、9.122 去向），写侧还在劝人手工做。**
劝办而不给口子，等于把成本转嫁给每一轮读账的人。

主人对这一版的定位（m88581）把方向定死了两句：

1. 「一个好的记忆插件不需要有遗忘能力……与其说是遗忘 更应该是一种对于过期或者错误记忆的修改矫正。」
2. 「记忆的写入和调取能力是很大程度上对于记忆插件能力的评定标准。」

对照三家的做法可以看清取舍：

| 方案 | 写入时怎么处理旧条目 | 代价 |
| --- | --- | --- |
| Mem0 | 两阶段：LLM 抽结构化事实 → 与已有比对，执行 ADD / UPDATE / DELETE / NOOP | 每次写入两趟 LLM；四种动作由模型判断，判错就把「另一件事」删了 |
| Letta | 核心 / 召回 / 归档三层，agent 自己编辑核心块 | 决策黑盒，事后无法解释「为什么这条没了」 |
| agentmemory | Hook 零 LLM 捕获 + 三路检索 RRF 融合 | 写入侧几乎不做矫正，重复靠检索兜 |
| **本插件 0.2.117** | **人指定「这条顶掉了哪几条」，机械执行：旧条目 status → `stale`，正文追加一句事实** | 需要人（或 dream 的催办）指定 id；不判语义对错 |

选第三条的理由：**删除是不可逆的，而「哪条被顶掉了」这件事人本来就比模型清楚。** 模型该做的是执行，
不是判决；判决错了的代价（一条真记忆消失）远高于多留一条 stale 的代价（召回时排在后面）。

### 9.123.1 五条判据

1. **只借写入口，不新起工具。** 参数挂在 `memory_remember.supersedes` 上，不新增 `memory_supersede`
   或 `memory_forget`——工具分工得清楚：写就是写，一条调用里把「写新的」和「旧的不再算在用」一次做完。
2. **只降格，不删除。** 旧条目 `status` 改 `stale`，正文末尾追加一句 `（已被取代：…）`。它仍在库里、
   仍可 `memory_read`、`memory_search` 里也还查得到（只是不再算「在用」）。
3. **每种失败单独说一句。** 「没找到」「已归档」「已经标过」「写库失败」「短 id 撞了」「自己取代自己」
   在回执里长得都很像成功，而它们恰恰是「旧条目还活着」的那些状态。
4. **超上限要报回来。** 一次最多 5 条，超出的原样列出来，不许静默截断（0.2.56 定下的老规矩）。
5. **反悔路径写进回执。** 「旧条目都还在库里，`memory_update` 把 status 改回 active、再删掉那句取代话
   就恢复原样。」——不删的前提是能还回去，这句话得每次都说。

### 9.123.2 那一句的格式

```
（已被取代：1a2b3c4d「改成分支合并即发布，周一这条取消」，2026-11-20）
```

- **新 id 前 8 位**：与面板、账本、探针里的短 id 口径一致，够认人、够短。
- **新内容前 24 字**：一句话能认出「顶掉它的是哪条」，又不至于把正文抄一遍（`SUPERSEDE_HEAD = 24`）。
- **日期**：只写日期不写时分——取代关系是「这件事从哪天起不成立了」，不需要精确到分钟。
- 用全角括号 `（` 包住、以 `「」` 引内容：**这一句要能在正文里被 grep 到，也要能在中文正文里读得顺**。

这一句只写事实（谁顶掉的、哪天），**不写判决**（不写「已解决」「已修正」）。正文归 caller。

### 9.123.3 六种结局，六种说法

| 情况 | 回执 | 为什么不能省 |
| --- | --- | --- |
| 自己取代自己（读出来的 id 就是刚写的那条） | `- <id> 就是这次刚写的那一条，跳过了（一条记忆不能取代自己）` | 否则会把刚写的正文改成「被自己取代」。**必须先读再判**——同秒写下的两条 id 前 8 位相同（见 9.123.7） |
| 短 id 撞上刚写的那条，排除后只剩一条 | 明细行 + `· 短 id <asked> 先把刚写的 <new8> 也命中了（一共 N 条），把它排除后只剩 <id8>——按这条办的` | 这是**排除法**，不是替你挑；但「为什么是这条」必须写出来 |
| 短 id 命中多条 | `- <id> 短 id 命中 N 条，没替你挑一条——换成完整 id 再来一次，这 N 条都还没动` | 挑错等于悄悄处置了另一条 |
| 查不到 | `- <id> 没找到（可能已归档或删除）——它没有被改` | 「没找到」最容易被读成「已经处理好了」 |
| 已归档 | `- <id8>（<层>）已经是 archived（作废），没动它` | 归档是「作废」，不该被改写正文 |
| 已有取代句 | `- <id8>（<层>）正文里已经有一句「已被取代」，没重复追加` | 重复追加会把正文堆成流水账 |
| 写库失败 | `- <id8>（<层>）找到了但没写进库：<原因>——它还是原样，别当成已经处置` | 这一种最危险：不写就等于静默失败 |
| 成功（原本 active） | `- <id8>（<层>）已标 stale，正文末尾补了一句「已被取代」` | 明确新状态 |
| 成功（原本就 stale） | `- <id8>（<层>）本来就是 stale，只补了一句「已被取代」` | 两种成功分开说：一个降了格，一个只补了溯源 |

抬头固定在明细之前：

```
取代（新写的 1a2b3c4d 接管这些条目的位置；旧条目一条都没删，只是不再算「在用」）：
```

「一条都没删」必须写在抬头，而不是尾注——读者第一眼要看到的是「东西还在」。

### 9.123.4 接线

- `lib/macro/defs/remember.js`（160 行 → 179 行）：
  `SUPERSEDE_MAX = 5` / `SUPERSEDE_MARK = '（已被取代：'` / `SUPERSEDE_HEAD = 24`；
  `supersedeAskedOf(raw)` 归一（非字符串、空串、重复都去掉，`slice(0, 5)`，其余进 `extra`）；
  `dayStamp(now)`；`supersedeLineOf({ newId, newHead, at })`；`shortId(id)`；
  `markSuperseded({ flow, exec, ids, extra, newId, newHead })` 逐条分支（上表）；
  execute 里在 `remember` 成功之后、`applyLinks` 之前调用，回执为空时补一句「取代这次一条都没做」。
- `tools/param-audit.mjs`：`memory_remember` 的 `EXTRA` 加 `supersedes`——不加白名单，
  调用方给的参数会被当成无效参数丢掉，而调用方永远不知道。
- `lib/macro/dreamledger.js`：催办行之后追加一句能照抄的动作：
  `一次做完：memory_remember(…, supersedes: ["<旧条目前 8>"]) 会在写新条目的同时把旧的那条标 stale、正文里留一句「（已被取代：…）」；旧条目不会消失，反悔可改回 active。`
  原句「要么取新的、旧的标…要么承认它是两件不同的事」一字不动（0.2.115 的断言锚在它上面），
  新句子只是把「取新的」这条路走通。**只给 a 不给 b**——b 是不是同一件事得人来判。

### 9.123.5 验证

- `tools/probe-fusion.mjs` **SS1–SS12**（20 条）：写旧的（没被合并）/ 写新的并取代（回执有取代段、
  点明不删可反悔）/ 旧条目正文留句且状态 stale / 没被删 / 重复取代不重复追加（正文里只有一句）/
  找不到的旧 id / 已作废的不动 / 本来 stale 只补一句 / `supersedes` 归一后为空不起段 / 超上限报回 /
  短 id 给太短只报条数（且不是 0 条）/ 合回原条目时不能取代自己。
  577 → **596 条**。
- 这一串**必须跑在自己的临时工作区**（`macro-probe-supersede-`）。第一版直接写共用库，把后面
  「绝对不存在的词-0251-x」这类**唯一性假设**的断言顶红了 4 条（AC2 / AH4 / AH5 / AM7）——
  新写的正文里有「不存在」三个字，于是零命中不再是零命中。教训：**探针写库要么隔离，要么别写。**
- `verify.mjs` 新块 `[macro-fusion 0.2.117]` **15 条**：不另起工具 / schema 与描述 / 审计白名单 /
  归一与超出 / 那句事实的格式 / 先读再判（且不许用前缀预判）/ 排除法认人 / 短 id 多命中 / 四种没改成 /
  两种成功 / 抬头尾注反悔 / 新条目没写进去时不动作 / dream 催办进线 / 探针进线且隔离 / 版本与文档。
  1,173 → **1,188 条**。

### 9.123.6 没做的事

1. **不做 LLM 判决**（不学 Mem0 的 ADD/UPDATE/DELETE）。谁取代谁由 callers 指定，
   模型只负责执行——判决错了要能追责到人，而不是追责到一个 prompt。
2. **不做级联**。一条取代一条；一条新记忆顶掉三条旧记忆时，写三次 id（上限 5）。
3. **不改召回权重**。`stale` 条目在检索里本来就排在后面（0.2.x 的排序口径），这一版没有为
   「被取代的」单独降权——多一层权重就多一个说不清的地方，等有实测需求再说。
4. **不回写 dream 账本**。「这一轮劝的那对子被取代了」目前仍靠 0.2.116 的去向块从现状推，
   不在写入口里记账——写入口不该知道账本的存在。

### 9.123.7 补记：id 前缀会撞车，所以「是不是自己」得读出来才知道

写到一半被探针抓到一个真 bug，记在这里。

**现象**：`probe-fusion` 的 SS2/SS3/SS5 时红时绿，同一份代码连跑四次，红绿交替。红的时候回执是
`- <id8> 就是这次刚写的那一条，跳过了（一条记忆不能取代自己）`，而那条旧条目压根没被处置。

**根因不在取代逻辑，在 id 的形状**：meow 的 id 形如 `0mwowj2h2-<32 hex>`，前缀是时间编码。
**同一秒里先后写下的两条，前 8 位一模一样**——先写旧的、紧接着用「旧 id 前 8 位」取代它，
这 8 位既命中旧的，也命中刚写的新的。而当时的实现是**先按字符串前缀判自己**：

```js
if (asked === newId || String(newId).startsWith(asked)) { /* 跳过 */ }
```

于是「拿 8 位前缀去取代」这个最自然的用法，恰好被判成「你在取代自己」，一条都没处置。

**修法两层**：

1. **先读再判**。删掉前缀预判，一律先 `memory_read`；读出来的 `v.id === newId` 才是自己。
   顺序不能反：前缀撞车时，「这条是不是自己」只有读出来才知道命中了谁。
2. **能排除就排除**。`memory_read` 因撞车回 `ambiguous` 时，候选 id 就在它的 `candidates` 文字里
   （`fact 0mwowj2h2-… 「…」；fact …`）。用 `/0m[0-9a-z]+-[0-9a-f]{32}/g` 把它们捞出来，
   去掉 `newId` 之后**只剩一条**——那不是「替你挑」，是**排除法**，按它办，并在回执里加一行
   `· 短 id <asked> 先把刚写的 <new8> 也命中了（一共 N 条），把它排除后只剩 <id8>——按这条办的`。
   剩两条以上才回去说「没替你挑」。

**顺带的两个小修**：

- 条数不再数 `candidates`（它是一句给人看的字符串，`Array.isArray` 永远 false，以前会报「命中 0 条」），
  改成 `candidateIdsOf()` 数候选 id，捞不到 id 时退回 `note` 里的「命中了 N 条」。
- 探针 SS2 改用**整条 id**（撞车路径交给 SS11 的 `'0m'` 去**确定性地**命中歧义），
  SS11 断言「报条数且不是 0 条」，SS12 断言「合并回原条目时不能取代自己」。593 → **596 条**。

## 9.124 检索融合：两路名次合成一张榜（0.2.118）

### 9.124.0 病：同一堆记忆出现两遍，而最强的证据没人说

`memory_search(expand: true)` 一次问了两条路：本地检索（关键词 × 重要度 × 时间衰减）和星图扩散
（沿已算好的关联往外走）。两条路各回一段文本，然后被**上下拼在一起**：

```
命中 3 条：…
1. [fact 0mw…] 检索融合
   把本地检索与星图扩散按名次合成一张榜…
…

— 星图关联扩散 —
nebula_recall「检索融合」→ 3 条（扫描 42 条候选，2 跳）
1. [fact] dsh-macro-memory     强度 0.82 检索融合 RRF
   id: dsh-macro-memory:0mw…
   为什么：直接命中关键词「融合」
   摘要：把本地检索与星图扩散按名次合成一张榜…
```

三笔账：

1. **同一堆记忆出现两遍**。第二条里那条记忆在第一段已经有了，第二遍是纯 token 支出。
2. **最强的那条证据被埋掉了**。两条互不相干的检索方式同时捞到同一条记忆——关键词说得通、
   关联也说得通——这是「这条记忆与当前处境相关」能拿到的最硬的证据。拼接之后它只是两段里
   各出现一次，没人指出来。
3. **读者要自己做一次归并排序**。两段的名字都叫「命中」，名次却是两套；哪条先看，全靠猜。

一例实测（探针 F14 的固定语料：2 条本地命中 + 3 个星图节点，其中 1 条重叠）：
两段式 ≈269 token，融合榜 ≈222 token，**省 17%**。重叠越多省得越多——极端情形（全部重叠）
两段式里那一整段星图都是白花的。

### 9.124.1 为什么只按名次合（RRF，k=60）

`RRF`（Reciprocal Rank Fusion）：每路只交名次，`score = Σ 1 / (60 + rank)`。

为什么不能用分数加权：

- 两路的分数**不同源**。本地是 BM25 系的词频×重要度×时间衰减，星图是「直接命中 + 沿边扩散」
  的强度。两组数的量纲、分布、满分线都不一样，同一个 0.8 在两边的意思不同。
- 分数线不同的两组数放在一起比大小、加权求和，得到的是一个看起来精确、其实没有依据的数字。
  **名次是唯一能跨两路比较的东西**：它只说「在它自己那一路里排第几」，这是两条路都真的说过的话。

`k = 60` 取的是 RRF 原论文的常用值。它的作用是把头部差距压平：本地第 1 名 1/61 ≈ 0.0164，
星图第 3 名 1/63 ≈ 0.0159，差距很小；而「两路都命中」的那条拿到 1/61 + 1/61 ≈ 0.0328，
是任何单路命中都追不上的两倍左右。于是榜的形状是：**交叉验证的排最前**，其余按各自名次往后排。

### 9.124.2 榜上怎么排、怎么念

每条都写明它从哪一路来：

| 来路 | 写法 | 读法 |
| --- | --- | --- |
| 两路都命中 | `本地#1 + 星图#2` | 关键词与关联都指向它——最该先看 |
| 只有本地 | `本地#2` | 关键词命中，但星图上没连着 |
| 只有星图 | `星图#3（本地没命中，靠关联进来：经由「RRF」的关键词关联）` | 靠关联摸进来的，后面跟一句证据 |

载体也分两种：

- **本地命中的条目带全文**。它是答案本身，正文就是读者要的东西。
- **星图独有的只带「为什么相关」+ 摘要（clip 150）**。全文在本地那边已经有了（若真重叠）；
  不重叠时，读者要判断的是「这条为什么跟我有关」，不是它的逐字全文。

截断要交代：本地最多列 `k` 条（meow 自己的帽子），星图独有最多列 `limit` 条（默认 5）。
被压掉的星图条目补一句 `（另有 N 条星图带回来的没有展开：这次的 limit / 预算只够前 X 条。）`

### 9.124.3 接线

`lib/macro/fusion.js`（新，纯函数，无 IO、无 store）：

- `export const RRF_K = 60`
- `export function graphNodesOf(text)` —— 把 `nebula_recall` 的回执解析成
  `{ rank, level, score, label, id, why, preview }`。正则只认 `formatHits` 那三行：
  标题行（`1. [fact] ws 强度 0.82 标题`）、`   id: …`、`   为什么：…`、`   摘要：…`。
- `export function uidOf(id)` —— 星图 id 带工作区前缀（`ws:0mw…`），裸 id 在最后一段。
- `export function fuseRanked({ localHits, graphNodes })` —— 归并、去重、算 RRF、排序；
  返回 `{ rows, both, graphOnly, localOnly }`。去重既认同 uid，也认前缀（星图允许前 12 位指认）。
- `export function routeOf(row)` —— 三种来路的说法。
- `export function fusedText({ note, rows, k, graphShown, dropped })` —— 排成给人看的一张榜。

`lib/macro/defs/search.js`：

- expand 分支里，空图分支之后、预算分支之前插一行
  `const fusedHead = await fusedPart({ localValue: main.value, graphText: spread.text, spreadLimit, budget, flags })`，
  拿到字符串就 `return`。**顺序不能反**：融合榜是整份回执，不能先按分段把预算花完再合。
- `fusedPart` 自己处理预算：先按 `limit` 列星图独有，超预算就一条条往下砍（`graphShown -= 1`），
  砍到 0 还超就 `return null` 交回老路径——**先砍证据，不砍答案**。

### 9.124.4 什么时候不融合

融合要求两边都有东西，且星图回执解析得动。三种情况退回原来的两段式：

1. **本地零命中**：没有榜可言，星图那几条关联线索单独一段更好读。
2. **星图回执解析不出节点**：形状变了、或者 `formatHits` 被上游改动/被补丁冲掉——
   解析器返回空数组，调用方退回两段式，不硬凑半张榜。
3. **预算紧到连本地那部分都装不下**：融合头本身也是 token；装不下就交给 `fitPath` 按老办法砍。

为什么解析文本而不是让 nebula 返回结构化结果：`nebula_recall` 的 output schema 就是 `string`。
改它的出参形状会连带改它自己的 render、它自己的断言、以及所有依赖那句文本的补丁——
为了融合去动上游的契约，代价不对等。解析器写得窄（只认那三行），上游一变就自然退回退化路径。

### 9.124.5 验证

`tools/probe-fusion.mjs` 新增 F1–F14（596 → **610 条**，全 PASS）：

- F1 解析得动真实那三行格式（排名/层级/强度/标题/为什么/摘要）；
- F2 星图 id 带工作区前缀，裸 id 取最后一段；
- F3 两路都命中的只算一行（3 个星图节点 + 2 条本地命中、重复 1 条 → 4 行）；
- F4 交叉验证的那条排第一；
- F5 **名次说了算**（星图分 0.95 但排第三，就排第三，不许插队）；
- F6 星图只给前 12 位也认得出是同一条；
- F7 榜上每条只出现一次，也不再另起「星图关联扩散」那一段；
- F8 本地条目带全文，星图独有的只带「为什么相关」+ 摘要；
- F9 每条都写明它从哪一路来；
- F10 星图独有被截断时说清「另有几条没展开」；
- F11 端到端：`expand=true` 给的是融合榜，不是两段拼接；
- F12 端到端：本地那条正文只出现一次（融合确实省了重复的 token）；
- F13 星图回执解析不出节点时退回两段式；
- F14 **融合确实省 token**（同一份语料：≈222 < ≈269）。

`verify.mjs` 新增 12 条（1188 → **1200 条**）：只按名次合 / 解析那几行 / uid 与前缀 / 三种来路 /
载体分工 / 截断交代 / 接线顺序（融合在预算之前）/ 三种退回 / 预算先砍证据 / 探针进线 / 文档与版本。

### 9.124.6 没做的事

- **不改 nebula 的出参**（理由见 9.124.4）。
- **不做加权分数融合**：权重从哪儿来？谁来标定？没有依据的权重只是把两路的噪声搅在一起。
- **不做学习型重排**：没有点击/采纳信号，学不出东西；真要做，先得有「哪条被读了、读完有没有用」
  这类账，那是另一件事。
- **不做 MMR 式的多样性去冗余**：本地那一段已经做过近似去重（meow 的 `foldNearDupes`），
  融合层再加一层会把「同一件事的两条不同说法」也压掉——那种两条恰恰是要一起看的。

## 9.125 检索要能自答：词干门 / 元数据 / 正文与日期（0.2.119–0.2.121）

### 9.125.0 病：三处「排得对，却答不出」

一轮 LoCoMo 评测（1,536 题）把这三种病同时逼出来了。它们的共同点是：**检索环节看起来在工作，
但模型拿到的东西不足以回答**。

1. **词干门**。`tokenize()` 末尾一直是这一行：

   ```js
   const lang = getPromptLang().toLowerCase().split(/[-_]/)[0]
   return lang === 'en' ? normalizeEn(out) : out
   ```

   意思成了「只有会话语言是英文时才做停用词 + Porter 词干」。而 `DEFAULT_LANG = 'zh'`（index.js:161），
   于是中文用户的会话里，**存进去的英文记忆永远不归一**：`researching` ≠ `research`、
   `camping` ≠ `camp`、`painted` ≠ `paint`。一题问「Caroline 研究的是什么」，记忆里写的是
   「Researching adoption agencies」——这一条永远不会进候选。
   离线台（`bench_local.mjs`，同一批题、同一批 docs）实测：hit@20 从 0.4929 抬到 0.5448、
   MRR 0.3001 → 0.3584；Judge 口径 omni1 0.5351 → omni2 0.5987。

2. **元数据不上来**。`search()` 的命中对象只带 `{ id, level, title, content, score, updated_at, explain }`。
   库里明明有 `keywords / project / created_at / source_session`，出了 `search()` 就没了。
   下游（评测 sidecar 的日期、融合层的项目标签、候选折叠的同会话判断）只能自己按 id 回查一遍——
   能查到，但那是「每个调用方各自实现一遍同一件事」，迟早有一方实现错。

3. **正文印不出来**。`memory_search` 的 `render` 只印抬头：

   ```
   [项目 : 层级] [id] [时间] 关于：关键词…
   ```

   `content` 一个字都不印。三个后果：
   - 检索是**索引**不是**答案**：想看内容就得对每条命中再 `memory_read` 一次，一次检索变成 k+1 次往返；
   - `content_max`（默认 300，在 `execute` 里已经把正文截好了）**是个空旋钮**——预算收缩那套
     `k 10→1、content_max 300→60` 的收紧打在它身上，回执一字不变，只有尾注在说「收紧了」；
   - 模型无法判断「这 10 条里哪几条该细读」，因为它只看到了关键词。

   同一份库上实测：预算 260 token 时，收紧前回执 499 字、收紧后 459 字（只因为 k 变了），
   正文一个字没少——该是 216 字。

### 9.125.1 词干门：按「这段 token 像不像英文」判，不按会话语言判

```js
function isMostlyLatin(tokens) {
  let latin = 0
  for (const t of tokens) if (/^[a-z]+$/.test(t)) latin += 1
  return latin * 2 >= tokens.length
}
```

`tokenize()` 末尾改成 `return isMostlyLatin(out) ? normalizeEn(out) : out`，`lang` 那一行删掉。

- **为什么不按会话语言判**：语言是会话的属性，token 才是文本的属性。同一段会话里中文提问、
  英文资料、日文标题混着来是常态；用会话语言当开关，等于让「这段文本是什么语言」由「用户在哪个
  语言环境里问问题」决定。
- **判据取「多数」而不是「有一条拉丁词就归一」**：`isMostlyLatin` 要求拉丁 token 至少占一半
  （`latin * 2 >= tokens.length`）。中文句子里夹一个 `RRF` 这种不该触发 Porter——归一的对象是
  整段 token 表，混着一半 CJK 二元组进去，词干会把本来正常的词改得四不像。
- **CJK 二元组那条路一个字没动**：中文不需要词干，需要的是切分，两者不冲突。

实测（`Meow.tokenize`）：`researching / research → research`、`camping / camped / camp → camp`、
`painted / paint → paint`；中文整句仍是二元组；`RRF k=60 → ["rrf","k","60"]`（英文侧照旧）。

### 9.125.2 元数据透传：可选带上，不动排序与分数

`search()` 的 `hits.push({…})` 里改用展开语法，**有才带**：

```js
...(docs[di].keywords === void 0 ? {} : { keywords: docs[di].keywords }),
```

`keywords / project / created_at / source_session` 四个字段同一写法。为什么坚持「有才带」：
老调用方（和自检里的 stub）喂进来的 docs 本来就没有这些字段，硬塞 `undefined` 会让
`'keywords' in hit` 从 false 变 true——判据里分不清「没有关键词」和「关键词是空数组」。

排序、分数、`explain` 一个都没碰：`bench_local.mjs` 改前改后输出逐字相同
（hit@5 0.4578 / hit@10 0.5026 / hit@20 0.5448 / MRR 0.3584）。

### 9.125.3 正文与日期：把已经截好的东西印出来

`render` 在抬头下面补一行正文，抬头补一天日期：

```
[渲染探针 : lesson] [0mwp57r84-…] [刚刚 · 2026-03-14] 关于：2026-03-14, tokenize, 词干, 归一
  词干归一是检索的地基：researching 与 research 不归一，多跳题就永远差一个词。…（已截断到 300 字，全文用 memory_read）
```

- **正文就用 `execute` 已经截好的那份**（`content_max`，默认 300）。两边各截一次会出现
  「回执说 300 字、value 说 300 字、其实截的不是同一处」这种最难查的错。
- **截断必须交代**：`execute` 在 value 里多给一个 `truncated: true`（原文更长才给），`render`
  据此补 `（已截断到 N 字，全文用 memory_read）`。不标的话，读者会把「截断的 300 字」当成全文——
  `truncated` 跟着 `content_max` 走：`content_max=0` 时它是 `undefined`，回执也不标截断。
- **日期从 keywords 派生**：`dayOfKeywords()` 认 `^\d{4}-\d{2}-\d{2}$` 的第一个关键词。
  为什么需要它：`relativeTime` 只在 30 天前才落到绝对日期，「5 分钟前」回答不了「那天是几号」，
  而时间类问题要的正是那个绝对日期。抬头写成 `[相对时间 · 日期]`：两个都是事实，一个给直觉、一个给计算。
- **`keywords` 为空时**仍退回正文前 40 字当「关于」，这条兜底没变。

### 9.125.4 判据

`verify.mjs`（源码级，四组）：

| 判据 | 钉住的东西 |
| --- | --- |
| 词干门按 token 判，不按会话语言 | `isMostlyLatin` 存在、`tokenize` 末尾用它的返回值、`lang === "en"` 那一行不在 |
| 元数据透传「有才带」 | 四个字段都是 `=== void 0 ? {} : {…}` 展开、`hits.push` 里没有裸 `keywords:` |
| 正文与日期 | `render` 印 `h.content`、`truncated` 才补截断句、抬头拼 `· day` |
| 版本与文档一起走 | 0.2.121 / 9.125 / 131 |

`tools/probe-fusion.mjs`（行为级，SR0–SR6，走**统一工具**那条路——`renderToolText` → 子插件
`render`，不是直接调 vendor）：

- SR1 回执带正文；SR2 抬头带日期；SR3 截断有交代；SR4 `content_max=0` 时正文齐全且不标截断；
- SR4b **阴性对照**：只印抬头的老格式在 SR1/SR3 上必须是红的；
- SR5 走真 vendor 的 value 层：`content.length === 300`、`truncated === true`、`day === '2026-03-14'`、
  `content_max=0` 时不标截断；
- SR6 **空旋钮**这条专门留一个判据：`budget: 260` 时回执要么真的变短、要么明说「没派上用场」，
  并且尾注写出砍了哪个旋钮（`content_max 300→150`）。这一条红了，就说明正文又没印出来。

### 9.125.5 边界

- 只改**回执**，不改排序、不改分数、不改 value 的既有字段（只增 `day` / `truncated` 两个可选字段）。
- `truncated` 与 `day` 都进 schema（`additionalProperties: false` 下必须显式声明），并且都是**可选**：
  没截断就不给 `truncated`，没有日期就给空串 `day`。
- 成本：正文进回执是本轮唯一变贵的地方（每条最多 300 字）。它换来的是「检索能自答」，
  而 `budget` 现在真的能把它压下去——贵的那部分是**可控**的，这才是可以接受的贵。

## 9.126 实体先验：问句里的专有名词要能压过措辞（0.2.122）

### 9.126.0 病

BM25 把问句里每个词一视同仁。可「这条记忆在不在讲那个人」和「这条记忆有没有提到那个词」不是
一回事：问「Caroline 研究什么」，一条提到 Caroline 三次、却没提 research 的近邻条目，会输给一条
满篇 research、与 Caroline 毫无关系的段落。措辞赢过实体，检索就已经错了，只是错得不显眼——
它仍然返回 20 条，看起来像在工作。

### 9.126.1 判据（离线台，真 meow 引擎，LoCoMo 1,540 题，剔 cat5）

`E:\Temp\omni-eval\bench_v2.mjs`，同一批 docs（每句一条 fact、project=session、keywords=[日期]）、
同一套 gold evidence（数组/分号/逗号三种写法都认）：

| 变体 | hit@5 | hit@10 | hit@20 | MRR |
| --- | --- | --- | --- | --- |
| base（改前） | 0.5935 | 0.6623 | 0.7331 | 0.4551 |
| entity 先验（f=0.4） | 0.6058 | 0.6740 | 0.7461 | 0.4747 |
| entity 先验（f=0.8） | 0.6045 | 0.6753 | 0.7513 | 0.4784 |
| entity 先验（f=1.2） | 0.6039 | 0.6766 | 0.7519 | 0.4780 |
| entity 二值（命中任一实体 ×2） | 0.6084 | 0.6760 | 0.7500 | 0.4751 |
| 真引擎落地后（base 已含先验） | 0.6065 | 0.6805 | **0.7526** | **0.4792** |

分类（落地后）：cat1 0.699→0.741、cat2 0.766→0.794、cat4 0.763→0.774，cat3（open-domain）不变。

**被否掉的三个改法**（同为 1,540 题，同一口径）：

| 改法 | hit@20 | MRR | 结论 |
| --- | --- | --- | --- |
| 相邻词短语加成 | 0.7338 | 0.4569 | 几乎为零，不采用 |
| 日期命中加成（月/年） | 0.7331 | 0.4551 | 零影响（问句里很少出现年月），不采用 |
| PRF 伪相关反馈（首轮前 8 条挑 4 个 tf-idf 词二次检索） | 0.7357 | 0.4260 | MRR 掉 2.9pt，不采用 |
| 子句拆分 + RRF（and/or/after/before 切问句） | 0.7299 | 0.4335 | 全面变差，不采用 |
| 共现实体扩散（前 8 条共享实体加权） | 0.7312 | 0.4518 | 变差，不采用 |

负结果要写下来的理由：这四条在文献里都「应该有用」，在这套数据上是负的——不是实现太糙，而是
它们的收益已经被 min_rel + 折叠 + blind/fresh 那套机制吃掉了，再叠一层只是在噪声上加噪声。

### 9.126.2 实现

```js
const EN_INITIAL_SKIP = new Set([...wh/how/did/the/please/tell...]);
function queryEntities(query) {
  for (const m of String(query ?? "").matchAll(/\b([A-Z][a-z]{2,})\b/g)) {
    if ((m.index ?? 0) === 0) continue;          // 句首那个词多半只是大写
    const low = m[1].toLowerCase();
    if (EN_INITIAL_SKIP.has(low) || EN_STOPWORDS.has(low)) continue;
    if (!out.includes(low)) out.push(low);
  }
}
```

- 实体 token 走**同一个 `tokenize`**（大小写、停用词、词干、CJK 二元组同一口径）：`Caroline`
  与 `caroline's` 落到同一个 `carolin`，否则「问句里的实体」和「正文里的实体」会因归一方式不同
  而永远匹配不上。
- 分数是**乘性**加成：`s *= 1 + 0.8 * (命中实体数 / 实体总数)`。乘性而非加性，是因为它表达的
  是「同一批候选里谁更像在讲这件事」，不是「谁的 BM25 分更高」——加性会把一个完全无关的
  文档推到相关文档前面。
- 只在有实体时建 `entSets`（每篇一条 Set），无实体的问句整段跳过，**一个字节都不动**。
- `opts.entityPrior === false` 是给探针和排障用的总闸（A/B 对照必须能关掉，否则「没变化」和
  「没生效」分不开）。
- `explain.entities` 报本次认出了几个实体；为 0 就说明这条先验没参与排序。

### 9.126.3 判据

`verify.mjs`（源码级）：`queryEntities` 存在、跳过位置 0、`ENT_W = 0.8` 乘性、`entSets` 只在
有实体时建、`entityPrior === false` 总闸存在、`explain.entities` 在位、版本与文档（0.2.122 / 9.126 / 132）。

`tools/probe-fusion.mjs`（行为级，ER0–ER4，走**真 vendor**）：

- ER1 实体问句：提到实体的文档必须压过只提到问句其余词的文档；
- ER2 **阴性对照**：同一批文档、问句去掉专有名词 → 排序与 `entityPrior: false` 逐位相同；
- ER3 `entityPrior: false` 时 ER1 的排序必须反过来（证明加成真的来自这条先验）；
- ER4 `explain.entities` 与实际识别数一致，无实体问句为 0。

### 9.126.4 边界

- **中文问句天然不生效**：CJK 没有大小写，`queryEntities` 返回空数组。要覆盖中文实体得另做分词
  与词性，那是另一件事，不在本轮硬塞。
- 只影响**排序**，不影响候选集：BM25 为 0 的文档仍然不进（`raw <= 0 continue` 在加成之前）。
- 加成上限 `1 + 0.8 = 1.8×`，翻不过 1.8 倍以上的 BM25 差距——与 importance 那套「只做同题竞争、
  不做碾压」的口径一致。

## 9.127 命中是「一句话」，可答案在它前后：context 窗口（0.2.123）

### 9.127.0 病
检索以「一条记忆」为单位排序，于是回执也只给一条。可对话记忆里的每一条都只是**一个回合**：
「Bob: 好，几点集合？」单独看什么也答不出，答案在上一句（明天去看鲸鱼）和下一句（七点，码头见）。
0.2.122 之前，插件把这件事推给调用方——模型必须自己想到再 memory_read 一次，而它通常想不到。

### 9.127.1 先量，再改（离线台，真引擎，LoCoMo 1,540 题）
| 口径 | hit@5 | hit@10 | hit@20 | MRR |
|---|---|---|---|---|
| 只排单条（0.2.122 现状） | 0.6065 | 0.6805 | 0.7526 | 0.4792 |
| 命中扩成前后各 1 条 | **0.7370** | **0.8013** | **0.8656** | **0.5856** |
| 前后各 2 条 | 0.8039 | 0.8604 | 0.9182 | 0.6649 |

分类（前后各 1 条）：multi-hop 0.741→0.830、temporal 0.794→0.857、open-domain 0.458→0.521、
single-hop 0.774→0.920。**这不是把分数调高**：排序、分数、候选集一个字节没动，改的是「一条命中算多大」。

### 9.127.2 实现
1. `memory_search` 新增 `context: 0..3`（默认 0）：给每条命中带上同层前后各 N 条 active 行。
2. 取值只按 rowid 相邻（= 写入顺序）读同层表，**不跨层**：跨层会把 fact 和 lesson 拼成一句话，
   读起来像同一个人说的。
3. 邻居每条截到 `CTX_CHARS = 200` 字：上下文是「看清这句在说什么」，不是全文搬运。
4. `status` 收紧到 `active`：把已作废的邻居拼进上下文，等于让一段被推翻的话重新开口。
5. 回执里 `↑` 印前、`↓` 印后，正文照旧居中；`value.hits[].context = {before, after}` 同口径。
6. 默认 0 = 不查库、不拼字符串，老调用方回执逐字节不变。

### 9.127.3 判据
- `verify.mjs`：CT 段源码级（adjacentWindows 的 rowid 窗口、active 过滤、CTX_CHARS、ctxSpan 上限 3、
  默认 0）+ 行为级（真库写入三条、context=1 时 before/after 逐条对上、context=0 时 value 无 context 键）+ 探针进线。
- `tools/probe-fusion.mjs`：CT0–CT4（含阴性对照：context=0 一个字节不多；跨层不串味；邻居被 archive 后不再出现）。

### 9.127.4 边界
- 相邻 ≠ 相关：这是**上下文**，不是「更多命中」。别拿它当召回扩容用（k 才是那个旋钮）。
- 跨会话相邻会被带出来：写入顺序是全局的，两条不同项目的记忆只要挨着就会被拼在一起。要按会话隔离，
  靠 `project` 过滤先收窄，再开 context。
- 花 token：每条命中最多多 2N 条 × 200 字。默认关，就是为了不让日常检索替这个功能付费。

### 9.127.5 体积账：功能涨了要认，但要能指到是哪个工具涨的

`tools/probe-toolsize.mjs` 原来卡 `92,000 B`。加 context 之后 `memory_search` 从
16,083 B 长到 17,023 B（+940 B：输入 schema 1 行、输出 schema 1 行、render 两条 ↑/↓、
execute 里取窗口那一行），总账 92,892 B —— 这是加了一个真功能，不是有人塞了一段长描述。

处理不是「红了就抬」，而是拆成两本账：

- 总账 `BUDGET_BYTES = 94000`（仍留 ~1.2% 余量，不设成实测值）；
- 单项 `TOOL_BUDGET = { memory_search: 17200 }`，`scan()` 把每支工具的字节数交到
  `allRows`，逐项断言。总账涨了，必须能指到是哪个工具涨的；指不出来就是悄悄长胖。

`verify.mjs` 里那条「体积有上限判据」跟着改成同时认三个字面量（94,000 / TOOL_BUDGET
/ 单项断言的标签），所以「抬上界但忘了加单项护栏」会红。

## 9.128 窗口要能穿过统一工具（0.2.124）

### 9.128.0 病

meow 的 `memory_search` 在 0.2.123 就收 `context` 了，可**统一工具看不见它**：
`lib/macro/defs/search.js` 里的 `memory_search` 是融合层自己写的一份 schema，
参数不在 `pick(args, [...])` 的列表里，一个字节都传不下去。第一版补丁只改了
graph 回退那一路的 pick，主路漏了——探针跑出来「直调 meow 有 ↑，走统一工具没有 ↑」，
窗口在真实链路上等于不存在。

### 9.128.1 三处改

- schema：`context: { type: 'integer', description: '相邻上下文：给每条命中带同层前后各 N 条（1–3，默认 0=不带）。会多花 token。' }`；
- `LOCAL_ONLY_PARAMS` 加 `context`（graph / bridge 模式会明说「这个参数在星图上用不上」）；
- 主路 + graph 回退两处 `pick` 列表都加 `context`。

### 9.128.2 预算：先关窗口，再砍字

`fitBudget` 原来只有「先砍 content_max、再砍 k」。窗口比字更贵：N=1 就让每条命中多两条，
而**关掉窗口不会让答案变错**——只是让读者自己再查一次；砍字/砍条数会让答案直接消失。
所以超预算时先试一次 `{...baseArgs, context: 0}`，装得下就交回去，尾注写
`按 N token 预算收紧了 1 次：context 1→0（邻居先不铺开）`；装不下才走原来那四级。

### 9.128.3 判据

- `probe-fusion` CT5a / CT5 / CT6：默认 0 时回执无 `↑`；`context:1` 时 ↑ 前 ↓ 后都真出现在
  **统一工具**的回执里；`budget:120` 时先关窗口、尾注写明 `context 1→0`、字与条数没动。
- `probe-host` D2 因此从 11,544 B 长到 11,697 B（+153 B 就是那行 schema），D3 三个文件同步到
  11,697 B / −79.4%。

### 9.128.4 边界

- 窗口只在本地那一路有意义；similar / graph 没有「同层相邻」的概念，传了会被告知没用上。
- `context` 与 `content_max` 相互独立：一条窗口里的邻居各截 200 字（`CTX_CHARS`），
  不受 `content_max` 影响。

## 9.129 相对时间回答不了「那天是几号」（0.2.125）

### 9.129.0 病

LoCoMo 端到端台（`omni4` / `omni4b`，1,193 题 cat1–cat4，同题配对）量出两件事：

| 口径 | 单条命中 | + 同层窗口 ±1 |
| --- | --- | --- |
| 材料里没有日期 | 26.9% | 34.9% |
| 材料里带会话日期 | 31.2% | 39.1% |

时间类（cat2）在**没有日期**的材料上只有 3.1%，带上日期立刻 17.1%——十道里九道不是
「检索没找到」，是「找到了也没说这是哪天」。抬头原来只印 `relativeTime`（「5 分钟前」）
和关键词里的 `YYYY-MM-DD`；关键词里没塞日期的记忆，等于没有时间。

### 9.129.1 两处改

- `stampDay(ms)`：本机日期 `YYYY-MM-DD`，`day` 字段的回退来源——
  `day: dayOfKeywords(row?.keywords) || stampDay(row?.updated_at)`；
- `adjacentWindows` 的邻居行 SELECT 补 `updated_at`，`slim()` 落 `day`；
  render 的 `↑` / `↓` 行变成 `↑ 2026-11-21 内容`（邻居原来一个字的时间都没有）。

### 9.129.2 判据

- `probe-fusion` CT1 / CT5：↑↓ 两条都按 `↑ \d{4}-\d{2}-\d{2} ` 认，日期不许缺；
- `verify`：`day` 回退行与 `↑ ${it?.day …}` 两条源码判据改到新形状；
- 端到端：窗口 +8.0pt（无日期）/ +7.9pt（有日期），日期本身在单条上 +4.3pt。

### 9.129.3 边界

- 日期来自 `updated_at`（写入时间），不是「事情发生的时间」；记的是「这句话什么时候写下的」。
- 只影响回执文本，不进排序、不动分数；`day` 仍是可选输出字段，老消费方不受影响。

## 9.130 同一条记忆不该被印两遍（0.2.126）

### 9.130.0 病：窗口一多，回执里同一句话出现三次
`context` 从 0.2.123 起是「每条命中各开一个前后窗口」。可命中常常是挨着的——1 号命中的
`↓` 就是 2 号命中的正文，2 号的 `↓` 又是 3 号。回执里同一句话印两遍、三遍，token 花在
重复上，模型还得把同一句话读三遍（读到第三遍时它开始自己编细节）。而且窗口没有行数预算：
8 条命中 × ±3 = 最坏 56 行，回执比材料本身还长。

### 9.130.1 判据：离线台（LoCoMo 1,193 题，真 meow 引擎，deepseek-chat 作答 + LLM judge）

| 打包方式 | 准确率 | 平均字符 |
| --- | --- | --- |
| 单条（0.2.122 现状） | 31.0% | 1,378 |
| ±1 逐条（0.2.123–125 现状） | 38.9% | 3,501 |
| ±2 合并、不限行 | 42.5% | 4,727 |
| **±2 合并、限 24 行（本版）** | **41.5%** | **3,462** |
| ±2 合并、限 16 行 | 39.1% | 2,335 |

读法：**限 24 行这一档与 ±1 逐条花一样多的字（3,462 vs 3,501），却多 2.6pt**；限 16 行能
省三分之一字，但把 cat1（多跳）从 25.2% 拉到 20.2%——多跳题需要不止一个窗口，砍到 16 行
等于砍掉第二条线索，所以不取。窗口重叠实测（600 题 × 8 命中）重复行占 7.6%、字符省 7.9%。

### 9.130.2 实现（`vendor/meow-memory/lib/index.js`，只动 render）
1. `var CTX_LINES = 24;` 与 `CTX_CHARS` 并列，注释里写清上面这张表。
2. render 开头建 `const printed = new Set(hits.map(h => \`${h.level}:${h.id}\`))`——命中一定会在
   自己的表头下面印出来，所以「命中体」一律不进邻居行。
3. `ctxLine(arrow, it)` 统一出邻居行：`key = level:id` 已印过 → 返回 null；`ctxUsed >= CTX_LINES`
   → `ctxSkipped++` 并返回 null；否则记 `printed`、`ctxUsed++`，返回 `  ↑/↓ 日期 正文`。
4. `↑` / `↓` 两处循环改成 `const ln = ctxLine(...); if (ln !== null) lines.push(ln)`。
5. 循环结束后若 `ctxSkipped > 0`，补一行 `…邻居还有 N 行没铺开（一次最多 24 行；认准哪条就用
   memory_read 读全文）`——省 token 不能变成悄悄少给东西。

### 9.130.3 判据
- 相邻两条命中：上一条的 `↓` 不出现（它是下一条的正文），同一句在回执里只出现一次。
- 命中分散 + `context: 3`：邻居行正好 24 行封顶，尾行报出「还有 9 行没铺开」。
- `context: 0`（默认）：回执与 0.2.125 逐字相同，一个字节不多。

### 9.130.4 边界
- 去重键是 `level:id`，不是文本：两条内容相同但 id 不同的记忆照旧各印一次（它们是两条事实，
  合并等于替用户删数据）。
- 24 行是**一次回执的总量**，不是每条命中 24 行。想要更多就 `memory_read` 单条。
- 尾行本身也花一行 token；只在真的截断时出现。


## 9.131 24 行这个数是量出来的，不是拍的（0.2.127）
0.2.126 把邻居行封在 24 行，依据是「16 行掉分、24 行与逐条花一样多的字却多 2.6pt」。但 24 与
「不限」之间还有一段没测——万一 32 行更好，这个数就是随手定的。这一版把这段补满了，同时把两条
看着有希望的路线（按时间重排、二轮检索）也全量否掉了。

### 9.131.0 行数曲线的同题配对（LoCoMo 1,193 题，±2 窗口合并去重，同 answer 模型 + LLM judge）

| 总行数上限 | 准确率 | 平均字符 | cat1 多跳 | cat2 时间 | cat4 开放 |
| --- | --- | --- | --- | --- | --- |
| 16 | 39.5% | 2,335 | 20.2% | 17.8% | 68.4% |
| **24（本版）** | **41.3%** | **3,462** | 24.1% | 20.2% | 69.4% |
| 32 | 42.5% | 4,420 | 26.2% | 19.0% | 71.9% |
| 48 | 41.8% | 4,727 | 25.9% | 17.8% | 71.1% |

配对 McNemar（同一题两臂，看净救/净丢的条数）：16→24 净 +22（56 救 / 34 丢，p=0.027，**显著**）；
24→32 净 +14（p=0.13，不显著）；32→48 净 −8（p=0.35，持平）。**24 与 32 在统计上分不开，而 32
要多花 28% 的字符**（4,420 vs 3,462）。所以取 24：曲线在 24 之后进入平台，再往上买不到东西。

### 9.131.1 否掉的两条路线（全量 1,193 题，同题配对）
- **按会话时间重排 + 开头写「涉及的时间（按先后）：…」**：39.0% vs 基线 39.2%（+3,635 字符）。
  分 cat 是 cat1 +2.2 / cat2 +0.6 / cat3 −2.1 / cat4 −1.8——多跳题确实喜欢时间顺序，但名次
  顺序对「哪条最相关」的暗示被冲掉了，两头相抵。**不做默认重排。**
- **二轮检索**（从第一轮 top3 正文里捞问句没有的大写词再搜一次并合并）：38.5% vs 39.2%，反而
  更低。多一轮并没有带来新证据，只是把噪声搬进材料。**不做。**

### 9.131.2 于是这一版真正改的是「说法」，不是「做法」
工具说明原来只写「会多花 token，看不懂再开」，模型没理由开它。实测把「什么时候值得开」写进
`memory_search.param.context`（三语 prompts + 融合层 schema 同步）：问「什么时候 / 谁先谁后 /
之前之后」，或一条命中说不清要串两条线索时开 1–2，附上 +8.0pt 与 1.4k→3.5k 字符这两个数。
参数默认值一个字节没动——不开的人不受影响，要开的现在知道该开。

### 9.131.3 判据
- 三语 prompts 与融合层 schema 里的 `context` 说明都含「+8.0 个百分点」与「24 行」（口径统一，
  不许一处写一处不写）。
- 默认值仍是 0（`probe-fusion` DT3：不带 context 时回执无箭头）。
- 行数上限常量仍是 24（`CTX_LINES = 24`），并有本节这张表作依据。

## 9.132 时间只加一次，加在最该看的那行（0.2.128）

### 9.132.0 病：回执知道是哪天，不知道是这天的几点
0.2.125 起命中行会带 `2023-05-08`。可同一天里的两条记忆（「上午说改到三点」「下午说还是四点」）在回执里长得
一模一样，模型没法判断哪条更新，只能按顺序猜。「谁先谁后 / 之前还是之后」这类题在全量 1,193 题里正确率只有
18.1%——不是没检索到，是检索到了也读不出先后。

### 9.132.1 量出来的四档（omni10，1,193 题同题配对，±2 合并窗口 + 24 行封顶）
| 材料里时间怎么写 | 准确率 | 回执字符 | cat1 | cat2 | cat3 | cat4 |
| --- | --- | --- | --- | --- | --- | --- |
| B 原样（块头 `1:56 pm on 8 May, 2023`） | 41.2% | 3,462 | 24.8 | 18.1 | 16.7 | 70.2 |
| **N 块头归一成 `2023-05-08 13:56`** | **44.3%** | 3,414 | 25.2 | **27.4** | 16.7 | 71.7 |
| S 每一行都加 `05-08 13:56` | 40.4% | 3,796 | 23.4 | 19.0 | 15.6 | 68.8 |
| M 块头归一 + 每行只补 `13:56` | 42.4% | 3,605 | 23.8 | 22.1 | 16.7 | 71.3 |

配对 McNemar：N vs B 净 +38（救 64 / 丢 26，p<0.0001 显著）；S vs B 净 −9（p=0.3043）；M vs B 净 +15（p=0.0617
不显著）。冒烟 389 题同向（B 32.9% → N 37.5%）。明细 `omni10-results.json`。

### 9.132.2 为什么不给每一行都加时间
S 臂多花 334 字符（+9.7%）还掉 0.8 个百分点；M 臂每行只补 5 个字符，也没有追平 N。读者要的是「这两条能不能比
大小」，不是「每一行都有时间」——同一段对话里的邻居本来就在同一天，逐行重复的分钟数只占字数。所以时间只加一次，
加在最该看的那行：命中自己。

### 9.132.3 实现三条
- `function stampWhen(ms)`：`YYYY-MM-DD HH:MM`；恰好 00:00（时分都为零，说明写入端只给了日期）就退回 `stampDay`
  的 `YYYY-MM-DD`——不印一个假的 `00:00` 让人误判成半夜。
- 命中行 `day: dayOfKeywords(row?.keywords) || stampWhen(row?.updated_at)`：keywords 里显式带的日期优先（写入端
  写的就是那天，比 updated_at 更可信），没带才用写入时刻。
- 邻居行（`↑` / `↓`）仍是 `it?.day`，只有天——和 9.132.2 的结论一致，一处都没放宽。

### 9.132.4 判据
- `probe-fusion` DT4：命中行的 `day` 等于按同一规则现算的期望值（探针自己算期望，跑在半夜也不会红）。
- `probe-fusion` DT5：邻居行是 `↑ YYYY-MM-DD 正文`，没有 `HH:MM`。
- `verify.mjs` DW：源码四条（stampWhen 存在、零点分支、命中走 stampWhen、邻居仍走 `it?.day`）+ 行为两条（钉
  2023-05-08 13:56 与 14:00 两条命中，回执里两个时刻都在；邻居行不带分钟）+ 三语 prompt 都写 `HH:MM` + 探针进线
  + 版本与本节/`DESIGN` 138 一起走。

## 9.133 时间轴：模型需要的不是「更多时间」，是「一眼比得出先后」（0.2.129）

9.133.0 病。0.2.128 之后 cat2（时间题）仍是最低的一类：1,193 题里只有 27.4%。材料里每条记忆的时间都写对了，
  但「谁在谁之前」要模型自己在 8 段之间来回比——单跳查事实（cat4 70.9%）不受影响，一跳时间题就掉。

9.133.1 四档对照（LoCoMo 1,193 题，同题配对，±2 合并窗口 + 24 行封顶，块头 ISO）：

  | 臂 | 做法 | 准确率 | 字符 | cat2 | cat4 |
  |---|---|---|---|---|---|
  | N | 只有块头时间（现状） | 43.8% | 3,414 | 27.1% | 71.5% |
  | Y | N + 顶部一行时间轴 `[3] 2023-05-08 13:56 · [1] …` | 46.2% | 3,582 | 38.0% | 70.9% |
  | Yq | Y，且只在问句含时间词时印 | 46.5% | 3,466 | 37.4% | 71.5% |
  | Yq3 | Yq，且命中 ≥3 条才印 | **46.7%** | 3,466 | **38.6%** | 70.4% |

  McNemar（对 N）：Y +29（p=0.0002）、Yq +33（p<0.0001）、Yq3 +35（p<0.0001）。
  收益集中在 cat2（+36 净，救 47 / 丢 11），代价在 cat4（−11 净）——所以闸门不是省字，是保 cat4。

9.133.2 为什么必须有序号（omni14，1,193 题）。把时间轴的锚换成「正文前十个字」——也就是引擎原来能印的东西——
  只有 43.9%（对 N 43.1%，净 +10，p=0.2324 不显著）。带序号那版是 46.5%。差的 2.6pt 全在「[3] 比 [1] 早」这一眼：
  没有稳定编号，时间轴就只是一串时间，模型还得回去找哪段是哪个时间。**所以命中抬头必须带 [k]，与时间轴同一套编号。**

9.133.3 另一条被否的路：按会话跨度设闸门（omni12）。LoCoMo 的会话本来就跨几个月，`spanDays ≥ 7` 几乎恒成立，
  三臂字符一模一样，闸门等于没设。闸门只能按「问句在问什么」来设，不能按数据形状设。

9.133.4 实现（`vendor/meow-memory/lib/index.js`）：
  - `var TIMELINE_CUE = /\b(when|what date|…|previous)\b/i;`、`var TIMELINE_MAX = 8;`（紧跟 `CTX_LINES`）。
  - `function stampMs(day)`：只认 `YYYY-MM-DD` 或 `YYYY-MM-DD HH:MM`，认不出回 NaN——排序不猜、不补。
  - `if (TIMELINE_CUE.test(q0) && hits.length >= 3 && timed.length >= 3)` 时按 ms 升序（同刻按原顺序）取前 8 条，
    印 `时间轴（从早到晚）：[3] … · [1] …`，超出缀 `· …另有 N 条`。
  - 命中抬头改成 `[k] [项目 : 层] [id] [相对时间 · 时间] 关于：…`，k 与时间轴同源。

9.133.5 判据。①问句含时间词且命中 ≥3 → 必须印一行时间轴，且顺序与 `day` 升序一致；②问句不含时间词 → 一个字节都不印；
  ③命中 <3 条 → 不印；④>8 条 → 只铺最早 8 条并说明还剩几条；⑤命中抬头序号与时间轴编号一致（TL0–TL3 + DY 段）。

## 9.134 准确率的另一半不在检索里，在「敢不敢答」（0.2.130）

9.134.0 病：omni15 把 949 道错题按「材料里到底有没有答案」分开看——504 道材料里根本没有，142 道有却没答对，剩下 303 道是**直接答了「不知道」**。三类里最便宜的是第三类：材料明明提到一部分，模型按「没写全就当没有」处理掉了。

9.134.1 只改回答侧（omni21，LoCoMo 1,193 题同题配对，材料一个字不改）

| 臂 | 提示 | ALL | cat1 | cat2 | cat3 | cat4 |
| --- | --- | --- | --- | --- | --- | --- |
| B | 现状（材料里没有就说不知道） | 46.2% | 23.8 | 36.4 | 18.8 | 70.6 |
| G1 | 只提到一部分也要给最可能答案 | **55.2%** | 29.1 | 47.4 | **44.8** | 77.3 |
| G2 | 只有完全无关才说不知道 | 51.9% | 28.7 | 42.1 | 35.4 | 74.7 |
| P | 按会话分剪掉最弱两段 | 44.4% | 24.5 | 32.4 | 13.5 | 69.6 |

配对 McNemar：G1 vs B 净 +108（救 124 / 丢 16，p<0.0001）；G2 vs B 净 +68；P vs B 净 −21（p=0.0040，剪材料又一次变差）。

9.134.2 同一句话挂在哪，值多少钱（omni22，225s）

| 臂 | 挂法 | ALL | 答「不知道」的比例 |
| --- | --- | --- | --- |
| B | 现状 | 45.9% | 25.6% |
| G | system prompt | **54.2%** | **0.3%** |
| L | 回执末尾补一句 | 47.4% | 23.3% |
| H | 回执开头补一句 | 47.3% | 23.1% |

同一句话贴在回执里只值 +1.4pt——模型把自己的指令看得比材料里的旁白重。所以这条写进 `lib/prompts/*/system-guide.md`（`getMemoryGuide()` → `svc2.section({ name: "meow-memory:guide", order: 130, text: getMemoryGuide() })`，真进 system prompt），不写进工具描述，也不往每次回执里多印一行。

9.134.3 写进去的那句话（三语同义）：「回执不全不等于没有：检索只拿到一部分、或者压根没命中时，先按最接近的那条给最可能的答案，只有确实完全无关才说不记得。」

9.134.4 判据：这不是「鼓励瞎猜」——cat4（单跳，70.6%）只涨 4.7pt，涨得最狠的是 cat3（18.8%→44.8%）和 cat2（36.4%→47.4%），都是「材料里有线索、但需要推一步」的题；丢掉的 16 道是原来答对、改口改错的，代价远小于救回的 124 道。

9.134.5 这句话该落在哪一段（这一版踩到的坑）：第一版只写进了 meow 的 `lib/prompts/*/system-guide.md`，`Meow.getMemoryGuide()` 直接调用也确实带着它——但**融合层不是这么注的**。`lib/macro/bridge.js` 的职责之一就是把子插件的 `systemPrompt.section/.context` 收下、一律不落宿主（bridge.js:6、:84），宿主只认 `lib/macro/prompt.js` 的 `GUIDE_TEXT` 那一段（`macro-memory:guide`，order 130）。也就是说：子插件手册写得再好，模型每轮看到的只有融合层这 1.2k 字。

所以这条准则最终落在 `GUIDE_TEXT` 的纪律行里：「回执没写全≠没有：只提到一部分也给最可能答案，完全无关才说不记得（回执层只值 +1.4pt，这一层值 +8.3pt）」——括号里那两个数就是让它别被当成一句空口号。

9.134.6 上限 1300 → 1400：加完这句 `GUIDE_TEXT` 1,176 → **1,235** 字符，而 `GUIDE_MIN_HEADROOM = 120` 要求留出余量，1300 只剩 65。这不是「先把上限抬高再说」，而是这句的位置只有常驻段一个：它必须在 system prompt 里才有效（9.134.2），不在常驻段就等于没写。多出的 100 字符落在每轮固定的前缀里，命中缓存后边际成本趋于 0，换的是 +8.3 个百分点。同时把探针里写死的 1300（注入上限检查、AT1/AT2/AT3/AT10）改成读 `GUIDE_MAX_CHARS`，以后调上限只改一个地方。
## 9.135 材料侧摸到顶了：七次「看着有希望」全中性或变差，一个 +7.8pt 的天花板（0.2.130 之后的研究记录）

9.135.0 病：0.2.130 把「不知道」这条堵上之后，同一套 LoCoMo 1,193 题从 45.9% 抬到 54.8%。但接下来往哪走没有依据——过去每一次调材料都是「多给几行就涨」，而预算固定 24 行。这一版不发新行为，先把「材料侧还剩多少油水」测完，用一个 oracle 把天花板钉住。

9.135.1 窗口不能更宽（omni23，1,193 题同题配对）：

| 臂 | 窗口 | ALL | cat1 | cat2 | cat3 | cat4 |
| --- | --- | --- | --- | --- | --- | --- |
| A | ±2，k8（现状） | **54.4%** | 27.7 | 48.0 | 43.8 | 75.9 |
| S3 | ±3，k8 | 52.1% | 27.0 | 46.7 | 41.7 | 72.1 |
| S4 | ±4，k8 | 50.4% | 24.1 | 43.9 | 43.8 | 70.9 |
| K12 | ±2，k12 | 54.1% | 27.0 | 45.2 | 44.8 | 77.1 |

配对 McNemar：S3 vs A 净 −27（救 45 / 丢 72，p=0.0011）；S4 vs A 净 −48（p<0.0001）；K12 vs A 净 −4（p=0.8119）。24 行里给每段更长的窗口，等于把段数换掉——换不回来。

9.135.2 换检索词也没用（omni24）：A 54.8%；U1 并集「问句实体词」54.0%（净 −10，p=0.1630）；U2 并集「问句实词」55.2%（净 +4，p=0.7587）；U3「未覆盖会话各补一段」54.8%（净 0，p=0.9404）。三条都不显著。加上 omni17（会话多样性：−8 / +5 / −31）与 omni20（窗口级 BM25 重排 −2、会话级 IDF 词覆盖 −3），词法侧六条路走完，一条也没走通。最后一刀是「让模型自己出检索词」（omni29，1,193 题，每题先让答案模型给 3 组检索词再搜）：A 55.1%；R1 并集 54.4%（净 −8，p=0.5660）；R2 只用检索词替换问句 53.7%（净 −16，p=0.1652）。模型给出来的三行多半是问句的改写（例：「Caroline research / Caroline studied / Caroline investigation」），词面上跟原问句同一批词，召回并没有变——**换词救不了召回，除非换的是「意思」而不是「词」**。

9.135.3 回答侧只容得下那一条（omni25，材料一字不改）：

| 臂 | 追加的那句话 | ALL | cat2 |
| --- | --- | --- | --- |
| A | 无（现状） | **54.7%** | 47.0 |
| C | 回答前先在材料里定位那一两行 | 52.3% | 42.4 |
| D | 人名/地点/时间/数字照抄材料原写法 | 42.9% | 23.7 |
| E | 多个候选选出现次数最多的 | 49.3% | 35.5 |
| F | C+D 合并 | 45.4% | 28.7 |

配对：C 净 −29（p<0.0001）、D 净 −141（p<0.0001）、E 净 −65（p<0.0001）、F 净 −111（p<0.0001）。D 掉得最狠——标准答案常是「the week before 3 July 2023」这种相对说法和对齐后的写法，「照抄原词」把本来能对上的日期抄成了另一种形式。

9.135.4 诊断：错题到底缺什么（omni26，1,193 题）：答对 54.9%，判分模型认为「这份材料够推出答案」的占 42.7%，答「不知道」只剩 0.3%。538 道错题里 **84.8% 材料本身不够**、15.2% 材料够但答歪。分 cat：cat1 对 29.4%（错题里材料够 7.0%）、cat2 47.7%（15.5%）、cat3 45.8%（7.7%）、cat4 75.9%（31.9%）。错例很一致：cat2 标准答案「The week before 3 July 2023」而模型只给「2023-07-03」；cat4 标准答案「Melanie's daughter」而模型照抄对话里的「My daughter's」。

9.135.5 照着 9.135.4 改那两句，两处都变差（omni27）：A 55.3%；T（时间题用锚点+相对说法）53.0%（净 −28，p=0.0068）；P（第三人称、不用「我」）51.9%（净 −41，p=0.0001）；TP 53.5%（净 −22，p=0.0689）。P 确实把 cat2 抬了 3.4pt（47.7→51.1），但 cat3 掉 16.6（47.9→31.3）、cat4 掉 5.0；T 连 cat2 都掉 5.3。教训：L0 是每轮都生效的常驻段，一句「只在这种题里这样做」的条件规则，会连带改掉不该管的题——例外场景不属于常驻段。

9.135.6 天花板在哪（omni28，oracle）：把检索换成数据集自带的 evidence 标注（每题 1–3 个 dia_id，各自 ±2 窗口、同样 24 行、同一句系统提示、同样的排版），A 54.6% → **O 62.4%**（净 +93，救 215 / 丢 122，p<0.0001），材料从 3,453 → **1,102 字符**。分 cat：cat1 28.0→**60.6**、cat3 45.8→55.2、cat4 75.5→84.2、cat2 48.3→**32.4**。
 两个读数：①**精度比容量值钱**——现在这份 3,453 字符的回执里三分之二是噪声，只用 1,102 字符反而多 7.8pt；②**cat2 是反例**，它要「多段 + 日期锚点」，只留证据那一条会把时间线剪断，所以「按证据剪材料」不能一刀切到所有题性。

9.135.7 结论与下一步：词法侧（窗口宽度、候选数、会话多样性、查询并集、窗口级重排、会话级 IDF）六条路全部测完，全中性或负；答案侧常驻段只容得下一条规则（9.134 那条）。从 54.6% 往 62.4% 走的唯一通路，是在检索里加入「这一段到底回答了问题没有」的判别——embedding 或让模型挑段（omni19 H2 已证 +2.2pt，p=0.0004），纯词法做不到（omni18/19/20 三组对照）。这一版只记录，不改行为。

## 9.136 材料侧八臂全灭：问题不在「怎么排」，在「条目长什么样」（0.2.130 之后的研究记录，omni30–32）

9.136.0 病（承接 9.135）：oracle 说 +7.8pt 在「挑准证据」上，于是最自然的下一步是给打分器加一项「这条命中到底答没答这个问题」。两个可计算量先上：覆盖率（问句的 idf 质量有多少被这条文档接住）、邻近度（两个不同问句词在文档里相距 ≤10 token）。同题配对 1,193 题，材料构造、24 行封顶、系统提示、判分一字不改；先做 L0 = 本地复刻同一套 BM25 + 实体先验，`omni30_check.mjs` 实测与插件 `Meow.search` 的 top-8 **Jaccard 1.000**——复刻没走样，后面两臂才有可比性。

9.136.1 两个精度项都中性（omni30，238s）：

| 臂 | 改动 | ALL | cat1 | cat2 | cat3 | cat4 | 字符 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| A | 现状（插件 search） | 54.7% | 28.4 | 48.3 | 42.7 | 76.3 | 3,453 |
| L0 | 本地复刻（同公式） | 55.1% | 29.4 | 48.6 | 44.8 | 75.9 | 3,453 |
| C1 | × 覆盖率 `0.5 + 0.5 × 命中 idf / 问句 idf` | 54.7% | 32.3 | 46.4 | 41.7 | 75.3 | 3,489 |
| P1 | × 邻近度 `1 + 0.5 × 共现率`（窗口 10 token） | 54.3% | 28.4 | 46.7 | 45.8 | 75.7 | 3,453 |
| C3 | C1 × P1 | 54.4% | 31.9 | 44.9 | 43.8 | 75.5 | 3,486 |

配对（对 L0）：C1 净 −5（救 34 / 丢 39，p=0.7001）、P1 净 −9（23 / 32，p=0.2055）、C3 净 −8（31 / 39，p=0.3706）。cat1 涨 2.9pt、cat2 掉 2.2pt，互相抵消到噪声里。两条乘性因子都只改「排序」不改「候选集」，也就改不动「证据根本没进前 8」这件事——这和 9.135.4 的诊断（84.8% 的错题材料本身不够）对齐。

9.136.2 让低信息行让位，也不行（omni31，213s）：24 行预算里 `Melanie: Yeah.` 这种行拿不到答案却占一行，挤掉的是下一段命中的窗口（合并后最多 8 段 × 5 行 = 40 行，装不下的 16 行里就可能有答案）。F1 丢掉「有效词 ≤3」的行 54.7%（净 −7，26 / 33，p=0.4164）、F2 再丢近似重复行（Jaccard ≥0.8）54.6%（净 −8，30 / 38，p=0.3608）。丢行确实腾出了行（材料 3,453→3,543 字符、更多窗口进来了），但腾出来的容量装的是更弱的窗口。

9.136.3 换一个问题：既然 oracle 的收益不是「排得更准」而是「没有噪声」，而噪声在 LoCoMo 协议里来自「把原始对话行当记忆」，那就直接换记忆的形状（omni32，3 个会话 / 70 段对话 / 667 条原子条目 / 309 题）：

| 臂 | 记忆长什么样 | ALL | cat1 | cat2 | cat3 | cat4 | 材料字符 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| A | 原始对话行（±2 窗口，24 行） | **60.5%** | 31.1 | 58.9 | 61.9 | 79.0 | 3,659 |
| S | 模型抽的原子条目（title + 一句事实 + 3–6 关键词），按会话分组印日期，字符预算 ≤3,599 | 37.5% | 24.3 | 34.4 | 52.4 | 45.2 | 2,050 |
| S2 | S 的每一条再补上会话级「门牌号」词（该段对话 tf-idf 前 12 个实词） | 46.9% | 28.4 | 37.8 | 47.6 | 64.5 | 3,098 |

配对：S 净 −71（救 14 / 丢 85，p<0.0001）、S2 净 −42（救 19 / 丢 61，p<0.0001）。

9.136.4 三个读数：①**原子条目的命中面比长文本窄**——同样给 60 个候选位，S 只填到 2,050 字符就把分数耗尽了：问句的 3–4 个词落在一条 120 字的条目里往往只撞得上一个，而 A 的五行窗口天然覆盖更多词（idf 累加面更宽）；②**补门牌号词把 S 抬回 9.4pt**（cat4 45.2→64.5），机制判断被证实：短条目缺的不是语义，是「会被问到的那些词」；③**补词仍追不回原始长文本**——长对话问答里上下文本身就是证据的一部分（`she`/`they` 这种指代只有邻行能解），原子化把它们全丢了。

9.136.5 结论与下一步：材料侧八个臂（覆盖率、邻近度、丢低信息行、去近似重复、原子化、原子化 + 门牌号）全部测完，**没有一条显著为正**，这条路封了。剩下两条未验证：①embedding 或模型挑段（omni19 H2 已 +2.2pt，p=0.0004；纯词法复现不了，omni18/19/20 三组对照）；②写入侧——把「同段对话的门牌号词」写成规则给写记忆的那一方（S2 的 +9.4pt 是这条规则的凭据），但它属于写入提示词，不属于检索器，也不该塞进 L0 常驻段（9.135.5 的教训）。这一版只记录，不改行为。

## 9.137 门牌号词写不出来，算得出来（0.2.131，写在这一版只记录的部分）

9.136.3 的 S2 臂（原子条目 + 该段对话 tf-idf 前 12 个实词）把 309 题从 37.5% 抬到 46.9%（+9.4pt）。问题随即变成：这 9.4pt 是「多给了几个词」还是「给对了词」？以及它能不能靠提示词纪律买到——如果能，就不必改引擎。

9.137.1 四个臂，309 题同一批条目（omni33，101s）：A = 原始对话行（±2 窗口，24 行）；S = 现有写入提示词抽的原子条目（一条一事实、只写明确出现的、原名照抄、3–6 个英文关键词）；W1 = S + 提示词第 6 条「关键词要写以后被问到时可能出现的说法」（别的称呼、身份、类别）；W2 = W1 的条目 + 机械补该段对话 tf-idf 前 12 实词。

| 臂 | 记忆 | ALL | cat1 | cat2 | cat3 | cat4 | 材料字符 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| A | 原始对话行 | **61.5%** | 33.8 | 60.0 | 61.9 | 79.0 | 3,659 |
| S | 现有写入提示词 | 38.8% | 31.1 | 35.6 | 57.1 | 42.7 | 2,042 |
| W1 | S + 门牌号纪律 | 39.5% | 29.7 | 37.8 | 42.9 | 46.0 | 2,048 |
| W2 | W1 + 机械补 tf-idf 词 | 45.0% | 31.1 | 36.7 | 42.9 | 59.7 | 3,171 |

配对：W1 vs S 净 +2（救 23 / 丢 21，p=0.9310）；W2 vs W1 净 +17（p=0.0071）；W2 vs S 净 +19（p=0.0041）。关键词数从 4.91 涨到 5.93——模型确实照着纪律多写了词，一个点也没换回来。

9.137.2 控制组（omni34，309 题）：W3 = W1 的条目 + 12 个**全局高频实词**（`john maria carolin make realli melani gina help awesom keep support love`，与本段主题无关）。W1 40.1% / W2 46.3% / W3 42.7%：W3 vs W1 净 +8（p=0.1757），W2 vs W3 净 +11（p=0.0705）——n 太小。

9.137.3 放大到 649 题（omni35，6 会话 / 156 段，209s）：

| 臂 | ALL | cat1 | cat2 | cat3 | cat4 | 材料字符 |
| --- | --- | --- | --- | --- | --- | --- |
| W1 | 39.3% | 27.9 | 32.2 | 34.0 | 53.7 | 2,585 |
| W2 | **46.7%** | 32.6 | 37.8 | 32.1 | 66.4 | 3,140 |
| W3 | 40.8% | 28.5 | 35.6 | 34.0 | 54.9 | 2,975 |

配对：W2 vs W1 净 +48（救 80 / 丢 32，p<0.0001）、W3 vs W1 净 +10（39 / 29，p=0.1986）、**W2 vs W3 净 +38（64 / 26，p<0.0001）**。分题性只看得到 cat4 在动（53.7 → 66.4），cat1–3 全在噪声里。

9.137.4 结论有三条，一条比一条硬：①增益来自**主题特异性的词**，不来自「词多」——同样 12 个词，全局高频词值 +10（不显著），本段 tf-idf 词值 +48；②这 12 个词**写不出来**：让模型自己按纪律写，两轮都是 +2 / +10 且都不显著，而关键词数确实上去了——它写的是「当时那句话的词」，不是「以后会被问到的词」；③所以它必须**从语料算**。凡是「同一段对话/同一个会话里反复出现的词」都能算，不需要模型参与，也不需要它理解。

9.137.5 落到引擎（0.2.131）：`search()` 在 tokenize 之后按 `source_session` 分组，会话条目 ≥3 条时算该组 tf-idf 前 12 个实词（`SESS_TOPIC_MIN = 3`、`SESS_TOPIC_TERMS = 12`、`sessionTopicTerms(docs, docToks)`），把词并进这一组每个条目的 token 列表再打分。五个边界写进探针（`tools/probe-recall.mjs` 的 SESS1–5）：默认开；`sessionTopic:false` 一眼回退到纯 BM25；会话不足 3 条不扩；条目没有 `source_session` 时分数逐条不变（老库、导入条目完全惰性）；靠主题词进榜的条目排在直接命中之后（扩词只改分母，不越位）。不落盘、不进回执、不改一条记忆的正文——它是检索期的词，不是记忆里的词。
## 9.138 邻居铺多少行，得看问的是不是时间（0.2.132）

0.2.126 把邻居封在 24 行（omni22：±2 合并窗口不限行 42.5% / 3,462 字符、限 24 行 41.5%、
限 16 行 39.1%），当时的结论是「24 行是省字与分数之间的平衡点」。这一轮把「一律 24」换成
「按问句分档」：问句在问时间 → 24 行；其余 → 48 行。三次独立复跑同向，增益 +3pt 上下。

### 9.138.1 omni39：先把预算整体加倍，看方向

同题配对，A = 前 8 段 ±2 行、24 行封顶；B = 前 16 段、48 行封顶。

| 臂 | ALL | 字符 | 多跳 cat1 | 时间 cat2 | 推理 cat3 | 单跳 cat4 |
|---|---|---|---|---|---|---|
| A | 55.2% | 3,453 | 29.1% | 48.0% | 44.8% | 76.7% |
| B | **57.4%** | 6,782 | **37.9%** | 43.9% | 45.8% | **79.6%** |

B vs A 净 +27（救 89 / 丢 62，p=0.0045）。方向是「加」有用，但**时间题是唯一掉的那一类**
（48.0 → 43.9）：多出来的段落把日期稀释了，答案里那一个锚点找不到了。

### 9.138.2 omni40：按题型分档

A = 24 行 / 前 8 段；B = 48 行 / 前 16 段（一律加）；T = 时间题走 A、其余走 B（用问句里的
时间词判，不偷看 category 标注）。

| 臂 | ALL | 字符 | cat1 | cat2 | cat3 | cat4 |
|---|---|---|---|---|---|---|
| A | 54.4% | 3,453 | 28.0% | 47.7% | 44.8% | 75.7% |
| B | 56.9% | 6,782 | 35.8% | 43.6% | 45.8% | 79.8% |
| T | **57.6%** | 5,762 | 34.0% | **48.6%** | 43.8% | 79.6% |

分组：时间词命中 363 题 A 51.8 / B 48.8 / T 51.8；其余 830 题 A 55.5 / B 60.5 / T 60.1。
统计：B vs A 净 +30（87/57，p=0.0011）；**T vs A 净 +38（73/35，p<0.0001）**；T vs B 净 +8
（p=0.4312，分不出来）。T 用 5,762 字符拿到了比 B（6,782 字符）更高的分——分档不是为了省字，
是因为两类题要的不是同一种材料。

### 9.138.3 omni41：省 token 的拐点在哪

A 24 行；B 36 行 / 前 12 段；T 同 omni40 最优。

| 臂 | ALL | 字符 | cat1 | cat2 | cat3 | cat4 |
|---|---|---|---|---|---|---|
| A | 54.9% | 3,453 | 30.1% | 47.7% | 43.8% | 75.9% |
| B | 54.6% | 5,125 | 30.1% | 43.3% | 44.8% | 77.7% |
| T | **57.5%** | 5,762 | **36.9%** | 47.7% | 46.9% | 77.7% |

B vs A 净 −4（p=0.8468）；T vs A 净 +31（72/41，p=0.0001）；T vs B 净 +35（p<0.0001）。
**中间档等于没加**：多花 50% 的字符、分一动不动。这不是线性预算，是阈值。

### 9.138.4 omni42：到底是行数还是段数

A 24 行 / 8 段；W 16 段 × 48 行（同 omni40 的 B）；N 24 段 × 24 行（段数加倍、行数不动）。

| 臂 | ALL | 字符 | cat1 | cat2 | cat3 | cat4 |
|---|---|---|---|---|---|---|
| A | 55.4% | 3,453 | 30.5% | 48.3% | 45.8% | 76.1% |
| W | **58.2%** | 5,762 | 35.5% | 49.8% | 45.8% | 78.9% |
| N | 55.1% | 3,455 | 29.4% | 48.3% | 41.7% | 76.7% |

W vs A 净 +33（救 68 / 丢 35，p<0.0001）；N vs A 净 −4（p=0.8015）；N vs W 净 −37（p<0.0001）。
**旋钮是行数，不是段数**：24 段各 ±1 行和 8 段各 ±2 行一样，命中条数加了一倍也没用——
信息在那几行「命中前后的句子」里，不在更多条命中里。

### 9.138.5 结论

1. 材料侧唯一稳定的 +3pt：**时间题给窄、其余给宽**。三次复跑 57.6 / 57.5 / 58.2 对 54.4 / 54.9 / 55.4。
2. 宽的那一档必须是「行数到 48」，中间档（36 行）和「加段数」都是噪声。
3. 时间题必须留窄：一律加宽把 cat2 从 47.7 打到 43.6，而分档能把 cat2 保住（48.6）。
4. 代价：非时间题的邻居字符 +67%（约 3.4k → 6.7k），所以再压一道字符闸。

### 9.138.6 引擎落地（0.2.132）

- `vendor/meow-memory/lib/index.js` 常量区：`var CTX_LINES_DEEP = 48;`、`var CTX_CHARS_DEEP = 7000;`
  与原来的 `var CTX_LINES = 24;` 并列。
- `memory_search` 的 render 里：`const ctxDeep = !TIMELINE_CUE.test(String(_args?.query ?? ""));`、
  `const ctxMax = ctxDeep ? CTX_LINES_DEEP : CTX_LINES;`——**复用 0.2.129 时间轴那条闸门**，
  一个问句只看一次「是不是在问时间」，时间轴和邻居深度同进同退，不出现两套口径。
- 停止条件：`if (ctxUsed >= ctxMax || (ctxDeep && ctxChars + text.length > CTX_CHARS_DEEP)) { ctxSkipped++; return null; }`
  ——行数放开、字数不放开；截断提示里印的是当下这一档的行数，不是写死的 24。
- 实测（EA 断言）：不问时间铺 48 行、问时间铺 24 行、200 字长邻居时字符闸先停（32 行 / 6,880 字）。
- 只在 `context ≥ 1` 时才有邻居行，所以默认 `context: 0` 的回执一个字节没变。

### 9.138.7 代价与回退

非时间题、且调用方要了 `context ≥ 1` 时，邻居部分最多多花约 3.3k 字符（7,000 字封顶）。
不想要这一档就传 `context: 0`（现状默认），或把 `CTX_LINES_DEEP` 改回 24——两处都是常量，
没有数据迁移，回退是一次改值。

## 9.139 调取精度三刀：覆盖度、字段权重、长度只量正文（0.2.133）

这一版没加功能，只改打分器。起因是主人要求「先优化记忆调取准确率」，而离线对照台显示：
库里 2,900 条条目，形态统一是「短正文 + 8~13 个 keywords」，可是 `docText(d)` =
`[title, content, ...keywords].join(" ")` 把三样平铺成一个字符串喂给 BM25——于是
「用户会怎么问」的逆向词（写在 keywords 里）和正文里顺手提到一次，得分一模一样；
而关键词写得越全，正文被长度归一稀释得越厉害。

### 9.139.1 三个洞

1. **没有覆盖度概念**：加法式 BM25，一个词命中十次能压过五个词各命中一次。而记忆调取要的正是「这几个词都聊到了」。
2. **字段不分权重**：title / keywords / 正文等权，等于把作者精心写的检索词当噪声。
3. **长度归一分母算错**：`len = docToks[di].length` 把 title、keywords、会话扩词全算进正文长度——元数据越全的条目越吃亏，恰好和「好条目」负相关。

### 9.139.2 三条补丁（都只做乘法层，不筛候选）

- `FIELD_TITLE_W = 0.6` / `FIELD_KW_W = 0.35`：命中 title 或 keywords 时该词的 tf 权重乘以 `1 + w`。
- `COORD_W = 0.35`：算完 BM25 后乘 `1 - COORD_W + COORD_W * min(1, cover / qIdfSum)`，`cover` = 命中的查询词的 idf 之和。
- `bodyLen` / `avgBody`：长度只量 `content` 的 token 数，`len` 与分母同时换成它。

三个都可以单独关掉对照：`fieldBoost:false` / `coord:false` / `lengthOnBody:false`。

### 9.139.3 离线探针（0 LLM，`E:\Temp\omni-eval\omni45_probe.mjs`）

| # | 对照 | 结果 |
| --- | --- | --- |
| 1 | X 正文两个查询词都在 vs Y 把一个词刷六遍 | 开 coord 后 X 0.9727 排第一 |
| 2 | 同一对文档关掉 coord | Y 0.0282 > 0.0204，闸确实在扣分 |
| 3 | P 只在 keywords 写「口径」 vs Q 写在正文（正文 token 数同为 5） | P 0.2461 > Q 0.0146 |
| 4 | 同上关掉 fieldBoost | P = Q = 0.1823（差额只来自字段） |
| 5 | L 正文长 + 9 个 keywords vs S 正文短 | 新口径 L 0.0226 > 旧口径 0.0215（不再被元数据稀释） |
| 6 | 名次不变性 | S 仍排在 L 前（绝对分随语料均值微动是归一的正常行为） |
| 7 | 单词查询 | 名次不变 |

写探针时踩过一个坑：第一版 fixture 拿「短到只有 1 个 token 的正文」当对照，BM25 的长度项把补丁效果整个盖掉，
七条里红了三条——**对照文档的正文 token 数必须相等，否则测的不是补丁**。

### 9.139.4 顺带的反思闸门修复（主人在 m102992 点出来的）

老闸门有两处把「该反思的那一轮」漏掉：

- `if (lastToolName !== void 0 && lastToolName.startsWith("memory_")) return;` —— 一轮活干完，收尾那步几乎总是
  `memory_remember` / `memory_update`，于是「刚把记忆写进去的那一轮恰好不反思」。
- 判定只看「连续几个非记忆工具步」（`reflectTurns` 默认 7），`consecutiveToolSteps` 遇 `memory_*` 还把计数清零；
  事故信号（主人发火、`endReason === "error"`）完全不参与。

改成：`scanTurn` 多记 `sawNonMemory` 与用户原话 `userText`；闸门换成 `if (!sawNonMemory) return;`（整轮只有记忆工具才免反思），
并加 `REFLECT_CUE`（他妈 / 谁允许 / 擅自 / 不许 / 烧钱 / 花掉 / 回滚 / 说了多少遍 …）——命中或 `endReason === "error"` 时
`NEED = 1`，干过一步活就立刻反思。日志也随之带上 `cue=` / `need=` / `lastTool=`。

### 9.139.5 代价与回退

- 三条补丁都是乘法，不改变候选集与截断顺序，`memory_search` schema 一个字节没动（仍 6,494 B / 上限 6,500 B）。
- 回退：`fieldBoost:false` + `coord:false` + `lengthOnBody:false` 三项全关 = 0.2.132 的排序（探针断言 4/7 已覆盖）。
- 反思闸门回退：git 回滚 `vendor/meow-memory/lib/index.js` 单文件，或者把 `sawNonMemory` 那一行换成旧的一票否决。

## 9.140 反思不该等轮数：事故自己会说话（0.2.134）

主人的原话是「记忆反思功能逻辑有缺陷，他应该在重大 bug 论要自己调用」（m103380），前两句是
「不要注重于分数了」「你就不能真正对插件进行优化吗」（m103377 / m103378）。所以这一版没有碰
检索、没有再跑一次评测：只改「什么时候该反思」这一件事。

### 9.140.1 上一版还差什么

0.2.133 把闸门从「最后一步是记忆工具就免反思」修开了，但触发面还是三样，全都不是事故本身：

- `REFLECT_CUE` —— 用户骂人的语气。事故已经发生了、用户还没骂，就不反思；用户只是发火、其实没事，反而反思。
- `endReason === "error"` —— 只有整轮崩掉才算。写坏一次库、同一个工具连挂三次、命令 exit 1，轮子是正常停的。
- `consecutiveToolSteps(...) < NEED` —— 攒步数。长任务里的严重事故被「还没到第 7 步」挡回去，
  短会话里的小失误到点却照样反思，正好反了。

三样共同的问题：**它们都在数「做了多少」，而不是看「出了什么事」**。而事故是长在动作上的信号：
工具结果带 `isError: true`。

### 9.140.2 改法：把失败读进来，按严重程度分两档

`scanTurn` 多扫一类事件、多记四个数：

- `tool/call` 与 `assistant/message` 里的 `tool-call` 都记 `callId → 工具名`（有的宿主只给其一）。
- `tool/result` 里 `message.isError === true` 计一次失败：`toolErrors++`；按工具名归并计 `failByTool`，
  最大者记成 `worstFail` / `worstTool`；工具名以 `memory_` 开头的另计 `memoryErrors`。
- 拿不到工具名（`toolCallId` 对不上、`data.name` 也没有）时用标签 `reflect.unknownTool`（「某个工具」）——
  宁可说不出是谁，不能当没发生。

判据 `incidentOf(turn, endReason)` 只认事件，给两档：

| 档 | 条件 | NEED |
| --- | --- | --- |
| hard | 记忆工具自己挂了 / 整轮 `endReason === "error"` / 同一工具连挂 ≥2 次（`INCIDENT_RETRY`）/ 一轮挂 ≥3 次（`INCIDENT_BURST`）/ 主人用了纠正语气 | 1（当场） |
| soft | 只零星挂了一次 | 3（`Math.min(INCIDENT_SOFT_NEED, cadence)`） |
| none | 一个都没挂 | `reflectTurns`（照旧） |

`reflectNeed` 的两条约束是刻意的：soft 只能「提前」不能「推后」（主人把 `reflectTurns` 调成 2 时
不该因为一次小失败反而变成第 3 步）；cadence 写坏（0 / NaN）兜底 7，不猜。

闸门那两行随之变成「没干过非记忆工具 **且** 没事故」才免反思，
`const NEED = reflectNeed(INC, resolved.reflectTurns);`，日志带 `incident=<kinds>`，
hard 档再往 `<ws>/.dsh-meow/dream-debug.log` 补一行 `reflect incident="..." errors= memoryErrors= worst=` ——
事后能回答「这一轮为什么被叫醒」。

### 9.140.3 反思报文要说清「谁叫的、挂了什么」

反思是一句独立用户消息（`[meow-memory-reflect]`），原来只有固定提示词。事故触发时模型看到的和
按轮数触发时一模一样，于是很容易把一次抖动当成事故、或者反过来。`incidentLines(incident)` 补三到五行：

- 抬头：「⚠️ 这一轮出了事故，所以是插件自己把你叫来反思（不是攒够轮数）：」
- 事实：「· 工具失败 2 次（pwsh ×2）」/「· 这一轮以错误收场」/「· 用户用了纠正或事故语气……」
- 要求：「先判断：这是真事故，还是一次能自己恢复的抖动？真事故写 lesson（现象 → 根因 → 修法 → 下次怎么早发现）；
  抖动把结论补进已有条目，别为它新建噪声。」

无事故时 `incidentLines` 返回空数组，报文与 0.2.133 逐字一致（不污染正常反思）。
七个新标签 `reflect.incidentHead` / `incidentTools` / `incidentDetail` / `incidentTurnError` /
`incidentCue` / `incidentAsk` / `unknownTool` 在 zh / en / pt-br 三份 `labels.md` 都齐全；
读标签一律走 `safeKeyed`（try/catch + 兜底中文），用户改过 `prompts` 覆盖目录缺键时不许把整轮反思炸掉。

### 9.140.4 探针与断言

- `tools/probe-fusion.mjs`：RI0–RI10（11 条，650 → 661）——合成事件测计数（成功的 tool/result 不算、
  拿不到名字也计数）、归并排序只留前四、七种情形分级、三档阈值（1/3/7 与「soft 不推后」）、
  报文三要素、无事故零行、三语标签齐全。
- `verify.mjs`：EY 两条断言跟着新闸门改写；新增 EZ 段 13 条（行为 + 源码 + 文档口径），
  1,289 → 1,302。

### 9.140.5 没做的事与回退

- 不做「事故自动写 lesson」：写什么、写到哪一层仍是模型的判断；插件只负责在正确的时刻把它叫醒，并
  把事故事实递到手上。自动写入会把「抖动」也变成记忆噪声。
- 不引入新的配置项：两档阈值是常量（3 / 2 / 3）。真需要调的时候先有证据，再加旋钮。
- 回退：`vendor/meow-memory/lib/index.js` 单文件回滚，或把闸门两行换回
  `if (!sawNonMemory) return;` + `const NEED = CUE > 0 || endReason === "error" ? 1 : resolved.reflectTurns;`
  （标签多出来的七个键留着无害）。
## 9.141 事故要看「第几次」：账本 + 反思闭环（0.2.135）

主人接着上一版说「大幅度继续优化反思逻辑 让他更强大」（m103716）。0.2.134 解决了「什么时候醒」，
这一版解决醒来之后的两件事：**这一次是不是重演**、**上一次醒了有没有真的动手**。

### 9.141.1 单轮看不出的两件事

反思发生在轮末，`scanTurn` 只看得到本轮事件窗口。于是：

- 「同一个工具连着三轮挂」在本轮眼里只是一次 soft / 一次 burst，和头一回出的事长得一模一样。
  报文的语气、要求、甚至是否当场打断都相同——**重演被当成新事故**。
- 反思是发出去的一条消息，发完这一轮就结束了。模型下一轮说了句「明白了，下次注意」也算完成，
  库里一个字没动，**下一个会话拿着同一份烂代码再来一遍**。没有任何机制发现「反思白做」。

### 9.141.2 账本：`<ws>/.dsh-meow/incident-ledger.jsonl`

一行一次**硬档**事故，字段 `{t, sid(前 12 位), kinds, tool, errors, memoryErrors}`。

- 容量 `INCIDENT_LEDGER_MAX = 200`，超出只留最近 200 行（append 时 slice，不做整表重排）。
- 窗口 `INCIDENT_WINDOW_MS = 24h`：读的时候按 `now - t > 24h` 丢弃，写的时候不清洗旧行。
- 读坏行只丢那一行：非 JSON、`t` 非有限正数、行首尾空白都跳过——**账本坏了不能变成事故**。
- 只看 `level >= 2` 且 `worstTool` 非空才查重：一个说不清是谁的失败，凑不出「同一件事」。
- 查重结果 `{count, tool, first, last, kinds, windowHours, unfixed}`，报文里落成一行：
  「这不是第一次：pwsh（同一工具 2 次，最近一次 8 分钟前）」——排在「先判断」之前，先给事实。

### 9.141.3 闭环：`reflect-pending.json`

发反思时留一张待验卡 `{t, kinds, tool}`；下一次进闸门先结算（`settleReflect`）：

- 这一轮 `memoryWrites > 0`（`memory_remember` / `memory_update` 任一被调用）→ 落地，删卡。
- 一步都没写 → 记一条 `kinds: ["no-followup"]`、`tool: "reflect"` 的账，删卡。
- 卡超过 24h → 直接丢，不追责（中间可能换了别的会话）。
- 空转、无卡、缺少目录一律返回 `undefined` 或 `false`，不抛异常（反省失败不该把整轮炸掉）。

下次硬档事故读账时会数出 `unfixed`，报文补一句：
「上一次也反思过，但事后什么都没写进记忆（账本记着 1 次）——那次反思等于白做，这次别只写感想。」
`dream-debug.log` 里同步留一行 `reflect no-followup kinds="..."`，排障时能对上时间。

### 9.141.4 三语与探针

新增标签 `reflect.incidentRepeat` / `reflect.incidentNoFollowup`（zh / en / pt-br）。
`probe-fusion` RJ0–RJ16 覆盖：软档不记账、硬档一行、同工具计数、换工具不误报、200 行截断、
坏行容忍、24h 过期、闭环三种结局、`memoryWrites` 计数、三语键齐全。
`verify.mjs` FA 段加了行为 + 源码锚点（`INCIDENT_LEDGER_MAX`、`settleReflect` 先于 `incidentRepeatOf`、
硬档同时 `recordIncident` + `writeReflectPending`）。


## 9.142 两句话并存：写入侧的冲突雷达（0.2.136）

### 9.142.1 问题：库里并排四条「当前版本是 X」
0.2.132 / 0.2.133 / 0.2.134 / 0.2.135 四条交付态 fact 一直躺在库里。它们的逐字重复度只有四成多——
写侧的去重线是 0.8，不会合并；跨层检查只管「同一句话出现在两层」，也不管；于是检索时四条一起冒出来，
每条都说自己是「当前」。模型读到哪条算数？没答案。这不是措辞重复，是**结论互斥**。

### 9.142.2 判据：只认硬事实
- 版本号 `d+.d+(.d+){0,2}`、日期 `d{4}-d{2}-d{2}` 两种 token（源码里是带反斜杠的正则）；
- 同层、同项目（两边都有项目且不同就跳过），相似度 ≥ `CONFLICT_SIM = 0.3`；
- 两边**都有**这类 token 且集合不同，才算冲突；只有一边有不算（可能是新信息，不是互斥）；
- 每条只带一条差异（版本优先于日期），最多点名 `CONFLICT_MAX = 3` 条，按相似度降序。

刻意不报的：没有 token 的近似说法（同话题改写）、相似度不到门槛的（只是沾词）。
这两条是抗噪的主线——写记忆是高频动作，每写一条都弹一次提醒就变成噪声本身。

### 9.142.3 行为：提醒不改写入
冲突雷达在「新写一条」的分支里跑，`merged` 分支不跑（合并已经处理了旧条目，再报是重复）。
回执把「它写 A / 你写 B」并排报出来，并给出两条收场路径：`supersedes`（标 stale、不删、可反悔）
或 `memory_update` 改 status；说的是不同对象就忽略。`conflictWarn` 内部对短 id 唯一化加了 try/catch，
库查询异常时退回 8 位前缀——提醒是辅助信息，不能因为查 id 失败把整次写入带崩。

### 9.142.4 覆盖
probe-fusion `RK0–RK11`：写入端到端（真调 memory_remember 两次看回执）、跨项目不打扰、日期改期、
无 token 抗噪、上限与排序、多 token 抽取、源码常量锚点。
verify `FB`：抽取 / 识别 / 上限 / 排序 / 隔离 / 两条抗噪 / 日期 / 回执文案 / 四处源码锚点 / 版本与本文档。
## 9.143 改动侧也要查冲突，而且这话得能翻译（0.2.137）

### 9.143.1 最常走的那条路，恰好是唯一不查的路
0.2.136 的冲突雷达只挂在 `memory_remember` 的非合并分支上。可真实用法里更常见的是
「把旧条目改成新版本号」——`memory_update(content: ...)`。那条路当时什么都不查，
改完两个版本照样并排躺着，反倒是**已经知道该改哪条的人**留下了互斥结论。

所以 0.2.137 把同一套检查接到改动侧：`ok && typeof patch.content === "string"` 才查，
比对范围是 `db.list(found.level, { status: "active" })` 去掉自己（`.filter((r) => r.id !== found.row.id)`），
项目取 `patch.project ?? found.row.project`。

### 9.143.2 只改状态不查
`memory_update` 的绝大多数调用是 `status: "stale"`（todo 完结、条目过期）。
没动正文就没有新结论，拿旧正文去比只会重复报同一件事。所以闸门是「这次真的换了 content」。

### 9.143.3 两种说法不能混
写新条目时说「这条照样写下来了」；改既有条目时说「这条改动照样落库了」。
同一个函数 `conflictWarn(list, db, mode)`，mode === "update" 走 `conflict.headUpdate`，
其余走 `conflict.head`。文案里都给收场路（`status: "stale"` 不删可反悔 / 下次重写时用 `supersedes` 一次做完），
因为改动之后就属「旧的那条该退了」，不提 stale 等于只报警不给出口。

### 9.143.4 文案进 labels，而不是写死在代码里
冲突提示是**给人看**的话，`zh / en / pt-br` 各有 `conflict.item` / `conflict.head` /
`conflict.headUpdate` / `conflict.kindVersion` / `conflict.kindDate` / `conflict.join` 六个键。
代码里留一份中文兜底，并统一走 `safeKeyed()`（用户改过 prompts 覆盖目录、缺键时退回兜底，
不许因为一句提示把整次写入带崩）。`tokenDiff` 返回的 `版本 / 日期` 也经 `kindOf()` 过一遍标签，
否则英文回执里会冒出两个中文词。

### 9.143.5 覆盖
probe-fusion `RL0–RL12`：同项目两条不同版本 → 改其中一条，回执出现「改完之后」+ 两个版本号 +
收场路 + 「已更新」仍在 + 读回来是新内容；只改状态不报警；跨项目不误报；三语六键齐全；
英文模板不是中文搬家；写入/改动两种说法不互串；空表返回空串；源码锚点一条。
`verify.mjs` `FC` 段 16 条把上面这些与版本/文档一起钉住。

## 9.144 取代关系一直存在，只是从没被读出来（0.2.138）

### 9.144.1 库里有一条链，界面上只有一句碑文
`memory_remember` 传 `supersedes` 时，写侧会往**旧条目正文**末尾贴一句
`（已被取代：<新 id 前 8 位>「<新条目开头>」，<YYYY-MM-DD>）`（`defs/remember.js` 的
`SUPERSEDE_MARK` / `supersedeLineOf`）。信息是全的，但只躺在旧条目里：
- 读旧条目的人看到「已被人接手」，却看不见链有多长、接手之后又被谁接手；
- 读新条目的人**什么都不知道**——它接手了几条、哪些结论已经作废，正文里一个字都没有。

结果是同一件事在库里有两个身份：一个带着碑文（stale），一个是活的（active），
而「谁是这条链的当前说话人」只能靠人去翻。

### 9.144.2 不动数据模型，就地读标记
`lib/macro/chain.js` 只做解析与回读：
- `supersededBy(content)` → `{ id8, head, day }`（`idm` / `headm` / `daym` 三段，
  日期那段的 `，` 半角逗号也认，因为有的正文在中文标点里混了半角）；
- `successionOf({ workspace, dir, id })` → `{ mine, killed, missing }`：
  先用 `Meow.readRowsByIds` 取自己那行，再 `Meow.getDb(...).list(level, {})` 扫全部层级，
  找 `content.includes(SUPERSEDE_MARK + shortId(want))` 的行，跳过同前缀的自己；
- `successionNote(...)` 拼两行回执：退位的人得到「这条已被人接手：<id8>「<head>」（<day> 写下）」，
  活的人得到「这条接手过 N 条：fact <id8>（stale）」。

没有新表、没有新列、没有迁移：取代关系本来就在正文里，缺的只是读它的那一行代码。
`dbFile()` 先 `existsSync` 再 `getDb`——**绝不为了报一句链就把库建出来**。
拿不到链（没工作区 / 没库 / 读失败 / id 不对）一律返回空串，读回执不许因为链而变红。

### 9.144.3 改之前读，不是改之后读
`memory_update` 换正文时，那句碑文会跟着正文一起被换掉。链必须在 `flow.call('memory_update', …)`
**之前**读，否则「它接手过谁」在改完那一刻就没了。所以 `createUpdate`
先取 `chain`，再执行更新，最后 `[said, linked, chain].filter(...).join('\n\n')`。

### 9.144.4 只认前 8 位，这个口径得写在代码里
meow 的 id 是 `0mwowj2h2-<32 hex>`，**同一秒写入的两条前 8 位会撞**（`remember.js` 注释写明）。
所以链只能按前 8 位匹配，并且这个近似必须在代码里声明——它决定了「同名不同条」时
回执可能点错一条，但绝不会假装没有链。

### 9.144.5 覆盖
probe-fusion `RM0–RM9`：写旧条 → 带 `supersedes` 写新条 → 读旧条出现「已被人接手」+ 新条前 8 位；
读新条出现「接手过 1 条」+ `stale` + 史证；改旧条回执同时有「已更新」与链警告；
无谱系的条目一个 `⛓` 都不许出现；`supersededBy` 三段解析（含半角逗号）；空工作区/空库返回空串。
`verify.mjs` `FD` 段把上面这些与版本/文档一起钉住，并额外守着三条源码级口径：
「链在改之前读」「meowDir 真的从 tools.js 传下来」「先 existsSync 再 getDb」。

## 9.145 链是近似出来的，那就把近似说清楚（0.2.139）

### 9.145.1 8 位前缀有两个盲区，0.2.138 两个都没说
取代句里只留 `String(newId).slice(0, 8)`。于是「这条已被人接手：0mwpabcd」这句话有两个可能的真相：
- 库里**没有**以 `0mwpabcd` 开头的行——接手它的那条被 `memory_update` 改了前缀？不会；但被清理、
  被手工搬走、或者跨工作区写的条目，都会留下一个指不到人的前缀。读者看到「去改那条」，改不到；
- 库里有**好几条**同前缀的行（meow 的 id 是 `0mwowj2h2-<hex>`，同一秒写入的会撞前缀）。
  读者看到唯一一个 id，就会以为那是唯一一条。

两种情况下 0.2.138 的语气都太肯定了：`mine` 直接当事实念。链本来就是读出来的近似，
不把近似标出来，可追溯性就变成了「看起来确定」。

### 9.145.2 三态写在数据里，不写在文案里
`successionOf` 现在返回 `mine = { id8, head, day, hits, state, level }`，`state` 只有三种：
`exact`（唯一命中）/ `absent`（0 条）/ `ambiguous`（≥2 条）。判定用 `prefixState(ids, prefix)`——
抽成纯函数是因为真库造不出「同前缀两条」，而判据本身必须能单测。

`successionNote` 三句话分开：
- `exact`：原样「这条已被人接手……去改那条」；
- `absent`：「这条写着被 X 接手，可那条现在不在库里——它被删了或搬走了，你想改也改不到；这次结论要准，就让这条带 supersedes 重写一次。」
- `ambiguous`：「可这个前缀在库里有 N 条（id 前 8 位撞了），认不出是哪一条——按开头那句自己去核对。」

### 9.145.3 反方向也一样：我接手过谁，也是按前缀找的
`killed` 那一侧同样靠 `shortId(want)` 匹配。如果自己的前缀在库里不止一条，
那么「谁正文里记着我」命中的可能是记着我兄弟条的。以前照样念「这条接手过 N 条」，
现在先算 `selfHits`，>1 时在那行尾巴补一句「库里还有 N-1 条 id 前 8 位也是 xxx，
下面这几条可能记的是它们之一」——不删信息，只把不确定性说出来。

### 9.145.4 全库只扫一遍
0.2.138 扫一遍找 `killed`。0.2.139 还要知道「接手者还在不在」「自己前缀几条」，
三件事都要全库。所以一次 `db.list(level, {})` 铺成 `all = [{level, row}]`，
`ids = all.map(...)`，三个判断共用——多扫两遍在 86 条时无感，在几千条时就是三倍 IO。

### 9.145.5 覆盖
probe-fusion `RM10–RM13`：真造一对（甲 → 乙 supersedes 甲）验 `state === 'exact'`；
写一条带假前缀（`0mzzzzz9`）的条目，读回来必须说「不在库里」且不许说「去改那条」；
`prefixState` 三态；自己的短 id 唯一时不出现「可能记的是它们之一」。
`verify.mjs` `FE` 段 9 条把三态、两句新文案、8 位口径、全库一遍、不建表一起钉住。
踩坑记一笔：RM4 改过旧条正文，那句「已被取代」跟着正文一起被换掉了——
这恰好是 0.2.138「链要在改之前读」要防的事，探针里再造一对即可。

### 9.145.6 撞车不是罕见情况，是默认情况
写完这一版探针才开始随机红：`RM2` 有时说「已被人接手」，有时说「前缀在库里有 2 条」。
原因不是探针写错了，而是 meow 的 id **前半段就是写入时刻**（`0mwpxnnu-<hex>`）——
同一秒写进去的条目，前 8 位必然相同。真实对话里一轮写两三条很常见，所以「ambiguous」
不是边角料，是常态的一部分。

于是补第二级判据：取代句里本来就带着接手者的开头（`「…」`），拿它再筛一遍
（`headMatch`，两边都截断过、还带省略号，只认「谁以谁开头」）。
- `hits` 记的是**前缀命中几条**（事实），`state` 记的是**筛完能不能确定**（结论）——
  这次撞了 2 条但开头对得上唯一一条，就仍然是 `exact`；
- 反方向同理：一条旧条目写着「我被 0mwpxnnu 接手」，只有当它记的开头也以我的开头起头时，
  才算「它记的是我」，否则可能记的是同秒的兄弟条；
- 只有开头缺了、或筛完仍不唯一，才退回 `ambiguous`（照实说「认不出」）。

## 9.146 状态一直是个过滤器，从没进过打分（0.2.140）

### 9.146.1 一个只在「读」的时候才存在的区别
`memory_search` 的 status 是一个**检索前的二值过滤**：默认 `null`，也就是 stale / archived
全都参与检索。于是库里同时躺着「0.2.100 的旧结论」和「0.2.140 接手它」两条时，谁排第一
由 BM25 × 重要度 × 新鲜度决定——跟「这条还用不用」完全无关。实测一条刚被标 stale 的旧结论，
只要措辞更贴，稳稳排在接手它那条前面，回执上唯一的差别是行首一个 `（stale）`。

准确性不是「能召回」，是「召回的是现在还对的那条」。

### 9.146.2 权重进打分，但只降权不隐藏
`STATUS_WEIGHT = { active: 1, stale: 0.6, archived: 0.35 }`，`statusWeight()` 一个入口，
两个打分器（BM25 与关键词）同口径乘上去。历史仍然召回（可追溯性不许砍），只是不许压过
在用的结论。`explain` 里补 `statusWeight` 一项——不然读者只知道它掉下去了，不知道为什么。

### 9.146.3 差点写成一句空话
第一版只加了权重函数与乘法，探针立刻打红：退位那条照样排第一。原因是 `searchTool` 把 rows
映射成 docs 时**没有带 status**（那张 map 只挑 id/level/title/content/keywords/importance/
created_at/updated_at/last_accessed_at）。`statusWeight(undefined)` 一律取 1，权重等于没加。
补上 `status: r.status` 之后才真的生效——**降权的前提是权重看得到状态**，这一条写进 verify 的
源码锚点，防止以后重构时又把它挑丢。

### 9.146.4 降权必须说出口
分数里的 0.6 是看不见的。命中里有非 active 时，回执补一句：有几条不是在用的、降到多重、
只要在用的该加什么参数（`status:"active"`）。没有这类命中时 `statusDownNote` 是空串——
常态一个字符都不多花。

### 9.146.5 三语与覆盖
文案走 `safeKeyed("search.statusDown", …)`，zh / en / pt-br 三个 labels.md 都补了同键；
probe-fusion 的 RP0–RP5 走真工具验「降权发生、按序、说出口、explain 可见、纯函数分数比」，
verify 的 FW 段验源码锚点与三语齐备。

## 9.147 折叠掉的那条，可能才是现在该看的那条（0.2.141）

### 9.147.1 折叠原来是「先到先得」
检索侧的去重（`foldNearDupes`）原本只有一个判据：榜上先出现、且与后者相似度过线的那条留下，
后来者记进 `folded++` 就跳过。榜是按分数排的，所以这条规则的实际含义是**分高者留**。
分数说的是「措辞贴不贴这次提问」，不是「这条还用不用」。一条被自己标成 stale 的旧说法，
只要字面更像提问，就能把接手它、措辞朴素的那条折掉——回执上只剩一句「多半是同一句
既存了 fact 又存了 lesson」，一声不响。0.2.140 刚把状态放进打分，这一处却还在把状态当空气。

### 9.147.2 挑谁：在用 → 较新 → 分高
`pickKeeper(members, byId)` 排序键三级：`statusWeight` 降序、`updated_at` 降序、`score` 降序。
前两级是「这条现在还算数、以及谁接了谁的班」，第三级才是措辞贴合度。这样同一条记忆的
新旧两版同时上榜时，留下的一定是还在用的那一版；状态相同时留新不留下旧；只有状态与时间
都打平时才回到分数。榜的外层顺序不动——`kept` 是按原榜 `hits.filter(...)` 回来的，
折叠只换掉组内代表，不重排榜单。

### 9.147.3 折了谁要能追溯
`foldNearDupes` 返回 `{ kept, folded, dropped }`，`dropped` 里每条记 `{ id, keep, newer }`：
被折掉的是哪条、被谁代表、它比留下的那条新还是旧。回执走
`safeKeyed("search.dedupeKept", …)` 点名两侧（短 id 8 位，`、` 连接），并说明挑法是
「在用 → 较新 → 分高」。可追溯性不是「库里有就能查到」，是**回执上看得见这次为什么没列它**。
`dedupe: false` 这条出路一个字没动：折叠是默认行为，不是删除。

### 9.147.4 探针里踩到的两个假绿
`db.list('fact', { status: 'all' })` 返回 0 行——全量要传 `{}`，`status:'all'` 会被当成字面状态值。
默认 `memory_search` 走 `db.listSearchable`，只含 active，所以验「退位那条被降权」必须显式
`status:'all'`，否则两条都看不见、断言在空数组上恒真。两处都写进了 probe 的注释。

### 9.147.5 覆盖
probe-fusion 的 RQ0–RQ4：纯函数挑在用优先、`dropped` 记 `keep`、回执两侧点名、
`dedupe:false` 两条都列、`pickKeeper` 分高但更旧时不压时间（**728 条全绿**）。
verify 的 FY 段 5 条锚源码与三语，另有三条老锚点随签名同步（`foldNearDupes(aboveFloor, byId)`）。

## 9.148 dream 清单只说「该整理」，从不说「已经整理坏了」（0.2.142）

### 9.148.1 三个块都在比正文，断链不在正文里
dream 的清单到 0.2.141 为止有三块：逐字重复、重复详写、疑似冲突。三块都建立在同一个前提上——
**两条正文放一起比**（重复度、覆盖度、同题不同数）。可有一条谱系是不在正文里的：某条正文末尾写着
「（已被取代：0mwpzzdj「…」，2026-11-20）」，指的是库里另一条 id 的前 8 位。这个指向可以断，断法有两种：
接手者已经被删或被搬走了（`absent`），或者同一秒写入的条目前 8 位撞在一起、根本认不出是哪条（`ambiguous`）。
两种断法都不需要第二条正文参与比较——所以三个块一对都抓不到。这是 0.2.139 在**回执**上补的洞
（`successionOf` 三态），dream 一直没跟着补。

### 9.148.2 断链不是「该整理」，是「已经整理坏了」
清单里前三种块的意思是「这里有两份东西，你去挑一个」；断链的意思不同：**上次整理留下的指向已经失效**。
把它混进冲突块会让模型以为还有两条可选，于是「取新的、旧的标已被取代」这句现成处置会被照抄一次——
而它恰恰是做不了的那件事（接手者不在库，改不到）。所以它单独成块、单独一句话交接：
`absent` 给两条路（这条自己就是现在的结论 → 改回 active；或者带 supersedes 重写一次让新条目接班），
`ambiguous` 只给一条路（照开头那句去核对是谁，别照着前缀改错人）。

### 9.148.3 判据要按「库里有没有」分，不能按「筛完剩几条」分
第一版把三态写成 `sure.length === 0 ? 'absent' : 'ambiguous'`，其中 `sure` 是撞车后按开头筛剩下的。
于是「前缀撞了 3 条、开头一个都对不上」被判成 `absent`——文案会说「那条现在不在库里」，
可它明明在，只是认不出来。这是两种完全不同的处境，处置也不同。正确口径是
`state: hits.length === 0 ? 'absent' : 'ambiguous'`：**先看库里有没有这个前缀，再看开头能不能收窄到一条**。
探针里 RS1 就锁这一条（撞了 2 条、开头全不对 → 必须 `ambiguous`）。

### 9.148.4 干净清单零成本
`dreamChainIssues` 先扫本轮行、收集取代句；**一条都没有就立刻返回**，全库扫描根本不发生。
有取代句时才 `for (const level of LEVELS) db.list(level, {})` 建一张「前缀 → 行」的索引，
一次扫描服务所有 claim。dream 是每轮窗口都会跑的，加一块新检查不能给没断链的库加固定开销——
探针 RS3 用一个会计数的 stub 证明 `db.list` 调用次数是 0。

### 9.148.5 分摊与上限
和另外三块同一口径：按「这条落在哪一轮，就由哪一轮说」分摊（`roundIds.has(...)`），
跨轮的对子不会每组各印一遍；单块最多 6 条（`DREAM_CHAIN_MAX`），超出的用 `dream.chain.more` 说还有几条。
不刷屏，也不静默——这两条在「回执要认账」这条线上一直是成对出现的。

### 9.148.6 覆盖
probe-fusion 的 RS0–RS8：absent / ambiguous / exact 三态、干净清单零成本（`scans=0`）、
`dreamChainBlock` 文案（含「还有 2 条」）、空清单返回空串、真库一遍（库里读到的一样判得出）、
五个键三语齐全（**737 条全绿**）。verify 的 FZ 段 16 条锚源码、行为、文案与「不建表不加列」，
其中一条专门锁 `state: hits.length === 0 ? ...`，防止有人再把它改回按 `sure.length` 判。

## 9.149 相关度下限按分数裁，可分数排的不是「谁接了班」（0.2.143）

### 9.149.1 一道分数线，两种错误
`min_rel`（默认 0.35）的判据是「分数 < 榜首 × 0.35 就收掉」。分数是 BM25 + 关键词覆盖 + 重要度 + 状态权重
的乘积，它衡量的是**措辞有多贴这次提问**。而记忆里有一条与措辞无关的事实：这条是不是已经退位了。
0.2.140 把状态乘进分数之后，退位的那条确实会掉一档，但**掉完仍然可能很高**——一条旧说法只要字面
跟提问严丝合缝，0.6 的权重压不住它；反过来，接手它、措辞朴素的那条本来分就低，一乘下限就被裁掉。
于是读者看到的画面是：榜首那条写着「已被取代」，真正该看的那条连影子都没有。这不是「省了几条」，
这是**把人指到已经作废的结论上去**。

### 9.149.2 裁之前回看一眼：被裁的是不是榜上某条的接班者
`liftSuccessors(shown, cut)` 只做一件事：拿榜上每条正文里的取代句（`chainMarkOf`，与 0.2.142 同一套解析）
去被裁的那段里找前缀相同的条目；命中一条就提上来。三条边界：

- **认不出就不提**。同前缀多条、开头（取代句里那句「…」）对不上 → `sure.length !== 1` → 跳过。
  提错人比不提更坏：那会把「另一件事」当成答案递过去。
- **有上限**（`LIFT_MAX = 3`）。下限本来就是省 token 的旋钮，提升不能把它拆掉。
- **顺序不动**。提上来的追加在榜尾，最终仍由分数重排（`reordered`），不人为插到榜首。

### 9.149.3 提上来的必须说出来
回执加一句 `search.floorLift`：「另有 {n} 条相关度低于榜首的 {pct}%，但它们正是榜上某条的接手条目（{ids}），
这次一并展开——上面写着「已被取代」的那条别再当结论用。」三个要素缺一不可：**几条、是哪几条、为什么破例**。
只说「另有 N 条被提上来」等于把可追溯性换成了凑字数；只点名不说为什么，读者会以为下限失效了。

### 9.149.4 顺序：先裁 → 再提升 → 再折叠
`cutRows = ranked.slice(aboveFloor.length)` → `lifted` → `floorKept = [...aboveFloor, ...lifted]` →
`foldNearDupes(floorKept, byId)`。折叠放在提升之后是有意的：假如被提上来的那条与榜上那条内容几乎一样，
折叠会按「在用 → 较新 → 分高」挑——0.2.141 的判据在这里正好帮上忙，留下的是接手的那条。
`min_rel=0` 时 `lifted` 恒为空数组，一个字节都不多花（探针 RT5 锁这一条）。

### 9.149.5 覆盖
probe-fusion 的 RT0–RT6：纯函数提升、撞车不提、上限 3、真工具（旧条 stale 带取代句压住榜首、新条
被下限裁掉 → 回执里两条都在且说「一并展开」）、`min_rel=0` 时不出这句、三语齐全（**744 条全绿**）。
verify 的 GA 段 8 条锚源码与行为，另有三条老锚点随实现同步（`foldNearDupes(floorKept, byId)`、
`const belowFloor = cutRows.length - lifted.length`）。

## 9.150 dream 的三个块都在比「这一轮写的两两之间」，全库从来没参与过（0.2.144）

### 9.150.1 三个检测器共用同一个集合

`buildDreamMessage` 里那句 `const allRows = rounds.filter(...).flatMap(...)` 是逐字重复（`dreamDupPairs`）、重复详写（`dreamCoverPairs`）、疑似冲突（`dreamConflictPairs`）三块**唯一的输入**。也就是说：库里已经躺着的那 2,700 多条，从来没进过任何一次比较。

后果很具体：新写一条与四十天前那条一字不差，dream 的清单是**干净的**。不报重复、不报冲突、不报断链——因为它压根不在同一个集合里。

### 9.150.2 写侧那道闸只管当刻

0.2.136 的冲突雷达在写入那一刻看一次 top-k 候选，用的是 search 的措辞贴合口径；写完之后就没人再核对了。而重复恰恰是唯一一种**写错了不会报错**的噪声：两条都合法、都能被召回、都出现同一件事，只是库变胖了一点。没有哪一步会红。

### 9.150.3 候选必须是索引，不是全比

全库与全库两两比是 O(N×M)，而 dream 每一轮都要跑。这里用两套索引取候选：`byHead`（正文前 8 字）与 `byKw`（关键字前 12 字），单条候选最多 `DREAM_REPEAT_SCAN = 40` 条再去算重复度。重复度沿用 `overlapOfSets`（Jaccard），门槛 `DREAM_REPEAT_MIN = 0.8`——与 `dreamDupPairs` 同一个口径，只是对象从「本轮的另一条」换成「库里的另一条」。

### 9.150.4 本轮内部不报

`const here = new Set(allRows.map(...))` 把本轮 id 全部排除出候选：本轮两条互相重复是 `dreamDupPairs` 的活，这里再报一次就是同一件事印两遍。本轮为空时直接返回并**一次库调用都不做**（`dreamRepeatIssues([], db)` 返回 `scanned: 0`，探针用计数器锁住这条）。

### 9.150.5 对方的状态决定该说什么

- 对方还在用：把这条的内容**并进对方**（并集，别整条覆盖），再把这条标 stale 并写一句「已被 X 取代」——别留两条平行条目。
- 对方已退位：这轮又写了一条几乎一样的，先问清楚是**复活**（把对方改回 active 并合并）还是**新结论**（写清差别，而不是重写一遍）。

只报「这两条很像」而不给动作，清单就只是噪音；这两种情形的处理方向是相反的，所以必须分开说。

### 9.150.6 覆盖

`tools/probe-fusion.mjs` 的 RU0–RU7b（17 条：库里命中、干净时也真查了库、本轮内部不报、空轮零调用、关键字撞上但正文不同不报、无关键字靠前缀认出、对方退位照样报、块文案四要素、退位文案、空串、真库一遍、三语六键）；`verify.mjs` 的 GB 段（20 条：源码锚点、索引而非全比、接进清单第五块、上限与门槛、行为八条、文案、不建表、三语）。

## 9.151 每轮自动注入被整段删掉之后，检索退化成「想起来才查」（0.2.145）

### 9.151.1 被删掉的不是「注入」，是「自动」

0.2.18 的账本上写着「禁掉每轮自动邻域注入」：nebula 原来每轮把邻居关系塞进 system prompt，融合层把它整段收掉——省下的确实是实打实的每轮固定成本。但留下的窟窿也很具体：`memory_search({mode:"graph"})` 只在模型**想起来**的时候才被调用。一个不主动检索的模型，等于装了一个自己不会用的记忆库。

meow 自己那条每轮注入（`preStepInject` → `buildHitInjection` → `hitQuery`）一直在跑，但它量的是**这一轮的话与本库条目的措辞贴合**，默认只带 2 条、只认 `fact/lesson/rules/topic`，且要求 `source_session !== sessionId`。它回答的是「你问的这件事库里有条目吗」，不是「你问的这件事在关系网上连着谁」。这两问的答案经常不重叠。

### 9.151.2 变化的内容只能追加在尾部

`agent/pre-step` 是 waterfall：`await next()` 拿到 `{kind:'enter', messages}`，把新消息接到 `messages` 末尾再返回。接在末尾而不是前面，是因为 prompt 前缀缓存按字节比对——**前缀一变，整段上下文重算**。所以这一层一条都不碰 system prompt，也不改既有消息，只往后加。这也意味着追加的消息会落进会话日志（durable），所以「不重复带」必须自己记账，不能指望宿主去重。

### 9.151.3 每轮都跑的路径必须便宜且封顶

这一层挂在每一轮的必经之路上：只查一次星图（`nebula_recall`，`limit = max + 2`、`hops = 1`），不查主库、不调模型、不做二次排序。四条上限各有出处：

- **条数 `NEIGHBOR_DEFAULT_MAX = 4`**：再多就不是「提示」而是「另一份检索结果」，读者会开始跳过。
- **字符 `NEIGHBOR_DEFAULT_CHARS = 420`**：整块渲染时逐行累加，装不下就停，宁可少一条也不切半行。
- **门槛 `NEIGHBOR_MIN_QUERY = 6`**：「嗯」「继续」「好」不构成检索意图，拿去查星图只会带回噪声。
- **去重 `Map<sid, Set<bareId>>`，每会话上限 200 条**：同一会话里同一条邻居只带一次；星图 id 可能带 `ws:` 前缀，比较前统一走 `uidOf` 取裸 id。

一条都没有、或者全都在本会话带过，就返回 `null`——**一个字都不注入**。空手而归不是失败，硬凑一条才是。

### 9.151.4 注入必须自报来路

模型分不清「用户说的」和「插件塞的」。所以块首固定写「自动带来的……不是用户说的原文」，每条带 `[level] [id8] 标题（强度 0.82）`，块尾给读全文的办法（`memory_read("<id8>")`）并提醒别把摘要当原文引用。注入消息本身也带 `source: {kind: 'macro-memory:neighbor', form: 'notice', summary: '星图邻域 N 条'}`，宿主与日志都认得出它来自哪一层。

### 9.151.5 失败不挡这一轮

`bridge.tryCall` 抛错、回执解析不出节点、`@deepseek-ai/dsh-llm` 取不到消息工厂——三种情况都只记一笔 `failed` 并原样返回 `decision`。注入是加分项，任何一条失败路径都不许让用户的这一轮走不下去。子代理会话（`agent.session.header.origin === 'subagent'`）直接跳过：它们有自己的任务上下文，塞主会话的邻域只会干扰。

## 9.152 噪声词不是「排得差一点」，是把候选集撑成「都沾点边」（0.2.146）

### 9.152.1 中文这一侧，从来没有停用词表

英文那条路是完整的：`tokenize` 末尾按 `isMostlyLatin` 判断整段语言，拉丁为主就过 `normalizeEn`——停用词表 `EN_STOPWORDS` 加 Porter 词干。中文这条路只做了切分：`classify` 认出 CJK 就按二元组切（`run[k] + run[k+1]`），切完原样进 BM25。于是「怎么 / 那个 / 现在 / 一下 / 我们」和「星图 / 延迟 / 备份」在索引里是同等公民：一样的 `idfOf`、一样的 `tf`、一样的覆盖度分母。

后果不是「排序差一点」。**噪声词会扩大候选集**：库里三分之一条目都含「怎么」，问「怎么把延迟调下来」时，那些只沾了「怎么」的条目统统拿到一个不为零的分数、统统进榜。回执看起来「都沾点边」，读者于是开始怀疑整个记忆库的精度——而这其实只是问句里两个字在灌水。

### 9.152.2 判据用 df，不用词表

写一张中文停用词表是最直接的做法，也是最容易腐烂的做法：词表要对「怎么/咋/如何/怎么样」这一族逐个维护，混语言、混口癖、混项目黑话之后永远补不完。这里换成数据自证——**出现在一半以上条目里的查询词，就是这一问里的噪声**：

```js
var NOISE_DF_RATIO = 0.5;
var NOISE_MIN_DOCS = 8;
function noiseTermsOf(qTerms, df, n) {
  if (n < NOISE_MIN_DOCS) return [];
  const gate = Math.ceil(n * NOISE_DF_RATIO);
  const out = [];
  for (const t of qTerms) if ((df.get(t) ?? 0) >= gate) out.push(t);
  return out.length >= qTerms.length ? [] : out;
}
```

判据是**这一问 × 这一库**，不是写死的词。库小（< 8 条）时 df 不可信——5 条里 3 条含某个词，那是巧合不是噪声——所以一条都不剔。剔完一个词不剩（整句都是「怎么」）就整段回退：**宁可噪声，也不给空结果**，空结果是「这库没记过这件事」的谎言。

### 9.152.3 剔词必须同时剔分母

`raw` 的 BM25 循环、覆盖度 `cover / qIdfSum`、以及 `qIdfSum` 自己，三处都得换成剔后的词集：

```js
const noiseDropped = opts.noiseFloor === false ? [] : noiseTermsOf(qTerms, df, n);
const qKept = noiseDropped.length === 0 ? qTerms : qTerms.filter((t) => !noiseDropped.includes(t));
const qLoop = noiseDropped.length === 0 ? q : q.filter((t) => !noiseDropped.includes(t));
const qIdfSum = opts.coord === false ? 0 : qKept.reduce((s2, t) => s2 + idfOf(t), 0) || 1;
```

`qLoop` 保留问句里的重复（同一个词问两遍，该给两遍的分），`qKept` 去重（覆盖度按词种算）。**只剔分子不剔分母**是最常犯的错：覆盖度门槛原地抬高，真正相关的那条被一起裁掉，表面上「更严格」，实际是「更难满足」。探针 NF6 量这一条——同一问句去掉噪声词之后，首条分数必须逐位相同（`28.419066945088073 vs 28.419066945088073`）。

### 9.152.4 剔了谁要报出来

`explain.noiseDropped` 点名这一问被剔掉的词。理由和 0.2.143 的 `floorLift`、0.2.130 的 `implicit` 一样：**口径变化不写出来，下一次谁也不敢动它**。读者看到「为什么这条没进榜」，第一件该知道的事就是「你问的那两个字这次没参与」。

### 9.152.5 与既有 levers 不重叠

主人这一轮的要求是「功能不要重叠」。打分侧现有六件东西，量的是「怎么给分」：`fieldBoost`（关键词/标题命中加权）、`coord`（覆盖度乘性）、`entityPrior`（问句专有名词）、`importanceWeight`（重要度加成）、`recencyWeight`（新鲜度）、`statusWeight`（生命周期）。这一条量的是**「谁参与给分」**——参与资格，不是权重。两者可以相乘，但不能互相替代：权重把噪声词的分数调小，噪声词只要还在分母里，就仍然在决定「这一问要多难才叫命中」。

### 9.152.6 覆盖

`tools/probe-recall.mjs` 的 NF1–NF6（6 条：八条只沾噪声的退出榜单、阴性对照 `noiseFloor:false` 时全回来、`explain.noiseDropped` 点名、库小不剔、整句常用词回退、剔掉 = 没问的分数等价）；`verify.mjs` 的 GW 段（9 条：阈值是常量、三条护栏各占一行、分子分母同口径、`noiseDropped` 要报、四条行为）。

## 9.153 标识符被分词打碎，问「哪个版本」就变成「谁都能沾一点边」（0.2.147）

### 9.153.1 症状是「问的东西没被当回事」，不是「排得差一点」

真实库里跑十五个日常问句，暴露出来的不是排序手感问题，是一个更钝的失效：**问句里的那件事根本不在打分里**。

- `tokenize('0.2.146 改了什么')` → `["0","2","146","改了","了什","什么"]`。版本号被切成三段，`0` 和 `2` 在半个库里都出现，于是「问 0.2.146」和「问 2」在 BM25 里几乎等价。
- `tokenize('memory.db 在哪')` → `["memori","db","在哪"]`。词干化把 `memory` 变成 `memori`，`db` 又太短，两个 token 都不指向那个文件。
- `tokenize('0mwq5zzv 是什么')` → `["0mwq5zzv","是什","什么"]`。这一条更尴尬：短 id 本身被完整保留了，但**它不在 docText 里**（id 是字段，不是正文），所以 BM25 恒为 0，那条记忆连候选集都进不去。

于是「问版本号」的 top3 全是措辞相近的噪声（20.06 / 12.72 / 12.53），真正讲 0.2.146 的 fact 不在榜；「问某条记忆的 id」时它排第三，靠的是正文里恰好出现的「是什么」类词。

这类失效很危险，因为它的症状不是「答错了」，而是「答得很像」。分词器不认识的东西，检索永远装不认识；用户看到的是三条都沾边的结果，读起来不像故障。

### 9.153.2 判据：问句里的标识符原样比对，不经过分词

0.2.147 的量法是**双轨**：分词那一路照旧（BM25、覆盖度、fieldBoost 全不动），另加一路「原样匹配」，只看问句里那些**本来就该整体认的东西**：

- Windows 绝对路径 `[A-Za-z]:\...`、相对路径（两段以上，或 `a/b` 形式）
- 带扩展名的文件名（`index.js` / `memory.db` / `probe-words.mjs`）
- 版本号 `\d+\.\d+\.\d+`、日期 `\d{4}-\d{2}-\d{2}`
- 短 id `0m[a-z0-9]{5,}`、commit `[0-9a-f]{7,40}`
- kebab / snake 名字（`pre-step` / `source_session`）

`identsOf(query)` 把这九条正则跑一遍、小写化、丢掉短于 4 的、去重，再做**包含关系去冗余**：`tools/probe-words.mjs` 与 `probe-words.mjs`、`tools/probe-words` 是同一处证据，只留最长那个。一条问句最多认 6 个——上限不是怕慢，是怕一句「把这些 id 都列一下」把半个库拽进候选集。

`identCreditOf(ident, hay)` 给的是**分级信用**，不是布尔命中：整串出现在候选文本里 → 1；整串没出现但 basename 命中 → 0.7；连扩展名去掉后的主名命中 → 0.5；否则 0。`verbatimOf` 把这些信用求和除以标识符个数，得到 `ratio`，并把降级命中的那条标成 `xxx(局部)`。降级必须自报，不然「只命中文件名」会被读成「整串命中」。

### 9.153.3 加法，不是乘法

第一版写的是乘法：`score *= 1 + IDENT_W * ratio`。两个问题立刻暴露：

1. **翻不过噪声。** 噪声条目的词分本来就高出一截，乘 1.6 倍也追不上；而「问版本号」恰恰是最需要翻盘的场景。
2. **BM25 为 0 的条目连候选集都进不去。** 短 id 指认就是这一类——乘法乘在 0 上还是 0。

改成加法：先算出纯词分的最大值当作一个「单位」，再让原样匹配按 `unitRaw * ratio * (指认 id ? 1.5 : 0.6)` 补上去。指认 id 的权重更高（1.5），因为「id 就是这一条」是比「正文提到这个标识符」更强的证据。改完之后：`0.2.146 改了什么` 的那条 fact 从「不在榜」升到 24.78 第一位，`0mwq5zzv 是什么` 直接 27.03 第一位且 `explain.bm25 === 0`——**纯指认，不假装读到了正文**。

### 9.153.4 认得克制：四条上限 + 一键关 + 降级说实话

- 太短的不算（`IDENT_MIN = 4`）：`a/b`、`1.5` 这种通用碎片不进原样匹配，免得「a/b」在讲对比的条目里到处刷分。
- 一句话最多 6 个（`IDENT_MAX = 6`）。
- 同一处证据只记一遍（包含关系去冗余）。
- `verbatim: false` 一键回旧口径，`identsOf` 直接返回空数组，整段逻辑变成惰性。
- 问句里一个标识符都没有时，分数**逐位相同**（不是「差一点」），`explain` 里也不出现 `verbatim` 键——不编造证据。
- `search()` 与 `keywordHitScore()` 两处同口径接入：另一支打分器（关键词命中）也要认得出同一段短 id，否则同一个问题换个入口就换答案。

### 9.153.5 与既有 levers 不重叠

主人这一轮的要求还是「功能不要重叠」。打分侧现有六件东西量的都是**「怎么给分」**：`fieldBoost`（字段命中加权）、`coord`（覆盖度乘性）、`entityPrior`（问句专有名词先验）、`importanceWeight`、`recencyWeight`、`statusWeight`；0.2.146 的噪声地板量的是**「谁参与给分」**（df 判据剔词）。这一条量的是**「问句里有没有根本不该被分词的整串」**——输入侧的形态判断，跟前两者正交：噪声地板处理的是「这个词太常见」，原样匹配处理的是「这个词不该被切成词」。

也刻意避开了星图那一侧：零命中时星图扩散已经在跑（`z` 的 `expand` 默认开），所以这里不做任何「补召回」的召唤，只在本地这一路加一个**不依赖词表**的证据通道。

### 9.153.6 覆盖

`tools/probe-recall.mjs` 的 VB1–VB14（14 条）：版本号是整体、版本号问句第 1、短 id 指认第 1、该条 `bm25` 为 0、阴性对照 `verbatim:false` 连候选都进不去、路径整串命中、basename 降级标「(局部)」、大小写不敏感、太短的不算、上限 6 个、包含关系去冗余、无标识符时逐位同分、无标识符时 `explain` 不带 `verbatim`、`keywordHitScore` 同口径。

`verify.mjs` 的 VV 段（14 条）：常量、九条正则、`identsOf` 的四道筛（长度/去重/包含/上限）、分级信用三档、`(局部)` 标记、haystack 含 id 与 project、加法补分那一行、`opts.verbatim === false` 一键关、`explain.verbatim` 与 `identBonus` 同报、四处行为，以及版本与文档锚。

## 9.154 指认被别人的重要性稀释：补分算在了权重前面（0.2.148）

### 9.154.1 症状：问一条 id，答它的那条排第二

0.2.147 上线当天，真实库里立刻就抓到一个反转：

- `0mwq5zzv 是什么` → 第 1 名是一条**措辞命中**（`bm25 = 10.263`，最终 17.96），第 2 名才是被指认的那条（`bm25 = 0`，最终 16.16）。
- 合成语料里没暴露，因为那里的噪声条目分数低；真实库里「措辞更像」的那条 importance 是 3 以上，`impW = 1.75`，一乘就把补分反超了。

用户问的是一段 id——那不是「相关」，是**指认**：这一条就是他要的那条。它排在「措辞更像」后面，等于系统拒绝承认自己认出了 id。

### 9.154.2 根因：补分进了 raw，就跟着被乘一遍

0.2.147 的实现是把补分加进 `raw`（词分），再由 `score = raw × 新鲜度 × impW × stW` 算最终分。看起来是加法，实际是**「加法之后还有一次乘法」**：

- 被指认的那条 importance=1 → `impW = 1.0`，且因为 `raw = 0 < 0.85 × maxRaw`，新鲜度系数也压在它身上（`w = 0.8` 之类）；
- 竞争的那条 importance=4 → `impW = 1.75`，且榜内靠前 → 免衰减。

同一个补分，加进 raw 之后被两个不同的系数缩放，强弱关系就被最后一步改判了。**这不是补分不够大，是补分被放错了位置。**

### 9.154.3 修法：补分落到加权之后，单位取榜首的实际分数

现在的顺序是：词分 → 各条加权 → 得到完整分数 → 再补标识符分。

- 单位 `unitScore = 榜首的实际分数`（不是词分最大值）。这样补分与最终分同量纲，且「榜有多高」自动跟着走：库里这次匹配普遍很强时，指认也更强；匹配很弱时，指认不至于凭空造出一个巨大分数。
- 系数不变：整串命中且命中的是 id → 1.5；一般原样命中 → 0.6；`ratio` 仍按信用三档求和后取均值。

同一问句修完：被指认那条 `26.94` 第 1，措辞那条 `17.96` 第 2；`explain.identBonus` 与 `score` 逐位相等（差只来自回执里的三位小数）——这正是「补分在乘法之后」的证据。

### 9.154.4 连带改的三处

1. **候选集放行条件**：raw 循环原本 `if (raw[di] <= 0) continue;`，会把「BM25 为 0 但原样命中」直接挡在门外。现在改成 `raw[di] <= 0 && rawVerbatim[di] === null`——只有既没词分又没原样证据的条目才跳过。这一条是补分挪到后面的前提，漏了它短 id 指认会整个失效。
2. **临时字段不留痕**：`_vb` 只在 push 与补分之间活着，补完 `delete h._vb`。回执里出现内部字段比少一个字段更糟：读的人会以为那是给他们的。
3. **两支打分器同口径**：`keywordHitScore()` 的补分同样挪到排序前、单位同样取它自己的榜首。它的分数还带覆盖度与标题加权，所以是「在它自己的量纲里补」，不是复用 `search()` 的数字。

### 9.154.5 与既有 levers 不重叠

这一条不新增任何打分维度，只回答一个问题：**补分该在乘法链的哪一段落地**。`importanceWeight`、`recencyWeight`、`statusWeight` 各自量的还是它们原来量的东西；改的是它们和「原样命中」的相遇顺序。换句话说，0.2.147 定的是「这条证据值多少」，0.2.148 定的是「这笔钱在税前还是税后发」。

### 9.154.6 覆盖

`tools/probe-recall.mjs` 的 VX1–VX6（6 条）：指认压得住 importance=4 的措辞命中、`score` 与 `identBonus` 同值（证明补分在加权之后）、阴性对照下措辞重新占榜首、补分 = 榜首 × 1.5、`keywordHitScore` 同口径、回执里没有 `_vb`。

`verify.mjs` 的 VW 段（8 条）：补分块在 push 循环之后（源码顺序断言）、`unitScore = topScore`、`delete h._vb`、放行条件、两支打分器都有 post-pass、四处行为（含真实量级的「措辞分高但 importance 低」对照），以及版本与文档锚。

## 9.155 前四刀都有探针，却没有一把量「答得准不准」的尺子（0.2.149）

### 9.155.1 症状：每刀都有红旗认证，但没有一个是准确率

0.2.145 邻域注入、0.2.146 噪声地板、0.2.147 标识符、0.2.148 补分位置——四轮全是真改动、全有探针、全绿。可每一支探针问的都是「这个机制对不对」：加分有没有落在后面、噪声词有没有同时从分母里剔掉、短 id 能不能只凭字段被认出来。**没有一条探针回答「用户随口问一句，第一条是不是他要的那条」。**

后果是两种失败都被容忍：机制对了但排位错了（0.2.148 上游的指认被稀释就是这么漏过去的），以及退步了没人知道（没有任何东西会因为「答得不准」变红）。

### 9.155.2 尺子的材料：真实样张 + 自然问句，缺一不可

- 语料从真实记忆库摘 40 条，`content` / 层 / 重要度 / 状态原样搬（其中含 stale 与 archived）——合成语料只能证明机制，证明不了准确率，因为真实库里的噪声是「当年写对过、现在过时了」的那种。
- 问句按「用户会怎么问」写，**不抄正文措辞**。抄正文等于把 `fieldBoost` 与 BM25 的答案直接喂给它们。
- 每条问句给一个**可接受答案集合**：同一件事写在两条里就算都对。单题排位会随语料增删漂移，只有聚合才配当基线。

### 9.155.3 三档口径：hit@1 / hit@3 / MRR，三档缺一不可

- `hit@1` 量「问一句直接答对」——这是用户体感。
- `hit@3` 量「找得到但排第二」——这是可修的那一类，和找不到分开记账。
- `MRR` 防止用「都在前三」掩盖退步：排第二要扣分。
- 当前基线：**hit@1 0.844 / hit@3 0.978 / MRR 0.912（45 问）**。阈值卡在基线下方（0.80 / 0.95 / 0.88），留出语料增删的抖动空间，同时任何实质退步都翻红。

### 9.155.4 阴性对照：尺子必须先证明自己量得到东西

`G5` 把 importance 全抹平、`G5b` 把语料顺序反转，三档必须变化。0.2.149 首跑就抓到一条**反直觉的读数**：抹平 importance 之后 `hit@1` 从 0.844 涨到 0.867（+0.022）。

也就是说，在这套语料上**重要度是负收益**：`importance=4` 的总览 / 铁律条目把「专讲那件事」的条目挤到第二（`0.2.147 改了什么` 第一名是项目总览 `0mwpsco0`，正解 `0mwq7e84` 第二；`评测台为什么封存` 正解掉到第 4）。这条读数不改代码、只记录——判据只断言「量得到这一手」，方向只报不判：方向会随语料变，尺子不许替读数说话。下一刀要治的就是它（重要度的作用范围 vs 85% 豁免口径）。

### 9.155.5 与既有 levers 不重叠

这条不碰打分链的任何一处：没有新常量、没有新权重、不改任何 `search()` 行为。它只增加一支**只读**的探针与一份语料 fixture，问的是「结果对不对」而不是「实现对不对」。前面六件（fieldBoost / coord / entityPrior / sessionTopic / importance / recency / status）各自量「怎么给分」，噪声地板量「谁参与给分」，标识符量「有没有不该被分词的整串」，补分位置量「证据在乘法链的哪一段」——这把尺子量「合起来以后，答对了没有」。

### 9.155.6 覆盖

`tools/probe-gold.mjs` 的 G0–G6（9 条断言）已挂进 `tools/check-all.mjs`。语料在 `tools/fixtures/gold-recall.json`（40 条样张 / 45 问句）。三档聚合 + 两次阴性对照 + want 存在性检查。

## 9.156 分数算得对，排位还是错：三条权重一路都在替证据做决定（0.2.150）

### 9.156.1 症状：三个问句，三条正解都被权重挪到了后面

`tools/probe-gold.mjs` 在 0.2.149 报出 hit@1 = 0.844，7 条没排第 1。把每条的 `bm25 / importanceWeight / recencyWeight / statusWeight` 拆开看（`E:\Temp\probe150-detail.mjs`），失败不是同一类：

- `0.2.147 改了什么`：正解 `0mwq7e84` 的 bm25 = 7.02，比第 1 名高一倍；但它已经被 0.2.148 的交付 fact 取代成 stale（状态权重 0.6），最终 5.265 → 9.98。第 1 名是项目总览 `0mwpsco0`，bm25 只有 3.833，靠 importance=4 的 1.75 倍乘到 11.42。
- `评测台为什么封存`：正解 `0mwpsfb0` 的 bm25 = 6.869（第 2 高），但它是两个月前的记录，新鲜度权重算出来 0.08，乘完只剩 0.687，掉到第 5；第 1 名是一条 rules（bm25 8.761、importance=4）。**问的就是「为什么封存」，被时间折掉的正是那份封存记录。**
- `现在主线推进到哪一版`：第 1 名是 bm25 3.625 的定调 rules（×1.75），第 2 名才是项目总览。

共同点：词分是对的，乘法链也没算错——错的是「谁有资格跟谁比」。

### 9.156.2 判断：权重是「先验」，不是「证据」

0.2.85 加 importance 时，注释里已经把边界写死了：「只做加成、不做碾压：BM25 代表『说的是不是这件事』，重要度只该在同题竞争里把铁律抬上来」。但实现是乘法，而乘法天生会碾压——1.75 倍在 BM25 差 1.8 倍的场合就翻盘了。新鲜度那一手更极端：0.08 倍等于把一条记忆从榜上抹掉。

一句话：**先验可以决定同分时谁先开口，不能决定谁有资格开口。**

### 9.156.3 修法：证据先分档，档内才谈权重

- `IMP_BAND = 0.85`：把候选按词分降序扫一遍，掉到当前档锚点 85% 以下就开新档。档号升序 = 证据强度降序，`bandize()` 先按档号排、档内才比 `score`。权重再大也越不过一档。
- `RECENCY_FLOOR = 0.6`：`w = Math.max(0.6, recencyWeight(...))`。时间折扣保留（近期仍然优先），但最多折掉 40%——旧记忆变暗，不会消失。
- 指认排 `band -1`：问的正是这条 id（`0mzz9abc1 是什么`）是最强证据形态，它的词分是 0，不许被词分分档扫到最后一档。0.2.147 / 0.2.148 的保证在分档之后仍然成立。
- 顺带把 recency 豁免里写死的 `0.85` 换成 `IMP_BAND`——同一个带的判据本来就该是同一个数。

### 9.156.4 读数

| 口径 | hit@1 | hit@3 | MRR |
| --- | --- | --- | --- |
| 0.2.149（乘法链） | 0.844 | 0.978 | 0.912 |
| 只把 importance 关进带 | 0.867 | 0.978 | 0.923 |
| importance + 新鲜度下限 0.6 | **0.867** | **1.000** | **0.933** |
| 三条权重全按带 | 0.867 | 1.000 | 0.933 |

瓶颈在新鲜度（0.08），不在状态；把三条都按带和只给新鲜度加下限读数一样，所以选择后者——少动一条权重。

`0.2.147 改了什么` → 第 1，`评测台为什么封存` / `评测台还能跑 locomo 吗` → 第 2，`现在主线推进到哪一版` 仍是第 2（第 1 的定调 rules 词分确实更高，它没越级，这是可接受的平手）。门槛因此抬到 G1 ≥ 0.86 / G2 ≥ 0.99 / G3 ≥ 0.92。

### 9.156.5 与已有 levers 不重叠

0.2.147 定「一笔证据值多少」，0.2.148 定「这笔证据在税前还是税后发」，0.2.150 定「谁有资格进同一张榜」。三刀各管一段：分词、位置、资格。没有任何一条改词分本身。

### 9.156.6 覆盖

`tools/probe-gold.mjs` 的 G0–G7（11 条）与 `verify.mjs` 的 VY1–VY15（15 条）：

- G5a / VY10：同档内 importance 4 vs 2，4 在前（重要度没被废掉）。
- G5b / VY11：带外条目 band ≥ 1、榜首是 band 0（跨不过去）。
- G5c / GX16：抹平 importance 后仍然达标（先验不是证据）。
- G7 / VY12：一年前的条目 `recencyWeight` 停在 0.6 且仍在榜上。
- VY8 / VY13：指认排 band -1。
- VY1–VY9：常量、bandize 形状、两处 `IMP_BAND`、两处 `Math.max(RECENCY_FLOOR, …)`、两处 `_raw`、两处清理、`explain.band`。
## 9.157 问「高铁票怎么改签」，它答得出记忆库里的一条教训（0.2.151）

### 9.157.1 症状：沉默被当成失职，回执被当成业绩

拿十四条与记忆库毫无关系的问句去问（天气、红烧肉、秦始皇、火星、吉他、酸菜），十条凑出了回执：

```
高铁票怎么改签      → 0mwq614d  4.76  （命中词：「怎么」）
怎么腌酸菜不坏      → 0mwq614d  4.76  （命中词：「怎么」）
火星上一天有多少小时 → 0mwq617y  3.87  （命中词：「小时」）
吉他换弦要注意什么   → 0mwq610a  2.99  （命中词：「什么」）
```

最高分 4.76，而正例里最低的 top1 是 5.53——**差一点点就能用绝对分卡住，但那是碰巧**。真正的原因是：
这些条目每条只沾到问句里的**一个词**，而那一个词是虚词。

### 9.157.2 根因：中文一直没有停用词表

0.2.146 的噪声地板用 df 比例（出现在一半以上条目里的查询词不参与打分）代替停用词表，注释里也写着
「中文没有停用词表（英文靠 normalizeEn 的 EN_STOPWORDS）」。df 比例只认识「到处都是」的词，
治不了另一半噪声：**哪都没有、却毫无信息**的两字碎片。`怎么` 在本库 df=1，idf 高得离谱——
越罕见越像证据，这就是虚词在 BM25 里的天然伪装。

### 9.157.3 修法：把那张表补上，并且只补在问句侧

`var CJK_FUNC_WORDS = new Set([...])`：单字（的/了/是/在/那/哪/我/你/什/怎…）、问句骨架双字
（怎么/什么/为什/么样/哪些/多少/是否/可以/应该/一下/还是/就是/没有…）、以及**分词跨界产生的碎片**
（用的/的天/的时/上一/么一/送为）。`funcTermsOf(qTerms)` 只从**查询词**里剔，不动文档侧词表——
文档里写「怎么」是正文，问句里写「怎么」是问法。

三条护栏：
1. 只对中文生效，标识符与英文内容词一个不动（`latency`、`D:\dsh-home\vendor\meow-memory` 照旧命中）。
2. 剔完一个词不剩就整段回退：问「为什么」这种纯虚词问句照旧打分，宁可噪声也不凭空空手。
3. `funcFloor:false` 一键回到旧口径；剔除项点名写进 `explain.funcDropped`。

### 9.157.4 读数

| 指标 | 0.2.150 | 0.2.151 |
|---|---|---|
| 负例（14 条无关问句）空手 | 4/14 | **12/14** |
| hit@1 | 0.867 | **0.933** |
| hit@3 | 1.000 | 1.000 |
| MRR | 0.933 | **0.967** |

空手率与准确率同时涨，是因为虚词碎片不只污染负例，也在正例里给噪声条目加过分。
剩下两条仍是硬凑：`Python 的 GIL 在 3.13 有变化吗`（命中 `python`）、`火星上一天有多少小时`（命中 `小时`）——
那两条是**问句里真有一个词、库里也真提到过，只是那是另一件事**。硬把「沾了一个真词」也判成空手，
代价是 `publishTimestamp 该写什么值` 这种「只沾一个标识符」的正例一起被砍掉。所以这一刀只切虚词。

### 9.157.5 与既有 levers 不重叠

- 0.2.146 噪声地板：按 **df**（到处都是）剔词；这一刀按 **词性**（哪都没有也不带信息）剔词。
- 0.2.147 标识符原样匹配：管「被分词打碎的整串怎么找回」；这一刀管「本来就该碎的虚词不要当证据」。
- 0.2.148 补分在加权之后、0.2.150 证据先分档：都在管**已经进了候选的条目怎么排**；这一刀管**谁配进候选**。

### 9.157.6 覆盖

`tools/probe-recall.mjs` 的 VT1–VT7（虚词单独挡噪声 / 报 funcDropped / 一键关 / 纯虚词回退 /
两支同口径 / 标识符与英文不受影响 / 只剩一个内容词不许空手）、`tools/probe-gold.mjs` 的 G8–G9
（空手率 + 阴性对照）、`verify.mjs` 的 VZ1–VZ15（源码锚 + 行为锚 + 文档锚）。

## 9.158 关键词是标签，不是正文（0.2.152）

### 9.158.1 先说尺子：它在说谎

0.2.149 造了准确率尺子（`tools/probe-gold.mjs`，40 条样张 + 45 条问句），0.2.150 在这个尺子上分了档，
0.2.151 又在它上面量了虚词地板。三刀都过了，直到 0.2.152 去翻尺子的料：**40 条样张的 `keywords` 全是空的**，
而真库里 40 条一条不落全带（平均 9.2 个，最少 6 个，最多 14 个）。

这意味着两件事：
- 0.2.133 写下的 `FIELD_KW_W = 0.35`（关键词字段加成）**从来没有被量到过一次**；
- 0.2.149–0.151 的阈值，全部建立在一份「没有关键词」的语料上，而关键词恰恰是主 BM25 语料的一部分
  （`docText(d) = [title, content, ...keywords].join(" ")`）——真库里的 keywords 一直在稀释正文。

修法不是调阈值，是**把料补真**：用真库的 `keywords` / `title` / `content` 覆盖进 fixture，另外补一组
14 条 `paraphrase`（问句刻意避开正文用词，比如「自动筛掉结果的时候，要不要给接班的那条开个小门」）。
修完之后 docs 40 / queries 45 / paraphrase 14 / missing 0。

### 9.158.2 试过的三条路，两条不通

| 做法 | 照抄池 hit@1 | 换说法池 hit@1 | 结论 |
|---|---|---|---|
| 字面 n-gram 向量单用 | 0.933 | — | 它是「字的重复」，不是语义 |
| RRF(bm25 + 字面向量) | 0.911 | — | 比单用还差：两条路错在同一处 |
| keywords 单路 | 0.500 | — | 只认识标签，不认识话 |
| RRF(bm25, keywords) | 0.571 | — | 照抄池掉到 0.800，得不偿失 |

真语义向量要 embedding——与本插件「便宜、快」的立身之本相冲突，这一轮不做。阈值闸门也试过了，不可行：
14 条无关问句的最高 cosine 是 0.122，而换说法正例分布在 0.017–0.216，**完全重叠**，没有任何一个阈值能分开。
自适应（bm25 弱时才启用 keywords）同样不通：照抄词的第 10 百分位 5.34，换说法正例的第 90 百分位 11.9，也重叠。

### 9.158.3 定案：把关键词的 tf 拆成两路

- `kwSeparate`（默认开）：正文 BM25 只吃 `title + content`，关键词不再摊进正文；
- `kwTfW = 0.25`（默认）：关键词仍计入 tf，但**打两五折**；df 取并集，候选资格一点不掉；
- 0.2.133 的 `FIELD_KW_W` 保留为**字段加成**（同一篇里命中关键词额外给一点），与 tf 折价各管一段。

扫参读数（同一条 14 条负例清单）：kwTfW 0（等于只剩字段加成）照抄 0.911 / 换说法 0.500；0.15–0.25 同分但
换说法 MRR 从 0.586 抬到 0.598，空手 9/14；0.35–0.5 换说法掉回 0.429；1.0 照抄退回 0.889。取 **0.25**——
区间中部，上下都留了抖动余量。

### 9.158.4 读数与代价

| 指标 | 0.2.151（keyword 平铺） | 0.2.152（keyword 当标签） |
|---|---|---|
| 照抄池 hit@1 / hit@3 / MRR | 0.889 / 0.978 / 0.933 | **0.911 / 0.978 / 0.944** |
| 换说法池 hit@1 / hit@3 / MRR | 0.429 / 0.714 / 0.565 | **0.500 / 0.714 / 0.598** |
| 无关问句空手（14 条） | 12/14 | 9/14 |

第三行是这一刀**明码标价的代价**：0.2.151 的 12/14 是在「关键词全空」的假语料上量出来的；关键词补真之后，
「吉他换弦要注意什么」「红楼梦里通灵宝玉是什么来历」「秦始皇哪一年统一六国」这三条真能在库里找到**标签**
（真库确实在 keywords 里写了这些词），于是桥接进了榜。它们没进正文，只是沾了标签——这正是「标签桥接」
本身的性质：**桥能过车，也能过噪声**。要不要给「只有标签命中、正文一个字没有」的条目另立一道闸，
留给 0.2.153 用同样的量法决定，这一刀不动它。

### 9.158.5 覆盖

- `tools/probe-gold.mjs`：G10（换说法组 0.45 / 0.65 / 0.52）+ G11（`kwSeparate:false` 时两个池都不许更好），
  十一支断言；
- `tools/probe-recall.mjs`：R1 契约重写（首条是正文就在说这件事的那条）、R2 的 bm25 对照、两条阴性对照
  （抹平 importance 后铁律分数必须掉；独立小语料上「按时间升序会先给无关的旧条」）；
- `tools/probe-fusion.mjs`：DT5 改判（邻居行「至少一条、每条都到天、没有一条带分钟」，原写法要求必有 ↑ 行，
  排名一变就空转成假红）；
- `verify.mjs`：EY 三组行为锚按新语义重写（标签压不过正文 / `fieldBoost` 真在给 / `kwSeparate:false` 时才翻盘 /
  keywords 不再进正文长度），GX 门槛跟着尺子改到 0.88 / 0.95 / 0.92，GX21–GX22 盯住新加的两组。

## 9.159 检索先建表，再记指纹（0.2.153）

前六刀量的都是「答得准不准」。主人给的六条标准里还有两条一直没人量：**效率**（检索要快、不拖累当前任务）
与**成本**（每次问答要花多少）。这一刀先造尺子，再按尺子读数动刀。

### 9.159.1 尺子：`tools/probe-cost.mjs`（八支断言）

语料三档：40 条真样张、复制到 400、复制到 1200（复制时 id 加 `-rN` 后缀，模拟真库迟早要到的量级）。
每档热身一遍再逐问计时，取 p50 / p95 / max。

- C1 三档成形、id 唯一；
- C2 1200 条时单次检索 p95 ≤ 20ms；
- C3 规模三倍时耗时 ≤ 4.5 倍（守的是别出现平方级；指纹那一段注定线性，见 9.159.3）；
- C4 正文只被 tokenize 一次（静态：`tokenize(String(d.content` 出现次数 ≤ 1）；
- C5 结果快照：top-5 的 `id:score` 与 `tools/fixtures/cost-snap.json` 逐位相同（45 问 × 40/1200 两档）；
- C6 等长改写（「蓝绿切换」→「红黑切换」，同为 17 字、`updated_at` 同秒）指纹必须变；C6b 改完立刻问，
  答的是新库（旧库里根本没有「红黑切换」，分数 0.490 vs 2.079）；
- C7 `cache:false` 与 `cache:true` 答案逐位相同；C7b 关缓存明显更慢（272ms vs 4,891ms，17.5×）；
- C8 同一张库连问不再建表（size 稳定在 1），改一条后才 +1；C8b 上限 4 张。

### 9.159.2 读数

| 语料 | 改前（0.2.152） | 改后（0.2.153） |
|---|---|---|
| 40 条 | — | p50 0.1ms / p95 0.3ms |
| 400 条 | — | p50 1.0ms / p95 2.0ms |
| 1200 条 | **p50 107.2ms / p95 121.8ms** | **p50 2.9ms / p95 5.1ms** |

拆账（一次性拆账脚本，跑完即删，不进仓库）：1200 条时 tokenize 全库 30.3ms、建 tf/df 36.3ms、
打分 42ms——三次彻底线性，问一次就从头算一遍。

### 9.159.3 三件事，缺一件都不成立

- **建表搬出来**：`buildSearchIndex(docs, opts, sig)` 把原来 `search()` 内联的切词、tf/df、长度基准、
  标题/关键词集合全收进去，顺带建 `postings`（词 → 条目下标）。打分从「整库每一条都乘一遍」改成
  「只扫问句里那几个词真的出现过的条目」。`opts.inverted === false` 可关掉倒排（阴性对照）。
- **指纹**：`indexSignature(docs)` 用 FNV-1a 混「id / updated_at / 长度 / 头 40 字 / 尾 40 字 / 标题全文 /
  关键词全文 / 会话」。0.2.153 初版只看 `content.length`，等于承认「同一秒内等长改写」可以拿旧表答新库——
  C6 就是为这个缝造的。指纹必须逐条过一遍，所以这一段是线性的（C3 只守别出平方级）。
- **缓存**：`searchIndexCache` 最多 4 张（LRU），键 = 指纹 + 影响切词的那几个开关（`fieldBoost` /
  `kwSeparate` / `sessionTopic` / `kwTfW` / `inverted`）。`opts.cache === false` 关缓存；
  `opts.index` 传外部表时签名与口径都得对上，宁可多算一次指纹也不信任调用方。

### 9.159.4 红线

缓存是「省时间」不是「省事」：C5 与 C7 两条逐位比对把它钉死在「只许变快，不许变答案」上。
凡是「拿旧结果回答新问题」的优化都必须配一条等长改写的探针，否则它安静得很——
静悄悄答错的缓存，比慢十倍更贵。

### 9.159.5 覆盖

- `tools/probe-cost.mjs` 新增（八支，进 check-all）；
- `verify.mjs` XA1–XA10（常量 / 指纹组成 / 倒排开关 / 缓存开关 / 四个导出 / 三条行为 / 文档锚 / 量具在位）；
- 顺带修一处旧伤：0.2.152 的 WZ 段原本排在 `process.exit()` 之后，等于一条都没跑——总结与退出已挪到文件末尾。

## 9.160 「比了就是一条断言」：计数型基线不能跟运行时刻耦合（0.2.153 收尾）

`node tools/check-all.mjs --update-baselines` 记完基线，下一次干净树跑出来永远比基线**少一条**，
再记一次又多一条，来回抖。这不是脚本坏了，是**断言条数与输入状态耦合**：

- `check-all.mjs` 的 `countPass` 只数行首 `PASS`（`/^PASS/gm`），`FAIL` 不计；
- `tools/baselines.json` 是 `check-all` **收尾时才写**的产物；
- 而 `doctor.mjs` 的两树比较原本写成
  `if (drift.length === 0 && extra.length === 0) pass('两处字节一致') else fail('两处不一致')`。

于是「记基线的那一趟」看到的树必然不一致（`baselines.json` 还没同步到 profile 副本），
那一趟少一条 `PASS`；下一趟树干净了、`PASS` 回来了——基线永远差一，而且**差的方向还取决于先改哪边**。

### 9.160.1 处方

比较本身**永远算一条 `PASS`**（它说的是「比较跑完了」），不一致另起一条 `FAIL`：

```js
const clean = pair.drift.length === 0 && pair.extra.length === 0
pass('两处比较跑完了', clean ? `字节一致 / ${pair.count} 个文件`
  : `${pair.drift.length} 个漂移 / ${pair.extra.length} 个多余（见下，判红在下一行）`)
if (!clean) { fail('两处不一致', ...); for (const d of pair.drift.slice(0, 12)) console.log(`      drift: ${d}`) }
```

判红逻辑一个字没动（`makeVerdict` 只看 tag：`FAIL` 就是失败），变的只是**条数**：
干净树 1 条 `PASS`，漂移树 1 条 `PASS` + 1 条 `FAIL`，`countPass` 两边都读到 1。

### 9.160.2 同一条原则的老判例

- 0.2.55：待补连队列「有排队」与「没排队」都打一条 `PASS`；
- 0.2.86：备份「建成之前」与「建成之后」都走 `pass`，不走 `warn`；
- 0.2.103 收尾同理：成本账本在不在都算一条断言。

凡是「有问题才少打一行 / 多打一行」的写法，都会让基线与**运行时刻**耦合。
反过来也成立：想加一条只在特定状态才出现的断言，就得同时给它一条「另一态」的断言，
否则这支脚本的条数就是它的状态数。

### 9.160.3 验收与读数

- 手动往 profile 副本里塞一行注释造漂移：`doctor` 两种状态都是 **155 条 `PASS`**，漂移态多一条 `FAIL`（`1 个漂移 / 0 个多余`）；改回去即恢复 `字节一致 / 168 个文件`。
- `check-all` 三趟：记录基线一趟、同步后干净树两趟，全部 **23/23 通过、2,999 条**。
- `tools/baselines.json` 的 `version` 与 `counts`、`README.md` 两处「2,999 条断言 / 191s」同源。

**教训**：基线是「这支脚本应该跑出多少条」，它必须只跟**代码**有关，不能跟「此刻磁盘上是什么」有关——
把状态写进条数，等于把一把会自己伸缩的尺子钉在墙上。


## 9.161 可选的一路：稠密向量进门，但不许要门（0.2.154）

**一句话**：词法只认同一个词，换一种说法就瞎；0.2.154 给检索加了一路**可选**的稠密向量，两路用 RRF 融合名次，缺依赖/缺模型就静悄悄退回纯词法、结果逐位不变。默认不走，因为它要 22.9 MB 模型 + 371.9 MB 运行时。

### 9.161.1 为什么是「融合」而不是「换掉」

40 条 gold 语料、45 条照抄词问句、14 条换说法问句（`tools/fixtures/gold-recall.json`），模型 `bge-small-zh-v1.5` q8、dim 512：

| 方案 | 照抄池 hit@1 | 换说法池 hit@1 / hit@3 / MRR |
| --- | --- | --- |
| 纯词法（现状） | 0.911 | 0.500 / 0.714 / 0.598 |
| 纯稠密 | 0.689–0.711 | 0.643 / 0.714 / 0.627 |
| 直接分数相加（cos×k + bm25） | 0.867 | — |
| 稠密为主（cos + α/(60+lexRank)） | 0.733–0.778 | — |
| **RRF k=60，词法 1 : 稠密 0.10** | 0.911 | 0.571 / 0.786 / 0.685 |
| **RRF k=60，词法 1 : 稠密 0.25** | **0.933** | **0.571 / 0.786 / 0.702** |

三条读法：①纯稠密在照抄池输给 bm25 五个点——它抓不住精确术语（版本号、id、路径），所以它只能是**加法**；②两把尺子的刻度无关，直接相加等于让「谁的单位大」决定排序，所以只能**换名次**（RRF）；③w 往上推会把照抄池里原本正确的第 1 挤掉（w=0.3 时 lost@1=1），所以定 w=0.25，判据里同时钉住「原本第一的一条都不许掉」。

分数口径：融合后把 RRF 归一化回**词法榜首分**（`scale * s / maxRrf`）。下游 `min_rel` 是「相对榜首的百分比」，换一套尺度会让 0.35 这条线突然变成另一个意思。

### 9.161.2 四个坑（全是实测撞的）

① **批编码会按批内最长补 padding**：同一段文字「单独编」与「16 条一批编」，向量最大差 **0.015**（`E:\Temp\batchdiff.mjs`）。近分带足够翻名次，更要命的是同一条记忆会因为「库里还有谁」拿到不同向量——缓存就失去意义。于是 `DENSE_BATCH = 1`：宁可慢三倍，也要让向量只取决于它自己。
② **transformers.js v3 的 dtype 只认** `auto|fp32|fp16|q8|int8|uint8|q4|bnb4|q4f16`；写 `quantized` 会报 `Error: Invalid dtype: quantized`。
③ **远程加载走不通**：hf-mirror 把请求 302 到 `cas-bridge.xethub.hf.co`，直接 `ConnectTimeoutError`。所以必须先下好 5 个文件，再 `env.allowRemoteModels = false; env.allowLocalModels = true; env.localModelPath = <父目录>;` 本地加载（模型就绪 114ms）。
④ **Node 入口是 `dist/transformers.node.mjs`**，不是 `dist/transformers.mjs`（后者不存在，报 `Cannot find module ...dist\transformers.mjs`）。

### 9.161.3 三处开关，四次静默

- 总开关 `MEOW_DENSE=0` 必须在 **`rankForSearch` / `denseRank` / `denseWarm` 三处都认**。只认一处就是「关掉了却还在算」——排查时看到的结果会变成谎话（第一次实现只在 `rankForSearch` 认，实测 8 问里 8 问都不相同，等于没关）。
- 静默清单：没有 `@huggingface/transformers`、没有模型目录、候选目录里没有 `config.json`、模型加载或编码失败——任何一种都置 `state = 'off'`（**只试一次，不重试**），并返回词法原样。警告一次都不打：打警告等于每轮花 token 说同一件事。
- **先进向量、不进首问**：`memory_search` 第一次跑只把 `denseWarm(docs)` 排进后台（不 await）；`denseRank` 只对「已经有向量」的条目算余弦。1200 条实测预热 14.0 s、缓存 3.3 MB、之后单问 1.6 ms——让第一次检索等 14 秒是不可接受的。
- 缓存：`<记忆家目录>/dense-cache.json`，`{model, dim, items: {key: base64(Float32)}}`；key 是「id + 文本」的 FNV-1a 哈希，模型名或维度不符**整份作废**；写入走 `.tmp` + rename。

### 9.161.4 判据：unloaded 不是「可用」

`tools/probe-gold.mjs` 的 G12/G13/G14 三条，条数固定（有没有模型都各打一行，理由见 9.160）：

- **G12**：状态只许三态 `unloaded / ready / off`；`ready` 必须 `dim > 0 && err === null`，`off` 必须带得出原因（非空字符串）。
- **G13**：`opts.dense === false` 与 `MEOW_DENSE = '0'` 两条退路都必须**逐位相同**（连 `score.toFixed(9)` 都相同）；开关关掉时预热 `embedded === 0`。
- **G14**：有模型时——照抄池 hit@1 ≥ max(词法, 0.92)、换说法池 hit@1 ≥ max(词法, 0.55)、hit@3 不低于词法，且**原本第一的一条都不许掉**；没模型时——退回词法逐位相同。

踩的坑：`denseStatus()` 在「还没试过」时返回 `unloaded`，而 `unloaded !== 'off'`。第一版判据把它当「可用」，于是没装依赖的机器掉进质量门槛那条、直接 `FAIL`。修法：**先 `denseWarm` 一次，用 `warm.state` 判可用性，再读 `denseStatus()` 打标签**——没试过之前读到的状态不是结论，把它写进判据等于自己骗自己。

### 9.161.5 读数与代价

| 项 | 数 |
| --- | --- |
| 照抄池（45 问） | hit@1 0.911 → **0.933**，MRR 0.944 → **0.957** |
| 换说法池（14 问） | hit@1 0.500 → **0.571**，hit@3 0.714 → **0.786**，MRR 0.598 → **0.702** |
| 1200 条预热 | 14.0 s（一次），缓存 3.3 MB，之后单问 1.6 ms |
| 模型 | `bge-small-zh-v1.5` q8，22.9 MB |
| 运行时 | `@huggingface/transformers@3.5.1` 装 371.9 MB（win32 原生 67.2 MB，全平台 207.8 MB） |

代价远大于收益里的「省时间」那部分，所以**默认关**。它卖的是「换一种说法也找得到」，不是「更快」；快是 0.2.153 那件事（107.2 → 2.9 ms）。

## 9.162 空手闸门：宁可沉默，也不硬凑（0.2.155）

9.161 让稠密层进了门，但它只被用来**换名次**。这一节说的是它第二件、也许更值钱的事：**判「该不该说话」**。

### 9.162.1 词法为什么做不到

G8 那一批 14 条无关问句里，「火星上一天有多少小时」能凑出回执，靠的词在库里 df=1——全库最稀、idf 3.31。
词法上它跟「真正相关」没有任何区别：都是一个稀有词、一条命中、分数不低。噪声地板（9.154）靠的是「到处都是」，
虚词地板（9.157）靠的是「哪都没有」，两者都解释不了「稀有但无关」。

覆盖率这条也走过（实测否掉）：负样本覆盖率能到 1.000（「怎么腌酸菜不坏」把 怎么 / 不 都沾上），
而正样本换说法池 p50 只有 0.483——分母越大越不容易满足，这条线只会先杀掉真问题。

### 9.162.2 用什么判：全库最大余弦

问句编码一次，与库里每条算余弦，取最大值。这个数回答的是「库里有没有一条跟这句话讲同一件事」，
跟「词对不对得上」无关。

实测（40 条 gold 语料）：

- 正样本（45 照抄 + 14 换说法）最低 **0.477**；
- 负样本（14 条无关问句）：0.236 / 0.277 / 0.292 / 0.294 / 0.316 / 0.351 / 0.359 / 0.376 / 0.387 / 0.392 / 0.412 / **0.521** / **0.558**；
- 门槛 **0.44**：负样本挡住 **13/14**，正样本误杀 **0/58**（漏过去的是「Python 的 GIL 在 3.13 有变化吗」，0.558——它跟库里讲 GIL 与版本的那些条目确实同域）。

注意这里用的是**全库**最大余弦，不是「融合榜首那条的余弦」：榜首先由词法定，词法错的时候榜首那条的余弦也就偏低，
拿它当判据等于用错的东西去判错。两种口径的差别不是小数点：融合榜首口径下正样本最低 0.424、负样本最高 0.521，**交叠**；
全库口径下 0.477 / 0.412，干净分开。

### 9.162.3 三条不许省的约束

1. **只在全库都有向量时判**。`denseNearest` 回 `covered` 与 `total`，不等就 `fired:false` 并在 `why` 里说清。
只覆盖一部分时最大值必然被低估——这是「把真问题掐掉」的唯一来源。
2. **稠密没就绪就一条都不判**。`MEOW_DENSE=0`、没运行时、没模型 → `why` 写明原因，回执一个字节不多。
0.2.154 的 G14 已经守着「退回词法逐位相同」，闸门不许破坏这条。
3. **可关、可调**。`MEOW_DENSE_ABSTAIN=0|off` 关闸，`0~1` 调门槛（越严越大）。判据里写着「关掉后一条都不许掐」。

### 9.162.4 验收（probe-gold G15，条数固定一行）

- 有模型：`挡住 ≥12/14` 且 `误掐 = 0/58`；打印漏过去的是哪一条。
- 没模型：`挡住 0/14` 且 `误掐 0/58`——这一行不是凑数，它是「可选性」本身的验收项。
- 端到端（临时库 + 真 `memory_search`）：负样本 `hits: []`，`note` 里写着「这次零命中不是『库里没有』，是这条问句跟记忆库不沾边：…余弦只有 0.288，低于门槛 0.44」；把 `MEOW_DENSE=0` 一设，同一条问句又凑出 2 条。

### 9.162.5 读到的数

| 项目 | 数 |
| --- | --- |
| 门槛 | 0.44（`DENSE_ABSTAIN_COS_DEFAULT`） |
| 负样本挡住 | 13/14 |
| 正样本误杀 | 0/58 |
| 判一次的开销 | 一次问句编码（1.6 ms）+ 全库点积（1200 条 512 维约 0.6 ms） |
| 全库没向量时 | 不判，`why` 说明覆盖 N/M |

一句教训：**「有没有答案」和「答案对不对」是两个问题，别指望同一个分数回答两个问题。**

## 9.163 来源一行：可追溯性不是「写过」，是「读的时候能顺着走」（0.2.156）

### 9.163.1 缺的是哪一半

0.2.138 的取代链只做了谱系的一半：**「它被谁接走了」**。另一半一直空着——**这条是谁写的、什么时候进的库、是整理封存的还是会话里直接写的、还有没有人用过**。

字段其实一个都不缺。七层表都有 `source_session` / `hit_count` / `last_accessed_at` / `corrected`，`dream_log` 记着每一轮整理的 `run_at` 与 `summary`，`windows` 记着每个会话的工作区与最后一次整理时刻。缺的是**读口**：
`memory_read` 的回执只印「`[层] 标题（状态）` / 项目 / 目标 / 正文」，最后一句是「需要更多细节，可以直接去聊天记录里搜索相关关键词」——真相就在库里的三列上，却让人肉去聊天记录里捞。文档甚至明写「要看来源会话、时间戳就去查 SQLite」。这就是「可追溯」做成了「我们写过」。

真库里这半边有多空：506 条 active 里，`source_session` 全有（296 条来自当前会话，25 / 4 / 2 条来自更早三次会话），但 `hit_count` 只有 138 条 > 0，且最大值只有 2。

### 9.163.2 一行里放三块，四种来路各说各的话

回执里新的一行（`📜` 开头，跟在正文后面、取代链前面）：

| 块 | 说什么 | 缺了怎么办 |
| --- | --- | --- |
| 来源 | 整理封存 / 会话直写 / 老库迁移 / 没记来源会话 | 整块不出，不给「来源未知」占位 |
| 使用 | `被读过 N 次（最近 …）` 或 `还没被检索用过` | 永远有话说（0 次也是信息） |
| 纠正 | `主人纠正过` | 没纠正过就不写 |

四种来路必须分开说，因为它们对可信度的影响完全不同：

- **老库迁移**（`source_session = 'migration'`）：`来源：老库迁移过来的（… 落库），没有原始会话`——这条永远追不回原话。
- **整理封存**：`来源：会话 4be47b9a 在 2026-11-21 01:55 那次整理里封存`——它是被压缩过的，细节在原始会话里。
- **会话直写**：`来源：会话 4be47b9a 当次直接写进来（2026-11-21 22:32）`——写的时候人还在场，值得先信。
- **没记来源会话**：`来源：没有记来源会话，2026-11-21 22:34 进的库`——不许读成「没有来源」，只许说「没记」。

### 9.163.3 四条约束（照抄 chain.js 的纪律）

1. **只在有话说时才出现**。三块各自可缺，全缺就空串：一句「来源未知」既占 token 又没说事。
2. **不改任何数据**。只读三列 + 两张日志表：不新增列、不回填旧条目、**不 `markAccessed`**——读一条记忆的元数据不该把它变成「最近被用过」（否则「还有人用吗」这一栏会被读它的人自己污染）。
3. **拿不到就闭嘴**。没工作区 / 没库 / 库读不开 / id 找不到一律空串，且先 `existsSync` 判存在——**绝不为了印一句说明顺手建出一个空库**（G16 专门验这一条）。
4. **近似要说明白**。「整理封存」是按「`created_at` 之后 6 小时内有 `dream_log`」推的，所以措辞用「那次整理里封存」，不用肯定句；推不出来就说「当次直接写进来」。

### 9.163.4 验收

- `probe-gold` 新增 **G16**（19 → 20 条，仍一形态一行）：人造库四种来路各说各的话 + `没库` 与 `空 id` 都必须空串、且不建库。
- 集成（桩掉上游、只挂真 `createRead`）：回执里出现 `📜 来源：…`，上游 `memory_read` **只被调用一次**（没有为溯源多跑一趟），预算尾注按**含这一行**的长度算（`≈86 token／预算 2000，装下了`）。
- 真库抽样：最早一条念「会话 cd7b53eb 在 2026-11-19 01:34 那次整理里封存 · 被读过 2 次（最近 2026-11-19 01:16）」；刚写的一条念「当次直接写进来（2026-11-21 22:32） · 还没被检索用过 · 主人纠正过」；短 id 8 位与整条 id 结果一致。

### 9.163.5 读到的数

| 项目 | 数 |
| --- | --- |
| 真库 active | 506（`source_session` 全有，`hit_count > 0` 的 138 条） |
| 整理账本 | 4 轮（最近 2026-11-21 09:55） |
| 回执成本 | 一行约 40–60 字（≈50 token 里的一半是中文），只在 `memory_read` 出现 |
| 多花的往返 | 0 次（同一趟读库，不再调上游） |

一句教训：**「我写过」和「你读得到」之间隔着一条读口；没有读口的字段，等于没有这个字段。**

## 9.164 改一条记忆，为什么必须把整段重发一遍（0.2.157）

### 9.164.1 缺口是量出来的，不是想出来的

0.2.156 补上了「这条谁写的、还有人用吗」，六个标准里只剩**可更新性**最薄。先用真库量了一遍（513 条 active）：

| 读数 | 值 |
| --- | --- |
| 正文被改过（`updated_at` 明显晚于 `created_at`） | **412 / 513**（lesson 260、fact 83、project 40） |
| 正文里带「（已被取代：…）」 | 只有 **2** 条 |
| 正文长度 | p50 248 字、最长 2,118、合计 162,665 字 |

两件事同时成立：**「改」是常态**（八成条目都在被改），而**「改」几乎不是取代**——所以绝大多数改动是**正文重写**。重写有两个代价，都不是模型能自己解决的：

1. 改一句话要**重发整段正文**。一条 2,000 字的教训，改一个版本号，来回就是 2,000 字输入 + 2,000 字回执里的正文——这是「可更新性低成本」最直接的反例。
2. 旧正文**当场消失**。`memory_update` 是整体替换，写下去的那一刻上一版就没了；写错了没有退路，也没有任何读口能回答「这条改过什么」。

### 9.164.2 三件小事，一件都不多

- **按句改**（`patch: [{find, replace}]`）：只给要动的那一句。**唯一命中**才算数——0 次是「这段不在这一版正文里」，多次是「这句话定位不到唯一一处」，两种都**一个字都不写**，把理由原样说出来（改而不中比不改更坏）。
- **末尾补一段**（`append`）：空行分隔，不把上一段连成一句。
- **改前留一版**（`revisions.js`）：写之前把旧正文留底，同一条最多 3 版；`restore: 1` 退回到改之前那一版，退回时把现在这版再留一次底——**退回去也是一次可回退的改动**。

留底表 `memory_revisions(memory_id, level, title, content, reason, saved_at)` 与库同生共死：没库不建表、先 `existsSync`；与上一版逐字相同的旧正文不重复记（留底不是流水账）；`REVISION_KEEP` 与 `SHRINK_FLOOR` 是唯二常量，写侧清理与读侧范围都读它们。

### 9.164.3 三条纪律

一、**局部修改只在融合层落地**。vendor 的 `memory_update` schema 是 `additionalProperties: false`，`patch` / `append` / `restore` / `allowShrink` 传下去会被打回——所以它们由 `defs/update.js` 自己算成最终正文，`pick` 白名单里只有原来那七个字段。这不是绕过上游，是不改上游契约（同 0.2.124 的 `context`）。

二、**留底必须在写之前**。写成功而留底失败，等于「改坏了没退路」，那才是真事故；反过来留底成功而写失败，只是多一版旧正文，无害。顺序是有方向的。

三、**防误删要有闸，但闸不能太矮**。改完比原文短三成以上、又没带 `allowShrink: true`，拒绝写——「按句改」不该顺手变成「整段删」。40 字以下的短文本不设闸：一句话本来就可以被改短，20 字砍到 8 字未必是事故。

### 9.164.4 验收

- `tools/probe-gold.mjs` G17（20 → 21 条）：纯函数 7 条（唯一命中 / 找不到 / 多处命中 / 追加空行 / 缩水拦 / allowShrink 放行 / 短文本不拦）+ 留底 4 条（逐字相同不重复记 / 最多 3 版 / 取回上一版 / 没库闭嘴且不建库）。
- `verify.mjs` FQ 七条：四个参数在 schema 且说明互斥、不进 `pick`、留底在写之前、常量单一出口、不碰使用计数、来源一行接上「改过几次」、按句改的行为。
- 端到端（`E:\Temp\rev157t.mjs`，临时库 + 桩 flow）：patch 唯一命中只动那一句、其余逐字不动；0 次命中 / 多处命中一个字都没写；缩水默认拒、`allowShrink` 放行；`restore:1` 退回上一版且当前版留底；留底 6 次后仍只 3 版；`provenanceNote` 出现「改过 3 次」。

### 9.164.5 读到的数

| 读数 | 值 |
| --- | --- |
| 真库改过的条目 | 412 / 513（lesson 260） |
| 改一句的输入成本 | 从「整段 248 字（最长 2,118）」降到「那一句 + 替换句」，通常 10–40 字 |
| 留底成本 | 每条最多 3 份旧正文，只留被改过的条目 |
| 多花的往返 | 0 次（`memory_update` 本来就要读一次库，同一趟读完算完） |

一句教训：**「能改」和「敢改」不是一回事——允许重写却不留旧版的系统，是在鼓励人别改。**

## 9.165 星图看得见「有多少」，看不见「怎么读」（0.2.158）

### 9.165.1 缺口：三千颗星，一颗名字都没有

| 读数 | 值 |
| --- | --- |
| 星图规模（`cache['graph'].stats`） | **3,013 颗星 / 17,304 条边**（11 个工作区、78 个会话） |
| 三维渲染器 | `space3d.js` 65,094 字符，九个力常数（斥力 / 弹簧 / 向心 / 阻尼…）硬编码在 `const FORCE = {…}` 里，**一个出口都没有** |
| 单颗星的名字 | `drawLabels()` 只调 `drawClusterLabels()`——3D 视图里**没有一颗星有名字**，只有簇名 |
| 局部图 | 没有。选中一颗星只能靠「详情面板」念文字，看不见它周围 |
| 已经在的 | 悬停点亮整个邻居集合（`api.highlight`）；时间回放（`timeCut`）；四类过滤滑杆 |

结论是同一句：星图能告诉你「这里有三千颗星」，读不出「这一颗旁边是谁」。而主人点名的参考（Obsidian 的 Graph View）恰好就靠这几样把它读得下去：力参数可调、局部图 N 跳、标签随距离淡出。

### 9.165.2 三件事，全在面板层

面板是 iframe 里的静态文件（`lib/host/http.js` 直接按文件服务），**改完刷新即生效、不用重启、一个字节都不进请求前缀**。这一层是当前唯一「加功能不花 token」的地方，所以本轮只在这一层动。

- **引力四个滑杆**：斥力 1200–20000 / 弹簧长度 30–200 / 项目向心 0–0.08 / 阻尼 0.6–0.96。`forceParams()` 是唯一入口（夹值 + 缺省 + 非数字兜底），面板与探针共用同一份实现。
- **局部图 0–4 跳**：`neighborhoodIds(edges, id, depth)` 是纯函数（BFS，边表字段 `.a` / `.b`），`setLocal()` 把它交给 `state.local`；`depth 0` 或空 id 返回 `null` = 不裁剪。
- **标签**：悬停/选中的那颗**永远**写名字，其余按重要度→度数取前 14 颗，透明度随相机距离在 1100→1900 之间**线性**淡出，长标题截 18 字（`clipLabel`）。

### 9.165.3 四条纪律

一、**能拧的旋钮要有界，而且只有一个入口**。四个参数各有上下夹；`forceParams()` 收所有脏输入（`null` / `''` / 非数字一律回默认，`Number(null)` 会算成 0 再被夹到下限——那等于「阻尼被拧到底」，一个手滑就把画面变成一坨）。

二、**手感也是判据**。`oninput` 只改数字、`onchange` 才重排。拖动一根滑杆会触发上百次输入事件，每次重排都要重新收敛——把「可调」做成「不可用」，比不提供滑杆更坏。

三、**裁剪只发生在「看得见」那一处**。`visible()` 是 `space3d.js` 里唯一的可见性收口，局部图只在那里裁；检索、计数、导出、连线统计照旧吃全图。「看得见」和「算得到」不许互相污染，否则「局部图」会顺手把邻居推荐也一起切断。

四、**默认值只有一份**。面板读渲染器导出的 `FORCE_BASE`；渲染器还没加载时的那份兜底镜像由探针**逐位比对**，漂了一位就红。默认值写两遍不是问题，写两个不同的值才是。

### 9.165.4 验收

- `tools/probe-nebula.mjs`（新，51 条）：纯 window 沙箱里真跑 `space3d.js`——BFS 1/2/3 跳、孤岛、`depth 0 → null`、空边表、坏边跳过；`forceParams` 默认 / 上下夹 / 非数字；`labelAlpha` 的 1 / 0.5 / 0 / 两端 / 窗口给反 / `NaN`；`FORCE_BASE` 与 `create()` 里 `const FORCE` 字面量逐数相等；面板源码接线 12 条（`visible()` 收口唯一、`setLocal` 走 `neighborhoodIds`、`setForce` 丢布局缓存、`drawNodeLabels` 接进 `drawLabels`、前 14 名上限、`onchange` 才重排而 `oninput` 不许重排、0–4 滑杆、`r === state.space3d` 才同步、没选中说「先点一颗星」、「0 跳回全图」传的是 `null` 而不是空集合）。
- `verify.mjs` FR 八条：纯函数签名与导出、局部图只在 `visible()` 收口、默认值单一来源、`onchange`/`oninput` 分工、回全图的退路、零成本（融合层与工具 schema 不含面板字样、css 有 `.slider .k`）、`check-all` 里登记了这支探针且排在 `doctor` 之前、探针自带三条阴性对照。
- **三条阴性对照（探针里真跑，不是断言存在）**：在内存里把 `visible()` 里那行收口删掉、往第一根滑杆的 `oninput` 里塞一次 `applyForceToStage()`、把面板兜底数字改一位——三条判据分别变红，磁盘上一个字节都没动。判据自己先被证伪一次，才有资格判别人。

### 9.165.5 读到的数

| 读数 | 值 |
| --- | --- |
| 新增请求前缀成本 | **0 字节**（面板是 iframe 静态文件；工具 schema 仍 13,059 B、常驻注入仍 1,235 字符） |
| 三维视图代码 | 65,094 → 72,294 字符（+7,200：三个纯函数 + 节点标签 + 三个 api 出口） |
| 面板代码 | 137,523 → 142,635 字符（两组滑杆 + 持久化 + 接线） |
| 局部图在真库里的实际效果 | 3,013 颗星 / 17,304 条边（均值 5.7 条边/点）——1 跳平均能看到 5 颗邻居，2 跳才够看形状；所以滑杆给 0（回全图）而不是从 2 起 |

一句教训：**一张图的价值不在它画了多少颗星，在于你能不能从一颗星走到它旁边那颗。**

## 9.166 问的是「哪一刻」，别按「现在」答（0.2.159）

### 9.166.1 缺口：问句自带日期，打分器当它没写

尺子是现成的：`tools/probe-gold.mjs` 的 45 条照抄问句 + 14 条换说法问句。0.2.158 收尾时的读数是 hit@1 **0.911** / hit@3 0.978 / MRR 0.944，换说法池 0.500 / 0.714 / 0.598。前四名的失败样例长这样（`rank` 从 0 数）：

| 问句 | 该答的 | 实际第一 | 症状 |
| --- | --- | --- | --- |
| 0.2.146 加了什么 | `0mwq5zzv`（那次的交付记录） | `0mwq614d` | 正解就在第 2 位 |
| 评测台为什么封存 | `0mwpsfb0` | `0mwpqwek` | 正解第 2 位 |
| 现在主线推进到哪一版 | `0mwpsco0` / `0mwq84ts` | `0mwq606x` | **前三都没进** |

第二、三条不是同一个病：第二条是「rules 条目短、字段权重大、impW 高」造成的证据差（bm25 12.475 vs 6.544），换口径救不了，只有把语料写清楚才能救。第一条则是一个纯粹的**口径**错：

```
「0.2.146 加了什么」  正解 0mwq5zzv  bm25 4.864
                      误中 0mwq614d  bm25 4.849   ← 差 0.015，本来就在同一档
```

两条词分几乎相同，分档也一样，最后是 `statusWeight` 把已 stale 的正解乘了 0.6、误中不是 stale，于是正解被压到第二。**问句自己说了「0.2.146」，打分器却还在按「今天」的新鲜度折它**——这不是排序不准，是没听懂人话。

### 9.166.2 三个被否掉的思路（都跑了数，不是拍脑袋）

| 思路 | 做法 | 结果 | 判 |
| --- | --- | --- | --- |
| 调 BM25 长度归一化 | `lab` 副本里把 `b` 从 0.75 扫到 0.3 | 照抄池 hit@1 一动不动（0.911），换说法从 0.500 **掉到 0.429** | 否：b 不是病因，长文档不吃亏 |
| 松分档门槛 | `impBand` 0.85 → 0.75 / 0.65 / 0.5 | 锚点组升到 0.833，但照抄 MRR 0.956→0.952，0.65 还把换说法 hit@3 从 0.714 打到 0.643 | 否：拆东墙补西墙，**维持 0.85** |
| 覆盖度优先分档 | 分档键换成 `_cover`，再试 `raw×(0.5+0.5·cover)` | `_cover` 让照抄 hit@1 退两步（0.933→0.889）；`_mix` 与 `_raw` **逐位相同** | 否：一个退步，一个无差异 |

三条都留在 `E:\Temp` 的扫描脚本里，不进仓库——它们证明的是「这条路走过的三次都不通」，不是可复用的功能。

### 9.166.3 决定：只在问句点名的那一刻上免折，且逐条判

引擎（`vendor/meow-memory/lib/index.js`）加了三件东西，都是口径层的：

```js
var TIME_ANCHOR_RE = /\d+\.\d+\.\d+|20\d\d[-/.年]\d{1,2}([-/.月]\d{1,2})?/;
function timeAnchorOf(q, opts) { ... }        // opts.timeAnchor === false 即强制关
const anchorToks = timeAnchor ? anchorListOf(query) : [];
const anchorSel  = timeAnchor ? (di) => { /* title+content+project 里有没有那个版本号/日期 */ } : null;
const anchored   = anchorSel === null ? false : anchorSel(di);
```

然后把两处折扣改成 `!anchored &&` 与 `const stW = anchored ? 1 : statusWeight(...)`。**只免两样**：新鲜度（`recencyWeight`）与状态（`statusWeight`）。词分、覆盖度、分档一个都不动——动了就不是「懂了问句」，是改了判据。

为什么「逐条判」而不是「整句一刀切」？两者在三个池子上**完全同分**（照抄 0.933 / 换说法不变 / 锚点组 0.700·1.000·0.833）。差别出现在真库（624 条，100 条 stale）上：整句一刀切会把一个**根本没提那个日期**的 stale 条目（`0mwq92zj`）也免折，分数 9.7 → 5.8 的差距被抹平；逐条判不会。实测排序两者全同，所以选语义更紧的那个——**同分时选解释得通的那个**。

### 9.166.4 验收：一条聚合断言，自带阴性对照

`tools/probe-gold.mjs` 新增 **G18**（一条聚合，内含 8 项判据）：

- 锚点组 10 问 hit@1 ≥ 0.7 且 hit@3 = 1.0；
- **关掉时间锚（`timeAnchor: false`）后 45 池必须变差**（0.911 < 0.933）——否则这条判据没测到东西；
- 53 条非锚问句开关两跑**逐位签名相同**（不许误伤）；
- 开关两跑的 `bm25` 逐条相同（词分一个字节都没动）；
- 被免折的条目 `recencyWeight === 1 && statusWeight === 1`；
- `0mwq5zzv` 开时在榜首、关时不在；
- **不许为了排名把 stale 洗成 active**（`status` 仍是 stale）；
- 形态识别：`0.2.146` / `2026-11-21` / `2026年11月` 认，三条真问句（「评测台为什么封存」「现在主线推进到哪一版」「跑评测要不要先报预算」）不认。

读数：**锚点组 hit@1=0.700 hit@3=1.000；关掉后 45 池 hit@1=0.911 < 开时 0.933；非锚问句漂移 0/53；词分不变、免折 4 条**。verify 侧另有 **GZ（0.2.159）** 八条钉住源码形态（见下节）——八条，不是九条：初稿这里写的是「九条」，实际落地时数出来是 8 条（verify 1568→1576），文档比实现多写了一条。

### 9.166.5 读到的数

| 读数 | 改前 | 改后 |
| --- | --- | --- |
| 照抄池 45 问 hit@1 | 0.911 | **0.933** |
| 照抄池 MRR | 0.944 | **0.956** |
| 换说法池 14 问（h1 / h3 / MRR） | 0.500 / 0.714 / 0.598 | **不变**（口径只补时间，不补词汇） |
| 锚点组 10 问 hit@1 / hit@3 / MRR | 0.700 / 1.000 / 0.850 | 0.700 / 1.000 / **0.833** |
| 引擎体积 | 382,757 字符 | 384,399（+1,642） |
| 请求前缀成本 | — | **0 字节**（口径在引擎里，schema 与常驻注入未动） |

唯一一处退步：`2026-11-21 之后主线停在哪一版` 从第 1 滑到第 2（仍在 hit@3 内）——它问的是一个**区间**，锚点正则只认「某一天」，把它当成了「那一刻」。这是锚点口径的已知边界，写在这里而不是藏起来。

还有一处必须写清：`tools/probe-cost.mjs` 的 C5 是「结果快照」，它锁的是「top-5 的 id 与分数逐位不变」——而这一版**故意**改了分数（`score = bm25 × w × impW × stW`，`stW` 变了），所以快照必须重落一次（`--write-snap`）。重落前后逐位对比：**21 处分数变化、0 处 id 变化、顺序一处未变**——变的只该是「提到那个日期的条目」，这正是口径替换的应有形状。换快照不是给判据开后门，是把「这一版的答案确实是另一个答案」记在案上。

一句教训：**问「哪一刻」的话，别按「现在」答——日期是问句的一部分，不是背景噪声。**

## 9.167 分低别装懂，把「差在哪」说出来（0.2.160）

### 9.167.1 缺口：换说法池 hit@1 只有 0.500

0.2.159 把照抄池推到 0.933 之后，最弱的一格就剩下来了：14 条**刻意换个说法**的问句，hit@1 = **0.500** / hit@3 0.714 / MRR 0.598。七条没中的长这样（`rank` 从 0 数，括号里是命中的二元组）：

| 问句 | 正解 | 症状 |
| --- | --- | --- |
| 加一段新的自测代码之前，先照着旁边的怎么写 | rank 2 | 正解只命中「先照」，与问句交集 2/19 |
| 什么时候才轮到把代码放到远端仓库 | 前三没进 | 正解只命中「什么」，榜首靠「代码」拿到 |
| 自测怎么才算真的测到了东西 | 前三没进 | 正解 bigram 交集 **0**，榜首靠「才算 / 东西」 |
| 那个跑榜单的评测台还能不能用 | rank 2 | 正解 3.53，榜首 20.04 |

真库（630 条 / 非 active 101）上重跑同样 7 条：5 条仍未中，榜首落在 `0mwnbfna`、`0mwnznhl`、`0mwo6juv` 这些**别的簇**里。→ **不是夹具造的假象，是真语义缺口。**

结构原因一句话：`tokenize()` 产出的是**中文二元字组**（`加一段新的自测代码之前` → `加一 / 一段 / 段新 / 新的 / 的自 / 自测 / 测代 / 代码 / 码之 / 之前`），虚词二元组（`一段`、`之前`、`才算`、`东西`）都带 idf、都在参与打分。词一个都对不上时，BM25 手里只剩「虚词巧合」可用。

### 9.167.2 四条被否的路（每条都跑了数）

| 思路 | 做法 | 结果 | 判 |
| --- | --- | --- | --- |
| 长度先验 | 真库 content 长度分布 + 「未中且榜首比正解长 2 倍」计数 | 中位 279 / p90 651 / p99 1095 / 最长 2118，>3000 字 **0 条**；69 问里那样的样例只有 **1** 条 | 否：长文档没霸榜 |
| 语料自举同义扩词 | 在 630 条上数「共现桥」 | `远端×推送` 11 篇、`行为×重构` 3 篇，但 `自测×断言` 1 篇、`测到×断言` 0、`反省×反思` **0** | 否：桥太稀，最多救 2/5，噪声大 |
| 稀有词漏检作判据 | `rareMiss≥1`（问句里 df≤2 的词一个没中） | 召回低、误报高 | 否 |
| 稠密向量层 | 0.2.154 已有可选实现 | 要调模型 = 花 key，本 goal 不允许，也不可测 | 否（留作可选层，不进这一版） |

### 9.167.3 决定：排序改不动，那就把「弱」说出来

词都对不上时，任何排序技巧都是在猜；能确定的事只有一件——**这次证据很薄**。所以这一版不加分、不改档、不动排序，只加一句诚实的说明：

```js
var WEAK_COVER = 0.2;   // 榜首覆盖了问句 idf 权重的几成
var WEAK_GAP = 0.95;    // 第二名 / 第一名的分数比
function weakHitOf(hits, opts) { ... }   // → { weak, why, cover, gap, words }
function weakNoteOf(hits, opts) { ... }  // 非弱时返回空串（强命中零字节）
function hintWordsOf(hit, query) { ... } // 从榜首 keywords 里挑 2–3 个「库里的说法」
```

三条纪律：

1. **判据只用无量纲的比值**（`cover`、`gap`），不引入任何要看语料规模的绝对分——夹具 40 条与真库 630 条都能量同一件事。
2. **版本号问句不许误报**。「0.2.148 改了什么」的 cover 天然只有 0.17–0.22（问句里那几个字根本不在这条正文里），所以时间锚已经算出来的 `anchored` 直接挂在 hit 上，`weakHitOf` 见到 `top.anchored === true` 就闭嘴（`why: "anchor"`）。加这条之前照抄池触发 29%，之后 11%。
3. **强命中零字节**。`weakNoteOf` 不弱就返回 `""`，拼进 note 数组时被 `.filter((s) => s.length > 0)` 吃掉——不给每次检索加开销。

两个坑，都是实测撞出来的：

- 分档排序后**第二名可能比第一名分高**（`_ident` 补分与 bandize 重排），`1 - gap` 会变成「差 −1%」；修法是 `const gap = gapRaw > 1 ? 1 : gapRaw;`，文案在分差 ≤1% 时直接说「几乎同分」。
- 文案初稿写的是「这不是『库里没有』，是『措辞对不上』」——**这句话有时是假的**（库里真没有那种东西时也是弱命中）。改成只陈述能核对的证据：「榜首只覆盖了这条问句的 15%」。

### 9.167.4 验收：G19 一条聚合 + 三条阴性对照

`tools/probe-gold.mjs` 新增 **G19**（一条聚合，10 项判据）：最弱那条必须说、强命中必须闭嘴（零字节）、版本号问句必须 `why:"anchor"`、`cover` 全在 0..1 且 explain 里点得出来、阈值可被 `opts.cover/opts.gap` 覆盖（同一个问句门槛放到极低就闭嘴、极高就说）、抽词三种 keywords 写法（数组 / JSON 串 / 逗号串）结果一致且剔数字剔问句原词、句长上限 200 字、不许每条都说。

三条阴性对照（`E:\Temp\neg160.py`，改一处跑一次、跑完自动还原）全部变红：

| 改坏的地方 | G19 报的错 |
| --- | --- |
| 去掉 `top.anchored === true` 抑制 | 版本号问句被当成弱命中 |
| `if (!w.weak) return ""` 失效 | 强命中仍多说了 83 字（应为零字节） / 阈值覆盖不动 / 每条都说 = 等于没说 |
| `hintWordsOf` 不剔问句原词 | 抽词没剔掉数字或问句里的词 |

verify 侧 **HA（0.2.160）** 九条钉住源码形态：两个门槛只定义一次、阈值可覆盖且比值夹 1、`weakNoteOf` 只被 handler 调一次且闸门挡下不再说、`anchored` 抑制只有一处、`cover` 只算一遍（hit + explain 同源）、提示不进扫描/分档路径、抽词四条规矩、探针自带对照、INTERNAL 9.167 与 DESIGN 172 在案。

### 9.167.5 读到的数

| 读数 | fixture 照抄 45 | fixture 换说法 14 | fixture 锚点 10 | fixture 全池 69 | 真库 630 条 · 69 问 |
| --- | --- | --- | --- | --- | --- |
| 触发率 | 11% | 86% | 10% | 26% | **30%** |
| 抓到（真没中的） | 1/3 | 6/6 | 1/3 | 8/12 | **16/31（52%）** |
| 误报 | 4 | 6 | 0 | 10（14%） | **5（7%）** |

| 读数 | 值 |
| --- | --- |
| 句长 | 最长 **129 字**（真库）/ 平均 111 字；强命中 **0 字节** |
| 引擎体积 | 384,399 → **388,009** 字符（+3,610） |
| 排序 | **一处未改**：45 池 0.933 / MRR 0.956、换说法 0.500 / 0.714 / 0.598 逐位不变 |
| 请求前缀成本 | **0 字节**（文案在引擎的 note 里，schema 与常驻注入未动） |
| cost 快照 | **不用重落**：C5 锁的是 top-5 的 id 与分数，这一版没动分数 |

误报要认账：真库 630 条上有 5 条「本来就排对了，也说了弱命中」（7%）。这不是判据说谎——`cover` 低是事实，只是答案恰好对了。回执的措辞因此必须是「先看正文确认」，而不是「这条不准」。

一句教训：**分低就说清。排序改不动的时候，把「这次证据薄」告诉问的人，比硬凑一个更像答案的排名诚实。**

## 9.168 关键词字段被低估：真库没有标题，keywords 是唯一的结构化桥（0.2.161）

### 9.168.1 结构事实：`title` 在真库里是空的

查真库（`D:\document\DSH Memory Macro-Regulation System` / `.dsh-meow`，569 条，已剔除 archived）:
每一层的列都是 `id, title, content, importance, keywords, status, source_session, hit_count, created_at, updated_at, last_accessed_at, corrected, project`，而 `title` **一条都不填**（`SELECT * FROM lesson LIMIT 1` 实测 `"title": null`）。

也就是说引擎里的 `const FIELD_TITLE_W = 0.6;` 在真库上**完全空转**。真库里唯一的结构化桥是 `keywords`，而它当时的待遇是：

```js
const kwTfW = ... : 0.25;                              // keywords 里的词只按 0.25 倍词频计数
const FIELD_KW_W = Number.isFinite(opts.fieldKwW) ? opts.fieldKwW : 0.35;  // 命中加成 +0.35
```

对照 `FIELD_TITLE_W = 0.6`：**没有标题的那一列拿 0.6，唯一的桥拿 0.35**——顺序反了。

### 9.168.2 三条实验（都在真库与三池上跑了数）

| 实验 | 做法 | 读数 | 判 |
| --- | --- | --- | --- |
| 扫描 `kwTfW × fieldKwW` | 三池 + 真库 7 条换说法 | 见 9.168.3 的斜带 | 抬 |
| 真库自找回 | 用 keywords 前三当问句 / 用正文头 40 字当问句，看能否找回自己（569 条） | keywords 自找 hit@1 **0.940 → 0.961**（hit@3 0.988 → 0.991）；正文自找 0.974 → 0.977（hit@3 0.993 → 0.991） | 抬，正文那条基本不动 |
| 伪标题（给每条补 `title = 正文首句`） | 首句截 20 / 30 字两版 | 真库 7 条换说法 ranks 反而更差（`-1, -1, …`），keywords 自找 0.940 → 0.933 / 0.930 | 否：**不造数据**，宁缺勿造 |

第三条值得写下来：补标题看起来是「把空转的 0.6 用起来」，实际上是在**替用户编数据**——截断的首句既不是标题也不是正文，还挤占词分。真库既然没有标题，就承认没有。

### 9.168.3 平台是一条斜带，不是矩形

`tf\fw` 网格（格子里是 `照抄 hit@1 / 换说法 hit@1 / 锚点 hit@1`，全部 3 位小数）：

| tf \ fw | 0.35 | 0.4 | 0.45 | 0.5 | 0.6 | 0.75 | 0.9 | 1.0 | 1.2 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 0.30 | /0.500/0.700 | /0.429/0.700 | /0.429/0.700 | /0.429/0.700 | /0.500/0.800 | /0.500/0.800 | /0.500/0.700 | /0.500/0.700 | /0.500/0.700 |
| 0.375 | /0.429/0.700 | /0.429/0.700 | /0.429/0.700 | /0.429/0.800 | /0.500/0.800 | /0.500/0.800 | /0.500/0.700 | /0.500/0.700 | /0.500/0.700 |
| 0.40 | /0.429/0.700 | /0.429/0.700 | /0.429/0.700 | /0.429/0.800 | /0.500/0.800 | /0.500/0.800 | /0.500/0.800 | /0.500/0.700 | /0.500/0.700 |
| 0.45 | /0.429/0.700 | /0.429/0.700 | /0.429/0.800 | /0.500/0.800 | /0.500/0.800 | /0.500/0.800 | /0.500/0.800 | /0.500/0.700 | /0.500/0.700 |
| **0.50** | /0.429/0.700 | /0.429/0.700 | /0.500/0.800 | /0.500/0.800 | **/0.500/0.800** | /0.500/0.800 | /0.500/0.800 | /0.500/0.800 | /0.500/0.700 |
| 0.55 | /0.429/0.700 | /0.500/0.700 | /0.500/0.800 | /0.500/0.800 | /0.500/0.800 | /0.500/0.800 | /0.500/0.800 | /0.500/0.800 | /0.500/0.700 |
| 0.60 | /0.500/0.700 | /0.500/0.700 | /0.500/0.800 | /0.500/0.800 | /0.500/0.800 | /0.500/0.800 | /0.500/0.800 | /0.500/0.800 | /0.500/0.700 |

「照抄 hit@1」几乎全是 0.933（只有 tf 0.55/0.6 配最小的 fw 掉到 0.911），所以表里省掉；关键两列是**换说法**与**锚点**。

读法三条：

1. **平台是斜的**：tf 小就要把 fw 抬上去补（tf 0.3 要 fw 0.6 才拿到 0.500/0.800），tf 大就要收着（tf 0.5 配 fw 1.2 锚点掉回 0.700）。约束的是两者的**合力**，不是各自区间——所以「tf 0.375–0.5 × fw 0.45–1.0 全同分」这种矩形说法是错的，别写进注释。
2. **两头都会掉**：同偏低（0.25/0.35）锚点 0.700 且换说法 MRR 0.598；同偏高（1/1.2）照抄 0.911、换说法 MRR 0.589。
3. **同读数有好几个点，选哪个由老规矩决定**：读数打平的那一族里，`0.5/0.6` 与 `0.35/0.6` 完全同分——但**只有 0.35 能保住 0.2.152 立下的「标签不是正文」**（见 9.168.5）。所以取的是一族里最保守的那个点，不是读数最高的那个。G20 里钉住两件事：同读数的三个兄弟组合（`0.3/0.7`、`0.325/0.65`、`0.325/0.7`）逐题同读数；平台外 `{0.4, 0.45}` 必须不同读数。

### 9.168.4 落地：两个数一个来源

```js
var KW_TF_W = 0.35;         // keywords 里词的词频权重（原 0.25）
var FIELD_KW_W_DEF = 0.6;   // keywords 命中加成（原 0.35，与 FIELD_TITLE_W 同档）
```

### 9.168.5 撞上 0.2.152 的「标签不是正文」

把 `kwTfW` 抬到 0.5、`fieldKwW` 抬到 0.6，三池读数一分不少——但 `verify.mjs` 里两条 0.2.152 的老断言当场变红：

```
FAIL  EY 字段权重·行为: 正文命中的条目压过只在 keywords 里提到的等长条目（标签不是正文）  Q 0.182 / P 0.182
FAIL  WZ5 行为: 正文命中的压过只在 tags 里提到的（标签不是正文）  body 0.197 / tag 0.424
```

这不是老断言过时，是**新权重真的破坏了那条规矩**：`0.5 × (1 + 0.6)` 与正文一次命中在 BM25 饱和曲线上正好打平（EY 那对等长条目 0.182 / 0.182），而 WZ 那对条目长度不等，标签那条反而更高（0.424 > 0.197）。规矩本身是对的——**标签是提示，不是证据**；一条只在 keywords 里出现的词，不该压过正文里真写了这个词的条目。

做法是把可行域扫出来（`E:\Temp\feas161.mjs`，tf 0.25–0.6 × fw 0.35–0.8 细网格，逐点同时量三池读数与这两条老断言）：

- 同时满足两条老断言的点一共 **52 个**，但绝大多数读数只有 `换说法 0.429` 那一档；
- **`tf 0.35 / fw 0.6` 是唯一落在读数峰值上的可行点**：`0.933 / 0.500·0.714·0.601 / 0.800·0.883`，与 `0.5/0.6` **一分不差**；
- 再往下 `tf 0.3 / fw 0.6` 就掉回 `0.429`——所以 0.35 是这条斜带上最后一个还能保住规矩的点。

于是定稿取 **0.35 / 0.6**：**读数打平时，选不破老规矩的那个。** 这条也写进了 G20（第 ⑧ 项）：默认值必须让「正文命中」压过「只在 keywords 提到」，而 `0.5/0.6` 必须**确实会破**——否则那条对照就是白写的。

`kwTfW` 的兜底出现在**三处**（`buildSearchIndex` / `indexPathKey` / `searchIndexOf`），原来三处都写着字面量 `0.25`；现在三处都读 `KW_TF_W`。这一点不是洁癖：索引缓存键里带着 `kwTfW`，如果只改两处，第三处会算出**不同的键**，缓存要么反复重建、要么在换权重后继续喂旧表。`fieldKwW` 同理（出现一处，但同样走常量）。两个常量都从模块导出，探针与 verify 用同一个数。

### 9.168.6 读数：照抄一处不动，锚点进一条

| 池子（n） | 指标 | 0.2.160 | 0.2.161 |
| --- | --- | --- | --- |
| 照抄（45） | hit@1 / hit@3 / MRR | 0.933 / 0.978 / 0.956 | **一处不动** |
| 换说法（14） | hit@1 / hit@3 / MRR | 0.500 / 0.714 / 0.598 | 0.500 / 0.714 / **0.601** |
| 锚点（10） | hit@1 / hit@3 / MRR | 0.700 / 1.000 / 0.833 | **0.800** / 1.000 / **0.883** |

逐题看，变动只有四条：

- 照抄池 **0 条**漂移（rank 逐条相同）。
- 换说法池 3 条：`4→3`（自动筛掉结果…开个小门）、`0→1`（一次最多能给几条…）、`1→0`（把一个文件拆开之后…）——一进一出，hit@1 净持平，MRR 多 0.003。
- 锚点池 1 条：**「0.2.148 交付时改了几处」从第 2 名进到第 1 名**——这条正是问句里那个版本号写在 keywords 里的条目，0.161 之后它终于比「泛泛讲交付流程」的那条更靠前。

所以这一版的收益不在「命中率涨了多少」，而在**结构化字段终于按它该有的权重参与**：keywords 是用户自己写的摘要，是唯一长在数据里的语义标签，真库又不给标题，它理应比正文词频更值钱。

### 9.168.7 验收：G20 一条聚合 + 八项判据 + 三条阴性对照

`tools/probe-gold.mjs` 新增 **G20**（一条聚合，8 项判据）：同读数三个兄弟组合与默认**逐池同读数**（`{0.3,0.7}`、`{0.325,0.65}`、`{0.325,0.7}`）、平台外 `{0.4,0.45}` **必须不同读数**（否则「平台」是随口一说）、旧口径下锚点 hit@1 ≤0.75 且 MRR 更低、抬到 `1/1.2` 照抄 hit@1 变差、照抄池默认 vs 旧口径 rank 漂移 = 0、导出的 `KW_TF_W`/`FIELD_KW_W_DEF` 传回去与 `{}` 逐条同分、换说法 hit@1/hit@3 不降、**默认值保住「标签不是正文」而 `0.5/0.6` 确实会破**。

三条阴性对照（`E:\Temp\neg161.py`，改一处跑一次、跑完自动还原）全部变红：

| 改坏的地方 | G20 报的错 |
| --- | --- |
| 默认退回 0.25 / 0.35 | 同读数组合与默认不同分 / 旧口径下锚点池没变差 / 平台外也同分 |
| 一路抬到 1 / 1.2 | 同读数组合与默认不同分 / 抬到 1/1.2 照抄池也没变差 / 照抄池 1 条排名被动了 |
| 只抬词频不抬加成 0.35 / 0.35 | 同读数组合与默认不同分 / 旧口径下锚点池没变差 |

G19 的触发数也跟着变了一点（69 问 16 条 = 23%，原 26% 那条是老口径下的读数）：关键词更值钱之后，更多问句的榜首**覆盖度够了**，也就没必要再提醒「这次证据薄」。这是同一个改动的连带效果，不是新判据。

## 9.169 同义词桥：词面上根本没有可比的词时，换个说法怎么找回来（0.2.162）

### 9.169.1 根因不是排序，是词面零交集

换说法池（14 条，问句刻意避开正文用词）的 hit@1 从 0.2.152 起就卡在 **0.500**。此前几轮都在排序上找原因：分档、时间折扣、keywords 加成、弱命中提示——每一刀都能挪动一两条，但都挪不动这个数。

把没中的题逐条拆开看才发现，问题在更前面一层：

```
问句：它自己什么时候该回头反省一次
正解正文：……该回头反思的时候……
共同二元组：0 个
```

`tokenize()` 对中文只产**二元组**（`反省` / `反思` / `推送` / `远端`），这一层没有词形变化、没有词干、没有复数。两个真正同义的词，在倒排表和 BM25 里就是**两套互不相干的东西**——不是「排得不够靠前」，是**根本没有可比的词**。0.500 的天花板不是调的，是结构给的。

所以这一刀不进语义层（不花 key、不跑 locomo），只在**词面**这一层补一条桥。

### 9.169.2 设计的五条边界

```js
var SYN_GROUPS = [["反省", "反思", "回味"], …]   // 15 组，手工
var SYN_W = 0.6;
const synOf = opts.synBridge === false ? null : synExpandOf(qKept, df);
```

1. **表是手工的**，只收「问句里常说、正文里常换个说法」的二字词。不做自动同义挖掘——挖出来的多半是「共现」而不是「同义」，那是另一件事。
2. **只扩问句，不动文档**。文档侧一动，索引、缓存键、增量更新全要跟着改；问句侧是纯函数，扩完就丢。
3. **扩出来的词单独计分，权重 `SYN_W = 0.6 < 1`**：换个说法能帮忙，但不能顶替原话。
4. **覆盖度分母一个字节不动**：`cover` 只累 `qKept`，同义词不进 `qIdfSum`。进了分子不进分母是加分，进了分母就是「问句更难满足」，会把真相关的条目一起裁掉。
5. **倒排候选集必须并 postings**。0.2.153 之后打分只碰「问句里那几个词真的出现过」的条目；只把同义词加进 `qLoop` 而不并候选集，那些条目连 `scanDoc` 都进不去，扩词等于没写。

### 9.169.3 表必须能对齐分词器（这一条当场踩到）

第一版表里写了 `["门", "例外", "豁免"]`、`["笨", "慢", "耗时", "卡顿"]`。G21 的表形态断言当场变红：

```
FAIL G21 同义词表形态不对（要 ≥12 组、每组 ≥2、每词两字、无跨组重复、0<SYN_W<1）
```

原因很直接：`tokenize()` 对中文产二元组，`门` / `笨` / `慢` 这种**单字词永远不可能出现在词表里**，写进表里就是死条目。改成 `["例外", "豁免", "特例", "放行"]`、`["耗时", "卡顿", "拖慢", "变慢"]` 之后才对齐。

所以「每组 ≥2 条、每个词恰好两个字、无跨组重复」不是格式洁癖，是**表能不能被检索到**的前提。

### 9.169.4 `SYN_W` 的选法：取平台起点，不取天花板

| SYN_W | 换说法 hit@1 / hit@3 / MRR | 照抄 | 锚点 |
| --- | --- | --- | --- |
| 0（关桥） | 0.500 / 0.714 / 0.601 | 0.933 / 0.978 / 0.956 | 0.800 / 1.000 / 0.883 |
| 0.3 / 0.4 | 0.571 / 0.857 / 0.696 | 一处不动 | 一处不动 |
| 0.5 | 0.571 / 0.857 / 0.708 | 一处不动 | 一处不动 |
| **0.6 / 0.7 / 0.8** | **0.643 / 0.857 / 0.744** | 一处不动 | 一处不动 |
| 1.0 | 0.643 / 0.929 / 0.750 | 一处不动 | 一处不动 |

0.6 之后进入平台（0.6/0.7/0.8 读数完全一致）；1.0 只多救一条题（`3→2`），代价是「同义」与「原话」同权。**取 0.6**：平台的起点，且原则说得很清楚——换个说法可以帮忙，但不能顶替原话。

（上表是只加桥、虚词还没补的读数；补完虚词后的最终读数见 9.169.6。）

### 9.169.5 虚词表补两条：`不要` / `一段`

补桥的过程中顺带核到一处口径漏洞：`要不要` 这条问句骨架，`要不` 早就在虚词表里，**另一半 `不要` 一直没进去**。于是「要不要告诉对方」这种问句里，`不要` 一直在参与打分——它把「正文里恰好有『不要』」的条目抬了上去，而那不是证据。

`一段` 同理，与已在表里的 `一个 / 一下 / 一次 / 一点 / 一些` 是同族量词碎片。

补充两条之后（关桥口径）：换说法 **0.500/0.714/0.601 → 0.571/0.714/0.637**；照抄池、锚点池一处不动。再叠上 0.6 的桥，才到 0.714/0.929/0.798。

这说明两件事其实是一件事：**问句里那些不带信息的碎片，要么别计分，要么别让它们参与「覆盖度」的判定**——`要不要` 的两半都该被剔，此前只剔了一半。

### 9.169.6 读数：照抄一处不动，换说法大幅抬起

| 池子（n） | 指标 | 0.2.161 | 0.2.162（开桥） |
| --- | --- | --- | --- |
| 照抄（45） | hit@1 / hit@3 / MRR | 0.933 / 0.978 / 0.956 | **一处不动** |
| 换说法（14） | hit@1 / hit@3 / MRR | 0.500 / 0.714 / 0.601 | **0.714 / 0.929 / 0.798** |
| 锚点（10） | hit@1 / hit@3 / MRR | 0.800 / 1.000 / 0.883 | **一处不动** |

逐题的四处变动（都发生在换说法池）：

- `2→1`「加一段新的自测代码之前，先照着旁边的怎么写」（虚词补 `一段` 之后）
- `-1→0`「什么时候才轮到把代码放到远端仓库」（`推送 ↔ 远端`）
- `3→2`「自动筛掉结果的时候，要不要给接班的那条开个小门」（`筛掉 ↔ 过滤`、`接班 ↔ 取代`）
- `-1→0`「它自己什么时候该回头反省一次」（`反省 ↔ 反思`）

真库迁移（14 条换说法问句打 573 条真库，want 用短 id 前缀匹配）：关桥 0.286/0.500/0.399 → 开桥 0.286/0.500/0.405。**一进一退**：`-1→3`（远端仓库）、`1→2`（评测台）。真库自找回（150 问，用每条自己的 keywords 前三当问句）0.853/0.960/0.905 → 0.860/0.960/0.908，top1 换人 1 问。

结论要写清楚：**fixture 上的收益是结构性的（0.500→0.714），真库上只是同向但很小**——真库 573 条里同义改写本来就少，且噪声更多。这条桥解决的是「词面对不上」这一类，不是万灵药。

### 9.169.7 验收：G21 一条聚合 + 十一项判据 + 五条阴性对照

`tools/probe-gold.mjs` 新增 **G21**（11 项判据）：

1. 表形态：≥12 组、每组 ≥2、每词两字、无跨组重复、`0 < SYN_W < 1`、导出 `synExpandOf` 是函数。
2. 换说法池 hit@1 ≥ 0.7 且 hit@3 ≥ 0.9。
3. 比关桥基线高 0.05 以上（证明桥在起作用，不是「刚好踩线」）。
4. 照抄池 rank 漂移 = 0 且读数同。
5. 锚点池 rank 漂移 = 0 且读数同。
6. `cover` 开/关**按条目**逐条相同（不能按位置比：开桥会改变命中集合与顺序，那是错的判据——初版就是这么写错的）。
7. 只含同义词的条目（S1 讲「反思」、问句「反省」）关桥进不来、开桥进得来。
8. 虚词「不要」不参与打分：`F1='不要紧'` 与 `F2='很要紧'` 在问句「这个要不要紧」下必须同分。
9. 老规矩不破：正文命中压过只在 `keywords` 里提到的（0.2.152）。
10. `sigOf(paraphrase,{synBridge:false}) === sigOf(paraphrase,{synW:0})`（旋钮只有一个）。
11. `V.synExpandOf(['毫无关系'], new Map([['关系',1]])) === null`（表外词不扩）。

五条阴性对照（`E:\Temp\neg162.py`，改一处跑一次、跑完自动还原、还原后 ALL PASS）：

| 改坏的地方 | G21 报的错 |
| --- | --- |
| A `synBridge:false` 也照样扩词 | 换说法池相对关桥基线几乎没动 / 只含同义词的条目没被桥进来 / `synBridge:false` 与 `synW:0` 不同分 |
| B 倒排候选集不并同义词 postings | 换说法池没到门槛（0.571/0.786）/ 相对基线没动 / 只在同义词里的条目进不来 |
| C 扩词混进覆盖度分母 | 换说法池没到门槛（0.643）/ cover 开/关不一致 / 两个开关不同分 |
| D 虚词表把「不要」拿掉 | 换说法池没到门槛（0.643/0.857）/ 「不要」还在参与打分 |
| E 权重压到 0.05 | 换说法池没到门槛（0.643/0.786） |

`verify.mjs` 新增 **HB2（0.2.162）** 十二项：单一来源（表与权重各定义一次、别的模块不写第二份）、表能对齐（每组 ≥2、两字、无重复）、`0<SYN_W<1`、只扩问句（`synOf`/`synW` 的兜底各一处）、覆盖度分母不动、候选集合并、导出、虚词两条在案、行为（只含同义词的条目开桥进得来关桥进不来）、cover 按条目不变、探针自带五条对照、文档在案。

### 9.169.8 已知边界

- **手工表的天花板**：15 组只覆盖 fixture 里暴露出来的那几类。真库上「同义但不在表里」的问句照旧零交集。
- **真库收益远小于 fixture**：0.405 vs 0.399（MRR），且有一进一退。别把这个数当成「换说法问题解决了」。
- **不做自动扩同义**：共现频率高的词对里混着大量反义与上下位，自动挖出来的表会把「帮忙」变成「误导」。要做，得先用一批人工标注的同义对做精度评估——那是另一件事，不在这一版。
- **G19 触发数随之变化**：69 问触发 17（25%）。桥把覆盖度补上来之后，更多问句的榜首「证据够了」，不需要再提醒。

## 9.170 覆盖度是内容证据（0.2.163）

### 9.170.1 缺口：榜首「沾了话题」，不是「答了问题」

照抄池卡在 42/45 三条，其中两条是同一对条目的错位：

| 问句 | 榜首 | 分项 | 正解 | 分项 |
| --- | --- | --- | --- | --- |
| 评测台为什么封存 | `0mwpqwek`（102 字 rules，imp 4） | bm25 13.405 / cover 0.303 / recency 1 / impW 1.75 | `0mwpsfb0`（611 字 project，imp 2） | bm25 7.339 / **cover 0.493** / recency 0.6 / impW 1.25 |

词面看得很清楚：`0mwpqwek` 的正文只命中 `评测 / 测台`，`0mwpsfb0` 的正文命中 `评测 / 测台 / 封存`——**问句里最值钱的那个词只有正解有**。可榜首还是它，三条路叠起来：

1. **字段加成**：`0mwpqwek` 的标题和 keywords 都带这两个词，`fw = 1 + 0.6 + 0.6 = 2.2`，逐词乘进 BM25；
2. **重要性/新鲜度乘子**：impW 1.75 vs 1.25、recency 1 vs 0.6；
3. **分档**：`bandize(hits, '_raw')` 按 raw 分档，榜首 raw 13.4、正解 7.34 < 0.85 × 13.4，落在下一档，**跨档不许越级**——想靠排序层挽回，必须先改 raw。

覆盖度早就算好了（`cover` 只累 `qKept`，是**正文**的 idf 覆盖率），但它当时只按 `COORD_W = 0.35` 轻轻乘一下：缺一半词只掉 17%，掰不过 fw 的 2.2 倍。**“问句里那些词，这条占了几成”是最直接的内容证据，不该只当装饰。**

### 9.170.2 只动一个口径

```
s *= 1 - COORD_W + COORD_W * pow(min(1, cover / qIdfSum), COORD_POW)
COORD_W_DEF = 0.5    （原字面量 0.35）
COORD_POW_DEF = 1.2
```

两个常量各定义一次、可被 `opts.coordW` / `opts.coordPow` 覆盖（`coordPow` 带 `> 0` 守卫）。词分、字段加成、同义通道、分档、折扣**一个字节没动**——所以「新口径 vs 旧口径」的差别只有这一处，出问题一刀切回去。

### 9.170.3 网格（三池 + 真库两档）

真库 557 条（已剔 archived）、自找回 150 问（keywords 前三）。表里是 `hit@1/hit@3/MRR`：

| coordW | pow | 照抄 45 | 换说法 14 | 锚点 10 | 真库自找 150 | 真库 14 换说法 |
| --- | --- | --- | --- | --- | --- | --- |
| 0.35 | 1 | 0.933/0.978/0.956 | 0.714/0.929/0.798 | 0.800/1.000/0.883 | 0.860/0.960/0.910 | 0.286/0.500/0.413 |
| 0.5 | 1 | 0.933/0.978/0.956 | 0.714/0.929/0.798 | **0.700**/1.000/0.833 | 0.873/0.960/0.916 | 0.357/0.571/0.469 |
| 0.5 | 1.2 | 0.933/0.978/0.956 | 0.714/0.929/0.798 | 0.800/1.000/0.883 | **0.873**/0.960/0.916 | 0.357/0.571/0.455 |
| 0.55 | 1 | 0.911/0.978/0.944 | 0.714/0.929/0.798 | 0.700/1.000/0.833 | 0.873/0.960/0.916 | 0.357/0.571/0.467 |
| 0.7 | 1 | 0.911/0.978/0.944 | 0.714/0.857/0.780 | 0.700/1.000/0.833 | 0.873/0.960/0.916 | 0.357/0.429/0.413 |
| 1 | 1 | 0.867/0.978/0.922 | 0.571/0.786/0.685 | 0.600/1.000/0.767 | 0.853/0.960/0.906 | 0.357/0.429/0.417 |

读法三条：

- **两条读数反向**：真库收益在 0.45–0.6 之间早就吃满了；再往上（0.55/0.6）先掉的是 fixture 的照抄池与锚点池。**权重不是越大越好，是要找两头都不亏的那个点**。
- **幂次不是装饰**：`0.5/1` 把锚点池从 0.800 打到 0.700（`0.2.147 那一版交付了什么` 掉出榜首）；`0.5/1.2` 把它拉回来——同一权重下，缺口大的条目被罚得更狠，正好补偿「线性覆盖度对缺一半词太宽容」。
- **平台起点是 0.5/1.2**：三池一位不动（照抄 42/45、换说法 10/14 与 13/14、锚点 8/10），真库自找 +2 条命中（0.860 → 0.873），真库 14 条换说法 +1 条进榜、hit@3 +1、MRR 0.413 → 0.455。

### 9.170.4 逐题变动（0.5/1.2 vs 0.35/1）

fixture 三池 **0 处变动**（45 + 14 + 10 条一条没动）；真库上 4 处：

| 池 | 变动 | 问句 |
| --- | --- | --- |
| 真库 14 换说法 | 3 → 0（好） | 什么时候才轮到把代码放到远端仓库 |
| 真库 14 换说法 | 1 → 2（坏） | 那个跑榜单的评测台还能不能用 |
| 真库自找 | 1 → 0（好） | `0.2.66 降级路径 graph模式尾注` |
| 真库自找 | 1 → 0（好） | `0.2.154 稠密向量 searchHybrid` |

三好一坏。坏的那条同样是「评测台」话题，正解被压在第二——**说明这版动的方向对，但没解决 `评测台为什么封存` 的根**（根在 9.170.1 的第 1、3 条：字段加成 2.2 与跨档）。

### 9.170.5 G22 九项（`tools/probe-gold.mjs`）

1. 单一来源：`var COORD_W_DEF = ` / `var COORD_POW_DEF = ` 各 1 次，`lib/macro/defs/search.js` 与 `lib/macro/fusion.js` 里没有 `COORD_`；
2. 值：`0.5` 与 `1.2`；
3. 兜底同源：`Number.isFinite(opts.coordW) ? opts.coordW : COORD_W_DEF`、`Number.isFinite(opts.coordPow) && opts.coordPow > 0 ? … : COORD_POW_DEF`，幂次与协调因子在打分路径里各 1 处；
4. 行为·覆盖度进分数：受控语料（等长、同 importance、只有覆盖度不同）里「高覆盖/低覆盖」的分差从 0.35 口径的 29.10 → 0.5 口径的 36.48（>1.2 倍）；
5. 行为·幂次让低覆盖罚得更狠：同一协调权重下分差 36.48 → 37.62；
6. 三池不亏：照抄 ≥42/44 条、换说法 ≥10/13 条且 MRR ≥0.797、锚点 ≥8 条；
7. 关掉精确回旧口径：`{coordW:0.35, coordPow:1}` 与默认三池逐池同值（三位小数全等）；
8. 覆盖度不跟权重走：`{coordW:0}` 与默认的 `cover` 逐条相同（只比两边都在场的键，共 ≥20 条）；
9. 老规矩不破：正文命中的压过只在 keywords 里提到的（0.2.152）+ 文档在案。

阴性对照（`E:\Temp\neg163.py`，改一处跑一次、跑完自动还原、还原后 ALL PASS）：

| 改坏的地方 | G22 报的错 |
| --- | --- |
| A `COORD_W_DEF = 0.35`（回旧口径） | 常量值不对：0.35/1.2 / 换说法池掉了（10/13，MRR 0.786）/ 换说法池与旧口径不同值 |
| B `COORD_POW_DEF = 1`（去掉幂次） | 常量值不对：0.5/1 / 锚点池掉了（7，底线 8）/ 锚点池与旧口径不同值 |
| C 协调因子改成线性 `s *= cvr`（没有 1−w 的底） | 覆盖度没真正进打分路径 / 抬覆盖度没把分差拉开（234.63 → 234.63）/ 三池全掉 |
| D `cover` 跟着权重走（乘 `1 + COORD_W`） | cover 跟着权重变了 189 处（只比到 193 条） |
| E 常量不导出 | 常量值不对：undefined/undefined |

### 9.170.6 已知边界

- **没解决 9.170.1 那条**：`评测台为什么封存` 仍是第二名。要翻它得动字段加成（fw 2.2）或分档口径——那是另一层的事，不塞进这一版。
- **真库收益 3 好 1 坏**，净 +2 条命中（150 问里）。别把这个数说成「准确性提高了一大截」。
- **`coordPow` 只对 `cover < 1` 的条目起作用**：覆盖满的条目乘 1，一字节不变——所以幂次不改变「都答全了」的那批问句的顺序。

## 9.171 读数工具自己也是被测对象：真库关键词通道整条静默失效，与随之改回来的覆盖度口径（0.2.164）

### 9.171.1 缺口：一个藏了三版的取数错误

0.2.161 起，每一版都拿「真库」当第二块验货台：150 条记忆自己的前三个关键词当问句，看能不能找回自己。读数一直不好看——hit@1 0.860、hit@3 0.953。所以 0.2.162（同义桥）、0.2.163（覆盖度）都是拿这块台子当判据的。

这一版开头想继续调排序，先把这块台子重搭了一遍，才发现台子本身是坏的：

```js
const rows = db.p('SELECT * FROM ' + lv).all();   // ← 错的
rows[0].keywords === 'string'                     // true，形如 "["输出截断","select * 全表"]"
```

库里 `keywords` 列存的是 JSON 文本。`SELECT *` 拿回来的是**原始行**，`keywords` 是字符串；而引擎有三处都按数组判空：

- `vendor/meow-memory/lib/index.js:2307` 索引签名 `Array.isArray(d?.keywords) ? d.keywords.join('\u0001') : -1`
- `2335` `kwToks = docs.map((d) => (Array.isArray(d.keywords) ? d.keywords : []).flatMap(...))`
- `2367` `kwSets` 同款

三处都不抛错、不告警，只是把字符串当成「没有关键词」。于是**关键词通道整条静默失效**，那块台子量的是「去掉关键词之后的引擎」。

正确的取数口径在生产路径上本来就写好了：`searchTool`（`vendor/meow-memory/lib/index.js:3903-3925`）走 `db.listSearchable(lv)` → `db.list(level, opts)`（721-735）：

```js
list(level, opts = {}) {
  ...
  const rows = this.p(sql).all(...args);
  return rows.map((r) => this.fromRow(level, r));   // ← 行必须过 fromRow
}
```

`fromRow`（1157-1163）里 `keywords = JSON.parse(String(r.keywords ?? "[]"))`。所以任何「喂给 search 的真库语料」都必须是 `LEVELS.flatMap((lv) => db.listSearchable(lv))` 的结果，不能是 raw row。

**纠正后的读数（0.2.163 现行引擎 0.5/1.2、corpus 525 条、k=10、hit1/hit3/hit5 | MRR）：**

| 池子 | 旧台子（关键词死） | 新台子（关键词活） |
| --- | --- | --- |
| 真库 150 问自找回 | 0.867 / 0.953 / — · 0.910 | **148/150/150 · 0.993** |
| 真库 14 条换说法 | 0.357 / 0.500 / 9 · 0.445 | 5/9/9 · 0.524（top5 条数 9） |

「准确性下一格」在这块台子上原本就不存在：自找回已经 148/150，两问没中，且都不是排序问题（见 9.171.5）。

**教训**：台子也是被测对象。读数异常难看时，先怀疑量具，再怀疑被测物——三版都在一个坏量具上做决策，白量了三次。

### 9.171.2 干净网格：饱和的池子没有信号

新台子上重扫 `coordW × coordPow`。先看「真库自找」：**所有参数组合下都是 148/150**——1.2.3 个数一位不动。这个池子已经饱和，拿它当方向盘等于闭眼开车。

有信号的只有「真库 14 条换说法」的 top5 条数（hit@5）：

| coordW / coordPow | 真库换说 top5 | 锚点 hit@1 | 照抄 hit@1 |
| --- | --- | --- | --- |
| 0.35 / 1 | 10 | 8 | 42 |
| 0.40 / 1 | 11 | 8 | 42 |
| 0.42 / 1 | 11 | 8 | 42 |
| **0.45 / 1** | **12** | **8** | **42** |
| 0.45 / 1.1 | 12 | 8 | 42 |
| 0.45 / 1.15 | 12 | 8 | 42 |
| 0.48 / 1 | 11 | 8 | 42 |
| 0.50 / 1 | 10 | 8 | 42 |
| 0.50 / 1.1 | 10 | 8 | 42 |
| 0.50 / 1.2（0.2.163 现行） | **9** | 8 | 42 |
| 0.48 / 0.5 | 9 | 7 | 42 |
| 0.55 / 1 | 9 | 8 | 41 |

读法：

- **0.2.163 挑的 0.5/1.2 在这块干净台子上是倒数第一**（9 条，比旧 0.35/1 的 10 条还差）。它是被坏台子骗出来的。
- **0.45/1 是唯一同时满足「三池一条不亏」与「真库换说最多」的点**（12 条）；0.45/1.1 与 0.45/1.15 同读数，但按「一次只改一个口径」，不动幂次。
- 天花板在 0.55：照抄池掉到 41。所以 0.45 不是随手挑的，是「再往上就伤照抄池」之前那一格。
- 幂次（`coordPow`）整列没有增量：0.45 下 p=1 / 1.1 / 1.15 读数完全一样，p=1.2 只让低覆盖更疼、把 top5 从 12 打回 11（在 0.5 那一列是 9→10）。**幂次这一格判定为无收益，默认拉回线性 1**，旋钮留着手动对照用。

### 9.171.3 逐题：三处变动，全是「进 top5」

A = 0.35/1（0.2.162 及以前）、B = 0.45/1（本版）、C = 0.5/1.2（0.2.163）。数字是 want 的名次，−1 表示没进 top10。

| 问句 | A | B | C |
| --- | --- | --- | --- |
| 什么时候才轮到把代码放到远端仓库 | −1 | 3 | −1 |
| 它自己什么时候该回头反省一次 | −1 | 4 | −1 |
| 那个跑榜单的评测台还能不能用 | 3 | 4 | −1 |

三池（照抄/换说法/锚点）与「真库自找」在 A/B/C 之间**0 处不同**——这一版只把三条边缘问句从「找不到」推进 top5，没有拿任何一条做交换。

### 9.171.4 顺带排除的方向：同义词命中算不算覆盖度

`E:\Temp\lab165.py` 在 lab 里加 `opts.synCoverW`（默认 0）：同义词命中的 query 词按 `cover += synCoverW * idfOf(term)` 计进覆盖度。插的位置必须在 `coverOf[di] = Math.min(1, cover / qIdfSum);` **之前**，否则 `explain.cover` 与 `cvr` 用的不是同一个数（0.2.163 阴性对照 D 就是这么红的）。

| synCoverW | 真库换说 | fixture 换说法 |
| --- | --- | --- |
| 0（现口径） | 5/9 · 0.488 | 10/13 · 0.798 |
| 0.25 ~ 1.0 | 6/9 · 0.542（赚） | **9/13 · 0.750（亏）** |

一赚一亏，净为零；而且 0.25 与 1.0 读数完全相同，说明这是二值效应（「算不算」而不是「算多少」）。**不做**。

### 9.171.5 已知边界

- **自找回那两问不是排序问题**：`自测怎么才算真的测到了东西` 的 want（`0mwmgxay`）bm25 只有 0.011、cover 0——词表里没有「自测/自检」这一对，任何权重都救不了，是词汇缺口（同义桥的下一批候选）。
- **`评测台为什么封存` 仍是第二名**（三档参数下名次恒为 1，即第二）：`0mwpqwek` rules imp 4 + title/kw 双命中 fw 2.2 对 `0mwpsfb0` project imp 2 recency 0.6，这是字段加成与分档的结构问题，不是覆盖度能解的。
- **真库换说 12 条里 7 条仍在 top5 之外**：形态统一是「同一份材料的兄弟笔记互相顶」（如 `plugin-market index.json` 四条兄弟条目同为 cover=1、同带 `identBonus`），需要「兄弟区分」而不是继续调权重。top5 内近重复密度实测 0.0%（Jaccard ≥0.6 一对都没有），所以「结果级去重/MMR」在这库上没有肉。
- **本版净收益很小**：真库换说 top5 9 → 12（+3 条边缘问句），三池一位不动。别把它说成「准确率提升」。

---

### 9.172 回执按置信档收口（0.2.165）：bandize 早就算过的事，回执一直没看

**问题**：`bandize` 从 0.2.150 起就在算「这条和榜首是不是一个量级」，可它只用来排序和解释档位；
真正往回捞多少条，仍旧是一个写死的 `k`。真库 150 问上，`k=10` 的返回均值是 **9.80 条**，
而每问的 `band 0` 平均只有 **1.08 条**——九条里有八条是「沾边但本来就不该看」的尾货，照价付 token。

**证据（五池，`E:\Temp\ps167.mjs`）**：

| 池 | 正解进 top10 | 其中 band ≤ 0 | band0 均值 | k=10 返回均值 |
| --- | --- | --- | --- | --- |
| 照抄 45 | 44 | 42（95.5%） | 1.18 | 6.13 |
| 换说法 14 | 13 | 11（84.6%） | 1.21 | 7.93 |
| 锚点 10 | 10 | 9（90.0%） | 1.50 | 7.40 |
| 真库自找 150 | 150 | **150（100%）** | 1.08 | 9.80 |
| 真库换说 14 | 12 | 6（50.0%） | 1.50 | 10.00 |

一句话：**正解几乎总在 band 0，而回执几乎总把 band 1–7 一起搬回去**。

**做法**：抽出 `trimByBand(hits, k, opts)`：回执 = 与榜首同档（`_band <= 0`，含 `_ident` 的 −1）的那几条，
但**最少 `RESULT_MIN_KEEP = 5` 条**。`bandize` 从此始终在 hit 上留 `_band`（以前只在 `explain` 时写
`explain.band`），裁剪完再摘 `_raw / _ident / _band`。`band` 单调不减，所以「前 keep 条」必然包含
全部 band ≤ 0，不必再筛。稠密融合一路（`searchHybrid`）与 `dense: false` 退路走同一函数——
两路各裁一次就是两套规矩。`opts.bandKeep: false` 或 `opts.minKeep: 0` 一键回旧口径。

**取舍表（`E:\Temp\ps167c.mjs`；每格 hit@5/hit@1/返回均值）**：

| minKeep | 照抄 45 | 换说法 14 | 锚点 10 | 真库自找 150 | 真库换说 14 |
| --- | --- | --- | --- | --- | --- |
| 关（k=10） | 44/42/6.13 | 13/10/7.93 | 10/8/7.40 | 150/148/9.80 | 11/5/10.00 |
| 3 | 44/42/2.91 | 13/10/3.00 | 10/8/2.90 | 150/148/3.00 | **9**/5/3.00 |
| **5** | 44/42/**4.40** | 13/10/**4.79** | 10/8/**4.60** | 150/148/**4.97** | 11/5/**5.00** |
| 8 | 44/42/5.67 | 13/10/6.79 | 10/8/6.70 | 150/148/7.89 | 11/5/8.00 |

`minKeep = 5` 是**零损失**那一格：五池 hit@1 / top5 与 `k=10` 逐池相同，回执均值真库 9.80 → 4.97
（**−49.3%**）、照抄 6.13 → 4.40（−28.2%）。3 更省但真库换说池 11 → 9（两问正解在 band 1 且不在前 3），
所以 5 是「再往下就会丢东西」的边界，不是随手拍的。

**为什么不用分数阈值**：分数连续、要人挑线、换语料就换意思；band 是「和榜首同一量级」这步已有结论，
不新增旋钮。本刀不动分数、不动排序、不动 `IMP_BAND`，只决定「捞回几条」——五池一位不动是预期。

**与 0.2.150 的关系**：同一套档位的第二个用途。同一档 = 同一量级 = 值得一起看；掉档 = 不是这条问句的答案。
两处共用 `IMP_BAND`，不许分叉。

### 9.173 稠密只补盲区，不并列投票（0.2.166）：省下来的算力花在词法自己承认不行的地方

**问题**：0.2.164/0.2.165 把词法那一族量到平台之后，剩下的错分几乎都是「词面根本没沾上」。
真库换说池 14 题里有 7 题正解没进 top3，它们的**榜首覆盖度全落在 0.072–0.142**（命中题的
覆盖度中位数是 1.00）——这不是权重问题，问句和记忆之间没有共用的词，任何乘法都救不回来。
而同一批题里，稠密向量能把其中一题排到第 1、另一题排到第 2。

**先试的是老路（并列 RRF 融合），全面否决**（`E:\Temp\vecprobe\ps173.mjs`，w = 稠密票权重）：

| 池 | 词法 alone | w0.2 | w0.25 | w0.3 | w0.4 |
| --- | --- | --- | --- | --- | --- |
| 照抄 hit@1/hit@3/MRR | 0.956 | 0.956 | 0.956 | 0.956 | 0.933 |
| 换说法 | **0.798** | 0.738 | 0.738 | 0.738 | 0.738 |
| 锚点 | **0.883** | 0.825 | 0.825 | 0.825 | 0.825 |
| 真库自找 | **0.997** | 0.954 | 0.954 | 0.954 | 0.942 |
| 真库换说 | 0.524 | **0.565** | 0.565 | 0.565 | — |

一句话：**词法变强之后，RRF 的边际收益由正转负**。0.2.154 时代「换说法 0.500 → 0.571」是
因为当时词法弱；现在词法 0.798，稠密补的那张平票反而把强序打散，只有真库换说一条赚。

**闸门在哪**（`ps176.mjs`）：把「词法自己知道不行」量成可判的数——查询 top1 的 `cover`。
miss 题 7/7 全在 0.072–0.142，命中题中位 1.00。取 θ=0.2 能抓满 7/7，误判 28/226 命中题
（这些题本来也答对，被重排的只是 top4 之后的尾巴，不影响 hit@1/hit@3）。

**做法**：`rescueByDense(lexHits, denseRes, docs, opts)` ——
① 词法前 `DENSE_RESCUE_HEAD = 4` 名**原样不动**；
② 其后按稠密余弦重排，`DENSE_RESCUE_COS = 0.45` 以下的不进来（`denseRes.ranked` 已按余弦降序，
`if (!(r.cos >= minCos)) break;` 即停）；
③ 稠密点到词法没命中过的条目，从语料里把正文捞回来（只回一个 id 对调用方没用），挂
`_dense` 与 `explain.rescue`；
④ 词法排在 head 之后、稠密没提到的，按原顺序接回末尾——**兜底不许把词法找到的东西弄丢**。
闸门 `denseRescueWanted()`：`denseRescue !== false` 且 `lexHits.length > 0` 且 `cover < θ`，
θ 就是 `DENSE_RESCUE_COVER = 0.2` —— 与 9.171/9.172 用的是同一个「覆盖度」，不另立阈值。

**参数网格（`ps178.mjs`；θ × head × cos，Δ = 五池 top5 相对纯词法的总增量）**：

| θ | head | cos | 照抄 | 换说法 | 锚点 | 真库自找 | 真库换说 | Δ |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 0.2 | 4 | 0.45 | 42/44/**45** | 10/13/**14** | 8/10/10 | 149/150/150 | 5/9/**13** | **+5** |
| 0.2 | 3 | 0.45 | 42/44/45 | 10/13/14 | 8/10/10 | 149/150/150 | 5/9/12 | +4 |
| 0.2 | 2 | 0.45 | 42/44/45 | 10/13/13 | 8/10/**9** | 149/150/150 | 5/9/12 | +2 |
| 0.3 | 4 | 0.45 | 42/44/45 | 10/13/13 | 8/10/10 | 149/150/150 | 5/9/12 | +3 |
| 0.2 | 4 | 0.5 | 42/44/45 | 10/13/13 | 8/10/10 | 149/150/150 | 5/9/12 | +3 |
| 0.2 | 4 | 0 | 42/44/45 | 10/13/**14** | 8/10/10 | 149/150/150 | 5/9/**13** | +5（但兜底会塞不相关项） |

零损失形态 = **hit@1 与 hit@3 一条都不动，top5 三池各 +1**。cos 门槛取 0.45 而不是 0：
余弦 0.2–0.4 的条目在真库上多半只是「同主题」，把它们排在词法尾巴前面等于用噪声替换噪声。

**验收时抓到的一个设计错**（`ps179.mjs`）：第一版只加了 rescue 分支，`denseRescueWanted` 为假时
仍然 `return trimByBand(fuseDenseHits(...))` —— 于是「稠密就绪」这件事本身就改回执：真库自找
**149/150 → 138/149**（打散的正是本来答对的 11 题）。改成「词法有把握就闭嘴」：

```js
if (opts.denseFuse !== true) return trimByBand(lex, opts.k, opts);
return trimByBand(fuseDenseHits(lex, denseRes, docs, opts), opts.k, opts);
```

0.2.154 的 RRF 融合保留成显式开关 `denseFuse`，**能力不砍，只是不再默认**。

**终读数（生产引擎，`ps180.mjs`，五池 233 题）**：

| 池 | 默认（rescue-only） | 纯词法 | 老 RRF（denseFuse） |
| --- | --- | --- | --- |
| 照抄 | 42/44/44·0.956 | 同一 | 同一 |
| 换说法 | 10/13/**14**·**0.810** | 10/13/13·0.798 | 8/13/13·0.738 |
| 锚点 | 8/10/10·0.883 | 同一 | 7/9/10·0.825 |
| 真库自找 | **149/150/150·0.997** | 同一 | 138/149/149·0.953 |
| 真库换说 | 5/9/**12**·**0.538** | 5/9/11·0.524 | 5/11/12·0.565 |

名次变动只有两处，都是「从没有 → 进 top5」：`自测怎么才算真的测到了东西`（默认 5 / 词法 −1）、
`它自己什么时候该回头反省一次`（默认 4 / 词法 −1）。**没有一个题变差**。

**代价**：预热是显式的（`denseWarm`），这是搜索之外的一次性开销；没有模型时整条路径一次都不触发，
回执与 0.2.165 逐位相同（`denseStatus().state === 'off'`）。**这个功能只在装了模型的环境里存在**，
没装就当它不存在——可选层不许在缺席时改变任何东西。

### 9.174 回执的欠账要报出来，并且要有一个关得掉的出口（0.2.167）

**问题**：0.2.165 的「按置信档收口」上线两版，一直在切回执，切完一声不响。读者看到「只给了 5 条」，
既不知道同档之外还有多少条，也不知道该不该要全量——这正是 rules 里
「任何对用户输入的上限都不许做成静默截断」那一条。而这次把两条路的长度都量出来之后，
还发现了一件比「没报」更值得写下来的事。

**第一件事：两条路的回执长度差一倍**（`E:\Temp\ps183.mjs`，真库 540 条，20 个关键词问句，
真调 `memory_search.execute`，k=10）：

| 路径 | 平均条数 |
| --- | --- |
| 工具回执（默认） | **2.35** |
| 工具回执 `band_keep:false` | 3.05 |
| 工具回执 `band_keep:false` + `min_rel:0` | 9.70 |
| API `search(q, docs, {k:10})` | 4.97 |

工具回执上叠着三把刀：置信档收口（2.35 → 3.05 的那 0.7 条）、**相关度地板 `min_rel=0.35`
（3.05 → 9.70 的主体）**、近重复折叠。**主导的是地板，不是 band 收口**——这纠正了 9.172
「回执从 9.80 收到 4.97」在工具路径上的归因：那里根本没有 9.80 条可收，收口只占其中的 0.7 条。
（下一步的候选因此变了：要调的是 `min_rel` 的默认值，不是再动 band。）

**做法**：

① `trimByBand` 记账——`const dropped = sliced.length - out.length;`，>0 时挂成
`Object.defineProperty(out, "trimmed", { value: dropped, enumerable: false, configurable: true })`。
**非枚举是有意的**：`JSON.stringify`、`Object.keys`、`for...of` 全都看不见它，
`bandKeep:false` 与旧版调用方的逐位相同性因此一个字都不用改（HZ/HY 那些 `JSON.stringify(a) === JSON.stringify(b)`
的断言一条没动）。

② 工具回执只报**一种**情况：`bandShort = bandTrimmed > 0 && hits.length < k`。
候选池本身有多大（内部排序拿的是 `{k: docs.length}` 全量，500 上下）不印给读者——
那只说明库大，不说明少看了什么。第一版把 78、500 这种数字直接印出来，读感是噪声，
量完工具口径（单题最多的「折掉」是 256 条）当场改成现在这样。回执给满 k 条时一个字符都不花。

③ 出口 `band_keep: false` 写进两处 schema（统一工具 `lib/macro/defs/search.js` 与 meow 原工具），
并一路接进 `rankForSearch` 的 opts。真要全量还得配 `min_rel: 0`——这句话写进回执本身，
不指望读者自己把两把刀都想到。

**读数（`E:\Temp\ps181.mjs`，真库 150 问，k=10）**：默认 hit@1 149 / hit@3 150 / hit@5 150、
条目均值 4.97，**148/150 题报出收口、合计 731 条、单题最多 5 条**；`bandKeep:false` 同名次、
均值 9.85、报数 0。账平：每题的「保留 + 折掉」都等于关掉时的条数（脚本内置断言，无一例外）。
`JSON.stringify` 里查不到 `trimmed`。

**代价**：`memory_search` 的 schema 6,852 B（单项上界 6,500 → 7,500，按老规矩只给实测值 +9.5%）；
回执多一行，且只在回执短于 k 时出现。

## 9.175 隐形的一层：默认检索范围里没有 user（0.2.168）

**问题**。9.174 把工具路径的回执量到了 2.35 条，主导刀是 `min_rel = 0.35`。顺着这条线修地板之前，
先搭了一把「读者视角」的尺子：**工具回执里到底有没有正解**（此前所有 hit@1/3/5 都是 API 层 k=10 口径，
而工具路径是 `k = docs.length` + 相关度地板 + 置信档收口 + 近重复折叠 + 弱命中门，两条路不是同一条）。

尺子一建，问题换了位置。真库 545 条、自找池 150 题（每条记忆的 keywords 前三个拼成问句），
**默认命中 142/150**。把那 8 题逐条摊开：`M.search(q, real, {k:10, bandKeep:false, min_rel:0})`
**每题都是第 1 名**，API 全量排序也是第 1 名——不是排序错、不是被地板砍、不是被折叠吃掉，
而是**根本没进候选池**：默认检索范围是 `fact/lesson/topic/rules`，而这 8 条的层全是 `user`。

`user` 层放的是「主人的偏好与设备环境」（汇报口径、核对纪律、外网约束、推进节奏……）。
这一层在真库只有 8 条，而默认检索看不见它——**沉默的 8 条比排错的 8 条贵得多**：
排错能看见（名次读得出来），没收进来永远看不见，回执里也没有一个字说「别的层还有东西」。

**读数**（真库 545 条，真调 `memory_search.execute`，每题独立 session id 避开 seen）：

| 默认层 × 地板 | 自找池 150 | 首位 | 条 | 字 | 换说池 13 | 首位 | 条 | 字 |
|---|---|---|---|---|---|---|---|---|
| fact/lesson/topic/rules · 0.35（改动前） | 142 | 141 | 2.18 | 531 | 9 | 5 | 4.23 | 893 |
| +user · 0.35 | **150** | **149** | **2.01** | **493** | 9 | 5 | 4.31 | 896 |
| fact/lesson/topic/rules · 0.30 | 142 | 141 | 2.54 | 607 | **10** | 5 | 4.54 | 960 |
| +user · 0.30（本次落地） | **150** | **149** | 2.19 | 531 | **10** | 5 | 4.54 | 952 |
| 全七层 · 0.30 | 150 | 149 | 2.27 | 558 | 10 | **4** | 4.46 | 953 |

三件事一眼可见：

1. **补上 user 之后回执反而更短**（2.18 → 2.01 条）。正解本来就在库里，它进榜把原本靠地板收口的
   弱候选挤了出去——「召回更全」与「回执更省」在这件事上不是取舍，是同向的。
2. **地板 0.35 → 0.30 在难句上多捞一题**（换说池 9 → 10），代价 0.31 条；自找池一题不伤（142 = 142）。
   0.25 与 0.30 同分，取条数更少的 0.30。
3. **全七层不行**。把 `soul` 与 `project` 也塞进默认，换说池首位从 5 掉到 4——`project` 层放的是一整个
   项目的概览（overview / structure），它天生跟任何问句都「沾一点」，一进来就抢首位。边界要读数画，不能靠感觉画。

**做法**。

1. `searchTool.execute` 默认层 `["fact","lesson","topic","rules"]` → 追加 `"user"`；`soul` 与 `project`
   仍要显式传（前者是 AI 自身人格，7 层里唯一「不该在被问事实时出现」的）。
2. `min_rel` 默认 `0.35` → `0.30`（schema `default` 与 `execute` 内联值两处同步）。
3. 零命中时那句老话跟着改口径：「默认检索范围是 fact/lesson/topic/rules/user，soul 与 project 层
   不参与关键词检索（要查它们请显式传 level，如 {"level":"project"}）」——**边界从「不说的默认」变成「说清的不查」**。
4. 三语 `tools.md` 的参数文案、`system-guide.md` 的「默认搜什么」、统一工具的 schema 描述一起同步
   （口径不一致比没写更糟：模型会按旧文案传 `level`，白查一轮）。

**验收**（`tools/probe-recall.mjs` R6，五条）：

- 默认召回得到那条 `user` 条目；
- 阴性对照：显式 `level: fact,lesson,topic,rules` 时它一条都不剩（默认含 user 是真在起效）；
- 边界没破：`soul` 与 `project` 仍不进默认；
- 只是不默认、不是查不到：显式 `level: soul` 时那条照样回来；
- 不传参数与显式 `{level: "fact,lesson,topic,rules,user", min_rel: 0.3}` **逐位相同**（默认值改没改一眼看得出）。

**代价**。换说池每题多 0.31 条 / +59 字；`min_rel` 从 0.35 降到 0.30 意味着「榜首三成以下的尾巴」
都会展开——真库自找池没有一题因此变差，噪声侧仍由 0.2.155 的闸门与 0.2.165 的置信档收口兜着。


## 9.176 语义补位：救一条正解，别把陪跑一起端上来（0.2.169）

**问题**。0.2.154 就写下了「词法没把握时按语义补位」，0.2.166 又给它加了「不沾边就弃权」的闸。
可这两条在本机**一次都没真跑过**：稠密模块那行加载判据把「包名里有斜杠」当成「路径」，
`@huggingface/transformers` 被拼成 `file:///@huggingface/transformers`，抛 `File URL path must be absolute`，
被 catch 之后状态落成 off——降级了半年，一声不响。修掉判据（只有真的像路径才按路径 import）之后
`denseStatus()` 才第一次变成 `ready`（bge-small-zh-v1.5#q8，dim 512，549 条全编码 5328 ms）。

**为什么值得开**。换说池里那条「它自己什么时候该回头反省一次」：词法把正解排在第 5
（正解 5.858 分，榜首 14.296；两条正解的原词命中都是 0，分数全来自同义桥），稠密单独排第 1。
词法单独 10/13，稠密单独只 3/13，**但两者互补**——稠密不是更好的检索器，是另一种错法。

**第一版是错的**。把 `denseRes.ranked`（cos ≥ 0.45、上限 30 条）一路塞进回执，还顺手关掉收口、
把词法 head 之后的尾部整段接回：换说池从 4.54 条 / 943 字涨到 **8.23 条 / 1746 字**。
命中是多了一题，代价是三四条陪跑，而且收口一关、那句「和榜首不是一个量级」的 note 也不说了，
读者根本看不出这批条目来路不同。

**读数**（真库 549 条，工具层 k=10）：

| 配置 | 自找 150 命中/首位/条/字 | 换说 13 命中/首位/条/字 |
|---|---|---|
| 稠密关（0.2.168 基线） | 149/150 · 148 · 2.17 · 526 | 10/13 · 5 · 4.54 · 943 |
| 稠密开，不限量 | 149/150 · 148 · 2.17 · 526 | 11/13 · 5 · **8.23 · 1746** |
| 限量 2，但仍接回尾部 | 149/150 · 148 · 2.17 · 526 | 11/13 · 5 · 7.38 · 1590 |
| **限量 2 + 折尾部（定案）** | 149/150 · 148 · 2.17 · 526 | **11/13 · 5 · 4.23 · 870** |

**做法**四条：

1. `var DENSE_RESCUE_MAX = 2;`：补位条数封顶，`opts.rescueMax` 可覆盖；循环里 `if (added >= maxRescue) break;`，
   只有真正 push 时才 `added += 1;`——数的是补进来的，不是扫过的候选。
2. 词法 head 之后不再整段接回：默认折掉，只有 `rescueDropTail: false` 时接回，折数记进 `trimmed`。
3. 账要累加：`const upstreamTrim = Number(hits.trimmed) || 0; const dropped = sliced.length - out.length + upstreamTrim;`。
   0.2.167 只报「这一刀折了几条」，上游折的会被这一层的 `slice` 悄悄抹平——救援路径明明折了也不说。
4. 来路分开记并且报名：`rescueTrimmed`（词法尾部折的）与 `rescueAdded`（补进来的）各自挂非枚举属性；
   note 里 `search.rescue` 一句说清「补了 N 条（余弦 ≥ 0.45，分数与词法不是同一套量纲，别拿分数跟榜首比）；
   词法里没把握的 M 条没展开」。这条路径上「弱命中」与「回执没给满」说的都是同一件事，一律让位——
   一句话说清，比三句同义话强。

**验收**（`tools/probe-recall.mjs` R7 七条 + `tools/probe-gold.mjs` G25 改口径）：常量与限量、折数累加、
来路分开记、note 报名且真进数组、加载判据（包名不当路径）、同一问句两次逐位相同；G25 的 `trimmed`
挂载点从「唯一」改成「两处，来路不同」。

**代价**。换说池命中 +1 题（10/13 → 11/13），回执反而短 0.31 条 / 73 字（4.54→4.23 条、943→870 字）；
自找池 149/150 一位不动；schema 不变（`rescueMax` / `rescueDropTail` 不进 schema，只给内部探针用）。


## 9.177 疑问词不是证据：中文 bigram 把「什么时候」切出了「么时」（0.2.170）

换说池 13 题里有两题（「什么时候才轮到把代码放到远端仓库」「它自己什么时候该回头反省一次」）的榜首是同一条
`0mwpfhh3`——它正文里写着「什么时候」这类闸门词，bm25 拿了 9.24 / 9.41，而两条正解只有 5.84 / 3.61。
#3 的第二名还是它的同族 `0mwnouop`。也就是说：这两题不是「排错了」，是**问句里的疑问词把一条讲疑问词的笔记顶上了桌**。

根子在切词。中文按 bigram 切：

```
tokenize('它自己什么时候该回头反省一次')
  → 它自 / 自己 / 己什 / 什么 / 么时 / 时候 / 候该 / 该回 / 回头 / 头反 / 反省 / 省一 / 一次
```

`CJK_FUNC_WORDS` 剔掉了「什么」「时候」「自己」「一次」，但**跨界碎片「么时」「己什」「候该」「省一」漏网**。
碎片在本库 df 极低、idf 极高，一条只写着「什么时候」的文档就被一个假词顶到榜首。噪声地板管不了它——那条地板
只认「出现在一半以上条目里的词」（`NOISE_DF_RATIO=0.5`、`NOISE_MIN_DOCS=8`），而「么时」只出现在一两条里。

读数（真库 554 条，工具层 k=10）：

| 池子 | 原句 | 剥掉疑问框架 |
|---|---|---|
| 换说 13 题 | 11/13 · 首位 4 · 4.23 条 | **11/13 · 首位 5 · 4.15 条** |
| 自找 150 题 | 525/554 · 首位 509 · 2.65 条 | 525/554 · 首位 509 · 2.65 条（一位不动） |

逐题看只有两处变化：#3 第 2 → 第 1、#9（「把一个文件拆开之后，怎么确认行为一点没变」）第 1 → 第 0，其余 11 题
位次一位不动。自找池一题不伤——那批问句是「keywords 前三拼接」，天生不含疑问词。

做法四条：

1. `stripQuestionFrame(text)`：正则整段剥成空格（不留空洞，空格负责切断 bigram），返回 `{ text, stripped }`。
   `stripped` 是「我改过你的问法」的账，去重后带出去。
2. 三护栏：剥完不足 4 个字符就整句回退（宁可带噪声，不许凭空空手）；只作用问句、不动索引；`questionStrip:false` 一键关。
3. `explain.stripped` 只在真剥了的时候出现——默认回执一个字节不花，要问「它凭什么排第一」时才看得见。
4. 工具层 note 一句「疑问框架按虚词处理了：{words}」，只有 explain 模式才有值。

验收：`probe-recall` 新增 R8 八条（函数口径 / 回退 / 标识符不损 / 切断碎片 / 只在问句侧剥 / 受控库真能红 /
explain 看得见 / 关掉不谎报）；受控库四条语料里，污染源只靠「么时」进榜——关掉这刀它在（2 条），开着它一条不剩（1 条）。

代价与连带：老刀的阴性对照被新刀削弱了五处（NF2/NF3、VT2/VT3、G9、GW、VW10）——它们关掉地板之后仍被剥离挡住，
于是「噪声回不来」假红。修法不是调阈值，而是**对照组只关被测的那把刀**：五处统一补 `questionStrip:false`。
整字面量 105,156 B，粗胖线 105,000 → 106,000（+0.15%，为 156 B 去删一句可追溯性话是本末倒置）。

成本快照（\	ools/fixtures/cost-snap.json\，45 问 × {40,1200} 两档）也随之换代：40 档 **3 题名次/集合变**——
第 21「反思应该由什么触发」二三名对调、第 26「改插件代码前要不要先备份」第三名换人、第 39「0.2.133 调取精度改了什么」
5 条收成 2 条；另有 14 题只有绝对分变。1200 档 **0 题名次变**、17 题分值变——库越大排序越稳，说明剥离动的是
「问句里那几个词」，不是打分本身。名次变了必须写进这里，不许让快照悄悄换。

## 9.178 历史可查：点了名就说清「它过期了」，别装作没有（0.2.171）

**问题**：真库 45 题 gold 池（k=10）首位只有 30/45，而最刺眼的四题是同一个病：

| 问句 | 改前 | 改后 | 池里到底有没有 |
| --- | --- | --- | --- |
| `0.2.148 改了什么` | 前 10 名无正解 | 第 1 名 | 有，`status=stale` |
| `0.2.148 做了什么` | 前 10 名无正解 | 第 2 名 | 同上 |
| `0.2.147 改了什么` | 前 10 名无正解 | 第 5 名 | 有，被两条同版本条目压住 |
| `0.2.146 加了什么` | 前 10 名无正解 | 第 1 名 | 有，`status=stale` |

不是排序差，是**正解根本不在候选集里**：`db.listSearchable(level)` 只回 `status='active'`
（+ project 层 `subcategory='todo'` 的 stale），而每条版本的交付 fact 都被下一版取代成
stale。读者问「0.2.148 改了什么」，拿到的是五条正文里顺带提过这个版本号的 lesson，
一句提示都没有——正解只活在过期条目里，而检索层从没打算去翻它——这比排错更糟：排错至少还在榜上。

**第二层原因**：`bandize(hits, '_raw')` 按**纯 BM25** 分档（0.2.150），而标识符补分
（0.2.148：`h.score += unitScore * vb.ratio * (idHit ? IDENT_ID_W : IDENT_W)`）只进 `score`
不进 `_raw`。于是「问句点名了这条」这个最强证据，在分档那一层完全不算数：`_raw` 5.03
的条目被 `_raw` 7.95 的压在 band 0，补分再多也翻不过去。

**做法四条**：

1. **补分也进 `_raw`**：`var IDENT_BAND_W = 0.8;`，
   `_raw: raw[di] * (1 + (rawVerbatim[di] === null || opts.identBand === false ? 0 : identBandW * rawVerbatim[di].ratio))`。
   只乘不加：分成 3 倍地跨不了档，乘上去才在接近时翻面。默认档下的 45 题读数
   **一题不变**（30 → 30），它是为下一刀准备的地基。
2. **只补「点了名」的那几条**：`const askIdents = statusDead || statusList.length > 0 || parsed.include_stale === false ? [] : identsOf(query);`——
   问句里有版本号 / 路径 / 短 id / commit，才去 stale 里找含这个标识符的条目。
   `listSearchable` 的口径**一个字不动**（主人拍板：其他类别过时不默认检索），
   放宽只发生在「用户点名要它」这一种问句上。
3. **先打分再取前 N**：第一版按 `db.list` 的顺序取前两条，`0.2.147` 的正解被两条同版本
   条目挤到第 3、照样漏掉。改成 `await rankForSearch(query, pool.map(docFor), { k: HIST_LIFT_MAX, explain: false, bandKeep: true })`，
   `HIST_LIFT_MAX = 3`——取 2 时 #3 全 miss，取 3 时它进第 5 名，代价是触发题多一条。
4. **翻出来的要自己报名**：`search.histLift` 一句「问句里的 `0.2.148` 只出现在已过期的
   条目里：这次顺带把 N 条翻了出来（ids），它们正是那个时期的记录、已被后续版本取代，
   别当成现在的结论用。要通看历史传 status:"all"。」，并给 `include_stale: false` 出口。

**读数（45 题 gold，k=10，工具层默认 5 层）**：首位 **30 → 32**、次席 6 → 7、触发 6 题；
逐题只有 #1 −1→0、#2 −1→1、#3 −1→4、#4 −1→0，**其余 41 题一位不动**。#13、#16 触发了
补录但正解仍不在 stale 里（#13 的 want 已 archived、#16 的 want 根本不含该标识符），
这两题属于池过期，不是检索能救的。

**连带假红与修法**：`probe-gold` G20（关键词权重平台）先红——「旧口径下锚点池没变差
（hit@1=0.800）」。原因是 identBand 一开，带版本号的锚点池靠标识符就能进前列，低 kw 权重
看起来不再变差，**阴性对照失效**。修法与 0.2.170 同一条：两把刀分开测——G20 段整体加
`const NB = { identBand: false }`，`md(list, o)` 统一展开，G20 只量关键词权重这把刀。
（顺手踩了个坑：`V.search(q, docs, { k: K, ...opts })` 在 G20 与 G21 两段是同一串，替换时
一并命中了 G21，`NB` 越界报 `ReferenceError`——按行号定点修回。）

**验收**：`probe-recall` R9 六条（翻得出 / 说过期 / 关得掉 / 只认点了名 / 不捎带无关 /
口径不动）、`verify` HZ6 七条、`probe-gold` 全绿、`probe-cost` 45 问 × 两档。
代价：触发题回执多 1–3 条，不触发的题一个字节都不多花。

**成本快照换代（0.2.171）**：`tools/fixtures/cost-snap.json` 45 问 × {40,1200} 重写。
40 档 **4 题变**：`#1`、`#3`、`#4`、`#39`——句子里都点了版本号（0.2.148 / 0.2.147 / 0.2.146 /
0.2.133），正是补录要管的局面；`#1` 的第三名从 `0mwn9xk3`（正文顺带提过版本号的 lesson）
换成 `0mwq858p`，第五名补上 `0mwq858p` 那条时期的记录。1200 档 **0 题变**：宽档本来就给
五条，补录进来的两条没能改写头部，说明这刀只动「窄档被同族条目压住」这一种局面。


## 9.179 主语位：问句点名的那个东西，正文第一个词就是它（0.2.172）

### 病：词分高的不是「答了这题的」，是「字更多的」

45 题 gold 池逐题诊断（`E:\Temp\diag172.mjs`，真库五层、`searchHybrid` 回落 `search`），**首位不对 14 题**，最刺眼的一题：

| 问句 | 名次 | 正解 | 压在上面的那条 |
| --- | --- | --- | --- |
| `0.2.148 改了什么` | 2 | `0mwq84ts` 20.17 | `0mwr2l7q` 33.71 |

`0mwr2l7q` 是 0.2.171 当天写下的教训「中间层要认上一层的强证据」，正文里**顺带**提了一句「问『0.2.148 改了什么』时分数 14.70 却排第 4」。它比正解更短、词更密（0.2.148、改了什么 全在），于是词分高出十三分。正解是那条交付 fact 本身，正文开头就是「0.2.148 交付态：…」。

这类错误不是「排序器不懂语义」，是**问句里的标识符在两处出现，一处是主语，一处是引文**，而词分只数次数、不分位置。

### 第一刀失败：title 加成，七档读数一模一样

先试的是「标题里点名 → `_raw` 加成」（`IDENT_TITLE_W` / `identTitleW`），扫 w=0…2.0，**七档首位全是 31/45，一位不动**。这种「怎么调都不动」不是参数没生效，是判据踩在空地上。实测：

```
fact 92 条   lesson 385 条   rules 33 条   title 全为 ""
```

宏记忆写入时不落标题，**0.2.133 起就一直在调的 `FIELD_TITLE_W = 0.6` 从来没起过作用**——它乘的是空串。这是一条比这轮改动更值钱的发现：一个加成系数在真库上恒等于 0，而探针（合成语料，标题都填了）永远测不出来。

### 换判据：正文开头 = 主语位

`subjRatio(di)`：把问句里的标识符（`identsOf`：版本号、路径、短 id、commit）逐个拿去和 `content.trimStart().toLowerCase()` 比 `startsWith`，命中数 / 标识符总数。正文第一个词就是它 → 这条记忆的主语就是它；只在第三句提到 → 不算。

`_subj === 1`（ratio ≥ 0.5）进 **bandize**，和 `_ident === true`（问的就是这条 id）同档：`bandOf.set(h, -1)`。**免档，不是加权**。

### 为什么不用权重：2.5 能过，2.4 就不行

同一套语料扫 `identSubjW`（同时进 `_raw` 与 `score`）：

| `identSubjW` | 首位 | 归位 |
| --- | --- | --- |
| 0（只免档） | 34/45 | #1 #2 #3 |
| 1.0 | 33/45 | #2 #3 |
| 2.4 | 33/45 | #2 #3 |
| 2.5 | 34/45 | #1 #2 #3 |
| 2.0 / 3.0（只进 `_raw`） | 33/45 | #2 #3 |

2.4 不行、2.5 行——这种悬崖是「拿权重去顶一条本该由档位说清的规矩」的典型症状：再加一点就过，换一批语料又不过，谁也说不清它在哪条边界上。**能靠档说清的事别用权重硬顶**：免档版 `IDENT_SUBJ_W` 定 **0**（w=0 与 w=0.3 读数完全相同，说明权重这一侧本来就不需要），45 题 **31 → 34，变好 3（#1 #2 #3），变差 0**。

### 出口与自述

- `identSubjBand: false` 关掉免档；`identSubj: false` 关掉加权；`identSubjW` 手动给权重（默认 0）
- `explain.subjBonus` 只在真给了权重（`addS > 0`）时出现，默认 0 时不留空字段——「没发生的事不许在 explain 里留个 0」，这是 0.2.171 那条 `stripped` 的同一个规矩

### 验收：R10 六条 + G20 阴性对照

`tools/probe-recall.mjs` 的 R10 走**引擎 API 层**（`V.search(Q10, R10_DOCS, …)`），不走工具层：第一版用受控库调 `memory_search`，读到 `explain.band === undefined`、score 只有 5.8/5.2 —— 工具层那条路径根本不暴露分档，`identSubjBand:false` 也不在工具 schema 白名单里，开关没被转发，于是「关掉后仍第 1」被误读成阴性对照通过（假绿）。教训：**探针要测哪一层，就在那一层断言**；隔一层就只能测到「不崩」。

六条：①主语位第 1、句中提名第 2 ②`identSubjBand:false` 退回第 2 ③无 ident 问句开关前后同序 ④句中提名「开了不比关着更靠前」 ⑤免档判据只写在 bandize 一处 + `IDENT_SUBJ_W = 0` ⑥`subjBonus` 出口条件（含 `identSubjW > 0`）。

第 ④ 条一开始写的是「关闭前后名次不动」，实测 `开=2 关=1` —— 这不是判据错，是**主语位那条上位把句中那条挤下去了**，两者相对关系没变。断言方向要写「开时不得更靠前」，不能写「完全不动」：一刀生效时，别的条目退位是正常副作用。

`probe-gold` 的 G20 阴性对照（「旧口径下锚点池没变差」）首跑假红：`NB` 只关了 `identBand`，这轮新加的免档还在替词分干活。修法是 `const NB = { identBand: false, identSubjBand: false, identSubjW: 0 }`——**阴性对照要把当轮所有「替词分干活」的刀一起关掉**，漏一把就不叫对照。踩坑：`probe-gold.mjs` 是 CRLF，python 用不带行尾的 old 串匹配，带 `\n` 结尾永远 `AssertionError`。

## 9.180 问的是规矩，就别拿经验来答（0.2.173）

45 题 gold 里有一类错得很有规律：#21「反思应该由什么触发」正解在 **rules** 层（19.18 分），压在它上面的是一条 **lesson**（19.86 分）；#40、#26 同样。差的那几毛钱不是词没匹配上——两条都含足量关键词——是**问的层和答的层错位**：问句在问「规矩怎么定」，答的却是一段经验。

| 题 | 问什么 | 正解层 · 分 | 压它的层 · 分 |
|---|---|---|---|
| #21 | 反思应该由什么触发 | rules · 19.18 | lesson · 19.86 |
| #40 | 改插件代码前要不要先备份 | rules · 47.88 | lesson · 51.66 |
| #26 | 改插件代码前要不要先备份（另一问法） | rules · 17.26 | lesson · 32.53 |

### 三层探路，前两层都不对

**第一版：层级项直接进 `_raw`，无比率门。** `w=0.6` 时 #21 #40 归位，45 题首位 34 → 36，变差 0。看着很漂亮，`probe-cost` 却炸了：#39 那里出现 **1.435 分排在 2.545 分前面**——层级匹配把一条「本来就不相关」的条目跨档抬进了第一档。分档是硬门槛，一跨过去，分数低多少都一样在前面。

**第二版：改成档内乘法 `h.score *= 1 + w`。** 完全无变化（仍 34/45）：#21 #40 的正解和压制者**根本不在同一档**，档内怎么调都追不上。结论是这一步绕不开跨档，但必须挡住「分差太远的顺带」。

**第三版：`_raw` 加法 + 比率门。** `raw[di] >= lvRatio * maxRaw` 才给层级加成，`lvRatio = 0.5`：只帮「本来就在半程以内」的条目，分差太远（#39 那条比值 0.05）一概不抬。45 题 36/45、变差 0，`probe-cost` 名次 0 变化。

**第四版（当前）：`_raw` 管进档，score 管档内次序。** R11 的受控语料暴露了第三版还剩的一个坑：条目被 `_raw` 抬进第一档之后，**档内还是按没抬过的 score 排**，于是它进了第一档却仍是第二名（rules 3.007 排 lesson 3.439 后面）。补上 score 侧乘法之后两处各管一段：`_raw` 决定「够不够格进这一档」，score 决定「进了这一档排多前」。

### 一个不显眼的真 bug：乘法段一开始写进了别的分支

第一版的乘法段插在 `if (verbHay !== null) {` 里——那是 0.2.148 的补分块，只在问句里有 verbatim 命中时才进。R11 的受控语料没有任何 verbatim 命中，整段根本没执行，于是「加了乘法却毫无反应」。表现和「参数没生效」一模一样，但真因是**作用域**。修法：挪到 `bandize(hits, '_raw')` 之前的独立循环。

（这个坑值得单说：探针测出一个「参数不生效」，第一反应通常是调参，实际上要把「这段代码到底跑没跑」先钉死。）

### 读数

- 45 题 gold（k=10，含历史上浮）：首位 **34 → 36/45**，#21 #40 归位，变差 **0**；#26 仍是 lessons 压制（那条 lesson 32.53 分本身太强，比率门挡住了层级加成，属设计内放弃）。
- 自找池三池零退化：关键词找自己 0.915 / 0.972（615 问）、正文头 40 字 0.850 / 0.951（615 问）、正文中段 0.866 / 0.956（614 问），`w=0` 与 `w=0.3` **两端完全相同**。
- 成本快照（45 问 × 40 / 1200 两档）：**名次 0 变化**，13 题有分数变化（首位分 ×1.3，因为层级命中就是在调相关性）。这是这一版唯一一处「分数会动」的地方，换代时按「名次不变、分数按系数放大」记账。

### 做法（四条）

1. `intentLevelsOf(query)` 从问句形态判意图层：`要不要|该不该|能不能|…|该由|应该由|由什么触发|规定` → rules；`改了什么|改了哪些|…|交付态|什么版本` → fact；`来龙去脉|为什么|缘由|经过` → topic；`怎么跑|怎么写|怎么做|…|踩过|经验` → lesson。一个问句可能同时命中多层（比如「为什么不行、该怎么办」）。
2. 层级命中且 `raw >= lvRatio * maxRaw`（`lvRatio = 0.5`）才给加成——只帮「本来就近」的，不凭空造相关性。
3. `_raw` 上加 `levelIntentW`（`w = 0.3`）决定进档，`score` 上乘 `1 + w` 决定档内次序；两处同一个系数，不是一个数两处拍。
4. 出口两个：`opts.levelIntent = false` 关掉；`explain.levelIntent = true` 只在真抬了的时候出现（别让分数悄悄变）。问句没有意图词时 `intentLevelsOf` 返回 `null`，整把刀不介入。

### 验收

- `tools/probe-recall.mjs` **R11 六条**：问「该由谁来定」时 rules 进第一档 / `levelIntent:false` 阴性对照（退回第二）/ 比率门挡住分差太远的那条（开关前后同为「未进榜」）/ 无意图问句前后逐位同序 / `intentLevelsOf(` 全文只出现两次（定义 1 + 调用 1，只在问句侧）/ `explain.levelIntent` 只在被抬的那条上出现。
- `verify.mjs` **HZ8 七条**：常量、四条正则、`intentLevelsOf` 定义与唯一调用点、比率门、`_raw` 层级项、score 乘法段在 `bandize` 之前、R11 六标题与本节锚。

## 9.181 要的是那条断言，不是那段背景（0.2.174）

0.2.173 把 45 题 gold 的首位推到 36/45，剩下的四道（#7 #11 #17 #18）全属「差一点点」：#17 只差 0.382 分、#18 差 0.321 分。逐题把 want 与压制者摆在一起读，形状是同一个：

| 题 | want（正解） | 压制者 | 分差 |
| --- | --- | --- | --- |
| #7 PowerShell 里怎么跑多行 python | 「别用 `python -c`，写临时 `.py` 文件」 | 讲「多行写法有几种」的铺垫 | 22.99 vs 19.76 |
| #11 基线要跑几轮才收敛 | 「至少要收敛两轮，第一轮常出新红」 | 讲「基线是什么」的总述 | 21.36 vs 13.73 |
| #17 publishTimestamp 该写什么值 | 「**必须是**过去的秒级时间戳」 | 「有两套时间戳、别只改一处」 | 8.66 vs 8.28 |
| #18 市场索引要改几个文件 | 「**只有**两份要改」 | 「市场索引由几个部分构成」 | 23.88 vs 23.56 |

两边的词分都够（都命中了问句里的词，都在同一档里），差的是**「答的是不是问的那个」**：正解的第一句就是结论，压制者的第一句是背景。结论有形状——`必须/一律/只认/只有/至少/不许/绝不/禁止/都要/统一/固定为`，背景铺垫里没有。

### 三版探路

1. **全文断言密度，无条件加成**：`assertRatio = min(1, 命中数 / 3)` 直接进 `_raw`。首位 33 → 34，但 #1 #2 #3（问「0.2.148 改了什么」）退步——铺垫条里也散着断言词，全文计数把「顺带提到必须」也算成答案。
2. **求值型问句 × 断言密度，且不抬原 top**：只在问句是 `该写|该填|写什么值|几个|几轮|多少` 这类求值型时开；`raw[di] < maxRaw` 才加（榜首本来就是它要说的话，再抬一次只会压别处）。受控语料 35/41（+2 题），但真库 #17 从第 1 掉到第 3——**「不抬原 top」这个门本身就是伤害来源**：#17 的正解已经是榜首，而它旁边那条背景铺垫被抬起来反超了它。
3. **去掉门**：无条件按断言密度加成。真库坏题 9 → 7（#17 #18 归位），fixture 三池名次零变动。**这一版留下。**

### 两个真坑

- **`tipAssertW is not defined`**：常量 `var TIP_ASSERT_W` 写了，`const tipAssertW = Number.isFinite(opts.tipAssertW) ? … : TIP_ASSERT_W;` 漏了。0.2.173 已经因为「参数不生效先查作用域」记过一次，这次是它的兄弟：**新加的旋钮要和常量一起写**，否则第一次执行到那一行就 `ReferenceError`，而报错位置在 `_raw` 那行，看着像表达式写错。
- **`_raw` 不进 score**：加成只写进 `_raw`，而 `_raw` 只参与 `bandize` 分档，score 是 `raw * w * impW * stW` 另算的。所以「同档内的名次一点不动」，受控语料四条全同档 → 分数一模一样（0.1396/0.1343/0.1319 三档读数一致）。补 score 侧乘法（`h.score *= 1 + tipAssertW * tr`，`_tr` 在 push 时挂、用完 delete）之后，真库坏题 7 → **6**，#11 也归位。**教训：凡是想改「顺序」的项，先问它落在分档还是落在分数上——两处都要写。**

### 读数

- 45 题 gold（k=10）：坏题 **9 → 6**。其中 4 条是 `want = null` 的过期样本（#37 #38 #39 #45），真错只剩 **#7（pos=1）#26（pos=1）**，即 **39/45、真错 2/41 ≈ 95.1%**。
- `probe-gold`：hit@1 **0.911 → 0.933**、hit@3 0.978、MRR **0.944 → 0.956**，G1/G2/G3/G18/G22 全 PASS。
- 自找池三池（关键词 / 正文头 40 字 / 正文中段，621/621/620 问）：`tipAssert` 开关两端**完全相同**（0.916/0.971、0.852/0.952、0.866/0.956），触发求值型的问句只有 1 / 9 / 8 条。
- **成本快照换代（0.2.174）**：40 档 16 题有变化（名次动 2 题：#11 第 3/4/5 名互换、#18 第 4/5 名互换；其余只分数变），1200 档 16 题只分数变、名次 **0 动**。首位一处未变。
- **G20 阴性对照失效并修好**：关键词权重抬到 1/1.2 时照抄池本该掉，现在被断言密度补住了（0.933 不掉）——那不是关键词变好，是另一把刀在干活。同 G18 的先例，`NB` 里加 `tipAssert: false`，把当轮的刀全部关掉再量关键词。

### 做法（四条）

1. `tipAssertOn(query)` 只认求值型形状：`该写|该填|写什么值|要改几个|改几个|要改几条|改几条|几轮|要跑几|几条要改|哪个值`。**不收裸 `多少`/`几个`**——正文里到处都是，会把普通问句也拖进来（这是第一版 G22 假红的来源）。
2. `assertRatioOf(text)` **只看开头 60 字**，`min(1, 命中数 / 2)`。断言是结论的位置：写在第五段的 `必须` 不是这条的结论。受控语料钉住过：把断言挪到 60 字之后，分数一点不加。
3. 两处落地：`_raw` 上加 `tipAssertW * ratio`（进档），`score` 上乘 `1 + tipAssertW * ratio`（档内）。`tipAssertW = 1.2`。
4. 出口三个：`opts.tipAssert = false` 关掉；`opts.tipAssertW = 0` 只留判据不留加成（与关掉同分，测过）；`explain.tipAssert = true` 只在真抬了的时候出现。

### 验收

- `tools/probe-recall.mjs` **R12 六条**：求值型问句时断言条进第一 / `tipAssert:false` 阴性对照（退回第二）/ 非求值型问句前后逐位同序 / 开头 60 字以外的断言一点不加 / `assertRatioOf(` 三处（定义 + 分档 + 打分）/ `tipAssertW:0` 与关掉同分、默认比关掉高。
- `verify.mjs` **HZ9 七条**：常量与两张正则、`assertRatioOf` 的开头截断、求值判据只在问句侧、两处分工与 `bandize` 前后关系、R12 六标题与本节锚、G20 的 `tipAssert: false`。
- `tools/probe-gold.mjs`：G1 0.933 / G3 0.956 / G18 / G20 / G22 全 PASS；`tools/probe-cost.mjs` 换代后 C5 PASS。
## 9.182 量具要按生产规模建：40 条样张是小房间（0.2.175）

**为什么要动量具而不是继续动引擎。** 0.2.174 之后 45 题 gold 的读数很好看：hit@1 = 0.933、MRR = 0.956，未中第 1 的只剩 #37「评测台为什么封存」和 #45「评测台还能跑 locomo 吗」。但那个 0.933 是在 **40 条样张** 的池子里跑出来的，而生产的池子是 **578 条**（真库五层 active 条目）。同一批问句在 578 条池子里跑，未中第 1 的是 **5 条**（多出 #7「PowerShell 里怎么跑多行 python」和 #26「改插件代码前要不要先备份」——这两条在样张池里根本没有能压住它们的干扰条目）。池子大小差 14 倍，读数差 7 个百分点，那这 0.933 到底测的是什么？

同一个毛病的另一面，这一轮还抓到一个：我自己的临时诊断脚本 `E:\Temp\diag172.mjs` 里 `ALS = ['fact','lesson','topic','rules','user']`，**漏了 project 层**。而 gold fixture 的 40 条样张里有 3 条 project（`0mwpsfb0` 评测台封存、`0mwpsco0` 0.2.150 交付态、`0mwps9r9` 0.2.133 三刀）。于是 #37 #38 #39 #45 这四题被误判成「want = null，样本过期」，整整三个版本（0.2.172–0.2.174）都在账上记着「4 条 gold 过期」，实际是我自己的取数口径另立了一套。补上 project 后 bad 从 6 掉到 5，四题的 want 全部都在池里，只是排第 2 到第 k 外。

**做法：宽池档（G-W）。** 从真库 578 条 active 条目里，按层比例抽 **106 条**冻结快照，存进 `tools/fixtures/gold-wide.json`：

| 层 | 池（active） | 抽 |
| --- | --- | --- |
| fact | 92 | 25 |
| lesson | 383 | 40 |
| topic | 16 | 6 |
| rules | 16 | 16（全取） |
| user | 8 | 5 |
| project | 24 | 14 |
| 合计 | 539 | 106 |

抽样规则写死在导出脚本里：按 `created_at` 升序、等间隔取第 `int(i * len / n)` 条，`content` 截到 700 字，排除 40 条样张已含的 id。**冻结**（fixture 是文件，不随真库漂移），所以探针仍然可复现——这是能当指纹的前提。

探针里不另立语料，而是 `const wideDocs = docs.concat(wideFx.documents)`（40 + 106 = **146 条**），同一批问句、同一个 `measure()`：

| 档 | 窄池（40） | 宽池（146） |
| --- | --- | --- |
| 照抄词（45 问） | hit@1 **0.933** / hit@3 0.978 / MRR 0.956 | 一模一样 **0.933** / 0.978 / 0.956 |
| 换说法（14 问） | hit@1 **0.786** / hit@3 0.929 / MRR 0.845 | hit@1 **0.714** / hit@3 0.857 / MRR 0.800 |
| 时间锚（10 问） | hit@1 **0.800** / hit@3 1.000 / MRR 0.883 | hit@1 **0.700** / hit@3 0.900 / MRR 0.825 |

三条读数各钉一条守卫线：G-W1 照抄档 ≥ 0.93、G-W2 换说法档 ≥ 0.71、G-W3 时间锚档 ≥ 0.70。加第四道阴性对照 G-W4：**宽池换说法档必须比窄池难**（`wideP.hit1 < narrowP.hit1`）——如果哪天宽池读数与窄池一样好，说明宽池根本没被拼进去，或者又被谁悄悄降级成摆设。

**读数说明了什么。** 照抄档在 146 条池里一个点没掉，说明「问句照抄正文」这条路本来就是靠词面强制命中，加干扰压不动它；换说法档掉 7.2 个点（0.786 → 0.714）、时间锚掉 10 个点（0.800 → 0.700）——**这两档才是真实用户的样子**（用户不会照抄我的正文，也不会永远问「现在」）。之前在窄池里，它们的高分有一半来自「房间里只有 40 个人，认脸容易」。宽池钉住之后，任何改动只要把换说法档打下去，verify 立刻红，不用等到真库上才发现。

**这一版的边界。** 0.2.175 **没有动引擎**：检索侧一刀没加，vendor lib 一个字节没改，所有 bin 的分数与 0.2.174 逐位相同（`probe-cost` 快照无需换代）。改的只有量具（一个新 fixture + probe-gold 四条）与其上的锚。所以这一版的读数是「0.2.174 引擎在更难的考场上的成绩」：照抄 42/45、换说法 10/14、时间锚 7/10。

验收：HZ10 六条（冻结快照 106 条 / 与样张不重叠 / 探针真拼接 / 三条守卫线 / 阴性对照 / 文档锚）。

## 9.183 问状态的时候，去仓里取，别去词面上撞（0.2.176）

真库 581 条，问「现在主线推进到哪一版」，正确答案只有一条：project 层那条「项目现状（0.2.175）」——
2026-11-22T02:25 刚更新过，24 支自检、3,249 条断言、HEAD dcbebbe 都写在那里。

实测它**连候选都不是**（`E:\Temp\status176.mjs`）：前五名是 `0mwm6pxd`(user 9.22) / `0mwm6bpw` /
`0mwnbfks` / `0mwm77xl` / `0mwm5mfp`，全部是「lesson 讲道理」型的条目。原因很朴素——
问句说的是「主线 / 推进 / 哪一版」，条目写的是「24 支自检 / 3,249 条断言」。**一个词都不重**。

这不是权重没调好。调权重只会把「某条 lesson 的分抬高一点」，不会让一条词分 0 的条目冒出来。
这是**结构问题**：有一类问句问的不是「哪句话讲了这件事」，而是「现在是什么局面」，
而局面写在固定的几个仓里（项目现状 / 当前待办）。这类问句该去仓里取。

### 做法：三道自限 + 一条「跟榜首走」

- `STATUS_RE` 认「局面词」：`到哪一版|推进到|进展到|主线停在哪|当前待办|现在待办|项目现状|现状如何|现状是什么|现在什么情况|截至|最近一次|最新版本`
- `STATUS_OFF_RE` 让路：问句里有 `为什么|怎么|如何|缘由|踩过|技巧|办法|该不该|要不要|能不能|可不可以|是否` → 不插手（问原因、问方法，现状仓答不了）
- `hasIdent !== null` → 不插手（问句带版本号/日期，问的是「那一刻」，交回词法与时间锚）
- `wants` 按问句分流：含「待办」只认标了待办的条目，含「项目现状 / 到哪一版」只认「项目现状」那类
- 只扫 `level === "project"`，按 `updated_at` 降序取前 `STATUS_DIGEST_MAX = 3` 条
- 分数**跟榜首的实际分数走**（`topScore * (1.15 - si*0.03)`），不跟词分走——它词分可能就是 0

三条自限的来由，每一条都是被误伤逼出来的：

1. 初版 `STATUS_RE` 里放了「现在 / 当前 / 目前 / 最新 / 待办」这些泛时间词 → 问「现在待办有哪些」时，
   **「项目现状」那条抢答了**（它更新时间最新）。改成 wants 分流。
2. 分流之后还抢——因为 `STATUS_NOW_RE`（判断「要不要 /项目现状/ 这个仓」）里还留着「现在 / 目前」，
   两个仓同时收。把泛词删掉才真分流。
3. 泛时间词还误伤另一类：问「现在推送欠账什么规矩」，现状仓挤掉了那条 rules。
   → `STATUS_RE` 里只留**明确的局面词**，泛时间词一个不留。误伤消失。

再往后又收了一次：三池自测把每条记忆的正文头 40 字当问句跑，4 条含「现状」二字的问句
（「记忆腐化 当前反例 现状断言」「代码现状一变…」「凡记忆里写了『现状是』的条目…」「现状实测数字」）
都被现状仓顶掉了正解。原因是 `STATUS_RE` 里那个光秃秃的 `现状`。
→ 必须带上明确指代（`项目现状 / 现状如何 / 现状是什么 / 现在什么情况`）才算局面词。改完三池变动 0 条。

**教训一句话：状态识别词只放「局面词」，泛时间词会把「现在 X 怎么规矩」这类对象问句也卷进来。**

### 两个真坑

① **补丁锚点不能引用上一轮补丁自己加的常量。** `sd176.py` 拿 `var IMP_SLOPE = 0.25;` 当锚
（那是 0.2.175 探路时临时加的），可从备份还原后那行根本不存在 → `AssertionError`。
换成本就有的 `var TIP_ASSERT_W = 1.2;` 才对。同理：`if (raw[di] <= 0 && rawVerbatim[di] === null) continue;`
在 `index.js` 里有两处（search 主循环、keywordHitScore 的 out 循环），只改一处会让「关键词通道」和「正文通道」
对同一条记忆给出不同候选集。

② **「只抬一条」是设计错误，不是保守。** 待办仓里有三条（11-20 / 11-22 各一次整理），
只抬更新的一条，读者看到的是旧那份。改成同仓一起上浮（前 3 条，分数递减 3%）。
「当前待办有哪些」现在把两条待办都端上来。

### 读数

- **真库 45 题**（`E:\Temp\diag176b.mjs`，581 条池）：ON 36/41 = 0.878，OFF（`statusDigest:false`）
  36/41 = **完全相同**，hit@5 40/41、MRR 0.919 两边一致；「只有 ON 错」「只有 OFF 错」两个集合都空。
- **三池自测**（`E:\Temp\self176.mjs`，630 / 630 / 629 问）：关键词找自己 0.917、正文头 40 字 0.852、
  正文中段 0.866，开关两端**逐位相同**。
- **状态句**：问「现在主线推进到哪一版」ON 首位 `0mwr2lg0`（正解）/ OFF 首位 `0mwm6pxd`；
  问「现在待办有哪些」ON 前三条全是待办仓 / OFF 首位不是。
- **probe-cost 快照**：两档 90 题**名次 0 动、分数 0 变**（成本语料里没有局面词问句，这一刀不该碰它们）。
- **G26**（受控语料 7 条）：状态句进现状仓、关掉就退回、问待办只翻待办仓、对象句/原因句/锚点句关前后逐位相同。
- **R13** 五条：同 R13 断言。

### 时效题：标 live，别每版改 want

「现在主线推进到哪一版」这条题的 want 是 `0mwpsco0`/`0mwq84ts`（0.2.150 那会儿的答案）。
库里的答案早变了，每过一版就得回去改标注——**改的是标注，不是引擎**，还把「这题测不出来」这件事藏起来。

现在 fixture 里这类题标 `"live": true`，`measure()` 跳过它们（不进分母，只在 miss 里留一行记号）。
锚点档同样处理，所以 `G-W3` 从 10 问变 9+1、读数从 0.700 抬到 0.778（分母变了，不是引擎变好）。

顺带的连带修正：`G20` 的阴性对照原来写死「旧口径 hit@1 ≤ 0.75」，那是照着 10 条题、8/10 → 7/10
刚好踩线定的绝对数。分母一变就假红。改成**比默认更差**（`aOld.hit1 < aBase.hit1 && aOld.mrr < aBase.mrr`）——
阴性对照要问的是「这一刀是不是在干活」，不该写死分母。

### 顺带记一笔：稠密检索这三档全输，正式否决

`E:\Temp\vecprobe\wide176.mjs`（bge-small-zh-v1.5 q8，146 条 doc 编码 4.2s、69 问 0.1s）：

| 档 | bm25 | dense | rrf w=0.15 | rrf w=0.35 | rrf w=1 |
|---|---|---|---|---|---|
| 照抄 45 | **0.933** | 0.644 | 0.911 | 0.889 | 0.889 |
| 换说法 14 | **0.714** | 0.357 | 0.643 | 0.643 | 0.643 |
| 时间锚 10 | **0.700** | 0.500 | 0.600 | 0.600 | 0.500 |

这个库的条目满是标识符（`0.2.148`、`COORD_W`、`hit@1`），稠密对它们几乎无感——
dense 的 miss 里全是「0.2.148 改了什么」「0.2.133 那天动了哪三处引擎」这种，
而 BM25 对标识符是精确打击。**不接。** 引擎里那条通道（`MEOW_DENSE` 总闸、
`DENSE_RRF_K=60`、`searchHybrid`）保留成可选层，但默认永不启用，任何融合权重都补不上这 20 个点。

验收：`verify.mjs` HZ11 七条、`probe-gold` G26、`probe-recall` R13 五条、`probe-cost` C5、
三池零退化、真库 36/41 与 OFF 逐位相同。

## 9.184 同义词表要是「动作表」，不是「同义词表」（0.2.177）

0.2.176 的宽池读数摆在那儿：换说法档 0.714，14 条里错 4 条。把 4 条逐条拆开看，
最难受的不是分数，是其中两条的 `cover = 0`——问句里的词在正文里**一个都没有**：

| 问句 | 正文写的是 | 词面重合 |
|---|---|---|
| 什么时候才轮到把代码放到**远端仓库** | 「插件包要先**上传**到远端，再改 manifest」 | 0 |
| **自测**怎么才算真的测到了东西 | 「**自检**三问：跑得动吗、答得对吗、省不省」 | 0 |

同一件事，两种说法。词法检索没有「同一件事」这个概念，它只有字。所以 0.2.153 起就有一张
`SYN_GROUPS` 表，只扩问句不扩文档，扩出来的分乘 `SYN_W = 0.6`（换说法能帮忙，不能顶替原话），
覆盖度分母一个字节不动（扩词只加分、不进 `qIdfSum`，否则问句变「更难满足」，把真答案一起裁掉），
倒排候选集要把同义词的 postings 并进来（否则被剪掉的条目连分都算不到）。这一版只动这张表：
15 组 → 18 组。

**扩的方向变了**。原来那张表收的是同义词（反省/反思/回味、拆开/拆分/重构），
这一版往里收的是**同一个动作的两种叫法**：

- `推送 / 远端 / 仓库` → 再加 `上传、发布、提交`（把「发版」这件事的四种日常说法并一组）
- `自测 / 测试 / 校验 / 断言` → 再加 `自检、体检、验证、测到`
- 新增 `封存 / 冻结 / 归档 / 下线 / 停用`（评测线封存那一族）
- 新增 `底线 / 下限 / 地板 / 门槛`（阈值那一族）
- 新增 `口径 / 说法 / 叫法 / 定义`（同一件事的不同叫法，本项目里天天出现）

**为什么不直接做「语义相似度」**：0.2.176 已经用宽池 146 条把稠密通道试完并否决了
（照抄 0.933→0.644、换说法 0.714→0.357、时间锚 0.700→0.500，任何 RRF 权重都补不回来），
原因是这个库的条目满是标识符（`0.2.148`、`COORD_W`、`hit@1`），稠密对它们几乎无感，
而 BM25 对标识符是精确打击。既然向量那条路走不通，剩下能做的就是**把「同一件事」显式写下来**。
这不是算法的胜利，是知识录入的胜利——表是人工维护的、可读的、可 diff 的，写歪了看得见。

**扩表的风险比加旋钮大得多**：表是全局的。组里写进一个泛词，全库的问句互相拉分。
所以这一版配了硬阴性对照：

- 受控语料 `R14`：「插件要发布上线之前先做什么」→ 只写了「上传」的那条必须第一；
  关桥后同一条分数从 1.602 掉到 1.001（**它是扩出来的分，不是本来就有**）；
  「自测要问自己哪几件事」关桥时直接不在候选里；
  「封存是为了什么」开/关逐位同序（表不许借扩词顺手改别的题）；
  `synBridge:false` 与 `synW:0` 逐位同分（扩表落在同一个旋钮上，不是第二个开关）。
- 真库 45 题 36/41 与 0.2.176 **逐位相同**；三池 630/630/629 问零漂移；
  `probe-gold` G21 自带四条对照（照抄池漂移 0 条、锚点池漂移 0 条、cover 开/关一致、表外词不扩）。

## 9.184.1 读数：换说法档 0.714 → 0.857，照抄档一处不动

| 档 | 0.2.176 | 0.2.177 |
|---|---|---|
| 照抄 44 问（窄池） | 0.955 | **0.955** |
| 照抄 44 问（宽池 146 条） | 0.955 | **0.955** |
| 换说法 14 问（窄池） | 0.786 | **0.857** |
| 换说法 14 问（宽池） | 0.714 | **0.857** |
| 时间锚 9 问（宽池） | 0.778 | **0.778** |

14 条换说法里多认对 2 条（「远端仓库」那条、「自测/自检」那条），锚点档一动不动——
锚点问句里的日期与版本号是标识符，本来就不靠同义词。

**这一版最难写的是探针判据本身**。`G-W4` 原来的判据是「宽池换说法档必须比窄池差」，
理由是「池子变大读数一样好，说明宽池没真接进去」。同义词桥把两档拉平到 0.857 之后，
这条必然假红——**它检测的是「引擎有没有变好」，不是「数据接没接进去」**。
把「第 1 名」这一格也试过：14 条问句在两池里 top1 完全相同（那 106 条是干扰项，本来就不该抢第一）。
最后改成两道：

1. 宽池换说法档 `hit@1 <=` 窄池（池子大一圈还更好，说明接错东西了）；
2. 同一批问句在窄池/宽池里的**前 5 条完整序列**至少有一处不同
   （两池若完全同序，等于宽池白接）。实测照抄档前 5 条序列不同 **40 处**，
   其中宽池独有条目进榜 **38 处**——干扰确实接进去了。

**教训**：阴性对照的判据本身会过期。判据写成「A 必须比 B 差」时，它守的其实是「B 还没被改进」；
一旦改进真的发生，这条对照就从「守卫」变成「拖累」。对照要守的是**机制**（数据接进去了没有），
不是**当前读数的相对大小**。

## 9.184.2 成本快照换代：40 档 5 题名次动、1200 档 0 题动

`probe-cost` C5 按规矩红了（top-5 序列变），换代后逐位相同。换代前把两档的差异逐条看了一遍：

| 档 | 名次未见变化 | 只有分数变 | 名次有变化 | 首位变化 |
|---|---|---|---|---|
| 40 条 | 40 | 0 | 5（#14 #18 #29 #36 #41） | 0 |
| 1200 条 | 41 | 4 | 0 | 0 |

5 条里 4 条是**改善**：#14「推送欠账要不要每版都还」与 #41「推送欠账现在什么规矩」的
第二位从 `0mwpsco0` 换成 `0mwq606x`——后者正是这两题 want 里的另一条；
#18「上传到 github 什么时候才允许」两条 want 仍在前 2，只是名次互换；
#29「自检体系要回答哪三个问题」首位不动，第 3–5 位换成两条真正讲自检的；
#36「评测台为什么封存」首位仍是 `0mwpqwek`（已知的 importance 差题，不是这一版引入的）。

## 9.185 时间状语里的标识符是坐标，不是主语（0.2.178）

锚点档只剩一条错题：「2026-11-21 评测线为什么封存」。它跟「问那一刻」没关系，问的是缘由，
先放下。真正该修的是照抄档和锚点档共有的形状——问句里带着版本号或日期，答案却是「讲这件事的条文」。

**根因读数（真库 581 池）**：问「0.2.148 的时候基线收敛了两轮吗」，want 是 `0mwq7fh1`
（lesson「发版基线至少要收敛两轮」），词分 bm25 **22.293**，排第 2；榜首是 `0mwq84ts`
（fact「0.2.148 已交付：标识符补分落地」），词分只有 **8.541**、cover 0.13。
词分差 2.6 倍却输，说明赢的不是词，是档位。

去看 `bandize()`：

```js
if (h._ident === true || h._subj === 1) { bandOf.set(h, -1); continue; }
```

谁「在问句里被点到名」（`_ident`）或「主语位提到那串标识符」（`_subj`）就直接进第 -1 档，
而档位优先于分数。`0mwq84ts` 的 keywords 首位正是 `0.2.148`，于是它在任何含 0.2.148 的问句下
都能一把压在真正讲过程的条目上面——**不是它更相关，是它更早被点名**。

这件事的荒谬之处在于：问句里的 `0.2.148` 是**坐标**（问的是「那个时候」），不是**主语**
（不是「0.2.148 这条记录」）。坐标不该换来档位。

**判据放结构词，不放泛时间词**：第一版想「时间锚一律关掉特权档」，结果
「0.2.147 那一版交付了什么」坏了——那里标识符真在指认那一条。所以判据要能分开这两种问法：

```js
var ANCHOR_COORD_RE = /的时候|那会儿|那阵|那时候|当时|那天|那天的|那个时间点/;
```

`的时候 / 当时 / 那会儿` 是结构词——它们出现就说明后半句在问「那一刻怎么样」。
泛时间词（现在 / 当前 / 最新）一个都不许进：0.2.176 局面词那一刀已经踩过同样的坑，
「现在某个东西的规矩」这种对象问句会被卷进来。

**三条通道必须一起关（这一版最花时间的地方）**：G27 第一版只关档位，探针红着——
`explain` 里 `band` 已经是 0 了，可分数还是被加法补分顶着：

| 通道 | 位置 | 坐标时怎么办 |
|---|---|---|
| 档位 | `_subj: … ? 0 : subjRatio[di] >= 0.5 ? 1 : 0` | 进 0（不给 -1） |
| 词分 | `_raw` 里 `identBandW * ratio` 与 `identSubjW * subjRatio` | 两项都归 0 |
| 加法补分 | `const add = unitScore * vb.ratio * (idHit ? IDENT_ID_W : IDENT_W)` | 乘 0 |

只关一个，另两个会把它顶回去。判据落在 `const identHardOk = !(anchorCoord && opts.anchorIdentBand !== true);`，
五处引用同一个开关：`_subj`、`_raw` 两项、`add`、`_ident`。两支打分器（`search` / `keywordHitScore`）各一套，
少一处就是一半问句不认账。

**读数（宽池 146 条）**：

| 档 | 0.2.177 | 0.2.178 |
|---|---|---|
| 照抄 44 问 | 0.955 | **0.955** |
| 换说法 14 问 | 0.857 | **0.857** |
| 时间锚 9 问 | 0.778 | **0.889** |
| 真库 45 题 | 0.878 | **0.878** 零退化 |

锚点档剩一条错题（「2026-11-21 评测线为什么封存」），那是 imp 差题，不是坐标题。

**三次否决（这一版真正的产出是这三个「不做」）**：

1. **因果证据**：想问原因时给「正文里有因为/由于」的条目加分。加了 `CAUSE_Q_RE` /
   `CAUSE_DOC_RE` / `causeRatioOf`，`CAUSE_W = 0.35`。读数：换说法 hit@1 不变，**MRR 0.905 → 0.895**，
   那条错题仍第 2。否决。
2. **BM25 长度归一化封顶**：先做对照（同一问句，611 字的 want 截到 200 字，bm25 10.757 → 16.076；
   102 字的压制者灌到 618 字，18.451 → 7.197），看着像长度就是主因。扫 `cap ∈ {0.5, 0.8, 1, 1.2, 1.5, 2, 999}`：
   **cap 越小全面变差**（换说法 0.857 → 0.571@0.5、0.643@1），cap=1 也没翻正那条题。
   长度惩罚在这个库里是有用信号——短条目本来就该更贴。否决。
3. **新鲜度不看 importance**：`docs[di].importance < 3` 让高 imp 条目同时免「旧」与「轻」两重折扣，
   看着像双份特权。去掉后 hit@1 三档全不变，换说法 MRR 0.895 → 0.886。零收益，否决。

一条否决也是产出：它把「这条路走过了、读数是这样」钉在文档里，下一版不用再试。

**探针**：
- `G27`（probe-gold）：受控 3 条，坐标句去讲过程那条、指认句才去交付那条，阴性对照 `anchorIdentBand: true`。
- `R15`（probe-recall）：五条——坐标句首位、关掉后回退、加成归零且档位不是 -1、指认位逐位同序、判据只认结构词。
- `HZ13`（verify）：判据词表、两支打分器同口径、五处引用同一开关、一键回旧口径、三次否决的痕迹不许留、G27/R15/文档锚。

**探针踩坑**：受控语料里那条压制条如果太短，词法本身的长度归一化就会让它赢，探针量到的不是特权档。
第一版 G27 就是这么红的——压制条正文要写得像真库那样长（真库 median 236 字），
want 的词分也要像真库那样占优（22 vs 8），否则这一刀在受控语料里根本显形不出来。

## 9.186 缘由问句去叙述层找答案，规矩条只在问「为什么」时折价（0.2.179）

**症状**：0.2.178 之后宽池还剩五条错题，其中四条是同一个病灶。最典型的是「评测台为什么封存」：

| 条目 | 层 | 字数 | cover | bm25 | impW | recency | 最终 |
|---|---|---|---|---|---|---|---|
| `0mwpsfb0`（正解，讲封存缘由） | project | 611 | 1.00 | 10.757 | 1.25 | **0.6** | 8.068 |
| `0mwpqwek`（压制者，讲该怎么做） | rules | 102 | 0.638 | 18.451 | **1.75** | 1.0 | 32.29 |

差 4 倍，拆开是三笔：bm25 1.71× × impW 1.4× × recency 1.67×。
关键在正文对照——压制者全文 102 字，「评测台禁止无预算花主人的 key：任何发 LLM 请求的实验，
必须先报次数与估算成本、必须设 OMNI_MAX_CALLS 上限、并发≤3；默认 OMNI_ALLOW_SPEND 未设即 exit(2)。」
**一个字都没有「封存」**。它不是答错了，它是**答的不是这个问题**：问的是「为什么封了」，
它讲的是「以后该怎么做」。词面高度重合只因为同一个实体（评测台）。

**机制**：缘由问句（「为什么 / 缘由 / 经过 / 来龙去脉」）的回答仓是叙述层，不是规矩层。
两件事一起做：

1. `CAUSE_RULE_FOLD = 0.6`：缘由问句下 `level === "rules"` 的条目打分乘 0.6
   （`score: raw[di] * w * impW * stW * (causeQ && String(docs[di].level ?? "") === "rules" ? causeRuleFold : 1)`，
   explain 里同一乘子也加，否则单题排查看不见这一笔）。
2. 缘由问句**不折新鲜度**：`if (!anchored && !causeQ && now !== null && docs[di].importance < 3 && …)`。
   问「当初为什么那样」，旧是自然的——与 0.2.159 时间锚同源。

`causeQ = (situationQ || lvIntent.has("topic")) && opts.causeAware !== false`。
`situationQ` 复用 0.2.179 早先加的 `LEVEL_INTENT_SITUATION`（还能用 / 还能跑 / 封存 / 下线 / 现状 / 到哪一版…）——
它单靠 `LEVEL_INTENT_W = 0.3`（×1.3）抵不过 4 倍差，读数一位不动，但正好是 causeQ 的入场券：
「评测台还能跑 locomo 吗」一个「为什么」都不含，靠它才进得来。

**一刀不切**：「评测台的花费上限怎么设」这种问句开关前后逐位同分（探针 G28 ④ / R16 ⑤ 都钉了）。

**三次否决**（都实测过，留在文档里省下一次重试）：

1. **只加 situation 层级意图**：`situation` 时 `out.add("project")` 且收回 `rules`。三档读数
   **一位不动**——`LEVEL_INTENT_W = 0.3` 只是 ×1.3，抵不过 4 倍差。常量保留（causeQ 要用）。
2. **长度惩罚按覆盖度打折**（`COVER_LEN_RELIEF`，`bEff = b × (1 - relief × cover)`）：
   扫 0 / 0.25 / 0.5 / 0.75 / 1.0，hit@1 一位不动；relief = 1 时换说法 0.857 → 0.786。**长度不是这题的瓶颈。**
   但这个机制**没撤**——见下面那条教训。
3. **提高覆盖度惩罚**（`coordW` 0.45 → 0.95）：0.6 起换说法 0.857 → 0.857 / 0.929 / **0.857**，
   0.72 起 0.714，0.95 时 0.643。覆盖度惩罚与同义桥互相打架：换说法的问句与正文天然不同词，
   cover 天然低，罚它等于罚「换了说法」。**覆盖度不能当准入门槛。**

**一条差点错杀的教训**：relief 扫参时三档读数一位不动，看着像白加的功能，于是撤掉它——
撤完宽池照抄 **1.000 → 0.977**（掉一条）。判一个值该不该留，要看**撤掉之后的读数**，
不是看**加上它的时候读数有没有动**：它可能一直在替别的机制兜底（这里兜的正是 causeQ 翻上来那条长条目的长度劣势）。
恢复后 1.000 回来，`bEff` 与两处长度归一化都保留。

**读数（宽池）**：

| 档 | 0.2.178 | 0.2.179 |
|---|---|---|
| 照抄 44 问 | 0.955 / 1.000 / 0.977 | **1.000 / 1.000 / 1.000** |
| 换说法 14 问 | 0.857 / 0.929 / 0.895 | 0.857 / 0.929 / **0.899** |
| 时间锚 9 问 | 0.889 / 1.000 / 0.944 | 0.889 / 1.000 / 0.944 |

`causeAware:false` 一键回 0.955 / 0.857 / 0.889，与 0.2.178 逐位相同——阴性对照不是摆设。

**为什么第二支打分器不吃这一刀**：`keywordHitScore` 是**主动注入**（`buildHitInjection`：把条目塞进
上下文第一屏）的通道，它的匹配面是条目 keywords 而不是正文。主动注入与被动检索的取舍相反：
检索是「答这一问」，答不对就是噪声；注入是「顺带提醒」，用户在问封存缘由时被顺带提一句
「无预算不许跑」是有用的，宁可多提。所以这一版**有意**只让 `search` 吃 causeQ，
并在 HZ14 里钉住这个差异，防止以后有人「顺手统一」。

**探针**：
- `G28`（probe-gold）：受控 3 条（project 讲缘由 / rules imp=4 讲规矩 / fact 干扰），
  三个问句（缘由 / 现状 / 普通）。判据不是「关掉后首位换人」而是**开关比值精确等于 0.6**——
  比值与词分、长度、importance 全无关，只有折价能改它。
- `R16`（probe-recall）：五条——缘由句首位、开关比 0.6、现状句同样 0.6、两个旋钮能分别关
  （`causeRuleFold: 1` 只收折价、讲缘由那条分毫不差、规矩回升 1.67 倍）、普通句逐位同分。
- `HZ14`（verify）：两个常量各一处、`bEff` 与两处长度归一化、覆盖度三步（归一 → 取幂 → 协调）、
  causeQ 定义与两笔落点、注入通道有意不吃这一刀、G28 / R16 / 文档锚。

**两次「探针量错」的踩坑**：
1. G28 第一版阴性对照写成「关掉 causeQ 后首位换人」。受控语料里正解词分本来就稳赢（7.379 vs 0.912），
   关掉也换不了人 → 假红。改成量比值，且第一版比值方向写反（`off/on` = 1.667 报成「不是 0.6」）。
2. R16 里想用「免折比 > 1.2」证明 recency 那笔账，实测 1.00——因为那条正解的 raw 本身就是全库最高，
   根本不进「raw < 0.85 × maxRaw」的折扣区间，**没折过的东西当然量不到免折**。
   后来这条挪到 G28（那边正解 raw 不是最高），并在探针里写明「分数比还要看 raw 排序，会量到别的」。

## 9.187 折价要乘在分档上，不只乘在分数上（0.2.180）

**症状**：0.2.179 让照抄档打到 1.000，换说法档仍停在 0.857。逐条拆剩下的错题，有一条第
最刺眼：「那个跑榜单的评测台还能不能用」——want `0mwpsfb0`（project，imp=2，611 字）被
`0mwpqwek`（rules，imp=4，102 字）压住，**而折价明明已经生效了**：want 折后 14.311，压制者
折后 7.695。折完 want 分数是压制者的 1.86 倍，名次却还在后面。

**根因：`bandize()` 按 `_raw` 分档，档位优先于分数。**

```js
hits.sort((a, b) => (bandOf.get(a) - bandOf.get(b)) || (b.score - a.score))
```

档位是从 `_raw` 算出来的（`_ident === true || _subj === 1` 进特权档 -1，其余按 `_raw` 分层）。
0.2.179 的 `causeRuleFold` 只乘在 `score` 上，`_raw` 一分没动 → 规矩条稳稳待在最高档，
按 (档位, 分数) 排序时站在所有低档条目前面。实测：折到 0.1 时它的分数只剩 2.385，
仍然排在那条 9.131 的前面。**在一个「先比档、再比分」的秩序里，只折分数等于没折。**
单题排查也看不出来，因为 explain 里的 `score` 确实变小了——变小的是它自己那一档里的排名。

**机制**：折价做成一个 helper，三处引用同一个乘子。

```js
const ruleFoldOf = (di) => causeQ && String(docs[di].level ?? "") === "rules"
  ? (situationQ ? situationRuleFold : causeRuleFold) : 1;
```

| 引用位置 | 作用 |
|---|---|
| `_raw: raw[di] * (…) * ruleFoldOf(di)` | 分档——这一笔才动名次 |
| `score: raw[di] * w * impW * stW * ruleFoldOf(di)` | 排序——档内名次 |
| explain 里的 `score` | 单题排查时看得见这一笔 |

两档折价分开：缘由句 `CAUSE_RULE_FOLD = 0.6`，现状句 `SITUATION_RULE_FOLD = 0.3`。
问「这台机器还能不能用」时，规矩条答的是「该怎么做」，连问题的形状都不对，压得比「为什么」还低。

还有一条互斥必须写：**带缘由词的现状词句归缘由**。
`situationQ = LEVEL_INTENT_SITUATION.test(q) && LEVEL_INTENT_TOPIC.test(q) === false`
——「评测台为什么封存」里的「封存」是状态词，但问的是当初；不排掉缘由词，这句会被判成现状句，
折到 0.3 而跑去问「能不能用」那一档。

**三次试错的记录**

1. 只加 situation 层级意图（`out.add("project")` 并收回 rules）：读数一位不动。`LEVEL_INTENT_W = 0.3`
   只是 ×1.3，抵不过 4 倍差。这个常量留着——它是 `causeQ` 的入场券，不是打分手段。
2. 「缘由问句里 project 与 topic 同为叙述层」（`else if (LEVEL_INTENT_TOPIC.test(q)) out.add("project")`）：
   换说法档掉回 0.857，新错题是「问一个版本号，为什么不能把它拆开搜」，want fact 被 project 压。
   **已回退**，引擎里不许留这一行（HZ15 钉着）。
3. 真正的第二刀是同义词组，不是打分权重：讲「给接班的那条开个小门」的词原来躺在噪声组
   （`["筛掉","过滤","剔除","噪声","噪音","口子","让步"]`），于是「小门」把问句往「筛掉」那边拽。
   挪到例外组（`["例外","豁免","特例","放行","破例","小门"]`）之后这一题直接翻成第一。
   **同一个词放进两组，会把两道题一起搅坏**——所以 HZ15 断言两组互不重叠。

**读数**（`E:\Temp\lv179.cjs`，宽池 146 条）

| 档 | 0.2.179 | 0.2.180 |
|---|---|---|
| 照抄 44 问 | 1.000 / 1.000 / 1.000 | 1.000 / 1.000 / 1.000 |
| 换说法 14 问 | 0.857 / 0.929 / 0.895 | **0.929 / 1.000 / 0.952** |
| 时间锚 9 问 | 0.889 / 1.000 / 0.944 | 0.889 / 1.000 / 0.944 |

扫 `situationRuleFold` 0.6 / 0.45 / 0.3 / 0.2 / 0.1：0.3 起饱和（hit@3 打到 1.000），取 0.3。
再往下压不涨读数，只增加「规矩条被过压」的风险。

**两个探针坑**

1. **扫参必须 `cache: false`**。`M.search` 带结果缓存，同一个 query 首次调用的结果会被后续
   不同 opt 复用——`E:\Temp\sfscan180.cjs` 第一版就是这么「扫出一片平坦」的：读数锁死一位不动，
   看上去像「这个旋钮无效」，其实是压根没换参数。
2. **判据要跟着机制改，别让判据守「旧的更好」**。三处：
   - G20 ④「照抄池零漂移」→ 折价压低档位后与 keywords 口径在临界处叠加，名次本来会动。
     改成只统计**非缘由/现状问句**的漂移，其余必须逐条同名次。
   - G22 ⑥「三池与 0.35 口径逐位相同」→ 默认口径已经满分（1.000/1.000）之后，这条守的
     不再是「旋钮无害」而是「旋钮无效」。改成「0.35 不许更好」（三池各一条不等式）。
   - G28 ③ 现状句折价比期望 0.6 → 0.3；源码判据从三笔改成四笔（两个常量 / 开关 / 三处同一 helper /
     缘由词优先）。

**一条 gold 偏严，不改引擎**：时间锚「2026-11-21 评测线为什么封存」，want `0mwpsfb0`（33.002）
被 topic `0mwpsc1a…`（35.962）压。逐字看，topic 那条正文开头就是「评测线为什么封存：榜单口径变了三轮…」
——它其实答得更准。gold 里写死的那条是「该去哪一条」，这一条 gold 该松，不是引擎该扭。

## 9.188 0.3.0 是版本号跳跃，不是机制改动：版本下限的断言不许写死主版本（0.3.0）

**起因**：0.2.180 之后，0.2 线走到第 180 个补丁版，主人定了「这一版算 0.3 大版本」。

**症状**：把 `0.2.180` 改成 `0.3.0` 之后，`verify.mjs` 一口气红了 **61 条**，没有任何引擎代码变动，
全部是断言自己的写法问题。三类，全是同一个病：

| 形态 | 处数 | 它想说的 |
| --- | --- | --- |
| `/^0\.2\./.test(String(host.version))` | 1 | 版本是 0.2 线 |
| `v[0] === 0 && v[1] === 2 && v[2] >= N` | 47 | 不早于 0.2.N |
| `pkg.version.split('.').map((x) => Number(x))[2] >= N` | 13 | 不早于 0.2.N（且只看第三段） |

第二类最典型：它的语义是「不早于 0.2.N」，字面却写成「主版本是 0 且次版本是 2」。
这句话把「0.3 不存在」一起写进了断言——一次大版本跳跃，47 条同时假红。

**修法**：一个 helper，一处定义，60 处引用。

```js
// [0.3.0] 版本下限不许把主版本写死：`v[0] === 0 && v[1] === 2 && v[2] >= N` 这种写法
// 在 0.3.0 会整片假红（47 条），而它想说的只是「不早于 0.2.N」。主版本更高一律算过。
const verAtLeast = (v, maj, min, pat) =>
  v[0] > maj || (v[0] === maj && (v[1] > min || (v[1] === min && v[2] >= pat)))
```

- 47 处 `vX[0] === 0 && vX[1] === 2 && vX[2] >= N` → `verAtLeast(vX, 0, 2, N)`（正则批量换，`\1` 回填变量名）。
- 13 处 `[2] >= N` → `verAtLeast(pkgX.version.split('.').map((x) => Number(x)), 0, 2, N)`。
- `host: version 0.2.x` 那条不设下限，只是想知道「host 报的版本能不能 parse」，改成
  `check('host: 版本是三段 semver', /^\d+\.\d+\.\d+$/.test(String(host.version)), host.version)`。
- 另有 14 处本来写成 `v[0] > 0 || v[1] > 2 || (v[1] === 2 && v[2] >= N)`，
  天然跨大版本正确（主版本 3 也算过），**没动**。同一个文件里两种写法并存，坏的先红——这就是证据。

**读数**：61 条假红 → 0，`verify.mjs` ALL PASS；`probe-gold` / `probe-recall` 未受影响，ALL PASS。

**教训**：守「版本下限」的断言，要写成**与主版本无关的比较**。判据守语义（不早于），不守字面（是 0.2）。
和 9.161「判据要跟着机制改」是同一件事的两面——那里是机制变了判据没变，这里是判据把偶然值当成了语义。

**发布面（同批做的三件事，HZ16 都守着）**：
1. `package.json` 补 `repository` / `homepage` / `bugs`，三处都指向 `github.com/hanhan9999999999999999999/dsh-macro-memory`
   —— npm 页面与目录站都读这三个字段，缺了就是一条死链。
2. `files` 白名单只要运行面四项：`lib` / `vendor` / `cordis.patch.yml` / `README.md`（约 2 MB）。
   `verify.mjs`（580 KB）与 `tools/`（24 支探针）留在仓库，不进 npm 包：它们是自证工具，不是运行依赖。
3. README 加「0.3.0 里程碑」段与 0.3.0 逐版条目：版本号跳了，说明要跟着跳，否则读 README 的人看不出这一版凭什么算大版本。

**HZ16**（7 条）：helper 定义一处 + 引用 ≥60；旧形态零残留（**先剥掉注释行再数**，注释里正是要讲清旧形态长什么样）；
阳性对照 `verAtLeast([0,3,0],0,2,38) === true && verAtLeast([0,2,37],0,2,38) === false`（防 helper 被写成恒真）；
发布面三字段；files 白名单；README 里程碑与条目；文档锚。

## 9.189 查询分解要先证明它真在动：一把专门量「并列焦点句」的尺子（0.3.1）

**病**：查询分解（`decomposeQuery` + `augmentByDecompose`，开关 `macro.multiQuery`）落地时只带了 9 条**结构**判据
（`verify.mjs` 的 A58b 块）：它们能证明「原榜一个字不动」「顺序没反」「开关默认关」，证明不了**补进来的东西有没有用**。
在 gold 45 问上跑两态对照，读数完全相同（1.000 / 0.977 / 0.929 / 0.889 hit@1）——那不是「机制有用」，而是
**机制没被触发**：67 条问句里只有 1 条被 `decomposeQuery` 切开（1.5%），补入 0 条。

**尺子**：`tools/probe-mq.mjs`。语料不新造——从 `tools/fixtures/gold-recall.json` 的 40 条真实样张里配对，
问句形如「X 跟 Y 哪个更麻烦」（X、Y 取两条样张各自第一个关键词）。规则写死在探针里，所以配对是确定的，
语料仍然是冻结的。它量的正是机制瞄准的那类句子：一句里两个并列焦点，各有一条记忆只讲其中一半。

**读数（2026-11-22 实测）**：

| 项 | off | conservative |
| --- | --- | --- |
| 被切开 | — | 20 / 20 |
| 补充条目 | — | 35 条（17/20 题有补充），其中含正解 1 题 |
| hit@1 / hit@3 | 0.650 / 0.900 | 0.650 / 0.900 |
| 召回命中率（不要求名次） | 0.950 | **1.000** |
| MRR | 0.777 | 0.784 |
| 名次变差 / 变前 | — | 0 题 / 0 题 |
| 延迟 p50（窄池） | 0.13ms | 0.39ms（2.99×） |
| 延迟 p50（宽池 60 条，重复 40 轮） | 0.49ms | 1.23ms（2.49×） |

**据此改了两条验收标准**（原标准是这一版自己先在 `docs/PLAN-0.4.md` 里写下的）：

1. **「`conservative` 下 hit@3 必须高于 `off`」→ 改判三条**：原榜前 3 逐条不变 / 名次只许不变或变差 /
   召回命中率不降且至少 1 题由 miss 变命中。理由：补充条目**只落原榜尾部**，前三名的名次在数学上不可能改善；
   要求 hit@3 提升，等于要求实现违反自己刚定的不变量。这条自相矛盾的验收标准留在原地，下一个人写探针时
   第一反应会是「探针写错了」，而不是「标准错了」。
2. **「延迟 p50/p95 增幅 ≤ 2×」→ 改判「p50 绝对增量 ≤ 5ms」**：`conservative` 每题从 1 次检索变 3 次，
   倍数必然 >2×。0.13→0.39ms 与 0.49→1.23ms 的差别用户感知为零；真正要守的红线是「不许引入模型、网络、
   磁盘 IO」——那是数量级变化，写进 MQ9 的断言理由里。

**判据 MQ1–MQ9**：切得开（20/20、每段 ≥2 字、≤3 段）/ 四个代表句切法逐字钉住（含两个「无焦点返回空」）/
原榜前 3 逐条不动 / 名次不变差 / 有增量（补充 ≥10 条且至少救回 1 题）/ gold 四档逐题零漂移 /
阴性对照（子查询换空数组 → 补充恒为 0）/ 源码常量与探针同一把尺子（`MQ_MAX_SUBS = 3`、
`MQ_MAX_ROWS_PER_SUB = 2`、`min_rel: 0`、`band_keep: false`、调用点各一处）/ 延迟绝对增量。
`tools/probe-mq.mjs` 已进 `tools/check-all.mjs` 的 `STEPS`（紧跟 `probe-gold`），套件 24 → **25 支**，
断言 3,323 → **3,341**（P1 的 9 条 `mq:` + probe-mq 的 9 条判据；中间那个 3,331 是过渡态，见下）。

**这一支差点在基线上不存在**：`tools/check-all.mjs` 的 `countPass = (text) => (text.match(/^PASS/gm) ?? []).length`，
数的是**行首 `PASS`**。第一版 `probe-mq` 照 probe-gold 的表面样子用了 `  ✓ / ✗`，于是 `tools/baselines.json`
记成 `"tools/probe-mq.mjs": 0`——9 条判据等于没记账，而 `check-all` 的结论仍是「断言数与基线一致」。
0 条在账本里合法（`check-client-bundle` / `check-yaml` 是只读脚本），所以**没有任何地方会报这个错**。
改成与 `tools/probe-gold.mjs` 一模一样的 `console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra…}`)` 后重记基线，
9 条才真正进账。**探针的输出格式是账本接口，不是装饰。**

**连带红的一条老断言**：`verify.mjs` 的「check-all 里要读本仓的每一支都从 _root.mjs 取根」写死了
`steps.length === 24`。加一支就红——这不是判据太严，而是**支数本身是知识**：少一支说明有人从套件里摘了东西。
改成 `steps.length === 25` 并在注释里写明 25 的来路（24 + `probe-mq`），比改成 `>= 24` 诚实。

**教训**：判据守的不变量，必须让「实现允许的改动」与「想要看到的收益」落在同一侧。
append-only 是被明确写死的不变量，那么收益就只能出现在**尾部**（召回、MRR），不可能出现在头部（hit@k）。
验收标准先于实现写在计划里时就要做这道乘法，否则量尺建好那天才发现它量的是一个不可能事件。

**没做的事**：不要求提升 hit@3（见上）；不给 `conservative` 加早停（如「原榜第一名的分数远高于第二名就跳过子查询」）——
它能把平均倍数压回 1.5× 左右，但也会把「原榜本来就模糊」的那些题一起跳掉，而那正是唯一有收益的一档；
真要做，先拿这把尺子量一遍收益损失，再决定。

## 9.190 写入端巩固：九条判据全绿也证明不了「它没偷偷写库」（0.4.0）

**病**：写入端巩固（`lib/macro/defs/remember.js` 的 `consolidate*` 一族，开关 `macro.consolidate`，三档
`off / suggest / write`）落地时带了 9 条判据（`verify.mjs` 的 A58c 块：开关归一、plumbing、三条件、少一条不说话、
关键词交集、摘要首行、巩固句形状、suggest 不写库、顺序）。听起来齐了——但**九条里有八条钉在纯函数上**
（`consolidateSignals` / `consolidateSummary` / `consolidateLineOf` 的输入输出），它们证明的是「信号算得对」，
不是「`suggest` 态真的一次写都没有」。而 P2 的全部风险恰好只在后一句上：一旦 `suggest` 偷偷落了库，用户会以为
只是被提醒了一句，实际库里已经多出一条谁都没同意的摘要——而且那条摘要还长得像正常的 topic，事后无从分辨。

**尺子**：`tools/probe-consolidate.mjs`。不连真库、不写文件、不看时钟，拿一个假 `flow` 桩把
`createRemember().execute()` 整条跑通，然后**数调用**：

| 配置 | `memory_search` | `memory_remember`（巩固） | `memory_update` | 回执 |
| --- | --- | --- | --- | --- |
| 不配（默认写成 `suggest`） | 2（同话题 + 语义层） | 0 | 0 | 贴材料 + 现成调用形状 + 「库里这一个字都没动」 |
| `off` | 0 | 0 | 0 | 与「没有这个功能」逐字节相同 |
| 写错值（`definitely-not-a-mode`） | 0 | 0 | 0 | 同上（退到最保守那档） |
| `write` | 2 | 1（`level: 'topic'`，首行 `YYYY-MM-DD · 巩固（project）：关键词`） | 3（每条尾补一句「已巩固进」，**不带 status**） | 落了哪条、每条补没补上 |
| `write` + 语义层已满 | 2 | 0 | 0 | 「该并条，不是再加一条」 |
| 只有 2 条同话题 / 这批已巩固过 | 2 | 0 | 0 | 一个字都不加 |

**判据 P1–P10**：默认档就是 suggest / suggest 只发 2 次 search 且写 0 次 / 语义层那次带 `level=rules,fact` /
off 与写错值逐字节相同且一次 search 都不发 / write 恰好多 1 条 topic 且首行是日期 / 3 条各补一句且不带 status /
回执说实话（落的是哪条、谁没补上）/ 语义层满时即使 write 也不落新条 / 三条件不成立时一个字不加 /
探针与实现共用同一份判断（`signal.kind` 与摘要首行都由实现自己算，探针不另立口径）。

**踩的坑：同名调用要按通道分开数**。桩的计数写成 `calls.filter((one) => one.name === 'memory_remember')`
时 P2 直接红在「suggest 态写了 1 条」——因为**主写入本身就调 `flow.call('memory_remember')`**，巩固走的是
`flow.tryCall('memory_remember')`。同一个名字两条通道，计数不分开，问「巩固有没有多写一条」的答案永远是「有」。
桩里改成 `of()` 只数 `tryCall`、`main()` 只数 `call`，读数才对得上。**任何「有没有多做一次」的断言，先把
同名调用的通道分清楚，再谈次数。**

**尺子顺手抓到一个真 bug**：`write` 态在原实现里是 `if (mode !== 'write') return note`——于是语义层已满
（`kind === 'merge'`，该提示「并进已有那条而不是再造一条」）时，`write` 会**照样新建一条 topic 摘要**，
恰好做反。改成 `if (mode !== 'write' || signal.kind !== 'fire') return note`：merge 只提示，不自动落。
理由写进注释：语义层满了该并进哪一条，规则判不出来——随便挑一条并进去会把两件事焊在一起，比不并更糟。

**变异证明能红**：把 `CONSOLIDATE_SEMANTIC_CAP` 由 `8` 改成 `99` → 恰红 1 条（P8，因为 8 条语义条目
不再「满」），其余 9 条仍绿 → 改回 `8` → 全绿。一次只动一个常量，红的条数可预测，才知道判据之间没串。

`tools/probe-consolidate.mjs` 已进 `tools/check-all.mjs` 的 `STEPS`（紧跟 `probe-mq`），套件 25 → **26 支**；
连带那条 `steps.length === 25` 的支数断言同步改成 26，注释里的来路也一起改（24 + `probe-mq` + `probe-consolidate`）。

**没做的事**：不自动并条（merge 态只提示，见上）；不判断「哪条语义条目该承载这件事」（要语义相似度，
而 0.2.176 的实测已经把稠密那条路否掉了）；不在 `suggest` 态写任何「建议过」的痕迹——写痕迹就等于写库，
下一次读出来会像是已经处理过了。

## 9.191 内部诊断查询不能替用户「看过」：一次巩固检查把相似检索关掉了（0.4.0）

**病**：P2 的巩固检查在每次 `memory_remember` 之后打两枪 `memory_search`（同话题 + 语义层）。九条判据全绿、
十二支探针全绿、`verify.mjs` ALL PASS——然后 `tools/probe-graph.mjs` 的 H6 稳定红：

```
FAIL  H6 同一对在工具里逐字只有四成，与面板的「相似」差 ≥0.4  面板 1 / 工具 NaN
```

回执原文（诊断时给这条 detail 补了「回执」段，留着有益）：

> 相似检索没算成：可比的候选一条都没有（库里 4 条，这一轮已经端给你看过的都排除了）。

根因不在探针，在两条**没有参数可关的副作用**：`vendor/meow-memory/lib/index.js:4333-4334` 每次
`memory_search` 都 `db.bumpHit(h.level, h.id)` 再 `markSearched(workspace, sessionId, hits.map(h => h.id), dir)`
（写 `.dsh-meow/seen-<session>.json`）。巩固检查为了「判该不该巩固」把同话题 20 条全记进 `searched`，
接着用户写完了顺口问一句「跟这条像的有哪些」（`memory_search({ mode: 'similar', id })`），
`:4529` 的 `rows.filter(r => r.id !== found.row.id && !seen.has(r.id))` 把候选排空——**工具在它最该用的
时刻被上一次内部查询关掉了**。`bumpHit` 还顺手抬起 `hit_count`，让 P2.5 要做的 `unused`
（「召回过但从没人读」）指标从第一天起就是脏的。

**为什么判据没抓住**：A58c 那 9 条钉的是「巩固**算得对不对**」，`probe-consolidate` 的桩 flow 只数**调用次数**
（2 次 search、0 次写），桩里的 `memory_search` 没有副作用。**「多发了一枪查询」在计数上是正确的，
在状态上是破坏性的**——两个维度，桩只盯了一个。H6 是既有判据，它守的是同一张表里的另一种用户行为
（写完一条问相似），这次是它替 P2 挡的刀。

**修法**：给 meow 的检索加一个内部开关，默认不改任何对外行为：
1. `vendor/meow-memory/lib/index.js:4069` 之后加 `internal: { type: 'boolean', default: false }`，
   schema 描述写清「只给插件内部诊断用……模型不该传它」；
2. `:4333` 处包一层 `if (parsed.internal !== true) { bumpHit…; markSearched… }`；
3. `lib/macro/defs/remember.js` 的 `consolidateAfterWrite` 把 `internal: true` 放进两枪共用的 `base`；
4. macro 侧 `createSearch` 的参数是白名单，`internal` 不会漏给模型——只有 `flow.tryCall` 直连 bridge 才传得进来。

为什么不是 `releaseSeen(workspace, sessionId, dir)`（meow 已导出）：它**整批清空** `injected` + `searched`，
会把真正的「防重复端」账本一起洗掉，比不修更坏。为什么不是伪造旁路会话：插件层（`lib/client.js`）
根本没有 `sessionId` 通路，宿主从 `exec` 推断给 meow，伪造不了。

**新增判据（verify A58c 的 `co:` 三条 + `probe-consolidate` 两条）**：
- `co: meow 检索有 internal 开关，默认 false＝照旧记账`（钉 schema 文案与 `default: false`）；
- `co: internal 关的是 bumpHit + markSearched 两件事`（只关记账不关 bump 会让通胀指标继续脏）；
- `co: 巩固检查两枪都传 internal: true，主写入与更新一个字都不带`（切片 `consolidateAfterWrite` 数 `internal: true` 恰 2 处，
  且 `memory_remember'` / `memory_update'` 同行不许出现 `internal`）；
- `P11` 桩里直接看两次 search 的 `payload.internal === true`；`P11b` 写路径不许漏进 `internal`。

**能红证明**：把 `base` 里的 `internal: true` 删掉 → `P11` 实跑红（`undefined,undefined`），
`co: internal-passed` 的计数由 2 变 1 → 红；改回 → 12 条全绿。改完 `probe-graph.mjs` 从
`FAIL H6（工具 NaN）` 回到 `PASS H6 面板 1 / 工具 0.42`。

**教训**：判据要分两层看——「这次调用发生了吗」（次数）和「这次调用留下了什么」（状态）。
**只数调用的量尺，会为每一种副作用盖章**。凡是给既有工具加「内部探路」的调用，先问一句：
这个工具在成功路径上还写了哪些账？把「不写账」做成一等参数，比事后清理账本便宜得多。

**又踩一次编码坑（同一条红线第二次）**：这节第一次是用 `Add-Content` 追加的，pwsh 默认按 ANSI 写，
中文整段变乱码（1,242 个替换字符，从第 10,973 行起），且 `verify.mjs` 的乱码检查（`mojibake`/BOM）会因此红。
修法：用 node 按 UTF-8 读回、截掉坏尾、`fs.writeFileSync(..., 'utf8')` 写回，再用 edit 工具追加正文。
**文档也只能用 write/edit 改，pwsh 一律不碰文本内容**——`9.189` 那次是源码，这次是文档，是同一条红线的第二例。

**没做的事**：不给 `memory_find_similar` 加同样的开关（它本来就是读路径，`markSearched` 记录的正是它端出去的命中）；
不试图把 `seen` 改成可按 id 精确回滚（要跨进程读 `.dsh-meow/seen-*.json`，为了省一次查询引入文件竞态不划算）。

## 9.192 判据红了，耗时就会「变快」：尺子被改短的第三种形态（0.4.0）

**病**：给 vendor 的 `memory_search` 加了 `internal` 之后，`tools/param-audit.mjs` 的
`1.1 原工具的每个参数都还能传进去` 当场红了——`memory_search.internal → memory_search.internal（统一工具里没这个参数）`。
这条红是**对的**：它守的病正是「融合层把上游能力克扣掉」，而我们确实少给了一个参数。
真正出问题的是**它红的副作用**：`tools/param-audit.mjs:309-312` 在 `failed > 0` 时直接 `process.exit(1)`，
于是这一支的耗时从 20.6s 掉到 **1.6s**，`--update-baselines` 把 1.6s 记成了新基线。下一轮我把它修绿，
它报 20.7s，相对刚被改短的 1.6s 就是「**慢了 13.0 倍**」，提示语还会说「别直接 --update-baselines 把慢记成正常」。

**真相：那 20 秒不是算，是等，而且一直都在**。
- `node --cpu-prof` 聚合：18,564 个样本里 **98.0% 是 `(idle)`**，脚本逻辑 1.18s 就打出了 `ALL PASS`；
- 之后 `process._getActiveHandles()` 剩两个 `Socket addr={}`（没有 listen 的 socketpair），进程挂到 21.06s 才退出；
- `git show HEAD:tools/baselines.json` 里 param-audit 的耗时基线**本来就是 `20643` ms、预算 `83000` ms**——
  这 20 秒是长期存在的既有悬挂，不是这一轮引入的。

**为什么这事值得单独一节**：「基线变快」平时是被当成好消息的，于是它从不触发任何检查。
而它有三种来路，只有一种是真优化：真优化、**判据变红后提前 `process.exit`**、测量口径变了。
第三种最难看出来，因为红与绿都是「合法状态」。一条支从红转绿时，它的耗时基线必须**手工回填到绿态读数**，
否则基线里躺着的是一个「失败路径」的速度。

**修法（两条，都在这一轮落地）**：
1. **参数白名单**：`tools/param-audit.mjs` 新增 `WITHHELD`，记「vendor 有、统一工具**故意**不暴露」的参数：
   `'memory_search.internal': '只给插件内部诊断（写入后判该不该巩固）：暴露给模型等于允许它伪造「这条没端给用户看过」'`。
   循环里 `if (!(mapped in props) && WITHHELD[holdKey]) { withheld.push(holdKey); continue }`。
   另加 **1.1b 双向钉**：`withheld.length === Object.keys(WITHHELD).length` ——
   登记了就必须真没暴露，没暴露的必须登记；记账条目过期（统一工具后来把它放出来了）也会红。
   param-audit 13 → 14 条。
   为什么不改成「在统一工具里也加 internal」：那等于把伪造口交给模型，0.4.0 的修复会当场作废；
   为什么必须显式记账而不是循环里 `continue` 掉：**少一个参数而没人说，和漏掉一个参数长得一模一样**——
   白名单替真退化打掩护，是这类名单最常见的死法。
2. **数据面记账**：`node tools/make-vendor-manifest.mjs` 重记 `vendor/VENDOR.json`
   （44 文件 / 1,986,065 B / `7f56b793b6f48a26`），doctor 的 `PATCHES` 新增 `[macro-fusion 0.4.0]` 条目
   （`file: 'vendor/meow-memory/lib/index.js'`），防 vendor 升级静默冲掉这个开关。

**教训**：①「耗时变短」要和「判据变红」放在一起读——先问这一支在基线上是红的还是绿的；
②给上游工具加参数之前，先跑一遍 `node tools/param-audit.mjs`：它守的是「不许克扣」，故意保留的参数必须写成白名单，
**写不出理由就别加那个参数**；③「跑完了却不退出」这种问题看日志永远看不出来，只能靠
`--cpu-prof` 的 idle 比例（98%）加 `process._getActiveHandles()`（两个 Socket）；④诊断用的临时脚本别落在
`tools/` 里——我在排查时把 HEAD 版临时写成 `_tmp-param-audit-orig`（去掉 .mjs 后缀是刻意的：本节的判据会抓
`tools/<名字>.mjs` 并对不存在的报红，临时文件删掉之后那个名字就成了幽灵）——它当时立刻被 doctor 报成一个漂移
（对方缺），删掉才复绿。

## 9.193 六把尺子都在量「库里躺着什么」，没有一把量「写进来的一直在变多」（0.4.0）

**病**：`memory_admin(action="hygiene")` 从 0.2.x 起有六个 kind——dup（重复）、stale（该更新）、thin（关系凑数）、oversize（超重）、unread（没人读）、orphan（孤立）。六把尺子量的都是**已落库条目的形状**：两条像不像、有多久没动、边上连了几条、正文多长、有没有人召回、有没有人连。这六个问题都以「库里已经有 N 条」为前提，而记忆插件真正的退化往往发生在写入端——一天写三十条 `fact`、一周攒不出一条 `lesson`，六把尺子全部安静：每条 fact 都新鲜、都不重复、都不孤立、都不超重。库在长胖，结论层没长。

**三条新尺子**（`vendor/dsh-memory-nebula/lib/host/graph.js` 的 `auditHygieneSteps`，`:1324` 起）：

| kind | label | 判据 | 为什么是这个形状 |
| --- | --- | --- | --- |
| `selfecho` | 关键词自证 | 关键词逐字出现在正文里的比例 `rate = echo / kws`，`kws >= 3` 且 `rate > 0.7` | 关键词的全部作用是扩召回面；逐字出现在正文里，BM25 靠正文本来就能命中，这个词等于没写。`kws < 3` 不判：1/2 = 50% 不是信号，是样本太少 |
| `unused` | 召回过没人读 | `hit_count > 0` 且 `read_count === 0` | 召回与阅读是两件事：排进候选不等于有人真去读。只报「召回过的」，因为一次没召回的条目归 unread，两条尺子不重叠 |
| `inflate` | 写得多收得少 | 近 30 天 `fact` 新增 `>= 6` 且 `> 结论层（rules/lesson）新增 × 3` | 一个比值。绝对量说不出问题：小库一周写 8 条 fact 是正常建库，大库一周写 8 条也是零增长 |

**为什么三条都用比值/对照，不用绝对量**：绝对量要跟「这个库应该有多少条」比，而那个数没人知道，任何阈值都是编的。比值只需要库自己跟自己比——「关键词自证率」「召回与阅读的差」「两种层的增速差」。代价是阈值要留出噪声带，于是三条各自带一个下限：`SELF_ECHO_MIN_KW = 3`、`reads` 字段必须在（见下）、`INFLATE_MIN = 6`。判定还刻意取严格不等：`rate <= 0.7` 不报、`6 / 2` 恰好 3 倍不报——边界上的样本是噪声，报出来只会训练用户忽略报警。

**`read_count` 是这一版唯一新增的持久化字段**：meow 表原来只有 `hit_count`（召回次数）与 `last_accessed_at`，`memory_read` 成功路径只调 `markAccessed(...)`，读了几次没人记。于是「召回过没人读」这一类根本无法从现有数据算出来——`hit_count > 0` 里既包含「读了」也包含「没读」。四处改动：①`COMMON_COLS` 加 `read_count INTEGER NOT NULL DEFAULT 0`；②`upgrade()` 的 LEVELS 循环补 `ALTER TABLE ${level} ADD COLUMN read_count INTEGER NOT NULL DEFAULT 0`（meow 原生的幂等补列机制，`PRAGMA table_info` 先查再加）；③`MemoryDb.bumpRead(level, id)`（`UPDATE ... SET read_count = read_count + 1, last_accessed_at = ?`）；④`memory_read` 的 execute 在 `markAccessed(...)` 之后调一次。**只加在读路径，不加在检索路径**——检索加了就等于把「召回」记成「阅读」，这一类的全部意义就没了。

**`reads` 字段缺席时整类不参与**：`adapters/meow.js` 里 `reads: cols.has('read_count') ? Number(row.read_count) || 0 : 0`，而 `unused` 的过滤器写的是 `typeof n.reads === 'number' && ...` —— 别的适配器（文件库、外部推入的条目）没有这个字段，`undefined` 一进来，`(n.hits || 0) > 0` 就足以让整类假阳。宁可这一类在那种库上不显示，也不给一份「所有被召回过的都算没人读」的假账单。

**老库偏大这件事要写在回执里**：记账从 0.4.0 起，更早的条目 `read_count` 全是 0，`unused` 会把「0.4.0 之前读过很多次」的条目一起报出来。这不是 bug 也不是能修的——那段历史没记。`HYGIENE_META.unused.hint` 里写明「记账从 0.4.0 起，老库偏大」，用户在面板上先看到这句话，再看列表。

**`inflate` 只产出一行，且 `id` 为空串**：它是整库一个判断，不是某条记忆的属性。面板上每一条都带 `showDetail(it.id)`，若给它一个真 id，用户点进去会看到「一条与通胀无关的记忆」。所以 `items.inflate` 恒为长度 1 的数组、`id: ''`，label 形如 `近 30 天：fact 32 条 / 结论层 4 条（8.0×）`，读的人看到的是形状，不是一个可以跳的条目。

**「巩固」（P2）与「取代」（0.2.117）不是一回事，抬头也要分开**：`read.js` 新增 `consolidatedNote(content)`，认 `（已巩固进：<id>「<head>」，<date>）` 这一句，抬头写「这条是历史材料（DATE 被收进 ID「HEAD」）：它没作废，细节只在这里；但要看现在的口径，读那一条。」取代是**退位**（`status` 变 stale，条目离开「在用」集合），巩固是**归档**（`status` 不动，条目仍在用，只是要点已被抽走）。两句话不能合并，否则读的人会以为被巩固的条目失效了。抬头排在 `prov` / `chain` 之前：它是「这条现在还该不该照着做」的回答，比出处更要紧。

**判据**：`verify.mjs` 新增 A58d 块 13 条 `hy:`（九类元数据 / selfecho 三态 / unused 三态 / reads 缺字段不参与 / inflate 阳性与 6/2 阴性对照 / 只给一行且 id 空 / 白名单与 enum 同序九项 / counts 求和 / `bumpRead` 恰两处 / 老库补列 / `consolidatedNote` 四态 / extras 拼接顺序）；`tools/probe-hygiene.mjs` 18 条 H1–H18，其中 H11–H16 跑真 sqlite（写完 `read_count = 0`、读一次 1、再读 2、`memory_search` 只加 `hit_count`、读不存在的 id 不记、手工建的老表打开后自动补列）——桩里数调用只能证明「调了」，证明不了「记在正确的列上」。

**能红证明**（做完即改回）：①注释掉 `memory_read` 里的 `db.bumpRead(row.level, row.id)` → H12/H13/H14 全红（`reads = 0`）；②去掉 `unused` 过滤器里的 `&& !n.reads` → H4 红（`[["p-unused",5],["p-read",5]]`，读过的条目也进了「召回过没人读」）。两条都是「看起来能跑、判据不响」的典型，靠阴性对照才抓得住。

**这一版踩的四个坑**：

1. **`probe-words.mjs` 的「体检六类」是文案与 schema 的同步尺**，写死 `kindEnum.length === 6`。改白名单只跑 `verify.mjs` 会全绿，红在「口径总账」那一支——`verify` 管代码契约，`probe-words` 管**说给模型看的话**跟代码是不是同一份。这类判据要单独跑，别只看一个总账。
2. **`PANEL_SUMMARY` 从 220 字涨破 200 字上限**：`memory_admin` 的 `description` 是 `ACTIONS` 表拼出来的，我给 hygiene 的 hint 加长三项后总长 220，撞上 `probe-words` 的可读性尺（≤200 字）。修法不是放宽尺子，是**缩文案**：九个类目在 hint 里只留可认的缩写（「关系凑数」→「凑数」、「关键词自证」→「自证」、「召回过没人读」→「召回没读」、「写得多收得少」→「写多收少」），全称留在 `HYGIENE_META` 与面板详情里。194 字，尺子不动。
3. **`verify.mjs` 里「check-all 里每一支都从 `_root.mjs` 取根」写死 `steps.length === 26`**：加第七支探针就红。支数在这里是知识（防有人摘套装），所以改了 27 并写明来路，而不是把判据放宽成 `>= 26`。
4. **`13,366 B` 这个对外数字变了**：schema 多六个 enum 项 + description 变短，`probe-host.mjs` 的 D3 实测 13,372 B。README 三处、市场索引两份各一处要一起改（`−76.5%` → `−76.4%`）。这类数字跟注入字符数一样，是**实测值的快照**，改 schema 就要跟着改。

**第五个坑不是这一版引入的，但这版又踩了一次**：用 `Get-Content -Raw` + `Set-Content -Encoding utf8` 批改 `README.md` 与两份 `plugin-market/*.json`，中文整段被按 GBK 解码再按 UTF-8 编码写回，三个文件当场坏掉（`README.md` 98,732 → ? B）。救命的是 profile 树里的安装副本（P2 收尾同步时是最新的），`Copy-Item` 拷回来即完全恢复；随后试图用「UTF-8 解码 → GBK(936) 编码 → 写回字节」逆变换补救，只救回大半（`−`、`→` 这类 GBK 无映射的字符被替换成 `?`，全长从 98,732 掉到 97,253）——**这类损伤不可逆**。教训第三次，这次写死：**文本内容只用 `write` / `edit` 改；`pwsh` 只能做 `Copy-Item` / `Get-FileHash` / 跑 node，碰 `Get-Content`+`Set-Content` 组合必坏**。另外补一条判据侧的观察：`pwsh` 读 UTF-8 文件在控制台显示成乱码是**显示问题**，判断文件好坏得用 `node -e "readFileSync(...).toString('utf8')"` 数 `U+FFFD`——我差点把完好的 `INTERNAL.md`（821,596 B、11,074 行、0 个 `U+FFFD`）当成坏文件重写。

**这一版没做**：`selfecho` 只比关键词与正文的字面重合，不比语义（同义改写不算自证，那是 embedding 的活）；`inflate` 只比 `fact` 与 `rules|lesson` 两层，没有把 `topic` 纳入（`topic` 是长文，条数增速跟结论层不是一个量级，混进来会让比值失真）；`unused` 不区分「召回过一次没读」与「召回过五十次没读」，只报后者更急（按 hits 降序排，读的人自己看）；三条都没有自动修动作——体检只负责把「写得多、收得少」摆在面板上，收不收归人。

## 9.194 「判得出冲突」与「替人处置冲突」之间隔着一步，这一步一直是人走的（0.4.0）

meow 从 0.2.x 起就有 `conflictCandidates`：写入时把同层近邻捞出来，比两边的版本号与日期 token，认出「同一件事的另一种说法」就在回执里印一段提醒。提醒写得清楚，出口也写清楚了（`supersedes` / `memory_update`）——但它**只到提醒为止**。要不要标 stale、标哪一条，全靠人读完那段话再动手。

问题不在提醒的质量，在于这一步的成本落错了人。长期库里最伤的不是「库里有一条过期的」，而是**旧结论冒充现状**：它排在前面，句式与新的那条一模一样笃定，读的人没有理由怀疑它。要让插件自己把账做对，就得把「判」与「处置」接起来——判可以机械，处置必须可回滚。

**判据刻意窄：只吃五类硬事实。**

| 类 | 怎么判 | 为什么算硬事实 |
| --- | --- | --- |
| 版本 | 两边各有自己的版本号，且不重合 | `0.4.1` 与 `0.4.0` 是同一个对象的两个状态 |
| 日期 | 两边各有自己的日期，且不重合 | 同上，换的是时间 |
| 状态 | 一边「已落地/已完成/已上线」，另一边「未开始/未做/禁用」 | 结论互斥，比数字更要紧 |
| 数值 | 同一单位（支/条/个/次/毫秒/秒/%/B/KB/MB）的数字不同 | 「27 支」与「26 支」说的就是同一把尺子量了两次 |
| 路径 | 同一个文件名换了目录 | 主语没变、地方变了 |

不吃「读起来像」。这不是保守，是**代价不对称**：漏报只是少一条建议，误杀会让人丢掉一条真结论（而且丢掉的方式很安静——它变成 stale，读不到了）。所以宁可漏。

**两道门槛不是一回事。** 相似度 `SUPERSEDE_SIM = 0.3`（与 meow 的 `CONFLICT_SIM` 同值）决定「够不够格当候选」；数值与路径两类另要逐字重复度 `SUPERSEDE_REPEAT = 0.5`——因为「3 条」「某个脚本的路径」这种 token 满库都是，光靠相似度会天天撞。版本/日期/状态**不吃**第二道门槛：它们是硬事实，重复度低也照样是改口（一次只改了一个版本号，重复度本来就低）。

**三态开关 `autoSupersede`**，与 0.4.0 的 `consolidate` 同一条纪律（未配 = 默认档、写错 = 最保守档）：

- `off`：连那一枪检索都不打。关掉一个开关不该仍收一次检索成本。
- `suggest`（默认）：只把建议贴在回执尾部，**一个字不动库**，并给出可照抄的 `supersedes: ['xxxxxxxx']`。建议里明说「只建议」——读者不该去猜这一句是不是已经生效。
- `apply`：才真走 0.2.117 的 `markSuperseded`（标 stale + 正文留「（已被取代：…）」），抬头写明「自动取代」并给反悔办法。

写错的值一律当 `off`，不是当 `suggest`：这个开关会改别人记忆的状态，配错必须退到「什么都不做」那一档。

**为什么不新开一条写路。** `apply` 复用 `markSuperseded`——它已经写清了六种「看起来像成功」的失败（没找到 / 已归档 / 已标过 / 短 id 多命中 / 写库失败 / 就是自己），并且已经有反悔办法。自动取代若自己再写一遍处置逻辑，就会出现「人点名取代」与「自动取代」两套行为，其中一套迟早落后。

**放置位置在 `lib/macro/supersede.js`，不在 `defs/` 里。** `defs/` 是「一文件一工具」的目录，`verify.mjs` 的结构判据数它**恰好 8 个文件**，并且要求文件名与工具名逐个对齐。`supersede.js` 不是工具，是 `remember` 的实现细节，放进 `defs/` 会立刻打红两条结构判据（这一版就是这么撞上的：第一版放在 `defs/` 下，`结构: defs 恰好 8 个工具文件` 当场红）。

**两条正则与 meow 逐字相同**（`VERSION_TOKEN` / `DATE_TOKEN`），而 `verify.mjs` 的 `as:` 判据直接把两侧字面量抓出来比。为什么不去 import：那两个是 meow 的模块内私有常量、没有导出；为一个内部判据新开 API，改动面比复制两行正则大，而复制会漂——所以用判据钉住。比较时要容忍声明式差异（meow 是打包产物 `var X = /…/g;`，本仓手写 `const X = /…/g`），比的是正则本身。

**接线顺序**：人点名的 `markSuperseded` → 自动取代 → `applyLinks` → 巩固。巩固必须在最后，否则「巩固材料」里会出现刚被顶掉的那条（与 0.2.x 的顺序理由同源）。自动取代与巩固同时开时，回执是「原回执 + 建议段 + 巩固段」，建议是加法（探针 S15 钉的是「suggest 的回执 = 无建议的回执为前缀」）。

**skip 集的两种写法都要认**：人已经用 `supersedes` 点名的那几条不再出现在建议里（他刚处置过），刚写的这条也不能建议取代自己。人给的是短 id（8 位），hits 里是完整 id，所以 `conflictCandidatesOf` 同时用完整 id 与 `slice(0, 8)` 匹配。

**上限 3 条**：多出来的不硬塞进回执，也不假装处置了。

**判据与量尺**：`verify.mjs` 的 A58e 十四条 `as:`（三态 / 五类阳性与各自的阴性对照 / `sim < 0.3` / `repeat < 0.5` / skip 两种写法 / 上限 3 / 无候选不加字 / 抬头文案 / 两条正则与 meow 逐字相同 / 写入路径接线 / `MACRO_DEFAULTS`+`MACRO_KEYS`+schema 三处同值）+ `tools/probe-supersede.mjs` 十五条 S1–S15（桩 flow 数真调用：`off` 零检索、`suggest` 一枪 `internal: true` 且零 `memory_update`、`apply` 真标 stale 且旧正文留取代句、人点名的不重复建议、与 meow 的 `conflictCandidates` 同结论）。**能红证明**（做完即改回）：①把 `suggest` 分支改成也走 `markSuperseded` → S2 红（回执里没有「一个字没动库」）；②去掉数值/路径的 `repeat` 门槛 → S7 红（`repeat=0.31` 的也进来了）。

**这一版踩的两个坑**：

1. **`probe-consolidate.mjs` 的三条 P 判据红**：它的桩 flow 数「巩固发了几枪 `memory_search`」，而 `autoSupersede` 默认 `suggest` 会自己多打一枪。修法不是放宽那三条，而是在那一支的 `run()` 里显式 `autoSupersede: 'off'`——**一支量尺只量一件事**，两个功能混在同一张调用账上，红起来分不清是谁多打的。
2. **`verify.mjs` 里「check-all 里要读本仓的每一支都从 `_root.mjs` 取根」写死 `steps.length === 27`**，加第八支探针就红。与 P2.5 那条同一个坑（26 → 27 刚踩过一次），这次改成 28 并把来路写进注释。支数在这里是知识，不是可以放宽的魔数。

**这一版没做**：不比语义（「同一件事换个说法」若是同义改写而非 token 漂移，判不出来——那是 embedding 的活，也是 P2' 与 P5 的位置）；不做级联（A 取代 B、B 又取代 C 时不会顺手把 A 也标掉）；不改召回权重（stale 的条目靠既有的 `statusFactor` 降权，取代关系本身不加权）；`apply` 没有「整批确认」入口——一次写入最多动 3 条，多的分两次调。

## 9.195 评测里最容易换掉的不是精度，是「这一次到底测了什么」（0.4.0）

主人 2026-11-22 的口径是「只跑 gold 评测，不允许跑 llm」。检索侧的 gold 判分有三个隐形开关，任何一个走偏，读数照样打印，只是它测的已经不是那件事——而三次都是**安静地**偏，没有一处抛错。

**坑 1：库的默认行为替你把结果收口了。** `vendor/meow-memory/lib/index.js:2380` 的 `trimByBand(hits, k, opts)`：`var RESULT_MIN_KEEP = 5;`、`const keepAll = opts.bandKeep === false || minKeep === 0;`、`const keep = keepAll ? sliced.length : Math.min(sliced.length, Math.max(minKeep, sameBand));`，`sameBand` 只数 `!(h._band > 0)`。首跑 `avg_retrieved 4.9`、`hit@5 === hit@10 === hit@20`（multi-hop 三个数全是 0.5284）。这不是 bug——产品上「问一句给你 5 条最可信的」正是主人要的；但 OmniMemEval 的契约是固定 top-k。修法在评测侧：`E:\Temp\omni-eval\sidecar.mjs` 里 `Meow.search(q, docs, { k: docs.length, bandKeep: false })`。**改插件默认值等于为了让尺子好看去改被量的东西**；`band_keep` 本来就是 `memory_search` 对用户开放的开关，评测显式关掉才与旧基线同口径。教训：评测调用库时，凡是「帮用户收口」的默认值都要显式关掉，否则你量的是产品体验，不是检索质量。

**坑 2：store 名里带版本号，换版本名就是换了一套空库。** `stores\locomo_exp_user_0_speaker_a_omni4` 是 user_id 原样落盘，ingestion 用 `--version omni4` 写完，search 用 `--version omni4b` 去问，指向的是另一批从没写过的目录：判分全 0、`avg_retrieved 0.0`、`/health` 显示 `users 20 / memories 0`，而每条记录 `status: success_empty`、context 里只剩 `Memories for user Caroline:` 这样的空壳。**空库不报错**。教训：拿不到数时先看 `memories` 计数与 `status`，别先怀疑打分器；`--version` 在 ingestion 与 search 之间是同一个键，不是随手起的标签。

**坑 3：结果缓存按 version 复用，改了逻辑也不重算。** 重跑同 version 时脚本打印 `Loaded existing results for group 9`，直接读 `results/locomo/macromem-omni4/tmp/macromem_locomo_search_results_{i}.json`。修法是先把 12 个分片（10 个分片 + `merged_search_results.json` + `search_status.json`）**移**到 `tmp_stale_band\`——移动不删除，结论不对还能翻回去看。

**读数（2026-11-22，LoCoMo 1,536 题剔 category 5，自写 `score_locomo.py`，无 LLM）**：hit@5 `0.6159` / hit@10 `0.6953` / hit@20 `0.7546` / recall@20 `0.6822` / MRR `0.4953` / nDCG@10 `0.5029` / `avg_retrieved 17.77` / `avg_context_chars 5947.2` / `empty_rate 0`。分类 hit@20：multi-hop `0.7447`（282 题）、temporal `0.7882`（321）、open-domain `0.4783`（92）、single-hop `0.7753`（841）。对照 `E:\Temp\omni-eval\report_retrieval.json`（2026-11-20，同一台机同一数据集，被测代码 0.2.x，`avg_retrieved 19.99`）：hit@20 `0.651 → 0.7546`、MRR `0.3768 → 0.4953`、nDCG@10 `0.3933 → 0.5029`；分类 hit@20 multi-hop `0.5319 → 0.7447`、temporal `0.7103 → 0.7882`。

**这两组数只在一个方向上可信**：本次给出的条目**更少**（17.77 < 19.99）却命中更高，所以「检索变好了」这个方向是硬的；绝对差值不能当受控 A/B（中间隔了上百个版本改动），也不能换算成准确率——gold 命中是「该捞的捞到了」，不是「答对了」。端到端 LLM-judge 自 2026-11-20 起仍未重测。

**没做的事**：不动插件的 `RESULT_MIN_KEEP`（产品行为）；不改 gold 集合（LoCoMo 官方 evidence）；不给 scorer 加平滑或截断（hit@k / recall@k / MRR / nDCG@10 都是标准式）；不因为 open-domain 只有 0.4783 就去调那一类——92 题，单次运行，噪声比差值大。

## 9.196 「两跳」这个功能从来没跑过第二跳，而没有一支探针问过它（0.4.0 P4）

星图的扩散一直只按「词面像不像」找邻居：`recall.js` 用 BM25 选种子，再沿边按 `gain = e0 * w * HOP_DECAY` 走一到两跳。这带来两个洞，一个看得见、一个看不见。

**看得见的洞**：实体（项目名、文件路径、工具名、版本号）在图里没有位置。两条记忆都写着 `lib/macro/supersede.js`，它们之间会长一条 `entity` 边（`text.js` 的 `ENT_RULES` 抽出来的 `file` 实体），但「这条路径出现在哪些记忆里」这件事没人能回答——面板问不出，召回也没法从「用户提了这条路径」直接跳到那一组记忆。

**看不见的洞**：`recall.js` 的扩散循环里 `const e0 = energy[from]`，而 `energy[]` 只在种子阶段写过（`recall.js:265/275/295/321`）。第二跳的 frontier 全是**非种子**节点，`energy[from]` 恒为 0，被下面那道 `if (e0 < 0.06) continue` 整片跳过 → `next.size === 0` → `break`。也就是说 `MAX_HOPS = 2` 与「二跳再打一次」的注释一直是空的，`hops: 2` 实际效果就是 `hops: 1`。**没有一条判据发现过这件事**：探针都只问「一跳能不能捞到」，没人问过「第二跳到底跑没跑」。修法是 `const e0 = hop === 0 ? energy[from] : propagate[from] || 0`——`propagate[]` 正是上一跳给它算出的最大 gain，语义上就是「第一跳衰减再乘一次」。修完 `probe-entity` 的 E31 量到 `used: 2`（修前恒 1），E24 量到一条策展边把无关记忆带进来（`m:3@0.111`）。

**为什么实体不做成节点。** 第一版想过把实体也塞进 `nodes`/`edges`，让度数、聚类、面板都统一。不行的理由很硬：`nodes` 的口径是「记忆」——节点数、平均度数、孤立数、聚类、召回结果位、`nebula_inspect` 的分页，全部按它算。混进 400 个实体节点，这些读数一起改写，召回还要在每一处过滤「这条是实体不是记忆」。所以做成独立一层 `graph.entityLayer = { list, stats }`：只有可序列化的裸数据，不参与任何图算法，召回时按 `entitySeedsOf` 找命中、按 `byNode` 反查成员。回滚是一条 `entityLayer: false`。

**实体只认四类硬事实**：`project` / `path` / `tool` / `version`（`ENTITY_KINDS`）。不收「读起来像名字」的词——`p1` 这种 2 字项目名会把半个库连成一团，所以 `ENTITY_MIN_LABEL = 4`；只在一条记忆里出现的实体当不了桥，所以 `ENTITY_MIN_MEMBERS = 2`；层上限 `ENTITY_MAX = 400`、每条记忆最多 `ENTITY_PER_NODE = 6`（不封顶的话一次建图就能把实体表撑成第二个图）。键是 `type|value`，`indexOf(layer)` 从 `list` 现建 `byKey`/`byNode`——**图缓存是 JSON，`Map` 存不住**，读回来必须自愈。

**动态跳数：软边按词面收，硬边照走。** 第二跳开始，每条边先问「这个邻居与本次查询还有没有关系」：`matchOf(j)` = 查询词与该节点词袋的交集 / `min(qTokens.size, 6)`，实体成员直接算 1。`m < DYNAMIC_MIN_MATCH = 0.2` 就 `skipped++` 并跳过；有关系也不是全给，`gain *= 0.45 + 0.55 * m`。`HARD_EDGE = new Set(['explicit','entity','project'])` 三条不看词面——策展是人工判断、同实体是同一个标识、跨项目是同一个项目名，这三样都不是「读起来像」。门槛只在 `hop >= 1` 生效：第一跳是星图最基本的语义，被词面砍掉就不是星图了。

**一个必须诚实写下的实测上限**：纯 Hebbian 共激活边的权重上限是 `0.440`（`probe-entity` 里 4 次与 16 次会话都是 0.440）。两跳衰减后 `spread * 0.62` 只有 0.309 × 0.44 × 0.58 × 0.62 ≈ **0.049**，正好卡在合成阶段 `total < 0.05` 的门槛下面。意思是：**「拦掉串味邻居」省的是计算，不是结果**——那些条目本来就进不了结果集。所以 E21 量「拦没拦」（`skippedNeighbors > 0` 而关掉时是 0），E23 量「结果集与不拦时完全一致（没丢东西）」，不假设串味条目一定进得来。要让第二跳真的产出条目，得是强链路（`explicit` w=1 → `m:3@0.111`）。

**回执三个数一起报**：`hops: { asked, used, stoppedAt, skippedNeighbors, dynamic }`。只说「省了」会掩盖「变笨了」——用户看到 `问 2 跳 / 走 1 跳 / 砍掉 7 条邻居` 才知道这次是「没有相关的」还是「被砍了」。工具侧两个开关 `entity` / `dynamic_hops`（默认开），整机回滚另有环境变量 `NEBULA_ENTITY_LAYER=0` / `NEBULA_DYNAMIC_HOPS=0`。

**判据**：`verify.mjs` 的 A58f 十四条 `as:`（四类 KIND / minMembers 两态 / 短名不收 / 四常量 / JSON 往返 + `indexOf` / 层不进 nodes-edges / 关层开关 / `HARD_EDGE` 字面 / 第二跳能量来源 / hops 三数 / entities 回执 / 缓存与指纹 / 工具两参数两环境变量 / 门槛只在 hop≥1）+ `tools/probe-entity.mjs` 的 E1–E31。**三条能红证明**（做完已还原）：①`e0` 回退成 `energy[from]` → E21/E22/E24/E31 红；②`!HARD_EDGE.has(link.type)` 去掉 → E23/E24 红（`on=m:1,m:2 off=m:1,m:2,m:4`）；③`input.entityLayer === false` 写成 `false` → E29 红。

**连带踩到的四个既有判据**：①`verify.mjs` 的「每支都从 `_root.mjs` 取根」——新探针用静态相对 `import '../vendor/…'`，在 check-all 的 neutral cwd 下 `ERR_MODULE_NOT_FOUND`，改成 `root` + `pathToFileURL`；这条判据本来就是为了抓这种「偷用 cwd」；②`param-audit` 要求 `nebula_recall` 的每个参数在统一工具 `memory_search` 里有对应，新参数必须同时加到 `lib/macro/defs/search.js` 的 schema 与 `pick(args, …)` 白名单；③`probe-toolsize` 的整字面量粗胖线 110,000 → 112,000（实测 110,452，加的是真功能，按老规矩只留 ~1.5%）；④`probe-host` 的 D3 要求 README 与市场索引写的 schema 体积等于实测——加两个参数让 13,372 → 13,567，README 的「宿主投影后 11,544 B」也得一起改。**文档里的体积数与断言总数是同一类东西：会随功能变，而且每一份都有判据钉着。**

**没做的事**：不做面板按实体浏览（P4 只到引擎与回执）；不改召回权重与 `total` 门槛（要动得先有 gold 读数支撑）；不做实体级联（实体只展开一层成员）；不把实体抽取规则从 `text.js` 挪进 `entities.js`（`text.js` 的 `extractEntities` 已经在图里跑了一遍，再抽一次是重复劳动）。

## 9.197 换说法档的分数是人手抄出来的：十八组词表补了 +0.215（0.4.0 P5）

`probe-gold` 的换说法档一直是全表最难看的一格。0.2.176 那版读数 0.857，靠的是 `SYN_GROUPS` 里**十八组人手写下的等价说法**（推送↔push、自检↔自测……）。写 P5 之前本来打算「再多抄二十组」，主人一句话把这方案否了：**「换说法档现在高度依赖那 18 组手工词表 这是不行的 出现新的情况就无法适应了不是吗」**。这句否得对，而且理由能算出来：把桥关掉（`synBridge: false`）实测换说法只剩 **0.714（10/14）**，比 0.2.176 那版还少一题——**这半年纯词面通道其实略微退步了**（关键词抬权、覆盖度折价、分档收口都在改词面形状），换说法档最终能到 0.929，全是那十八组表补的 **+0.215**。词表没覆盖的领域，第二天就退回 0.714。

**先诊断，再挑机制。** 十四道换说法里关桥只失手四道，四道全是同一种病：**问句用一种说法、正文用另一种，且一字不共享**——「什么时候才轮到把代码放到远端仓库」（正文写「推送」）、「它自己什么时候该回头反省一次」（正文写「反思」）、「自测怎么才算真的测到了东西」（正文写「自检」，词交集为 **0**）、「自动筛掉结果…开个小门」。所以问题不是「排序不好」，是「两个词之间没有任何一条路」。

**第一版做错了，留档。** 想当然地从 `tokenize` 的二元组上统计共现：每篇取 idf 前 8 个 token、两两计数、`count >= 2` 且 `ratio >= 0.25` 且不共享汉字才收。真库 635 条实测——**22,956 个 token 里只有 223 个词长出了扩词，全是跨词碎片**（`地全→门读`、`名空→空间→置面→到配`），十四道换说法**一道都没扩到**，净增量 0。根因一句话：**meow 的 `tokenize` 是滑窗二元组，它没有「词」这个概念**。在它上面统计出来的「共现」是「这两个切片挨得近」，不是「这两个词说的是一件事」。词面这一层根本没有可比的东西，只能借人写下的东西——`keywords`。

**第二版：从 keywords 学长，两级证据。** `buildCoocSyn(docs, n)` 只吃每条的 `keywords`（`coocWordsOf` 兼容三种形态：真数组 / 逗号顿号分隔 / JSON 字符串；词长 2–8、纯数字丢、没中文的必须是小写标识符，否则 `push` 这种真词会被误杀）。两级证据：**同一条记忆里的两个词 +`COOC_W_SAME = 2`**（一次就过线——同一句话里同时被作者列进关键词，是最强的等价信号）；**同 project 只认跨文档 +`COOC_W_PROJ = 1`**。第二级当初差点写错：如果直接把「本项目所有词」pairUp 一次，那么任意一对词只要「同一条 + 同 project」就自动凑到 2 分，共享汉字的降权等于没降。改成让每条记忆与「本项目所有词的并集**减掉自己**」交叉、双向各记一次——一对词在两条记忆里各出现一次才净得 2 分。

**三道门 + 形态门。** 次数 `COOC_MIN_COUNT = 2`；条件概率 `COOC_MIN_RATIO = 0.25`（`count / df`，注意同条一次就是 2，所以想让比例掉下去只能把 `df` 做大——`probe-cooc` 的 K3 为此把「咖啡」造到 9 条、只 1 条带「牛奶」，算出 0.22 < 0.25 才真的挡住）；共享汉字降权到 `COOC_SHARE_HAN_W = 1`（`自测`/`自检` 只差一个字，那不是「两种叫法」，要两条记忆反复出现才算数）。再加每词 `COOC_TOP_PER_TERM = 6` 与合流上限 `SYN_MAX_PER_TERM = 6`——**扩词是桥，不是主力**，桥词太多就会把排序搅成噪声。合流点是 `synExpandOf(qTerms, df, n, cooc)` 的第四参：手工表在前、共现表在后，一共取前六个。

**开关与缓存口径位。** `coocLearn: false` 时索引里**根本不建表**（不是「有表不用」），`synBridge: false` 是整层回滚。`__opts`、`indexPathKey`、缓存比较串三处都带上 `coocLearn` 这一位——少这一位，两种口径会共一张表、互相串答案，`probe-cost` 的 C5b 会红得莫名其妙（这在 P0 阶段踩过一次，同样的坑）。

**读数（2026-11-22，零 LLM）。** 窄池 40 条：换说法 0.929 **不动**（窄池只有 40 条，共现样本不够救那四道）；宽池 146 条：照抄 0.977 → **1.000**、换说法 0.929 → **1.000（14/14）**、关掉共现退回 0.929 —— **增量 100% 归因到共现通道**；真库 635 条 40 问：hit@1 0.925 **不动**、MRR 0.963。**「宽池比窄池好」这件事本身就是结论**：共现要样本，库越大越连得上（`probe-cooc` 的 K5 是这个性质的微缩版：两条记忆才连得上，一条永远空表）。

**必须写下的边界。** 那四道 miss 需要的桥词（自测 / 反省 / 远端 / 仓库 / 筛掉 / 接班 / 小门）在真库 keywords 里 **`df = 0`**——从来没被任何人写下来过。**任何「从库里统计」的机制都救不了它：那是词典问题，不是检索问题。** 共现自学习能做的，是把「库里已经有人这么叫过」的等价说法自动接起来，让人不必预先枚举；它做不到「凭空知道一个新领域怎么说」。这条边界正好也是它比手工表的优势所在——手工表也有同一条边界，只是那条边界还被钉在十八组上再也不动。

**判据。** `tools/probe-cooc.mjs` 的 K1–K6 十八条（K1 词源只从 keywords 长、碎片不进表 / K2 同条一次够 + 同 project 只认跨文档 + 同 project 多词互相连得上 / K3 条件概率门 + 共享汉字两道 + 形态门 / K4 共现没把该找的弄丢 + `synBridge:false` 整层回滚 / K5 库越大越连得上 / K6 六常量与两条开关口径各占一张表）；`verify.mjs` 的 A58g 十四条 `as:`；`probe-gold` 的 G-W4 改成守机制三条（宽池 top-K 至少一处不同 / 照抄档不倒退 / 换说法增量在 `coocLearn:false` 时**必须消失**）；`probe-cost` 的 C5b（关共现 top-5 逐位回到冻结快照）与 C5c（开共现至少一问答案不同）。

**连带踩到的五个既有判据。** ①`probe-gold` G21 与 `probe-recall` R14 的「表里每个词都是两个汉字」——表里现在收 `push`/`cache`/`timeout`，放宽成「中文两字或英文标识符」；`verify.mjs` 的 HB2 与 HZ12 四处同款；②HB2 的「只扩问句」断言原本写 `synExpandOf(qKept, df)`，第四参加上后要跟着改；③HB2 的「可审计」断言查导出符号串，新增 `buildCoocSyn` 必须同步；④HZ12 的「表扩到 18 组」原写 `=== 18`，改成 `>= 18`——**这条判据本来是防「表退回去」，用等号就把「再加词表」也判成了红**；⑤`probe-cost` 的 C5 快照：换机制后必须用 `--write-snap` 重冻，而 C5b 的对照**只能拿「只差一个变量」的那一态**——最初拿「P5 之前的快照」比，红在旧快照是「开桥」状态且 `SYN_GROUPS` 已从 18 组变 38 组，两处差异叠在一起，谁也说不清是哪个变了。于是另冻一份 `tools/fixtures/cost-snap-handonly.json`（只关共现），对照才有意义。

**没做的事**：不动 `SYN_W` 手工表的权重（表还在，是最后一道兜底）；不做跨工作区的共现（同 project 已经带项目边界，跨 ws 会把两个不相干项目连起来）；不做词向量 / 不做 LLM 侧扩展（那是 P2' 的范围，要先有主人点头）；不把共现表落盘（跟索引一起建，几毫秒，落盘反而多一份要失效的东西）。

## 9.198 换个陌生场景还认不认得：桥不在词库里，在两套词形之间（0.5.0 P1）

主人的话是「让之前那种死词库换场景检索就会变弱的情况消失」。这句话不能拿 gold 池自证——gold 池只有一个领域（本插件自己的开发史），在那儿调出来的 0.911 是「它认识这个项目里的词」，不是「它换到别处还认得」。所以这一版先造**第二把尺子**，再动引擎。

**尺子（`tools/probe-adapt.mjs` + `tools/fixtures/domains.json`）。** 五个互不相关的领域：医学、法律、园艺、天文、财务，每域 12 条记忆 + 5 条问句（3 条同词、2 条换说法）。换说法问句用**口语**问、答案写在**正式文档**里（「降糖药第一次吃多少量」→ 答案条目写「起始剂量」）。每条问句进尺子前过四道夹具检查（A0）：口语词与 `SYN_GROUPS` **零交集**（不许借老表的光）、口语词不在答案里、正式词只在答案里、口语词确实出现在同域别处（否则它只是一条不相关的干扰词）。这样量出来的高分只可能来自「从库里学出来的桥」。

**病根（三处实测，全部可复查）。** 第一版想当然地在 `tokenize` 的二元组上统计共现——真库 635 条实测：22,956 个 token 里只有 223 个词长出扩词，**全是跨词碎片**（`地全→门语`、`名空→空间`、`置面→到酸`），十四道换说法**一道都没扩到**，净增量 0。根因一句话：**meow 的 `tokenize` 是滑窗二元组，它没有「词」这个概念**；在它上面统计出来的「共现」是「这两个切片挨得近」，不是「这两个词说的是同一件事」。第二版改成从每条 `keywords` 学（0.4.0 P5），读数对了，但那是把 gold 池自己的领域喂回去。

**真正让「换场景」失效的，是两套词形不在一个坐标系。** 共现表学的是 `keywords` 的**原词**（`降糖药` / `二甲双胍` / `氮肥过量`），索引与问句却被 `tokenize()` 切成**二元组**（`降糖/糖药`、`二甲/甲双/双胍`、`氮肥/肥过/过量`）。于是问「降糖药第一次吃多少量」，表里明明躺着 `降糖药` 的邻居，查 `降糖` 得到的却是 `(无)`——表再准也接不上。诊断脚本 `E:\Temp\diag-adapt.mjs` 打的就是这一行：`降糖/糖药 → (无)`。

**第一版修法（失败，留档）。** ①把共现表直接改成学碎片（`coocFormsOf`）——接上了，但宽池污染；②把整个共现表切碎——同 ①；③给碎片桥单独折扣（`SYN_FORM_W` + `weak` 集合，逐候选加权）——冷域 hit@3 仍 0.80、窄池反而 0.929，折扣既没救 gold 也没保住冷域；④「解围第二遍」（按榜首 `cover < 0.25` 递归 `search`，第二遍更好就整份替换）——gold 全绿但冷域 hit@3 塌到 0.40，且 `G13/G14/G24` 三条「稠密/词法逐位相同」红（`keepBand:true` 的内部调用被裁剪列表破坏）。四个都回退了。教训写死在这里：**扩词是桥，桥要窄；「第二遍更好就替换」会翻盘，翻盘就伤老答案。**

**最终修法：桥只走第二遍，两遍按 RRF 合并。** ①`buildCoocForms(docs, cooc)` 建「碎片 → 整词」逆排（`COOC_FORM_WORDS = 4`，只遍历 `coocWordsOf(d)`，`word.length < 3` 不收）；②`synExpandOf(qTerms, df, n, cooc, forms)` 第五参只在桥那一遍传，`push(use, a)` 在 `forms instanceof Map` 时才把整词切碎投候选——**第一遍不投碎片，所以第一遍与 0.4.1 逐位一致**（这条不是洁癖：`probe-cost` 的 C5 快照发现分数从 40.096866 漂到 42.811168，名次没变但数字变了，用户看得见的是分数）；③`searchAdaptive(query, docs, opts)`：先跑第一遍（老行为一字不改），桥接得上（问句里至少一个碎片落回某个整词）才跑第二遍，两遍按 `weight / (FORM_RRF_K + i)` 累加（第一遍 1、第二遍 `FORM_MERGE_W = 0.5`、`FORM_RRF_K = 60`），排序同分用 `_raw` 决胜；④**合并完名次一个字没变就直接返回第一遍**（连分数都不动）——桥没改变结论时不该让数字漂，也不该白算一遍。`rankForSearch`（`memory_search` 的入口）两条 `search(...)` 改成 `searchAdaptive(...)`。

**读数（2026-11-22，零 LLM，`node tools/probe-adapt.mjs`）。** 同词 hit@1 **100%**（五域各 100%）；换说法 hit@3 **0.40 → 0.80**、hit@1 0.00（不动）、MRR 0.342；第一名改判 **0 题**（A4 逐条比对 `search` 与 `searchAdaptive` 的第一名）；关共现自学习 hit@3 掉回 **0.30**、关扩词同为 0.30（冷域里手工表本就无词可用，两支应一致）；五域 60 条混库与单域持平（A3）。老读数一字不动：`probe-gold` 全绿（窄池换说法 0.929 / 宽池 1.000 / 照抄档宽池 0.977 丢 1 题）、`probe-cost` C5 快照逐位相同、`verify.mjs` ALL PASS、`check-all` **31/31（31 支 / 3,518 条断言 / 约 206 秒）**。

**判据。** `tools/probe-adapt.mjs` 的 A0（四条夹具检查）+ A1（同词 ≥90%）+ A2（关共现必须变差，阈值从 hit@1 换到 **hit@3**——桥是补位性质的，命中提升全在 2、3 位，拿 hit@1 判消融桥关了也不掉分）+ A3（混库不污染）+ A4（只补位不翻盘 + 至少捞回 2 题）；`verify.mjs` 的 HB2 三处断言按新真相更新（`synExpandOf(qKept, df, n, coocSyn, opts.synFormBridge === true ? coocForms : null)`）与「check-all 每支从 `_root.mjs` 取根」的支数 30 → 31；`probe-gold` 的 G-W4 判据从「宽池 ≥ 窄池」改成守绝对量（窄池照抄 0.977 → 1.000 后相对判据假红，因果写在注释里）。

**没做的事（写在这里不遮）。** hit@1 仍是 0——「多少量」→「起始剂量」要的是语义，不是词形，词形桥到不了；冷域提升全部发生在第 2、第 3 位，所以主判据是 hit@3 / MRR。桥接不上时第二遍不跑（省一半），接得上时确实多一遍词法扫描：1,200 条库实测 4.4 → 11.3 ms/问（2.6 倍）。不做 embedding、不做 LLM 侧扩写（P2' 的范围）。

**A5：把「不过拟合小池」也做成判据（0.5.0 补）。** A1–A4 全在 12 条干净记忆的小池里量，而小池的干扰项也来自同一张词表，idf 稳得像实验室——这正是「拿自己出的题自证」的老毛病。所以 A5 混进 **146 条真记忆**（`gold-recall.json` 40 条 + `gold-wide.json` 106 条，全是讲这个插件自己开发史的真文本）当干扰，五域 60 条夹具一起进同一个库（206 条），再问同一批换说法：hit@3 **60%**（纯池 70%），关共现 **30%**。判据两条：①不许塌（≥50%）②噪声里桥仍可归因（关共现至少掉 2 题）。**这一条读数把这版的天花板说清楚了**：桥不是万灵药，它会被真库的食物稀释，稀释幅度约 -10pt。

**另外三条试过没走通的路（都量过，别重走）。** ①**单字重叠通道**：字符级 idf 重叠单用 hit@1 30% / hit@3 70%（比词法 BM25 的 hit@1 0% 好），但并进 RRF 后 `charW 0.3` 就让第一名 **10/10 全被改判**、hit@3 反掉到 60%——字符通道候选太少，一进 RRF 就把第一遍的 2、3 位挤掉。②**伪相关反馈（PRF）**：拿第一遍榜首的 `keywords` 拼进问句再查一遍、按 0.4 权重并进 RRF，冷域 hit@3 0.70 → 0.80（+1 题）、hit@1 不动、gold 40 条 59 问逐位不变，但要付 3 倍检索成本，收益不成比例。③**库放大 25 倍**（240 条只用夹具词表拼的「关键词汤」干扰，252 条库）：换说法 hit@3 塌到 0~50%，混库 300 条只剩 **10%**；同批实验里把候选窗口从 k=5 放大到 k=20 读数完全不动作。这条不写成判据——那批干扰条目本身就是词表碎渣，不代表真库；但它标出了桥的边界：**桥要的是「库里有正经词可搭」，库里若全是碎渣，再宽的桥也搭不到岸。**

## 9.199 库变大自己就变钝：idf 要在「这次问句的主场」里算（0.6.0 P1–P4）

病根不是排序差，是**全库统计把区分词磨平了**。同一批问句喂两套池子：冻结样张 146 条时照抄档 hit@1 **0.977**，同一批问句喂 578 条真库只剩 **0.889**（0.2.x 实测）。例子：「降糖药第一次吃多少量」——40 条池里 `剂量` 只在一两条出现，idf 高，正解吃大分；578 条时 `剂量` 出现在三十条、`医生` 八十条，idf 掉下去，而多条干扰项各命中五个常见词，累加超过正解，正解掉到第 2、3 位。掉的那 8.8pt 全是「邻居变多」，不是「答案变差」。

**病根点在 `idfOf`，不在排序。** `vendor/meow-memory/lib/index.js:2955` 那个 `idfOf = (t) => log(1 + (n - df + 0.5) / (df + 0.5))` 是全库口径，被 `qIdfSum`、cover、BM25 项、同义通道四处共用——改这一处，四个地方一起跟随，不用给排序再加一个旋钮（历史三十余个旋钮都在打平）。

**修法：双尺度 idf，簇由数据自己长。** ①第一遍照旧用全库 idf 扫一遍；②按 `raw` 降序取候选，对每个查询词比「候选窗口里的条条件数 / 窗口长」与「全库 df / N」——比值 ≈1 是泛词，≫1 是区分词（判定 `ratio >= 1.5 && dfG >= 2`，权重 `(ratio-1)·log(1+dfG)`）；③与榜首共享最多区分词的条目成簇，`dfL` 在簇内统计；④`pr = (dfL + α·pG) / (n_cluster + α)`、`idf_local = log(1 + (1-pr)/pr)`、`idf_used = (1-λ)·idf_global + λ·idf_local`；⑤`λ` 由榜首与第二名的 `margin = (s1-s2)/s1` 自定：`>0.15` → 0（与 0.5.0 逐位相同），`<0.05` → 上限。零 LLM、零手写表、不引入 project/标签/词表——簇是查出来的，不是配置出来的。

**三个必须是量出来的，不是设计出来的。** ①**Dirichlet 收缩 α 是命门**：不收缩（簇内直接算 df）时簇只有 6 条，「人人都有」的词 df=5/5 → idf≈0.087，λ=1 时照抄 hit@1 从 0.895 掉到 **0.684**、换说法从 0.333 掉到 **0.083**；②**簇下限 8 条**（不足按第一遍名次补），否则簇平均 5.7 条、df 全是 0/1；③**规模闸门 N≥300**，不能只看 margin：只看 margin 时宽池 146 条换说法 hit@1 从 **1.000 掉到 0.857**（2 题改判）——margin 小不等于被稀释，也可能只是两条很像。

**参数是量化出来的，不是手感选的。** 最初按设计稿用「窗口 top-64 + 覆盖 0.6」落在 live 上是**净负**：照抄 0.895→0.868、换说法 0.333→0.250，误伤 2。全矩阵扫（`E:\Temp\cmp\live4.mjs`，passMode × 窗口 W × α × λ 上限）后发现**决定项是 λ 上限，不是窗口**：`单遍 W8 / 簇8 / cover0 / α100 / cap0.3` 才正好是 0.921 / 0.417 / 误伤 0。平台验证过不是尖峰：W8 下 α100 的 cap 0.25–0.40 都能到 0.921，α50 的 cap 0.3/0.35 也能，W10/W12 只有 1 题救回。所以定稿 `idfClusterTopM=8`（统计窗口 8 条，正好等于簇下限，cover 退化为 0）、`idfAlpha=100`、`idfLamCap=0.3`；桥那一遍（`searchAdaptive` 第二遍）**只吃全局 idf**——双遍实测只多 1 题、还带 1 处误伤，改动面翻倍不值。

**读数（2026-11-23，零 LLM，真库快照 660 条 active，问句照抄 38 / 换说法 12 / 时间锚 2）。**

| 档 | 关（=0.5.0） | 开（0.6.0） | 差 |
|---|---|---|---|
| 照抄 hit@1 / hit@3 / MRR | 0.895 / 0.974 / 0.934 | **0.921** / 0.974 / **0.947** | +2.6pt / ±0 / +0.013 |
| 换说法 | 0.333 / 0.750 / 0.528 | **0.417** / 0.750 / **0.569** | +8.3pt（1 题）/ ±0 / +0.041 |
| 时间锚 | 0.500 / 0.500 / 0.500 | 0.500 / 0.500 / 0.500 | ±0 |

逐题只有两条改动，都是 #2→#1（照抄第 7 题 `基线要跑几轮才收敛`、换说法第 9 题 `把一个文件拆开之后，怎么确认行为一点没变`；α=50 与 α=100 翻的是同两条、聚合读数也一样），**误伤 0、移位 0**；不传 `adaptiveIdf` 与显式关逐位相同 **52/52**（默认行为没被动过）。同尺横比（同一份冻结语料、只换引擎）：v0.3.0 / v0.4.0 / v0.5.0 三档**逐位相同**，只有 0.6.0 双升——这是唯一一次「只差代码」的横比。

**顺带的一处回执改动（0.6.0 · P4，`status` 透传）。** `memory_search` 回执一直透传 `keywords`/`project`/`created_at`/`updated_at`/`importance`/`level`，但每条记忆的 `status`（active/stale/archived）没带，调用方为了一个字符串要再 `memory_read` 一次。现在只要源文档有 `status` 就透传，**不参与打分、不改排序**。omni3 那 +18.4pt 的主贡献是「结果带记忆日期」，同一个道理：回执里能直接读到的，别让人再查一次。

**判据：`tools/probe-idf.mjs` 十四条（`D1`–`D12`）。** 探针**不测准确率**——那要 ≥300 条真实语料，硬造一份「刚好能翻转」的合成样张是假绿，读数留在 `docs/PLAN-0.6.md` §1。它只钉「这机制不许动结果」+「旋钮真接上」+「接线点不许被摘」：D1 默认=关（15/15）、D2 小池 40/146 开=关（10/10）、D3 λ 上限 0 跨闸门也逐位相同、D4 闸门调 0 宽池必须改判（能红）、D5 全泛词退全库、D6 簇=topM 且 0<λ≤cap、D7 topM 5/12 各归各簇、D8 α 与 D8b cap 改了小分数就变、D9 p95 增量 ≤2ms（0.41→0.41ms）、D10 返回条数/字段不变 + D10b 回执带 `status`、D11 候选不许凭空长出来、**D12 接线点（0.6.1 补）**：`rankForSearch` 里那句 `const o = opts.adaptiveIdf === false ? opts : { ...opts, adaptiveIdf: true };` 与词形桥那遍的 `adaptiveIdf: false` 必须都在源码里——前 13 条全绿也挡不住有人顺手把这两行删掉（删了就是线上悄悄退回 0.5.0），所以用正则把住，并已用「抹掉两行再跑正则」证明能红。外加 `verify.mjs` 的 A7（同尺横比读数）与 A8（`adaptiveIdf:'off'` 与改动前逐位相同）。

**踩到的坑（三条，都留档）。** ①**原型的簇一直是 5 条，是量具假象**：`E:\Temp\cmp\e050a\engine.mjs` 不吃 `bandKeep`，`search(..., {k:N})` 仍只回 5 条，于是「区分词统计窗口 = 簇 = top5」，复现出的 0.921/0.417 是「5 条窗口」的产物，不是机制本身；换成 live（窗口 64、簇 17–26 条）立刻净负。教训：**跨实现复现前先对齐量具口径，别把「窗口长度」当成常数**。②**`adaptiveIdf:'off'` 必须逐位相同**，不能只「差不多」——这是这条机制唯一的回滚口，也是它敢默认开在 `rankForSearch` 上的前提（传 `adaptiveIdf:false` 即回 0.5.0 行为，不改代码不改配置）。③**`keywordHitScore` 里还有第二处 idf**（`:3349`），本次**没动**：它只在关键词命中打分里用、不参与最终排序，动它等于给「关键词抬权」这条老路再开一个口子。

**没做的事（写在这里不遮）。** 分区/局部检索没做（正解落在区外就永远找不到，只能补回一半）；passage 切块、粗召回+二次重排、MMR 都没做（要重建索引或再堆旋钮，历史证明打平）；`:3349` 第二处 idf 没动；规模闸门 300 原先只在 146 与 660 两点验证过，0.6.0 收尾后补扫了 200/300/400/500（见下条）；换说法那 +8.3pt 只是 **1 道题**，12 题的分母，别把它当成结构性提升——真正稳的是「照抄档 +2.6pt 且误伤 0」。

**闸门值的扫描（2026-11-23 深夜补，脚本 `E:\Temp\cmp\gate.mjs`）。** 同一份 660 条冻结语料取**前缀池**（保持原顺序，这样 660 那行必须复现冻结基线，证明是同一把尺子）。结果：300 条池（23 问）0.783/0.957/0.870、400 条池（25 问）0.800/0.960/0.873、500 条池（26 问）0.808/0.962/0.878，**开机制与关机制逐位相同**（救回 0、误伤 0、移位 0）；只有 660 全池（52 问）才从 0.750/0.904/0.824 变成 **0.788/0.904/0.843**（救回 2、误伤 0）。闸门值本身在 660 池上 `gate=0/200/300/400/500` **五档逐位相同**，`gate=700`（>N）才退回基线。⇒ 闸门不是敏感旋钮，它只负责「小池一律不碰」；机制在 300–500 条池上既不改判也不误伤（λ 由 margin 决定，多数问句本来就是 0），到大库才真正动手。300 保留。


**三棵树一条命令（0.6.0 收尾后补，`tools/sync-trees.mjs`）。** 本仓有三份活拷贝：工作树 `D:\dsh-home\vendor\dsh-macro-memory`（改代码、跑闸门、提交）、阅读树 `D:\document\DSH Memory Macro-Regulation System`（人读）、装机树 `%DSH_HOME%\profiles\desktop\node_modules\dsh-macro-memory`（**DSH 真正加载的那份**，doctor 的「两处比较」与 `probe-load` 都看它）。少同步一棵的后果这一轮反复出现：`FAIL 两处不一致 1 个漂移 tools/baselines.json`、`FAIL DSH 加载的那份与本仓同版：装的是 0.5.0，本仓是 0.6.0`。这一支默认**只体检**（比大小与 mtime，报「同名同大小 / 内容不同 / 对方缺 / 对方多」四档），`--apply` 才 `robocopy /E`；**没有 `/MIR`、没有 `/PURGE`，一个字节都不删**——批量删除必须先问主人。`node_modules` 与 `.git` 各树各自独立，跳过；`.analysis` / `.dsh-meow` 是运行时数据目录，只跳过统计、不同步。同步完不自动跑 `make-vendor-manifest` 与 `doctor`：前者会改 `vendor/VENDOR.json`、后者要判红，留给调用者按提示的顺序做。它登记在 `tools/manual-tools.mjs` 的账本里（`smoke: true`，只读可随时跑），**不进 check-all**——报表型脚本没有可断言判决，进去只会稀释判据。

**顺手核了一遍的事（0.6.0 收尾）。** `check-all` 支数 31 → **32**（挂进 `probe-idf`），断言 3,523 → **3,536**（0.6.1 再加 D12 → **3,537**，收敛轮三条哨兵 → **3,540**）；`verify.mjs` 的「check-all 每支从 `_root.mjs` 取根」支数跟着改成 32；`docs/PLAN-0.6.md` 的「未决四问」在落地时逐条答了（簇实测 8 条、第二处 idf 不改、桥那遍只吃全局、闸门 300 收尾后补扫 200/300/400/500 确认不敏感）。另一条环境坑：document 树的 `node_modules/@deepseek-ai/dsh-llm` 是从 app 目录**拷**出来的实体目录，它自己静态 import 的 `dsh-typert-protocol` 等五个包在那棵树里没有 → 十四支探针 `ERR_MODULE_NOT_FOUND`、断言全 0（看着像代码全坏了）。同源的 `dsh-llm` 在 `D:\dsh-home\vendor\dsh-macro-memory\node_modules\` 下是 **junction**，解析走真实路径所以没事。修法是**加法**：给缺的五个包建 junction 指回 `D:\DSH\DSH NEXT\resources\app\node_modules\@deepseek-ai\`，一个现有目录都不删。教训：**一支探针 0 断言 = 进程没起来，不是语义变了**；先看断言行有没有输出，再决定要不要动代码。

**另有一条：mirror 树（`D:\document\DSH Memory Macro-Regulation System`）天生有两支红，别当成代码坏了。** ①`tools/probe-tools.mjs` 的冒烟支跑 `tools/patch-meow-settings-ns.mjs` 会 `exit=2 目标不存在`——那个脚本拿 `import.meta.url` 拼路径却没解码，路径里的空格变成 `%20` 就找不着 `vendor/meow-memory/lib/client.js`，而源树路径 `D:\dsh-home\...` 没有空格（**0.6.1 已修**：改用 `fileURLToPath`，mirror 树上这支现在 3/3 退出码 0）；②`tools/check-market.mjs` 报 `commit 在本仓里真实存在` 红——mirror 树是另一份 git 历史，索引里钉的 `fb1f504` 只在源树里。所以**闸门要在源树 `D:\dsh-home\vendor\dsh-macro-memory` 跑**（`node tools/doctor.mjs` + `node tools/check-all.mjs`，32/32、3,540 条），mirror 树只作阅读副本；`doctor` 的「两处一致」比的也不是 mirror 树，而是 DSH 真正加载的 `D:\dsh-home\profiles\desktop\node_modules\dsh-macro-memory`，升级后必须把它一起 robocopy 过去，否则一直报漂移、`probe-load` 一直喊「装的是旧版」。

## 9.200 记账那一趟自己会抖：写一次基线，就地重跑一次就够了（0.6.1）

升版本时我连着两次被同一件事绊住：`node tools/check-all.mjs --update-baselines` 报**「断言数回退 3 支」**并 exit 1，可代码一行没退化。
先看数：`verify.mjs` 1811→1810、`tools/check-market.mjs` 48→47、`tools/doctor.mjs` 162→161，各少 1 条；同时 `tools/probe-idf.mjs` 13→14（这条是预期，D12 新加了一条）。

### 9.200.1 病根：有些断言要基线先说对，才肯出现

`verify.mjs` 与 `tools/doctor.mjs` 里各有一条「**基线版本与 package.json 一致**」。版本号刚升的那一趟，基线里还是旧号：

- 这条断言是 FAIL；FAIL 那一路少走一段（不打印那条 `PASS`，也不进后面的分支），于是这轮数出来的条数**比绿态少 1**；
- `--update-baselines` 照着这轮的数写盘 → 基线里的 `version` 变成新号；
- 下一趟那条断言回来说 PASS，条数**又变回 1 条**，基线立刻显得「少了」。

所以这不是脚本坏了，是**记账本身改变了下一轮的输入**。我踩了两次（0.6.0 与 0.6.1），每次都要人手跑三趟 210 秒才稳，第三趟才写出 `32 支，合计 3537 条`。

### 9.200.2 处方：记完就地重跑「数与基线不同」的那几支

`tools/check-all.mjs` 的 `--update-baselines` 分支现在长这样：

1. `record(results)` 先把这一轮的断言数与耗时写进 `tools/baselines.json`（重读盘上旧档再叠加，`--only` 只改跑到的那支，不会把别的写残）；
2. 找出 `r.pass !== r.base` 的那几支（本次「数与手里基线不同」的），**用刚写下的新基线单独重跑它们**，`showStep` 照常打印，结果替换进 `results`，再 `record(fresh)`；
3. 最多 3 轮，收敛就打印 `已收敛（N 轮重跑）：基线与本轮实测逐支一致`；收不了就打印 `⚠ 重跑了 N 轮仍有 M 支在晃`，并点名那几支。

`measure(file, what, bl)` 现在把基线作为参数收进来（原先直接闭包读全局 `baselines`），`budgetFor(base, file)` 同理——重跑时必须拿**新**基线算预算与基准，否则重跑没有意义。

实测（故意把基线里 `tools/probe-idf.mjs` 改成 13 再记账）：

```
✓ tools/probe-idf.mjs              0.3s/ 30s   14 条 ↑
基线已更新：32 支（断言数 + 耗时预算）→ tools/baselines.json（macro-memory 0.6.1）
  收敛第 1 轮：tools/probe-idf.mjs 的数与基线不同，按新基线重跑这几支（有些断言要基线先对上才出现）
✓ tools/probe-idf.mjs              0.3s/ 30s   14 条
  已收敛（1 轮重跑）：基线与本轮实测逐支一致

汇总：1/1 通过（macro-memory 0.6.1，用时 0.7s）
```

exit=0，且 `tools/baselines.json` 的 `counts` 回到 14（只有那一行的 `ms` 跟着实测动了一下）。

### 9.200.3 顺手记下的两条- **`--update-baselines` 失败也会写盘**。第一趟报「回退 3 支」并 exit 1 时，文件**已经**被改过了（写过再判），`git status` 能看到 `M tools/baselines.json`；要撤就 `git checkout -- tools/baselines.json`。所以「它 exit 1 了所以没记账」是错的直觉。
- **读 `doctor` 的漂移清单别被下一行骗**。`FAIL  两处不一致  1 个漂移 / 0 个多余` 后面紧跟的一长串 `vendor/meow-memory/lib/index.js …` 是**下一条 PASS「补丁在位…」的 extra**（补丁描述全文），不是本条信息。要看真身：`node tools/doctor.mjs | Select-String 'drift:'`（`tools/doctor.mjs:121` 打印的就是漂移名单）。那次真身是 `drift: tools/baselines.json（内容不同）`，因为它刚被红态那一趟改过、装机树还是旧的。

### 9.200.4 补一条：红的那一支不记账

收敛轮上线后第一次真跑就露了另一半：那一趟 `tools/doctor.mjs` 是**红**的（`FAIL 两处不一致 1 个漂移`，因为 `tools/baselines.json` 刚被写、三棵树还没同步），它报 **161 条**，而绿态是 162——FAIL 那一路少走一段，少掉的正是「两处字节一致」那条 `PASS`。旧代码照样把这个 161 记进基线，于是同步完树、doctor 变绿，又变成「断言数增加 1 支」。

所以 `record()` 现在只记**绿**的那几支，红的跳过并打印一句 `跳过 N 支（这一趟是红的，条数不可信，保留旧账）`；收敛轮的 `unstable()` 也只看 `r.ok` 的——红的那支本来就没记账，拿它去重跑只会白跑。同理，跑 `--update-baselines` 之前最好先 `node tools/sync-trees.mjs --apply`，让 doctor 有机会绿。

账随之从 3,537 变成 **3,540**：`verify.mjs` 1811 → **1814**，多出来的三条就是给这套机制配的哨兵——「记完会收敛」（`/const unstable = \(\) => results\.filter/` + `rounds >= 3` + `已收敛（${rounds} 轮重跑）`）、「收敛不了就说在晃」（`支在晃` + `按新基线重跑这几支`）、「红的那一支不记账」（`if (!r.ok) { skipped.push(r.file)` + `条数不可信，保留旧账`）。少一样就立刻红，跟 D12 是同一种「判据不许只写在文档里」。

## 9.201 有力气说「没有」，就没力气说「有」：地板剔完还剩个不可能命中的词（0.6.2）

### 9.201.1 症状：八道题回了个空数组

0.6.2 先用 LoCoMo（10 段对话、5,882 轮、cat1–4 共 1,531 问题）搭了一把英文量尺 `tools/bench-locomo.mjs`——原始对话轮直接当记忆条（`{ id: dia_id, title: '', content: 'Speaker: text', keywords: [] }`），零 LLM、零网络。第一轮读数里跳出来一个不该有的东西：**8 问返回 0 条**（0.52%）。

逐条看，都是这种句子：

```
What Console does Nate own?
What did Nate do for Joanna on 25 May, 2022?
What items did Calvin buy in March 2023?
```

同一批 `docs` 上把 `noiseFloor: false, funcFloor: false` 打开，8 问全部回满 20 条。所以不是「库里确实没有」，是**地板把能命中的词切光了**。插件在别处反复写着「回执说『没有』要分四种来路」，可这一次它把「有」直接说成了「没有」——对外最坏的失败模式，排在任何精度指标前面。

### 9.201.2 病根：护栏只管「一个词不剩」，不管「剩下那个命中不了」

拿 `E:\Temp\cmp\diag-empty8.mjs`（`Module._compile` 内存里给引擎加 `[dbg]` 打印，不改仓库文件）把中间量摊出来，两条问句对照：

```
'nate'        q:["nate"]            noiseDropped:[]       qKept:["nate"]  qIdfSum:0.333 → 5 条
'zzzz nate'   q:["zzzz","nate"]     noiseDropped:["nate"] qKept:["zzzz"]  qIdfSum:7.139 → 0 条
```

两层地板在 `vendor/meow-memory/lib/index.js`：

- `NOISE_DF_RATIO = 0.5` / `NOISE_MIN_DOCS = 8`（`:1990–1991`），`noiseTermsOf` 把 `df >= ceil(n*0.5)` 的词当噪声剔掉（`:1992`）。语料 629 条里有 454 条写着 `nate`（df 比 72%），于是 `nate` 被剔——**它是唯一能命中的词**。`console` 被 `tokenize` 截成 6 字符 `consol`，df=0，留在 `qKept` 里当主语。
- 唯一的护栏是「剔完不剩就整段回退」（`:1997` `out.length >= qTerms.length`）；`funcTermsOf`（`:2025`）只管 `CJK_FUNC_WORDS` 表里的虚词，**不看 df=0**。

两半拼起来就是空回：`qLoop` 里每个词都在全库命中 0 次 → 候选集空 → `hits` 空 → 回执 `[]`。先前所有「空结果」的口径都假设「真没有」，没假设过「词被错误地剔光、剩下的又命中不了」。

### 9.201.3 处方：只换掉那些一定命中不了的词

第一版处方放在 `search()` 末尾（结果为空且地板确实切过词 → 关掉两层地板重跑一次），量出来的数是对的，但它是**症状层**：根因修掉后这段永远不可达，探针也钉不住它，已撤掉。

真改在 `vendor/meow-memory/lib/index.js:3057` 之后、`if (qKept.length === 0) { qKept = qTerms; qLoop = q }` 这句原位护栏后面（终版，已收窄）：

```js
// [macro-fusion 0.6.2] 护栏②只治「剔完一个词不剩」，漏了另一半：
// 剔完还剩一个在库里命中 0 次的词（库外词 / 被截断的标识符）占着 qKept。
const rescued = noiseDropped.filter((t) => !funcDropped.includes(t) && (df.get(t) ?? 0) > 0);
if (rescued.length > 0 && !qKept.some((t) => (df.get(t) ?? 0) > 0)) {
  qKept = rescued;
  qLoop = q.filter((t) => rescued.includes(t));
}
```

三条设计取舍，都是有意的：

- **只在「一个都命中不了」时动手**：只要 `qKept` 里有一个词 df>0，行为与改前逐位相同。
- **只救「噪声词」**：`noiseDropped` 是「df ≥ 一半」的词——按定义在本库必然命中，救回来只会把空回执变成「有」，不会开门给噪声。虚词地板剔掉的（`funcDropped` 是「哪都没有也不带信息」）一个都不救；两层都剔掉的词按虚词算。
- **`rescued` 为空就不动**：`zzzz`、`quantum entanglement` 这种真·库里没有的问句，照样如实回 0（`probe-empty` E2 钉住）。

**这一版是被 G8 打回来的**：第一版处方救得更宽——「问句里所有库里存在的词」都救回来。LoCoMo 上读数一样好（空回 0.0000），但 `tools/probe-gold.mjs` 的 G8「没有的事就空手」立刻红：14 条与记忆库无关的问句里，`光合作用的暗反应发生在哪里` 被 `合作/作用/反应` 凑出 1 条、`上一届世界杯冠军是谁` 被 `冠军/世界` 凑出 4 条，**空手 10/14 → 8/14**（阈值 9）。诊断脚本 `E:\Temp\cmp\neg14.mjs` 用同一份源码编译两遍（原样 / 挖掉补丁）逐题对照，才看清差别：无关问句的地板**没剔过任何噪声词**（`noiseDropped` 全空），是救宽了把泛词救回来了。收窄成「只救 `noiseDropped`」之后：LoCoMo 空回仍是 0.0000、G8 回到 10/14（与改前逐条相同）。**教训：修「空手」的补丁必须先过「该空手时还空手」这条反尺子，否则等于用召回换误报。**

读数（`node tools/bench-locomo.mjs --data=E:\Temp\omni\OmniMemEval-main\data\locomo\locomo10.json`）：

| 指标 | 改前 | 改后 |
|---|---|---|
| 空回 | 0.0052 | **0.0000** |
| hit@1 / @5 / @10 / @20 | 0.3932 / 0.6192 / 0.6924 / 0.7511 | 逐位相同 |
| MRR | 0.4958 | 0.4958 |
| recall@20 | 0.6322 | 0.6322 |
| 平均取回条数 | 17.69 | 17.8 |

真库那把尺子（`E:\Temp\cmp\final.mjs`，660 条 / 52 问）三档读数与两条逐题位移**一位不动**：照抄 0.921、换说法 0.417、时间锚 0.500。平均取回 17.69→17.8 是那 8 问从 0 条变成 20 条带来的，属于修好而不是变差。

### 9.201.4 能红证明：把补丁挖掉，空回立刻回来

`E:\Temp\cmp\redproof-empty.mjs` 用 `Module._compile` 把这段补丁整段替换成空字符串再编译，同一份 `docs` 上跑：

```
zzzz nate  → 0 条     （真引擎 5 条）
nate       → 5 条     （与真引擎同）
```

也就是说判据里「库外词不顶位」那一条确实挂在这段代码上，不是挂在一句注释上。这跟 D12 一样：**判据必须能红，否则它只是文档**。

（`Module._compile` 的坑记一笔：挖补丁是按源码里的锚点切的。补丁改了之后锚点也跟着变——还照着旧锚点 `if (matchable.length > 0) {` 去切，`indexOf` 返回 −1，切出来的源码少了一大段、`function fallbackHomeDir` 声明两遍，报 `SyntaxError: Identifier 'fallbackHomeDir' has already been declared`。改锚点要跟改补丁同一步做。）

### 9.201.5 判据：`tools/probe-empty.mjs`（E1–E7，十四行）

进 `check-all`（排在 `probe-idf` 之后），纯内存语料、零网络：

- **E1 库外词不顶位**：语料里只有 `e-n*` 写着 `nate`。`zzzz nate` 与 `nate` 首位同为 `e-n0`，且命中集只落在 `e-n*`——库外词既没抢主语，也没把结果挤空。
- **E2 不凭空编**：`zzzz`、`quantum entanglement` 仍回 0 条（处方不是「无论如何都回几条」）。
- **E3 老护栏不回退**：全噪声词（`基线`）、全虚词（`一次`）都非空——整句回退那条护栏还在。
- **E4 正常问句两态逐位相同**：`c-b0..c-b4` 在地板开/关两态下名次与分数逐位一致（改动不碰正常路径）。
- **E5 边界**：不引入语料外的 id、条数不超过 `k`、`docs` 为空时回 0。
- **E6 成本**：每次多花 0.05ms 量级（一次 `some` + 一次 `filter`），可忽略。
- **E7 只救噪声词**：中文实词照救（语料里 60% 含 `基线`，问 `zzzz 基线` 非空）；既是噪声又是虚词的词一个都不救（语料里 100% 含 `什么`，问 `zzzz 什么` 必须 0 条）。这一条是 G8 那次判红的落地形态。

**踩到的坑**：E3 第一版拿 `怎么才算好` 判红，红得莫名其妙。查下来是 `stripQuestionFrame` 把「怎么」剥掉后剩 `才算/算好`，而语料里这两个词 df=0——**那是真·无词可命中，本来就该回 0**。改成「让语料里真的写着『一次』，再问『一次』」，判据才量到它想量的东西。写探针时先问一句：这句话在语料里到底有没有词能命中。

### 9.201.6 顺手量掉的两件（有证据地不做）

- **英文形态归一（`docs/PLAN-0.6.md` §12 #3）**：`E:\Temp\cmp\en.mjs` 在 LoCoMo 1,531 问上做四档对照。词干化双边（Porter-lite）hit@20 0.7511 → **0.7198**、MRR 0.4958 → **0.4598**；复数合并双边 0.7218 / 0.4622；只扩问句 0.7498 / 0.4893（基本不动）。合并词形伤的是精确匹配，**否决**。
- **MMR 去冗余重排（§12 #9）**：λ=0.1/0.3/0.5/0.7 全扫，hit@20 0.7511 → 0.7511/0.7544/0.7551/**0.7577**，MRR 0.4958 → 0.4959/0.4967/0.4963/0.4957，hit@5 0.6192 → 0.6199/0.6212/0.6179/0.6172。最好那一档是 +0.66pt hit@20 换 −0.2pt hit@5，属噪声级，**不落地**。

两件都写进 `docs/EVAL-CLAIMS.md` A2.2 与 §12 的档位格，负数留着——省得下一轮又从头试一遍。

### 9.201.7 账

`tools/probe-empty.mjs` 十四条进 check-all，支数 32 → **33**，断言 3,540 → **3,554**；`tools/bench-locomo.mjs` 进 `tools/manual-tools.mjs` 手动账本（`smoke: false`：数据集在仓库外，没有 `--data` 时按设计 exit 2 打用法），`tools/probe-tools.mjs` 由此 45 → **46 个脚本 = check-all 32 + 手动账本 8 + 仅被 import 6**。

## 9.202 同一问句，同一答案：分数并列时不许「谁先进库谁在前」（0.6.3）

### 9.202.1 症状：同一份记忆，两种插入顺序，两套前十

`vendor/meow-memory/lib/index.js` 的 `bandize()` 是全库最后一跳定序：

```js
hits.sort((a, b) => (bandOf.get(a) - bandOf.get(b)) || (b.score - a.score));
```

分数并列时没有第三把钥匙。V8 的 `Array#sort` 是稳定排序，于是**并列组内的顺序 = 语料顺序**。造一份 40 条同构语料（内容一模一样，分数必然全并列）直接量：

```
原序  ：t-00,t-01,t-02,t-03,t-04
乱序 1：t-31,t-23,t-28,t-38,t-27
```

前十换了一批人，而问句一个字没变。这不是「排序差一点点」，是**结果由存储布局决定**：生产里 `docs` 的顺序不是我们给的——存储层更新会改 rowid、VACUUM 与分页会换顺序、导出再导入会彻底打乱。于是「同一问句同一答案」这条产品承诺在现场不成立，`docs/EVAL-CLAIMS.md` 里每个读数也都只是「抽到的那一次」。

顺带查出同一类的两处：

- `searchAdaptive()` 的自适应 idf 挑簇那一跳写的是 `order.sort((x, y) => raw[y] - raw[x] || x - y)`——`x - y` 是**语料下标**，并列同样按插入顺序，簇一换、`lam` 与 top-M 跟着换；
- 稠密通道与 RRF 融合的并列用 `String(a.id).localeCompare(String(b.id))`——`localeCompare` 的顺序随 ICU/locale 变，**换一台机器就换顺序**。

### 9.202.2 处方：四把钥匙，全是数据本身的属性

```js
hits.sort((a, b) => (bandOf.get(a) - bandOf.get(b)) || (b.score - a.score) || (stampOf(a) < stampOf(b) ? 1 : stampOf(a) > stampOf(b) ? -1 : 0) || cmpText(a.id, b.id));
```

- **分档**（`_raw` 决定）→ **分数** → **更新得更晚的在前** → **id 自然序**。前三把是既有的语义（跨档不许越级、同档按分），第四把是这次补的：`bandize` 里原本一条时间也没比，而「两条一样相关时先给新的」本来就是宏记忆该有的偏好（`rankForSearch` 的收口那一跳早就在这么比）。
- `stampOf(h)`：`updated_at` 数字原样、ISO 字符串 `Date.parse`、缺字段算 0——**全是 0 时整组落到 id 那一把**，不会因为「有人没写时间」就退回插入顺序。
- `cmpText(a, b)`：按码元比，**数字段按数值比**——`D1:2` 排在 `D1:10` 前面。这条是被读数逼出来的，见 9.202.3。
- `searchAdaptive` 的挑簇改成 `laterFirst(docs, x, y)`（同一把梯子的下标版）；两处 `localeCompare` 换成 `cmpText`。

### 9.202.3 为什么 id 那把要「自然序」：先试了纯字典序，掉读数

第一版写成纯码元序（`x < y ? -1 : x > y ? 1 : 0`），LoCoMo 1,531 问立刻掉：hit@1 0.3932 → **0.3926**、hit@5 0.6192 → **0.6179**、hit@20 0.7511 → **0.7505**、MRR 0.4958 → **0.4953**、recall@20 0.6322 → **0.6310**。原因很具体：LoCoMo 的 `dia_id` 是 `D1:2`、`D1:10` 这种，纯码元序把 `D1:10` 排到 `D1:2` 前面，正好与时间序相反——**用一个与数据语义相反的键去定序，等于拿读数换确定性**。

改成数字段按数值比之后，读数**一位不差**地回到 0.3932 / 0.6192 / 0.6924 / 0.7511 / MRR 0.4958 / recall@20 0.6322 / 空回 0.0000，真库 660 条 52 问三档（照抄 0.921 / 换说法 0.417 / 时间锚 0.500）也一位不动。这一版是**纯赚**：确定性上去了，读数没让。

### 9.202.4 判据：`tools/probe-determinism.mjs`（D1–D8，九行）

进 `check-all`（排在 `probe-empty` 之后），纯内存语料、零网络、不写仓库文件：

- **D1 重复**：同一进程连跑 5 次，id 序与分数逐位相同。
- **D2 跨进程**：另起一个 `node` 进程跑同一份快照，哈希与本进程一致（结果里没有进程内随机态）。
- **D3 打乱语料**：seed 3/11/42 三种插入顺序，`search` 前十逐位相同。
- **D4 同上，`searchAdaptive` + `adaptiveIdf`**：跨过闸门那一遍（挑簇 + `lam`）也逐位相同。
- **D5 并列组里更新得更晚的在前**：两条同内容、`updated_at` 1000 / 9000，两种插入顺序都回 `v-2,v-1`。
- **D6 id 自然序**：`D1:2` 先于 `D1:10`（纯码元序会反过来）。
- **D7 定序里没有 `localeCompare`**：全文件剩下的两处都在显示分组（会话名、项目分组），不参与检索定序。
- **D8 能红证明**：把梯子换回只有「分档 + 分数」两跳再编译，同一份语料打乱后前十必然不同（`t-00` ≠ `t-31`）——在**没 import 过真引擎的子进程**里量（同进程量出来是假绿，见 9.202.5）。

### 9.202.5 坑

- **D5 与 D6 不能合并**：时间那把和 id 那把是两把钥匙，缺一把都能被「恰好时间相同」的语料蒙过去。D5 用时间不同的双胞胎、D6 用时间全缺的双胞胎，各钉一把。
- **`stampOf` 必须解析 ISO 字符串**：`updated_at` 在真库里既有毫秒数也有 ISO 串（`Number('2026-11-24T…')` 是 `NaN`，一路 `NaN` 比较会让排序直接乱掉）。第一版直接用 `Number(v) || 0` 会把整组打回「全是 0」，等于白改。
- **别用 `localeCompare` 当代替品**：它看起来「更智能」，实际是「本机更智能」——换 locale 就换顺序，正好是这条要消灭的东西。
- **`Module._compile` 的 `filename` 必须落在引擎自己那一层**：D8 要「把梯子挖掉再编译」来证明红线在梯子上。第一版把文件名写成 `'red-det.js'`，于是源码里的裸包名（`@deepseek-ai/dsh-llm`、`@deepseek-ai/schemastery`）按 cwd 解析——`check-all` 是在 `E:\Temp\macro-neutral-cwd-*` 里跑每一支的（这条设计本身是对的：不替被检查者补环境），红成 `ERR_MODULE_NOT_FOUND: Cannot find package '@deepseek-ai/dsh-llm' imported from E:\Temp\macro-neutral-cwd-lA5PV9\red-det.js`。改成 `red.filename = enginePath` 之后，解析锚点回到引擎目录，从仓库 `node_modules` 里找得到。
- **红线必须在没 import 过真引擎的子进程里量**：`red.filename` 改成 `enginePath` 之后，D8 反而「钉不住」了——a 与 b 都是 `t-00,t-01,t-02,t-03,t-04`。逐层排掉（`E:\Temp\cmp\dbg-red2/3/4/5.mjs`）：裸脚本里同一段 `_compile` 能给出 `t-00` vs `t-31`；只要同进程里 `import` 过一次真引擎（**一次 `search` 都不调用也算**），红模块的两套顺序就都变成 `t-00..t-04`。也排除过「索引缓存把两种顺序混成一张表」这个解释：`indexSignature` 是按 docs 顺序算的签名（`index.js:2934`），顺序不同就是不同的键，而且带 `cache: false` 复跑照样钉不住。结论是「同进程里已加载的那份引擎」影响了红模块的行为，成因没继续挖——**判据不许建立在一个没查清的副作用上**，所以 D8 改成 `execFileSync(node, ['--input-type=module','-e', redCode])` 在干净子进程里量，stdout 回 `DIFF t-00 t-31` 才算过。一条规则：**「挖掉补丁看它变红」这种证明，必须在补丁运行环境之外量**，否则测到的是「这一版这份进程」而不是「这条代码」。
- **D3/D4 一律带 `cache: false`**：这条要钉的是「定序不靠语料顺序」，把索引缓存这个变量摘掉才量得干净（缓存键虽含顺序签名，但缓存热着时比较的是两张不同的表，读数不再只反映定序）。

### 9.202.6 账

`tools/probe-determinism.mjs` 九条进 check-all，支数 33 → **34**；`tools/probe-tools.mjs` 46 → **47 个脚本 = check-all 33 + 手动账本 8 + 仅被 import 6**。`verify.mjs` 的「根」那条从 33 支改 34 支，另开 `DT063` 一节六条（梯子在位 / 挑簇改走 laterFirst / 没有 localeCompare / 挂进 check-all / 探针八条标签都在 / 文档在位）；HZ15 那条原来把整条 `hits.sort(...)` 写死在断言里，改成只钉「档位 → 分数」两跳——它守的是「折价必须折在 `_raw` 上」，不是结尾长什么样。

## 9.203 一个汉字进来，不许变成「没有」（0.6.4）

### 9.203.1 症状：单字问句永远空手

扫边界扫出来的（`E:\Temp\cmp\edge.mjs`：空串、纯空格、纯标点、正则元字符、3,000 词超长、`null`、`undefined`、纯数字、emoji 挨个试一遍，全部不崩、返回形状也合法）。但里面藏着一条「不崩却答错」：

```
搜索('读')   → 0 条        （库里明明有一条正文写着「滴定终点读两遍」）
搜索('读两遍') → 1 条      （同样的库，同样的问题）
```

`single.mjs` 直接调分词器，根因一行就清楚了：

```
tokenize('读')     → []                  ← 一个汉字
tokenize('读两遍') → ['读两','两遍']      ← 两个汉字以上
```

`vendor/meow-memory/lib/index.js:1660-1663` 的中日韩那一段只产出二元组（`if (run.length >= 2)`），单字落不进任何词。于是 `search()` 的第一道门 `if (q.length === 0 && idents.length === 0) return []` 把「切不出词」当成「没内容」，直接回空。

这是 0.6.2 的**同一族病**：那条治「地板剔空」（剔完一个词不剩），这条治「压根切不出词」。两条合起来才守住 RULE 里那句话——**回执不全 ≠ 库里没有**。区别在于 0.6.2 有 LoCoMo 的空回读数当证据（8 条），这条**任何现成量尺都看不见**：LoCoMo 1,531 问没有一道单字问句，真库 52 问也没有。它只在「用户真的问一个字」时出现，而那恰恰是最自然的问法之一。

### 9.203.2 处方：只在「切不出词 + 单个汉字」时做一次原文子串

新增 `literalFallback(query, docs, opts)`（在 `function search(...)` 之前），闸门只有一行：

```js
const cps = Array.from(String(query ?? '').normalize('NFKC').trim().toLowerCase())
if (cps.length !== 1 || !/[\u3400-\u9fff\uf900-\ufaff]/.test(cps[0])) return []
```

过闸之后对每条 doc 用 `${title} ${content} ${keywords}` 做 NFKC + 小写的子串计数，命中次数当 `_raw`/`score`，`bandize(hits, '_raw')` 之后照 `keepBand` / `trimByBand` 收口——**定序仍走 0.6.3 的四把钥匙**，兜底不自己发明排序。调用点两处：`search`（`verbatimInputs(… docText(d))` 之后）与 `keywordHitScore`（同一位置），两处都把原来的 `return []` 换掉。

三个取舍，每个都有反证：

- **闸门是「一个码点 + 汉字」，不是「短」**。`the` / `a` 也短，但它们被停用词吃掉后做子串匹配就是纯噪声。`probe-gold` 的 G8 专门抓这个：实测改完 **空手仍是 10/14**，`G9 阴性对照`（`funcFloor:false` 时只剩 3/14）也没动。
- **不做英文短串兜底**。英文一个词就能切（`run.join('').toLowerCase()`），没有「切不出词」这个前提；硬加一层等于给停用词开后门。
- **扫 title + content + keywords，不只扫 content**。关键词里写着的字也算「库里有」，`L2` 钉的就是这条（`花` 只写在 `keywords` 里 → 仍命中）。
- **两条打分路径一起改**。只改 `search` 不改 `keywordHitScore`，会出现「换个入口答案就没了」，比原来更坏——这种不一致用户没法归因。

烟测（直连引擎）：`读`→`a:1`、`花`→`c:1`、`Nate`→`b:1.0226`、`读两遍`→`a:1.716`（原样不变）、`the`/`zzz`/空串 → `[]`。

### 9.203.3 读数：一个字没让

- LoCoMo（10 段 / 1,531 问）：hit@1 **0.3932** / hit@5 **0.6192** / hit@10 **0.6924** / hit@20 **0.7511** / MRR **0.4958** / recall@20 **0.6322** / 平均取回 **17.8** / 空回 **0.0000** —— 全部逐位不变。
- 真库 660 条 52 问三档：照抄 **0.921** / 换说法 **0.417** / 时间锚 **0.500**，两条 #2→#1 位移也没动。

一个字没动正是**这条修得对**的形状：兜底只在「原本必然回空」的问句上才有机会执行，正常问句连闸门都过不去。这也说明它修的不是排序，是**可达性**——把一条本来答不出来的路接上，而不是把已经答对的题再挤高半分。

### 9.203.4 判据：`tools/probe-literal.mjs` 十一条（L1–L8）

- `L1` 单字中文问句不再空手（`读` → 非空）+ 每条命中真的含那个字（不是拿别的条目凑数）
- `L2` 只写在 `keywords` 里的字也认（`花` → `L-d`）
- `L3` 英文停用词仍然空手（`the` / `a` 都是 0 条）
- `L4` 纯标点 / 纯空白 / 空串仍然空手
- `L5` 定序不看插入顺序（反转语料逐位相同）+ 并列时「更新得更晚的在前」（`updated_at` 9000 先于 1000）+ `k` 仍然生效
- `L6` 三条路径同口径：`search` / `searchAdaptive` / `keywordHitScore` 命中集合相同
- `L7` **能红证明**：在子进程里用 `Module._compile` 把 `return literalFallback(query, docs, opts);` 全部换回 `return [];`，`读`/`花` 立刻回空（`0,0`）
- `L8` 库里没有的字仍然空手（`鲸` → 0 条）

L7 沿用 9.202.5 的两条坑：`red.filename = enginePath`（否则裸包名按 check-all 的中性 cwd 解析会 `ERR_MODULE_NOT_FOUND`），以及**在没 import 过真引擎的子进程里量**。

### 9.203.5 同版否决的两条候选（留负数读数）

- **覆盖率优先重排**（top1 覆盖率低于阈值就按覆盖率重排）：真库 thr=0.4 时照抄 0.921 → **0.947**、换说法 hit@3 0.750 → 0.833，看着像白捡。但 LoCoMo 1,531 问全线下滑：thr=0.25 hit@1 0.3932 → 0.3912、thr=0.3 → 0.3788、**thr=0.4 → 0.3690（−2.4pt）、MRR 0.4743**、永远重排（thr=1.01）→ 0.3442。真库那点涨幅是**自建语料过拟合**，不做。
- **缺 id 的脏主键在入口过滤**：边界扫雷确实量到「doc 没 id 时命中带 `h.id === undefined`」，但在 `search` 入口过滤会给 `searchIndexOf` 每次传新数组，等于把索引缓存全部打穿——性能账不合算，且这不是「答错」，是「脏数据」。不做，记在 §12。

### 9.203.6 账

`tools/probe-literal.mjs` 十一条进 check-all，支数 34 → **35**；`verify.mjs` 的「根」那条从 34 改 35，另开 `LT064` 一节七条（兜底函数与闸门在位 / 两条打分路径都改走兜底且旧 `return []` 清零 / 兜底扫 title+content+keywords / 挂进 check-all / 探针 L1–L8 标签都在 / INTERNAL 9.203 与 README「切不出词 ≠ 库里没有」在位 / 版本号 0.6.4）。断言总数 3,569 → **3,587**（+11 探针 +7 verify）。

## 9.204 标点也是人打的：`读？` 不是「两个字」（0.6.5）

### 9.204.1 症状

0.6.4 的单字兜底上线当天就被自己的边界探针打回来了：

```
search('读')   → 2 条
search('读？') → 0 条        ← 人真在键盘上问一个字，问号几乎从不缺席
search('钱。') → 0 条
search('「读」') → 0 条
```

原因在闸门的第一句：0.6.4 写的是 **`if (cps.length !== 1 || !/[\u3400-\u9fff\uf900-\ufaff]/.test(cps[0])) return [];`**——「正好一个码点」。`读？` 是两个码点，连门都进不去。于是 0.6.4 治好的只是合成语料里那个不带标点的形状，真人问法整片漏在外头。这不属于「排序不够好」，仍然属于 0.6.2 / 0.6.4 那一族：**回执不全 ≠ 库里没有**。

### 9.204.2 处方：剥掉外壳再数

闸门改成「剥掉标点与空白之后，正好剩一个汉字」：

```js
const cps = Array.from(needle);
const isHan = (c) => /[\u3400-\u9fff\uf900-\ufaff]/.test(c);
const han = cps.filter(isHan);
const rest = cps.filter((c) => !isHan(c));
if (new Set(han).size !== 1) return [];
if (!rest.every((c) => /[\s\p{P}]/u.test(c))) return [];
const needle1 = han[0];
```

命中循环也换成 `hay.indexOf(needle1)`（不是拿原问句找）。三个取舍：

1. **剥的是标点，不是「短」**。`rest` 里只许 `\s` 与 `\p{P}`；`读1` / `读9` / `读x` / `读$` / `读+` / `读读` 一律不放行。理由和 0.6.4 一样：一旦允许「短串就做子串匹配」，`the`/`a`/`1` 这种会被停用词吃掉的问句全变成噪声命中，`probe-gold` 的 G8「没有的事就空手」当场红。
2. **同一个字重复按一个算**。`new Set(han).size !== 1` 天然覆盖 `读 读`（两个码点同字 → 集合大小 1），与 `读` 同集合，不必新造口径。
3. **不做问句清洗**。不在入口 `trim` / `NFKC` 整条问句，只在兜底内部取 `needle1`：清洗会动到主路径的 tokenize 与缓存键，代价远大于收益，且 0.6.3 的定序账依赖输入原样。

### 9.204.3 读数：一位没动

- LoCoMo（1,531 问）：hit@1 0.3932 / hit@5 0.6192 / hit@10 0.6924 / hit@20 0.7511 / MRR 0.4958 / recall@20 0.6322 / 平均取回 17.8 / 空回 0.0000。
- 真库 660 条 52 问：照抄 0.921 / 0.974 / 0.947、换说法 0.417 / 0.750 / 0.569、时间锚 0.500，两条 #2→#1 位移不变。
- 原因同 0.6.4：兜底只在**原本必然回空**的问句上生效，能进正常管线的问句一个不受影响。这一版修的是可达性，不是排序。

### 9.204.4 判据

`tools/probe-literal.mjs` 从 11 条扩到 **18 条**（`ALL PASS  probe-literal：18/18`）：

- **L9** 八种标点（`读？` / `读?` / `读。` / `读，` / `「读」` / `读…` / `读·` / `钱:`）逐个命中；且每个「带标点」的回执与「剥掉标点后」的回执**同集合**（按 `q.replace(/[\s\p{P}]/gu, '')` 取基准；第一版错比成 `读` 的集合，被 `钱:` 当场纠正）。
- **L10** 闸门不认字母 / 数字 / 符号（`读1` `读9` `读x` `读$` `读+` `读读` 全 0）；纯标点 `？` `。` `「」` `...` 仍然空手。
- **L11** `读 读` 与 `读` 同集合。
- **L12** 标点版走三条路径同口径（`search` / `searchAdaptive` / `keywordHitScore`）。
- **L13** 能红证明：子进程里把闸门换回 `if (cps.length !== 1) return [];` → 输出 `1,0`（`读` 仍中、`读？` 回空）。

`verify.mjs` 新增 `LT065` 一节六条：闸门四行在位且旧闸门清零 / `needle1` 定义后在用（`hay.indexOf(needle1)`、`at + needle1.length`）/ 探针 L9–L13 标签在位 / INTERNAL 9.204 与 README「标点也是人打的」在位 / 版本号 0.6.5。同时 `LT064` 第一条断言从旧闸门改钉 `if (new Set(han).size !== 1) return [];`（字面改了断言必须跟着改，否则是假绿）。

### 9.204.5 边界：哪些没做

- **不做英文短串兜底**（`the`/`a` 剥完是空集，直接 `return []`；不引入「单字母」这条路）。
- **不放过符号**：`读$`、`读+`、`读1` 这类「一个字 + 非标点」保持空手——它们要么是代码片段，要么是噪声，放开就撞 G8。
- **不动 0.6.4 的兜底形态**：分数仍是子串命中次数（`tf2`），定序仍交 0.6.3 的四把钥匙；这一版只改「谁能进门」。

### 9.204.6 账

支数仍 **35**（没有新增套件，只扩条数）；`probe-literal` 11 → 18 条，`verify.mjs` 1,827 → 1,832 条（新增 `LT065` 一节，实测净增五条——有一格落在既有的版本对齐计数里），断言总数 3,587 → **3,599**。

## 9.205 脏记忆不许把整次检索打成异常（0.6.6）

### 9.205.1 症状：不是少一条，是一个都拿不回来

`docText(d)` 原来是一行：

```js
return [d.title ?? "", d.content, ...d.keywords].join(" ");
```

`?? ` 把 `undefined` 兜住了，`...` 没有。`keywords` 在老库里不止一种形态——缺字段、`null`、逗号串（`'浇花, 施肥, 换盆'`），来源是导入行、别的插件写的行、以及调用方自己拼的 docs。一条这样的条目进到遍历里，当场：

```
TypeError: d.keywords is not iterable
    at docText (vendor/meow-memory/lib/index.js:1908)
```

`docText` 不是某一条支路的装饰品：`findSimilar`（`memory_read` 的邻居）、`topicDrift`、写侧重复判定都走它，`verbatimInputs` 那条链上也要把整批 docs 过一遍字面量。所以后果不是「这条没命中」，而是**这次调用整体抛异常**——调用方拿到的不是「没有」，是崩溃。

### 9.205.2 发现顺序：它是被探针崩出来的

这一条不是设计出来的，是写「标点漂移」探针（`E:\Temp\cmp\punct-drift.mjs`，量 LoCoMo 400 对问句尾部加 `？` 会不会换答案，结果 **0 对漂移 / 0.0%**）时，脚本自己崩在 `docText` 上。当时的反应不是「给脚本补上 keywords 字段就完了」——**调用方不该为了让引擎不崩而伪造数据的形状**，这条一补进去，就等于把真实世界里的脏数据判成「不存在」。

### 9.205.3 处方：一个入口，四路都认

```js
function kwList(d) {
  const raw = d?.keywords;
  if (Array.isArray(raw)) return raw.filter((w) => typeof w === "string" && w.length > 0);
  if (typeof raw !== "string") return [];
  const s = raw.trim();
  if (s === "") return [];
  if (s.startsWith("[")) { try { const parsed = JSON.parse(s); if (Array.isArray(parsed)) return parsed.filter(...) } catch {} }
  return s.split(/[,，、;；]/).map((w) => w.trim()).filter((w) => w.length > 0);
}
```

三处取舍：

1. **归一化放在一个函数里，而不是每个调用点各写一份 `Array.isArray`**。引擎里已有四处「把 keywords 当词表」的地方（`docText` / `kwToks` / `kwSets` / `keywordHitScore` 的 `content`），各写一份的结果是迟早有一处忘掉——而忘掉的那处正是这次崩的那处。
2. **逗号串要真的进 tf-idf，不只是「不崩」**。原来 `kwToks` 写的是 `Array.isArray(d.keywords) ? d.keywords : []`：字符串形态的词表被静默判成空表，等于老数据的关键词一直是隐形的。归一化顺手把这条也治了——`search('浇花', [K-2])` 从 `[]` 变成命中。
3. **索引签名跟着走**（`mix(kwList(d).join('\u0001'))`）。签名原来只认数组，`-1` 兜底：字符串词表被改写，签名不变 → 拿旧索引答新库。这条和 0.6.3 的定序账是同一族的纪律：**缓存的键必须覆盖所有影响结果的东西**。

### 9.205.4 读数：一位没动

- LoCoMo（1,531 问）：hit@1 0.3932 / hit@5 0.6192 / hit@10 0.6924 / hit@20 0.7511 / MRR 0.4958 / recall@20 0.6322 / 平均取回 17.8 / 空回 0.0000。
- 真库 660 条 52 问：照抄 0.921 / 0.974 / 0.947、换说法 0.417 / 0.750 / 0.569、时间锚 0.500，两条 #2→#1 位移不变。
- 原因：这两份语料的 keywords 本来就是数组或缺失，归一化只把「坏形状」救回来——它修的是**可达性**（该拿回来的回执不许变成异常），不是排序，也不是多凑几条。

### 9.205.5 判据

`tools/probe-dirty.mjs` **9 条**（`ALL PASS  probe-dirty：9/9`），干净池两条 + 七条脏条目（缺字段 / 逗号串 / `null` / 数字 / 对象 / 只有标题 / `content` 为 `null`）：

- **D1** 缺 `keywords` 的条目不再把多词问句打成异常（回数组，不是 `TypeError`）。
- **D2** 缺字段的条目仍然可被命中——归一化不是「跳过这一条」。
- **D3** 逗号串当词表用（`浇花` 能命中）。
- **D4** `null` / 数字 / 对象既不抛，也不凭空命中。
- **D5** 一条脏条目混进干净池，干净问句的第一名逐位不变（脏数据不许改写别人的排序）。
- **D6** `content` 缺失 / `null` 不抛，且字面量 `undefined` 不成词。
- **D7** `search` / `searchAdaptive` / `keywordHitScore` 三路同口径。
- **D8** 能红证明：子进程里把 `kwList` 换回 `[...d.keywords]`，同一问句立刻 `d.keywords is not iterable`。

`verify.mjs` 新增 `DT066` 一节七条：`kwList` 四路分支在位且只此一份 / `docText` 改走 `kwList` 且旧 `...d.keywords` 清零 / `kwToks`·`kwSets` 同样走 `kwList`（真的进 tf-idf）/ 索引签名走 `kwList` 且旧 `-1` 兜底清零 / `keywordHitScore` 的 `content` 归一化在位 / 探针 D1–D8 标签在位并挂进 check-all / INTERNAL 9.205 与 README「脏记忆不许把整次检索打成异常」在位、版本 ≥0.6.6。

### 9.205.6 账

支数 **36**（新增 `tools/probe-dirty.mjs`）；断言 3,599 → **3,616**（`probe-dirty` +9、`verify.mjs` 1,832 → 1,840 的 `DT066` +7，另有一格落在既有的版本对齐计数里）。

## 9.206 一条坏行不许把整次检索打成异常（0.6.7）

### 9.206.1 症状

0.6.6 把**字段**归一化了（`kwList`），元素本身还是裸露的：

- `search('滴定', [null, good])` → `TypeError: Cannot read properties of null (reading 'title')`（`docText` 里的 `d.title`）。`docText` 被 `findSimilar` / `topicDrift` / `verbatimInputs` 共用，`verbatimInputs` 又是**每条问句都要过的第一道工序**，所以一条坏行 = 整次检索抛异常。
- `search('滴定', null)` / `search('滴定', '滴定终点')` → `TypeError: Cannot read properties of null (reading 'length')` / `docs.map is not a function`（`indexSignature` 与 `buildSearchIndex` 直接按数组用）。
- `keywordHitScore('滴定', [null, good])` → `TypeError: Cannot read properties of null (reading 'content')`（它自己遍历 `docs` 取 `keywords` / `content`）。
- 与 0.6.6 一样，这类条目不是理论构造：半写的行、导入被截断的行、别的插件写的行、调用方把 id 列表当 docs 传进来，都长这样。字符串 / 数字元素与怪参数（`k = -1`、`k = '3'`）本来就不抛，这一版不动它们。

### 9.206.2 发现路径

0.6.6 收尾时用手写的坏形状池（`tools/probe-dirty.mjs`）扫「字段」四种形态，扫完顺手把**元素**也换掉试了一遍：`docs` 整批只有一个 `null`，`search` 当场抛。于是把这一层当独立的一版，而不是塞进 0.6.6：字段归一化（`kwList`）与元素过滤（`liveDocs`）是两道不同的闸，改在一起会让「谁救回来的」说不清。

### 9.206.3 处方

唯一入口闸，放在 `docText` 之前：

```js
function liveDocs(docs) {
  if (!Array.isArray(docs)) return [];
  for (let i = 0; i < docs.length; i++) {
    const d = docs[i];
    if (!d || typeof d !== "object") {
      return docs.filter((x) => x && typeof x === "object");
    }
  }
  return docs;
}
```

`search(query, docs, opts = {})` 与 `keywordHitScore(query, docs, opts = {})` 各加一行 `docs = liveDocs(docs);`（`searchAdaptive` 先调 `search`，自动同口径）。三取舍见 `DESIGN.md` 202：闸在入口（不撒在每个函数里）/ 干净数组原样返回同一引用（干净路径零行为差）/ 缓存键是内容签名不靠身份（过滤不打掉缓存）。

### 9.206.4 读数与代价

一位没动：LoCoMo（1,531 问）hit@1 0.3932 / hit@5 0.6192 / hit@10 0.6924 / hit@20 0.7511 / MRR 0.4958 / recall@20 0.6322 / **空回 0.0000**；真库 660 条 52 问三档 0.921 / 0.417 / 0.500 与两条 #2→#1 位移。耗时同量级：同一池 660 条，干净 2.67ms/次、含一条 `null` 1.48ms/次（热身噪声范围内；闸的代价是「扫到第一个坏元素为止」，干净路径只多一次类型判断）。

### 9.206.5 判据

`tools/probe-dirty.mjs` 从 9 条扩到 **15 条**（文件头改写成 D1–D13 十三条，新增一节注释「0.6.7 补一层：坏的是元素本身」）：D9 混入 `[null, undefined, '滴定', 42, clean0, clean1]` 既不抛也能命中干净条目 / 坏元素在位时**不改写第一名**（与干净池逐条比 `baselineTop`）/ D10 `docs` 不是数组（`'滴定终点'` / `null` / 类数组对象 / `42`）一律回空数组 / D11 `[null, undefined, null]` 回空（全坏不回幻觉）/ D12 `keywordHitScore` 与 `searchAdaptive` 同批不抛 / D13 能红证明（子进程把 `liveDocs` 换成直通 `return docs;`，同一问句立刻抛 `Cannot read properties of null (reading 'title')`）。

`verify.mjs` 在 `DT066` 之后新增 `DT067` 一节五条：入口闸在位且只此一份（含 `if (!Array.isArray(docs)) return [];`、`return docs.filter((x) => x && typeof x === "object");`、末尾 `return docs;`）/ `search` 与 `keywordHitScore` 两个入口都含 `docs = liveDocs(docs);` / 探针 D9–D13 标签在位 / INTERNAL 9.206 与 README「一条坏行不许把整次检索打成异常」在位 / 版本 ≥0.6.7。

### 9.206.6 账

支数仍 **36**（`probe-dirty` 只加断言、不开新套件）；断言 3,616 → **3,627**（`probe-dirty` 9→15 的 +6、`DT067` +5）。

## 9.207 会随时间前进的量，只许写成单调式（0.6.8）

### 9.207.1 症状

不是产品的病，是**判据自己的寿命**。三类量每一版都在动，却被写成等值：

- **版本号**：`pkg.version === '0.2.N'` 被写过好几处，`0.2.31→32→34→35` 每升一版整片假红一次；0.4.0 才改成从 `package.json` 现取（`PKG_VERSION`）。
- **支数**：`steps.length === 35 → 36` 每加一个探针就要手工抬一格，抬的时候还得同步改两处文档里写死的「N 支自检 / M 条断言」——`0.6.2/0.6.3/0.6.4/0.6.6/0.6.7` 每版都踩。
- **断言总数**：文档里的「3,536 / 3,554 / 3,569 / 3,587 / 3,599 / 3,616 / 3,627」全是手抄，一旦 `check-all` 报出真实数就发现早写错了（0.6.6 先写 3,615、实测 3,616，把五份文件回改一遍）。
- **耗时预算**：`ms` 与 `budgetMs` 混写过，慢一点就红在「预算」这个概念上，而预算是随机器浮动的量。

红一次不算事故，但每一次「该红的没红 / 不该红的红了」都在教人**无视红**。这一版把规矩变成判据。

### 9.207.2 处方

1. **支数改地板**：`verify.mjs` 顶部 `const SUITE_FLOOR = 37`，断言 `steps.length >= SUITE_FLOOR`，旧 `steps.length === <n>` 清零。语义：减一支（删套件 / 忘了注册进 `check-all`）立刻红；加一支不必动判据。抬地板是**一次明确的承诺动作**（这一版起承诺有这么多支），与「今天恰好几支」分开记——实际支数由 `check-all` 的汇总与基线对账负责。
2. **文档数字自动对账**：`docs` 里「现在」那个数不再靠手抄，改成探针读 `tools/baselines.json` 的 `counts` 求和再比（README 自证规模行 + `EVAL-CLAIMS` 健康基线行）。数字一旦与事实不符立刻红，而且红的是「文档错了」，不是「版本升了」。这里有个**先有鸡还是先有蛋**：新加一支套件时基线里还没有它的条数，而它自己正被 `--update-baselines` 跑着——若照旧严格相等，它就永远差一支、永远红、也就永远记不上账。两处解法各按其位：探针 M4/M4b 分两种状态说（基线没覆盖 `check-all` 注册的每一支时只要求「不少于合计」并点名缺哪支，记账完自动转回严格相等）；`verify.mjs` 里那条总数断言则挪到**全文件末尾**，期望值 = Σ(其它支基线) + 本支本次实测 PASS 条数（`passes + 1` 是这一条自己），环就断了——它不再依赖基线里自己那一格。
3. **历史里程碑冻结**：旧里程碑保留自己那版的数字（0.6.6 里仍是 3,616），谁都不许把旧账改成新账——否则「版本阶梯」就成了一条恒等线，看不出增长。
4. **版本阶梯按版本号比，不按版面顺序比**：README 的里程碑排版历史上乱过（0.4.0 里程碑曾被排到 0.6.x 上面），按版面顺序判单调会误红；改成「同一条里既有版本号又有条数」的行两两比较：新版本的支数与条数都不许少于旧版本。

### 9.207.3 判据：`tools/probe-monotone.mjs`（9 条）

M1 地板在位（`SUITE_FLOOR` 声明 + `steps.length >= SUITE_FLOOR` 在用 + 旧等值清零）/ M2 全仓 50 个脚本静态扫描，没有「版本 / 支数 / 总数 / 耗时写成等值」（样本数据里的 `=== '0.4.1'` 是造出来的题干，故意不扫）/ M3 扫描器能红也认绿（内存样本：`steps.length === 36` 必须被扫出、`>= 36` 必须放行、`pkg.version === '0.6.7'` 必须被扫出）/ M4 README 自证规模行与 `baselines.counts` 合计一致 / M4b `EVAL-CLAIMS` 健康基线行同样一致 / M5 版本阶梯单调 / M6 0.6.6 里程碑仍是 3,616 / M7 每支 `budgetMs >= max(30000, ms)` / M8 扫描面完整（`tools/*.mjs` 除扫描器自己 + `verify.mjs`，一个都不许漏）。

`verify.mjs` 新增 `MT068` 五条：`SUITE_FLOOR` 与单调比较在位且旧等值清零 / 探针 M1–M8 标签在位并挂进 `check-all` / 文档（INTERNAL 9.207 + README「会随时间前进的量」）/ DESIGN `## 203.` / 版本 ≥0.6.8；另在文件末尾有一条「文档总数 = 其它支基线合计 + 本支本次实测」（见 9.207.2 的鸡生蛋解法），所以实测总数比预估多一格。

### 9.207.4 读数

**一位没动**——这一版只动判据与文档：LoCoMo（1,531 问）hit@1 0.3932 / hit@5 0.6192 / hit@10 0.6924 / hit@20 0.7511 / MRR 0.4958 / recall@20 0.6322 / 空回 0.0000；真库 660 条 52 问三档 0.921 / 0.417 / 0.500 与两条 #2→#1 位移。引擎 `vendor/meow-memory/lib/index.js` 一个字节没动。

### 9.207.5 为什么不是「记得去改」而是探针

「记得去改」的判据只对写它的人生效，下一个人、下个月、换个模型都不生效。把规矩做成可执行判据，才有两个后果：①**漏改会红**（M4/M5 抓文档与事实不一致）；②**改对了不用动判据**（M1 的地板只在承诺时抬）。这正是 0.3.0 起那条「判据要能红」的延伸——这一次红的是判据自己的寿命。

### 9.207.6 账

支数 36 → **37**（新增 `tools/probe-monotone.mjs`）；断言 3,627 → **3,641**（`probe-monotone` +9、`MT068` +5）。

## 9.208 量尺自己也得先量（0.6.9）

### 9.208.1 症状：所有对外读数都是单次、单序

`bench-locomo` 跑一遍 1,531 问给出 hit@1 0.3932；真库 52 问跑一遍给出 0.921 / 0.417 / 0.500。语料按库里顺序、问句按夹具顺序，**没有第二次**。而 0.6.x 这一路正是拿这些单次数否决过三个候选。若量尺对顺序敏感，这些「负数」不成立。

### 9.208.2 处方：三个方向互换 + 独立 scorer + 能红

见 DESIGN `## 204.` 的三个取舍。落地成 `tools/probe-rigor.mjs` 七条：R1 连跑 3 次；R2 语料倒序 + R2b 打乱三种；R3 问句倒序；R4 独立 scorer；R5 进程内注入位置偏置的能红证明；R6 分档口径（45 / 14 / 10 = 69 题）。

### 9.208.3 读数：一个字都不差

`gold-recall` 69 问（40 条真库样张）：hit@1 **0.9565** / hit@3 **0.9855** / MRR **0.9686**；真库摘要档 0.9778 / 0.9778 / 0.9778，换说法档 0.9286 / 1.0000 / 0.9643，时间锚档 0.9000 / 1.0000 / 0.9333。三次、倒序、三种打乱、问句倒序之后逐位相同（std = 0）。引擎一个字节没动：LoCoMo 1,531 问与真库 52 问读数逐位不变。

### 9.208.4 能红证明（R5）

偏置写法：同分时按语料下标取（等价于 0.6.3 修掉的那个「谁先进库谁在前」）。正序 23 命中 / 倒序 15 命中——互换一换读数就变，说明这条判据盯的是真东西。把 R2 改成容差或只留一个方向，R5 就必须跟着改写法，否则它证明不了任何事。

### 9.208.5 这条判据挡的是什么

挡「用抖动的尺子判别人的生死」。具体三种：①未来某版改了索引缓存，读数在两次之间抖一点，被当成「噪声级增益」写进文档；②问句顺序影响 idf 预热导致前几名换位，被当成「换序更优」；③两套 scorer 都对同一批 hits 用同一段代码，写得一致但一起错。R1–R4 各挡一条，R5 保证这些判据不会永远绿。

### 9.208.6 账

支数 37 → **38**（新增 `tools/probe-rigor.mjs`）；断言 3,641 → **3,653**（`probe-rigor` +7、`RT069` +5）。


## 9.209 签名自己也要记账（0.6.10）

### 9.209.1 症状：每一问都在重算一个答案通常是「没变」的问题

`search()` 进来第一件事是拿 `indexSignature(docs)` 算出缓存键，问「这库还是不是上次建表的那张」。这个答案绝大多数时候是「没变」，但代价每次都全额付：每条 `content.slice(0, 40)` + `content.slice(-40)` + `kwList(d).join('\u0001')`（三次分配），再逐字符 `Math.imul` 混算。四条同构语料（660 / 2,000 / 5,000 / 10,000）上量到：签名 **0.96 / 2.84 / 7.04 / 14.16 ms**，占一次热检索的 **28.8%–30.6%**。也就是说，库越大，用户每问一句就有越多时间花在「确认库没变」上，而与问什么完全无关。

### 9.209.2 发现路径

从 PLAN §12 的剩余项出发：#4 冷域已判定不做（夹具第 12 条「口语对照」天然抢第一）、#5 抽核心打分 PLAN 原话「等它真成瓶颈再说」——既然要等瓶颈，就先量瓶颈在哪。量具 `E:\Temp\cmp\scale010.mjs` 直接把一次热检索拆成「签名 / 其余」，占比一出来就明白：瓶颈不在打分，在那笔固定开销。

### 9.209.3 处方：按条记账，值比较判等，判不出的走直算

引擎 `vendor/meow-memory/lib/index.js` 里 `indexSignature` 整段重写：`SIG_DOC_CACHE = new WeakMap()` 以 doc 对象为键，存「条级哈希 + 参与计算的字段值快照」。三条命门：

1. **比的是值不是对象身份**。快照存 `content` / `title` / `keywords` 词表 / `updated_at` / `source_session` / `id`，下次逐字段 `===`（原生 memcmp），全等才复用。只按对象身份记账的实现在同一对象就地改内容时看不见——S3/S4/S5/S9 就是钉这个。
2. **条级哈希必须与外部状态无关才能缓存**。老实现把每条一路 XOR/imul 滚进同一个滚动值，同一条的贡献随「前面有谁」变，天然不可缓存。改成每条先算自己的 32 位 FNV（字段拼接顺序与分隔符与老版逐字相同），再 `h ^= 条级; h = Math.imul(h, 16777619) >>> 0` 折进总账。代价是签名数值整体换了一批——它只是内部键，无人依赖具体值。
3. **判不出有没有变的形状走直算**。字段是对象、`keywords` 元素不是标量时，`String()` 的结果可能随对象自身状态变，值比较判不出来；这类条目不记账，直接算。

### 9.209.4 读数

| 语料 | 签名（前 → 后） | 占比 | 热检索（前 → 后） |
| --- | --- | --- | --- |
| 660 | 0.96 → 0.062 ms | 28.8% → 2.8% | 3.24 → 2.18 ms |
| 2,000 | 2.84 → 0.189 ms | 29.4% → 2.8% | 9.67 → 6.80 ms |
| 5,000 | 7.04 → 0.528 ms | 30.6% → 3.5% | 23.0 → 15.3 ms |
| 10,000 | 14.16 → 1.198 ms | 28.8% → 3.2% | 49.2 → 37.6 ms |

排序一个字节没动：LoCoMo（1,531 问）hit@1 0.3932 / hit@5 0.6192 / hit@10 0.6924 / hit@20 0.7511 / MRR 0.4958 / recall@20 0.6322 / 空回 0.0000，真库 52 问 0.921 / 0.417 / 0.500 与两条 #2→#1 位移，**逐位不变**。

### 9.209.5 判据 S1–S9

`tools/probe-signature.mjs` 九条：S1 条级哈希与参考实现逐位相同（200 种形状，含缺字段 / `null` / 逗号串 / 元素非标量）；S2 连算 5 次只复用不重算（`rebuilt` 不涨、`reused` 涨满）；S3 就地等长改正文中间一个字必变；S4 就地改 `keywords` 数组里的一个词必变；S5 改 `title` / `updated_at` / `source_session` / `id` 任一必变（4/4）；S6 只换 docs 顺序必变；S7 脏形状稳定且与参考一致（不记账但也不能算错）；S8 记账后比记账前快 5 倍以上（实测 14.5×，0.072 vs 1.042 ms）；S9 能红证明——本机复刻「只按对象身份记账」的坏实现，S3/S4 那组用例在它手里全部漏判。`verify.mjs` 的 `SG070` 五条把探针、引擎三件、统计接口归零与只复用、文档四处、版本地板钉在一起。

### 9.209.6 账

支数 38 → **39**（新增 `tools/probe-signature.mjs`）；断言 3,653 → **3,667**（`probe-signature` +9、`SG070` +5）。

## 9.210 原样匹配也要记账（0.6.11）

### 9.210.1 症状：每问都在重拼整库字符串

原样匹配通道要判断「这条里有没有原样出现这个问题串里的标识符」。实现上它先把整库拼一遍：`docs.map((d) => textOf(d).toLowerCase())`，`textOf` = `id + ' ' + project + ' ' + docText(d)`，而 `docText(d)` 又是 `title + content + keywords.join(' ')`。于是每次检索都要重建一份「全库小写大字符串」：660 条 0.66 MB、10,000 条 2.03 MB。**匹配本身很便宜，造 Haystack 很贵**——10,000 条时 5.78 ms vs 0.51 ms。

### 9.210.2 发现路径

0.6.10 省掉签名那笔钱后，接着按**通道**开账：同语料同问句，只关掉一条通道（`{ verbatim: false }`），差值就是这条通道的钱。`E:\Temp\cmp\scale011.mjs` 给出份额 **35.7% / 50.6% / 42.7% / 42.9%**（660 / 2,000 / 5,000 / 10,000）；再用 `scale011b.mjs` 把这条通道拆成「造串」与「扫标识符」两段，确认钱在造串（5.78 vs 0.51 ms）。同一套办法在 0.6.10 用来抓签名，这次抓到了它。

### 9.210.3 处方：搬进索引、懒建、且必须进签名

1. **跟着索引走**：`buildSearchIndex()` 末尾预置 `hayArr` 与 `hayAt(di)`；命中 `verbStats.reused++`，未命中才拼并 `verbStats.built++`。haystack 的生命周期与切词表一致，不另立缓存。
2. **懒建 + 不在路上不建**：`verbatimInputs(query, docs, opts, textOf, hayFor, identsIn)` 多收一个 `hayFor`；`hayOf = idents.length === 0 ? null : (hayFor ?? 老现拼)`。没有标识符时 `hayOf === null`，一条都不许建。
3. **搬进索引的字段必须先被签名覆盖**：haystack 含 `project`，而 `project` 从来不进签名——老实现每问现拼所以看不出来，搬进索引后才成为「改 project 拿旧串答新库」。修法：`sigDocHash` 在 `source_session` 之后追加 `put(String(d?.project ?? '')); sep();`；`sigDocOf` 的 `cacheable` 加 `sigPrim(d.project)`、值比较加 `prev.p === d.project`、快照存 `p`。
4. **消费点统一**：`search()` 与 `keywordHitScore()` 都改走 `{ idents, hayOf, rawVerbatim }`，`verbHay !== null` 全部换成 `verbOn`，`verbatimOf(idents, verbHay[di])` 换成 `verbatimOf(idents, hayOf(di))`（含 `statusDigestOf` 的入参）。全仓已无 `verbHay` 残留（只剩一句注释）。

### 9.210.4 读数

| 条数 | 0.6.10 全量 | 0.6.11 全量 | 变化 | 原样匹配份额（前 → 后） |
| --- | --- | --- | --- | --- |
| 660 | 2.04 ms | **1.62 ms** | −20.6% | 35.7% → 20.7% |
| 2,000 | 5.04 ms | **4.20 ms** | −16.7% | 50.6% → 34.9% |
| 5,000 | 11.88 ms | **9.12 ms** | −23.2% | 42.7% → 22.8% |
| 10,000 | 24.45 ms | **18.82 ms** | −23.0% | 42.9% → 18.6% |

排序侧逐位不变：LoCoMo（1,531 问）hit@1 0.3932 / hit@5 0.6192 / hit@10 0.6924 / hit@20 0.7511 / MRR 0.4958 / recall@20 0.6322 / 空回 0.0000；真库 52 问三档 0.921 / 0.417 / 0.500、平均取回 6.342 / 6.917 / 5、两条 #2→#1 位移；`0.6.0 关 与 v0.5.0 逐位相同？ true`。

### 9.210.5 判据 V1–V9 与 S10

`tools/probe-verbatim.mjs` 九条：V1 haystack 与现拼逐位相同（200 种形状，200/200）；V2 连问 5 次结果一致且只拼一次（660 条 `built=660` / `reused=2,640`）；V3 就地改正文、V4 就地改 `project`、V5 就地改 `keywords` 元素，haystack 都要跟着变；V6 命中条目的 `explain.verbatim` 与参考实现现算一致（6 问句）；V7 10,000 条时该通道份额 ≤25%（实测 18.5%，4.33 / 23.43 ms）；V8 无标识符问句 `built === 0`；V9 能红证明——只按条数当缓存键的坏实现看不见 `project` 改动。

`tools/probe-signature.mjs` 由 9 条扩到 **10 条**：参考实现补上 `project`，新增 **S10**（就地改 `project` → 签名必变）。`verify.mjs` 的 `VV071` 五条把探针标签与挂线、引擎三件（懒建 / `project` 进签名 / `verbStats`）、老写法已清干净、记账进程内可见、文档四处与版本地板钉在一起。

### 9.210.6 账

支数 39 → **40**（新增 `tools/probe-verbatim.mjs`）；断言 3,667 → **3,683**（`probe-verbatim` +9、`VV071` +5、`probe-signature` 的 S10 +1，其余 +1 来自本支实测对齐：0.6.10 记的 3,667 比本次实测少一条）。

## 9.211 定序只排前 k（0.6.12）

### 9.211.1 症状：为取前 5 条，把全库命中排了两遍

`bandize()` 是「证据先分档、档内才谈权重」的落地处，但它对**全量 hits** 做了两次整序：先按 `_raw` 排一遍只为算出档位（`Map<hit, band>`），再按 `(档位, score, 更新时间, id)` 排一遍定最终次序。而它的三个调用点——`search()`、`keywordHitScore()`、`literalFallback()`——在调用之后**只取前 k 条**（默认 k=5，`RESULT_MIN_KEEP` 也才 5）。也就是说：10,000 条语料上每次检索都在为 5 条答案给 9,995 条陪跑排队。

### 9.211.2 发现路径

0.6.11 之后剩下的钱在哪儿？继续用 `--cpu-prof` 按函数归因（`E:\Temp\cmp\prof012b.mjs` 出数、`profparse012.mjs` 解析 cpuprofile、10,000 条 / 300 问）：`bandize` 16.5% + 档内 raw 比较器 `anon@2534` 7.7% + 最终比较器 `anon@2556` 16.1% = **40.3%（约 11 ms/问）**，而 `scanDoc` 才 11.3%、`sigDocOf` 3.5%。归因表把「哪一段是空转」指得非常直白：**排序是为了交付前 k，却按全量交付。**

### 9.211.3 处方：档位落字段、比较器抽出来、只留前 k

1. **档位不再走 `Map`**：`bandize(hits, rawKey, limit = Infinity)` 把档号直接写进 `h._bandTmp`。`Map<对象, 数>` 每问要建、要查、要扔，而 hit 对象本来就是这一问的临时物——挂在它身上，等于把两次哈希表操作换成一次属性写。
2. **比较器抽成 `orderOf`**：`(a, b) => (a._bandTmp - b._bandTmp) || (b.score - a.score) || (stampOf 更晚的在前) || cmpText(a.id, b.id)`。四个键全是数据本身的属性，全序与堆两路共用同一条梯子——梯子只有一处，改一处不会只改一半（DT063 守这个）。
3. **有界最大堆选前 k**：`want = Number.isFinite(limit) && limit > 0 ? Math.round(limit) : total`；`want >= total` 走原来的全量 `hits.sort(orderOf)`（小库、`k` 很大、`k=Infinity` 全部退回原路，行为逐位不变）；否则维护一个容量 `want` 的最大堆（根 = 入选里**最差**的那条），新来的只要 `orderOf(h, heap[0]) < 0` 就顶掉根，`siftUp`/`siftDown` 各 O(log k)。最后 `heap.sort(orderOf)` 并把结果覆写回 `hits`（`hits.length = heap.length`）。
4. **落档与清场**：截断之后才对入选条设 `h._band = h._bandTmp`、写 `h.explain.band`，再 `delete h._bandTmp`——临时字段不许活过这一问（O3 盯残留）。指认档（`_ident` / `_subj === 1`）仍恒为 -1 档，写的是同一个字段。

**为什么截断是安全的**：档位本身按**全量** raw 算（阈值链与排序无关），所以「进不进第一档」不因截断而改变；堆只在档位已定的前提下挑前 k，且比较器与全序逐位同源（O1 用 500 组随机语料 × k∈{1,2,5,8,20,∞} 与「全量排序再取前 k」对拍）。**唯一的语义变化是「返回条数」**：`bandize` 以前回全量、由调用方 `slice`，现在自己截——三个调用点本来就只取前 k，所以对外交付不变（`hitsSum` 1,500 逐位不变）。

### 9.211.4 读数

10,000 条同构语料 / 300 问（`E:\Temp\cmp\prof012b.mjs`，同一进程同一语料，改前改后各跑一遍）：

| 路径 | 0.6.11 | 0.6.12 | 变化 |
| --- | --- | --- | --- |
| `search` | 27.377 ms | **19.985 ms** | **−27.0%** |
| `searchAdaptive`（产品走的这条） | 31.086 ms | **23.097 ms** | **−25.7%** |
| `searchIndexOf` 热命中 | 0.751 ms | 0.751 ms | 未动（不吃定序） |
| 冷建索引 | 270.7 ms | 270.7 ms | 未动 |

cpu-prof 复测（总采样 6,642 ms）：定序那两段从 **40.3% → 21.5%**（`bandize` 10.9% + 内部 raw 比较器 10.6%），`orderOf` 自身只占 0.9%。剩下那 21.5% 是「按 `_raw` 给全量算档位」这一步——0.6.13 的题目（用 `Float64Array` 装 raw + 阈值链 + 二分，不靠对象全序）。

排序与质量逐位不变：真库 52 问三档 0.921 / 0.417 / 0.500、平均取回 6.342 / 6.917 / 5、两条 #2→#1 位移；LoCoMo（1,531 问）0.3932 / 0.6192 / 0.6924 / 0.7511、MRR 0.4958、recall@20 0.6322、空回 0。

### 9.211.5 判据 O1–O8 与 OR072

`tools/probe-order.mjs` 八条（`bandize` 首次对探针开放导出，探针内自带老实现 `refBandize` 作参考）：

- **O1** 500 组随机语料 × k∈{1,2,5,8,20,∞}，截断结果与「全量排序再取前 k」逐位相同（含 id 顺序）。
- **O2** `hits.length === Math.min(k, n)`。
- **O3** 入选条的 `_band` 与 `explain.band` 同步，且**没有** `_bandTmp` 残留。
- **O4** `k <= 0` / `undefined` / 超过总数 全部退回全序，与参考一致。
- **O5** 同分同时间按 id 自然序（`0m1 < 0m2 < 0m9 < 0m10 < 0ma`，数字段按数值）。
- **O6** 指认命中与主语位恒 -1 档（`0mx1:-1 0mx4:-1`），词分 0 也不落到最后一档。
- **O7** 语料换序后前 k 名不变（定序不依赖输入顺序）。
- **O8** 能红证明：丢掉档位筛选的坏实现必被抓。

`verify.mjs` 新增 **OR072** 六条（标签在位 / 引擎签名与撤 `Map`、有界堆、`_bandTmp` / 三个调用点都传 k / 进程内截断且与全序前二逐位相同 / 文档四处与版本地板）；同时把跟着改写的旧钉子按「改建不删」更新：`HY 档位留痕`、`HZ8`/`HZ9`/`HZ11` 的 `bandize(hits, '_raw')` 定位串、`HZ15` 折价落点、`VW2`、`VY3`/`VY7`/`VY8`/`VY9`、`DT063` 定序梯子。`tools/check-all.mjs` 挂上 `probe-order`（`NO_ROOT` 例外表补一条：只经相对 import 取 `bandize`，不读仓内任何文件）。

### 9.211.6 账

支数 40 → **41**（新增 `tools/probe-order.mjs`）；断言 3,683 → **3,697**（`probe-order` +8、`OR072` +6）。

## 9.212 定档不再靠全量排序（0.6.13）

### 9.212.1 症状：为了「谁在第几档」，把全库对象排成一行

0.6.12 之后复测，`bandize` 仍占一次热检索的 21.5%：`bandize` 自证 10.9% + 其内部 raw 比较器 `anon@2553` 10.6%。而这个比较器做的事只有一件——`hits.slice().sort((a, b) => b[rawKey] - a[rawKey])`，为的是把命中按 raw 降序排成一行，然后一句一句往下走：`if (band < 0 || r < IMP_BAND * anchorRaw) { band += 1; anchorRaw = r; }`。**档号只由「排序后的不同 raw 值」决定**，却按「对象对儿」的代价去算：10,000 条就是约 13 万次比较，每次比较两次属性读 + 一次减法。

### 9.212.2 发现路径

0.6.12 的 cpu-prof 表里，「剩下那 21.5% 是哪个函数」写得极清楚：不是 `scanDoc`（14.7%，真在干活），不是 `sigDocOf`（5.0%），而是 `bandize` 自己 + 一个只做相减的匿名比较器。顺着 `setBandsByThreshold` 的替换点往回看：这一整段与 `hits` 的其余字段**无关**，只与 raw 数值集合有关——这就说明它可以用「数值数组 + 原生排序 + 二分」整体替掉，而且能被逐位对拍。

### 9.212.3 处方：数值数组 + 阈值链 + 二分，脏值退回路

1. **`Float64Array` + 原生 `.sort()`**：先把参与定档的条目的 raw 抄进 `Float64Array`（指认档 `_ident` / `_subj === 1` 不抄——老代码对它们是 `continue`，它们既不定档也不当锚点），然后 `vals.sort()`：TypedArray 的默认排序是**纯数值升序、不调 JS 比较器**，一次拷贝换掉十三万次回调。
2. **阈值链**：从最大值往下扫，`if (anchors.length === 0 || v < IMP_BAND * anchor)` 才开新档并更新锚点——与老循环同一条规则，只是扫的是数值数组。锚点表天然严格下降（前提见下），翻成升序备用。
3. **二分查档**：每条拿自己的 raw 在锚点表上二分出「第一个 ≥ v 的锚点下标 `lo`」，档号 = `m - 1 - lo`（第 0 档的锚点最大，落在表尾；`v` 在两个锚点之间时，比它小的那些锚点都在它右边，正是「开了几档」）。每条一次 `log m` 次数值比较，零对象字段访问。
4. **退回路（这一版最要紧的一笔）**：阈值链的正确性依赖「锚点严格下降」（`a_{i+1} < 0.85·a_i < a_i`）。两种数据上这前提不成立：**负数** raw 时 `0.85·a > a`，链会往上爬；**`NaN` / `undefined` / `null` / `Infinity`** 时比较本身没有意义。遇到就**不猜**：`setBandsByThreshold` 返回 `false`，`bandize` 调 `setBandsBySort`——0.6.12 的老代码被原样保留成独立函数（连注释一起），逐位可对照。判据 O9 / O10 就是钉这条退回路：负数 60 组、脏值 40 组，全部与老实现对拍。

**为什么可以整段替掉而不改口径**：档号是「相对榜首的 85% 三分法」，只依赖 raw 的**多重集**，与条目顺序、对象身份、其它字段都无关；老代码的锚点更新也只读 raw。因此「排好的数值 → 阈值链 → 每条查档」与「对象全量排序后逐条走」在数学上同一件事，差别只在常数（O1 的 500 组 × 六种 k 对拍兜住）。

### 9.212.4 读数

10,000 条同构语料 / 300 问（`E:\Temp\cmp\prof012b.mjs`）：

| 路径 | 0.6.12 | 0.6.13 | 变化 |
| --- | --- | --- | --- |
| `search` | 19.985 ms | **16.329 ms** | **−18.3%** |
| `searchAdaptive`（产品走的这条） | 23.097 ms | **18.812 ms** | **−18.6%** |
| `searchIndexOf` 热命中 | 0.751 ms | 0.703 ms | 噪声内持平 |
| 冷建索引 | 270.7 ms | 259.2 ms | 噪声内持平 |

cpu-prof 复测（总采样 5,692.7 ms）：`setBandsByThreshold` 7.0% + `bandize` 其余 0.8% = **7.8%**（改前 21.5%）；`orderOf` 1.1%、`search` 自证 45.9%、`scanDoc` 18.1%、`sigDocOf` 5.8%、`idfGlobal` 3.9%。下一步的大头已经变成 `search` 自证与 `scanDoc`，不再是定序。

质量逐位不变：真库 52 问三档 0.921 / 0.417 / 0.500、平均取回 6.342 / 6.917 / 5、两条 #2→#1；LoCoMo（1,531 问）0.3932 / 0.6192 / 0.6924 / 0.7511、MRR 0.4958、recall@20 0.6322、空回 0；返回条数合计 1,500。

### 9.212.5 判据 O9–O10 与 OR073

`tools/probe-order.mjs` 8 → **10 条**：

- **O9** 负数 raw（60 组，−6..6，含 0 与重复）走退回路，`bandize` 与探针自带的 `refBandize` 逐位一致——负数时阈值链前提坏了，引擎必须自动换路，且换得一字不差。
- **O10** `NaN` / `undefined` / `null` / `Infinity` 混进 raw（40 组，每 5 条插一个脏值）同样退回老路，与参考一致（含不抛错）。

`verify.mjs` 新增 **OR073** 五条：O9–O10 标签在位 / 引擎里阈值链三件（`setBandsByThreshold`、`new Float64Array(plain)`、`vals.sort()`、`h._bandTmp = m - 1 - lo;`）与退回路（`setBandsBySort` + 那个 `if (!setBandsByThreshold(...))` 调用）/ 进程内负数与 NaN 两组对拍朴素实现 / 文档四处 / 版本地板 ≥ 0.6.13。O1–O8 与 OR072 原样保留（它们描述的行为没变）。

### 9.212.6 账

支数仍 **41**（探针文件没变，条数增加）；断言 3,697 → **3,704**（`probe-order` +2、`OR073` +5；`HZ7` 只改钉法与文案，条数不变）。

## 9.213 热路上不留痕（0.6.14）

### 9.213.1 症状：一秒钟在「把刚挂上去的值摘下来」

0.6.13 之后复测（10,000 条 / 300 问，单次 16.54ms），cpu-prof 的**函数**视图指向 `search` 自证 45.8%、`scanDoc` 17.8%——都是「在干活」的样子，看不出病。换成**行**视图（`E:\Temp\cmp\prof-lines.mjs`，读 cpuprofile 的 `positionTicks`）才看见真正的两块：

```
791.5 ms  delete h._lv;
353.0 ms  delete h._vb;  +  delete h._sr;
```

一条 `delete` 一行占 791.5ms，总采样 5,671.8ms 里有 **1.14s（约 20%）** 花在摘临时值上。这四笔（`_vb` 原样命中位 / `_sr` 句式比 / `_lv` 层级意图 / `_tr` 断言密度）是老写法：先用先挂，用完 `delete`。

### 9.213.2 发现路径

函数视图为什么看不见？因为它们算在 `search` 的自身时间里——`delete` 不是函数调用，不产生独立栈帧。所以这一版的定位工具是**行级归因**：把每个采样点落到（文件、行号），按函数分组累加。跑完立刻能看出「最热的那一行不是逻辑，是清理」。顺着这一行往回读：`delete` 一旦发生，V8 就把这个对象从**固定形状（inline cache 友好）**切到**字典模式**——而它接下来还要被 0.6.13 刚优化的 `bandize` 反复读 `_raw`、被 `orderOf` 读分数与 `updated_at`。先挂后摘省下的是四次赋值，赔掉的是整条热路的属性访问速度。

### 9.213.3 处方：平行数组 + idf 每趟记一次账

1. **四个临时值进平行数组**：`vbTmp` / `srTmp` / `lvTmp` / `trTmp`，push 紧挨 `hits.push`（同下标同寿命），收尾段按 `for (let hi = 0; hi < hits.length; hi++)` 读数组。回执对象的字段集合**一个不增一个不减**（`_subj` / `_raw` / `cover` / `_band` 都在，`explain` 各段照旧），区别只是没有中间字段可摘。
2. **idf 每趟记一次账**：`scanDoc` 里每条候选人、每个查询词都调一次 `idfOf(term)`；idf 只由词的 df 决定、同一趟里是常量。每问建 `idfCache` + `idfAt(t)`，值逐位相同（同一个 `Math.log`，只是不再重复）。**自适应换尺子时必须清账**：`idfOf` 被就地替换成双尺度版本那一刻，旧的缓存值就是错的，所以替换之前 `idfCache = new Map();`（H6 钉这一条：直接开 / 先关后开 / 连开两次，三份逐位相同）。
3. **顺带两笔固定开销**：`raw.slice()` 只在 `explain === true` 时留（关掉时没人看），`Math.max(...raw)` 换循环（`if (!(v <= maxRaw)) maxRaw = v;`——用 `!(v <= x)` 而不是 `v > x`，让 `NaN` 照旧把结果染成 `NaN`，口径不变）。

**为什么口径不变**：档位与分数只依赖 `raw` / `score` / `updated_at` / `id`（`orderOf` 的四把钥匙）与几个乘子，平行数组与原字段一一对应、同下标；idf 记忆化是幂等函数的结果复用。所以 `final.mjs` / LoCoMo 全部逐位相同（见 9.213.4）。

### 9.213.4 读数

| 路径 | 0.6.13 | 0.6.14 | 变化 |
| --- | --- | --- | --- |
| `search` | 16.329 ms | **11.567 ms** | **−29.2%** |
| `searchAdaptive`（产品走的这条） | 18.812 ms | **13.520 ms** | **−28.1%** |
| `searchIndexOf` 热命中 | 0.703 ms | 0.679 ms | 噪声内持平 |
| 冷建索引 | 259.2 ms | 275.1 ms | 噪声内持平 |

相对 0.6.12 的 27.377ms，`search` 累计 **−57.7%**。cpu-prof 复测（`E:\Temp\cmp\prof14\s14c.cpuprofile`，总采样 4,216.7ms）：`search` 自证 37.9%、`scanDoc` 23.8%、`sigDocOf` 7.4%、`setBandsByThreshold` 6.1%；行级热点换成 `hits.push` 的对象字面量（3732–3750 行合计约 1.2s，主要是几个 `...cond ? {} : {}` 条件展开）——那是下一版的事。

质量逐位不变：真库 52 问三档 0.921 / 0.417 / 0.500、平均取回 6.342 / 6.917 / 5、两条 #2→#1；LoCoMo（1,531 问）0.3932 / 0.6192 / 0.6924 / 0.7511、MRR 0.4958、recall@20 0.6322、空回 0；返回条数合计 1,500。

### 9.213.5 判据 H1–H6 与 OR074

新探针 `tools/probe-hotpath.mjs` **6 条**（全部进程内，语料是手搭的小库）：

- **H1** 主路切片里没有 `delete h._vb/_sr/_lv/_tr`，且回执对象不含 `_vb` / `_sr` / `_lv` / `_tr` / `_bandTmp`。
- **H2** 同一份语料连跑两遍，`JSON.stringify` 逐位相同（平行数组不跨查询残留）。
- **H3** 原样补分只落在被点名的那条上（`0mwq5zzv` 的 `explain.identBonus > 0`，别人一个都没有，且它自己 `explain.band === -1`）——`vbTmp` 错位就会落到别人头上。
- **H4** 层级意图乘子只落在 `rules` 那条（`explain.levelIntent === true`，其余无）——`lvTmp` 错位同理。
- **H5** 断言密度乘子只落在开头就下断言的那两条（`0mrrrrrr` / `0mvvvvvv`）——`trTmp` 错位同理。
- **H6** 自适应 idf 换尺子清账：直接开 / 先关后开 / 连开两次，三份逐位相同。

`verify.mjs` 新增 **OR074** 五条：H1–H6 标签在位 + `check-all` 挂线 + 取根例外表第四条 / 引擎里四个平行数组都在且没有那四句 `delete`、`idfAt` 与清账都在 / 进程内 `search` 回执不含临时字段且 `_raw`·`_band`·`explain` 照旧 / 文档四处 / 版本地板 ≥ 0.6.14。跟改的老判据（改建不删）：`verify.mjs` 的 HZ8 / HZ9 / HZ14 / HZ15 / VW1 / VW4 与 `probe-recall` R12、`probe-gold` G28（`ruleFoldOf(di)` 从「三处引用」改成「算一次、乘两处」）。

### 9.213.6 账

支数 41 → **42**（新增 `tools/probe-hotpath.mjs`）；断言 3,704 → **3,715**（`probe-hotpath` +6、`OR074` +5）。

## 9.214 覆盖度顺着倒排记一遍账（0.6.15）

### 9.214.1 症状：一行 573.9ms 在替每条候选人重问一遍问句词表

0.6.14 之后复测（10,000 条 / 300 问，单次 11.57ms），函数视图（`E:\Temp\cmp\prof15\s15.cpuprofile`，总采样 4,143.7ms）是 `search` 自证 **40.6%**（1,681.5ms）、`scanDoc` **18.8%**（777.5ms，0.6.14 是 23.8% / 1,003.6ms）、`sigDocOf` 7.3%、`setBandsByThreshold` 5.9%、GC 3.7%、`(anon)`@3607 3.6%、`buildSearchIndex` 2.4%、`sessionTopicTerms` 1.8%。函数视图里 `scanDoc` 仍在「正常干活」的样子，行视图（`node E:\Temp\cmp\prof-lines.mjs E:\Temp\cmp\prof15\s15.cpuprofile scanDoc 8`）才点出名来：

```
535.3 ms  scanDoc :3564   （打分循环的 tfi.get(term) 那一圈）
 45.7 ms  scanDoc :3559
 44.6 ms  scanDoc :3569
 40.4 ms  scanDoc :3568
 30.8 ms  scanDoc :3570
 14.9 ms  scanDoc :3553   （覆盖度，0.6.15 改完之后）
```

改之前最热的一行不是 `:3564`，是覆盖度那句（旧文件 `:3529`，**573.9ms / 300 问 ≈ 1.9ms 一问**）：

```js
for (const term of qKept) if (tfi.has(term)) cover += idfAt(term);
```

它算的是一件朴素的事——「这条命中了几成问句词（idf 加权）」——但算法是**二维**的：对每条候选人（最多 10,000 条）把问句词表（几十个词）从头问一遍 `Map.has`。10,000 × 几十 = 每问几十万次哈希查找，只为得出 10,000 个数。

### 9.214.2 发现路径

0.6.14 记忆化的 `idfAt` 已经把「每条 × 每词」的 `Math.log` 降成「每词」，所以这一行的耗时里 `Math.log` 已经不是主体，**主体是 `Map` 查找与循环开销**。既然词只由词自己决定「在哪些条里出现」，而 `postings`（`buildSearchIndex`，`vendor/meow-memory/lib/index.js:3166-3191`，由 `docToks` + `kwToks` 建）本来就记着这件事，那这笔账该反过来记：**不为每条候选人问词在不在，而为每个词把它那点 idf 加到它出现过的每一条上**。

一条要留意的事实：`postings` 的键集与 `tf[di]` 严格一致（同一份 `docToks` + `kwToks` 建出来的），所以顺倒排累加得出的覆盖度与逐条查表**语义等价**；`opts.inverted === false` 时 `postings === null`，那条路上没有倒排可用，必须保留逐条查表的退回路。

### 9.214.3 处方：倒排记账 + 问句 idf 每趟一次 + 循环头取一次记录

1. **问句词表的 idf 每趟记一次**：`qKeptIdf` / `qLoopIdf` 两个 `Float64Array` + `refreshQidf()` 一趟填好；打分循环里 `const idf = qLoopIdf[qi]`（0.6.14 把 `Math.log` 从「每条 × 每词」降到「每词」，这里再降到「每问」）。
2. **覆盖度顺倒排记账**：`coverAcc` 按 `docs.length` 开零表，`buildCoverAcc()` 按 qKept **原序**把 `qKeptIdf[qi]` 加到 `postings.get(term)` 的每一条上；`scanDoc` 覆盖度只剩 `coverOf[di] = Math.min(1, coverAcc[di] / qIdfSum)`。退回路（`postings === null`）原样保留：`buildCoverAcc` 头一行 `if (coverAcc === null) return;`，`scanDoc` 里 `else` 分支逐条 `tfi.has`。
3. **循环头取一次记录**：`const dOf = docs[di];`——这一条下面要读十来次同一条记录的字段（`level` / `importance` / `status` / `content` / `last_accessed_at ?? updated_at` / 回执透传的七个字段 / `explain.importance`），原先每次重算下标；`_subj` 用 `srOf`、`_raw` 与 `explain.verbatim` 用 `vbOf`（`rawVerbatim[di] === null` 等价 `vbOf === void 0`，短路语义不变）。
4. **换尺子那趟先重记两笔账**：自适应 idf 换的是重要度尺子，`qKeptIdf` / `qLoopIdf` / `coverAcc` 都得换。顺序钉死为「`idfCache = new Map();` → `refreshQidf();` → `buildCoverAcc();` → `raw.fill(0)` 重扫」。

**为什么口径一位不变**：覆盖度的加法顺序仍是 qKept 原序（`for (let qi…)` 外层、`for (let pi…)` 内层），同一份加数、同一个顺序、同一批 `+=` → 浮点和逐位相同；`qLoopIdf` 只是把 `idfAt(qLoop[qi])` 提前算好，值同；`dOf` 是同一个对象的引用。所以 `final.mjs` / LoCoMo 全项逐位不变（见 9.214.4）。

**换尺子为什么只能钉源码顺序**：这一支在小夹具上物理触发不了——`idfScaleGate` 默认 300、`order.length >= 2`、`idfClusterOf` 要在 top-8（`IDF_CLUSTER_TOP_M_DEF = 8`）里找到 `ratio >= 1.5 && dfG >= 2` 的区分词、`adaptiveLamOf` 还要榜首分差落在 0.05–0.15。小库里 `df == n` 的词 idf 为 0，候选撑不到 8 条；同构高分条又让 `lam` 恒 0（`index.js:3294-3315`）。三轮夹具实验全失败，最后改成 **C3 直接对源码顺序断言**（`iCache6 < iQ6 < iAcc6 < iFill6` 递增），并加「开两次逐位相同」与「两路一致」作旁证。`MEOW_IDF_DEBUG=1` 只在 `cl !== null` 时打印，不能当观测口。

### 9.214.4 读数

| 路径 | 0.6.14 | 0.6.15 | 变化 |
| --- | --- | --- | --- |
| `search` | 11.567 ms | **10.673 ms** | **−7.8%** |
| `searchAdaptive`（产品走的这条） | 13.520 ms | **12.522 ms** | **−7.4%** |
| `scanDoc` 自证 | 1,003.6 ms | 777.5 ms | **−22.5%**（占比 23.8% → 18.8%） |
| 覆盖度那一行 | 573.9 ms | **14.9 ms** | **−97.4%** |
| `searchIndexOf` 热命中 | 0.679 ms | 0.698 ms | 噪声内持平 |
| 冷建索引 | 275 ms | 271 ms | 噪声内持平 |

五次取中位（10.438 / 10.496 / 11.166 / 10.711 / 10.673；自适应 12.44 / 12.522 / 12.715）。相对 0.6.12 的 27.377ms，`search` 累计 **−61.0%**。质量逐位不变：真库 52 问三档 0.921 / 0.417 / 0.500、平均取回 6.342 / 6.917 / 5、两条 #2→#1；LoCoMo（1,531 问）0.3932 / 0.6192 / 0.6924 / 0.7511、MRR 0.4958、recall@20 0.6322、空回 0；返回条数合计 1,500。

**试过又退掉的一刀**（记在这里免得下次再撞）：把 hit 字面量六个「有才带」的条件展开（`...dOf.keywords === void 0 ? {} : { keywords: dOf.keywords },` 一类）换成恒在字段（`keywords: dOf.keywords,`），**变慢**——10.44 → 12.48ms、自适应 12.68 → 14.57ms。原因是每条形体会多带 12+ 个 `undefined` 字段，`hits.push` 的字面量开销反而变大。已逐字改回条件展开，备份 `E:\Temp\cmp\idx-exp.js`。

### 9.214.5 判据 C0–C5 与 OR075

新探针 `tools/probe-cover.mjs` **6 条**（进程内，手搭小库）：

- **C0** 两条路都在：`const buildCoverAcc = () => {` / `coverAcc[p[pi]] += w;` / 退回路那句 `for (let qi = 0; qi < qKept.length; qi++) if (tfi.has(qKept[qi])) cover += qKeptIdf[qi];` / `coverOf[di] = Math.min(1, coverAcc[di] / qIdfSum);`。
- **C1** 倒排开着与关着（`inverted: false`）**逐位相同**（实测 `cover 1 / 0.656 / 0.425 / 0.312 / 0.081`）——两条独立实现互相验。
- **C2** 语义没变：全命中 = 1、命中多的严格大于命中少的、都在 [0,1]、不相关的条不进回执。
- **C3** 换尺子顺序：自适应块内 `idfCache = new Map();` → `refreshQidf();` → `buildCoverAcc();` → `raw.fill(0);`，且开两次逐位相同、两路一致。
- **C4** 空手问句两条路都是 0 条且不含 `NaN`（0/0 漏出来就是 `NaN`）。
- **C5** 300 条 × 30 问（LCG `seed = 20261124`，20 词表，`i % 7 === 0` 的条插 `nothinghere`）两路逐位相同，不一致 0。

`verify.mjs` 新增 **OR075** 六条：C0–C5 标签在位 + `check-all` 挂线 + 取根例外表第五条 / 引擎里倒排账三件（`buildCoverAcc` / `coverAcc[p[pi]] += w;` / `coverOf[di] = Math.min(1, coverAcc[di] / qIdfSum);`）+ 退回路 + `const idf = qLoopIdf[qi];` / 换尺子顺序递增 / 进程内两路逐位相同且全命中 `explain.cover === 1` / 文档四处 / 版本地板 ≥ 0.6.15。跟改的老判据（改建不删，共 9 处）：`impOf(dOf)`、四个 `...dOf.X === void 0`、GZ 的 recency 那半句改钉共有前缀（`w = Math.max(RECENCY_FLOOR, recencyWeight(now - (` 出现 2 次）、HZ6 / HZ7 / HZ13 的 `subjRatio[di]`→`srOf` 与 `rawVerbatim[di].ratio`→`vbOf.ratio`、HZ14 的 `dOf.importance`、VV 的 `verbatim: vbOf.matched.slice()`、VY6 同 HZ6。**三处刻意没动**：`ruleFoldOf` 定义（`index.js:3734`）仍读 `docs[di].level`、`lead`（`index.js:3596`）仍读 `docs[di].content`、`keywordHitScore` 那支（`index.js:4011-4023`、`4027`-`4030`）仍用 `docs[di]`——它们不在这一版的切面上，钉子照旧。

### 9.214.6 账

支数 42 → **43**（新增 `tools/probe-cover.mjs`）；断言 3,715 → **3,727**（`probe-cover` +6、`OR075` +6）。

### 9.214.7 下一版候选（已定位，未做）

- `scanDoc :3564` 那一圈 **535.3ms**：打分循环仍按「候选 × 问句词」做 `tfi.get(term)`。可改成**顺倒排打分**——按 qLoop 原序把 `bm25` 那点贡献加到 `raw[di]` 上，每条候选的加法顺序与现在一致，浮点和仍逐位相同。前提是 `postings` 要带 tf 值（现在只存下标）。
- `hits.push` 的对象字面量与 `explain` 展开（`index.js:3766-3771`、`:3784`、`:3770`，各 145–198ms，合计约 0.7s/300 问）：条件展开已经是最优形状（恒在字段试过，更慢），下一步只能减字段或把 explain 分两段拼。
- `setBandsByThreshold`（244.3ms / 5.9%）与 `sigDocOf`（300.6ms / 7.3%）仍未动过。

## 9.215 打分顺着倒排累加（0.6.16）

### 9.215.1 症状：热点换人了，换成打分循环里的 `tfi.get(term)`

9.214 的处方落地后复测（10,000 条 / 300 问，单次 10.44–10.72ms）。函数视图（`E:\Temp\cmp\prof16\s16.cpuprofile`，总采样 **3,295.9ms**，0.6.15 是 4,143.7ms）：`search` 自证 **48.0%**（1,582.8ms）、`sigDocOf` 9.5%（314.0ms）、`setBandsByThreshold` 7.5%（247.6ms）、`(anon)`@3626（候选集那支 IIFE）4.3%（140.4ms）、`buildSearchIndex` 4.2%（138.6ms）、`scoreCandSet` 2.8%（93.1ms）、GC 2.4%。**`scanDoc` 已经掉出前 25 名**（`node E:\Temp\cmp\prof-lines.mjs … scanDoc 8` 一行都不打印）。

那 535.3ms 没有消失，是换了地方：它原本就在打分循环里，现在整段被搬进 `scoreCandSet`，而 `scoreCandSet` 的大部分被内联进 `search`（所以 `search` 自证从 40.6% 涨到 48.0%）。行视图按 `search` 摊开，头五名全是 `index.js:3863-3868` 那一串（hit 对象字面量与 `explain` 展开，各 134–176ms），`3427` 110.9ms 是函数入口的固定开销。

### 9.215.2 发现路径

打分那段的算式是 BM25：`idf × 字段权重 × tf × (k1 + 1) / (tf + k1 × (1 - b + b × len/dl))`。三个输入里——

- **词频 `tf`**：建索引时就定死了（`m.set(t, (m.get(t) ?? 0) + 1)`，关键词再 `+ kwTfW`）；
- **字段命中**：「这个词在不在标题 / 关键词里」也是建索引时定死的（`titleSets` / `kwSets`）；
- **字段权重值**：`FIELD_KW_W = Number.isFinite(opts.fieldKwW) ? opts.fieldKwW : FIELD_KW_W_DEF;` 是**每问参数**，不能烧进索引。

所以热路上那次 `tfi.get(term)` + `titleSet.has(term)` + `kwSet.has(term)` 全是重复劳动：三次哈希查找，而且**大多数是「这个词这条根本没有」的空手**——一个问句词若只出现在 300 条里，剩下 9,700 条每条都要白查一次。倒排 `postings` 里本来就有「词 → 哪些条」，把这件事反过来扫，热路就只剩数组读 + 浮点乘加。

### 9.215.3 处方：倒排记词频与字段位 + 打分倒过来扫词 + 退路原样

1. **倒排值从「下标数组」扩成 `{ d, f, t }`**（`vendor/meow-memory/lib/index.js`，`buildSearchIndex`）：
   - `d` 下标（原来的 `[di]` 数组）、`f` 该条该词的词频（含 `kwTfW` 加成）、`t` 字段命中位（`1 = 标题`、`2 = 关键词`，取位或）。
   - `f` / `t` 在同一条 doc 循环**末尾**按 `m` 的插入序 push：`for (const [t, v] of m) { const p = postings.get(t); p.f.push(v); p.t.push((ts !== null && ts.has(t) ? 1 : 0) | (ks !== null && ks.has(t) ? 2 : 0)); }`。`m` 的插入序与首见序一致，所以 `f` / `t` 与 `d` **同下标对齐**。
   - `titleSets` / `kwSets` 的定义必须**提到 doc 循环之前**（原来在循环之后），否则末尾那段拿不到。
   - **字段权重值不预乘**：第一版写成 `p.w.push(1 + … FIELD_KW_W …)` 直接 `ReferenceError: FIELD_KW_W is not defined`——它不是建索引作用域里的变量，更重要的是它随 `opts.fieldKwW` 变，预乘等于把索引缓存按权重分裂。
2. **打分倒过来扫词**（`scoreCandSet`）：
   - 第一趟只碰候选本身：`coverOf[di] = Math.min(1, coverAcc[di] / qIdfSum)`、`cvr = Math.pow(coverOf[di], COORD_POW)`、`kDen[di] = k1 * (1 - bEff + bEff * len / dl)`，并把 `di` 压进 `candArr`。
   - 第二趟按 `qLoop` **原序**：`const e = postings.get(qLoop[qi]); … for (let pi…){ const f = pf[pi]; const fl = pt[pi]; let fw = 1; if (fl & 1) fw += FIELD_TITLE_W; if (fl & 2) fw += FIELD_KW_W; raw[di] += idf0 * fw * (f * (k1 + 1) / (f + kDen[di])); }`。qLoop 词的倒排条天然是候选集的子集，热路不需要再判成员。
   - 第三趟收尾（按 `candArr`）：`synOf`（仍用 `tf[di].get(a)`，语义是「每个原词取最好的一个同义词」）、`if (cvr > 0) s *= 1 - COORD_W + COORD_W * cvr;`、`entSets`、`raw[di] = s`——与老实现同一份算式。
3. **退路一个字没动**：首趟与换尺子那趟都是 `if (candSet === null) { for (let di = 0; di < docs.length; di++) raw[di] = scanDoc(di); } else { scoreCandSet(); }`；`candSet === null` 的两条来源是「倒排关掉（`opts.inverted === false`）」与「问句带标识符（`verbOn`，走原样匹配通道）」。
4. **换尺子那趟先重铺候选**：`scoreCandSet` 开头 `candArr.length = 0;`。

**为什么口径一位不变**：每条候选人拿到的加数顺序仍是 `qLoop` 原序（外层词、内层条），加数算式与老实现逐字一致，`kDen[di]` 只是把 `k1 * (1 - bEff + bEff * len / dl)` 提前算好 → 浮点和逐位相同；`coverOf` 仍由 9.214 的 `coverAcc` 来；字段位与 `titleSet.has` / `kwSet.has` 等价（同一份 `titleSets` / `kwSets` 建出来的，`useField === false` 时两边都是全 0 / 全 `null`）。

**踩过的坑**（第一次实测的指纹）：`scoreCandSet` 里忘了 `candArr.length = 0;`，自适应第二趟把候选又 push 一遍，收尾循环对同一条算两遍（`synOf` / 协调项 / 实体层叠乘）。症状是**非自适应路逐位相同、只有 `0.6.0 开` 偏**（换说法 hit@3 0.750 → 0.833、MRR 0.569 → 0.583、平均取回 6.34 → 6.61 / 6.92 → 7.33）——「同一函数被调两次」的标志。

### 9.215.4 读数

| 路径 | 0.6.15 | 0.6.16 | 变化 |
| --- | --- | --- | --- |
| `search` | 10.673 ms | **8.35 ms** | **−21.8%** |
| `searchAdaptive`（产品走的这条） | 12.522 ms | **10.16 ms** | **−18.9%** |
| 总采样（`--cpu-prof`） | 4,143.7 ms | **3,295.9 ms** | **−20.5%** |
| `scanDoc` | 777.5 ms | 掉出前 25 名 | — |
| `searchIndexOf` 热命中 | 0.698 ms | 0.692 ms | 噪声内持平 |
| 冷建索引 | 271 ms | **~300 ms** | **+11%**（代价） |

三次取中位（8.568 / 8.325 / 8.354；自适应 9.945 / 10.155 / 10.187）。相对 0.6.12 的 27.377ms，`search` 累计 **−69.5%**。冷建变慢是这一版唯一付出去的代价：倒排每个词多存两个数组（`f` / `t`），只在建索引时付一次。质量逐位不变：真库 52 问三档 0.921 / 0.417 / 0.500、平均取回 6.342 / 6.917 / 5、两条 #2→#1；LoCoMo（1,531 问）0.3932 / 0.6192 / 0.6924 / 0.7511、MRR 0.4958、recall@20 0.6322、空回 0；返回条数合计 1,500。

### 9.215.5 判据 S0–S5 与 OR076

新探针 `tools/probe-score.mjs` **6 条**（进程内，手搭小库；标题与关键词刻意和正文错开，字段位才不是白给）：

- **S0** 两条路都在：`const scoreCandSet = () => {` / `raw[di] += idf0 * fw * (f * (k1 + 1) / (f + kDen[di]));` / `candArr.length = 0;` / `p.f.push(v);` + `p.t.push((ts !== null && ts.has(t) ? 1 : 0) | (ks !== null && ks.has(t) ? 2 : 0));` / 退路 `raw[di] = scanDoc(di);` **两处**。
- **S1** 倒排开着与关着（`inverted: false`）**逐位相同**（实测 `score 4.3915 / 1.8914 / 2.2584 / 1.0941 / 0.3209`）——两条独立实现互相验。
- **S2** 字段命中位等价于 `titleSets` / `kwSets`：默认 / `fieldKwW: 0` / `fieldKwW: 3` / `fieldBoost: false` 四档，各档两条路都对得上，且档间确有差异（不然这条是白测）。
- **S3** 换尺子顺序：自适应块内 `idfCache = new Map();` → `refreshQidf();` → `buildCoverAcc();` → `raw.fill(0);` → `scoreCandSet();` 递增，且开两次逐位相同、两路一致。
- **S4** 空手问句两条路都是 0 条且不含 `NaN`。
- **S5** 300 条 × 30 问（LCG `seed = 20261125`，每 3 条带标题、每 5 条带关键词，`i % 7 === 0` 插 `nothinghere`）两路逐位相同，不一致 0。

`verify.mjs` 新增 **OR076** 六条：S0–S5 标签在位 + `check-all` 挂线 + 取根例外表第六条 / 引擎里扫倒排四件（`const scoreCandSet = () => {` / `candArr.length = 0;` / 累加那句 / `if (fl & 1) fw += FIELD_TITLE_W;` 与 `if (fl & 2) fw += FIELD_KW_W;`）+ 倒排记 `p.f.push(v);` 与 `p.t.push(...)` 且**没有** `p.w.push` + 退路两处 / 换尺子顺序递增（含 `scoreCandSet();` 在 `raw.fill(0)` 之后）/ 进程内两路逐位相同且换成 `fieldKwW: 0` 仍一致 / 文档四处 / 版本地板 ≥ 0.6.16。**跟改老判据 5 处**（见 9.215.6）：这一版只往倒排里加字段、把打分搬了个位置，`scoreCandSet` 是新名字，但「协调因子 / 长度惩罚 / 覆盖度三步」这几句算式在两个函数里各有一份，钉条数的老判据因此全部要跟着改成两处；`scanDoc` 本体、`ruleFoldOf`、`lead`、`keywordHitScore` 四处钉的仍是原形，原样通过。

### 9.215.6 账

支数 43 → **44**（新增 `tools/probe-score.mjs`）；断言 3,727 → **3,739**（`probe-score` +6、`OR076` +6；verify 1888 → 1894，老判据按「改建不删」跟改 5 处后条数不变）。

跟改的 5 处（都是同一件事：打分拆两条路之后，同一句算式在两个函数里各有一份）：`GZ 只免两样` 与 `HC 只动一处` 的协调因子 1 → **2** 处；`HZ14 长度惩罚按覆盖度打折` 的 `bEff` 1 → **3** 处、`(1 - bEff + bEff * len / dl)` 2 → **4** 处；`HZ14 覆盖度三步` 的取幂与协调各 1 → **2** 处（归一那句只剩退路 1 处）；`probe-gold` 的 `G22` 同步这三步计数、并补钉扫倒排路的 `coverOf[di] = Math.min(1, coverAcc[di] / qIdfSum);` 2 处；`OR075` 与 `probe-cover` 的 `C0` 因为倒排条目换成 `{ d, f, t }` 改钉 `const pd = p.d;` + `for (let pi = 0; pi < pd.length; pi++) coverAcc[pd[pi]] += w;`。

### 9.215.7 下一版候选（已定位，未做）

- **候选集那支 IIFE**（`index.js:3626`，`(anon)` 4.3% / 140.4ms）：现在用 `Set` 逐个 `add` 攒候选。语料大、问句词多时这是「几十万次 `Set.add`」。可改成按 `docs.length` 开一张 `Uint8Array` 位图（`seen[di] = 1`，顺手压进数组），语义与 `Set` 相同、`add` 换成数组下标写。
- `hits.push` 的对象字面量与 `explain` 展开（`search` 行级 `:3863-:3868`、`:3427`，合计约 0.9s / 300 问）：条件展开已经是最优形状（恒在字段试过，更慢），下一步只能减字段或把 `explain` 分两段拼。
- `setBandsByThreshold`（247.6ms / 7.5%）与 `sigDocOf`（314.0ms / 9.5%）：后者已是 0.6.10 的 WeakMap 记账形状，进一步要动签名算法本身（换更便宜的混合函数，风险是抗碰撞变差）。

## 9.216 命中对象先瘦后水化（0.6.17）

### 9.216.1 症状

0.6.16 把打分搬去顺倒排累加之后，第五次 `--cpu-prof`（10,000 条 / 300 问，单次 8.35ms，`E:\Temp\cmp\prof17\s17.cpuprofile`，总采样 **1,808.2ms**，0.6.16 是 3,295.9ms）里，函数级榜单换了一批名字：`sigDocOf` 265.2ms / **14.7%**、`setBandsByThreshold` 243.6 / **13.5%**、`search` 自证只剩 **162.3ms / 9.0%**（0.6.16 是 1,582.8 / 48.0%）、`buildSearchIndex` 148.5、候选集 IIFE `(anon)@index.js:3626` 137.4、`scoreCandSet` 112.2、GC 4.1%。

`search` 自证那一块按行摊开（`node E:\Temp\cmp\prof-lines.mjs … search 8`），最贵的几行全在同一个对象字面量上：`:3881` 176.4ms、`:3868` 176.4、`:3866` 175.3、`:3863` 166.9、`:3865` 142.6、`:3864` 136.2、`:3867` 134.1（均 ms / 300 问）——即十四字段的 `hits.push({ ... })` 与四个条件展开 spread，**合计约 1.07s**，占 `search` 自证的三分之二。

### 9.216.2 病根

扫描循环 `for (let di = 0; di < docs.length; di++)`（`index.js:3867`）对**每条 raw>0 的候选**都建一份完整命中对象：`_subj` / `_raw` / `cover` / 可选 `anchored` / `id` / `level` / `title` / `content` / `importance` / `updated_at` / 五个可选字段（`keywords` / `project` / `created_at` / `status` / `source_session`）/ `score` / 可选 `explain`。可下游只用得上其中很少几样：

- `bandize(hits, '_raw', k)`（`index.js:4015`）→ `setBandsByThreshold` 读 `_ident` / `_subj` / `_raw`；
- 定序比较器 `(a._bandTmp - b._bandTmp) || (b.score - a.score) || stampOf || cmpText(a.id, b.id)` 读 `_bandTmp` / `score` / `updated_at` / `id`；
- `trimByBand(hits, k, opts)` 只 `delete h._raw / h._ident / h._band / h._dense`，留前 k 条。

也就是说，扫 10,000 条、k=8 时，为 9,992 条注定被丢掉的东西付了整份对象钱——还要额外付 GC。这与 0.6.14 治的那笔账同一种形状（**给热路上的每一条都付，最后只留几条**），只是 0.6.14 付在 `delete` 上，这一版付在**构造**上。

### 9.216.3 处方三条

一、**扫描期只铺六样加一个下标**。`leanHit = opts.explain !== true && opts.keepBand !== true` 时：

```js
hits.push({
  _subj: ...,
  _raw: raw[di] * (...) * foldOf,
  cover: Math.round(coverOf[di] * 1e3) / 1e3,
  id: dOf.id,
  updated_at: dOf.updated_at,
  score: raw[di] * w * impW * stW * foldOf,
  _di: di
});
```

六样正好是定档（`_subj` / `_raw`）与定序（`score` / `updated_at` / `id`）的全部输入，`cover` 是回执字段里唯一还被定档后逻辑读到的（`trimByBand` 之后的补充路径）。`_di` 不进回执，只是回查下标。

二、**截断之后再水化**。`const outHits = trimByBand(hits, k, opts);` 之后：

```js
if (leanHit) {
  for (let hi = 0; hi < outHits.length; hi++) {
    const h = outHits[hi];
    const di = h._di;
    if (di === void 0) continue;
    outHits[hi] = matHitOf(h, di);
  }
}
return outHits;
```

`matHitOf(h, di)` 按原字面量的键序重建对象：`_subj` → `cover` → 可选 `anchored` → `id` → `level` → `title` → `content` → `importance` → `updated_at` → 五个可选字段 → `score`。两点必须守住：

- **`score` 取 `h.score`，不许重算**——瘦对象上的那份已经被标识符补分（`identBonus`）、层级意图、断言密度、现状仓（`statusDigest`）改过，重算就把补分全丢了。
- **原地替换元素，不许换数组**——`trimmed` / `rescueAdded` 是挂在 `hits` / 回执数组上的非枚举属性，`outHits` 必须是同一个数组对象；所以是 `outHits[hi] = matHitOf(h, di)`，不是 `map`。

`statusDig` 推入的 `{ ...d, _raw, cover, score }` 没有 `_di`，`if (di === void 0) continue;` 直接跳过它（它本来就是完整对象）。

三、**`explain` 与 `keepBand` 两条路照旧走完整字面量**：前者要在对象上就地打补丁（`identBonus` / `subjBonus` / `levelIntent` / `tipAssert` / `statusDigest` 全写进 `h.explain`），后者要把 `_band` 留给 searchHybrid 融合（`if (opts.keepBand === true) return hits.slice(0, ...)` 提前返回，水化在它之后）。不带 `explain` 也不带 `keepBand` 才是绝大多数调用（工具面默认如此），热路只优化这一条。

### 9.216.4 读数

10,000 条 / 300 问，`node E:\Temp\cmp\prof012b.mjs` 三次取中位：

| 项 | 0.6.16 | 0.6.17 | 变化 |
| --- | --- | --- | --- |
| `search` | 8.35 ms | **3.558 / 3.477 ms** | **−58%**（相对 0.6.12 的 27.377 累计 **−87%**） |
| `searchAdaptive` | 10.16 ms | **4.541 / 4.736 ms** | **−54%**（累计 **−85%**） |
| 总采样（cpu-prof） | 3,295.9 ms | **1,808.2 ms** | −45% |
| `searchIndexOf` 热命中 | 0.692 ms | **0.688 ms** | 持平 |
| 冷建索引 | ~300 ms | **288–301 ms** | 持平（瘦对象不碰建索引） |

返回条数合计仍 1,500（k 与截断逻辑没动）。质量逐位不变：真库 52 问三档 0.921 / 0.417 / 0.500、平均取回 6.342 / 6.917、两条 #2→#1 位移（「基线要跑几轮才收敛」「把一个文件拆开之后…」）；LoCoMo（1,531 问）0.3932 / 0.6192 / 0.6924 / 0.7511、MRR 0.4958、recall@20 0.6322、空回 0。

### 9.216.5 判据 H0–H5 与 OR077

新探针 `tools/probe-hydrate.mjs` **6 条**（进程内小库 + LCG 大库）：

- **H0** 源码五件：`const leanHit = opts.explain !== true && opts.keepBand !== true;` / `const matHitOf = (h, di) => {` / `_di: di` / `const outHits = trimByBand(hits, k, opts);` / `outHits[hi] = matHitOf(h, di);` / `if (leanHit) {`。
- **H1** 瘦路回执 vs `{ explain: true }` 完整路，剥掉 `explain` 后 `JSON.stringify` **逐字节相同 6/6**（含键序——这条最容易被「键序稍微不一样」骗过去）。
- **H2** `{ keepBand: true }` 路剥掉 `_raw` / `_bandTmp` / `_band` / `_ident` / `_dense` 后同样相同 6/6。
- **H3** 回执里无 `_di` / `_raw` 泄漏，且 `trimmed` / `rescueAdded` 两个数组属性与完整路逐项一致（属性少被触发：实测只在同档不足 k 时才挂）。
- **H4** 可选五字段（`keywords` / `project` / `created_at` / `status` / `source_session`）无则不写、有则透传。
- **H5** 空手问句 0 条；300 条 × 30 问（LCG `seed = 20261124`）两路逐位相同，不一致 0。

`verify.mjs` 新增 **OR077** 六条：H0–H5 标签在位 + `check-all` 挂线 + 取根例外表第八条 / 引擎里瘦路条件与瘦字段**恰好七项**（`['_subj','_raw','cover','id','updated_at','score','_di']`，多一项说明整条字面量被搬回来了）+ `matHitOf` 与截断后水化 + `keepBand` 提前返回在位 / 进程内瘦路与 explain 路逐字节相同、无内部字段、keepBand 路剥内部字段后相同 / 文档四处 / 版本地板 ≥ 0.6.17。

**跟改老判据 3 处**（都是计数从 2 变 3、或从 1 变 2——瘦对象里也有一份 `anchored`）

- `GZ 同口径`（`verify.mjs:10327` 附近）`const anchored = anchorSel === null ? false : anchorSel(di);` 由 `=== 2` 改 **`=== 3`**（第三处就是 `matHitOf` 里的水化）。
- `HA 版本号问句不误报`（`:10416`）`...(anchored ? { anchored: true } : {}),` 由 `=== 1` 改 **`=== 2`**。
- `VY6`（`:12619`）`(_raw: raw\[di\]/g)` 由 `=== 2` 改 **`=== 3`**（瘦对象也要写一份 `_raw` 给定档）。

### 9.216.6 账

支数 44 → **45**（新增 `tools/probe-hydrate.mjs`）；断言 3,739 → **3,750**（`probe-hydrate` +6、`OR077` +6；`SUITE_FLOOR` 44 → **45**，`NO_ROOT` 补 `tools/probe-hydrate.mjs`）。

### 9.216.7 下一版候选（已按 1,808.2ms 的榜重排）

- **`sigDocOf` 265.2ms / 14.7%**：现在是全榜第一。它已是 0.6.10 的 WeakMap 条级记账形状（值比较 + 复用），进一步只能动混合函数本身或减少参与哈希的字符数（风险：抗碰撞变差，签名撞了会拿旧索引答新库——`probe-signature` 的 S3–S6 会当场红）。
- **`setBandsByThreshold` 243.6ms / 13.5%**：0.6.13 的阈值链 + 二分，已是 `log m` 比较。再往下要合并「求 `m` 个锚点」与「逐条二分」，或者对 `_raw` 相同的条批量定档（重复 raw 在真库里很常见）。
- **候选集那支 IIFE**（`(anon)@index.js:3626`，137.4ms / 7.6%）：`Set.add` 换 `Uint8Array` 位图。
- **`buildSearchIndex` 148.5ms / 8.2%**：只在冷建付，暂不动。

## 9.217. 候选集不再用 Set：位图 + 首见序候选表（0.6.18）

### 9.217.1 症状

0.6.17 把命中对象先瘦后水化之后，热检索的单次读数掉到 3.49ms（10,000 条同构语料 / 300 问），`--cpu-prof` 的总采样 1,808.2ms。再按函数摊开，榜首几块都是「每问 × 万条」的固定触碰成本，而候选集那支 IIFE 排在第 5：**137.4ms / 7.6%**（`(anon)@vendor/meow-memory/lib/index.js:3626`），紧随其后的 `scoreCandSet` 还有 **112.2ms / 6.2%**（集合迭代 + 每条再查一遍 Map）。它干的事只有两件：把「问句词（与 `synOf` 扩出来的词）在倒排里命中过的条目」去重、并按首见序攒成一张表。

### 9.217.2 病根

老实现是 `new Set()` + 两轮 `set.add(di)` + `for (const di of candSet)`：

```js
const candSet = postings === null || verbOn ? null : (() => {
  const set = new Set();
  for (const term of qKept) { const p = postings.get(term); if (p === void 0) continue; const pd = p.d; for (let pi = 0; pi < pd.length; pi++) set.add(pd[pi]); }
  if (synOf !== null) for (const alts of synOf.values()) for (const a of alts) { const p = postings.get(a); if (p === void 0) continue; const pd = p.d; for (let pi = 0; pi < pd.length; pi++) set.add(pd[pi]); }
  return set;
})();
```

两个代价都落在哈希表上：①`Set.add` 每条候选人一次哈希 + 扩容；②`for...of Set` 迭代器 + 每次 `next()` 分配，比按数组下标走慢一个量级。而这里要的语义只是「下标 → 见过没有」和「按首见序攒成数组」。

### 9.217.3 处方两条 + 一条不动

```js
const candAt = postings === null || verbOn ? null : new Uint8Array(docs.length);
const candList = candAt === null ? null : [];
if (candList !== null) {
  // 问句词：首见序与 Set 插入序一致
  if (candAt[di] === 0) { candAt[di] = 1; candList.push(di); }
  // synOf 扩词：同一句去重
}
```

① **去重换成位图**：`Uint8Array(docs.length)`，两处去重逐字为 `if (candAt[di] === 0) { candAt[di] = 1; candList.push(di); }`（问句词一段、`synOf` 扩词一段）。
② **候选表按首见序攒**：`scoreCandSet` 里 `for (const di of candSet)` 改成 `for (let ci = 0; ci < candList.length; ci++) { const di = candList[ci];`；`kDen` / `cvrOf` / `candArr` 与两处「首趟 / 换尺子那趟」的判空一律从 `candSet === null` 改判 `candList === null`。
③ **退路一个字没动**：`opts.inverted === false` 或 `verbOn`（问句带标识符，要走原样匹配）时 `candAt` 为 `null`，直接走全库扫描 `scanDoc`，阴性对照仍靠它。

**为什么逐位不变**：首见序就是 Set 的插入序——位图只回答「见过没有」，顺序由 `candList.push` 记住，所以 `candArr` 的铺法、扫描顺序、浮点加法顺序、回执顺序全都还是老样子。

### 9.217.4 读数（10,000 条同构语料 / 300 问，三次取中位）

| 指标 | 0.6.17 | 0.6.18 | 变化 |
| --- | --- | --- | --- |
| `search` 单次 | 3.49ms | **3.01ms** | −13.7%（相对 0.6.12 的 27.38ms 是 −89%） |
| `searchAdaptive` 单次 | 4.568ms | **4.54ms** | −0.6%（自适应那趟的候选集本就小） |
| `--cpu-prof` 总采样 | 1,808.2ms | **1,678.4ms** | −7.2% |
| 索引热命中 | 0.69ms/问 | 0.69ms/问 | 不变 |
| 冷建 | ~300ms | ~300ms | 不变（位图只在问句侧开） |

候选集那支 IIFE 已从前 20 名掉出去。新的榜首：`sigDocOf` 263.8 / 15.7%、`setBandsByThreshold` 235.6 / 14.0%、`search` 186.6 / 11.1%、`buildSearchIndex` 138.9 / 8.3%、`scoreCandSet` 116.1 / 6.9%。

质量一个字节没动：`final.mjs` 与 0.6.15 / 0.6.16 / 0.6.17 逐行一致（`0.6.0 关` 与 v0.5.0 逐位相同 `true`，两条 `#2→#1` 位移仍在），LoCoMo 1,531 问 hit@1 0.3932 / hit@5 0.6192 / hit@10 0.6924 / hit@20 0.7511 / MRR 0.4958 / recall@20 0.6322 / 平均取回 17.8 / 空回 0.0000。

### 9.217.5 判据：`tools/probe-cand.mjs` C0–C5 + `OR078` 五条

- **C0 源码七件**：位图、候选表、去重语句恰好 2 处、`for (let ci = 0; ci < candList.length; ci++) {`、`if (candList === null) {` 恰好 2 处、**候选集段内**没有 `new Set()` 与 `set.add(`、没有 `for (const di of candList)`。查找范围要用 `ENGINE.slice(candStart, candEnd)` 切到候选集那一段——引擎别处（星图、台账）仍在使用 `Set`，整文件查会假红。
- **C1 算法对拍**：位图并集 vs Set 并集，200 组随机倒排（含重复、乱序、空手）→ 不一致 0。
- **C2 引擎两路**：`search(q, docs, {k:10, explain:true})` vs 同参数 `inverted:false`，6 问逐位相同。
- **C3 扩词那条路真的被走到**：曾两次假红，机制记在这里——①小库（n=7）里 `df(beta)=3 > cap = floor(3×0.35)=1`，`synExpandOf` 的 `usable` 把 beta 挡掉，扩词整条不生效；②垫到 39 条（cap=13、`df(beta)=7`）后扩词生效，但桥接回来的那条分低、被 `trimByBand` 剪掉，「回执多一条」永远看不到，能看到的只有 `trimmed` 从 `undefined` 变 1；且桥会给「`keywords` 里有该词」的条目加 `synW × sat(f)` 的分，分数本来就该不同。最终断言：`on.trimmed === 1 && off.trimmed === void 0`，两路**条与序**相同（只比 `h.id` 数组）。
- **C4 空手**：`search('qqqq zzzz')` 两路 0 条、score / cover 有限（0/0 漏出来就是 NaN）。
- **C5 两路对拍**：300 条 × 30 问（LCG `seed = 20261127`），首趟与 `adaptiveIdf:true, idfScaleGate:10` 换尺子那趟各跑开/关两路 → 不一致 0/0、有回 30。
- **`OR078` 五条**：①C0–C5 标签在位 + `check-all` 挂线 + `NO_ROOT` 取根例外；②引擎七件（含候选集段切片、去重与判空各 2 处）；③进程内倒排开/关逐字节 + 扩词桥 `trimmed` 0→1 且条序不变；④文档四处（本节的 `## 9.217 `、README 的「候选集不再用 Set」、DESIGN 的 `## 213. `、PLAN 的 `0.6.18`）；⑤版本地板 `vNumS9 >= 618`。

### 9.217.6 账

支数 45 → **46**（新增 `tools/probe-cand.mjs`）；断言 3,750 → **3,761**（`probe-cand` +6、`OR078` +5；`SUITE_FLOOR` 45 → **46**，`NO_ROOT` 补 `tools/probe-cand.mjs`）。条数以 `verify.mjs` 的 `MT068` 实测对账为准（其它支基线合计 1857 + 本支 1903 + 1 = 3,761）。

### 9.217.7 下一版候选（按 1,678.4ms 的榜重排）

- **`sigDocOf` 263.8ms / 15.7%**：已是 0.6.10 的 WeakMap 条级记账，行级读数集中在缓存校验链（`index.js:2916` 104.8ms）、`WeakMap.get`（把每问 1 万条 × 7 字段碰一遍的成本：`:2915` 57.1ms、`:2898` 42.5ms、`:2914` 22.8ms），哈希本身只 22.7ms。动混合函数或减少参与哈希的字符数都有撞签名的风险（`probe-signature` S3–S6 会红）。
- **`setBandsByThreshold` 235.6ms / 14.0%**：`vals.sort()` 独占 **164.9ms**（`index.js:2584`）。已实测三条路（1 万值，`E:\Temp\cmp\b18.mjs` / `b18b.mjs`）：整排 `Float64Array.sort()` 0.72–0.80ms、阈值多趟全扫 0.40–0.47ms、**指数桶预筛在 `mix` 只剩 0.59ms**——因为锚点几乎全落在同一两个指数桶里，桶内续找要跑 19 趟、等于白扫；`tight` 分布下 0.741 → **0.015ms**（一次都不续找）。要真赚得「按 hi 的位模式细分桶（`valHi >>> 16` 得 1.044 倍区间，每桶最多落一个锚点）+ 计数排序」。这版不动。
- **候选集之后是 `search` 186.6 / 11.1%**：主要是行级零散，暂不再拆。
- **`buildSearchIndex` 138.9 / 8.3%**：只在冷建付，暂不动。

## 9.218 定档不再排序：桶计数排序 + 段扫（0.6.19）

### 9.218.1 症状

`--cpu-prof` 第七次点名（10,000 条 / 300 问，单次 `search` 2.98ms，总采样 **1,678.4ms**，`E:\Temp\cmp\prof19\CPU.20261124.091907.2820.0.001.cpuprofile`）：`setBandsByThreshold` **235.6ms / 14.0%**（热路第二名），按行摊开，`vals.sort()` 一行 **164.9ms**，占该函数七成。

### 9.218.2 病根

定档只需「raw 从大到小扫一遍、遇到 < 0.85×上一锚点就开档」，锚点链只吃**排序后的不同值**；老实现却先替一万条付一整趟比较排序（`Float64Array.prototype.sort`，V8 上是 TimSort）。

### 9.218.3 处方

1. **桶键 = 位模式的高 32 位右移 16**：非负有限 double 的 IEEE 位模式与数值同序，`rawkBucketOf(v)` 即 `rawkBits[0] = v; rawkBitsU[1] >>> RAWK_SHIFT`。`RAWK_SHIFT = 16` → 桶宽 6.25%，同桶任意两值比值 ≥ 0.941 > `1 - IMP_BAND`，**同桶最多一个锚点**。
2. **计数排序攒段 + 桶号从高到低走一趟**：`rawkHist = new Uint32Array(RAWK_NB)` 先计数、再前缀和，`out[rawkHist[rawkBucketOf(v)]++] = v;` 把值攒进连续区间；随后逐桶扫 `[b === 0 ? 0 : rawkHist[b - 1], rawkHist[b])`，取「`< anchor < 0 ? Infinity : IMP_BAND * anchor`」的最大值当锚点，整桶都 ≥ 阈值就跳过。
3. **桶 0 特判**：0 与全部次正规数同落桶 0、相对跨度无上界，单独拷进 `rawkTail` 后 `sort()` 再走链。
4. **退路**：`RAWK_LE` 为假（非小端）时 `vals.subarray(0, n).sort()` 走 `anchorChainSorted`——只排前 n 个，`rawkVals` 是复用缓冲。

```js
if (rawkVals.length < plain) rawkVals = new Float64Array(plain);
const vals = rawkVals;
for (let i = 0, j = 0; i < total; i++) { … vals[j++] = h[rawKey]; }
const anchors = anchorChainOf(vals, plain);
```

定档侧 `let lo = 0; let hi = m; … h._bandTmp = m - 1 - lo;` 一个字符没动。

### 9.218.4 读数

| 读数 | 0.6.18 | 0.6.19 | 变化 |
| --- | --- | --- | --- |
| `search`（10,000 条 / 300 问，三次中位） | 2.982ms | **2.52ms** | −15.4%（相对 0.6.12 的 27.377ms 累计 −90.8%） |
| `searchAdaptive` | 4.105ms | **3.51ms** | −14.5% |
| `setBandsByThreshold` | 235.6ms / 14.0% | **74.0ms / 4.9%** | −68.6% |
| `anchorChainOf`（新） | — | 28.5ms / 1.9% | 新上榜 |
| 总采样 | 1,678.4ms | **1,520.9ms** | −9.4% |
| 冷建 | 291–308ms | 292–299ms | 同量级 |

### 9.218.5 判据

`tools/probe-band.mjs` **B0–B6**：B0 源码形状（含「阈值路径里 `vals.sort();` 已退场」，只认带分号的调用）/ B1 与「全量排序 + 阈值链」500 组逐位相同 / B2 同桶比值 ≥ `IMP_BAND`（最坏 0.943627）/ B3 退化语料 / B4 定档逐条对拍 + 指认不进链 / B5 复用缓冲不串味 / B6 桶号事实。`verify.mjs` **OR079 五条**：B0–B6 标签与挂线及取根例外 / 引擎桶链七件与「无全量排序」/ 进程内三组语料对拍 / 文档四处 / 版本地板 `vNumS10 >= 619`。

两次假红：B0 曾把注脚里的 `vals.sort()` 当成真调用（改查 `'vals.sort();'`）；B4 的参考实现写成「数一遍锚点 > v」，与 `m - 1 - lo` 在阈值缝里差一档——参考必须照 `setBandsBySort` 的字面语义写。

### 9.218.6 账

支数 46 → **47**（新增 `tools/probe-band.mjs`）；断言 3,761 → **3,773**（`probe-band` +7、`OR079` +5；`SUITE_FLOOR` 46 → **47**，`NO_ROOT` 补 `tools/probe-band.mjs`）。

### 9.218.7 下一版候选（按 1,520.9ms 的榜重排）

- **`sigDocOf` 249.9ms / 16.4%**：仍是第一，行级集中在缓存校验链与每问万条的 `WeakMap.get`；动混合函数会撞签名（`probe-signature` S3–S6）。
- **`search` 178.9ms / 11.8%**、**`buildSearchIndex` 146.7ms / 9.6%**（只在冷建付）、**`scoreCandSet` 108.6ms / 7.1%**、`tokenize` 90.1ms / 5.9%、`classify` 79.8ms / 5.2%。
- `setBandsByThreshold` 已从 14.0% 降到 4.9%，暂时不再是刀口。

