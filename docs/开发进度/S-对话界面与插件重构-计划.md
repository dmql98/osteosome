# 开发计划 · 对话界面重构 + 减法 + 插件聚合

> 制定：2026-10-02 ｜ 状态：**待开工** ｜ 依据：`docs/对话界面架构.html`（本轮讨论定案）+ 仓库现状实测
> 口径：每个 S 一步一个 commit + 全绿 + 可单独 revert；绿灯 = `pnpm -r run typecheck` 零错 + `pnpm -r run test` 全绿

---

## 0. 起点（实测）

| 项 | 值 |
|---|---|
| 分支 / HEAD | `P2-llm` / `ec03717`（P4 收尾已推） |
| **未提交** | **P7 WS-1 最小工具循环**（24 文件，已 typecheck 零错 + 全绿）← S0 先落袋 |
| 服务数 | **10**：`hello` `session` `loop` `llm` `llm-provider-{openai,openrouter,deepseek,anthropic}` `credentials` `llm-retry` |
| 组件数 | 10（其中 `widget.llm-chat` = 消息区 + 输入框**焊在一起**） |
| 已知缺陷 | ① 思考流泄漏进正文 ② 插件表硬编码在前端 ③ `setEnabled` 不真停服务 ④ `hello` 是纯演示 |

## 1. 目标（定案，不再讨论）

| 维度 | 目标 |
|---|---|
| 界面 | 3 个组件：`session-list` / `chat-timeline` / `chat-composer`，默认预设拼成正常 agent 对话界面 |
| 服务 | 按功能：`session` / `loop`（编排）/ `llm`（模型接入）+ 能力位；**默认进程 10 → 5** |
| provider | **一个通用 openai 兼容实现 + 厂商预设表（数据）**；加厂商 = 加一行，不加代码不加进程 |
| Core | 进程 + 总线 + 桥 + 凭证 store，**零业务知识** |
| 插件 | **聚合**：一组服务 + 一组组件 + 依赖；Core 扫 `plugins/*/plugin.json` |

**明确不做**：窄窗降级、代码语法高亮库、工具跨进程化、审批 listener、MCP 接入、上下文压缩、整体转 pi。

---

## 2. 步骤

### S0 · 落袋 P7 WS-1（0.5 小时）

- **做什么**：把未提交的最小工具循环提交（独立 commit）
- **验收**：`pnpm -r typecheck` 零错 + `pnpm -r test` 全绿（当前已达成）

---

### S1 · 通用 provider：多实例 + 厂商预设表（1.5 天）★核心

- **为什么先做**：做完才能删包，且删包前用户不掉任何 provider
- **做什么**：
  1. `shared/src/llm/vendors.ts` —— 预设表（数据）：`id / label / baseUrl / api / credentialEnv / defaultModel / models[]`，
     内置 openai、deepseek、openrouter、moonshot、siliconflow、groq、together、xai、mistral、ollama、vllm、lm-studio
  2. `llm-provider-openai` 改为**多实例**：启动时读配置（预设表 + 用户自填项），为每家 publish 一条 `llm.provider.registered`
     （各自 `baseUrl` / `credentialRef` / `defaultModel`）；请求时按 `provider` 名路由到对应 baseUrl
  3. 请求路由：`llm.provider.request` 带 `provider` → 该实例用自己 baseUrl 打上游
- **落点**：`shared/src/llm/vendors.ts`（新）、`services/llm-provider-openai/src/{index,provider}.ts`
- **验收**：
  - 单测：预设表 12 条 id 唯一、baseUrl 合法、credentialEnv 命名一致
  - 单测：同一进程内两个实例（openai + deepseek）各自打自己的 baseURL（假 fetch 断言 URL）
  - 端到端：`agent.run{provider:'deepseek'}` → 假上游收到 deepseek baseUrl 的请求
- **风险**：当前 provider 包的 `BASE_URL` 是模块级常量 → 要改成按实例传入（`req.baseURL` 已支持，改装配层即可）

---

### S2 · 减法：删 4 个服务（0.5 天）

