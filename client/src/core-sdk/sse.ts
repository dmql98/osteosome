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
