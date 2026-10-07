<template>
  <div ref="railEl" class="rail" @keydown="onKeydown">
    <header class="rail__head">
      <span class="rail__title">会话</span>
      <span class="rail__n">{{ sessions.list.value.length }}</span>
      <span class="rail__sp" />
      <IconButton
        icon="🔍"
        size="sm"
        :label="searchOpen ? '关闭搜索' : '搜索会话'"
        :class="{ 'is-on': searchOpen }"
        data-testid="rail-search-toggle"
        @click="toggleSearch"
      />
      <IconButton
        icon="▤"
        size="sm"
        :label="prefs.showPreview.value ? '隐藏预览行' : '显示预览行'"
        :class="{ 'is-on': prefs.showPreview.value }"
        data-testid="rail-preview-toggle"
        @click="prefs.togglePreview()"
      />
      <IconButton
        icon="＋"
        size="sm"
        class="ib--new"
        label="新建会话"
        data-testid="rail-new"
        @click="onCreate"
      />
    </header>

    <div v-if="searchOpen" class="rail__search">
      <input
        ref="searchInput"
        v-model="query"
        type="text"
        placeholder="搜索会话标题…"
        aria-label="搜索会话标题"
        data-testid="rail-search-input"
        @keydown.esc="closeSearch"
      />
    </div>

    <div class="rail__body" role="listbox" aria-label="会话列表" data-testid="rail-body">
      <!-- P0-12：三种空态之「还没有会话」 -->
      <div v-if="!sessions.list.value.length" class="rail__empty" data-testid="rail-empty-none">
        <span class="ic">💬</span>
        <div class="t">还没有会话</div>
        <div class="d">点右上角 ＋ 开始第一段对话。</div>
      </div>

      <!-- P0-12：三种空态之「无匹配」 -->
      <div v-else-if="!groups.length" class="rail__empty" data-testid="rail-empty-nomatch">
        <span class="ic">🔍</span>
        <div class="t">没有匹配「{{ query }}」的会话</div>
        <div class="d">换个关键词，或按 Esc 清空搜索。</div>
      </div>

      <div v-for="g in groups" :key="g.key" class="grp">
        <div class="grp__head" role="button" :aria-expanded="!g.collapsed" @click="prefs.toggleGroup(g.key)">
          <span class="grp__arrow" :class="{ 'is-open': !g.collapsed }">▸</span>
          <span class="grp__name">{{ g.label }}</span>
          <span class="grp__count">{{ g.rows.length }}</span>
          <span class="grp__sp" />
          <button
            v-if="g.key === 'pin' || g.key === 'today' || g.key === 'yesterday' || g.key === 'week' || g.key === 'earlier'"
            class="grp__pin"
            :class="{ 'is-on': prefs.isGroupPinned(g.key) }"
            type="button"
            :aria-label="prefs.isGroupPinned(g.key) ? '取消整组置顶' : '整组置顶（本地）'"
            @click.stop="prefs.toggleGroupPin(g.key)"
          >
            📌
          </button>
        </div>

        <template v-if="!g.collapsed">
          <div
            v-for="row in g.rows"
            :id="`srow-${row.meta.id}`"
            :key="row.meta.id"
            class="srow"
            :class="{ 'is-active': row.meta.id === curId, 'is-archived': row.meta.archived, 'srow--child': row.depth > 0 }"
            :style="row.depth > 0 ? { paddingLeft: `${row.depth * 16}px` } : undefined"
            role="option"
            :aria-selected="row.meta.id === curId"
            :tabindex="row.meta.id === focusId ? 0 : -1"
            :draggable="canDrag(g.key)"
            :data-testid="`srow-${row.meta.id}`"
            @click="onSelect(row.meta)"
            @dblclick="startRename(row.meta)"
            @focus="focusId = row.meta.id"
            @contextmenu.prevent="openMenu($event, row.meta)"
            @dragstart="onDragStart($event, row.meta)"
            @dragover="onDragOver($event, g.key, row.meta)"
            @drop="onDrop($event, g.key)"
            @dragend="onDragEnd"
          >
            <button
              v-if="row.hasChildren"
              class="srow__chev"
              :class="{ 'is-open': !row.collapsed }"
              type="button"
              :aria-label="row.collapsed ? '展开子会话' : '折叠子会话'"
              @click.stop="toggleParent(row.meta.id)"
            >
              ▸
            </button>
            <span v-else class="srow__chev srow__chev--spacer" aria-hidden="true" />

            <div
              class="srow__main"
              :class="{ 'srow__main--2': prefs.showPreview.value && !!row.meta.lastMessage }"
            >
              <StatusDot
                :motion="motion.motionOf(row.meta.id)"
                :size="row.depth > 0 ? 5 : 7"
                :label="motionLabel(row.meta.id)"
              />

              <div class="srow__col">
                <div class="srow__line">
                  <span v-if="row.meta.pinned" class="srow__pin" aria-label="已置顶">📌</span>
                  <input
                    v-if="renamingId === row.meta.id"
                    :ref="setRenameInput"
                    v-model="renameText"
                    class="srow__edit"
                    aria-label="重命名会话"
                    @click.stop
                    @keydown.enter.prevent="commitRename(row.meta)"
                    @keydown.esc.prevent="cancelRename"
                    @blur="commitRename(row.meta)"
                  />
                  <span v-else class="srow__title" :title="row.meta.title">{{ row.meta.title || '新会话' }}</span>
                  <span
                    v-if="isUnread(row.meta)"
                    class="srow__unread"
                    aria-label="未读"
                    data-testid="srow-unread"
                  />
                  <span v-if="row.meta.corrupted" class="srow__warn" title="该会话文件损坏">⚠</span>
                </div>
                <div v-if="prefs.showPreview.value && row.meta.lastMessage" class="srow__prev" data-testid="srow-prev">
                  {{ row.meta.lastMessage }}
                </div>
              </div>

              <span class="srow__time">{{ timeAgo(row.meta.updatedAt, now) }}</span>
            </div>

            <div class="srow__acts">
              <button
                class="srow__act"
                type="button"
                :aria-label="row.meta.archived ? '取消归档' : '归档'"
                :data-testid="`srow-archive-${row.meta.id}`"
                @click.stop="onArchive(row.meta)"
              >
                {{ row.meta.archived ? '↩' : '🗄' }}
              </button>
              <button
                class="srow__act"
                type="button"
                aria-label="更多操作"
                :data-testid="`srow-menu-${row.meta.id}`"
                @click.stop="openMenu($event, row.meta)"
              >
                ⋯
              </button>
            </div>
          </div>
        </template>
      </div>
    </div>

    <!-- 行内菜单：作用对象永远是它挂的那一行 -->
    <div
      v-if="menu"
      class="menu"
      role="menu"
      :style="{ left: `${menu.x}px`, top: `${menu.y}px` }"
      data-testid="srow-menu"
    >
      <button class="menu__i" role="menuitem" @click="menuPin">
        <span class="ic">📌</span>{{ menuMeta?.pinned ? '取消置顶' : '置顶' }}
      </button>
      <button class="menu__i" role="menuitem" @click="menuRename">
        <span class="ic">✏️</span>重命名
      </button>
      <button class="menu__i" role="menuitem" @click="menuCopyId">
        <span class="ic">#</span>复制 ID
      </button>
      <button class="menu__i" role="menuitem" @click="menuArchive">
        <span class="ic">🗄</span>{{ menuMeta?.archived ? '取消归档' : '归档' }}
      </button>
      <button class="menu__i" role="menuitem" @click="menuExport">
        <span class="ic">⬇</span>导出…
      </button>
      <div class="menu__sep" />
      <button class="menu__i menu__i--danger" role="menuitem" @click="menuDelete">
        <span class="ic">🗑</span>删除
      </button>
    </div>

    <!-- P0-4：删除走打断式确认（不可逆） -->
    <Modal
      :open="confirmDeleteId !== ''"
      :title="`⚠ 删除「${confirmDeleteTitle}」？`"
      :closable="true"
      @update:open="(v: boolean) => { if (!v) confirmDeleteId = '' }"
    >
      <p>删除后会话及其消息将不可恢复。</p>
      <template #footer>
        <Button size="sm" variant="ghost" @click="confirmDeleteId = ''">取消</Button>
        <Button size="sm" variant="danger" data-testid="srow-delete-confirm" @click="doDelete">确认删除</Button>
      </template>
    </Modal>

    <div v-if="toast" class="rail__toast" role="status" data-testid="rail-toast">{{ toast }}</div>
  </div>
