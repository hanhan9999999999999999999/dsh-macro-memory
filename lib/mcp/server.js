/**
 * mcp/server —— 把 8 个 memory_* 工具按 Model Context Protocol 暴露出去。
 *
 * 为什么手写而不引 @modelcontextprotocol/sdk：这个包的安装判据是「不装编译链、不加依赖」。
 * MCP 的 stdio 传输就是「一行一个 JSON-RPC 2.0 报文」，实现它不到两百行；换一个
 * 会跟着升级、会带依赖的 SDK 进来，不划算。协议细节按 2024-11-05 与 2025-06-18 两版
 * 对齐（两者在 initialize / tools 上兼容）。
 *
 * 三条纪律：
 *   1. **stdout 只准出协议报文**。任何日志、警告、进度都走 stderr——MCP 客户端会
 *      因为一行杂音把整条连接判成坏掉。
 *   2. **单个请求失败不许拖垮连接**。工具抛错 → 包成 isError:true 的结果返回；
 *      只有「报文本身不是 JSON-RPC」才回 error 对象。
 *   3. **不主动发通知**。没有「有新记忆」这类推送（那需要订阅语义，宿主支持程度也参差）。
 */

import readline from 'node:readline'

/** 我们实现的协议版本；客户端给的版本在我们列表里就照它回，否则回最新的。 */
const SUPPORTED_PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05']
const LATEST_PROTOCOL = SUPPORTED_PROTOCOLS[0]

const ERR_PARSE = -32700
const ERR_INVALID_REQUEST = -32600
const ERR_METHOD_NOT_FOUND = -32601
const ERR_INVALID_PARAMS = -32602
const ERR_INTERNAL = -32603

/**
 * 起一个 stdio 服务器。
 *
 * @param {object} opts
 * @param {object} opts.engine          createMacroEngine() 的返回值
 * @param {string} [opts.version]       自报版本号
 * @param {string} [opts.name]          自报名字
 * @param {NodeJS.ReadableStream} [opts.input]
 * @param {NodeJS.WritableStream} [opts.output]
 * @param {(line:string)=>void} [opts.log] 调试日志（写 stderr）
 * @param {string} [opts.cwd]          默认工作区：宿主不在 tools/call 里带 cwd 时用它。
 *   MCP 子进程的 process.cwd() 是宿主自己的目录（Codex 每个对话一个新目录），
 *   不传这个，库就会落在宿主临时目录下的空库里——`mcp --cwd DIR` 就是给它兜底的。
 */
