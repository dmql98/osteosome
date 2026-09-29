/**
 * 插件注册表（设计期写死）。
 *
 * 定位：组件与插件合并——每个插件在设计初期就把自己需要的组件（widget id）定好，
 * 运行期不再有“添加组件”入口；用户从「插件详情」里按组件加入窗口。
 * 本表同时是插件列表窗 / 详情窗的数据源，也是 widget 归属（widget -> plugin）的反查源。
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
    widgets: ['widget.system-info', 'widget.command-palette', 'widget.hello-command'],
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
