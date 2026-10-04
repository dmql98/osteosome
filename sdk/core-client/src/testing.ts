/**
 * 测试用的假 EventSource（P6）。
 *
 * ## 为什么提供它，而不是让每个插件 UI 各自 mock `sse`
 *
 * 踩过一次：models/ui 的测试 mock 的是 `@osteosome/core-client` 的公共入口，
 * 但包内部的 `useEndpointProbe` import 的是**相对路径** `./sse` ——
 * 于是 mock 落空，`useEndpointProbe` 用了真的 sse，真的去 `new EventSource`，
 * jsdom 里没有这个东西，报的是「connection failed」而断言看起来像组件坏了。
 *
 * 更要紧的是这个坑的**形状**很常见：mock 一个「实现没有 import 的模块」不会报错，
 * 只会让被测物偷偷用了真实现。症状与「组件有 bug」一模一样。
 *
 * ## 为什么放在包里而不是复制到每个测试文件
 *
 * 假 EventSource 必须知道**真实的 wire 格式**（消息是 `{topic, payload}` 的 JSON）。
 * 格式一改，各处复制的假实现就会静默地继续按旧格式发消息 ——
 * 于是测试全绿而线上收不到事件。所以它必须和定义格式的代码放在一起。
 *
 * ## 用法
 *
 * ```ts
 * const sse = installFakeEventSource()   // 每个用例前调（或 beforeEach）
 * // …挂载组件…
 * sse.emit('llm.provider.registered', { provider: 'openai' })
 * ```
 */
export interface FakeEventSource {
  /** 造一条消息投给所有订阅者（走真实客户端的 JSON 解包与 topic 匹配） */
  emit(topic: string, payload: unknown): void
  /** 当前被创建的连接数。用于断言「没有多余连接」 */
  readonly openCount: number
  /** 被创建过的连接 URL */
  readonly urls: string[]
  /** 恢复真实环境 */
  restore(): void
}

class FakeEventSourceImpl {
  static instances: FakeEventSourceImpl[] = []
  readonly listeners = new Map<string, Array<(event: unknown) => void>>()
  closed = false

  constructor(readonly url: string) {
    FakeEventSourceImpl.instances.push(this)
  }

  addEventListener(type: string, handler: (event: unknown) => void): void {
    const list = this.listeners.get(type) ?? []
    list.push(handler)
    this.listeners.set(type, list)
  }

  removeEventListener(type: string, handler: (event: unknown) => void): void {
    const list = this.listeners.get(type) ?? []
    const index = list.indexOf(handler)
    if (index >= 0) list.splice(index, 1)
  }

  close(): void {
    this.closed = true
  }

  dispatch(type: string, event: unknown): void {
    // 真实的 EventSource 一旦 close 就不再投递事件。**必须守这条**：
    // `SseClient` 每订阅一个新 topic 就会 close 旧连接再建新的，于是同一批
    // handler 会被挂到多个连接上；假实现若还往已关闭的连接投消息，
    // 一个 token 就会被 append 很多次 —— 症状是「文本变成 你你你你你」。
    // 那是**假的** bug，但排查它要花掉半小时，所以写进实现里。
    if (this.closed) return
    for (const handler of [...(this.listeners.get(type) ?? [])]) handler(event)
  }

  /** SSE 客户端把 open 当作「连上了」，这里立刻触发，省掉每个用例的等待 */
  open(): void {
    this.dispatch('open', new Event('open'))
  }

  /** 按**真实 wire 格式**投一条消息 */
  message(topic: string, payload: unknown): void {
    this.dispatch('message', { data: JSON.stringify({ topic, payload }) } as MessageEvent<string>)
  }
}

/** 装上假 EventSource，并让第一个连接立刻进入 open 状态 */
export function installFakeEventSource(): FakeEventSource {
  FakeEventSourceImpl.instances = []
  const original = (globalThis as { EventSource?: unknown }).EventSource
  ;(globalThis as { EventSource?: unknown }).EventSource = class extends FakeEventSourceImpl {
    constructor(url: string) {
      super(url)
      // 真实客户端在 open 之后才认为 connected；同步触发，避免用例里出现「等一下」的竞态
      queueMicrotask(() => this.open())
    }
  }
  const api: FakeEventSource = {
    emit(topic, payload) {
      for (const instance of FakeEventSourceImpl.instances) instance.message(topic, payload)
    },
    get openCount() {
      return FakeEventSourceImpl.instances.length
    },
    get urls() {
      return FakeEventSourceImpl.instances.map((i) => i.url)
    },
    restore() {
      if (original === undefined) delete (globalThis as { EventSource?: unknown }).EventSource
      else (globalThis as { EventSource?: unknown }).EventSource = original
      FakeEventSourceImpl.instances = []
    },
  }
  return api
}