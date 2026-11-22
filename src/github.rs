use std::collections::HashMap;
use std::time::{Duration, Instant};

use anyhow::{Context, Result, bail};
use hmac::{Hmac, KeyInit, Mac};
use jsonwebtoken::jwk::JwkSet;
use jsonwebtoken::{
    Algorithm, DecodingKey, EncodingKey, Header, Validation, decode, decode_header, encode,
};
use reqwest::header::{ACCEPT, AUTHORIZATION};
use reqwest::{Client, Method, RequestBuilder, StatusCode};
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use subtle::ConstantTimeEq;
use tokio::sync::RwLock;
use tracing::{debug, info};

use crate::config::{LoadedConfig, OwnerType};
use crate::nix_format::unix_now;

type HmacSha256 = Hmac<Sha256>;

struct CachedJwks {
    jwks: JwkSet,
    fetched_at: Instant,
}

struct CachedInstallationToken {
    token: String,
    expires_at: Instant,
}

#[derive(Debug, Serialize)]
struct AppJwtClaims {
    iat: u64,
    exp: u64,
    iss: String,
}

#[derive(Debug, Deserialize)]
struct InstallationTokenResponse {
    token: String,
}

#[derive(Debug, Deserialize)]
struct PackageVersion {
    id: u64,
    name: String,
}

fn is_last_version_rejection(status: StatusCode, body: &str) -> bool {
    status == StatusCode::BAD_REQUEST && body.to_ascii_lowercase().contains("last version")
}

fn is_download_threshold_rejection(status: StatusCode, body: &str) -> bool {
    if !matches!(
        status,
        StatusCode::BAD_REQUEST | StatusCode::FORBIDDEN | StatusCode::UNPROCESSABLE_ENTITY
    ) {
        return false;
    }
    let lower = body.to_ascii_lowercase();

    lower.contains("5000") || lower.contains("5,000") || lower.contains("public package")
}

#[derive(Debug, Clone, Deserialize)]
pub struct OidcClaims {
    pub repository_owner_id: String,
    pub repository: String,
    #[serde(rename = "ref")]
    pub ref_name: String,
    pub event_name: String,
}

impl OidcClaims {
    pub fn owner_id(&self) -> Result<u64> {
        self.repository_owner_id
            .parse::<u64>()
            .with_context(|| format!("invalid repository_owner_id '{}'", self.repository_owner_id))
    }

    pub fn repo_name(&self) -> Result<&str> {
        let Some((_owner, repo)) = self.repository.split_once('/') else {
            bail!("invalid OIDC repository claim '{}'", self.repository);
        };
        if repo.is_empty() || repo.contains('/') {
            bail!("invalid OIDC repository name in '{}'", self.repository);
        }

        Ok(repo)
    }

    #[must_use]
    pub fn pull_request_number(&self) -> Option<u64> {
        let rest = self.ref_name.strip_prefix("refs/pull/")?;
        let num = rest.strip_suffix("/merge")?;

        num.parse::<u64>().ok()
    }
}

pub struct OidcVerifier {
    http: Client,
    issuer: String,
    audience: String,
    jwks: RwLock<Option<CachedJwks>>,
}

impl OidcVerifier {
    pub fn new(issuer: &str, audience: &str) -> Self {
        let http = Client::builder()
            .user_agent(concat!("firn/", env!("CARGO_PKG_VERSION")))
            .timeout(Duration::from_secs(15))
            .build()
            .unwrap();

        Self {
            http,
            issuer: issuer.trim_end_matches('/').to_owned(),
            audience: audience.to_owned(),
            jwks: RwLock::new(None),
        }
    }

    async fn fetch_jwks(&self) -> Result<JwkSet> {
        let url = format!("{}/.well-known/jwks", self.issuer);
        let response = self
            .http
            .get(&url)
            .send()
            .await
            .with_context(|| format!("failed to fetch OIDC JWKS from {url}"))?;
        let status = response.status();
        if !status.is_success() {
            bail!("OIDC JWKS request to {url} failed with status {status}");
        }

        response
            .json::<JwkSet>()
            .await
            .context("failed to parse OIDC JWKS JSON")
    }

    async fn find_cached_key(&self, kid: &str) -> Result<Option<DecodingKey>> {
        let guard = self.jwks.read().await;
        let Some(cached) = guard.as_ref() else {
            return Ok(None);
        };
        if cached.fetched_at.elapsed() > Duration::from_secs(3600) {
            return Ok(None);
        }
        let Some(jwk) = cached.jwks.find(kid) else {
            return Ok(None);
        };

        Ok(Some(
            DecodingKey::from_jwk(jwk).context("failed to construct DecodingKey from JWK")?,
        ))
    }

