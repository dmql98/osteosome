<script setup lang="ts">
/**
 * 「获取模型列表」之后的第二步：候选勾选 → **采纳进配置**。
 *
 * ## 为什么要有这一步（而不是拉到就直接写）
 *
 * 自建端点（内网网关 / 别人的 vLLM / 代理）的 `/models` 常常一次返回几十上百条，
 * 其中只有几个真能聊。直接全写进配置等于把噪音搬进对话输入框的下拉。
 * 所以这里跟 dsh 的设置-模型 页同一套做法：
 *
 * 拉到的是**候选**，用户勾的才是**配置**；没勾的留在候选里，不落盘。
 *
 * ## 已配置的清单为什么预先勾上
 *
 * 打开时把「配置里已有」与「这次拉到的」并成一张表，已配置的预先勾上 ——
 * 于是这一个弹窗同时承担「加」和「删」：取消勾 = 从清单里移除。
 * 上游清单里**没有**的已配置模型同样列出来（`/models` 不全、或用户手写的名字），
 * 否则一次「获取模型列表」会把用户手填的模型悄悄删掉。
 *
 * ## 拉不到清单不是死路
 *
 * 端点连不上、或没实现 `/models`（自建网关的常见情况）时，这里给一个手填入口：
 * 用户知道自己要哪个模型名，就不该被一个失败的探测卡住。
 *
 * ## 只看 props、只 emit
 *
 * 写入由 `LlmSettingsView` 独占（`models.prefs.set` 是合并式写，两个地方各写一次会互相覆盖），
 * 这个组件连 `useModelsPrefs` 都不认识。
 */
import { computed, ref, watch } from 'vue'
import { Button } from '@osteosome/ui'
import { Checkbox } from '@osteosome/ui'
import { Input } from '@osteosome/ui'
import { Modal } from '@osteosome/ui'

const props = defineProps<{
  open: boolean
  /** 端点 id（弹窗里只用于文案与默认值拼接） */
  endpointId: string
  /** 端点显示名，空则退回 id */
  endpointLabel: string
  /** 这次探测拿到的候选模型（可能为空：连不上 / 没有 /models） */
  candidates: string[]
  /** 配置里已采纳的清单 —— 打开时它们预先勾上 */
  selected: string[]
  /** 探测结论，只用于文案（`null` = 还没探过） */
  catalog: 'remote' | 'static' | null
}>()

const emit = defineEmits<{
  (e: 'update:open', value: boolean): void
  /** 采纳：只带勾上的那些（可能为空数组 = 清空清单） */
  (e: 'confirm', models: string[]): void
}>()

/** 表格里的全部条目（候选 ∪ 已配置 ∪ 手动添加），去重保序 */
const rows = ref<string[]>([])
/** 勾上的条目。**用数组而不是 Set**：模板里要频繁 `includes`，而 Set 的响应式在 Vue 里要额外包一层 */
const checked = ref<string[]>([])
const query = ref('')
const manual = ref('')

function unique(list: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of list) {
    const m = raw.trim()
    if (!m || seen.has(m)) continue
    seen.add(m)
    out.push(m)
  }
  return out
}

/**
 * 每次打开都**重建**编辑态。
 *
 * 不能只在挂载时初始化：同一个弹窗会被不同端点复用，残留上一次的候选会让
 * 「A 端点的模型清单里出现了 B 端点的模型」—— 而这类脏数据一保存就落盘。
 */
watch(
  () => props.open,
  (open) => {
    if (!open) return
    rows.value = unique([...props.selected, ...props.candidates])
    // 已配置过 → 只勾已配置的（这次拉到的新条目要用户自己决定）；
    // 没配过 → 全勾（「我刚拉到的就是我要的」是绝大多数情况）
    checked.value = props.selected.length > 0 ? unique(props.selected) : unique(props.candidates)
    query.value = ''
    manual.value = ''
  },
  { immediate: true },
)

const keyword = computed(() => query.value.trim().toLowerCase())

const visible = computed(() =>
  keyword.value ? rows.value.filter((m) => m.toLowerCase().includes(keyword.value)) : rows.value,
)

function isChecked(model: string): boolean {
  return checked.value.includes(model)
}

function toggle(model: string, on: boolean): void {
  if (on) {
    if (!isChecked(model)) checked.value = [...checked.value, model]
  } else {
    checked.value = checked.value.filter((m) => m !== model)
  }
}

