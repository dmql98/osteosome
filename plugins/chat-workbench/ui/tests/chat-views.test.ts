/**
 * ② 时间线 / ③ 输入框 单测（P6 迁入 `plugins/chat-workbench/ui` 后重写）。
 *
 * ## 与搬迁前相比，测试要改的东西
 *
 * | | 搬迁前（client/widgets） | 搬迁后 |
 * |---|---|---|
 * | 挂载对象 | 本地 `*Widget.vue` | `plugins/chat-workbench/ui/src/views/*` |
 * | 状态来源 | pinia `chat.store` / `session.store` | 各自 `useSessionState()` / `useRunState()`（无 pinia） |
 * | SSE | mock 捕获 handler | 真客户端 + 假 `EventSource`（同一手法，但 mock 落在正确的位置） |
 * | 注入历史 | 直接改 `sessions.messages` | 发 `session.get.result` |
 * | 当前会话 | `sessions.select('s1')` | `setCurrentSessionId('s1')`（共享层，非 store 字段） |
 *
 * ## 一处真正的行为改动，断言必须跟着改
 *
 * **原来** ③ 一发问就乐观造出 user 行 + assistant 占位行，因为 ②③ 共享同一个 store，
 * 本地造的行 ② 立刻看得见。**现在** 两个 iframe 各持一份状态，本地造的行另一个看不见 ——
 * 而正确做法本来就不是乐观：user 行等 `message.appended`（服务端真的落了库才显示），
 * assistant 占位行等 `loop.state.changed{state:'running'}`。
 *
 * 于是多出两条必须存在的断言：
 *   1. 「发问之后、running 到达之前」② **不该**显示任何东西；
 *   2. user 行**不是**提交时出现的，而是服务端回执 `message.appended` 之后出现的。
 *
 * 这两条不是测试变严了 —— 是「界面上有的东西一定存下来了」这个性质的直接体现。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { installFakeEventSource, type FakeEventSource } from '@osteosome/core-client/testing'
import { sse } from '@osteosome/core-client'
import ChatTimelineView from '../src/views/ChatTimelineView.vue'
import ChatComposerView from '../src/views/ChatComposerView.vue'
import {
  CUR_ID_KEY,
  __resetSessionSyncForTest,
  currentSessionId,
  setCurrentSessionId,
  startSessionSync,
} from '../src/state/session-sync'

const DESCRIPTOR = {
  provider: 'deepseek',
  defaultModel: 'deepseek-chat',
  credentialRef: 'env:DEEPSEEK_API_KEY',
  retryPolicy: { maxAttempts: 3, baseDelayMs: 500, backoff: 'exponential', retryableCodes: ['rate_limited'] },
}

let fakeSse: FakeEventSource
const mounted: VueWrapper[] = []

function emit(topic: string, payload: unknown): void {
  fakeSse.emit(topic, payload)
}

/**
 * 取出每次 POST /api/command 的请求体。
 *
 * 必须按 URL 过滤：页面还会发 `GET /api/preferences`（读模型开关）这类**没有 body** 的请求，
 * `JSON.parse('undefined')` 会直接炸在这里 —— 症状是毫不相关的用例集体失败。
 */
function commandBodies(fetchMock: { mock: { calls: unknown[][] } }): Record<string, unknown>[] {
  return fetchMock.mock.calls
    .filter((c) => String(c[0]).includes('/api/command'))
    .map((c) => JSON.parse(String((c[1] as { body?: unknown } | undefined)?.body)) as Record<string, unknown>)
}

/** Select 的 options 是 prop，直接改 value + change 触发 */
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
  // 共享层也要复位：它是模块级 ref + sessionStorage，不清就会串用例
  __resetSessionSyncForTest()
})

afterEach(() => {
  for (const w of mounted) w.unmount()
  mounted.length = 0
  vi.unstubAllGlobals()
})

/** 挂 ② + ③，并把当前会话设成 sessionId（不传则不设）。返回类型留给 TS 推断 ——
 * 显式写 `ReturnType<typeof vi.spyOn>` 会落到 `vi.spyOn` 的某个具体重载上，反而不兼容。 */
async function mountViews(sessionId = 's1') {
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 202 }))
  if (sessionId) setCurrentSessionId(sessionId)
  const timeline = mount(ChatTimelineView)
  const composer = mount(ChatComposerView)
  mounted.push(timeline, composer)
  await flushPromises()
  emit('llm.provider.registered', DESCRIPTOR)
  await flushPromises()
  return { timeline, composer, fetchMock }
}

