# P1b 详细计划 · Pane 工作台骨架（v3 · 接口化）

> 归属：`阶段追踪.md` 里程碑 **P1b** ｜ 上游：`../core开发文档.md`（§8.6 client / §11 前端工作台）、`../ost-开发文档.md`（§17.2 技术选型 / §11.6 开发合同）
> 状态：已完成（骨架交付；自动化验证全绿，P1b 手工验收项见 §7） ｜ 作者：dmql ｜ 日期：2026-09-23 ｜ v3 变更：v2「接口化」五处接口级细节 + 三轮 review 补强（Table 组件、import.meta.glob 相对路径、三重围栏解封、组件接口签名）
> 验收口径：**一个 PR + 全绿 + 可单独 revert**。集成冒烟依赖 **P1a（Core 在场）**。

---

## 0. 目标与范围

### 0.1 目标

把前端工作台骨架落地：**Vue 3 + Vite + Pinia + dockview-vue**；`definePane` 契约 + 自动注册；`core-sdk`（SSE 单例 + 命令 + 偏好）；**可序列化布局 + `/api/preferences` 持久化**；一个「空 Pane」跑通 **注册 → 停靠 → 拖拽 → 刷新还原 → 拉出独立窗**；并引入**编辑 / 运行双模式**（runtime：隐藏全部顶部栏 + 锁定拖拽 + 浮动组重叠，§3.8）。它是 P2 起所有真实 Pane 的宿主骨架。

前置依赖：P1a（Core 的 `/events` / `/api/command` / `/api/preferences` 就绪）。client 骨架可与 P1a 并行起头，但**冒烟绿灯要等 P1a 全绿**。

### 0.2 范围内（In Scope）

| 项 | 说明 |
|---|---|
| `client/` workspace | Vue 3 + Vite + TS + Pinia + vue-router + dockview-vue |
| `definePane` 契约 | `panes/registry.ts` + `import.meta.glob` 自动发现 |
| `core-sdk` | `sse.ts` 单例状态机 / `useEventBus` / `useCommand` / `useServiceStatus` / `usePreferences` |
| 布局模型 | `Layout` 纯类型 + 与 dockview 双向映射 + `/api/preferences` 持久化与恢复 |
| 三入口路由 | 主窗（`/`）/ 弹窗（`/pane/:id`）/ 未匹配重定向 |
| PaneHost / PaneFrame | `#/pane/:id` 路由壳 + 标题栏 / 窗口菜单（见 wireframe） |
| 拉出独立窗 | `window.open` 弹窗机械 + `floating`/`windows` 登记（纯网页） |
| 首个示例 Pane | `hello-pane` 验证全链路（也是开发合同样板） |
| 编辑 / 运行双模式 | edit：header 显示、可拖拽；runtime：`header.hidden` + `group.locked` + 浮动组重叠（§3.8） |
| TopBar | 服务状态徽章 + 模式切换按钮（主窗独有） |

### 0.3 范围外（Out of Scope）

- ❌ Electron 壳（`desktop/`）与 `BrowserWindow` 弹窗桥（§11.4 桌面侧，留阶段 3）
- ❌ 跨窗本地态 `BroadcastChannel`（`osteosome:ctx` / `osteosome:ui`，阶段 C 期）
- ❌ `session.store`（session 模型 P2 起）与 `uiStore`（**不建**——布局即状态，§11.1 明示删除）
- ❌ i18n 词条、主题系统（浅/深/取色）、图标包
- ❌ 真实业务 Pane（chat / character / stats，P2-P5）
- ❌ 样式隔离 Shadow DOM + CSS 变量隔离（阶段 3）

---

## 1. 仓库改造

P1b 在既有 monorepo 上新增 `client/` workspace：

```
osteosome/
├── package.json / pnpm-workspace.yaml / tsconfig.base.json   # P1a 已就位
├── core/ · shared/ · sdk/ · services/                        # P1a 已就位
├── docs/                                                      # 已就位
└── client/                                                    # 本次主产物
```

### client/

```
client/
├── package.json                     # name: @osteosome/client
├── vite.config.ts                   # vue 插件 + @ 别名 + dev proxy + build.outDir
├── tsconfig.json                    # extends ../../tsconfig.base.json
├── index.html
├── env.d.ts
└── src/
    ├── main.ts                      # createApp + router + pinia
    ├── App.vue                      # 仅 <RouterView/>（无业务装配）
    ├── router.ts                    # 三入口路由（见 §3.5）
    │
    ├── layouts/
    │   ├── MainLayout.vue           # 主窗：TopBar + DockviewLayout
    │   └── TopBar.vue               # 服务状态徽章 + 模式切换按钮
    │
    ├── core-sdk/
    │   ├── sse.ts                   # EventSource 单例状态机（见 §3.4）
    │   ├── useEventBus.ts           # topic 订阅 + 生命周期自动退订
    │   ├── useCommand.ts            # POST /api/command 封装
    │   ├── useServiceStatus.ts      # 订阅 service.* → 响应式服务状态表（写 Pinia）
    │   └── usePreferences.ts        # GET/PUT /api/preferences 封装
    │
    ├── panes/
    │   ├── types.ts                 # PaneDefinition 类型
    │   ├── registry.ts              # definePane + import.meta.glob 自动发现
    │   ├── PaneHost.vue             # 弹窗入口：迷你标题栏 + 单 Pane
    │   ├── PaneFrame.vue            # 标题栏（拖拽区）+ 窗口菜单（见 §3.6 wireframe）
    │   └── PaneError.vue            # Pane 加载失败占位（不改布局）
    │
    ├── layout/
    │   ├── types.ts                 # Layout / WorkspaceLayout / PaneId
    │   ├── layout.model.ts          # 纯类型 + 与 dockview 双向映射（见 §3.3）
    │   ├── DockviewLayout.vue       # dockview-vue 集成（onReady / onDidLayoutChange）
    │   ├── layout.store.ts          # Pinia：mode + workspace + bootstrap/save（见 §3.2）
    │   ├── mode.ts                  # 编辑/运行双模式（header.hidden / group.locked）
    │   └── window-manager.ts        # window.open 弹窗机械 + floating/windows 登记
    │
    ├── features/
    │   └── hello/
    │       └── hello-pane.vue       # 示例 Pane（definePane 开发合同样板）
    │
    ├── components/
    │   ├── ui/                      # 通用组件库（18 个 · WS-1b，样式全走 tokens.css）
    │   │   ├── Button.vue · IconButton.vue · Input.vue · Textarea.vue · Select.vue
    │   │   ├── Checkbox.vue · Switch.vue · Modal.vue · Drawer.vue · Toast.vue
    │   │   ├── Tooltip.vue · Dropdown.vue · Tabs.vue · Card.vue · List.vue · Table.vue
    │   │   ├── Spinner.vue · EmptyState.vue
    │   │   └── index.ts             # 统一导出 + app.use(UiPlugin)
    │   └── layout/                  # 页面结构组件（3 个 · WS-1b）
    │       ├── PageHeader.vue · Section.vue · SplitPane.vue
    │
    ├── stores/
    │   └── service.store.ts         # service.* → 响应式服务状态表（useServiceStatus 写入）；session/ui 蓝图不建
    └── styles/
        ├── tokens.css               # CSS 变量（颜色/间距/圆角/z-index seed）
        └── base.css
```

