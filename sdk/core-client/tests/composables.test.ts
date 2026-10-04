import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent } from 'vue'
import { useEventBus } from '../src/useEventBus'
import { useCommand } from '../src/useCommand'
import { sse } from '../src/sse'

/**
 * mock 的是**实现真正 import 的那个模块**。
 *
 * 这条测试以前在 client 里，用 `vi.mock('../../src/core-sdk/sse')` 拦截 —— 因为当时
 * `useEventBus` 就在隔壁、import 的是同一个路径。P6 把它们抽进包里之后，
 * 那个 mock 路径就拦不住了：包有它自己的 `sse` 实例。
 *
 * 症状值得记一下：断言报的是「expected "spy" to be called with ['hello.*', …]」，
 * 看起来像 `useEventBus` 坏了，实际是<b>测试 mock 了一个没人用的模块</b>。
 * 这种假红的修复方式永远是「mock 正确的那个路径」，不是「改实现去迁就测试」。
 */
vi.mock('../src/sse', async () => {
  const actual = await vi.importActual<typeof import('../src/sse')>('../src/sse')
  return { ...actual, sse: { subscribe: vi.fn(() => vi.fn()), ensureConnected: vi.fn() } }
})

describe('core-client composables', () => {
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
    await expect(send('session.list', { text: 'hi' })).resolves.toBe(true)
    await expect(send('session.list')).resolves.toBe(false)
    expect(fetchMock).toHaveBeenCalledWith('/api/command', expect.objectContaining({ method: 'POST' }))
    fetchMock.mockRestore()
  })
})