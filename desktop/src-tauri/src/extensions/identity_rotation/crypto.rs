use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
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

// Windows Credential Manager limits a generic credential blob to 2,560 bytes.
// SecretStore intentionally keeps the application's ordinary secrets in one
// JSON blob, which is already close to that limit for established users. A
// full identity rotation temporarily stages old/new owner and agent keys, so
// putting those values into the ordinary blob deterministically exceeds the
// Windows limit. Rotation secrets therefore use one dedicated,
// content-addressed SecretStore service per logical secret. Values are base64
// encoded and bounded so each backing credential stays below that limit.
const ROTATION_SECRET_MAX_BYTES: usize = 768;
const ROTATION_SECRET_ENTRY_KEY: &str = "payload";

fn rotation_secret_service(name: &str) -> String {
    format!(
        "{}.identity-rotation.{}",
        keyring_service(),
        sha256_hex(name.as_bytes())
    )
}

fn rotation_secret_store(name: &str) -> SecretStore {
    SecretStore::keyring(rotation_secret_service(name))
}

fn encode_rotation_secret(value: &str) -> Result<Zeroizing<String>, String> {
    if value.is_empty() || value.len() > ROTATION_SECRET_MAX_BYTES {
        return Err("identity_rotation_secure_store_value_too_large".into());
    }
    Ok(Zeroizing::new(BASE64_STANDARD.encode(value.as_bytes())))
}

fn decode_rotation_secret(encoded: &str) -> Result<Zeroizing<String>, String> {
    let decoded = Zeroizing::new(
        BASE64_STANDARD
            .decode(encoded)
            .map_err(|_| "identity_rotation_secure_store_corrupt".to_string())?,
    );
    String::from_utf8(decoded.to_vec())
        .map(Zeroizing::new)
        .map_err(|_| "identity_rotation_secure_store_corrupt".to_string())
}

fn load_scoped_secret(name: &str) -> Result<Option<Zeroizing<String>>, String> {
    let Some(encoded) = rotation_secret_store(name)
        .load(ROTATION_SECRET_ENTRY_KEY)
        .map_err(|_| "identity_rotation_secure_store_unavailable".to_string())?
    else {
        return Ok(None);
    };
    decode_rotation_secret(&encoded).map(Some)
}

fn delete_scoped_secret(name: &str) -> Result<(), String> {
    rotation_secret_store(name)
        .delete_all_with_legacy_cleanup()
        .map_err(|_| "identity_rotation_secure_purge_failed".to_string())
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
    let encoded = encode_rotation_secret(value)?;
    let store = rotation_secret_store(name);
    store
        .store(ROTATION_SECRET_ENTRY_KEY, encoded.as_str())
        .map_err(|_| "identity_rotation_secure_store_unavailable".to_string())?;
    if !store
        .verify_stored_raw(ROTATION_SECRET_ENTRY_KEY, encoded.as_str())
        .map_err(|_| "identity_rotation_secure_store_unavailable".to_string())?
    {
        let _ = store.delete_all_with_legacy_cleanup();
        return Err("identity_rotation_secure_store_readback_failed".into());
    }
    // Values written by desktop versions before the scoped format are only
    // removed after the new copy has passed an OS-backed readback check.
    secret_store()
        .delete(name)
        .map_err(|_| "identity_rotation_secure_store_unavailable".to_string())?;
    Ok(())
}

fn load_secret(name: &str) -> Result<Zeroizing<String>, String> {
    let scoped_error = match load_scoped_secret(name) {
        Ok(Some(value)) => return Ok(value),
        Ok(None) => None,
        Err(error) => Some(error),
    };

    // Seamlessly resume journals created by the pre-scoped desktop. Keep the
    // legacy value until the new copy has been stored and read back from the
    // OS, then remove it from the capacity-constrained application blob.
    let legacy = secret_store()
        .load(name)
        .map_err(|_| "identity_rotation_secure_store_unavailable".to_string())?;
    let Some(legacy) = legacy.map(Zeroizing::new) else {
        return Err(
            scoped_error.unwrap_or_else(|| "identity_rotation_staged_secret_missing".to_string())
        );
    };
    store_secret(name, legacy.as_str())?;
    Ok(legacy)
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

pub(crate) struct RotationProofRequest<'a> {
    pub(crate) keys: &'a Keys,
    pub(crate) rotation_id: &'a str,
    pub(crate) action: &'a str,
    pub(crate) challenge_hash: &'a str,
    pub(crate) community_id: &'a str,
    pub(crate) old_public_key: &'a str,
    pub(crate) new_public_key: &'a str,
    pub(crate) proof_kind: u16,
    pub(crate) proof_content: &'a str,
}

