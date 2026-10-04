/**
 * 转发到 `@osteosome/core-client`（P6）。
 *
 * ## 为什么留这个文件而不是让 client 直接 import 包
 *
 * 为了**零改动**：client 里有几十处 `from '@/core-sdk/useCommand'`。
 * 保留同名 shim 意味着那些 import 一行都不用动，而依赖图在类型层面完全等价。
 *
 * ## 那这些 shim 会不会成为「两份真相源」
 *
 * 不会 —— 它们**不含任何实现**，只有一行 re-export。
 * 要漂移也不可能漂：改行为只会改到包里那一份。
 * （对比一下 P5 留下的 `plugins/models/ui/src/core-sdk/` 那种逐字节副本 ——
 * 那才是两份真相源，本轮已经删掉了。）
 */
export { sse, SseClient, type SseHandler, type SseState, type SseClientOptions } from '@osteosome/core-client'