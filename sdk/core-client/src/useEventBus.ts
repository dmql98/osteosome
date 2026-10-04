import { onMounted, onUnmounted } from 'vue'
import { sse, type SseHandler } from './sse'

export function useEventBus(topic: string, handler: SseHandler): void {
  let dispose: (() => void) | null = null
  onMounted(() => { dispose = sse.subscribe(topic, handler) })
  onUnmounted(() => { dispose?.(); dispose = null })
}
