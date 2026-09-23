/**
 * 统一日志（RFC §7.2 logger.ts）—— 写 stdout，结构化为 JSON 可选。
 * 服务子进程的日志走 stderr（SDK logger），Core 聚合；这里只管 Core 自身。
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }

let currentLevel: LogLevel = (process.env.OST_LOG_LEVEL as LogLevel) || 'info'
let jsonMode = process.env.OST_LOG_JSON === '1'

function ts(): string {
  return new Date().toISOString()
}

function write(level: LogLevel, msg: string, meta?: unknown): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[currentLevel]) return
  if (jsonMode) {
    const line = { t: ts(), level, msg, ...(meta !== undefined ? { meta } : {}) }
    process.stdout.write(`${JSON.stringify(line)}\n`)
    return
  }
  const suffix = meta !== undefined ? ` ${typeof meta === 'string' ? meta : JSON.stringify(meta)}` : ''
  process.stdout.write(`[${ts()}] ${level.toUpperCase()} ${msg}${suffix}\n`)
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
  setJson(flag: boolean) {
    jsonMode = flag
  },
}