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
