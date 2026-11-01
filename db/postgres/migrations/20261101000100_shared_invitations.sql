-- Shared-list invitations. An owner invites an email address; the person who
-- signs in with that address accepts or declines. Unregistered addresses stay
-- pending and become visible once that address registers. Rows are never
-- deleted by the API: status transitions keep an audit trail.

CREATE TABLE shared_list_invitations (
    id UUID PRIMARY KEY,
    list_id UUID NOT NULL REFERENCES shared_lists(id) ON DELETE CASCADE,
    email_normalized TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('editor', 'viewer')),
    -- 'revoked' is reserved for owner-side cancellation; v1 does not expose it.
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'accepted', 'declined', 'revoked')),
    invited_by UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    responded_by UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    responded_at TIMESTAMPTZ,
    CONSTRAINT shared_list_invitations_email_lower
        CHECK (email_normalized = lower(email_normalized)),
    CONSTRAINT shared_list_invitations_email_length
        CHECK (length(email_normalized) BETWEEN 3 AND 254)
);

-- At most one open invitation per list and address; re-inviting updates it.
CREATE UNIQUE INDEX idx_shared_list_invitations_pending
    ON shared_list_invitations (list_id, email_normalized)
    WHERE status = 'pending';

CREATE INDEX idx_shared_list_invitations_email
    ON shared_list_invitations (email_normalized, created_at DESC)
    WHERE status = 'pending';
