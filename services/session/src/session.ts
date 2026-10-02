/**
 * 会话聚合逻辑（P3 WS-1）—— 命令语义 + 结果构造（纯逻辑，可直测）。
 *
 * 七个命令（P3 §3.3）：
 * - `session.list`      → 列表
 * - `session.get`       → 单会话全文（不存在 → null，不抛）
 * - `session.create`    → 新建
 * - `session.rename`    → 重命名
 * - `session.delete`    → 删除
 * - `session.clear`     → 清空全部
 * - `message.append`    → 追加消息
 *
 * 结果约定：命令 topic + `<cmd>.result` 响应 topic，靠 `requestId` 关联；
 * 缺字段/不存在 → `*.result` 携带 `error: { code, message }`（不吞静默）。
 */
import type { Message, MessageRole, SessionFile, SessionMeta } from './store'
import { SessionStore } from './store'

/** 命令结果形状（`{ requestId, ... }`，成功带数据、失败带 error） */
export interface CommandResult {
  requestId: string
  error?: { code: string; message: string }
  [key: string]: unknown
}

const CODE_INVALID = 'invalid_request'
const CODE_NOT_FOUND = 'not_found'

function err(requestId: string, code: string, message: string): CommandResult {
  return { requestId, error: { code, message } }
}

function str(payload: Record<string, unknown>, key: string): string {
  return typeof payload[key] === 'string' ? (payload[key] as string) : ''
}

/** 派发一条 session 命令 → 结果（不含发布动作，发布在 index.ts） */
export function dispatch(store: SessionStore, topic: string, payload: Record<string, unknown>): CommandResult {
  const requestId = str(payload, 'requestId')

  switch (topic) {
    case 'session.list':
      return { requestId, sessions: store.list() }

    case 'session.get': {
      const sessionId = str(payload, 'sessionId')
      if (!sessionId) return err(requestId, CODE_INVALID, 'session.get: sessionId is required')
      const file = store.get(sessionId)
      // 不存在/损坏 → null（P3 §3.3：null → 调用方回退最近会话）
      return { requestId, session: file }
    }

    case 'session.create': {
      const title = str(payload, 'title')
      const meta = store.create(title)
      return { requestId, sessionId: meta.id, title: meta.title }
    }

    case 'session.rename': {
      const sessionId = str(payload, 'sessionId')
      const title = str(payload, 'title')
      if (!sessionId || !title) return err(requestId, CODE_INVALID, 'session.rename: sessionId and title are required')
      const meta = store.rename(sessionId, title)
      if (!meta) return err(requestId, CODE_NOT_FOUND, `session.rename: no session '${sessionId}'`)
      return { requestId, sessionId: meta.id, title: meta.title }
    }

    case 'session.delete': {
      const sessionId = str(payload, 'sessionId')
      if (!sessionId) return err(requestId, CODE_INVALID, 'session.delete: sessionId is required')
      if (!store.remove(sessionId)) return err(requestId, CODE_NOT_FOUND, `session.delete: no session '${sessionId}'`)
      return { requestId, sessionId }
    }

    case 'session.clear': {
      const deletedCount = store.clear()
      return { requestId, deletedCount }
    }

    case 'message.append': {
      const sessionId = str(payload, 'sessionId')
      const message = payload.message as
        | { role?: string; content?: string; id?: string; toolCallId?: string; toolName?: string; toolCalls?: unknown }
        | undefined
      if (!sessionId || !message || typeof message.content !== 'string') {
        return err(requestId, CODE_INVALID, 'message.append: sessionId and message.content are required')
      }
      // P7：role 增 'tool'（工具结果回填）；其余非法值仍回落 user（宽容解析）
      const role: MessageRole =
        message.role === 'assistant' || message.role === 'system' || message.role === 'tool'
          ? message.role
          : 'user'
      const toolCalls = Array.isArray(message.toolCalls)
        ? (message.toolCalls as { id: string; name: string; arguments: string }[]).filter(
            (t) => t && typeof t.id === 'string' && typeof t.name === 'string',
          )
        : undefined
      const appended = store.appendMessage(sessionId, {
        role,
        content: message.content,
        ...(message.id ? { id: message.id } : {}),
        ...(typeof message.toolCallId === 'string' && message.toolCallId ? { toolCallId: message.toolCallId } : {}),
        ...(typeof message.toolName === 'string' && message.toolName ? { toolName: message.toolName } : {}),
        ...(toolCalls && toolCalls.length > 0 ? { toolCalls } : {}),
      })
      if (!appended) return err(requestId, CODE_NOT_FOUND, `message.append: no session '${sessionId}'`)
      return { requestId, sessionId, message: appended }
    }

    default:
      return err(requestId, CODE_INVALID, `unknown command '${topic}'`)
  }
}
