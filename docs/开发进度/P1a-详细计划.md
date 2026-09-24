# P1a 详细计划 · Core 微内核 + hello-world 服务

> 归属：`阶段追踪.md` 里程碑 **P1a** ｜ 上游：`../core开发文档.md`（Core RFC §2-§8）
> 状态：已完成（2026-09-24 绿灯全过） ｜ 作者：dmql ｜ 日期：2026-09-23
> 验收口径：**一个 PR + 全绿 + 可单独 revert**

---

## 0. 目标与范围

### 0.1 目标

把 Core 微内核完整落地：**Bus + ServiceManager + SseBridge** 三个模块、TS 服务 SDK、`shared/` 类型契约，并用一个 **hello-world 服务**跑通「启动 → 握手 → 命令 → 事件推流 → 崩溃重启」的端到端链路。它是 P1b-P8 的地基，API 一旦稳定不再改动，后续所有演化都发生在服务里。

### 0.2 范围内（In Scope）

| 项 | 说明 |
|---|---|
| 微内核三模块 | Bus / ServiceManager / SseBridge（RFC §2-§4） |
| 进程管理 | spawn / kill、manifest 校验、拓扑排序、健康检查、崩溃重启、优雅停止 |
| JSON-RPC | `Content-Length` 分帧 + 握手 + 方法集（RFC §3.4-3.5） |
| TS SDK | `@osteosome/service-sdk`（RFC §6.3） |
| 共享契约 | `shared/events.ts` + `manifest.ts` + `protocol.ts` |
| 持久化 | MemoryAdapter / NullAdapter 两种；SQLite 延后（修订说明） |
| 冒烟服务 | `services/hello/` 一个 hello-world 服务端到端 |
| HTTP | `/events` + `/api/command` + `/api/preferences` + `/health` + 静态资源 |

### 0.3 范围外（Out of Scope）

- ❌ LLM 服务 / Loop / 角色 / 统计等真实业务服务（P2 起）
- ❌ SQLite 事件落库 + `bus.replay` 持久化（P8）
- ❌ Python / Rust SDK（阶段 D）
- ❌ 前端 client / dockview / Pane（P1b）
- ❌ 运行时安装第三方服务、跨窗拖拽

---

## 1. 仓库改造

P1a 起把仓库升级为 **pnpm monorepo**（RFC §7.1）：

```
osteosome/
├── package.json                     # workspace root
├── pnpm-workspace.yaml              # packages: core / shared / sdk/* / services/*
├── tsconfig.base.json               # strict 公共配置
├── .gitignore                       # node_modules / dist / data
├── docs/                            # 已就位（本文档系）
├── core/                            # 本次主产物
├── shared/                          # 类型与契约唯一真相源
├── sdk/ts/                          # TS 服务 SDK
└── services/hello/                  # 端到端冒烟服务
```

### core/（主产物）

```
core/
├── package.json                     # name: @osteosome/core
├── tsconfig.json
├── src/
│   ├── main.ts                      # 组装：Bus + ServiceManager + SseBridge
│   ├── bus/
│   │   ├── bus.ts                   # publish / subscribe / replay / stats / ready
│   │   ├── pattern.ts               # 通配符匹配（单段 * / 多段 ** / 裸 * 全量）
│   │   ├── persistence.ts           # MemoryAdapter / NullAdapter
│   │   └── types.ts                 # EventKey / EventPayload / EventBase
│   ├── service-manager/
│   │   ├── manager.ts               # 启动/停止/重启编排 + service.* 事件
│   │   ├── process.ts               # spawn / kill / 信号（Windows-safe）
│   │   ├── manifest.ts              # 加载 + schema 校验
│   │   ├── topology.ts              # 依赖图 + 拓扑排序 + 环检测
│   │   ├── health.ts                # 心跳 + 重启策略（backoff）
│   │   └── jsonrpc/
│   │       ├── framing.ts           # Content-Length 分帧（解码/编码）
│   │       ├── client.ts            # Core 侧 JSON-RPC 客户端
│   │       └── protocol.ts          # 方法集 / 协议版本常量
│   ├── sse-bridge/
│   │   ├── server.ts                # node:http 服务器（含 GET /health）
│   │   ├── sse.ts                   # GET /events（每连接独立过滤订阅）
│   │   ├── command.ts               # POST /api/command（202 + bus.publish）
│   │   ├── preferences.ts           # GET/PUT /api/preferences（dataDir JSON）
│   │   └── static.ts                # 静态资源（dist/client，无则 404 fallback）
│   ├── config/
│   │   ├── config.ts                # CLI env 配置加载
│   │   └── paths.ts                 # dataDir / servicesDir / distDir
│   └── logger.ts                    # 统一日志（stdout，结构化为 JSON 可选）
└── tests/
    ├── bus.test.ts
    ├── pattern.test.ts
    ├── manager.test.ts
    ├── sse.test.ts
    └── e2e.test.ts
```

