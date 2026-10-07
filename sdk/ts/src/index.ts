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
// 注：`attachCredentialClient`（`credentials.resolve` 那一跳）已随 Core 凭证库一起退休——
// 密钥归使用方插件之后，取值是「插件读自己的文件」，不需要一个中转服务。
// 见 `docs/插件化架构优化.html` §4「凭证能力位退休」。
export { performHandshake, assertInitializeResult, type HandshakeOptions } from './handshake'
export {
  PLUGIN_READ_FILE_METHOD,
  loadPluginJson,
  readPluginFile,
  type PluginReadFileOptions,
} from './plugin-files'
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
