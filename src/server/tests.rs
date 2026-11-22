use std::collections::{HashMap, HashSet};
use std::fs;
use std::sync::{Arc, Mutex};

use axum::body::{Body, Bytes, to_bytes};
use axum::extract::{Path, State};
use axum::http::header::{AUTHORIZATION, CONTENT_TYPE, LOCATION};
use axum::http::{Request, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, head, post, put};
use axum::{Json, Router};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use hmac::{Hmac, Mac};
use jsonwebtoken::{Algorithm, EncodingKey, Header, encode};
use rand::rngs::OsRng;
use rsa::pkcs8::EncodePrivateKey;
use rsa::traits::PublicKeyParts;
use rsa::{RsaPrivateKey, RsaPublicKey};
use serde::Serialize;
use sha2::{Digest, Sha256};
use tower::ServiceExt;

use super::{AppState, Endpoints, build_router, build_state};
use crate::config::{Config, GcConfig, GitHubAppConfig, LoadedConfig, OwnerConfig, OwnerType};
use crate::db::Database;
use crate::firn::Firn;
use crate::nix_format::{
    SigningKeyPair, fingerprint, format_sha256_nixbase32, unix_now, verify_signature,
};
use crate::oci::OciClient;
use crate::protocol::{CommitEntry, CommitRequest, PlanRequest, PlanResponse};

#[derive(Default)]
struct MockStore {
    blobs: HashMap<String, Vec<u8>>,
    manifests: HashMap<String, Vec<u8>>,
    versions: HashMap<String, Vec<(u64, String)>>,
    protected_packages: HashSet<String>,
    deleted_versions: Vec<u64>,
    deleted_packages: Vec<String>,
    next_version_id: u64,
}

#[derive(Clone)]
struct MockInfra {
    jwks: serde_json::Value,
    cdn_base: String,
    store: Arc<Mutex<MockStore>>,
}

async fn mock_head_blob(
    State(mock): State<MockInfra>,
    Path((owner, pkg, digest)): Path<(String, String, String)>,
) -> StatusCode {
    let key = format!("{owner}/{pkg}/{digest}");
    if mock.store.lock().unwrap().blobs.contains_key(&key) {
        StatusCode::OK
    } else {
        StatusCode::NOT_FOUND
    }
}

async fn mock_get_blob(
    State(mock): State<MockInfra>,
    Path((owner, pkg, digest)): Path<(String, String, String)>,
) -> Response {
    let key = format!("{owner}/{pkg}/{digest}");
    if mock.store.lock().unwrap().blobs.contains_key(&key) {
        (
            StatusCode::TEMPORARY_REDIRECT,
            [(LOCATION, format!("{}/cdn/{key}", mock.cdn_base))],
        )
            .into_response()
    } else {
        StatusCode::NOT_FOUND.into_response()
    }
}

async fn mock_start_upload(Path((owner, pkg)): Path<(String, String)>) -> impl IntoResponse {
    (
        StatusCode::ACCEPTED,
        [(LOCATION, format!("/v2/{owner}/{pkg}/blobs/uploads/1"))],
    )
}

async fn mock_put_blob(
    State(mock): State<MockInfra>,
    Path((owner, pkg, _id)): Path<(String, String, String)>,
    uri: Uri,
    body: Bytes,
) -> StatusCode {
    let digest = uri
        .query()
        .unwrap()
        .split('&')
        .find_map(|pair| pair.strip_prefix("digest="))
        .unwrap();
    mock.store
        .lock()
        .unwrap()
        .blobs
        .insert(format!("{owner}/{pkg}/{digest}"), body.to_vec());

    StatusCode::CREATED
}

