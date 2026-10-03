<script setup lang="ts">
/**
 * 模型配置（S7-7 起是独立的 `widget.llm-settings`，归 models 插件）
 *
 * ## ⚠️ 这个文件头不要放 JS 块注释
 *
 * Vue 的 SFC 解析器把 `<script>` **之前**的内容按 HTML 解析。
 * 所以块注释里只要出现 `<dl>`、`<b>` 这类尖括号，就会被当成顶层标签 ——
 * 报 `Element is missing end tag`，而错误位置指向注释里那个词附近，完全不指向真因。
 * 本文件踩过一次（说明文字里写了 `<dl>`）。所以注释一律写在 `<script>` 内部。
 *
 * ## 这一版改了什么，为什么
 *
 * 上一版把 12 家预设**平铺成一个长列表**，展开后是只读的事实表，
 * 而「选模型」被放在第三段。于是：
 *
 * · 12 家里通常只有 1–2 家连上了，其余 11 行是噪音，用户要滚动着找
 * · 「选厂商 → 选模型」这个**连续动作**被拆到相隔两段
 * · 想改端点 / 默认模型只能去「自定义端点」**另建一条** —— 同一厂商两处出现、两处配置
 * · 展开只看得到「默认模型: (空)」（lm-studio / vLLM 的预设就是这样），
 *   用户无从下手，而 `llm.models.list` 这个能力其实早就存在，只是没有入口
 *
 * 现在拆成四块，职责各自单一：正在使用 / 服务商 / 自定义端点 / 插件提供的接入。
 *
 * ## 「就地改预设」不需要任何 Core 侧新机制
 *
 * `buildVendorInstances` 里 `byId` 是 Map：先塞预设，**再用 override 按同 id 覆盖**。
 * 所以「改预设的端点」= 写一条同 id 的 `vendorOverride`，并在上游标「已覆盖预设」。
 *
 * 但**没配凭证的云厂商不能这么改**：`instanceFromOverride` 在 `credentialRef`
 * 解析不出来时返回 `null`，那条 override 压根不会成为实例 —— 填了也白填。
 * 所以这类厂商不给端点编辑框，只给「设置密钥」。
 *
 * ## 探测 = 拉模型列表（同一个动作）
 *
 * `llm.models.list.result` 的 `catalog:'static'` 就意味着走了内置兜底 = 端点连不上，
 * 于是连通性是顺带的，见 `useEndpointProbe`。
 */
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import Button from '@/components/ui/Button.vue'
import Input from '@/components/ui/Input.vue'
import Modal from '@/components/ui/Modal.vue'
import { useEndpointProbe } from '@/core-sdk/useEndpointProbe'
import { useLlmProviders } from '@/core-sdk/useLlmProviders'
import { usePreferences } from '@/core-sdk/usePreferences'
import ActiveModelCard from './ActiveModelCard.vue'
import CustomEndpointSection from './CustomEndpointSection.vue'
import PluginProviderSection from './PluginProviderSection.vue'
import VendorListSection from './VendorListSection.vue'
import type { VendorPreset } from '@osteosome/shared'
import { VENDOR_PRESETS } from '@osteosome/shared'

interface EndpointOverride {
  id: string
  label?: string
  baseUrl: string
  defaultModel?: string
  credentialRef?: string
  api?: string
}

interface MaskedCredential {
  id: string
  name: string
  provider: string
}

const { t } = useI18n()
const preferences = usePreferences()
const { list: providerList, providers } = useLlmProviders()
const probe = useEndpointProbe()

/** 预设表直接静态 import —— 不要改成 `await import()`：
 *  那会让首屏的厂商清单晚一拍才出现（实测：整页只剩标题，测试与人都看不出是「加载中」）。
 */
const catalog = ref<VendorPreset[]>([...VENDOR_PRESETS])
const credentials = ref<MaskedCredential[]>([])
const overrides = ref<EndpointOverride[]>([])
const expanded = ref<string[]>([])

const selectedProvider = ref('')
const selectedModel = ref('')

// ── 凭证弹窗 ──
const credentialOpen = ref(false)
const credentialId = ref('')
const credentialName = ref('')
const credentialValue = ref('')

