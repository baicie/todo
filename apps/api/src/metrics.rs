use std::{collections::BTreeMap, sync::Mutex, time::Instant};

use axum::{
    extract::State,
    http::{HeaderName, HeaderValue, Request, header::CONTENT_TYPE},
    middleware::Next,
    response::{IntoResponse, Response},
};
use uuid::Uuid;

use crate::state::AppState;

const REQUEST_ID_HEADER: HeaderName = HeaderName::from_static("x-request-id");
const DURATION_BUCKETS: [f64; 11] = [
    0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0,
];

#[derive(Default)]
struct MetricsInner {
    requests: BTreeMap<(String, String, u16), u64>,
    duration_buckets: [u64; DURATION_BUCKETS.len()],
    duration_sum_micros: u64,
    duration_count: u64,
    sync_operations: BTreeMap<String, u64>,
    auth_code_requests: BTreeMap<String, u64>,
    push_events: BTreeMap<String, u64>,
    readiness_failures: u64,
}

/// Process-local metrics for the single-binary deployment. Labels are bounded
/// (method, route template/normalized path, status) to keep cardinality low.
pub struct Metrics {
    started: Instant,
    inner: Mutex<MetricsInner>,
}

impl Default for Metrics {
    fn default() -> Self {
        Self::new()
    }
}

impl Metrics {
    pub fn new() -> Self {
        Self {
            started: Instant::now(),
            inner: Mutex::new(MetricsInner::default()),
        }
    }

    pub fn record_http(&self, method: &str, path: &str, status: u16, elapsed_seconds: f64) {
        let Ok(mut inner) = self.inner.lock() else {
            return;
        };
        *inner
            .requests
            .entry((method.to_owned(), path.to_owned(), status))
            .or_default() += 1;
        inner.duration_sum_micros = inner
            .duration_sum_micros
            .saturating_add((elapsed_seconds * 1_000_000.0) as u64);
        inner.duration_count = inner.duration_count.saturating_add(1);
        for (index, bound) in DURATION_BUCKETS.iter().enumerate() {
            if elapsed_seconds <= *bound {
                inner.duration_buckets[index] = inner.duration_buckets[index].saturating_add(1);
            }
        }
    }

    pub fn record_sync(&self, result: &str, count: u64) {
        if count == 0 {
            return;
        }
        let Ok(mut inner) = self.inner.lock() else {
            return;
        };
        *inner.sync_operations.entry(result.to_owned()).or_default() += count;
    }

    pub fn record_auth_code_request(&self, result: &str) {
        let Ok(mut inner) = self.inner.lock() else {
            return;
        };
        *inner
            .auth_code_requests
            .entry(result.to_owned())
            .or_default() += 1;
    }

    pub fn record_push(&self, result: &str, count: u64) {
        if count == 0 {
            return;
        }
        let Ok(mut inner) = self.inner.lock() else {
            return;
        };
        *inner.push_events.entry(result.to_owned()).or_default() += count;
    }

    pub fn record_readiness_failure(&self) {
        if let Ok(mut inner) = self.inner.lock() {
            inner.readiness_failures = inner.readiness_failures.saturating_add(1);
        }
    }

    pub fn render(&self) -> String {
        let inner = self.inner.lock().expect("metrics lock");
        let mut output = String::new();
        output.push_str("# HELP todo_uptime_seconds Process uptime in seconds.\n");
        output.push_str("# TYPE todo_uptime_seconds gauge\n");
        output.push_str(&format!(
            "todo_uptime_seconds {}\n",
            self.started.elapsed().as_secs_f64()
        ));

        output.push_str(
            "# HELP todo_http_requests_total HTTP requests by method, path and status.\n",
        );
        output.push_str("# TYPE todo_http_requests_total counter\n");
        for ((method, path, status), count) in &inner.requests {
            output.push_str(&format!(
                "todo_http_requests_total{{method=\"{method}\",path=\"{path}\",status=\"{status}\"}} {count}\n"
            ));
        }

        output.push_str(
            "# HELP todo_http_request_duration_seconds HTTP request latency.\n# TYPE todo_http_request_duration_seconds histogram\n",
        );
        for (index, bound) in DURATION_BUCKETS.iter().enumerate() {
            output.push_str(&format!(
                "todo_http_request_duration_seconds_bucket{{le=\"{bound}\"}} {}\n",
                inner.duration_buckets[index]
            ));
        }
        output.push_str(&format!(
            "todo_http_request_duration_seconds_bucket{{le=\"+Inf\"}} {}\n",
            inner.duration_count
        ));
        output.push_str(&format!(
            "todo_http_request_duration_seconds_sum {}\n",
            inner.duration_sum_micros as f64 / 1_000_000.0
        ));
        output.push_str(&format!(
            "todo_http_request_duration_seconds_count {}\n",
            inner.duration_count
        ));

        output.push_str("# HELP todo_sync_operations_total Sync operations by result.\n");
        output.push_str("# TYPE todo_sync_operations_total counter\n");
        for (result, count) in &inner.sync_operations {
            output.push_str(&format!(
                "todo_sync_operations_total{{result=\"{result}\"}} {count}\n"
            ));
        }

        output.push_str("# HELP todo_auth_code_requests_total Auth code requests by outcome.\n");
        output.push_str("# TYPE todo_auth_code_requests_total counter\n");
        for (result, count) in &inner.auth_code_requests {
            output.push_str(&format!(
                "todo_auth_code_requests_total{{result=\"{result}\"}} {count}\n"
            ));
        }

        for result in ["sent", "failed", "skipped"] {
            let count = inner.push_events.get(result).copied().unwrap_or_default();
            output.push_str(&format!(
                "# HELP todo_push_{result}_total Web Push operations by outcome.\n"
            ));
            output.push_str(&format!("# TYPE todo_push_{result}_total counter\n"));
            output.push_str(&format!("todo_push_{result}_total {count}\n"));
        }

        output.push_str("# HELP todo_readiness_failures_total Failed readiness probes.\n");
        output.push_str("# TYPE todo_readiness_failures_total counter\n");
        output.push_str(&format!(
            "todo_readiness_failures_total {}\n",
            inner.readiness_failures
        ));
        output
    }
}

