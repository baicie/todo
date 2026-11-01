//! Boundary and abuse-case coverage for the HTTP API (docs/roadmap-v2/05-quality.md §2).
//!
//! Tests without `#[ignore]` are hermetic: they use a lazy pool and only reach
//! code paths that reject the request before any database access. The ignored
//! tests need a disposable PostgreSQL database:
//!
//!   DATABASE_URL=postgres://todo:todo@127.0.0.1:5432/todo \
//!     cargo test -p todo-api --test postgres_boundaries -- --ignored --skip known_defect_
//!
//! Tests named `known_defect_*` describe the intended contract for defects that
//! are tracked but not fixed in this change. CI skips them by name; run them
//! explicitly to check whether a defect is still present.

use std::{sync::Arc, time::Duration};

use async_trait::async_trait;
use axum::{
    Router,
    body::Body,
    http::{
        HeaderValue, Method, Request, StatusCode,
        header::{AUTHORIZATION, CONTENT_LENGTH, CONTENT_TYPE, COOKIE, ORIGIN},
    },
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

const DEV_CODE: &str = "246810";

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

struct Reply {
    status: StatusCode,
    content_type: Option<String>,
    body: Value,
}

impl Reply {
    /// Every 4xx/5xx must use the `{code, message}` JSON envelope.
    #[track_caller]
    fn assert_error(&self, status: StatusCode, code: &str) {
        self.assert_error_in("", status, code);
    }

    #[track_caller]
    fn assert_error_in(&self, context: &str, status: StatusCode, code: &str) {
        assert_eq!(
            self.status, status,
            "{context}: unexpected status; body: {}",
            self.body
        );
        assert_eq!(
            self.content_type.as_deref(),
            Some("application/json"),
            "{context}: error responses must use the JSON contract; body: {}",
            self.body
        );
        assert_eq!(self.body["code"], code, "{context}: body: {}", self.body);
        assert!(
            self.body["message"].is_string(),
            "{context}: error responses carry a message; body: {}",
            self.body
        );
    }

    #[track_caller]
    fn assert_status(&self, status: StatusCode) {
        assert_eq!(
            self.status, status,
            "unexpected status; body: {}",
            self.body
        );
    }
}

fn request(
    method: Method,
    uri: &str,
    token: Option<&str>,
    content_type: Option<&str>,
    body: impl Into<Body>,
) -> Request<Body> {
    let mut builder = Request::builder().method(method).uri(uri);
    if let Some(content_type) = content_type {
        builder = builder.header(CONTENT_TYPE, content_type);
    }
    if let Some(token) = token {
        builder = builder.header(AUTHORIZATION, format!("Bearer {token}"));
    }
    builder.body(body.into()).unwrap()
}

fn json_request(method: Method, uri: &str, token: Option<&str>, body: &Value) -> Request<Body> {
    request(
        method,
        uri,
        token,
        Some("application/json"),
        serde_json::to_vec(body).unwrap(),
    )
}

/// A body one byte over the configured limit. `with_length` controls whether a
/// Content-Length header announces the size (rejected by the limit layer) or
/// the body is only discovered to be too large while it is read.
fn oversized_request(
    method: Method,
    uri: &str,
    token: Option<&str>,
    with_length: bool,
) -> Request<Body> {
    let size = Config::for_test().max_body_bytes + 1;
    let mut request = request(
        method,
        uri,
        token,
        Some("application/json"),
        vec![b' '; size],
    );
    if with_length {
        request
            .headers_mut()
            .insert(CONTENT_LENGTH, HeaderValue::from(size));
    }
    request
}

async fn send(app: &Router, request: Request<Body>) -> Reply {
    let response = app.clone().oneshot(request).await.unwrap();
    let status = response.status();
    let content_type = response
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned);
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    let body = if bytes.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&bytes)
            .unwrap_or_else(|_| Value::String(String::from_utf8_lossy(&bytes).into_owned()))
    };
    Reply {
        status,
        content_type,
        body,
    }
}

/// Router whose pool never connects. Any test that unexpectedly reaches the
/// database fails fast instead of hanging.
fn hermetic_app() -> Router {
    let config = Config::for_test();
    let pool = PgPoolOptions::new()
        .max_connections(1)
        .acquire_timeout(Duration::from_secs(2))
        .connect_lazy("postgres://todo:todo@127.0.0.1:1/unreachable")
        .expect("lazy pool");
    build_router(AppState::with_mailer(pool, config, Arc::new(NoopMailer))).unwrap()
}

/// Malformed payloads shared by every JSON route. None of them may reach a
/// handler or produce a non-JSON error.
const MALFORMED_BODIES: &[&str] = &[
    "{",
    "{\"email\":}",
    "not json",
    "null",
    "123",
    "\"string\"",
    "{\"email\": 1}",
    "{\"email\": \"a@example.com\", \"email\": \"b@example.com\"}",
];

#[tokio::test]
async fn auth_routes_reject_malformed_json_with_json_errors() {
    let app = hermetic_app();
    for uri in [
        "/api/v1/auth/code/request",
        "/api/v1/auth/code/verify",
        "/api/v1/auth/refresh",
    ] {
        for body in MALFORMED_BODIES {
            let reply = send(
                &app,
                request(
                    Method::POST,
                    uri,
                    None,
                    Some("application/json"),
                    body.to_string(),
                ),
            )
            .await;
            assert_eq!(reply.status, StatusCode::BAD_REQUEST, "{uri} {body}");
            reply.assert_error(StatusCode::BAD_REQUEST, "VALIDATION_FAILED");
        }
    }
}

#[tokio::test]
async fn auth_routes_reject_unknown_fields() {
    let app = hermetic_app();
    let cases = [
        (
            "/api/v1/auth/code/request",
            json!({ "email": "a@example.com", "user_id": Uuid::new_v4() }),
        ),
        (
            "/api/v1/auth/code/verify",
            json!({
                "email": "a@example.com",
                "code": DEV_CODE,
                "device_id": Uuid::new_v4(),
                "platform": "linux",
                "device_name": "x",
                "role": "admin"
            }),
        ),
        (
            "/api/v1/auth/refresh",
            json!({ "refresh_token": "abc", "user_id": Uuid::new_v4() }),
        ),
    ];
    for (uri, body) in cases {
        let reply = send(&app, json_request(Method::POST, uri, None, &body)).await;
        reply.assert_error(StatusCode::BAD_REQUEST, "VALIDATION_FAILED");
    }
}

#[tokio::test]
async fn json_routes_require_a_json_content_type() {
    let app = hermetic_app();
    let body = json!({ "email": "a@example.com" }).to_string();
    for content_type in [
        None,
        Some("text/plain"),
        Some("application/x-www-form-urlencoded"),
    ] {
        let reply = send(
            &app,
            request(
                Method::POST,
                "/api/v1/auth/code/request",
                None,
                content_type,
                body.clone(),
            ),
        )
        .await;
        reply.assert_error(StatusCode::BAD_REQUEST, "VALIDATION_FAILED");
    }
    let reply = send(
        &app,
        request(
            Method::POST,
            "/api/v1/auth/refresh",
            None,
            Some("text/plain"),
            json!({ "refresh_token": "abc" }).to_string(),
        ),
    )
    .await;
    reply.assert_error(StatusCode::BAD_REQUEST, "VALIDATION_FAILED");
}

