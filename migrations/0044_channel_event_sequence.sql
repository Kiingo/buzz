-- Commit-ordered positions for newly accepted channel messages. Signed event
-- fields, existing history, deletion semantics and ordinary Nostr reads stay
-- unchanged. NULL identifies history predating this transport contract; it is
-- deliberately not replayed as newly submitted work.
ALTER TABLE events ADD COLUMN channel_sequence NUMERIC;
ALTER TABLE events ADD CONSTRAINT events_channel_sequence_ck CHECK (
    channel_sequence IS NULL OR
    (kind = 9 AND channel_id IS NOT NULL AND channel_sequence > 0
     AND channel_sequence = trunc(channel_sequence))
);
CREATE TABLE channel_event_heads (
    community_id UUID NOT NULL REFERENCES communities(id),
    channel_id UUID NOT NULL,
    sequence NUMERIC NOT NULL CHECK (sequence >= 0 AND sequence = trunc(sequence)),
    PRIMARY KEY (community_id, channel_id)
);
SELECT attach_community_write_fence('channel_event_heads');

-- A sequence/identity alone is NOT a safe high-water mark: a later transaction
-- can commit before a lower allocated value. Updating this scoped row holds its
-- lock until the event transaction commits/rolls back. A reader on the writer
-- therefore cannot observe a higher position with an uncommitted lower input.
-- Different channels/communities do not serialize one another. Numeric avoids
-- a machine-integer lifetime ceiling; only each query page is bounded.
CREATE FUNCTION assign_channel_event_sequence() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
    NEW.channel_sequence := NULL;
    IF NEW.kind = 9 AND NEW.channel_id IS NOT NULL THEN
        INSERT INTO channel_event_heads (community_id, channel_id, sequence)
        VALUES (NEW.community_id, NEW.channel_id, 1)
        ON CONFLICT (community_id, channel_id) DO UPDATE
            SET sequence = channel_event_heads.sequence + 1
        RETURNING sequence INTO NEW.channel_sequence;
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER trg_assign_channel_event_sequence
    BEFORE INSERT ON events
    FOR EACH ROW EXECUTE FUNCTION assign_channel_event_sequence();
CREATE INDEX idx_events_channel_sequence
    ON events (community_id, channel_id, channel_sequence)
    WHERE kind = 9 AND channel_sequence IS NOT NULL AND deleted_at IS NULL;
