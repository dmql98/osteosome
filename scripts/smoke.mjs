/**
 * 端到端冒烟（手动跑，非测试套件）：真 `core/dist/main.js` 子进程 + 真 `services/`。
 *
 * 验的是 Core 的三件事，载体是真实服务 `session`（S2 起替换掉示例服务 hello）：
 *   1. 进程拉起 → /health 汇报 ready
 *   2. 命令往返：POST /api/command(session.create) → SSE 收到 session.create.result + 领域事件
 *   3. 被 kill 后自动重启（pid 变、restartCount ≥ 1），重启后命令仍可用
 *
 * 跑法：pnpm -r run build && node scripts/smoke.mjs
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const WATCHDOG_MS = 90_000

/** 载体服务：真业务服务 id（命令往返 + 进程运维都拿它当靶子） */
const VEHICLE = 'session'

const REQUIRED_ARTIFACTS = [
  path.join(REPO_ROOT, 'core', 'dist', 'main.js'),
  path.join(REPO_ROOT, 'shared', 'dist', 'index.js'),
  path.join(REPO_ROOT, 'sdk', 'ts', 'dist', 'index.js'),
  // P2：服务产物在**插件**的 dist/server 下（Core 只认产物），不再在服务自己的 dist/
  path.join(REPO_ROOT, 'plugins', 'chat-workbench', 'dist', 'server', 'session', 'index.js'),
]

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function log(msg) {
  console.log(`[smoke] ${msg}`)
}

function parseEvents(text) {
  const out = []
  for (const line of text.split('\n')) {
    if (!line.startsWith('data: ')) continue
    try {
      const parsed = JSON.parse(line.slice(6))
      if (parsed && typeof parsed.topic === 'string' && parsed.payload && typeof parsed.payload === 'object') {
        out.push(parsed)
      }
    } catch {
      /* partial frame */
    }
  }
  return out
}

async function getHealth(base) {
  try {
    const res = await fetch(`${base}/health`)
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  }
}

function findVehicle(health) {
  if (!health || !Array.isArray(health.services)) return null
  return health.services.find((s) => s.id === VEHICLE) ?? null
}

async function waitFor(fn, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await fn()
    if (value) return value
    if (Date.now() >= deadline) throw new Error(`${label}: timed out after ${timeoutMs}ms`)
    await sleep(120)
  }
}

function killPid(pid) {
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    return
  }
  try {
    process.kill(pid, 'SIGKILL')
  } catch {
    /* already gone */
  }
}

async function openSse(base) {
  const controller = new AbortController()
  // `session.**` 而非 `session.*`：命令回执是两层（session.create.result），
  // 单层通配只吃得到 session.create / session.created，回执永远等不到
  const res = await fetch(`${base}/events?topics=session.**`, { signal: controller.signal })
  if (res.status !== 200) throw new Error(`sse open failed: status=${res.status}`)
  let buf = ''
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  void (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
      }
    } catch {
      /* aborted */
    }
  })()
  return {
    text: () => buf,
    close: () => controller.abort(),
  }
}

