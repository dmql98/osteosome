import { describe, expect, it } from 'vitest'
import { join, resolve } from 'node:path'
import {
  assertPathSafe,
  isWildcardAll,
  normalizePathForPlatform,
  workspaceApprovalRoot,
} from '../src/tools/paths'
import {
  firstToken,
  globToRegExp,
  matchGlob,
  parseBytes,
  validateConstraints,
  type ConstraintField,
} from '../src/tools/constraints'

describe('tools/paths（路径守卫）', () => {
  const root = process.platform === 'win32' ? 'C:\\proj' : '/proj'
  const other = process.platform === 'win32' ? 'D:\\other' : '/other'

  it('相对路径按 roots[0] resolve，落在根内 → 通过', () => {
    const r = assertPathSafe('src/a.ts', [root])
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.absolute).toBe(resolve(root, 'src/a.ts'))
  })

  it('绝对路径在根外 → 拒绝；多根时命中任一即可', () => {
    const inside = join(root, 'x')
    expect(assertPathSafe(inside, [root]).ok).toBe(true)
    expect(assertPathSafe(inside, [other]).ok).toBe(false)
    expect(assertPathSafe(inside, [other, root]).ok).toBe(true)
  })

  it('空工作区 → 拒绝（任何路径都越界）', () => {
    const r = assertPathSafe('a', [])
    expect(r.ok).toBe(false)
  })

  it('空路径 / NUL 字节 → 拒绝', () => {
    expect(assertPathSafe('', [root]).ok).toBe(false)
    expect(assertPathSafe('a\u0000b', [root]).ok).toBe(false)
  })

  it('normalizePathForPlatform：反斜杠统一 + git-bash /c/ → C:', () => {
    expect(normalizePathForPlatform('a\\b\\c')).toBe('a/b/c')
    expect(normalizePathForPlatform('/c/Users/x')).toBe('C:/Users/x')
  })

  it('workspaceApprovalRoot = 请求路径的父目录', () => {
    expect(workspaceApprovalRoot(join(root, 'a', 'b.txt'))).toBe(resolve(root, 'a'))
  })

  it('isWildcardAll：* / ** 等视为全放行', () => {
    expect(isWildcardAll('*')).toBe(true)
    expect(isWildcardAll('**')).toBe(true)
    expect(isWildcardAll('src/*')).toBe(false)
  })
})

describe('tools/constraints（约束引擎，7 条规则）', () => {
  const f = (validateRule: ConstraintField['validateRule'], validateArg: string, key = 'k'): ConstraintField => ({
    key,
    type: 'string',
    validateArg,
    validateRule,
  })

  it('glob-allow：命中允许清单才通过；全放行声明 fail closed', () => {
    expect(validateConstraints([f('glob-allow', 'path')], { k: ['src/**'] }, { path: 'src/a/b.ts' })).toBeNull()
    expect(validateConstraints([f('glob-allow', 'path')], { k: ['src/**'] }, { path: 'other/a.ts' })).not.toBeNull()
    expect(validateConstraints([f('glob-allow', 'path')], { k: ['**'] }, { path: 'src/a.ts' })).toContain('全放行')
  })

  it('glob-deny：命中禁止模式 → 拒', () => {
    expect(validateConstraints([f('glob-deny', 'path')], { k: ['**/*.env'] }, { path: 'a/.env' })).not.toBeNull()
    expect(validateConstraints([f('glob-deny', 'path')], { k: ['**/*.env'] }, { path: 'a/b.txt' })).toBeNull()
  })

  it('bytes-max：解析 "1KB" 并按 UTF-8 计', () => {
    expect(parseBytes('1KB')).toBe(1024)
    expect(parseBytes('1.5MB')).toBe(1572864)
    expect(parseBytes('512')).toBe(512)
    expect(validateConstraints([f('bytes-max', 'content')], { k: '3' }, { content: 'aaa' })).toBeNull()
    expect(validateConstraints([f('bytes-max', 'content')], { k: '2' }, { content: 'aaa' })).not.toBeNull()
  })

  it('exact-allow：只看首 token；空清单 → 全禁', () => {
    expect(validateConstraints([f('exact-allow', 'command')], { k: ['npm', 'git'] }, { command: 'npm install x' })).toBeNull()
    expect(validateConstraints([f('exact-allow', 'command')], { k: ['npm'] }, { command: 'rm -rf /' })).not.toBeNull()
    expect(validateConstraints([f('exact-allow', 'command')], { k: [] }, { command: 'npm i' })).toContain('全禁')
    expect(firstToken('  git   status ')).toBe('git')
  })

  it('substring-deny：子串拒绝', () => {
    expect(validateConstraints([f('substring-deny', 'command')], { k: ['rm -rf', 'sudo'] }, { command: 'sudo x' })).not.toBeNull()
    expect(validateConstraints([f('substring-deny', 'command')], { k: ['rm -rf'] }, { command: 'echo hi' })).toBeNull()
  })

  it('max-number / readonly-query', () => {
    expect(validateConstraints([f('max-number', 'n')], { k: 5 }, { n: 6 })).not.toBeNull()
    expect(validateConstraints([f('max-number', 'n')], { k: 5 }, { n: 3 })).toBeNull()
    expect(validateConstraints([f('readonly-query', 'q')], { k: ['list', 'get'] }, { q: 'list' })).toBeNull()
    expect(validateConstraints([f('readonly-query', 'q')], { k: ['list'] }, { q: 'delete' })).not.toBeNull()
  })

  it('未设值的规则不生效（null = 通过）', () => {
    expect(validateConstraints([f('glob-allow', 'path')], {}, { path: 'anywhere' })).toBeNull()
    expect(validateConstraints([f('exact-allow', 'command')], { k: undefined }, { command: 'whatever' })).toBeNull()
  })

  it('globToRegExp：** 跨段、* 段内', () => {
    expect(matchGlob('src/**/*.ts', 'src/a/b/c.ts')).toBe(true)
    expect(matchGlob('src/*.ts', 'src/a/b.ts')).toBe(false)
    expect(globToRegExp('a/*.ts').test('a/b.ts')).toBe(true)
  })
})
