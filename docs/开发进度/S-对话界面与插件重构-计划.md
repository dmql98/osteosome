# 开发计划 · 对话界面重构 + 减法 + 插件聚合

> 制定：2026-10-02 ｜ 状态：**S0～S8 全部完成**（含 S7-7 归属订正）｜ 依据：`docs/对话界面架构.html`（本轮讨论定案）+ 仓库现状实测
> 口径：每个 S 一步一个 commit + 全绿 + 可单独 revert；绿灯 = `pnpm -r run typecheck` 零错 + `pnpm -r test` 全绿
> **执行顺序与编号不同**：`S7-1 → S7-2a → S7-5 → S7-2b → S7-3 → S7-4 → S7-6`。S7 由 6 子步重排为 8，
> 原因是「先切启动语义、后写清单」会 bricking app（B 语义下没有清单 = 零服务 = 应用不可用）。
> 详见 `docs/开发计划.html` 的「S7 收口」。

---

## 0. 起点（实测）→ 现在（实测）

| 项 | 起点 | 现在 |
|---|---|---|
| 分支 / HEAD | `P2-llm` / `ec03717`（P4 收尾已推） | `P2-llm` / S8 收尾中 |
| **未提交** | **P7 WS-1 最小工具循环**（24 文件） | 无（工作区干净） |
| 服务数 | **10**：`hello` `session` `loop` `llm` `llm-provider-{openai,openrouter,deepseek,anthropic}` `credentials` `llm-retry` | **6**：`credentials` `llm-provider-openai` `llm-retry` `llm` `loop` `session` |
| 组件数 | 10（`widget.llm-chat` = 消息区 + 输入框**焊在一起**） | **11**（`widget.llm-chat` 已拆成 `chat-timeline` + `chat-composer`；新增 `widget.llm-settings`） |
| provider | 4 个进程（openai / openrouter / deepseek / anthropic） | **1 个进程**承载 12 家厂商预设（加厂商 = 加一行数据） |
| 插件清单 | 前端 `registry.ts` 里 6 条硬编码 | **唯一真源** = `plugins/*/plugin.json`（5 个插件），经 `GET /api/plugins` 下发 |
| 已知缺陷 ① 思考流泄漏进正文 | 有 | **已修**（S4，正文与思维链分流，`Message.reasoning` 单独落库） |
| 已知缺陷 ② 插件表硬编码在前端 | 有 | **已修**（S7-3，硬编码表删除，双向对账测试守住） |
| 已知缺陷 ③ `setEnabled` 不真停服务 | 有 | **已修**（S7-4，真发 `plugin.stop`，且重启后仍保持） |
| 已知缺陷 ④ `hello` 是纯演示 | 有 | **已删**（S2） |

**规模实测**（S8 量，S8 收尾时）：

| 项 | 值 |
|---|---|
| 包 | 10 个（`shared` / `core` / `client` / `sdk` + 6 个服务） |
| 源码 + 测试 | 27,279 行 / 246 文件 |
| 其中测试 | 76 文件 / 11,359 行 —— **测试/源码行数比 ≈ 69%** |
| 不含测试的源码 | 172 文件 / 16,375 行 |

最大的三个包：`client` 9,435 行、`core` 8,895 行、`shared` 1,942 行。

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
| S7-1 | `PluginManifest` zod schema + `plugin.start/stop` 命令 + `plugin.state.changed` 事件 | `shared/src/{plugin-manifest,events}.ts`；`core/src/config/config.ts` |
| S7-2a | **只读**：Core 扫 `plugins/<id>/plugin.json` → 校验 → **先跑环检测** → 拓扑 → 状态聚合 → `GET /api/plugins`。**启动行为完全不变** | `core/src/service-manager/{plugin-registry,plugin-registry-runtime}.ts` |
| S7-5 | 落 **5 个真实 `plugin.json`**，把 **6 服务 + 11 组件**归组 | `plugins/*/plugin.json` |
| S7-2b | **切启动语义**：只启已安装插件声明的服务 + 三态降级 + `plugin.start/stop` 展开成服务启停 | `service-manager/manager.ts`（可选参数）；`main.ts`（唯一降级判断点） |
| S7-3 | 前端插件清单**改从 Core 拉**，删掉 `client/src/plugins/registry.ts` 的硬编码 `PLUGINS` | `plugins/registry.ts`（只留纯函数）+ 新增 `core-sdk/usePlugins.ts` |
| S7-4 | **`setEnabled` / `uninstall` 真的停服务** | `stores/plugin.store.ts` → 发 `plugin.stop/start` |
| S7-6 | 详情窗显示「N/M 就绪 · 逐服务状态 · degraded 明细」 | `plugins/PluginDetailWindow.vue` |
| **S7-7** | **归属订正**（用户提问触发，不在原计划）：LLM 配置从 `settings` 拆成 `widget.llm-settings`，归 `models` 插件 | 新增 `widgets/llm-settings/`；`plugins/models/plugin.json` |

