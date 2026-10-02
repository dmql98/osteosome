/**
 * openai 兼容 wire 翻译层（P7）—— 供 `llm-provider-openai` / `-deepseek` / `-openrouter` 共用。
 *
 * 为什么上移 shared：三家 provider 的 wire 完全同构（`chat/completions` + `choices[].delta`），
 * 翻译规则只写一份。放在任一 provider 包里会让另两家 import 兄弟包，违反
 * 「provider 不相互 import」纪律（同 P2 把 `StreamChunk` 上移 shared 的理由）。
 *
 * 纪律：**中立协议 ↔ wire 的差异只允许出现在本文件与各 provider 的 `provider.ts`**，
 * 上层（主位 / loop / 前端）只见 `ChatMessage.toolCalls` / `ChatMessage.toolCallId`。
 */
import type { ToolSpec } from './types'

/** openai 兼容消息（wire 形状） */
export interface WireMessage {
  role: string
  content: string
  tool_call_id?: string
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[]
}

/**
 * 中立消息 → openai wire。
 *
 * 两处必翻（不翻则上游 400）：
 * - `role:'tool'` → `tool_call_id`（对应 assistant 发起的调用）
 * - `role:'assistant'` 且带 `toolCalls` → `tool_calls[]`（否则模型看不到自己上一轮要调什么）
 */
export function toWireMessages(
  messages: {
    role: string
    content: string
    toolCallId?: string
    toolCalls?: { id: string; name: string; arguments: string }[]
  }[],
): WireMessage[] {
  return messages.map((m) => {
    if (m.role === 'tool') {
      return { role: 'tool', content: m.content, tool_call_id: m.toolCallId ?? '' }
    }
    if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
      return {
        role: 'assistant',
        content: m.content,
        tool_calls: m.toolCalls.map((c) => ({
          id: c.id,
          type: 'function' as const,
          function: { name: c.name, arguments: c.arguments },
        })),
      }
    }
    return { role: m.role, content: m.content }
  })
}

/** 中立工具定义 → openai 兼容 `{ type:'function', function:{...} }` */
export function toWireTools(tools: ToolSpec[] | undefined): unknown[] | undefined {
  if (!tools || tools.length === 0) return undefined
  return tools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters ?? { type: 'object', properties: {} },
    },
  }))
}