| 删 | 理由 | 连带处理 |
|---|---|---|
| `llm-provider-deepseek` | 就是 openai 兼容 + 换 baseURL，已被 S1 的实例覆盖 | workspace / 3 个集成测试的「9 服务」断言改「5 服务」 |
| `llm-provider-openrouter` | 同上 | 同上 |
| `llm-provider-anthropic` | 定案不做；claude 走 OpenRouter | 16 组单测改写成「经 OpenRouter 调 claude 模型」的对照回归 |
| `hello` | 纯演示，零用户价值 | 删 `services/hello` + `widget.hello-command` + 命令台按钮 + plugin registry 条目 + `scripts/smoke.mjs` 与 `core/tests/e2e.test.ts` 改用 `session.create` |

- **保留**：`shared/src/events.ts` 里的 `hello.command.*` 契约（只增不改，留着当测试 fixture 词，多数测试只用到 topic 字符串）
- **验收**：进程数 5；`pnpm -r test` 全绿；手工启动 Core `/health` 只列 5 个服务
- **诚实损失**：ost 从此**只有一种 wire**。将来接 Bedrock 原生 Converse / Gemini 原生需重做（已记入 §5 决策门）

---

### S3 · 设置 Pane「新增服务商」（0.5 天）

- **做什么**：
  1. 数据源换成 `shared` 的预设表（下拉选厂商 → 自动填 baseUrl / key env 名 / 默认模型）
  2. 「自定义端点」：用户填 `label / baseUrl / credentialRef / defaultModel` → 写入配置 → S1 的 provider 运行时注册
  3. **不配置凭证 → 该 provider 不注册** → 前端下拉里就没有它；指定它发问得 `unsupported_provider`
- **验收**：设置窗新增 deepseek 后，对话窗下拉出现 deepseek 且能选中；删掉凭证后消失
- **收益**：P4 那条没勾的绿灯「新增服务商不再手改单函数」真正达成

---

### S4 · 修思考流泄漏（0.5 天）★S5 的前置

- **做什么**：
  1. `shared`：`llm.token.streamed` 加可选字段 `blockType?: 'text' | 'reasoning'`（只增不改）
  2. `services/llm`：主位按块类型标注（现在 `isDelta` 不看 `blockType`，reasoning 被当正文发）
  3. `services/loop`：`loop.token.streamed` 透传 `blockType`
- **验收**：端到端用例 —— 假上游发 reasoning 块，断言 `{blockType:'reasoning'}` 事件可见 **且** 正文里不含思维链
- **风险**：无（只加可选字段，向后兼容）

---

### S5 · 组件拆分：③② 从 `llm-chat` 拆出（1.5 天）

- **做什么**：
  1. 新增 `client/src/stores/chat.store.ts`：`activeRequestId` / `sending` / in-flight 行 / `model` / `thinking` / 工具块状态
  2. `widget.chat-timeline`（②）：消息气泡、**折叠思考块**、**工具卡**、错误内联、流式尾光标、Markdown `<pre>`
  3. `widget.chat-composer`（③）：输入框 + 发送/停止 + 模型下拉 + 思考强度下拉
  4. 删除 `widget.llm-chat`
  5. ②③ **零直接通信**，共享 `chat.store`；服务端事件都带同一 `requestId`，按它过滤不串轮
- **验收**：
  - 组件用例：②③ 各自独立挂载渲染；共用 requestId 不串轮；工具块执行中→✓/✗；错误内联不清空上文
  - ① 切会话 → ② 清空重载 → ③ 输入禁用状态正确

---

### S6 · 对话布局预设（0.5 天）

- **做什么**：`client/src/panes/default-layout.ts` 写死三盒几何（会话 `240px` / 对话 `flex × 满高−120` / 输入 `flex × 120`）；
  面板头加「重置为对话布局」接 `layout.store.resetLayout`
- **验收**：打开即是 `对话界面架构.html` §1.4 的样子；三个盒子可各自拖动；拖完能一键复位

---

### S7 · 插件 = 聚合（2 天）

| 步 | 内容 | 落点 |
|---|---|---|
| S7-1 | `PluginManifest` zod schema + `plugin.start/stop` 命令 + `plugin.state.changed` 事件 | `shared/src/{manifest,events}.ts` |
| S7-2 | Core 扫 `plugins/*/plugin.json`，按 `dependencies` 拓扑启停 + 状态聚合（`ready`/`degraded`/`stopped`）+ `GET /api/plugins` | 新增 `core/src/service-manager/plugin-manifest.ts`；`manager.ts` 增批量启停；`sse-bridge/server.ts` 增路由 |
| S7-3 | 前端插件清单**改从 Core 拉**，删掉 `client/src/plugins/registry.ts` 的硬编码 `PLUGINS` | `plugins/registry.ts`（只留 `pluginForWidget` 等纯函数）+ 新增 `core-sdk/usePlugins.ts` |
| S7-4 | **`setEnabled` 真的停服务**（现在只写 prefs，一个进程都没停） | `stores/plugin.store.ts` → 发 `plugin.stop/start` |
| S7-5 | 迁移：写 6 个 `plugin.json`，把 5 个服务 + 3 个组件归组 | `plugins/*/plugin.json` |
| S7-6 | 插件详情窗显示「N 组件 / M 服务 / 依赖 / degraded 明细」 | `PluginListWindow.vue` / `PluginDetailWindow.vue` |

