/**
 * 联网搜索（`websearch` 工具的实现）—— 纯解析 + 一次抓取，不碰总线，可直接单测。
 *
 * ## 为什么要两个后端
 *
 * 搜索 API 全都要 key，而 ost 是「本地优先、谁用谁配」的产品：
 * - 配了 `OST_SEARCH_ENDPOINT`（SearxNG 之类自建实例）→ 走它，返回结构化 JSON，最稳；
 * - 没配 → 退回 **DuckDuckGo lite** 的 HTML 页（无需 key，一次 POST）。
 *
 * 退回的那条是「能让模型用起来」的兜底，不是最优解：HTML 会变，所以解析写成
 * 「找不到就返回空列表 + 原因」，而不是抛 —— 模型看到「没搜到」时会换个说法再试，
 * 看到异常栈则只会复述异常。
 *
 * ## 输出是给模型读的纯文本
 *
 * 每条三段：序号 + 标题、URL、摘要。不返回 HTML、不返回 JSON 字符串 ——
 * 后者会诱导模型去「解析」而不是「读」。
 */
/** 一条搜索结果 */
export interface SearchHit {
  title: string
  url: string
  snippet: string
}

/** 一次搜索的结果：命中的条目 + 走的哪个后端（要告诉模型，便于它判断可信度） */
export interface SearchOutcome {
  hits: SearchHit[]
  backend: 'searxng' | 'duckduckgo'
}

/** 一次搜索最多取几条 */
export const MAX_RESULTS = 10

/** 默认条数 */
export const DEFAULT_RESULTS = 5

const SEARCH_TIMEOUT_MS = 20_000

/** 冒充普通浏览器：lite.duckduckgo.com 对默认 UA 会直接 403 */
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36'

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
}

/** 只处理搜索结果里会出现的实体；`&#x27;` 这类数字实体也认 */
export function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body.startsWith('#')) {
      const code = body.startsWith('#x') || body.startsWith('#X')
        ? Number.parseInt(body.slice(2), 16)
        : Number.parseInt(body.slice(1), 10)
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : whole
    }
    return ENTITIES[body.toLowerCase()] ?? whole
  })
}

/** 去标签 + 解实体 + 压空白（标题/摘要都走这一条） */
export function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim()
}

/**
 * DuckDuckGo 的结果链接有时是 `/l/?uddg=<encoded>` 形式的跳转，
 * 直接给模型这个地址等于让它多跳一层，所以把真实 URL 取出来。
 */
export function resolveDdgHref(href: string): string {
  const raw = href.trim()
  if (raw === '') return ''
  const absolute = raw.startsWith('//') ? `https:${raw}` : raw
  try {
    const url = new URL(absolute, 'https://duckduckgo.com')
    const target = url.searchParams.get('uddg')
    return target ? target : url.toString()
  } catch {
    return raw
  }
}

/**
 * 解析 lite.duckduckgo.com 的结果页。
 *
 * 结构（会变，所以只依赖最稳的两件事）：结果标题是带 `result-link` 类的 `<a>`，
 * 摘要是一串 `result-snippet` 单元格，与标题按出现顺序一一对应。
 */
