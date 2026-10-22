# 拾事 · Local-first To Do

一个克制、明亮、离线优先的跨平台待办应用。实现基线来自
[`docs/design/README.md`](docs/design/README.md)。

## 能力

- **本地优先**：浏览器使用 IndexedDB (Dexie)，Tauri 原生端使用 SQLite；无需登录即可完整使用。
- **智能视图**：我的一天、重要、计划内、日历、全部任务、自定义清单与已完成。
- **任务工作台**：快速录入、自然语言日期/标签/清单、子步骤、备注、标签、截止日期、提醒、重复规则、搜索、筛选与保存视图、撤销删除。
- **数据自主**：JSON / CSV / ICS 导出、JSON / ICS 导入恢复、云端账号导出。
- **端到端云同步**：账号验证码登录、首次登录显式“合并 / 仅用云端 / 取消”、字段级 patch、
  服务端序号、幂等 op、outbox 重放、游标增量、游标过期 rebase、设备撤销、冲突详情、
  诊断包、多本机账号数据隔离和 Web Push 订阅。
- **协作**：共享清单 v1（owner/editor/viewer、revision 冲突保护、成员邀请、轮询刷新；在线协作，不写入个人同步 change log）。
- **跨平台提醒**：Web 页面存活时提醒；桌面托盘/自启/重启补偿；Android AlarmManager 与
  iOS UNUserNotificationCenter 插件源码已提供。
- **生产 API**：SMTP 邮件、PostgreSQL 共享限流、JWT + 轮换 refresh token、备份/保留/账号
  清除运维 CLI、`/healthz` + `/readyz`、`/metrics`、`X-Request-Id`、Docker/Caddy 部署与安全校验。

## 实现状态

- **已完成并本地验证**：本地 MVP、全部视图、标签/筛选/保存视图、日历/ICS、自然语言快速添加、
  模板/每周回顾、详情/子步骤/日期/提醒/重复、搜索、撤销删除、JSON/CSV、响应式 Web、PWA
  离线、Tauri SQLite 壳、桌面提醒/托盘/自启、Axum/PostgreSQL API、生产邮件与限流、运维
  CLI、Web 云同步双设备 E2E、多账号本地隔离、Web Push 后端、共享清单 API、Web 虚拟滚动与
  10k/100k 性能基准、Playwright 回归与 axe 零违规、桌面/Web 发布工作流。
- **平台/范围边界**：共享清单 Web 端是在线协作 v1（15 秒轮询、revision 冲突保护），尚未
  接入 native 本地共享 outbox；多账号切换目前只在 Web 端启用独立 IndexedDB，Tauri 仍使用
  单一 SQLite 数据空间。真实 Android/iOS 构建需在对应环境初始化并签名；本机没有
  Android SDK/NDK/adb 和 macOS/Xcode。
- **外部服务边界**：未使用真实 SMTP 凭据发信；生产发信前应做一次人工验证。未申请公网
  Caddy 证书；证书、备份异地复制和密钥托管由部署侧完成。

## 快速开始

```bash
pnpm install
pnpm dev          # http://localhost:5173（默认本地模式，不上传数据）
pnpm test
pnpm build
```

Web 云同步：部署 API 后，在“设置与数据 → 同步”填写 API 地址和邮箱，使用验证码登录。
开发环境默认验证码来自 `AUTH_DEV_CODE`（默认 `246810`）；生产环境必须配置 SMTP。

桌面 / 移动原生壳（Tauri 2）：

```bash
cd apps/native/src-tauri
cargo tauri dev       # 或 cargo tauri build
```

原生端 SQLite 契约、托盘/自启、Android/iOS 提醒限制见 [docs/native.md](docs/native.md)。

云同步服务：

```bash
docker compose up -d postgres
cp .env.example .env
cargo run -p todo-api
```

生产部署、Caddy TLS、备份恢复和运维 CLI：

- [docs/runbooks/production.md](docs/runbooks/production.md)
- [docs/runbooks/operations.md](docs/runbooks/operations.md)
- [docs/runbooks/backup-restore.md](docs/runbooks/backup-restore.md)
- [docs/operations.md](docs/operations.md)（`/metrics`、request id、生产 smoke）

## GitHub Actions 发布验收

推送 `v*` 标签或手动运行 `release-acceptance` workflow：

- `api-container`：构建真实 Docker 镜像，启动 PostgreSQL，跑 smoke、带 VAPID 的 Web Push config、`pg_dump` 隔离恢复。
- `web-e2e`：生产构建 + Playwright 功能/PWA/axe。
- `release-desktop`：Windows/macOS/Linux 未签名桌面包。
- `release-web`、`API`、`native`：各自独立回归。
- 手动运行时可选择 `build_mobile=true` 构建 Android debug APK。

界面采用 Fluent / Microsoft To Do 风格：浅灰导航、Segoe 字体、Fluent 蓝、低圆角、紧凑任务行，深色主题同步适配；视觉回归由 `scripts/visual-check.mjs` 截图。

## 验收命令

```bash
pnpm check          # 全 workspace 类型、前端/同步/领域测试、Web 构建、Rust 测试
pnpm rust:lint      # cargo fmt + clippy -D warnings
pnpm test:e2e:install
pnpm test:e2e       # 生产构建 + Playwright 回归/PWA/axe（自动启动/复用 4173 预览）
pnpm perf:web       # 需另开 pnpm --filter @todo/app preview
pnpm perf:budget    # 校验 10k/100k 性能预算
pnpm sbom           # 生成 artifacts/sbom.cdx.json
```

真实双设备云同步（本地 API + PostgreSQL；开发环境将 `AUTH_CODE_RESEND_SECONDS` 设为
`1`，否则同一邮箱两次登录需等待 60 秒）：

```bash
node scripts/cloud-e2e.mjs
```

该脚本验证首次登录显式合并、第二设备使用云端快照、双向增量、离线写入恢复、页面刷新
后的 refresh token 续期和同步诊断。

PostgreSQL 集成测试（需运行 `docker compose up -d postgres`）：

```bash
DATABASE_URL=postgres://todo:todo@localhost:5432/todo \
  cargo test -p todo-api --test postgres_smoke -- --ignored
DATABASE_URL=postgres://todo:todo@localhost:5432/todo \
  cargo test -p todo-api --test postgres_production -- --ignored
```

## 目录

```text
apps/app         SolidJS SPA（Web + Tauri 共用）
apps/native      Tauri 2 原生壳 + Android/iOS 提醒插件
apps/api         Axum API
packages/domain  纯领域模型、日期与重复规则
packages/application 用例服务与仓库契约
packages/sync    同步引擎与 REST transport
packages/contracts API 契约
packages/ui      设计 token 与基础样式
crates/native-core SQLite 原生核心
db               PostgreSQL / SQLite 基线
docs             ADR、运行手册、性能与无障碍报告
```

详细架构见 [docs/architecture.md](docs/architecture.md)，同步协议见
[docs/sync-protocol.md](docs/sync-protocol.md)。
