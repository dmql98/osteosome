import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import type { ServiceStatus } from '@osteosome/shared'
import { Bus } from './bus/bus'
import {
  coreVersion,
  ensureDir,
  loadConfig,
  migrateFlatLayout,
  migrateLegacyDataDir,
  migratePluginOwnedData,
  type CoreConfig,
} from './config'
import { logger } from './logger'
import { readPreferences } from './preferences'
import { ServiceManager, type ServiceManagerOptions } from './service-manager'
import { PluginRegistry } from './service-manager/plugin-registry-runtime'
import { SseBridge, type SseBridgeOptions } from './sse-bridge'

/** `ServiceManager.list()`（ServiceInfo[]）→ 状态映射 */
function serviceStateMap(list: { id: string; status: ServiceStatus }[]): Map<string, ServiceStatus> {
  return new Map(list.map((s) => [s.id, s.status]))
}

/**
 * `preferences.plugins.uninstalled` —— 装了但被卸掉的插件 id。
 *
 * `Preferences` 是 `Record<string, unknown>`（无 schema），所以这里**防御式读**：
 * 手写坏 JSON 或旧版本残留都不该让 Core 起不来。
 */
function readUninstalled(dataDir: string): Set<string> {
  const { value } = readPreferences(dataDir)
  const plugins = value.plugins
  if (typeof plugins !== 'object' || plugins === null) return new Set()
  const list = (plugins as Record<string, unknown>).uninstalled
  if (!Array.isArray(list)) return new Set()
  return new Set(list.filter((x): x is string => typeof x === 'string'))
}

/**
 * `preferences.plugins.enabled` 里值为 `false` 的插件 id（S7-4）。
 *
 * 只认**显式 false**：`enabled[id]` 缺省即启用，所以 `undefined` / `true` 都不算停用。
 * 防御式读的原因同 `readUninstalled` —— `Preferences` 是 `Record<string, unknown>`，没有 schema。
 */
function readDisabled(dataDir: string): Set<string> {
  const { value } = readPreferences(dataDir)
  const plugins = value.plugins
  if (typeof plugins !== 'object' || plugins === null) return new Set()
  const enabled = (plugins as Record<string, unknown>).enabled
  if (typeof enabled !== 'object' || enabled === null) return new Set()
  const map = enabled as Record<string, unknown>
  return new Set(Object.keys(map).filter((id) => map[id] === false))
}

export interface StartCoreOptions {
  argv?: string[]
  env?: NodeJS.ProcessEnv
  cwd?: string
  config?: Partial<CoreConfig>
  manager?: Partial<
    Pick<
      ServiceManagerOptions,
      'handshakeTimeoutMs' | 'stopGraceMs' | 'maxRestarts' | 'backoffBaseMs'
    >
  >
  bridge?: Partial<Pick<SseBridgeOptions, 'heartbeatMs' | 'zombieMs'>>
}

export interface Core {
  config: CoreConfig
  bus: Bus
  manager: ServiceManager
  bridge: SseBridge
  /** 插件层（S7-2a，只读） */
  plugins: PluginRegistry
  port: number
  stop: () => Promise<void>
}

