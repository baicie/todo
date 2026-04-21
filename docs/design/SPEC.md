# UniTodo — 跨平台 Todo 应用设计文档

> 一套前端代码，部署于各平台；可配置远程后端持久化，也可纯本地运行。

---

## 1. 项目概述

### 1.1 项目背景

当前市场上主流 Todo 应用（如 Microsoft To Do、Todoist、TickTick）存在以下痛点：

- **数据主权缺失**：用户数据存储在服务商云端，无法离线使用或自行托管
- **跨平台体验割裂**：各平台客户端功能不一致，本地化存储与云端存储不可切换
- **扩展性受限**：无法对接私有后端或自定义业务逻辑

### 1.2 项目目标

构建一个**跨平台 Todo 应用**，具备以下特性：

| 目标 | 说明 |
|------|------|
| 跨平台渲染 | 同一套 UI 代码运行于 Web、Desktop (Tauri)、Mobile (React Native/Taro)、小程序、浏览器扩展 |
| 双模存储 | 通过 `@baicie/orbit` 的存储抽象层，可自由切换本地 (IndexedDB/localStorage) 和远程 (REST API) |
| 可部署 | 提供完整的 NestJS 后端，支持 Docker 一键部署 |
| 开源可控 | 数据存储位置由用户决定，可私有部署 |

### 1.3 参考竞品

- **Microsoft To Do**：智能列表（My Day/重要/计划/任务）、清单分组、步骤拆解、提醒重复
- **Notion**：块编辑、数据库视图、模板
- **Linear**：键盘优先、状态流、团队协作

本项目以 Microsoft To Do 为核心参考，融合轻量级块编辑和灵活的存储架构。

---

## 2. 系统架构

### 2.1 Monorepo 结构

```
todo/
├── apps/
│   ├── web/              # React + Vite Web 应用
│   ├── backend/          # NestJS REST API 后端
│   ├── desktop/          # Tauri 桌面应用
│   ├── mobile/           # React Native 移动应用
│   ├── miniprogram/      # Taro 多端小程序
│   └── browser-ext/      # 浏览器扩展
├── packages/
│   ├── todo-model/       # 核心数据模型 + 存储抽象 ⭐
│   ├── ui/               # 共享 UI 组件库
│   └── utils/            # 共享工具函数
├── pnpm-workspace.yaml
└── package.json
```

**关键设计原则**：业务逻辑（todo-model）和 UI 组件（ui）下沉到 `packages`，各平台 app 仅负责平台适配层和入口。

### 2.2 核心包：todo-model

`@baicie/orbit` 是本项目的核心抽象层，其设计遵循**依赖倒置原则**——业务层不依赖具体存储实现，只依赖抽象接口。

```
todo-model/src/
├── types.ts              # 核心类型定义（Task, List, Step, User 等）
├── storage.ts            # 存储抽象接口（IStorage, ITaskStorage, IListStorage, IAuthStorage）
├── smart-list.ts         # 智能列表工具函数
├── local/                # 本地存储实现（IndexedDB / localStorage）
│   ├── task-storage.ts
│   ├── list-storage.ts
│   ├── auth-storage.ts
│   └── index.ts
└── remote/               # 远程存储实现（REST API）
    ├── task-storage.ts
    ├── list-storage.ts
    ├── auth-storage.ts
    ├── api-client.ts
    └── index.ts
```

**使用方式**：

```typescript
// 本地模式（纯本地，无需后端）
import { createLocalStorage } from '@baicie/orbit/local';
const storage = createLocalStorage();

// 远程模式（连接后端服务）
import { createRemoteStorage } from '@baicie/orbit/remote';
const storage = createRemoteStorage({ mode: 'remote', apiBaseUrl: 'https://api.example.com' });

// 统一接口调用
const tasks = await storage.tasks.getTasks({ listId: 'xxx' });
```

这种设计使得：
- **平台无关**：业务代码不关心数据从哪里来
- **可切换**：用户可在设置中随时切换存储模式
- **可扩展**：新增存储后端（如 WebDAV、Supabase）只需实现接口

### 2.3 平台适配策略

