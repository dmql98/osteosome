/**
 * 会话列表的**本地偏好**（P4b P0-9 / P0-10 / P0-11）—— 分组折叠、手动顺序、已读时间、整组置顶。
 *
 * ## 为什么存 `sessionStorage` 而不是 `localStorage`
 *
 * 未读点（P0-10）用 sessionStorage：它的语义是「同窗口组的三个 iframe 共享，
 * 一个窗口一份独立命名空间」。localStorage **跨窗口**，两个窗口会互相清对方的未读
 * （天枢 `sessionListPrefs.ts` 现状即如此，P4b §12 明确「别学」）。
 *
 * ## 为什么键名带 schema 版本后缀
 *
 * 改结构（比如 order 从数组变对象）时，版本一变旧键自然被忽略 → 回落默认偏好，
 * 而不是按新结构去解析旧数据导致崩溃或错乱。**解析失败当空偏好**，绝不抛错、绝不 `removeItem`
 * （清空会丢用户手动排的顺序）。
 *
 * ## 为什么用一堆 ref 而不是一个普通对象
 *
 * 视图的 `groups` computed / 未读点都要**随偏好变化重算**。普通对象改字段不会触发 Vue 更新，
 * 症状是「点了置顶/切了折叠，界面纹丝不动，刷新才生效」。
 */
import { ref, type Ref } from 'vue'

/** 键名即跨 iframe 协议的一部分 —— 改它会丢偏好的同时，也可能让同步测试失效 */
export const LIST_PREFS_KEY = 'osteosome.chat-workbench.listPrefs.v1'

interface StoredPrefs {
  collapsed: string[]
  order: Record<string, string[]>
  seen: Record<string, number>
  showPreview: boolean
  groupPinned: string[]
}

function read(): StoredPrefs {
  const empty: StoredPrefs = { collapsed: [], order: {}, seen: {}, showPreview: true, groupPinned: [] }
  try {
    const raw = sessionStorage.getItem(LIST_PREFS_KEY)
    if (!raw) return empty
    const parsed = JSON.parse(raw) as Partial<StoredPrefs>
    if (!parsed || typeof parsed !== 'object') return empty
    return {
      collapsed: Array.isArray(parsed.collapsed) ? parsed.collapsed.filter((x) => typeof x === 'string') : [],
      order: parsed.order && typeof parsed.order === 'object' ? (parsed.order as Record<string, string[]>) : {},
      seen: parsed.seen && typeof parsed.seen === 'object' ? (parsed.seen as Record<string, number>) : {},
      showPreview: typeof parsed.showPreview === 'boolean' ? parsed.showPreview : true,
      groupPinned: Array.isArray(parsed.groupPinned) ? parsed.groupPinned.filter((x) => typeof x === 'string') : [],
    }
  } catch {
    // 无痕模式 / 坏 JSON：退化成默认偏好，不清除已有值
    return empty
  }
}

export interface ListPrefsApi {
  isCollapsed: (key: string) => boolean
  toggleGroup: (key: string) => void
  setCollapsed: (key: string, value: boolean) => void
  orderFor: (bucket: string) => string[]
  setOrder: (bucket: string, ids: string[]) => void
  seenAt: (sessionId: string) => number
  markSeen: (sessionId: string, at: number) => void
  isUnread: (sessionId: string, updatedAt: string) => boolean
  showPreview: Ref<boolean>
  togglePreview: () => void
  isGroupPinned: (key: string) => boolean
  toggleGroupPin: (key: string) => void
  /** 仅测试用：清空本进程内存态（sessionStorage 由调用方处理） */
  __reset: () => void
}

export function useListPrefs(): ListPrefsApi {
  const initial = read()
  const collapsed = ref<Set<string>>(new Set(initial.collapsed))
  const groupPinned = ref<Set<string>>(new Set(initial.groupPinned))
  const order = ref<Record<string, string[]>>({ ...initial.order })
  const seen = ref<Record<string, number>>({ ...initial.seen })
  const showPreview = ref(initial.showPreview)

  function persist(): void {
    const snapshot: StoredPrefs = {
      collapsed: [...collapsed.value],
      groupPinned: [...groupPinned.value],
      order: order.value,
      seen: seen.value,
      showPreview: showPreview.value,
    }
    try {
      sessionStorage.setItem(LIST_PREFS_KEY, JSON.stringify(snapshot))
    } catch {
      /* 写不了就算：本地已生效，只是不持久 */
    }
  }

  return {
    isCollapsed: (key) => collapsed.value.has(key),
    toggleGroup(key) {
      const next = new Set(collapsed.value)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      collapsed.value = next
      persist()
    },
    setCollapsed(key, value) {
      const next = new Set(collapsed.value)
      if (value) next.add(key)
      else next.delete(key)
      collapsed.value = next
      persist()
    },
    orderFor: (bucket) => order.value[bucket] ?? [],
    setOrder(bucket, ids) {
      order.value = { ...order.value, [bucket]: [...ids] }
      persist()
    },
    seenAt: (sessionId) => seen.value[sessionId] ?? 0,
    markSeen(sessionId, at) {
      if (!sessionId) return
      if ((seen.value[sessionId] ?? 0) >= at) return
      seen.value = { ...seen.value, [sessionId]: at }
      persist()
    },
    isUnread(sessionId, updatedAt) {
      const at = Date.parse(updatedAt)
      if (!Number.isFinite(at)) return false
      return at > (seen.value[sessionId] ?? 0)
    },
    showPreview,
    togglePreview() {
      showPreview.value = !showPreview.value
      persist()
    },
    isGroupPinned: (key) => groupPinned.value.has(key),
    toggleGroupPin(key) {
      const next = new Set(groupPinned.value)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      groupPinned.value = next
      persist()
    },
    __reset() {
      collapsed.value = new Set()
      groupPinned.value = new Set()
      order.value = {}
      seen.value = {}
      showPreview.value = true
    },
  }
}
