//! Cross-pod huddle audio: owner fan-out over the relay mesh.
//!
//! Today a huddle's audio only fans out within a single pod
//! ([`super::room::Room::broadcast_frame`]). Under horizontal scaling, two
//! participants can land on different pods and never hear each other — which is
//! why [`super::handler`] rejects joins with `huddle_audio_unavailable` when the
//! deployment sets `huddle_audio_available = false`. This module removes that
//! wall by routing audio across the mesh to the pod that *owns* the huddle.
//!
//! ## Owner-authoritative model
//!
//! One pod owns a huddle: the holder of the Redis fenced CAS lease for
//! `session_id == channel_id` (the session directory, Perci's lane, exposed to
//! us through [`HuddleOwnerDirectory`]). That pod hosts the single
//! [`Room`](super::room::Room) —
//! the sole allocator of the 0..=254 `peer_index` space, so indices can never
//! collide across pods. Non-owner pods are thin: they register their local
//! clients as *remote peers* in the owner's room over a reliable
//! [`Profile::HuddleControl`] stream, forward those clients' Opus frames to the
//! owner as datagrams, and deliver the owner's fan-out back verbatim.
//!
//! ## The payload invariant (why this needs no wire change)
//!
//! Protocol v1/v2 clients send an opaque client frame and receive the released
//! one-byte `[peer_index]` routing prefix. Protocol v3 adds a per-index `epoch`,
//! so its relay-added prefix is `[peer_index][epoch]`. The relay parses v2/v3
//! frame headers for telemetry only and otherwise forwards client bytes opaquely.
//! Both prefix shapes are routing metadata — they never touch ciphertext — and
//! map directly onto [`MeshDatagram::payload`]. **peer_index is always the first
//! byte of a media datagram payload, both directions**; the remainder is the
//! versioned opaque wire frame and rides unchanged through the split-and-reprefix
//! below. The client's WebSocket wire format stays byte-identical to single-pod
//! fan-out.
//!
//! ## Room stays pure
//!
//! `Room` never learns about the mesh. A remote participant is an ordinary
//! [`AudioPeer`] whose `audio_tx` receiver is drained by a task that wraps each
//! frame in a [`MeshDatagram`] and calls [`RelayPeerTransport::send_datagram`].
//! The in-pod fan-out is reused unchanged; only a peer's *sink* differs.
//!
//! ## Once per pod, not once per participant
//!
//! A non-owner pod delivers every media datagram it receives to *all* of its
//! local clients (minus the author). The owner therefore sends each frame to a
//! pod once: the remote peers one pod registers share a
//! [`DeliveryGroup`](super::room::DeliveryGroup), and the room's fan-out hands a
//! frame to one member per group. Sending it through every member's sink would
//! make each of N co-located clients hear every frame N times.
//!
//! ## Fencing (law, not exempt for media)
//!
//! Every datagram carries a [`FencedHeader`]. Both ends reject frames whose
//! generation is stale for the session — a late datagram from a dead generation
//! is dropped, which for lossy audio is indistinguishable from packet loss and
//! is therefore exactly correct. Monotonicity of `generation` across owner death
//! is guaranteed by the directory's companion INCR counter (session-directory
//! lane); this module trusts that and only enforces "reject < known".

use std::sync::Arc;

use bytes::Bytes;
use tokio::sync::mpsc;
use tracing::{debug, warn};
use uuid::Uuid;

use buzz_relay_mesh::{FencedHeader, MeshDatagram, RelayPeerTransport, RuntimeId};

use super::room::AudioRoomManager;

/// The slice of the session directory that huddle audio needs.
///
/// Implemented by the session-directory lane (Perci) over the Redis fenced CAS
/// lease. Kept narrow on purpose: audio only asks "who owns this huddle, and at
/// what generation?" — it never acquires, renews, or releases leases (that is
/// the owning pod's session layer). Returning [`None`] means "no live owner"
/// (the caller may then acquire, on the owner path).
pub trait HuddleOwnerDirectory: Send + Sync + 'static {
    /// Current `{owner_runtime_id, generation}` for a huddle session, or `None`
    /// if no live lease exists. Cheap/cached; called on the join path, not per
    /// frame.
    fn owner_of(&self, session_id: Uuid) -> Option<Ownership>;
}

/// A resolved huddle ownership snapshot.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Ownership {
    /// Boot-unique mesh endpoint key of the pod currently holding the lease.
    pub owner_runtime_id: RuntimeId,
    /// Fenced generation of this ownership epoch; monotonic per session.
    pub generation: u64,
}

