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

## 3. 迁移测试

- PostgreSQL：从每个历史 migration 版本升级到最新，验证数据保留。
- SQLite：v1 schema 数据库升级到 tags/shared 表，验证 outbox/cursor 不丢。
- IndexedDB：Dexie v1/v2 数据升级到 v3，旧任务仍可读取。
- 备份恢复：导出 → 清空 → 恢复，任务/清单/步骤/日期完全一致。

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
