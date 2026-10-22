use axum::{
    Router,
    body::Bytes,
    extract::State,
    http::{
        HeaderMap, HeaderValue, StatusCode,
        header::{CONTENT_TYPE, COOKIE, ORIGIN, SET_COOKIE},
    },
    response::{IntoResponse, Response},
    routing::post,
};
use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use uuid::Uuid;

use crate::{
    auth::{
        AuthUser,
        rate_limit::AuthRequestLimit,
        tokens::{generate_auth_code, generate_refresh_token, hash_refresh_token},
    },
    domain::Platform,
    email::normalize_email,
    error::{ApiResult, AppError},
    extract::ApiJson,
    mail::deliver_auth_code,
    state::AppState,
};

const REFRESH_COOKIE: &str = "todo_refresh";
const COOKIE_PATH: &str = "/api/v1/auth";

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/v1/auth/code/request", post(request_code))
        .route("/api/v1/auth/code/verify", post(verify_code))
        .route("/api/v1/auth/refresh", post(refresh))
        .route("/api/v1/auth/logout", post(logout))
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RequestCodeRequest {
    email: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct VerifyCodeRequest {
    email: String,
    code: String,
    device_id: Uuid,
    platform: Platform,
    device_name: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RefreshRequest {
    refresh_token: Option<String>,
}

#[derive(Debug, Serialize)]
struct TokenResponse {
    access_token: String,
    token_type: &'static str,
    expires_in: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    refresh_token: Option<String>,
}

#[derive(Debug, FromRow)]
struct AuthCodeRow {
    id: Uuid,
    code_hash: Vec<u8>,
    attempts: i32,
    expires_at: DateTime<Utc>,
    consumed_at: Option<DateTime<Utc>>,
}

#[derive(Debug, FromRow)]
struct DeviceIdentityRow {
    user_id: Uuid,
}

#[derive(Debug, FromRow)]
struct UserRow {
    id: Uuid,
    deleted_at: Option<DateTime<Utc>>,
}

#[derive(Debug, FromRow)]
struct RefreshLocatorRow {
    id: Uuid,
    session_id: Uuid,
    user_id: Uuid,
    device_id: Uuid,
}

#[derive(Debug, FromRow)]
struct RefreshRow {
    id: Uuid,
    session_id: Uuid,
    expires_at: DateTime<Utc>,
    rotated_at: Option<DateTime<Utc>>,
    revoked_at: Option<DateTime<Utc>>,
    user_id: Uuid,
    device_id: Uuid,
    session_expires_at: DateTime<Utc>,
    session_revoked_at: Option<DateTime<Utc>>,
    user_deleted_at: Option<DateTime<Utc>>,
    device_revoked_at: Option<DateTime<Utc>>,
}

async fn request_code(
    State(state): State<AppState>,
    ApiJson(body): ApiJson<RequestCodeRequest>,
) -> ApiResult<StatusCode> {
    let email = normalize_email(&body.email)
        .map_err(|_| AppError::validation("email must be a valid email address"))?;

    let now = Utc::now();
    let resend_cutoff = now - Duration::seconds(state.config.auth_code_resend_seconds);

    let mut tx = state.pool.begin().await?;
    // Serializes resend checks for the same email across all API instances.
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))")
        .bind(&email)
        .execute(&mut *tx)
        .await?;

    // The shared window row is incremented in the same transaction. Commit
    // even when limiting so the counter cannot be bypassed by rollback.
    match state.auth_rate_limiter.check(&mut tx, &email).await? {
        AuthRequestLimit::GlobalExceeded => {
            tx.commit().await?;
            state.metrics.record_auth_code_request("rate_limited");
            return Err(AppError::TooManyRequests {
                code: "RATE_LIMITED",
                message: "Too many code requests; try again later".to_owned(),
            });
        }
        AuthRequestLimit::Suppressed => {
            tx.commit().await?;
            state.metrics.record_auth_code_request("suppressed");
            return Ok(StatusCode::ACCEPTED);
        }
        AuthRequestLimit::Allowed => {}
    }

    let recent_code: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM auth_codes \
         WHERE email_normalized = $1 AND created_at > $2)",
    )
    .bind(&email)
    .bind(resend_cutoff)
    .fetch_one(&mut *tx)
    .await?;
    if recent_code {
        tx.commit().await?;
        state.metrics.record_auth_code_request("suppressed");
        return Ok(StatusCode::ACCEPTED);
    }

    let code = if state.config.app_env.is_development() {
        state.config.auth_dev_code.clone().ok_or_else(|| {
            AppError::Internal("development auth code is not configured".to_owned())
        })?
    } else {
        generate_auth_code()
    };
    let code_hash = state.auth_codes.hash(&code);
    let expires_at = now + Duration::seconds(state.config.auth_code_ttl_seconds);

    sqlx::query(
        "INSERT INTO auth_codes (id, email_normalized, code_hash, expires_at) \
         VALUES ($1, $2, $3, $4)",
    )
    .bind(Uuid::new_v4())
    .bind(&email)
    .bind(code_hash)
    .bind(expires_at)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    state.metrics.record_auth_code_request("accepted");

    if state.config.app_env.is_development() {
        // The development code comes from AUTH_DEV_CODE (or 246810) and is
        // intentionally never written to logs or returned in the response.
        tracing::info!("development sign-in code issued; retrieve it from AUTH_DEV_CODE");
    } else {
        // Delivery happens after commit so a provider failure cannot make an
        // unusable code the committed value. Failures are logged redacted and
        // the response remains a generic 202.
        let _ = deliver_auth_code(
            state.mailer.as_ref(),
            &email,
            &code,
            state.config.auth_code_ttl_seconds,
        )
        .await;
    }

    Ok(StatusCode::ACCEPTED)
}

