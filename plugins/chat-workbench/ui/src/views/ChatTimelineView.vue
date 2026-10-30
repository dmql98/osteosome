<template>
  <div class="chat-timeline" @click="onRootClick">
    <div class="chat-timeline__bar">
      <span class="chat-timeline__title">{{ currentTitle }}</span>
      <span v-if="running" class="chat-timeline__pill chat-timeline__pill--run" data-testid="timeline-pill">回复中</span>
      <span v-else-if="failed" class="chat-timeline__pill chat-timeline__pill--err" data-testid="timeline-pill">出错</span>
      <span class="chat-timeline__sp" />
      <span class="chat-timeline__count">{{ rows.length }} 条</span>
    </div>
    <div ref="messagesEl" class="chat-timeline__messages" data-testid="timeline-messages" @scroll="onScroll">
      <button
        v-if="hasMore"
        class="chat-timeline__more"
        data-testid="timeline-load-more"
        :disabled="loadingMore"
        @click="onLoadMore"
      >
        {{ loadingMore ? '加载中…' : '加载更早的消息' }}
      </button>
      <EmptyState
        v-if="!rows.length"
        icon="💬"
        title="这个会话还没有消息"
        description="在下方输入框发问，会话会自动保存历史。"
      />

      <template v-for="row in rows" :key="row.key">
        <!-- user / assistant 气泡 -->
        <div
          v-if="row.role === 'user'"
          class="chat-timeline__bubble chat-timeline__bubble--user"
          data-testid="timeline-user"
        >
          {{ row.text }}
        </div>
        <div
          v-else
          class="chat-timeline__bubble chat-timeline__bubble--assistant"
          :class="{ 'chat-timeline__bubble--streaming': row.pending && !row.text }"
          data-testid="timeline-assistant"
        >
          <span v-if="row.pending && !row.text" class="chat-timeline__spinner"><Spinner :size="12" /></span>
          <!-- 正文：markdown 渲染（安全见 state/md.ts）；user 气泡保持纯文本 -->
          <div v-if="row.text" class="chat-md" v-html="row.text && md(row.text)" />
          <!-- 流式尾光标（本轮还在跑且正文已开始） -->
          <span v-if="showCaret(row)" class="chat-timeline__caret" data-testid="timeline-caret" />
        </div>

        <!-- 折叠思考块。与正文分开渲染 —— 这是「思维链不进正文」的可见证据 -->
        <details v-if="row.reasoning" class="chat-timeline__thinking" :data-testid="`timeline-thinking-${row.key}`">
          <summary class="chat-timeline__thinking-head">
            <span class="chat-timeline__thinking-label">💭 思考过程</span>
            <span class="chat-timeline__thinking-count">{{ row.reasoning.length }} 字</span>
          </summary>
          <pre class="chat-timeline__thinking-body" data-testid="timeline-thinking-body">{{ row.reasoning }}</pre>
        </details>

        <!-- 工具卡：执行中 → ✓ / ✗ -->
        <div
          v-for="call in row.toolCalls ?? []"
          :key="call.id"
          class="chat-timeline__tool"
          :class="{
            'chat-timeline__tool--failed': call.ok === false,
            'chat-timeline__tool--running': call.ok === undefined,
          }"
          :data-testid="`timeline-tool-${call.name}`"
        >
          <span class="chat-timeline__tool-name">🔧 {{ call.name }}</span>
          <span class="chat-timeline__tool-args">{{ call.arguments }}</span>
          <span v-if="call.ok === undefined" class="chat-timeline__tool-state">执行中…</span>
          <span v-else-if="call.ok" class="chat-timeline__tool-state chat-timeline__tool-state--ok">
            ✓ {{ call.summary }}
          </span>
          <span v-else class="chat-timeline__tool-state chat-timeline__tool-state--err">✗ {{ call.summary }}</span>
        </div>

        <!-- 停因与用量 -->
        <div
          v-if="row.role === 'assistant' && !row.pending && (row.finishReason || row.usage)"
          class="chat-timeline__meta"
          data-testid="timeline-meta"
        >
          <span v-if="finishLabel(row.finishReason)" class="chat-timeline__meta-item">
            {{ finishLabel(row.finishReason) }}
          </span>
          <span v-if="row.usage" class="chat-timeline__meta-item mono">
            ↑{{ row.usage.promptTokens }} ↓{{ row.usage.completionTokens }}
          </span>
        </div>
      </template>

      <!-- 错误内联：不清空上文，就在末尾 -->
      <div v-if="failed" class="chat-timeline__failed" data-testid="timeline-failed">{{ failed }}</div>
    </div>

    <!-- 未钉底时给一个「回到底部」浮钮（running/长会话里被顶上去之后一眼能找回） -->
    <button v-if="!pinned" class="chat-timeline__jump" data-testid="timeline-jump" @click="jumpBottom">↓ 最新</button>

    <!-- 审批卡（P7 WS-13）：exec / workspace 两种 kind 就地答，不跳去 ① 工具页 -->
    <div v-if="approvals.length" class="chat-timeline__approvals" data-testid="timeline-approvals">
      <div v-for="p in approvals" :key="p.requestId" class="chat-timeline__approval" data-testid="timeline-approval">
        <div class="chat-timeline__approval-head">
          <Badge :variant="p.kind === 'workspace' ? 'warning' : 'primary'">
            {{ p.kind === 'workspace' ? '工作区授权' : '工具执行' }}
          </Badge>
          <code class="chat-timeline__approval-tool">{{ p.toolName }}</code>
          <span class="chat-timeline__approval-risk">{{ p.risk }}</span>
        </div>
        <pre class="chat-timeline__approval-body">{{ p.kind === 'workspace' ? `${p.requestedPath}\n（授权根：${p.permissionRoot}）` : p.arguments }}</pre>
        <div class="chat-timeline__approval-actions">
          <label v-if="p.risk === 'proc'" class="chat-timeline__approval-remember">
            <input type="checkbox" v-model="remember[p.requestId]" /> 记住
          </label>
          <span class="chat-timeline__sp" />
          <Button size="sm" variant="ghost" @click="resolve(p.requestId, false)">拒绝</Button>
          <Button size="sm" @click="resolve(p.requestId, true)">批准</Button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * ② 对话时间线 —— **纯展示，从不主动写状态**。
 *
 * ## 它与 ③ 输入框之间零直接通信，而这在 P6 之后更彻底了
 *
 * 搬进插件之前：两者共享 pinia 单例（同一个对象）。
 * 现在：两个独立 iframe，**连共享对象都没有了** —— 各自订阅同一批 SSE 事件，
 * 各自拼出内容必然一致的视图。
 *
 * 所以「零直接通信」这件事的含义变了：**以前靠共享对象实现，现在靠事件流同源实现。**
 * 后者更可靠：共享对象要同步，事件流只要各自收齐。
 *
 * ## 它为什么需要 curId
 *
 * `message.appended` / `loop.token.streamed` 都是**广播**，不带「这是给谁的」。
 * 按 curId 过滤是这个视图唯一的「状态依赖」，而 curId 由 ① 写共享层。
 *
 * ## P0-16：两个不存在的令牌修掉了
 *
 * 此前用了 `--color-accent` 与 `--color-surface-1`，而 `sdk/ui/src/tokens.css` 里
 * 真名是 `--color-primary` 与 `--color-surface`。token 名写错 CSS 与 TS 都不报错，
 * 症状是「用户气泡没有底色、流式尾光标是透明的」——这正是 tokens-parity 那类测试想防的事。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Badge, Button, Card, EmptyState, Spinner } from '@osteosome/ui'
