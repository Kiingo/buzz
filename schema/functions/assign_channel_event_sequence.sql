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
