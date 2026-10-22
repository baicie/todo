//! Ignored by default because it needs a real PostgreSQL instance.
//!
//! Run with:
//!   DATABASE_URL=postgres://todo:todo@127.0.0.1:5432/todo \
//!     cargo test -p todo-api --test postgres_smoke -- --ignored
//!
//! The CI workflow provides PostgreSQL 16 and exercises migrations through the
//! API health-check smoke step. These tests intentionally use a lazy pool so
//! the regular unit suite remains hermetic.

use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use axum::{
    Router,
    body::Body,
    http::{Method, Request, StatusCode, header::AUTHORIZATION, header::CONTENT_TYPE},
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use sqlx::postgres::PgPoolOptions;
use todo_api::{
    AppState, build_router,
    config::{AppEnv, Config, PushConfig},
    mail::{MailError, MailProvider},
    push::{PushPayload, PushSendError, PushSender, PushService, PushTarget, run_worker_once},
};
use tower::ServiceExt;
use uuid::Uuid;

struct RecordingMailer {
    sent: Mutex<Vec<(String, String, i64)>>,
    ready: bool,
}

#[async_trait]
impl MailProvider for RecordingMailer {
    async fn send_auth_code(
        &self,
        recipient: &str,
        code: &str,
        ttl_seconds: i64,
    ) -> Result<(), MailError> {
        self.sent
            .lock()
            .unwrap()
            .push((recipient.to_owned(), code.to_owned(), ttl_seconds));
        Ok(())
    }

    fn is_ready(&self) -> bool {
        self.ready
    }

    fn kind(&self) -> &'static str {
        "recording"
    }
}

struct RecordingPushSender {
    sent: Mutex<Vec<(Uuid, Value)>>,
    error: Option<PushSendError>,
}

#[async_trait]
impl PushSender for RecordingPushSender {
    async fn send(&self, target: &PushTarget, payload: &PushPayload) -> Result<(), PushSendError> {
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

fn push_config() -> PushConfig {
    PushConfig {
        public_key: URL_SAFE_NO_PAD.encode([3_u8; 65]),
        private_key: URL_SAFE_NO_PAD.encode([4_u8; 32]),
        subject: "mailto:push-test@example.com".to_owned(),
    }
}

#[tokio::test]
#[ignore = "requires PostgreSQL; set DATABASE_URL and pass --ignored"]
async fn migrations_apply_and_health_endpoint_works() {
    dotenvy::dotenv().ok();
    let database_url = std::env::var("DATABASE_URL")
        .expect("DATABASE_URL must point at a disposable PostgreSQL test database");
    let mut config = Config::for_test();
    config.database_url = database_url.clone();
    let pool = PgPoolOptions::new()
        .max_connections(2)
        .connect(&database_url)
        .await
        .expect("connect to test PostgreSQL");

    sqlx::migrate!("../../db/postgres/migrations")
        .run(&pool)
        .await
        .expect("apply migrations");

    let tags_type: String = sqlx::query_scalar(
        "SELECT data_type FROM information_schema.columns \
         WHERE table_schema = 'public' AND table_name = 'tasks' AND column_name = 'tags'",
    )
    .fetch_one(&pool)
    .await
    .expect("tasks.tags column");
    assert_eq!(tags_type, "ARRAY");
    let tags_index: Option<String> = sqlx::query_scalar(
        "SELECT indexname FROM pg_indexes \
         WHERE schemaname = 'public' AND tablename = 'tasks' AND indexname = 'idx_tasks_tags_gin'",
    )
    .fetch_optional(&pool)
    .await
    .expect("tasks.tags index");
    assert_eq!(tags_index.as_deref(), Some("idx_tasks_tags_gin"));
    let push_tables: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM information_schema.tables \
         WHERE table_schema = 'public' \
           AND table_name IN ('push_subscriptions', 'push_deliveries', 'push_test_usage')",
    )
    .fetch_one(&pool)
    .await
    .expect("push tables");
    assert_eq!(push_tables, 3);

    let app = build_router(AppState::new(pool, config).unwrap()).unwrap();
    let response = app
        .oneshot(
            Request::builder()
                .uri("/readyz")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);

    let body = response.into_body().collect().await.unwrap().to_bytes();
    let value: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(value["status"], "ready");
    assert_eq!(value["checks"]["migrations"], "ok");
    assert_eq!(value["checks"]["mail"], "ok");
}

#[tokio::test]
#[ignore = "requires PostgreSQL; set DATABASE_URL and pass --ignored"]
async fn production_code_is_handed_to_mailer_and_not_returned() {
    dotenvy::dotenv().ok();
    let database_url = std::env::var("DATABASE_URL")
        .expect("DATABASE_URL must point at a disposable PostgreSQL test database");
    let pool = PgPoolOptions::new()
        .max_connections(2)
        .connect(&database_url)
        .await
        .expect("connect to test PostgreSQL");
    sqlx::migrate!("../../db/postgres/migrations")
        .run(&pool)
        .await
        .expect("apply migrations");

    let mut config = Config::for_test();
    config.app_env = AppEnv::Production;
    config.database_url = database_url;
    let mailer = Arc::new(RecordingMailer {
        sent: Mutex::new(Vec::new()),
        ready: true,
    });
    let app = build_router(AppState::with_mailer(pool.clone(), config, mailer.clone())).unwrap();
    let email = format!("mailer-{}@example.com", uuid::Uuid::new_v4());
    let body = format!("{{\"email\":\"{email}\"}}");

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/v1/auth/code/request")
                .header(CONTENT_TYPE, "application/json")
                .body(Body::from(body))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::ACCEPTED);
    let response_body = response.into_body().collect().await.unwrap().to_bytes();
    let response_text = String::from_utf8(response_body.to_vec()).unwrap();
    assert!(response_text.is_empty());

