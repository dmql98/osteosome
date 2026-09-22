# Osteosome 开发文档 · 插件化架构 RFC —「一切皆插件」导向的耦合治理

> 状态：Draft ｜ 作者：dmql ｜ 日期：2026-09-22 ｜ 原名：天枢插件化架构 RFC（天枢 → Osteosome 更名中）
> 关联：天枢仓 `dev/docs/dsh-vs-tianshu-tools.md`（工具系统级对比，本文是架构级延续，两者互补）
> 原则：**小步 strangler，每步绿灯通行**。不推倒重写、不引入运行时热插拔、不新增运行时依赖（初期）。

---

## 1. 动机：耦合正在把天枢焊成一块

天枢 server（`dev/web/server/src`，251 个 TS 文件）功能并不缺，缺的是**模块之间的胶水**。耦合集中体现为三个"装配点"，所有子系统都被它们直接 import / 内联调用：

### 1.1 `app.ts` —— 唯一装配中枢（首战战场）

`startTianshuServer()`（app.ts:160-378）就是一台"把所有线焊在一起"的机器：

- **直接 import 20 个路由 + 15+ 子系统**（app.ts:6-33），代码即装配清单，改装配只能改代码。
- **启动时内联执行 7 段业务 sweep**（app.ts:176-264）：孤儿 run 回收、续跑链修复、run_events/llm_calls 数据保留、快照仓库清理、tool_usage 回填、builtin 内容物化、角色视觉迁移。每段都是"拿 `getDb()` 裸跑 SQL + 打日志"，段与段之间靠手写先后顺序，无法单独开关/替换/测试。
- **全局可变单例靠 boot 时偷偷塞**（app.ts:328-331）：
  ```ts
  setEventDefinitionRuntime(broadcaster)   // event/event-run-adapter.ts
  setGoalRuntime(broadcaster)              // routes/goals.ts
  setRunsRuntime(broadcaster)              // routes/runs.ts
  setTransportBroadcaster(broadcaster)     // transport/runtime.ts
  ```
  被塞的模块各自维护一个 `let xxxRef: ... = null` + `getXxx()`（throw if not set），这就是"运行时全局变量"——谁先 import 谁先炸，测试里必须先手动塞。

### 1.2 `outer.ts` —— 531 行 god-function

`sessionLoop()`（agent/outer.ts:56-529）一次 run 做完全部：加载角色/provider → 连 MCP（重试 3 次）→ 组工具注入 → system prompt 构建/缓存 → 组初始消息 → 冷启动压缩 → 剪枝 → 跑 loop → git 快照 diff → 自动续跑 → 缓存统计 → 进化检测 → 断 MCP。直接 import **20+ 模块**（db store / transport / evolution / content / definitions / knowledge / mcp / snapshot / config / run machinery…），新增任何能力都必须改它。

### 1.3 `loop-engine.ts` —— 784 行内嵌策略

`runLoopEngine()`（agent/loop/loop-engine.ts:145-784）把 plan/goal/delegation/doom-loop/收敛评估/上下文管理全部 if/else 内联在 turn 循环里。执行模式（direct/plan_first/goal）、策略注入、压缩水位全是**承诺式功能**而非**可插拔扩展点**。

### 1.4 放大耦合的底层机制

