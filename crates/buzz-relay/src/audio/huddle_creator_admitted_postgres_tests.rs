// Included in handler::tests::postgres_tests. Creator-admitted huddle backing
// channels, driven through the real ingest pipeline (kinds 9000, 9001, 9002,
// 9007, 9008, 9022) and the real audio admission check.

/// A private parent channel and a TTL-bound backing channel created through
/// ingest, linked by the creator's kind 48100.
struct CreatorAdmittedFixture {
    state: Arc<AppState>,
    tenant: TenantContext,
    parent: Uuid,
    child: Uuid,
    /// Owner of the parent and creator of the backing channel.
    creator: nostr::Keys,
    /// Parent member, not yet put in the backing channel.
    member: nostr::Keys,
    /// Parent admin.
    parent_admin: nostr::Keys,
    /// A second parent owner.
    co_owner: nostr::Keys,
    /// Not in the parent.
    outsider: nostr::Keys,
}

impl CreatorAdmittedFixture {
    async fn new(marked: bool) -> Self {
        let state = crate::handlers::group_state_postgres_tests::state().await;
        let tenant =
            crate::handlers::group_state_postgres_tests::community(&state, "creator-admitted")
                .await;
        let creator = nostr::Keys::generate();
        let parent = crate::handlers::group_state_postgres_tests::create_channel(
            &state,
            &tenant,
            &creator,
            &[&["visibility", "private"]],
        )
        .await;
        let (member, parent_admin, co_owner, outsider) = (
            nostr::Keys::generate(),
            nostr::Keys::generate(),
            nostr::Keys::generate(),
            nostr::Keys::generate(),
        );
        for (key, role) in [
            (&member, buzz_db::channel_members::MemberRole::Member),
            (&parent_admin, buzz_db::channel_members::MemberRole::Admin),
            (&co_owner, buzz_db::channel_members::MemberRole::Owner),
        ] {
            state
                .db
                .add_member(
                    tenant.community(),
                    parent,
                    &key.public_key().to_bytes(),
                    role,
                    Some(&creator.public_key().to_bytes()),
                )
                .await
                .expect("seed parent member");
        }
        let child = Uuid::new_v4();
        let (child_text, parent_text) = (child.to_string(), parent.to_string());
        let name = format!("huddle-{}", child.simple());
        let h = ["h", child_text.as_str()];
        let name_tag = ["name", name.as_str()];
        let mark = ["admission", "creator", parent_text.as_str()];
        let mut tags: Vec<&[&str]> =
            vec![&h, &name_tag, &["visibility", "private"], &["ttl", "3600"]];
        if marked {
            tags.push(&mark);
        }
        let fixture = Self {
            state,
            tenant,
            parent,
            child,
            creator,
            member,
            parent_admin,
            co_owner,
            outsider,
        };
        fixture
            .ingest(&fixture.creator, 9007, &tags)
            .await
            .expect("create backing channel");
        seed_huddle_started_link(
            fixture.state.db.pool(),
            *fixture.tenant.community().as_uuid(),
            parent,
            child,
            &fixture.creator.public_key().to_bytes(),
        )
        .await;
        fixture
    }

    async fn ingest(
        &self,
        keys: &nostr::Keys,
        kind: u16,
        tags: &[&[&str]],
    ) -> Result<crate::handlers::ingest::IngestResult, crate::handlers::ingest::IngestError> {
        let tags = tags
            .iter()
            .map(|tag| nostr::Tag::parse(tag.iter().copied()).expect("tag"));
        let event = nostr::EventBuilder::new(nostr::Kind::Custom(kind), "")
            .tags(tags)
            .sign_with_keys(keys)
            .expect("sign");
        crate::handlers::ingest::ingest_event(
            &self.state,
            &self.tenant,
            event,
            crate::handlers::group_state_postgres_tests::http_auth(keys),
        )
        .await
    }

    /// The creator's kind 9000 for `key` on the backing channel, with opaque
    /// `call` and `epoch` tags (a fresh epoch keeps the event id fresh).
    async fn put(
        &self,
        key: &nostr::Keys,
        epoch: &str,
    ) -> Result<crate::handlers::ingest::IngestResult, crate::handlers::ingest::IngestError> {
        let (child, hex) = (self.child.to_string(), key.public_key().to_hex());
        self.ingest(
            &self.creator,
            9000,
            &[
                &["h", &child],
                &["p", &hex],
                &["call", "call-1"],
                &["epoch", epoch],
            ],
        )
        .await
    }

