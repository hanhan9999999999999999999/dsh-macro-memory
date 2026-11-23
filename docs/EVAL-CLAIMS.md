# 评测口径单（EVAL-CLAIMS）

**一句话**：本文件是仓库里唯一承认的「评测数字出处」。表 A 之外的一切数字都是**历史读数**——可以拿来决定先做哪件事，不许拿来当现状、不许写进宣传、不许当回归基准。

判据只认一句话：**任何数字要出场，必须带齐「日期 + 版本/commit + 数据集口径」三件套；缺一项就当场标成历史读数。**

---

## A. 现在能引用的（现状读数）

| 项 | 读数 | 日期 | 版本 / commit | 复核命令 |
|---|---|---|---|---|
| 健康基线 | 34 支 suite / **3,569 断言** / failed 0 / 与 baseline 逐支一致（约 220s） | 2026-11-24 01:20 | 0.6.3 · 本地（待提交） | `node tools/check-all.mjs` |
| 两棵树同步 | drift 0 / extra 0（同步后） | 2026-11-24 01:20 | 0.6.3 | `node tools/doctor.mjs`（结果 PASS）；`node tools/sync-trees.mjs --apply` |
| 库变大后的照抄召回（新尺子） | 同一批 52 问、真库快照 660 条 active：照抄 **hit@1 0.895 → 0.921**、MRR 0.934 → 0.947；换说法 **0.333 → 0.417**、MRR 0.528 → 0.569；时间锚 0.500 不动；**救回 2 / 误伤 0 / 移位 0**（逐题只有两条 #2→#1）。关掉即回 0.5.0 逐位相同（52/52）。同尺横比 v0.3.0 / v0.4.0 / v0.5.0 三档逐位相同、只有本节双升 | 2026-11-23 22:00 | 0.6.0 · meow 补丁（局部 idf，`adaptiveIdf` 产品路径默认开） | `node tools/probe-idf.mjs`（D1–D12 十四条；读数见 `docs/PLAN-0.6.md` §1） |
| 换场景适应力（新尺子） | 5 个陌生领域（医学/法律/园艺/天文/财务）× 12 条 + 10 条换说法问句：换说法 **hit@3 0.40 → 0.80**、hit@1 0.00 不动、MRR 0.342；两遍合并**第一名改判 0 题**；关共现自学习 hit@3 掉回 0.30；混库 60 条与单域持平；同词 hit@1 100% | 2026-11-22 22:40 | 0.5.0 · meow 补丁 `[macro-fusion 0.5.0 · P1]` | `node tools/probe-adapt.mjs`（A0–A5 九条） |
| 版本与接口面 | 0.3.0，接口面冻结 | 2026-11-22 | `2c029b0`（`chore(baselines): 0.3.0 · 24 suites / 3323 assertions`） | `git log --oneline -1` |
| 工具面 | 8 个统一 `memory_*` 工具 + 一段最小注入 | 2026-11-22 | 0.3.0 | `node tools/probe-toolsize.mjs` |
| 查询分解量尺 | 20 题双实体：切开 20/20、补充 35 条、救回 1 题；hit@3 `0.900→0.900`、命中率 `0.950→1.000`、MRR `0.777→0.784`；延迟 p50 `0.14→0.44ms` | 2026-11-22 16:30 | 0.3.1 · `multiQuery: conservative` | `node tools/probe-mq.mjs` |
| 写入端巩固量尺 | 6 种配置下调用账：`off` 0 次检索且回执逐字节不变 / `suggest` 2 次检索 0 次写入 / `write` 恰多 1 条 `topic` 摘要 + 3 条各补一句巩固话且 `status` 不动 / 语义层满即使 `write` 也 0 次写入 | 2026-11-22 17:20 | 0.4.0 · `consolidate: suggest`（默认） | `node tools/probe-consolidate.mjs` |
| 内部诊断检索 | 巩固检查的两枪带 `internal: true`：不写 `seen`、不 `bumpHit`；模型侧拿不到这个参数（`param-audit` 的 `WITHHELD` 白名单 + `1.1b` 双向钉） | 2026-11-22 17:20 | 0.4.0 · meow 补丁 `[macro-fusion 0.4.0]` | `node tools/probe-graph.mjs`（H6）/ `node tools/param-audit.mjs` |
| 写入端通胀量尺 | 九类 `hygiene`：`selfecho` 关键词自证率（`echo/kws > 0.7` 才报，`kws >= 3` 才判，0.67 不报）/ `unused` 召回闭环（`hit_count > 0` 且 `read_count === 0`；读过的、没命中的都不报）/ `inflate` 层通胀（近 30 天 `fact >= 6` 且 `> 结论层 × 3`，6/2 恰好 3× 不报，命中只给一行且 `id: ''`） | 2026-11-22 18:00 | 0.4.0 · nebula 补丁 `[macro-fusion 0.4.0]` | `node tools/probe-hygiene.mjs`（H1–H18，H11–H16 跑真 sqlite） |
| 读侧记账 | `read_count` 从 0.4.0 起记账（`COMMON_COLS` + `upgrade()` 的 `ALTER TABLE` + `bumpRead` + `memory_read` 成功路径各一处），**只加在读路径不加在检索路径**：检索只抬 `hit_count`。老库打开即补列、值从 0 起算，所以刚升级的库里 `unused` 会偏大 | 2026-11-22 18:00 | 0.4.0 · meow 补丁 | `node tools/probe-hygiene.mjs`（H16 老库补列） |
| 自动取代 | 五类硬事实（版本 / 日期 / 状态词反转 / 同一单位数值 / 同一文件名换目录），优先级同序；两道门槛分开（相似度 `0.3` 够格当候选，数值与路径另要逐字重复度 `0.5`）。三态 `autoSupersede`：`off` 零检索、`suggest`（默认）一枪 `internal` 检索且 `memory_update` 0 次、`apply` 才真标 stale；人已点名的不重复建议；一次最多 3 条 | 2026-11-22 18:35 | 0.4.0 · `autoSupersede: suggest`（默认） | `node tools/probe-supersede.mjs`（S1–S15，桩 flow 数调用） |
| 实体层与动态跳数 | 实体只收四类硬事实（`project` / `path` / `tool` / `version`），`minMembers=2`、上限 400、每条记忆最多 6 个、标签 ≥4 字；实体**不进 `nodes`**，是独立一层 `graph.entityLayer`（不参与任何图算法，关掉一个开关即回滚）。动态跳数只在 `hop >= 1` 生效：`matchOf` < `0.2` 的软边邻居跳过，`gain *= 0.45 + 0.55 * m`，`explicit` / `entity` / `project` 三类硬边照走。回执三数齐报（`asked` / `used` / `skippedNeighbors`）。顺带修掉既有沉默 bug：`hops: 2` 此前从未真正跑过第二跳（`e0` 恒 0） | 2026-11-22 19:30 | 0.4.0 · nebula 补丁 `[macro-fusion 0.4.0]`（P4） | `node tools/probe-entity.mjs`（E1–E31） |
| 共现自学习扩词 | 词源取每条记忆的 `keywords`（不是 `tokenize` 的滑窗切片）；两级证据（同条 +2 / 同 project 只认**跨文档** +1）；三道门（次数 ≥2、条件概率 ≥0.25、共享汉字权重降到 1）加形态门（2–8 字、非纯数字、英文须像标识符）；与 `SYN_GROUPS` 在 `synExpandOf` 第四参合流，**只扩 query 不扩库**。读数：窄池换说法 0.929 不动、**宽池照抄 0.977 → 1.000、换说法 0.929 → 1.000（14/14）**，关 `coocLearn` 退回 0.929（增量可归因）；真库 hit@1 0.925 不动。第一版从 bigram 学错（635 条 / 22,956 token / 223 个词 / 全是碎片 / 14 题零增量） | 2026-11-22 20:55 | 0.4.0 · meow 补丁 `[macro-fusion 0.4.0 · P5]` | `node tools/probe-cooc.mjs`（K1–K6 十八条）/ `node tools/probe-gold.mjs`（G-W4） |

