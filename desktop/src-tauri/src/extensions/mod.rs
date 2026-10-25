//! Optional, provider-neutral desktop extension points.
//!
//! Concrete extension implementations live here so the upstream application
//! shell needs only stable registration hooks.

pub(crate) mod agent_commands;
pub(crate) mod hosted_owner_relink;
pub(crate) mod identity_rotation;

pub(crate) use agent_commands::agent_commands_fetch;
pub(crate) use hosted_owner_relink::{
    hosted_owner_relink_attest_pending, hosted_owner_relink_available, hosted_owner_relink_list,
    hosted_owner_relink_list_unlinked, hosted_owner_relink_rebind,
};
pub(crate) use identity_rotation::{
    abort_identity_rotation, acknowledge_pending_identity_rotation,
    identity_rotation_renderer_continuity, identity_rotation_status,
    inspect_identity_rotation_handoff, run_identity_rotation, take_pending_identity_rotation,
    IdentityRotationExtensionState,
};

pub(crate) mod agent_summary;
pub(crate) use agent_summary::{agent_prewarm, agent_summary_fetch};

pub(crate) mod agent_ui;
pub(crate) mod agent_voice;
pub(crate) use agent_ui::agent_ui_request;
pub(crate) use agent_voice::agent_voice_request;

pub(crate) fn try_handle_deep_link(app: &tauri::AppHandle, url: &url::Url) -> bool {
    identity_rotation::try_handle_deep_link(app, url)
}

pub(crate) mod key_replacement;
pub(crate) mod session_controls;
pub(crate) use key_replacement::{
    confirm_key_replacement, key_replacement_confirmed, key_replacement_status,
    old_owner_key_removed, remove_old_owner_key,
};
pub(crate) use session_controls::agent_session_controls_available;
