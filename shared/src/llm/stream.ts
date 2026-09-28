/**
 * SSE wire → 归一化 JSON 事件流（唯一真相源，P2 WS-1 上移自 `services/llm/src/stream.ts`）。
 *
 * - 逐行解析 `data: {...}`；CRLF / 连续空行兼容；行尾残留缓冲。
 * - 截断（非 JSON）行忽略；非 `data:` 前缀（event:/id:/注释）忽略。
 * - `data: [DONE]` → `{ done: true }` 信号（不抛错）。
 */
export interface SseEvent {
  data: unknown
  done: boolean
}

/** 归一化：读 Web ReadableStream（fetch body）→ 逐事件 yield */
export async function* readSseJson(
  body: ReadableStream<Uint8Array> | null,
  opts: { signal?: AbortSignal } = {},
): AsyncGenerator<SseEvent, void, void> {
  if (!body) return
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    for (;;) {
      if (opts.signal?.aborted) return
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let idx: number
      while ((idx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, idx).replace(/\r$/, '')
        buffer = buffer.slice(idx + 1)
        const event = parseSseLine(line)
        if (event) yield event
      }
    }
    buffer += decoder.decode()
    if (buffer.trim() !== '') {
      const event = parseSseLine(buffer.replace(/\r$/, ''))
      if (event) yield event
    }
  } finally {
    reader.releaseLock()
  }
}

function parseSseLine(line: string): SseEvent | null {
  // SSE 规范：`data:` 后可带一个空格；OpenAI 兼容 wire 常发 `data: {...}`
  if (!line.startsWith('data:')) return null
  const payload = line.slice(5).replace(/^ /, '')
  if (payload === '[DONE]') return { data: '[DONE]', done: true }
  try {
    return { data: JSON.parse(payload), done: false }
  } catch {
    // 截断 / 非 JSON data 行 —— 忽略（P2 §4 stream 测试矩阵）
    return null
  }
}
