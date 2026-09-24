/**
 * 心跳（RFC §3.7 / P1a WS-5）—— 收到 Core 的 `health.ping` 自动回 `health.pong`。
 * 挂在 {@link RpcPeer} 通知链上，返回 disposer 可摘除。
 */
import { METHODS } from '@osteosome/shared'
import type { RpcPeer } from './transport'
import { logger } from './logger'

/** 订阅 ping → 自动 pong；返回 disposer */
export function attachHeartbeat(rpc: RpcPeer): () => void {
  return rpc.onNotification((method) => {
    if (method === METHODS['health.ping']) {
      rpc.notify(METHODS['health.pong'])
      logger.debug('heartbeat: health.pong')
    }
  })
}
