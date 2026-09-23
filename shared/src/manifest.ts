/**
 * Manifest 规范（RFC §3.2）—— 服务声明文件 service.json 的 schema 与类型。
 * 必填：id / version / protocolVersion / entry / publishes / subscribes；
 * inject / panes / healthCheck / restartPolicy / writableDirs 可缺省。
 */
import { z } from 'zod'

export const DEFAULT_HEALTH_CHECK = {
  interval: 5000,
  timeout: 2000,
} as const

export const DEFAULT_RESTART_POLICY = {
  maxRestarts: 3,
  backoff: 'exponential' as const,
}

export const ManifestSchema = z.object({
  /** 服务唯一标识，如 'hello'（services/<id>/ 目录名） */
  id: z.string().min(1),
  /** 服务版本 */
  version: z.string().min(1),
  /** 协议版本，须与 Core 兼容（shared/protocol.ts PROTOCOL_VERSION） */
  protocolVersion: z.string().min(1),
  /** 启动命令，如 'node dist/index.js'（Core 直接执行，不走 shell） */
  entry: z.string().min(1),
  /** 工作目录（缺省 = services/<id>/） */
  cwd: z.string().optional(),
  /** 依赖注入，用于拓扑排序 */
  inject: z.array(z.string()).default([]),
  /** 服务会发布的事件 topic（必须命中 shared/events.ts EventMap） */
  publishes: z.array(z.string()),
  /** 服务会订阅的 topic（事件 + 命令）—— Core 以此校验自身一致性 */
  subscribes: z.array(z.string()),
  /** 前端 Pane 注册 */
  panes: z.array(z.object({ id: z.string(), component: z.string() })).optional(),
  /** 健康检查参数（Core 读取后在 initialize 响应里回发 heartbeatInterval） */
  healthCheck: z
    .object({
      interval: z.number().int().positive(),
      timeout: z.number().int().positive(),
    })
    .optional(),
  /** 重启策略 */
  restartPolicy: z
    .object({
      maxRestarts: z.number().int().nonnegative(),
      backoff: z.enum(['exponential', 'fixed']),
    })
    .optional(),
  /**
   * 声明 `services/<id>/` 之下的额外可写子目录（声明式约定，非运行时强制；
   * 服务只写自己的目录是纪律，不是机制，P8 进程沙箱再强化为强制）。
   */
  writableDirs: z.array(z.string()).optional(),
})

export type Manifest = z.infer<typeof ManifestSchema>

export type HealthCheck = NonNullable<Manifest['healthCheck']>
export type RestartPolicy = NonNullable<Manifest['restartPolicy']>