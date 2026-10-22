-- Refresh-token rotation history and the append-only sync log.

CREATE TABLE refresh_tokens (
    id UUID PRIMARY KEY,
    session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    token_hash BYTEA NOT NULL UNIQUE,
    expires_at TIMESTAMPTZ NOT NULL,
    rotated_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ,
    replaced_by UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_refresh_tokens_session ON refresh_tokens (session_id);
CREATE INDEX idx_refresh_tokens_expiry ON refresh_tokens (expires_at);

-- Receipts survive long enough to answer retries. `server_seq` is NULL for a
-- rejected mutation because no change event was emitted.
CREATE TABLE op_receipts (
    op_id UUID PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_id UUID NOT NULL,
    client_seq BIGINT NOT NULL CHECK (client_seq > 0),
    server_seq BIGINT,
    status TEXT NOT NULL CHECK (status IN ('applied', 'rejected')),
    error_code TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT op_receipts_applied_has_seq
        CHECK ((status = 'applied' AND server_seq IS NOT NULL)
            OR (status = 'rejected')),
    UNIQUE (user_id, device_id, client_seq),
    FOREIGN KEY (user_id, device_id) REFERENCES devices(user_id, id)
);

CREATE INDEX idx_op_receipts_user_seq ON op_receipts (user_id, server_seq);
CREATE INDEX idx_op_receipts_device_seq ON op_receipts (device_id, client_seq);

CREATE TABLE change_log (
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    server_seq BIGINT NOT NULL CHECK (server_seq > 0),
    op_id UUID NOT NULL,
    entity_type TEXT NOT NULL CHECK (entity_type IN ('list', 'task', 'step', 'day_plan')),
    entity_id UUID NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('create', 'patch', 'delete', 'restore')),
    patch JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, server_seq)
);

CREATE INDEX idx_change_log_retention ON change_log (created_at);
CREATE INDEX idx_change_log_entity ON change_log (user_id, entity_type, entity_id, server_seq DESC);