> **决策**：SSE 服务器用 **node:http 原生**（RFC §17.1 主张原生 ReadableStream），零运行时依赖。RFC §5.4 的 `Hono/原生` 二选一在此定案。

### shared/

```
shared/
├── package.json                     # name: @osteosome/shared
└── src/
    ├── events.ts                    # EventMap 声明（declare module merging）
    ├── manifest.ts                  # Manifest 类型 + Zod schema
    ├── paths.ts                     # 数据目录约定：serviceDataDir()（服务只写自己的 services/<id>/）
    ├── protocol.ts                  # JSON-RPC 方法集 / 协议版本
    └── types.ts                     # ServiceId / PaneId / ServiceStatus 等
```

### sdk/ts/

```
sdk/ts/
├── package.json                     # name: @osteosome/service-sdk
└── src/
    ├── service.ts                   # Service 类（subscribe / publish / start / 优雅退出）
    ├── transport.ts                 # stdio 分帧 + JSON-RPC 双向
    ├── handshake.ts                 # initialize / initialized / 失败重试
    ├── heartbeat.ts                 # 收到 health.ping 自动回 health.pong
    └── logger.ts                    # stderr 日志（不污染协议流）
```

### services/hello/

```
services/hello/
├── service.json                     # manifest
├── package.json
├── src/index.ts                     # 订阅 hello.command → 发布 hello.command.*
└── tsconfig.json
```

---

## 2. 工作分解（WS-1 ~ WS-7）

### WS-1 · 脚手架就位（0.5d）

- [x] 根 `package.json`（private）+ `pnpm-workspace.yaml` + `tsconfig.base.json`（strict） + `.gitignore`
- [x] 四个 workspace 的 `package.json` / `tsconfig.json` 对齐（路径 `../../tsconfig.base.json`）
- [x] 引入 vitest + typescript，版本锁在一个 json（root devDependencies）
- [x] **子绿灯**：`pnpm install` 干净；每个 workspace `tsc --noEmit` 零错误（空壳）

### WS-2 · Bus 模块（2d）

- [x] `shared/src/events.ts` —— 首批 EventMap（见 §3）
- [x] `core/src/bus/types.ts` —— EventKey / EventPayload / EventBase（`ts`/`source` 必填）
- [x] `core/src/bus/pattern.ts` —— 通配符：`*` 单段 / `**` 多段 / 裸 `*` 全量
- [x] `core/src/bus/persistence.ts` —— MemoryAdapter（Array 存储）/ NullAdapter（不下发）；接口预留 SqliteAdapter
- [x] `core/src/bus/bus.ts` ——
  - `publish`：同步返回、异步投递（微任务）；`persist` 由 `persist:true` 或 topic 前缀白名单决定
  - `subscribe`：`once` / `priority` / `filter`；返回 disposer
  - 背压队列上限默认 10000，超限丢最旧并计 `stats.dropped`
  - 错误隔离：handler 抛错 → 日志 → 继续下一个
  - `replay`：基于持久化适配器的 AsyncIterable；`stats()`；`ready()`
- [x] `tests/bus.test.ts` + `tests/pattern.test.ts` —— 见 §4

### WS-3 · ServiceManager 模块（3d）

