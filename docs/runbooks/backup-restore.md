# 运行手册：备份与恢复

## Web

1. 打开“设置与数据 → 数据”。
2. 点击“导出 JSON”，确认文件已下载。
3. 恢复时选择“合并导入”或“替换全部”，再选择 JSON。
4. 替换会清空本机任务数据；导入前先导出当前数据。

IndexedDB 可能被浏览器在存储压力下清理。设置页提供 `navigator.storage.persist()` 申请，
但浏览器不保证批准，因此定期导出仍是唯一可依赖的备份。

## Native

- SQLite 数据库位于 Tauri 应用数据目录的 `shishi.db`。
- 所有写入使用事务；备份前暂停写入并由用户导出 JSON。
- 数据库升级前自动建立 `.bak` 文件；若迁移失败，保留旧文件和错误日志用于恢复。

## PostgreSQL / 自托管

仓库提供 `scripts/ops/backup.sh` 和 `scripts/ops/restore.sh`，Docker Compose 的
`backup` 服务只在 `ops` profile 下启动，不阻塞本地快速启动。

### 备份

```bash
mkdir -p backups
docker compose --profile ops run --rm backup
ls -lh backups/todo-*.dump*
```

产物为 PostgreSQL custom-format dump 和对应的 `.sha256`。脚本使用 `umask 077`，
默认保留 14 天（`BACKUP_RETENTION_DAYS`）。生产要求：

- 每日自动执行；至少保留 14 天，建议异地/对象存储再保存一份；
- 备份文件加密，访问权限只授予运维账号；
- 备份日志不得包含任务内容、token 或数据库密码；
- 定期将备份复制出主机，主机级磁盘故障不能同时带走数据库和全部备份。

### 恢复演练

恢复会覆盖目标数据库。必须先停止 API/Caddy、冻结写入、在隔离环境演练。

```bash
# 1. 停止写流量
docker compose stop caddy api

# 2. 再做一份当前库备份
docker compose --profile ops run --rm backup

# 3. 校验并恢复指定 dump；RESTORE_CONFIRM=YES 为强确认
docker compose --profile ops run --rm \
  -e RESTORE_CONFIRM=YES \
  --entrypoint /bin/sh \
  backup /opt/ops/restore.sh /backups/todo-YYYYMMDDTHHMMSSZ.dump

# 4. 启动 API；启动时会自动套用尚缺的 migration
docker compose up -d api

# 5. 等待就绪并检查计数
until curl -fsS http://127.0.0.1:8787/readyz >/dev/null; do sleep 1; done
OPS_ADMIN_TOKEN='<admin-token>' docker compose --profile ops run --rm ops ops all --dry-run
```

`restore.sh` 会校验同名 `.sha256`、要求 `RESTORE_CONFIRM=YES`，并使用
`--clean --if-exists --single-transaction --no-owner --no-acl`。生产恢复前应在隔离
数据库先演练，确认应用版本、migration 版本、账号数据和删除 tombstone 均符合预期。

### 恢复后核对

- `/readyz` 为 200，migrations 为 `ok`；
- `ops all --dry-run` 的计数合理；
- 抽查用户任务数、最近同步 cursor、设备数和导出 JSON；
- 若恢复的是旧备份，旧客户端可能收到 `CURSOR_EXPIRED`，需重新 bootstrap；
- 备份中仍包含已物理删除账号的历史副本，必须按备份保留/销毁策略处理。

### 共享清单与未发送的本地队列

PostgreSQL 备份包含服务端已接受的共享数据：`shared_lists`、`shared_list_members`、
`shared_list_invitations`、`shared_tasks`、`shared_steps`、`shared_op_receipts`。
恢复后这些清单、成员、任务和 `op_id` 回执都会回到备份时刻的状态，
`scripts/ops/backup-restore-test.sh` 的黄金数据集与行指纹断言覆盖了它们。

**PostgreSQL 备份无法恢复浏览器里尚未发出去的共享编辑。** 离线编辑先写入浏览器
IndexedDB 的 `sharedOutbox`，只有服务器确认后才进入 `shared_op_receipts`。Native 端的
共享清单是在线内存存储（不落盘，也没有共享 outbox），桌面端离线时无法编辑共享清单。
恢复一个旧 dump 时：

- 服务器上已回执的 op 会按备份回滚，客户端会重新推送仍在本地 outbox 里的 op；
  因为 `op_id` 回执也一起回滚，重放最多应用一次，不会重复创建任务；
- 只在浏览器本地、从未送达服务器的编辑不在任何 PostgreSQL 备份中。它们只能在
  原浏览器配置里保留，或用该浏览器的“导出 JSON”单独留存——而导出 JSON 也不含共享
  outbox（见下）；
- 因此恢复演练必须在隔离环境进行，不要让用户在原浏览器上继续离线编辑后再恢复，
  否则会产生无法从服务端重建的本地状态。

Web 端的 JSON 导出（设置 → 数据 → 导出 JSON）只包含个人数据
（`tasks/lists/steps/dayPlans`），**不包含共享清单和共享 outbox**。共享数据以服务端
为准；本机共享副本可在退出登录后重新登录时重建。这一点是产品决定，不是导出缺陷。