</template>

<script setup lang="ts">
/**
 * ① 会话列表 —— 写 `curId` 的那一个视图（P4b P0 重设计）。
 *
 * ## 相对旧实现的七处断层，逐条对应
 *
 * ① 运行态：`motion.motionOf(id)` 从 `loop.*` 投影出**任意**会话的状态（P0-14）；
 * ② 动作对象：行内菜单/改名/删除永远作用于**它自己那一行**（P0-2/3/4）；
 * ③ 分组：时间桶 `bucketOf`（P0-7）；
 * ④ 时间：相对时间 `timeAgo`（P0-5）；
 * ⑤ 搜索：头部开关（P0-8）；
 * ⑥ 键盘：listbox + 漫游 tabindex（P0-6）；
 * ⑦ 空态：三种（P0-12）。
 *
 * ## 它仍是「当前会话」的唯一发起方
 *
 * 只有本视图的用户操作会改「正在看哪个会话」（新建 / 切换 / 改名 / 删除）。
 * 它写 `curId` 进共享层，另外两个 iframe 通过 `storage` 事件知道。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Button, IconButton, Modal, StatusDot } from '@osteosome/ui'
import type { SessionMeta } from '@osteosome/shared'
import { BUCKET_LABEL, bucketOf, timeAgo, type BucketKey } from '../state/buckets'
import { useListPrefs } from '../state/list-prefs'
import { useSessionMotion } from '../state/motion'
import { currentSessionId, setCurrentSessionId, useSessionState } from '../state'

const sessions = useSessionState()
const curId = currentSessionId()
const motion = useSessionMotion()
const prefs = useListPrefs()

const railEl = ref<HTMLElement | null>(null)
const searchInput = ref<HTMLInputElement | null>(null)
const query = ref('')
const searchOpen = ref(false)
const renamingId = ref('')
const renameText = ref('')
const confirmDeleteId = ref('')
const focusId = ref('')
const toast = ref('')
let toastTimer: ReturnType<typeof setTimeout> | null = null
let clockTimer: ReturnType<typeof setInterval> | null = null
const now = ref(Date.now())

const menu = ref<{ id: string; x: number; y: number } | null>(null)

const filtered = computed<SessionMeta[]>(() => {
  const q = query.value.trim().toLowerCase()
  if (!q) return sessions.list.value
  return sessions.list.value.filter((m) => (m.title || '').toLowerCase().includes(q))
})

interface ListRow {
  meta: SessionMeta
  /** 0 = 顶层；>0 = 子会话缩进层数（P2-3） */
  depth: number
  hasChildren: boolean
  /** 该行作为父时被折叠 */
  collapsed: boolean
}