    async fn remove(
        &self,
        actor: &nostr::Keys,
        channel: Uuid,
        key: &nostr::Keys,
    ) -> Result<crate::handlers::ingest::IngestResult, crate::handlers::ingest::IngestError> {
        let (channel, hex) = (channel.to_string(), key.public_key().to_hex());
        self.ingest(actor, 9001, &[&["h", &channel], &["p", &hex]])
            .await
    }

    async fn admission(&self, key: &nostr::Keys) -> Result<MembershipAdmission, AdmissionRefusal> {
        check_membership_for_admission(
            &self.state,
            &self.tenant,
            self.child,
            &key.public_key().to_bytes(),
            Some(self.parent),
        )
        .await
    }

    async fn admitted(&self, key: &nostr::Keys) -> bool {
        match self.admission(key).await {
            Ok(MembershipAdmission::Existing { parent_channel_id }) => {
                assert_eq!(parent_channel_id, self.parent);
                true
            }
            Ok(other) => panic!("creator-admitted huddle offered {other:?}"),
            Err(AdmissionRefusal::Denied(_)) => false,
            Err(other) => panic!("unexpected refusal {other:?}"),
        }
    }

    /// A live audio socket for `key` on the backing channel. With `closes`,
    /// a socket task deregisters as soon as it is cancelled; otherwise the
    /// returned guard keeps it registered, like a stuck task.
    fn live_audio(
        &self,
        key: &nostr::Keys,
        closes: bool,
    ) -> (
        tokio_util::sync::CancellationToken,
        Option<crate::state::CommunityConnectionGuard>,
    ) {
        let cancel = tokio_util::sync::CancellationToken::new();
        let control = crate::state::CommunityConnectionControl::new(cancel.clone());
        control.bind_audio_channel(self.child);
        control.bind_pubkey(key.public_key().to_bytes());
        let guard = self.state.community_connections.register(
            Uuid::new_v4(),
            self.tenant.community(),
            control,
        );
        assert!(self.has_audio(key));
        if !closes {
            return (cancel, Some(guard));
        }
        let socket_cancel = cancel.clone();
        tokio::spawn(async move {
            socket_cancel.cancelled().await;
            drop(guard);
        });
        (cancel, None)
    }

    fn has_audio(&self, key: &nostr::Keys) -> bool {
        self.state.community_connections.has_huddle_audio(
            self.tenant.community(),
            self.child,
            Some(&key.public_key().to_bytes()),
        )
    }

    async fn inviter(&self, key: &nostr::Keys) -> Option<Vec<u8>> {
        self.state
            .db
            .huddle_active_member_inviter(
                self.tenant.community(),
                self.child,
                &key.public_key().to_bytes(),
            )
            .await
            .expect("inviter read")
            .flatten()
    }

    async fn mark(&self) -> Option<crate::huddle_creator_admitted::CreatorAdmitted> {
        let channel = self
            .state
            .db
            .get_channel(self.tenant.community(), self.child)
            .await
            .expect("backing channel");
        crate::huddle_creator_admitted::load(&self.state, self.tenant.community(), &channel)
            .await
            .expect("mark read")
    }
}

fn rejected(
    result: Result<crate::handlers::ingest::IngestResult, crate::handlers::ingest::IngestError>,
) -> String {
    match result {
        Err(crate::handlers::ingest::IngestError::Rejected(message)) => message,
        Ok(result) => panic!("expected a rejection, got OK {:?}", result.message),
        Err(other) => panic!("expected a rejection, got {other:?}"),
    }
}

fn accepted_message(
    result: Result<crate::handlers::ingest::IngestResult, crate::handlers::ingest::IngestError>,
) -> String {
    let result = result.unwrap_or_else(|error| panic!("expected OK, got {error:?}"));
    assert!(result.accepted, "not accepted: {}", result.message);
    result.message
}

