/**
 * 手动脚本账本（0.2.83）。
 *
 * tools/ 下的脚本分三类，缺一类就没人管：
 *   1. 进了 check-all 的 STEPS —— 每次自检都跑；
 *   2. 被别的脚本 import —— 借调用方的运行被覆盖；
 *   3. **手动脚本** —— 靠人想起来才跑。这一类从定义上就没人在看，`tools/cost-baseline.mjs`
 *      和 `tools/probe-toolsize.mjs` 就是这样烂掉的（用了没导入的 `root`，两个月没跑过）。
 *
 * 这份账本就是第三类的登记处：登记了才算「有意的手动」，没登记又不在前两类里 →
 * `tools/probe-tools.mjs` 直接判红。`smoke: true` 表示「只读、可随时跑」，
 * 探针会真跑一遍（带 `args`），跑不起来就是红；`smoke: false` 必须写清为什么不能自动跑。
 *
 * 增删脚本时改这里，不要改 probe-tools 里的白名单——账本是数据，判据是代码。
 *
 * [macro-fusion 0.2.83] 新增：手动脚本账本（每条带 smoke 与 why），由 tools/probe-tools.mjs 校验。
 */

export const MANUAL_TOOLS = [
  {
    file: 'tools/cost-baseline.mjs',
    smoke: true,
    why: '0.1.x 的一次性成本基线：只读两套引擎源码数静态开销，输出是人读报表，没有可断言的判决',
  },
  {
    file: 'tools/wire-profile.mjs',
    smoke: true,
    args: ['--status'],
    why: '把插件接进 profile 的手动工具；--status 只打印不改盘，--apply 才会写',
  },
  {
    file: 'tools/patch-meow-settings-ns.mjs',
    smoke: true,
    why: '给 meow 客户端补「按 entry id 找配置命名空间」的补丁；默认只检锚点不写盘，已打过则跳过（幂等）',
  },
  {
    file: 'tools/patch-nebula-noinject.mjs',
    smoke: false,
    why: '按行号切片的一次性补丁，落盘后锚点行就不存在了，再跑必然报错；保留仅供追溯那次改动',
  },
  {
    file: 'tools/accept-live.mjs',
    smoke: false,
    why: '对着正在运行的 DSH 读运行态（进程、日志、前端产物）；环境依赖，verify 另有判据禁止它进 check-all',
  },
  {
    file: 'tools/make-vendor-manifest.mjs',
    smoke: false,
    why: '会写 vendor/VENDOR.json，只在 vendor 里两个引擎变动时手动跑（跑完 doctor 才认指纹）',
  },
  {
    file: 'tools/sync-trees.mjs',
    smoke: true,
    args: [],
    why: '把本仓同步到阅读树与装机树；默认只体检不写盘（--apply 才 robocopy /E，从不删除），所以随时可跑',
  },
  {
    file: 'tools/bench-locomo.mjs',
    smoke: false,
    why: '英文独立量尺：数据集（LoCoMo locomo10.json）在仓库外，没有 --data 时按设计 exit=2 打用法——自动冒烟必然报「跑不起来」，与脚本好坏无关',
  },
  {
    file: 'tools/restore-live-db.mjs',
    smoke: false,
    why: '把快照库覆盖回活动库并清掉 -wal/-shm：宿主在跑时会拒绝，真跑一次就改写用户的库，只能主人点名跑（--dry-run 可先看）',
  },
]
