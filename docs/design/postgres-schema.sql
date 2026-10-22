-- PostgreSQL 16+ 示例架构草案，供迁移脚本拆分。
-- 所有表操作必须通过授权 user_id 限制，单凭外键不能代替鉴权。
-- 用数据库迁移工具生成实际版本，生产环境不要直接反复执行此文件。

CREATE TABLE users (
    id UUID PRIMARY KEY,
    email_normalized TEXT NOT NULL UNIQUE,
    preferred_timezone TEXT NOT NULL DEFAULT 'Asia/Shanghai',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at TIMESTAMPTZ
);

CREATE TABLE auth_codes (
    id UUID PRIMARY KEY,
    email_normalized TEXT NOT NULL,
    code_hash BYTEA NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    attempts INT NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    consumed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_auth_codes_email_recent ON auth_codes(email_normalized, created_at DESC);

CREATE TABLE devices (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    platform TEXT NOT NULL,
    last_client_seq BIGINT NOT NULL DEFAULT 0 CHECK (last_client_seq >= 0),
    last_seen_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (user_id, id)
);
CREATE INDEX idx_devices_user ON devices(user_id, created_at);

CREATE TABLE sessions (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_id UUID NOT NULL,
    refresh_token_hash BYTEA NOT NULL UNIQUE,
    expires_at TIMESTAMPTZ NOT NULL,
    revoked_at TIMESTAMPTZ,
    rotated_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    FOREIGN KEY (user_id, device_id) REFERENCES devices(user_id, id) ON DELETE CASCADE
);

CREATE TABLE lists (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name VARCHAR(120) NOT NULL,
    color TEXT,
    icon TEXT,
    rank VARCHAR(128) NOT NULL DEFAULT 'a0',
    server_rev BIGINT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at TIMESTAMPTZ,
    UNIQUE (user_id, id)
);
CREATE INDEX idx_lists_visible ON lists(user_id, rank) WHERE deleted_at IS NULL;

CREATE TABLE tasks (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    list_id UUID,
    title VARCHAR(1000) NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    status VARCHAR(12) NOT NULL DEFAULT 'open' CHECK (status IN ('open','completed')),
    important BOOLEAN NOT NULL DEFAULT false,
    due_on DATE,
    remind_at TIMESTAMPTZ,
    remind_timezone TEXT,
    rank VARCHAR(128) NOT NULL DEFAULT 'a0',
    series_id UUID,
    occurrence_key VARCHAR(64),
    recurrence JSONB,
    completed_at TIMESTAMPTZ,
    server_rev BIGINT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at TIMESTAMPTZ,
    UNIQUE (user_id, id),
    FOREIGN KEY (user_id, list_id) REFERENCES lists(user_id, id)
);
CREATE UNIQUE INDEX idx_tasks_recurrence_identity
  ON tasks(user_id, series_id, occurrence_key)
  WHERE series_id IS NOT NULL AND occurrence_key IS NOT NULL;
CREATE INDEX idx_tasks_list_rank ON tasks(user_id, list_id, rank)
  WHERE deleted_at IS NULL;
CREATE INDEX idx_tasks_due ON tasks(user_id, due_on)
  WHERE deleted_at IS NULL AND status = 'open';
CREATE INDEX idx_tasks_important ON tasks(user_id, important, updated_at DESC)
  WHERE deleted_at IS NULL;

CREATE TABLE steps (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    task_id UUID NOT NULL,
    title VARCHAR(1000) NOT NULL,
    is_completed BOOLEAN NOT NULL DEFAULT false,
    rank VARCHAR(128) NOT NULL DEFAULT 'a0',
    server_rev BIGINT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at TIMESTAMPTZ,
    UNIQUE (user_id, id),
    FOREIGN KEY (user_id, task_id) REFERENCES tasks(user_id, id)
);
CREATE INDEX idx_steps_task ON steps(user_id, task_id, rank)
  WHERE deleted_at IS NULL;

CREATE TABLE day_plans (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    task_id UUID NOT NULL,
    local_date DATE NOT NULL,
    rank VARCHAR(128) NOT NULL DEFAULT 'a0',
    server_rev BIGINT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at TIMESTAMPTZ,
    FOREIGN KEY (user_id, task_id) REFERENCES tasks(user_id, id),
    UNIQUE (user_id, task_id, local_date)
);
CREATE INDEX idx_day_plans_by_date ON day_plans(user_id, local_date, rank)
  WHERE deleted_at IS NULL;

-- 每个账号的 server_seq 必须在同一事务锁定此行后递增。
CREATE TABLE account_sync_state (
    user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    next_server_seq BIGINT NOT NULL DEFAULT 1 CHECK (next_server_seq > 0),
    min_available_seq BIGINT NOT NULL DEFAULT 0 CHECK (min_available_seq >= 0)
);

-- op_receipts 用于断线重试、冲突诊断。可做冷热分层，但删除前必须
-- 通过 devices.last_client_seq 的单调水位确保重复提交不会再次被应用。
CREATE TABLE op_receipts (
    op_id UUID PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_id UUID NOT NULL,
    client_seq BIGINT NOT NULL,
    server_seq BIGINT,
    status TEXT NOT NULL CHECK (status IN ('applied','rejected')),
    error_code TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (user_id, device_id, client_seq),
    FOREIGN KEY (user_id, device_id) REFERENCES devices(user_id, id)
);
CREATE INDEX idx_op_receipts_user_seq ON op_receipts(user_id, server_seq);

CREATE TABLE change_log (
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    server_seq BIGINT NOT NULL,
    op_id UUID NOT NULL,
    entity_type TEXT NOT NULL CHECK (entity_type IN ('list','task','step','day_plan')),
    entity_id UUID NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('create','patch','delete','restore')),
    patch JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, server_seq)
);
CREATE INDEX idx_change_log_retention ON change_log(created_at);

-- 每一次 Sync 请求的大致事务顺序：
-- BEGIN;
-- SELECT ... FROM devices WHERE user_id=$1 AND id=$2 FOR UPDATE;
-- SELECT ... FROM account_sync_state WHERE user_id=$1 FOR UPDATE;
-- verify device is active + client_seq is next expected
-- check op_receipts UNIQUE user_id/device_id/client_seq + op_id
-- validate entity ownership + apply field-level patch
-- assign account server_seq; INSERT change_log and op_receipts
-- UPDATE devices.last_client_seq and account_sync_state.next_server_seq
-- COMMIT;
-- 再按稳定快照查询客户端 cursor 后的变更。