| 英文独立量尺（纯检索） | LoCoMo 10 段 / 5,882 轮 / **1,531 问**（剔 cat5），原始对话轮直接当记忆、`k=20`、`bandKeep:false`：**hit@1 0.3932 / hit@5 0.6192 / hit@10 0.6924 / hit@20 0.7511 / MRR 0.4958 / recall@20 0.6322 / 空回 0.0000**。分档 hit@1/hit@20：cat1 0.2491/0.7438、cat2 0.5094/0.7781、cat3 0.1685/0.4944、cat4 0.4209/0.7705；gold1 0.7567、gold2+ 0.7359（recall 0.2906）。**绝对值不可与 A2 的 0.7546 混引**（那份是 ingestion + sidecar 口径） | 2026-11-24 00:25 | 0.6.2 · `tools/bench-locomo.mjs`（数据集指纹 `79fa87e90f04`） | `node tools/bench-locomo.mjs --data=<locomo10.json>`（零 LLM 零网络，约 25s） |
| 空回（不许把「有」说成「没有」） | 同一把英文量尺上 **空回 0.0052 → 0.0000**（8 问 → 0 问），hit@1/5/10/20 与 MRR **逐位不变**；真库 660 条 52 问三档读数一位不动；`probe-gold` 的 G8「该空手时还空手」保持 10/14 与改前逐条相同。病根：噪声地板剔掉「到处都是」的词时，可能留下**库外词（df=0）顶位**，候选集因此空；处方：留下的词全不可命中时，只把**被噪声地板剔掉、且不是虚词**的词救回来（第一版救得更宽、被 G8 判红，收窄后两尺都过） | 2026-11-24 00:25 | 0.6.2 · meow 补丁 `[macro-fusion 0.6.2]` | `node tools/probe-empty.mjs`（E1–E7 十四条，含能红证明） |
| 同一问句同一答案（定序） | 定序四把钥匙（分档 → 分数 → 更新得更晚的在前 → id 自然序）之后：**同进程连跑 5 次逐位相同、跨进程哈希一致（`27e6455559a98f74`）、语料打乱 seed 3/11/42 前十逐位相同**，`searchAdaptive` 跨 idf 闸门同样顺序无关；并列时 `updated_at` 9000 排在 1000 前，`D1:2` 排在 `D1:10` 前；检索定序里已无 `localeCompare`（全文件仅剩 2 处显示分组）。改前：40 条同构语料原序 `t-00..t-04` / 乱序 seed=1 `t-31,t-23,t-28,t-38,t-27`。读数代价 **0**：LoCoMo hit@1/5/10/20 = 0.3932/0.6192/0.6924/0.7511、MRR 0.4958、recall@20 0.6322、空回 0.0000 与改前逐位相同（纯字典序会掉到 0.3926/0.6179/0.7505/0.4953，故 id 用数字段自然序）；真库 660 条 52 问三档 0.921 / 0.417 / 0.500 与两条 #2→#1 位移不动 | 2026-11-24 01:15 | 0.6.3 · meow 补丁 `[macro-fusion 0.6.3]` | `node tools/probe-determinism.mjs`（D1–D8 九条，含子进程能红证明） |

