# Native 多账号隔离设计（P1 门禁）

> 状态：设计草案，未实施迁移。  
> 约束：V1.0-RC1 不开放 Tauri 账号切换；必须先通过 P0 同步、提醒、离线恢复门禁。

## 1. 现状审查

- Web：`apps/app/src/lib/accounts.ts` 使用 `shishi-todo:<accountId>` 作为 IndexedDB 名称，默认空间为 `shishi-todo`。
- Native：`apps/native/src-tauri/src/db.rs` 固定打开 `shishi.sqlite3`，所有 Tauri 账号共用同一个 SQLite。
- Native UI：`CloudPanel.tsx` 的 `canSwitchProfiles()` 在 Tauri 中返回 `false`，隐藏“切换账号/添加账号”入口；这是当前的防绕过门禁。
- 结论：**不能仅依赖隐藏按钮**。后续需要协议层账号绑定、独立数据库和独立 token/outbox；本文件只定义方案，不在本轮执行破坏性迁移。

## 2. 目标模型

```text
app_data_dir/
  accounts.json                    # 账号注册表，不含 token
  accounts/
    default/
      shishi.sqlite3               # 匿名/旧单库迁移目标
      backups/
    <account-id>/
      shishi.sqlite3
      backups/
```

- `default`：匿名本地空间；也是旧版 `shishi.sqlite3` 的迁移目标。
- `<account-id>`：由本地生成 UUID，不等于邮箱；邮箱可变，id 不可变。
- `accounts.json` 只保存：`id`、`email`、`apiUrl`、`createdAt`、`schemaVersion`、`lastOpenedAt`；不保存 access/refresh token。
- Token 使用现有 `secureTokenStore`，key 必须带账号：`cloud-refresh:<account-id>`；禁止共用 `cloud-refresh:default`。
- 每个账号数据库独立持有：`device_id`、`client_seq`、`outbox`、`server_shadow`、`cursor`、`day_plan`、提醒派生状态。

## 3. 打开与生命周期

1. 启动时读取 `accounts.json` 的 active id；找不到则使用 `default`。
2. 只打开 **一个** SQLite 连接，关闭上一个连接后才打开新账号；Tauri `AppState` 整体替换，不热切换。
3. 登录/登出/切换账号必须先停止自动同步、取消提醒 timer、关闭旧连接，再持久化 active id；随后重启 WebView 或重新创建 `AppState`。
4. 登出默认保留本地数据库；只有用户明确选择“清除本机数据”时才删除对应目录。删除前先停止 DB 并写入 pending deletion marker，避免半删除。
5. 匿名数据登录云账号时走显式 merge/cloud 选择，不自动把匿名库复制进账号库。

## 4. 旧单库迁移

迁移只在一次性升级步骤中执行，不能在普通启动路径反复执行：

1. 检测旧 `shishi.sqlite3` 存在且 `accounts/default/shishi.sqlite3` 不存在。
2. 停止 API/提醒/同步后台任务，使用 SQLite backup API 生成一致性备份。
3. 复制/重命名旧库到 `accounts/default/shishi.sqlite3`，执行 `PRAGMA integrity_check`。
4. 写 `accounts.json` 的 `schemaVersion=1` 和迁移完成 marker。
5. 启动新连接，验证 task/list/step/day_plan 数量与旧库一致。
6. 任一步失败：保留旧库和 backup，不删除旧文件，active 仍指向旧路径并显示可恢复错误。

## 5. 切换/回滚边界

- 切换失败：恢复 active id 到旧账号，重开旧数据库；不删除任何账号目录。
- 迁移失败：不修改旧库；回滚只需删除新目录的临时副本和 marker。
- 账号目录删除失败：标记 `deletion_pending`，下次启动重试，不能静默当作成功。
- 旧客户端降级：若新版本创建了多账号目录，旧版本只能读取 default；发布说明必须明确不可逆边界。

## 6. 提醒与设备身份

- 每个账号独立 `device_id`；切换账号前取消该账号所有系统提醒，避免 A 账号提醒出现在 B 账号。
- 提醒 reconcile 只能读取当前打开数据库的 `list_reminder_candidates`，禁止跨账号查询。
- 切换/登出时取消当前账号提醒；新账号在冷启动/前台恢复时重新 reconcile。
- `outbox`、`cursor`、`shadow` 禁止跨数据库复制；登录合并只走应用层导出/merge 流程。

## 7. 门禁与测试

在以下测试全部通过前，Tauri 不显示账号切换入口：

- 旧单库迁移成功、迁移失败保留旧库、重复启动幂等。
- 两账号分别创建/修改任务，互不可见；退出重开仍隔离。
- 账号 A 的 outbox/cursor/shadow 不会出现在 B。
- 切换前提醒被取消，切换后只调度新账号提醒。
- token key 按账号隔离，删除账号清理对应 key。
- 迁移中断/进程崩溃后可从 backup 恢复。

## 8. 结论

P1 仅完成设计与门禁审查，**不执行迁移**。P0 通过后，下一 PR 才可实现目录、注册表和一次性迁移；当前 Tauri 仍保持单库、单账号模式。