- [x] `shared/src/manifest.ts` —— Zod schema：必填 `id/version/protocolVersion/entry/publishes/subscribes`；`inject/panes/healthCheck/restartPolicy` 可缺省；`writableDirs?: string[]` 可选（声明 `services/<id>/` 下额外子目录，缺省只允许该目录根，见 §3.1）
- [x] `shared/src/protocol.ts` —— 方法集常量 + `PROTOCOL_VERSION`
- [x] `core/src/service-manager/jsonrpc/framing.ts` —— 解码：流式累积 `Content-Length\r\n\r\n` 消息体，处理粘包 / 拆包 / UTF-8 跨块；编码：`Content-Length` 头；非法 `Content-Length`（非数字 / 超上限 / 头解析失败）→ **关闭该服务的 stdio 连接 + 打日志 + Core 标记该服务 `failed` 触发重启**（对齐 LSP 规范：头解析失败后流已不可信，**不重对齐**——消息体内可能恰好含 `Content-Length:` 字符串被误判为新帧头）〔补强 ①，二轮 review 改为关连接策略〕
- [x] `core/src/service-manager/jsonrpc/protocol.ts` —— 方法集定义（RFC §3.5）；`initialize` 响应含 **`dataDir`**（数据根目录）+ `sessionId` + `heartbeatInterval`（见 §3.1）
- [x] `core/src/service-manager/jsonrpc/client.ts` —— 请求 / 通知 / 响应配对（`id`），超时判定，pending 表
- [x] `core/src/service-manager/process.ts` —— spawn（Windows-safe：直接 `node <abs path>`，不用 shell）；kill；SIGTERM→等→SIGKILL
- [x] `core/src/service-manager/topology.ts` —— inject → 有向图；环 → 拒绝启动（fail fast）
- [x] `core/src/service-manager/manifest.ts` —— 扫 `services/*/service.json` + 校验（schema / protocolVersion / 事件一致性）
- [x] `core/src/service-manager/health.ts` —— interval 发 `health.ping`，timeout 判失败；连续失败 N 次 → kill 重启；超 `maxRestarts` → `failed`；backoff exponential/fixed
- [x] `core/src/service-manager/manager.ts` —— 启动顺序（拓扑序、逐个握手、注册、心跳）、`service.*` 事件发布、`restart` 热插拔、逆序停止
- [x] `tests/manager.test.ts` —— 见 §4

### WS-4 · SseBridge 模块（1.5d）

- [x] `config/config.ts` + `paths.ts` —— 从 CLI / env 解析 `--services` / `--data` / `--dist` / `--port`（默认 1420）
- [x] `sse-bridge/server.ts` —— node:http；路由 `/events` `/api/command` `/api/preferences` `/health` `/*`；`GET /health` 返回 `{ ok, uptime, services: list() }`；**Origin 白名单**（`/events` + 全部 `/api/*`）：放行 `http://127.0.0.1:1420` / `http://localhost:1420` / **不带 `Origin` 头**（非浏览器，如 msw / curl / Node fetch）/ **`Origin: null`**（`file://` 页面、Electron 部分场景），其余（其他 http(s) 源）→ 403——防任意网页 `fetch('http://127.0.0.1:1420/api/...')` 打本机（P4 凭证 CSRF 同源生效，但白名单是 P1a 一次加全局覆盖）
- [x] `sse-bridge/sse.ts` —— 每连接 = 一个过滤后的 Bus 订阅；`?topics=` 逗号分隔；统一 `event: message` + body 内带 `topic`；30s 心跳注释行；连接关闭 → dispose；预留 `Last-Event-ID`；**90s 无有效写 → 主动断僵尸连接**（TCP 静默断开兜底，客户端 EventSource 自动重连）〔补强 ②〕
- [x] `sse-bridge/command.ts` —— POST → `202 Accepted` → `bus.publish(topic, payload)`
- [x] `sse-bridge/preferences.ts` —— GET/PUT，dataDir 下 JSON 文件（P1b 布局使用）
- [x] `sse-bridge/static.ts` —— 静态目录存在则 serve，否则回 `index.html` 占位
- [x] `logger.ts` —— 统一日志（含帧错误、背压丢弃、服务事件）
- [x] `tests/sse.test.ts` —— 见 §4

### WS-5 · TS SDK（1.5d）

- [x] `transport.ts` —— 复用/独立实现 stdio 分帧（与 Core 同一规范，不共享实现）
- [x] `handshake.ts` —— 自动发 `initialize`，等响应（超时重试），发 `initialized`；响应里读 **`dataDir`** 挂到 `service.dataDir`（沿同一规范复用，不重复实现）
- [x] `heartbeat.ts` —— 收到 `health.ping` 自动 `health.pong`
- [x] `service.ts` —— `new Service({ id, version })`；`service.subscribe(topic, handler)` **返回 disposer**（与 Bus 一致，进程退出前自动调用）；`bus.publish(...)`；**暴露 `service.dataDir`**；SIGTERM 优雅退出（停止接收→等完成→`shutdown`）
- [x] `logger.ts` —— stderr
- [x] `tests/`（SDK 侧）—— transport 分帧对拍 + service 对伪造 Core 的握手/心跳/事件分派

### WS-6 · hello-world 服务 + 端到端（1d）

- [x] `services/hello/` —— manifest + index.ts：订阅 `hello.command` → 发 `hello.command.started/executed`
- [x] `core/tests/e2e.test.ts` —— 见 §4
- [x] 冒烟脚本（repo 根 `scripts/smoke.mjs` 或 README 命令）：启动 core → `/health` 可接 → 命令注入 → SSE 收流

### WS-7 · 收尾（0.5d）

