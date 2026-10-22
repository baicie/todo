-- Shared authentication rate limiting and indexes used by retention jobs.

CREATE TABLE auth_rate_limit_windows (
    bucket TEXT NOT NULL CHECK (length(bucket) BETWEEN 1 AND 128),
    subject_hash BYTEA NOT NULL CHECK (octet_length(subject_hash) = 32),
    window_start TIMESTAMPTZ NOT NULL,
    request_count BIGINT NOT NULL DEFAULT 1 CHECK (request_count > 0),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (bucket, subject_hash, window_start)
);

CREATE INDEX idx_auth_rate_limit_windows_expiry
    ON auth_rate_limit_windows (window_start);

CREATE INDEX idx_auth_codes_expires_at
    ON auth_codes (expires_at);

CREATE INDEX idx_users_deleted_at
    ON users (deleted_at)
    WHERE deleted_at IS NOT NULL;

CREATE INDEX idx_sessions_revoked_at
    ON sessions (revoked_at)
    WHERE revoked_at IS NOT NULL;

CREATE INDEX idx_refresh_tokens_revoked_at
    ON refresh_tokens (revoked_at)
    WHERE revoked_at IS NOT NULL;

CREATE INDEX idx_op_receipts_created_at
    ON op_receipts (created_at);
