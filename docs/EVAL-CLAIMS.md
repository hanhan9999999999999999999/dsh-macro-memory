# 评测口径单（EVAL-CLAIMS）

**一句话**：本文件是仓库里唯一承认的「评测数字出处」。表 A 之外的一切数字都是**历史读数**——可以拿来决定先做哪件事，不许拿来当现状、不许写进宣传、不许当回归基准。

判据只认一句话：**任何数字要出场，必须带齐「日期 + 版本/commit + 数据集口径」三件套；缺一项就当场标成历史读数。**

---

## A. 现在能引用的（现状读数）

| 项 | 读数 | 日期 | 版本 / commit | 复核命令 |
|---|---|---|---|---|
| 健康基线 | 79 支 suite / **4,813 断言** / failed 0 / 与 baseline 逐支一致（约 400s） | 2026-11-27 | 0.9.1 | `node tools/check-all.mjs` |
| 两棵树同步 | drift 0 / extra 0（同步后） | 2026-11-24 18:00 | 0.6.32 | `node tools/doctor.mjs`（结果 PASS）；`node tools/sync-trees.mjs --apply` |
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
| 标点是外壳，不是内容（单字带标点） | 0.6.4 的闸门只认「正好一个码点」，真人问法几乎总带标点：**`读？` / `读?` / `读。` / `读，` / `「读」` / `读…` / `读·` / `钱:` 全部回空**（而 `读` 命中 2 条）。改后：剥掉标点与空白、要求**剩正好一个汉字**才走兜底，命中按 `needle1` 找子串；`读1` / `读9` / `读x` / `读$` / `读+` / `读读` 一律不放行，纯标点仍空手，`读 读` 与 `读` 同集合。读数代价 **0**：LoCoMo hit@1/5/10/20 = 0.3932/0.6192/0.6924/0.7511、MRR 0.4958、recall@20 0.6322、空回 0.0000 逐位相同；真库 52 问 0.921 / 0.417 / 0.500 与两条 #2→#1 位移不动；`probe-gold` G8 空手仍 10/14 | 2026-11-24 02:2x | 0.6.5 · meow 补丁 `[macro-fusion 0.6.5]` | `node tools/probe-literal.mjs`（18 条，L9–L13 为 0.6.5 新增，L13 为子进程能红证明） |
| 脏记忆不许把检索打成异常（数据形状） | `docText` 的 `...d.keywords` 遇上缺字段 / `null` / 逗号串（导入行、别的插件写的行、调用方自拼 `docs`）→ **`TypeError: d.keywords is not iterable`**，`findSimilar`（邻居）/ `topicDrift` / `verbatimInputs` 一崩全崩：不是「少一条命中」，是整次检索拿不回任何回执。改后：唯一入口 `kwList(d)`（数组 / 非字符串回空 / JSON 串 / `,，、;；` 四路），`docText`、打分面 `kwToks`·`kwSets`、`keywordHitScore` 的 `content` 全走它；**索引签名也走它**（字符串词表被改写要让缓存失效）；顺带让逗号串关键词真进 tf-idf（原来被 `Array.isArray` 判成空表、老数据的关键词一直隐形）。读数代价 **0**：LoCoMo hit@1/5/10/20 = 0.3932/0.6192/0.6924/0.7511、MRR 0.4958、recall@20 0.6322、空回 0.0000 逐位相同；真库 660 条 52 问三档 0.921 / 0.417 / 0.500 与两条 #2→#1 位移不动（这两份语料的 keywords 本就是数组或缺失） | 2026-11-24 03:13 | 0.6.6 · meow 补丁 `[macro-fusion 0.6.6]` | `node tools/probe-dirty.mjs`（D1–D8 九条，D8 为子进程能红证明） |
| 判据自己的寿命：会随时间前进的量写成单调式 | 不是产品的病，是**判据的寿命**：版本号 / 支数 / 断言总数 / 耗时预算每版都在动，写成 `===` 就每升一版必红（`0.2.31→35` 四遍版本等值；`0.6.2→0.6.7` 每版手工抬 `steps.length === 35 → 36` 并连带改两处手抄的「N 支 / M 条」，0.6.6 先写 3,615、实测 3,616，回改五份文件）。改后：支数改**地板**（`SUITE_FLOOR = 37` + `steps.length >= SUITE_FLOOR`，减支立刻红、加支不必动判据）；文档「现在」的数由探针读 `tools/baselines.json` 的 `counts` 合计**自动对账**；历史里程碑冻结自己那版的数字（0.6.6 仍 3,616）；版本阶梯按版本号两两比。引擎一个字节没动，读数逐位不变（LoCoMo 0.3932/0.6192/0.6924/0.7511、MRR 0.4958、空回 0；真库 0.921/0.417/0.500） | 2026-11-24 03:2x | 0.6.8 · 判据层（`tools/probe-monotone.mjs` + `verify.mjs` 的 `MT068`） | `node tools/probe-monotone.mjs`（9 条，M3 为扫描器能红也认绿） |
| 一条坏行不许把检索打成异常（元素形状） | 0.6.6 只归一化了**字段**，元素还裸露着：`docs` 里混进一条 `null` / `undefined` / 标量（半写的行、导入截断、调用方把 id 列表当 `docs`）→ `docText` 的 `d.title` 抛 **`TypeError: Cannot read properties of null (reading 'title')`**（`verbatimInputs` 是每条问句的第一道工序，一条坏行 = 整次检索异常）；`docs` 不是数组时死在 `docs.length`（`Cannot read properties of null (reading 'length')` / `docs.map is not a function`）；`keywordHitScore` 自己遍历取 `content` 另崩一处。改后：唯一入口闸 `liveDocs(docs)`（非数组回 `[]`、逐条问「是不是对象」、脏了才 `filter`、**干净数组原样返回同一引用**），`search` 与 `keywordHitScore` 各一行 `docs = liveDocs(docs);`；全是坏行回空数组（脏数据可以存在，不许有话语权）。读数代价 **0**：LoCoMo hit@1/5/10/20 = 0.3932/0.6192/0.6924/0.7511、MRR 0.4958、recall@20 0.6322、空回 0.0000 逐位相同；真库 52 问 0.921 / 0.417 / 0.500 与两条 #2→#1 位移不动；660 条含一条 `null` 的耗时与干净池同量级（1.5ms vs 2.7ms） | 2026-11-24 03:13 | 0.6.7 · meow 补丁 `[macro-fusion 0.6.7]` | `node tools/probe-dirty.mjs`（15 条，D9–D13 为 0.6.7 新增，D13 为子进程能红证明） |
| 原样匹配也要记账（固定开销） | 接着 0.6.10 算账，这次按**通道**开账（同语料同问句，只关一条通道取差值）：原样匹配为了拿到 haystack，每次检索都跑 `docs.map((d) => textOf(d).toLowerCase())`（`id + project + title + content + keywords.join(' ')` 拼一遍再小写，10,000 条 = 2.03 MB），占一次热检索 **35.7% / 50.6% / 42.7% / 42.9%**（660 / 2,000 / 5,000 / 10,000）；再拆一层，10,000 条时「拼 haystack」**5.78 ms** vs「逐条扫标识符」**0.51 ms**——钱在造串。改后 haystack 搬进索引（`hayArr` + 懒建 `hayAt(di)`，`built` / `reused` 记账），无标识符时一条不建；顺带补齐 0.6.10 的洞：haystack 含 `project`，而 `project` 从不进签名，搬进索引后会「改 project 拿旧串答新库」→ `sigDocHash` 与值比较都补 `project`，`probe-signature` 加 S10。读数（全量检索）：660 **2.04 → 1.62**、2,000 **5.04 → 4.20**、5,000 **11.88 → 9.12**、10,000 **24.45 → 18.82 ms**（**−20.6% / −16.7% / −23.2% / −23.0%**），原样匹配份额降到 18.6%–34.9%。排序代价 **0**：LoCoMo hit@1/5/10/20 = 0.3932/0.6192/0.6924/0.7511、MRR 0.4958、recall@20 0.6322、空回 0.0000 逐位相同；真库 52 问 0.921 / 0.417 / 0.500 与两条 #2→#1 位移不动；`0.6.0 关 与 v0.5.0 逐位相同？ true` | 2026-11-24 05:0x | 0.6.11 · meow 补丁 `[macro-fusion 0.6.11]` | `node tools/probe-verbatim.mjs`（9 条，V9 为「只按条数当缓存键」的坏实现能红）+ `node E:\Temp\cmp\scale011.mjs`（吞吐量具） |
| 定序只排前 k（固定开销） | 0.6.10/0.6.11 把签名与原样匹配记上账之后，`--cpu-prof` 按函数归因点到最大一块是**定序**：`bandize` 16.5% + 档内 raw 比较器 7.7% + 最终比较器 16.1% = **40.3%（约 11 ms/问，10,000 条 / 300 问）**，比扫文档（11.3%）还贵。病根是「为交 5 条排全量」：先按 `_raw` 排一遍定档（`Map<hit, band>`），再按（档 / 分数 / 时间 / id）排一遍定序，而三个调用点（`search`、`literalFallback`、`keywordHitScore`）之后都只取前 k。改后：档号直接写 `h._bandTmp`（撤 `Map`）、比较器抽成 `orderOf`（四把钥匙一处定义，全序与有界堆共用）、`bandize(hits, rawKey, limit)` 用**有界最大堆**选前 k（`want >= total` 退回全量排序，小库 / `k` 大 / `k=Infinity` 逐位不变），截断后才落 `_band` / `explain.band` 并 `delete _bandTmp`。读数：`search` **27.377 → 19.985 ms（−27.0%）**、`searchAdaptive` **31.086 → 23.097 ms（−25.7%）**，定序份额 **40.3% → 21.5%**（`orderOf` 自身 0.9%）；`searchIndexOf` 0.751 ms 与冷建索引 270.7 ms 未动。排序代价 **0**：前 k 与「全量排完再切」逐位相同（500 组随机语料 × k∈{1,2,5,8,20,∞} 对拍），`hitsSum` 1,500 不变；LoCoMo hit@1/5/10/20 = 0.3932/0.6192/0.6924/0.7511、MRR 0.4958、recall@20 0.6322、空回 0.0000 逐位相同；真库 52 问 0.921 / 0.417 / 0.500 与两条 #2→#1 位移不动 | 2026-11-24 05:2x | 0.6.12 · meow 补丁 `[macro-fusion 0.6.12]` | `node tools/probe-order.mjs`（8 条，O8 为「丢掉档位筛选」的坏实现能红）+ `node E:\Temp\cmp\prof012b.mjs`（吞吐量具） |
| 定档不再靠全量排序（固定开销） | 0.6.12 之后复测，剩下最贵的一块仍是**排序**，而且是「只为算档位」那一遍：`bandize` 自证 10.9% + 内部 raw 比较器 10.6% = **21.5%**。病根：档号只由「排序后的不同 raw 值」决定，与对象身份、其余字段无关，却按「对象对儿」的代价去算（10,000 条约 13 万次比较，每次两次属性读 + 一次减法）。改后：①把参与定档的 raw 抄进 `Float64Array`（指认档 `_ident` / `_subj === 1` 不抄，老代码对它们 `continue`，既不定档也不当锚点），`vals.sort()` 走 TypedArray 原生数值排序 ②按降序走阈值链（`v < IMP_BAND * anchor` 才开新档）得锚点表并翻成升序 ③每条二分出「第一个 ≥ v 的锚点下标 `lo`」，档号 = `m - 1 - lo`（一次 `log m` 数值比较，零字段访问）④**退回路**：负数（`0.85·a > a`）与 `NaN`/`undefined`/`null`/`Infinity` 上阈值链前提不成立 → `setBandsByThreshold` 返回 `false`，`bandize` 调 `setBandsBySort`（0.6.12 老代码原样留成独立函数，逐位可对照）。读数：`search` **19.985 → 16.329 ms（−18.3%）**、`searchAdaptive` **23.097 → 18.812 ms（−18.6%）**、定档那块 **21.5% → 7.8%**（`setBandsByThreshold` 7.0% + `bandize` 0.8%），`searchIndexOf` 0.703 ms 与冷建索引 259 ms 噪声内持平。排序代价 **0**：真库 52 问 0.921 / 0.417 / 0.500 与两条 #2→#1、LoCoMo 0.3932/0.6192/0.6924/0.7511、MRR 0.4958、recall@20 0.6322、空回 0.0000、`hitsSum` 1,500 全部逐位不变 | 2026-11-24 05:5x | 0.6.13 · meow 补丁 `[macro-fusion 0.6.13]` | `node tools/probe-order.mjs`（10 条，O9 负数 60 组 / O10 脏值 40 组都退回老路且与 `refBandize` 逐位一致）+ `node E:\Temp\cmp\prof012b.mjs`（吞吐量具）+ `--cpu-prof` 归因 |
| 热路上不留痕（固定开销） | 0.6.13 之后函数视图只剩「在干活」的样（`search` 自证 45.8%、`scanDoc` 17.8%），换行视图（`E:\Temp\cmp\prof-lines.mjs` 读 `positionTicks`）才看见病灶：`delete h._lv;` 一行 **791.5ms**，`delete h._vb;` + `delete h._sr;` 另 **353ms**，合计 **1.14s / 5,671.8ms（约 20%）** 花在摘临时值。病根：hit 对象上四个「先用后摘」的中间值（`_vb` 原样命中位 / `_sr` 句式比 / `_lv` 层级意图 / `_tr` 断言密度）用完 `delete`，而 `delete` 把对象打进**字典模式**，此后每次属性读写（含 0.6.13 刚优化的 `bandize` 里 `h._raw`、`orderOf` 读分数与时间）都走哈希表——省四次赋值，赔整条热路。改后：①四个临时值改放**与 hits 同下标的平行数组**（`vbTmp`/`srTmp`/`lvTmp`/`trTmp`，push 紧挨 `hits.push`，收尾按 `hi` 读），回执对象字段集合一个不增一个不减②**idf 每趟记一次账**（`idfCache` + `idfAt(t)`，同一个 `Math.log` 不再逐条重算；自适应换尺子时清账 `idfCache = new Map();`）③顺带收掉 `raw.slice()`（仅 `explain` 开时留）与 `Math.max(...raw)`（10k 参数展开 → 循环，`!(v <= maxRaw)` 保住 `NaN` 传播）。读数：`search` **16.329 → 11.567 ms（−29.2%；相对 0.6.12 的 27.377 累计 −57.7%）**、`searchAdaptive` **18.812 → 13.520 ms（−28.1%）**、`searchIndexOf` 0.679 ms 与冷建 275 ms 噪声内持平。排序代价 **0**：真库 52 问 0.921 / 0.417 / 0.500 与两条 #2→#1、LoCoMo 0.3932/0.6192/0.6924/0.7511、MRR 0.4958、recall@20 0.6322、空回 0.0000、`hitsSum` 1,500 全部逐位不变 | 2026-11-24 06:4x | 0.6.14 · meow 补丁 `[macro-fusion 0.6.14]` | `node tools/probe-hotpath.mjs`（6 条，H3/H4/H5 为「下标错位」的坏实现能红）+ `node E:\Temp\cmp\prof012b.mjs`（吞吐量具）+ 行级归因 |
| 覆盖度顺着倒排记一遍账（固定开销） | 0.6.14 之后函数视图仍只有「在干活」的样（`search` 自证 40.6%、`scanDoc` 18.8%），行视图点出 `scanDoc` 最热一行是**覆盖度**那句 `for (const term of qKept) if (tfi.has(term)) cover += idfAt(term);`——**573.9ms / 300 问（1.9ms 一问）**。病根：覆盖度是「词 × 文档」的二维账，算法却对每条候选人（最多 10,000）把问句词表（几十词）从头问一遍 `Map.has`，每问几十万次哈希查找只为算出 10,000 个数，而倒排 `postings` 本来就记着「每个词出现在哪些条里」。改后：①**问句 idf 每趟记一次**（`qKeptIdf` / `qLoopIdf` 两个 `Float64Array` + `refreshQidf()`，打分循环 `const idf = qLoopIdf[qi]`）②**覆盖度顺倒排记账**（`coverAcc` 按 `docs.length` 开零表，`buildCoverAcc()` 按 qKept **原序**把 `qKeptIdf[qi]` 加到 `postings.get(term)` 的每一条上；`scanDoc` 只剩 `coverOf[di] = Math.min(1, coverAcc[di] / qIdfSum)`）——加法顺序仍是 qKept 原序，每条浮点和逐位不变③**倒排缺席退回原路**（`opts.inverted === false` → `postings === null` → `coverAcc === null`，退回路一个字没动）④循环头 `const dOf = docs[di];`（这一条下面要读十来次同一条记录的字段）；换尺子那趟顺序钉死「`idfCache = new Map();` → `refreshQidf()` → `buildCoverAcc()` → `raw.fill(0)` 重扫」。读数（五次取中位）：`search` **11.567 → 10.673 ms（−7.8%；相对 0.6.12 的 27.377 累计 −61.0%）**、`searchAdaptive` **13.520 → 12.522 ms（−7.4%）**、覆盖度那一行 **573.9 → 14.9 ms（−97.4%）**、`scanDoc` 自证 **23.8% → 18.8%**、`searchIndexOf` 0.698 ms 与冷建 271 ms 噪声内持平。排序代价 **0**：真库 52 问 0.921 / 0.417 / 0.500 与两条 #2→#1、LoCoMo 0.3932/0.6192/0.6924/0.7511、MRR 0.4958、recall@20 0.6322、空回 0.0000、`hitsSum` 1,500 全部逐位不变 | 2026-11-24 07:0x | 0.6.15 · meow 补丁 `[macro-fusion 0.6.15]` | `node tools/probe-cover.mjs`（6 条，C1 倒排开关两路对拍、C3 钉换尺子源码顺序、C4 空手问句不留 `NaN`）+ `node E:\Temp\cmp\prof012b.mjs`（吞吐量具）+ 行级归因 |
| 打分顺着倒排累加（固定开销） | 0.6.15 之后 `scanDoc` 掉出函数视图前 25 名，热点换到打分循环那句 `const f = tfi.get(term);`——**535.3ms / 300 问**（`prof16/s16.cpuprofile`，总采样 3,295.9ms）。病根：BM25 的三个输入里**词频**与**字段命中**建索引时就定死、倒排 `postings` 顺手能记，只有字段权重值（`FIELD_KW_W` = `opts.fieldKwW`）是**每问参数**不能预乘；可老实现把前两件事全留在热路上——每条候选人 × 每个问句词三次哈希查找，且大多是「这个词这条根本没有」的空手。改后：①倒排值扩成 `{ d, f, t }`（下标 / 词频含 `kwTfW` 加成 / 字段命中位 `1=标题 2=关键词` 的位或），`f`/`t` 按 `m` 插入序 push 与 `d` 同下标对齐②打分倒过来扫词（`scoreCandSet`）：先备候选常数（`coverOf`、`kDen[di] = k1 * (1 - bEff + bEff * len / dl)`、协调项），再按 `qLoop` **原序**把 `idf0 * fw * (f * (k1 + 1) / (f + kDen[di]))` 加进 `raw[di]`，收尾按候选表补 `synOf`/协调项/实体层③逐条扫的退路一个字没动（`opts.inverted === false` 或 `verbOn` → `candSet === null`，首趟与换尺子那趟两处）；换尺子那趟 `scoreCandSet` 开头必须 `candArr.length = 0;`（少了它同一条会被算两遍，症状恰好是「非自适应路逐位相同、只有 `0.6.0 开` 偏」）。读数（三次取中位）：`search` **10.673 → 8.35 ms（−21.8%；相对 0.6.12 的 27.377 累计 −69.5%）**、`searchAdaptive` **12.522 → 10.16 ms（−18.9%）**、总采样 **4,143.7 → 3,295.9ms**；代价一条：**冷建 271 → ~300ms（+11%，倒排每词多存两个数组，只付一次）**。排序代价 **0**：真库 52 问 0.921 / 0.417 / 0.500 与两条 #2→#1、LoCoMo 0.3932/0.6192/0.6924/0.7511、MRR 0.4958、recall@20 0.6322、空回 0.0000、`hitsSum` 1,500 全部逐位不变 | 2026-11-24 07:4x | 0.6.16 · meow 补丁 `[macro-fusion 0.6.16]` | `node tools/probe-score.mjs`（6 条，S1 倒排开关两路对拍、S2 字段命中位四档等价、S3 钉换尺子先重铺候选）+ `node E:\Temp\cmp\prof012b.mjs`（吞吐量具）+ 行级归因 |
| 签名自己也要记账（固定开销） | 不是排序问题，是**每问一次的固定开销**：`indexSignature` 每次检索都把整库从头哈希一遍（`content.slice(0,40)` + `slice(-40)` + `kwList(d).join('\u0001')` 三次分配 + 逐字符 `Math.imul`），而它回答的「库没变」绝大多数时候答案是「没变」。实测（660 / 2,000 / 5,000 / 10,000 条同构语料）：签名 **0.96 / 2.84 / 7.04 / 14.16 ms**，占一次热检索的 **28.8%–30.6%**。改后按**条**记账（`SIG_DOC_CACHE = new WeakMap()` 存条级 32 位哈希 + 字段值快照，逐字段 `===` 判等——比的是**值**不是对象身份；条级哈希从滚动值里拆出来才能缓存；判不出有没有变的形状走直算）：签名 **0.062 / 0.189 / 0.528 / 1.198 ms（15×）**、占比降到 **2.8%–3.5%**，热检索 3.24→2.18 / 9.67→6.80 / 23.0→15.3 / 49.2→37.6 ms（**−33% / −30% / −33% / −24%**）。排序代价 **0**：LoCoMo hit@1/5/10/20 = 0.3932/0.6192/0.6924/0.7511、MRR 0.4958、recall@20 0.6322、空回 0.0000 逐位相同；真库 52 问 0.921 / 0.417 / 0.500 与两条 #2→#1 位移不动 | 2026-11-24 04:2x | 0.6.10 · meow 补丁 `[macro-fusion 0.6.10]` | `node tools/probe-signature.mjs`（9 条，S9 为「只按对象身份记账」的坏实现能红）+ `node E:\Temp\cmp\scale010.mjs`（吞吐量具） |
| 一个汉字也是问题（单字可达性） | `tokenize` 的中日韩只产二元组，一个汉字的问句切出空数组、`search` 第一道门直接回空：**`读`/`钱`/`花` 这类问句在库里有答案时回执为空**（`tokenize('读')` → `[]`、`tokenize('读两遍')` → `['读两','两遍']`）。改后：切不出词且问句是**单个汉字**时按原文子串在 title/content/keywords 里计数、仍交回四把钥匙定序，`search` 与 `keywordHitScore` 两条路径同改。读数代价 **0**：LoCoMo hit@1/5/10/20 = 0.3932/0.6192/0.6924/0.7511、MRR 0.4958、recall@20 0.6322、空回 0.0000 逐位相同；真库 660 条 52 问三档 0.921 / 0.417 / 0.500 与两条 #2→#1 位移不动；`probe-gold` G8 空手仍 **10/14**（闸门是「一个码点 + 汉字」，`the`/`a` 不做子串，不开口） | 2026-11-24 02:0x | 0.6.4 · meow 补丁 `[macro-fusion 0.6.4]` | `node tools/probe-literal.mjs`（L1–L8 十一条，含子进程能红证明） |
| 同一问句同一答案（定序） | 定序四把钥匙（分档 → 分数 → 更新得更晚的在前 → id 自然序）之后：**同进程连跑 5 次逐位相同、跨进程哈希一致（`27e6455559a98f74`）、语料打乱 seed 3/11/42 前十逐位相同**，`searchAdaptive` 跨 idf 闸门同样顺序无关；并列时 `updated_at` 9000 排在 1000 前，`D1:2` 排在 `D1:10` 前；检索定序里已无 `localeCompare`（全文件仅剩 2 处显示分组）。改前：40 条同构语料原序 `t-00..t-04` / 乱序 seed=1 `t-31,t-23,t-28,t-38,t-27`。读数代价 **0**：LoCoMo hit@1/5/10/20 = 0.3932/0.6192/0.6924/0.7511、MRR 0.4958、recall@20 0.6322、空回 0.0000 与改前逐位相同（纯字典序会掉到 0.3926/0.6179/0.7505/0.4953，故 id 用数字段自然序）；真库 660 条 52 问三档 0.921 / 0.417 / 0.500 与两条 #2→#1 位移不动 | 2026-11-24 01:15 | 0.6.3 · meow 补丁 `[macro-fusion 0.6.3]` | `node tools/probe-determinism.mjs`（D1–D8 九条，含子进程能红证明） |

