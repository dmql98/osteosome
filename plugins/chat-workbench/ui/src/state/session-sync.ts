/**
 * chat-workbench UI 的共享状态层：当前会话 id 的跨 iframe 同步（P6 新增）。
 *
 * ## 为什么这一层存在：三个视图原本靠 pinia 单例共享，现在跨三个 iframe
 *
 * 搬进插件之前，①会话列表 / ②时间线 / ③输入框是**同一个 JS 上下文**里的三个组件，
 * 共享 `session.store` 与 `chat.store` 两个 pinia 单例 —— 于是「②③ 之间零直接通信」
 * 这句话是真的：它们读同一个对象。
 *
 * 搬进插件之后它们是**三个独立 iframe**：各自的 JS 上下文、各自的 Vue app 实例。
 * 单例不再跨得过去。于是要回答一个具体问题：**哪些状态真的需要跨 iframe？**
 *
 * ## 答案只有一个：curId
 *
 * 其余状态每个 iframe 都能**各自问 Core 重建**，不需要任何消息层：
 *
 * | 状态 | 来源 | 为什么不需要共享 |
 * |---|---|---|
 * | `list`（会话索引） | SSE `session.created/updated/deleted` + `session.list.result` | 三个 iframe 各订一份，收到的是同一批事件 |
 * | `messages`（当前会话历史） | `session.get.result` + SSE `message.appended` | 同上；每个事件自带 `sessionId`，可按 curId 过滤 |
 * | in-flight 行（流式累积） | SSE `loop.token.streamed` / `loop.tool.executed` | 事件自带 `requestId` + `sessionId`，各 iframe 自己拼 |
 * | `sending` / `activeA` | SSE `loop.state.changed`（带 `requestId` + `sessionId`） | 同上 |
 * | `failed` | SSE `loop.run.failed` | 同上 |
 * | `draft` / `provider` / `model` / `thinking` | ③ 输入框自己 | 别的视图不读它们 |
 *
 * 换句话说：**服务端事件流本来就是那个「共享层」**，只是它一直在那里而没人注意到 ——
 * 之前 pinia 单例把「同一份数据」做成了「同一个对象」，于是掩盖了
 * 「这些数据本来就有多个独立副本的来源」这个事实。拆开之后才看清：
 * 需要自己传的东西只有一个字节。
 *
 * ## curId 用 sessionStorage 传，靠 storage 事件
 *
 * 候选与取舍：
 * - `BroadcastChannel` —— 能传，但它是**全应用**广播：Tauri 多窗口下两个窗口的
 *   会话列表会互相抢 curId。而 curId 今天的语义明确是「本地态，各窗独立」（P3 §3.4）。
 * - `postMessage` —— 要与宿主约定握手与消息形状，凭空多一层协议。
 * - **`sessionStorage`** —— 语义**正好**对上：按 origin + **顶层浏览上下文**隔离
 *   （同窗口的三个 iframe 共享，一个窗口一份独立命名空间），刷新后还在，
 *   且有现成的 `storage` 事件通知同上下文里的其它文档，零新增协议。
 *
 * ## 一个必须记住的坑：storage 事件不在写入方自己身上触发
 *
 * 所以 `setCurrentSessionId` 必须**本地先赋值、再写盘**。反过来的话，
 * 写入方自己要等一次永远不会来的事件才更新 —— 那一下点击就没反应了。
 * 而「本地先赋值」也正是让点击**立即**生效的原因：另外两个 iframe 是通过事件
 * 稍后知道的，它们有几十毫秒的延迟，**写入方不该陪着一起等**。
 *
 * ## Core 完全不知情
 *
 * curId 通过浏览器自己的同源存储共享，Core 只做「搬字节 + 路由命令」两件事，
 * 不需要知道「会话」这个概念。与 §7「Core 不解析插件内容」一致。
 */
import { ref, type Ref } from 'vue'

/**
 * sessionStorage 的键。带插件 id 前缀 —— 别的插件将来若也要共享，别撞。
 *
 * `export` 出来是因为「键名变了，同步测试必须跟着变」：
 * 这个键本身就是跨 iframe 协议的一部分，改它是破坏性变更。
 */
export const CUR_ID_KEY = 'osteosome.chat-workbench.curSessionId'

function readStored(): string {
  try {
    return sessionStorage.getItem(CUR_ID_KEY) ?? ''
  } catch {
    // 无痕模式 / storage 被禁：退化成「本 iframe 各自为政」，仍可用，只是不跨 iframe 同步
    return ''
  }
}

/**
 * 当前会话 id。每个 iframe 一份，靠 sessionStorage + storage 事件保持一致。
 *
 * 用 `ref` 而不是裸变量：三个视图都是 Vue 组件，靠响应式驱动重渲染。
 * 用裸变量就得手动 emit，那是自己重写一遍响应式。
 */
const curId: Ref<string> = ref(readStored())

/**
 * 开始跨 iframe 同步。由 `App.vue` 的 `onMounted` 调一次（不是每个视图各调）。
 *
 * 返回停止函数：视图层的「开始/停止」是对称的，而事件监听不返回值就等于没法停 ——
 * 测试里换一个用例就换一批监听，旧监听还活着，于是症状是「事件好像被处理了两次」。
 */
export function startSessionSync(): () => void {
  const onStorage = (event: StorageEvent): void => {
    // key === null = 有人 clear() 了整个 storage，对我们等于「回到没有当前会话」
    if (event.key !== null && event.key !== CUR_ID_KEY) return
    const next = readStored()
    if (next !== curId.value) curId.value = next
  }
  window.addEventListener('storage', onStorage)
  return () => window.removeEventListener('storage', onStorage)
}

/**
 * 切换当前会话。**本地先赋值，再写盘** —— 见文件头关于 storage 事件的那个坑。
 *
 * 不写盘也能用：读方读的永远是 `curId.value`（同一个 ref），
 * 只是另外两个 iframe 不知道，跨 iframe 同步退化成本地。
 */
export function setCurrentSessionId(sessionId: string): void {
  curId.value = sessionId
  try {
    if (sessionId) sessionStorage.setItem(CUR_ID_KEY, sessionId)
    else sessionStorage.removeItem(CUR_ID_KEY)
  } catch {
    // 写不了就算了：本地已经生效，只是不跨 iframe 同步
  }
}

export function currentSessionId(): Ref<string> {
  return curId
}

/**
 * 测试专用：复位模块级状态。
 *
 * `curId` 是模块级 ref，测试之间会互相污染 —— 而症状是「上个用例选中的会话
 * 在这个用例里还在」，排查时容易误以为是组件状态没清。
 */
export function __resetSessionSyncForTest(): void {
  curId.value = ''
  try {
    sessionStorage.removeItem(CUR_ID_KEY)
  } catch {
    // 忽略：清不掉也不影响断言
  }
}