/**
 * 提交一轮并让服务端"接住"。
 *
 * 分两步是刻意的：先拿 `loop.run` 的 requestId（= A），再发 `loop.state.changed{running}` ——
 * 这正是服务端的顺序，而中间那一小段窗口正是「乐观行 vs 服务端回执」的分界线。
 * 需要断言分界线本身的用例用 `beginRun` + 手动 `emitRunning`。
 */
async function submitRun(
  composer: VueWrapper,
  fetchMock: { mock: { calls: unknown[][] } },
  text = 'hi',
): Promise<string> {
  await composer.get('[data-testid="composer-input"]').setValue(text)
  await composer.get('form').trigger('submit')
  await flushPromises()
  const run = commandBodies(fetchMock).find((b) => b.topic === 'loop.run')!
  return (run.payload as { requestId: string }).requestId
}

/** 服务端"接住"了：发 running，于是 ② 认领 A 并出现占位行 */
function emitRunning(a: string, sessionId = 's1'): void {
  emit('loop.state.changed', { requestId: a, sessionId, state: 'running' })
}

/** 提交 + 服务端接住，返回 A（多数用例需要的完整序列） */
async function startRun(
  composer: VueWrapper,
  fetchMock: { mock: { calls: unknown[][] } },
  text = 'hi',
  sessionId = 's1',
): Promise<string> {
  const a = await submitRun(composer, fetchMock, text)
  emitRunning(a, sessionId)
  await flushPromises()
  return a
}

/** 服务端落库一条 user 消息（`loop.run` 之后 loop 会发 `message.append`，session 回 `message.appended`） */
function emitUserAppended(content: string, sessionId = 's1', id = 'srv_u'): void {
  emit('message.appended', {
    sessionId,
    message: { id, role: 'user', content, createdAt: '2024-01-01' },
  })
}

/** 服务端落库一条 assistant 消息 */
function emitAssistantAppended(content: string, sessionId = 's1', id = 'srv_a'): void {
  emit('message.appended', {
    sessionId,
    message: { id, role: 'assistant', content, createdAt: '2024-01-01' },
  })
}

