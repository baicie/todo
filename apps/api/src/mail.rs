use std::{
    fmt::{self, Display},
    str::FromStr,
    sync::Arc,
    time::Duration,
};

use async_trait::async_trait;
use lettre::{
    AsyncSmtpTransport, AsyncTransport, Tokio1Executor,
    message::{Mailbox, Message, header::ContentType},
    transport::smtp::authentication::Credentials,
};

use crate::config::{Config, ConfigError, MailConfig, SmtpTlsMode};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MailError {
    kind: &'static str,
}

impl MailError {
    pub fn kind(self) -> &'static str {
        self.kind
    }
}

impl Display for MailError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.kind)
    }
}

impl std::error::Error for MailError {}

#[async_trait]
pub trait MailProvider: Send + Sync {
    async fn send_auth_code(
        &self,
        recipient: &str,
        code: &str,
        ttl_seconds: i64,
    ) -> Result<(), MailError>;

    /// Readiness means the provider has valid, complete configuration. It is
    /// intentionally not a live SMTP network probe.
    fn is_ready(&self) -> bool;

    fn kind(&self) -> &'static str;
}

/// Used only in development/test where the deterministic dev code is used and
/// no email is sent.
pub struct DevelopmentMailer;

#[async_trait]
impl MailProvider for DevelopmentMailer {
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
        "development"
    }
}

pub struct SmtpMailer {
    transport: AsyncSmtpTransport<Tokio1Executor>,
    from: Mailbox,
}

impl SmtpMailer {
    pub fn new(config: &MailConfig) -> Result<Self, ConfigError> {
        let from = config
            .mail_from
            .parse::<Mailbox>()
            .map_err(|_| ConfigError("MAIL_FROM must be a valid mailbox".to_owned()))?;

        let builder = match config.smtp_tls {
            SmtpTlsMode::Starttls => AsyncSmtpTransport::<Tokio1Executor>::starttls_relay(
                &config.smtp_host,
            )
            .map_err(|_| ConfigError("could not configure SMTP STARTTLS transport".to_owned()))?,
            SmtpTlsMode::Implicit => AsyncSmtpTransport::<Tokio1Executor>::relay(&config.smtp_host)
                .map_err(|_| {
                    ConfigError("could not configure implicit SMTP TLS transport".to_owned())
                })?,
        };

        let transport = builder
            .port(config.smtp_port)
            .credentials(Credentials::new(
                config.auth_username.clone(),
                config.auth_password.clone(),
            ))
            .timeout(Some(Duration::from_secs(15)))
            .build();

        Ok(Self { transport, from })
    }
}

#[async_trait]
impl MailProvider for SmtpMailer {
    async fn send_auth_code(
        &self,
        recipient: &str,
        code: &str,
        ttl_seconds: i64,
    ) -> Result<(), MailError> {
        let recipient = Mailbox::from_str(recipient).map_err(|_| MailError { kind: "address" })?;
        let message = Message::builder()
            .from(self.from.clone())
            .to(recipient)
            .subject("Your Shishi sign-in code")
            .header(ContentType::TEXT_PLAIN)
            .body(format!(
                "Your one-time sign-in code is {code}. It expires in {} minutes.",
                (ttl_seconds.max(60) / 60).max(1)
            ))
            .map_err(|_| MailError {
                kind: "message_build",
            })?;

        // Do not retain the transport error text: some SMTP servers echo
        // message or recipient data in replies.
        self.transport
            .send(message)
            .await
            .map_err(|_| MailError { kind: "transport" })?;
        Ok(())
    }

    fn is_ready(&self) -> bool {
        true
    }

    fn kind(&self) -> &'static str {
        "smtp"
    }
}

pub fn build_mailer(config: &Config) -> Result<Arc<dyn MailProvider>, ConfigError> {
    match &config.mail {
        Some(mail_config) => Ok(Arc::new(SmtpMailer::new(mail_config)?)),
        None if config.app_env == crate::config::AppEnv::Production => Err(ConfigError(
            "production requires SMTP_HOST, MAIL_FROM, AUTH_USERNAME, and AUTH_PASSWORD".to_owned(),
        )),
        None => Ok(Arc::new(DevelopmentMailer)),
    }
}