/// The parent auto-add and open shortcut are skipped: only the creator and
/// creator puts are admitted, and the put's opaque tags reach the roster.
/// Mutation: drop the creator-admitted early return in
/// `check_membership_for_admission` → the parent member is AutoAddRequired.
#[tokio::test]
#[ignore = "requires Postgres"]
async fn creator_admitted_huddle_admits_only_the_creator_and_creator_puts() {
    let f = CreatorAdmittedFixture::new(true).await;
    assert_eq!(
        f.mark().await.map(|mark| mark.parent_channel_id),
        Some(f.parent)
    );
    assert!(f.admitted(&f.creator).await);
    assert!(!f.admitted(&f.member).await, "no parent auto-add");
    assert!(
        !f.admitted(&f.parent_admin).await,
        "parent role is not admission"
    );
    assert!(!f.admitted(&f.outsider).await);

    assert_eq!(accepted_message(f.put(&f.member, "1").await), "");
    assert!(f.admitted(&f.member).await, "creator put admits");
    assert_eq!(
        f.inviter(&f.member).await.as_deref(),
        Some(&f.creator.public_key().to_bytes()[..])
    );
    let roster = crate::handlers::group_state_postgres_tests::group_state_tags(
        &f.state, &f.tenant, f.child, 39002,
    )
    .await;
    let echo = vec![
        "put".to_owned(),
        f.member.public_key().to_hex(),
        "call-1".to_owned(),
        "1".to_owned(),
    ];
    assert!(roster.contains(&echo), "{roster:?}");
}

/// Unmarked huddles keep parent auto-add, and a mark cannot be added later or
/// smuggled in through another key's kind 9007.
#[tokio::test]
#[ignore = "requires Postgres"]
async fn unmarked_huddle_behavior_is_unchanged() {
    let f = CreatorAdmittedFixture::new(false).await;
    assert!(f.mark().await.is_none());
    assert!(matches!(
        f.admission(&f.member).await,
        Ok(MembershipAdmission::AutoAddRequired { .. })
    ));
    assert!(matches!(
        f.admission(&f.outsider).await,
        Err(AdmissionRefusal::Denied(_))
    ));

    // A kind 9007 signed by someone other than the channel's creator never
    // marks it.
    let mut foreign_id = Uuid::new_v4().as_bytes().to_vec();
    foreign_id.extend_from_slice(Uuid::new_v4().as_bytes());
    sqlx::query(
        "INSERT INTO events (community_id, id, pubkey, created_at, kind, tags, content, sig, channel_id) \
         VALUES ($1, $2, $3, NOW() - interval '1 hour', 9007, $4, '', $5, $6)",
    )
    .bind(f.tenant.community().as_uuid())
    .bind(foreign_id)
    .bind(f.member.public_key().to_bytes().to_vec())
    .bind(serde_json::json!([
        ["h", f.child.to_string()],
        ["admission", "creator", f.parent.to_string()]
    ]))
    .bind(vec![0u8; 64])
    .bind(f.child)
    .execute(f.state.db.pool())
    .await
    .expect("foreign creation row");
    assert!(f.mark().await.is_none(), "only the creator's 9007 marks");

    let (child, parent) = (f.child.to_string(), f.parent.to_string());
    let message = rejected(
        f.ingest(
            &f.creator,
            9002,
            &[&["h", &child], &["admission", "creator", &parent]],
        )
        .await,
    );
    assert!(message.contains("fixed at creation"), "{message}");

    assert_eq!(accepted_message(f.put(&f.member, "1").await), "");
    let roster = crate::handlers::group_state_postgres_tests::group_state_tags(
        &f.state, &f.tenant, f.child, 39002,
    )
    .await;
    assert!(roster.iter().all(|tag| tag[0] != "put"), "{roster:?}");
}

/// Only the creator puts or removes: the backing channel's admin, a parent
/// owner and members are refused, including a member removing themselves.
#[tokio::test]
#[ignore = "requires Postgres"]
async fn only_the_creator_puts_or_removes() {
    let f = CreatorAdmittedFixture::new(true).await;
    let child = f.child.to_string();
    accepted_message(f.put(&f.member, "1").await);
    let admin_hex = f.parent_admin.public_key().to_hex();
    accepted_message(
        f.ingest(
            &f.creator,
            9000,
            &[&["h", &child], &["p", &admin_hex], &["role", "admin"]],
        )
        .await,
    );

    let co_owner_hex = f.co_owner.public_key().to_hex();
    let message = rejected(
        f.ingest(
            &f.parent_admin,
            9000,
            &[&["h", &child], &["p", &co_owner_hex]],
        )
        .await,
    );
    assert!(message.contains("only the creator"), "admin put: {message}");
    rejected(
        f.ingest(&f.co_owner, 9000, &[&["h", &child], &["p", &co_owner_hex]])
            .await,
    );
    let message = rejected(f.remove(&f.parent_admin, f.child, &f.member).await);
    assert!(
        message.contains("only the creator"),
        "admin remove: {message}"
    );
    let message = rejected(f.remove(&f.member, f.child, &f.member).await);
    assert!(
        message.contains("only the creator"),
        "self remove: {message}"
    );

    assert!(f.admitted(&f.member).await);
    assert!(!f.admitted(&f.co_owner).await);
}

