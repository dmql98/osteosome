# 对话流组件 Demo — osteosome 插件化形态

> 这是**前端组件形态的开发参考**，不是完整可运行产品。
> 目标：把「对话流」拆成符合 osteosome 插件化架构的组件，
> 让后续实际开发时可以直接照抄结构与契约。

---

## 1. 这份 Demo 做了什么 / 没做什么

| | 做 | 不做 |
|---|---|---|
| **组件拆分** | ✅ 6 个顶层组件，各一文件一页；内部构造合在对话流里 | — |
| **设计令牌** | ✅ `--color-*` / `--space-*` / `--motion-*`，一份文件 | — |
| **widget 注册** | ✅ `registry.defineWidget` / `resolveWidget` 三态 | — |
| **插件清单** | ✅ `ui.views[]` 声明 widget id | Core 扫盘 plugin.json |
| **状态派生** | ✅ 事件流 → 订阅 → 拼视图 | 真 SSE / 真服务 |
| **iframe 装载** | ❌ | `PluginWidgetHost` + postMessage 握手 |
| **跨 iframe 同步** | ❌ | sessionStorage + storage 事件 |
| **拖拽摆位** | ❌ | `vue-movable-box` + dockview |
| **顶栏 / 图标轨** | ❌（Demo 残留，已删） | 宿主自带 |

**为什么不做 iframe**：Demo 要能双击 `index.html` 直接打开看效果。
拆成 iframe 后，跨视图的状态同步必须走 `sessionStorage` + `storage` 事件
（osteosome 的真实做法），演示成本高且掩盖了组件本身的形态。
真实实现时按 osteosome 的路子走即可，组件代码不用改。

---

## 2. 怎么用

### 组件陈列（主要用途）

**`components/index.html`** 是入口，列出全部 5 个顶层组件。点任意一张卡片进入该组件的独立页面，
每页包含三段：

1. **示例** —— 该组件的所有关键状态（不是只有 happy path）
2. **接口契约** —— props / emits 表格，含类型与默认值
3. **设计要点** —— 为什么这么设计，以及它对应 osteosome 的哪个文件

每个组件一个独立 HTML，可以单独打开、单独发给同事、单独截图放进文档。

| 组件 | 页面 | 对应 osteosome 文件 |
|---|---|---|
| **对话流** | `components/timeline.html` | `plugins/chat-workbench/ui/src/views/ChatTimelineView.vue` + `packages/client/ui-chat/` + `ui-tool/` |
| **对话列表** | `components/sessionlist.html` | `plugins/chat-workbench/ui/src/views/SessionListView.vue` |
| **输入框** | `components/composer.html` | `plugins/chat-workbench/ui/src/views/ChatComposerView.vue` |
| **检查器** | `components/workspace.html` | `plugins/chat-workbench/ui/src/views/SessionWorkspaceView.vue` |
| **工作区管理** | `components/workspace-manager.html` | `plugins/chat-workbench/ui/src/views/SessionWorkspaceView.vue`（工作区部分）+ `plugins/tools/services/workspace` |
| **审批块** | `components/approval.html` | `packages/client/ui-approval/src/client/ApprovalPanel.tsx` |

### 组件粒度

**6 个顶层组件**，不是 12 个。思考块、对话框、Turn 导航轨、工具调用树、统计栏
都是**对话流的内部构造**，不是平级的顶层组件。

理由：widget 是宿主摆位的单位。用户拖动的、面板里放着的，是「对话流」这一个盒子，
不是五个。拆成五个 widget 意味着用户要自己拼 —— 那是另一个产品的形态。

内部拆开是因为它们的展开策略各自独立：

| 内部构造 | 展开策略 |
|---|---|
| 思考块 | 默认展开，内容与正文分离 |
| 工具调用树 | 默认折叠，运行时自动展开 |
| 对话框 | 常驻，流式时跟呼吸光标 |
| 统计栏 | 常驻，但操作按钮 hover 才显形 |
| Turn 导航轨 | 跟随滚动，当前轮高亮 |

