# P1b 详细计划 · Panel / Widget 工作台骨架（现行实现）

> 归属：`阶段追踪.md` 里程碑 **P1b**
>
> 状态：已完成，自动化验证全绿
>
> 当前实现说明：本文以仓库代码为准。详细的数据流和组件职责见 [`../前端工作台-现行实现.md`](../前端工作台-现行实现.md)。

## 0. 结论先行

当前工作台采用两层布局：

```text
MainLayout
└─ DockviewLayout                         外层：Panel 停靠、拆分、比例、序列化
   └─ PanelContainer                      内层：Widget 拖动、缩放、吸附、几何持久化
      └─ Widget component                  最小业务单元
```

两套库的职责不能混淆：

- **dockview-vue**：管理 Panel，也就是外层窗口/标签/分隔条；
- **vue-movable-box**：管理 Panel 内的 Widget 盒子，也就是自由拖动、缩放、层级和吸附；
- **Widget**：工作台的最小业务组件，通过 `widgets/` 注册和发现；
- **Panel**：Widget 的容器，不是业务组件本身。

当前默认布局是 `panel.main`，其中装入所有默认 Widget。没有已保存布局时，`default-layout.ts` 通过 dockview 原生 `addPanel` 创建它。

## 1. 当前目录和职责

```text
client/src/
├── main.ts                         # Vue、Pinia、Router、UI 插件、布局样式
├── App.vue                         # 只渲染 RouterView
├── router.ts                       # / 主窗口；/pane/:id 独立 Panel 窗口
├── layouts/
│   ├── MainLayout.vue              # TopBar + DockviewLayout；挂载时 bootstrap
│   └── TopBar.vue                  # 模式切换、新建 Panel、添加 Widget
├── layout/
│   ├── DockviewLayout.vue          # dockview 外层生命周期和布局事件
│   ├── layout.store.ts             # SerializedDockview 快照和偏好持久化
│   ├── mode.ts                     # edit / runtime 模式
│   ├── types.ts                    # PaneId、LayoutMode 及兼容类型
│   └── window-manager.ts           # 独立 Panel 窗口
├── panes/
│   ├── PanelContainer.vue          # vue-movable-box 内层容器
│   ├── PanelHeaderActions.vue      # 重置 / 拉出 / 关闭
│   ├── PanelTab.vue                # dockview 自定义 Panel tab
│   ├── PanelHost.vue               # 独立 Panel 窗口壳
│   ├── default-layout.ts           # 默认 panel.main
│   └── types.ts                    # PANEL_COMPONENT、PanelParams、兼容 PaneDefinition
├── widgets/
│   ├── types.ts                    # WidgetDefinition
│   ├── definition.ts               # defineWidget
│   └── registry.ts                 # import.meta.glob 自动发现
├── components/                     # 通用 UI 组件
├── core-sdk/                       # SSE、事件、命令、服务状态、偏好
└── styles/                         # tokens.css、base.css
```

### 1.1 兼容文件说明

仓库中仍存在部分早期 P1b 文件，例如 `PaneView.vue`、`PaneFrame.vue`、`layout.model.ts` 和旧 `features/hello` 注册代码。它们不是当前主工作台的渲染链路，当前主链路是：

```text
MainLayout → DockviewLayout → PanelContainer → Widget component
```

后续扩展应优先修改 `DockviewLayout.vue`、`PanelContainer.vue`、`layout.store.ts` 和 `widgets/`，不要根据兼容文件的旧接口继续扩展主架构。

## 2. 现行工作分解

### WS-1 · Vue client 骨架

- [x] Vue 3 + Vite + TypeScript + Pinia + vue-router；
- [x] `App.vue` 只保留 `RouterView`；
- [x] `MainLayout` 挂载 `DockviewLayout` 并调用 `layout.bootstrap()`；
- [x] `main.ts` 引入 `dockview.css` 和 `vue-movable-box/style.css`；
- [x] 通用 UI 组件库和 tokens.css。

### WS-2 · dockview 外层布局

- [x] `DockviewVue` 注册唯一的 `panel` 组件；
- [x] `PanelContainer` 作为所有 Panel 的内容组件；
- [x] `api.toJSON()` / `api.fromJSON()` 负责外层布局快照；
- [x] `onDidLayoutChange` 将外层变化交给 `layout.store`；
- [x] `addWidget()`、`newPanel()`、`resetLayout()` 由 Pinia store 统一操作；
- [x] 默认布局由 `default-layout.ts` 创建；
- [x] `onDidAddGroup` 和模式 watcher 同步 edit / runtime 状态。

### WS-2b · vue-movable-box 内层组件布局