---

## 2. 工作分解（WS-1 ~ WS-1b ~ WS-6）

### WS-1 · client 骨架（1d）

- [x] workspace：`package.json` + `vite.config.ts`（见 §3.7）+ `tsconfig.json` + `index.html` + `env.d.ts`
- [x] 依赖编排：`vue` / `vue-router` / `pinia` / `dockview-vue`；dev：`vite` / `typescript` / `vue-tsc`；test：`vitest` + `@vue/test-utils` + `jsdom` + `msw`
- [x] `main.ts` + `App.vue`（仅 RouterView）+ `router.ts`（三入口，见 §3.5）+ `styles/tokens.css` + `base.css`
- [x] `layouts/MainLayout.vue` + `layouts/TopBar.vue` 空壳（先不接 store）
- [x] **子绿灯**：`pnpm --filter @osteosome/client dev` 空页可跑；`/` 和 `/pane/foo` 分别命中 MainLayout / PaneHost

> **落地偏差（2026-09-24）**：① `tsconfig.json` 的 `extends` 取 `../tsconfig.base.json`（§1 写的 `../../` 是笔误，`client/` 与 `core/` 同级）；② **vite 锁 `^7`**——8.x 换 rolldown 内核后 `Plugin` 类型与 vitest 3 / `@vitejs/plugin-vue` 6 冲突（TS2769）；③ 实际版本 vue 3.5.43 / vue-router 5.3.1 / pinia 4.0.3 / dockview-vue 8.3.1 / vue-tsc 3.3.11；④ `router.ts` 额外导出 `routes` 与 `createAppRouter(history)`，测试用 memory history 复用同一张路由表（断言 `getRoutes()` 顺序按集合比较）；⑤ pnpm 11 用 `allowBuilds` 放行 esbuild + msw。

### WS-1b · 通用组件库 ui（2d）

> 评估补强（2026-09-23）：原 P1b 只有 Icon/Button/Toast 三个组件，Pane 空手起会糙。补齐 **18 个 ui + 3 个 layout** 组件（二轮 review 加 `Table`，hello-pane 服务清单 / P4 provider 列表 / P5 角色列表都要用），之后所有 Pane 一律用组件库实现（不再裸写样式）。

> **进度（2026-09-24）**：已完成 8 个 —— `Spinner` / `Button` / `IconButton` / `Input` / `Textarea` / `Select` / `Checkbox` / `Switch`（各带一个测试文件，覆盖渲染 / 交互 / v-model / 禁用态）。本轮补齐剩余 10 个 UI（`Modal` / `Drawer` / `Toast` / `Tooltip` / `Dropdown` / `Tabs` / `Card` / `List` / `Table` / `EmptyState`）与 3 个 layout 组件（`PageHeader` / `Section` / `SplitPane`），并新增 `components/ui/index.ts` + `UiPlugin`；client 全量测试共 75 条。约定：class 前缀 `ui-`，样式一律 scoped + 只取 `tokens.css` 变量，原生元素优先（`select` / `checkbox` / `textarea`），图标用文本字形（图标包不在 P1b 范围）。

- [x] `components/ui/` —— 18 个基础组件：Button / IconButton / Input / Textarea / Select / Checkbox / Switch / Modal / Drawer / Toast / Tooltip / Dropdown / Tabs / Card / List / **Table** / Spinner / EmptyState；全部消费 `tokens.css`（颜色/间距/圆角/z-index 走 CSS 变量，不 import 自定义 CSS）
- [x] `components/ui/index.ts` —— 统一导出 + `app.use(UiPlugin)` 全局注册
- [x] `components/layout/` —— PageHeader / Section / SplitPane（页面结构三件套）
- [x] 可访问性基线：交互组件键盘可达 + `aria-*`；Popover 类（Tooltip/Dropdown/Modal/Drawer）统一 focus-trap + Esc 关闭
- [x] **子绿灯**：每个组件一个测试文件（渲染 / 交互 / v-model / 禁用态最小集）；`tokens.css` 双主题下视觉抽查

