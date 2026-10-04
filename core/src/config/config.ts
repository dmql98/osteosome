/**
 * Core 配置加载（P1a WS-4）—— CLI / env 解析，fail fast。
 *
 * 优先级：CLI > env > 默认值。
 * - `--services` / `OST_SERVICES` → **显式的扁平服务目录**（给了就只用它，插件目录一概不看；
 *   缺省 = 从插件目录发现服务，见 `main.ts`）
 * - `--data` / `OST_DATA`         → 数据根目录
 * - `--dist` / `OST_DIST`         → 前端静态资源目录（缺省 `./dist/client`）
 * - `--port` / `OST_PORT`         → HTTP 端口（缺省 1420）
 * - `--plugins` / `OST_PLUGINS`   → 插件目录（缺省 `./plugins`；给 `none` 或空串 = **关掉插件层**）
 *
 * ## 路径缺省：发行版 vs 开发
 *
 * 有发行标记（exe 同级 `.osteosome-dist`）时，**安装根 = exe 旁边**，于是
 * `dataDir = <安装根>/userData`、`pluginsDir = <安装根>/plugins` —— 整份发行物自包含，
 * 拷走即换机器。没有标记（开发跑）时 `dataDir` 退到用户目录（`userDataDir()`）、
 * `pluginsDir` 退到 `./plugins`。判据见 `paths.ts` 的 `installRoot()`。
 *
 * 支持 `--key value` 与 `--key=value` 两种写法。
 */
import { isAbsolute, join, resolve } from 'node:path'
import { installRoot, userDataDir } from './paths'

/** CLI/env 解析后的 Core 配置（路径均已 resolve 为绝对路径） */
export interface CoreConfig {
  dataDir: string
  distDir: string
  port: number
  /**
   * 插件目录（S7）。**`undefined` = 不启用插件层** → Core 照旧无条件启动 services/ 下所有服务。
   *
   * 这个「关掉」的能力不是给产品用的，是给**测试**用的：core/tests 里有 17 个集成测试
   * 起真 Core 只为拿到某几个服务，若它们都得先「装插件」，测试就从「测 provider」
   * 变成「测插件装配」，红的理由和被测的东西无关。
   *
   * 产品路径永远启用（startCore 默认指向 `<repo>/plugins`，见 main.ts）。
   */
  /**
   * **显式的扁平服务目录**（里面直接放 `<id>/service.json`）。
   *
   * 缺省 `undefined` = 「从插件目录发现服务」（P1 之后的主路径）。
   * 显式给出时**只用它**，插件目录一概不看 —— 这是给集成测试与逃生门用的：
   * core/tests 里有 17 个集成测试只想临时起某几个服务，若都得先造插件骨架，
   * 测试就从「测 provider」变成「测插件装配」，红灯理由和被测物无关。
   */
  servicesDir?: string
  /**
   * 插件目录（S7）。**`undefined` = 不启用插件层** → Core 照旧无条件启动 services/ 下所有服务。
   *
   * 这个「关掉」的能力不是给产品用的，是给**测试**用的：core/tests 里有 17 个集成测试
   * 起真 Core 只为拿到某几个服务，若它们都得先「装插件」，测试就从「测 provider」
   * 变成「测插件装配」，红的理由和被测的东西无关。
   *
   * 产品路径永远启用（startCore 默认指向 `<repo>/plugins`，见 main.ts）。
   */
  pluginsDir?: string
  /**
   * 安装根 `<exe 旁边>/osteosome`；`undefined` = **不是发行版**（开发跑）。
   *
   * 判据见 `paths.ts` 的 {@link installRoot}（exe 同级有 `.osteosome-dist` 标记文件）。
   * 是发行版时 `dataDir` / `pluginsDir` 都从这里派生，于是整份发行物自包含。
   */
  installRoot?: string
  /**
   * `dataDir` 是不是**缺省值**（没给 `--data` / `OST_DATA`）。
   *
   * 只给一件事用：决定要不要做旧 `<cwd>/.data` 的一次性迁移（见 `migrateLegacyDataDir`）。
   * 显式指定过数据根 = 部署者另有安排，Core 不该往那儿搬东西。
   */
  dataDirIsDefault?: boolean
}

/** HTTP 默认端口（RFC：本机 SseBridge） */
export const DEFAULT_PORT = 1420

const DEFAULTS = {
  /**
   * 数据根**没有仓库内缺省** —— 走 installRoot() / userDataDir()；`--data` / `OST_DATA` 可覆盖。
   *
   * 服务目录**也没有缺省**了：P1 之后从插件目录发现（`plugins/<id>/services/<sid>/`），
   * `servicesDir` 只在显式给出时存在。
   */
  dist: './dist/client',
  /** S7：插件目录缺省 ./plugins（发行版下为 `<安装根>/plugins`）；目录不存在时按「零插件」处理 */
  plugins: './plugins',
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
 * `execPath` 仅用于判发行版（测试注入；缺省 `process.execPath`）。
 * 端口非法（非整数 / 越界）→ throw（fail fast）。
 */
export function loadConfig(
  argv: string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
  execPath: string = process.execPath,
): CoreConfig {
  const args = parseArgv(argv)

  const pick = (cliKey: string, envKey: string): string | undefined => {
    const fromCli = args.get(cliKey)
    if (fromCli !== undefined && fromCli !== '') return fromCli
    const fromEnv = env[envKey]
    if (fromEnv !== undefined && fromEnv !== '') return fromEnv
    return undefined
  }

  const servicesRaw = pick('services', 'OST_SERVICES')
  const dataRaw = pick('data', 'OST_DATA')
  const distRaw = pick('dist', 'OST_DIST') ?? DEFAULTS.dist
  const portRaw = pick('port', 'OST_PORT') ?? String(DEFAULT_PORT)

  const port = Number(portRaw)
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`config: invalid port '${portRaw}' (expected integer 0-65535)`)
  }

  // 发行版 → 安装根在 exe 旁边，于是 dataDir / pluginsDir 都在它底下（整份发行物自包含）
  const root = installRoot(execPath)
  // S7：--plugins '' / OST_PLUGINS='' 显式关掉插件层（测试用）；未给则用缺省（发行版下是 <安装根>/plugins）
  const pluginsRaw = args.get('plugins') ?? env.OST_PLUGINS ?? (root ? join(root, 'plugins') : DEFAULTS.plugins)

  return {
    // 没给 → 从插件目录发现服务（main.ts 按插件清单算）；给了就只用它（测试 / 逃生门）
    ...(servicesRaw !== undefined ? { servicesDir: resolvePath(servicesRaw, cwd) } : {}),
    // 没给 --data / OST_DATA → 发行目录或用户目录（数据跟着人，不跟着工作副本）
    dataDir:
      dataRaw !== undefined ? resolvePath(dataRaw, cwd) : root ? join(root, 'userData') : userDataDir(env),
    dataDirIsDefault: dataRaw === undefined,
    distDir: resolvePath(distRaw, cwd),
    port,
    ...(root !== undefined ? { installRoot: root } : {}),
    // 空串 = 显式关闭；`none` 便于在 shell / 测试里表达「不要插件层」
    ...(pluginsRaw !== '' && pluginsRaw !== 'none' ? { pluginsDir: resolvePath(pluginsRaw, cwd) } : {}),
  }
}
