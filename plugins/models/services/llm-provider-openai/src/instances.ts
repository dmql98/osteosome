/**
 * 厂商实例构建（S1）—— 把「厂商预设表」+ env 配置算成「本进程要注册哪些 provider 实例」。
 *
 * 与装配层（`index.ts`）分离的原因：这段是纯函数，能直测；装配层只负责 publish 与转发。
 *
 * **多实例怎么在一进程内工作**：每个实例持有自己的 baseUrl / 凭证引用 / 默认模型 / 静态目录，
 * 注册到 `llm` 主位的路由表里各占一个 provider 名；请求到达时按 `payload.provider` 取对应实例。
 * wire 翻译是同一套（都是 openai 兼容），所以 provider 侧只有一份 `streamCompletions`。
 *
 * **env 覆盖**（集成冒烟与自建端点靠它，无需改代码）：
 * - `<ID_UPPER>_BASE_URL` 改端点（如 `DEEPSEEK_BASE_URL=http://127.0.0.1:1234/v1`）
 * - `<ID_UPPER>_MODEL` 改默认模型
 *
 * **本进程只服务 `WIRE_OPENAI`**：预设表里 `api !== WIRE_OPENAI` 的行由别的
 * `llm-provider-<wire>` 进程负责（见 `shared/src/llm/vendors.ts` 的 `api` 契约）。
 * 过滤而不是全盘接受，是为了不注册出「声称支持、实际会发错请求体」的假 provider。
 */
import {
  hasVendorCredential,
  presetsForWire,
  resolveVendorBaseUrl,
  resolveVendorModel,
  vendorCredentialRef,
  WIRE_OPENAI,
  type VendorPreset,
} from '@osteosome/shared'
import { RETRY_POLICY } from './provider'

/** 本进程实现的 wire —— 与服务 id `llm-provider-openai` 对应 */
export const SERVED_WIRE = WIRE_OPENAI

/** 一个已解析好的 provider 实例（= 一条 `llm.provider.registered`） */
export interface VendorInstance {
  /** provider id（路由名） */
  id: string
  /** 展示名 */
  label: string
  /** 上游根（已去尾部斜杠） */
  baseUrl: string
  /** 凭证引用 `env:<NAME>`；免凭证厂商为空串 */
  credentialRef: string
  /** 默认模型（可能为空串 —— 本地端点由用户填） */
  defaultModel: string
  /** 静态兜底目录 */
  staticModels: string[]
  /** 该实例的预设出处（自定义端点为 undefined） */
  preset?: VendorPreset
}

/** 用户自填端点（S3 由设置窗写入；S1 先留形状与解析口） */
export interface VendorOverride {
  id: string
  label?: string
  baseUrl: string
  /** 凭证引用；缺省按 `env:<ID_UPPER>_API_KEY` 推断 */
  credentialRef?: string
  defaultModel?: string
  models?: string[]
  /**
   * wire id；缺省 `openai`。
   *
   * 用户自填端点默认就是 openai 兼容（绝大多数自建端点/代理都是），所以缺省值合理。
   * 若填了本进程**不实现**的 wire，该项被拒绝并告警 —— 宁可不装，也不能装一个会发错
   * 请求体的 provider。
   */
  api?: string
}

/**
 * 用户自填项的来源：env `LLM_VENDORS_EXTRA`（JSON 数组）。
 *
 * 为什么先给 env 而不是 API：S1 不引入新的 Core 路由；等 S3 的设置窗落地，
 * 写入路径改为 preferences，这里保留 env 作为「脚本/自建端点」入口与测试注入点。
 * 畸形 JSON 静默忽略（不因为一条坏配置起不来）。
 */
export function parseVendorOverrides(raw: string | undefined): VendorOverride[] {
  if (!raw || !raw.trim()) return []
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (o): o is VendorOverride =>
        !!o &&
        typeof o === 'object' &&
        typeof (o as VendorOverride).id === 'string' &&
        (o as VendorOverride).id.length > 0 &&
        typeof (o as VendorOverride).baseUrl === 'string' &&
        (o as VendorOverride).baseUrl.length > 0,
    )
  } catch {
    return []
  }
}

