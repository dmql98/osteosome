# Osteosome 开发文档 · 微内核架构 RFC v3

> 状态：Draft v3 ｜ 作者：dmql ｜ 日期：2026-09-23 ｜ 原名：天枢插件化架构 RFC（天枢 → Osteosome 更名中）
> 关联：`dev/docs/dsh-vs-tianshu-tools.md`（工具系统级对比，本文是架构级延续）
> 原则：**小步 strangler，每步绿灯通行**。不推倒重写、不引入运行时热插拔、不新增运行时依赖（初期）。
>
> **v3 核心变更**：从 v1/v2 的「前后端双主线插件化」升级为 **微内核 + 多语言服务 + 可观察总线**。Core 极薄且稳定，服务独立进程、语言自由、可热插拔，前端用 Vue 3 + dockview-vue。

---

## 0. v3 相对 v2 的变化摘要

| 维度 | v1 / v2 | v3 |
|---|---|---|
| **架构形态** | 插件化单体（进程内 ctx） | **微内核 + 多语言服务 + 消息总线** |
| **Core 职责** | 装配器 + 事件容器 | **进程管理 + 总线 + SSE 桥**（极薄，不跑业务） |
| **服务形态** | 进程内模块 | **独立进程（语言自由）** |
| **服务间通信** | `ctx.get('xxx')` 直接调用 | **总线事件（publish / subscribe）** |
| **热插拔** | 插件热插拔（进程内卸载） | **服务热插拔（kill + spawn，Core 不重启）** |
| **旁路观察** | 无 | **零侵入（统计服务只订阅不发布）** |
| **前端框架** | React | **Vue 3 + dockview-vue**（官方支持） |
| **前端通信** | 事件轮询 | **SSE（推）+ HTTP POST（命令）** |
| **新增文档** | — | Core 契约、事件契约、服务 SDK、Core 目录结构 |

---

## 1. 动机：耦合正在把 Osteosome 焊成一块

Osteosome 功能并不缺，缺的是**模块之间的胶水**。耦合在前后端各集中为三个「装配点」。

### 1.1 Server 端三个装配点

#### ① `app.ts` —— 唯一装配中枢（首战战场）

`startTianshuServer()`（app.ts:160-378）是一台「把所有线焊在一起」的机器：

- **直接 import 20 个路由 + 15+ 子系统**（app.ts:6-33），代码即装配清单，改装配只能改代码。
- **启动时内联执行 7 段业务 sweep**（app.ts:176-264）：孤儿 run 回收、续跑链修复、run_events/llm_calls 数据保留、快照仓库清理、tool_usage 回填、builtin 内容物化、角色视觉迁移。每段都是「拿 `getDb()` 裸跑 SQL + 打日志」，段与段之间靠手写先后顺序。
- **全局可变单例靠 boot 时偷偷塞**（app.ts:328-331）：

  ```ts
  setEventDefinitionRuntime(broadcaster)   // event/event-run-adapter.ts
  setGoalRuntime(broadcaster)              // routes/goals.ts
  setRunsRuntime(broadcaster)              // routes/runs.ts
  setTransportBroadcaster(broadcaster)     // transport/runtime.ts
  ```

  被塞的模块各自维护一个 `let xxxRef: ... = null` + `getXxx()`（throw if not set），即「运行时全局变量」——谁先 import 谁先炸。

#### ② `outer.ts` —— 531 行 god-function

`sessionLoop()`（agent/outer.ts:56-529）一次 run 做完全部：加载角色/provider → 连 MCP（重试 3 次）→ 组工具注入 → system prompt 构建/缓存 → 组初始消息 → 冷启动压缩 → 剪枝 → 跑 loop → git 快照 diff → 自动续跑 → 缓存统计 → 进化检测 → 断 MCP。直接 import **20+ 模块**，新增任何能力都必须改它。

#### ③ `loop-engine.ts` —— 784 行内嵌策略

`runLoopEngine()`（agent/loop/loop-engine.ts:145-784）把 plan/goal/delegation/doom-loop/收敛评估/上下文管理全部 if/else 内联在 turn 循环里。执行模式、策略注入、压缩水位全是**承诺式功能**而非**可插拔扩展点**。

### 1.2 Client 端三个装配点（与 server 同构的病）

| 装配点 | 现状 | 病灶 |
|---|---|---|
| `App.tsx`（前端的 app.ts） | 内联导航 `<nav class="nav-rail">` + `navItems` 数组（App.tsx:30-39、113-145）+ 路由表（147-169） | 导航不是组件；4 组启动副作用（48-106）硬编码 |
| `ChatPage.tsx` | 装配 SessionPanel / ChatArea / RightPanel / FilePanel | 装配关系写死在页面，开合布尔漂在 uiStore |
| `RightPanel.tsx`（359 行 monolith） | 角色卡 / 项目区 / 授权工作区 / 帮手 / 知识库 / GoalPanel / **会话统计**七段手排顺序 | 「会话统计」（331-345）只是其中一段，不是可插拔单元 |

### 1.3 放大耦合的底层机制