pub(crate) fn build_rotation_proof(
    request: RotationProofRequest<'_>,
) -> Result<serde_json::Value, String> {
    if request.proof_kind != 27_236 || request.proof_content != "buzz-identity-rotation-v1" {
        return Err("identity_rotation_contract_unsupported".into());
    }
    let tags = [
        Tag::parse(["rotation", request.rotation_id]),
        Tag::parse(["action", request.action]),
        Tag::parse(["challenge", request.challenge_hash]),
        Tag::parse(["community", request.community_id]),
        Tag::parse(["old", request.old_public_key]),
        Tag::parse(["new", request.new_public_key]),
    ]
    .into_iter()
    .collect::<Result<Vec<_>, _>>()
    .map_err(|_| "identity_rotation_proof_failed".to_string())?;
    let event = EventBuilder::new(Kind::Custom(request.proof_kind), request.proof_content)
        .tags(tags)
        .custom_created_at(Timestamp::now())
        .sign_with_keys(request.keys)
        .map_err(|_| "identity_rotation_proof_failed".to_string())?;
    serde_json::to_value(event).map_err(|_| "identity_rotation_proof_failed".to_string())
}

pub(crate) fn purge_staged_secrets(journal: &IdentityRotationJournal) -> Result<(), String> {
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
        let scoped_failed = delete_scoped_secret(&name).is_err();
        let legacy_failed = secret_store().delete(&name).is_err();
        if scoped_failed || legacy_failed {
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
        let challenge = "a".repeat(64);
        let old = "b".repeat(64);
        let new = "c".repeat(64);
        let proof = build_rotation_proof(RotationProofRequest {
            keys: &keys,
            rotation_id: "20000000-0000-4000-8000-000000000001",
            action: "prepare",
            challenge_hash: &challenge,
            community_id: "chat.example.com",
            old_public_key: &old,
            new_public_key: &new,
            proof_kind: 27_236,
            proof_content: "buzz-identity-rotation-v1",
        })
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
        let keys = Keys::generate();
        let challenge = "a".repeat(64);
        let old = "b".repeat(64);
        let new = "c".repeat(64);
        assert!(build_rotation_proof(RotationProofRequest {
            keys: &keys,
            rotation_id: "20000000-0000-4000-8000-000000000001",
            action: "prepare",
            challenge_hash: &challenge,
            community_id: "chat.example.com",
            old_public_key: &old,
            new_public_key: &new,
            proof_kind: 1,
            proof_content: "other",
        })
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

    #[test]
    fn rotation_secret_entry_fits_windows_credential_manager() {
        let encoded = encode_rotation_secret(&"a".repeat(ROTATION_SECRET_MAX_BYTES)).unwrap();
        let wrapped = serde_json::to_string(&std::collections::HashMap::from([(
            ROTATION_SECRET_ENTRY_KEY,
            encoded.as_str(),
        )]))
        .unwrap();
        let windows_password_bytes = wrapped.encode_utf16().count() * 2;
        assert!(
            windows_password_bytes <= 2_560,
            "rotation backing credential was {windows_password_bytes} bytes"
        );
    }

    #[test]
    fn every_rotation_secret_shape_fits_the_scoped_entry_contract() {
        let owner = Keys::generate();
        let agent = Keys::generate();
        let nsec = owner.secret_key().to_bech32().unwrap();
        let auth = compute_agent_auth_tag(&owner, &agent).unwrap();
        for value in ["a".repeat(43), nsec, auth] {
            assert!(encode_rotation_secret(&value).is_ok());
        }
    }

    #[test]
    fn rotation_secret_encoding_round_trips_and_detects_corruption() {
        let value = "portable secret \u{1f41d} ".repeat(20);
        let encoded = encode_rotation_secret(&value).unwrap();
        assert_eq!(
            decode_rotation_secret(encoded.as_str()).unwrap().as_str(),
            value
        );
        assert_eq!(
            decode_rotation_secret("not-base64***").unwrap_err(),
            "identity_rotation_secure_store_corrupt"
        );
    }

    #[test]
    fn rotation_secret_services_hide_logical_names() {
        let logical_name = concat!(
            "identity-rotation:20000000-0000-4000-8000-000000000001:",
            "agent-new:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        );
        let service = rotation_secret_service(logical_name);
        assert!(!service.contains(logical_name));
        assert!(!service.contains("aaaaaaaaaaaaaaaa"));
        assert!(service.starts_with(keyring_service()));
    }
}
