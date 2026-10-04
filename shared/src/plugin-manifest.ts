/**
 * 插件清单 `plugin.json` 的 schema 与类型（S7-1）。
 *
 * ## 它与 `service.json` 的分工（不重叠）
 *
 * | 文件 | 回答的问题 | 谁读 |
 * |---|---|---|
 * | `plugins/<id>/dist/server/<sid>/service.json` | **一个进程怎么被拉起来**（entry / protocolVersion / publishes / subscribes） | Core 管生命周期时 |
 * | `plugins/<id>/plugin.json` | **哪些进程与组件算一件东西**（归属与依赖） | Core 编排 + 前端展示 |
 *
 * 所以加一个插件不用改任何 `service.json`，加一个能力位不用改任何 `plugin.json`。
 *
 * ## 两份 service.json：源码侧与产物侧（P2）
 *
 * 服务在 `plugins/<id>/services/<sid>/service.json`（**源码侧**，跟 git 走）也有一份 ——
 * 那是「这个服务存在、它声明了哪些 topic」的**声明**，CI 的 `service-manifest-sync`
 * 校验的就是它。构建时它被复制到 `dist/server/<sid>/service.json`（**产物侧**，`entry`
 * 改写成 `node index.js`），**Core 只读产物侧那份** —— 没构建过的服务对 Core 不可见，
 * 插件相应地降级成「未构建」。这样「插件交付物 = 一个 dist 目录」才成立。
 *
 * ## 为什么归属必须落盘，不能派生
 *
 * 「这三个服务必须一起用」是**人写的设计决定**，磁盘上读不出来 —— 只能从真实服务状态
 * 派生出「有哪些服务在跑」，那得到的是服务列表的镜像，不是插件。
 * 归属是数据（这里），状态是事实（由服务真实 status 聚合，见 {@link PluginState}）。
 */
import { z } from 'zod'

/** 插件依赖另一个插件；`optional` = 缺了只降级不阻断 */
export const PluginDependencySchema = z.object({
  pluginId: z.string().min(1),
  /** 缺必需依赖 → 插件 degraded + 提示「缺 X」，**不启动失败** */
  optional: z.boolean().default(false),
})

/**
 * 「我这个插件要哪些 Core 才装得上」的闭区间声明（P2）。
 *
 * **不写 = 不限**：现有插件零改动就能过，而「没声明」永远是安全的缺省。
 *
 * 两端都是**含**的闭区间，且只支持 `x.y.z`（可带预发布后缀）—— 刻意不支持
 * `^1.2.3` / `1.x` 这类简写与 range 表达式，理由见 `shared/src/semver.ts` 文件头。
 */
const VersionRangeSchema = z
  .object({
    min: z.string().min(1).optional(),
    max: z.string().min(1).optional(),
  })
  .optional()

/** 别的插件的数据命名空间，本插件**只读**（P2 只声明，P3 才真正生效） */
const DataReadableBySchema = z.array(z.string().min(1)).default([])

/**
 * 插件 UI 里的一个**命名视图**（P3，形态 1）。
 *
 * 一个插件的 UI 是一个应用，`views[]` 声明它有哪些可独立摆放的视图。Core 的路由是
 * `/plugins/<id>/ui/<entry>`，同一个插件的多个视图因此只是不同入口 ——
 * 这就是「多个可拖动组件」得以保留的原因（否则一个插件只能整块摆放）。
 *
 * `entry` 用 **hash** 切视图（`index.html#timeline`）而不是路径，是刻意的：
 * hash 不产生服务端请求，于是「深链」这件事完全由插件自己管，Core 不需要知道
 * 任何路由规则 —— 它只当静态文件搬运工。
 */
const UiViewSchema = z.object({
  /** 视图 id，惯例是 widget id（前端按它摆位）；Core 只当字符串，不校验命名 */
  id: z.string().min(1),
  /** 展示名（插件详情窗 / 添加组件的列表用） */
  title: z.string().min(1),
  /** 相对 `dist/ui/` 的入口，惯例 `index.html` 或 `index.html#timeline` */
  entry: z.string().min(1),
})

/**
 * 插件的 WebUI 产物（P3）。
 *
 * **没有 `ui` 的插件就没有前端界面** —— 纯服务插件（credentials / reliability）合法地不声明。
 * 声明了但 `dist/ui/` 没构建 → 插件报「UI 未构建」，Core 的路由回 404（而不是白屏）。
 */
const UiSchema = z
  .object({
    views: z.array(UiViewSchema).default([]),
  })
  .optional()