#[tokio::test]
async fn oversized_bodies_return_json_413() {
    let app = hermetic_app();
    // With Content-Length the limit layer rejects before routing or
    // authentication, so authenticated routes are covered here too.
    for uri in [
        "/api/v1/auth/code/request",
        "/api/v1/auth/code/verify",
        "/api/v1/auth/refresh",
        "/api/v1/sync",
        "/api/v1/shared/lists",
        "/api/v1/push/subscriptions",
    ] {
        let reply = send(&app, oversized_request(Method::POST, uri, None, true)).await;
        reply.assert_error(StatusCode::PAYLOAD_TOO_LARGE, "PAYLOAD_TOO_LARGE");
    }
    // Without Content-Length the body is rejected while it is read. Only
    // unauthenticated routes read the body before the database here; the
    // authenticated equivalents are covered by the PostgreSQL tests.
    for uri in [
        "/api/v1/auth/code/request",
        "/api/v1/auth/code/verify",
        "/api/v1/auth/refresh",
    ] {
        let reply = send(&app, oversized_request(Method::POST, uri, None, false)).await;
        reply.assert_error(StatusCode::PAYLOAD_TOO_LARGE, "PAYLOAD_TOO_LARGE");
    }
}

#[tokio::test]
async fn code_routes_validate_fields_before_touching_the_database() {
    let app = hermetic_app();
    for email in ["", "no-at-sign", "a@b", "a@@example.com", ".a@example.com"] {
        let reply = send(
            &app,
            json_request(
                Method::POST,
                "/api/v1/auth/code/request",
                None,
                &json!({ "email": email }),
            ),
        )
        .await;
        reply.assert_error(StatusCode::BAD_REQUEST, "VALIDATION_FAILED");
    }

    let valid = json!({
        "email": "a@example.com",
        "code": DEV_CODE,
        "device_id": Uuid::new_v4(),
        "platform": "linux",
        "device_name": "boundary"
    });
    let invalid_fields = [
        ("code", json!("12345")),
        ("code", json!("123456789")),
        ("code", json!("12a456")),
        ("code", json!(123456)),
        ("device_name", json!("")),
        ("device_name", json!("   ")),
        ("device_name", json!("x".repeat(101))),
        ("platform", json!("beos")),
        ("device_id", json!("not-a-uuid")),
        ("email", json!("not-an-email")),
    ];
    for (field, value) in invalid_fields {
        let mut body = valid.clone();
        body[field] = value.clone();
        let reply = send(
            &app,
            json_request(Method::POST, "/api/v1/auth/code/verify", None, &body),
        )
        .await;
        assert_eq!(reply.status, StatusCode::BAD_REQUEST, "{field}={value}");
        reply.assert_error(StatusCode::BAD_REQUEST, "VALIDATION_FAILED");
    }

    // Web sign-in sets a cookie, so it is protected against login CSRF.
    let mut web = valid.clone();
    web["platform"] = json!("web");
    let mut cross_site = json_request(Method::POST, "/api/v1/auth/code/verify", None, &web);
    cross_site
        .headers_mut()
        .insert(ORIGIN, HeaderValue::from_static("https://evil.example"));
    send(&app, cross_site)
        .await
        .assert_error(StatusCode::FORBIDDEN, "ORIGIN_NOT_ALLOWED");
}

#[tokio::test]
async fn refresh_requires_exactly_one_credential() {
    let app = hermetic_app();
    let empty = request(
        Method::POST,
        "/api/v1/auth/refresh",
        None,
        None,
        Body::empty(),
    );
    send(&app, empty)
        .await
        .assert_error(StatusCode::UNAUTHORIZED, "UNAUTHORIZED");

    let empty_token = json_request(
        Method::POST,
        "/api/v1/auth/refresh",
        None,
        &json!({ "refresh_token": "" }),
    );
    send(&app, empty_token)
        .await
        .assert_error(StatusCode::BAD_REQUEST, "VALIDATION_FAILED");

    let mut both = json_request(
        Method::POST,
        "/api/v1/auth/refresh",
        None,
        &json!({ "refresh_token": "body-token" }),
    );
    both.headers_mut().insert(
        COOKIE,
        HeaderValue::from_static("todo_refresh=cookie-token"),
    );
    send(&app, both)
        .await
        .assert_error(StatusCode::BAD_REQUEST, "VALIDATION_FAILED");

    let mut cross_site = request(
        Method::POST,
        "/api/v1/auth/refresh",
        None,
        None,
        Body::empty(),
    );
    cross_site.headers_mut().insert(
        COOKIE,
        HeaderValue::from_static("todo_refresh=cookie-token"),
    );
    cross_site
        .headers_mut()
        .insert(ORIGIN, HeaderValue::from_static("https://evil.example"));
    send(&app, cross_site)
        .await
        .assert_error(StatusCode::FORBIDDEN, "ORIGIN_NOT_ALLOWED");
}

#[tokio::test]
async fn authenticated_routes_reject_missing_and_malformed_tokens() {
    let app = hermetic_app();
    let routes = [
        (Method::POST, "/api/v1/sync"),
        (Method::GET, "/api/v1/export"),
        (Method::GET, "/api/v1/sync/bootstrap"),
        (Method::GET, "/api/v1/shared/lists"),
        (Method::POST, "/api/v1/shared/lists"),
        (Method::POST, "/api/v1/push/subscriptions"),
        (Method::DELETE, "/api/v1/account"),
    ];
    for (method, uri) in routes {
        let body = json!({});
        let missing = json_request(method.clone(), uri, None, &body);
        send(&app, missing)
            .await
            .assert_error(StatusCode::UNAUTHORIZED, "UNAUTHORIZED");

        let mut basic = json_request(method.clone(), uri, None, &body);
        basic.headers_mut().insert(
            AUTHORIZATION,
            HeaderValue::from_static("Basic dG9kbzp0b2Rv"),
        );
        send(&app, basic)
            .await
            .assert_error(StatusCode::UNAUTHORIZED, "UNAUTHORIZED");

        for token in ["garbage", "a.b.c", &"x".repeat(9000)] {
            let forged = json_request(method.clone(), uri, Some(token), &body);
            send(&app, forged)
                .await
                .assert_error(StatusCode::UNAUTHORIZED, "INVALID_TOKEN");
        }
    }
}

#[tokio::test]
async fn unsupported_methods_use_the_json_404_contract() {
    let app = hermetic_app();
    for (method, uri) in [
        (Method::POST, "/api/v1/export"),
        (Method::GET, "/api/v1/sync"),
        (Method::PUT, "/api/v1/shared/lists"),
        (Method::GET, "/api/v1/auth/refresh"),
    ] {
        send(&app, request(method, uri, None, None, Body::empty()))
            .await
            .assert_error(StatusCode::NOT_FOUND, "NOT_FOUND");
    }
}

// ---------------------------------------------------------------------------
// PostgreSQL-backed boundaries
// ---------------------------------------------------------------------------

async fn pg_app() -> (Router, PgPool) {
    dotenvy::dotenv().ok();
    let database_url = std::env::var("DATABASE_URL")
        .expect("DATABASE_URL must point at a disposable PostgreSQL test database");
    let pool = PgPoolOptions::new()
        .max_connections(4)
        .connect(&database_url)
        .await
        .expect("connect to test PostgreSQL");
    sqlx::migrate!("../../db/postgres/migrations")
        .run(&pool)
        .await
        .expect("apply migrations");
    let mut config = Config::for_test();
    config.database_url = database_url;
    // The global sign-in budget is shared by every test using this database.
    config.auth_code_global_requests_per_window = 100_000;
    // Some tests sign the same address in on a second device.
    config.auth_code_resend_seconds = 0;
    let state = AppState::with_mailer(pool.clone(), config, Arc::new(NoopMailer));
    (build_router(state).unwrap(), pool)
}

struct Session {
    email: String,
    user_id: Uuid,
    device_id: Uuid,
    access: String,
    refresh: String,
}

async fn login(app: &Router, pool: &PgPool, label: &str) -> Session {
    let email = format!("{label}-{}@example.com", Uuid::new_v4());
    login_device(app, pool, &email, Uuid::new_v4()).await
}

