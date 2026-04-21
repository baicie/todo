import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { resolve } from 'node:path';

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 3000,
  },
  resolve: {
    alias: {
      '@baicie/orbit': resolve(__dirname, '../../packages/todo-model/src'),
      '@baicie/orbit-ui': resolve(__dirname, '../../packages/ui/src'),
      '@baicie/orbit-hooks': resolve(__dirname, '../../packages/hooks/src'),
      '@baicie/orbit-utils': resolve(__dirname, '../../packages/utils/src'),
    },
  },
});
