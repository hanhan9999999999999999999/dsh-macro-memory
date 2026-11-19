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

- `check-all`：21 支 / 1,886 条断言 / 136.6s
- `probe-graph`：58 → 65 条（+7 = H 段）
- `verify`：952 → 953；`doctor`：124 → 125；`check-market`：47 —（索引未提交时那条从 PASS 变 WARN，提交后回 48）
- `vendor/` 未改：`make-vendor-manifest` 不必重跑
- 顺带修：`tools/probe-graph.mjs` 的 GB3 原来写死 `nodesN - orphN <= 1 && tailLine === ''`，H 段两条孤立节点进来后
  变成 4 节点 / 2 孤立 → 改成 `(nodesN - orphN <= 1 ? tailLine === '' : tailLine.includes('没排上来'))`

### 9.97.6 边界

- 改的是**融合层文案与探针**，没动 vendor 的签名算法、没改 dup 门槛 0.86、没改面板排序与截断（`HY_MAX`）。
- 面板这个数会继续顶格——这是它作为「扫全库」近似算法的固有行为，本轮只保证**读的人知道自己在读什么**。
- 已知仍未统一：`memory_dream` 与面板其它口径还没跟着 `dedupe` / `repeat` / 这里的「相似」对齐。
