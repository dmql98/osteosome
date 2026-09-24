/**
 * Core 配置加载（P1a WS-4）—— CLI / env 解析，fail fast。
 *
 * 优先级：CLI > env > 默认值。
 * - `--services` / `OST_SERVICES` → services 目录（缺省 `./services`）
 * - `--data` / `OST_DATA`         → 数据根目录（缺省 `./.data`）
 * - `--dist` / `OST_DIST`         → 前端静态资源目录（缺省 `./dist/client`）
 * - `--port` / `OST_PORT`         → HTTP 端口（缺省 1420）
 *
 * 支持 `--key value` 与 `--key=value` 两种写法。
 */
import { isAbsolute, resolve } from 'node:path'

/** CLI/env 解析后的 Core 配置（路径均已 resolve 为绝对路径） */
export interface CoreConfig {
  servicesDir: string
  dataDir: string
  distDir: string
  port: number
}

/** HTTP 默认端口（RFC：本机 SseBridge） */
export const DEFAULT_PORT = 1420

const DEFAULTS = {
  services: './services',
  data: './.data',
  dist: './dist/client',
} as const

/** 解析 `--key value` / `--key=value` → map（值缺省时记空串） */
function parseArgv(argv: string[]): Map<string, string> {
  const out = new Map<string, string>()
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (!arg.startsWith('--')) continue
    const eq = arg.indexOf('=')
    if (eq !== -1) {
      out.set(arg.slice(2, eq), arg.slice(eq + 1))
      continue
    }
    const key = arg.slice(2)
    const next = argv[i + 1]
    if (next !== undefined && !next.startsWith('--')) {
      out.set(key, next)
      i++
    } else {
      out.set(key, '')
    }
  }
  return out
}

function resolvePath(value: string, cwd: string): string {
  return isAbsolute(value) ? value : resolve(cwd, value)
}

/**
 * 从 argv（默认 `process.argv.slice(2)`）与 env 加载配置。
 * `cwd` 仅用于相对路径解析（测试注入；缺省 `process.cwd()`）。
 * 端口非法（非整数 / 越界）→ throw（fail fast）。
 */
export function loadConfig(
  argv: string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): CoreConfig {
  const args = parseArgv(argv)

  const pick = (cliKey: string, envKey: string): string | undefined => {
    const fromCli = args.get(cliKey)
    if (fromCli !== undefined && fromCli !== '') return fromCli
    const fromEnv = env[envKey]
    if (fromEnv !== undefined && fromEnv !== '') return fromEnv
    return undefined
  }

  const servicesRaw = pick('services', 'OST_SERVICES') ?? DEFAULTS.services
  const dataRaw = pick('data', 'OST_DATA') ?? DEFAULTS.data
  const distRaw = pick('dist', 'OST_DIST') ?? DEFAULTS.dist
  const portRaw = pick('port', 'OST_PORT') ?? String(DEFAULT_PORT)

  const port = Number(portRaw)
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`config: invalid port '${portRaw}' (expected integer 0-65535)`)
  }

  return {
    servicesDir: resolvePath(servicesRaw, cwd),
    dataDir: resolvePath(dataRaw, cwd),
    distDir: resolvePath(distRaw, cwd),
    port,
  }
}
