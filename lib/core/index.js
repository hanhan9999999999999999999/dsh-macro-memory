/**
 * core/index —— 这个包对外的「core 面」：装配一个引擎、认出库在哪、把写交给谁。
 *
 * 为什么要这一支（PLAN §11.2）：`exports` 里 `"."` 与 `"./core"` 都指向这里，于是
 *
 *   import { createMacroEngine } from 'macro-memory/core'
 *
 * 就能拿到整套 core，而不用记住 `engine.js` / `owner.js` / `serve.js` 各在哪一格。
 * 这不是又一层实现——**这里一行逻辑都不写**，只把已经存在、已经有判据盯着的东西
 * 摆到门口。多写一行「顺手做点什么」的代码，就多一处没人盯的口径。
 *
 * 分三组摆：
 *   1. 装配与位置：引擎、数据目录、配置文件；
 *   2. 归属与可见性：谁写的、能给谁看（PRIVATE / workspace / global）；
 *   3. 共享与围栏：单写者服务、待补交队列、AGENTS.md 的块。
 *
 * 不给的东西（故意的）：`lib/macro/**` 的八层实现细节与 `lib/ui/**` 的页面。
 * 前者是内部构造，改起来不该被外部调用固定住；后者在 `macro-memory/ui`。
 */

export {
  CONFIG_FILE,
  CORE_NAME,
  DEFAULT_TOOL_WAIT_MS,
  createMacroEngine,
  createMiniHost,
  dbDirOf,
  defaultDataDir,
  makeExec,
  resolveDataDir,
  writeConfigFile,
} from './engine.js'

export { CONFIG_VERSION, defaultConfig, loadConfig, mergeConfig, saveConfig } from './config.js'

export {
  DEFAULT_SCOPE_BY_LEVEL,
  SCOPES,
  buildVisibility,
  createOwnerStore,
  defaultScopeOf,
  labelOf,
  normalizeScope,
  tagOwners,
} from './owner.js'

export { serveStats, startServe } from './serve.js'

export {
  DEDUP_WINDOW,
  PENDING_FILE,
  SERVE_FILE,
  discover,
  enqueuePending,
  flushPending,
  makeRequestId,
  modeNote,
  offlineText,
  pendingCount,
  pendingFilePath,
  readPending,
  readServeInfo,
  removeServeInfo,
  request,
  rewritePending,
  serveFilePath,
  sharedCall,
  writeServeInfo,
} from './client.js'

export {
  CREATION_IGNORE,
  CREATION_PREFIX,
  ensureTrust,
  isCreationArtifact,
  isTrusted,
  listTrusted,
  markerPathOf,
  markersDirOf,
  normalizeWorkspacePath,
  readTrustMarker,
  trustWorkspace,
  untrustWorkspace,
} from './trust.js'

export { SCHEMA_VERSION, checkSchema, readSchemaVersion, schemaRefusalText, stampSchema } from './migrate.js'

export { APP_DIR_NAME, detectHomeDir, pathFor } from './paths.js'

export {
  FENCE_BEGIN,
  FENCE_END,
  FENCE_VERSION,
  detectEol,
  locate,
  looksEmpty,
  renderBlock,
  spliceBlock,
  stripBlock,
} from './fence.js'

export { DEFAULT_TARGETS, applyBlock, inspectBlock, removeBlock, resolveTargets } from './agents-file.js'
