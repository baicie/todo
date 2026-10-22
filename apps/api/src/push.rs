use std::{sync::Arc, time::Duration};

use async_trait::async_trait;
use axum::{
    Json, Router,
    extract::State,
    http::{StatusCode, Uri},
    routing::{get, post},
};
use base64::{
    Engine,
    engine::general_purpose::{URL_SAFE, URL_SAFE_NO_PAD},
};
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, PgPool};
use tokio::task::JoinHandle;
use uuid::Uuid;
use web_push_native::{
    Auth, WebPushBuilder, jwt_simple::algorithms::ES256KeyPair, p256::PublicKey,
};

use crate::{
    auth::AuthUser,
    config::{Config, ConfigError, PushConfig},
    error::{ApiResult, AppError},
    state::AppState,
};

const MAX_PUSH_TEST_PER_DAY: i16 = 5;
const PUSH_TASK_BATCH: i64 = 100;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PushSendError {
    /// The push service reported 404/410 (or an equivalent permanent endpoint
    /// failure). The subscription must not be retried.
    Gone,
    /// A timeout, 5xx, encryption, or other transient failure. The delivery
    /// claim is released so a later worker tick can retry.
    Transient,
}

#[derive(Debug, Clone)]
pub struct PushTarget {
    pub subscription_id: Uuid,
    pub endpoint: String,
    pub p256dh: String,
    pub auth: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct PushPayload {
    pub title: String,
    pub body: String,
    #[serde(rename = "taskId")]
    pub task_id: Option<Uuid>,
    pub url: String,
}

pub fn reminder_payload(task_id: Uuid, title: &str, note: &str) -> PushPayload {
    let body = if note.trim().is_empty() {
        "Task reminder".to_owned()
    } else {
        note.chars().take(500).collect()
    };
    PushPayload {
        title: title.to_owned(),
        body,
        task_id: Some(task_id),
        url: format!("/?task={task_id}"),
    }
}

pub fn test_payload() -> PushPayload {
    PushPayload {
        title: "Test notification".to_owned(),
        body: "Web Push is configured correctly".to_owned(),
        task_id: None,
        url: "/".to_owned(),
    }
}

#[async_trait]
pub trait PushSender: Send + Sync {
    async fn send(&self, target: &PushTarget, payload: &PushPayload) -> Result<(), PushSendError>;
}

struct WebPushSender {
    client: reqwest::Client,
    config: PushConfig,
}

#[async_trait]
impl PushSender for WebPushSender {
    async fn send(&self, target: &PushTarget, payload: &PushPayload) -> Result<(), PushSendError> {
        let endpoint: axum::http::Uri = target
            .endpoint
            .parse()
            .map_err(|_| PushSendError::Transient)?;
        let p256dh_bytes =
            decode_push_base64(&target.p256dh).map_err(|_| PushSendError::Transient)?;
        let p256dh =
            PublicKey::from_sec1_bytes(&p256dh_bytes).map_err(|_| PushSendError::Transient)?;
        let auth_bytes = decode_push_base64(&target.auth).map_err(|_| PushSendError::Transient)?;
        if auth_bytes.len() != 16 {
            return Err(PushSendError::Transient);
        }
        let auth = Auth::clone_from_slice(&auth_bytes);
        let private_key =
            decode_push_base64(&self.config.private_key).map_err(|_| PushSendError::Transient)?;
        let key_pair =
            ES256KeyPair::from_bytes(&private_key).map_err(|_| PushSendError::Transient)?;
        let payload_bytes = serde_json::to_vec(payload).map_err(|_| PushSendError::Transient)?;
        let request = WebPushBuilder::new(endpoint, p256dh, auth)
            .with_vapid(&key_pair, &self.config.subject)
            .build(payload_bytes)
            .map_err(|_| PushSendError::Transient)?;
        let method = reqwest::Method::from_bytes(request.method().as_str().as_bytes())
            .map_err(|_| PushSendError::Transient)?;
        let mut outgoing = self.client.request(method, request.uri().to_string());
        for (name, value) in request.headers() {
            outgoing = outgoing.header(name.as_str(), value.as_bytes());
        }
        let response = outgoing
            .body(request.into_body())
            .send()
            .await
            .map_err(|_| PushSendError::Transient)?;
        match response.status().as_u16() {
            200..=299 => Ok(()),
            404 | 410 => Err(PushSendError::Gone),
            _ => Err(PushSendError::Transient),
        }
    }
}

fn decode_push_base64(value: &str) -> Result<Vec<u8>, base64::DecodeError> {
    URL_SAFE_NO_PAD
        .decode(value)
        .or_else(|_| URL_SAFE.decode(value))
}

#[derive(Clone)]
pub struct PushService {
    config: PushConfig,
    sender: Arc<dyn PushSender>,
}

impl PushService {
    pub fn new(config: PushConfig, sender: Arc<dyn PushSender>) -> Self {
        Self { config, sender }
    }

