<template>
  <div class="plugin-detail">
    <header class="plugin-detail__bar">
      <span class="plugin-detail__title">插件管理</span>
      <span class="plugin-detail__spacer"></span>
      <IconButton icon="×" size="sm" label="关闭窗口" @click="closeCurrentWindow" />
    </header>

    <div v-if="!plugin" class="plugin-detail__body plugin-detail__body--center">
      <EmptyState icon="🧩" title="插件不存在" :description="`未找到插件：${pluginId}`" />
    </div>

    <div v-else class="plugin-detail__body">
      <section class="plugin-hero">
        <div class="plugin-hero__icon">{{ plugin.icon }}</div>
        <div class="plugin-hero__info">
          <div class="plugin-hero__name">
            {{ plugin.name }}
            <span class="plugin-badge">v{{ plugin.version }}</span>
          </div>
          <div class="plugin-hero__meta">{{ authorLine }}</div>
          <div class="plugin-hero__status">
            <span class="dot" :class="statusDot"></span>{{ statusLabel }}
          </div>
        </div>
        <div class="plugin-hero__toggle">
          <span class="plugin-hero__toggle-label">{{ isEnabled ? '启用' : '停用' }}</span>
          <Switch :model-value="isEnabled" @update:model-value="onToggleEnabled" />
        </div>
      </section>

      <section class="detail-card">
        <header class="detail-card__head">介绍</header>
        <div class="detail-card__body">{{ plugin.description }}</div>
      </section>

      <section class="detail-card">
        <header class="detail-card__head">能力</header>
        <div class="detail-card__body">
          <div v-for="cap in plugin.capabilities" :key="cap.name" class="cap-row">
            <span class="cap-row__name">{{ cap.name }}</span>
            <span v-if="cap.detail" class="cap-row__detail">{{ cap.detail }}</span>
            <span class="cap-row__ok">✓</span>
          </div>
          <p v-if="!plugin.capabilities.length" class="detail-card__empty">该插件未声明服务层能力</p>
        </div>
      </section>

      <section class="detail-card">
        <header class="detail-card__head">组件（UI，用户装配）</header>
        <div class="detail-card__body">
          <div v-for="widgetId in plugin.widgets" :key="widgetId" class="widget-row">
            <div class="widget-row__info">
              <span class="widget-row__name">{{ widgetTitle(widgetId) }}</span>
              <span class="widget-row__id">{{ widgetId }}</span>
            </div>
            <span v-if="addedWidgetId === widgetId" class="widget-row__added">已加入 ✓</span>
            <Button
              size="sm"
              :variant="isEnabled ? 'primary' : 'ghost'"
              :disabled="!isEnabled"
              @click="addWidget(widgetId)"
            >
              ＋ 加入窗口
            </Button>
          </div>
          <p v-if="!isEnabled" class="widget-row__hint">插件已停用，启用后才能加入组件。</p>
        </div>
      </section>

      <section class="detail-card">
        <header class="detail-card__head">依赖</header>
        <div class="detail-card__body">
          <div v-for="dep in plugin.dependencies" :key="dep.id" class="dep-row">
            <span class="dot" :class="dependencyReady(dep) ? 'green' : 'yellow'"></span>
            <span>{{ dep.label }}</span>
            <span class="dep-row__state">{{ dependencyReady(dep) ? '已就绪' : '等待中' }}</span>
          </div>
          <p v-if="!plugin.dependencies.length" class="detail-card__empty">无依赖</p>
        </div>
      </section>

      <section class="danger-zone">
        <div class="danger-zone__title">危险区</div>
        <div class="danger-zone__actions">
          <Button size="sm" variant="ghost" @click="onToggleEnabled(!isEnabled)">
            {{ isEnabled ? '停用插件' : '启用插件' }}
          </Button>
          <Button size="sm" variant="danger" @click="confirmOpen = true">卸载插件</Button>
        </div>
      </section>
    </div>

    <Modal v-model:open="confirmOpen" :title="`⚠ 卸载「${plugin?.name ?? ''}」？`" :closable="true">
      <div class="uninstall-warn">
        卸载后：该插件组件会从所有窗口移除（共 {{ plugin?.widgets.length ?? 0 }} 个实例），以下能力将消失：
        <div class="uninstall-caps">
          <span v-for="cap in plugin?.capabilities ?? []" :key="cap.name">- {{ cap.name }}</span>
        </div>
        历史数据保留，重装后可恢复。
      </div>
      <template #footer>
        <Button size="sm" variant="ghost" @click="confirmOpen = false">取消</Button>
        <Button size="sm" variant="danger" @click="doUninstall">确认卸载</Button>
      </template>
    </Modal>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import Button from '@/components/ui/Button.vue'
import EmptyState from '@/components/ui/EmptyState.vue'
import IconButton from '@/components/ui/IconButton.vue'
import Modal from '@/components/ui/Modal.vue'
import Switch from '@/components/ui/Switch.vue'
import { getWidget } from '@/widgets/registry'
import { getPlugin, type PluginDependency } from './registry'
import { usePluginStore } from '@/stores/plugin.store'
import { useServiceStatus } from '@/core-sdk/useServiceStatus'
import { requestAddWidget, notifyPluginsChanged } from '@/layout/window-events'
import { closeCurrentWindow } from '@/tauri/plugin-window'

const props = defineProps<{ pluginId: string }>()

const store = usePluginStore()
const services = useServiceStatus()
const confirmOpen = ref(false)
const addedWidgetId = ref('')
let addedTimer: ReturnType<typeof setTimeout> | null = null

