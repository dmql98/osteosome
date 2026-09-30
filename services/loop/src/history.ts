/**
 * 历史组装（P3 WS-3）—— 纯函数：会话历史 + system prompt → 多轮 messages。
 *
 * 截断策略（P3 §6 保守）：
 * - 保留首条 system（由 `prompt` 参数置首，不来自历史）；
 * - 保留最近 `maxMessages` 条历史（user/assistant），更早的丢弃；
 * - 过滤掉历史里 role 非 system/user/assistant 的脏数据（P3 只这三类）。
 */

export interface HistoryMessage {
  id?: string
  role: 'system' | 'user' | 'assistant'
  content: string
}

export const DEFAULT_MAX_MESSAGES = 20

/** 组装多轮 messages：system 置首 + 截断后的历史 */
export function buildMessages(
  history: HistoryMessage[],
  systemPrompt: string,
  maxMessages: number = DEFAULT_MAX_MESSAGES,
): { role: 'system' | 'user' | 'assistant'; content: string }[] {
  const cleaned = history.filter(
    (m): m is HistoryMessage =>
      (m.role === 'user' || m.role === 'assistant' || m.role === 'system') && typeof m.content === 'string',
  )
  // 历史里的 system 丢弃（system 统一由 prompt 参数提供，避免重复注入）
  const turns = cleaned.filter((m) => m.role === 'user' || m.role === 'assistant')
  const trimmed = maxMessages > 0 && turns.length > maxMessages ? turns.slice(turns.length - maxMessages) : turns
  return [
    { role: 'system', content: systemPrompt },
    ...trimmed.map((m) => ({ role: m.role, content: m.content })),
  ]
}