describe('chat-timeline（②）· 消息投影', () => {
  it('选中会话 → 发 session.get 载入历史', async () => {
    const { fetchMock } = await mountViews('s1')
    expect(commandBodies(fetchMock).map((b) => b.topic)).toContain('session.get')
  })

  it('session.get.result → 渲染历史消息', async () => {
    const { timeline } = await mountViews('s1')
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
  })

  it('发问之后、服务端 running 之前 → ② 什么都没有（不造乐观行）', async () => {
    const { timeline, composer, fetchMock } = await mountViews('s1')
    const a = await submitRun(composer, fetchMock, '你好')
    await timeline.vm.$nextTick()
    // 这一段是与搬迁前的**行为差异**，也是去掉乐观行的意义所在：
    // ② 和 ③ 是两个 iframe，③ 本地造的行 ② 根本看不见。必须等服务端事件。
    expect(timeline.text(), 'running 到达前不该有任何消息行').not.toContain('你好')
    expect(timeline.findAll('[data-testid="timeline-assistant"]')).toHaveLength(0)
    // A 已经发出去了，只是还没"认领"
    expect(a).toBeTruthy()
  })

  it('loop.state.changed{running} → ② 认领 A、出占位行；③ 同步变「停止」', async () => {
    const { timeline, composer, fetchMock } = await mountViews('s1')
    const a = await submitRun(composer, fetchMock, '你好')
    expect(composer.find('[data-testid="composer-send"]').exists()).toBe(true)

    emitRunning(a)
    await flushPromises()
    await timeline.vm.$nextTick()
    expect(timeline.findAll('[data-testid="timeline-assistant"]')).toHaveLength(1)
    expect(composer.find('[data-testid="composer-stop"]').exists(), '③ 认领到同一个 A').toBe(true)
  })

  it('user 行靠服务端回执出现，不是提交那一刻（"界面上有的东西一定存下来了"）', async () => {
    const { timeline, composer, fetchMock } = await mountViews('s1')
    await startRun(composer, fetchMock, '你好')
    await timeline.vm.$nextTick()
    expect(timeline.text(), '回执前没有 user 行').not.toContain('你好')

    emitUserAppended('你好')
    await timeline.vm.$nextTick()
    expect(timeline.get('[data-testid="timeline-user"]').text()).toContain('你好')
  })

  it('loop.token.streamed → 累积到 in-flight assistant', async () => {
    const { timeline, composer, fetchMock } = await mountViews('s1')
    const a = await startRun(composer, fetchMock, '你好')
    emit('loop.token.streamed', { requestId: a, sessionId: 's1', token: '你', index: 0 })
    emit('loop.token.streamed', { requestId: a, sessionId: 's1', token: '好', index: 1 })
    await timeline.vm.$nextTick()
    expect(timeline.get('[data-testid="timeline-assistant"]').text()).toBe('你好')
  })

  it('异 requestId 的 token 被忽略（上一轮迟到的 token 不能污染新一轮）', async () => {
    const { timeline, composer, fetchMock } = await mountViews('s1')
    const a = await startRun(composer, fetchMock, 'hi')
    emit('loop.token.streamed', { requestId: 'other', sessionId: 's1', token: 'X', index: 0 })
    await timeline.vm.$nextTick()
    emit('loop.token.streamed', { requestId: a, sessionId: 's1', token: 'Y', index: 0 })
    await timeline.vm.$nextTick()
    expect(timeline.get('[data-testid="timeline-assistant"]').text()).toBe('Y')
  })

  it('异 sessionId 的事件被忽略（在别的会话上跑的一轮不该出现在这里）', async () => {
    const { timeline, composer, fetchMock } = await mountViews('s1')
    await startRun(composer, fetchMock, 'hi')
    emit('loop.token.streamed', { requestId: 'other-run', sessionId: 'other', token: 'Z', index: 0 })
    await timeline.vm.$nextTick()
    expect(timeline.text(), '别的会话的 token 不该串进来').not.toContain('Z')
  })

  it('message.appended(assistant) → 占位行换成历史消息，且**只出现一次**', async () => {
    const { timeline, composer, fetchMock } = await mountViews('s1')
    const a = await startRun(composer, fetchMock, 'hi')
    emit('loop.token.streamed', { requestId: a, sessionId: 's1', token: '答案', index: 0 })
    await timeline.vm.$nextTick()
    expect(timeline.findAll('[data-testid="timeline-assistant"]')).toHaveLength(1)

    emitAssistantAppended('答案')
    await timeline.vm.$nextTick()
    const texts = timeline.findAll('[data-testid="timeline-assistant"]').map((n) => n.text())
    expect(
      texts.filter((t) => t.includes('答案')),
      '占位行与历史消息若同时存在，同一个回答会显示两遍',
    ).toHaveLength(1)
    // 占位行已消：它不再 pending
    expect(timeline.find('[data-testid="timeline-caret"]').exists()).toBe(false)
  })

  it('loop.run.failed → 错误内联在末尾 + 保留半句 + ③ 恢复可发送', async () => {
    const { timeline, composer, fetchMock } = await mountViews('s1')
    const a = await startRun(composer, fetchMock, 'hi')
    emit('loop.token.streamed', { requestId: a, sessionId: 's1', token: '半句', index: 0 })
    await timeline.vm.$nextTick()

    emit('loop.run.failed', { requestId: a, sessionId: 's1', error: { code: 'missing_credential', message: 'no key' } })
    await timeline.vm.$nextTick()
    expect(timeline.get('[data-testid="timeline-failed"]').text()).toContain('缺少 API Key')
    expect(timeline.get('[data-testid="timeline-assistant"]').text()).toContain('半句')
    expect(composer.find('[data-testid="composer-send"]').exists()).toBe(true)
  })

  it('失败时占位行是空的 → 删掉（不留永远转圈的幽灵气泡）', async () => {
    const { timeline, composer, fetchMock } = await mountViews('s1')
    const a = await startRun(composer, fetchMock, 'hi')
    emit('loop.run.failed', { requestId: a, sessionId: 's1', error: { code: 'network', message: 'boom' } })
    await timeline.vm.$nextTick()
    expect(timeline.findAll('[data-testid="timeline-assistant"]')).toHaveLength(0)
    // `.get()` 在找不到时是**抛**而不是返回假，所以「有没有」一律用 `.find()`
    expect(timeline.find('[data-testid="timeline-failed"]').exists()).toBe(true)
  })

  it('loop 崩溃（service.failed loop）→ 清在途 + ③ 恢复输入', async () => {
    const { composer, fetchMock } = await mountViews('s1')
    await startRun(composer, fetchMock, 'hi')
    emit('service.failed', { serviceId: 'loop', reason: 'crashed' })
    await flushPromises()
    await composer.vm.$nextTick()
    expect(composer.find('[data-testid="composer-send"]').exists()).toBe(true)
  })
})

