# 拾事 V1.0-RC2-D：Native Reliability 架构

## 0. 范围与基线

- 基线：`main` / `54a2b915a6d2d1ec2fc331b56b6c666224a3489f`
- 分支：`feat/rc2d-native-hardening`
- 本设计只覆盖 Native 可靠性、QA 工具链和可安全交付的账号/通知能力；不改变云端协议字段语义，不扩大生产账号删除能力。
- 设计目标：把 RC2-C 中依赖人工时序的故障验证，变成确定性的 `FaultPoint`；把凭据、提醒和通知点击失败变成可测试、可恢复的状态；把 Windows QA 从临时脚本变成可归档、可重复的 Harness。

### 0.1 当前调用图（基线真实代码）

```text
main()
  -> tauri Builder
     -> single-instance / autostart / notification plugins
  -> setup()
     -> db::open_app_store()
        -> app_data_dir()/accounts.json
        -> recover_pending_switch()       # journal 恢复
        -> ensure_active_account()        # migration/registry/active DB
        -> TodoStore::open(active DB)
        -> finish_pending_switch()        # VERIFYING_TARGET -> active
     -> secure_tokens::migrate_legacy_refresh_token() (仅 migrated Cloud)
     -> reminders::create_adapter() + cleanup_foreign_queue()
     -> lifecycle::LifecycleState::load()
     -> app.manage(AppState { store, reminders, account, RuntimeGate })
  -> WebView invoke
     -> todo_storage -> RuntimeGate lease -> TodoStore transaction
     -> native_* account/switch commands
     -> schedule/cancel/reschedule reminders
     -> secure_token_get/set/remove (仅 active account key)
```

账号切换调用链：

```text
CloudPanel
  -> native_prepare_account_switch(target)
     -> ensure_restart_supported / ensure_runtime_active
     -> RuntimeGate.begin_switch(): close gate, wait in-flight (2s max)
     -> accounts::prepare_account_switch(): verify target + PREPARED journal
     -> RuntimeGate.prepare_committed()
  -> window.confirm + cloud.quiesceForAccountSwitch()
     -> stop timers/listeners; invalidate generation; clear sync_session fence
  -> native_request_account_switch(target,generation)
     -> RuntimeGate.begin_request()
     -> cancel_current_account_reminders()
     -> request journal RESTART_REQUIRED
     -> desktop restart process (350ms delay)
  -> new process
     -> open_store_at(): recover_pending_switch()
        -> verify target / registry active / TodoStore::open
        -> finish_pending_switch()
     -> AppState rebuilt; WebView recreated
```

## 1. Switch journal 状态机

持久化文件：`<root>/pending-account-switch.json`，版本 1，字段不变。

```text
                 prepare
ACTIVE ------------------------------> PREPARED
                                         |  request
                                         v
PREPARED ---------------------------> RESTART_REQUIRED
                                         |  startup recovery
                                         v
                               VERIFYING_TARGET (registry active 已更新)
                                         |  DB open + verification
                                         v
                                      ACTIVE (journal 删除)

任意可恢复失败：journal FAILED + error_code
  - 启动恢复先修 registry active，再返回 failure
  - FAILED 不自动重试目标
```

不变量：

1. `PREPARED` 可 abort，且只能 abort；删除 journal 之前 gate 不可写。
2. `RESTART_REQUIRED`/`VERIFYING_TARGET` 不可 abort，也不可把 gate 重开；只能 startup recovery 或整进程冷恢复。
3. `RESTART_REQUIRED`/`VERIFYING_TARGET` 的 target 必须重验 registry/DB/integrity/identity；target 缺失/损坏/身份不符 => `FAILED/TARGET_INVALID` 并恢复 source。
4. registry active 更新与 journal phase 的相对顺序由现有两阶段写入保证；`FAILED` 状态允许启动时修复 active 指针。
5. 旧账号 token、cloud config、outbox 和 DB 不因切换删除。

RC2-D 不改变 journal 文件格式或 phase 枚举；只在状态转换点增加 QA `FaultPoint`。

## 2. RuntimeGate 并发时序

```text
Active  accepting=true, in_flight=0
  |
  | storage lease:
  |   enter_storage(): accepting? -> fetch_add(1) -> recheck accepting
  |
  | begin_switch()
  v
Draining accepting=false
  in_flight>0: wait Condvar, deadline=2s
  in_flight=0: -> Preparing
  timeout: -> DrainFailed; return DrainTimeout
  |
  | prepare_account_switch (+ journal)
  v
Prepared -> (request) RequestInProgress -> RestartRequired
                                      \-> Failed on request/cancel/restart failure
Draining/Preparing failure -> DrainFailed (abort may reopen)
```

