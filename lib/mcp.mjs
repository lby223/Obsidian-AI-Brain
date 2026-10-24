/**
 * lib/mcp.mjs —— 一个极小的 MCP 客户端（stdio + streamable-http）
 * ============================================================================
 * 为什么不用 `@deepseek-ai/dsh-mcp-client`：那是个"把 MCP 挂成 dsh 工具"的完整插件，
 * 而我们要的是**插件内部自己起/连这个 MCP**（指定网站的登录、凭证、工具白名单都由我们管）。
 *
 * stdio 协议就三句话：`initialize` → `notifications/initialized` → `tools/call`，
 * 一行一个 JSON-RPC。
 * streamable-http 走 POST，带 `Accept: application/json, text/event-stream`，
 * 响应可能带 `Mcp-Session-Id` 头（记下来，后续请求带上）。
 * ============================================================================
 */
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'

const PKG = (() => { try { return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) } catch { return {} } })()

/** 通用 MCP 客户端：command=null 时走 streamable-http（url），否则走 stdio。 */
export class McpClient {
  constructor({ command = null, args = [], url = '', headers = {}, cwd, env, log = () => {} }) {
    this.cfg = { command, args, url, headers, cwd, env, log }
    this.proc = null
    this.buf = ''
    this.nextId = 1
    this.pending = new Map()
    this.stderr = ''
    this.sessionId = ''
    this.starting = null
  }

  get running() { return Boolean(this.proc || this.cfg.url) }

  async start() {
    if (this.cfg.url) return this.#startHttp()
    return this.#startStdio()
  }

  async #startStdio() {
    if (this.proc) return
    if (this.starting) return this.starting
    this.starting = (async () => {
      const { command, args, cwd, env, log } = this.cfg
      this.proc = spawn(command, args, {
        cwd,
        env: { ...process.env, ...(env || {}) },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      })
      this.proc.stdout.setEncoding('utf8')
      this.proc.stdout.on('data', (chunk) => this.#onData(chunk))
      this.proc.stderr.setEncoding('utf8')
      this.proc.stderr.on('data', (c) => { this.stderr = (this.stderr + c).slice(-4000) })
      this.proc.on('error', (e) => log(`MCP 子进程启动失败：${e?.message ?? e}`))
      this.proc.on('exit', (code) => {
        log(`MCP 子进程退出（code=${code}）`)
        for (const [, p] of this.pending) p.reject(new Error(`MCP 子进程退出（code=${code}）${this.stderr ? '：' + this.stderr.slice(-300) : ''}`))
        this.pending.clear()
        this.proc = null
      })
      await this.#request('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: PKG.name || 'dsh-ai-brain', version: PKG.version || '0.0.0' },
      })
      this.#notify('notifications/initialized', {})
      log('MCP 已就绪')
    })()
    try { await this.starting } finally { this.starting = null }
  }

  async #startHttp() {
    if (this.sessionId) return
    // streamable-http 的 initialize 本身就是握手，sessionId 由响应头带回
    await this.#request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: PKG.name || 'dsh-ai-brain', version: PKG.version || '0.0.0' },
    })
    this.#notify('notifications/initialized', {})
  }

  stop() {
    try { this.proc?.kill() } catch { /* 已经没了 */ }
    this.proc = null
  }

  /** 调一个 MCP 工具：能解析成 JSON 就返回对象，否则返回字符串 */
  async call(name, args = {}, { timeoutMs = 180000 } = {}) {
    await this.start()
    const result = await this.#request('tools/call', { name, arguments: args }, timeoutMs)
    const text = (result?.content ?? []).map((c) => c?.text ?? '').join('\n').trim()
    if (result?.isError) throw new Error(text || `MCP 工具 ${name} 报错`)
    try { return text ? JSON.parse(text) : {} } catch { return text }
  }

  /** 列出远端工具名（用于白名单校验/调试） */
  async listTools({ timeoutMs = 60000 } = {}) {
    await this.start()
    const result = await this.#request('tools/list', {}, timeoutMs)
    return (result?.tools ?? []).map((t) => t?.name).filter(Boolean)
  }

  #onData(chunk) {
    this.buf += chunk
    let idx
    while ((idx = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, idx).trim()
      this.buf = this.buf.slice(idx + 1)
      if (!line) continue
      let msg
      try { msg = JSON.parse(line) } catch { continue }
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id)
        this.pending.delete(msg.id)
        if (msg.error) p.reject(new Error(msg.error?.message ? String(msg.error.message) : JSON.stringify(msg.error)))
        else p.resolve(msg.result)
      }
    }
  }

  #send(obj) {
    if (this.cfg.url) { this.#sendHttp(obj); return }
    if (!this.proc?.stdin?.writable) throw new Error('MCP 子进程不在运行')
    this.proc.stdin.write(JSON.stringify(obj) + '\n')
  }

  async #sendHttp(obj) {
    const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(this.cfg.headers || {}) }
    if (this.sessionId) headers['mcp-session-id'] = this.sessionId
    const r = await fetch(this.cfg.url, { method: 'POST', headers, body: JSON.stringify(obj) })
    const sid = r.headers.get('mcp-session-id')
    if (sid) this.sessionId = sid
    const text = await r.text()
    // SSE 可能包一层 "event: message\ndata: {…}"；取最后一个 data: 行
    const lines = text.split(/\r?\n/)
    const dataLine = [...lines].reverse().find((l) => l.startsWith('data:'))
    const body = dataLine ? dataLine.slice(5).trim() : text.trim()
    let msg
    try { msg = JSON.parse(body) } catch { msg = {} }
    if (msg.id !== undefined && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id)
      this.pending.delete(msg.id)
      if (msg.error) p.reject(new Error(msg.error?.message ? String(msg.error.message) : JSON.stringify(msg.error)))
      else p.resolve(msg.result)
    }
  }

  #notify(method, params) { this.#send({ jsonrpc: '2.0', method, params }) }

  #request(method, params, timeoutMs = 60000) {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`MCP ${method} 超时（${timeoutMs}ms）${this.stderr ? '：' + this.stderr.slice(-200) : ''}`))
      }, timeoutMs)
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v) },
        reject: (e) => { clearTimeout(timer); reject(e) },
      })
      try { this.#send({ jsonrpc: '2.0', id, method, params }) } catch (e) {
        clearTimeout(timer); this.pending.delete(id); reject(e)
      }
    })
  }
}
