use std::{
    env,
    fmt::{self, Display},
    net::SocketAddr,
    str::FromStr,
    time::Duration,
};

use base64::{
    Engine,
    engine::general_purpose::{URL_SAFE, URL_SAFE_NO_PAD},
};
use lettre::message::Mailbox;

pub const DEFAULT_ACCESS_TOKEN_TTL_SECONDS: i64 = 15 * 60;
pub const DEFAULT_AUTH_CODE_TTL_SECONDS: i64 = 10 * 60;
pub const DEFAULT_REFRESH_TOKEN_TTL_DAYS: i64 = 30;
pub const MAX_SYNC_OPS: usize = 100;
pub const MAX_SYNC_CHANGES: u32 = 500;
pub const MAX_BOOTSTRAP_ENTITIES: u32 = 500;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AppEnv {
    Development,
    Test,
    Production,
}

impl AppEnv {
    pub fn is_development(self) -> bool {
        matches!(self, Self::Development | Self::Test)
    }
}

impl FromStr for AppEnv {
    type Err = ConfigError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value.trim().to_ascii_lowercase().as_str() {
            "development" | "dev" => Ok(Self::Development),
            "test" => Ok(Self::Test),
            "production" | "prod" => Ok(Self::Production),
            other => Err(ConfigError(format!(
                "APP_ENV must be development, test, or production (got {other:?})"
            ))),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SmtpTlsMode {
    Starttls,
    Implicit,
}

impl SmtpTlsMode {
    pub fn default_port(self) -> u16 {
        match self {
            Self::Starttls => 587,
            Self::Implicit => 465,
        }
    }
}

impl FromStr for SmtpTlsMode {
    type Err = ConfigError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value.trim().to_ascii_lowercase().as_str() {
            "starttls" => Ok(Self::Starttls),
            "implicit" | "tls" | "ssl" | "smtps" => Ok(Self::Implicit),
            "none" => Err(ConfigError(
                "SMTP_TLS=none is not allowed; production SMTP requires TLS".to_owned(),
            )),
            _ => Err(ConfigError(
                "SMTP_TLS must be starttls or implicit".to_owned(),
            )),
        }
    }
}

#[derive(Clone, PartialEq, Eq)]
pub struct MailConfig {
    pub smtp_host: String,
    pub smtp_port: u16,
    pub smtp_tls: SmtpTlsMode,
    pub auth_username: String,
    pub auth_password: String,
    pub mail_from: String,
}

impl fmt::Debug for MailConfig {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("MailConfig")
            .field("smtp_host", &self.smtp_host)
            .field("smtp_port", &self.smtp_port)
            .field("smtp_tls", &self.smtp_tls)
            .field("auth_username", &"[REDACTED]")
            .field("auth_password", &"[REDACTED]")
            .field("mail_from", &self.mail_from)
            .finish()
    }
}

#[derive(Clone, PartialEq, Eq)]
pub struct PushConfig {
    pub public_key: String,
    pub private_key: String,
    pub subject: String,
}

impl fmt::Debug for PushConfig {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("PushConfig")
            .field("public_key", &self.public_key)
            .field("private_key", &"[REDACTED]")
            .field("subject", &self.subject)
            .finish()
    }
}

#[derive(Clone)]
pub struct Config {
    pub app_env: AppEnv,
    pub database_url: String,
    pub bind_addr: SocketAddr,
    pub jwt_secret: String,
    pub cors_origins: Vec<String>,
    pub auth_dev_code: Option<String>,
    pub mail: Option<MailConfig>,
    pub push: Option<PushConfig>,
    pub push_worker_interval_seconds: u64,
    pub access_token_ttl_seconds: i64,
    pub refresh_token_ttl_seconds: i64,
    pub auth_code_ttl_seconds: i64,
    pub auth_code_resend_seconds: i64,
    pub auth_code_requests_per_window: usize,
    pub auth_code_window_seconds: u64,
    pub auth_code_global_requests_per_window: usize,
    pub auth_code_max_attempts: i32,
    pub cookie_secure: bool,
    pub request_timeout_seconds: u64,
    pub max_body_bytes: usize,
    pub db_max_connections: u32,
}

