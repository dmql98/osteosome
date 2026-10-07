import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { defineComponent, nextTick } from 'vue'
import { sse } from '../src/sse'
import { useLlmProviders } from '../src/useLlmProviders'

/**
 * 可控的 EventSource：真 `SseClient` 照旧跑，但「什么时候 open / 有没有事件」由测试决定。
 *
 * 不用 mock `../src/sse` 模块是有意的 —— 那会把 `state` 的真实流转一起 mock 掉，
 * 于是「什么时候才算 connected」这条最关键的语义反而没人守。
 * 真客户端 + 假传输，是这条回归测试唯一诚实的形状。
 */
class FakeEventSource extends EventTarget {
  static instances: FakeEventSource[] = []
  readonly url: string
  readyState = 0
  constructor(url: string) {
    super()
    this.url = url
    FakeEventSource.instances.push(this)
  }
  close(): void {
    this.readyState = 2
  }
  /** 对端已登记这条流：浏览器会在这一刻触发 open */
  open(): void {
    this.readyState = 1
    this.dispatchEvent(new Event('open'))
  }
  emit(data: unknown): void {
    this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(data) }))
  }
}

function last(): FakeEventSource {
  const es = FakeEventSource.instances[FakeEventSource.instances.length - 1]
  if (!es) throw new Error('还没有 EventSource 被创建')
  return es
}

/** 本组件会订阅两个 topic，而 SseClient 每换一个 topic 就换一条流 —— 两次订阅 = 两条流 */
const STREAMS_PER_HOST = 2

function host(onList?: (providers: { provider: string }[]) => void) {
  return defineComponent({
    setup() {
      const { list } = useLlmProviders()
      return () => {
        onList?.(list.value)
        return null
      }
    },
  })
}

describe('useLlmProviders · 状态对齐', () => {
  let fetchMock: MockInstance<typeof globalThis.fetch>
  let mounted: VueWrapper[] = []

  function mountTracked(component: ReturnType<typeof host>) {
    const w = mount(component)
    mounted.push(w as VueWrapper)
    return w
  }

  function reannounceCalls(): number {
    return fetchMock.mock.calls.filter((call) => {
      const init = call[1] as { body?: string } | undefined
      return String(init?.body ?? '').includes('llm.provider.reannounce')
    }).length
  }

  beforeEach(() => {
    FakeEventSource.instances = []
    globalThis.EventSource = FakeEventSource as unknown as typeof EventSource
    fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 202 }))
  })

  afterEach(() => {
    // 必须在这里收尾而不是每条用例自己 unmount：
    // 断言一旦失败，unmount 就到不了，残留组件的 watcher 会跟着 state 变化再发一轮，
    // 后面几条用例的计数全被污染（看着像实现有 bug，其实是自己漏了清理）。
    for (const w of mounted.splice(0)) w.unmount()
    sse.close()
    fetchMock.mockRestore()
  })

  it('连接建立之前不发 reannounce —— 那一刻问回来的清单投递给空气', async () => {
    mountTracked(host())
    await nextTick()

    expect(FakeEventSource.instances).toHaveLength(STREAMS_PER_HOST)
    expect(sse.getState()).toBe('connecting')
    expect(reannounceCalls()).toBe(0)
  })

  it('连接一建立就发 reannounce，且重连后再发一次（漏掉的由此自愈）', async () => {
    mountTracked(host())
    await nextTick()

    last().open()
    await nextTick()
    expect(sse.getState()).toBe('connected')
    expect(reannounceCalls()).toBe(1)

    // 换流：新增 topic 会让 SseClient 重连（它把 topic 集合并进新 URL），
    // 于是又是一次「新的连接建立」—— 对齐必须跟着再来一遍。
    mountTracked(
      defineComponent({
        setup() {
          sse.subscribe('some.other.topic', () => undefined)
          return () => null
        },
      }),
    )
    await nextTick()
    expect(FakeEventSource.instances).toHaveLength(STREAMS_PER_HOST + 1)
    expect(sse.getState()).toBe('connecting')
    expect(reannounceCalls()).toBe(1)

    last().open()
    await nextTick()
    expect(reannounceCalls()).toBe(2)
  })

  it('回放到的事件进得了 list（对齐之后拿得到清单）', async () => {
    const seen: string[][] = []
    mountTracked(
      host((providers) => {
        seen.push(providers.map((p) => p.provider))
      }),
    )
    await nextTick()

    last().open()
    await nextTick()
    last().emit({
      topic: 'llm.provider.registered',
      payload: { provider: 'lm-studio', defaultModel: '', credentialRef: '', retryPolicy: { maxAttempts: 3 } },
    })
    await nextTick()

    expect(seen.at(-1)).toEqual(['lm-studio'])
  })

  it('同一个 sse 实例上的第二个组件不必等一个不会再来的 open', async () => {
    mountTracked(host())
    await nextTick()
    last().open()
    await nextTick()
    expect(reannounceCalls()).toBe(1)

    // 流已经通了：新组件挂载时状态就是 connected，它要立刻问一次而不是干等
    mountTracked(host())
    await nextTick()
    expect(reannounceCalls()).toBe(2)
  })
})
