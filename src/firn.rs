use std::path::Path;
use std::sync::Arc;

use anyhow::Result;

use crate::config::LoadedConfig;
use crate::db::Database;
use crate::gc::{self, GcReport};
use crate::github::GitHubAppClient;
use crate::server;

pub const GITHUB_API_URL: &str = "https://api.github.com";

#[derive(Clone)]
pub struct Firn {
    pub config: Arc<LoadedConfig>,
    pub db: Database,
    pub github_app: Option<Arc<GitHubAppClient>>,
}

impl Firn {
    pub fn new(config: LoadedConfig, db: Database, github_api_url: &str) -> Result<Self> {
        let github_app = GitHubAppClient::from_config(&config, github_api_url)?.map(Arc::new);

        Ok(Self {
            config: Arc::new(config),
            db,
            github_app,
        })
    }

    pub fn open(config_path: &Path) -> Result<Self> {
        let config = LoadedConfig::from_file(config_path)?;
        let db = Database::open(&config.database_path)?;

        Self::new(config, db, GITHUB_API_URL)
    }

    pub async fn serve(self) -> Result<()> {
        server::run(self).await
    }

    pub async fn run_gc(&self, dry_run: bool) -> Result<GcReport> {
        gc::run_once(self, dry_run).await
    }
}
