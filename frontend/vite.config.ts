import path from 'path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// When the browser uses same-origin /api (empty VITE_API_BASE_URL in dev), forward to the Go backend.
// In Docker dev, set CRONSENTINEL_DEV_API_PROXY=http://backend:8080 so the Vite container reaches the API.
const devApiProxyTarget =
  process.env.CRONSENTINEL_DEV_API_PROXY || 'http://127.0.0.1:8080'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    proxy: {
      '/api': { target: devApiProxyTarget, changeOrigin: true },
      '/healthz': { target: devApiProxyTarget, changeOrigin: true },
    },
  },
})