| 机制 | 位置 | 后果 |
|---|---|---|
| DB 单例满天飞 | `getDb()` + 各 store 直接 import（routes/messages.ts:2-5 等 20+ 处） | 存储无法替换/分片/测试隔离 |
| 全局可变单例 | `setXxxRuntime`/`getXxx`（transport/runtime.ts:30-37） | 隐式依赖 boot 顺序，模块间不可见耦合 |
| 路由是模块级单例 | `const router = new Hono()`（各 routes/*.ts） | 无法按场景装配、无法并发多实例 |

### 1.5 好消息：地基建了一半

天枢已经具备 dsh 的**两块地基**：
- **工具 = 半个插件系统**：`tools/registry.ts` 目录自动发现 + `tool.json` 元数据 + 显式 `register()`，且 `routes/tools.ts` 与 registry 都能读元数据。
- **Provider = 一个成形的 seam**：`providers/types.ts` 统一定义 + `openai-compatible.ts` 基类 + 30+ provider 适配器，consumer 在 `llm/client.ts`。
- **会话 = 半个 durable log**：`run-event-store.ts` 的 `publishRunEvent` / `createDurableStream` / resume 机制，思想已接近 dsh 的 "session log 是唯一事实源"。

**缺口就在中间**：没有 context（服务容器）、没有事件扩展点（只有 emit 通知）、没有装配清单（app.ts 是特权核心）。

---

## 2. dsh 哲学五则 & 天枢落点

DeepSeek Harness（dsh）的全部主张可缩成五条，每条都给天枢一个具体落点：

### 2.1 一切皆插件，连 agent loop 本身都是插件

DSH 没有一个"特权核心"要打补丁：model adapter、tool registry、session log、agent loop 全部是插件，可被配置替换。

**天枢落点**：最终 `runLoopEngine` 与 `sessionLoop` 中间层（context 构建、policy 注入、continuation）都拆成可替换的处理器。**远期**：`agent-loop` 本身可被第三方实现替换。

### 2.2 Cordis：一个 ctx 是服务的仓库

DSH 底层是 Cordis：插件向共享 **ctx** 贡献 services / typed events / 可逆 effects。插件是 `apply(ctx)` 函数或 Service 子类，靠 `inject` 声明依赖。

**天枢落点**：用一个**极简自研 `ctx`**（约 150 行，接口对齐 Cordis 概念，未来可无缝换 Cordis 实现）替换 `setXxxRuntime` 全局单例 + 直接 import。这是**第一步就做、收益最显性**的改造。

### 2.3 事件分类法： waterfall / serial，扩展点是"否决+委托"而非"通知"

DSH 的事件分两类：
- **waterfall**（`agent/pre-step`、`llm/stream`、`tools/pre-execute`…）：listener 收到 `(...args, next)`，**不调 `next()` 即否决**（短路），调则委托给下游。
- **serial**（`agent/turn-stopping`）：旁路通知，无 `next()`。

**天枢落点**：天枢目前的 `stream.emit('run.*')` 只是"通知"。新增带 `next()` 语义的扩展点（`agent.pre-step`、`tools.pre-execute`、`run.before-compact`），让策略/审批/压缩能变成挂上去的 listener，而不是 `loop-engine.ts` 里的 if/else。

### 2.4 Seam = Service Definition + Service Provider + Consumer，三者齐备才叫能力

DSH 定义：换一个 provider 就换整个产品行为 = seam 成立。文件系统/子进程 provider 共用一个执行世界，指哪儿都跟着走。

**天枢落点**：显式立项五个 seam：`llm`（已成）、`tools`（已成）、`storage`（session/message/event store 接口化）、`context.builder`（消息/提示组装）、`transport.broadcaster`（已半成）。每个 seam 配 Definition（接口）+ Provider（默认实现）+ Consumer（loop/routes）。

### 2.5 Session log 是唯一事实源："model-visible means logged"

任何进入模型请求的内容必须能从 log 重建；resume/fork/回放/遥测全部派生自同一条事件流。

**天枢落点**：天枢已有 `run_events` durable 表 + resume。**本 RFC 将"任何新写入模型上下文的东西必须是新事件类型"立为迁移期不变式**（对齐 dsh 的 runtime invariant），防止继续出现"只进内存不进日志"的动态注入。

---

## 3. 目标架构

```
                     ┌──────────────────────────────────────────────┐
                     │                boot.ts (装配层)                │
                     │   read manifest → 按序 apply 各 layer/flake   │
                     └───────────────┬──────────────────────────────┘
                                     │ creates
                                     ▼
   ┌──────────────┐   ┌─────────────────────────────┐   ┌────────────────┐
   │   ctx (Container) │  register/get/inject/event    │   │   Sweep/Lifecycle │
   │  services + events│  waterfall/serial/action      │   │   plugins       │
   └──────┬───────────┘  └─────────────────────────────┘   └────────────────┘
          │
   ┌──────▼──────────────────────────────────────────────────────────────┐
   │                        Seam 注册表（运行态）                           │
   │  llm *  tools *  storage *  context.builder *  transport.broadcaster │
   └──────┬──────────────────────────────────────────────────────────────┘
          │ providers are consumers of ctx
          ▼
   ┌──────────────────────────────────────────────────────────────────────┐
   │   Agent 运行时（可替换的 loop 实现）                                      │
   │   outer pipeline (pre-step hooks) → loop → inner → tools(pre/guard/   │
   │   execute/post) → 结果 → 持久化                                         │
   └──────────────────────────────────────────────────────────────────────┘
```

### 3.1 极简 `ctx` 契约（第一步落地件）—— 对齐真实 Cordis

新增 `src/container/context.ts`（约 200 行，无新依赖）。**不引入 Cordis 包本体，但契约对齐它的五个想法**，白盒替换点保留：

```ts
interface Container {
  // ① 服务仓库：认领 ctx.<key>，靠 key 找服务，不靠 import
  register<T>(id: string, impl: T): void
  get<T>(id: string): T                        // 未注册则 throw（fail fast）
  has(id: string): boolean
  is(plugin: PluginModule, name: string): boolean // 服务归属判断（卸载仲裁用）

  // ③ 依赖声明：插件命名所需服务，等它们存在才激活 apply
  //    （加载顺序由依赖推导，替代 app.ts 手工排 sweep）
  mount(plugin: { inject?: string[]; apply(ctx): void | Promise<void> }): Promise<void>
  // ⑤ 可逆效果：任何注册都返回 disposer，卸载/重建时逆序回卷
  effect(register: (ctx) => void | (() => void)): () => void

  // ④ 类型化事件 + 分派模式（TS declaration merging 声明事件名 → 类型即契约）
  on(event: EventKey, listener: Listener): () => void      // disposer
  emit(event: EventKey, payload: unknown): void            // 旁路通知
  waterfall(event: EventKey, input: unknown): Promise<unknown>   // 中间件，可短路
  serial(event: EventKey, input: unknown): Promise<unknown>      // 依序链式
  bail(event: EventKey, input: unknown): Promise<unknown>        // 首决即止（预留）

  // ctx 是树：agent/子作用域从父 ctx 派生，派生继承服务、隔离事件
  scope(): Container
  parent: Container | null

  // 生命周期
  start(): Promise<{ stop(): Promise<void> }>   // 按依赖序启动 / 逆序停止
}
```

**分派模式契约**（对齐 Cordis dispatch 表；天枢起步只用前三个，`bail`/`parallel` 进契约但留待需要时实现）：

| 模式 | await | 顺序 | 返回值 | 用途 |
|---|---|---|---|---|
| `emit` | 否 | 注册序 | 无 | 旁路通知（`run.failed`、`goal.paused`） |
| `waterfall` | 否 | 注册序 | 有 | **中间件**：`agent.pre-step` / `tools.pre-execute`，不调 `next()` 即否决 |
| `serial` | 是 | 注册序 | 有 | 链式决策（`run.completed` → continuation 判定，可挂多个后续） |
| `bail` | 否 | 到首决 | 有 | 单一决策点（预留） |
| `parallel` | 是 | 并行 | 无 | 扇出（预留，如多 sink 投递） |

**waterfall 语义**（与 dsh 完全一致）：listener 收 `(...args, next)`，`next()` 携带（可能被上一家改写的）结果委托给下一家；返回值经 `next()` 传播；short-circuit = 不调 `next()`。策略/审批/提示注入都是挂上去的 listener，而不是 `loop-engine.ts` 里的 if/else。

**可逆效果是命门**：`ctx.on` / `ctx.effect` 必须返回 disposer，且 `mount(plugin)` 在 plugin 卸载时**逆序回卷**其全部注册（对齐 §2.2 "注册是 effects，卸载时 unwind"）。这是热重载与插件树安全重建的前提，也是天枢现在"往全局 Map 塞东西"缺失的一环。

### 3.2 Lifecycle / Sweep 插件（app.ts 拆解目标）

每个启动 sweep 变一个独立插件：

```ts
export interface LifecyclePlugin {
  id: string
  order: number                              // 显式排序，替代手写先后
  enabled?: (ctx) => boolean                 // 可开关
  run(ctx: Container): Promise<void>         // 幂等，失败可降级打日志不阻断启动
}
```

app.ts 收敛为一句话 + 一个 hook：

```ts
for (const p of [...bootPlugins].sort((a, b) => a.order - b.order)) {
  if (p.enabled?.(ctx) ?? true) await p.run(ctx)
}
```

### 3.3 路由工厂化

`const router = new Hono()`（模块级单例）→ `createRouter(ctx: Container): Hono`。依赖通过 ctx 注入，不再 `setXxxRuntime`。route 文件内部可保留对 store 的引用，但 store 改为从 ctx 取（`ctx.get('storage.session')` 之类），测试可注入内存实现。

### 3.4 Boot manifest（远期 driver）

目标形态：

```yaml
# tianshu.profile.yml
profile:
  base: desktop
plugins:
  - id: tianshu.sweep.retention    # 可被用户 patch 关闭/替换
  - id: tianshu.agent-loop.default
  - id: tool.memory *              # 记忆/知识/技能作为可挂载插件
providers:
  - deepseek / vertex / custom
```

装配顺序：`profile.bundles 顺序 → 用户 patch → 环境 override`。**这一步是远期目标**，前三个阶段只做代码层接缝，manifest 只是最终形态的画线。

---

## 4. 迁移路线图（strangler，五层）

每层是一个可独立合入的 PR，**绿灯标准统一为**：

```bash
npm test --prefix web/server          # vitest 全绿（含现有 60+ 测试）
npm run build:server                  # tsc 零错误
# 手动 smoke：node dist/index.js 启动，/api/sessions 可接，发一条消息跑通
```

### Layer 0：基线与冻结（第 0 步，~0.5 天）

- 跑通全套 `npm test --prefix web/server` 与 `npm run build:server`，记录基线。
- **补 `app.ts` 装配层测试**（当前 `startTianshuServer` 无覆盖）：用 `setup-data-dir.ts` + `TIANSHU_DISABLE_SERVER_LOCK=1` 做一次"起来→洁→关"的冒烟测试，固化启动顺序行为。这是后面每层 refactor 的安全网。
- 补齐 `transport/runtime.ts` 单测（`set/get/has` 三态）。

**产物**：一个能证明"装配行为在当前实现下是 X"的测试，strangler 每步都让测试继续证明"还是 X"。

### Layer 1：Container 基座 + 替换全局单例（第 1 步，~2-3 天）※ 首战

**目标**：消灭 `setXxxRuntime` 全局面 + 让事件具备 waterfall 能力 + 让"注册可回卷"。

1. 新增 `src/container/context.ts`（3.1 契约，含 `mount` 的 `inject` 等待语义与 `effect`/`on` 的 disposer）。
2. 迁移最先死的四个单例：
   - `transport/runtime.ts`：`createBroadcaster` 改为在 ctx 上注册 `transport.broadcaster`；`setTransportBroadcaster/getTransportBroadcaster` 保留为薄兼容壳（deprecated 注释），跑完本层后删除。
   - `event/event-run-adapter`、`routes/goals.ts`、`routes/runs.ts` 的 runtime 注入同法迁移。
3. `startTianshuServer` 内部创建 `ctx`，把 `broadcaster`、`db`、关键 store 注册进去（先注册，**消费者暂不换**，做到"可注册但未消费"，降低单层 diff）。
4. 验证挂载语义：把四个单例迁移写成 `ctx.mount({ inject: ['transport.broadcaster'], apply(...) })` 形式的插件，**用依赖声明替代手工塞全局**（app.ts:328-331 的那四行 `setXxx*` 从"命令"变"声明"）。
5. 追加 `waterfall` 的第一个真实用例（演示而非业务）：给 `run.started` 挂一个串行日志监听，验证 serial 语义 + 卸载后 disposer 生效（回卷可测）。

**绿灯**：Layer 0 测试原样全绿 + 新加的 container 单测绿（含"disposer 卸载后 listener 不再触发"）。
**回滚**：单层 revert，兼容壳保证旧路径不破。

> 注：本层只落 `mount`/`inject`/`effect`/`on`/`emit`/`waterfall` 六个能力 + `scope()`；`serial/bail/parallel` 进契约但实现留空（YAGNI），接口存在防止后续改签名。

### Layer 2：启动 sweep 插件化（第 2 步，~2-3 天）※ 首战继续

**目标**：`app.ts` 里的 7 段内联 sweep 全部变成独立 `LifecyclePlugin`，app.ts 收敛成"建 ctx → 注册 → 按序 run plugins → 挂路由 → serve"。

1. 新增 `src/lifecycle/` 目录，每个 sweep 一个插件文件（retention、orphan-reclaim、continuation-repair、snapshot-sweep、tool-usage-backfill、builtin-materialize、skin-migrate），**逐段 1:1 搬运，不优化逻辑**（先保行为，后炼）。
2. `app.ts` 里删除内联块，替换为 `for...run(plugins)`。
3. 排序依赖（如 continuation-repair 必须在 retention 之前）用 `order` 字段显式表达，**顺手把隐性顺序变成可读契约**。
4. `initTools` / `materializeAllBuiltinContent` / `migrateAllCharacterVisualsToSkin` 也纳入 lifecycle。

**绿灯**：Layer 0 冒烟测试原样全绿（时序由 order 保证一致）+ `lifecycle.test.ts` 增补"某插件 disabled 时其余照常"。
**风险**：Sweep 顺序被测试锁定后不会漂移；任何一段在启动 log 中可单独观测。

### Layer 3：路由工厂化 + storage seam（第 3 步，~3-5 天）

**目标**：路由不再依赖模块级单例与 `getXxxRuntime`，依赖显式注入。

1. 批量把 `const router = new Hono()` 改为 `createRouter(ctx)`：先迁 `runs.ts`（耦合最重的）练手，再批量其余。
2. 定义 storage seam：`StorageDefinition`（session/message/event interfaces），把 `getDb()` 的直接 import 收敛到 seam 内，`ctx.get('storage.session')` 获取。**不重写 store 实现，只加接口皮**（接口皮 = 现有 store 的函数签名摘录，零行为变更）。
3. `setXxxRuntime` 兼容壳在本层删除。

**绿灯**：routes 相关测试（provider-api / session-stats / statistics-api / run-policy-api / theme-api 等）全绿 + Layer 0 冒烟全绿。
**风险**：此层 diff 最大，拆成多次 commit，每 5 个路由一签。

### Layer 4：outer / loop 拆接缝（第 4 步，~1-2 周）

**目标**：把前文 1.2/1.3 的 god-function 拆成 pipeline + hooks。**这是工作量最大的一层，独立成 RFC v2 细化**，此处只定方向和骨架。

1. **context.builder seam**：`buildInitialMessages` / system-prompt 组装 / 冷启动压缩 / 剪枝 → 实现 `ContextBuilder` 接口，`agent.pre-step` 之前由上至下执行，各步骤注册为 hook。
2. **policy seam**：plan/goal/delegation/doom-loop 注入 → `agent.pre-step` waterfall listener + `run.policy-alert` 扩展点。硬 if/else 变 listener。
3. **continuation seam**：自动续跑逻辑移出 outer，挂 `run.completed` 扩展点（serial listener 决定是否排 successor）。
4. **agent-loop seam**：`runLoopEngine` 本身定义为可替换服务 `ctx.get('agent.loop')`，默认实现保留现状。

**绿灯**：`loop.test.ts` / `run-policy.test.ts` / `goal-control.test.ts` / `sub-agent-fanout.test.ts` 全绿 + 一次人工跑三模式（direct/plan_first/goal）e2e 冒烟。

### Layer 5（远期，非本期）：插件打包与 manifest

- 定义插件 API 契约（`apply(ctx)` + metadata），工具/记忆/知识/技能作为可挂载插件发布。
- `tianshu.profile.yml` boot manifest，支持 patch/替换。
- 若届时 Cordis 生态成熟，`ctx` 内部实现可替换为 Cordis（接口层已对齐，换实现是白盒替换）。
- **不做**：运行时（不重启）热插拔、进程级拆分（server/client/desktop 仍单体）。

---

## 5. 迁移期不变式（"don't make it worse" 守则）

在改造过程中，任何**新增/修改**代码必须遵守：

1. **Model-visible means logged**：写入模型上下文的任何新动态内容，必须先有对应 durable 事件类型 + 事件落库，不准只写内存。违反此条的新代码不允许合入。
2. **禁新全局单例**：`setXxxRuntime` 模式不再新增。新服务一律过 ctx。
3. **禁在 app.ts 内联新 sweep**：启动逻辑一律走 LifecyclePlugin。
4. **路由禁止新增模块级 `const router`**：一律 `createRouter(ctx)`。
5. **任一注册必带 disposer**：`ctx.on`/`ctx.effect`/store 注册都返回回卷函数；不允许"只塞 Map 不提供卸载"的新代码（对齐 Cordis reversible effects）。
6. **每层一个 PR + 全绿 + 可单独 revert**：不允许跨层大爆炸提交。

---

## 6. 非目标与边界（本期明确不做）

| 事项 | 状态 |
|---|---|
| 引入 Cordis 作为运行时依赖 | ❌ 初期不引入；用约 150 行自研 ctx 对齐接口,预留替换点 |
| 代码行为优化（sweep 合并/提速） | ❌ Layer 2 只做搬运塑形,优化后续单独做 |
| 重写 store/db 实现 | ❌ 只加接口皮 |
| 运行时热插拔插件 | ❌ 远期 |
| server/client/desktop 进程拆分 | ❌ |
| 一次性把全部 251 文件插件化 | ❌ strangler,每层只做承诺范围 |

---

## 7. 验证矩阵与节奏预估

| Layer | 内容 | 关键绿灯 | 预估 |
|---|---|---|---|
| 0 | 基线 + app.ts 冒烟测试 | 60+ vitest 原样全绿 | 0.5 天 |
| 1 | ctx + 替换全局单例 | 原测试全绿 + container 单测 | 2-3 天 |
| 2 | 启动 sweep 插件化 | 冒烟全绿 + lifecycle 增补测试 | 2-3 天 |
| 3 | 路由工厂化 + storage seam | routes 测试全绿 | 3-5 天 |
| 4 | outer/loop 拆接缝 | loop/policy/goal 测试全绿 + 三模式 e2e | 1-2 周 |
| 5 | 插件打包 + manifest | 远期,另立 RFC | — |

**最低可交付版本** = Layer 0-2：`app.ts` 从"焊线机器"变成"读清单的装配器"，这是本次首战的最小完整闭环。Layer 3-4 是价值深挖，Layer 5 是愿景。

---

## 8. 附录：现状耦合证据索引

| 症状 | 位置 |
|---|---|
| 全局单例 set/get 对 | transport/runtime.ts:30-37；routes/goals.ts、routes/runs.ts、event/event-run-adapter.ts 同构 |
| app.ts import 全部路由+子系统 | app.ts:6-33 |
| 内联启动 sweep ×7 | app.ts:176-264 |
| boot 时塞 runtime | app.ts:328-331 |
| outer god-function | agent/outer.ts:56-529（直接 import 20+ 模块，outer.ts:1-45） |
| loop 内嵌策略 | agent/loop/loop-engine.ts:145-784 |
| 路由模块级单例 | routes/messages.ts:5 等（`const router = new Hono()`） |
| 工具已插件化 | tools/registry.ts:13-54 |
| provider 已 seam | providers/types.ts + providers/openai-compatible.ts |
| 会话 durable 事件 | agent/runtime/run-event-store.ts |

---

## 9. 附录：与 DeepSeek Harness 的成熟度对标（决策补充 2026-09-22）

> **决策**：整体不嵌入 dsh 作为运行时；但对**个别子系统**，若 dsh 的实现明显更成熟，按「**移植契约词汇、实现长在天枢自己的存储上**」的方式吸收（dsh 是 MIT，可直接照搬代码再改造成天枢 SQLite 版）。本附录是逐能力的成熟度基线 + A 组移植契约清单，供各层验收对照；同时它**不推翻原五层 strangler，而是升级其中两块 seam**。

### 9.1 对标矩阵

| 分组 | 能力 | dsh 的成熟形态 | 天枢现状 | 结论 |
|---|---|---|---|---|
| **A · 值得移植** | LLM 适配器 | `LlmAdapter.stream(): AsyncIterable<StreamChunk>` 中立流契约 + 按供应商独立包（`llm-deepseek` 原生双协议 / `llm-pi-ai` 包装目录）；provider 声明式 `retryPolicy` + 错误码化；`token-meter` 重放日志测算 | `llm/client.ts` 单一 openai 兼容 wire（681 行）+ `format` 死配置 + 字符串判 429 + 4 字段记账 | 契约形状待对齐（见 §11） |
| **A · 值得移植** | 会话模型 | `Session` = 仅追加的类型化事件日志，单一事实源；LLM 历史**从日志派生**，重放 = 重新派生；事件无损 JSON、seqs 连续，可声明式扩展事件类型 | `run_events` 仅半套 durable 流；messages/sessions 仍存关系表，双轨并存 | 事件化未走完 |
| **A · 值得移植** | Compaction | 完整 seam：`compaction/start\|summary\|end` log-only 事件 + 全程锁（崩溃 = 孤儿锁可探测）+ `shadowedRange/shadowedSeqs/shadowedTokenCount` 书签 + 摘要以 `surfaceOp:{op:'replace'}` 的 `user/message` 落面 + `pressure/context-overflow` 双触发 | outer.ts 内联冷启动压缩 + loop 内剪枝、硬阈值 | 无锁、无书签、无事件化 |
| **A · 值得移植** | 工具执行管线 | `tools/pre-execute → tools/execute → tools/post-execute` + policy 监听器；审批 / 权限预设独立成子系统 | workspace 审批以 if/else 散布在 loop | 只有肉，没有管线 |
| B · 相当，不动 | skills / goal / plan / 子代理 | skills 目录、same-session goals、plan mode、subagent providers | SKILL.md 技能包、承诺式 goal/plan、角色委托 | —— |
| C · 只借思路 | sandbox / bash / terminal / jobs / LSP / code-runtime / web-access | landlock 沙箱、PTY、代码运行器…（Linux/npm 生态） | Windows 桌面 + 工具目录 + SQLite | 平台不合，不移植 |

### 9.2 A 组移植契约（移植「词汇与形状」，实现自研）

**① 会话模型 → 对齐 event-sourced log（结构级强约束）**
- 契约：会话 = 仅追加类型化事件日志；任何 model-visible 内容必有对应事件类型；消息历史由日志派生（投影表），重放 = 重新派生。
- 落点：`run_events` 已半成形；目标是把 messages/sessions 的写入收敛为「写事件 → 派生表」，让不变式 1「Model-visible means logged」从条文变**结构保证**。
- 边界：这是数据模型层改动，独立成步，与 Layer 3 storage seam 配合，**只能事件化不能先斩旧表**；不与 Layer 0-2 并发。

**② Compaction → dsh 形状的 seam（升级 Layer 4）**
- 词汇：`compaction/start | summary | end` 三个 log-only 事件；锁包围「测长 → 选区 → 摘要 → 落面」全程（先 start、最后 end，崩溃 = 无 end 的孤儿锁，重启可回收）；`shadowedSeqs` 为被遮蔽节点权威集；摘要本身是带 `surfaceOp:{op:'replace',start,end}` 的 `user/message`。
- 落点：把 RFC §5 扩展点表的 `run.before-compact` 扩展为这套词汇 + 触发词（`pressure | context-overflow`），替换 outer.ts 内联冷启动压缩与 loop 硬阈值。
- 验收：压缩全程可重放、可审计；孤儿锁出现在启动 sweep（复用 Layer 2 LifecyclePlugin）而非静默吞掉。

**③ 工具执行管线 → pre/execute/post + policy 监听（升级 Layer 4）**
- 形状：`ctx.tools.execute` 前后各一个 waterfall 扩展点；workspace 审批 / 策略矩阵 / 只读判定从 loop 的 if/else 变 `tools.pre-execute` listener；结果截断与 doom-loop 观测挂 `tools.post-execute`。
- 落点：与 RFC §5 扩展点表一致，落地即升级 Layer 4 的 policy seam。
- 验收：审批与执行解耦；新增策略不触碰 loop；策略挂载可逆（disposer）。

**④ LLM 适配器 → 中立流契约 + 声明式 retry 与错误码（升级 Layer 4，行为侧，见 §11 附录 C）**
- 契约：`stream()` 输出带 block 边界的类型化流（文本 / 推理 / 工具 call 显式块），末尾 `finish` 终块携带稳定错误码与 Retry-After 事实；重试策略由 provider 声明、执行器独立（对齐 dsh `LlmAdapter` + `llm-retry`，只搬词汇不搬代码）。
- 落点：`llm/client.ts` 的 `LLMChunk` 升级为块化契约；`format` 要么兑现成真 wire 要么从 schema 删除；429 / 并发 / 超时判定从字符串 `includes()` 收敛为错误码；记账对齐 disjoint cached/uncached；凭证收口到 seam。
- 验收：新增供应商不再手改单一函数；google preset baseUrl 恢复可连通；无任何错误靠字符串匹配判定；`isTransientLLMError` 的字符串表退位。

### 9.3 边界与顺序

- 全部自研实现对齐契约，**不引入任何 dsh 运行时依赖**（延续 §6 决策）。
- A 组四项的落地顺序：④LLM 适配器契约对齐（最小、纯行为侧，先做）→ ③工具管线（接 Layer 4，纯行为侧）→ ①会话事件化（数据层大改，独立小步，需存储迁移）→ ②Compaction（依赖 ① 的事件化土壤，最后做）。
- B 组不再因对标而改动；C 组只保留「everything is a plugin」的 seam 分层思路。

---

## 10. 附录：前端工作台化 —— 「插件即窗口」（决策补充 2026-09-22）

> **决策**：前端从「页面」升级为「工作台」——每个持久信息面是一个**独立的窗（Pane）**，默认停泊在主容器里，可被拖出为独立窗口、可自由调换位置；**新增一个插件 = 新增一个插件窗口**。本附录定义 Pane 契约、布局模型、双端弹窗机械与跨窗状态同步，作为后续「客户端插件化」RFC 的范围锚点。参照物是 VSCode / Obsidian 的副窗口停泊模式（dsh 是单窗口插件应用，此模式天枢自研）。

### 10.1 现状：前端三个装配点（与 server 同构的病）

| 装配点 | 现在 | 病灶 |
|---|---|---|
| `App.tsx`（前端的 app.ts） | 内联导航 `<nav class="nav-rail">` + `navItems` 数组（App.tsx:30-39、113-145）+ 路由表（147-169） | 导航不是组件；4 组启动副作用（48-106：桌面恢复 / datadir 遮罩 / 主题引导 / 事件轮询）硬编码 |
| `ChatPage.tsx` | 装配 SessionPanel / ChatArea / RightPanel / FilePanel | 装配关系写死在页面，面板开合布尔漂在 uiStore |
| `RightPanel.tsx`（359 行 monolith） | 角色卡 / 项目区 / 授权工作区 / 帮手 / 知识库 / GoalPanel / **会话统计**七段手排顺序 | 「会话统计」（331-345，`useSessionStats` + `buildStatsCards`）只是其中一段，不是可插拔单元 |

### 10.2 核心模型：Pane = 单元，Layout = 数据，窗口 = 挂载方式

- **Pane**：一个持久信息面（导航栏 / 会话列表 / 聊天 / 会话统计 / 目标 / 轨迹 / 知识挂载…）。
- **Layout**：一份可序列化的装配图 JSON（主窗内嵌网格 + 同窗悬浮 + 独立窗），存进 `/api/preferences`（沿用 theme/iconpack 的按文件持久化模式）。
- **Mount**：`docked`（停泊）/ `swap`（同窗换位）/ `windowed`（拉出独立窗）。
- **红利**：uiStore 的 `sidebarOpen / rightPanelOpen / filePanelOpen` 三开关直接消失——面板开合 = 布局里有没有该 pane 节点。

```ts
type Layout =
  | { kind: 'row'; children: Layout[] }                    // 水平分割
  | { kind: 'col'; children: Layout[] }                    // 垂直分割
  | { kind: 'pane'; id: PaneId }                           // 叶子 = 一个插件窗口

interface WorkspaceLayout {
  dock: Layout                                             // 主窗内嵌网格
  floating: { paneId: string; size: { w: number; h: number } }[]   // 同窗悬浮
  windows: { paneId: string; rect: { x: number; y: number; w: number; h: number } }[]  // 已拉出独立窗
}
```

### 10.3 插件作者的开发合同（写一个 pane = 得到一个窗口）

与 server `tools/registry.ts:13-54` 的目录自动发现同构：client 用 vite `import.meta.glob` 扫 `features/*/pane.tsx`，作者只写元数据 + 组件：

```tsx
export default definePane({
  id: 'pane.evolution',
  title: '进化洞察',
  icon: 'nav-sparkles',
  defaultSlot: { area: 'right', index: 3 },   // 首次出现的默认停泊位
  windowable: true,                           // 允许拉出独立窗
  component: lazy(() => import('./EvolutionInsights')),
})
```

`definePane` 自动获得：标题栏（可拖拽）/ 窗口菜单（重置布局 · 拉出 · 关闭）/ i18n key / 初始化上下文。

### 10.4 双端拉出机械

- **桌面（Electron）**：桥上加 `paneWindow.open(paneId, rect?)` → 主进程 `new BrowserWindow(...)` 加载 `#/pane/<paneId>`；同 partition → 共享 localStorage / SSE cookie，零鉴权桥接；创建后写回 `layout.windows`。
- **纯网页**：`window.open('#/pane/<paneId>')` 弹窗。
- **宿主壳 `<PaneHost>`**：`#/pane/:id` 路由 = i18n Provider + ThemeBackdrop + 迷你标题栏 + 该 Pane。App.tsx 的启动副作用（10.1）必须拆进宿主层，否则弹窗是黑窗。

