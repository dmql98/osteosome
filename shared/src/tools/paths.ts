/**
 * 工具路径守卫（P7 §4.3 / §4.5）—— 执行者在**动手之前**必须先过这里。
 *
 * ## 为什么在 shared 而不在各执行者
 *
 * `assertPathSafe` 是**唯一**一份实现，四个执行者共用。各写一份必然漂移
 * （「edit 的路径检查比 read 宽」）——那种差异零报错，只在某天越界时才显形。
 *
 * ## 多根时 workspace 排第一
 *
 * 相对路径按 `roots[0]` resolve（loop 透传时把 `workspace` 放第一个），
 * 于是「历史里的 `src/a.ts` 换了根就指向别处」这种漂移被钉死在一个基准上。
 *
 * ## 越界不是错误，是一次可操作的授权
 *
 * 越界 → 执行者产 `tool.execute.result{ok:false, escape:{requestedPath, permissionRoot}}`，
 * 由 loop 发起 `kind:'workspace'` 审批；批准后把 `permissionRoot` 加进授权根并**重派**。
 * 之所以能重派，前提是**路径校验发生在任何副作用之前** —— 这条前提有测试守着。
 */
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'

export interface PathOk {
  ok: true
  /** 归一化后的绝对路径 */
  absolute: string
  /** 落在哪个授权根里 */
  root: string
}
export interface PathReject {
  ok: false
  reason: string
}
export type PathCheck = PathOk | PathReject

/** Windows 上跑（用于把 git-bash 的 `/c/` 归一成 `C:\`） */
export function isWindows(): boolean {
  return process.platform === 'win32'
}

const DRIVE_RE = /^[a-zA-Z]:[\\/]/
const BASH_DRIVE_RE = /^\/([a-zA-Z])(\/|$)/

/**
 * 路径归一化（迁自天枢 `normalizePathForPlatform`）：
 * - 反斜杠统一成正斜杠再交给 `node:path`；
 * - git-bash 的 `/c/Users/…` → `C:/Users/…`（仅 Windows 有意义，但归一化本身与平台无关）。
 */
export function normalizePathForPlatform(raw: string): string {
  let p = raw.trim().replace(/\\/g, '/')
  const m = BASH_DRIVE_RE.exec(p)
  if (m) p = `${m[1].toUpperCase()}:/${p.slice(m[0].length)}`
  return p
}

/** `child` 是否在 `root` 之内（或就是它）。两侧都已 resolve。 */
export function isInside(root: string, child: string): boolean {
  const rel = relative(root, child)
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
}

/**
 * 把请求路径解析成一个绝对路径，并检查它落在**任一**授权根内。
 * 相对路径按 `roots[0]`（workspace 第一）解析。
 */
export function assertPathSafe(requested: unknown, roots: readonly string[]): PathCheck {
  if (typeof requested !== 'string' || requested.trim() === '') {
    return { ok: false, reason: 'path must be a non-empty string' }
  }
  if (requested.includes('\0')) return { ok: false, reason: 'path contains a NUL byte' }
  if (roots.length === 0) {
    return { ok: false, reason: '没有绑定工作区（workspace）—— 请先授权一个项目目录' }
  }
  const norm = normalizePathForPlatform(requested)
  const base = resolve(roots[0])
  const absolute = isAbsolute(norm) ? resolve(norm) : resolve(base, norm)
  for (const r of roots) {
    const root = resolve(r)
    if (isInside(root, absolute)) return { ok: true, absolute, root }
  }
  return { ok: false, reason: `path '${requested}' 越出了所有授权根` }
}

/**
 * 最小可授权目录（`tool.execute.result.escape.permissionRoot`）。
 *
 * 取请求路径的父目录：授权它之后，该路径就在根内。给 `C:\` 这种会把整盘放进来 ——
 * 所以调用方（loop）在发起工作区审批时要把这个目录原样展示给用户确认。
 */
export function workspaceApprovalRoot(requested: string): string {
  const norm = normalizePathForPlatform(requested)
  const abs = isAbsolute(norm) ? resolve(norm) : resolve(norm)
  return dirname(abs)
}

/** 判断一个 glob 模式是不是「单独的通配」——`*` / `**` / `.` 这种等于全放行，必须 fail fast */
export function isWildcardAll(pattern: unknown): boolean {
  if (typeof pattern !== 'string') return false
  const p = pattern.trim()
  return p === '*' || p === '**' || p === './*' || p === '**/*' || p === '/' || p === '\\'
}

/** 校验 `drive`/盘符路径段（复用给 tools 契约） */
export { DRIVE_RE }
