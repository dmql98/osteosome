<script setup lang="ts">
/**
 * 已连接服务商卡片 —— 模型配置页的主体。
 *
 * ## 一张卡回答「这家现在什么状态」
 *
 * 头部一行扫完：名称 · 覆盖标记 · 模型数 · 连通状态 · 有没有密钥。
 * 身体是「怎么改」：端点就地改、凭证入口、默认模型，再往下是模型墙。
 * 头部永远可见（身体收起时也在），所以「连没连上」不需要展开才看得到。
 *
 * 头部右侧还有一个红色的「删除」—— 把这家移回「未连接的预设」。
 * 它放在头部而不是身体里，因为**接错了这件事在收起状态下也要能改**：
 * 接进来才发现不对的用户，不该先展开卡片才找得到退路。
 * 收起时该按钮仍在（头部不参与 `v-show`），所以这个入口永远在。
 *
 * ## 只吃 props、只 emit
 *
 * 偏好写入、凭证 HTTP、探测命令全在 `LlmSettingsView`。
 * 这个组件不认识 `usePreferences`，也就不会有自己的写入队列 ——
 * 否则两个组件各自 `patch` 会在 `llm` 键上互相覆盖
 * （`usePreferences.patch` 是**浅合并**，整层 `llm` 会被换掉）。
 *
 * ## 端点为什么可以就地改
 *
 * `buildVendorInstances` 里 `byId` 是 Map：先塞预设，**再用同 id 的 override 覆盖**。
 * 所以「改预设端点」= 写一条同 id 的 `vendorOverride`，不需要任何 Core 侧新机制。
 * 但**没配凭证的云厂商改了也白改** —— `instanceFromOverride` 在凭证解析不出来时
 * 返回 `null`，那条 override 压根不会成为实例。所以那类端点只给凭证入口。
 */
import { computed, ref } from 'vue'
import { Button } from '@osteosome/ui'
import { Input } from '@osteosome/ui'
import ModelWall from './ModelWall.vue'

export interface ProviderCardData {
  id: string
  label: string
  baseUrl: string
  /** 空串 = 免凭证（本地端点） */
  credentialEnv: string
  /** 本插件的凭证文件里有没有这家的密钥（owner 重播的掩码列表） */
  hasKey: boolean
  /** 当前生效的默认模型（override 优先于预设） */
  defaultModel: string
  /** 预设声明的默认模型，只用作输入框占位 */
  presetDefaultModel: string
  /** 该 id 上有 override（标「已覆盖预设」） */
  overridden: boolean
  note?: string
  models: string[]
  probing: boolean
  /** null = 还没探过；与「探过了不行」要分开显示 */
  reachable: boolean | null
  latencyMs: number | null
  expanded: boolean
  /** 本端点下已禁用的模型名（省掉子组件再理解 `provider::model`） */
  disabled: string[]
}

const props = defineProps<{
  provider: ProviderCardData
  /** 页头搜索词 —— 透传给模型墙做模型名过滤 */
  query: string
}>()

const emit = defineEmits<{
  (e: 'toggle'): void
  (e: 'probe'): void
  (e: 'set-key'): void
  (e: 'remove-key'): void
  (e: 'edit-base-url', value: string): void
  (e: 'edit-model', value: string): void
  (e: 'set-default', model: string): void
  (e: 'toggle-model', model: string, on: boolean): void
  (e: 'set-all', on: boolean): void
  /** 退回未连接：把这家从接入清单里摘掉（密钥与端点配置保留） */
  (e: 'disconnect'): void
}>()

/** 端点就地编辑：'' = 没在改 */
const urlDraft = ref('')
const editingUrl = ref(false)

function startEditUrl(): void {
  urlDraft.value = props.provider.baseUrl
  editingUrl.value = true
}

function commitUrl(): void {
  const next = urlDraft.value.trim()
  if (next) emit('edit-base-url', next.replace(/\/+$/, ''))
  editingUrl.value = false
}

function cancelEdit(): void {
  editingUrl.value = false
  urlDraft.value = ''
}

