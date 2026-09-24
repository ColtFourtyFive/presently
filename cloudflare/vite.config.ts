import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [react()],
  resolve: { dedupe: ['react', 'react-dom'] },
  // Shipped builds are minified and carry no source maps.
  build: { outDir: 'dist/client', emptyOutDir: true, sourcemap: false, minify: true },
  server: { port: 5174, proxy: { '/api': 'http://127.0.0.1:8787', '/cdn-cgi': 'http://127.0.0.1:8787' } },
});
