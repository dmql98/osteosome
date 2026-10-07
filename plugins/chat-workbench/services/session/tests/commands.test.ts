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

  it('session.pin → result 带 pinned；缺 pinned / 不存在 → error', () => {
    const { sessionId } = dispatch(store, 'session.create', { requestId: 'r1' })
    const pinned = dispatch(store, 'session.pin', { requestId: 'r2', sessionId, pinned: true })
    expect(pinned).toMatchObject({ sessionId, pinned: true })
    // 置顶不改 updatedAt
    const meta = store.list().find((m) => m.id === sessionId)!
    expect(meta.pinned).toBe(true)
    expect(dispatch(store, 'session.pin', { requestId: 'r3', sessionId }).error).toMatchObject({ code: 'invalid_request' })
    expect(dispatch(store, 'session.pin', { requestId: 'r4', sessionId: 'nope', pinned: true }).error).toMatchObject({
      code: 'not_found',
    })
  })

  it('session.archive → result 带 archived；缺 archived / 不存在 → error', () => {
    const { sessionId } = dispatch(store, 'session.create', { requestId: 'r1' })
    expect(dispatch(store, 'session.archive', { requestId: 'r2', sessionId, archived: true })).toMatchObject({
      sessionId,
      archived: true,
    })
    expect(dispatch(store, 'session.archive', { requestId: 'r3', sessionId }).error).toMatchObject({
      code: 'invalid_request',
    })
    expect(
      dispatch(store, 'session.archive', { requestId: 'r4', sessionId: 'nope', archived: true }).error,
    ).toMatchObject({ code: 'not_found' })
  })

  it('message.append → lastMessage 预览进入索引（P2-4 / P0-0 的数据源）', () => {
    const { sessionId } = dispatch(store, 'session.create', { requestId: 'r1' })
    dispatch(store, 'message.append', {
      requestId: 'r2',
      sessionId,
      message: { role: 'user', content: '帮我看看这段代码' },
    })
    expect(store.list().find((m) => m.id === sessionId)!.lastMessage).toBe('帮我看看这段代码')
  })

  it('session.create 带 parentId → 子会话挂到父下（P2-3）', () => {
    const parent = dispatch(store, 'session.create', { requestId: 'r1', title: '父' })
    const child = dispatch(store, 'session.create', { requestId: 'r2', title: '子', parentId: parent.sessionId })
    expect(store.list().find((m) => m.id === child.sessionId)!.parentId).toBe(parent.sessionId)
  })

  it('session.set.workspace（P7 M0）：合并式写 workspace + addRoot/removeRoot，不改 updatedAt', () => {
    const { sessionId } = dispatch(store, 'session.create', { requestId: 'r1' })
    const before = store.list().find((m) => m.id === sessionId)!.updatedAt
    const set = dispatch(store, 'session.set.workspace', { requestId: 'r2', sessionId, workspace: 'C:\\proj' })
    expect(set).toMatchObject({ sessionId, workspace: 'C:\\proj', workspaces: [] })
    dispatch(store, 'session.set.workspace', { requestId: 'r3', sessionId, addRoot: 'D:\\data' })
    let meta = store.list().find((m) => m.id === sessionId)!
    expect(meta.workspace).toBe('C:\\proj')
    expect(meta.workspaces).toEqual(['D:\\data'])
    dispatch(store, 'session.set.workspace', { requestId: 'r4', sessionId, removeRoot: 'D:\\data' })
    meta = store.list().find((m) => m.id === sessionId)!
    expect(meta.workspaces).toBeUndefined()
    expect(meta.updatedAt).toBe(before)
    expect(dispatch(store, 'session.set.workspace', { requestId: 'r5', sessionId: 'nope' }).error).toMatchObject({
      code: 'not_found',
    })
    expect(dispatch(store, 'session.set.workspace', { requestId: 'r6' }).error).toMatchObject({ code: 'invalid_request' })
  })

  it('session.export → 返回 Markdown 文本与文件名（P2-5）', () => {
    const { sessionId } = dispatch(store, 'session.create', { requestId: 'r1', title: '导出我' })
    dispatch(store, 'message.append', { requestId: 'r2', sessionId, message: { role: 'user', content: '你好' } })
    dispatch(store, 'message.append', {
      requestId: 'r3',
      sessionId,
      message: { role: 'assistant', content: '回答', reasoning: '想一下' },
    })
    const res = dispatch(store, 'session.export', { requestId: 'r4', sessionId })
    expect(res.filename).toBe(`${sessionId}.md`)
    const content = res.content as string
    expect(content).toContain('# 导出我')
    expect(content).toContain('## 用户')
    expect(content).toContain('你好')
    expect(content).toContain('## 助手')
    expect(content).toContain('> 思考过程：')
    // 不存在的会话 → not_found
    expect(dispatch(store, 'session.export', { requestId: 'r5', sessionId: 'nope' }).error).toMatchObject({
      code: 'not_found',
    })
    expect(dispatch(store, 'session.export', { requestId: 'r6' }).error).toMatchObject({ code: 'invalid_request' })
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