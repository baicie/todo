use std::time::Duration;

use axum::{
    Json, Router,
    body::Body,
    http::{
        HeaderValue, Method, Request, StatusCode,
        header::{ACCEPT, AUTHORIZATION, CONTENT_TYPE, HeaderName},
    },
    middleware::{self, Next},
    response::{IntoResponse, Response},
};
use tower_http::{
    compression::CompressionLayer,
    cors::{AllowOrigin, CorsLayer},
    limit::RequestBodyLimitLayer,
    timeout::TimeoutLayer,
    trace::{DefaultOnResponse, TraceLayer},
};
use tracing::Level;

use crate::{
    account, auth, bootstrap, config::ConfigError, devices, error::ErrorBody, export, health,
    metrics, push, shared, state::AppState, sync,
};

pub fn build_router(state: AppState) -> Result<Router, ConfigError> {
    let config = state.config.clone();
    let mut origins = Vec::with_capacity(config.cors_origins.len());
    for origin in &config.cors_origins {
        let value = HeaderValue::from_str(origin).map_err(|_| {
            ConfigError(format!(
                "CORS origin is not a valid header value: {origin:?}"
            ))
        })?;
        origins.push(value);
    }

    let cors = CorsLayer::new()
        .allow_origin(AllowOrigin::list(origins))
        .allow_methods([
            Method::GET,
            Method::POST,
            Method::PATCH,
            Method::DELETE,
            Method::OPTIONS,
        ])
        .allow_headers([AUTHORIZATION, CONTENT_TYPE, ACCEPT])
        .expose_headers([HeaderName::from_static("x-request-id")])
        .allow_credentials(true)
        .max_age(Duration::from_secs(3600));

    let trace = TraceLayer::new_for_http()
        // Query strings can contain the bootstrap continuation token. Log only
        // the path and never request headers or bodies.
        .make_span_with(|request: &Request<Body>| {
            tracing::info_span!(
                "http_request",
                method = %request.method(),
                path = %request.uri().path()
            )
        })
        .on_request(())
        .on_response(DefaultOnResponse::new().level(Level::INFO));

    let router = Router::new()
        .merge(health::router())
        .merge(metrics::router())
        .merge(auth::routes::router())
        .merge(devices::router())
        .merge(bootstrap::router())
        .merge(sync::router())
        .merge(export::router())
        .merge(push::router())
        .merge(shared::router())
        .merge(account::router())
        .fallback(not_found)
        .method_not_allowed_fallback(not_found)
        .with_state(state.clone())
        .layer(CompressionLayer::new())
        .layer(RequestBodyLimitLayer::new(config.max_body_bytes))
        .layer(TimeoutLayer::with_status_code(
            StatusCode::REQUEST_TIMEOUT,
            config.request_timeout(),
        ))
        .layer(trace)
        .layer(middleware::from_fn(normalize_transport_errors))
        .layer(cors)
        .layer(middleware::from_fn_with_state(
            state,
            metrics::observability,
        ));

    Ok(router)
}

async fn not_found() -> Response {
    (
        StatusCode::NOT_FOUND,
        Json(ErrorBody {
            code: "NOT_FOUND".to_owned(),
            message: "The requested endpoint does not exist".to_owned(),
        }),
    )
        .into_response()
}

/// tower-http's body limit and timeout produce plain text 413/408 responses.
/// Normalize those transport failures to the same JSON envelope as application
/// errors. Method-not-allowed is handled here too.
async fn normalize_transport_errors(request: Request<Body>, next: Next) -> Response {
    let response = next.run(request).await;
    let (code, message) = match response.status() {
        StatusCode::PAYLOAD_TOO_LARGE => (
            "PAYLOAD_TOO_LARGE",
            "The request body exceeds the configured limit",
        ),
        StatusCode::REQUEST_TIMEOUT => {
            ("REQUEST_TIMEOUT", "The request exceeded the server timeout")
        }
        StatusCode::METHOD_NOT_ALLOWED => (
            "METHOD_NOT_ALLOWED",
            "Method is not allowed for this endpoint",
        ),
        _ => return response,
    };
    (
        response.status(),
        Json(ErrorBody {
            code: code.to_owned(),
            message: message.to_owned(),
        }),
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::{Request, header::CONTENT_TYPE};
    use http_body_util::BodyExt;
    use sqlx::postgres::PgPoolOptions;
    use tower::ServiceExt;

    fn test_app() -> Router {
        let config = crate::config::Config::for_test();
        let pool = PgPoolOptions::new()
            .connect_lazy(&config.database_url)
            .expect("lazy pool");
        build_router(AppState::new(pool, config).unwrap()).unwrap()
    }

    #[tokio::test]
    async fn unknown_routes_return_json_404() {
        let app = test_app();
        let response = app
            .oneshot(
                Request::builder()
                    .uri("/api/v1/does-not-exist")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        assert_eq!(
            response
                .headers()
                .get(CONTENT_TYPE)
                .and_then(|value| value.to_str().ok()),
            Some("application/json")
        );
        let body = response.into_body().collect().await.unwrap().to_bytes();
        let value: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(value["code"], "NOT_FOUND");
    }

    #[tokio::test]
    async fn liveness_does_not_require_database() {
        let app = test_app();
        let response = app
            .oneshot(
                Request::builder()
                    .uri("/healthz")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert!(response.headers().get("x-request-id").is_some());
        let body = response.into_body().collect().await.unwrap().to_bytes();
        let value: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(value["status"], "ok");
    }

    #[tokio::test]
    async fn request_id_is_propagated_and_metrics_are_exposed() {
        let app = test_app();
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/healthz")
                    .header("x-request-id", "0123456789abcdef")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(
            response
                .headers()
                .get("x-request-id")
                .and_then(|value| value.to_str().ok()),
            Some("0123456789abcdef")
        );
        let metrics = app
            .oneshot(
                Request::builder()
                    .uri("/metrics")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(metrics.status(), StatusCode::OK);
        let body = metrics.into_body().collect().await.unwrap().to_bytes();
        let text = String::from_utf8(body.to_vec()).unwrap();
        assert!(text.contains("todo_http_requests_total"));
        assert!(text.contains("todo_http_request_duration_seconds_bucket"));
        assert!(text.contains("path=\"/healthz\""));
    }

    #[tokio::test]
    async fn cors_preflight_is_allowlisted() {
        let app = test_app();
        let response = app
            .oneshot(
                Request::builder()
                    .method("OPTIONS")
                    .uri("/api/v1/sync")
                    .header("Origin", "http://localhost:5173")
                    .header("Access-Control-Request-Method", "POST")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response
                .headers()
                .get("access-control-allow-origin")
                .and_then(|value| value.to_str().ok()),
            Some("http://localhost:5173")
        );
    }
}