| 平台 | 渲染框架 | 存储策略 | 特殊能力 |
|------|---------|---------|---------|
| **Web** | React + Vite | localStorage / IndexedDB / REST API | PWA 离线支持 |
| **Desktop** | React + Vite (嵌入式) | IndexedDB + REST API | 原生窗口、系统托盘、文件系统访问 |
| **Mobile** | React Native / Taro | AsyncStorage + REST API | 推送通知、摄像头扫描 |
| **Miniprogram** | Taro | Storage API + REST API | 微信登录、支付 |
| **Browser Ext** | React | Chrome Storage API | 无需后端，浏览器内独立运行 |

---

## 3. 数据模型

### 3.1 核心实体

#### Task（任务）

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | `string` | UUID |
| `title` | `string` | 任务标题 |
| `description` | `string \| null` | 富文本描述（Markdown 或块编辑器 JSON） |
| `isCompleted` | `boolean` | 是否完成 |
| `isImportant` | `boolean` | 是否标记为重要 |
| `addToMyDay` | `boolean` | 是否加入「今日」 |
| `dueDate` | `string \| null` | 截止日期（ISO 8601） |
| `reminderDate` | `string \| null` | 提醒时间 |
| `repeatPattern` | `RepeatPattern` | 重复模式 |
| `category` | `TaskCategory` | 颜色分类（blue/red/green/orange） |
| `files` | `FileAttachment[]` | 附件列表 |
| `steps` | `Step[]` | 子任务步骤 |
| `listId` | `string \| null` | 所属清单 ID |
| `createdAt` | `string` | 创建时间 |
| `updatedAt` | `string` | 更新时间 |

**RepeatPattern**：`'daily' | 'weekly' | 'monthly' | 'yearly' | 'weekdays' | 'custom' | null`

**TaskCategory**：`'blue' | 'red' | 'green' | 'orange' | null`

#### Step（子任务步骤）

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | `string` | UUID |
| `title` | `string` | 步骤标题 |
| `isCompleted` | `boolean` | 是否完成 |
| `createdAt` | `string` | 创建时间 |
| `updatedAt` | `string` | 更新时间 |

#### List（清单）

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | `string` | UUID |
| `title` | `string` | 清单标题 |
| `icon` | `string \| null` | 图标名称或 emoji |
| `theme` | `string \| null` | 主题色 |
| `isSmart` | `boolean` | 是否为智能列表（系统预置，不可删除） |
| `userId` | `number` | 所属用户 ID（本地模式下为 0 或 null） |
| `createdAt` | `string` | 创建时间 |
| `updatedAt` | `string` | 更新时间 |

#### SmartList（智能列表）

智能列表是根据查询条件动态生成的任务视图，不是真实存储的数据。

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | `string` | 固定 ID：`'my-day' \| 'important' \| 'planned' \| 'tasks'` |
| `type` | `SmartListType` | 列表类型 |
| `title` | `string` | 显示标题（i18n key） |
| `icon` | `string` | 图标名称 |

#### User（用户）

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | `number` | 用户 ID |
| `name` | `string` | 用户名 |
| `email` | `string` | 邮箱 |
| `age` | `number` | 年龄 |
| `createdAt` | `string` | 注册时间 |

### 3.2 存储接口设计

```typescript
interface ITaskStorage {
  readonly mode: 'local' | 'remote';
  getTasks(params?: TaskQueryParams): Promise<Task[]>;
  getTask(id: string): Promise<Task | null>;
  createTask(input: CreateTaskInput): Promise<Task>;
  updateTask(id: string, input: UpdateTaskInput): Promise<Task>;
  deleteTask(id: string): Promise<void>;
  addStep(taskId: string, input: CreateStepInput): Promise<Step>;
  updateStep(stepId: string, input: UpdateStepInput): Promise<Step>;
  deleteStep(stepId: string): Promise<void>;
}

interface IListStorage {
  readonly mode: 'local' | 'remote';
  getLists(): Promise<List[]>;
  getList(id: string): Promise<List | null>;
  createList(input: CreateListInput): Promise<List>;
  updateList(id: string, input: UpdateListInput): Promise<List>;
  deleteList(id: string): Promise<void>;
}

interface IAuthStorage {
  readonly mode: 'local' | 'remote';
  login(email: string, password: string): Promise<AuthResult>;
  register(name: string, email: string, password: string): Promise<AuthResult>;
  getProfile(): Promise<User>;
  getStoredUser(): User | null;
  getStoredToken(): string | null;
  setAuth(result: AuthResult): void;
  clearAuth(): void;
}

interface IStorage {
  readonly mode: 'local' | 'remote';
  readonly tasks: ITaskStorage;
  readonly lists: IListStorage;
  readonly auth: IAuthStorage;
  readonly config: StorageConfig;
  initialize(): Promise<void>;
  destroy(): Promise<void>;
}
```

