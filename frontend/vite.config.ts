import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'
import { frameworkGuide } from './vite-plugin-framework-guide.ts'

export default defineConfig({
  plugins: [react(), frameworkGuide(path.resolve(import.meta.dirname, '../docs/src'))],
  resolve: {
    alias: { '@': path.resolve(import.meta.dirname, './src') },
  },
  server: {
    proxy: {
      '/api': { target: 'http://localhost:3000', changeOrigin: true },
    },
  },
})
