/**
 * models 插件 UI 的行为单测（P5，从 client/tests/widgets/settings.test.ts 搬过来）。
 *
 * ## 为什么搬
 *
 * 这块界面已经不在 client 包里了 —— 它现在是 `plugins/models/ui/` 的一份源码，
 * 构建后由 Core 伺服在 `/plugins/models/ui/`。测试跟着**被测物**走：留在 client 里的那份
 * 要么因为 import 路径失效被误删，要么反过来 —— 有人改了搬过去的实现，
 * client 的测试还在跑、还绿。
 *
 * ## 与搬过来时相比，三处真实差异
 *
 * 1. **厂商目录改成运行时读**（`fetch('catalog.json')`）—— 见下面 `stubFetch` 的注释。
 *    这是唯一一处「测试要重新理解」的行为：以前那份厂商表是编译期常量。
 * 2. **不挂 pinia / i18n / UiPlugin**：这个界面一个 store、一个 i18n key、
 *    一个全局组件都没用到（原来那份 mount 挂了三个，其中两个是 client 时代的包袱）。
 * 3. **同源假设成立**：界面在 iframe 里跑，但 `/api/*` 与 `/events` 都是 Core 的
 *    同源路由，所以这些用例的 mock 方式与在 client 里时**完全一样**。
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { installFakeEventSource } from '@osteosome/core-client/testing'
import { sse } from '@osteosome/core-client'
import LlmSettings from '../src/views/LlmSettingsView.vue'

/** 插件自带的厂商目录：构建时被复制进 `dist/ui/`，页面运行时 fetch 它 */
const CATALOG_BODY = readFileSync(
  // tests/ → ui/ → models/：catalog.json 在**插件根**，不在 ui 包里
  resolve(fileURLToPath(import.meta.url), '..', '..', '..', 'catalog.json'),
  'utf8',
)

const DESCRIPTOR = {
  provider: 'openai',
  defaultModel: 'gpt-4o-mini',
  credentialRef: 'env:OPENAI_API_KEY',
  retryPolicy: { maxAttempts: 3, baseDelayMs: 500, backoff: 'exponential', retryableCodes: ['rate_limited'] },
}

/**
 * 这里**不 mock SSE**，而是装一个假的 `EventSource`（`@osteosome/core-client/testing`）。
 *
 * ## 为什么不再 mock sse 模块
 *
 * 原来这份测试 mock 的是 `../src/core-sdk/sse`。P6 把 core-sdk 抽成包之后，
 * 组件 import 的是包，而包内部 `useEndpointProbe` import 的是**相对路径** `./sse` ——
 * 于是那份 mock 落空，`useEndpointProbe` 用了真的 sse、真的去 `new EventSource`。
 *
 * 这个坑值得记下：**mock 一个「实现没有 import 的模块」不会报错**，
 * 只会让被测物偷偷用了真实现。症状（断言像是组件坏了）与真正的组件 bug 一模一样。
 *
 * ## 换成假 EventSource 之后多测了什么
 *
 * 真的 `SseClient` 会：建连接 → 收 open → 解 JSON → 按 topic 通配匹配分发 → 多订阅者都收到。
 * 这些以前全被 mock 掉了，现在都在被测。所以下面 `emit()` 造的事件要**按真实 wire 格式**
 * （`{topic, payload}` 的 JSON）才能被收到 —— 而那个格式由包自己定义，假的也就住在包里。
 */
let fakeSse: ReturnType<typeof installFakeEventSource>

/** 往所有打开着的 SSE 连接投一条事件（topic 支持通配，与真实分发一致） */
function emit(topic: string, payload: unknown): void {
  fakeSse.emit(topic, payload)
}

/**
 * 种一份接入清单 —— **owner（models 插件的服务）重播整份**。
 *
 * 接入清单归插件自己的服务所有（`userData/plugin/models/preferences.json`），前端经总线订阅，
 * 所以这里**不是** mock 一个 HTTP 响应，而是往 SSE 里投一条 `models.prefs.state`。
 *
 * 这一点与实现无关紧要，但**时机**要跟真实的运行时契约一致：
 * 事件必须在**挂载之后**才有订阅者。所以这函数只**记下**要播的内容，
 * 由 {@link mountLlm} 在 `mount()` 之后立刻播出去（所有用例都是「种 → 挂 → flush」，
 * 这个顺序天然成立）。以前那版是「在 mount 前 mock `/api/preferences` 的 GET 回包」——
 * 运行时契约换了（拉取式 → 订阅式），顺序也跟着换了。
 */