| 机制 | 位置 | 后果 |
|---|---|---|
| DB 单例满天飞 | `getDb()` + 各 store 直接 import（routes/messages.ts:2-5 等 20+ 处） | 存储无法替换/分片/测试隔离 |
| 全局可变单例 | `setXxxRuntime`/`getXxx`（transport/runtime.ts:30-37） | 隐式依赖 boot 顺序 |
| 路由是模块级单例 | `const router = new Hono()`（各 routes/*.ts） | 无法按场景装配、无法并发多实例 |
| 前端导航是数组 | App.tsx:30-39 | 新增信息面必须改 App.tsx |
| 前端面板开合是布尔 | uiStore | 布局不可序列化、不可持久化、不可拖拽 |

### 1.4 好消息：地基建了一半

- **工具 = 半个插件系统**：`tools/registry.ts` 目录自动发现 + `tool.json` 元数据 + 显式 `register()`。
- **Provider = 一个成形的 seam**：`providers/types.ts` 统一定义 + `openai-compatible.ts` 基类 + 30+ provider 适配器。
- **会话 = 半个 durable log**：`run-event-store.ts` 的 `publishRunEvent` / `createDurableStream` / resume 机制。

**缺口就在中间**：server 缺总线与进程隔离，client 缺 Panel / Widget 契约与布局模型。

---

## 2. 微内核模型：Core 极薄，服务独立进程

v3 的核心判断：**「Core 稳定、服务频繁更新、重启服务不重启程序」这个需求，直接决定服务必须是进程外。** 进程内模块无法做到「单个服务重启而程序不重启」。

### 2.1 三件职责

| 职责 | 说明 |
|---|---|
| **① 进程管理** | 读 manifest、拓扑排序、spawn / kill、健康检查、崩溃重启、优雅停止 |
| **② 消息总线** | publish / subscribe / replay；服务间不直连，全部经过它 |
| **③ SSE 桥** | `/events` 推事件给前端，`/api/command` 收前端命令，托管静态资源 |

### 2.2 四件不做的事

| 不做 | 原因 |
|---|---|
| **请求-响应路由** | 服务 A 调服务 B 走「请求事件 + 响应事件」，配对靠 `requestId`，通道管理归总线 |
| **业务逻辑** | LLM 编排 / Loop 控制 / 角色档案全在服务里，Core 不 import 任何业务模块 |
| **数据存储抽象** | storage 服务独立进程，Core 不直接碰 DB |
| **前端逻辑** | Core 只托管前端静态资源 + SSE 桥。Pane 的布局、订阅、渲染全在前端 |

### 2.3 关键判断：为什么必须是进程外

| 需求 | 进程内 | 进程外 |
|---|---|---|
| 更新单个服务 | ❌ 必须重启宿主进程 | ✅ kill + spawn |
| 语言自由 | ❌ 只能同语言 | ✅ 任意语言 |
| 崩溃隔离 | ❌ 拖垮整个进程 | ✅ 只挂自己 |
| 资源回收 | ⚠️ 靠手动 + GC | ✅ 操作系统自动 |

**结论：Core 写一次就稳定，之后所有演化都发生在服务里。**

---

## 3. dsh 哲学与 Cordis 对标

### 3.1 Cordis 六想法

Cordis 是 dsh 底下真正干活的插件框架（官称 *Meta-Framework of Spatiotemporal Composability*，论文 arXiv 2608.25512）。全部主张可缩成六条：

| # | 想法 | 说明 |
|---|---|---|
| ① | **插件 = 实现 Service 的东西** | 一个函数（可选 `inject` / `apply(ctx)`）或 `Service` 子类 |
| ② | **Context = 服务的仓库** | 服务认领 `ctx.<key>`，靠 key 找服务，不靠 import |
| ③ | **依赖用 inject 声明** | 等依赖就位再激活，装配顺序由依赖推导 |
| ④ | **类型化事件 + 5 种分派模式** | `emit` / `waterfall` / `parallel` / `serial` / `bail` |
| ⑤ | **注册 = 可回卷的效果** | `ctx.effect()` / `ctx.on()` 返回 disposer，卸载逆序回卷 |
| ⑥ | **Osteosome 新增：插件是捆绑包** | 后端 `activate(ctx)` + 前端 Widget / Panel 装配 + `manifest.json` |

**waterfall 是最关键的机制**：listener 收到 `(...args, next)`，**不调 `next()` 即否决**（短路），调则携带改写后的值委托下游。策略、审批、提示注入都是挂上去的 listener，而不是循环里的 if/else。

### 3.2 Osteosome Core 与 Cordis 的本质区别

**Cordis 是进程内插件编排框架；Osteosome Core 是跨进程微内核服务编排框架。**

| 维度 | Cordis | Osteosome Core |
|---|---|---|
| **服务形态** | 进程内模块（TS 对象） | 独立进程（任意语言） |
| **通信方式** | 直接通过 `ctx` 对象调用 | 通过 Bus 发事件（JSON-RPC over stdio） |
| **依赖解析** | `inject` 字段声明 | `manifest.json` 声明 |
| **生命周期** | 插件热插拔（加载/卸载） | 服务热插拔（进程启动/停止） |
| **语言边界** | 仅 TS / JS | 语言无关（TS / Python / Rust / Go） |
| **核心职责** | 服务注册、DI、事件分发 | 进程管理、消息总线、SSE 桥 |

### 3.3 借鉴方式：不引入本体，对齐契约

- **不引入 Cordis 作为运行时依赖**（延续 v1 决策）。
- Core 的 Bus 接口**对齐 Cordis 的概念**：`publish` / `subscribe` / `effect` 返回 disposer / 通配符。
- 若远期 Cordis 生态成熟，Bus 内部实现可白盒替换为 Cordis（接口层已对齐）。

---

## 4. 目标架构

### 4.1 全景图

```
┌─────────────────────────────────────────────────────────────────┐
│  Electron 壳（极薄 · 只开窗口 / 原生能力桥）                       │
└─────────────────────────────────────────────────────────────────┘
                            │ spawn / IPC
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│  Core（TS / Node · 极薄 · 很少更新）                              │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐   │
│  │ 进程管理器    │  │ 消息总线     │  │ SSE 桥 + 静态资源     │   │
│  └──────────────┘  └──────────────┘  └──────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
        │ stdout/JSON-RPC          │ 事件 fan-out      │ HTTP POST
        ▼                          ▼                   ▼
┌──────────────────┐  ┌──────────────────┐  ┌────────────────────┐
│ 服务（独立进程）  │  │ 前端 Panel / Widget (Vue)  │  │ 前端 /api/command  │
│ ├ LLM (TS/Python)│  │ ├ pane.chat      │  │                    │
│ ├ Loop (TS)      │  │ ├ pane.stats     │  │                    │
│ ├ 角色 (TS)      │  │ ├ pane.character │  │                    │
│ └ 统计 (TS)      │  │ └ ...            │  │                    │
└──────────────────┘  └──────────────────┘  └────────────────────┘
        ▲
        │ 旁路订阅（零侵入）
        └─── 统计 / 日志 / 审计 / 分析
```

### 4.2 微内核三模块关系

**ServiceManager 和 SseBridge 都依赖 Bus，但彼此不直接通信。**

```
                     ┌──────────────────────────┐
                     │           Bus            │
                     │  publish / subscribe     │
                     └────┬────────────────┬────┘
                          │                │
              ┌───────────┘                └────────────┐
              ▼                                         ▼
     ┌──────────────────┐                    ┌──────────────────┐
     │ ServiceManager   │    ✕ 无直连 ✕       │   SseBridge      │
     │  进程生命周期      │                    │   前后端桥        │
     └────────┬─────────┘                    └─────────┬────────┘
              │ stdio JSON-RPC                        │ HTTP / SSE
              ▼                                       ▼
     ┌──────────────────┐                    ┌──────────────────┐
     │  服务进程         │                    │    前端 Panel / Widget      │
     └──────────────────┘                    └──────────────────┘
```

**不变式**：管道之间不直接说话，都经过 Bus。

---

## 5. Core 契约细节

### 5.1 Bus —— 消息总线

```ts
interface Bus {
  // ── 发布 ─────────────────────────────────────────
  publish<T extends EventKey>(
    topic: T,
    payload: EventPayload<T>,
    options?: { persist?: boolean }
  ): void

  // ── 订阅 ─────────────────────────────────────────
  // 返回 disposer，取消订阅。支持通配符：'llm.*' / '*'
  subscribe<T extends EventKey>(
    topic: T | Pattern,
    handler: (payload: EventPayload<T>) => void | Promise<void>,
    options?: {
      once?: boolean
      priority?: number
      filter?: (payload) => boolean
    }
  ): () => void

  // ── 回放 ─────────────────────────────────────────
  replay(from: number, to: number, topics?: EventKey[]): AsyncIterable<Event>

  // ── 元信息 ───────────────────────────────────────
  stats(): { published: number; delivered: number; dropped: number }
  ready(): Promise<void>
}
```

| 特性 | 说明 |
|---|---|
| **同步返回，异步投递** | `publish` 立即返回，handler 在微任务或下一个 tick 执行 |
| **错误隔离** | handler 抛错 → 捕获 → 打日志 → 继续投递下一个订阅者 |
| **通配符** | `llm.*` 匹配 `llm.request` / `llm.token` / `llm.done`；`*` 匹配所有 |
| **背压** | 内存队列上限 N（默认 10000），超限丢弃最旧并计 `stats.dropped` |
| **持久化白名单** | `persist: true` 或 topic 前缀白名单才落库 |
| **订阅 disposer** | 返回函数，调用即取消订阅 |
| **优先级** | `priority` 数值越大越先执行，用于拦截型订阅 |

**持久化适配器**：

```ts
interface PersistenceAdapter {
  append(event: Event): Promise<void>
  range(from: number, to: number, topics?: string[]): AsyncIterable<Event>
  close(): Promise<void>
}
```

内置实现：`SqliteAdapter`（默认）、`MemoryAdapter`（测试）、`NullAdapter`（不落库）。

### 5.2 ServiceManager —— 进程生命周期

```ts
interface ServiceManager {
  start(): Promise<void>                     // 按 manifest 的 inject 依赖拓扑排序启动
  stop(timeoutMs?: number): Promise<void>    // 逆序停止，超时强杀
  restart(serviceId: string): Promise<void>  // 热插拔：单个服务重启，Core 不动

  status(serviceId: string): ServiceStatus
  list(): ServiceInfo[]
}

type ServiceStatus = 'starting' | 'ready' | 'restarting' | 'failed' | 'stopped'
```

**Manifest 规范**：

```json
{
  "id": "llm",
  "version": "1.0.0",
  "protocolVersion": "1.0.0",
  "entry": "python -m llm_service",
  "cwd": "./services/llm",
  "inject": ["storage"],
  "publishes": ["llm.request.started", "llm.token.streamed", "llm.request.finished"],
  "subscribes": ["llm.request"],
  "panes": [
    { "id": "pane.llm.providers", "component": "ProvidersPane" },
    { "id": "pane.llm.config", "component": "LlmConfigPane" }
  ],
  "healthCheck": { "interval": 5000, "timeout": 2000 },
  "restartPolicy": { "maxRestarts": 3, "backoff": "exponential" }
}
```

**stdio JSON-RPC 分帧**（LSP 同款，避免粘包）：

```
Content-Length: 123\r\n
\r\n
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{...}}
```

**方法集**：

| 方向 | 方法 | 说明 |
|---|---|---|
| 服务 → Core | `initialize` | 握手，带 manifest 与协议版本 |
| 服务 → Core | `bus.publish` | 发布事件到总线 |
| 服务 → Core | `bus.subscribe` | 订阅 topic |
| 服务 → Core | `bus.unsubscribe` | 取消订阅 |
| 服务 → Core | `health.pong` | 心跳应答 |
| 服务 → Core | `shutdown` | 主动要求退出 |
| Core → 服务 | `bus.event` | 推送订阅的事件 |
| Core → 服务 | `health.ping` | 心跳探测 |
| Core → 服务 | `shutdown` | 要求优雅退出 |

**Core 自动发布的生命周期事件**：

| Topic | 触发时机 | Payload |
|---|---|---|
| `service.starting` | spawn 进程后 | `{ serviceId, version }` |
| `service.ready` | initialize 握手成功 | `{ serviceId, version, panes }` |
| `service.restarting` | 崩溃后准备重启 | `{ serviceId, reason }` |
| `service.failed` | 重启超限或协议错误 | `{ serviceId, exitCode, reason }` |
| `service.stopped` | 正常停止 | `{ serviceId }` |

**优雅停止**：`SIGTERM → 等待 timeoutMs（默认 5000）→ SIGKILL`。

### 5.3 SseBridge —— 前后端桥

**端点**：

| 端点 | 方法 | 用途 |
|---|---|---|
| `/events` | GET | SSE 事件流，前端订阅总线事件 |
| `/api/command` | POST | 前端投递命令到总线 |
| `/api/preferences` | GET / PUT | 布局 / 主题 / i18n 等偏好持久化 |
| `/*` | GET | 静态资源（Vue 构建产物） |

**`/events` 语义**：

```
GET /events?topics=llm.*,loop.state,tools.*

→ 200 OK
→ Content-Type: text/event-stream

event: message
data: {"topic":"llm.token.streamed","payload":{"requestId":"req-001","token":"你","index":0}}

: heartbeat
（每 30s 一条注释行，防代理超时）
```

- **每个 SSE 连接 = 一个过滤后的 Bus 订阅**。连接关闭 → 自动 dispose。
- **统一包成 `event: message` + JSON body**（topic 在 body 里），前端单监听器按 topic 分发。这样 topic 可以动态扩展，不受 `addEventListener` 静态注册限制。
- **心跳**：每 30s 发 `: heartbeat`。
- **断线重连**：浏览器 `EventSource` 自动重连。

**`/api/command` 语义**：

```
POST /api/command
Content-Type: application/json

{ "topic": "llm.request", "payload": { ... } }

→ 202 Accepted
```

**不等待处理结果**。结果通过 SSE 回来。

**接口**：

```ts
interface SseBridge {
  listen(): Promise<void>
  close(): Promise<void>
  connections(): number
  broadcast(event: string, data: unknown): void
}
```

### 5.4 三个模块组装

```ts
// core/src/main.ts
import { Bus } from './bus'
import { ServiceManager } from './service-manager'
import { SseBridge } from './sse-bridge'

const bus = new Bus({ persist: { adapter: sqliteAdapter } })
const services = new ServiceManager({ bus, manifestDir: './services' })
const bridge = new SseBridge({ bus, port: 1420, staticDir: './dist/client' })

// 启动顺序：
// 1. Bus 就绪（可订阅，但还没事件）
// 2. SseBridge 起 HTTP 服务（前端可连，但还没事件）
// 3. ServiceManager 按拓扑启动服务（服务开始发事件）
await bus.ready()
await bridge.listen()
await services.start()
```

---

## 6. 事件契约规范

### 6.1 命名：`domain.entity.action`

```
格式：<domain>.<entity>.<action>

✅ 好例子：
  llm.request.started
  llm.token.streamed
  loop.state.changed
  character.changed
  tools.executed
  service.ready

❌ 坏例子：
  llmRequestStarted          // 没有分隔符，无法通配符匹配
  llm_req_start              // 下划线风格不一致
  LLM.REQUEST.STARTED        // 大写，阅读负担
  update                     // 太泛，没有 domain 前缀
```

| 段 | 约定 | 已有域 |
|---|---|---|
| **domain** | 服务归属 | `llm` `loop` `character` `tools` `storage` `session` `service` `ui` |
| **entity** | 被操作的对象 | `request` `token` `message` `state` `call` `event` |
| **action** | 过去式动词 | `started` `streamed` `finished` `changed` `failed` `executed` `ready` |

**用过去式**：事件是「已经发生的事」，不是命令。命令走 `/api/command`。

### 6.2 版本：只增不改

| 变更类型 | 做法 |
|---|---|
| **加字段** ✅ | 直接加，不改 topic |
| **加可选字段** ✅ | 直接加，标注 optional |
| **删字段** ❌ | 标记 deprecated，两个版本周期后删 |
| **改字段类型** ❌ | 升版本：`llm.token.v2` |
| **改语义** ❌ | 升版本，或换新 topic |

### 6.3 Payload 公共字段

```ts
interface EventBase {
  ts: number          // 时间戳（毫秒）
  source: string      // 发布者 serviceId
  requestId?: string  // 一对一请求-响应配对
  traceId?: string    // 关联链
  sessionId?: string  // 会话上下文
}
```

| 约束 | 值 |
|---|---|
| payload 大小 | ≤ 256KB（建议） |
| 高频事件速率 | ≤ 1000/s（建议） |
| 必填字段 | `ts` `source` |
| 禁止字段 | 函数 / Symbol / 循环引用 / BigInt |
| 敏感数据 | 不落库，或脱敏后落库 |

### 6.4 类型共享：一份定义，三处消费

```ts
// shared/events.ts
declare module '@osteosome/bus' {
  interface EventMap {
    'llm.request.started': { requestId: string; provider: string; model: string }
    'llm.token.streamed': { requestId: string; token: string; index: number }
    'llm.request.finished': {
      requestId: string
      usage: { input: number; output: number }
      finishReason: 'stop' | 'length' | 'error'
    }
    'loop.state.changed': { sessionId: string; state: 'idle' | 'running' | 'paused' }
    'service.ready': { serviceId: string; version: string }
    'service.failed': { serviceId: string; exitCode: number; reason: string }
  }
}
```

**三处消费**：

```ts
// ① 服务里发布（编译期检查）
bus.publish('llm.token.streamed', { requestId, token, index })

// ② 前端订阅（payload 自动推导）
useEventBus('llm.token.streamed', (e) => { currentMsg += e.token })

// ③ Core 内部过滤（handler 参数自动推导）
bus.subscribe('service.failed', (e) => services.restart(e.serviceId))
```

**这是 TS 相对 Python / Rust 的核心收益**：事件类型一份定义，三处消费，编译期检查。

### 6.5 落库白名单

| 事件类型 | 是否落库 | 判断依据 |
|---|---|---|
| `llm.request.started` | ✅ 落 | 进入模型上下文的内容 |
| `llm.token.streamed` | ✅ 落（或聚合后落） | 模型输出 |
| `llm.request.finished` | ✅ 落 | 模型响应完成 |
| `loop.state.changed` | ✅ 落 | 会话状态变更 |
| `service.ready` | ✅ 落 | 审计需要 |
| `ui.hover` / `ui.scroll` | ❌ 不落 | 纯 UI 瞬时状态 |

**默认不落，避免高频 UI 事件写爆 DB。**

### 6.6 首批事件清单

| Topic | 发布者 | 订阅者 | 落库 | 用途 |
|---|---|---|---|---|
| `llm.request.started` | LLM | Loop / 统计 | ✅ | 调用开始 |
| `llm.token.streamed` | LLM | Loop / 聊天 Pane | ✅ | 流式 token |
| `llm.request.finished` | LLM | Loop / 统计 | ✅ | 调用完成 + usage |
| `loop.state.changed` | Loop | 聊天 Pane / 角色 Pane | ✅ | idle / running / paused |
| `character.changed` | 角色 | 角色 Pane | ✅ | 档案更新 |
| `tools.executed` | Loop | 统计 / 日志 | ✅ | 工具调用 |
| `service.starting` | Core | 全部前端 | ✅ | 服务启动中 |
| `service.ready` | Core | 全部前端 | ✅ | 服务就绪 |
| `service.failed` | Core | 全部前端 | ✅ | 服务崩溃 |
| `service.restarting` | Core | 全部前端 | ✅ | 重启中 |
| `ui.activeSession.changed` | 前端 | 前端（BroadcastChannel） | ❌ | 跨窗会话同步 |
| `ui.layout.changed` | 前端 | 前端（BroadcastChannel） | ❌ | 布局变更 |

---

## 7. 服务 SDK 契约

### 7.1 握手协议

```
1. Core → 服务：spawn 进程
2. 服务 → Core：request 'initialize'
   {
     "jsonrpc": "2.0", "id": 1, "method": "initialize",
     "params": {
       "protocolVersion": "1.0.0",
       "serviceId": "llm",
       "coreVersion": "3.0.0",
       "manifest": { ... }
     }
   }
3. Core → 服务：response
   {
     "jsonrpc": "2.0", "id": 1,
     "result": { "sessionId": "core-session-abc", "heartbeatInterval": 5000 }
   }
4. 服务 → Core：notification 'initialized'
5. 双向进入运行态：publish / subscribe / heartbeat
6. 服务退出前：notification 'shutdown'，Core 回 'exit'
```

### 7.2 Manifest 校验（SDK 启动时执行）

1. **schema 校验** —— 字段类型正确，必填存在
2. **版本校验** —— `protocolVersion` 与 Core 兼容
3. **事件一致性** —— `publishes` / `subscribes` 的 topic 必须在 `shared/events.ts` 声明

不一致 → 拒绝启动（fail fast），Core 广播 `service.failed`。

### 7.3 TS SDK 骨架

```ts
// services/llm/src/index.ts
import { Service, bus, logger } from '@osteosome/service-sdk'

const service = new Service({ id: 'llm', version: '1.0.0' })

service.subscribe('llm.request', async (req) => {
  const { requestId, provider, model, messages } = req

  bus.publish('llm.request.started', {
    ts: Date.now(), source: 'llm', requestId, provider, model,
  })

  try {
    for await (const token of callProvider(provider, model, messages)) {
      bus.publish('llm.token.streamed', {
        ts: Date.now(), source: 'llm', requestId, token: token.text, index: token.index,
      })
    }
    bus.publish('llm.request.finished', {
      ts: Date.now(), source: 'llm', requestId, usage: {...}, finishReason: 'stop',
    })
  } catch (err) {
    bus.publish('llm.request.finished', {
      ts: Date.now(), source: 'llm', requestId, usage: null, finishReason: 'error',
    })
  }
})

service.start().catch((err) => {
  logger.error('LLM service failed to start', err)
  process.exit(1)
})
```

### 7.4 Python SDK 骨架

```python
# services/llm-python/src/main.py
import asyncio
from osteosome_service import Service, bus, logger

service = Service(id="llm-python", version="1.0.0")

@service.subscribe("llm.request")
async def handle_llm_request(req: dict):
    request_id = req["requestId"]
    bus.publish("llm.request.started", {
        "ts": ..., "source": "llm-python",
        "requestId": request_id,
        "provider": req["provider"],
        "model": req["model"],
    })
    try:
        async for token in call_provider(req["provider"], req["model"], req["messages"]):
            bus.publish("llm.token.streamed", {
                "ts": ..., "source": "llm-python",
                "requestId": request_id,
                "token": token.text, "index": token.index,
            })
        bus.publish("llm.request.finished", {
            "ts": ..., "source": "llm-python",
            "requestId": request_id,
            "usage": {"input": 10, "output": 42},
            "finishReason": "stop",
        })
    except Exception as err:
        logger.error(f"LLM call failed: {err}")

if __name__ == "__main__":
    asyncio.run(service.start())
```

### 7.5 SDK 覆盖的通用能力

| 能力 | SDK 内部实现 |
|---|---|
| stdio 分帧 | `Content-Length` 解析、粘包处理、UTF-8 边界 |
| 握手 | 自动发送 `initialize`，等 Core 响应，失败重试 |
| 心跳 | 收到 `health.ping` 自动回 `health.pong` |
| 事件分派 | 收到 `bus.event` → 按 topic 匹配 handler → 异步执行 |
| 订阅管理 | 进程退出前自动 `unsubscribe` |
| 优雅退出 | 捕获 SIGTERM → 停止接受新事件 → 等处理完成 → `shutdown` |
| 日志 | 写 stderr（不污染协议流），Core 收集并聚合 |
| 错误上报 | handler 抛错 → SDK 捕获 → 发 `service.handler-error` |

### 7.6 多语言路线

| 语言 | 阶段 | 理由 |
|---|---|---|
| **TS** | 阶段 1-2 | 和 Core 同语言，复用 `shared/events.ts`；内置服务全部用它 |
| **Python** | 阶段 3 | AI / 数据处理生态；LLM 服务可能第一个换 Python |
| **Rust** | 阶段 4 | 性能敏感服务；或复用已有 Rust 库 |
| **Go** | 阶段 4 | 并发密集服务；或团队已有 Go 代码 |

**不要一次做全部**：SDK 是最大的工作量。先做 TS（自己用），再做一个 Python（验证协议中立性）。

---

## 8. Core 目录结构

### 8.1 仓库总览

```
osteosome/
├── package.json                    # monorepo root（pnpm workspaces）
├── pnpm-workspace.yaml
├── tsconfig.base.json
│
├── core/                           # 微内核（TS / Node）
├── services/                       # 内置服务（独立进程）
├── shared/                         # Core / 服务 / 前端共享的类型与工具
├── sdk/                            # 服务 SDK（多语言）
├── client/                         # 前端工作台（Vue 3 + dockview-vue）
├── desktop/                        # Electron 壳
└── docs/                           # RFC / 开发文档
```

### 8.2 core/ —— 微内核

```
core/
├── package.json                    # name: @osteosome/core
├── tsconfig.json
├── src/
│   ├── main.ts                     # 入口：组装 Bus + ServiceManager + SseBridge
│   ├── bus/
│   │   ├── bus.ts                  # Bus 实现
│   │   ├── pattern.ts              # 通配符匹配
│   │   ├── persistence.ts          # 持久化适配
│   │   └── types.ts                # EventKey / EventPayload / EventBase
│   ├── service-manager/
│   │   ├── manager.ts              # ServiceManager 实现
│   │   ├── process.ts              # spawn / kill / 信号处理
│   │   ├── manifest.ts             # manifest 加载与 schema 校验
│   │   ├── topology.ts             # 依赖拓扑排序
│   │   ├── health.ts               # 心跳检查与重启策略
│   │   └── jsonrpc/
│   │       ├── framing.ts          # Content-Length 分帧
│   │       ├── client.ts           # Core 侧 JSON-RPC 客户端
│   │       └── protocol.ts         # 方法集定义
│   ├── sse-bridge/
│   │   ├── server.ts               # HTTP 服务器
│   │   ├── sse.ts                  # /events 端点
│   │   ├── command.ts              # /api/command 端点
│   │   └── static.ts               # 静态资源托管
│   ├── config/
│   │   ├── config.ts               # 配置加载
│   │   └── paths.ts                # dataDir / servicesDir / distDir
│   └── logger.ts                   # 统一日志
└── tests/
```

**代码量预估**：核心三个模块约 **1500-2000 行**。这是 Core 的全部。

### 8.3 services/ —— 内置服务

```
services/
├── llm/                            # LLM 服务
│   ├── service.json                # manifest
│   ├── src/
│   │   ├── index.ts
│   │   ├── providers/              # 服务商适配器
│   │   ├── stream.ts               # 流式 token 解析
│   │   └── usage.ts                # usage 记账
│   └── tests/
├── loop/                           # Loop 服务
├── character/                      # 角色服务
├── storage/                        # storage 服务（DB 唯一持有者）
└── stats/                          # 统计服务（旁路消费者）
```

**每个服务的结构一致**：`service.json` + `src/index.ts` + 业务模块。

### 8.4 shared/ —— 共享层

```
shared/
└── src/
    ├── events.ts                   # 事件类型定义
    ├── manifest.ts                 # Manifest 类型 + Zod schema
    ├── protocol.ts                 # JSON-RPC 协议版本、方法集
    └── types.ts                    # 通用类型
```

**shared/ 是唯一真相源。** 改 shared/ 的类型 → 三处编译期同时报错。

### 8.5 sdk/ —— 服务 SDK

```
sdk/
├── ts/                             # TypeScript SDK
│   └── src/
│       ├── service.ts
│       ├── transport.ts
│       ├── handshake.ts
│       ├── heartbeat.ts
│       └── logger.ts
├── python/                         # Python SDK（阶段 3）
└── rust/                           # Rust SDK（阶段 4）
```

### 8.6 client/ —— Panel / Widget 工作台（Vue）

```
client/
├── package.json                     # Vue 3 + dockview-vue + vue-movable-box
├── vite.config.ts
├── index.html
└── src/
    ├── main.ts                      # 两套布局样式均在此引入
    ├── App.vue                      # 只渲染 RouterView
    ├── core-sdk/                    # SSE / command / preferences / service status
    ├── layout/
    │   ├── DockviewLayout.vue       # 外层 Panel 停靠、拆分、比例和序列化
    │   ├── layout.store.ts          # SerializedDockview 快照和偏好持久化
    │   ├── mode.ts                  # edit / runtime
    │   └── window-manager.ts        # 独立 Panel 窗口
    ├── panes/
    │   ├── PanelContainer.vue       # 内层 vue-movable-box Widget 容器
    │   ├── PanelHeaderActions.vue   # 重置 / 拉出 / 关闭
    │   ├── PanelTab.vue             # 自定义 Panel tab
    │   ├── PanelHost.vue            # 独立窗口壳
    │   └── default-layout.ts        # 默认 panel.main
    ├── widgets/                     # 最小业务单元
    │   ├── definition.ts            # defineWidget
    │   ├── registry.ts              # import.meta.glob 自动发现
    │   └── types.ts                 # WidgetDefinition
    ├── components/                  # 通用 UI 组件
    ├── stores/                      # Pinia
    └── styles/                      # tokens.css / base.css
```

### 8.7 desktop/ —— Electron 壳

```
desktop/
├── package.json
├── src/
│   ├── main.ts                     # 主进程：spawn Core + BrowserWindow
│   ├── preload.ts
│   └── pane-window.ts              # 弹窗管理
└── electron-builder.yml
```

### 8.8 启动流程

```
1. 用户双击 Osteosome
   ↓
2. Electron main 启动
   ├─ spawn Core 子进程
   ├─ 等 /health 就绪
   └─ BrowserWindow 加载 http://127.0.0.1:1420
   ↓
3. Core 启动
   ├─ Bus 就绪
   ├─ SseBridge 监听 1420
   ├─ 扫 services/*/service.json
   ├─ 拓扑排序 → spawn 每个服务
   └─ 每个服务握手 → 进入运行态
   ↓
