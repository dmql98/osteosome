import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import * as path from 'node:path'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * 设计令牌只有一份，宿主与所有插件 UI 都从它引（P6 起）。
 *
 * ## 这条测试守的是「不会又变回两份」
 *
 * P5 时令牌有两份复制（client 与 plugins/models/ui），靠本文件逐字对账。
 * 那时它是有用的 —— 复制一旦漂移，症状是「模型设置页的按钮和设置页颜色对不上」，
 * 而排查时人人都会去看组件，没人想到是令牌文件。
 *
 * P6 搬完 workbench 再搬完 chat-workbench 有了**四个**消费者（宿主 + 三个插件 UI）：
 * 每次调色要改四处、构建四个包，漏掉哪一个都不立刻暴露。对账能保证「四份一致」，
 * 保证不了「四份都是新的」—— 而后者才是真正会伤到用户的那一半。
 *
 * 于是令牌连同组件一起进了 `@osteosome/ui`。现在不存在漂移的可能，
 * 因为只有一份源码。于是本文件从「逐字比对」改成「**断言没有副本**」：
 * 它守的正是当初建立复制的那个理由消失之后，不有人把它重新引入。
 *
 * 为什么住在 core 的测试里：它跨包（client / plugins / sdk），
 * 哪一边都不是「主体」，而它守的确实是「Core 伺服出去的插件界面与宿主看起来是一套」。
 */
const here = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(here, '..', '..')
const CANONICAL = join(REPO_ROOT, 'sdk', 'ui', 'src')

/** 扫源码目录（跳过 node_modules / dist / .git 与测试文件） */
function findDuplicates(name: string): string[] {
  const hits: string[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (['node_modules', 'dist', '.git', '.aoci', 'docs'].includes(entry.name)) continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full)
      } else if (entry.name === name && full !== join(CANONICAL, name)) {
        hits.push(path.relative(REPO_ROOT, full))
      }
    }
  }
  walk(REPO_ROOT)
  return hits
}

/** 收集源码里对 styles 的引用（.ts / .vue / .css 都算）。带文件路径，便于按消费点断言 */
function styleImports(): Array<{ file: string; spec: string }> {
  const hits: Array<{ file: string; spec: string }> = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (['node_modules', 'dist', '.git', '.aoci'].includes(entry.name)) continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (/\.(ts|vue|css)$/.test(entry.name) && !full.includes(`${path.sep}tests${path.sep}`)) {
        const text = readFileSync(full, 'utf8')
        // 只关心**我们自己的**令牌 —— `dockview-vue/dist/styles/dockview.css` 之类的
        // 第三方样式表路径里也有 "styles/"，那是依赖自带的，与单一来源无关
        for (const m of text.matchAll(
          /from\s+'([^']*\/(?:tokens|base)\.css)'|import\s+'([^']*\/(?:tokens|base)\.css)'/g,
        )) {
          hits.push({ file: path.relative(REPO_ROOT, full).split(path.sep).join('/'), spec: m[1] ?? m[2] ?? '' })
        }
      }
    }
  }
  walk(REPO_ROOT)
  return hits
}

/** 令牌的消费点：宿主 + 每个有 `ui/src` 的插件 */
function expectedConsumerDirs(): string[] {
  const dirs = ['client']
  const pluginsRoot = join(REPO_ROOT, 'plugins')
  if (!existsSync(pluginsRoot)) return dirs
  for (const entry of readdirSync(pluginsRoot, { withFileTypes: true })) {
    if (entry.isDirectory() && existsSync(join(pluginsRoot, entry.name, 'ui', 'src'))) {
      dirs.push(`plugins/${entry.name}/ui`)
    }
  }
  return dirs
}

describe('设计令牌 · 单一来源（P6）', () => {
  it('全仓没有 tokens.css 副本', () => {
    const dupes = findDuplicates('tokens.css')
    expect(
      dupes,
      `这些文件是 tokens.css 的副本，应改为从 '@osteosome/ui/styles/tokens.css' 引：\n${dupes.join('\n')}`,
    ).toEqual([])
  })

  it('全仓没有 base.css 副本', () => {
    const dupes = findDuplicates('base.css')
    expect(
      dupes,
      `这些文件是 base.css 的副本，应改为从 '@osteosome/ui/styles/base.css' 引：\n${dupes.join('\n')}`,
    ).toEqual([])
  })

  it('宿主与每个插件 UI 都从共享包引令牌', () => {
    const imports = styleImports()
    const consumers = expectedConsumerDirs()

    // 不写死数量：P6 收尾时是 4 处（宿主 + 三个插件 UI），再加插件就自动算进去。
    // 写死的话，每加一个插件 UI 就要有人记得改这里 —— 而忘改的后果是这条测试
    // 静默地不再守新插件（数对不上才报错，数对得上就是空转）。
    expect(consumers.length, '至少该有宿主一个消费点').toBeGreaterThanOrEqual(1)

    for (const dir of consumers) {
      const inDir = imports.filter((i) => i.file.startsWith(`${dir}/`))
      for (const spec of ['@osteosome/ui/styles/tokens.css', '@osteosome/ui/styles/base.css']) {
        expect(
          inDir.some((i) => i.spec === spec),
          `${dir} 没有引 ${spec} —— 它的界面会没有颜色变量（一片透明/黑）`,
        ).toBe(true)
      }
    }

    // 没有任何人从相对路径引本地副本（副本本身由上面两条 findDuplicates 守）
    const local = imports.filter((i) => !i.spec.startsWith('@osteosome/ui/'))
    expect(local, `这些引用指向本地副本：${local.map((l) => l.spec).join(', ')}`).toEqual([])
  })

  it('共享包里的令牌文件真的定义了变量（否则上面三条全在验空气）', () => {
    for (const name of ['tokens.css', 'base.css']) {
      const file = join(CANONICAL, name)
      expect(statSync(file).size).toBeGreaterThan(0)
      expect(readFileSync(file, 'utf8')).toContain('--color-bg')
    }
  })
})