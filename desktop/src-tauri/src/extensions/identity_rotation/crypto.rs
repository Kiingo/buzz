use nostr::{EventBuilder, Keys, Kind, Tag, Timestamp, ToBech32};
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

use crate::{app_state::keyring_service, secret_store::SecretStore};

use super::journal::IdentityRotationJournal;

pub(crate) fn sha256_hex(value: &[u8]) -> String {
    hex::encode(Sha256::digest(value))
}

fn secret_store() -> &'static SecretStore {
    SecretStore::shared(keyring_service())
}

fn secret_name(rotation_id: &str, kind: &str, discriminator: &str) -> Result<String, String> {
    let id = uuid::Uuid::parse_str(rotation_id)
        .map_err(|_| "identity_rotation_id_invalid".to_string())?;
    if kind.is_empty()
        || kind.len() > 32
        || !kind
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte == b'-')
        || discriminator.is_empty()
        || discriminator.len() > 80
        || !discriminator
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b':'))
    {
        return Err("identity_rotation_secret_name_invalid".into());
    }
    Ok(format!("identity-rotation:{id}:{kind}:{discriminator}"))
}

fn store_secret(name: &str, value: &str) -> Result<(), String> {
    let store = secret_store();
    store
        .store(name, value)
        .map_err(|_| "identity_rotation_secure_store_unavailable".to_string())?;
    if !store
        .verify_stored_raw(name, value)
        .map_err(|_| "identity_rotation_secure_store_unavailable".to_string())?
    {
        let _ = store.delete(name);
        return Err("identity_rotation_secure_store_readback_failed".into());
    }
    Ok(())
}

fn load_secret(name: &str) -> Result<Zeroizing<String>, String> {
    secret_store()
        .load(name)
        .map_err(|_| "identity_rotation_secure_store_unavailable".to_string())?
        .map(Zeroizing::new)
        .ok_or_else(|| "identity_rotation_staged_secret_missing".to_string())
}

pub(crate) fn store_handoff_challenge(rotation_id: &str, challenge: &str) -> Result<(), String> {
    store_secret(
        &secret_name(rotation_id, "challenge", "coordinator")?,
        challenge,
    )
}

pub(crate) fn load_handoff_challenge(rotation_id: &str) -> Result<Zeroizing<String>, String> {
    load_secret(&secret_name(rotation_id, "challenge", "coordinator")?)
}

pub(crate) fn store_resume_token(rotation_id: &str, token: &str) -> Result<(), String> {
    store_secret(
        &secret_name(rotation_id, "resume-token", "coordinator")?,
        token,
    )
}

pub(crate) fn load_resume_token(rotation_id: &str) -> Result<Zeroizing<String>, String> {
    load_secret(&secret_name(rotation_id, "resume-token", "coordinator")?)
}

pub(crate) fn stage_human_keys(
    rotation_id: &str,
    old_keys: &Keys,
    new_keys: &Keys,
) -> Result<(), String> {
    stage_keys(rotation_id, "human-old", "owner", old_keys)?;
    stage_keys(rotation_id, "human-new", "owner", new_keys)
}

pub(crate) fn stage_agent_keys(
    rotation_id: &str,
    old_public_key: &str,
    old_keys: &Keys,
    new_keys: &Keys,
    old_auth_tag: &str,
    new_auth_tag: &str,
) -> Result<(), String> {
    stage_keys(rotation_id, "agent-old", old_public_key, old_keys)?;
    stage_keys(rotation_id, "agent-new", old_public_key, new_keys)?;
    store_secret(
        &secret_name(rotation_id, "agent-old-auth", old_public_key)?,
        old_auth_tag,
    )?;
    store_secret(
        &secret_name(rotation_id, "agent-new-auth", old_public_key)?,
        new_auth_tag,
    )
}

fn stage_keys(
    rotation_id: &str,
    kind: &str,
    discriminator: &str,
    keys: &Keys,
) -> Result<(), String> {
    let nsec = Zeroizing::new(
        keys.secret_key()
            .to_bech32()
            .map_err(|_| "identity_rotation_key_encode_failed".to_string())?,
    );
    store_secret(&secret_name(rotation_id, kind, discriminator)?, &nsec)
}

pub(crate) fn load_human_keys(rotation_id: &str, new: bool) -> Result<Keys, String> {
    load_keys(
        rotation_id,
        if new { "human-new" } else { "human-old" },
        "owner",
    )
}

pub(crate) fn load_agent_keys(
    rotation_id: &str,
    old_public_key: &str,
    new: bool,
) -> Result<Keys, String> {
    load_keys(
        rotation_id,
        if new { "agent-new" } else { "agent-old" },
        old_public_key,
    )
}

pub(crate) fn load_agent_auth_tag(
    rotation_id: &str,
    old_public_key: &str,
    new: bool,
) -> Result<Zeroizing<String>, String> {
    load_secret(&secret_name(
        rotation_id,
        if new {
            "agent-new-auth"
        } else {
            "agent-old-auth"
        },
        old_public_key,
    )?)
}

