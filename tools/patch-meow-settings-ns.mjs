#!/usr/bin/env node
/**
 * patch-meow-settings-ns.mjs — 让 meow 的设置面板在自己的 entry id 下读配置。
 *
 * 背景（2026-11-18 22:30，主人贴的市场诊断）：
 *   dsh-macro-memory 的设置面板读不到配置：它按「meow-memory」读取，
 *   而这个环境里没有这个名字的条目 id，它自己的条目是「macro-memory」。
 *
 * 成因：宿主按 entry id 注册 config 命名空间。本包以 `macro-memory` 身份挂载，
 *   meow 客户端却把 `SETTINGS_NS = "meow-memory"` 写死，`settingsScope.bind()`
 *   与 `configForms.get()` 都去问一个不存在的命名空间 → 面板空白。
 *
 * 改法（只动 vendor 副本里的 meow 客户端产物，原包不动）：
 *   1) 新增候选列表 ["macro-memory", "dsh-macro-memory", "meow-memory"] 与两个探测函数；
 *   2) settingsScope 分支先问 configForms 哪个命名空间真有表单，再按候选顺序 bind，失败继续试下一个；
 *   3) configForms 分支先探测哪个命名空间有表单，再 get；探不到就不挂、留给轮询。
 *
 * 用法：
 *   node tools/patch-meow-settings-ns.mjs          # 只检查锚点，不写盘
 *   node tools/patch-meow-settings-ns.mjs --apply  # 写盘
 *
 * 幂等：已打过补丁时直接跳过（检测标记串）。
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const ROOT = path.resolve(HERE, '..')
const TARGET = path.join(ROOT, 'vendor', 'meow-memory', 'lib', 'client.js')
const APPLY = process.argv.includes('--apply')
const MARK = 'SETTINGS_NS_CANDIDATES'

const ANCHOR_NS = 'var SETTINGS_NS = "meow-memory";'
const ANCHOR_SCOPE = 'if (settingsScope !== void 0) return mountWithScope(settingsScope.bind({ namespace: SETTINGS_NS }));'
const ANCHOR_FORMS = 'mountDisposer = mountWithScope(configForms.get(SETTINGS_NS));'

const BLOCK = `${ANCHOR_NS}
// 2026-11-18 22:30 修复（tools/patch-meow-settings-ns.mjs）：宿主按 entry id 注册 config
// 命名空间，本包以 macro-memory 身份挂载时配置挂在 "macro-memory" 下；写死读 "meow-memory"
// 会读不到（设置面板空白）。按候选顺序探测，独立运行时仍回落到 meow-memory。
var ${MARK} = ["macro-memory", "dsh-macro-memory", "meow-memory"];
function resolveSettingsNs(probe) {
  for (let i = 0; i < ${MARK}.length; i += 1) {
    const ns = ${MARK}[i];
    try {
      if (probe(ns)) return ns;
    } catch {
    }
  }
  return ${MARK}[0];
}
function bindSettingsScope(scope, order) {
  const list = Array.isArray(order) && order.length > 0 ? order : ${MARK};
  for (let i = 0; i < list.length; i += 1) {
    try {
      return scope.bind({ namespace: list[i] });
    } catch {
    }
  }
  return null;
}`

// settingsScope 分支没有表单可探测，就先问 configForms 哪个命名空间真有表单，
// 把探测结果排到候选队首；configForms 还没就绪时退回候选[0]。
const SCOPE_NEW = `const resolveNsFromForms = () => {
    const forms = softService(ctx, "configForms");
    if (forms === void 0 || typeof forms.get !== "function") return ${MARK}[0];
    return resolveSettingsNs((key) => {
      try {
        return forms.get(key) !== void 0;
      } catch {
        return false;
      }
    });
  };
  if (settingsScope !== void 0) {
      const boundScope = bindSettingsScope(settingsScope, [resolveNsFromForms(), ...${MARK}]);
      if (boundScope !== null) return mountWithScope(boundScope);
    }`

const FORMS_NEW = `const settingsForm = configForms.get(resolveSettingsNs((key) => {
      try {
        return configForms.get(key) !== void 0;
      } catch {
        return false;
      }
    }));
    if (settingsForm === void 0 || settingsForm === null) return;
    mountDisposer = mountWithScope(settingsForm);`

function countOf(hay, needle) {
  if (needle.length === 0) return 0
  let n = 0
  let at = hay.indexOf(needle)
  while (at !== -1) {
    n += 1
    at = hay.indexOf(needle, at + needle.length)
  }
  return n
}

if (!fs.existsSync(TARGET)) {
  console.error(`[patch] 目标不存在：${TARGET}`)
  process.exit(2)
}

const before = fs.readFileSync(TARGET, 'utf8')
const bytes0 = Buffer.byteLength(before, 'utf8')
const sha0 = crypto.createHash('sha256').update(before).digest('hex').toUpperCase()

if (before.includes(MARK)) {
  console.log(`[patch] 已打过补丁（发现 ${MARK}），跳过。${bytes0} B  sha256 ${sha0}`)
  process.exit(0)
}

for (const [name, anchor] of [['SETTINGS_NS', ANCHOR_NS], ['settingsScope', ANCHOR_SCOPE], ['configForms', ANCHOR_FORMS]]) {
  const n = countOf(before, anchor)
  if (n !== 1) {
    console.error(`[patch] 锚点 "${name}" 出现 ${n} 次（应为 1），不写盘。`)
    process.exit(3)
  }
}

let after = before
after = after.replace(ANCHOR_NS, BLOCK)
after = after.replace(ANCHOR_SCOPE, SCOPE_NEW)
after = after.replace(ANCHOR_FORMS, FORMS_NEW)

const bytes1 = Buffer.byteLength(after, 'utf8')
const sha1 = crypto.createHash('sha256').update(after).digest('hex').toUpperCase()

console.log(`[patch] target   ${TARGET}`)
console.log(`[patch] before   ${bytes0} B  sha256 ${sha0}`)
console.log(`[patch] after    ${bytes1} B  sha256 ${sha1}`)
console.log(`[patch] delta    ${bytes1 - bytes0 >= 0 ? '+' : ''}${bytes1 - bytes0} B`)

const checks = [
  ['候选顺序 macro-memory 在前', after.includes('["macro-memory", "dsh-macro-memory", "meow-memory"]')],
  ['settingsScope 走 bindSettingsScope', after.includes('const boundScope = bindSettingsScope(settingsScope, [resolveNsFromForms(), ...SETTINGS_NS_CANDIDATES]);')],
  ['settingsScope 分支先探测 configForms', after.includes('const resolveNsFromForms = () => {')],
  ['bindSettingsScope 支持候选顺序', after.includes('function bindSettingsScope(scope, order) {')],
  ['configForms 走 resolveSettingsNs', after.includes('configForms.get(resolveSettingsNs((key) => {')],
  ['不再有裸 get(SETTINGS_NS)', !after.includes('configForms.get(SETTINGS_NS)')],
  ['slots id 未改（仍是 SETTINGS_NS）', after.includes('id: SETTINGS_NS,')],
]
let ok = true
for (const [label, pass] of checks) {
  console.log(`[check] ${pass ? 'PASS' : 'FAIL'}  ${label}`)
  if (!pass) ok = false
}
if (!ok) {
  console.error('[patch] 自检未过，不写盘。')
  process.exit(4)
}

if (!APPLY) {
  console.log('[patch] 干跑（未加 --apply），未写盘。')
  process.exit(0)
}

fs.writeFileSync(TARGET, after, 'utf8')
console.log('[patch] 已写盘。记得同步到 profiles/desktop/node_modules/dsh-macro-memory 的同一路径。')