- **验收**：
  - 装 `chat-workbench` → 3 个进程起来 + 3 个组件出现在面板；卸掉 → 全消失
  - 缺必需依赖（没装 provider）→ 插件状态 `degraded` + 提示「缺 provider:X」，**不启动失败**
  - 停插件前先发 `loop.cancel` 正常收尾，超时才强杀
- **测试影响**：`client/tests/widgets/registry.test.ts` 那条「插件声明的每个 widget 必须 get 得到」断言，数据源从静态 `PLUGINS` 换成 Core 清单（要加 mock）

---

### S8 · 收尾（0.5 天）

- `pnpm -r typecheck` 零错 + `pnpm -r test` 全绿
- 更新 `docs/开发进度/阶段追踪.md`：P7 WS-1/WS-2 状态、P8 前置项、新的服务/组件清单
- 更新 `docs/对话界面架构.html`：把「现状 → 目标」落账（服务 5 个、组件 3 个、provider 预设表）

---

## 3. 依赖关系

```
S0 ─► S1 ─► S2 ─► S3          （减法线：provider 收敛，进程 10→5）
     └► S4 ─► S5 ─► S6        （界面线：修缺陷 → 拆组件 → 布局预设）
                          └──► S7 ─► S8   （插件线：聚合模型）
```

两条线（S1-S3 与 S4-S6）**可并行**，S7 依赖 S6（插件要声明三组件的归属）。

## 4. 工期

| 步 | 量 | 累计 |
|---|---|---|
| S0 | 0.5 h | 0.5 h |
| S1 | 1.5 天 | 2 天 |
| S2 | 0.5 天 | 2.5 天 |
| S3 | 0.5 天 | 3 天 |
| S4 | 0.5 天 | 3.5 天 |
| S5 | 1.5 天 | 5 天 |
| S6 | 0.5 天 | 5.5 天 |
| S7 | 2 天 | 7.5 天 |
| S8 | 0.5 天 | **8 天** |

**前 2 天（S0~S2）就有可见收益**：进程数减半、启动变快、provider 一个不少。

## 5. 决策门（触发即重估，别凭感觉反复讨论）

| 触发条件 | 该做什么 |
|---|---|
| 需要上下文压缩 / fork / rewind | 评估 `@earendil-works/pi-durable` + pi 的 compaction |
| 需要多 agent 编排（一个会话 spawn 另一个） | 评估包 `pi-agent-core` 替换 `loop` 内部实现（前端/会话/参数链路全部复用） |
| 工具 > 20 且依赖 MCP 生态 | `tools` 独立成能力位 + 借 `@earendil-works/pi-mcp` |
| 需要 OAuth 登录（Copilot / Bedrock / Vertex） | 同上，走 pi-ai 的 auth 层 |
| 需要 Bedrock 原生 Converse / Gemini 原生 wire | 新增第二个 provider 实现（`api` 字段已在预设表预留） |

## 6. 已识别的风险

| 风险 | 处置 |
|---|---|
| S1 改多实例时碰 `BASE_URL` 模块常量 | `req.baseURL` 已支持，只需装配层按实例传入；单测用假 fetch 断言 URL |
| S2 删包后 3 个集成测试的「9 服务」断言红 | 同一 commit 内改断言；`startCore` 加 `services?: string[]` 白名单参数供测试显式开启 |
| S5 拆组件后旧 `widget.llm-chat` 残留引用 | P4 WS-1 那条断言会抓到（插件声明的组件必须 get 得到） |
| S7 停插件时进程正在跑工具 | 停前发 `loop.cancel` 走正常收尾，`stopGraceMs` 超时才强杀 |
| S7 前端改拉清单后离线打不开 | 拉取失败时回退到内置最小清单（只有一个 core 插件），不白屏 |
