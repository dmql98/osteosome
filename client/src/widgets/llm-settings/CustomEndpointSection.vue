/**
 * 自定义端点 —— 模型配置页的第三块。
 *
 * ## 它和「服务商」的区别（这是最容易混的地方）
 *
 * · **服务商** = 12 家预设，开箱带 baseUrl；改端点等于「覆盖预设」，会打「已覆盖预设」标记
 * · **自定义端点** = **不在预设里**的地址（内网网关、别人的 vLLM、代理……）
 *
 * 所以这个区**过滤掉了所有预设 id**：那些在「服务商」里改完就生效了，
 * 在这儿再列一遍会让同一个端点出现在两个地方、两处配置。
 *
 * ## 它也是「免凭证端点」的主要入口
 *
 * 预设里的本地端点只有 LM Studio / Ollama / vLLM 三家，且端口写死。
 * 换一个端口、或者指向内网的 vLLM，就得靠这里。
 */
<script setup lang="ts">
import Button from '@/components/ui/Button.vue'
import IconButton from '@/components/ui/IconButton.vue'

export interface EndpointRow {
  id: string
  label: string
  baseUrl: string
  /** 空串 = 显式免凭证 */
  credentialRef: string
}

const props = defineProps<{
  endpoints: EndpointRow[]
  probing: Record<string, boolean>
  reachable: Record<string, boolean | null>
}>()

const emit = defineEmits<{
  (e: 'create'): void
  (e: 'edit', endpointId: string): void
  (e: 'remove', endpointId: string): void
  (e: 'probe', endpointId: string): void
}>()

function stateDot(id: string): string {
  const r = props.reachable[id]
  if (r === true) return 'green'
  if (r === false) return 'red'
  return 'gray'
}
</script>

<template>
  <section class="endpoints">
    <header class="endpoints__head">
      <h3 class="endpoints__title">自定义端点 ({{ endpoints.length }})</h3>
      <Button size="sm" data-testid="endpoint-new" @click="emit('create')">＋ 新增</Button>
    </header>
    <p class="endpoints__hint">
      不在预设里的地址：内网网关、别人的 vLLM、代理…… 预设厂商改端点请去上面「服务商」。
    </p>

    <p v-if="!endpoints.length" class="endpoints__empty">还没有自定义端点。</p>

    <div v-for="e in endpoints" :key="e.id" class="endpoint" :data-testid="`endpoint-${e.id}`">
      <span class="dot" :class="stateDot(e.id)" />
      <span class="endpoint__name">{{ e.label || e.id }}</span>
      <span class="endpoint__url mono">{{ e.baseUrl }}</span>
      <Button size="sm" variant="ghost" :disabled="probing[e.id]" @click="emit('probe', e.id)">
        {{ probing[e.id] ? '探测中…' : '探测' }}
      </Button>
      <Button size="sm" variant="ghost" @click="emit('edit', e.id)">编辑</Button>
      <IconButton icon="✕" label="删除" @click="emit('remove', e.id)" />
    </div>
  </section>
</template>

<style scoped>
.endpoints { display: flex; flex-direction: column; gap: var(--space-2); }
.endpoints__head { display: flex; align-items: center; gap: var(--space-2); }
.endpoints__title { margin: 0; font-size: var(--text-sm); font-weight: 700; flex: 1; }
.endpoints__hint { margin: 0; font-size: var(--text-xs); color: var(--color-text-muted); }
.endpoints__empty { margin: 0; font-size: var(--text-sm); color: var(--color-text-muted); }
.endpoint {
  display: flex; align-items: center; gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--color-border); border-radius: var(--radius-md);
  background: var(--color-surface-1);
}
.endpoint__name { font-size: var(--text-sm); font-weight: 600; flex: none; }
.endpoint__url { flex: 1; min-width: 0; font-size: var(--text-xs); overflow-wrap: anywhere; }
</style>