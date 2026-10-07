/**
 * session 服务入口（P3 WS-1；P4b P0-0 / D5 修订）—— 命令分发 + 结果/事件发布。
 *
 * - 订阅九个 session 命令（P3 §3.3 + P4b P2-1/P2-2）→ 走 store → 发 `<cmd>.result`；
 * - 顺带发布领域事件（`session.created` / `session.updated` / `session.deleted` / `message.appended`），
 *   供前端 + loop 旁路消费。
 *
 * ## P0-0：`message.append` 后**必须**补发 `session.updated`
 *
 * 时间桶分组、跨桶重排、手动排序的持久化，全都建立在「客户端知道每条会话最新的 `updatedAt`」
 * 之上。store 早就把 `meta.updatedAt` 改成消息时间了，但这里此前**只发 `message.appended`**，
 * 不发 `session.updated` —— 于是客户端的 `SessionMeta.updatedAt` 只在 create/rename 时更新，
 * 分组会停在错误位置且不自愈。客户端 `ui/state/session.ts` **已经订阅了**这条，
 * 所以这里只是补一个 publish。顺带把 `lastMessage` 预览也带出去。
 *
 * ## D5：不再对每条命令无条件拷全量索引
 *
 * 原来 `const before = new Set(store.list().map(...))` 在 dispatch 之前无条件执行，
 * 唯一用途是给 `session.clear` 逐个发 `session.deleted`，而 append 分支根本不用它。
 * 现在挪进 clear 分支，并用 `store.ids()`（返回 Set，省掉 N 个对象拷贝）。
 *
 * ## 会话落在哪：`userData/plugin/chat-workbench/`
 *
 * `service.dataDir` 由握手回填，**`start()` 之前恒为 `''`** —— 所以 store 只能在
 * `main()` 里、`await service.start()` **之后**建（见旧注释与 P4b §6.6 的迁移红线）。
 * 拿不到 dataDir 就直接失败，绝不退到相对路径（487 条会话写进 dist/ 的事故）。
 */
import { Service } from '@osteosome/service-sdk'
import { SessionStore } from './store'
import { dispatch } from './session'

const service = new Service({ id: 'session', version: '1.0.0' })

/**
 * 握手之后才建（见文件头）。顶层留 `null` 而不是造一个空壳：
 * 空壳会让「会话到底存哪」这个问题有两个答案，而「必须在 start 之后建」正是这里最容易写错的地方。
 */
let store: SessionStore | null = null

/** 命令 → 结果 topic（P3 §3.3 + P4b P2-1/P2-2） */
const RESULT_TOPIC: Record<string, string> = {
  'session.list': 'session.list.result',
  'session.get': 'session.get.result',
  'session.create': 'session.create.result',
  'session.rename': 'session.rename.result',
  'session.delete': 'session.delete.result',
  'session.clear': 'session.clear.result',
  'session.pin': 'session.pin.result',
  'session.archive': 'session.archive.result',
  'session.export': 'session.export.result',
  'message.append': 'message.append.result',
}

function handle(topic: string, payload: Record<string, unknown>): void {
  // 订阅生效在 start 之后，所以这里拿不到 store 意味着「命令来早了」——
  // 那不可能发生（SDK 在 started=false 时不投递），真发生了也是我们自己的接线问题，必须炸出来
  if (!store) throw new Error(`session: ${topic} arrived before the store was opened`)

  // D5：快照只在 clear 这一条分支里取（Set，无对象拷贝），其余命令不再白付这份钱
  const clearIds = topic === 'session.clear' ? store.ids() : null

  const result = dispatch(store, topic, payload)
  service.publish(RESULT_TOPIC[topic], result)
  if (result.error) return

  // session.created / session.updated（create / rename）
  if (topic === 'session.create' || topic === 'session.rename') {
    const meta = store.meta(result.sessionId as string)
    if (meta) {
      service.publish(topic === 'session.create' ? 'session.created' : 'session.updated', {
        sessionId: meta.id,
        title: meta.title,
        updatedAt: meta.updatedAt,
        ...(meta.pinned !== undefined ? { pinned: meta.pinned } : {}),
        ...(meta.archived !== undefined ? { archived: meta.archived } : {}),
        ...(meta.lastMessage ? { lastMessage: meta.lastMessage } : {}),
        ...(meta.workspace ? { workspace: meta.workspace } : {}),
        ...(meta.workspaces ? { workspaces: meta.workspaces } : {}),
      })
    }
  }

  // 置顶 / 归档：**改的是分类，不是活动时间**，所以 updatedAt 原样带（不 bump）
  if (topic === 'session.pin' || topic === 'session.archive') {
    const meta = store.meta(result.sessionId as string)
    if (meta) {
      service.publish('session.updated', {
        sessionId: meta.id,
        updatedAt: meta.updatedAt,
        ...(meta.pinned !== undefined ? { pinned: meta.pinned } : {}),
        ...(meta.archived !== undefined ? { archived: meta.archived } : {}),
      })
    }
  }

  // session.deleted
  if (topic === 'session.delete') {
    service.publish('session.deleted', { sessionId: result.sessionId })
  }

  // session.clear：dispatch 前已取快照，这里逐个发 deleted
  if (topic === 'session.clear' && clearIds) {
    for (const id of clearIds) service.publish('session.deleted', { sessionId: id })
  }

  // message.appended + **P0-0：补发 session.updated**（updatedAt + 预览行）
  if (topic === 'message.append') {
    service.publish('message.appended', {
      sessionId: result.sessionId,
      message: result.message,
    })
    const meta = store.meta(result.sessionId as string)
    if (meta) {
      service.publish('session.updated', {
        sessionId: meta.id,
        updatedAt: meta.updatedAt,
        ...(meta.lastMessage ? { lastMessage: meta.lastMessage } : {}),
      })
    }
  }
}

for (const topic of Object.keys(RESULT_TOPIC)) {
  service.subscribe(topic, (payload) => {
    handle(topic, payload as Record<string, unknown>)
  })
}

/**
 * `session.set.workspace`（P7 M0）—— 合并式写工作区，唯一写者。
 * 没有专属 `<cmd>.result`：变更以 `session.updated`（带 workspace/workspaces）广播出去，
 * loop 据此更新本地副本并用于越界重派。
 */
service.subscribe('session.set.workspace', (payload) => {
  if (!store) throw new Error('session: session.set.workspace arrived before the store was opened')
  const result = dispatch(store, 'session.set.workspace', payload as Record<string, unknown>)
  if (result.error) return
  const meta = store.meta(result.sessionId as string)
  if (meta) {
    service.publish('session.updated', {
      sessionId: meta.id,
      updatedAt: meta.updatedAt,
      ...(meta.workspace ? { workspace: meta.workspace } : {}),
      ...(meta.workspaces ? { workspaces: meta.workspaces } : {}),
    })
  }
})

async function main(): Promise<void> {
  await service.start()
  // 握手已完成，`service.dataDir` 现在才是真的。拿不到就 fail fast（见文件头）
  const dir = service.dataDir || process.env.DS_DATA_DIR
  if (!dir) {
    throw new Error(
      'session: no dataDir from the handshake — refusing to fall back to a relative path ' +
        '(that is how 487 sessions ended up inside dist/)',
    )
  }
  store = new SessionStore(dir)
  console.log(`session: dataDir=${store.root}`)
}

main().catch((err: unknown) => {
  console.error(`session: failed to start: ${String(err)}`)
  process.exit(1)
})
