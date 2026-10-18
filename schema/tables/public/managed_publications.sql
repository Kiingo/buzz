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
