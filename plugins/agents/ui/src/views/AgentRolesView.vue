<template>
  <div class="ag">
    <!-- 左栏：角色列表 -->
    <aside class="ag__list">
      <header class="ag__head">
        <span class="ag__title">角色</span>
        <span class="ag__n">{{ characters.length }}</span>
        <span class="ag__sp" />
        <Button size="sm" data-testid="ag-new" @click="onCreate">新建</Button>
      </header>
      <div v-if="!characters.length" class="ag__empty">
        <EmptyState
          icon="🎭"
          title="还没有角色"
          description="角色是一组绑定（提示词 / 技能 / 工具 / 模型偏好）。"
        />
      </div>
      <ul v-else class="ag__items" role="listbox" aria-label="角色列表">
        <li
          v-for="c in characters"
          :key="c.id"
          class="ag__item"
          :class="{ 'is-active': c.id === selectedId }"
          role="option"
          :aria-selected="c.id === selectedId"
          :data-testid="`ag-item-${c.id}`"
          @click="selectedId = c.id"
        >
          <span class="ag__emoji">{{ c.emoji || '🎭' }}</span>
          <span class="ag__name">{{ c.name || c.id }}</span>
          <Badge v-if="!c.prompt.trim()" variant="neutral" data-testid="ag-bare">裸会话</Badge>
        </li>
      </ul>
    </aside>

    <!-- 右栏：编辑器 -->
    <section class="ag__detail">
      <div v-if="!selected" class="ag__detail-empty">
        <EmptyState icon="👈" title="选一个角色" description="左侧列表里点一个角色开始编辑。" />
      </div>

      <template v-else>
        <header class="ag__detail-head">
          <span class="ag__detail-emoji">{{ selected.emoji || '🎭' }}</span>
          <span class="ag__detail-title">{{ selected.name || selected.id }}</span>
          <code class="ag__detail-id">{{ selected.id }}</code>
          <span class="ag__sp" />
          <Button size="sm" variant="danger" data-testid="ag-delete" @click="onDelete">删除</Button>
        </header>

        <nav class="ag__tabs" role="tablist">
          <button
            v-for="t in TABS"
            :key="t.key"
            class="ag__tab"
            :class="{ 'is-on': tab === t.key }"
            role="tab"
            :aria-selected="tab === t.key"
            :data-testid="`ag-tab-${t.key}`"
            @click="tab = t.key"
          >
            {{ t.label }}
          </button>
        </nav>

        <div class="ag__pane">
          <!-- 角色（身份 + 人格提示词） -->
          <template v-if="tab === 'identity'">
            <label class="ag__field">
              <span class="ag__label">名称</span>
              <Input :model-value="selected.name" data-testid="ag-name" @update:model-value="onName" />
            </label>
            <label class="ag__field">
              <span class="ag__label">表情</span>
              <Input :model-value="selected.emoji ?? ''" placeholder="🎭" data-testid="ag-emoji" @update:model-value="onEmoji" />
            </label>
            <label class="ag__field">
              <span class="ag__label">人格提示词（p5）</span>
              <Textarea
                :model-value="selected.prompt"
                :rows="6"
                auto-grow
                placeholder="你是……（留空 = 裸会话，p5 层为空）"
                data-testid="ag-prompt"
                @update:model-value="onPromptInput"
                @blur="save({ prompt: selected.prompt })"
              />
            </label>
            <div v-if="!selected.prompt.trim()" class="ag__info" data-testid="ag-bare-info">
              这个角色没有人格提示词，p5 层为空，会话<strong>回落到裸会话</strong>。这是合法配置。
            </div>
          </template>

          <!-- 绑定（工具 / 技能） -->
          <template v-else-if="tab === 'bindings'">
            <div class="ag__field">
              <span class="ag__label">工具</span>
              <label class="ag__inline">
                <input type="checkbox" :checked="selected.tools === '*'" data-testid="ag-tools-all" @change="toggleAllTools" />
                <span>全部工具（<code>*</code>）</span>
              </label>
              <Input
                v-if="selected.tools !== '*'"
                :model-value="(selected.tools as string[]).join(', ')"
                placeholder="read, glob, grep"
                data-testid="ag-tools"
                @update:model-value="onTools"
              />
              <p v-if="selected.tools !== '*' && (selected.tools as string[]).length" class="ag__dangling" data-testid="ag-tools-dangling">
                工具服务未装 —— 这些是<strong>悬空引用</strong>，装配时忽略、不报错。
              </p>
            </div>
            <div class="ag__field">
              <span class="ag__label">技能</span>
              <Input
                :model-value="selected.skills.join(', ')"
                placeholder="git-diff, sql-explain"
                data-testid="ag-skills"
                @update:model-value="onSkills"
              />
              <p v-if="selected.skills.length" class="ag__dangling" data-testid="ag-skills-dangling">
                技能服务未装 —— 悬空引用，装配时忽略。
              </p>
            </div>
          </template>

          <!-- 模型偏好 -->
          <template v-else-if="tab === 'model'">
            <div class="ag__field">
              <span class="ag__label">provider</span>
              <Select
                :model-value="selected.provider ?? ''"
                :options="providerOptions"
                data-testid="ag-provider"
                @update:model-value="onPickProvider"
              />
            </div>
            <div class="ag__field">
              <span class="ag__label">模型</span>
              <Select
                :model-value="selected.model ?? ''"
                :options="modelOptions"
                data-testid="ag-model"
                @update:model-value="onPickModel"
              />
            </div>
            <div class="ag__field">
              <span class="ag__label">思考强度</span>
              <Select
                :model-value="selected.thinking ?? ''"
                :options="thinkingOptions"
                data-testid="ag-thinking"
                @update:model-value="onPickThinking"
              />
            </div>
            <p class="ag__hint">省略即「不覆盖」，回落链：loop.run 参数 → 角色偏好 → models 默认 → env → 硬编码。</p>
          </template>

          <!-- 装配预览 -->
          <template v-else-if="tab === 'assembly'">
            <div class="ag__budget" :class="{ 'is-hot': p5Bytes > 8192 }" data-testid="ag-p5">
              <span class="ag__label">p5 角色层</span>
              <span v-if="!selected.prompt.trim()" class="ag__mono">（空）</span>
              <span v-else class="ag__mono">{{ p5Bytes }} B / 8192 B</span>
            </div>
            <div class="ag__field">
              <span class="ag__label">工具（{{ selected.tools === '*' ? '全部' : (selected.tools as string[]).length }}）</span>
              <div class="ag__chips">
                <template v-if="selected.tools === '*'">
                  <span class="ag__chip">*（全部）</span>
                </template>
                <template v-else>
                  <span v-for="t in selected.tools as string[]" :key="t" class="ag__chip is-dangling" title="工具服务未装：悬空引用">{{ t }}</span>
                </template>
              </div>
            </div>
            <div class="ag__field">
              <span class="ag__label">技能（{{ selected.skills.length }}）</span>
              <div class="ag__chips">
                <span v-if="!selected.skills.length" class="ag__mono">（无）</span>
                <span v-for="s in selected.skills" :key="s" class="ag__chip is-dangling" title="技能服务未装：悬空引用">{{ s }}</span>
              </div>
            </div>
            <div class="ag__field">
              <span class="ag__label">模型</span>
              <span class="ag__mono">{{ modelSummary }}</span>
            </div>
            <p class="ag__hint">装配 = 本机可用 ∩ 角色绑定。悬空引用按「忽略 + 标一条」处理，不报错。</p>
          </template>

          <!-- 事件 -->
          <template v-else>
            <p v-if="!events.length" class="ag__mono">（暂无事件）</p>
            <ul v-else class="ag__events" data-testid="ag-events">
              <li v-for="(e, i) in events" :key="i" class="ag__event">
                <code>{{ e.topic }}</code>
                <span class="ag__event-s">{{ e.summary }}</span>
              </li>
            </ul>
          </template>
        </div>
      </template>
    </section>
  </div>