关于「3,341」的来路：3,323（0.3.0 冻结）→ 3,332（P1 的 9 条 `mq:` 判据）→ 3,331（verify 支数断言 24→25）→ 3,341（新增 `tools/probe-mq.mjs` 9 条量尺，套件 24→25）。中间那一次 3,331 是过渡态：`probe-mq` 还没改成 `PASS` 行格式，在基线里被记成 0 条——**输出不是 `PASS`/`FAIL` 开头的探针，在 check-all 里等于没记账**（`countPass` 数的是 `/^PASS/gm`）。引用旧文章里的 3,323 / 3,332 时要说明它是 P1 前后的过渡基线。

关于「3,367」的来路：3,341 → **3,367**（+26 = 12 条 `co:` 判据 + 12 条 `tools/probe-consolidate.mjs` + `param-audit` 的 `1.1b` + `probe-graph` 1 条，套件 25→26）。这里也有一个过渡态 **3,365**：`param-audit` 判红后 `process.exit(1)`，把 20.6s 的耗时截成 1.6s 记进基线，转绿之后反报「慢了 13 倍」。**一条支从红转绿，耗时基线要手工回填成绿态读数**——`--update-baselines` 会把失败路径的速度当成正常（`docs/INTERNAL.md` 9.192）。

关于「3,398」的来路：3,367 → **3,398**（+31 = 12 条 `hy:` 判据（verify 的 A58d）+ 18 条 `tools/probe-hygiene.mjs`（H1–H18）+ 1 条 `tools/doctor.mjs`（补上 `probe-hygiene.mjs` 的文档出处后那条 WARN 转 PASS 才计入），套件 26→27）。verify 单支 1,757 → 1,769，其余 26 支 1,610 → 1,629。同一节 `docs/INTERNAL.md` 9.193 记了这段的四个连带坑：`probe-words` 把「体检六类」写死、`PANEL_SUMMARY` 220 字撞 200 字可读性尺、`verify` 的 `steps.length === 26` 与 `check-all` 支数注释、schema 体积 13,366 → 13,372 B。

