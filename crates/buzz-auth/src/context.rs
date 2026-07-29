//! Versioned, transport-neutral authorization context.
//!
//! Authentication adapters produce this context after verifying Nostr proof.
//! Federated identity is optional, but when present it remains distinct from
//! the Nostr authority that signed the request. Raw assertions and mutable
//! display claims never enter this type.

use std::fmt;

use buzz_core::{tenant::TenantContext, CommunityId};
use nostr::PublicKey;
use thiserror::Error;
use uuid::Uuid;

use crate::Scope;

/// Version of the authorization-context contract.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuthContextVersion {
    /// Initial shared authorization-context contract.
    V1,
}

/// Cryptographic proof used to authenticate the Nostr actor.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuthMethod {
    /// NIP-42 challenge/response over WebSocket.
    Nip42,
    /// NIP-98 signed HTTP request.
    Nip98,
    /// Blossom upload authorization.
    Blossom,
}

/// Entry point that produced the authorization context.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuthTransport {
    /// Relay WebSocket protocol.
    RelayWebSocket,
    /// HTTP relay bridge.
    HttpBridge,
    /// Git-over-HTTP endpoint.
    Git,
    /// Media upload or download endpoint.
    Media,
    /// Huddle audio WebSocket.
    Audio,
}

/// Transport profile used to deliver a federated assertion.
///
/// This records how the assertion reached its verifier. It is intentionally
/// independent of [`AuthTransport`]; each authentication adapter must verify
/// the delivery profile before constructing authorization evidence.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AssertionTransport {
    /// A trusted proxy stripped inbound copies and injected the assertion.
    TrustedProxy,
    /// The client attached the assertion to the authorized request.
    ClientAttached,
}

/// Policy used when no active binding exists for either principal or key.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EnrollmentMode {
    /// First use requires an assertion that attests the proven Nostr key.
    AttestedKey,
    /// Bindings must be created by an out-of-band administrative process.
    Provisioned,
    /// First use may bind the proven key without an asserted key claim.
    Tofu,
}

/// Provenance recorded when a binding is created.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BindingSource {
    /// The identity provider attested the proven Nostr key.
    AttestedKey,
    /// An operator provisioned the binding out of band.
    Provisioned,
    /// The binding was established by trust on first use.
    Tofu,
}

/// Expiry of a validated federated assertion, expressed as Unix seconds.
#[derive(Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct AssertionExpiry(u64);

impl fmt::Debug for AssertionExpiry {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_tuple("AssertionExpiry")
            .field(&"[redacted]")
            .finish()
    }
}

impl AssertionExpiry {
    /// Build a non-zero assertion expiry.
    pub const fn new(unix_seconds: u64) -> Result<Self, AuthContextError> {
        if unix_seconds == 0 {
            return Err(AuthContextError::InvalidAssertionExpiry);
        }
        Ok(Self(unix_seconds))
    }

    /// Expiry as seconds since the Unix epoch.
    pub const fn unix_seconds(self) -> u64 {
        self.0
    }

    /// Returns `true` when the assertion is no longer valid at `now`.
    pub const fn is_expired_at(self, now_unix_seconds: u64) -> bool {
        self.0 <= now_unix_seconds
    }
}

/// Expiry imposed by a separately verified delegation proof.
#[derive(Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct DelegationExpiry(u64);

impl fmt::Debug for DelegationExpiry {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_tuple("DelegationExpiry")
            .field(&"[redacted]")
            .finish()
    }
}

impl DelegationExpiry {
    /// Build a non-zero delegation expiry.
    pub const fn new(unix_seconds: u64) -> Result<Self, AuthContextError> {
        if unix_seconds == 0 {
            return Err(AuthContextError::InvalidDelegationExpiry);
        }
        Ok(Self(unix_seconds))
    }

    /// Expiry as seconds since the Unix epoch.
    pub const fn unix_seconds(self) -> u64 {
        self.0
    }

    /// Returns `true` when the delegation is no longer valid at `now`.
    pub const fn is_expired_at(self, now_unix_seconds: u64) -> bool {
        self.0 <= now_unix_seconds
    }
}

/// Server-verified Nostr authority for a request or connection.
#[derive(Clone, PartialEq, Eq)]
pub struct NostrAuthority {
    actor_pubkey: PublicKey,
    proof_method: AuthMethod,
    verified_owner_pubkey: Option<PublicKey>,
}

impl fmt::Debug for NostrAuthority {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("NostrAuthority")
            .field("actor_pubkey", &"[redacted]")
            .field("proof_method", &self.proof_method)
            .field(
                "verified_owner_pubkey",
                &self.verified_owner_pubkey.map(|_| "[redacted]"),
            )
            .finish()
    }
}

impl NostrAuthority {
    fn new(
        actor_pubkey: PublicKey,
        proof_method: AuthMethod,
        verified_owner_pubkey: Option<PublicKey>,
    ) -> Self {
        Self {
            actor_pubkey,
            proof_method,
            verified_owner_pubkey,
        }
    }

    /// Authenticated Nostr actor.
    pub const fn actor_pubkey(&self) -> PublicKey {
        self.actor_pubkey
    }

    /// Proof method used to authenticate the actor.
    pub const fn proof_method(&self) -> AuthMethod {
        self.proof_method
    }

    /// Cryptographically verified owner for a delegated Nostr actor.
    pub const fn verified_owner_pubkey(&self) -> Option<PublicKey> {
        self.verified_owner_pubkey
    }
}

/// Stable identity-provider principal.
///
/// Equality uses the exact validated issuer and subject values. Neither value
/// is suitable for public events or general-purpose logs.
#[derive(Clone, PartialEq, Eq, Hash)]
pub struct FederatedPrincipal {
    issuer: String,
    subject: String,
}

impl FederatedPrincipal {
    /// Build an issuer-qualified principal from validated assertion claims.
    pub fn new(
        issuer: impl Into<String>,
        subject: impl Into<String>,
    ) -> Result<Self, AuthContextError> {
        let issuer = issuer.into();
        let subject = subject.into();
        if issuer.trim().is_empty() {
            return Err(AuthContextError::EmptyIssuer);
        }
        if subject.trim().is_empty() {
            return Err(AuthContextError::EmptySubject);
        }
        Ok(Self { issuer, subject })
    }

