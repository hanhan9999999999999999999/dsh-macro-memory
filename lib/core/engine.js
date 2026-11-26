/**
 * core/engine —— 不依赖 DSH 的记忆引擎装配层。
 *
 * 它做的事，和 `lib/index.js` 的 `apply()` 是同两件：
 *   1. 把两个引擎（meow / nebula）挂进一个「宿主」里，用 bridge 收下它们的工具与注入；
 *   2. 用 `lib/macro/tools.js` 的 8 个统一工具重新组织，对外只暴露 memory_*。
 *
 * 区别只有一处：宿主不是 cordis，而是 `mini-host.js`。所以这个文件不 import
 * `@deepseek-ai/*`、不读宿主环境变量，任何 agent（MCP / CLI / 自己的 loop）都能直接用它。
 *
 * 库的位置沿用 meow 自己的语义（这是「一份真身」的关键）：
 *   workspace 库 = <workspace>/<projectDir>/memory.db   （默认 .dsh-meow，与 DSH 侧同一个文件）
 *   全局库      = <homeDir>/memory.db                   （默认 ~/.dsh-meow）
 * 也就是说：DSH 里存的记忆，Codex 接进来就该看得见——不需要同步、不需要导入。
 * dataDir（平台数据目录）只放配置、注入块、日志这些派生物，不放记忆正文。
 */

import path from 'node:path'
import { createMiniHost } from './mini-host.js'
import { detectHomeDir, resolveDataDir } from './paths.js'
import { ensureTrust, isTrusted, listTrusted, trustWorkspace } from './trust.js'
import { createBridge, errText, wrapPlugin } from '../macro/bridge.js'
import { renderToolText } from '../macro/render.js'
import { createUnifiedTools } from '../macro/tools.js'
import { GUIDE_MAX_CHARS, GUIDE_TEXT, buildFullGuide, clampGuide, guideBudget } from '../macro/prompt.js'
import * as Meow from '../../vendor/meow-memory/lib/index.js'
import * as Nebula from '../../vendor/dsh-memory-nebula/lib/index.js'

/** 统一工具的默认等待上限（毫秒）：引擎装配是同步的，这个值只在极端情况下兜底。 */
export const DEFAULT_TOOL_WAIT_MS = 30000

/** core 的版本号，由 package.json 之外单独维护一份，方便 CLI 自报家门。 */
export const CORE_NAME = 'macro-memory'

/**
 * 造一个会话执行上下文。
 *
 * 工具的写路径要回答两个问题：「这条记忆属于哪个工作区」「谁写的」。
 * DSH 的答案是 `exec.agent.session.header.cwd` —— core 里照同一条取法，
 * 这样同一份代码在两边对同一个目录算出的 key 一致（库才真的是同一份）。
 */
export function makeExec({ cwd, sessionId, agentId, homeDir } = {}) {
  const header = { cwd: typeof cwd === 'string' ? cwd : process.cwd() }
  const session = { id: sessionId ?? `core-${process.pid}`, header }
  return {
    agent: { session, id: agentId ?? 'core' },
    session,
    homeDir,
  }
}

/**
 * 信任门拒绝时给的话。
 * 要求：说清「是哪个目录 / 为什么」，并给一条能直接粘进终端的命令——
 * 只说「被拒绝」等于把排查成本丢回给人。
 */
function refusalText(guard, homeDir) {
  const lines = [`这个工作区还没被信任，记忆读写已暂停：${guard.dir}`]
  if (guard.reason === 'external' && Array.isArray(guard.leftovers)) {
    const shown = guard.leftovers.slice(0, 3).join('、')
    const more = guard.leftovers.length > 3 ? ` 等 ${guard.leftovers.length} 项` : ''
    lines.push(`目录里有不是本插件产生的文件（${shown}${more}），像是在别处建好的库被带进来了。`)
    lines.push('不猜、不写，是为了避免把别人的「记忆」当成你的——这条是有意的。')
  } else if (guard.reason === 'policy-never') {
    lines.push('当前是 trust=never：任何工作区都不自动信任，只认显式信任。')
  } else if (typeof guard.reason === 'string' && guard.reason.startsWith('unreadable:')) {
    lines.push(`目录读不出来（${guard.reason.slice('unreadable:'.length)}），先修权限再谈信任。`)
  }
  lines.push('确认这是你自己的项目后，跑一次即可恢复（写进信任表，立刻生效，不需要重启）：')
  lines.push(`  npx -y macro-memory trust "${guard.workspace}"`)
  lines.push(`信任表在 ${path.join(homeDir, 'trusted-workspaces')}，与 DSH 的 /meow-trust 同一份——两边互相认。`)
  return lines.join('\n')
}

