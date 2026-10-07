/**
 * shell-tools（P7 M4 WS-7）—— bash / pwsh。
 *
 * ## 沙箱 = 约束清单（不是路径）
 *
 * fs-tools 的沙箱是「工作区目录」，shell 的是 `allowed_commands`：**空清单 = 全禁**
 * （默认放行等于让插件单方面获得任意代码执行）。`denied_patterns` 优先。
 * 命令在**工作区目录**里跑（cwd = workspaces[0]）。
 */
import { Service, logger } from '@osteosome/service-sdk'
import { execFile } from 'node:child_process'
import {
  firstToken,
  parseToolArguments,
  validateConstraints,
  type ConstraintField,
  type ToolRisk,
} from '@osteosome/shared'

const SERVICE_ID = 'shell-tools'
const service = new Service({ id: SERVICE_ID, version: '1.0.0' })

const CONSTRAINT_FIELDS: ConstraintField[] = [
  { key: 'allowed_commands', label: '允许命令', type: 'string-list', validateArg: 'command', validateRule: 'exact-allow' },
  { key: 'denied_patterns', label: '禁止模式', type: 'string-list', validateArg: 'command', validateRule: 'substring-deny' },
]

const TOOLS = ['bash', 'pwsh'].map((name) => ({
  name,
  description: `在工作区目录里执行一条 ${name === 'bash' ? 'bash' : 'powershell'} 命令`,
  parameters: {
    type: 'object',
    properties: { command: { type: 'string' }, timeout_seconds: { type: 'number' } },
    required: ['command'],
  },
  risk: 'proc' as ToolRisk,
  constraintFields: CONSTRAINT_FIELDS,
}))

let constraints: Record<string, Record<string, unknown>> = {}
function registerTools(): void {
  service.publish('tool.registered', { serviceId: SERVICE_ID, tools: TOOLS })
}
service.subscribe('tools.state', (p) => {
  const c = (p as { constraints?: unknown } | null)?.constraints
  if (c && typeof c === 'object') constraints = c as Record<string, Record<string, unknown>>
})
service.subscribe('tools.list', registerTools)

const pendingApproval = new Map<string, (approved: boolean) => void>()
service.subscribe('tool.approval.resolved', (p) => {
  const id = typeof p.requestId === 'string' ? p.requestId : ''
  const s = id ? pendingApproval.get(id) : undefined
  if (s) {
    pendingApproval.delete(id)
    s(p.approved === true)
  }
})
function askApproval(T: string, sessionId: string, name: string, risk: ToolRisk, args: Record<string, unknown>): Promise<boolean> {
  if (risk === 'read') return Promise.resolve(true)
  service.publish('tool.approval.requested', { requestId: T, sessionId, toolName: name, risk, arguments: JSON.stringify(args), kind: 'exec' })
  return new Promise<boolean>((resolve) => {
    pendingApproval.set(T, resolve)
    setTimeout(() => {
      if (pendingApproval.delete(T)) resolve(false)
    }, 120_000)
  })
}

service.subscribe('tool.execute', async (payload) => {
  const T = typeof payload.requestId === 'string' ? payload.requestId : ''
  const name = typeof payload.name === 'string' ? payload.name : ''
  const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId : ''
  if (!T || (name !== 'bash' && name !== 'pwsh')) return
  const decl = TOOLS.find((t) => t.name === name)!
  const args = parseToolArguments(typeof payload.arguments === 'string' ? payload.arguments : '{}') ?? {}
  const out = (ok: boolean, content: string, summary = content) =>
    service.publish('tool.execute.result', { requestId: T, ok, content, summary })

  const cviol = validateConstraints(CONSTRAINT_FIELDS, constraints[name] ?? {}, args)
  if (cviol) return out(false, cviol)

  if (!(await askApproval(T, sessionId, name, 'proc', args))) return out(false, '审批被拒绝或超时')

  const command = String(args.command ?? '')
  const cwd = Array.isArray(payload.workspaces) ? (payload.workspaces as string[])[0] : undefined
  const timeout = typeof args.timeout_seconds === 'number' ? Math.min(Math.max(args.timeout_seconds, 1), 120) : 60
  try {
    const res = await new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
      const shell = name === 'pwsh' ? 'powershell.exe' : 'bash'
      execFile(shell, name === 'pwsh' ? ['-NoProfile', '-Command', command] : ['-lc', command], {
        cwd: cwd && cwd !== '' ? cwd : undefined,
        timeout: timeout * 1000,
        maxBuffer: 5 * 1024 * 1024,
        windowsHide: true,
      }, (err, stdout, stderr) => {
        if (err && (err as { killed?: boolean }).killed) reject(new Error(`命令超时（${timeout}s）`))
        else if (err) resolve({ code: (err as { code?: number }).code ?? 1, stdout: String(stdout), stderr: String(stderr) })
        else resolve({ code: 0, stdout: String(stdout), stderr: String(stderr) })
      })
    })
    const ok = res.code === 0
    out(ok, (res.stdout + (res.stderr ? `\n[stderr]\n${res.stderr}` : '')).trim() || '(无输出)', `${name} ${firstToken(command)} → 退出码 ${res.code}`)
  } catch (err) {
    out(false, String((err as Error)?.message ?? err))
  }
})

async function main(): Promise<void> {
  await service.start()
  registerTools()
  logger.info(`shell-tools: registered ${TOOLS.map((t) => t.name).join(', ')}（空 allowed_commands = 全禁）`)
}
main().catch((err: unknown) => {
  console.error(`shell-tools: failed to start: ${String(err)}`)
  process.exit(1)
})