### 10.5 跨窗状态：服务端真源 + 两个 BroadcastChannel

- 数据（会话 / 统计 / 运行事件）全部走服务端 SSE，弹窗连上即收流，不复制内存。
- 需同步的只有本地态，两个通道：
  - `tianshu:ctx` → `{ activeSessionId }`：会话上下文**全局唯一**，任何窗改 → 广播 → 其余跟随（主窗点会话，弹出的 Chat / 统计窗跟着切）。v1 单一上下文；「一窗一会话」隔离归远期。
  - `tianshu:ui` → layout 变更（窗开关 / rect）。
- **恢复**：Electron 启动按 `layout.windows` 复原各窗位置尺寸；打开的是同页 URL，数据自然回来。网页弹窗活不过刷新，不予承诺。

### 10.6 生命周期（新增 / 卸载 / 更新插件对布局的影响）

| 场景 | 行为 |
|---|---|
| 新装插件首启 | 无布局记录 → 按 `defaultSlot` append 到右侧底部，可拖走 / 拉出 |
| 卸载插件 | dock / windows 留下未知 paneId → 渲染「插件未安装」占位，**不崩布局**；重装原位复原 |
| 插件自更新 | paneId 不变，布局不丢，只换内容 |

### 10.7 分期路线（F0-F3，均走客户端绿灯门：vitest 全绿 + 构建）

