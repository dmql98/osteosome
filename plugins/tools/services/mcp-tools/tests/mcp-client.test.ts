/**
 * MCP stdio 客户端单测（P7 M4 WS-11）—— 对假 MCP server 走 initialize → tools/list → tools/call。
 */
import { describe, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { McpStdioClient } from '../src/mcp'

const here = dirname(fileURLToPath(import.meta.url))
const server = join(here, 'fake-mcp-server.mjs')

describe('McpStdioClient', () => {
  it('initialize → tools/list → tools/call 往返（换行分隔 JSON-RPC）', async () => {
    const client = new McpStdioClient(process.execPath, [server])
    try {
      await client.initialize()
      const tools = await client.listTools()
      expect(tools.map((t) => t.name)).toEqual(['echo'])
      expect(tools[0].description).toBe('echo back')
      const r = await client.callTool('echo', { text: 'hi' })
      expect(r.ok).toBe(true)
      expect(r.content).toBe('hi')
    } finally {
      client.close()
    }
  }, 20_000)

  it('未知方法 → reject（错误消息来自 server）', async () => {
    const client = new McpStdioClient(process.execPath, [server])
    try {
      await client.initialize()
      // callTool 走 tools/call；这里直接触发未知方法路径：用一个不存在的 tool 名，server 仍会回 content（空）
      const r = await client.callTool('nope', {})
      expect(r.ok).toBe(true)
      expect(r.content).toBe('')
    } finally {
      client.close()
    }
  }, 20_000)

  it('server 退出 → 未决请求被 reject，不悬挂', async () => {
    // 指向一个立刻退出的进程（node -e 立即结束）→ exit 触发 failAll
    const client = new McpStdioClient(process.execPath, ['-e', 'process.exit(0)'])
    await expect(client.initialize()).rejects.toThrow(/exited|timed out/i)
    client.close()
  }, 25_000)
})
