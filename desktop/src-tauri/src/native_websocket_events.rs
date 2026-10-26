//! Relay `EVENT` frames are verified in the socket task, before the webview
//! sees them. An event whose id is not the NIP-01 hash of its fields, or
//! whose signature is not its author's, never reaches a subscriber, a cache
//! or a notification. A verified event is handed on re-serialized from what
//! was verified, so a field the relay added, or a number the webview would
//! read differently, cannot reach it unsigned.
//!
//! Only relay clients may use this plugin: it drops text frames that are not
//! readable relay messages. `relayWebSocketPluginUsers.test.mjs` pins its
//! renderer users.

use std::fmt;

use serde::de::{self, Deserialize, Deserializer, IgnoredAny, SeqAccess, Visitor};

/// What the socket task does with one inbound text frame.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum InboundFrame {
    /// Not an `EVENT` frame: delivered unchanged.
    Pass,
    /// An `EVENT` frame whose event verifies: delivered as this frame,
    /// `["EVENT", <subscription id>, <the verified event>]`, re-serialized
    /// with exactly the seven NIP-01 fields.
    VerifiedEvent(String),
    /// Dropped: an `EVENT` frame whose event is malformed or does not
    /// verify, or a frame that is not JSON the renderer could act on safely.
    Drop(&'static str),
}

/// Classifies a relay text frame. Parsing fails closed: a frame this parser
/// cannot read is dropped rather than handed to a renderer that might read
/// it as an event. Relays never send such frames, so nothing valid is lost.
pub(crate) fn classify_inbound_frame(payload: &str) -> InboundFrame {
    let (subscription_id, event) = match serde_json::from_str::<Frame>(payload) {
        Ok(Frame::Other) => return InboundFrame::Pass,
        Ok(Frame::Event(subscription_id, event)) => (subscription_id, event),
        Err(_) => return InboundFrame::Drop("unreadable frame"),
    };
    if event.verify().is_err() {
        return InboundFrame::Drop("event failed verification");
    }
    // JavaScript reads `created_at` as a double; past 2^53 it would read a
    // different time than the one signed.
    if event.created_at.as_secs() > MAX_SAFE_JS_INTEGER {
        return InboundFrame::Drop("created_at beyond what the webview reads exactly");
    }
    match serde_json::to_string(&("EVENT", subscription_id, &event)) {
        Ok(frame) => InboundFrame::VerifiedEvent(frame),
        Err(_) => InboundFrame::Drop("event could not be re-serialized"),
    }
}

/// `Number.MAX_SAFE_INTEGER`.
const MAX_SAFE_JS_INTEGER: u64 = (1 << 53) - 1;

enum Frame {
    Event(String, Box<nostr::Event>),
    Other,
}

impl<'de> Deserialize<'de> for Frame {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        deserializer.deserialize_any(FrameVisitor)
    }
}

struct FrameVisitor;

impl<'de> Visitor<'de> for FrameVisitor {
    type Value = Frame;

    fn expecting(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
        formatter.write_str("a relay message")
    }

    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Frame, A::Error> {
        // The renderer acts only on arrays led by a string message type.
        let kind = match seq.next_element::<serde_json::Value>()? {
            Some(serde_json::Value::String(kind)) => kind,
            _ => {
                while seq.next_element::<IgnoredAny>()?.is_some() {}
                return Ok(Frame::Other);
            }
        };
        if kind != "EVENT" {
            while seq.next_element::<IgnoredAny>()?.is_some() {}
            return Ok(Frame::Other);
        }
        // `["EVENT", <subscription id>, <event>]`; the renderer reads only
        // a string subscription id, and nothing after the event.
        let subscription_id = seq
            .next_element::<String>()?
            .ok_or_else(|| de::Error::invalid_length(1, &self))?;
        let event = seq
            .next_element::<nostr::Event>()?
            .ok_or_else(|| de::Error::invalid_length(2, &self))?;
        while seq.next_element::<IgnoredAny>()?.is_some() {}
        Ok(Frame::Event(subscription_id, Box::new(event)))
    }

