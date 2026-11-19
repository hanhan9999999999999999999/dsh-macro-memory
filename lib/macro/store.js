/**
 * 存储层：macro 自己的两个 jsonl 文件「在哪、怎么写、怎么读」。
 *
 * 为什么单开一个文件（0.2.21）：路径与 jsonl 的读写原本散在 `cost.js`（成本账本）与 `links.js`
 * （待补连线队列）里，于是队列要从成本账本 import 一个 `macroHome()` —— 依赖方向与现实语义
 * 正好反了（队列不是成本的一部分），而且「读文件→按行 JSON.parse→跳过坏行」这段一模一样的
 * 循环写了两遍。两处各自都正确，合起来就是两个错：谁都能改路径，谁都能改解析规则。
 *
 * 三条约定，改这个文件之前先读：
 *   1. **`$DSH_HOME` 只在这里读一次**。别处的路径一律由 `ledgerPath()` / `pendingPath()` 给出，
 *      这样「换个 home」只需要改一处，doctor 也能用一行断言盯住。
 *   2. **jsonl 的坏行一律跳过，不抛**。这两个文件都是「降级不影响记忆主功能」的类型：
 *      一行坏掉的账不该让整个账本读不出来。
 *   3. **这层不认识业务**。它不知道「成本」和「待补连线」是什么，只知道文件名与行格式。
 */
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** macro 的数据目录：`$DSH_HOME/macro-memory`（没设 DSH_HOME 时退回 ~/.dsh）。 */
export function macroHome() {
  const root = process.env.DSH_HOME && process.env.DSH_HOME.length > 0 ? process.env.DSH_HOME : join(homedir(), '.dsh')
  return join(root, 'macro-memory')
}

/** 成本账本。 */
export function ledgerPath() {
  return join(macroHome(), 'cost.jsonl')
}

/** 待补连线队列。 */
export function pendingPath() {
  return join(macroHome(), 'pending-links.jsonl')
}

/**
 * 读一个 jsonl 文件，**并把「为什么没读到」一起回出来**（0.2.55）。
 *
 * [macro-fusion 0.2.55] 一处 `[]` 原来同时代表四种来路：
 * 从没写过 / 文件读不出来（EACCES、EISDIR）/ 整份都是坏行 / 写了但一条都没落成。
 * 上游面板只能拿这个「空」去编一句话，就变成「账本还是空的，调用几次再看」——
 * 明明是我们写不进去，说出来却像用户没调用过。
 *
 * @returns {{entries: any[], exists: boolean, unreadable: boolean, badLines: number, lines: number, error: string}}
 */
export function readJsonlDetail(file) {
  let raw = ''
  try {
    raw = readFileSync(file, 'utf8')
  } catch (err) {
    const missing = err && err.code === 'ENOENT'
    // ENOENT 才是「真的没有」；别的错误（权限、把目录当文件读）都是「这次读不出来」
    return {
      entries: [],
      exists: !missing,
      unreadable: !missing,
      badLines: 0,
      lines: 0,
      error: missing ? '' : String(err?.message ?? err),
    }
  }
  const entries = []
  let badLines = 0
  let lines = 0
  for (const line of raw.split('\n')) {
    if (line.trim().length === 0) continue
    lines += 1
    try {
      entries.push(JSON.parse(line))
    } catch {
      badLines += 1
    }
  }
  return { entries, exists: true, unreadable: false, badLines, lines, error: '' }
}

/**
 * 读一个 jsonl 文件，返回能解析的条目数组。
 * 文件不存在 → 空数组；空行与坏行 → 跳过（约定 2）。
 */
export function readJsonl(file) {
  return readJsonlDetail(file).entries
}

/**
 * 追加一行 JSON（目录不存在就先建），并把失败原因带出来（0.2.55）。
 * 约定 2 是「写不进去不打断调用方」，不是「写不进去不许说」——调用方可以继续省略，
 * 但面板需要知道这批账到底存下来了没有。
 */
export function appendJsonlDetail(file, entry) {
  try {
    mkdirSync(macroHome(), { recursive: true })
    appendFileSync(file, `${JSON.stringify(entry)}\n`, 'utf8')
    return { ok: true, error: '' }
  } catch (err) {
    return { ok: false, error: String(err?.message ?? err) }
  }
}

/** 追加一行 JSON（目录不存在就先建）；写不进去就算了，绝不打断调用方。 */
export function appendJsonl(file, entry) {
  return appendJsonlDetail(file, entry).ok
}