interface RowGroup {
  key: BucketKey
  label: string
  rows: ListRow[]
  collapsed: boolean
}

/** 桶内排序：手动顺序里的按手动排，其余（新会话）浮到顶部按 recency */
function sortWithinBucket(list: SessionMeta[], manual: string[]): SessionMeta[] {
  if (manual.length === 0) return list
  const known = list.filter((m) => manual.includes(m.id)).sort((a, b) => manual.indexOf(a.id) - manual.indexOf(b.id))
  const unknown = list.filter((m) => !manual.includes(m.id))
  return [...unknown, ...known]
}

/**
 * 把桶内会话铺成「带缩进的树」（P2-3）：`parentId` 指向同桶内某行的 → 挂在它下面；
 * 指向不存在/不可见父的 → 当顶层。递归带 `visited` 防环（坏数据不该让渲染死循环）。
 */
function buildRows(items: SessionMeta[], searching: boolean): ListRow[] {
  const present = new Set(items.map((m) => m.id))
  const childrenOf = (id: string): SessionMeta[] => items.filter((m) => m.parentId === id)
  const isChild = new Set(items.filter((m) => m.parentId && present.has(m.parentId)).map((m) => m.id))
  const rows: ListRow[] = []
  const visited = new Set<string>()
  /** 被折叠父节点藏起来的子树 —— 末尾的「环兜底」不能把它们又当顶层补回来 */
  const hidden = new Set<string>()
  const hideSubtree = (meta: SessionMeta): void => {
    if (hidden.has(meta.id)) return
    hidden.add(meta.id)
    for (const k of childrenOf(meta.id)) hideSubtree(k)
  }
  const walk = (meta: SessionMeta, depth: number): void => {
    if (visited.has(meta.id)) return
    visited.add(meta.id)
    const kids = childrenOf(meta.id).filter((k) => !visited.has(k.id))
    const collapsed = !searching && prefs.isCollapsed(`parent:${meta.id}`)
    rows.push({ meta, depth, hasChildren: kids.length > 0, collapsed })
    if (kids.length > 0 && !collapsed) for (const k of kids) walk(k, depth + 1)
    else for (const k of kids) hideSubtree(k)
  }
  for (const m of items.filter((x) => !isChild.has(x.id))) walk(m, 0)
  // 兜底：只有「环内成员」（既非根、又没被折叠藏起来）才当顶层补上，避免死循环丢数据
  for (const m of items) if (!visited.has(m.id) && !hidden.has(m.id)) walk(m, 0)
  return rows
}