let pendingPrefs: Record<string, unknown> = {}

function mockPrefs(prefs: Record<string, unknown> = {}): void {
  pendingPrefs = prefs
}

/** 投一次 owner 的重播（`prefs` 缺省的键取空，语义与「文件里没写」一致） */
function emitPrefs(patch: Record<string, unknown> = {}): void {
  emit('models.prefs.state', {
    prefs: { connectedVendors: [], vendorOverrides: [], enabledModels: [], ...pendingPrefs, ...patch },
  })
}

/** owner 重播的密钥掩码列表 */
function emitCredentials(list: Array<Record<string, unknown>>): void {
  emit('models.credentials.state', { credentials: list })
}

/** 取出每次 POST /api/command 的请求体（页面还会发没 body 的 GET，不按 URL 过滤会炸） */
function commandBodies(fetchMock: { mock: { calls: unknown[][] } }): Record<string, unknown>[] {
  return fetchMock.mock.calls
    .filter((c) => String(c[0]).includes('/api/command'))
    .map((c) => JSON.parse(String((c[1] as { body?: unknown }).body)) as Record<string, unknown>)
}

/** 最后一次 `models.prefs.set` 里的 patch（合并式写，所以断言看「这一份」而不是整体文件） */
function lastPatch(bodies: Record<string, unknown>[]): {
  connectedVendors: string[]
  vendorOverrides: Array<Record<string, unknown>>
  enabledModels: string[]
} {
  const last = bodies.at(-1)
  if (!last) throw new Error('没有 models.prefs.set 命令')
  const patch = (last.payload as { patch?: Record<string, unknown> }).patch ?? {}
  return {
    connectedVendors: (patch.connectedVendors as string[]) ?? [],
    vendorOverrides: (patch.vendorOverrides as Array<Record<string, unknown>>) ?? [],
    enabledModels: (patch.enabledModels as string[]) ?? [],
  }
}

/**
 * `fetch` 的替身：**厂商目录永远由真实文件应答，其余走用例自己设的 mock**。
 *
 * ## 为什么要这么绕一层
 *
 * P5 起厂商目录是**插件自带的运行时数据**，页面 `fetch('catalog.json')`。
 * 而这套用例里到处是 `vi.mocked(fetch).mockResolvedValue(...)` —— 一个「所有 URL 都返回
 * 同一个 Response」的 mock。目录请求落进去就会拿到 `{}`，界面于是显示成
 * 「读不到厂商目录」，而**每一条断言厂商数量的用例都会红**。
 *
 * 逐个用例改 mock 有两个问题：一是 17 处机械改动（改错一处就假红），
 * 二是「哪些用例需要目录」这件事本身成了每个用例的隐含责任。
 *
 * 这里把它收在一处：`catalog.json` 由**真实文件**应答，其余 URL 转发给用例的 mock。
 * 于是「12 家预设全可见」这类断言读到的是真数据，而且新增用例不必知道目录这回事。
 */
function stubFetch(): void {
  // 默认应答：除厂商目录外一律 202。接入清单与密钥改走总线（SSE 事件 + 命令），
  // 所以这里**不再**有 `/api/preferences` 与 `/api/credentials` 的分支 ——
  // 留着它们会让「界面还在走旧通道」这件事在测试里看起来是正常的。
  const inner = vi.fn(async (_input?: unknown, _init?: { method?: string }) => new Response(null, { status: 202 }))

  const stub = ((input: unknown, init?: { method?: string }) => {
    if (String(input).includes('catalog.json')) {
      // 顺手记一笔：这样 `fetchMock.mock.calls` 里也能看到目录请求，排障时知道它发生过
      inner(input, init)
      return Promise.resolve(new Response(CATALOG_BODY, { status: 200 }))
    }
    return inner(input, init)
  }) as unknown as ReturnType<typeof vi.fn>

  // 把 mock 的控制面转给 inner：这样下面所有用例原有的
  // `vi.mocked(fetch).mockResolvedValue(...)` / `.mockImplementation(...)` 一行都不用改
  for (const key of [
    'mockResolvedValue',
    'mockRejectedValue',
    'mockImplementation',
    'mockImplementationOnce',
    'mockReturnValue',
    'mockClear',
    'mockReset',
    'mockName',
  ] as const) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(stub as any)[key] = (...args: unknown[]) => (inner as any)[key](...args)
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(stub as any).mock = inner.mock

  vi.stubGlobal('fetch', stub)
}