- **验收**（全部已实证，不是「应该可以」）：
  - 装 `chat-workbench` → 3 个进程起来 + 3 个组件出现在面板；卸掉 → 全消失
  - 缺必需依赖（没装 provider）→ 插件状态 `degraded` + 显示缺哪个依赖，**进程照常起**（`session` 独立可用）
  - 停插件前先发 `loop.cancel` 正常收尾，超时才强杀
  - `plugin.stop models` → **只有** `llm-provider-openai` 变 stopped，另外 5 个照旧 ready
  - 重启后停用**保持得住**（`enabled:{models:false}` → 启动时不启）
  - `plugins/` 目录不存在 → 告警 + **退回全启**，`core: started` 照常出现
- **测试影响**：`client/tests/widgets/registry.test.ts` 的对账断言，数据源从静态 `PLUGINS` 换成**真实 `plugins/*/plugin.json`**，并补了**反向**对账（不许有孤儿组件）。这条测试已反证有效：临时从清单摘掉一个组件，立刻报「孤儿组件」

---

### S8 · 收尾（0.5 天）

- [x] `pnpm -r run build / typecheck / test` 退出码全 0 + `node scripts/smoke.mjs` PASS
- [x] **逐项核对「有没有第二个真源」**（不凭印象写「已收敛」）：
  - 插件清单：唯一真源 = `plugins/*/plugin.json`。前端 `PLUGINS` 常量已删，全仓零 `plugin.<旧 id>` 残留
  - 服务归属：**6 个服务全部被认领**，无遗漏 —— 这是 B 语义最直接的翻车方式（漏认领 → 切语义后静默不启动）
  - 组件归属：**11 个实现 ↔ 11 个声明，双向对齐**，无孤儿、无「声明了但没实现」
  - ⚠️ `preferences.plugins.enabled` 与 `uninstalled` **故意保持两个集合**（停用 = 暂时不要，卸载 = 不要了）
- [x] 更新本文件：状态、起点→现在对照、规模实测、S7 子步表改成实际形态、风险表逐条结算
- [ ] 更新 `docs/对话界面架构.html`：状态胶囊 / 目标 / 系统图 / **归属表逐条对账**
      （已知过时：它写「6 个插件」，实际是 **5 个插件 / 6 服务 / 11 组件**；
      且它把 LLM 配置归在 `settings` 下，而那属于 `models` 插件 —— 见 S7-7）
- [ ] 更新 `docs/开发进度/阶段追踪.md`：P7 WS-1/WS-2 状态、P8 前置项

---

## 3. 依赖关系（实际执行顺序）

```
S0 ─► S1 ─► S2 ─► S3          （减法线：provider 收敛，进程 10 → 6）
     └► S4 ─► S5 ─► S6        （界面线：修缺陷 → 拆组件 → 布局预设）
                          └──► S7-1 ─► S7-2a ─► S7-5 ─► S7-2b ─► S7-3 ─► S7-4 ─► S7-6 ─► S8
```

两条线（S1-S3 与 S4-S6）**可并行**，S7 依赖 S6（插件要声明组件归属）。

**S7 内部按依赖重排过一次**（原计划 6 子步 → 实际 8 子步）。理由：
选了 B 语义（只启已安装插件声明的服务）之后，「先切启动语义、后写清单」会
**bricking app** —— 没有清单 = 已安装集合为空 = 零服务 spawn = 界面全空。
所以切成「只读(2a) → 落清单(5) → 切语义(2b)」。

> 这条是本轮最值得记的排期教训：**压平子步会丢掉子步之间的依赖顺序**。
> 拆子步时先问「这几步之间有没有『必须先做』的关系」，有就别压。

