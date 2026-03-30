import { defineConfig } from 'vite';
import path from 'path';

export default defineConfig({
  root: 'public',
  resolve: {
    alias: {
      '@shared': path.resolve(__dirname, 'shared'),
    },
  },
  build: {
    outDir: '../dist/client',
    emptyOutDir: true,
  },
  server: {
    proxy: {
      '/api': 'http://localhost:3000',
    },
  },
});