- `begin_request` 持有 gate control mutex，覆盖 reminder cancel、journal 写入和 restart spawn 决定；abort 只能等它结束。
- `SwitchRequestGuard::Drop` 在未完成时进入 `Failed`，不允许回到 Prepared；避免 disposed Cloud Controller 与可写 gate 并存。
- `begin_abort` 仅 Active/Prepared/DrainFailed；RestartRequired/Failed 返回不可回退。
- QA 故障点插入 `begin_switch` 后、journal 写入后、registry 更新前后和 DB open 前后；不改变并发锁顺序。

## 3. SQLite 写事务边界

- `TodoStore` 是唯一 SQLite 边界；WebView 只能通过 `todo_storage` 的有限 action 访问，不能传 SQL/path。
- 所有业务写都在 rusqlite transaction 内；`sync_initialize_cloud` 的 registry/DB identity 预检在 transaction 之前完成（RC2-B.1）。
- 切换 gate 关闭后的唯一例外是 `sync_clear_session`（quiesce fence），不写业务数据。
- active account 的 DB 由 `ensure_active_account` 选路；target 打开失败时 `open_store_at` 回滚 source，绝不创建空目标库。
- 故障注入点：
  - `TargetDatabaseBeforeOpen` / `TargetDatabaseAfterOpen`（Tauri）；
  - `SqliteBusy` 当前是数据库打开前的确定性 QA 注入点；真实外部锁竞争的进程级测试仍为 NOT_RUN。
  - `MigrationCopyVerified` 之前与之后分别验证 backup/target fingerprint。
- 不允许用“删除 outbox / 重建空 DB”作为恢复手段。

## 4. Token 与凭据存储边界

当前生产服务名是固定 `app.shishi.todo.secure-token`，不能改，否则已有用户 Refresh Token 全部失联。

目标边界：

```text
secure_tokens (policy + migration)
  -> CredentialBackend (get/set/delete)
     -> OsCredentialBackend
        - production: service = app.shishi.todo.secure-token
        - QA build:   service = app.shishi.todo.rc2d-qa.secure-token
     -> MemoryCredentialBackend (unit tests)
     -> FaultyCredentialBackend (fault injection tests)
```

约束：

- key 仍为 `cloud-refresh:<account-id>`；生产 key 格式不变。
- authorize_secure_key 仍只允许 active account 的 key；B 不能读 A。
- Get 失败只返回错误，不删除任何 key。
- Set 失败不得清除旧的有效 token（OS keyring 的 set 语义需要测试确认；迁移逻辑先读回校验新值）。
- Delete 失败必须返回错误，不能伪装成功。
- legacy token 迁移顺序：读 legacy -> set new -> read new 校验 -> delete legacy。若 delete 失败，新的 token 已可靠保存，旧 token 保留；下一次启动可幂等重试，不能反过来先删旧。
- QA 构建使用独立服务名，绝不触碰生产 service 的 key。

## 5. 系统提醒调度与点击事件流

### 5.1 当前状态

- Desktop `DesktopTimerAdapter` 维护进程内 `HashMap<reminder_id, QueuedReminder>`；`schedule` 会替换同 ID，过去时间返回 `skipped-past`；`cancel` 返回成功但可能队列仍残留（bug/失败点）。
- ID 形状：`account:<account-id>:<task-id>`；旧版可能是无前缀 ID。
- `reschedule_reminders` 差分 reconcile；失败项写入 `failed`，但部分 cancel 错误被忽略（这需要修复）。
- Windows Toast 通过 `tauri-plugin-notification`，当前没有 action/click 路由。

### 5.2 目标通知 target

```text
NotificationTargetV1 {
  account_id: String,
  task_id: String,
  source_version: 1
}
```

- 只在 reminder ID 已经包含 account/task 后生成。
- Windows 通知增加一个 `打开任务` action；action id 是版本化 compact token（URL-safe JSON 或 `v1:<account>:<task>`）。
- `NotificationAction` handler 在 Native thread：
  1. 解析 token；版本/长度/字符白名单。
  2. `list_accounts` 校验 account 存在且等于当前 active；不相等 => 只提示切换账号，不自动切换。
  3. gate 处于 Active；否则暂存/拒绝。
  4. 当前 store 查 task；不存在/已删除 => 丢弃，不按同名/同 task id 路由。
  5. 将 activation 放入 `PendingNotificationActivation`（idempotency id），`show_main_window`，emit `native-notification-activation`。