export async function startCore(options: StartCoreOptions = {}): Promise<Core> {
  const base = loadConfig(options.argv, options.env, options.cwd)
  const config: CoreConfig = { ...base, ...options.config }
  ensureDir(config.dataDir)
  // 数据根从仓库内的 `<cwd>/.data` 挪到用户目录之后的一次性迁移。
  // 判据全在 `migrateLegacyDataDir` 里（只对缺省值、只对空目标、只复制文件）；
  // 这里只负责把结果讲清楚 —— 密钥搬了家，用户必须知道它在哪。
  //
  // `options.config.dataDir` 也算「显式」：集成测试与 smoke 都是这样注入临时目录的，
  // 若把它们当成「用缺省值」，本机的 `.data` 会被拷进测试的临时目录里。
  const usingDefaultDataDir = options.config?.dataDir === undefined && (base.dataDirIsDefault ?? false)
  const migrated = usingDefaultDataDir
    ? migrateLegacyDataDir(config.dataDir, options.cwd ?? process.cwd(), true)
    : []
  if (migrated.length > 0) {
    logger.warn(
      `core: migrated legacy ./.data -> ${config.dataDir} (${migrated.join(', ')}). ` +
        `数据现在跟着用户目录走；旧目录确认无用后可自行删除。`,
    )
  }
  // 同一个根里的「扁平 → 三层」：P0 时代写下的 preferences/credentials 留在原地没人读，
  // 用户的表现是「升级后配置与密钥全没了」。这条**不看** isDefault —— 它不是换根，
  // 而是同一个根里换布局，判据在函数内部（目标已有新布局就什么都不做）。
  const relaid = migrateFlatLayout(config.dataDir)
  if (relaid.length > 0) {
    logger.warn(
      `core: moved flat layout -> userData/core + userData/plugin (${relaid.join(', ')}). ` +
        `Core 自己的数据从今往后在 userData/core/ 下。`,
    )
  }

  const bus = new Bus()
  // Core 自己的版本（P2）：判 `pluginCompatibility` 用，同时随握手发给服务。
  const coreVer = coreVersion()
  if (coreVer === '0.0.0') {
    logger.warn(
      'core: cannot read own version from package.json — coreCompatibility checks will treat every plugin as incompatible',
    )
  }
  // 插件用户数据归位：密钥与模型接入清单从 `userData/core/` 搬到 `userData/plugin/models/`。
  // 必须**在起服务之前**搬 —— provider 进程一起来就会读那两个文件，而它是它们的唯一写者。
  const rehomed = migratePluginOwnedData(config.dataDir)
  for (const line of rehomed) {
    if (line.startsWith('WARN:')) logger.warn(`core: ${line}`)
    else logger.warn(`core: ${line} —— 这些数据现在归使用它们的插件自己管。`)
  }
  let managerRef: ServiceManager
  // 插件层必须**先于** ServiceManager 构造（B 语义要由它算出「允许启动集合」，
  // 以及 P1 之后的「服务目录在哪、每个服务的数据根在哪」），
  // 所以它不能在自己的构造期读服务状态 —— PluginRegistry 因此把首次聚合做成惰性的。
  const pluginRegistry = new PluginRegistry(bus, {
    pluginsDir: config.pluginsDir,
    dataDir: config.dataDir,
    coreVersion: coreVer,
    listServiceStates: () => serviceStateMap(managerRef.list()),
    uninstalledIds: () => readUninstalled(config.dataDir),
    disabledIds: () => readDisabled(config.dataDir),
    // 真实的进程启停只能由 ServiceManager 做（它持有 child 句柄），
    // 而「插件包含哪些服务」只有插件层知道 —— 这里把两者接起来，方向仍是单向的。
    controlService: async (command, serviceId) => {
      if (command === 'start') await managerRef.startRegistered(serviceId)
      else await managerRef.stopServicePublic(serviceId)
    },
  })

  /**
   * 服务发现根：**显式 `--services` 优先，否则从插件清单算**。
   *
   * 两者的语义差别要说清：显式给出时插件目录一概不看（测试与逃生门），于是
   * `serviceDataDirs` 也退成空表 —— 那些服务会拿到 `dataDir` 根目录（旧行为）。
   * 生产路径永远走插件层，所以那张表永远是满的。
   */
  const usingExplicitServicesDir = options.config?.servicesDir ?? base.servicesDir
  const serviceDirs = usingExplicitServicesDir ? [usingExplicitServicesDir] : pluginRegistry.serviceDirs()
  const serviceDataDirs = usingExplicitServicesDir ? new Map<string, string>() : pluginRegistry.serviceDataDirs()
  // P3：`plugins.readFile` 的边界（服务只能读自己插件目录）。显式 `--services` 模式下同样退成空表 ——
  // 那些服务本来就不属于任何插件，于是它们调 readFile 会被拒（fail closed）而不是读到任意路径。
  const servicePluginDirs = usingExplicitServicesDir
    ? new Map<string, string>()
    : pluginRegistry.servicePluginDirs()
  if (serviceDirs.length === 0) {
    logger.warn(
      `core: no services found (pluginsDir=${config.pluginsDir ?? 'off'}) — nothing to start`,
    )
  }

  const manager = new ServiceManager({
    serviceDirs,
    serviceDataDirs,
    servicePluginDirs,
    dataDir: config.dataDir,
    coreVersion: coreVer,
    sessionId: randomUUID(),
    bus,
    // B 语义（S7-2b）：三态降级后的「允许启动集合」。undefined = 不限制 = 照旧全启。
    // 这是插件层影响启动行为的**唯一**入口 —— 见 allowedServiceIds() 的说明。
    allowedServiceIds: pluginRegistry.allowedServiceIds(),
    ...options.manager,
  })
  // PluginRegistry 的 controlService / listServiceStates 是**闭包**，调用发生在
  // manager 建好之后（构造期 PluginRegistry 不读服务状态），所以这里安全。
  managerRef = manager

  const bridge = new SseBridge({
    bus,
    config,
    plugins: pluginRegistry,
    controlPlugin: (command, pluginId) => pluginRegistry.control(command, pluginId),
    listServices: () => manager.list(),
    controlService: async (command, serviceId) => {
      try {
        if (command === 'restart') await manager.restart(serviceId)
        else if (command === 'stop') await manager.stopServicePublic(serviceId)
        else await manager.startServicePublic(serviceId)
        return null
      } catch (err) {
        return String(err)
      }
    },
    ...options.bridge,
  })

  let port: number
  try {
    port = await bridge.listen()
    await manager.start()
    // 必须在 manager.start() 之后挂：启动期那一串 starting/ready 就是插件状态
    // 从 stopped 跃到 ready 的时刻，漏了就等于启动完成时状态是陈的。
    pluginRegistry.attach()
  } catch (err) {
    // manager 可能已启动部分服务；启动失败必须按逆序回收，避免孤儿进程。
    await manager.stop().catch((stopErr: unknown) => {
      logger.error(`core: manager rollback failed: ${String(stopErr)}`)
    })
    await bridge.close().catch(() => undefined)
    await bus.close().catch(() => undefined)
    throw err
  }

  let stopPromise: Promise<void> | null = null
  const stop = (): Promise<void> => {
    if (stopPromise === null) {
      stopPromise = (async () => {
        await manager.stop().catch((err: unknown) => {
          logger.error(`core: manager.stop failed: ${String(err)}`)
        })
        await bridge.close().catch((err: unknown) => {
          logger.error(`core: bridge.close failed: ${String(err)}`)
        })
        await bus.close().catch((err: unknown) => {
          logger.error(`core: bus.close failed: ${String(err)}`)
        })
      })()
    }
    return stopPromise
  }

  // 打印服务发现根而不是 `config.servicesDir`：P1 之后那项缺省不存在（从插件目录发现），
// 打出来是 `undefined`，而排障要看的恰恰是**实际扫了哪几个目录**
  logger.info(
    `core: started port=${port} services=${serviceDirs.length ? serviceDirs.join(',') : '(none)'} ` +
      `data=${config.dataDir}`,
  )
  return { config, bus, manager, bridge, plugins: pluginRegistry, port, stop }
}

function isCliEntry(): boolean {
  const entry = process.argv[1]
  return typeof entry === 'string' && /[/\\]main\.(js|ts)$/.test(entry)
}

async function runCli(): Promise<void> {
  const core = await startCore()
  const shutdown = (signal: string): void => {
    logger.info(`core: ${signal} received, shutting down`)
    void core.stop().then(
      () => process.exit(0),
      (err: unknown) => {
        logger.error(`core: shutdown failed: ${String(err)}`)
        process.exit(1)
      },
    )
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
}

if (isCliEntry()) {
  runCli().catch((err: unknown) => {
    logger.error(`core: startup failed: ${String(err)}`)
    process.exit(1)
  })
}