### 完整工作台

**`index.html`**（根目录）把全部组件装配成一个可交互的工作台：
能发消息、触发流式输出、触发审批接管、折叠面板。

## 3. 目录结构

```
ost-chat-demo/
├── index.html                      # 完整工作台（装配全部组件）
├── components/                     # ★ 组件陈列 —— 每个组件一个独立 HTML
│   ├── index.html                  #   索引页
│   ├── timeline.html               #   对话流
│   ├── sessionlist.html            #   对话列表
│   ├── composer.html               #   输入框
│   ├── workspace.html              #   检查器
│   ├── workspace-manager.html      #   工作区管理
│   └── approval.html               #   审批块
├── styles/
│   ├── tokens.css                  # 设计令牌（对应 sdk/ui/src/tokens.css）
│   ├── base.css                    # 全局基础样式
│   └── doc.css                     # 组件陈列页的版式
├── vendor/
│   └── vue.global.prod.js          # Vue 3 运行时（真实实现用 npm 装）
└── src/
    ├── doc/
    │   └── loader.js               # 组件陈列页的公共装载器（导航 + 契约表 + 主题）
    ├── core/
    │   └── registry.js             # widget 注册表 ← client/src/widgets/registry.ts
    ├── ui/
    │   ├── index.js                # 共享展示组件库 ← sdk/ui/src/
    │   └── styles.css              # 组件样式
    ├── host/                       # 宿主外壳 ← client/src/
    │   ├── app.js                  # 主装配 ← client/src/main.ts
    │   ├── AppFrame.js             # 布局框架 ← layouts/MainLayout.vue + panes/default-layout.ts
    │   └── styles.css
    └── plugins/chat-workbench/     # 插件 ← plugins/chat-workbench/
        ├── manifest.js             # ui.views[] 声明 ← plugin.json
        ├── state/
        │   └── chat-state.js       # 事件派生状态 ← ui/src/state/run.ts
        ├── components/
        │   ├── ChatTimeline.js     # 对话流（含思考块/工具树/对话框/统计栏/导航轨）
        │   ├── WorkspaceManager.js # 工作区管理 ← views/SessionWorkspaceView.vue 的工作区部分
        │   └── ApprovalPanel.js    # 审批块 ← packages/client/ui-approval/
        └── views/
            ├── ChatComposerView.js # 输入区 ← ui/src/views/ChatComposerView.vue
            ├── SessionListView.js  # 会话列表 ← ui/src/views/SessionListView.vue
            └── SessionWorkspaceView.js  # 检查器 ← ui/src/views/SessionWorkspaceView.vue
```

**关键点**：组件页只是「壳」—— 它加载 `src/` 下真正的组件实现并渲染示例。
所以组件代码改了，所有组件页立刻同步；组件页本身不含任何组件逻辑。

---

## 4. 核心契约

### 4.1 widget id 是持久化主键

```
widget.session-list      会话列表
widget.chat-timeline     对话流
widget.chat-composer     输入区
widget.session-workspace 检查器
widget.rail              图标轨（宿主自带，不属于插件）
```

**id 一旦改名，用户拖好的位置就全丢了**（症状是「升级后所有组件回到默认位置」）。
所以 id 与 osteosome 保持完全一致，将来搬过去不用改。

### 4.2 注册表三态

```js
registry.defineWidget(id, title, component)   // 注册本地 widget
registry.resolveWidget(id, pluginViews)       // → { kind: 'local' | 'iframe' | 'missing' }
```

`resolveWidget` 的判定顺序**不能调换**（osteosome P4 的核心语义）：
本地注册 → 插件 view → 已退役（missing/removed）→ 未知（missing/unknown）。

> Demo 里用的是「本地注册优先」。真实 osteosome 的本地组件表在 P6 后已清空
> （组件全迁进插件），所以两者效果等价 —— 差别只在同名时谁生效。

