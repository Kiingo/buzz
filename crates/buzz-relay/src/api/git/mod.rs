//! Git hosting — Smart HTTP transport, permission hooks, and policy engine.
//!
//! # Module structure
//!
//! - `transport` — Smart HTTP protocol (info/refs, upload-pack, receive-pack)
//! - `hook` — Pre-receive hook script and injection
//! - `policy` — Internal policy endpoint (HMAC-authenticated callback from hook)

use std::net::SocketAddr;
use std::sync::Arc;

use axum::{
    body::Body,
    extract::ConnectInfo,
    http::{Request, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::post,
    Router,
};
use tower_http::limit::RequestBodyLimitLayer;

use crate::state::AppState;

pub mod binding;
pub mod cas_publish;
pub mod hook;
pub mod hydrate;
pub mod manifest;
pub mod manifest_event;
pub mod pack_cache;
pub mod policy;
pub mod store;
pub mod transport;

pub use transport::git_router;

/// Middleware that rejects requests from non-loopback addresses.
///
/// Defense-in-depth: the internal policy endpoint should only be reachable
/// from localhost (the pre-receive hook runs on the same host as the relay).
async fn require_localhost(req: Request<Body>, next: Next) -> Response {
    let is_loopback = req
        .extensions()
        .get::<ConnectInfo<SocketAddr>>()
        .map(|ci| ci.0.ip().is_loopback())
        .unwrap_or(false);

    if !is_loopback {
        return (StatusCode::FORBIDDEN, "internal endpoint: localhost only").into_response();
    }

    next.run(req).await
}

/// Build the internal git policy router.
///
/// Mounted at `/internal/git/policy` — only accessible from localhost.
/// The pre-receive hook calls this to authorize pushes.
/// Body limit: 1 MB (500 refs × ~200 bytes each = ~100 KB typical; 1 MB is generous).
pub fn git_policy_router(state: Arc<AppState>) -> Router {
    Router::new()
        .route("/internal/git/policy", post(policy::hook_policy_check))
        // Keep both guards scoped to the internal route. `Router::layer`
        // also wraps the sub-router's fallback, so after this router is merged
        // it would turn unrelated, otherwise-unmatched public paths (including
        // `/invite/{code}`) into the localhost guard's 403 response before the
        // outer SPA fallback could handle them.
        .route_layer(RequestBodyLimitLayer::new(1024 * 1024)) // 1 MB
        .route_layer(middleware::from_fn(require_localhost))
        .with_state(state)
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::routing::get;
    use tower::ServiceExt;

    fn request(path: &str) -> Request<Body> {
        let mut request = Request::builder()
            .uri(path)
            .body(Body::empty())
            .expect("test request");
        request
            .extensions_mut()
            .insert(ConnectInfo(SocketAddr::from(([203, 0, 113, 10], 41234))));
        request
    }

    #[tokio::test]
    async fn localhost_guard_does_not_intercept_unmatched_public_paths() {
        let router = Router::new()
            .route("/internal/git/policy", get(|| async { StatusCode::OK }))
            .route_layer(middleware::from_fn(require_localhost));

        let public_fallback = router
            .clone()
            .oneshot(request("/invite/v2.opaque-code"))
            .await
            .expect("route response");
        assert_eq!(public_fallback.status(), StatusCode::NOT_FOUND);

        let internal_route = router
            .oneshot(request("/internal/git/policy"))
            .await
            .expect("route response");
        assert_eq!(internal_route.status(), StatusCode::FORBIDDEN);
    }
}
