use std::collections::HashMap;
use std::fs;
use std::io::{self, BufRead, Write};
use std::process::Stdio;
use std::sync::Arc;

use anyhow::{Context, Result, bail};
use clap::Args;
use reqwest::Client;
use reqwest::header::AUTHORIZATION;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::io::AsyncReadExt;
use tokio::process::Command;
use tokio::sync::Semaphore;
use tracing::{debug, info};

use crate::nix_format::{format_sha256_nixbase32, normalize_references, store_hash_from_path};
use crate::oci::OciClient;
use crate::protocol::{CommitEntry, CommitRequest, CommitResponse, PlanRequest, PlanResponse};

#[derive(Args)]
pub struct PushArgs {
    /// Base URL of the Firn server (e.g. https://cache.so1ve.dev)
    #[arg(long, env = "FIRN_SERVER")]
    server: String,

    /// GitHub owner name (optional unless needed to disambiguate a shared
    /// manual token)
    #[arg(long, env = "FIRN_OWNER")]
    owner: Option<String>,

    /// Static Bearer token for manual pushes (omit in GitHub Actions to use
    /// OIDC)
    #[arg(long, env = "FIRN_TOKEN")]
    token: Option<String>,

    /// Read newline-separated store paths from standard input
    #[arg(long)]
    stdin: bool,

    /// Upload even paths already signed by skipped upstream caches
    #[arg(long)]
    include_upstream: bool,

    /// Signature key prefixes to skip (repeatable)
    #[arg(long, default_values = ["cache.nixos.org-1:"])]
    skip_signed_by: Vec<String>,

    /// Number of concurrent NAR uploads
    #[arg(long, default_value_t = 4)]
    jobs: usize,

    /// Zstandard compression level (1-19)
    #[arg(long, default_value_t = 3)]
    zstd_level: i32,

    /// Nix store paths or GC root symlinks (e.g. ./result)
    #[arg(value_name = "PATH")]
    paths: Vec<String>,
}

#[derive(Debug, Clone)]
struct NixPathInfo {
    path: String,
    store_hash: String,
    nar_size: u64,
    deriver: Option<String>,
    references: Vec<String>,
    signatures: Vec<String>,
}

enum AuthMode {
    Manual { bearer: String },
    Oidc { jwt: String, github_token: String },
}

struct DumpedNar {
    compressed: Vec<u8>,
    nar_sha256: [u8; 32],
    nar_size: u64,
    file_sha256: [u8; 32],
}

