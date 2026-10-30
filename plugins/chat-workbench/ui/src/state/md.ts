/**
 * 消息正文渲染（P0-视觉轮）—— assistant 产出的唯一渲染入口。
 *
 * ## 为什么必须在这里收口
 *
 * 时间线曾用 `{{ row.text }}` 纯文本插值：代码块、列表、标题全部平铺成一坨等宽文字。
 * 现在唯一的改动面就是这一份 → 时间线只管把 HTML 塞进 `.chat-md` 容器。
 *
 * ## 流式安全
 *
 * 来源是**模型输出**，不可信。所以任何产物都过 `DOMPurify.sanitize`
 * （默认配置已剥 `<script>`/事件属性；仅额外放行链接的 `target`）。
 * 流式期间每次 token 都重渲染整个文本 —— 典型会话体量（几 KB）下解析成本可忽略；
 * 值得警惕的下半屏长代码会话也远低于一次布局抖动的开销。刻意不做增量解析。
 *
 * ## 代码块的「复制」按钮
 *
 * `v-html` 里的按钮不是 Vue 组件，事件走**容器级委托**（`mdCopyHandler`，
 * 在时间线组件里挂一次）。按钮自己没有任何行为，只负责标记「我旁边有个 code」。
 */
import DOMPurify from 'dompurify'
import { marked } from 'marked'

/* 安全放行：链接带 target=_blank（外链新窗口开），DOMPurify 默认会剥它 */
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A' && node.getAttribute('href')) {
    node.setAttribute('target', '_blank')
    node.setAttribute('rel', 'noopener noreferrer')
  }
})

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

marked.use({
  gfm: true,
  breaks: true, // 模型输出的单个换行按 <br> 处理，贴聊天习惯
  renderer: {
    /** 块级代码 → 带语言标签与复制按钮的头（样式见时间线 .md-code） */
    code(token: { text: string; lang?: string }): string {
      const lang = (token.lang ?? '').trim().split(/\s+/)[0] ?? ''
      return `<div class="md-code" data-lang="${escapeHtml(lang)}">` +
        `<div class="md-code__head"><span class="md-code__lang">${lang || 'text'}</span>` +
        `<button class="md-copy" type="button" data-copy aria-label="复制代码">复制</button></div>` +
        `<pre><code>${escapeHtml(token.text)}</code></pre></div>\n`
    },
  },
})

/** 渲染 + 消毒。时间线里 assistant 行的正文走这里；user 行保持纯文本不变。 */
export function renderMarkdown(text: string): string {
  if (!text) return ''
  const html = marked.parse(text, { async: false }) as string
  return DOMPurify.sanitize(html, { ADD_ATTR: ['target', 'aria-label', 'data-copy', 'data-lang'] })
}

/**
 * 代码块复制（委托处理器的动作部分）。返回 true = 已写入剪贴板。
 *
 * 剪贴板 API 在 iframe / 非手势上下文可能被拒，退回 `execCommand('copy')` 老路 ——
 * 两条都失败才算失败（调用方给个「复制失败」反馈即可，不弹窗）。
 */
export async function copyCodeFrom(el: Element): Promise<boolean> {
  const code = el.querySelector('pre code')
  if (!code) return false
  const text = code.textContent ?? ''
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    // 回退：隐藏 textarea + 选中 + execCommand（IANA 已废弃但仍是最广的兜底）
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    let ok = false
    try {
      ok = document.execCommand('copy')
    } catch {
      ok = false
    }
    ta.remove()
    return ok
  }
}