    /// Validated identity-provider issuer.
    pub fn issuer(&self) -> &str {
        &self.issuer
    }

    /// Stable, non-reassignable subject within the issuer namespace.
    pub fn subject(&self) -> &str {
        &self.subject
    }
}

impl fmt::Debug for FederatedPrincipal {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("FederatedPrincipal")
            .field("issuer", &"[redacted]")
            .field("subject", &"[redacted]")
            .finish()
    }
}

/// Monotonically increasing version of an identity-to-key binding.
#[derive(Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct BindingVersion(u64);

impl fmt::Debug for BindingVersion {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_tuple("BindingVersion")
            .field(&"[redacted]")
            .finish()
    }
}

impl BindingVersion {
    /// Initial version assigned to a newly created binding.
    pub const INITIAL: Self = Self(1);

    /// Build a non-zero binding version.
    pub const fn new(value: u64) -> Result<Self, AuthContextError> {
        if value == 0 {
            return Err(AuthContextError::InvalidBindingVersion);
        }
        Ok(Self(value))
    }

    /// Numeric binding version.
    pub const fn get(self) -> u64 {
        self.0
    }
}

/// Stable reference to one active identity-to-key binding.
///
/// This reference is identity evidence. It is not an authorization lease and
/// does not by itself provide expiry or live-revocation enforcement.
#[derive(Clone, PartialEq, Eq)]
pub struct VersionedBindingRef {
    authorization_domain: CommunityId,
    binding_id: Uuid,
    principal: FederatedPrincipal,
    bound_pubkey: PublicKey,
    binding_version: BindingVersion,
    source: BindingSource,
}

impl fmt::Debug for VersionedBindingRef {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("VersionedBindingRef")
            .field("authorization_domain", &"[redacted]")
            .field("binding_id", &"[redacted]")
            .field("principal", &self.principal)
            .field("bound_pubkey", &"[redacted]")
            .field("binding_version", &"[redacted]")
            .field("source", &self.source)
            .finish()
    }
}

impl VersionedBindingRef {
    /// Build a reference to an active, versioned binding.
    pub fn new(
        authorization_domain: CommunityId,
        binding_id: Uuid,
        principal: FederatedPrincipal,
        bound_pubkey: PublicKey,
        binding_version: BindingVersion,
        source: BindingSource,
    ) -> Result<Self, AuthContextError> {
        if binding_id.is_nil() {
            return Err(AuthContextError::InvalidBindingId);
        }
        Ok(Self {
            authorization_domain,
            binding_id,
            principal,
            bound_pubkey,
            binding_version,
            source,
        })
    }

    /// Server-resolved authorization domain that owns the binding.
    pub const fn authorization_domain(&self) -> CommunityId {
        self.authorization_domain
    }

    /// Stable binding identifier.
    pub const fn binding_id(&self) -> Uuid {
        self.binding_id
    }

    /// Issuer-qualified principal represented by the binding.
    pub const fn principal(&self) -> &FederatedPrincipal {
        &self.principal
    }

    /// Nostr key owned by the binding.
    pub const fn bound_pubkey(&self) -> PublicKey {
        self.bound_pubkey
    }

    /// Current binding version.
    pub const fn binding_version(&self) -> BindingVersion {
        self.binding_version
    }

    /// Provenance of the active binding.
    pub const fn source(&self) -> BindingSource {
        self.source
    }
}

/// Separately verified delegation from a bound owner to the authenticated key.
#[derive(Clone, PartialEq, Eq)]
pub struct VerifiedDelegation {
    owner_pubkey: PublicKey,
    delegate_pubkey: PublicKey,
    expires_at: Option<DelegationExpiry>,
}

impl fmt::Debug for VerifiedDelegation {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("VerifiedDelegation")
            .field("owner_pubkey", &"[redacted]")
            .field("delegate_pubkey", &"[redacted]")
            .field("expires_at", &self.expires_at.map(|_| "[redacted]"))
            .finish()
    }
}

impl VerifiedDelegation {
    /// Build a verified delegation result after the caller has validated the
    /// delegation proof against both keys and any transport-specific context.
    pub fn new(
        owner_pubkey: PublicKey,
        delegate_pubkey: PublicKey,
        expires_at: Option<DelegationExpiry>,
    ) -> Result<Self, AuthContextError> {
        if owner_pubkey == delegate_pubkey {
            return Err(AuthContextError::SelfDelegation);
        }
        Ok(Self {
            owner_pubkey,
            delegate_pubkey,
            expires_at,
        })
    }

    /// Bound owner that authorized the delegate.
    pub const fn owner_pubkey(&self) -> PublicKey {
        self.owner_pubkey
    }

    /// Authenticated delegate key.
    pub const fn delegate_pubkey(&self) -> PublicKey {
        self.delegate_pubkey
    }

    /// Optional upper bound imposed by the delegation proof.
    pub const fn expires_at(&self) -> Option<DelegationExpiry> {
        self.expires_at
    }
}

/// Stable reason for an allowed authorization decision.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuthorizationReason {
    /// Only the configured Nostr proof was required.
    NostrOnly,
    /// An existing direct federated binding matched.
    ///
    /// Enrollment policy governs creation of new bindings. Resolution of an
    /// existing active binding, including future lease checks, is a separate
    /// lifecycle decision.
    ExistingBinding,
    /// A direct binding was created under attested-key enrollment.
    EnrolledAttestedKey,
    /// A direct binding was created under trust-on-first-use enrollment.
    EnrolledTofu,
    /// A verified delegate derived authority from a bound owner.
    DelegatedOwnerBinding,
}

