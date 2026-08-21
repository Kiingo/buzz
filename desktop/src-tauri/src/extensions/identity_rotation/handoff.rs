use std::{collections::VecDeque, sync::Mutex};

use serde::Serialize;
use tauri::{Emitter, Manager, State};
use url::Url;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct IdentityRotationHandoff {
    pub id: String,
    pub contract_version: u8,
    pub rotation_id: String,
    pub challenge: Option<String>,
    pub coordinator_origin: Option<String>,
    pub resume: bool,
    pub recovery_backup_required: bool,
    pub assisted_reminder: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct IdentityRotationHandoffPublic {
    pub id: String,
    pub contract_version: u8,
    pub rotation_id: String,
    pub resume: bool,
    pub recovery_backup_required: bool,
    pub assisted_reminder: bool,
}

impl From<&IdentityRotationHandoff> for IdentityRotationHandoffPublic {
    fn from(value: &IdentityRotationHandoff) -> Self {
        Self {
            id: value.id.clone(),
            contract_version: value.contract_version,
            rotation_id: value.rotation_id.clone(),
            resume: value.resume,
            recovery_backup_required: value.recovery_backup_required,
            assisted_reminder: value.assisted_reminder,
        }
    }
}

#[derive(Default)]
pub(crate) struct IdentityRotationExtensionState {
    pending: Mutex<VecDeque<IdentityRotationHandoff>>,
    pub(crate) operation: tokio::sync::Mutex<()>,
}

impl IdentityRotationExtensionState {
    fn lock(&self) -> std::sync::MutexGuard<'_, VecDeque<IdentityRotationHandoff>> {
        self.pending
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn enqueue(&self, handoff: IdentityRotationHandoff) -> IdentityRotationHandoff {
        let mut queue = self.lock();
        if let Some(existing) = queue
            .iter()
            .find(|queued| queued.rotation_id == handoff.rotation_id)
        {
            return existing.clone();
        }
        queue.push_back(handoff.clone());
        handoff
    }

    fn first(&self) -> Option<IdentityRotationHandoff> {
        self.lock().front().cloned()
    }

    pub(crate) fn get(&self, id: &str) -> Option<IdentityRotationHandoff> {
        self.lock().iter().find(|entry| entry.id == id).cloned()
    }

    fn acknowledge(&self, id: &str) -> bool {
        let mut queue = self.lock();
        if queue.front().is_some_and(|entry| entry.id == id) {
            queue.pop_front();
            true
        } else {
            false
        }
    }
}

fn parse_handoff(url: &Url) -> Result<IdentityRotationHandoff, String> {
    let resume = url.host_str() == Some("identity-rotation-resume");
    if url.scheme() != "buzz"
        || (!resume && url.host_str() != Some("identity-rotation"))
        || !matches!(url.path(), "" | "/")
        || url.fragment().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err("identity_rotation_handoff_invalid".into());
    }
    let mut contract_version = None;
    let mut rotation_id = None;
    let mut challenge = None;
    let mut coordinator_origin = None;
    let mut recovery_backup_required = None;
    let mut assisted_reminder = None;
    for (key, value) in url.query_pairs() {
        let slot = match key.as_ref() {
            "contract_version" => &mut contract_version,
            "rotation_id" => &mut rotation_id,
            "challenge" if !resume => &mut challenge,
            "coordinator_origin" if !resume => &mut coordinator_origin,
            "recovery_backup_required" if !resume => &mut recovery_backup_required,
            "assisted_reminder" if !resume => &mut assisted_reminder,
            _ => return Err("identity_rotation_handoff_invalid".into()),
        };
        if slot.replace(value.into_owned()).is_some() {
            return Err("identity_rotation_handoff_invalid".into());
        }
    }
    if contract_version.as_deref() != Some("1") {
        return Err("identity_rotation_contract_unsupported".into());
    }
    let rotation_id = rotation_id
        .filter(|value| uuid::Uuid::parse_str(value).is_ok())
        .ok_or_else(|| "identity_rotation_handoff_invalid".to_string())?;
    let challenge = if resume {
        None
    } else {
        Some(
            challenge
                .filter(|value| {
                    (32..=256).contains(&value.len())
                        && value
                            .bytes()
                            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
                })
                .ok_or_else(|| "identity_rotation_handoff_invalid".to_string())?,
        )
    };
    let coordinator_origin = if resume {
        None
    } else {
        let origin =
            coordinator_origin.ok_or_else(|| "identity_rotation_handoff_invalid".to_string())?;
        let parsed_origin =
            Url::parse(&origin).map_err(|_| "identity_rotation_handoff_invalid".to_string())?;
        if parsed_origin.scheme() != "https"
            || parsed_origin.host_str().is_none()
            || !parsed_origin.username().is_empty()
            || parsed_origin.password().is_some()
            || parsed_origin.query().is_some()
            || parsed_origin.fragment().is_some()
        {
            return Err("identity_rotation_handoff_invalid".into());
        }
        Some(origin.trim_end_matches('/').to_string())
    };
    let recovery_backup_required = if resume {
        false
    } else {
        match recovery_backup_required.as_deref() {
            Some("1") => true,
            Some("0") => false,
            _ => return Err("identity_rotation_handoff_invalid".into()),
        }
    };
    let assisted_reminder = if resume {
        false
    } else {
        match assisted_reminder.as_deref() {
            Some("1") => true,
            Some("0") => false,
            _ => return Err("identity_rotation_handoff_invalid".into()),
        }
    };
    Ok(IdentityRotationHandoff {
        id: uuid::Uuid::new_v4().to_string(),
        contract_version: 1,
        rotation_id,
        challenge,
        coordinator_origin,
        resume,
        recovery_backup_required,
        assisted_reminder,
    })
}