import { sse, useCommand } from '@osteosome/core-client'
import { copyCodeFrom, renderMarkdown } from '../state/md'
import { currentSessionId, useRunState, useSessionState, type ChatRow } from '../state'

const sessions = useSessionState()
const { hasMore, loadingMore, loadMore } = sessions
const curId = currentSessionId()

/** 消息滚动容器 —— 「加载更早」prepend 后用它做滚动锚定 */
const messagesEl = ref<HTMLElement | null>(null)

/* ── 自动滚动（钉底）策略 ──────────────────────────────────────
 * 钉底 = 视口距底部 < 48px。用户上滚超过这个距离就算「解开」，
 * 之后新 token 不再拽人；回到底部附近自动重新钉上。 */
const pinned = ref(true)

function onScroll(): void {
  const el = messagesEl.value
  if (!el) return
  pinned.value = el.scrollHeight - el.scrollTop - el.clientHeight < 48
}

function scrollToBottom(): void {
  const el = messagesEl.value
  if (el) el.scrollTop = el.scrollHeight
}

/** 钉底状态下，每批新行/token 都贴到底；解钉时不拽人（浮钮接管）。
 *  watch 放在 `rows` 定义之后（watch 的 getter 在注册时就要读 rows，提前会踩 TDZ） */
function jumpBottom(): void {
  pinned.value = true
  void nextTick(scrollToBottom)
}

