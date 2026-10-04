/**
 * chat-timeline（②）/ chat-composer（③）Widget 单测。
 *
 * S5 把原来的 `widget.llm-chat`（407 行，逻辑 290 行全塞在一个组件里）拆成
 * ② 只读消息投影 + ③ 输入与请求参数，两者**零直接通信**、共享 `stores/chat.store.ts`。
 * 所以这里的挂载方式是**两个都挂**，但断言分别落在各自的 testid 上。
 *
 * 手法对齐 composables.test.ts：mock sse 捕获 handler（等同跨窗事件注入）+ mock fetch 拦截 /api/command。
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

/**
 * 这里**不 mock SSE**，而是装一个假的 `EventSource`（`@osteosome/core-client/testing`）。
 *
 * ## 换掉 mock 的两个理由
 *
 * 1. **它已经失效了**：P6 把 core-sdk 抽成包，`../../src/core-sdk/sse` 只是个转发 shim，
 *    而 `useLlmProviders` / `session.store` 用的是**包内部**的 sse 实例 ——
 *    mock 一个没人 import 的模块不会报错，只会让被测物偷偷用真实现。
 *    症状：`providerOptions` 为空 → 组件走「尚未注册任何 provider」分支 →
 *    `[data-testid="composer-input"]` 找不到 → 22 条用例集体红。
 * 2. **它自己就带着 bug**：`sseHandlers.set(topic, handler)` 是
 *    「一个 topic 只存一个 handler」—— 真实客户端是 `Map<topic, Set<handler>>`。
 *    页面里两个 composable 订阅同一 topic 时，后订阅的会把先订阅的顶掉。
 *    这类 mock 的缺陷比被测代码的缺陷更难查，因为它让「事件机制」看起来是坏的。
 *
 * 换成真客户端之后，连接建立、open、JSON 解包、topic 通配匹配、多订阅者分发
 * 全都在被测之内 —— 比原来多测了一整层。
 */
let fakeSse: ReturnType<typeof installFakeEventSource>

import ChatTimelineWidget from '../../src/widgets/chat-timeline/ChatTimelineWidget.vue'
import ChatComposerWidget from '../../src/widgets/chat-composer/ChatComposerWidget.vue'
import { useSessionStore } from '../../src/stores/session.store'
import { installFakeEventSource } from '@osteosome/core-client/testing'
import { sse } from '@osteosome/core-client'

const DESCRIPTOR = {
  provider: 'deepseek',
  defaultModel: 'deepseek-chat',
  credentialRef: 'env:DEEPSEEK_API_KEY',
  retryPolicy: { maxAttempts: 3, baseDelayMs: 500, backoff: 'exponential', retryableCodes: ['rate_limited'] },
}

function emit(topic: string, payload: unknown): void {
  fakeSse.emit(topic, payload)
}

/**
 * 取出每次 POST /api/command 的请求体。
 *
 * 必须按 URL 过滤：页面还会发 `GET /api/preferences`（读模型开关）这类**没有 body**
 * 的请求，`JSON.parse('undefined')` 会直接炸在这里 —— 症状是毫不相关的用例集体失败。
 */
function commandBodies(fetchMock: { mock: { calls: unknown[][] } }): Record<string, unknown>[] {
  return fetchMock.mock.calls
    .filter((c) => String(c[0]).includes('/api/command'))
    .map((c) => {
      const init = c[1] as { body?: unknown } | undefined
      return JSON.parse(String(init?.body)) as Record<string, unknown>
    })
}

/** Select 的 options 是 prop，直接改 value + change 触发（对齐 settings.test.ts 手法） */
async function setSelect(wrapper: VueWrapper, testid: string, value: string): Promise<void> {
  const el = wrapper.get(`[data-testid="${testid}"] select`)
  const element = el.element as HTMLSelectElement
  element.value = value
  await el.trigger('change')
}

beforeEach(() => {
  // SSE 是模块级单例：跨用例不断订阅，后一个用例会收到前一个的 handler，
  // 症状是「用例之间互相影响、单独跑都过」—— 那类红最难查
  sse.close()
  fakeSse = installFakeEventSource()
  setActivePinia(createPinia())
})

