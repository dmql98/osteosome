/**
 * fs-tools（P7 M2）—— 文件工具执行者：read / glob / grep / write / edit。
 *
 * ## 沙箱 = 传入的 workspaces（执行者自己算，loop 不算）
 *
 * 每个带路径的工具在**动手之前**先过 `shared` 的 `assertPathSafe`（workspace 排第一）。
 * 越界 → 不执行，产 `escape`（由 loop 转成一次工作区审批并重派）。
 *
 * ## 约束在 shared 唯一一份实现
 *
 * `constraints.json`（机器默认，owner = 闸门）经 `tools.state` 重播到这里；
 * 与工具声明（`specs.ts`）一起交给 `validateConstraints`。违反直接失败，不问人。
 *
 * ## 审批
 *
 * 写类（risk≠read）在执行前发 `tool.approval.requested` 并等 `tool.approval.resolved`。
 * 闸门对 auto/deny 立即应答；ask 等用户。超时 → 视为拒绝（产失败结果，不留幽灵）。
 */
import { Service, logger } from '@osteosome/service-sdk'
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import {
  assertPathSafe,
  matchGlob,
  parseToolArguments,
  validateConstraints,
  workspaceApprovalRoot,
  type ToolRisk,
} from '@osteosome/shared'
import { FS_TOOLS } from './specs'

const SERVICE_ID = 'fs-tools'
const service = new Service({ id: SERVICE_ID, version: '1.0.0' })

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.aoci'])
const MAX_GLOB_FILES = 500
const MAX_GREP_FILES = 200
const MAX_GREP_ROWS = 200
const MAX_READ_BYTES = 2 * 1024 * 1024

let constraints: Record<string, Record<string, unknown>> = {}

function registerTools(): void {
  service.publish('tool.registered', {
    serviceId: SERVICE_ID,
    tools: FS_TOOLS.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
      risk: t.risk,
      ...(t.constraintFields ? { constraintFields: t.constraintFields } : {}),
    })),
  })
}

service.subscribe('tools.state', (payload) => {
  const c = (payload as { constraints?: unknown } | null)?.constraints
  if (c && typeof c === 'object') constraints = c as Record<string, Record<string, unknown>>
})
service.subscribe('tools.list', registerTools)

// ── 审批等待（请求 → 应答配对）──
const pendingApproval = new Map<string, (approved: boolean) => void>()
service.subscribe('tool.approval.resolved', (payload) => {
  const id = typeof payload.requestId === 'string' ? payload.requestId : ''
  const settle = id ? pendingApproval.get(id) : undefined
  if (settle) {
    pendingApproval.delete(id)
    settle(payload.approved === true)
  }
})

function askApproval(T: string, sessionId: string, name: string, risk: ToolRisk, args: Record<string, unknown>): Promise<boolean> {
  if (risk === 'read') return Promise.resolve(true)
  service.publish('tool.approval.requested', {
    requestId: T,
    sessionId,
    toolName: name,
    risk,
    arguments: JSON.stringify(args),
    kind: 'exec',
  })
  return new Promise<boolean>((resolve) => {
    pendingApproval.set(T, resolve)
    setTimeout(() => {
      if (pendingApproval.delete(T)) resolve(false)
    }, 120_000)
  })
}

// ── 文件遍历（有界；跳过 node_modules/.git/dist）──
function walkFiles(root: string, limit: number): string[] {
  const out: string[] = []
  const stack = [root]
  while (stack.length > 0 && out.length < limit) {
    const dir = stack.pop()!
    let names: string[]
    try {
      names = readdirSync(dir)
    } catch {
      continue
    }
    for (const n of names) {
      if (out.length >= limit) break
      if (n.startsWith('.') || SKIP_DIRS.has(n)) continue
      const full = join(dir, n)
      let isDir = false
      try {
        isDir = statSync(full).isDirectory()
      } catch {
        continue
      }
      if (isDir) stack.push(full)
      else out.push(full)
    }
  }
  return out
}

function result(T: string, ok: boolean, content: string, summary: string, escape?: { requestedPath: string; permissionRoot: string }): void {
  service.publish('tool.execute.result', { requestId: T, ok, content, summary, ...(escape ? { escape } : {}) })
}

