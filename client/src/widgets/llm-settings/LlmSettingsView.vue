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
 * 去掉「正在使用」块。它回答的是「我此刻发问走哪家」，而选 provider/模型
 * 本来就是**对话输入框**的职责（`ChatComposerWidget` 的 composer-provider /
 * composer-model），设置页再放一份下拉等于两处选择互相看不见 ——
 * 用户在这儿选了、去输入框又是另一个，还查不出谁改的。
 *
 * 所以本页只剩两件事：**有哪些端点（连没连上、怎么改）**，以及**每个端点有哪些模型（要不要用）**。
 *
 * ## 「就地改预设」不需要任何 Core 侧新机制
 *
 * `buildVendorInstances` 里 `byId` 是 Map：先塞预设，**再用 override 按同 id 覆盖**。
 * 所以「改预设的端点」= 写一条同 id 的 `vendorOverride`，并在上游标「已覆盖预设」。
 *
 * 但**没配凭证的云厂商不能这么改**：`instanceFromOverride` 在 `credentialRef`
 * 解析不出来时返回 `null`，那条 override 压根不会成为实例 —— 填了也白填。
 * 所以这类端点不给端点编辑框，只给「设置密钥」。
 *
 * ## 探测 = 拉模型列表（同一个动作）
 *
 * `llm.models.list.result` 的 `catalog:'static'` 就意味着走了内置兜底 = 端点连不上，
 * 于是连通性是顺带的，见 `useEndpointProbe`。本页只留 probe 一个发送方：
 * 模型墙 = `probe.results[id].models`，状态 = `catalog === 'remote'`。
 *
 * ## 偏好写入为什么必须集中在这里
 *
 * `usePreferences.patch` 是**浅合并**：`{...base, ...partial}` —— 写 `llm` 就是把整个
 * `llm` 键换掉。所以 `vendorOverrides` 和 `enabledModels` 必须**一起写**，
 * 而且只有这一个地方写。子组件（ProviderCard / ModelWall）只吃 props、只 emit。
 */
import { computed, onMounted, ref, watch } from 'vue'
import Button from '@/components/ui/Button.vue'
import Input from '@/components/ui/Input.vue'
import Modal from '@/components/ui/Modal.vue'
import { useEndpointProbe } from '@/core-sdk/useEndpointProbe'
import { useLlmProviders } from '@/core-sdk/useLlmProviders'
import { usePreferences } from '@/core-sdk/usePreferences'
import CustomEndpointSection from './CustomEndpointSection.vue'
import PluginProviderSection from './PluginProviderSection.vue'
import VendorListSection from './VendorListSection.vue'
import type { PendingRow } from './ProviderCatalog.vue'
import type { ProviderCardData } from './ProviderCard.vue'
import type { VendorPreset } from '@osteosome/shared'
import { VENDOR_PRESETS } from '@osteosome/shared'

interface EndpointOverride {
  id: string
  label?: string
  baseUrl: string
  defaultModel?: string
  /** `''` = 显式免凭证；**缺省 = 要凭证**（由 provider 去 env / 凭证库按 id 找） */
  credentialRef?: string
  api?: string
}

interface MaskedCredential {
  id: string
  name: string
  provider: string
}

const preferences = usePreferences()
const { list: providerList, providers } = useLlmProviders()
const probe = useEndpointProbe()

/** 预设表直接静态 import —— 不要改成 `await import()`：
 *  那会让首屏的厂商清单晚一拍才出现（实测：整页只剩标题，测试与人都看不出是「加载中」）。
 */
const catalog = ref<VendorPreset[]>([...VENDOR_PRESETS])
const credentials = ref<MaskedCredential[]>([])
const overrides = ref<EndpointOverride[]>([])
/**
 * 已禁用的模型，元素是 `${providerId}::${model}`。
 *
 * **空数组 = 全启用**，这是默认态 —— 老偏好文件一个字没写也照常工作，不需要迁移。
 * 反向存「已启用」就得先知道全集，而全集来自探测，探测前是空的，
 * 那会把所有模型都判成关的。
 */
