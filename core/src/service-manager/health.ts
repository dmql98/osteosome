/**
 * 健康检查（RFC §3.7 / WS-3）—— interval 发 ping，超时判失败；连续失败 N 次 → 重启。
 * 重启调度（backoff / maxRestarts / 事件发布）归 manager，本模块只报告 up/down。
 *
 * 用法（测试注入 fake timers）：
 * ```ts
 * const health = new HealthMonitor({ ping, confirmPong, onDown, onUp }, { interval, timeout })
 * health.start()
 * ```
 */
import { logger } from '../logger'

export interface HealthMonitorDeps {
  /** 发一次 health.ping（通知方向，Core → 服务） */
  ping: () => void
  /** 判定为失败（心跳超时） */
  onDown: (reason: string) => void
  /** 判定为恢复 */
  onUp: () => void
}

export interface HealthMonitorOptions {
  /** ping 间隔（ms），来自 manifest.healthCheck.interval */
  interval: number
  /** ping 超时（ms），来自 manifest.healthCheck.timeout */
  timeout: number
}

export class HealthMonitor {
  private intervalTimer: NodeJS.Timeout | null = null
  private timeoutTimer: NodeJS.Timeout | null = null
  private stopped = false
  private lastDown = false

  constructor(
    private readonly deps: HealthMonitorDeps,
    private readonly options: HealthMonitorOptions,
  ) {}

  start(): void {
    this.stopped = false
    this.intervalTimer = setInterval(() => this.tick(), this.options.interval)
    this.intervalTimer.unref?.()
  }

  stop(): void {
    this.stopped = true
    this.clearTimers()
  }

  /** 服务已恢复（pong 确认） */
  private tick(): void {
    if (this.stopped) return
    this.deps.ping()
    this.timeoutTimer = setTimeout(() => {
      if (this.stopped) return
      // 仍未收到 pong → 判定失败
      this.lastDown = true
      this.deps.onDown(`heartbeat timeout after ${this.options.timeout}ms`)
    }, this.options.timeout)
    this.timeoutTimer.unref?.()
  }

  /** 由 client.onNotification('health.pong') 调用 */
  confirm(): void {
    if (this.stopped) return
    if (this.timeoutTimer) {
      clearTimeout(this.timeoutTimer)
      this.timeoutTimer = null
      if (this.lastDown) {
        this.lastDown = false
        this.deps.onUp()
      }
    }
  }

  private clearTimers(): void {
    if (this.intervalTimer) {
      clearInterval(this.intervalTimer)
      this.intervalTimer = null
    }
    if (this.timeoutTimer) {
      clearTimeout(this.timeoutTimer)
      this.timeoutTimer = null
    }
  }
}