| 步 | 内容 | 绿灯 |
|---|---|---|
| F0 | 布局模型 + `definePane` 注册表 + `<PaneHost>`；App.tsx 启动副作用拆进宿主层。副产品：uiStore 三开关消失 | 布局序列化单测 + 现 vitest 全绿 |
| F1 | 页内拖拽换位（dnd-kit 或轻量自研）→ 布局 diff → 持久化 | 拖拽交换 + 刷新还原 |
| F2 | Electron `paneWindow` 桥 + `#/pane/:id` + 启动复原窗口 | 桌面冒烟：拖出 / 归位 / 重启 |
| F3 | 网页 popout + `tianshu:ctx` / `tianshu:ui` 广播跨窗同步 | 双端一致 |

### 10.8 边界（本期明确不做）

- **跨窗拖拽**（把一个窗拖进另一窗的网格）：远期；v1 只做「同窗内换位 + 拉出独立窗」。
- **复制窗**（同一 pane 开多个实例）：远期（v1 全局单上下文不允许两个聊天窗看不同会话）。
- **操作类对话框不窗化**：选角色 / 审批 / 编辑弹窗保持模态，只有**持久信息面**才是 pane。
- 布局权限 / 多用户布局：不做（沿用现有单机偏好语义）。

---

## 11. 附录：LLM Provider 适配器对标与问题清单（决策补充 2026-09-22）

