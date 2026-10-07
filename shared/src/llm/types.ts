/**
 * LLM 中立协议 —— 基础类型（唯一真相源，P2 WS-1 上移自 `services/llm/src/`）。
 *
 * 依赖纪律：
 * - `chunk.ts` 只依赖本文件；本文件**零 import**（provider 服务可独立消费，不相互 import）。
 * - `StreamErrorCode` 全链路错误码化（§3.3）：不再出现供应商字符串匹配。
 * - `ProviderDescriptor` 由 provider 服务注册时发布（§3.2），主位据此路由。
 */

/** 块类型：文本 / 推理 / 工具调用 */
export type BlockType = 'text' | 'reasoning' | 'tool_call'

/** 结束原因（中立枚举；取消统一走 `stop`，§3.4） */
export type FinishReason = 'stop' | 'length' | 'content_filter' | 'tool_calls' | 'error'

/** usage 记账（P2：总量；P4 起可追加 cached/uncached 细分） */
export interface Usage {
  promptTokens: number
  completionTokens: number
}

/** 适配器错误码（§3.3）—— 全链路不再出现供应商字符串匹配 */
export type StreamErrorCode =
  | 'unauthorized' // 401/403 —— 非瞬态
  | 'rate_limited' // 429 —— 瞬态
  | 'server_error' // 5xx —— 瞬态（503 起）
  | 'network' // fetch 网络异常 / 超时 —— 瞬态
  | 'invalid_request' // 400 / wire 畸形 —— 非瞬态
  | 'unsupported_provider' // 主位路由缺失 —— 非瞬态
  | 'missing_credential' // 凭证解析失败 —— 非瞬态

export interface StreamError {
  code: StreamErrorCode
  message: string
}

/** 模型发起的一次工具调用（P7：assistant 消息携带 → loop 执行 → role:'tool' 回填） */
export interface ToolCall {
  /** 块 id（provider wire 的 tool_call id，中立化后） */
  id: string
  name: string
  /** JSON 字符串（wire 原样；解析失败由执行侧兜底） */
  arguments: string
}

/** 声明式工具定义（P7：loop 下发给主位 → provider，wire 形状由各自 provider 翻译） */
export interface ToolSpec {
  name: string
  description: string
  /** JSON Schema 对象 */
  parameters: Record<string, unknown>
}

// ── 工具能力位（P7）────────────────────────────────────────────
/** 工具风险档：决定硬超时分档与默认审批策略 */
export type ToolRisk = 'read' | 'write' | 'net' | 'proc'
/** 审批策略：ask 弹窗 / auto 放行 / deny 直接拒 */
export type ApprovalPolicy = 'ask' | 'auto' | 'deny'

/**
 * 目录里的一条工具（`tools.state` 载荷）。
 * `managedBy:'auto'` = 由已安装技能包 / MCP 决定，界面**不给启用开关**（只只读展示）。
 */
export interface ToolRecord extends ToolSpec {
  serviceId: string
  risk: ToolRisk
  enabled: boolean
  managedBy?: 'user' | 'auto'
  /** 同名冲突：被拒的那个不覆盖生效的那个，界面标 ⚠ */
  conflict?: boolean
  /** 该工具声明了哪些约束键（界面据此渲染约束编辑器） */
  constraintKeys?: string[]
  /** 约束字段声明（界面据此渲染编辑器） */
  constraintFields?: import('../tools/constraints').ConstraintField[]
}

/** 工作区目录项（`workspace.list.result.entries`） */
export interface DirEntry {
  name: string
  path: string
  isDir: boolean
}
/** 工作区入口（盘符 / 快捷入口） */
export interface DirRoot {
  name: string
  path: string
  kind: 'drive' | 'quick'
}
/** MCP 服务器配置（`mcp-servers.json`） */
export interface MCPServerConfig {
  id: string
  transport: 'stdio' | 'sse' | 'http'
  command?: string
  args?: string[]
  url?: string
  enabled?: boolean
}
/** 越界信息（`tool.execute.result.escape`）—— 由 loop 转发成一次工作区审批 */
export interface ToolEscape {
  requestedPath: string
  permissionRoot: string
}

