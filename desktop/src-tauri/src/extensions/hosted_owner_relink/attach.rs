//! Which existing provider agent a new hosted identity attaches to.
//!
//! When the owner picks one of their agents that has no Buzz identity yet,
//! the create sends that agent's id, and every later deploy of the same
//! identity sends the same id: the provider folds it into the create's
//! idempotency key and payload hash, so a replay without it (including the
//! rollback replay that learns an uncertain create's agent id) would be a
//! different request. The id names the owner's own agent and is not secret.
//! It is kept beside the agent store, keyed by the agent's public key, rather
//! than in the managed-agent record. Nothing is written for a plain create,
//! so a build that never attaches never creates the file.

use std::collections::BTreeMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::Manager;

use super::request::is_uuid;

const STORE_FILE: &str = "hosted-agent-attach.json";
const STORE_VERSION: u32 = 1;
/// The deploy payload field the hosted provider reads.
const PAYLOAD_FIELD: &str = "kiingo_agent_id";
/// Shown when the picked id is not a canonical agent id.
pub(crate) const ATTACH_ID_INVALID: &str =
    "The agent you picked can't be used; choose it again from the list.";
const STORE_UNREADABLE: &str =
    "Buzz couldn't read which agent this one attaches to; restart Buzz and try again.";
const STORE_UNWRITABLE: &str =
    "Buzz couldn't save which agent this one attaches to; check free disk space and try again.";

static STORE_LOCK: Mutex<()> = Mutex::new(());

#[derive(Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
struct AttachStore {
    version: u32,
    /// Agent public key (hex) to the attached agent's id.
    agents: BTreeMap<String, String>,
}

/// The picked agent id in canonical form: `None` for a plain create, or a
/// lowercase UUID. Anything else is refused before any side effect.
pub(crate) fn normalized_attach_agent_id(value: Option<&str>) -> Result<Option<String>, String> {
    let Some(value) = value.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    let id = value.to_ascii_lowercase();
    if is_uuid(&id) {
        Ok(Some(id))
    } else {
        Err(ATTACH_ID_INVALID.into())
    }
}

fn store_path<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|_| STORE_UNREADABLE.to_string())?;
    Ok(dir.join(STORE_FILE))
}

/// Why the store could not be read.
#[derive(Debug, PartialEq, Eq)]
enum LoadError {
    /// The file exists but is not a store this build understands.
    Corrupt,
    /// The file could not be read at all.
    Io,
}

fn empty_store() -> AttachStore {
    AttachStore {
        version: STORE_VERSION,
        agents: BTreeMap::new(),
    }
}

fn load(path: &Path) -> Result<AttachStore, LoadError> {
    match std::fs::read(path) {
        Ok(bytes) => {
            let store: AttachStore =
                serde_json::from_slice(&bytes).map_err(|_| LoadError::Corrupt)?;
            if store.version != STORE_VERSION {
                return Err(LoadError::Corrupt);
            }
            Ok(store)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(empty_store()),
        Err(_) => Err(LoadError::Io),
    }
}

/// The store for a deploy: an unreadable or corrupt file reads as empty, so
/// it never blocks deploys. An agent that had attached then deploys without
/// its attach id; only a replay of an uncertain attach create is affected,
/// since it no longer matches the original request.
fn load_for_deploy(path: &Path) -> AttachStore {
    load(path).unwrap_or_else(|error| {
        tracing::warn!(
            ?error,
            "hosted agent attach store unreadable; deploying without attach ids"
        );
        empty_store()
    })
}

/// The store for recording a new attach: a corrupt file is replaced (it
/// could not be used anyway); a file that cannot be read refuses only this
/// attach create.
fn load_for_attach(path: &Path) -> Result<AttachStore, String> {
    match load(path) {
        Ok(store) => Ok(store),
        Err(LoadError::Corrupt) => {
            tracing::warn!("hosted agent attach store corrupt; starting a new one");
            Ok(empty_store())
        }
        Err(LoadError::Io) => Err(STORE_UNREADABLE.into()),
    }
}

fn save(path: &Path, store: &AttachStore) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|_| STORE_UNWRITABLE.to_string())?;
    }
    let bytes = serde_json::to_vec_pretty(store).map_err(|_| STORE_UNWRITABLE.to_string())?;
    let mut file =
        atomic_write_file::AtomicWriteFile::open(path).map_err(|_| STORE_UNWRITABLE.to_string())?;
    file.write_all(&bytes)
        .map_err(|_| STORE_UNWRITABLE.to_string())?;
    file.commit().map_err(|_| STORE_UNWRITABLE.to_string())
}

