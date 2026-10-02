<template>
  <div class="llm-settings">
    <!-- S3：厂商目录。数据源是 shared 的预设表（12 家），**不是**「已注册的」——
         否则这里只能看到已经能用的那几家，用户没有任何地方可以「新增」一家。 -->
    <div class="llm-settings__section">
      <div class="llm-settings__section-head">
        <h3 class="llm-settings__heading">{{ t('llm.vendorCatalog') }}</h3>
      </div>
      <p class="llm-settings__hint">{{ t('llm.vendorCatalogHint') }}</p>
      <div
        v-for="v in catalog"
        :key="v.id"
        class="llm-settings__vendor"
        :class="{ 'llm-settings__vendor--on': isConfigured(v.id) }"
        :data-testid="`vendor-${v.id}`"
      >
        <button class="llm-settings__vendor-head" type="button" @click="toggleDetail(v.id)">
          <span class="llm-settings__vendor-name">{{ v.label }}</span>
          <span class="llm-settings__vendor-id">{{ v.id }}</span>
          <span
            class="llm-settings__state"
            :class="stateClass(v)"
            :data-testid="`vendor-state-${v.id}`"
          >{{ stateText(v) }}</span>
        </button>

        <div v-if="detailOpen === v.id" class="llm-settings__vendor-body">
          <dl class="llm-settings__facts">
            <dt>{{ t('llm.vendorBaseUrl') }}</dt>
            <dd class="mono">{{ v.baseUrl }}</dd>
            <dt>{{ t('llm.vendorKeyEnv') }}</dt>
            <dd class="mono">{{ v.credentialEnv || '—' }}</dd>
            <dt>{{ t('llm.vendorDefaultModel') }}</dt>
            <dd class="mono">{{ v.defaultModel }}</dd>
          </dl>
          <p v-if="v.note" class="llm-settings__hint">{{ v.note }}</p>
          <p v-if="credentialProvider(v.id)" class="llm-settings__hint">
            {{ t('llm.vendorFromEnv') }}（{{ credentialProvider(v.id) }}）
          </p>
          <div class="llm-settings__row">
            <Button size="sm" :data-testid="`vendor-setkey-${v.id}`" @click="openKeyModal(v.id)">
              {{ t('llm.vendorSetKey') }}
            </Button>
            <IconButton
              v-if="credentialFor(v.id)"
              icon="✕"
              :label="t('llm.vendorRemoveKey')"
              :data-testid="`vendor-dropkey-${v.id}`"
              @click="onDeleteCredential(credentialFor(v.id)!)"
            />
          </div>
        </div>
      </div>
    </div>

    <!-- S3：自定义端点（写入 preferences.llm.vendorOverrides） -->
    <div class="llm-settings__section">
      <div class="llm-settings__section-head">
        <h3 class="llm-settings__heading">{{ t('llm.customEndpoint') }}</h3>
        <Button size="sm" data-testid="endpoint-new" @click="openEndpointModal()">
          {{ t('llm.newEndpoint') }}
        </Button>
      </div>
      <p class="llm-settings__hint">{{ t('llm.customEndpointHint') }}</p>
      <div v-if="!overrides.length" class="llm-settings__empty">{{ t('common.empty') }}</div>
      <div
        v-for="o in overrides"
        :key="o.id"
        class="llm-settings__credential"
        :data-testid="`endpoint-${o.id}`"
      >
        <span class="llm-settings__credential-name">{{ o.label || o.id }}</span>
        <span class="llm-settings__credential-masked mono">{{ o.baseUrl }}</span>
        <IconButton icon="✕" :label="t('common.delete')" @click="onDeleteOverride(o.id)" />
      </div>
    </div>

    <div class="llm-settings__section">
      <div class="llm-settings__section-head">
        <h3 class="llm-settings__heading">{{ t('llm.model') }}</h3>
      </div>
      <div class="llm-settings__row">
        <Select
          :model-value="selectedProvider"
          :options="providerOptions"
          :placeholder="t('llm.provider')"
          aria-label="model-provider"
          @update:model-value="onSelectProvider"
        />
        <div v-if="catalogModels.length" class="llm-settings__models">
          <Select
            :model-value="selectedModel"
            :options="modelOptions"
            :placeholder="t('llm.model')"
            aria-label="model"
            @update:model-value="onSelectModel"
          />
          <span
            v-if="catalogKind === 'static'"
            class="llm-settings__badge"
            :title="t('llm.staticListHint')"
          >
            {{ t('llm.staticList') }}
          </span>
        </div>
      </div>
    </div>

    <div class="llm-settings__section">
      <div class="llm-settings__section-head">
        <h3 class="llm-settings__heading">{{ t('llm.credential') }}</h3>
        <Button size="sm" @click="credentialOpen = true">{{ t('llm.newCredential') }}</Button>
      </div>
      <div v-if="!credentialOptions.length" class="llm-settings__empty">{{ t('common.empty') }}</div>
      <div v-for="c in credentialOptions" :key="c.value" class="llm-settings__credential">
        <span class="llm-settings__credential-name">{{ c.label }}</span>
        <span class="llm-settings__credential-masked">{{ c.masked }}</span>
        <IconButton icon="✕" :label="t('common.delete')" @click="onDeleteCredential(String(c.value))" />
      </div>
    </div>

    <!-- 存密钥：provider 字段就是厂商 id，provider 服务凭它把该厂商注册上来 -->
    <Modal :open="keyOpen" :title="t('llm.vendorSetKey')" @update:open="keyOpen = $event">
      <div class="llm-settings__form">
        <p class="llm-settings__hint mono">{{ keyTarget }}</p>
        <Input
          v-model="keyValue"
          type="password"
          :placeholder="t('llm.credentialKey')"
          aria-label="vendor-key"
        />
      </div>
      <template #footer>
        <div class="llm-settings__form-actions">
          <Button variant="ghost" @click="keyOpen = false">{{ t('common.cancel') }}</Button>
          <Button :disabled="!keyValue" data-testid="vendor-key-save" @click="onSaveVendorKey">
            {{ t('common.save') }}
          </Button>
        </div>
      </template>
    </Modal>

    <Modal :open="endpointOpen" :title="t('llm.newEndpoint')" @update:open="endpointOpen = $event">
      <div class="llm-settings__form">
        <Input v-model="epId" :placeholder="t('llm.endpointId')" aria-label="endpoint-id" />
        <Input v-model="epLabel" :placeholder="t('llm.providerName')" aria-label="endpoint-label" />
        <Input v-model="epBaseUrl" :placeholder="t('llm.endpointBaseUrl')" aria-label="endpoint-baseurl" />
        <Input
          v-model="epModel"
          :placeholder="t('llm.endpointDefaultModel')"
          aria-label="endpoint-model"
        />
        <label class="llm-settings__check">
          <input v-model="epNoCredential" type="checkbox" aria-label="endpoint-nocred" />
          <span>{{ t('llm.endpointNoCredential') }}</span>
        </label>
      </div>
      <template #footer>
        <div class="llm-settings__form-actions">
          <Button variant="ghost" @click="endpointOpen = false">{{ t('common.cancel') }}</Button>
          <Button
            :disabled="!epId || !epBaseUrl"
            data-testid="endpoint-save"
            @click="onSaveEndpoint"
          >
            {{ t('common.save') }}
          </Button>
        </div>
      </template>
    </Modal>

    <Modal
      :open="credentialOpen"
      :title="t('llm.newCredential')"
      @update:open="credentialOpen = $event"
    >
      <div class="llm-settings__form">
        <Input v-model="credentialName" :placeholder="t('common.name')" aria-label="credential-name" />
        <Input v-model="credentialValue" type="password" :placeholder="t('llm.credentialKey')" aria-label="credential-value" />
      </div>
      <template #footer>
        <div class="llm-settings__form-actions">
          <Button variant="ghost" @click="credentialOpen = false">{{ t('common.cancel') }}</Button>
          <Button :disabled="!credentialValue" @click="onSaveCredential">{{ t('common.save') }}</Button>
        </div>
      </template>
    </Modal>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { VENDOR_PRESETS, type VendorPreset } from '@osteosome/shared'
