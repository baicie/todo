# 跨平台 UI 复用策略

> 分析各平台框架的渲染差异，制定合理的复用层级，最大化开发效率。

---

## 1. 平台框架总览

| 平台 | 框架 | 渲染引擎 | 样式方案 | 路由方案 | 当前状态 |
|------|------|---------|---------|---------|---------|
| **Web** | React 19 + Vite | DOM | Tailwind CSS v4 | React Router v7 | 🟡 已完成 |
| **Browser Ext** | React 19 + Vite | DOM | Tailwind CSS v4 | Hash Router | 🔴 空壳 |
| **Miniprogram** | Taro 4 (React) | 各小程序 DSL / WebView | SASS + Taro UI | Taro Router | 🔴 空壳 |
| **Mobile** | Expo + React Native 0.85 | Native Views | StyleSheet | React Navigation | 🔴 空壳 |
| **Desktop** | Tauri 2 + React | WebView (Chromium) | Tailwind CSS v4 | React Router v7 | 🔴 空壳 |

---

## 2. 复用层级模型

复用按依赖深度分为四个层级，从底层到顶层依赖递减、复用收益递增：

```
┌─────────────────────────────────────────────────┐
│  Layer 4：UI 组件层                              │
│  TaskCard, StepItem, DatePicker, CategoryTag    │
│  ├─ Header, Sidebar, Layout (可直接复用)         │
│  └─ TaskDetailDrawer (需调整抽屉宽度)            │
├─────────────────────────────────────────────────┤
│  Layer 3：业务组合层                             │
│  TaskList, SmartListGroup, CreateTaskInput      │
│  (复用组合逻辑，样式/事件平台适配)               │
├─────────────────────────────────────────────────┤
│  Layer 2：Hooks / 状态层                         │
│  useTask, useList, useAuth, useStorage           │
│  (纯逻辑，无 DOM 依赖，完全跨平台复用)           │
├─────────────────────────────────────────────────┤
│  Layer 1：数据 / 类型层                          │
│  @repo/todo-model (存储抽象 + TypeScript 类型)   │
│  React Query (服务端状态 + 缓存)                 │
│  (完全跨平台复用)                                │
└─────────────────────────────────────────────────┘
```

### 2.1 各层级复用详情

#### Layer 1 — 数据 / 类型层（复用率 100%）

```typescript
// 任何平台都可以直接使用，无需任何适配
import { createLocalStorage, createRemoteStorage } from '@repo/todo-model';
import { Task, List, CreateTaskInput } from '@repo/todo-model';
```

**包含内容**：
- `packages/todo-model/src/types.ts` — 所有 TypeScript 类型定义
- `packages/todo-model/src/storage.ts` — 存储接口抽象
- `packages/todo-model/src/local/` — 本地存储实现
- `packages/todo-model/src/remote/` — 远程存储实现
- React Query 的 `QueryClient` 配置

#### Layer 2 — Hooks 层（复用率 100%）

```typescript
// 提取为独立包 packages/hooks
import { useTask, useTaskList, useCreateTask } from '@repo/hooks';
```

**包含内容**（待实现）：

| Hook | 职责 |
|------|------|
| `useStorage()` | 初始化 storage（根据配置切换 local/remote） |
| `useTask(params)` | 获取/筛选任务列表 |
| `useTaskDetail(id)` | 获取单个任务详情 |
| `useCreateTask()` | 创建任务的 mutation + 乐观更新 |
| `useUpdateTask()` | 更新任务的 mutation + 乐观更新 |
| `useDeleteTask()` | 删除任务的 mutation |
| `useTaskSteps(taskId)` | 获取任务的步骤列表 |
| `useList()` | 获取清单列表 |
| `useCreateList()` | 创建清单 |
| `useAuth()` | 认证状态管理 |

**实现要点**：Hooks 内部调用 `@repo/todo-model` 的接口，不涉及任何 DOM、路由或平台特定 API。

#### Layer 3 — 业务组合层（复用率 ~40%）

将多个 Layer 2 Hooks 组合，生成业务视图所需的数据结构。

**包含内容**：

| 组合组件 | 职责 |
|---------|------|
| `TaskListView` | 接收筛选参数，渲染任务列表，处理空状态 |
| `SmartListGroup` | 渲染「今日/重要/计划/任务」四个智能列表入口 |
| `CreateTaskInput` | 快捷创建任务输入框（回车提交） |
| `TaskBatchActions` | 批量操作栏（移动/删除/标记完成） |

