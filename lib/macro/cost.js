/**
 * 成本账本：$DSH_HOME/macro-memory/cost.jsonl
 *
 * 只做两件事：每次 memory_* 工具执行后追加一行；memory_admin(action="cost") 汇总最近记录。
 * 账本坏了不影响记忆功能（所有写入都吞异常）。
 *
 * 路径与 jsonl 读写已下沉到 `store.js`（0.2.21）——这里只算「成本」这件事。
 */
import { appendJsonlDetail, ledgerPath, readJsonlDetail } from './store.js'

/** 账本位置（转发自存储层，老调用方不必改 import）。 */
export { ledgerPath }

// 0.2.55：记账失败原来是彻底无声的（约定 2：不打断记忆）。于是面板只能说「账本还是空的，
// 调用几次再来」——把「我写不进去」说成了「你还没调用」。这里留一份最小的失败账，
// 只够面板说实话：连着败了几次、最后一次为什么败。（写成功就清零：旧账不该冒充现在的状态）
const writeFail = { failures: 0, error: '' }

export function recordCall(entry) {
  // 写不进去就算了，不打断记忆（约定 2）
  const r = appendJsonlDetail(ledgerPath(), entry)
  if (!r.ok) {
    writeFail.failures += 1
    writeFail.error = r.error
  } else {
    writeFail.failures = 0
    writeFail.error = ''
  }
}

/** 账本「空」的四种来路（0.2.55）：没写过 / 写不进去 / 读不出来 / 全坏行。 */
function emptyReport(detail) {
  const p = ledgerPath()
  if (writeFail.failures > 0) {
    return (
      `成本账本一行都没写进去：最近 ${writeFail.failures} 次记账都失败了（${writeFail.error}）。\n` +
      `这不是「你还没调用工具」——调用照常发生了，只是账没落下来。账本：${p}`
    )
  }
  if (detail.unreadable) {
    return `成本账本在，但这次读不出来（${detail.error}）——不是账本是空的，也没法确认里头到底有多少条。账本：${p}`
  }
  if (detail.badLines > 0) {
    return `成本账本里有 ${detail.lines} 行，但一行都解析不出来（${detail.badLines} 行坏行）——不是没记过账，是这份账本坏了。账本：${p}`
  }
  if (detail.exists && detail.lines > 0) {
    return `成本账本里有 ${detail.lines} 行，但没有一条是完整的记账记录。账本：${p}`
  }
  return `成本账本还没记过账（${p}）。调用几次 memory_* 工具后再看。`
}

/**
 * [macro-fusion 0.2.76] 「最近 N 次调用」这句话里其实有三个数，以前只报了中间那个。
 *
 * 面板抬头永远写「最近 200 次调用」，正文合计的却是 `entries.slice(-200)` 那几条：
 *   - 账本只有 5 条时，抬头仍说「最近 200 次」——读者以为自己看到 200 次的平均；
 *   - 账本有 300 条时，前面 100 条一个字都没提，合计被当成整本账；
 *   - 中间夹着 2 行坏行时，只要还剩一条好行，这 2 行连数都不进，也没人说「有 2 行读不出来」。
 *
 * 0.2.74 的 `listTail()`、0.2.75 的 `hubTail()` 是同一条路子：**一个口径只有一个出口，
 * 而且只报读者能自己验算的数**。这里能验算的等式是：
 *   账本行数 = 这次算进去的条数 + 更早没进的条数 + 解析不出来的行数
 *
 * 没什么可说的（你要多少真算了多少、账本全进了统计、没有坏行）就返回空串——
 * 那句「最近 N 次」由调用方（面板 note）自己决定还要不要，不必在这儿重复。
 */
