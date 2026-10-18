-- These fences outlive chat deletion and retention. There is deliberately no
-- channel/event FK or expiry: neither may resurrect cancelled output.
CREATE TABLE managed_publication_scopes (
    community_id UUID NOT NULL REFERENCES communities(id),
    issuer VARCHAR(96) NOT NULL,
    scope_kind TEXT NOT NULL CHECK (scope_kind IN ('discussion', 'receipt')),
    scope_id UUID NOT NULL,
    channel_id UUID NOT NULL,
    requester_pubkey BYTEA NOT NULL CHECK (octet_length(requester_pubkey) = 32),
    request_event_id BYTEA NOT NULL CHECK (octet_length(request_event_id) = 32),
    cancelled_at TIMESTAMPTZ,
    cancellation_event_id BYTEA CHECK (octet_length(cancellation_event_id) = 32),
    cancellation_user_event_id BYTEA CHECK (octet_length(cancellation_user_event_id) = 32),
    cancellation_authorization TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (community_id, issuer, scope_kind, scope_id),
    CHECK (
        (cancelled_at IS NULL AND cancellation_event_id IS NULL
         AND cancellation_user_event_id IS NULL AND cancellation_authorization IS NULL)
        OR
        (cancelled_at IS NOT NULL AND cancellation_event_id IS NOT NULL
         AND cancellation_user_event_id IS NOT NULL AND cancellation_authorization IS NOT NULL
         AND cancellation_user_event_id <> request_event_id
         AND length(cancellation_authorization) BETWEEN 1 AND 4096)
    )
);