**平台差异**：这类组件的组合逻辑可复用，但涉及的样式绑定、事件名称（`onClick` vs `onTap`）、触摸反馈需要适配。

#### Layer 4 — UI 组件层（复用率 ~30-80%，取决于平台）

| 组件 | Web | Browser Ext | Miniprogram | Mobile | Desktop |
|------|-----|-------------|-------------|--------|---------|
| `Button` | ✅ | ✅ | ⚠️ 需 Taro 化 | ⚠️ | ✅ |
| `Input` | ✅ | ✅ | ⚠️ 需 Taro 化 | ⚠️ | ✅ |
| `Drawer` | ✅ | ✅ | ⚠️ 需 Taro 化 | ⚠️ | ✅ |
| `DatePicker` | ✅ | ✅ | ⚠️ 需 Taro 化 | ⚠️ | ✅ |
| `Checkbox` | ✅ | ✅ | ⚠️ | ⚠️ | ✅ |
| `IconButton` | ✅ | ✅ | ⚠️ | ⚠️ | ✅ |
| `Header` | ✅ | ✅ | 🔴 重写 | 🔴 重写 | ✅ |
| `Sidebar` | ✅ | ✅ | 🔴 重写 | 🔴 重写 | ✅ |
| `Layout` | ✅ | ✅ | 🔴 重写 | 🔴 重写 | ✅ |
| `MainContent` | ✅ | ✅ | 🔴 重写 | 🔴 重写 | ✅ |
| `TaskDetailDrawer` | ✅ | ✅ | 🔴 重写 | 🔴 重写 | ✅ |

> ⚠️ = 样式/事件适配后可用，🔴 = 需重写

---

## 3. 平台对标分析

### 3.1 Web ↔ Browser Ext（复用率 80%）

**可行性：非常高**

两者都是 React 19 + DOM + Tailwind CSS，差异极小。

| 差异点 | Web | Browser Ext | 解决方案 |
|--------|-----|-------------|---------|
| 入口 | `index.html` | `manifest.json` + `background.ts` | 各有独立入口 |
| 认证存储 | `localStorage` | `chrome.storage.local` | `IAuthStorage` 接口隔离 |
| HTTP 请求 | 直接 `fetch/axios` | `chrome.runtime.sendMessage` | API client 抽象 |
| 离线支持 | Service Worker | 内置（Background Script） | 共享 worker 逻辑 |
| 部署方式 | CDN / Vercel | Chrome Web Store | — |
| 窗口模型 | 浏览器窗口 | Popup / Panel / Tab | 布局组件条件渲染 |

**复用策略**：

```
browser-ext/
├── manifest.json              # Manifest V3 配置
├── background.ts             # Service Worker（消息路由）
├── popup/
│   ├── main.tsx              # Popup 入口（复用自己的 main.tsx）
│   └── App.tsx              # 复用 web 的 App + Layout
├── content-script/
│   └── injection.tsx        # 注入页面的脚本（可选）
└── adapter/
    ├── auth-adapter.ts      # chrome.storage → AuthStorage 适配
    └── api-adapter.ts       # chrome.runtime → Axios 适配
```

Browser Ext 可以直接将 `apps/web/src/` 中的以下文件作为依赖引用：

- `components/Layout.tsx` — 布局骨架（抽屉宽度调整为 100vw/100vh）
- `components/Header.tsx` — 顶部栏（搜索栏可能需要简化）
- `components/Sidebar.tsx` — 侧边栏（移动端抽屉模式）
- `components/MainContent.tsx` — 任务列表（直接复用）
- `components/TaskDetailDrawer.tsx` — 任务详情（直接复用）
- `components/SettingsDrawer.tsx` — 设置面板（直接复用）
- `pages/Login.tsx` — 登录页（Popup 模式下可简化）
- `pages/Register.tsx` — 注册页

**改造步骤**：

1. 将 `apps/web/src/contexts/AuthContext.tsx` 中的 `localStorage` 访问替换为 `@repo/todo-model` 的 `IAuthStorage` 接口
2. 将 `apps/web/src/lib/api.ts` 中的 `axios` 实例替换为适配器（local 模式直接用 axios，ext 模式用 chrome.runtime）
3. Browser Ext 入口使用 React 18（Manifest V3 要求），需降级 React 版本或确认兼容性

### 3.2 Web ↔ Miniprogram / Mobile（复用率 30%）

**可行性：中等（通过 Taro）**

