/**
 * 插件注册表（设计期写死）。
 *
 * 定位：组件与插件合并——每个插件在设计初期就把自己需要的组件（widget id）定好，
 * 运行期不再有“添加组件”入口；用户从「插件详情」里按组件加入窗口。
 * 本表同时是插件列表窗 / 详情窗的数据源，也是 widget 归属（widget -> plugin）的反查源。
 *
 * P2（LLM 能力位拆分）追加：`plugin.llm`（主位服务 `llm`）+ 3 个 provider 服务插件。
 * 按「能力位 = 独立服务进程」的 OST 思想，**服务插件 = 服务的呈现**：
 * - `plugin.llm`           → `services/llm`（能力主位，组件 `widget.llm-chat`）
 * - `plugin.llm-providers` → 3×`services/llm-provider-*`（provider 位，组件 `widget.llm-providers`）
 * - credentials / llm-retry 是旁路服务，无独立组件（见 LLM能力位拆分设计.md §4.5.1），
 *   不在本表列为可管理插件——它们的启停由服务层 manifest 控制，UI 不镜像服务内部结构。
 *
 * 注意：插件定义里 `widgets` 指向的 widget 由 WS-8 提供（llm-chat / llm-providers 已落地）。
 */

export interface PluginCapability {
  /** 服务层能力标识（点分命名，如 service.restart） */
  name: string
  /** 可选的人类可读说明 */
  detail?: string
}

export interface PluginDependency {
  /** 依赖的服务 / 插件 id（可与 service.* 事件的 serviceId 对齐） */
  id: string
  /** 展示名 */
  label: string
  /** 无实时服务信息时的静态就绪标记，默认 true */
  ready?: boolean
}

export interface PluginDefinition {
  id: string
  name: string
  /** 卡片图标（emoji） */
  icon: string
  version: string
  author?: string
  license?: string
  /** 插件介绍 */
  description: string
  /** 服务层能力（可无 UI） */
  capabilities: PluginCapability[]
  /** 该插件贡献的 UI 组件（widget id），设计期写死 */
  widgets: string[]
  /** 依赖 */
  dependencies: PluginDependency[]
}

/** 内置插件：把现有 widget 按领域收编到插件名下。 */
export const PLUGINS: PluginDefinition[] = [
  {
    id: 'plugin.workbench',
    name: '工作台基础',
    icon: '🧰',
    version: '1.0.0',
    author: 'osteosome',
    license: 'Apache-2.0',
    description:
      '工作台的最小骨架：系统信息、命令台与快速问候。它连接 Core 的命令通道，展示本机与控制进程概况，是龙骨默认携带的基础血肉。',
    capabilities: [
      { name: 'system.info', detail: '读取本机与控制进程概况' },
      { name: 'command.execute', detail: '向 Core 投递命令' },
      { name: 'hello.greet', detail: '示例问候命令' },
    ],
    widgets: ['widget.system-info', 'widget.command-palette', 'widget.hello-command', 'widget.settings'],
    dependencies: [{ id: 'core', label: 'Core 微内核' }],
  },
  {
    id: 'plugin.event-stream',
    name: '事件流',
    icon: '🌊',
    version: '0.9.0',
    author: 'osteosome',
    license: 'Apache-2.0',
    description:
      '订阅 Core 事件总线的心跳，把 tool.* / service.* / session.* 事件以时间线形式呈现，便于观察 Agent 的实时过程。',
    capabilities: [
      { name: 'event.subscribe', detail: '订阅通配主题（* / **）' },
      { name: 'event.replay', detail: '回放最近事件' },
    ],
    widgets: ['widget.event-stream'],
    dependencies: [{ id: 'bus', label: '消息总线' }],
  },
  {
    id: 'plugin.service-manager',
    name: '服务管理',
    icon: '⚙️',
    version: '1.0.0',
    author: 'osteosome',
    license: 'Apache-2.0',
    description:
      '管理 Core 下挂载的独立服务进程：查看启动、就绪、异常等生命周期状态，并触发重启。',
    capabilities: [
      { name: 'service.list', detail: '列出已注册服务' },
      { name: 'service.status', detail: '订阅服务生命周期事件' },
      { name: 'service.restart', detail: '重启异常服务' },
    ],
    widgets: ['widget.service-status', 'widget.service-manager'],
    dependencies: [
      { id: 'core', label: 'Core 微内核' },
      { id: 'bus', label: '消息总线' },
    ],
  },
  {
    id: 'plugin.session',
    name: '会话',
    icon: '💬',
    version: '0.1.0',
    author: 'osteosome',
    license: 'Apache-2.0',
    description:
      '会话管理（P3 WS-4）：会话列表（新建 / 切换 / 重命名 / 删除 / 当前高亮）经 SSE 事件跨窗实时同步；curId 当前会话为本地态（各窗独立）。组件（widget.session-list）。',
    capabilities: [
      { name: 'session.list', detail: '会话索引列表' },
      { name: 'session.create/rename/delete', detail: '会话 CRUD' },
    ],
    widgets: ['widget.session-list'],
    dependencies: [{ id: 'session', label: '会话服务' }],
  },
  {
    id: 'plugin.llm',
    name: 'LLM 对话',
    icon: '🤖',
    version: '0.1.0',
    author: 'osteosome',
    license: 'Apache-2.0',
    description:
      'LLM 能力主位（services/llm）：接收前端 llm.request 命令、按 provider 路由、把流式块翻译成 llm.token.streamed 等对外事件。组件（widget.llm-chat）由 WS-8 提供（发问 / 停止 / 流式累积）。',
    capabilities: [
      { name: 'llm.request', detail: '发起流式对话' },
      { name: 'llm.cancel', detail: '取消在途请求' },
      { name: 'llm.provider.registered', detail: '感知 provider 注册' },
    ],
    widgets: ['widget.llm-chat'],
    dependencies: [{ id: 'llm', label: 'LLM 主位服务' }],
  },
  {
    id: 'plugin.llm-providers',
    name: 'LLM Providers',
    icon: '🔌',
    version: '0.1.0',
    author: 'osteosome',
    license: 'Apache-2.0',
    description:
      'LLM provider 能力位（services/llm-provider-*）：deepseek / openrouter / openai（通用兼容）独立服务，经 llm.provider.registered 注册自身能力。组件（widget.llm-providers）由 WS-8 提供，渲染 provider 存在性与状态（defaultModel / credentialRef / retry 声明）。',
    capabilities: [
      { name: 'llm.provider.registered', detail: 'provider 注册（defaultModel / credentialRef / retryPolicy）' },
      { name: 'llm.provider.unregistered', detail: 'provider 退出（主位摘路由）' },
      { name: 'credentials.resolve', detail: '经凭证能力位解析 API Key（值不进前端）' },
    ],
    widgets: ['widget.llm-providers'],
    dependencies: [
      { id: 'llm', label: 'LLM 主位服务' },
      { id: 'credentials', label: '凭证服务' },
    ],
  },
]

export function listPlugins(): PluginDefinition[] {
  return [...PLUGINS]
}

export function getPlugin(id: string): PluginDefinition | undefined {
  return PLUGINS.find((plugin) => plugin.id === id)
}

/** widget 归属的插件；未登记归属的 widget 返回 undefined（视为始终可用）。 */
export function pluginForWidget(widgetId: string): PluginDefinition | undefined {
  return PLUGINS.find((plugin) => plugin.widgets.includes(widgetId))
}