关于「3,341」的来路：3,323（0.3.0 冻结）→ 3,332（P1 的 9 条 `mq:` 判据）→ 3,331（verify 支数断言 24→25）→ 3,341（新增 `tools/probe-mq.mjs` 9 条量尺，套件 24→25）。中间那一次 3,331 是过渡态：`probe-mq` 还没改成 `PASS` 行格式，在基线里被记成 0 条——**输出不是 `PASS`/`FAIL` 开头的探针，在 check-all 里等于没记账**（`countPass` 数的是 `/^PASS/gm`）。引用旧文章里的 3,323 / 3,332 时要说明它是 P1 前后的过渡基线。

关于「3,367」的来路：3,341 → **3,367**（+26 = 12 条 `co:` 判据 + 12 条 `tools/probe-consolidate.mjs` + `param-audit` 的 `1.1b` + `probe-graph` 1 条，套件 25→26）。这里也有一个过渡态 **3,365**：`param-audit` 判红后 `process.exit(1)`，把 20.6s 的耗时截成 1.6s 记进基线，转绿之后反报「慢了 13 倍」。**一条支从红转绿，耗时基线要手工回填成绿态读数**——`--update-baselines` 会把失败路径的速度当成正常（`docs/INTERNAL.md` 9.192）。

关于「3,398」的来路：3,367 → **3,398**（+31 = 12 条 `hy:` 判据（verify 的 A58d）+ 18 条 `tools/probe-hygiene.mjs`（H1–H18）+ 1 条 `tools/doctor.mjs`（补上 `probe-hygiene.mjs` 的文档出处后那条 WARN 转 PASS 才计入），套件 26→27）。verify 单支 1,757 → 1,769，其余 26 支 1,610 → 1,629。同一节 `docs/INTERNAL.md` 9.193 记了这段的四个连带坑：`probe-words` 把「体检六类」写死、`PANEL_SUMMARY` 220 字撞 200 字可读性尺、`verify` 的 `steps.length === 26` 与 `check-all` 支数注释、schema 体积 13,366 → 13,372 B。