/** 对话消息（llm.request 与 llm.provider.request 共用） */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  /** role:'tool' 时必带：对应 assistant.toolCalls[].id */
  toolCallId?: string
  /** role:'assistant' 且发起工具调用时携带 */
  toolCalls?: ToolCall[]
}

/** 宽松解析工具参数（wire 是 JSON 字符串；畸形 → undefined 由调用方兜底） */
export function parseToolArguments(raw: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(raw) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}

/**
 * 思考强度（中立枚举，P4 WS-2）—— 前端只认这四个值，各家 wire 词汇由 provider 内部翻译：
 *
 * | 中立 | openai `reasoning_effort` | anthropic `thinking.budget_tokens` |
 * |---|---|---|
 * | `off` | 不下发（用模型默认） | 不下发 |
 * | `low` | `low` | 2048 |
 * | `medium` | `medium` | 8192 |
 * | `high` | `high` | 16384 |
 *
 * 纪律同 `StreamErrorCode`：**provider 不互相 import，wire 差异不出 provider 边界**。
 */
export type ThinkingEffort = 'off' | 'low' | 'medium' | 'high'

/** anthropic 等 token 预算制 provider 的思考预算映射（anthropic 要求 budget ≥ 1024） */
export const THINKING_BUDGETS: Record<Exclude<ThinkingEffort, 'off'>, number> = {
  low: 2048,
  medium: 8192,
  high: 16384,
}

/** 宽松解析（前端/总线来值不可信；非法 → undefined = 不下发） */
export function normalizeThinking(value: unknown): ThinkingEffort | undefined {
  return value === 'off' || value === 'low' || value === 'medium' || value === 'high' ? value : undefined
}

/** 声明式重试策略（P2 只声明不执行；执行器 P4 落 `services/llm-retry`） */
export type BackoffStrategy = 'exponential' | 'fixed'

export interface RetryPolicy {
  /** 总尝试次数（含首次） */
  maxAttempts: number
  /** 首次重试基础延迟 ms */
  baseDelayMs: number
  backoff: BackoffStrategy
  /** 视为瞬态的错误码（对齐 §3.3 retryableCodes） */
  retryableCodes: string[]
}

/** 通用默认重试策略（429/503 瞬态）；provider 服务可各自覆盖声明 */
export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 500,
  backoff: 'exponential',
  retryableCodes: ['rate_limited', 'server_error'],
}

/** ProviderDescriptor（provider 服务注册时发布，§3.2） */
export interface ProviderDescriptor {
  /** 如 'deepseek' / 'openrouter' / 'openai' */
  provider: string
  defaultModel: string
  /** 如 'env:DEEPSEEK_API_KEY'；P4 支持 'core:<id>' */
  credentialRef: string
  retryPolicy: RetryPolicy
}

/** 由原始 finishReason 归一化到中立枚举（每个 provider 各自负责映射） */
export function normalizeFinishReason(reason: string): FinishReason {
  switch (reason) {
    case 'length':
      return 'length'
    case 'content_filter':
      return 'content_filter'
    case 'tool_calls':
      return 'tool_calls'
    case 'error':
      return 'error'
    default:
      // stop / end_turn / stop_sequence / 未知 → 一律 stop
      return 'stop'
  }
}

/** usage 归一：wire 字段 → 中立 Usage（P2 只填总量；缺字段按 0） */
export function normalizeUsage(raw: unknown): Usage | undefined {
  if (raw === null || typeof raw !== 'object') return undefined
  const r = raw as Record<string, unknown>
  const prompt = typeof r.prompt_tokens === 'number' ? r.prompt_tokens : 0
  const completion = typeof r.completion_tokens === 'number' ? r.completion_tokens : 0
  if (prompt === 0 && completion === 0) return undefined
  return { promptTokens: prompt, completionTokens: completion }
}