async fn login_device(app: &Router, pool: &PgPool, email: &str, device_id: Uuid) -> Session {
    send(
        app,
        json_request(
            Method::POST,
            "/api/v1/auth/code/request",
            None,
            &json!({ "email": email }),
        ),
    )
    .await
    .assert_status(StatusCode::ACCEPTED);
    let reply = send(
        app,
        json_request(
            Method::POST,
            "/api/v1/auth/code/verify",
            None,
            &json!({
                "email": email,
                "code": DEV_CODE,
                "device_id": device_id,
                "platform": "linux",
                "device_name": "boundary-test"
            }),
        ),
    )
    .await;
    reply.assert_status(StatusCode::OK);
    let user_id = sqlx::query_scalar("SELECT id FROM users WHERE email_normalized = $1")
        .bind(email.to_ascii_lowercase())
        .fetch_one(pool)
        .await
        .unwrap();
    Session {
        email: email.to_owned(),
        user_id,
        device_id,
        access: reply.body["access_token"].as_str().unwrap().to_owned(),
        refresh: reply.body["refresh_token"].as_str().unwrap().to_owned(),
    }
}

fn op(client_seq: i64, entity: &str, entity_id: Uuid, kind: &str, patch: Value) -> Value {
    json!({
        "op_id": Uuid::new_v4(),
        "client_seq": client_seq,
        "entity": entity,
        "entity_id": entity_id,
        "kind": kind,
        "patch": patch
    })
}

async fn sync(app: &Router, session: &Session, ops: Value) -> Reply {
    send(
        app,
        json_request(
            Method::POST,
            "/api/v1/sync",
            Some(&session.access),
            &json!({ "device_id": session.device_id, "cursor": "0", "ops": ops }),
        ),
    )
    .await
}

/// Sends one op and returns its ack. The request itself must succeed.
async fn sync_one(app: &Router, session: &Session, op: Value) -> Value {
    let reply = sync(app, session, json!([op])).await;
    reply.assert_status(StatusCode::OK);
    reply.body["ack"][0].clone()
}

async fn watermark(pool: &PgPool, session: &Session) -> i64 {
    sqlx::query_scalar("SELECT last_client_seq FROM devices WHERE user_id = $1 AND id = $2")
        .bind(session.user_id)
        .bind(session.device_id)
        .fetch_one(pool)
        .await
        .unwrap()
}

async fn count(pool: &PgPool, sql: &str, id: Uuid) -> i64 {
    sqlx::query_scalar(sql)
        .bind(id)
        .fetch_one(pool)
        .await
        .unwrap()
}

#[tokio::test]
#[ignore = "requires PostgreSQL; set DATABASE_URL and pass --ignored"]
async fn sync_rejects_malformed_requests_with_json_errors() {
    let (app, pool) = pg_app().await;
    let session = login(&app, &pool, "sync-malformed").await;
    let token = Some(session.access.as_str());
    let base = json!({ "device_id": session.device_id, "cursor": "0", "ops": [] });

    for body in [
        "{",
        "null",
        "[]",
        "{\"device_id\": \"x\"}",
        "{\"cursor\": \"0\"}",
    ] {
        let request = request(
            Method::POST,
            "/api/v1/sync",
            token,
            Some("application/json"),
            body.to_owned(),
        );
        send(&app, request).await.assert_error_in(
            body,
            StatusCode::BAD_REQUEST,
            "VALIDATION_FAILED",
        );
    }

    let valid_op = op(1, "list", Uuid::new_v4(), "create", json!({ "name": "x" }));
    let mut invalid_bodies = Vec::new();
    let mut unknown_top = base.clone();
    unknown_top["user_id"] = json!(Uuid::new_v4());
    invalid_bodies.push(("unknown top-level field", unknown_top));
    for (field, value) in [
        ("user_id", json!(Uuid::new_v4())),
        ("client_seq", json!("1")),
        ("client_seq", json!(1.5)),
        ("entity", json!("user")),
        ("kind", json!("upsert")),
        ("op_id", json!("not-a-uuid")),
        ("entity_id", json!(null)),
    ] {
        let mut bad_op = valid_op.clone();
        bad_op[field] = value;
        let mut body = base.clone();
        body["ops"] = json!([bad_op]);
        invalid_bodies.push((field, body));
    }
    for limit in [json!(0), json!(501), json!(-1), json!("10")] {
        let mut body = base.clone();
        body["limit"] = limit;
        invalid_bodies.push(("limit", body));
    }
    for cursor in [json!("-1"), json!("abc"), json!("1.5"), json!(""), json!(0)] {
        let mut body = base.clone();
        body["cursor"] = cursor;
        invalid_bodies.push(("cursor", body));
    }
    let too_many: Vec<Value> = (1..=101)
        .map(|seq| {
            op(
                seq,
                "list",
                Uuid::new_v4(),
                "create",
                json!({ "name": "x" }),
            )
        })
        .collect();
    let mut body = base.clone();
    body["ops"] = json!(too_many);
    invalid_bodies.push(("101 ops", body));
    for (context, body) in invalid_bodies {
        send(
            &app,
            json_request(Method::POST, "/api/v1/sync", token, &body),
        )
        .await
        .assert_error_in(context, StatusCode::BAD_REQUEST, "VALIDATION_FAILED");
    }

    let mut ahead = base.clone();
    ahead["cursor"] = json!("999999");
    send(
        &app,
        json_request(Method::POST, "/api/v1/sync", token, &ahead),
    )
    .await
    .assert_error(StatusCode::BAD_REQUEST, "INVALID_CURSOR");

    let mut other_device = base.clone();
    other_device["device_id"] = json!(Uuid::new_v4());
    send(
        &app,
        json_request(Method::POST, "/api/v1/sync", token, &other_device),
    )
    .await
    .assert_error(StatusCode::FORBIDDEN, "DEVICE_MISMATCH");

    // Authenticated routes read the body after the session lookup, so a body
    // without Content-Length is only rejected by the streaming limit.
    send(
        &app,
        oversized_request(Method::POST, "/api/v1/sync", token, false),
    )
    .await
    .assert_error(StatusCode::PAYLOAD_TOO_LARGE, "PAYLOAD_TOO_LARGE");

    assert_eq!(watermark(&pool, &session).await, 0, "nothing was applied");
}