#[derive(Deserialize)]
struct OidcResponse {
    value: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawPathInfo {
    #[serde(default)]
    path: Option<String>,
    nar_size: u64,
    #[serde(default)]
    deriver: Option<String>,
    #[serde(default)]
    references: Vec<String>,
    #[serde(default)]
    signatures: Vec<String>,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum PathInfoOutput {
    Map(HashMap<String, Option<RawPathInfo>>),
    List(Vec<RawPathInfo>),
}

fn convert_raw_path_info(path: String, raw: RawPathInfo) -> Result<NixPathInfo> {
    let store_hash = store_hash_from_path(&path)?.to_owned();
    let references = normalize_references(&raw.references)?;

    Ok(NixPathInfo {
        path,
        store_hash,
        nar_size: raw.nar_size,
        deriver: raw.deriver,
        references,
        signatures: raw.signatures,
    })
}

fn parse_nix_path_info_json(bytes: &[u8]) -> Result<Vec<NixPathInfo>> {
    let parsed: PathInfoOutput =
        serde_json::from_slice(bytes).context("failed to parse `nix path-info --json` output")?;
    let mut results = Vec::new();

    match parsed {
        PathInfoOutput::Map(map) => {
            for (path, entry) in map {
                if let Some(raw) = entry {
                    results.push(convert_raw_path_info(path, raw)?);
                }
            }
        }
        PathInfoOutput::List(items) => {
            for raw in items {
                let Some(path) = raw.path.clone() else {
                    bail!("path-info array item missing `path` field");
                };
                results.push(convert_raw_path_info(path, raw)?);
            }
        }
    }

    results.sort_by(|a, b| a.path.cmp(&b.path));

    Ok(results)
}

async fn query_nix_closure(paths: &[String]) -> Result<Vec<NixPathInfo>> {
    let output = Command::new("nix")
        .args(["path-info", "--json", "--recursive"])
        .args(paths)
        .output()
        .await
        .context("failed to run `nix path-info --json --recursive`")?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        bail!("nix path-info failed ({}): {stderr}", output.status);
    }

    parse_nix_path_info_json(&output.stdout)
}

fn collect_input_paths(args: &PushArgs) -> Result<Vec<String>> {
    let mut paths = args.paths.clone();

    if args.stdin {
        for line in io::stdin().lock().lines() {
            let line = line.context("failed to read store path from stdin")?;
            let trimmed = line.trim();
            if !trimmed.is_empty() {
                paths.push(trimmed.to_owned());
            }
        }
    }

    let mut resolved = Vec::with_capacity(paths.len());
    for raw in paths {
        let canonical = fs::canonicalize(&raw)
            .with_context(|| format!("failed to resolve store path '{raw}'"))?;
        let Some(text) = canonical.to_str() else {
            bail!("non-UTF-8 store path {}", canonical.display());
        };
        resolved.push(text.to_owned());
    }

    resolved.sort();
    resolved.dedup();

    Ok(resolved)
}

async fn resolve_auth(http: &Client, server_url: &str, args: &PushArgs) -> Result<AuthMode> {
    if let Some(token) = &args.token {
        return Ok(AuthMode::Manual {
            bearer: token.clone(),
        });
    }

    let oidc_url = std::env::var("ACTIONS_ID_TOKEN_REQUEST_URL").ok();
    let oidc_token = std::env::var("ACTIONS_ID_TOKEN_REQUEST_TOKEN").ok();
    let (Some(request_url), Some(request_token)) = (oidc_url, oidc_token) else {
        bail!(
            "no authentication credentials found: pass --token / FIRN_TOKEN for manual push, or run in GitHub Actions with `id-token: write`"
        );
    };

    let Ok(github_token) = std::env::var("GITHUB_TOKEN") else {
        bail!("GITHUB_TOKEN (with packages: write) is required for GitHub Actions OIDC push");
    };

    let separator = if request_url.contains('?') { '&' } else { '?' };
    let full_url = format!("{request_url}{separator}audience={server_url}");
    let resp = http
        .get(&full_url)
        .header(AUTHORIZATION, format!("Bearer {request_token}"))
        .send()
        .await
        .context("failed to request GitHub Actions OIDC token")?;
    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        bail!("GitHub Actions OIDC token request failed ({status}): {body}");
    }

    let payload: OidcResponse = resp
        .json()
        .await
        .context("failed to parse GitHub Actions OIDC response")?;

    Ok(AuthMode::Oidc {
        jwt: payload.value,
        github_token,
    })
}

async fn post_json<Req: Serialize + Sync, Resp: DeserializeOwned>(
    http: &Client,
    url: &str,
    bearer: &str,
    body: &Req,
) -> Result<Resp> {
    let response = http
        .post(url)
        .header(AUTHORIZATION, format!("Bearer {bearer}"))
        .json(body)
        .send()
        .await
        .with_context(|| format!("failed to contact {url}"))?;
    let status = response.status();
    if !status.is_success() {
        let text = response.text().await.unwrap_or_default();
        bail!("request to {url} failed ({status}): {text}");
    }

    response
        .json()
        .await
        .with_context(|| format!("failed to parse JSON response from {url}"))
}

