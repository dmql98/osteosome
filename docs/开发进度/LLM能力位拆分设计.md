# LLM 能力位拆分设计 · 六个插件 · 超越 dsh 的插件化

> 状态：定案 ｜ 作者：dmql ｜ 日期：2026-09-28
> 关联：`ost-capability-design.md`（能力层抽象）、`ost-开发文档.md`（架构 RFC v3 §16 dsh 对标）、`P2-详细计划.md`（落地计划）
> 定位：**本文是 LLM 域的「能力位」拆分定案**——不照抄 dsh 的包内三角，而是按 OST 自己的能力层思想拆成独立服务插件；dsh 只作参照系，目标是在「存在性由插件决定」上超越它。

---

## 1. 为什么不是「dsh 的包内三角」

dsh 的 LLM 组拆了 **9 个 npm 包**（`packages/llm/`）：

| # | dsh 包 | 职责 |
|---|---|---|
| 1 | `llm` | 核心：适配器注册 + 流式调用 + 中立词表（`ctx.llm`） |
| 2 | `llm-deepseek` | DeepSeek 专用协议/配置/能力元数据 |
| 3 | `llm-deepseek-api-key` | API key 鉴权与发现 |
| 4 | `llm-deepseek-account` | 账号 token 鉴权（OAuth 旁路） |
| 5 | `llm-pi-ai` | pi-ai 多 provider 路由（含 openai/anthropic/...） |
| 6 | `deepseek-llm-api-extensions` | 请求扩展字段（生命周期元数据） |
| 7 | `plugin-package-inventory-deepseek` | 插件清单贡献到请求 |
| 8 | `llm-retry` | 重试执行器（durable 边界重跑） |
| 9 | `token-meter` | 记账/上下文压力测算 |

剥掉 DeepSeek 专属的 2/3/4/7，dsh 的**通用 LLM 骨架 = 5 个**：`llm` 核心 + provider 路由 + retry + token-meter + 请求定制。

**但 dsh 的拆分是「进程内 Cordis 插件的 npm 包拆分」**——所有包装进同一个进程，`ctx.llm` 是单例服务，卸载一个 provider 包只是少一个注册项，运行时照样活着。

**OST 的拆分是「能力位 = 独立服务进程」**——这是 `ost-capability-design.md` §1 的核心主张：**没装插件，功能不存在，不是可选**。LLM 在 OST 里不是「一个服务内部有几个 npm 包」，而是「几个能力位，每个位由插件决定存不存在」：

- 装 `llm` 主服务 → 系统有「LLM 对话」这件事（`llm.request` 命令 + 流式事件存在）；
- 不装任何 provider → `llm.request` 会失败（`unsupported_provider`），**而不是没有这个命令**；
- 装 `llm-provider-deepseek` → `provider: 'deepseek'` 可用；卸掉 → deepseek **不存在**；
- 换 `llm-provider-openrouter` → openrouter 可用；切换插件 = 切换能力实现（对齐附件 A/B/C 的例子）。

**超越 dsh 的点**：dsh 的 provider 是「同进程注册项」，卸载是「少一个选项」；OST 的 provider 是「独立进程能力位」，卸载是「这个能力从系统里消失」。前者是配置差异，后者是存在性差异。

---

## 2. 定案：LLM 能力位 = 6 个插件

| # | 插件（服务进程） | 能力位 | 职责 | 阶段 |
|---|---|---|---|---|
| 1 | `services/llm` | `capability.llm` | 能力主位：收 `llm.request` → 查 provider 路由 → 转发 `llm.provider.request` → 收 chunk 事件 → 翻译对外事件（`llm.token.streamed` 等）；`llm.cancel` 转发 | P2 |
| 2 | `services/llm-provider-deepseek` | `capability.llm.provider.deepseek` | deepseek-chat 适配器服务：注册能力 + 凭证引用 + retry 声明 + 流式 chunk | P2 |
| 3 | `services/llm-provider-openrouter` | `capability.llm.provider.openrouter` | openrouter（openai 兼容）适配器服务 | P2 |
| 4 | `services/llm-provider-opencode` | `capability.llm.provider.opencode` | opencode serve HTTP 适配器服务（本地 agent 引擎） | P2 |
| 5 | `services/credentials` | `capability.credentials` | 凭证能力位：`credentials.resolve` 命令 → `credentials.resolved` 事件（env 引用 v1，core store P4） | P2 |
| 6 | `services/llm-retry` | `capability.llm.retry` | retry 声明消费 + 执行器（P2 先声明与记账，P4 补真重试）+ token 用量记账 | P2 声明 / P4 执行 |

