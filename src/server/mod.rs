mod cache;
#[cfg(test)]
mod tests;
mod upload;
mod webhook;

use std::collections::HashSet;
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use axum::Router;
use axum::extract::Request;
use axum::http::StatusCode;
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use tokio::sync::mpsc;
use tracing::{debug, error, info, warn};

use crate::db::Database;
use crate::firn::Firn;
use crate::github::OidcVerifier;
use crate::nix_format::unix_now;
use crate::oci::OciClient;

const GITHUB_OIDC_ISSUER: &str = "https://token.actions.githubusercontent.com";
const GHCR_REGISTRY_URL: &str = "https://ghcr.io";

const ACCESS_QUEUE_CAPACITY: usize = 4096;
const ACCESS_FLUSH_BATCH: usize = 256;
const ACCESS_FLUSH_INTERVAL: Duration = Duration::from_secs(15);
const GC_INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);

struct Endpoints {
    oidc_issuer: String,
    registry_url: String,
}

impl Endpoints {
    fn production() -> Self {
        Self {
            oidc_issuer: GITHUB_OIDC_ISSUER.to_owned(),
            registry_url: GHCR_REGISTRY_URL.to_owned(),
        }
    }
}

#[derive(Clone)]
pub struct AppState {
    firn: Firn,
    registry_url: String,
    oci: Arc<OciClient>,
    oidc: Arc<OidcVerifier>,
    access_tx: mpsc::Sender<i64>,
}

pub struct ApiError(StatusCode, String);

impl ApiError {
    fn new(status: StatusCode, message: impl Into<String>) -> Self {
        Self(status, message.into())
    }

    fn internal(error: impl std::fmt::Display) -> Self {
        let message = error.to_string();
        error!(error = %message, "internal server error");

        Self(StatusCode::INTERNAL_SERVER_ERROR, message)
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.0, self.1).into_response()
    }
}

async fn log_request(request: Request, next: Next) -> Response {
    let method = request.method().clone();
    let path = request.uri().path().to_owned();
    let started = Instant::now();
    let response = next.run(request).await;
    let status = response.status();
    let elapsed_ms = started.elapsed().as_millis();

    if status.is_server_error() {
        error!(%method, %path, status = status.as_u16(), elapsed_ms, "http request failed");
    } else if status.is_client_error() && status != StatusCode::NOT_FOUND {
        warn!(%method, %path, status = status.as_u16(), elapsed_ms, "http request rejected");
    } else {
        debug!(%method, %path, status = status.as_u16(), elapsed_ms, "http request");
    }

    response
}

async fn shutdown_signal() {
    let mut sigterm =
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()).unwrap();

    tokio::select! {
        _ = tokio::signal::ctrl_c() => {},
        _ = sigterm.recv() => {},
    }
    info!("shutdown signal received");
}

fn flush_access_batch(db: &Database, pending: &mut HashSet<i64>) {
    if pending.is_empty() {
        return;
    }

    let ids: Vec<i64> = pending.drain().collect();
    if let Err(error) = db.touch_accessed(&ids, unix_now()) {
        warn!(error = %error, "failed to flush last_accessed_at batch");
    }
}

async fn run_access_flusher(db: Database, mut rx: mpsc::Receiver<i64>) {
    let mut pending = HashSet::with_capacity(ACCESS_FLUSH_BATCH);
    let mut ticker = tokio::time::interval(ACCESS_FLUSH_INTERVAL);
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

    loop {
        tokio::select! {
            item = rx.recv() => {
                if let Some(id) = item {
                    pending.insert(id);
                    if pending.len() >= ACCESS_FLUSH_BATCH {
                        flush_access_batch(&db, &mut pending);
                    }
                } else {
                    flush_access_batch(&db, &mut pending);
                    break;
                }
            }
            _ = ticker.tick() => {
                flush_access_batch(&db, &mut pending);
            }
        }
    }
}

async fn run_gc_loop(firn: Firn) {
    let mut ticker = tokio::time::interval(GC_INTERVAL);
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    ticker.tick().await;

    loop {
        ticker.tick().await;
        if let Err(error) = firn.run_gc(false).await {
            warn!(error = %error, "background GC cycle failed");
        }
    }
}

fn build_state(firn: Firn, endpoints: &Endpoints) -> Result<(AppState, mpsc::Receiver<i64>)> {
    let oci = Arc::new(OciClient::new(&endpoints.registry_url)?);
    let oidc = Arc::new(OidcVerifier::new(
        &endpoints.oidc_issuer,
        &firn.config.public_base_url,
    ));
    let (access_tx, access_rx) = mpsc::channel(ACCESS_QUEUE_CAPACITY);

    let state = AppState {
        firn,
        registry_url: endpoints.registry_url.clone(),
        oci,
        oidc,
        access_tx,
    };

    Ok((state, access_rx))
}

fn build_router(state: AppState) -> Router {
    Router::new()
        .route("/healthz", get(|| async { "ok\n" }))
        .route("/nix-cache-info", get(cache::main_cache_info))
        .route("/nar/{file}", get(cache::main_nar))
        .route("/{narinfo}", get(cache::main_narinfo))
        .route("/api/v1/public-keys", get(cache::public_keys))
        .route("/api/v1/uploads/plan", post(upload::plan))
        .route("/api/v1/uploads/commit", post(upload::commit))
        .route("/api/v1/webhooks/github", post(webhook::handle))
        .route(
            "/pr/{owner}/{repo}/{number}/nix-cache-info",
            get(cache::pr_cache_info),
        )
        .route("/pr/{owner}/{repo}/{number}/nar/{file}", get(cache::pr_nar))
        .route(
            "/pr/{owner}/{repo}/{number}/{narinfo}",
            get(cache::pr_narinfo),
        )
        .layer(middleware::from_fn(log_request))
        .with_state(state)
}

pub async fn run(firn: Firn) -> Result<()> {
    let listen = firn.config.listen.clone();
    let (state, access_rx) = build_state(firn, &Endpoints::production())?;

    let flush_task = tokio::spawn(run_access_flusher(state.firn.db.clone(), access_rx));
    let gc_task = tokio::spawn(run_gc_loop(state.firn.clone()));

    let router = build_router(state.clone());
    let listener = tokio::net::TcpListener::bind(&listen)
        .await
        .with_context(|| format!("failed to bind {listen}"))?;
    info!(listen = %listen, "firn server listening");

    axum::serve(listener, router)
        .with_graceful_shutdown(shutdown_signal())
        .await
        .context("HTTP server failed")?;

    drop(state);
    gc_task.abort();
    let _ = flush_task.await;

    Ok(())
}