4. 前端加载
   ├─ import.meta.glob 扫 panes
   ├─ 读 /api/preferences 恢复布局
   ├─ dockview-vue 渲染 Pane
   └─ 每个 Pane 开 SSE 订阅
   ↓
5. 用户点「发送」
   ├─ ChatPane POST /api/command
   ├─ Core 投递到 Bus
   ├─ LLM 服务订阅并处理
   ├─ LLM 服务 publish token
   ├─ Core fan-out 给 SSE
   └─ ChatPane 收到 token → 显示
```

---

## 9. 消息总线与单向通信

### 9.1 「Loop 调 LLM」的完整走线

```ts
// ① Loop 服务发请求事件（带 requestId）
bus.publish('llm.request', {
  requestId: 'req-001',
  provider: 'deepseek',
  model: 'deepseek-chat',
  messages: [{ role: 'user', content: '你好' }],
})

// ② LLM 服务订阅，处理后发响应事件
bus.subscribe('llm.request', async (e) => {
  for await (const token of callProvider(e)) {
    bus.publish('llm.token.streamed', { requestId: e.requestId, token, index })
  }
  bus.publish('llm.request.finished', { requestId: e.requestId, usage: {...} })
})

// ③ Loop 服务订阅响应（匹配自己的请求）
bus.subscribe('llm.token.streamed', (e) => {
  if (e.requestId === 'req-001') handleToken(e.token)
})

