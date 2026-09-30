/**
 * llm-chat / llm-providers Widget 单测（P2 WS-8）。
 *
 * 手法对齐既有 composables.test.ts：mock sse.subscribe 捕获 handler（等同 FakeEventSource 注入），
 * mock fetch 断言 `/api/command` POST（等同 msw 拦截）；断言 token 累积与 finished/failed 结束态。
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent, h } from 'vue'

const sseHandlers = new Map<string, (payload: unknown, topic?: string) => void>()

vi.mock('../../src/core-sdk/sse', async () => {
  const actual = await vi.importActual<typeof import('../../src/core-sdk/sse')>('../../src/core-sdk/sse')
  return {
    ...actual,
    sse: {
      subscribe: vi.fn((topic: string, handler: (payload: unknown, topic?: string) => void) => {
        sseHandlers.set(topic, handler)
        return () => { sseHandlers.delete(topic) }
      }),
      ensureConnected: vi.fn(),
    },
  }
})

import LlmChatWidget from '../../src/widgets/llm-chat/LlmChatWidget.vue'
import LlmProvidersWidget from '../../src/widgets/llm-providers/LlmProvidersWidget.vue'
import { sse } from '../../src/core-sdk/sse'

function emit(topic: string, payload: unknown): void {
  sseHandlers.get(topic)?.(payload, topic)
}

const DESCRIPTOR = {
  provider: 'deepseek',
  defaultModel: 'deepseek-chat',
  credentialRef: 'env:DEEPSEEK_API_KEY',
  retryPolicy: { maxAttempts: 3, baseDelayMs: 500, backoff: 'exponential', retryableCodes: ['rate_limited'] },
}

beforeEach(() => {
  sseHandlers.clear()
  vi.mocked(sse.subscribe).mockClear()
})

describe('llm-providers widget', () => {
  it('无 provider → EmptyState；registered 后渲染行；unregistered 后摘除', async () => {
    const wrapper = mount(LlmProvidersWidget)
    expect(wrapper.text()).toContain('无 provider 注册')

    emit('llm.provider.registered', DESCRIPTOR)
    await wrapper.vm.$nextTick()
    expect(wrapper.get('[data-testid="llm-provider-deepseek"]').text()).toContain('deepseek-chat')
    expect(wrapper.get('[data-testid="llm-provider-deepseek"]').text()).toContain('env:DEEPSEEK_API_KEY')

    emit('llm.provider.unregistered', { provider: 'deepseek' })
    await wrapper.vm.$nextTick()
    expect(wrapper.text()).toContain('无 provider 注册')
  })
})

describe('llm-chat widget', () => {
  async function mountWithProvider() {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 202 }))
    const wrapper = mount(LlmChatWidget)
    await wrapper.vm.$nextTick()
    emit('llm.provider.registered', DESCRIPTOR)
    await wrapper.vm.$nextTick()
    return { wrapper, fetchMock }
  }

  it('registered 后自动选中 provider 并出现输入框', async () => {
    const { wrapper, fetchMock } = await mountWithProvider()
    expect(wrapper.find('[data-testid="llm-chat-input"]').exists()).toBe(true)
    expect(wrapper.get('[data-testid="llm-chat-provider"]').text()).toContain('deepseek')
    fetchMock.mockRestore()
  })

  it('发送 → POST llm.request（user 消息立即落本地），token 逐条累积到 assistant', async () => {
    const { wrapper, fetchMock } = await mountWithProvider()
    const textarea = wrapper.get('[data-testid="llm-chat-input"]')
    await textarea.setValue('你好')
    await wrapper.get('form').trigger('submit')
    await wrapper.vm.$nextTick()

    // user 消息立即出现（不等响应）
    expect(wrapper.get('[data-testid="llm-chat-user"]').text()).toContain('你好')
    // POST /api/command 走 llm.request
    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body))
    expect(fetchMock.mock.calls[0][0]).toBe('/api/command')
    expect(body.topic).toBe('llm.request')
    expect(body.payload.provider).toBe('deepseek')
    expect(body.payload.model).toBe('deepseek-chat')
    const requestId = body.payload.requestId

    // 抽取在途 requestId：token 事件必须带它
    emit('llm.token.streamed', { requestId, token: '你', index: 0 })
    emit('llm.token.streamed', { requestId, token: '好', index: 1 })
    await wrapper.vm.$nextTick()
    expect(wrapper.get('[data-testid="llm-chat-assistant"]').text()).toBe('你好')

    // finished → Spinner 收起（发第二次可发送）
    emit('llm.request.finished', { requestId, finishReason: 'stop', usage: { promptTokens: 3, completionTokens: 2 } })
    await wrapper.vm.$nextTick()
    expect(wrapper.find('[data-testid="llm-chat-send"]').exists()).toBe(true)
    fetchMock.mockRestore()
  })

  it('finished 前的 Spinner 态：显示停止按钮；点击 → POST llm.cancel', async () => {
    const { wrapper, fetchMock } = await mountWithProvider()
    await wrapper.get('[data-testid="llm-chat-input"]').setValue('hi')
    await wrapper.get('form').trigger('submit')
    await wrapper.vm.$nextTick()
    const requestId = JSON.parse(String(fetchMock.mock.calls[0][1]?.body)).payload.requestId

    expect(wrapper.find('[data-testid="llm-chat-send"]').exists()).toBe(false)
    await wrapper.get('button.ui-button').trigger('click')
    const cancelBody = JSON.parse(String(fetchMock.mock.calls[1][1]?.body))
    expect(cancelBody.topic).toBe('llm.cancel')
    expect(cancelBody.payload.requestId).toBe(requestId)
    fetchMock.mockRestore()
  })

  it('failed → 错误占位（missing_credential 中文映射），不崩', async () => {
    const { wrapper, fetchMock } = await mountWithProvider()
    await wrapper.get('[data-testid="llm-chat-input"]').setValue('hi')
    await wrapper.get('form').trigger('submit')
    await wrapper.vm.$nextTick()
    const requestId = JSON.parse(String(fetchMock.mock.calls[0][1]?.body)).payload.requestId

    emit('llm.request.failed', { requestId, error: { code: 'missing_credential', message: 'no key' } })
    await wrapper.vm.$nextTick()
    expect(wrapper.get('[data-testid="llm-chat-failed"]').text()).toContain('缺少 API Key')
    // 结束态：可再次发送
    expect(wrapper.find('[data-testid="llm-chat-send"]').exists()).toBe(true)
    fetchMock.mockRestore()
  })

  it('异 requestId 的 token 事件被忽略（不串流）', async () => {
    const { wrapper, fetchMock } = await mountWithProvider()
    await wrapper.get('[data-testid="llm-chat-input"]').setValue('hi')
    await wrapper.get('form').trigger('submit')
    await wrapper.vm.$nextTick()
    const requestId = JSON.parse(String(fetchMock.mock.calls[0][1]?.body)).payload.requestId

    emit('llm.token.streamed', { requestId: 'other-request', token: 'X', index: 0 })
    await wrapper.vm.$nextTick()
    expect(wrapper.get('[data-testid="llm-chat-assistant"]').text()).toBe('')
    // 正确 requestId 仍累积
    emit('llm.token.streamed', { requestId, token: 'Y', index: 0 })
    await wrapper.vm.$nextTick()
    expect(wrapper.get('[data-testid="llm-chat-assistant"]').text()).toBe('Y')
    fetchMock.mockRestore()
  })
})
