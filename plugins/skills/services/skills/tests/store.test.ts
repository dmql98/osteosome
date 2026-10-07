/**
 * skills 服务的存储单测（P6 WS-1）—— 自建 SKILL.md 读写 / 机器级开关 / 容错。
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readdirSync, mkdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SkillStore } from '../src/store'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ost-skills-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const customFile = (name: string) => join(dir, 'custom', name, 'SKILL.md')

describe('SkillStore', () => {
  it('扫 custom/ 解析 SKILL.md（frontmatter name/description + 目录名兜底）', () => {
    const store = new SkillStore(dir)
    store.writeCustom('git-diff', '---\nname: git-diff\ndescription: 看 git 差异\n---\n\n正文…')
    const skills = store.customSkills()
    expect(skills).toEqual([
      { ownerPluginId: 'user', name: 'git-diff', description: '看 git 差异', source: 'custom', enabled: true },
    ])
  })

  it('无 frontmatter → name 用目录名、description 空', () => {
    const store = new SkillStore(dir)
    store.writeCustom('plain', '就是一段正文')
    const [s] = store.customSkills()
    expect(s).toMatchObject({ name: 'plain', description: '' })
  })

  it('机器级开关：缺省 true；setEnabled 后持久化，重读仍在', () => {
    const store = new SkillStore(dir)
    expect(store.isEnabled('user', 'x')).toBe(true)
    store.setEnabled('user', 'x', false)
    expect(store.isEnabled('user', 'x')).toBe(false)
    const store2 = new SkillStore(dir)
    expect(store2.isEnabled('user', 'x')).toBe(false)
    // 缺省仍 true
    expect(store2.isEnabled('user', 'y')).toBe(true)
  })

  it('readCustom / removeCustom；坏档跳过不崩', () => {
    const store = new SkillStore(dir)
    store.writeCustom('a', '---\ndescription: A\n---\nbody-a')
    expect(store.readCustom('a')).toContain('body-a')
    // 手工塞一个没有 SKILL.md 的目录 → 不进索引
    mkdirSync(join(dir, 'custom', 'empty'), { recursive: true })
    expect(store.customSkills().map((s) => s.name)).toEqual(['a'])
    expect(store.removeCustom('a')).toBe(true)
    expect(existsSync(customFile('a'))).toBe(false)
    expect(store.removeCustom('nope')).toBe(false)
  })

  it('非法 name（路径分隔符）被拒', () => {
    const store = new SkillStore(dir)
    expect(() => store.writeCustom('../evil', 'x')).toThrow()
    expect(store.readCustom('a/b')).toBeNull()
  })

  it('原子写：不留 .tmp', () => {
    const store = new SkillStore(dir)
    store.setEnabled('user', 'a', false)
    expect(existsSync(join(dir, 'skills.json'))).toBe(true)
    expect(readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([])
  })
})