- [x] 每个 Widget 渲染为一个 `MovableBox`；
- [x] 拖动手柄为 Widget 标题栏 `.panel-boxes__header`；
- [x] 支持自由移动、8 向缩放、z-index 层级和 `snap-to-elements` 吸附；
- [x] Widget 几何保存为 `params.layout[widgetId]`；
- [x] `@drag-stop` / `@resize-stop` 通过 `updateParameters` 保存；
- [x] 派发 `osteosome:panel-layout`，由外层 Dockview 重新序列化；
- [x] 刷新或重新打开时优先恢复 `params.layout`。

### WS-3 · core-sdk

- [x] `sse.ts` 单例连接和 topic 分发；
- [x] `useEventBus` 生命周期订阅 / 退订；
- [x] `useCommand` POST `/api/command`；
- [x] `useServiceStatus` 订阅服务生命周期事件；
- [x] `usePreferences` GET / PUT `/api/preferences`。

### WS-4 · Panel 宿主和独立窗口

- [x] `PanelHeaderActions.vue` 提供重置、拉出、关闭；
- [x] `openPanelWindow(panelId, widgetIds)` 生成 `#/pane/:id?w=...`；
- [x] `PanelHost.vue` 复用 `PanelContainer`，不重复创建 dockview 外层；
- [x] 独立窗口挂载时确保 SSE 已连接；
- [x] 弹窗被浏览器拦截时返回 `null`，由调用方处理。

### WS-5 · Widget registry 和示例

- [x] `defineWidget` 校验 `id` / `title`；
- [x] `registry.ts` 通过 `import.meta.glob('./*/*-widget.vue', { eager: true })` 自动发现；
- [x] `widget.service-status` 展示服务状态；
- [x] `widget.hello-command` 验证命令 → Core → SSE 事件链路。

### WS-6 · 收尾和验证

- [x] `pnpm build`；
- [x] `pnpm test`；
- [x] Core 1420 和 Vite 5173 启动检查；
- [x] HTTP 200 冒烟检查。

## 3. 接口定案

### 3.1 WidgetDefinition

```ts
// client/src/widgets/types.ts
import type { Component } from 'vue'

export interface WidgetDefinition {
  id: string
  title: string
  component: () => Promise<{ default: Component }>
}
```

Widget 定义文件示例：

```vue
<script lang="ts">
import { defineWidget } from '@/widgets/definition'

export default defineWidget({
  id: 'widget.example',
  title: '示例组件',
  component: () => import('./ExampleWidget.vue'),
})
</script>
```

Widget 文件名必须匹配 `*-widget.vue`，并放在 `client/src/widgets/<group>/` 下，Vite 才会通过 `import.meta.glob` 自动发现。

### 3.2 PanelParams

```ts
// client/src/panes/types.ts
export const PANEL_COMPONENT = 'panel'

export interface PanelParams {
  widgets?: string[]
}
```

实际运行时，Panel 参数还包含 `layout`：

```ts
type RuntimePanelParams = PanelParams & {
  layout?: Record<string, MovableBoxRect>
}
```

`widgets` 决定 Panel 中有哪些 Widget；`layout[widgetId]` 保存该 Widget 的 `left/top/width/height/zIndex`。

### 3.3 Dockview 外层快照

```ts
// client/src/layout/layout.store.ts
import type { SerializedDockview } from 'dockview-core'

type LayoutState = {
  mode: 'edit' | 'runtime'
  snapshot: SerializedDockview | null
  api: DockviewApi | null
  hydrated: boolean
  saving: boolean
  lastError: string | null
}
```

持久化规则：

- `api.toJSON()` 的结果就是外层真源；
- `updateLayout(next)` 更新 `snapshot` 并防抖 500ms；
- `saveNow()` 通过 `usePreferences().put({ layout })` 保存；
- `bootstrap()` 解析失败时回退到默认布局并设置 `lastError`；
- `resetLayout()` 调用 `api.clear()`，再执行 `applyDefaultLayout(api)`。

### 3.4 PanelContainer 内层数据流

```ts
type MovableBoxRect = {
  left: number
  top: number
  width: number
  height: number
  zIndex: number
}
```

```text
MovableBox drag/resize
  → panel.api.updateParameters({ widgets, layout })
  → dispatchEvent('osteosome:panel-layout')
  → DockviewLayout 收到事件
  → api.toJSON()
  → layout.store.updateLayout(snapshot)
  → /api/preferences
```

初始布局由 `defaultRect(index)` 生成：Panel 尚未保存某个 Widget 的矩形时，按照 360×240 的盒子和 8px 网格生成默认位置。

### 3.5 路由

