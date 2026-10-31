# 拾事 Native（Tauri 2 + SQLite）

本文档说明 `apps/native` 与 `crates/native-core` 的实现、开发运行方式、数据一致性保证和当前限制。

## 1. 目录与职责

```text
crates/native-core/           纯 Rust SQLite 仓库（不依赖 Tauri，可直接测试）
  src/models.rs               domain DTO，serde camelCase 契约
  src/store.rs                迁移、参数化 CRUD、事务、outbox、同步落库
  src/dispatch.rs             固定 todo_storage action 表
  tests/repository.rs         in-memory SQLite 回归测试

apps/native/
  icon.svg                    品牌图标源文件
  scripts/generate-icons.py   生成 PNG/ICO 的可复现脚本
  plugins/tauri-plugin-shishi-reminder/
    src/                      Rust mobile bridge（仅移动端注册平台实现）
    android/                  AlarmManager / NotificationManager / BOOT_COMPLETED
                              + AndroidKeyStore AES-GCM secure tokens
    ios/                      UNUserNotificationCenter / 64 条 / 30 天窗口
                              + Security.framework Keychain secure tokens
  src-tauri/
    src/main.rs               桌面/移动进程入口
    src/lib.rs                Tauri Builder、插件/命令注册、窗口生命周期
    src/db.rs                 app data 路径、AppState、专用连接
    src/commands.rs           todo_storage、提醒、桌面设置、安全令牌命令
    src/reminders.rs          统一 ReminderAdapter、桌面队列、移动插件桥
    src/desktop_shell.rs      系统托盘、显示/隐藏/退出
    src/lifecycle.rs          关闭行为偏好、开机自启状态
    src/secure_tokens.rs      桌面 keyring / 移动插件桥
    src/security.rs           固定 action allowlist 与导航白名单
    tauri.conf.json           窗口、CSP、构建路径、bundle
    capabilities/default.json 最小 capability
    icons/                    32/64/128/256/512 PNG + ICO
```

`apps/native/src-tauri/Cargo.toml` 是独立 Cargo workspace，避免 Tauri 移动端构建与根服务端 workspace 相互影响。它通过 path 依赖 `crates/native-core`。

## 2. 环境要求

- Rust stable 1.96（或项目声明的更高版本）、`rustfmt`。
- Node.js 22+、pnpm 10+。
- Windows：WebView2 Runtime；安装 Visual Studio Build Tools（MSVC + Windows SDK）。
- macOS：Xcode Command Line Tools。
- Linux：Tauri 2 要求的 WebKitGTK、GTK、libappindicator 等系统依赖，见 <https://v2.tauri.app/start/prerequisites/>；桌面安全令牌还需要 Secret Service（GNOME Keyring/KWallet）及 `libdbus-1-dev` 等构建依赖。
- Android：Android Studio、Android SDK/NDK、`adb`（当前工作区不具备）。
- iOS：macOS、Xcode、Apple Developer 签名（当前工作区不具备）。
- Tauri CLI 2：

```bash
cargo install tauri-cli --version "^2"
```

首次原生构建会下载并编译 Tauri 依赖，耗时明显长于 `cargo test` 单测。

## 3. 桌面运行与构建

先安装前端依赖：

```bash
pnpm install
```

开发：

```bash
cd apps/native/src-tauri
cargo tauri dev
```

`beforeDevCommand` 为 `pnpm --dir ../../app dev`，`devUrl` 为 `http://localhost:5173`。发布构建：

```bash
cd apps/native/src-tauri
cargo tauri build
```

`beforeBuildCommand` 为 `pnpm --dir ../../app build`，`frontendDist` 为 `../../app/dist`。路径均相对于 `src-tauri` 目录。

仅检查 Rust：

```bash
cargo test -p todo-native-core
cargo clippy -p todo-native-core --all-targets -- -D warnings
cd apps/native/src-tauri
cargo check -p todo-native
cargo clippy -p todo-native --all-targets -- -D warnings
cargo test --lib   # [profile.test] debug=0 规避 Windows PDB LNK1318
```

### 构建身份：Stable / Dev / QA

构建身份由 Tauri `identifier` 决定，并**逐层**推导出数据根、SQLite、Credential namespace、
Windows AUMID、单实例标识、托盘/自启标识与安装程序身份。仅修改窗口标题或安装包文件名
不构成隔离。

