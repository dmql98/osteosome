/**
 * 通配符匹配（P1a 定案）：
 * - `*`   匹配「恰好一个段」
 * - `**`  匹配「零或多个段」
 * - 裸 `*` 匹配全量
 *
 * 例：`hello.*` 匹配 `hello.command`；`hello.**` 匹配 `hello.command.started`；
 * `service.*` 匹配 `service.ready`（不匹配 `service.ready.extra`，杜绝前缀误匹配）。
 */

/** 是否匹配 topic（pattern 可为精确 topic、`*`/`**`/混合通配） */
export function matchPattern(pattern: string, topic: string): boolean {
  if (pattern === '*' || pattern === '**') return true
  const pat = pattern.split('.')
  const t = topic.split('.')
  return matchSegments(pat, t)
}

function matchSegments(pat: string[], topic: string[]): boolean {
  if (pat.length === 0) return topic.length === 0
  const head = pat[0]
  if (head === '**') {
    for (let take = 0; take <= topic.length; take++) {
      if (matchSegments(pat.slice(1), topic.slice(take))) return true
    }
    return false
  }
  if (topic.length === 0) return false
  if (head === '*' || head === topic[0]) {
    return matchSegments(pat.slice(1), topic.slice(1))
  }
  return false
}