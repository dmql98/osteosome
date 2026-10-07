<template>
  <div class="sk">
    <header class="sk__head">
      <span class="sk__title">技能</span>
      <span class="sk__n">{{ skills.length }}</span>
      <span class="sk__sp" />
      <nav class="sk__tabs" role="tablist">
        <button class="sk__tab" :class="{ 'is-on': tab === 'catalog' }" data-testid="sk-tab-catalog" @click="tab = 'catalog'">技能库</button>
        <button class="sk__tab" :class="{ 'is-on': tab === 'stats' }" data-testid="sk-tab-stats" @click="tab = 'stats'">统计</button>
      </nav>
    </header>

    <div v-if="!skills.length" class="sk__empty">
      <EmptyState icon="🧩" title="还没有技能" description="技能来自各插件自带的 SKILL.md，或用户自建的 custom/ 目录。" />
    </div>

    <!-- 技能库：按 owner 分组 -->
    <div v-else-if="tab === 'catalog'" class="sk__body">
      <section v-for="g in groups" :key="g.owner" class="sk__group">
        <div class="sk__group-head">
          <span class="sk__group-name">{{ ownerLabel(g.owner) }}</span>
          <span class="sk__group-n">{{ g.items.length }}</span>
        </div>
        <table class="sk__table">
          <thead>
            <tr><th>名称</th><th>描述</th><th>本机可用</th><th>角色</th><th>索引 B</th></tr>
          </thead>
          <tbody>
            <tr v-for="s in g.items" :key="`${s.ownerPluginId}:${s.name}`" :data-testid="`sk-row-${s.name}`" :class="{ 'is-off': !s.enabled }">
              <td class="sk__name">
                <code>{{ s.name }}</code>
                <span v-if="conflicts.has(s.name)" class="sk__warn" :title="conflictHint(s.name)">⚠ 同名冲突</span>
              </td>
              <td class="sk__desc" :title="s.description">{{ s.description || '（无描述）' }}</td>
              <td>
                <Switch :model-value="s.enabled" :data-testid="`sk-switch-${s.name}`" @update:model-value="(v:boolean)=>toggle(s, v)" />
              </td>
              <td class="sk__roles" :data-testid="`sk-roles-${s.name}`">
                绑了 {{ boundCount(s.name) }} · <b :class="{ 'is-zero': effectiveCount(s) === 0 && boundCount(s.name) > 0 }">有效 {{ effectiveCount(s) }}</b>
              </td>
              <td class="sk__bytes">{{ indexBytes(s) }} B</td>
            </tr>
          </tbody>
        </table>
      </section>
    </div>

    <!-- 统计 -->
    <div v-else class="sk__body">
      <div class="sk__stat-grid">
        <div class="sk__stat"><div class="sk__stat-v">{{ skills.length }}</div><div class="sk__stat-l">技能总数</div></div>
        <div class="sk__stat"><div class="sk__stat-v">{{ enabledCount }}</div><div class="sk__stat-l">本机可用</div></div>
        <div class="sk__stat"><div class="sk__stat-v">{{ groups.length }}</div><div class="sk__stat-l">来源分组</div></div>
      </div>
      <div class="sk__budget" :class="{ 'is-hot': totalBytes > budgetBytes }" data-testid="sk-budget">
        <div class="sk__budget-head">
          <span>索引预算</span>
          <span class="sk__mono">{{ totalBytes }} B / {{ budgetBytes }} B　·　{{ enabledCount }} / {{ maxEntries }} 条</span>
        </div>
        <div class="sk__budget-bar"><div class="sk__budget-fill" :style="{ width: `${Math.min(100, (totalBytes / budgetBytes) * 100).toFixed(1)}%` }" /></div>
        <p class="sk__hint">超预算（8 KB / 20 条）时索引片段**整块丢弃**，本轮模型看不到任何技能。</p>
      </div>
      <section v-for="g in groups" :key="`st-${g.owner}`" class="sk__stat-owner">
        <span class="sk__group-name">{{ ownerLabel(g.owner) }}</span>
        <span class="sk__mono">{{ g.items.length }} 个 · {{ groupBytes(g) }} B</span>
      </section>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * widget.skills —— 技能库（按 owner 分组）+ 统计（P6）。
 *
 * 本视图的开关叫「本机可用」（机器级），**不是**「启用」/「绑定」：
 * 与角色绑定的合成是 **AND**，`绑了 N · 有效 M` 是它唯一的出口。
 * 同名冲突标 ⚠ 并说明是哪两个 owner 撞了（被拒的不覆盖生效的）。
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { EmptyState, Switch } from '@osteosome/ui'
import {
  CUSTOM_OWNER_ID,
  SKILL_INDEX_BUDGET_BYTES,
  SKILL_INDEX_MAX_ENTRIES,
  skillIndexBytes,
  skillIndexTotalBytes,
  sortSkillIndex,
  type SkillIndexEntry,
} from '@osteosome/shared'
import { useSkillsState } from '../state'

const { skills, characters, bind, dispose, setEnabled, refresh } = useSkillsState()
const tab = ref<'catalog' | 'stats'>('catalog')

const budgetBytes = SKILL_INDEX_BUDGET_BYTES
const maxEntries = SKILL_INDEX_MAX_ENTRIES

const sorted = computed(() => sortSkillIndex(skills.value))

interface GroupRow { owner: string; items: SkillIndexEntry[] }
const groups = computed<GroupRow[]>(() => {
  const byOwner = new Map<string, SkillIndexEntry[]>()
  for (const s of sorted.value) {
    const arr = byOwner.get(s.ownerPluginId)
    if (arr) arr.push(s)
    else byOwner.set(s.ownerPluginId, [s])
  }
  // owner 顺序跟排序键一致（确定）
  return [...byOwner.entries()].map(([owner, items]) => ({ owner, items }))
})

