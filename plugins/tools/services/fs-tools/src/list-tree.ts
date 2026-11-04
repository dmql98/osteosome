/**
 * 目录树渲染（`ls` 工具的实现）—— 纯函数，不碰总线，可直接单测。
 *
 * ## 为什么单独一个文件
 *
 * `index.ts` 在模块顶层就 `service.start()`，任何单测都会真的去连总线。
 * 这个项目的既有做法是「把能测的算出来、把接线的留在 service 里」
 * （见 `models` 插件的 `instances.ts` / `store.ts`）。这里照办。
 *
 * ## 有界，且**诚实地说明被截断**
 *
 * 模型最常犯的错是 `ls /` 然后拿回几千行。所以：
 * - 深度默认 1、上限 3（再深就不是「看看目录」，而是「全库扫描」，那是 glob 的事）；
 * - 条目上限 300，超了在正文末尾写一行 `…（已截断，共 N 项）`——
 *   静默截断会让模型以为目录就这些，然后编造不存在的文件名。
 */
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** 一次 `ls` 最多列多少条 */
export const MAX_ENTRIES = 300

/** 深度上限：1 = 只看这一层 */
export const MAX_DEPTH = 3

export interface ListTreeOptions {
  /** 往下看几层，1 起。缺省 1 */
  depth?: number
  /** 是否包含以 `.` 开头的条目（缺省不包含） */
  all?: boolean
  maxEntries?: number
}

export interface ListTreeResult {
  /** 逐行的目录树（目录名带尾斜杠，子项缩进两格） */
  text: string
  /** 实际列出的条目数（不含截断提示行） */
  entries: number
  /** 是否因为条目上限被截断 */
  truncated: boolean
}

interface Entry {
  name: string
  isDir: boolean
}

/**
 * 读一层目录。读不了就**当空**（权限/竞态），而不是抛 ——
 * 一个子目录读不了不该让整次 `ls` 失败。
 */
function readEntries(dir: string, all: boolean): Entry[] {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  const out: Entry[] = []
  for (const name of names) {
    if (!all && name.startsWith('.')) continue
    let isDir = false
    try {
      isDir = statSync(join(dir, name)).isDirectory()
    } catch {
      continue
    }
    out.push({ name, isDir })
  }
  // 目录在前、同类按字典序：同一份目录每次输出的顺序都一样，diff 才有意义
  return out.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
    return a.name.localeCompare(b.name)
  })
}

/**
 * 把目录渲染成缩进树。
 * @param root 绝对目录路径
 * @param opts 深度 / 隐藏项 / 条目上限
 * @returns 树文本 + 是否截断
 */
export function listTree(root: string, opts: ListTreeOptions = {}): ListTreeResult {
  const depth = Math.min(Math.max(Math.floor(opts.depth ?? 1), 1), MAX_DEPTH)
  const all = opts.all === true
  const maxEntries = Math.max(Math.floor(opts.maxEntries ?? MAX_ENTRIES), 1)

  const lines: string[] = []
  let entries = 0
  let truncated = false

  const walk = (dir: string, level: number): void => {
    const items = readEntries(dir, all)
    for (const item of items) {
      if (entries >= maxEntries) {
        truncated = true
        return
      }
      entries += 1
      lines.push(`${'  '.repeat(level)}${item.name}${item.isDir ? '/' : ''}`)
      if (item.isDir && level + 1 < depth) walk(join(dir, item.name), level + 1)
    }
  }

  walk(root, 0)
  if (truncated) lines.push(`…（已截断，只列前 ${maxEntries} 项）`)
  return { text: lines.join('\n'), entries, truncated }
}
