import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { Bus } from '../src/bus/bus'
import { ServiceManager } from '../src/service-manager/manager'

/**
 * P3：`plugins.readFile` —— 服务只读地读**自己插件目录**里的文件。
 *
 * 这个 RPC 存在的理由：服务被打成单文件（没有 `require` 能解析到 `../../catalog.json`），
 * 但插件需要带自己的静态数据（models 的 12 家预设就是 `catalog.json`）。
 * 于是「能读自己插件目录」必须由 Core 授予 —— 于是**边界就是本测试的全部内容**：
 * 能读自己的、读不到别人的、越不出自己的目录。功能只是边界的一个副作用。
 *
 * 测试用真实子进程（fixtures/fake-service.mjs + FAKE_REQUEST_METHOD），
 * 走完整的 stdio JSON-RPC，而不是直接调私有方法 —— 否则测的就不是
 * 「Core 真的应答了一个特权请求」，而是「一个函数返回了我预期的值」。
 */
const SERVICE_ID = 'svc'
// 复用 hello.command.started：manifest 校验要求 publishes 的 topic 必须在 shared EventMap 里声明过,
// 借一个已声明的 topic 承载报告（payload 类型运行时不强校验）。
const REPORT_TOPIC = 'hello.command.started'
const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-service.mjs')
const PUBLISHES = [REPORT_TOPIC]

let root: string
let serviceDir: string
let pluginDir: string
let otherPluginDir: string

/**
 * 每个用例都要 spawn 一个真实 node 子进程（冷启动 + 握手），默认 5s 超时在机器
 * 一忙就变红 —— 而这类红是**假红**，比不测更坏。所以逐个放宽，别依赖全局配置。
 */
const t = (name: string, fn: () => Promise<void>) => test(name, fn, 20000)

interface Report {
  result: { content?: string } | null
  error: { code?: number; message?: string } | null
}

/**
 * 起一个真实服务进程，让它发一次 `plugins.readFile`，返回 Core 的应答。
 *
 * `servicePluginDirs` 为 null 时**完全不传**该选项 —— 因为「没配表」与
 * 「配了表但不含这个服务」必须走同一条拒绝路径（fail closed）。
 */
async function readFile(
  params: unknown,
  opts: { pluginDirs?: Map<string, string> | null } = {},
): Promise<Report> {
  process.env.FAKE_SERVICE_ID = SERVICE_ID
  process.env.FAKE_MANIFEST = JSON.stringify({ publishes: PUBLISHES, subscribes: [], version: '1.0.0' })
  process.env.FAKE_REQUEST_METHOD = 'plugins.readFile'
  process.env.FAKE_REQUEST_PARAMS = JSON.stringify(params ?? null)
  process.env.FAKE_REQUEST_REPORT_TOPIC = REPORT_TOPIC

  const bus = new Bus()
  const report = new Promise<Report>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('service never reported')), 8000)
    bus.subscribe(REPORT_TOPIC, (payload) => {
      clearTimeout(timer)
      resolve(payload as unknown as Report)
    })
  })

  const manager = new ServiceManager({
    serviceDirs: [root],
    dataDir: path.join(root, 'data'),
    sessionId: 'test-session',
    bus,
    handshakeTimeoutMs: 5000,
    stopGraceMs: 500,
    maxRestarts: 0,
    backoffBaseMs: 50,
    ...(opts.pluginDirs === null ? {} : { servicePluginDirs: opts.pluginDirs ?? new Map([[SERVICE_ID, pluginDir]]) }),
  })

  try {
    await manager.start()
    return await report
  } finally {
    // start() 也要在 try 里：这个测试**会**故意让 manager 起不来（manifest 校验失败等），
    // 那种情况下一旦没走到 stop，node 子进程会活过测试文件 —— 然后既占 CPU 又锁住临时目录，
    // 表现为后面毫不相干的测试莫名超时。这类「泄漏」很难归因，宁可在这里啰嗦一点。
    await manager.stop().catch(() => undefined)
  }
}