const plugin = computed(() => getPlugin(props.pluginId))
const isEnabled = computed(() => store.isEnabled(props.pluginId))
const statusDot = computed(() => (store.isInstalled(props.pluginId) ? (isEnabled.value ? 'green' : 'gray') : 'red'))
const statusLabel = computed(() => {
  if (!store.isInstalled(props.pluginId)) return '已卸载'
  return isEnabled.value ? '运行中' : '已停用'
})
const authorLine = computed(() => {
  const parts: string[] = []
  if (plugin.value?.author) parts.push(`作者: ${plugin.value.author}`)
  if (plugin.value?.license) parts.push(plugin.value.license)
  return parts.join(' · ') || '本地插件'
})

function widgetTitle(widgetId: string): string {
  return getWidget(widgetId)?.title ?? widgetId
}

function dependencyReady(dep: PluginDependency): boolean {
  const service = services.services[dep.id]
  if (service) return service.status === 'ready'
  return dep.ready !== false
}

function addWidget(widgetId: string): void {
  requestAddWidget(widgetId)
  addedWidgetId.value = widgetId
  if (addedTimer) clearTimeout(addedTimer)
  addedTimer = setTimeout(() => { addedWidgetId.value = '' }, 1600)
}

async function onToggleEnabled(value: boolean): Promise<void> {
  await store.setEnabled(props.pluginId, value)
  notifyPluginsChanged()
}

async function doUninstall(): Promise<void> {
  confirmOpen.value = false
  await store.uninstall(props.pluginId)
  notifyPluginsChanged()
  await closeCurrentWindow()
}

onMounted(() => {
  if (!store.hydrated) void store.bootstrap()
})
onBeforeUnmount(() => {
  if (addedTimer) clearTimeout(addedTimer)
})
</script>

<style scoped>
.plugin-detail { display: flex; flex-direction: column; height: 100%; background: var(--color-surface); }
.plugin-detail__bar { display: flex; align-items: center; gap: var(--space-2); height: 40px; padding: 0 var(--space-3); border-bottom: 1px solid var(--color-border); flex: none; }
.plugin-detail__title { font-weight: 700; font-size: var(--text-md); }
.plugin-detail__spacer { flex: 1; }
.plugin-detail__body { flex: 1; min-height: 0; overflow-y: auto; padding: var(--space-4); display: flex; flex-direction: column; gap: var(--space-3); }
.plugin-detail__body--center { display: grid; place-items: center; }

.plugin-hero { display: flex; align-items: center; gap: var(--space-3); }
.plugin-hero__icon { width: 48px; height: 48px; border-radius: var(--radius-md); background: var(--color-surface-2); display: grid; place-items: center; font-size: 24px; flex: none; }
.plugin-hero__info { flex: 1; min-width: 0; }
.plugin-hero__name { font-weight: 700; font-size: var(--text-md); display: flex; align-items: center; gap: 6px; }
.plugin-hero__meta { font-size: var(--text-xs); color: var(--color-text-muted); margin-top: 2px; }
.plugin-hero__status { display: flex; align-items: center; gap: 4px; font-size: var(--text-xs); color: var(--color-text-muted); margin-top: 2px; }
.plugin-hero__toggle { display: flex; align-items: center; gap: var(--space-2); flex: none; }
.plugin-hero__toggle-label { font-size: var(--text-xs); color: var(--color-text-muted); }

.plugin-badge { font-size: var(--text-xs); color: var(--color-text-muted); border: 1px solid var(--color-border); border-radius: var(--radius-full); padding: 0 6px; font-weight: 400; }

.detail-card { border: 1px solid var(--color-border); border-radius: var(--radius-md); overflow: hidden; }
.detail-card__head { padding: var(--space-2) var(--space-3); background: var(--color-surface-2); font-weight: 700; font-size: var(--text-sm); }
.detail-card__body { padding: var(--space-3); font-size: var(--text-sm); display: flex; flex-direction: column; gap: var(--space-2); line-height: 1.6; max-height: 32vh; overflow-y: auto; }
.detail-card__empty { margin: 0; color: var(--color-text-muted); font-size: var(--text-xs); }

.cap-row { display: flex; align-items: center; gap: var(--space-2); font-size: var(--text-sm); }
.cap-row__name { font-family: var(--font-mono); font-size: var(--text-xs); color: var(--color-primary); }
.cap-row__detail { color: var(--color-text-muted); font-size: var(--text-xs); }
.cap-row__ok { margin-left: auto; color: var(--color-success); }

.widget-row { display: flex; align-items: center; gap: var(--space-2); }
.widget-row__info { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.widget-row__name { font-size: var(--text-sm); }
.widget-row__id { font-family: var(--font-mono); font-size: var(--text-xs); color: var(--color-text-muted); }
.widget-row__added { font-size: var(--text-xs); color: var(--color-success); flex: none; }
.widget-row__hint { margin: 0; font-size: var(--text-xs); color: var(--color-text-muted); }

.dep-row { display: flex; align-items: center; gap: var(--space-2); font-size: var(--text-sm); }
.dep-row__state { margin-left: auto; font-size: var(--text-xs); color: var(--color-text-muted); }

.danger-zone { border: 1px solid var(--color-danger); border-radius: var(--radius-md); padding: var(--space-3); }
.danger-zone__title { color: var(--color-danger); font-weight: 700; font-size: var(--text-sm); margin-bottom: var(--space-2); }
.danger-zone__actions { display: flex; gap: var(--space-2); }

.uninstall-warn { font-size: var(--text-sm); line-height: 1.6; }
.uninstall-caps { margin: var(--space-2) 0; font-family: var(--font-mono); font-size: var(--text-xs); color: var(--color-text-muted); display: flex; flex-direction: column; gap: 2px; }
</style>