/** 命令往返：POST /api/command → 等 SSE 出现该 requestId 的 `session.create.result` */
async function postUntilResult(base, sse, requestId, title, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let lastStatus = 0
  while (Date.now() < deadline) {
    const res = await fetch(`${base}/api/command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic: 'session.create', payload: { requestId, title } }),
    })
    lastStatus = res.status
    await res.text().catch(() => '')
    await sleep(250)
    const events = parseEvents(sse.text())
    const hit = events.find(
      (e) => e.topic === 'session.create.result' && e.payload.requestId === requestId,
    )
    if (hit) return events
  }
  throw new Error(
    `command '${requestId}' no result in ${timeoutMs}ms (lastStatus=${lastStatus}); sse=${JSON.stringify(sse.text().slice(0, 800))}`,
  )
}

let coreProc = null
let coreExited = null
let vehiclePid = null
let dataDir = null
let sse = null

async function cleanup() {
  if (sse) {
    try {
      sse.close()
    } catch {
      /* ignore */
    }
    sse = null
  }
  if (vehiclePid != null) {
    killPid(vehiclePid)
    vehiclePid = null
  }
  if (coreProc && coreProc.exitCode === null) {
    const pid = coreProc.pid
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    } else {
      try {
        process.kill(pid, 'SIGTERM')
      } catch {
        /* ignore */
      }
      await sleep(1500)
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        /* ignore */
      }
    }
  }
  coreProc = null
  if (dataDir) {
    rmSync(dataDir, { recursive: true, force: true })
    dataDir = null
  }
}

async function main() {
  const missing = REQUIRED_ARTIFACTS.filter((f) => !existsSync(f))
  if (missing.length > 0) {
    throw new Error(`missing build artifacts:\n  ${missing.join('\n  ')}\nrun: pnpm -r run build`)
  }

  dataDir = mkdtempSync(path.join(tmpdir(), 'ost-smoke-'))
  const pluginsDir = path.join(REPO_ROOT, 'plugins')
  const distDir = path.join(dataDir, 'dist-client')

  coreProc = spawn(
    process.execPath,
    [
      path.join(REPO_ROOT, 'core', 'dist', 'main.js'),
      '--plugins',
      pluginsDir,
      '--data',
      dataDir,
      '--dist',
      distDir,
      '--port',
      '0',
    ],
    { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true },
  )
  coreProc.once('exit', (code, signal) => {
    coreExited = { code, signal }
  })

  let stdoutBuf = ''
  let port = 0
  coreProc.stdout.setEncoding('utf8')
  coreProc.stdout.on('data', (chunk) => {
    stdoutBuf += chunk
    process.stdout.write(chunk)
    if (port === 0) {
      const m = /listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(stdoutBuf)
      if (m) port = Number(m[1])
    }
  })

  await waitFor(() => port !== 0 || coreExited !== null, 20_000, 'core listening')
  if (coreExited) {
    throw new Error(
      `core exited early (code=${coreExited.code} signal=${coreExited.signal}); stdout tail: ${JSON.stringify(stdoutBuf.slice(-600))}`,
    )
  }
  if (port === 0) throw new Error(`core produced no listening line; stdout: ${JSON.stringify(stdoutBuf.slice(-600))}`)

  const base = `http://127.0.0.1:${port}`
  log(`core listening at ${base}`)

  const svc1 = await waitFor(
    async () => {
      if (coreExited) throw new Error(`core exited while waiting for service (code=${coreExited.code})`)
      const h = findVehicle(await getHealth(base))
      return h && h.status === 'ready' ? h : null
    },
    25_000,
    'session ready',
  )
  vehiclePid = svc1.pid
  log(`session ready pid=${svc1.pid} restartCount=${svc1.restartCount}`)

  sse = await openSse(base)

  const r1 = `smoke-1-${Date.now()}`
  const events1 = await postUntilResult(base, sse, r1, 'ping-1', 15_000)
  const result1 = events1.find((e) => e.topic === 'session.create.result' && e.payload.requestId === r1)
  const created1 = events1.find((e) => e.topic === 'session.created' && e.payload.title === 'ping-1')
  if (!result1) throw new Error(`missing result event for ${r1}`)
  if (!created1) throw new Error(`missing session.created event for ${r1}`)
  if (result1.payload.title !== 'ping-1') {
    throw new Error(`result.title expected 'ping-1', got ${JSON.stringify(result1.payload.title)}`)
  }
  // 领域事件与命令回执指向同一会话：bus 与 SSE 桥都没串味
  if (created1.payload.sessionId !== result1.payload.sessionId) {
    throw new Error(
      `session.created.sessionId ${JSON.stringify(created1.payload.sessionId)} != result.sessionId ${JSON.stringify(result1.payload.sessionId)}`,
    )
  }
  // source 由 SDK 注入，标明事件来自哪个服务进程
  if (result1.payload.source !== 'session') {
    throw new Error(`result.source expected 'session', got ${JSON.stringify(result1.payload.source)}`)
  }
  log('round 1: POST /api/command → SSE result + session.created ok (source=session)')

  log(`killing session pid=${svc1.pid}`)
  killPid(svc1.pid)

  const svc2 = await waitFor(
    async () => {
      if (coreExited) throw new Error(`core exited while waiting for restart (code=${coreExited.code})`)
      const h = findVehicle(await getHealth(base))
      if (!h || h.status !== 'ready') return null
      if ((h.restartCount ?? 0) < 1) return null
      if (h.pid === svc1.pid) return null
      return h
    },
    25_000,
    'session restart',
  )
  vehiclePid = svc2.pid
  log(`session restarted pid=${svc2.pid} restartCount=${svc2.restartCount}`)

  const r2 = `smoke-2-${Date.now()}`
  const events2 = await postUntilResult(base, sse, r2, 'ping-2', 15_000)
  const result2 = events2.find((e) => e.topic === 'session.create.result' && e.payload.requestId === r2)
  if (!result2) throw new Error(`missing result event after restart for ${r2}`)
  if (result2.payload.title !== 'ping-2') {
    throw new Error(`round 2 title expected 'ping-2', got ${JSON.stringify(result2.payload.title)}`)
  }
  log('round 2: command after restart ok')

  log('PASS')
}

const watchdog = setTimeout(() => {
  console.error('[smoke] FAIL: watchdog timeout (90s)')
  void cleanup().then(
    () => process.exit(1),
    () => process.exit(1),
  )
}, WATCHDOG_MS)

main()
  .then(() => {
    clearTimeout(watchdog)
    return cleanup()
  })
  .then(
    () => process.exit(0),
    (err) => {
      clearTimeout(watchdog)
      console.error(`[smoke] FAIL: ${err && err.stack ? err.stack : String(err)}`)
      return cleanup().then(
        () => process.exit(1),
        () => process.exit(1),
      )
    },
  )
