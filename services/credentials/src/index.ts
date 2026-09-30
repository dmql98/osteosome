import { Service } from '@osteosome/service-sdk'
import { resolveCredential } from './resolve'

const service = new Service({ id: 'credentials', version: '1.0.0' })

/**
 * 凭证能力位（P2 WS-3）—— 收 `credentials.resolve { requestId, ref }` → 发 `credentials.resolved`。
 * v1 只认 `env:<VAR>` → `process.env[...]`；`core:<id>` 预留（P4 接凭证 store），明确报 unimplemented。
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

  const result = resolveCredential(ref)
  if (result.ok) {
    respond({ apiKey: result.apiKey })
    return
  }
  respond({ error: result.error })
})

async function main(): Promise<void> {
  await service.start()
}

main().catch((err: unknown) => {
  console.error(`credentials: failed to start: ${String(err)}`)
  process.exit(1)
})
