import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { resolve } from 'node:path';
import { VitePWA } from 'vite-plugin-pwa';

const pwaConfig = VitePWA({
  registerType: 'autoUpdate',
  includeAssets: ['icons/*.svg', 'favicon.svg'],
  manifest: {
    name: 'Orbit',
    short_name: 'Orbit',
    description: '跨平台 Todo 应用，一套代码，多端运行',
    start_url: '/',
    display: 'standalone',
    orientation: 'portrait-primary',
    background_color: '#f8fafc',
    theme_color: '#3b82f6',
    scope: '/',
    lang: 'zh-CN',
    categories: ['productivity', 'utilities'],
    icons: [
      {
        src: '/icons/icon-192.svg',
        sizes: '192x192',
        type: 'image/svg+xml',
      },
      {
        src: '/icons/icon-512.svg',
        sizes: '512x512',
        type: 'image/svg+xml',
      },
      {
        src: '/icons/icon-512.svg',
        sizes: '512x512',
        type: 'image/svg+xml',
        purpose: 'any maskable',
      },
    ],
    shortcuts: [
      {
        name: '新建任务',
        short_name: '新建',
        description: '快速创建新任务',
        url: '/?action=new-task',
      },
      {
        name: '我的任务',
        short_name: '任务',
        description: '查看所有任务',
        url: '/tasks/tasks',
      },
    ],
  },
  workbox: {
    globPatterns: ['**/*.{js,css,html,ico,svg,png,woff2}'],
    runtimeCaching: [
      {
        urlPattern: /^https:\/\/fonts\.googleapis\.com\/.*/i,
        handler: 'CacheFirst',
        options: {
          cacheName: 'google-fonts-cache',
          expiration: {
            maxEntries: 10,
            maxAgeSeconds: 60 * 60 * 24 * 365,
          },
          cacheableResponse: {
            statuses: [0, 200],
          },
        },
      },
      {
        urlPattern: /^https:\/\/fonts\.gstatic\.com\/.*/i,
        handler: 'CacheFirst',
        options: {
          cacheName: 'gstatic-fonts-cache',
          expiration: {
            maxEntries: 10,
            maxAgeSeconds: 60 * 60 * 24 * 365,
          },
          cacheableResponse: {
            statuses: [0, 200],
          },
        },
      },
    ],
  },
  devOptions: {
    enabled: true,
  },
});

export default defineConfig({
  plugins: [react(), tailwindcss(), pwaConfig],
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
  build: {
    chunkSizeWarningLimit: 600,
    rollupOptions: {
      output: {
        manualChunks: (id) => {
          if (id.includes('node_modules')) {
            if (id.includes('@tanstack')) {
              return 'vendor-tanstack';
            }
            if (id.includes('lucide-react')) {
              return 'vendor-icons';
            }
            if (id.includes('framer-motion')) {
              return 'vendor-animation';
            }
            if (id.includes('i18next') || id.includes('react-i18next')) {
              return 'vendor-i18n';
            }
            if (id.includes('react-router') || id.includes('react-router-dom')) {
              return 'vendor-router';
            }
            if (id.includes('dexie')) {
              return 'vendor-db';
            }
            if (id.includes('axios') || id.includes('workbox')) {
              return 'vendor-misc';
            }
          }
        },
      },
    },
  },
});
