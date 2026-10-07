/**
 * 分发前提的守卫（P2）—— 「拷出去能不能跑」。
 *
 * ## 这条测试存在的理由
 *
 * 服务构建从 `tsc` 换成 esbuild bundle 是为了**产物脱离本仓库仍可运行**。
 * 这个性质极易被无声破坏：哪天有人在 build 脚本里加一个 `external`，
 * 或者某个依赖改成了动态 `require`，产出会安静地退化成「在仓库里能跑、拷出去不能跑」——
 * CI 全绿，用户装上才发现。
 *
 * 所以这里**真的把它拷到一个空目录去跑一次**：不发消息，只验证它能起来并完成握手。
 */
import { describe, expect, it, afterAll } from 'vitest'
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

// 本文件在 core/tests/ → 上两级是仓库根
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const PLUGINS_DIR = path.join(REPO_ROOT, 'plugins')

/** 每个插件声明的服务 → 它在 dist/server 下的产物目录（构建跑过一次才存在） */
function builtServices(): Array<{ plugin: string; service: string; dir: string }> {
  const out: Array<{ plugin: string; service: string; dir: string }> = []
  for (const plugin of readdirSync(PLUGINS_DIR, { withFileTypes: true })) {
    if (!plugin.isDirectory()) continue
    const distRoot = path.join(PLUGINS_DIR, plugin.name, 'dist', 'server')
    if (!existsSync(distRoot)) continue
    for (const service of readdirSync(distRoot, { withFileTypes: true })) {
      const dir = path.join(distRoot, service.name)
      if (service.isDirectory() && existsSync(path.join(dir, 'index.js'))) {
        out.push({ plugin: plugin.name, service: service.name, dir })
      }
    }
  }
  return out
}

const cleanups: string[] = []
afterAll(() => {
  for (const d of cleanups) rmSync(d, { recursive: true, force: true })
})

describe('服务产物可分发（P2）', () => {
  const services = builtServices()

  it('构建跑过：每个插件的服务都有 dist 产物（没跑 build 时这条先红）', () => {
    // 凭证能力位退休后服务数 6 -> 5（models 的 provider 自己解析密钥，不再有中转服务）
    expect(services.length).toBeGreaterThanOrEqual(5)
    for (const s of services) {
      expect(existsSync(path.join(s.dir, 'index.js')), `${s.plugin}/${s.service} 缺 index.js`).toBe(true)
      expect(existsSync(path.join(s.dir, 'service.json')), `${s.plugin}/${s.service} 缺 service.json`).toBe(true)
    }
  })

  it('产物里的 service.json 的 entry 指向同目录（不再是 ../.. 相对源码的 dist）', () => {
    for (const s of services) {
      const m = JSON.parse(readFileSync(path.join(s.dir, 'service.json'), 'utf8')) as {
        entry: string
        id: string
      }
      expect(m.entry, `${s.service} 的 entry`).toBe('node index.js')
      expect(m.id).toBe(s.service)
    }
  })

  it('产物里没有任何非 Node 内置的 require —— 这就是「拷走就能跑」的全部含义', () => {
    for (const s of services) {
      const code = readFileSync(path.join(s.dir, 'index.js'), 'utf8')
      const requires = [...code.matchAll(/require\(["']([^"']+)["']\)/g)].map((m) => m[1]!)
      const external = requires.filter((r) => !r.startsWith('node:') && r !== 'node:util')
      expect(external, `${s.service} 的产物里有外部依赖：${external.join(', ')}`).toEqual([])
    }
  })

  it('拷到空目录（无 node_modules）后仍能启动并发出 initialize —— 分发链路的端到端证明', async () => {
    for (const s of services) {
      const tmp = mkdtempSync(path.join(tmpdir(), `ost-dist-${s.service}-`))
      cleanups.push(tmp)
      // 只拷产物本身：没有 node_modules、没有 workspace、没有任何东西可借
      cpSync(s.dir, tmp, { recursive: true })

      // 用 spawn 而不是 fork：服务之间是纯 stdio JSON-RPC，**不需要 IPC 通道**
// （fork 强制要求，于是这里会变成一个与被测物无关的启动失败）。
// stdio 的 stdin 必须留着 —— 服务在等 Core 的 initialize 响应才继续。
const child = spawn(process.execPath, [path.join(tmp, 'index.js')], {
        cwd: tmp,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      const line = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => {
          child.kill()
          reject(new Error(`${s.service}: 拷走后没发出 initialize（stdout: ${out.slice(0, 200)} / err: ${err.slice(0, 200)}）`))
        }, 8000)
        let out = ''
        let err = ''
        child.stderr?.on('data', (c: Buffer) => {
          err += String(c)
        })
        child.stdout?.on('data', (c: Buffer) => {
          out += String(c)
          const jsonLine = out.split('\n').find((l) => l.includes('"initialize"'))
          if (jsonLine) {
            clearTimeout(timer)
            resolve(jsonLine)
          }
        })
        child.on('error', (e) => {
          clearTimeout(timer)
          reject(e)
        })
      })
      child.kill()
      const req = JSON.parse(line) as { method: string; params: { serviceId: string; coreVersion: string } }
      expect(req.method).toBe('initialize')
      expect(req.params.serviceId).toBe(s.service)
    }
  })
})
