/**
 * llm-retry —— retry 声明消费 + usage 记账装配（P2 WS-7）。
 *
 * - 收 `llm.provider.registered` 存 retry 声明（主位透传 ProviderDescriptor）；`unregistered` 摘除；
 * - 收 `llm.request.finished` → 记 usage 发 `llm.metrics.usage { requestId, provider, usage }`；
 * - 收 `llm.request.failed` → 记失败（P2 只记事件，不重发；重试执行器 P4 读声明 backoff+jitter）。
 *
 * 旁路服务：不参与请求路径，只做声明消费 + 记账。
 */
import { Service } from '@osteosome/service-sdk'
import type { ProviderDeclaration } from './accounting'
import {
  recordFailure,
  recordUsage,
  removeDeclaration,
  upsertDeclaration,
} from './accounting'

const service = new Service({ id: 'llm-retry', version: '1.0.0' })

/** provider → retry 声明（registered 存 / unregistered 摘） */
const declarations = new Map<string, ProviderDeclaration>()

service.subscribe('llm.provider.registered', (payload) => {
  upsertDeclaration(payload as Record<string, unknown>, declarations)
})

service.subscribe('llm.provider.unregistered', (payload) => {
  const provider = typeof payload.provider === 'string' ? payload.provider : ''
  removeDeclaration(provider, declarations)
})

service.subscribe('llm.request.finished', (payload) => {
  const record = recordUsage(payload as Record<string, unknown>, declarations)
  if (!record) return
  if (record.usage) {
    service.publish('llm.metrics.usage', {
      requestId: record.requestId,
      provider: record.provider,
      usage: record.usage,
    })
  }
  // usage 为空 → 不记账也不发事件（避免 0 token 噪音）
})

service.subscribe('llm.request.failed', (payload) => {
  const record = recordFailure(payload as Record<string, unknown>, declarations)
  if (!record) return
  // P2 只记事件：失败不入 metrics（无 usage 可记）；重试判定 P4 执行器做
})

async function main(): Promise<void> {
  await service.start()
}

main().catch((err: unknown) => {
  console.error(`llm-retry: failed to start: ${String(err)}`)
  process.exit(1)
})
