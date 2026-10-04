<script setup lang="ts">
/**
 * 模型墙 —— 服务商卡片展开后的网格。
 *
 * ## 一卡一模型：为什么不用下拉
 *
 * 一个端点常有几十个模型，下拉只能一个个翻、还看不到「哪个是默认的」。
 * 网格让「扫一眼 → 关掉不要的 → 点一个设默认」在一个视野里完成。
 *
 * ## 启用开关写哪
 *
 * `llm.enabledModels`（数组，元素是 `<provider>::<model>`）。
 * **空数组 = 全启用**，这是默认态 —— 于是老偏好文件一个字没写也照常工作，
 * 不需要迁移。反向存「已启用」就得先知道全集，而全集来自探测，
 * 探测前是空的，那就会把所有模型都判成关的。
 *
 * 用 `::` 而不是 `:` 分隔，是因为模型名里本来就有冒号（`qwen2.5:7b`）。
 *
 * 对话输入框按同一份偏好过滤 `modelOptions`，所以关掉 = 真的选不到，
 * 不是一个「设了没反应」的假开关。
 */
import { computed } from 'vue'
import { Switch } from '@osteosome/ui'

const props = defineProps<{
  /** 这个端点当前拉到的模型清单（未探测 = 空） */
  models: string[]
  /** 本端点下已禁用的模型名 */
  disabled: string[]
  /** 当前生效的默认模型（可能不在 models 里 —— 那也是「已设置」） */
  defaultModel: string
  /** `remote` = 真拉到了上游清单；`static` = 内置兜底（多半连不上） */
  catalog: 'remote' | 'static' | null
  /** 页头搜索词：命中的模型会让所属卡片自动展开，这里再把不命中的模型滤掉 */
  query: string
}>()

const emit = defineEmits<{
  (e: 'set-default', model: string): void
  (e: 'toggle', model: string, on: boolean): void
}>()

const keyword = computed(() => props.query.trim().toLowerCase())

const visible = computed(() => {
  if (!keyword.value) return props.models
  return props.models.filter((m) => m.toLowerCase().includes(keyword.value))
})

function isOn(model: string): boolean {
  return !props.disabled.includes(model)
}

const sourceText = computed(() => (props.catalog === 'remote' ? '远程' : '静态'))
</script>

<template>
  <div class="wall">
    <p v-if="!models.length" class="wall__empty">这个端点还没有模型清单 —— 点上方「获取模型列表」拉一次。</p>
    <p v-else-if="!visible.length" class="wall__empty">没有匹配的模型。</p>
    <div v-else class="wall__grid">
      <div v-for="m in visible" :key="m" class="mcard" :class="{ 'mcard--off': !isOn(m) }">
        <div class="mcard__row">
          <button
            type="button"
            class="mcard__name"
            :title="defaultModel === m ? '已经是默认模型' : '点一下把这个设成默认模型'"
            @click="emit('set-default', m)"
          >
            {{ m }}
          </button>
          <Switch
            :model-value="isOn(m)"
            :aria-label="`模型 ${m}`"
            @update:model-value="emit('toggle', m, $event)"
          />
        </div>
        <div class="mcard__meta">
          <span v-if="defaultModel === m" class="mcard__tag mcard__tag--def">★ 默认</span>
          <span v-if="!isOn(m)" class="mcard__tag mcard__tag--off">已停用</span>
          <span class="mcard__spacer" />
          <span class="mcard__src">{{ sourceText }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.wall__grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: var(--space-2);
}
.wall__empty { margin: 0; font-size: var(--text-xs); color: var(--color-text-muted); }

.mcard {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  padding: var(--space-2);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-surface-1);
}
.mcard--off { opacity: 0.55; }

.mcard__row { display: flex; align-items: center; gap: var(--space-2); }
.mcard__name {
  flex: 1;
  min-width: 0;
  padding: 0;
  border: none;
  background: none;
  font: inherit;
  font-size: var(--text-xs);
  color: var(--color-text);
  text-align: left;
  cursor: pointer;
  overflow-wrap: anywhere;
}
.mcard__name:hover { color: var(--color-primary); }

.mcard__meta {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  font-size: var(--text-xs);
  color: var(--color-text-muted);
}
.mcard__spacer { flex: 1; }
.mcard__tag {
  border: 1px solid var(--color-border);
  border-radius: var(--radius-full);
  padding: 0 6px;
  white-space: nowrap;
}
.mcard__tag--def { color: var(--color-primary); border-color: var(--color-primary); }
.mcard__tag--off { color: var(--color-text-muted); }
.mcard__src { white-space: nowrap; }
</style>