const groups = computed<RowGroup[]>(() => {
  const searching = query.value.trim().length > 0
  const byBucket = new Map<BucketKey, SessionMeta[]>()
  const nowMs = now.value
  for (const m of filtered.value) {
    const b = bucketOf(m, nowMs)
    const arr = byBucket.get(b)
    if (arr) arr.push(m)
    else byBucket.set(b, [m])
  }
  const baseOrder: BucketKey[] = ['pin', 'today', 'yesterday', 'week', 'earlier', 'archived']
  const pinned = baseOrder.filter((k) => prefs.isGroupPinned(k))
  const rest = baseOrder.filter((k) => !prefs.isGroupPinned(k))
  const out: RowGroup[] = []
  for (const k of [...pinned, ...rest]) {
    const list = byBucket.get(k)
    if (!list || list.length === 0) continue
    const manual = k === 'pin' || k === 'archived' ? [] : prefs.orderFor(k)
    out.push({
      key: k,
      label: BUCKET_LABEL[k],
      rows: buildRows(sortWithinBucket(list, manual), searching),
      // 搜索时强制展开全部分组（P4b §6）
      collapsed: searching ? false : prefs.isCollapsed(k),
    })
  }
  return out
})

/** 键盘漫游：只走视觉可见的行（折叠组 / 折叠父节点内的跳过），且只移焦点不切会话 */
const visibleIds = computed<string[]>(() =>
  groups.value.flatMap((g) => (g.collapsed ? [] : g.rows.map((r) => r.meta.id))),
)

const menuMeta = computed(() => (menu.value ? sessions.list.value.find((m) => m.id === menu.value!.id) : undefined))
const confirmDeleteTitle = computed(
  () => sessions.list.value.find((m) => m.id === confirmDeleteId.value)?.title ?? '',
)

function showToast(text: string): void {
  toast.value = text
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => {
    toast.value = ''
  }, 2400)
}

function motionLabel(id: string): string {
  const label: Record<string, string> = {
    idle: '空闲', thinking: '思考中', listening: '等待确认', working: '执行工具', speaking: '回复中', success: '已完成', error: '出错',
  }
  return label[motion.motionOf(id)] ?? ''
}

function isUnread(meta: SessionMeta): boolean {
  // 运行中的会话不显示未读点 —— 你正看着它
  if (meta.id === curId.value) return false
  return prefs.isUnread(meta.id, meta.updatedAt)
}

function onSelect(meta: SessionMeta): void {
  setCurrentSessionId(meta.id)
  prefs.markSeen(meta.id, Date.parse(meta.updatedAt))
  menu.value = null
}

async function onCreate(): Promise<void> {
  const id = await sessions.create()
  if (id) prefs.markSeen(id, Date.now())
}

function toggleSearch(): void {  searchOpen.value = !searchOpen.value
  if (searchOpen.value) {
    void nextTick(() => searchInput.value?.focus())
  } else {
    query.value = ''
  }
}
function closeSearch(): void {
  searchOpen.value = false
  query.value = ''
}

function setRenameInput(el: unknown): void {
  if (el instanceof HTMLInputElement) void nextTick(() => el.focus())
}
function startRename(meta: SessionMeta): void {
  menu.value = null
  renamingId.value = meta.id
  renameText.value = meta.title
}
function cancelRename(): void {
  renamingId.value = ''
  renameText.value = ''
}
async function commitRename(meta: SessionMeta): Promise<void> {  if (renamingId.value !== meta.id) return
  const title = renameText.value.trim()
  renamingId.value = ''
  if (title && title !== meta.title) await sessions.rename(meta.id, title)
}

