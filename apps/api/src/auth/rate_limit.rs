use hmac::{Hmac, Mac};
use sha2::Sha256;
use sqlx::{Postgres, Transaction};

type HmacSha256 = Hmac<Sha256>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuthRequestLimit {
    Allowed,
    /// The per-email limit was reached. Callers still return the generic 202
    /// response so account existence cannot be inferred from a 429.
    Suppressed,
    GlobalExceeded,
}

/// PostgreSQL-backed fixed-window limiter. Every increment is an atomic
/// `INSERT ... ON CONFLICT DO UPDATE`, so multiple API instances sharing the
/// database observe one consistent budget. Records are keyed by a keyed hash of
/// the normalized email rather than plaintext addresses.
pub struct AuthRateLimiter {
    fingerprint_key: [u8; 32],
    per_email_max: i64,
    global_max: i64,
    window_seconds: f64,
}

impl AuthRateLimiter {
    pub fn new(secret: &str, per_email_max: usize, global_max: usize, window_seconds: u64) -> Self {
        Self {
            fingerprint_key: derive_key(secret, b"todo/auth-rate-limit/v1"),
            per_email_max: per_email_max as i64,
            global_max: global_max as i64,
            window_seconds: window_seconds.max(60) as f64,
        }
    }

    /// Must be called inside the auth request transaction. The global bucket is
    /// checked first so a single caller cannot bypass the shared ceiling by
    /// rotating email addresses.
    pub async fn check(
        &self,
        tx: &mut Transaction<'_, Postgres>,
        email_normalized: &str,
    ) -> Result<AuthRequestLimit, sqlx::Error> {
        let global_count = self
            .record(tx, "auth_code_request_global", &[0_u8; 32])
            .await?;
        if global_count > self.global_max {
            return Ok(AuthRequestLimit::GlobalExceeded);
        }

        let email_hash = self.fingerprint(email_normalized);
        let email_count = self
            .record(tx, "auth_code_request_email", &email_hash)
            .await?;
        if email_count > self.per_email_max {
            Ok(AuthRequestLimit::Suppressed)
        } else {
            Ok(AuthRequestLimit::Allowed)
        }
    }

    async fn record(
        &self,
        tx: &mut Transaction<'_, Postgres>,
        bucket: &str,
        subject_hash: &[u8; 32],
    ) -> Result<i64, sqlx::Error> {
        let count: i64 = sqlx::query_scalar(
            r#"
            INSERT INTO auth_rate_limit_windows AS arl
                (bucket, subject_hash, window_start, request_count)
            VALUES (
                $1,
                $2,
                to_timestamp(
                    floor(extract(epoch FROM clock_timestamp()) / $3::double precision)
                    * $3::double precision
                ),
                1
            )
            ON CONFLICT (bucket, subject_hash, window_start)
            DO UPDATE SET
                request_count = arl.request_count + 1,
                updated_at = now()
            RETURNING request_count
            "#,
        )
        .bind(bucket)
        .bind(subject_hash.as_slice())
        .bind(self.window_seconds)
        .fetch_one(&mut **tx)
        .await?;
        Ok(count)
    }

    fn fingerprint(&self, email_normalized: &str) -> [u8; 32] {
        let mut mac =
            HmacSha256::new_from_slice(&self.fingerprint_key).expect("HMAC accepts any key");
        mac.update(email_normalized.as_bytes());
        mac.finalize().into_bytes().into()
    }
}

fn derive_key(secret: &str, context: &[u8]) -> [u8; 32] {
    let mut mac = HmacSha256::new_from_slice(secret.as_bytes()).expect("HMAC accepts any key");
    mac.update(context);
    mac.finalize().into_bytes().into()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn limiter() -> AuthRateLimiter {
        AuthRateLimiter::new("a-test-secret-that-is-at-least-32-bytes-long", 5, 300, 900)
    }

    #[test]
    fn fingerprints_are_stable_and_do_not_reveal_email() {
        let limiter = limiter();
        let first = limiter.fingerprint("person@example.com");
        let second = limiter.fingerprint("person@example.com");
        let other = limiter.fingerprint("other@example.com");
        assert_eq!(first, second);
        assert_ne!(first, other);
        assert!(
            !first
                .windows(b"person@example.com".len())
                .any(|window| window == b"person@example.com")
        );
    }

    #[test]
    fn different_secrets_produce_different_fingerprints() {
        let first = AuthRateLimiter::new("secret-one-that-is-at-least-32-bytes", 5, 300, 900)
            .fingerprint("person@example.com");
        let second = AuthRateLimiter::new("secret-two-that-is-at-least-32-bytes", 5, 300, 900)
            .fingerprint("person@example.com");
        assert_ne!(first, second);
    }
}