const enabledCount = computed(() => skills.value.filter((s) => s.enabled).length)
const totalBytes = computed(() => skillIndexTotalBytes(skills.value.filter((s) => s.enabled)))

/** 同名冲突：同一个 name 出现在多个 owner 下 */
const conflicts = computed(() => {
  const byName = new Map<string, Set<string>>()
  for (const s of skills.value) {
    const set = byName.get(s.name) ?? new Set<string>()
    set.add(s.ownerPluginId)
    byName.set(s.name, set)
  }
  return new Set([...byName.entries()].filter(([, owners]) => owners.size > 1).map(([name]) => name))
})

function conflictHint(name: string): string {
  const owners = [...new Set(skills.value.filter((s) => s.name === name).map((s) => s.ownerPluginId))]
  return `同名技能由这些来源提供：${owners.join(' / ')}（被拒的不覆盖生效的）`
}

function ownerLabel(owner: string): string {
  return owner === CUSTOM_OWNER_ID ? '用户自建' : owner
}

/** 有多少角色绑定了这个技能名 */
function boundCount(name: string): number {
  return characters.value.filter((c) => c.skills.includes(name)).length
}
/** 有效 = 绑了 且 本机可用（AND 的出口） */
function effectiveCount(s: SkillIndexEntry): number {
  return s.enabled ? boundCount(s.name) : 0
}
function indexBytes(s: SkillIndexEntry): number {
  return skillIndexBytes(s)
}
function groupBytes(g: GroupRow): number {
  return skillIndexTotalBytes(g.items.filter((s) => s.enabled))
}

async function toggle(s: SkillIndexEntry, value: boolean): Promise<void> {
  await setEnabled(s.ownerPluginId, s.name, value)
}

onMounted(() => {
  bind()
  void refresh()
})
onBeforeUnmount(() => dispose())
</script>

<style scoped>
.sk { display: flex; flex-direction: column; height: 100%; min-height: 0; }
.sk__head { display: flex; align-items: center; gap: var(--space-2); padding: var(--space-3); border-bottom: 1px solid var(--color-border); }
.sk__title { font-weight: 600; }
.sk__n { font-size: var(--text-xs); color: var(--color-text-muted); }
.sk__sp { flex: 1; }
.sk__tabs { display: flex; gap: var(--space-1); }
.sk__tab { border: 0; background: transparent; color: var(--color-text-muted); font: inherit; font-size: var(--text-sm); padding: 4px 10px; cursor: pointer; border-bottom: 2px solid transparent; }
.sk__tab.is-on { color: var(--color-primary); border-bottom-color: var(--color-primary); font-weight: 600; }
.sk__empty { padding: var(--space-5); }
.sk__body { flex: 1; min-height: 0; overflow-y: auto; padding: var(--space-3) var(--space-4); }
.sk__group { margin-bottom: var(--space-4); }
.sk__group-head { display: flex; align-items: baseline; gap: var(--space-2); margin-bottom: var(--space-1); }
.sk__group-name { font-size: var(--text-xs); font-weight: 600; color: var(--color-text-muted); letter-spacing: 0.4px; }
.sk__group-n { font-size: var(--text-xs); color: var(--color-text-muted); }
.sk__table { width: 100%; border-collapse: collapse; font-size: var(--text-sm); }
.sk__table th { text-align: left; font-size: var(--text-xs); color: var(--color-text-muted); font-weight: 600; padding: 4px 8px; border-bottom: 1px solid var(--color-border); }
.sk__table td { padding: 5px 8px; border-bottom: 1px solid var(--color-border); vertical-align: middle; }
.sk__table tr.is-off { opacity: 0.55; }
.sk__name code { font-family: var(--font-mono); font-size: var(--text-xs); }
.sk__warn { color: var(--color-warning); font-size: var(--text-xs); margin-left: var(--space-2); }
.sk__desc { max-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--color-text-muted); }
.sk__roles { white-space: nowrap; font-size: var(--text-xs); }
.sk__roles .is-zero { color: var(--color-warning); }
.sk__bytes { text-align: right; font-family: var(--font-mono); font-size: var(--text-xs); color: var(--color-text-muted); white-space: nowrap; }
.sk__stat-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: var(--space-3); margin-bottom: var(--space-4); }
.sk__stat { border: 1px solid var(--color-border); border-radius: var(--radius-md); padding: var(--space-3); text-align: center; }
.sk__stat-v { font-size: var(--text-xl); font-weight: 700; }
.sk__stat-l { font-size: var(--text-xs); color: var(--color-text-muted); }
.sk__budget { border: 1px solid var(--color-border); border-radius: var(--radius-md); padding: var(--space-3); margin-bottom: var(--space-4); }
.sk__budget.is-hot { border-color: var(--color-danger); color: var(--color-danger); }
.sk__budget-head { display: flex; justify-content: space-between; font-size: var(--text-sm); }
.sk__budget-bar { height: 8px; border-radius: var(--radius-full); background: var(--color-surface-3); overflow: hidden; margin: var(--space-2) 0; }
.sk__budget-fill { height: 100%; background: var(--color-primary); }
.sk__budget.is-hot .sk__budget-fill { background: var(--color-danger); }
.sk__hint { font-size: var(--text-xs); color: var(--color-text-muted); margin: 0; }
.sk__stat-owner { display: flex; justify-content: space-between; padding: var(--space-1) 0; font-size: var(--text-sm); }
.sk__mono { font-family: var(--font-mono); font-size: var(--text-xs); color: var(--color-text-muted); }
</style>