// ── 自定义端点弹窗 ──
const endpointOpen = ref(false)
const endpointEditId = ref('')
const epId = ref('')
const epLabel = ref('')
const epBaseUrl = ref('')
const epModel = ref('')
const epNoCredential = ref(true)

// ── 派生：服务商列表（预设） ──
const vendorRows = computed(() =>
  catalog.value.map((v) => ({
    id: v.id,
    label: v.label,
    baseUrl: v.baseUrl,
    credentialEnv: v.credentialEnv,
    defaultModel: v.defaultModel,
    note: v.note,
  })),
)

/** 已注册成实例的 id 集合（= 「连上了」） */
const connected = computed(() => {
  const out: Record<string, boolean> = {}
  for (const id of Object.keys(providers.value ?? {})) out[id] = true
  for (const o of overrides.value) out[o.id] = true
  return out
})

const overrideById = computed(() => {
  const m: Record<string, EndpointOverride> = {}
  for (const o of overrides.value) m[o.id] = o
  return m
})

const overridden = computed(() => {
  const out: Record<string, boolean> = {}
  for (const id of Object.keys(overrideById.value)) out[id] = true
  return out
})

/** 生效端点 / 模型：override 优先于预设 */
const effectiveBaseUrl = computed(() => {
  const out: Record<string, string> = {}
  for (const v of vendorRows.value) out[v.id] = v.baseUrl
  for (const [id, o] of Object.entries(overrideById.value)) out[id] = o.baseUrl
  return out
})

const effectiveModel = computed(() => {
  const out: Record<string, string> = {}
  for (const v of vendorRows.value) out[v.id] = v.defaultModel
  for (const [id, o] of Object.entries(overrideById.value)) out[id] = o.defaultModel ?? ''
  return out
})

/**
 * 自定义端点区只列**非预设**的 override。
 *
 * 预设 id 的 override 已经在「服务商」里就地编辑了；在这儿再列一遍，
 * 同一个端点就会出现在两个地方、两处配置。
 */
const customEndpoints = computed(() => {
  const presetIds = new Set(catalog.value.map((v) => v.id))
  return overrides.value
    .filter((o) => !presetIds.has(o.id))
    .map((o) => ({ id: o.id, label: o.label ?? '', baseUrl: o.baseUrl, credentialRef: o.credentialRef ?? '' }))
})

/** 插件提供的接入：目前恒为空 —— 没有插件注册原生 wire provider */
const pluginProviders = ref<{ id: string; label: string; baseUrl: string }[]>([])

const providerOptions = computed(() =>
  providerList.value.map((p) => ({ value: p.provider, label: p.provider })),
)

const activeProvider = computed(() => {
  const id = selectedProvider.value
  if (!id) return null
  const row = vendorRows.value.find((v) => v.id === id)
  const baseUrl = effectiveBaseUrl.value[id]
  if (!row && !baseUrl) return null
  return {
    provider: id,
    label: row?.label ?? id,
    baseUrl: baseUrl ?? '',
    credentialRef: providers.value?.[id]?.credentialRef ?? overrideById.value[id]?.credentialRef ?? '',
    defaultModel: effectiveModel.value[id] ?? '',
  }
})

/** 探测状态：预设 + 自定义端点一起给子组件 */
const probeState = computed(() => ({
  probing: probe.probing.value,
  reachable: Object.fromEntries(
    Object.entries(probe.results.value).map(([k, v]) => [k, v ? v.catalog === 'remote' : null]),
  ),
}))

// ── 当前 provider 的模型目录 ──
async function onSelectProvider(value: string | number): Promise<void> {
  selectedProvider.value = String(value)
  selectedModel.value = ''
  // 换 provider：清空旧模型选择，并立刻拉一次新家的列表
  await probe.probe(selectedProvider.value)
}

function onSelectModel(value: string | number): void {
  selectedModel.value = String(value)
  void saveModelPick(selectedProvider.value, selectedModel.value)
}

async function saveModelPick(providerId: string, model: string): Promise<void> {
  if (!providerId) return
  await upsertOverride(providerId, { defaultModel: model })
}

