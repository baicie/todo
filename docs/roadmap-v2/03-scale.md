# 03 · 10 万级规模化设计

## 目标

- 10k 任务保持现有预算：列表 ≤100ms、搜索 ≤150ms、冷启动 ≤1.5s。
- 100k 任务可交互：首屏 ≤2s，分页加载 ≤200ms/页，搜索 ≤500ms，滚动 FPS ≥50。
- 首次登录/首次同步 10 万级数据时显示可解释进度，不阻塞输入。

## 1. 分页模型

`TaskQuery` 增加：

```ts
interface TaskQuery {
  limit?: number; // 默认 200，最大 500
  cursor?: string | null;
}
interface Page<T> {
  items: T[];
  nextCursor: string | null;
}
```

Cursor 为 base64url JSON，包含排序键：

- 全部/重要/计划内：`{ status, dueOn, rank, id }`
- 清单：`{ status, rank, id }`
- 已完成：`{ completedAt, id }`

服务端/本地仓库必须用同一排序键和 null 规则，避免重复/漏项。

## 2. 本地索引

- 为 `tasks` 增加多值索引/字段：
  - `status`
  - `listId`
  - `dueOn`
  - `completedAt`
  - `searchText`（title+note 小写规范化，非 UI 字段）
- 搜索使用 `searchText` 前缀/倒排 token 表；首版使用内存 token 倒排（10 万任务约 10–20MB），构建一次后增量更新。
- `getCounts` 使用按索引 count + 轻量聚合，避免每次全表读取。

## 3. 虚拟列表 + 增量加载

- `TaskList` 保留固定行高虚拟窗口。
- 滚动接近底部 4 屏时请求下一页。
- 列表状态维护 `items + nextCursor + loadingMore`。
- 切换视图/搜索时取消过期请求（generation token）。
- 滚动到顶部/筛选变化时重置 cursor。

## 4. 同步进度

`SyncEngine` 增加可选 `onProgress`：

```ts
{ phase: 'push'|'pull'|'rebase', completed: number, total: number }
```

每批 100 ops 回调一次。UI 显示“正在上传 200/1000”而不是只显示 syncing。错误和离线仍保留 outbox。

## 5. 服务端

- 现有 `/sync` 每批 100 ops 已满足；补 `limit` 上限和慢查询日志。
- PostgreSQL 增加必要索引：
  - `tasks(user_id, status, due_on, rank, id)`
  - `tasks(user_id, completed_at DESC, id)`
  - `change_log(user_id, server_seq)`
- 100k 账号导出改为流式 JSON/分页（当前 `jsonb_agg` 会一次性构造大对象）；先设置导出上限并警告，再实现 keyset 流式导出。

## 6. 压力测试

新增 `scripts/perf/stress-sync.mjs`：

- 生成 N 个任务和 outbox ops；
- 启动本地 API；
- 记录 push/pull p50/p95、失败率、内存；
- 不写入生产数据库。

## 7. 验收

- 100k 首屏 2s 内可交互。
- 连续滚动 100 页无重复/漏项。
- 搜索 100k ≤500ms。
- 10k 预算不退化。
- 同步进度回调批次正确，断网可从 outbox 续传。

## 8. 非目标

- 首版不引入 Web Worker 数据库；先测主线程 IndexedDB 是否满足。
- 不做跨设备实时推送（Web Push 仅提醒）。
