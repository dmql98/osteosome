<template>
  <span
    class="ui-status-dot"
    :class="[`ui-status-dot--${motion}`, { 'ui-status-dot--pulse': pulsing }]"
    :style="style"
    role="status"
    :aria-label="label ?? MOTION_LABEL[motion]"
    :title="label ?? MOTION_LABEL[motion]"
  />
</template>

<script setup lang="ts">
/**
 * 运行态圆点（P4b 会话列表重设计 §4）。
 *
 * ## 它是纯展示组件
 *
 * 「哪个会话处于什么 motion」是**视图层从 `loop.*` 事件投影出来的判断**，
 * 本组件只负责把它画成一个 7px 圆点。组件不知道也不该知道 loop 事件 —— 那是插件视图的事。
 *
 * ## 颜色走 `--motion-*` 令牌，不硬编码
 *
 * 六个 motion 各有深浅两套取值（见 tokens.css）。直接写十六进制（天枢侧栏现状：
 * `#d59b2d` / `#4f80c9` / `#6f5acb`）在深色主题下会糊掉 —— 这正是 tokens-parity 想防的事。
 *
 * ## 脉动是最贵的通道
 *
 * 满屏都在闪等于什么都没说。所以脉动频率编码紧急度：speaking 最快（正文正在滚）、
 * working 次之（工具在跑）、thinking/listening 最慢（在等）；success/error/idle **不脉动**。
 * 所有动画只改 transform/opacity（不动 layout），并被 `prefers-reduced-motion` 全局关掉。
 */
import { computed } from 'vue'
import { MOTION_LABEL, PULSING_MOTIONS, type MotionState } from '../motion'

const props = withDefaults(
  defineProps<{
    motion?: MotionState
    /** 直径 px（子会话缩到 5，当前会话行用 7） */
    size?: number
    /** 无障碍/悬停文案（缺省按 motion 给中文） */
    label?: string
  }>(),
  { motion: 'idle', size: 7, label: undefined },
)

const pulsing = computed(() => PULSING_MOTIONS.includes(props.motion))
const style = computed(() => ({ width: `${props.size}px`, height: `${props.size}px` }))
</script>

<style scoped>
.ui-status-dot {
  display: inline-block;
  flex: none;
  border-radius: var(--radius-full);
  background: var(--motion-idle);
  box-shadow: 0 0 0 1px rgba(127, 127, 127, 0.18);
}

.ui-status-dot--idle { background: var(--motion-idle); }
.ui-status-dot--thinking { background: var(--motion-thinking); animation: ui-dot-pulse 1.1s ease-in-out infinite; }
.ui-status-dot--listening { background: var(--motion-listening); animation: ui-dot-pulse 1.1s ease-in-out infinite; }
.ui-status-dot--working { background: var(--motion-working); animation: ui-dot-pulse 0.7s ease-in-out infinite; }
.ui-status-dot--speaking { background: var(--motion-speaking); animation: ui-dot-pulse 0.45s ease-in-out infinite; }
.ui-status-dot--success { background: var(--motion-success); }
.ui-status-dot--error { background: var(--motion-error); }

@keyframes ui-dot-pulse {
  50% { transform: scale(0.5); opacity: 0.45; }
}

@media (prefers-reduced-motion: reduce) {
  .ui-status-dot { animation: none !important; }
}
</style>
