/**
 * MCP stdio 客户端（P7 M4 WS-11）—— JSON-RPC 2.0，换行分隔（MCP stdio transport）。
 *
 * 只做三件事：`initialize` → `tools/list` → `tools/call`。
 * 子进程生命周期由此处掌握：`close()` **杀进程**（删除 server / 插件被 kill 后不能留泄漏）。
 */
import { spawn, type ChildProcess } from 'node:child_process'

export interface McpTool {
  name: string
  description?: string
  inputSchema?: Record<string, unknown>
}

interface Pending {
  resolve: (v: unknown) => void
  reject: (e: Error) => void
  timer: NodeJS.Timeout
}

const REQUEST_TIMEOUT_MS = 15_000

export class McpStdioClient {
  private readonly child: ChildProcess
  private buf = ''
  private nextId = 1
  private readonly pending = new Map<number, Pending>()
  private closed = false

  constructor(
    command: string,
    args: readonly string[],
    private readonly onClose?: () => void,
  ) {
    this.child = spawn(command, [...args], { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true })
    this.child.stdout?.setEncoding('utf8')
    this.child.stdout?.on('data', (chunk: string) => this.absorb(chunk))
    this.child.on('exit', () => this.failAll(new Error('MCP server exited')))
    this.child.on('error', (err) => this.failAll(err instanceof Error ? err : new Error(String(err))))
  }

  private absorb(chunk: string): void {
    this.buf += chunk
    let nl = this.buf.indexOf('\n')
    while (nl >= 0) {
      const line = this.buf.slice(0, nl).trim()
      this.buf = this.buf.slice(nl + 1)
      if (line !== '') this.handleLine(line)
      nl = this.buf.indexOf('\n')
    }
  }

  private handleLine(line: string): void {
    let msg: { id?: number; result?: unknown; error?: { message?: string } }
    try {
      msg = JSON.parse(line) as typeof msg
    } catch {
      return // 忽略非 JSON 行
    }
    if (typeof msg.id !== 'number') return
    const p = this.pending.get(msg.id)
    if (!p) return
    this.pending.delete(msg.id)
    clearTimeout(p.timer)
    if (msg.error) p.reject(new Error(msg.error.message ?? 'MCP error'))
    else p.resolve(msg.result)
  }

  private failAll(err: Error): void {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer)
      p.reject(err)
    }
    this.pending.clear()
    if (this.closed) return
    this.closed = true
    this.onClose?.()
  }

  private request<T>(method: string, params: unknown): Promise<T> {
    if (this.closed) return Promise.reject(new Error('MCP client closed'))
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`MCP request '${method}' timed out`))
      }, REQUEST_TIMEOUT_MS)
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer })
      this.child.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    })
  }

  private notify(method: string, params: unknown): void {
    this.child.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`)
  }

  async initialize(): Promise<void> {
    await this.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'osteosome', version: '1.0.0' },
    })
    this.notify('notifications/initialized', {})
  }

  async listTools(): Promise<McpTool[]> {
    const res = await this.request<{ tools?: McpTool[] }>('tools/list', {})
    return Array.isArray(res.tools) ? res.tools : []
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<{ ok: boolean; content: string }> {
    const res = await this.request<{ content?: { type?: string; text?: string }[]; isError?: boolean }>('tools/call', {
      name,
      arguments: args,
    })
    const text = (res.content ?? []).map((c) => c.text ?? '').join('\n')
    return { ok: res.isError !== true, content: text }
  }

  /** 杀进程组（stdio 子进程可能又拉了孙子进程） */
  close(): void {
    this.closed = true
    try {
      this.child.kill()
      // Windows 上杀进程树
      if (process.platform === 'win32' && this.child.pid) {
        spawn('taskkill', ['/PID', String(this.child.pid), '/T', '/F'], { windowsHide: true }).unref?.()
      }
    } catch {
      /* 已退出 */
    }
  }
}
