import { onMounted, onUnmounted } from 'vue'
import { useServiceStore } from '@/stores/service.store'
import { sse } from './sse'

export function useServiceStatus() {
  const services = useServiceStore()
  let dispose: (() => void) | null = null
  onMounted(() => {
    dispose = sse.subscribe('service.*', (payload, topic) => {
      if (topic && payload && typeof payload === 'object') services.apply(topic, payload as Record<string, unknown>)
    })
    void fetch('/health').then(async (response) => {
      if (!response.ok) return
      const health = await response.json() as { services?: Array<{ id?: string; status?: string; version?: string }> }
      for (const item of health.services ?? []) {
        if (item.id && item.status) services.setStatus(item.status as Parameters<typeof services.setStatus>[0], { serviceId: item.id, version: item.version })
      }
    }).catch(() => undefined)
  })
  onUnmounted(() => { dispose?.(); dispose = null })
  return services
}