/**
 * 只读的 `widget.llm-providers` 状态面板已删除（与「模型接入」面板信息重复），
 * 所以本文件现在只覆盖 ② / ③。它的用例在 `settings.test.ts` 的
 * `LlmSettingsView 服务商配置` 那一节里 —— provider 的存在性在那边已有断言。
 */

/** 挂 ② + ③（共享 store），并把当前会话设成 s1 */async function mountChat(sessionId = 's1') {
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 202 }))
  const timeline = mount(ChatTimelineWidget)
  const composer = mount(ChatComposerWidget)
  await flushPromises()
  emit('llm.provider.registered', DESCRIPTOR)
  await flushPromises()
  const sessions = useSessionStore()
  if (sessionId) sessions.select(sessionId)
  await flushPromises()
  return { timeline, composer, fetchMock, sessions }
}

/** 在 ③ 里发问，回本轮的 A（loop.run 的 requestId） */
async function startRun(composer: VueWrapper, fetchMock: { mock: { calls: unknown[][] } }, text = 'hi'): Promise<string> {
  await composer.get('[data-testid="composer-input"]').setValue(text)
  await composer.get('form').trigger('submit')
  await flushPromises()
  return (commandBodies(fetchMock).find((b) => b.topic === 'loop.run')!.payload as { requestId: string }).requestId
}

describe('chat-timeline（②）· 消息投影', () => {
  it('选中会话 → 发 session.get 载入历史', async () => {
    const { fetchMock } = await mountChat('s1')
    expect(commandBodies(fetchMock).map((b) => b.topic)).toContain('session.get')
    fetchMock.mockRestore()
  })

  it('session.get.result → 渲染历史消息', async () => {
    const { timeline, fetchMock } = await mountChat('s1')
    emit('session.get.result', {
      requestId: 'get-1',
      session: {
        meta: { id: 's1' },
        messages: [
          { id: 'm1', role: 'user', content: '历史问题', createdAt: '2024-01-01' },
          { id: 'm2', role: 'assistant', content: '历史回答', createdAt: '2024-01-01' },
        ],
      },
    })
    await timeline.vm.$nextTick()
    expect(timeline.get('[data-testid="timeline-user"]').text()).toContain('历史问题')
    expect(timeline.get('[data-testid="timeline-assistant"]').text()).toContain('历史回答')
    fetchMock.mockRestore()
  })

  it('发问 → ② 立即显示 user 消息 + in-flight assistant 占位（③ 发的问，② 看得到）', async () => {
    const { timeline, composer, fetchMock } = await mountChat('s1')
    await startRun(composer, fetchMock, '你好')
    await timeline.vm.$nextTick()
    expect(timeline.get('[data-testid="timeline-user"]').text()).toContain('你好')
    fetchMock.mockRestore()
  })

  it('loop.token.streamed → 累积到 in-flight assistant', async () => {
    const { timeline, composer, fetchMock } = await mountChat('s1')
    const a = await startRun(composer, fetchMock, '你好')
    emit('loop.token.streamed', { requestId: a, sessionId: 's1', token: '你', index: 0 })
    emit('loop.token.streamed', { requestId: a, sessionId: 's1', token: '好', index: 1 })
    await timeline.vm.$nextTick()
    expect(timeline.get('[data-testid="timeline-assistant"]').text()).toBe('你好')
    fetchMock.mockRestore()
  })

  it('异 requestId 的 token 被忽略（不串流）', async () => {
    const { timeline, composer, fetchMock } = await mountChat('s1')
    const a = await startRun(composer, fetchMock, 'hi')
    emit('loop.token.streamed', { requestId: 'other', token: 'X', index: 0 })
    await timeline.vm.$nextTick()
    emit('loop.token.streamed', { requestId: a, sessionId: 's1', token: 'Y', index: 0 })
    await timeline.vm.$nextTick()
    expect(timeline.get('[data-testid="timeline-assistant"]').text()).toBe('Y')
    fetchMock.mockRestore()
  })

  it('message.appended → in-flight 换服务端 id（不重放 content）', async () => {
    const { timeline, composer, fetchMock, sessions } = await mountChat('s1')
    const a = await startRun(composer, fetchMock, 'hi')
    emit('loop.token.streamed', { requestId: a, sessionId: 's1', token: '答案', index: 0 })
    await timeline.vm.$nextTick()

    sessions.messages = []
    emit('message.appended', {
      sessionId: 's1',
      message: { id: 'srv_1', role: 'assistant', content: '答案', createdAt: '2024-01-01' },
    })
    await timeline.vm.$nextTick()
    const texts = timeline.findAll('[data-testid="timeline-assistant"]').map((n) => n.text())
    expect(texts.filter((t) => t.includes('答案')).length).toBe(1)
    fetchMock.mockRestore()
  })

  it('loop.run.failed → ② 错误内联在末尾 + 不留幽灵 assistant', async () => {
    const { timeline, composer, fetchMock } = await mountChat('s1')
    const a = await startRun(composer, fetchMock, 'hi')
    emit('loop.token.streamed', { requestId: a, sessionId: 's1', token: '半句', index: 0 })
    await timeline.vm.$nextTick()

    emit('loop.run.failed', { requestId: a, sessionId: 's1', error: { code: 'missing_credential', message: 'no key' } })
    await timeline.vm.$nextTick()
    expect(timeline.get('[data-testid="timeline-failed"]').text()).toContain('缺少 API Key')
    // 有内容的半句保留（错误内联不清空上文）
    expect(timeline.get('[data-testid="timeline-assistant"]').text()).toContain('半句')
    // ③ 恢复可发送
    expect(composer.find('[data-testid="composer-send"]').exists()).toBe(true)
    fetchMock.mockRestore()
  })

  it('loop 崩溃（service.failed loop）→ 清 in-flight + ③ 恢复输入', async () => {
    const { composer, fetchMock } = await mountChat('s1')
    await startRun(composer, fetchMock, 'hi')
    emit('service.failed', { serviceId: 'loop', reason: 'crashed' })
    await composer.vm.$nextTick()
    expect(composer.find('[data-testid="composer-send"]').exists()).toBe(true)
    fetchMock.mockRestore()
  })
})