| 通道   | 配置文件                                  | identifier            | Credential service                     | 数据根（Windows）               |
| ------ | ----------------------------------------- | --------------------- | -------------------------------------- | ------------------------------- |
| Stable | `tauri.conf.json`                         | `app.shishi.todo`     | `app.shishi.todo.secure-token`         | `%APPDATA%\app.shishi.todo`     |
| Dev    | `tauri.conf.json` + `tauri.dev.conf.json` | `app.shishi.todo.dev` | `app.shishi.todo.dev.secure-token`     | `%APPDATA%\app.shishi.todo.dev` |
| QA     | `tauri.conf.json` + `tauri.qa.conf.json`  | `app.shishi.todo.qa`  | `app.shishi.todo.rc2d-qa.secure-token` | `%APPDATA%\app.shishi.todo.qa`  |

- Dev/QA 用 `--config` 做**深层合并**，不修改正式配置文件：
  `cargo tauri build --config src-tauri/tauri.dev.conf.json`。
- Credential service 由运行时 identifier 派生（`build_identity::resolve`），不再由 cargo feature
  选择。**无法识别的 identifier 直接报错**，不会回退到任何命名空间——打包写错 identifier 的产物
  无法读写其它通道的凭据。
- `native-qa` feature 只保留“故障注入 + 可注入 credential backend”，与通道隔离正交：Dev 构建
  **不**启用它，且必须是功能完整的正式产品形态。QA 构建启动时仍强制校验 identifier 为
  `app.shishi.todo.qa`，否则拒绝 arm 注入并启动失败。
- 运行时自检：`qa_build_identity` 命令返回 `channel` / `isDev` / `isQa` / `identifier` /
  `dataRoot` / `credentialService` / `faultInjectionEnabled`，用于安装包验收时核对身份。
- **已有 `0.0.1-dev.0` 兼容性**：该预发布使用 Stable 身份构建，其数据留在 Stable 数据根与
  Stable 凭据命名空间。Dev 构建**不会**自动读取或迁移这些数据；需要时按
  `docs/acceptance/v1.0-rc2d.11-native-reliability-and-distribution.md` 的手动步骤（关闭应用后
  复制文件）显式迁移，旧数据原样保留、可撤销。

### 图标

`icons/` 已包含 `32x32.png`、`64x64.png`、`128x128.png`、`128x128@2x.png`、`icon-512.png`、`icon.png`、`icon.ico`。`tauri.conf.json` 只引用这些实际存在的文件。需要重新生成时：

```bash
python apps/native/scripts/generate-icons.py
```

脚本需要 Pillow。仓库目前未放 `.icns`；macOS 正式分发前应执行 `cargo tauri icon apps/native/icon.svg`（Tauri CLI 会生成完整平台图标集），或补充 `.icns`。当前配置没有引用不存在的 `.icns`。

## 4. 前端存储契约

前端只调用：

```ts
invoke('todo_storage', {
  request: { action: string, payload: object },
});
```

`todo_storage` 是唯一存储入口。JSON 使用 domain camelCase；SQLite 列使用 snake_case。成功时返回 domain 对象或 `null`。失败时 `invoke` 会以 `{ code, message }` 拒绝，`code` 例如 `VALIDATION_FAILED`、`NOT_FOUND`、`INVALID_DATE`、`UNSUPPORTED`、`DATABASE_ERROR`。

Action 集合定义在 `crates/native-core/src/dispatch.rs`，与需求一致：

`initialize`, `list_lists`, `create_list`, `patch_list`, `delete_list`, `restore_list`,
`create_task`, `patch_task`, `get_task`, `list_tasks`, `get_counts`, `commit_completion`,
`delete_task`, `restore_task`, `reorder_task`, `list_day_plan`, `add_to_day`,
`remove_from_day`, `create_step`, `patch_step`, `delete_step`, `export_data`,
`import_data`, `clear_all`, `get_device_id`, `get_sync_cursor`, `pending_mutations`,
`apply_server_result`, `bootstrap_required`, `rotate_device_id`, `sync_diagnostics`,
`sync_set_enabled`, `sync_clear_rejected`, `sync_clear_account_binding`,
`sync_initialize_cloud`, `sync_replace_snapshot`.