async fn dump_and_compress_nar(store_path: &str, zstd_level: i32) -> Result<DumpedNar> {
    let mut child = Command::new("nix-store")
        .args(["--dump", store_path])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .with_context(|| format!("failed to spawn nix-store --dump {store_path}"))?;

    let mut stdout = child.stdout.take().unwrap();
    let mut encoder = zstd::stream::write::Encoder::new(Vec::new(), zstd_level)
        .context("failed to initialize zstd encoder")?;
    let mut nar_hasher = Sha256::new();
    let mut nar_size = 0u64;
    let mut buf = vec![0u8; 64 * 1024];

    loop {
        let read = stdout
            .read(&mut buf)
            .await
            .context("failed to read nix-store --dump output")?;
        if read == 0 {
            break;
        }
        let chunk = &buf[..read];
        nar_hasher.update(chunk);
        nar_size += read as u64;
        encoder.write_all(chunk)?;
    }

    let status = child
        .wait()
        .await
        .context("failed to wait for nix-store --dump")?;
    if !status.success() {
        bail!("nix-store --dump {store_path} exited with {status}");
    }

    let compressed = encoder.finish()?;
    let nar_sha256: [u8; 32] = nar_hasher.finalize().into();
    let file_sha256: [u8; 32] = Sha256::digest(&compressed).into();

    Ok(DumpedNar {
        compressed,
        nar_sha256,
        nar_size,
        file_sha256,
    })
}

async fn upload_single_path(
    oci: &OciClient,
    repository: &str,
    push_token: &str,
    info: &NixPathInfo,
    zstd_level: i32,
) -> Result<CommitEntry> {
    let dumped = dump_and_compress_nar(&info.path, zstd_level).await?;
    if dumped.nar_size != info.nar_size {
        bail!(
            "NAR size mismatch for {}: nix path-info reported {}, dump produced {}",
            info.path,
            info.nar_size,
            dumped.nar_size
        );
    }

    let file_size = dumped.compressed.len() as u64;
    let blob_digest = hex::encode(dumped.file_sha256);
    let manifest_digest = oci
        .upload_nar_blob(repository, push_token, dumped.compressed, &blob_digest)
        .await
        .with_context(|| format!("failed to upload {} to {repository}", info.path))?;
    debug!(
        store_path = %info.path,
        nar_size = dumped.nar_size,
        file_size,
        manifest = %manifest_digest,
        "uploaded compressed NAR blob"
    );

    Ok(CommitEntry {
        store_path: info.path.clone(),
        nar_hash: format_sha256_nixbase32(&dumped.nar_sha256),
        nar_size: dumped.nar_size,
        file_hash: format_sha256_nixbase32(&dumped.file_sha256),
        file_size,
        manifest_digest,
        blob_digest,
        deriver: info.deriver.clone(),
        references: info.references.clone(),
    })
}

async fn upload_missing_paths(
    oci: Arc<OciClient>,
    repository: &str,
    push_token: &str,
    candidates: &[NixPathInfo],
    missing: Vec<String>,
    jobs: usize,
    zstd_level: i32,
) -> Result<Vec<CommitEntry>> {
    let by_hash: HashMap<&str, &NixPathInfo> = candidates
        .iter()
        .map(|item| (item.store_hash.as_str(), item))
        .collect();
    let semaphore = Arc::new(Semaphore::new(jobs));
    let mut handles = Vec::with_capacity(missing.len());

    for hash in missing {
        let Some(&info_ref) = by_hash.get(hash.as_str()) else {
            continue;
        };
        let path_info = info_ref.clone();
        let permit = Arc::clone(&semaphore).acquire_owned().await.unwrap();
        let oci_client = Arc::clone(&oci);
        let repo = repository.to_owned();
        let token = push_token.to_owned();

        handles.push(tokio::spawn(async move {
            let _permit = permit;

            upload_single_path(&oci_client, &repo, &token, &path_info, zstd_level).await
        }));
    }

    let mut entries = Vec::with_capacity(handles.len());
    for handle in handles {
        entries.push(handle.await.unwrap()?);
    }

    Ok(entries)
}