export const PluginManifestSchema = z.object({
  /** 插件唯一标识，须等于所在目录名（`plugins/<id>/plugin.json`） */
  id: z.string().min(1),
  /** 展示名 */
  name: z.string().min(1),
  version: z.string().min(1),
  icon: z.string().optional(),
  description: z.string().optional(),
  author: z.string().optional(),
  license: z.string().optional(),
  /**
   * 本插件带来的服务 id（源码在 `plugins/<id>/services/<id>/`，
   * 产物在 `plugins/<id>/dist/server/<id>/` —— **Core 只认后者**，P2 起）。
   *
   * 允许为空（内置的无服务插件，如只碰 Core 的工作台骨架）。
   * 校验交给编排层：声明了不存在的服务 id 是**编排错误**，不是 schema 错误。
   */
  services: z.array(z.string().min(1)).default([]),
  /** 本插件带来的组件 id（对应 `widget.<name>`） */
  components: z.array(z.string().min(1)).default([]),
  /**
   * 能力声明（纯展示，**不参与任何判定**）。
   *
   * 刻意保持"只读给人看"的定位：一旦有代码依赖它做判断，它就会变成第二个真源。
   */
  capabilities: z
    .array(z.object({ name: z.string().min(1), detail: z.string().optional() }))
    .default([]),
  dependencies: z.array(PluginDependencySchema).default([]),
  /**
   * 这个插件要哪些 Core 版本才装得上（P2）。**缺省 = 不限**，别把 Core 的版本轴
   * 变成所有插件的负担 —— 只有真的用到了新能力的插件才该写。
   *
   * 不满足时插件**可见但不启动**（照「依赖环内成员」的既有语义），reason 说清差在哪。
   */
  coreCompatibility: VersionRangeSchema,
  /**
   * 允许**只读**本插件用户数据的其他插件 id（P3 生效）。
   *
   * 为什么要有它：一个插件的 UI 常常要读另一个插件的数据（chat-workbench 的输入框
   * 要读 models 的模型开关）。今天那种共享靠「都塞进同一个 preferences.json」——
   * 而那意味着 Core 必须解析插件内容。拆成命名空间后，跨命名空间读就得**显式授权**，
   * 否则任何插件都能读到任何插件的密钥。
   *
   * 写**永远只限自己**，没有对应的「可写别人」字段 —— 那条路不开。
   */
  dataReadableBy: DataReadableBySchema,
  /**
   * 这个插件的 WebUI（P3）。**没有它 = 纯服务插件**（credentials / reliability 就不是）。
   *
   * 产物在 `plugins/<id>/dist/ui/`，由 Core 伺服在 `/plugins/<id>/ui/<entry>`。
   */
  ui: UiSchema,
  /**
   * 是否随 Core 自动启动。
   *
   * 缺省 true（装了就跟着起）。false = 「装了但先不启动」，用于用户想手动控制、
   * 或插件只是提供组件（比如设置面板）不需要进程的情况。
   */
  autoStart: z.boolean().default(true),
})

export type PluginManifest = z.infer<typeof PluginManifestSchema>
export type PluginDependency = z.infer<typeof PluginDependencySchema>

/**
 * 插件状态（**派生**，不是声明）。
 *
 * - `ready`：它声明的服务全 ready，必需依赖都在
 * - `degraded`：**还在**，但缺必需依赖或某个服务不 ready —— 用得起一部分，不该报失败
 * - `stopped`：没装、被卸载，或 autoStart:false 且未启动
 * - `failed`：它声明的服务里有关键服务 failed（比 degraded 更严重）
 */
export type PluginState = 'ready' | 'degraded' | 'stopped' | 'failed'

/** 状态聚合的输入：插件 + 当前真实服务状态 + 已装插件集合 */
export interface PluginStateInput {
  manifest: PluginManifest
  /** 服务 id → 真实生命周期状态（来自 Core 的 ServiceManager，不猜） */
  serviceStates: ReadonlyMap<string, string>
  /** 已装插件 id 集合（用于判定依赖是否满足） */
  installedPluginIds: ReadonlySet<string>
}

/** 状态聚合的结果；`reason` 给人看，`missing` 供 UI 定位 */
export interface PluginStateResult {
  state: PluginState
  /** 人话原因（degraded / failed 时有值） */
  reason: string
  /** 缺失的必需依赖插件 id */
  missingDependencies: string[]
  /** 未 ready / failed 的服务 id */
  unhealthyServices: string[]
  /** 它声明的服务里，有几个已 ready（详情窗展示「N/M」） */
  readyServiceCount: number
}

/**
 * 插件状态聚合（S7-1 的纯逻辑，Core 与前端都可复用）。
 *
 * **判定顺序是有意的**：
 * 1. 必需依赖缺失 → `degraded`（**不是 failed**）：对话工作台缺 provider 时仍该显示、
 *    仍该让用户看见缺什么，只是发不出请求。这与计划的验收句一致。
 * 2. 依赖都在 → 看服务：有 failed → `failed`；有非 ready → `degraded`；全 ready → `ready`
 * 3. autoStart:false 且一个服务都没起 → `stopped`（不是 degraded —— 它没坏，是没开）
 */
