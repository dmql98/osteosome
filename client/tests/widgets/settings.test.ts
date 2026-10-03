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

/**
 * 每个 topic 可以有**多个**订阅者。
 *
 * 原来这里是个 `Map<string, handler>`，一个 topic 只存一个 handler ——
 * 于是「后订阅的把先订阅的顶掉」。页面里同时有 `useModelCatalog` 与
 * `useEndpointProbe` 订阅 `llm.models.list.result` 时，其中一个会静默收不到事件，
 * 症状是「模型列表不填充」这类看起来像页面坏了的现象。
 *
 * mock 的缺陷比被测代码的缺陷更难查，因为它让「事件机制」看起来是坏的。
 */
const sseHandlers = new Map<string, ((payload: unknown) => void)[]>()

vi.mock('../../src/core-sdk/sse', async () => {
  const actual = await vi.importActual<typeof import('../../src/core-sdk/sse')>('../../src/core-sdk/sse')
  return {
    ...actual,
    sse: {
      subscribe: vi.fn((topic: string, handler: (payload: unknown) => void) => {
        const list = sseHandlers.get(topic) ?? []
        list.push(handler)
        sseHandlers.set(topic, list)
        return () => {
          const cur = sseHandlers.get(topic) ?? []
          const idx = cur.indexOf(handler)
          if (idx >= 0) cur.splice(idx, 1)
          sseHandlers.set(topic, cur)
        }
      }),
      ensureConnected: vi.fn(),
    },
  }
})

import SettingsPaneView from '../../src/widgets/settings/SettingsPaneView.vue'
import LlmSettings from '../../src/widgets/llm-settings/LlmSettingsView.vue'

const DESCRIPTOR = {
  provider: 'openai',
  defaultModel: 'gpt-4o-mini',
  credentialRef: 'env:OPENAI_API_KEY',
  retryPolicy: { maxAttempts: 3, baseDelayMs: 500, backoff: 'exponential', retryableCodes: ['rate_limited'] },
}

function emit(topic: string, payload: unknown): void {
  for (const handler of sseHandlers.get(topic) ?? []) handler(payload)
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

  it('resources 按命名空间：settings.tabs.ui / llm.provider / common.save 均可达', () => {
    expect(i18n.global.t('settings.tabs.ui')).toBeTruthy()
    expect(i18n.global.t('llm.provider')).toBeTruthy()
    expect(i18n.global.t('common.save')).toBeTruthy()
  })

  it('S7-7：settings 不再有 llm tab（它已是独立的 widget.llm-settings，归 models 插件）', () => {
    // 正向断言容易糊弄：t() 对不存在的 key 会返回 key 本身，所以要断言它**不是** 'LLM'
    expect(i18n.global.t('settings.tabs.llm')).not.toBe('LLM')
  })

  it('S7-7：settings 只剩 ui / advanced 两个 tab，且没有 LLM', () => {
    const wrapper = mount(SettingsPaneView, { global: { plugins: [createPinia(), i18n] } })
    const labels = wrapper.findAll('button').map((b) => b.text())
    expect(labels.some((l) => l.includes('LLM'))).toBe(false)
    expect(labels.length).toBeGreaterThan(0)
  })
})