export function parseDuckDuckGoLite(html: string, limit: number): SearchHit[] {
  const hits: SearchHit[] = []
  const anchor = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi
  let match: RegExpExecArray | null
  while (hits.length < limit && (match = anchor.exec(html)) !== null) {
    const attrs = match[1] ?? ''
    if (!/class\s*=\s*['"][^'"]*result-link/i.test(attrs)) continue
    const href = /href\s*=\s*(['"])(.*?)\1/i.exec(attrs)?.[2] ?? ''
    const title = stripTags(match[2] ?? '')
    const url = resolveDdgHref(href)
    if (title === '' || url === '') continue
    hits.push({ title, url, snippet: '' })
  }

  const snippetCell = /<td[^>]*class\s*=\s*['"][^'"]*result-snippet[^'"]*['"][^>]*>([\s\S]*?)<\/td>/gi
  let index = 0
  let cell: RegExpExecArray | null
  while ((cell = snippetCell.exec(html)) !== null && index < hits.length) {
    hits[index]!.snippet = stripTags(cell[1] ?? '')
    index += 1
  }
  return hits
}

/** 解析 SearxNG 的 `/search?format=json` 回包 */
export function parseSearxng(raw: unknown, limit: number): SearchHit[] {
  if (!raw || typeof raw !== 'object') return []
  const results = (raw as { results?: unknown }).results
  if (!Array.isArray(results)) return []
  const out: SearchHit[] = []
  for (const item of results) {
    if (out.length >= limit) break
    if (!item || typeof item !== 'object') continue
    const row = item as { title?: unknown; url?: unknown; content?: unknown }
    const title = typeof row.title === 'string' ? row.title.trim() : ''
    const url = typeof row.url === 'string' ? row.url.trim() : ''
    if (title === '' || url === '') continue
    const snippet = typeof row.content === 'string' ? row.content.trim() : ''
    out.push({ title, url, snippet })
  }
  return out
}

/** 渲染成模型好读的文本 */
export function renderSearch(query: string, hits: readonly SearchHit[], backend: string): string {
  if (hits.length === 0) {
    return `搜索「${query}」（${backend}）没有结果。可以换个关键词，或用 webfetch 直接打开已知地址。`
  }
  const lines = [`搜索「${query}」（${backend}，${hits.length} 条）`]
  hits.forEach((hit, i) => {
    lines.push('')
    lines.push(`${i + 1}. ${hit.title}`)
    lines.push(`   ${hit.url}`)
    if (hit.snippet) lines.push(`   ${hit.snippet}`)
  })
  return lines.join('\n')
}

export interface SearchOptions {
  query: string
  /** 条数（1..10，缺省 5） */
  limit?: number
  /** 自建搜索实例根（SearxNG）。给了就不走 DuckDuckGo */
  endpoint?: string
  fetchImpl?: typeof fetch
  timeoutMs?: number
  /** 覆盖 DuckDuckGo 的抓取地址（测试与镜像用） */
  ddgUrl?: string
}

/**
 * 搜一次。
 *
 * 两种后端都失败时**抛**（由调用方转成失败结果）：那是「工具坏了」，
 * 与「搜到了但没有结果」必须区分开 —— 后者是模型该换关键词的信号。
 */
export async function searchWeb(options: SearchOptions): Promise<SearchOutcome> {
  const query = options.query.trim()
  if (query === '') throw new Error('websearch: query 不能为空')
  const limit = Math.min(Math.max(Math.floor(options.limit ?? DEFAULT_RESULTS), 1), MAX_RESULTS)
  const impl = options.fetchImpl ?? fetch
  const timeoutMs = options.timeoutMs ?? SEARCH_TIMEOUT_MS

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const endpoint = (options.endpoint ?? '').replace(/\/+$/, '')
    if (endpoint !== '') {
      const url = `${endpoint}/search?q=${encodeURIComponent(query)}&format=json`
      const res = await impl(url, { headers: { accept: 'application/json' }, signal: controller.signal })
      if (!res.ok) throw new Error(`搜索实例返回 HTTP ${res.status}`)
      const json = (await res.json().catch(() => null)) as unknown
      return { hits: parseSearxng(json, limit), backend: 'searxng' }
    }

    const res = await impl(options.ddgUrl ?? 'https://lite.duckduckgo.com/lite/', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'user-agent': UA,
        accept: 'text/html',
      },
      body: new URLSearchParams({ q: query }).toString(),
      signal: controller.signal,
    })
    if (!res.ok) throw new Error(`DuckDuckGo 返回 HTTP ${res.status}`)
    const html = await res.text()
    return { hits: parseDuckDuckGoLite(html, limit), backend: 'duckduckgo' }
  } finally {
    clearTimeout(timer)
  }
}
