```markdown
# Osteosome 能力层设计备忘 · Capability

> 状态：Draft ｜ 作者：dmql ｜ 日期：2026-09-24
> 关联：`ost-开发文档.md`（架构 RFC v3）、`ost-聚合设计备忘.md`（统一工具注册）、`P1b-详细计划.md`（Slot 扩展点）、`P3-详细计划.md`（prompt 组装）
> 定位：**本文是「能力层」的设计备忘，不推翻现有规划，只在 Tool / Pane / Service 之上加一层。** 用于对齐 Capability 抽象和第一步落地。

---

## 1. 动机：从「工具」到「能力」

### 1.1 一个例子暴露的缺口

用户设想：**「添加附件」也作为一个插件**。

- 装附件插件 A（普通上传）→ 聊天框有附件按钮，AI 能收附件
- 装附件插件 B（本地路径）→ 附件按钮变成路径输入，AI 拿到路径
- 装附件插件 C（复杂转换）→ 附件先被转成 md，AI 拿到 md
- **不装任何附件插件** → **聊天框没有附件按钮，AI 不知道「附件」是什么**

**关键差别**：没装插件，功能**不存在**，不是**可选**。

这和之前讨论的「工具」本质不同——工具是「AI 想用就用」；这里是「**没有它，系统的某一部分就不存在**」。

### 1.2 假问题与真问题

**假问题**：「插件能不能改变 Agent 的运行方式？」

—— 能，但这不是「Tool」这一层能表达的。

**真问题**：「**怎么让插件贡献的不只是工具，而是一个完整的功能单元**——UI 入口、后端逻辑、system prompt、事件、数据模型，缺一不可？」

—— 这是缺口。

### 1.3 名词

本文给「插件贡献的完整功能单元」起名：**Capability（能力）**。

- **Tool**：AI 可以调的一个动作（`read_file` / `web_search` / `mcp.fs.read`）
- **Capability**：系统的一个功能单元（**UI 插槽 + Tool + Prompt 片段 + 事件 + 数据模型**的组合）

---

## 2. 定义：Capability 是什么

### 2.1 形式定义

```ts
interface Capability {
  id: string                          // 全局唯一：capability.attachment
  description: string                 // 用户/开发者可读
  provider: string                    // 提供者（插件 id）
  
  // 以下全部可选——不是所有能力都需要全部贡献
  contributes?: {
    slots?: SlotContribution[]        // UI 插槽内容
    tools?: ToolDefinition[]          // AI 可调动作（通常由能力推导，不手写）
    systemPrompt?: string | (() => string)  // system prompt 片段（动态或静态）
    events?: EventDefinition[]        // 能力自身事件（attachment.uploaded 等）
    schemaExtensions?: SchemaExt[]    // 数据模型扩展（Message.attachments 等）
  }
  
