/**
 * Core 侧 JSON-RPC 协议（RFC §3.5）。
 * 方法集 / 版本常量来自 shared（单一真相源），此处补充 Core 侧应答构造与校验。
 */
import {
  HANDSHAKE_TIMEOUT_MS,
  METHODS,
  PROTOCOL_VERSION,
  SERVICE_HANDLER_ERROR,
  type InitializeResult,
} from '@osteosome/shared'

export { HANDSHAKE_TIMEOUT_MS, METHODS, PROTOCOL_VERSION, SERVICE_HANDLER_ERROR }

export type {
  BusEventParams,
  BusPublishParams,
  BusSubscribeParams,
  InitializeParams,
  JsonRpcRequest,
  JsonRpcResponse,
} from '@osteosome/shared'

/** 构造 Core → 服务的 initialize 响应（RFC §6.1 / P1a §3.1 数据目录约定） */
export function createInitializeResult(info: {
  sessionId: string
  heartbeatInterval: number
  dataDir: string
}): InitializeResult {
  return {
    sessionId: info.sessionId,
    heartbeatInterval: info.heartbeatInterval,
    dataDir: info.dataDir,
  }
}

/** JSON-RPC 错误（响应 object） */
export interface JsonRpcError {
  code: number
  message: string
  data?: unknown
}

/** 构造 JSON-RPC 错误对象 */
export function jsonRpcError(code: number, message: string, data?: unknown): JsonRpcError {
  return { code, message, ...(data === undefined ? {} : { data }) }
}