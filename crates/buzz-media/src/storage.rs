//! Backend-neutral media object storage for S3/MinIO and Azure Blob.

use std::path::Path;
use std::pin::Pin;
use std::sync::Arc;

use buzz_azure_storage::AzureBlobStore;
use buzz_core::tenant::{CommunityId, TenantContext};

use crate::config::MediaConfig;
use crate::error::MediaError;
use bytes::Bytes;
use s3::creds::Credentials;
use s3::{Bucket, Region};
use serde::{Deserialize, Serialize};

/// A stream of object bytes usable with `axum::body::Body::from_stream()`.
pub type ByteStream = Pin<Box<dyn futures_core::Stream<Item = Result<Bytes, MediaError>> + Send>>;

#[derive(Clone)]
enum MediaBackend {
    S3(Arc<Bucket>),
    Azure(AzureBlobStore),
}

/// Object storage client selected explicitly from the runtime configuration.
#[derive(Clone)]
pub struct MediaStorage {
    backend: MediaBackend,
}

impl MediaStorage {
    /// Create a new storage client from config.
    ///
    /// Credential selection:
    /// - If both `s3_access_key` and `s3_secret_key` are non-empty, use them as
    ///   static credentials (MinIO/local/dev, or any static-key deployment).
    /// - Otherwise, fall back to the AWS default credential chain via
    ///   [`Credentials::default`]: environment, shared profile, web-identity
    ///   token (IRSA on EKS — `AssumeRoleWithWebIdentity`), container, and
    ///   instance-metadata providers, in that order. This lets the relay use
    ///   the pod's IAM role without long-lived static keys.
    pub fn new(config: &MediaConfig) -> Result<Self, MediaError> {
        let region = Region::Custom {
            region: config.s3_region.clone(),
            endpoint: config.s3_endpoint.clone(),
        };
        let creds = match (
            config.s3_access_key.is_empty(),
            config.s3_secret_key.is_empty(),
        ) {
            (false, false) => Credentials::new(
                Some(&config.s3_access_key),
                Some(&config.s3_secret_key),
                None,
                None,
                None,
            ),
            (true, true) => {
                // No static keys configured: resolve from the AWS credential chain
                // (IRSA web-identity, env, profile, instance metadata).
                Credentials::default()
            }
            _ => {
                return Err(MediaError::StorageError(
                    "s3_access_key and s3_secret_key must be configured together, or both empty to use the AWS credential chain"
                        .to_string(),
                ));
            }
        }
        .map_err(|e| MediaError::StorageError(e.to_string()))?;
        let bucket = Bucket::new(&config.s3_bucket, region, creds)
            .map_err(|e| MediaError::StorageError(e.to_string()))?
            .with_path_style();
        Ok(Self {
            backend: MediaBackend::S3(Arc::from(bucket)),
        })
    }

    /// Create the configured production backend.
    ///
    /// `BUZZ_OBJECT_STORAGE_BACKEND` defaults to `s3`. Azure requires
    /// `BUZZ_AZURE_STORAGE_ACCOUNT` and `BUZZ_AZURE_MEDIA_CONTAINER`; the
    /// Azure SDK then authenticates through workload identity.
    pub fn from_runtime_env(config: &MediaConfig) -> Result<Self, MediaError> {
        match std::env::var("BUZZ_OBJECT_STORAGE_BACKEND")
            .unwrap_or_else(|_| "s3".to_string())
            .to_ascii_lowercase()
            .as_str()
        {
            "s3" => Self::new(config),
            "azure" => {
                let account = required_env("BUZZ_AZURE_STORAGE_ACCOUNT")?;
                let container = required_env("BUZZ_AZURE_MEDIA_CONTAINER")?;
                Self::new_azure(&account, &container)
            }
            backend => Err(MediaError::StorageError(format!(
                "unsupported BUZZ_OBJECT_STORAGE_BACKEND '{backend}'; expected s3 or azure"
            ))),
        }
    }