describe('chat-timeline（②）· 思维链隔离与元信息', () => {
  it('reasoning token → 进折叠块，正文不含思维链', async () => {
    const { timeline, composer, fetchMock } = await mountViews('s1')
    const a = await startRun(composer, fetchMock, '这题怎么解')
    emit('loop.token.streamed', { requestId: a, sessionId: 's1', token: '让我想想', index: 0, blockType: 'reasoning' })
    emit('loop.token.streamed', { requestId: a, sessionId: 's1', token: '答案是四十二', index: 1, blockType: 'text' })
    await timeline.vm.$nextTick()

    const body = timeline.get('[data-testid="timeline-assistant"]').text()
    expect(body).toContain('答案是四十二')
    expect(body).not.toContain('让我想想')
    const thinking = timeline.find('[data-testid^="timeline-thinking-"]')
    expect(thinking.exists()).toBe(true)
    expect(thinking.text()).toContain('让我想想')
  })

  it('缺省 blockType 的 token 仍算正文（老节点不发该字段）', async () => {
    const { timeline, composer, fetchMock } = await mountViews('s1')
    const a = await startRun(composer, fetchMock, 'hi')
    emit('loop.token.streamed', { requestId: a, sessionId: 's1', token: '正文', index: 0 })
    await timeline.vm.$nextTick()
    expect(timeline.get('[data-testid="timeline-assistant"]').text()).toContain('正文')
    expect(timeline.find('[data-testid^="timeline-thinking-"]').exists()).toBe(false)
  })

  it('落库消息带 reasoning / finishReason / usage → 折叠块 + 元信息行', async () => {
    const { timeline } = await mountViews('s1')
    emit('session.get.result', {
      session: {
        meta: { id: 's1' },
        messages: [
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
        ],
      },
    })
    await timeline.vm.$nextTick()
    expect(timeline.find('[data-testid^="timeline-thinking-"]').text()).toContain('思考过程')
    const meta = timeline.get('[data-testid="timeline-meta"]').text()
    expect(meta).toContain('达到长度上限')
    expect(meta).toContain('↑9')
    expect(meta).toContain('↓4')
  })

  it('流式期间正文非空 → 出现尾光标', async () => {
    const { timeline, composer, fetchMock } = await mountViews('s1')
    const a = await startRun(composer, fetchMock, 'hi')
    emit('loop.token.streamed', { requestId: a, sessionId: 's1', token: '开始', index: 0 })
    await timeline.vm.$nextTick()
    expect(timeline.find('[data-testid="timeline-caret"]').exists()).toBe(true)
  })
})

describe('chat-timeline（②）· 工具块', () => {
  it('loop.tool.executed → 渲染工具名 + 参数 + 成功摘要', async () => {
    const { timeline, composer, fetchMock } = await mountViews('s1')
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
  })

  it('工具失败 → 块上带失败态与错误摘要', async () => {
    const { timeline, composer, fetchMock } = await mountViews('s1')
    const a = await startRun(composer, fetchMock, '读文件')
    emit('loop.tool.executed', {
      requestId: a, sessionId: 's1', toolCallId: 'c-2', name: 'read_file',
      arguments: '{"path":"../x"}', ok: false, summary: '路径非法',
    })
    await timeline.vm.$nextTick()
    const block = timeline.get('[data-testid="timeline-tool-read_file"]')
    expect(block.classes()).toContain('chat-timeline__tool--failed')
    expect(block.text()).toContain('路径非法')
  })

  it('回看历史：assistant 消息带 toolCalls → 渲染工具块', async () => {
    const { timeline } = await mountViews('s1')
    emit('session.get.result', {
      session: {
        meta: { id: 's1' },
        messages: [
          { id: 'm1', role: 'user', content: '看看目录', createdAt: '2024-01-01' },
          {
            id: 'm2', role: 'assistant', content: '', createdAt: '2024-01-01',
            toolCalls: [{ id: 'c-1', name: 'list_dir', arguments: '{"path":""}' }],
          },
        ],
      },
    })
    await timeline.vm.$nextTick()
    expect(timeline.get('[data-testid="timeline-tool-list_dir"]').text()).toContain('list_dir')
  })

  it('异 requestId 的工具事件被忽略（不串轮）', async () => {
    const { timeline, composer, fetchMock } = await mountViews('s1')
    await startRun(composer, fetchMock, 'hi')
    emit('loop.tool.executed', {
      requestId: 'other', sessionId: 's1', toolCallId: 'c-9', name: 'list_dir',
      arguments: '{}', ok: true, summary: 'x',
    })
    await timeline.vm.$nextTick()
    expect(timeline.find('[data-testid="timeline-tool-list_dir"]').exists()).toBe(false)
  })
})