**接口签名（props / emits / slots 一行摘要）**：

| 组件 | props | emits | slots |
|---|---|---|---|
| `Button` | `variant: 'primary'\|'ghost'\|'danger'`；`size`；`disabled`；`loading`；`type` | `click` | `default`（文本） |
| `IconButton` | `icon: string`；`size`；`disabled`；`label`（a11y 必填） | `click` | – |
| `Input` | `modelValue`；`placeholder`；`disabled`；`type`；`clearable` | `update:modelValue`；`clear`；`enter` | `prefix` / `suffix` |
| `Textarea` | `modelValue`；`rows`；`placeholder`；`disabled`；`autoGrow` | `update:modelValue` | – |
| `Select` | `modelValue: string\|number`；`options: {label,value,disabled?}[]`；`disabled`；`placeholder` | `update:modelValue` | – |
| `Checkbox` | `modelValue: boolean`；`label?`；`disabled`；`indeterminate` | `update:modelValue` | – |
| `Switch` | `modelValue: boolean`；`disabled` | `update:modelValue` | – |
| `Modal` | `open`；`title?`；`width?`；`closable`；`maskClosable` | `update:open`；`close` | `header?` / `default` / `footer` |
| `Drawer` | `open`；`title?`；`side: 'left'\|'right'`；`size` | `update:open`；`close` | `header?` / `default` / `footer` |
| `Toast` | 命令式 `toast(msg, {type?, duration?, action?})`（非 props 场景） | – | – |
| `Tooltip` | `content: string`；`placement`；`delay` | – | `default`（触发元素） |
| `Dropdown` | `items: {label,value,disabled?,danger?}[]`；`trigger: 'click'\|'hover'` | `select(value)` | `default`（触发元素） |
| `Tabs` | `tabs: {key,label,disabled?}[]`；`modelValue` | `update:modelValue` | 内容走 `tab:<key>` 具名 slot 或子区 |
| `Card` | `title?`；`padding?`；`hoverable?` | – | `header?` / `default` / `footer?` |
| `List` | `items: T[]`；`virtual?` | `select(index)` | `item`（scoped `{item,index}`）；`empty` |
| `Table` | **props 驱动，零模板耦合**：`columns: {key,label?,align?,slot?}[]`；`rows: Record<string,unknown>[]`；`rowKey: string`；`loading?`；`emptyText?` | – | 单元格可走 `slot[<key>]`（作用域 `{row, value}`） |
| `Spinner` | `size`；`label?` | – | – |
| `EmptyState` | `icon?`；`title`；`description?` | `action` | `action?`（按钮区） |
| `PageHeader`（layout） | `title`；`subtitle?`；`back?` | `back` | `actions`（右侧按钮区） |
| `Section`（layout） | `title?`；`collapsible?`；`defaultOpen?` | `toggle` | `default` |
| `SplitPane`（layout） | `direction`；`initialRatio`；左右 `min` | `update:ratio` | `left` / `right` |

### WS-2 · 布局引擎（2.5d）

- [ ] `layout/types.ts` —— `Layout` / `WorkspaceLayout` / `PaneId`（§3.3 完整定义）
- [ ] `layout/layout.model.ts` ——
  - `defaultWorkspace(): WorkspaceLayout`
  - `applyDefaultSlot(ws, pane, area, index): WorkspaceLayout`
  - `toDockviewGrid(layout, paneMeta): SerializedDockview`
  - `fromDockviewGrid(grid): Layout`
  - `serializeWorkspace(ws): string` / `parseWorkspace(json): WorkspaceLayout | null`（非法 → null）
  - **全部纯函数，不依赖 dockview 运行时**，可单独单测
- [ ] `layout/layout.store.ts` —— Pinia（§3.2 完整签名）
  - state：`mode` / `workspace` / `hydrated` / `saving` / `lastError`
  - actions：`bootstrap()` / `updateWorkspace(next)` / `setMode(mode)` / `scheduleSave()` / `resetLayout()`
- [ ] `layout/DockviewLayout.vue` ——
  - `onReady({ api })` → `api.fromJSON(toDockviewGrid(store.workspace, paneMeta))`
  - `api.onDidLayoutChange(() => store.updateWorkspace(fromDockviewGrid(api.toJSON())))`
  - `api.onDidAddGroup(group => applyModeToGroup(group, store.mode))`（事后新建组跟随模式）
  - `watch(store.mode, () => applyModeToAllGroups(api, store.mode))`
- [ ] `layout/mode.ts` —— `applyModeToGroup(group, mode)` / `applyModeToAllGroups(api, mode)`（§3.4）
- [ ] 主题：`tokens.css` 里声明 `--dv-overlay-z-index: 2000`（默认 999，弹窗 ≥1000 会遮挡）
- [ ] **子绿灯**：
  - 空 dockview 可渲染
  - 拖拽换位后 `store.workspace` 正确更新（`fromDockviewGrid` 输出可读 JSON）
  - 刷新浏览器 → GET `/api/preferences` → `toDockviewGrid` 还原同一布局
  - `store.setMode('runtime')` → 全部 group `header.hidden=true` + `locked=true`

### WS-3 · core-sdk（1.5d）

- [x] `sse.ts` —— **单例状态机**（§3.4 完整实现）
  - state：`disconnected | connecting | connected | reconnecting`
  - `subscribe(topic, handler): disposer` / `ensureConnected()` / `close()`
  - topics 集合动态合并；变更时重连（带新 `?topics=`）
  - 分发：`event: message` → 解析 body `{ topic, payload }` → 分发到订阅者
  - 断线重连：浏览器原生 + 90s 无消息主动 close 重建（TCP 静默断开兜底）