async fn mock_put_manifest(
    State(mock): State<MockInfra>,
    Path((owner, pkg, reference)): Path<(String, String, String)>,
    body: Bytes,
) -> impl IntoResponse {
    let digest = format!("sha256:{}", hex::encode(Sha256::digest(&body)));
    let mut guard = mock.store.lock().unwrap();
    guard
        .manifests
        .insert(format!("{owner}/{pkg}/{reference}"), body.to_vec());
    guard
        .manifests
        .insert(format!("{owner}/{pkg}/{digest}"), body.to_vec());
    guard.next_version_id += 1;
    let vid = guard.next_version_id;
    guard
        .versions
        .entry(format!("{owner}/{pkg}"))
        .or_default()
        .push((vid, digest.clone()));

    (StatusCode::CREATED, [("Docker-Content-Digest", digest)])
}

async fn mock_get_manifest(
    State(mock): State<MockInfra>,
    Path((owner, pkg, reference)): Path<(String, String, String)>,
) -> Response {
    let key = format!("{owner}/{pkg}/{reference}");
    match mock.store.lock().unwrap().manifests.get(&key) {
        Some(bytes) => (StatusCode::OK, bytes.clone()).into_response(),
        None => StatusCode::NOT_FOUND.into_response(),
    }
}

async fn mock_list_versions(
    State(mock): State<MockInfra>,
    Path((owner, pkg)): Path<(String, String)>,
) -> Json<Vec<serde_json::Value>> {
    let guard = mock.store.lock().unwrap();
    let list = guard
        .versions
        .get(&format!("{owner}/{pkg}"))
        .into_iter()
        .flatten()
        .map(|(id, name)| serde_json::json!({ "id": id, "name": name }))
        .collect();

    Json(list)
}

async fn mock_delete_version(
    State(mock): State<MockInfra>,
    Path((owner, pkg, vid)): Path<(String, String, u64)>,
) -> Response {
    let key = format!("{owner}/{pkg}");
    let mut guard = mock.store.lock().unwrap();
    if guard.protected_packages.contains(&key) {
        return (
            StatusCode::BAD_REQUEST,
            r#"{"message":"You cannot delete a public package version that has more than 5000 downloads."}"#,
        )
            .into_response();
    }
    let count = match guard.versions.get(&key) {
        Some(list) => list.len(),
        None => 0,
    };
    if count == 1 {
        return (
            StatusCode::BAD_REQUEST,
            r#"{"message":"You cannot delete the last version of a package. You must delete the package instead."}"#,
        )
            .into_response();
    }
    if let Some(versions) = guard.versions.get_mut(&key) {
        versions.retain(|(id, _)| *id != vid);
    }
    guard.deleted_versions.push(vid);

    StatusCode::NO_CONTENT.into_response()
}

async fn mock_delete_package(
    State(mock): State<MockInfra>,
    Path((owner, pkg)): Path<(String, String)>,
) -> Response {
    let key = format!("{owner}/{pkg}");
    let mut guard = mock.store.lock().unwrap();
    if guard.protected_packages.contains(&key) {
        return (
            StatusCode::BAD_REQUEST,
            r#"{"message":"You cannot delete a public package that has more than 5000 downloads."}"#,
        )
            .into_response();
    }
    guard.versions.remove(&key);
    guard.deleted_packages.push(key);

    StatusCode::NO_CONTENT.into_response()
}

async fn spawn_mock_infra(jwks: serde_json::Value) -> (String, Arc<Mutex<MockStore>>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base_url = format!("http://{}", listener.local_addr().unwrap());
    let store = Arc::new(Mutex::new(MockStore::default()));
    let mock = MockInfra {
        jwks,
        cdn_base: base_url.clone(),
        store: Arc::clone(&store),
    };

    let app = Router::new()
        .route(
            "/.well-known/jwks",
            get(|State(m): State<MockInfra>| async move { Json(m.jwks) }),
        )
        .route(
            "/token",
            get(|| async { Json(serde_json::json!({ "token": "mock-oci-token" })) }),
        )
        .route(
            "/v2/{owner}/{pkg}/blobs/{digest}",
            head(mock_head_blob).get(mock_get_blob),
        )
        .route("/v2/{owner}/{pkg}/blobs/uploads/", post(mock_start_upload))
        .route("/v2/{owner}/{pkg}/blobs/uploads/{id}", put(mock_put_blob))
        .route(
            "/v2/{owner}/{pkg}/manifests/{reference}",
            put(mock_put_manifest).get(mock_get_manifest),
        )
        .route(
            "/app/installations/{id}/access_tokens",
            post(|| async {
                (
                    StatusCode::CREATED,
                    Json(serde_json::json!({ "token": "ghs_mock_install_token" })),
                )
            }),
        )
        .route(
            "/users/{owner}/packages/container/{pkg}",
            delete(mock_delete_package),
        )
        .route(
            "/users/{owner}/packages/container/{pkg}/versions",
            get(mock_list_versions),
        )
        .route(
            "/users/{owner}/packages/container/{pkg}/versions/{vid}",
            delete(mock_delete_version),
        )
        .with_state(mock);

    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });

    (base_url, store)
}