const disabledModels = ref<string[]>([])
/** 用户手动收起的卡片。**不在这个名单里 = 展开** —— 连上就该看见模型墙 */
const collapsed = ref<string[]>([])
/** 未连接的预设目录是否展开。默认收起 —— 12 家里通常只连 1–2 家 */
const dirOpen = ref(false)
const query = ref('')

// ── 凭证弹窗 ──
const credentialOpen = ref(false)
const credentialId = ref('')
const credentialName = ref('')
const credentialValue = ref('')
/** 「这个密钥弹窗是为谁开的」—— 保存后要按它探测 */
const keyTargetProvider = ref('')

// ── OpenAI 兼容端点弹窗 ──
const endpointOpen = ref(false)
const endpointEditId = ref('')
const epId = ref('')
const epLabel = ref('')
const epBaseUrl = ref('')
const epModel = ref('')
/** 要不要密钥。新端点默认不要 —— 本地 vLLM / 内网网关一大半是免密钥的 */
const epNeedKey = ref(false)
const epCredId = ref('')
const epCredName = ref('')
const epKeyValue = ref('')

// ── 派生 ──
const overrideById = computed(() => {
  const m: Record<string, EndpointOverride> = {}
  for (const o of overrides.value) m[o.id] = o
  return m
})

/** 已注册成实例的 id + 有 override 的 id（后者也会成为实例） */
const connected = computed(() => {
  const out: Record<string, boolean> = {}
  for (const id of Object.keys(providers.value ?? {})) out[id] = true
  for (const o of overrides.value) out[o.id] = true
  return out
})

/** 生效端点 / 模型：override 优先于预设 */
const effectiveBaseUrl = computed(() => {
  const out: Record<string, string> = {}
  for (const v of catalog.value) out[v.id] = v.baseUrl
  for (const [id, o] of Object.entries(overrideById.value)) out[id] = o.baseUrl
  return out
})

const effectiveModel = computed(() => {
  const out: Record<string, string> = {}
  for (const v of catalog.value) out[v.id] = v.defaultModel
  for (const [id, o] of Object.entries(overrideById.value)) out[id] = o.defaultModel ?? ''
  return out
})

const keyword = computed(() => query.value.trim().toLowerCase())

/** 搜索要能跨到模型名 —— 用户记得的是「哪个模型」，不一定记得是哪家的 */
function matches(id: string, label: string, baseUrl: string, models: string[]): boolean {
  const k = keyword.value
  if (!k) return true
  if (label.toLowerCase().includes(k)) return true
  if (id.toLowerCase().includes(k)) return true
  if (baseUrl.toLowerCase().includes(k)) return true
  return models.some((m) => m.toLowerCase().includes(k))
}

function modelKey(id: string, model: string): string {
  return `${id}::${model}`
}

function disabledFor(id: string): string[] {
  const prefix = `${id}::`
  return disabledModels.value.filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length))
}

const credentialFor = (providerId: string): MaskedCredential | undefined =>
  credentials.value.find((c) => c.provider === providerId)

/** 已连接的服务商卡片（只列预设；自定义端点归它自己那一组，不重复出现） */
const cards = computed<ProviderCardData[]>(() => {
  const out: ProviderCardData[] = []
  for (const v of catalog.value) {
    if (!connected.value[v.id]) continue
    const baseUrl = effectiveBaseUrl.value[v.id] ?? v.baseUrl
    const models = probe.results.value[v.id]?.models ?? []
    if (!matches(v.id, v.label, baseUrl, models)) continue
    const result = probe.results.value[v.id]
    // 搜到模型名时把这张卡顶开：用户要的是那个模型，藏起来等于没搜到
    const forceOpen = keyword.value !== '' && models.some((m) => m.toLowerCase().includes(keyword.value))
    out.push({
      id: v.id,
      label: v.label,
      baseUrl,
      credentialEnv: v.credentialEnv,
      hasKey: Boolean(credentialFor(v.id)),
      defaultModel: effectiveModel.value[v.id] ?? '',
      presetDefaultModel: v.defaultModel,
      overridden: Boolean(overrideById.value[v.id]),
      note: v.note,
      models,
      probing: probe.probing.value[v.id] === true,
      reachable: result ? result.catalog === 'remote' : null,
      latencyMs: result?.latencyMs ?? null,
      expanded: !collapsed.value.includes(v.id) || forceOpen,
      disabled: disabledFor(v.id),
    })
  }
  return out
})

