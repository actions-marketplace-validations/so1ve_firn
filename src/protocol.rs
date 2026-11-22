use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlanRequest {
    #[serde(default)]
    pub owner: Option<String>,
    pub store_paths: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlanResponse {
    pub owner: String,
    pub scope: String,
    pub registry: String,
    pub ghcr_repository: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ghcr_token: Option<String>,
    pub missing: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommitEntry {
    pub store_path: String,
    pub nar_hash: String,
    pub nar_size: u64,
    pub file_hash: String,
    pub file_size: u64,
    pub manifest_digest: String,
    pub blob_digest: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deriver: Option<String>,
    #[serde(default)]
    pub references: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommitRequest {
    #[serde(default)]
    pub owner: Option<String>,
    pub entries: Vec<CommitEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommitResponse {
    pub owner: String,
    pub scope: String,
    pub committed: usize,
}