export function resolvePluginState(input: PluginStateInput): PluginStateResult {
  const { manifest, serviceStates, installedPluginIds } = input

  const missingDependencies = manifest.dependencies
    .filter((dep) => !dep.optional && !installedPluginIds.has(dep.pluginId))
    .map((dep) => dep.pluginId)

  const serviceIds = manifest.services
  const unhealthyServices = serviceIds.filter((id) => {
    const state = serviceStates.get(id)
    return state !== undefined && state !== 'ready' && state !== 'stopped'
  })
  const failedServices = serviceIds.filter((id) => serviceStates.get(id) === 'failed')
  const readyServiceCount = serviceIds.filter((id) => serviceStates.get(id) === 'ready').length
  const runningCount = serviceIds.filter((id) => serviceStates.get(id) === 'starting' || serviceStates.get(id) === 'ready').length

  const base = { missingDependencies, unhealthyServices, readyServiceCount }

  // ① 必需依赖缺失 → degraded（缺什么要指名，用户才能去装）
  if (missingDependencies.length > 0) {
    return { ...base, state: 'degraded', reason: `缺插件：${missingDependencies.join('、')}` }
  }

  // ② 有关键服务 failed
  if (failedServices.length > 0) {
    return { ...base, state: 'failed', reason: `服务异常：${failedServices.join('、')}` }
  }

  // ③ 服务在但没全 ready → degraded（还在，可能正在启动）
  if (unhealthyServices.length > 0) {
    return { ...base, state: 'degraded', reason: `服务未就绪：${unhealthyServices.join('、')}` }
  }

  // ④ 没装 / 没开
  if (!manifest.autoStart && runningCount === 0) {
    return { ...base, state: 'stopped', reason: '已安装但未启动' }
  }

  // ⑤ 声明的服务一个都不在（编排层还没起 / 该插件未启用）
  if (serviceIds.length > 0 && readyServiceCount === 0 && runningCount === 0) {
    return { ...base, state: 'stopped', reason: '未启动' }
  }

  return { ...base, state: 'ready', reason: '' }
}

/**
 * 按 `dependencies` 拓扑排序（S7-1 的纯逻辑）。
 *
 * - 依赖在前、被依赖者先启（与 `service.json` 的 `inject` 拓扑序同一约定）
 * - **缺失的必需依赖不会让排序失败**：那些插件标 degraded，靠状态聚合告知，不阻断启动
 * - **循环依赖无法在此检测**（会互相等待）—— 调用方（编排层）必须先跑 `findPluginCycles`
 *
 * @returns 排序后的插件；无法解析的插件（id 与目录名不符等）由调用方先过滤掉
 */
export function topoSortPlugins(manifests: readonly PluginManifest[]): PluginManifest[] {
  const byId = new Map(manifests.map((m) => [m.id, m]))
  const out: PluginManifest[] = []
  const done = new Set<string>()

  const visit = (manifest: PluginManifest, path: Set<string>): void => {
    if (done.has(manifest.id)) return
    if (path.has(manifest.id)) return // 环：交给 findPluginCycles 报，这里不死循环
    path.add(manifest.id)
    for (const dep of manifest.dependencies) {
      const target = byId.get(dep.pluginId)
      if (target) visit(target, path)
    }
    path.delete(manifest.id)
    done.add(manifest.id)
    out.push(manifest)
  }

  // 按 id 排序后再遍历 → 输出稳定（冒烟断言可预期）
  for (const manifest of [...manifests].sort((a, b) => a.id.localeCompare(b.id))) {
    visit(manifest, new Set())
  }
  return out
}

/** 找出循环依赖的插件组（S7-2 启动前必须先跑，否则拓扑排序会互相等待） */
export function findPluginCycles(manifests: readonly PluginManifest[]): string[][] {
  const byId = new Map(manifests.map((m) => [m.id, m]))
  const cycles: string[][] = []
  const state = new Map<string, 'visiting' | 'done'>()
  const stack: string[] = []

  const visit = (id: string): void => {
    const current = state.get(id)
    if (current === 'done') return
    if (current === 'visiting') {
      const start = stack.indexOf(id)
      if (start >= 0) cycles.push([...stack.slice(start), id])
      return
    }
    state.set(id, 'visiting')
    stack.push(id)
    for (const dep of byId.get(id)?.dependencies ?? []) {
      if (byId.has(dep.pluginId)) visit(dep.pluginId)
    }
    stack.pop()
    state.set(id, 'done')
  }

  for (const manifest of manifests) visit(manifest.id)
  return cycles
}
