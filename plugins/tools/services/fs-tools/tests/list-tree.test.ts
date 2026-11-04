/**
 * `ls` 的目录树渲染。
 *
 * 守的是四件在真实对话里会咬人的事：
 * 1. **目录在前、同类按名排序** —— 顺序不稳定，模型每次看到的就不一样，diff 无从谈起；
 * 2. **默认不列隐藏项** —— `.git` / `.env` 列出来只是噪音，真要看得显式 `all`；
 * 3. **深度有界** —— `ls . depth:3` 不该变成全库扫描；
 * 4. **截断要说出来** —— 静默截断会被模型当成「目录就这些」，然后编造文件名。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { listTree, MAX_ENTRIES } from '../src/list-tree'

let dir = ''

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ost-ls-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function touch(path: string): void {
  writeFileSync(join(dir, path), 'x', 'utf8')
}

describe('listTree', () => {
  it('目录在前、同类按字典序，目录名带尾斜杠', () => {
    mkdirSync(join(dir, 'zeta'))
    mkdirSync(join(dir, 'alpha'))
    touch('b.txt')
    touch('a.txt')

    const out = listTree(dir)
    expect(out.text.split('\n')).toEqual(['alpha/', 'zeta/', 'a.txt', 'b.txt'])
    expect(out.entries).toBe(4)
    expect(out.truncated).toBe(false)
  })

  it('默认不列隐藏项；all 才列', () => {
    mkdirSync(join(dir, '.git'))
    touch('.env')
    touch('index.ts')

    expect(listTree(dir).text.split('\n')).toEqual(['index.ts'])
    expect(listTree(dir, { all: true }).text.split('\n')).toEqual(['.git/', '.env', 'index.ts'])
  })

  it('depth 控制下钻层数（1 = 只看这一层）', () => {
    mkdirSync(join(dir, 'src', 'ui'), { recursive: true })
    touch('src/app.ts')
    touch('src/ui/main.ts')

    expect(listTree(dir).text.split('\n')).toEqual(['src/'])
    // 目录在前（ui 是目录、app.ts 是文件），且子项紧跟在自己的父目录后面（深度优先）
    expect(listTree(dir, { depth: 2 }).text.split('\n')).toEqual(['src/', '  ui/', '  app.ts'])
    expect(listTree(dir, { depth: 9 }).text.split('\n')).toEqual([
      'src/',
      '  ui/',
      '    main.ts',
      '  app.ts',
    ])
  })

  it('超过条目上限 → 截断并明说（不让模型以为目录就这些）', () => {
    const total = MAX_ENTRIES + 5
    for (let i = 0; i < total; i += 1) touch(`f${String(i).padStart(4, '0')}.txt`)

    const out = listTree(dir)
    expect(out.entries).toBe(MAX_ENTRIES)
    expect(out.truncated).toBe(true)
    expect(out.text.endsWith(`…（已截断，只列前 ${MAX_ENTRIES} 项）`)).toBe(true)
  })

  it('空目录给空文本（调用方负责说「空的」）', () => {
    const out = listTree(dir)
    expect(out.text).toBe('')
    expect(out.entries).toBe(0)
  })
})
