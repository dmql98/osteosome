/**
 * workspace 服务（P7 M0 WS-0.3）—— **只列目录、不读文件**。
 *
 * ## 能力边界（不是实现细节）
 *
 * 它支持 UI 的目录选择器：`workspace.list` 返回盘符 + 快捷入口 + 目录项；
 * `workspace.resolve` 判存在；`workspace.open` 用系统文件管理器打开。
 * 它**从不 readFile** —— 只 `readdirSync` + `statSync`（判 isDir）。
 * 这条边界写在类型与测试里：越界读文件的能力，模型与界面都不该经由本服务拿到。
 *
 * ## 它不是工具
 *
 * workspace 服务**不进 `tool.registered`** —— 模型够不到它。它是 UI 支撑面。
 *
 * ## 天枢的差异
 *
 * 天枢把 `/api/workspace/*` 做成 **Core 路由**；OST 的 Core 没有任意文件系统面
 * （只有 `/api/plugins` 与 `/plugins/*`），所以这里是**服务命令**，走总线。
 */
import { Service, logger } from '@osteosome/service-sdk'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import type { DirEntry, DirRoot } from '@osteosome/shared'

const service = new Service({ id: 'workspace', version: '1.0.0' })

/** 隐藏项过滤：以 `.` 开头（posix 约定；Windows 隐藏属性另论，这里只按名字） */
function isHidden(name: string): boolean {
  return name.startsWith('.')
}

/** 快捷入口（盘符之外） */
function quickRoots(): DirRoot[] {
  const home = homedir()
  const out: DirRoot[] = [{ name: '主目录', path: home, kind: 'quick' }]
  if (process.platform === 'win32') {
    const desktop = join(home, 'Desktop')
    if (existsSync(desktop)) out.push({ name: '桌面', path: desktop, kind: 'quick' })
  }
  return out
}

/** 盘符（仅 Windows；其他平台返回空） */
function driveRoots(): DirRoot[] {
  if (process.platform !== 'win32') return []
  const out: DirRoot[] = []
  for (let c = 65; c <= 90; c += 1) {
    const letter = String.fromCharCode(c)
    const p = `${letter}:\\`
    try {
      if (existsSync(p)) out.push({ name: `${letter}:`, path: p, kind: 'drive' })
    } catch {
      // 无权限/不可访问的盘符跳过
    }
  }
  return out
}

/** 列一个目录（只 readdir/stat；目录在前，各自按 name 排序；隐藏项过滤） */
function listDir(dir: string): DirEntry[] {
  const entries: DirEntry[] = []
  for (const name of readdirSync(dir)) {
    if (isHidden(name)) continue
    const full = join(dir, name)
    let isDir = false
    try {
      isDir = statSync(full).isDirectory()
    } catch {
      continue // 断链/无权限项跳过
    }
    entries.push({ name, path: full, isDir })
  }
  entries.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0
  })
  return entries
}

service.subscribe('workspace.list', (payload) => {
  const requestId = typeof payload.requestId === 'string' ? payload.requestId : ''
  if (!requestId) return
  const raw = typeof payload.path === 'string' ? payload.path : ''
  const roots = [...driveRoots(), ...quickRoots()]
  if (!raw) {
    service.publish('workspace.list.result', { requestId, entries: [], currentPath: '', parentPath: null, roots })
    return
  }
  const path = resolve(raw)
  if (!existsSync(path)) {
    // 不崩：给空列表 + 原路径（界面据此提示）
    service.publish('workspace.list.result', { requestId, entries: [], currentPath: path, parentPath: dirname(path), roots })
    return
  }
  let entries: DirEntry[] = []
  try {
    entries = listDir(path)
  } catch (err) {
    logger.warn(`workspace.list: ${path}: ${String(err)}`)
  }
  service.publish('workspace.list.result', {
    requestId,
    entries,
    currentPath: path,
    parentPath: dirname(path) === path ? null : dirname(path),
    roots,
  })
})

service.subscribe('workspace.resolve', (payload) => {
  const requestId = typeof payload.requestId === 'string' ? payload.requestId : ''
  const raw = typeof payload.path === 'string' ? payload.path : ''
  if (!requestId) return
  const path = raw ? resolve(raw) : ''
  service.publish('workspace.resolve.result', { requestId, path: path && existsSync(path) ? path : null })
})

service.subscribe('workspace.open', (payload) => {
  const raw = typeof payload.path === 'string' ? payload.path : ''
  if (!raw) return
  const path = resolve(raw)
  // 用系统文件管理器打开；失败只记日志（不产结果 —— 这是 fire-and-forget 的 UI 动作）
  try {
    if (process.platform === 'win32') spawn('explorer', [path], { detached: true, stdio: 'ignore' }).unref()
    else if (process.platform === 'darwin') spawn('open', [path], { detached: true, stdio: 'ignore' }).unref()
    else spawn('xdg-open', [path], { detached: true, stdio: 'ignore' }).unref()
  } catch (err) {
    logger.warn(`workspace.open: ${path}: ${String(err)}`)
  }
})

async function main(): Promise<void> {
  await service.start()
  logger.info(`workspace: ready (list/resolve/open · 只列目录不读文件)`)
}

main().catch((err: unknown) => {
  console.error(`workspace: failed to start: ${String(err)}`)
  process.exit(1)
})
