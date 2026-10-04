<template>
  <div class="plugin-detail">
    <header class="plugin-detail__bar" data-tauri-drag-region>
      <span class="plugin-detail__title" data-tauri-drag-region>插件管理</span>
      <span class="plugin-detail__spacer" data-tauri-drag-region></span>
      <WindowControls />
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
          <div v-for="widgetId in widgetIds" :key="widgetId" class="widget-row">
            <div class="widget-row__info">
              <span class="widget-row__name">{{ widgetTitle(widgetId) }}</span>
              <span class="widget-row__id">{{ widgetId }}</span>
              <span class="widget-row__origin">{{ widgetOrigin(widgetId) }}</span>
            </div>
            <span v-if="addedWidgetId === widgetId" class="widget-row__added">已加入 ✓</span>
            <Button
              size="sm"
              :variant="isEnabled ? 'primary' : 'ghost'"
              :disabled="!isEnabled || !canAddWidget(widgetId)"
              @click="addWidget(widgetId)"
            >
              ＋ 加入窗口
            </Button>
          </div>
          <p v-if="widgetIds.length === 0" class="widget-row__hint">该插件未提供可装配的界面组件。</p>
          <p v-else-if="!isEnabled" class="widget-row__hint">插件已停用，启用后才能加入组件。</p>
        </div>
      </section>

      <section v-if="hasIssues" class="detail-card detail-card--warn">
        <header class="detail-card__head">状态明细</header>
        <div class="detail-card__body">
          <p v-if="plugin.reason" class="issue-reason">{{ plugin.reason }}</p>
          <div v-if="plugin.missingDependencies.length" class="issue-row">
            <span class="issue-row__label">缺必需依赖</span>
            <span class="issue-row__value">{{ plugin.missingDependencies.join('、') }}</span>
          </div>
          <div v-if="plugin.unhealthyServices.length" class="issue-row">
            <span class="issue-row__label">未就绪的服务</span>
            <span class="issue-row__value">{{ plugin.unhealthyServices.join('、') }}</span>
          </div>
          <div v-if="plugin.missingOptional.length" class="issue-row">
            <span class="issue-row__label">缺可选依赖</span>
            <span class="issue-row__value">{{ plugin.missingOptional.join('、') }}</span>
          </div>
          <p class="issue-hint">
            这些是 Core 判定的<b>事实</b>，界面只负责显示，不在前端重算。
          </p>
        </div>
      </section>

      <section class="detail-card">
        <header class="detail-card__head">
          服务<span class="detail-card__count">{{ plugin.readyServiceCount }} / {{ plugin.totalServices }} 就绪</span>
        </header>
        <div class="detail-card__body">
          <div v-for="serviceId in plugin.services" :key="serviceId" class="dep-row">
            <span class="dot" :class="serviceStateDot(serviceId)"></span>
            <span>{{ serviceId }}</span>
            <span class="dep-row__state">{{ serviceStateLabel(serviceId) }}</span>
          </div>
          <p v-if="!plugin.services.length" class="detail-card__empty">
            该插件不带服务（只提供组件，或组件由 Core 内置）
          </p>
        </div>
      </section>

      <section class="detail-card">
        <header class="detail-card__head">依赖</header>
        <div class="detail-card__body">
          <div v-for="dep in plugin.dependencies" :key="dep.pluginId" class="dep-row">
            <span class="dot" :class="dependencyReady(dep) ? 'green' : 'yellow'"></span>
            <span>{{ dep.label }}</span>
            <span class="dep-row__state">{{ dependencyReady(dep) ? '已就绪' : '等待中' }}</span>
          </div>
          <p v-if="!plugin.dependencies.length" class="detail-card__empty">无依赖</p>
        </div>
      </section>

      <section class="danger-zone">
        <div class="danger-zone__title">危险区</div>
        <p v-if="actionError" class="danger-zone__error">{{ actionError }}</p>
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
        卸载后：该插件组件会从所有窗口移除（共 {{ plugin?.components.length ?? 0 }} 个实例），以下能力将消失：
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
import { computed, onBeforeUnmount, ref } from 'vue'
import { Button } from '@osteosome/ui'
import { EmptyState } from '@osteosome/ui'
import { Modal } from '@osteosome/ui'
import { Switch } from '@osteosome/ui'
import WindowControls from '@/components/layout/WindowControls.vue'
import { addableWidgetIds, resolveWidget } from '@/widgets/registry'
import { usePlugins } from '@/core-sdk/usePlugins'
import type { PluginView } from './registry'
import { requestAddWidget, notifyPluginsChanged } from '@/layout/window-events'
import { closeCurrentWindow } from '@/tauri/plugin-window'

