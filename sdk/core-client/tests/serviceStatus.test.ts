import { beforeEach, describe, expect, it } from 'vitest'
import { computed, nextTick } from 'vue'
import { serviceStatus, type ServiceStatusEntry } from '../src/serviceStatus'

/**
 * 服务状态表（P6 从 client 的 pinia store 抽到 sdk/core-client）。
 *
 * ## 迁移时要守住的两件事
 *
 * 1. **形状不变**：调用方写的是 `services.services` / `services.readyCount`
 *    （pinia 会自动解包 ref），所以抽包时也这么暴露，client 那几处才不用改。
 * 2. **仍然是响应式的**：这不是「能跑就行」——
 *    服务状态一变，顶栏的健康灯与状态面板必须立刻跟着变。
 *    所以这里显式验一次 `computed` 会被重新求值。
 */
describe('serviceStatus', () => {
  beforeEach(() => {
    serviceStatus.clear()
  })

  it('按 service.* topic 更新服务状态和计数', () => {
    serviceStatus.apply('service.ready', { serviceId: 'hello', version: '1.0.0' })
    serviceStatus.apply('service.starting', { serviceId: 'llm', version: '1.0.0' })
    expect(serviceStatus.services.hello?.status).toBe('ready')
    expect(serviceStatus.services.llm?.status).toBe('starting')
    expect(serviceStatus.readyCount).toBe(1)
    expect(serviceStatus.totalCount).toBe(2)
  })

  it('忽略不认识的 topic（别的事件不该把服务状态搅乱）', () => {
    serviceStatus.apply('service.ready', { serviceId: 'hello' })
    serviceStatus.apply('llm.token.streamed', { serviceId: 'hello' })
    expect(serviceStatus.services.hello?.status).toBe('ready')
  })

  it('version 在后续事件里没带时沿用上一次的（别被抹掉）', () => {
    serviceStatus.apply('service.ready', { serviceId: 'llm', version: '1.0.0' })
    serviceStatus.apply('service.restarting', { serviceId: 'llm' })
    expect(serviceStatus.services.llm?.status).toBe('restarting')
    expect(serviceStatus.services.llm?.version).toBe('1.0.0')
  })

  it('setStatus 接受 health 快照的 id 字段', () => {
    // `/health` 回来的字段是 `id`，而事件是 `serviceId` —— 两个来源都要认
    serviceStatus.setStatus('ready', { id: 'session' })
    expect(serviceStatus.services.session?.status).toBe('ready')
  })

  it('**响应式**：状态变了，依赖它的 computed 会重新求值', () => {
    const ready = computed(() => serviceStatus.readyCount)
    const total = computed(() => serviceStatus.totalCount)
    expect([ready.value, total.value]).toEqual([0, 0])

    serviceStatus.apply('service.ready', { serviceId: 'llm' })
    // 不用 nextTick 断言「将来某一刻会更新」，那太松；这里要求同步可读
    expect([ready.value, total.value]).toEqual([1, 1])

    serviceStatus.apply('service.failed', { serviceId: 'llm', reason: 'boom' })
    expect(ready.value).toBe(0)
    const entry = serviceStatus.services.llm as ServiceStatusEntry
    expect(entry.reason).toBe('boom')
  })

  it('clear 归零（组件卸载 / 测试之间不留脏状态）', () => {
    serviceStatus.apply('service.ready', { serviceId: 'llm' })
    serviceStatus.clear()
    expect(serviceStatus.totalCount).toBe(0)
  })

  it('await nextTick 不会让上面任何一条失效（守住「不是只在同步路径可用」）', async () => {
    serviceStatus.apply('service.ready', { serviceId: 'session' })
    await nextTick()
    expect(serviceStatus.services.session?.status).toBe('ready')
  })
})