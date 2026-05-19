<template>
  <div class="bg-white/40 backdrop-blur-md border border-white/30 rounded-2xl shadow-md p-4">
    <div class="flex flex-col md:flex-row md:items-center md:justify-between gap-2 mb-3">
      <div class="font-semibold text-gray-800 break-all">{{ account.email }}</div>
      <div class="flex flex-wrap gap-2 text-xs">
        <span class="px-2 py-1 rounded-lg bg-indigo-50 border border-indigo-100 text-indigo-700" :title="String(totals.chatInput)">
          {{ t('stats.totals.chatInput') }}: {{ formatCompact(totals.chatInput, fmtUnits) }}
        </span>
        <span class="px-2 py-1 rounded-lg bg-emerald-50 border border-emerald-100 text-emerald-700" :title="String(totals.chatOutput)">
          {{ t('stats.totals.chatOutput') }}: {{ formatCompact(totals.chatOutput, fmtUnits) }}
        </span>
        <span class="px-2 py-1 rounded-lg bg-indigo-50 border border-indigo-100 text-indigo-700" :title="String(totals.cliInput)">
          {{ t('stats.totals.cliInput') }}: {{ formatCompact(totals.cliInput, fmtUnits) }}
        </span>
        <span class="px-2 py-1 rounded-lg bg-emerald-50 border border-emerald-100 text-emerald-700" :title="String(totals.cliOutput)">
          {{ t('stats.totals.cliOutput') }}: {{ formatCompact(totals.cliOutput, fmtUnits) }}
        </span>
        <span class="px-2 py-1 rounded-lg bg-amber-50 border border-amber-100 text-amber-700" :title="String(totals.cliCalls)">
          {{ t('stats.totals.cliCalls') }}: {{ formatCompact(totals.cliCalls, fmtUnits) }}
        </span>
      </div>
    </div>

    <div v-if="hasData" class="grid grid-cols-1 md:grid-cols-2 gap-2">
      <div class="bg-white/60 rounded-lg p-2">
        <div class="text-xs text-gray-600 mb-1">{{ t('stats.chart.input') }}</div>
        <SvgSparkline :values="inputs" color="#6366f1" />
      </div>
      <div class="bg-white/60 rounded-lg p-2">
        <div class="text-xs text-gray-600 mb-1">{{ t('stats.chart.output') }}</div>
        <SvgSparkline :values="outputs" color="#10b981" />
      </div>
    </div>
    <div v-else class="text-center text-gray-400 text-sm py-3">{{ t('stats.account.noData') }}</div>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import SvgSparkline from './SvgSparkline.vue'
import { formatCompact } from '../utils/format.js'

const props = defineProps({
  account: { type: Object, required: true }, // { email, history }
  range: { type: Array, required: true }     // ['YYYY-MM-DD', ...] in chronological order
})

const { t } = useI18n()

const fmtUnits = computed(() => ({
  unitK: t('dash.acct.unitK'),
  unitM: t('dash.acct.unitM')
}))

const days = computed(() => {
  const history = props.account.history || {}
  return props.range.map(date => {
    const entry = history[date] || { chat: {}, cli: {} }
    const chat = entry.chat || {}
    const cli = entry.cli || {}
    return {
      date,
      chatInput: Number(chat.input) || 0,
      chatOutput: Number(chat.output) || 0,
      cliInput: Number(cli.input) || 0,
      cliOutput: Number(cli.output) || 0,
      cliCalls: Number(cli.calls) || 0
    }
  })
})

const totals = computed(() => days.value.reduce((acc, d) => ({
  chatInput: acc.chatInput + d.chatInput,
  chatOutput: acc.chatOutput + d.chatOutput,
  cliInput: acc.cliInput + d.cliInput,
  cliOutput: acc.cliOutput + d.cliOutput,
  cliCalls: acc.cliCalls + d.cliCalls
}), { chatInput: 0, chatOutput: 0, cliInput: 0, cliOutput: 0, cliCalls: 0 }))

const inputs = computed(() => days.value.map(d => d.chatInput + d.cliInput))
const outputs = computed(() => days.value.map(d => d.chatOutput + d.cliOutput))

const hasData = computed(() => inputs.value.some(v => v > 0) || outputs.value.some(v => v > 0))
</script>