impl Config {
    pub fn from_env() -> Result<Self, ConfigError> {
        let app_env = env::var("APP_ENV")
            .unwrap_or_else(|_| "development".to_owned())
            .parse::<AppEnv>()?;

        let database_url = required("DATABASE_URL")?;
        let bind_addr = env::var("BIND_ADDR")
            .unwrap_or_else(|_| "127.0.0.1:8787".to_owned())
            .parse()
            .map_err(|_| ConfigError("BIND_ADDR must be a socket address".to_owned()))?;

        let jwt_secret = required("JWT_SECRET")?;
        if jwt_secret.len() < 32 {
            return Err(ConfigError(
                "JWT_SECRET must contain at least 32 bytes of entropy".to_owned(),
            ));
        }

        let cors_origins = parse_origins(env::var("CORS_ORIGINS").ok().as_deref(), app_env)?;

        let auth_dev_code = if app_env.is_development() {
            let code = env::var("AUTH_DEV_CODE").unwrap_or_else(|_| "246810".to_owned());
            if !is_six_digit_code(&code) {
                return Err(ConfigError(
                    "AUTH_DEV_CODE must be exactly six ASCII digits".to_owned(),
                ));
            }
            Some(code)
        } else {
            None
        };

        if app_env == AppEnv::Production
            && matches!(
                jwt_secret.as_str(),
                "replace-with-at-least-32-random-characters"
                    | "local-development-only-change-this-jwt-secret"
            )
        {
            return Err(ConfigError(
                "JWT_SECRET is still set to a documented development default".to_owned(),
            ));
        }

        let mail = parse_mail_config(
            app_env,
            MailEnvValues {
                host: env::var("SMTP_HOST").ok(),
                port: env::var("SMTP_PORT").ok(),
                tls: env::var("SMTP_TLS").ok(),
                username: env::var("AUTH_USERNAME").ok(),
                password: env::var("AUTH_PASSWORD").ok(),
                mail_from: env::var("MAIL_FROM").ok(),
            },
        )?;

        let web_push_enabled = parse_optional_bool("WEB_PUSH_ENABLED", false)?;
        let push = parse_push_config(
            web_push_enabled,
            PushEnvValues {
                public_key: env::var("VAPID_PUBLIC_KEY").ok(),
                private_key: env::var("VAPID_PRIVATE_KEY").ok(),
                subject: env::var("VAPID_SUBJECT").ok(),
            },
        )?;
        let push_worker_interval_seconds = parse_number("PUSH_WORKER_INTERVAL_SECONDS", 30_u64)?;
        if !(1..=3600).contains(&push_worker_interval_seconds) {
            return Err(ConfigError(
                "PUSH_WORKER_INTERVAL_SECONDS must be between 1 and 3600".to_owned(),
            ));
        }

        let access_token_ttl_seconds =
            parse_number("ACCESS_TOKEN_TTL_SECONDS", DEFAULT_ACCESS_TOKEN_TTL_SECONDS)?;
        if !(60..=3600).contains(&access_token_ttl_seconds) {
            return Err(ConfigError(
                "ACCESS_TOKEN_TTL_SECONDS must be between 60 and 3600".to_owned(),
            ));
        }

        let refresh_token_ttl_days =
            parse_number("REFRESH_TOKEN_TTL_DAYS", DEFAULT_REFRESH_TOKEN_TTL_DAYS)?;
        if !(1..=365).contains(&refresh_token_ttl_days) {
            return Err(ConfigError(
                "REFRESH_TOKEN_TTL_DAYS must be between 1 and 365".to_owned(),
            ));
        }

        let auth_code_ttl_seconds =
            parse_number("AUTH_CODE_TTL_SECONDS", DEFAULT_AUTH_CODE_TTL_SECONDS)?;
        if !(60..=1800).contains(&auth_code_ttl_seconds) {
            return Err(ConfigError(
                "AUTH_CODE_TTL_SECONDS must be between 60 and 1800".to_owned(),
            ));
        }

        let auth_code_resend_seconds = parse_number("AUTH_CODE_RESEND_SECONDS", 60_i64)?;
        if !(1..=900).contains(&auth_code_resend_seconds) {
            return Err(ConfigError(
                "AUTH_CODE_RESEND_SECONDS must be between 1 and 900".to_owned(),
            ));
        }

        let auth_code_requests_per_window = parse_number("AUTH_CODE_REQUESTS_PER_WINDOW", 5_usize)?;
        if !(1..=100).contains(&auth_code_requests_per_window) {
            return Err(ConfigError(
                "AUTH_CODE_REQUESTS_PER_WINDOW must be between 1 and 100".to_owned(),
            ));
        }

        let auth_code_window_seconds = parse_number("AUTH_CODE_WINDOW_SECONDS", 900_u64)?;
        if !(60..=86_400).contains(&auth_code_window_seconds) {
            return Err(ConfigError(
                "AUTH_CODE_WINDOW_SECONDS must be between 60 and 86400".to_owned(),
            ));
        }

        let auth_code_global_requests_per_window =
            parse_number("AUTH_CODE_GLOBAL_REQUESTS_PER_WINDOW", 300_usize)?;
        if !(1..=100_000).contains(&auth_code_global_requests_per_window) {
            return Err(ConfigError(
                "AUTH_CODE_GLOBAL_REQUESTS_PER_WINDOW must be between 1 and 100000".to_owned(),
            ));
        }

        let auth_code_max_attempts = parse_number("AUTH_CODE_MAX_ATTEMPTS", 5_i32)?;
        if !(1..=10).contains(&auth_code_max_attempts) {
            return Err(ConfigError(
                "AUTH_CODE_MAX_ATTEMPTS must be between 1 and 10".to_owned(),
            ));
        }

        let cookie_secure = parse_optional_bool("COOKIE_SECURE", app_env == AppEnv::Production)?;
        if app_env == AppEnv::Production && !cookie_secure {
            return Err(ConfigError(
                "COOKIE_SECURE must be true in production".to_owned(),
            ));
        }

        let request_timeout_seconds = parse_number("REQUEST_TIMEOUT_SECONDS", 30_u64)?;
        if !(1..=300).contains(&request_timeout_seconds) {
            return Err(ConfigError(
                "REQUEST_TIMEOUT_SECONDS must be between 1 and 300".to_owned(),
            ));
        }

        let max_body_bytes = parse_number("MAX_BODY_BYTES", 1024 * 1024_usize)?;
        if !(1024..=10 * 1024 * 1024).contains(&max_body_bytes) {
            return Err(ConfigError(
                "MAX_BODY_BYTES must be between 1024 and 10485760".to_owned(),
            ));
        }

        let db_max_connections = parse_number("DB_MAX_CONNECTIONS", 10_u32)?;
        if !(1..=100).contains(&db_max_connections) {
            return Err(ConfigError(
                "DB_MAX_CONNECTIONS must be between 1 and 100".to_owned(),
            ));
        }

        Ok(Self {
            app_env,
            database_url,
            bind_addr,
            jwt_secret,
            cors_origins,
            auth_dev_code,
            mail,
            push,
            push_worker_interval_seconds,
            access_token_ttl_seconds,
            refresh_token_ttl_seconds: refresh_token_ttl_days * 86_400,
            auth_code_ttl_seconds,
            auth_code_resend_seconds,
            auth_code_requests_per_window,
            auth_code_window_seconds,
            auth_code_global_requests_per_window,
            auth_code_max_attempts,
            cookie_secure,
            request_timeout_seconds,
            max_body_bytes,
            db_max_connections,
        })
    }