    {
        let sent = mailer.sent.lock().unwrap();
        assert_eq!(sent.len(), 1);
        assert_eq!(sent[0].0, email);
        assert_eq!(sent[0].1.len(), 6);
        assert!(!response_text.contains(&sent[0].1));
    }

    sqlx::query("DELETE FROM auth_codes WHERE email_normalized = $1")
        .bind(&email)
        .execute(&pool)
        .await
        .unwrap();
}

#[tokio::test]
#[ignore = "requires PostgreSQL; set DATABASE_URL and pass --ignored"]
async fn readiness_fails_when_mail_configuration_is_not_ready() {
    dotenvy::dotenv().ok();
    let database_url = std::env::var("DATABASE_URL")
        .expect("DATABASE_URL must point at a disposable PostgreSQL test database");
    let pool = PgPoolOptions::new()
        .max_connections(1)
        .connect(&database_url)
        .await
        .expect("connect to test PostgreSQL");
    sqlx::migrate!("../../db/postgres/migrations")
        .run(&pool)
        .await
        .expect("apply migrations");
    let mut config = Config::for_test();
    config.database_url = database_url;
    let mailer = Arc::new(RecordingMailer {
        sent: Mutex::new(Vec::new()),
        ready: false,
    });
    let app = build_router(AppState::with_mailer(pool, config, mailer)).unwrap();
    let response = app
        .oneshot(
            Request::builder()
                .uri("/readyz")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    let body = response.into_body().collect().await.unwrap().to_bytes();
    let value: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(value["code"], "NOT_READY");
    assert_eq!(value["checks"]["mail"], "failed");
    assert_eq!(value["checks"]["database"], "ok");
}

#[tokio::test]
async fn unauthenticated_device_listing_uses_json_error_contract() {
    let mut config = Config::for_test();
    config.database_url = "postgres://todo:todo@127.0.0.1/todo_test".to_owned();
    let pool = PgPoolOptions::new()
        .max_connections(1)
        .connect_lazy(&config.database_url)
        .expect("create lazy test pool");
    let app = build_router(AppState::new(pool, config).unwrap()).unwrap();

    let response = app
        .oneshot(
            Request::builder()
                .uri("/api/v1/devices")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    assert_eq!(
        response
            .headers()
            .get(CONTENT_TYPE)
            .and_then(|value| value.to_str().ok()),
        Some("application/json")
    );
    let body = response.into_body().collect().await.unwrap().to_bytes();
    let value: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(value["code"], "UNAUTHORIZED");
}

#[tokio::test]
#[ignore = "requires PostgreSQL; set DATABASE_URL and pass --ignored"]
async fn tags_round_trip_through_sync_bootstrap_and_export() {
    dotenvy::dotenv().ok();
    let database_url = std::env::var("DATABASE_URL")
        .expect("DATABASE_URL must point at a disposable PostgreSQL test database");
    let mut config = Config::for_test();
    config.database_url = database_url.clone();
    let pool = PgPoolOptions::new()
        .max_connections(2)
        .connect(&database_url)
        .await
        .expect("connect to test PostgreSQL");
    sqlx::migrate!("../../db/postgres/migrations")
        .run(&pool)
        .await
        .expect("apply migrations");
    let app = build_router(AppState::new(pool.clone(), config).unwrap()).unwrap();

    let email = format!("tags-{}@example.com", Uuid::new_v4());
    let device_id = Uuid::new_v4();
    let (status, _) = request_json(
        &app,
        Method::POST,
        "/api/v1/auth/code/request",
        None,
        json!({ "email": email }),
    )
    .await;
    assert_eq!(status, StatusCode::ACCEPTED);
    let (status, tokens) = request_json(
        &app,
        Method::POST,
        "/api/v1/auth/code/verify",
        None,
        json!({
            "email": email,
            "code": "246810",
            "device_id": device_id,
            "platform": "web",
            "device_name": "tags-test"
        }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let token = tokens["access_token"]
        .as_str()
        .expect("access token")
        .to_owned();

    let list_id = Uuid::new_v4();
    let task_id = Uuid::new_v4();
    let list_op = Uuid::new_v4();
    let task_op = Uuid::new_v4();
    let (status, created) = request_json(
        &app,
        Method::POST,
        "/api/v1/sync",
        Some(&token),
        json!({
            "device_id": device_id,
            "cursor": "0",
            "limit": 100,
            "ops": [
                {
                    "op_id": list_op,
                    "client_seq": 1,
                    "entity": "list",
                    "entity_id": list_id,
                    "kind": "create",
                    "patch": {
                        "name": "Tags",
                        "color": "#3d66d9",
                        "icon": null,
                        "rank": "000001"
                    }
                },
                {
                    "op_id": task_op,
                    "client_seq": 2,
                    "entity": "task",
                    "entity_id": task_id,
                    "kind": "create",
                    "patch": {
                        "list_id": list_id,
                        "title": "Tagged task",
                        "tags": [" Work ", "work", "#Home", "home"],
                        "rank": "000001"
                    }
                }
            ]
        }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(created["ack"][1]["status"], "applied");
    let task_change = created["changes"]
        .as_array()
        .unwrap()
        .iter()
        .find(|change| change["entity"] == "task" && change["entity_id"] == task_id.to_string())
        .expect("task change");
    assert_eq!(task_change["patch"]["tags"], json!(["Work", "Home"]));

    let (status, bootstrap) = request_json(
        &app,
        Method::GET,
        "/api/v1/sync/bootstrap?limit=500",
        Some(&token),
        json!({}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let bootstrap_task = bootstrap["entities"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entity| entity["entity"] == "task" && entity["entity_id"] == task_id.to_string())
        .expect("bootstrap task");
    assert_eq!(bootstrap_task["data"]["tags"], json!(["Work", "Home"]));

    let (status, export) =
        request_json(&app, Method::GET, "/api/v1/export", Some(&token), json!({})).await;
    assert_eq!(status, StatusCode::OK);
    let export_task = export["tasks"]
        .as_array()
        .unwrap()
        .iter()
        .find(|task| task["id"] == task_id.to_string())
        .expect("exported task");
    assert_eq!(export_task["tags"], json!(["Work", "Home"]));

    let (status, patched) = request_json(
        &app,
        Method::POST,
        "/api/v1/sync",
        Some(&token),
        json!({
            "device_id": device_id,
            "cursor": created["next_cursor"],
            "limit": 100,
            "ops": [{
                "op_id": Uuid::new_v4(),
                "client_seq": 3,
                "entity": "task",
                "entity_id": task_id,
                "kind": "patch",
                "patch": { "tags": ["urgent", "#Next"] }
            }]
        }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(patched["ack"][0]["status"], "applied");
    let patch_change = patched["changes"]
        .as_array()
        .unwrap()
        .iter()
        .find(|change| change["entity"] == "task" && change["entity_id"] == task_id.to_string())
        .expect("patched task change");
    assert_eq!(patch_change["patch"]["tags"], json!(["urgent", "Next"]));

    let (status, export) =
        request_json(&app, Method::GET, "/api/v1/export", Some(&token), json!({})).await;
    assert_eq!(status, StatusCode::OK);
    let export_task = export["tasks"]
        .as_array()
        .unwrap()
        .iter()
        .find(|task| task["id"] == task_id.to_string())
        .expect("exported patched task");
    assert_eq!(export_task["tags"], json!(["urgent", "Next"]));

    let too_many_tags: Vec<String> = (0..=20).map(|index| format!("tag-{index}")).collect();
    let (status, rejected) = request_json(
        &app,
        Method::POST,
        "/api/v1/sync",
        Some(&token),
        json!({
            "device_id": device_id,
            "cursor": patched["next_cursor"],
            "limit": 100,
            "ops": [{
                "op_id": Uuid::new_v4(),
                "client_seq": 4,
                "entity": "task",
                "entity_id": task_id,
                "kind": "patch",
                "patch": { "tags": too_many_tags }
            }]
        }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(rejected["ack"][0]["status"], "rejected");
    assert_eq!(rejected["ack"][0]["error_code"], "VALIDATION_FAILED");

    sqlx::query("DELETE FROM users WHERE email_normalized = $1")
        .bind(&email)
        .execute(&pool)
        .await
        .unwrap();
}

#[tokio::test]
#[ignore = "requires PostgreSQL; set DATABASE_URL and pass --ignored"]
async fn push_subscription_upsert_delete_and_test_limit() {
    dotenvy::dotenv().ok();
    let database_url = std::env::var("DATABASE_URL")
        .expect("DATABASE_URL must point at a disposable PostgreSQL test database");
    let mut config = Config::for_test();
    config.database_url = database_url.clone();
    config.push = Some(push_config());
    let pool = PgPoolOptions::new()
        .max_connections(3)
        .connect(&database_url)
        .await
        .expect("connect to test PostgreSQL");
    sqlx::migrate!("../../db/postgres/migrations")
        .run(&pool)
        .await
        .expect("apply migrations");

    let mailer = Arc::new(RecordingMailer {
        sent: Mutex::new(Vec::new()),
        ready: true,
    });
    let fake = Arc::new(RecordingPushSender {
        sent: Mutex::new(Vec::new()),
        error: None,
    });
    let push = PushService::new(config.push.clone().unwrap(), fake.clone());
    let app = build_router(AppState::with_mailer_and_push(
        pool.clone(),
        config.clone(),
        mailer.clone(),
        Some(push),
    ))
    .unwrap();

    let email = format!("push-{}@example.com", Uuid::new_v4());
    let device_id = Uuid::new_v4();
    let (status, _) = request_json(
        &app,
        Method::POST,
        "/api/v1/auth/code/request",
        None,
        json!({ "email": email }),
    )
    .await;
    assert_eq!(status, StatusCode::ACCEPTED);
    let (status, tokens) = request_json(
        &app,
        Method::POST,
        "/api/v1/auth/code/verify",
        None,
        json!({
            "email": email,
            "code": "246810",
            "device_id": device_id,
            "platform": "web",
            "device_name": "push-test"
        }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let token = tokens["access_token"]
        .as_str()
        .expect("access token")
        .to_owned();

    let (status, push_json) = request_json(
        &app,
        Method::GET,
        "/api/v1/push/config",
        Some(&token),
        json!({}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(push_json["enabled"], true);
    assert_eq!(push_json["public_key"], push_config().public_key);

    let endpoint = format!("https://push.example.com/send/{}", Uuid::new_v4());
    let first_key = URL_SAFE_NO_PAD.encode([5_u8; 65]);
    let second_key = URL_SAFE_NO_PAD.encode([6_u8; 65]);
    let auth_key = URL_SAFE_NO_PAD.encode([7_u8; 16]);
    let (status, first) = request_json(
        &app,
        Method::POST,
        "/api/v1/push/subscriptions",
        Some(&token),
        json!({
            "endpoint": endpoint,
            "p256dh": first_key,
            "auth": auth_key,
            "user_agent": "Browser"
        }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let subscription_id = first["id"].as_str().expect("subscription id").to_owned();
    let (status, second) = request_json(
        &app,
        Method::POST,
        "/api/v1/push/subscriptions",
        Some(&token),
        json!({
            "endpoint": endpoint,
            "p256dh": second_key,
            "auth": auth_key,
            "user_agent": "Browser updated"
        }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(second["id"], subscription_id);
    let stored: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM push_subscriptions WHERE endpoint = $1 AND failed_at IS NULL",
    )
    .bind(&endpoint)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(stored, 1);

    for _ in 0..5 {
        let (status, result) = request_json(
            &app,
            Method::POST,
            "/api/v1/push/test",
            Some(&token),
            json!({}),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(result["sent"], 1);
    }
    let (status, limited) = request_json(
        &app,
        Method::POST,
        "/api/v1/push/test",
        Some(&token),
        json!({}),
    )
    .await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(limited["code"], "PUSH_TEST_RATE_LIMITED");

    let (status, _) = request_json(
        &app,
        Method::DELETE,
        "/api/v1/push/subscriptions",
        Some(&token),
        json!({ "endpoint": endpoint }),
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let stored: i64 =
        sqlx::query_scalar("SELECT count(*) FROM push_subscriptions WHERE endpoint = $1")
            .bind(&endpoint)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(stored, 0);

    let mut disabled_config = config.clone();
    disabled_config.push = None;
    let disabled =
        build_router(AppState::with_mailer(pool.clone(), disabled_config, mailer)).unwrap();
    let (status, disabled_config) = request_json(
        &disabled,
        Method::GET,
        "/api/v1/push/config",
        Some(&token),
        json!({}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(disabled_config["enabled"], false);
    let (status, disabled_error) = request_json(
        &disabled,
        Method::POST,
        "/api/v1/push/subscriptions",
        Some(&token),
        json!({
            "endpoint": "https://push.example.com/send/disabled",
            "p256dh": second_key,
            "auth": auth_key
        }),
    )
    .await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(disabled_error["code"], "PUSH_DISABLED");

    sqlx::query("DELETE FROM users WHERE email_normalized = $1")
        .bind(&email)
        .execute(&pool)
        .await
        .unwrap();
}

#[tokio::test]
#[ignore = "requires PostgreSQL; set DATABASE_URL and pass --ignored"]
async fn push_worker_deduplicates_task_deliveries() {
    dotenvy::dotenv().ok();
    let database_url = std::env::var("DATABASE_URL")
        .expect("DATABASE_URL must point at a disposable PostgreSQL test database");
    let mut config = Config::for_test();
    config.database_url = database_url.clone();
    let pool = PgPoolOptions::new()
        .max_connections(2)
        .connect(&database_url)
        .await
        .expect("connect to test PostgreSQL");
    sqlx::migrate!("../../db/postgres/migrations")
        .run(&pool)
        .await
        .expect("apply migrations");

    let user_id = Uuid::new_v4();
    let subscription_id = Uuid::new_v4();
    let task_id = Uuid::new_v4();
    let email = format!("worker-{}@example.com", Uuid::new_v4());
    sqlx::query("INSERT INTO users (id, email_normalized) VALUES ($1, $2)")
        .bind(user_id)
        .bind(&email)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth) \
         VALUES ($1, $2, $3, $4, $5)",
    )
    .bind(subscription_id)
    .bind(user_id)
    .bind(format!(
        "https://push.example.com/worker/{}",
        Uuid::new_v4()
    ))
    .bind(URL_SAFE_NO_PAD.encode([8_u8; 65]))
    .bind(URL_SAFE_NO_PAD.encode([9_u8; 16]))
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO tasks (id, user_id, title, note, status, remind_at) \
         VALUES ($1, $2, 'Due task', 'Worker test', 'open', now() - interval '1 minute')",
    )
    .bind(task_id)
    .bind(user_id)
    .execute(&pool)
    .await
    .unwrap();

    let fake = Arc::new(RecordingPushSender {
        sent: Mutex::new(Vec::new()),
        error: None,
    });
    let service = PushService::new(
        PushConfig {
            public_key: URL_SAFE_NO_PAD.encode([3_u8; 65]),
            private_key: URL_SAFE_NO_PAD.encode([4_u8; 32]),
            subject: "mailto:push-test@example.com".to_owned(),
        },
        fake.clone(),
    );
    let state = AppState::with_mailer(
        pool.clone(),
        config,
        Arc::new(RecordingMailer {
            sent: Mutex::new(Vec::new()),
            ready: true,
        }),
    );
    let first = run_worker_once(&state, &service).await.unwrap();
    assert!(first.sent >= 1);
    let second = run_worker_once(&state, &service).await.unwrap();
    assert!(second.skipped >= 1);
    let delivered: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM push_deliveries WHERE task_id = $1 AND subscription_id = $2",
    )
    .bind(task_id)
    .bind(subscription_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(delivered, 1);
    {
        let sent = fake.sent.lock().unwrap();
        let payload = sent
            .iter()
            .find(|(id, _)| *id == subscription_id)
            .map(|(_, payload)| payload)
            .expect("task payload");
        assert_eq!(payload["taskId"], task_id.to_string());
        assert_eq!(payload["url"], format!("/?task={task_id}"));
    }

    sqlx::query("DELETE FROM push_deliveries WHERE task_id = $1 AND subscription_id = $2")
        .bind(task_id)
        .bind(subscription_id)
        .execute(&pool)
        .await
        .unwrap();
    let gone_service = PushService::new(
        push_config(),
        Arc::new(RecordingPushSender {
            sent: Mutex::new(Vec::new()),
            error: Some(PushSendError::Gone),
        }),
    );
    let gone = run_worker_once(&state, &gone_service).await.unwrap();
    assert!(gone.failed >= 1);
    let failed: bool =
        sqlx::query_scalar("SELECT failed_at IS NOT NULL FROM push_subscriptions WHERE id = $1")
            .bind(subscription_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert!(failed);

    sqlx::query("UPDATE push_subscriptions SET failed_at = NULL WHERE id = $1")
        .bind(subscription_id)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("DELETE FROM push_deliveries WHERE task_id = $1 AND subscription_id = $2")
        .bind(task_id)
        .bind(subscription_id)
        .execute(&pool)
        .await
        .unwrap();
    let transient_service = PushService::new(
        push_config(),
        Arc::new(RecordingPushSender {
            sent: Mutex::new(Vec::new()),
            error: Some(PushSendError::Transient),
        }),
    );
    let transient = run_worker_once(&state, &transient_service).await.unwrap();
    assert!(transient.failed >= 1);
    let failed: bool =
        sqlx::query_scalar("SELECT failed_at IS NOT NULL FROM push_subscriptions WHERE id = $1")
            .bind(subscription_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert!(!failed);
    let delivered: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM push_deliveries WHERE task_id = $1 AND subscription_id = $2",
    )
    .bind(task_id)
    .bind(subscription_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(delivered, 0, "transient errors must release their claim");

    sqlx::query("DELETE FROM users WHERE id = $1")
        .bind(user_id)
        .execute(&pool)
        .await
        .unwrap();
}

async fn request_json(
    app: &Router,
    method: Method,
    uri: &str,
    token: Option<&str>,
    body: Value,
) -> (StatusCode, Value) {
    let mut builder = Request::builder()
        .method(method)
        .uri(uri)
        .header(CONTENT_TYPE, "application/json");
    if let Some(token) = token {
        builder = builder.header(AUTHORIZATION, format!("Bearer {token}"));
    }
    let response = app
        .clone()
        .oneshot(
            builder
                .body(Body::from(serde_json::to_vec(&body).unwrap()))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    let value = if bytes.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&bytes).unwrap_or(Value::Null)
    };
    (status, value)
}

#[tokio::test]
#[ignore = "requires PostgreSQL; set DATABASE_URL and pass --ignored"]
async fn replayed_sync_operation_returns_the_original_receipt() {
    dotenvy::dotenv().ok();
    let database_url = std::env::var("DATABASE_URL")
        .expect("DATABASE_URL must point at a disposable PostgreSQL test database");
    let mut config = Config::for_test();
    config.database_url = database_url.clone();
    let pool = PgPoolOptions::new()
        .max_connections(2)
        .connect(&database_url)
        .await
        .expect("connect to test PostgreSQL");
    sqlx::migrate!("../../db/postgres/migrations")
        .run(&pool)
        .await
        .expect("apply migrations");
    let app = build_router(AppState::new(pool.clone(), config).unwrap()).unwrap();

    let email = format!("sync-{}@example.com", Uuid::new_v4());
    let device_id = Uuid::new_v4();
    let (status, _) = request_json(
        &app,
        Method::POST,
        "/api/v1/auth/code/request",
        None,
        json!({ "email": email }),
    )
    .await;
    assert_eq!(status, StatusCode::ACCEPTED);
    let (status, tokens) = request_json(
        &app,
        Method::POST,
        "/api/v1/auth/code/verify",
        None,
        json!({
            "email": email,
            "code": "246810",
            "device_id": device_id,
            "platform": "web",
            "device_name": "idempotency-test"
        }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let token = tokens["access_token"]
        .as_str()
        .expect("access token")
        .to_owned();

    let list_id = Uuid::new_v4();
    let op_id = Uuid::new_v4();
    let list_name = format!("Idempotent {}", Uuid::new_v4());
    let batch = json!({
        "device_id": device_id,
        "cursor": "0",
        "limit": 100,
        "ops": [{
            "op_id": op_id,
            "client_seq": 1,
            "entity": "list",
            "entity_id": list_id,
            "kind": "create",
            "patch": {
                "name": list_name,
                "color": "#3d66d9",
                "icon": null,
                "rank": "000001"
            }
        }]
    });

    let (status, first) = request_json(
        &app,
        Method::POST,
        "/api/v1/sync",
        Some(&token),
        batch.clone(),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(first["ack"][0]["status"], "applied");
    let first_server_seq = first["ack"][0]["server_seq"].as_i64().expect("server_seq");
    assert_eq!(
        first["changes"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|change| change["op_id"] == op_id.to_string())
            .count(),
        1
    );

    let (status, replay) =
        request_json(&app, Method::POST, "/api/v1/sync", Some(&token), batch).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(replay["ack"][0]["status"], "applied");
    assert_eq!(replay["ack"][0]["server_seq"], first_server_seq);
    assert_eq!(
        replay["changes"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|change| change["op_id"] == op_id.to_string())
            .count(),
        1
    );

    let stored: i64 =
        sqlx::query_scalar("SELECT count(*) FROM lists WHERE name = $1 AND deleted_at IS NULL")
            .bind(&list_name)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(stored, 1);

    let user_id: Uuid = sqlx::query_scalar("SELECT id FROM users WHERE email_normalized = $1")
        .bind(&email)
        .fetch_one(&pool)
        .await
        .unwrap();
    sqlx::query("UPDATE account_sync_state SET min_available_seq = $1 WHERE user_id = $2")
        .bind(first_server_seq + 1)
        .bind(user_id)
        .execute(&pool)
        .await
        .unwrap();
    let (status, expired) = request_json(
        &app,
        Method::POST,
        "/api/v1/sync",
        Some(&token),
        json!({ "device_id": device_id, "cursor": "0", "limit": 100, "ops": [] }),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(expired["code"], "CURSOR_EXPIRED");
}
