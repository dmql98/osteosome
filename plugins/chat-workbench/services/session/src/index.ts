/**
 * session 服务入口（P3 WS-1）—— 命令分发 + 结果/事件发布。
 *
 * - 订阅七个 session 命令（§3.3）→ 走 store → 发 `<cmd>.result`；
 * - 顺带发布领域事件（`session.created` / `session.updated` / `session.deleted` / `message.appended`），
 *   供前端 + loop 旁路消费（WS-2 细拆命令 IPC，这里先落地全链）。
 */
import { Service } from '@osteosome/service-sdk'
import { SessionStore } from './store'
import { dispatch } from './session'

const service = new Service({ id: 'session', version: '1.0.0' })
const store = new SessionStore(service.dataDir || process.env.DS_DATA_DIR || '.data')

/** 命令 → 结果 topic（P3 §3.3） */
const RESULT_TOPIC: Record<string, string> = {
  'session.list': 'session.list.result',
  'session.get': 'session.get.result',
  'session.create': 'session.create.result',
  'session.rename': 'session.rename.result',
  'session.delete': 'session.delete.result',
  'session.clear': 'session.clear.result',
  'message.append': 'message.append.result',
}

function handle(topic: string, payload: Record<string, unknown>): void {
  // 变更类命令：先记快照，dispatch 后按结果发布领域事件（事件与 result 同批）
  const before = new Set(store.list().map((m) => m.id))
  const result = dispatch(store, topic, payload)
  service.publish(RESULT_TOPIC[topic], result)
  if (result.error) return

  // session.created / session.updated
  if (topic === 'session.create' || topic === 'session.rename') {
    const sessionId = result.sessionId as string
    const meta = store.list().find((m) => m.id === sessionId)
    if (meta) {
      service.publish(topic === 'session.create' ? 'session.created' : 'session.updated', {
        sessionId: meta.id,
        title: meta.title,
        updatedAt: meta.updatedAt,
      })
    }
  }
  // session.deleted（含 clear：clear 逐个删除前先发事件）
  if (topic === 'session.delete') {
    service.publish('session.deleted', { sessionId: result.sessionId })
  }
  if (topic === 'session.clear') {
    for (const id of before) service.publish('session.deleted', { sessionId: id })
  }
  // message.appended
  if (topic === 'message.append') {
    service.publish('message.appended', {
      sessionId: result.sessionId,
      message: result.message,
    })
  }
}

for (const topic of Object.keys(RESULT_TOPIC)) {
  service.subscribe(topic, (payload) => {
    handle(topic, payload as Record<string, unknown>)
  })
}

async function main(): Promise<void> {
  await service.start()
  console.log(`session: dataDir=${store.root}`)
}

main().catch((err: unknown) => {
  console.error(`session: failed to start: ${String(err)}`)
  process.exit(1)
})
