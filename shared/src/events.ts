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
  ThinkingEffort,
  ToolCall,
  ToolSpec,
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

/** 事件/结果错误（P3 §3.3：缺字段/不存在 → <cmd>.result 带 error，不吞静默） */
export interface EventError {
  code: string
  message: string
}

/** 会话元信息（session 索引条目） */
export interface SessionMeta {
  id: string
  title: string
  createdAt: string
  updatedAt: string
  pinned?: boolean
  /** 全文/索引损坏标记（读到但不可用） */
  corrupted?: boolean
}

/** 消息（append-only，不可变；P7 起 role 可为 tool，携带 toolCallId / toolCalls） */
export interface Message {
  id: string
  role: 'system' | 'user' | 'assistant' | 'tool'
  createdAt: string
  content: string
  finishReason?: 'stop' | 'length' | 'content_filter' | 'tool_calls' | 'error'
  usage?: { promptTokens: number; completionTokens: number }
  /**
   * `role:'assistant'`：本轮的**思维链**（S4，只增不改）。
   *
   * 为什么要单独存而不是丢：主位与 loop 把 `blockType:'reasoning'` 的 token 单独累积到这里，
   * **`content` 只留正文**。前端据此渲染可折叠的思考块（S5）。
   * 若只是「不显示」而不存，思维链就被静默扔掉了 —— 用户看不到模型为什么这么想，也无法排查。
   */
  reasoning?: string
  /** role:'tool'：对应 assistant.toolCalls[].id */
  toolCallId?: string
  /** role:'tool'：工具名（渲染与排查用） */
  toolName?: string
  /** role:'assistant'：本条发起的工具调用 */
  toolCalls?: ToolCall[]
}

