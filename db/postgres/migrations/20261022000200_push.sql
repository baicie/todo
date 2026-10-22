-- Web Push subscriptions, delivery deduplication, and per-user test limits.

CREATE TABLE push_subscriptions (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    endpoint TEXT NOT NULL UNIQUE,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    user_agent TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    failed_at TIMESTAMPTZ,
    CONSTRAINT push_subscriptions_endpoint_nonempty CHECK (length(btrim(endpoint)) > 0),
    CONSTRAINT push_subscriptions_p256dh_nonempty CHECK (length(btrim(p256dh)) > 0),
    CONSTRAINT push_subscriptions_auth_nonempty CHECK (length(btrim(auth)) > 0)
);

CREATE INDEX idx_push_subscriptions_user ON push_subscriptions (user_id);
CREATE INDEX idx_push_subscriptions_active
    ON push_subscriptions (user_id) WHERE failed_at IS NULL;

CREATE TABLE push_deliveries (
    task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    subscription_id UUID NOT NULL REFERENCES push_subscriptions(id) ON DELETE CASCADE,
    delivered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (task_id, subscription_id)
);

CREATE INDEX idx_push_deliveries_delivered_at ON push_deliveries (delivered_at);
CREATE INDEX idx_push_deliveries_subscription ON push_deliveries (subscription_id);

CREATE TABLE push_test_usage (
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    usage_day DATE NOT NULL,
    used SMALLINT NOT NULL DEFAULT 0 CHECK (used >= 0),
    PRIMARY KEY (user_id, usage_day)
);