Taro 4 支持 React 19 语法，Miniprogram 可以通过 Taro 编译通道复用部分代码。但约束极多：

| 约束项 | 说明 | 影响 |
|--------|------|------|
| Tailwind CSS | Taro 不支持 | 全部样式需改写为 SASS / Taro UI |
| Framer Motion | 不支持 | 动画需用 `react-native-reanimated` 重写 |
| `document` / `window` | 不可用 | 所有 DOM 操作需替换 |
| CSS 变量主题 | 不支持 | 主题系统需改用 JS 变量注入 |
| React Router | 不支持 | 需改用 Taro Router |
| 部分 npm 包 | 依赖 DOM 的包不可用 | Axios 需替换为 Taro 请求 |
| 组件事件 | `onClick` → `onTap` | 事件名需适配 |
| 滚动 | `overflow: auto` → ScrollView | 滚动容器需替换 |

**Taro 编译的实际复用范围**：

```
packages/
├── todo-model/           ✅ 完全复用（无 DOM 依赖）
├── ui/                   ⚠️ 原子组件可复用（需 Taro 化）
└── hooks/                ✅ 完全复用（纯逻辑）

apps/web/src/
├── components/          🔴 页面级组件无法复用
│   ├── Layout.tsx
│   ├── MainContent.tsx
│   └── ...
└── lib/                 ⚠️ 需替换 API 层
    ├── api.ts            # Axios → Taro.request
    └── queryClient.ts    # 替换为 Taro Query 适配

apps/miniprogram/src/    🔴 完全重写（但调用相同的 hooks）
    ├── pages/
    │   └── tasks/
    │       └── index.tsx  # 调用 useTask() hook
    └── components/        # 适配后的组件
```

**改造建议**：

1. 创建 `packages/hooks` 提取所有业务逻辑 Hooks（Layer 2）
2. 各端 `pages/` 目录作为入口层，调用 Layer 2 Hooks 获取数据
3. UI 组件（Layer 4）各端独立实现，但设计保持一致
4. 样式采用 Design Token 方案（CSS 变量 → JS Token 对象），各端用自己的方式注入

### 3.3 Web ↔ Desktop（复用率 90%）

**可行性：非常高**

Tauri 2 的 WebView 基于 Chromium，完整支持 DOM、Tailwind CSS、React Router。Desktop 端复用 Web 代码几乎无障碍。

**差异点**：

| 差异 | Web | Desktop | 解决方案 |
|------|-----|---------|---------|
| HTTP | `fetch` / `axios` | 同左 | 无差异 |
| 认证存储 | `localStorage` | 同左 | 无差异 |
| 窗口尺寸 | 响应式 | 固定窗口 | 布局组件已处理 |
| Rust 能力 | 无 | 文件系统、系统托盘 | 通过 Tauri commands 按需调用 |
| 离线运行 | PWA | 内置 | 无需改动 |
| 构建产物 | HTML/JS/CSS | `.dmg` / `.exe` | 不同构建命令 |

**复用策略**：

```
apps/desktop/
├── src-tauri/             # Rust 层（Tauri 2）
│   ├── src/
│   │   ├── lib.rs         # 插件注册
│   │   └── commands/      # Tauri commands（未来扩展）
│   └── tauri.conf.json
└── src/                   # 直接复用 web app 源码
    ├── main.tsx           # 替换为 Tauri 入口
    ├── App.tsx            # 复用（路由不变）
    ├── components/        # 直接复用
    ├── contexts/          # 需替换认证层（见下）
    ├── pages/             # 直接复用
    └── lib/
        └── api.ts         # 可选：添加 Tauri command 调用
```

**关键改造点**：

1. **入口替换**：`main.tsx` 改为 Tauri 提供的 `app.listen()` 入口
2. **认证存储**：将 `localStorage` 改为 `@repo/todo-model` 的 `IAuthStorage` 接口
3. **窗口配置**：`tauri.conf.json` 中配置窗口尺寸、标题、菜单
4. **构建命令**：`vite build` → Tauri CLI `tauri build`

其余 UI 组件（Layout、Sidebar、MainContent 等）**可直接复用**。

---

## 4. 推荐实现路径

### 4.1 第一步：提取 Hooks 包（Layer 2）

```
packages/hooks/src/
├── useStorage.ts         # 初始化 storage 实例
├── useTask.ts            # 任务 CRUD + 查询
├── useList.ts            # 清单 CRUD
├── useAuth.ts            # 认证状态
└── index.ts
```