async fn response_text(resp: Response) -> String {
    let bytes = to_bytes(resp.into_body(), 65536).await.unwrap();

    String::from_utf8(bytes.to_vec()).unwrap()
}

struct TestHarness {
    _tmp: tempfile::TempDir,
    mock_url: String,
    store: Arc<Mutex<MockStore>>,
    state: AppState,
    app: Router,
    oci: OciClient,
    oidc_key: EncodingKey,
    main_key: SigningKeyPair,
    pr_key: SigningKeyPair,
}

impl TestHarness {
    async fn new() -> Self {
        let rsa_key = RsaPrivateKey::new(&mut OsRng, 2048).unwrap();
        let rsa_pub = RsaPublicKey::from(&rsa_key);
        let rsa_pem = rsa_key.to_pkcs8_pem(rsa::pkcs8::LineEnding::LF).unwrap();
        let oidc_key = EncodingKey::from_rsa_pem(rsa_pem.as_bytes()).unwrap();
        let jwks = serde_json::json!({
            "keys": [{
                "kty": "RSA",
                "kid": "test-kid-1",
                "alg": "RS256",
                "use": "sig",
                "n": URL_SAFE_NO_PAD.encode(rsa_pub.n().to_bytes_be()),
                "e": URL_SAFE_NO_PAD.encode(rsa_pub.e().to_bytes_be()),
            }]
        });

        let (mock_url, store) = spawn_mock_infra(jwks).await;
        let tmp = tempfile::tempdir().unwrap();
        let main_key = SigningKeyPair::generate("cache.so1ve.dev-1").unwrap();
        let pr_key = SigningKeyPair::generate("cache.so1ve.dev-pr-1").unwrap();

        let main_key_path = tmp.path().join("main.key");
        let pr_key_path = tmp.path().join("pr.key");
        let app_pem_path = tmp.path().join("app.pem");
        let webhook_secret_path = tmp.path().join("webhook.secret");
        let manual_tokens_path = tmp.path().join("manual.tokens");
        fs::write(&main_key_path, main_key.secret_string()).unwrap();
        fs::write(&pr_key_path, pr_key.secret_string()).unwrap();
        fs::write(&app_pem_path, rsa_pem.as_bytes()).unwrap();
        fs::write(&webhook_secret_path, "whsec_test").unwrap();
        fs::write(&manual_tokens_path, "manual-secret-token\n").unwrap();

        let config = LoadedConfig::from_config(Config {
            listen: "127.0.0.1:0".to_owned(),
            database_path: tmp.path().join("state.db"),
            public_base_url: "https://cache.so1ve.dev".to_owned(),
            github_app: Some(GitHubAppConfig {
                app_id: 1,
                private_key_file: app_pem_path,
                webhook_secret_file: Some(webhook_secret_path),
            }),
            gc: GcConfig::default(),
            owners: vec![OwnerConfig {
                name: "so1ve".to_owned(),
                owner_type: OwnerType::User,
                github_owner_id: 58_381_667,
                github_installation_id: Some(99),
                main_signing_key_file: main_key_path,
                pr_signing_key_file: pr_key_path,
                package_template: "{repo}-cache".to_owned(),
                manual_push_package: "manual-cache".to_owned(),
                protected_refs: vec!["refs/heads/main".to_owned()],
                allowed_repos: Vec::new(),
                manual_tokens_file: Some(manual_tokens_path),
            }],
        })
        .unwrap();

        let db = Database::open_in_memory().unwrap();
        let firn = Firn::new(config, db, &mock_url).unwrap();
        let endpoints = Endpoints {
            oidc_issuer: mock_url.clone(),
            registry_url: mock_url.clone(),
        };
        let (state, _rx) = build_state(firn, &endpoints).unwrap();
        let app = build_router(state.clone());
        let oci = OciClient::new(&mock_url).unwrap();

        Self {
            _tmp: tmp,
            mock_url,
            store,
            state,
            app,
            oci,
            oidc_key,
            main_key,
            pr_key,
        }
    }