/**
 * 参数链路（P4 WS-2）：模型选择 + 思考强度 + provider 真正进 `loop.run`。
 * 断层回归：P3 时这三处是「装饰」，现由 `llm.models.list` + `loop.run` 新字段兑现。
 */
describe('chat-composer（③）· 参数链路', () => {
  it('provider 注册 → 拉该家模型目录；result 到达 → 模型下拉出选项', async () => {
    const { composer, fetchMock } = await mountViews()
    expect(commandBodies(fetchMock).some((b) => b.topic === 'llm.models.list')).toBe(true)

    emit('llm.models.list.result', {
      requestId: 'models-1', provider: 'deepseek',
      models: ['deepseek-chat', 'deepseek-reasoner'], catalog: 'remote',
    })
    await composer.vm.$nextTick()
    const options = composer.get('[data-testid="composer-model"] select').findAll('option')
    expect(options.map((o) => o.text())).toEqual(['deepseek-chat', 'deepseek-reasoner'])
    expect(composer.find('[data-testid="composer-static-badge"]').exists()).toBe(false)
  })

  it('目录降级 static → 挂角标', async () => {
    const { composer } = await mountViews()
    emit('llm.models.list.result', {
      requestId: 'models-1', provider: 'deepseek', models: ['deepseek-chat'], catalog: 'static',
    })
    await composer.vm.$nextTick()
    expect(composer.get('[data-testid="composer-static-badge"]').text()).toContain('静态')
  })

  it('目录不含当前模型 → 回落到声明默认模型，否则取第一项', async () => {
    const { composer } = await mountViews()
    emit('llm.models.list.result', {
      requestId: 'models-1', provider: 'deepseek', models: ['deepseek-reasoner'], catalog: 'remote',
    })
    await composer.vm.$nextTick()
    const el = composer.get('[data-testid="composer-model"] select').element as HTMLSelectElement
    expect(el.value).toBe('deepseek-reasoner')
  })

  it('发问 → loop.run 带 provider / model / thinking', async () => {
    const { composer, fetchMock } = await mountViews()
    emit('llm.models.list.result', {
      requestId: 'models-1', provider: 'deepseek',
      models: ['deepseek-chat', 'deepseek-reasoner'], catalog: 'remote',
    })
    await composer.vm.$nextTick()
    await setSelect(composer, 'composer-model', 'deepseek-reasoner')
    await setSelect(composer, 'composer-thinking', 'high')

    await submitRun(composer, fetchMock, '你好')
    const run = commandBodies(fetchMock).find((b) => b.topic === 'loop.run')!
    expect(run.payload).toMatchObject({
      text: '你好', provider: 'deepseek', model: 'deepseek-reasoner', thinking: 'high',
    })
  })

  it('思考强度默认 off → loop.run 不带 thinking（用模型默认档）', async () => {
    const { composer, fetchMock } = await mountViews()
    await submitRun(composer, fetchMock, '你好')
    const run = commandBodies(fetchMock).find((b) => b.topic === 'loop.run')!
    expect((run.payload as { thinking?: string }).thinking).toBeUndefined()
    expect(run.payload).toMatchObject({ provider: 'deepseek', model: 'deepseek-chat' })
  })

  it('停止按钮 → POST loop.cancel（A，非 llm.cancel）', async () => {
    const { composer, fetchMock } = await mountViews()
    const a = await startRun(composer, fetchMock, 'hi')
    await composer.get('[data-testid="composer-stop"]').trigger('click')
    await flushPromises()
    const bodies = commandBodies(fetchMock)
    const cancel = bodies.find((b) => b.topic === 'loop.cancel')!
    expect(cancel).toBeTruthy()
    expect((cancel.payload as { requestId: string }).requestId).toBe(a)
    expect(bodies.find((b) => b.topic === 'llm.cancel')).toBeUndefined()
  })

  it('取消成功 → 占位行清掉（取消是成功路径，不留半截 assistant）', async () => {
    const { timeline, composer, fetchMock } = await mountViews('s1')
    const a = await startRun(composer, fetchMock, 'hi')
    emit('loop.token.streamed', { requestId: a, sessionId: 's1', token: '半截', index: 0 })
    await timeline.vm.$nextTick()
    expect(timeline.text()).toContain('半截')

    await composer.get('[data-testid="composer-stop"]').trigger('click')
    await flushPromises()
    emit('loop.run.cancelled', { requestId: a, sessionId: 's1' })
    await timeline.vm.$nextTick()
    expect(timeline.text(), '取消后不该留半截回答').not.toContain('半截')
    expect(composer.find('[data-testid="composer-send"]').exists()).toBe(true)
  })

  it('设置页关掉的模型，这里选不到（llm.enabledModels 是真的生效，不是假开关）', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: unknown) => {
      if (String(input).includes('/api/preferences')) {
        return new Response(JSON.stringify({ llm: { enabledModels: ['deepseek::deepseek-reasoner'] } }), { status: 200 })
      }
      return new Response(null, { status: 202 })
    })
    const composer = mount(ChatComposerView)
    mounted.push(composer)
    await flushPromises()
    emit('llm.provider.registered', DESCRIPTOR)
    await flushPromises()
    emit('llm.models.list.result', {
      requestId: 'x', provider: 'deepseek',
      models: ['deepseek-chat', 'deepseek-reasoner'], catalog: 'remote',
    })
    await flushPromises()

    const options = composer.findAll('[data-testid="composer-model"] option').map((o) => o.text())
    expect(options, '没被关掉的必须还能选').toContain('deepseek-chat')
    expect(options, '关掉了却还出现在下拉里 = 设置页的开关是假的').not.toContain('deepseek-reasoner')
  })

  it('无 provider → EmptyState，输入框不出现', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 202 }))
    const composer = mount(ChatComposerView)
    mounted.push(composer)
    await flushPromises()
    expect(composer.text()).toContain('尚未注册任何 provider')
    expect(composer.find('[data-testid="composer-input"]').exists()).toBe(false)
  })

  it('没有当前会话 → 先建一个再发问（curId 是空串的兜底路径）', async () => {
    setCurrentSessionId('')
    const { composer, fetchMock } = await mountViews('')
    await composer.get('[data-testid="composer-input"]').setValue('新会话第一句')
    await composer.get('form').trigger('submit')
    await flushPromises()

    const create = commandBodies(fetchMock).find((b) => b.topic === 'session.create')
    expect(create, '没有 curId 时必须先建会话').toBeTruthy()

    // 服务端回执带真实 id（**不是** command 的 requestId —— 拿错的话
    // 第一句会跑到一个不存在的会话上，而症状只是「历史空的」）
    emit('session.create.result', {
      requestId: (create!.payload as { requestId: string }).requestId,
      sessionId: 'srv_new_1',
    })
    await flushPromises()

    const run = commandBodies(fetchMock).find((b) => b.topic === 'loop.run')
    expect(run, '拿到 sessionId 之后才该发 loop.run').toBeTruthy()
    expect(run!.payload).toMatchObject({ sessionId: 'srv_new_1' })
    expect(currentSessionId().value, '新建后共享层也切过去').toBe('srv_new_1')
  })
})

