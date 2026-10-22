# 02 · 同步与账号体验设计

## 1. 账号资料与多账号

### 决策

- 每个云账号拥有独立的本地数据库命名空间，避免任务、outbox、cursor 混用。
- Web：IndexedDB 名 `shishi-todo:<accountId>`；首个匿名库仍为 `shishi-todo`。
- Tauri：SQLite 文件名由活动账号决定；账号切换后重启应用。
- 账号注册表存 `localStorage` 的 `shishi.accounts.v1`：
  ```json
  [{ "id": "uuid", "email": "...", "apiUrl": "...", "platform": "web|tauri", "lastUsedAt": "..." }]
  ```
- 活动账号存 `shishi.active-account.v1`。
- 切换账号必须：
  1. 确认当前账号已同步或有本机备份；
  2. 保存资料并 reload；
  3. 打开对应数据库；
  4. 若 refresh 凭据不属于该账号，则进入“重新验证邮箱”状态，不删除本机数据。

### Web 限制

浏览器 refresh token 使用 HttpOnly Cookie，同一 API origin 只保留一个会话。切回旧账号需要重新验证码登录；本机数据仍在。Tauri 使用按账号命名的系统安全存储条目，可恢复会话。

### 验收

- 两个账号的任务互不出现。
- 切换账号不会清空任何账号数据。
- 同一账号切回后可继续同步。
- 账号注册表支持移除“仅本机”资料，但必须先确认。

## 2. 冲突与拒绝详情

当前只显示 rejected 数量。新增 `sync_rejections` 本地表：

```text
op_id, entity, entity_id, kind, patch_json, error_code, rejected_at
```

UI：

- 同步面板显示“N 个失败操作”。
- 展开列表：实体类型、实体标题/ID、变更字段、错误码、时间。
- 操作：`放弃本地变更`（回滚到 shadow）、`复制诊断`。
- 数量为 0 时隐藏区块。

## 3. 云端导出

- 复用 `GET /api/v1/export`，前端 `AuthClient.exportAccount()`。
- 同步面板增加“下载云端完整备份”。
- 文件名 `shishi-cloud-backup-<date>.json`。
- 导出结果不包含 token、refresh hash、验证码。
- 断网/401 时提示重新登录，不写本机。

## 4. 诊断包

`GET /diagnostics` 只生成本地 JSON，不上传：

```json
{
  "appVersion": "1.1.0",
  "platform": "web",
  "generatedAt": "...",
  "cloud": {
    "apiUrl": "...",
    "phase": "connected",
    "deviceId": "...",
    "cursor": "...",
    "pending": 0,
    "rejected": 0
  },
  "counts": { "tasks": 0, "lists": 0 },
  "recentErrors": []
}
```

不包含任务标题、备注、邮箱、token。设置页“同步”提供下载。

## 5. Web Push

### 服务端

- 新表 `push_subscriptions`：user_id, endpoint, p256dh, auth, user_agent, created_at, last_success_at, disabled_at。
- `GET /api/v1/push/public-key` 返回 VAPID public key。
- `POST /api/v1/push/subscribe` / `DELETE /api/v1/push/subscribe`。
- 后台 worker 每 30 秒查看到期 `tasks.remind_at`，通过 Web Push 发送；用 `push_delivery_log(task_id, occurrence_key)` 唯一约束防重复。
- 生产必须配置 `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT`；未配置时功能关闭并明确返回 503。

### Web 客户端

- 设置页增加“后台提醒（Web Push）”，仅 HTTPS/localhost 可用。
- `service-worker` 增加 `push`/`notificationclick`。
- 订阅失败、权限拒绝、VAPID 缺失均有明确文案。
- local-first 原则：Web Push 只覆盖已同步到云端的提醒；仅本机任务仍由页面存活时通知。

## 6. 验收

- 多账号隔离测试。
- 云端导出 JSON 可被本机导入。
- rejected 详情能回滚并消失。
- 诊断包不含敏感字段。
- Web Push 订阅/退订/去重测试；无 VAPID 时关闭。

## 7. 非目标

- 同一浏览器同时保持两个 Web 账号的 refresh 会话。
- 端到端加密推送载荷。