async fn verify_code(
    State(state): State<AppState>,
    headers: HeaderMap,
    ApiJson(body): ApiJson<VerifyCodeRequest>,
) -> ApiResult<Response> {
    if body.platform == Platform::Web {
        // Login CSRF protection for cookie-based web sessions.
        enforce_cookie_origin(&state, &headers)?;
    }
    let email = normalize_email(&body.email)
        .map_err(|_| AppError::validation("email must be a valid email address"))?;
    if !(6..=8).contains(&body.code.chars().count())
        || !body.code.bytes().all(|byte| byte.is_ascii_digit())
    {
        return Err(AppError::validation("code must contain 6 to 8 digits"));
    }
    let device_name = body.device_name.trim();
    if device_name.is_empty() || device_name.chars().count() > 100 {
        return Err(AppError::validation(
            "device_name must contain between 1 and 100 characters",
        ));
    }

    let now = Utc::now();
    let mut tx = state.pool.begin().await?;

    let auth_code = sqlx::query_as::<_, AuthCodeRow>(
        r#"
        SELECT id, code_hash, attempts, expires_at, consumed_at
        FROM auth_codes
        WHERE email_normalized = $1
          AND consumed_at IS NULL
          AND expires_at > now()
        ORDER BY created_at DESC
        LIMIT 1
        FOR UPDATE
        "#,
    )
    .bind(&email)
    .fetch_optional(&mut *tx)
    .await?;

    let Some(auth_code) = auth_code else {
        tx.commit().await?;
        return Err(invalid_code());
    };
    if auth_code.expires_at <= now {
        tx.commit().await?;
        return Err(invalid_code());
    }
    if auth_code.attempts >= state.config.auth_code_max_attempts
        || auth_code.consumed_at.is_some()
        || !state.auth_codes.verify(&body.code, &auth_code.code_hash)
    {
        sqlx::query("UPDATE auth_codes SET attempts = LEAST(attempts + 1, 10) WHERE id = $1")
            .bind(auth_code.id)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        return Err(invalid_code());
    }

    let user = sqlx::query_as::<_, UserRow>(
        r#"
        INSERT INTO users (id, email_normalized)
        VALUES ($1, $2)
        ON CONFLICT (email_normalized)
        DO UPDATE SET email_normalized = EXCLUDED.email_normalized
        RETURNING id, deleted_at
        "#,
    )
    .bind(Uuid::new_v4())
    .bind(&email)
    .fetch_one(&mut *tx)
    .await?;
    if user.deleted_at.is_some() {
        tx.rollback().await?;
        return Err(AppError::Unauthorized {
            code: "ACCOUNT_UNAVAILABLE",
            message: "This account is unavailable".to_owned(),
        });
    }

    sqlx::query(
        "INSERT INTO account_sync_state (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING",
    )
    .bind(user.id)
    .execute(&mut *tx)
    .await?;

    let existing_device = sqlx::query_as::<_, DeviceIdentityRow>(
        "SELECT user_id FROM devices WHERE id = $1 FOR UPDATE",
    )
    .bind(body.device_id)
    .fetch_optional(&mut *tx)
    .await?;

    if let Some(existing) = existing_device {
        if existing.user_id != user.id {
            tx.rollback().await?;
            return Err(AppError::Conflict {
                code: "DEVICE_CONFLICT",
                message: "That device id is already in use".to_owned(),
            });
        }
        sqlx::query(
            "UPDATE devices SET name = $1, platform = $2, revoked_at = NULL, last_seen_at = now() \
             WHERE user_id = $3 AND id = $4",
        )
        .bind(device_name)
        .bind(body.platform.as_str())
        .bind(user.id)
        .bind(body.device_id)
        .execute(&mut *tx)
        .await?;
    } else {
        sqlx::query(
            "INSERT INTO devices (id, user_id, name, platform, last_seen_at) \
             VALUES ($1, $2, $3, $4, now())",
        )
        .bind(body.device_id)
        .bind(user.id)
        .bind(device_name)
        .bind(body.platform.as_str())
        .execute(&mut *tx)
        .await?;
    }

    let session_id = Uuid::new_v4();
    let (refresh_token, refresh_hash) = generate_refresh_token();
    let refresh_expires_at = now + Duration::seconds(state.config.refresh_token_ttl_seconds);
    sqlx::query(
        "INSERT INTO sessions (id, user_id, device_id, refresh_token_hash, expires_at) \
         VALUES ($1, $2, $3, $4, $5)",
    )
    .bind(session_id)
    .bind(user.id)
    .bind(body.device_id)
    .bind(&refresh_hash)
    .bind(refresh_expires_at)
    .execute(&mut *tx)
    .await?;
    sqlx::query(
        "INSERT INTO refresh_tokens (id, session_id, token_hash, expires_at) \
         VALUES ($1, $2, $3, $4)",
    )
    .bind(Uuid::new_v4())
    .bind(session_id)
    .bind(&refresh_hash)
    .bind(refresh_expires_at)
    .execute(&mut *tx)
    .await?;

    sqlx::query("UPDATE auth_codes SET consumed_at = now() WHERE id = $1 AND consumed_at IS NULL")
        .bind(auth_code.id)
        .execute(&mut *tx)
        .await?;
    let (access_token, expires_in) = state
        .jwt
        .issue_access(user.id, session_id, body.device_id)?;
    tx.commit().await?;

    let web = body.platform == Platform::Web;
    let response_body = TokenResponse {
        access_token,
        token_type: "Bearer",
        expires_in,
        refresh_token: (!web).then_some(refresh_token.clone()),
    };
    let mut response = axum::Json(response_body).into_response();
    if web {
        append_refresh_cookie(
            response.headers_mut(),
            &refresh_token,
            state.config.refresh_token_ttl_seconds,
            state.config.cookie_secure,
        )?;
    }
    Ok(response)
}