---

## 4. 后端 API 设计

### 4.1 API 概述

- **Base URL**: `/api`
- **认证方式**: JWT Bearer Token
- **内容格式**: JSON
- **分页**: 标准化分页响应 `{ data: [], total: number, page: number, pageSize: number }`

### 4.2 认证接口

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/auth/register` | 用户注册 |
| POST | `/auth/login` | 用户登录 |
| GET | `/auth/profile` | 获取当前用户信息（需认证） |

### 4.3 任务接口

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/tasks` | 获取任务列表（支持筛选参数） |
| GET | `/tasks/:id` | 获取任务详情 |
| POST | `/tasks` | 创建任务 |
| PATCH | `/tasks/:id` | 更新任务 |
| DELETE | `/tasks/:id` | 删除任务 |
| POST | `/tasks/:id/steps` | 添加子任务步骤 |
| PATCH | `/tasks/steps/:stepId` | 更新子任务步骤 |
| DELETE | `/tasks/steps/:stepId` | 删除子任务步骤 |

**GET /tasks 查询参数**：

| 参数 | 类型 | 说明 |
|------|------|------|
| `listId` | `string` | 按清单筛选 |
| `isImportant` | `boolean` | 仅重要任务 |
| `addToMyDay` | `boolean` | 仅「今日」任务 |
| `hasDueDate` | `boolean` | 仅有截止日期的任务 |
| `isCompleted` | `boolean` | 仅已完成/未完成任务 |
| `page` | `number` | 页码 |
| `pageSize` | `number` | 每页数量 |

### 4.4 清单接口

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/lists` | 获取所有清单 |
| GET | `/lists/:id` | 获取清单详情 |
| POST | `/lists` | 创建清单 |
| PATCH | `/lists/:id` | 更新清单 |
| DELETE | `/lists/:id` | 删除清单 |

### 4.5 文件上传接口

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/uploads/single` | 单文件上传 |
| POST | `/uploads/multiple` | 多文件上传（最多 5 个） |
| GET | `/uploads` | 获取文件列表 |
| DELETE | `/uploads/:id` | 删除文件 |