> **复核结论**：RFC §9.1 原判 providers 为「B · 相当，不动」，本次深调研推翻该判定——天枢的 provider 层不是「适配器集合」，而是**「目录 + 单一 openai 兼容 wire」**。dsh 的 provider 层（`packages/llm/*`）构型显著更成熟，已提级为 A 组「契约对齐」（§9.2-④）。本附录给现状证据、问题清单与对照表。

### 11.1 天枢三层栈（适配器其实是目录）

| 层 | 内容 | 证据 |
|---|---|---|
| ① 遗留静态目录 | `providers/*.ts` ×35，每文件 ~16 行（id / baseUrl / envKey / format / models[]），仅作 runtime 断言 | 全库唯一消费点 `provider-catalog/loader.ts:143`（`getPlugin(preset.runtime.plugin)`） |
| ② 出厂预设 | `content/builtin/providers/*/provider.json`（schemaVersion 1，18 家） | schema.ts:11-74；loader.ts:13-18（seed 到 dataDir 后读取） |
| ③ 运行时 | `db/providerStore.ts` 用户记录 + `llm/client.ts`（681 行）干全部 wire | outer.ts:78-88 组装 ProviderConfig（base_url / api_key / api_style） |

**wire 只有一种形状**：`streamChatCompletion`（client.ts:233）只讲 OpenAI chat/completions SSE 与 OpenAI Responses SSE（client.ts:513）两个协议，外加 `/responses` 探测（client.ts:118）。厂商差异全部堆在这一函数里。

