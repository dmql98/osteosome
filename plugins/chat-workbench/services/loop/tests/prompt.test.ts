import { describe, expect, it } from 'vitest'
import { assembleSystemPrompt, DEFAULT_SYSTEM_PROMPT, type PromptFragment } from '../src/prompt'

const frag = (pluginId: string, id: string, priority: number, text: string): PromptFragment => ({ pluginId, id, priority, text })

describe('assembleSystemPrompt（P5 片段装配）', () => {
  it('基础提示词恒在最前；片段按 (priority, id) 确定排序', () => {
    const out = assembleSystemPrompt(DEFAULT_SYSTEM_PROMPT, [
      frag('reliability', 'retry-note', 10, '重试说明'),
      frag('other', 'a-note', 10, 'A 片段'),
      frag('third', 'z-note', 1, 'Z 先'),
    ])
    const idx = (s: string) => out.indexOf(s)
    expect(out.startsWith(DEFAULT_SYSTEM_PROMPT)).toBe(true)
    expect(idx('Z 先')).toBeLessThan(idx('A 片段')) // priority 1 先于 10
    expect(idx('A 片段')).toBeLessThan(idx('重试说明')) // 同优先级按 id 码位 a < r
  })

  it('未选角色时**不**纳入任何 role:* 片段（裸会话）', () => {
    const out = assembleSystemPrompt(DEFAULT_SYSTEM_PROMPT, [
      frag('agents', 'role:alice', 5, '你是爱丽丝'),
      frag('agents', 'role:bob', 5, '你是鲍勃'),
    ])
    expect(out).not.toContain('爱丽丝')
    expect(out).not.toContain('鲍勃')
  })

  it('选了角色 → 只纳入那一条 role: 片段（其余角色的不串）', () => {
    const frags = [frag('agents', 'role:alice', 5, '你是爱丽丝'), frag('agents', 'role:bob', 5, '你是鲍勃')]
    const out = assembleSystemPrompt(DEFAULT_SYSTEM_PROMPT, frags, 'bob')
    expect(out).toContain('你是鲍勃')
    expect(out).not.toContain('爱丽丝')
  })

  it('空白片段文本被丢弃（不产生空行）', () => {
    const out = assembleSystemPrompt('base', [frag('x', 'empty', 1, '   '), frag('x', 'ok', 2, '真片段')])
    expect(out).toBe('base\n\n真片段')
  })

  it('无片段 → 只有基础提示词', () => {
    expect(assembleSystemPrompt('base', [])).toBe('base')
  })
})