// ④ 统计服务旁路订阅（零侵入）
bus.subscribe('llm.request', (e) => stats.providers[e.provider]++)
```

### 9.2 旁路观察是免费的

- 统计服务订阅 `llm.*`，**LLM 服务不需要为它改任何代码**。
- 新增日志 / 审计 / 分析服务，同样零侵入。
- 调试时在总线上打日志，所有服务间通信一览无余。
- 事件天然适合事件溯源：落库、回放、审计都免费。

### 9.3 单向优先：SSE + HTTP POST

| 方向 | 协议 | 理由 |
|---|---|---|
| 后端 → 前端（事件流） | **SSE** | 语义单向，浏览器原生 `EventSource`，自带重连，纯 HTTP |
| 前端 → 后端（命令） | **HTTP POST** | 「发完就不管」的短请求，无需长连接 |
| 进程间控制面 | JSON-RPC over stdio | 语言无关，进程隔离 |
| 服务 ↔ 服务 | 总线（不直连） | 一对多 / 多对多天然，旁路可观察 |

**前端订阅示例（Vue）**：

```vue
<script setup>
import { ref } from 'vue'
import { useEventBus } from '@/core-sdk/useEventBus'

const messages = ref([])
let currentMsg = ''

useEventBus('llm.token.streamed', (e) => {
  currentMsg += e.token
})
useEventBus('llm.request.finished', (e) => {
  messages.value.push({ role: 'assistant', content: currentMsg })
  currentMsg = ''
})
</script>
```

### 9.4 为什么不用 WebSocket

- 接收是单向的，SSE 天生为此。
- 发送是「发完就不管」，POST 足够。
- WebSocket 的复杂度（握手、心跳、状态机）在这里换不来任何收益。

---

## 10. 服务热插拔

### 10.1 Manifest（见 §5.2）

### 10.2 五个必须解决的问题

| # | 问题 | 解法 |
|---|---|---|
| 1 | **事件版本管理** | 事件 schema 带版本号或向后兼容；Core 做校验 |
| 2 | **Pane 与服务生命周期解耦** | Core 广播 `service.*` 事件；Pane 订阅并显示「重连中」 |
| 3 | **服务重启后的状态恢复** | 事件溯源（落库 + 回放）或标记未完成任务失败 |
| 4 | **事件持久化与回放** | 关键事件落 SQLite；`bus.replay(from, to)` |
| 5 | **服务依赖关系** | manifest `inject` 声明；Core 拓扑排序；依赖服务不可用时广播 `service.unavailable` |

**热插拔最终形态**：更新 LLM 服务 = 替换 manifest 指向的二进制 + Core kill 旧进程 + 启动新进程。Core 不动，其他服务不动，前端 Panel / Widget 通过 `service.status` 事件感知并更新 UI。

---

## 11. 前端工作台

> 本节以当前仓库实现为准。当前工作台已经完成从旧 Pane 方案到 **Panel / Widget 两层工作台** 的迁移。详细文件和数据流见 [`前端工作台-现行实现.md`](./前端工作台-现行实现.md) 和 [`开发进度/P1b-详细计划.md`](./开发进度/P1b-详细计划.md)。

### 11.1 当前分层

```text
MainLayout
└─ DockviewLayout                         外层：Panel 停靠、拆分、比例、序列化
   └─ PanelContainer                      内层：Widget 拖动、缩放、吸附、几何保存
      └─ Widget component                  最小业务单元