    fn sign_oidc(&self, repo: &str, ref_name: &str, event_name: &str) -> String {
        #[derive(Serialize)]
        struct Claims<'a> {
            iss: &'a str,
            aud: &'a str,
            exp: i64,
            repository_owner_id: &'a str,
            repository: String,
            #[serde(rename = "ref")]
            ref_name: &'a str,
            event_name: &'a str,
        }

        let mut header = Header::new(Algorithm::RS256);
        header.kid = Some("test-kid-1".to_owned());
        let claims = Claims {
            iss: &self.mock_url,
            aud: "https://cache.so1ve.dev",
            exp: unix_now() + 300,
            repository_owner_id: "58381667",
            repository: format!("so1ve/{repo}"),
            ref_name,
            event_name,
        };

        encode(&header, &claims, &self.oidc_key).unwrap()
    }

    async fn get(&self, uri: &str) -> Response {
        self.app
            .clone()
            .oneshot(Request::builder().uri(uri).body(Body::empty()).unwrap())
            .await
            .unwrap()
    }

    async fn post_json<T: Serialize>(&self, uri: &str, bearer: &str, body: &T) -> Response {
        self.app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(uri)
                    .header(AUTHORIZATION, format!("Bearer {bearer}"))
                    .header(CONTENT_TYPE, "application/json")
                    .body(Body::from(serde_json::to_vec(body).unwrap()))
                    .unwrap(),
            )
            .await
            .unwrap()
    }

    async fn send_pr_closed_webhook(&self, repo: &str, pr_number: u64) -> StatusCode {
        let body = format!(
            r#"{{"action":"closed","repository":{{"name":"{repo}","owner":{{"id":58381667}}}},"pull_request":{{"number":{pr_number}}}}}"#
        );
        let mut mac = Hmac::<Sha256>::new_from_slice(b"whsec_test").unwrap();
        mac.update(body.as_bytes());
        let sig = format!("sha256={}", hex::encode(mac.finalize().into_bytes()));

        self.app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/v1/webhooks/github")
                    .header("X-GitHub-Event", "pull_request")
                    .header("X-Hub-Signature-256", sig)
                    .body(Body::from(body))
                    .unwrap(),
            )
            .await
            .unwrap()
            .status()
    }

    async fn upload_and_commit(
        &self,
        bearer: &str,
        ghcr_repository: &str,
        store_path: &str,
        nar_bytes: &[u8],
    ) -> (String, String) {
        let compressed = zstd::stream::encode_all(nar_bytes, 3).unwrap();
        let nar_digest: [u8; 32] = Sha256::digest(nar_bytes).into();
        let file_digest: [u8; 32] = Sha256::digest(&compressed).into();
        let file_hex = hex::encode(file_digest);
        let nar_hash = format_sha256_nixbase32(&nar_digest);
        let manifest_digest = self
            .oci
            .upload_nar_blob(
                ghcr_repository,
                "mock-oci-token",
                compressed.clone(),
                &file_hex,
            )
            .await
            .unwrap();

        let resp = self
            .post_json(
                "/api/v1/uploads/commit",
                bearer,
                &CommitRequest {
                    owner: None,
                    entries: vec![CommitEntry {
                        store_path: store_path.to_owned(),
                        nar_hash: nar_hash.clone(),
                        nar_size: nar_bytes.len() as u64,
                        file_hash: format_sha256_nixbase32(&file_digest),
                        file_size: compressed.len() as u64,
                        manifest_digest,
                        blob_digest: file_hex.clone(),
                        deriver: None,
                        references: Vec::new(),
                    }],
                },
            )
            .await;
        assert_eq!(resp.status(), StatusCode::OK);

        (nar_hash, file_hex)
    }
}