#[tokio::test]
#[ignore = "requires PostgreSQL; set DATABASE_URL and pass --ignored"]
async fn sync_enforces_client_seq_and_op_id_rules() {
    let (app, pool) = pg_app().await;
    let session = login(&app, &pool, "sync-seq").await;
    let list = |seq: i64, id: Uuid| op(seq, "list", id, "create", json!({ "name": "Seq" }));
    let lists_with_id = "SELECT count(*) FROM lists WHERE id = $1";

    sync(&app, &session, json!([list(0, Uuid::new_v4())]))
        .await
        .assert_error(StatusCode::CONFLICT, "SEQUENCE_MISMATCH");
    sync(
        &app,
        &session,
        json!([list(2, Uuid::new_v4()), list(1, Uuid::new_v4())]),
    )
    .await
    .assert_error(StatusCode::CONFLICT, "SEQUENCE_MISMATCH");
    sync(
        &app,
        &session,
        json!([list(1, Uuid::new_v4()), list(1, Uuid::new_v4())]),
    )
    .await
    .assert_error(StatusCode::CONFLICT, "SEQUENCE_MISMATCH");
    let mut first = list(1, Uuid::new_v4());
    let mut second = list(2, Uuid::new_v4());
    second["op_id"] = first["op_id"].clone();
    sync(&app, &session, json!([first.clone(), second]))
        .await
        .assert_error(StatusCode::CONFLICT, "SEQUENCE_MISMATCH");

    // A gap anywhere rolls back the whole request, including earlier ops.
    let applied_before_gap = Uuid::new_v4();
    sync(
        &app,
        &session,
        json!([list(1, applied_before_gap), list(3, Uuid::new_v4())]),
    )
    .await
    .assert_error(StatusCode::CONFLICT, "SEQUENCE_MISMATCH");
    assert_eq!(count(&pool, lists_with_id, applied_before_gap).await, 0);
    sync(&app, &session, json!([list(2, Uuid::new_v4())]))
        .await
        .assert_error(StatusCode::CONFLICT, "SEQUENCE_MISMATCH");
    assert_eq!(watermark(&pool, &session).await, 0);

    // First application, then an identical retry returns the same receipt.
    let list_id = Uuid::new_v4();
    first = list(1, list_id);
    let ack = sync_one(&app, &session, first.clone()).await;
    assert_eq!(ack["status"], "applied", "{ack}");
    let server_seq = ack["server_seq"].clone();
    let replay = sync_one(&app, &session, first.clone()).await;
    assert_eq!(replay["status"], "applied");
    assert_eq!(replay["server_seq"], server_seq);
    let op_id: Uuid = serde_json::from_value(first["op_id"].clone()).unwrap();
    let changes_for_op = "SELECT count(*) FROM change_log WHERE op_id = $1";
    assert_eq!(count(&pool, changes_for_op, op_id).await, 1);

    // op_id is the idempotency key: a different payload under the same op_id
    // and client_seq gets the original receipt and is never applied.
    let mut altered = first.clone();
    altered["patch"] = json!({ "name": "Altered" });
    let replay = sync_one(&app, &session, altered).await;
    assert_eq!(replay["server_seq"], server_seq);
    let name: String = sqlx::query_scalar("SELECT name FROM lists WHERE id = $1")
        .bind(list_id)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(name, "Seq");

    let mut moved = first.clone();
    moved["client_seq"] = json!(2);
    sync(&app, &session, json!([moved]))
        .await
        .assert_error(StatusCode::CONFLICT, "SEQUENCE_MISMATCH");
    sync(&app, &session, json!([list(1, Uuid::new_v4())]))
        .await
        .assert_error(StatusCode::CONFLICT, "SEQUENCE_MISMATCH");

    // After receipt pruning the device watermark is authoritative.
    sqlx::query("DELETE FROM op_receipts WHERE op_id = $1")
        .bind(op_id)
        .execute(&pool)
        .await
        .unwrap();
    let replay = sync_one(&app, &session, first.clone()).await;
    assert_eq!(replay["status"], "already_processed", "{replay}");
    let reused_seq = Uuid::new_v4();
    let replay = sync_one(&app, &session, list(1, reused_seq)).await;
    assert_eq!(replay["status"], "already_processed", "{replay}");
    assert_eq!(count(&pool, lists_with_id, reused_seq).await, 0);
    assert_eq!(count(&pool, changes_for_op, op_id).await, 1);

    // Rejected ops still advance the watermark and replay as rejected.
    let missing = op(2, "task", Uuid::new_v4(), "patch", json!({ "title": "x" }));
    let ack = sync_one(&app, &session, missing.clone()).await;
    assert_eq!(ack["status"], "rejected");
    assert_eq!(ack["error_code"], "ENTITY_NOT_FOUND");
    assert_eq!(watermark(&pool, &session).await, 2);
    let replay = sync_one(&app, &session, missing).await;
    assert_eq!(replay["status"], "rejected");
    assert_eq!(replay["error_code"], "ENTITY_NOT_FOUND");

    let reply = sync(
        &app,
        &session,
        json!([
            list(3, Uuid::new_v4()),
            op(4, "list", Uuid::new_v4(), "create", json!({ "name": "" })),
            list(5, Uuid::new_v4()),
        ]),
    )
    .await;
    reply.assert_status(StatusCode::OK);
    let statuses: Vec<&str> = reply.body["ack"]
        .as_array()
        .unwrap()
        .iter()
        .map(|ack| ack["status"].as_str().unwrap())
        .collect();
    assert_eq!(statuses, ["applied", "rejected", "applied"]);
    assert_eq!(watermark(&pool, &session).await, 5);

    // The op_id namespace is global: while its receipt exists, another device
    // or account cannot reuse an op_id. (`first`'s receipt was pruned above,
    // so use the batch's first op, whose receipt is still present.)
    let retained_op_id = op_id_of(&reply.body["ack"][0]);
    let second_device = login_device(&app, &pool, &session.email, Uuid::new_v4()).await;
    let mut foreign = list(1, Uuid::new_v4());
    foreign["op_id"] = json!(retained_op_id);
    sync(&app, &second_device, json!([foreign.clone()]))
        .await
        .assert_error(StatusCode::CONFLICT, "SEQUENCE_MISMATCH");
    assert_eq!(watermark(&pool, &second_device).await, 0);
    let other_account = login(&app, &pool, "sync-seq-other").await;
    sync(&app, &other_account, json!([foreign]))
        .await
        .assert_error(StatusCode::CONFLICT, "SEQUENCE_MISMATCH");
    assert_eq!(watermark(&pool, &other_account).await, 0);
}

fn op_id_of(ack: &Value) -> Uuid {
    serde_json::from_value(ack["op_id"].clone()).unwrap()
}

fn get(uri: &str, session: &Session) -> Request<Body> {
    request(Method::GET, uri, Some(&session.access), None, Body::empty())
}

