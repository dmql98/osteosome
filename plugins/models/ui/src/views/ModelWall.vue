<script setup lang="ts">
/**
 * 模型墙 —— 一个端点展开后的模型网格。
 *
 * ## 一卡一模型：为什么不用下拉
 *
 * 一个端点常有几十个模型，下拉只能一个个翻、还看不到「哪个是默认的」。
 * 网格让「扫一眼 → 关掉不要的 → 设为默认」在一个视野里完成。
 *
 * ## 模型名只是名字，改默认是单独的按钮
 *
 * 原来点模型名就等于「设为默认」—— 名字长得像标签，点上去却有副作用，
 * 用户是抱着「看看这个模型」的预期点的。所以默认模型单独一个「设为默认」按钮，
 * 已经是默认的那张卡只留 `★ 默认` 标记（一个点不动的按钮比标签更碍眼）。
 *
 * ## 启用开关写哪
 *
 * `modelProfiles` 之外的另一个偏好键：`enabledModels`（数组，元素是 `<provider>::<model>`）。
 * **空数组 = 全启用**，这是默认态 —— 于是老偏好文件一个字没写也照常工作，
 * 不需要迁移。反向存「已启用」就得先知道全集，而全集来自探测，
 * 探测前是空的，那就会把所有模型都判成关的。
 *
 * 用 `::` 而不是 `:` 分隔，是因为模型名里本来就有冒号（`qwen2.5:7b`）。
 *
 * 对话输入框按同一份偏好过滤 `modelOptions`，所以关掉 = 真的选不到，
 * 不是一个「设了没反应」的假开关。
 *
 * ## 卡片上的四项能力设置（对齐 dsh 的设置-模型页）
 *
 * 上下文窗口 / 最大输出 / 输入模态 / 思考档位是 **per-model** 的（同厂商下差异很大），
 * 由 {@link ModelProfileEditor} 编辑，写进 `modelProfiles` 表（键 `${provider}::${model}`）。
 * 卡片不直接写盘：它只 `emit('update-profile')`，写入由页面统一做
 * （`models.prefs.set` 是**整表替换**，两个地方各写一次必然互相覆盖）。
 *
 * ## 角标说「远程 / 静态 / 未探测」三态
 *
 * 这里踩过一次：`catalog === null`（还没探过）时也被显示成「静态」，
 * 于是「设默认模型」清掉探测结果之后，用户看到的是
 * 「从远程变成静态」—— 而真相只是「这次没测」。三态必须分开显示。
 */
import { computed, ref } from 'vue'
import { Button } from '@osteosome/ui'
import { Switch } from '@osteosome/ui'
import type { ModelProfile } from '@osteosome/shared'
import { formatCapacity } from '../capacity'
import ModelProfileEditor from './ModelProfileEditor.vue'

const props = defineProps<{
  /** 这个端点当前拉到的模型清单（未探测 = 空） */
  models: string[]
  /** 本端点下已禁用的模型名 */
  disabled: string[]
  /** 当前生效的默认模型（可能不在 models 里 —— 那也是「已设置」） */
  defaultModel: string
  /** `remote` = 真拉到了上游清单；`static` = 内置兜底；`null` = 还没探过 */
  catalog: 'remote' | 'static' | null
  /** 页头搜索词：命中的模型会让所属卡片自动展开，这里再把不命中的模型滤掉 */
  query: string
  /** 模型名 → 能力（本端点作用域，键不带 provider 前缀） */
  profiles?: Record<string, ModelProfile>
}>()

const emit = defineEmits<{
  (e: 'set-default', model: string): void
  (e: 'toggle', model: string, on: boolean): void
  (e: 'update-profile', model: string, profile: ModelProfile): void
}>()

const keyword = computed(() => props.query.trim().toLowerCase())

const visible = computed(() => {
  if (!keyword.value) return props.models
  return props.models.filter((m) => m.toLowerCase().includes(keyword.value))
})

/** 哪些卡片的「设置」是展开的（纯 UI 状态，不落盘） */
const opened = ref<string[]>([])

