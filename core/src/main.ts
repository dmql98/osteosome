import { randomUUID } from 'node:crypto'
import { existsSync, readdirSync } from 'node:fs'
import path from 'node:path'
import type { ServiceStatus } from '@osteosome/shared'
import { Bus } from './bus/bus'
import { ensureDir, loadConfig, type CoreConfig } from './config'
import { logger } from './logger'
import { readPreferences } from './preferences'
import { ServiceManager, type ServiceManagerOptions } from './service-manager'
import { PluginRegistry } from './service-manager/plugin-registry-runtime'
import { SseBridge, type SseBridgeOptions } from './sse-bridge'
import { CredentialApi } from './credentials/api'
import { CredentialStore } from './credentials/store'

/**
 * `services/<id>/` 里声明过的服务 id —— 用来校验插件 `services[]` 有没有指向不存在服务。
 *
 * 刻意**不复用** `loadServices`：那个是「全成功或抛」，这里只是拿个 id 集合做交叉校验。
 * 一个坏 service.json 不该顺带让插件层拒绝工作。代价是遍历逻辑有小幅重复，
 * 等 S7-2b 把两边并到一起再说。
 */
function readDeclaredServiceIds(servicesDir: string): string[] {
  if (!existsSync(servicesDir)) return []
  return readdirSync(servicesDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(path.join(servicesDir, e.name, 'service.json')))
    .map((e) => e.name)
}

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
  /** 凭证能力（P4 WS-1） */
  credentials: CredentialApi
  port: number
  stop: () => Promise<void>
}

export async function startCore(options: StartCoreOptions = {}): Promise<Core> {
  const base = loadConfig(options.argv, options.env, options.cwd)
  const config: CoreConfig = { ...base, ...options.config }
  ensureDir(config.dataDir)

  const bus = new Bus()
  // 凭证能力（P4 WS-1）：Core 特权数据（不走 P1a §3.1 服务 dataDir 约定）
  const credentialStore = new CredentialStore(config.dataDir)
  const credentials = new CredentialApi(credentialStore, bus)
  if (credentialStore.isCorrupted()) {
    logger.warn('core: credentials.json corrupted — credential ops report error state (Core stays up)')
  }
  let managerRef: ServiceManager
  // 插件层必须**先于** ServiceManager 构造（B 语义要由它算出「允许启动集合」），
  // 所以它不能在自己的构造期读服务状态 —— PluginRegistry 因此把首次聚合做成惰性的。
  const pluginRegistry = new PluginRegistry(bus, {
    pluginsDir: config.pluginsDir,
    knownServiceIds: new Set(readDeclaredServiceIds(config.servicesDir)),
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

  const manager = new ServiceManager({
    servicesDir: config.servicesDir,
    dataDir: config.dataDir,
    sessionId: randomUUID(),
    bus,
    credentials,
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
    credentials,
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

  logger.info(
    `core: started port=${port} services=${config.servicesDir} data=${config.dataDir}`,
  )
  return { config, bus, manager, bridge, credentials, plugins: pluginRegistry, port, stop }
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
