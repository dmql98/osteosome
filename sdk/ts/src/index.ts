/**
 * @osteosome/service-sdk —— TS 服务 SDK（RFC §6.3 / P1a WS-5）。
 *
 * 服务入口：
 * ```ts
 * import { Service } from '@osteosome/service-sdk'
 * const service = new Service({ id: 'hello', version: '1.0.0' })
 * await service.start()
 * service.subscribe('hello.command', (payload, topic) => { ... })
 * service.publish('hello.command.started', { ... })
 * ```
 */
export { Service, type ServiceOptions, type ServiceHandler } from './service'
export { performHandshake, assertInitializeResult, type HandshakeOptions } from './handshake'
export { attachHeartbeat } from './heartbeat'
export {
  StreamTransport,
  FrameDecoder,
  FramingError,
  RpcPeer,
  RpcTimeoutError,
  encodeFrame,
  createStdioTransport,
  DEFAULT_MAX_MESSAGE_BYTES,
  MAX_HEADER_BYTES,
  type Transport,
  type FramingErrorCode,
  type JsonRpcMessage,
} from './transport'
export { logger, type LogLevel } from './logger'
