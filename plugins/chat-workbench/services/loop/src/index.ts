/**
 * loop 服务入口（P3 WS-3）—— 装配：loop.run → 先落 user 消息 → 发 llm.request → 流式回填 → message.append。
 *
 * - **唯一写者**：assistant 消息只经 loop（in-flight 累积、finish 时 append）；user 消息先落库再发 llm.request。
 * - **requestId 分层**：A = loop.run（前端只见 A），B = llm.request 内部 id；映射只活在 loop 进程。
 * - **只吃总线**：不直读 session 文件，经 `session.*` 命令 + `*.result` 拿历史（服务间唯一通道 = 总线）。
 * - **参数透传**（P4 WS-2）：`loop.run` 的 `provider` / `model` / `thinking` 一路带进 `llm.request`。
 */
import { Service, logger } from '@osteosome/service-sdk'
import {
  normalizeThinking,
  SKILL_INDEX_BUDGET_BYTES,
  SKILL_INDEX_MAX_ENTRIES,
  skillsIndexText,
  utf8Bytes,
  type SkillIndexEntry,
  type ThinkingEffort,
  type ToolCall,
  type ToolRecord,
  type ToolRisk,
  type ToolSpec,
} from '@osteosome/shared'
import { randomUUID } from 'node:crypto'
import { LoopCore, type ChatTurn } from './core'
import { buildMessages, DEFAULT_MAX_MESSAGES, type HistoryMessage } from './history'
import { assembleSystemPrompt, DEFAULT_SYSTEM_PROMPT, type PromptFragment } from './prompt'

const service = new Service({ id: 'loop', version: '1.0.0' })

/** A → { sessionId }（loop.run 时记，finish/fail 后发 state.changed 用） */
const sessionsByA = new Map<string, string>()
/** historyReq（session.get 命令 id）→ A（关联多轮历史拉取往返） */
const historyReqByRun = new Map<string, string>()

/**
 * 目标 provider（P4 WS-2：`loop.run` 可逐次指定；缺省回落 env → deepseek）。
 * 测试与冒烟经 LLM_PROVIDER 指向本地假上游（openai 位）。
 */
const DEFAULT_PROVIDER = process.env.LLM_PROVIDER?.trim() || 'deepseek'

/**
 * 工具目录 = **各执行者登记的并集**（来自 `tools.state`）—— loop 手里**不留路径/不留实现**。
 *
 * ## 为什么不再有 tool-root
 *
 * M3 之前 loop 进程内有一套最小工具（`read_file`/`list_dir`），沙箱 = 插件自己的 `tool-root/`。
 * M3 把工具执行外包给各执行者进程：loop 只**查表派发** —— 目录来自 `tools.state`，
 * 执行走 `tool.execute` 往返。沙箱由执行者按传入的 `workspaces` 自己判断（loop 不持有路径）。
 *
 * ## 缺失是合法的
 *
 * 没装 tools 插件 → 收不到 `tools.state` → 目录为空 → 模型没有工具，对话照常。
 */
let TOOL_SPECS: ToolSpec[] = []
/** name → risk（用于硬超时分档与工作区审批的 payload） */
const riskByName = new Map<string, ToolRisk>()

service.subscribe('tools.state', (payload) => {
  const tools = (payload as { tools?: unknown } | null)?.tools
  if (!Array.isArray(tools)) return
  const records = tools as ToolRecord[]
  TOOL_SPECS = records
    .filter((t) => t.enabled !== false && t.conflict !== true)
    .map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }))
  riskByName.clear()
  for (const t of records) if (t.name) riskByName.set(t.name, t.risk)
})

/**
 * 工具轮上限（P7）：一轮里模型最多连续发起 N 次工具调用。
 * 防「模型反复调同一个工具」的无限循环（N 次后以 `tool_loop_limit` 失败并落已发生的消息）。
 */
const MAX_TOOL_ROUNDS = Number(process.env.LLM_MAX_TOOL_ROUNDS ?? 5)

/** requestId（B）→ 本轮解析出的工具调用（`llm.request.tool_call` 累积） */
const toolCallsByB = new Map<string, ToolCall[]>()
/** A → 已完成的工具轮数（防无限循环） */
const toolRoundsByA = new Map<string, number>()