  // 生命周期钩子
  onActivate?: (ctx: Container) => Promise<void> | void
  onDeactivate?: (ctx: Container) => Promise<void> | void
}
```

**核心约束**：一个 capability 至少要贡献 `slots`、`tools`、`systemPrompt`、`events`、`schemaExtensions` 中的一项。空能力没意义。

### 2.2 与现有概念的关系

| 层 | 抽象 | 提供者 | 消费者 |
|---|---|---|---|
| **服务** | Service（进程 + manifest） | 插件 | 其他服务 / Core |
| **UI** | Pane（独立窗口） | 插件 | 用户（拖到工作台） |
| **UI** | **Slot（插槽内容）** | **插件** | **宿主 Pane（决定位置）** |
| **动作** | Tool（AI 可调） | 插件 | Loop（AI） |
| **能力** | **Capability（功能单元）** | **插件** | **系统（组装 Agent）** |

**层次**：Capability 在最上层——一个 capability 可能**包含**若干个 tool，**贡献**一个 slot，**注入**一段 prompt，**扩展**一个 schema。

---

## 3. 一个具体例子：附件插件 A/B/C

### 3.1 三个插件，同一能力位

三个插件都占据 `capability.attachment`，但实现不同：

**插件 A（普通上传）**

| 层 | 内容 |
|---|---|
| **Slot** | `chat.composer.actions` 加一个「附件」按钮 → 点击打开文件选择器 |
| **Tool** | `attachment.upload(path)` → 读文件 → 存到会话 → 返回 `attachmentId` |
| **Prompt** | 「用户可能附加文件，你会在消息里看到 attachment 引用」 |
| **Event** | `attachment.uploaded` / `attachment.removed` |
| **Schema** | `Message.attachments: Attachment[]` |

**插件 B（本地路径）**

| 层 | 内容 |
|---|---|
| **Slot** | 同位置加「本地路径」按钮 → 路径输入框 |
| **Tool** | `attachment.upload_path(path)` → 校验存在 → 返回 `{ path }` 引用（不复制） |
| **Prompt** | 「附件以本地路径形式给出，你可以用 `read_file` 读取」 |
| **Event** | 同上 |
| **Schema** | 同上（`Attachment` 类型字段不同：`{ path: string }`） |

**插件 C（复杂转换）**

| 层 | 内容 |
|---|---|
| **Slot** | 同 A（文件选择器） |
| **Tool** | `attachment.upload(path)` → 检测类型 → 调「转换插件」→ 存 md → 返回 `attachmentId` |
| **Prompt** | 「附件已被转成 markdown 内容」 |
| **Event** | 同上 + `attachment.converted` |
| **Schema** | 同上（`Attachment` 带 `convertedFrom`） |
| **依赖** | `requires: ['com.example.convert']` |

### 3.2 用户视角

- 装 A → 附件按钮出现，AI 能收附件
- 换 B → 按钮变成「路径输入」，AI 拿到路径
- 换 C → 按钮回到文件选择器，但 AI 拿到的内容是转换后的 md
- **卸载任意一个** → 按钮消失，AI 不再知道「附件」这个概念

**切换插件 = 切换能力实现**。

---

## 4. 与 Tool / Pane / Service 的层次关系

### 4.1 分层图

```
┌─────────────────────────────────────────────────────────┐
│                    Capability                           │
│         （功能单元：UI + Tool + Prompt + 事件 + Schema）  │
└────────────┬────────────────────────────────┬───────────┘
             │                                │
             ▼                                ▼
     ┌──────────────┐                 ┌──────────────┐
     │   Slot       │                 │    Tool      │
     │ （插槽内容）  │                 │ （AI 可调）   │
     └──────┬───────┘                 └──────┬───────┘
            │                                │
            ▼                                ▼
     ┌──────────────┐                 ┌──────────────┐
     │  宿主 Pane    │                 │  Loop 服务   │
     │ （聊天框等）  │                 │  （AI）      │
     └──────────────┘                 └──────────────┘
```

**两个扩展点**：
- **Pane**：插件贡献独立窗口，用户拖到任意位置
- **Slot**：插件贡献插槽内容，宿主决定位置

**一个动作扩展点**：
- **Tool**：AI 可调动作，通常由 Capability 自动推导

### 4.2 一个 Capability 的生命周期

```
插件安装 → Core 注册 Capability → 
  ① Slot 贡献 → 宿主 Pane 渲染按钮
  ② Tool 注册 → Tool Registry 出现 attachment.upload
  ③ Prompt 片段 → Loop 组装 system prompt 时注入
  ④ Event 注册 → 总线可订阅 attachment.uploaded
  ⑤ Schema 扩展 → Message 类型加 attachments 字段

插件卸载 → Core 反注册 Capability → 
  ① Slot 消失 → 按钮立即消失
  ② Tool 移除 → Tool Registry 里消失
  ③ Prompt 片段消失 → 下一轮 system prompt 重组
  ④ Event 保留（历史数据可查，但不再产生）
  ⑤ Schema 保留（数据仍在，但 UI 不渲染）
