//! Token-based (ES256 provider JWT) APNs authentication.
//!
//! Apple's `.p8` auth keys are team-scoped: one key signs short-lived provider
//! tokens for every app on the team, so a deployment does not need a
//! per-bundle push certificate. The signed token travels in the
//! `authorization: bearer` header; the key itself never leaves this module and
//! is never logged or rendered by `Debug`.
//!
//! Apple requires refreshing a provider token at least once an hour and
//! rejects refreshing more often than once every 20 minutes
//! (`TooManyProviderTokenUpdates`). Tokens are therefore reused for
//! [`REFRESH_AFTER_SECONDS`] and an `ExpiredProviderToken` answer forces a new
//! one only once the cached token is at least [`MIN_REFRESH_INTERVAL_SECONDS`]
//! old.

use std::{collections::HashMap, path::PathBuf, sync::Mutex};

use jsonwebtoken::{Algorithm, EncodingKey, Header};
use serde::Serialize;

use crate::{apns::ApnsError, config::ConfigError};

/// Reuse a provider token for 40 minutes (Apple accepts up to 60).
pub const REFRESH_AFTER_SECONDS: i64 = 40 * 60;
/// Never mint a replacement sooner than Apple's 20-minute floor.
pub const MIN_REFRESH_INTERVAL_SECONDS: i64 = 20 * 60;

/// How the gateway authenticates to APNs, from deployment configuration.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ApnsAuthConfig {
    /// A combined certificate + private key PEM (`BUZZ_PUSH_DOGFOOD_APNS_CERT_PATH`).
    Certificate { path: PathBuf },
    /// A team `.p8` auth key with its key id and team id.
    Token {
        key_path: PathBuf,
        key_id: String,
        team_id: String,
    },
}

/// Apple key ids and team ids are exactly ten uppercase letters or digits.
fn apple_identifier(value: &str) -> bool {
    value.len() == 10
        && value
            .bytes()
            .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit())
}

/// Parse `BUZZ_PUSH_DOGFOOD_APNS_AUTH` (`certificate` by default, or `token`)
/// and the variables that mode requires.
pub fn parse_auth(e: &HashMap<String, String>) -> Result<ApnsAuthConfig, ConfigError> {
    const MODE: &str = "BUZZ_PUSH_DOGFOOD_APNS_AUTH";
    const CERT: &str = "BUZZ_PUSH_DOGFOOD_APNS_CERT_PATH";
    const KEY: &str = "BUZZ_PUSH_DOGFOOD_APNS_KEY_PATH";
    const KEY_ID: &str = "BUZZ_PUSH_DOGFOOD_APNS_KEY_ID";
    const TEAM_ID: &str = "BUZZ_PUSH_DOGFOOD_APNS_TEAM_ID";
    let required = |key: &'static str| {
        e.get(key)
            .map(String::as_str)
            .filter(|value| !value.is_empty())
            .ok_or(ConfigError::Missing(key))
    };
    match e.get(MODE).map(String::as_str) {
        None | Some("certificate") => Ok(ApnsAuthConfig::Certificate {
            path: PathBuf::from(required(CERT)?),
        }),
        Some("token") => {
            let key_id = required(KEY_ID)?;
            let team_id = required(TEAM_ID)?;
            if !apple_identifier(key_id) {
                return Err(ConfigError::Invalid(KEY_ID));
            }
            if !apple_identifier(team_id) {
                return Err(ConfigError::Invalid(TEAM_ID));
            }
            Ok(ApnsAuthConfig::Token {
                key_path: PathBuf::from(required(KEY)?),
                key_id: key_id.to_owned(),
                team_id: team_id.to_owned(),
            })
        }
        Some(_) => Err(ConfigError::Invalid(MODE)),
    }
}

#[derive(Serialize)]
struct ProviderClaims<'a> {
    iss: &'a str,
    iat: i64,
}

struct CachedToken {
    jwt: String,
    issued_at: i64,
}

/// Signs and caches APNs provider tokens from a team `.p8` key.
pub struct ProviderTokenSigner {
    key: EncodingKey,
    header: Header,
    team_id: String,
    cache: Mutex<Option<CachedToken>>,
}