    pub fn request_timeout(&self) -> Duration {
        Duration::from_secs(self.request_timeout_seconds)
    }

    /// Configuration that is safe for unit tests and lazy PgPools.
    #[doc(hidden)]
    pub fn for_test() -> Self {
        Self {
            app_env: AppEnv::Test,
            database_url: "postgres://todo:todo@127.0.0.1/todo_test".to_owned(),
            bind_addr: "127.0.0.1:0".parse().expect("valid test address"),
            jwt_secret: "test-only-jwt-secret-with-more-than-32-bytes".to_owned(),
            cors_origins: vec!["http://localhost:5173".to_owned()],
            auth_dev_code: Some("246810".to_owned()),
            mail: None,
            push: None,
            push_worker_interval_seconds: 30,
            access_token_ttl_seconds: DEFAULT_ACCESS_TOKEN_TTL_SECONDS,
            refresh_token_ttl_seconds: DEFAULT_REFRESH_TOKEN_TTL_DAYS * 86_400,
            auth_code_ttl_seconds: DEFAULT_AUTH_CODE_TTL_SECONDS,
            auth_code_resend_seconds: 60,
            auth_code_requests_per_window: 5,
            auth_code_window_seconds: 900,
            auth_code_global_requests_per_window: 300,
            auth_code_max_attempts: 5,
            cookie_secure: false,
            request_timeout_seconds: 30,
            max_body_bytes: 1024 * 1024,
            db_max_connections: 5,
        }
    }
}

