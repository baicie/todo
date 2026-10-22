# 04 · 产品能力设计

## 1. 标签、筛选与保存视图

### 数据

- `Task.tags: string[]`，最多 20 个，每个 1–32 字符，去重、trim、小写比较但保留显示大小写。
- PostgreSQL `tasks.tags text[] NOT NULL DEFAULT '{}'`；GIN 索引。
- SQLite `local_tasks.tags_json TEXT NOT NULL DEFAULT '[]'`。
- Dexie `tasks.tags` multi-entry index；schema v3。
- 同步 patch 白名单加入 `tags`。

### UX

- 快速添加和详情支持 `#标签` 语法。
- 任务行显示最多 3 个标签 chip。
- 视图工具栏增加筛选 popover：标签、状态、截止日期、清单。
- 保存视图存 `localStorage`：`{id,name,view,filter,sort}`，侧栏“保存视图”区域可重命名/删除。
- 搜索匹配标签。

## 2. 日历视图

- 侧栏增加“日历”智能视图。
- 月视图：6×7 网格，每格显示最多 3 条任务，超出显示“+N”。
- 点击日期筛选该日任务；点击任务打开详情。
- 支持键盘方向键切换日期，Enter 打开当天。
- 任务按 `dueOn`；无截止日期不显示。
- 移动端改为周视图/列表切换，避免过密。

## 3. ICS

- 设置 → 数据增加“导出日历 (.ics)”。
- 使用 UTC `DTSTAMP`，全天任务用 `VALUE=DATE`。
- 转义逗号、分号、反斜杠和换行；UID 使用任务 id。
- 支持从 ICS 导入 `VEVENT` 的 SUMMARY/DTSTART/DUE，第一版只导入到收件箱，重复规则不导入。
- 不实现 CalDAV 双向同步。

## 4. 自然语言快速添加

解析器输入示例：

```text
明天下午三点交报告 #工作 !重要
每周一整理周报 #工作
下周五 18:00 健身
```

支持：

- 相对日期：今天/明天/后天/下周X/下月X
- 时间：HH:mm、上午/下午/晚上
- 重复：每天/每周X/每月X
- 重要：`!重要` / `!!`
- 标签：`#tag`
- 清单：`@清单名`
- 解析失败保留原文，不阻塞添加。
- 预览 chip 显示识别结果，用户可撤销识别。

## 5. 模板与每周回顾

### 模板

- 本地表 `templates`：id, name, title, note, tags, dueOffsetDays, remindTime, steps, createdAt。
- 设置 → 数据 → 模板管理；快速添加输入框旁“模板”按钮。
- 从模板创建任务，日期按今天偏移。
- 模板只存本机，不参与云同步第一版。

### 每周回顾

- 侧栏/设置入口“每周回顾”。
- 统计：本周完成数、逾期数、无截止日期数、各清单完成分布、连续完成天数。
- 列出本周完成和下周到期任务。
- 支持“清理无日期收件箱”批量操作（需确认）。
- 纯派生数据，不新增同步实体。

## 6. 共享清单 v1

### 边界

- 共享清单是独立的“协作清单”，不混入个人 `/sync` 的账号 change log。
- 支持 owner/editor/viewer 三种角色。
- 支持任务创建、标题/备注/状态/重要/截止日期、步骤；不支持共享清单中的重复任务、我的一天、提醒（第一版明确禁用）。
- 采用 revision 轮询（15 秒）而不是 WebSocket；保证最终一致，不保证实时。
- 共享清单在侧栏单独分组，带成员头像/共享标记。

### 服务端模型

```text
shared_lists(id, owner_id, name, color, icon, rank, revision, created_at, updated_at, deleted_at)
shared_list_members(list_id, user_id, role, created_at, deleted_at)
shared_tasks(id, list_id, title, note, status, important, due_on, rank, created_at, updated_at, deleted_at)
shared_steps(id, task_id, title, is_completed, rank, created_at, updated_at, deleted_at)
shared_changes(list_id, revision, actor_id, op_id, entity, entity_id, kind, patch_json, created_at)
shared_op_receipts(list_id, op_id, actor_id, revision, status, error_code, created_at)
```

### API

```text
GET    /api/v1/shared/lists
POST   /api/v1/shared/lists
GET    /api/v1/shared/lists/{id}/snapshot?since=<revision>
POST   /api/v1/shared/lists/{id}/ops
POST   /api/v1/shared/lists/{id}/members        {email, role}
PATCH  /api/v1/shared/lists/{id}/members/{uid}  {role}
DELETE /api/v1/shared/lists/{id}/members/{uid}
GET    /api/v1/shared/invitations
POST   /api/v1/shared/invitations/{id}/accept|decline
```

- `ops` body 携带 `base_revision`、`op_id`、实体、kind、patch。
- 服务端以 list 行锁串行化 revision；op receipt 幂等。
- 成员权限：
  - viewer 只能 pull；
  - editor 可改任务/步骤；
  - owner 可改清单、成员、删除。
- 所有查询强制 `list_members` 校验。
- 邀请：按邮箱创建 pending invitation；同邮箱登录后接受。未注册邮箱保留 pending，注册后可见。

### 客户端

- Dexie 新增 `sharedLists`, `sharedTasks`, `sharedSteps`, `sharedOutbox`, `sharedMeta`。
- `SharedSyncEngine`：pull revision → 合并 shadow+pending；push pending ops（每批 50）；15s 轮询 + 页面恢复。
- 本机编辑先写物化表 + sharedOutbox；离线可编辑 editor 清单。
- UI 显示成员、角色、最后同步时间；viewer 禁用编辑控件。
- 共享实体不写入个人 `tasks/lists`，避免与个人同步冲突。

### 验收

- owner 邀请 editor，editor 在第二设备看到并编辑任务。
- viewer 无编辑入口，API 拒绝写。
- 离线编辑恢复后推送；revision 冲突返回 409 并自动 rebase。
- 移除成员后其后续请求 403，本地共享数据可只读保留或删除。
- 共享清单不影响个人同步预算。

## 7. 非目标

- 共享清单实时光标/评论/附件。
- 共享清单提醒和重复任务。
- CalDAV 双向同步。