// ── 跨进程工具执行（M3）──────────────────────────────────────────
/** toolCallId → 结果结算（等 tool.execute.result） */
const toolResultPending = new Map<string, (r: { ok: boolean; content: string; summary: string; escape?: { requestedPath: string; permissionRoot: string } }) => void>()
/** toolCallId → 工作区审批结算（等 tool.approval.resolved） */
const workspaceApprovalPending = new Map<string, (approved: boolean) => void>()
/** A → 本轮的沙箱根（workspace 排第一；从 session.get.result 取，session.updated 更新） */
const workspacesByA = new Map<string, string[]>()
/** 硬超时分档（M3）：按 risk */
const RISK_TIMEOUT_MS: Record<ToolRisk, number> = { read: 15_000, net: 60_000, write: 60_000, proc: 120_000 }

service.subscribe('tool.execute.result', (payload) => {
  const id = typeof payload.requestId === 'string' ? payload.requestId : ''
  const settle = id ? toolResultPending.get(id) : undefined
  if (!settle) return
  toolResultPending.delete(id)
  const escape = payload.escape as { requestedPath?: unknown; permissionRoot?: unknown } | undefined
  settle({
    ok: payload.ok === true,
    content: typeof payload.content === 'string' ? payload.content : '',
    summary: typeof payload.summary === 'string' ? payload.summary : '',
    ...(escape && typeof escape.requestedPath === 'string' && typeof escape.permissionRoot === 'string'
      ? { escape: { requestedPath: escape.requestedPath, permissionRoot: escape.permissionRoot } }
      : {}),
  })
})

service.subscribe('tool.approval.resolved', (payload) => {
  const id = typeof payload.requestId === 'string' ? payload.requestId : ''
  const settle = id ? workspaceApprovalPending.get(id) : undefined
  if (!settle) return
  workspaceApprovalPending.delete(id)
  settle(payload.approved === true)
})

// 中途新增授权根（工作区审批批准后 loop 自己发的 session.set.workspace）→ 更新本地副本
service.subscribe('session.updated', (payload) => {
  const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId : ''
  const ws = Array.isArray(payload.workspaces) ? (payload.workspaces as unknown[]).filter((w): w is string => typeof w === 'string') : null
  const root = typeof payload.workspace === 'string' ? payload.workspace : ''
  if (!sessionId) return
  for (const [a, sid] of sessionsByA) {
    if (sid !== sessionId) continue
    const merged = [root, ...(ws ?? [])].filter((x) => x !== '')
    if (merged.length > 0) workspacesByA.set(a, [...new Set(merged)])
  }
})

/** 发一次 tool.execute 并等结果；超时 → 失败结果（不留幽灵） */
function dispatchToolExecute(call: ToolCall, sessionId: string, workspaces: string[], timeoutMs: number): Promise<{ ok: boolean; content: string; summary: string; escape?: { requestedPath: string; permissionRoot: string } }> {
  service.publish('tool.execute', {
    requestId: call.id,
    sessionId,
    name: call.name,
    arguments: call.arguments,
    workspaces,
  })
  return new Promise((resolve) => {
    toolResultPending.set(call.id, resolve)
    setTimeout(() => {
      if (toolResultPending.delete(call.id)) {
        resolve({ ok: false, content: `工具 ${call.name} 超时（${timeoutMs / 1000}s）`, summary: '工具超时' })
      }
    }, timeoutMs)
  })
}

/**
 * 执行一次工具调用（M3）—— 走总线，不碰 loop 进程内任何实现。
 *
 * 越界（`escape`）→ 发起 `kind:'workspace'` 审批；批准 → `session.set.workspace{addRoot}`
 * → **重派同一 `call.id`**（前提：执行者路径校验在任何副作用之前，故幂等）。拒绝/超时 → 失败回填。
 */