#[derive(Default)]
struct MailEnvValues {
    host: Option<String>,
    port: Option<String>,
    tls: Option<String>,
    username: Option<String>,
    password: Option<String>,
    mail_from: Option<String>,
}

fn parse_mail_config(
    app_env: AppEnv,
    values: MailEnvValues,
) -> Result<Option<MailConfig>, ConfigError> {
    if app_env != AppEnv::Production {
        // Development and test use the deterministic dev code and never open
        // an SMTP connection, preserving the original local workflow.
        return Ok(None);
    }

    let smtp_host = required_value("SMTP_HOST", values.host)?;
    if smtp_host.len() > 253
        || smtp_host.contains("://")
        || smtp_host.contains('/')
        || smtp_host.chars().any(char::is_whitespace)
    {
        return Err(ConfigError(
            "SMTP_HOST must be a hostname without scheme, path, or whitespace".to_owned(),
        ));
    }
    let smtp_tls = match values.tls.as_deref() {
        Some(value) if !value.trim().is_empty() => value.parse::<SmtpTlsMode>()?,
        _ => SmtpTlsMode::Starttls,
    };
    let smtp_port = match values.port {
        Some(value) if !value.trim().is_empty() => value
            .trim()
            .parse::<u16>()
            .map_err(|_| ConfigError("SMTP_PORT must be a valid TCP port".to_owned()))?,
        _ => smtp_tls.default_port(),
    };
    if smtp_port == 0 {
        return Err(ConfigError(
            "SMTP_PORT must be greater than zero".to_owned(),
        ));
    }

    let auth_username = required_value("AUTH_USERNAME", values.username)?;
    let auth_password = required_value("AUTH_PASSWORD", values.password)?;
    let mail_from = required_value("MAIL_FROM", values.mail_from)?;
    mail_from
        .parse::<Mailbox>()
        .map_err(|_| ConfigError("MAIL_FROM must be a valid mailbox".to_owned()))?;

    Ok(Some(MailConfig {
        smtp_host,
        smtp_port,
        smtp_tls,
        auth_username,
        auth_password,
        mail_from,
    }))
}

#[derive(Default)]
struct PushEnvValues {
    public_key: Option<String>,
    private_key: Option<String>,
    subject: Option<String>,
}

fn parse_push_config(
    enabled: bool,
    values: PushEnvValues,
) -> Result<Option<PushConfig>, ConfigError> {
    if !enabled {
        return Ok(None);
    }

    let public_key = push_required("VAPID_PUBLIC_KEY", values.public_key)?;
    let private_key = push_required("VAPID_PRIVATE_KEY", values.private_key)?;
    let subject = push_required("VAPID_SUBJECT", values.subject)?;
    validate_vapid_key("VAPID_PUBLIC_KEY", &public_key, 65)?;
    validate_vapid_key("VAPID_PRIVATE_KEY", &private_key, 32)?;

    let mailto = subject.strip_prefix("mailto:").unwrap_or_default();
    if mailto.is_empty()
        || !mailto.contains('@')
        || mailto.chars().any(char::is_whitespace)
        || subject.len() > 320
    {
        return Err(ConfigError(
            "VAPID_SUBJECT must be a mailto: URI containing an email address".to_owned(),
        ));
    }

    Ok(Some(PushConfig {
        public_key,
        private_key,
        subject,
    }))
}

fn push_required(name: &str, value: Option<String>) -> Result<String, ConfigError> {
    value
        .filter(|value| !value.trim().is_empty())
        .map(|value| value.trim().to_owned())
        .ok_or_else(|| ConfigError(format!("{name} is required when WEB_PUSH_ENABLED is true")))
}

