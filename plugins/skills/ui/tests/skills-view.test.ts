/**
 * widget.skills 视图（P6）—— 分组 / 本机可用开关 / 角色绑定 AND / 同名冲突 / 统计。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { installFakeEventSource, type FakeEventSource } from '@osteosome/core-client/testing'
import { sse } from '@osteosome/core-client'
import SkillsView from '../src/views/SkillsView.vue'

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

const entry = (owner: string, name: string, description = '', enabled = true) => ({
  ownerPluginId: owner,
  name,
  description,
  source: owner === 'user' ? 'custom' : 'plugin',
  enabled,
})

async function mountView() {
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 202 }))
  const wrapper = mount(SkillsView)
  mounted.push(wrapper)
  await flushPromises()
  return { wrapper, fetchMock }
}

describe('SkillsView（widget.skills）', () => {
  it('空索引 → 「还没有技能」空态', async () => {
    const { wrapper } = await mountView()
    expect(wrapper.text()).toContain('还没有技能')
  })

  it('skills.state → 按 owner 分组渲染（用户自建 / 插件）', async () => {
    const { wrapper } = await mountView()
    fakeSse.emit('skills.state', { skills: [entry('user', 'custom-a', '自建'), entry('chat-workbench', 'git-diff', '看差异')] })
    await flushPromises()
    expect(wrapper.text()).toContain('用户自建')
    expect(wrapper.text()).toContain('chat-workbench')
    expect(wrapper.find('[data-testid="sk-row-custom-a"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="sk-row-git-diff"]').exists()).toBe(true)
  })

  it('同名冲突 → 标 ⚠', async () => {
    const { wrapper } = await mountView()
    fakeSse.emit('skills.state', { skills: [entry('user', 'dup'), entry('chat-workbench', 'dup')] })
    await flushPromises()
    expect(wrapper.findAll('[data-testid="sk-row-dup"]')).toHaveLength(2)
    expect(wrapper.text()).toContain('同名冲突')
  })

  it('「本机可用」开关 → skill.enabled.set', async () => {
    const { wrapper, fetchMock } = await mountView()
    fakeSse.emit('skills.state', { skills: [entry('user', 'a')] })
    await flushPromises()
    await wrapper.get('[data-testid="sk-switch-a"]').trigger('click')
    await flushPromises()
    const cmd = commandBodies(fetchMock).find((b) => b.topic === 'skill.enabled.set')!
    expect(cmd?.payload).toMatchObject({ name: 'a', ownerPluginId: 'user', enabled: false })
  })

  it('角色列 = 绑了 N · 有效 M（AND：停用时有效 0）', async () => {
    const { wrapper } = await mountView()
    fakeSse.emit('skills.state', { skills: [entry('user', 'a', '', true), entry('user', 'b', '', false)] })
    fakeSse.emit('agent.state', {
      characters: [
        { id: 'r1', name: 'R1', prompt: '', skills: ['a', 'b'], tools: '*' },
        { id: 'r2', name: 'R2', prompt: '', skills: ['a'], tools: '*' },
      ],
    })
    await flushPromises()
    expect(wrapper.get('[data-testid="sk-roles-a"]').text()).toContain('绑了 2')
    expect(wrapper.get('[data-testid="sk-roles-a"]').text()).toContain('有效 2')
    expect(wrapper.get('[data-testid="sk-roles-b"]').text()).toContain('绑了 1')
    expect(wrapper.get('[data-testid="sk-roles-b"]').text()).toContain('有效 0')
  })

  it('统计 Tab → 预算条', async () => {
    const { wrapper } = await mountView()
    fakeSse.emit('skills.state', { skills: [entry('user', 'a', '描述')] })
    await flushPromises()
    await wrapper.get('[data-testid="sk-tab-stats"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid="sk-budget"]').exists()).toBe(true)
    expect(wrapper.get('[data-testid="sk-budget"]').text()).toContain('8192')
  })
})