async function onArchive(meta: SessionMeta): Promise<void> {
  await sessions.archive(meta.id, !meta.archived)
}

/** 折叠/展开某父会话的子会话（P2-3；本地偏好，不写库） */
function toggleParent(id: string): void {
  prefs.toggleGroup(`parent:${id}`)
}

function openMenu(event: MouseEvent, meta: SessionMeta): void {
  const margin = 180
  const x = Math.min(event.clientX, window.innerWidth - margin)
  const y = Math.min(event.clientY, window.innerHeight - 220)
  menu.value = { id: meta.id, x, y }
}
function closeMenu(): void {
  menu.value = null
}
async function menuPin(): Promise<void> {
  const m = menuMeta.value
  if (m) await sessions.pin(m.id, !m.pinned)
  closeMenu()
}
function menuRename(): void {
  const m = menuMeta.value
  closeMenu()
  if (m) startRename(m)
}
async function menuCopyId(): Promise<void> {
  const m = menuMeta.value
  closeMenu()
  if (!m) return
  try {
    await navigator.clipboard.writeText(m.id)
    showToast('已复制会话 ID')
  } catch {
    showToast('复制失败（浏览器拒绝）')
  }
}
async function menuArchive(): Promise<void> {
  const m = menuMeta.value
  if (m) await sessions.archive(m.id, !m.archived)
  closeMenu()
}
function menuExport(): void {
  const m = menuMeta.value
  closeMenu()
  if (!m) return
  void downloadExport(m.id)
}
async function downloadExport(id: string): Promise<void> {
  const result = await sessions.exportSession(id)
  if (!result) {
    showToast('导出失败（会话不存在或服务未响应）')
    return
  }
  try {
    const blob = new Blob([result.content], { type: 'text/markdown;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = result.filename
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
    showToast('已导出')
  } catch {
    showToast('导出失败（浏览器拒绝下载）')
  }
}
function menuDelete(): void {
  const m = menuMeta.value
  closeMenu()
  if (m) confirmDeleteId.value = m.id
}
async function doDelete(): Promise<void> {
  const id = confirmDeleteId.value
  confirmDeleteId.value = ''
  if (id) await sessions.remove(id)
}

// ── 键盘（P0-6） ────────────────────────────────
function focusRow(id: string): void {
  focusId.value = id
  void nextTick(() => (document.getElementById(`srow-${id}`) as HTMLElement | null)?.focus())
}
function onKeydown(event: KeyboardEvent): void {
  const ids = visibleIds.value
  if (ids.length === 0) return
  const idx = ids.indexOf(focusId.value)
  switch (event.key) {
    case 'ArrowDown':
      event.preventDefault()
      focusRow(ids[Math.min(idx + 1, ids.length - 1)] ?? ids[0])
      break
    case 'ArrowUp':
      event.preventDefault()
      focusRow(ids[Math.max(idx - 1, 0)] ?? ids[0])
      break
    case 'Enter': {
      const meta = sessions.list.value.find((m) => m.id === focusId.value)
      if (meta) onSelect(meta)
      break
    }
    case 'Delete': {
      if (focusId.value) confirmDeleteId.value = focusId.value
      break
    }
    case 'F2': {
      const meta = sessions.list.value.find((m) => m.id === focusId.value)
      if (meta) startRename(meta)
      break
    }
    case 'Escape':
      // 一次只关一层
      if (menu.value) closeMenu()
      else if (confirmDeleteId.value) confirmDeleteId.value = ''
      else if (searchOpen.value) closeSearch()
      break
    default:
      break
  }
}

function onGlobalKeydown(event: KeyboardEvent): void {
  const target = event.target as HTMLElement | null
  const typing = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault()
    searchOpen.value = true
    void nextTick(() => searchInput.value?.focus())
    return
  }
  if (event.key === '/' && !typing) {
    event.preventDefault()
    searchOpen.value = true
    void nextTick(() => searchInput.value?.focus())
  }
  if (event.key === 'Escape') closeMenu()
}
function onDocClick(): void {
  closeMenu()
}

// ── 拖拽（P0-11）：只允许同桶、非置顶、非归档、非搜索态 ──
const dragId = ref('')
function canDrag(bucket: BucketKey): boolean {
  return !query.value.trim() && bucket !== 'pin' && bucket !== 'archived'
}
function onDragStart(event: DragEvent, meta: SessionMeta): void {
  dragId.value = meta.id
  event.dataTransfer?.setData('text/plain', meta.id)
}
function onDragOver(event: DragEvent, bucket: BucketKey, _meta: SessionMeta): void {
  if (!dragId.value) return
  const dragged = sessions.list.value.find((m) => m.id === dragId.value)
  if (!dragged) return
  if (bucketOf(dragged, now.value) !== bucket) {
    event.dataTransfer!.dropEffect = 'none'
    return
  }
  event.preventDefault()
  event.dataTransfer!.dropEffect = 'move'
}
function onDrop(event: DragEvent, bucket: BucketKey): void {
  event.preventDefault()
  const id = dragId.value
  dragId.value = ''
  if (!id) return
  const dragged = sessions.list.value.find((m) => m.id === id)
  if (!dragged) return
  if (bucketOf(dragged, now.value) !== bucket) {
    showToast('不能在时间分组之间拖拽')
    return
  }
  if (bucket === 'pin' || bucket === 'archived') return
  // 目标位置：把 id 提到当前该桶显示顺序里落点（简化为追加到桶首，保留其余）
  const group = groups.value.find((g) => g.key === bucket)
  if (!group) return
  const current = group.rows.map((r) => r.meta.id).filter((x) => x !== id)
  const order = [id, ...current]
  prefs.setOrder(bucket, order)
}
function onDragEnd(): void {
  dragId.value = ''
}

// ── 生命周期 ────────────────────────────────────
onMounted(() => {
  motion.bind()
  document.addEventListener('click', onDocClick)
  window.addEventListener('keydown', onGlobalKeydown)
  clockTimer = setInterval(() => {
    now.value = Date.now()
  }, 30_000)
  if (!sessions.hydrated.value) void sessions.bootstrap()
})

onBeforeUnmount(() => {
  motion.dispose()
  document.removeEventListener('click', onDocClick)
  window.removeEventListener('keydown', onGlobalKeydown)
  if (clockTimer) clearInterval(clockTimer)
  if (toastTimer) clearTimeout(toastTimer)
  sessions.dispose()
})

// 初始焦点 + 焦点失效兜底
watch(
  visibleIds,
  (ids) => {
    if (!ids.includes(focusId.value)) focusId.value = ids[0] ?? ''
  },
  { immediate: true },
)

// 当前会话被删 → 清 curId（这是 ① 的职责，见 state/session.ts 文件头）
watch(
  () => [curId.value, sessions.list.value.length, sessions.hydrated.value] as const,
  () => {
    if (!curId.value || !sessions.hydrated.value) return
    if (sessions.list.value.some((m) => m.id === curId.value)) return
    setCurrentSessionId('')
  },
)
</script>

<style scoped>
/* P0-13：窄栏退化用容器查询，不是媒体查询 */
.rail {
  container-type: inline-size;
  position: relative;
  display: flex;
  flex-direction: column;
  min-height: 0;
  min-width: 0;
  height: 100%;
  background: var(--color-surface);
  color: var(--color-text);
  font-size: var(--text-sm);
}
.rail__head {
  flex: none;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-3) var(--space-3) var(--space-2);
}
.rail__title { font-size: var(--text-sm); font-weight: 600; color: var(--color-text); letter-spacing: 0.3px; }
.rail__n { font-size: var(--text-xs); color: var(--color-text-muted); font-variant-numeric: tabular-nums; }
.rail__sp { flex: 1; }