> **为什么不把 credentials 放 core 里**：P4 旧计划把凭证 seam 放 `core/src/credentials/`，但按能力位思想，凭证是独立能力——`capability.credentials`，装没装插件决定「凭证这个东西存不存在」。Core 保持极薄（进程管理 + 总线 + SSE 桥），凭证作为独立服务进程，天然可热插拔、可被其它服务复用（不只是 llm）。
>
> **为什么不把 retry 放 llm 里**：dsh 的 `llm-retry` 是独立插件，因为重试在 durable 边界执行，不属于「一次模型调用」的职责。OST 同理：`llm` 主位只管「发请求 → 收流」，重试与记账是旁路能力位。

---

## 3. 运行时拓扑

```text
                      ┌────────────────────────────┐
                      │           Core             │
                      │   Bus · ServiceManager ·   │
                      │   SseBridge（/api/command） │
                      └──────┬─────────┬───────────┘
                             │         │
        ┌────────────────────┘         └────────────────────┐
        ▼                                                    ▼
┌───────────────┐  订阅 llm.request            订阅 llm.provider.request
│   services/   │───────────────────────┐     ┌──────────────────────────────┐
│      llm      │                       │     │  llm-provider-deepseek       │
│  capability.llm│  ┌───────────────┐   │     │  llm-provider-openrouter     │
└───────────────┘  │   llm-retry    │   │     │  llm-provider-opencode       │
                   │（旁路订阅 llm.*）│   │     │  （各 provider 服务）         │
                   └───────┬───────┘   │     └──────────────┬───────────────┘
                           │           │                    │
                           │           │  credentials.resolve/resolved
                           │           └────────────────────┼──────────────┐
                           ▼                                ▼              ▼
                  ┌─────────────────┐              ┌────────────────────┐
                  │   credentials   │              │  llm-retry          │
                  │  capability.    │              │  capability.        │
                  │  credentials    │              │  llm.retry          │
                  └─────────────────┘              └────────────────────┘
```

**一次 `llm.request` 的完整走线**：

1. 前端 `POST /api/command` → `llm.request { requestId, provider, model, messages }`；
2. `services/llm` 收命令 → 发 `llm.request.started` → **查 provider 路由表**（哪些 provider 服务注册过）：
   - provider 没注册 → `llm.request.failed { error.code: 'unsupported_provider' }`；
   - 注册了 → 发命令 `llm.provider.request { requestId, provider, model, messages, credentialRef }`（凭证引用由 provider 声明，主位透传）；
3. `services/llm-provider-*` 收命令 → 先发 `credentials.resolve { ref, requestId }` 要 apiKey → 收到 `credentials.resolved` → 调上游 → 逐块发 `llm.provider.chunk { requestId, chunk: StreamChunk }`；
4. `services/llm` 收 chunk 事件 → 翻译对外事件：
   - `{ kind: 'delta', blockType: 'text' }` → `llm.token.streamed`；
   - `{ kind: 'finish' }` → `llm.request.finished { finishReason, usage }`；
   - `{ kind: 'finish', error }` → `llm.request.failed`；
   - `reasoning` / `tool_call` 块 → 识别降级（不渲染，不报错）；
5. `services/llm-retry` 旁路订阅 `llm.request.failed` + `llm.request.finished` → 记 usage / 按 provider 的 retry 声明决定是否重发 `llm.request`（P4 执行器）；
6. `services/credentials` 独立服务：收 `credentials.resolve` → 解析 `env:<VAR>` / `core:<id>` → 发 `credentials.resolved { requestId, apiKey }`（**值只走服务间总线，永不进 SSE/前端**）。

**取消链路**：`llm.cancel { requestId }` → `services/llm` 转发 `llm.provider.cancel { requestId }` → provider abort → `finish{ finishReason:'stop' }` 提前结束（成功取消不留痕，不发 failed）。

---

## 4. 服务清单与 manifest 契约

### 4.1 `services/llm`（能力主位）

```json
{
  "id": "llm",
  "entry": "node dist/index.js",
  "publishes": ["llm.request.started", "llm.token.streamed", "llm.request.finished", "llm.request.failed"],
  "subscribes": ["llm.request", "llm.cancel", "llm.provider.registered", "llm.provider.chunk", "llm.provider.unregistered"]
}
```

- 进程内维护 provider 路由表：收 `llm.provider.registered { provider, defaultModel }` → 加表；`llm.provider.unregistered` → 删表。
- 不 import 任何 provider 实现——**provider 是什么，由装了什么服务决定**。

### 4.2 `services/llm-provider-*`（provider 能力位，三个）

```json
{
  "id": "llm-provider-deepseek",
  "publishes": ["llm.provider.registered", "llm.provider.chunk", "llm.provider.unregistered"],
  "subscribes": ["llm.provider.request", "llm.provider.cancel", "credentials.resolved"]
}
```

每个 provider 服务自带三样声明（对齐 P2 接缝三角，但**声明在 manifest/进程边界**而非代码内 import）：