### 11.2 问题清单（带证据）

1. **`format` 字段是死配置**：schema.ts:39 明文「请求格式，决定消息序列化与响应解析方式」，但请求路径**无任何按 `format` 分支**；仅 routes/providers.ts:55、provider-oauth.ts:315 当元数据透出。声明 3 种格式，实现只有 1 种。
2. **google 预设大概率 404**：google baseUrl=`https://generativelanguage.googleapis.com/v1/`（provider.json:10）被拼成 `/v1/chat/completions`，与 Gemini 官方 OpenAI 兼容路径 `/v1beta/openai/` 不符；`format:'gemini'` 承诺原生，实际连兼容口都拼不对（用户需自行覆盖 base_url 才能用）。
3. **thinking / reasoning 靠字符串嗅探**：`reasoning_content` / `reasoning` / `response.reasoning_summary_text.delta` 三路硬匹配（client.ts:432-437、596-602），网关换字段名即静默丢思考。
4. **重试策略在 agent 不在 provider**：`streamWithRetry` 是 `agent/inner.ts:238` 的通用循环，env 常量（229-236），429 靠 `errorText.includes('429')`（inner.ts:329）字符串判定；provider 无法声明自己的重试语义。
5. **错误分类是字符串表**：`isTransientLLMError` 一串 `includes()`（llm/errors.ts:39-69），措辞一变即失效。
6. **双轨并存**：35 静态插件 + 预设目录 + DB 三层叠着，新增厂商要手改 `providers/index.ts:39-51` 的 import 数组——工具侧却有 `tools/registry.ts` 目录自动发现，两套发现机制不一致。
7. **凭证单轨**：`getApiKey: () => process.env[...]`（types.ts:27），进程级单 key；OAuth 旁路（provider-oauth.ts）与 runtime 拆成两套，无统一凭证 seam。
8. **记账 4 字段**：`LLMUsage` 仅 input/output/cacheHit/cacheMiss（client.ts:64-69），无 disjoint cached/uncached 拆分、无 reasoningTokens。
9. **能力是静态元数据**：`supports_*` 写死在 catalog，配懒等 models.dev（cache 1h，routes/providers.ts:9-34），无运行时能力探测。