.rail__search { flex: none; padding: 0 var(--space-3) var(--space-2); }
.rail__search input {
  width: 100%; padding: 6px 9px; border-radius: var(--radius-md);
  border: 1px solid var(--color-border); background: var(--color-bg); color: var(--color-text);
  font: inherit; font-size: var(--text-xs); outline: none;
  transition: border-color var(--duration-fast);
}
.rail__search input:focus { border-color: var(--color-primary); box-shadow: 0 0 0 2px var(--color-primary-soft); }
.rail__search input::placeholder { color: var(--color-text-muted); }

.rail__body { flex: 1; min-height: 0; overflow-y: auto; padding: 0 6px 10px; }
.rail__body::-webkit-scrollbar { width: 8px; }
.rail__body::-webkit-scrollbar-thumb { background: var(--color-border); border-radius: var(--radius-full); }
.rail__body::-webkit-scrollbar-track { background: transparent; }

.grp { margin-bottom: var(--space-1); }
.grp__head {
  display: flex; align-items: center; gap: 6px; padding: 5px 6px; cursor: pointer;
  border-radius: var(--radius-md); user-select: none;
  transition: background var(--duration-fast);
}
.grp__head:hover { background: var(--color-surface-2); }
.grp__name { font-size: var(--text-xs); font-weight: 600; color: var(--color-text-muted); letter-spacing: 0.4px; white-space: nowrap; }
.grp__count { font-size: var(--text-xs); color: var(--color-text-muted); opacity: 0.75; font-variant-numeric: tabular-nums; }
.grp__sp { flex: 1; min-width: 0; }
.grp__arrow {
  width: 18px; height: 18px; flex: none; display: inline-flex; align-items: center; justify-content: center;
  font-size: 9px; line-height: 1; color: var(--color-text-muted); border-radius: var(--radius-sm);
  transition: transform var(--duration-fast), color var(--duration-fast);
}
.grp__arrow.is-open { transform: rotate(90deg); }
.grp__pin {
  width: 18px; height: 18px; flex: none; display: inline-flex; align-items: center; justify-content: center;
  border: 0; background: transparent; color: var(--color-text-muted); cursor: pointer; padding: 0;
  font-size: 11px; line-height: 1; border-radius: var(--radius-sm); opacity: 0;
  transition: transform var(--duration-fast), color var(--duration-fast), background var(--duration-fast);
}
.grp__head:hover .grp__pin { opacity: 1; }
.grp__pin.is-on { opacity: 1; color: var(--color-warning); }
.grp__pin:hover { background: var(--color-surface-3); }

