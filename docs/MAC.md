# 跨平台（macOS / Linux / Windows）

> 一句话：**同一个包，三个平台装法一样**。插件本体没有原生依赖，数据落在 `$DSH_HOME/macro-memory`；
> 唯一的前提是宿主（DSH 本体）在你的平台上跑得起来，并且它自带的 Node ≥ 22.5。

这一页写给两类人：在 mac 上装插件的人，和要在 mac 上验证这份代码的人。

---

## 1. 前提：宿主与它的 Node

| 项 | 事实 | 为什么重要 |
| --- | --- | --- |
| 宿主 | DSH 桌面版有 mac 发行版（universal，Intel + Apple Silicon 同一份 dmg） | 插件是挂在宿主里的，宿主没有 mac 版就无从谈起 |
| Node | 宿主自带 runtime：`node 24.21.0`（mac 的 `x64` / `arm64` 两份 `runtime.json` 与本机 Windows 完全同版本） | 主库用 **`node:sqlite`**（Node 22.5 起内置）。不需要 `better-sqlite3`，也就不需要 node-gyp、Xcode 命令行工具、编译 |
| 包结构 | `package.json` 无 `dependencies`、无 `install` / `postinstall` 脚本、无 `.node` 产物 | mac 上 `npm i` 不会编译任何东西，装包失败概率和 Windows 一致 |
| asar | mac 的 `Info.plist` 里有 `ElectronAsarIntegrity`（`app.asar` 的 SHA256 固定） | **不要**去解包/改写宿主的 `app.asar`；插件一律装在 `profiles` 安装面 |

查你自己的宿主 Node：

```bash
# mac：DSH 装在 /Applications 里，runtime 在 .app 包内
"/Applications/DSH NEXT.app/Contents/Resources/runtime/arm64/primary-runtime/dependencies/node/bin/node" -v
```

输出应是 `v24.21.0`（Intel 机器把 `arm64` 换成 `x64`）。

---

## 2. 装法

和 Windows 一样，两条路：

1. **市场装**（推荐）：DSH 里打开市场，装 `macro-memory`，重启 DSH。
2. **手动装**：把本仓（或解包后的 npm 包）放进 profile 的安装面：

```bash
mkdir -p ~/.dsh/profiles/desktop/node_modules
cp -R "dsh-macro-memory" ~/.dsh/profiles/desktop/node_modules/
# 或者在 profile 的 package.json 里加一条 file: / 版本依赖，再让宿主装
```

> `desktop` 是 profile 名。用别的 profile 就换成那个名字（自检脚本认 `DSH_PROFILE`）。

装完重启 DSH。**插件不改宿主任何文件**，所以卸载就是删掉目录 + 重启。

---

## 3. 数据落在哪

规则只有一条：**`$DSH_HOME/macro-memory`**，`$DSH_HOME` 没设就是 `<家目录>/.dsh`。

| 平台 | 默认 | 说明 |
| --- | --- | --- |
| macOS | `~/.dsh/macro-memory` | 与宿主同一套规则 |
| Linux | `~/.dsh/macro-memory` | 同上 |
| Windows | `%DSH_HOME%\macro-memory`（常见 `D:\dsh-home\macro-memory`） | 装了 DSH 的机器通常已把 `DSH_HOME` 指到 `D:\dsh-home` |

里面有什么：

- `memory.db`（+ `-wal` / `-shm`）：七层主库，唯一真源
- `snapshots/`：自动快照（每小时最多一份，留 7 份）
- 星图、错边账、修过账：可重建的索引与账本

**按工作区**的库还在各工作区自己的 `.dsh-meow/memory.db` 里，这一点三个平台完全一样。

### 相关环境变量

| 变量 | 作用 | 默认 |
| --- | --- | --- |
| `DSH_HOME` | 宿主数据根；插件唯一的路径来源 | `<家目录>/.dsh` |
| `DSH_PROFILE` | 用哪个 profile 找已安装的插件（自检用） | `desktop` |
| `DSH_MACRO_VENDOR` | 覆盖「阅读树」位置（自检用） | `$DSH_HOME/vendor/dsh-macro-memory` |
| `DSH_MACRO_PROFILE_HOME` | 覆盖装机树位置（自检用） | `$DSH_HOME/profiles/desktop` |
| `DSH_BACKUP` | 备份根（复原脚本用） | Windows `D:\备份`，其余 `~/DSH-备份` |
| `DSH_APP` | 宿主 `resources/app` 在哪（`check-market` 用） | mac `/Applications/DSH NEXT.app/Contents/Resources/app` |
| `DSH_LIVE_PROCESS` | 宿主进程名（`accept-live` / 复原脚本用） | `DSH NEXT` |

路径全部走 `node:path`，不用字符串拼分隔符；`$DSH_HOME` 只在一个文件里读一次（`lib/macro/platform.js`）。

---

## 4. 自检怎么跑

在仓库根目录（mac / Linux 上 `node` 用系统自带的也行，只要 ≥ 22.5）：