/// A creator put is accepted only for an active parent member.
#[tokio::test]
#[ignore = "requires Postgres"]
async fn creator_put_requires_active_parent_membership() {
    let f = CreatorAdmittedFixture::new(true).await;
    let message = rejected(f.put(&f.outsider, "1").await);
    assert!(message.contains("parent channel"), "{message}");
    assert!(!f.admitted(&f.outsider).await);
}

/// The mark is fixed: no kind 9002 adds, changes or clears it, whoever signs
/// it, and visibility cannot be opened. A mark at creation needs a parent the
/// creator belongs to, private visibility and a TTL; a second kind 9007 for
/// the id is a duplicate.
#[tokio::test]
#[ignore = "requires Postgres"]
async fn admission_mark_is_fixed_at_creation() {
    let f = CreatorAdmittedFixture::new(true).await;
    let (child, parent) = (f.child.to_string(), f.parent.to_string());
    let other = Uuid::new_v4().to_string();
    let admin_hex = f.parent_admin.public_key().to_hex();
    accepted_message(
        f.ingest(
            &f.creator,
            9000,
            &[&["h", &child], &["p", &admin_hex], &["role", "admin"]],
        )
        .await,
    );
    accepted_message(f.put(&f.member, "1").await);
    for (actor, pins_message) in [
        (&f.creator, true),
        (&f.parent_admin, true),
        (&f.member, false),
    ] {
        for mark in [
            ["admission", "creator", parent.as_str()],
            ["admission", "creator", other.as_str()],
            ["admission", "open", parent.as_str()],
        ] {
            let message = rejected(f.ingest(actor, 9002, &[&["h", &child], &mark]).await);
            assert!(
                !pins_message || message.contains("fixed at creation"),
                "{message}"
            );
        }
    }
    let message = rejected(
        f.ingest(&f.creator, 9002, &[&["h", &child], &["visibility", "open"]])
            .await,
    );
    assert!(message.contains("visibility is fixed"), "{message}");
    assert_eq!(
        f.mark().await.map(|mark| mark.parent_channel_id),
        Some(f.parent)
    );

    let name = format!("dup-{}", f.child.simple());
    rejected(
        f.ingest(
            &f.member,
            9007,
            &[
                &["h", &child],
                &["name", &name],
                &["visibility", "private"],
                &["ttl", "3600"],
                &["admission", "creator", &parent],
            ],
        )
        .await,
    );

    let marked_creation = |id: Uuid, visibility: &str, ttl: Option<&str>| {
        let mut tags = vec![
            vec!["h".to_owned(), id.to_string()],
            vec!["name".to_owned(), format!("marked-{}", id.simple())],
            vec!["visibility".to_owned(), visibility.to_owned()],
            vec!["admission".to_owned(), "creator".to_owned(), parent.clone()],
        ];
        if let Some(ttl) = ttl {
            tags.push(vec!["ttl".to_owned(), ttl.to_owned()]);
        }
        tags
    };
    for (signer, visibility, ttl, expected) in [
        (&f.outsider, "private", Some("3600"), "member of the parent"),
        (&f.creator, "open", Some("3600"), "must be private"),
        (&f.creator, "private", None, "needs a ttl"),
    ] {
        let id = Uuid::new_v4();
        let tags = marked_creation(id, visibility, ttl);
        let tags: Vec<Vec<&str>> = tags
            .iter()
            .map(|tag| tag.iter().map(String::as_str).collect())
            .collect();
        let tags: Vec<&[&str]> = tags.iter().map(Vec::as_slice).collect();
        let message = rejected(f.ingest(signer, 9007, &tags).await);
        assert!(message.contains(expected), "{message}");
        assert!(f
            .state
            .db
            .get_channel(f.tenant.community(), id)
            .await
            .is_err());
    }
}

