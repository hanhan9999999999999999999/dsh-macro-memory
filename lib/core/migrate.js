/**
 * 库版本门（PLAN-UNIVERSAL P0-5 / 判据 U8）。
 *
 * 只有一条规矩：**适配层只认不高于自己的库**。库比适配层新（别人用更新的版本写过），
 * 这一层就只读——不是怕，是不知道新版本加了什么约束，硬写等于赌。
 *
 * 版本号存在 SQLite 原生的 `PRAGMA user_version` 里（meow 自己从不碰它，见
 * `grep -n "user_version" vendor/meow-memory/lib/index.js` 零命中），所以不需要
 * 新建元表、不需要迁移表结构，也不会让老库「看起来被改过」。
 *
 * 这一层**不主动写盘**：打开老库时只读 0，写入 `user_version` 只发生在用户显式跑
 * `macro-memory migrate` 时——自动打戳会让「只读检查」变成「悄悄改库」。
 */

/** 当前适配层认识的库结构版本。加列/加表时 +1，并在 migrate 里补对应的 DDL。 */
export const SCHEMA_VERSION = 1

/** 兼容 meow 的 MemoryDb 包装（有 p/exec）与裸 node:sqlite DatabaseSync（有 prepare/exec）。 */
function prepareOf(db) {
  if (!db) return null
  if (typeof db.p === 'function') return db.p.bind(db)
  if (typeof db.prepare === 'function') return db.prepare.bind(db)
  return null
}

export function readSchemaVersion(db) {
  const p = prepareOf(db)
  if (!p) return null
  try {
    const row = p('PRAGMA user_version').get()
    if (!row) return 0
    const v = Number(row.user_version ?? Object.values(row)[0])
    return Number.isFinite(v) && v >= 0 ? v : null
  } catch {
    return null
  }
}

/** 只在显式 `migrate` 时调用。返回写入后的版本；读不出来就抛，不猜。 */
export function stampSchema(db, version = SCHEMA_VERSION) {
  const v = Math.max(0, Math.floor(version))
  if (typeof db?.exec === 'function') db.exec(`PRAGMA user_version = ${v}`)
  else if (typeof db?.db?.exec === 'function') db.db.exec(`PRAGMA user_version = ${v}`)
  else throw new Error('这个库句柄没有 exec()，写不了 user_version')
  return v
}

/**
 * 判一次门。
 * @returns {{ok:boolean, dbVersion:number|null, adapterVersion:number, readOnly:boolean, reason:string|null}}
 *   reason ∈ db-newer（库比适配层新，只读）/ unreadable（读不出来，放行但记账）/ null
 */
export function checkSchema(db) {
  const dbVersion = readSchemaVersion(db)
  const base = { dbVersion, adapterVersion: SCHEMA_VERSION, readOnly: false, reason: null }
  if (dbVersion === null) return { ...base, ok: false, reason: 'unreadable' }
  if (dbVersion > SCHEMA_VERSION) return { ...base, ok: false, readOnly: true, reason: 'db-newer' }
  return { ...base, ok: true }
}

/** 版本门拒绝时给的话：说清谁比谁新、能做什么、怎么解决。 */
export function schemaRefusalText(check) {
  return [
    `这个记忆库比当前适配层新：库 schema v${check.dbVersion} > macro-memory v${check.adapterVersion}。`,
    '多半是你用更新的 macro-memory 写过这个库，现在用的是旧版本。',
    '为了不写坏，读写都先停了——不是不让你用，是不猜新字段的规矩。',
    '两条路：① 升级适配层：npm i -g dsh-macro-memory@latest（或 npx -y -p dsh-macro-memory macro-memory@latest ...）；',
    '          ② 确认那份新数据不重要，跑 `macro-memory migrate` 把它降到本层认识的结构（会先备份）。',
  ].join('\n')
}