- [x] `useEventBus(topic, handler)` —— 组件 onMounted 订阅 / onUnmounted 退订；支持通配符透传
- [x] `useCommand` —— `POST /api/command`（202 即返回；错误打日志不抛）
- [x] `useServiceStatus` —— 订阅 `service.*` → 写 Pinia `serviceStore`（响应式服务状态表）
- [x] `usePreferences` —— `GET` / `PUT` 封装
- [x] **子绿灯**：core-sdk 单测（注入 `FakeEventSource`，断言单例唯一 / topics 合并只重连一次 / 分发 / 90s 兜底 / 清理）

### WS-4 · Pane 契约与宿主（2d）

- [x] `panes/types.ts` —— `PaneDefinition`（§3.1）
- [x] `panes/registry.ts` ——
  - `definePane(def)`：id 唯一校验、缺 id/title 拒绝（抛错）
  - `import.meta.glob('../features/*/*-pane.vue', { eager: true })` 自动发现（**Vite glob 不支持 `@` 别名**，必须相对 `registry.ts` 的路径）
  - `getPane(id)` / `listPanes()` / `defaultPanelsFor(ws)`
- [x] `panes/PaneFrame.vue` —— 标题栏（4 个交互，见 §3.6 wireframe）+ `onBeforeClose` 拦截
- [x] `panes/PaneError.vue` —— `defineAsyncComponent` 的 `onError` 兜底，**不改布局**
- [x] `panes/PaneHost.vue` —— 弹窗入口：迷你标题栏 + 单 Pane（不带 TopBar / DockviewLayout）；挂载时 `sse.ensureConnected()`
- [x] `layout/window-manager.ts` ——
  - `open(paneId): Window | null`（同 pane 已开 → 聚焦不重开；**被浏览器弹窗拦截返回 null** → 调用方 Toast 提示「请允许弹窗」）
  - 内部登记 `popups: Map<PaneId, Window>`
  - `popup.onbeforeunload` → 清理登记
- [x] **子绿灯**：`definePane` 一个 pane 可停靠；点「拉出」→ `window.open` 打开 `#/pane/<id>`，内容与主窗一致

### WS-5 · 首个示例 Pane（1d）

- [x] `features/hello/hello-pane.vue` —— `definePane` 完整样板（§3.1）；**全部用 WS-1b 组件库渲染**（Table/List/Card/Button/EmptyState/Spinner）
  - 内容：`useServiceStatus` 展示服务清单（验证 core-sdk 全链路）
  - **服务清单用 `Table`**（`columns: serviceId / status / 最后心跳`）；空态用 EmptyState
  - **hello-pane 底部「发送 hello.command」按钮** —— `useCommand` POST `/api/command { topic: 'hello.command', payload: { requestId, text: 'hi' } }`；SSE 收 `hello.command.started/executed`（Toast 显示 echo），验证 `/api/command` 命令链路
  - **wireframe 见 §3.6**
- [x] 端到端：
  - 拖拽换位 → 刷新浏览器 → 布局还原
  - 拉出独立窗 → 内容一致（同源 SSE，天然共享）
  - 运行模式：顶部栏隐藏、拖拽锁定、hello-pane 内容全占
- [x] **子绿灯**：hello-pane 显示来自 Core 的 `service.*` 状态；三条链路全通

### WS-6 · 收尾（0.5d）

- [x] `../core开发文档.md` §8 勾选 P1b
- [x] `阶段追踪.md` P1b 状态更新（全部绿灯通过才标 ✅；且前置 P1a 须已完成）
- [x] 绿灯全集复跑：vitest + vue-tsc + vite build + **Core 集成冒烟**

---

## 3. 接口定案（P1b 补齐）

### 3.1 PaneDefinition —— RFC §11.2 原样实现

```ts
// panes/types.ts
import type { Component } from 'vue'

export interface PaneDefinition {
  id: string
  title: string
  icon?: string
  component: () => Promise<{ default: Component }>
  defaultSlot?: { area: 'left' | 'right' | 'bottom'; index: number }
  windowable?: boolean                        // 默认 true
  minSize?: { w: number; h: number }
  onBeforeClose?: () => boolean | Promise<boolean>
}
```

开发合同（双 `<script>` 形式，§11.2 样板）：

```vue
<!-- features/hello/hello-pane.vue -->
<script lang="ts">
import { definePane } from '@/panes/registry'
export default definePane({
  id: 'pane.hello',
  title: 'Hello',
  defaultSlot: { area: 'right', index: 0 },
  windowable: true,
  component: () => import('./HelloPane.vue'),
})
</script>

<script setup lang="ts">
// 组件逻辑
</script>
```

### 3.2 layout.store —— Pinia 接口