import Button from '@/components/ui/Button.vue'
import IconButton from '@/components/ui/IconButton.vue'
import Input from '@/components/ui/Input.vue'
import Modal from '@/components/ui/Modal.vue'
import Select from '@/components/ui/Select.vue'
import Textarea from '@/components/ui/Textarea.vue'
import { useLlmProviders } from '@/core-sdk/useLlmProviders'
import { useModelCatalog } from '@/core-sdk/useModelCatalog'
import { usePreferences } from '@/core-sdk/usePreferences'
import { sse } from '@/core-sdk/sse'

interface MaskedCredential {
  id: string
  name: string
  provider: string
  kind: string
  masked: string
}

/** 自填端点一条（与 `services/llm-provider-openai` 的 `VendorOverride` 同形） */
interface EndpointOverride {
  id: string
  label?: string
  baseUrl: string
  defaultModel?: string
  models?: string[]
  /** wire id；缺省 openai。填别家会被 provider 拒绝并告警 */
  api?: string
  credentialRef?: string
}

const { t } = useI18n()
const { list: providerList, providers } = useLlmProviders()
const { models: catalogModels, catalog: catalogKind, options: modelOptions, load: loadCatalog } = useModelCatalog()
const preferences = usePreferences()

const credentials = ref<MaskedCredential[]>([])
const credentialOpen = ref(false)
const credentialName = ref('')
const credentialValue = ref('')

