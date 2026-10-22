use std::{fmt, str::FromStr, time::Duration};

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use chrono::{DateTime, Utc};
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use uuid::Uuid;

use crate::domain::EntityType;

const TOKEN_VERSION: u8 = 1;
const MAX_TOKEN_LEN: usize = 16 * 1024;
const DEFAULT_TTL: Duration = Duration::from_secs(15 * 60);

type HmacSha256 = Hmac<Sha256>;

#[derive(Debug, Clone)]
pub struct ContinuationCodec {
    key: [u8; 32],
    ttl: Duration,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BootstrapContinuation {
    pub user_id: Uuid,
    pub snapshot_cursor: i64,
    pub snapshot_at: DateTime<Utc>,
    pub last_entity: Option<EntityType>,
    pub last_id: Option<Uuid>,
    pub expires_at: i64,
}

#[derive(Debug, Serialize, Deserialize)]
struct WirePayload {
    v: u8,
    uid: Uuid,
    snapshot_cursor: i64,
    snapshot_at: DateTime<Utc>,
    last_entity: Option<EntityType>,
    last_id: Option<Uuid>,
    exp: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ContinuationError {
    Invalid,
    Expired,
}

impl fmt::Display for ContinuationError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Invalid => formatter.write_str("invalid continuation token"),
            Self::Expired => formatter.write_str("continuation token expired"),
        }
    }
}

impl std::error::Error for ContinuationError {}

impl ContinuationCodec {
    pub fn new(secret: &str) -> Self {
        Self {
            key: derive_key(secret, b"todo/bootstrap-continuation/v1"),
            ttl: DEFAULT_TTL,
        }
    }

    pub fn issue(
        &self,
        user_id: Uuid,
        snapshot_cursor: i64,
        snapshot_at: DateTime<Utc>,
        last_entity: Option<EntityType>,
        last_id: Option<Uuid>,
    ) -> String {
        self.issue_with_expiry(
            user_id,
            snapshot_cursor,
            snapshot_at,
            last_entity,
            last_id,
            Utc::now() + chrono::Duration::from_std(self.ttl).unwrap_or_default(),
        )
    }

    fn issue_with_expiry(
        &self,
        user_id: Uuid,
        snapshot_cursor: i64,
        snapshot_at: DateTime<Utc>,
        last_entity: Option<EntityType>,
        last_id: Option<Uuid>,
        expires_at: DateTime<Utc>,
    ) -> String {
        let payload = WirePayload {
            v: TOKEN_VERSION,
            uid: user_id,
            snapshot_cursor,
            snapshot_at,
            last_entity,
            last_id,
            exp: expires_at.timestamp(),
        };
        let encoded = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&payload).expect("serializable"));
        let signature = self.sign(encoded.as_bytes());
        format!("{encoded}.{}", URL_SAFE_NO_PAD.encode(signature))
    }

    pub fn verify(
        &self,
        token: &str,
        expected_user: Uuid,
    ) -> Result<BootstrapContinuation, ContinuationError> {
        if token.len() > MAX_TOKEN_LEN {
            return Err(ContinuationError::Invalid);
        }
        let (encoded, signature) = token.split_once('.').ok_or(ContinuationError::Invalid)?;
        if encoded.is_empty() || signature.is_empty() || signature.contains('.') {
            return Err(ContinuationError::Invalid);
        }
        let signature = URL_SAFE_NO_PAD
            .decode(signature)
            .map_err(|_| ContinuationError::Invalid)?;
        let mut mac = HmacSha256::new_from_slice(&self.key).expect("HMAC accepts any key");
        mac.update(encoded.as_bytes());
        mac.verify_slice(&signature)
            .map_err(|_| ContinuationError::Invalid)?;

        let bytes = URL_SAFE_NO_PAD
            .decode(encoded)
            .map_err(|_| ContinuationError::Invalid)?;
        let payload: WirePayload =
            serde_json::from_slice(&bytes).map_err(|_| ContinuationError::Invalid)?;
        if payload.v != TOKEN_VERSION
            || payload.uid != expected_user
            || payload.snapshot_cursor < 0
            || payload.last_entity.is_some() != payload.last_id.is_some()
        {
            return Err(ContinuationError::Invalid);
        }
        if payload.exp <= Utc::now().timestamp() {
            return Err(ContinuationError::Expired);
        }

        Ok(BootstrapContinuation {
            user_id: payload.uid,
            snapshot_cursor: payload.snapshot_cursor,
            snapshot_at: payload.snapshot_at,
            last_entity: payload.last_entity,
            last_id: payload.last_id,
            expires_at: payload.exp,
        })
    }

    fn sign(&self, message: &[u8]) -> Vec<u8> {
        let mut mac = HmacSha256::new_from_slice(&self.key).expect("HMAC accepts any key");
        mac.update(message);
        mac.finalize().into_bytes().to_vec()
    }

    #[cfg(test)]
    fn with_ttl(mut self, ttl: Duration) -> Self {
        self.ttl = ttl;
        self
    }
}

