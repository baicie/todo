# PWA 配置

> Progressive Web App 的完整配置，包括 manifest、Service Worker、离线策略和安装提示。

---

## 1. PWA 概述

PWA 让 Web 应用拥有接近原生应用的体验：

| 特性 | 说明 |
|------|------|
| **可安装** | 用户可将应用"安装"到桌面/开始菜单 |
| **离线运行** | Service Worker 缓存资源，无网络也可使用 |
| **后台同步** | 离线操作在恢复网络后自动同步 |
| **推送通知** | 接收系统级推送通知（需 Web Push） |
| **快速加载** | App Shell 缓存确保秒开 |

---

## 2. Manifest 配置

### 2.1 manifest.json

```json
{
  "name": "UniTodo",
  "short_name": "UniTodo",
  "description": "跨平台 Todo 应用，一套代码，多端运行",
  "start_url": "/",
  "display": "standalone",
  "orientation": "portrait-primary",
  "background_color": "#f8fafc",
  "theme_color": "#3b82f6",
  "scope": "/",
  "lang": "zh-CN",
  "categories": ["productivity", "utilities"],
  "icons": [
    {
      "src": "/icons/icon-72.png",
      "sizes": "72x72",
      "type": "image/png"
    },
    {
      "src": "/icons/icon-96.png",
      "sizes": "96x96",
      "type": "image/png"
    },
    {
      "src": "/icons/icon-128.png",
      "sizes": "128x128",
      "type": "image/png"
    },
    {
      "src": "/icons/icon-144.png",
      "sizes": "144x144",
      "type": "image/png"
    },
    {
      "src": "/icons/icon-152.png",
      "sizes": "152x152",
      "type": "image/png"
    },
    {
      "src": "/icons/icon-192.png",
      "sizes": "192x192",
      "type": "image/png",
      "purpose": "any maskable"
    },
    {
      "src": "/icons/icon-384.png",
      "sizes": "384x384",
      "type": "image/png"
    },
    {
      "src": "/icons/icon-512.png",
      "sizes": "512x512",
      "type": "image/png",
      "purpose": "any maskable"
    }
  ],
  "shortcuts": [
    {
      "name": "新建任务",
      "short_name": "新建",
      "description": "快速创建新任务",
      "url": "/?action=new-task",
      "icons": [{ "src": "/icons/shortcut-new.png", "sizes": "96x96" }]
    },
    {
      "name": "我的任务",
      "short_name": "任务",
      "description": "查看所有任务",
      "url": "/tasks/tasks"
    }
  ],
  "screenshots": [
    {
      "src": "/screenshots/desktop.png",
      "sizes": "1280x720",
      "type": "image/png",
      "form_factor": "wide",
      "label": "桌面端视图"
    },
    {
      "src": "/screenshots/mobile.png",
      "sizes": "375x667",
      "type": "image/png",
      "form_factor": "narrow",
      "label": "移动端视图"
    }
  ],
  "related_applications": [],
  "prefer_related_applications": false
}
```

### 2.2 关键配置说明

| 字段 | 值 | 说明 |
|------|-----|------|
| `display` | `standalone` | 全屏运行，无浏览器地址栏和导航栏 |
| `orientation` | `portrait-primary` | 默认竖屏 |
| `theme_color` | `#3b82f6` | 顶部状态栏和地址栏颜色（Chrome 安卓） |
| `background_color` | `#f8fafc` | 启动画面背景色 |
| `start_url` | `/` | 点击图标打开的 URL |
| `shortcuts` | — | 右键图标显示的快捷操作 |

### 2.3 图标尺寸要求

| 尺寸 | 用途 | 是否必需 |
|------|------|---------|
| 72px | Windows 磁贴 | 建议 |
| 96px | PWA 快捷方式 | 建议 |
| 128px | Chrome 应用列表 | 建议 |
| 144px | Windows 任务栏 | 建议 |
| 152px | iPad | 建议 |
| 192px | Android 桌面 | 必需 |
| 384px | Android @2x | 建议 |
| 512px | Play Store / iOS | 必需 |

> 图标应使用 `purpose: "any maskable"`，允许平台裁剪为圆角/异形。

---

## 3. Service Worker

### 3.1 目录结构

```
apps/web/public/
├── sw.js                 # Service Worker 主文件
├── manifest.json         # PWA 清单
└── icons/               # 图标资源
```

### 3.2 Service Worker 实现

```javascript
// sw.js
const CACHE_NAME = 'unitodo-v1';
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
];

// 安装阶段：预缓存静态资源
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(STATIC_ASSETS);
    })
  );
  self.skipWaiting();
});

// 激活阶段：清理旧缓存
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames
          .filter((name) => name !== CACHE_NAME)
          .map((name) => caches.delete(name))
      );
    })
  );
  self.clients.claim();
});

// 请求拦截：Network First（API）/ Cache First（静态资源）
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // API 请求：Network First，失败时回退到缓存
  if (url.pathname.startsWith('/api')) {
    event.respondWith(networkFirst(request));
    return;
  }

  // 静态资源：Cache First，失败时回退到网络
  event.respondWith(cacheFirst(request));
});

async function networkFirst(request) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    const cached = await caches.match(request);
    return cached || new Response(JSON.stringify({ error: 'offline' }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;

  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    // 静态资源无法获取时，返回离线页面（如果是导航请求）
    if (request.mode === 'navigate') {
      return caches.match('/');
    }
    throw new Error('network unavailable');
  }
}
```

