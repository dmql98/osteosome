/**
 * loop 状态机单测（P3 WS-3）—— 纯逻辑直测 LoopCore（不依赖总线帧往返）。
 * 覆盖：state 机 idle→running→idle、防重入、A/B requestId 不串号、in-flight 累积、
 * cancel、失败释放、崩溃 reset。
 */
import { describe, expect, it, beforeEach } from 'vitest'
import { LoopCore } from '../src/core'
import { buildMessages } from '../src/history'

function makeCore() {
  const sent: { kind: 'request'; b: string; sessionId: string; messages: unknown[] }[] = []
  const cancels: string[] = []
  const core = new LoopCore({
    sendLlmRequest(b, sessionId, messages) {
      sent.push({ kind: 'request', b, sessionId, messages })
    },
    sendLlmCancel(b) {
      cancels.push(b)
    },
  })
  return { core, sent, cancels }
}

describe('LoopCore 状态机', () => {
  let ctx: ReturnType<typeof makeCore>

  beforeEach(() => {
    ctx = makeCore()
  })

  it('idle → start(running) → finish(idle)', () => {
    expect(ctx.core.currentState()).toBe('idle')
    expect(ctx.core.start('A1', 'B1', 's1', [{ role: 'user', content: 'hi' }])).toBe(true)
    expect(ctx.core.currentState()).toBe('running')
    ctx.core.finish('B1', 'stop')
    expect(ctx.core.currentState()).toBe('idle')
  })

  it('防重入：running 中重复 start → false', () => {
    expect(ctx.core.start('A1', 'B1', 's1', [])).toBe(true)
    expect(ctx.core.start('A2', 'B2', 's1', [])).toBe(false)
    expect(ctx.core.isBusy()).toBe(true)
  })

  it('A/B 不串号：token(B) → 返回 A；不同 B 的 token 互不干扰', () => {
    ctx.core.start('A1', 'B1', 's1', [])
    expect(ctx.core.onToken('B1', '你')).toBe('A1')
    // 未知 B → null（不串）
    expect(ctx.core.onToken('B_unknown', 'X')).toBeNull()
  })

  it('in-flight 累积：token 累积到 finish 的 content', () => {
    ctx.core.start('A1', 'B1', 's1', [])
    ctx.core.onToken('B1', '你')
    ctx.core.onToken('B1', '好')
    const done = ctx.core.finish('B1', 'stop', { promptTokens: 3, completionTokens: 2 })!
    expect(done.content).toBe('你好')
    expect(done.a).toBe('A1')
    expect(done.usage).toEqual({ promptTokens: 3, completionTokens: 2 })
  })

  it('finish：未知 B → null（已结束不重复处理）', () => {
    ctx.core.start('A1', 'B1', 's1', [])
    ctx.core.finish('B1', 'stop')
    expect(ctx.core.finish('B1', 'stop')).toBeNull()
  })

  it('cancel(A) → 发 llm.cancel(B)，未知 A 静默', () => {
    ctx.core.start('A1', 'B1', 's1', [])
    expect(ctx.core.cancel('A1')).toBe(true)
    expect(ctx.cancels).toEqual(['B1'])
    expect(ctx.core.cancel('A_unknown')).toBe(false)
  })

  it('cancelFinish(A)：不落半截 assistant，释放回 idle', () => {
    ctx.core.start('A1', 'B1', 's1', [])
    ctx.core.onToken('B1', '半截')
    const cancelled = ctx.core.cancelFinish('A1')!
    expect(cancelled.a).toBe('A1')
    expect(ctx.core.currentState()).toBe('idle')
  })

  it('fail(B)：释放回 idle（不落 assistant，由调用方发 loop.run.failed）', () => {
    ctx.core.start('A1', 'B1', 's1', [])
    const failed = ctx.core.fail('B1')!
    expect(failed.a).toBe('A1')
    expect(ctx.core.currentState()).toBe('idle')
  })

  it('崩溃 reset：in-flight 归零、state 回 idle（进程内态无回放）', () => {
    ctx.core.start('A1', 'B1', 's1', [])
    ctx.core.reset()
    expect(ctx.core.currentState()).toBe('idle')
    expect(ctx.core.onToken('B1', 'x')).toBeNull()
  })
})

describe('buildMessages 多轮组装', () => {
  it('system 置首 + 历史多轮顺序', () => {
    const messages = buildMessages(
      [
        { role: 'user', content: 'q1' },
        { role: 'assistant', content: 'a1' },
        { role: 'user', content: 'q2' },
      ],
      'SYS',
    )
    expect(messages).toEqual([
      { role: 'system', content: 'SYS' },
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'q2' },
    ])
  })

  it('超长截断：保留最近 N 条（system 始终置首）', () => {
    const history = Array.from({ length: 10 }, (_, i) => ({
      role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      content: `m${i}`,
    }))
    const messages = buildMessages(history, 'SYS', 3)
    expect(messages[0].content).toBe('SYS')
    expect(messages).toHaveLength(4) // system + 3 条最近
    expect(messages.map((m) => m.content)).toEqual(['SYS', 'm7', 'm8', 'm9'])
  })

  it('过滤脏数据：历史里 role 非法 / content 非字符串 → 丢弃', () => {
    const messages = buildMessages(
      [
        { role: 'user', content: 'ok' },
        { role: 'bogus' as never, content: 'x' },
        { role: 'assistant', content: 123 as never },
      ],
      'SYS',
    )
    expect(messages).toEqual([{ role: 'system', content: 'SYS' }, { role: 'user', content: 'ok' }])
  })

  it('历史里的 system 丢弃（system 统一由参数提供，避免重复注入）', () => {
    const messages = buildMessages([{ role: 'system', content: 'hist-sys' }], 'SYS')
    expect(messages).toEqual([{ role: 'system', content: 'SYS' }])
  })
})