```

---

## 5. 四个关键差异

### 差异一：UI 是能力的入口，不是固定布局

**之前**：Pane 契约——插件贡献一个独立窗口，用户拖到工作台。
**现在**：Capability 还可能贡献**插槽内容**——宿主决定位置，插件只提供内容。

**两个扩展点**：

```ts
// 扩展点 1：贡献一个 Pane（用户可自由布局）
definePane({ id, title, component })

// 扩展点 2：贡献一个插槽内容（宿主决定位置）
defineSlot('chat.composer.actions', AttachmentButton)
```

**Slot 是新的东西**。宿主（聊天 Pane）声明「我这里有插槽 `chat.composer.actions`」，插件往里塞。

**P1b 已有的 `definePane` 不够**——必须补 `defineSlot`。

### 差异二：System prompt 必须感知能力的存亡

**没装附件插件** → system prompt 里**不应出现**「你可以接收附件」这句话。

否则 LLM 会幻想用户在附件里放了东西。

**P3 的 `prompt.ts`**（Loop 的 system prompt 组装）需要从「常量」变成「能力清单的投影」：

```ts
function buildSystemPrompt(ctx: Container): string {
  const parts = [
    basePrompt,
    ...ctx.capabilities
      .filter(c => c.contributes?.systemPrompt)
      .map(c => resolvePromptFragment(c.contributes.systemPrompt))
  ]
  return parts.join('\n\n')
}
```

**装插件** → 重组 prompt → LLM 下一轮就知道。
**卸插件** → 片段消失 → LLM 不再假装能收。

### 差异三：Tool 是能力的投影

`attachment.upload` 这个 tool **不是插件作者手动注册的**，是能力的副产品。

- 装了 A → tool registry 里出现 `attachment.upload`（用 A 的实现）
- 卸了 A → tool 消失

**能力在位 → tool 在位；能力不在 → tool 不存在**。

Manifest 里**不应该写 `contributes.tools`**，应该写 `contributes.capabilities`——tool 由 Core 从 capability 自动导出。

### 差异四：消息 schema 本身是能力贡献的

`Message.attachments` 这个字段**不是 Core 定的**，是附件插件贡献的。

- 没装附件插件 → Message 没有 `attachments` 字段 → 序列化不会出现
- 装了 → Message 有这个字段 → LLM 能理解 → 前端能渲染

**这是最深的耦合：插件能改变数据模型本身**。

**实现方式**（候选）：
- **Zod schema merge**：Core 定义 base Message schema，插件注册 `schemaExtensions`，运行时合并
- **可选字段**：所有扩展字段都 optional，`Message.attachments?: Attachment[]`
- **动态类型**：TypeScript 用 declaration merging，运行时用宽松校验

**推荐**：**可选字段 + Zod merge**——简单、类型安全、不需要运行时类型推导。

---

## 6. 架构影响

### 6.1 Core 需要 Capability Registry

现有 registry：
- Service registry（P1a）
- Tool registry（P7）
- Pane registry（P1b，前端）

新增：
- **Capability registry**（Core）
- **Slot registry**（前端）
- **Schema extension registry**（Core / shared）

### 6.2 Loop 的 prompt 组装必须动态

**P3 的 `prompt.ts` 是常量，必须改为能力驱动的组装器**。

**不要求 P3 立即改**——P3 时 prompt 是常量可以接受。但**架构上要预留**——不要让 prompt 成为不可变的字符串。

**P3 的 `prompt.ts` 至少应该是一个函数**，即使它暂时返回常量：

```ts
// P3 版本（常量）
export function buildSystemPrompt(): string {
  return CONSTANT_PROMPT
}

// 能力化后（P5+ 或 Step 2）
export function buildSystemPrompt(ctx: Container): string {
  return [base, ...capabilities].join('\n\n')
}
```

### 6.3 前端需要 Slot 概念

**Slot 契约**：

```ts
// 宿主声明（聊天 Pane）
defineSlotHost('chat.composer.actions', { position: 'bottom-right', maxItems: 5 })

