/**
 * 模型目录通用逻辑（P4 WS-3）—— 各 provider 服务复用的「拉上游 /models + 降级静态」实现。
 *
 * 为什么放 shared：openai 系（deepseek / openrouter / openai）与 anthropic 的 `/models` 形状一致
 * （`{ data: [{ id }] }`），差异只在 baseURL 与静态兜底列表——由各 provider 注入。
 *
 * **降级语义**（P4 计划）：拉取失败 / 超时 / 畸形 → 回 `source:'static'` + 静态列表，
 * 让前端能提示「列表可能不全」而不是直接空列表。
 */
export interface CatalogResult {
  models: string[]
  source: 'remote' | 'static'
}

export interface ListModelsOptions {
  /** 上游根（不含 /models） */
  baseURL: string
  apiKey: string
  /** 静态兜底列表（各 provider 自带） */
  staticModels: string[]
  /** 拉取超时 ms（默认 5000） */
  timeoutMs?: number
  signal?: AbortSignal
  /** 注入 fetch（测试） */
  fetchImpl?: typeof fetch
  /** 鉴权 header 构造（各 provider 不同：Bearer vs x-api-key） */
  headers?: Record<string, string>
}

const DEFAULT_TIMEOUT_MS = 5000

/** 从 `/models` 响应解析模型 id 列表；畸形/非数组 → 空数组 */
export function parseModelIds(raw: unknown): string[] {
  if (!raw || typeof raw !== 'object') return []
  const data = (raw as { data?: unknown }).data
  if (!Array.isArray(data)) return []
  const ids: string[] = []
  for (const item of data) {
    if (item && typeof item === 'object' && typeof (item as { id?: unknown }).id === 'string') {
      ids.push((item as { id: string }).id)
    }
  }
  return ids
}

/** 拉模型目录；失败/超时 → 降级 static（不抛） */
export async function listModels(opts: ListModelsOptions): Promise<CatalogResult> {
  const { baseURL, apiKey, staticModels, signal } = opts
  const fetchImpl = opts.fetchImpl ?? fetch
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const url = `${baseURL.replace(/\/+$/, '')}/models`

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  timer.unref?.()
  // 外部 signal 也要能中断
  const onAbort = (): void => controller.abort()
  signal?.addEventListener('abort', onAbort, { once: true })

  try {
    const res = await fetchImpl(url, {
      method: 'GET',
      headers: {
        ...(opts.headers ?? {}),
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      signal: controller.signal,
    })
    if (!res.ok) return { models: staticModels, source: 'static' }
    const json = (await res.json().catch(() => null)) as unknown
    const ids = parseModelIds(json)
    if (ids.length === 0) return { models: staticModels, source: 'static' }
    return { models: ids, source: 'remote' }
  } catch {
    return { models: staticModels, source: 'static' }
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
}
