/**
 * skills-tools（P7 M4 WS-10）—— skill_manager。
 *
 * 注入与否由**技能列表**决定：技能为空 → **不注册**（没有技能包可管）。
 * 有技能包 → 注册 `skill_manager`（`managedBy:'auto'`，界面不给启用开关）。
 * 执行体：返回技能索引（正文按需的 `skill_read` 属后续，本阶段返回目录）。
 */
import { Service, logger } from '@osteosome/service-sdk'
import type { SkillIndexEntry, ToolRisk } from '@osteosome/shared'

const SERVICE_ID = 'skills-tools'
const service = new Service({ id: SERVICE_ID, version: '1.0.0' })

let skills: SkillIndexEntry[] = []
let registeredNow = false

const SPEC = {
  name: 'skill_manager',
  description: '列出可用技能（name + description）',
  parameters: { type: 'object', properties: {} },
  risk: 'read' as ToolRisk,
  managedBy: 'auto' as const,
}

function sync(): void {
  const have = skills.length > 0
  if (have && !registeredNow) {
    service.publish('tool.registered', { serviceId: SERVICE_ID, tools: [SPEC] })
    registeredNow = true
  } else if (!have && registeredNow) {
    service.publish('tool.unregistered', { serviceId: SERVICE_ID })
    registeredNow = false
  }
}

service.subscribe('skills.state', (payload) => {
  const s = (payload as { skills?: unknown } | null)?.skills
  skills = Array.isArray(s) ? (s as SkillIndexEntry[]) : []
  sync()
})
service.subscribe('tools.list', sync)

service.subscribe('tool.execute', (payload) => {
  const T = typeof payload.requestId === 'string' ? payload.requestId : ''
  if (!T || payload.name !== 'skill_manager') return
  const content = skills.map((s) => `- ${s.name}: ${s.description}`).join('\n') || '（无可用技能）'
  service.publish('tool.execute.result', { requestId: T, ok: true, content, summary: `skill_manager → ${skills.length} 个技能` })
})

async function main(): Promise<void> {
  await service.start()
  sync()
  logger.info(`skills-tools: ready（技能列表空则不注册 skill_manager）`)
}
main().catch((err: unknown) => {
  console.error(`skills-tools: failed to start: ${String(err)}`)
  process.exit(1)
})
