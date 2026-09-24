/**
 * 握手（RFC §6.1 / P1a WS-5）—— 服务启动时主动发 `initialize`，
 * 等 Core 响应（超时可重试），再发 `initialized` 通知。
 *
 * 响应载有 **`dataDir`**（P1a §3.1 数据目录约定）→ 挂到 `service.dataDir`。
 */
import { HANDSHAKE_TIMEOUT_MS, METHODS, PROTOCOL_VERSION, type InitializeResult } from '@osteosome/shared'
import type { RpcPeer } from './transport'
import { RpcTimeoutError } from './transport'
import { logger } from './logger'

export interface HandshakeOptions {
  serviceId: string
  version: string
  /** 服务 manifest 快照（Core 与磁盘交叉校验 publishes/subscribes） */
  manifest: Record<string, unknown>
  /** Core 版本（本 SDK 对端标识，P1a 固定占位即可） */
  coreVersion?: string
  protocolVersion?: string
  /** 单次 initialize 超时（默认 HANDSHAKE_TIMEOUT_MS） */
  timeoutMs?: number
  /** 超时后的额外重试次数（默认 2 → 共 3 次尝试） */
  retries?: number
  /** 重试间隔 ms（默认 50） */
  retryDelayMs?: number
}

const DEFAULT_RETRIES = 2
const DEFAULT_RETRY_DELAY_MS = 50

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** 校验 initialize 响应形状（fail fast） */
export function assertInitializeResult(v: unknown): asserts v is InitializeResult {
  const r = v as Partial<InitializeResult> | null | undefined
  if (
    !r ||
    typeof r !== 'object' ||
    typeof r.sessionId !== 'string' ||
    typeof r.dataDir !== 'string' ||
    typeof r.heartbeatInterval !== 'number'
  ) {
    throw new Error(`handshake: invalid InitializeResult: ${JSON.stringify(v)}`)
  }
}

/**
 * 执行握手：initialize（超时重试）→ 校验响应 → notify initialized。
 * 成功返回 {@link InitializeResult}（含 dataDir / sessionId / heartbeatInterval）。
 */
export async function performHandshake(rpc: RpcPeer, options: HandshakeOptions): Promise<InitializeResult> {
  const params = {
    protocolVersion: options.protocolVersion ?? (options.manifest.protocolVersion as string) ?? PROTOCOL_VERSION,
    serviceId: options.serviceId,
    coreVersion: options.coreVersion ?? '0.0.0',
    manifest: options.manifest,
  }
  const timeoutMs = options.timeoutMs ?? HANDSHAKE_TIMEOUT_MS
  const retries = options.retries ?? DEFAULT_RETRIES
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS
  const maxAttempts = 1 + retries

  let lastErr: unknown
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const result = await rpc.request<InitializeResult>(METHODS.initialize, params, timeoutMs)
      assertInitializeResult(result)
      // initialized 由 Service.start 在本地订阅补发完成后发送，确保 Core 不会先于
      // bus.subscribe 宣告 ready，避免启动窗口内首条命令丢失。
      logger.debug(
        `handshake: ok sessionId=${result.sessionId} dataDir=${result.dataDir} heartbeat=${result.heartbeatInterval}ms (attempt ${attempt})`,
      )
      return result
    } catch (err) {
      lastErr = err
      const retryable = err instanceof RpcTimeoutError
      logger.warn(
        `handshake: attempt ${attempt}/${maxAttempts} failed${retryable ? ' (timeout)' : ''}: ${String(err)}`,
      )
      if (attempt < maxAttempts && retryable) {
        await sleep(retryDelayMs)
        continue
      }
      break
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
}