这一层完全不涉及 DOM，可在所有平台复用。

### 4.2 第二步：扩展 UI 包（Layer 4 原子组件）

```
packages/ui/src/
├── button/
│   ├── Button.tsx
│   └── index.ts
├── input/
│   ├── Input.tsx
│   └── index.ts
├── drawer/
│   ├── Drawer.tsx        # 支持 web/ext/desktop
│   ├── DrawerMobile.tsx  # RN/Taro 版本
│   └── index.ts
├── date-picker/
│   ├── DatePicker.tsx
│   ├── DatePickerMobile.tsx
│   └── index.ts
└── ...
```

原子组件（Button、Input、Select 等）样式简单，平台差异小，可封装为条件导出：

```typescript
// packages/ui/src/drawer/index.ts
export { Drawer as DrawerWeb } from './Drawer';
export { DrawerMobile as Drawer } from './DrawerMobile';
```

### 4.3 第三步：平台入口层（Layer 3 + Layer 4 页面）

```
apps/
├── web/src/              # 完整实现（参考实现）
│   ├── components/       # Layer 4 组合组件（直接复用）
│   ├── contexts/         # AuthContext → 替换为 useAuth()
│   └── pages/            # 页面入口
│
├── browser-ext/          # 90% 复用 web/src
│   └── src/
│       ├── popup/        # 入口 + 布局（复用 web）
│       └── adapter/      # storage 适配器
│
├── desktop/              # 95% 复用 web/src
│   ├── src/             # 入口 + 布局（复用 web）
│   └── src-tauri/       # Rust commands
│
├── miniprogram/          # 30% 复用（Layer 1 + Layer 2）
│   └── src/
│       ├── pages/        # 各端独立页面，调用 hooks
│       └── components/   # 各端独立组件
│
└── mobile/               # 30% 复用（Layer 1 + Layer 2）
    └── src/
        ├── screens/      # 各端独立页面，调用 hooks
        └── components/   # 各端独立组件
```

### 4.4 第四步：Design Token 统一设计语言

为确保各平台 UI 视觉一致，定义 Design Token：

```typescript
// packages/design-tokens/src/index.ts
export const tokens = {
  color: {
    primary: '#3b82f6',
    success: '#22c55e',
    warning: '#f59e0b',
    danger: '#ef4444',
    background: '#f8fafc',
    text: '#111827',
    textSecondary: '#6b7280',
  },
  spacing: {
    xs: '0.25rem',
    sm: '0.5rem',
    md: '1rem',
    lg: '1.5rem',
    xl: '2rem',
  },
  radius: {
    sm: '0.25rem',
    md: '0.5rem',
    lg: '0.75rem',
    full: '9999px',
  },
  shadow: {
    sm: '0 1px 2px rgba(0,0,0,0.05)',
    md: '0 4px 6px rgba(0,0,0,0.1)',
    lg: '0 10px 15px rgba(0,0,0,0.1)',
  },
};
```

| 平台 | Tailwind 方案 | Taro/CSS-in-JS 方案 |
|------|-------------|-------------------|
| Web | `@apply text-primary bg-primary` | JSX inline styles from tokens |
| Browser Ext | 同 Web | 同上 |
| Desktop | 同 Web | 同上 |
| Miniprogram | — | `taro-ui` + SASS 变量 |
| Mobile | — | `taro-ui` + StyleSheet |

---

## 5. 结论

| 平台 | 推荐策略 | 预期复用率 | 核心工作 |
|------|---------|-----------|---------|
| **Browser Ext** | 直接引用 web 组件 + 替换存储层 | **80%** | 替换 `IAuthStorage` 实现为 `chrome.storage` |
| **Desktop** | 直接引用 web 组件 + Tauri 入口 | **95%** | 配置 `tauri.conf.json` + 替换入口 |
| **Miniprogram** | Layer 1+2 复用，Layer 3+4 重写 | **30%** | 实现 Taro 适配层（样式/路由/事件） |
| **Mobile** | Layer 1+2 复用，Layer 3+4 重写 | **30%** | 实现 RN 适配层（Native Views/动画） |

**执行优先级**：

1. **Browser Ext + Desktop** — 复用收益最高，优先完成
2. **提取 `packages/hooks`** — 为后续 Taro/RN 打好基础
3. **Miniprogram + Mobile** — 基于 hooks 实现各端适配层

---

*文档版本：v0.1.0 | 最后更新：2026-04-21*