// 插件贡献
defineSlot('chat.composer.actions', AttachmentButton, { priority: 10 })
```

**Slot 与 Pane 的差异**：

| 维度 | Pane | Slot |
|---|---|---|
| 位置 | 用户决定 | 宿主决定 |
| 生命周期 | 用户开/关 | 宿主渲染时存在 |
| 内容 | 完整组件 | 通常是按钮/图标 |
| 布局 | 拖拽/换位 | 宿主布局 |

### 6.4 插件之间有能力依赖

插件 C 依赖「转换插件」。这意味着：

- Manifest 加 `requires: ['com.example.convert']`
- Core 加载顺序由依赖推导——**P1a 的 `inject` 已经做了这个**，能力依赖是它的延伸
- 卸载转换插件 → 依赖它的插件 C 自动禁用或告警

---

## 7. 生命周期

### 7.1 卸载能力意味着什么

**场景**：用户正在编辑消息，里面已附加两个文件。这时用户卸载附件插件。

**三个层次的问题**：

**① 已有数据的处置**

| 选项 | 含义 |
|---|---|
| A. **保留但不显示** | `attachments` 字段还在数据里，但 UI 不渲染（LLM 也不见）。重装后恢复 |
| B. 清空 | 卸载时删除所有 `attachments`。不可逆 |
| C. 冻结 | 提示用户「该会话有 2 个附件，卸载后不可见」，让用户决定 |

**推荐 A**——**数据不删，只是不可见**。这是「能力存在性」与「数据存在性」的分离。

**② UI 元素的处置**

**立即消失**——刷新后按钮没了。用户困惑？给一次 toast 提示「附件插件已卸载」。

**③ System prompt 的处置**

LLM 下一轮不该再说「你可以接收附件」。**在内存里立即重组 prompt**，不用重启 loop。

### 7.2 激活顺序

```
插件 A（附件）依赖插件 B（转换）
  → Core 拓扑排序：B 先激活，A 后激活
  → B 贡献 capability.convert
  → A 贡献 capability.attachment，引用 B 的 capability