const pendingTotal = computed(() => catalog.value.filter((v) => !connected.value[v.id]).length)

const pendingRows = computed<PendingRow[]>(() =>
  catalog.value
    .filter((v) => !connected.value[v.id])
    .filter((v) => matches(v.id, v.label, effectiveBaseUrl.value[v.id] ?? v.baseUrl, []))
    .map((v) => ({
      id: v.id,
      label: v.label,
      credentialEnv: v.credentialEnv,
      hasKey: Boolean(credentialFor(v.id)),
    })),
)

/** 搜索时目录自动展开 —— 搜了却什么都不显示，比展开更让人怀疑页面坏了 */
const dirVisible = computed(() => dirOpen.value || keyword.value !== '')

/** 探测可达性：`null` = 还没探过（与「探过了不行」分开显示） */
const reachableMap = computed<Record<string, boolean | null>>(() =>
  Object.fromEntries(
    Object.entries(probe.results.value).map(([k, v]) => [k, v ? v.catalog === 'remote' : null]),
  ),
)

/**
 * 自定义端点区只列**非预设**的 override。
 *
 * 预设 id 的 override 已经在上面的卡片里就地编辑了；在这儿再列一遍，
 * 同一个端点就会出现在两个地方、两处配置。
 */
const customEndpoints = computed(() => {
  const presetIds = new Set(catalog.value.map((v) => v.id))
  return overrides.value
    .filter((o) => !presetIds.has(o.id))
    .map((o) => ({
      id: o.id,
      label: o.label ?? '',
      baseUrl: o.baseUrl,
      needsKey: o.credentialRef !== '',
    }))
})

/** 插件提供的接入：目前恒为空 —— 没有插件注册原生 wire provider */
const pluginProviders = ref<{ id: string; label: string; baseUrl: string }[]>([])

// ── 展开 / 探测 ──
function toggleVendor(providerId: string): void {
  collapsed.value = collapsed.value.includes(providerId)
    ? collapsed.value.filter((x) => x !== providerId)
    : [...collapsed.value, providerId]
}

function toggleDir(): void {
  dirOpen.value = !dirOpen.value
}

/** 点卡片上的「探测 / 获取模型列表 / 连接」——三处是同一个动作 */
async function onProbe(providerId: string): Promise<void> {
  if (!providerId) return
  await probe.probe(providerId)
}

// ── 就地改预设：写同 id 的 override ──
async function upsertOverride(id: string, patch: Partial<EndpointOverride>): Promise<void> {
  const existing = overrideById.value[id]
  const base = existing ?? { id, baseUrl: '', credentialRef: '' }
  const next: EndpointOverride = { ...base, ...patch, id }
  if (!next.baseUrl) return
  overrides.value = [...overrides.value.filter((o) => o.id !== id), next]
  await saveLlm()
  probe.clear(id)
}

async function onEditBaseUrl(id: string, value: string): Promise<void> {
  await upsertOverride(id, { baseUrl: value.replace(/\/+$/, '') })
}

function onEditModel(id: string, value: string): void {
  void upsertOverride(id, { defaultModel: String(value).trim() })
}

function onSetDefault(id: string, model: string): void {
  void upsertOverride(id, { defaultModel: model })
}

// ── 逐模型启用 / 禁用（llm.enabledModels） ──
async function onToggleModel(id: string, model: string, on: boolean): Promise<void> {
  const key = modelKey(id, model)
  const next = new Set(disabledModels.value)
  if (on) next.delete(key)
  else next.add(key)
  disabledModels.value = [...next]
  await saveLlm()
}

