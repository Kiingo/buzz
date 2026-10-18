CREATE FUNCTION retain_user_stop_event() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
    stop_root BYTEA;
BEGIN
    stop_root := user_stop_event_root(NEW.kind, NEW.tags, NEW.content, NEW.channel_id);
    IF stop_root IS NOT NULL THEN
        INSERT INTO user_stop_events
            (community_id, id, pubkey, created_at, kind, tags, content, sig,
             received_at, channel_id, root_event_id)
        VALUES
            (NEW.community_id, NEW.id, NEW.pubkey, NEW.created_at, NEW.kind,
             NEW.tags, NEW.content, NEW.sig, NEW.received_at, NEW.channel_id, stop_root)
        ON CONFLICT (community_id, id) DO NOTHING;
    END IF;
    RETURN NEW;
END
$$;
