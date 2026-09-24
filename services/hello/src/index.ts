import { Service } from '@osteosome/service-sdk'

const service = new Service({ id: 'hello', version: '1.0.0' })

service.subscribe('hello.command', (payload) => {
  const requestId = typeof payload.requestId === 'string' ? payload.requestId : ''
  const text = typeof payload.text === 'string' ? payload.text : ''
  service.publish('hello.command.started', { requestId, text })
  try {
    service.publish('hello.command.executed', { requestId, echo: text })
  } catch (err) {
    service.publish('hello.command.failed', { requestId, reason: String(err) })
  }
})

async function main(): Promise<void> {
  await service.start()
}

main().catch((err: unknown) => {
  console.error(`hello: failed to start: ${String(err)}`)
  process.exit(1)
})
