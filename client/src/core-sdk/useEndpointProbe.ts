/**
 * 端点探测（S8 之后的模型配置页重做）—— **不需要任何新的 Core 通路**。
 *
 * ## 为什么能免费拿到「连通性」
 *
 * `llm.models.list.result` 带 `catalog: 'remote' | 'static'`：
 * `remote` = 真的拉到了上游 `/models`；`static` = 拉取失败/超时，provider 降级到内置静态列表。
 *
 * 所以**「拉模型列表」和「测连通」是同一个动作** —— 顺带还给了延迟与模型清单，
 * 不必再写一个 `/health` 之类的探针接口。
 *
 * ## 为什么不直接用 `useModelCatalog`
 *
 * 那个 composable 是**单 provider 专用**的：`load(target)` 会把 `provider` 改成 target
 * 并清空列表 —— 它服务的是「当前选中的模型下拉」。
 * 而探测要能对**任意** provider 发、且**不能劫持当前选择**：
 * 用户点「连通性测试」测另一家，回来发现自己的模型下拉被清空了，那是纯粹的伤害。
 *
 * 所以这里独立一份，结果**按 provider 归档**。
 *
 * ## 结果按 provider 匹配而非 requestId
 *
 * 与 `useModelCatalog` 同一个理由：同一 provider 的重复探测结果等价，
 * 而按 requestId 匹配会被竞态搞出「点了三次只认最后一次」的错觉。
 */
import { onMounted, onUnmounted, ref } from 'vue'
import { useCommand } from './useCommand'
import { sse } from './sse'

export interface ProbeResult {
  provider: string
  models: string[]
  /** `remote` = 端点可达；`static` = 走了内置兜底，基本可判定为连不上 */
  catalog: 'remote' | 'static'
  /** 客户端实测往返耗时（ms）。超时/无响应时为 null */
  latencyMs: number | null
  at: number
}

/** 单次探测的上限。超时就报「不可达」—— 按钮不能一直转。 */
const PROBE_TIMEOUT_MS = 8000

export function useEndpointProbe() {
  /** provider → 最近一次探测结果 */
  const results = ref<Record<string, ProbeResult | undefined>>({})
  const probing = ref<Record<string, boolean>>({})
  /** requestId → 开始时刻，用于算延迟 */
  const startedAt = new Map<string, number>()

  function resultOf(provider: string): ProbeResult | undefined {
    return results.value[provider]
  }

  function isProbing(provider: string): boolean {
    return probing.value[provider] === true
  }

  /**
   * 端点是否可达。
   *
   * `null` = 还没探过（**与「不可达」是两件事**，UI 要分开显示：
   * 「未测试」和「测试失败」对用户的意义完全不同）。
   */
  function reachable(provider: string): boolean | null {
    const r = results.value[provider]
    if (!r) return null
    return r.catalog === 'remote'
  }

  /** 端点改了之后旧结果就没意义了，必须清掉 —— 否则会显示上一端的成功 */
  function clear(provider: string): void {
    const next = { ...results.value }
    delete next[provider]
    results.value = next
  }

  function setProbing(provider: string, on: boolean): void {
    const next = { ...probing.value }
    if (on) next[provider] = true
    else delete next[provider]
    probing.value = next
  }

  function applyResult(payload: unknown): void {
    if (!payload || typeof payload !== 'object') return
    const p = payload as Record<string, unknown>
    const provider = typeof p.provider === 'string' ? p.provider : ''
    if (!provider || probing.value[provider] !== true) return
    const requestId = typeof p.requestId === 'string' ? p.requestId : ''
    const began = startedAt.get(requestId)
    if (began !== undefined) startedAt.delete(requestId)
    results.value = {
      ...results.value,
      [provider]: {
        provider,
        models: Array.isArray(p.models)
          ? (p.models as unknown[]).filter((m): m is string => typeof m === 'string')
          : [],
        catalog: p.catalog === 'remote' ? 'remote' : 'static',
        latencyMs: began === undefined ? null : Date.now() - began,
        at: Date.now(),
      },
    }
    setProbing(provider, false)
  }

  /** 探测某 provider。返回结果；超时或无响应按「不可达」处理 */
  async function probe(provider: string): Promise<ProbeResult | null> {
    if (!provider) return null
    const requestId = `probe-${provider}-${Date.now()}-${Math.random().toString(16).slice(2)}`
    startedAt.set(requestId, Date.now())
    setProbing(provider, true)

    // 超时兜底：provider 只会对**自己负责的**厂商回结果。
    // 若它压根没注册成实例，就永远不会有回音 —— 不设兜底按钮会一直转。
    const timer = setTimeout(() => {
      startedAt.delete(requestId)
      if (probing.value[provider] !== true) return
      results.value = {
        ...results.value,
        [provider]: {
          provider,
          models: [],
          catalog: 'static',
          latencyMs: null,
          at: Date.now(),
        },
      }
      setProbing(provider, false)
    }, PROBE_TIMEOUT_MS)

    try {
      const { send } = useCommand()
      await send('llm.models.list', { requestId, provider })
    } finally {
      clearTimeout(timer)
    }
    return results.value[provider] ?? null
  }

  let dispose: (() => void) | null = null
  onMounted(() => {
    dispose = sse.subscribe('llm.models.list.result', applyResult)
  })
  onUnmounted(() => {
    dispose?.()
    dispose = null
    startedAt.clear()
  })

  return { results, probing, probe, resultOf, isProbing, reachable, clear }
}