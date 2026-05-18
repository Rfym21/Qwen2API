<template>
  <svg
    :viewBox="`0 0 ${width} ${height}`"
    preserveAspectRatio="none"
    class="block w-full"
    :style="{ height: height + 'px' }"
    aria-hidden="true"
  >
    <polyline
      v-if="points"
      :points="points"
      fill="none"
      :stroke="color"
      stroke-width="1.5"
      stroke-linejoin="round"
      stroke-linecap="round"
    />
  </svg>
</template>

<script setup>
import { computed } from 'vue'

const props = defineProps({
  values: { type: Array, required: true },
  color: { type: String, default: '#6366f1' },
  height: { type: Number, default: 30 }
})

const width = 100

// Polyline built from normalized values. Skip when all zero or fewer than two points.
const points = computed(() => {
  const vals = Array.isArray(props.values) ? props.values : []
  if (vals.length < 2) return ''
  const max = Math.max(...vals)
  if (max <= 0) return ''
  const step = width / (vals.length - 1)
  return vals
    .map((v, i) => {
      const x = i * step
      const y = props.height - (Number(v) || 0) / max * props.height
      return `${x.toFixed(2)},${y.toFixed(2)}`
    })
    .join(' ')
})
</script>