#[tokio::test]
#[ignore = "requires PostgreSQL; set DATABASE_URL and pass --ignored"]
async fn sync_rejects_cross_account_references() {
    let (app, pool) = pg_app().await;
    let alice = login(&app, &pool, "xref-alice").await;
    let bob = login(&app, &pool, "xref-bob").await;
    let (list_id, task_id, step_id) = (Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4());
    let reply = sync(
        &app,
        &alice,
        json!([
            op(1, "list", list_id, "create", json!({ "name": "Alice" })),
            op(
                2,
                "task",
                task_id,
                "create",
                json!({ "title": "Alice task", "list_id": list_id })
            ),
            op(
                3,
                "step",
                step_id,
                "create",
                json!({ "task_id": task_id, "title": "Alice step" })
            ),
        ]),
    )
    .await;
    reply.assert_status(StatusCode::OK);
    assert!(
        reply.body["ack"]
            .as_array()
            .unwrap()
            .iter()
            .all(|ack| ack["status"] == "applied"),
        "{}",
        reply.body
    );

    let own_task = Uuid::new_v4();
    let attempts = [
        (
            "task under a foreign list",
            op(
                1,
                "task",
                Uuid::new_v4(),
                "create",
                json!({ "title": "x", "list_id": list_id }),
            ),
            "INVALID_PARENT",
        ),
        (
            "step under a foreign task",
            op(
                2,
                "step",
                Uuid::new_v4(),
                "create",
                json!({ "task_id": task_id, "title": "x" }),
            ),
            "INVALID_PARENT",
        ),
        (
            "day plan for a foreign task",
            op(
                3,
                "day_plan",
                Uuid::new_v4(),
                "create",
                json!({ "task_id": task_id, "local_date": "2026-11-01" }),
            ),
            "INVALID_PARENT",
        ),
        (
            "patch a foreign task",
            op(4, "task", task_id, "patch", json!({ "title": "hijacked" })),
            "ENTITY_NOT_FOUND",
        ),
        (
            "delete a foreign task",
            op(5, "task", task_id, "delete", json!({})),
            "ENTITY_NOT_FOUND",
        ),
        (
            "restore a foreign task",
            op(6, "task", task_id, "restore", json!({})),
            "ENTITY_NOT_FOUND",
        ),
        (
            "patch a foreign list",
            op(7, "list", list_id, "patch", json!({ "name": "hijacked" })),
            "ENTITY_NOT_FOUND",
        ),
        (
            "patch a foreign step",
            op(8, "step", step_id, "patch", json!({ "title": "hijacked" })),
            "ENTITY_NOT_FOUND",
        ),
        (
            "create with a foreign list id",
            op(9, "list", list_id, "create", json!({ "name": "dup" })),
            "CONSTRAINT_VIOLATION",
        ),
        (
            "create with a foreign task id",
            op(10, "task", task_id, "create", json!({ "title": "dup" })),
            "CONSTRAINT_VIOLATION",
        ),
        (
            "own task",
            op(
                11,
                "task",
                own_task,
                "create",
                json!({ "title": "Bob task" }),
            ),
            "",
        ),
        (
            "move an own task into a foreign list",
            op(12, "task", own_task, "patch", json!({ "list_id": list_id })),
            "INVALID_PARENT",
        ),
    ];
    let ops: Vec<Value> = attempts.iter().map(|(_, op, _)| op.clone()).collect();
    let reply = sync(&app, &bob, json!(ops)).await;
    reply.assert_status(StatusCode::OK);
    let acks = reply.body["ack"].as_array().unwrap();
    assert_eq!(acks.len(), attempts.len(), "{}", reply.body);
    for ((context, _, code), ack) in attempts.iter().zip(acks) {
        if code.is_empty() {
            assert_eq!(ack["status"], "applied", "{context}: {ack}");
        } else {
            assert_eq!(ack["status"], "rejected", "{context}: {ack}");
            assert_eq!(ack["error_code"], *code, "{context}: {ack}");
        }
    }

    let task: (String, bool, Option<Uuid>) =
        sqlx::query_as("SELECT title, deleted_at IS NOT NULL, list_id FROM tasks WHERE id = $1")
            .bind(task_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(task, ("Alice task".to_owned(), false, Some(list_id)));
    let list_name: String = sqlx::query_scalar("SELECT name FROM lists WHERE id = $1")
        .bind(list_id)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(list_name, "Alice");
    let step_title: String = sqlx::query_scalar("SELECT title FROM steps WHERE id = $1")
        .bind(step_id)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(step_title, "Alice step");
    let bob_list: Option<Uuid> = sqlx::query_scalar("SELECT list_id FROM tasks WHERE id = $1")
        .bind(own_task)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(bob_list, None);
}

#[tokio::test]
#[ignore = "requires PostgreSQL; set DATABASE_URL and pass --ignored"]
async fn bootstrap_and_export_are_scoped_to_the_caller() {
    let (app, pool) = pg_app().await;
    let alice = login(&app, &pool, "scope-alice").await;
    let bob = login(&app, &pool, "scope-bob").await;
    let lists = [Uuid::new_v4(), Uuid::new_v4()];
    sync(
        &app,
        &alice,
        json!([
            op(
                1,
                "list",
                lists[0],
                "create",
                json!({ "name": "Alice one" })
            ),
            op(
                2,
                "list",
                lists[1],
                "create",
                json!({ "name": "Alice two" })
            ),
        ]),
    )
    .await
    .assert_status(StatusCode::OK);

    let export = send(&app, get("/api/v1/export", &bob)).await;
    export.assert_status(StatusCode::OK);
    assert_eq!(export.body["lists"], json!([]), "{}", export.body);
    assert_eq!(export.body["user"]["email"], bob.email);
    let export = send(&app, get("/api/v1/export", &alice)).await;
    export.assert_status(StatusCode::OK);
    let mut exported: Vec<Uuid> = export.body["lists"]
        .as_array()
        .unwrap()
        .iter()
        .map(|list| serde_json::from_value(list["id"].clone()).unwrap())
        .collect();
    exported.sort();
    let mut expected = lists.to_vec();
    expected.sort();
    assert_eq!(exported, expected);

    for query in ["limit=0", "limit=501", "limit=-1", "limit=abc"] {
        send(
            &app,
            get(&format!("/api/v1/sync/bootstrap?{query}"), &alice),
        )
        .await
        .assert_error_in(query, StatusCode::BAD_REQUEST, "VALIDATION_FAILED");
    }
    send(
        &app,
        get("/api/v1/sync/bootstrap?continuation=garbage", &alice),
    )
    .await
    .assert_error(StatusCode::BAD_REQUEST, "INVALID_CONTINUATION");

    // A continuation is bound to the account that started the snapshot.
    let first_page = send(&app, get("/api/v1/sync/bootstrap?limit=1", &alice)).await;
    first_page.assert_status(StatusCode::OK);
    let continuation = first_page.body["next_page"]
        .as_str()
        .expect("a second page")
        .to_owned();
    let next = format!("/api/v1/sync/bootstrap?limit=1&continuation={continuation}");
    send(&app, get(&next, &bob))
        .await
        .assert_error(StatusCode::BAD_REQUEST, "INVALID_CONTINUATION");
    let second_page = send(&app, get(&next, &alice)).await;
    second_page.assert_status(StatusCode::OK);
    assert_eq!(
        second_page.body["entities"].as_array().unwrap().len(),
        1,
        "{}",
        second_page.body
    );
}

#[tokio::test]
#[ignore = "requires PostgreSQL; set DATABASE_URL and pass --ignored"]
async fn refresh_rotates_once_and_revokes_the_session_on_reuse() {
    let (app, pool) = pg_app().await;
    let session = login(&app, &pool, "refresh").await;
    let refresh = |token: &str| {
        json_request(
            Method::POST,
            "/api/v1/auth/refresh",
            None,
            &json!({ "refresh_token": token }),
        )
    };

    for token in ["not-a-real-token".to_owned(), "x".repeat(64 * 1024)] {
        send(&app, refresh(&token))
            .await
            .assert_error(StatusCode::UNAUTHORIZED, "INVALID_REFRESH_TOKEN");
    }

    let rotated = send(&app, refresh(&session.refresh)).await;
    rotated.assert_status(StatusCode::OK);
    let next = rotated.body["refresh_token"].as_str().unwrap().to_owned();
    assert_ne!(next, session.refresh);

    // Presenting a rotated-out token is treated as theft: the whole session,
    // including the token that replaced it, is revoked.
    send(&app, refresh(&session.refresh))
        .await
        .assert_error(StatusCode::UNAUTHORIZED, "REFRESH_TOKEN_REUSED");
    send(&app, refresh(&next))
        .await
        .assert_error(StatusCode::UNAUTHORIZED, "REFRESH_TOKEN_REUSED");
    send(&app, get("/api/v1/export", &session))
        .await
        .assert_error(StatusCode::UNAUTHORIZED, "UNAUTHORIZED");
}

#[tokio::test]
#[ignore = "requires PostgreSQL; set DATABASE_URL and pass --ignored"]
async fn sync_rejects_values_postgres_cannot_store() {
    let (app, pool) = pg_app().await;
    let session = login(&app, &pool, "sync-unstorable").await;
    let cases = [
        ("NUL in list name", "list", json!({ "name": "a\u{0}b" })),
        ("NUL in task title", "task", json!({ "title": "a\u{0}b" })),
        (
            "NUL in task note",
            "task",
            json!({ "title": "ok", "note": "a\u{0}b" }),
        ),
        (
            "NUL in a tag",
            "task",
            json!({ "title": "ok", "tags": ["a\u{0}b"] }),
        ),
        (
            "NUL in recurrence",
            "task",
            json!({ "title": "ok", "recurrence": { "rule": "a\u{0}b" } }),
        ),
        (
            "due_on before PostgreSQL's date range",
            "task",
            json!({ "title": "ok", "due_on": "-5000-01-01" }),
        ),
        (
            "remind_at before PostgreSQL's timestamp range",
            "task",
            json!({
                "title": "ok",
                "remind_at": "-5000-01-01T00:00:00Z",
                "remind_timezone": "UTC"
            }),
        ),
    ];
    let total = cases.len() as i64;
    for (index, (context, entity, patch)) in cases.into_iter().enumerate() {
        let seq = index as i64 + 1;
        let reply = sync(
            &app,
            &session,
            json!([op(seq, entity, Uuid::new_v4(), "create", patch)]),
        )
        .await;
        assert_eq!(reply.status, StatusCode::OK, "{context}: {}", reply.body);
        let ack = &reply.body["ack"][0];
        assert_eq!(ack["status"], "rejected", "{context}: {ack}");
        assert_eq!(ack["error_code"], "VALIDATION_FAILED", "{context}: {ack}");
    }
    assert_eq!(watermark(&pool, &session).await, total);
}

#[tokio::test]
#[ignore = "requires PostgreSQL; set DATABASE_URL and pass --ignored"]
async fn sign_in_rejects_device_names_postgres_cannot_store() {
    let (app, _pool) = pg_app().await;
    let email = format!("nul-device-{}@example.com", Uuid::new_v4());
    send(
        &app,
        json_request(
            Method::POST,
            "/api/v1/auth/code/request",
            None,
            &json!({ "email": email }),
        ),
    )
    .await
    .assert_status(StatusCode::ACCEPTED);
    send(
        &app,
        json_request(
            Method::POST,
            "/api/v1/auth/code/verify",
            None,
            &json!({
                "email": email,
                "code": DEV_CODE,
                "device_id": Uuid::new_v4(),
                "platform": "linux",
                "device_name": "laptop\u{0}"
            }),
        ),
    )
    .await
    .assert_error(StatusCode::BAD_REQUEST, "VALIDATION_FAILED");
}

#[tokio::test]
#[ignore = "requires PostgreSQL; set DATABASE_URL and pass --ignored"]
async fn push_routes_use_the_json_error_contract() {
    let (app, pool) = pg_app().await;
    let session = login(&app, &pool, "push-contract").await;
    let token = Some(session.access.as_str());
    let uri = "/api/v1/push/subscriptions";
    for method in [Method::POST, Method::DELETE] {
        for body in ["{", "null", "[]", "{\"endpoint\": 1}"] {
            let request = request(
                method.clone(),
                uri,
                token,
                Some("application/json"),
                body.to_owned(),
            );
            send(&app, request).await.assert_error_in(
                &format!("{method} {body}"),
                StatusCode::BAD_REQUEST,
                "VALIDATION_FAILED",
            );
        }
        let unknown = json!({
            "endpoint": "https://push.example/sub",
            "p256dh": "AAAA",
            "auth": "AAAA",
            "user_id": Uuid::new_v4()
        });
        send(&app, json_request(method.clone(), uri, token, &unknown))
            .await
            .assert_error_in(
                &format!("{method} unknown field"),
                StatusCode::BAD_REQUEST,
                "VALIDATION_FAILED",
            );
        let plain = request(
            method.clone(),
            uri,
            token,
            Some("text/plain"),
            json!({ "endpoint": "https://push.example/sub" }).to_string(),
        );
        send(&app, plain).await.assert_error_in(
            &format!("{method} text/plain"),
            StatusCode::BAD_REQUEST,
            "VALIDATION_FAILED",
        );
    }
}

// ---------------------------------------------------------------------------
// Shared lists: permission matrix (owner / editor / viewer / non-member)
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, Debug)]
enum Actor {
    Owner,
    Editor,
    Viewer,
    Outsider,
}

