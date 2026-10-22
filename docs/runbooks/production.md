# 运行手册：生产部署与安全

## 启动前置条件

1. PostgreSQL 16 可用，且数据库账号具备 schema migration 权限。
2. 生成独立随机 `JWT_SECRET`（至少 32 字节）和数据库密码，不提交到仓库。
3. `APP_ENV=production`。
4. 配置完整 SMTP（见下表）；缺少任一项时进程启动失败。
5. `COOKIE_SECURE=true`，只通过 HTTPS 暴露 API。
6. `CORS_ORIGINS` 是精确的 HTTPS 前端 origin 列表；禁止 `*`。

## 环境变量

| 变量              | 生产要求            | 说明                                                                                                  |
| ----------------- | ------------------- | ----------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`    | 必填                | PostgreSQL 连接串，建议启用 TLS。                                                                     |
| `JWT_SECRET`      | 必填                | 至少 32 字节随机值；禁止使用示例值。                                                                  |
| `CORS_ORIGINS`    | 必填                | 逗号分隔的精确 origin。                                                                               |
| `SMTP_HOST`       | 必填                | SMTP 主机名，不含 scheme/path。                                                                       |
| `SMTP_PORT`       | 可选                | 默认 `587`（starttls）或 `465`（implicit）。                                                          |
| `SMTP_TLS`        | 可选                | `starttls`（默认）或 `implicit`；`none` 在生产被拒绝。                                                |
| `AUTH_USERNAME`   | 必填                | SMTP 用户名。                                                                                         |
| `AUTH_PASSWORD`   | 必填                | SMTP 密码/应用专用密码，不得记录日志。                                                                |
| `MAIL_FROM`       | 必填                | 合法 mailbox，例如 `Shishi <no-reply@example.com>`。                                                  |
| `AUTH_DEV_CODE`   | 不使用              | 生产忽略开发验证码。                                                                                  |
| `COOKIE_SECURE`   | 必须 `true`         | 否则配置校验失败。                                                                                    |
| `BIND_ADDR`       | 建议 `0.0.0.0:8787` | 仅在受控网络内监听。                                                                                  |
| `RUST_LOG`        | 建议                | 默认 `todo_api=info,tower_http=info,sqlx=warn`。不要把 `sqlx` 调到 trace 级别，避免查询参数进入日志。 |
| `OPS_ADMIN_TOKEN` | 仅运维任务          | 至少 32 字符；不传给 API 服务。                                                                       |

## 邮件

`APP_ENV=production` 时验证码为随机六位数字，提交数据库后通过 lettre SMTP 发送。
API 只返回通用 `202`；SMTP 错误只记录固定错误类型，不记录验证码、收件人或 SMTP
响应原文。SMTP 服务器暂时不可用不会阻塞 API 启动，但会记录脱敏错误；修复 SMTP 后
重新请求即可。`/readyz` 检查邮件配置完整，不做每次健康检查都连接 SMTP。

开发环境仍使用 `AUTH_DEV_CODE` 或 `246810`，不发送邮件、不返回、不记录验证码。

## TLS / Caddy

仓库提供 `Caddyfile` 和可选的 `tls` profile：

```bash
APP_DOMAIN=api.example.com \
docker compose --profile tls up -d
```

- 将 DNS A/AAAA 指向 Caddy 主机，开放 80/443；Caddy 自动申请/续期证书。
- Caddy 终止 TLS 后反代到 `api:8787`，追加 HSTS、nosniff、frame 和 referrer 安全头。
- Caddy 访问日志有意不启用：bootstrap continuation 位于 query string，不能被访问日志
  明文记录。应用自身只记录 method 和 path，不记录 query、header 或 body。
- 若使用其他入口（云负载均衡/Ingress），必须实现等价 TLS、CORS、请求体限制和访问
  日志 query 脱敏；只允许入口访问 API，不直接暴露 8787。

## 健康检查

- `/healthz`：存活探针，不依赖数据库或邮件，只证明进程可响应 HTTP。
- `/readyz`：就绪探针，检查 PostgreSQL、全部嵌入式 migration 已成功应用、邮件配置
  完整。成功为 `200 {"status":"ready"}`；失败为 `503 NOT_READY`。
- Docker healthcheck 使用 `/readyz`；负载均衡只应把 readiness 通过的实例加入流量。

## 日志与审计

- API trace span 只记录 method 和 path，不记录 query（continuation token 在 query）。
- 不记录请求 body、Authorization/Cookie header、验证码、JWT、refresh token、任务内容。
- SMTP 错误、数据库内部错误均只输出固定类别/操作信息，不输出值。
- 生产日志建议接入集中式、访问受控的日志系统，并设置保留期和告警：
  - `sign-in code delivery failed` 频率；
  - `/readyz` 失败；
  - `change_log` 裁剪和 account purge 的 apply 计数；
  - 401/409/429 异常突增。
- Caddy access log 默认不启用；若启用其他代理日志，必须确认 query 脱敏，否则
  bootstrap continuation 会泄露。

## 发布顺序

1. 备份数据库（见 `backup-restore.md`）。
2. 部署新 API 镜像；启动时自动执行嵌入式 migration。
3. 等 `/readyz` 返回 200 再切流量。
4. 运行 `ops cleanup --dry-run` / `ops all --dry-run` 观察计数。
5. 需要时按运维手册执行 apply。
6. 观察错误率、延迟、`CURSOR_EXPIRED` 和 SMTP 失败告警。