impl std::fmt::Debug for ProviderTokenSigner {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // The key and tokens are credentials; only the public identifiers show.
        f.debug_struct("ProviderTokenSigner")
            .field("key_id", &self.header.kid)
            .field("team_id", &self.team_id)
            .finish_non_exhaustive()
    }
}

impl ProviderTokenSigner {
    /// Load a PKCS#8 P-256 `.p8` key and prove it can sign. Any failure is a
    /// credential error that carries no key material.
    pub fn new(key_pem: &[u8], key_id: &str, team_id: &str) -> Result<Self, ApnsError> {
        if !apple_identifier(key_id) || !apple_identifier(team_id) {
            return Err(ApnsError::Credential);
        }
        let key = EncodingKey::from_ec_pem(key_pem).map_err(|_| ApnsError::Credential)?;
        let mut header = Header::new(Algorithm::ES256);
        header.kid = Some(key_id.to_owned());
        let signer = Self {
            key,
            header,
            team_id: team_id.to_owned(),
            cache: Mutex::new(None),
        };
        signer.sign(chrono::Utc::now().timestamp())?;
        Ok(signer)
    }

    fn sign(&self, issued_at: i64) -> Result<String, ApnsError> {
        jsonwebtoken::encode(
            &self.header,
            &ProviderClaims {
                iss: &self.team_id,
                iat: issued_at,
            },
            &self.key,
        )
        .map_err(|_| ApnsError::Credential)
    }

    /// The provider token to send now, reusing the cached one while it is fresh.
    pub fn bearer(&self) -> Result<String, ApnsError> {
        self.bearer_at(chrono::Utc::now().timestamp())
    }

    pub(crate) fn bearer_at(&self, now: i64) -> Result<String, ApnsError> {
        let mut cache = self.cache.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(cached) = cache.as_ref() {
            let age = now - cached.issued_at;
            if (0..REFRESH_AFTER_SECONDS).contains(&age) {
                return Ok(cached.jwt.clone());
            }
        }
        let jwt = self.sign(now)?;
        *cache = Some(CachedToken {
            jwt: jwt.clone(),
            issued_at: now,
        });
        Ok(jwt)
    }

    /// APNs answered `ExpiredProviderToken`: drop the cached token so the next
    /// send mints a new one, unless that would break Apple's refresh floor.
    pub fn expire(&self) {
        self.expire_at(chrono::Utc::now().timestamp());
    }