### 4.3 组件边界：props 进、事件出

共享 UI 组件（`src/ui/`）**不读 store、不发请求、不 import core-client**。
这条边界是它能被插件直接用的前提。

插件视图接收的 props（由宿主显式注入）：

| prop | 类型 | 说明 |
|---|---|---|
| `chat` | Object | 状态实例（含 `state.rows` / `state.turns` / `state.sending`） |
| `approval` | Object \| null | 待审批项，null 表示不接管 |
| `currentSessionId` | string | 当前会话 id |
| `onSend` | Function | `(text) => void` |
| `onStop` | Function | `() => void` |
| `onRegen` / `onBranch` / `onCopy` / `onDelete` | Function | 消息级操作 |
| `onToggleThink` / `onToggleTools` | Function | 折叠状态切换 |
| `onApprove` / `onReject` | Function | 审批应答 |

### 4.4 状态是派生出来的

```
事件流（真 SSE / Demo 的 mock bus）
  → subscribe(topic, handler)
  → 拼出 rows[]
  → 渲染
```

**不是**「A 改了本地状态、通知 B 同步」。这条纪律一旦破坏，
就会掉回「消息层 + 消息形状 + 消息丢失」那一整套排障地狱。

用到的 topic：

| topic | 载荷 | 作用 |
|---|---|---|
| `loop.state.changed` | `{requestId, state, turnKey, label}` | running → 占位行；idle → 收尾 |
| `loop.token.streamed` | `{requestId, token, blockType}` | 正文 / 思考分流累加 |
| `loop.tool.executed` | `{requestId, id, name, path, ok, ms, diff, children}` | 工具调用 |
| `message.appended` | `{id, role, text, ms, usage, speed, cacheHit}` | 消息落库 |
| `loop.run.failed` | `{message}` | 错误内联在末尾 |
| `loop.run.cancelled` | `{requestId}` | 标记「已停止」 |

**换真 SSE 时只需替换 `bus.subscribe` 的实现，其余代码不动。**

---

## 5. 本次的两处设计改动

### 5.1 Turn 导航轨移到左侧

deepseek-harness 把它放在**右侧**，但那条轨道与**原生滚动条**争同一块地方 ——
滚动条出现时轨道被推走，不出现时轨道又显得孤零零。

移到**左侧**之后：
- 右边完整让给原生滚动条，两件事不再抢位置
- 轨道与左侧的图标轨/会话列表在同一条视觉轴上，界面左重右轻，稳
- 天枢的「左栏用户消息跳转圆点条」本来就是这个位置，位置语言一致

```
┌────┬──────────┬────┬──────────────────────────┬──────────┐
│ 轨 │ 会话列表  │导航│  消息区（滚动条在右侧）      │ 检查器    │
│56px│ 240px    │轨  │                          │ 300px    │
│    │          │26px│                          │          │
└────┴──────────┴────┴──────────────────────────┴──────────┘
```

组件：`components/TurnNavRail.js`
- props：`turns[]` / `activeKey` / `maxHeight`
- 事件：`jump(key)`
- 刻度间距按 `maxHeight` 自适应（8~18px），`maxHeight` 由宿主用 `ResizeObserver` 量出传入 ——
  **组件自己不读 DOM**（保持纯展示）

### 5.2 组件粒度

**5 个顶层组件**，粒度对齐 osteosome 的 widget：

```
widget.chat-timeline      对话流      ← ChatTimeline.js
widget.session-list      对话列表    ← SessionListView.js
widget.chat-composer      输入框      ← ChatComposerView.js
widget.session-workspace  检查器      ← SessionWorkspaceView.js
（审批块不是 widget —— 它是浮层，由工具调用触发）
```