/// A creator kind 9001 closes the member's live socket before the OK, which
/// then carries no warning.
#[tokio::test]
#[ignore = "requires Postgres"]
async fn removal_closes_live_audio_before_the_ok() {
    let f = CreatorAdmittedFixture::new(true).await;
    crate::huddle_creator_admitted::test_hooks::deliver_end_publishes(f.tenant.community());
    accepted_message(f.put(&f.member, "1").await);
    let (cancel, _) = f.live_audio(&f.member, true);

    let message = accepted_message(f.remove(&f.creator, f.child, &f.member).await);
    assert!(!f.has_audio(&f.member), "socket closed before the ack");
    assert!(cancel.is_cancelled());
    assert_eq!(message, "");
    assert!(!f.admitted(&f.member).await);
}

/// kind 9022 is the same teardown, and the member stays out until the
/// creator puts them again.
#[tokio::test]
#[ignore = "requires Postgres"]
async fn leave_tears_down_and_needs_a_fresh_put() {
    let f = CreatorAdmittedFixture::new(true).await;
    crate::huddle_creator_admitted::test_hooks::deliver_end_publishes(f.tenant.community());
    accepted_message(f.put(&f.member, "1").await);
    let (cancel, _) = f.live_audio(&f.member, true);

    let child = f.child.to_string();
    let message = accepted_message(f.ingest(&f.member, 9022, &[&["h", &child]]).await);
    assert!(!f.has_audio(&f.member), "socket closed before the ack");
    assert!(cancel.is_cancelled());
    assert_eq!(message, "");

    assert!(
        !f.admitted(&f.member).await,
        "a leave is not undone by rejoining"
    );
    accepted_message(f.put(&f.member, "2").await);
    assert!(f.admitted(&f.member).await, "a fresh creator put admits");
}

/// A socket that does not close in time is force-dropped, and the OK is
/// still true but carries the contract warning. An unconfirmed cross-pod
/// publish answers the same way.
#[tokio::test]
#[ignore = "requires Postgres"]
async fn unconfirmed_close_force_drops_and_warns() {
    let f = CreatorAdmittedFixture::new(true).await;
    crate::huddle_creator_admitted::test_hooks::deliver_end_publishes(f.tenant.community());
    accepted_message(f.put(&f.member, "1").await);
    let (cancel, stuck) = f.live_audio(&f.member, false);

    let started = tokio::time::Instant::now();
    let message = accepted_message(f.remove(&f.creator, f.child, &f.member).await);
    assert!(started.elapsed() >= crate::huddle_creator_admitted::LOCAL_CLOSE_DEADLINE);
    assert_eq!(
        message,
        crate::huddle_creator_admitted::AUDIO_CLOSE_UNCONFIRMED_WARNING
    );
    assert!(cancel.is_cancelled());
    assert!(
        !f.has_audio(&f.member),
        "force-dropped while the task was stuck"
    );
    drop(stuck);

    // No delivery stand-in: the test relay's Redis is unreachable, so the
    // other pods' close is unconfirmed even though this pod's socket closed.
    let g = CreatorAdmittedFixture::new(true).await;
    accepted_message(g.put(&g.member, "1").await);
    let (_cancel, _) = g.live_audio(&g.member, true);
    let message = accepted_message(g.remove(&g.creator, g.child, &g.member).await);
    assert!(!g.has_audio(&g.member));
    assert_eq!(
        message,
        crate::huddle_creator_admitted::AUDIO_CLOSE_UNCONFIRMED_WARNING
    );
}

/// Leaving the parent ends admission, and the periodic re-check cuts the
/// live socket.
#[tokio::test]
#[ignore = "requires Postgres"]
async fn parent_removal_denies_admission_and_recheck_cuts_audio() {
    let f = CreatorAdmittedFixture::new(true).await;
    accepted_message(f.put(&f.member, "1").await);
    assert!(f.admitted(&f.member).await);
    let (cancel, _guard) = f.live_audio(&f.member, false);
    let mark = f.mark().await.expect("marked");
    let member_bytes = f.member.public_key().to_bytes();
    assert_eq!(
        crate::huddle_creator_admitted::recheck(
            &f.state,
            f.tenant.community(),
            f.child,
            mark,
            &member_bytes
        )
        .await,
        0
    );

    accepted_message(f.remove(&f.creator, f.parent, &f.member).await);
    assert!(!f.admitted(&f.member).await);
    assert_eq!(
        crate::huddle_creator_admitted::recheck(
            &f.state,
            f.tenant.community(),
            f.child,
            mark,
            &member_bytes
        )
        .await,
        1
    );
    assert!(cancel.is_cancelled());
    rejected(f.put(&f.member, "2").await);
}

