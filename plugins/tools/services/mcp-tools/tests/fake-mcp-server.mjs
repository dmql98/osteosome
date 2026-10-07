// 假 MCP server（stdio，换行分隔 JSON-RPC）—— 测试用：initialize / tools/list / tools/call
import readline from 'node:readline'

const rl = readline.createInterface({ input: process.stdin })
const send = (o) => process.stdout.write(`${JSON.stringify(o)}\n`)

rl.on('line', (line) => {
  let msg
  try {
    msg = JSON.parse(line)
  } catch {
    return
  }
  if (msg.method === 'initialize') {
    send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1' } } })
  } else if (msg.method === 'notifications/initialized') {
    // 通知无响应
  } else if (msg.method === 'tools/list') {
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: { tools: [{ name: 'echo', description: 'echo back', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } }] },
    })
  } else if (msg.method === 'tools/call') {
    send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: String(msg.params?.arguments?.text ?? '') }] } })
  } else if (msg.id !== undefined) {
    send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'method not found' } })
  }
})