/** 厂商目录：预设表全量 12 家（不是「已注册的」——那样用户无处可新增） */
const catalog = VENDOR_PRESETS
/** 展开详情的厂商 id（一次一个） */
const detailOpen = ref('')

/** 存密钥弹窗 */
const keyOpen = ref(false)
const keyTarget = ref('')
const keyValue = ref('')

/** 自定义端点 */
const overrides = ref<EndpointOverride[]>([])
const endpointOpen = ref(false)
const epId = ref('')
const epLabel = ref('')
const epBaseUrl = ref('')
const epModel = ref('')
const epNoCredential = ref(true)

const selectedProvider = ref('')
const selectedModel = ref('')

const providerOptions = computed(() =>
  providerList.value.map((p) => ({ label: p.provider, value: p.provider })),
)
const credentialOptions = computed(() =>
  credentials.value.map((c) => ({ value: c.id, label: `${c.name}（${c.provider}）`, masked: c.masked })),
)

// 目录到达后默认选第一个模型（未选过时）
watch(catalogModels, (list) => {
  if (list.length > 0 && !selectedModel.value) selectedModel.value = list[0]
})

function toggleDetail(id: string): void {
  detailOpen.value = detailOpen.value === id ? '' : id
}

/** 该厂商在凭证库里那条的 id（没有则空串） */
function credentialFor(vendorId: string): string {
  return credentials.value.find((c) => c.provider === vendorId)?.id ?? ''
}

/**
 * 已配置 = 主位路由表里真有它。
 *
 * 不用「凭证库里有没有那条」当判据：env 注入的密钥不进凭证库，但它照样能用 ——
 * 拿凭证库当真相会把「明明能用」显示成「未配置」。
 */
function isConfigured(vendorId: string): boolean {
  return !!providers.value?.[vendorId]
}

/** 免密钥端点（ollama / vllm / lm-studio）不需要任何凭证 */
function isNoCredential(vendor: VendorPreset): boolean {
  return !vendor.credentialEnv
}

