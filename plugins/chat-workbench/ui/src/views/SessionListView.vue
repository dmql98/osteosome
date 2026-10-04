<template>
  <Card title="会话" class="session-list">
    <div class="session-list__toolbar">
      <Button size="sm" :loading="sessions.loading.value" @click="onCreate">新建会话</Button>
      <Button v-if="currentMeta" size="sm" variant="ghost" @click="openRename">重命名</Button>
      <Button v-if="currentMeta" size="sm" variant="ghost" @click="confirmDeleteOpen = true">删除</Button>
    </div>

    <List v-if="sessions.list.value.length" :items="sessions.list.value" @select="onSelect">
      <template #item="{ item }">
        <div
          v-if="asMeta(item)"
          class="session-list__row"
          :class="{ 'session-list__row--active': asMeta(item)!.id === curId }"
        >
          <span class="session-list__title">{{ asMeta(item)!.title || '新会话' }}</span>
          <span class="session-list__time">{{ formatTime(asMeta(item)!.updatedAt) }}</span>
          <span v-if="asMeta(item)!.corrupted" class="session-list__corrupted" title="该会话文件损坏">⚠</span>
        </div>
      </template>
    </List>
    <EmptyState v-else icon="💬" title="还没有会话" description="点击「新建会话」开始一段对话。" />
  </Card>

  <Modal v-model:open="renameOpen" title="重命名会话">
    <Input v-model="renameText" placeholder="会话标题" aria-label="会话标题" />
    <template #footer>
      <Button size="sm" variant="ghost" @click="renameOpen = false">取消</Button>
      <Button size="sm" @click="onRename">保存</Button>
    </template>
  </Modal>

  <Modal v-model:open="confirmDeleteOpen" :title="`⚠ 删除「${currentMeta?.title ?? ''}」？`">
    <p>删除后会话及其消息将不可恢复。</p>
    <template #footer>
      <Button size="sm" variant="ghost" @click="confirmDeleteOpen = false">取消</Button>
      <Button size="sm" variant="danger" @click="onDelete">确认删除</Button>
    </template>
  </Modal>
</template>

<script setup lang="ts">
/**
 * ① 会话列表 —— 写 `curId` 的那一个视图。
 *
 * ## 它是「当前会话」的**唯一发起方**
 *
 * 三盒里只有这个视图的用户操作会改变「正在看哪个会话」（新建 / 切换 / 重命名 / 删除）。
 * 它写 `curId` 进共享层，另外两个 iframe 通过 `storage` 事件知道。
 *
 * ## 为什么 `curId` 要用 `computed` 而不是直接写 store
 *
 * 它是共享层里的 ref（跨 iframe），不是本视图的状态。
 * 包一层 computed 是为了让「读」在本视图内保持响应式 —— 直接 `.value` 也行，
 * 但模板里 `curId` 直接就是 ref 值更清楚，少一次 `unref` 心智负担。
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { Button, Card, EmptyState, Input, List, Modal } from '@osteosome/ui'
import type { SessionMeta } from '@osteosome/shared'
import { currentSessionId, useSessionState } from '../state'

const sessions = useSessionState()
const curId = currentSessionId()
const currentMeta = computed(() => sessions.current())
const renameOpen = ref(false)
const confirmDeleteOpen = ref(false)
const renameText = ref('')

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString()
  } catch {
    return iso
  }
}

/** List 槽位是 unknown，收窄为 SessionMeta（模板用） */
function asMeta(item: unknown): SessionMeta | undefined {
  if (!item || typeof item !== 'object') return undefined
  const m = item as Partial<SessionMeta>
  return typeof m.id === 'string' ? (m as SessionMeta) : undefined
}

function onSelect(index: number): void {
  const meta = sessions.list.value[index] as SessionMeta | undefined
  if (meta) sessions.select(meta.id)
}

async function onCreate(): Promise<void> {
  await sessions.create()
}

function openRename(): void {
  renameText.value = currentMeta.value?.title ?? ''
  renameOpen.value = true
}

async function onRename(): Promise<void> {
  if (currentMeta.value && renameText.value.trim()) {
    await sessions.rename(currentMeta.value.id, renameText.value)
  }
  renameOpen.value = false
}

async function onDelete(): Promise<void> {
  confirmDeleteOpen.value = false
  if (currentMeta.value) await sessions.remove(currentMeta.value.id)
}

onMounted(() => {
  if (!sessions.hydrated.value) void sessions.bootstrap()
})

onBeforeUnmount(() => {
  // 事件退订。iframe 被移除时组件卸载 —— 不退订的话，SSE 客户端会一直往一个
  // 已经不在文档里的组件写 ref，而症状是「关掉一个盒子之后内存涨、
  // 切会话时偶发报 'cannot read properties of undefined'」。
  sessions.dispose()
})
</script>

<style scoped>
.session-list { display: flex; flex-direction: column; gap: var(--space-3); }
.session-list__toolbar { display: flex; gap: var(--space-2); flex-wrap: wrap; }
.session-list__row { display: flex; align-items: baseline; gap: var(--space-2); width: 100%; }
.session-list__row--active .session-list__title { color: var(--color-primary); font-weight: 600; }
.session-list__title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.session-list__time { font-size: var(--text-xs); color: var(--color-text-muted); flex: none; }
.session-list__corrupted { color: var(--color-danger); flex: none; }
</style>