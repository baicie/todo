# Native 多账号隔离设计（RC2-A 实现版）

> 状态：RC2-A 底座已实现；仍不开放多账号 UI、热切换和 RC2-B 写入路由。  
> 约束：旧用户升级不能丢失任务、outbox、shadow、cursor 或设备身份；任何异常都不能把旧数据误归属给云账号。

## 1. 对旧设计的修正

旧设计把 `app_data_dir/shishi.sqlite3` 一律迁入 `accounts/default`。这是高风险假设：

- 旧库可能已经明确绑定云账号（`kv_state.bound_account`）。
- 旧库可能是从未登录的匿名库。
- 旧库可能绑定信息缺失、损坏，或 outbox/device identity 与绑定不一致。

因此 RC2-A 改为 **先判定归属，再决定目标空间**：

| 判定         | 依据                                                                                     | 结果                                                                   |
| ------------ | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| 匿名         | 无 `bound_account`，且 `sync_enabled != true`                                            | `default` 匿名空间                                                     |
| 已绑定       | `bound_account` 是合法且规范化的邮箱，`device_id` 存在，outbox 中所有 device_id 与之一致 | 稳定 UUID 云账号空间                                                   |
| 归属不明     | 绑定邮箱非法、绑定缺失但 sync 已启用、绑定存在但 device_id 缺失/outbox 不一致            | **不迁移、不初始化空库**，保留原库和一致性备份，记录 `REQUIRES_REVIEW` |
| 绑定信息损坏 | 注册表/状态文件 JSON 损坏、active account 不存在                                         | 返回可恢复错误，禁止创建空库掩盖                                       |

归属判定只读查询，不写旧库；判定规则优先保守（宁可不迁移，也不误归属）。

## 2. 目录布局

```text
app_data_dir/
  accounts.json
  accounts.json.old-<uuid>       # Windows fallback previous registry (crash only)
  accounts.json.replace-journal  # Windows fallback recovery journal
  migration-state.json
  installation-state.json       # only while a fresh install is being initialized
  accounts/
    default/
      shishi.sqlite3
    <opaque-uuid-v7>/
      shishi.sqlite3
  migration-backups/
    <timestamp>-shishi.sqlite3
    quarantine-target-<uuid>.sqlite3
    fresh-corrupt-database-<uuid>.sqlite3
  shishi.sqlite3                 # 旧库，迁移后保留
  shishi.sqlite3-wal / -shm      # 旧库仍由 SQLite 管理
```

- 旧库及其 WAL/SHM 从不直接移动或删除。
- 账号 ID 只接受 `default` 或规范 UUID；邮箱永远不进入路径。
- 数据库文件名固定为 `shishi.sqlite3`，由注册表和原生代码派生，WebView 不能提供路径。
- `accounts.json` 只保存 `id/kind/email/apiUrl/createdAt/schemaVersion/lastOpenedAt`；不保存 token。
- `migration-backups/` 保存迁移前一致性副本；异常时原库、备份、目标三者都保留。
- 全新安装的完成标记 `installation-state.json` 在数据库创建前写入，注册表提交且数据库存在后才删除。

## 2.1 全新安装初始化

```text
无 registry / 无旧库 / 无账号 DB / 无迁移状态
  -> 写 installation-state.json (PREPARED)
  -> 创建并 integrity_check 空 SQLite
  -> installation-state.json (DATABASE_CREATED)
  -> 写 accounts.json (default)
  -> installation-state.json (REGISTRY_COMMITTED)
  -> 删除 Marker
```

- 数据库先于注册表出现；不允许出现“registry 已提交但 DB 尚未创建”的稳定窗口。
- PREPARED/DATABASE_CREATED/REGISTRY_COMMITTED 任一点崩溃，下一次启动按 marker 恢复，不重新写 default。
- 只要发现任意 `accounts/<id>/shishi.sqlite3`，且没有 marker/registry 解释它，就按数据存在处理并阻断，不创建空 default。
- `accounts.json` 存在但 active DB 缺失，且没有 installation marker，返回 `ActiveAccountMissing`，不自动补空库。

## 3. 迁移状态机

```text
NOT_STARTED
  -> BACKUP_CREATED       # SQLite Backup API 生成一致性副本并验证
  -> COPY_VERIFIED        # 目标临时库 integrity_check + 全量数据比较
  -> REGISTRY_COMMITTED   # accounts.json 原子持久化 active account
  -> COMPLETE             # 重新读取注册表 + 目标库再次验证

REQUIRES_REVIEW           # 归属不明，只写状态和备份，不建账号、不建空库
FAILED                    # 任一步失败；旧库/备份保留，下次启动可重试
```

- 状态文件本身用临时文件 + fsync + 原子替换（Unix rename；Windows `ReplaceFileW`，失败时写入可恢复 journal）。
- 只有 `COMPLETE` 才走正常快速打开路径；任何非 `COMPLETE` 状态都必须重新核对 source / backup / target、归属账户、registry active 与状态一致性，再继续或拒绝，不能仅因 target 文件存在就打开。
- `COMPLETE` 快速路径只校验 target 存在、SQLite integrity、migration target 与 registry active 一致；不把迁移时的内容指纹与正在使用的实时库比较，否则用户正常写入会被误判。
- 新目标通过 `PRAGMA integrity_check`，并按表计算逐行内容摘要：
  - `local_tasks`、`local_lists`、`local_steps`、`local_day_plans` 的全部列（含 nullable、deleted_at、note、remind_at）；
  - `outbox` 全字段与逐行摘要；
  - `server_shadow` 全字段与逐行摘要；
  - `kv_state` 全部行（含 device_id、sync_cursor、client_seq、bound_account）；
  - `schema_migrations` 全部版本。
