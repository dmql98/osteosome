/**
 * 历史组装（P3 WS-3 + P7 扩展）—— 纯函数：会话历史 + system prompt → 多轮 messages。
 *
 * 截断策略（P3 §6 保守 + P7 修正）：
 * - 保留首条 system（由 `prompt` 参数置首，不来自历史）；
 * - 保留最近 `maxMessages` 条历史（user/assistant/tool），更早的丢弃；
 * - **P7：截断点必须落在 user 边界**——openai 兼容上游对「孤立 tool 消息」直接 400
 *   （tool 消息必须紧跟发起它的 assistant.tool_calls），故截断后向前找到第一条 user 再切。
 * - 过滤掉 role 不在集合内的脏数据（P7 起集合含 tool）。
 */
import type { ToolCall } from '@osteosome/shared'
import type { ChatTurn } from './core'

export interface HistoryMessage {
  id?: string
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  /** role:'tool'：对应 assistant.toolCalls[].id（P7） */
  toolCallId?: string
  /** role:'assistant'：本条发起的工具调用（P7） */
  toolCalls?: ToolCall[]
}

export const DEFAULT_MAX_MESSAGES = 20

const VALID_ROLES = new Set(['user', 'assistant', 'tool', 'system'])

/** 组装多轮 messages：system 置首 + 截断后的历史（含 P7 工具轮） */
export function buildMessages(
  history: HistoryMessage[],
  systemPrompt: string,
  maxMessages: number = DEFAULT_MAX_MESSAGES,
): ChatTurn[] {
  const cleaned = history.filter(
    (m): m is HistoryMessage => VALID_ROLES.has(m.role) && typeof m.content === 'string',
  )
  // 历史里的 system 丢弃（system 统一由 prompt 参数提供，避免重复注入）
  const turns = cleaned.filter((m) => m.role === 'user' || m.role === 'assistant' || m.role === 'tool')
  const trimmed = trimToUserBoundary(turns, maxMessages)
  return [
    { role: 'system', content: systemPrompt },
    ...trimmed.map((m) => ({
      role: m.role,
      content: m.content,
      ...(m.toolCallId ? { toolCallId: m.toolCallId } : {}),
      ...(m.toolCalls && m.toolCalls.length > 0 ? { toolCalls: m.toolCalls } : {}),
    })),
  ]
}

/**
 * 截断到 `maxMessages` 条，并把起点对齐到 user 边界（P7）。
 *
 * 为什么必须对齐：一次工具轮在历史里是 `assistant(tool_calls) → tool → tool → …`，
 * 从中间切开会留下没有 tool_calls 的孤立 tool 消息，上游 400。
 * 若整段历史里没有 user（异常数据），退化为原样截断（宁可 400 也不要静默丢整段）。
 */
export function trimToUserBoundary(turns: HistoryMessage[], maxMessages: number): HistoryMessage[] {
  if (maxMessages <= 0 || turns.length <= maxMessages) return turns
  let start = turns.length - maxMessages
  while (start < turns.length && turns[start].role !== 'user') start += 1
  return start >= turns.length ? turns.slice(turns.length - maxMessages) : turns.slice(start)
}