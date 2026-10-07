/**
 * SseBridge HTTP 服务器（RFC §4 / P1a WS-4）—— node:http 原生，零运行时依赖。
 *
 * 路由：
 * - `GET  /events`            → SSE（Origin 白名单 + `?topics=` 过滤）
 * - `POST /api/command`       → 202 + bus.publish（Origin 白名单）
 * - `GET/PUT /api/preferences`→ dataDir JSON（Origin 白名单）
 * - `GET/PUT /api/config`      → 引导配置 `<应用根>/ost.config.json`（改数据目录的唯一入口）
 * - `GET  /api/info`           → `{ dataDir, dataDirSource, defaultDataDir, configFilePath }`
 * - `GET  /health`            → `{ ok, uptime, services: list() }`（不查 Origin）
 *  - `GET  /plugins/<id>/ui/*` → 插件 WebUI 产物（P3；停用/未构建即 404）
 *  - `GET  /plugins/<id>/data/*` → 插件用户数据（只读；停用/卸载即 404，无 SPA fallback）
 *  - `GET  /*`                 → 静态资源 / 占位 index.html
 *
 * Origin 白名单（`/events` + 全部 `/api/*`）：
 * - 无 Origin 头（curl / Node fetch / msw）→ 放行
 * - `Origin: null`（file:// / Electron 部分场景）→ 放行
 * - `http://127.0.0.1:<port>` / `http://localhost:<port>` → 放行
 * - 其余（任意其他 http(s) 源）→ 403 —— 防任意网页 CSRF 打本机 API
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { ServiceInfo } from '@osteosome/shared'
import type { Bus } from '../bus/bus'
import type { CoreConfig } from '../config'
import type { PluginRegistry } from '../service-manager/plugin-registry-runtime'
import { logger } from '../logger'
import { handleCommand } from './command'
import { handleConfig } from './config'
import { handlePlugins } from './plugins'
import { handlePluginData } from './plugin-data'
import { handlePluginUi } from './plugin-ui'
import { handlePreferences } from './preferences'
import { handleStatic } from './static'
import {
  DEFAULT_HEARTBEAT_MS,
  DEFAULT_ZOMBIE_MS,
  SseSession,
  parseTopics,
} from './sse'
import { methodNotAllowed, sendJson } from './util'

export interface SseBridgeOptions {
  bus: Bus
  config: CoreConfig
  /** 供 /health 的 `services: list()`（由 ServiceManager 注入） */
  listServices?: () => ServiceInfo[]
  /** 服务控制命令回调（由 ServiceManager 注入）：restart/stop/start 走这里，返回错误信息则视为失败 */
  controlService?: (command: 'restart' | 'stop' | 'start', serviceId: string) => Promise<string | null>
  /** 插件启停（S7-2b）：展开成服务启停由 PluginRegistry 做 */
  controlPlugin?: (
    command: 'start' | 'stop',
    pluginId: string,
  ) => Promise<{ serviceIds: string[] } | string>
  /** 心跳间隔 ms（默认 30000；测试注入小值） */
  heartbeatMs?: number
  /** 僵尸断开阈值 ms（默认 90000；测试注入小值） */
zombieMs?: number
  /** 插件层（S7-2a）：提供 `GET /api/plugins`。未装配则该路由回 404 */
  plugins?: PluginRegistry
}

export class SseBridge {
  private readonly server: Server
  private readonly sessions = new Set<SseSession>()
  private readonly startedAt = Date.now()
  private readonly heartbeatMs: number
  private readonly zombieMs: number
  private boundPort = 0

  constructor(private readonly options: SseBridgeOptions) {
    this.heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS
    this.zombieMs = options.zombieMs ?? DEFAULT_ZOMBIE_MS
    this.server = createServer((req, res) => {
      this.route(req, res).catch((err) => {
        logger.error(`sse-bridge: unhandled route error: ${String(err)}`)
        if (!res.writableEnded && !res.destroyed) {
          sendJson(res, 500, { error: 'internal error' })
        }
      })
    })
  }

  /** 当前活跃 SSE 连接数（测试用） */
  get connectionCount(): number {
    let n = 0
    for (const s of this.sessions) if (s.active) n++
    return n
  }

  /** 实际监听端口（listen 后可用；0 表示未 listen） */
  get port(): number {
    return this.boundPort
  }

  /** 启动监听；port 省略用 config.port（0 = 系统分配，测试用）。返回实际端口。 */
  listen(port?: number): Promise<number> {
    const target = port ?? this.options.config.port
    return new Promise((resolve, reject) => {
      const onError = (err: Error) => reject(err)
      this.server.once('error', onError)
      this.server.listen(target, '127.0.0.1', () => {
        this.server.removeListener('error', onError)
        const addr = this.server.address()
        this.boundPort = typeof addr === 'object' && addr !== null ? addr.port : target
        logger.info(`sse-bridge: listening on http://127.0.0.1:${this.boundPort}`)
        resolve(this.boundPort)
      })
    })
  }

  /** 关闭：断开全部 SSE 会话 + 关 HTTP 服务器（含 keep-alive 残留连接） */
  async close(): Promise<void> {
    for (const session of [...this.sessions]) session.close()
    this.sessions.clear()
    await new Promise<void>((resolve) => {
      this.server.close(() => resolve())
      // Node ≥18.2：强制关 keep-alive / 挂起连接，避免 close 永不回调
      this.server.closeAllConnections?.()
    })
  }

