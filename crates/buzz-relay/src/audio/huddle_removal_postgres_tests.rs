// Included in handler::tests::postgres_tests to exercise the actual admission
// and join-commit seams with the existing isolated PostgreSQL fixtures.

async fn removed_huddle_fixture() -> (
    Arc<AppState>,
    TenantContext,
    Uuid,
    Uuid,
    nostr::Keys,
    nostr::Keys,
) {
    let state = audio_test_state_real_db()
        .await
        .expect("Spot PostgreSQL fixture");
    let (tenant, parent, creator) = seed_audio_fixture(state.db.pool()).await;
    let child = seed_parent_huddle(state.db.pool(), &tenant, parent, &creator).await;
    let member = nostr::Keys::generate();
    add_channel_member(state.db.pool(), &tenant, parent, &member).await;
    add_channel_member(state.db.pool(), &tenant, child, &member).await;
    // The creator can use the normal authorized membership mutation below.
    sqlx::query("UPDATE channel_members SET role = 'owner' WHERE community_id = $1 AND channel_id = $2 AND pubkey = $3")
        .bind(tenant.community().as_uuid()).bind(child).bind(creator.public_key().to_bytes().to_vec())
        .execute(state.db.pool()).await.expect("creator owns the fixture huddle");
    (state, tenant, parent, child, creator, member)
}

#[tokio::test]
#[ignore = "requires Postgres"]
async fn huddle_removal_overrides_cached_membership_and_open_audio_admission() {
    for open in [false, true] {
        let (state, tenant, parent, child, creator, member) = removed_huddle_fixture().await;
        let member_bytes = member.public_key().to_bytes().to_vec();
        assert!(state
            .is_member_cached(tenant.community(), child, &member_bytes)
            .await
            .expect("warm cache"));
        if open {
            sqlx::query(
                "UPDATE channels SET visibility = 'open' WHERE community_id = $1 AND id = $2",
            )
            .bind(tenant.community().as_uuid())
            .bind(child)
            .execute(state.db.pool())
            .await
            .expect("open fixture");
        }
        state
            .db
            .remove_member(
                tenant.community(),
                child,
                &member_bytes,
                &creator.public_key().to_bytes(),
            )
            .await
            .expect("authorized external removal");
        assert!(
            matches!(
                check_membership_for_admission(&state, &tenant, child, &member_bytes, Some(parent))
                    .await,
                Err(AdmissionRefusal::RemovedFromHuddle)
            ),
            "cached/open admission must not restore removal"
        );
        assert!(state
            .db
            .is_member(tenant.community(), parent, &member_bytes)
            .await
            .expect("parent membership"));
    }
}

#[tokio::test]
#[ignore = "requires Postgres"]
async fn huddle_self_leave_rejoins_but_external_or_unknown_removal_requires_reinvite() {
    let (state, tenant, parent, child, creator, member) = removed_huddle_fixture().await;
    let key = member.public_key().to_bytes().to_vec();
    state
        .db
        .remove_member(tenant.community(), child, &key, &key)
        .await
        .expect("self leave");
    state.invalidate_membership(&tenant, child, &key);
    assert!(
        matches!(
            check_membership_for_admission(&state, &tenant, child, &key, Some(parent)).await,
            Ok(MembershipAdmission::AutoAddRequired { .. })
        ),
        "self leave remains rejoinable"
    );
    for actor in [Some(creator.public_key().to_bytes().to_vec()), None] {
        sqlx::query("UPDATE channel_members SET removed_by = $3 WHERE community_id = $1 AND channel_id = $2 AND pubkey = $4")
            .bind(tenant.community().as_uuid()).bind(child).bind(actor).bind(&key)
            .execute(state.db.pool()).await.expect("committed removal provenance");
        assert!(matches!(
            check_membership_for_admission(&state, &tenant, child, &key, Some(parent)).await,
            Err(AdmissionRefusal::RemovedFromHuddle)
        ));
    }
    let (other, _, _) = seed_audio_fixture(state.db.pool()).await;
    assert!(!state
        .db
        .huddle_rejoin_blocked(other.community(), child, &key)
        .await
        .expect("tenant-scoped read"));
    assert!(matches!(
        check_membership_for_admission(&state, &other, child, &key, Some(parent)).await,
        Err(AdmissionRefusal::Denied("channel not found"))
    ));
    state
        .db
        .add_member(
            tenant.community(),
            child,
            &key,
            buzz_db::channel_members::MemberRole::Member,
            Some(&creator.public_key().to_bytes()),
        )
        .await
        .expect("explicit authorized reinvite");
    state.invalidate_membership(&tenant, child, &key);
    assert!(
        matches!(
            check_membership_for_admission(&state, &tenant, child, &key, Some(parent)).await,
            Ok(MembershipAdmission::Existing { .. })
        ),
        "reinvite restores access"
    );
}

#[tokio::test]
#[ignore = "requires Postgres"]
async fn huddle_removal_after_precheck_rolls_back_both_existing_and_auto_add_joins() {
    for auto_add in [false, true] {
        let (state, tenant, parent, child, creator, member) = removed_huddle_fixture().await;
        let key = member.public_key().to_bytes().to_vec();
        if auto_add {
            state
                .db
                .remove_member(tenant.community(), child, &key, &key)
                .await
                .expect("self leave");
            state.invalidate_membership(&tenant, child, &key);
        }
        let admission = check_membership_for_admission(&state, &tenant, child, &key, Some(parent))
            .await
            .expect("initially allowed");
        assert_eq!(
            matches!(admission, MembershipAdmission::AutoAddRequired { .. }),
            auto_add
        );
        // Removal commits after the real precheck, before its stale admission
        // can acquire the same membership lock and write a participant join.
        sqlx::query("UPDATE channel_members SET removed_at = NOW(), removed_by = $3 WHERE community_id = $1 AND channel_id = $2 AND pubkey = $4")
            .bind(tenant.community().as_uuid()).bind(child).bind(creator.public_key().to_bytes().to_vec()).bind(&key)
            .execute(state.db.pool()).await.expect("removal wins the race");
        let gate = crate::nip_fi_gate::SessionAdmissionGate::new(
            chrono::Utc::now() + chrono::Duration::hours(1),
            CancellationToken::new(),
        );
        let room = Arc::new(crate::audio::room::Room::new(tenant.community(), child));
        let result = commit_participant_join(
            &state,
            &tenant,
            child,
            parent,
            &member.public_key().to_hex(),
            &key,
            Uuid::new_v4(),
            0,
            0,
            1,
            "1",
            &admission,
            &gate,
            &room,
            None,
            None,
        )
        .await;
        assert!(
            matches!(result, Err(JoinCommitError::RemovedFromHuddle)),
            "stale admission: {result:?}"
        );
        assert!(!state
            .db
            .is_member(tenant.community(), child, &key)
            .await
            .expect("removal retained"));
        assert!(state
            .db
            .huddle_rejoin_blocked(tenant.community(), child, &key)
            .await
            .expect("provenance retained"));
        assert_eq!(
            lifecycle_event_count(state.db.pool(), &tenant, parent, 48101).await,
            0,
            "refusal must not commit a participant lifecycle event"
        );
    }
}