impl Actor {
    const ALL: [Self; 4] = [Self::Owner, Self::Editor, Self::Viewer, Self::Outsider];

    fn rank(self) -> u8 {
        match self {
            Self::Owner => 3,
            Self::Editor => 2,
            Self::Viewer => 1,
            Self::Outsider => 0,
        }
    }
}

struct SharedUsers {
    owner: Session,
    editor: Session,
    viewer: Session,
    outsider: Session,
}

impl SharedUsers {
    async fn login(app: &Router, pool: &PgPool) -> Self {
        Self {
            owner: login(app, pool, "matrix-owner").await,
            editor: login(app, pool, "matrix-editor").await,
            viewer: login(app, pool, "matrix-viewer").await,
            outsider: login(app, pool, "matrix-outsider").await,
        }
    }

    fn get(&self, actor: Actor) -> &Session {
        match actor {
            Actor::Owner => &self.owner,
            Actor::Editor => &self.editor,
            Actor::Viewer => &self.viewer,
            Actor::Outsider => &self.outsider,
        }
    }
}

/// A shared list at revision 1 with one task, the three member roles, one more
/// viewer (`target_id`) for the member routes to act on, and a registered
/// non-member (`candidate_email`) to invite. Rows are written directly so the
/// matrix does not depend on how membership is granted.
struct SharedFixture {
    list_id: Uuid,
    task_id: Uuid,
    target_id: Uuid,
    candidate_email: String,
}

async fn shared_fixture(pool: &PgPool, users: &SharedUsers) -> SharedFixture {
    let fixture = SharedFixture {
        list_id: Uuid::new_v4(),
        task_id: Uuid::new_v4(),
        target_id: Uuid::new_v4(),
        candidate_email: format!("matrix-candidate-{}@example.com", Uuid::new_v4()),
    };
    let target_email = format!("matrix-target-{}@example.com", Uuid::new_v4());
    let mut tx = pool.begin().await.unwrap();
    for (id, email) in [
        (fixture.target_id, target_email.as_str()),
        (Uuid::new_v4(), fixture.candidate_email.as_str()),
    ] {
        sqlx::query("INSERT INTO users (id, email_normalized) VALUES ($1, $2)")
            .bind(id)
            .bind(email)
            .execute(&mut *tx)
            .await
            .unwrap();
    }
    sqlx::query("INSERT INTO shared_lists (id, owner_id, name) VALUES ($1, $2, 'Matrix')")
        .bind(fixture.list_id)
        .bind(users.owner.user_id)
        .execute(&mut *tx)
        .await
        .unwrap();
    for (user_id, role) in [
        (users.owner.user_id, "owner"),
        (users.editor.user_id, "editor"),
        (users.viewer.user_id, "viewer"),
        (fixture.target_id, "viewer"),
    ] {
        sqlx::query("INSERT INTO shared_list_members (list_id, user_id, role) VALUES ($1, $2, $3)")
            .bind(fixture.list_id)
            .bind(user_id)
            .bind(role)
            .execute(&mut *tx)
            .await
            .unwrap();
    }
    sqlx::query("INSERT INTO shared_tasks (id, list_id, title) VALUES ($1, $2, 'Matrix task')")
        .bind(fixture.task_id)
        .bind(fixture.list_id)
        .execute(&mut *tx)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    fixture
}

/// Everything the shared-list routes can change, as one comparable string.
async fn shared_state(pool: &PgPool, list_id: Uuid) -> String {
    sqlx::query_scalar(
        "SELECT concat_ws(' | ', \
           (SELECT concat_ws(',', revision, deleted_at IS NULL, name) \
              FROM shared_lists WHERE id = $1), \
           (SELECT string_agg(concat_ws(',', id, title, status, deleted_at IS NULL), ';' \
                              ORDER BY id) \
              FROM shared_tasks WHERE list_id = $1), \
           (SELECT string_agg(concat_ws(',', user_id, role, deleted_at IS NULL), ';' \
                              ORDER BY user_id) \
              FROM shared_list_members WHERE list_id = $1))",
    )
    .bind(list_id)
    .fetch_one(pool)
    .await
    .unwrap()
}

#[derive(Clone, Copy, Debug)]
enum SharedRoute {
    GetList,
    DeleteList,
    CreateTask,
    PatchTask,
    DeleteTask,
    AddMember,
    PatchMember,
    RemoveMember,
}

impl SharedRoute {
    const ALL: [Self; 8] = [
        Self::GetList,
        Self::DeleteList,
        Self::CreateTask,
        Self::PatchTask,
        Self::DeleteTask,
        Self::AddMember,
        Self::PatchMember,
        Self::RemoveMember,
    ];

    /// Viewers read, editors change tasks, owners manage the list and members.
    fn allows(self, actor: Actor) -> bool {
        let required = match self {
            Self::GetList => Actor::Viewer,
            Self::CreateTask | Self::PatchTask | Self::DeleteTask => Actor::Editor,
            Self::DeleteList | Self::AddMember | Self::PatchMember | Self::RemoveMember => {
                Actor::Owner
            }
        };
        actor.rank() >= required.rank()
    }

