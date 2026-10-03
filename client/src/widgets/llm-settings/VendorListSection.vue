<script setup lang="ts">
/**
 * 服务商列表 —— 模型配置页的第二块。
 *
 * ## 分成「已连接 / 未连接」而不是平铺 12 行
 *
 * 原页面把 12 家预设平铺成一个长列表，每家展开后是只读的事实表。
 * 但 12 家里通常只有 1–2 家真的连上了 —— 剩下 11 行是纯噪音，用户要滚动着找。
 *
 * 所以：连上的排前面并**默认展开**，没连的压成**一行一家**。
 * 一行能放下「名称 + 需要什么凭证 + 一个动作按钮」，扫一眼就知道该点哪个。
 *
 * ## 为什么展开后可以就地改
 *
 * 因为 `buildVendorInstances` 里 `byId` 是 Map：先塞预设，**再用 override 按同 id 覆盖**
 * （`byId.set(instance.id, instance)`）。所以「改预设的端点 / 默认模型」=
 * 写一条同 id 的 `vendorOverride`，不需要新增任何 Core 侧机制。
 *
 * ## 但没配凭证的云厂商不能就地改端点
 *
 * `instanceFromOverride` 在 `credentialRef` 解析不出来时返回 `null`，
 * 那条 override **压根不会成为实例** —— 于是用户填了端点却毫无效果，而且没有任何提示。
 *
 * 所以这类厂商不给端点编辑框，只给「设置密钥」：先让它成为实例，再谈改端点。
 * 这条约束写在这里是因为它很容易被下一个人「顺手放开」。
 *
 * ## ⚠️ 文件头不要放 JS 块注释
 *
 * Vue 的 SFC 解析器把 `<script>` **之前**的内容按 HTML 解析，
 * 注释里出现 `<dl>` 这类尖括号会被当成顶层标签，报 `Element is missing end tag`
 * 且位置完全不指向真因。所以注释一律写在 `<script>` 内部。
 */
import { computed, ref } from 'vue'
import Button from '@/components/ui/Button.vue'
import Input from '@/components/ui/Input.vue'

export interface VendorRow {
  id: string
  label: string
  baseUrl: string
  /** 空串 = 免凭证 */
  credentialEnv: string
  defaultModel: string
  note?: string
}

const props = defineProps<{
  vendors: VendorRow[]
  /** provider id → 是否已连上（注册成了实例） */
  connected: Record<string, boolean>
  /** provider id → 当前端点（可能是 override 改过的） */
  effectiveBaseUrl: Record<string, string>
  /** provider id → 当前默认模型 */
  effectiveModel: Record<string, string>
  /** provider id → 该 id 上是否有 override（用于标「已覆盖预设」） */
  overridden: Record<string, boolean>
  probing: Record<string, boolean>
  reachable: Record<string, boolean | null>
  expanded: string[]
}>()

const emit = defineEmits<{
  (e: 'toggle', providerId: string): void
  (e: 'set-key', providerId: string): void
  (e: 'remove-key', providerId: string): void
  (e: 'probe', providerId: string): void
  (e: 'edit-base-url', providerId: string, value: string): void
  (e: 'edit-model', providerId: string, value: string): void
}>()

const query = ref('')
/** 正在就地改端点的 provider（'' = 都没在改） */
const editingUrl = ref('')
const urlDraft = ref('')

const keyword = computed(() => query.value.trim().toLowerCase())

const connectedList = computed(() =>
  props.vendors.filter(
    (v) => props.connected[v.id] && (!keyword.value || v.label.toLowerCase().includes(keyword.value) || v.id.includes(keyword.value)),
  ),
)
const pendingList = computed(() =>
  props.vendors.filter(
    (v) => !props.connected[v.id] && (!keyword.value || v.label.toLowerCase().includes(keyword.value) || v.id.includes(keyword.value)),
  ),
)

/** 未连接的一律按「需要什么」分两类，动作不同：设密钥 vs 直接连 */
function needsKey(v: VendorRow): boolean {
  return v.credentialEnv !== ''
}

function startEditUrl(vendorId: string, current: string): void {
  editingUrl.value = vendorId
  urlDraft.value = current
}

function commitUrl(vendorId: string): void {
  const next = urlDraft.value.trim()
  if (next) emit('edit-base-url', vendorId, next)
  editingUrl.value = ''
  urlDraft.value = ''
}

function cancelEdit(): void {
  editingUrl.value = ''
  urlDraft.value = ''
}

function stateDot(vendorId: string): string {
  const r = props.reachable[vendorId]
  if (r === true) return 'green'
  if (r === false) return 'red'
  return 'gray'
}
</script>