// ── 就地改预设：写同 id 的 override ──
async function upsertOverride(id: string, patch: Partial<EndpointOverride>): Promise<void> {
  const existing = overrideById.value[id]
  const base = existing ?? { id, baseUrl: '', credentialRef: '' }
  const next: EndpointOverride = { ...base, ...patch, id }
  if (!next.baseUrl) return
  overrides.value = [...overrides.value.filter((o) => o.id !== id), next]
  await saveOverrides()
  probe.clear(id)
}

async function onEditBaseUrl(id: string, value: string): Promise<void> {
  await upsertOverride(id, { baseUrl: value.replace(/\/+$/, '') })
}

async function onEditModel(id: string, value: string): Promise<void> {
  await upsertOverride(id, { defaultModel: value.trim() })
  // 改了模型就把端点探一次：用户填完模型名通常正等着它能用
  await probe.probe(id)
}

// ── 凭证 ──
function credentialFor(providerId: string): MaskedCredential | undefined {
  return credentials.value.find((c) => c.provider === providerId)
}

function openKeyModal(providerId: string): void {
  const existing = credentialFor(providerId)
  credentialId.value = existing?.id ?? `${providerId}-key`
  credentialName.value = existing?.name ?? `${providerId} API Key`
  credentialValue.value = ''
  credentialOpen.value = true
}

async function onSaveCredential(): Promise<void> {
  if (!credentialValue.value) return
  await fetch('/api/credentials', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id: credentialId.value,
      name: credentialName.value,
      provider: keyTargetProvider.value,
      value: credentialValue.value,
    }),
  })
  credentialValue.value = ''
  credentialOpen.value = false
  await loadCredentials()
  // 刚给了密钥 → 那家可能刚刚注册成功，立刻探一次
  if (keyTargetProvider.value) await probe.probe(keyTargetProvider.value)
}

/** 记录「这个密钥弹窗是为谁开的」—— 保存后要按它探测 */
const keyTargetProvider = ref('')

function openKey(providerId: string): void {
  keyTargetProvider.value = providerId
  openKeyModal(providerId)
}

async function onDeleteCredential(id: string): Promise<void> {
  await fetch(`/api/credentials?id=${encodeURIComponent(id)}`, { method: 'DELETE' })
  credentials.value = credentials.value.filter((c) => c.id !== id)
}

async function removeKey(providerId: string): Promise<void> {
  const c = credentialFor(providerId)
  if (c) await onDeleteCredential(c.id)
  probe.clear(providerId)
}

// ── 自定义端点 ──
function openEndpointModal(): void {
  endpointEditId.value = ''
  epId.value = ''
  epLabel.value = ''
  epBaseUrl.value = ''
  epModel.value = ''
  epNoCredential.value = true
  endpointOpen.value = true
}

function editEndpoint(id: string): void {
  const o = overrideById.value[id]
  if (!o) return
  endpointEditId.value = id
  epId.value = o.id
  epLabel.value = o.label ?? ''
  epBaseUrl.value = o.baseUrl
  epModel.value = o.defaultModel ?? ''
  epNoCredential.value = (o.credentialRef ?? '') === ''
  endpointOpen.value = true
}

async function onSaveEndpoint(): Promise<void> {
  const id = epId.value.trim()
  const baseUrl = epBaseUrl.value.trim()
  if (!id || !baseUrl) return
  if (!endpointEditId.value && overrides.value.some((o) => o.id === id)) return
  const item: EndpointOverride = {
    id,
    baseUrl: baseUrl.replace(/\/+$/, ''),
    // 免密钥就写空串 credentialRef；否则按约定推断 env 名，由用户在凭证库补密钥
    ...(epNoCredential.value ? { credentialRef: '' } : {}),
    ...(epLabel.value.trim() ? { label: epLabel.value.trim() } : {}),
    ...(epModel.value.trim() ? { defaultModel: epModel.value.trim() } : {}),
  }
  overrides.value = [...overrides.value.filter((o) => o.id !== id), item]
  await saveOverrides()
  endpointOpen.value = false
  // 建完立刻探：新增端点的首要疑问就是「它通不通」，顺便把模型列表填上
  await refreshOne(id, true)
}

async function onDeleteOverride(id: string): Promise<void> {
  overrides.value = overrides.value.filter((o) => o.id !== id)
  await saveOverrides()
  probe.clear(id)
}

