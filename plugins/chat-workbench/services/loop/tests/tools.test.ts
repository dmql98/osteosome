/**
 * P7 工具轮单测 —— 两块纯逻辑（不依赖总线/服务进程）：
 *
 * 1. `LoopCore.nextRound`：工具轮换 B 续跑、buffer 清零、state 保持 running；
 * 2. `tools.ts`：内置工具执行 + **路径守卫**（越界/绝对路径/不存在/非文件）。
 */
import { describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LoopCore, type ChatTurn } from '../src/core'
import { executeTool, resolveInside, toolSpecs } from '../src/tools'

function makeCore() {
  const sent: { b: string; messages: ChatTurn[] }[] = []
  const cancels: string[] = []
  const core = new LoopCore({
    sendLlmRequest(b, _sessionId, messages) {
      sent.push({ b, messages })
    },
    sendLlmCancel(b) {
      cancels.push(b)
    },
  })
  return { core, sent, cancels }
}

describe('LoopCore.nextRound（工具轮续跑）', () => {
  it('换新 B 续跑：旧 B 映射移除、buffer 清零、state 仍 running', () => {
    const { core, sent } = makeCore()
    core.accept('A1', 's1', '读文件')
    core.start('B1', [{ role: 'user', content: '读文件' }])
    core.onToken('B1', '我看')
    expect(core.currentState()).toBe('running')

    const out = core.nextRound('B1', 'B2', [{ role: 'system', content: 'SYS' }])
    expect(out).toEqual({ a: 'A1', sessionId: 's1', content: '我看', reasoning: '' })
    // 新 B 已发出，旧 B 不再有效
    expect(sent.map((s) => s.b)).toEqual(['B1', 'B2'])
    expect(core.peekContent('B1')).toBe('')
    expect(core.currentA('B2')).toBe('A1')
    expect(core.currentA('B1')).toBeNull()
    // 关键：工具轮中间**不能**回到 idle（否则前端会误判本轮结束）
    expect(core.currentState()).toBe('running')
  })

  it('下一轮 token 累积到新 B；finish 新 B 正常收尾并落全文', () => {
    const { core } = makeCore()
    core.accept('A1', 's1', '读文件')
    core.start('B1', [{ role: 'user', content: '读文件' }])
    core.nextRound('B1', 'B2', [])
    expect(core.onToken('B2', '文件里有')).toBe('A1')
    expect(core.peekContent('B2')).toBe('文件里有')
    const done = core.finish('B2', 'stop')
    expect(done).toMatchObject({ a: 'A1', content: '文件里有' })
    expect(core.currentState()).toBe('idle')
  })

  it('取消：nextRound 后的 B 才是取消目标（旧 B 已失效）', () => {
    const { core, cancels } = makeCore()
    core.accept('A1', 's1', 'x')
    core.start('B1', [])
    core.nextRound('B1', 'B2', [])
    core.cancel('A1')
    expect(cancels).toEqual(['B2'])
  })

  it('未知旧 B → nextRound 返回 null（迟到事件不重发）', () => {
    const { core, sent } = makeCore()
    core.accept('A1', 's1', 'x')
    core.start('B1', [])
    expect(core.nextRound('B-unknown', 'B2', [])).toBeNull()
    expect(sent.map((s) => s.b)).toEqual(['B1'])
  })
})