async function onSetAll(id: string, on: boolean): Promise<void> {
  const prefix = `${id}::`
  if (on) {
    // 全部启用要连「模型已经不在清单里」的陈旧条目一起清掉，否则那家永远差几个
    disabledModels.value = disabledModels.value.filter((k) => !k.startsWith(prefix))
  } else {
    const models = probe.results.value[id]?.models ?? []
    const next = new Set(disabledModels.value)
    for (const m of models) next.add(modelKey(id, m))
    disabledModels.value = [...next]
  }
  await saveLlm()
}

// ── 凭证 ──
function openKey(providerId: string): void {
  const existing = credentialFor(providerId)
  keyTargetProvider.value = providerId
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

async function onDeleteCredential(id: string): Promise<void> {
  await fetch(`/api/credentials?id=${encodeURIComponent(id)}`, { method: 'DELETE' })
  credentials.value = credentials.value.filter((c) => c.id !== id)
}

async function removeKey(providerId: string): Promise<void> {
  const c = credentialFor(providerId)
  if (c) await onDeleteCredential(c.id)
  probe.clear(providerId)
}

// ── OpenAI 兼容端点 ──
function openEndpointModal(): void {
  endpointEditId.value = ''
  epId.value = ''
  epLabel.value = ''
  epBaseUrl.value = ''
  epModel.value = ''
  epNeedKey.value = false
  epCredId.value = ''
  epCredName.value = ''
  epKeyValue.value = ''
  endpointOpen.value = true
}

function editEndpoint(id: string): void {
  const o = overrideById.value[id]
  if (!o) return
  const existing = credentialFor(id)
  endpointEditId.value = id
  epId.value = o.id
  epLabel.value = o.label ?? ''
  epBaseUrl.value = o.baseUrl
  epModel.value = o.defaultModel ?? ''
  // credentialRef 显式空串 = 免凭证；缺省 = 要凭证
  epNeedKey.value = o.credentialRef !== ''
  epCredId.value = existing?.id ?? `${id}-key`
  epCredName.value = existing?.name ?? `${id} API Key`
  epKeyValue.value = ''
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
    // 要凭证就**不写** credentialRef（provider 去 env / 凭证库按 id 找），
    // 免凭证才显式写空串 —— 写成 `core:xxx` 反而会把不存在的引用钉死
    ...(epNeedKey.value ? {} : { credentialRef: '' }),
    ...(epLabel.value.trim() ? { label: epLabel.value.trim() } : {}),
    ...(epModel.value.trim() ? { defaultModel: epModel.value.trim() } : {}),
  }
  overrides.value = [...overrides.value.filter((o) => o.id !== id), item]
  await saveLlm()

  // 凭证跟着端点一起填：一张表单办完，不用让用户再去找一次入口
  if (epNeedKey.value && epKeyValue.value) {
    await fetch('/api/credentials', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: epCredId.value.trim() || `${id}-key`,
        name: epCredName.value.trim() || `${id} API Key`,
        provider: id,
        value: epKeyValue.value,
      }),
    })
    await loadCredentials()
    epKeyValue.value = ''
  }

  endpointOpen.value = false
  // 建完立刻探：新增端点的首要疑问就是「它通不通」，顺便把模型列表填上
  await probe.probe(id)
}

async function onDeleteOverride(id: string): Promise<void> {
  overrides.value = overrides.value.filter((o) => o.id !== id)
  await saveLlm()
  probe.clear(id)
}

// ── 偏好读写（唯一写入点 —— 见文件头） ──
async function saveLlm(): Promise<void> {
  await preferences.patch({ llm: { vendorOverrides: overrides.value, enabledModels: disabledModels.value } })
}

