/**
 * 事件契约 —— Core / 服务 / 前端共享的唯一真相源（RFC §5，P1a 首批）。
 *
 * 约定：
 * - 命名 `domain.entity.action`（过去式动词，事件是既成事实）
 * - 版本「只增不改」：加字段 ✅ / 改字段类型 / 改语义 → 升 topic 版本
 * - 命令不是事件：命令 topic 走 /api/command，声明在 {@link CommandMap}
 */
import type {
  ChatMessage,
  ProviderDescriptor,
  RetryPolicy,
  StreamChunk,
  StreamError,
  Usage,
} from './llm'

/** 所有事件 payload 的公共字段（ts / source 必填，其余可选） */
export interface EventBase {
  /** 时间戳（毫秒） */
  ts: number
  /** 发布者 serviceId，如 'hello' / 'llm' / 'loop' / 'core' */
  source: string
  /** 一对一请求-响应配对 */
  requestId?: string
  /** 关联链（一个用户操作触发多个服务协作） */
  traceId?: string
  /** 会话上下文 */
  sessionId?: string
}

/** Pane 声明（manifest.panes 元素，用于前端注册） */
export interface PaneDescriptor {
  id: string
  component: string
}

/**
 * 事件映射 —— 后续阶段（P2+）追加 llm / loop / session 等只增不删。
 * interface 合并语义：所有 topic 集中于此，一处定义三处消费。
 */
export interface EventMap {
  'service.starting': EventBase & { serviceId: string; version: string }
  'service.ready': EventBase & { serviceId: string; version: string; panes?: PaneDescriptor[] }
  'service.restarting': EventBase & { serviceId: string; reason: string }
  'service.failed': EventBase & { serviceId: string; exitCode?: number; reason: string }
  'service.stopped': EventBase & { serviceId: string }
  'hello.command.started': EventBase & { requestId: string; text: string }
  'hello.command.executed': EventBase & { requestId: string; echo: string }
  'hello.command.failed': EventBase & { requestId: string; reason: string }
  // ── llm（P2 §3.4）──
  'llm.request.started': EventBase & { requestId: string; provider: string; model: string }
  'llm.token.streamed': EventBase & { requestId: string; token: string; index: number }
  'llm.request.finished': EventBase & {
    requestId: string
    finishReason: 'stop' | 'length' | 'content_filter' | 'tool_calls' | 'error'
    usage?: { promptTokens: number; completionTokens: number }
  }
  'llm.request.failed': EventBase & {
    requestId: string
    error: { code: string; message: string }
  }
  // ── llm 能力位（P2 六插件 §5，只增不改）──
  /** provider 服务就绪并注册能力（主位据此建路由） */
  'llm.provider.registered': EventBase & ProviderDescriptor
  /** provider 服务退出 / 重启中（主位摘路由，前端摘状态行） */
  'llm.provider.unregistered': EventBase & { provider: string }
  /** provider → 主位：流式块（块结构不出 wire，主位翻译成 llm.token.streamed 等对外事件） */
  'llm.provider.chunk': EventBase & { requestId: string; chunk: StreamChunk }
  /** credentials → provider：凭证解析结果（值只在服务间总线传播，永不进 SSE） */
  'credentials.resolved': EventBase & {
    requestId: string
    apiKey?: string
    error?: StreamError
  }
  /** llm-retry 记账输出（P2 只声明消费 + 记账，P4 执行器） */
  'llm.metrics.usage': EventBase & { requestId: string; provider: string; usage: Usage }
}

/**
 * 命令映射 —— 走 /api/command 投递（非事件），不要求 ts/source。
 * 服务 manifest 的 `subscribes` 可引用命令与事件。
 */
export interface CommandMap {
  'hello.command': { requestId: string; text: string }
  'service.restart': { serviceId: string }
  'service.stop': { serviceId: string }
  'service.start': { serviceId: string }
  // ── llm（P2 §3.4 命令）──
  'llm.request': {
    requestId: string
    provider: string
    model?: string
    messages: ChatMessage[]
    temperature?: number
    meta?: Record<string, unknown>
  }
  'llm.cancel': { requestId: string }
  // ── llm 能力位（P2 六插件 §5，只增不改）──
  /** 主位 → provider：发起流（credentialRef / retryPolicy 由主位按路由注入） */
  'llm.provider.request': {
    requestId: string
    provider: string
    model: string
    messages: ChatMessage[]
    temperature?: number
    credentialRef: string
    retryPolicy: RetryPolicy
    meta?: Record<string, unknown>
  }
  /** 主位 → provider：取消在途请求（provider `signal.abort()` → 上游断开 → `finish{ stop }`） */
  'llm.provider.cancel': { requestId: string }
  /** provider → credentials：解析凭证引用（ref 如 `env:DEEPSEEK_API_KEY`；P4 支持 `core:<id>`） */
  'credentials.resolve': { requestId: string; ref: string }
}

/** 事件 topic：keyof EventMap */
export type EventKey = keyof EventMap & string

/** 命令 topic：keyof CommandMap */
export type CommandKey = keyof CommandMap & string

/** 事件 payload 依 topic 自动推导 */
export type EventPayload<T extends EventKey> = EventMap[T]

/** 命令 payload 依 topic 自动推导 */
export type CommandPayload<T extends CommandKey> = CommandMap[T]

/**
 * 运行时事件 topic 清单 —— 与 {@link EventMap} 保持同步（只增不改纪律）。
 * Core 用它在服务启动前做 manifest 事件一致性校验（fail fast）。
 */
export const EVENT_TOPICS = [
  'service.starting',
  'service.ready',
  'service.restarting',
  'service.failed',
  'service.stopped',
  'hello.command.started',
  'hello.command.executed',
  'hello.command.failed',
  'llm.request.started',
  'llm.token.streamed',
  'llm.request.finished',
  'llm.request.failed',
  'llm.provider.registered',
  'llm.provider.unregistered',
  'llm.provider.chunk',
  'credentials.resolved',
  'llm.metrics.usage',
] as const satisfies readonly EventKey[]

/** 运行时命令 topic 清单 —— 与 {@link CommandMap} 同步；服务 manifest 的 subscribes 可引用命令 */
export const COMMAND_TOPICS = [
  'hello.command',
  'service.restart',
  'service.stop',
  'service.start',
  'llm.request',
  'llm.cancel',
  'llm.provider.request',
  'llm.provider.cancel',
  'credentials.resolve',
] as const satisfies readonly CommandKey[]