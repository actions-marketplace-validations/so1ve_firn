use axum::Json;
use axum::extract::State;
use axum::http::header::AUTHORIZATION;
use axum::http::{HeaderMap, StatusCode};
use tracing::{info, warn};

use super::{ApiError, AppState};
use crate::config::LoadedOwner;
use crate::db::{CommitRecord, MAIN_SCOPE, pr_scope};
use crate::github::constant_time_token_matches;
use crate::nix_format::{
    SigningKeyPair, fingerprint, normalize_references, store_hash_from_path, store_path_basename,
    unix_now, validate_sha256_hex, validate_sha256_nixbase32,
};
use crate::oci::OciClient;
use crate::protocol::{CommitEntry, CommitRequest, CommitResponse, PlanRequest, PlanResponse};

enum UploadScope {
    Main,
    Pr { repo: String, number: u64 },
}

impl UploadScope {
    fn as_db_scope(&self) -> String {
        match self {
            Self::Main => MAIN_SCOPE.to_owned(),
            Self::Pr { repo, number } => pr_scope(repo, *number),
        }
    }

    const fn pr_info(&self) -> Option<(&str, u64)> {
        match self {
            Self::Main => None,
            Self::Pr { repo, number } => Some((repo.as_str(), *number)),
        }
    }
}

struct AuthenticatedUpload<'a> {
    owner: &'a LoadedOwner,
    ghcr_package: String,
    scope: UploadScope,
    needs_ghcr_token: bool,
}

struct PreparedCommit {
    store_hash: String,
    store_path: String,
    nar_hash: String,
    nar_size: u64,
    file_hash: String,
    file_size: u64,
    manifest_digest: String,
    blob_digest: String,
    deriver: Option<String>,
    references: Vec<String>,
    signature: String,
}

fn extract_bearer_token(headers: &HeaderMap) -> Result<&str, ApiError> {
    let Some(token) = headers
        .get(AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .filter(|token| !token.is_empty())
    else {
        return Err(ApiError::new(
            StatusCode::UNAUTHORIZED,
            "missing or invalid Bearer Authorization header",
        ));
    };

    Ok(token)
}

async fn authenticate<'a>(
    state: &'a AppState,
    headers: &HeaderMap,
    requested_owner: Option<&str>,
) -> Result<AuthenticatedUpload<'a>, ApiError> {
    let token = extract_bearer_token(headers)?;

    if let Some(owner_name) = requested_owner
        && let Some(owner) = state.firn.config.owner_by_name(owner_name)
        && constant_time_token_matches(&owner.manual_tokens, token)
    {
        return Ok(AuthenticatedUpload {
            owner,
            ghcr_package: owner.manual_push_package.clone(),
            scope: UploadScope::Main,
            needs_ghcr_token: true,
        });
    }

    let claims = state.oidc.verify(token).await.map_err(|error| {
        warn!(error = %error, "OIDC authentication failed");

        ApiError::new(
            StatusCode::UNAUTHORIZED,
            format!("invalid credentials: {error}"),
        )
    })?;
    let owner_id = claims
        .owner_id()
        .map_err(|error| ApiError::new(StatusCode::UNAUTHORIZED, error.to_string()))?;
    let Some(owner) = state.firn.config.owner_by_github_id(owner_id) else {
        return Err(ApiError::new(
            StatusCode::FORBIDDEN,
            "GitHub owner is not configured",
        ));
    };

    if let Some(requested) = requested_owner
        && requested != owner.name
    {
        return Err(ApiError::new(
            StatusCode::FORBIDDEN,
            "requested owner does not match OIDC identity",
        ));
    }

    let repo_name = claims
        .repo_name()
        .map_err(|error| ApiError::new(StatusCode::FORBIDDEN, error.to_string()))?;
    if !owner.is_repo_allowed(repo_name) {
        return Err(ApiError::new(
            StatusCode::FORBIDDEN,
            format!(
                "repository '{repo_name}' is not allowed for owner '{}'",
                owner.name
            ),
        ));
    }

    let scope = match claims.event_name.as_str() {
        "pull_request_target" => {
            return Err(ApiError::new(
                StatusCode::FORBIDDEN,
                "pull_request_target is rejected to prevent fork PR cache poisoning",
            ));
        }
        "pull_request" => {
            let Some(number) = claims.pull_request_number() else {
                return Err(ApiError::new(
                    StatusCode::FORBIDDEN,
                    "pull_request event did not carry a refs/pull/<n>/merge ref",
                ));
            };

            UploadScope::Pr {
                repo: repo_name.to_owned(),
                number,
            }
        }
        _ => {
            if !owner.is_protected_ref(&claims.ref_name) {
                return Err(ApiError::new(
                    StatusCode::FORBIDDEN,
                    format!(
                        "ref '{}' is not a protected ref for owner '{}'",
                        claims.ref_name, owner.name
                    ),
                ));
            }

            UploadScope::Main
        }
    };

    Ok(AuthenticatedUpload {
        ghcr_package: owner.ghcr_package_for_repo(repo_name),
        owner,
        scope,
        needs_ghcr_token: false,
    })
}

async fn issue_scoped_ghcr_token(
    state: &AppState,
    owner: &LoadedOwner,
    ghcr_repository: &str,
) -> Result<String, ApiError> {
    let Some(app) = state.firn.github_app.as_ref() else {
        return Err(ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "GitHub App is not configured for manual push token exchange",
        ));
    };
    let Some(installation_id) = owner.github_installation_id else {
        return Err(ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "owner has no github_installation_id configured",
        ));
    };

    let install_token = app
        .installation_token(installation_id)
        .await
        .map_err(ApiError::internal)?;

    state
        .oci
        .exchange_token(
            ghcr_repository,
            "pull,push",
            Some(("x-access-token", &install_token)),
        )
        .await
        .map_err(ApiError::internal)
}