/// Tracks the highest generation this pod has observed per session, so stale
/// frames are rejected at every hop (fencing law). Monotonic-only: a frame is
/// accepted iff its generation is `>=` the highest seen; observing a higher
/// generation advances the floor (and signals a takeover the caller may act on).
#[derive(Default)]
pub struct GenerationFloor {
    seen: dashmap::DashMap<Uuid, u64>,
}

impl GenerationFloor {
    /// Create an empty floor (no sessions observed yet).
    pub fn new() -> Self {
        Self {
            seen: dashmap::DashMap::new(),
        }
    }

    /// Check a frame's generation against the floor for its session.
    ///
    /// - `Accept` — generation is current (`== floor`) or advances it (`>
    ///   floor`, a takeover we now pin).
    /// - `RejectStale { known }` — generation is below the floor; drop the
    ///   frame. This is the fence.
    pub fn check(&self, session_id: Uuid, generation: u64) -> FenceVerdict {
        use dashmap::mapref::entry::Entry;
        match self.seen.entry(session_id) {
            Entry::Occupied(mut e) => {
                let known = *e.get();
                if generation < known {
                    FenceVerdict::RejectStale { known }
                } else {
                    if generation > known {
                        *e.get_mut() = generation;
                    }
                    FenceVerdict::Accept {
                        advanced: generation > known,
                    }
                }
            }
            Entry::Vacant(e) => {
                e.insert(generation);
                FenceVerdict::Accept { advanced: false }
            }
        }
    }

    /// Drop all state for a session (room ended / owner teardown).
    pub fn forget(&self, session_id: Uuid) {
        self.seen.remove(&session_id);
    }
}

/// Outcome of a fence check.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FenceVerdict {
    /// Frame is live. `advanced` is true when it bumped the floor (takeover).
    Accept {
        /// True when this frame's generation exceeded the prior floor,
        /// signalling an ownership takeover the caller may act on.
        advanced: bool,
    },
    /// Frame is from a superseded generation; drop it.
    RejectStale {
        /// The highest generation observed for this session — the fence floor.
        known: u64,
    },
}

/// Handles inbound mesh media for huddles on this pod.
///
/// Registered as (part of) the relay's [`buzz_relay_mesh::InboundHandler`].
/// Datagrams are delivered to local room peers; the fence is enforced here so
/// no stale media reaches a client. The `HuddleControl` stream path (remote
/// peer registration) is driven from [`super::handler`] on join/leave and is
/// wired in a following change — this type owns the datagram half and the
/// shared fence state both halves consult.
pub struct MeshAudioRouter {
    rooms: Arc<AudioRoomManager>,
    fence: Arc<GenerationFloor>,
    local_runtime_id: RuntimeId,
}

impl MeshAudioRouter {
    /// Construct a router over this pod's rooms, tagged with the local runtime
    /// identity (used to distinguish owner vs non-owner delivery paths).
    pub fn new(rooms: Arc<AudioRoomManager>, local_runtime_id: RuntimeId) -> Self {
        Self::with_fence(rooms, local_runtime_id, Arc::new(GenerationFloor::new()))
    }

    /// Construct a router that enforces an externally owned generation floor.
    ///
    /// Used by the boot wiring (`mesh_boot::wire_mesh_consumers`) so the
    /// datagram hot path and session teardown (`GenerationFloor::forget`,
    /// reached via `MeshHandle::audio_fence`) consult exactly one floor.
    pub fn with_fence(
        rooms: Arc<AudioRoomManager>,
        local_runtime_id: RuntimeId,
        fence: Arc<GenerationFloor>,
    ) -> Self {
        Self {
            rooms,
            fence,
            local_runtime_id,
        }
    }

    /// Shared fence state, so the `HuddleControl` stream path (join/leave) and
    /// the datagram path enforce one generation floor per session.
    pub fn fence(&self) -> Arc<GenerationFloor> {
        Arc::clone(&self.fence)
    }

    /// This pod's mesh runtime identity.
    pub fn local_runtime_id(&self) -> RuntimeId {
        self.local_runtime_id
    }

