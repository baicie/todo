-- Core account, authentication, and entity schema.
-- Every row is scoped by user_id; authorization is enforced by the API in
-- addition to these foreign keys.

CREATE TABLE users (
    id UUID PRIMARY KEY,
    email_normalized TEXT NOT NULL UNIQUE,
    preferred_timezone TEXT NOT NULL DEFAULT 'Asia/Shanghai',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at TIMESTAMPTZ,
    CONSTRAINT users_email_normalized_lower CHECK (email_normalized = lower(email_normalized)),
    CONSTRAINT users_email_nonempty CHECK (length(email_normalized) BETWEEN 3 AND 254)
);

CREATE TABLE auth_codes (
    id UUID PRIMARY KEY,
    email_normalized TEXT NOT NULL,
    code_hash BYTEA NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    attempts INT NOT NULL DEFAULT 0 CHECK (attempts >= 0 AND attempts <= 10),
    consumed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_auth_codes_email_recent
    ON auth_codes (email_normalized, created_at DESC);
CREATE INDEX idx_auth_codes_cleanup
    ON auth_codes (created_at);

CREATE TABLE devices (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    platform TEXT NOT NULL,
    last_client_seq BIGINT NOT NULL DEFAULT 0 CHECK (last_client_seq >= 0),
    last_seen_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT devices_name_nonempty CHECK (length(btrim(name)) BETWEEN 1 AND 100),
    UNIQUE (user_id, id)
);

CREATE INDEX idx_devices_user ON devices (user_id, created_at);

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

CREATE INDEX idx_sessions_user_device ON sessions (user_id, device_id);
CREATE INDEX idx_sessions_expiry ON sessions (expires_at);

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
    CONSTRAINT lists_name_nonempty CHECK (length(btrim(name)) BETWEEN 1 AND 120),
    UNIQUE (user_id, id)
);

CREATE INDEX idx_lists_visible ON lists (user_id, rank) WHERE deleted_at IS NULL;

CREATE TABLE tasks (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    list_id UUID,
    title VARCHAR(1000) NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    status VARCHAR(12) NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'completed')),
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
    CONSTRAINT tasks_title_nonempty CHECK (length(btrim(title)) BETWEEN 1 AND 1000),
    UNIQUE (user_id, id),
    FOREIGN KEY (user_id, list_id) REFERENCES lists(user_id, id)
);

CREATE UNIQUE INDEX idx_tasks_recurrence_identity
    ON tasks (user_id, series_id, occurrence_key)
    WHERE series_id IS NOT NULL AND occurrence_key IS NOT NULL;
CREATE INDEX idx_tasks_list_rank ON tasks (user_id, list_id, rank)
    WHERE deleted_at IS NULL;
CREATE INDEX idx_tasks_due ON tasks (user_id, due_on)
    WHERE deleted_at IS NULL AND status = 'open';
CREATE INDEX idx_tasks_important ON tasks (user_id, important, updated_at DESC)
    WHERE deleted_at IS NULL;
CREATE INDEX idx_tasks_user_updated ON tasks (user_id, updated_at);

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
    CONSTRAINT steps_title_nonempty CHECK (length(btrim(title)) BETWEEN 1 AND 1000),
    UNIQUE (user_id, id),
    FOREIGN KEY (user_id, task_id) REFERENCES tasks(user_id, id)
);

CREATE INDEX idx_steps_task ON steps (user_id, task_id, rank)
    WHERE deleted_at IS NULL;

CREATE TABLE day_plans (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    task_id UUID NOT NULL,
    local_date DATE NOT NULL,
    rank VARCHAR(128) NOT NULL DEFAULT 'a0',
    server_rev BIGINT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at TIMESTAMPTZ,
    FOREIGN KEY (user_id, task_id) REFERENCES tasks(user_id, id),
    UNIQUE (user_id, task_id, local_date)
);

CREATE INDEX idx_day_plans_by_date ON day_plans (user_id, local_date, rank)
    WHERE deleted_at IS NULL;

-- next_server_seq is allocated only while this row is locked in the same
-- transaction that writes entities, change_log, and op_receipts.
CREATE TABLE account_sync_state (
    user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    next_server_seq BIGINT NOT NULL DEFAULT 1 CHECK (next_server_seq > 0),
    min_available_seq BIGINT NOT NULL DEFAULT 0 CHECK (min_available_seq >= 0)
);
