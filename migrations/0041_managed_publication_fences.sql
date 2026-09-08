-- Runtime trust is provisioned by the operator, never from an agent event.
CREATE TABLE managed_runtime_issuers (
    community_id UUID NOT NULL REFERENCES communities(id),
    issuer VARCHAR(96) NOT NULL,
    key_id VARCHAR(96) NOT NULL,
    public_key BYTEA NOT NULL CHECK (octet_length(public_key) = 32),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (community_id, issuer, key_id)
);

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

-- A receipt cannot migrate to a different discussion or signer to evade Stop.
CREATE TABLE managed_publication_receipts (
    community_id UUID NOT NULL REFERENCES communities(id),
    issuer VARCHAR(96) NOT NULL,
    receipt_id UUID NOT NULL,
    scope_kind TEXT NOT NULL,
    scope_id UUID NOT NULL,
    signer_pubkey BYTEA NOT NULL CHECK (octet_length(signer_pubkey) = 32),
    PRIMARY KEY (community_id, issuer, receipt_id),
    FOREIGN KEY (community_id, issuer, scope_kind, scope_id)
        REFERENCES managed_publication_scopes (community_id, issuer, scope_kind, scope_id),
    CHECK (scope_kind <> 'receipt' OR scope_id = receipt_id)
);

-- The row and visible event commit together. Exact retries acknowledge the
-- original acceptance even after Stop or chat retention, without re-inserting.
CREATE TABLE managed_publications (
    community_id UUID NOT NULL REFERENCES communities(id),
    issuer VARCHAR(96) NOT NULL,
    fence_id UUID NOT NULL,
    receipt_id UUID NOT NULL,
    event_id BYTEA NOT NULL CHECK (octet_length(event_id) = 32),
    runtime_authorization TEXT NOT NULL CHECK (length(runtime_authorization) BETWEEN 1 AND 4096),
    accepted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (community_id, issuer, fence_id),
    UNIQUE (community_id, issuer, event_id),
    FOREIGN KEY (community_id, issuer, receipt_id)
        REFERENCES managed_publication_receipts (community_id, issuer, receipt_id)
);

SELECT attach_community_write_fence('managed_runtime_issuers');
SELECT attach_community_write_fence('managed_publication_scopes');
SELECT attach_community_write_fence('managed_publication_receipts');
SELECT attach_community_write_fence('managed_publications');
