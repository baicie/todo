# 01 · 发布与可观测性设计

## 目标

让服务从“功能可用”进入“可发布、可排障、可计量”的状态，且不引入额外基础设施依赖。

## 1. 版本基线

- 所有实现进入 git 初始提交，打 tag `v1.1.0-rc.1`。
- 发布前必须通过：
  - `pnpm typecheck`
  - `pnpm test`
  - `pnpm build`
  - `pnpm rust:lint`
  - `cargo test --workspace`
  - PostgreSQL 集成测试
  - `pnpm test:e2e`

## 2. 请求 ID

中间件为每个请求生成或透传 `X-Request-Id`：

- 客户端可传 `X-Request-Id`；服务端校验为 16–128 个安全字符。
- 无请求头时生成 UUID。
- 响应始终带 `X-Request-Id`。
- tracing span 包含 `request_id`，访问日志只记录 method/path/status/latency/request_id，不记录 query、body、token。

## 3. Metrics

新增 `GET /metrics`，Prometheus text exposition，不依赖 Prometheus crate：

```text
todo_http_requests_total{method,path,status} 123
todo_http_request_duration_seconds_bucket{le="0.05"} 100
todo_http_request_duration_seconds_sum 12.3
todo_http_request_duration_seconds_count 456
todo_sync_operations_total{result="applied"} 12
todo_auth_code_requests_total{result="accepted"} 3
todo_readiness_failures_total 0
todo_uptime_seconds 3600
```

实现方式：

- 进程级 `Metrics` 放在 `AppState`，使用 `AtomicU64`。
- 直方图固定桶：5ms/10ms/25ms/50ms/100ms/250ms/500ms/1s/2.5s/5s/10s。
- path 使用 Axum 匹配后的路由模板（`/api/v1/sync`），避免把 id 写入标签基数。
- `/metrics` 仅允许内网/运维网络访问的建议写入 runbook；API 默认绑定本机。

## 4. 访问日志与告警建议

- 每条 HTTP 访问日志包含 `request_id`、method、path、status、latency_ms。
- 错误日志只记录错误码/类别，不记录任务标题、邮箱、验证码、token。
- 告警建议：
  - 5xx 比例 >2% 持续 5 分钟
  - `/readyz` 失败连续 3 次
  - 邮件 provider 失败率 >10%
  - sync 5xx/429 激增
  - PostgreSQL 连接池等待时间过长

## 5. 生产 smoke

新增 `scripts/ops/smoke.sh`：

1. `GET /healthz` 必须 200。
2. `GET /readyz` 必须 200。
3. 请求开发/测试登录验证码，使用测试账号登录。
4. `GET /api/v1/export` 必须 200 且 JSON。
5. `POST /api/v1/sync` 空 ops 拉取必须 200。
6. 输出 JSON 结果，不输出 token/验证码。

生产使用真实邮箱时需要 `AUTH_DEV_CODE` 不生效；smoke 脚本支持 `SMOKE_EMAIL`/`SMOKE_CODE`，未提供时跳过登录并明确报告。

## 6. 验收

- `curl /metrics` 返回合法 Prometheus 文本。
- 每个响应有 `X-Request-Id`。
- 日志中可用 request id 关联一次请求。
- smoke 在本地 Compose 环境通过。
- runbook 记录告警阈值和容量假设。

## 7. 非目标

- 不引入 Prometheus server、Grafana、OpenTelemetry collector。
- 不做远程日志上传。
