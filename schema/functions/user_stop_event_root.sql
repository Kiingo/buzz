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
