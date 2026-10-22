# 运行手册：生产运维任务

所有运维命令都通过同一个 `todo-api` 二进制执行，不暴露公网 HTTP 管理端点。普通启动
不带参数即进入 `serve` 模式。

## 保护与模式

- `OPS_ADMIN_TOKEN`：必填，至少 32 字符。缺失时 CLI 拒绝执行。
- `APP_ENV`：生产设置为 `production`；此时 `CHANGE_LOG_RETENTION_DAYS` 必须
  > = 90，否则 CLI 直接拒绝运行。
- 默认 `--dry-run`，只输出将删除/清理的计数，不修改数据。
- `--apply` 同时要求环境变量 `OPS_CONFIRM=APPLY`，防止误操作。
- token 不得放在命令行参数、脚本日志或工单中。
- 运维 CLI 应只由受控管理员在受控主机/容器内运行；数据库账号本身也应是运维专用账号。
- 所有任务幂等，可安全重复执行；日志只包含计数和动作，不包含邮箱、验证码、token 或任务内容。

```bash
# 在仓库环境（需要 DATABASE_URL）
export OPS_ADMIN_TOKEN='at-least-32-characters-of-secret'
cargo run -p todo-api -- ops cleanup --dry-run
cargo run -p todo-api -- ops cleanup --apply          # 需要 OPS_CONFIRM=APPLY
cargo run -p todo-api -- ops prune-change-log --dry-run
cargo run -p todo-api -- ops prune-change-log --apply
cargo run -p todo-api -- ops purge-accounts --dry-run
cargo run -p todo-api -- ops purge-accounts --apply
cargo run -p todo-api -- ops all --dry-run
```

Docker Compose：

```bash
docker compose --profile ops run --rm ops ops cleanup --dry-run
docker compose --profile ops run --rm ops ops all --dry-run
OPS_CONFIRM=APPLY docker compose --profile ops run --rm ops ops all --apply
```

Compose 中的 `ops` 服务只会在指定 profile 时启动，不影响本地
`docker compose up -d postgres` / `docker compose up` 快速启动。

## 清理过期认证数据

`ops cleanup` 删除：

- 已过期且超过 `AUTH_CODE_RETENTION_DAYS`（默认 1 天）的一次性验证码；
- 已过期或撤销且超过 `SESSION_RETENTION_DAYS`（默认 7 天）的会话，以及级联的
  refresh token；
- 超过 `OP_RECEIPT_RETENTION_DAYS`（默认 90 天）的同步幂等回执；
- 超过 `RATE_LIMIT_RETENTION_HOURS`（默认 24 小时）的共享限流窗口。

回执删除是安全的：设备水位 `devices.last_client_seq` 会在同一事务中先于回执保留，
旧重试会得到 `already_processed` 而不是再次应用。

## 裁剪 change log

`ops prune-change-log` 按 `CHANGE_LOG_RETENTION_DAYS`（默认 90，生产不得低于
设计保留期）批量删除旧 `change_log`，并在同一事务中对受影响账号把
`account_sync_state.min_available_seq` 提升到第一条仍保留的 `server_seq`（如果没有
保留变更则提升到 `next_server_seq`）。这保证：

- 旧客户端得到 `CURSOR_EXPIRED`，必须先 bootstrap；
- 水位以下的旧回执不会被重新应用；
- 删除按 `(created_at, user_id, server_seq)` 批次进行，可用 `OPS_BATCH_SIZE`
  控制单批大小（默认 5000）。

建议在低峰期运行；任务可重复执行。

## 物理清理已删除账号

账号在 API 中先被软删除（`users.deleted_at`），并且会立即撤销会话、refresh token
和设备。`ops purge-accounts` 只处理删除时间早于 `ACCOUNT_PURGE_GRACE_DAYS`
（默认 7 天）的账号，按以下顺序物理删除：

1. 任务实体（day_plans、steps、tasks、lists，包括 tombstone）；
2. 同步回执、change log、account sync state；
3. refresh token、sessions、devices；
4. 该邮箱剩余 auth codes；
5. 最后删除 user 行。

该顺序确保删除过程中外键始终有效。备份中的历史副本不会自动消失，必须根据备份保留
策略轮换并销毁；若合规要求立即抹除备份，需要单独的数据销毁流程。

## 建议调度

| 任务                           | 频率         | 说明                           |
| ------------------------------ | ------------ | ------------------------------ |
| `ops cleanup --apply`          | 每小时或每日 | 低风险，可高频                 |
| `ops prune-change-log --apply` | 每日低峰     | 保留 >= 90 天                  |
| `ops purge-accounts --apply`   | 每日低峰     | 宽限期 >= 7 天，审计计数       |
| `backup` 服务                  | 每日         | 至少保留 14 天并异地保存       |
| 恢复演练                       | 每季度       | 使用隔离数据库和真实备份做演练 |

生产环境建议由 cron、systemd timer 或平台定时任务执行，并在执行前后采集命令退出码和
JSON 计数；不要通过公网 API 触发。任何 apply 输出都必须归档到受控审计日志。

## 故障处理

- `OPS_ADMIN_TOKEN must be set`：环境未注入 secret，不执行。
- `destructive operations require OPS_CONFIRM=APPLY`：先 dry-run，确认计数后再 apply。
- `CURSOR_EXPIRED` 告警增加：确认 change log 保留天数和客户端上线/重连频率。
- 清理任务失败：事务回滚，已提交批次可安全重复；先检查数据库空间、锁等待和迁移状态。
- 账号 purge 后 API 返回 401：符合预期；不允许以旧 token/refresh token 恢复账号。