impl AuthorizationReason {
    /// Stable audit and metric code for this decision.
    pub const fn code(self) -> &'static str {
        match self {
            Self::NostrOnly => "nostr_only",
            Self::ExistingBinding => "federated_binding_existing",
            Self::EnrolledAttestedKey => "federated_binding_enrolled_attested_key",
            Self::EnrolledTofu => "federated_binding_enrolled_tofu",
            Self::DelegatedOwnerBinding => "federated_delegated_owner_binding",
        }
    }
}

/// Federated authorization attached to a Nostr-authenticated actor.
#[derive(Clone, PartialEq, Eq)]
pub enum FederatedAuthorization {
    /// This deployment does not require federated identity.
    ///
    /// An independently verified Nostr owner may still be present in the
    /// [`NostrAuthority`] without acquiring a federated binding.
    NotRequired,
    /// The actor directly owns the active federated binding.
    Direct {
        /// Active identity-to-key binding.
        binding: VersionedBindingRef,
        /// Principal extracted from the currently validated assertion.
        assertion_principal: FederatedPrincipal,
        /// Assertion delivery profile used by the verifier.
        assertion_transport: AssertionTransport,
        /// Enrollment policy evaluated for the authorization domain.
        enrollment_mode: EnrollmentMode,
        /// Upper bound for authorization derived from the assertion.
        assertion_expires_at: AssertionExpiry,
        /// Stable reason describing whether the binding existed or was enrolled.
        reason: AuthorizationReason,
    },
    /// The actor is delegated by the owner of an active federated binding.
    Delegated {
        /// Owner's active binding.
        owner: VersionedBindingRef,
        /// Owner principal extracted from the currently validated assertion.
        assertion_principal: FederatedPrincipal,
        /// Assertion delivery profile used by the verifier.
        assertion_transport: AssertionTransport,
        /// Upper bound for authorization derived from the owner's assertion.
        assertion_expires_at: AssertionExpiry,
        /// Separately verified owner-to-delegate proof.
        delegation: VerifiedDelegation,
    },
}

impl fmt::Debug for FederatedAuthorization {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NotRequired => formatter.write_str("NotRequired"),
            Self::Direct {
                binding,
                assertion_transport,
                enrollment_mode,
                reason,
                ..
            } => formatter
                .debug_struct("Direct")
                .field("binding", binding)
                .field("assertion_principal", &"[redacted]")
                .field("assertion_transport", assertion_transport)
                .field("enrollment_mode", enrollment_mode)
                .field("assertion_expires_at", &"[redacted]")
                .field("reason", reason)
                .finish(),
            Self::Delegated {
                owner,
                assertion_transport,
                delegation,
                ..
            } => formatter
                .debug_struct("Delegated")
                .field("owner", owner)
                .field("assertion_principal", &"[redacted]")
                .field("assertion_transport", assertion_transport)
                .field("assertion_expires_at", &"[redacted]")
                .field("delegation", delegation)
                .finish(),
        }
    }
}

/// Initial shared authorization-context contract.
#[derive(Clone, PartialEq, Eq)]
pub struct AuthContextV1 {
    tenant: TenantContext,
    correlation_id: Uuid,
    transport: AuthTransport,
    nostr: NostrAuthority,
    federated: FederatedAuthorization,
    scopes: Vec<Scope>,
    channel_ids: Option<Vec<Uuid>>,
}

/// Server-verified inputs consumed by the V1 authorization finalizer.
#[derive(Clone, PartialEq, Eq)]
pub struct AuthContextInput {
    tenant: TenantContext,
    correlation_id: Uuid,
    transport: AuthTransport,
    actor_pubkey: PublicKey,
    proof_method: AuthMethod,
    verified_owner_pubkey: Option<PublicKey>,
    scopes: Vec<Scope>,
    channel_ids: Option<Vec<Uuid>>,
}

impl AuthContextInput {
    /// Collect values that have already passed their transport-specific checks.
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        tenant: TenantContext,
        correlation_id: Uuid,
        transport: AuthTransport,
        actor_pubkey: PublicKey,
        proof_method: AuthMethod,
        verified_owner_pubkey: Option<PublicKey>,
        scopes: Vec<Scope>,
        channel_ids: Option<Vec<Uuid>>,
    ) -> Self {
        Self {
            tenant,
            correlation_id,
            transport,
            actor_pubkey,
            proof_method,
            verified_owner_pubkey,
            scopes,
            channel_ids,
        }
    }
}

impl fmt::Debug for AuthContextV1 {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("AuthContextV1")
            .field("authorization_domain", &"[redacted]")
            .field("correlation_id", &"[redacted]")
            .field("transport", &self.transport)
            .field("nostr", &self.nostr)
            .field("federated", &self.federated)
            .field("scopes", &"[redacted]")
            .field("channel_ids", &"[redacted]")
            .finish()
    }
}

/// Versioned result of successful request or connection authorization.
#[derive(Clone, PartialEq, Eq)]
pub enum AuthContext {
    /// Initial shared authorization-context contract.
    V1(AuthContextV1),
}

impl fmt::Debug for AuthContext {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::V1(context) => formatter.debug_tuple("V1").field(context).finish(),
        }
    }
}

impl AuthContext {
    /// Validate all authorization evidence and finalize an immutable V1 context.
    ///
    /// `now_unix_seconds` must come from the server clock for the authorization
    /// decision being finalized.
    pub fn finalize_v1(
        input: AuthContextInput,
        authorization: FederatedAuthorization,
        now_unix_seconds: u64,
    ) -> Result<Self, AuthContextError> {
        if !transport_accepts_proof(input.transport, input.proof_method) {
            return Err(AuthContextError::TransportProofMismatch);
        }
        validate_federated_authorization(
            input.tenant.community(),
            input.actor_pubkey,
            input.verified_owner_pubkey,
            &authorization,
            now_unix_seconds,
        )?;
        let nostr = NostrAuthority::new(
            input.actor_pubkey,
            input.proof_method,
            input.verified_owner_pubkey,
        );
        Ok(Self::V1(AuthContextV1 {
            tenant: input.tenant,
            correlation_id: input.correlation_id,
            transport: input.transport,
            nostr,
            federated: authorization,
            scopes: input.scopes,
            channel_ids: input.channel_ids,
        }))
    }