async fn refresh(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> ApiResult<Response> {
    let cookie_token = refresh_cookie(&headers);
    let body_token = parse_refresh_body(&headers, &body)?;
    let token = match (cookie_token, body_token) {
        (Some(_), Some(_)) => {
            return Err(AppError::validation(
                "send a refresh token in exactly one of the JSON body or cookie",
            ));
        }
        (Some(token), None) => Some((token, true)),
        (None, Some(token)) => Some((token, false)),
        (None, None) => None,
    }
    .ok_or_else(AppError::unauthorized)?;

    let (token, web) = token;
    if web {
        enforce_cookie_origin(&state, &headers)?;
    }
    let token_hash = hash_refresh_token(&token);
    let now = Utc::now();

    let mut tx = state.pool.begin().await?;
    // Read the token-to-session mapping without locks, then acquire locks in
    // the global order users -> devices -> sessions -> refresh_tokens. Every
    // other session mutation follows this order to avoid deadlocks.
    let locator = sqlx::query_as::<_, RefreshLocatorRow>(
        r#"
        SELECT rt.id, rt.session_id, s.user_id, s.device_id
        FROM refresh_tokens rt
        JOIN sessions s ON s.id = rt.session_id
        WHERE rt.token_hash = $1
        "#,
    )
    .bind(&token_hash)
    .fetch_optional(&mut *tx)
    .await?;
    let Some(locator) = locator else {
        tx.rollback().await?;
        return Err(refresh_invalid());
    };

    let locked_user: Option<(Option<DateTime<Utc>>,)> =
        sqlx::query_as("SELECT deleted_at FROM users WHERE id = $1 FOR UPDATE")
            .bind(locator.user_id)
            .fetch_optional(&mut *tx)
            .await?;
    if locked_user.is_none() {
        tx.rollback().await?;
        return Err(refresh_invalid());
    }
    let locked_device: Option<(Option<DateTime<Utc>>,)> =
        sqlx::query_as("SELECT revoked_at FROM devices WHERE user_id = $1 AND id = $2 FOR UPDATE")
            .bind(locator.user_id)
            .bind(locator.device_id)
            .fetch_optional(&mut *tx)
            .await?;
    if locked_device.is_none() {
        tx.rollback().await?;
        return Err(refresh_invalid());
    }
    let locked_session: Option<(Uuid,)> = sqlx::query_as(
        "SELECT id FROM sessions WHERE id = $1 AND user_id = $2 AND device_id = $3 FOR UPDATE",
    )
    .bind(locator.session_id)
    .bind(locator.user_id)
    .bind(locator.device_id)
    .fetch_optional(&mut *tx)
    .await?;
    if locked_session.is_none() {
        tx.rollback().await?;
        return Err(refresh_invalid());
    }

    let row = sqlx::query_as::<_, RefreshRow>(
        r#"
        SELECT rt.id,
               rt.session_id,
               rt.expires_at,
               rt.rotated_at,
               rt.revoked_at,
               s.user_id,
               s.device_id,
               s.expires_at AS session_expires_at,
               s.revoked_at AS session_revoked_at,
               u.deleted_at AS user_deleted_at,
               d.revoked_at AS device_revoked_at
        FROM refresh_tokens rt
        JOIN sessions s ON s.id = rt.session_id
        JOIN users u ON u.id = s.user_id
        JOIN devices d ON d.user_id = s.user_id AND d.id = s.device_id
        WHERE rt.id = $1 AND rt.token_hash = $2
        FOR UPDATE OF rt
        "#,
    )
    .bind(locator.id)
    .bind(&token_hash)
    .fetch_optional(&mut *tx)
    .await?;

    let Some(row) = row else {
        tx.rollback().await?;
        return Err(refresh_invalid());
    };

    if row.rotated_at.is_some() || row.revoked_at.is_some() {
        sqlx::query("UPDATE sessions SET revoked_at = COALESCE(revoked_at, now()) WHERE id = $1")
            .bind(row.session_id)
            .execute(&mut *tx)
            .await?;
        revoke_session_refresh_tokens(&mut tx, row.session_id).await?;
        tx.commit().await?;
        return Err(AppError::Unauthorized {
            code: "REFRESH_TOKEN_REUSED",
            message: "The refresh session has been revoked; sign in again".to_owned(),
        });
    }
    if row.session_revoked_at.is_some()
        || row.user_deleted_at.is_some()
        || row.device_revoked_at.is_some()
        || row.expires_at <= now
        || row.session_expires_at <= now
    {
        sqlx::query("UPDATE sessions SET revoked_at = now() WHERE id = $1")
            .bind(row.session_id)
            .execute(&mut *tx)
            .await?;
        revoke_session_refresh_tokens(&mut tx, row.session_id).await?;
        tx.commit().await?;
        return Err(refresh_invalid());
    }

    let (new_token, new_hash) = generate_refresh_token();
    let new_refresh_id = Uuid::new_v4();
    let new_expiry = now + Duration::seconds(state.config.refresh_token_ttl_seconds);
    sqlx::query(
        "INSERT INTO refresh_tokens (id, session_id, token_hash, expires_at) \
         VALUES ($1, $2, $3, $4)",
    )
    .bind(new_refresh_id)
    .bind(row.session_id)
    .bind(&new_hash)
    .bind(new_expiry)
    .execute(&mut *tx)
    .await?;
    sqlx::query(
        "UPDATE refresh_tokens SET rotated_at = now(), replaced_by = $1 \
         WHERE id = $2 AND rotated_at IS NULL",
    )
    .bind(new_refresh_id)
    .bind(row.id)
    .execute(&mut *tx)
    .await?;
    let updated = sqlx::query(
        "UPDATE sessions SET refresh_token_hash = $1, expires_at = $2, rotated_at = now() \
         WHERE id = $3 AND revoked_at IS NULL",
    )
    .bind(&new_hash)
    .bind(new_expiry)
    .bind(row.session_id)
    .execute(&mut *tx)
    .await?;
    if updated.rows_affected() != 1 {
        tx.rollback().await?;
        return Err(refresh_invalid());
    }
    sqlx::query("UPDATE devices SET last_seen_at = now() WHERE user_id = $1 AND id = $2")
        .bind(row.user_id)
        .bind(row.device_id)
        .execute(&mut *tx)
        .await?;

    let (access_token, expires_in) =
        state
            .jwt
            .issue_access(row.user_id, row.session_id, row.device_id)?;
    tx.commit().await?;

    let response_body = TokenResponse {
        access_token,
        token_type: "Bearer",
        expires_in,
        refresh_token: (!web).then_some(new_token.clone()),
    };
    let mut response = axum::Json(response_body).into_response();
    if web {
        append_refresh_cookie(
            response.headers_mut(),
            &new_token,
            state.config.refresh_token_ttl_seconds,
            state.config.cookie_secure,
        )?;
    }
    Ok(response)
}

async fn logout(State(state): State<AppState>, auth: AuthUser) -> ApiResult<Response> {
    let mut tx = state.pool.begin().await?;
    // Match the lock order used by refresh and device revocation.
    let user: Option<(Uuid,)> = sqlx::query_as("SELECT id FROM users WHERE id = $1 FOR UPDATE")
        .bind(auth.user_id)
        .fetch_optional(&mut *tx)
        .await?;
    if user.is_none() {
        tx.rollback().await?;
        return Err(AppError::unauthorized());
    }
    let device: Option<(Uuid,)> =
        sqlx::query_as("SELECT id FROM devices WHERE user_id = $1 AND id = $2 FOR UPDATE")
            .bind(auth.user_id)
            .bind(auth.device_id)
            .fetch_optional(&mut *tx)
            .await?;
    if device.is_none() {
        tx.rollback().await?;
        return Err(AppError::unauthorized());
    }
    let session: Option<(Uuid,)> = sqlx::query_as(
        "SELECT id FROM sessions WHERE id = $1 AND user_id = $2 AND device_id = $3 FOR UPDATE",
    )
    .bind(auth.session_id)
    .bind(auth.user_id)
    .bind(auth.device_id)
    .fetch_optional(&mut *tx)
    .await?;
    if session.is_none() {
        tx.rollback().await?;
        return Err(AppError::unauthorized());
    }

    sqlx::query(
        "UPDATE sessions SET revoked_at = COALESCE(revoked_at, now()) \
         WHERE id = $1 AND user_id = $2",
    )
    .bind(auth.session_id)
    .bind(auth.user_id)
    .execute(&mut *tx)
    .await?;
    revoke_session_refresh_tokens(&mut tx, auth.session_id).await?;
    tx.commit().await?;

    let mut response = StatusCode::NO_CONTENT.into_response();
    clear_refresh_cookie(response.headers_mut())?;
    Ok(response)
}

async fn revoke_session_refresh_tokens(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    session_id: Uuid,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "UPDATE refresh_tokens SET revoked_at = COALESCE(revoked_at, now()) \
         WHERE session_id = $1 AND revoked_at IS NULL",
    )
    .bind(session_id)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

fn invalid_code() -> AppError {
    AppError::Unauthorized {
        code: "INVALID_CODE",
        message: "Invalid or expired sign-in code".to_owned(),
    }
}

fn refresh_invalid() -> AppError {
    AppError::Unauthorized {
        code: "INVALID_REFRESH_TOKEN",
        message: "The refresh credential is invalid or expired".to_owned(),
    }
}

fn parse_refresh_body(headers: &HeaderMap, body: &Bytes) -> ApiResult<Option<String>> {
    if body.is_empty() {
        return Ok(None);
    }
    if let Some(content_type) = headers.get(CONTENT_TYPE)
        && !content_type
            .to_str()
            .unwrap_or_default()
            .to_ascii_lowercase()
            .starts_with("application/json")
    {
        return Err(AppError::validation(
            "Content-Type must be application/json",
        ));
    }
    let payload: RefreshRequest = serde_json::from_slice(body)
        .map_err(|_| AppError::validation("Malformed JSON refresh request"))?;
    if payload.refresh_token.as_deref() == Some("") {
        return Err(AppError::validation("refresh_token may not be empty"));
    }
    Ok(payload.refresh_token)
}

fn refresh_cookie(headers: &HeaderMap) -> Option<String> {
    for header in headers.get_all(COOKIE) {
        let Ok(value) = header.to_str() else {
            continue;
        };
        for pair in value.split(';') {
            let Some((name, value)) = pair.trim().split_once('=') else {
                continue;
            };
            if name == REFRESH_COOKIE && !value.is_empty() {
                return Some(value.to_owned());
            }
        }
    }
    None
}

fn enforce_cookie_origin(state: &AppState, headers: &HeaderMap) -> ApiResult<()> {
    let Some(origin) = headers.get(ORIGIN) else {
        return Ok(());
    };
    let origin = origin
        .to_str()
        .map_err(|_| AppError::Forbidden {
            code: "ORIGIN_NOT_ALLOWED",
            message: "Origin is not allowed".to_owned(),
        })?
        .trim_end_matches('/');
    if state
        .config
        .cors_origins
        .iter()
        .any(|allowed| allowed == origin)
    {
        Ok(())
    } else {
        Err(AppError::Forbidden {
            code: "ORIGIN_NOT_ALLOWED",
            message: "Origin is not allowed".to_owned(),
        })
    }
}

fn append_refresh_cookie(
    headers: &mut HeaderMap,
    token: &str,
    max_age_seconds: i64,
    secure: bool,
) -> ApiResult<()> {
    let secure_attribute = if secure { "; Secure" } else { "" };
    let value = format!(
        "{REFRESH_COOKIE}={token}; HttpOnly; SameSite=Strict; Path={COOKIE_PATH}; Max-Age={max_age_seconds}{secure_attribute}"
    );
    headers.append(
        SET_COOKIE,
        HeaderValue::from_str(&value)
            .map_err(|_| AppError::Internal("could not build refresh cookie".to_owned()))?,
    );
    Ok(())
}

fn clear_refresh_cookie(headers: &mut HeaderMap) -> ApiResult<()> {
    let value =
        format!("{REFRESH_COOKIE}=; HttpOnly; SameSite=Strict; Path={COOKIE_PATH}; Max-Age=0");
    headers.append(
        SET_COOKIE,
        HeaderValue::from_str(&value)
            .map_err(|_| AppError::Internal("could not clear refresh cookie".to_owned()))?,
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cookie_parser_selects_our_cookie_only() {
        let mut headers = HeaderMap::new();
        headers.insert(
            COOKIE,
            HeaderValue::from_static("theme=dark; todo_refresh=abc123; other=1"),
        );
        assert_eq!(refresh_cookie(&headers).as_deref(), Some("abc123"));
    }

    #[test]
    fn cookie_parser_ignores_empty_values() {
        let mut headers = HeaderMap::new();
        headers.insert(COOKIE, HeaderValue::from_static("todo_refresh=; x=1"));
        assert!(refresh_cookie(&headers).is_none());
    }

    #[test]
    fn refresh_body_requires_json_content_type() {
        let mut headers = HeaderMap::new();
        headers.insert(CONTENT_TYPE, HeaderValue::from_static("text/plain"));
        let error = parse_refresh_body(&headers, &Bytes::from_static(b"{}")).unwrap_err();
        assert!(matches!(
            error,
            AppError::BadRequest {
                code: "VALIDATION_FAILED",
                ..
            }
        ));
    }
}