pub async fn run(args: PushArgs) -> Result<()> {
    let raw_paths = collect_input_paths(&args)?;
    if raw_paths.is_empty() {
        info!("no store paths provided; nothing to push");

        return Ok(());
    }

    let candidates: Vec<NixPathInfo> = query_nix_closure(&raw_paths)
        .await?
        .into_iter()
        .filter(|item| {
            args.include_upstream
                || !item.signatures.iter().any(|sig| {
                    args.skip_signed_by
                        .iter()
                        .any(|prefix| sig.starts_with(prefix))
                })
        })
        .collect();
    if candidates.is_empty() {
        info!("all store paths are already signed by skipped upstream keys; nothing to push");

        return Ok(());
    }

    let server_url = args.server.trim_end_matches('/');
    let http = Client::builder()
        .user_agent(concat!("firn/", env!("CARGO_PKG_VERSION")))
        .build()
        .unwrap();

    let auth = resolve_auth(&http, server_url, &args).await?;
    let auth_token = match &auth {
        AuthMode::Manual { bearer } => bearer.as_str(),
        AuthMode::Oidc { jwt, .. } => jwt.as_str(),
    };

    let plan: PlanResponse = post_json(
        &http,
        &format!("{server_url}/api/v1/uploads/plan"),
        auth_token,
        &PlanRequest {
            owner: args.owner.clone(),
            store_paths: candidates.iter().map(|item| item.path.clone()).collect(),
        },
    )
    .await?;

    if plan.missing.is_empty() {
        info!(
            owner = %plan.owner,
            scope = %plan.scope,
            "all {} store paths are already cached",
            candidates.len()
        );

        return Ok(());
    }

    info!(
        owner = %plan.owner,
        scope = %plan.scope,
        repository = %plan.ghcr_repository,
        missing = plan.missing.len(),
        total = candidates.len(),
        "uploading missing store paths"
    );

    let oci = Arc::new(OciClient::new(&plan.registry)?);
    let push_token = match (&auth, plan.ghcr_token) {
        (_, Some(token)) => token,
        (AuthMode::Oidc { github_token, .. }, None) => {
            oci.exchange_token(
                &plan.ghcr_repository,
                "pull,push",
                Some(("x-access-token", github_token)),
            )
            .await?
        }
        (AuthMode::Manual { .. }, None) => {
            bail!("server did not return a scoped GHCR upload token for manual push")
        }
    };

    let entries = upload_missing_paths(
        oci,
        &plan.ghcr_repository,
        &push_token,
        &candidates,
        plan.missing,
        args.jobs.max(1),
        args.zstd_level,
    )
    .await?;

    let committed: CommitResponse = post_json(
        &http,
        &format!("{server_url}/api/v1/uploads/commit"),
        auth_token,
        &CommitRequest {
            owner: args.owner,
            entries,
        },
    )
    .await?;

    println!(
        "Committed {} store paths to {} (scope={}, owner={})",
        committed.committed, server_url, committed.scope, committed.owner
    );

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_modern_map_and_legacy_array_path_info() {
        let modern = br#"{
          "/nix/store/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-foo": {
            "narHash": "sha256-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=",
            "narSize": 128,
            "references": ["/nix/store/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb-bar"],
            "signatures": ["cache.nixos.org-1:abc"]
          }
        }"#;
        let parsed = parse_nix_path_info_json(modern).unwrap();
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].store_hash, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
        assert_eq!(
            parsed[0].references,
            vec!["bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb-bar"]
        );

        let legacy = br#"[{
          "path": "/nix/store/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-foo",
          "narSize": 128,
          "references": [],
          "signatures": []
        }]"#;
        let parsed_legacy = parse_nix_path_info_json(legacy).unwrap();
        assert_eq!(parsed_legacy.len(), 1);
        assert_eq!(parsed_legacy[0].nar_size, 128);
    }
}