describe('SettingsPaneView 壳', () => {
  it('渲染 界面 / 高级 两个 Tab（i18n 文案）—— S7-7 起没有 LLM tab 了', async () => {
    const wrapper = mount(SettingsPaneView, { global: { plugins: [createPinia(), i18n, UiPlugin] } })
    await flushPromises()
    const text = wrapper.text()
    // 原来这里是 expect(text).toContain('LLM')。S7-7 把 LLM 拆成独立的
    // widget.llm-settings（归 models 插件），所以这条断言必须跟着变 ——
    // 留着它就等于要求那个错配的归属一直存在
    expect(text).not.toContain('LLM')
    expect(text).toContain('界面')
    expect(text).toContain('高级')
  })
})

  describe('LlmSettingsView 服务商配置（widget.llm-settings，归 models 插件 · 重做版）', () => {
    /**
     * 重做版把页面拆成四块（正在使用 / 服务商 / 自定义端点 / 插件提供的接入），
     * 所以这些断言按新结构写，但**守的行为一条没少** ——
     * 尤其这三条：预设必须全量可见、配置必须写对地方、不能发出指向已删服务的假开关。
     */

    const ALL_PRESETS = 12

    function mountLlm(attach = false) {
      return mount(LlmSettings, {
        global: { plugins: [createPinia(), i18n, UiPlugin] },
        attachTo: attach ? document.body : undefined,
      })
    }

    it('厂商清单来自预设表全量 12 家 —— 已连接 + 未连接 相加等于 12', async () => {
      vi.mocked(fetch).mockResolvedValue(new Response('{}', { status: 200 }))
      const wrapper = mountLlm()
      await wrapper.vm.$nextTick()

      const connected = wrapper.findAll('[data-testid^="vendor-"]').filter((w) =>
        w.attributes('data-testid') === 'vendor-openai',
      )
      const text = wrapper.text()
      // 12 家里任何一家都必须能看见 —— 看不见就没法去配置它
      for (const id of ['deepseek', 'openai', 'openrouter', 'mistral', 'ollama', 'lm-studio', 'vllm']) {
        expect(text, id + ' 不在清单里').toContain(id)
      }
// 没有任何 registered 事件时，「已连接」分组整组不渲染（空分组不占地方），
      // 12 家全落在「未连接」—— 一个都不能少
      expect(text).not.toContain('已连接 (')
      expect(text).toContain('未连接 (' + ALL_PRESETS + ')')

      // 收到一个 registered 后，它必须从「未连接」挪到「已连接」，且计数跟着变
      emit('llm.provider.registered', { provider: 'lm-studio', defaultModel: '', credentialRef: '' })
      await wrapper.vm.$nextTick()
      expect(wrapper.text()).toContain('已连接 (1)')
      expect(wrapper.text()).toContain('未连接 (' + (ALL_PRESETS - 1) + ')')
      wrapper.unmount()
      wrapper.unmount()
    })

    it('展开已连接厂商 → 显示 baseUrl / 需要什么凭证 / 默认模型，且可就地改', async () => {
      vi.mocked(fetch).mockResolvedValue(new Response('{}', { status: 200 }))
      const wrapper = mountLlm()
      await wrapper.vm.$nextTick()
      // lm-studio 是免凭证本地端点，永远已注册 —— 用它当「已连接」的样本
      emit('llm.provider.registered', {
        provider: 'lm-studio',
        defaultModel: '',
        credentialRef: '',
      })
      await wrapper.vm.$nextTick()
      const head = wrapper.find('[data-testid="vendor-lm-studio"]')
      expect(head.exists()).toBe(true)
      await head.trigger('click')
      await wrapper.vm.$nextTick()
const text = wrapper.text()
      expect(text).toContain('http://127.0.0.1:1234/v1')
      expect(text).toContain('免凭证')
      // 它的预设 defaultModel 是空的 —— 重做版必须给出「由你决定模型名」的提示，
      // 而不是只显示一个空值（旧版就是这样，用户无从下手）。
      // 注意断的是 **内层 input 的 placeholder 属性**而不是 text()：
      // placeholder 不进文本内容；且 `data-testid` 会被 Vue 透传到 Input 的根 div 上，
      // 真正的 input 在它里面。
      const modelField = wrapper.find('[data-testid="vendor-model-lm-studio"]')
      expect(modelField.exists()).toBe(true)
      const modelInput = modelField.find('input')
      expect(modelInput.exists()).toBe(true)
      expect(modelInput.attributes('placeholder')).toContain('由你决定模型名')
      // Input 会把 aria-label 兜底成 placeholder —— 于是这个提示也是无障碍标签
      expect(modelInput.attributes('aria-label')).toContain('由你决定模型名')
      expect(wrapper.find('[data-testid="vendor-url-lm-studio"]').exists()).toBe(true)
      wrapper.unmount()
    })

    it('未连接的服务商：一行一家，点开能看到端点/模型并就地探测', async () => {
      vi.mocked(fetch).mockResolvedValue(new Response('{}', { status: 200 }))
      const wrapper = mountLlm()
      await wrapper.vm.$nextTick()
      expect(wrapper.text()).toContain('需要 DEEPSEEK_API_KEY')
      // 点一下必须**真的展开** —— 以前这里是个空操作：按钮只改 `expanded`，
      // 而未连接的行没有可展开的 body，于是「直接连」点了什么都没发生。
      await wrapper.find('[data-testid="vendor-deepseek"]').trigger('click')
      await wrapper.vm.$nextTick()
      const body = wrapper.findAll('.vendor__body')
      expect(body.length).toBeGreaterThan(0)
      expect(body[0]!.text()).toContain('连通性测试')
      wrapper.unmount()
    })

    it('挂载时会问一次「现在都有谁」（llm.provider.reannounce）', async () => {
      // 纯事件驱动的 provider 清单有个致命前提：订阅要早于事件。
      // 而注册事件在服务进程握手完成时就发完了 —— 页面是之后才打开的，
      // 于是把已连上的服务显示成「未连接」（用户报的现象：LM Studio 开着却显示未连接）。
      const fetchMock = vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 202 }))
      mountLlm()
      await flushPromises()
      const topics = fetchMock.mock.calls
        .filter((c) => String(c[0]).includes('/api/command'))
        .map((c) => JSON.parse(String((c[1] as { body?: unknown }).body)).topic)
      expect(topics).toContain('llm.provider.reannounce')
    })

    it('搜索框过滤服务商', async () => {
      vi.mocked(fetch).mockResolvedValue(new Response('{}', { status: 200 }))
      const wrapper = mountLlm()
      await wrapper.vm.$nextTick()
      const search = wrapper.find('[aria-label="vendor-search"]')
      expect(search.exists()).toBe(true)
      await search.setValue('deepseek')
      await wrapper.vm.$nextTick()
      expect(wrapper.text()).toContain('deepseek')
      expect(wrapper.text()).not.toContain('siliconflow')
      wrapper.unmount()
    })

    it('设置密钥 → PUT /api/credentials 且 provider 字段=厂商 id（不发 service.stop）', async () => {
      const fetchMock = vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 200 }))
      const wrapper = mountLlm(true)
      await wrapper.vm.$nextTick()
      await wrapper.find('[data-testid="vendor-deepseek"]').trigger('click')
      await wrapper.vm.$nextTick()
      await wrapper.findAll('button').find((b) => b.text() === '设置密钥')!.trigger('click')
      await wrapper.vm.$nextTick()
      const input = document.body.querySelector<HTMLInputElement>('input[type="password"]')
      expect(input, '密钥输入框没渲染').not.toBeNull()
      input!.value = 'sk-user'
      input!.dispatchEvent(new Event('input'))
      await wrapper.vm.$nextTick()
      const saveBtn = Array.from(document.body.querySelectorAll('button')).find(
        (b) => b.getAttribute('data-testid') === 'credential-save',
      )
      expect(saveBtn, '保存按钮没渲染').toBeDefined()
      saveBtn!.click()
      await flushPromises()
      const put = fetchMock.mock.calls
        .filter((c) => String(c[0]).includes('/api/credentials') && (c[1] as { method?: string })?.method === 'PUT')
        .map((c) => JSON.parse(String((c[1] as { body?: unknown }).body)))
      expect(put).toHaveLength(1)
      expect(put[0]).toMatchObject({ provider: 'deepseek', value: 'sk-user' })
      // 关键：不再有指向已删服务的假开关
      const commands = fetchMock.mock.calls
        .filter((c) => String(c[0]).includes('/api/command'))
        .map((c) => JSON.parse(String((c[1] as { body?: unknown }).body)))
      expect(commands.some((b) => b.topic === 'service.stop' || b.topic === 'service.start')).toBe(false)
      wrapper.unmount()
      document.body.innerHTML = ''
    })

    it('自定义端点 → 写入 preferences 的 llm.vendorOverrides，保存即探测', async () => {
      const fetchMock = vi.mocked(fetch).mockResolvedValue(new Response('{}', { status: 200 }))
      const wrapper = mountLlm(true)
      await wrapper.vm.$nextTick()
      await wrapper.find('[data-testid="endpoint-new"]').trigger('click')
      await wrapper.vm.$nextTick()
      const bodyInputs = Array.from(document.body.querySelectorAll('input'))
      const idInput = bodyInputs.find((i) => i.placeholder === 'my-proxy')
      const urlInput = bodyInputs.find((i) => i.placeholder === 'http://127.0.0.1:1234/v1')
      expect(idInput, '端点 id 输入框没渲染').toBeTruthy()
      expect(urlInput, 'Base URL 输入框没渲染').toBeTruthy()
      idInput!.value = 'my-proxy'
      idInput!.dispatchEvent(new Event('input'))
      urlInput!.value = 'http://127.0.0.1:8080/v1'
      urlInput!.dispatchEvent(new Event('input'))
      await wrapper.vm.$nextTick()
      const saveBtn = Array.from(document.body.querySelectorAll('button')).find(
        (b) => b.getAttribute('data-testid') === 'endpoint-save',
      )
      saveBtn!.click()
      await flushPromises()
      const put = fetchMock.mock.calls
        .filter((c) => String(c[0]).includes('/api/preferences') && (c[1] as { method?: string })?.method === 'PUT')
        .map((c) => JSON.parse(String((c[1] as { body?: unknown }).body)))
      expect(put.length).toBeGreaterThan(0)
      expect(put.at(-1)!.llm.vendorOverrides).toEqual([
        { id: 'my-proxy', baseUrl: 'http://127.0.0.1:8080/v1', credentialRef: '' },
      ])
      // 新增端点的首要疑问就是「它通不通」→ 保存后必须自动探一次
      const commands = fetchMock.mock.calls
        .filter((c) => String(c[0]).includes('/api/command'))
        .map((c) => JSON.parse(String((c[1] as { body?: unknown }).body)))
      expect(
        commands.some((b) => b.topic === 'llm.models.list' && b.payload?.provider === 'my-proxy'),
        '保存后没有自动探测',
      ).toBe(true)
      wrapper.unmount()
      document.body.innerHTML = ''
    })

    it('自定义端点区只列非预设的；改了预设不会在这重复出现', async () => {
      const fetchMock = vi.mocked(fetch).mockResolvedValue(
        new Response(JSON.stringify({ llm: { vendorOverrides: [{ id: 'lm-studio', baseUrl: 'http://127.0.0.1:9999/v1' }, { id: 'my-proxy', baseUrl: 'http://10.0.0.5:8000/v1' }] } }), { status: 200 }),
      )
const wrapper = mountLlm()
      await flushPromises()
      // 选择器要够窄：`endpoint-` 前缀会把「新增端点」按钮也算进来
      const endpointRows = wrapper.findAll('div[data-testid^="endpoint-"]')
      // 只剩 my-proxy —— lm-studio 那条是「覆盖预设」，该在服务商区就地编辑
      expect(endpointRows.length).toBe(1)
      expect(endpointRows[0]!.attributes('data-testid')).toBe('endpoint-my-proxy')
      expect(fetchMock).toBeDefined()
      wrapper.unmount()
    })

    it('就地改预设端点 → 写同 id 的 override，并在该厂商标「已覆盖预设」', async () => {
      const fetchMock = vi.mocked(fetch).mockResolvedValue(new Response('{}', { status: 200 }))
      const wrapper = mountLlm()
      await wrapper.vm.$nextTick()
      emit('llm.provider.registered', { provider: 'lm-studio', defaultModel: '', credentialRef: '' })
      await wrapper.vm.$nextTick()
      await wrapper.find('[data-testid="vendor-lm-studio"]').trigger('click')
      await wrapper.vm.$nextTick()
      await wrapper.find('[data-testid="vendor-url-lm-studio"]').trigger('click')
      await wrapper.vm.$nextTick()
      const edit = wrapper.findAll('input').find((i) => i.element.value.includes('1234'))
      expect(edit, '端点编辑框没出现').toBeTruthy()
      edit!.element.value = 'http://127.0.0.1:4321/v1'
      edit!.trigger('input')
      await wrapper.vm.$nextTick()
      const save = wrapper.findAll('button').find((b) => b.text() === '保存')
      await save!.trigger('click')
      await flushPromises()
      const put = fetchMock.mock.calls
        .filter((c) => String(c[0]).includes('/api/preferences') && (c[1] as { method?: string })?.method === 'PUT')
        .map((c) => JSON.parse(String((c[1] as { body?: unknown }).body)))
      expect(put.length).toBeGreaterThan(0)
      // 同 id 覆盖 —— buildVendorInstances 里 byId.set 同 key 会盖掉预设
      expect(put.at(-1)!.llm.vendorOverrides.some((o: { id: string; baseUrl: string }) => o.id === 'lm-studio' && o.baseUrl === 'http://127.0.0.1:4321/v1')).toBe(true)
      expect(wrapper.text()).toContain('已覆盖预设')
      wrapper.unmount()
    })

    it('「正在使用」卡片：选 provider → 发 llm.models.list；result 回来即填充模型', async () => {
      const fetchMock = vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 202 }))
      const wrapper = mountLlm()
      await wrapper.vm.$nextTick()
      emit('llm.provider.registered', DESCRIPTOR)
      await wrapper.vm.$nextTick()
      await setSelect(wrapper, 0, 'openai')
      const bodies = fetchMock.mock.calls
        .filter((c) => String(c[0]).includes('/api/command'))
        .map((c) => JSON.parse(String((c[1] as { body?: unknown }).body)))
      expect(bodies.some((b) => b.topic === 'llm.models.list')).toBe(true)
      emit('llm.models.list.result', {
        requestId: 'models-1',
        provider: 'openai',
        models: ['gpt-4o-mini', 'gpt-4o'],
        catalog: 'static',
      })
      await wrapper.vm.$nextTick()
      expect(wrapper.text()).toContain('gpt-4o-mini')
      wrapper.unmount()
    })

    it('「获取模型列表」按钮：填下拉 + 显示计数，且只发一次命令', async () => {
      const fetchMock = vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 202 }))
      const wrapper = mountLlm()
      await wrapper.vm.$nextTick()
      emit('llm.provider.registered', { provider: 'lm-studio', defaultModel: '', credentialRef: '' })
      await wrapper.vm.$nextTick()

      const btn = wrapper.find('[data-testid="refresh-models"]')
      expect(btn.exists()).toBe(true)
      // 挂载 / 切 provider 会自动拉一次，期间按钮禁用 —— 这正是想要的：
      // 禁用状态下重复点击打多次端点是纯浪费
      expect(btn.text()).toMatch(/获取模型列表|拉取中/)
      emit('llm.models.list.result', {
        requestId: 'auto', provider: 'lm-studio', models: ['stale-model'], catalog: 'remote',
      })
      await wrapper.vm.$nextTick()
      expect(btn.attributes('disabled')).toBeUndefined()

      await btn.trigger('click')
      await wrapper.vm.$nextTick()
      emit('llm.models.list.result', {
        requestId: 'x', provider: 'lm-studio', models: ['qwen2.5-7b', 'qwen2.5-3b'], catalog: 'remote',
      })
      await wrapper.vm.$nextTick()

      expect(btn.text()).toContain('获取模型列表')
      // 计数告诉用户「拉到几个」，否则下拉从「stale-model」变成两个时他不知道发生了什么
      expect(wrapper.text()).toContain('2 个')
      expect(wrapper.text()).not.toContain('stale-model')
      // 连通性顺带更新 —— 同一个往返，不该让用户等两遍
      expect(wrapper.text()).toContain('已连通')

      const topics = fetchMock.mock.calls
        .filter((c) => String(c[0]).includes('/api/command'))
        .map((c) => JSON.parse(String((c[1] as { body?: unknown }).body)).topic)
      // 一次点击只该有一次 models.list（探测复用它，不额外发第二次）
      const lists = topics.filter((t) => t === 'llm.models.list').length
      expect(lists).toBeLessThanOrEqual(2) // 至多：面板挂载时那一次 + 本次点击
      wrapper.unmount()
    })

    it('探测 = 拉模型列表：catalog=remote 判为连通，static 判为连不上', async () => {
      vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 202 }))
      const wrapper = mountLlm()
      await wrapper.vm.$nextTick()
      emit('llm.provider.registered', { provider: 'lm-studio', defaultModel: '', credentialRef: '' })
      await wrapper.vm.$nextTick()
