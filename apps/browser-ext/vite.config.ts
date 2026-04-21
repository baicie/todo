import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';
import { readFileSync, writeFileSync } from 'fs';

function chromeExtension() {
  return {
    name: 'chrome-extension',
    closeBundle() {
      const manifest = JSON.parse(readFileSync('manifest.json', 'utf-8'));
      writeFileSync('dist/manifest.json', JSON.stringify(manifest, null, 2));
    },
  };
}

export default defineConfig({
  plugins: [react(), chromeExtension()],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
      '@baicie/orbit': resolve(__dirname, '../../packages/todo-model/src'),
      '@baicie/orbit-ui': resolve(__dirname, '../../packages/ui/src'),
      '@baicie/orbit-hooks': resolve(__dirname, '../../packages/hooks/src'),
      '@baicie/orbit-utils': resolve(__dirname, '../../packages/utils/src'),
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        popup: resolve(__dirname, 'popup.html'),
        background: resolve(__dirname, 'src/background/index.ts'),
        content: resolve(__dirname, 'src/content/index.ts'),
      },
      output: {
        entryFileNames: '[name].js',
        chunkFileNames: 'chunks/[name]-[hash].js',
        assetFileNames: '[name].[ext]',
        format: 'es',
      },
    },
  },
});
