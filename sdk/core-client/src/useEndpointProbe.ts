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
  /**
   * provider → 该次探测的结算（回音 / 超时 / 发送失败只结算一次）。
   *
   * 键用 **provider 而不是 requestId**：结果本来就按 provider 归档
   * （见文件头），而回音里 requestId 可能对不上（同一 provider 的并发探测、
   * 或由 `useModelCatalog` 那一路带回的结果），按 requestId 结算会让
   * `probe()` 永远等不到收尾。
   *
   * 探测要等的是 **SSE 回音**，不是 HTTP 202 —— 两者是两条独立的路。
   * 兜底计时器必须活到真正结算为止，不能跟着 `send()` 的返回一起清掉。
   */
  const pending = new Map<string, () => void>()

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
    // 结算：让正在 await 的 probe() 返回，并撤掉它的兜底计时器
    pending.get(provider)?.()
  }

  /**
   * 探测某 provider，**拿到回音才返回**。超时或无响应按「不可达」处理。
   *
   * ⚠️ 兜底计时器不能跟着 `await send(...)` 一起清掉：`useCommand.send` 只等
   * HTTP 202，SSE 回音是另一条路 —— 那样计时器会在回音到达之前就被撤掉，
   * 「没回音时按钮一直转」这个坑原封不动地留着（实现与文件头的注释正好相反）。
   */
  async function probe(provider: string): Promise<ProbeResult | null> {
    if (!provider) return null
    // 上一次还在转就别再发一轮：结果按 provider 归档，两轮只会互相踩
    if (probing.value[provider] === true) return results.value[provider] ?? null

    const requestId = `probe-${provider}-${Date.now()}-${Math.random().toString(16).slice(2)}`
    startedAt.set(requestId, Date.now())
    setProbing(provider, true)

    let timer: ReturnType<typeof setTimeout> | undefined
    const settle = (): void => {
      if (timer !== undefined) {
        clearTimeout(timer)
        timer = undefined
      }
      pending.delete(provider)
      startedAt.delete(requestId)
    }

    await new Promise<void>((resolve) => {
      const finish = (): void => {
        settle()
        resolve()
      }
      pending.set(provider, finish)

      // 超时兜底：provider 只会对**自己负责的**厂商回结果。
      // 若它压根没注册成实例，就永远不会有回音 —— 不设兜底按钮会一直转。
      timer = setTimeout(() => {
        if (probing.value[provider] === true) {
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
        }
        finish()
      }, PROBE_TIMEOUT_MS)

      // 连 202 都没拿到同样算不可达；拿到 202 则由 applyResult 结算
      const { send } = useCommand()
      void send('llm.models.list', { requestId, provider }).catch(() => finish())
    })

    return results.value[provider] ?? null
  }

  let dispose: (() => void) | null = null
  onMounted(() => {
    dispose = sse.subscribe('llm.models.list.result', applyResult)
  })
  onUnmounted(() => {
    dispose?.()
    dispose = null
    // 撤掉所有在途探测的兜底计时器，别把它们带进组件销毁之后
    for (const finish of [...pending.values()]) finish()
    pending.clear()
    startedAt.clear()
  })

  return { results, probing, probe, resultOf, isProbing, reachable, clear }
}