/**
 * 装配引擎。
 *
 * @param {object} [opts]
 * @param {string} [opts.dataDir]    平台数据目录（配置/日志），缺省按平台算
 * @param {string} [opts.projectDir] workspace 内的库目录名，默认 .dsh-meow（与 DSH 共用）
 * @param {string} [opts.homeDir]    全局库目录，缺省 = detectHomeDir()（装了 DSH 就用它的 storages，否则 ~/.dsh-meow）
 * @param {object} [opts.meow]       覆盖 meow 引擎配置
 * @param {object} [opts.nebula]     覆盖星图引擎配置
 * @param {object} [opts.macro]      覆盖融合层配置（guideMaxChars 等）
 * @param {boolean} [opts.verbose]   打调试日志到 stderr
 * @param {boolean} [opts.withNebula] 是否挂星图引擎，默认 true
 * @param {number} [opts.waitMs]     等引擎工具挂上的上限（毫秒），默认 5000；0 = 不等
 * @param {'auto'|'always'|'never'} [opts.trust] 信任策略，默认 auto（只信空库/本机新建）
 */
export async function createMacroEngine(opts = {}) {
  const dataDir = resolveDataDir({ dir: opts.dataDir })
  const log = opts.verbose === true ? (...a) => console.error('[macro-memory]', ...a) : () => {}
  const warn = (...a) => console.error('[macro-memory]', ...a)

  const host = createMiniHost({ verbose: opts.verbose === true, logger: opts.logger })
  const bridge = createBridge({ log, warn })

  const meowCfg = {
    projectDir: opts.projectDir ?? '.dsh-meow',
    homeDir: opts.homeDir ?? detectHomeDir(),
    ...(opts.meow ?? {}),
  }
  const nebulaCfg = { ...(opts.nebula ?? {}) }
  const macroCfg = { guideMaxChars: GUIDE_MAX_CHARS, ...(opts.macro ?? {}) }
  const meowDirReader = () => (typeof meowCfg.projectDir === 'string' && meowCfg.projectDir.length > 0
    ? meowCfg.projectDir
    : '.dsh-meow')

  host.ctx.plugin(wrapPlugin(Meow, bridge, 'meow'), meowCfg)
  if (opts.withNebula !== false) {
    host.ctx.plugin(wrapPlugin(Nebula, bridge, 'nebula'), nebulaCfg)
  }

  const defs = createUnifiedTools({ bridge, config: macroCfg, meowDir: meowDirReader })
  const byName = new Map(defs.map((d) => [d.name, d]))

  // 信任门的落点：meow 自己算出来的全局目录（装了 DSH 就是 DSH 的 storages，没装就是
  // ~/.dsh-meow）。core 不另建一套，这样两边共用同一张信任表。
  const homeNow = () => Meow.activeHomeDir() ?? ''
  const trustPolicy = opts.trust ?? 'auto'
  // 关掉之后不再服务：MCP / CLI 里进程会退，但库文件句柄与定时器要跟着停，
  // 否则「关完了还在读写」这种半死状态最难查——所以这里显式立一个标志。
  let closed = false

  // 引擎的 apply 是异步的：meow 要迁移库、等设置服务，工具会在几百毫秒后才挂上。
  // 这里等它一次（默认 5s，成功即返回），否则「装配好了」的引擎前几秒是半空壳，
  // MCP 客户端 tools/list 会少一半工具，而且没有任何报错。
  const waitMs = Number.isFinite(opts.waitMs) ? opts.waitMs : 5000
  if (opts.wait !== false) {
    await bridge.awaitTool('memory_remember', waitMs)
    await bridge.awaitTool('nebula_recall', Math.min(waitMs, 1500))
  }

  // 引擎工具是同步注册的（apply 里没有异步等待），这里只做一次兜底确认：
  // 少一个子引擎工具时，统一工具会自己回「尚未就绪」，不在这里提前抛。
  const ready = {
    meow: bridge.has('memory_remember') && bridge.has('memory_search'),
    nebula: bridge.has('nebula_recall'),
  }

  return {
    name: CORE_NAME,
    dataDir,
    projectDir: meowCfg.projectDir,
    homeDir: meowCfg.homeDir,
    /** 8 个统一工具的声明（给 MCP / function calling 用，不含执行体）。 */
    tools: defs.map((d) => ({ name: d.name, description: d.description, parameters: d.parameters })),
    ready,
    /** 直接拿到某个统一工具的原始定义（测试与 CLI 用）。 */
    def(name) {
      return byName.get(name)
    },
    /**
     * 调一个统一工具。
     *
     * 开工前先过信任门：工作区里躺着一个不是本机创建的记忆库时（clone 了别人的仓库），
     * 一律不读不写，回一段能照着敲的说明——比抛一个「写入被拒绝」更有用。
     *
     * @returns {Promise<{text: string, value: any, refused?: boolean}>}
     */
    async call(name, args = {}, execOptions = {}) {
      if (closed) throw new Error('macro-memory：引擎已关闭，不再提供服务')
      const def = byName.get(name)
      if (!def) throw new Error(`macro-memory：没有这个工具 ${name}（有：${[...byName.keys()].join('、')}）`)
      const cwd = path.resolve(execOptions.cwd ?? process.cwd())
      const guard = ensureTrust({
        workspace: cwd,
        homeDir: homeNow(),
        projectDir: meowDirReader(),
        policy: trustPolicy,
      })
      if (!guard.trusted) {
        return { text: refusalText(guard, homeNow()), value: null, refused: true }
      }
      const exec = makeExec({ ...execOptions, cwd })
      const value = await def.execute(args, exec)
      return { text: renderToolText(def, args, value), value }
    },
    /** 这个工作区信不信任（只读，不写 marker）。 */
    trustState(cwd = process.cwd()) {
      const ws = path.resolve(cwd)
      return {
        workspace: ws,
        dir: path.join(ws, meowDirReader()),
        trusted: isTrusted(ws, homeNow()),
        homeDir: homeNow(),
        policy: trustPolicy,
      }
    },
    /** 显式信任一个工作区（CLI 的 `macro-memory trust` 走这里）。 */
    trust(cwd = process.cwd(), source = 'macro-memory:cli') {
      const ws = path.resolve(cwd)
      const ok = trustWorkspace(ws, { homeDir: homeNow(), source })
      return { workspace: ws, trusted: ok, homeDir: homeNow() }
    },
    /** 已信任的工作区清单。 */
    trustedList() {
      return listTrusted(homeNow())
    },
    /** L0 常驻注入文本（字符上限按配置裁）。 */
    injection({ maxChars } = {}) {
      const budget = guideBudget(maxChars ?? macroCfg.guideMaxChars)
      return clampGuide(GUIDE_TEXT, budget.value)
    },
    /** L2 完整手册（按需给）。 */
    fullGuide() {
      return buildFullGuide(bridge)
    },
    /** 引擎里实际注册到的子插件工具名（排障用）。 */
    captured() {
      return bridge.names()
    },
    stats() {
      return { ...host.stats(), ready, captured: bridge.names().length }
    },
    async close() {
      closed = true
      try {
        await host.dispose()
      } catch (err) {
        warn('拆卸宿主失败：', errText(err))
      }
      try {
        await Meow.closeAllDbs?.()
      } catch (err) {
        warn('关库失败：', errText(err))
      }
      try {
        await Nebula.closeAllDbs?.()
      } catch {
        /* 星图没导出这个函数是正常的 */
      }
    },
  }
}

export { writeConfigFile } from './config.js'
export { createMiniHost } from './mini-host.js'
export { defaultDataDir, resolveDataDir, dbDirOf, CONFIG_FILE } from './paths.js'