.srow { position: relative; display: flex; align-items: center; gap: 2px; border-radius: var(--radius-md); margin-bottom: 1px; }
.srow__main {
  flex: 1; min-width: 0; display: flex; align-items: center; gap: var(--space-2);
  padding: 5px 6px; border-radius: var(--radius-md); cursor: pointer; outline: none;
  transition: background var(--duration-fast);
}
.srow__main:hover { background: var(--color-surface-2); }
.srow__main:focus-visible { box-shadow: 0 0 0 2px var(--color-focus-ring); }
.srow.is-active > .srow__main { background: var(--color-primary-soft); }
.srow.is-active::before {
  content: ''; position: absolute; left: 0; top: 4px; bottom: 4px; width: 2px;
  background: var(--color-primary); border-radius: 1px;
}
/* 两行形态（有预览）：状态点与标题首行对齐 */
.srow__main--2 { align-items: flex-start; }
.srow__main--2 :deep(.ui-status-dot) { margin-top: 5px; }
.srow__col { flex: 1; min-width: 0; }
.srow__line { display: flex; align-items: center; gap: 5px; min-width: 0; }
.srow__title {
  flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-size: var(--text-xs); color: var(--color-text);
}
.srow.is-active .srow__title { font-weight: 600; }
.srow.is-archived .srow__title { color: var(--color-text-muted); }
.srow__pin { flex: none; color: var(--color-warning); font-size: 10px; }
.srow__warn { flex: none; color: var(--color-danger); font-size: 10px; }
.srow__unread { flex: none; width: 5px; height: 5px; border-radius: var(--radius-full); background: var(--color-primary); }
.srow__prev {
  margin-top: 1px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-size: var(--text-xs); color: var(--color-text-muted); line-height: 1.4;
}
.srow__prev:empty { display: none; }
.srow__time {
  flex: none; font-size: var(--text-xs); color: var(--color-text-muted);
  font-variant-numeric: tabular-nums; transition: opacity var(--duration-fast);
}
/* 时间 ↔ 操作 互斥：hover / 键盘聚焦时把时间推到透明，按钮淡入 */
.srow:hover > .srow__main > .srow__time,
.srow:focus-within > .srow__main > .srow__time { opacity: 0; }
.srow__edit {
  flex: 1; min-width: 0; padding: 3px 7px; border: 1px solid var(--color-primary);
  border-radius: var(--radius-sm); background: var(--color-bg); color: var(--color-text);
  font: inherit; font-size: var(--text-xs); outline: none; box-shadow: 0 0 0 2px var(--color-primary-soft);
}
.srow__acts {
  position: absolute; right: 4px; top: 50%; transform: translateY(-50%);
  display: flex; align-items: center; gap: 1px; padding-left: 10px; opacity: 0;
  background: linear-gradient(90deg, transparent, var(--color-surface-2) 8px);
  transition: opacity var(--duration-fast); pointer-events: none;
}
.srow:hover > .srow__acts, .srow:focus-within > .srow__acts { opacity: 1; pointer-events: auto; }
.srow.is-active:hover > .srow__acts, .srow.is-active:focus-within > .srow__acts {
  background: linear-gradient(90deg, transparent, var(--color-primary-soft) 8px);
}
.srow__act {
  width: 19px; height: 19px; display: inline-flex; align-items: center; justify-content: center;
  border: 0; border-radius: var(--radius-sm); background: transparent; color: var(--color-text-muted);
  cursor: pointer; padding: 0; font-size: 11px; line-height: 1;
}
.srow__act:hover { background: var(--color-surface-3); color: var(--color-text); }
.srow__act--danger:hover { background: var(--color-danger-soft); color: var(--color-danger); }

