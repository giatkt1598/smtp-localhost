import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  root: '.',
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': 'http://127.0.0.1:18025',
      '/v3': 'http://127.0.0.1:18025'
    }
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true
  }
});