#[tokio::test]
async fn rejects_pull_request_target_and_unprotected_refs() {
    let h = TestHarness::new().await;
    let pr_target = h.sign_oidc("latchshot", "refs/heads/main", "pull_request_target");
    let feature = h.sign_oidc("latchshot", "refs/heads/feature", "push");

    let req = PlanRequest {
        owner: None,
        store_paths: Vec::new(),
    };
    assert_eq!(
        h.post_json("/api/v1/uploads/plan", &pr_target, &req)
            .await
            .status(),
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        h.post_json("/api/v1/uploads/plan", &feature, &req)
            .await
            .status(),
        StatusCode::FORBIDDEN
    );
}

#[tokio::test]
async fn oidc_main_push_signs_and_redirects_to_cdn() {
    let h = TestHarness::new().await;
    let jwt = h.sign_oidc("latchshot", "refs/heads/main", "push");
    let hash = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    let path = format!("/nix/store/{hash}-hello");

    let resp = h
        .post_json(
            "/api/v1/uploads/plan",
            &jwt,
            &PlanRequest {
                owner: None,
                store_paths: vec![path.clone()],
            },
        )
        .await;
    assert_eq!(resp.status(), StatusCode::OK);
    let plan: PlanResponse = serde_json::from_str(&response_text(resp).await).unwrap();
    assert_eq!(plan.ghcr_repository, "so1ve/latchshot-cache");
    assert_eq!(plan.missing, vec![hash]);
    assert!(plan.ghcr_token.is_none());

    let nar_bytes = b"fake-nar-content-main";
    let (nar_hash, file_hex) = h
        .upload_and_commit(&jwt, &plan.ghcr_repository, &path, nar_bytes)
        .await;

    let narinfo_resp = h.get(&format!("/so1ve/{hash}.narinfo")).await;
    assert_eq!(narinfo_resp.status(), StatusCode::OK);
    let text = response_text(narinfo_resp).await;
    let sig = text.lines().find_map(|l| l.strip_prefix("Sig: ")).unwrap();
    let fp = fingerprint(&path, &nar_hash, nar_bytes.len() as u64, &[]);
    assert!(verify_signature(&h.main_key.public_string(), &fp, sig).unwrap());

    let nar_resp = h.get(&format!("/so1ve/nar/{file_hex}.nar.zst")).await;
    assert_eq!(nar_resp.status(), StatusCode::FOUND);
    assert!(
        nar_resp
            .headers()
            .get(LOCATION)
            .unwrap()
            .to_str()
            .unwrap()
            .contains("/cdn/so1ve/latchshot-cache/sha256:")
    );
}