    /// Create an Azure media backend using the Azure credential environment.
    pub fn new_azure(account: &str, container: &str) -> Result<Self, MediaError> {
        Ok(Self {
            backend: MediaBackend::Azure(AzureBlobStore::from_env(account, container)?),
        })
    }

    /// Store an object from a byte slice.
    ///
    /// Used for images, sidecars, and thumbnails. For large video files use
    /// [`put_file`] to avoid loading the entire blob into RAM.
    pub async fn put(&self, key: &str, bytes: &[u8], content_type: &str) -> Result<(), MediaError> {
        match &self.backend {
            MediaBackend::S3(bucket) => {
                bucket
                    .put_object_with_content_type(key, bytes, content_type)
                    .await?;
            }
            MediaBackend::Azure(store) => {
                store
                    .put(key, Bytes::copy_from_slice(bytes), content_type)
                    .await?;
            }
        }
        Ok(())
    }

    /// Stream a file from disk into S3 without loading it into RAM.
    ///
    /// Uses rust-s3's `put_object_stream_with_content_type` which reads from
    /// the file incrementally via an 8 MiB `BufReader`. The full file is never
    /// held in memory simultaneously. Intended for video blobs (up to 500 MB).
    pub async fn put_file(
        &self,
        key: &str,
        path: &Path,
        content_type: &str,
    ) -> Result<(), MediaError> {
        const BUF: usize = 8 * 1024 * 1024; // 8 MiB read buffer

        match &self.backend {
            MediaBackend::S3(bucket) => {
                let file = tokio::fs::File::open(path)
                    .await
                    .map_err(|e| MediaError::Io(e.to_string()))?;
                let mut reader = tokio::io::BufReader::with_capacity(BUF, file);
                bucket
                    .put_object_stream_with_content_type(&mut reader, key, content_type)
                    .await?;
            }
            MediaBackend::Azure(store) => {
                store.put_file(key, path, content_type).await?;
            }
        }
        Ok(())
    }

    /// Retrieve an object's bytes.
    pub async fn get(&self, key: &str) -> Result<Vec<u8>, MediaError> {
        match &self.backend {
            MediaBackend::S3(bucket) => match bucket.get_object(key).await {
                Ok(response) => Ok(response.to_vec()),
                Err(s3::error::S3Error::HttpFailWithBody(404, _)) => Err(MediaError::NotFound),
                Err(e) => Err(MediaError::StorageError(e.to_string())),
            },
            MediaBackend::Azure(store) => Ok(store.get(key).await?.bytes.to_vec()),
        }
    }

    /// Retrieve a byte range from an object via S3-native `Range` GET.
    ///
    /// `start` and `end` are inclusive byte offsets. Only the requested slice
    /// is transferred from S3 — the full object is never loaded into RAM.
    /// Intended for HTTP 206 range responses on large video blobs.
    pub async fn get_range(&self, key: &str, start: u64, end: u64) -> Result<Vec<u8>, MediaError> {
        match &self.backend {
            MediaBackend::S3(bucket) => {
                match bucket.get_object_range(key, start, Some(end)).await {
                    Ok(response) => Ok(response.to_vec()),
                    Err(s3::error::S3Error::HttpFailWithBody(404, _)) => Err(MediaError::NotFound),
                    Err(e) => Err(MediaError::StorageError(e.to_string())),
                }
            }
            MediaBackend::Azure(store) => {
                let end_exclusive = end.checked_add(1).ok_or_else(|| {
                    MediaError::StorageError("invalid inclusive range end".to_string())
                })?;
                Ok(store.get_range(key, start..end_exclusive).await?.to_vec())
            }
        }
    }