    /// Contract version represented by this context.
    pub const fn version(&self) -> AuthContextVersion {
        match self {
            Self::V1(_) => AuthContextVersion::V1,
        }
    }

    /// Server-resolved tenant for the request or connection.
    pub const fn tenant(&self) -> &TenantContext {
        match self {
            Self::V1(context) => &context.tenant,
        }
    }

    /// Request or connection correlation identifier.
    pub const fn correlation_id(&self) -> Uuid {
        match self {
            Self::V1(context) => context.correlation_id,
        }
    }

    /// Transport that established this authorization context.
    pub const fn transport(&self) -> AuthTransport {
        match self {
            Self::V1(context) => context.transport,
        }
    }

    /// Verified Nostr authority.
    pub const fn nostr(&self) -> &NostrAuthority {
        match self {
            Self::V1(context) => &context.nostr,
        }
    }

    /// Authenticated Nostr actor.
    pub const fn pubkey(&self) -> PublicKey {
        self.nostr().actor_pubkey()
    }

    /// Proof method used to authenticate the Nostr actor.
    pub const fn auth_method(&self) -> AuthMethod {
        self.nostr().proof_method()
    }

    /// Cryptographically verified owner for a delegated Nostr actor.
    pub const fn agent_owner_pubkey(&self) -> Option<PublicKey> {
        self.nostr().verified_owner_pubkey()
    }

    /// Federated authorization associated with the Nostr actor.
    pub const fn federated_authorization(&self) -> &FederatedAuthorization {
        match self {
            Self::V1(context) => &context.federated,
        }
    }

    /// Stable reason for the successful authorization decision.
    pub const fn authorization_reason(&self) -> AuthorizationReason {
        match self.federated_authorization() {
            FederatedAuthorization::NotRequired => AuthorizationReason::NostrOnly,
            FederatedAuthorization::Direct { reason, .. } => *reason,
            FederatedAuthorization::Delegated { .. } => AuthorizationReason::DelegatedOwnerBinding,
        }
    }

    /// Permission scopes granted to the context.
    pub fn scopes(&self) -> &[Scope] {
        match self {
            Self::V1(context) => &context.scopes,
        }
    }

    /// Optional channel restriction.
    pub fn channel_ids(&self) -> Option<&[Uuid]> {
        match self {
            Self::V1(context) => context.channel_ids.as_deref(),
        }
    }

    /// Returns `true` if this context includes the given scope.
    pub fn has_scope(&self, scope: &Scope) -> bool {
        self.scopes().contains(scope)
    }
}

const fn transport_accepts_proof(transport: AuthTransport, proof_method: AuthMethod) -> bool {
    match transport {
        AuthTransport::RelayWebSocket | AuthTransport::Audio => {
            matches!(proof_method, AuthMethod::Nip42)
        }
        AuthTransport::HttpBridge | AuthTransport::Git => matches!(proof_method, AuthMethod::Nip98),
        AuthTransport::Media => matches!(proof_method, AuthMethod::Nip98 | AuthMethod::Blossom),
    }
}

fn validate_federated_authorization(
    authorization_domain: CommunityId,
    actor_pubkey: PublicKey,
    verified_owner: Option<PublicKey>,
    authorization: &FederatedAuthorization,
    now_unix_seconds: u64,
) -> Result<(), AuthContextError> {
    if verified_owner == Some(actor_pubkey) {
        return Err(AuthContextError::SelfDelegation);
    }
    match authorization {
        FederatedAuthorization::NotRequired => {}
        FederatedAuthorization::Direct {
            binding,
            assertion_principal,
            enrollment_mode,
            assertion_expires_at,
            reason,
            ..
        } => {
            if binding.authorization_domain() != authorization_domain {
                return Err(AuthContextError::BindingDomainMismatch);
            }
            if assertion_principal != binding.principal() {
                return Err(AuthContextError::AssertionPrincipalMismatch);
            }
            if verified_owner.is_some() {
                return Err(AuthContextError::DirectAuthorizationHasOwner);
            }
            if binding.bound_pubkey() != actor_pubkey {
                return Err(AuthContextError::DirectBindingKeyMismatch);
            }
            if assertion_expires_at.is_expired_at(now_unix_seconds) {
                return Err(AuthContextError::AssertionExpired);
            }
            if !direct_reason_is_valid(*reason, *enrollment_mode, binding.source()) {
                return Err(AuthContextError::InvalidAuthorizationReason);
            }
        }
        FederatedAuthorization::Delegated {
            owner,
            assertion_principal,
            assertion_expires_at,
            delegation,
            ..
        } => {
            if owner.authorization_domain() != authorization_domain {
                return Err(AuthContextError::BindingDomainMismatch);
            }
            if assertion_principal != owner.principal() {
                return Err(AuthContextError::AssertionPrincipalMismatch);
            }
            if delegation.delegate_pubkey() != actor_pubkey {
                return Err(AuthContextError::DelegateKeyMismatch);
            }
            if delegation.owner_pubkey() != owner.bound_pubkey()
                || verified_owner != Some(owner.bound_pubkey())
            {
                return Err(AuthContextError::DelegatedOwnerMismatch);
            }
            if assertion_expires_at.is_expired_at(now_unix_seconds) {
                return Err(AuthContextError::AssertionExpired);
            }
            if delegation
                .expires_at()
                .is_some_and(|expiry| expiry.is_expired_at(now_unix_seconds))
            {
                return Err(AuthContextError::DelegationExpired);
            }
        }
    }
    Ok(())
}

const fn direct_reason_is_valid(
    reason: AuthorizationReason,
    enrollment_mode: EnrollmentMode,
    binding_source: BindingSource,
) -> bool {
    match reason {
        AuthorizationReason::ExistingBinding => true,
        AuthorizationReason::EnrolledAttestedKey => {
            matches!(enrollment_mode, EnrollmentMode::AttestedKey)
                && matches!(binding_source, BindingSource::AttestedKey)
        }
        AuthorizationReason::EnrolledTofu => {
            matches!(enrollment_mode, EnrollmentMode::Tofu)
                && matches!(
                    binding_source,
                    BindingSource::Tofu | BindingSource::AttestedKey
                )
        }
        AuthorizationReason::NostrOnly | AuthorizationReason::DelegatedOwnerBinding => false,
    }
}