规范 payload 是直接对象，例如：

```ts
{ action: 'create_task', payload: { title: '写周报', planDate: '2026-10-21' } }
{ action: 'list_tasks', payload: { view: 'my-day', localDate: '2026-10-21' } }
```

为兼容早期生成的适配器，`create_list` / `create_task` 也接受 `{ input: ... }`，`list_tasks` 也接受 `{ query: ... }`；新代码应使用直接 payload。

`pending_mutations` 返回：

```json
[
  {
    "opId": "019...",
    "deviceId": "019...",
    "clientSeq": 12,
    "entity": "task",
    "entityId": "019...",
    "kind": "patch",
    "patch": { "title": "新标题" },
    "createdAt": "2026-10-21T06:00:00.000Z",
    "status": "pending"
  }
]
```

`apply_server_result` 接受 `{ acks, changes, nextCursor }`。ack/change 的字段同时接受 camelCase 和 API 的 snake_case 别名（`op_id`、`server_seq`、`entity_id`、`next_cursor`、`error_code`）。`status = applied | already_processed | accepted` 的 outbox 行会删除；`rejected` 会保留并标记为 rejected。处理 acks/changes 后，对 ack 对应的 outbox 实体和 change 实体去重，统一按 shadow + 剩余 pending 重建物化行：rejected 的本地 patch 会从 shadow 回落，pending 的同实体字段（包括同字段）保持本地值；cursor 写入 `kv_state`。

### 云同步专用 action

| Action                       | Payload                                              | 返回 / 行为                                                                                                                                                                                                                          |
| ---------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `rotate_device_id`           | 无                                                   | 新 UUIDv7。重写现有 outbox 的 deviceId，status 置 `local`，clientSeq/cursor 归零，sync 关闭，epoch 内 opId 保持不变。                                                                                                                |
| `sync_diagnostics`           | 无                                                   | `{ enabled, deviceId, cursor, pending, rejected, boundAccount }`。                                                                                                                                                                   |
| `sync_set_enabled`           | `{ enabled }`                                        | 关闭时 pending→local；开启时 local→pending；持久化 `sync_enabled`。                                                                                                                                                                  |
| `sync_clear_rejected`        | 无                                                   | 删除 rejected outbox；对受影响实体，若存在 shadow，则按 shadow + 剩余 pending 重新物化。没有 shadow 时不破坏现状。                                                                                                                   |
| `sync_clear_account_binding` | 无                                                   | 清空 boundAccount，关闭 sync，cursor/clientSeq 归零，删除全部 outbox。物化数据保留。                                                                                                                                                 |
| `sync_initialize_cloud`      | `{ snapshot, mode: 'merge'\|'cloud', accountEmail }` | 返回 `{ preparedOps }`。cloud：清空物化/outbox/shadow 后导入远端；merge：按 id + updatedAt 显式合并，生成 list→task→step→day_plan 顺序的 pending outbox。写远端 shadow、账户绑定、cursor、enabled=true。日计划唯一槽冲突以远端为准。 |
| `sync_replace_snapshot`      | `{ snapshot }`                                       | cursor rebound/rebase：保留 pending outbox，清空并写回远端 shadow，以“远端 + pending 重放”重建受影响实体，更新 cursor。                                                                                                              |

`CloudSnapshot` 的字段为 `{ cursor, lists, tasks, steps, dayPlans }`，全部使用 domain camelCase。merge 模式中本机 removed（tombstone）与远端状态按 `updatedAt` 决定 create/patch/delete/restore；云端已有记录优先于本机旧记录。所有 snapshot/outbox 写入同一 SQLite transaction。

### Secure token 命令

注册了 `secure_token_get(key)`、`secure_token_set(key,value)`、`secure_token_remove(key)`。桌面通过 `keyring` crate 使用 Windows Credential Manager / macOS Keychain / Linux Secret Service，服务名由运行时 identifier 派生（Stable `app.shishi.todo.secure-token`、Dev `app.shishi.todo.dev.secure-token`、QA `app.shishi.todo.rc2d-qa.secure-token`；见第 3 节“构建身份”）。无法识别的 identifier 会明确报错，不会回退到任何命名空间。Linux 构建需要可用的 Secret Service/DBus 运行环境；无桌面密钥环时应明确报错而不是降级明文。