beforeEach(() => {
  // SSE 是**模块级单例**：跨用例不清订阅，后一个用例会收到前一个用例的 handler，
  // 症状是「用例之间互相影响、单独跑都过」—— 那种红最难查
  sse.close()
  // 同理：`mockPrefs` 记的是「下一轮 owner 会重播什么」，不重置就会漏给下一个用例 ——
  // 症状是「某个用例明明没种偏好，却看到上一条用例连上的厂商」
  pendingPrefs = {}
  fakeSse = installFakeEventSource()
  stubFetch()
})

afterEach(() => {
  vi.unstubAllGlobals()
  fakeSse?.restore()
  sse.close()
  // fake timers 泄漏会把下一个用例的 setTimeout 全吃掉，测试会以诡异的方式挂住
  vi.useRealTimers()
})

describe('LlmSettingsView 服务商配置（widget.llm-settings，归 models 插件 · 重做版）', () => {
  /**
   * 按 demo 重做后的页面拆成三块（已连接卡片 / 未连接的预设目录 / OpenAI 兼容端点），
   * 所以这些断言按新结构写，但**守的行为一条没少** ——
   * 尤其这三条：预设必须全量可见、配置必须写对地方、不能发出指向已删服务的假开关。
   */

  const ALL_PRESETS = 12

  /**
 * 首屏要等的不止一次 tick。
 *
 * 厂商目录改成**运行时读**之后，`onMounted` 里是 `Promise.all([reloadCatalog(), …])`：
 * fetch → `res.json()` → 校验 → 写 ref，这是一条 promise 链，`$nextTick` 只推进一个微任务。
 * 所以凡是「挂载后立刻断言清单内容」的用例都得 `flushPromises()`。
 *
 * 这不是测试迁就实现，而是运行时契约变了：以前那份表是编译期常量，首屏同步就有。
 */
  function mountLlm(attach = false) {
    // 不挂 pinia / i18n / UiPlugin：这个界面一个 store、一个 i18n key、一个全局组件都没用到
    const wrapper = mount(LlmSettings, { attachTo: attach ? document.body : undefined })
    // owner 的重播必须晚于 mount —— 订阅者在 onMounted 才挂上
    emitPrefs()
    emitCredentials([])
    return wrapper
  }

  it('厂商清单来自预设表全量 12 家 —— 已连接 + 未连接 相加等于 12', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response('{}', { status: 200 }))
    const wrapper = mountLlm()
    await flushPromises()

    const connected = wrapper.findAll('[data-testid^="vendor-"]').filter((w) =>
      w.attributes('data-testid') === 'vendor-openai',
    )
    const text = wrapper.text()
    // 12 家里任何一家都必须能看见 —— 看不见就没法去配置它
    for (const id of ['deepseek', 'openai', 'openrouter', 'mistral', 'ollama', 'lm-studio', 'vllm']) {
      expect(text, id + ' 不在清单里').toContain(id)
    }
    // 没有任何 registered 事件时，「已连接」分组整组不渲染（空分组不占地方），
    // 12 家全落在「未连接的预设」—— 一个都不能少
    expect(text).not.toContain('已连接 (')
    expect(text).toContain('未连接的预设 (' + ALL_PRESETS + ')')

    // **registered 事件不再把它挪进已连接**（P0 起的语义）：
    // 免凭证的本地端点在 Core 侧恒注册，若 UI 拿注册当「已连接」，
    // ollama / vllm / lm-studio 就永远躺在已连接里，用户没机会从预设里挑。
    emit('llm.provider.registered', { provider: 'lm-studio', defaultModel: '', credentialRef: '' })
    await flushPromises()
    expect(wrapper.text()).not.toContain('已连接 (')
    expect(wrapper.text()).toContain('未连接的预设 (' + ALL_PRESETS + ')')
    wrapper.unmount()
  })

  it('展开已连接厂商 → 显示 baseUrl / 需要什么凭证 / 默认模型，且可就地改', async () => {
    // 「已连接」由偏好 llm.connectedVendors 表达（不是 registered 事件）——
    // 所以偏好必须在 mount **之前**种下：组件在 onMounted 里就把它读空了，
    // 之后再 mock 就晚了（这个顺序错误的表现是「卡片怎么都不出现」）。
    // lm-studio 是免凭证本地端点，拿它当样本最省事。
    mockPrefs({ connectedVendors: ['lm-studio'] })
    const wrapper = mountLlm()
    await flushPromises()
    emit('llm.provider.registered', {
      provider: 'lm-studio',
      defaultModel: '',
      credentialRef: '',
    })
    await flushPromises()
    const head = wrapper.find('[data-testid="vendor-lm-studio"]')
    expect(head.exists()).toBe(true)
    await head.trigger('click')
    await flushPromises()
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

  it('未连接的服务商：一行一家 —— 说清「需要什么」并给出下一步点哪', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response('{}', { status: 200 }))
    const wrapper = mountLlm()
    await flushPromises()
    expect(wrapper.text()).toContain('需要 DEEPSEEK_API_KEY')

    // 目录默认收起（12 家里通常只连 1–2 家，剩下 11 行是噪音）
    expect(wrapper.find('[data-testid="vendor-dir"]').attributes('aria-expanded')).toBe('false')
    await wrapper.find('[data-testid="vendor-dir"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid="vendor-dir"]').attributes('aria-expanded')).toBe('true')

    // 一行一家，且两件事都在这一行里答完：这家要什么 + 下一步点哪。
    // 没给密钥之前「连接」按住不放 —— 点了只会空转到超时，是纯浪费
    const row = wrapper.find('[data-testid="vendor-deepseek"]')
    expect(row.exists()).toBe(true)
    expect(row.text()).toContain('deepseek')
    expect(row.text()).toContain('需要 DEEPSEEK_API_KEY')
    expect(wrapper.find('[data-testid="vendor-setkey-deepseek"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="vendor-connect-deepseek"]').attributes('disabled')).toBeDefined()
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

  it('点「连接」立刻有反馈：按钮转「探测中…」，回音后变 ✓可达并复位', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response('{}', { status: 200 }))
    const wrapper = mountLlm()
    await flushPromises()
    await wrapper.find('[data-testid="vendor-dir"]').trigger('click')
    await flushPromises()

    expect(wrapper.find('[data-testid="vendor-probe-lm-studio"]').text()).toContain('未测试')
    expect(wrapper.find('[data-testid="vendor-connect-lm-studio"]').text()).toContain('连接')

    await wrapper.find('[data-testid="vendor-connect-lm-studio"]').trigger('click')
    await flushPromises()

    // **这一行会离开「未连接的预设」** —— 点连接就是把它记进接入清单（P0 起的语义），
    // 于是探测状态要去看**卡片**上的那个，不是还留在目录里的行。
    // 这条断言守住的就是「它确实挪走了」：目录里少了、卡片上多了，加起来 12 家不变。
    expect(wrapper.find('[data-testid="vendor-connect-lm-studio"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="vendor-lm-studio"]').exists()).toBe(true)
    // 探测按钮在探测期间禁用并显示「探测中…」
    const busy = wrapper.find('[data-testid="probe-active"]')
    expect(busy.attributes('disabled')).toBeDefined()

    // 回音：`catalog: remote` = 真的拉到了上游 /models → 判可达，按钮复位
    emit('llm.models.list.result', {
      requestId: 'probe-lm-studio-1',
      provider: 'lm-studio',
      models: ['qwen3-8b'],
      catalog: 'remote',
    })
    await flushPromises()
    // 卡片上的文案是「已连通 Nms」，不是目录行那句「✓ 可达」——
    // 两处文案不同是刻意的（卡片还要显示往返延迟），所以断言要认准所在的位置
    expect(wrapper.find('[data-testid="vendor-lm-studio"]').text()).toMatch(/已连通/)
    expect(wrapper.find('[data-testid="probe-active"]').attributes('disabled')).toBeUndefined()
    wrapper.unmount()
  })

  it('点了连接却没人回话 → 8 秒兜底判不可达，按钮不会永远转下去', async () => {
    // 只 fake setTimeout：VTU 的 flushPromises 走 setImmediate，全 fake 会让它永远不 resolve
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    vi.mocked(fetch).mockResolvedValue(new Response('{}', { status: 200 }))
    const wrapper = mountLlm()
    await flushPromises()
    await wrapper.find('[data-testid="vendor-dir"]').trigger('click')
    await flushPromises()

    await wrapper.find('[data-testid="vendor-connect-lm-studio"]').trigger('click')
    await flushPromises()
    // 点连接后这行已挪进已连接，探测状态看卡片（与上面那条同理）
    expect(wrapper.find('[data-testid="probe-active"]').attributes('disabled')).toBeDefined()

    // provider 压根没注册成实例时永远不会回音 —— 兜底必须自己收场，
    // 不能跟着 HTTP 202 一起把计时器撤掉（那正是原实现的错）
    vi.advanceTimersByTime(8000)
    await flushPromises()
    // 探不通也**留在已连接**（点了连接就是「我打算用它」），退路是卡片上的「删除」——
    // 让页面替用户改主意，比让他自己猜「怎么没生效」更糟
    expect(wrapper.find('[data-testid="vendor-lm-studio"]').text()).toContain('连不上')
    expect(wrapper.find('[data-testid="vendor-disconnect-lm-studio"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="probe-active"]').attributes('disabled')).toBeUndefined()
    wrapper.unmount()
  })

  it('搜索框过滤服务商', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response('{}', { status: 200 }))
    const wrapper = mountLlm()
    await flushPromises()
    const search = wrapper.find('[aria-label="vendor-search"]')
    expect(search.exists()).toBe(true)
    await search.setValue('deepseek')
    await flushPromises()
    expect(wrapper.text()).toContain('deepseek')
    expect(wrapper.text()).not.toContain('siliconflow')
    wrapper.unmount()
  })

  it('设置密钥 → models.credentials.put 且 provider 字段=厂商 id（不发 service.stop）', async () => {
    const fetchMock = vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 200 }))
    const wrapper = mountLlm(true)
    await flushPromises()
    // 用 testid 而不是「第一个 设置密钥 按钮」：卡片与目录里都有这个按钮，
    // 按顺序取会拿到隔壁厂商的，症状是 PUT 的 provider 字段悄悄变成别家 id
    await wrapper.find('[data-testid="vendor-setkey-deepseek"]').trigger('click')
    await flushPromises()
    const input = document.body.querySelector<HTMLInputElement>('input[type="password"]')
    expect(input, '密钥输入框没渲染').not.toBeNull()
    input!.value = 'sk-user'
    input!.dispatchEvent(new Event('input'))
    await flushPromises()
    const saveBtn = Array.from(document.body.querySelectorAll('button')).find(
      (b) => b.getAttribute('data-testid') === 'credential-save',
    )
    expect(saveBtn, '保存按钮没渲染').toBeDefined()
    saveBtn!.click()
    await flushPromises()
    const put = commandBodies(fetchMock).filter((b) => b.topic === 'models.credentials.put')
    expect(put).toHaveLength(1)
    expect(put[0]!.payload).toMatchObject({ provider: 'deepseek', value: 'sk-user' })
    // 关键：不再有指向已删服务的假开关
    const commands = fetchMock.mock.calls
      .filter((c) => String(c[0]).includes('/api/command'))
      .map((c) => JSON.parse(String((c[1] as { body?: unknown }).body)))
    expect(commands.some((b) => b.topic === 'service.stop' || b.topic === 'service.start')).toBe(false)
    wrapper.unmount()
    document.body.innerHTML = ''
  })

  it('自定义端点 → 写 models 接入清单的 vendorOverrides，保存即探测', async () => {
    const fetchMock = vi.mocked(fetch).mockResolvedValue(new Response('{}', { status: 200 }))
    const wrapper = mountLlm(true)
    await flushPromises()
    await wrapper.find('[data-testid="endpoint-new"]').trigger('click')
    await flushPromises()
    const bodyInputs = Array.from(document.body.querySelectorAll('input'))
    const idInput = bodyInputs.find((i) => i.placeholder === 'my-proxy')
    const urlInput = bodyInputs.find((i) => i.placeholder === 'http://127.0.0.1:1234/v1')
    expect(idInput, '端点 id 输入框没渲染').toBeTruthy()
    expect(urlInput, 'Base URL 输入框没渲染').toBeTruthy()
    idInput!.value = 'my-proxy'
    idInput!.dispatchEvent(new Event('input'))
    urlInput!.value = 'http://127.0.0.1:8080/v1'
    urlInput!.dispatchEvent(new Event('input'))
    await flushPromises()
    const saveBtn = Array.from(document.body.querySelectorAll('button')).find(
      (b) => b.getAttribute('data-testid') === 'endpoint-save',
    )
    saveBtn!.click()
    await flushPromises()
    const put = commandBodies(fetchMock).filter((b) => b.topic === 'models.prefs.set')
    expect(put.length).toBeGreaterThan(0)
    expect((put.at(-1)!.payload as { patch: { vendorOverrides: unknown } }).patch.vendorOverrides).toEqual([
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
    // 接入清单由 owner 重播：这里给一份带 override 的
    mockPrefs({
      vendorOverrides: [
        { id: 'lm-studio', baseUrl: 'http://127.0.0.1:9999/v1' },
        { id: 'my-proxy', baseUrl: 'http://10.0.0.5:8000/v1' },
      ],
    })
    const wrapper = mountLlm()
    await flushPromises()
    // 选择器要够窄：`endpoint-` 前缀会把「新增端点」按钮也算进来
    const endpointRows = wrapper.findAll('div[data-testid^="endpoint-"]')
    // 只剩 my-proxy —— lm-studio 那条是「覆盖预设」，该在服务商区就地编辑
    expect(endpointRows.length).toBe(1)
    expect(endpointRows[0]!.attributes('data-testid')).toBe('endpoint-my-proxy')
    wrapper.unmount()
  })

  it('就地改预设端点 → 写同 id 的 override，并在该厂商标「已覆盖预设」', async () => {
    const fetchMock = vi.mocked(fetch).mockResolvedValue(new Response('{}', { status: 200 }))
    mockPrefs({ connectedVendors: ['lm-studio'] })
    const wrapper = mountLlm()
    await flushPromises()
    emit('llm.provider.registered', { provider: 'lm-studio', defaultModel: '', credentialRef: '' })
    await flushPromises()
    await wrapper.find('[data-testid="vendor-lm-studio"]').trigger('click')
    await flushPromises()
    await wrapper.find('[data-testid="vendor-url-lm-studio"]').trigger('click')
    await flushPromises()
    const edit = wrapper.findAll('input').find((i) => i.element.value.includes('1234'))
    expect(edit, '端点编辑框没出现').toBeTruthy()
    edit!.element.value = 'http://127.0.0.1:4321/v1'
    edit!.trigger('input')
    await flushPromises()
    const save = wrapper.findAll('button').find((b) => b.text() === '保存')
    await save!.trigger('click')
    await flushPromises()
    const put = commandBodies(fetchMock).filter((b) => b.topic === 'models.prefs.set')
    expect(put.length).toBeGreaterThan(0)
    // 同 id 覆盖 —— buildVendorInstances 里 byId.set 同 key 会盖掉预设
    expect(lastPatch(put).vendorOverrides.some((o) => o.id === 'lm-studio' && o.baseUrl === 'http://127.0.0.1:4321/v1')).toBe(true)
    expect(wrapper.text()).toContain('已覆盖预设')
    wrapper.unmount()
  })

  it('模型墙开关 → 写接入清单的 enabledModels（`${provider}::${model}`，空数组=全启用）', async () => {
    const fetchMock = vi.mocked(fetch).mockResolvedValue(new Response('{}', { status: 200 }))
    mockPrefs({ connectedVendors: ['lm-studio'] })
    const wrapper = mountLlm()
    await flushPromises()
    emit('llm.provider.registered', { provider: 'lm-studio', defaultModel: '', credentialRef: '' })
    await flushPromises()
    emit('llm.models.list.result', {
      requestId: 'x',
      provider: 'lm-studio',
      models: ['qwen2.5-7b', 'qwen3-4b'],
      catalog: 'remote',
    })
    await flushPromises()

    const sw = wrapper.findAll('[role="switch"]').find((w) => w.attributes('aria-label') === '模型 qwen2.5-7b')
    expect(sw, '模型开关没渲染').toBeTruthy()
    // 默认没写过偏好 = 全启用 —— 老配置一个字都不用补
    expect(sw!.attributes('aria-checked')).toBe('true')
    await sw!.trigger('click')
    await flushPromises()

    const put = () => commandBodies(fetchMock).filter((b) => b.topic === 'models.prefs.set')
    expect(put().length).toBeGreaterThan(0)
    // 用 `::` 分隔：模型名里本来就有冒号（qwen2.5:7b），拿 `:` 一刀两断会切错
    expect(lastPatch(put()).enabledModels).toEqual(['lm-studio::qwen2.5-7b'])
    expect(wrapper.text()).toContain('已停用')

    // 全部禁用 → 整家进名单；再全部启用 → 清成空数组（= 全启用，不是留一堆残条目）
    await wrapper.findAll('button').find((b) => b.text() === '全部禁用')!.trigger('click')
    await flushPromises()
    expect(lastPatch(put()).enabledModels).toEqual(['lm-studio::qwen2.5-7b', 'lm-studio::qwen3-4b'])
    await wrapper.findAll('button').find((b) => b.text() === '全部启用')!.trigger('click')
    await flushPromises()
    expect(lastPatch(put()).enabledModels).toEqual([])
    wrapper.unmount()
  })

  it('卡片：注册即自动探测（发 llm.models.list）；result 回来即填进模型墙', async () => {
    // 旧行为是「先选 provider 再拉模型」—— 但选 provider 的那个下拉已经删了：
    // provider 归对话输入框，设置页只负责「这家什么状态、有哪些模型」。
    // 所以探测改由注册事件触发，一次到位。
    const fetchMock = vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 202 }))
    mockPrefs({ connectedVendors: ['openai'] })
    const wrapper = mountLlm()
    await flushPromises()
    emit('llm.provider.registered', DESCRIPTOR)
    await flushPromises()
    const bodies = commandBodies(fetchMock)
    expect(bodies.some((b) => b.topic === 'llm.models.list')).toBe(true)

    emit('llm.models.list.result', {
      requestId: 'models-1',
      provider: 'openai',
      models: ['gpt-4o-mini', 'gpt-4o'],
      catalog: 'static',
    })
    await flushPromises()
    expect(wrapper.text()).toContain('gpt-4o-mini')
    expect(wrapper.text()).toContain('可用模型 (2)')
    wrapper.unmount()
  })

  it('「获取模型列表」按钮：填下拉 + 显示计数，且只发一次命令', async () => {
    const fetchMock = vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 202 }))
    mockPrefs({ connectedVendors: ['lm-studio'] })
    const wrapper = mountLlm()
    await flushPromises()
    emit('llm.provider.registered', { provider: 'lm-studio', defaultModel: '', credentialRef: '' })
    await flushPromises()

    const btn = wrapper.find('[data-testid="refresh-models"]')
    expect(btn.exists()).toBe(true)
    // 挂载 / 切 provider 会自动拉一次，期间按钮禁用 —— 这正是想要的：
    // 禁用状态下重复点击打多次端点是纯浪费
    expect(btn.text()).toMatch(/获取模型列表|拉取中/)
    emit('llm.models.list.result', {
      requestId: 'auto', provider: 'lm-studio', models: ['stale-model'], catalog: 'remote',
    })
    await flushPromises()
    expect(btn.attributes('disabled')).toBeUndefined()

    await btn.trigger('click')
    await flushPromises()
    emit('llm.models.list.result', {
      requestId: 'x', provider: 'lm-studio', models: ['qwen2.5-7b', 'qwen2.5-3b'], catalog: 'remote',
    })
    await flushPromises()

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
    mockPrefs({ connectedVendors: ['lm-studio'] })
    const wrapper = mountLlm()
    await flushPromises()
    emit('llm.provider.registered', { provider: 'lm-studio', defaultModel: '', credentialRef: '' })
    await flushPromises()