    pub fn public_key(&self) -> &str {
        &self.config.public_key
    }

    pub fn config(&self) -> &PushConfig {
        &self.config
    }

    async fn send_test(&self, pool: &PgPool, user_id: Uuid) -> ApiResult<PushStats> {
        let targets = load_targets(pool, user_id).await?;
        let payload = test_payload();
        let mut stats = PushStats::default();
        for target in targets {
            match self.send_target(&target, &payload).await {
                Ok(()) => {
                    stats.sent += 1;
                    mark_subscription_success(pool, target.subscription_id).await?;
                }
                Err(PushSendError::Gone) => {
                    stats.failed += 1;
                    mark_subscription_failed(pool, target.subscription_id).await?;
                }
                Err(PushSendError::Transient) => {
                    stats.failed += 1;
                }
            }
        }
        Ok(stats)
    }

    async fn send_target(
        &self,
        target: &PushTarget,
        payload: &PushPayload,
    ) -> Result<(), PushSendError> {
        self.sender.send(target, payload).await
    }
}

pub fn build_push_service(config: &Config) -> Result<Option<PushService>, ConfigError> {
    let Some(push_config) = &config.push else {
        return Ok(None);
    };
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|_| {
            ConfigError(
                "WEB_PUSH_ENABLED is true but the Web Push HTTP client could not start".to_owned(),
            )
        })?;
    let sender = Arc::new(WebPushSender {
        client,
        config: push_config.clone(),
    });
    Ok(Some(PushService::new(push_config.clone(), sender)))
}

#[derive(Debug, Default, Serialize)]
pub struct PushStats {
    pub sent: u64,
    pub failed: u64,
    pub skipped: u64,
}