fn validate_vapid_key(name: &str, value: &str, expected_bytes: usize) -> Result<(), ConfigError> {
    let bytes = URL_SAFE_NO_PAD
        .decode(value)
        .or_else(|_| URL_SAFE.decode(value))
        .map_err(|_| ConfigError(format!("{name} must be URL-safe base64")))?;
    if bytes.len() != expected_bytes {
        return Err(ConfigError(format!(
            "{name} must decode to {expected_bytes} bytes"
        )));
    }
    Ok(())
}

fn required_value(name: &str, value: Option<String>) -> Result<String, ConfigError> {
    value
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| ConfigError(format!("{name} is required in production")))
}

fn required(name: &str) -> Result<String, ConfigError> {
    env::var(name)
        .ok()
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| ConfigError(format!("{name} is required")))
}

fn parse_number<T>(name: &str, default: T) -> Result<T, ConfigError>
where
    T: FromStr,
    T::Err: Display,
{
    match env::var(name) {
        Ok(value) if !value.trim().is_empty() => value
            .trim()
            .parse()
            .map_err(|error| ConfigError(format!("{name} is invalid: {error}"))),
        _ => Ok(default),
    }
}

fn parse_optional_bool(name: &str, default: bool) -> Result<bool, ConfigError> {
    match env::var(name) {
        Ok(value) if !value.trim().is_empty() => match value.trim().to_ascii_lowercase().as_str() {
            "true" | "1" | "yes" => Ok(true),
            "false" | "0" | "no" => Ok(false),
            _ => Err(ConfigError(format!("{name} must be true or false"))),
        },
        _ => Ok(default),
    }
}

fn parse_origins(value: Option<&str>, app_env: AppEnv) -> Result<Vec<String>, ConfigError> {
    let raw = value.map(str::trim).filter(|value| !value.is_empty());
    let raw = match raw {
        Some(value) => value,
        None if app_env == AppEnv::Production => {
            return Err(ConfigError(
                "CORS_ORIGINS must be configured in production".to_owned(),
            ));
        }
        None => "http://localhost:5173",
    };

    let mut origins = Vec::new();
    for origin in raw
        .split(',')
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        let trimmed = origin.trim_end_matches('/');
        if trimmed == "*" {
            return Err(ConfigError(
                "CORS_ORIGINS must be an explicit allowlist, not *".to_owned(),
            ));
        }
        if !(trimmed.starts_with("https://") || trimmed.starts_with("http://")) {
            return Err(ConfigError(format!(
                "CORS origin is not an absolute http(s) origin: {origin:?}"
            )));
        }
        let authority = trimmed
            .strip_prefix("https://")
            .or_else(|| trimmed.strip_prefix("http://"))
            .unwrap_or_default();
        if authority.is_empty()
            || authority.contains('/')
            || authority.contains('?')
            || authority.contains('#')
            || authority.chars().any(char::is_whitespace)
        {
            return Err(ConfigError(format!(
                "CORS origin must not include a path, query, or whitespace: {origin:?}"
            )));
        }
        if app_env == AppEnv::Production && trimmed.starts_with("http://") {
            return Err(ConfigError(
                "CORS_ORIGINS must use https:// in production".to_owned(),
            ));
        }
        origins.push(trimmed.to_owned());
    }
    if origins.is_empty() {
        return Err(ConfigError("CORS_ORIGINS cannot be empty".to_owned()));
    }
    origins.sort();
    origins.dedup();
    Ok(origins)
}

