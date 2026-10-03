/**
 * 「正在使用」卡片 —— 模型配置页的第一块。
 *
 * ## 为什么单独一块
 *
 * 原页面把「选厂商」放在厂商目录里、「选模型」放在第三段，中间隔着自定义端点。
 * 但**「选厂商 → 选模型」是一个连续动作**，拆开就等于让用户自己记住当前状态再往下翻。
 *
 * 所以把「我此刻发问会走谁」提到最上面，并在这里给出唯一的模型下拉。
 * 下面的厂商列表回答的是另一个问题：「有哪些可选的」。
 */
<script setup lang="ts">
import { computed } from 'vue'
import Select from '@/components/ui/Select.vue'
import type { ProbeResult } from '@/core-sdk/useEndpointProbe'

export interface ActiveProvider {
  provider: string
  label: string
  baseUrl: string
  /** 空串 = 免凭证（本地端点） */
  credentialRef: string
  defaultModel: string
}

const props = defineProps<{
  provider: ActiveProvider | null
  providers: { value: string; label: string }[]
  models: { value: string; label: string }[]
  model: string
  loadingModels: boolean
  /** null = 未探测过；要与「探测失败」区分显示 */
  reachable: boolean | null
  probe: ProbeResult | undefined
  probing: boolean
}>()

const emit = defineEmits<{
  (e: 'update:provider', value: string): void
  (e: 'update:model', value: string): void
  (e: 'probe'): void
}>()

const credentialLine = computed(() => {
  const ref = props.provider?.credentialRef ?? ''
  if (!ref) return '免凭证（本地端点）'
  if (ref.startsWith('env:')) return `来自环境变量 ${ref.slice(4)}`
  return `凭证 ${ref}`
})

/** 探测结果一句话说明。`reachable === null` 是「还没测」，不是「测过了不行」 */
const statusText = computed(() => {
  if (props.probing) return '探测中…'
  if (props.reachable === null) return '未测试'
  if (props.reachable) {
    const ms = props.probe?.latencyMs
    const n = props.probe?.models.length ?? 0
    const latency = ms === null || ms === undefined ? '' : ` · ${ms}ms`
    return `已连通${latency} · ${n} 个模型`
  }
  return '连不上'
})

const statusClass = computed(() => {
  if (props.probing) return 'is-probing'
  if (props.reachable === null) return 'is-unknown'
  return props.reachable ? 'is-ok' : 'is-bad'
})

/**
 * 没有默认模型是最常见的卡点（lm-studio / vLLM 的预设 `defaultModel` 就是空的）。
 * 空着不说清楚，用户会以为页面坏了。
 */
const needsModel = computed(() => Boolean(props.provider) && !props.provider?.defaultModel && !props.model)
</script>

<template>
  <section class="active-model">
    <h3 class="active-model__title">正在使用</h3>

    <p v-if="!provider" class="active-model__empty">
      还没连上任何服务商。往下在「服务商」里挑一家，或
      <button type="button" class="linkish" @click="$emit('probe')">连接本地端点</button>。
    </p>

    <div v-else class="active-model__grid">
      <label class="active-model__row">
        <span class="active-model__key">服务商</span>
        <Select
          :model-value="provider.provider"
          :options="providers"
          placeholder="选择服务商"
          aria-label="active-provider"
          @update:model-value="emit('update:provider', $event)"
        />
      </label>

      <label class="active-model__row">
        <span class="active-model__key">模型</span>
        <Select
          :model-value="model"
          :options="models"
          :placeholder="loadingModels ? '拉取模型列表中…' : '选择模型'"
          aria-label="active-model"
          @update:model-value="emit('update:model', $event)"
        />
      </label>

      <div class="active-model__row">
        <span class="active-model__key">端点</span>
        <span class="active-model__val mono">{{ provider.baseUrl }}</span>
        <button type="button" class="linkish" :disabled="probing" @click="emit('probe')">
          {{ probing ? '探测中…' : '连通性测试' }}
        </button>
      </div>

      <div class="active-model__row">
        <span class="active-model__key">凭证</span>
        <span class="active-model__val">{{ credentialLine }}</span>
      </div>

      <div class="active-model__row">
        <span class="active-model__key">状态</span>
        <span class="active-model__status" :class="statusClass">
          <span class="dot" :class="statusClass" />{{ statusText }}
        </span>
      </div>
    </div>

    <p v-if="needsModel" class="active-model__warn">
      这个服务商<b>没有默认模型</b> —— 从上面选一个，或在下方「服务商」里填一个。
    </p>
  </section>
</template>

<style scoped>
.active-model {
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-surface-1);
  padding: var(--space-3);
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
.active-model__title { margin: 0; font-size: var(--text-sm); font-weight: 700; }
.active-model__grid { display: flex; flex-direction: column; gap: var(--space-2); }
.active-model__row { display: flex; align-items: center; gap: var(--space-2); }
.active-model__key { flex: none; width: 52px; font-size: var(--text-xs); color: var(--color-text-muted); }
.active-model__val { flex: 1; min-width: 0; font-size: var(--text-xs); overflow-wrap: anywhere; }
.active-model__status { display: inline-flex; align-items: center; gap: 4px; font-size: var(--text-xs); }
.active-model__status.is-ok { color: var(--color-success); }
.active-model__status.is-bad { color: var(--color-danger); }
.active-model__status.is-unknown, .active-model__status.is-probing { color: var(--color-text-muted); }
.active-model__warn {
  margin: 0;
  padding: var(--space-2);
  border: 1px solid var(--color-warning);
  border-radius: var(--radius-md);
  background: var(--color-warning-soft);
  color: var(--color-warning);
  font-size: var(--text-xs);
}
.active-model__empty { margin: 0; font-size: var(--text-sm); color: var(--color-text-muted); }
.linkish {
  background: none;
  border: none;
  padding: 0;
  color: var(--color-primary);
  font: inherit;
  font-size: var(--text-xs);
  cursor: pointer;
  text-decoration: underline;
}
.linkish:disabled { color: var(--color-text-muted); cursor: default; text-decoration: none; }
</style>