function stateText(vendor: VendorPreset): string {
  if (isConfigured(vendor.id)) return t('llm.vendorConfigured')
  if (isNoCredential(vendor)) return t('llm.vendorNoCredential')
  return t('llm.vendorNotConfigured')
}

function stateClass(vendor: VendorPreset): string {
  if (isConfigured(vendor.id)) return 'llm-settings__state--on'
  if (isNoCredential(vendor)) return 'llm-settings__state--free'
  return 'llm-settings__state--off'
}

/** 展示用：这家当前实际用的 credentialRef（`env:` 前缀说明是环境变量注入的） */
function credentialProvider(vendorId: string): string {
  const ref = providers.value?.[vendorId]?.credentialRef ?? ''
  return ref.startsWith('env:') ? ref.slice(4) : ''
}

function openKeyModal(vendorId: string): void {
  keyTarget.value = vendorId
  keyValue.value = ''
  keyOpen.value = true
}

/** 存密钥 → provider 收到 `credential.saved` 即注册（不用重启进程） */
async function onSaveVendorKey(): Promise<void> {
  if (!keyTarget.value || !keyValue.value) return
  const res = await fetch('/api/credentials', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: `${keyTarget.value} key`,
      provider: keyTarget.value,
      value: keyValue.value,
    }),
  })
  if (!res.ok) return
  keyOpen.value = false
  keyValue.value = ''
  await loadCredentials()
}

function openEndpointModal(): void {
  epId.value = ''
  epLabel.value = ''
  epBaseUrl.value = ''
  epModel.value = ''
  epNoCredential.value = true
  endpointOpen.value = true
}

async function onSaveEndpoint(): Promise<void> {
  const id = epId.value.trim()
  const baseUrl = epBaseUrl.value.trim()
  if (!id || !baseUrl) return
  if (overrides.value.some((o) => o.id === id)) return
  const item: EndpointOverride = {
    id,
    baseUrl,
    // 免密钥就写空串 credentialRef；否则按约定推断 env 名，由用户在凭证库补密钥
    ...(epNoCredential.value ? { credentialRef: '' } : {}),
    ...(epLabel.value.trim() ? { label: epLabel.value.trim() } : {}),
    ...(epModel.value.trim() ? { defaultModel: epModel.value.trim() } : {}),
  }
  overrides.value = [...overrides.value, item]
  await saveOverrides()
  endpointOpen.value = false
}

async function onDeleteOverride(id: string): Promise<void> {
  overrides.value = overrides.value.filter((o) => o.id !== id)
  await saveOverrides()
}

/** 写入 Core 偏好 `llm.vendorOverrides`（provider 启动时经 `preferences.get` 读回） */
async function saveOverrides(): Promise<void> {
  await preferences.patch({ llm: { vendorOverrides: overrides.value } })
}

async function loadOverrides(): Promise<void> {
  try {
    const prefs = (await preferences.get()) as { llm?: { vendorOverrides?: unknown } }
    const raw = prefs.llm?.vendorOverrides
    overrides.value = Array.isArray(raw) ? (raw as EndpointOverride[]) : []
  } catch {
    overrides.value = []
  }
}

function onSelectProvider(value: string | number): void {
  selectedProvider.value = String(value)
  selectedModel.value = ''
  void loadCatalog(selectedProvider.value)
}

function onSelectModel(value: string | number): void {
  selectedModel.value = String(value)
}

async function onDeleteCredential(id: string): Promise<void> {
  await fetch(`/api/credentials?id=${encodeURIComponent(id)}`, { method: 'DELETE' })
  credentials.value = credentials.value.filter((c) => c.id !== id)
}

async function onSaveCredential(): Promise<void> {
  if (!credentialValue.value) return
  await fetch('/api/credentials', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: credentialName.value || credentialValue.value.slice(0, 8),
      provider: selectedProvider.value || 'llm',
      value: credentialValue.value,
    }),
  })
  credentialOpen.value = false
  credentialName.value = ''
  credentialValue.value = ''
  await loadCredentials()
}