```ts
// layout/layout.store.ts
import { defineStore } from 'pinia'
import type { WorkspaceLayout } from './types'
import { defaultWorkspace, parseWorkspace, serializeWorkspace } from './layout.model'
import { usePreferences } from '@/core-sdk/usePreferences'

type Mode = 'edit' | 'runtime'

interface LayoutState {
  mode: Mode                       // v1 不落 preferences（刷新回 edit）
  workspace: WorkspaceLayout       // 当前布局（唯一真相源）
  hydrated: boolean                // 是否已从服务端恢复过
  saving: boolean                  // 是否正在 PUT
  lastError: string | null         // 最近一次错误的用户可读消息
}

export const useLayoutStore = defineStore('layout', {
  state: (): LayoutState => ({
    mode: 'edit',
    workspace: defaultWorkspace(),
    hydrated: false,
    saving: false,
    lastError: null,
  }),

  actions: {
    /** MainLayout 挂载时调用一次：从 /api/preferences 恢复布局 */
    async bootstrap() {
      try {
        const prefs = await usePreferences().get()
        const parsed = prefs.layout ? parseWorkspace(prefs.layout) : null
        this.workspace = parsed ?? defaultWorkspace()
        if (prefs.layout && !parsed) {
          this.lastError = '布局已损坏，已重置为默认'
        }
      } catch (e) {
        this.lastError = '加载布局失败，已重置为默认'
        this.workspace = defaultWorkspace()
      } finally {
        this.hydrated = true
      }
    },

    /** dockview 拖拽/换位 → 写回 */
    updateWorkspace(next: WorkspaceLayout) {
      this.workspace = next
      this.scheduleSave()
    },

    setMode(mode: Mode) { this.mode = mode },

    /** 防抖 500ms 落盘 */
    scheduleSave: (() => {
      let timer: ReturnType<typeof setTimeout> | null = null
      return function (this: { _save: () => Promise<void> }) {
        if (timer) clearTimeout(timer)
        timer = setTimeout(() => this._save(), 500)
      }
    })(),

    /** 实际落盘 */
    async _save() {
      this.saving = true
      try {
        await usePreferences().put({ layout: serializeWorkspace(this.workspace) })
      } catch (e) {
        this.lastError = '保存布局失败'
      } finally {
        this.saving = false
      }
    },

    /** 重置为默认布局（PaneFrame 的 ⇱ 按钮调用） */
    resetLayout() {
      this.workspace = defaultWorkspace()
      this.scheduleSave()
    },
  },
})
```

**约定**：`DockviewLayout` 只读 `store.workspace` 渲染、只调 `store.updateWorkspace()` 写回；**不直接碰 `usePreferences`**。

### 3.3 Layout 与 dockview 双向映射（layout.model.ts）

**核心原则**：`Layout` 是我们的真相源，dockview 只是**可替换的渲染引擎**。

```ts
// layout/types.ts
export type PaneId = string

export type Layout =
  | { kind: 'row'; children: Layout[] }        // 水平分割
  | { kind: 'col'; children: Layout[] }        // 垂直分割
  | { kind: 'pane'; id: PaneId }               // 叶子

export interface WorkspaceLayout {
  dock: Layout
  floating: { paneId: PaneId; size: { w: number; h: number } }[]
  windows: { paneId: PaneId; rect: { x: number; y: number; w: number; h: number } }[]
}
```

```ts
// layout/layout.model.ts —— 纯函数，可单测
import type { SerializedDockview } from 'dockview-core'
import type { Layout, WorkspaceLayout, PaneId } from './types'

export function defaultWorkspace(): WorkspaceLayout
export function applyDefaultSlot(
  ws: WorkspaceLayout,
  pane: { id: PaneId; slot: { area: 'left' | 'right' | 'bottom'; index: number } },
): WorkspaceLayout

/** 自己的 Layout → dockview 序列化格式 */
export function toDockviewGrid(
  layout: Layout,
  paneMeta: Map<PaneId, { title: string }>,
): SerializedDockview

/** dockview 序列化格式 → 自己的 Layout */
export function fromDockviewGrid(grid: SerializedDockview): Layout

export function serializeWorkspace(ws: WorkspaceLayout): string
export function parseWorkspace(json: string): WorkspaceLayout | null   // 非法 → null
```

**两条硬性约束**（写进 §6 风险表）：

1. ❌ **不持久化 `api.toJSON()` 的原始输出**——它含 dockview 版本敏感字段
2. ✅ **持久化自己的 `WorkspaceLayout`**——dockview 升级时只改 `toDockviewGrid` / `fromDockviewGrid`
3. ✅ 布局恢复失败 → **fallback 到默认布局 + Toast 提示**，不崩白屏

### 3.4 sse.ts 单例状态机（core-sdk）

**状态**：`disconnected → connecting → connected → reconnecting → disconnected`

```ts
// core-sdk/sse.ts
type State = 'disconnected' | 'connecting' | 'connected' | 'reconnecting'
type Handler = (payload: unknown) => void

class SseClient {
  private es: EventSource | null = null
  private state: State = 'disconnected'
  private topics = new Set<string>()
  private handlers = new Map<string, Set<Handler>>()
  private lastMessageAt = 0
  private silenceTimer: ReturnType<typeof setInterval> | null = null

  /** 订阅：加入 topic 集合；必要时重连（带新 ?topics=） */
  subscribe(topic: string, handler: Handler): () => void {
    if (!this.handlers.has(topic)) this.handlers.set(topic, new Set())
    this.handlers.get(topic)!.add(handler)

    const isNewTopic = !this.topics.has(topic)
    this.topics.add(topic)

    if (this.state === 'disconnected') {
      this.reconnect()
    } else if (isNewTopic) {
      this.reconnect()                    // topics 变更 → 重建连接
    }
    return () => this.unsubscribe(topic, handler)
  }

  /** 主动确保连接（PaneHost 弹窗挂载时调用） */
  ensureConnected() {
    if (this.state === 'disconnected') this.reconnect()
  }

  private unsubscribe(topic: string, handler: Handler) {
    this.handlers.get(topic)?.delete(handler)
    if (this.handlers.get(topic)?.size === 0) this.handlers.delete(topic)

    // topic 集合收缩 → 重建连接；全空 → 关闭
    const hadTopic = this.topics.delete(topic)
    if (this.topics.size === 0) {
      this.close()
    } else if (hadTopic) {
      this.reconnect()
    }
  }

  private reconnect() {
    this.es?.close()
    this.state = 'connecting'
    const qs = [...this.topics].join(',')
    this.es = new EventSource(`/events?topics=${encodeURIComponent(qs)}`)

    this.es.addEventListener('open', () => {
      this.state = 'connected'
      this.lastMessageAt = Date.now()
    })

    this.es.addEventListener('message', (e: MessageEvent) => {
      this.lastMessageAt = Date.now()
      try {
        const { topic, payload } = JSON.parse(e.data)
        this.handlers.get(topic)?.forEach(h => h(payload))
      } catch { /* 打日志，不崩 */ }
    })

    this.es.addEventListener('error', () => {
      // 浏览器 EventSource 会自动重连，但不会更新 topics
      this.state = 'reconnecting'
    })

    this.startSilenceWatchdog()
  }

  /** 90s 无任何消息 → 主动 close 重建（TCP 静默断开兜底） */
  private startSilenceWatchdog() {
    if (this.silenceTimer) clearInterval(this.silenceTimer)
    this.silenceTimer = setInterval(() => {
      if (Date.now() - this.lastMessageAt > 90_000) {
        this.reconnect()
      }
    }, 30_000)
  }

  close() {
    this.es?.close()
    this.es = null
    this.state = 'disconnected'
    if (this.silenceTimer) clearInterval(this.silenceTimer)
    this.silenceTimer = null
  }

  getState() { return this.state }
}

export const sse = new SseClient()
```

