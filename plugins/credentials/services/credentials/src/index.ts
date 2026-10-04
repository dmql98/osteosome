import { Service } from '@osteosome/service-sdk'
import { resolveCredential } from './resolve'

const service = new Service({ id: 'credentials', version: '1.0.0' })

/**
 * 凭证能力位（P2 WS-3 骨架 + P4 WS-2 接 core store）—— 收 `credentials.resolve { requestId, ref }` → 发 `credentials.resolved`。
 *
 * 两种 ref kind：
 * - `env:<VAR>` → 读本进程 `process.env`（P2）
 * - `core:<id>` → 经 JSON-RPC `credentials.get` 问 Core 凭证 store 取原值（P4 WS-2；**不经总线、不落事件**）
 *
 * 解析失败不裸奔默认 key —— 永远回 error（missing_credential），不空着 apiKey。
 */
service.subscribe('credentials.resolve', (payload) => {
  const requestId = typeof payload.requestId === 'string' ? payload.requestId : ''
  const ref = typeof payload.ref === 'string' ? payload.ref : ''
  const respond = (body: Record<string, unknown>) => service.publish('credentials.resolved', { requestId, ...body })

  if (!requestId || !ref) {
    respond({ error: { code: 'missing_credential', message: 'credentials.resolve: requestId and ref are required' } })
    return
  }

  // core:<id> → Core 凭证 store（原值只经 JSON-RPC 回本进程，不入总线/事件/SSE）
  const fetchCore = async (credentialId: string): Promise<string> => {
    const res = await service.call<{ value?: string }>('credentials.get', { id: credentialId })
    return res?.value ?? ''
  }

  void resolveCredential(ref, { fetchCore })
    .then((result) => {
      if (result.ok) {
        respond({ apiKey: result.apiKey })
        return
      }
      respond({ error: result.error })
    })
    .catch((err: unknown) => {
      respond({ error: { code: 'missing_credential', message: `credentials.resolve failed: ${String(err)}` } })
    })
})

async function main(): Promise<void> {
  await service.start()
}

main().catch((err: unknown) => {
  console.error(`credentials: failed to start: ${String(err)}`)
  process.exit(1)
})