    fn success(self) -> StatusCode {
        match self {
            Self::DeleteList | Self::DeleteTask | Self::RemoveMember => StatusCode::NO_CONTENT,
            _ => StatusCode::OK,
        }
    }

    fn request(self, list_id: Uuid, fixture: &SharedFixture, token: &str) -> Request<Body> {
        let list = format!("/api/v1/shared/lists/{list_id}");
        let task = format!("{list}/tasks/{}", fixture.task_id);
        let member = format!("{list}/members/{}", fixture.target_id);
        let (method, uri, body) = match self {
            Self::GetList => {
                return request(Method::GET, &list, Some(token), None, Body::empty());
            }
            Self::DeleteList => (Method::DELETE, list, json!({ "revision": 1 })),
            Self::CreateTask => (
                Method::POST,
                format!("{list}/tasks"),
                json!({ "title": "Matrix create", "revision": 1 }),
            ),
            Self::PatchTask => (
                Method::PATCH,
                task,
                json!({ "title": "Matrix patch", "revision": 1 }),
            ),
            Self::DeleteTask => (Method::DELETE, task, json!({ "revision": 1 })),
            Self::AddMember => (
                Method::POST,
                format!("{list}/members"),
                json!({ "email": fixture.candidate_email, "role": "viewer", "revision": 1 }),
            ),
            Self::PatchMember => (
                Method::PATCH,
                member,
                json!({ "role": "editor", "revision": 1 }),
            ),
            Self::RemoveMember => (Method::DELETE, member, json!({ "revision": 1 })),
        };
        json_request(method, &uri, Some(token), &body)
    }
}

#[tokio::test]
#[ignore = "requires PostgreSQL; set DATABASE_URL and pass --ignored"]
async fn shared_list_permission_matrix() {
    let (app, pool) = pg_app().await;
    let users = SharedUsers::login(&app, &pool).await;
    let probe = shared_fixture(&pool, &users).await;
    for route in SharedRoute::ALL {
        for actor in Actor::ALL {
            // Every cell gets a fresh list so earlier cells cannot mask later ones.
            let fixture = shared_fixture(&pool, &users).await;
            let before = shared_state(&pool, fixture.list_id).await;
            let token = &users.get(actor).access;
            let reply = send(&app, route.request(fixture.list_id, &fixture, token)).await;
            let after = shared_state(&pool, fixture.list_id).await;
            let context = format!("{route:?} as {actor:?}");
            if route.allows(actor) {
                assert_eq!(reply.status, route.success(), "{context}: {}", reply.body);
                if matches!(route, SharedRoute::GetList) {
                    assert_eq!(before, after, "{context} must not change the list");
                } else {
                    assert_ne!(before, after, "{context} must change the list");
                }
            } else {
                // Non-members cannot tell a hidden list from a missing one.
                let (status, code) = match actor {
                    Actor::Outsider => (StatusCode::NOT_FOUND, "SHARED_LIST_NOT_FOUND"),
                    _ => (StatusCode::FORBIDDEN, "SHARED_LIST_FORBIDDEN"),
                };
                reply.assert_error_in(&context, status, code);
                assert_eq!(before, after, "{context} must not change the list");
            }
        }
        let reply = send(
            &app,
            route.request(Uuid::new_v4(), &probe, &users.owner.access),
        )
        .await;
        reply.assert_error_in(
            &format!("{route:?} on a missing list"),
            StatusCode::NOT_FOUND,
            "SHARED_LIST_NOT_FOUND",
        );
    }

    // The index returns each list the caller belongs to, with the caller's role.
    for (actor, role) in [
        (Actor::Owner, Some("owner")),
        (Actor::Editor, Some("editor")),
        (Actor::Viewer, Some("viewer")),
        (Actor::Outsider, None),
    ] {
        let reply = send(&app, get("/api/v1/shared/lists", users.get(actor))).await;
        reply.assert_status(StatusCode::OK);
        let listed = reply
            .body
            .as_array()
            .unwrap()
            .iter()
            .find(|list| list["id"] == json!(probe.list_id))
            .map(|list| list["role"].clone());
        assert_eq!(listed, role.map(|role| json!(role)), "{actor:?}");
    }
}

fn with_header(mut request: Request<Body>, name: &'static str, value: &str) -> Request<Body> {
    request
        .headers_mut()
        .insert(name, HeaderValue::from_str(value).unwrap());
    request
}

async fn list_revision(pool: &PgPool, list_id: Uuid) -> i64 {
    sqlx::query_scalar("SELECT revision FROM shared_lists WHERE id = $1")
        .bind(list_id)
        .fetch_one(pool)
        .await
        .unwrap()
}

#[tokio::test]
#[ignore = "requires PostgreSQL; set DATABASE_URL and pass --ignored"]
async fn shared_routes_reject_malformed_bodies_and_revisions() {
    let (app, pool) = pg_app().await;
    let users = SharedUsers::login(&app, &pool).await;
    let fixture = shared_fixture(&pool, &users).await;
    let token = Some(users.owner.access.as_str());
    let list = format!("/api/v1/shared/lists/{}", fixture.list_id);
    let tasks = format!("{list}/tasks");
    let task = format!("{tasks}/{}", fixture.task_id);
    let member = format!("{list}/members/{}", fixture.target_id);
    let owned_lists = "SELECT count(*) FROM shared_lists WHERE owner_id = $1";
    let lists_before = count(&pool, owned_lists, users.owner.user_id).await;
    let before = shared_state(&pool, fixture.list_id).await;

    let writes = [
        (Method::POST, "/api/v1/shared/lists".to_owned()),
        (Method::DELETE, list.clone()),
        (Method::POST, tasks.clone()),
        (Method::PATCH, task.clone()),
        (Method::DELETE, task.clone()),
        (Method::POST, format!("{list}/members")),
        (Method::PATCH, member.clone()),
        (Method::DELETE, member),
    ];
    for (method, uri) in &writes {
        for body in [
            "{",
            "null",
            "[]",
            "\"text\"",
            "{\"revision\": \"1\"}",
            "{\"revision\": 1, \"owner_id\": \"00000000-0000-0000-0000-000000000000\"}",
        ] {
            let request = request(
                method.clone(),
                uri,
                token,
                Some("application/json"),
                body.to_owned(),
            );
            send(&app, request).await.assert_error_in(
                &format!("{method} {uri} {body}"),
                StatusCode::BAD_REQUEST,
                "VALIDATION_FAILED",
            );
        }
    }

    let patch = |body: Value| json_request(Method::PATCH, &task, token, &body);
    let cases = [
        (
            "missing revision",
            patch(json!({ "title": "x" })),
            StatusCode::BAD_REQUEST,
            "REVISION_REQUIRED",
        ),
        (
            "zero revision",
            patch(json!({ "title": "x", "revision": 0 })),
            StatusCode::BAD_REQUEST,
            "VALIDATION_FAILED",
        ),
        (
            "negative revision",
            patch(json!({ "title": "x", "revision": -1 })),
            StatusCode::BAD_REQUEST,
            "VALIDATION_FAILED",
        ),
        (
            "non-numeric If-Match",
            with_header(patch(json!({ "title": "x" })), "if-match", "\"abc\""),
            StatusCode::BAD_REQUEST,
            "VALIDATION_FAILED",
        ),
        (
            "If-Match disagrees with body",
            with_header(
                patch(json!({ "title": "x", "revision": 1 })),
                "if-match",
                "\"2\"",
            ),
            StatusCode::BAD_REQUEST,
            "VALIDATION_FAILED",
        ),
        (
            "no task fields",
            patch(json!({ "revision": 1 })),
            StatusCode::BAD_REQUEST,
            "VALIDATION_FAILED",
        ),
        (
            "stale revision",
            patch(json!({ "title": "x", "revision": 2 })),
            StatusCode::CONFLICT,
            "REVISION_CONFLICT",
        ),
        (
            "list id is not a UUID",
            request(
                Method::GET,
                "/api/v1/shared/lists/not-a-uuid",
                token,
                None,
                Body::empty(),
            ),
            StatusCode::BAD_REQUEST,
            "VALIDATION_FAILED",
        ),
        (
            "task id is not a UUID",
            json_request(
                Method::PATCH,
                &format!("{tasks}/not-a-uuid"),
                token,
                &json!({ "title": "x", "revision": 1 }),
            ),
            StatusCode::BAD_REQUEST,
            "VALIDATION_FAILED",
        ),
        (
            "task in another list",
            json_request(
                Method::PATCH,
                &format!("{tasks}/{}", Uuid::new_v4()),
                token,
                &json!({ "title": "x", "revision": 1 }),
            ),
            StatusCode::NOT_FOUND,
            "SHARED_TASK_NOT_FOUND",
        ),
        (
            "oversized create body without Content-Length",
            oversized_request(Method::POST, &tasks, token, false),
            StatusCode::PAYLOAD_TOO_LARGE,
            "PAYLOAD_TOO_LARGE",
        ),
        (
            "oversized delete body without Content-Length",
            oversized_request(Method::DELETE, &task, token, false),
            StatusCode::PAYLOAD_TOO_LARGE,
            "PAYLOAD_TOO_LARGE",
        ),
    ];
    for (context, request, status, code) in cases {
        let reply = send(&app, request).await;
        reply.assert_error_in(context, status, code);
        if code == "REVISION_CONFLICT" {
            assert_eq!(reply.body["current_revision"], 1, "{context}");
        }
    }

    assert_eq!(shared_state(&pool, fixture.list_id).await, before);
    assert_eq!(
        count(&pool, owned_lists, users.owner.user_id).await,
        lists_before
    );
}