### 11.3 dsh 参照（`packages/llm/*`，构型级差异）

| 维度 | dsh | 天枢 |
|---|---|---|
| 契约 | `LlmAdapter.stream(): AsyncIterable<StreamChunk>` 中立流：`block-start/delta/block-end` + 类型化 reasoning + 原始 JSON 工具参数 + `finish` 终块 | 松散 `LLMChunk = delta/done/error/usage`，推理 / 工具拼装靠调用方 |
| 组织 | 核心虚类 + 按供应商独立包（`llm-deepseek` 原生双协议 / `llm-pi-ai` 包装第三方目录） | 单函数写死 openai 兼容两种协议 |
| 重试 | `providerRetryPolicy()` 声明 + `llm-retry` 独立插件在 durable 边界执行 | agent 循环 + env 常量 |
| 记账 | `token-meter` 包：重放会话日志 + 4字符/token 启发式 + 适配器声明图片定价，无模型调用 | 仅透传响应 usage，4 字段 |
| 错误 | `LlmError` 稳定码（AUTH / RATE_LIMIT / CONTEXT_WINDOW_EXCEEDED…）+ Retry-After 事实 | `includes()` 字符串表 |
| 凭证 | `ctx.credentials` seam，`apiKeyEnv` 按请求解析 | env 进程级 + OAuth 旁路 |

### 11.4 结论：提级为 A 组「契约对齐」，划入 Layer 4 行为侧

- 只搬**契约词汇**不搬代码（延续 §9.3 决策）：`LLMChunk` 块化、`format` 兑现或删除、错误码化、disjoint 记账、凭证 seam。
- 落点与验收见 §9.2-④；落地顺序见 §9.3（④ 最小、纯行为侧，先做，可与 ③ 工具管线并行）。