关于「3,523」的来路：3,511 → **3,523**（+12 = 12 条 `tools/probe-adapt.mjs`（A0 三条 / A1 / A2 两条 / A3 / A4 两条 / A5 两条 / A6 一条）+ 0 条 `verify.mjs`（支数断言 30→31 只是数字没加条）+ `tools/doctor.mjs` 绿态回填 ±2，套件 30→31）。A6 是 11-23 复跑 LoCoMo 之后补的：它不量收益，只钉边界——纯拉丁语料上 `coocForms` 恒空、两遍与一遍逐位相同，谁将来想让英文也吃到桥，先让这条红再改判据与文档。**这一版最该记住的一条**：改判据不是改数字，是改因果——`probe-gold` 的 G-W4 从「宽池 ≥ 窄池」改成守绝对量（窄池照抄 0.977 → 1.000 之后，相对判据把「真干扰项压到第 2」判成红），`probe-adapt` 的消融从 hit@1 换到 hit@3（桥是补位性质，命中提升全在 2、3 位）。两处都把「为什么改、改了代价是什么」写进注释与 `docs/INTERNAL.md` 9.198。

关于「3,540」的来路：3,523 → 3,536（+13 = 13 条 `tools/probe-idf.mjs`（D1 默认=关 / D2 小池不动 / D3 λ 上限 0 / D4 闸门不是摆设 / D5 全泛词退全库 / D6 结构不变量 / D7 窗口各归各簇 / D8 α 真的接上 / D8b cap 真的接上 / D9 p95 增量 / D10 返回字段不变 / D10b 回执带 `status` / D11 候选不凭空造）+ 0 条 `verify.mjs`（支数断言 31→32 只是数字没加条），套件 31→32）→ **3,537**（+1 = 0.6.1 的 `probe-idf` **D12 接线点**：`rankForSearch` 的产品入口必须默认开、`searchAdaptive` 的词形桥那遍必须显式关，两处正则都在源码里把住；删掉任何一处，前 13 条仍全绿而线上悄悄退回 0.5.0——这条专治「判据全绿、行为回退」的沉默故障，已用「把两行抹掉后再跑正则」证明能红）→ **3,540**（+3 = 0.6.1 收尾给 `check-all --update-baselines` 的收敛轮配的三条哨兵：`verify.mjs` A16 里「记完会收敛（数与基线不同就地重跑、最多 3 轮）」与「收敛不了就说在晃」（+2），以及「红的那一支不记账（FAIL 那一路少走一段，条数不可信）」（+1）；这三条都对着 `tools/check-all.mjs` 的源码形状判，删掉收敛逻辑就立刻红）。**这一版最该记住的一条**：`probe-idf` 不测准确率——准确率要 ≥300 条真实语料才有意义，硬造「刚好翻转」的合成样张只能得到假绿（试过两条思路都自相矛盾：正解不进 top-8 就永远修不回来；「簇内普及但全库稀有」在数学上要求 p 同时高和低）。它只钉三件事：**这机制不许动小库与默认路径**（D1/D2/D3 逐位相同）、**旋钮真的接在判分上**（D4/D6/D8/D8b 能红）、**接线点不许被顺手摘掉**（D12）。准确率读数落在 `docs/PLAN-0.6.md` §1 与本节「库变大后的照抄召回」行，两边数字必须同源。

