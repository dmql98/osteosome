import { randomUUID } from 'node:crypto'
import { Bus } from './bus/bus'
import { ensureDir, loadConfig, type CoreConfig } from './config'
import { logger } from './logger'
import { ServiceManager, type ServiceManagerOptions } from './service-manager'
import { SseBridge, type SseBridgeOptions } from './sse-bridge'
import { CredentialApi } from './credentials/api'
import { CredentialStore } from './credentials/store'

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
  const bridge = new SseBridge({
    bus,
    config,
    credentials,
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
  return { config, bus, manager, bridge, credentials, port, stop }
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
