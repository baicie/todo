-- Native SQLite 数据模型简化基线。迁移版本与 PRAGMA 配置由 Rust 处理。
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS local_tasks (
  id TEXT PRIMARY KEY,
  list_id TEXT,
  title TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('open', 'completed')),
  important INTEGER NOT NULL DEFAULT 0 CHECK (important IN (0, 1)),
  due_on TEXT,
  remind_at TEXT,
  remind_timezone TEXT,
  rank TEXT NOT NULL DEFAULT 'a0',
  series_id TEXT,
  occurrence_key TEXT,
  recurrence_json TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_local_tasks_list ON local_tasks(list_id, status, rank);
CREATE INDEX IF NOT EXISTS idx_local_tasks_due ON local_tasks(due_on, status);

CREATE TABLE IF NOT EXISTS local_lists (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  color TEXT,
  icon TEXT,
  rank TEXT NOT NULL DEFAULT 'a0',
  deleted_at TEXT
);

CREATE TABLE IF NOT EXISTS local_steps (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES local_tasks(id),
  title TEXT NOT NULL,
  is_completed INTEGER NOT NULL DEFAULT 0,
  rank TEXT NOT NULL DEFAULT 'a0',
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_local_steps_task ON local_steps(task_id, rank);

CREATE TABLE IF NOT EXISTS local_day_plans (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES local_tasks(id),
  local_date TEXT NOT NULL,
  rank TEXT NOT NULL DEFAULT 'a0',
  deleted_at TEXT,
  UNIQUE(task_id, local_date)
);
CREATE INDEX IF NOT EXISTS idx_local_day_plans ON local_day_plans(local_date, rank);

CREATE TABLE IF NOT EXISTS server_shadow (
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  server_rev INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  PRIMARY KEY (entity_type, entity_id)
);

CREATE TABLE IF NOT EXISTS outbox (
  op_id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,
  client_seq INTEGER NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  patch_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  sync_status TEXT NOT NULL DEFAULT 'pending',
  error_code TEXT,
  UNIQUE(device_id, client_seq)
);
CREATE INDEX IF NOT EXISTS idx_outbox_pending ON outbox(sync_status, client_seq);

CREATE TABLE IF NOT EXISTS kv_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- trigram MATCH 适用于至少 3 个 Unicode 字符；1-2 字短词需 LIKE 回退。
CREATE VIRTUAL TABLE IF NOT EXISTS task_fts USING fts5(
  title,
  note,
  content='local_tasks',
  content_rowid='rowid',
  tokenize='trigram'
);

CREATE TRIGGER IF NOT EXISTS task_ai AFTER INSERT ON local_tasks BEGIN
  INSERT INTO task_fts(rowid, title, note) VALUES(new.rowid, new.title, new.note);
END;
CREATE TRIGGER IF NOT EXISTS task_ad AFTER DELETE ON local_tasks BEGIN
  INSERT INTO task_fts(task_fts, rowid, title, note)
    VALUES('delete', old.rowid, old.title, old.note);
END;
CREATE TRIGGER IF NOT EXISTS task_au AFTER UPDATE OF title, note ON local_tasks BEGIN
  INSERT INTO task_fts(task_fts, rowid, title, note)
    VALUES('delete', old.rowid, old.title, old.note);
  INSERT INTO task_fts(rowid, title, note) VALUES(new.rowid, new.title, new.note);
END;

-- 强约束：本地 command 修改 materialized tables 时，必须在同一事务
-- 写入 outbox；已登录远端 changes 先更新 shadow，再重放 outbox 重算实体。
-- 账号切换使用独立数据库文件，不在同一个 DB 通过 user_id 混合隔离。