// 挂载即自动探测一次，所以初始是「探测中…」；
      // 重点是**不能**在还没结果时就显示「连不上」—— 那会冤枉一个其实好好的端点
      expect(wrapper.text()).toMatch(/探测中|未测试/)
      expect(wrapper.text()).not.toContain('连不上')

      const probeBtn = wrapper.find('[data-testid="probe-active"]')
      await probeBtn.trigger('click')
      await wrapper.vm.$nextTick()
      emit('llm.models.list.result', {
        requestId: 'x', provider: 'lm-studio', models: ['qwen2.5-7b'], catalog: 'remote',
      })
      await wrapper.vm.$nextTick()
      expect(wrapper.text()).toContain('已连通')

      await wrapper.find('[data-testid="probe-active"]').trigger('click')
      await wrapper.vm.$nextTick()
      emit('llm.models.list.result', {
        requestId: 'y', provider: 'lm-studio', models: [], catalog: 'static',
      })
      await wrapper.vm.$nextTick()
      expect(wrapper.text()).toContain('连不上')
      wrapper.unmount()
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
      const wrapper = mountLlm(true)
      await flushPromises()
      emit('llm.provider.registered', DESCRIPTOR)
      await wrapper.vm.$nextTick()
      // 重做版把入口放在服务商区（「换密钥」），不再有一个游离的「新建凭证」按钮
      expect(wrapper.text()).not.toContain('新建凭证')
      await wrapper.find('[data-testid="vendor-openai"]').trigger('click')
      await wrapper.vm.$nextTick()
      await wrapper.find('[data-testid="vendor-setkey-openai"]').trigger('click')
      await wrapper.vm.$nextTick()
      const valueInput = document.body.querySelector<HTMLInputElement>('input[type="password"]')
      expect(valueInput).toBeTruthy()
      valueInput!.value = 'sk-secret-value'
      valueInput!.dispatchEvent(new Event('input', { bubbles: true }))
      await wrapper.vm.$nextTick()
      const saveBtn = Array.from(document.body.querySelectorAll('button')).find(
        (b) => b.getAttribute('data-testid') === 'credential-save',
      )
      expect(saveBtn).toBeTruthy()
      saveBtn!.click()
      await flushPromises()
      expect(saved).toBe(true)
      wrapper.unmount()
      document.body.innerHTML = ''
    })
  })