async function executeToolCall(call: ToolCall, sessionId: string, workspaces: string[]): Promise<{ ok: boolean; content: string; summary: string }> {
  const risk = riskByName.get(call.name) ?? 'read'
  const first = await dispatchToolExecute(call, sessionId, workspaces, RISK_TIMEOUT_MS[risk])
  if (first.ok || !first.escape) return first

  // 越界 → 工作区审批
  const { requestedPath, permissionRoot } = first.escape
  service.publish('tool.approval.requested', {
    requestId: call.id,
    sessionId,
    toolName: call.name,
    risk,
    arguments: call.arguments,
    kind: 'workspace',
    requestedPath,
    permissionRoot,
    rationale: `工具 '${call.name}' 想访问工作区之外的路径`,
  })
  const approved = await new Promise<boolean>((resolve) => {
    workspaceApprovalPending.set(call.id, resolve)
    setTimeout(() => {
      if (workspaceApprovalPending.delete(call.id)) resolve(false)
    }, 120_000)
  })
  if (!approved) {
    return { ok: false, content: `路径 '${requestedPath}' 越出工作区，用户未授权`, summary: '越界未授权' }
  }
  // 授权根加入会话工作区，再重派同一 T（幂等：越界发生在任何副作用之前）
  service.publish('session.set.workspace', { requestId: `wsa-${call.id}`, sessionId, addRoot: permissionRoot })
  const nextWorkspaces = [...new Set([...workspaces, permissionRoot])]
  return dispatchToolExecute(call, sessionId, nextWorkspaces, RISK_TIMEOUT_MS[risk])
}

/**
 * 本次 run 的请求参数（P4 WS-2）。
 *
 * loop 同时只跑一轮（`core.isBusy()` 重入守卫），所以装配层用模块级「当前 run 参数」即可，
 * 不必把参数穿进 LoopCore 状态机（LoopCore 只认 model —— 它 P3 就有 `start(b, msgs, model?)` 形参）。
 * accept 时写，start（拿到历史后）时读。
 */
let currentParams: { provider?: string; model?: string; thinking?: ThinkingEffort } = {}

/**
 * 已注册的提示词片段（P5）：`key = pluginId\u0000id` 去重；装配时按 (priority,id) 排。
 * 由各服务 publish `prompt.fragment.registered`（角色那份 id = `role:<id>`）。
 */
const fragments = new Map<string, PromptFragment>()
/** 本次 run 选的角色（决定纳入哪条 `role:*` 片段）；loop 同时只跑一轮 */
let currentCharacterId = ''

/**
 * 本次 run 的 p10 技能索引文本（由 `skills.list{characterId}` 的响应算出来）。
 *
 * 空串 = 裸会话（没角色 → 不注入 p10）或技能服务缺失。**索引片段随角色解析一起算**，
 * 不是静态 publish 的一份 —— 这样「索引里看得见的技能」与「角色绑定」在服务端就 AND 好了
 * （见技能设计稿 §2：否则会出现「看见→去读→被拒，原因用户看不到」）。
 */
let currentSkillsText = ''

/** 在途的 skills.list 请求：等待 `skills.list.result` 后放行本轮 */
interface PendingSkills {
  proceed: (skillsText: string) => void
  timer: NodeJS.Timeout
}
const pendingSkills = new Map<string, PendingSkills>()
/** 两次 run 之间在等 skills 的窗口里也要拒重入 */
let setupPending = false
/** skills 应答超时（服务没装 / 卡住）→ 放行空索引，不卡住这一轮 */
const SKILLS_TIMEOUT_MS = 1500

/**
 * 索引片段预算闸门（8 KB / 20 条）：超了**整块丢弃**（不静默截断），
 * 与技能设计稿 §2「先看到字节，因为它先到」一致。
 */
function gatedSkillsText(entries: readonly SkillIndexEntry[]): string {
  const enabled = entries.filter((e) => e.enabled)
  if (enabled.length === 0) return ''
  const bytes = enabled.reduce((n, e) => n + utf8Bytes(`${e.name}: ${e.description}`), 0)
  if (enabled.length > SKILL_INDEX_MAX_ENTRIES || bytes > SKILL_INDEX_BUDGET_BYTES) {
    logger.warn(
      `loop: p10 技能索引超预算（${enabled.length} 条 / ${bytes} B），整块丢弃，本轮模型看不到技能`,
    )
    return ''
  }
  return skillsIndexText(enabled)
}

