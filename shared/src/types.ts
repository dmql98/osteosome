/** 通用领域类型（RFC §3.1 / §7.4） */

/** 服务唯一标识（services/<id>/） */
export type ServiceId = string

/** 前端 Pane 唯一标识（manifest.panes[].id） */
export type PaneId = string

/** 服务生命周期状态 */
export type ServiceStatus = 'starting' | 'ready' | 'restarting' | 'failed' | 'stopped'

/** 单个服务的对外快照（RFC §3.1 ServiceInfo） */
export interface ServiceInfo {
  id: ServiceId
  version: string
  status: ServiceStatus
  pid?: number
  startedAt?: number
  restartCount: number
  /**
   * 最近一次失败的原因（握手被拒 / 协议错误 / 重启预算耗尽等）。
   *
   * `protocolFailedReason` 在 `handleExit` 里读完即清、只进 `service.failed`
   * 事件，事件没人订阅时这个原因就丢了；`reason` 是它的持久副本，供 `/health`
   * 这类只看快照的调用方定位。转到 `ready` 后清除。
   */
  reason?: string
}