#[tokio::test]
#[ignore = "requires PostgreSQL; set DATABASE_URL and pass --ignored"]
async fn shared_op_ids_replay_the_original_result() {
    let (app, pool) = pg_app().await;
    let users = SharedUsers::login(&app, &pool).await;
    let fixture = shared_fixture(&pool, &users).await;
    let owner = Some(users.owner.access.as_str());
    let editor = Some(users.editor.access.as_str());
    let list = format!("/api/v1/shared/lists/{}", fixture.list_id);
    let tasks = format!("{list}/tasks");
    let task_id = Uuid::new_v4();
    let task = format!("{tasks}/{task_id}");

    // Create: a retry returns the original task even with a stale revision or
    // a different payload, and never inserts or bumps the revision twice.
    let create_op = Uuid::new_v4();
    let create = json!({ "id": task_id, "title": "Replay", "revision": 1, "op_id": create_op });
    let reply = send(&app, json_request(Method::POST, &tasks, owner, &create)).await;
    reply.assert_status(StatusCode::OK);
    assert_eq!(reply.body["revision"], 2);
    let mut altered = create.clone();
    altered["title"] = json!("Altered");
    for body in [create, altered] {
        let reply = send(&app, json_request(Method::POST, &tasks, owner, &body)).await;
        reply.assert_status(StatusCode::OK);
        assert_eq!(reply.body["id"], json!(task_id));
        assert_eq!(reply.body["title"], "Replay");
    }
    assert_eq!(list_revision(&pool, fixture.list_id).await, 2);
    let task_rows = "SELECT count(*) FROM shared_tasks WHERE id = $1";
    assert_eq!(count(&pool, task_rows, task_id).await, 1);

    // Another member cannot reuse the op_id.
    let reuse = json!({ "title": "Editor", "revision": 2, "op_id": create_op });
    send(&app, json_request(Method::PATCH, &task, editor, &reuse))
        .await
        .assert_error(StatusCode::CONFLICT, "OP_ID_CONFLICT");
    assert_eq!(list_revision(&pool, fixture.list_id).await, 2);

    // Patch.
    let patch_op = Uuid::new_v4();
    let patch = json!({ "title": "Patched", "revision": 2, "op_id": patch_op });
    let reply = send(&app, json_request(Method::PATCH, &task, editor, &patch)).await;
    reply.assert_status(StatusCode::OK);
    assert_eq!(reply.body["title"], "Patched");
    let mut altered = patch.clone();
    altered["title"] = json!("Altered");
    for body in [patch, altered] {
        let reply = send(&app, json_request(Method::PATCH, &task, editor, &body)).await;
        reply.assert_status(StatusCode::OK);
        assert_eq!(reply.body["title"], "Patched");
    }
    assert_eq!(list_revision(&pool, fixture.list_id).await, 3);

    // Delete.
    let delete = json!({ "revision": 3, "op_id": Uuid::new_v4() });
    for _ in 0..2 {
        let reply = send(&app, json_request(Method::DELETE, &task, editor, &delete)).await;
        reply.assert_status(StatusCode::NO_CONTENT);
    }
    assert_eq!(list_revision(&pool, fixture.list_id).await, 4);

    // Member role change.
    let member = format!("{list}/members/{}", fixture.target_id);
    let role = json!({ "role": "editor", "revision": 4, "op_id": Uuid::new_v4() });
    for _ in 0..2 {
        let reply = send(&app, json_request(Method::PATCH, &member, owner, &role)).await;
        reply.assert_status(StatusCode::OK);
        assert_eq!(reply.body["role"], "editor");
    }
    assert_eq!(list_revision(&pool, fixture.list_id).await, 5);
    let receipts = "SELECT count(*) FROM shared_op_receipts WHERE list_id = $1";
    assert_eq!(count(&pool, receipts, fixture.list_id).await, 4);
}

/// `apps/api/src/shared.rs` validates lengths but not NUL characters or the
/// PostgreSQL date range, so these inputs reach the database and fail as 500.
/// shared.rs is being changed in a parallel branch, so the fix is left to it.
#[tokio::test]
#[ignore = "known defect in shared.rs: NUL characters and out-of-range dates return 500 instead of 400; run explicitly"]
async fn known_defect_shared_routes_reject_values_postgres_cannot_store() {
    let (app, pool) = pg_app().await;
    let users = SharedUsers::login(&app, &pool).await;
    let fixture = shared_fixture(&pool, &users).await;
    let token = Some(users.owner.access.as_str());
    let list = format!("/api/v1/shared/lists/{}", fixture.list_id);
    let tasks = format!("{list}/tasks");
    let cases = [
        (
            "NUL in list name",
            Method::POST,
            "/api/v1/shared/lists".to_owned(),
            json!({ "name": "a\u{0}b" }),
        ),
        (
            "NUL in task title",
            Method::POST,
            tasks.clone(),
            json!({ "title": "a\u{0}b", "revision": 1 }),
        ),
        (
            "NUL in task note",
            Method::POST,
            tasks.clone(),
            json!({ "title": "ok", "note": "a\u{0}b", "revision": 1 }),
        ),
        (
            "due_on before PostgreSQL's date range",
            Method::POST,
            tasks.clone(),
            json!({ "title": "ok", "due_on": "-5000-01-01", "revision": 1 }),
        ),
        (
            "NUL in patched task title",
            Method::PATCH,
            format!("{tasks}/{}", fixture.task_id),
            json!({ "title": "a\u{0}b", "revision": 1 }),
        ),
    ];
    let mut failures = Vec::new();
    for (context, method, uri, body) in cases {
        let reply = send(&app, json_request(method, &uri, token, &body)).await;
        if reply.status != StatusCode::BAD_REQUEST || reply.body["code"] != "VALIDATION_FAILED" {
            failures.push(format!("{context}: {} {}", reply.status, reply.body));
        }
    }
    assert!(failures.is_empty(), "{failures:#?}");
}