### 4.6 健康检查

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/health` | 整体健康状态 |
| GET | `/health/ready` | 就绪检查（依赖 DB） |
| GET | `/health/live` | 存活检查 |

---

## 5. 前端架构（Web App）

### 5.1 技术栈

| 类别 | 技术选型 |
|------|---------|
| 框架 | React 19 + TypeScript |
| 构建 | Vite 8 + Tailwind CSS v4 |
| 路由 | React Router v7 |
| 状态/数据 | React Query v5（服务端状态）+ Context（认证状态） |
| HTTP | Axios |
| 动画 | Framer Motion |
| 国际化 | i18next + react-i18next |
| 图标 | Lucide React |
| UI 组件 | @baicie/orbit-ui |

### 5.2 目录结构

```
apps/web/src/
├── main.tsx                    # 入口
├── App.tsx                     # 路由配置 + ProtectedRoute
├── contexts/
│   └── AuthContext.tsx         # 认证上下文
├── components/
│   ├── Layout.tsx              # 页面布局骨架
│   ├── Header.tsx              # 顶部导航栏
│   ├── Sidebar.tsx             # 侧边栏（智能列表 + 自定义清单）
│   ├── MainContent.tsx         # 主内容区（任务列表）
│   ├── TaskDetailDrawer.tsx    # 任务详情抽屉
│   ├── SettingsDrawer.tsx       # 设置抽屉
│   └── ContextMenu.tsx          # 右键菜单
├── pages/
│   ├── Login.tsx               # 登录页
│   └── Register.tsx            # 注册页
├── lib/
│   ├── api.ts                  # Axios 实例（请求/响应拦截器）
│   └── queryClient.ts          # React Query 配置
├── i18n.ts                     # i18next 配置
├── locales/
│   ├── en/translation.json
│   └── zh/translation.json
└── index.css                   # Tailwind 入口 + CSS 变量主题
```

### 5.3 页面路由

| 路径 | 组件 | 说明 |
|------|------|------|
| `/login` | `Login.tsx` | 登录页 |
| `/register` | `Register.tsx` | 注册页 |
| `/tasks/:listId` | `Layout` + `MainContent` | 任务列表页（需认证） |
| `/` | redirect to `/tasks/my-day` | 首页重定向 |

### 5.4 主题系统

通过 Tailwind CSS v4 的 CSS 变量实现主题切换：

```css
:root {
  --theme-primary: #3b82f6;    /* 主色调：蓝色 */
  --theme-bg: #f8fafc;          /* 背景色 */
  --theme-text: #111827;        /* 主文本色 */
  --sidebar-bg: #ffffff;
  --sidebar-hover: #f1f5f9;
  --radius: 0.5rem;
}
```

---

## 6. 桌面端架构（Desktop / Tauri）

### 6.1 技术栈

| 类别 | 技术选型 |
|------|---------|
| 框架 | Tauri 2.x |
| 前端 | React + Vite（复用 web app 源码） |
| 存储 | IndexedDB（本地）+ REST API（可选） |
| 后端语言 | Rust |

### 6.2 Tauri 配置

- **窗口**：可调整大小，支持最小化/最大化/全屏
- **构建目标**：macOS DMG / App Bundle
- **开发模式**：自动打开 DevTools
- **全局 Tauri API**：前端可直接调用 `window.__TAURI__` 对象

### 6.3 Rust 层职责

桌面端的 Rust 层（`apps/desktop/src-tauri/src/`）承担以下职责：

1. **系统级集成**：系统托盘、文件选择对话框、窗口控制
2. **原生能力桥接**：摄像头、文件系统、本地通知
3. **安全沙箱**：管理前端权限范围
4. **存储适配**：通过 IPC 调用 Rust 层的 IndexedDB 封装（未来可选）

当前阶段保持单 crate 结构，仅在 `lib.rs` 中注册插件和 DevTools 开关。业务逻辑通过 Tauri commands 暴露给前端。

### 6.4 演进路径

```
阶段一（当前）：单 crate，仅基础插件注册
阶段二：commands/ 模块拆分（Tauri commands）
阶段三：services/ 业务逻辑独立
阶段四（如需）：crates/core/ 拆分为独立 workspace crate
```

---

## 7. 各平台 App 状态

| 平台 | 状态 | 说明 |
|------|------|------|
| **Web** | 🟡 开发中 | 基础 UI 和 API 集成已完成，存储抽象层未接入 |
| **Backend** | 🟡 开发中 | 完整 REST API + 数据库，Docker 部署支持 |
| **Desktop** | 🟢 初始模板 | Tauri 2 空白项目，尚未接入业务逻辑 |
| **Mobile** | 🔴 未开始 | React Native / Taro 框架选型待定 |
| **Miniprogram** | 🔴 未开始 | Taro 多端项目待创建 |
| **Browser Ext** | 🔴 未开始 | 独立 manifest v3 项目待创建 |

---

## 8. 部署方案

### 8.1 后端部署

后端通过 Docker 和 `docker-compose` 一键部署：

```yaml
# docker-compose.yml
services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_DB: unitodo
      POSTGRES_USER: unitodo
      POSTGRES_PASSWORD: ${DB_PASSWORD}
    volumes:
      - postgres_data:/var/lib/postgresql/data

  backend:
    build: ./apps/backend
    ports:
      - "3001:3001"
    environment:
      DB_HOST: postgres
      DB_PORT: 5432
      DB_DATABASE: unitodo
      DB_USERNAME: unitodo
      DB_PASSWORD: ${DB_PASSWORD}
      JWT_SECRET: ${JWT_SECRET}
    depends_on:
      - postgres

