/**
 * 服务状态表 —— 一个 `reactive` 对象，**不用 pinia**。
 *
 * ## 为什么从 pinia 拿掉
 *
 * 这张表只有 51 行、只被 `useServiceStatus` 用。而 pinia 一进包，就意味着
 * **每个插件 UI 都得装一个 pinia 实例**（为了看几个服务状态而已）——
 * 十几个 KB 的依赖，换一张本可以用 `reactive` 表达的三字段表。
 * 更麻烦的是它让「宿主」与「插件 UI」的初始化顺序产生了隐式耦合：
 * 忘了 `app.use(pinia)` 会在**组件 setup 里**抛错，而插件 UI 是独立入口，更容易漏。
 *
 * pinia 换来的是 devtools、跨 store 依赖、插件化 store —— 这三样这里都用不上。
 * 真要用的时候（多个 store 互相依赖）再加回来，那时它是**有理由**的。
 *
 * ## 形状刻意与原来的 pinia store 一致
 *
 * `services` / `readyCount` / `totalCount` 直接挂在对象上（不是 `state.services`），
 * 因为 pinia 会自动解包 ref —— 调用方写的就是 `services.services`。
 * 抽包时**保持这个形状**，client 里那几处调用点一行都不用改。
 *
 * 用 `reactive` + getter 而不是「返回一堆 ref」：getter 读到的依赖会被 reactive
 * 正常追踪，所以 `computed(() => services.readyCount)` 与模板里的
 * `services.readyCount` 都仍然是响应式的。
 */
import { reactive } from 'vue'

export type ServiceLifecycle = 'starting' | 'ready' | 'restarting' | 'failed' | 'stopped'

export interface ServiceStatusEntry {
  serviceId: string
  status: ServiceLifecycle
  version?: string
  lastSeenAt: number
  reason?: string
}

/** topic → 生命周期。只认这五个，其它 topic 直接忽略 */
const STATUS_BY_TOPIC: Record<string, ServiceLifecycle> = {
  'service.starting': 'starting',
  'service.ready': 'ready',
  'service.restarting': 'restarting',
  'service.failed': 'failed',
  'service.stopped': 'stopped',
}

/**
 * 真正的存储。
 *
 * 刻意放在 `serviceStatus` **之外**：`serviceStatus` 本身是 reactive 的，
 * 若在它的 getter 里读 `this.services`，Vue 的响应式追踪会把 getter 自己
 * 算成依赖 —— 于是每次读状态都算一次「依赖变了」，在 computed 里表现为无谓重算。
 * 用一个闭包外的 reactive 对象当存储，getter 只读它，依赖关系是干净的。
 */
const store = reactive({ services: {} as Record<string, ServiceStatusEntry> })

export const serviceStatus = reactive({
  /** serviceId → 状态。**直接暴露**（不是 state.services）：与原 pinia store 的形状一致 */
  get services(): Record<string, ServiceStatusEntry> {
    return store.services
  },
  get readyCount(): number {
    return Object.values(store.services).filter((item) => item.status === 'ready').length
  },
  get totalCount(): number {
    return Object.keys(store.services).length
  },

  /** 吃一条 `service.*` 事件 */
  apply(topic: string, payload: Record<string, unknown>): void {
    const serviceId = typeof payload.serviceId === 'string' ? payload.serviceId : ''
    if (!serviceId) return
    const status = STATUS_BY_TOPIC[topic]
    if (!status) return
    const previous = store.services[serviceId]
    store.services[serviceId] = {
      serviceId,
      status,
      lastSeenAt: Date.now(),
      ...(typeof payload.version === 'string'
        ? { version: payload.version }
        : previous?.version
          ? { version: previous.version }
          : {}),
      ...(typeof payload.reason === 'string' ? { reason: payload.reason } : {}),
    }
  },

  /** 直接设状态（`/health` 的启动快照走这里） */
  setStatus(status: ServiceLifecycle, payload: Record<string, unknown>): void {
    const serviceId =
      typeof payload.serviceId === 'string' ? payload.serviceId : typeof payload.id === 'string' ? payload.id : ''
    if (!serviceId) return
    store.services[serviceId] = {
      serviceId,
      status,
      lastSeenAt: Date.now(),
      ...(typeof payload.version === 'string' ? { version: payload.version } : {}),
      ...(typeof payload.reason === 'string' ? { reason: payload.reason } : {}),
    }
  },

  clear(): void {
    store.services = {}
  },
})