/** 每轮重算的 system prompt（历史里的 system 一律丢弃，所以装卸/切角色立即生效） */
function currentSystemPrompt(): string {
  const base = assembleSystemPrompt(DEFAULT_SYSTEM_PROMPT, [...fragments.values()], currentCharacterId)
  return currentSkillsText ? `${base}\n\n可用技能（用 skill_read 读正文）：\n${currentSkillsText}` : base
}

service.subscribe('prompt.fragment.registered', (payload) => {
  const pluginId = typeof payload.pluginId === 'string' ? payload.pluginId : ''
  const id = typeof payload.id === 'string' ? payload.id : ''
  if (!pluginId || !id) return
  fragments.set(`${pluginId}\u0000${id}`, {
    pluginId,
    id,
    priority: typeof payload.priority === 'number' ? payload.priority : 0,
    text: typeof payload.text === 'string' ? payload.text : '',
  })
})

service.subscribe('prompt.fragment.unregistered', (payload) => {
  const pluginId = typeof payload.pluginId === 'string' ? payload.pluginId : ''
  const id = typeof payload.id === 'string' ? payload.id : ''
  if (pluginId && id) fragments.delete(`${pluginId}\u0000${id}`)
})

const core = new LoopCore({
  sendLlmRequest(b, sessionId, messages, model) {
    service.publish('llm.request', {
      requestId: b,
      provider: currentParams.provider ?? DEFAULT_PROVIDER,
      messages,
      ...(model ? { model } : {}),
      ...(currentParams.thinking ? { thinking: currentParams.thinking } : {}),
      // P7：下发工具目录，模型才可能发起 tool_calls（中立形状，wire 由 provider 翻）
      ...(TOOL_SPECS.length > 0 ? { tools: TOOL_SPECS } : {}),
    })
  },
  sendLlmCancel(b) {
    service.publish('llm.cancel', { requestId: b })
  },
})

function newB(): string {
  return `loop-${randomUUID().replace(/-/g, '').slice(0, 16)}`
}

service.subscribe('loop.run', (payload) => {
  const a = typeof payload.requestId === 'string' ? payload.requestId : ''
  const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId : ''
  const text = typeof payload.text === 'string' ? payload.text.trim() : ''
  // P4 WS-2：本次 run 的 provider / model / thinking（非法 thinking 静默丢弃 = 用模型默认）
  const runParams = {
    ...(typeof payload.provider === 'string' && payload.provider ? { provider: payload.provider } : {}),
    ...(typeof payload.model === 'string' && payload.model ? { model: payload.model } : {}),
    ...(normalizeThinking(payload.thinking) ? { thinking: normalizeThinking(payload.thinking) as ThinkingEffort } : {}),
  }
  // P5：本次 run 选的角色 → 装配器据此纳入 `role:<id>` 那份提示词片段（缺省 = 裸会话）
  const characterId = typeof payload.characterId === 'string' ? payload.characterId : ''

  const fail = (code: string, message: string) => {
    service.publish('loop.run.failed', { requestId: a, sessionId, error: { code, message } })
    service.publish('loop.state.changed', { requestId: a, sessionId, state: 'idle' })
  }

  if (!a || !sessionId || !text) {
    fail('invalid_request', 'loop.run: requestId, sessionId and text are required')
    return
  }
  // 重入拒绝（P3 §6：running 中重复 run → busy；等 skills 的窗口也算占位）
  if (core.isBusy() || setupPending) {
    fail('busy', 'loop is running')
    return
  }

  // 1) 先落 user 消息（不等 llm 响应，会话里立即可见）
  service.publish('message.append', { requestId: `mu-${a}`, sessionId, message: { role: 'user', content: text } })

  // 2) 受理 run 的公共尾：占位防重入 → 发 session.get 拉历史；拿到 result 后才 start(B)
  const proceed = (skillsText: string): void => {
    setupPending = false
    if (!core.accept(a, sessionId, text)) {
      fail('busy', 'loop is running')
      return
    }
    currentParams = runParams
    currentCharacterId = characterId
    currentSkillsText = skillsText
    const historyReq = `hg-${a}`
    historyReqByRun.set(historyReq, a)
    sessionsByA.set(a, sessionId)
    service.publish('session.get', { requestId: historyReq, sessionId })
    service.publish('loop.state.changed', { requestId: a, sessionId, state: 'running' })
  }

  // 3) 角色轮：先按角色要技能索引（p10）。AND 在 skills 服务端成立；超时/缺服务 → 放行空索引
  if (characterId) {
    setupPending = true
    const skillsReq = `sk-${a}`
    const timer = setTimeout(() => {
      const pending = pendingSkills.get(skillsReq)
      if (!pending) return
      pendingSkills.delete(skillsReq)
      pending.proceed('')
    }, SKILLS_TIMEOUT_MS)
    pendingSkills.set(skillsReq, { proceed, timer })
    service.publish('skills.list', { requestId: skillsReq, characterId })
    return
  }
  proceed('')
})

