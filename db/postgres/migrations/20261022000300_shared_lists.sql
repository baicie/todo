-- Shared-list collaboration v1. Shared entities are intentionally separate from
-- personal sync entities so personal and shared history cannot collide.

CREATE TABLE shared_lists (
    id UUID PRIMARY KEY,
    owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name VARCHAR(120) NOT NULL,
    color TEXT,
    icon TEXT,
    rank VARCHAR(128) NOT NULL DEFAULT 'a0',
    revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at TIMESTAMPTZ,
    CONSTRAINT shared_lists_name_nonempty CHECK (length(btrim(name)) BETWEEN 1 AND 120)
);

CREATE INDEX idx_shared_lists_owner ON shared_lists (owner_id)
    WHERE deleted_at IS NULL;
CREATE INDEX idx_shared_lists_updated ON shared_lists (updated_at DESC)
    WHERE deleted_at IS NULL;

CREATE TABLE shared_list_members (
    list_id UUID NOT NULL REFERENCES shared_lists(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('owner', 'editor', 'viewer')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at TIMESTAMPTZ,
    PRIMARY KEY (list_id, user_id)
);

CREATE INDEX idx_shared_list_members_user ON shared_list_members (user_id)
    WHERE deleted_at IS NULL;
CREATE INDEX idx_shared_list_members_list ON shared_list_members (list_id)
    WHERE deleted_at IS NULL;

CREATE TABLE shared_tasks (
    id UUID PRIMARY KEY,
    list_id UUID NOT NULL REFERENCES shared_lists(id) ON DELETE CASCADE,
    title VARCHAR(1000) NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    status VARCHAR(12) NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'completed')),
    important BOOLEAN NOT NULL DEFAULT FALSE,
    due_on DATE,
    rank VARCHAR(128) NOT NULL DEFAULT 'a0',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at TIMESTAMPTZ,
    CONSTRAINT shared_tasks_title_nonempty CHECK (length(btrim(title)) BETWEEN 1 AND 1000)
);

CREATE INDEX idx_shared_tasks_list ON shared_tasks (list_id, rank, created_at)
    WHERE deleted_at IS NULL;
CREATE INDEX idx_shared_tasks_due ON shared_tasks (list_id, due_on)
    WHERE deleted_at IS NULL AND status = 'open';

CREATE TABLE shared_steps (
    id UUID PRIMARY KEY,
    task_id UUID NOT NULL REFERENCES shared_tasks(id) ON DELETE CASCADE,
    title VARCHAR(1000) NOT NULL,
    is_completed BOOLEAN NOT NULL DEFAULT FALSE,
    rank VARCHAR(128) NOT NULL DEFAULT 'a0',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at TIMESTAMPTZ,
    CONSTRAINT shared_steps_title_nonempty CHECK (length(btrim(title)) BETWEEN 1 AND 1000)
);

CREATE INDEX idx_shared_steps_task ON shared_steps (task_id, rank, created_at)
    WHERE deleted_at IS NULL;

CREATE TABLE shared_op_receipts (
    list_id UUID NOT NULL REFERENCES shared_lists(id) ON DELETE CASCADE,
    op_id UUID NOT NULL,
    actor_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    revision BIGINT NOT NULL CHECK (revision > 0),
    status TEXT NOT NULL CHECK (status IN ('applied', 'rejected')),
    error_code TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (list_id, op_id)
);

CREATE INDEX idx_shared_op_receipts_actor ON shared_op_receipts (actor_id, created_at DESC);