/**
 * 加载更早一页并把视口锚住：记录 prepend 前的 `scrollHeight`，DOM 更新后按增量下移 `scrollTop`，
 * 否则用户正在看的那条会「跳走」。
 */
async function onLoadMore(): Promise<void> {
  const el = messagesEl.value
  const before = el?.scrollHeight ?? 0
  const top = el?.scrollTop ?? 0
  await loadMore()
  await nextTick()
  if (el) el.scrollTop = top + (el.scrollHeight - before)
}

const run = useRunState({
  curId: () => curId.value,
  messages: () => sessions.messages.value,
})

const rows = computed<ChatRow[]>(() => run.rowsView.value)
const failed = computed(() => run.failed.value)
const running = computed(() => run.sending.value)

/** 钉底状态下，每批新行/token 都贴到底；解钉时不拽人（浮钮接管）。
 *  deep: true —— 流式更新走的是「行内追加」（run.ts 里 `target.text += token`），
 *  不 deep 的话同一行的追加不触发 watch，钉底就断了。 */
watch(
  rows,
  () => {
    if (!pinned.value) return
    void nextTick(scrollToBottom)
  },
  { deep: true },
)

/** markdown 正文（user 走纯文本分支，不会调到这里）。旧行同文本命中缓存。 */
const mdCache = new Map<string, string>()
function md(text: string): string {
  const hit = mdCache.get(text)
  if (hit !== undefined) return hit
  const html = renderMarkdown(text)
  // 流式期间同一行 key 反复出现 Bad 增长的话也不大：粒度按「整段文本」，
  // 落库后 id 稳定，缓存量级 ≈ 消息数。无界场景（超长会话）由换页自然淘汰。
  if (mdCache.size > 512) mdCache.clear()
  mdCache.set(text, html)
  return html
}

/** 代码块复制：按钮在 v-html 里不是 Vue 组件 → 容器级委托 */
async function onRootClick(event: Event): Promise<void> {
  const target = event.target as HTMLElement | null
  const copyBtn = target?.closest('[data-copy]')
  if (!copyBtn) return
  const btn = copyBtn as HTMLButtonElement
  const ok = await copyCodeFrom(btn.closest('.md-code') as Element)
  btn.textContent = ok ? '已复制' : '复制失败'
  btn.disabled = true
  setTimeout(() => {
    btn.textContent = '复制'
    btn.disabled = false
  }, 1200)
}
/** 标题条上的会话名（会话列表还没载入时退回「对话」） */
const currentTitle = computed(() => sessions.list.value.find((m) => m.id === curId.value)?.title || '对话')

/** 尾光标：只在「本轮在跑 + 这一行正在流式 + 已有正文」时显示 */
function showCaret(row: ChatRow): boolean {
  return Boolean(run.sending.value && row.pending && row.text.length > 0)
}

/** finishReason → 人话（只对用户有意义的那几个取值翻译） */
const FINISH_LABEL: Record<string, string> = {
  stop: '正常结束',
  length: '达到长度上限',
  content_filter: '被内容过滤',
  tool_calls: '工具调用',
  error: '出错结束',
}
function finishLabel(reason?: string): string {
  return reason ? (FINISH_LABEL[reason] ?? reason) : ''
}

interface PendingApproval {
  requestId: string
  sessionId: string
  toolName: string
  risk: string
  kind: 'exec' | 'workspace'
  arguments: string
  requestedPath?: string
  permissionRoot?: string
}
const approvals = ref<PendingApproval[]>([])
const remember = ref<Record<string, boolean>>({})
let offApprovals: Array<() => void> = []

/** 就地批准/拒绝：只发 `tool.approval.resolved`，真正的执行由 loop 重派 */
async function resolve(requestId: string, approved: boolean): Promise<void> {
  const { send } = useCommand()
  const ok = await send('tool.approval.resolved', {
    requestId,
    approved,
    ...(remember.value[requestId] ? { remember: true } : {}),
  })
  if (ok) approvals.value = approvals.value.filter((x) => x.requestId !== requestId)
}