```

**P1a 的拓扑排序逻辑**可以直接复用——依赖图从「服务依赖」扩展到「能力依赖」。

---

## 8. 落地三步

### Step 1（P1b 内）：加 `defineSlot` 扩展点

**P1b 已经有 `definePane`**（独立窗口）。补 `defineSlot`（宿主声明插槽、插件贡献内容）。

**第一个用例**：TopBar 右侧的「模式切换」按钮改为插槽贡献——`topbar.actions`。

**工作量**：约 +1 天。
**不涉及 Core 改动**——纯前端。
**验证点**：Slot registry 能注册、能渲染、能移除。

### Step 2（P3 后，P5 前）：Capability 抽象 + 第一个附件插件

**Core 加 `CapabilityRegistry`**：
- 注册 / 反注册能力
- 从 capability 自动导出 tool / slot / prompt / event / schema
- 能力依赖拓扑排序（复用 P1a 逻辑）

**附件插件作为第一个 Capability 实例**：
- Slot：`chat.composer.actions` 加附件按钮
- Tool：`attachment.upload`
- Prompt：片段注入
- Event：`attachment.uploaded`
- Schema：`Message.attachments`

**工作量**：约 +3-5 天（Core 扩展 + 附件插件）。

**验证点**：
- 装/卸附件插件，聊天框按钮同步出现/消失
- 装/卸时 system prompt 同步变（日志可查）
- Tool registry 同步变
- 已有消息的 `attachments` 卸载后不渲染，重装后恢复

### Step 3（P7 一并）：能力组合 + 依赖

**插件 C（复杂转换）依赖转换插件**：
- 能力依赖图
- 拓扑排序
- 卸载依赖时的降级处理

**工作量**：约 +2-3 天（与 P7 的工具管线共用基础设施）。

**验证点**：装 C 时若转换插件未装，C 显示「依赖未满足」占位。

---

## 9. 最小验证场景

**不需要大改架构。一个最小场景**：

1. **写一个「附件插件 A」（最简版）**：
   - Slot：`chat.composer.actions` 加一个「上传附件」按钮
   - Tool：`attachment.upload(path)` → 返回 attachmentId
   - Prompt 片段：「你可以接收附件」
   - Schema：`Message.attachments?: { id, name, size }[]`

2. **装它** → 按钮出现，AI 能收附件

3. **卸它** → 按钮消失，AI 说「我没有接收附件的功能」

**这个场景跑通，整个架构就验证了**。

**最小实现细节**：

- **Slot**：聊天 Pane（P3 的 ChatPane）声明 `chat.composer.actions` 插槽；附件插件注册按钮
- **Tool**：附件插件注册 `attachment.upload`，走 P7 之前的简化路径（直接注册到 tool registry，不经过 capability 自动导出）
- **Prompt**：P3 的 `prompt.ts` 从常量改为「读 capabilities 组装」
- **Schema**：`Message.attachments?` 可选字段，Zod schema 用 `.optional()`

**验证顺序**（不需要全做完才能测）：
1. 先做 Slot（P1b 内）→ 看到按钮出现/消失
2. 再做 Prompt 动态组装 → 装/卸时日志能看到 prompt 变化
3. 再做 Tool 投影 → tool registry 同步变化
4. 最后做 Schema → 消息里出现/消失 attachments

---

## 10. 边界与非目标

**本期明确不做**：

- ❌ 能力的自动发现（能力由插件显式声明）
- ❌ 能力的热插拔（本期卸载需要重启服务，与 P1a 一致）
- ❌ 能力间通信的抽象（能力间通过总线通信，不引入新机制）
- ❌ 能力的权限控制（远期，与插件权限同阶段）
- ❌ 能力的市场 / 分享（远期）

**远期考虑**：

- 能力版本管理（插件升级时能力接口的兼容性）
- 能力依赖的强校验（manifest 里 requires 的能力必须在位）
- 能力的 A/B 测试（同一能力位挂两个实现，用户切换）
- 能力的使用统计（哪个能力被 AI 调用最多）

---

## 11. 开放问题

1. **Capability 和插件是一对一还是一对多？**
   建议**一对多**——一个插件可以贡献多个 capability（如「附件插件」贡献 `attachment` + `attachment.convert`）。但要防止过度拆分。

2. **Slot 的位置谁定？**
   建议**宿主定**——宿主声明 `defineSlotHost('chat.composer.actions', { position })`；插件只提供内容，不关心位置。这样宿主改布局不需要改插件。

3. **Schema 扩展的冲突处理？**
   建议**不允许冲突**——两个插件都扩展 `Message.attachments` 时拒绝第二个注册（fail fast）。如需覆盖，用命名空间 `Message.extAttachments` 之类。

4. **能力卸载时的数据是否级联？**
   建议**不级联**——数据保留，只是不可见。用户手动清理数据的操作归远期「数据管理」Pane。

5. **Prompt 片段是否有顺序？**
   建议**有**——用 `priority` 字段。core prompt 优先级最高，能力 prompt 按优先级排序。

6. **能力依赖是否要求 P7 先做工具管线？**
   建议**不要求**——最小验证场景可以绕过完整工具管线（直接注册 tool）。P7 时再把能力化路径打通。

---

## 12. 一句话总结

> **Tool 是 AI 能做的动作；Capability 是系统的功能单元（UI + Tool + Prompt + 事件 + 数据模型）。**
>
> **没装附件插件，不是「附件功能可选」，是「附件这个功能不存在」——按钮没有、prompt 没有、tool 没有、数据字段没有。**
>
> **这比「一切皆插件」更深一层：不只是功能是插件，是功能的存在性由插件决定。**
>
> **落地三步：P1b 加 `defineSlot` → P3 后加 Capability 抽象 + 第一个附件插件 → P7 加能力组合。最小验证场景：一个最简附件插件的装/卸。**
>
> **这个设想如果落实，Osteosome 和之前所有插件式应用都不同——用户装什么插件，就有什么能力的 Agent。**

---

## 附录 A · 与现有文档的关系

| 文档 | 关系 |
|---|---|
| `ost-开发文档.md` §11（前端工作台） | 本文的 Slot 扩展是 Pane 之外的**第二类 UI 扩展点** |
| `ost-开发文档.md` §17（前端技术选型） | 本文不涉及技术选型，只涉及扩展点设计 |
| `ost-聚合设计备忘.md` | 聚合解决「工具从哪来」，本文解决「功能如何组装」——互补 |
| `P1b-详细计划.md` | Step 1（`defineSlot`）在 P1b 内加 |
| `P3-详细计划.md` | Step 2 依赖 P3 的 prompt 组装改为函数形式 |
| `P7-详细计划.md` | Step 3 与 P7 的工具管线共用基础设施 |

## 附录 B · 术语

| 术语 | 定义 |
|---|---|
| **Capability（能力）** | 系统的功能单元：UI 插槽 + Tool + Prompt + 事件 + 数据模型 的组合 |
| **Tool（工具）** | AI 可以调的一个动作（read_file / web_search 等） |
| **Pane（窗）** | 插件贡献的独立窗口，用户拖到任意位置 |
| **Slot（插槽）** | 插件贡献的 UI 内容，宿主决定位置 |
| **能力位** | `capability.<name>`——一个逻辑位置，同一时刻只有一个实现 |
| **能力贡献** | 插件在 manifest 里声明的 capabilities 列表 |
| **能力投影** | Tool / Slot / Prompt / Event / Schema 都是能力的投影 |
| **纯知识型 Skill** | 只有 markdown，注入 system prompt，不进 tool registry |
| **工具型 Skill** | 带 scripts，脚本变 tool + 说明注入 |

## 附录 C · 附件三插件的对比表

| 维度 | 插件 A（普通上传） | 插件 B（本地路径） | 插件 C（复杂转换） |
|---|---|---|---|
| **能力位** | `capability.attachment` | `capability.attachment` | `capability.attachment` |
| **UI（Slot）** | 文件选择器按钮 | 路径输入按钮 | 文件选择器按钮 |
| **Tool** | `attachment.upload(path)` | `attachment.upload_path(path)` | `attachment.upload(path)` |
| **Prompt 片段** | 「附件以引用形式出现」 | 「附件是本地路径」 | 「附件已转成 md」 |
| **事件** | `attachment.uploaded` | 同 | 同 + `attachment.converted` |
| **Schema** | `Message.attachments` | 同（字段不同：`path`） | 同（带 `convertedFrom`） |
| **依赖** | — | — | `requires: ['com.example.convert']` |
| **用户感知** | 上传后 AI 看到引用 | AI 看到路径，自己读 | AI 看到 md 内容 |

**三个插件占据同一能力位**——用户装哪个，系统就表现为哪种能力。**切换插件 = 切换能力实现**。
```

---

已落盘为独立文档。几点说明：

1. **定位为「设计备忘」不是「正式 RFC」**——和聚合文档一致，讨论还在收敛，等 P1b/P3 开工时再决定是否升级。
2. **明确它不推翻现有规划**——`ost-开发文档.md` / P1a-P8 都不动，本文只加一层。
3. **落地三步走写得很具体**——Step 1 在 P1b 内加 `defineSlot`（+1 天）；Step 2 在 P3 后 P5 前加 Capability 抽象 + 第一个附件插件（+3-5 天）；Step 3 与 P7 一并（+2-3 天）。
4. **最小验证场景落在「最简附件插件」**——不需要大改架构就能验证整个思路。
5. **附录 C 是三插件的对比表**——你把 A/B/C 三个例子说清楚了，文档里就该有对照。