- WebView 在 mount 完成后调用 `native_take_notification_activation`；Native 在 active account + WebView ready 后才交付。交付契约为 **pop-on-read（一次性消费）**：take 即交付；没有独立的 ACK 接口，重复 take 返回 None。
- 启动 drain：Native 单次 take 最多处理 8 条，跳过并 reject 已无效的记录后返回下一条有效；WebView 注册 listener 后主动循环 take 到 null，单轮上限 8，事件触发的 drain 通过串行 Promise chain 合并。Native 调用失败立即结束当前 cycle，不忙循环。
- 生命周期：App 同步创建 `AbortController`；`onCleanup` 先 abort 再释放 dispatcher。bridge 在动态 import、每个 listener 注册和初始 drain 前后检查取消；取消后注册才返回的 listener 立即 unlisten，禁止再调用 `openTask`/`notify`。
- 冷启动：Native 在任何 active 账号确认前不处理任务打开；pending activation 只保存“已验证但未交付”的 target。若进程重启丢失 activation，则安全丢弃；不得打开错误账号任务。
- 平台能力：Windows 的 `on_action` 已可用；通知正文的 `tap` 不携带 target，因此产品契约使用“打开任务”按钮 action。真实 Toast 点击和双账号拒绝在本轮为 NOT_RUN；无法确认时不伪造端到端 PASS。
- 旧无前缀通知：单元测试通过内存 adapter 创建 legacy/foreign 队列并执行 cleanup；真实 Windows 通知库 fixture **NOT_RUN**，生产不会为了测试直接写真实通知库。

## 6. FaultInjector 架构

### 6.1 类型

```rust
pub enum FaultPoint {
  InstallationPrepared,
  InstallationDatabaseCreated,
  MigrationBackupCreated,
  MigrationCopyVerified,
  SwitchPreparedPersisted,
  SwitchRestartRequiredPersisted,
  SwitchVerifyingTargetPersisted,
  RegistryActiveBeforeUpdate,
  RegistryActiveAfterUpdate,
  TargetDatabaseBeforeOpen,
  TargetDatabaseAfterOpen,
  SwitchJournalBeforeCleanup,
  RegistryReplaceFallback,
  CredentialGet,
  CredentialSet,
  CredentialDelete,
  ReminderCancel,
  SqliteBusy,
}

pub enum FaultAction {
  Error { code: String, message: String },
  Block { duration_ms: u64 },
  Terminate { exit_code: i32 },
}

pub struct FaultEvent { event_id, point, phase, account_id, detail }
pub struct FaultEvidence { event_id, point, phase, at, result }
pub trait FaultInjector: Send + Sync {
  fn decide(&self, event: &FaultEvent) -> Option<FaultAction>;
  fn record(&self, evidence: &FaultEvidence);
}
```

### 6.2 生产/QA 隔离

- `native-accounts` 默认无注入器；`fault-injection` feature 才编译可设置注册表与 QA 实现。
- Tauri `native-qa` feature 启用 `native-accounts/fault-injection`，并在 setup 里读取显式 `--rc2d-fault-config <path>`；**不注册任何 WebView IPC**。
- 生产 Release 不启用 feature；运行时环境变量无法打开注入。
- QA 启动前置校验：identifier 必须严格等于 `app.shishi.todo.qa`；否则拒绝 arm 注入并退出/报告。
- QA 数据根由 Tauri identifier 自动隔离，不允许传入真实用户路径；凭据 service 使用 QA 命名空间。
- evidence JSONL 每行包含 event id、point、phase、结果、时间；不写 token/验证码/完整凭据目标。
- `Terminate` 使用明确的 QA exit code；`Block` 有上限；所有外部等待有 deadline。

### 6.3 测试策略

- 单元测试：内存注入器 + 已实现测试的控制/错误/恢复用例（覆盖 14/18 点）；`fault-injection` feature 测试必须串行执行，因为注入器是进程级的。`CredentialGet/Set/Delete` 和 `RegistryReplaceFallback` 的点级注入测试、`ReminderCancel` 的恢复用例仍为 NOT_RUN。
- QA 命令测试：`SWITCH_PREPARED_PERSISTED` 通过真实 QA 应用触发，验证错误、attempted abort 和 active account 不变，并写入 run-bound evidence。
- **NOT_RUN**：本轮 QA harness 尚未实现“任意点强杀 + 重启后读取 journal/registry/SQLite 快照”的进程级矩阵；只完成可重复的故障配置、证据和 prepared 恢复路径。该缺口在最终报告中保留。
- 生产回归：feature off 编译并运行全部既有测试，确认无注入器时行为与基线一致。

## 7. QA 构建与生产构建隔离

| 维度               | 生产                           | QA                                     |
| ------------------ | ------------------------------ | -------------------------------------- |
| Tauri identifier   | `app.shishi.todo`              | `app.shishi.todo.qa`                   |
| Product name       | 拾事                           | 拾事 QA                                |
| Feature            | 无 `native-qa`                 | `native-qa`                            |
| Fault IPC          | 不存在                         | 不存在（仅启动参数）                   |
| Fault 配置         | 不读取                         | `--rc2d-fault-config` 显式文件         |
| Credential service | `app.shishi.todo.secure-token` | `app.shishi.todo.rc2d-qa.secure-token` |
| Data root          | 生产 app data                  | QA app data（独立 identifier）         |
| Installer          | 不自动生成/不发布              | unsigned QA NSIS/APK，明显标识         |
| 测试账号           | 禁止                           | `*.example.test` + 本地 API            |