/**
 * 「正在使用」卡片与厂商区的模型下拉，**都从 probe 结果派生**。
 *
 * 为什么不用 `useModelCatalog`（它也发 `llm.models.list`）：
 * 两个 composable 各发一次同一个命令 = 用户点一下打两次端点、等两遍 ——
 * 这正是这个页面要消除的毛病。
 *
 * 所以本页只留 probe 一个发送方/状态持有者：
 * · 模型列表 = `probe.resultOf(id)?.models`
 * · 「拉取中」 = `probe.isProbing(id)`
 * · 可达性 = `catalog === 'remote'`
 *
 * `useModelCatalog` 仍留给别的组件（如输入框的模型下拉），互不干扰。
 */
const activeModels = computed<{ value: string; label: string }[]>(() => {
  const list = probe.results.value[selectedProvider.value]?.models ?? []
  return list.map((m) => ({ label: m, value: m }))
})
const loadingModels = computed(() => probe.probing.value[selectedProvider.value] === true)
/**
 * 对某个 provider 做一次「拉列表 + 探活」。
 *
 * 无论从「连通性测试」还是「获取模型列表」进来，做的都是同一件事：
 * 一次 `llm.models.list` 既填下拉又给出可达性。两个入口只是问的问题不同。
 */
async function refreshOne(providerId: string, alsoSelect: boolean): Promise<void> {
  if (!providerId) return
  if (alsoSelect) {
    selectedProvider.value = providerId
    selectedModel.value = ''
  }
  await probe.probe(providerId)
}

async function onProbe(providerId: string): Promise<void> {
  // 从厂商区点的：顺便把它切成当前服务商，否则「探测的是另一家、下拉还是上一家」
  await refreshOne(providerId, selectedProvider.value !== providerId)
}

async function onRefreshModels(): Promise<void> {
  // 从「正在使用」卡片点的：只刷新当前这家
  await refreshOne(selectedProvider.value, false)
}

function toggleVendor(providerId: string): void {
  expanded.value = expanded.value.includes(providerId)
    ? expanded.value.filter((x) => x !== providerId)
    : [...expanded.value, providerId]
}

// ── 偏好读写 ──
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

async function loadCredentials(): Promise<void> {
  try {
    const res = await fetch('/api/credentials')
    if (!res.ok) return
    const body = (await res.json()) as { credentials?: MaskedCredential[] }
    credentials.value = body.credentials ?? []
  } catch {
    credentials.value = []
  }
}

/**
 * 挂载后等 provider 列表到位，再挑一个当前服务商。
 *
 * 为什么必须 watch 而不是只在 onMounted 里挑一次：
 * `onMounted` 那一刻 `providerList` 通常还是**空的** —— provider 是通过
 * `llm.provider.registered` 事件陆续注册上来的，晚一拍。
 * 于是旧写法会让「正在使用」卡片**一直空着**，直到用户手动选一次 ——
 * 而那卡片恰恰是回答「我现在发问走哪家」的地方，空着最伤。
 */
watch(
  providerList,
  async (list) => {
    if (selectedProvider.value && list.some((p) => p.provider === selectedProvider.value)) return
    const first = list[0]
    if (!first) return
    selectedProvider.value = first.provider
    selectedModel.value = ''
    await probe.probe(first.provider)
  },
  { immediate: true },
)

onMounted(async () => {
  await Promise.all([loadOverrides(), loadCredentials()])
})
</script>

