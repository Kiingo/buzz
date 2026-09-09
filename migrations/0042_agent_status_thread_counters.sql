-- Operational status remains durable thread evidence, not a contribution.
-- Repair only ancestors of existing status rows; do not alter signed events.
WITH affected AS (
    SELECT DISTINCT tm.community_id, ancestor.event_id
    FROM thread_metadata tm
    JOIN events e ON e.community_id = tm.community_id
                 AND e.created_at = tm.event_created_at AND e.id = tm.event_id
    CROSS JOIN LATERAL (VALUES (tm.parent_event_id), (tm.root_event_id)) ancestor(event_id)
    WHERE e.kind = 40098 AND ancestor.event_id IS NOT NULL
), corrected AS (
    SELECT a.community_id, a.event_id,
        (SELECT COUNT(*) FROM thread_metadata child
         JOIN events e ON e.community_id = child.community_id
                      AND e.created_at = child.event_created_at AND e.id = child.event_id
         WHERE child.community_id = a.community_id AND child.parent_event_id = a.event_id
           AND e.deleted_at IS NULL AND e.kind <> 40098) AS reply_count,
        (SELECT COUNT(*) FROM thread_metadata child
         JOIN events e ON e.community_id = child.community_id
                      AND e.created_at = child.event_created_at AND e.id = child.event_id
         WHERE child.community_id = a.community_id AND child.root_event_id = a.event_id
           AND e.deleted_at IS NULL AND e.kind <> 40098) AS descendant_count,
        (SELECT MAX(e.received_at) FROM thread_metadata child
         JOIN events e ON e.community_id = child.community_id
                      AND e.created_at = child.event_created_at AND e.id = child.event_id
         WHERE child.community_id = a.community_id AND child.parent_event_id = a.event_id
           AND e.deleted_at IS NULL AND e.kind <> 40098) AS last_reply_at
    FROM affected a
)
UPDATE thread_metadata tm
SET reply_count = c.reply_count, descendant_count = c.descendant_count,
    last_reply_at = c.last_reply_at
FROM corrected c
WHERE tm.community_id = c.community_id AND tm.event_id = c.event_id;