关于「3,587」的来路：3,569 → **3,587**（+18 = `tools/probe-literal.mjs` 的 L1–L8 十一条，+ `verify.mjs` 新开的 `LT064` 一节七条，套件 34→35）。这一组钉的不是「排序更准」，而是**「问句可达」**：一个汉字进来，分词器切不出词，系统也不许把它当成「库里没有」——L1/L2 单字与 keywords 命中、L3/L4 停用词与标点仍空手、L5 定序不看插入顺序、L6 三条路径同口径、L7 挖掉兜底即回空（子进程里量）、L8 库里没有的字仍空手。

关于「3,599」的来路：3,587 → **3,599**（+12 = `tools/probe-literal.mjs` 11→18 的 L9–L13 七条，+ `verify.mjs` 新开的 `LT065` 一节实测净增五条；套件仍 35，因为这一版只扩条数不开新支）。L9 钉「八种标点逐个命中且与剥掉标点同集合」、L10 钉「闸门剥的是标点不是短」（`读1`/`读x`/`读$`/`读+`/`读读` 全 0，纯标点仍空手）、L11 钉「同字重复按一个算」、L12 钉「标点版三条路径同口径」、L13 钉「把闸门退回 0.6.4 的 `cps.length !== 1` → `读` 仍中而 `读？` 回空」（子进程里量 `1,0`）。这一组证明的是**用户打的是问句，不是测试用例**：标点是语气，不该把问题变成「没有」。

关于「3,616」的来路：3,599 → **3,616**（+17 = `tools/probe-dirty.mjs` 的 D1–D8 九条，+ `verify.mjs` 新开的 `DT066` 一节七条，另有一格落在既有的版本对齐计数里，套件 35→36）。这一组钉的是**「数据有坏形状，代码不许变成异常」**：D1 缺 `keywords` 的多词问句不再抛 / D2 缺字段的条目仍可被命中（归一化不是跳过）/ D3 逗号串当词表用（真进 tf-idf）/ D4 `null`·数字·对象既不抛也不凭空命中 / D5 脏条目混进干净池不改写别人的第一名 / D6 `content` 缺失既不抛、也不把字面量 `undefined` 成词 / D7 三条路径同口径 / D8 把 `kwList` 换回 `[...d.keywords]` → `not iterable`（子进程里量）。`DT066` 另外钉住 `docText`/`kwToks`/`kwSets`/索引签名四处都走 `kwList`、旧写法清零——这条最容易「改一处、漏三处」，所以断言按四处逐个点名。

关于「3,641」的来路：3,627 → **3,641**（+14 = `tools/probe-monotone.mjs` 的 M1–M8 九条，+ `verify.mjs` 新开的 `MT068` 五条，套件 36→37）。这一组钉的不是「检索更准」，而是**「判据自己不许每版都假红」**：M1 支数是地板式（`SUITE_FLOOR = 37` + `>=`，旧 `===` 清零）/ M2 全仓 50 个脚本静态扫描没有「版本 / 支数 / 总数 / 耗时写成等值」/ M3 扫描器能红也认绿（内存样本：`steps.length === 36` 被扫出、`>= 36` 放行、`pkg.version === '0.6.7'` 被扫出）/ M4 与 M4b README 自证规模行、EVAL-CLAIMS 健康基线行都与 `baselines.counts` 合计一致 / M5 版本阶梯单调（按版本号比，不按版面顺序）/ M6 0.6.6 里程碑仍写 3,616（旧账不许被改成新账）/ M7 每支 `budgetMs >= max(30000, ms)` / M8 扫描面除扫描器自己外一个不漏。

关于「3,627」的来路：3,616 → **3,627**（+11 = `tools/probe-dirty.mjs` 9→15 的 D9–D13 六条，+ `verify.mjs` 新开的 `DT067` 一节五条；套件仍 36，这一版只扩条数不开新支）。这一组钉的不是「排序更准」，而是**「坏的是元素本身，也不许把整次检索打成异常」**：D9 混入 `[null, undefined, '滴定', 42, clean0, clean1]` 既不抛也能命中干净条目 / D9' 坏元素在位时干净问句的第一名逐条不变 / D10 `docs` 本身不是数组（`'滴定终点'` / `null` / 类数组对象 / `42`）一律回空数组 / D11 `[null, undefined, null]` 回空（全坏不回幻觉）/ D12 `keywordHitScore` 与 `searchAdaptive` 同批不抛 / D13 能红证明（子进程把 `liveDocs` 换成直通 `return docs;` → 立刻 `Cannot read properties of null (reading 'title')`）。

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

| 量尺自己也得先量（评测口径） | `gold-recall` 69 问：hit@1 0.9565 / hit@3 0.9855 / MRR 0.9686；连跑 3 次、语料倒序、三种打乱、问句倒序之后**逐位相同（std = 0）**；独立 scorer 交叉验一致；注入位置偏置即红（23→15） | `tools/probe-rigor.mjs`（R1–R6）+ `verify.mjs` RT069 | 2026-11-24 | 0.6.9 |

| 原样匹配也要记账（固定开销口径） | 660 / 2,000 / 5,000 / 10,000 条同构语料：全量检索 2.04 → **1.62** / 5.04 → **4.20** / 11.88 → **9.12** / 24.45 → **18.82 ms**，原样匹配份额 35.7%/50.6%/42.7%/42.9% → **20.7%/34.9%/22.8%/18.6%**；10,000 条时「拼 haystack」5.78 ms vs「扫标识符」0.51 ms；就地改正文·`project`·`keywords` 必变、无标识符一条不建、只按条数当缓存键的坏实现必红 | `tools/probe-verbatim.mjs`（V1–V9）+ `probe-signature.mjs` S10 + `verify.mjs` VV071 + `E:\Temp\cmp\scale011.mjs` | 2026-11-24 | 0.6.11 |

| 签名自己也要记账（固定开销口径） | 660 / 2,000 / 5,000 / 10,000 条同构语料：签名 0.96 → **0.062** / 2.84 → **0.189** / 7.04 → **0.528** / 14.16 → **1.198** ms（15×），占比 28.8%–30.6% → **2.8%–3.5%**；一次热检索 3.24 → 2.18 / 9.67 → 6.80 / 23.0 → 15.3 / 49.2 → 37.6 ms；就地改正文·`keywords`·四个字段必变、只换序必变、只按对象身份记账的坏实现必红 | `tools/probe-signature.mjs`（S1–S9）+ `verify.mjs` SG070 + `E:\Temp\cmp\scale010.mjs` | 2026-11-24 | 0.6.10 |
| 定序只排前 k（固定开销口径） | 10,000 条 / 300 问：`search` 27.377 → **19.985 ms（−27.0%）**、`searchAdaptive` 31.086 → **23.097 ms（−25.7%）**，定序份额 40.3% → **21.5%**（`bandize` 10.9% + raw 比较器 10.6%，`orderOf` 自身 0.9%）；`searchIndexOf` 0.751 ms、冷建索引 270.7 ms 未动；前 k 与「全量排完再切」逐位相同（500 组 × k∈{1,2,5,8,20,∞}）、`hitsSum` 1,500 不变、指认档恒 −1、临时字段无残留、丢档位筛选的坏实现必红 | `tools/probe-order.mjs`（O1–O8）+ `verify.mjs` OR072 + `E:\Temp\cmp\prof012b.mjs` | 2026-11-24 | 0.6.12 |
| 定档不再靠全量排序（固定开销口径） | 10,000 条 / 300 问：`search` 19.985 → **16.329 ms（−18.3%）**、`searchAdaptive` 23.097 → **18.812 ms（−18.6%）**，定档份额 21.5% → **7.8%**（`setBandsByThreshold` 7.0% + `bandize` 0.8%）；`searchIndexOf` 0.703 ms、冷建 259 ms 噪声内持平；`Float64Array` + 原生 `sort` + 阈值链 + 二分，负数 / `NaN` / `undefined` / `null` / `Infinity` 退回 `setBandsBySort` 老路且与参考逐位一致（O9 60 组、O10 40 组）；真库 52 问、LoCoMo 全项、`hitsSum` 1,500 逐位不变 | `tools/probe-order.mjs`（O1–O10）+ `verify.mjs` OR073 + `E:\Temp\cmp\prof012b.mjs` | 2026-11-24 | 0.6.13 |

