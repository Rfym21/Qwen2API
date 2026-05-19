<template>
  <div class="dashboard-scroll w-100vw h-100vh p-4 overflow-y-auto">
    <div class="container mx-auto">
      <div class="flex flex-col md:flex-row justify-between items-start md:items-center mb-6 px-4 space-y-4 md:space-y-0 pt-5">
        <div class="flex items-center gap-3">
          <router-link
            to="/"
            class="action-button font-bold border border-gray-200 bg-white/60 text-gray-800 px-3 py-2 rounded-xl shadow-sm hover:bg-white/90 transition-all duration-300"
          >
            ← {{ t('stats.backToDashboard') }}
          </router-link>
          <h1 class="text-3xl md:text-4xl font-bold">{{ t('stats.title') }}</h1>
        </div>
        <LangSwitcher />
      </div>

      <div class="px-4 mb-6">
        <div class="inline-flex flex-wrap gap-2 bg-white/50 backdrop-blur-sm border border-white/40 rounded-2xl p-2 shadow">
          <button
            v-for="opt in periodOptions"
            :key="opt.value"
            @click="period = opt.value"
            :class="[
              'px-4 py-2 rounded-xl text-sm font-medium transition-all duration-200',
              period === opt.value
                ? 'bg-indigo-100 text-indigo-800 border border-indigo-300'
                : 'bg-transparent text-gray-700 hover:bg-white/70 border border-transparent'
            ]"
          >
            {{ opt.label }}
          </button>
        </div>
      </div>

      <div v-if="loading" class="text-center py-12 text-gray-500">
        <svg class="animate-spin h-6 w-6 mx-auto mb-2" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
          <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
          <path class="opacity-75" fill="currentColor" d="m4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
        </svg>
        {{ t('stats.loading') }}
      </div>

      <div v-else class="px-4">
        <StatsTotals :totals="aggregateTotals" :daily="aggregateDaily" />

        <div class="text-lg font-semibold mb-3">{{ t('stats.account.label') }}</div>
        <div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <StatsAccountCard
            v-for="acc in accounts"
            :key="acc.email"
            :account="acc"
            :range="dateRange"
          />
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import axios from 'axios'
import LangSwitcher from '../components/LangSwitcher.vue'
import StatsTotals from '../components/StatsTotals.vue'
import StatsAccountCard from '../components/StatsAccountCard.vue'

const { t } = useI18n()

const loading = ref(true)
const accounts = ref([])
// Server-side date — anchor for every period range. Paired with the
// _getYesterdayKey helper used by the archival routine; do not switch this
// to new Date() in the browser — differing browser/container TZs would
// shift month boundaries.
const serverToday = ref(new Date().toISOString().slice(0, 10))

const period = ref('currentMonth')
const periodOptions = computed(() => [
  { value: 'currentMonth', label: t('stats.filter.currentMonth') },
  { value: 'prevMonth', label: t('stats.filter.prevMonth') },
  { value: 'last90', label: t('stats.filter.last90') }
])

// Parse YYYY-MM-DD as a local date.
function parseDateKey(key) {
  const [y, m, d] = key.split('-').map(Number)
  return new Date(y, m - 1, d)
}
function formatDateKey(date) {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}
function daysInMonth(year, monthIndex0) {
  return new Date(year, monthIndex0 + 1, 0).getDate()
}

// dateRange — array of YYYY-MM-DD keys in chronological order, anchored to serverToday.
const dateRange = computed(() => {
  const today = parseDateKey(serverToday.value)
  const result = []
  if (period.value === 'last90') {
    for (let i = 89; i >= 0; i--) {
      const d = new Date(today)
      d.setDate(d.getDate() - i)
      result.push(formatDateKey(d))
    }
  } else if (period.value === 'currentMonth') {
    const year = today.getFullYear()
    const m0 = today.getMonth()
    const last = daysInMonth(year, m0)
    for (let day = 1; day <= last; day++) {
      result.push(formatDateKey(new Date(year, m0, day)))
    }
  } else if (period.value === 'prevMonth') {
    const prev = new Date(today.getFullYear(), today.getMonth() - 1, 1)
    const year = prev.getFullYear()
    const m0 = prev.getMonth()
    const last = daysInMonth(year, m0)
    for (let day = 1; day <= last; day++) {
      result.push(formatDateKey(new Date(year, m0, day)))
    }
  }
  return result
})

// Daily aggregate across all accounts — feeds the summary bar chart.
const aggregateDaily = computed(() => dateRange.value.map(date => {
  let chatInput = 0, chatOutput = 0, cliInput = 0, cliOutput = 0, cliCalls = 0
  for (const acc of accounts.value) {
    const entry = (acc.history || {})[date]
    if (!entry) continue
    const chat = entry.chat || {}
    const cli = entry.cli || {}
    chatInput += Number(chat.input) || 0
    chatOutput += Number(chat.output) || 0
    cliInput += Number(cli.input) || 0
    cliOutput += Number(cli.output) || 0
    cliCalls += Number(cli.calls) || 0
  }
  return { date, chatInput, chatOutput, cliInput, cliOutput, cliCalls }
}))

const aggregateTotals = computed(() => aggregateDaily.value.reduce((acc, d) => ({
  chatInput: acc.chatInput + d.chatInput,
  chatOutput: acc.chatOutput + d.chatOutput,
  cliInput: acc.cliInput + d.cliInput,
  cliOutput: acc.cliOutput + d.cliOutput,
  cliCalls: acc.cliCalls + d.cliCalls
}), { chatInput: 0, chatOutput: 0, cliInput: 0, cliOutput: 0, cliCalls: 0 }))

// Strictly validate `today` before using it to build dateRange — without this,
// a malformed '2026-13-99' would slip through new Date(y, m-1, d) (JS would
// roll the date over) and the UI would render the wrong window.
const DATE_KEY_REGEX = /^\d{4}-\d{2}-\d{2}$/

onMounted(async () => {
  try {
    const response = await axios.get('/api/statsHistory', {
      headers: { Authorization: localStorage.getItem('apiKey') || '' }
    })
    const apiToday = response.data?.today
    if (typeof apiToday === 'string' && DATE_KEY_REGEX.test(apiToday)) {
      serverToday.value = apiToday
    }
    accounts.value = response.data?.accounts || []
  } catch (error) {
    console.error('Failed to load statsHistory', error)
    alert(t('stats.loadFailed') + (error?.message || ''))
  } finally {
    loading.value = false
  }
})
</script>
