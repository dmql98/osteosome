<template>
  <Card title="工作区" class="ws">
    <div v-if="!curId" class="ws__empty">
      <EmptyState icon="🗂" title="没有当前会话" description="先在会话列表里选一个会话。" />
    </div>

    <template v-else>
      <section class="ws__row">
        <div class="ws__col">
          <div class="ws__label">项目目录</div>
          <div class="ws__value" :data-testid="'ws-project'">
            <code>{{ current?.workspace || '（未绑定项目）' }}</code>
          </div>
        </div>
        <Button size="sm" variant="ghost" :disabled="!current?.workspace" @click="open(current!.workspace!)">打开</Button>
        <Button size="sm" @click="togglePicker">{{ picking ? '取消' : '选择项目' }}</Button>
      </section>

      <!-- 目录选择器（走 workspace.list；桌面 Tauri 下可换原生 dialog） -->
      <section v-if="picking" class="ws__picker" data-testid="ws-picker">
        <div class="ws__crumbs">
          <button class="ws__crumb" @click="list('')">根</button>
          <button v-if="currentPath" class="ws__crumb" @click="list(parentPath ?? '')">..</button>
          <span class="ws__path mono">{{ currentPath || '（盘符 / 快捷入口）' }}</span>
        </div>
        <div class="ws__grid">
          <button v-for="e in entries" :key="e.path" class="ws__entry" :class="{ 'is-dir': e.isDir }" @click="e.isDir ? list(e.path) : undefined" @dblclick="e.isDir ? choose(e.path) : undefined">
            {{ e.isDir ? '📁' : '📄' }} {{ e.name }}
          </button>
          <button v-for="r in roots" :key="r.path" class="ws__entry is-dir" @click="list(r.path)">{{ r.kind === 'drive' ? '💽' : '⭐' }} {{ r.name }}</button>
        </div>
        <div class="ws__picker-actions">
          <span class="ws__hint">点目录进入，双击选为项目</span>
          <span class="ws__sp" />
          <Button v-if="currentPath" size="sm" @click="choose(currentPath)">选这个目录</Button>
        </div>
      </section>

      <section class="ws__row" v-if="(current?.workspaces ?? []).length">
        <div class="ws__col">
          <div class="ws__label">授权根（越界授权后加入）</div>
          <ul class="ws__roots">
            <li v-for="w in current!.workspaces" :key="w" class="ws__root">
              <code>{{ w }}</code>
              <button class="ws__x" title="移除" @click="removeRoot(w)">×</button>
            </li>
          </ul>
        </div>
      </section>

      <p class="ws__note">沙箱 = 项目目录 ∪ 授权根；模型只能读写这些目录里的文件。未绑定项目时任何路径都越界，第一次调用会弹一次工作区授权。</p>
    </template>
  </Card>
</template>

<script setup lang="ts">
/**
 * widget.session-workspace —— 会话工作区（P7 M0 WS-0.6）。
 *
 * 项目区（只读 + 打开）+ 授权根（×）+ 目录选择器（走 `workspace.list`，只列目录不读文件）。
 * 写走 `session.set.workspace`（唯一写者 = session 服务）。
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { Button, Card, EmptyState } from '@osteosome/ui'
import { sse, useCommand } from '@osteosome/core-client'
import type { DirEntry, DirRoot } from '@osteosome/shared'
import { currentSessionId, useSessionState } from '../state'

const sessions = useSessionState()
const curId = currentSessionId()
const current = computed(() => sessions.list.value.find((m) => m.id === curId.value))

const picking = ref(false)
const entries = ref<DirEntry[]>([])
const roots = ref<DirRoot[]>([])
const currentPath = ref('')
const parentPath = ref<string | null>(null)

let unsubs: Array<() => void> = []

async function list(path: string): Promise<void> {
  const { send } = useCommand()
  await send('workspace.list', { requestId: `wl-${Date.now()}`, path })
}
async function open(path: string): Promise<void> {
  const { send } = useCommand()
  await send('workspace.open', { requestId: `wo-${Date.now()}`, path })
}
async function choose(path: string): Promise<void> {
  if (!curId.value) return
  const { send } = useCommand()
  await send('session.set.workspace', { requestId: `wset-${Date.now()}`, sessionId: curId.value, workspace: path })
  picking.value = false
}
async function removeRoot(root: string): Promise<void> {
  if (!curId.value) return
  const { send } = useCommand()
  await send('session.set.workspace', { requestId: `wrm-${Date.now()}`, sessionId: curId.value, removeRoot: root })
}
function togglePicker(): void {
  picking.value = !picking.value
  if (picking.value) void list('')
}

onMounted(() => {
  void sessions.bootstrap()
  unsubs = [
    sse.subscribe('workspace.list.result', (payload) => {
      const p = payload as { entries?: DirEntry[]; currentPath?: string; parentPath?: string | null; roots?: DirRoot[] } | null
      if (!p) return
      entries.value = p.entries ?? []
      roots.value = p.roots ?? []
      currentPath.value = p.currentPath ?? ''
      parentPath.value = p.parentPath ?? null
    }),
  ]
})
onBeforeUnmount(() => {
  for (const off of unsubs) off()
  unsubs = []
  sessions.dispose()
})
</script>

<style scoped>
.ws { display: flex; flex-direction: column; height: 100%; min-height: 0; }
.ws__empty { padding: var(--space-5); }
.ws__row { display: flex; align-items: flex-end; gap: var(--space-2); margin-bottom: var(--space-3); }
.ws__col { flex: 1; min-width: 0; }
.ws__label { font-size: var(--text-xs); color: var(--color-text-muted); margin-bottom: 2px; }
.ws__value code { font-family: var(--font-mono); font-size: var(--text-xs); word-break: break-all; }
.ws__picker { border: 1px solid var(--color-border); border-radius: var(--radius-md); padding: var(--space-3); margin-bottom: var(--space-3); }
.ws__crumbs { display: flex; align-items: center; gap: var(--space-2); margin-bottom: var(--space-2); }
.ws__crumb { border: 1px solid var(--color-border); background: var(--color-surface); border-radius: var(--radius-sm); font-size: var(--text-xs); padding: 1px 8px; cursor: pointer; }
.ws__path { font-size: var(--text-xs); color: var(--color-text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ws__grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 2px; max-height: 240px; overflow-y: auto; }
.ws__entry { text-align: left; border: 0; background: transparent; font: inherit; font-size: var(--text-sm); padding: 4px 6px; border-radius: var(--radius-sm); cursor: pointer; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ws__entry:hover { background: var(--color-surface-2); }
.ws__entry.is-dir { color: var(--color-text); }
.ws__picker-actions { display: flex; align-items: center; gap: var(--space-2); margin-top: var(--space-2); }
.ws__hint { font-size: var(--text-xs); color: var(--color-text-muted); }
.ws__sp { flex: 1; }
.ws__roots { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; }
.ws__root { display: flex; align-items: center; gap: var(--space-2); }
.ws__root code { flex: 1; font-family: var(--font-mono); font-size: var(--text-xs); word-break: break-all; }
.ws__x { border: 0; background: transparent; color: var(--color-danger); cursor: pointer; font-size: var(--text-md); }
.ws__note { font-size: var(--text-xs); color: var(--color-text-muted); }
</style>