// 挂载即自动探测一次，所以初始是「探测中…」；
    // 重点是**不能**在还没结果时就显示「连不上」—— 那会冤枉一个其实好好的端点
    expect(wrapper.text()).toMatch(/探测中|未测试/)
    expect(wrapper.text()).not.toContain('连不上')

    const probeBtn = wrapper.find('[data-testid="probe-active"]')
    await probeBtn.trigger('click')
    await flushPromises()
    emit('llm.models.list.result', {
      requestId: 'x', provider: 'lm-studio', models: ['qwen2.5-7b'], catalog: 'remote',
    })
    await flushPromises()
    expect(wrapper.text()).toContain('已连通')

    await wrapper.find('[data-testid="probe-active"]').trigger('click')
    await flushPromises()
    emit('llm.models.list.result', {
      requestId: 'y', provider: 'lm-studio', models: [], catalog: 'static',
    })
    await flushPromises()
    expect(wrapper.text()).toContain('连不上')
    wrapper.unmount()
  })

  it('凭证：owner 重播的掩码列表可见；发 put 命令后新凭证出现在列表里', async () => {
    const fetchMock = vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 202 }))
    // 已连接的厂商才渲染成卡片（默认展开），凭证那行在卡片上 —— 所以先把它接进来
    mockPrefs({ connectedVendors: ['openai'] })
    const wrapper = mountLlm(true)
    await flushPromises()
    emit('llm.provider.registered', DESCRIPTOR)
    await flushPromises()
    // 重做版把入口放在服务商区（「换密钥」），不再有一个游离的「新建凭证」按钮
    expect(wrapper.text()).not.toContain('新建凭证')
    await wrapper.find('[data-testid="vendor-openai"]').trigger('click')
    await flushPromises()
    await wrapper.find('[data-testid="vendor-setkey-openai"]').trigger('click')
    await flushPromises()
    const valueInput = document.body.querySelector<HTMLInputElement>('input[type="password"]')
    expect(valueInput).toBeTruthy()
    valueInput!.value = 'sk-secret-value'
    valueInput!.dispatchEvent(new Event('input', { bubbles: true }))
    await flushPromises()
    const saveBtn = Array.from(document.body.querySelectorAll('button')).find(
      (b) => b.getAttribute('data-testid') === 'credential-save',
    )
    expect(saveBtn).toBeTruthy()
    saveBtn!.click()
    await flushPromises()

    // 命令确实发出去了（明文只走这一条路 → 总线 → owner）
    const put = commandBodies(fetchMock).filter((b) => b.topic === 'models.credentials.put')
    expect(put).toHaveLength(1)
    expect(put[0]!.payload).toMatchObject({ provider: 'openai', value: 'sk-secret-value' })
    // 列表由 owner 重播：模拟它存好之后的那一次，界面据此显示「已保存 · 环境变量名」
    emitCredentials([{ id: 'c1', name: 'openai API Key', provider: 'openai', kind: 'apiKey', masked: 'sk-s…alue' }])
    await flushPromises()
    expect(wrapper.text()).toContain('已保存 · OPENAI_API_KEY')
    // 顺带钉住红线：掩码本身**根本不进 DOM**（界面只说「存了」，不显示值）
    expect(wrapper.text()).not.toContain('sk-s…alue')
    wrapper.unmount()
    document.body.innerHTML = ''
  })
})