QA package never writes production keys/data. All destructive fixtures use temp dirs or QA identifier roots; cleanup only resources recorded in the current run manifest.

## 8. 多平台验收策略

| 平台        | 本轮目标                                                     | 真实 PASS 条件                                              |
| ----------- | ------------------------------------------------------------ | ----------------------------------------------------------- |
| Windows x64 | QA NSIS + real app harness + Credential Manager/notification | 有真实安装、真实进程、真实凭据/通知证据                     |
| macOS ARM64 | CI `cargo check --features native-qa`（编译检查）            | 只在有 runner/真机时声明构建/测试 PASS；不声称通知点击 PASS |
| Linux x64   | CI `cargo check --features native-qa`（编译检查）            | headless 环境不声称构建/系统通知 PASS                       |
| Android     | unsigned debug APK when SDK available                        | 无真机时 NOT_RUN                                            |
| iOS         | Rust/Swift bridge compile when available                     | 无签名/模拟器真机时 NOT_RUN                                 |

CI 只产出 unsigned QA artifacts；不自动触发正式 Release。发布门禁拆成：

- `CODE_RC_READY`：源码、单测、lint、构建、单元级故障测试全部通过。
- `PLATFORM_RELEASE_READY`：仅在目标平台真实安装包、凭据、通知、兼容性验收均 PASS 时另行标记。

## 9. 回滚、安全性、兼容性

### 9.1 兼容性

- 不改变 `accounts.json` / journal / migration state / cloud snapshot / outbox 格式。
- 不改变 `todo_storage` action 和现有 native command 参数。
- 新增 command 只有通知 activation/diagnostics；旧 WebView 不调用也能运行。
- 生产 Credential service 名不变；新增 QA service 只在 QA feature 编译。
- 通知 action 是新增产品行为；旧通知仍能显示/清理。

### 9.2 安全

- account ID 只能来自 Native registry；WebView 不能指定打开其他账号任务。
- 通知 target 通过 account + task 双重校验；不匹配时只提示，不自动切换。
- 故障注入无生产 IPC；QA 配置不能由 WebView/环境变量开启。
- diagnostics 脱敏：不导出 token、验证码、真实凭据 target、完整用户邮箱；只导出 account 摘要哈希/ID、文件名、状态和错误码。

### 9.3 回滚

- QA 构建和生产构建分离；关闭 `native-qa` feature 即回到无注入路径。
- 通知路由是增量行为；失败时可安全丢弃 activation，不影响本地任务。
- 凭据后端重构保留生产函数签名和 service 名；若 QA backend 异常，生产代码编译路径不包含它。
- 性能改动必须先有基准；无法证明安全的全表扫描/索引改动不强行合入。

### 9.4 改造变更矩阵

| 改造                               | 持久化格式                                          | IPC 契约                                                             | 产品行为                                       |
| ---------------------------------- | --------------------------------------------------- | -------------------------------------------------------------------- | ---------------------------------------------- |
| FaultInjector / FaultPoint         | 不改变业务文件；QA 另写 evidence JSONL              | 无注入 IPC；新增只读 `qa_build_identity` 生产探测命令（不 arm 故障） | 生产无变化                                     |
| CredentialBackend                  | Token key 格式不变；生产 service 名不变             | `secure_token_*` 参数/返回不变                                       | 生产无变化；QA 使用独立 service                |
| Legacy token 迁移顺序              | 不改变 key，增加读回校验                            | 不改变                                                               | 失败时保留旧 token，不伪造成功                 |
| ReminderAdapter 失败处理           | 不改变                                              | 报告字段只增不改（`failed` 已有）                                    | 取消/调度失败显式诊断，不再静默成功            |
| NotificationTargetV1 click routing | 不写入 DB；activation 仅内存                        | **新增** activation command/event                                    | **新增**“打开任务” action；body tap 不路由任务 |
| Legacy reminder fixture/cleanup    | 不改变                                              | QA fixture 不暴露生产 IPC                                            | 生产旧队列清理更严格                           |
| QA Harness / CI                    | 不写入生产数据（identity guard 之后才执行 fixture） | 新增只读 `qa_build_identity`；不新增故障 arm IPC                     | 生产无变化                                     |
| Diagnostics export                 | 新增脱敏 JSON 文件                                  | **新增**只读 diagnostics command                                     | **新增**可见诊断/导出按钮（不 force-bind）     |
| 性能优化                           | 不改变 schema/格式                                  | 不改变                                                               | 仅在证据支撑下改变查询路径                     |