/**
 * 自填项 → 实例。
 *
 * 凭证解析顺序：`credentialRef` 缺省按 `env:<ID_UPPER>_API_KEY` 推断；该 env 没值时，
 * 退到 Core 凭证库里 `provider === 该 id` 的那条（用户在设置窗为自填端点存的密钥）。
 * 两条都没有 → 不返回（不注册）。
 */
function instanceFromOverride(
  o: VendorOverride,
  env: NodeJS.ProcessEnv,
  byProvider: ReadonlyMap<string, string>,
): VendorInstance | null {
  const suffix = o.id.replace(/[^a-zA-Z0-9]/g, '_').toUpperCase()
  const explicitRef = o.credentialRef
  // 用户显式给了 credentialRef 就按它走；没给才走「env 推断 → 凭证库」
  const credentialRef = explicitRef ?? pickOverrideCredentialRef(o.id, suffix, env, byProvider)
  if (credentialRef === null) return null
  return {
    id: o.id,
    label: o.label ?? o.id,
    baseUrl: o.baseUrl.replace(/\/+$/, ''),
    credentialRef,
    defaultModel: o.defaultModel ?? '',
    staticModels: o.models ?? [],
    preset: undefined,
  }
}

function pickOverrideCredentialRef(
  id: string,
  suffix: string,
  env: NodeJS.ProcessEnv,
  byProvider: ReadonlyMap<string, string>,
): string | null {
  const envRef = `env:${suffix}_API_KEY`
  if (typeof env[envRef.slice(4)] === 'string' && env[envRef.slice(4)]!.trim().length > 0) return envRef
  const coreId = byProvider.get(id)
  if (coreId) return `core:${coreId}`
  // 自填端点可以显式声明免凭证：`credentialRef: ''`
  return null
}

/**
 * 凭证来源的真相。
 *
 * S3 之前只有 env（`credentialRef = env:<NAME>`）；S3 起用户在设置窗存密钥到 Core 凭证库，
 * 于是同一份「这家能不能用」有两个来源：
 *
 * | 来源 | credentialRef | 谁写的 | 优先级 |
 * |---|---|---|---|
 * | 进程 env | `env:<VAR>` | 脚本 / CI / 自建端点 | **高** —— 显式注入优先于库里那份 |
 * | Core 凭证库 | `core:<id>` | 用户在设置窗 | 低（env 没有时兜底） |
 * | 无 | 不注册 | — | 该厂商不出现 |
 *
 * env 优先的理由：env 是**部署者**的显式意图，凭证库是**用户**填的。冲突时听部署者的。
 */
export interface CredentialSources {
  /** Core 凭证库：`厂商 id → 凭证 id`（`credential.saved` 带 `provider` 字段，据此归类） */
  byProvider?: ReadonlyMap<string, string>
  /** env 判定沿用 `hasVendorCredential`（免凭证端点恒真） */
  env?: NodeJS.ProcessEnv
  /**
   * Core 偏好（`preferences.get` 的返回值）—— 用户在设置窗写的自填端点。
   * 键：`llm.vendorOverrides`。
   */
  preferences?: { vendorOverrides?: unknown }
}

/** 某个厂商该用哪个 credentialRef；`null` = 不可用（不注册） */
export function resolveCredentialRef(preset: VendorPreset, sources: CredentialSources = {}): string | null {
  const env = sources.env ?? process.env
  const envRef = vendorCredentialRef(preset)
  // 免凭证端点（credentialEnv 为空）→ 无需凭证即可用
  if (!envRef) return ''
  // ① env 注入优先：存在就用它，不看凭证库（部署者的显式意图）
  if (hasVendorCredential(preset, env)) return envRef
  // ② 退到 Core 凭证库：用户在设置窗为这家存的密钥
  const coreId = sources.byProvider?.get(preset.id)
  if (coreId) return `core:${coreId}`
  // ③ 两边都没有 → 不可用
  return null
}