volumes:
  postgres_data:
```

### 8.2 前端部署

| 平台 | 部署方式 |
|------|---------|
| Web | Vercel / Netlify（静态部署） |
| Desktop | 直接分发 `.dmg` / `.exe` 安装包 |
| Mobile | 应用商店（App Store / Google Play）|
| Miniprogram | 微信开发者工具上传 |
| Browser Ext | Chrome Web Store / 手动加载 |

### 8.3 环境变量

前端环境变量（`.env`）：

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `VITE_API_URL` | 后端 API 地址 | `http://localhost:3001/api` |
| `VITE_STORAGE_MODE` | 存储模式 | `'local'` |

---

## 9. 开发规范

### 9.1 Git 规范

遵循 AGENTS.md 中的规范：

- **分支命名**：`feat/xxx`、`fix/xxx`、`docs/xxx` 等
- **Commit Message**：Conventional Commits 格式
- **PR 标题**：英文，简短描述，格式 `<type>: <description>`
- **禁止直接提交**：保护分支 `main` / `master`

### 9.2 代码风格

- TypeScript 严格模式
- 2 空格缩进，LF 换行
- 禁止 `any`、禁止 `console.log`
- 使用 `import type` 导入类型
- 使用 `node:` 前缀导入 Node.js 内置模块

### 9.3 Monorepo 工作流

```bash
pnpm install          # 安装所有依赖
pnpm dev              # 开发模式（所有 apps 并行）
pnpm build            # 构建所有包和 apps
pnpm lint             # ESLint 检查
```

---

## 10. 未来路线图

### Phase 1：核心功能完善（当前重点）

- [ ] Web App 接入 `@baicie/orbit` 存储抽象层
- [ ] 完成本地存储实现（IndexedDB）
- [ ] 完成远程存储实现（REST API 对接）
- [ ] 实现设置页面：存储模式切换、主题切换、账号管理
- [ ] 完善拖拽排序、任务批量操作

### Phase 2：多端扩展

- [ ] Desktop App：接入 todo-model，实现本地优先存储
- [ ] Mobile App：React Native / Taro 选型，启动开发
- [ ] Miniprogram：Taro 多端编译适配

### Phase 3：高级功能

- [ ] 块编辑器（替代纯文本描述）
- [ ] 标签系统（替代单一分类）
- [ ] 协作共享（团队清单、任务分配）
- [ ] 数据同步引擎（冲突解决、离线队列）
- [ ] 键盘快捷键体系（参考 Linear）

### Phase 4：生态扩展

- [ ] 浏览器扩展（独立运行，数据同步）
- [ ] VS Code 插件（任务内嵌显示）
- [ ] API开放（第三方集成）
- [ ] 插件系统（自定义字段、工作流自动化）

---

## 附录 A：项目依赖一览

### 核心依赖

| 包 | 版本 | 用途 |
|----|------|------|
| `react` | ^19 | UI 框架 |
| `react-router-dom` | ^7 | 路由管理 |
| `@tanstack/react-query` | ^5 | 服务端状态管理 |
| `axios` | ^1 | HTTP 客户端 |
| `i18next` | ^26 | 国际化 |
| `framer-motion` | ^12 | 动画 |

### Monorepo 内部包

| 包 | 路径 | 用途 |
|----|------|------|
| `@baicie/orbit` | `packages/todo-model` | 核心数据模型 + 存储抽象 |
| `@baicie/orbit-ui` | `packages/ui` | 共享 UI 组件 |
| `@baicie/orbit-utils` | `packages/utils` | 共享工具函数 |
| `@baicie/orbit-tsconfig` | `packages/tsconfig` | TypeScript 配置 |

---

## 附录 B：数据库实体关系

```
User (1) ───< Task (N)
User (1) ───< List (N)
List (1) ───< Task (N)
Task (1) ───< Step (N)
Task (1) ───< FileAttachment (N, via JSON column)
```

---

*文档版本：v0.1.0 | 最后更新：2026-04-21*
