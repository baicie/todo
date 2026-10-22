use std::sync::Arc;

use sqlx::PgPool;

use crate::{
    auth::{AuthCodeHasher, AuthRateLimiter, JwtService, continuation::ContinuationCodec},
    config::{Config, ConfigError},
    mail::{MailProvider, build_mailer},
    metrics::Metrics,
    push::{PushService, build_push_service},
};

#[derive(Clone)]
pub struct AppState {
    pub pool: PgPool,
    pub config: Arc<Config>,
    pub jwt: Arc<JwtService>,
    pub continuation: Arc<ContinuationCodec>,
    pub auth_codes: Arc<AuthCodeHasher>,
    pub auth_rate_limiter: Arc<AuthRateLimiter>,
    pub mailer: Arc<dyn MailProvider>,
    pub push: Option<Arc<PushService>>,
    pub metrics: Arc<Metrics>,
}

impl AppState {
    pub fn new(pool: PgPool, config: Config) -> Result<Self, ConfigError> {
        let mailer = build_mailer(&config)?;
        let push = build_push_service(&config)?;
        Ok(Self::with_services(pool, config, mailer, push))
    }

    /// Dependency-injection entry point used by integration tests and future
    /// providers. Production startup should normally use [`AppState::new`].
    pub fn with_mailer(pool: PgPool, config: Config, mailer: Arc<dyn MailProvider>) -> Self {
        let push = build_push_service(&config).ok().flatten();
        Self::with_services(pool, config, mailer, push)
    }

    /// Test entry point for routes that require an enabled Web Push service.
    pub fn with_mailer_and_push(
        pool: PgPool,
        config: Config,
        mailer: Arc<dyn MailProvider>,
        push: Option<PushService>,
    ) -> Self {
        Self::with_services(pool, config, mailer, push)
    }

    fn with_services(
        pool: PgPool,
        config: Config,
        mailer: Arc<dyn MailProvider>,
        push: Option<PushService>,
    ) -> Self {
        let config = Arc::new(config);
        let continuation = Arc::new(ContinuationCodec::new(&config.jwt_secret));

        Self {
            pool,
            jwt: Arc::new(JwtService::new(&config)),
            continuation,
            auth_codes: Arc::new(AuthCodeHasher::new(&config.jwt_secret)),
            auth_rate_limiter: Arc::new(AuthRateLimiter::new(
                &config.jwt_secret,
                config.auth_code_requests_per_window,
                config.auth_code_global_requests_per_window,
                config.auth_code_window_seconds,
            )),
            mailer,
            push: push.map(Arc::new),
            config,
            metrics: Arc::new(Metrics::new()),
        }
    }
}