关于「3,523」的来路：3,511 → **3,523**（+12 = 12 条 `tools/probe-adapt.mjs`（A0 三条 / A1 / A2 两条 / A3 / A4 两条 / A5 两条 / A6 一条）+ 0 条 `verify.mjs`（支数断言 30→31 只是数字没加条）+ `tools/doctor.mjs` 绿态回填 ±2，套件 30→31）。A6 是 11-23 复跑 LoCoMo 之后补的：它不量收益，只钉边界——纯拉丁语料上 `coocForms` 恒空、两遍与一遍逐位相同，谁将来想让英文也吃到桥，先让这条红再改判据与文档。**这一版最该记住的一条**：改判据不是改数字，是改因果——`probe-gold` 的 G-W4 从「宽池 ≥ 窄池」改成守绝对量（窄池照抄 0.977 → 1.000 之后，相对判据把「真干扰项压到第 2」判成红），`probe-adapt` 的消融从 hit@1 换到 hit@3（桥是补位性质，命中提升全在 2、3 位）。两处都把「为什么改、改了代价是什么」写进注释与 `docs/INTERNAL.md` 9.198。

关于「3,540」的来路：3,523 → 3,536（+13 = 13 条 `tools/probe-idf.mjs`（D1 默认=关 / D2 小池不动 / D3 λ 上限 0 / D4 闸门不是摆设 / D5 全泛词退全库 / D6 结构不变量 / D7 窗口各归各簇 / D8 α 真的接上 / D8b cap 真的接上 / D9 p95 增量 / D10 返回字段不变 / D10b 回执带 `status` / D11 候选不凭空造）+ 0 条 `verify.mjs`（支数断言 31→32 只是数字没加条），套件 31→32）→ **3,537**（+1 = 0.6.1 的 `probe-idf` **D12 接线点**：`rankForSearch` 的产品入口必须默认开、`searchAdaptive` 的词形桥那遍必须显式关，两处正则都在源码里把住；删掉任何一处，前 13 条仍全绿而线上悄悄退回 0.5.0——这条专治「判据全绿、行为回退」的沉默故障，已用「把两行抹掉后再跑正则」证明能红）→ **3,540**（+3 = 0.6.1 收尾给 `check-all --update-baselines` 的收敛轮配的三条哨兵：`verify.mjs` A16 里「记完会收敛（数与基线不同就地重跑、最多 3 轮）」与「收敛不了就说在晃」（+2），以及「红的那一支不记账（FAIL 那一路少走一段，条数不可信）」（+1）；这三条都对着 `tools/check-all.mjs` 的源码形状判，删掉收敛逻辑就立刻红）。**这一版最该记住的一条**：`probe-idf` 不测准确率——准确率要 ≥300 条真实语料才有意义，硬造「刚好翻转」的合成样张只能得到假绿（试过两条思路都自相矛盾：正解不进 top-8 就永远修不回来；「簇内普及但全库稀有」在数学上要求 p 同时高和低）。它只钉三件事：**这机制不许动小库与默认路径**（D1/D2/D3 逐位相同）、**旋钮真的接在判分上**（D4/D6/D8/D8b 能红）、**接线点不许被顺手摘掉**（D12）。准确率读数落在 `docs/PLAN-0.6.md` §1 与本节「库变大后的照抄召回」行，两边数字必须同源。

关于「3,569」的来路：3,554 → **3,569**（+15 = `tools/probe-determinism.mjs` 的 D1–D8 九条，+ `verify.mjs` 新开的 `DT063` 一节六条，套件 33→34）。这九条钉的不是「排序更准」，而是**「同一问句必须同一答案」**：D1 同进程连跑 5 次逐位相同 / D2 另起一个 node 进程跑同一份快照、哈希与本进程相同（没有进程内随机态）/ D3 语料打乱三种 seed 前十逐位相同 / D4 `searchAdaptive` + `adaptiveIdf` 跨过 300 条闸门那一跳同样顺序无关 / D5 并列组里「更新得更晚的在前」（`updated_at` 1000 与 9000 的双胞胎）+ 反转语料一致 / D6 id 自然序（`D1:2` 先于 `D1:10`）/ D7 检索定序里没有 `localeCompare`（白名单只放过会话名与项目分组两处显示层）/ D8 能红证明。**能红证明的写法本身踩了两个坑**：①`Module._compile` 的 `filename` 必须落在引擎自己那一层（写成 `'red-det.js'` 会按 cwd 解析裸包名，`check-all` 在中性 cwd 里跑就报 `ERR_MODULE_NOT_FOUND: Cannot find package '@deepseek-ai/dsh-llm'`）；②红线必须在**没 import 过真引擎的子进程**里量——同进程里只要加载过真引擎（哪怕一次 `search` 都不调用），编译出来的红模块对语料顺序就变得不敏感，两套顺序都返回 `t-00..t-04`，量出来是假绿。两个坑都记在 `docs/INTERNAL.md` 9.202.5。

