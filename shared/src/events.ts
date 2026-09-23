/**
 * 事件契约 —— Core / 服务 / 前端共享的唯一真相源（RFC §5，P1a 首批）。
 *
 * 约定：
 * - 命名 `domain.entity.action`（过去式动词，事件是既成事实）
 * - 版本「只增不改」：加字段 ✅ / 改字段类型 / 改语义 → 升 topic 版本
 * - 命令不是事件：命令 topic 走 /api/command，声明在 {@link CommandMap}
 */

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
}

/**
 * 命令映射 —— 走 /api/command 投递（非事件），不要求 ts/source。
 * 服务 manifest 的 `subscribes` 可引用命令与事件。
 */
export interface CommandMap {
  'hello.command': { requestId: string; text: string }
}

/** 事件 topic：keyof EventMap */
export type EventKey = keyof EventMap & string

/** 命令 topic：keyof CommandMap */
export type CommandKey = keyof CommandMap & string

/** 事件 payload 依 topic 自动推导 */
export type EventPayload<T extends EventKey> = EventMap[T]

/** 命令 payload 依 topic 自动推导 */
export type CommandPayload<T extends CommandKey> = CommandMap[T]