/**
 * 构建本进程要注册的实例列表。
 *
 * 规则：
 * 1. 只看**本进程实现的 wire**（`SERVED_WIRE`）的预设 —— 别的 wire 归别的进程；
 * 2. 遍历这些预设，**有可用凭证**（env / Core 凭证库 / 免凭证）的才注册；
 * 3. 叠加用户自填项（同 id 时自填覆盖预设），其中 wire 不是本进程实现的那批**拒绝并告警**；
 * 4. 自填项同样要求凭证已配置；
 * 5. 结果按 id 排序，保证注册顺序稳定（冒烟断言可预期）。
 *
 * @param rejected 收集被拒绝的自填项（装配层用来告警，测试用来断言）
 * @param presets 本进程要服务的预设（P5：来自插件自带 `catalog.json`）。
 *                **必填** —— 数据只有一个来源（那份文件），这里给默认值等于把它
 *                抄回代码里，而两份数据漂移的症状是「界面上有的厂商，服务不认」。
 */
export function buildVendorInstances(
  envOrSources: NodeJS.ProcessEnv | CredentialSources = process.env,
  presets: readonly VendorPreset[] = presetsForWire(SERVED_WIRE, []),
  rejected: Array<{ id: string; api: string }> = [],
): VendorInstance[] {
  // 兼容旧签名：第一个参数传纯 env 对象时按 env 处理
  const sources: CredentialSources =
    envOrSources && 'env' in envOrSources || envOrSources && 'byProvider' in envOrSources
      ? (envOrSources as CredentialSources)
      : { env: envOrSources as NodeJS.ProcessEnv }
  const env = sources.env ?? process.env
  const byProvider = sources.byProvider ?? new Map<string, string>()
  const byId = new Map<string, VendorInstance>()

  for (const preset of presets) {
    if (preset.api !== SERVED_WIRE) continue
    const credentialRef = resolveCredentialRef(preset, { env, byProvider })
    if (credentialRef === null) continue
    byId.set(preset.id, {
      id: preset.id,
      label: preset.label,
      baseUrl: resolveVendorBaseUrl(preset, env),
      credentialRef,
      defaultModel: resolveVendorModel(preset, env),
      staticModels: [...preset.models],
      preset,
    })
  }

  for (const override of parseVendorOverrides(readOverridesFrom(sources))) {
    const wire = override.api ?? WIRE_OPENAI
    if (wire !== SERVED_WIRE) {
      // 不静默丢弃：用户以为自己装上了，得让他看见为什么没生效
      rejected.push({ id: override.id, api: wire })
      continue
    }
    const instance = instanceFromOverride(override, env, byProvider)
    if (instance) byId.set(instance.id, instance)
  }

  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id))
}

/**
 * 自填端点的来源。
 *
 * 优先级：**Core 偏好（用户在设置窗写的）> env `LLM_VENDORS_EXTRA`（脚本 / 测试注入）**。
 * 两者都没有 → 无自填端点。只有真的取到了非空数组才用偏好，否则回退 env ——
 * 否则「设置窗里没填过」会把脚本注入的端点也一起抹掉。
 */
function readOverridesFrom(sources: CredentialSources): string | undefined {
  const fromPrefs = sources.preferences?.vendorOverrides
  if (Array.isArray(fromPrefs) && fromPrefs.length > 0) return JSON.stringify(fromPrefs)
  return (sources.env ?? process.env).LLM_VENDORS_EXTRA
}

/** 实例 → `llm.provider.registered` 的 payload */
export function toRegisteredPayload(inst: VendorInstance): {
  provider: string
  defaultModel: string
  credentialRef: string
  retryPolicy: typeof RETRY_POLICY
} {
  return {
    provider: inst.id,
    defaultModel: inst.defaultModel,
    credentialRef: inst.credentialRef,
    retryPolicy: RETRY_POLICY,
  }
}
