/**
 * skills 服务入口（P6 WS-1）—— 技能索引的**收集方 + 唯一写者**。
 *
 * ## 它做三件事
 *
 * 1. **收集**：订阅各插件的 `skill.registered` / `skill.unregistered`（那些插件自己的服务
 *    读完自己的 `SKILL.md` 再交上来），加上自己 `custom/` 目录里的用户自建技能，汇总成
 *    **全系统一份**的 `skills.state`。
 * 2. **AND（服务端）**：`skills.list{characterId}` 返回「本机可用 ∩ 该角色绑定」——
 *    索引里看得见的，模型一定读得到（避免「看见→去读→被拒，原因看不到」）。
 * 3. **写入口唯一**：`skill.package.write` 写用户自建 SKILL.md；`skill.enabled.set` 改机器级开关。
 *
 * ## 它不做什么
 *
 * - **不读别的插件的 SKILL.md** —— `plugins.readFile` 只限自己插件目录，那份正文由对方交。
 * - **不认识工具/角色** —— 角色绑定从 `agent.state`（广播）读；技能正文的按需回吐（`skill_read`）
 *   归 tools 插件 P7 的 `skills-tools` 执行者，本阶段不做。
 */
import { Service, logger } from '@osteosome/service-sdk'
import {
  intersectRoleSkills,
  sortSkillIndex,
  type CharacterBrief,
  type SkillIndexEntry,
} from '@osteosome/shared'
import { SkillStore } from './store'

const service = new Service({ id: 'skills', version: '1.0.0' })

let store: SkillStore | null = null
/** 插件登记的技能（key = owner::name） */
const pluginSkills = new Map<string, SkillIndexEntry>()
/** 角色目录（从 agent.state 读；用于 skills.list{characterId} 的绑定过滤） */
let characters: CharacterBrief[] = []

const keyOf = (ownerPluginId: string, name: string): string => `${ownerPluginId}::${name}`

/** 全部索引条目（自定义 + 插件），带 enabled 标志，按 owner→name 确定排序 */
function buildIndex(): SkillIndexEntry[] {
  const all = new Map<string, SkillIndexEntry>()
  if (store) {
    for (const c of store.customSkills()) all.set(keyOf(c.ownerPluginId, c.name), c)
  }
  for (const [k, e] of pluginSkills) all.set(k, e)
  const entries = [...all.values()].map((e) => ({
    ...e,
    enabled: store ? store.isEnabled(e.ownerPluginId, e.name) : true,
  }))
  return sortSkillIndex(entries)
}

function publishState(): void {
  service.publish('skills.state', { skills: buildIndex() })
}

service.subscribe('skill.registered', (payload) => {
  const ownerPluginId = typeof payload.ownerPluginId === 'string' ? payload.ownerPluginId : ''
  const name = typeof payload.name === 'string' ? payload.name : ''
  if (!ownerPluginId || !name) return
  const description = typeof payload.description === 'string' ? payload.description : ''
  const source = payload.source === 'custom' ? 'custom' : 'plugin'
  pluginSkills.set(keyOf(ownerPluginId, name), { ownerPluginId, name, description, source, enabled: true })
  publishState()
})

service.subscribe('skill.unregistered', (payload) => {
  const ownerPluginId = typeof payload.ownerPluginId === 'string' ? payload.ownerPluginId : ''
  const name = typeof payload.name === 'string' ? payload.name : ''
  if (!ownerPluginId || !name) return
  if (pluginSkills.delete(keyOf(ownerPluginId, name))) publishState()
})

// 角色绑定从广播读（缺失 = 没有角色 → skills.list 退化为「全部本机可用」）
service.subscribe('agent.state', (payload) => {
  const c = (payload as { characters?: unknown } | null)?.characters
  if (Array.isArray(c)) characters = c as CharacterBrief[]
})

service.subscribe('skills.list', (payload) => {
  const requestId = typeof payload.requestId === 'string' ? payload.requestId : ''
  if (!requestId) return
  const characterId = typeof payload.characterId === 'string' ? payload.characterId : ''
  const available = buildIndex().filter((e) => e.enabled)
  if (!characterId) {
    service.publish('skills.list.result', { requestId, skills: available })
    return
  }
  const character = characters.find((c) => c.id === characterId)
  // 角色未知 → 拿不到绑定，退回「全部本机可用」（不臆测绑定）
  if (!character) {
    service.publish('skills.list.result', { requestId, skills: available })
    return
  }
  service.publish('skills.list.result', { requestId, skills: intersectRoleSkills(available, character.skills) })
})

service.subscribe('skill.enabled.set', (payload) => {
  if (!store) return
  const name = typeof payload.name === 'string' ? payload.name : ''
  const ownerPluginId = typeof payload.ownerPluginId === 'string' ? payload.ownerPluginId : ''
  const enabled = payload.enabled === true
  if (!name || !ownerPluginId) return
  store.setEnabled(ownerPluginId, name, enabled)
  publishState()
})

service.subscribe('skill.package.write', (payload) => {
  if (!store) return
  const name = typeof payload.name === 'string' ? payload.name : ''
  if (!name) return
  try {
    if (payload.removed === true) {
      store.removeCustom(name)
    } else if (typeof payload.content === 'string') {
      store.writeCustom(name, payload.content)
    } else {
      return
    }
    publishState()
  } catch (err) {
    logger.warn(`skills: package.write failed: ${String(err)}`)
  }
})

// 收集方/编辑器上线时请重播（与 agent 服务同款：宿主问一次）
service.subscribe('prompt.fragments.list', () => {
  publishState()
})

async function main(): Promise<void> {
  await service.start()
  const dir = service.dataDir || process.env.DS_DATA_DIR
  if (!dir) {
    throw new Error(
      'skills: no dataDir from the handshake — refusing to fall back to a relative path ' +
        '(that is how 487 sessions ended up inside dist/)',
    )
  }
  store = new SkillStore(dir)
  logger.info(`skills: custom=${store.customSkills().length} dataDir=${dir}`)
  publishState()
}

main().catch((err: unknown) => {
  console.error(`skills: failed to start: ${String(err)}`)
  process.exit(1)
})
