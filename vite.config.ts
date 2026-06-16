import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Project site is served from https://kheuton.github.io/fairplay/, so the
// production build needs a '/fairplay/' base for asset URLs. Dev & preview stay
// at root so the local dev server keeps working at http://localhost:5173/.
export default defineConfig(({ mode }) => ({
  base: mode === 'production' ? '/fairplay/' : '/',
  plugins: [react()],
  server: {
    proxy: {
      '/todoist-api': {
        target: 'https://api.todoist.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/todoist-api/, ''),
      },
    },
  },
  preview: {
    proxy: {
      '/todoist-api': {
        target: 'https://api.todoist.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/todoist-api/, ''),
      },
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
}));