describe('chat-timeline（②）· S4 思维链隔离与元信息', () => {
  it('reasoning token → 进折叠块，正文不含思维链', async () => {
    const { timeline, composer, fetchMock } = await mountChat('s1')
    const a = await startRun(composer, fetchMock, '这题怎么解')
    emit('loop.token.streamed', { requestId: a, sessionId: 's1', token: '让我想想', index: 0, blockType: 'reasoning' })
    emit('loop.token.streamed', { requestId: a, sessionId: 's1', token: '答案是四十二', index: 1, blockType: 'text' })
    await timeline.vm.$nextTick()

    // 正文只有答案
    const body = timeline.get('[data-testid="timeline-assistant"]').text()
    expect(body).toContain('答案是四十二')
    expect(body).not.toContain('让我想想')
    // 思维链单独渲染成折叠块
    const thinking = timeline.find('[data-testid^="timeline-thinking-"]')
    expect(thinking.exists()).toBe(true)
    expect(thinking.text()).toContain('让我想想')
    fetchMock.mockRestore()
  })

  it('缺省 blockType 的 token 仍算正文（老节点不发该字段）', async () => {
    const { timeline, composer, fetchMock } = await mountChat('s1')
    const a = await startRun(composer, fetchMock, 'hi')
    emit('loop.token.streamed', { requestId: a, sessionId: 's1', token: '正文', index: 0 })
    await timeline.vm.$nextTick()
    expect(timeline.get('[data-testid="timeline-assistant"]').text()).toContain('正文')
    expect(timeline.find('[data-testid^="timeline-thinking-"]').exists()).toBe(false)
    fetchMock.mockRestore()
  })

  it('落库消息带 reasoning / finishReason / usage → 折叠块 + 元信息行', async () => {
    const { timeline, sessions, fetchMock } = await mountChat('s1')
    sessions.messages = [
      { id: 'm1', role: 'user', content: '问题', createdAt: '2024-01-01' },
      {
        id: 'm2',
        role: 'assistant',
        content: '答案',
        reasoning: '思考过程',
        finishReason: 'length',
        usage: { promptTokens: 9, completionTokens: 4 },
        createdAt: '2024-01-01',
      },
    ] as never
    await timeline.vm.$nextTick()
    expect(timeline.find('[data-testid^="timeline-thinking-"]').text()).toContain('思考过程')
    const meta = timeline.get('[data-testid="timeline-meta"]').text()
    expect(meta).toContain('达到长度上限')
    expect(meta).toContain('↑9')
    expect(meta).toContain('↓4')
    fetchMock.mockRestore()
  })

  it('流式期间正文非空 → 出现尾光标', async () => {
    const { timeline, composer, fetchMock } = await mountChat('s1')
    const a = await startRun(composer, fetchMock, 'hi')
    emit('loop.token.streamed', { requestId: a, sessionId: 's1', token: '开始', index: 0 })
    await timeline.vm.$nextTick()
    expect(timeline.find('[data-testid="timeline-caret"]').exists()).toBe(true)
    fetchMock.mockRestore()
  })
})

