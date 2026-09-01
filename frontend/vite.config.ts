import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'
import { algoGuide } from './vite-plugin-algo-guide'

export default defineConfig({
  plugins: [react(), algoGuide(path.resolve(__dirname, '../docs/src'))],
  resolve: {
    alias: { '@': path.resolve(__dirname, './src') },
  },
  server: {
    proxy: {
      '/api': { target: 'http://localhost:3000', changeOrigin: true },
    },
  },
})