```

当前职责分工：

| 层 | 技术 | 负责 | 不负责 |
|---|---|---|---|
| Panel 外层 | `dockview-vue` / `dockview-core` | Panel 创建、停靠、拆分、比例、tab、`toJSON/fromJSON` | Widget 自由拖动和缩放 |
| Widget 内层 | `vue-movable-box` | Widget 盒子移动、8 向缩放、z-index、吸附、`params.layout` 持久化 | Panel 停靠结构 |
| 业务单元 | `widgets/*.vue` | 服务状态、命令、表单等具体能力 | 直接操作 dockview / 偏好存储 |

### 11.2 外层 dockview 布局

`client/src/layout/DockviewLayout.vue` 只注册一个 dockview 组件：

```ts
const components = { panel: PanelContainer }
```

`client/src/layout/layout.store.ts` 保存 dockview 原生 `SerializedDockview` 快照：

```ts
type LayoutState = {
  mode: 'edit' | 'runtime'
  snapshot: SerializedDockview | null
  api: DockviewApi | null
  hydrated: boolean
  saving: boolean
  lastError: string | null
}
```

- `api.toJSON()` 是外层布局真源；
- `api.fromJSON()` 恢复外层布局；
- `onDidLayoutChange` 更新 `layout.store`；
- `bootstrap()` 从 `/api/preferences` 恢复，损坏时回退默认布局；
- `resetLayout()` 执行 `api.clear()` + `applyDefaultLayout(api)`；
- runtime 模式隐藏组头并锁定外层拖拽。

### 11.3 Panel 内层 Widget 布局

`client/src/panes/PanelContainer.vue` 为每个 Widget 创建一个 `MovableBox`：

```vue
<MovableBox
  v-for="widget in visible"
  v-model="widget.rect"
  drag-handle=".panel-boxes__header"
  :snap-to-elements="true"
  :snap-targets="snapTargets"
  @drag-stop="persist"
  @resize-stop="persist"
/>
```

每个 Widget 的几何数据保存为：

```ts
type MovableBoxRect = {
  left: number
  top: number
  width: number
  height: number
  zIndex: number
}
```

持久化路径：

```text
MovableBox 拖动 / 缩放
  → Panel.api.updateParameters({ widgets, layout })
  → window event: osteosome:panel-layout
  → DockviewLayout.api.toJSON()
  → layout.store.updateLayout(snapshot)
  → /api/preferences
```

因此 `params.layout[widgetId]` 是 Widget 几何的真源；它嵌入 Panel 的 dockview 参数中，而不是单独维护一份全局 Widget 布局。

### 11.4 Widget 注册契约

Widget 是工作台的最小业务单位：

```ts
export interface WidgetDefinition {
  id: string
  title: string
  component: () => Promise<{ default: Component }>
}
```

`client/src/widgets/registry.ts` 通过 `import.meta.glob('./*/*-widget.vue', { eager: true })` 自动发现 Widget。当前内置 `widget.service-status` 和 `widget.hello-command`。

