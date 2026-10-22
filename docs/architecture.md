# 架构说明

拾事采用 local-first 架构。UI 永远先读写本机物化视图，云端只负责可选的多设备持久化，
因此离线、启动和日常操作不依赖网络。

## 分层

```text
presentation (apps/app/src/components, pages)
        │ 只调用 TaskService / PlatformPort
application (packages/application)
        │ 用例、事务边界、导出格式
domain (packages/domain)
        │ 纯 TS：实体、日期、重复规则、校验
infrastructure
  ├─ apps/app/src/adapters/web-repository.ts   Dexie / IndexedDB
  ├─ apps/app/src/adapters/tauri-repository.ts Tauri command bridge
  ├─ crates/native-core                        SQLite + outbox transaction
  └─ apps/api                                  Axum + PostgreSQL
```

约束：

- Solid 组件不得直接使用 Dexie、SQLite 或 `fetch` 访问业务数据。
- `@todo/domain` 不依赖 DOM、Tauri、数据库或网络。
- `@todo/application` 只依赖仓库接口，不感知具体平台。
- Native 的 WebView 不具备任意 SQL、文件系统或 shell 权限；只能调用固定领域命令。

## 本地数据模型

| 表              | 用途                                                       |
| --------------- | ---------------------------------------------------------- |
| `tasks`         | 任务物化视图，包含完成、日期、提醒、重复规则和软删除       |
| `lists`         | 用户清单，收件箱用 `listId = null` 表示                    |
| `steps`         | 子步骤                                                     |
| `day_plans`     | `(taskId, localDate)` 唯一，表示我的一天                   |
| `outbox`        | 本地 mutation 日志，含 UUIDv7 `opId`、设备序号和字段 patch |
| `server_shadow` | 已确认的云端实体快照（登录后）                             |
| `meta`          | 设备 ID、客户端序号、同步游标、初始化标记                  |

每个本地写操作在**同一个事务**内更新物化表并写入 outbox。UI 看到任务时，记录已经持久化。

## 时间语义

- `dueOn`: `YYYY-MM-DD` 日历日，不包含时间。
- `remindAt`: UTC instant。
- `remindTimezone`: IANA 时区，保留提醒创建时的本地语义。
- `localDate`: 账户/设备时区下的“我的一天”日期。
- 重复规则使用日历运算，不使用 `+86400s`，覆盖 DST 与月末。

`todayInTimeZone` 通过 `Intl.DateTimeFormat` 计算账户时区的日期；`zonedDateTimeToUtc`
用两轮偏移校正将墙上时间转换为 UTC。

## 平台适配

`createAppPlatform()` 在启动时检测 Tauri：

- Web：Dexie repository + Web Notifications + `navigator.storage.persist()`。
- Tauri：动态加载 domain command adapter + 原生 SQLite + 原生提醒桥接。

动态导入确保 Web 构建不会把 Tauri 运行时拉入首屏。Web 与 Native 共用业务模型、路由和组件，
但布局在 860px 以下切换为移动 Shell：底部导航、全屏详情、抽屉式清单。

## 同步

`@todo/app` 的 `createCloudController` 负责账号登录、首次合并向导和同步生命周期；
`@todo/sync` 提供同步引擎，`@todo/sync/rest` 提供 REST transport。关键性质：

1. 服务端为账号内操作分配单调 `server_seq`。
2. `op_id` 唯一致使重试幂等；重复提交返回原 receipt。
3. 设备 `client_seq` 连续递增，拒绝乱序或空洞；重新验证会轮换设备 ID。
4. 字段级 patch，标题与截止日期互不覆盖。
5. 删除优先；恢复必须是显式 `restore`。
6. 本地 `shadow + 未确认 outbox` 重放得到物化视图，远端变更绝不覆盖 pending 本地输入。
7. Cursor 过期时做一致性 bootstrap，保留未确认 outbox。
8. 首次登录必须显式选择“合并 / 仅使用云端 / 取消”，不会静默上传或覆盖；
   登录前可下载本机 JSON 备份。

完整协议见 [sync-protocol.md](sync-protocol.md)。

## 安全边界

- API 的 `user_id` 只来自验证过的 access token；设备 ID 必须与 token 绑定。
- refresh token 仅存哈希；轮换并检测复用。Web 使用 HttpOnly Cookie，桌面 Tauri 使用
  Windows Credential Manager / macOS Keychain / Linux Secret Service，移动端当前为
  进程内会话（重启后重新登录）。
- 生产环境强制 HTTPS CORS、Secure Cookie、真实 SMTP 和 ≥32 字节 JWT secret。
- Tauri capability 最小化，CSP 禁止远端脚本与 `eval`。
- 备注按文本节点渲染，不注入 HTML。
- 日志不输出任务标题、备注、验证码、token 或完整请求体。

## 提醒

`ReminderScheduler` 是平台端口：

- Native 桌面：Rust 进程内调度队列 + 系统通知；重启后重建。
- Android/iOS：系统本地通知桥接（见 [native.md](native.md) 的限制说明）。
- Web：只在页面存活期间发送通知，设置里明确展示这一限制。

## 性能

- 任务列表超过 300 行时启用虚拟滚动，只挂载可见区约 18 行。
- 仓库维护内存任务快照，`getCounts` 与 `listTasks` 复用同一份数据；写操作统一失效。
- 搜索 60ms 防抖，结果限制 80 条，查询前只预处理一次搜索 token。
- 10k 任务生产预览实测：列表 75ms、搜索 106ms、冷重载 172ms（见
  [performance.md](performance.md)）。
- Web 首屏 JS gzip 约 104 KB；图标按需 tree-shake。
- 数据库索引覆盖清单/状态/截止日期；原生迁移使用 WAL。
