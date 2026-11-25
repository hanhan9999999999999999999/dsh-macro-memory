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
import { appendFileSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync } from 'node:fs'
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
 * [macro-fusion 0.6.43] 邻域注入的「这一会话已经带过哪些条」账本，一个会话一个文件。
 *
 * 为什么要有（0.6.43）：邻域注入器原来的 `seen` 是内存里的 `Map<sessionId, Set>`，
 * 一旦宿主重启/续接会话，账本就归零——同一个会话接着聊，上一轮刚注入的邻居又原样来一遍。
 * 而这一类重复是最纯的浪费：模型在历史里已经看过那条摘要，第二遍纯计费。
 *
 * 文件名按会话 id 派生并做字符收敛：session id 理论上可能带路径分隔符或冒号
 * （跨工作区那种 `ws:session-…` 写法），直接当文件名会在 Windows 上写不进去。
 */
export function neighborSeenPath(sessionId) {
  const raw = String(sessionId ?? '').trim()
  const safe = raw.replace(/[^A-Za-z0-9_.-]+/g, '_').slice(0, 96)
  return join(macroHome(), 'neighbor-seen', `${safe === '' ? 'unknown' : safe}.json`)
}

/**
 * [macro-fusion 0.6.54] 错边观察账：一个**工作区**一份（星图是按工作区建的，不是按会话）。
 *
 * 为什么要独立一份：0.6.44 起邻域注入会给模型一条现成的 `nebula_link(action="mute")` 命令，
 * 但「模型有没有动手」没有任何记录——同一跳错边在没被断掉之前，每轮都会重新被词面闸标一次
 * 「未沾词」再带进上下文。要让它「连标几轮就暂时不带」，就得跨轮记住这一跳标过几次；
 * 会话账本（neighbor-seen）记的是「带过哪些条」，不是「哪一跳反复出问题」，两者生命周期也不同。
 *
 * 文件名同样做字符收敛（工作区是绝对路径，含 : \ / 全都不合法），取尾部 96 字符：
 * 同一台机器上工作区路径的尾部才是区分度所在。
 */
export function neighborSuspectPath(workspace) {
  const raw = String(workspace ?? '').trim()
  const safe = raw.replace(/[^A-Za-z0-9_.-]+/g, '_').slice(-96)
  return join(macroHome(), 'neighbor-suspect', `${safe === '' ? 'unknown' : safe}.json`)
}

/**
 * [0.6.66] 修过账：一个工作区一份，记「哪几跳被摘掉了、第几轮、凭什么摘的」。
 *
 * 为什么错边账之外还要这一份：0.6.54/0.6.65 让模型能销账，销完这一跳就从观察账里消失了——
 * 于是「这条边上周已经判过无关」这件事在本地一个字都不剩。三处会因此难受：
 *  ① 面板看不出「已经修过几跳」，看起来永远像没动过手；
 *  ② 模型隔几天再遇到同一批邻居，会重新判一遍、重新摘一遍；
 *  ③ 摘错了没有回头路可讲——`unmute` 得知道两端的 id，而账已经没了。
 * 星图自己记得 mute（重建也不会再连），但它只记得「断了」，不记得「为什么断」。
 */
export function neighborFixesPath(workspace) {
  const raw = String(workspace ?? '').trim()
  const safe = raw.replace(/[^A-Za-z0-9_.-]+/g, '_').slice(-96)
  return join(macroHome(), 'neighbor-fixes', `${safe === '' ? 'unknown' : safe}.json`)
}

/**
 * [macro-fusion 0.6.44] 单个会话账本里最多留多少条 id。
 *
 * 为什么要上限（0.6.44）：这份账本是「这一会话已经带过哪些邻居」，只进不出——
 * 一个跑了几百轮的会话会把文件写成几百 KB，每次 decide 还要整份 parse 一遍。
 * 400 条已经远超任何真实会话的有效记忆量（一轮最多 4 条邻域），再往前的
 * 早就被窗口挤出去了，留在账本里只是让读盘越来越慢。
 */
export const NEIGHBOR_SEEN_MAX_IDS = 400

/**
 * [macro-fusion 0.6.44] 清理邻域账本目录：按天数与文件数两条线，都只删**本插件自己的缓存**。
 *
 * 为什么要有（0.6.44）：`neighbor-seen/` 一个会话一个文件，宿主重启、临时会话、
 * 探针、子代理都会留下文件，从来没有人删。跑久了目录里躺着几百个几十字节的小文件，
 * 每次列目录/备份都拖慢。这里给两条线：太老的（默认 30 天）与太多的（默认留最近 200 个）。
 *
 * 三条约束：
 *  ① 只碰 `<macroHome>/neighbor-seen/*.json`，别的路径一个字节都不动；
 *  ② 任何一步失败都只回在返回值里，不抛——这是缓存清理，不是主流程；
 *  ③ `maxFiles <= 0` 表示不限文件数（只按天数删）。
 *
 * @param {{maxAgeDays?: number, maxFiles?: number, now?: number}} opts
 * @returns {{scanned: number, removedByAge: number, removedByCount: number, error: string}}
 */
export function pruneNeighborSeen(opts = {}) {
  const maxAgeDays = Number.isFinite(opts.maxAgeDays) ? Math.max(0, opts.maxAgeDays) : 30
  const maxFiles = Number.isFinite(opts.maxFiles) ? Math.max(0, Math.floor(opts.maxFiles)) : 200
  const now = Number.isFinite(opts.now) ? opts.now : Date.now()
  const out = { scanned: 0, removedByAge: 0, removedByCount: 0, error: '' }
  const dir = join(macroHome(), 'neighbor-seen')
  let names = []
  try {
    names = readdirSync(dir).filter((n) => n.endsWith('.json'))
  } catch (err) {
    // ENOENT 是常态（还没写过账本），不当错误。
    if (err && err.code !== 'ENOENT') out.error = String(err?.message ?? err)
    return out
  }
  const files = []
  for (const name of names) {
    const file = join(dir, name)
    try {
      const st = statSync(file)
      if (!st.isFile()) continue
      files.push({ file, mtime: st.mtimeMs })
      out.scanned += 1
    } catch {
      // 列目录与 stat 之间被删掉了：跳过就行。
    }
  }
  const cutoff = now - maxAgeDays * 86400000
  const survivors = []
  for (const f of files) {
    if (maxAgeDays > 0 && f.mtime < cutoff) {
      try {
        unlinkSync(f.file)
        out.removedByAge += 1
        continue
      } catch {
        // 删不动就留着，下次数的时候再说。
      }
    }
    survivors.push(f)
  }
  if (maxFiles > 0 && survivors.length > maxFiles) {
    survivors.sort((a, b) => b.mtime - a.mtime)
    for (const f of survivors.slice(maxFiles)) {
      try {
        unlinkSync(f.file)
        out.removedByCount += 1
      } catch {
        // 同上。
      }
    }
  }
  return out
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
