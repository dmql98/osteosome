/**
 * 交付物守卫（P8）——「装配出来的目录，Core 到底认不认」。
 *
 * ## 为什么不直接测 pack-plugin.mjs 的内部函数
 *
 * 那样测的是「它有没有做到它自己说的事」。真正要守的是另一件事：
 * **拷到别人机器上之后，Core 还装得上吗**。所以这里的做法是 ——
 * 跑一次装配，把 `pack/` 当成 `pluginsDir` 交给 Core 自己的 `scanPlugins`，
 * 用对方的校验器验我们的产物。规则只有一份，在 `plugin-registry.ts` 里；
 * pack 脚本那边的 preflight 只是给人看的即时报错，不构成第二份真理。
 *
 * ## 两个真实翻过车的地方（都由下面的断言守住）
 *
 * 1. **`dist/` 被排在了要拷的目录之外** —— preflight 全绿、输出里一个产物都没有。
 *    「装配后没再验一次输出」是这类 bug 的成因，所以这里验的是输出。
 * 2. **运行期数据 `.data/` 混了进去** —— chat-workbench 的交付物曾有 234 个
 *    会话文件（session 服务在 dataDir 为空时回退到相对路径 `.data`，
 *    落在了 build 目录里）。`.gitignore` 挡得住提交，挡不住拷贝。
 *
 * 前提：跑过 build。没构建时这里会红 —— 与 `service-distribution.test.ts` 同纪律。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadServicesFrom } from '../src/service-manager/manifest'
import { scanPlugins } from '../src/service-manager/plugin-registry'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const PACK_DIR = path.join(REPO_ROOT, 'pack')

const cleanups: string[] = []
afterAll(() => {
  for (const d of cleanups) rmSync(d, { recursive: true, force: true })
})

function walk(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(p))
    else out.push(p)
  }
  return out
}

function packedIds(): string[] {
  if (!existsSync(PACK_DIR)) return []
  return readdirSync(PACK_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
}

/** 把 `pack/` 复制成一个临时 `pluginsDir` —— 每个用例独立，互不污染 */
function makePluginsCopy(): string {
  const tmp = mkdtempSync(path.join(tmpdir(), 'ost-pack-scan-'))
  cleanups.push(tmp)
  const pluginsDir = path.join(tmp, 'plugins')
  cpSync(PACK_DIR, pluginsDir, { recursive: true })
  return pluginsDir
}

/**
 * 按 Core 真实的接线方式算「已知服务 id」：
 * `PluginRegistry.serviceDirs()` → `loadServicesFrom(dirs)`。
 * 只有产物齐全的服务才进得来 —— 正是这条让「少了一份产物」能被报出来。
 * 自己拼一个集合等于替被测系统把答案准备好。
 */
function knownServiceIds(pluginsDir: string): Set<string> {
  const roots = readdirSync(pluginsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => path.join(pluginsDir, e.name, 'dist', 'server'))
    .filter((p) => existsSync(p))
  return new Set(loadServicesFrom(roots).map((s) => s.manifest.id))
}

beforeAll(() => {
  const r = spawnSync(process.execPath, [path.join(REPO_ROOT, 'scripts', 'pack-plugin.mjs')], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  })
  if (r.status !== 0) {
    throw new Error(`装配失败（status=${r.status}）\n${r.stdout}\n${r.stderr}`)
  }
}, 180_000)