- 摘要按主键稳定排序，对 NULL/整数/浮点/文本/BLOB 做类型标记，再计算 SHA-256；行数相同但任一字段变化都会失败。
- 内容指纹用于迁移 copy、backup/target 比较，以及所有非 COMPLETE 状态的恢复；COMPLETE 后是实时数据库，不再与迁移时指纹比较。
- 迁移只读取/复制 SQLite 页，不生成新的 outbox、不改 clientSeq/opId、不触发同步。
- 重复启动：COMPLETE 且 target 指纹一致才直接打开；中断在 BACKUP_CREATED/COPY_VERIFIED/REGISTRY_COMMITTED/FAILED 时从备份核对/重建目标并继续。
- 目标已存在但内容异常（integrity/指纹不符）时，非 COMPLETE 状态先隔离目标并从备份重建；COMPLETE 状态直接失败关闭，不自动覆盖。
- 归属不明：保留旧库，创建一致性备份，写 `REQUIRES_REVIEW`，应用启动返回可恢复错误；用户可见的手动确认 UI 属于后续版本。
- 恢复完成后 `migrated_from_legacy=true`，确保绑定云账号的旧 Refresh Token 迁移条件仍成立。

## 4. 注册表与原子写入

`AccountRegistry`：

```json
{
  "version": 1,
  "activeAccountId": "default",
  "accounts": [
    {
      "id": "default",
      "kind": "anonymous",
      "createdAt": "...",
      "schemaVersion": 1,
      "lastOpenedAt": "..."
    }
  ]
}
```

- `save()` 前完整校验：版本、ID 唯一、active 存在、anonymous 只能是 default、cloud 必须是规范化合法邮箱且非 default。
- 写入顺序：同目录 temp -> 文件 fsync -> 原子替换 -> 目录 fsync（Unix）。
- Windows `ReplaceFileW` 失败的 fallback：先写 `accounts.json.replace-journal`，再 `target -> .old-*`，再 temp -> target；成功后删除 journal。
- 启动时若 registry 缺失/损坏，扫描 `.old-*`、`.accounts.json.*.tmp` 和 replacement journal：
  - journal 存在时优先使用完整有效的临时新文件，否则使用旧备份；
  - 无 journal 且存在多个互不一致的有效候选时阻断，不从默认账号重建；
  - 只要发现任意已有账号数据库，绝不把缺失 registry 解释为全新安装。
- 注册表缺失：区分“全新安装”和“迁移完成但注册表丢失”；后者直接报错，不创建空 registry 掩盖。
- active 缺失：报错。
- 账号目录：拒绝符号链接、拒绝非目录、`canonicalize` 后必须位于 accounts root 内；数据库文件本身也拒绝符号链接。

## 5. 运行时与凭据边界

- `AppState` 只持有一个当前账号的 `Arc<TodoStore>`；RC2-A 没有账号切换，因此没有热替换路径。
- 启动顺序：迁移/registry -> 打开唯一 SQLite -> 创建提醒 adapter -> 启动 WebView。
- WebView 通过 `native_account_context` 命令读取 active account（不读取路径）。
- `apps/app` 在动态加载 `App`/`cloud.ts` **之前**写入 account profile 和 active id；cloud 配置键为：
  - default: `shishi.cloud.config`
  - account: `shishi.cloud.config.<account-id>`
- 已绑定迁移时，只有旧 cloud config 的 email 与数据库绑定邮箱一致才复制到新账号键；不一致不复制，Cloud 状态回到 disconnected。
- Refresh token 键：
  - `cloud-refresh:default`（legacy）
  - `cloud-refresh:<account-id>`
- 只在绑定归属已通过迁移验证后，把 legacy refresh token 复制到 account key 并删除旧 key；匿名/归属不明不迁移。
- 未来 RC2-B 切换账号必须：停止自动同步/提醒 timer -> 取消当前账号提醒 -> 原子持久化 active -> 关闭旧 Store -> 重建 WebView/AppState；旧连接不得在切换后继续写入。

## 6. 迁移故障与回滚

- 备份失败：不创建账号目录、不写 accounts.json；旧库保留，状态 FAILED。
- 目标复制/校验失败：备份保留；目标临时文件保留/隔离；旧库保留。
- registry 写入失败：目标已验证但 active 未提交；下次启动从状态恢复，不打开空库。
- 完成后任何异常：不删除旧库、不删除 backup。
- 旧版本降级：RC2-A 保留根目录旧库，但迁移后的新写入只进入账号目录；发布说明必须注明降级会看不到新写入。

## 7. RC2-B 契约（未实现）

- 真正的账号切换 UI、热切换、提醒取消/重建、WebView 重建。
- 各账号的云配置读写完全以 active account 为根。
- 账号删除需要 pending-deletion marker 和重试；不得半删除。
- 双窗口、真实 Provider、断电级持久性仍需人工验收。
