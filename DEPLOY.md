# Deployment

## 快速开始

使用部署脚本集中管理所有部署任务：

```bash
# 查看所有可用命令
./scripts/deploy/deploy.sh --help

# 部署所有服务 (Docker)
./scripts/deploy/deploy.sh all

# 发布共享包
./scripts/deploy/deploy.sh packages

# 构建移动端
./scripts/deploy/deploy.sh mobile

# 构建桌面应用
./scripts/deploy/deploy.sh desktop
```

---

## 共享包 (`@baicie/orbit-*`)

共享包通过 GitHub Actions 发布到 npm，触发方式是推送版本标签：

```bash
# 手动发布 (使用脚本)
./scripts/deploy/packages.sh [版本]

# 示例
./scripts/deploy/packages.sh v0.1.0     # 指定版本
./scripts/deploy/packages.sh           # 自动生成 patch 版本
./scripts/deploy/packages.sh --dry-run # 模拟运行
```

或手动打标签触发 Release workflow：

```bash
git tag v0.0.1
git push origin v0.0.1
```

发布的包：
- `@baicie/orbit-todo-model` - 核心数据模型
- `@baicie/orbit-hooks` - React Hooks
- `@baicie/orbit-ui` - UI 组件库
- `@baicie/orbit-utils` - 工具函数

> 注意：`@baicie/orbit-tsconfig` 是私有包，不会发布。

---

## Web 应用 (Docker)

```bash
# 使用脚本
./scripts/deploy/docker.sh up          # 启动所有服务
./scripts/deploy/docker.sh web         # 仅启动 Web
./scripts/deploy/docker.sh logs        # 查看日志

# 手动 Docker 命令
cd apps/web
docker build -t orbit-web .
docker run -p 8080:80 orbit-web

# 或使用 docker-compose
cd scripts/deploy
docker-compose up -d --build
```

Web 应用地址：http://localhost:8080

---

## 后端服务 (Docker)

```bash
# 使用脚本
./scripts/deploy/docker.sh backend      # 启动后端服务
./scripts/deploy/docker.sh logs backend # 查看后端日志

# 手动命令
cd apps/backend
docker build -t orbit-backend .
docker run -p 3001:3001 orbit-backend
```

后端服务地址：http://localhost:3001

---

## 移动端 (Expo + EAS)

```bash
# 使用脚本
./scripts/deploy/mobile.sh build ios --profile production
./scripts/deploy/mobile.sh build android
./scripts/deploy/mobile.sh build all
./scripts/deploy/mobile.sh submit ios
./scripts/deploy/mobile.sh update all    # OTA 更新

# 手动命令
cd apps/mobile
eas build --platform ios --profile production
eas submit --platform ios
```

需要 `eas.json` 配置。参考 [EAS Build 文档](https://docs.expo.dev/build/introduction/)。

---

## 浏览器扩展

```bash
# 使用脚本
./scripts/deploy/browser-ext.sh build chrome   # 构建 Chrome 扩展
./scripts/deploy/browser-ext.sh build firefox  # 构建 Firefox 扩展
./scripts/deploy/browser-ext.sh build all      # 构建所有浏览器
./scripts/deploy/browser-ext.sh package        # 打包扩展

# 手动命令
cd apps/browser-ext
pnpm build

# Chrome: 加载 dist/ 作为开发者扩展
# Firefox: 使用 web-ext 打包或上传到 AMO
```

---

## VSCode 扩展

```bash
# 使用脚本
./scripts/deploy/vscode-ext.sh build    # 构建
./scripts/deploy/vscode-ext.sh package  # 打包 .vsix
./scripts/deploy/vscode-ext.sh publish  # 发布到 Marketplace

# 手动命令
cd apps/vscode-ext
pnpm package
# 上传 .vsix 到 VSCode Marketplace
```

---

## 桌面应用 (Tauri)

```bash
# 使用脚本
./scripts/deploy/desktop.sh build windows   # 构建 Windows
./scripts/deploy/desktop.sh build macos     # 构建 macOS
./scripts/deploy/desktop.sh build all       # 构建所有平台
./scripts/deploy/desktop.sh dev             # 开发模式
./scripts/deploy/desktop.sh bundle          # 打包安装程序

# 手动命令
cd apps/desktop
pnpm build
# 输出目录: src-tauri/target/release/
```

特定平台构建：

```bash
cargo build --release --target x86_64-pc-windows-msvc  # Windows
cargo build --release --target x86_64-unknown-linux-gnu  # Linux
cargo build --release --target x86_64-apple-darwin       # macOS
```

---

## 脚本结构

```
scripts/deploy/
├── deploy.sh       # 主入口，统一调度各模块
├── docker.sh       # Docker 部署 (web, backend)
├── packages.sh     # 共享包发布 (npm)
├── mobile.sh       # 移动端构建 (iOS, Android)
├── desktop.sh      # 桌面应用构建 (Tauri)
├── browser-ext.sh  # 浏览器扩展构建
└── vscode-ext.sh   # VSCode 扩展构建
```
