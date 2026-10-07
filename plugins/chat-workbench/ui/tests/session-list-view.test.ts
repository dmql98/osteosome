/**
 * ① 会话列表视图单测（P4b P0 重设计）。
 *
 * 覆盖 P0-1（去 Card）、P0-2（行内菜单对象=本行）、P0-5（相对时间）、P0-8（搜索）、P0-12（空态）、
 * P0-14（运行态圆点）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { installFakeEventSource, type FakeEventSource } from '@osteosome/core-client/testing'
import { sse } from '@osteosome/core-client'
import SessionListView from '../src/views/SessionListView.vue'
import { __resetSessionSyncForTest } from '../src/state/session-sync'

const META = (id: string, title: string, extra: Record<string, unknown> = {}) => ({
  id,
  title,
  createdAt: '2024-01-01T00:00:00.000Z',
  updatedAt: new Date().toISOString(),
  ...extra,
})

let fakeSse: FakeEventSource
const mounted: VueWrapper[] = []

function commandBodies(fetchMock: { mock: { calls: unknown[][] } }): Record<string, unknown>[] {
  return fetchMock.mock.calls
    .filter((c) => String(c[0]).includes('/api/command'))
    .map((c) => JSON.parse(String((c[1] as { body?: unknown } | undefined)?.body)) as Record<string, unknown>)
}

async function mountList(sessions: ReturnType<typeof META>[]) {
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 202 }))
  const wrapper = mount(SessionListView)
  mounted.push(wrapper)
  await flushPromises()
  fakeSse.emit('session.list.result', { requestId: 'r', sessions })
  await flushPromises()
  return { wrapper, fetchMock }
}

beforeEach(() => {
  sse.close()
  fakeSse = installFakeEventSource()
  __resetSessionSyncForTest()
  sessionStorage.clear()
})

afterEach(() => {
  for (const w of mounted) w.unmount()
  mounted.length = 0
  vi.unstubAllGlobals()
})

describe('SessionListView（①）· 形态', () => {
  it('P0-1：没有 Card 外壳（侧栏盒子本身就是盒子）', async () => {
    const { wrapper } = await mountList([META('a', '会话 A')])
    expect(wrapper.find('.ui-card').exists()).toBe(false)
    expect(wrapper.find('.rail').exists()).toBe(true)
  })

  it('P0-12：零会话 → 「还没有会话」空态，不是「无匹配」', async () => {
    const { wrapper } = await mountList([])
    expect(wrapper.find('[data-testid="rail-empty-none"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="rail-empty-nomatch"]').exists()).toBe(false)
  })

  it('P0-14：每行有一个运行态圆点', async () => {
    const { wrapper } = await mountList([META('a', '会话 A')])
    expect(wrapper.find('[data-testid="srow-a"] .ui-status-dot').exists()).toBe(true)
  })

  it('P0-8：搜索只匹配标题；无结果 → 「无匹配」空态', async () => {
    const { wrapper } = await mountList([META('a', 'SSE 重连'), META('b', '无关会话')])
    await wrapper.get('[data-testid="rail-search-toggle"]').trigger('click')
    await wrapper.get('[data-testid="rail-search-input"]').setValue('SSE')
    await flushPromises()
    expect(wrapper.find('[data-testid="srow-a"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="srow-b"]').exists()).toBe(false)
    // 搜不到
    await wrapper.get('[data-testid="rail-search-input"]').setValue('zzz')
    await flushPromises()
    expect(wrapper.find('[data-testid="rail-empty-nomatch"]').exists()).toBe(true)
  })
})

describe('SessionListView（①）· 行内菜单（P0-2）', () => {
  it('菜单里的动作作用于**它挂的那一行**，不是当前会话', async () => {
    const { wrapper, fetchMock } = await mountList([META('a', '会话 A'), META('b', '会话 B')])
    // 点第 b 行的 ⋯
    await wrapper.get('[data-testid="srow-menu-b"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid="srow-menu"]').exists()).toBe(true)
    // 点「置顶」→ 发 session.pin 且 sessionId = b
    const pinBtn = wrapper.findAll('[data-testid="srow-menu"] .menu__i').find((b) => b.text().includes('置顶'))!
    await pinBtn.trigger('click')
    await flushPromises()
    const pin = commandBodies(fetchMock).find((b) => b.topic === 'session.pin')
    expect(pin?.payload).toMatchObject({ sessionId: 'b', pinned: true })
  })

  it('归档按钮直接作用于该行', async () => {
    const { wrapper, fetchMock } = await mountList([META('a', '会话 A')])
    await wrapper.get('[data-testid="srow-archive-a"]').trigger('click')
    await flushPromises()
    expect(commandBodies(fetchMock).find((b) => b.topic === 'session.archive')?.payload).toMatchObject({
      sessionId: 'a',
      archived: true,
    })
  })

  it('导出菜单项发 session.export（对象=该行）', async () => {
    const { wrapper, fetchMock } = await mountList([META('a', '会话 A')])
    await wrapper.get('[data-testid="srow-menu-a"]').trigger('click')
    await flushPromises()
    const exportBtn = wrapper.findAll('[data-testid="srow-menu"] .menu__i').find((b) => b.text().includes('导出'))!
    await exportBtn.trigger('click')
    await flushPromises()
    expect(commandBodies(fetchMock).find((b) => b.topic === 'session.export')?.payload).toMatchObject({ sessionId: 'a' })
  })
})

describe('SessionListView（①）· 子会话树（P2-3）', () => {
  it('parentId 指向同桶父会话 → 子行缩进呈现；折叠父则隐藏子', async () => {
    const parent = META('p', '父会话')
    const child = META('c', '子会话', { parentId: 'p' })
    const { wrapper } = await mountList([parent, child])
    // 子行带 srow--child
    const childRow = wrapper.get('[data-testid="srow-c"]')
    expect(childRow.classes()).toContain('srow--child')
    // 父行有折叠箭头
    const chev = wrapper.get('[data-testid="srow-p"] .srow__chev')
    expect(chev.classes()).toContain('srow__chev')
    // 点折叠 → 子行消失
    await chev.trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid="srow-c"]').exists()).toBe(false)
  })

  it('parentId 指向不存在的会话 → 当顶层行（不丢）', async () => {
    const orphan = META('o', '孤儿', { parentId: 'ghost' })
    const { wrapper } = await mountList([orphan])
    expect(wrapper.find('[data-testid="srow-o"]').exists()).toBe(true)
    expect(wrapper.get('[data-testid="srow-o"]').classes()).not.toContain('srow--child')
  })
})