关于「3,653」的来路：3,641 → 3,653（+12 = `probe-rigor` 七条 + `RT069` 五条，套件 37→38）。

关于「3,667」的来路：3,653 → 3,667（+14 = `tools/probe-signature.mjs` 的 S1–S9 九条 + `verify.mjs` 新开的 `SG070` 五条，套件 38→39）。

关于「3,683」的来路：3,667 → 3,683（+16 = `tools/probe-verbatim.mjs` 的 V1–V9 九条 + `verify.mjs` 新开的 `VV071` 五条 + `tools/probe-signature.mjs` 新加的 S10 一条，另有 1 条是本支实测对齐补回的：0.6.10 记的 3,667 比实测少一条；套件 39→40）。

关于「3,697」的来路：3,683 → 3,697（+14 = `tools/probe-order.mjs` 的 O1–O8 八条 + `verify.mjs` 新开的 `OR072` 六条，套件 40→41）。这一组钉的不是「排序更准」，而是**「排前 k 不算全量的钱，也不许改任何一名的顺序」**：O1 用 500 组随机语料 × 六种 k 与「全量排序再取前 k」逐位对拍，O4 钉住 `k<=0` / `undefined` / 超过总数一律退回全序，O8 是「丢掉档位筛选」的坏实现能红证明；`OR072` 把探针标签、引擎三件（签名收 `limit` / 撤 `Map` / 有界堆）、三个调用点都传 k、进程内截断逐位相同与文档四处钉在一起。同一版按「改建不删」更新了跟着改写的旧钉子（`HY 档位留痕`、`HZ8`/`HZ9`/`HZ11` 的定位串、`HZ15` 折价落点、`VW2`、`VY3`/`VY7`/`VY8`/`VY9`、`DT063` 梯子、`probe-gold` G23、`probe-determinism` D8）。

关于「3,704」的来路：3,697 → 3,704（+7 = `tools/probe-order.mjs` 新加的 O9–O10 两条 + `verify.mjs` 新开的 `OR073` 五条，套件仍 41；`OR073` 另把 `HZ7` 从「钉 1 处」改成「钉两路」，只改钉法与文案、条数不变）。这一组钉的不是「更快」，而是**「快得没有改口径」**：O9 用负数 raw（60 组，−6..6，含 0 与重复）逼出退回路——阈值链在负数上「锚点严格下降」不成立，引擎必须自动换到老全量排序并与参考实现逐位一致；O10 用 `NaN`/`undefined`/`null`/`Infinity` 混进 raw（40 组，每 5 条插一个脏值）钉同一件事且不抛错。`OR073` 把 O9–O10 标签、阈值链三件（`setBandsByThreshold` / `new Float64Array(plain)` / `vals.sort()` / `h._bandTmp = m - 1 - lo;`）、退回路调用、进程内负数与 NaN 对拍、文档四处与版本地板钉在一起。O1–O8 与 OR072 一字未改——它们描述的行为（前 k 逐位相同、截断、无残留、指认档、换序稳定）在本版仍然成立。

关于「3,715」的来路：3,704 → 3,715（+11 = `tools/probe-hotpath.mjs` 的 H1–H6 六条 + `verify.mjs` 新开的 `OR074` 五条；套件 41→42）。这一组钉的不是「更快」，而是**「热路上不许先挂后摘」**：H1 直接切主路源码，确认四个临时值不再靠 `delete` 收场、回执对象也没有 `_vb`/`_sr`/`_lv`/`_tr`/`_bandTmp`；H3/H4/H5 是这一版最容易犯的错的三面镜子——临时值一旦与 hits 下标错位，原样补分就会落到别人头上（`explain.identBonus`）、层级意图乘子会落到非 `rules` 的条目（`explain.levelIntent`）、断言密度乘子会落到没在开头下断言的条目（`explain.tipAssert`），三条都是进程内可判、能红；H2 钉平行数组不跨查询残留（同语料两遍 `JSON.stringify` 逐位相同），H6 钉自适应 idf 换尺子时必须清账（直接开 / 先关后开 / 连开两次三份相同）。`OR074` 把 H1–H6 标签、`check-all` 挂线、取根例外表第四条、引擎四个平行数组与「零 `delete h._*`」、`idfAt` 与清账、进程内回执干净、文档四处与版本地板钉在一起。同一版按「改建不删」跟改的老钉子：`verify.mjs` 的 `HZ8`/`HZ9`/`HZ14`/`HZ15`/`VW1`/`VW4`、`probe-recall` 的 R12（`assertRatioOf(` 从 3 处降成 2 处：定义 1 + 每条算一次，分档与打分共用同一笔）、`probe-gold` 的 G28（`ruleFoldOf(di)` 从「三处引用」改成「算一次、乘两处」）。

关于「3,727」的来路：3,715 → 3,727（+12 = `tools/probe-cover.mjs` 的 C0–C5 六条 + `verify.mjs` 新开的 `OR075` 六条；套件 42→43）。这一组钉的不是「更快」，而是**「同一笔账换个方向记，得出的数必须一位不差」**：C1 把倒排关掉（`inverted: false`）与默认两条路**对拍逐位相同**——两条独立实现互相验，倒排记账写错了这里立刻红；C2 钉覆盖度语义没变（全命中 = 1、命中多的严格大于命中少的、都落在 [0,1]、无关条不进回执）；C3 钉换尺子那趟的顺序（`idfCache = new Map();` → `refreshQidf();` → `buildCoverAcc();` → `raw.fill(0);`），这一支在小夹具上物理触发不了（`idfScaleGate` 300、top-8 要有区分词、`adaptiveLamOf` 要榜首分差 0.05–0.15，同分小语料恒 `lam = 0`），所以改成直接对源码顺序断言，另加「开两次逐位相同」「两路一致」作旁证；C4 钉空手问句两条路都是 0 条且不含 `NaN`（0/0 漏出来就是 `NaN`）；C5 用 300 条 × 30 问的脏语料（LCG `seed = 20261124`，二成条插库外词）钉两路仍逐位相同。`OR075` 把 C0–C5 标签、`check-all` 挂线、取根例外表第五条、引擎里倒排账三件与退回路、`const idf = qLoopIdf[qi]`、换尺子顺序递增、进程内两路对拍与全命中 `explain.cover === 1`、文档四处与版本地板钉在一起。同一版按「改建不删」跟改的老钉子共 9 处：`impOf(dOf)`、四个 `...dOf.X === void 0`、GZ 的 recency 共有前缀（`w = Math.max(RECENCY_FLOOR, recencyWeight(now - (` 出现 2 次）、`HZ6`/`HZ7`/`HZ13` 的 `subjRatio[di]`→`srOf` 与 `rawVerbatim[di].ratio`→`vbOf.ratio`、`HZ14` 的 `dOf.importance`、`VV` 的 `verbatim: vbOf.matched.slice()`、`VY6`；而 `ruleFoldOf` 定义、`lead`、`keywordHitScore` 三处**刻意没动**（不在这一版切面上）。

关于「3,739」的来路：3,727 → 3,739（+12 = `tools/probe-score.mjs` 的 S0–S5 六条 + `verify.mjs` 新开的 `OR076` 六条；老判据按「改建不删」跟改 5 处后条数不变，套件 43→44、verify 1888→1894，两本账合起来 +12，与 MT068 那条的对账公式一致）。这一组钉的不是「更快」，而是**「换个方向扫，打出来的分必须一位不差」**：S1 把倒排关掉（`inverted: false`，退回逐条 `tfi.get`）与默认两条路**对拍逐位相同**（实测 `score 4.3915 / 1.8914 / 2.2584 / 1.0941 / 0.3209`）——两条独立实现互相验，扫倒排写错了这里立刻红；S2 钉字段命中位等价于 `titleSets` / `kwSets`，四档（默认 / `fieldKwW: 0` / `fieldKwW: 3` / `fieldBoost: false`）各档两路都对得上，且档间确有差异（否则这条是白测）；S3 钉换尺子那趟的顺序（`idfCache = new Map();` → `refreshQidf();` → `buildCoverAcc();` → `raw.fill(0);` → `scoreCandSet();`），并旁证开两次逐位相同、两路一致；S4 钉空手问句两条路都是 0 条且不含 `NaN`；S5 用 300 条 × 30 问的语料（LCG `seed = 20261125`，每 3 条带标题、每 5 条带关键词）钉两路仍逐位相同。`OR076` 把 S0–S5 标签、`check-all` 挂线、取根例外表第六条、引擎里扫倒排四件、倒排记 `p.f` / `p.t` 且**不许** `p.w`（字段权重不预乘）、退路两处、换尺子顺序递增（含 `scoreCandSet();`）、进程内两路对拍与 `fieldKwW: 0` 仍一致、文档四处与版本地板钉在一起。这一版按「改建不删」跟改的 5 处：`GZ`（协调因子 1→2 处）、`HC`（同上）、`HZ14` 长度惩罚（`bEff` 3 处、长度归一化 4 处）与覆盖度三步（归一 1 处、取幂与协调各 2 处）、`probe-gold` 的 `G22`（同上三步计数 + 扫倒排路的 `coverAcc` 归一 2 处）、`OR075` 与 `probe-cover` 的 `C0`（倒排条目换成 `{d,f,t}` 后改钉 `const pd = p.d;` + `coverAcc[pd[pi]] += w;`）；`scanDoc` 本体、`ruleFoldOf`、`lead`、`keywordHitScore` 三处**刻意没动**（不在这一版切面上）。