export async function serveStdio(opts) {
  const engine = opts.engine
  const version = opts.version ?? '0.0.0'
  const name = opts.name ?? 'macro-memory'
  const input = opts.input ?? process.stdin
  const output = opts.output ?? process.stdout
  const log = typeof opts.log === 'function' ? opts.log : () => {}
  // 默认工作区：宿主没带 cwd 时用它（见 opts.cwd 的说明）
  const defaultCwd = typeof opts.cwd === 'string' && opts.cwd.length > 0 ? opts.cwd : undefined

  const send = (obj) => {
    try {
      output.write(`${JSON.stringify(obj)}\n`)
    } catch (err) {
      log(`写 stdout 失败：${err?.message ?? err}`)
    }
  }
  const reply = (id, result) => send({ jsonrpc: '2.0', id, result })
  const fail = (id, code, message, data) => {
    const error = { code, message }
    if (data !== undefined) error.data = data
    send({ jsonrpc: '2.0', id, error })
  }

  const rl = readline.createInterface({ input, crlfDelay: Infinity })
  let closed = false
  // 客户端名字（initialize 的 clientInfo.name）：多 agent 共用一个库时，这就是「谁写的」。
  // 记不到就退回 'mcp'——归属宁可是粗的，也不要编一个具体名字。
  let clientName = ''

  const shutdown = async () => {
    if (closed) return
    closed = true
    try {
      rl.close()
    } catch {
      /* 已经关了 */
    }
    try {
      await engine.close?.()
    } catch (err) {
      log(`关闭引擎失败：${err?.message ?? err}`)
    }
  }
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.once(sig, () => {
      void shutdown().then(() => process.exit(0))
    })
  }

  /** 处理一条报文。返回 false 表示「该退了」。 */
  async function handle(msg) {
    if (msg === null || typeof msg !== 'object' || Array.isArray(msg)) {
      fail(null, ERR_INVALID_REQUEST, '报文必须是 JSON-RPC 对象')
      return
    }
    const { id, method, params } = msg
    const isNotification = id === undefined || id === null
    if (typeof method !== 'string') {
      if (!isNotification) fail(id, ERR_INVALID_REQUEST, '缺少 method')
      return
    }

    // 通知一律不回包（MCP 的 notifications/* 都是单向的）
    if (isNotification) {
      log(`通知：${method}`)
      return
    }

    switch (method) {
      case 'initialize': {
        const asked = typeof params?.protocolVersion === 'string' ? params.protocolVersion : ''
        const protocolVersion = SUPPORTED_PROTOCOLS.includes(asked) ? asked : LATEST_PROTOCOL
        const info = params?.clientInfo
        clientName = typeof info?.name === 'string' ? info.name.trim().slice(0, 64) : ''
        if (clientName !== '') log(`客户端：${clientName}${typeof info?.version === 'string' ? ` ${info.version}` : ''}`)
        reply(id, {
          protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name, version },
          instructions: engine.injection({ maxChars: 1200 }),
        })
        return
      }
      case 'ping':
        reply(id, {})
        return
      case 'tools/list':
        reply(id, {
          tools: engine.tools.map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.parameters ?? { type: 'object', properties: {} },
          })),
        })
        return
      case 'tools/call': {
        const toolName = params?.name
        if (typeof toolName !== 'string' || toolName.length === 0) {
          fail(id, ERR_INVALID_PARAMS, 'tools/call 缺少 name')
          return
        }
        if (!engine.def(toolName)) {
          fail(id, ERR_INVALID_PARAMS, `没有这个工具：${toolName}`, { available: engine.tools.map((t) => t.name) })
          return
        }
        const args = params?.arguments ?? {}
        const cwd = typeof params?.cwd === 'string' ? params.cwd : defaultCwd
        try {
          const out = await engine.call(toolName, args, { cwd, agentId: clientName !== '' ? clientName : 'mcp' })
          const result = { content: [{ type: 'text', text: out.text }] }
          if (out.refused === true) result.isError = true
          reply(id, result)
        } catch (err) {
          // 工具自身的错误也走 result（isError），而不是 JSON-RPC error：
          // 前者模型看得见正文，后者会被客户端当成协议故障。
          reply(id, { content: [{ type: 'text', text: String(err?.message ?? err) }], isError: true })
        }
        return
      }
      // MCP 里这些是可选能力：明确回「没实现方法」，别装死
      case 'resources/list':
        reply(id, { resources: [] })
        return
      case 'prompts/list':
        reply(id, { prompts: [] })
        return
      case 'logging/setLevel':
        reply(id, {})
        return
      default:
        fail(id, ERR_METHOD_NOT_FOUND, `没实现这个方法：${method}`)
    }
  }

  let queue = Promise.resolve()
  rl.on('line', (line) => {
    const text = line.trim()
    if (text.length === 0) return
    let msg
    try {
      msg = JSON.parse(text)
    } catch {
      fail(null, ERR_PARSE, '不是合法 JSON')
      return
    }
    // 串行处理：MCP 客户端可能并发发请求，但写库必须一条一条来
    queue = queue.then(() => handle(msg)).catch((err) => {
      log(`处理失败：${err?.stack ?? err}`)
      fail(msg?.id ?? null, ERR_INTERNAL, String(err?.message ?? err))
    })
  })

  await new Promise((resolve) => {
    rl.on('close', resolve)
  })
  await queue
  await shutdown()
}
