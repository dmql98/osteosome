/**
 * 时间线渲染用的行（②）。
 *
 * ## 为什么不叫 `Row` 也不叫 `MessageItem`
 *
 * 它**不是**一条落库消息 —— 一行可能是「已落库的消息」，也可能是「正在流的一轮」。
 * 两者字段几乎一样（都是 role + text），合起来渲染才不会在气泡里出现分叉样式，
 * 所以合成一个类型而不是两套渲染分支。
 *
 * ## `pending` 是唯一能区分「在途」与「已落库」的字段
 *
 * `pending: true` ⇒ 占位行（等服务端 `message.appended` 换成真 id）。
 * 落库之后一律 `pending: false` 或整个字段不存在。
 */
export interface ChatRow {
  /** 视图 id。落库后是服务端消息 id；在途时是 `in-flight-<requestId>` */
  key: string
  role: 'user' | 'assistant'
  /** 正文。**不含思维链** —— reasoning 单独走下面那个字段 */
  text: string
  /** 思维链（折叠块渲染这个，不进 `text`） */
  reasoning?: string
  /** 在途中（还在流式累积） */
  pending?: boolean
  /** 这一轮为什么停（来自落库消息的 finishReason） */
  finishReason?: string
  /** token 用量 */
  usage?: { promptTokens: number; completionTokens: number }
  /** assistant 消息发起的工具调用（ok 未定义 = 执行中） */
  toolCalls?: (import('@osteosome/shared').ToolCall & { ok?: boolean; summary?: string })[]
}