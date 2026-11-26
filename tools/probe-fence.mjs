#!/usr/bin/env node
/**
 * F 组：文件围栏（PLAN-UNIVERSAL §8.3 / U10）。
 *
 * 这一支只测纯函数，不装引擎、不建库、不联网——围栏是唯一会碰用户文件的动作，
 * 判据必须能在一秒内反复跑，才敢在每次改完之后跑。
 *
 * 要防的事故（按严重程度排）：
 *   1. 用户原有内容被改了——哪怕只多一个空行，也算数据损失；
 *   2. 卸载摘不干净，留下半块标记；
 *   3. 重复 init 把块叠成两层；
 *   4. CRLF 仓库里塞进 LF 块，git diff 整文件翻红。
 */
import { spliceBlock, stripBlock, locate, looksEmpty, detectEol } from '../lib/core/fence.js'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { root } from './_root.mjs'

const BIN = path.join(root, 'bin', 'macro-memory.mjs')

let pass = 0
let fail = 0
function check(name, cond, detail = '') {
  if (cond) {
    pass++
    console.log(`PASS  ${name}${detail ? `  ${detail}` : ''}`)
  } else {
    fail++
    console.log(`FAIL  ${name}  ${detail}`)
  }
}

const L0 = '你有记忆工具：memory_search / memory_remember / memory_read。先查再写，一条一事。'

// ── F1 空文件：创建块，摘完回到空 ────────────────────────────────
{
  const a = spliceBlock('', L0)
  const s = stripBlock(a.text)
  check('F1 空文件 → created，摘完回到空（调用方可以据此删文件）',
    a.action === 'created' && looksEmpty(s.text) && s.removed,
    `action=${a.action}`)
}

// ── F2 幂等：同一份 L0 写两次，字节不变 ──────────────────────────
{
  const src = '# AGENTS\n\n写点规矩。\n'
  const a = spliceBlock(src, L0)
  const b = spliceBlock(a.text, L0)
  check('F2 幂等：连写两次字节相同，且第二次是 replaced 不是叠加',
    a.text === b.text && b.action === 'replaced' && (b.text.match(/macro-memory:begin/g) ?? []).length === 1,
    `action=${b.action}`)
}

// ── F3/F4 摘块后逐字节还原（三种结尾各一条，最容易被 eol 处理弄坏）──
for (const [name, src] of [
  ['F3 以两个空行结尾', '# AGENTS\n\n规矩。\n\n'],
  ['F4 不以换行结尾', '# AGENTS\n规矩。'],
  ['F4b 只有一个尾换行', '# AGENTS\n\n规矩。\n'],
]) {
  const a = spliceBlock(src, L0)
  const s = stripBlock(a.text)
  check(`${name} → 摘块后逐字节还原`, s.text === src && s.removed, `sep=${a.sep} 还原=${s.text === src}`)
}

// ── F5 CRLF：块必须跟文件同一种换行 ────────────────────────────
{
  const src = '# AGENTS\r\n\r\n规矩。\r\n'
  const a = spliceBlock(src, L0)
  const blockSlice = a.text.slice(a.text.indexOf('<!-- macro-memory:begin'), a.text.indexOf('<!-- macro-memory:end'))
  const s = stripBlock(a.text)
  check('F5 CRLF 文件：块内也是 CRLF（git diff 不该整文件翻红），摘完逐字节还原',
    detectEol(src) === '\r\n' && !/[^\r]\n/.test(blockSlice) && s.text === src,
    `EOL=${JSON.stringify(detectEol(src))}`)
}

// ── F6 坏块：begin 在、end 不在 → 原样不动 + 报 broken ────────────
{
  const src = '# AGENTS\n<!-- macro-memory:begin sep="1" v="1" -->\n半块（用户手改坏了）\n'
  const s = stripBlock(src)
  check('F6 坏块：不擅自删，原样不动并报 broken（让 CLI 去说人话）',
    s.broken === true && s.text === src && s.removed === false)
}

// ── F7 块在中间：只碰自己，前后用户内容逐字不变 ──────────────────
{
  const head = '# 前半\n\n用户写的。\n\n'
  const tail = '\n\n# 后半\n\n也有用户内容。\n'
  const seeded = `${head}<!-- macro-memory:begin sep="2" v="1" -->\n旧块\n<!-- macro-memory:end -->${tail}`
  const a = spliceBlock(seeded, L0)
  const ok = a.text.startsWith(head) && a.text.endsWith(tail) && a.action === 'replaced' && a.text.includes('先查再写')
  check('F7 块在中间：原地替换，前后用户内容逐字不变', ok, `action=${a.action}`)
}

// ── F8 定位信息够用：sep / version / 区间都能读出来 ──────────────
{
  const src = '<!-- macro-memory:begin sep="1" v="1" -->\nX\n<!-- macro-memory:end -->\n'
  const L = locate(src)
  check('F8 定位：sep、version、区间都对，且不 broken',
    L && L.sep === 1 && L.version === 1 && L.broken === false && src.slice(L.start, L.end).endsWith('<!-- macro-memory:end -->'),
    JSON.stringify({ sep: L?.sep, version: L?.version }))
}

// ── F9 CLI 端到端：uninstall 不装引擎也要能把文件摘回原样 ─────────
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-fence-'))
  const p = path.join(dir, 'AGENTS.md')
  const src = '# 用户原文\n\n两行。\n\n'
  fs.writeFileSync(p, src, 'utf8')
  fs.writeFileSync(p, spliceBlock(src, L0).text, 'utf8') // 等价于 init --agents 写完
  const r = spawnSync(process.execPath, [BIN, 'uninstall', '--file', p], { encoding: 'utf8' })
  const back = fs.readFileSync(p, 'utf8')
  check('F9 CLI uninstall 端到端：不用装配引擎，摘完逐字节还原',
    r.status === 0 && back === src, `exit=${r.status} 还原=${back === src}`)
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}

// ── F10 帮助里能看见这三条命令，否则等于没做 ────────────────────
{
  const r = spawnSync(process.execPath, [BIN, '--help'], { encoding: 'utf8' })
  const help = r.stdout ?? ''
  check('F10 --help 里有 refresh / uninstall / --file（发现不了的功能等于不存在）',
    r.status === 0 && help.includes('refresh') && help.includes('uninstall') && help.includes('--file'))
}

console.log(`\n${pass} PASS / ${fail} FAIL`)
process.exit(fail === 0 ? 0 : 1)
