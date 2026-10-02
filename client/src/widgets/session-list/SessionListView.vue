<template>
  <Card title="会话" class="session-list">
    <div class="session-list__toolbar">
      <Button size="sm" :loading="store.loading" @click="onCreate">新建会话</Button>
      <Button v-if="store.current" size="sm" variant="ghost" @click="openRename">重命名</Button>
      <Button v-if="store.current" size="sm" variant="ghost" @click="confirmDeleteOpen = true">删除</Button>
    </div>

    <List v-if="store.list.length" :items="store.list" @select="onSelect">
      <template #item="{ item }">
        <div
          v-if="asMeta(item)"
          class="session-list__row"
          :class="{ 'session-list__row--active': asMeta(item)!.id === store.curId }"
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

  <Modal v-model:open="confirmDeleteOpen" :title="`⚠ 删除「${store.current?.title ?? ''}」？`">
    <p>删除后会话及其消息将不可恢复。</p>
    <template #footer>
      <Button size="sm" variant="ghost" @click="confirmDeleteOpen = false">取消</Button>
      <Button size="sm" variant="danger" @click="onDelete">确认删除</Button>
    </template>
  </Modal>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import Button from '@/components/ui/Button.vue'
import Card from '@/components/ui/Card.vue'
import EmptyState from '@/components/ui/EmptyState.vue'
import Input from '@/components/ui/Input.vue'
import List from '@/components/ui/List.vue'
import Modal from '@/components/ui/Modal.vue'
import { useSessionStore } from '@/stores/session.store'
import type { SessionMeta } from '@osteosome/shared'

const store = useSessionStore()
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
  const meta = store.list[index] as SessionMeta | undefined
  if (meta) store.select(meta.id)
}

async function onCreate(): Promise<void> {
  await store.create()
}

function openRename(): void {
  renameText.value = store.current?.title ?? ''
  renameOpen.value = true
}

async function onRename(): Promise<void> {
  if (store.current && renameText.value.trim()) await store.rename(store.current.id, renameText.value)
  renameOpen.value = false
}

async function onDelete(): Promise<void> {
  confirmDeleteOpen.value = false
  if (store.current) await store.remove(store.current.id)
}

onMounted(() => {
  if (!store.hydrated) void store.bootstrap()
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
