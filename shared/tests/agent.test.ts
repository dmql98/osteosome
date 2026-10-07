import { describe, expect, it } from 'vitest'
import {
  characterFragmentId,
  characterIdFromFragment,
  hasInjectablePrompt,
  mergeCharacterPatch,
  newCharacter,
  parseCharacters,
  sortCharacters,
  toRecipe,
} from '../src/agent'

describe('角色契约（shared/src/agent.ts）', () => {
  it('characterFragmentId / characterIdFromFragment 往返', () => {
    expect(characterFragmentId('reviewer')).toBe('role:reviewer')
    expect(characterIdFromFragment('role:reviewer')).toBe('reviewer')
    expect(characterIdFromFragment('other:reviewer')).toBeNull()
    expect(characterIdFromFragment('role:')).toBeNull()
  })

  it('parseCharacters 逐条报错、不整份拒', () => {
    const { characters, errors } = parseCharacters([
      { id: 'a', name: 'A', prompt: 'hi', skills: ['git-diff'], tools: ['read_file'] },
      { name: 'no id' },
      { id: 'b', prompt: 123, tools: 'bogus' },
      { id: 'a', name: 'dup' },
    ])
    expect(characters.map((c) => c.id)).toEqual(['a']) // 只有合法的那条
    expect(errors.length).toBeGreaterThanOrEqual(3) // no id / bad tools / dup
    expect(characters[0]).toMatchObject({ id: 'a', skills: ['git-diff'], tools: ['read_file'] })
  })

  it('parseCharacters：缺省 tools → "*"；缺省 name → id；空 prompt 合法', () => {
    const { characters } = parseCharacters([{ id: 'bare', prompt: '' }])
    expect(characters[0]).toMatchObject({ id: 'bare', name: 'bare', prompt: '', tools: '*' })
  })

  it('mergeCharacterPatch：合并式，没给的键不变；upsert 不存在的角色', () => {
    const base = { ...newCharacter('a', 'A'), prompt: 'p', skills: ['s1'], provider: 'deepseek' }
    const merged = mergeCharacterPatch(base, { id: 'a', name: 'A2' })
    expect(merged).toMatchObject({ id: 'a', name: 'A2', prompt: 'p', skills: ['s1'], provider: 'deepseek' })
    // skills 整体替换
    expect(mergeCharacterPatch(base, { id: 'a', skills: ['s2'] }).skills).toEqual(['s2'])
    // 空串清除可选项
    expect(mergeCharacterPatch(base, { id: 'a', provider: '' }).provider).toBeUndefined()
    // 不存在 → 新建
    expect(mergeCharacterPatch(undefined, { id: 'z', prompt: 'x' })).toMatchObject({ id: 'z', prompt: 'x', tools: '*' })
  })

  it('toRecipe：纯数据配方，可缺省模型偏好', () => {
    const recipe = toRecipe({ ...newCharacter('a', 'A'), prompt: '人格', skills: ['s'], tools: ['t'], model: 'm' })
    expect(recipe).toMatchObject({ characterId: 'a', prompt: '人格', skills: ['s'], tools: ['t'], model: 'm' })
    expect(recipe.provider).toBeUndefined()
  })

  it('sortCharacters：按 name 码位确定排序', () => {
    const list = [newCharacter('b', '乙'), newCharacter('a', '甲'), newCharacter('c', '甲')]
    const sorted = sortCharacters(list)
    // 码位：乙 U+4E59 < 甲 U+7532；同名按 id
    expect(sorted.map((c) => c.id)).toEqual(['b', 'a', 'c'])
  })

  it('hasInjectablePrompt：空白 prompt 不注入（e4 裸会话）', () => {
    expect(hasInjectablePrompt({ ...newCharacter('a'), prompt: '' })).toBe(false)
    expect(hasInjectablePrompt({ ...newCharacter('a'), prompt: '   ' })).toBe(false)
    expect(hasInjectablePrompt({ ...newCharacter('a'), prompt: 'hi' })).toBe(true)
  })
})