    async fn decoding_key_for_kid(&self, kid: &str) -> Result<DecodingKey> {
        if let Some(key) = self.find_cached_key(kid).await? {
            return Ok(key);
        }

        let jwks = self.fetch_jwks().await?;
        debug!(issuer = %self.issuer, kid, "refreshed OIDC JWKS cache");
        let found = jwks.find(kid).cloned();
        *self.jwks.write().await = Some(CachedJwks {
            jwks,
            fetched_at: Instant::now(),
        });

        let Some(jwk) = found else {
            bail!("no OIDC JWK found for kid '{kid}'");
        };

        DecodingKey::from_jwk(&jwk).context("failed to construct DecodingKey from JWK")
    }

    pub async fn verify(&self, token: &str) -> Result<OidcClaims> {
        let header = decode_header(token).context("failed to decode OIDC JWT header")?;
        if header.alg != Algorithm::RS256 {
            bail!("unsupported OIDC JWT algorithm {:?}", header.alg);
        }
        let Some(kid) = header.kid else {
            bail!("OIDC JWT header missing kid");
        };

        let key = self.decoding_key_for_kid(&kid).await?;

        let mut validation = Validation::new(Algorithm::RS256);
        validation.set_issuer(&[&self.issuer]);
        validation.set_audience(&[&self.audience]);
        validation.validate_exp = true;

        let decoded = decode::<OidcClaims>(token, &key, &validation)
            .context("OIDC JWT signature or claims validation failed")?;

        Ok(decoded.claims)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DeleteOutcome {
    Deleted,
    NotFound,
    /// GitHub permanently refuses deletion (e.g. public package version exceeds
    /// 5,000 downloads).
    Protected(String),
}

pub struct GitHubAppClient {
    app_id: u64,
    encoding_key: EncodingKey,
    api_url: String,
    http: Client,
    tokens: RwLock<HashMap<u64, CachedInstallationToken>>,
}

impl GitHubAppClient {
    fn github_request(&self, method: Method, url: &str, bearer: &str) -> RequestBuilder {
        self.http
            .request(method, url)
            .header(AUTHORIZATION, format!("Bearer {bearer}"))
            .header(ACCEPT, "application/vnd.github+json")
            .header("X-GitHub-Api-Version", "2022-11-28")
    }

    fn issue_app_jwt(&self) -> Result<String> {
        let now = unix_now() as u64;
        let claims = AppJwtClaims {
            iat: now.saturating_sub(60),
            exp: now + 9 * 60,
            iss: self.app_id.to_string(),
        };

        encode(&Header::new(Algorithm::RS256), &claims, &self.encoding_key)
            .context("failed to sign GitHub App JWT")
    }

    async fn find_version_id(
        &self,
        versions_url: &str,
        token: &str,
        manifest_digest: &str,
    ) -> Result<Option<u64>> {
        for page in 1u32.. {
            let url = format!("{versions_url}?per_page=100&page={page}");
            let response = self
                .github_request(Method::GET, &url, token)
                .send()
                .await
                .with_context(|| format!("failed to list GHCR versions from {url}"))?;

            if response.status() == StatusCode::NOT_FOUND {
                return Ok(None);
            }
            if !response.status().is_success() {
                let status = response.status();
                let body = response.text().await.unwrap_or_default();
                bail!("failed to list GHCR versions at {url} ({status}): {body}");
            }

            let versions: Vec<PackageVersion> = response
                .json()
                .await
                .context("failed to parse GitHub package versions JSON")?;
            if let Some(found) = versions
                .iter()
                .find(|version| version.name == manifest_digest)
            {
                return Ok(Some(found.id));
            }
            if versions.len() < 100 {
                return Ok(None);
            }
        }

        Ok(None)
    }

    async fn delete_package(&self, package_url: &str, token: &str) -> Result<DeleteOutcome> {
        let response = self
            .github_request(Method::DELETE, package_url, token)
            .send()
            .await
            .with_context(|| format!("failed to delete GHCR package {package_url}"))?;

        let status = response.status();
        if status == StatusCode::NOT_FOUND {
            return Ok(DeleteOutcome::NotFound);
        }
        if status.is_success() {
            return Ok(DeleteOutcome::Deleted);
        }

        let body = response.text().await.unwrap_or_default();
        if is_download_threshold_rejection(status, &body) {
            return Ok(DeleteOutcome::Protected(body));
        }

        bail!("failed to delete GHCR package {package_url} ({status}): {body}")
    }

    pub fn new(app_id: u64, private_key_pem: &[u8], api_url: &str) -> Result<Self> {
        let encoding_key = EncodingKey::from_rsa_pem(private_key_pem)
            .context("failed to parse GitHub App RSA private key PEM")?;
        let http = Client::builder()
            .user_agent(concat!("firn/", env!("CARGO_PKG_VERSION")))
            .timeout(Duration::from_secs(30))
            .build()
            .unwrap();

        Ok(Self {
            app_id,
            encoding_key,
            api_url: api_url.trim_end_matches('/').to_owned(),
            http,
            tokens: RwLock::new(HashMap::new()),
        })
    }

    pub fn from_config(config: &LoadedConfig, api_url: &str) -> Result<Option<Self>> {
        let Some(app) = &config.github_app else {
            return Ok(None);
        };

        Self::new(app.app_id, &app.private_key_pem, api_url).map(Some)
    }

    pub async fn installation_token(&self, installation_id: u64) -> Result<String> {
        {
            let guard = self.tokens.read().await;
            if let Some(cached) = guard.get(&installation_id)
                && cached.expires_at > Instant::now()
            {
                return Ok(cached.token.clone());
            }
        }

        let jwt = self.issue_app_jwt()?;
        let url = format!(
            "{}/app/installations/{installation_id}/access_tokens",
            self.api_url
        );
        let response = self
            .github_request(Method::POST, &url, &jwt)
            .send()
            .await
            .with_context(|| format!("failed to request GitHub installation token from {url}"))?;
        let status = response.status();
        if !status.is_success() {
            let body = response.text().await.unwrap_or_default();
            bail!(
                "GitHub installation token request for installation {installation_id} failed ({status}): {body}"
            );
        }

        let payload: InstallationTokenResponse = response
            .json()
            .await
            .context("failed to parse GitHub installation token response")?;
        self.tokens.write().await.insert(
            installation_id,
            CachedInstallationToken {
                token: payload.token.clone(),
                expires_at: Instant::now() + Duration::from_secs(45 * 60),
            },
        );

        Ok(payload.token)
    }

    pub async fn delete_ghcr_package_version(
        &self,
        owner: &str,
        owner_type: OwnerType,
        installation_id: u64,
        package: &str,
        manifest_digest: &str,
    ) -> Result<DeleteOutcome> {
        let token = self.installation_token(installation_id).await?;
        let scope_segment = match owner_type {
            OwnerType::User => "users",
            OwnerType::Org => "orgs",
        };
        let package_url = format!(
            "{}/{scope_segment}/{owner}/packages/container/{package}",
            self.api_url
        );
        let versions_url = format!("{package_url}/versions");

        let Some(version_id) = self
            .find_version_id(&versions_url, &token, manifest_digest)
            .await?
        else {
            return Ok(DeleteOutcome::NotFound);
        };

        let delete_url = format!("{versions_url}/{version_id}");
        let response = self
            .github_request(Method::DELETE, &delete_url, &token)
            .send()
            .await
            .with_context(|| format!("failed to delete GHCR version {delete_url}"))?;

        let status = response.status();
        if status == StatusCode::NOT_FOUND {
            return Ok(DeleteOutcome::NotFound);
        }
        if status.is_success() {
            return Ok(DeleteOutcome::Deleted);
        }

        let body = response.text().await.unwrap_or_default();
        if is_last_version_rejection(status, &body) {
            info!(
                owner,
                package,
                manifest = manifest_digest,
                "last GHCR version cannot be deleted individually; deleting empty package"
            );

            return self.delete_package(&package_url, &token).await;
        }
        if is_download_threshold_rejection(status, &body) {
            return Ok(DeleteOutcome::Protected(body));
        }

        bail!(
            "failed to delete GHCR version {version_id} ({manifest_digest}) for {owner}/{package} ({status}): {body}"
        )
    }
}

#[must_use]
pub fn verify_webhook_signature(secret: &[u8], header_value: &str, body: &[u8]) -> bool {
    let Some(expected_hex) = header_value.strip_prefix("sha256=") else {
        return false;
    };
    let Ok(expected) = hex::decode(expected_hex) else {
        return false;
    };
    let mut mac = HmacSha256::new_from_slice(secret).unwrap();
    mac.update(body);
    let computed = mac.finalize().into_bytes();

    computed.as_slice().ct_eq(expected.as_slice()).into()
}

#[must_use]
pub fn constant_time_token_matches(tokens: &[String], candidate: &str) -> bool {
    let candidate_bytes = candidate.as_bytes();
    let mut matched = false;
    for token in tokens {
        if bool::from(token.as_bytes().ct_eq(candidate_bytes)) {
            matched = true;
        }
    }

    matched
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn webhook_signature_verification() {
        let secret = b"top-secret";
        let body = br#"{"action":"closed"}"#;
        let mut mac = HmacSha256::new_from_slice(secret).unwrap();
        mac.update(body);
        let sig = format!("sha256={}", hex::encode(mac.finalize().into_bytes()));

        assert!(verify_webhook_signature(secret, &sig, body));
        assert!(!verify_webhook_signature(secret, &sig, b"tampered"));
        assert!(!verify_webhook_signature(b"wrong", &sig, body));
        assert!(!verify_webhook_signature(secret, "bad-prefix", body));
    }

    #[test]
    fn recognizes_github_ghcr_deletion_limits() {
        assert!(is_last_version_rejection(
            StatusCode::BAD_REQUEST,
            r#"{"message":"You cannot delete the last version of a package. You must delete the package instead."}"#
        ));
        assert!(is_download_threshold_rejection(
            StatusCode::BAD_REQUEST,
            r#"{"message":"You cannot delete a public package version that has more than 5000 downloads."}"#
        ));
        assert!(!is_download_threshold_rejection(
            StatusCode::INTERNAL_SERVER_ERROR,
            "server error"
        ));
    }
}
