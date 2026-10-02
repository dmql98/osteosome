# P4b · 对话工作台 — 交接与计划

> 交接日期：2026-10-01 ｜ 状态：**已执行完毕（并入 P4 收口，2026-10-02）**
> 界面 demo：[`../wireframes/demo/index.html`](../wireframes/demo/index.html) 左侧导航最下组「对话工作台（P4b）」→ J1~J4（浏览器直接打开，无构建）
> 前置阅读：[`P4-详细计划.md`](./P4-详细计划.md)、[`阶段追踪.md`](./阶段追踪.md)、[`前端工作台-现行实现.md`](../前端工作台-现行实现.md)

---

## 0.1 结论落地情况（2026-10-02 收尾后回填）

§8 的 5 项待拍板，**已按下列裁决执行**（产出见 `阶段追踪.md` P4 区块 WS-5/WS-6 与修订记录）：

| # | 待拍板项 | 裁决 |
|---|---|---|
| 1 | 组件拆分粒度（单盒子 vs 两盒子） | **保持现状两件**：`widget.session-list` + `widget.chat` 各自独立 movable box，符合「组件=最小单元」约定；两者都必须在默认面板 |
| 2 | `plugin.chat` 新增 / `plugin.workbench` 改名 | **都不做**（纯命名，无功能收益）。`widget.llm-chat` 仍归 `plugin.llm`，`plugin.workbench` 保持原名 |
| 3 | 429 重试红怎么修 | **按请求取策略**：llm-retry 从 `llm.provider.request` 记 retryPolicy，声明表退化为兜底。理由：该事件必然晚于 llm-retry 订阅（请求由前端/loop 发起），与启动顺序彻底解耦；不像 `inject` 那样把 provider 绑死在旁路服务上，也不像 Bus 回放那样改动 P1a 语义 |
| 4 | `source` vs `catalog` | **`catalog` 正确，契约改名**。真因：`EventBase.source` 是总线保留字，ServiceManager 对每条服务消息盖章 `source=serviceId`（`manager.ts:334`）——叫 `source` 的业务字段必被覆盖。**§1.3 建议回退是错的**，已在 `shared/src/events.ts` 写明勿回退 |
| 5 | P4b 与 P7 边界 | **确认**：本轮只做「对话雏形」（多轮 + provider/model/思考强度可控）；工具调用循环、`tool_call` 出 wire、`role:'tool'` 扩展三项仍为 P7 前置项 |

**§2.1 的 429 根因推断已证实**，并顺带暴露第二个同源问题：`llm-retry` 重启后声明表恒空 → usage 记账 provider 会退化成 `unknown`。按请求取策略同时修掉了这一类。

### 外部参照评估（用户 2026-10-02 提出：要不要直接用 pi）