async function loadLlm(): Promise<void> {
  try {
    const prefs = (await preferences.get()) as {
      llm?: { vendorOverrides?: unknown; enabledModels?: unknown }
    }
    overrides.value = Array.isArray(prefs.llm?.vendorOverrides)
      ? (prefs.llm.vendorOverrides as EndpointOverride[])
      : []
    disabledModels.value = Array.isArray(prefs.llm?.enabledModels)
      ? (prefs.llm.enabledModels as string[])
      : []
  } catch {
    overrides.value = []
    disabledModels.value = []
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
 * 新注册的 provider 自动探一次。
 *
 * 必须 watch 而不是只在 onMounted 挑一次：`llm.provider.registered` 是服务握手时
 * 就发完的，页面可能之后才打开 —— 于是「LM Studio 开着却显示未测试」。
 * 探一次既填模型墙又给出连通性，还不用用户自己去找按钮。
 *
 * 已有结果的跳过：这条 watch 会在 providerList 每次变化时再跑，
 * 无条件重探会让「获取模型列表」的点击计数失控。
 */
watch(
  providerList,
  (list) => {
    for (const p of list) {
      if (probe.probing.value[p.provider] || probe.results.value[p.provider]) continue
      void probe.probe(p.provider)
    }
  },
  { immediate: true },
)

onMounted(async () => {
  await Promise.all([loadLlm(), loadCredentials()])
})
</script>

<template>
  <div class="llm-settings">
    <header class="llm-settings__bar">
      <h2 class="llm-settings__title">模型接入</h2>
      <Input v-model="query" class="llm-settings__search" placeholder="搜索服务商 / 模型…" aria-label="vendor-search" />
    </header>
    <p class="llm-settings__sub">连上本地或云端模型。改动即时生效，不用重启。选哪个模型在对话输入框里。</p>

    <VendorListSection
      :cards="cards"
      :rows="pendingRows"
      :total="pendingTotal"
      :dir-open="dirVisible"
      :query="query"
      :probing="probe.probing.value"
      :reachable="reachableMap"
      @toggle="toggleVendor"
      @probe="onProbe"
      @set-key="openKey"
      @remove-key="removeKey"
      @edit-base-url="onEditBaseUrl"
      @edit-model="onEditModel"
      @set-default="onSetDefault"
      @toggle-model="onToggleModel"
      @set-all="onSetAll"
      @toggle-dir="toggleDir"
      @connect="onProbe"
    />

    <CustomEndpointSection
      :endpoints="customEndpoints"
      :probing="probe.probing.value"
      :reachable="reachableMap"
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

    <Modal
      v-model:open="endpointOpen"
      :title="endpointEditId ? '编辑 OpenAI 兼容端点' : '新增 OpenAI 兼容端点'"
      :closable="true"
    >
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

        <div class="form__row form__row--col">
          <label class="form__check">
            <input v-model="epNeedKey" type="checkbox" />
            <span>需要 API Key（OpenAI 兼容端点通常要）</span>
          </label>
          <div v-if="epNeedKey" class="cred">
            <label class="form__row">
              <span class="form__key">凭证 id</span>
              <Input v-model="epCredId" :placeholder="`${epId || '端点 id'}-key`" />
            </label>
            <label class="form__row">
              <span class="form__key">名称</span>
              <Input v-model="epCredName" placeholder="凭证名称" />
            </label>
            <label class="form__row">
              <span class="form__key">密钥值</span>
              <Input v-model="epKeyValue" type="password" placeholder="只写入，不回显" />
            </label>
            <p class="form__note">
              密钥明文只进 Core 凭证库，不进日志、不进总线。留空则稍后在卡片上单独设置。
            </p>
          </div>
        </div>
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
.llm-settings__search { max-width: 220px; }
.llm-settings__sub { margin: 0; font-size: var(--text-xs); color: var(--color-text-muted); }
.llm-settings__ports { margin: 0; font-size: var(--text-xs); color: var(--color-text-muted); }

.form { display: flex; flex-direction: column; gap: var(--space-2); }
.form__row { display: flex; align-items: center; gap: var(--space-2); }
.form__row--col { flex-direction: column; align-items: stretch; gap: var(--space-2); }
.form__key { flex: none; width: 72px; font-size: var(--text-xs); color: var(--color-text-muted); }
.form__check { display: flex; align-items: center; gap: var(--space-2); font-size: var(--text-sm); }
.form__note { margin: 0; font-size: var(--text-xs); color: var(--color-text-muted); }
.cred {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-2);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-surface-2);
}
</style>