    /// Stream an object's bytes from S3 without loading into RAM.
    ///
    /// Returns a pinned stream of `Result<Bytes, MediaError>` chunks.
    /// The full object is never buffered — intended for streaming large
    /// blobs (video) directly into HTTP responses via `Body::from_stream()`.
    pub async fn get_stream(&self, key: &str) -> Result<ByteStream, MediaError> {
        match &self.backend {
            MediaBackend::S3(bucket) => {
                let response = bucket
                    .get_object_stream(key)
                    .await
                    .map_err(|e| MediaError::StorageError(e.to_string()))?;
                if response.status_code == 404 {
                    return Err(MediaError::NotFound);
                }
                let stream = futures_util::StreamExt::map(response.bytes, |chunk| {
                    chunk.map_err(|e| MediaError::StorageError(e.to_string()))
                });
                Ok(Box::pin(stream))
            }
            MediaBackend::Azure(store) => {
                let stream = store.get_stream(key).await?;
                Ok(Box::pin(futures_util::StreamExt::map(stream, |chunk| {
                    chunk.map_err(MediaError::from)
                })))
            }
        }
    }

    /// Check if an object exists. Returns false on 404.
    pub async fn head(&self, key: &str) -> Result<bool, MediaError> {
        match &self.backend {
            MediaBackend::S3(bucket) => match bucket.head_object(key).await {
                Ok(_) => Ok(true),
                Err(s3::error::S3Error::HttpFailWithBody(404, _)) => Ok(false),
                Err(e) => Err(MediaError::StorageError(e.to_string())),
            },
            MediaBackend::Azure(store) => Ok(store.head(key).await?.is_some()),
        }
    }

    /// Delete an object. Returns an error on failure — callers decide whether to propagate.
    pub async fn delete(&self, key: &str) -> Result<(), MediaError> {
        match &self.backend {
            MediaBackend::S3(bucket) => {
                bucket
                    .delete_object(key)
                    .await
                    .map_err(|e| MediaError::StorageError(e.to_string()))?;
            }
            MediaBackend::Azure(store) => store.delete_if_exists(key).await?,
        }
        Ok(())
    }

    /// HEAD with metadata — returns Content-Length (size).
    pub async fn head_with_metadata(&self, key: &str) -> Result<Option<BlobHeadMeta>, MediaError> {
        match &self.backend {
            MediaBackend::S3(bucket) => match bucket.head_object(key).await {
                Ok((result, _)) => Ok(Some(BlobHeadMeta {
                    size: result.content_length.unwrap_or(0) as u64,
                })),
                Err(s3::error::S3Error::HttpFailWithBody(404, _)) => Ok(None),
                Err(e) => Err(MediaError::StorageError(e.to_string())),
            },
            MediaBackend::Azure(store) => Ok(store.head(key).await?.map(|metadata| BlobHeadMeta {
                size: metadata.size,
            })),
        }
    }

    /// Build the community-scoped sidecar key for a given sha256 (bare hash).
    ///
    /// Raw media bytes remain shared content-addressed CAS (`{sha}.{ext}`), but
    /// the metadata sidecar is the tenant read gate. A blob in another
    /// community must never be observable through a global `_meta/{sha}.json`
    /// lookup.
    pub fn sidecar_key(community: CommunityId, sha256: &str) -> String {
        format!("_meta/{community}/{sha256}.json")
    }

    /// Build the community-scoped sidecar key from the resolved request tenant.
    pub fn ctx_sidecar_key(ctx: &TenantContext, sha256: &str) -> String {
        Self::sidecar_key(ctx.community(), sha256)
    }

    /// Read community-scoped sidecar JSON for a given sha256 (bare hash).
    pub async fn get_sidecar(
        &self,
        ctx: &TenantContext,
        sha256: &str,
    ) -> Result<BlobMeta, MediaError> {
        let key = Self::ctx_sidecar_key(ctx, sha256);
        let bytes = self.get(&key).await?;
        let meta: BlobMeta = serde_json::from_slice(&bytes)?;
        Ok(meta)
    }