/** 单会话全文（session.get.result） */
export interface SessionFile {
  meta: SessionMeta
  messages: Message[]
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
    // ── 插件（S7-1，只增不改）──
    /**
     * 插件状态变化（S7）。`state` 是**派生**的：Core 把它声明的服务真实状态 +
     * 依赖满足情况聚合出来（见 `shared/src/plugin-manifest.ts` 的 resolvePluginState）。
     *
     * 为什么状态是事件而不是让前端自己算：前端算就得复制一份聚合逻辑，
     * 而那份逻辑的输入（服务真实状态）只有 Core 有 —— 于是又变成第二个真源。
     */
    'plugin.state.changed': EventBase & {
      pluginId: string
      state: 'ready' | 'degraded' | 'stopped' | 'failed'
      /** 人话原因（degraded / failed 时有值），直接显示给用户 */
      reason?: string
      /** 缺失的必需依赖插件 id */
      missingDependencies?: string[]
      /** 该插件的服务里 ready 的个数 / 总数（详情窗「N/M」） */
      readyServices?: number
      totalServices?: number
    }
  'hello.command.started': EventBase & { requestId: string; text: string }
  'hello.command.executed': EventBase & { requestId: string; echo: string }
  'hello.command.failed': EventBase & { requestId: string; reason: string }
  // ── llm（P2 §3.4）──
  'llm.request.started': EventBase & { requestId: string; provider: string; model: string }
  'llm.token.streamed': EventBase & {
    requestId: string
    token: string
    index: number
    /**
     * 该 token 属于哪类块（S4，只增不改）—— `reasoning` 是思维链，**不是正文**。
     *
     * 缺省视为 `'text'`，这样只发 `data:` 老事件的上游/旧版本节点不会因为缺字段而错分流。
     * 不标的后果很具体：主位与 loop 都会把思维链当正文 token 累积，思维链混进回答正文。
     */
    blockType?: 'text' | 'reasoning'
  }
  'llm.request.finished': EventBase & {
    requestId: string
    finishReason: 'stop' | 'length' | 'content_filter' | 'tool_calls' | 'error'
    usage?: { promptTokens: number; completionTokens: number }
  }
  'llm.request.failed': EventBase & {
    requestId: string
    error: { code: string; message: string }
  }
  /**
   * 主位 → 上层：本次请求解析出的工具调用（P7，只增不改）。
   *
   * 来源：provider 的 `tool_call` 块（`block-start` + `tool-arg-delta` + `block-end`）
   * 在主位按块 id 拼装完整 `{ id, name, arguments }` 后**按块闭合即发**（不等 finish），
   * 于是上层能在模型还在续答时就开始执行/渲染工具。
   */
  'llm.request.tool_call': EventBase & { requestId: string; toolCall: ToolCall }
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
  /**
   * 模型目录结果（P4 WS-3）—— 由**对应 provider 服务**发布（能力位：谁知道自己有哪些模型）。
   * `catalog:'remote'` = 上游 /models 拉取成功；`'static'` = 拉取失败/超时 → 降级静态列表（可能不全）。
   *
   * **字段名是 `catalog` 不是 `source`（勿回退）**：`source` 是 {@link EventBase} 的保留字段
   * ——ServiceManager 对每条服务消息做权威盖章 `source = serviceId`（`manager.ts:334`），
   * 任何叫 `source` 的业务字段都会被覆盖成服务名（P4 WS-5 集成冒烟实证：
   * 断言拿到 `'llm-provider-openai'`）。这是总线级保留字，不是命名风格问题。
   */
  'llm.models.list.result': EventBase & {
    requestId: string
    provider: string
    models: string[]
    catalog: 'remote' | 'static'
  }
  // ── credential（P4 §3.4，只增不改；**值永不入 payload**）──
  /** 凭证写入（只带 { id, name, provider }；明文值不出 Core） */
  'credential.saved': EventBase & { id: string; name: string; provider: string }
  /** 凭证删除（只带 { id }） */
  'credential.deleted': EventBase & { id: string }
  // ── session（P3 §3.3/§3.4，只增不改）──
  /** session 命令结果（`session.get` 不存在时 session:null，调用方回退最近会话） */
  'session.list.result': EventBase & { requestId: string; sessions: SessionMeta[]; error?: EventError }
  'session.get.result': EventBase & { requestId: string; session: SessionFile | null; error?: EventError }
  'session.create.result': EventBase & { requestId: string; sessionId: string; title: string; error?: EventError }
  'session.rename.result': EventBase & { requestId: string; sessionId: string; title: string; error?: EventError }
  'session.delete.result': EventBase & { requestId: string; sessionId: string; error?: EventError }
  'session.clear.result': EventBase & { requestId: string; deletedCount: number; error?: EventError }
  'message.append.result': EventBase & { requestId: string; sessionId: string; message: Message; error?: EventError }
  /** session 领域事件（前端列表 + loop 旁路消费） */
  'session.created': EventBase & { sessionId: string; title: string; updatedAt: string }
  'session.updated': EventBase & { sessionId: string; title?: string; updatedAt: string }
  'session.deleted': EventBase & { sessionId: string }
  'message.appended': EventBase & { sessionId: string; message: Message }
  // ── loop（P3 §3.2/§3.4，只增不改）──
  /** loop 状态切换（requestId = A，loop.run 的对外 id） */
  'loop.state.changed': EventBase & { requestId: string; sessionId: string; state: 'idle' | 'running' }
  /** 本次跑动失败（错误码透传；不落 assistant 消息） */
  'loop.run.failed': EventBase & { requestId: string; sessionId: string; error: EventError }
  /** 本次跑动被主动取消（成功路径，不留半截 assistant） */
  'loop.run.cancelled': EventBase & { requestId: string; sessionId: string }
  /** loop 转发 llm 的 token（B→A 换发；B 不泄前端，index 保留 llm 原值） */
  'loop.token.streamed': EventBase & {
    requestId: string
    sessionId: string
    token: string
    index: number
    /** 同 `llm.token.streamed.blockType`：loop 透传，缺省视为 `'text'` */
    blockType?: 'text' | 'reasoning'
  }
  /**
   * 一次工具执行的结果（P7，只增不改）—— 前端据此渲染工具块（进行中 → 成功/失败）。
   * `summary` 是给模型与 UI 看的短摘要（长内容截断，完整结果在 role:'tool' 消息里）。
   */
  'loop.tool.executed': EventBase & {
    requestId: string
    sessionId: string
    toolCallId: string
    name: string
    arguments: string
    ok: boolean
    summary: string
  }
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
    // ── 插件（S7-1，只增不改）──
    /**
     * 启停一个插件 —— **展开成它声明的服务启停**（S7-2 实现展开，S7-4 接前端）。
     *
     * 展开时的两个约定（S7-1 先钉死，实现照做）：
     * - **停之前先收尾**：若插件的服务里含 `loop`，先发 `loop.cancel` 让在途的一轮
     *   正常结束，超时才强杀。直接杀会留下半截 assistant 消息。
     * - **共享服务不误停**：同一个服务若被多个插件声明，只有当**声明它的插件都没装**
     *   才真的停。当前 5 个插件的服务互不重叠，所以先不做引用计数 ——
     *   这是个**已知前提**，不是「已处理」。将来出现重叠时必须改成引用计数。
     */
    'plugin.start': { pluginId: string }
    'plugin.stop': { pluginId: string }
  // ── llm（P2 §3.4 命令）──
  'llm.request': {
    requestId: string
    provider: string
    model?: string
    messages: ChatMessage[]
    temperature?: number
    /** 思考强度（P4 WS-2，只增不改；provider 内部翻各家 wire） */
    thinking?: ThinkingEffort
    /** 工具定义（P7，只增不改；非空即让模型可发起 tool_calls） */
    tools?: ToolSpec[]
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
    thinking?: ThinkingEffort
    /** 工具定义（P7；主位透传，各 provider 翻自家 wire） */
    tools?: ToolSpec[]
    credentialRef: string
    retryPolicy: RetryPolicy
    meta?: Record<string, unknown>
  }
  /** 主位 → provider：取消在途请求（provider `signal.abort()` → 上游断开 → `finish{ stop }`） */
  'llm.provider.cancel': { requestId: string }
  /** provider → credentials：解析凭证引用（ref 如 `env:DEEPSEEK_API_KEY`；P4 支持 `core:<id>`） */
  'credentials.resolve': { requestId: string; ref: string }
  /**
   * 模型目录命令（P4 WS-3）—— 前端/主位发，**对应 provider 服务**订阅并回复 `llm.models.list.result`。
   * （能力位设计：模型列表属于 provider 自身知识，主位不查上游）
   */
  'llm.models.list': { requestId: string; provider: string }
  // ── session 命令（P3 §3.3，只增不改；响应走 <cmd>.result 事件）──
  'session.list': { requestId: string }
  'session.get': { requestId: string; sessionId: string }
  'session.create': { requestId: string; title?: string }
  'session.rename': { requestId: string; sessionId: string; title: string }
  'session.delete': { requestId: string; sessionId: string }
  'session.clear': { requestId: string }
  'message.append': { requestId: string; sessionId: string; message: { role: 'system' | 'user' | 'assistant' | 'tool'; content: string; id?: string; toolCallId?: string; toolName?: string; toolCalls?: ToolCall[] } }
  // ── loop 命令（P3 §3.4；requestId = A，对外可见）──
  /**
   * 发起一次对话（P4 WS-2 起带参：`provider`/`model`/`thinking` 缺省时由 loop 回落 env/默认）。
   * 只增不改：P3 时期只有 requestId/sessionId/text。
   */
  'loop.run': {
    requestId: string
    sessionId: string
    text: string
    provider?: string
    model?: string
    thinking?: ThinkingEffort
  }
  /** 取消在途 run（fire-and-forget，无 <cmd>.result；结果由 loop.run.cancelled / loop.run.failed 体现） */
  'loop.cancel': { requestId: string }
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
  'plugin.state.changed',
  'hello.command.started',
  'hello.command.executed',
  'hello.command.failed',
  'llm.request.started',
  'llm.token.streamed',
  'llm.request.finished',
  'llm.request.failed',
  'llm.request.tool_call',
  'llm.provider.registered',
  'llm.provider.unregistered',
  'llm.provider.chunk',
  'credentials.resolved',
  'llm.metrics.usage',
  'llm.models.list.result',
  'credential.saved',
  'credential.deleted',
  'session.list.result',
  'session.get.result',
  'session.create.result',
  'session.rename.result',
  'session.delete.result',
  'session.clear.result',
  'message.append.result',
  'session.created',
  'session.updated',
  'session.deleted',
  'message.appended',
  'loop.state.changed',
  'loop.run.failed',
  'loop.run.cancelled',
  'loop.token.streamed',
  'loop.tool.executed',
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
  'llm.models.list',
  'session.list',
  'session.get',
  'session.create',
  'session.rename',
  'session.delete',
  'session.clear',
  'message.append',
  'loop.run',
  'loop.cancel',
  'plugin.start',
  'plugin.stop',
] as const satisfies readonly CommandKey[]