    /// Deliver an inbound media datagram to the addressed local huddle.
    ///
    /// The payload is `[peer_index][client frame]` for protocol v1/v2, or
    /// `[peer_index][epoch][client frame]` for v3 — already prefixed by the
    /// sender (the owner, when fanning out to us; or a non-owner client's pod,
    /// when we are the owner). We fence, then push the payload into every
    /// *local* peer's audio sink **except** the peer whose index authored it,
    /// mirroring `broadcast_frame`'s "everyone but the sender" rule so a speaker
    /// never hears themselves.
    ///
    /// Returns the fence verdict for observability/tests. Does not itself
    /// re-fan across the mesh: if we are the owner, cross-pod fan-out happens
    /// through the remote peers' mesh sinks during `broadcast_frame`, so an
    /// owner-side inbound datagram only needs local delivery here.
    pub fn on_media_datagram(&self, dgram: &MeshDatagram) -> FenceVerdict {
        let session_id = dgram.fenced.session_id;
        let verdict = self.fence.check(session_id, dgram.fenced.generation);
        if let FenceVerdict::RejectStale { known } = verdict {
            debug!(
                %session_id,
                frame_generation = dgram.fenced.generation,
                known_generation = known,
                "dropping stale-generation media datagram (fence)"
            );
            return verdict;
        }

        let Some(room) = self.rooms.get_unambiguous_by_channel(session_id) else {
            // No local room for this session: nothing to deliver to. Not an
            // error — membership can race a datagram in flight. An ambiguous
            // same-UUID room collision is also dropped because the current
            // media envelope has no community label.
            return verdict;
        };

        let Some((&author_index, rest)) = dgram.payload.split_first() else {
            warn!(%session_id, "empty media datagram payload — dropping");
            return verdict;
        };
        // Reconstruct the exact versioned on-wire frame the local fan-out uses.
        // `rest` is the opaque client frame for v1/v2, or `[epoch][client frame]`
        // for v3; only `peer_index` (the author's routing index) is split off for
        // the skip-self check. Hand peers the already-prefixed bytes without
        // interpreting the negotiated payload shape.
        let mut prefixed = bytes::BytesMut::with_capacity(dgram.payload.len());
        prefixed.extend_from_slice(&[author_index]);
        prefixed.extend_from_slice(rest);
        let prefixed = prefixed.freeze();

        room.deliver_prefixed(author_index, prefixed);
        verdict
    }
}

