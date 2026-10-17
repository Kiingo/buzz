CREATE TRIGGER trg_events_guard_channel_roster_snapshot
    BEFORE INSERT ON events
    FOR EACH ROW EXECUTE FUNCTION guard_channel_roster_snapshot();

-- INSERT OR UPDATE OF: an UPDATE can move a previously exempt row into the
-- guarded set (channel_id NULL -> NOT NULL) or move a channel row's
-- created_at below the fence, so both mutation paths re-run the guard on the
-- NEW row. A created_at rewrite that crosses partition bounds runs as
-- DELETE + INSERT and hits the cloned AFTER INSERT guard on the destination
-- partition; an in-partition rewrite fires the UPDATE OF arm.
CREATE CONSTRAINT TRIGGER events_created_at_floor
    AFTER INSERT OR UPDATE OF created_at, channel_id ON events
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW
    EXECUTE FUNCTION events_created_at_floor_guard();
CREATE TRIGGER trg_assign_channel_event_sequence
    BEFORE INSERT ON events
    FOR EACH ROW EXECUTE FUNCTION assign_channel_event_sequence();

-- The original event and its recovery evidence commit or roll back together,
-- including backdated/out-of-order commits and every event insertion entrypoint.
CREATE TRIGGER retain_user_stop_event
AFTER INSERT ON events
FOR EACH ROW WHEN (NEW.kind = 9 AND strpos(NEW.content, '!cancel') > 0)
EXECUTE FUNCTION retain_user_stop_event();
SELECT attach_community_write_fence('events');
