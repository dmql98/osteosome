/**
 * widget.tools 视图（P7 M5）—— 目录 / 审批 / 试调 / MCP / 事件 五 Tab。
 *
 * 与 skills/agents 的视图测试同构：装假 EventSource，喂 `tools.state` 等事件，
 * 断言「渲染对了」+「点下去发的是哪条命令」。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { installFakeEventSource, type FakeEventSource } from '@osteosome/core-client/testing'
import { sse } from '@osteosome/core-client'
import { Select } from '@osteosome/ui'
import ToolsView from '../src/views/ToolsView.vue'
import { __resetToolsStateForTest } from '../src/state'

let fakeSse: FakeEventSource
const mounted: VueWrapper[] = []

function commandBodies(fetchMock: { mock: { calls: unknown[][] } }): Record<string, unknown>[] {
  return fetchMock.mock.calls
    .filter((c) => String(c[0]).includes('/api/command'))
    .map((c) => JSON.parse(String((c[1] as { body?: unknown } | undefined)?.body)) as Record<string, unknown>)
}

beforeEach(() => {
  // 工具页状态是**模块级单例**：不清就会串用例（上一个用例的工具/事件留到下一个）
  __resetToolsStateForTest()
  sse.close()
  fakeSse = installFakeEventSource()
})
afterEach(() => {
  for (const w of mounted) w.unmount()
  mounted.length = 0
  vi.unstubAllGlobals()
})

const tool = (name: string, risk = 'read', extra: Record<string, unknown> = {}) => ({
  name,
  description: `${name} 工具`,
  parameters: { type: 'object', properties: { path: { type: 'string' } } },
  serviceId: 'fs-tools',
  risk,
  enabled: true,
  ...extra,
})

async function mountView() {
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 202 }))
  const wrapper = mount(ToolsView)
  mounted.push(wrapper)
  await flushPromises()
  return { wrapper, fetchMock }
}

describe('ToolsView（widget.tools）', () => {
  it('空目录 → 空态', async () => {
    const { wrapper } = await mountView()
    expect(wrapper.text()).toContain('目录为空')
  })

  it('tools.state → 目录按服务分组渲染，风险徽章 + 冲突 + 自动只读', async () => {
    const { wrapper } = await mountView()
    fakeSse.emit('tools.state', {
      tools: [tool('read'), tool('bash', 'proc'), tool('write', 'write', { conflict: true, managedBy: 'auto' })],
      policies: { read: 'auto', bash: 'ask' },
      constraints: {},
      mcpServers: [],
    })
    await flushPromises()
    expect(wrapper.find('[data-testid="tv-row-read"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="tv-row-bash"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('同名冲突')
    expect(wrapper.text()).toContain('只读（自动）')
    // 自动管理的行不给策略开关
    expect(wrapper.find('[data-testid="tv-policy-write"]').exists()).toBe(false)
  })

  it('改策略 → 发 tools.set{ policies }', async () => {
    const { wrapper, fetchMock } = await mountView()
    fakeSse.emit('tools.state', { tools: [tool('read')], policies: { read: 'auto' }, constraints: {}, mcpServers: [] })
    await flushPromises()
    const sel = wrapper.findAllComponents(Select).find((c) => c.attributes('data-testid') === 'tv-policy-read')!
    sel.vm.$emit('update:modelValue', 'ask')
    await flushPromises()
    const cmd = commandBodies(fetchMock).find((b) => b.topic === 'tools.set')!
    expect(cmd?.payload).toMatchObject({ policies: { read: 'ask' } })
  })

  it('审批 Tab → 渲染请求，批准发 tool.approval.resolved{approved:true}', async () => {
    const { wrapper, fetchMock } = await mountView()
    fakeSse.emit('tool.approval.requested', {
      requestId: 'r1',
      sessionId: 's1',
      toolName: 'bash',
      risk: 'proc',
      kind: 'exec',
      arguments: '{"command":"ls"}',
    })
    await flushPromises()
    await wrapper.get('[data-testid="tv-tab-approval"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid="tv-approval"]').exists()).toBe(true)
    const approve = wrapper.findAll('button').find((b) => b.text() === '批准')!
    await approve.trigger('click')
    await flushPromises()
    const cmd = commandBodies(fetchMock).find((b) => b.topic === 'tool.approval.resolved')!
    expect(cmd?.payload).toMatchObject({ requestId: 'r1', approved: true })
  })

  it('试调 Tab → 跑工具发 tools.invoke', async () => {
    const { wrapper, fetchMock } = await mountView()
    fakeSse.emit('tools.state', { tools: [tool('read')], policies: {}, constraints: {}, mcpServers: [] })
    await flushPromises()
    await wrapper.get('[data-testid="tv-tab-invoke"]').trigger('click')
    await flushPromises()
    const sel = wrapper.findAllComponents(Select).find((c) => c.attributes('data-testid') === 'tv-invoke-tool')!
    sel.vm.$emit('update:modelValue', 'read')
    await flushPromises()
    await wrapper.get('[data-testid="tv-invoke-run"]').trigger('click')
    await flushPromises()
    const cmd = commandBodies(fetchMock).find((b) => b.topic === 'tools.invoke')!
    expect(cmd?.payload).toMatchObject({ name: 'read' })
    expect(String((cmd?.payload as { arguments?: string }).arguments)).toContain('path')
  })

  it('MCP Tab → 非法 JSON 不发命令，合法则发 tools.mcp.set', async () => {
    const { wrapper, fetchMock } = await mountView()
    await wrapper.get('[data-testid="tv-tab-mcp"]').trigger('click')
    await flushPromises()
    const ta = wrapper.get('[data-testid="tv-mcp-json"]')
    await ta.setValue('{ not json')
    const save = wrapper.findAll('button').find((b) => b.text() === '保存')!
    await save.trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid="tv-mcp-error"]').exists()).toBe(true)
    await ta.setValue(JSON.stringify([{ id: 'srv', transport: 'stdio', command: 'node' }]))
    await save.trigger('click')
    await flushPromises()
    const cmd = commandBodies(fetchMock).find((b) => b.topic === 'tools.mcp.set')!
    expect(cmd?.payload).toMatchObject({ servers: [{ id: 'srv', transport: 'stdio', command: 'node' }] })
  })

  it('事件 Tab → 展示收到的事件', async () => {
    const { wrapper } = await mountView()
    fakeSse.emit('tools.state', { tools: [tool('read')], policies: {}, constraints: {}, mcpServers: [] })
    await flushPromises()
    await wrapper.get('[data-testid="tv-tab-events"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid="tv-events"]').text()).toContain('tools.state')
  })

  /**
   * 回归：面板是**后打开的**，闸门早就播完了。
   *
   * 之前这里只订阅、不问，于是「对话里工具能跑，工具面板永远显示目录为空」——
   * 用户看到的是「工具组件坏了」。现在连上就问一次 `tools.list`。
   */
  it('挂载即主动问一次目录（tools.list）—— 否则后打开的面板永远是空目录', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 202 }))
    // 先播一条：此时还没有订阅者，等价于「闸门在面板打开前已经播过」
    fakeSse.emit('tools.state', { tools: [tool('read')], policies: {}, constraints: {}, mcpServers: [] })
    const wrapper = mount(ToolsView)
    mounted.push(wrapper)
    await flushPromises()

    expect(commandBodies(fetchMock).some((b) => b.topic === 'tools.list')).toBe(true)
    // 面板此刻确实是空的（没收到重播），而闸门收到 tools.list 后会整份重播
    expect(wrapper.text()).toContain('目录为空')
    fakeSse.emit('tools.state', { tools: [tool('read'), tool('ls')], policies: {}, constraints: {}, mcpServers: [] })
    await flushPromises()
    expect(wrapper.text()).toContain('ls')
    expect(wrapper.text()).not.toContain('目录为空')
  })

  it('卸载时摘掉订阅：重开面板不会把同一条事件处理两次', async () => {
    const first = await mountView()
    first.wrapper.unmount()
    mounted.length = 0
    const second = await mountView()
    fakeSse.emit('tools.state', { tools: [tool('read')], policies: {}, constraints: {}, mcpServers: [] })
    await flushPromises()
    await second.wrapper.get('[data-testid="tv-tab-events"]').trigger('click')
    await flushPromises()
    // 只该有一条「1 个工具」—— 订阅没摘的话会叠成两条（而且后续每次重开都更多）
    const rows = second.wrapper.findAll('[data-testid="tv-events"] li')
    const stateRows = rows.filter((r) => r.text().includes('tools.state'))
    expect(stateRows).toHaveLength(1)
  })
})