// skills.list.result（关联 skillsReq）→ 放行本轮（p10 由角色过滤后的索引算出来）
service.subscribe('skills.list.result', (payload) => {
  const requestId = typeof payload.requestId === 'string' ? payload.requestId : ''
  const pending = requestId ? pendingSkills.get(requestId) : undefined
  if (!pending) return
  pendingSkills.delete(requestId)
  clearTimeout(pending.timer)
  const skills = Array.isArray(payload.skills) ? (payload.skills as SkillIndexEntry[]) : []
  pending.proceed(gatedSkillsText(skills))
})

// session.get.result（关联 historyReq）→ 拼多轮 → core.start(B) → 发 llm.request
service.subscribe('session.get.result', (payload) => {
  const p = payload as {
    requestId?: string
    session?: { messages?: unknown[]; meta?: { workspace?: string; workspaces?: string[] } } | null
    error?: { code?: string; message?: string }
  }
  const a = p?.requestId ? historyReqByRun.get(p.requestId) : undefined
  if (!a) return // 非本次历史拉取（或已释放/已取消）
  historyReqByRun.delete(p.requestId!)

  // P7 M0：本轮沙箱根 = workspace ∪ workspaces（workspace 排第一）
  const meta = p?.session?.meta
  if (meta) {
    const ws = [meta.workspace ?? '', ...(meta.workspaces ?? [])].filter((x) => x !== '')
    workspacesByA.set(a, [...new Set(ws)])
  }

  // 兜底1：session.get 报错（会话不存在等）→ 用本轮 text 跑一问一答，不卡在 running
  if (p?.error) {
    const messages = buildMessages([{ role: 'user', content: core.awaitingRun()?.text ?? '' }], currentSystemPrompt(), DEFAULT_MAX_MESSAGES)
    core.start(newB(), messages, currentParams.model)
    return
  }

  // 兜底2：session 为 null（会话已被删）→ 同样用本轮 text 跑一问一答
  // 正常路径：历史已含 loop.run 先落库的 user 消息（末尾），buildMessages 直接用完整历史
  const history = (p?.session?.messages ?? []) as HistoryMessage[]
  const messages = buildMessages(history, currentSystemPrompt(), DEFAULT_MAX_MESSAGES)

  core.start(newB(), messages, currentParams.model)
})

// llm.token.streamed（B）→ 累积 + 换发 A（P3 §3.4：B 不泄前端）
service.subscribe('llm.token.streamed', (payload) => {
    const b = typeof payload.requestId === 'string' ? payload.requestId : ''
    const token = typeof payload.token === 'string' ? payload.token : ''
    const index = typeof payload.index === 'number' ? payload.index : 0
    // S4：块类型透传。缺省 'text' —— 老版本 llm 主位不发这个字段，不能因此丢正文
    const blockType = payload.blockType === 'reasoning' ? 'reasoning' : 'text'
    // 分流累积：reasoning 进独立缓冲，不进正文
    const a = core.onToken(b, token, blockType)
    if (!a) return
    const sessionId = sessionsByA.get(a) ?? ''
    // 换发：requestId 换成 A，index 保留 llm 原值（P3 §3.4），blockType 原样带过去
    service.publish('loop.token.streamed', { requestId: a, sessionId, token, index, blockType })
})

// llm.request.tool_call（B）→ 累积本轮工具调用（主位已按块拼装完整 name+arguments）
service.subscribe('llm.request.tool_call', (payload) => {
  const b = typeof payload.requestId === 'string' ? payload.requestId : ''
  const call = payload.toolCall as ToolCall | undefined
  if (!b || !call || typeof call.id !== 'string' || typeof call.name !== 'string') return
  const list = toolCallsByB.get(b) ?? []
  list.push({ id: call.id, name: call.name, arguments: typeof call.arguments === 'string' ? call.arguments : '{}' })
  toolCallsByB.set(b, list)
})