  // ── 路由 ────────────────────────────────────────
  private async route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${this.boundPort || this.options.config.port}`)
    const path = url.pathname

    if (path === '/events') {
      if (req.method !== 'GET') {
        methodNotAllowed(res, 'GET')
        return
      }
      if (!this.originAllowed(req)) {
        sendJson(res, 403, { error: 'origin not allowed' })
        return
      }
      this.startSse(req, res, url)
      return
    }

    if (path === '/api/command' || path === '/api/preferences' || path.startsWith('/api/')) {
      // 全部 /api/* 先过 Origin 白名单，未知路径 404
      if (!this.originAllowed(req)) {
        sendJson(res, 403, { error: 'origin not allowed' })
        return
      }
      if (path === '/api/command') {
        if (req.method !== 'POST') {
          methodNotAllowed(res, 'POST')
          return
        }
        await handleCommand(
          req,
          res,
          this.options.bus,
          this.options.controlService,
          this.options.controlPlugin,
        )
        return
      }
      if (path === '/api/preferences') {
        if (req.method !== 'GET' && req.method !== 'PUT') {
          methodNotAllowed(res, 'GET, PUT')
          return
        }
        await handlePreferences(req, res, this.options.config.dataDir)
        return
      }
      if (path === '/api/config') {
        if (req.method !== 'GET' && req.method !== 'PUT') {
          methodNotAllowed(res, 'GET, PUT')
          return
        }
        await handleConfig(req, res, this.options.config.configFilePath)
        return
      }
      if (path === '/api/plugins') {
          if (req.method !== 'GET') {
            methodNotAllowed(res, 'GET')
            return
          }
          handlePlugins(req, res, this.options.plugins)
          return
        }
        if (path === '/api/info') {
          if (req.method !== 'GET') {
            methodNotAllowed(res, 'GET')
            return
          }
          // 设置页用这几项渲染「数据目录」那一格：当前值 / 它是不是缺省 /
          // 「恢复默认」会落到哪 / 这个设置本身存在哪
          const cfg = this.options.config
          sendJson(res, 200, {
            dataDir: cfg.dataDir,
            dataDirSource: cfg.dataDirSource ?? (cfg.dataDirIsDefault ? 'default' : 'cli'),
            ...(cfg.defaultDataDir !== undefined ? { defaultDataDir: cfg.defaultDataDir } : {}),
            ...(cfg.configFilePath !== undefined ? { configFilePath: cfg.configFilePath } : {}),
          })
          return
        }
      sendJson(res, 404, { error: 'not found' })
      return
    }

    // 插件 WebUI 产物（P3）。**必须在 static.ts 之前**：static.ts 是兜底 handler，
    // 它会对任何未知路径回 index.html —— 顺序反了，插件的 404 就永远说不出口了。
    if (this.options.plugins && path.startsWith('/plugins/')) {
      // 同样过 Origin 白名单（与 /api/* 同一套判定）。
      // 注意它**不会**挡住 iframe 嵌入：iframe 与顶层导航按 Fetch 规范不带 Origin，
      // 白名单本来就放行「无 Origin」。这条真正挡住的是别处网页用 fetch
      // 去读插件界面（那个读到了也是一坨没有 CORS 头的 HTML，但没必要让人试）。
      if (!this.originAllowed(req)) {
        sendJson(res, 403, { error: 'origin not allowed' })
        return
      }
      // 插件用户数据（只读）。**必须在 handlePluginUi 之前**：
      // /plugins/<id>/data/* 与 /plugins/<id>/ui/* 同前缀，
      // 顺序反了，data 路由会被 ui 的 SPA fallback 接走。
      if (/^\/plugins\/[^/]+\/data(\/|$)/.test(path)) {
        handlePluginData(req, res, this.options.plugins, path)
        return
      }
      handlePluginUi(req, res, this.options.plugins, path)
      return
    }

    if (path === '/health') {
      if (req.method !== 'GET') {
        methodNotAllowed(res, 'GET')
        return
      }
      sendJson(res, 200, {
        ok: true,
        uptime: Date.now() - this.startedAt,
        services: this.options.listServices?.() ?? [],
      })
      return
    }

    // 静态资源（GET/HEAD；其余方法 405）
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      methodNotAllowed(res, 'GET, HEAD')
      return
    }
    handleStatic(res, this.options.config.distDir, path)
  }

  // ── Origin 白名单 ───────────────────────────────
  private originAllowed(req: IncomingMessage): boolean {
    const origin = req.headers.origin
    // 非浏览器客户端（curl / Node fetch / msw）无 Origin → 放行
    if (origin === undefined) return true
    // file:// 页面、Electron 部分场景
    if (origin === 'null') return true

    const port = this.boundPort || this.options.config.port
    const allowed = new Set([
      `http://127.0.0.1:${port}`,
      `http://localhost:${port}`,
      // 无显式端口的默认情形（少见，浏览器一般会带端口）
      ...(port === 80 ? ['http://127.0.0.1', 'http://localhost'] : []),
      ...(port === 443 ? ['https://127.0.0.1', 'https://localhost'] : []),
    ])
    return allowed.has(origin)
  }

  // ── SSE 会话 ────────────────────────────────────
  private startSse(req: IncomingMessage, res: ServerResponse, url: URL): void {
    const session = new SseSession(res, this.options.bus, {
      heartbeatMs: this.heartbeatMs,
      zombieMs: this.zombieMs,
      topics: parseTopics(url.search),
    })
    session.onClosed = () => {
      this.sessions.delete(session)
    }
    this.sessions.add(session)
    session.start(req)
  }
}
