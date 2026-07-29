//! Azure Blob Storage primitives required by Buzz media and git storage.
//!
//! The adapter deliberately exposes conditional writes as a semantic outcome:
//! losing an optimistic-concurrency race is expected, not a transport error.
//! Production construction uses the Azure credential environment, which lets
//! AKS workload identity provide short-lived credentials without storage keys.

#![deny(unsafe_code)]

use std::ops::Range;
use std::pin::Pin;
use std::sync::Arc;

use bytes::Bytes;
use futures_core::Stream;
use futures_util::TryStreamExt;
use object_store::azure::{MicrosoftAzure, MicrosoftAzureBuilder};
use object_store::path::Path;
use object_store::{
    Attribute, Attributes, Error as ObjectStoreError, ObjectMeta, ObjectStore, ObjectStoreExt,
    PutMode, PutOptions, PutResult, UpdateVersion,
};

/// A streaming Azure Blob response suitable for an HTTP response body.
pub type ByteStream =
    Pin<Box<dyn Stream<Item = Result<Bytes, AzureStorageError>> + Send + 'static>>;

/// A blob body and the exact version metadata observed by the same GET.
#[derive(Debug)]
pub struct VersionedObject {
    /// Object bytes.
    pub bytes: Bytes,
    /// Version to supply to a subsequent compare-and-swap write.
    pub version: UpdateVersion,
    /// Object attributes returned by Azure, including content type when set.
    pub attributes: Attributes,
}

/// Result of an atomic conditional write.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ConditionalWrite {
    /// The write committed and returned the new object version.
    Won(UpdateVersion),
    /// Another writer won the precondition race.
    LostRace,
}