关于「3,750」的来路：3,739 → 3,750（+6 = `tools/probe-hydrate.mjs` 的 H0–H5 六条 + `verify.mjs` 新开的 `OR077` 六条，减去老判据里三条被改成计数的口径——条数不变；套件 44→45）。这一组钉的不是「更快」，而是**「少建的对象不许把回执变样」**：H1 把瘦路回执与 `{ explain: true }` 完整路逐条比 `JSON.stringify`（先剥掉 `explain`），**键序也要一致**——水化最容易犯的错不是丢字段，而是把字段换个位置，那样下游按 `Object.keys` 遍历的地方就会静默变序；H2 对 `{ keepBand: true }` 路做同样的事（剥掉 `_raw` / `_bandTmp` / `_band` / `_ident` / `_dense`），因为那条路是 searchHybrid 融合的输入，`_band` 必须还在；H3 钉两件事：回执里不许漏出 `_di` / `_raw`（`_di` 是纯内部下标，漏出去调用方会当成字段），以及 `trimmed` / `rescueAdded` 这两个挂在数组上的非枚举属性必须还在（水化如果用 `map` 造新数组，这两个属性会静默消失，`searchHybrid` 的救回计数就永远读不到）；H4 钉可选五字段（`keywords` / `project` / `created_at` / `status` / `source_session`）照旧「无则不写、有则透传」——0.2.120 与 0.6.0 两版特意补上的透传，不许在这一版被水化顺手抹掉；H5 用 300 条 × 30 问（LCG `seed = 20261124`）钉两路逐位相同。`OR077` 把 H0–H5 标签、`check-all` 挂线、取根例外表第八条、引擎里瘦路条件与**瘦字段恰好七项**（`_subj` / `_raw` / `cover` / `id` / `updated_at` / `score` / `_di`，多一项就说明整条字面量被搬回了热路）、`matHitOf` 与截断后水化、`keepBand` 提前返回、进程内瘦路与 explain 路逐字节相同且 keepBand 路剥内部字段后相同、文档四处与版本地板钉在一起。这一版按「改建不删」跟改的 3 处：`GZ` 的 `const anchored = anchorSel === null ? false : anchorSel(di);` 2→3 处（第三处是水化）、`HA` 的 `...(anchored ? { anchored: true } : {}),` 1→2 处、`VY6` 的 `_raw: raw[di]` 2→3 处（瘦对象也要写一份 `_raw` 给定档）；`scanDoc`、`scoreCandSet`、`bandize` / `trimByBand`、`lead`、`keywordHitScore` 各处**刻意没动**（不在这一版切面上）。读数口径也不变：`search` 8.35 → 3.5ms、`searchAdaptive` 10.16 → 4.5ms、总采样 3,295.9 → 1,808.2ms，LoCoMo 与真库 52 问**逐位不变**——这一版优化的是「建对象的时机」，不是排序与打分。

关于「3,761」的来路：3,750 → 3,761（+11 = `tools/probe-cand.mjs` 的 C0–C5 六条 + `verify.mjs` 新开的 `OR078` 五条；套件 45→46、verify 1898→1903）。这一组钉的不是「更快」，而是**「换成位图去重，候选的顺序与回执必须一位不差」**：C0 先把源码七件钉住（位图 `new Uint8Array(docs.length)`、候选表、两处去重逐字 `if (candAt[di] === 0) { candAt[di] = 1; candList.push(di); }`、`for (let ci = 0; ci < candList.length; ci++) {`、`if (candList === null) {` 恰好两处、**候选集那一段里**没有 `new Set()` 与 `set.add(`、没有 `for (const di of candList)`）——注意查找范围必须用 `ENGINE.slice(candStart, candEnd)` 切到候选集那一段，引擎别处（星图、台账）仍在使用 `Set`，整文件查必假红；C1 拿位图并集与 Set 并集在 200 组随机倒排上逐位对拍（含重复、乱序、空手）；C2 把倒排关掉（`inverted: false`，退回全库扫描）与默认两条路 6 问逐位相同——两条独立实现互相验；C3 钉「同义扩词那条路真的被走到」：这条**两次假红**才做对，机制留档——①小库（n=7）里 `df(beta)=3 > cap = Math.max(1, Math.floor(3 × 0.35)) = 1`，`synExpandOf` 的 `usable` 直接把 beta 挡掉，扩词整条不生效；②垫到 39 条 filler（cap=13、`df(beta)=7`）后扩词生效（临时调试引擎打印出 `SYN [ 'alpha=>beta' ]`），但桥接回来的那条分低、**被 `trimByBand` 剪掉**，「回执里多一条」永远看不到，能看到的只有 `trimmed` 从 `undefined` 变成 1；而且桥会给「`keywords` 里有该词」的条目加 `synW × sat(f)` 的分，分数本来就该不同（实测 4.8974 vs 4.3036）。所以断言写成 `on.trimmed === 1 && off.trimmed === void 0` 加两路**条与序**相同（只比 `h.id` 数组，不比分数）；C4 钉空手问句两条路都是 0 条且不含 `NaN`；C5 用 300 条 × 30 问（LCG `seed = 20261127`）把首趟与 `adaptiveIdf: true, idfScaleGate: 10` 换尺子那趟各跑开/关两路，不一致 0/0。`OR078` 把 C0–C5 标签、`check-all` 挂线、取根例外表第九条、引擎七件（含候选集段切片、去重与判空各 2 处）、进程内倒排开/关逐字节相同与扩词桥 `trimmed` 0→1 且条序不变、文档四处与版本地板钉在一起。这一版按「改建不删」**没有**跟改任何老判据——`candSet` 这个名字只出现在候选集那一段，`scanDoc`、`scoreCandSet` 的打分算式、`bandize` / `trimByBand`、`lead`、`keywordHitScore` 各处一个字没动。读数口径也不变：`search` 3.49 → 3.01ms、`searchAdaptive` 4.568 → 4.54ms、总采样 1,808.2 → 1,678.4ms，LoCoMo 与真库 52 问**逐位不变**——这一版优化的是「候选集合怎么建」，不是排序与打分。

关于「3,773」的来路：3,761 → 3,773（+12 = `tools/probe-band.mjs` 的 B0–B6 七条 + `verify.mjs` 新开的 `OR079` 五条；套件 46→47、verify 1903→1908）。这一组钉的不是「更快」，而是**「不排序也得把档位算得一位不差」**：B0 先把源码形状钉住（桶常量 `RAWK_SHIFT = 16` / `RAWK_NB`、`rawkHist.fill(0);` 与计数、`out[rawkHist[rawkBucketOf(v)]++] = v;` 攒段、阈值 `anchor < 0 ? Infinity : IMP_BAND * anchor`、桶 0 分支里 `seg.sort();`、小端退路 `vals.subarray(0, n).sort();`、阈值路径里已无 `vals.sort();`——**只认带分号的真实调用**，否则会被自己注释里的 `vals.sort()` 判红）；B1 拿桶链与「全量排序 + 阈值链」在 500 组随机语料（含 0、重复、次正规数 5e-324、跨 1e±300）上逐位对拍；B2 钉「同桶最多一个锚点」的地基：4,000 样本 870 个桶，同桶任意两值比值最坏 **0.943627** ≥ `IMP_BAND = 0.85`；B3 退化语料（全 0 / 全相同 / 单值 / 0 与次正规数 / 空手）；B4 定档逐条对拍 200 组 + 指认条目（`_ident` / `_subj === 1`）不进阈值链——这条**假红过一次**，参考实现不能写成「数一遍锚点 > v」，引擎是 `m - 1 - lo`，两者在「落进 0.85 阈值缝里」的值上差一档，参考必须照 `setBandsBySort` 的字面语义写；B5 钉复用缓冲：先跑 300 条再跑 3 条，锚点与单跑逐位相同（退路漏 `subarray(0, n)` 时这条与 `probe-order` 六条一起红）；B6 钉桶号事实（0 与 5e-324 → 桶 0、1.0 → 16368、桶号随值单调不减、`RAWK_LE === true`）。`OR079` 把 B0–B6 标签、`check-all` 挂线、取根例外表第十条、引擎桶链七件与「阈值路径无全量排序」、进程内三组固定语料对拍、文档四处与版本地板钉在一起。这一版按「改建不删」**只跟改了一条老判据**：`OR073`（它钉的正是 0.6.13 那个形状「`new Float64Array(plain)` + `vals.sort()`」，而这一版把全量排序换掉了）——新形状改判「`setBandsByThreshold` 调 `anchorChainOf`、`anchorChainSorted` 仍在、`h._bandTmp = m - 1 - lo;` 不动」，退回路那条判据一个字没改；其余老判据全部原样。——`setBandsBySort` 与 `anchorChainSorted` 整段留在文件里当退路与阴性对照，`bandize` / `trimByBand` / `scoreCandSet` / `scanDoc` 的打分算式一个字没动。读数口径也不变：`search` 2.982 → 2.52ms、`searchAdaptive` 4.105 → 3.51ms、总采样 1,678.4 → 1,520.9ms，LoCoMo 与真库 52 问**逐位不变**——这一版优化的是「怎么从大到小扫」，不是打分与截断。