/// A sink that forwards a remote peer's fanned-out frames onto the mesh.
///
/// Constructed on the owner pod for each *remote* participant: the owner's
/// `Room` sees the remote peer as an ordinary [`AudioPeer`] whose `audio_tx`
/// feeds this task, which wraps each frame as a [`MeshDatagram`] and sends it to
/// the pod that hosts that participant. Drops on a disconnected/oversize peer —
/// realtime audio never blocks fan-out on one slow remote link.
pub fn spawn_remote_peer_sink(
    transport: Arc<dyn RelayPeerTransport>,
    to: RuntimeId,
    fenced: FencedHeader,
    mut frames: mpsc::Receiver<Bytes>,
) {
    tokio::spawn(async move {
        let mut seq: u64 = 0;
        while let Some(frame) = frames.recv().await {
            let dgram = MeshDatagram {
                fenced,
                seq,
                payload: frame.to_vec(),
            };
            seq = seq.wrapping_add(1);
            if let Err(e) = transport.send_datagram(to, dgram) {
                // Disconnected peer or oversize frame: drop and keep going.
                // The MTU case is the ship-gate's job to prevent; here we just
                // never let one bad link stall the room.
                debug!(%to, "remote peer datagram send failed: {e}");
            }
        }
        debug!(%to, "remote peer sink closed");
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rt(b: u8) -> RuntimeId {
        RuntimeId([b; 32])
    }

    fn fenced(session: Uuid, generation: u64) -> FencedHeader {
        FencedHeader {
            session_id: session,
            generation,
            owner_runtime_id: rt(0xAA),
        }
    }

    #[test]
    fn fence_accepts_first_and_equal_and_higher() {
        let f = GenerationFloor::new();
        let s = Uuid::new_v4();
        assert_eq!(f.check(s, 5), FenceVerdict::Accept { advanced: false });
        assert_eq!(f.check(s, 5), FenceVerdict::Accept { advanced: false });
        assert_eq!(f.check(s, 6), FenceVerdict::Accept { advanced: true });
    }

    #[test]
    fn fence_rejects_stale_after_advance() {
        let f = GenerationFloor::new();
        let s = Uuid::new_v4();
        assert_eq!(f.check(s, 10), FenceVerdict::Accept { advanced: false });
        // A late frame from the superseded generation is rejected.
        assert_eq!(f.check(s, 9), FenceVerdict::RejectStale { known: 10 });
        // The floor is unchanged by a rejected frame.
        assert_eq!(f.check(s, 10), FenceVerdict::Accept { advanced: false });
    }

    #[test]
    fn fence_is_per_session() {
        let f = GenerationFloor::new();
        let a = Uuid::new_v4();
        let b = Uuid::new_v4();
        assert_eq!(f.check(a, 7), FenceVerdict::Accept { advanced: false });
        // A different session starts its own floor.
        assert_eq!(f.check(b, 1), FenceVerdict::Accept { advanced: false });
        assert_eq!(f.check(a, 6), FenceVerdict::RejectStale { known: 7 });
    }

    #[test]
    fn fence_forget_resets_floor() {
        let f = GenerationFloor::new();
        let s = Uuid::new_v4();
        f.check(s, 20);
        f.forget(s);
        // After forget, a lower generation is accepted as a fresh floor —
        // used on room-end/teardown so a rejoin isn't fenced by a dead session.
        assert_eq!(f.check(s, 3), FenceVerdict::Accept { advanced: false });
    }

    #[test]
    fn router_drops_stale_datagram_without_delivering() {
        let rooms = Arc::new(AudioRoomManager::new());
        let router = MeshAudioRouter::new(Arc::clone(&rooms), rt(1));
        let s = Uuid::new_v4();
        // Establish a floor at generation 5.
        assert!(matches!(
            router.on_media_datagram(&MeshDatagram {
                fenced: fenced(s, 5),
                seq: 0,
                payload: vec![0, 1, 2],
            }),
            FenceVerdict::Accept { .. }
        ));
        // A stale frame is rejected.
        assert_eq!(
            router.on_media_datagram(&MeshDatagram {
                fenced: fenced(s, 4),
                seq: 1,
                payload: vec![0, 1, 2],
            }),
            FenceVerdict::RejectStale { known: 5 }
        );
    }

    #[test]
    fn router_tolerates_missing_room_and_empty_payload() {
        let rooms = Arc::new(AudioRoomManager::new());
        let router = MeshAudioRouter::new(Arc::clone(&rooms), rt(1));
        let s = Uuid::new_v4();
        // No local room for this session: accepted by fence, no panic.
        assert!(matches!(
            router.on_media_datagram(&MeshDatagram {
                fenced: fenced(s, 1),
                seq: 0,
                payload: vec![7, 8],
            }),
            FenceVerdict::Accept { .. }
        ));
        // Empty payload after a valid fence: dropped, no panic.
        let s2 = Uuid::new_v4();
        assert!(matches!(
            router.on_media_datagram(&MeshDatagram {
                fenced: fenced(s2, 1),
                seq: 0,
                payload: vec![],
            }),
            FenceVerdict::Accept { .. }
        ));
    }

    /// A recording transport: every datagram the owner's sinks send, by
    /// destination pod.
    struct RecordingTransport(std::sync::Mutex<Vec<(RuntimeId, MeshDatagram)>>);

    impl RelayPeerTransport for RecordingTransport {
        fn send_datagram(
            &self,
            to: RuntimeId,
            dgram: MeshDatagram,
        ) -> Result<(), buzz_relay_mesh::MeshError> {
            self.0.lock().unwrap().push((to, dgram));
            Ok(())
        }
        fn open_session_stream(
            &self,
            _to: RuntimeId,
            _hello: buzz_relay_mesh::StreamHello,
        ) -> buzz_relay_mesh::BoxFuture<
            '_,
            Result<buzz_relay_mesh::MeshStream, buzz_relay_mesh::MeshError>,
        > {
            Box::pin(async { Err(buzz_relay_mesh::MeshError::Transport("unused".into())) })
        }
        fn set_inbound(&self, _handler: Box<dyn buzz_relay_mesh::InboundHandler>) {}
    }

    impl RecordingTransport {
        /// Wait for the sink tasks to ship `want` datagrams, give a straggler
        /// time to show up, then take them all.
        async fn settle(&self, want: usize) -> Vec<(RuntimeId, MeshDatagram)> {
            let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(2);
            while self.0.lock().unwrap().len() < want && tokio::time::Instant::now() < deadline {
                tokio::time::sleep(std::time::Duration::from_millis(5)).await;
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            std::mem::take(&mut *self.0.lock().unwrap())
        }
    }

    /// Two clients on one non-owner pod (and one on a second pod) each hear
    /// an owner-pod speaker's frame, and each other's, exactly once.
    ///
    /// Mutation: give each remote peer its own delivery group (or none), so
    /// the owner sends one datagram per remote participant → RED (each
    /// co-located client receives the frame twice).
    #[tokio::test]
    async fn co_located_remote_clients_each_receive_a_frame_exactly_once() {
        use super::super::room::DeliveryGroup;
        use buzz_core::CommunityId;

        let (owner_pod, ingress_pod, other_pod) = (rt(0xAA), rt(1), rt(2));
        let community = CommunityId::from_uuid(Uuid::new_v4());
        let session = Uuid::new_v4();
        let fence = fenced(session, 7);
        let transport = Arc::new(RecordingTransport(std::sync::Mutex::new(Vec::new())));

        // Owner pod: one local speaker and three remote peers, two of them
        // registered by the same ingress pod.
        let owner_rooms = Arc::new(AudioRoomManager::new());
        let owner_room = owner_rooms.get_or_create(community, session);
        let (speaker_id, ..) = owner_room.add_peer("speaker".into(), 2).unwrap();
        owner_room.mark_committed(speaker_id);
        let mut remote_index = std::collections::HashMap::new();
        for (pubkey, pod) in [
            ("alice", ingress_pod),
            ("bob", ingress_pod),
            ("carol", other_pod),
        ] {
            let group = DeliveryGroup {
                link: pod.0,
                generation: fence.generation,
            };
            let (peer_id, peer_index, _, audio_rx, ..) = owner_room
                .add_remote_peer_pending(pubkey.into(), 2, group)
                .unwrap();
            assert!(owner_room.commit_peer(peer_id).is_some());
            spawn_remote_peer_sink(
                Arc::clone(&transport) as Arc<dyn RelayPeerTransport>,
                pod,
                fence,
                audio_rx,
            );
            remote_index.insert(pubkey, peer_index);
        }

        // Ingress pod: Alice and Bob are local clients at their owner-assigned
        // indexes.
        let ingress_rooms = Arc::new(AudioRoomManager::new());
        let ingress_room = ingress_rooms.get_or_create(community, session);
        let (_, _, mut alice_rx, ..) = ingress_room
            .add_peer_at_index("alice".into(), 2, remote_index["alice"])
            .unwrap();
        let (_, _, mut bob_rx, ..) = ingress_room
            .add_peer_at_index("bob".into(), 2, remote_index["bob"])
            .unwrap();
        let ingress = MeshAudioRouter::new(Arc::clone(&ingress_rooms), ingress_pod);

        let to = |sent: &[(RuntimeId, MeshDatagram)], pod: RuntimeId| {
            sent.iter().filter(|(t, _)| *t == pod).count()
        };

        // 1. The owner-pod speaker talks: one datagram per pod.
        owner_room.broadcast_frame(speaker_id, Bytes::from_static(b"speaker-opus"));
        let sent = transport.settle(2).await;
        assert_eq!(
            to(&sent, ingress_pod),
            1,
            "one datagram to the ingress pod: {sent:?}"
        );
        assert_eq!(
            to(&sent, other_pod),
            1,
            "one datagram to the other pod: {sent:?}"
        );
        assert!(sent.iter().all(|(t, _)| *t != owner_pod));
        for (_, dgram) in sent.iter().filter(|(t, _)| *t == ingress_pod) {
            ingress.on_media_datagram(dgram);
        }
        for rx in [&mut alice_rx, &mut bob_rx] {
            assert!(rx.try_recv().unwrap().ends_with(b"speaker-opus"));
            assert!(
                rx.try_recv().is_err(),
                "a second copy reached a co-located client"
            );
        }

        // 2. Alice talks; the owner receives her frame from the mesh. Bob
        //    (same pod) and Carol (other pod) each get it once; Alice doesn't.
        let mut from_alice = vec![remote_index["alice"]];
        from_alice.extend_from_slice(b"alice-opus");
        owner_room.deliver_prefixed(remote_index["alice"], Bytes::from(from_alice));
        let sent = transport.settle(2).await;
        assert_eq!(to(&sent, ingress_pod), 1, "{sent:?}");
        assert_eq!(to(&sent, other_pod), 1, "{sent:?}");
        for (_, dgram) in sent.iter().filter(|(t, _)| *t == ingress_pod) {
            ingress.on_media_datagram(dgram);
        }
        assert!(bob_rx.try_recv().unwrap().ends_with(b"alice-opus"));
        assert!(bob_rx.try_recv().is_err(), "Bob heard Alice twice");
        assert!(alice_rx.try_recv().is_err(), "Alice heard herself");
    }
}
