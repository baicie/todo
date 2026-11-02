# 05 · 工程质量设计

## 1. Property-based 测试

使用 `fast-check` 覆盖：

- 重复规则：任意起止/间隔/时区输入不崩溃，下一次 occurrence 严格递增。
- 同步 patch 合并：相同字段本地 pending 覆盖远端；不同字段都保留；删除/恢复显式。
- cursor 分页：任意分页遍历结果无重复、无遗漏，最终集合等于全集。
- 自然语言解析：随机日期/时间/标签不抛异常，解析结果可回退为原文。

## 2. API fuzz / 边界测试

- 验证码、refresh、sync、export、shared ops 的 malformed JSON。
- 超大 body、未知字段、重复 op_id、非递增 client_seq、跨账号 list/task 引用。
- 权限矩阵：owner/editor/viewer/非成员。
- 使用 cargo test 的 deterministic cases；可选 `cargo-fuzz` 目标不进入默认 CI。

**状态（2026-11-01）**：`apps/api/tests/postgres_boundaries.rs`。

- 无需数据库的 8 个用例（默认 `cargo test` 运行）：验证码/refresh 的 malformed JSON、
  未知字段、Content-Type、带与不带 Content-Length 的超大 body（断言 JSON 413）、
  缺失/伪造 token、不支持的 method。
- 需要 PostgreSQL 的用例（`--ignored`）：sync 的 malformed 请求、`client_seq`
  为 0/乱序/重复/有间隔（整批回滚）、`op_id` 回放返回原回执且不同 payload 不会被应用、
  回执清理后以设备水位为准、跨设备/跨账号复用 `op_id`、跨账号 list/task 引用、
  bootstrap/export 只返回本账号数据、refresh 轮换与重用撤销、push 路由错误契约；
  共享清单 8 个路由 × owner/editor/viewer/非成员的权限矩阵（每格独立清单，断言状态码
  与是否改动数据）、malformed body 与 revision、`op_id` 回放。
- 发现并修复：sync 中含 NUL 的文本/标签/recurrence 与超出 PostgreSQL 日期范围的
  日期原返回 500，现为 `VALIDATION_FAILED` 拒绝回执；设备名含 NUL 原返回 500，
  现在含任何控制字符都返回 400；push 订阅路由原返回纯文本错误，现为 JSON。
- 已修复（2026-11-02）：`shared.rs` 同一类输入（清单名/任务标题/备注含 NUL、
  `due_on` 超出 PostgreSQL `date` 范围 4713 BC..5874897 AD）原返回 500
  `INTERNAL_ERROR`，在隔离 PostgreSQL 上复现后在 `validate_text`/`validate_note`/
  `validate_due_on` 中拒绝，现为 400 `VALIDATION_FAILED`，且不写库、不推进 revision、
  不写回执。测试由 `known_defect_...` 更名为
  `shared_routes_reject_values_postgres_cannot_store`，去掉 `#[ignore]` 之外的跳过逻辑，
  CI 以 `--ignored` 运行全部边界用例，不再使用 `--skip known_defect_`。
  `cargo-fuzz` 目标仍未实现。
- 实测：本机 Windows + PostgreSQL 18.6 全部通过；CI（PostgreSQL 16）见 Phase G 记录。

## 3. 迁移测试

- PostgreSQL：从每个历史 migration 版本升级到最新，验证数据保留。
- SQLite：v1 schema 数据库升级到 tags/shared 表，验证 outbox/cursor 不丢。
- IndexedDB：Dexie v1/v2 数据升级到 v3，旧任务仍可读取。
- 备份恢复：导出 → 清空 → 恢复，任务/清单/步骤/日期完全一致。

**状态（2026-11-01）**：PostgreSQL 部分由 `apps/api/tests/postgres_migrations.rs`
覆盖。对每个历史版本新建随机名临时库（结束时删除，断言失败也会删除），只应用到该版本，
写入该版本 schema 下的代表数据，再用 API 的 `MIGRATOR` 升级到最新，断言：原有行逐列
保留、schema（列/约束/索引）与全新安装一致且无未验证约束、新增约束对旧行生效、当前 API
可读取升级后的数据（readyz、export、sync 拉取、共享清单）、重复执行迁移无副作用。
本机 PostgreSQL 18.6 实测通过（6 个版本，约 7.5s）；CI 尚未运行。新增迁移会自动纳入
升级路径，但新表需在 `seed_for` 中补充种子数据才有数据保留断言。SQLite 与 IndexedDB
部分不在本次范围内。