</template>

<script setup lang="ts">
/**
 * widget.agents —— 角色目录 + 编辑器（P5）。
 *
 * 5 个 Tab：角色（身份 + 人格提示词）/ 绑定（工具 + 技能）/ 模型偏好 / 装配预览 / 事件。
 * 所有写都是**逐字段自动保存**（`agent.state.set`，合并式），没有「保存」按钮。
 * 缺失是合法的：绑了但本机没有的服务一律标「悬空引用」，不报错、不阻止保存。
 *
 * ## 保存时机
 *
 * 文本字段（名称 / 表情 / 工具 / 技能）在 `@update:model-value`（每次输入）就发 patch ——
 * 合并式语义天然适合逐字段保存；人格提示词较长，用 `@blur`（Textarea 的根是 textarea，
 * blur 能冒泡；Input 的根是 div，blur 不冒泡，所以那几处不用 blur）。下拉在 change 时保存。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Badge, Button, EmptyState, Input, Select, Textarea } from '@osteosome/ui'
import { useLlmProviders, useModelCatalog } from '@osteosome/core-client'
import type { AgentStatePatch, CharacterBrief, ThinkingEffort } from '@osteosome/shared'
import { useAgentState } from '../state'

const { characters, events, bind, dispose, setPatch, refresh } = useAgentState()
const { list } = useLlmProviders()
const { models, load } = useModelCatalog()

const TABS = [
  { key: 'identity', label: '角色' },
  { key: 'bindings', label: '绑定' },
  { key: 'model', label: '模型' },
  { key: 'assembly', label: '装配' },
  { key: 'events', label: '事件' },
] as const
type TabKey = (typeof TABS)[number]['key']
const tab = ref<TabKey>('identity')

const selectedId = ref('')
const selected = computed(() => characters.value.find((c) => c.id === selectedId.value))

watch(
  characters,
  (all) => {
    if (!selectedId.value && all.length > 0) selectedId.value = all[0].id
    if (selectedId.value && !all.some((c) => c.id === selectedId.value)) selectedId.value = all[0]?.id ?? ''
  },
  { immediate: true },
)

function splitNames(v: string): string[] {
  return v.split(/[\n,，]/).map((s) => s.trim()).filter((s) => s !== '')
}

async function save(patch: Partial<CharacterBrief>): Promise<void> {
  if (!selected.value) return
  await setPatch({ character: { id: selected.value.id, ...patch } as AgentStatePatch['character'] })
}

// 文本字段：先改本地对象（即时反馈），再发合并 patch
function onName(v: string): void {
  if (!selected.value) return
  selected.value.name = v
  void save({ name: v })
}
function onEmoji(v: string): void {
  if (!selected.value) return
  selected.value.emoji = v
  void save({ emoji: v })
}
function onPromptInput(v: string): void {
  if (!selected.value) return
  selected.value.prompt = v
}
function onTools(v: string): void {
  if (!selected.value) return
  selected.value.tools = splitNames(v)
  void save({ tools: selected.value.tools })
}
function onSkills(v: string): void {
  if (!selected.value) return
  selected.value.skills = splitNames(v)
  void save({ skills: selected.value.skills })
}
function toggleAllTools(e: Event): void {
  const all = (e.target as HTMLInputElement).checked
  void save({ tools: all ? '*' : [] })
}

async function onCreate(): Promise<void> {
  const id = `c_${Date.now().toString(36)}`
  await setPatch({ character: { id, name: '新角色', prompt: '', skills: [], tools: '*' } })
  selectedId.value = id
}
async function onDelete(): Promise<void> {
  if (!selected.value) return
  await setPatch({ removed: selected.value.id })
}

// ── 模型 Tab ──────────────────────────────────────────────
const providerOptions = computed(() => [
  { label: '（不覆盖）', value: '' },
  ...list.value.map((p) => ({ label: p.provider, value: p.provider })),
])
const modelOptions = computed(() => [{ label: '（不覆盖）', value: '' }, ...models.value.map((m) => ({ label: m, value: m }))])
const thinkingOptions = [
  { label: '（不覆盖）', value: '' },
  { label: '关', value: 'off' },
  { label: '低', value: 'low' },
  { label: '中', value: 'medium' },
  { label: '高', value: 'high' },
]
async function onPickProvider(v: string): Promise<void> {
  await save({ provider: v })
  if (v) await load(v)
}
function onPickModel(v: string): void {
  void save({ model: v })
}
function onPickThinking(v: string): void {
  void save({ thinking: v as ThinkingEffort })
}
const modelSummary = computed(() => {
  const c = selected.value
  if (!c) return ''
  return [c.provider, c.model, c.thinking].filter(Boolean).join(' · ') || '（不覆盖，用默认）'
})

// ── 装配预览 ──────────────────────────────────────────────
const p5Bytes = computed(() => new TextEncoder().encode(selected.value?.prompt ?? '').length)

onMounted(() => {
  bind()
  void refresh()
})
onBeforeUnmount(() => dispose())
</script>

<style scoped>
.ag { display: grid; grid-template-columns: 220px 1fr; height: 100%; min-height: 0; }
.ag__list { display: flex; flex-direction: column; min-height: 0; border-right: 1px solid var(--color-border); }
.ag__head { display: flex; align-items: center; gap: var(--space-2); padding: var(--space-3); }
.ag__title { font-weight: 600; }
.ag__n { font-size: var(--text-xs); color: var(--color-text-muted); }
.ag__sp { flex: 1; }
.ag__empty { padding: var(--space-4); }
.ag__items { list-style: none; margin: 0; padding: 0 6px; overflow-y: auto; }
.ag__item { display: flex; align-items: center; gap: var(--space-2); padding: 6px 8px; border-radius: var(--radius-md); cursor: pointer; }
.ag__item:hover { background: var(--color-surface-2); }
.ag__item.is-active { background: var(--color-primary-soft); }
.ag__emoji { flex: none; }
.ag__name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--text-sm); }
.ag__detail { display: flex; flex-direction: column; min-height: 0; overflow: hidden; }
.ag__detail-empty { padding: var(--space-5); }
.ag__detail-head { display: flex; align-items: center; gap: var(--space-2); padding: var(--space-3); border-bottom: 1px solid var(--color-border); }
.ag__detail-emoji { font-size: var(--text-lg); }
.ag__detail-title { font-weight: 600; }
.ag__detail-id { font-size: var(--text-xs); color: var(--color-text-muted); }
.ag__tabs { display: flex; gap: var(--space-1); padding: var(--space-2) var(--space-3) 0; border-bottom: 1px solid var(--color-border); }
.ag__tab { border: 0; background: transparent; color: var(--color-text-muted); font: inherit; font-size: var(--text-sm); padding: 6px 10px; cursor: pointer; border-bottom: 2px solid transparent; }
.ag__tab.is-on { color: var(--color-primary); border-bottom-color: var(--color-primary); font-weight: 600; }
.ag__pane { flex: 1; min-height: 0; overflow-y: auto; padding: var(--space-4); display: flex; flex-direction: column; gap: var(--space-4); }
.ag__field { display: flex; flex-direction: column; gap: var(--space-1); }
.ag__label { font-size: var(--text-xs); color: var(--color-text-muted); }
.ag__inline { display: flex; align-items: center; gap: var(--space-2); font-size: var(--text-sm); }
.ag__mono { font-family: var(--font-mono); font-size: var(--text-xs); color: var(--color-text-muted); }
.ag__hint { font-size: var(--text-xs); color: var(--color-text-muted); margin: 0; }
.ag__info { padding: var(--space-2) var(--space-3); border-left: 3px solid var(--color-primary); background: var(--color-primary-soft); border-radius: var(--radius-md); font-size: var(--text-xs); }
.ag__dangling { font-size: var(--text-xs); color: var(--color-warning); margin: var(--space-1) 0 0; }
.ag__budget { display: flex; align-items: baseline; gap: var(--space-2); padding: var(--space-2) var(--space-3); border: 1px solid var(--color-border); border-radius: var(--radius-md); }
.ag__budget.is-hot { border-color: var(--color-danger); color: var(--color-danger); }
.ag__chips { display: flex; flex-wrap: wrap; gap: var(--space-1); }
.ag__chip { font-size: var(--text-xs); padding: 1px 6px; border-radius: var(--radius-full); border: 1px solid var(--color-border); }
.ag__chip.is-dangling { border-style: dashed; border-color: var(--color-warning); color: var(--color-warning); }
.ag__events { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--space-1); font-size: var(--text-xs); }
.ag__event { display: flex; gap: var(--space-2); font-family: var(--font-mono); }
.ag__event-s { color: var(--color-text-muted); }
</style>
