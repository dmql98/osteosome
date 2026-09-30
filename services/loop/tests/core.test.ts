/**
 * loop 状态机单测（两阶段 API）—— 纯逻辑直测 LoopCore（不依赖总线帧往返）。
 *
 * 覆盖：state 机 idle→awaiting→running→idle、防重入、A/B requestId 不串号、in-flight 累积、
 * cancel（在途/awaiting 两路径）、失败释放、崩溃 reset。
 *
 * 两阶段（P3 多轮接线）：accept(A) 占位 → 装配层拉 session.get → start(B, messages) 发 llm.request。
 */
import { describe, expect, it, beforeEach } from 'vitest'
import { LoopCore } from '../src/core'
import { buildMessages } from '../src/history'

function makeCore() {
  const sent: { b: string; sessionId: string; messages: unknown[] }[] = []
  const cancels: string[] = []
  const core = new LoopCore({
    sendLlmRequest(b, sessionId, messages) {
      sent.push({ b, sessionId, messages })
    },
    sendLlmCancel(b) {
      cancels.push(b)
    },
  })
  /** 便捷：accept + start 直达（等价装配层两阶段） */
  const runNow = (a: string, b: string, sessionId: string, messages: unknown[] = []): boolean => {
    if (!core.accept(a, sessionId, 'hi')) return false
    core.start(b, messages as never)
    return true
  }
  return { core, sent, cancels, runNow }
}

describe('LoopCore 状态机（两阶段）', () => {
  let ctx: ReturnType<typeof makeCore>

  beforeEach(() => {
    ctx = makeCore()
  })

  it('idle → accept(running/awaiting) → start(running) → finish(idle)', () => {
    expect(ctx.core.currentState()).toBe('idle')
    expect(ctx.core.accept('A1', 's1', 'hi')).toBe(true)
    // accept 后占位防重入，但尚未发 llm.request
    expect(ctx.core.currentState()).toBe('running')
    expect(ctx.sent).toHaveLength(0)
    expect(ctx.core.awaitingRun()).toMatchObject({ a: 'A1', sessionId: 's1' })

    ctx.core.start('B1', [{ role: 'user', content: 'hi' }] as never)
    expect(ctx.sent).toHaveLength(1) // start 才真正发 llm.request
    ctx.core.finish('B1', 'stop')
    expect(ctx.core.currentState()).toBe('idle')
  })

  it('防重入：accept 后（awaiting/running）重复 accept → false', () => {
    expect(ctx.core.accept('A1', 's1', 'hi')).toBe(true)
    expect(ctx.core.accept('A2', 's1', 'hi')).toBe(false)
    expect(ctx.core.isBusy()).toBe(true)
  })

  it('startNow（快路径，无 awaiting）直接发 llm.request', () => {
    expect(ctx.core.startNow('A1', 'B1', 's1', [])).toBe(true)
    expect(ctx.sent).toHaveLength(1)
    ctx.core.finish('B1', 'stop')
  })

  it('A/B 不串号：token(B) → 返回 A；不同 B 的 token 互不干扰', () => {
    ctx.runNow('A1', 'B1', 's1')
    expect(ctx.core.onToken('B1', '你')).toBe('A1')
    expect(ctx.core.onToken('B_unknown', 'X')).toBeNull()
  })

  it('in-flight 累积：token 累积到 finish 的 content', () => {
    ctx.runNow('A1', 'B1', 's1')
    ctx.core.onToken('B1', '你')
    ctx.core.onToken('B1', '好')
    const done = ctx.core.finish('B1', 'stop', { promptTokens: 3, completionTokens: 2 })!
    expect(done.content).toBe('你好')
    expect(done.a).toBe('A1')
    expect(done.usage).toEqual({ promptTokens: 3, completionTokens: 2 })
  })

  it('finish：未知 B → null（已结束不重复处理）', () => {
    ctx.runNow('A1', 'B1', 's1')
    ctx.core.finish('B1', 'stop')
    expect(ctx.core.finish('B1', 'stop')).toBeNull()
  })

  it('cancel(A) 在途 → 发 llm.cancel(B)，未知 A 静默', () => {
    ctx.runNow('A1', 'B1', 's1')
    expect(ctx.core.cancel('A1')).toBe(true)
    expect(ctx.cancels).toEqual(['B1'])
    expect(ctx.core.cancel('A_unknown')).toBe(false)
  })

  it('cancel(A) awaiting 阶段（未发 llm.request）→ 清占位回 idle，不发 llm.cancel', () => {
    ctx.core.accept('A1', 's1', 'hi')
    expect(ctx.core.cancel('A1')).toBe(false) // 未在途，不发 llm.cancel
    expect(ctx.cancels).toHaveLength(0)
    expect(ctx.core.currentState()).toBe('idle') // 占位已清
    expect(ctx.core.awaitingRun()).toBeNull()
  })

  it('cancelAwaiting(A)：清占位 + 返回 sessionId（装配层发 run.cancelled）', () => {
    ctx.core.accept('A1', 's1', 'hi')
    const done = ctx.core.cancelAwaiting('A1')!
    expect(done).toEqual({ a: 'A1', sessionId: 's1' })
    expect(ctx.core.currentState()).toBe('idle')
    // 重复取消 → null
    expect(ctx.core.cancelAwaiting('A1')).toBeNull()
  })

  it('cancelFinish(A)：不落半截 assistant，释放回 idle', () => {
    ctx.runNow('A1', 'B1', 's1')
    ctx.core.onToken('B1', '半截')
    const cancelled = ctx.core.cancelFinish('A1')!
    expect(cancelled.a).toBe('A1')
    expect(ctx.core.currentState()).toBe('idle')
  })

  it('fail(B)：释放回 idle（不落 assistant，由调用方发 loop.run.failed）', () => {
    ctx.runNow('A1', 'B1', 's1')
    const failed = ctx.core.fail('B1')!
    expect(failed.a).toBe('A1')
    expect(ctx.core.currentState()).toBe('idle')
  })

  it('崩溃 reset：in-flight / awaiting 归零、state 回 idle（进程内态无回放）', () => {
    ctx.core.accept('A1', 's1', 'hi')
    ctx.core.start('B1', [])
    ctx.core.reset()
    expect(ctx.core.currentState()).toBe('idle')
    expect(ctx.core.awaitingRun()).toBeNull()
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
