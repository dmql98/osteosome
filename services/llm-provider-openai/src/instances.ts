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

/** 自填项 → 实例（凭证引用缺省按 `env:<ID_UPPER>_API_KEY` 推断；未配置凭证则不返回） */
function instanceFromOverride(o: VendorOverride, env: NodeJS.ProcessEnv): VendorInstance | null {
  const suffix = o.id.replace(/[^a-zA-Z0-9]/g, '_').toUpperCase()
  const credentialRef = o.credentialRef ?? `env:${suffix}_API_KEY`
  // 免凭证（credentialRef 为空串）或该引用对应的 env 有值才注册
  if (credentialRef) {
    const envName = credentialRef.startsWith('env:') ? credentialRef.slice(4) : ''
    const value = envName ? env[envName] : undefined
    if (typeof value !== 'string' || value.trim().length === 0) return null
  }
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

/**
 * 构建本进程要注册的实例列表。
 *
 * 规则：
 * 1. 只看**本进程实现的 wire**（`SERVED_WIRE`）的预设 —— 别的 wire 归别的进程；
 * 2. 遍历这些预设，**已配置凭证**（或免凭证）的才注册；
 * 3. 叠加用户自填项（同 id 时自填覆盖预设），其中 wire 不是本进程实现的那批**拒绝并告警**；
 * 4. 自填项同样要求凭证已配置；
 * 5. 结果按 id 排序，保证注册顺序稳定（冒烟断言可预期）。
 *
 * @param rejected 收集被拒绝的自填项（装配层用来告警，测试用来断言）
 */
export function buildVendorInstances(
  env: NodeJS.ProcessEnv = process.env,
  presets: readonly VendorPreset[] = presetsForWire(SERVED_WIRE),
  rejected: Array<{ id: string; api: string }> = [],
): VendorInstance[] {
  const byId = new Map<string, VendorInstance>()

  for (const preset of presets) {
    if (preset.api !== SERVED_WIRE) continue
    if (!hasVendorCredential(preset, env)) continue
    byId.set(preset.id, {
      id: preset.id,
      label: preset.label,
      baseUrl: resolveVendorBaseUrl(preset, env),
      credentialRef: vendorCredentialRef(preset),
      defaultModel: resolveVendorModel(preset, env),
      staticModels: [...preset.models],
      preset,
    })
  }

  for (const override of parseVendorOverrides(env.LLM_VENDORS_EXTRA)) {
    const wire = override.api ?? WIRE_OPENAI
    if (wire !== SERVED_WIRE) {
      // 不静默丢弃：用户以为自己装上了，得让他看见为什么没生效
      rejected.push({ id: override.id, api: wire })
      continue
    }
    const instance = instanceFromOverride(override, env)
    if (instance) byId.set(instance.id, instance)
  }

  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id))
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