**可测断言**（写进 §4 测试矩阵）：

- 5 个 `subscribe` 只触发 2 次连接（首次 + topics 变更 1 次）
- `unsubscribe` 到 topics 空 → `close()`，状态 `disconnected`
- 90s 无 message → 自动重连（用 fake timers）

### 3.5 三入口路由（router.ts）

```ts
// router.ts
import { createRouter, createWebHashHistory } from 'vue-router'

const routes = [
  { path: '/',         component: () => import('@/layouts/MainLayout.vue') },
  { path: '/pane/:id', component: () => import('@/panes/PaneHost.vue'), props: true },
  { path: '/:pathMatch(.*)*', redirect: '/' },
]

export const router = createRouter({
  history: createWebHashHistory(),    // Electron file:// 兼容；弹窗 URL 稳定
  routes,
})
```

**入口职责**：

| 入口 | 文件 | 职责 |
|---|---|---|
| `App.vue` | `src/App.vue` | 只 `<RouterView/>`，**无业务装配** |
| 主窗 | `layouts/MainLayout.vue` | TopBar + DockviewLayout；挂载时 `layout.bootstrap()` |
| 弹窗 | `panes/PaneHost.vue` | 迷你标题栏 + 单 Pane；挂载时 `sse.ensureConnected()`；**不挂 TopBar / DockviewLayout** |

### 3.6 UI wireframe

#### 主窗整体（MainLayout）

```
┌──────────────────────────────────────────────────────────────────┐
│ TopBar                                                            │
│ ┌──────────────────────────────┬──────────────────────────────┐  │
│ │ 🟢 服务 3/3 就绪             │ [编辑] [运行]  ← 模式切换     │  │
│ └──────────────────────────────┴──────────────────────────────┘  │
├──────────────────────────────────────────────────────────────────┤
│ DockviewLayout                                                   │
│ ┌──────────────┬───────────────────────┬──────────────────────┐  │
│ │ hello        │                       │                      │  │
│ │ PaneFrame    │      (空网格)          │   (未停靠的 Pane)     │  │
│ │ ┌──┬──┬──┐   │                       │                      │  │
│ │ │ ⇱│ ⤢│ ×│   │                       │                      │  │
│ │ └──┴──┴──┘   │                       │                      │  │
│ │              │                       │                      │  │
│ └──────────────┴───────────────────────┴──────────────────────┘  │
└──────────────────────────────────────────────────────────────────┘
```

#### PaneFrame 标题栏（4 个交互）

```
┌──────────────────────────────────────────────────┐
│ ⠿ 图标 标题                ⇱ 重置  ⤢ 拉出  × 关闭 │  ← 拖拽把手 = 标题栏
├──────────────────────────────────────────────────┤
│                                                  │
│                Pane 内容                          │
│                                                  │
└──────────────────────────────────────────────────┘
```

| 按钮 | 动作 | 实现 |
|---|---|---|
| ⠿ 标题栏 | 拖拽移动 / 换位 | dockview 内建（`header` 默认可拖） |
| ⇱ 重置 | 恢复默认槽位 | `store.resetLayout()` |
| ⤢ 拉出 | 新窗口 | `window-manager.open(paneId)` |
| × 关闭 | 卸载面板 | `api.removePanel(id)`（自动触发 `onDidLayoutChange` → store 写回） |

`onBeforeClose` 拦截 → 返回 `false` 时**不关闭**，弹提示。

#### PaneHost（弹窗 `#/pane/:id`）

```
┌──────────────────────────────────────┐
│ ⠿ 图标 标题                            │  ← 迷你标题栏（可拖拽，无菜单）
├──────────────────────────────────────┤
│                                      │
│           Pane 内容                   │
│                                      │
└──────────────────────────────────────┘
```

#### hello-pane（示例 Pane）

```
┌──────────────────────────────────────────────┐
│ Hello                                         │
├──────────────────────────────────────────────┤
│ 服务状态                                       │
│ ┌──────────────┬─────────┬──────────────────┐ │
│ │ serviceId    │ status  │ 最后心跳          │ │
│ ├──────────────┼─────────┼──────────────────┤ │
│ │ hello        │ 🟢 ready │ 2s 前           │ │
│ │ ...          │ ...      │ ...              │ │
│ └──────────────┴─────────┴──────────────────┘ │
│                                               │
│ [发送 hello.command]  ← 演示命令链路           │
└──────────────────────────────────────────────┘
```

### 3.7 vite.config.ts

