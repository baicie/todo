# ADR-005：Desktop/Mobile SQLite，Web IndexedDB

- 状态：接受
- 日期：2026-10-21

## 决策

- Native 端：Rust + SQLite（WAL、foreign_keys、事务串行写）。
- Web 端：Dexie + IndexedDB。

两端实现同一 `TaskRepository` 接口，拥有相同的行为测试；不把 SQLite WASM 引入 Web 首屏。

## 备选方案

- 统一 IndexedDB：Desktop 的持久性、备份和事务能力不足。
- 统一 SQLite WASM：首屏体积和 OPFS 兼容性代价高。
- Tauri 官方 SQL 插件：可作为维护成本过高时的后备方案；当前采用最小权限的固定领域命令。
