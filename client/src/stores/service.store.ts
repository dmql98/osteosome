import { defineStore } from 'pinia'

export type ServiceLifecycle = 'starting' | 'ready' | 'restarting' | 'failed' | 'stopped'
export interface ServiceStatusEntry {
  serviceId: string
  status: ServiceLifecycle
  version?: string
  lastSeenAt: number
  reason?: string
}

export const useServiceStore = defineStore('services', {
  state: () => ({ services: {} as Record<string, ServiceStatusEntry> }),
  getters: {
    readyCount: (state) => Object.values(state.services).filter((item) => item.status === 'ready').length,
    totalCount: (state) => Object.keys(state.services).length,
  },
  actions: {
    apply(topic: string, payload: Record<string, unknown>): void {
      const serviceId = typeof payload.serviceId === 'string' ? payload.serviceId : ''
      if (!serviceId) return
      const statusByTopic: Record<string, ServiceLifecycle> = {
        'service.starting': 'starting',
        'service.ready': 'ready',
        'service.restarting': 'restarting',
        'service.failed': 'failed',
        'service.stopped': 'stopped',
      }
      const status = statusByTopic[topic]
      if (!status) return
      const previous = this.services[serviceId]
      this.services[serviceId] = {
        serviceId,
        status,
        lastSeenAt: Date.now(),
        ...(typeof payload.version === 'string' ? { version: payload.version } : previous?.version ? { version: previous.version } : {}),
        ...(typeof payload.reason === 'string' ? { reason: payload.reason } : {}),
      }
    },
    setStatus(status: ServiceLifecycle, payload: Record<string, unknown>): void {
      const serviceId = typeof payload.serviceId === 'string' ? payload.serviceId : typeof payload.id === 'string' ? payload.id : ''
      if (!serviceId) return
      this.services[serviceId] = {
        serviceId,
        status,
        lastSeenAt: Date.now(),
        ...(typeof payload.version === 'string' ? { version: payload.version } : {}),
        ...(typeof payload.reason === 'string' ? { reason: payload.reason } : {}),
      }
    },
    clear(): void { this.services = {} },
  },
})
