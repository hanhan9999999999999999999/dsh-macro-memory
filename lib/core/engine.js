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
import fs from 'node:fs'
import { createMiniHost } from './mini-host.js'
import { detectHomeDir, resolveDataDir } from './paths.js'
import { ensureTrust, isTrusted, listTrusted, trustWorkspace } from './trust.js'
import { checkSchema, readSchemaVersion, schemaRefusalText, stampSchema, SCHEMA_VERSION } from './migrate.js'
import { buildVisibility, createOwnerStore, normalizeScope, tagOwners } from './owner.js'
import { discover, pendingCount, serveFilePath, sharedCall } from './client.js'
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
export function makeExec({ cwd, sessionId, agentId, homeDir, visibility } = {}) {
  const header = { cwd: typeof cwd === 'string' ? cwd : process.cwd() }
  const session = { id: sessionId ?? `core-${process.pid}`, header }
  return {
    agent: { session, id: agentId ?? 'core' },
    session,
    homeDir,
    // 可见性（0.9.0）：引擎在执行前把「这个 agent 看不见哪些 id」算好挂在这里，
    // meow 侧只问一句 `hidden.has(id)`。不挂就是「不限制」——老库、单 agent 场景照旧。
    ...(visibility ? { visibility } : {}),
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
  // 共享层开关（PLAN 第 5 节）：`auto` = 探到 serve 就走服务、探不到就直连；
  // `off` = 永远直连（serve 自己、以及要「结果可复现」的探针都用这档）。
  const serveMode = opts.serve === 'off' ? 'off' : 'auto'
  // 关掉之后不再服务：MCP / CLI 里进程会退，但库文件句柄与定时器要跟着停，
  // 否则「关完了还在读写」这种半死状态最难查——所以这里显式立一个标志。
  let closed = false

  /**
   * 库版本门（PLAN P0-5 / U8）。只在库文件**已经存在**时读——库还没建就交给 meow
   * 自己建，不因为「检查版本」顺手创建一个空库（那会让 doctor 产生副作用）。
   * 读不出来（权重、坏文件）一律放行并在回执里记账：诊断功能不该挡死主流程。
   */
  function schemaGate(cwd, dir) {
    const file = path.join(cwd, dir, 'memory.db')
    if (!fs.existsSync(file)) return { checked: false, ok: true, readOnly: false, reason: null, dbVersion: null, adapterVersion: SCHEMA_VERSION }
    try {
      return { checked: true, ...checkSchema(Meow.getDb(cwd, dir)) }
    } catch (err) {
      log('版本门读不出来，放行：', errText(err))
      return { checked: false, ok: true, readOnly: false, reason: 'unreadable', dbVersion: null, adapterVersion: SCHEMA_VERSION }
    }
  }

  /**
   * 归属账（PLAN P1-2 的第一半）：谁写的、能给谁看。
   *
   * 只在库文件已经存在时打开——和版本门同一个理由：检查不该顺手建库。
   * 打不开就返回 null，整个归属环节当没发生：它永远不该挡住「记一条记忆」这件事。
   */
  const ownerStores = new Map()
  function ownerStoreFor(cwd, dir) {
    const file = path.join(cwd, dir, 'memory.db')
    if (!fs.existsSync(file)) return null
    if (ownerStores.has(file)) return ownerStores.get(file)
    try {
      const store = createOwnerStore(Meow.getDb(cwd, dir))
      ownerStores.set(file, store)
      return store
    } catch (err) {
      log('归属账打不开，跳过：', errText(err))
      return null
    }
  }

  // 写工具要记账，读工具要标注；其余（dream / admin / link）不碰归属。
  const WRITE_TOOLS = new Set(['memory_remember', 'memory_update'])
  const READ_TOOLS = new Set(['memory_search', 'memory_read', 'memory_project'])

  /**
   * 从返回值里认出这条记忆的 id：结构化字段优先，认不出再从回执文本里捞 `id=xxxx`。
   *
   * 两条判据都得**放连字符进来**：meow 的 id 是 `<base36 时间戳>-<26 位 uuid>`（`newId()`，
   * vendor/meow-memory/lib/index.js:421），而回执只印 `id.slice(0, 8)`——那 8 位是**时间前缀**，
   * 精度 36 ms。原来这里写 `[0-9a-z]{6,}`，含 `-` 的完整 id 一律判非法，于是每次都退化成从回执
   * 文本里捞那 8 位；两条记忆在同一 36 ms 窗口里写入就会捞到**同一个**短 id，后写的那次把前一条的
   * 归属行覆盖掉（`record()` 走 UPDATE 分支）。Windows 上每条写入跨毫秒，撞不上；Linux CI 上三条
   * 连写落在同一窗口，probe-share 的 S5 就把 soul/rules 都读成了最后一次写的 `global`。
   * 结构化的 `value.id` 一直都是完整的，只是被这条正则挡住了。
   */
  function newIdOf(value, text) {
    const cands = [value?.id, value?.memory?.id, value?.result?.id, value?.value?.id]
    for (const c of cands) {
      if (typeof c === 'string' && /^[0-9a-z][0-9a-z-]{5,}$/.test(c)) return c
    }
    // 兜底只在结构化字段缺失时才走：文本里只有 8 位前缀，撞了就没法分辨，能不用就不用。
    const m = /id\s*=\s*([0-9a-z][0-9a-z-]{5,})/.exec(String(text ?? ''))
    return m ? m[1] : null
  }

  /** 记一条归属。失败不抛：归属是增强，写坏记忆才是事故。 */
  function recordOwnership(name, args, value, text, store, self) {
    try {
      if (name === 'memory_remember') {
        const id = newIdOf(value, text)
        if (!id) return
        store.record(id, {
          owner: self,
          level: args.level,
          scope: normalizeScope(args.scope, args.level),
          visibility: normalizeScope(args.visibility, args.level),
        })
        return
      }
      if (name === 'memory_update') {
        const id = typeof args.id === 'string' ? args.id : newIdOf(value, text)
        if (id) store.touch(id, { editor: self })
      }
    } catch (err) {
      log('归属记账失败（不影响写入）：', errText(err))
    }
  }

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
      // 信任门过了才谈版本：库比适配层新时一律只读，不猜新字段的规矩。
      const schema = schemaGate(cwd, meowDirReader())
      if (schema.readOnly) {
        return { text: schemaRefusalText(schema), value: null, refused: true, schema }
      }
      // 共享层（PLAN 第 5、6 节 / P1-1 / U7 / U9）：本机有 serve 在跑时，读写都交给它。
      // 没有 `serve.json` 就是「没装服务」，这一支直接返回，一次 fs 读、零连接——
      // 不装服务的人不该为这套东西付任何代价。
      if (execOptions.noServe !== true && serveMode !== 'off') {
        const share = await sharedCall({
          dataDir,
          tool: name,
          args,
          cwd,
          agentId: execOptions.agentId,
          sessionId: execOptions.sessionId,
        })
        if (share.mode !== 'standalone') {
          return { text: share.text, value: share.value, refused: share.refused === true, share }
        }
      }
      // 可见性要在执行**之前**算：别人的 private 条目连候选池都不该进，
      // 过滤放在渲染之后等于先把答案给了再划掉——k 条被占位、时间轴也会漏。
      //
      // 注意这里是**两次**取 store，不是一次：`ownerStoreFor` 在库文件还不存在时返回 null
      // （检查不该顺手建库），而「第一次写入」这个场景正是库还不存在——用前置那一次记账，
      // 第一条记忆的归属就会永久丢失（probe-share 的 S0/S1 就这么抓到过）。
      const selfId = typeof execOptions.agentId === 'string' && execOptions.agentId !== '' ? execOptions.agentId : 'core'
      const before = ownerStoreFor(cwd, meowDirReader())
      const visibility = before ? buildVisibility(before, selfId) : null
      const exec = makeExec({ ...execOptions, cwd, ...(visibility ? { visibility } : {}) })
      const value = await def.execute(args, exec)
      let text = renderToolText(def, args, value)
      // 归属（PLAN P1-2 / U6）：写侧记账、读侧标注。整段失败只记日志，回执照旧。
      const store = ownerStoreFor(cwd, meowDirReader())
      if (store) {
        const self = exec.agent?.id ?? 'core'
        try {
          if (WRITE_TOOLS.has(name)) recordOwnership(name, args, value, text, store, self)
          if (READ_TOOLS.has(name)) text = tagOwners(text, store, self)
        } catch (err) {
          log('归属环节出错（不影响本次调用）：', errText(err))
        }
      }
      return { text, value }
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
    /** 库版本门状态（doctor / CLI migrate 用，只读不写）。 */
    schemaState(cwd = process.cwd()) {
      const ws = path.resolve(cwd)
      return { workspace: ws, dir: path.join(ws, meowDirReader()), ...schemaGate(ws, meowDirReader()) }
    },
    /**
     * 归属分布账（UI 概览 / 共享矩阵 / agent 页用，只读不写）。
     *
     * 只读的意思很具体：库不存在就返回空账，**不建库、不建表**——打开 UI 看一眼不该在
     * 任何工作区里留下 `.dsh-meow/`。要看「各层真实条数」请调 `memory_admin action=stats`，
     * 那是 meow 自己的账；这里只报「我们记过归属的那部分」，两者差多少正好说明还有多少
     * 老条目没有归属（0.9 之前写的一律没有）。
     */
    census(cwd = process.cwd()) {
      const ws = path.resolve(cwd)
      const dir = meowDirReader()
      const store = ownerStoreFor(ws, dir)
      const c = store && typeof store.census === 'function' ? store.census() : null
      const agents = store && typeof store.agents === 'function' ? store.agents() : []
      return {
        workspace: ws,
        dir: path.join(ws, dir),
        dataDir,
        ...(c ?? { total: 0, scopes: { private: 0, workspace: 0, global: 0 }, layers: {}, matrix: {}, owners: 0 }),
        agents: agents.map((a) => ({ owner: String(a.owner ?? ''), n: Number(a.n ?? 0), first: a.first ?? null, last: a.last ?? null })),
      }
    },
    /**
     * 共享层状态（doctor / `macro-memory stats` 用，只读不写）。
     *
     * 三档的说法与回执一致：`standalone` 没装服务、`shared` 服务在跑、`readonly`
     * `serve.json` 还在但连不上（待补交队列这时候才有意义）。
     */
    async shareState() {
      const found = await discover(dataDir)
      const mode = found.mode === 'stale' ? 'readonly' : found.mode
      return {
        mode,
        dataDir,
        serveFile: serveFilePath(dataDir),
        pending: pendingCount(dataDir),
        info: found.info
          ? { pid: found.info.pid, url: found.info.url, startedAt: found.info.startedAt, version: found.info.version }
          : null,
        stats: found.stats ?? null,
        reason: found.reason ?? null,
      }
    },
    /**
     * 显式迁移（只在用户敲 `macro-memory migrate` 时跑）。
     *
     * 只做一件事：把 `PRAGMA user_version` 抬到适配层认识的版本。v0 → v1 的表结构
     * 与 meow 建出来的完全一样（meow 从不写 user_version），所以这一步是**记账**，
     * 不是改结构；将来加列/加表的 DDL 都挂在这个函数里，一处升级。
     *
     * 真写之前先 `vacuumInto` 出一份一致副本（不是 `copyFile`——WAL 里可能还有页）；
     * 库比适配层新时**不降级**：那条路只能靠升级适配层，猜着打戳等于替别人做决定。
     */
    migrateSchema(cwd = process.cwd(), { to = SCHEMA_VERSION, dryRun = false } = {}) {
      const ws = path.resolve(cwd)
      const dir = meowDirReader()
      const file = path.join(ws, dir, 'memory.db')
      if (!fs.existsSync(file)) return { ok: false, reason: 'no-db', from: null, to, backup: null }
      const db = Meow.getDb(ws, dir)
      const from = readSchemaVersion(db)
      if (from === null) return { ok: false, reason: 'unreadable', from, to, backup: null }
      if (from === to) return { ok: true, reason: 'already', from, to, backup: null }
      if (from > to) return { ok: false, reason: 'db-newer', from, to, backup: null }
      if (dryRun) return { ok: true, reason: 'would-stamp', from, to, backup: null }
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      const backup = `${file}.bak-${stamp}`
      try {
        db.vacuumInto(backup)
      } catch (err) {
        warn('一致副本没做出来，退回整文件复制：', errText(err))
        fs.copyFileSync(file, backup)
      }
      const written = stampSchema(db, to)
      return { ok: true, reason: 'stamped', from, to: written, backup }
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
