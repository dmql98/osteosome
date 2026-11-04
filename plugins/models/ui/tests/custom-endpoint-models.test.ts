/**
 * 自建端点（OpenAI 兼容端点）的**模型清单**链路：拉取 → 勾选 → 采纳进配置 → 行内模型墙。
 *
 * ## 为什么单独一个文件，而不是往 `llm-settings.test.ts` 里加
 *
 * 那个文件用 `node:fs` 读插件自带的 `catalog.json`，而它在 jsdom 环境下会被 Vite
 * 外部化成空模块（`fileURLToPath is not a function`）—— 这是**本机/环境的既有问题**，
 * 与新功能无关。这里改用最小目录（fetch 替身应答），于是这份用例在任何环境下都能跑，
 * 而它要守的正是这次改动：探测拿到的清单**不会**自动进配置，只有用户勾的才落盘。
 *
 * ## 断言看什么
 *
 * 看**发出去的命令**（`/api/command` 的 body）与**渲染出的文本**，不看内部状态：
 * 落盘位置（`models.prefs.set` 的 `vendorOverrides[].models`）才是 owner 真正读的东西。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { installFakeEventSource } from '@osteosome/core-client/testing'
import { sse } from '@osteosome/core-client'
import LlmSettings from '../src/views/LlmSettingsView.vue'

/** 最小可用厂商目录：一家预设就够了（本文件只测「非预设」的自建端点） */
const CATALOG_BODY = JSON.stringify({
  vendors: [
    {
      id: 'openai',
      label: 'OpenAI',
      baseUrl: 'https://api.openai.com/v1',
      api: 'openai',
      credentialEnv: 'OPENAI_API_KEY',
      defaultModel: 'gpt-4o-mini',
      models: ['gpt-4o-mini'],
    },
  ],
})

let fakeSse: ReturnType<typeof installFakeEventSource>

function emit(topic: string, payload: unknown): void {
  fakeSse.emit(topic, payload)
}

/** owner 重播接入清单（订阅式，必须晚于 mount） */
function emitPrefs(patch: Record<string, unknown> = {}): void {
  emit('models.prefs.state', {
    prefs: { connectedVendors: [], vendorOverrides: [], enabledModels: [], ...patch },
  })
}

/** 最后一次 `models.prefs.set` 的 patch */
function lastPatch(commands: Record<string, unknown>[]) {
  const set = commands.filter((b) => b.topic === 'models.prefs.set')
  const last = set.at(-1)
  if (!last) throw new Error('没有 models.prefs.set 命令')
  return (last.payload as { patch: Record<string, unknown> }).patch as {
    vendorOverrides: Array<Record<string, unknown>>
    enabledModels: string[]
    modelProfiles: Record<string, Record<string, unknown>>
  }
}

interface FetchSpy {
  /** 发到 `/api/command` 的命令体（按发送顺序） */
  commands: () => Record<string, unknown>[]
}

function installFetch(): FetchSpy {
  const bodies: string[] = []
  const fn = vi.fn(async (input: unknown, init?: { body?: unknown }) => {
    const url = String(input)
    if (url.includes('catalog.json')) return new Response(CATALOG_BODY, { status: 200 })
    if (url.includes('/api/command')) bodies.push(String(init?.body ?? ''))
    return new Response(null, { status: 202 })
  })
  vi.stubGlobal('fetch', fn)
  return { commands: () => bodies.map((b) => JSON.parse(b) as Record<string, unknown>) }
}

function mountLlm(attach = false) {
  const wrapper = mount(LlmSettings, { attachTo: attach ? document.body : undefined })
  return wrapper
}

/** 在 teleport 到 body 的弹窗里点某一行模型的勾选框 */
function clickCandidate(model: string): void {
  const label = document.body.querySelector<HTMLElement>(`[data-testid="model-pick-${model}"]`)
  if (!label) throw new Error(`弹窗里没有模型行 ${model}`)
  const input = label.querySelector<HTMLInputElement>('input')
  if (!input) throw new Error(`模型行 ${model} 里没有勾选框`)
  input.click()
}

function clickInBody(testId: string): void {
  const el = document.body.querySelector<HTMLElement>(`[data-testid="${testId}"]`)
  if (!el) throw new Error(`弹窗里没有 [data-testid="${testId}"]`)
  el.click()
}

