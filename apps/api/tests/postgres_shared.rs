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
use sqlx::{PgPool, postgres::PgPoolOptions};
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

async fn setup() -> (Router, PgPool) {
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
    (app, pool)
}

async fn get(app: &Router, uri: &str, token: &str) -> (StatusCode, Value) {
    request_json(app, Method::GET, uri, Some(token), None, json!({})).await
}

async fn post(app: &Router, uri: &str, token: &str, body: Value) -> (StatusCode, Value) {
    request_json(app, Method::POST, uri, Some(token), None, body).await
}

fn invitation_path(invitation_id: &str, action: &str) -> String {
    format!("/api/v1/shared/invitations/{invitation_id}/{action}")
}

/// Owner-side invite; asserts the pending invitation and returns its id.
async fn invite(
    app: &Router,
    list_path: &str,
    owner: &str,
    email: &str,
    role: &str,
    revision: i64,
) -> String {
    let (status, invitation) = post(
        app,
        &format!("{list_path}/members"),
        owner,
        json!({ "email": email, "role": role, "revision": revision }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "invite {email}: {invitation}");
    assert_eq!(invitation["status"], "pending");
    assert_eq!(invitation["email"], email);
    assert_eq!(invitation["role"], role);
    assert_eq!(invitation["revision"], revision + 1);
    invitation["id"].as_str().expect("invitation id").to_owned()
}

async fn member_id(app: &Router, list_path: &str, owner: &str, email: &str) -> String {
    let (status, snapshot) = get(app, list_path, owner).await;
    assert_eq!(status, StatusCode::OK);
    snapshot["members"]
        .as_array()
        .unwrap()
        .iter()
        .find(|member| member["email"] == email)
        .and_then(|member| member["user_id"].as_str())
        .expect("member id")
        .to_owned()
}

async fn delete_users(pool: &PgPool, emails: &[&str]) {
    for email in emails {
        sqlx::query("DELETE FROM users WHERE email_normalized = $1")
            .bind(email)
            .execute(pool)
            .await
            .unwrap();
    }
}

#[tokio::test]
#[ignore = "requires PostgreSQL; set DATABASE_URL and pass --ignored"]
async fn shared_lists_permissions_revisions_members_and_tasks() {
    let (app, pool) = setup().await;

    let owner_email = format!("shared-owner-{}@example.com", Uuid::new_v4());
    let editor_email = format!("shared-editor-{}@example.com", Uuid::new_v4());
    let viewer_email = format!("shared-viewer-{}@example.com", Uuid::new_v4());
    let outsider_email = format!("shared-outsider-{}@example.com", Uuid::new_v4());
    let owner = login(&app, &owner_email, Uuid::new_v4()).await;
    let editor = login(&app, &editor_email, Uuid::new_v4()).await;
    let viewer = login(&app, &viewer_email, Uuid::new_v4()).await;
    let outsider = login(&app, &outsider_email, Uuid::new_v4()).await;

    let (status, created) = post(
        &app,
        "/api/v1/shared/lists",
        &owner,
        json!({ "name": "Team list", "color": "#3d66d9", "icon": "users" }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(created["role"], "owner");
    assert_eq!(created["revision"], 1);
    let list_id = created["id"].as_str().expect("list id").to_owned();
    let list_path = format!("/api/v1/shared/lists/{list_id}");

    let (status, lists) = get(&app, "/api/v1/shared/lists", &owner).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(lists.as_array().unwrap().len(), 1);
    let (status, lists) = get(&app, "/api/v1/shared/lists", &editor).await;
    assert_eq!(status, StatusCode::OK);
    assert!(lists.as_array().unwrap().is_empty());

    // Adding a member creates a pending invitation; membership starts on accept.
    let editor_invitation = invite(&app, &list_path, &owner, &editor_email, "editor", 1).await;
    let (status, invitation) = request_json(
        &app,
        Method::POST,
        &format!("{list_path}/members"),
        Some(&owner),
        Some("\"2\""),
        json!({ "email": viewer_email, "role": "viewer" }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(invitation["role"], "viewer");
    assert_eq!(invitation["revision"], 3);
    let viewer_invitation = invitation["id"].as_str().unwrap().to_owned();

    let (status, hidden) = get(&app, &list_path, &editor).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(hidden["code"], "SHARED_LIST_NOT_FOUND");

    let (status, accepted) = post(
        &app,
        &invitation_path(&editor_invitation, "accept"),
        &editor,
        json!({}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(accepted["role"], "editor");
    assert_eq!(accepted["revision"], 4);
    let (status, accepted) = post(
        &app,
        &invitation_path(&viewer_invitation, "accept"),
        &viewer,
        json!({}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(accepted["role"], "viewer");
    assert_eq!(accepted["revision"], 5);

    let (status, snapshot) = get(&app, &list_path, &editor).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(snapshot["revision"], 5);
    assert_eq!(snapshot["list"]["role"], "editor");
    assert_eq!(snapshot["members"].as_array().unwrap().len(), 3);
    let (status, snapshot) = get(&app, &list_path, &viewer).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(snapshot["list"]["role"], "viewer");

    let (status, forbidden) = request_json(
        &app,
        Method::POST,
        &format!("{list_path}/tasks"),
        Some(&viewer),
        Some("\"5\""),
        json!({ "title": "Viewer cannot write" }),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(forbidden["code"], "SHARED_LIST_FORBIDDEN");
    let (status, hidden) = get(&app, &list_path, &outsider).await;
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
        Some("\"5\""),
        create_body.clone(),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(task["title"], "Ship shared task");
    assert_eq!(task["revision"], 6);
    let (status, replayed) = request_json(
        &app,
        Method::POST,
        &format!("{list_path}/tasks"),
        Some(&editor),
        Some("\"5\""),
        create_body,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(replayed["id"], task_id.to_string());
    assert_eq!(replayed["revision"], 6);
    let task_id = task_id.to_string();
    let task_path = format!("{list_path}/tasks/{task_id}");

    let (status, task) = request_json(
        &app,
        Method::PATCH,
        &task_path,
        Some(&editor),
        None,
        json!({ "title": "Ship shared task v2", "status": "completed", "revision": 6 }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(task["status"], "completed");
    assert_eq!(task["revision"], 7);

    let (status, conflict) = request_json(
        &app,
        Method::PATCH,
        &task_path,
        Some(&editor),
        None,
        json!({ "title": "Stale", "revision": 6 }),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(conflict["code"], "REVISION_CONFLICT");
    assert_eq!(conflict["current_revision"], 7);

    let editor_id = member_id(&app, &list_path, &owner, &editor_email).await;
    let (status, member) = request_json(
        &app,
        Method::PATCH,
        &format!("{list_path}/members/{editor_id}"),
        Some(&owner),
        None,
        json!({ "role": "viewer", "revision": 7 }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(member["role"], "viewer");
    let (status, forbidden) = request_json(
        &app,
        Method::PATCH,
        &task_path,
        Some(&editor),
        Some("\"8\""),
        json!({ "title": "Demoted editor cannot write" }),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(forbidden["code"], "SHARED_LIST_FORBIDDEN");

    let viewer_id = member_id(&app, &list_path, &owner, &viewer_email).await;
    let (status, _) = request_json(
        &app,
        Method::DELETE,
        &format!("{list_path}/members/{viewer_id}"),
        Some(&owner),
        Some("\"8\""),
        json!({}),
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    // A removed member is told access was revoked (403), unlike a stranger (404).
    let (status, revoked) = get(&app, &list_path, &viewer).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(revoked["code"], "SHARED_LIST_ACCESS_REVOKED");
    let (status, revoked) = request_json(
        &app,
        Method::PATCH,
        &task_path,
        Some(&viewer),
        Some("\"9\""),
        json!({ "title": "Removed member cannot write" }),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(revoked["code"], "SHARED_LIST_ACCESS_REVOKED");

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
        Some("\"9\""),
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
        Some("\"9\""),
        json!({}),
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let (status, snapshot) = get(&app, &list_path, &owner).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(snapshot["revision"], 10);
    assert!(snapshot["tasks"].as_array().unwrap().is_empty());

    let (status, _) = request_json(
        &app,
        Method::DELETE,
        &list_path,
        Some(&owner),
        Some("\"10\""),
        json!({}),
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let (status, hidden) = get(&app, &list_path, &owner).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(hidden["code"], "SHARED_LIST_NOT_FOUND");
    // Once the list itself is gone a former member also sees 404.
    let (status, hidden) = get(&app, &list_path, &viewer).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(hidden["code"], "SHARED_LIST_NOT_FOUND");

    delete_users(
        &pool,
        &[&owner_email, &editor_email, &viewer_email, &outsider_email],
    )
    .await;
}

#[tokio::test]
#[ignore = "requires PostgreSQL; set DATABASE_URL and pass --ignored"]
async fn shared_list_invitations_accept_decline_and_visibility() {
    let (app, pool) = setup().await;

    let owner_email = format!("invite-owner-{}@example.com", Uuid::new_v4());
    let invitee_email = format!("invite-invitee-{}@example.com", Uuid::new_v4());
    let decliner_email = format!("invite-decliner-{}@example.com", Uuid::new_v4());
    let outsider_email = format!("invite-outsider-{}@example.com", Uuid::new_v4());
    let late_email = format!("invite-late-{}@example.com", Uuid::new_v4());
    let owner = login(&app, &owner_email, Uuid::new_v4()).await;
    let invitee = login(&app, &invitee_email, Uuid::new_v4()).await;
    let decliner = login(&app, &decliner_email, Uuid::new_v4()).await;
    let outsider = login(&app, &outsider_email, Uuid::new_v4()).await;

    let (status, created) = post(
        &app,
        "/api/v1/shared/lists",
        &owner,
        json!({ "name": "Invite list" }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let list_id = created["id"].as_str().expect("list id").to_owned();
    let list_path = format!("/api/v1/shared/lists/{list_id}");
    let members_path = format!("{list_path}/members");

    // Invitations never grant ownership, and active members cannot be re-invited.
    let (status, rejected) = post(
        &app,
        &members_path,
        &owner,
        json!({ "email": invitee_email, "role": "owner", "revision": 1 }),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(rejected["code"], "VALIDATION_FAILED");
    let (status, rejected) = post(
        &app,
        &members_path,
        &owner,
        json!({ "email": owner_email, "role": "editor", "revision": 1 }),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(rejected["code"], "SHARED_MEMBER_EXISTS");

    // Invite with an op_id; replaying it returns the same invitation without a bump.
    let invite_op = Uuid::new_v4();
    let invite_body = json!({
        "email": invitee_email,
        "role": "viewer",
        "revision": 1,
        "op_id": invite_op
    });
    let (status, first) = post(&app, &members_path, &owner, invite_body.clone()).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(first["revision"], 2);
    let invitee_invitation = first["id"].as_str().unwrap().to_owned();
    let (status, replayed) = post(&app, &members_path, &owner, invite_body).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(replayed["id"], invitee_invitation.as_str());
    assert_eq!(replayed["revision"], 2);

    // Re-inviting a pending address updates the same invitation.
    let (status, updated) = post(
        &app,
        &members_path,
        &owner,
        json!({ "email": invitee_email, "role": "editor", "revision": 2 }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(updated["id"], invitee_invitation.as_str());
    assert_eq!(updated["role"], "editor");
    assert_eq!(updated["revision"], 3);

    let decliner_invitation = invite(&app, &list_path, &owner, &decliner_email, "editor", 3).await;
    // An address with no account yet still gets a pending invitation.
    let late_invitation = invite(&app, &list_path, &owner, &late_email, "viewer", 4).await;

    let (status, snapshot) = get(&app, &list_path, &owner).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(snapshot["revision"], 5);
    assert_eq!(snapshot["members"].as_array().unwrap().len(), 1);
    assert_eq!(snapshot["invitations"].as_array().unwrap().len(), 3);

    let (status, mine) = get(&app, "/api/v1/shared/invitations", &invitee).await;
    assert_eq!(status, StatusCode::OK);
    let mine = mine.as_array().unwrap();
    assert_eq!(mine.len(), 1);
    assert_eq!(mine[0]["id"], invitee_invitation.as_str());
    assert_eq!(mine[0]["list_id"], list_id.as_str());
    assert_eq!(mine[0]["list_name"], "Invite list");
    assert_eq!(mine[0]["role"], "editor");
    assert_eq!(mine[0]["invited_by_email"], owner_email.as_str());

    // Nobody can see or answer an invitation addressed to someone else.
    let (status, theirs) = get(&app, "/api/v1/shared/invitations", &outsider).await;
    assert_eq!(status, StatusCode::OK);
    assert!(theirs.as_array().unwrap().is_empty());
    for action in ["accept", "decline"] {
        let (status, hidden) = post(
            &app,
            &invitation_path(&invitee_invitation, action),
            &outsider,
            json!({}),
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_eq!(hidden["code"], "SHARED_INVITATION_NOT_FOUND");
    }

    // A pending invitee is not a member yet.
    let (status, hidden) = get(&app, &list_path, &invitee).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(hidden["code"], "SHARED_LIST_NOT_FOUND");

    let accept_op = Uuid::new_v4();
    let accept_path = invitation_path(&invitee_invitation, "accept");
    let (status, accepted) =
        post(&app, &accept_path, &invitee, json!({ "op_id": accept_op })).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(accepted["id"], list_id.as_str());
    assert_eq!(accepted["role"], "editor");
    assert_eq!(accepted["revision"], 6);
    let (status, again) = post(&app, &accept_path, &invitee, json!({ "op_id": accept_op })).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(again["revision"], 6);
    let (status, again) = post(&app, &accept_path, &invitee, json!({})).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(again["role"], "editor");

    let (status, mine) = get(&app, "/api/v1/shared/invitations", &invitee).await;
    assert_eq!(status, StatusCode::OK);
    assert!(mine.as_array().unwrap().is_empty());
    let (status, snapshot) = get(&app, &list_path, &invitee).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(snapshot["revision"], 6);
    assert_eq!(snapshot["list"]["role"], "editor");
    assert_eq!(snapshot["members"].as_array().unwrap().len(), 2);
    // Only owners see pending invitations.
    assert!(snapshot["invitations"].as_array().unwrap().is_empty());

    let (status, task) = post(
        &app,
        &format!("{list_path}/tasks"),
        &invitee,
        json!({ "title": "Accepted editor writes", "revision": 6 }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(task["revision"], 7);
    let task_path = format!("{list_path}/tasks/{}", task["id"].as_str().unwrap());

    let (status, forbidden) = post(
        &app,
        &members_path,
        &invitee,
        json!({ "email": outsider_email, "role": "viewer", "revision": 7 }),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(forbidden["code"], "SHARED_LIST_FORBIDDEN");
    let (status, rejected) = post(
        &app,
        &members_path,
        &owner,
        json!({ "email": invitee_email, "role": "viewer", "revision": 7 }),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(rejected["code"], "SHARED_MEMBER_EXISTS");

    let decline_path = invitation_path(&decliner_invitation, "decline");
    let (status, _) = post(&app, &decline_path, &decliner, json!({})).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let (status, _) = post(&app, &decline_path, &decliner, json!({})).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let (status, answered) = post(
        &app,
        &invitation_path(&decliner_invitation, "accept"),
        &decliner,
        json!({}),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(answered["code"], "SHARED_INVITATION_NOT_PENDING");
    let (status, hidden) = get(&app, &list_path, &decliner).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(hidden["code"], "SHARED_LIST_NOT_FOUND");

    let (status, snapshot) = get(&app, &list_path, &owner).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(snapshot["revision"], 8);
    let pending = snapshot["invitations"].as_array().unwrap();
    assert_eq!(pending.len(), 1);
    assert_eq!(pending[0]["email"], late_email.as_str());

    // The unregistered address sees its invitation after signing up; viewers stay read-only.
    let late = login(&app, &late_email, Uuid::new_v4()).await;
    let (status, mine) = get(&app, "/api/v1/shared/invitations", &late).await;
    assert_eq!(status, StatusCode::OK);
    let mine = mine.as_array().unwrap();
    assert_eq!(mine.len(), 1);
    assert_eq!(mine[0]["id"], late_invitation.as_str());
    let (status, accepted) = post(
        &app,
        &invitation_path(&late_invitation, "accept"),
        &late,
        json!({}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(accepted["role"], "viewer");
    assert_eq!(accepted["revision"], 9);
    let (status, forbidden) = post(
        &app,
        &format!("{list_path}/tasks"),
        &late,
        json!({ "title": "Viewer cannot write", "revision": 9 }),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(forbidden["code"], "SHARED_LIST_FORBIDDEN");

    // Removing a member revokes access; the old invitation cannot be replayed.
    let invitee_id = member_id(&app, &list_path, &owner, &invitee_email).await;
    let (status, _) = request_json(
        &app,
        Method::DELETE,
        &format!("{members_path}/{invitee_id}"),
        Some(&owner),
        Some("\"9\""),
        json!({}),
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let (status, revoked) = get(&app, &list_path, &invitee).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(revoked["code"], "SHARED_LIST_ACCESS_REVOKED");
    let (status, revoked) = request_json(
        &app,
        Method::PATCH,
        &task_path,
        Some(&invitee),
        Some("\"10\""),
        json!({ "title": "Removed editor cannot write" }),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(revoked["code"], "SHARED_LIST_ACCESS_REVOKED");
    let (status, answered) = post(&app, &accept_path, &invitee, json!({})).await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(answered["code"], "SHARED_INVITATION_NOT_PENDING");

    // A fresh invitation restores access with the newly granted role.
    let reinvite = invite(&app, &list_path, &owner, &invitee_email, "viewer", 10).await;
    let (status, accepted) = post(
        &app,
        &invitation_path(&reinvite, "accept"),
        &invitee,
        json!({}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(accepted["role"], "viewer");
    assert_eq!(accepted["revision"], 12);
    let (status, snapshot) = get(&app, &list_path, &invitee).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(snapshot["list"]["role"], "viewer");

    // Invitations to a deleted list disappear and cannot be accepted.
    let outsider_invitation = invite(&app, &list_path, &owner, &outsider_email, "editor", 12).await;
    let (status, _) = request_json(
        &app,
        Method::DELETE,
        &list_path,
        Some(&owner),
        Some("\"13\""),
        json!({}),
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let (status, mine) = get(&app, "/api/v1/shared/invitations", &outsider).await;
    assert_eq!(status, StatusCode::OK);
    assert!(mine.as_array().unwrap().is_empty());
    let (status, hidden) = post(
        &app,
        &invitation_path(&outsider_invitation, "accept"),
        &outsider,
        json!({}),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(hidden["code"], "SHARED_INVITATION_NOT_FOUND");

    delete_users(
        &pool,
        &[
            &owner_email,
            &invitee_email,
            &decliner_email,
            &outsider_email,
            &late_email,
        ],
    )
    .await;
}