    /// Write community-scoped sidecar JSON for a given sha256 (bare hash).
    ///
    /// `ctx` must be the server-resolved request tenant. Callers must never
    /// derive the community from client-supplied blob metadata, URLs, or event
    /// tags; this sidecar key is the tenant read gate for otherwise shared CAS
    /// bytes.
    pub async fn put_sidecar(
        &self,
        ctx: &TenantContext,
        sha256: &str,
        meta: &BlobMeta,
    ) -> Result<(), MediaError> {
        let key = Self::ctx_sidecar_key(ctx, sha256);
        let meta_json = serde_json::to_vec(meta)?;
        self.put(&key, &meta_json, "application/json").await
    }

    /// Convenience: read just the MIME type from the community sidecar.
    ///
    /// Returns `None` for both absent sidecars and storage read failures. Public
    /// read handlers intentionally collapse that distinction to 404 so an
    /// A-bound request cannot distinguish a B-only blob from a missing blob.
    pub async fn read_sidecar_mime(&self, ctx: &TenantContext, sha256_ext: &str) -> Option<String> {
        let sha256 = sha256_ext.split('.').next().unwrap_or(sha256_ext);
        self.get_sidecar(ctx, sha256)
            .await
            .ok()
            .map(|m| m.mime_type)
    }

    /// One page of a full-bucket listing, for the storage sweep. Wraps
    /// rust-s3's manual `list_page` (NOT the auto-paginating `list`, which
    /// has no cap) and converts the result into the storage-agnostic
    /// [`crate::bucket_index::Page`] shape the pure fold consumes.
    ///
    /// `max_keys` bounds one HTTP response, not the sweep's total object
    /// cap — the caller (`fold_bucket_listing`) enforces the cumulative cap
    /// across pages.
    pub async fn list_page(
        &self,
        continuation_token: Option<String>,
        max_keys: usize,
    ) -> Result<crate::bucket_index::Page, MediaError> {
        match &self.backend {
            MediaBackend::S3(bucket) => {
                let (result, _status) = bucket
                    .list_page(
                        String::new(),
                        None,
                        continuation_token,
                        None,
                        Some(max_keys),
                    )
                    .await?;
                Ok(crate::bucket_index::Page {
                    objects: result
                        .contents
                        .into_iter()
                        .map(|obj| (obj.key, obj.size))
                        .collect(),
                    next_continuation_token: result.next_continuation_token,
                    is_truncated: result.is_truncated,
                })
            }
            MediaBackend::Azure(store) => {
                let page = store.list_page(None, continuation_token, max_keys).await?;
                let is_truncated = page.continuation_token.is_some();
                Ok(crate::bucket_index::Page {
                    objects: page
                        .objects
                        .into_iter()
                        .map(|object| (object.key, object.size))
                        .collect(),
                    next_continuation_token: page.continuation_token,
                    is_truncated,
                })
            }
        }
    }
}