移动端通过同一个本地 Tauri 插件的 `secureTokenGet`、`secureTokenSet`、`secureTokenRemove` 命令写入系统安全存储，不暴露给 WebView：

- **Android**：每个逻辑 token 使用独立的 AndroidKeyStore AES-256-GCM 密钥；shared preferences 文件 `shishi_secure_tokens` 中仅保存 SHA-256 哈希后的 preference key，以及 `{ keyAlias, iv, ciphertext }` 三个 Base64/别名值。明文 token 不写入 SharedPreferences、SQLite、日志或 localStorage。`remove` 删除对应 Keystore alias 和密文记录；未知 key 或重复删除为成功 no-op。使用平台 API，没有新增需要联网下载的 Gradle 依赖。
- **iOS**：Security.framework Keychain，`kSecClassGenericPassword`，固定 service 为 `app.shishi.todo.secure-token`，account 为经过校验的 token key；数据使用 `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`，不进入 iCloud 同步。`remove` 删除对应 item，`errSecItemNotFound` 视为成功。

移动命令的 get 返回 `{ value: string | null }`，由 Rust bridge 转成与桌面一致的 `Option<String>`；set/remove 成功无返回。令牌同样绝不写入 localStorage 或 SQLite。Keystore 密钥可能因系统恢复/应用数据异常失效，此时读取明确报错并可在登录后重新 set；不会自动降级到明文。

> 当前工作区没有 Android SDK/Xcode，Android/iOS 原生安全存储只完成了源码与静态契约审查，**未在本机编译或真机验证**。发布前需按第 8 节在 Android/iOS 设备验证首次写入、覆盖、重启读回、删除幂等和卸载/升级行为。

前端 Tauri 平台的 `SecureTokenStore` 已接到上述三个命令：`apps/app/src/adapters/platform.ts`
的 `TauriTokenStore` 在登录、刷新和退出时读写 OS 凭据库。Web 平台不把 refresh token
放进 localStorage，而是依赖服务端 HttpOnly Cookie；`LocalTokenStore` 仅保留为无安全
存储时的旧兼容实现，不被云同步使用。

## 5. SQLite 架构与保证

- 专用连接：`TodoStore` 持有 `Arc<Mutex<rusqlite::Connection>>`。Tauri 命令把整个操作移到 `tauri::async_runtime::spawn_blocking`，避免在 async runtime 上执行阻塞 SQL。
- PRAGMA：每个连接执行 `journal_mode=WAL`、`foreign_keys=ON`、`busy_timeout=5000ms`、`synchronous=NORMAL`、`temp_store=MEMORY`。
- 迁移：`schema_migrations` + version 1 SQL；在既有早期表上会补齐 `created_at` / `updated_at` 列。数据在首次打开时创建于应用数据目录的 `shishi.sqlite3`，路径不接受前端输入。
- 参数化 SQL：全部值使用 `params!` / `params_from_iter`；动态 SQL 只拼接内部固定的列名与表名。WebView 没有 SQL、shell、任意文件系统能力。
- 软删除：任务、清单、步骤、我的一天都使用 `deleted_at`。`delete_list` 同时在同事务内把未删除任务 `list_id` 设为 `NULL`；`restore_list` 不自动把任务移回清单。
- 时间与排序：日期字段为 `YYYY-MM-DD`，instant 统一规范化为 UTC ISO-8601（毫秒）；`updated_at` 在每次可变操作中更新。
- 我的一天：`UNIQUE(task_id, local_date)`；`add_to_day` 对已有 tombstone 执行 restore，不会触发唯一约束冲突。
- 导出包含 tombstone（用于完整恢复）；导入 `replace` 清空实体、outbox、shadow，`merge` 不清理。导入的每条实体同样追加一条 outbox mutation。
- `clear_all` 删除实体、步骤、我的一天、outbox、shadow，但保留 `kv_state`（设备 ID、client_seq、cursor 等）。

### Outbox 保证

所有会改变 task/list/step/day_plan 物化数据的命令都在**同一个 SQLite transaction** 内：