export function costScope(asked, counted, good, bad = 0) {
  const want = Math.max(0, Math.trunc(Number(asked) || 0))
  const got = Math.max(0, Math.trunc(Number(counted) || 0))
  const can = Math.max(0, Math.trunc(Number(good) || 0))
  const broken = Math.max(0, Math.trunc(Number(bad) || 0))
  // 一条都没算进去时，「统计最近 0 次」没有信息量：那是空账本的四种来路，正文已经说清了。
  if (got === 0) return ''
  const parts = [`统计最近 ${got} 次调用`]
  if (want > got) parts.push(`（你要的是 ${want} 次，账本里能算的只有 ${got} 条）`)
  const older = can - got
  if (older > 0) parts.push(`；更早的 ${older} 条没进这次统计`)
  if (broken > 0) parts.push(`；另有 ${broken} 行解析不出来，一行都没算进去`)
  return parts.join('')
}

/** 成本面板：正文交给 `readCost().body`，口径交给 `readCost().scope`（同一个函数里算，不重读账本）。 */
export function readCost(limit = 200) {
  const detail = readJsonlDetail(ledgerPath())
  const n = Number(limit)
  // 0.2.61：`entries.slice(-limit)` 在 limit=0 时是 `slice(-0)`＝整本账——要求「一条都别列」
  // 反而列出全部。这里先把它挡住：照办 0，并且说清账本里其实有多少行。
  if (Number.isFinite(n) && n <= 0) {
    return {
      body: `按你给的 limit=${n} 这次一条都不列（账本里其实有 ${detail.lines} 行，不是没有记录）。账本：${ledgerPath()}`,
      scope: '',
    }
  }
  const entries = detail.entries.slice(-n)
  if (entries.length === 0) {
    return { body: emptyReport(detail), scope: '' }
  }
  const byTool = new Map()
  let argsChars = 0
  let resultChars = 0
  let failed = 0
  let ms = 0
  for (const e of entries) {
    argsChars += Number(e.argsChars) || 0
    resultChars += Number(e.resultChars) || 0
    ms += Number(e.ms) || 0
    if (e.ok === false) failed += 1
    const key = String(e.tool ?? '?')
    const bucket = byTool.get(key) ?? { n: 0, args: 0, out: 0, fail: 0 }
    bucket.n += 1
    bucket.args += Number(e.argsChars) || 0
    bucket.out += Number(e.resultChars) || 0
    if (e.ok === false) bucket.fail += 1
    byTool.set(key, bucket)
  }
  // 抬头（面板名 + 「最近 N 次调用」）由 panel.js 统一加，这里只管账目本身（0.2.25）
  const lines = [
    `合计：入参 ${argsChars} 字符 / 出参 ${resultChars} 字符 / 失败 ${failed} 次 / 耗时 ${ms} ms`,
    '按工具：',
  ]
  for (const [name, b] of [...byTool.entries()].sort((a, b) => b[1].n - a[1].n)) {
    lines.push(`- ${name}：${b.n} 次，入参 ${b.args} 字符，出参 ${b.out} 字符${b.fail > 0 ? `，失败 ${b.fail}` : ''}`)
  }
  lines.push(`账本：${ledgerPath()}`)
  return { body: lines.join('\n'), scope: costScope(n, entries.length, detail.entries.length, detail.badLines) }
}

/** 老接口：只要正文。兼容 `probe-fusion` 里那些直接读字符串的调用点。 */
export function costReport(limit = 200) {
  return readCost(limit).body
}

/** 包一个工具定义，执行前后记账。 */
export function withCost(toolName, def) {
  return {
    ...def,
    async execute(args, exec) {
      const started = Date.now()
      let ok = true
      let result
      try {
        result = await def.execute(args, exec)
        return result
      } catch (err) {
        ok = false
        throw err
      } finally {
        let argsChars = 0
        let resultChars = 0
        try {
          argsChars = JSON.stringify(args ?? {}).length
        } catch {
          argsChars = 0
        }
        try {
          resultChars = typeof result === 'string' ? result.length : JSON.stringify(result ?? '').length
        } catch {
          resultChars = 0
        }
        recordCall({ ts: new Date().toISOString(), tool: toolName, ok, argsChars, resultChars, ms: Date.now() - started })
      }
    },
  }
}
