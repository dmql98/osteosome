import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { defineComponent, nextTick } from 'vue'
import { sse } from '../src/sse'
import { useModelCredentials, useModelsPrefs } from '../src/useModelsPrefs'

/**
 * 可控的 EventSource + 真 `SseClient`（理由与 `useLlmProviders.test.ts` 一样：
 * mock 掉 `sse` 模块会把「什么时候才算 connected」这条语义一起 mock 掉）。
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

describe('models 插件用户数据（总线读写）', () => {
  let fetchMock: MockInstance<typeof globalThis.fetch>
  let mounted: VueWrapper[] = []

  const host = (onState?: () => void) =>
    defineComponent({
      setup() {
        const { prefs, synced, patch } = useModelsPrefs()
        const creds = useModelCredentials()
        onState?.()
        void prefs
        void synced
        void creds
        return () => null
      },
    })

  function mountTracked(component: ReturnType<typeof host>) {
    const w = mount(component)
    mounted.push(w as VueWrapper)
    return w
  }

  function commands(): Array<Record<string, unknown>> {
    return fetchMock.mock.calls
      .filter((c) => String(c[0]).includes('/api/command'))
      .map((c) => JSON.parse(String((c[1] as { body?: string }).body)) as Record<string, unknown>)
  }

  function topics(): string[] {
    return commands().map((b) => String(b.topic))
  }

  beforeEach(() => {
    FakeEventSource.instances = []
    globalThis.EventSource = FakeEventSource as unknown as typeof EventSource
    fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 202 }))
  })

  afterEach(() => {
    for (const w of mounted.splice(0)) w.unmount()
    sse.close()
    fetchMock.mockRestore()
  })

  it('连上之前不问（那一刻问回来的清单投递给空气）', async () => {
    mountTracked(host())
    await nextTick()
    expect(topics()).toEqual([])
  })

  it('连上就问接入清单与凭据各一次', async () => {
    mountTracked(host())
    await nextTick()
    last().open()
    await nextTick()

    expect(topics()).toContain('models.prefs.get')
    expect(topics()).toContain('models.credentials.list')
  })

  it('owner 重播整份 → refs 落到界面上（容错：脏形状不炸）', async () => {
    let seen: { vendors: string[]; maskedOnly: boolean } | undefined
    mountTracked(
      defineComponent({
        setup() {
          const { prefs, synced } = useModelsPrefs()
          const { credentials } = useModelCredentials()
          return () => {
            seen = { vendors: [...prefs.value.connectedVendors], maskedOnly: credentials.value.every((c) => !('value' in c)) }
            void synced
            return null
          }
        },
      }),
    )
    await nextTick()
    last().open()
    await nextTick()

    last().emit({
      topic: 'models.prefs.state',
      payload: { prefs: { connectedVendors: ['lm-studio'], vendorOverrides: '脏形状', enabledModels: [] } },
    })
    last().emit({
      topic: 'models.credentials.state',
      payload: { credentials: [{ id: 'c1', name: 'k', provider: 'deepseek', kind: 'apiKey', masked: 'sk-…' }] },
    })
    await nextTick()

    expect(seen?.vendors).toEqual(['lm-studio'])
    expect(seen?.maskedOnly).toBe(true)
  })

  it('patch 发的是 models.prefs.set + patch（合并式，不是整份覆盖）', async () => {
    let patch!: (delta: Record<string, unknown>) => Promise<void>
    mountTracked(
      defineComponent({
        setup() {
          patch = useModelsPrefs().patch
          return () => null
        },
      }),
    )
    await nextTick()
    last().open()
    await nextTick()

    await patch({ enabledModels: ['a::m'] })

    const set = commands().find((b) => b.topic === 'models.prefs.set')
    expect(set?.payload).toEqual({ patch: { enabledModels: ['a::m'] } })
  })

  it('重连后再问一次（漏掉的那次由此自愈）', async () => {
    mountTracked(host())
    await nextTick()
    last().open()
    await nextTick()
    expect(topics().filter((t) => t === 'models.prefs.get')).toHaveLength(1)

    // 换流：新增 topic 会让 SseClient 重连（它把 topic 集合并进新 URL）
    mountTracked(
      defineComponent({
        setup() {
          sse.subscribe('some.other.topic', () => undefined)
          return () => null
        },
      }),
    )
    await nextTick()
    last().open()
    await nextTick()

    expect(topics().filter((t) => t === 'models.prefs.get')).toHaveLength(2)
  })
})