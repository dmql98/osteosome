/**
 * 服务进程管理（RFC §3.3 / WS-3）—— Windows-safe spawn / kill。
 *
 * - entry 直接执行，不走 shell（避免 cmd shim 差异）；`node` 归一为 process.execPath
 * - 相对路径（如 `dist/index.js`）相对服务工作目录解析
 * - 强制终止：Windows 用 `taskkill /pid /T /F`（杀进程树），其余 SIGKILL
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import * as path from 'node:path'

export interface ManagedProcess {
  child: ChildProcess
  /** 进程退出完成（code / signal） */
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>
}

export interface SpawnServiceOptions {
  /** entry 的工作目录（缺省 = services/<id>/） */
  cwd: string
  env?: Record<string, string | undefined>
}

/** 解析 manifest.entry → { command, args }，相对脚本相对 cwd 解析 */
export function parseEntry(entry: string, cwd: string): { command: string; args: string[] } {
  const argv = entry.trim().split(/\s+/).filter(Boolean)
  if (argv.length === 0) throw new Error(`entry parse: empty command: '${entry}'`)
  if (argv[0] === 'node') argv[0] = process.execPath
  const args = argv.slice(1).map((a) => (a.startsWith('.') ? path.resolve(cwd, a) : a))
  return { command: argv[0], args }
}

/** spawn 一个服务进程（stdout=协议流, stderr=日志） */
export function spawnServiceProcess(entry: string, options: SpawnServiceOptions): ManagedProcess {
  const { command, args } = parseEntry(entry, options.cwd)
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: false,
    windowsHide: true,
  })
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }))
    child.once('error', (err) => {
      // spawn 失败（如入口缺失）也视为退出，避免永不 resolve
      child.emit('exit', null, null)
      resolve({ code: null, signal: null })
    })
  })
  return { child, exited }
}

/** 发 SIGTERM（Windows 上多半映射为强制终止；优雅路径是协议 shutdown） */
export function sendSigterm(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null) return
  child.kill('SIGTERM')
}

/** 强制终止（Windows 进程树，其余 SIGKILL） */
export function forceKill(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null) return
  if (process.platform === 'win32') {
    if (child.pid == null) return
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true })
  } else {
    child.kill('SIGKILL')
  }
}

/** 等待进程退出，超时返回 false */
export async function waitExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs)
    child.once('exit', () => {
      clearTimeout(timer)
      resolve(true)
    })
  })
}

/**
 * 优雅停止：先给 grace 期等自然退出，再 SIGTERM，最后强制杀。
 * （协议层的 shutdown 通知由 manager 先发，本函数只管信号兜底。）
 */
export async function stopProcess(child: ChildProcess, gracefulMs: number): Promise<void> {
  if (await waitExit(child, gracefulMs)) return
  sendSigterm(child)
  if (await waitExit(child, gracefulMs)) return
  forceKill(child)
  await waitExit(child, gracefulMs)
}