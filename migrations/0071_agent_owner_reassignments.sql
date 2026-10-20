-- Durable audit of every guarded agent owner reassignment. A row is written in
-- the same transaction that moves users.agent_owner_pubkey from a rotated
-- owner key to its successor, and names the signed NIP-IA archive evidence the
-- move rests on. Rows are append-only evidence, never consulted for
-- authorization.
CREATE TABLE agent_owner_reassignments (
    community_id UUID NOT NULL REFERENCES communities(id),
    id UUID NOT NULL DEFAULT gen_random_uuid(),
    agent_pubkey BYTEA NOT NULL CHECK (octet_length(agent_pubkey) = 32),
    previous_owner_pubkey BYTEA NOT NULL CHECK (octet_length(previous_owner_pubkey) = 32),
    new_owner_pubkey BYTEA NOT NULL CHECK (octet_length(new_owner_pubkey) = 32),
    evidence TEXT NOT NULL CHECK (evidence IN ('nip_ia_self', 'nip_ia_admin')),
    archive_actor TEXT NOT NULL,
    archive_request_event_id TEXT NOT NULL,
    archived_at TIMESTAMPTZ NOT NULL,
    reassigned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (community_id, id),
    CHECK (previous_owner_pubkey <> new_owner_pubkey)
);
CREATE INDEX idx_agent_owner_reassignments_agent
    ON agent_owner_reassignments (community_id, agent_pubkey, reassigned_at DESC);

SELECT attach_community_write_fence('agent_owner_reassignments');