| 项目 | 是什么 | 对 ost 的可用性 |
|---|---|---|
| [pi](https://github.com/earendil-works/pi) 官方 | agent toolkit：`pi-ai`（30+ provider 统一 API + 模型目录 + thinking 统一枚举）、`pi-agent-core`（工具循环 + 事件流）、`pi-mcp`、`pi-durable`、`chord`（≈ost core） | **只有 core 可嵌**。官方**无 web 前端**（`pi-tui` 是终端差分渲染，coding-agent 依赖 chalk） |
| [pi-gui](https://github.com/minghinmatthewlam/pi-gui) | 第三方 Electron 桌面壳，MIT，`packages/pi-sdk-driver` 是 over pi-coding-agent 的适配器 | 组件**不可 import**（React + Electron IPC，无组件包导出）。价值＝交互规格参考（timeline / composer / 每线程模型与思考强度 / tool 渲染 / fork-rewind）＋适配器层参考 |
| [Paseo](https://paseo.sh/) | agent 控制平面：把本机 40+ agent CLI（Claude Code/Codex/OpenCode/Pi…）当子进程拉起，统一 UI + worktree + 调度 + 审批 | **不是库**，是产品。可抄「agent 适配器接口 + daemon↔客户端会话协议」 |

**裁决**：不整体转 pi。引入 pi 的收益集中在 agent loop，而 ost 的 `Message` 契约（`role: system|user|assistant` + `content: string`）存不下 pi transcript 的 `toolResult` 与多 block 结构——转 pi 等于提前做 P7 前置项①并改动 P3 的 session 层与前端渲染，净额接近零。**pi 的正确位置是 P7**：届时按 P7 三前置项扩完 `Message` 契约，只替换 loop 的内部实现为 `pi-agent-core`，前端 widget / session 服务 / 参数链路全部复用。若只想白拿 pi-ai 的 provider 层（30+ 家 + 模型目录 + thinking 翻译），可在任意时刻落一个 `llm-provider-pi`（StreamChunk 翻译层），架构零破坏。

---

## 0. 一句话结论

用户期望「到 P4 能看到一个简单可用的对话 agent」，但**当前 P4 的实际交付是「多 provider 管理 + 凭证 + 设置 Pane」**，不含对话 agent 形态。差距不在「做了多少」，而在**前端组件与请求链路存在 4 处断层**——其中最关键的一条是：**UI 上能选的 provider/模型，实际链路根本收不到**。本文件把这 4 处断层钉死，给出组件归属与参数链路的落地方案，待确认后再开工。

---

## 1. 仓库真实状态（已核实）

| 项 | 值 |
|---|---|
| 分支 | `P2-llm`（P3/P4 提交都在这个分支上，**没有独立的 P3/P4 分支**） |
| HEAD | `2cc77b7` P4 WS-4 设置 Pane 套件 + 主题/i18n |
| P4 提交链 | `092d256` WS-1 → `f54ba55` WS-2 → `5f5b302`+`7190111` WS-3 → `2cc77b7` WS-4 |
| WS-5（装配+收尾） | **未完成**：`阶段追踪.md` 里 P4 仍是 🟡 进行中 |
| 工作区 | 有未提交改动（见 §1.1）+ 1 个未跟踪新文件 |

### 1.1 未提交改动（接手前先决定去留）

| 文件 | 改动内容 | 我的判断 |
|---|---|---|
| `core/tests/p4-integration.test.ts`（新增未跟踪） | P4 集成冒烟，6 用例 | 保留，是 WS-5 的验收主体 |
| `services/llm-provider-anthropic/src/index.ts` | 模块顶层 publish `llm.provider.registered` → 改为 `start()` 之后注册 | **修复，必须保留**（见 §1.2） |
| `services/llm-retry/src/index.ts` | 加了一行 `console.error` 调试日志 | 建议删掉 |
| 4 个 provider + `LlmSettings.vue` + `settings.test.ts` | 字段 `source` → `catalog` 重命名 | **建议整体回退**，见 §1.3 |

### 1.2 `service.publish` 在 `started=false` 时被丢弃

provider 必须 `await service.start()` **之后**才能 publish 注册事件，否则主位拿不到路由。anthropic 是 P4 WS-3 新写的，踩了 openai 系 P2 已修过的坑，当前工作区改动正在修它——**别回退这处**。

### 1.3 `source` → `catalog` 重命名与契约冲突（建议回退）

- 权威契约 `shared/src/events.ts:115-120` 写的是 `source: 'remote' | 'static'`；P4 计划 §WS-3 也是 `source`。
- 工作区把 4 个 provider、`LlmSettings.vue`、`settings.test.ts`、冒烟断言都改成了 `catalog`，**但契约与文档没改**。
- 全仓靠它的地方只有前端下拉那一处，typecheck 也过（publish 的 payload 类型约束较松），所以**不会编译报错，只会静默不一致**。
- 建议：**回退成 `source`**，统一到既有契约。若确实要叫 `catalog`，必须同时改 `shared` + 文档，属于独立决策，不该混在 WS-5 收尾里。

---

## 2. 验证结果（本次实跑）

```bash
pnpm -r run typecheck        # ✅ 全绿，0 error
pnpm -r run test             # ❌ core 1 failed / 106 passed
```

| 包 | 结果 |
|---|---|
| shared | 7 passed |
| sdk/ts | 54 passed |
| **client** | **128 passed / 37 文件** ✅ |
| core | 106 passed / **1 failed** ❌ |

失败用例：`core/tests/p4-integration.test.ts` → `429 → rate_limited（瞬态，llm-retry 退避重发 → 重试后成功）`
报错：`timeout waiting for llm.request.finished after retry`（耗时 17.6s 超时）

**⇒ P4 尚不能判定为「绿灯全过」，`阶段追踪.md` 保持 🟡 是对的。**

### 2.1 该失败用例的根因（**推断，未最终验证**）

抓到的现象：事件流里只有第一次请求链，**没有第二次**——`llm-retry` 从未重发。日志里我加的 `[llm-retry] registered=...` **一次都没打印**。

推断链路（置信度中高，未走完验证）：

1. Core 按拓扑序逐个 `await spawnAndHandshake`，实测启动序为 `credentials → hello → llm → anthropic → deepseek → openai → openrouter → llm-retry → loop → session`，**`llm-retry` 排在 4 个 provider 之后**。
2. provider 在自己 `start()` 后立刻 publish `llm.provider.registered`；此时 `llm-retry` 尚未 `bus.subscribe`，**而 Bus 没有「订阅即回放」**（`core/src/bus/bus.ts` 只有 enqueue→drain→deliver，订阅就是往数组里 push）。
3. ⇒ `llm-retry` 的 `declarations` 表为空 → `shouldRetry` 判定 `no_policy` → 不重试。
4. 旁证：401 用例「期望不重试」照样绿（`openaiHits===1`），所以这个洞此前没被测出来；P2 的 `llm-integration` 只断言 usage 记账（靠 `started` 事件回填 provider），**也不需要 declarations**。429 重试是第一个真正依赖声明表的用例。

候选修法（未实施，需你拍板）：给 providers 加 `inject: ['llm-retry']` 让其晚启；或让 `llm-retry` 启动后主动向 llm 主位拉一次当前路由；或给 Bus 加「注册类事件订阅即回放」。三者语义差别大，见 §6 待确认项 ③。

---

## 3. 已确认的 4 处断层（这是「组件完全不对」的真正原因）

### 断层① 会话列表**根本没被注册**，默认工作台里不存在

- `client/src/widgets/registry.ts:5` 用 `import.meta.glob('./*/*-widget.vue')` 自动发现 widget。
- `widget.session-list` 的定义文件是 `client/src/features/session/session-list-pane.vue` —— **目录不对（不在 `widgets/` 下）且文件名不以 `-widget.vue` 结尾**，glob 扫不到。
- `widget.settings` 同病：`client/src/widgets/settings/settings-pane.vue`。
- 而 `client/src/plugins/registry.ts:68,120` 明确声明了这两个 widget id 归插件 —— **插件清单说有，组件注册表里没有**，于是 `defaultWidgetIds()`（= `listWidgets()`）不含它们，默认面板开不出来。
- 单测没抓到：`client/tests/widgets/registry.test.ts` 只断言「≥6 个」和逐个点名 5 个旧组件，从不断言「每个已声明的 widget 都能被 `getWidget` 取到」。
- ⚠️ 反推的运行时后果**未在浏览器验证**（本次只做静态阅读），但按代码路径是确定的。

### 断层② 对话组件的 provider 下拉是**装饰**，选了不生效

- `LlmChatWidget.vue:169` 发的是 `loop.run`；
- `services/loop/src/index.ts:26` 是 `const PROVIDER = process.env.LLM_PROVIDER?.trim() || 'deepseek'` —— **写死常量**；
- `services/loop/src/index.ts:30` 发 `llm.request` 时**既不带 provider（除了那个常量）也不带 model**。
- ⇒ 用户在前端选哪个 provider / 哪个模型，都不影响真实请求。

### 断层③ 模型不可选

`LlmChatWidget.vue:14` 的「模型」是个 `readonly` 的 `Input`，只显示 `defaultModel`。
**已有可复用资产**：`llm.models.list → llm.models.list.result`（P4 WS-3 已落，含 remote/static 降级），`LlmSettings.vue:130-170` 已有完整的前端拉取 + 降级角标逻辑，可直接搬。

### 断层④ 思考强度完全不存在

wire 上没有这个维度：`shared/src/events.ts:161-167` 的 `llm.request` 只有 `model?` / `temperature?`；`loop.run`（`:200`）只有 `requestId/sessionId/text`。provider 侧 `StreamRequest` 也只有 `temperature`。

**顺带记一条 P7 债务**（不属本轮）：`shared/src/llm/types.ts:38-41` 的 `ChatMessage` 只有 `system/user/assistant`，没有 `role:'tool'`、没有 tools 定义 —— 这是 agent 工具循环的前置项。

---

## 4. 目标界面形态（对应你提的 7 项，demo J1~J4 已按此出图）

| 你的要求 | demo 位置 | 现状 | P4b 目标 |
|---|---|---|---|
| 会话列表 | 左栏 | 代码有、未注册 | 默认上工作台，增删改切 |
| 会话流式聊天框 | 右栏消息区 | ✅ 已有 | 保留 P3 虚拟 id 累积方案 |
| 输入框 | 右栏底部 | ✅ 已有 | 保留（Enter 发送 / Shift+Enter 换行） |
| 发送/停止按钮 | 输入框右侧 | ✅ 已有 | 保留（停止 = `loop.cancel`） |
| **模型选择** | 顶栏第 1 个下拉 | ❌ 只读 | 接 `llm.models.list`，按 provider 分组 + static 角标 |
| **思考强度** | 顶栏第 2 个下拉 | ❌ 无 | 中立枚举 → 各家 wire 翻译 |
| —（补充）provider 选择 | 顶栏 | ❌ 装饰 | 下拉真正生效，或 P4b 先隐去 |

四态已在 demo 体现：J1 有历史 / J2 空会话（发送禁用）/ J3 流式中（停止 + 输入禁用 + 尾光标 + 思考分块）/ J4 失败（错误占位 + 输入恢复）。

---

## 5. 组件清单与插件归属（**待你拍板**）

归属推导原则：**沿用既有「能力位 → 插件」约定**（`plugin.<id>` 与 `services/<id>` 对应，插件声明自己贡献的 widget）。

| # | Widget | 归属插件 | 后端依赖 | 改动量 |
|---|---|---|---|---|
| 1 | `widget.session-list` | `plugin.session`（已声明） | session | **仅注册**，~0 |
| 2 | `widget.chat` | `plugin.chat`（**新增**） | loop → llm → provider | 主体 |
| 3 | `widget.settings` | `plugin.core`（**改名**，`plugin.workbench` → `plugin.core`） | core 凭证 + 各 provider | 仅注册 + 改名 |
| 4 | `widget.llm-providers` | `plugin.llm`（已声明） | llm + providers | 不动，保留为调试视图 |

**为什么 3 要改名**：`plugin.workbench` 现在的定位是「系统信息/命令台/hello」这类骨架组件，却把 LLM 设置（provider 增删、凭证绑定、模型目录）挂在自己名下，与「对话 + 设置都归对话插件」的直觉相反。建议改名为 `plugin.core`（骨架与全局设置）。

**为什么 4 新增 `plugin.chat` 而不是并进 `plugin.llm`**：`plugin.llm` = `services/llm`（纯主位，headless）；对话 UI 真正依赖的是 `loop`（会话编排 + 多轮 + 落库）。挂到 llm 名下会让「插件」和「服务」错位。代价是新增插件需同步 `client/src/plugins/registry.ts` 与后端拓扑。

**⚠️ 未决**：② 也可并入 `plugin.llm`（不动插件表，少一处改动，但服务↔插件错位）。见 §6 待确认 ②。

---

## 6. 参数链路设计（模型 / 思考强度怎么真的走到上游）

```
前端 widget.chat
  └─ loop.run { requestId:A, sessionId, text, provider?, model?, thinking? }   ← 契约扩 ①
       └─ loop 服务（两阶段不变）→ llm.request { requestId:B, provider, messages, model?, thinking? }
            └─ llm 主位（已支持 model 透传）→ llm.provider.request
                 └─ provider：thinking → 各家 wire 翻译                                ← 契约扩 ②
```

### 扩点清单

| 扩点 | 文件 | 改动 |
|---|---|---|
| ① `loop.run` 命令 | `shared/src/events.ts:200` | 增 `provider?` / `model?` / `thinking?`（**只增不改**） |
| ① `loop` 装配 | `services/loop/src/index.ts:26,30` | 去掉硬编码常量：`provider = payload.provider \|\| env.LLM_PROVIDER \|\| 'deepseek'`；把 `model/thinking` 带进 `llm.request`（`LoopCore.start` 已预留 `model?` 形参，**接线即可**） |
| ② `llm.request` / `llm.provider.request` | `shared/src/events.ts:161-180` | 增 `thinking?: ThinkingEffort` |
| ② `llm` 主位 | `services/llm/src/index.ts:27-52,100-105` | `parseLlmRequest` 透传 `thinking`（`model` 已透传，照抄即可） |
| ② openai 系 wire | `services/llm-provider-openai/src/provider.ts:133-141` | 非空即加 `reasoning_effort` |
| ② anthropic wire | `services/llm-provider-anthropic/src/provider.ts:179` | 映射 `thinking: { type:'enabled', budget_tokens }`（**注意 anthropic 开启 thinking 时 temperature 必须为 1，否则 400**） |
| ③ deepseek / openrouter | 同 openai | openrouter 透传；deepseek 若不支持需容错（`reasoner` 系列不接受 `reasoning_effort`） |

### 中立枚举（建议）

```ts
type ThinkingEffort = '' | 'low' | 'medium' | 'high'   // '' = 关闭（不下发，用模型默认）
```
放 `shared/src/llm/types.ts`，各家 wire 只在 provider 内翻译 —— 与「错误码化，provider 不互相 import」的既有纪律一致。

> 若你倾向更强的能力位纪律，可再拆一个 `thinking` 能力位；但那是另一个量级的工作量，建议 P4b 不做。

---

## 7. 建议的 WS 拆分（**待确认，未开工**）

| WS | 内容 | 验收 |
|---|---|---|
| WS-0 | 收尾 P4：删调试日志、`source` 字段统一、修 §2.1 的 429 重试红 | `pnpm -r run test` 全绿 |
| WS-1 | widget 注册单一真源：修 glob 断层 + 补「已声明 widget 必须可 get」断言 | `widget.session-list` / `widget.settings` 出现在默认面板；registry 测试锁死 |
| WS-2 | 插件表调整：新增 `plugin.chat`，`plugin.workbench` → `plugin.core` | 插件列表/详情窗显示正确，停用 `plugin.chat` 后对话区消失 |
| WS-3 | 参数链路：契约扩点 ①② + 各家 wire 翻译 | 单测：openai 请求体含 `reasoning_effort`；anthropic 含 `thinking.budget_tokens` 且 temperature=1 |
| WS-4 | `widget.chat` 重建：模型下拉（复用 models.list 逻辑）+ 思考强度下拉 + provider 下拉生效 | 组件测试 + 端到端：选 deepseek-reasoner + 高强度 → 冒烟断言上游请求体 |
| WS-5 | 集成冒烟：真 Core + 真 8 服务 + 本地假上游，断言 `loop.run` 带参一路到上游 body | 仿 `p4-integration.test.ts` 加用例 |

---

## 8. 未做的事 / 需要你决定的事

**未做（本次刻意没碰）**：任何 `client/`、`services/`、`shared/` 代码；P4 WS-5 收尾；429 红用例的修复。

**待你拍板**：

1. **组件拆分粒度**：`widget.chat` 做成「一个盒子内含 左列表 + 右对话」（demo 形态，布局稳定、拖到独立窗也完整），还是「两个独立 movable box 盒子」靠工作台摆位？（后者符合当前"组件=最小单元"约定，但窗口尺寸/流式高度受盒子约束）
2. **归属**：`plugin.chat` 新增 vs 并入 `plugin.llm`；`plugin.workbench` 是否改名 `plugin.core`。
3. **429 重试红怎么修**：拓扑 `inject` 顺序 / llm-retry 启动后主动拉路由 / Bus 订阅即回放。
4. **`source` vs `catalog`**：回退成契约里的 `source`，还是正式改名并同步改 `shared` + 文档。
5. **P4b 与 P7 的边界**：本轮只做「对话 agent 的雏形」（多轮 + 模型/强度可控），**不做**工具调用循环、tool_call 透出 wire、`role:'tool'` 扩展 —— 那三件仍属 P7 前置项（已登记在 `阶段追踪.md`）。确认这个边界吗？

---

## 附：本次改动清单

| 文件 | 改动 | 验证 |
|---|---|---|
| `docs/wireframes/demo/index.html` | 新增 J1~J4 四个对话工作台场景 + `.cwb*` 样式 + 导航项 | `parse5` 解析：错误数 6→6，**均为既有 I3/I4 模板写法所致**，我新增场景（第 916 行起）未引入新错误；nav 与 template 一一对应 |
| 本文件 | 新建 | — |

`docs/wireframes/chat-workbench.html`（我最初写的独立 demo）已删除，避免与 `demo/index.html` 形成两份真源。