- [x] `../core开发文档.md` §8 勾选 P1a 项
- [x] `阶段追踪.md` P1a 状态更新 + 交付物全勾
- [x] 绿灯命令全集复跑（见 §5）

---

## 3. 事件契约（P1a 首批）

`shared/src/events.ts` 只声明 P1a 实际用到的 topic；后续沿用**只增不改**（RFC §6.2），llm/loop/character 等在后续阶段追加。

| Topic | 语义 | Payload |
|---|---|---|
| `service.starting` | Core spawn 进程后（已发布） | `{ serviceId, version }` |
| `service.ready` | 握手成功 | `{ serviceId, version, panes? }` |
| `service.restarting` | 崩溃后准备重启 | `{ serviceId, reason }` |
| `service.failed` | 重启超限 / 协议错误 | `{ serviceId, exitCode, reason }` |
| `service.stopped` | 正常停止 | `{ serviceId }` |
| `hello.command.started` | hello 服务收到命令 | `{ requestId, text }` |
| `hello.command.executed` | 处理完成 | `{ requestId, echo }` |
| `hello.command.failed` | 处理异常 | `{ requestId, reason }` |

**命令 topic**（走 `/api/command`，非事件）：`hello.command` — `{ requestId, text }`。

> 通配符定案：`*` 匹配 **恰好一个段**，`**` 匹配 **零或多个段**，裸 `*` 匹配全量。例：`hello.*` 匹配 `hello.command.started`；`service.*` 匹配 `service.ready`。

### 3.1 数据目录约定（跨阶段契约 · 卡 P2/P3/P4）

服务进程怎么知道往哪儿写数据——**P1a 的 `initialize` 握手响应里带 `dataDir`**：

```ts
// core/src/service-manager/jsonrpc/protocol.ts —— Core → 服务 initialize 响应
{
  "sessionId": "core-session-abc",
  "heartbeatInterval": 5000,
  "dataDir": "/Users/dmql/.osteosome"        // ★ 新增：数据根目录（--data 传入）
}
```

- SDK 侧：`handshake.ts` 读 `dataDir` → `service.dataDir`（`services/hello/src/index.ts` 直接可用）。
- `shared/src/paths.ts`：

```ts
export function serviceDataDir(dataDir: string, serviceId: string): string
// → `${dataDir}/services/${serviceId}/`
```

- **约定：每个服务只写自己的 `services/<id>/` 子目录**。P4 的 llm 配置 → `serviceDataDir(dataDir, 'llm')/config.json`；P3 的会话 → `serviceDataDir(dataDir, 'session')/sessions/`；P4 的 `credentials.json` 是 **Core 自己的**数据，直接落 `dataDir/credentials.json`（不走此约定）。
- `manifest.ts` 允许可选 `writableDirs: string[]`：服务声明 `services/<id>/` 之下的额外子目录。**这是声明式约定，非运行时强制**——Core 不校验服务的文件写入（独立进程、进程内无沙箱）；各服务用 `serviceDataDir()` 计算自己的根、**不碰其他服务的目录是纪律，不是机制**。P8+ 若加进程沙箱再强化为强制。

- **`heartbeatInterval` 来源定案**：manifest 的 `healthCheck.interval`（服务在 manifest 声明）→ **Core 读取后在 `initialize` 响应里回发**；服务不主动带，接受 Core 权威（避免「manifest vs 握手响应」两个真源）。

---

## 4. 测试矩阵

| 模块 | 用例要求（至少覆盖） |
|---|---|
| pattern | 单段 `*`、多段 `**`、裸 `*`、精确 topic、无匹配、非前缀误匹配 |
| bus | 同步返回异步投递、错误隔离不中断、disposer 回卷、priority 顺序、once 只触发一次、filter 生效、背压超限丢最旧且 `stats.dropped`+1、MemoryAdapter replay 保序 |
| framing | 编码/解码往返、粘包（一帧含多消息）、拆包（跨块）、UTF-8 多字节跨块、**非法头 → 关连接 + 标记 failed + 重启（非重对齐）** |
| manifest | 缺必填字段、protocolVersion 不兼容、topic 未声明 → 全部 fail fast |
| topology | 线性依赖、菱形依赖、环检测、未知 inject 拒绝 |
| health | pong 正常保持 ready、超时判失败、连续失败触发重启、超 maxRestarts → failed、backoff 序列 |
| process/manager | 启动顺序符合拓扑、停止逆序、SIGTERM 优雅停止超时强杀、崩溃→`service.restarting`→恢复、`service.*` 事件在总线上可见 |
| sse | `?topics=` 过滤生效、publish → 推流格式正确、心跳注释、连接关闭 dispose、command 202 且到达总线、**僵尸连接 90s 主动断** |
| e2e | 启动 core → /health → spawn hello → POST `hello.command` → SSE 收到 `hello.command.*`；kill hello 进程 → 自动拉起 → 事件恢复 |