新增业务组件时，优先新增 Widget，而不是新增一个 dockview 外层 Pane。只有当组件需要独立停靠、拆分或独立窗口时，才由 Panel 组织多个 Widget 或增加新的 Panel 使用场景。

### 11.5 路由和独立窗口

- `/`：`MainLayout`，包含 TopBar 和 DockviewLayout；
- `/pane/:id?w=widgetA,widgetB`：`PanelHost`，复用 `PanelContainer`；
- `openPanelWindow(panelId, widgetIds)`：通过 `window.open` 拉出独立 Panel；
- 独立窗口不复制业务数据，Widget 继续通过 Core 的 SSE / command 链路获取数据。

### 11.6 组件开发合同

1. **SSE 单例**：Widget 使用 `useEventBus`，不自行创建 `EventSource`；
2. **命令统一出口**：使用 `useCommand`，不直接绕过 Core 调业务 API；
3. **Widget 只负责业务能力**：Panel 容器负责拖动、缩放、几何和持久化，Widget 不直接操作 dockview；
4. **拖动手柄固定**：MovableBox 使用 Widget 标题栏作为拖拽把手；
5. **布局恢复失败可回退**：偏好损坏时使用默认 Panel，不白屏。

### 11.7 当前实现边界

`PaneView.vue`、`PaneFrame.vue`、`layout.model.ts` 和旧 `features/*` Pane 注册代码仍可能作为 P1b 兼容文件存在，但不是当前主渲染链路。新增功能应优先落在 `DockviewLayout.vue`、`PanelContainer.vue`、`layout.store.ts` 和 `widgets/`。

---
## 12. 迁移路线图

每阶段一个可独立合入的 PR。**绿灯标准统一**：

```bash
# Core
npm test --prefix core                 # vitest 全绿
npm run build --prefix core            # tsc 零错误
# 冒烟：node core/dist/main.js 启动，/health 可接，spawn 一个 hello-world 服务

# Client
npm test --prefix client               # vitest 全绿
npm run build --prefix client          # tsc + vite build 零错误
# 冒烟：布局拖拽 → 刷新还原 → 拉出独立窗 → 重启复原
```

### 阶段 1 · 进程内 ctx + 总线雏形（~3-5 天）

- 新增 `src/container/context.ts`（对齐 Cordis 的 `mount`/`inject`/`effect`/`on`/`emit`/`waterfall`/`scope`）。
- 四个 `setXxxRuntime` 单例改写成 `ctx.mount({ inject: ['transport.broadcaster'], apply })` 插件。
- 引入进程内事件总线：`bus.publish` / `bus.subscribe`，第一个真实用例是 `run.started` 日志监听。
- `app.ts` 里 7 段内联 sweep → 独立 LifecyclePlugin，隐性顺序用 `order` 显式化。
- 旧 set/get 保留薄兼容壳。

**绿灯**：60+ vitest 原样全绿 + container + bus 单测绿；app.ts 收敛成装配器。

### 阶段 2 · Core 与第一个进程外服务（~1-2 周）

- Core 从 server 剥离，独立为 `core/`：进程管理 + 总线 + SSE 桥。
- 定义服务 manifest 规范 + `shared/events.ts` 事件契约。
- 写 TS SDK，**第一个进程外服务**：LLM 服务，通过 stdio JSON-RPC 接入总线。
- 健康检查、崩溃重启、优雅停止。
- 前端暴露 `/events` SSE 端点 + `/api/command`。

**绿灯**：重启 LLM 服务不影响 Core 和其他服务；前端 SSE 收到 `llm.token.streamed` 流。

### 阶段 3 · 服务拆分 + 前端工作台（~2-3 周）

- Loop 服务、角色服务、统计服务逐一拆成独立进程。
- **统计服务旁路订阅** `llm.*` / `tools.*`——验证「零侵入可观察」。
- Python SDK + 一个 Python 服务（验证协议中立性）。
- 前端 Vue 3 + `dockview-vue` + `vue-movable-box`：实现 Panel / Widget 两层工作台、布局持久化和独立窗口。
- 现有导航 / SessionPanel / ChatArea / RightPanel 七段按业务能力拆成 Widget，再由 Panel 组织。

**绿灯**：拖拽布局 + 刷新还原 + 拉出独立窗 + 重启复原；统计 Pane 实时计数。

### 阶段 4 · 事件持久化 + 多语言服务（远期，另立 RFC）

- 关键事件落 SQLite，`bus.replay(from, to)` API。
- 统计服务支持历史回放，重启不丢计数。
- Rust SDK / Go SDK。
- 服务市场 / 安装器 / 签名验证。

---

## 13. 迁移期不变式

任何**新增/修改**代码必须遵守：

1. **Model-visible means logged** —— 写入模型上下文的任何新内容，必须先有 durable 事件 + 落库，不准只写内存。
2. **服务间不直连** —— 所有通信经过总线，配对靠 `requestId`，通道管理归 Core。
3. **旁路消费者零侵入** —— 统计 / 日志 / 审计服务只订阅不发布，不要求现有服务改代码。
4. **Core 不跑业务逻辑** —— Core 只管进程管理、总线、SSE 桥；任何业务模块必须下沉为服务。
5. **任一注册必带 disposer** —— `ctx.on/effect` / `bus.subscribe` 都返回回卷函数。
6. **前端禁新增「页面级装配」** —— 新业务信息面优先注册为 Widget，由 Panel 组织；禁止把业务装配硬编码进 `App.vue` 或 `MainLayout.vue`。
7. **前端禁复制服务端数据到本地 store** —— 所有持久数据走 SSE，本地态只有 `activeSessionId` 和 layout。
8. **事件只增不改** —— 破坏性变更必须升版本；payload 必须 JSON 可序列化。
9. **每阶段一个 PR + 全绿 + 可单独 revert** —— 不允许跨阶段大爆炸提交。

---

## 14. 非目标与边界