## 4. 备份恢复 CI

`scripts/ops/backup-restore-test.sh`：

1. 启动临时 PostgreSQL（Compose）。
2. 运行 API migrations。
3. 插入黄金数据集。
4. `backup.sh` 生成 dump + checksum。
5. 删除数据库，`restore.sh` 恢复。
6. 运行 SQL 校验任务/清单/账号数量。
7. 清理临时卷。

CI 中作为可选 job，使用 Docker 服务和 `RESTORE_CONFIRM=YES`。

**状态（2026-11-01）**：脚本已实现，复用 `backup.sh` / `restore.sh`。除上述步骤外还
检查 `restore.sh` 拒绝未确认与 checksum 不符的 dump、恢复后每张表的行指纹与备份前一致、
恢复后 API 就绪且 `ops all --dry-run` 通过、在已修改的库上再次恢复可回到备份状态。
`.github/workflows/api.yml` 新增 `backup-restore` job：`workflow_dispatch` 时总是运行，
push/PR 时仅在改动 `scripts/ops/`、`db/postgres/`、`docker-compose.yml` 或
`apps/api/src/{db,ops}.rs` 时运行，使用 `--compose` 模式。

- 实测：本机以现有服务器模式（PostgreSQL 18.6，Git Bash）完整通过。
- 工具版本：`pg_dump` 比服务器新时，dump 会带上旧服务器不认识的设置
  （PostgreSQL 17 起写 `SET transaction_timeout`），恢复失败看起来却像备份损坏。
  脚本现在从服务器读取 `server_version_num`，与 `psql`/`pg_dump`/`pg_restore`
  的主版本逐一比对，不一致立即失败并说明原因。CI job 也不再依赖 runner 默认的
  客户端：它从 `docker-compose.yml` 读取服务镜像主版本，按需从 apt.postgresql.org
  安装同版本的 `postgresql-client-<major>`，与 `postgres:16-alpine` 配对。
- NOT_RUN：`--compose` 模式（本机 Docker Desktop 无法启动）。CI job 首次运行
  （run 41301207891）在恢复步骤因上述版本不匹配失败，修复后待重新运行验证。

## 5. SBOM 与依赖

- Web：`pnpm licenses list --json` + `pnpm sbom`（若 pnpm 支持）。
- Rust：`cargo metadata` 生成依赖清单；可选 `cargo-cyclonedx`。
- CI 生成 `sbom-web.json` / `sbom-rust.json` artifact。
- 依赖漏洞扫描：`pnpm audit --prod`、`cargo audit`（允许网络时）；失败等级 high/critical 阻断。

## 6. 性能预算门禁

`scripts/perf/check-budget.mjs` 读取 benchmark JSON：

- 10k 列表 ≤100ms
- 10k 搜索 ≤150ms
- 10k 冷启动 ≤1500ms
- JS gzip ≤200KB
- 100k 首屏 ≤2000ms（当启用 100k 样本时）

CI 在 browser/perf job 中构建、预览、跑 benchmark、比较预算；超过 10% 回归失败。

## 7. 安全与发布检查

- `pnpm audit --prod`、`cargo audit`。
- Dockerfile 非 root、healthcheck、只复制必要文件。
- `.env` 不入库；生产 secrets 检查。
- 发布 tag 前跑 `pnpm check`、e2e、PostgreSQL 集成、backup-restore。

## 8. 验收

- 新增测试在 CI 中运行。
- 迁移测试覆盖所有历史 schema。
- backup-restore 演练可重复。
- SBOM 生成并有 artifact。
- 性能预算失败会使 CI 失败。

## 9. 非目标

- 不在默认 PR 中运行 10 万 benchmark（时间成本高），使用 nightly 或手动 workflow。
- 不引入商业 APM。