- `credentialRef`（如 `env:DEEPSEEK_API_KEY`）——随 `llm.provider.registered` 发布；
- `retryPolicy`（`maxAttempts` / `baseDelayMs` / `backoff` / `retryableCodes`）——同样注册发布；
- `defaultModel`（如 `deepseek-chat`）——注册发布，供 P4 模型目录用。

### 4.3 `services/credentials`（凭证能力位）

```json
{
  "id": "credentials",
  "publishes": ["credentials.resolved"],
  "subscribes": ["credentials.resolve"]
}
```

- v1 只认 `env:<VAR>`（如 `env:DEEPSEEK_API_KEY`）→ `process.env[...]`；解析失败 → `credentials.resolved { error: { code: 'missing_credential' } }`，**不裸奔默认 key**；
- `core:<credentialId>` 预留（P4 接凭证 store）。

### 4.4 `services/llm-retry`（重试 + 记账能力位）

```json
{
  "id": "llm-retry",
  "publishes": ["llm.metrics.usage"],
  "subscribes": ["llm.request.failed", "llm.request.finished", "llm.provider.registered"]
}
```

- P2：只消费 `llm.provider.registered` 收 retry 声明 + 消费 finished/failed 记 usage（`llm.metrics.usage { requestId, provider, usage }`）；
- P4：读声明执行真重试（backoff + jitter + `retryableCodes`），重发 `llm.request`。

### 4.5 前端配套

| Widget | 能力位依赖 | 职责 |
|---|---|---|
| `widget.llm-chat` | `capability.llm` | 发问 → `llm.request`；SSE 收 `llm.token.streamed` 累积；`llm.request.finished` 收起 Spinner；`llm.request.failed` 错误占位；in-flight 停止按钮 → `llm.cancel` |
| `widget.llm-providers` | `capability.llm` + `llm.provider.registered` | provider 状态列表（谁注册了 / defaultModel / credentialRef 是否有值 / retry 声明），P4 扩展为管理 Pane |

> 前端只依赖 `capability.llm` 的事件/命令契约，**不知道 provider 内部**——provider 是什么、有几个，由服务端能力位决定，前端订阅 `llm.provider.*` 事件被动感知。

#### 4.5.1 服务 ↔ 前端组件对照表（6 服务）

| 服务（能力位） | 对应前端组件 | 说明 |
|---|---|---|
| `services/llm`（能力主位） | `widget.llm-chat` | 前端与 LLM 对话交互的唯一直连面：`llm.request` / `llm.cancel` / 流式事件 |
| `services/llm-provider-deepseek` | `widget.llm-providers`（状态行） | 前端**不直连** provider，只经 `llm.provider.registered/unregistered` 被动感知存在与 defaultModel |
| `services/llm-provider-openrouter` | `widget.llm-providers`（状态行） | 同上 |
| `services/llm-provider-opencode` | `widget.llm-providers`（状态行） | 同上 |
| `services/credentials` | **无组件** | 凭证能力位对前端**不可见**——`credentials.resolve/resolved` 只在服务间总线传播，值永不进 SSE/前端；P4 凭证管理走 `llm-providers` 扩展的 Pane（绑定/掩码展示），不新建独立组件 |
| `services/llm-retry` | **无组件** | retry 是服务端旁路行为（声明消费 + usage 记账），前端无感知；P4 重试参数经 `llm-settings` Pane 配置，不新建独立组件 |

> **原则**：前端组件 = 「能力」的呈现，不是「服务」的镜像。6 个服务按能力位语义映射为 **2 个 Widget**——`llm-chat`（LLM 对话交互）+ `llm-providers`（provider 存在性/状态）；旁路服务（credentials / llm-retry）刻意无独立组件，避免把服务内部结构泄漏到 UI（对齐「凭证值永不进前端」与「retry 服务端行为」两项不变式）。

---

## 5. 事件与命令契约（只增不改）

在 `shared/src/events.ts` 追加（全部为新增 topic，不修改既有）：

**命令 topic**（`CommandMap`）：

| Topic | 语义 | Payload |
|---|---|---|
| `llm.request` | 发起流式对话（已有） | `{ requestId, provider, model?, messages, temperature?, meta? }` |
| `llm.cancel` | 取消在途请求（已有） | `{ requestId }` |
| `llm.provider.request` | 主位 → provider：发起流 | `{ requestId, provider, model, messages, temperature?, credentialRef, retryPolicy, signal? }` |
| `llm.provider.cancel` | 主位 → provider：取消 | `{ requestId }` |
| `credentials.resolve` | provider → credentials：解析凭证 | `{ requestId, ref }` |

**事件 topic**（`EventMap`）：

