<template>
  <div class="inline-flex items-stretch bg-white/60 backdrop-blur-sm border border-gray-200 rounded-xl shadow-sm overflow-hidden">
    <button
      v-for="(code, i) in availableLocales"
      :key="code"
      @click="setLocale(code)"
      :class="[
        'flex items-center justify-center px-2.5 py-1.5 transition-colors duration-200',
        locale === code
          ? 'bg-indigo-100'
          : 'hover:bg-white/80'
      ]"
      :title="code"
      :aria-label="code"
      :aria-pressed="locale === code">
      {{ code }}
    </button>
  </div>
</template>

<script setup>
import { useI18n } from 'vue-i18n'

const { locale, availableLocales } = useI18n()

const setLocale = (code) => {
  locale.value = code
  localStorage.setItem('locale', code)
}
</script>
