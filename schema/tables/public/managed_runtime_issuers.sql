-- Runtime trust is provisioned by the operator, never from an agent event.
CREATE TABLE managed_runtime_issuers (
    community_id UUID NOT NULL REFERENCES communities(id),
    issuer VARCHAR(96) NOT NULL,
    key_id VARCHAR(96) NOT NULL,
    public_key BYTEA NOT NULL CHECK (octet_length(public_key) = 32),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (community_id, issuer, key_id)
);
