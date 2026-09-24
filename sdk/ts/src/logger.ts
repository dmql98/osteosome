/**
 * SDK 日志（RFC §6.3）—— 写 stderr，不污染 stdout 协议流。
 * 级别受 `OST_LOG_LEVEL` 控制（与 Core logger 同约定）。
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }

let currentLevel: LogLevel = (process.env.OST_LOG_LEVEL as LogLevel) || 'info'

function write(level: LogLevel, msg: string, meta?: unknown): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[currentLevel]) return
  const ts = new Date().toISOString()
  const suffix = meta !== undefined ? ` ${typeof meta === 'string' ? meta : JSON.stringify(meta)}` : ''
  process.stderr.write(`[${ts}] ${level.toUpperCase()} ${msg}${suffix}\n`)
}

export const logger = {
  debug(msg: string, meta?: unknown) {
    write('debug', msg, meta)
  },
  info(msg: string, meta?: unknown) {
    write('info', msg, meta)
  },
  warn(msg: string, meta?: unknown) {
    write('warn', msg, meta)
  },
  error(msg: string, meta?: unknown) {
    write('error', msg, meta)
  },
  setLevel(level: LogLevel) {
    currentLevel = level
  },
}