关于「3,554」的来路：3,540 → **3,554**（+14 = `tools/probe-empty.mjs` 的 E1–E7 十四条，套件 32→33）。这十四条钉的不是「排序更准」，而是**「回执不许把『有』说成『没有』」**：E1 库外词不许顶掉能命中的词（`zzzz nate` 与 `nate` 首位同一条）/ E2 不凭空编（问句全是库外词、或与库彻底无关时仍回 0 条）/ E3 老护栏不回退（全是噪声词、全是虚词时照旧整句回退）/ E4 正常问句在地板开/关两态下**逐位相同**（证明补丁只在「留下的词全不可命中」时动手）/ E5 不引新 id、返回条数不出 k、`docs` 为空仍回 0 / E6 成本（单次 0.05ms）/ E7 只救噪声词（中文实词 `基线` 照救、既是噪声又是虚词的 `什么` 一个都不救——第一版救得更宽，被 G8「没有的事就空手」判红：14 条无关问句空手 10/14 → 8/14）。**能红证明**：把补丁那一段从源码里挖掉再编译，`zzzz nate` 立刻回 0 条而 `nate` 仍是 5 条——说明红线在这条补丁上，不在测试写法上。

关于「3,511」的来路：3,476 → **3,511**（+35 = 14 条 `as:` 判据（verify 的 A58g）+ 18 条 `tools/probe-cooc.mjs`（K1–K6）+ 4 条 `tools/doctor.mjs`（P5 补丁账 + 三条绿态才计入的同步/指纹判据）+ 2 条 `tools/probe-cost.mjs`（C5b/C5c），另有几支因绿态转红态消失的条件断言回填 ±1，套件 29→30）。verify 单支 1,797 → 1,811。**这里有一个必须记住的坑**：`--update-baselines` 在「红着跑」的那一轮会把少掉的断言数记成新基线（drift 态下 `两处比较` / `账本指纹` 后面三条绿态判据不出现 → doctor 记成 159 而实际绿态是 162），所以顺序只能是「先两树同步 → 再跑绿 → 再 update → 再跑一遍确认 `断言数与基线一致`」。连带坑记在 `docs/INTERNAL.md` 9.197：两级证据混一张表把宽池换说法打回 13/14、C5b 快照必须冻结「只差一个变量」的那一态。

关于「3,476」的来路：3,428 → **3,476**（+48 = 14 条 `as:` 判据（verify 的 A58f）+ 31 条 `tools/probe-entity.mjs`（E1–E31）+ 4 条 `tools/doctor.mjs`（P4 三条补丁账 + 一条 WARN 转 PASS）+ 3 条 `tools/probe-host.mjs`（D3 三条此前是红态未计入、这一轮转绿），另有几支因文档同步 ±1 条微调，套件 28→29）。verify 单支 1,783 → 1,797。连带坑记在 `docs/INTERNAL.md` 9.196：`_root.mjs` 取根、`param-audit` 的参数对应、`probe-toolsize` 抬线 110,000 → 112,000、`probe-host` D3 的 schema 体积 13,372 → 13,567。

关于「3,428」的来路：3,398 → **3,428**（+14 条 `as:` 判据（verify 的 A58e）+ 15 条 `tools/probe-supersede.mjs`（S1–S15）+ 1 条 `tools/doctor.mjs`（补上 `probe-supersede.mjs` 的文档出处后那条 WARN 转 PASS 才计入），套件 27→28，合计 +30）。verify 单支 1,769 → 1,783，其余 27 支 1,629 → 1,645。这一节的连带坑记在 `docs/INTERNAL.md` 9.194：模块放进 `defs/` 撞红两条结构判据、`probe-consolidate` 被多打的一枪检索数乱、`verify` 的 `steps.length` 再次写死。

## A2. 本地检索 gold 口径（2026-11-22 实测，**全程无 LLM**）

