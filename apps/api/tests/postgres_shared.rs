//! PostgreSQL integration coverage for the v1 shared-list API.

use std::sync::Arc;

use async_trait::async_trait;
use axum::{
    Router,
    body::Body,
    http::{Method, Request, StatusCode, header::AUTHORIZATION, header::CONTENT_TYPE},
};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use sqlx::postgres::PgPoolOptions;
use todo_api::{
    AppState, build_router,
    config::Config,
    mail::{MailError, MailProvider},
};
use tower::ServiceExt;
use uuid::Uuid;

struct NoopMailer;

#[async_trait]
impl MailProvider for NoopMailer {
    async fn send_auth_code(
        &self,
        _recipient: &str,
        _code: &str,
        _ttl_seconds: i64,
    ) -> Result<(), MailError> {
        Ok(())
    }

    fn is_ready(&self) -> bool {
        true
    }

    fn kind(&self) -> &'static str {
        "noop"
    }
}

async fn request_json(
    app: &Router,
    method: Method,
    uri: &str,
    token: Option<&str>,
    if_match: Option<&str>,
    body: Value,
) -> (StatusCode, Value) {
    let mut builder = Request::builder()
        .method(method)
        .uri(uri)
        .header(CONTENT_TYPE, "application/json");
    if let Some(token) = token {
        builder = builder.header(AUTHORIZATION, format!("Bearer {token}"));
    }
    if let Some(if_match) = if_match {
        builder = builder.header("if-match", if_match);
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

async fn login(app: &Router, email: &str, device_id: Uuid) -> String {
    let (status, _) = request_json(
        app,
        Method::POST,
        "/api/v1/auth/code/request",
        None,
        None,
        json!({ "email": email }),
    )
    .await;
    assert_eq!(status, StatusCode::ACCEPTED);
    let (status, tokens) = request_json(
        app,
        Method::POST,
        "/api/v1/auth/code/verify",
        None,
        None,
        json!({
            "email": email,
            "code": "246810",
            "device_id": device_id,
            "platform": "web",
            "device_name": "shared-test"
        }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    tokens["access_token"]
        .as_str()
        .expect("access token")
        .to_owned()
}

#[tokio::test]
#[ignore = "requires PostgreSQL; set DATABASE_URL and pass --ignored"]
async fn shared_lists_permissions_revisions_members_and_tasks() {
    dotenvy::dotenv().ok();
    let database_url = std::env::var("DATABASE_URL")
        .expect("DATABASE_URL must point at a disposable PostgreSQL test database");
    let mut config = Config::for_test();
    config.database_url = database_url.clone();
    let pool = PgPoolOptions::new()
        .max_connections(4)
        .connect(&database_url)
        .await
        .expect("connect to test PostgreSQL");
    sqlx::migrate!("../../db/postgres/migrations")
        .run(&pool)
        .await
        .expect("apply migrations");
    let app = build_router(AppState::with_mailer(
        pool.clone(),
        config,
        Arc::new(NoopMailer),
    ))
    .unwrap();

    let owner_email = format!("shared-owner-{}@example.com", Uuid::new_v4());
    let editor_email = format!("shared-editor-{}@example.com", Uuid::new_v4());
    let viewer_email = format!("shared-viewer-{}@example.com", Uuid::new_v4());
    let outsider_email = format!("shared-outsider-{}@example.com", Uuid::new_v4());
    let owner = login(&app, &owner_email, Uuid::new_v4()).await;
    let editor = login(&app, &editor_email, Uuid::new_v4()).await;
    let viewer = login(&app, &viewer_email, Uuid::new_v4()).await;
    let outsider = login(&app, &outsider_email, Uuid::new_v4()).await;

    let (status, created) = request_json(
        &app,
        Method::POST,
        "/api/v1/shared/lists",
        Some(&owner),
        None,
        json!({ "name": "Team list", "color": "#3d66d9", "icon": "users" }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(created["role"], "owner");
    assert_eq!(created["revision"], 1);
    let list_id = created["id"].as_str().expect("list id").to_owned();
    let list_path = format!("/api/v1/shared/lists/{list_id}");

    let (status, lists) = request_json(
        &app,
        Method::GET,
        "/api/v1/shared/lists",
        Some(&owner),
        None,
        json!({}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(lists.as_array().unwrap().len(), 1);
    let (status, lists) = request_json(
        &app,
        Method::GET,
        "/api/v1/shared/lists",
        Some(&editor),
        None,
        json!({}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert!(lists.as_array().unwrap().is_empty());

    let (status, member) = request_json(
        &app,
        Method::POST,
        &format!("{list_path}/members"),
        Some(&owner),
        None,
        json!({ "email": editor_email, "role": "editor", "revision": 1 }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(member["role"], "editor");
    let editor_id = member["user_id"].as_str().expect("editor id").to_owned();
    let (status, member) = request_json(
        &app,
        Method::POST,
        &format!("{list_path}/members"),
        Some(&owner),
        Some("\"2\""),
        json!({ "email": viewer_email, "role": "viewer" }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(member["role"], "viewer");

    let (status, snapshot) = request_json(
        &app,
        Method::GET,
        &list_path,
        Some(&editor),
        None,
        json!({}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(snapshot["revision"], 3);
    assert_eq!(snapshot["list"]["role"], "editor");
    assert_eq!(snapshot["members"].as_array().unwrap().len(), 3);
    let (status, snapshot) = request_json(
        &app,
        Method::GET,
        &list_path,
        Some(&viewer),
        None,
        json!({}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(snapshot["list"]["role"], "viewer");

    let (status, forbidden) = request_json(
        &app,
        Method::POST,
        &format!("{list_path}/tasks"),
        Some(&viewer),
        Some("\"3\""),
        json!({ "title": "Viewer cannot write" }),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(forbidden["code"], "SHARED_LIST_FORBIDDEN");
    let (status, hidden) = request_json(
        &app,
        Method::GET,
        &list_path,
        Some(&outsider),
        None,
        json!({}),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(hidden["code"], "SHARED_LIST_NOT_FOUND");

    let task_id = Uuid::new_v4();
    let create_op = Uuid::new_v4();
    let create_body = json!({
        "id": task_id,
        "title": "Ship shared task",
        "note": "First shared task",
        "important": true,
        "due_on": "2026-11-01",
        "op_id": create_op
    });
    let (status, task) = request_json(
        &app,
        Method::POST,
        &format!("{list_path}/tasks"),
        Some(&editor),
        Some("\"3\""),
        create_body.clone(),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(task["title"], "Ship shared task");
    assert_eq!(task["revision"], 4);
    let (status, replayed) = request_json(
        &app,
        Method::POST,
        &format!("{list_path}/tasks"),
        Some(&editor),
        Some("\"3\""),
        create_body,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(replayed["id"], task_id.to_string());
    assert_eq!(replayed["revision"], 4);
    let task_id = task_id.to_string();
    let task_path = format!("{list_path}/tasks/{task_id}");

    let (status, task) = request_json(
        &app,
        Method::PATCH,
        &task_path,
        Some(&editor),
        None,
        json!({ "title": "Ship shared task v2", "status": "completed", "revision": 4 }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(task["status"], "completed");
    assert_eq!(task["revision"], 5);

    let (status, conflict) = request_json(
        &app,
        Method::PATCH,
        &task_path,
        Some(&editor),
        None,
        json!({ "title": "Stale", "revision": 4 }),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(conflict["code"], "REVISION_CONFLICT");
    assert_eq!(conflict["current_revision"], 5);

    let (status, member) = request_json(
        &app,
        Method::PATCH,
        &format!("{list_path}/members/{editor_id}"),
        Some(&owner),
        None,
        json!({ "role": "viewer", "revision": 5 }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(member["role"], "viewer");
    let (status, forbidden) = request_json(
        &app,
        Method::PATCH,
        &task_path,
        Some(&editor),
        Some("\"6\""),
        json!({ "title": "Demoted editor cannot write" }),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(forbidden["code"], "SHARED_LIST_FORBIDDEN");

    let (status, member_id) =
        request_json(&app, Method::GET, &list_path, Some(&owner), None, json!({})).await;
    assert_eq!(status, StatusCode::OK);
    let viewer_id = member_id["members"]
        .as_array()
        .unwrap()
        .iter()
        .find(|member| member["email"] == viewer_email)
        .and_then(|member| member["user_id"].as_str())
        .expect("viewer member id")
        .to_owned();
    let (status, _) = request_json(
        &app,
        Method::DELETE,
        &format!("{list_path}/members/{viewer_id}"),
        Some(&owner),
        Some("\"6\""),
        json!({}),
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let (status, hidden) = request_json(
        &app,
        Method::GET,
        &list_path,
        Some(&viewer),
        None,
        json!({}),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(hidden["code"], "SHARED_LIST_NOT_FOUND");

    let owner_id: Uuid = sqlx::query_scalar("SELECT id FROM users WHERE email_normalized = $1")
        .bind(&owner_email)
        .fetch_one(&pool)
        .await
        .unwrap();
    let (status, cannot_remove_self) = request_json(
        &app,
        Method::DELETE,
        &format!("{list_path}/members/{owner_id}"),
        Some(&owner),
        Some("\"7\""),
        json!({}),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(cannot_remove_self["code"], "VALIDATION_FAILED");

    let (status, _) = request_json(
        &app,
        Method::DELETE,
        &task_path,
        Some(&owner),
        Some("\"7\""),
        json!({}),
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let (status, snapshot) =
        request_json(&app, Method::GET, &list_path, Some(&owner), None, json!({})).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(snapshot["revision"], 8);
    assert!(snapshot["tasks"].as_array().unwrap().is_empty());

    let (status, _) = request_json(
        &app,
        Method::DELETE,
        &list_path,
        Some(&owner),
        Some("\"8\""),
        json!({}),
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let (status, hidden) =
        request_json(&app, Method::GET, &list_path, Some(&owner), None, json!({})).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(hidden["code"], "SHARED_LIST_NOT_FOUND");

    for email in [owner_email, editor_email, viewer_email, outsider_email] {
        sqlx::query("DELETE FROM users WHERE email_normalized = $1")
            .bind(email)
            .execute(&pool)
            .await
            .unwrap();
    }
}