async function loadCredentials(): Promise<void> {
  try {
    const res = await fetch('/api/credentials')
    if (res.ok) {
      const data = (await res.json()) as { credentials?: MaskedCredential[] }
      credentials.value = data.credentials ?? []
    }
  } catch {
    // Core 无凭证能力 → 空列表
  }
}

function onCredentialEvent(): void {
  void loadCredentials()
}

let disposeSaved: (() => void) | null = null
let disposeDeleted: (() => void) | null = null

onMounted(() => {
  void loadCredentials()
  void loadOverrides()
  disposeSaved = sse.subscribe('credential.saved', onCredentialEvent)
  disposeDeleted = sse.subscribe('credential.deleted', onCredentialEvent)
})

onUnmounted(() => {
  disposeSaved?.()
  disposeSaved = null
  disposeDeleted?.()
  disposeDeleted = null
})
</script>

<style scoped>
.llm-settings {
  display: flex;
  flex-direction: column;
  gap: var(--space-5);
}
.llm-settings__section {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
.llm-settings__section-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.llm-settings__heading {
  margin: 0;
  font-size: var(--text-sm);
  color: var(--color-text-muted);
}
.llm-settings__empty {
  font-size: var(--text-xs);
  color: var(--color-text-muted);
  padding: var(--space-2) 0;
}
.llm-settings__provider,
.llm-settings__credential {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
}
.llm-settings__provider-name {
  font-size: var(--text-sm);
  color: var(--color-text);
}
.llm-settings__provider-meta {
  font-size: var(--text-xs);
  color: var(--color-text-muted);
}
.llm-settings__provider-retry,
.llm-settings__retry {
  margin-left: var(--space-2);
  color: var(--color-text-muted);
}

/* ── S3：厂商目录 ── */
.llm-settings__hint {
  margin: 0 0 var(--space-2);
  font-size: var(--text-xs);
  color: var(--color-text-muted);
}
.llm-settings__vendor {
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  margin-bottom: var(--space-2);
}
.llm-settings__vendor--on {
  border-color: var(--color-success);
}
.llm-settings__vendor-head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
  padding: var(--space-2) var(--space-3);
  background: none;
  border: 0;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.llm-settings__vendor-name {
  font-size: var(--text-sm);
  color: var(--color-text);
}
.llm-settings__vendor-id {
  font-family: var(--font-mono, monospace);
  font-size: var(--text-xs);
  color: var(--color-text-muted);
}
.llm-settings__state {
  margin-left: auto;
  font-size: var(--text-xs);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  padding: 0 var(--space-2);
  white-space: nowrap;
  color: var(--color-text-muted);
}
.llm-settings__state--on {
  border-color: var(--color-success);
  color: var(--color-success);
}
.llm-settings__state--free {
  border-color: var(--color-border-strong, var(--color-border));
}
.llm-settings__vendor-body {
  padding: 0 var(--space-3) var(--space-3);
}
.llm-settings__facts {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 2px var(--space-3);
  margin: 0 0 var(--space-2);
  font-size: var(--text-xs);
}
.llm-settings__facts dt {
  color: var(--color-text-muted);
}
.llm-settings__facts dd {
  margin: 0;
  color: var(--color-text);
  overflow-wrap: anywhere;
}
.llm-settings__check {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--text-sm);
  color: var(--color-text);
}
.llm-settings__row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}
.llm-settings__models {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}
.llm-settings__badge {
  font-size: var(--text-xs);
  color: var(--color-warning);
  border: 1px solid var(--color-warning);
  border-radius: var(--radius-sm);
  padding: 1px var(--space-2);
  white-space: nowrap;
}
.llm-settings__credential-name {
  font-size: var(--text-sm);
  color: var(--color-text);
}
.llm-settings__credential-masked {
  font-size: var(--text-xs);
  color: var(--color-text-muted);
  flex: 1;
}
.llm-settings__form {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}
.llm-settings__form-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-2);
}
</style>
