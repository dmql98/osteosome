import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent } from 'vue'
import { useEventBus } from '../../src/core-sdk/useEventBus'
import { useCommand } from '../../src/core-sdk/useCommand'
import { sse } from '../../src/core-sdk/sse'

vi.mock('../../src/core-sdk/sse', async () => {
  const actual = await vi.importActual<typeof import('../../src/core-sdk/sse')>('../../src/core-sdk/sse')
  return { ...actual, sse: { subscribe: vi.fn(() => vi.fn()), ensureConnected: vi.fn() } }
})

describe('core-sdk composables', () => {
  it('useEventBus 挂载订阅、卸载退订', () => {
    const wrapper = mount(defineComponent({ setup() { useEventBus('hello.*', vi.fn()); return () => null } }))
    expect(sse.subscribe).toHaveBeenCalledWith('hello.*', expect.any(Function))
    wrapper.unmount()
  })

  it('useCommand POST 成功与失败均不抛', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(null, { status: 202 }))
      .mockResolvedValueOnce(new Response(null, { status: 500 }))
    const { send } = useCommand()
    await expect(send('hello.command', { text: 'hi' })).resolves.toBe(true)
    await expect(send('hello.command')).resolves.toBe(false)
    expect(fetchMock).toHaveBeenCalledWith('/api/command', expect.objectContaining({ method: 'POST' }))
    fetchMock.mockRestore()
  })
})