// llm.request.finished（B）→ 取 A + 累积全文 → message.append(assistant) → state idle
service.subscribe('llm.request.finished', (payload) => {
  const b = typeof payload.requestId === 'string' ? payload.requestId : ''
  const finishReason = typeof payload.finishReason === 'string' ? payload.finishReason : 'stop'
  const usage = payload.usage as { promptTokens: number; completionTokens: number } | undefined
  const toolCalls = toolCallsByB.get(b) ?? []
  toolCallsByB.delete(b)

  // P7：finishReason=tool_calls → 走工具轮（不落终态 assistant、不发 idle，run 继续）
  if (finishReason === 'tool_calls' && toolCalls.length > 0) {
    void runToolRound(b, toolCalls)
    return
  }

  const done = core.finish(b, finishReason, usage)
  if (!done) return
  const sessionId = sessionsByA.get(done.a) ?? done.sessionId
  // 落 assistant 全文（finishReason/usage 带上）
    service.publish('message.append', {
      requestId: `ma-${done.a}`,
      sessionId,
      message: {
        role: 'assistant',
        content: done.content,
        // S4：思维链单独存，`content` 里没有它（S5 据此渲染可折叠思考块）
        ...(done.reasoning ? { reasoning: done.reasoning } : {}),
        finishReason: done.finishReason,
        ...(done.usage ? { usage: done.usage } : {}),
      },
    })
  service.publish('loop.state.changed', { requestId: done.a, sessionId, state: 'idle' })
  releaseRun(done.a)
})

/**
 * 工具轮（P7）：模型发起工具调用 → 逐个执行 → `role:'tool'` 回填 → 再发一轮 `llm.request`。
 *
 * 顺序与落库：
 * 1. assistant 消息落库（带 `toolCalls`，模型下一轮要看到自己发起过什么）；
 * 2. 每个工具结果落一条 `role:'tool'` 消息（带 `toolCallId`），并发 `loop.tool.executed` 供 UI 渲染；
 * 3. `core.nextRound(旧B, 新B, messages)` —— 复用刚落库的消息作为下一轮上下文，
 *    state 保持 running（不发 idle），前端不会误判结束。
 *
 * 工具**顺序执行**：P3 的设计取舍（可预测 + 结果与 tool_calls 顺序一致）；并行执行属 P7 后续。
 */
async function runToolRound(oldB: string, toolCalls: ToolCall[]): Promise<void> {
  const a = core.currentA(oldB)
  if (!a) return // 已取消/未知 B
  const sessionId = sessionsByA.get(a) ?? ''
  const rounds = (toolRoundsByA.get(a) ?? 0) + 1
  toolRoundsByA.set(a, rounds)

  // 本轮 assistant 全文（工具轮通常是空正文，但模型可能同时说了一句）
    const { content: assistantContent, reasoning: assistantReasoning } = core.peek(oldB)

  if (rounds > MAX_TOOL_ROUNDS) {
    // 超限：把已发生的 assistant 落库后失败退出（不静默吞掉，也不无限跑）
    if (assistantContent !== '' || toolCalls.length > 0) {
      service.publish('message.append', {
        requestId: `ma-${a}`,
        sessionId,
        message: {
          role: 'assistant',
          content: assistantContent,
          ...(assistantReasoning ? { reasoning: assistantReasoning } : {}),
          finishReason: 'tool_calls',
          toolCalls,
        },
      })
    }
    core.finish(oldB, 'stop')
    service.publish('loop.run.failed', {
      requestId: a,
      sessionId,
      error: { code: 'tool_loop_limit', message: `工具轮超过上限 ${MAX_TOOL_ROUNDS} 次，已中止` },
    })
    service.publish('loop.state.changed', { requestId: a, sessionId, state: 'idle' })
    releaseRun(a)
    return
  }

  // 1) assistant 消息（含 toolCalls）落库
  service.publish('message.append', {
    requestId: `ma-${a}`,
    sessionId,
    message: {
      role: 'assistant',
      content: assistantContent,
      ...(assistantReasoning ? { reasoning: assistantReasoning } : {}),
      finishReason: 'tool_calls',
      toolCalls,
    },
  })

  // 2) 逐个执行工具（M3：跨进程，走 tool.execute 往返）→ 落 role:'tool' 结果
  const turns: ChatTurn[] = [
    { role: 'assistant', content: assistantContent, toolCalls },
  ]
  const workspaces = workspacesByA.get(a) ?? []
  for (const call of toolCalls) {
    const result = await executeToolCall(call, sessionId, workspaces)
    service.publish('loop.tool.executed', {
      requestId: a,
      sessionId,
      toolCallId: call.id,
      name: call.name,
      arguments: call.arguments,
      ok: result.ok,
      summary: result.summary,
    })
    service.publish('message.append', {
      requestId: `tr-${a}-${call.id}`,
      sessionId,
      message: {
        role: 'tool',
        content: result.content,
        toolCallId: call.id,
        toolName: call.name,
      },
    })
    turns.push({ role: 'tool', content: result.content, toolCallId: call.id })
  }

  // 3) 续跑下一轮（state 仍 running）
  const nextB = newB()
  core.nextRound(oldB, nextB, [
    { role: 'system', content: currentSystemPrompt() },
    ...turns,
  ], currentParams.model)
}

