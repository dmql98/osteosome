<template>
  <span class="ui-badge" :class="toneClass">
    <slot />
  </span>
</template>

<script setup lang="ts">
/**
 * 徽章 / 药丸（P4b §11：`pill` 与状态标签）。
 *
 * 纯展示：内容走默认插槽，样式走 `variant` 或 `motion`。会话列表的「运行中 / 失败」
 * 小药丸、以及将来 tools 的风险徽章都归它，避免三处各自硬编码。
 *
 * `motion` 与 `variant` 二选一：给了 `motion` 就用对应的 `--motion-*` 描边/文字色
 * （与 StatusDot 同一套令牌），否则用 `variant` 的语义色。两者同时给时以 `motion` 为准。
 */
import { computed } from 'vue'
import type { MotionState } from '../motion'

type Variant = 'neutral' | 'primary' | 'success' | 'warning' | 'danger'

const props = withDefaults(
  defineProps<{
    variant?: Variant
    /** 用 `--motion-*` 上色（与 StatusDot 同一套令牌）；给了它就不加 variant 类 */
    motion?: MotionState
  }>(),
  { variant: 'neutral', motion: undefined },
)

const toneClass = computed(() =>
  props.motion ? `ui-badge--motion-${props.motion}` : `ui-badge--${props.variant}`,
)
</script>

<style scoped>
.ui-badge {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  padding: 1px 7px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-full);
  font-size: var(--text-xs);
  line-height: 1.5;
  color: var(--color-text-muted);
  white-space: nowrap;
}

.ui-badge--neutral { color: var(--color-text-muted); border-color: var(--color-border); }
.ui-badge--primary { color: var(--color-primary); border-color: var(--color-primary); background: var(--color-primary-soft); }
.ui-badge--success { color: var(--color-success); border-color: var(--color-success); }
.ui-badge--warning { color: var(--color-warning); border-color: var(--color-warning); }
.ui-badge--danger { color: var(--color-danger); border-color: var(--color-danger); background: var(--color-danger-soft); }

.ui-badge--motion-idle { color: var(--motion-idle); border-color: var(--motion-idle); }
.ui-badge--motion-thinking { color: var(--motion-thinking); border-color: var(--motion-thinking); }
.ui-badge--motion-listening { color: var(--motion-listening); border-color: var(--motion-listening); }
.ui-badge--motion-working { color: var(--motion-working); border-color: var(--motion-working); }
.ui-badge--motion-speaking { color: var(--motion-speaking); border-color: var(--motion-speaking); }
.ui-badge--motion-success { color: var(--motion-success); border-color: var(--motion-success); }
.ui-badge--motion-error { color: var(--motion-error); border-color: var(--motion-error); }
</style>
