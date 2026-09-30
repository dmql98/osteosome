/**
 * llm-chat / llm-providers Widget 单测（P3 WS-5 会话化语义）。
 *
 * 手法对齐 composables.test.ts：mock sse 捕获 handler（等同跨窗事件注入）+ mock fetch 拦截 /api/command。
 * 覆盖 P3 §3.4：发问走 loop.run、loop.token.streamed 累积 in-flight、message.appended 换服务端 id（不重放）、
 * 停止按钮发 loop.cancel、loop.run.failed 错误占位不留幽灵、loop 崩溃清 in-flight。
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

const sseHandlers = new Map<string, (payload: unknown) => void>()

vi.mock('../../src/core-sdk/sse', async () => {
  const actual = await vi.importActual<typeof import('../../src/core-sdk/sse')>('../../src/core-sdk/sse')
  return {
    ...actual,
    sse: {
      subscribe: vi.fn((topic: string, handler: (payload: unknown) => void) => {
        sseHandlers.set(topic, handler)
        return () => sseHandlers.delete(topic)
      }),
      ensureConnected: vi.fn(),
    },
  }
})

import LlmChatWidget from '../../src/widgets/llm-chat/LlmChatWidget.vue'
import LlmProvidersWidget from '../../src/widgets/llm-providers/LlmProvidersWidget.vue'
import { useSessionStore } from '../../src/stores/session.store'

const DESCRIPTOR = {
  provider: 'deepseek',
  defaultModel: 'deepseek-chat',
  credentialRef: 'env:DEEPSEEK_API_KEY',
  retryPolicy: { maxAttempts: 3, baseDelayMs: 500, backoff: 'exponential', retryableCodes: ['rate_limited'] },
}

function emit(topic: string, payload: unknown): void {
  sseHandlers.get(topic)?.(payload)
}

function commandBodies(fetchMock: ReturnType<typeof vi.spyOn>): Record<string, unknown>[] {
  return fetchMock.mock.calls.map((c) => JSON.parse(String(c[1]?.body)) as Record<string, unknown>)
}

beforeEach(() => {
  sseHandlers.clear()
  setActivePinia(createPinia())
})

describe('llm-providers widget', () => {
  it('无 provider → EmptyState；registered 渲染行；unregistered 摘除', async () => {
    const wrapper = mount(LlmProvidersWidget)
    expect(wrapper.text()).toContain('无 provider 注册')
    emit('llm.provider.registered', DESCRIPTOR)
    await wrapper.vm.$nextTick()
    expect(wrapper.get('[data-testid="llm-provider-deepseek"]').text()).toContain('deepseek-chat')
    emit('llm.provider.unregistered', { provider: 'deepseek' })
    await wrapper.vm.$nextTick()
    expect(wrapper.text()).toContain('无 provider 注册')
  })
})

describe('llm-chat widget（P3 会话化）', () => {
  async function mountWithSession(sessionId = 's1') {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 202 }))
    const wrapper = mount(LlmChatWidget)
    await wrapper.vm.$nextTick()
    emit('llm.provider.registered', DESCRIPTOR)
    await wrapper.vm.$nextTick()
    const sessions = useSessionStore()
    if (sessionId) sessions.select(sessionId)
    await flushPromises()
    return { wrapper, fetchMock, sessions }
  }

  it('选中会话 → 发 session.get 载入历史', async () => {
    const { fetchMock } = await mountWithSession('s1')
    const topics = commandBodies(fetchMock).map((b) => b.topic)
    expect(topics).toContain('session.get')
    fetchMock.mockRestore()
  })

  it('session.get.result → 渲染历史消息', async () => {
    const { wrapper, fetchMock } = await mountWithSession('s1')
    emit('session.get.result', {
      requestId: 'get-1',
      session: {
        meta: { id: 's1' },
        messages: [
          { id: 'm1', role: 'user', content: '历史问题', createdAt: '2024-01-01' },
          { id: 'm2', role: 'assistant', content: '历史回答', createdAt: '2024-01-01' },
        ],
      },
    })
    await wrapper.vm.$nextTick()
    expect(wrapper.get('[data-testid="llm-chat-user"]').text()).toContain('历史问题')
    expect(wrapper.get('[data-testid="llm-chat-assistant"]').text()).toContain('历史回答')
    fetchMock.mockRestore()
  })

  it('发问 → POST loop.run（非 llm.request）+ user 消息立即可见 + in-flight assistant 占位', async () => {
    const { wrapper, fetchMock } = await mountWithSession('s1')
    await wrapper.get('[data-testid="llm-chat-input"]').setValue('你好')
    await wrapper.get('form').trigger('submit')
    await wrapper.vm.$nextTick()

    const bodies = commandBodies(fetchMock)
    const run = bodies.find((b) => b.topic === 'loop.run')!
    expect(run.topic).toBe('loop.run')
    const payload = run.payload as { sessionId: string; text: string; requestId: string }
    expect(payload.sessionId).toBe('s1')
    expect(payload.text).toBe('你好')
    // user 消息立即可见
    expect(wrapper.get('[data-testid="llm-chat-user"]').text()).toContain('你好')
    // in-flight assistant 占位（pending spinner）
    expect(wrapper.find('[data-testid="llm-chat-send"]').exists()).toBe(false)
    fetchMock.mockRestore()
  })

  it('loop.token.streamed → 累积到 in-flight assistant', async () => {
    const { wrapper, fetchMock } = await mountWithSession('s1')
    await wrapper.get('[data-testid="llm-chat-input"]').setValue('你好')
    await wrapper.get('form').trigger('submit')
    await wrapper.vm.$nextTick()
    const a = (commandBodies(fetchMock).find((b) => b.topic === 'loop.run')!.payload as { requestId: string }).requestId

    emit('loop.token.streamed', { requestId: a, sessionId: 's1', token: '你', index: 0 })
    emit('loop.token.streamed', { requestId: a, sessionId: 's1', token: '好', index: 1 })
    await wrapper.vm.$nextTick()
    expect(wrapper.get('[data-testid="llm-chat-assistant"]').text()).toBe('你好')
    fetchMock.mockRestore()
  })

  it('异 requestId 的 token 被忽略（不串流）', async () => {
    const { wrapper, fetchMock } = await mountWithSession('s1')
    await wrapper.get('[data-testid="llm-chat-input"]').setValue('hi')
    await wrapper.get('form').trigger('submit')
    await wrapper.vm.$nextTick()
    const a = (commandBodies(fetchMock).find((b) => b.topic === 'loop.run')!.payload as { requestId: string }).requestId
    emit('loop.token.streamed', { requestId: 'other', token: 'X', index: 0 })
    await wrapper.vm.$nextTick()
    emit('loop.token.streamed', { requestId: a, sessionId: 's1', token: 'Y', index: 0 })
    await wrapper.vm.$nextTick()
    expect(wrapper.get('[data-testid="llm-chat-assistant"]').text()).toBe('Y')
    fetchMock.mockRestore()
  })

  it('message.appended → in-flight 换服务端 id（不重放 content）', async () => {
    const { wrapper, fetchMock, sessions } = await mountWithSession('s1')
    await wrapper.get('[data-testid="llm-chat-input"]').setValue('hi')
    await wrapper.get('form').trigger('submit')
    await wrapper.vm.$nextTick()
    const a = (commandBodies(fetchMock).find((b) => b.topic === 'loop.run')!.payload as { requestId: string }).requestId
    emit('loop.token.streamed', { requestId: a, sessionId: 's1', token: '答案', index: 0 })
    await wrapper.vm.$nextTick()

    // 服务端落库 → message.appended（当前会话 assistant）
    sessions.messages = []
    emit('message.appended', {
      sessionId: 's1',
      message: { id: 'srv_1', role: 'assistant', content: '答案', createdAt: '2024-01-01' },
    })
    await wrapper.vm.$nextTick()
    // 视图切到服务端消息（session cache 持有）——不应出现重复内容
    const assistantTexts = wrapper.findAll('[data-testid="llm-chat-assistant"]').map((n) => n.text())
    expect(assistantTexts.filter((t) => t.includes('答案')).length).toBe(1)
    fetchMock.mockRestore()
  })

  it('停止按钮 → POST loop.cancel（A，非 llm.cancel）', async () => {
    const { wrapper, fetchMock } = await mountWithSession('s1')
    await wrapper.get('[data-testid="llm-chat-input"]').setValue('hi')
    await wrapper.get('form').trigger('submit')
    await wrapper.vm.$nextTick()
    const a = (commandBodies(fetchMock).find((b) => b.topic === 'loop.run')!.payload as { requestId: string }).requestId

    await wrapper.get('button.ui-button').trigger('click')
    const bodies = commandBodies(fetchMock)
    const cancel = bodies.find((b) => b.topic === 'loop.cancel')!
    expect(cancel).toBeTruthy()
    expect((cancel.payload as { requestId: string }).requestId).toBe(a)
    // 旧的 llm.cancel 不应出现
    expect(bodies.find((b) => b.topic === 'llm.cancel')).toBeUndefined()
    fetchMock.mockRestore()
  })

  it('loop.run.failed → 错误占位 + 不留幽灵 assistant', async () => {
    const { wrapper, fetchMock } = await mountWithSession('s1')
    await wrapper.get('[data-testid="llm-chat-input"]').setValue('hi')
    await wrapper.get('form').trigger('submit')
    await wrapper.vm.$nextTick()
    const a = (commandBodies(fetchMock).find((b) => b.topic === 'loop.run')!.payload as { requestId: string }).requestId
    emit('loop.token.streamed', { requestId: a, sessionId: 's1', token: '半句', index: 0 })
    await wrapper.vm.$nextTick()

    emit('loop.run.failed', { requestId: a, sessionId: 's1', error: { code: 'missing_credential', message: 'no key' } })
    await wrapper.vm.$nextTick()
    expect(wrapper.get('[data-testid="llm-chat-failed"]').text()).toContain('缺少 API Key')
    // 失败后不残留 pending in-flight
    expect(wrapper.find('[data-testid="llm-chat-send"]').exists()).toBe(true)
    fetchMock.mockRestore()
  })

  it('loop 崩溃（service.failed loop）→ 清 in-flight + 输入恢复', async () => {
    const { wrapper, fetchMock } = await mountWithSession('s1')
    await wrapper.get('[data-testid="llm-chat-input"]').setValue('hi')
    await wrapper.get('form').trigger('submit')
    await wrapper.vm.$nextTick()
    emit('service.failed', { serviceId: 'loop', reason: 'crashed' })
    await wrapper.vm.$nextTick()
    // in-flight 清掉、可再次发送
    expect(wrapper.find('[data-testid="llm-chat-send"]').exists()).toBe(true)
    fetchMock.mockRestore()
  })
})