| Topic | 语义 | Payload |
|---|---|---|
| `llm.request.started` | 已开始（已有） | `{ requestId, provider, model }` |
| `llm.token.streamed` | 文本 delta（已有） | `{ requestId, token, index }` |
| `llm.request.finished` | 正常结束 / 取消（已有） | `{ requestId, finishReason, usage? }` |
| `llm.request.failed` | 硬错误（已有） | `{ requestId, error: { code, message } }` |
| `llm.provider.registered` | provider 服务就绪并注册能力 | `{ provider, defaultModel, credentialRef, retryPolicy }` |
| `llm.provider.chunk` | provider → 主位：流式块 | `{ requestId, chunk: StreamChunk }` |
| `llm.provider.unregistered` | provider 服务退出/重启中 | `{ provider }` |
| `credentials.resolved` | credentials → provider：解析结果 | `{ requestId, apiKey? , error? }` |
| `llm.metrics.usage` | llm-retry 记账输出 | `{ requestId, provider, usage }` |

`StreamChunk` / `readSseJson` / `ChatMessage` 等中立协议从 `services/llm/src/` 上移到 `shared/src/llm/`（唯一真相源），provider 服务直接依赖 `@osteosome/shared` 消费。

---

## 6. 与旧计划的差异

| 维度 | 旧 P2（2026-09-23 定案） | 新定案（2026-09-28） |
|---|---|---|
| provider 组织 | `services/llm` 包内 `adapter/deepseek.ts` 单实现 | 独立服务进程 `services/llm-provider-*` |
| 接缝三角归属 | `services/llm/src/adapter/` | `shared/src/llm/`（协议）+ 各 provider 服务（实现） |
| 凭证 | `services/llm/src/credentials/resolver.ts`（进程内 env） | 独立服务 `services/credentials`（总线 resolve/resolved） |
| retry | `services/llm/src/retry/policy.ts`（声明不执行） | 独立服务 `services/llm-retry`（P2 声明+记账 / P4 执行） |
| 前端 | `features/chat/chat-pane.vue` 单 Pane | `widget.llm-chat` + `widget.llm-providers` 两个 Widget |
| provider 数量 | deepseek 唯一 | deepseek / openrouter / opencode 三个 |
| 卸载语义 | 删代码 | 卸服务进程 → 能力从系统消失（`unsupported_provider`） |

**P4 的再分配**：旧 P4 的「三 provider + 凭证 seam + retry 执行器 + 设置 Pane」大部分被 P2 提前实现（凭证/retry 服务化、三 provider、opencode）。P4 只剩：凭证 store（`core:<id>` kind 落 `dataDir/credentials.json`，值永不进总线）、retry 执行器实装、模型目录 `listModels()`、设置 Pane 套件、i18n/主题。

---

## 7. 风险与决策

| 主题 | 决策 / 规避 |
|---|---|
| **服务进程数量膨胀** | 每 provider 一个进程，开销是 Node 进程启动成本；P2 三个 provider + 主位 + 凭证 + retry = 6 进程，可接受；P4 若 provider 增多，可引入「provider 容器进程」（多 provider 共享一个进程，仍保持能力位语义） |
| **chunk 事件走总线带宽** | token 逐条发布 OK（RFC 既有契约）；若 P4 吞吐瓶颈，再以 `llm.block.*` 增量降频（只增不改） |
| **凭证值进总线** | `credentials.resolved` 的 apiKey **只在服务间总线传播，永不进 SSE/前端**；前端永远见不到凭证值；P4 落 core store 后值甚至不出 credentials 服务 |
| **opencode 是 agent 不是纯 LLM** | `llm-provider-opencode` 走 `opencode serve` HTTP（`/session/message` SSE）；它产出的不是 token 而是 agent 消息块——适配器把它翻译成 `StreamChunk`（text delta / finish），对主位透明 |
| **retry 空转** | retry 在 P2 只声明 + 记账，不执行——避免半吊子重试造成重复请求；执行器 P4 与凭证 store 一并装备 |
| **崩溃恢复** | 重试交给 Core 进程管理（P1a）：kill provider → 拉起 → `llm.provider.registered` 重新注册；请求级重试 P4 再做 |

---

## 8. 落地顺序（对应 P2-详细计划 WS）

```text
WS-1 shared: llm 协议上移 + 事件/命令契约追加
WS-2 service-sdk: credentials 客户端（resolve → resolved Promise 封装）
WS-3 services/credentials: 凭证能力位
WS-4 services/llm: 主位重写（路由表 + 翻译 + cancel 转发）
WS-5 services/llm-provider-deepseek + openrouter: openai 兼容 provider
WS-6 services/llm-provider-opencode: opencode serve 适配器
WS-7 services/llm-retry: 声明消费 + 记账
WS-8 client: chat-widget + providers-widget
WS-9 收尾: 文档勾选 + 绿灯全集复跑
```