```ts
const routes = [
  { path: '/', component: () => import('./layouts/MainLayout.vue') },
  {
    path: '/pane/:id',
    component: () => import('./panes/PanelHost.vue'),
    props: (route) => ({
      id: String(route.params.id),
      widgets: String(route.query.w ?? '').split(',').filter(Boolean),
    }),
  },
  { path: '/:pathMatch(.*)*', redirect: '/' },
]
```

独立窗口传递的是 Panel id 和 Widget id 列表。业务数据不复制，仍通过 Core 的 SSE 获取。

## 4. 测试矩阵（当前实现）

| 模块 | 当前覆盖 |
|---|---|
| `layout.store` | 快照恢复、损坏布局回退、变更防抖保存、添加 Widget、新建 / 重置 Panel |
| `layout.model` | 旧兼容模型的 row/col/pane 转换测试 |
| `widgets/registry` | 自动发现、定义校验、组件映射 |
| `panes/default-layout` | 默认 Panel 和默认 Widget |
| `panes/pane-host` | Panel 独立窗口入口 |
| `panes/pane-frame` | 兼容 PaneFrame 行为 |
| `window-manager` | 登记、聚焦复用、关闭清理 |
| `router` | `/`、`/pane/:id`、重定向 |
| `core-sdk` | SSE 单例、事件订阅、命令、服务状态 |
| `components/ui` | 通用 UI 组件渲染和交互 |
| `PanelContainer` / MovableBox | 当前依赖人工浏览器验收；后续可补几何事件自动化测试 |

## 5. 绿灯标准

```powershell
# 构建
pnpm build

# 全量测试
pnpm test

# 手工工作台验收
# 1. TopBar 新建 Panel
# 2. 添加两个 Widget 到同一 Panel
# 3. 拖动标题栏移动 Widget
# 4. 拖动边缘缩放 Widget
# 5. 验证吸附和 z-index
# 6. 刷新页面，确认 Panel 和 Widget 几何恢复
# 7. 拉出独立窗口，确认 Widget 列表和 SSE 数据一致
# 8. 切换 runtime，确认外层拖拽锁定、组头隐藏
```

## 6. 风险和维护约束

| 主题 | 当前约束 |
|---|---|
| 两套布局引擎 | dockview 只管 Panel；vue-movable-box 只管 Widget，不得把两层状态混成同一棵树 |
| Widget 几何 | 几何必须存进 Panel `params.layout`，不能另建全局 Widget 状态 |
| 事件桥 | Widget 几何变化通过 `osteosome:panel-layout` 通知外层，不能绕过 `layout.store` 写偏好 |
| 拖动手柄 | 固定使用 Widget 标题栏，避免内容滚动和交互被拖拽接管 |
| 依赖样式 | `main.ts` 必须引入 `vue-movable-box/style.css` |
| 布局损坏 | 解析失败回退默认布局，不能白屏 |
| 兼容代码 | `PaneView` / `PaneFrame` / `layout.model` 不是当前主链路，扩展前先确认调用方 |
| Widget 通信 | 继续使用 `useEventBus` / `useCommand`，不在 Widget 内新开 SSE 或旁路 API |

## 7. 当前验证基线

```text
pnpm build       PASS
pnpm test        PASS
Client           34 test files / 84 tests
Core             76 tests
SDK              48 tests
Core :1420       HTTP 200
Vite :5173       HTTP 200
```

## 8. 后续扩展顺序

1. 新业务能力优先以 Widget 形式加入 `client/src/widgets/`；
2. 只有当多个 Widget 需要独立停靠、拆分或独立窗口时，才新增 Panel 组织方式；
3. 需要拖动 / 缩放 / 吸附的组件统一交给 `vue-movable-box`，不要在 Widget 内自行实现第二套拖拽；
4. 需要改变 Panel 停靠结构时修改 dockview 外层，不要把 Panel 几何写进 Widget `params.layout`；
5. 为 MovableBox 交互补充浏览器级测试后，再把它纳入 CI 绿灯。

## 9. 演进记录

- **P1b 初始方案**：Pane 直接由 dockview 渲染，使用自定义 `Layout` / `WorkspaceLayout` 做外层布局；
- **dockview 原生化**：改为保存 `SerializedDockview`，移除自定义双向映射作为主链路；
- **Widget 化**：将最小业务单位从 Pane 下沉为 Widget，Panel 统一使用 `PanelContainer`；
- **GridviewVue 方案**：一度尝试用内层 dockview 管理 Widget，后被自由盒子交互需求替代；
- **vue-movable-box 方案（现行）**：Widget 改为 `MovableBox`，支持自由拖动、缩放、吸附，并将几何写入 `params.layout`；
- **当前实现**：dockview 管外层 Panel，vue-movable-box 管内层 Widget，Widget registry 负责业务组件发现。
