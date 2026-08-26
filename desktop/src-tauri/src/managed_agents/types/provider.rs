use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum BackendKind {
    #[default]
    Local,
    Provider {
        id: String,
        config: serde_json::Value,
        /// Validated provider capability, refreshed before every deployment.
        #[serde(
            default,
            skip_serializing_if = "is_false",
            rename = "ownsExecutionProfile"
        )]
        owns_execution_profile: bool,
    },
}

impl BackendKind {
    pub fn owns_execution_profile(&self) -> bool {
        matches!(
            self,
            Self::Provider {
                owns_execution_profile: true,
                ..
            }
        )
    }

    pub fn set_owns_execution_profile(&mut self, owns: bool) {
        if let Self::Provider {
            owns_execution_profile,
            ..
        } = self
        {
            *owns_execution_profile = owns;
        }
    }
}

fn is_false(value: &bool) -> bool {
    !*value
}
