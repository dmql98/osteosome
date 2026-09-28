/**
 * SSE wire → 归一化 JSON 事件流（P2 WS-2 / WS-3 翻译层）。
 *
 * - 逐行解析 `data: {...}`；CRLF / 连续空行兼容；行尾残留缓冲。
 * - 截断（非 JSON）行忽略；非 `data:` 前缀（event:/id:/注释）忽略。
 * - `data: [DONE]` → `{ done: true }` 信号（不抛错）。
 */

export { readSseJson } from '@osteosome/shared'
export type { SseEvent } from '@osteosome/shared'