```bash
node tools/probe-platform.mjs      # 平台账：23 条，唯一一支专为跨平台写的
node tools/probe-load.mjs          # 装进去的这份能不能被宿主加载（问宿主自己的判据）
node tools/check-client-bundle.mjs # 构建产物自洽
node tools/doctor.mjs              # 两棵树逐文件比对
node tools/check-all.mjs           # 一次跑完（开发机上才有意义）
```

`probe-platform.mjs` 数四本账：路径推演（三平台的宏目录、`$DSH_HOME` 三种取值）、字面量账（运行面除 `SAMPLE_HOME` 一处样例不许出现盘符；`process.platform` 与 `$DSH_HOME` 只许出现在 `platform.js`）、工具账（`cpTree`、`doctor` 的根、`check-market` 的 mac 路径、`accept-live` 的 `ps`）、文档账（本页、README 平台段、版本三处一致）。最后一条是阴性对照：判据对着故意写坏的样本必须判红。

> `tools/sync-trees.mjs` 在 Windows 上走 `robocopy /E`，在 mac / Linux 上走 `fs.cpSync`——语义相同：**只增改，从不删除**。

---

## 5. 库坏了怎么复原

脚本：`tools/restore-live-db.mjs`（跨平台；Windows 另有等价的 `restore-live-db.ps1`）。

```bash
# 1) 先体检（不写盘）：看源库多大、现库三件套在不在、宿主还活着没有
node tools/restore-live-db.mjs --dry-run

# 2) 完全退出 DSH，再真复原
node tools/restore-live-db.mjs --source ~/.dsh/macro-memory/restore/20261125-restored-memory.db

# 3) 重启 DSH
```

它做四件事：

1. 宿主还在跑就拒绝动手（避免和活进程抢同一次 checkpoint）
2. 把现有 `memory.db` / `-wal` / `-shm` 备份到 `<备份根>/<时间戳>-before-restore-live/`
3. 覆盖主库，**并删掉 `-wal` / `-shm`**（旧 WAL 里可能是坏盐帧，留着会被回放）
4. 自检：`PRAGMA integrity_check` + 七层计数（用 `node:sqlite`，不需要 python）

出问题先还原备份：退出 DSH → 把备份目录里的三个文件拷回 `.dsh-meow/`（或 `~/.dsh/macro-memory/`）→ 启动。

---

## 6. 排障

| 现象 | 原因 | 怎么办 |
| --- | --- | --- |
| 面板说「这台机器的 Node 取不到 `node:sqlite`」 | 宿主用的不是自带 runtime，而是系统里更老的 Node | 用宿主自带的 node（见第 1 节）跑；或升级系统 Node 到 ≥ 22.5 |
| 数据没落在以为的地方 | 设了 `DSH_HOME` | `node tools/probe-platform.mjs` 的 INFO 段会打印 `dshHome` 与 `macroHome` |
| 插件装了但没加载 | 装错 profile / 没重启 / 宿主版本太老 | `node tools/probe-load.mjs`；再看宿主日志 `~/.dsh/logs/desktop-next.log` |
| 写文件报 EPERM / 权限错 | 宿主沙箱策略与目录 ACL 不一致（mac 上少见，Windows 上见过） | 把工作目录加进放行清单，别用管理员身份硬怼 |
| 想改宿主让插件更好装 | mac 的 `app.asar` 有完整性校验 | 不要改；走 `profiles` |

---

## 7. 已知限制

- **没有 mac 真机读数**。0.7.0 的跨平台改动是「推演 + 静态审计 + 本机 Windows 全绿」，不是「在 mac 上跑过」。第 8 节就是补这一课的清单。
- 快照层的 `node:sqlite` 已惰性化：取不到时只有快照/对比这一层降级（面板会说清楚），其余功能照常。但**引擎本身**（`vendor/meow-memory/lib/index.js`）仍是静态 import，Node 太老时整个插件加载不了——这是硬底线，不是可以兜的。
- `tools/` 里的 `.ps1`（复原脚本的 Windows 版）在 mac / Linux 上用不了，用同名 `.mjs`。
- 本页提到的路径都是**默认值**；`$DSH_HOME` 换过就按换过的算。

---

## 8. 待做的真机冒烟（发布前）

在一台 mac（Apple Silicon 优先）上，按顺序做完这四步，把结果贴回 CHANGELOG 的 0.7.0 条目：

1. **装**：市场装或手动放进 `~/.dsh/profiles/desktop/node_modules/dsh-macro-memory`，重启 DSH，确认进程没报错、工具列表里出现 8 个 `memory_*`。
2. **建库**：随便聊两轮让它写一条，确认 `~/.dsh/macro-memory/memory.db` 出现且 > 4 KB；`node tools/probe-platform.mjs` 在 mac 上应 23/23。
3. **检索**：问一个刚记过的事，确认注入块里有那一条（账上 `picks=` 有它）。
4. **复原**：`node tools/restore-live-db.mjs --dry-run` 应认出 mac 的路径与进程；真跑一次（可对一份副本）确认备份目录落在 `~/DSH-备份/` 下、`integrity_check` 是 `ok`。

四步全过，就可以把「mac 已验」写进 README 的技术规格表。
