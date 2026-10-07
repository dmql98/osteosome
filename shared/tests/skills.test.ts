import { describe, expect, it } from 'vitest'
import {
  assertSafeSkillName,
  danglingBoundSkills,
  intersectRoleSkills,
  parseSkillMd,
  skillIndexTotalBytes,
  skillsIndexText,
  sortSkillIndex,
  utf8Bytes,
  type SkillIndexEntry,
} from '../src/skills'

const entry = (owner: string, name: string, description = '', enabled = true): SkillIndexEntry => ({
  ownerPluginId: owner,
  name,
  description,
  source: owner === 'user' ? 'custom' : 'plugin',
  enabled,
})

describe('技能契约（shared/src/skills.ts）', () => {
  it('parseSkillMd：frontmatter name/description + 正文', () => {
    const pkg = parseSkillMd('---\nname: git-diff\ndescription: 看差异\n---\n\n正文行1\n正文行2', 'fallback')
    expect(pkg).toEqual({ name: 'git-diff', description: '看差异', body: '正文行1\n正文行2' })
  })

  it('parseSkillMd：无 frontmatter → 目录名兜底、description 空', () => {
    expect(parseSkillMd('就是正文', 'dir-name')).toEqual({ name: 'dir-name', description: '', body: '就是正文' })
  })

  it('assertSafeSkillName：拒路径分隔符 / . / ..', () => {
    expect(assertSafeSkillName('git-diff')).toBe(true)
    expect(assertSafeSkillName('a/b')).toBe(false)
    expect(assertSafeSkillName('..')).toBe(false)
    expect(assertSafeSkillName('')).toBe(false)
  })

  it('sortSkillIndex：ownerPluginId → name 确定排序', () => {
    const list = [entry('user', 'b'), entry('models', 'a'), entry('user', 'a'), entry('chat-workbench', 'z')]
    expect(sortSkillIndex(list).map((e) => `${e.ownerPluginId}:${e.name}`)).toEqual([
      'chat-workbench:z',
      'models:a',
      'user:a',
      'user:b',
    ])
  })

  it('intersectRoleSkills：本机可用 ∩ 角色绑定（AND）', () => {
    const available = [entry('user', 'a'), entry('user', 'b'), entry('user', 'c')]
    expect(intersectRoleSkills(available, ['a', 'c', 'missing']).map((e) => e.name)).toEqual(['a', 'c'])
    expect(intersectRoleSkills(available, [])).toEqual([])
  })

  it('skillsIndexText：只收 enabled，按确定顺序，只放 name+description', () => {
    const text = skillsIndexText([entry('user', 'b', 'B 描述'), entry('user', 'a', 'A 描述'), entry('user', 'off', 'x', false)])
    expect(text).toBe('- a: A 描述\n- b: B 描述')
    expect(skillsIndexText([])).toBe('')
  })

  it('danglingBoundSkills：绑了但本机没有的（去重排序）', () => {
    const available = [entry('user', 'a')]
    expect(danglingBoundSkills(['a', 'x', 'x', 'b'], available)).toEqual(['b', 'x'])
  })

  it('skillIndexTotalBytes / utf8Bytes：按 UTF-8 计', () => {
    expect(utf8Bytes('a')).toBe(1)
    expect(utf8Bytes('中')).toBe(3)
    expect(skillIndexTotalBytes([entry('user', 'a', '中')])).toBe(1 + 3)
  })
})
