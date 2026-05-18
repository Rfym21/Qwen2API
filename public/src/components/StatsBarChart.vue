<template>
  <Bar :data="chartData" :options="chartOptions" />
</template>

<script setup>
import { computed } from 'vue'
import { Bar } from 'vue-chartjs'
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  BarElement,
  Tooltip,
  Legend
} from 'chart.js'

ChartJS.register(CategoryScale, LinearScale, BarElement, Tooltip, Legend)

const props = defineProps({
  labels: { type: Array, required: true },
  inputs: { type: Array, required: true },
  outputs: { type: Array, required: true },
  inputLabel: { type: String, default: 'Input' },
  outputLabel: { type: String, default: 'Output' }
})

const chartData = computed(() => ({
  labels: props.labels,
  datasets: [
    {
      label: props.inputLabel,
      data: props.inputs,
      backgroundColor: 'rgba(99, 102, 241, 0.7)',
      borderColor: 'rgba(99, 102, 241, 1)',
      borderWidth: 1
    },
    {
      label: props.outputLabel,
      data: props.outputs,
      backgroundColor: 'rgba(16, 185, 129, 0.7)',
      borderColor: 'rgba(16, 185, 129, 1)',
      borderWidth: 1
    }
  ]
}))

const chartOptions = {
  responsive: true,
  maintainAspectRatio: false,
  plugins: {
    legend: { position: 'top' },
    tooltip: { mode: 'index', intersect: false }
  },
  scales: {
    x: { stacked: false, ticks: { maxRotation: 0, autoSkip: true, maxTicksLimit: 12 } },
    y: { stacked: false, beginAtZero: true }
  }
}
</script>