const props = defineProps<{ pluginId: string }>()

const { store } = usePlugins()
const confirmOpen = ref(false)
const addedWidgetId = ref('')
/** 启停/卸载失败提示。命令失败时状态不变，不提示就等于骗人 */
const actionError = ref('')
let addedTimer: ReturnType<typeof setTimeout> | null = null

const plugin = computed(() => store.byId(props.pluginId))
const isEnabled = computed(() => store.isEnabled(props.pluginId))

/**
 * hero 上的状态有**两个独立的轴**，别混成一个：
 * · 用户意愿（启用 / 停用）—— 本地 prefs，Core 并不知道
 * · 实际状态（ready / degraded / failed / stopped）—— Core 派生
 *
 * 只显示前者的话，一个 degraded 的插件会显示「运行中」——
 * 用户看到绿灯却发不出请求，详情窗（本该最详尽的地方）也不给任何线索。
 * 与列表窗 S7-3 修的是同一个缺口，两处必须一致，否则两个窗口说法不同。
 */
const statusLabel = computed(() => {
  if (!store.isInstalled(props.pluginId)) return '已卸载'
  if (!isEnabled.value) return '已停用'
  return coreStateLabel(plugin.value?.state)
})

const statusDot = computed(() => {
  if (!store.isInstalled(props.pluginId)) return 'red'
  if (!isEnabled.value) return 'gray'
  return coreStateDot(plugin.value?.state)
})

function coreStateLabel(state: PluginView['state'] | undefined): string {
  if (state === 'degraded') return '降级'
  if (state === 'failed') return '故障'
  if (state === 'stopped') return '未运行'
  return '运行中'
}

function coreStateDot(state: PluginView['state'] | undefined): string {
  if (state === 'failed') return 'red'
  if (state === 'degraded') return 'yellow'
  if (state === 'stopped') return 'gray'
  return 'green'
}

/** 是否值得展开「状态明细」—— 一切正常时不占地方 */
const hasIssues = computed(() => {
  const p = plugin.value
  if (!p) return false
  return (
    p.state !== 'ready' ||
    p.unhealthyServices.length > 0 ||
    p.missingDependencies.length > 0
  )
})

/** 逐个服务的真实状态。`undefined` = 未在跑 */
function serviceStateOf(serviceId: string): string | undefined {
  return plugin.value?.serviceStates[serviceId]
}

function serviceStateLabel(serviceId: string): string {
  const state = serviceStateOf(serviceId)
  switch (state) {
    case 'ready':
      return '就绪'
    case 'starting':
      return '启动中'
    case 'restarting':
      return '重启中'
    case 'failed':
      return '故障'
    case 'stopped':
      return '已停'
    default:
      // 没在跑：区分「被停用」与「所属插件没装」—— 前者是用户的决定，后者是缺东西
      return isEnabled.value ? '未在跑' : '随插件停用'
  }
}

function serviceStateDot(serviceId: string): string {
  const state = serviceStateOf(serviceId)
  if (state === 'ready') return 'green'
  if (state === 'failed') return 'red'
  if (state === 'starting' || state === 'restarting') return 'yellow'
  return 'gray'
}
const authorLine = computed(() => {
  const parts: string[] = []
  if (plugin.value?.author) parts.push(`作者: ${plugin.value.author}`)
  if (plugin.value?.license) parts.push(plugin.value.license)
  return parts.join(' · ') || '本地插件'
})

/**
 * 可加入窗口的组件 id：插件的 `ui.views` ∪ `components`（本地组件）。
 *
 * 用 `addableWidgetIds` 而不是直接列 `plugin.components` —— P3 起插件的页面
 * 走 `ui.views`，只列 `components` 的话，将来插件搬走了自己的 UI，
 * 这个列表会**悄悄变空**，而插件确实还提供着界面。
 */
const widgetIds = computed(() => (plugin.value ? addableWidgetIds(plugin.value) : []))

function widgetTitle(widgetId: string): string {
  return resolveWidget(widgetId, store.all).title
}

/** 来源标注：插件页面 vs 还在 client 包里的本地组件（用户据此知道界面归谁） */
function widgetOrigin(widgetId: string): string {
  return resolveWidget(widgetId, store.all).kind === 'iframe' ? '插件页面' : '内置组件'
}

