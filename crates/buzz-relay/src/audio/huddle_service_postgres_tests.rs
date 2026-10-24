// Included in handler::tests::postgres_tests. A huddle service identity
// (`BUZZ_HUDDLE_SERVICE_PUBKEYS`) driven through the real ingest pipeline,
// relay-membership check and audio admission.

/// A relay with one huddle service key, a private parent owned by `owner`
/// with `member` in it, and `outsider` in neither.
struct HuddleServiceFixture {
    state: Arc<AppState>,
    tenant: TenantContext,
    service: nostr::Keys,
    owner: nostr::Keys,
    member: nostr::Keys,
    outsider: nostr::Keys,
    parent: Uuid,
}

impl HuddleServiceFixture {
    async fn new() -> Self {
        let service = nostr::Keys::generate();
        let state = crate::state::tests::test_state_with_huddle_services(
            &crate::test_support::database_url(),
            &[service.public_key().to_bytes()],
        )
        .await;
        let tenant =
            crate::handlers::group_state_postgres_tests::community(&state, "huddle-service").await;
        let owner = nostr::Keys::generate();
        let parent = crate::handlers::group_state_postgres_tests::create_channel(
            &state,
            &tenant,
            &owner,
            &[&["visibility", "private"]],
        )
        .await;
        let member = nostr::Keys::generate();
        state
            .db
            .add_member(
                tenant.community(),
                parent,
                &member.public_key().to_bytes(),
                buzz_db::channel_members::MemberRole::Member,
                Some(&owner.public_key().to_bytes()),
            )
            .await
            .expect("seed parent member");
        Self {
            state,
            tenant,
            service,
            owner,
            member,
            outsider: nostr::Keys::generate(),
            parent,
        }
    }

    fn ttl(&self) -> String {
        self.state
            .config
            .ephemeral_ttl_override
            .unwrap_or(3600)
            .to_string()
    }

