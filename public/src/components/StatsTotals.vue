<template>
  <div class="bg-white/30 backdrop-blur-md border border-white/30 rounded-2xl shadow-xl p-6 mb-6">
    <h2 class="text-2xl font-bold mb-4">{{ t('stats.totals.label') }}</h2>

    <div class="grid grid-cols-2 md:grid-cols-5 gap-4 mb-6">
      <div class="bg-white/60 rounded-xl p-3 border border-indigo-100">
        <div class="text-xs text-gray-600">{{ t('stats.totals.chatInput') }}</div>
        <div class="text-2xl font-bold text-indigo-700" :title="String(totals.chatInput)">
          {{ formatCompact(totals.chatInput, fmtUnits) }}
        </div>
      </div>
      <div class="bg-white/60 rounded-xl p-3 border border-emerald-100">
        <div class="text-xs text-gray-600">{{ t('stats.totals.chatOutput') }}</div>
        <div class="text-2xl font-bold text-emerald-700" :title="String(totals.chatOutput)">
          {{ formatCompact(totals.chatOutput, fmtUnits) }}
        </div>
      </div>
      <div class="bg-white/60 rounded-xl p-3 border border-indigo-100">
        <div class="text-xs text-gray-600">{{ t('stats.totals.cliInput') }}</div>
        <div class="text-2xl font-bold text-indigo-700" :title="String(totals.cliInput)">
          {{ formatCompact(totals.cliInput, fmtUnits) }}
        </div>
      </div>
      <div class="bg-white/60 rounded-xl p-3 border border-emerald-100">
        <div class="text-xs text-gray-600">{{ t('stats.totals.cliOutput') }}</div>
        <div class="text-2xl font-bold text-emerald-700" :title="String(totals.cliOutput)">
          {{ formatCompact(totals.cliOutput, fmtUnits) }}
        </div>
      </div>
      <div class="bg-white/60 rounded-xl p-3 border border-amber-100">
        <div class="text-xs text-gray-600">{{ t('stats.totals.cliCalls') }}</div>
        <div class="text-2xl font-bold text-amber-700" :title="String(totals.cliCalls)">
          {{ formatCompact(totals.cliCalls, fmtUnits) }}
        </div>
      </div>
    </div>

    <div v-if="hasData" class="h-64 md:h-72">
      <StatsBarChart
        :labels="labels"
        :inputs="inputs"
        :outputs="outputs"
        :input-label="t('stats.chart.input')"
        :output-label="t('stats.chart.output')"
      />
    </div>
    <div v-else class="text-center text-gray-500 py-8">{{ t('stats.account.noData') }}</div>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import StatsBarChart from './StatsBarChart.vue'
import { formatCompact } from '../utils/format.js'

const props = defineProps({
  totals: { type: Object, required: true },
  daily: { type: Array, required: true } // [{ date, chatInput, chatOutput, cliInput, cliOutput, cliCalls }]
})

const { t } = useI18n()

const fmtUnits = computed(() => ({
  unitK: t('dash.acct.unitK'),
  unitM: t('dash.acct.unitM')
}))

const labels = computed(() => props.daily.map(d => d.date))
const inputs = computed(() => props.daily.map(d => (d.chatInput || 0) + (d.cliInput || 0)))
const outputs = computed(() => props.daily.map(d => (d.chatOutput || 0) + (d.cliOutput || 0)))

const hasData = computed(() => inputs.value.some(v => v > 0) || outputs.value.some(v => v > 0))
</script>