/** 占位（已退役/未知）不可加入：它只是给已有布局看的残留 */
function canAddWidget(widgetId: string): boolean {
  return resolveWidget(widgetId, store.all).kind !== 'missing'
}

/**
 * 依赖是否就绪。
 *
 * 判据换成「被依赖的**插件**状态」而不是「拿 pluginId 去 services 里查」——
 * 依赖关系连的是插件，不是服务。用旧判据的话 `services[pluginId]` 永远是 undefined，
 * 于是永远走 `return dep.ready !== false` 那条兜底，看着正常其实没判过。
 */
function dependencyReady(dep: { pluginId: string }): boolean {
  return store.byId(dep.pluginId)?.state === 'ready'
}

function addWidget(widgetId: string): void {
  requestAddWidget(widgetId)
  addedWidgetId.value = widgetId
  if (addedTimer) clearTimeout(addedTimer)
  addedTimer = setTimeout(() => { addedWidgetId.value = '' }, 1600)
}

async function onToggleEnabled(value: boolean): Promise<void> {
  // 失败时状态不变，所以必须说一声 —— 否则开关弹回去了，用户不知道是没点上还是没成功
  const ok = await store.setEnabled(props.pluginId, value)
  actionError.value = ok ? '' : '启停命令未被 Core 接受，状态未改变'
  if (ok) notifyPluginsChanged()
}

async function doUninstall(): Promise<void> {
  confirmOpen.value = false
  const ok = await store.uninstall(props.pluginId)
  if (!ok) {
    // 别关窗口：卸载没成功还把窗关了，用户会以为已经卸载了
    actionError.value = '卸载失败：Core 未接受停用命令，插件仍在运行'
    return
  }
  notifyPluginsChanged()
  await closeCurrentWindow()
}

onBeforeUnmount(() => {
  if (addedTimer) clearTimeout(addedTimer)
})
</script>

<style scoped>
.plugin-detail { display: flex; flex-direction: column; height: 100%; background: var(--color-surface); }
.plugin-detail__bar { display: flex; align-items: center; gap: var(--space-2); height: 40px; padding: 0 0 0 var(--space-3); border-bottom: 1px solid var(--color-border); flex: none; }
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
.detail-card__count { margin-left: var(--space-2); font-weight: 400; font-size: var(--text-xs); color: var(--color-text-muted); }
.detail-card--warn { border-color: var(--color-warning); }
.detail-card--warn .detail-card__head { background: var(--color-warning-soft); color: var(--color-warning); }
.issue-reason { margin: 0; font-size: var(--text-sm); font-weight: 600; color: var(--color-warning); }
.issue-row { display: flex; gap: var(--space-2); font-size: var(--text-xs); }
.issue-row__label { color: var(--color-text-muted); flex: none; min-width: 88px; }
.issue-row__value { font-family: var(--font-mono); }
.issue-hint { margin: 0; font-size: var(--text-xs); color: var(--color-text-muted); }
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
.widget-row__origin { font-size: var(--text-xs); color: var(--color-text-subtle, var(--color-text-muted)); }
.widget-row__added { font-size: var(--text-xs); color: var(--color-success); flex: none; }
.widget-row__hint { margin: 0; font-size: var(--text-xs); color: var(--color-text-muted); }

.dep-row { display: flex; align-items: center; gap: var(--space-2); font-size: var(--text-sm); }
.dep-row__state { margin-left: auto; font-size: var(--text-xs); color: var(--color-text-muted); }

.danger-zone { border: 1px solid var(--color-danger); border-radius: var(--radius-md); padding: var(--space-3); }
.danger-zone__title { color: var(--color-danger); font-weight: 700; font-size: var(--text-sm); margin-bottom: var(--space-2); }
.danger-zone__actions { display: flex; gap: var(--space-2); }
.danger-zone__error { margin: var(--space-2) 0 0; padding: var(--space-2); border: 1px solid var(--color-danger); border-radius: var(--radius-md); background: var(--color-danger-soft); color: var(--color-danger); font-size: var(--text-xs); }

.uninstall-warn { font-size: var(--text-sm); line-height: 1.6; }
.uninstall-caps { margin: var(--space-2) 0; font-family: var(--font-mono); font-size: var(--text-xs); color: var(--color-text-muted); display: flex; flex-direction: column; gap: 2px; }
</style>
