use axum::body::Bytes;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use serde::Deserialize;
use tracing::{info, warn};

use super::{ApiError, AppState};
use crate::github::verify_webhook_signature;

#[derive(Deserialize)]
struct WebhookOwner {
    id: u64,
}

#[derive(Deserialize)]
struct WebhookRepository {
    name: String,
    owner: WebhookOwner,
}

#[derive(Deserialize)]
struct WebhookPullRequest {
    number: u64,
}

#[derive(Deserialize)]
struct PullRequestWebhook {
    action: String,
    repository: WebhookRepository,
    pull_request: WebhookPullRequest,
}

pub(super) async fn handle(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<StatusCode, ApiError> {
    let Some(webhook_secret) = state
        .firn
        .config
        .github_app
        .as_ref()
        .and_then(|app| app.webhook_secret.as_deref())
    else {
        return Err(ApiError::new(StatusCode::NOT_FOUND, "webhooks not enabled"));
    };

    let Some(sig_header) = headers
        .get("X-Hub-Signature-256")
        .and_then(|value| value.to_str().ok())
    else {
        return Err(ApiError::new(
            StatusCode::UNAUTHORIZED,
            "missing webhook signature",
        ));
    };

    if !verify_webhook_signature(webhook_secret, sig_header, &body) {
        warn!("rejected GitHub webhook with invalid signature");

        return Err(ApiError::new(
            StatusCode::UNAUTHORIZED,
            "invalid webhook signature",
        ));
    }

    if headers
        .get("X-GitHub-Event")
        .and_then(|value| value.to_str().ok())
        != Some("pull_request")
    {
        return Ok(StatusCode::NO_CONTENT);
    }

    let payload: PullRequestWebhook = serde_json::from_slice(&body).map_err(|error| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            format!("invalid webhook JSON: {error}"),
        )
    })?;
    if payload.action != "closed" {
        return Ok(StatusCode::NO_CONTENT);
    }

    if let Some(owner) = state
        .firn
        .config
        .owner_by_github_id(payload.repository.owner.id)
    {
        let removed = state
            .firn
            .db
            .delete_pr_scope(
                &owner.name,
                &payload.repository.name,
                payload.pull_request.number,
            )
            .map_err(ApiError::internal)?;
        info!(
            owner = %owner.name,
            repo = %payload.repository.name,
            pr = payload.pull_request.number,
            removed,
            "cleaned PR overlay on pull_request closed webhook"
        );
    }

    Ok(StatusCode::NO_CONTENT)
}
