import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [react()],
  resolve: { dedupe: ['react', 'react-dom'] },
  build: { outDir: 'dist/client', emptyOutDir: true },
  server: { port: 5174, proxy: { '/api': 'http://127.0.0.1:8787', '/cdn-cgi': 'http://127.0.0.1:8787' } },
});