onMounted(() => {
  // 每个 iframe 各自 bootstrap —— 这不是冗余，是「不依赖别人」的一部分。
  //
  // 搬进插件之前三个视图共享一个 pinia store，所以 ① 载入的会话列表大家都能读。
  // 现在它们是三个独立 iframe，② 的 `list` 是空的 —— 而它要的 `messages`
  // 也要有人触发 `session.get`。跨 iframe 传「数据」正是我们要避免的（见
  // `state/index.ts` 的纪律），所以正确的做法是**自己载入**。
  //
  // 代价是同一窗口里 `session.list` 会发三次。幂等、几十字节，
  // 换来的是「②③ 单独打开也能用」—— 那种情形用户真的能做（把某个盒子关掉再打开）。
  void sessions.bootstrap()
  run.bindEvents()
  // 审批卡：只看当前会话的请求（其它会话的请求由那边/① 工具页答）
  offApprovals = [
    sse.subscribe('tool.approval.requested', (payload) => {
      const p = payload as PendingApproval | null
      if (!p?.requestId) return
      if (p.sessionId && curId.value && p.sessionId !== curId.value) return
      if (!approvals.value.some((x) => x.requestId === p.requestId)) {
        approvals.value = [...approvals.value, { ...p, kind: p.kind === 'workspace' ? 'workspace' : 'exec' }]
      }
    }),
    sse.subscribe('tool.approval.resolved', (payload) => {
      const id = (payload as { requestId?: string } | null)?.requestId
      if (id) approvals.value = approvals.value.filter((x) => x.requestId !== id)
    }),
  ]
})

onBeforeUnmount(() => {
  for (const off of offApprovals) off()
  offApprovals = []
  run.dispose()
  sessions.dispose()
})
</script>