fn is_six_digit_code(value: &str) -> bool {
    value.len() == 6 && value.bytes().all(|byte| byte.is_ascii_digit())
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConfigError(pub String);

impl Display for ConfigError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl std::error::Error for ConfigError {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn app_env_aliases_are_supported() {
        assert_eq!(
            "development".parse::<AppEnv>().unwrap(),
            AppEnv::Development
        );
        assert_eq!("PROD".parse::<AppEnv>().unwrap(), AppEnv::Production);
        assert!("staging".parse::<AppEnv>().is_err());
    }

    #[test]
    fn wildcard_cors_is_rejected() {
        let error = parse_origins(Some("*"), AppEnv::Production).unwrap_err();
        assert!(error.0.contains("explicit allowlist"));
    }

    #[test]
    fn origins_are_normalized_and_deduplicated() {
        let origins = parse_origins(
            Some("https://app.example.com/, https://app.example.com"),
            AppEnv::Production,
        )
        .unwrap();
        assert_eq!(origins, vec!["https://app.example.com"]);
    }

    #[test]
    fn production_requires_https_cors_origins() {
        assert!(parse_origins(Some("http://app.example.com"), AppEnv::Production).is_err());
        assert!(parse_origins(Some("https://app.example.com/path"), AppEnv::Production).is_err());
        assert!(parse_origins(Some("https://app.example.com"), AppEnv::Production).is_ok());
    }

    #[test]
    fn dev_code_must_be_six_digits() {
        assert!(is_six_digit_code("246810"));
        assert!(!is_six_digit_code("24681"));
        assert!(!is_six_digit_code("abcdef"));
    }

    #[test]
    fn smtp_tls_modes_are_strictly_parsed() {
        assert_eq!(
            "starttls".parse::<SmtpTlsMode>().unwrap(),
            SmtpTlsMode::Starttls
        );
        assert_eq!(
            "implicit".parse::<SmtpTlsMode>().unwrap(),
            SmtpTlsMode::Implicit
        );
        assert_eq!("ssl".parse::<SmtpTlsMode>().unwrap(), SmtpTlsMode::Implicit);
        assert!("none".parse::<SmtpTlsMode>().is_err());
    }

    fn valid_production_mail_values() -> MailEnvValues {
        MailEnvValues {
            host: Some("smtp.example.com".to_owned()),
            port: None,
            tls: Some("starttls".to_owned()),
            username: Some("smtp-user".to_owned()),
            password: Some("smtp-password".to_owned()),
            mail_from: Some("Shishi <no-reply@example.com>".to_owned()),
        }
    }

    #[test]
    fn production_requires_complete_mail_configuration() {
        let mut values = valid_production_mail_values();
        values.host = None;
        let error = parse_mail_config(AppEnv::Production, values).unwrap_err();
        assert!(error.0.contains("SMTP_HOST"));

        let mut values = valid_production_mail_values();
        values.mail_from = Some("not-a-mailbox".to_owned());
        let error = parse_mail_config(AppEnv::Production, values).unwrap_err();
        assert!(error.0.contains("MAIL_FROM"));
    }

    #[test]
    fn production_mail_config_uses_tls_defaults_and_redacts_debug() {
        let config = parse_mail_config(AppEnv::Production, valid_production_mail_values())
            .unwrap()
            .unwrap();
        assert_eq!(config.smtp_port, 587);
        assert_eq!(config.smtp_tls, SmtpTlsMode::Starttls);
        let debug = format!("{config:?}");
        assert!(!debug.contains("smtp-password"));
        assert!(debug.contains("[REDACTED]"));
    }

    fn valid_push_values() -> PushEnvValues {
        PushEnvValues {
            public_key: Some(URL_SAFE_NO_PAD.encode([7_u8; 65])),
            private_key: Some(URL_SAFE_NO_PAD.encode([9_u8; 32])),
            subject: Some("mailto:ops@example.com".to_owned()),
        }
    }

    #[test]
    fn web_push_is_optional_when_disabled() {
        assert_eq!(
            parse_push_config(false, PushEnvValues::default()).unwrap(),
            None
        );
    }

    #[test]
    fn web_push_requires_complete_configuration_when_enabled() {
        let mut values = valid_push_values();
        values.public_key = None;
        let error = parse_push_config(true, values).unwrap_err();
        assert!(error.0.contains("VAPID_PUBLIC_KEY"));

        let mut values = valid_push_values();
        values.subject = Some("https://example.com".to_owned());
        assert!(parse_push_config(true, values).is_err());

        let mut values = valid_push_values();
        values.private_key = Some("not-base64".to_owned());
        assert!(parse_push_config(true, values).is_err());
    }

    #[test]
    fn web_push_config_redacts_private_key() {
        let config = parse_push_config(true, valid_push_values())
            .unwrap()
            .unwrap();
        let debug = format!("{config:?}");
        assert!(!debug.contains(&config.private_key));
        assert!(debug.contains("[REDACTED]"));
    }

    #[test]
    fn development_ignores_mail_configuration() {
        assert_eq!(
            parse_mail_config(AppEnv::Development, MailEnvValues::default()).unwrap(),
            None
        );
    }
}
