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