const credentialLine = computed(() => {
  const p = props.provider
  if (!p.credentialEnv) return '免凭证（本地端点）'
  if (p.hasKey) return `已保存 · ${p.credentialEnv}`
  return `环境变量 ${p.credentialEnv}`
})

/** 探测状态一句话。`reachable === null` 是「还没测」，不是「测过了不行」 */
const statusText = computed(() => {
  const p = props.provider
  if (p.probing) return '探测中…'
  if (p.reachable === null) return '未测试'
  if (p.reachable) return p.latencyMs === null ? '已连通' : `已连通 ${p.latencyMs}ms`
  return '连不上 · 静态清单'
})

const statusClass = computed(() => {
  const p = props.provider
  if (p.probing) return 'is-probing'
  if (p.reachable === null) return 'is-idle'
  return p.reachable ? 'is-ok' : 'is-bad'
})

const keyBadge = computed(() => {
  const p = props.provider
  if (!p.credentialEnv) return { cls: 'key--none', text: '免凭证' }
  return p.hasKey ? { cls: 'key--has', text: '••••' } : { cls: 'key--miss', text: '缺' }
})

/** 就地改端点只在「改了会真的生效」时给入口 —— 见文件头那段约束 */
const canEditUrl = computed(() => Boolean(props.provider.credentialEnv) === false || props.provider.hasKey)

function onToggleModel(model: string, on: boolean): void {
  emit('toggle-model', model, on)
}
</script>

<template>
  <article class="pcard" :class="{ 'pcard--open': provider.expanded }" :data-testid="`vendor-${provider.id}`" :data-pid="provider.id">
    <div class="pcard__head">
      <button type="button" class="pcard__toggle" :aria-expanded="provider.expanded ? 'true' : 'false'" @click="emit('toggle')">
        <span class="pcard__logo" aria-hidden="true">{{ provider.label.slice(0, 1) }}</span>
        <span class="pcard__name">{{ provider.label }}</span>
        <span v-if="provider.overridden" class="pcard__badge">已覆盖预设</span>
        <span class="pcard__count">{{ provider.models.length }} 个模型</span>
        <span class="pcard__status" :class="statusClass">{{ statusText }}</span>
        <span class="pcard__key" :class="keyBadge.cls">{{ keyBadge.text }}</span>
        <span class="pcard__chev" aria-hidden="true">{{ provider.expanded ? '▾' : '▸' }}</span>
      </button>
      <div class="pcard__actions">
        <Button size="sm" variant="ghost" :disabled="provider.probing" data-testid="probe-active" @click="emit('probe')">
          {{ provider.probing ? '探测中…' : '连通性测试' }}
        </Button>
        <Button size="sm" variant="ghost" @click="emit('set-key')">
          {{ provider.hasKey ? '换密钥' : '设置密钥' }}
        </Button>
        <Button v-if="provider.credentialEnv && provider.hasKey" size="sm" variant="ghost" @click="emit('remove-key')">
          删除密钥
        </Button>
        <Button
          size="sm"
          variant="danger"
          :title="'把这家移回未连接的预设（密钥与端点设置保留）'"
          :data-testid="`vendor-disconnect-${provider.id}`"
          @click="emit('disconnect')"
        >
          删除
        </Button>
      </div>
    </div>

    <div v-show="provider.expanded" class="pcard__body">
      <div class="field">
        <span class="field__key">端点</span>
        <template v-if="editingUrl">
          <Input v-model="urlDraft" class="field__input mono" placeholder="http://127.0.0.1:1234/v1" />
          <Button size="sm" variant="primary" @click="commitUrl">保存</Button>
          <Button size="sm" variant="ghost" @click="cancelEdit">取消</Button>
        </template>
        <template v-else>
          <span class="field__val mono">{{ provider.baseUrl }}</span>
          <Button
            v-if="canEditUrl"
            size="sm"
            variant="ghost"
            :data-testid="`vendor-url-${provider.id}`"
            @click="startEditUrl"
          >
            改端点
          </Button>
          <span v-else class="field__hint">配好密钥后才能改端点</span>
        </template>
      </div>

      <div class="field">
        <span class="field__key">凭证</span>
        <span class="field__val">{{ credentialLine }}</span>
        <Button size="sm" variant="ghost" :data-testid="`vendor-setkey-${provider.id}`" @click="emit('set-key')">
          {{ provider.hasKey ? '换密钥' : '设置密钥' }}
        </Button>
      </div>

      <div class="field">
        <span class="field__key">默认</span>
        <Input
          class="field__input mono"
          :model-value="provider.defaultModel"
          :placeholder="provider.presetDefaultModel || '这个端点由你决定模型名'"
          :data-testid="`vendor-model-${provider.id}`"
          @update:model-value="emit('edit-model', String($event))"
        />
        <span class="field__hint">对话框没选模型时用它</span>
      </div>

      <div class="wall-head">
        <span class="wall-head__title">可用模型 ({{ provider.models.length }})</span>
        <Button
          size="sm"
          variant="ghost"
          :disabled="provider.probing"
          data-testid="refresh-models"
          @click="emit('probe')"
        >
          {{ provider.probing ? '拉取中…' : '获取模型列表' }}
        </Button>
        <Button size="sm" variant="ghost" @click="emit('set-all', true)">全部启用</Button>
        <Button size="sm" variant="ghost" @click="emit('set-all', false)">全部禁用</Button>
      </div>

      <ModelWall
        :models="provider.models"
        :disabled="provider.disabled"
        :default-model="provider.defaultModel"
        :catalog="provider.reachable === null ? null : provider.reachable ? 'remote' : 'static'"
        :query="query"
        @set-default="emit('set-default', $event)"
        @toggle="onToggleModel"
      />

      <p v-if="provider.note" class="pcard__note">{{ provider.note }}</p>
    </div>
  </article>
