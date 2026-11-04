<script setup lang="ts">
/**
 * 单个模型的**能力设置**（展开在模型卡片里）。
 *
 * 对应 dsh 设置-模型页每一行模型的「上下文窗口 / 最大输出 / 输入类型 / 思考档位」四项。
 *
 * ## 为什么这些字段挂在模型上，而不是厂商上
 *
 * 同一家厂商下的模型差异很大：`deepseek-reasoner` 恒思考、不接受 `reasoning_effort`；
 * 多数补全模型没有图片输入；上下文窗口从 8K 到 1M 都有。按厂商配一个值，
 * 只能配成「有的模型会拒绝」的那个值 —— 所以必须是 per-model。
 *
 * ## 数据形状：清单是清单，能力是能力
 *
 * 模型清单在协议层是 `string[]`（`llm.models.list.result.models`），不能为了几个字段
 * 去改跨进程契约。所以能力单独一张表，键 `${providerId}::${model}`（`shared` 的
 * `modelProfileKey`）。**没配过 = 全用默认**，老偏好文件不需要迁移。
 *
 * ## 什么时候算「清除」
 *
 * 四项全空 = 这个模型没有任何自定义 → 这里发一个 `{}`，由父组件把表里那条删掉，
 * 而不是留一条空对象占位置（那样「已配置」的计数会虚高）。
 *
 * ## 报错怎么处理
 *
 * 容量读不懂（`abc`）时**不提交、只标红**：把 `NaN` 写进配置会得到一个 0 token 的模型，
 * 而用户看到的是一次静默的失败。文本留在框里，用户改对了再提交。
 */
import { computed, ref } from 'vue'
import { Button } from '@osteosome/ui'
import { Checkbox } from '@osteosome/ui'
import { Input } from '@osteosome/ui'
import type { ModelInput, ModelProfile } from '@osteosome/shared'
import { formatCapacity, parseCapacity } from '../capacity'

const props = defineProps<{
  /** 模型名（只用于无障碍标签与提示） */
  model: string
  /** 当前配置（父组件给的是「这一条」；没配过就是空对象） */
  profile: ModelProfile
}>()

const emit = defineEmits<{
  /** 整份新配置；`{}` = 清除这个模型的自定义 */
  (e: 'update:profile', profile: ModelProfile): void
}>()

/** 四个档位的展示顺序与中文名。wire 值就是档位名（provider 直接发成 `reasoning_effort`） */
const LEVELS = [
  { value: 'off', label: '关' },
  { value: 'low', label: '低' },
  { value: 'medium', label: '中' },
  { value: 'high', label: '高' },
] as const

/** 容量字段的本地文本（用户可能正打到一半，不能每次都回写成格式化后的样子） */
const contextDraft = ref(props.profile.contextWindow === undefined ? '' : formatCapacity(props.profile.contextWindow))
const maxTokensDraft = ref(props.profile.maxTokens === undefined ? '' : formatCapacity(props.profile.maxTokens))
const contextInvalid = ref(false)
const maxTokensInvalid = ref(false)

/**
 * 在现有配置上打补丁。
 *
 * 值为 `undefined` / 空数组的键**直接删掉**，不留 `{reasoningEfforts: []}` 那种半套状态 ——
 * 存储侧也会把它当「没配」，两边保持一致。
 */
function withPatch(patch: Partial<ModelProfile>): ModelProfile {
  const next: Record<string, unknown> = { ...props.profile }
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined || (Array.isArray(value) && value.length === 0)) delete next[key]
    else next[key] = value
  }
  return next as ModelProfile
}

function commitCapacity(field: 'contextWindow' | 'maxTokens', text: string): void {
  const parsed = parseCapacity(text)
  const invalid = parsed !== undefined && Number.isNaN(parsed)
  if (field === 'contextWindow') contextInvalid.value = invalid
  else maxTokensInvalid.value = invalid
  // 读不懂就不提交：框里的文本留着，用户改对之前配置不动
  if (invalid) return
  emit('update:profile', withPatch({ [field]: parsed === undefined ? undefined : parsed }))
}