主人 2026-11-22 的原话：「只跑gold评测 不允许跑llm」。这一节只测**检索能不能把 gold evidence 捞进 top-k**，不测回答对不对——它是命中率，不是准确率，不许与 B 节的 71.95 并列，也不许换算成准确率。

- 跑法：`locomo_ingestion.py --lib macromem --version omni4 --workers 2 --clear`（6m38s，10/10 users / 1,536 题）→ `locomo_search.py --lib macromem --version omni4 --workers 2 --top-k 20` → `score_locomo.py --data data\locomo\locomo10.json --results results\locomo\macromem-omni4`。
- 被测代码：0.4.0 未提交工作树（HEAD `2c029b0` + P0/P1/P2/P2.5/P3）；判分器是自写的 `E:\Temp\omni-eval\score_locomo.py`（纯本地查表，无模型调用）；结果目录 `results/locomo/macromem-omni4`，报告 `E:\Temp\omni-eval\report_omni4_retrieval.{json,md}`。
- **评测侧必须显式 `bandKeep: false`**：`E:\Temp\omni-eval\sidecar.mjs` 里 `Meow.search(q, docs, { k: docs.length, bandKeep: false })`。不传的话 meow 的 `trimByBand` 默认按置信档收口（`RESULT_MIN_KEEP = 5`），常常只回 5 条，`hit@5` 与 `hit@20` 会恒等——那是产品行为，不是 bug，但 OmniMemEval 的契约是固定 top-k。

| 项（1,536 题） | 读数 |
|---|---|
| hit@5 / hit@10 / hit@20 | **0.6159 / 0.6953 / 0.7546** |
| recall@5 / recall@10 / recall@20 | 0.5522 / 0.6231 / 0.6822 |
| MRR / nDCG@10 | 0.4953 / 0.5029 |
| avg_retrieved / avg_context_chars / empty_rate | 17.77 / 5,947.2 / 0.0 |

| 类别 | 题数 | hit@5 | hit@10 | hit@20 | recall@20 | MRR | nDCG@10 |
|---|---|---|---|---|---|---|---|
| multi-hop | 282 | 0.5248 | 0.6489 | 0.7447 | 0.4666 | 0.3765 | 0.3004 |
| temporal | 321 | 0.6729 | 0.7321 | 0.7882 | 0.7555 | 0.5807 | 0.5961 |
| open-domain | 92 | 0.3478 | 0.4457 | 0.4783 | 0.3613 | 0.2616 | 0.2457 |
| single-hop | 841 | 0.6540 | 0.7241 | 0.7753 | 0.7616 | 0.5281 | 0.5634 |

对照 `E:\Temp\omni-eval\report_retrieval.json`（2026-11-20，同机同数据集，被测代码是 0.2.x，`avg_retrieved` 19.99）：hit@5 `0.5013 → 0.6159`、hit@10 `0.582 → 0.6953`、hit@20 `0.651 → 0.7546`、recall@20 `0.5835 → 0.6822`、MRR `0.3768 → 0.4953`、nDCG@10 `0.3933 → 0.5029`；分类 hit@20：multi-hop `0.5319 → 0.7447`、temporal `0.7103 → 0.7882`、open-domain `0.4022 → 0.4783`、single-hop `0.6956 → 0.7753`。**本次给出的条目更少（17.77 < 19.99）却命中更高**，差值方向可信。

限制（引用时必须带）：这是同机两次不同代码的读数对照，不是受控 A/B（中间隔了上百个版本改动）；自写 scorer、单次运行无 std、非官方脚本、非公开榜单；gold 命中 ≠ 回答正确；端到端 LLM-judge 自 2026-11-20 起未重测（B 节）。

### A2.1 0.5.0 复跑（2026-11-23，`omni5`）：与 0.4.0 **逐位相同**

