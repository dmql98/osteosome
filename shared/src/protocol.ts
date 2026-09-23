/**
 * JSON-RPC 协议版本与方法集（RFC §3.5 / §6.1）。
 * 方法集「只增不改」—— P4 追加 credentials.* 时直接加常量，不改既有。
 */
export const PROTOCOL_VERSION = '1.0.0'

/** 握手超时默认值 */
export const HANDSHAKE_TIMEOUT_MS = 5000

export const METHODS = {
  initialize: 'initialize',
  initialized: 'initialized',
  /** 服务 → Core：发布事件到总线 */
  'bus.publish': 'bus.publish',
  /** 服务 → Core：订阅 topic */
  'bus.subscribe': 'bus.subscribe',
  /** 服务 → Core：取消订阅 */
  'bus.unsubscribe': 'bus.unsubscribe',
  /** Core → 服务：推送订阅的事件 */
  'bus.event': 'bus.event',
  /** Core → 服务：心跳探测 */
  'health.ping': 'health.ping',
  /** 服务 → Core：心跳应答 */
  'health.pong': 'health.pong',
  /** 双向：请求退出 */
  shutdown: 'shutdown',
  /** Core → 服务：对 shutdown 的收尾应答 */
  exit: 'exit',
} as const

/** initialize 请求参数（服务 → Core） */
export interface InitializeParams {
  protocolVersion: string
  serviceId: string
  coreVersion: string
  /** 服务自身声明的 manifest 快照，Core 与磁盘 manifest 交叉校验 */
  manifest: Record<string, unknown>
}

/** Core → 服务 initialize 响应（P1a §3.1 数据目录约定） */
export interface InitializeResult {
  sessionId: string
  /** Core 读 manifest.healthCheck.interval 回发，服务接受 Core 权威 */
  heartbeatInterval: number
  /** 数据根目录（--data 传入）；服务只写 serviceDataDir(dataDir, serviceId)/ */
  dataDir: string
}

/** 服务 → Core bus.publish 请求参数 */
export interface BusPublishParams {
  topic: string
  payload: Record<string, unknown>
}

/** 服务 → Core bus.subscribe / 取消 请求参数 */
export interface BusSubscribeParams {
  topic: string
}

/** Core → 服务 bus.event 推送参数 */
export interface BusEventParams {
  topic: string
  payload: Record<string, unknown>
}

/** service.handler-error：服务端 handler 抛错上报（RFC §6.5） */
export const SERVICE_HANDLER_ERROR = 'service.handler-error'

/** JSON-RPC 信封结构 */
export interface JsonRpcRequest {
  jsonrpc: '2.0'
  id?: number | string
  method: string
  params?: unknown
}

export interface JsonRpcResponse {
  jsonrpc: '2.0'
  id: number | string
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}