fn resolve_nip42_auth_relay_url(
    requested_relay_url: &str,
    configured_relay_url: &str,
    canonical_relay_url: Option<&str>,
) -> String {
    let requested = requested_relay_url.trim().trim_end_matches('/');
    let configured = configured_relay_url.trim().trim_end_matches('/');

    if requested == configured {
        if let Some(canonical) = canonical_relay_url
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            return canonical.trim_end_matches('/').to_string();
        }
    }

    requested.to_string()
}

/// Returns the NIP-42 relay tag for a socket connected to `requested_relay_url`.
///
/// A Kiingo preview build can dial its restricted Front Door alias while the
/// relay remains bound to the canonical production tenant URL. The canonical
/// override applies only when the requested URL exactly matches this build's
/// configured relay; user-selected communities continue signing their own URL.
pub fn nip42_auth_relay_url(requested_relay_url: &str) -> String {
    let configured = crate::relay::relay_ws_url();
    let canonical = std::env::var("BUZZ_CANONICAL_RELAY_URL")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .or_else(|| option_env!("BUZZ_DESKTOP_BUILD_CANONICAL_RELAY_URL").map(str::to_string));

    resolve_nip42_auth_relay_url(requested_relay_url, &configured, canonical.as_deref())
}

#[cfg(test)]
mod tests {
    use super::resolve_nip42_auth_relay_url;

    #[test]
    fn configured_preview_uses_canonical_nip42_relay_tag() {
        assert_eq!(
            resolve_nip42_auth_relay_url(
                "wss://buzz-preview.kiingo.com",
                "wss://buzz-preview.kiingo.com",
                Some("wss://chat.kiingo.com"),
            ),
            "wss://chat.kiingo.com"
        );
    }

    #[test]
    fn user_selected_relay_cannot_inherit_canonical_override() {
        assert_eq!(
            resolve_nip42_auth_relay_url(
                "wss://another-community.example",
                "wss://buzz-preview.kiingo.com",
                Some("wss://chat.kiingo.com"),
            ),
            "wss://another-community.example"
        );
    }

    #[test]
    fn canonical_override_normalizes_only_trailing_slashes() {
        assert_eq!(
            resolve_nip42_auth_relay_url(
                "wss://buzz-preview.kiingo.com/",
                "wss://buzz-preview.kiingo.com",
                Some(" wss://chat.kiingo.com/ "),
            ),
            "wss://chat.kiingo.com"
        );
    }
}
