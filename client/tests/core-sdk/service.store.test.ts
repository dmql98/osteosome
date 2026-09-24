import { describe, expect, it } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useServiceStore } from '../../src/stores/service.store'

describe('service.store', () => {
  it('按 service.* topic 更新服务状态和计数', () => {
    setActivePinia(createPinia())
    const store = useServiceStore()
    store.apply('service.ready', { serviceId: 'hello', version: '1.0.0' })
    store.apply('service.starting', { serviceId: 'llm', version: '1.0.0' })
    expect(store.services.hello?.status).toBe('ready')
    expect(store.services.llm?.status).toBe('starting')
    expect(store.readyCount).toBe(1)
    expect(store.totalCount).toBe(2)
  })
})