<template>
  <div class="llm-settings">
    <header class="llm-settings__bar">
      <h2 class="llm-settings__title">模型接入</h2>
      <Button size="sm" data-testid="endpoint-new-top" @click="openEndpointModal">＋ 连接新端点</Button>
    </header>
    <p class="llm-settings__sub">连上本地或云端模型。改动即时生效，不用重启。</p>

    <ActiveModelCard
      :provider="activeProvider"
      :providers="providerOptions"
      :models="activeModels"
      :model="selectedModel"
      :loading-models="loadingModels"
      :model-count="activeModels.length"
      :reachable="probeState.reachable[selectedProvider] ?? null"
      :probe="probe.results.value[selectedProvider]"
      :probing="probe.probing.value[selectedProvider] === true"
      @update:provider="onSelectProvider"
      @update:model="onSelectModel"
      @probe="onProbe(selectedProvider)"
      @refresh-models="onRefreshModels"
    />

    <VendorListSection
      :vendors="vendorRows"
      :connected="connected"
      :effective-base-url="effectiveBaseUrl"
      :effective-model="effectiveModel"
      :overridden="overridden"
      :probing="probe.probing.value"
      :reachable="probeState.reachable"
      :expanded="expanded"
      @toggle="toggleVendor"
      @set-key="openKey"
      @remove-key="removeKey"
      @probe="onProbe"
      @edit-base-url="onEditBaseUrl"
      @edit-model="onEditModel"
    />

    <CustomEndpointSection
      :endpoints="customEndpoints"
      :probing="probe.probing.value"
      :reachable="probeState.reachable"
      @create="openEndpointModal"
      @edit="editEndpoint"
      @remove="onDeleteOverride"
      @probe="onProbe"
    />

    <PluginProviderSection :plugin-providers="pluginProviders" />

    <p class="llm-settings__ports">
      ⓘ 本地端点默认端口：LM Studio <b class="mono">1234</b> · Ollama <b class="mono">11434</b> ·
      vLLM <b class="mono">8000</b>，都要带 <b class="mono">/v1</b>。
    </p>

    <Modal v-model:open="endpointOpen" :title="endpointEditId ? '编辑端点' : '新增端点'" :closable="true">
      <div class="form">
        <label class="form__row">
          <span class="form__key">端点 id</span>
          <Input v-model="epId" :disabled="Boolean(endpointEditId)" placeholder="my-proxy" />
        </label>
        <label class="form__row">
          <span class="form__key">显示名</span>
          <Input v-model="epLabel" placeholder="可留空" />
        </label>
        <label class="form__row">
          <span class="form__key">Base URL</span>
          <Input v-model="epBaseUrl" placeholder="http://127.0.0.1:1234/v1" />
        </label>
        <label class="form__row">
          <span class="form__key">默认模型</span>
          <Input v-model="epModel" placeholder="本地端点由你决定模型名" />
        </label>
        <label class="form__row">
          <span class="form__key">免凭证</span>
          <input v-model="epNoCredential" type="checkbox" />
        </label>
      </div>
      <template #footer>
        <Button size="sm" variant="ghost" @click="endpointOpen = false">取消</Button>
        <Button size="sm" variant="primary" data-testid="endpoint-save" @click="onSaveEndpoint">保存并探测</Button>
      </template>
    </Modal>

    <Modal v-model:open="credentialOpen" title="设置密钥" :closable="true">
      <div class="form">
        <label class="form__row">
          <span class="form__key">凭证 id</span>
          <Input v-model="credentialId" />
        </label>
        <label class="form__row">
          <span class="form__key">名称</span>
          <Input v-model="credentialName" />
        </label>
        <label class="form__row">
          <span class="form__key">密钥值</span>
          <Input v-model="credentialValue" type="password" placeholder="只写入，不回显" />
        </label>
        <p class="form__note">密钥明文只进 Core 凭证库，不进日志、不进总线。</p>
      </div>
      <template #footer>
        <Button size="sm" variant="ghost" @click="credentialOpen = false">取消</Button>
        <Button size="sm" variant="primary" data-testid="credential-save" @click="onSaveCredential">保存</Button>
      </template>
    </Modal>
  </div>
</template>

<style scoped>
.llm-settings { display: flex; flex-direction: column; gap: var(--space-3); }
.llm-settings__bar { display: flex; align-items: center; gap: var(--space-2); }
.llm-settings__title { margin: 0; font-size: var(--text-md); font-weight: 700; flex: 1; }
.llm-settings__sub { margin: 0; font-size: var(--text-xs); color: var(--color-text-muted); }
.llm-settings__ports { margin: 0; font-size: var(--text-xs); color: var(--color-text-muted); }
.form { display: flex; flex-direction: column; gap: var(--space-2); }
.form__row { display: flex; align-items: center; gap: var(--space-2); }
.form__key { flex: none; width: 72px; font-size: var(--text-xs); color: var(--color-text-muted); }
.form__note { margin: 0; font-size: var(--text-xs); color: var(--color-text-muted); }
</style>