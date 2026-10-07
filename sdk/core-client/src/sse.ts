import { ref, type Ref } from 'vue'

export type SseState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting'
export type SseHandler = (payload: unknown, topic?: string) => void

export interface SseClientOptions {
  createEventSource?: (url: string) => EventSource
  now?: () => number
  watchdogIntervalMs?: number
  silenceTimeoutMs?: number
}

type EventSourceFactory = (url: string) => EventSource

function matchesTopic(pattern: string, topic: string): boolean {
  if (pattern === topic) return true
  if (pattern === '*') return true
  const patternParts = pattern.split('.')
  const topicParts = topic.split('.')
  let pi = 0
  let ti = 0
  while (pi < patternParts.length && ti < topicParts.length) {
    const part = patternParts[pi]
    if (part === '**') return true
    if (part !== '*' && part !== topicParts[ti]) return false
    pi += 1
    ti += 1
  }
  return pi === patternParts.length && ti === topicParts.length
}

export class SseClient {
  private readonly stateRef: Ref<SseState> = ref('disconnected')
  private readonly topics = new Set<string>()
  private readonly handlers = new Map<string, Set<SseHandler>>()
  private es: EventSource | null = null
  private lastMessageAt = 0
  private silenceTimer: ReturnType<typeof setInterval> | null = null
  private readonly createEventSource: EventSourceFactory
  private readonly now: () => number
  private readonly watchdogIntervalMs: number
  private readonly silenceTimeoutMs: number

  constructor(options: SseClientOptions = {}) {
    this.createEventSource = options.createEventSource ?? ((url) => new EventSource(url))
    this.now = options.now ?? (() => Date.now())
    this.watchdogIntervalMs = options.watchdogIntervalMs ?? 30_000
    this.silenceTimeoutMs = options.silenceTimeoutMs ?? 90_000
  }

  get state(): SseState { return this.stateRef.value }
  getState(): SseState { return this.state }
  get activeTopics(): string[] { return [...this.topics] }

  /**
 * 订阅一个 topic。返回退订函数。
 *
 * ## ⚠️ 订阅「新 topic」会**换一条连接**，别在命令旁边这么干
 *
 * EventSource 的订阅集是**建在 URL 里**的（SSE 协议没法给一条已建立的连接加 topic），
 * 所以每多一个 topic 就必须重开一次：`reconnect()` 会 `close()` 旧流、另开一条新的。
 * 而新流**此刻还没 open** —— 对端尚未登记它。这中间有一个「两条都不在」的窗口，
 * **落在这个窗口里的事件就永远丢了**：handler 还在（`handlers` map 是共享的），
 * 但那一刻没有任何一条流在传输。
 *
 * 这个坑已经咬过两次，形态不同、根因同一：
 * - `chat-workbench` 的 `create()`：为一次命令临时订阅 `session.create.result` → 换流 →
 *   紧接着发的 `session.create` 的回执与 `session.created` 双双丢失 →
 *   **会话列表不刷新**，且 `create()` 干等 10 秒兜底（用户要切走再切回来才看见）。
 * - `useLlmProviders`：挂载后立刻发 `llm.provider.reannounce` → 回放的清单投递给空气 →
 *   provider 下拉永远空着。
 *
 * **规矩：不要为一次命令临时订阅 topic。**
 * 要等回执，就**常驻订阅**（在 `onMounted` / `bindEvents` 里）再在本地按 requestId 配对，
 * 像 `useEndpointProbe` 按 provider 归档那样；或者像 `useLlmProviders` 那样，
 * 把「问一次」挂在 `state === 'connected'` 上（连上就问、重连就再问，天然自愈）。
 *
 * 也不能改成「新流 open 之后再关旧流」来兜住 —— 重叠期同一事件会被投递两次，
 * 而 `loop.token.streamed` 是直接追加、无去重（payload 里也没有序号可去重），
 * 那会把刚修好的「事件只到一次」打回原形。
 */
subscribe(topic: string, handler: SseHandler): () => void {
    let handlers = this.handlers.get(topic)
    if (!handlers) {
      handlers = new Set()
      this.handlers.set(topic, handlers)
    }
    handlers.add(handler)
    const isNewTopic = !this.topics.has(topic)
    this.topics.add(topic)
    if (this.state === 'disconnected' || isNewTopic) this.reconnect()
    return () => this.unsubscribe(topic, handler)
  }

  ensureConnected(): void {
    if (this.state === 'disconnected') this.reconnect()
  }

  close(): void {
    this.es?.close()
    this.es = null
    this.stateRef.value = 'disconnected'
    this.lastMessageAt = 0
    if (this.silenceTimer) clearInterval(this.silenceTimer)
    this.silenceTimer = null
    this.topics.clear()
    this.handlers.clear()
  }

  private unsubscribe(topic: string, handler: SseHandler): void {
    const handlers = this.handlers.get(topic)
    handlers?.delete(handler)
    if (handlers && handlers.size > 0) return
    this.handlers.delete(topic)
    if (!this.topics.delete(topic)) return
    if (this.topics.size === 0) this.close()
    else this.reconnect()
  }

  private reconnect(): void {
    if (this.topics.size === 0) return
    this.es?.close()
    this.stateRef.value = 'connecting'
    const query = encodeURIComponent([...this.topics].join(','))
    try {
      this.es = this.createEventSource(`/events?topics=${query}`)
    } catch (error) {
      this.stateRef.value = 'reconnecting'
      console.warn('[sse] connection failed', error)
      return
    }
    this.lastMessageAt = this.now()
    this.es.addEventListener('open', () => {
      this.stateRef.value = 'connected'
      this.lastMessageAt = this.now()
    })
    this.es.addEventListener('message', (event: MessageEvent<string>) => {
      this.lastMessageAt = this.now()
      try {
        const message = JSON.parse(event.data) as { topic?: unknown; payload?: unknown }
        if (typeof message.topic !== 'string') return
        for (const [pattern, handlers] of this.handlers) {
          if (!matchesTopic(pattern, message.topic)) continue
          for (const handler of handlers) handler(message.payload, message.topic)
        }
      } catch (error) {
        console.warn('[sse] invalid message', error)
      }
    })
    this.es.addEventListener('error', () => {
      this.stateRef.value = 'reconnecting'
    })
    this.startWatchdog()
  }

  private startWatchdog(): void {
    if (this.silenceTimer) clearInterval(this.silenceTimer)
    this.silenceTimer = setInterval(() => {
      if (this.state !== 'disconnected' && this.now() - this.lastMessageAt > this.silenceTimeoutMs) this.reconnect()
    }, this.watchdogIntervalMs)
  }
}

export const sse = new SseClient()