| 事项 | 状态 |
|---|---|
| 引入 Cordis 作为运行时依赖 | ❌ 初期不引入；Bus 接口对齐，预留替换点 |
| 引入外部消息中间件（NATS / Redis / ZeroMQ） | ❌ 总线自研，桌面应用不跑 broker |
| 重写 store / db 实现 | ❌ 只加接口皮 |
| 运行时热插拔（不重启服务热替换） | ❌ 本期只做「重启单个服务不重启 Core」 |
| 一次支持所有语言 | ❌ 先 TS，再 Python，后 Rust / Go |
| 运行时安装第三方服务 | ❌ 先编译期发现内置服务 |
| 跨窗拖拽 | ❌ 远期；v1 只做「同窗内换位 + 拉出独立窗」 |
| 复制窗 / 一窗一会话 | ❌ 远期；v1 全局单上下文 |
| 操作类对话框窗化（选角色 / 审批 / 编辑） | ❌ 保持模态 |
| 服务直连旁路 | ❌ 服务 A 不能绕过总线直调服务 B |
| 进程内跑非 TS 服务 | ❌ 进程内只跑 TS 模块 |
| 兼容 dsh 插件运行时 | ❌ 远期可选；本期不做 |
| 一次性全服务化 | ❌ strangler，每阶段只做承诺范围 |

---

## 15. dsh 成熟度对标

> **决策**：整体不嵌入 dsh 作为运行时；但对个别子系统，若 dsh 的实现明显更成熟，按「**移植契约词汇、实现长在 Osteosome 自己的存储上**」吸收（dsh 为 MIT）。

### 15.1 对标矩阵

| 分组 | 能力 | dsh 成熟形态 | Osteosome 现状 | 结论 |
|---|---|---|---|---|
| **A · 移植** | LLM 适配器 | `LlmAdapter.stream(): AsyncIterable<StreamChunk>` 中立流契约 + 按供应商独立包；声明式 `retryPolicy` + 错误码化；`token-meter` 重放日志测算 | `llm/client.ts` 单一 openai 兼容 wire（681 行）+ `format` 死配置 + 字符串判 429 + 4 字段记账 | 契约形状待对齐（见 §16） |
| **A · 移植** | 会话模型 | `Session` = 仅追加类型化事件日志，单一事实源；LLM 历史从日志派生 | `run_events` 仅半套 durable 流；messages/sessions 仍存关系表 | 事件化未走完 |
| **A · 移植** | Compaction | 完整 seam：`compaction/start\|summary\|end` log-only + 全程锁 + `shadowedSeqs` 书签 + `surfaceOp` 落面 | outer.ts 内联冷启动压缩 + loop 内剪枝、硬阈值 | 无锁、无书签、无事件化 |
| **A · 移植** | 工具执行管线 | `tools/pre-execute → execute → post-execute` + policy 监听；审批/权限预设独立 | workspace 审批以 if/else 散布在 loop | 只有肉，没有管线 |
| B · 相当 | skills / goal / plan / 子代理 | skills 目录、same-session goals、plan mode、subagent providers | SKILL.md 技能包、承诺式 goal/plan、角色委托 | 不为移植而移植 |
| C · 借思路 | sandbox / 终端 / jobs / LSP / 代码运行 / web | landlock 沙箱、PTY、代码运行器… | Windows 桌面 + 工具目录 + SQLite | 平台不合，只借 seam 分层思路 |

### 15.2 A 组四项移植契约

**① 会话模型 → 对齐 event-sourced log**

- 契约：会话 = 仅追加类型化事件日志；任何 model-visible 内容必有对应事件类型；消息历史由日志派生（投影表），重放 = 重新派生。
- 落点：`run_events` 已半成形；目标是把 messages/sessions 的写入收敛为「写事件 → 派生表」。
- 边界：数据模型层改动，独立成步，与 storage 服务化配合，**只能事件化不能先斩旧表**。

**② Compaction → dsh 形状的 seam**

- 词汇：`compaction/start | summary | end` 三个 log-only 事件；锁包围全程；`shadowedSeqs` 为被遮蔽节点权威集；摘要本身是带 `surfaceOp:{op:'replace'}` 的 `user/message`。
- 落点：`run.before-compact` 扩展为这套词汇 + 触发词（`pressure | context-overflow`）。
- 验收：压缩全程可重放、可审计；孤儿锁由 LifecyclePlugin 回收。

**③ 工具执行管线 → pre/execute/post + policy 监听**

- 形状：`tools.pre-execute / post-execute` 两个 waterfall 点；审批/只读判定从 if/else 变 listener。
- 验收：审批与执行解耦；策略挂载可逆；新增策略不碰 loop。

**④ LLM 适配器 → 中立流契约 + 声明式 retry 与错误码**

- 契约：`stream()` 输出带 block 边界的类型化流（文本 / 推理 / 工具 call 显式块），末尾 `finish` 终块携带稳定错误码与 Retry-After。
- 落点：`llm/client.ts` 的 `LLMChunk` 块化；`format` 兑现或删除；字符串判 429 收敛为错误码；disjoint 记账；凭证 seam。
- 验收：新增供应商不再手改单函数；google preset baseUrl 恢复可连通；错误告别字符串匹配。
- **本地化落点（2026-09-23）**：接缝三角（`LlmAdapter` / `StreamChunk` / 凭证引用 / retry 声明）+ deepseek 单实现见 `docs/开发进度/P2-详细计划.md`；三 provider 实现 + 凭证 seam + `listModels()` + retry 执行器见 `docs/开发进度/P4-详细计划.md`。

**落地顺序**：④ LLM 适配器（最小、纯行为侧，先做）→ ③ 工具管线 → ① 会话事件化（数据层大改）→ ② Compaction（依赖事件化土壤）。

---

## 16. LLM Provider 适配器对标与问题清单

> **复核结论**：原判 providers 为「B · 相当，不动」，本次深调研推翻——Osteosome 的 provider 层不是「适配器集合」，而是**「目录 + 单一 openai 兼容 wire」**。dsh 的 `packages/llm/*` 构型显著更成熟。

### 16.1 三层栈（适配器其实是目录）

| 层 | 内容 | 证据 |
|---|---|---|
| ① 遗留静态目录 | `providers/*.ts` ×35，每文件 ~16 行 | `provider-catalog/loader.ts:143` |
| ② 出厂预设 | `content/builtin/providers/*/provider.json`（18 家） | `schema.ts:11-74` |
| ③ 运行时 | `db/providerStore.ts` + `llm/client.ts`（681 行）干全部 wire | `outer.ts:78-88` |

### 16.2 问题清单

1. **`format` 字段是死配置**：schema.ts:39 声明 3 种格式，请求路径无任何按 `format` 分支。
2. **google 预设大概率 404**：baseUrl=`https://generativelanguage.googleapis.com/v1/` 被拼成 `/v1/chat/completions`，与 Gemini 官方 OpenAI 兼容路径 `/v1beta/openai/` 不符。
3. **thinking / reasoning 靠字符串嗅探**：`reasoning_content` / `reasoning` / `response.reasoning_summary_text.delta` 三路硬匹配（client.ts:432-437、596-602）。
4. **重试策略在 agent 不在 provider**：`streamWithRetry` 是 `agent/inner.ts:238` 的通用循环，429 靠 `includes('429')` 判定。
5. **错误分类是字符串表**：`isTransientLLMError` 一串 `includes()`（llm/errors.ts:39-69）。
6. **双轨并存**：35 静态插件 + 预设目录 + DB 三层叠着。
7. **凭证单轨**：`getApiKey: () => process.env[...]`（types.ts:27）。
8. **记账 4 字段**：`input/output/cacheHit/cacheMiss`（client.ts:64-69）。
9. **能力是静态元数据**：`supports_*` 写死在 catalog。

### 16.3 dsh 参照

| 维度 | dsh | Osteosome |
|---|---|---|
| 契约 | `LlmAdapter.stream(): AsyncIterable<StreamChunk>` 中立流 | 松散 `LLMChunk` |
| 组织 | 核心虚类 + 按供应商独立包 | 单函数写死 openai 兼容两种协议 |
| 重试 | `providerRetryPolicy()` 声明 + `llm-retry` 独立插件 | agent 循环 + env 常量 |
| 记账 | `token-meter` 重放日志 | 仅透传响应 usage，4 字段 |
| 错误 | `LlmError` 稳定码 | `includes()` 字符串表 |
| 凭证 | `ctx.credentials` seam | env 进程级 + OAuth 旁路 |

