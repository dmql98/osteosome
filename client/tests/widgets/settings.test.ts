/**
 * 设置 Pane 套件单测（P4 WS-4）。
 *
 * 基础设施（useTheme / initTheme / initLocale）直接单测——不依赖组件挂载；
 * 组件级只断言关键渲染（provider 行 / static 角标 / 凭证掩码 / Tab 文案），
 * select 交互用原生 element.value + change 事件触发（Select 的 options 是 prop，setValue 不可靠）。
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { i18n, initLocale, DEFAULT_LOCALE } from '../../src/i18n'
import { UiPlugin } from '../../src/components/ui'
import { initTheme, useTheme, DEFAULT_THEME, type Theme } from '../../src/core-sdk/useTheme'

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

import SettingsPaneView from '../../src/widgets/settings/SettingsPaneView.vue'
import LlmSettings from '../../src/widgets/settings/llm/LlmSettings.vue'

const DESCRIPTOR = {
  provider: 'openai',
  defaultModel: 'gpt-4o-mini',
  credentialRef: 'env:OPENAI_API_KEY',
  retryPolicy: { maxAttempts: 3, baseDelayMs: 500, backoff: 'exponential', retryableCodes: ['rate_limited'] },
}

function emit(topic: string, payload: unknown): void {
  sseHandlers.get(topic)?.(payload)
}

function setSelect(wrapper: ReturnType<typeof mount>, index: number, value: string): Promise<void> {
  const el = wrapper.findAll('select')[index]
  if (!el) throw new Error(`no select at index ${index}`)
  const element = el.element as HTMLSelectElement
  element.value = value
  return el.trigger('change')
}

beforeEach(() => {
  sseHandlers.clear()
  setActivePinia(createPinia())
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ credentials: [] }), { status: 200 })))
  document.documentElement.removeAttribute('data-theme')
  ;(i18n.global.locale as { value: string }).value = 'zh-CN'
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('主题基础设施（useTheme / initTheme）', () => {
  it('initTheme 挂载即读 preferences → 设 data-theme（dark 恢复）', async () => {
    await initTheme(async () => ({ 'ui.theme': 'dark' }))
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
  })

  it('preferences 无 theme → 默认 light', async () => {
    await initTheme(async () => ({}))
    expect(document.documentElement.getAttribute('data-theme')).toBe(DEFAULT_THEME)
  })

  it('setTheme 即时改 DOM（不等刷新）', () => {
    const { setTheme } = useTheme()
    setTheme('dark')
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
    setTheme('light')
    expect(document.documentElement.getAttribute('data-theme')).toBe('light')
  })
})

describe('i18n 基础设施（initLocale）', () => {
  it('读 preferences 恢复 locale（en）', async () => {
    await initLocale(async () => ({ 'ui.locale': 'en' }))
    expect((i18n.global.locale as { value: string }).value).toBe('en')
  })

  it('无 locale / 非法 → 默认 zh-CN', async () => {
    await initLocale(async () => ({}))
    expect((i18n.global.locale as { value: string }).value).toBe(DEFAULT_LOCALE)
  })

  it('resources 按命名空间：settings.tabs.llm / llm.provider / common.save 均可达', () => {
    expect(i18n.global.t('settings.tabs.llm')).toBe('LLM')
    expect(i18n.global.t('llm.provider')).toBeTruthy()
    expect(i18n.global.t('common.save')).toBeTruthy()
  })
})

describe('SettingsPaneView 壳', () => {
  it('渲染 LLM / 界面 / 高级 三个 Tab（i18n 文案）', async () => {
    const wrapper = mount(SettingsPaneView, { global: { plugins: [createPinia(), i18n, UiPlugin] } })
    await flushPromises()
    const text = wrapper.text()
    expect(text).toContain('LLM')
    expect(text).toContain('界面')
    expect(text).toContain('高级')
  })
})

describe('LlmSettings LLM 设置', () => {
  it('provider registered → 列表行 + 启停开关发 service.stop', async () => {
    const fetchMock = vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 202 }))
    const wrapper = mount(LlmSettings, { global: { plugins: [createPinia(), i18n, UiPlugin] } })
    emit('llm.provider.registered', DESCRIPTOR)
    await wrapper.vm.$nextTick()
    expect(wrapper.text()).toContain('openai')
    const switches = wrapper.findAll('.ui-switch')
    expect(switches.length).toBeGreaterThan(0)
    await switches[0].trigger('click')
    const bodies = fetchMock.mock.calls
      .filter((c) => String(c[0]).includes('/api/command'))
      .map((c) => JSON.parse(String((c[1] as { body?: unknown }).body)))
    expect(bodies.some((b) => b.topic === 'service.stop')).toBe(true)
  })

  it('模型下拉：选 provider → 发 llm.models.list；result static → 角标 + 模型填充', async () => {
    const fetchMock = vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 202 }))
    const wrapper = mount(LlmSettings, { global: { plugins: [createPinia(), i18n, UiPlugin] } })
    emit('llm.provider.registered', DESCRIPTOR)
    await wrapper.vm.$nextTick()
    // select[0] = provider 选择
    await setSelect(wrapper, 0, 'openai')
    const bodies = fetchMock.mock.calls
      .filter((c) => String(c[0]).includes('/api/command'))
      .map((c) => JSON.parse(String((c[1] as { body?: unknown }).body)))
    expect(bodies.some((b) => b.topic === 'llm.models.list')).toBe(true)
    emit('llm.models.list.result', {
      requestId: 'models-1',
      provider: 'openai',
      models: ['gpt-4o-mini', 'gpt-4o'],
      source: 'static',
    })
    await wrapper.vm.$nextTick()
    expect(wrapper.text()).toContain('静态列表')
    expect(wrapper.text()).toContain('gpt-4o-mini')
  })

  it('凭证：GET 掩码列表可见；新建 PUT 后刷新出现新凭证', async () => {
    const fetchMock = vi.mocked(fetch)
    let saved = false
    fetchMock.mockImplementation(async (input: unknown, init?: { method?: string; body?: unknown }) => {
      const url = String(input)
      if (url.includes('/api/credentials') && init?.method === 'PUT') {
        saved = true
        return new Response(JSON.stringify({ id: 'c1', name: 'k1', provider: 'openai', masked: 'sk-…' }), { status: 200 })
      }
      if (url.includes('/api/credentials')) {
        return new Response(
          JSON.stringify({ credentials: saved ? [{ id: 'c1', name: 'k1', provider: 'openai', masked: 'sk-…' }] : [] }),
          { status: 200 },
        )
      }
      return new Response(null, { status: 202 })
    })
    const wrapper = mount(LlmSettings, { global: { plugins: [createPinia(), i18n, UiPlugin] }, attachTo: document.body })
    await flushPromises()
    expect(wrapper.text()).toContain('新建凭证')
    // 打开 Modal → 填密文 → 保存（Modal 用 Teleport，内容在 document.body）
    await wrapper.findAll('button').find((b) => b.text().includes('新建凭证'))?.trigger('click')
    await wrapper.vm.$nextTick()
    const bodyInputs = Array.from(document.body.querySelectorAll('input'))
    const valueInput = bodyInputs.find((i) => i.getAttribute('aria-label') === 'credential-value')
    expect(valueInput).toBeTruthy()
    ;(valueInput as HTMLInputElement).value = 'sk-secret-value'
    valueInput!.dispatchEvent(new Event('input', { bubbles: true }))
    await wrapper.vm.$nextTick()
    const saveBtn = Array.from(document.body.querySelectorAll('button')).find((b) => b.textContent?.trim() === '保存')
    expect(saveBtn).toBeTruthy()
    saveBtn!.click()
    await flushPromises()
    expect(saved).toBe(true)
    expect(wrapper.text()).toContain('k1')
    wrapper.unmount()
    document.body.innerHTML = ''
  })
})
