/**
 * 会话列表的分组与相对时间（P4b §2 / §3）—— **纯函数**，与视图无关，可直接测。
 *
 * 分组键固定五+一：`置顶 → 今天 → 昨天 → 本周 → 更早`，归档单独一桶。
 * 之所以按时间而不是按项目：`SessionMeta` 没有 workspace/project 字段（§12），
 * 硬造要动协议；时间桶零成本且恰好解决 240px 侧栏的真实痛点（找昨天那条）。
 */

export type BucketKey = 'pin' | 'today' | 'yesterday' | 'week' | 'earlier' | 'archived'

/** 分组的显示顺序（固定） */
export const BUCKET_ORDER: readonly BucketKey[] = ['pin', 'today', 'yesterday', 'week', 'earlier', 'archived']

export const BUCKET_LABEL: Record<BucketKey, string> = {
  pin: '置顶',
  today: '今天',
  yesterday: '昨天',
  week: '本周',
  earlier: '更早',
  archived: '归档',
}

function startOfDay(ms: number): number {
  const d = new Date(ms)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/** 本周起点（周一 00:00，本地时区） */
function startOfWeek(ms: number): number {
  const d = new Date(startOfDay(ms))
  const day = d.getDay() // 0=周日
  const backToMonday = (day + 6) % 7
  d.setDate(d.getDate() - backToMonday)
  return d.getTime()
}

/**
 * 分桶。**归档优先于置顶**：归档会话即便 pinned 也落在归档桶（它已经「收起来」了）。
 */
export function bucketOf(meta: { pinned?: boolean; archived?: boolean; updatedAt: string }, now: number): BucketKey {
  if (meta.archived) return 'archived'
  if (meta.pinned) return 'pin'
  const t = Date.parse(meta.updatedAt)
  if (!Number.isFinite(t)) return 'earlier'
  const today = startOfDay(now)
  if (t >= today) return 'today'
  if (t >= today - 86_400_000) return 'yesterday'
  if (t >= startOfWeek(now)) return 'week'
  return 'earlier'
}

/**
 * 相对时间（P0-5）。24h 内给「刚刚 / N 分钟前 / N 小时前」，之后降级到「昨天 / M/D」
 * —— **不永远停在 N 天前**（天枢侧栏的老毛病）。
 */
export function timeAgo(iso: string, now: number): string {
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return ''
  const diff = now - t
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
  if (t >= startOfDay(now) - 86_400_000) return '昨天'
  const d = new Date(t)
  return `${d.getMonth() + 1}/${d.getDate()}`
}