</template>

<style scoped>
.pcard {
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-surface-1);
}
.pcard--open { border-color: var(--color-primary); }

.pcard__head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
}
.pcard__toggle {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex: 1;
  min-width: 0;
  padding: 0;
  border: none;
  background: none;
  font: inherit;
  color: inherit;
  text-align: left;
  cursor: pointer;
}
.pcard__logo {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border-radius: var(--radius-sm);
  background: var(--color-surface-3);
  font-size: var(--text-xs);
  font-weight: 700;
}
.pcard__name { font-size: var(--text-sm); font-weight: 600; }
.pcard__badge {
  flex: none;
  font-size: var(--text-xs);
  color: var(--color-warning);
  border: 1px solid var(--color-warning);
  border-radius: var(--radius-full);
  padding: 0 6px;
}
.pcard__count { flex: none; font-size: var(--text-xs); color: var(--color-text-muted); }
.pcard__status { flex: none; font-size: var(--text-xs); }
.pcard__status.is-ok { color: var(--color-success); }
.pcard__status.is-bad { color: var(--color-danger); }
.pcard__status.is-idle, .pcard__status.is-probing { color: var(--color-text-muted); }
.pcard__key {
  flex: none;
  font-size: var(--text-xs);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-full);
  padding: 0 6px;
  color: var(--color-text-muted);
}
.pcard__key.key--has { color: var(--color-success); border-color: var(--color-success); }
.pcard__key.key--miss { color: var(--color-danger); border-color: var(--color-danger); }
.pcard__chev { flex: none; font-size: var(--text-xs); color: var(--color-text-muted); }
.pcard__actions { display: flex; gap: var(--space-1); flex: none; }

.pcard__body {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: 0 var(--space-3) var(--space-3);
}

.field { display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap; }
.field__key { flex: none; width: 40px; font-size: var(--text-xs); color: var(--color-text-muted); }
.field__val { flex: 1; min-width: 0; font-size: var(--text-xs); overflow-wrap: anywhere; }
.field__input { flex: 1; min-width: 140px; }
.field__hint { flex: 1; font-size: var(--text-xs); color: var(--color-text-muted); }

.wall-head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex-wrap: wrap;
  margin-top: var(--space-2);
  padding-top: var(--space-2);
  border-top: 1px solid var(--color-border);
}
.wall-head__title { flex: 1; font-size: var(--text-xs); font-weight: 700; }

.pcard__note { margin: 0; font-size: var(--text-xs); color: var(--color-text-muted); }
</style>