    // Any other JSON value is not a relay message the renderer acts on.
    fn visit_map<A: de::MapAccess<'de>>(self, mut map: A) -> Result<Frame, A::Error> {
        while map.next_entry::<IgnoredAny, IgnoredAny>()?.is_some() {}
        Ok(Frame::Other)
    }

    fn visit_str<E: de::Error>(self, _: &str) -> Result<Frame, E> {
        Ok(Frame::Other)
    }

    fn visit_bool<E: de::Error>(self, _: bool) -> Result<Frame, E> {
        Ok(Frame::Other)
    }

    fn visit_i64<E: de::Error>(self, _: i64) -> Result<Frame, E> {
        Ok(Frame::Other)
    }

    fn visit_u64<E: de::Error>(self, _: u64) -> Result<Frame, E> {
        Ok(Frame::Other)
    }

    fn visit_f64<E: de::Error>(self, _: f64) -> Result<Frame, E> {
        Ok(Frame::Other)
    }

    fn visit_unit<E: de::Error>(self) -> Result<Frame, E> {
        Ok(Frame::Other)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use nostr::{EventBuilder, JsonUtil, Keys, Kind};

    fn signed(content: &str, keys: &Keys) -> nostr::Event {
        EventBuilder::new(Kind::Custom(40002), content)
            .sign_with_keys(keys)
            .expect("sign")
    }

    fn frame(event: &serde_json::Value) -> String {
        serde_json::json!(["EVENT", "l-1", event]).to_string()
    }

    fn json(event: &nostr::Event) -> serde_json::Value {
        serde_json::from_str(&event.as_json()).expect("event json")
    }

    /// The frame a verified event is delivered as, parsed back.
    fn delivered(payload: &str) -> serde_json::Value {
        match classify_inbound_frame(payload) {
            InboundFrame::VerifiedEvent(frame) => serde_json::from_str(&frame).expect("frame json"),
            other => panic!("expected a verified event, got {other:?}: {payload}"),
        }
    }

    #[test]
    fn a_genuine_event_is_delivered() {
        let event = signed("hello", &Keys::generate());
        assert_eq!(
            delivered(&frame(&json(&event))),
            serde_json::json!(["EVENT", "l-1", json(&event)])
        );
    }

    #[test]
    fn a_verified_event_is_delivered_with_only_its_signed_fields() {
        let event = signed("hello", &Keys::generate());
        let mut padded = json(&event);
        padded["relay_note"] = "added by the relay".into();
        padded["content_html"] = "<b>unsigned</b>".into();
        let payload = serde_json::json!(["EVENT", "l-1", padded, {"extra": true}]).to_string();

        let frame = delivered(&payload);
        assert_eq!(frame, serde_json::json!(["EVENT", "l-1", json(&event)]));
        let delivered_event = frame[2].as_object().expect("event object");
        let mut fields: Vec<&str> = delivered_event.keys().map(String::as_str).collect();
        fields.sort_unstable();
        assert_eq!(
            fields,
            [
                "content",
                "created_at",
                "id",
                "kind",
                "pubkey",
                "sig",
                "tags"
            ]
        );
    }

    #[test]
    fn a_time_past_what_javascript_reads_exactly_is_dropped() {
        let keys = Keys::generate();
        let at = |secs: u64| {
            EventBuilder::new(Kind::Custom(40002), "late")
                .custom_created_at(nostr::Timestamp::from_secs(secs))
                .sign_with_keys(&keys)
                .expect("sign")
        };
        let last_exact = at(MAX_SAFE_JS_INTEGER);
        assert_eq!(
            delivered(&frame(&json(&last_exact)))[2]["created_at"],
            MAX_SAFE_JS_INTEGER
        );
        assert!(matches!(
            classify_inbound_frame(&frame(&json(&at(MAX_SAFE_JS_INTEGER + 1)))),
            InboundFrame::Drop(_)
        ));
    }

    #[test]
    fn other_relay_messages_pass_unchanged() {
        for payload in [
            r#"["EOSE","l-1"]"#,
            r#"["OK","abc",true,""]"#,
            r#"["CLOSED","l-1","error: x"]"#,
            r#"["NOTICE","slow down"]"#,
            r#"["AUTH","challenge"]"#,
            r#"[]"#,
            r#"[1,2]"#,
            r#"{"type":"x"}"#,
            r#""text""#,
        ] {
            assert_eq!(
                classify_inbound_frame(payload),
                InboundFrame::Pass,
                "{payload}"
            );
        }
    }

    #[test]
    fn forged_events_are_dropped() {
        let author = Keys::generate();
        let genuine = json(&signed("hello", &author));
        let other = json(&signed("other", &author));
        let mut edited = genuine.clone();
        edited["content"] = "edited".into();
        let mut resigned = genuine.clone();
        resigned["sig"] = other["sig"].clone();
        // Signed by another key, then attributed to the author with a
        // matching id: only the signature check catches it.
        let forged = signed("forged", &Keys::generate());
        let reattributed_id = nostr::EventId::new(
            &author.public_key(),
            &forged.created_at,
            &forged.kind,
            &forged.tags,
            &forged.content,
        );
        let mut reattributed_json = json(&forged);
        reattributed_json["pubkey"] = author.public_key().to_hex().into();
        reattributed_json["id"] = reattributed_id.to_hex().into();

        for event in [edited, resigned, reattributed_json] {
            assert!(
                matches!(
                    classify_inbound_frame(&frame(&event)),
                    InboundFrame::Drop(_)
                ),
                "{event}"
            );
        }
    }

    #[test]
    fn unreadable_or_disguised_event_frames_are_dropped() {
        let genuine = json(&signed("hello", &Keys::generate()));
        let mut missing = genuine.clone();
        missing.as_object_mut().expect("object").remove("sig");
        let escaped = frame(&genuine).replacen("\"EVENT\"", "\"\\u0045VENT\"", 1);
        let mut deep = String::new();
        for _ in 0..200 {
            deep.push('[');
        }
        for _ in 0..200 {
            deep.push(']');
        }
        for payload in [
            frame(&missing),
            r#"["EVENT","l-1"]"#.to_string(),
            r#"["EVENT","l-1",{"id":"x"}]"#.to_string(),
            "not json".to_string(),
            format!(r#"["EVENT",5,{genuine}]"#),
            format!(r#"["EVENT","l-1",{genuine},{deep}]"#),
        ] {
            assert!(
                matches!(classify_inbound_frame(&payload), InboundFrame::Drop(_)),
                "{payload}"
            );
        }
        // An escaped message type still reads as EVENT, is verified, and is
        // delivered spelled plainly.
        assert_eq!(delivered(&escaped)[0], "EVENT");
    }
}