fn derive_key(secret: &str, context: &[u8]) -> [u8; 32] {
    let mut mac = HmacSha256::new_from_slice(secret.as_bytes()).expect("HMAC accepts any key");
    mac.update(context);
    mac.finalize().into_bytes().into()
}

/// Query-friendly validation for a continuation supplied by a client.
pub fn parse_continuation_limit(value: Option<&str>) -> Result<u32, ContinuationError> {
    let Some(value) = value else {
        return Ok(500);
    };
    let raw = u32::from_str(value).map_err(|_| ContinuationError::Invalid)?;
    if !(1..=500).contains(&raw) {
        return Err(ContinuationError::Invalid);
    }
    Ok(raw)
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeDelta;

    fn codec() -> ContinuationCodec {
        ContinuationCodec::new("a-test-secret-that-is-at-least-32-bytes-long")
    }

    #[test]
    fn continuation_round_trips_and_is_account_bound() {
        let codec = codec();
        let user = Uuid::new_v4();
        let other_user = Uuid::new_v4();
        let snapshot_at = Utc::now();
        let token = codec.issue(
            user,
            42,
            snapshot_at,
            Some(EntityType::Task),
            Some(Uuid::new_v4()),
        );

        let verified = codec.verify(&token, user).unwrap();
        assert_eq!(verified.user_id, user);
        assert_eq!(verified.snapshot_cursor, 42);
        assert_eq!(verified.snapshot_at, snapshot_at);
        assert_eq!(verified.last_entity, Some(EntityType::Task));
        assert_eq!(
            codec.verify(&token, other_user),
            Err(ContinuationError::Invalid)
        );
    }

    #[test]
    fn continuation_tampering_is_rejected() {
        let codec = codec();
        let user = Uuid::new_v4();
        let token = codec.issue(user, 7, Utc::now(), None, None);
        let (payload, signature) = token.split_once('.').unwrap();
        let mut bytes = URL_SAFE_NO_PAD.decode(payload).unwrap();
        // Flip a byte in the JSON payload while leaving the HMAC untouched.
        bytes[0] ^= 0b0000_0001;
        let tampered = format!("{}.{}", URL_SAFE_NO_PAD.encode(bytes), signature);
        assert_eq!(
            codec.verify(&tampered, user),
            Err(ContinuationError::Invalid)
        );
    }

    #[test]
    fn malformed_tokens_are_rejected() {
        let codec = codec();
        let user = Uuid::new_v4();
        for token in ["", ".", "abc", "a.b.c", "not-base64.signature"] {
            assert_eq!(codec.verify(token, user), Err(ContinuationError::Invalid));
        }
    }

    #[test]
    fn expired_continuation_is_rejected() {
        let codec = codec();
        let user = Uuid::new_v4();
        let token = codec.issue_with_expiry(
            user,
            1,
            Utc::now(),
            None,
            None,
            Utc::now() - TimeDelta::seconds(1),
        );
        assert_eq!(codec.verify(&token, user), Err(ContinuationError::Expired));
    }

    #[test]
    fn continuation_limit_is_strictly_parsed() {
        assert_eq!(parse_continuation_limit(None), Ok(500));
        assert_eq!(parse_continuation_limit(Some("1")), Ok(1));
        assert_eq!(parse_continuation_limit(Some("500")), Ok(500));
        for invalid in ["0", "501", "-1", " 5", "abc"] {
            assert_eq!(
                parse_continuation_limit(Some(invalid)),
                Err(ContinuationError::Invalid)
            );
        }
    }

    #[test]
    fn short_lived_token_ttl_still_works() {
        let codec = codec().with_ttl(Duration::from_secs(1));
        let user = Uuid::new_v4();
        let token = codec.issue(user, 1, Utc::now(), None, None);
        assert!(codec.verify(&token, user).is_ok());
    }
}