---

## 5. 绿灯标准

```powershell
# 单测全绿
pnpm --filter @osteosome/core test          # 等价 npm test --prefix core
pnpm --filter @osteosome/sdk test

# 构建零错误
pnpm --filter @osteosome/core build         # tsc --noEmit + tsc 产物
pnpm --filter @osteosome/sdk build
pnpm --filter @osteosome/hello build

# 冒烟
node core/dist/main.js --services ./services --data .data
#  - GET /health 可接，返回 ok + 服务清单
#  - 一个 hello 子进程 spawn 且握手成功
#  - POST /api/command {topic:"hello.command",...} → SSE 收到 started/executed
#  - kill hello 子进程 → Core 自动重启 → 事件恢复（服务热插拔验证）
```

`pnpm install` 干净 + CI 化（若仓库已有 CI 配置则接入，否则跳过）。

---

## 6. 风险与决策

| 主题 | 决策 / 规避 |
|---|---|
| Windows spawn | 服务 entry 直接 `node <dist绝对路径>`，**不走 shell**（避免 cmd shim 差异）；`kill` 用 `taskkill /pid /T` 或 child.kill 兼容层 |
| stdio 分帧 | 协议只走 stdout/stderr 分离——协议流 stdout、日志 stderr；SDK 与 Core 同一规范但**实现独立**（防耦合） |
| 通配符语义 | 已定案：`*` 单段 / `**` 多段 / 裸 `*` 全量。若日后发现与 Cordis 语义冲突，只增 `#` 等新符号，不改现有行为 |
| 持久化 | SQLite 延后是显式决策；Bus 落库失败在 P1a 用 NullAdapter 吞掉，写清 `TODO(P8)`，不留静默数据丢失 |
| 事件一致性校验 | manifest 的 publishes/subscribes 必须命中 EventMap，命中失败 = 拒启动（fail fast），避免跑出协议外 topic |
| 并发超时 | 握手 / 心跳 / 优雅停止三处超时参数都从 manifest 或 config 读，写测试时注入 fake timers |
| 恶意/畸形帧 | 非法 `Content-Length` → **关该服务 stdio 连接 + 标记 failed + 触发重启**（对齐 LSP：坏头后流不可信，不重对齐；坏帧本来就是异常信号，重启是合理的强反应）（补强 ①） |
| **本机 HTTP CSRF** | `/events` + 全部 `/api/*` 加 **Origin 白名单**：放行 `127.0.0.1:1420` / `localhost:1420` / **不带 `Origin` 头**（非浏览器）/ **`Origin: null`**（file://），其余 → 403——任意网页无法 `fetch` 打本机 API（P4 `/api/credentials` 在 P1a 就已被覆盖） |
| TCP 静默断开 | SSE 侧 90s 无有效写 → 主动断开僵尸连接，由客户端 EventSource 自动重连兜底（补强 ②） |

---

## 7. 开工顺序

```
WS-1 ─► WS-2 ─► WS-3 ─► WS-4 ─► WS-5 ─► WS-6 ─► WS-7
        │        ▲        │
        └──可并行──────┘
```

- WS-2/3/4 是三个相对独立的模块，搞定 shared 契约后**可串行推进、各自带测**（符合「每步绿灯」）。
- WS-5 依赖 WS-3 的 framing 规范；WS-6 依赖 WS-3+WS-4 才端到端。
- 每个 WS 单独 commit，回合一个 PR；WS-7 时整个 P1a PR 合并。

---

## 附录 A · 两处小补强（2026-09-23 评估定案）

| # | 落点 | 补强 | 价值 |
|---|---|---|---|
| ① | `jsonrpc/framing.ts` | 非法 `Content-Length` → **关该服务 stdio 连接 + 打日志 + Core 标记 `failed` 触发重启**（LSP 一致策略；放弃「重对齐」——消息体内 `Content-Length:` 字符串会误判） | 坏头不会让 Core 崩、也不会静默吃垃圾；一次坏帧重启一次服务是可接受的强反应 |
| ② | `sse-bridge/sse.ts` | 90s 无有效写 → 主动断开僵尸连接 | TCP 静默断开（半开）时，客户端立刻拿到 EOF 触发 EventSource 自动重连，而不是黑洞挂死 |

> 两者均已同步进 WS-3 / WS-4 任务、§4 测试矩阵与 §6 风险表。P1a 总体判断：**保持，足够作为基座**。