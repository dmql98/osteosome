import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const WATCHDOG_MS = 90_000

const REQUIRED_ARTIFACTS = [
  path.join(REPO_ROOT, 'core', 'dist', 'main.js'),
  path.join(REPO_ROOT, 'shared', 'dist', 'index.js'),
  path.join(REPO_ROOT, 'sdk', 'ts', 'dist', 'index.js'),
  path.join(REPO_ROOT, 'services', 'hello', 'dist', 'index.js'),
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

function findHello(health) {
  if (!health || !Array.isArray(health.services)) return null
  return health.services.find((s) => s.id === 'hello') ?? null
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
  const res = await fetch(`${base}/events?topics=hello.command.*`, { signal: controller.signal })
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

async function postUntilExecuted(base, sse, requestId, text, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let lastStatus = 0
  while (Date.now() < deadline) {
    const res = await fetch(`${base}/api/command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic: 'hello.command', payload: { requestId, text } }),
    })
    lastStatus = res.status
    await res.text().catch(() => '')
    await sleep(250)
    const events = parseEvents(sse.text())
    const hit = events.find(
      (e) => e.topic === 'hello.command.executed' && e.payload.requestId === requestId,
    )
    if (hit) return events
  }
  throw new Error(
    `command '${requestId}' not executed in ${timeoutMs}ms (lastStatus=${lastStatus}); sse=${JSON.stringify(sse.text().slice(0, 800))}`,
  )
}

let coreProc = null
let coreExited = null
let helloPid = null
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
  if (helloPid != null) {
    killPid(helloPid)
    helloPid = null
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
  const servicesDir = path.join(REPO_ROOT, 'services')
  const distDir = path.join(dataDir, 'dist-client')

  coreProc = spawn(
    process.execPath,
    [
      path.join(REPO_ROOT, 'core', 'dist', 'main.js'),
      '--services',
      servicesDir,
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

  const hello1 = await waitFor(
    async () => {
      if (coreExited) throw new Error(`core exited while waiting for hello (code=${coreExited.code})`)
      const h = findHello(await getHealth(base))
      return h && h.status === 'ready' ? h : null
    },
    25_000,
    'hello ready',
  )
  helloPid = hello1.pid
  log(`hello ready pid=${hello1.pid} restartCount=${hello1.restartCount}`)

  sse = await openSse(base)

  const r1 = `smoke-1-${Date.now()}`
  const events1 = await postUntilExecuted(base, sse, r1, 'ping-1', 15_000)
  const started1 = events1.find((e) => e.topic === 'hello.command.started' && e.payload.requestId === r1)
  const executed1 = events1.find((e) => e.topic === 'hello.command.executed' && e.payload.requestId === r1)
  if (!started1) throw new Error(`missing started event for ${r1}`)
  if (!executed1) throw new Error(`missing executed event for ${r1}`)
  if (started1.payload.source !== 'hello') {
    throw new Error(`started.source expected 'hello', got ${JSON.stringify(started1.payload.source)}`)
  }
  if (executed1.payload.echo !== 'ping-1') {
    throw new Error(`executed.echo expected 'ping-1', got ${JSON.stringify(executed1.payload.echo)}`)
  }
  log('round 1: POST /api/command → SSE started+executed ok (source=hello)')

  log(`killing hello pid=${hello1.pid}`)
  killPid(hello1.pid)

  const hello2 = await waitFor(
    async () => {
      if (coreExited) throw new Error(`core exited while waiting for restart (code=${coreExited.code})`)
      const h = findHello(await getHealth(base))
      if (!h || h.status !== 'ready') return null
      if ((h.restartCount ?? 0) < 1) return null
      if (h.pid === hello1.pid) return null
      return h
    },
    25_000,
    'hello restart',
  )
  helloPid = hello2.pid
  log(`hello restarted pid=${hello2.pid} restartCount=${hello2.restartCount}`)

  const r2 = `smoke-2-${Date.now()}`
  const events2 = await postUntilExecuted(base, sse, r2, 'ping-2', 15_000)
  const executed2 = events2.find((e) => e.topic === 'hello.command.executed' && e.payload.requestId === r2)
  if (!executed2) throw new Error(`missing executed event after restart for ${r2}`)
  if (executed2.payload.echo !== 'ping-2') {
    throw new Error(`round 2 echo expected 'ping-2', got ${JSON.stringify(executed2.payload.echo)}`)
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
