/**
 * 订阅 Core 的服务状态（P6 从 client 抽出）。
 *
 * 数据来源两路，缺一不可：
 * · **SSE `service.*`** —— 运行期变化（启动、崩溃、重启、停止）
 * · **`GET /health`** —— 启动时的当前快照
 *
 * 为什么要 `/health`：纯事件驱动有个致命前提 —— **订阅要早于事件**。
 * 而 `service.ready` 是在服务握手完成时就发完的，于是任何在启动之后才打开的页面
 * （插件 UI、详情窗、独立窗口）都会**永远错过**那批事件，把已经就绪的服务显示成「未就绪」。
 * 所以挂载时补拉一次快照。
 */
import { onMounted, onUnmounted } from 'vue'
import { serviceStatus } from './serviceStatus'
import { sse } from './sse'

export function useServiceStatus() {
  let dispose: (() => void) | null = null
  onMounted(() => {
    dispose = sse.subscribe('service.*', (payload, topic) => {
      if (topic && payload && typeof payload === 'object') {
        serviceStatus.apply(topic, payload as Record<string, unknown>)
      }
    })
    void fetch('/health')
      .then(async (response) => {
        if (!response.ok) return
        const health = (await response.json()) as {
          services?: Array<{ id?: string; status?: string; version?: string }>
        }
        for (const item of health.services ?? []) {
          if (item.id && item.status) {
            serviceStatus.setStatus(item.status as Parameters<typeof serviceStatus.setStatus>[0], {
              serviceId: item.id,
              version: item.version,
            })
          }
        }
      })
      .catch(() => undefined)
  })
  onUnmounted(() => {
    dispose?.()
    dispose = null
  })
  return serviceStatus
}