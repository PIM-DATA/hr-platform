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
    // Bind the IPv4 loopback explicitly: Vite's default resolved to [::1] only on this machine, so
    // http://127.0.0.1:5173 (and browsers that resolve localhost to IPv4 first) were refused.
    host: '127.0.0.1',
    // Same-origin API in dev → cookies work without CORS; production can use a reverse proxy the same way.
    proxy: { '/api': { target: 'http://localhost:4000', changeOrigin: true } },
  },
});