fn load_keys(rotation_id: &str, kind: &str, discriminator: &str) -> Result<Keys, String> {
    let nsec = load_secret(&secret_name(rotation_id, kind, discriminator)?)?;
    Keys::parse(nsec.as_str()).map_err(|_| "identity_rotation_staged_key_corrupt".to_string())
}

pub(crate) fn compute_agent_auth_tag(
    owner_keys: &Keys,
    agent_keys: &Keys,
) -> Result<String, String> {
    let compat_owner = nostr::Keys::parse(&owner_keys.secret_key().to_secret_hex())
        .map_err(|_| "identity_rotation_auth_tag_failed".to_string())?;
    let compat_agent = nostr::PublicKey::from_hex(&agent_keys.public_key().to_hex())
        .map_err(|_| "identity_rotation_auth_tag_failed".to_string())?;
    buzz_sdk_pkg::nip_oa::compute_auth_tag(&compat_owner, &compat_agent, "")
        .map_err(|_| "identity_rotation_auth_tag_failed".to_string())
}

pub(crate) fn build_rotation_proof(
    keys: &Keys,
    rotation_id: &str,
    action: &str,
    challenge_hash: &str,
    community_id: &str,
    old_public_key: &str,
    new_public_key: &str,
    proof_kind: u16,
    proof_content: &str,
) -> Result<serde_json::Value, String> {
    if proof_kind != 27_236 || proof_content != "buzz-identity-rotation-v1" {
        return Err("identity_rotation_contract_unsupported".into());
    }
    let tags = [
        Tag::parse(["rotation", rotation_id]),
        Tag::parse(["action", action]),
        Tag::parse(["challenge", challenge_hash]),
        Tag::parse(["community", community_id]),
        Tag::parse(["old", old_public_key]),
        Tag::parse(["new", new_public_key]),
    ]
    .into_iter()
    .collect::<Result<Vec<_>, _>>()
    .map_err(|_| "identity_rotation_proof_failed".to_string())?;
    let event = EventBuilder::new(Kind::Custom(proof_kind), proof_content)
        .tags(tags)
        .custom_created_at(Timestamp::now())
        .sign_with_keys(keys)
        .map_err(|_| "identity_rotation_proof_failed".to_string())?;
    serde_json::to_value(event).map_err(|_| "identity_rotation_proof_failed".to_string())
}

pub(crate) fn purge_staged_secrets(journal: &IdentityRotationJournal) -> Result<(), String> {
    let store = secret_store();
    let mut names = vec![
        secret_name(&journal.rotation_id, "challenge", "coordinator")?,
        secret_name(&journal.rotation_id, "resume-token", "coordinator")?,
        secret_name(&journal.rotation_id, "human-old", "owner")?,
        secret_name(&journal.rotation_id, "human-new", "owner")?,
    ];
    for agent in &journal.agents {
        names.push(secret_name(
            &journal.rotation_id,
            "agent-old",
            &agent.old_public_key,
        )?);
        names.push(secret_name(
            &journal.rotation_id,
            "agent-new",
            &agent.old_public_key,
        )?);
        names.push(secret_name(
            &journal.rotation_id,
            "agent-old-auth",
            &agent.old_public_key,
        )?);
        names.push(secret_name(
            &journal.rotation_id,
            "agent-new-auth",
            &agent.old_public_key,
        )?);
    }
    let mut failed = false;
    for name in names {
        if store.delete(&name).is_err() {
            failed = true;
        }
    }
    if failed {
        Err("identity_rotation_secure_purge_failed".into())
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn proofs_bind_every_rotation_dimension() {
        let keys = Keys::generate();
        let proof = build_rotation_proof(
            &keys,
            "20000000-0000-4000-8000-000000000001",
            "prepare",
            &"a".repeat(64),
            "chat.example.com",
            &"b".repeat(64),
            &"c".repeat(64),
            27_236,
            "buzz-identity-rotation-v1",
        )
        .unwrap();
        assert_eq!(proof["pubkey"], keys.public_key().to_hex());
        let tags = proof["tags"].as_array().unwrap();
        for name in ["rotation", "action", "challenge", "community", "old", "new"] {
            assert_eq!(
                tags.iter()
                    .filter(|tag| tag[0].as_str() == Some(name))
                    .count(),
                1
            );
        }
        assert!(!serde_json::to_string(&proof).unwrap().contains("nsec1"));
    }

    #[test]
    fn rejects_non_catalog_proof_parameters() {
        assert!(build_rotation_proof(
            &Keys::generate(),
            "20000000-0000-4000-8000-000000000001",
            "prepare",
            &"a".repeat(64),
            "chat.example.com",
            &"b".repeat(64),
            &"c".repeat(64),
            1,
            "other",
        )
        .is_err());
    }

    #[test]
    fn secure_store_names_are_rotation_scoped_and_path_safe() {
        let id = "20000000-0000-4000-8000-000000000001";
        assert_eq!(
            secret_name(id, "agent-new", &"a".repeat(64)).unwrap(),
            format!("identity-rotation:{id}:agent-new:{}", "a".repeat(64))
        );
        assert!(secret_name(id, "agent-new", "../owner").is_err());
        assert!(secret_name("not-a-uuid", "agent-new", "owner").is_err());
        assert!(secret_name(id, "Agent-New", "owner").is_err());
    }
}