pub fn router() -> axum::Router<AppState> {
    axum::Router::new().route(
        "/metrics",
        axum::routing::get(|State(state): State<AppState>| async move {
            (
                [(CONTENT_TYPE, "text/plain; version=0.0.4; charset=utf-8")],
                state.metrics.render(),
            )
                .into_response()
        }),
    )
}

/// Generates/propagates a request id, records bounded HTTP metrics and writes an
/// access log line that never includes query strings, headers or bodies.
pub async fn observability(
    State(state): State<AppState>,
    request: Request<axum::body::Body>,
    next: Next,
) -> Response {
    let supplied = request
        .headers()
        .get(&REQUEST_ID_HEADER)
        .and_then(|value| value.to_str().ok())
        .filter(|value| valid_request_id(value))
        .map(str::to_owned);
    let request_id = supplied.unwrap_or_else(|| Uuid::new_v4().to_string());
    let method = request.method().as_str().to_owned();
    let path = normalize_path(request.uri().path());
    let started = Instant::now();
    let mut response = next.run(request).await;
    let elapsed = started.elapsed().as_secs_f64();
    let status = response.status().as_u16();

    if let Ok(value) = HeaderValue::from_str(&request_id) {
        response.headers_mut().insert(REQUEST_ID_HEADER, value);
    }
    state.metrics.record_http(&method, &path, status, elapsed);
    tracing::info!(
        request_id = %request_id,
        method = %method,
        path = %path,
        status,
        latency_ms = elapsed * 1000.0,
        "http_access"
    );
    response
}

fn valid_request_id(value: &str) -> bool {
    (16..=128).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-'))
}

fn normalize_path(path: &str) -> String {
    if path.is_empty() {
        return "/".to_owned();
    }
    path.split('/')
        .map(|segment| {
            if Uuid::parse_str(segment).is_ok() {
                "{id}"
            } else {
                segment
            }
        })
        .collect::<Vec<_>>()
        .join("/")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_ids_are_bounded_and_safe() {
        assert!(valid_request_id("0123456789abcdef"));
        assert!(!valid_request_id("short"));
        assert!(!valid_request_id("0123456789abcde<"));
    }

    #[test]
    fn paths_hide_uuids_but_keep_routes() {
        assert_eq!(
            normalize_path("/api/v1/devices/019a0000-0000-7000-8000-000000000001"),
            "/api/v1/devices/{id}"
        );
        assert_eq!(normalize_path("/api/v1/sync"), "/api/v1/sync");
    }

    #[test]
    fn metrics_render_prometheus_text() {
        let metrics = Metrics::new();
        metrics.record_http("GET", "/healthz", 200, 0.002);
        metrics.record_sync("applied", 2);
        metrics.record_push("sent", 3);
        metrics.record_push("failed", 1);
        let text = metrics.render();
        assert!(text.contains(
            "todo_http_requests_total{method=\"GET\",path=\"/healthz\",status=\"200\"} 1"
        ));
        assert!(text.contains("todo_sync_operations_total{result=\"applied\"} 2"));
        assert!(text.contains("todo_push_sent_total 3"));
        assert!(text.contains("todo_push_failed_total 1"));
        assert!(text.contains("todo_push_skipped_total 0"));
        assert!(text.contains("todo_http_request_duration_seconds_count 1"));
    }
}