describe('tools（内置只读工具）', () => {
  /** 临时目录 + **等待** fn 结束再清理（async fn 必须 await，否则目录先被删掉） */
  async function withRoot(fn: (root: string) => Promise<void>): Promise<void> {
    const root = mkdtempSync(join(tmpdir(), 'ost-loop-tools-'))
    try {
      await fn(root)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }

  it('toolSpecs 声明 read_file / list_dir 且带 JSON Schema', () => {
    const specs = toolSpecs('/tmp')
    expect(specs.map((s) => s.name)).toEqual(['read_file', 'list_dir'])
    for (const spec of specs) {
      expect(spec.description.length).toBeGreaterThan(0)
      expect(spec.parameters).toMatchObject({ type: 'object' })
    }
  })

  it('read_file 读到内容；list_dir 列出条目', async () => {
    await withRoot(async (root) => {
      writeFileSync(join(root, 'a.txt'), 'hello')
      mkdirSync(join(root, 'sub'))
      const read = await executeTool(root, 'read_file', { path: 'a.txt' })
      expect(read).toMatchObject({ ok: true, content: 'hello' })
      const list = await executeTool(root, 'list_dir', { path: '' })
      expect(list.ok).toBe(true)
      expect(list.content).toContain('a.txt')
      expect(list.content).toContain('sub/')
    })
  })

  it('路径守卫：绝对路径与 .. 越界一律拒绝', () => {
    expect(resolveInside('/root', 'a/b.txt')).toBeTruthy()
    expect(resolveInside('/root', '../secret')).toBeNull()
    expect(resolveInside('/root', 'a/../../secret')).toBeNull()
    expect(resolveInside('/root', '/etc/passwd')).toBeNull()
    expect(resolveInside('/root', '')).toBeNull()
  })

  it('越界路径 → 工具返回错误文本（ok=false），不抛异常', async () => {
    await withRoot(async (root) => {
      const out = await executeTool(root, 'read_file', { path: '../outside.txt' })
      expect(out.ok).toBe(false)
      expect(out.content).toContain('路径非法')
    })
  })

  it('未知工具 / 参数畸形 → 失败结果而不是抛错（让模型能自我纠正）', async () => {
    await withRoot(async (root) => {
      const unknown = await executeTool(root, 'no_such_tool', {})
      expect(unknown.ok).toBe(false)
      expect(unknown.content).toContain('未知工具')
      const missing = await executeTool(root, 'read_file', {})
      expect(missing.ok).toBe(false)
    })
  })

  it('目录当文件读 / 文件当目录列 → 明确报错', async () => {
    await withRoot(async (root) => {
      mkdirSync(join(root, 'dir'))
      writeFileSync(join(root, 'file.txt'), 'x')
      expect((await executeTool(root, 'read_file', { path: 'dir' })).content).toContain('不是文件')
      expect((await executeTool(root, 'list_dir', { path: 'file.txt' })).content).toContain('不是目录')
    })
  })
})
describe('LoopCore · 正文与思维链分流（S4）', () => {
  it('reasoning token 不进正文 buffer', () => {
    const { core } = makeCore()
    core.accept('A1', 's1', '想一下')
    core.start('B1', [{ role: 'user', content: '想一下' }])
    core.onToken('B1', '先想', 'reasoning')
    core.onToken('B1', '答案', 'text')
    const done = core.finish('B1', 'stop')
    // 关键：正文里不能出现思维链
    expect(done?.content).toBe('答案')
    expect(done?.reasoning).toBe('先想')
  })

  it('缺省 blockType 按 text 处理（老版本节点不发这个字段，不能丢正文）', () => {
    const { core } = makeCore()
    core.accept('A1', 's1', 'hi')
    core.start('B1', [{ role: 'user', content: 'hi' }])
    core.onToken('B1', 'a')
    core.onToken('B1', 'b')
    const done = core.finish('B1', 'stop')
    expect(done?.content).toBe('ab')
    expect(done?.reasoning).toBe('')
  })

  it('peek 同时给出正文与思维链；未知 B 返回空而非崩', () => {
    const { core } = makeCore()
    core.accept('A1', 's1', 'hi')
    core.start('B1', [{ role: 'user', content: 'hi' }])
    core.onToken('B1', '思', 'reasoning')
    core.onToken('B1', '答', 'text')
    expect(core.peek('B1')).toEqual({ content: '答', reasoning: '思' })
    expect(core.peek('nope')).toEqual({ content: '', reasoning: '' })
  })

  it('工具轮换轮时思维链跟随本轮一起交出并清零', () => {
    const { core } = makeCore()
    core.accept('A1', 's1', '读文件')
    core.start('B1', [{ role: 'user', content: '读文件' }])
    core.onToken('B1', '思1', 'reasoning')
    core.onToken('B1', '正文1', 'text')
    const out = core.nextRound('B1', 'B2', [{ role: 'system', content: 'S' }])
    expect(out).toMatchObject({ content: '正文1', reasoning: '思1' })
    // 新一轮从零累积，不带上一轮的思维链
    expect(core.peek('B2')).toEqual({ content: '', reasoning: '' })
  })

  it('finish 带出 finishReason 与 usage（S4 顺带修的落库字段）', () => {
    const { core } = makeCore()
    core.accept('A1', 's1', 'hi')
    core.start('B1', [{ role: 'user', content: 'hi' }])
    core.onToken('B1', 'ok', 'text')
    const done = core.finish('B1', 'length', { promptTokens: 3, completionTokens: 7 })
    expect(done).toMatchObject({
      content: 'ok',
      reasoning: '',
      finishReason: 'length',
      usage: { promptTokens: 3, completionTokens: 7 },
    })
  })
})