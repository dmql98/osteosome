/**
 * chat-workbench 插件 UI 的状态层。
 *
 * ## 与 client 侧那两个 pinia store 的关系
 *
 * 搬进插件之前它们是 `stores/session.store.ts` 与 `stores/chat.store.ts`，
 * pinia 单例，三个视图共享同一份对象。现在三个视图是三个独立 iframe，
 * 单例跨不过去 —— 于是这个目录把状态**按「谁需要它」重新切了一遍**：
 *
 * · `session-sync.ts` —— 唯一真正需要跨 iframe 的东西：`curId`
 * · `session.ts`        —— 会话索引与历史，**每个 iframe 各自从 SSE 重建**
 * · `run.ts`            —— 在途那一轮，同样从 SSE 派生
 * · `types.ts`          —— 时间线渲染的行
 *
 * ## 为什么这个目录里没有 pinia
 *
 * pinia 解决的是「同一 JS 上下文里多个组件共享一个单例」。搬进 iframe 之后
 * **同一上下文里只剩一个视图** —— 组件之间本来就不共享引用（跨 iframe 也共享不了）。
 * 于是 pinia 剩下的只有 `defineStore` 的样板和一个「必须先 `createPinia()`」的前提。
 *
 * 插件 UI 不挂 pinia 与 P5 一致：models/ui 那个界面一个 store 都没用到，于是没挂；
 * 这里确实用到状态，但那份状态是**局部**的，不需要 store。
 *
 * ## 最重要的一条纪律：状态是**派生**出来的，不是传过去的
 *
 * 之前 pinia 单例把「同一份数据」做成了「同一个对象」，于是掩盖了一件事：
 * **那些数据的来源本来就是可复制的服务端事件流**。三个 iframe 各订一份 SSE，
 * 各拼各的视图，结果必然一致 —— 因为输入相同。
 *
 * 这条纪律一旦破坏（开始「A 改了本地状态、通知 B 同步」）就会掉回
 * 「消息层 + 消息形状 + 消息丢失」那一整套排障地狱。所以这里只共享 `curId`，
 * 而 `curId` 是唯一一个**服务端没有、也不该有**的状态。
 */
export {
  currentSessionId,
  setCurrentSessionId,
  startSessionSync,
  __resetSessionSyncForTest,
} from './session-sync'
export { useSessionState, type SessionState } from './session'
export {
  cancelRun,
  useComposerRun,
  useRunState,
  type ComposerRun,
  type ComposerRunOptions,
  type RunState,
  type RunStateOptions,
} from './run'
export type { ChatRow } from './types'