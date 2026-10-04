// 单元测试专用假服务 —— 真实 Node 子进程，最小 JSON-RPC 对端（stdio Content-Length 分帧）
// 模式由环境变量控制：
//   FAKE_SERVICE_ID / FAKE_DATA_DIR / FAKE_CRASH_ONCE(+FAKE_CRASH_MARKER) /
//   FAKE_GARBAGE / FAKE_IGNORE_PING / FAKE_IGNORE_SHUTDOWN / FAKE_DELAY_INITIALIZE_MS /
//   FAKE_REQUEST_METHOD(+FAKE_REQUEST_PARAMS, FAKE_REQUEST_REPORT_TOPIC)
// 最后一条用于**服务 → Core** 的特权 RPC（如 plugins.readFile）：握手后发一次请求，
// 把结果（或错误）publish 到 REPORT_TOPIC，好让测试断言 Core 真的应答了、且应答了什么。
import { existsSync, writeFileSync } from 'node:fs'

/** 特权 RPC 探针用的固定 id。选 100 是因为 Core 自己的请求 id 从更小的数开始，
 *  且这个 id 只在 FAKE_REQUEST_REPORT_TOPIC 存在时才有特殊含义。 */
const FAKE_REQUEST_ID = 100

/** 特权 RPC 探针只发一次（这个应答分支会被 Core 的每一条 result 触发） */
let probeSent = false

// 崩溃锚点：FAKE_CRASH_ONCE=1 且 marker 不存在时，加载期立即 exit(1)，
// 不发 initialize。首次实例在握手完成前崩 → handleExit 发布 service.restarting
// → 重启的第二次实例看到 marker 跳过崩溃并正常握手进 ready，
// 定型断言顺序 restarting → ready（restartCount=1）。
const crashOnce = process.env.FAKE_CRASH_ONCE === '1'
const crashMarker = process.env.FAKE_CRASH_MARKER
if (crashOnce) {
  if (crashMarker && !existsSync(crashMarker)) {
    writeFileSync(crashMarker, '')
    console.error(`[fixture] crash-now: marker=${crashMarker}`)
    process.exit(1)
  }
  console.error(`[fixture] skip-crash: marker exists: ${crashMarker}`)
}

let buffer = Buffer.alloc(0)
let pendingLen = null

function encode(msg) {
  const body = Buffer.from(JSON.stringify(msg), 'utf8')
  process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`)
  process.stdout.write(body)
}

function handleMessage(msg) {
  if (!msg || typeof msg !== 'object') return
  if (typeof msg.method === 'string') {
    if (msg.method === 'initialize') {
      encode({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          sessionId: 'fake-session',
          heartbeatInterval: 50,
          dataDir: process.env.FAKE_DATA_DIR ?? '.',
        },
      })
      encode({ jsonrpc: '2.0', method: 'initialized' })
      return
    }
    if (msg.method === 'health.ping') {
      if (process.env.FAKE_IGNORE_PING !== '1') {
        encode({ jsonrpc: '2.0', method: 'health.pong' })
      }
      return
    }
    if (msg.method === 'shutdown') {
      if (process.env.FAKE_IGNORE_SHUTDOWN === '1') return
      process.exit(0)
    }
    if ('id' in msg) {
      encode({ jsonrpc: '2.0', id: msg.id, result: { echo: true, method: msg.method } })
    }
    return
  }
  if ('id' in msg && msg.result) {
    if (msg.id === FAKE_REQUEST_ID && process.env.FAKE_REQUEST_REPORT_TOPIC) {
      // 特权 RPC 的成功应答：把结果 publish 回总线，好让测试断言 Core 到底答了什么
      encode({
        jsonrpc: '2.0',
        id: 200,
        method: 'bus.publish',
        params: {
          topic: process.env.FAKE_REQUEST_REPORT_TOPIC,
          payload: { result: msg.result ?? null, error: null },
        },
      })
      return
    }
    encode({ jsonrpc: '2.0', method: 'initialized' })
    // 特权 RPC 探针：**在收到 Core 对 initialize 的应答之后**才发 ——
    // 那是 Core 的 client 一定已经挂好 onRequest 的时刻。反过来放在「请求 initialize」
    // 的分支里是错的：这个 fixture 是**服务发起** initialize（见文件末尾），
    // 那个分支永远等不到消息，于是探针永不发出、测试只能超时。
    // `msg.id === 1` = initialize 的应答；`probeSent` 保证只发一次
    // （这个分支会被每一条带 result 的应答触发，包括 Core 对自己请求的回声）。
    if (msg.id === 1 && !probeSent && process.env.FAKE_REQUEST_METHOD) {
      probeSent = true
      encode({
        jsonrpc: '2.0',
        id: FAKE_REQUEST_ID,
        method: process.env.FAKE_REQUEST_METHOD,
        params: JSON.parse(process.env.FAKE_REQUEST_PARAMS ?? 'null'),
      })
    }
  }
  if ('id' in msg && msg.error && msg.id === FAKE_REQUEST_ID && process.env.FAKE_REQUEST_REPORT_TOPIC) {
    // 错误应答走另一条分支 —— 拒绝路径（越界、没插件目录…）才是这里的主要测试对象
    encode({
      jsonrpc: '2.0',
      id: 201,
      method: 'bus.publish',
      params: {
        topic: process.env.FAKE_REQUEST_REPORT_TOPIC,
        payload: { result: null, error: msg.error },
      },
    })
  }
}

process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk])
  for (;;) {
    if (pendingLen === null) {
      const idx = buffer.indexOf('\r\n\r\n')
      if (idx === -1) return
      const header = buffer.subarray(0, idx).toString('ascii')
      const m = /Content-Length:\s*(\d+)/i.exec(header)
      if (!m) return
      pendingLen = Number(m[1])
      buffer = buffer.subarray(idx + 4)
    }
    if (buffer.length < pendingLen) return
    const body = buffer.subarray(0, pendingLen)
    buffer = buffer.subarray(pendingLen)
    pendingLen = null
    try {
      handleMessage(JSON.parse(body.toString('utf8')))
    } catch {
      /* ignore malformed */
    }
  }
})

if (process.env.FAKE_GARBAGE === '1') {
  setInterval(() => process.stdout.write(Buffer.from('garbage\r\n\r\nnot-framed\n')), 20)
}

const delayInit = Number(process.env.FAKE_DELAY_INITIALIZE_MS ?? 0)
const manifestSnapshot = process.env.FAKE_MANIFEST ?? '{}'
setTimeout(
  () => {
    encode({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: process.env.FAKE_PROTOCOL_VERSION ?? '1.0.0',
        serviceId: process.env.FAKE_SERVICE_ID ?? 'fake',
        coreVersion: '0.0.0',
        manifest: JSON.parse(manifestSnapshot),
      },
    })
    if (process.env.FAKE_PUBLISH_TOPIC) {
      const publish = () =>
        encode({
          jsonrpc: '2.0',
          id: 2,
          method: 'bus.publish',
          params: {
            topic: process.env.FAKE_PUBLISH_TOPIC,
            payload: JSON.parse(process.env.FAKE_PUBLISH_PAYLOAD ?? '{}'),
          },
        })
      publish()
      setInterval(publish, 40)
    }
  },
  delayInit,
)