describe('插件可分发（P8）', () => {
  it('七个插件都装配出来了（凭证退休后 4 个，P5/P6/P7 加 agents/skills/tools 成 7 个）', () => {
    expect(packedIds().sort()).toEqual([
      'agents',
      'chat-workbench',
      'models',
      'reliability',
      'skills',
      'tools',
      'workbench',
    ])
  })

  it('交付物里只有清单、自带数据与产物 —— 源码与构建配置一律不进', () => {
    const forbidden = new Set(['services', 'ui', 'node_modules', 'package.json', 'pnpm-lock.yaml'])
    for (const id of packedIds()) {
      const root = path.join(PACK_DIR, id)
      // 插件根下：不许出现源码目录与包管理器元数据
      for (const entry of readdirSync(root)) {
        expect(forbidden.has(entry), `${id}/ 不该有 ${entry}`).toBe(false)
        expect(/^tsconfig(\..+)?\.json$/.test(entry), `${id}/ 不该有 ${entry}`).toBe(false)
      }
      // 全树：不许出现任何源码文件
      for (const file of walk(root)) {
        const rel = path.relative(root, file)
        expect(/\.(ts|mts|cts|vue)$/.test(file), `${id}/${rel} 是源码`).toBe(false)
      }
      expect(existsSync(path.join(root, 'plugin.json')), `${id}/plugin.json`).toBe(true)
    }
  })

  it('不带运行期数据（.data）与 sourcemap（*.map）', () => {
    for (const id of packedIds()) {
      for (const file of walk(path.join(PACK_DIR, id))) {
        const rel = path.relative(PACK_DIR, file)
        expect(file.split(path.sep).includes('.data'), `${rel} 是运行期数据，不该被发出`).toBe(false)
        expect(file.endsWith('.map'), `${rel} 是 sourcemap，不该被发出`).toBe(false)
      }
    }
  })

  it('声明的每个服务，产物齐全且 entry 指向同目录的 index.js', () => {
    for (const id of packedIds()) {
      const manifest = JSON.parse(readFileSync(path.join(PACK_DIR, id, 'plugin.json'), 'utf8')) as {
        services: string[]
      }
      for (const sid of manifest.services) {
        const dir = path.join(PACK_DIR, id, 'dist', 'server', sid)
        expect(existsSync(path.join(dir, 'index.js')), `${id}/${sid} 缺 index.js`).toBe(true)
        const sm = JSON.parse(readFileSync(path.join(dir, 'service.json'), 'utf8')) as {
          id: string
          entry: string
        }
        expect(sm.id, `${id}/${sid} 的 service.json.id`).toBe(sid)
        expect(sm.entry, `${id}/${sid} 的 entry`).toBe('node index.js')
      }
    }
  })

  it('声明的每个 UI 视图，entry 文件都在', () => {
    for (const id of packedIds()) {
      const manifest = JSON.parse(readFileSync(path.join(PACK_DIR, id, 'plugin.json'), 'utf8')) as {
        ui?: { views: Array<{ id: string; entry: string }> }
      }
      for (const view of manifest.ui?.views ?? []) {
        const file = view.entry.split('#')[0] ?? view.entry
        expect(
          existsSync(path.join(PACK_DIR, id, 'dist', 'ui', file)),
          `${id} 的视图 ${view.id}（${view.entry}）缺文件`,
        ).toBe(true)
      }
    }
  })

  /**
   * 全篇最重要的一条：**Core 自己认不认**。
   *
   * 把 `pack/` 当 pluginsDir 扫一遍，并按 Core 真实的接线方式传
   * `knownServiceIds`（`loadServicesFrom(serviceDirs())` —— 只有产物齐全的服务才会被加载）。
   *
   * 这一步曾会对每个服务报「services 在插件内没有对应目录」：源码侧的检查
   * 没有区分「开发仓」与「发行版」，而交付物本来就不带 `services/`。
   * 装好了却报错，比装坏了更难查 —— 因为没人会去查一个正常的东西。
   */
  it('把 pack/ 当 pluginsDir 扫一遍，Core 不报任何问题', () => {
    const pluginsDir = makePluginsCopy()
    const scan = scanPlugins(pluginsDir, knownServiceIds(pluginsDir))

    expect(scan.status).toBe('ok')
    expect(scan.plugins.map((p) => p.manifest.id).sort()).toEqual(packedIds().sort())
    expect(scan.problems, JSON.stringify(scan.problems, null, 2)).toEqual([])
    expect(scan.cycles).toEqual([])
  })

  /**
   * 反向：真的少了一份产物，必须报出来。
   *
   * 上一条断言「干净时不报错」，若没有这条，把检查整个删掉也能通过 ——
   * 那样「说清哪里坏了」就只剩一份没人再看的代码。
   * 这里删掉 `chat-workbench/dist/server/llm/`（整个服务目录），期望
   * `knownServiceIds` 里没有它 → 「services 指向不存在的服务」。
   */
  it('真的少了一份服务产物，Core 要说出来', () => {
    const pluginsDir = makePluginsCopy()
    rmSync(path.join(pluginsDir, 'chat-workbench', 'dist', 'server', 'llm'), {
      recursive: true,
      force: true,
    })

    const scan = scanPlugins(pluginsDir, knownServiceIds(pluginsDir))
    const reasons = scan.problems.map((p) => p.reason).join('\n')

    expect(reasons, reasons).toContain('llm')
    expect(reasons, reasons).toMatch(/不存在的服务|未构建/)
  })

  it('服务产物的 entry 都是单文件，装配后仍无外部依赖（拷走就能跑的前提）', () => {
    for (const id of packedIds()) {
      const dir = path.join(PACK_DIR, id, 'dist', 'server')
      if (!existsSync(dir)) continue
      for (const sid of readdirSync(dir)) {
        const code = readFileSync(path.join(dir, sid, 'index.js'), 'utf8')
        // 不做静态扫描断言「零 require」—— 那是 service-distribution.test.ts 的活
        // （它真的把产物拷到空目录起一次进程）。这里只保证文件是可读的 JS。
        expect(code.length, `${id}/${sid} 的 index.js 是空的`).toBeGreaterThan(0)
      }
    }
  })
})
