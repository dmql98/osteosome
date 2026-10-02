/**
 * session 命令全链单测（P3 WS-2）—— 七命令 + requestId 关联 + 错误码化。
 * 纯逻辑走 dispatch()（与 index.ts 装配同一入口），不依赖总线帧往返。
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionStore } from '../src/store'
import { dispatch } from '../src/session'

let dir: string
let store: SessionStore

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ost-session-cmd-'))
  store = new SessionStore(dir)
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('session 七命令（IPC 全链）', () => {
  it('session.create → result 带 sessionId/title + list 可见', () => {
    const created = dispatch(store, 'session.create', { requestId: 'r1', title: '会话 A' })
    expect(created.requestId).toBe('r1')
    expect(created.sessionId).toBeTruthy()
    expect(created.title).toBe('会话 A')
    const list = dispatch(store, 'session.list', { requestId: 'r2' })
    expect((list.sessions as unknown[]).length).toBe(1)
  })

  it('session.get → 返回全文；不存在 → null（调用方回退最近会话）', () => {
    const { sessionId } = dispatch(store, 'session.create', { requestId: 'r1' })
    dispatch(store, 'message.append', { requestId: 'r2', sessionId, message: { role: 'user', content: 'hi' } })
    const got = dispatch(store, 'session.get', { requestId: 'r3', sessionId })
    expect((got.session as { messages: unknown[] }).messages).toHaveLength(1)
    // 不存在 → null（不 error，调用方回退）
    const missing = dispatch(store, 'session.get', { requestId: 'r4', sessionId: 'nope' })
    expect(missing.session).toBeNull()
    expect(missing.error).toBeUndefined()
  })

  it('session.rename → result 带新标题；不存在 → error{not_found}', () => {
    const { sessionId } = dispatch(store, 'session.create', { requestId: 'r1', title: 'A' })
    const renamed = dispatch(store, 'session.rename', { requestId: 'r2', sessionId, title: 'B' })
    expect(renamed.title).toBe('B')
    const missing = dispatch(store, 'session.rename', { requestId: 'r3', sessionId: 'nope', title: 'x' })
    expect(missing.error).toMatchObject({ code: 'not_found' })
  })

  it('session.delete → result 带 sessionId；不存在 → error{not_found}', () => {
    const { sessionId } = dispatch(store, 'session.create', { requestId: 'r1' })
    const del = dispatch(store, 'session.delete', { requestId: 'r2', sessionId })
    expect(del.sessionId).toBe(sessionId)
    const missing = dispatch(store, 'session.delete', { requestId: 'r3', sessionId: 'nope' })
    expect(missing.error).toMatchObject({ code: 'not_found' })
  })

  it('session.clear → deletedCount 正确', () => {
    dispatch(store, 'session.create', { requestId: 'r1', title: 'a' })
    dispatch(store, 'session.create', { requestId: 'r2', title: 'b' })
    const cleared = dispatch(store, 'session.clear', { requestId: 'r3' })
    expect(cleared.deletedCount).toBe(2)
    expect(dispatch(store, 'session.list', { requestId: 'r4' }).sessions).toEqual([])
  })

  it('message.append → result 带完整 message；不存在会话 → error{not_found}', () => {
    const { sessionId } = dispatch(store, 'session.create', { requestId: 'r1' })
    const appended = dispatch(store, 'message.append', {
      requestId: 'r2',
      sessionId,
      message: { role: 'assistant', content: '答案' },
    })
    expect((appended.message as { role: string }).role).toBe('assistant')
    const missing = dispatch(store, 'message.append', { requestId: 'r3', sessionId: 'nope', message: { role: 'user', content: 'x' } })
    expect(missing.error).toMatchObject({ code: 'not_found' })
  })

  it('缺必填字段 → error{invalid_request}（不静默）', () => {
    expect(dispatch(store, 'session.get', { requestId: 'r' }).error).toMatchObject({ code: 'invalid_request' })
    expect(dispatch(store, 'session.rename', { requestId: 'r', sessionId: 'x' }).error).toMatchObject({ code: 'invalid_request' })
    expect(dispatch(store, 'message.append', { requestId: 'r', sessionId: 'x' }).error).toMatchObject({ code: 'invalid_request' })
  })

  it('message.append 非法 role → 默认 user', () => {
    const { sessionId } = dispatch(store, 'session.create', { requestId: 'r1' })
    const appended = dispatch(store, 'message.append', {
      requestId: 'r2',
      sessionId,
      message: { role: 'bogus', content: 'x' },
    })
    expect((appended.message as { role: string }).role).toBe('user')
  })

  it('未知命令 → error{invalid_request}', () => {
    expect(dispatch(store, 'session.bogus', { requestId: 'r' }).error).toMatchObject({ code: 'invalid_request' })
  })

  it('requestId 贯穿每条 result（不串号）', () => {
    const a = dispatch(store, 'session.list', { requestId: 'rid-A' })
    const b = dispatch(store, 'session.create', { requestId: 'rid-B' })
    expect(a.requestId).toBe('rid-A')
    expect(b.requestId).toBe('rid-B')
  })
})

describe('message.append 透传（S4 修的静默丢字段）', () => {
  /** 落库后重读，确认字段真的在磁盘上而不只是 result 里 */
  function appendAndRead(message: Record<string, unknown>): Record<string, unknown> {
    const { sessionId } = dispatch(store, 'session.create', { requestId: 'c0', title: 'T' })
    dispatch(store, 'message.append', { requestId: 'c1', sessionId, message })
    const got = dispatch(store, 'session.get', { requestId: 'c2', sessionId })
    const messages = (got.session as { messages: Record<string, unknown>[] }).messages
    return messages[messages.length - 1]!
  }

  it('finishReason / usage 原样落库并在重读后仍在', () => {
    const msg = appendAndRead({
      role: 'assistant',
      content: '答',
      finishReason: 'length',
      usage: { promptTokens: 11, completionTokens: 5 },
    })
    expect(msg.finishReason).toBe('length')
    expect(msg.usage).toEqual({ promptTokens: 11, completionTokens: 5 })
  })

  it('reasoning 单独落库，且 content 里没有思维链', () => {
    const msg = appendAndRead({ role: 'assistant', content: '答', reasoning: '先想…', finishReason: 'stop' })
    expect(msg.reasoning).toBe('先想…')
    expect(msg.content).toBe('答')
  })

  it('非法 finishReason 被丢弃而不是原样存进去', () => {
    const msg = appendAndRead({ role: 'assistant', content: 'x', finishReason: 'whatever' })
    expect(msg.finishReason).toBeUndefined()
  })

  it('半截 usage（缺一个字段 / 非数字）视为没有，不存半截', () => {
    expect(appendAndRead({ role: 'assistant', content: 'x', usage: { promptTokens: 3 } }).usage).toBeUndefined()
    expect(
      appendAndRead({ role: 'assistant', content: 'x', usage: { promptTokens: '3', completionTokens: 2 } }).usage,
    ).toBeUndefined()
  })

  it('空 reasoning 不落字段（不产生空串噪音）', () => {
    expect(appendAndRead({ role: 'assistant', content: 'x', reasoning: '' }).reasoning).toBeUndefined()
  })
})