**思考块 / 对话框 / Turn 导航轨 / 工具调用树 / 统计栏是对话流的内部构造**，
在 `ChatTimeline.js` 一个文件里。它们的展开策略各自独立，所以内部拆成子组件
（`ThinkingBlock` / `MessageBubble` / `ToolCallTree` / `StatBar` / `TurnNavRail`），
但对外只暴露一个 `ChatTimeline`。

真实实现里这些会分散在 `packages/client/ui-chat/` 与 `ui-tool/` 两个包里 ——
本 Demo 合成一个文件是为了**看清装配关系**，实际开发时按这个边界拆开即可。

**新增一个 widget 只需两步，不改宿主装配代码**：
1. 写组件文件，在 `manifest.js` 里 `registry.defineWidget(...)`
2. 把 widget id 加进 `AppFrame` 的 `LAYOUT` 规格

## 6. 迁回 osteosome 的对照表

| Demo 里的 | 迁回后 |
|---|---|
| `<script src>` 逐个加载 | `import` + Vite 打包 |
| `window.OST.ui.Button` | `import { Button } from '@osteosome/ui'` |
| `registry.defineWidget`（本地） | `plugin.json` 的 `ui.views[]`（Core 扫盘） |
| `resolveWidget` → `kind:'local'` | `resolveWidget` → `kind:'iframe'`，走 `PluginWidgetHost` |
| `mock bus` | `sse.subscribe()`（`@osteosome/core-client`） |
| `props` 传递 chat | sessionStorage + storage 事件传 `curId`，其余走 SSE |
| `styles.css` 单文件 | 每个组件 `<style scoped>`（BEM 类名保持不变） |
| `styles/tokens.css` | `@osteosome/ui/styles/tokens.css`（**令牌名完全一致，直接换皮**） |

### 必须遵守的 5 条

1. **组件边界**：props 进、事件出，不读 store、不 import core-client
2. **状态派生**：从事件流拼出来，不乐观造行
3. **令牌唯一来源**：不硬编码颜色，全走 `var(--color-*)`
4. **BEM 类名**：`block__element--modifier`
5. **不建第二真源**：同一份数据只从事件流来

---

## 7. 已知差异与待办

| 项 | Demo 现状 | 真实实现 |
|---|---|---|
| iframe 装载 | 无 | `PluginWidgetHost` + `osteosome:plugin-ui:ready` 握手 |
| 跨视图 `curId` | props 注入（AppFrame 按 widget id 分发） | sessionStorage + storage 事件（**本地先赋值再写盘**） |
| 审批块浮出 | 宿主渲染为 `.frame__approval-layer` 浮层 | 同样浮在对话流上方，不插入消息流 |
| 输入框常驻 | 单个组件实例切换 phase | 跨会话不重挂载 textarea，保留草稿与光标 |
| 拖拽摆位 | 无 | `vue-movable-box` + dockview |
| 密度切换 | 未做（顶栏已移除） | 折叠策略 / 折叠内容 / 完成时机三个独立维度 |
| SSE 订阅时机 | 一次性订阅全部 topic | 常驻订阅 + 本地按 requestId 配对（**不要为一次命令临时订阅**） |

---

## 8. 怎么跑

直接双击 `index.html`（用的是传统 script 标签，非 ES module，file:// 可用）。

或起个静态服务器：

```bash
cd ost-chat-demo && python -m http.server 8899
# 打开 http://127.0.0.1:8899/index.html
```

### 可以试的交互

**完整工作台**（`../index.html`）
- 输入框：直接发送 → 打字机 + 呼吸光标；`Esc` 停止；`↑` 调出上一条
- 工具组里的 **Bash** 行 → 点击「待授权」标记 → **审批块浮出**（含作用域说明）
- 悬停消息右下角 → 复制 / **重新生成**（原地替换，不新建会话）/ 分支 / 删除
- 左侧导航轨：hover 刻度看轮次摘要，点击跳转

**组件页**
- `approval.html` 的沙盘里，点工具行的「待授权」标记看审批块联动