    pub(crate) fn expire_at(&self, now: i64) {
        let mut cache = self.cache.lock().unwrap_or_else(|e| e.into_inner());
        if cache
            .as_ref()
            .is_some_and(|cached| now - cached.issued_at >= MIN_REFRESH_INTERVAL_SECONDS)
        {
            *cache = None;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use jsonwebtoken::{DecodingKey, Validation};
    use serde::Deserialize;

    // Test-only P-256 key pair generated for these tests; not an Apple key.
    const TEST_P8: &[u8] = include_bytes!("../tests/fixtures/apns-test-auth-key.p8");
    const TEST_P8_PUBLIC: &[u8] = include_bytes!("../tests/fixtures/apns-test-auth-key.pub.pem");

    #[derive(Deserialize)]
    struct Claims {
        iss: String,
        iat: i64,
    }

    fn signer() -> ProviderTokenSigner {
        ProviderTokenSigner::new(TEST_P8, "ABCDE12345", "TEAM123456").unwrap()
    }

    fn decode(jwt: &str) -> (Header, Claims) {
        let mut validation = Validation::new(Algorithm::ES256);
        validation.required_spec_claims.clear();
        validation.validate_exp = false;
        let data = jsonwebtoken::decode::<Claims>(
            jwt,
            &DecodingKey::from_ec_pem(TEST_P8_PUBLIC).unwrap(),
            &validation,
        )
        .unwrap();
        (data.header, data.claims)
    }

    #[test]
    fn provider_token_is_es256_with_key_id_issuer_and_issued_at() {
        let jwt = signer().bearer_at(1_800_000_000).unwrap();
        let (header, claims) = decode(&jwt);
        assert_eq!(header.alg, Algorithm::ES256);
        assert_eq!(header.kid.as_deref(), Some("ABCDE12345"));
        assert_eq!(claims.iss, "TEAM123456");
        assert_eq!(claims.iat, 1_800_000_000);
    }

    #[test]
    fn tokens_are_reused_until_the_refresh_age_then_replaced() {
        let signer = signer();
        let first = signer.bearer_at(1_000).unwrap();
        assert_eq!(
            signer.bearer_at(1_000 + REFRESH_AFTER_SECONDS - 1).unwrap(),
            first
        );
        let second = signer.bearer_at(1_000 + REFRESH_AFTER_SECONDS).unwrap();
        assert_ne!(second, first);
        assert_eq!(decode(&second).1.iat, 1_000 + REFRESH_AFTER_SECONDS);
        // A clock that moved backwards never reuses a token "from the future".
        let rewound = signer.bearer_at(10).unwrap();
        assert_eq!(decode(&rewound).1.iat, 10);
    }

    #[test]
    fn an_expired_answer_refreshes_only_after_apples_minimum_interval() {
        let signer = signer();
        let first = signer.bearer_at(1_000).unwrap();
        signer.expire_at(1_000 + MIN_REFRESH_INTERVAL_SECONDS - 1);
        assert_eq!(
            signer
                .bearer_at(1_000 + MIN_REFRESH_INTERVAL_SECONDS - 1)
                .unwrap(),
            first,
            "refreshing sooner would risk TooManyProviderTokenUpdates"
        );
        signer.expire_at(1_000 + MIN_REFRESH_INTERVAL_SECONDS);
        let refreshed = signer
            .bearer_at(1_000 + MIN_REFRESH_INTERVAL_SECONDS)
            .unwrap();
        assert_ne!(refreshed, first);
    }

    #[test]
    fn invalid_keys_and_identifiers_are_credential_errors() {
        for (pem, key_id, team_id) in [
            (b"".as_slice(), "ABCDE12345", "TEAM123456"),
            (b"not a key".as_slice(), "ABCDE12345", "TEAM123456"),
            (TEST_P8_PUBLIC, "ABCDE12345", "TEAM123456"),
            (TEST_P8, "short", "TEAM123456"),
            (TEST_P8, "ABCDE12345", "team123456"),
        ] {
            assert!(matches!(
                ProviderTokenSigner::new(pem, key_id, team_id),
                Err(ApnsError::Credential)
            ));
        }
    }

    #[test]
    fn debug_output_never_contains_key_material_or_tokens() {
        let signer = signer();
        let jwt = signer.bearer_at(1_000).unwrap();
        let debug = format!("{signer:?}");
        assert!(debug.contains("ABCDE12345") && debug.contains("TEAM123456"));
        assert!(!debug.contains(&jwt));
        assert!(!debug.contains("PRIVATE KEY"));
    }

    mod transport {
        use super::*;
        use crate::apns::{ApnsTransport, DeliveryAttempt, DeliveryOutcome, PushTransport};
        use axum::{
            extract::State,
            http::{HeaderMap, StatusCode},
            response::IntoResponse,
            routing::post,
            Json, Router,
        };
        use std::sync::{Arc, Mutex as StdMutex};

        #[derive(Clone)]
        struct Stub {
            seen: Arc<StdMutex<Vec<HeaderMap>>>,
            expired_first: Arc<StdMutex<bool>>,
        }

        async fn apns(State(stub): State<Stub>, headers: HeaderMap) -> axum::response::Response {
            stub.seen.lock().unwrap().push(headers);
            let mut expired = stub.expired_first.lock().unwrap();
            if *expired {
                *expired = false;
                return (
                    StatusCode::FORBIDDEN,
                    Json(serde_json::json!({ "reason": "ExpiredProviderToken" })),
                )
                    .into_response();
            }
            StatusCode::OK.into_response()
        }

        async fn serve(expired_first: bool) -> (String, Stub) {
            let stub = Stub {
                seen: Arc::default(),
                expired_first: Arc::new(StdMutex::new(expired_first)),
            };
            let app = Router::new()
                .route("/3/device/{endpoint}", post(apns))
                .with_state(stub.clone());
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let base = format!("http://{}", listener.local_addr().unwrap());
            tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
            (base, stub)
        }

        fn attempt() -> DeliveryAttempt {
            DeliveryAttempt {
                request_id: uuid::Uuid::nil(),
                expires_at: 1,
            }
        }

        #[tokio::test]
        async fn token_transport_sends_a_verifiable_bearer_and_the_server_owned_topic() {
            let (base, stub) = serve(false).await;
            let transport = ApnsTransport::token_with_base_url(
                TEST_P8,
                "ABCDE12345",
                "TEAM123456",
                "com.example.app".into(),
                base,
            )
            .unwrap();
            assert_eq!(
                transport.send(attempt(), &"ab".repeat(32)).await,
                DeliveryOutcome::Accepted
            );
            let seen = stub.seen.lock().unwrap();
            let auth = seen[0]
                .get(reqwest::header::AUTHORIZATION)
                .unwrap()
                .to_str()
                .unwrap()
                .to_owned();
            let jwt = auth.strip_prefix("bearer ").expect("bearer scheme");
            let (header, claims) = decode(jwt);
            assert_eq!(header.kid.as_deref(), Some("ABCDE12345"));
            assert_eq!(claims.iss, "TEAM123456");
            assert_eq!(seen[0].get("apns-topic").unwrap(), "com.example.app");
        }

        #[tokio::test]
        async fn an_expired_provider_token_is_a_retry_not_a_configuration_fault() {
            let (base, _stub) = serve(true).await;
            let transport = ApnsTransport::token_with_base_url(
                TEST_P8,
                "ABCDE12345",
                "TEAM123456",
                "com.example.app".into(),
                base,
            )
            .unwrap();
            assert!(matches!(
                transport.send(attempt(), &"ab".repeat(32)).await,
                DeliveryOutcome::Retry { .. }
            ));
            assert_eq!(
                transport.send(attempt(), &"ab".repeat(32)).await,
                DeliveryOutcome::Accepted
            );
        }
    }

    fn env(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs
            .iter()
            .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
            .collect()
    }

    #[test]
    fn auth_mode_defaults_to_certificate_and_token_mode_needs_all_three() {
        assert_eq!(
            parse_auth(&env(&[("BUZZ_PUSH_DOGFOOD_APNS_CERT_PATH", "/id.pem")])).unwrap(),
            ApnsAuthConfig::Certificate {
                path: PathBuf::from("/id.pem")
            }
        );
        let token = [
            ("BUZZ_PUSH_DOGFOOD_APNS_AUTH", "token"),
            ("BUZZ_PUSH_DOGFOOD_APNS_KEY_PATH", "/key.p8"),
            ("BUZZ_PUSH_DOGFOOD_APNS_KEY_ID", "ABCDE12345"),
            ("BUZZ_PUSH_DOGFOOD_APNS_TEAM_ID", "TEAM123456"),
        ];
        assert_eq!(
            parse_auth(&env(&token)).unwrap(),
            ApnsAuthConfig::Token {
                key_path: PathBuf::from("/key.p8"),
                key_id: "ABCDE12345".into(),
                team_id: "TEAM123456".into(),
            }
        );
        // Token mode needs no certificate path.
        for missing in [
            "BUZZ_PUSH_DOGFOOD_APNS_KEY_PATH",
            "BUZZ_PUSH_DOGFOOD_APNS_KEY_ID",
            "BUZZ_PUSH_DOGFOOD_APNS_TEAM_ID",
        ] {
            let mut partial = env(&token);
            partial.remove(missing);
            assert!(
                matches!(parse_auth(&partial), Err(ConfigError::Missing(key)) if key == missing)
            );
        }
        let mut bad_id = env(&token);
        bad_id.insert("BUZZ_PUSH_DOGFOOD_APNS_KEY_ID".into(), "abc".into());
        assert!(parse_auth(&bad_id).is_err());
        assert!(parse_auth(&env(&[("BUZZ_PUSH_DOGFOOD_APNS_AUTH", "magic")])).is_err());
    }
}
