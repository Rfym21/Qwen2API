import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

const proxyTarget = 'http://localhost:3000'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [vue()],
  server: {
    proxy: {
      '/verify': proxyTarget,
      '/api': proxyTarget,
      '/v1': proxyTarget,
    }
  }
})
