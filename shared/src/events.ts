/**
 * 事件契约 —— Core / 服务 / 前端共享的唯一真相源（RFC §5，P1a 首批）。
 *
 * 约定：
 * - 命名 `domain.entity.action`（过去式动词，事件是既成事实）
 * - 版本「只增不改」：加字段 ✅ / 改字段类型 / 改语义 → 升 topic 版本
 * - 命令不是事件：命令 topic 走 /api/command，声明在 {@link CommandMap}
 */
import type {
  ApprovalPolicy,
  ChatMessage,
  DirEntry,
  DirRoot,
  MCPServerConfig,
  ProviderDescriptor,
  RetryPolicy,
  StreamChunk,
  StreamError,
  ThinkingEffort,
  ToolCall,
  ToolEscape,
  ToolRecord,
  ToolRisk,
  ToolSpec,
  Usage,
} from './llm'
import type { ConstraintField, ConstraintValues } from './tools/constraints'
import type { MaskedCredential, ModelsPrefs } from './llm'
import type { SkinBrief, SkinSetPatch, SkinSetResult } from './skin'
import type { AgentRecipe, AgentStatePatch, CharacterBrief } from './agent'
import type { SkillIndexEntry, SkillSource } from './skills'

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
  /**
   * 归档（P4b P2-2，只增不改）。归档桶内部纯按时间排，不接受手动顺序。
   *
   * **归档不得改 `updatedAt`** —— 与 `pinned` 同一条纪律（P4b DR-6）：
   * 用户操作的是「分类」，不是「活动时间」。否则归档一下会话就跳进「今天」最顶上。
   */
  archived?: boolean
  /**
   * 父会话 id（P4b P2-3，只增不改）—— 子代理发起的对话归属到父会话，
   * 前端按它在前端归组（不学天枢对每个根会话各发一次子会话请求的 N+1）。
   */
  parentId?: string
  /**
   * 最后一条 user/assistant 消息的预览（P4b P2-4，只增不改）—— 由 session 服务在 append 时截断拼接。
   *
   * 为什么服务端拼而不是前端各拉一次：前端要为每个会话各发一次 `session.get`
   * 才能拿到最后一条消息（N+1，天枢已经中过这个招）。服务端拼一次，列表直接有。
   */
  lastMessage?: string
  /** 会话绑定的项目目录（P7 M0，只增不改）—— 工具沙箱的权威来源（session 服务是唯一写者） */
  workspace?: string
  /** 额外授权根（越界审批批准后加入；`workspace` 排第一，其余按加入序） */
  workspaces?: string[]
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
  // ── models 插件的用户数据（只增不改；**明文凭证永不入 payload**）──
  /**
   * models 插件的接入清单（`userData/plugin/models/preferences.json`）。
   *
   * **所有者是 models 插件的服务**（它同时是 UI 与会话输入框的数据源），Core 不持有也不转发。
   * 任何一次变更后由 owner **主动重播整份**（不是增量），所以订阅方不需要 diff 也不需要补偿逻辑。
   */
  'models.prefs.state': EventBase & { prefs: ModelsPrefs }
  /**
   * models 插件的凭证**掩码**列表（`userData/plugin/models/credentials.json`）。
   *
   * ⚠️ 只有掩码（`sk-abc…xyz`）。明文值只存在于 owner 进程的内存与那个文件里 ——
   * 这是「密钥归使用方插件」之后仍然成立的那条红线。
   */
  'models.credentials.state': EventBase & { credentials: MaskedCredential[] }
  // ── session（P3 §3.3/§3.4，只增不改）──
  /** session 命令结果（`session.get` 不存在时 session:null，调用方回退最近会话） */
  'session.list.result': EventBase & { requestId: string; sessions: SessionMeta[]; error?: EventError }
  'session.get.result': EventBase & { requestId: string; session: SessionFile | null; error?: EventError }
  'session.create.result': EventBase & { requestId: string; sessionId: string; title: string; error?: EventError }
  'session.rename.result': EventBase & { requestId: string; sessionId: string; title: string; error?: EventError }
  'session.delete.result': EventBase & { requestId: string; sessionId: string; error?: EventError }
  'session.clear.result': EventBase & { requestId: string; deletedCount: number; error?: EventError }
  'session.pin.result': EventBase & { requestId: string; sessionId: string; pinned: boolean; error?: EventError }
  'session.archive.result': EventBase & { requestId: string; sessionId: string; archived: boolean; error?: EventError }
  /** 导出结果（P2-5）：`content` 是完整 Markdown 文本，`filename` 建议下载名 */
  'session.export.result': EventBase & {
    requestId: string
    sessionId: string
    filename: string
    content: string
    error?: EventError
  }
  'message.append.result': EventBase & { requestId: string; sessionId: string; message: Message; error?: EventError }
  /** session 领域事件（前端列表 + loop 旁路消费） */
  'session.created': EventBase & { sessionId: string; title: string; updatedAt: string }
  'session.updated': EventBase & {
    sessionId: string
    title?: string
    updatedAt: string
    /** 置顶变化（P4b P2-1，只增不改）。**bump 它不代表改 updatedAt** */
    pinned?: boolean
    /** 归档变化（P4b P2-2，只增不改） */
    archived?: boolean
    /** 预览行更新（P4b P2-4 / P0-0：append 后补发）。只取 user/assistant 的正文前 120 码点 */
    lastMessage?: string
    /** 工作区变化（P7 M0，只增不改）：loop 据此更新本地副本 + 可用于重派 */
    workspace?: string
    workspaces?: string[]
  }
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
  // ── skins 插件的皮肤目录（只增不改）──
  /**
   * 皮肤清单（`plugins/skins/skins.json`）。
   *
   * ## 为什么只有一条事件、而且是「重播整份」
   *
   * skins 插件是**只读能力位** —— 资产是构建产物，运行期不可写
   * （详见 `shared/src/skin.ts` 与 docs/插件demo/skin_manager/皮肤管理插件设计.html）。
   * 所以没有 `skin.set`，也就没有「改完之后要广播什么」这个问题。
   *
   * **重播整份**让订阅方不需要 diff、不需要补偿逻辑：view 晚于 owner 启动时，
   * 那批变更早就发完了（与 `models.prefs.state` / `tools.state` 同一个理由）。
   *
   * ## 订阅方有三个，各取所需
   * - `widget.skins`：目录与预览（只读）
   * - `widget.agents`：绑定选择器的候选 —— 它**只读**，写的是 `characters.json`
   *   里 `skinId` 那一条，owner 是 agents 服务
   * - `widget.chat-timeline`：把 `skinId` 换成资产 URL
   *
   * ## 收不到时怎么表现
   *
   * **没收到 ≠ 空清单**。两者在界面上必须能区分开（§8 第 3 条）：
   * 没收到显示「无法校验」，空清单显示「没有皮肤」。
   * 前者不能说出是哪个插件没提供 —— 一份清单都没拿到，说出来就是猜。
   */
  'skin.state': EventBase & { skins: SkinBrief[] }
  'skin.set.result': EventBase & SkinSetResult

  // ── agents 插件（P5，只增不改）──
  /**
   * 角色目录（`userData/plugin/agents/characters.json`）—— **重播整份**。
   *
   * 与 `skin.state` / `models.prefs.state` 同一套「owner 重播整份」机制：
   * composer 的角色下拉、widget.agents 编辑器都订阅它，不需要 diff。
   */
  'agent.state': EventBase & { characters: CharacterBrief[] }
  /**
   * 角色解析结果（`agent.resolve` 的响应）—— **两跳**（总线不提供返回值）。
   * `recipe` 是纯数据配方；`error` 时（角色不存在等）由调用方回落裸会话。
   */
  'agent.resolve.result': EventBase & { requestId: string; recipe?: AgentRecipe; error?: EventError }

  // ── prompt 片段（P5，只增不改）──
  /**
   * 一段要拼进 system 的提示词片段。**角色那份也走这条**（id = `role:<characterId>`），
   * 与 reliability 插件发的那条一模一样 —— 所以 loop 侧零新增机制。
   *
   * 装配器按 `(priority, id)` 排；`role:*` 片段只在当前 run 选了对应角色时才纳入。
   */
  'prompt.fragment.registered': EventBase & { pluginId: string; id: string; priority: number; text: string }
  'prompt.fragment.unregistered': EventBase & { pluginId: string; id: string }

  // ── skills 插件（P6，只增不改）──
  /**
   * 一个技能被登记（带技能的插件服务读完自己的 SKILL.md 后 publish）。
   * `source:'custom'` 的是用户自建（owner = {@link CUSTOM_OWNER_ID}）。
   */
  'skill.registered': EventBase & {
    ownerPluginId: string
    name: string
    description: string
    source: SkillSource
    enabled: boolean
  }
  'skill.unregistered': EventBase & { ownerPluginId: string; name: string }
  /** 全系统唯一的技能索引（**重播整份**）—— 界面与统计的数据源 */
  'skills.state': EventBase & { skills: SkillIndexEntry[] }
  /** `skills.list` 的响应（两跳）：按角色过滤后的索引 = 本机可用 ∩ 角色绑定 */
  'skills.list.result': EventBase & { requestId: string; skills: SkillIndexEntry[]; error?: EventError }

  // ── 工作区（P7 M0，只增不改）──
  /** 列目录结果（盘符 + 快捷入口 + 目录项）。**workspace 服务从不 readFile** */
  'workspace.list.result': EventBase & {
    requestId: string
    entries: DirEntry[]
    currentPath: string
    parentPath: string | null
    roots: DirRoot[]
  }
  /** 解析一个路径是否存在（用于选择器校验） */
  'workspace.resolve.result': EventBase & { requestId: string; path: string | null }

  // ── 工具（P7 M1/M2，只增不改）──
  /** 一个执行者登记它提供的工具（含 risk）。**同名后者拒绝注册**（不覆盖，界面标 ⚠） */
  'tool.registered': EventBase & {
    serviceId: string
    tools: (ToolSpec & { risk: ToolRisk; managedBy?: 'user' | 'auto'; constraintFields?: ConstraintField[] })[]
  }
  'tool.unregistered': EventBase & { serviceId: string }
  /**
   * 一次工具执行的结果。**越界**时 `ok:false` + `escape`（由 loop 转成工作区审批并重派）；
   * 被拒 / 超时 / 禁用 / 未知，四种都产结果（不静默丢弃）。
   */
  'tool.execute.result': EventBase & {
    requestId: string
    ok: boolean
    content: string
    summary: string
    escape?: ToolEscape
  }
  /**
   * 审批请求。`kind:'exec'`（缺省）由**闸门**应答；`kind:'workspace'`（越界授权）由 **loop** 应答
   * （闸门不认识工作区）。老节点不传 `kind` → 按普通 exec 处理。
   */
  'tool.approval.requested': EventBase & {
    requestId: string
    sessionId: string
    toolName: string
    risk: ToolRisk
    arguments: string
    kind?: 'exec' | 'workspace'
    requestedPath?: string
    permissionRoot?: string
    rationale?: string
    expiresAt?: number
  }
  /** 工具目录 + 策略 + 约束 + MCP（重播整份，widget.tools 数据源） */
  'tools.state': EventBase & {
    tools: ToolRecord[]
    policies: Record<string, ApprovalPolicy>
    constraints: ConstraintValues
    mcpServers?: MCPServerConfig[]
  }
  /** 试调（`tools.invoke`）的结果 */
  'tools.invoke.result': EventBase & {
    requestId: string
    ok: boolean
    content: string
    summary: string
    elapsedMs: number
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
  // ── models 插件的用户数据命令（owner = 对应 provider 服务）──
  /**
   * 「把接入清单重播一遍」（空载荷）。
   *
   * 与 `llm.provider.reannounce` 同一个理由：订阅方可能晚于 owner 启动，
   * 那批变更事件早就发完了。**重播整份**而不是发增量，订阅方因此不需要 diff。
   */
  'models.prefs.get': Record<string, never>
  /** 合并式改接入清单（`patch` 里没给的键保持不变）—— 避免两个视图互相覆盖 */
  'models.prefs.set': { patch: Partial<ModelsPrefs> }
  /** 「把凭证掩码列表重播一遍」（空载荷） */
  'models.credentials.list': Record<string, never>
  /**
   * 新建 / 覆盖一条密钥。
   *
   * ⚠️ `value` 是**明文**，但它只走「前端 → Core `/api/command` → 总线 → owner」这一条路，
   * 不会进 SSE / 事件 / 日志（owner 回的是掩码列表）。这条通道与 Core 时代的
   * `PUT /api/credentials` 同一性质，只是终点从 Core 的文件换成了插件的文件。
   */
  'models.credentials.put': { id?: string; name: string; provider: string; value: string }
  /** 删一条密钥 */
  'models.credentials.delete': { id: string }
  /**
   * 模型目录命令（P4 WS-3）—— 前端/主位发，**对应 provider 服务**订阅并回复 `llm.models.list.result`。
   * （能力位设计：模型列表属于 provider 自身知识，主位不查上游）
   */
  'llm.models.list': { requestId: string; provider: string }
  /**
   * 请 provider 进程**重播全部** `llm.provider.registered`（空载荷）。
   *
   * 为什么需要它：前端对 provider 清单是**纯事件驱动**的，而注册事件在进程启动时就发完了。
   * 任何在启动之后才打开的页面（模型配置窗、插件详情窗…）都会**永远错过**那批事件，
   * 于是把已经连上的服务显示成「未连接」。
   *
   * 与 `llm.models.list` 的区别：那个要指定 provider、只答一家；这个问「现在都有谁」。
   */
  'llm.provider.reannounce': Record<string, never>
  // ── session 命令（P3 §3.3，只增不改；响应走 <cmd>.result 事件）──
  'session.list': { requestId: string }
  'session.get': { requestId: string; sessionId: string }
  /**
   * 新建会话（P3；P4b P2-3 加可选 `parentId`，只增不改）。
   * `parentId` 给子代理发起的子会话用 —— 前端按它归组，不学天枢的 N+1。
   */
  'session.create': { requestId: string; title?: string; parentId?: string }
  'session.rename': { requestId: string; sessionId: string; title: string }
  'session.delete': { requestId: string; sessionId: string }
  'session.clear': { requestId: string }
  /** 置顶（P4b P2-1）。**不得改 `updatedAt`** —— 见 §9 决策与 shared SessionMeta 注释 */
  'session.pin': { requestId: string; sessionId: string; pinned: boolean }
  /** 归档（P4b P2-2）。与 `session.pin` 同一条纪律：不改 `updatedAt` */
  'session.archive': { requestId: string; sessionId: string; archived: boolean }
  /** 导出会话（P4b P2-5）。结果走 `session.export.result`（Markdown 文本，前端下载） */
  'session.export': { requestId: string; sessionId: string }
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
    /** P5：本次 run 选的角色 id（缺省 = 裸会话）。装配器据此纳入 `role:<id>` 片段 */
    characterId?: string
  }
  /** 取消在途 run（fire-and-forget，无 <cmd>.result；结果由 loop.run.cancelled / loop.run.failed 体现） */
  'loop.cancel': { requestId: string }
  // ── skins 插件（**只有一条命令**：收集方上线时问一次）──
  /**
   * 「把皮肤清单重播一遍」（空载荷）。
   *
   * 与 `models.prefs.get` / `llm.provider.reannounce` 同一个理由：订阅方可能晚于
   * owner 启动，那批变更事件早就发完了。**重播整份**而不是发增量。
   *
   * ## 走用户数据之后，写操作从这里长出来
   *
   * 资产在 `userData/plugin/skins/`，服务**独占读写**（握手的 `dataDir` 指向那里），
   * 所以上传 / 裁剪 / 删除 / 改元数据都有落点，`skin.state` 之后会重播整份。
   *
   * 注意本插件**仍然不写 `characters.json`** —— 角色的 `skinId` 由 agent 服务持有。
   * `skin.set` 存在的唯一理由是「删除一套皮肤前要核对有没有角色在用」。
   */
  'skin.list': Record<string, never>
  /**
   * 改一个角色绑的皮肤 —— **这是写 `characters.json` 之外唯一的写操作**。
   *
   * ## 写的是谁的数据
   *
   * `skinId` 字段本身在 `agents` 的 `characters.json` 里，owner 是 agent 服务；
   * **本插件不写那个文件**。这条命令存在的理由是另一件事：删除一套皮肤时，
   * 要知道「有没有角色正在用它」才能决定**能不能删**。
   *
   * ## 合并式
   *
   * `patch` 里没给的键保持不变。删除走 `removed` 而不是把字段设成 `null` ——
   * 因为「没绑」与「绑了个空」在协议上是同一件事，不值得两种表示。
   *
   * ## 结果带 `affectedRoles`
   *
   * 删除/停用被引用中的皮肤时，服务**拒绝并列出引用者**（不静默删）。
   * 那份清单是从 `agent.state` 读的（owner 重播整份），所以它可能不完整 ——
   * 因此这里的 `affectedRoles` 是**尽力而为的提示**，界面上要照原文说，
   * 不能反过来当「没被引用」的保证。
   */
  'skin.set': { requestId: string; patch: SkinSetPatch }

  // ── agents 插件命令（P5，只增不改）──
  /**
   * 合并式改角色目录（没给的键不变）。结果走 `agent.state` 重播，**不另发 result** ——
   * 与 `skin.set` 不同：这里没有「被拒」的失败模式，patch 要么合进去要么条目不存在。
   */
  'agent.state.set': { requestId: string; patch: AgentStatePatch }
  /** 问「这个角色装配成什么」—— 两跳，回 `agent.resolve.result` */
  'agent.resolve': { requestId: string; characterId: string }
  /** 请各插件重播自己的 `prompt.fragment.registered`（空载荷）。晚启动的装配器上线时问一次 */
  'prompt.fragments.list': Record<string, never>

  // ── skills 插件命令（P6，只增不改）──
  /**
   * 要技能清单。`characterId` 可选 —— 给了就返回**本机可用 ∩ 该角色绑定**（AND 服务端成立），
   * 不给返回全部本机可用。loop 在角色轮里用它拼 p10 索引片段。
   */
  'skills.list': { requestId: string; characterId?: string }
  /**
   * 机器级「本机可用」开关。**不影响角色绑定**（关掉不删绑定，重开即恢复）。
   * 粒度：机器级一份（`skills.json`）。
   */
  'skill.enabled.set': { requestId: string; name: string; enabled: boolean; ownerPluginId: string }
  /**
   * 写用户自建技能（`userData/plugin/skills/custom/<name>/SKILL.md`）—— **skills 服务是唯一写者**。
   * 改正文 / 新建走 `content`；删除走 `removed`（不可逆，界面只提供停用，见技能设计稿 §2）。
   */
  'skill.package.write': { requestId: string; name: string; content?: string; removed?: boolean }

  // ── 工作区命令（P7 M0，只增不改）──
  /** 列目录（不读文件）。`path` 缺省 = 盘符/快捷入口根 */
  'workspace.list': { requestId: string; path?: string }
  /** 解析一个路径是否存在 */
  'workspace.resolve': { requestId: string; path: string }
  /** 用系统文件管理器打开一个目录 */
  'workspace.open': { requestId: string; path: string }
  /**
   * 合并式写会话的工作区（唯一写者 = session 服务）：
   * `workspace` 设项目根；`addRoot` / `removeRoot` 增删授权根。
   */
  'session.set.workspace': { requestId: string; sessionId: string; workspace?: string; addRoot?: string; removeRoot?: string }

  // ── 工具命令（P7 M1/M2，只增不改）──
  /** 请求重播工具目录（`tools.state`） */
  'tools.list': Record<string, never>
  /**
   * 派发一次工具执行给执行者（loop → 执行者）。`workspaces` 是沙箱根（**workspace 排第一**）；
   * 缺省 = 无工作区（任何路径都越界 → 触发一次工作区审批）。
   */
  'tool.execute': { requestId: string; sessionId: string; name: string; arguments: string; workspaces?: string[] }
  /** 审批应答（用户 → 闸门 / loop） */
  'tool.approval.resolved': { requestId: string; approved: boolean; reason?: string; remember?: boolean }
  /** 合并式改策略 / 约束（widget.tools） */
  'tools.set': { requestId?: string; policies?: Record<string, ApprovalPolicy>; constraints?: ConstraintValues }
  /** 试调一个工具（widget.tools 的「试调」Tab） */
  'tools.invoke': { requestId: string; name: string; arguments: string }
  /** 改 MCP 服务器清单 */
  'tools.mcp.set': { requestId?: string; servers: MCPServerConfig[] }
  /** 测一个 MCP 服务器连通性 */
  'tools.mcp.test': { requestId?: string; server: string }
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
  'llm.metrics.usage',
  'llm.models.list.result',
  'models.prefs.state',
  'models.credentials.state',
  'session.list.result',
  'session.get.result',
  'session.create.result',
  'session.rename.result',
  'session.delete.result',
  'session.clear.result',
  'session.pin.result',
  'session.archive.result',
  'session.export.result',
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
  'skin.state',
  'skin.set.result',
  'agent.state',
  'agent.resolve.result',
  'prompt.fragment.registered',
  'prompt.fragment.unregistered',
  'skill.registered',
  'skill.unregistered',
  'skills.state',
  'skills.list.result',
  'workspace.list.result',
  'workspace.resolve.result',
  'tool.registered',
  'tool.unregistered',
  'tool.execute.result',
  'tool.approval.requested',
  'tools.state',
  'tools.invoke.result',
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
  'llm.models.list',
  'llm.provider.reannounce',
  'models.prefs.get',
  'models.prefs.set',
  'models.credentials.list',
  'models.credentials.put',
  'models.credentials.delete',
  'session.list',
  'session.get',
  'session.create',
  'session.rename',
  'session.delete',
  'session.clear',
  'session.pin',
  'session.archive',
  'session.export',
  'message.append',
  'loop.run',
  'loop.cancel',
  'skin.list',
  'skin.set',
  'agent.state.set',
  'agent.resolve',
  'prompt.fragments.list',
  'skills.list',
  'skill.enabled.set',
  'skill.package.write',
  'workspace.list',
  'workspace.resolve',
  'workspace.open',
  'session.set.workspace',
  'tools.list',
  'tool.execute',
  'tool.approval.resolved',
  'tools.set',
  'tools.invoke',
  'tools.mcp.set',
  'tools.mcp.test',
  'plugin.start',
  'plugin.stop',
] as const satisfies readonly CommandKey[]