import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Dev: run core in another terminal (python main.py), then proxy /v1 and OpenAPI to it.
const apiTarget = process.env.VITE_API_PROXY ?? 'http://127.0.0.1:8787'

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/v1': { target: apiTarget, changeOrigin: true },
      '/openapi.json': { target: apiTarget, changeOrigin: true },
      '/docs': { target: apiTarget, changeOrigin: true },
      '/redoc': { target: apiTarget, changeOrigin: true },
    },
  },
})