/// The parent's admins and owners may still delete the backing channel,
/// which ends its audio; a plain parent member may not.
#[tokio::test]
#[ignore = "requires Postgres"]
async fn parent_admin_may_delete_the_backing_channel() {
    let f = CreatorAdmittedFixture::new(true).await;
    let child = f.child.to_string();
    rejected(f.ingest(&f.member, 9008, &[&["h", &child]]).await);
    let (cancel, _) = f.live_audio(&f.creator, true);

    accepted_message(f.ingest(&f.parent_admin, 9008, &[&["h", &child]]).await);
    assert!(cancel.is_cancelled());
    assert!(!f.admitted(&f.creator).await);

    let g = CreatorAdmittedFixture::new(true).await;
    accepted_message(
        g.ingest(&g.co_owner, 9008, &[&["h", &g.child.to_string()]])
            .await,
    );
    assert!(!g.admitted(&g.creator).await);
}

/// An expired creator-admitted huddle admits nobody, even if it were open.
#[tokio::test]
#[ignore = "requires Postgres"]
async fn expired_creator_admitted_huddle_admits_nobody() {
    let f = CreatorAdmittedFixture::new(true).await;
    accepted_message(f.put(&f.member, "1").await);
    assert!(f.admitted(&f.member).await);
    sqlx::query(
        "UPDATE channels SET ttl_deadline = NOW() - interval '1 minute', visibility = 'open' \
         WHERE community_id = $1 AND id = $2",
    )
    .bind(f.tenant.community().as_uuid())
    .bind(f.child)
    .execute(f.state.db.pool())
    .await
    .expect("expire the huddle");
    for key in [&f.creator, &f.member, &f.co_owner, &f.outsider] {
        assert!(!f.admitted(key).await, "expired huddle admitted a key");
    }
}

/// `invited_by` comes from the accepted put's signer: a client tag is
/// ignored, and a row the creator did not put is not admitted.
#[tokio::test]
#[ignore = "requires Postgres"]
async fn forged_invited_by_is_ignored() {
    let f = CreatorAdmittedFixture::new(true).await;
    let (child, member_hex, outsider_hex) = (
        f.child.to_string(),
        f.member.public_key().to_hex(),
        f.outsider.public_key().to_hex(),
    );
    accepted_message(
        f.ingest(
            &f.creator,
            9000,
            &[
                &["h", &child],
                &["p", &member_hex],
                &["invited_by", &outsider_hex],
            ],
        )
        .await,
    );
    let creator_bytes = f.creator.public_key().to_bytes();
    assert_eq!(
        f.inviter(&f.member).await.as_deref(),
        Some(&creator_bytes[..])
    );
    assert!(f.admitted(&f.member).await);

    // A row whose inviter is not the creator is not a creator put.
    sqlx::query(
        "UPDATE channel_members SET invited_by = $4 \
         WHERE community_id = $1 AND channel_id = $2 AND pubkey = $3",
    )
    .bind(f.tenant.community().as_uuid())
    .bind(f.child)
    .bind(f.member.public_key().to_bytes().to_vec())
    .bind(f.outsider.public_key().to_bytes().to_vec())
    .execute(f.state.db.pool())
    .await
    .expect("foreign inviter");
    assert!(!f.admitted(&f.member).await);
    add_channel_member(f.state.db.pool(), &f.tenant, f.child, &f.co_owner).await;
    assert!(
        !f.admitted(&f.co_owner).await,
        "a row without a creator put"
    );

    // The creator's next put restamps it.
    accepted_message(f.put(&f.member, "2").await);
    assert_eq!(
        f.inviter(&f.member).await.as_deref(),
        Some(&creator_bytes[..])
    );
    assert!(f.admitted(&f.member).await);
}
