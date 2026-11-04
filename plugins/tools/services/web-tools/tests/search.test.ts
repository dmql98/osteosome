/**
 * `websearch` 的解析与抓取。
 *
 * 两个后端都要守同一件事：**搜到 0 条**与**工具坏了**必须分清 ——
 * 前者是模型换关键词的信号，后者要落成失败结果。所以：
 * - 解析函数对畸形输入返回空，不抛；
 * - `searchWeb` 在 HTTP 失败时抛（由执行者转成 `ok:false`）。
 *
 * HTML 解析另守两条：跳转链接要还原成真实 URL（`/l/?uddg=`），
 * 标题/摘要去标签解实体（否则模型读到 `&amp;quot;` 这种噪音）。
 */
import { describe, expect, it } from 'vitest'
import {
  decodeEntities,
  MAX_RESULTS,
  parseDuckDuckGoLite,
  parseSearxng,
  renderSearch,
  resolveDdgHref,
  searchWeb,
  stripTags,
} from '../src/search'

/** 真实 lite.duckduckgo.com 结果页的骨架（属性顺序与引号风格都照抄） */
const DDG_HTML = `
<table>
  <tr>
    <td><a rel="nofollow" href="https://example.com/a" class='result-link'>Alpha &amp; Beta</a></td>
  </tr>
  <tr><td class='result-snippet'>第一条摘要，含 <b>粗体</b>。</td></tr>
  <tr>
    <td><a rel="nofollow" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.org%2Fb&amp;rut=xyz" class='result-link'>Gamma</a></td>
  </tr>
  <tr><td class='result-snippet'>第二条摘要</td></tr>
</table>
`

describe('DDG lite 解析', () => {
  it('抽标题 / 还原真实 URL / 按顺序配上摘要', () => {
    const hits = parseDuckDuckGoLite(DDG_HTML, 5)
    expect(hits).toEqual([
      { title: 'Alpha & Beta', url: 'https://example.com/a', snippet: '第一条摘要，含 粗体 。' },
      { title: 'Gamma', url: 'https://example.org/b', snippet: '第二条摘要' },
    ])
  })

  it('limit 生效；畸形 HTML 返回空而不是抛', () => {
    expect(parseDuckDuckGoLite(DDG_HTML, 1)).toHaveLength(1)
    expect(parseDuckDuckGoLite('<html>换了版式</html>', 5)).toEqual([])
    expect(parseDuckDuckGoLite('', 5)).toEqual([])
  })
})

describe('SearxNG 解析', () => {
  it('取 title/url/content，缺字段的条目跳过', () => {
    expect(
      parseSearxng(
        {
          results: [
            { title: 'A', url: 'https://a.test', content: 'sa' },
            { title: '', url: 'https://b.test' },
            { title: 'C', content: '没 URL' },
            { title: 'D', url: 'https://d.test' },
          ],
        },
        5,
      ),
    ).toEqual([
      { title: 'A', url: 'https://a.test', snippet: 'sa' },
      { title: 'D', url: 'https://d.test', snippet: '' },
    ])
  })

  it('非对象 / 缺 results 一律空', () => {
    expect(parseSearxng(null, 5)).toEqual([])
    expect(parseSearxng({}, 5)).toEqual([])
    expect(parseSearxng({ results: 'x' }, 5)).toEqual([])
  })
})

describe('文本还原', () => {
  it('实体与标签', () => {
    expect(decodeEntities('a &amp; b &#x27;c&#x27; &nbsp;d')).toBe("a & b 'c'  d")
    expect(stripTags('<p>你好 <b>世界</b></p>')).toBe('你好 世界')
  })

  it('跳转链接还原成目标地址（别的形态原样保留）', () => {
    expect(resolveDdgHref('//duckduckgo.com/l/?uddg=https%3A%2F%2Fx.test%2Fp')).toBe('https://x.test/p')
    expect(resolveDdgHref('https://plain.test/q')).toBe('https://plain.test/q')
  })
})

describe('renderSearch', () => {
  it('每条三段：序号标题 / URL / 摘要', () => {
    const text = renderSearch('q', [{ title: 'T', url: 'https://t.test', snippet: 'S' }], 'searxng')
    expect(text.split('\n')).toEqual(['搜索「q」（searxng，1 条）', '', '1. T', '   https://t.test', '   S'])
  })

  it('0 条时给出下一步建议（而不是一个空字符串）', () => {
    expect(renderSearch('q', [], 'duckduckgo')).toContain('没有结果')
    expect(renderSearch('q', [], 'duckduckgo')).toContain('webfetch')
  })
})

describe('searchWeb', () => {
  it('配了 endpoint → 走 SearxNG 的 JSON 接口', async () => {
    const calls: Array<{ url: string }> = []
    const fake = (async (input: unknown) => {
      calls.push({ url: String(input) })
      return new Response(JSON.stringify({ results: [{ title: 'A', url: 'https://a.test', content: 'sa' }] }), { status: 200 })
    }) as unknown as typeof fetch

    const outcome = await searchWeb({ query: '你好 世界', endpoint: 'http://127.0.0.1:8080/', fetchImpl: fake })
    expect(outcome.backend).toBe('searxng')
    expect(outcome.hits).toHaveLength(1)
    expect(calls[0]!.url).toBe(`http://127.0.0.1:8080/search?q=${encodeURIComponent('你好 世界')}&format=json`)
  })

  it('没配 endpoint → POST DuckDuckGo lite', async () => {
    const seen: Array<{ url: string; method?: string; body?: string }> = []
    const fake = (async (input: unknown, init?: { method?: string; body?: string }) => {
      seen.push({ url: String(input), method: init?.method, body: init?.body })
      return new Response(DDG_HTML, { status: 200 })
    }) as unknown as typeof fetch

    const outcome = await searchWeb({ query: 'alpha', fetchImpl: fake })
    expect(outcome.backend).toBe('duckduckgo')
    expect(outcome.hits).toHaveLength(2)
    expect(seen[0]!.method).toBe('POST')
    expect(seen[0]!.body).toBe('q=alpha')
  })

  it('result 上限被夹到 1..MAX_RESULTS', async () => {
    const hits = Array.from({ length: 20 }, (_, i) => ({ title: `t${i}`, url: `https://t.test/${i}`, content: '' }))
    const fake = (async () => new Response(JSON.stringify({ results: hits }), { status: 200 })) as unknown as typeof fetch

    const capped = await searchWeb({ query: 'q', limit: 999, endpoint: 'http://x', fetchImpl: fake })
    expect(capped.hits).toHaveLength(MAX_RESULTS)
  })

  it('后端挂了 → 抛（这是「工具坏了」，不是「没搜到」）', async () => {
    const fake = (async () => new Response('nope', { status: 503 })) as unknown as typeof fetch
    await expect(searchWeb({ query: 'q', fetchImpl: fake })).rejects.toThrow(/503/)
  })

  it('空 query 直接抛', async () => {
    await expect(searchWeb({ query: '  ', fetchImpl: (async () => new Response('')) as unknown as typeof fetch })).rejects.toThrow(/query/)
  })
})