/**
 * 跨 iframe 契约 —— **本文件最重要的那一节**。
 *
 * 搬迁前这里的断言是「②③ 零直接通信，靠同一个 pinia store」。
 * 搬迁后连 store 都没有了：三个 iframe 各持一份状态，**唯一共享的是 `curId`**，
 * 其余全部由同一批 SSE 事件各自派生。
 *
 * 所以要证明的不再是「没有组件间通信」，而是更强的那句：
 * **同一批事件，在任意两个独立实例上得出同一份视图。**
 * 这正是「把三盒拆成三个 iframe 却仍然像一个界面」的全部依据。
 */
describe('跨 iframe 契约：同一批事件 → 同一份视图', () => {
  it('两个独立的时间线实例，渲染结果逐字相同', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 202 }))
    setCurrentSessionId('s1')
    const a = mount(ChatTimelineView)
    const b = mount(ChatTimelineView)
    mounted.push(a, b)
    await flushPromises()
    await Promise.all([a.vm.$nextTick(), b.vm.$nextTick()])

    emit('session.get.result', {
      session: {
        meta: { id: 's1' },
        messages: [{ id: 'm1', role: 'user', content: '同一个问题', createdAt: '2024-01-01' }],
      },
    })
    await flushPromises()
    await Promise.all([a.vm.$nextTick(), b.vm.$nextTick()])

    expect(a.get('[data-testid="timeline-messages"]').text()).toBe(
      b.get('[data-testid="timeline-messages"]').text(),
    )
    expect(a.get('[data-testid="timeline-messages"]').text()).toContain('同一个问题')
    // ② 是纯展示：它不发 loop.* 命令（session.list / session.get 是它自己的数据自举）
    const loopCommands = commandBodies(fetchMock).filter((c) => String(c.topic).startsWith('loop.'))
    expect(loopCommands, '② 不该发 loop.* 命令').toEqual([])
  })

  it('共享的只有 curId：两个实例读到同一个值，切会话另一个也跟着切', async () => {
    setCurrentSessionId('s1')
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 202 }))
    const a = mount(ChatTimelineView)
    const b = mount(ChatTimelineView)
    mounted.push(a, b)
    await flushPromises()
    await Promise.all([a.vm.$nextTick(), b.vm.$nextTick()])

    expect(currentSessionId().value).toBe('s1')
    setCurrentSessionId('s2')
    await flushPromises()
    expect(currentSessionId().value, '写方与读方都是同一个共享 ref').toBe('s2')

    const gets = commandBodies(fetchMock).filter((c) => c.topic === 'session.get')
    expect(gets.at(-1)!.payload, 'curId 变了，两个实例都为它重新拉历史').toMatchObject({ sessionId: 's2' })
  })

  it('共享 curId 的同步：另一个浏览上下文改 curId，这边也跟上（storage 事件）', async () => {
    setCurrentSessionId('s1')
    // `startSessionSync()` 是 App.vue 的 onMounted 调的（每个 iframe 一次），
    // 这里直接挂视图所以补调一次 —— 没有它就没有 storage 监听，事件白发
    const stopSync = startSessionSync()
    const a = mount(ChatTimelineView)
    mounted.push(a)
    await flushPromises()

    // 模拟「另一个 iframe / 另一个 Tab」写 sessionStorage。
    // storage 事件**不在写入方自己身上触发** —— 所以不能调 setCurrentSessionId 来测，
    // 必须直接写盘 + 派发事件，那才是「别人写的」那一条
    window.sessionStorage.setItem(CUR_ID_KEY, 'from-other-context')
    window.dispatchEvent(new StorageEvent('storage', { key: CUR_ID_KEY, newValue: 'from-other-context' }))
    await flushPromises()
    expect(currentSessionId().value).toBe('from-other-context')
    stopSync()
  })

  it('③ 单独挂载也能发问（不依赖 ② 存在）', async () => {
    setCurrentSessionId('s1')
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 202 }))
    const composer = mount(ChatComposerView)
    mounted.push(composer)
    await flushPromises()
    emit('llm.provider.registered', DESCRIPTOR)
    await flushPromises()

    const a = await submitRun(composer, fetchMock, '只有输入框')
    expect(a).toBeTruthy()
    expect(commandBodies(fetchMock).some((b) => b.topic === 'loop.run')).toBe(true)
  })

  it('切会话 → 在途行清空 + 重新载入历史（半截内容不许跟着用户走）', async () => {
    const { timeline, composer, fetchMock } = await mountViews('s1')
    const a = await startRun(composer, fetchMock, 'hi')
    emit('loop.token.streamed', { requestId: a, sessionId: 's1', token: '脏数据', index: 0 })
    await timeline.vm.$nextTick()
    expect(timeline.text()).toContain('脏数据')

    setCurrentSessionId('s2')
    await flushPromises()
    await timeline.vm.$nextTick()
    expect(timeline.text(), '切会话后不该残留上一轮的 in-flight').not.toContain('脏数据')

    const gets = commandBodies(fetchMock).filter((b) => b.topic === 'session.get')
    expect(gets.at(-1)!.payload).toMatchObject({ sessionId: 's2' })
  })
})