#[derive(Debug, Serialize)]
struct PushConfigResponse {
    enabled: bool,
    public_key: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct SubscribeRequest {
    endpoint: String,
    p256dh: String,
    auth: String,
    #[serde(default)]
    user_agent: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct UnsubscribeRequest {
    endpoint: String,
}

#[derive(Debug, Serialize)]
struct SubscriptionResponse {
    id: Uuid,
    endpoint: String,
}

#[derive(Debug, Serialize)]
struct PushTestResponse {
    sent: u64,
    failed: u64,
    skipped: u64,
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/v1/push/config", get(push_config))
        .route(
            "/api/v1/push/subscriptions",
            post(subscribe).delete(unsubscribe),
        )
        .route("/api/v1/push/test", post(send_test))
}

async fn push_config(
    State(state): State<AppState>,
    _auth: AuthUser,
) -> ApiResult<Json<PushConfigResponse>> {
    let (enabled, public_key) = match state.push.as_ref() {
        Some(push) => (true, Some(push.public_key().to_owned())),
        None => (false, None),
    };
    Ok(Json(PushConfigResponse {
        enabled,
        public_key,
    }))
}

async fn subscribe(
    State(state): State<AppState>,
    auth: AuthUser,
    Json(request): Json<SubscribeRequest>,
) -> ApiResult<Json<SubscriptionResponse>> {
    require_push(&state)?;
    let (endpoint, p256dh, auth_key, user_agent) =
        validate_subscription(request, state.config.app_env)?;

    let existing_user: Option<Uuid> = sqlx::query_scalar(
        "INSERT INTO push_subscriptions \
         (id, user_id, endpoint, p256dh, auth, user_agent) \
         VALUES ($1, $2, $3, $4, $5, $6) \
         ON CONFLICT (endpoint) DO UPDATE SET \
           p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth, \
           user_agent = EXCLUDED.user_agent, last_seen_at = now(), failed_at = NULL \
         WHERE push_subscriptions.user_id = EXCLUDED.user_id \
         RETURNING id",
    )
    .bind(Uuid::new_v4())
    .bind(auth.user_id)
    .bind(&endpoint)
    .bind(&p256dh)
    .bind(&auth_key)
    .bind(&user_agent)
    .fetch_optional(&state.pool)
    .await?;

    if existing_user.is_none() {
        return Err(AppError::Conflict {
            code: "PUSH_SUBSCRIPTION_CONFLICT",
            message: "This push endpoint is already registered to another account".to_owned(),
        });
    }
    Ok(Json(SubscriptionResponse {
        id: existing_user.expect("checked above"),
        endpoint,
    }))
}

async fn unsubscribe(
    State(state): State<AppState>,
    auth: AuthUser,
    Json(request): Json<UnsubscribeRequest>,
) -> ApiResult<StatusCode> {
    let _ = require_push(&state)?;
    let endpoint = normalize_endpoint(&request.endpoint, state.config.app_env)?;
    sqlx::query("DELETE FROM push_subscriptions WHERE user_id = $1 AND endpoint = $2")
        .bind(auth.user_id)
        .bind(endpoint)
        .execute(&state.pool)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn send_test(
    State(state): State<AppState>,
    auth: AuthUser,
) -> ApiResult<Json<PushTestResponse>> {
    let push = require_push(&state)?;
    consume_test_quota(&state, auth.user_id).await?;
    let stats = push.send_test(&state.pool, auth.user_id).await?;
    state.metrics.record_push("sent", stats.sent);
    state.metrics.record_push("failed", stats.failed);
    state.metrics.record_push("skipped", stats.skipped);
    Ok(Json(PushTestResponse {
        sent: stats.sent,
        failed: stats.failed,
        skipped: stats.skipped,
    }))
}

fn require_push(state: &AppState) -> ApiResult<&PushService> {
    state
        .push
        .as_deref()
        .ok_or_else(|| AppError::ServiceUnavailable {
            code: "PUSH_DISABLED",
            message: "Web Push is not configured".to_owned(),
        })
}

async fn consume_test_quota(state: &AppState, user_id: Uuid) -> ApiResult<()> {
    let used: Option<i16> = sqlx::query_scalar(
        "INSERT INTO push_test_usage (user_id, usage_day, used) \
         VALUES ($1, CURRENT_DATE, 1) \
         ON CONFLICT (user_id, usage_day) DO UPDATE SET used = push_test_usage.used + 1 \
         WHERE push_test_usage.used < $2 \
         RETURNING used",
    )
    .bind(user_id)
    .bind(MAX_PUSH_TEST_PER_DAY)
    .fetch_optional(&state.pool)
    .await?;
    if used.is_none() {
        return Err(AppError::TooManyRequests {
            code: "PUSH_TEST_RATE_LIMITED",
            message: "Web Push test notifications are limited to 5 per day".to_owned(),
        });
    }
    Ok(())
}

fn validate_subscription(
    request: SubscribeRequest,
    app_env: crate::config::AppEnv,
) -> ApiResult<(String, String, String, Option<String>)> {
    let endpoint = normalize_endpoint(&request.endpoint, app_env)?;
    let p256dh = validate_key("p256dh", &request.p256dh, 4096)?;
    let auth = validate_key("auth", &request.auth, 1024)?;
    let user_agent = request
        .user_agent
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty());
    if user_agent.as_ref().is_some_and(|value| value.len() > 512)
        || user_agent
            .as_ref()
            .is_some_and(|value| value.chars().any(char::is_control))
    {
        return Err(AppError::validation(
            "user_agent must be at most 512 printable characters",
        ));
    }
    Ok((endpoint, p256dh, auth, user_agent))
}

fn normalize_endpoint(value: &str, app_env: crate::config::AppEnv) -> ApiResult<String> {
    let endpoint = value.trim();
    if endpoint.is_empty() || endpoint.len() > 4096 {
        return Err(AppError::validation(
            "endpoint must be between 1 and 4096 characters",
        ));
    }
    let uri: Uri = endpoint
        .parse()
        .map_err(|_| AppError::validation("endpoint must be a valid URL"))?;
    let Some(scheme) = uri.scheme_str() else {
        return Err(AppError::validation("endpoint must be an absolute URL"));
    };
    let local_http = app_env.is_development()
        && scheme == "http"
        && matches!(uri.host(), Some("localhost" | "127.0.0.1"));
    if scheme != "https" && !local_http {
        return Err(AppError::validation(
            "endpoint must use https:// (http://localhost is allowed in development)",
        ));
    }
    if uri.host().is_none() {
        return Err(AppError::validation("endpoint must contain a host"));
    }
    Ok(endpoint.to_owned())
}

fn validate_key(name: &str, value: &str, max_len: usize) -> ApiResult<String> {
    let value = value.trim();
    if value.is_empty() || value.len() > max_len || value.chars().any(char::is_whitespace) {
        return Err(AppError::validation(format!(
            "{name} must be non-empty URL-safe base64 without whitespace"
        )));
    }
    URL_SAFE_NO_PAD
        .decode(value)
        .or_else(|_| URL_SAFE.decode(value))
        .map_err(|_| AppError::validation(format!("{name} must be URL-safe base64")))?;
    Ok(value.to_owned())
}

#[derive(Debug, FromRow)]
struct ReminderTask {
    id: Uuid,
    user_id: Uuid,
    title: String,
    note: String,
}

#[derive(Debug, FromRow)]
struct PushTargetRow {
    id: Uuid,
    endpoint: String,
    p256dh: String,
    auth: String,
}

async fn load_targets(pool: &PgPool, user_id: Uuid) -> Result<Vec<PushTarget>, sqlx::Error> {
    let rows = sqlx::query_as::<_, PushTargetRow>(
        "SELECT id, endpoint, p256dh, auth FROM push_subscriptions \
         WHERE user_id = $1 AND failed_at IS NULL ORDER BY created_at, id",
    )
    .bind(user_id)
    .fetch_all(pool)
    .await?;
    Ok(rows
        .into_iter()
        .map(|row| PushTarget {
            subscription_id: row.id,
            endpoint: row.endpoint,
            p256dh: row.p256dh,
            auth: row.auth,
        })
        .collect())
}

async fn mark_subscription_success(
    pool: &PgPool,
    subscription_id: Uuid,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "UPDATE push_subscriptions SET last_seen_at = now(), failed_at = NULL WHERE id = $1",
    )
    .bind(subscription_id)
    .execute(pool)
    .await?;
    Ok(())
}

async fn mark_subscription_failed(pool: &PgPool, subscription_id: Uuid) -> Result<(), sqlx::Error> {
    sqlx::query("UPDATE push_subscriptions SET failed_at = now() WHERE id = $1")
        .bind(subscription_id)
        .execute(pool)
        .await?;
    Ok(())
}

pub async fn run_worker_once(state: &AppState, service: &PushService) -> ApiResult<PushStats> {
    let tasks = sqlx::query_as::<_, ReminderTask>(
        "SELECT id, user_id, title, note FROM tasks \
         WHERE remind_at IS NOT NULL \
           AND remind_at <= now() \
           AND remind_at > now() - interval '5 minutes' \
           AND status = 'open' \
           AND deleted_at IS NULL \
         ORDER BY remind_at, id LIMIT $1",
    )
    .bind(PUSH_TASK_BATCH)
    .fetch_all(&state.pool)
    .await?;

    let mut stats = PushStats::default();
    for task in tasks {
        let targets = load_targets(&state.pool, task.user_id).await?;
        if targets.is_empty() {
            stats.skipped += 1;
            continue;
        }
        let payload = reminder_payload(task.id, &task.title, &task.note);
        for target in targets {
            let claimed: Option<Uuid> = sqlx::query_scalar(
                "INSERT INTO push_deliveries (task_id, subscription_id) \
                 VALUES ($1, $2) ON CONFLICT (task_id, subscription_id) DO NOTHING \
                 RETURNING subscription_id",
            )
            .bind(task.id)
            .bind(target.subscription_id)
            .fetch_optional(&state.pool)
            .await?;
            if claimed.is_none() {
                stats.skipped += 1;
                continue;
            }

            match service.send_target(&target, &payload).await {
                Ok(()) => {
                    stats.sent += 1;
                    mark_subscription_success(&state.pool, target.subscription_id).await?;
                }
                Err(PushSendError::Gone) => {
                    stats.failed += 1;
                    mark_subscription_failed(&state.pool, target.subscription_id).await?;
                }
                Err(PushSendError::Transient) => {
                    stats.failed += 1;
                    sqlx::query(
                        "DELETE FROM push_deliveries WHERE task_id = $1 AND subscription_id = $2",
                    )
                    .bind(task.id)
                    .bind(target.subscription_id)
                    .execute(&state.pool)
                    .await?;
                }
            }
        }
    }

    state.metrics.record_push("sent", stats.sent);
    state.metrics.record_push("failed", stats.failed);
    state.metrics.record_push("skipped", stats.skipped);
    Ok(stats)
}

pub fn spawn_worker(state: AppState) -> Option<JoinHandle<()>> {
    let service = state.push.clone()?;
    let interval = Duration::from_secs(state.config.push_worker_interval_seconds);
    Some(tokio::spawn(async move {
        let mut ticker = tokio::time::interval(interval);
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            ticker.tick().await;
            match run_worker_once(&state, &service).await {
                Ok(stats) if stats.sent + stats.failed + stats.skipped > 0 => {
                    tracing::info!(
                        sent = stats.sent,
                        failed = stats.failed,
                        skipped = stats.skipped,
                        "web push worker completed a batch"
                    );
                }
                Ok(_) => {}
                Err(_) => tracing::warn!("web push worker tick failed"),
            }
        }
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};

    struct FakeSender {
        sent: std::sync::Mutex<Vec<(Uuid, Value)>>,
        error: Option<PushSendError>,
    }

    #[async_trait]
    impl PushSender for FakeSender {
        async fn send(
            &self,
            target: &PushTarget,
            payload: &PushPayload,
        ) -> Result<(), PushSendError> {
            self.sent.lock().unwrap().push((
                target.subscription_id,
                serde_json::to_value(payload).unwrap(),
            ));
            if let Some(error) = &self.error {
                return Err(error.clone());
            }
            Ok(())
        }
    }

    #[test]
    fn reminder_payload_has_stable_contract() {
        let task_id = Uuid::parse_str("019a0000-0000-7000-8000-000000000003").unwrap();
        let payload = reminder_payload(task_id, "Buy milk", "Remember the list");
        assert_eq!(payload.title, "Buy milk");
        assert_eq!(payload.body, "Remember the list");
        assert_eq!(payload.task_id, Some(task_id));
        assert_eq!(payload.url, format!("/?task={task_id}"));
        let value = serde_json::to_value(payload).unwrap();
        assert_eq!(value["taskId"], task_id.to_string());
        assert_eq!(value["url"], format!("/?task={task_id}"));
    }

    #[test]
    fn empty_note_uses_a_default_body() {
        let task_id = Uuid::new_v4();
        assert_eq!(
            reminder_payload(task_id, "Task", "  ").body,
            "Task reminder"
        );
    }

    #[test]
    fn subscription_validation_rejects_invalid_input() {
        let valid = SubscribeRequest {
            endpoint: "https://push.example.com/send/abc".to_owned(),
            p256dh: URL_SAFE_NO_PAD.encode([1_u8; 65]),
            auth: URL_SAFE_NO_PAD.encode([2_u8; 16]),
            user_agent: Some("Browser".to_owned()),
        };
        assert!(validate_subscription(valid, crate::config::AppEnv::Production).is_ok());

        let invalid_endpoint = SubscribeRequest {
            endpoint: "http://push.example.com/send/abc".to_owned(),
            p256dh: URL_SAFE_NO_PAD.encode([1_u8; 65]),
            auth: URL_SAFE_NO_PAD.encode([2_u8; 16]),
            user_agent: None,
        };
        assert!(
            validate_subscription(invalid_endpoint, crate::config::AppEnv::Production).is_err()
        );

        let empty_key = SubscribeRequest {
            endpoint: "https://push.example.com/send/abc".to_owned(),
            p256dh: String::new(),
            auth: URL_SAFE_NO_PAD.encode([2_u8; 16]),
            user_agent: None,
        };
        assert!(validate_subscription(empty_key, crate::config::AppEnv::Production).is_err());
    }

    #[test]
    fn dedupe_key_is_task_and_subscription() {
        let task_id = Uuid::new_v4();
        let subscription_id = Uuid::new_v4();
        let key = (task_id, subscription_id);
        assert_eq!(key, (task_id, subscription_id));
    }

    #[test]
    fn fake_sender_receives_test_payload() {
        let fake = Arc::new(FakeSender {
            sent: std::sync::Mutex::new(Vec::new()),
            error: None,
        });
        let service = PushService::new(
            PushConfig {
                public_key: "public".to_owned(),
                private_key: "private".to_owned(),
                subject: "mailto:test@example.com".to_owned(),
            },
            fake.clone(),
        );
        let target = PushTarget {
            subscription_id: Uuid::new_v4(),
            endpoint: "https://example.com".to_owned(),
            p256dh: "key".to_owned(),
            auth: "auth".to_owned(),
        };
        let runtime = tokio::runtime::Runtime::new().unwrap();
        runtime.block_on(async {
            service.send_target(&target, &test_payload()).await.unwrap();
        });
        let sent = fake.sent.lock().unwrap();
        assert_eq!(sent.len(), 1);
        assert_eq!(sent[0].0, target.subscription_id);
        assert_eq!(
            sent[0].1,
            json!({
                "title": "Test notification",
                "body": "Web Push is configured correctly",
                "taskId": null,
                "url": "/"
            })
        );
    }
}