1. 写/软删除物化行并更新 `updated_at`；
2. 读取 `kv_state.device_id`，递增 `kv_state.client_seq`；
3. 生成 UUIDv7 `op_id`；
4. 写入 `outbox`：sync 关闭时为 `sync_status='local'`，开启时为 `'pending'`。

任一 SQL 或约束失败会回滚整组操作。测试用一个故意重复的 `nextTask` 覆盖了「完成更新 + 首条 outbox 已写、下一任务插入失败」的回滚路径。

`client_seq` 在设备内单调递增且会跳过已有 outbox 的最大序号（rotate 后重新分配历史序号），`UNIQUE(device_id, client_seq)` 约束保证不会重复。`get_device_id` 在缺失时创建 UUIDv7-like 值。初始 `get_sync_cursor` 返回 `"0"`，可被云端 `ChangeCursor` 解析。

`pending_mutations` 的 `patch` 是 domain camelCase（例如 `{"listId":null}`），而当前 Axum API 的 sync patch 解析使用 snake_case。接入同步时，Tauri SyncStore 的 transport 层必须做 camelCase → snake_case 映射，或由 API 明确同时接受两种键名；不要在 SQLite 中直接存 snake_case JSON。

## 6. 提醒桥接

已注册的原生命令：

```text
schedule_reminder(reminderId, fireAtUtc, title, body, exact?)
cancel_reminder(reminderId)
reschedule_reminders()
reminder_permission() -> 'granted' | 'denied' | 'prompt'
request_reminder_permission() -> 'granted' | 'denied' | 'prompt'
set_badge_count(count)
```

`ReminderAdapter` 是统一平台接口（schedule / cancel / clear / permission / request_permission）。桌面实现：

- 使用通知插件请求/检查权限与发送即时通知；
- 使用 Rust 后台线程 + `Mutex + Condvar` 的进程内队列，等待最近一条未来提醒；
- 相同 `reminderId` 会替换旧计划，过去时间会忽略；
- `reschedule_reminders` 查询 SQLite 中未完成且有 `remind_at` 的任务，重建队列；
- 退出进程后定时器消失；下次启动需要前端再次调用 `reschedule_reminders`。系统休眠/时钟调整后可能延迟，不是 OS 级可靠调度。

移动端通过本地 `tauri-plugin-shishi-reminder` 调用平台调度：

- **Android**：`AlarmManager` + `PendingIntent` + `BroadcastReceiver`，默认 `setAndAllowWhileIdle`（非精确、可在 Doze 下触发）。可选 `exact=true` 只在 `canScheduleExactAlarms()` 为真时使用 `setExactAndAllowWhileIdle`，任何权限/系统拒绝都会回退到 inexact，返回 mode 中可见。`NotificationManager` 建 channel 并发通知；SharedPreferences 保存待处理队列；`BOOT_COMPLETED` / QuickBoot receiver 重建闹钟。Android 13+ `POST_NOTIFICATIONS` 在 schedule 前请求。
- **iOS**：`UNUserNotificationCenter` 本地通知；运行时请求授权；只调度 30 天内提醒，最多 64 条 pending；相同 identifier 覆盖；启动/前台调用 `reschedule_reminders` 重建。前台由 delegate 展示 banner/sound。
- 移动端不再返回“未实现”；`ReminderAdapter` 由 `#[cfg(mobile)]` 接插件，桌面构建不依赖 Android/iOS SDK。
- **能力/权限限制**：Android 厂商可能杀后台或延迟闹钟；`SCHEDULE_EXACT_ALARM` 是特殊权限，Google Play/国内商店政策可能限制，因此不作为默认路径。若商店审核不接受该权限，可从插件 manifest 移除，代码仍安全降级为 inexact。iOS 超过 64 条或 30 天窗口的提醒会跳过/拒绝并等待下次启动重建。系统重启、强制停止、省电模式仍可能导致不触发，无法承诺 100% 准点。

`set_badge_count` 调用 Tauri 窗口 badge API；Windows 当前由 Tauri 标记为不支持（UI 已把角标当作可选增强）。

### 桌面生命周期

