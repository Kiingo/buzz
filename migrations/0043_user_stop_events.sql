-- Only original signed, thread-scoped Stop commands belong here. This is a
-- control-audit index, never a second chat store: no event/channel FK, retention
-- expiry, or delete cascade may erase a Stop before an offline runtime sees it.
-- Whole-community deletion still owns these rows through its normal inventory.
CREATE TABLE user_stop_events (
    community_id UUID NOT NULL REFERENCES communities(id),
    id BYTEA NOT NULL CHECK (octet_length(id) = 32),
    pubkey BYTEA NOT NULL CHECK (octet_length(pubkey) = 32),
    created_at TIMESTAMPTZ NOT NULL,
    kind INT NOT NULL CHECK (kind = 9),
    tags JSONB NOT NULL,
    content TEXT NOT NULL,
    sig BYTEA NOT NULL CHECK (octet_length(sig) = 64),
    received_at TIMESTAMPTZ NOT NULL,
    channel_id UUID NOT NULL,
    root_event_id BYTEA NOT NULL CHECK (octet_length(root_event_id) = 32),
    PRIMARY KEY (community_id, id)
);
CREATE INDEX idx_user_stop_events_scope
    ON user_stop_events (community_id, channel_id, pubkey, root_event_id, created_at DESC, id);

-- Match the public cancellation contract, not natural-language intent.
-- ECMAScript trim/\s is explicit: PostgreSQL/Rust whitespace classes differ
-- (notably U+0085). Last valid NIP-10 root/reply markers win; root-only is not
-- a reply. The signature and event id remain unchanged and are reverified by
-- the consuming runtime before any cancellation authority is admitted.
CREATE FUNCTION user_stop_event_root(
    p_kind INT, p_tags JSONB, p_content TEXT, p_channel_id UUID
) RETURNS BYTEA
LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE AS $$
DECLARE
    tag JSONB;
    channel_text TEXT;
    channel_count INT := 0;
    root_text TEXT;
    reply_text TEXT;
    normalized TEXT;
BEGIN
    IF p_kind <> 9 OR strpos(p_content, '!cancel') = 0
       OR jsonb_typeof(p_tags) <> 'array' THEN
        RETURN NULL;
    END IF;
    IF jsonb_array_length(p_tags) > 2000 THEN
        RETURN NULL;
    END IF;
    normalized := btrim(regexp_replace(
        p_content,
        U&'[\0009-\000D\0020\00A0\1680\2000-\200A\2028\2029\202F\205F\3000\FEFF]+',
        ' ', 'g'
    ));
    IF normalized COLLATE "C" !~ '^(nostr:[a-zA-Z0-9]+ )*!cancel( nostr:[a-zA-Z0-9]+)*$' THEN
        RETURN NULL;
    END IF;
    FOR tag IN SELECT value FROM jsonb_array_elements(p_tags)
    LOOP
        IF jsonb_typeof(tag) <> 'array' THEN
            RETURN NULL;
        END IF;
        IF EXISTS (SELECT 1 FROM jsonb_array_elements(tag) part WHERE jsonb_typeof(part) <> 'string') THEN
            RETURN NULL;
        END IF;
        IF tag->>0 = 'h' THEN
            channel_count := channel_count + 1;
            channel_text := tag->>1;
        ELSIF tag->>0 = 'e' AND (tag->>1) COLLATE "C" ~ '^[0-9a-fA-F]{64}$' THEN
            IF tag->>3 = 'root' THEN
                root_text := tag->>1;
            ELSIF tag->>3 = 'reply' THEN
                reply_text := tag->>1;
            END IF;
        END IF;
    END LOOP;
    IF channel_count <> 1 OR channel_text IS NULL OR reply_text IS NULL THEN
        RETURN NULL;
    END IF;
    IF channel_text COLLATE "C" !~ '^(00000000-0000-0000-0000-000000000000|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$' THEN
        RETURN NULL;
    END IF;
    IF channel_text::UUID <> p_channel_id THEN
        RETURN NULL;
    END IF;
    RETURN decode(coalesce(root_text, reply_text), 'hex');
END
$$;

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

-- The original event and its recovery evidence commit or roll back together,
-- including backdated/out-of-order commits and every event insertion entrypoint.
CREATE TRIGGER retain_user_stop_event
AFTER INSERT ON events
FOR EACH ROW WHEN (NEW.kind = 9 AND strpos(NEW.content, '!cancel') > 0)
EXECUTE FUNCTION retain_user_stop_event();

-- One-time migration of original retained events only. No receipt, cancellation
-- marker, acknowledgement, model contribution, or historical outcome is invented.
INSERT INTO user_stop_events
    (community_id, id, pubkey, created_at, kind, tags, content, sig,
     received_at, channel_id, root_event_id)
SELECT community_id, id, pubkey, created_at, kind, tags, content, sig,
       received_at, channel_id, user_stop_event_root(kind, tags, content, channel_id)
FROM events
WHERE kind = 9 AND strpos(content, '!cancel') > 0
  AND user_stop_event_root(kind, tags, content, channel_id) IS NOT NULL
ON CONFLICT (community_id, id) DO NOTHING;

SELECT attach_community_write_fence('user_stop_events');