关于「3,785」的来路：3,773 → 3,785（+12 = `tools/probe-sigrow.mjs` 的 R0–R5 六条 + `verify.mjs` 新开的 `OR080` 六条；套件 47→48、verify 1908→1914）。这一组钉的不是「冷建更快」，而是**「少查一次表，签名的结论一位不差」**：R0 先把源码形状钉住（`const SIG_ROW_CACHE = new WeakMap();`、`function sigRowFor(`、首访不铺行 `if (slot.row === null && slot.visits >= 2) slot.row = new Array(n);`、行内校验 `function sigDocOfRow(` 里的 `e !== void 0 && d !== null && typeof d === 'object' &&`、行命中照旧 `sigStats.hashed++;` 与 `sigStats.reused++;`、两路合并 `h ^= row === null ? sigDocOf(docs[i]) : sigDocOfRow(row, i, docs[i]);`、非数组旧路 `for (const d of docs)`）；R1 拿「同一个数组连算两趟」与「每趟都 `docs.slice()`」两路在 40 张库上快照对拍，**4,018 次逐位相同**；R2 钉计数口径（两路都是 `calls=2 hashed=400 reused=200 rebuilt=200`——这条**假红过一次**：两条路共用一批文档对象时，先跑的会把条级缓存填满，后跑的自然全 `reused`，两路必须各用一份互不相干的同形库）；R3 钉「改一处必被看见」的八种改法（改正文 / 标题 / 项目 / 关键词 / 时间、换顺序、删一条、加一条），每一种新旧两路都换签名；R4 三次连算一致且副本同签名；R5 脏值（`null` / `undefined` / 字符串 / 数字 / 关键词塞对象）两路同签名、绝不把两条不同脏值认成一条。`OR080` 把 R0–R5 标签、`check-all` 挂线、取根例外表第十一条、引擎八件（含「一问只算一次签名」三处：`const sig = indexSignature(docs);` / `const key = indexPathKey(docs, opts, sig);` / `given.__sig === sig &&`）、进程内 40 库两路对拍 + 改一处两路一起变、计数口径、文档四处与版本地板 `vNumS11 >= 620` 钉在一起。这一版**没有跟改任何老判据**：`indexSignature` 的总签名与行缓存那趟逐位相同（R1 / R4 就是这条），`searchIndexCache` 的键照旧，`probe-signature` 的 S1–S10 原样全绿，`probe-verbatim` 的 V7 与 `st.built === 660 && st.reused >= 660 * 4` 也原样满足——行命中仍走 `sigDocOf` 的同一套计数。——质量口径同样没动：`search` 2.52 → 2.042ms、`searchAdaptive` 3.51 → 2.59ms、总采样 1,624.0 → 1,433.5ms；LoCoMo locomo10 十个样本 / 5,882 条轮次 / **1,986 问**的新旧引擎 top-20 逐问对拍 **0 处不同**（`E:\Temp\cmp\ab20.mjs`），真库 52 问三档 0.921 / 0.417 / 0.500 与两条 `#2→#1` 位移照旧。这一版优化的是「这张库还是不是刚才那张库」怎么问，不是打分、定档与截断。

关于「3,797」的来路：3,785 → 3,797（+12 = `tools/probe-lex.mjs` 的 L0–L5 六条 + `verify.mjs` 新开的 `OR081` 六条，减去本支重排后的净差 −7；套件 48→49）。这一组钉的不是「更快」，而是**「换一张表，切出来的词一个都不许变」**：

- **L1 是这次最硬的判据**：0x0000–0x10FFFF 跳过代理区共 **1,112,064** 个码点，逐点把新分类与旧那两条 Unicode 正则对拍，是一次跑完全量的穷举，不是抽样。分类错一个码点不会报错，只会悄悄改变切段 → 二元组 → 召回，抽样抓不到。
- **L2 钉的是表本身**：65,536 格逐格与正则对拍（skip 15,356 / cjk 28,789 / word 21,391），并验「建两次逐格相同」——表是纯函数，不许带状态。
- **L3/L5 钉的是切段语义**：14 串混排语料（全角 ＡＢＣ、半角片假名 ﾊﾝｶｸ、々/ー、emoji、星外字 𠀋𠮷、孤立代理项、空串、单字）逐串相同；标点串 0 token、单汉字 0 token、两汉字 1 个二元组——这三条是老实现的行为，一个字没改。
- **L4 钉的是惰性**：模块起来时 `clsBmp === null`、第一次分类才建（一次 64KB）、此后 identity 不变（不重建）。
- **OR081 除标签/挂线/文档/版本地板外，把 L1 与 L3 在 `verify.mjs` 里再跑一遍**（用 `new Function` 把引擎那一段切出来当纯函数），并把引擎形状九件（三档常量 / 惰性槽 / 表由 `CJK.source` 与 `WORD.source` 扫出 / 只补空格 / 单码点快路 / 星外退路 / `classify` 包装 / `tokenize` 数值比较 / `tokenize` 不再出现 `classify(`）钉住。

读数口径：本版**没有跟改任何老判据**——`OR073`–`OR080`、`probe-*` 全部原样通过；`SUITE_FLOOR` 48 → 49，`NO_ROOT` 增 `tools/probe-lex.mjs` 一条（只经相对 import 与 `import.meta.url` 取引擎）。

### 关于「3,809」的来路

- 相对 0.6.21 的 3,797：**净 +12**，逐笔对得上，没有别的来路。
  - `tools/probe-cold.mjs` **+6**（C0 形状十一件 / C1 分段可交换 14 对 / C2 成词可交换 14 对含混排反例 / C3 五张表 12 条 × 4 支路 / C4 确定性 / C5 退化 11 例）。
  - `verify.mjs` 的 `OR082` **+6**（C0–C5 标签 + 挂线 + 取根例外 / 引擎十一件 / 进程内分段对拍 / 进程内成词对拍 + 混排反例 / 文档四处 / 版本 ≥ 0.6.22）。
  - 其它支**一条未动**：`OR081` 与 `probe-lex` 的 L0 只是把「切段循环」的取址从 `tokenize` 改到 `tokenizeSegs`（条数不变），`WZ2` / `DT066` 两条源码形状断言改成读新的派生链（条数不变），`WZ3` 保留原字面量、连源码都照老写法写回去了。
- 套件 49 → **50**（`SUITE_FLOOR` 50，`NO_ROOT` 增 `tools/probe-cold.mjs`）。
- 语义兜底：三条被改写的形状断言（`WZ2` / `DT066`）由 `probe-cold` C3（五张表与老表达式 12 条 × 4 支路逐条相同）与 `colddiff22.mjs`（11 轮 277 项对拍）兜住——**形状跟着源码走，语义一字不动**。

### 关于「3,819」的来路

- 相对 0.6.22 的 3,809：**净 +10**，逐笔对得上，没有别的来路。
  - `tools/probe-cooc.mjs` **+4**（`K7a` 每条词表只解一遍——`keywords` 写成 getter 数读次数，实测两条记忆读 2 次而老引擎读 4 次 / `K7b` 共现表与「朴素尺子」`naiveCooc()` 逐键逐值逐序相同，四组夹具含共享汉字簇、多项目 + 单条项目、重复关键词、空 keywords 混排 / `K7c` 够 3 条的会话每条追加同一串主题词 / `K7c` 不足 3 条的会话一条都不追加）。
  - `verify.mjs` 的 `OR083` **+6**（K7 探针在位 + 挂线 + 取根例外 / 引擎七件形状 / 进程内 getter 计次 / 进程内会话主题差分 / 文档四处 / 版本 ≥ 0.6.23）。
  - 其它支**一条未动**：`WZ2` / `DT066` / `OR081` 这些读源码形状的地方这一版根本没碰；`probe-cold` / `probe-lex` / `probe-sigrow` 全数原条通过。
- 套件 **50 支不变**（`SUITE_FLOOR` 50，`NO_ROOT` 不加新文件——`tools/probe-cooc.mjs` 早在 0.6.21 就进了线）。
- 语义兜底：这一版**没有改任何判据的语义**——四条引擎改动（词对记忆 / 词表只解一遍 / 项目层提行 / 会话主题一趟算完）由 `probe-cooc` K7b（共现表与朴素尺子逐键逐值逐序相同）与 `colddiff23.mjs`（20 条合成 doc × 11 组开关 + 1,451 条 LoCoMo 真实 doc × 3 组开关 + `buildCoocSyn` learn 开/关直对拍，共 **462 项 0 mismatch**，`coocSyn` 键序 / `docToks` / `postings` / `tf` / `df` / `titleSets` / `kwSets` / `hayAt` 全等）兜住——**形状跟着源码走，语义一字不动**。

### 关于「3,827」的来路