#[tokio::test]
async fn pr_overlay_isolates_writes_and_keys_from_main() {
    let h = TestHarness::new().await;
    let main_jwt = h.sign_oidc("latchshot", "refs/heads/main", "push");
    let pr_jwt = h.sign_oidc("latchshot", "refs/pull/7/merge", "pull_request");

    let main_hash = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    let main_path = format!("/nix/store/{main_hash}-base");
    let pr_hash = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    let pr_path = format!("/nix/store/{pr_hash}-pr");

    h.upload_and_commit(&main_jwt, "so1ve/latchshot-cache", &main_path, b"main-nar")
        .await;

    let plan_resp = h
        .post_json(
            "/api/v1/uploads/plan",
            &pr_jwt,
            &PlanRequest {
                owner: None,
                store_paths: vec![main_path.clone(), pr_path.clone()],
            },
        )
        .await;
    let pr_plan: PlanResponse = serde_json::from_str(&response_text(plan_resp).await).unwrap();
    assert_eq!(pr_plan.missing, vec![pr_hash]);

    let (pr_nar_hash, _) = h
        .upload_and_commit(&pr_jwt, &pr_plan.ghcr_repository, &pr_path, b"pr-nar")
        .await;

    assert_eq!(
        h.get(&format!("/so1ve/pr/latchshot/7/{main_hash}.narinfo"))
            .await
            .status(),
        StatusCode::OK
    );
    assert_eq!(
        h.get(&format!("/so1ve/{pr_hash}.narinfo")).await.status(),
        StatusCode::NOT_FOUND
    );

    let pr_text = response_text(
        h.get(&format!("/so1ve/pr/latchshot/7/{pr_hash}.narinfo"))
            .await,
    )
    .await;
    let pr_sig = pr_text
        .lines()
        .find_map(|l| l.strip_prefix("Sig: "))
        .unwrap();
    let pr_fp = fingerprint(&pr_path, &pr_nar_hash, b"pr-nar".len() as u64, &[]);
    assert!(verify_signature(&h.pr_key.public_string(), &pr_fp, pr_sig).unwrap());
    assert!(!verify_signature(&h.main_key.public_string(), &pr_fp, pr_sig).unwrap());
}

#[tokio::test]
async fn gc_handles_last_version_fallback_and_download_threshold_protection() {
    let h = TestHarness::new().await;

    // Manual Bearer token exchanges a scoped GHCR upload token via GitHub App.
    let manual_resp = h
        .post_json(
            "/api/v1/uploads/plan",
            "manual-secret-token",
            &PlanRequest {
                owner: Some("so1ve".to_owned()),
                store_paths: Vec::new(),
            },
        )
        .await;
    assert_eq!(manual_resp.status(), StatusCode::OK);
    let plan: PlanResponse = serde_json::from_str(&response_text(manual_resp).await).unwrap();
    assert_eq!(plan.ghcr_repository, "so1ve/manual-cache");
    assert_eq!(plan.ghcr_token.as_deref(), Some("mock-oci-token"));

    // Case 1: Deleting the sole remaining version falls back to deleting the
    // package.
    let pr_jwt = h.sign_oidc("latchshot", "refs/pull/9/merge", "pull_request");
    let pr_path = "/nix/store/cccccccccccccccccccccccccccccccc-ephemeral";
    h.upload_and_commit(&pr_jwt, "so1ve/latchshot-cache", pr_path, b"pr-ephemeral")
        .await;
    assert_eq!(
        h.send_pr_closed_webhook("latchshot", 9).await,
        StatusCode::NO_CONTENT
    );

    let report = h.state.firn.run_gc(false).await.unwrap();
    assert_eq!(report.blobs_deleted, 1);
    assert_eq!(
        h.store.lock().unwrap().deleted_packages,
        vec!["so1ve/latchshot-cache"]
    );

    // Case 2: Public package exceeding 5000 downloads is marked gc_blocked and
    // not retried.
    let popular_jwt = h.sign_oidc("popular", "refs/pull/10/merge", "pull_request");
    h.upload_and_commit(
        &popular_jwt,
        "so1ve/popular-cache",
        "/nix/store/dddddddddddddddddddddddddddddddd-popular",
        b"popular-nar",
    )
    .await;
    h.store
        .lock()
        .unwrap()
        .protected_packages
        .insert("so1ve/popular-cache".to_owned());
    assert_eq!(
        h.send_pr_closed_webhook("popular", 10).await,
        StatusCode::NO_CONTENT
    );

    let first_gc = h.state.firn.run_gc(false).await.unwrap();
    assert_eq!(first_gc.blobs_protected, 1);
    assert_eq!(first_gc.blob_errors, 0);

    let second_gc = h.state.firn.run_gc(false).await.unwrap();
    assert_eq!(second_gc.blobs_protected, 0);
    assert_eq!(second_gc.blobs_deleted, 0);
    assert_eq!(second_gc.blob_errors, 0);
}
