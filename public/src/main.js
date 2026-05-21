import { createApp } from 'vue'
import { createI18n } from 'vue-i18n'
import router from './routes/index.js'
import App from './App.vue'
import en from './locales/en.json'
import ru from './locales/ru.json'
import zh from './locales/zh.json'
import "./style.css"

const messages = { zh, en, ru },
  fallbackLocale = 'zh'

const detectLocale = () => {
  const stored = localStorage.getItem('locale');

  if (stored in messages) {
    return stored;
  }

  const full = navigator.language;
  const code = full.split('-')[0];

  return code in messages ? code : fallbackLocale;
}

const i18n = createI18n({
  locale: detectLocale(),
  fallbackLocale,
  messages,
  globalInjection: true
})

createApp(App)
  .use(i18n)
  .use(router)
  .mount('#app')