fn required_env(name: &str) -> Result<String, MediaError> {
    std::env::var(name)
        .ok()
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| {
            MediaError::StorageError(format!(
                "{name} is required when BUZZ_OBJECT_STORAGE_BACKEND=azure"
            ))
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn tenant(n: u128) -> TenantContext {
        TenantContext::resolved(
            CommunityId::from_uuid(uuid::Uuid::from_u128(n)),
            "media.example",
        )
    }

    fn storage_config(access: &str, secret: &str) -> crate::config::MediaConfig {
        crate::config::MediaConfig {
            s3_endpoint: "http://localhost:9000".to_string(),
            s3_access_key: access.to_string(),
            s3_secret_key: secret.to_string(),
            s3_bucket: "buzz-media".to_string(),
            s3_region: "us-west-2".to_string(),
            max_image_bytes: 50 * 1024 * 1024,
            max_gif_bytes: 10 * 1024 * 1024,
            max_video_bytes: 524_288_000,
            max_file_bytes: 104_857_600,
            public_base_url: "http://localhost:3000/media".to_string(),
            upload_records_enabled: false,
            upload_ip_header: None,
            upload_port_header: None,
        }
    }

    /// Static keys present: builds a client without touching the AWS
    /// credential chain (no env/metadata access), and the signing region
    /// comes from config rather than a hardcoded "us-east-1".
    #[test]
    fn static_keys_build_client_with_configured_region() {
        let storage = MediaStorage::new(&storage_config("buzz_dev", "buzz_dev_secret"))
            .expect("static creds should build a client");
        match &storage.backend {
            MediaBackend::S3(bucket) => match &bucket.region {
                Region::Custom { region, .. } => assert_eq!(region, "us-west-2"),
                other => panic!("expected Custom region, got {other:?}"),
            },
            MediaBackend::Azure(_) => panic!("expected S3 backend"),
        }
    }

    #[test]
    fn partial_static_keys_are_rejected() {
        let err = match MediaStorage::new(&storage_config("buzz_dev", "")) {
            Ok(_) => panic!("partial static creds must not silently use credential chain"),
            Err(err) => err,
        };
        assert!(
            err.to_string().contains("must be configured together"),
            "unexpected error: {err}"
        );

        let err = match MediaStorage::new(&storage_config("", "buzz_dev_secret")) {
            Ok(_) => panic!("partial static creds must not silently use credential chain"),
            Err(err) => err,
        };
        assert!(
            err.to_string().contains("must be configured together"),
            "unexpected error: {err}"
        );
    }

    #[test]
    fn sidecar_keys_are_community_scoped() {
        let a = tenant(1);
        let b = tenant(2);
        let sha = "f".repeat(64);

        assert_eq!(
            MediaStorage::ctx_sidecar_key(&a, &sha),
            format!("_meta/{}/{sha}.json", a.community())
        );
        assert_ne!(
            MediaStorage::ctx_sidecar_key(&a, &sha),
            MediaStorage::ctx_sidecar_key(&b, &sha)
        );
        assert_ne!(
            MediaStorage::ctx_sidecar_key(&a, &sha),
            format!("_meta/{sha}.json")
        );
    }

    /// Mutate-bite shape for the media substrate: same CAS bytes/hash can be
    /// known in A and B, but the sidecar is the read/existence gate. If the
    /// community segment is dropped from `sidecar_key`, B's metadata overwrites
    /// A's in this map and A observes B's MIME (wrong answer, not absence).
    #[test]
    fn same_sha_sidecars_do_not_bleed_between_communities() {
        let a = tenant(1);
        let b = tenant(2);
        let sha = "a".repeat(64);
        let mut sidecars = HashMap::new();

        sidecars.insert(MediaStorage::ctx_sidecar_key(&a, &sha), "image/png");
        sidecars.insert(MediaStorage::ctx_sidecar_key(&b, &sha), "video/mp4");

        assert_eq!(
            sidecars[&MediaStorage::ctx_sidecar_key(&a, &sha)],
            "image/png"
        );
        assert_eq!(
            sidecars[&MediaStorage::ctx_sidecar_key(&b, &sha)],
            "video/mp4"
        );
    }
}

/// Metadata returned by HEAD — just enough for BUD-01 response headers.
pub struct BlobHeadMeta {
    pub size: u64,
}

/// Full blob metadata — stored as sidecar JSON in `_meta/{community}/{sha256}.json`.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct BlobMeta {
    /// Pixel dimensions ("WxH").
    pub dim: String,
    /// Blurhash string.
    pub blurhash: String,
    /// Full URL to thumbnail.
    pub thumb_url: String,
    /// File extension (e.g. "jpg").
    pub ext: String,
    /// MIME type (e.g. "image/jpeg").
    pub mime_type: String,
    /// File size in bytes.
    pub size: u64,
    /// Unix timestamp when the blob was first uploaded.
    #[serde(default)]
    pub uploaded_at: i64,
    /// Video duration in seconds. `None` for non-video blobs.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_secs: Option<f64>,
}
