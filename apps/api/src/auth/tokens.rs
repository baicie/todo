use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use chrono::Utc;
use hmac::{Hmac, Mac};
use jsonwebtoken::{Algorithm, DecodingKey, EncodingKey, Header, Validation, decode, encode};
use rand::{RngCore, rngs::OsRng};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::{config::Config, error::AppError};

const ISSUER: &str = "todo-api";
const AUDIENCE: &str = "todo-client";

type HmacSha256 = Hmac<Sha256>;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AccessClaims {
    pub sub: Uuid,
    pub sid: Uuid,
    pub did: Uuid,
    pub iss: String,
    pub aud: String,
    pub iat: i64,
    pub exp: i64,
}

pub struct JwtService {
    encoding: EncodingKey,
    decoding: DecodingKey,
    access_ttl_seconds: i64,
}

impl JwtService {
    pub fn new(config: &Config) -> Self {
        Self {
            encoding: EncodingKey::from_secret(config.jwt_secret.as_bytes()),
            decoding: DecodingKey::from_secret(config.jwt_secret.as_bytes()),
            access_ttl_seconds: config.access_token_ttl_seconds,
        }
    }

    pub fn issue_access(
        &self,
        user_id: Uuid,
        session_id: Uuid,
        device_id: Uuid,
    ) -> Result<(String, i64), AppError> {
        let now = Utc::now().timestamp();
        let claims = AccessClaims {
            sub: user_id,
            sid: session_id,
            did: device_id,
            iss: ISSUER.to_owned(),
            aud: AUDIENCE.to_owned(),
            iat: now,
            exp: now + self.access_ttl_seconds,
        };
        let token = encode(&Header::new(Algorithm::HS256), &claims, &self.encoding)
            .map_err(|error| AppError::Internal(format!("could not sign access token: {error}")))?;
        Ok((token, self.access_ttl_seconds))
    }

    pub fn decode_access(&self, token: &str) -> Result<AccessClaims, AppError> {
        if token.is_empty() || token.len() > 8192 {
            return Err(AppError::invalid_token());
        }
        let mut validation = Validation::new(Algorithm::HS256);
        validation.validate_exp = true;
        validation.validate_nbf = false;
        validation.validate_aud = false;
        validation.leeway = 5;
        validation.set_required_spec_claims(&["exp", "sub"]);

        let data = decode::<AccessClaims>(token, &self.decoding, &validation)
            .map_err(|_| AppError::invalid_token())?;
        let claims = data.claims;
        if claims.iss != ISSUER || claims.aud != AUDIENCE || claims.exp <= claims.iat {
            return Err(AppError::invalid_token());
        }
        Ok(claims)
    }
}

pub struct AuthCodeHasher {
    key: [u8; 32],
}

impl AuthCodeHasher {
    pub fn new(secret: &str) -> Self {
        Self {
            key: derive_key(secret, b"todo/auth-code/v1"),
        }
    }

    pub fn hash(&self, code: &str) -> Vec<u8> {
        let mut mac = HmacSha256::new_from_slice(&self.key).expect("HMAC accepts any key");
        mac.update(code.as_bytes());
        mac.finalize().into_bytes().to_vec()
    }

    pub fn verify(&self, code: &str, expected_hash: &[u8]) -> bool {
        let mut mac = HmacSha256::new_from_slice(&self.key).expect("HMAC accepts any key");
        mac.update(code.as_bytes());
        mac.verify_slice(expected_hash).is_ok()
    }
}

/// Returns the opaque token for the client and the SHA-256 hash to persist.
/// The token is 256 random bits encoded with base64url (no padding).
pub fn generate_refresh_token() -> (String, Vec<u8>) {
    let mut bytes = [0_u8; 32];
    OsRng.fill_bytes(&mut bytes);
    let token = URL_SAFE_NO_PAD.encode(bytes);
    let hash = hash_refresh_token(&token);
    (token, hash)
}

pub fn hash_refresh_token(token: &str) -> Vec<u8> {
    Sha256::digest(token.as_bytes()).to_vec()
}

pub fn generate_auth_code() -> String {
    let mut bytes = [0_u8; 4];
    OsRng.fill_bytes(&mut bytes);
    let number = u32::from_le_bytes(bytes) % 1_000_000;
    format!("{number:06}")
}

fn derive_key(secret: &str, context: &[u8]) -> [u8; 32] {
    let mut mac = HmacSha256::new_from_slice(secret.as_bytes()).expect("HMAC accepts any key");
    mac.update(context);
    mac.finalize().into_bytes().into()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config() -> Config {
        Config::for_test()
    }

    #[test]
    fn jwt_round_trip_preserves_identity() {
        let config = config();
        let service = JwtService::new(&config);
        let user_id = Uuid::new_v4();
        let session_id = Uuid::new_v4();
        let device_id = Uuid::new_v4();
        let (token, ttl) = service
            .issue_access(user_id, session_id, device_id)
            .unwrap();
        let claims = service.decode_access(&token).unwrap();
        assert_eq!(claims.sub, user_id);
        assert_eq!(claims.sid, session_id);
        assert_eq!(claims.did, device_id);
        assert_eq!(claims.iss, ISSUER);
        assert_eq!(claims.aud, AUDIENCE);
        assert_eq!(ttl, config.access_token_ttl_seconds);
    }

    #[test]
    fn jwt_rejects_a_different_secret() {
        let config = config();
        let service = JwtService::new(&config);
        let (token, _) = service
            .issue_access(Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4())
            .unwrap();
        let mut other = config.clone();
        other.jwt_secret = "another-test-secret-that-is-at-least-32-bytes".to_owned();
        let other_service = JwtService::new(&other);
        assert!(other_service.decode_access(&token).is_err());
    }

    #[test]
    fn refresh_tokens_have_256_bits_and_hashes_are_stable() {
        let (token, hash) = generate_refresh_token();
        assert_eq!(URL_SAFE_NO_PAD.decode(token.as_bytes()).unwrap().len(), 32);
        assert_eq!(hash, hash_refresh_token(&token));
        assert_eq!(hash.len(), 32);
        let (other, _) = generate_refresh_token();
        assert_ne!(token, other);
    }

    #[test]
    fn auth_codes_are_hashed_and_verified_in_constant_time() {
        let hasher = AuthCodeHasher::new("a-test-secret-that-is-at-least-32-bytes-long");
        let hash = hasher.hash("246810");
        assert_eq!(hash.len(), 32);
        assert!(hasher.verify("246810", &hash));
        assert!(!hasher.verify("000000", &hash));
    }

    #[test]
    fn generated_codes_are_six_digits() {
        for _ in 0..64 {
            let code = generate_auth_code();
            assert_eq!(code.len(), 6);
            assert!(code.bytes().all(|byte| byte.is_ascii_digit()));
        }
    }
}