pub(crate) fn try_handle_deep_link(app: &tauri::AppHandle, url: &Url) -> bool {
    if !matches!(
        url.host_str(),
        Some("identity-rotation" | "identity-rotation-resume")
    ) {
        return false;
    }
    match parse_handoff(url) {
        Ok(handoff) => {
            let handoff = app
                .state::<IdentityRotationExtensionState>()
                .enqueue(handoff);
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
            let _ = app.emit(
                "deep-link-identity-rotation",
                IdentityRotationHandoffPublic::from(&handoff),
            );
        }
        Err(code) => {
            let _ = app.emit(
                "identity-rotation-progress",
                serde_json::json!({
                    "state": "failed",
                    "message": "The identity-rotation link is invalid or unsupported.",
                    "errorCode": code
                }),
            );
        }
    }
    true
}

#[tauri::command]
pub(crate) fn take_pending_identity_rotation(
    pending: State<'_, IdentityRotationExtensionState>,
) -> Option<IdentityRotationHandoffPublic> {
    pending
        .first()
        .as_ref()
        .map(IdentityRotationHandoffPublic::from)
}

#[tauri::command]
pub(crate) fn acknowledge_pending_identity_rotation(
    id: String,
    pending: State<'_, IdentityRotationExtensionState>,
) -> bool {
    pending.acknowledge(&id)
}

#[cfg(test)]
mod tests {
    use super::parse_handoff;
    use url::Url;

    #[test]
    fn accepts_canonical_handoff_without_exposing_other_fields() {
        let url = Url::parse(&format!(
            "buzz://identity-rotation?contract_version=1&rotation_id={}&challenge={}&coordinator_origin={}&recovery_backup_required=1&assisted_reminder=0",
            "20000000-0000-4000-8000-000000000001",
            "a".repeat(43),
            "https%3A%2F%2Fapi.example.com%2Fapi%2Fbuzz-hosted"
        ))
        .unwrap();
        let parsed = parse_handoff(&url).expect("valid handoff");
        assert_eq!(parsed.contract_version, 1);
        assert_eq!(
            parsed.coordinator_origin.as_deref(),
            Some("https://api.example.com/api/buzz-hosted")
        );
    }

    #[test]
    fn accepts_secret_free_resume_handoff() {
        let parsed = parse_handoff(
            &Url::parse(
                "buzz://identity-rotation-resume?contract_version=1&rotation_id=20000000-0000-4000-8000-000000000001",
            )
            .unwrap(),
        )
        .expect("valid resume handoff");
        assert!(parsed.resume);
        assert!(parsed.challenge.is_none());
        assert!(parsed.coordinator_origin.is_none());
        assert!(!parsed.recovery_backup_required);
        assert!(!parsed.assisted_reminder);
    }

    #[test]
    fn rejects_downgrade_duplicates_and_untrusted_transport() {
        for value in [
            format!(
                "buzz://identity-rotation?contract_version=0&rotation_id={}&challenge={}&coordinator_origin=https%3A%2F%2Fapi.example.com&recovery_backup_required=1&assisted_reminder=0",
                "20000000-0000-4000-8000-000000000001",
                "a".repeat(43)
            ),
            format!(
                "buzz://identity-rotation?contract_version=1&rotation_id={}&rotation_id={}&challenge={}&coordinator_origin=https%3A%2F%2Fapi.example.com&recovery_backup_required=1&assisted_reminder=0",
                "20000000-0000-4000-8000-000000000001",
                "20000000-0000-4000-8000-000000000002",
                "a".repeat(43)
            ),
            format!(
                "buzz://identity-rotation?contract_version=1&rotation_id={}&challenge={}&coordinator_origin=http%3A%2F%2Fapi.example.com&recovery_backup_required=1&assisted_reminder=0",
                "20000000-0000-4000-8000-000000000001",
                "a".repeat(43)
            ),
        ] {
            assert!(parse_handoff(&Url::parse(&value).unwrap()).is_err());
        }
    }
}
