use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::http::header::{CONTENT_TYPE, LOCATION};
use axum::response::{IntoResponse, Response};
use tracing::debug;

use super::{ApiError, AppState};
use crate::config::CACHE_PRIORITY;
use crate::db::{MAIN_SCOPE, pr_scope};
use crate::nix_format::{render_nix_cache_info, validate_sha256_hex, validate_store_hash};

fn serve_cache_info() -> Response {
    let body = render_nix_cache_info(CACHE_PRIORITY);

    ([(CONTENT_TYPE, "text/x-nix-cache-info")], body).into_response()
}

fn ensure_owner_exists(state: &AppState, owner_name: &str) -> Result<(), ApiError> {
    if state.firn.config.owner_by_name(owner_name).is_none() {
        return Err(ApiError::new(StatusCode::NOT_FOUND, "unknown cache owner"));
    }

    Ok(())
}

fn serve_narinfo(state: &AppState, scope: &str, narinfo_file: &str) -> Result<Response, ApiError> {
    let Some(store_hash) = narinfo_file.strip_suffix(".narinfo") else {
        return Err(ApiError::new(StatusCode::NOT_FOUND, "not found"));
    };
    if validate_store_hash(store_hash).is_err() {
        return Err(ApiError::new(StatusCode::NOT_FOUND, "invalid store hash"));
    }

    let Some(stored) = state
        .firn
        .db
        .get_narinfo(scope, store_hash)
        .map_err(ApiError::internal)?
    else {
        return Err(ApiError::new(StatusCode::NOT_FOUND, "narinfo not found"));
    };

    let _ = state.access_tx.try_send(stored.id);
    debug!(scope, store_hash, "narinfo cache hit");

    Ok((
        [(CONTENT_TYPE, "text/x-nix-narinfo")],
        stored.to_narinfo().render(),
    )
        .into_response())
}

async fn serve_nar(state: &AppState, scope: &str, file_name: &str) -> Result<Response, ApiError> {
    let Some(digest_hex) = file_name.strip_suffix(".nar.zst") else {
        return Err(ApiError::new(StatusCode::NOT_FOUND, "invalid nar filename"));
    };
    if validate_sha256_hex(digest_hex).is_err() {
        return Err(ApiError::new(StatusCode::NOT_FOUND, "invalid nar digest"));
    }

    let Some(blob) = state
        .firn
        .db
        .get_blob_for_download(scope, digest_hex)
        .map_err(ApiError::internal)?
    else {
        return Err(ApiError::new(StatusCode::NOT_FOUND, "nar blob not found"));
    };

    let repo = format!(
        "{}/{}",
        blob.owner_id.to_ascii_lowercase(),
        blob.ghcr_package.to_ascii_lowercase()
    );
    let redirect_url = state
        .oci
        .resolve_blob_redirect(&repo, &blob.blob_digest)
        .await
        .map_err(ApiError::internal)?;
    debug!(
        owner = %blob.owner_id,
        scope,
        package = %blob.ghcr_package,
        digest = %blob.blob_digest,
        "redirecting nar download to GHCR CDN"
    );

    Ok((StatusCode::FOUND, [(LOCATION, redirect_url)]).into_response())
}

pub(super) async fn main_cache_info() -> Response {
    serve_cache_info()
}

pub(super) async fn pr_cache_info(
    State(state): State<AppState>,
    Path((owner, _repo, _number)): Path<(String, String, u64)>,
) -> Result<Response, ApiError> {
    ensure_owner_exists(&state, &owner)?;

    Ok(serve_cache_info())
}

pub(super) async fn main_narinfo(
    State(state): State<AppState>,
    Path(narinfo_file): Path<String>,
) -> Result<Response, ApiError> {
    serve_narinfo(&state, MAIN_SCOPE, &narinfo_file)
}

pub(super) async fn pr_narinfo(
    State(state): State<AppState>,
    Path((owner, repo, number, narinfo_file)): Path<(String, String, u64, String)>,
) -> Result<Response, ApiError> {
    ensure_owner_exists(&state, &owner)?;

    serve_narinfo(&state, &pr_scope(&owner, &repo, number), &narinfo_file)
}

pub(super) async fn main_nar(
    State(state): State<AppState>,
    Path(file): Path<String>,
) -> Result<Response, ApiError> {
    serve_nar(&state, MAIN_SCOPE, &file).await
}

pub(super) async fn pr_nar(
    State(state): State<AppState>,
    Path((owner, repo, number, file)): Path<(String, String, u64, String)>,
) -> Result<Response, ApiError> {
    ensure_owner_exists(&state, &owner)?;

    serve_nar(&state, &pr_scope(&owner, &repo, number), &file).await
}