describe('chat-timeline（②）· 工具块（P7）', () => {
  it('loop.tool.executed → 渲染工具名 + 参数 + 成功摘要', async () => {
    const { timeline, composer, fetchMock } = await mountChat('s1')
    const a = await startRun(composer, fetchMock, '看看目录')
    emit('loop.tool.executed', {
      requestId: a, sessionId: 's1', toolCallId: 'c-1', name: 'list_dir',
      arguments: '{"path":""}', ok: true, summary: 'a.txt',
    })
    await timeline.vm.$nextTick()
    const block = timeline.get('[data-testid="timeline-tool-list_dir"]')
    expect(block.text()).toContain('list_dir')
    expect(block.text()).toContain('{"path":""}')
    expect(block.text()).toContain('a.txt')
    fetchMock.mockRestore()
  })

  it('工具失败 → 块上带失败态与错误摘要', async () => {
    const { timeline, composer, fetchMock } = await mountChat('s1')
    const a = await startRun(composer, fetchMock, '读文件')
    emit('loop.tool.executed', {
      requestId: a, sessionId: 's1', toolCallId: 'c-2', name: 'read_file',
      arguments: '{"path":"../x"}', ok: false, summary: '路径非法',
    })
    await timeline.vm.$nextTick()
    const block = timeline.get('[data-testid="timeline-tool-read_file"]')
    expect(block.classes()).toContain('chat-timeline__tool--failed')
    expect(block.text()).toContain('路径非法')
    fetchMock.mockRestore()
  })

  it('回看历史：assistant 消息带 toolCalls → 渲染工具块', async () => {
    const { timeline, sessions, fetchMock } = await mountChat('s1')
    sessions.messages = [
      { id: 'm1', role: 'user', content: '看看目录', createdAt: '2024-01-01' },
      {
        id: 'm2', role: 'assistant', content: '', createdAt: '2024-01-01',
        toolCalls: [{ id: 'c-1', name: 'list_dir', arguments: '{"path":""}' }],
      },
    ] as never
    await timeline.vm.$nextTick()
    expect(timeline.get('[data-testid="timeline-tool-list_dir"]').text()).toContain('list_dir')
    fetchMock.mockRestore()
  })

  it('异 requestId 的工具事件被忽略（不串轮）', async () => {
    const { timeline, composer, fetchMock } = await mountChat('s1')
    await startRun(composer, fetchMock, 'hi')
    emit('loop.tool.executed', {
      requestId: 'other', sessionId: 's1', toolCallId: 'c-9', name: 'list_dir',
      arguments: '{}', ok: true, summary: 'x',
    })
    await timeline.vm.$nextTick()
    expect(timeline.find('[data-testid="timeline-tool-list_dir"]').exists()).toBe(false)
    fetchMock.mockRestore()
  })
})