/// Record `attach` for `pubkey`, dropping entries for agents no longer in
/// `known_pubkeys`. A plain create (`None`) writes nothing.
fn remembered(
    mut store: AttachStore,
    pubkey: &str,
    attach: &str,
    known_pubkeys: &[&str],
) -> AttachStore {
    store
        .agents
        .retain(|key, _| key == pubkey || known_pubkeys.contains(&key.as_str()));
    store.agents.insert(pubkey.to_string(), attach.to_string());
    store.version = STORE_VERSION;
    store
}

/// Put the remembered id, if any, on the deploy payload's agent object.
fn attach_into(store: &AttachStore, pubkey: &str, payload: &mut Value) {
    if let (Some(id), Some(agent)) = (store.agents.get(pubkey), payload.as_object_mut()) {
        agent.insert(PAYLOAD_FIELD.into(), Value::String(id.clone()));
    }
}

/// Remember that the new identity `pubkey` attaches to `attach`. Called by
/// create before the record is saved, so the first deploy already sends it.
pub(crate) fn remember_attach<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    pubkey: &str,
    attach: Option<&str>,
    known_pubkeys: &[&str],
) -> Result<(), String> {
    let Some(attach) = attach else {
        return Ok(());
    };
    let _guard = STORE_LOCK
        .lock()
        .map_err(|_| STORE_UNWRITABLE.to_string())?;
    let path = store_path(app)?;
    let store = remembered(load_for_attach(&path)?, pubkey, attach, known_pubkeys);
    save(&path, &store)
}

/// Add the remembered attach id for `pubkey` to a deploy payload. No file, a
/// corrupt or unreadable file, or no entry leaves the payload as it was.
pub(crate) fn apply_attach<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    pubkey: &str,
    payload: &mut Value,
) -> Result<(), String> {
    // A poisoned lock or a missing data dir must not block deploys either.
    let _guard = STORE_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let Ok(path) = store_path(app) else {
        return Ok(());
    };
    if !path.exists() {
        return Ok(());
    }
    attach_into(&load_for_deploy(&path), pubkey, payload);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const ID: &str = "0a1b2c3d-0000-4000-8000-00000000abcd";

    #[test]
    fn attach_id_is_optional_and_canonical() {
        assert_eq!(normalized_attach_agent_id(None), Ok(None));
        assert_eq!(normalized_attach_agent_id(Some("  ")), Ok(None));
        assert_eq!(
            normalized_attach_agent_id(Some(format!(" {} ", ID.to_uppercase()).as_str())),
            Ok(Some(ID.to_string()))
        );
        for bad in ["not-a-uuid", "0a1b2c3d00004000800000000000abcd", "{0a1b}"] {
            assert_eq!(
                normalized_attach_agent_id(Some(bad)),
                Err(ATTACH_ID_INVALID.to_string())
            );
        }
    }

    #[test]
    fn remembered_keeps_known_agents_and_drops_gone_ones() {
        let mut store = AttachStore {
            version: STORE_VERSION,
            agents: BTreeMap::new(),
        };
        store.agents.insert("gone".into(), ID.into());
        store.agents.insert("kept".into(), ID.into());
        let store = remembered(store, "new", ID, &["kept"]);
        assert_eq!(
            store.agents.keys().map(String::as_str).collect::<Vec<_>>(),
            ["kept", "new"]
        );
    }

    #[test]
    fn attach_into_adds_the_field_only_for_a_remembered_agent() {
        let store = remembered(AttachStore::default(), "agent", ID, &[]);
        let mut attached = serde_json::json!({"name": "Scout"});
        attach_into(&store, "agent", &mut attached);
        assert_eq!(attached[PAYLOAD_FIELD], ID);
        let mut plain = serde_json::json!({"name": "Other"});
        attach_into(&store, "other", &mut plain);
        assert_eq!(plain, serde_json::json!({"name": "Other"}));
    }

    #[test]
    fn a_corrupt_store_never_blocks_deploys() {
        let dir = std::env::temp_dir().join(format!("buzz-attach-{}", uuid::Uuid::new_v4()));
        let path = dir.join(STORE_FILE);
        assert_eq!(load(&path).unwrap().agents.len(), 0);
        let store = remembered(AttachStore::default(), "agent", ID, &[]);
        save(&path, &store).unwrap();
        assert_eq!(load(&path).unwrap(), store);
        assert_eq!(load_for_deploy(&path), store);
        let corrupt_files: [&[u8]; 2] = [br#"{"version":9,"agents":{}}"#, b"not json"];
        for corrupt in corrupt_files {
            std::fs::write(&path, corrupt).unwrap();
            assert_eq!(load(&path).unwrap_err(), LoadError::Corrupt);
            // A deploy reads it as empty; a new attach starts a new store.
            assert_eq!(load_for_deploy(&path), empty_store());
            assert_eq!(load_for_attach(&path).unwrap(), empty_store());
        }
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