/** 全选 / 取消全选**只作用于当前可见的**：隐藏着的条目用户看不见，替他改就是伤害 */
const allVisibleChecked = computed(
  () => visible.value.length > 0 && visible.value.every((m) => isChecked(m)),
)

function toggleVisible(): void {
  if (allVisibleChecked.value) {
    const visibleSet = new Set(visible.value)
    checked.value = checked.value.filter((m) => !visibleSet.has(m))
    return
  }
  checked.value = unique([...checked.value, ...visible.value])
}

/**
 * 手动添加一条：直接进表并勾上。
 *
 * 进表而不只是进勾选列表 —— 手填的模型名同样要能在表格里被取消勾选、被二次确认。
 */
function addManual(): void {
  const m = manual.value.trim()
  if (!m) return
  rows.value = unique([...rows.value, m])
  if (!isChecked(m)) checked.value = [...checked.value, m]
  manual.value = ''
  // 加完把搜索清掉：否则新加的那条可能被当前搜索词挡住，用户以为没加上
  query.value = ''
}

const pickedCount = computed(() => rows.value.filter((m) => isChecked(m)).length)

const hint = computed(() => {
  const n = props.candidates.length
  if (props.catalog === 'remote') return `上游返回 ${n} 个模型。勾选后写进这个端点的清单，没勾的不会保存。`
  if (props.catalog === 'static') {
    return '这个端点没返回模型清单（连不上，或上游没有 /models）。可以手动添加模型名，或修好端点后再拉一次。'
  }
  return '还没有探测结果。可以手动添加模型名，或先点「获取模型列表」。'
})

function close(): void {
  emit('update:open', false)
}

function confirm(): void {
  emit('confirm', rows.value.filter((m) => isChecked(m)))
  emit('update:open', false)
}

const title = computed(
  () => `模型清单 · ${props.endpointLabel || props.endpointId || '端点'}`,
)
</script>

<template>
  <Modal :open="open" :title="title" :closable="true" @update:open="emit('update:open', $event)">
    <div class="picker">
      <p class="picker__hint">{{ hint }}</p>

      <div class="picker__toolbar">
        <Input
          v-model="query"
          class="picker__search"
          placeholder="搜索模型名…"
          aria-label="model-picker-search"
          data-testid="model-picker-search"
        />
        <Button
          size="sm"
          variant="ghost"
          :disabled="!visible.length"
          data-testid="model-picker-select-all"
          @click="toggleVisible"
        >
          {{ allVisibleChecked ? '取消全选' : '全选' }}
        </Button>
      </div>

      <p v-if="!rows.length" class="picker__empty">还没有条目 —— 用下面的输入框手动加一条。</p>
      <p v-else-if="!visible.length" class="picker__empty">没有匹配的模型。</p>
      <ul v-else class="picker__list" data-testid="model-picker">
        <li v-for="m in visible" :key="m" class="picker__row">
          <Checkbox
            :model-value="isChecked(m)"
            :label="m"
            :data-testid="`model-pick-${m}`"
            @update:model-value="toggle(m, $event)"
          />
        </li>
      </ul>

      <div class="picker__manual">
        <Input
          v-model="manual"
          class="picker__manual-input"
          :placeholder="`手动添加模型名，如 ${endpointId || 'my-model'}`"
          aria-label="model-picker-add-input"
          data-testid="model-picker-add-input"
          @enter="addManual"
        />
        <Button size="sm" variant="ghost" data-testid="model-picker-add" @click="addManual">添加</Button>
      </div>
    </div>
    <template #footer>
      <Button size="sm" variant="ghost" data-testid="model-picker-cancel" @click="close">取消</Button>
      <Button size="sm" variant="primary" data-testid="model-picker-save" @click="confirm">
        保存清单 ({{ pickedCount }})
      </Button>
    </template>
  </Modal>
</template>

<style scoped>
.picker { display: flex; flex-direction: column; gap: var(--space-2); }
.picker__hint { margin: 0; font-size: var(--text-xs); color: var(--color-text-muted); }
.picker__toolbar { display: flex; align-items: center; gap: var(--space-2); }
.picker__search { flex: 1; }
.picker__empty { margin: 0; font-size: var(--text-sm); color: var(--color-text-muted); }

.picker__list {
  margin: 0;
  padding: var(--space-1) 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  max-height: 240px;
  overflow: auto;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-surface-1);
}
.picker__row { padding: 2px var(--space-2); overflow-wrap: anywhere; }

.picker__manual { display: flex; align-items: center; gap: var(--space-2); }
.picker__manual-input { flex: 1; }
</style>