/// Azure Blob adapter failures.
#[derive(Debug, thiserror::Error)]
pub enum AzureStorageError {
    /// Object key could not be represented as an Azure blob path.
    #[error("invalid Azure Blob Storage object key: {0}")]
    InvalidPath(#[from] object_store::path::Error),
    /// Azure or transport failure.
    #[error("Azure Blob Storage error: {0}")]
    Backend(#[from] ObjectStoreError),
    /// A successful write or read omitted the ETag needed for Buzz CAS.
    #[error("Azure Blob Storage response for '{key}' did not include an ETag")]
    MissingEtag {
        /// Object key whose response was incomplete.
        key: String,
    },
}

/// Azure Blob Storage implementation of the object operations Buzz requires.
#[derive(Clone, Debug)]
pub struct AzureBlobStore {
    inner: Arc<MicrosoftAzure>,
}

impl AzureBlobStore {
    /// Build a production client from the Azure credential environment.
    ///
    /// In AKS, set `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, and
    /// `AZURE_FEDERATED_TOKEN_FILE`; `object_store` will use workload identity.
    /// A managed identity is used when no more-specific credential is present.
    pub fn from_env(account: &str, container: &str) -> Result<Self, AzureStorageError> {
        let inner = MicrosoftAzureBuilder::from_env()
            .with_account(account)
            .with_container_name(container)
            .build()?;
        Ok(Self {
            inner: Arc::new(inner),
        })
    }

    /// Build a client for the local Azurite emulator.
    pub fn for_azurite(container: &str) -> Result<Self, AzureStorageError> {
        let inner = MicrosoftAzureBuilder::new()
            .with_container_name(container)
            .with_use_emulator(true)
            .build()?;
        Ok(Self {
            inner: Arc::new(inner),
        })
    }

    /// Atomically create an object only when its key is absent.
    pub async fn create(
        &self,
        key: &str,
        bytes: Bytes,
        content_type: &str,
    ) -> Result<ConditionalWrite, AzureStorageError> {
        self.conditional_put(key, bytes, content_type, PutMode::Create)
            .await
    }

    /// Atomically replace an object only when its version still matches.
    pub async fn update(
        &self,
        key: &str,
        bytes: Bytes,
        content_type: &str,
        version: UpdateVersion,
    ) -> Result<ConditionalWrite, AzureStorageError> {
        self.conditional_put(key, bytes, content_type, PutMode::Update(version))
            .await
    }

    /// Put an object, replacing an existing value when present.
    pub async fn put(
        &self,
        key: &str,
        bytes: Bytes,
        content_type: &str,
    ) -> Result<UpdateVersion, AzureStorageError> {
        let path = object_path(key)?;
        let result = self
            .inner
            .put_opts(
                &path,
                bytes.into(),
                put_options(content_type, PutMode::Overwrite),
            )
            .await?;
        require_etag(key, result)
    }

    /// Read an object's bytes and CAS version from one GET response.
    pub async fn get(&self, key: &str) -> Result<VersionedObject, AzureStorageError> {
        let path = object_path(key)?;
        let result = self.inner.get(&path).await?;
        let version = version_from_meta(key, &result.meta)?;
        let attributes = result.attributes.clone();
        let bytes = result.bytes().await?;
        Ok(VersionedObject {
            bytes,
            version,
            attributes,
        })
    }

    /// Stream an object's bytes without buffering the full body.
    pub async fn get_stream(&self, key: &str) -> Result<ByteStream, AzureStorageError> {
        let path = object_path(key)?;
        let result = self.inner.get(&path).await?;
        Ok(Box::pin(
            result.into_stream().map_err(AzureStorageError::from),
        ))
    }

    /// Read a half-open byte range from an object.
    pub async fn get_range(
        &self,
        key: &str,
        range: Range<u64>,
    ) -> Result<Bytes, AzureStorageError> {
        let path = object_path(key)?;
        Ok(self.inner.get_range(&path, range).await?)
    }

    /// Return object metadata, or `None` when the key is absent.
    pub async fn head(&self, key: &str) -> Result<Option<ObjectMeta>, AzureStorageError> {
        let path = object_path(key)?;
        match self.inner.head(&path).await {
            Ok(meta) => Ok(Some(meta)),
            Err(ObjectStoreError::NotFound { .. }) => Ok(None),
            Err(error) => Err(error.into()),
        }
    }

    /// Delete an object. Azure treats deleting an absent blob as not found.
    pub async fn delete(&self, key: &str) -> Result<(), AzureStorageError> {
        let path = object_path(key)?;
        self.inner.delete(&path).await?;
        Ok(())
    }

    /// List all objects under a prefix, following Azure continuation pages.
    pub async fn list_prefix(&self, prefix: &str) -> Result<Vec<ObjectMeta>, AzureStorageError> {
        let path = object_path(prefix)?;
        Ok(self.inner.list(Some(&path)).try_collect::<Vec<_>>().await?)
    }

    async fn conditional_put(
        &self,
        key: &str,
        bytes: Bytes,
        content_type: &str,
        mode: PutMode,
    ) -> Result<ConditionalWrite, AzureStorageError> {
        let path = object_path(key)?;
        match self
            .inner
            .put_opts(&path, bytes.into(), put_options(content_type, mode))
            .await
        {
            Ok(result) => Ok(ConditionalWrite::Won(require_etag(key, result)?)),
            Err(ObjectStoreError::AlreadyExists { .. } | ObjectStoreError::Precondition { .. }) => {
                Ok(ConditionalWrite::LostRace)
            }
            Err(error) => Err(error.into()),
        }
    }
}

fn object_path(key: &str) -> Result<Path, AzureStorageError> {
    Ok(Path::parse(key)?)
}

fn put_options(content_type: &str, mode: PutMode) -> PutOptions {
    let mut attributes = Attributes::new();
    attributes.insert(Attribute::ContentType, content_type.to_string().into());
    PutOptions {
        mode,
        attributes,
        ..Default::default()
    }
}

fn require_etag(key: &str, result: PutResult) -> Result<UpdateVersion, AzureStorageError> {
    if result.e_tag.is_none() {
        return Err(AzureStorageError::MissingEtag {
            key: key.to_string(),
        });
    }
    Ok(result.into())
}

fn version_from_meta(key: &str, meta: &ObjectMeta) -> Result<UpdateVersion, AzureStorageError> {
    if meta.e_tag.is_none() {
        return Err(AzureStorageError::MissingEtag {
            key: key.to_string(),
        });
    }
    Ok(UpdateVersion {
        e_tag: meta.e_tag.clone(),
        version: meta.version.clone(),
    })
}