- 系统托盘菜单：显示拾事 / 隐藏到托盘 / 退出拾事；左键托盘图标恢复主窗口。图标由 Tauri 配置的默认应用图标提供。
- 单实例：`tauri-plugin-single-instance` 保证第二个进程聚焦已有窗口。
- 开机自启：`tauri-plugin-autostart`；自定义命令 `get_desktop_settings`、`set_autostart` 查询/切换。自启参数 `--autostart` 默认隐藏窗口，托盘可恢复。
- 关闭行为：`set_close_to_tray(enabled)` 持久化到 app config 的 `desktop-settings.json`，不写入 SQLite。默认关闭即退出；开启后点窗口关闭按钮仅隐藏。`get_desktop_settings` 返回 `{ closeToTray, autostartEnabled, autostartSupported }`。前端在“设置与数据 → 桌面”提供两个开关，修改立即生效。
- Linux 桌面需要 Secret Service（keyring）与常规托盘支持；无系统托盘/Wayland 限制的发行版仍可直接运行，关闭行为需配合设置调整。

## 7. 安全

- CSP 禁止远程脚本、`eval`、`object`、`frame`；允许的 connect 目标为 Tauri IPC、本地开发服务器（仅 dev）与 HTTPS/WSS API。
- `security.rs` 在 IPC 入口执行固定 action allowlist；未知 action 在进入数据库前被拒绝。
- Tauri 导航插件只允许 app 内部协议，开发模式额外允许 `http://localhost:5173`；外部 URL 必须交给系统浏览器处理。
- `capabilities/default.json` 只授予 `core:default` 与 `notification:default`，未启用 SQL 插件、shell、fs 或任意 URL 打开权限。
- 数据库路径由 Rust 端从应用数据目录计算，不接受路径参数；不暴露任意 SQL 执行接口。

## 8. 移动端打包步骤

前提：先完成桌面构建验证，并安装 Android Studio/SDK/NDK 或 Xcode。

```bash
cd apps/native/src-tauri

# Android（会生成被 .gitignore 忽略的 gen/android）
cargo tauri android init
cargo tauri android dev

# iOS（仅 macOS）
cargo tauri ios init
cargo tauri ios dev
```

移动插件源码位于 `apps/native/plugins/tauri-plugin-shishi-reminder`，应用 `src-tauri/Cargo.toml` 通过 path 依赖并只在 `#[cfg(mobile)]` 注册它。Tauri CLI 会从 Cargo metadata 读取插件的 `android/` 与 `ios/` 目录；桌面 check 不编译平台源码。

### Android 生成项目 patch / 校验

Android 库自身的 `android/src/main/AndroidManifest.xml` 已声明：

- `POST_NOTIFICATIONS`、`RECEIVE_BOOT_COMPLETED`、`SCHEDULE_EXACT_ALARM` 权限；
- `ReminderAlarmReceiver`（exported=false）与 `ReminderBootReceiver`（BOOT_COMPLETED/QUICKBOOT，exported=true）。

Gradle 会将这些条目合并到 `gen/android/app/src/main/AndroidManifest.xml`，因此**通常不需要手工编辑生成 manifest**。如果团队关闭了 library manifest 合并，需要手工补入上述权限和 receiver；receiver 的类名是 `app.shishi.todo.reminder.ReminderAlarmReceiver` / `ReminderBootReceiver`。插件类由 Rust `api.register_android_plugin("app.shishi.todo.reminder", "ReminderPlugin")` 注册，不要手工修改生成 Java 包。

`android/app/build.gradle` 的 `minSdk` 必须 ≥24，compileSdk 使用 Tauri 生成的版本（插件默认 36）。运行：

```bash
cd apps/native/src-tauri
cargo tauri android init
python ../scripts/verify-mobile-project.py android
cargo tauri android dev
```

### iOS 生成项目 patch / 校验

iOS **不需要** Info.plist 权限描述键来请求本地通知；`UNUserNotificationCenter.requestAuthorization` 只使用运行时授权。不需要 Push Notifications entitlement 或后台推送 capability。插件在 `load(webview:)` 中设置 `UNUserNotificationCenterDelegate`，用于前台显示。

Tauri CLI 会把 `ios/Package.swift` 链接进生成工程，Rust 用 `api.register_ios_plugin(init_plugin_shishi_reminder)` 注册 Swift 类。运行：

