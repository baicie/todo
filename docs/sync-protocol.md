# 增量同步协议

## 目标

- 单用户、多设备、离线可用。
- 可预测的字段级冲突合并，而不是 CRDT。
- 任意请求可以安全重试，不重复创建任务或事件。
- 删除不会被旧设备的修改意外复活。

## Mutation

```json
{
  "op_id": "019a0000-0000-7000-8000-000000000002",
  "client_seq": 39,
  "entity": "task",
  "entity_id": "019a0000-0000-7000-8000-000000000003",
  "kind": "patch",
  "patch": { "title": "提交报销单" }
}
```

- `op_id` 是 UUIDv7，服务端全局唯一。
- `client_seq` 对每个 `device_id` 严格从 1 连续递增；服务端持久化最高已处理值。
- `entity` 为 `task | list | step | day_plan`。
- `kind` 为 `create | patch | delete | restore`。
- patch 字段经过白名单和类型校验；服务端从不执行客户端 SQL。

## 服务端事务顺序

```text
BEGIN
  SELECT account_sync_state FOR UPDATE
  SELECT device FOR UPDATE
  verify device active + client_seq == last_client_seq + 1
  for each op:
    if op_id receipt exists -> return previous receipt
    if client_seq <= last_client_seq -> already_processed
    validate ownership, parent references, tombstone state
    apply field patch or insert/soft-delete entity
    allocate server_seq from account_sync_state.next_server_seq
    INSERT change_log, op_receipt
    UPDATE device.last_client_seq
  UPDATE account_sync_state
COMMIT (ops + receipts + events together)
```

拒绝的操作仍写入 receipt、推进设备序号，避免一个坏操作永久卡住 outbox。服务端返回
`status: "rejected"` 与稳定错误码。

## 响应与游标

```json
{
  "ack": [
    { "op_id": "…", "server_seq": 196, "status": "applied" }
  ],
  "changes": [
    fenced_change
  ],
  "next_cursor": "196",
  "has_more": false,
  "server_time": "2026-10-21T05:00:00Z"
}
```

- `next_cursor` 是本次**最后返回变更**的序号，不是账号最大序号。
- 一次最多 100 个 ops、500 个 changes。
- 已确认的 `op_id` 重试只返回原收据，不产生新事件。
- 回执被裁剪后，通过设备水位返回 `already_processed`；客户端需要时执行 bootstrap。

## 客户端算法

```text
mutate(command):
  transaction:
    update materialized rows
    append outbox(op_id, client_seq, patch)
  refresh UI
  schedule sync (debounce 500–1500ms)

syncOnce():
  acquire mutex
  read cursor + pending outbox batch
  POST /api/v1/sync
  transaction:
    apply changes to shadow in server_seq order
    remove acked outbox rows
    mark rejected rows visible
    reproject affected entities = shadow + remaining pending ops
    persist cursor
  if has_more or pending remain: repeat
```

如果网络在服务端提交后中断，客户端用相同 `op_id` 重试即可拿到原结果。远端改动不会把
本机尚未确认的 patch 覆盖掉。

## Cursor 过期与 Bootstrap

- 服务端保留变更日志至少 90 天（可配置）。
- 旧游标返回 HTTP 409 + `CURSOR_EXPIRED`。
- 客户端下载带 `snapshot_cursor` 的分页快照；快照读取期间的新变更由之后的增量补齐。
- 根据服务端 `last_client_seq` 去除已经处理的 outbox，**只重放真正未确认的操作**。
- 删除实体保留 tombstone 到日志裁剪窗口以后。

## Bootstrap 分页

`GET /api/v1/sync/bootstrap?continuation=...&limit=500`

- 首页固定 `snapshot_cursor`，后续页绑定同一账号与快照。
- continuation token 使用服务端 secret HMAC 签名，包含账号与快照信息，防止篡改和跨账号读取。
- 每页 1–500 条，包含可见实体和 tombstone。
- 完成后客户端从 `snapshot_cursor` 开始增量拉取。

## 冲突语义

考虑设备 A 改标题、设备 B 改提醒：

- 两个 op 分别 patch 不同字段，最终两处修改都保留。
- 若都改标题，以服务端接受顺序为准，后接受者赢。
- 删除后的普通 patch 被拒绝；必须显式 `restore`。
- 这不是语义级完美合并，但结果可预测且可通过 change log 诊断。

## 错误码

| code                | HTTP | 含义                             |
| ------------------- | ---: | -------------------------------- |
| `CURSOR_EXPIRED`    |  409 | 游标早于保留窗口，需要 bootstrap |
| `SEQUENCE_MISMATCH` |  409 | client_seq 空洞或重复导致乱序    |
| `ENTITY_NOT_FOUND`  |  404 | 实体不存在或不属于当前账号       |
| `VALIDATION_FAILED` |  400 | patch 字段或实体数据非法         |
| `FORBIDDEN`         |  403 | 设备被撤销或无权限               |
| `RATE_LIMITED`      |  429 | 超过同步/登录频率限制            |
| `UNAUTHORIZED`      |  401 | access token 无效或过期          |