/// Invalid authorization-context construction.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Error)]
pub enum AuthContextError {
    /// Issuer was empty.
    #[error("federated principal issuer must not be empty")]
    EmptyIssuer,
    /// Subject was empty.
    #[error("federated principal subject must not be empty")]
    EmptySubject,
    /// Binding version was zero.
    #[error("identity binding version must be greater than zero")]
    InvalidBindingVersion,
    /// Binding identifier was the nil UUID.
    #[error("identity binding identifier must not be nil")]
    InvalidBindingId,
    /// Assertion expiry was not a valid Unix timestamp.
    #[error("federated assertion expiry must be greater than zero")]
    InvalidAssertionExpiry,
    /// Delegation expiry was not a valid Unix timestamp.
    #[error("delegation expiry must be greater than zero")]
    InvalidDelegationExpiry,
    /// Assertion had expired when authorization was evaluated.
    #[error("federated assertion has expired")]
    AssertionExpired,
    /// Delegation had expired when authorization was evaluated.
    #[error("verified delegation has expired")]
    DelegationExpired,
    /// Owner and delegate were the same key.
    #[error("delegation owner and delegate must be different keys")]
    SelfDelegation,
    /// Direct authorization reason did not match its enrollment policy or source.
    #[error("federated authorization reason does not match binding provenance")]
    InvalidAuthorizationReason,
    /// Binding belonged to a different server-resolved authorization domain.
    #[error("federated binding does not belong to the authorization domain")]
    BindingDomainMismatch,
    /// Validated assertion principal did not match the active binding.
    #[error("federated assertion principal does not match the active binding")]
    AssertionPrincipalMismatch,
    /// Proof method was not valid for the transport being authorized.
    #[error("Nostr proof method does not match authorization transport")]
    TransportProofMismatch,
    /// Direct federated authorization was attached to a delegated Nostr actor.
    #[error("direct federated authorization cannot include a delegated Nostr owner")]
    DirectAuthorizationHasOwner,
    /// Direct binding key did not match the authenticated actor.
    #[error("direct federated binding does not match the authenticated Nostr key")]
    DirectBindingKeyMismatch,
    /// Delegated authorization named a different actor.
    #[error("delegated federated authorization does not match the authenticated Nostr key")]
    DelegateKeyMismatch,
    /// Delegated authorization did not match the verified Nostr owner.
    #[error("delegated federated authorization does not match the verified Nostr owner")]
    DelegatedOwnerMismatch,
}

