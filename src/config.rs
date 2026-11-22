use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};
use serde::Deserialize;

use crate::nix_format::SigningKeyPair;

pub const CACHE_PRIORITY: u32 = 41;

fn default_listen() -> String {
    "127.0.0.1:8080".to_owned()
}

fn default_package_template() -> String {
    "{repo}-cache".to_owned()
}

fn default_manual_push_package() -> String {
    "manual-cache".to_owned()
}

fn default_protected_refs() -> Vec<String> {
    vec!["refs/heads/main".to_owned()]
}

#[derive(Debug, Clone, Deserialize)]
pub struct GitHubAppConfig {
    pub app_id: u64,
    pub private_key_file: PathBuf,
    #[serde(default)]
    pub webhook_secret_file: Option<PathBuf>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(default)]
pub struct GcConfig {
    pub pr_ttl_days: u64,
    pub main_lru_days: u64,
}

impl Default for GcConfig {
    fn default() -> Self {
        Self {
            pr_ttl_days: 3,
            main_lru_days: 15,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum OwnerType {
    #[default]
    User,
    Org,
}

#[derive(Debug, Clone, Deserialize)]
pub struct OwnerConfig {
    pub name: String,
    #[serde(default)]
    pub owner_type: OwnerType,
    pub github_owner_id: u64,
    #[serde(default)]
    pub github_installation_id: Option<u64>,
    #[serde(default = "default_package_template")]
    pub package_template: String,
    #[serde(default = "default_manual_push_package")]
    pub manual_push_package: String,
    #[serde(default = "default_protected_refs")]
    pub protected_refs: Vec<String>,
    #[serde(default)]
    pub allowed_repos: Vec<String>,
    #[serde(default)]
    pub manual_tokens_file: Option<PathBuf>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Config {
    #[serde(default = "default_listen")]
    pub listen: String,
    pub database_path: PathBuf,
    pub public_base_url: String,
    pub main_signing_key_file: PathBuf,
    pub pr_signing_key_file: PathBuf,
    #[serde(default)]
    pub github_app: Option<GitHubAppConfig>,
    #[serde(default)]
    pub gc: GcConfig,
    #[serde(default)]
    pub owners: Vec<OwnerConfig>,
}

pub struct LoadedGitHubApp {
    pub app_id: u64,
    pub private_key_pem: Vec<u8>,
    pub webhook_secret: Option<Vec<u8>>,
}

pub struct LoadedOwner {
    pub name: String,
    pub owner_type: OwnerType,
    pub github_installation_id: Option<u64>,
    pub package_template: String,
    pub manual_push_package: String,
    pub protected_refs: Vec<String>,
    pub allowed_repos: HashSet<String>,
    pub manual_tokens: Vec<String>,
}

impl LoadedOwner {
    #[must_use]
    pub fn ghcr_owner(&self) -> String {
        self.name.to_ascii_lowercase()
    }

    #[must_use]
    pub fn ghcr_package_for_repo(&self, repo_name: &str) -> String {
        self.package_template
            .replace("{repo}", repo_name)
            .to_ascii_lowercase()
    }

    #[must_use]
    pub fn ghcr_repository(&self, package: &str) -> String {
        format!("{}/{}", self.ghcr_owner(), package.to_ascii_lowercase())
    }

    #[must_use]
    pub fn is_repo_allowed(&self, repo_name: &str) -> bool {
        self.allowed_repos.is_empty() || self.allowed_repos.contains(repo_name)
    }

    #[must_use]
    pub fn is_protected_ref(&self, ref_name: &str) -> bool {
        self.protected_refs.iter().any(|entry| entry == ref_name)
    }
}

fn validate_owner_name(name: &str) -> Result<()> {
    if name.is_empty()
        || !name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
    {
        bail!("invalid owner name '{name}': only ASCII alphanumerics, '-', and '_' are allowed");
    }

    Ok(())
}

fn load_tokens_file(path: &Path) -> Result<Vec<String>> {
    let raw = fs::read_to_string(path)
        .with_context(|| format!("failed to read manual tokens file {}", path.display()))?;

    Ok(raw
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with('#'))
        .map(str::to_owned)
        .collect())
}

fn read_signing_key(path: &Path, kind: &str) -> Result<SigningKeyPair> {
    let raw = fs::read_to_string(path)
        .with_context(|| format!("failed to read {kind} signing key at {}", path.display()))?;

    SigningKeyPair::parse_secret(&raw).with_context(|| format!("invalid {kind} signing key"))
}

fn load_github_app(app: GitHubAppConfig) -> Result<LoadedGitHubApp> {
    let private_key_pem = fs::read(&app.private_key_file).with_context(|| {
        format!(
            "failed to read GitHub App private key {}",
            app.private_key_file.display()
        )
    })?;
    let webhook_secret = match app.webhook_secret_file {
        Some(path) => {
            let secret = fs::read_to_string(&path)
                .with_context(|| format!("failed to read webhook secret {}", path.display()))?;
            let trimmed = secret.trim();
            if trimmed.is_empty() {
                bail!("webhook secret file {} is empty", path.display());
            }

            Some(trimmed.as_bytes().to_vec())
        }
        None => None,
    };

    Ok(LoadedGitHubApp {
        app_id: app.app_id,
        private_key_pem,
        webhook_secret,
    })
}

fn load_owner(owner: OwnerConfig) -> Result<LoadedOwner> {
    validate_owner_name(&owner.name)?;

    let manual_tokens = match owner.manual_tokens_file {
        Some(path) => load_tokens_file(&path)?,
        None => Vec::new(),
    };

    Ok(LoadedOwner {
        name: owner.name,
        owner_type: owner.owner_type,
        github_installation_id: owner.github_installation_id,
        package_template: owner.package_template,
        manual_push_package: owner.manual_push_package.to_ascii_lowercase(),
        protected_refs: owner.protected_refs,
        allowed_repos: owner.allowed_repos.into_iter().collect(),
        manual_tokens,
    })
}

pub struct LoadedConfig {
    pub listen: String,
    pub database_path: PathBuf,
    pub public_base_url: String,
    pub main_key: SigningKeyPair,
    pub pr_key: SigningKeyPair,
    pub github_app: Option<LoadedGitHubApp>,
    pub gc: GcConfig,
    pub owners_by_name: HashMap<String, LoadedOwner>,
    pub owner_name_by_github_id: HashMap<u64, String>,
}

impl LoadedConfig {
    pub fn from_config(raw: Config) -> Result<Self> {
        if raw.owners.is_empty() {
            bail!("configuration must define at least one [[owners]] entry");
        }

        let public_base_url = raw.public_base_url.trim_end_matches('/').to_owned();
        if public_base_url.is_empty() {
            bail!("public_base_url must not be empty");
        }

        let main_key = read_signing_key(&raw.main_signing_key_file, "main")?;
        let pr_key = read_signing_key(&raw.pr_signing_key_file, "PR")?;
        if main_key.public_string() == pr_key.public_string() {
            bail!("main_signing_key_file and pr_signing_key_file must use distinct signing keys");
        }

        let github_app = match raw.github_app {
            Some(app) => Some(load_github_app(app)?),
            None => None,
        };

        let mut owners_by_name = HashMap::with_capacity(raw.owners.len());
        let mut owner_name_by_github_id = HashMap::with_capacity(raw.owners.len());

        for owner in raw.owners {
            if owners_by_name.contains_key(&owner.name) {
                bail!("duplicate owner name '{}'", owner.name);
            }
            if owner_name_by_github_id.contains_key(&owner.github_owner_id) {
                bail!("duplicate github_owner_id {}", owner.github_owner_id);
            }

            let github_owner_id = owner.github_owner_id;
            let loaded = load_owner(owner)?;
            owner_name_by_github_id.insert(github_owner_id, loaded.name.clone());
            owners_by_name.insert(loaded.name.clone(), loaded);
        }

        Ok(Self {
            listen: raw.listen,
            database_path: raw.database_path,
            public_base_url,
            main_key,
            pr_key,
            github_app,
            gc: raw.gc,
            owners_by_name,
            owner_name_by_github_id,
        })
    }

    pub fn from_file(path: &Path) -> Result<Self> {
        let content = fs::read_to_string(path)
            .with_context(|| format!("failed to read config file {}", path.display()))?;
        let raw: Config = toml::from_str(&content)
            .with_context(|| format!("failed to parse TOML config {}", path.display()))?;

        Self::from_config(raw)
    }

    #[must_use]
    pub fn owner_by_name(&self, name: &str) -> Option<&LoadedOwner> {
        self.owners_by_name.get(name)
    }

    #[must_use]
    pub fn owner_by_github_id(&self, github_owner_id: u64) -> Option<&LoadedOwner> {
        let name = self.owner_name_by_github_id.get(&github_owner_id)?;

        self.owners_by_name.get(name)
    }
}
