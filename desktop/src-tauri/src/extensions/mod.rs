//! Optional, provider-neutral desktop extension points.
//!
//! Concrete extension implementations live here so the upstream application
//! shell needs only stable registration hooks.

pub(crate) mod identity_rotation;

pub(crate) use identity_rotation::{
    abort_identity_rotation, acknowledge_pending_identity_rotation, identity_rotation_status,
    inspect_identity_rotation_handoff, run_identity_rotation, take_pending_identity_rotation,
    IdentityRotationExtensionState,
};

pub(crate) fn try_handle_deep_link(app: &tauri::AppHandle, url: &url::Url) -> bool {
    identity_rotation::try_handle_deep_link(app, url)
}