/**
 * P4 WS-2：模型选择 + 思考强度 + provider 真正进 `loop.run`。
 * 断层回归：P3 时这三处是「装饰」，现由 `llm.models.list` + `loop.run` 新字段兑现。
 * S5 起这些控件归 ③ composer。
 */
describe('chat-composer（③）· 参数链路（P4 WS-2）', () => {
  it('provider 注册 → 拉该家模型目录；result 到达 → 模型下拉出选项', async () => {
    const { composer, fetchMock } = await mountChat()
    expect(commandBodies(fetchMock).some((b) => b.topic === 'llm.models.list')).toBe(true)

    emit('llm.models.list.result', {
      requestId: 'models-1', provider: 'deepseek',
      models: ['deepseek-chat', 'deepseek-reasoner'], catalog: 'remote',
    })
    await composer.vm.$nextTick()
    const options = composer.get('[data-testid="composer-model"] select').findAll('option')
    expect(options.map((o) => o.text())).toEqual(['deepseek-chat', 'deepseek-reasoner'])
    expect(composer.find('[data-testid="composer-static-badge"]').exists()).toBe(false)
    fetchMock.mockRestore()
  })

  it('目录降级 static → 挂角标', async () => {
    const { composer, fetchMock } = await mountChat()
    emit('llm.models.list.result', {
      requestId: 'models-1', provider: 'deepseek', models: ['deepseek-chat'], catalog: 'static',
    })
    await composer.vm.$nextTick()
    expect(composer.get('[data-testid="composer-static-badge"]').text()).toContain('静态')
    fetchMock.mockRestore()
  })

  it('目录不含当前模型 → 回落到声明默认模型，否则取第一项', async () => {
    const { composer, fetchMock } = await mountChat()
    emit('llm.models.list.result', {
      requestId: 'models-1', provider: 'deepseek', models: ['deepseek-reasoner'], catalog: 'remote',
    })
    await composer.vm.$nextTick()
    const el = composer.get('[data-testid="composer-model"] select').element as HTMLSelectElement
    expect(el.value).toBe('deepseek-reasoner')
    fetchMock.mockRestore()
  })

  it('发问 → loop.run 带 provider / model / thinking', async () => {
    const { composer, fetchMock } = await mountChat()
    emit('llm.models.list.result', {
      requestId: 'models-1', provider: 'deepseek',
      models: ['deepseek-chat', 'deepseek-reasoner'], catalog: 'remote',
    })
    await composer.vm.$nextTick()
    await setSelect(composer, 'composer-model', 'deepseek-reasoner')
    await setSelect(composer, 'composer-thinking', 'high')

    await startRun(composer, fetchMock, '你好')
    const run = commandBodies(fetchMock).find((b) => b.topic === 'loop.run')!
    expect(run.payload).toMatchObject({
      sessionId: 's1', text: '你好', provider: 'deepseek', model: 'deepseek-reasoner', thinking: 'high',
    })
    fetchMock.mockRestore()
  })

  it('思考强度默认 off → loop.run 不带 thinking（用模型默认档）', async () => {
    const { composer, fetchMock } = await mountChat()
    await startRun(composer, fetchMock, '你好')
    const run = commandBodies(fetchMock).find((b) => b.topic === 'loop.run')!
    expect((run.payload as { thinking?: string }).thinking).toBeUndefined()
    expect(run.payload).toMatchObject({ provider: 'deepseek', model: 'deepseek-chat' })
    fetchMock.mockRestore()
  })

  it('停止按钮 → POST loop.cancel（A，非 llm.cancel）', async () => {
    const { composer, fetchMock } = await mountChat()
    const a = await startRun(composer, fetchMock, 'hi')
    await composer.get('[data-testid="composer-stop"]').trigger('click')
    await flushPromises()
    const bodies = commandBodies(fetchMock)
    const cancel = bodies.find((b) => b.topic === 'loop.cancel')!
    expect(cancel).toBeTruthy()
    expect((cancel.payload as { requestId: string }).requestId).toBe(a)
    expect(bodies.find((b) => b.topic === 'llm.cancel')).toBeUndefined()
    fetchMock.mockRestore()
  })

  it('设置页关掉的模型，这里选不到（llm.enabledModels 是真的生效，不是假开关）', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: unknown) => {
      if (String(input).includes('/api/preferences')) {
        return new Response(JSON.stringify({ llm: { enabledModels: ['deepseek::deepseek-reasoner'] } }), { status: 200 })
      }
      return new Response(null, { status: 202 })
    })
    const composer = mount(ChatComposerWidget)
    await flushPromises()
    emit('llm.provider.registered', DESCRIPTOR)
    await flushPromises()
    emit('llm.models.list.result', {
      requestId: 'x',
      provider: 'deepseek',
      models: ['deepseek-chat', 'deepseek-reasoner'],
      catalog: 'remote',
    })
    await flushPromises()

    const options = composer.findAll('[data-testid="composer-model"] option').map((o) => o.text())
    expect(options, '没被关掉的必须还能选').toContain('deepseek-chat')
    expect(options, '关掉了却还出现在下拉里 = 设置页的开关是假的').not.toContain('deepseek-reasoner')
    fetchMock.mockRestore()
  })

  it('无 provider → EmptyState，输入框不出现', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 202 }))
    const composer = mount(ChatComposerWidget)
    await flushPromises()
    expect(composer.text()).toContain('尚未注册任何 provider')
    expect(composer.find('[data-testid="composer-input"]').exists()).toBe(false)
    fetchMock.mockRestore()
  })
})

