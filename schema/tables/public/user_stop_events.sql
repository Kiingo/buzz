-- Only original signed, thread-scoped Stop commands belong here. This is a
-- control-audit index, never a second chat store: no event/channel FK, retention
-- expiry, or delete cascade may erase a Stop before an offline runtime sees it.
-- Whole-community deletion still owns these rows through its normal inventory.
CREATE TABLE user_stop_events (
    community_id UUID NOT NULL REFERENCES communities(id),
    id BYTEA NOT NULL CHECK (octet_length(id) = 32),
    pubkey BYTEA NOT NULL CHECK (octet_length(pubkey) = 32),
    created_at TIMESTAMPTZ NOT NULL,
    kind INT NOT NULL CHECK (kind = 9),
    tags JSONB NOT NULL,
    content TEXT NOT NULL,
    sig BYTEA NOT NULL CHECK (octet_length(sig) = 64),
    received_at TIMESTAMPTZ NOT NULL,
    channel_id UUID NOT NULL,
    root_event_id BYTEA NOT NULL CHECK (octet_length(root_event_id) = 32),
    PRIMARY KEY (community_id, id)
);
CREATE INDEX idx_user_stop_events_scope
    ON user_stop_events (community_id, channel_id, pubkey, root_event_id, created_at DESC, id);
