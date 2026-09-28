/**
 * StreamChunk —— 中立流协议（唯一真相源，P2 WS-1 上移自 `services/llm/src/chunk.ts`）。
 *
 * 块化三段式（block-start / delta / block-end / finish），服务内部契约（provider ↔ 主位）；
 * 前端继续收 `llm.token.streamed`，块结构不出 wire（§3.1 映射）。
 *
 * - 块**自带完整边界信息**，不依赖调用方拼装。
 * - `finish` 块是唯一终块：缺 `finishReason` 一律拒绝（见 {@link isFinishBlock}）。
 */
import type { BlockType, FinishReason, StreamError, Usage } from './types'

export type { BlockType, FinishReason, StreamError, Usage }

export type StreamChunk =
  | {
      kind: 'block-start'
      id: string
      blockType: BlockType
      /** 该块在本次流中的序号（blockType 无关，递增） */
      index: number
    }
  | {
      kind: 'delta'
      id: string
      blockType: Exclude<BlockType, 'tool_call'>
      text: string
    }
  | {
      kind: 'tool-arg-delta'
      id: string
      blockType: 'tool_call'
      /** 工具名；首块携带，后续为 null */
      name: string | null
      /** 原始 JSON 透传（不解析、不变形），完整边界信息由调用方拼装 */
      arguments: string
    }
  | {
      kind: 'block-end'
      id: string
      blockType: BlockType
    }
  | {
      kind: 'finish'
      finishReason: FinishReason
      usage?: Usage
      error?: StreamError
    }

/** 判别函数：块类型收窄 */
export function isFinishBlock(chunk: StreamChunk): chunk is Extract<StreamChunk, { kind: 'finish' }> {
  return chunk.kind === 'finish'
}

export function isBlockStart(chunk: StreamChunk): chunk is Extract<StreamChunk, { kind: 'block-start' }> {
  return chunk.kind === 'block-start'
}

export function isDelta(chunk: StreamChunk): chunk is Extract<StreamChunk, { kind: 'delta' }> {
  return chunk.kind === 'delta'
}

export function isToolArgDelta(chunk: StreamChunk): chunk is Extract<StreamChunk, { kind: 'tool-arg-delta' }> {
  return chunk.kind === 'tool-arg-delta'
}

export function isBlockEnd(chunk: StreamChunk): chunk is Extract<StreamChunk, { kind: 'block-end' }> {
  return chunk.kind === 'block-end'
}

/** 终块校验：`finish` 块缺 `finishReason` 一律拒绝（构造与解析两侧共用） */
export function validateFinishBlock(
  chunk: unknown,
): chunk is Extract<StreamChunk, { kind: 'finish' }> {
  if (chunk === null || typeof chunk !== 'object') return false
  const c = chunk as Record<string, unknown>
  if (c.kind !== 'finish') return false
  const reason = c.finishReason
  const allowed: readonly FinishReason[] = ['stop', 'length', 'content_filter', 'tool_calls', 'error']
  return typeof reason === 'string' && (allowed as readonly string[]).includes(reason)
}