/** 未配置 = 文本（绝大多数模型的底线能力），所以「文本」恒勾且不可取消 */
const supportsImage = computed(() => (props.profile.input ?? ['text']).includes('image'))

function toggleImage(on: boolean): void {
  const input: ModelInput[] = on ? ['text', 'image'] : ['text']
  emit('update:profile', withPatch({ input: on ? input : undefined }))
}

/** 未配置 = 四档全给（不限制）。空数组在存储层会被丢弃，所以最后一档不许取消 */
const levels = computed(() => props.profile.reasoningEfforts ?? LEVELS.map((l) => l.value))

function levelOn(level: string): boolean {
  return levels.value.includes(level)
}

function isLastLevel(level: string): boolean {
  return levels.value.length === 1 && levelOn(level)
}

function toggleLevel(level: string, on: boolean): void {
  const next = on ? [...new Set([...levels.value, level])] : levels.value.filter((l) => l !== level)
  // 全选 = 不限制（不写这个键）；只留部分才落盘
  emit('update:profile', withPatch({ reasoningEfforts: next.length === LEVELS.length ? undefined : next }))
}

const isEmpty = computed(() => Object.keys(props.profile).length === 0)
</script>

<template>
  <div class="mp" :data-testid="`model-profile-${model}`">
    <label class="mp__row">
      <span class="mp__key">上下文窗口</span>
      <Input
        v-model="contextDraft"
        class="mp__input"
        placeholder="如 128K / 1M（留空用默认）"
        :aria-label="`${model} 上下文窗口`"
        :data-testid="`mp-context-${model}`"
        @change="commitCapacity('contextWindow', contextDraft)"
      />
      <span v-if="contextInvalid" class="mp__error">读不懂这个值</span>
      <span v-else class="mp__hint">token 数，支持 K / M</span>
    </label>

    <label class="mp__row">
      <span class="mp__key">最大输出</span>
      <Input
        v-model="maxTokensDraft"
        class="mp__input"
        placeholder="如 8K（留空用默认）"
        :aria-label="`${model} 最大输出`"
        :data-testid="`mp-maxtokens-${model}`"
        @change="commitCapacity('maxTokens', maxTokensDraft)"
      />
      <span v-if="maxTokensInvalid" class="mp__error">读不懂这个值</span>
      <span v-else class="mp__hint">单次回复的上限</span>
    </label>

    <div class="mp__row">
      <span class="mp__key">输入</span>
      <Checkbox :model-value="true" label="文本" disabled />
      <Checkbox
        :model-value="supportsImage"
        label="图片"
        :data-testid="`mp-image-${model}`"
        @update:model-value="toggleImage"
      />
      <span class="mp__hint">勾上图片即声明这个模型能收图</span>
    </div>

    <div class="mp__row">
      <span class="mp__key">思考档位</span>
      <Checkbox
        v-for="level in LEVELS"
        :key="level.value"
        :model-value="levelOn(level.value)"
        :label="level.label"
        :disabled="isLastLevel(level.value)"
        :data-testid="`mp-level-${level.value}-${model}`"
        @update:model-value="toggleLevel(level.value, $event)"
      />
      <span class="mp__hint">不勾的档位不会出现在对话框</span>
    </div>

    <div class="mp__foot">
      <Button v-if="!isEmpty" size="sm" variant="ghost" :data-testid="`mp-reset-${model}`" @click="emit('update:profile', {})">
        清除这个模型的设置
      </Button>
      <span v-else class="mp__hint">还没有自定义 —— 全部用默认</span>
    </div>
  </div>
</template>

<style scoped>
.mp {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  padding: var(--space-2);
  border-top: 1px dashed var(--color-border);
  background: var(--color-surface-2);
  border-radius: var(--radius-sm);
}
.mp__row { display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap; font-size: var(--text-xs); }
.mp__key { flex: none; width: 64px; color: var(--color-text-muted); }
.mp__input { flex: 1; min-width: 120px; }
.mp__hint { flex: 1; min-width: 120px; color: var(--color-text-muted); font-size: var(--text-xs); }
.mp__error { flex: 1; min-width: 120px; color: var(--color-danger); font-size: var(--text-xs); }
.mp__foot { display: flex; justify-content: flex-end; }
</style>
