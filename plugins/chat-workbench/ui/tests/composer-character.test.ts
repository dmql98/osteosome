/**
 * composer 的角色选择器（P5）—— 装 agents 才有下拉；选角色 → `loop.run` 带 characterId。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { installFakeEventSource, type FakeEventSource } from '@osteosome/core-client/testing'
import { sse } from '@osteosome/core-client'
import ChatComposerView from '../src/views/ChatComposerView.vue'
import { __resetSessionSyncForTest, setCurrentSessionId } from '../src/state/session-sync'

const DESCRIPTOR = {
  provider: 'deepseek',
  defaultModel: 'deepseek-chat',
  credentialRef: 'env:DEEPSEEK_API_KEY',
  retryPolicy: { maxAttempts: 3, baseDelayMs: 500, backoff: 'exponential', retryableCodes: ['rate_limited'] },
}

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
  __resetSessionSyncForTest()
})
afterEach(() => {
  for (const w of mounted) w.unmount()
  mounted.length = 0
  vi.unstubAllGlobals()
})

async function mountComposer() {
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 202 }))
  setCurrentSessionId('s1')
  const composer = mount(ChatComposerView)
  mounted.push(composer)
  await flushPromises()
  fakeSse.emit('llm.provider.registered', DESCRIPTOR)
  await flushPromises()
  return { composer, fetchMock }
}

describe('composer · 角色选择器（P5）', () => {
  it('没装 agents（无 agent.state）→ 角色下拉不出现', async () => {
    const { composer } = await mountComposer()
    expect(composer.find('[data-testid="composer-character"]').exists()).toBe(false)
  })

  it('agent.state → 角色下拉出现，含「裸会话」+ 各角色', async () => {
    const { composer } = await mountComposer()
    fakeSse.emit('agent.state', {
      characters: [
        { id: 'reviewer', name: '评审员', emoji: '🧐', prompt: '你是评审员', skills: [], tools: '*' },
      ],
    })
    await flushPromises()
    const select = composer.get('[data-testid="composer-character"] select')
    const opts = select.findAll('option').map((o) => o.text())
    expect(opts[0]).toContain('裸会话')
    expect(opts.some((t) => t.includes('评审员'))).toBe(true)
  })

  it('选角色后发问 → loop.run 带 characterId', async () => {
    const { composer, fetchMock } = await mountComposer()
    fakeSse.emit('agent.state', {
      characters: [{ id: 'reviewer', name: '评审员', prompt: '你是评审员', skills: [], tools: '*' }],
    })
    await flushPromises()
    const el = composer.get('[data-testid="composer-character"] select').element as HTMLSelectElement
    el.value = 'reviewer'
    await composer.get('[data-testid="composer-character"] select').trigger('change')
    await flushPromises()

    await composer.get('[data-testid="composer-input"]').setValue('帮我看这段')
    await composer.get('form').trigger('submit')
    await flushPromises()
    const run = commandBodies(fetchMock).find((b) => b.topic === 'loop.run')!
    expect((run.payload as { characterId?: string }).characterId).toBe('reviewer')
  })

  it('不选角色（保持裸会话）→ loop.run 不带 characterId', async () => {
    const { composer, fetchMock } = await mountComposer()
    fakeSse.emit('agent.state', { characters: [{ id: 'reviewer', name: '评审员', prompt: 'x', skills: [], tools: '*' }] })
    await flushPromises()
    await composer.get('[data-testid="composer-input"]').setValue('hi')
    await composer.get('form').trigger('submit')
    await flushPromises()
    const run = commandBodies(fetchMock).find((b) => b.topic === 'loop.run')!
    expect((run.payload as { characterId?: string }).characterId).toBeUndefined()
  })
})