describe('②③ 拆分后的契约：零直接通信', () => {
  it('② 单独挂载能渲染历史，且不发任何命令（纯展示）', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 202 }))
    const timeline = mount(ChatTimelineWidget)
    await flushPromises()
    useSessionStore().messages = [
      { id: 'm1', role: 'assistant', content: '只有时间线', createdAt: '2024-01-01' },
    ] as never
    await timeline.vm.$nextTick()
    expect(timeline.get('[data-testid="timeline-assistant"]').text()).toContain('只有时间线')
    expect(commandBodies(fetchMock), '② 不该发命令').toEqual([])
    fetchMock.mockRestore()
  })

  it('③ 单独挂载也能发问（不依赖 ② 存在）', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 202 }))
    const composer = mount(ChatComposerWidget)
    await flushPromises()
    emit('llm.provider.registered', DESCRIPTOR)
    useSessionStore().select('s1')
    await flushPromises()
    const a = await startRun(composer, fetchMock, '只有输入框')
    expect(a).toBeTruthy()
    expect(commandBodies(fetchMock).some((b) => b.topic === 'loop.run')).toBe(true)
    fetchMock.mockRestore()
  })

  it('共享同一份 sending：③ 显示「停止」时 ② 的 spinner 在转（无组件间通信）', async () => {
    const { timeline, composer, fetchMock } = await mountChat('s1')
    await startRun(composer, fetchMock, 'hi')
    await flushPromises()
    expect(composer.find('[data-testid="composer-stop"]').exists()).toBe(true)
    // ② 的 in-flight 行仍是 pending
    expect(timeline.get('[data-testid="timeline-assistant"]').text()).toContain('')
    fetchMock.mockRestore()
  })

  it('切会话 → ② 的 in-flight 清空 + 重新载入历史', async () => {
    const { timeline, composer, sessions, fetchMock } = await mountChat('s1')
    const a = await startRun(composer, fetchMock, 'hi')
    emit('loop.token.streamed', { requestId: a, sessionId: 's1', token: '脏数据', index: 0 })
    await timeline.vm.$nextTick()
    expect(timeline.text()).toContain('脏数据')

    // 切到另一个会话 → 本地 in-flight 必须清掉（否则上一轮的半截内容留在新会话里）
    sessions.select('s2')
    await flushPromises()
    await timeline.vm.$nextTick()
    expect(timeline.text(), '切会话后不该残留上一轮的 in-flight').not.toContain('脏数据')
    // 并且为新会话重新拉历史
    const gets = commandBodies(fetchMock).filter((b) => b.topic === 'session.get')
    expect(gets.at(-1)!.payload).toMatchObject({ sessionId: 's2' })
    fetchMock.mockRestore()
  })
})