service.subscribe('tool.execute', async (payload) => {
  const T = typeof payload.requestId === 'string' ? payload.requestId : ''
  const name = typeof payload.name === 'string' ? payload.name : ''
  const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId : ''
  if (!T || !name) return
  const decl = FS_TOOLS.find((t) => t.name === name)
  if (!decl) return // 不是本执行者的工具
  const args = parseToolArguments(typeof payload.arguments === 'string' ? payload.arguments : '{}') ?? {}
  const workspaces = Array.isArray(payload.workspaces)
    ? (payload.workspaces as unknown[]).filter((w): w is string => typeof w === 'string')
    : []

  // 1) 约束（违反直接失败，不问人）
  const cviol = validateConstraints(decl.constraintFields ?? [], constraints[name] ?? {}, args)
  if (cviol) return result(T, false, cviol, cviol)

  // 2) 路径守卫（越界 → escape，不执行）
  const rawPath = typeof args.path === 'string' ? args.path : ''
  const effective = rawPath || workspaces[0] || '.'
  const check = assertPathSafe(rawPath || '.', workspaces)
  if (!check.ok) {
    const escape = { requestedPath: rawPath || effective, permissionRoot: workspaceApprovalRoot(rawPath || effective) }
    return result(T, false, `越界：${check.reason}`, check.reason, escape)
  }
  const abs = check.absolute

  // 3) 审批（写类）
  if (!(await askApproval(T, sessionId, name, decl.risk, args))) {
    return result(T, false, '审批被拒绝或超时', '审批未通过')
  }

  // 4) 执行
  try {
    const out = execute(name, abs, args, workspaces)
    result(T, true, out.content, out.summary)
  } catch (err) {
    const msg = String((err as Error)?.message ?? err)
    result(T, false, msg, msg)
  }
})

function execute(
  name: string,
  abs: string,
  args: Record<string, unknown>,
  workspaces: readonly string[],
): { content: string; summary: string } {
  switch (name) {
    case 'read': {
      const stat = statSync(abs)
      if (stat.size > MAX_READ_BYTES) throw new Error(`文件 ${stat.size} B 超过读取上限 ${MAX_READ_BYTES} B`)
      const text = readFileSync(abs, 'utf8')
      const lines = text.split('\n')
      const offset = typeof args.offset === 'number' && args.offset > 0 ? Math.floor(args.offset) : 1
      const limit = typeof args.limit === 'number' && args.limit > 0 ? Math.floor(args.limit) : 400
      const slice = lines.slice(offset - 1, offset - 1 + limit)
      return { content: slice.join('\n'), summary: `read ${abs} (${slice.length}/${lines.length} 行)` }
    }
    case 'write': {
      mkdirSync(dirname(abs), { recursive: true })
      writeFileSync(abs, String(args.content ?? ''), 'utf8')
      const bytes = Buffer.byteLength(String(args.content ?? ''), 'utf8')
      return { content: `已写入 ${abs}`, summary: `write ${abs} (${bytes} B)` }
    }
    case 'edit': {
      const find = String(args.find ?? '')
      const replace = String(args.replace ?? '')
      if (find === '') throw new Error('edit: find 不能为空')
      const text = readFileSync(abs, 'utf8')
      const all = args.replace_all === true
      if (!text.includes(find)) throw new Error('edit: 未找到待替换文本')
      const next = all ? text.split(find).join(replace) : text.replace(find, replace)
      writeFileSync(abs, next, 'utf8')
      return { content: `已编辑 ${abs}`, summary: `edit ${abs}` }
    }
    case 'glob': {
      const pattern = String(args.pattern ?? '**/*')
      const files = walkFiles(abs, MAX_GLOB_FILES)
      const matched = files.filter((f) => matchGlob(pattern, relative(abs, f).replace(/\\/g, '/')))
      return { content: matched.join('\n'), summary: `glob ${pattern} → ${matched.length} 个文件` }
    }
    case 'grep': {
      const pattern = String(args.pattern ?? '')
      let re: RegExp
      try {
        re = new RegExp(pattern)
      } catch {
        throw new Error(`grep: 非法正则 '${pattern}'`)
      }
      const cap = typeof args.max_rows === 'number' && args.max_rows > 0 ? Math.min(Math.floor(args.max_rows), MAX_GREP_ROWS) : MAX_GREP_ROWS
      const files = walkFiles(abs, MAX_GREP_FILES)
      const rows: string[] = []
      for (const f of files) {
        if (rows.length >= cap) break
        let text: string
        try {
          text = readFileSync(f, 'utf8')
        } catch {
          continue
        }
        const lines = text.split('\n')
        for (let i = 0; i < lines.length && rows.length < cap; i += 1) {
          if (re.test(lines[i])) rows.push(`${relative(abs, f).replace(/\\/g, '/')}:${i + 1}: ${lines[i]}`)
        }
      }
      return { content: rows.join('\n'), summary: `grep /${pattern}/ → ${rows.length} 行` }
    }
    default:
      throw new Error(`fs-tools: 未实现的工具 '${name}'`)
  }
}

async function main(): Promise<void> {
  await service.start()
  registerTools()
  logger.info(`fs-tools: registered ${FS_TOOLS.map((t) => t.name).join(', ')}`)
}

main().catch((err: unknown) => {
  console.error(`fs-tools: failed to start: ${String(err)}`)
  process.exit(1)
})
