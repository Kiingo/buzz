-- Writer transaction heads, not authored timestamps or pre-commit identities.
CREATE TABLE channel_event_heads (
    community_id UUID NOT NULL REFERENCES communities(id),
    channel_id UUID NOT NULL,
    sequence NUMERIC NOT NULL CHECK (sequence >= 0 AND sequence = trunc(sequence)),
    PRIMARY KEY (community_id, channel_id)
);
