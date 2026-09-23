import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
      // Build the web app from the shared SOURCE: the bundle never depends on packages/shared/dist being built first.
      '@hr/shared': path.resolve(__dirname, '../../packages/shared/src/index.ts'),
    },
  },
  server: {
    port: 5173,
    // Same-origin API in dev → cookies work without CORS; production can use a reverse proxy the same way.
    proxy: { '/api': { target: 'http://localhost:4000', changeOrigin: true } },
  },
});
