/**
 * widget.agents 视图（P5）—— 空态 / 列表 / 新建 / 编辑 / 装配预览 / 事件。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { installFakeEventSource, type FakeEventSource } from '@osteosome/core-client/testing'
import { sse } from '@osteosome/core-client'
import AgentRolesView from '../src/views/AgentRolesView.vue'

let fakeSse: FakeEventSource
const mounted: VueWrapper[] = []

function commandBodies(fetchMock: { mock: { calls: unknown[][] } }): Record<string, unknown>[] {
  return fetchMock.mock.calls
    .filter((c) => String(c[0]).includes('/api/command'))
    .map((c) => JSON.parse(String((c[1] as { body?: unknown } | undefined)?.body)) as Record<string, unknown>)
}

beforeEach(() => {
  sse.close()
  fakeSse = installFakeEventSource()
})
afterEach(() => {
  for (const w of mounted) w.unmount()
  mounted.length = 0
  vi.unstubAllGlobals()
})

async function mountView() {
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 202 }))
  const wrapper = mount(AgentRolesView)
  mounted.push(wrapper)
  await flushPromises()
  return { wrapper, fetchMock }
}

describe('AgentRolesView（widget.agents）', () => {
  it('空目录 → 「还没有角色」空态', async () => {
    const { wrapper } = await mountView()
    expect(wrapper.text()).toContain('还没有角色')
  })

  it('agent.state → 列表出现；选中 → 身份 Tab 显示名称/提示词', async () => {
    const { wrapper } = await mountView()
    fakeSse.emit('agent.state', {
      characters: [{ id: 'reviewer', name: '评审员', emoji: '🧐', prompt: '你是评审员', skills: ['git-diff'], tools: ['read'] }],
    })
    await flushPromises()
    const item = wrapper.get('[data-testid="ag-item-reviewer"]')
    expect(item.text()).toContain('评审员')
    await item.trigger('click')
    await flushPromises()
    const nameInput = wrapper.get('[data-testid="ag-name"] input').element as HTMLInputElement
    expect(nameInput.value).toBe('评审员')
    const prompt = wrapper.get('[data-testid="ag-prompt"]').element as HTMLTextAreaElement
    expect(prompt.value).toBe('你是评审员')
  })

  it('空白提示词 → 标「裸会话」+ 信息条', async () => {
    const { wrapper } = await mountView()
    fakeSse.emit('agent.state', { characters: [{ id: 'bare', name: '裸会话', prompt: '', skills: [], tools: '*' }] })
    await flushPromises()
    await wrapper.get('[data-testid="ag-item-bare"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid="ag-bare"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="ag-bare-info"]').exists()).toBe(true)
  })

  it('新建 → 发 agent.state.set（character）', async () => {
    const { wrapper, fetchMock } = await mountView()
    await wrapper.get('[data-testid="ag-new"]').trigger('click')
    await flushPromises()
    const cmd = commandBodies(fetchMock).find((b) => b.topic === 'agent.state.set')!
    expect(cmd).toBeTruthy()
    expect((cmd.payload as { patch: { character?: { id: string } } }).patch.character?.id).toMatch(/^c_/)
  })

  it('改名称 → 发合并 patch', async () => {
    const { wrapper, fetchMock } = await mountView()
    fakeSse.emit('agent.state', { characters: [{ id: 'a', name: '旧名', prompt: 'x', skills: [], tools: '*' }] })
    await flushPromises()
    await wrapper.get('[data-testid="ag-item-a"]').trigger('click')
    await flushPromises()
    await wrapper.get('[data-testid="ag-name"] input').setValue('新名')
    await flushPromises()
    const cmd = commandBodies(fetchMock).filter((b) => b.topic === 'agent.state.set').pop()!
    expect((cmd.payload as { patch: { character: { id: string; name: string } } }).patch.character).toMatchObject({ id: 'a', name: '新名' })
  })

  it('绑定 Tab：绑了工具/技能 → 标悬空引用', async () => {
    const { wrapper } = await mountView()
    fakeSse.emit('agent.state', { characters: [{ id: 'a', name: 'A', prompt: 'x', skills: ['git-diff'], tools: ['read'] }] })
    await flushPromises()
    await wrapper.get('[data-testid="ag-item-a"]').trigger('click')
    await wrapper.get('[data-testid="ag-tab-bindings"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid="ag-tools-dangling"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="ag-skills-dangling"]').exists()).toBe(true)
  })

  it('装配 Tab：空 prompt → p5 显示「（空）」而非 0 B', async () => {
    const { wrapper } = await mountView()
    fakeSse.emit('agent.state', { characters: [{ id: 'a', name: 'A', prompt: '', skills: [], tools: '*' }] })
    await flushPromises()
    await wrapper.get('[data-testid="ag-item-a"]').trigger('click')
    await wrapper.get('[data-testid="ag-tab-assembly"]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-testid="ag-p5"]').text()).toContain('（空）')
  })
})