- 相对 0.6.23 的 3,819：**净 +8**，逐笔对得上，没有别的来路。
  - `tools/probe-cold.mjs` **+2**（`C6` 切词逐位——探针内内联 0.6.23 的 `Array.from` 老实现当尺子，27 条刁钻串 × 夹具 → 52 例 · 440 token · 0 不一致，外加「不再造字符数组」的形状四条 / `C7` df 摊出来——df 恒等于倒排长度、无缺键、`inverted:false` 支路 df 同序同值、`f`/`t` 与 `d` 同长，形状六条（`postings.get(t)` 全文只 2 次））。
  - `verify.mjs` 的 `OR084` **+6**（C6/C7 探针在位 + `check-all` 挂线 / 引擎五件形状：倒排条目只查一次、收尾按下标回填、df 由倒排长度摊出来、切词不再造字符数组、会话主题借 tf 判重 / 进程内切词逐位（引擎自己的 `classify` 配 `Array.from` 老实现当尺子，另单钉 `['中文','文𠀀','𠀀𪚥']`）/ 进程内 df 恒等 + 开合支路逐位相同 / 文档四处 / 版本 ≥ 0.6.24）。
  - 其它支**一条未动**：`OR083` 里只有一处「会话主题一趟算完」跟着源码换了形状（`stamp.get(t) !== ord` → `const c = tf.get(t);` + `} else tf.set(t, c + 1);`，断言条数不变、仍是同一条），`WZ2` / `DT066` / `OR081` / `OR082` 与 `probe-cooc` / `probe-lex` / `probe-sigrow` 全数原条通过。
- 套件 **50 支不变**（`SUITE_FLOOR` 50，`NO_ROOT` 不加新文件——C6/C7 加在已有的 `tools/probe-cold.mjs` 里）。
- 语义兜底：这一版**没有改任何判据的语义**——四条引擎改动（倒排条目当场记住 / df 由倒排长度摊出来 / 切词改下标走 / 会话主题借 tf 判重）由三把尺子同时兜住：`probe-cold` C6（切词逐位：`Array.from` 版当尺子）、C7（df 恒等于 `p.d.length`，且与 `inverted:false` 支路同序同值）、`colddiff24.mjs`（0.6.23 引擎 vs 0.6.24 引擎：20 条合成 doc × 11 组开关 + 1,451 条 LoCoMo 真实 doc × 3 组开关，**462 项 0 mismatch**，`postings` / `tf` / `df` / `titleSets` / `kwSets` / `hayAt` / `docToks` 全等）、`tokdiff24.mjs`（37 条刁钻串 + 7,868 条 LoCoMo turn，`tokenizeSegs` 与 `tokenize` 两条路 **15,810 项 0 mismatch**）。

### 关于「3,837」的来路

- 相对 0.6.24 的 3,827：**净 +10**，逐笔对得上，没有别的来路。
  - `tools/probe-cold.mjs` **+1**（新增 `C8` 成词那一趟——形状四件（按码点判 / 不再出现拉丁正则 / 严格串尾 / 过半即早退），行为拿正则版参考实现跑 **261 例 0 不一致**）。`C0` 与 `C6` 只是跟着新源码换了断言的**字面量**（`plainToks[i] = finishToks(ts);` + 就地 `ts.push(cs[k])` / `out.push(s.slice(ps, k + w));`），条数不变。
  - `tools/probe-cooc.mjs` **+2**（`K8a` 共现内层提行六件形状 / `K8b` 40 组 seeded 随机夹具与朴素尺子逐键逐值逐序相同）。
  - `verify.mjs` 的 `OR085` **+7**（K8 / C8 探针在位 + 挂线 / 引擎六件形状 / 进程内 16 例拉丁判据 / 10 组早退对拍 / 标题集与关键词两路口径 / 文档四处 / 版本 ≥ 0.6.25）。
  - 老判据跟着源码换字面量、**条数不变**的三处：`OR082` 的 `plainToks就地`（`finishToks(ts.concat(cs))` → `finishToks(ts);` + 就地 push）、`OR084` 的 `切词不再造字符数组`（`out.push(prev + cur);` → `out.push(s.slice(ps, k + w));`）、`WZ2`（`plainToks[i] = kwSep ? … : finishToks(ts.concat(cs, …));` → `if (kwSep) {` + `plainToks[i] = finishToks(ts);`）；`检索自答` 那条同样只换字面量（`latin * 2 >= tokens.length` → `if (latin * 2 >= ln) return true;`、`/^[a-z]+$/.test(t)` → `if (c < 97 || c > 122) return false;`）。
- 套件 **50 支不变**（`SUITE_FLOOR` 50，`NO_ROOT` 不加新文件——K8 加在已有的 `tools/probe-cooc.mjs`、C8 加在已有的 `tools/probe-cold.mjs` 里）。
- 语义兜底：这一版**没有改任何判据的语义**——四条引擎改动（共现内层提行 / 二元组连续切片 / 拉丁判据按码点判 + 过半早退 / 标题集先取 + 词表就地接正文）由三把尺子同时兜住：`probe-cold` C8（正则版 `refMostly` 当尺子，261 例）、`probe-cooc` K8b（40 组 seeded 随机夹具与 `naiveCooc` 逐键逐值逐序相同）、`colddiff25.mjs` + `tokdiff25.mjs`（0.6.24 引擎 vs 0.6.25 引擎：全字段 **462 项 0 mismatch**、切词链 **15,810 项 0 mismatch**）。**K8b 首红不是引擎变慢**：`E:\Temp\cmp\k8dbg.mjs` 三方对拍给出 `{"fixtures":40,"oldNewDiff":0}` / `{"naiveDiffOld":39,"naiveDiffNew":39}`——新旧引擎 40/40 逐位相同，而朴素尺子对**两个**引擎各差 39/40，差异只表现为同分并列的先后，根因是尺子没过引擎那层 keyword 去重；夹具每条 keywords 先去重之后 40/40 全同。**尺子的口径缺口要修在尺子上，不许拿它当引擎的红**。

### 关于「3,845」的来路

从 0.6.25 的 3,837 到 3,845，净 +8，全部是可执行断言，没有一条是「文档里写了个数」：

- `tools/probe-cooc.mjs` **+2**：K9a（共现层只认词号的六处形状）、K9b（出门换回原词：表的键与值的每个元素都还是词本身，键集合与朴素尺子相同）。
- `verify.mjs` **+6**：`OR086` 六条——探针在位 / 引擎四处形状 / 进程内键值里没有词号漏出来 / 同一批文档建两次逐键逐值逐序相同 / 文档在位（INTERNAL 9.225、DESIGN 221、README、PLAN）/ 版本号 ≥ 0.6.26。

跟着源码换字面量、条数不变的老判据（换的是形状，不是口径）：

- `verify.mjs` 的「as: 三道门各在位」与 `OR084` 附近的 `汉字判据按词对记忆` / `两层走同一闭包`：`const hanMemo = new Map();` → `const hanMemo = [];`、`coocShareHan(a, b)` → `coocShareHan(wById[a], wById[b])`、`shareHan(a, b)` → `hanHas(rowH, a, b)`，条数不变。
- `词表只解一遍`：`docs.map((d) => coocWordsOf(d))` → `docs.map((d) => coocWordsOf(d).map(idOf))`，`coocWordsOf(` 仍只出现一次。

本版没有新增探针文件，也没有删探针；支数仍是 **50**。质量口径与上一版逐位相同：`colddiff26` 462 项 0 不一致、`tokdiff26` 15,810 项 0 不一致。

### 关于「3,857」的来路

从 0.6.26 的 3,845 到 3,857，净 +12，全部是可执行断言，没有一条是「文档里写了个数」：

- `tools/probe-cold.mjs` **+1**：C9（`clsAt` 按下标分类——与「按码点跑 Unicode 正则」的尺子逐下标同值，15 串 · 245 下标 · 13 码点对拍；另钉切词里 `s[i]` 与内层 `clsCode(` 都不再出现）。
- `tools/probe-cooc.mjs` **+2**：K10a（项目层五处形状：无 `self` Set、无 `unionArr.filter`、先判 `onlySelf`、按并集序 `indexOf` 跳过、并集构造照旧）、K10b（五组夹具与朴素尺子逐键逐值逐序相同）。
- `verify.mjs` **+9**：`OR087` 九条——探针在位 / 引擎里按下标分类 / 签名混算三件模块级 / 会话主题词号两轮 / 项目层 onlySelf / 进程内签名口径（头尾改字换签名、正中等长改写同签名）/ 进程内会话主题与朴素两趟尺子逐会话逐词逐序相同 / 文档在位（INTERNAL 9.226、DESIGN 222、README、PLAN）/ 版本号 ≥ 0.6.27。

跟着源码换字面量、条数不变的老判据（换的是形状，不是口径）：

- `XA2 指纹取「长度 + 头 40 + 尾 40 + 标题 + 关键词 + 会话」`：`put(content.slice(0, 40))` / `put(content.slice(-40))` → `sigMixRange(h, content, 0, …)` / `sigMixRange(h, content, … - 40, content.length)`；`put(String(...))` → `h = sigMixStr(h, String(...))`。
- `DT066 索引签名也走 kwList` 与 `VV071 project 进签名`：同上，两处都改成「老写法或新写法任一在位」。
- `as: 同 project 那层只认跨文档`：`const others = unionArr.filter((w) => !self.has(w))` → 老写法或 `let onlySelf = true;` + `if (ws.indexOf(b) >= 0) continue;` 任一在位（0.6.27 把「造一份别人」换成「按并集序跳过自己」）。
- `OR081 切段数值比较` 与 `tools/probe-lex.mjs` 的 `tokNumeric`：`const cls = clsCode(...)` → 老写法或 `const cls = clsAt(s, i);` 任一在位。
- `OR083 会话主题一趟算完 / 排名口径字面不变` 与 `OR084 会话主题借词号判重`：`tf.get` / `tfBySess` 的形状 → `let id = tid.get(t);` / `if (cnt[id] === 0) {` / `cs[k] * Math.log(1 + total / sdf[ids[k]])`。

本版没有新增探针文件，也没有删探针；支数仍是 **50**。质量口径与上一版逐位相同：`colddiff27` 462 项 0 不一致、`tokdiff27` 15,810 项 0 不一致。