```bash
cd apps/native/src-tauri
cargo tauri ios init
python ../scripts/verify-mobile-project.py ios
cargo tauri ios dev
```

### 不要提交生成物

`apps/native/src-tauri/gen/`（Android Gradle、Xcode 工程）和 `target/` 均为本地生成物，已由 `apps/native/src-tauri/.gitignore` 与根 `.gitignore` 忽略。真机签名、AndroidManifest/Info.plist 的本地 team 配置只保留在开发者机器。

### 真机验收矩阵

| 平台                | 场景                           | 期望                                                                             |
| ------------------- | ------------------------------ | -------------------------------------------------------------------------------- |
| Android 12+         | 未授予通知权限                 | schedule 前请求；拒绝后明确报错，不假成功                                        |
| Android 12+         | 普通模式 / Doze / 省电模式     | inexact 可触发；记录 OEM 延迟，不承诺分钟级准点                                  |
| Android 12+         | 开启精确闹钟权限，`exact=true` | 使用 exact；无权限时回退 inexact 且返回值 mode 正确                              |
| Android 12+         | 重启、解锁后                   | BOOT receiver 从持久队列重建未来闹钟                                             |
| Android 12+         | 应用被强行停止                 | 多数 OEM 会取消/冻结闹钟，需重新打开 app；作为已知限制                           |
| Android 13+         | 点击通知                       | 启动 app，通知可取消；通知权限拒绝时无通知                                       |
| iOS 15+             | 首次请求授权/拒绝              | 状态 granted/denied/prompt 正确                                                  |
| iOS 15+             | 前台/后台/划掉 app             | 前台 delegate 显示；后台由系统 local notification 触发                           |
| iOS 15+             | 30 天内 / 30 天外              | 30 天内调度；30 天外跳过并等待下次启动重建                                       |
| iOS 15+             | 已有 64 条 pending             | 新 reminder 明确拒绝，不静默覆盖其他任务                                         |
| iOS 15+             | 时区/DST/重启                  | 系统按本地触发；不假定 UTC 固定间隔                                              |
| Android 12+         | token set/get/覆盖/remove      | 密文写入 SharedPreferences；删除后 Keystore alias 与记录均消失；重复 remove 成功 |
| Android 12+         | token 后重启 app               | 能解密读回；应用数据被系统恢复导致密钥失效时明确报错，不返回明文                 |
| iOS 15+             | token set/get/覆盖/remove      | Keychain service/account 正确；无 item 时 get 为 null；重复 remove 成功          |
| iOS 15+             | token 后重启设备/更新 app      | 首次解锁后可读回；删除后 Keychain item 不存在                                    |
| Windows/macOS/Linux | 托盘、关闭、单实例、自启       | 托盘显示/隐藏/退出；第二实例聚焦已有窗口；关闭行为设置生效；自启状态可查询       |
| Windows/macOS/Linux | keyring                        | 保存/读取/删除 refresh token；无凭据服务时报错不降级                             |

### 当前环境验证边界

本工作区没有 Android SDK、`adb`、Android 模拟器，也没有 macOS/Xcode，因此 Android/iOS 只能进行源码与静态布局审查，未做 Gradle/Xcode 编译、模拟器启动、真机权限/重启验收。AndroidKeyStore/Keychain token 的读写、覆盖、重启和删除幂等同样未在本机真机验证。具体系统版本、OEM 省电策略、iOS 64 条限制和通知授权弹窗必须在对应设备/CI 完成。

## 9. 集成注意事项

根 `Cargo.toml` 已包含 `crates/native-core`：

```toml
[workspace]
members = ["apps/api", "crates/native-core"]
exclude = ["apps/native/src-tauri"]
```

如果从旧版本分支合并，需要确保成员列表含 `"crates/native-core"` 且没有把它放在 `exclude` 中。不要加入 `apps/native/src-tauri`：该 crate 自带独立 `[workspace]`，使用自己的锁文件和 target 目录，避免 Tauri 移动端构建污染根 workspace。

前端调用命令名：

```text
todo_storage
schedule_reminder / cancel_reminder / reschedule_reminders
reminder_permission / request_reminder_permission
set_badge_count
get_desktop_settings / set_close_to_tray / set_autostart
secure_token_get / secure_token_set / secure_token_remove
```
