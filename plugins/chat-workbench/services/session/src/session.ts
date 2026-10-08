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

/** `session.get` 分页缺省与上限（P3-1 M3）：缺省 50，上限防调用方传 100000。 */
const DEFAULT_PAGE_LIMIT = 50
const MAX_PAGE_LIMIT = 500

/** 解析 `limit`：非法/缺省 → 50；上限 500。 */
function parsePageLimit(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return DEFAULT_PAGE_LIMIT
  return Math.min(Math.floor(raw), MAX_PAGE_LIMIT)
}

/** 中立 finishReason 白名单（与 shared 的 FinishReason 同枚举）；非法值丢弃而非乱存 */
const FINISH_REASONS: readonly NonNullable<Message['finishReason']>[] = [
  'stop',
  'length',
  'content_filter',
  'tool_calls',
  'error',
]

/** usage 宽容解析：两个字段都得是有限非负数，否则视为没有（不存半截） */
function parseUsage(raw: unknown): { promptTokens: number; completionTokens: number } | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const u = raw as { promptTokens?: unknown; completionTokens?: unknown }
  const ok = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0
  if (!ok(u.promptTokens) || !ok(u.completionTokens)) return undefined
  return { promptTokens: u.promptTokens, completionTokens: u.completionTokens }
}

function err(requestId: string, code: string, message: string): CommandResult {
  return { requestId, error: { code, message } }
}

function str(payload: Record<string, unknown>, key: string): string {
  return typeof payload[key] === 'string' ? (payload[key] as string) : ''
}

/** 角色 → 导出用的中文小标题 */
function roleLabel(role: MessageRole): string {
  return role === 'user' ? '用户' : role === 'assistant' ? '助手' : role === 'system' ? '系统' : '工具'
}

/**
 * 导出为 Markdown（P2-5）。纯函数 —— 只读 `SessionFile`，不碰 store。
 *
 * 思维链以引用块附在对应消息下（它是「这条回答为什么这么想」的一部分，导出时不该丢），
 * 工具调用列成列表。**不导出** finishReason / usage 这类内部元数据 —— 导出的是给人读的文本。
 */
export function toMarkdown(file: SessionFile): string {
  const lines: string[] = []
  lines.push(`# ${file.meta.title || '会话'}`)
  lines.push('')
  lines.push(`- id: ${file.meta.id}`)
  lines.push(`- created: ${file.meta.createdAt}`)
  lines.push(`- updated: ${file.meta.updatedAt}`)
  lines.push('')
  for (const m of file.messages) {
    lines.push(`## ${roleLabel(m.role)}`)
    if (m.reasoning) {
      lines.push('')
      lines.push('> 思考过程：')
      for (const rl of m.reasoning.split('\n')) lines.push(`> ${rl}`)
    }
    lines.push('')
    lines.push(m.content)
    if (m.toolCalls && m.toolCalls.length > 0) {
      lines.push('')
      for (const tc of m.toolCalls) lines.push(`- 调用工具 \`${tc.name}\`：\`${tc.arguments}\``)
    }
    if (m.toolName) {
      lines.push('')
      lines.push(`（工具结果：${m.toolName}）`)
    }
    lines.push('')
  }
  return lines.join('\n')
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
      // P3-1 M3：**恒分页** —— limit 缺省 50；before = 上一页的 nextCursor。
      const result = store.getPage(sessionId, {
        limit: parsePageLimit(payload.limit),
        ...(typeof payload.before === 'string' || typeof payload.before === 'number'
          ? { before: String(payload.before) }
          : {}),
      })
      // 不存在/会话为空 → session:null（调用方回退最近会话；不 error）
      if (!result) return { requestId, session: null }
      return { requestId, session: result.file, page: result.page }
    }

    case 'session.create': {
      const title = str(payload, 'title')
      // P2-3：可选 parentId（子代理子会话）。只认字符串；其余忽略（当顶层会话）
      const parentId = str(payload, 'parentId')
      const meta = store.create(title, parentId || undefined)
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

    case 'session.pin': {
      const sessionId = str(payload, 'sessionId')
      if (!sessionId) return err(requestId, CODE_INVALID, 'session.pin: sessionId is required')
      if (typeof payload.pinned !== 'boolean') return err(requestId, CODE_INVALID, 'session.pin: pinned (boolean) is required')
      const meta = store.setPinned(sessionId, payload.pinned)
      if (!meta) return err(requestId, CODE_NOT_FOUND, `session.pin: no session '${sessionId}'`)
      return { requestId, sessionId, pinned: meta.pinned === true }
    }

    case 'session.archive': {
      const sessionId = str(payload, 'sessionId')
      if (!sessionId) return err(requestId, CODE_INVALID, 'session.archive: sessionId is required')
      if (typeof payload.archived !== 'boolean') {
        return err(requestId, CODE_INVALID, 'session.archive: archived (boolean) is required')
      }
      const meta = store.setArchived(sessionId, payload.archived)
      if (!meta) return err(requestId, CODE_NOT_FOUND, `session.archive: no session '${sessionId}'`)
      return { requestId, sessionId, archived: meta.archived === true }
    }

    case 'session.set.workspace': {
      const sessionId = str(payload, 'sessionId')
      if (!sessionId) return err(requestId, CODE_INVALID, 'session.set.workspace: sessionId is required')
      const meta = store.setWorkspace(sessionId, {
        workspace: typeof payload.workspace === 'string' ? payload.workspace : undefined,
        addRoot: typeof payload.addRoot === 'string' ? payload.addRoot : undefined,
        removeRoot: typeof payload.removeRoot === 'string' ? payload.removeRoot : undefined,
      })
      if (!meta) return err(requestId, CODE_NOT_FOUND, `session.set.workspace: no session '${sessionId}'`)
      return { requestId, sessionId, workspace: meta.workspace ?? null, workspaces: meta.workspaces ?? [] }
    }

    case 'session.export': {
      const sessionId = str(payload, 'sessionId')
      if (!sessionId) return err(requestId, CODE_INVALID, 'session.export: sessionId is required')
      const file = store.get(sessionId)
      if (!file) return err(requestId, CODE_NOT_FOUND, `session.export: no session '${sessionId}'`)
      return {
        requestId,
        sessionId,
        filename: `${sessionId}.md`,
        content: toMarkdown(file),
      }
    }

    case 'session.clear': {
      const deletedCount = store.clear()
      return { requestId, deletedCount }
    }

    case 'message.append': {
      const sessionId = str(payload, 'sessionId')
      const message = payload.message as
        | {
            role?: string
            content?: string
            id?: string
            finishReason?: string
            usage?: unknown
            reasoning?: string
            toolCallId?: string
            toolName?: string
            toolCalls?: unknown
          }
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
      // S4：finishReason / usage / reasoning 原样透传。
      // 之前这三项在入参类型里根本没声明，`loop` 明明发了，落库时却被静默丢掉 ——
      // 表现是「刷新页面后不知道这一轮为什么停、用了多少 token」。
      const finishReason = FINISH_REASONS.includes(message.finishReason as NonNullable<Message['finishReason']>)
        ? (message.finishReason as NonNullable<Message['finishReason']>)
        : undefined
      const usage = parseUsage(message.usage)
      const reasoning = typeof message.reasoning === 'string' && message.reasoning ? message.reasoning : undefined
      const appended = store.appendMessage(sessionId, {
        role,
        content: message.content,
        ...(message.id ? { id: message.id } : {}),
        ...(finishReason ? { finishReason } : {}),
        ...(usage ? { usage } : {}),
        ...(reasoning ? { reasoning } : {}),
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