```ts
// client/vite.config.ts
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { fileURLToPath, URL } from 'node:url'

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  server: {
    port: 5173,
    proxy: {
      '/events':  { target: 'http://127.0.0.1:1420', changeOrigin: true },
      '/api':     { target: 'http://127.0.0.1:1420', changeOrigin: true },
      '/runtime': { target: 'http://127.0.0.1:1420', changeOrigin: true },
    },
  },
  build: {
    outDir: '../core/dist/client',   // 打包产物给 Core 托管
    emptyOutDir: true,
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test-setup.ts'],
  },
})
```

### 3.8 编辑 / 运行双模式（§3.4 补充定案）

| 模式 | 顶部栏 | 面板拖拽 | 组件重叠 |
|---|---|---|---|
| **编辑（edit）** | 显示 | 启用 | 不启用 |
| **运行（runtime）** | **隐藏** | **禁用** | **启用** |

```ts
// layout/mode.ts
import type { DockviewApi, DockviewGroupPanel } from 'dockview-core'

export type Mode = 'edit' | 'runtime'

export function applyModeToGroup(group: DockviewGroupPanel, mode: Mode) {
  group.header.hidden = mode === 'runtime'
  group.locked = mode === 'runtime'
}

export function applyModeToAllGroups(api: DockviewApi, mode: Mode) {
  api.groups.forEach(g => applyModeToGroup(g, mode))
}
```

| 能力 | 实现 |
|---|---|
| 隐藏顶部栏 | `group.header.hidden = true`（v8 下高度为 0，内容自动占满组区域） |
| 锁定拖拽 | `group.locked = true` |
| 组件重叠 | **浮动组**——`api.addPanel({ floating: true, position })` 或 `api.addFloatingGroup(panel, {...})` |
| 运行模式固定浮动组 | `floatingGroupDragHandle: 'tabbar'`（禁用把手） |
| z-index | 主题变量 `--dv-overlay-z-index: 2000`（浮动组默认 999，弹窗 ≥1000 会遮挡） |

**模式态归属**：`layout.store.mode`（默认 `'edit'`），**v1 不落 preferences**（刷新回编辑模式；如需持久化后续再开）。

**关键钩子**（DockviewLayout.vue）：

```ts
api.onDidAddGroup(group => applyModeToGroup(group, store.mode))   // 事后新建组跟随当前模式
watch(() => store.mode, mode => applyModeToAllGroups(api, mode))  // 模式切换时同步全部组
```

---

## 4. 测试矩阵

| 模块 | 用例要求（至少覆盖） |
|---|---|
| `layout.model` | row/col/pane 序列化往返、`applyDefaultSlot`（area+index）、非法 JSON → null、空树、`toDockviewGrid` / `fromDockviewGrid` 互转一致性 |
| `layout.store` | `bootstrap` GET 恢复、变更防抖 PUT（faketimer）、PUT 失败置 `lastError`、`resetLayout` 覆盖 |
| `mode` | enter/exit 切换 `header.hidden` 与 `locked`、`onDidAddGroup` 事后新建组跟随、运行模式浮动组把手禁用 |
| `sse` | 单例唯一、多订阅 topics 合并只重连一次、message 分发到对应订阅者、`unsubscribe` 到空 → close、90s 兜底重连（faketimer）、`close` 清理 |
| `useEventBus` | 挂载订阅 / 卸载退订、payload 透传 |
| `useCommand` | POST 到 `/api/command`、202 不抛、非 2xx 打日志不抛 |
| `useServiceStatus` | 订阅 `service.*` → 写 Pinia、状态表响应式更新 |
| `registry` | `definePane` 重复 id 拒绝、缺 id/title 拒绝、glob 自动发现、PaneDefinition 校验 |
| `PaneFrame` | 挂载渲染 pane、标题栏 4 按钮动作、`onBeforeClose` 返回 `false` 时不关 |
| `PaneHost` | `#/pane/:id` 命中渲染、`id` 不存在 → PaneError 占位、挂载时 `sse.ensureConnected` |
| `PaneError` | `defineAsyncComponent` 加载失败 → 占位渲染，**不改布局** |
| `window-manager` | 登记/恢复、同 pane 防重复拉出（聚焦不重开）、`onbeforeunload` 清理 |
| `router` | `/` → MainLayout、`/pane/foo` → PaneHost、`/*` → 重定向 |
| `TopBar` | 服务状态徽章随 `service.*` 更新、模式切换按钮触发 `store.setMode` |
| `ui` · 表单类（Input/Textarea/Select/Checkbox/Switch） | `v-model` 双向、禁用态、键盘可达 |
| `ui` · 按钮类（Button/IconButton） | `click` 事件、`disabled`、`loading` |
| `ui` · 弹层类（Modal/Drawer/Dropdown/Tooltip） | open/close、Esc 关闭、focus-trap、点击遮罩 |
| `ui` · 展示类（Card/List/Table/Spinner/EmptyState） | 渲染、插槽、空态、Table 列/单元格 slot/`rowKey` |
| `ui` · 导航类（Tabs） | `v-model`、键盘切换 |
| `layout`（PageHeader/Section/SplitPane） | 插槽布局、默认 props、窄屏折叠 |

**Mock 策略**：

| 依赖 | mock 方式 |
|---|---|
| `EventSource` | `vi.stubGlobal('EventSource', FakeEventSource)`（可手动 `emit('message', {data})` / `emit('open')` / `emit('error')`） |
| `fetch` | `msw`（Mock Service Worker）拦截 `/api/*`；或 `vi.stubGlobal('fetch', ...)` |
| dockview `api` | 手写 `FakeDockviewApi`（`addPanel` / `removePanel` / `onDidLayoutChange` / `toJSON` 最小实现） |
| `window.open` | `vi.spyOn(window, 'open').mockReturnValue(fakeWin)` |
| Pinia | `createTestingPinia()` |
| Router | `createRouter({ history: createMemoryHistory(), routes })` |