---

## 4. 工期（计划 vs 实际步数）

| 步 | 计划量 | 计划累计 | 实际子步 |
|---|---|---|---|
| S0 | 0.5 h | 0.5 h | 1 |
| S1 | 1.5 天 | 2 天 | 1 |
| S2 | 0.5 天 | 2.5 天 | 1 |
| S3 | 0.5 天 | 3 天 | 1 |
| S4 | 0.5 天 | 3.5 天 | 1 |
| S5 | 1.5 天 | 5 天 | 1 |
| S6 | 0.5 天 | 5.5 天 | 1 |
| S7 | 2 天 | 7.5 天 | **8**（+ S7-7 订正） |
| S8 | 0.5 天 | **8 天** | 1 |

**前 2 天（S0~S2）就有可见收益**：进程数 10 → 6、启动变快、provider 一个不少。
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

## 6. 已识别的风险 —— 逐条结算

预测有没有兑现，比「有没有出事」更有信息量。所以这一节记的不只是结果，还有
**当时的预测哪里准、哪里偏**。

| 风险 | 当时的处置 | 实际 |
|---|---|---|
| S1 改多实例时碰 `BASE_URL` 模块常量 | `req.baseURL` 已支持，只需装配层按实例传入；单测用假 fetch 断言 URL | ✅ **预测准**。没成为阻塞 |
| S2 删包后 3 个集成测试的「9 服务」断言红 | 同一 commit 内改断言 | ⚠️ **比预想的轻**。真正变红的是「默认工作台开不出来」—— 删掉的组件里有 3 个还在默认布局里，必须给它们找新归属 |
| S5 拆组件后旧 `widget.llm-chat` 残留引用 | P4 WS-1 那条断言会抓到 | ✅ **预测准，而且那条断言真的救了场**。S7-3 又给它补了**反向**对账（不许有孤儿组件），S7-7 反证有效 |
| S7 停插件时进程正在跑工具 | 停前发 `loop.cancel` 走正常收尾 | ✅ **预测准**。但真做时发现更麻烦：停用有**两个生效点**（运行期命令 + 启动路径），只做一头会「重启后自己回来」 |
| S7 前端改拉清单后离线打不开 | 拉取失败时回退到**内置最小清单** | ❌ **这条预测是错的，而且方案本身有害**。回退到内置清单 = 恢复第二真源。改成：拉不到就保持空清单 + 界面显示「未连接」，**不假装有插件** |

### 事后补记：本轮真正咬人的三条（都没在原风险表里）

| 风险 | 为什么没料到 | 怎么发现的 |
|---|---|---|
| **B 语义下「没有清单」= 零服务 = 应用不可用** | 只想着「插件层不可用要降级」，没意识到 B 语义把「无插件」变成了**默认态**而非边缘情况 | 推演 B 语义的时候，发现「仓库里还没有 `plugins/`」那一刻 |
| **停用只做运行期，重启失效** | 两处生效点分散在「命令通路」与「启动路径」两个地方，写的时候各自都自洽 | 单测全绿、冒烟 PASS，**只有重启才现形** |
| **独立窗口拿不到偏好** | 以为主窗口已经拉过偏好，独立窗口会共享 | S7-6 顺手查 `bootstrap()` 调用点时 |

> 这三条的共同形状：**都是「局部自洽、全局出错」**。
> 单测与冒烟都覆盖不到，因为它们测的都是局部。
> 所以「全绿」不等于「对」—— 必须问一句「**有没有哪条路径没人测过**」。

## 7. 留给下一轮的三件事

1. **共享服务引用计数** —— 当前 6 个服务被 5 个插件独占，所以「停 A 会不会停掉 B 需要的服务」这问题还不存在。写成「**已知前提**」而不是「已处理」；出现服务重叠时必须改成引用计数
2. **`autoStart:false` 的分支未被真实清单覆盖** —— 5 个插件都是 `autoStart: true`，只有夹具能测到那条规则。已在测试注释里写明，而不是假装它被覆盖了
3. **插件层关掉时无法按插件启停** —— `--plugins none` 下 `allowedServiceIds()` 返回 `undefined`（不限制），此时 `plugin.start/stop` 找不到插件。这是**测试专用模式**，但值得记下来，别以为它在生产路径上也能用