async fn validate_and_sign(
    oci: &OciClient,
    ghcr_repository: &str,
    signing_key: &SigningKeyPair,
    entry: CommitEntry,
) -> Result<PreparedCommit, ApiError> {
    let bad_req = |error: anyhow::Error| ApiError::new(StatusCode::BAD_REQUEST, error.to_string());

    let store_hash = store_hash_from_path(&entry.store_path)
        .map_err(bad_req)?
        .to_owned();
    validate_sha256_hex(&entry.blob_digest).map_err(bad_req)?;
    let blob_digest = entry.blob_digest.to_ascii_lowercase();

    let Some(manifest_hex) = entry.manifest_digest.strip_prefix("sha256:") else {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "manifest_digest must start with 'sha256:'",
        ));
    };
    validate_sha256_hex(manifest_hex).map_err(bad_req)?;
    let manifest_digest = format!("sha256:{}", manifest_hex.to_ascii_lowercase());

    validate_sha256_nixbase32(&entry.nar_hash).map_err(bad_req)?;
    validate_sha256_nixbase32(&entry.file_hash).map_err(bad_req)?;
    let references = normalize_references(&entry.references).map_err(bad_req)?;

    let deriver = match entry.deriver {
        Some(raw) if !raw.is_empty() => {
            if raw.starts_with("/nix/store/") {
                Some(store_path_basename(&raw).map_err(bad_req)?.to_owned())
            } else {
                Some(raw)
            }
        }
        _ => None,
    };

    oci.verify_manifest_and_blob(
        ghcr_repository,
        &manifest_digest,
        &blob_digest,
        entry.file_size,
    )
    .await
    .map_err(|error| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            format!("GHCR verification failed: {error}"),
        )
    })?;

    let fp = fingerprint(
        &entry.store_path,
        &entry.nar_hash,
        entry.nar_size,
        &references,
    );
    let signature = signing_key.sign_fingerprint(&fp);

    Ok(PreparedCommit {
        store_hash,
        store_path: entry.store_path,
        nar_hash: entry.nar_hash,
        nar_size: entry.nar_size,
        file_hash: entry.file_hash,
        file_size: entry.file_size,
        manifest_digest,
        blob_digest,
        deriver,
        references,
        signature,
    })
}

pub(super) async fn plan(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<PlanRequest>,
) -> Result<Json<PlanResponse>, ApiError> {
    let auth = authenticate(&state, &headers, request.owner.as_deref()).await?;

    let mut hashes = Vec::with_capacity(request.store_paths.len());
    for store_path in &request.store_paths {
        let hash = store_hash_from_path(store_path)
            .map_err(|error| ApiError::new(StatusCode::BAD_REQUEST, error.to_string()))?;
        hashes.push(hash.to_owned());
    }

    let scope = auth.scope.as_db_scope();
    let existing = state
        .firn
        .db
        .existing_store_hashes(&auth.owner.name, &scope, &hashes)
        .map_err(ApiError::internal)?;
    let total = hashes.len();
    let missing: Vec<String> = hashes
        .into_iter()
        .filter(|hash| !existing.contains(hash))
        .collect();

    let ghcr_repository = auth.owner.ghcr_repository(&auth.ghcr_package);
    let ghcr_token = if auth.needs_ghcr_token {
        Some(issue_scoped_ghcr_token(&state, auth.owner, &ghcr_repository).await?)
    } else {
        None
    };

    info!(
        owner = %auth.owner.name,
        scope = %scope,
        repository = %ghcr_repository,
        total,
        missing = missing.len(),
        manual = auth.needs_ghcr_token,
        "planned cache upload"
    );

    Ok(Json(PlanResponse {
        owner: auth.owner.name.clone(),
        scope,
        registry: state.registry_url.clone(),
        ghcr_repository,
        ghcr_token,
        missing,
    }))
}

pub(super) async fn commit(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<CommitRequest>,
) -> Result<Json<CommitResponse>, ApiError> {
    let auth = authenticate(&state, &headers, request.owner.as_deref()).await?;
    let ghcr_repository = auth.owner.ghcr_repository(&auth.ghcr_package);
    let scope_str = auth.scope.as_db_scope();
    let signing_key = match auth.scope {
        UploadScope::Main => &auth.owner.main_key,
        UploadScope::Pr { .. } => &auth.owner.pr_key,
    };

    let mut prepared = Vec::with_capacity(request.entries.len());
    for entry in request.entries {
        prepared.push(validate_and_sign(&state.oci, &ghcr_repository, signing_key, entry).await?);
    }

    let now = unix_now();
    let pr_info = auth.scope.pr_info();
    let records: Vec<CommitRecord<'_>> = prepared
        .iter()
        .map(|item| CommitRecord {
            owner_id: &auth.owner.name,
            scope: &scope_str,
            pr_info,
            ghcr_package: &auth.ghcr_package,
            manifest_digest: &item.manifest_digest,
            blob_digest: &item.blob_digest,
            file_size: item.file_size,
            store_hash: &item.store_hash,
            store_path: &item.store_path,
            nar_hash: &item.nar_hash,
            nar_size: item.nar_size,
            file_hash: &item.file_hash,
            deriver: item.deriver.as_deref(),
            references: &item.references,
            signature: &item.signature,
            now,
        })
        .collect();

    let committed = state
        .firn
        .db
        .commit_entries(&records)
        .map_err(ApiError::internal)?;

    info!(
        owner = %auth.owner.name,
        scope = %scope_str,
        repository = %ghcr_repository,
        committed,
        "committed cache entries"
    );

    Ok(Json(CommitResponse {
        owner: auth.owner.name.clone(),
        scope: scope_str,
        committed,
    }))
}