---

## 5. 绿灯标准

```powershell
# 单测全绿
pnpm --filter @osteosome/client test          # 等价 npm test --prefix client

# 构建零错误
pnpm --filter @osteosome/client build         # vue-tsc + vite build

# 集成冒烟（需 P1a Core 在场）
#  - 起 core（P1a） → 起 vite dev
#  - hello-pane 显示 service.* 状态（含 hello 服务 ready）
#  - 布局拖拽 → 刷新浏览器 → 布局还原
#  - 拉出独立窗 → 内容与主窗一致（同源同一 SSE 数据）
#  - 运行模式：全部顶部栏隐藏（内容占满）、拖拽锁定、overlay 浮动按钮浮于面板之上（--dv-overlay-z-index 不被弹窗遮挡）
#  - 布局损坏（手改 preferences 为非法 JSON）→ 重置为默认 + Toast
#  - UI 抽查：hello-pane 全部由 ui 组件库渲染（无裸 div 硬编码样式）
```

---

## 6. 风险与决策

| 主题 | 决策 / 规避 |
|---|---|
| **dockview 耦合** | 只走自己的 `Layout` 类型；dockview 当渲染引擎，面板 id = `PaneDefinition.id`；**不持久化 dockview 内部序列化格式**，只持久化 `WorkspaceLayout`。升级时只改 `toDockviewGrid` / `fromDockviewGrid` |
| **布局损坏** | `parseWorkspace` 返回 `null` → fallback `defaultWorkspace()` + Toast 提示（`store.lastError`）；不崩白屏 |
| **SSE 单例存活** | topics 集合动态合并：新订阅挂载即补请求；退订只移除分发，**集合非空不关连接**；全空才 `close()`。满足 Chrome 6 连接上限 |
| **SSE 静默断开** | 浏览器原生重连不覆盖 TCP 静默断开 → 90s 无消息主动 `close` + `reconnect()` |
| **刷新还原** | 布局落 `/api/preferences`（服务端真源，天然跨窗共享）；本地刷新 GET 恢复 |
| **拉出独立窗** | P1b 用纯网页 `window.open`；Electron `BrowserWindow` 桥留待阶段 3；`window-manager` 作为**唯一切换点** |
| **禁止页面级装配** | 新增信息面一律 `definePane`（不变式 #6）；`App.vue` **只放 RouterView**，不含业务面板清单 |
| **P1b 绿灯依赖 P1a** | 冒烟依赖 Core 在场：CI 串行声明（core job 先行），或冒烟脚本自动拉起 core |
| **z-index 层级冲突** | 浮动组默认 999，弹窗 ≥1000 会遮挡 → `--dv-overlay-z-index: 2000`（主题变量统一管控） |
| **事后新建组漏设模式** | dockview `onDidAddGroup` 钩子按当前 mode 应用 `header.hidden` / `locked` |
| **Pane 加载失败** | `defineAsyncComponent` 的 `onError` → 渲染 `PaneError` 占位，**不改布局**（保留位置便于重试） |
| **模式态持久化** | v1 **不落 preferences**（刷新回 edit）；如需持久化后续单开 |
| **组件库依赖纪律** | ui 组件只依赖 `tokens.css`，不许 import 自定义样式；主题切换 = 切 `data-theme` 属性；后续 i18n/主题系统延后到 P4（见 `P4-详细计划.md`） |

---

## 7. 开工顺序

```
P1a 全绿
  └► WS-1 client 骨架（可与 P1a 并行起头，冒烟后合）
      └► WS-1b 通用组件库（只依赖 WS-1 的 tokens.css，可与 WS-2/3/4 并行）
      └► WS-2 布局引擎 ──────────────┐
      └► WS-3 core-sdk（可与 WS-2 并行）├─► WS-5 首个 Pane
      └► WS-4 Pane 契约与宿主 ──────┘       │
                                            └► WS-6 收尾
```

- WS-1b / WS-2 / WS-3 / WS-4 相对独立，搞定 `PaneDefinition` + `Layout` + `sse` + `ui` 契约后可并行推进、各带测试。
- WS-5 依赖 WS-1b + WS-2 + WS-3 + WS-4 全套才端到端（**WS-1b 必须在 WS-5 前收尾**）。
- 每个 WS 单独 commit，回合一个 PR；WS-6 时整个 P1b PR 合并。

---

## 本次补齐的内容摘要

| 补齐项 | 位置 |
|---|---|
| **五处接口级细节** | §3 整章（原 P1b 只有 PaneDefinition + Layout） |
| 三入口路由 + App/MainLayout/PaneHost 职责 | §3.5 + WS-1 |
| dockview 双向映射（`toDockviewGrid` / `fromDockviewGrid`） | §3.3 + WS-2 |
| layout.store 完整 Pinia 接口 | §3.2 + WS-2 |
| sse.ts 单例状态机（含 90s 兜底） | §3.4 + WS-3 |
| UI wireframe（主窗 / PaneFrame / PaneHost / hello-pane） | §3.6 + WS-4 + WS-5 |
| vite.config.ts 完整配置 | §3.7 + WS-1 |
| 双模式实现细节 + 钩子 | §3.8 + WS-2 |
| 测试 mock 策略表 | §4 |
| 新增文件：`router.ts` / `MainLayout.vue` / `TopBar.vue` / `PaneError.vue` | §1 |
| **通用组件库（ui 18 + layout 3）＋ WS-1b** | §1 + WS-1b + §4（测试矩阵）+ §7 |
| 风险表新增 6 行 | §6 |

