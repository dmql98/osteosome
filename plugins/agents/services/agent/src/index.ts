/**
 * agent 服务入口（P5 WS-1）—— 角色目录 + 装配配方 + 提示词片段。
 *
 * ## 它只做一件事：把「角色」这份用户数据解析成一组绑定
 *
 * - **目录**：`agent.state` 重播整份（composer 下拉 + widget.agents 的数据源）
 * - **配方**：`agent.resolve` → `agent.resolve.result`（两跳；总线不提供返回值）
 * - **片段**：每个有 prompt 的角色注册 `role:<id>`（priority 5）到既有的
 *   `prompt.fragment.*` —— **和 reliability 插件发的那条一模一样**，loop 侧零新增机制
 *
 * ## 缺失是合法的
 *
 * 空 prompt 的角色**不注册片段**（它对模型而言没有身份，回落裸会话）；
 * 引用不存在的技能/工具不在这里判 —— 那是装配器与各自服务的事（标悬空引用）。
 *
 * ## dataDir 红线
 *
 * store 必须在 `await service.start()` 之后建：之前 `service.dataDir` 恒为 `''`，
 * 退到相对路径就是会话服务「487 条写进 dist/」的同款事故。拿不到就 fail fast。
 */
import { Service, logger } from '@osteosome/service-sdk'
import {
  characterFragmentId,
  hasInjectablePrompt,
  ROLE_FRAGMENT_PRIORITY,
  toRecipe,
  type AgentStatePatch,
} from '@osteosome/shared'
import { CharacterStore } from './store'

const PLUGIN_ID = 'agents'
const service = new Service({ id: 'agent', version: '1.0.0' })

let store: CharacterStore | null = null

/** 当前已注册片段的角色 id 集合（用于 diff 出「要注销」的） */
const registered = new Set<string>()

/** 所有「有 prompt 的角色」→ 片段 id + 文本 */
function desiredFragments(): Map<string, string> {
  const out = new Map<string, string>()
  if (!store) return out
  for (const c of store.list()) {
    if (hasInjectablePrompt(c)) out.set(c.id, c.prompt)
  }
  return out
}

/**
 * 让总线上的片段集合与目录一致，并**顺带重播**所有 desired 片段。
 *
 * 重播是刻意的：装配器可能晚启动（`prompt.fragments.list` 就是为它准备的），
 * 而「重播整份」不要求订阅方 diff —— 与 `models.prefs.state` 同一个理由。
 */
function syncFragments(): void {
  const desired = desiredFragments()
  for (const id of [...registered]) {
    if (!desired.has(id)) {
      service.publish('prompt.fragment.unregistered', { pluginId: PLUGIN_ID, id: characterFragmentId(id) })
      registered.delete(id)
    }
  }
  for (const [id, text] of desired) {
    service.publish('prompt.fragment.registered', {
      pluginId: PLUGIN_ID,
      id: characterFragmentId(id),
      priority: ROLE_FRAGMENT_PRIORITY,
      text,
    })
    registered.add(id)
  }
}

function publishState(): void {
  if (!store) return
  service.publish('agent.state', { characters: store.list() })
}

service.subscribe('agent.state.set', (payload) => {
  if (!store) return
  const patch = (payload as { patch?: AgentStatePatch }).patch
  if (!patch || typeof patch !== 'object') {
    logger.warn('agent.state.set: missing patch')
    return
  }
  const result = store.apply(patch)
  if (!result.changed) return
  publishState()
  syncFragments()
})

service.subscribe('agent.resolve', (payload) => {
  const requestId = typeof payload.requestId === 'string' ? payload.requestId : ''
  const characterId = typeof payload.characterId === 'string' ? payload.characterId : ''
  if (!requestId) return
  if (!store) {
    service.publish('agent.resolve.result', { requestId, error: { code: 'not_ready', message: 'agent store not ready' } })
    return
  }
  const character = characterId ? store.get(characterId) : undefined
  if (!character) {
    service.publish('agent.resolve.result', {
      requestId,
      error: { code: 'not_found', message: `no character '${characterId}'` },
    })
    return
  }
  service.publish('agent.resolve.result', { requestId, recipe: toRecipe(character) })
})

// 收集方上线时请求重播：把当前所有角色片段再发一遍（**并重播目录** ——
// 晚启动的 composer/编辑器订阅方也靠这一问补齐 agent.state）。
service.subscribe('prompt.fragments.list', () => {
  publishState()
  syncFragments()
})

async function main(): Promise<void> {
  await service.start()
  const dir = service.dataDir || process.env.DS_DATA_DIR
  if (!dir) {
    throw new Error(
      'agent: no dataDir from the handshake — refusing to fall back to a relative path ' +
        '(that is how 487 sessions ended up inside dist/)',
    )
  }
  store = new CharacterStore(dir)
  for (const err of store.takeErrors()) logger.warn(`agent: characters.json: ${err}`)
  logger.info(`agent: characters=${store.list().length} dataDir=${dir}`)
  // 启动即重播整份 + 注册片段（晚启动的订阅方靠 prompt.fragments.list 再来问一次）
  publishState()
  syncFragments()
}

main().catch((err: unknown) => {
  console.error(`agent: failed to start: ${String(err)}`)
  process.exit(1)
})
