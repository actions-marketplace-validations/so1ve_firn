use std::collections::HashMap;
use std::time::{Duration, Instant};

use anyhow::{Context, Result, bail};
use reqwest::header::{ACCEPT, AUTHORIZATION, CONTENT_LENGTH, CONTENT_TYPE, LOCATION};
use reqwest::{Client, Method, RequestBuilder, Response, StatusCode, Url, redirect};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::sync::RwLock;
use tracing::debug;

const EMPTY_CONFIG_BYTES: &[u8] = b"{}";
const EMPTY_CONFIG_DIGEST: &str =
    "sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a";
const OCI_MANIFEST_MEDIA_TYPE: &str = "application/vnd.oci.image.manifest.v1+json";
const OCI_EMPTY_CONFIG_MEDIA_TYPE: &str = "application/vnd.oci.empty.v1+json";
const FIRN_ARTIFACT_TYPE: &str = "application/vnd.firn.nar.v1";
const FIRN_NAR_ZSTD_MEDIA_TYPE: &str = "application/vnd.firn.nar.zstd.v1";

struct CachedToken {
    token: String,
    expires_at: Instant,
}

#[derive(Debug, Deserialize)]
struct TokenResponse {
    token: Option<String>,
    access_token: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OciDescriptor {
    media_type: String,
    digest: String,
    size: u64,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OciManifest {
    schema_version: u32,
    media_type: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    artifact_type: Option<String>,
    config: OciDescriptor,
    layers: Vec<OciDescriptor>,
}

pub struct OciClient {
    http: Client,
    no_redirect_http: Client,
    base_url: Url,
    registry_url: String,
    service: String,
    pull_tokens: RwLock<HashMap<String, CachedToken>>,
}

impl OciClient {
    fn resolve_location(&self, location: &str) -> Result<String> {
        let resolved = self
            .base_url
            .join(location)
            .with_context(|| format!("invalid OCI Location header '{location}'"))?;

        Ok(resolved.into())
    }

    pub async fn exchange_token(
        &self,
        repository: &str,
        actions: &str,
        basic_auth: Option<(&str, &str)>,
    ) -> Result<String> {
        let url = format!(
            "{}/token?service={}&scope=repository:{repository}:{actions}",
            self.registry_url, self.service
        );
        let mut request = self.http.get(&url);
        if let Some((username, password)) = basic_auth {
            request = request.basic_auth(username, Some(password));
        }

        let response = request
            .send()
            .await
            .with_context(|| format!("failed to request OCI token from {url}"))?;
        let status = response.status();
        if !status.is_success() {
            let body = response.text().await.unwrap_or_default();
            bail!("OCI token request for {repository} failed ({status}): {body}");
        }

        let payload: TokenResponse = response
            .json()
            .await
            .context("failed to parse OCI token JSON response")?;
        let Some(token) = payload.token.or(payload.access_token) else {
            bail!("OCI token response did not include a token");
        };
        if token.is_empty() {
            bail!("OCI token response returned an empty token");
        }

        Ok(token)
    }

    async fn get_pull_token(&self, repository: &str, force_refresh: bool) -> Result<String> {
        if !force_refresh {
            let guard = self.pull_tokens.read().await;
            if let Some(cached) = guard.get(repository)
                && cached.expires_at > Instant::now()
            {
                return Ok(cached.token.clone());
            }
        }

        let token = self.exchange_token(repository, "pull", None).await?;
        self.pull_tokens.write().await.insert(
            repository.to_owned(),
            CachedToken {
                token: token.clone(),
                expires_at: Instant::now() + Duration::from_secs(240),
            },
        );

        Ok(token)
    }

    async fn send_with_pull_token(
        &self,
        repository: &str,
        build: impl Fn(&str) -> RequestBuilder,
        label: &str,
    ) -> Result<(Response, String)> {
        let mut token = self.get_pull_token(repository, false).await?;
        let mut response = build(&token)
            .send()
            .await
            .with_context(|| format!("failed to {label}"))?;

        if response.status() == StatusCode::UNAUTHORIZED {
            debug!(
                repository,
                "OCI pull token expired; refreshing and retrying"
            );
            token = self.get_pull_token(repository, true).await?;
            response = build(&token)
                .send()
                .await
                .with_context(|| format!("failed to {label}"))?;
        }

        Ok((response, token))
    }

    async fn ensure_blob_uploaded(
        &self,
        repository: &str,
        push_token: &str,
        digest: &str,
        bytes: Vec<u8>,
    ) -> Result<()> {
        let head_url = format!("{}/v2/{repository}/blobs/{digest}", self.registry_url);
        let head = self
            .http
            .head(&head_url)
            .header(AUTHORIZATION, format!("Bearer {push_token}"))
            .send()
            .await
            .with_context(|| format!("failed to HEAD OCI blob {head_url}"))?;
        if head.status().is_success() {
            return Ok(());
        }

        let init_url = format!("{}/v2/{repository}/blobs/uploads/", self.registry_url);
        let init = self
            .http
            .post(&init_url)
            .header(AUTHORIZATION, format!("Bearer {push_token}"))
            .header(CONTENT_LENGTH, 0)
            .send()
            .await
            .with_context(|| format!("failed to start OCI blob upload {init_url}"))?;
        let init_status = init.status();
        if !init_status.is_success() {
            let body = init.text().await.unwrap_or_default();
            bail!("failed to start OCI blob upload for {repository} ({init_status}): {body}");
        }

        let Some(location) = init
            .headers()
            .get(LOCATION)
            .and_then(|value| value.to_str().ok())
        else {
            bail!("OCI upload init response missing Location header");
        };
        let resolved = self.resolve_location(location)?;
        let separator = if resolved.contains('?') { '&' } else { '?' };
        let put_url = format!("{resolved}{separator}digest={digest}");
        let len = bytes.len();

        let put = self
            .http
            .put(&put_url)
            .header(AUTHORIZATION, format!("Bearer {push_token}"))
            .header(CONTENT_TYPE, "application/octet-stream")
            .header(CONTENT_LENGTH, len)
            .body(bytes)
            .send()
            .await
            .with_context(|| format!("failed to upload OCI blob {digest}"))?;
        let put_status = put.status();
        if !put_status.is_success() {
            let body = put.text().await.unwrap_or_default();
            bail!("failed to upload OCI blob {digest} to {repository} ({put_status}): {body}");
        }

        Ok(())
    }

    pub fn new(registry_url: &str) -> Result<Self> {
        let trimmed = registry_url.trim_end_matches('/');
        let base_url =
            Url::parse(trimmed).with_context(|| format!("invalid registry URL '{trimmed}'"))?;
        let Some(host) = base_url.host_str() else {
            bail!("registry URL '{trimmed}' has no host");
        };
        let service = match base_url.port() {
            Some(port) => format!("{host}:{port}"),
            None => host.to_owned(),
        };

        let http = Client::builder()
            .user_agent(concat!("firn/", env!("CARGO_PKG_VERSION")))
            .timeout(Duration::from_secs(300))
            .build()
            .unwrap();
        let no_redirect_http = Client::builder()
            .user_agent(concat!("firn/", env!("CARGO_PKG_VERSION")))
            .redirect(redirect::Policy::none())
            .timeout(Duration::from_secs(30))
            .build()
            .unwrap();

        Ok(Self {
            http,
            no_redirect_http,
            base_url,
            registry_url: trimmed.to_owned(),
            service,
            pull_tokens: RwLock::new(HashMap::new()),
        })
    }

    pub async fn verify_manifest_and_blob(
        &self,
        repository: &str,
        manifest_digest: &str,
        blob_digest_hex: &str,
        expected_size: u64,
    ) -> Result<()> {
        let expected_layer_digest = format!("sha256:{blob_digest_hex}");
        let manifest_url = format!(
            "{}/v2/{repository}/manifests/{manifest_digest}",
            self.registry_url
        );
        let blob_url = format!(
            "{}/v2/{repository}/blobs/{expected_layer_digest}",
            self.registry_url
        );

        let (manifest_resp, token) = self
            .send_with_pull_token(
                repository,
                |tok| {
                    self.http
                        .request(Method::GET, &manifest_url)
                        .header(AUTHORIZATION, format!("Bearer {tok}"))
                        .header(ACCEPT, OCI_MANIFEST_MEDIA_TYPE)
                },
                &format!("fetch manifest {manifest_url}"),
            )
            .await?;

        if !manifest_resp.status().is_success() {
            bail!(
                "manifest {manifest_digest} not found in {repository} (status {})",
                manifest_resp.status()
            );
        }

        let manifest: OciManifest = manifest_resp
            .json()
            .await
            .context("failed to parse OCI manifest JSON")?;
        let has_layer = manifest
            .layers
            .iter()
            .any(|layer| layer.digest == expected_layer_digest && layer.size == expected_size);
        if !has_layer {
            bail!(
                "manifest {manifest_digest} in {repository} does not reference layer {expected_layer_digest} with size {expected_size}"
            );
        }

        let head_resp = self
            .http
            .head(&blob_url)
            .header(AUTHORIZATION, format!("Bearer {token}"))
            .send()
            .await
            .with_context(|| format!("failed to HEAD blob {blob_url}"))?;
        if !head_resp.status().is_success() {
            bail!(
                "blob {expected_layer_digest} not found in {repository} (status {})",
                head_resp.status()
            );
        }

        Ok(())
    }

    pub async fn resolve_blob_redirect(
        &self,
        repository: &str,
        blob_digest_hex: &str,
    ) -> Result<String> {
        let blob_url = format!(
            "{}/v2/{repository}/blobs/sha256:{blob_digest_hex}",
            self.registry_url
        );
        let (response, _) = self
            .send_with_pull_token(
                repository,
                |tok| {
                    self.no_redirect_http
                        .get(&blob_url)
                        .header(AUTHORIZATION, format!("Bearer {tok}"))
                },
                &format!("resolve blob {blob_url}"),
            )
            .await?;

        let status = response.status();
        if !status.is_redirection() {
            bail!(
                "expected redirect for blob sha256:{blob_digest_hex} in {repository}, got {status}"
            );
        }

        let Some(location) = response
            .headers()
            .get(LOCATION)
            .and_then(|value| value.to_str().ok())
        else {
            bail!("OCI redirect response missing Location header");
        };

        self.resolve_location(location)
    }

    pub async fn upload_nar_blob(
        &self,
        repository: &str,
        push_token: &str,
        file_bytes: Vec<u8>,
        file_sha256_hex: &str,
    ) -> Result<String> {
        let file_size = file_bytes.len() as u64;
        let layer_digest = format!("sha256:{file_sha256_hex}");

        self.ensure_blob_uploaded(
            repository,
            push_token,
            EMPTY_CONFIG_DIGEST,
            EMPTY_CONFIG_BYTES.to_vec(),
        )
        .await?;
        self.ensure_blob_uploaded(repository, push_token, &layer_digest, file_bytes)
            .await?;

        let manifest = OciManifest {
            schema_version: 2,
            media_type: OCI_MANIFEST_MEDIA_TYPE.to_owned(),
            artifact_type: Some(FIRN_ARTIFACT_TYPE.to_owned()),
            config: OciDescriptor {
                media_type: OCI_EMPTY_CONFIG_MEDIA_TYPE.to_owned(),
                digest: EMPTY_CONFIG_DIGEST.to_owned(),
                size: EMPTY_CONFIG_BYTES.len() as u64,
            },
            layers: vec![OciDescriptor {
                media_type: FIRN_NAR_ZSTD_MEDIA_TYPE.to_owned(),
                digest: layer_digest,
                size: file_size,
            }],
        };
        let manifest_bytes = serde_json::to_vec(&manifest).unwrap();
        let computed_digest = format!("sha256:{}", hex::encode(Sha256::digest(&manifest_bytes)));
        let manifest_url = format!(
            "{}/v2/{repository}/manifests/{computed_digest}",
            self.registry_url
        );

        let response = self
            .http
            .put(&manifest_url)
            .header(AUTHORIZATION, format!("Bearer {push_token}"))
            .header(CONTENT_TYPE, OCI_MANIFEST_MEDIA_TYPE)
            .body(manifest_bytes)
            .send()
            .await
            .with_context(|| format!("failed to push OCI manifest {manifest_url}"))?;

        let status = response.status();
        if !status.is_success() {
            let body = response.text().await.unwrap_or_default();
            bail!("OCI manifest push to {repository} failed ({status}): {body}");
        }

        if let Some(digest) = response
            .headers()
            .get("Docker-Content-Digest")
            .and_then(|value| value.to_str().ok())
            && !digest.is_empty()
        {
            return Ok(digest.to_owned());
        }

        Ok(computed_digest)
    }
}
