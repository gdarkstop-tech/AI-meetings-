import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://127.0.0.1:4000', changeOrigin: false },
      '/health': { target: 'http://127.0.0.1:4000', changeOrigin: false },
      '/ready': { target: 'http://127.0.0.1:4000', changeOrigin: false },
    },
  },
  build: { outDir: 'dist', emptyOutDir: true },
});
