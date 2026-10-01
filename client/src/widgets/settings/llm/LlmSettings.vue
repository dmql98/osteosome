<template>
  <div class="llm-settings">
    <div class="llm-settings__section">
      <h3 class="llm-settings__heading">{{ t('llm.provider') }}</h3>
      <div v-if="!providerList.length" class="llm-settings__empty">{{ t('common.empty') }}</div>
      <div v-for="p in providerList" :key="p.provider" class="llm-settings__provider">
        <div class="llm-settings__provider-main">
          <div class="llm-settings__provider-name">{{ p.provider }}</div>
          <div class="llm-settings__provider-meta">
            {{ p.defaultModel }}
            <span v-if="p.retryPolicy" class="llm-settings__retry">retry×{{ p.retryPolicy.maxAttempts }}</span>
          </div>
        </div>
        <Switch
          :model-value="isEnabled(p.provider)"
          :aria-label="`toggle ${p.provider}`"
          @update:model-value="onToggleProvider(p.provider, $event)"
        />
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
        <div v-if="modelsResult" class="llm-settings__models">
          <Select
            :model-value="selectedModel"
            :options="modelOptions"
            :placeholder="t('llm.model')"
            aria-label="model"
            @update:model-value="onSelectModel"
          />
          <span
            v-if="modelsResult.catalog === 'static'"
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
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import Button from '@/components/ui/Button.vue'
import IconButton from '@/components/ui/IconButton.vue'
import Input from '@/components/ui/Input.vue'
import Modal from '@/components/ui/Modal.vue'
import Select from '@/components/ui/Select.vue'
import Switch from '@/components/ui/Switch.vue'
import { useLlmProviders } from '@/core-sdk/useLlmProviders'
import { useCommand } from '@/core-sdk/useCommand'
import { sse } from '@/core-sdk/sse'

interface MaskedCredential {
  id: string
  name: string
  provider: string
  kind: string
  masked: string
}
interface ModelsResult {
  requestId: string
  provider: string
  models: string[]
  catalog: 'remote' | 'static'
}

const { t } = useI18n()
const { list: providerList, providers } = useLlmProviders()
const { send } = useCommand()

const credentials = ref<MaskedCredential[]>([])
const credentialOpen = ref(false)
const credentialName = ref('')
const credentialValue = ref('')

const selectedProvider = ref('')
const selectedModel = ref('')
const modelsResult = ref<ModelsResult | null>(null)

const providerOptions = computed(() =>
  providerList.value.map((p) => ({ label: p.provider, value: p.provider })),
)
const modelOptions = computed(() =>
  (modelsResult.value?.models ?? []).map((m) => ({ label: m, value: m })),
)
const credentialOptions = computed(() =>
  credentials.value.map((c) => ({ value: c.id, label: `${c.name}（${c.provider}）`, masked: c.masked })),
)

function isEnabled(provider: string): boolean {
  return !!providers.value?.[provider]
}

async function onToggleProvider(provider: string, on: boolean): Promise<void> {
  const serviceId = providerServiceId(provider)
  await send(on ? 'service.start' : 'service.stop', { serviceId })
}

function providerServiceId(provider: string): string {
  return provider.startsWith('llm-provider-') ? provider : `llm-provider-${provider}`
}

async function onSelectProvider(value: string | number): Promise<void> {
  selectedProvider.value = String(value)
  selectedModel.value = ''
  modelsResult.value = null
  await send('llm.models.list', { requestId: `models-${Date.now()}`, provider: selectedProvider.value })
}

function onSelectModel(value: string | number): void {
  selectedModel.value = String(value)
}

function applyModelsResult(payload: unknown): void {
  if (!payload || typeof payload !== 'object') return
  const p = payload as Record<string, unknown>
  if (p.provider !== selectedProvider.value) return
  modelsResult.value = {
    requestId: typeof p.requestId === 'string' ? p.requestId : '',
    provider: String(p.provider),
    models: Array.isArray(p.models) ? (p.models as unknown[]).filter((m): m is string => typeof m === 'string') : [],
    catalog: p.catalog === 'remote' ? 'remote' : 'static',
  }
  if (modelsResult.value.models.length > 0) selectedModel.value = modelsResult.value.models[0]
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

let disposeModels: (() => void) | null = null
let disposeSaved: (() => void) | null = null
let disposeDeleted: (() => void) | null = null

onMounted(() => {
  void loadCredentials()
  disposeModels = sse.subscribe('llm.models.list.result', applyModelsResult)
  disposeSaved = sse.subscribe('credential.saved', onCredentialEvent)
  disposeDeleted = sse.subscribe('credential.deleted', onCredentialEvent)
})
onUnmounted(() => {
  disposeModels?.()
  disposeModels = null
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
.llm-settings__retry {
  margin-left: var(--space-2);
  color: var(--color-text-muted);
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
