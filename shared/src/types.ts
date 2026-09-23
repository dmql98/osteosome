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
}