beforeEach(() => {
  sse.close()
  fakeSse = installFakeEventSource()
})

afterEach(() => {
  vi.unstubAllGlobals()
  fakeSse?.restore()
  sse.close()
  vi.useRealTimers()
  document.body.innerHTML = ''
})

const CUSTOM = { id: 'my-proxy', baseUrl: 'http://10.0.0.5:8000/v1' }

describe('自建端点的模型清单（获取 → 勾选 → 采纳 → 模型墙）', () => {
  it('已采纳的清单直接进模型墙 —— 重启后不必先探测也看得见', async () => {
    installFetch()
    const wrapper = mountLlm()
    await flushPromises()
    emitPrefs({ vendorOverrides: [{ ...CUSTOM, models: ['qwen2.5-7b', 'qwen2.5-3b'] }] })
    await flushPromises()

    // 探测结果只在内存里，重启即空；已采纳的那份必须能独立撑起模型墙
    expect(wrapper.find('[data-testid="endpoint-my-proxy"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('2 个模型')
    expect(wrapper.text()).toContain('qwen2.5-7b')
    expect(wrapper.text()).toContain('已采纳 2 条')
    wrapper.unmount()
  })

  it('没采纳过清单时说清楚「只在探测结果里」，别让人误以为存住了', async () => {
    installFetch()
    const wrapper = mountLlm()
    await flushPromises()
    emitPrefs({ vendorOverrides: [CUSTOM] })
    await flushPromises()
    expect(wrapper.text()).toContain('只在探测结果里')
    wrapper.unmount()
  })

  it('「获取模型列表」→ 真发 llm.models.list → 弹窗只勾已配置的 → 采纳后写进 vendorOverrides', async () => {
    const spy = installFetch()
    const wrapper = mountLlm(true)
    await flushPromises()
    emitPrefs({ vendorOverrides: [{ ...CUSTOM, models: ['qwen2.5-7b'] }] })
    await flushPromises()

    await wrapper.find('[data-testid="ep-fetch-my-proxy"]').trigger('click')
    await flushPromises()
    expect(
      spy.commands().some((b) => b.topic === 'llm.models.list' && (b.payload as { provider?: string }).provider === 'my-proxy'),
      '没有向上游要清单',
    ).toBe(true)

    emit('llm.models.list.result', {
      requestId: 'x',
      provider: 'my-proxy',
      models: ['qwen2.5-7b', 'qwen2.5-3b'],
      catalog: 'remote',
    })
    await flushPromises()

    // 弹窗打开：候选两个，**只有已配置的那个是勾上的**（拉到的清单不等于采纳的清单）
    expect(document.body.textContent).toContain('模型清单 · my-proxy')
    const boxes = Array.from(document.body.querySelectorAll<HTMLInputElement>('.ui-checkbox__input'))
    expect(boxes.map((b) => b.checked)).toEqual([true, false])

    clickCandidate('qwen2.5-3b')
    await flushPromises()
    clickInBody('model-picker-save')
    await flushPromises()

    expect(lastPatch(spy.commands()).vendorOverrides).toEqual([
      { ...CUSTOM, models: ['qwen2.5-7b', 'qwen2.5-3b'] },
    ])
    // 采纳不改连通性 → 不应把探测结论清掉（清了会闪回「未测试」）
    expect(wrapper.text()).toContain('已连通')
    wrapper.unmount()
  })

  it('「编辑清单」不联网：端点挂了也能手填模型名并保存', async () => {
    const spy = installFetch()
    const wrapper = mountLlm(true)
    await flushPromises()
    emitPrefs({ vendorOverrides: [CUSTOM] })
    await flushPromises()

    await wrapper.find('[data-testid="ep-pick-my-proxy"]').trigger('click')
    await flushPromises()
    // 一个 models.list 都不该发 —— 这条路径是纯本地编辑
    expect(spy.commands().some((b) => b.topic === 'llm.models.list')).toBe(false)

    const manual = Array.from(document.body.querySelectorAll<HTMLInputElement>('input')).find((i) =>
      (i.placeholder ?? '').includes('手动添加模型名'),
    )
    expect(manual, '没有手填入口').toBeTruthy()
    manual!.value = 'qwen2.5:7b'
    manual!.dispatchEvent(new Event('input', { bubbles: true }))
    await flushPromises()
    clickInBody('model-picker-add')
    await flushPromises()
    clickInBody('model-picker-save')
    await flushPromises()

    expect(lastPatch(spy.commands()).vendorOverrides).toEqual([{ ...CUSTOM, models: ['qwen2.5:7b'] }])
    wrapper.unmount()
  })

  it('行内的默认模型与逐模型开关都作用在这个端点 id 上', async () => {
    const spy = installFetch()
    const wrapper = mountLlm()
    await flushPromises()
    emitPrefs({ vendorOverrides: [{ ...CUSTOM, models: ['qwen2.5-7b'] }] })
    await flushPromises()

    const modelInput = wrapper.find('[data-testid="ep-model-my-proxy"]').find('input')
    expect(modelInput.attributes('placeholder')).toContain('这个端点由你决定模型名')
    await modelInput.setValue('qwen2.5-7b')
    await flushPromises()
    expect(lastPatch(spy.commands()).vendorOverrides).toEqual([
      { ...CUSTOM, models: ['qwen2.5-7b'], defaultModel: 'qwen2.5-7b' },
    ])

    const sw = wrapper.findAll('[role="switch"]').find((w2) => w2.attributes('aria-label') === '模型 qwen2.5-7b')
    expect(sw, '模型开关没渲染').toBeTruthy()
    await sw!.trigger('click')
    await flushPromises()
    expect(lastPatch(spy.commands()).enabledModels).toEqual(['my-proxy::qwen2.5-7b'])
    wrapper.unmount()
  })

  it('编辑端点不会清掉已采纳的清单（表单不管清单，就不该把它带走）', async () => {
    const spy = installFetch()
    const wrapper = mountLlm(true)
    await flushPromises()
    emitPrefs({ vendorOverrides: [{ ...CUSTOM, models: ['qwen2.5-7b'] }] })
    await flushPromises()

    await wrapper.find('[data-testid="ep-edit-my-proxy"]').trigger('click')
    await flushPromises()
    const urlInput = Array.from(document.body.querySelectorAll<HTMLInputElement>('input')).find(
      (i) => (i.placeholder ?? '').includes('127.0.0.1:1234'),
    )
    expect(urlInput, '端点编辑框没出现').toBeTruthy()
    urlInput!.value = 'http://10.0.0.6:8000/v1'
    urlInput!.dispatchEvent(new Event('input', { bubbles: true }))
    await flushPromises()
    clickInBody('endpoint-save')
    await flushPromises()

    expect(lastPatch(spy.commands()).vendorOverrides).toEqual([
      { ...CUSTOM, baseUrl: 'http://10.0.0.6:8000/v1', models: ['qwen2.5-7b'] },
    ])
    wrapper.unmount()
  })

  /**
   * 回归：改默认模型**与连通性无关**，而且入口是一个显式按钮。
   *
   * 之前这里有三个问题叠在一起：
   * 1. 点模型名就等于设默认 —— 名字长得像标签，点它有副作用；
   * 2. 那次点击会 `probe.clear()`，角标从「远程」跳成「静态」（三态塌成两态）、
   *    状态退回「未测试」，没采纳过清单的端点连模型墙都空了；
   * 3. 默认项与非默认项长得几乎一样，看不出现在用的是哪个。
   */
  it('「设为默认」是单独按钮：点完仍显示已连通 + 远程，清单不丢，默认项换成标记', async () => {
    const spy = installFetch()
    const wrapper = mountLlm()
    await flushPromises()
    emitPrefs({ vendorOverrides: [{ ...CUSTOM, models: ['qwen2.5-7b', 'qwen2.5-3b'] }] })
    await flushPromises()
    // 注册即自动探测（页面 watch providerList 的行为），再投一条远程结果
    emit('llm.provider.registered', { provider: 'my-proxy', defaultModel: '', credentialRef: '' })
    await flushPromises()
    emit('llm.models.list.result', {
      requestId: 'p1',
      provider: 'my-proxy',
      models: ['qwen2.5-7b', 'qwen2.5-3b'],
      catalog: 'remote',
    })
    await flushPromises()
    expect(wrapper.text()).toContain('已连通')
    expect(wrapper.find('.mcard__src').text()).toBe('远程')

    // 模型名不再是按钮：点名字什么都不会发生
    expect(wrapper.findAll('button').some((b) => b.text() === 'qwen2.5-3b')).toBe(false)

    const setDefault = wrapper.find('[data-testid="model-default-qwen2.5-3b"]')
    expect(setDefault.exists(), '没有「设为默认」按钮').toBe(true)
    expect(setDefault.text()).toBe('设为默认')
    await setDefault.trigger('click')
    await flushPromises()

    // 设默认只改 defaultModel —— 探测结论与模型墙都必须原样
    expect(lastPatch(spy.commands()).vendorOverrides[0]).toMatchObject({ defaultModel: 'qwen2.5-3b' })
    expect(wrapper.text()).toContain('已连通')
    expect(wrapper.find('.mcard__src').text()).toBe('远程')
    expect(wrapper.findAll('.mcard').length).toBe(2)

    // 变成默认之后：按钮消失、只留标记（切走的那张反过来重新长出按钮）
    expect(wrapper.find('[data-testid="model-default-qwen2.5-3b"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="model-default-qwen2.5-7b"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('★ 默认')
    wrapper.unmount()
  })

  it('模型卡片的能力设置写进 modelProfiles（上下文 128K → 128000，逐项合并）', async () => {
    const spy = installFetch()
    const wrapper = mountLlm()
    await flushPromises()
    emitPrefs({ vendorOverrides: [{ ...CUSTOM, models: ['qwen2.5-7b'] }] })
    await flushPromises()

    await wrapper.find('[data-testid="model-settings-qwen2.5-7b"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid="model-profile-qwen2.5-7b"]').exists()).toBe(true)

    const context = wrapper.find('[data-testid="mp-context-qwen2.5-7b"] input')
    await context.setValue('128K')
    await context.trigger('change')
    await flushPromises()
    expect(lastPatch(spy.commands()).modelProfiles).toEqual({
      'my-proxy::qwen2.5-7b': { contextWindow: 128000 },
    })

    // 图片输入：文本是底座能力，勾图片即声明「能收图」
    await wrapper.find('[data-testid="mp-image-qwen2.5-7b"] input').setValue(true)
    await flushPromises()
    expect(lastPatch(spy.commands()).modelProfiles).toEqual({
      'my-proxy::qwen2.5-7b': { contextWindow: 128000, input: ['text', 'image'] },
    })

    // 思考档位：取消「高」→ 只剩 关/低/中
    await wrapper.find('[data-testid="mp-level-high-qwen2.5-7b"] input').setValue(false)
    await flushPromises()
    expect(lastPatch(spy.commands()).modelProfiles).toEqual({
      'my-proxy::qwen2.5-7b': { contextWindow: 128000, input: ['text', 'image'], reasoningEfforts: ['off', 'low', 'medium'] },
    })
    // 卡片摘要跟着变 —— 配了却看不见等于没配
    expect(wrapper.find('.mcard__summary').text()).toContain('上下文 128K')
    expect(wrapper.find('.mcard__summary').text()).toContain('可收图')
    wrapper.unmount()
  })

  it('读不懂的容量不写盘（留文本、标红），清除设置则删掉这条能力', async () => {
    const spy = installFetch()
    const wrapper = mountLlm()
    await flushPromises()
    emitPrefs({ vendorOverrides: [{ ...CUSTOM, models: ['qwen2.5-7b'] }] })
    await flushPromises()
    await wrapper.find('[data-testid="model-settings-qwen2.5-7b"]').trigger('click')
    await flushPromises()

    const context = wrapper.find('[data-testid="mp-context-qwen2.5-7b"] input')
    const before = spy.commands().length
    await context.setValue('abc')
    await context.trigger('change')
    await flushPromises()
    // 没有新命令 = 没写盘；框里的文本还在
    expect(spy.commands().length).toBe(before)
    expect((context.element as HTMLInputElement).value).toBe('abc')
    expect(wrapper.find('[data-testid="model-profile-qwen2.5-7b"]').text()).toContain('读不懂')

    // 先写一个合法值，再「清除这个模型的设置」→ 表里那条被删掉
    await context.setValue('32K')
    await context.trigger('change')
    await flushPromises()
    expect(lastPatch(spy.commands()).modelProfiles).toEqual({ 'my-proxy::qwen2.5-7b': { contextWindow: 32000 } })

    await wrapper.find('[data-testid="mp-reset-qwen2.5-7b"]').trigger('click')
    await flushPromises()
    expect(lastPatch(spy.commands()).modelProfiles).toEqual({})
    wrapper.unmount()
  })
})