<template>
  <section class="vendors">
    <header class="vendors__head">
      <h3 class="vendors__title">服务商</h3>
      <Input v-model="query" class="vendors__search" placeholder="搜索服务商…" aria-label="vendor-search" />
    </header>

    <div v-if="connectedList.length" class="vendors__group">
      <div class="vendors__group-title">已连接 ({{ connectedList.length }})</div>
      <div v-for="v in connectedList" :key="v.id" class="vendor vendor--on">
        <button type="button" class="vendor__head" :data-testid="`vendor-${v.id}`" @click="emit('toggle', v.id)">
          <span class="dot" :class="stateDot(v.id)" />
          <span class="vendor__name">{{ v.label }}</span>
          <span v-if="overridden[v.id]" class="vendor__badge">已覆盖预设</span>
          <span class="vendor__id mono">{{ v.id }}</span>
        </button>

        <div v-if="expanded.includes(v.id)" class="vendor__body">
          <div class="vendor__field">
            <span class="vendor__key">端点</span>
            <template v-if="editingUrl === v.id">
              <Input v-model="urlDraft" class="vendor__input mono" :placeholder="v.baseUrl" />
              <Button size="sm" variant="primary" @click="commitUrl(v.id)">保存</Button>
              <Button size="sm" variant="ghost" @click="cancelEdit">取消</Button>
            </template>
            <template v-else>
              <span class="vendor__val mono">{{ effectiveBaseUrl[v.id] || v.baseUrl }}</span>
              <Button size="sm" variant="ghost" :data-testid="`vendor-url-${v.id}`" @click="startEditUrl(v.id, effectiveBaseUrl[v.id] || v.baseUrl)">
                改端点
              </Button>
            </template>
          </div>

          <div class="vendor__field">
            <span class="vendor__key">模型</span>
            <Input
              class="vendor__input mono"
              :model-value="effectiveModel[v.id] || ''"
              :placeholder="v.defaultModel || '这个端点由你决定模型名'"
              :data-testid="`vendor-model-${v.id}`"
              @update:model-value="emit('edit-model', v.id, $event)"
            />
          </div>

          <div class="vendor__field">
            <span class="vendor__key">凭证</span>
            <span class="vendor__val">{{ v.credentialEnv ? `已保存（${v.credentialEnv}）` : '免凭证（本地端点）' }}</span>
            <Button size="sm" variant="ghost" :data-testid="`vendor-setkey-${v.id}`" @click="emit('set-key', v.id)">
              换密钥
            </Button>
          </div>

          <div class="vendor__actions">
            <Button size="sm" variant="ghost" :disabled="probing[v.id]" @click="emit('probe', v.id)">
              {{ probing[v.id] ? '探测中…' : '连通性测试' }}
            </Button>
            <Button v-if="needsKey(v)" size="sm" variant="ghost" @click="emit('remove-key', v.id)">删除密钥</Button>
          </div>

          <p v-if="v.note" class="vendor__note">{{ v.note }}</p>
        </div>
      </div>
    </div>

    <div v-if="pendingList.length" class="vendors__group">
      <div class="vendors__group-title">未连接 ({{ pendingList.length }})</div>
      <div v-for="v in pendingList" :key="v.id" class="vendor vendor--off">
        <span class="vendor__name">{{ v.label }}</span>
        <span class="vendor__id mono">{{ v.id }}</span>
        <span class="vendor__need">{{ v.credentialEnv ? `需要 ${v.credentialEnv}` : '免凭证' }}</span>
        <Button
          size="sm"
          variant="ghost"
          :data-testid="`vendor-connect-${v.id}`"
          @click="needsKey(v) ? emit('set-key', v.id) : emit('toggle', v.id)"
        >
          {{ needsKey(v) ? '设置密钥' : '直接连' }}
        </Button>
      </div>
    </div>

    <p v-if="!connectedList.length && !pendingList.length" class="vendors__empty">没有匹配的服务商。</p>
  </section>
</template>

<style scoped>
.vendors { display: flex; flex-direction: column; gap: var(--space-2); }
.vendors__head { display: flex; align-items: center; gap: var(--space-2); }
.vendors__title { margin: 0; font-size: var(--text-sm); font-weight: 700; flex: 1; }
.vendors__search { max-width: 180px; }
.vendors__group { display: flex; flex-direction: column; gap: var(--space-1); }
.vendors__group-title { font-size: var(--text-xs); color: var(--color-text-muted); margin-top: var(--space-1); }
.vendors__empty { font-size: var(--text-sm); color: var(--color-text-muted); margin: 0; }

.vendor {
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-surface-1);
}
.vendor--on { border-color: var(--color-primary); }
.vendor--off { display: flex; align-items: center; gap: var(--space-2); padding: var(--space-2) var(--space-3); }

.vendor__head {
  display: flex; align-items: center; gap: var(--space-2);
  width: 100%; padding: var(--space-2) var(--space-3);
  background: none; border: none; font: inherit; color: inherit; cursor: pointer; text-align: left;
}
.vendor__name { font-weight: 600; font-size: var(--text-sm); }
.vendor__id { font-size: var(--text-xs); color: var(--color-text-muted); }
.vendor__badge {
  font-size: var(--text-xs); color: var(--color-warning);
  border: 1px solid var(--color-warning); border-radius: var(--radius-full); padding: 0 6px;
}
.vendor__need { flex: 1; font-size: var(--text-xs); color: var(--color-text-muted); }
.vendor__body {
  display: flex; flex-direction: column; gap: var(--space-2);
  padding: 0 var(--space-3) var(--space-3);
}
.vendor__field { display: flex; align-items: center; gap: var(--space-2); }
.vendor__key { flex: none; width: 40px; font-size: var(--text-xs); color: var(--color-text-muted); }
.vendor__val { flex: 1; min-width: 0; font-size: var(--text-xs); overflow-wrap: anywhere; }
.vendor__input { flex: 1; min-width: 0; }
.vendor__actions { display: flex; gap: var(--space-2); }
.vendor__note { margin: 0; font-size: var(--text-xs); color: var(--color-text-muted); }
</style>