<style scoped>
/* 铺满宿主给出的盒子：细标题条固定，消息区滚动（P4b §8，无 Card 外壳） */
.chat-timeline {
  position: relative;   /* 「回到底部」浮钮的定位参照 */
  display: flex; flex-direction: column; height: 100%; min-height: 0; gap: 0;
  background: var(--color-surface);
}
.chat-timeline__bar {
  flex: none; display: flex; align-items: center; gap: var(--space-2);
  padding: var(--space-2) var(--space-3); border-bottom: 1px solid var(--color-border);
  background: var(--color-surface);
}
.chat-timeline__title {
  font-size: var(--text-sm); font-weight: 600;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.chat-timeline__sp { flex: 1; }
.chat-timeline__count { font-size: var(--text-xs); color: var(--color-text-muted); font-variant-numeric: tabular-nums; }
.chat-timeline__pill {
  font-size: var(--text-xs); padding: 1px 7px; border-radius: var(--radius-full);
  border: 1px solid var(--color-border); color: var(--color-text-muted); white-space: nowrap;
}
.chat-timeline__pill--run { color: var(--motion-working); border-color: var(--motion-working); }
.chat-timeline__pill--err { color: var(--color-danger); border-color: var(--color-danger); }
.chat-timeline__messages {
  flex: 1; min-height: 0; overflow-y: auto; padding: var(--space-4) var(--space-4) var(--space-3);
  display: flex; flex-direction: column; gap: 10px;
  background: var(--color-bg);
  scroll-behavior: smooth;
}
.chat-timeline__messages::-webkit-scrollbar { width: 6px; }
.chat-timeline__messages::-webkit-scrollbar-thumb { background: var(--color-border-strong); border-radius: var(--radius-full); }
.chat-timeline__messages::-webkit-scrollbar-thumb:hover { background: var(--color-text-muted); }
.chat-timeline__messages::-webkit-scrollbar-track { background: transparent; }
.chat-timeline__messages > :deep(.ui-empty-state) { flex: 1; align-content: center; }
.chat-timeline__more {
  align-self: center; flex: none; margin-bottom: var(--space-2);
  border: 1px solid var(--color-border); background: var(--color-surface); color: var(--color-text-muted);
  border-radius: var(--radius-full); padding: 3px 12px; font: inherit; font-size: var(--text-xs); cursor: pointer;
}
.chat-timeline__more:disabled { opacity: .6; cursor: default; }
.chat-timeline__more:hover:not(:disabled) { color: var(--color-primary); border-color: var(--color-primary); }

.chat-timeline__bubble {
  max-width: min(760px, 92%);
  padding: 10px 14px; border-radius: 12px;
  font-size: var(--text-md); line-height: 1.65; white-space: pre-wrap; word-break: break-word;
}
.chat-timeline__bubble--user {
  align-self: flex-end; background: var(--color-primary); color: var(--color-text-inverse);
  border-bottom-right-radius: 4px; box-shadow: var(--shadow-sm);
}
.chat-timeline__bubble--assistant {
  align-self: flex-start; background: var(--color-surface); border: 1px solid var(--color-border);
  border-bottom-left-radius: 4px; box-shadow: var(--shadow-sm);
}
/* 还没出正文的 assistant 占位：给个最小体感高度，别缩成一条缝 */
.chat-timeline__bubble--streaming { min-height: 34px; display: inline-flex; align-items: center; }
.chat-timeline__spinner { display: inline-flex; margin-right: var(--space-1); vertical-align: middle; }
.chat-timeline__caret {
  display: inline-block; width: 5px; height: 1em; margin-left: 3px; vertical-align: text-bottom;
  background: var(--color-primary); animation: chat-timeline-blink 1s steps(2, start) infinite;
}
@keyframes chat-timeline-blink { to { visibility: hidden; } }

/* ── assistant 正文 markdown（state/md.ts 产出，不用 raw 信任）────────── */
.chat-md { white-space: normal; }   /* bubble 根上是 pre-wrap，markdown 自己接管换行 */
.chat-md > :first-child { margin-top: 0; }
.chat-md > :last-child { margin-bottom: 0; }
.chat-md p { margin: 0.5em 0; }
.chat-md h1, .chat-md h2, .chat-md h3, .chat-md h4 {
  margin: 1em 0 0.4em; font-weight: 650; line-height: 1.4;
}
.chat-md h1 { font-size: 1.28em; } .chat-md h2 { font-size: 1.18em; } .chat-md h3 { font-size: 1.08em; }
.chat-md h2 { padding-bottom: 0.25em; border-bottom: 1px solid var(--color-border); }
.chat-md ul, .chat-md ol { margin: 0.5em 0; padding-left: 1.5em; }
.chat-md li { margin: 0.2em 0; }
.chat-md li > input { margin-right: 0.35em; }
.chat-md blockquote {
  margin: 0.6em 0; padding: 0.1em 0 0.1em 0.8em;
  border-left: 3px solid var(--color-border-strong); color: var(--color-text-muted);
}
.chat-md hr { border: 0; border-top: 1px solid var(--color-border); margin: 1em 0; }
.chat-md a { color: var(--color-primary); text-decoration: underline; text-underline-offset: 2px; }
.chat-md table { border-collapse: collapse; margin: 0.6em 0; font-size: 0.95em; display: block; overflow-x: auto; }
.chat-md th, .chat-md td { border: 1px solid var(--color-border); padding: 4px 10px; text-align: left; }
.chat-md th { background: var(--color-surface-2); font-weight: 600; }
.chat-md :not(pre) > code {
  font-family: var(--font-mono); font-size: 0.92em;
  background: color-mix(in srgb, var(--color-primary) 9%, var(--color-surface-2));
  color: var(--color-text); border-radius: var(--radius-sm); padding: 1px 6px;
}

/* 代码块：头部（语言 + 复制）+ 深色面板；委托复制，按钮不背行为 */
.chat-md .md-code {
  margin: 0.6em 0; border: 1px solid var(--color-border);
  border-radius: var(--radius-md); overflow: hidden;
}
.chat-md .md-code__head {
  display: flex; align-items: center; justify-content: space-between;
  padding: 4px 10px; background: var(--color-surface-2);
  border-bottom: 1px solid var(--color-border);
}
.chat-md .md-code__lang { font-family: var(--font-mono); font-size: var(--text-xs); color: var(--color-text-muted); }
.chat-md .md-copy {
  border: 1px solid var(--color-border); border-radius: var(--radius-sm);
  background: var(--color-surface); color: var(--color-text-muted);
  font: inherit; font-size: var(--text-xs); padding: 1px 8px; cursor: pointer;
}
.chat-md .md-copy:hover:not(:disabled) { color: var(--color-primary); border-color: var(--color-primary); }
.chat-md .md-copy:disabled { cursor: default; opacity: 0.75; }
.chat-md .md-code pre { margin: 0; padding: 10px 12px; overflow-x: auto; background: var(--color-surface-2); }
.chat-md .md-code code {
  font-family: var(--font-mono); font-size: 0.92em; line-height: 1.55;
  color: var(--color-text); background: transparent; padding: 0;
}

/* ── 未钉底时的「回到底部」浮钮 ─────────────────────────────── */
.chat-timeline__jump {
  position: absolute; left: 50%; transform: translateX(-50%); bottom: 14px; z-index: 5;
  border: 1px solid var(--color-border); border-radius: var(--radius-full);
  background: var(--color-surface); color: var(--color-text);
  font: inherit; font-size: var(--text-xs); padding: 5px 14px; cursor: pointer;
  box-shadow: var(--shadow-md);
}
.chat-timeline__jump:hover { color: var(--color-primary); border-color: var(--color-primary); }

/* 折叠思考块 —— 与正文分开渲染，是「思维链不进正文」的可见证据 */
.chat-timeline__thinking {
  align-self: flex-start; max-width: min(760px, 92%);
  border: 1px solid var(--color-border);
  border-left: 3px solid var(--color-warning);
  border-radius: var(--radius-md); background: var(--color-surface); font-size: var(--text-xs);
  box-shadow: var(--shadow-sm);
}
.chat-timeline__thinking-head {
  display: flex; align-items: center; gap: var(--space-2); padding: 6px 12px;
  cursor: pointer; color: var(--color-text-muted); list-style: none;
}
.chat-timeline__thinking-head:hover { color: var(--color-text); }
.chat-timeline__thinking-head::-webkit-details-marker { display: none; }
.chat-timeline__thinking-label { color: var(--color-text-muted); font-weight: 600; }
.chat-timeline__thinking-count { margin-left: auto; font-variant-numeric: tabular-nums; }
.chat-timeline__thinking-body {
  margin: 0; padding: 2px 12px 10px;
  white-space: pre-wrap; word-break: break-word; color: var(--color-text-muted); line-height: 1.6;
}

.chat-timeline__tool {
  align-self: flex-start; max-width: min(760px, 92%);
  display: flex; align-items: baseline; gap: var(--space-2); flex-wrap: wrap;
  padding: var(--space-2) var(--space-3); border: 1px solid var(--color-border);
  border-left: 3px solid var(--color-primary); border-radius: var(--radius-md);
  font-size: var(--text-xs); background: var(--color-surface);
  box-shadow: var(--shadow-sm);
}
.chat-timeline__tool--failed { border-left-color: var(--color-danger); }
.chat-timeline__tool--running { border-left-color: var(--color-warning); }
.chat-timeline__tool-name { font-weight: 600; color: var(--color-text); }
.chat-timeline__tool-args {
  color: var(--color-text-muted); font-family: var(--font-mono);
  max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.chat-timeline__tool-state { margin-left: auto; color: var(--color-text-muted); white-space: nowrap; }
.chat-timeline__tool-state--ok { color: var(--color-success); }
.chat-timeline__tool-state--err { color: var(--color-danger); }

.chat-timeline__meta {
  align-self: flex-start; display: flex; gap: var(--space-3);
  font-size: var(--text-xs); color: var(--color-text-muted);
}
.chat-timeline__meta-item.mono { font-family: var(--font-mono); }

.chat-timeline__failed {
  align-self: flex-start; display: flex; gap: var(--space-2);
  padding: var(--space-2) var(--space-3); border: 1px solid var(--color-danger);
  border-radius: var(--radius-md); background: var(--color-danger-soft);
  color: var(--color-danger); font-size: var(--text-xs);
}

/* 审批卡 */
.chat-timeline__approvals {
  flex: none; display: flex; flex-direction: column; gap: var(--space-2);
  padding: var(--space-2) var(--space-3); border-top: 1px solid var(--color-border);
  background: var(--color-surface); max-height: 40%; overflow-y: auto;
}
.chat-timeline__approval { border: 1px solid var(--color-warning); border-radius: var(--radius-md); padding: var(--space-2) var(--space-3); }
.chat-timeline__approval-head { display: flex; align-items: center; gap: var(--space-2); }
.chat-timeline__approval-tool { font-family: var(--font-mono); font-size: var(--text-xs); }
.chat-timeline__approval-risk { font-size: var(--text-xs); color: var(--color-text-muted); }
.chat-timeline__approval-body {
  margin: var(--space-2) 0; padding: var(--space-2); border-radius: var(--radius-sm);
  background: var(--color-surface-2); font-size: var(--text-xs);
  white-space: pre-wrap; word-break: break-all; max-height: 160px; overflow-y: auto;
}
.chat-timeline__approval-actions { display: flex; align-items: center; gap: var(--space-2); }
.chat-timeline__approval-remember { font-size: var(--text-xs); color: var(--color-text-muted); }
</style>