function isOpen(model: string): boolean {
  return opened.value.includes(model)
}

function toggleOpen(model: string): void {
  opened.value = isOpen(model)
    ? opened.value.filter((m) => m !== model)
    : [...opened.value, model]
}

function isOn(model: string): boolean {
  return !props.disabled.includes(model)
}

function profileOf(model: string): ModelProfile {
  return props.profiles?.[model] ?? {}
}

/**
 * 卡片 meta 行的那句摘要 —— 只列**配过**的项。
 *
 * 全默认时给一句「默认」而不是四行空值：一个几十张卡片的墙，空标签是纯噪音。
 */
function summaryOf(model: string): string {
  const profile = profileOf(model)
  const parts: string[] = []
  if (profile.contextWindow !== undefined) parts.push(`上下文 ${formatCapacity(profile.contextWindow)}`)
  if (profile.maxTokens !== undefined) parts.push(`输出 ${formatCapacity(profile.maxTokens)}`)
  if (profile.input?.includes('image')) parts.push('可收图')
  const levels = profile.reasoningEfforts
  if (levels && levels.length > 0) parts.push(`思考 ${levels.map(levelLabel).join('/')}`)
  return parts.length > 0 ? parts.join(' · ') : '默认'
}

function levelLabel(level: string): string {
  if (level === 'off') return '关'
  if (level === 'low') return '低'
  if (level === 'medium') return '中'
  if (level === 'high') return '高'
  return level
}

/** 三态，缺一不可（见文件头那段「从远程变成静态」的坑） */
const sourceText = computed(() => {
  if (props.catalog === 'remote') return '远程'
  if (props.catalog === 'static') return '静态'
  return '未探测'
})
</script>

<template>
  <div class="wall">
    <p v-if="!models.length" class="wall__empty">这个端点还没有模型清单 —— 点上方「获取模型列表」拉一次。</p>
    <p v-else-if="!visible.length" class="wall__empty">没有匹配的模型。</p>
    <div v-else class="wall__grid">
      <div v-for="m in visible" :key="m" class="mcard" :class="{ 'mcard--off': !isOn(m) }">
        <div class="mcard__row">
          <!--
            模型名**只是名字**：可点击的名字会让人以为点一下是「选中/查看」，
            而它其实是「改默认模型」这种有副作用的写操作 —— 所以默认模型单独一个按钮。
          -->
          <span class="mcard__name" :title="m">{{ m }}</span>
          <Button
            size="sm"
            variant="ghost"
            :aria-expanded="isOpen(m) ? 'true' : 'false'"
            :data-testid="`model-settings-${m}`"
            @click="toggleOpen(m)"
          >
            设置
          </Button>
          <Switch
            :model-value="isOn(m)"
            :aria-label="`模型 ${m}`"
            @update:model-value="emit('toggle', m, $event)"
          />
        </div>
        <div class="mcard__meta">
          <!-- 已经是默认的只留标记，不显示按钮：一个点不动的「设为默认」比标签更碍眼 -->
          <span v-if="defaultModel === m" class="mcard__tag mcard__tag--def">★ 默认</span>
          <Button
            v-else
            size="sm"
            variant="ghost"
            :data-testid="`model-default-${m}`"
            @click="emit('set-default', m)"
          >
            设为默认
          </Button>
          <span v-if="!isOn(m)" class="mcard__tag mcard__tag--off">已停用</span>
          <span class="mcard__summary">{{ summaryOf(m) }}</span>
          <span class="mcard__spacer" />
          <span class="mcard__src">{{ sourceText }}</span>
        </div>
        <ModelProfileEditor
          v-if="isOpen(m)"
          :model="m"
          :profile="profileOf(m)"
          @update:profile="emit('update-profile', m, $event)"
        />
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
  font-size: var(--text-xs);
  color: var(--color-text);
  overflow-wrap: anywhere;
}

.mcard__meta {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  font-size: var(--text-xs);
  color: var(--color-text-muted);
}
.mcard__spacer { flex: 1; }
.mcard__summary { overflow-wrap: anywhere; }
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