### 3.3 Service Worker 注册

```typescript
// main.tsx 或单独的文件
if ('serviceWorker' in navigator) {
  window.addEventListener('load', async () => {
    try {
      const registration = await navigator.serviceWorker.register('/sw.js');
      console.log('Service Worker registered:', registration.scope);

      // 检查更新
      registration.addEventListener('updatefound', () => {
        const newWorker = registration.installing;
        newWorker?.addEventListener('statechange', () => {
          if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
            // 有新版本可用，提示用户刷新
            showUpdatePrompt();
          }
        });
      });
    } catch (error) {
      console.error('Service Worker registration failed:', error);
    }
  });
}
```

---

## 4. 缓存策略

| 资源类型 | 策略 | 说明 |
|---------|------|------|
| HTML（App Shell） | Cache First | 确保离线可打开 |
| CSS / JS / Fonts | Stale-While-Revalidate | 快速加载，同时更新缓存 |
| API 请求 | Network First | 优先获取最新数据 |
| 图片资源 | Cache First + 容量限制 | 缓存图片，减少重复下载 |
| 用户上传的附件 | 不缓存 | 直接请求，节省缓存空间 |

### 4.1 IndexedDB 离线数据

Service Worker 管理的是**应用资源**的缓存，而**用户数据**（任务、清单）存储在 IndexedDB 中（通过 `@repo/todo-model`）。两者互补：

```
用户数据 → IndexedDB（通过 todo-model）
应用资源 → Service Worker Cache（通过 sw.js）
```

---

## 5. 安装提示（BeforeInstallPrompt）

### 5.1 检测安装条件

```typescript
// 检测是否可以触发安装
let deferredPrompt: BeforeInstallPromptEvent | null = null;

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPrompt = e;

  // 显示自定义安装按钮
  showInstallButton();
});

window.addEventListener('appinstalled', () => {
  deferredPrompt = null;
  hideInstallButton();
  console.log('PWA installed');
});
```

### 5.2 触发安装

```typescript
async function installPWA() {
  if (!deferredPrompt) return;

  deferredPrompt.prompt();
  const { outcome } = await deferredPrompt.userChoice;
  console.log(`User response: ${outcome}`);
  deferredPrompt = null;
}
```

### 5.3 安装按钮放置位置

- **Header 右上角**：常驻显示（当支持安装时）
- **Settings 页面**：在"关于"区域显示"安装应用"按钮

---

## 6. 离线状态 UI

当应用处于离线状态时，显示一个全局的离线指示器：

```
┌─────────────────────────────────────────────┐
│  📡 离线模式 — 更改将在恢复网络后同步         │
└─────────────────────────────────────────────┘
```

```typescript
function OfflineIndicator() {
  const [isOnline, setIsOnline] = useState(navigator.onLine);

  useEffect(() => {
    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  if (isOnline) return null;

  return (
    <div className="offline-indicator">
      📡 离线模式 — 更改将在恢复网络后同步
    </div>
  );
}
```

---

## 7. 后台同步（Background Sync）

当用户在离线状态下操作（如创建任务），将操作存入 IndexedDB 的 syncQueue 后，使用 Background Sync API 在网络恢复时自动同步：

```typescript
// sw.js
self.addEventListener('sync', (event) => {
  if (event.tag === 'sync-tasks') {
    event.waitUntil(syncTasks());
  }
});

// 前端触发同步
async function triggerBackgroundSync() {
  const registration = await navigator.serviceWorker.ready;
  await registration.sync.register('sync-tasks');
}

// IndexedDB 中的 syncQueue 由 syncTasks() 函数处理
async function syncTasks() {
  const db = await openDB('UniTodoDB');
  const pending = await db.getAll('syncQueue');

  for (const operation of pending) {
    try {
      await fetch(`/api/${operation.entityType}s`, {
        method: operation.operation === 'create' ? 'POST' :
               operation.operation === 'update' ? 'PATCH' : 'DELETE',
        body: JSON.stringify(operation.payload),
      });
      await db.delete('syncQueue', operation.id);
    } catch {
      // 同步失败，等待下次 sync 事件
      break;
    }
  }
}
```

> 注意：Background Sync API 需要 HTTPS 或 localhost 环境。

---

## 8. Vite PWA 插件（推荐）

使用 `vite-plugin-pwa` 自动化 PWA 配置：

```bash
pnpm add vite-plugin-pwa -w
```

```typescript
// vite.config.ts
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icons/*.png', 'screenshots/*.png'],
      manifest: { /* 同 manifest.json 配置 */ },
      workbox: {
        globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2}'],
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/api\./,
            handler: 'NetworkFirst',
            options: {
              cacheName: 'api-cache',
              networkTimeoutSeconds: 10,
            },
          },
          {
            urlPattern: /\.(?:png|jpg|jpeg|svg|gif|webp)$/,
            handler: 'CacheFirst',
            options: {
              cacheName: 'image-cache',
              expiration: { maxEntries: 100 },
            },
          },
        ],
      },
    }),
  ],
});
```

---

*文档版本：v0.1.0 | 最后更新：2026-04-21*
