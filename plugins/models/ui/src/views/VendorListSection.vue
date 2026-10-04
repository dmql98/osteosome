<script setup lang="ts">
/**
 * 服务商区 —— 模型配置页的主体块：上面是已连接的卡片，下面是未连接的预设目录。
 *
 * ## 分成「已连接 / 未连接」而不是平铺 12 行
 *
 * 12 家里通常只有 1–2 家真的连上了，其余 11 行是纯噪音，用户要滚动着找。
 * 连上的做成卡片（默认展开，一眼看到状态与模型墙），没连的收进默认折叠的目录。
 *
 * ## 组件只吃 props、只 emit
 *
 * 偏好写入与凭证 HTTP 全在 `LlmSettingsView`：`usePreferences.patch` 是**浅合并**，
 * 多个组件各自 patch `llm` 键会互相覆盖。这个文件不认识 preferences，也就没有这个风险。
 *
 * ## ⚠️ 文件头不要放 JS 块注释
 *
 * Vue 的 SFC 解析器把 `<script>` **之前**的内容按 HTML 解析，
 * 注释里出现 `<dl>` 这类尖括号会被当成顶层标签，报 `Element is missing end tag`
 * 且位置完全不指向真因。所以注释一律写在 `<script>` 内部。
 */
import ProviderCard from './ProviderCard.vue'
import type { ProviderCardData } from './ProviderCard.vue'
import ProviderCatalog from './ProviderCatalog.vue'
import type { PendingRow } from './ProviderCatalog.vue'

export type { ProviderCardData, PendingRow }

const props = defineProps<{
  /** 已连接（成为实例的预设），已按搜索词过滤 */
  cards: ProviderCardData[]
  /** 未连接的预设，已按搜索词过滤 */
  rows: PendingRow[]
  /** 未连接的预设总数（不过滤 —— 计数要说明「还剩几家没接」） */
  total: number
  dirOpen: boolean
  query: string
  /** provider → 是否正在探测（透传给目录行，让「连接」按钮有反馈） */
  probing: Record<string, boolean>
  /** provider → 是否可达；缺省 = 还没探过 */
  reachable: Record<string, boolean | null>
}>()

const emit = defineEmits<{
  (e: 'toggle', providerId: string): void
  (e: 'probe', providerId: string): void
  (e: 'set-key', providerId: string): void
  (e: 'remove-key', providerId: string): void
  (e: 'edit-base-url', providerId: string, value: string): void
  (e: 'edit-model', providerId: string, value: string): void
  (e: 'set-default', providerId: string, model: string): void
  (e: 'toggle-model', providerId: string, model: string, on: boolean): void
  (e: 'set-all', providerId: string, on: boolean): void
  (e: 'toggle-dir'): void
  (e: 'connect', providerId: string): void
  /** 卡片上的「删除」：把这家挪回「未连接的预设」 */
  (e: 'disconnect', providerId: string): void
}>()

/**
 * 每张卡的监听器。
 *
 * 用 `v-on="object"` 而不是逐个写 `@toggle="emit('toggle', c.id)"`：
 * 模板内联语句**只能拿到第一个参数**（`$event`），而 `toggle-model` 要传
 * `(model, on)` 两个 —— 内联写法会静默丢掉 `on`，症状是开关永远只往一边翻。
 */
function cardListeners(id: string) {
  return {
    toggle: () => emit('toggle', id),
    probe: () => emit('probe', id),
    setKey: () => emit('set-key', id),
    removeKey: () => emit('remove-key', id),
    editBaseUrl: (value: string) => emit('edit-base-url', id, value),
    editModel: (value: string) => emit('edit-model', id, value),
    setDefault: (model: string) => emit('set-default', id, model),
    toggleModel: (model: string, on: boolean) => emit('toggle-model', id, model, on),
    setAll: (on: boolean) => emit('set-all', id, on),
    disconnect: () => emit('disconnect', id),
  }
}
</script>

<template>
  <section class="vendors">
    <p v-if="!cards.length && !props.rows.length" class="vendors__empty">
      {{ props.query ? '没有匹配的服务商。' : '还没有连上任何服务商 —— 往下「未连接的预设」里挑一家。' }}
    </p>

    <h3 v-if="props.cards.length" class="vendors__group">已连接 ({{ props.cards.length }})</h3>

    <ProviderCard
      v-for="c in props.cards"
      :key="c.id"
      :provider="c"
      :query="props.query"
      v-on="cardListeners(c.id)"
    />

    <ProviderCatalog
      v-if="props.total"
      :rows="props.rows"
      :total="props.total"
      :open="props.dirOpen"
      :probing="props.probing"
      :reachable="props.reachable"
      @toggle-open="emit('toggle-dir')"
      @set-key="emit('set-key', $event)"
      @connect="emit('connect', $event)"
    />
  </section>
</template>

<style scoped>
.vendors { display: flex; flex-direction: column; gap: var(--space-2); }
.vendors__empty { margin: 0; font-size: var(--text-sm); color: var(--color-text-muted); }
.vendors__group { margin: 0; font-size: var(--text-xs); font-weight: 700; color: var(--color-text-muted); }
</style>