/** 一次 run 彻底结束（成功/失败/取消）后清 A 相关状态 */
function releaseRun(a: string): void {
  sessionsByA.delete(a)
  toolRoundsByA.delete(a)
  workspacesByA.delete(a)
}

// llm.request.failed（B）→ loop.run.failed(A) + state idle，不落 assistant
service.subscribe('llm.request.failed', (payload) => {
  const b = typeof payload.requestId === 'string' ? payload.requestId : ''
  const error = payload.error as { code?: string; message?: string } | undefined
  const failed = core.fail(b)
  if (!failed) return
  const sessionId = sessionsByA.get(failed.a) ?? failed.sessionId
  service.publish('loop.run.failed', {
    requestId: failed.a,
    sessionId,
    error: { code: error?.code ?? 'unknown', message: error?.message ?? 'llm failed' },
  })
  service.publish('loop.state.changed', { requestId: failed.a, sessionId, state: 'idle' })
  releaseRun(failed.a)
})

// loop.cancel（A）→ 在途：llm.cancel(B)（等 finish{stop} 收尾）；awaiting：直接清占位发 run.cancelled
service.subscribe('loop.cancel', (payload) => {
  const a = typeof payload.requestId === 'string' ? payload.requestId : ''
  if (!a) return
  // awaiting 阶段（等 session.get 还没发 llm.request）：直接收尾
  const cancelledEarly = core.cancelAwaiting(a)
  if (cancelledEarly) {
    const sessionId = sessionsByA.get(a) ?? cancelledEarly.sessionId
    service.publish('loop.run.cancelled', { requestId: a, sessionId })
    service.publish('loop.state.changed', { requestId: a, sessionId, state: 'idle' })
    releaseRun(a)
    return
  }
// 在途 → llm.cancel(B)（provider abort → finish{stop} 收尾，状态机仍走 finished 分支）
  // 不在途 → 已结束，清残留的工具轮计数
  const cancelling = core.cancel(a)
  toolRoundsByA.delete(a)
  if (!cancelling) releaseRun(a)
})

async function main(): Promise<void> {
  await service.start()
  // 用 SDK logger（写 stderr）而不是 console.log（写 stdout）：
  // Core 只转发子进程的 stderr（manager.ts 的 logServiceStderr），stdout 是 stdio JSON-RPC 的协议流。
  // 所以 console.log 写的这行在 Core 日志里**根本看不到**。
  logger.info('loop: ready（工具目录来自 tools.state；执行走 tool.execute 往返）')
  // P5：请各插件重播 prompt 片段
  service.publish('prompt.fragments.list', {})
  // P7 M3：请各执行者重播工具目录（晚启动的 loop 才看得到工具）
  service.publish('tools.list', {})
}

main().catch((err: unknown) => {
  console.error(`loop: failed to start: ${String(err)}`)
  process.exit(1)
})