impl AuthContextError {
    /// Stable audit and metric code for this rejected finalization.
    pub const fn code(self) -> &'static str {
        match self {
            Self::EmptyIssuer => "federated_principal_empty_issuer",
            Self::EmptySubject => "federated_principal_empty_subject",
            Self::InvalidBindingVersion => "federated_binding_invalid_version",
            Self::InvalidBindingId => "federated_binding_invalid_id",
            Self::InvalidAssertionExpiry => "federated_assertion_invalid_expiry",
            Self::InvalidDelegationExpiry => "delegation_invalid_expiry",
            Self::AssertionExpired => "federated_assertion_expired",
            Self::DelegationExpired => "delegation_expired",
            Self::SelfDelegation => "delegation_self_reference",
            Self::InvalidAuthorizationReason => "federated_binding_invalid_reason",
            Self::BindingDomainMismatch => "federated_binding_domain_mismatch",
            Self::AssertionPrincipalMismatch => "federated_assertion_principal_mismatch",
            Self::TransportProofMismatch => "nostr_transport_proof_mismatch",
            Self::DirectAuthorizationHasOwner => "federated_direct_has_owner",
            Self::DirectBindingKeyMismatch => "federated_direct_key_mismatch",
            Self::DelegateKeyMismatch => "federated_delegate_key_mismatch",
            Self::DelegatedOwnerMismatch => "federated_delegated_owner_mismatch",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use buzz_core::CommunityId;
    use nostr::Keys;

    fn tenant(value: u128) -> TenantContext {
        TenantContext::resolved(
            CommunityId::from_uuid(Uuid::from_u128(value)),
            "relay.example",
        )
    }

    fn principal() -> FederatedPrincipal {
        FederatedPrincipal::new("https://idp.example", "subject-123")
            .expect("synthetic principal is valid")
    }

    fn binding(pubkey: PublicKey) -> VersionedBindingRef {
        binding_in(1, pubkey)
    }

    fn binding_in(domain: u128, pubkey: PublicKey) -> VersionedBindingRef {
        VersionedBindingRef::new(
            CommunityId::from_uuid(Uuid::from_u128(domain)),
            Uuid::from_u128(10),
            principal(),
            pubkey,
            BindingVersion::INITIAL,
            BindingSource::AttestedKey,
        )
        .expect("synthetic binding identifier is valid")
    }

    fn input(
        actor_pubkey: PublicKey,
        transport: AuthTransport,
        verified_owner_pubkey: Option<PublicKey>,
    ) -> AuthContextInput {
        AuthContextInput::new(
            tenant(1),
            Uuid::from_u128(2),
            transport,
            actor_pubkey,
            match transport {
                AuthTransport::RelayWebSocket | AuthTransport::Audio => AuthMethod::Nip42,
                _ => AuthMethod::Nip98,
            },
            verified_owner_pubkey,
            Scope::all_known(),
            None,
        )
    }

    fn delegated_authorization(
        domain: u128,
        owner_pubkey: PublicKey,
        delegate_pubkey: PublicKey,
        assertion_principal: FederatedPrincipal,
        assertion_expiry: u64,
        delegation_expiry: u64,
    ) -> FederatedAuthorization {
        FederatedAuthorization::Delegated {
            owner: binding_in(domain, owner_pubkey),
            assertion_principal,
            assertion_transport: AssertionTransport::TrustedProxy,
            assertion_expires_at: AssertionExpiry::new(assertion_expiry)
                .expect("synthetic assertion expiry is valid"),
            delegation: VerifiedDelegation::new(
                owner_pubkey,
                delegate_pubkey,
                Some(
                    DelegationExpiry::new(delegation_expiry)
                        .expect("synthetic delegation expiry is valid"),
                ),
            )
            .expect("synthetic owner and delegate are distinct"),
        }
    }

    #[test]
    fn context_preserves_server_resolved_authority() {
        let keys = Keys::generate();
        let correlation_id = Uuid::from_u128(2);
        let context = AuthContext::finalize_v1(
            AuthContextInput::new(
                tenant(1),
                correlation_id,
                AuthTransport::RelayWebSocket,
                keys.public_key(),
                AuthMethod::Nip42,
                None,
                vec![Scope::MessagesRead],
                None,
            ),
            FederatedAuthorization::NotRequired,
            100,
        )
        .expect("Nostr-only policy is final authorization");

        assert_eq!(context.version(), AuthContextVersion::V1);
        assert_eq!(context.tenant().community().as_uuid(), &Uuid::from_u128(1));
        assert_eq!(context.correlation_id(), correlation_id);
        assert_eq!(context.transport(), AuthTransport::RelayWebSocket);
        assert_eq!(context.pubkey(), keys.public_key());
        assert_eq!(context.auth_method(), AuthMethod::Nip42);
        assert!(context.has_scope(&Scope::MessagesRead));
        assert_eq!(
            context.federated_authorization(),
            &FederatedAuthorization::NotRequired
        );
    }

    #[test]
    fn direct_authorization_requires_the_authenticated_key() {
        let actor = Keys::generate();
        let other = Keys::generate();
        let error = AuthContext::finalize_v1(
            input(actor.public_key(), AuthTransport::RelayWebSocket, None),
            FederatedAuthorization::Direct {
                binding: binding(other.public_key()),
                assertion_principal: principal(),
                assertion_transport: AssertionTransport::TrustedProxy,
                enrollment_mode: EnrollmentMode::AttestedKey,
                assertion_expires_at: AssertionExpiry::new(200).expect("synthetic expiry is valid"),
                reason: AuthorizationReason::ExistingBinding,
            },
            100,
        )
        .expect_err("a direct binding for another key must be rejected");
        assert_eq!(error, AuthContextError::DirectBindingKeyMismatch);
    }

    #[test]
    fn delegated_authorization_requires_the_verified_owner() {
        let actor = Keys::generate();
        let owner = Keys::generate();
        let context = AuthContext::finalize_v1(
            input(
                actor.public_key(),
                AuthTransport::RelayWebSocket,
                Some(owner.public_key()),
            ),
            delegated_authorization(
                1,
                owner.public_key(),
                actor.public_key(),
                principal(),
                200,
                200,
            ),
            100,
        )
        .expect("verified owner and delegate match");

        assert!(matches!(
            context.federated_authorization(),
            FederatedAuthorization::Delegated { .. }
        ));
    }

    #[test]
    fn principal_debug_output_redacts_claim_values() {
        let principal = FederatedPrincipal::new("https://idp.example", "subject-123")
            .expect("synthetic principal is valid");
        let output = format!("{principal:?}");

        assert!(!output.contains("idp.example"));
        assert!(!output.contains("subject-123"));
        assert!(output.contains("[redacted]"));
    }

    #[test]
    fn context_debug_output_omits_tenant_host() {
        let actor = Keys::generate();
        let channel_id = Uuid::from_u128(20);
        let context = AuthContext::finalize_v1(
            AuthContextInput::new(
                tenant(1),
                Uuid::from_u128(2),
                AuthTransport::RelayWebSocket,
                actor.public_key(),
                AuthMethod::Nip42,
                None,
                vec![Scope::MessagesRead],
                Some(vec![channel_id]),
            ),
            FederatedAuthorization::Direct {
                binding: binding(actor.public_key()),
                assertion_principal: principal(),
                assertion_transport: AssertionTransport::TrustedProxy,
                enrollment_mode: EnrollmentMode::AttestedKey,
                assertion_expires_at: AssertionExpiry::new(200).expect("synthetic expiry is valid"),
                reason: AuthorizationReason::ExistingBinding,
            },
            100,
        )
        .expect("matching direct authorization is valid");

        let output = format!("{context:?}");
        assert!(!output.contains("relay.example"));
        assert!(!output.contains("idp.example"));
        assert!(!output.contains("subject-123"));
        assert!(!output.contains(&Uuid::from_u128(1).to_string()));
        assert!(!output.contains(&Uuid::from_u128(2).to_string()));
        assert!(!output.contains(&Uuid::from_u128(10).to_string()));
        assert!(!output.contains(&channel_id.to_string()));
        assert!(!output.contains(&actor.public_key().to_hex()));
        assert!(!output.contains("MessagesRead"));
        assert!(!output.contains("scope_count"));
        assert!(!output.contains("channel_restricted"));
        assert!(output.contains("authorization_domain"));
        assert!(output.contains("[redacted]"));
    }

    #[test]
    fn direct_authorization_rejects_a_verified_owner() {
        let actor = Keys::generate();
        let owner = Keys::generate();
        let error = AuthContext::finalize_v1(
            input(
                actor.public_key(),
                AuthTransport::RelayWebSocket,
                Some(owner.public_key()),
            ),
            FederatedAuthorization::Direct {
                binding: binding(actor.public_key()),
                assertion_principal: principal(),
                assertion_transport: AssertionTransport::TrustedProxy,
                enrollment_mode: EnrollmentMode::AttestedKey,
                assertion_expires_at: AssertionExpiry::new(200).expect("synthetic expiry is valid"),
                reason: AuthorizationReason::ExistingBinding,
            },
            100,
        )
        .expect_err("direct authorization cannot derive authority from an owner");

        assert_eq!(error, AuthContextError::DirectAuthorizationHasOwner);
    }

    #[test]
    fn delegated_authorization_requires_a_current_owner_assertion() {
        let actor = Keys::generate();
        let owner = Keys::generate();
        let error = AuthContext::finalize_v1(
            input(
                actor.public_key(),
                AuthTransport::RelayWebSocket,
                Some(owner.public_key()),
            ),
            delegated_authorization(
                1,
                owner.public_key(),
                actor.public_key(),
                principal(),
                100,
                200,
            ),
            100,
        )
        .expect_err("delegated authorization must not survive owner assertion expiry");

        assert_eq!(error, AuthContextError::AssertionExpired);
    }

    #[test]
    fn delegated_authorization_requires_the_owner_assertion_principal() {
        let actor = Keys::generate();
        let owner = Keys::generate();
        let assertion_principal = FederatedPrincipal::new("https://idp.example", "other-subject")
            .expect("synthetic principal is valid");
        let error = AuthContext::finalize_v1(
            input(
                actor.public_key(),
                AuthTransport::RelayWebSocket,
                Some(owner.public_key()),
            ),
            delegated_authorization(
                1,
                owner.public_key(),
                actor.public_key(),
                assertion_principal,
                200,
                200,
            ),
            100,
        )
        .expect_err("the current assertion must identify the bound owner");

        assert_eq!(error, AuthContextError::AssertionPrincipalMismatch);
    }

    #[test]
    fn delegated_authorization_rejects_an_expired_proof() {
        let actor = Keys::generate();
        let owner = Keys::generate();
        let error = AuthContext::finalize_v1(
            input(
                actor.public_key(),
                AuthTransport::RelayWebSocket,
                Some(owner.public_key()),
            ),
            delegated_authorization(
                1,
                owner.public_key(),
                actor.public_key(),
                principal(),
                200,
                100,
            ),
            100,
        )
        .expect_err("delegated authorization must not survive delegation expiry");

        assert_eq!(error, AuthContextError::DelegationExpired);
    }

    #[test]
    fn delegated_authorization_requires_the_authenticated_delegate() {
        let actor = Keys::generate();
        let other_delegate = Keys::generate();
        let owner = Keys::generate();
        let error = AuthContext::finalize_v1(
            input(
                actor.public_key(),
                AuthTransport::RelayWebSocket,
                Some(owner.public_key()),
            ),
            delegated_authorization(
                1,
                owner.public_key(),
                other_delegate.public_key(),
                principal(),
                200,
                200,
            ),
            100,
        )
        .expect_err("delegated authorization must name the authenticated actor");

        assert_eq!(error, AuthContextError::DelegateKeyMismatch);
    }

    #[test]
    fn delegated_authorization_requires_the_bound_owner() {
        let actor = Keys::generate();
        let owner = Keys::generate();
        let other_owner = Keys::generate();
        let error = AuthContext::finalize_v1(
            input(
                actor.public_key(),
                AuthTransport::RelayWebSocket,
                Some(other_owner.public_key()),
            ),
            delegated_authorization(
                1,
                owner.public_key(),
                actor.public_key(),
                principal(),
                200,
                200,
            ),
            100,
        )
        .expect_err("delegated authorization must match the verified owner");

        assert_eq!(error, AuthContextError::DelegatedOwnerMismatch);
    }

    #[test]
    fn delegated_binding_cannot_cross_authorization_domains() {
        let actor = Keys::generate();
        let owner = Keys::generate();
        let error = AuthContext::finalize_v1(
            input(
                actor.public_key(),
                AuthTransport::RelayWebSocket,
                Some(owner.public_key()),
            ),
            delegated_authorization(
                2,
                owner.public_key(),
                actor.public_key(),
                principal(),
                200,
                200,
            ),
            100,
        )
        .expect_err("a delegated binding from another domain must be rejected");

        assert_eq!(error, AuthContextError::BindingDomainMismatch);
    }

    #[test]
    fn zero_binding_version_is_rejected() {
        assert_eq!(
            BindingVersion::new(0),
            Err(AuthContextError::InvalidBindingVersion)
        );
    }

    #[test]
    fn nil_binding_identifier_is_rejected() {
        let actor = Keys::generate();
        let error = VersionedBindingRef::new(
            CommunityId::from_uuid(Uuid::from_u128(1)),
            Uuid::nil(),
            principal(),
            actor.public_key(),
            BindingVersion::INITIAL,
            BindingSource::AttestedKey,
        )
        .expect_err("nil is not a stable binding identifier");

        assert_eq!(error, AuthContextError::InvalidBindingId);
        assert_eq!(error.code(), "federated_binding_invalid_id");
    }

    #[test]
    fn evidence_value_debug_output_redacts_numeric_values() {
        let assertion_expiry = AssertionExpiry::new(200).expect("synthetic expiry is valid");
        let delegation_expiry = DelegationExpiry::new(300).expect("synthetic expiry is valid");
        let binding_version = BindingVersion::new(400).expect("synthetic version is valid");

        assert_eq!(
            format!("{assertion_expiry:?}"),
            "AssertionExpiry(\"[redacted]\")"
        );
        assert_eq!(
            format!("{delegation_expiry:?}"),
            "DelegationExpiry(\"[redacted]\")"
        );
        assert_eq!(
            format!("{binding_version:?}"),
            "BindingVersion(\"[redacted]\")"
        );
    }

    #[test]
    fn direct_authorization_rejects_expired_assertions() {
        let actor = Keys::generate();
        let error = AuthContext::finalize_v1(
            input(actor.public_key(), AuthTransport::HttpBridge, None),
            FederatedAuthorization::Direct {
                binding: binding(actor.public_key()),
                assertion_principal: principal(),
                assertion_transport: AssertionTransport::ClientAttached,
                enrollment_mode: EnrollmentMode::AttestedKey,
                assertion_expires_at: AssertionExpiry::new(100).expect("synthetic expiry is valid"),
                reason: AuthorizationReason::ExistingBinding,
            },
            100,
        )
        .expect_err("authorization must not survive assertion expiry");

        assert_eq!(error, AuthContextError::AssertionExpired);
        assert_eq!(error.code(), "federated_assertion_expired");
    }

    #[test]
    fn direct_authorization_requires_the_assertion_principal() {
        let actor = Keys::generate();
        let error = AuthContext::finalize_v1(
            input(actor.public_key(), AuthTransport::RelayWebSocket, None),
            FederatedAuthorization::Direct {
                binding: binding(actor.public_key()),
                assertion_principal: FederatedPrincipal::new(
                    "https://idp.example",
                    "other-subject",
                )
                .expect("synthetic principal is valid"),
                assertion_transport: AssertionTransport::TrustedProxy,
                enrollment_mode: EnrollmentMode::AttestedKey,
                assertion_expires_at: AssertionExpiry::new(200).expect("synthetic expiry is valid"),
                reason: AuthorizationReason::ExistingBinding,
            },
            100,
        )
        .expect_err("the current assertion must identify the bound principal");

        assert_eq!(error, AuthContextError::AssertionPrincipalMismatch);
        assert_eq!(error.code(), "federated_assertion_principal_mismatch");
    }

    #[test]
    fn enrolled_reason_must_match_policy_and_binding_source() {
        let actor = Keys::generate();
        let error = AuthContext::finalize_v1(
            input(actor.public_key(), AuthTransport::RelayWebSocket, None),
            FederatedAuthorization::Direct {
                binding: binding(actor.public_key()),
                assertion_principal: principal(),
                assertion_transport: AssertionTransport::TrustedProxy,
                enrollment_mode: EnrollmentMode::Provisioned,
                assertion_expires_at: AssertionExpiry::new(200).expect("synthetic expiry is valid"),
                reason: AuthorizationReason::EnrolledAttestedKey,
            },
            100,
        )
        .expect_err("provisioned mode cannot enroll during authorization");

        assert_eq!(error, AuthContextError::InvalidAuthorizationReason);
    }

    #[test]
    fn tofu_enrollment_uses_tofu_reason_with_attested_provenance() {
        let actor = Keys::generate();
        let authorization = FederatedAuthorization::Direct {
            binding: binding(actor.public_key()),
            assertion_principal: principal(),
            assertion_transport: AssertionTransport::TrustedProxy,
            enrollment_mode: EnrollmentMode::Tofu,
            assertion_expires_at: AssertionExpiry::new(200).expect("synthetic expiry is valid"),
            reason: AuthorizationReason::EnrolledTofu,
        };

        let context = AuthContext::finalize_v1(
            input(actor.public_key(), AuthTransport::RelayWebSocket, None),
            authorization,
            100,
        )
        .expect("TOFU policy may retain stronger attested-key provenance");

        assert_eq!(
            context.authorization_reason(),
            AuthorizationReason::EnrolledTofu
        );
    }

    #[test]
    fn tofu_enrollment_cannot_use_attested_key_policy_reason() {
        let actor = Keys::generate();
        let error = AuthContext::finalize_v1(
            input(actor.public_key(), AuthTransport::RelayWebSocket, None),
            FederatedAuthorization::Direct {
                binding: binding(actor.public_key()),
                assertion_principal: principal(),
                assertion_transport: AssertionTransport::TrustedProxy,
                enrollment_mode: EnrollmentMode::Tofu,
                assertion_expires_at: AssertionExpiry::new(200).expect("synthetic expiry is valid"),
                reason: AuthorizationReason::EnrolledAttestedKey,
            },
            100,
        )
        .expect_err("TOFU policy must emit the TOFU enrollment reason");

        assert_eq!(error, AuthContextError::InvalidAuthorizationReason);
    }

    #[test]
    fn transport_and_proof_method_must_agree() {
        let actor = Keys::generate();
        let input = AuthContextInput::new(
            tenant(1),
            Uuid::from_u128(2),
            AuthTransport::RelayWebSocket,
            actor.public_key(),
            AuthMethod::Nip98,
            None,
            Scope::all_known(),
            None,
        );

        let error = AuthContext::finalize_v1(input, FederatedAuthorization::NotRequired, 100)
            .expect_err("HTTP proof must not authorize a relay WebSocket");
        assert_eq!(error, AuthContextError::TransportProofMismatch);
    }

    #[test]
    fn binding_cannot_cross_authorization_domains() {
        let actor = Keys::generate();
        let error = AuthContext::finalize_v1(
            input(actor.public_key(), AuthTransport::RelayWebSocket, None),
            FederatedAuthorization::Direct {
                binding: binding_in(2, actor.public_key()),
                assertion_principal: principal(),
                assertion_transport: AssertionTransport::TrustedProxy,
                enrollment_mode: EnrollmentMode::AttestedKey,
                assertion_expires_at: AssertionExpiry::new(200).expect("synthetic expiry is valid"),
                reason: AuthorizationReason::ExistingBinding,
            },
            100,
        )
        .expect_err("a binding from another domain must be rejected");

        assert_eq!(error, AuthContextError::BindingDomainMismatch);
        assert_eq!(error.code(), "federated_binding_domain_mismatch");
    }

    #[test]
    fn nostr_only_authorization_may_preserve_a_verified_owner() {
        let actor = Keys::generate();
        let owner = Keys::generate();
        let context = AuthContext::finalize_v1(
            input(
                actor.public_key(),
                AuthTransport::RelayWebSocket,
                Some(owner.public_key()),
            ),
            FederatedAuthorization::NotRequired,
            100,
        )
        .expect("Nostr delegation remains independent of federated policy");

        assert_eq!(context.agent_owner_pubkey(), Some(owner.public_key()));
        assert_eq!(
            context.authorization_reason(),
            AuthorizationReason::NostrOnly
        );
    }

    #[test]
    fn nostr_only_authorization_rejects_self_delegation() {
        let actor = Keys::generate();
        let error = AuthContext::finalize_v1(
            input(
                actor.public_key(),
                AuthTransport::RelayWebSocket,
                Some(actor.public_key()),
            ),
            FederatedAuthorization::NotRequired,
            100,
        )
        .expect_err("an actor cannot be its own verified owner");

        assert_eq!(error, AuthContextError::SelfDelegation);
    }
}
