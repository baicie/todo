# 运维手册

本文覆盖 v1.1 生产运行的最小可观测性、冒烟测试和备份恢复流程。命令默认 API 地址为 `http://127.0.0.1:8787`，生产请替换为 HTTPS 域名。

## 健康检查

| 端点           | 用途                       | 成功响应                                |
| -------------- | -------------------------- | --------------------------------------- |
| `GET /healthz` | 进程存活，不访问数据库     | `200 {"status":"ok"}`                   |
| `GET /readyz`  | 数据库、迁移、邮件配置就绪 | `200 {"status":"ready","checks":{...}}` |
| `GET /metrics` | Prometheus 文本指标        | `200 text/plain`                        |

`/readyz` 失败时返回 `503`，并记录 `todo_readiness_failures_total`。Liveness 探针必须使用 `/healthz`，不要使用 `/readyz`，否则数据库短时不可用会触发无意义重启。

## 请求 ID 与日志

每个响应都带 `X-Request-Id`。客户端传入 16–128 位安全字符时原样保留，否则生成 UUID。访问日志为一行 JSON（`http_access`），包含 `request_id`、method、path、status、latency_ms。排查用户问题时，先让用户提供响应头中的 request id，再按该字段检索日志。

## 指标

| 指标                                           | 说明                                         |
| ---------------------------------------------- | -------------------------------------------- |
| `todo_http_requests_total{method,path,status}` | 请求计数；UUID 路径段已归一化为 `{id}`       |
| `todo_http_request_duration_seconds`           | 延迟直方图，桶 5ms–10s                       |
| `todo_sync_operations_total{result}`           | `applied` / `rejected` / `already_processed` |
| `todo_auth_code_requests_total{result}`        | `accepted` / `suppressed` / `rate_limited`   |
| `todo_readiness_failures_total`                | 就绪检查失败次数                             |
| `todo_push_*`                                  | Web Push 发送/失败/跳过计数                  |

建议告警：

- 5 分钟 5xx 比例 > 2%。
- `/readyz` 连续失败 3 次。
- `rate(todo_sync_operations_total{result="rejected"}[10m])` 持续 > 0（客户端协议错误）。
- `rate(todo_auth_code_requests_total{result="rate_limited"}[5m])` 异常升高（撞库/滥用）。
- p95 API 延迟 > 500ms 持续 10 分钟。

## 冒烟测试

健康与可观测性检查不需要账号：

```bash
API_URL=http://127.0.0.1:8787 node scripts/ops/smoke.mjs
```

带登录、导出和 sync 检查：

```bash
API_URL=https://todo.example.com \
SMOKE_EMAIL=ops@example.com \
SMOKE_CODE=123456 \
node scripts/ops/smoke.mjs
```

脚本只输出检查结果，不打印 token、验证码或邮件内容。

## PostgreSQL 备份

```bash
pg_dump --format=custom --no-owner --file=shishi-$(date +%F).dump "$DATABASE_URL"
```

恢复演练（务必使用独立数据库）：

```bash
createdb shishi_restore_test
pg_restore --clean --if-exists --no-owner --dbname=shishi_restore_test shishi-$(date +%F).dump
```

恢复后运行：

```bash
DATABASE_URL=postgres://.../shishi_restore_test cargo test -p todo-api --test postgres_smoke -- --ignored
```

客户端 JSON 备份通过“设置 → 数据 → 导出 JSON”完成；恢复前先退出云同步，避免合并期间产生双写。备份不包含 refresh token、验证码或账号凭据。

## Web Push

生产启用需要 `WEB_PUSH_ENABLED=true`、`VAPID_PUBLIC_KEY`、`VAPID_PRIVATE_KEY`、`VAPID_SUBJECT`。私钥只放在服务端密钥管理系统，不进入前端构建。未配置时 `/api/v1/push/config` 返回禁用状态，客户端显示“服务器尚未配置 VAPID 密钥”。

生成密钥：

```bash
node scripts/ops/vapid-keys.mjs
```

把输出写入 secret 管理；公钥会通过 `/api/v1/push/config` 返回给已登录客户端，私钥永不返回。

## 发布检查清单

1. `pnpm check` 和 `pnpm test:e2e` 通过。
2. `cargo fmt --all -- --check`、`cargo clippy --workspace --all-targets -- -D warnings` 通过。
3. `/readyz` 三项均为 ok。
4. 用真实两个客户端跑一次登录、合并、同步、导出、撤销设备。
5. 检查 `/metrics` 有请求计数，日志含 request id。
6. 备份数据库后再执行迁移。