- 跑法同上，`--version omni5`（ingestion 6m41s / search 12s）；sidecar 的检索入口改调 `Meow.searchAdaptive`（与产品 `rankForSearch` 同一条路），`bandKeep:false`、`k=docs.length` 口径不变。结果 `results/locomo/macromem-omni5`，报告 `E:\Temp\omni-eval\report_omni5_retrieval.{json,md}`。
- 读数：hit@5 `0.6159` / hit@10 `0.6953` / hit@20 `0.7546` / recall@20 `0.6822` / MRR `0.4953` / nDCG@10 `0.5029` / avg_retrieved `17.77` / avg_context_chars `5,947.2`，分类四项 hit@20 亦逐一相同。
- **为什么相同（三组证据，不是没跑到新代码）**：①`stores\*_omni5` 20 个库全新建、search 分片 04:17:28–04:17:40 现生成；②`E:\Temp\omni-eval\diag_omni5_diff.mjs` 在 user 0/1/2（419/369/663 条）385 条问句上，`search` 与 `searchAdaptive` 的 top-5 / top-20 改动数 **均为 0**；③`diag_omni5_scores.mjs` 直接喂 `synFormBridge:true`（绕过「桥接得上才跑」门），前 5 名分数逐位相同——第二遍没有新增候选。
- **机制原因**：`tokenize()`（`vendor/meow-memory/lib/index.js:1647`）对 CJK 段切二元组、对拉丁段只投整词小写；`buildCoocForms()`（`index.js:2694`）建表时 `if (f === word) continue;`（`index.js:2702`）丢掉「碎片==整词」项。纯英文库里 `coocForms` 恒为空 Map，词形桥无坐标可翻译，`searchAdaptive` 走 `sameOrder` 短路返回第一遍原对象。
- 结论（写清楚，别含糊）：**0.5.0 的「换场景适应力」是 CJK 词形桥，对英文 LoCoMo gold 集结构上不生效**；它在中文陌生领域上的收益由 `tools/probe-adapt.mjs` 度量（换说法 hit@3 40% → 80%，第一名改判 0 题）。这条边界必须与读数同时引用，否则等于把「没变」说成「没进步」。

### A2.2 0.6.2 纯检索复跑（2026-11-24，`tools/bench-locomo.mjs`）：换一把**更轻**的尺子，把「空回」量出来了

- 口径不同，先说清楚：不走 ingestion / sidecar，直接把 `locomo10.json` 里的**原始对话轮当记忆**（`{id: dia_id, title:'', content:'Speaker: text'}`），`Meow.search` 一把过、`k=20`、`bandKeep:false`、剔 category 5 → 1,531 问。所以**绝对值不与 A2 / A2.1 的 hit@20 0.7546 比较**，它只用于「同一把尺子前后对比」和「发现失败模式」。
- 读数：hit@1 0.3932 / hit@5 0.6192 / hit@10 0.6924 / hit@20 0.7511 / MRR 0.4958 / recall@20 0.6322 / 平均取回 17.8 / **空回 0.0000**（修之前 0.0052）。
- 收益：量出并修掉一个**把「有」说成「没有」**的缺陷（8 问回空回执），修完排序读数逐位不变——这是「少犯错」而不是「更聪明」，引用时别写成分数提升。
- 同版在这把尺子上**否掉两条候选**（读数留在 `docs/PLAN-0.6.md` §12）：英文词形归一（Porter-lite 词干化双边 0.7198 hit@20 / 0.4598 MRR、复数合并 0.7218 / 0.4622，比原始 0.7511 / 0.4958 全面变差）；MMR 重排（λ=0.7 时 hit@20 0.7577、MRR 0.4957，hit@5 0.6192 → 0.6172，属噪声级）。
- 限制（引用时必须带）：单次运行无 std、无 LLM 判分、`bandKeep:false` 是评测口径而非产品默认；top-20 里命中 ≠ 回答正确。

---

## B. 已过期，不得当现状引用

全部来自同一次运行：**2026-11-20**，数据集 LoCoMo（OmniMemEval 协议，1,540 题，剔 category 5），结果目录 `results/locomo/macromem-omni3`，判分器 deepseek-chat（不是官方强模型），**被测代码是 0.2.x 时期的 meow 核心**。

| 项 | 旧读数 | 口径补充 |
|---|---|---|
| 端到端 LLM-judge 准确率 | 71.95 | 单次运行，无标准差；judge 是 deepseek-chat |
| 检索侧 recall@20 / hit@5 / hit@20 | 0.672 / 0.606 / 0.740 | 自写 scorer（`score_locomo.py`），不是官方脚本 |
| MRR / nDCG@10 | 0.468 / 0.480 | 同上 |
| 分类准确率 | multi-hop 0.5887 / temporal 0.7227 / open-domain 0.4896 / single-hop 0.7883 | 同上 |
| 上下文均长 / top-k | 5,486 字符 / top-k=20 | 同上 |
| 上一版对照 | omni1 0.5351 → omni2 0.5987 → omni3 0.7195 | 三个版本之间的差值可用，绝对数不可用 |

