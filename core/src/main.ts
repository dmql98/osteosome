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
  const manager = new ServiceManager({
    servicesDir: config.servicesDir,
    dataDir: config.dataDir,
    sessionId: randomUUID(),
    bus,
    credentials,
    ...options.manager,
  })
  // 插件层（S7-2a）：只读扫盘 + 状态聚合。**不碰启动行为** ——
  // 「未安装插件的服务不 spawn」是 S7-2b。所以这一步无论扫出几个插件，
  // manager.start() 都照旧全启。
  const pluginRegistry = new PluginRegistry(bus, {
    pluginsDir: config.pluginsDir,
    knownServiceIds: new Set(readDeclaredServiceIds(config.servicesDir)),
    listServiceStates: () => serviceStateMap(manager.list()),
    uninstalledIds: () => readUninstalled(config.dataDir),
  })

  const bridge = new SseBridge({
    bus,
    config,
    credentials,
    plugins: pluginRegistry,
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