/** 从应答里取错误消息；期望成功时会因为 message 是 undefined 而失败 */
function expectError(report: Report): string {
  expect(report.result).toBeNull()
  expect(report.error).not.toBeNull()
  return report.error?.message ?? ''
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'ost-readfile-'))
  serviceDir = path.join(root, SERVICE_ID)
  mkdirSync(serviceDir, { recursive: true })
  writeFileSync(
    path.join(serviceDir, 'service.json'),
    JSON.stringify({
      id: SERVICE_ID,
      version: '1.0.0',
      protocolVersion: '1.0.0',
      entry: 'node service.mjs',
      inject: [],
      publishes: PUBLISHES,
      subscribes: [],
    }),
  )
  copyFileSync(FIXTURE, path.join(serviceDir, 'service.mjs'))

  pluginDir = path.join(root, 'plugins', 'models')
  mkdirSync(path.join(pluginDir, 'dist', 'server', SERVICE_ID), { recursive: true })
  writeFileSync(path.join(pluginDir, 'catalog.json'), JSON.stringify({ vendors: [{ id: 'openai' }] }))
  writeFileSync(path.join(pluginDir, 'dist', 'server', SERVICE_ID, 'index.js'), '// built\n')

  otherPluginDir = path.join(root, 'plugins', 'credentials')
  mkdirSync(otherPluginDir, { recursive: true })
  writeFileSync(path.join(otherPluginDir, 'secrets.json'), '{"token":"do-not-read"}')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  delete process.env.FAKE_REQUEST_METHOD
  delete process.env.FAKE_REQUEST_PARAMS
  delete process.env.FAKE_REQUEST_REPORT_TOPIC
})

// 每个用例都要 spawn 一个真实 node 子进程（冷启动 + 握手），800ms 的默认超时不够。
const SLOW = { testTimeout: 20000 }

describe('plugins.readFile · 能读到的', () => {
  t('自己插件根下的文件', async () => {
    const report = await readFile({ path: 'catalog.json' })
    expect(report.error).toBeNull()
    expect(JSON.parse(report.result?.content ?? '')).toEqual({ vendors: [{ id: 'openai' }] })
  })

  t('子目录下的文件（dist/ 也在范围内）', async () => {
    const report = await readFile({ path: 'dist/server/svc/index.js' })
    expect(report.error).toBeNull()
    expect(report.result?.content).toContain('// built')
  })

  t('前导斜杠等价（服务作者不必知道 Core 的路径基准）', async () => {
    const report = await readFile({ path: '/catalog.json' })
    expect(report.error).toBeNull()
    expect(report.result?.content).toContain('openai')
  })

  t('UTF-8 内容原样返回', async () => {
    writeFileSync(path.join(pluginDir, 'note.txt'), '插件自带说明\n第二行\n', 'utf8')
    const report = await readFile({ path: 'note.txt' })
    expect(report.result?.content).toBe('插件自带说明\n第二行\n')
  })
})

describe('plugins.readFile · 越界的必须拒绝', () => {
  t('爬出插件目录 → 拒绝', async () => {
    expect(expectError(await readFile({ path: '../credentials/secrets.json' }))).toContain(
      'outside plugin directory',
    )
  })

  t('读别的插件的文件 → 同一个拒绝（跨插件在结构上不可能）', async () => {
    const report = await readFile({ path: path.join(otherPluginDir, 'secrets.json') })
    expect(expectError(report)).toContain('outside plugin directory')
  })

  t('绝对路径逃逸 → 拒绝', async () => {
    expect(expectError(await readFile({ path: otherPluginDir }))).toContain(
      'outside plugin directory',
    )
  })

  t('node_modules 不可读（那是仓库布局，不是插件内容）', async () => {
    mkdirSync(path.join(pluginDir, 'node_modules', 'zod'), { recursive: true })
    writeFileSync(path.join(pluginDir, 'node_modules', 'zod', 'index.js'), '// big')
    expect(expectError(await readFile({ path: 'node_modules/zod/index.js' }))).toContain(
      'node_modules',
    )
  })

  t('目录不是文件 → 拒绝', async () => {
    expect(expectError(await readFile({ path: 'dist' }))).toContain('not a file')
  })

  t('不存在的文件 → 明确 not found（不是空字符串，那会被当成「空文件」）', async () => {
    expect(expectError(await readFile({ path: 'nope.json' }))).toContain('not found')
  })

  t('超上限的文件 → 拒绝（别把 RPC 当通用文件通道）', async () => {
    writeFileSync(path.join(pluginDir, 'huge.bin'), Buffer.alloc(2 * 1024 * 1024 + 1, 0x61))
    expect(expectError(await readFile({ path: 'huge.bin' }))).toContain('too large')
  })

  t('缺少 path → 参数错误', async () => {
    expect(expectError(await readFile({}))).toContain('path required')
  })
})

describe('plugins.readFile · 没有插件目录就拒绝（fail closed）', () => {
  t('表里没有这个服务 → no plugin directory', async () => {
    expect(expectError(await readFile({ path: 'catalog.json' }, { pluginDirs: null }))).toContain(
      'no plugin directory',
    )
  })

  t('表里有别的服务、没有它 → 同一个拒绝', async () => {
    const report = await readFile(
      { path: 'catalog.json' },
      { pluginDirs: new Map([['another-service', pluginDir]]) },
    )
    expect(expectError(report)).toContain('no plugin directory')
  })
})