/// Sends the code through the configured provider and emits only a fixed,
/// redacted failure event. The code, recipient, and SMTP error are never logged
/// or returned to the caller.
pub async fn deliver_auth_code(
    mailer: &dyn MailProvider,
    recipient: &str,
    code: &str,
    ttl_seconds: i64,
) -> bool {
    match mailer.send_auth_code(recipient, code, ttl_seconds).await {
        Ok(()) => true,
        Err(error) => {
            tracing::error!(
                provider = mailer.kind(),
                error_kind = error.kind(),
                "sign-in code delivery failed"
            );
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use std::{
        io::{self, Write},
        sync::Mutex,
    };

    use tracing::subscriber::with_default;
    use tracing_subscriber::fmt::MakeWriter;

    use super::*;

    struct RecordingMailer {
        fail: bool,
        sent: Mutex<Vec<(String, String, i64)>>,
    }

    impl RecordingMailer {
        fn new(fail: bool) -> Self {
            Self {
                fail,
                sent: Mutex::new(Vec::new()),
            }
        }
    }

    #[async_trait]
    impl MailProvider for RecordingMailer {
        async fn send_auth_code(
            &self,
            recipient: &str,
            code: &str,
            ttl_seconds: i64,
        ) -> Result<(), MailError> {
            self.sent
                .lock()
                .unwrap()
                .push((recipient.to_owned(), code.to_owned(), ttl_seconds));
            if self.fail {
                Err(MailError { kind: "test" })
            } else {
                Ok(())
            }
        }

        fn is_ready(&self) -> bool {
            true
        }

        fn kind(&self) -> &'static str {
            "recording"
        }
    }

    #[derive(Clone)]
    struct BufferWriter(Arc<Mutex<Vec<u8>>>);

    impl Write for BufferWriter {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(bytes);
            Ok(bytes.len())
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    struct BufferMakeWriter(Arc<Mutex<Vec<u8>>>);

    impl<'a> MakeWriter<'a> for BufferMakeWriter {
        type Writer = BufferWriter;

        fn make_writer(&'a self) -> Self::Writer {
            BufferWriter(self.0.clone())
        }
    }

    fn run_with_log_capture<F>(future: F) -> (bool, String)
    where
        F: std::future::Future<Output = bool>,
    {
        let logs = Arc::new(Mutex::new(Vec::new()));
        let subscriber = tracing_subscriber::fmt()
            .with_ansi(false)
            .with_max_level(tracing::Level::TRACE)
            .with_writer(BufferMakeWriter(logs.clone()))
            .finish();
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let delivered = with_default(subscriber, || runtime.block_on(future));
        let text = String::from_utf8(logs.lock().unwrap().clone()).unwrap();
        (delivered, text)
    }

    #[test]
    fn fake_mailer_receives_code_and_logs_do_not_leak_it() {
        let mailer = RecordingMailer::new(false);
        let (delivered, logs) = run_with_log_capture(deliver_auth_code(
            &mailer,
            "person@example.com",
            "654321",
            600,
        ));
        assert!(delivered);
        let sent = mailer.sent.lock().unwrap();
        assert_eq!(sent.len(), 1);
        assert_eq!(sent[0].0, "person@example.com");
        assert_eq!(sent[0].1, "654321");
        assert_eq!(sent[0].2, 600);
        assert!(!logs.contains("654321"));
        assert!(!logs.contains("person@example.com"));
    }

    #[test]
    fn delivery_failure_is_redacted() {
        let mailer = RecordingMailer::new(true);
        let (delivered, logs) = run_with_log_capture(deliver_auth_code(
            &mailer,
            "person@example.com",
            "654321",
            600,
        ));
        assert!(!delivered);
        assert!(logs.contains("sign-in code delivery failed"));
        assert!(!logs.contains("654321"));
        assert!(!logs.contains("person@example.com"));
    }

    #[test]
    fn default_mailer_is_development_without_smtp_config() {
        let config = crate::config::Config::for_test();
        let mailer = build_mailer(&config).unwrap();
        assert!(mailer.is_ready());
        assert_eq!(mailer.kind(), "development");
    }

    #[test]
    fn smtp_mailer_builds_from_complete_config_without_connecting() {
        let mut config = crate::config::Config::for_test();
        config.app_env = crate::config::AppEnv::Production;
        config.mail = Some(MailConfig {
            smtp_host: "smtp.example.com".to_owned(),
            smtp_port: 587,
            smtp_tls: SmtpTlsMode::Starttls,
            auth_username: "user".to_owned(),
            auth_password: "secret".to_owned(),
            mail_from: "Shishi <no-reply@example.com>".to_owned(),
        });
        let mailer = build_mailer(&config).unwrap();
        assert!(mailer.is_ready());
        assert_eq!(mailer.kind(), "smtp");
    }
}