/* P2-3：子会话折叠箭头与缩进。点击不切换当前会话（.stop 已挡住冒泡） */
.srow__chev {
  flex: none; width: 16px; height: 16px; display: inline-flex; align-items: center; justify-content: center;
  border: 0; background: transparent; color: var(--color-text-muted); cursor: pointer; padding: 0;
  font-size: 8px; line-height: 1; border-radius: var(--radius-sm); transition: transform var(--duration-fast);
}
.srow__chev.is-open { transform: rotate(90deg); }
.srow__chev:hover { background: var(--color-surface-3); color: var(--color-text); }
.srow__chev--spacer { visibility: hidden; }
.srow--child .srow__title { font-size: var(--text-xs); }

.rail__empty { padding: var(--space-6) var(--space-4); text-align: center; color: var(--color-text-muted); }
.rail__empty .ic { font-size: 22px; display: block; margin-bottom: var(--space-2); opacity: 0.7; }
.rail__empty .t { font-size: var(--text-xs); color: var(--color-text); margin-bottom: 2px; }
.rail__empty .d { font-size: var(--text-xs); line-height: 1.6; }

.menu {
  position: fixed; z-index: var(--z-dropdown); min-width: 168px; padding: 4px 0;
  background: var(--color-surface); border: 1px solid var(--color-border);
  border-radius: var(--radius-lg); box-shadow: var(--shadow-lg);
}
.menu__i {
  display: flex; align-items: center; gap: var(--space-2); width: 100%; border: 0;
  background: transparent; color: var(--color-text); font: inherit; font-size: var(--text-xs);
  text-align: left; padding: 6px var(--space-3); cursor: pointer;
}
.menu__i:hover { background: var(--color-surface-2); }
.menu__i .ic { width: 14px; text-align: center; color: var(--color-text-muted); }
.menu__i--danger { color: var(--color-danger); }
.menu__i--danger .ic { color: var(--color-danger); }
.menu__i--danger:hover { background: var(--color-danger-soft); }
.menu__sep { height: 1px; background: var(--color-border); margin: 4px 0; }

.rail__toast {
  position: absolute; left: 50%; bottom: 12px; transform: translateX(-50%);
  background: var(--color-text); color: var(--color-bg); font-size: var(--text-xs);
  padding: 6px 12px; border-radius: var(--radius-full); box-shadow: var(--shadow-lg); white-space: nowrap; z-index: 60;
}

.rail__head :deep(.ui-icon-button.is-on) { background: var(--color-primary-soft); color: var(--color-primary); }
.rail__head :deep(.ui-icon-button.ib--new) { background: var(--color-primary); color: var(--color-text-inverse); }
.rail__head :deep(.ui-icon-button.ib--new:hover:not(:disabled)) { background: var(--color-primary-hover); color: var(--color-text-inverse); }
.rail__head :deep(.ui-icon-button.ib--new .ui-icon-button__icon) { color: var(--color-text-inverse); }

/* P0-13：< 176px 时丢掉预览行、时间与分组计数；列表永远可操作 */
@container (max-width: 176px) {
  .srow__time { display: none; }
  .grp__count { display: none; }
  .srow__prev { display: none; }
}
</style>