    async fn ingest(
        &self,
        keys: &nostr::Keys,
        kind: u16,
        content: &str,
        tags: &[&[&str]],
    ) -> Result<crate::handlers::ingest::IngestResult, crate::handlers::ingest::IngestError> {
        let tags = tags
            .iter()
            .map(|tag| nostr::Tag::parse(tag.iter().copied()).expect("tag"));
        let event = nostr::EventBuilder::new(nostr::Kind::Custom(kind), content)
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

    /// `creator` creates a backing channel for the parent, marked or with
    /// the given admission tag.
    async fn create_backing(
        &self,
        creator: &nostr::Keys,
        admission: Option<&[&str]>,
    ) -> (
        Uuid,
        Result<crate::handlers::ingest::IngestResult, crate::handlers::ingest::IngestError>,
    ) {
        let child = Uuid::new_v4();
        let (child_text, parent_text, ttl) =
            (child.to_string(), self.parent.to_string(), self.ttl());
        let name = format!("service-{}", child.simple());
        let h = ["h", child_text.as_str()];
        let name_tag = ["name", name.as_str()];
        let ttl_tag = ["ttl", ttl.as_str()];
        let mark = ["admission", "creator", parent_text.as_str()];
        let mut tags: Vec<&[&str]> = vec![&h, &name_tag, &["visibility", "private"], &ttl_tag];
        match admission {
            Some(tag) => tags.push(tag),
            None => tags.push(&mark),
        }
        let result = self.ingest(creator, 9007, "", &tags).await;
        (child, result)
    }

    /// A huddle notice of `kind` in the parent naming `backing`.
    async fn notice(
        &self,
        keys: &nostr::Keys,
        kind: u16,
        backing: Uuid,
    ) -> Result<crate::handlers::ingest::IngestResult, crate::handlers::ingest::IngestError> {
        let content =
            serde_json::json!({ "ephemeral_channel_id": backing.to_string() }).to_string();
        let parent = self.parent.to_string();
        self.ingest(keys, kind, &content, &[&["h", &parent]]).await
    }

    async fn put(
        &self,
        channel: Uuid,
        key: &nostr::Keys,
    ) -> Result<crate::handlers::ingest::IngestResult, crate::handlers::ingest::IngestError> {
        let (channel, hex) = (channel.to_string(), key.public_key().to_hex());
        self.ingest(&self.service, 9000, "", &[&["h", &channel], &["p", &hex]])
            .await
    }

    async fn admission(
        &self,
        channel: Uuid,
        key: &nostr::Keys,
    ) -> Result<MembershipAdmission, AdmissionRefusal> {
        check_membership_for_admission(
            &self.state,
            &self.tenant,
            channel,
            &key.public_key().to_bytes(),
            Some(self.parent),
        )
        .await
    }
}

fn service_rejected(
    result: Result<crate::handlers::ingest::IngestResult, crate::handlers::ingest::IngestError>,
) -> String {
    match result {
        Err(crate::handlers::ingest::IngestError::Rejected(message)) => message,
        Ok(result) => panic!("expected a rejection, got OK {:?}", result.message),
        Err(other) => panic!("expected a rejection, got {other:?}"),
    }
}

fn service_accepted(
    result: Result<crate::handlers::ingest::IngestResult, crate::handlers::ingest::IngestError>,
) {
    let result = result.unwrap_or_else(|error| panic!("expected OK, got {error:?}"));
    assert!(result.accepted, "not accepted: {}", result.message);
}

/// The service runs a whole creator-admitted huddle without being a member
/// of anything: it is in no roster, holds no audio and has no relay
/// membership, and it starts and ends a backing channel exactly once.
#[tokio::test]
#[ignore = "requires Postgres"]
async fn huddle_service_runs_a_creator_admitted_huddle_invisibly() {
    let f = HuddleServiceFixture::new().await;
    let service_bytes = f.service.public_key().to_bytes();
    let (child, created) = f.create_backing(&f.service, None).await;
    service_accepted(created);
    for channel in [child, f.parent] {
        assert!(!f
            .state
            .db
            .is_member(f.tenant.community(), channel, &service_bytes)
            .await
            .expect("membership read"));
    }
    let service_hex = f.service.public_key().to_hex();
    let roster = crate::handlers::group_state_postgres_tests::group_state_tags(
        &f.state, &f.tenant, child, 39002,
    )
    .await;
    assert!(
        roster
            .iter()
            .all(|tag| !(tag[0] == "p" && tag.get(1) == Some(&service_hex))),
        "{roster:?}"
    );

    service_accepted(f.notice(&f.service, 48100, child).await);
    let message = service_rejected(f.notice(&f.service, 48100, child).await);
    assert!(message.contains("rate-limited"), "{message}");

    service_accepted(f.put(child, &f.member).await);
    assert!(matches!(
        f.admission(child, &f.member).await,
        Ok(MembershipAdmission::Existing { .. })
    ));
    // The service key never holds audio, as creator or as relay member.
    assert!(matches!(
        f.admission(child, &f.service).await,
        Err(AdmissionRefusal::Denied(_))
    ));
    assert!(matches!(
        crate::api::relay_members::check_relay_membership(
            &f.state,
            f.tenant.community(),
            &service_bytes,
            None,
            None,
        )
        .await,
        Ok(crate::api::relay_members::MembershipDecision::Denied)
    ));

    let (child_text, member_hex) = (child.to_string(), f.member.public_key().to_hex());
    service_accepted(
        f.ingest(
            &f.service,
            9001,
            "",
            &[&["h", &child_text], &["p", &member_hex]],
        )
        .await,
    );
    assert!(matches!(
        f.admission(child, &f.member).await,
        Err(AdmissionRefusal::Denied(_))
    ));

    service_accepted(f.notice(&f.service, 48103, child).await);
    let message = service_rejected(f.notice(&f.service, 48103, child).await);
    assert!(message.contains("rate-limited"), "{message}");
    service_accepted(f.ingest(&f.service, 9008, "", &[&["h", &child_text]]).await);
}

/// Required deny: a service start into a parent with no such backing
/// channel, and malformed notices.
#[tokio::test]
#[ignore = "requires Postgres"]
async fn huddle_service_start_needs_its_backing_channel() {
    let f = HuddleServiceFixture::new().await;
    let message = service_rejected(f.notice(&f.service, 48100, Uuid::new_v4()).await);
    assert!(message.contains("backing channel it created"), "{message}");

    let (child, created) = f.create_backing(&f.service, None).await;
    service_accepted(created);
    let (parent, member_hex) = (f.parent.to_string(), f.member.public_key().to_hex());
    let content = serde_json::json!({ "ephemeral_channel_id": child.to_string() }).to_string();
    let message = service_rejected(
        f.ingest(
            &f.service,
            48100,
            &content,
            &[&["h", &parent], &["p", &member_hex]],
        )
        .await,
    );
    assert!(message.contains("only the h tag"), "{message}");
    let padded = serde_json::json!({
        "ephemeral_channel_id": child.to_string(),
        "title": "x",
    })
    .to_string();
    let message = service_rejected(
        f.ingest(&f.service, 48100, &padded, &[&["h", &parent]])
            .await,
    );
    assert!(message.contains("only the h tag"), "{message}");
    let message = service_rejected(f.notice(&f.service, 48103, child).await);
    assert!(
        message.contains("rate-limited"),
        "an end needs a start: {message}"
    );
}

/// Required deny: a service notice naming another creator's backing channel.
#[tokio::test]
#[ignore = "requires Postgres"]
async fn huddle_service_cannot_announce_another_creators_huddle() {
    let f = HuddleServiceFixture::new().await;
    let (foreign, created) = f.create_backing(&f.owner, None).await;
    service_accepted(created);
    for kind in [48100, 48103] {
        let message = service_rejected(f.notice(&f.service, kind, foreign).await);
        assert!(message.contains("backing channel it created"), "{message}");
    }
    let (foreign_text, member_hex) = (foreign.to_string(), f.member.public_key().to_hex());
    for kind in [9000, 9001] {
        rejected_by_service(
            f.ingest(
                &f.service,
                kind,
                "",
                &[&["h", &foreign_text], &["p", &member_hex]],
            )
            .await,
        );
    }
    rejected_by_service(
        f.ingest(&f.service, 9008, "", &[&["h", &foreign_text]])
            .await,
    );
}

fn rejected_by_service(
    result: Result<crate::handlers::ingest::IngestResult, crate::handlers::ingest::IngestError>,
) {
    let message = service_rejected(result);
    assert!(message.contains("huddle service identity"), "{message}");
}

/// Required deny: every other kind from the service key, in every channel,
/// including messages and parent membership changes.
#[tokio::test]
#[ignore = "requires Postgres"]
async fn huddle_service_publishes_nothing_else() {
    let f = HuddleServiceFixture::new().await;
    let (child, created) = f.create_backing(&f.service, None).await;
    service_accepted(created);
    let (parent, child_text) = (f.parent.to_string(), child.to_string());
    let (member_hex, outsider_hex) = (
        f.member.public_key().to_hex(),
        f.outsider.public_key().to_hex(),
    );
    for channel in [&parent, &child_text] {
        rejected_by_service(f.ingest(&f.service, 9, "hello", &[&["h", channel]]).await);
        rejected_by_service(f.ingest(&f.service, 7, "+", &[&["h", channel]]).await);
        rejected_by_service(
            f.ingest(
                &f.service,
                9002,
                "",
                &[&["h", channel], &["name", "renamed"]],
            )
            .await,
        );
        rejected_by_service(f.ingest(&f.service, 9021, "", &[&["h", channel]]).await);
        rejected_by_service(f.ingest(&f.service, 9022, "", &[&["h", channel]]).await);
    }
    rejected_by_service(
        f.ingest(
            &f.service,
            9000,
            "",
            &[&["h", &parent], &["p", &outsider_hex]],
        )
        .await,
    );
    rejected_by_service(
        f.ingest(
            &f.service,
            9001,
            "",
            &[&["h", &parent], &["p", &member_hex]],
        )
        .await,
    );
    rejected_by_service(
        f.ingest(
            &f.service,
            9000,
            "",
            &[&["h", &child_text], &["p", &member_hex], &["role", "admin"]],
        )
        .await,
    );
    rejected_by_service(f.ingest(&f.service, 0, "{}", &[]).await);
    assert!(f
        .state
        .db
        .is_member(
            f.tenant.community(),
            f.parent,
            &f.member.public_key().to_bytes()
        )
        .await
        .expect("parent membership unchanged"));
}

/// Required deny: a service put for someone who is not a parent member.
#[tokio::test]
#[ignore = "requires Postgres"]
async fn huddle_service_puts_only_parent_members() {
    let f = HuddleServiceFixture::new().await;
    let (child, created) = f.create_backing(&f.service, None).await;
    service_accepted(created);
    let message = service_rejected(f.put(child, &f.outsider).await);
    assert!(message.contains("parent channel"), "{message}");
    assert!(matches!(
        f.admission(child, &f.outsider).await,
        Err(AdmissionRefusal::Denied(_))
    ));
}

/// Required deny: a service kind 9007 without the mark, or with any other
/// mark shape, creates nothing.
#[tokio::test]
#[ignore = "requires Postgres"]
async fn huddle_service_creates_only_marked_channels() {
    let f = HuddleServiceFixture::new().await;
    let parent = f.parent.to_string();
    let extra: [&str; 4] = ["admission", "creator", &parent, "extra"];
    let short: [&str; 2] = ["admission", "creator"];
    for admission in [None, Some(&extra[..]), Some(&short[..])] {
        let child = Uuid::new_v4();
        let (child_text, ttl) = (child.to_string(), f.ttl());
        let name = format!("unmarked-{}", child.simple());
        let h = ["h", child_text.as_str()];
        let name_tag = ["name", name.as_str()];
        let ttl_tag = ["ttl", ttl.as_str()];
        let mut tags: Vec<&[&str]> = vec![&h, &name_tag, &["visibility", "private"], &ttl_tag];
        if let Some(tag) = admission {
            tags.push(tag);
        }
        service_rejected(f.ingest(&f.service, 9007, "", &tags).await);
        assert!(f
            .state
            .db
            .get_channel(f.tenant.community(), child)
            .await
            .is_err());
    }
}
