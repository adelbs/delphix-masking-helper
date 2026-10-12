import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'
import { frameworkGuide } from './vite-plugin-framework-guide'

export default defineConfig({
  plugins: [react(), tailwindcss(), frameworkGuide(path.resolve(__dirname, '../docs/src'))],
  resolve: {
    alias: { '@': path.resolve(__dirname, './src') },
  },
  server: {
    proxy: {
      '/api': { target: 'http://localhost:3000', changeOrigin: true },
    },
  },
})
