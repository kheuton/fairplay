import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
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
});