**过期原因（一句话）**：2026-11-20 之后检索层又动了上百个版本（0.2.177 同义词桥、0.2.179 覆盖度打折、分档收口、dedupe、cap、实体先验、日期回传等），到 0.3.0 接口面冻结又是一次大改。**这期间没有重跑过端到端评测。**

主人 2026-11-22 的原话：「LLM测试不是很早跑的吗 我记得早就是过期数据了」。

---

## C. 引用规则（写回执 / 改 README / 写 DESIGN 之前自查）

1. 三件套（日期 + 版本/commit + 口径）缺一项 → 必须写成「历史读数」。
2. 不许把自建 gold / 自写 scorer 说成公开榜单；不许把单次运行说成均值。
3. 不许写「提升 N pt」，除非那次 A/B 是**经主人点头**跑出来的新基线；否则只能写「假设，待验证」。
4. 不许拿 `probe-gold` / `probe-recall` 的仓库内断言数冒充端到端效果——它们是**回归闸门**，不是效果广告。
5. 同一句话里出现两个数字时，两个都要带口径；只有一个带口径的句子等于两个都没带。

---

## D. 怎么重测（**每次都要主人点头**）

数据集与本机事实（2026-11-22 复核仍在）：

- 数据集：`E:\Temp\omni\OmniMemEval-main`
- 环境文件：`.env.macromem`（ANSWER / EVAL 均走 deepseek-chat）
- 旧结果：`results/locomo/macromem-omni{1,2,3}`（含 2026-11-20 的 LLM-judge 那三轮）、`macromem-omni4`（2026-11-22 本地 gold 检索）

**本地 gold（不花 key）的跑法见 A2**：ingestion → search → `score_locomo.py`，三步都是本地计算；search 的结果缓存会按 `tmp/` 里的分片复用，改评测逻辑后要把 `tmp\` 先移走（本次移到 `tmp_stale_band\`）才会重算。**`--version` 必须与 ingestion 时一致**——user_id 带版本后缀，换名等于指向另一套空库（`avg_retrieved 0.0`）。

成本（**历史读数，2026-11-20 那次实测，仅作预算参考**）：ingestion 7m42s（10 用户 / 1,540 题）、search 30s、answer ≈2m、judge ≈2m30s；三次 answer 合计 prompt 5.51M + completion 0.15M token，约 ¥20。

本机约束：没有 bash，`scripts/*.sh` 不能执行，必须直接调 python 模块；脚本入口要求 `$env:OMNIMEMEVAL_ENV_FILE='.env.macromem'`，否则 `utils/env.py` 直接 `sys.exit(1)`。

跑完必须同时更新本文件表 A（新日期 + 新 commit）与 PLAN-0.4 §8 进度账；只更新一处等于制造第二套口径。

---

## E. 复核清单（谁都能复现）

```powershell
cd D:\dsh-home\vendor\dsh-macro-memory
node tools/check-all.mjs          # 30/30，断言数 = 表 A 那个数
node tools/doctor.mjs             # 两棵树 181 文件字节一致
node tools/probe-mq.mjs           # MQ1–MQ9 全绿（查询分解量尺）
node tools/probe-consolidate.mjs  # P1–P11b 全绿（写入端巩固量尺）
node tools/probe-hygiene.mjs      # H1–H18 全绿（写入端通胀量尺，含真 sqlite）
node tools/probe-supersede.mjs    # S1–S15 全绿（自动取代量尺，桩 flow 数调用）
node tools/probe-entity.mjs       # E1–E31 全绿（实体层与动态跳数量尺）
node tools/probe-cooc.mjs         # K1–K6 十八条全绿（共现自学习扩词量尺）
git log --oneline -1              # 与表 A 的 commit 对齐
```

```powershell
# 本地检索 gold 口径（不花 key，见 A2；约 8 分钟）
cd E:\Temp\omni\OmniMemEval-main
$env:OMNIMEMEVAL_ENV_FILE='.env.macromem'
python scripts\locomo\locomo_ingestion.py --lib macromem --version omni5 --workers 2 --clear
python scripts\locomo\locomo_search.py   --lib macromem --version omni5 --workers 2 --top-k 20
python E:\Temp\omni-eval\score_locomo.py --data data\locomo\locomo10.json --results results\locomo\macromem-omni5
```

```powershell
# 口径自查：每条命中都必须同句带「2026-11-20 / omni3 / 0.2.x」
Select-String -Path README.md,docs\*.md -Pattern "71\.95|0\.7195"
```

命中后逐条看：带三件套的是「引用」，不带的就该改成带口径，或者删掉。
