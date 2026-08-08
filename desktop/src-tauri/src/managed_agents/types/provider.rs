use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum BackendKind {
    #[default]
    Local,
    Provider {
        id: String,
        config: serde_json::Value,
        /// Provider-advertised presentation metadata captured at selection
        /// time. Buzz treats this as inert display data; provider identifiers,
        /// model names, and business rules stay out of the desktop core.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        name: Option<String>,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        summary: Vec<ProviderPresentationItem>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ProviderPresentationItem {
    pub label: String,
    pub value: String,
}

/// Last provider-authoritative lifecycle state returned by protocol v2.
///
/// This is a cache for immediate/offline UI rendering only. The provider
/// control plane remains authoritative and every lifecycle operation refreshes
/// the complete value. Optional/defaulted fields preserve compatibility with
/// agents written by earlier Buzz versions and protocol-v1 providers.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ProviderLifecycleState {
    pub desired_state: String,
    pub observed_state: String,
    pub last_reconciled_at: Option<String>,
    pub last_ready_at: Option<String>,
    pub error_code: Option<String>,
    pub correlation_id: String,
}