**提级决策**：providers 提级为 A 组「契约对齐」——`LLMChunk` 块化、`format` 兑现或删除、错误码化、disjoint 记账、凭证 seam。独立成步，与 LLM 服务化并行。**实现状态**：契约对齐于 P2（块化 / 错误码）/ P4（format 删除 / 记账 / 凭证 seam）分批兑现，见 `docs/开发进度/P2-详细计划.md` 与 `P4-详细计划.md`。

---

## 17. 技术选型

### 17.1 Core 选型：TS / Node（明确）

| 维度 | TS / Node | Python |
|---|---|---|
| 进程管理 | ⭐⭐⭐ `child_process` + `execa` | ⭐⭐ `subprocess` + asyncio |
| 消息总线 | ⭐⭐⭐ `EventEmitter` 扩展 | ⭐⭐ asyncio pub/sub |
| SSE 桥 | ⭐⭐⭐ 原生 `ReadableStream` | ⭐⭐ FastAPI / aiohttp |
| 前端类型共享 | ⭐⭐⭐ TS 类型共享（Core ↔ Vue Pane） | ⭐ 无法共享 |
| Electron 集成 | ⭐⭐⭐ 同语言 | ⭐ sidecar 复杂 |
| 打包 | ⭐⭐⭐ 一套 Node | ⭐ PyInstaller 坑 |

**结论**：Core 极薄（进程管理 + 总线 + SSE 桥），IO 密集、协议密集、胶水密集——这是 TS / Node 的主场。Python 应该作为「某个需要 AI 生态的服务」的实现语言，而不是 Core。

### 17.2 前端选型：Vue 3 + dockview-vue

| 层 | 推荐 | 理由 |
|---|---|---|
| 桌面框架 | **Electron** | Node.js 生态，`BrowserWindow` 弹窗机械成熟 |
| 前端框架 | **Vue 3 + TypeScript** | SFC + `<script setup>` 类型推导自然，Pinia 简洁 |
| 构建 | **Vite** | 快，`import.meta.glob` 编译期发现 |
| 外层布局引擎 | **dockview-vue** | 官方支持，负责 Panel 停靠、拆分、比例和序列化 |
| 内层组件布局 | **vue-movable-box** | Panel 内 Widget 自由拖动、缩放、吸附和几何持久化 |
| 状态 | **Pinia** | Vue 官方状态库 |
| 样式隔离 | **Shadow DOM + CSS 变量** | 防止服务前端样式污染 |
| 跨窗通信 | **BroadcastChannel** | 同源零配置 |
| 数据流 | **SSE + HTTP POST** | 单向优先，服务端真源 |

**关于 React vs Vue**：当前仓库已经使用 Vue 3。`dockview-vue` 负责外层 Panel 布局，`vue-movable-box` 负责 Panel 内 Widget 布局；两者职责分层，不能把 Widget 拖动逻辑重新放回 dockview。

### 17.3 SDK 多语言路线

| 语言 | 阶段 | 理由 |
|---|---|---|
| **TS** | 阶段 1-2 | 和 Core 同语言，复用 `shared/events.ts` |
| **Python** | 阶段 3 | AI / 数据处理生态 |
| **Rust** | 阶段 4 | 性能敏感服务 |
| **Go** | 阶段 4 | 并发密集服务 |

---

## 18. 总结

Osteosome v3 的架构本质：**微内核 + 多语言服务 + 可观察总线**。

- **Core（TS，极薄，很少更新）**：进程管理 + 消息总线 + SSE 桥，不跑业务。
- **服务（进程外，语言自由，可热插拔）**：LLM / Loop / 角色 / 统计，各自 publishes / subscribes，通过总线通信。
- **前端（Vue + dockview-vue + vue-movable-box）**：Panel 外层布局和 Widget 内层布局均可序列化；Widget 订阅 SSE、POST 发命令，Panel 可拉出独立窗。

**服务 = 独立进程 + manifest + 事件契约**。新增一个服务 = 新增一个进程 + 若干 Pane + 一组事件类型。**旁路消费者（统计 / 日志 / 审计）零侵入**，只订阅不发布。

| 交付级别 | 内容 | 周期 |
|---|---|---|
| **最低可交付** | 阶段 1-2：Core 剥离、总线可用、LLM 服务跑通、前端 SSE 收到流 | ~2-3 周 |
| **完整工作台** | 阶段 3：多服务拆分、统计旁路验证、Vue 工作台化 | ~4-6 周 |
| **远期愿景** | 阶段 4：事件持久化 + 回放、多语言 SDK、服务市场 | — |

**下一步建议**：

1. 开工起点参考修订路线图（`core开发文档.md` §8 + `阶段追踪.md`），从 **P1a（Core + hello-world）** 起步。
2. P1b（Pane 工作台骨架）先于 P2；P2 写死单 provider 但必须走中立流契约，P4 只换 providers 层。
3. P3 显式做最小 Loop 再上 P5-P7 —— 角色 / 技能 / MCP 都挂在它上面。
4. P8（事件持久化、多语言 SDK、服务市场）独立成 RFC 细化。

---

## 附录 A：现状耦合证据索引

| 症状 | 位置 |
|---|---|
| 全局单例 set/get 对 | transport/runtime.ts:30-37；routes/goals.ts、routes/runs.ts、event/event-run-adapter.ts 同构 |
| app.ts import 全部路由+子系统 | app.ts:6-33 |
| 内联启动 sweep ×7 | app.ts:176-264 |
| boot 时塞 runtime | app.ts:328-331 |
| outer god-function | agent/outer.ts:56-529 |
| loop 内嵌策略 | agent/loop/loop-engine.ts:145-784 |
| 路由模块级单例 | routes/messages.ts:5 等 |
| 工具已插件化 | tools/registry.ts:13-54 |
| provider 已 seam | providers/types.ts + providers/openai-compatible.ts |
| 会话 durable 事件 | agent/runtime/run-event-store.ts |
| 前端导航是数组 | App.tsx:30-39、113-145 |
| 前端启动副作用硬编码 | App.tsx:48-106 |
| ChatPage 装配写死 | ChatPage.tsx |
| RightPanel monolith | RightPanel.tsx:331-345 |

## 附录 B：Core 模块依赖图（文字版）

```
                     ┌──────────────────────────┐
                     │           Bus            │
                     │  publish / subscribe     │
                     │  + 可选持久化             │
                     └────┬────────────────┬────┘
                          │                │
              ┌───────────┘                └────────────┐
              ▼                                         ▼
     ┌──────────────────┐                    ┌──────────────────┐
     │ ServiceManager   │    ✕ 无直连 ✕       │   SseBridge      │
     │ - spawn / kill   │                    │ - /events (SSE)  │
     │ - manifest 校验   │                    │ - /api/command   │
     │ - 健康检查        │                    │ - 静态资源        │
     │ - JSON-RPC 分帧   │                    │ - 每连接独立订阅   │
     └────────┬─────────┘                    └─────────┬────────┘
              │ stdio JSON-RPC                        │ HTTP / SSE
              ▼                                       ▼
     ┌──────────────────┐                    ┌──────────────────┐
     │  服务进程         │                    │    前端 Panel / Widget      │
     │  LLM / Loop / ... │                    │  Vue + dockview  │
     └──────────────────┘                    └──────────────────┘
```

**箭头语义**：

| 方向 | 含义 |
|---|---|
| ServiceManager → Bus（青色向上） | `bus.publish('service.*')` —— 生命周期事件发布 |
| Bus → ServiceManager（橙色向下） | `bus.event` —— Core 把服务订阅的事件推给它 |
| SseBridge → Bus（青色向上） | `bus.publish` —— 前端命令投递到总线 |
| Bus → SseBridge（橙色向下） | `bus.event` —— 总线事件推给 SSE 连接 |
| ServiceManager ↔ 服务进程（灰色） | stdio JSON-RPC |
| SseBridge ↔ 前端 Panel / Widget（灰色） | HTTP / SSE |

**没有的箭头**：ServiceManager ↔ SseBridge 直连。这是不变式：管道之间不直接说话，都经过 Bus。

---

> **关联文档**：
> - `ost-core-rfc.md` —— Core 微内核 RFC（本文件 §5-8 的独立展开）
> - `dev/docs/dsh-vs-tianshu-tools.md` —— 工具系统级对比
> - DeepSeek Harness 文档「Everything is a Plugin」
> - Cordis Primer：https://github.com/cordiverse/cordis
> - dockview 文档：https://dockview.dev