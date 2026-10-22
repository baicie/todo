use std::{
    collections::HashSet,
    env,
    error::Error,
    fmt::{self, Display},
    str::FromStr,
    time::Duration,
};

use chrono::{DateTime, Utc};
use serde::Serialize;
use serde_json::{Value, json};
use sqlx::{PgPool, postgres::PgPoolOptions};
use uuid::Uuid;

use crate::{config::AppEnv, db};

const DEFAULT_BATCH_SIZE: i64 = 5_000;
const OPS_TOKEN_MIN_LEN: usize = 32;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Command {
    Serve,
    Help,
    Ops(OpsRun),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct OpsRun {
    pub action: OpsAction,
    pub dry_run: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OpsAction {
    Cleanup,
    PruneChangeLog,
    PurgeAccounts,
    All,
}

impl OpsAction {
    fn as_str(self) -> &'static str {
        match self {
            Self::Cleanup => "cleanup",
            Self::PruneChangeLog => "prune-change-log",
            Self::PurgeAccounts => "purge-accounts",
            Self::All => "all",
        }
    }
}

pub fn parse_command<I, S>(args: I) -> Result<Command, OpsError>
where
    I: IntoIterator<Item = S>,
    S: Into<String>,
{
    let mut args: Vec<String> = args.into_iter().map(Into::into).collect();
    if args.is_empty() {
        return Ok(Command::Serve);
    }
    if args.iter().any(|arg| arg == "--help" || arg == "-h") {
        return Ok(Command::Help);
    }

    match args.remove(0).as_str() {
        "serve" => {
            if !args.is_empty() {
                return Err(usage("serve does not accept additional arguments"));
            }
            Ok(Command::Serve)
        }
        "ops" => {
            if args.is_empty() {
                return Err(usage("ops requires an action"));
            }
            let action = match args.remove(0).as_str() {
                "cleanup" => OpsAction::Cleanup,
                "prune-change-log" => OpsAction::PruneChangeLog,
                "purge-accounts" => OpsAction::PurgeAccounts,
                "all" => OpsAction::All,
                other => return Err(usage(format!("unknown ops action {other:?}"))),
            };
            let dry_run = parse_mode(args)?;
            Ok(Command::Ops(OpsRun { action, dry_run }))
        }
        other => Err(usage(format!("unknown command {other:?}"))),
    }
}

fn parse_mode(args: Vec<String>) -> Result<bool, OpsError> {
    let mut dry_run = true;
    let mut mode_seen = false;
    for arg in args {
        match arg.as_str() {
            "--dry-run" if !mode_seen => {
                dry_run = true;
                mode_seen = true;
            }
            "--apply" if !mode_seen => {
                dry_run = false;
                mode_seen = true;
            }
            "--dry-run" | "--apply" => {
                return Err(usage("specify at most one of --dry-run or --apply"));
            }
            _ => return Err(usage(format!("unknown ops argument {arg:?}"))),
        }
    }
    Ok(dry_run)
}

pub fn print_help() {
    println!(
        "To Do API\n\n\
         Usage:\n  \
         todo-api serve\n  \
         todo-api ops <cleanup|prune-change-log|purge-accounts|all> [--dry-run|--apply]\n\n\
         Operations default to --dry-run. --apply requires OPS_ADMIN_TOKEN (>=32 chars)\n\
         and OPS_CONFIRM=APPLY in the environment. Tokens are never accepted as CLI\n\
         arguments."
    );
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct CleanupReport {
    pub dry_run: bool,
    pub auth_codes_deleted: u64,
    pub sessions_deleted: u64,
    pub refresh_tokens_deleted: u64,
    pub op_receipts_deleted: u64,
    pub rate_limit_windows_deleted: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PruneReport {
    pub dry_run: bool,
    pub change_log_rows_deleted: u64,
    pub accounts_min_cursor_updated: u64,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct PurgeReport {
    pub dry_run: bool,
    pub accounts_purged: u64,
    pub lists_deleted: u64,
    pub tasks_deleted: u64,
    pub steps_deleted: u64,
    pub day_plans_deleted: u64,
    pub account_sync_states_deleted: u64,
    pub op_receipts_deleted: u64,
    pub change_log_rows_deleted: u64,
    pub refresh_tokens_deleted: u64,
    pub sessions_deleted: u64,
    pub devices_deleted: u64,
    pub auth_codes_deleted: u64,
}

pub struct OpsConfig {
    pub database_url: String,
    pub batch_size: i64,
    pub auth_code_retention_days: i64,
    pub session_retention_days: i64,
    pub op_receipt_retention_days: i64,
    pub change_log_retention_days: i64,
    pub account_purge_grace_days: i64,
    pub rate_limit_retention_hours: i64,
}

impl OpsConfig {
    pub fn from_env() -> Result<Self, OpsError> {
        let _admin_token = env::var("OPS_ADMIN_TOKEN")
            .ok()
            .filter(|value| value.len() >= OPS_TOKEN_MIN_LEN)
            .ok_or_else(|| {
                usage(format!(
                    "OPS_ADMIN_TOKEN must be set to at least {OPS_TOKEN_MIN_LEN} characters"
                ))
            })?;
        let database_url = env::var("DATABASE_URL")
            .ok()
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| usage("DATABASE_URL is required"))?;
        let app_env = env::var("APP_ENV")
            .unwrap_or_else(|_| "production".to_owned())
            .parse::<AppEnv>()
            .map_err(|error| usage(error.to_string()))?;
        let change_log_retention_days = parse_env("CHANGE_LOG_RETENTION_DAYS", 90, 1..=3_650)?;
        if app_env == AppEnv::Production && change_log_retention_days < 90 {
            return Err(usage(
                "CHANGE_LOG_RETENTION_DAYS must be at least 90 in production",
            ));
        }

        Ok(Self {
            database_url,
            batch_size: parse_env("OPS_BATCH_SIZE", DEFAULT_BATCH_SIZE, 100..=100_000)?,
            auth_code_retention_days: parse_env("AUTH_CODE_RETENTION_DAYS", 1, 1..=30)?,
            session_retention_days: parse_env("SESSION_RETENTION_DAYS", 7, 1..=90)?,
            op_receipt_retention_days: parse_env("OP_RECEIPT_RETENTION_DAYS", 90, 1..=3_650)?,
            change_log_retention_days,
            account_purge_grace_days: parse_env("ACCOUNT_PURGE_GRACE_DAYS", 7, 1..=365)?,
            rate_limit_retention_hours: parse_env("RATE_LIMIT_RETENTION_HOURS", 24, 1..=720)?,
        })
    }

    #[doc(hidden)]
    pub fn for_test(database_url: String) -> Self {
        Self {
            database_url,
            batch_size: 100,
            auth_code_retention_days: 1,
            session_retention_days: 7,
            op_receipt_retention_days: 90,
            change_log_retention_days: 90,
            account_purge_grace_days: 7,
            rate_limit_retention_hours: 24,
        }
    }
}

pub async fn run(command: OpsRun) -> Result<Value, OpsError> {
    let config = OpsConfig::from_env()?;
    if !command.dry_run && env::var("OPS_CONFIRM").as_deref() != Ok("APPLY") {
        return Err(usage(
            "destructive operations require OPS_CONFIRM=APPLY in the environment",
        ));
    }
    let pool = PgPoolOptions::new()
        .max_connections(2)
        .acquire_timeout(Duration::from_secs(5))
        .connect(&config.database_url)
        .await?;
    if !db::schema_is_current(&pool).await? {
        return Err(usage(
            "database schema is not current; deploy/start the API to apply migrations first",
        ));
    }

    let report = match command.action {
        OpsAction::Cleanup => {
            let r = cleanup_expired(&pool, &config, command.dry_run).await?;
            serde_json::to_value(r).map_err(|error| OpsError::Internal(error.to_string()))?
        }
        OpsAction::PruneChangeLog => {
            let r = prune_change_log(&pool, &config, command.dry_run).await?;
            serde_json::to_value(r).map_err(|error| OpsError::Internal(error.to_string()))?
        }
        OpsAction::PurgeAccounts => {
            let r = purge_accounts(&pool, &config, command.dry_run).await?;
            serde_json::to_value(r).map_err(|error| OpsError::Internal(error.to_string()))?
        }
        OpsAction::All => {
            let cleanup = cleanup_expired(&pool, &config, command.dry_run).await?;
            let prune = prune_change_log(&pool, &config, command.dry_run).await?;
            let purge = purge_accounts(&pool, &config, command.dry_run).await?;
            json!({
                "action": command.action.as_str(),
                "dry_run": command.dry_run,
                "cleanup": cleanup,
                "prune_change_log": prune,
                "purge_accounts": purge
            })
        }
    };
    tracing::info!(
        action = command.action.as_str(),
        dry_run = command.dry_run,
        counts = %report,
        "operations task completed"
    );
    Ok(report)
}

pub async fn connect(database_url: &str) -> Result<PgPool, OpsError> {
    Ok(PgPoolOptions::new()
        .max_connections(3)
        .acquire_timeout(Duration::from_secs(5))
        .connect(database_url)
        .await?)
}

pub async fn cleanup_expired(
    pool: &PgPool,
    config: &OpsConfig,
    dry_run: bool,
) -> Result<CleanupReport, OpsError> {
    let now = Utc::now();
    let auth_cutoff = now - chrono::Duration::days(config.auth_code_retention_days);
    let session_cutoff = now - chrono::Duration::days(config.session_retention_days);
    let receipt_cutoff = now - chrono::Duration::days(config.op_receipt_retention_days);
    let rate_cutoff = now - chrono::Duration::hours(config.rate_limit_retention_hours);

    if dry_run {
        let auth_codes_deleted = count(
            pool,
            "SELECT COUNT(*) FROM auth_codes WHERE expires_at < $1",
            auth_cutoff,
        )
        .await?;
        let sessions_deleted = count(
            pool,
            "SELECT COUNT(*) FROM sessions \
             WHERE expires_at < $1 OR revoked_at < $1",
            session_cutoff,
        )
        .await?;
        let refresh_tokens_deleted = count(
            pool,
            "SELECT COUNT(*) FROM refresh_tokens \
             WHERE expires_at < $1 OR revoked_at < $1",
            session_cutoff,
        )
        .await?;
        let op_receipts_deleted = count(
            pool,
            "SELECT COUNT(*) FROM op_receipts WHERE created_at < $1",
            receipt_cutoff,
        )
        .await?;
        let rate_limit_windows_deleted = count(
            pool,
            "SELECT COUNT(*) FROM auth_rate_limit_windows WHERE window_start < $1",
            rate_cutoff,
        )
        .await?;
        return Ok(CleanupReport {
            dry_run: true,
            auth_codes_deleted,
            sessions_deleted,
            refresh_tokens_deleted,
            op_receipts_deleted,
            rate_limit_windows_deleted,
        });
    }

    let auth_codes_deleted = delete_batches(
        pool,
        "DELETE FROM auth_codes WHERE id IN \
         (SELECT id FROM auth_codes WHERE expires_at < $1 ORDER BY expires_at LIMIT $2)",
        auth_cutoff,
        config.batch_size,
    )
    .await?;
    let sessions_deleted = delete_batches(
        pool,
        "DELETE FROM sessions WHERE id IN \
         (SELECT id FROM sessions WHERE expires_at < $1 OR revoked_at < $1 \
          ORDER BY expires_at LIMIT $2)",
        session_cutoff,
        config.batch_size,
    )
    .await?;
    let refresh_tokens_deleted = delete_batches(
        pool,
        "DELETE FROM refresh_tokens WHERE id IN \
         (SELECT id FROM refresh_tokens WHERE expires_at < $1 OR revoked_at < $1 \
          ORDER BY expires_at LIMIT $2)",
        session_cutoff,
        config.batch_size,
    )
    .await?;
    let op_receipts_deleted = delete_batches(
        pool,
        "DELETE FROM op_receipts WHERE op_id IN \
         (SELECT op_id FROM op_receipts WHERE created_at < $1 \
          ORDER BY created_at LIMIT $2)",
        receipt_cutoff,
        config.batch_size,
    )
    .await?;
    let rate_limit_windows_deleted = delete_batches(
        pool,
        "DELETE FROM auth_rate_limit_windows WHERE ctid IN \
         (SELECT ctid FROM auth_rate_limit_windows WHERE window_start < $1 \
          ORDER BY window_start LIMIT $2)",
        rate_cutoff,
        config.batch_size,
    )
    .await?;

    Ok(CleanupReport {
        dry_run: false,
        auth_codes_deleted,
        sessions_deleted,
        refresh_tokens_deleted,
        op_receipts_deleted,
        rate_limit_windows_deleted,
    })
}

pub async fn prune_change_log(
    pool: &PgPool,
    config: &OpsConfig,
    dry_run: bool,
) -> Result<PruneReport, OpsError> {
    let cutoff = Utc::now() - chrono::Duration::days(config.change_log_retention_days);
    if dry_run {
        let (rows, accounts): (i64, i64) = sqlx::query_as(
            "SELECT COUNT(*), COUNT(DISTINCT user_id) FROM change_log WHERE created_at < $1",
        )
        .bind(cutoff)
        .fetch_one(pool)
        .await?;
        return Ok(PruneReport {
            dry_run: true,
            change_log_rows_deleted: rows as u64,
            accounts_min_cursor_updated: accounts as u64,
        });
    }

    let mut deleted_total = 0_u64;
    let mut accounts = HashSet::new();
    loop {
        let mut tx = pool.begin().await?;
        sqlx::query(
            "CREATE TEMP TABLE ops_prune_change_log_batch \
             (user_id UUID NOT NULL, server_seq BIGINT NOT NULL, PRIMARY KEY (user_id, server_seq)) \
             ON COMMIT DROP",
        )
        .execute(&mut *tx)
        .await?;
        let selected = sqlx::query(
            "INSERT INTO ops_prune_change_log_batch (user_id, server_seq) \
             SELECT user_id, server_seq FROM change_log \
             WHERE created_at < $1 \
             ORDER BY created_at, user_id, server_seq \
             LIMIT $2 FOR UPDATE SKIP LOCKED",
        )
        .bind(cutoff)
        .bind(config.batch_size)
        .execute(&mut *tx)
        .await?
        .rows_affected();
        if selected == 0 {
            tx.commit().await?;
            break;
        }

        let affected: Vec<(Uuid,)> =
            sqlx::query_as("SELECT DISTINCT user_id FROM ops_prune_change_log_batch")
                .fetch_all(&mut *tx)
                .await?;
        for (user_id,) in affected {
            accounts.insert(user_id);
        }
        let deleted = sqlx::query(
            "DELETE FROM change_log c USING ops_prune_change_log_batch b \
             WHERE c.user_id = b.user_id AND c.server_seq = b.server_seq",
        )
        .execute(&mut *tx)
        .await?
        .rows_affected();
        deleted_total += deleted;

        sqlx::query(
            "UPDATE account_sync_state AS s SET min_available_seq = GREATEST( \
                s.min_available_seq, \
                COALESCE( \
                    (SELECT MIN(c.server_seq) FROM change_log c WHERE c.user_id = s.user_id), \
                    s.next_server_seq \
                ) \
             ) \
             WHERE s.user_id IN (SELECT DISTINCT user_id FROM ops_prune_change_log_batch)",
        )
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;

        if selected < config.batch_size as u64 {
            break;
        }
    }
    tracing::info!(
        change_log_rows_deleted = deleted_total,
        accounts_updated = accounts.len(),
        "change log retention prune completed"
    );
    Ok(PruneReport {
        dry_run: false,
        change_log_rows_deleted: deleted_total,
        accounts_min_cursor_updated: accounts.len() as u64,
    })
}

pub async fn purge_accounts(
    pool: &PgPool,
    config: &OpsConfig,
    dry_run: bool,
) -> Result<PurgeReport, OpsError> {
    let cutoff = Utc::now() - chrono::Duration::days(config.account_purge_grace_days);
    if dry_run {
        let accounts: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM users WHERE deleted_at IS NOT NULL AND deleted_at < $1",
        )
        .bind(cutoff)
        .fetch_one(pool)
        .await?;
        return Ok(PurgeReport {
            dry_run: true,
            accounts_purged: accounts as u64,
            ..PurgeReport::default()
        });
    }

    let mut report = PurgeReport {
        dry_run: false,
        ..PurgeReport::default()
    };
    loop {
        let mut tx = pool.begin().await?;
        let candidates: Vec<(Uuid, String)> = sqlx::query_as(
            "SELECT id, email_normalized FROM users \
             WHERE deleted_at IS NOT NULL AND deleted_at < $1 \
             ORDER BY deleted_at, id LIMIT $2 FOR UPDATE SKIP LOCKED",
        )
        .bind(cutoff)
        .bind(config.batch_size)
        .fetch_all(&mut *tx)
        .await?;
        if candidates.is_empty() {
            tx.commit().await?;
            break;
        }
        let candidate_count = candidates.len();

        for (user_id, email) in candidates {
            report.accounts_purged += 1;
            report.day_plans_deleted +=
                delete_user_rows(&mut tx, "DELETE FROM day_plans WHERE user_id = $1", user_id)
                    .await?;
            report.steps_deleted +=
                delete_user_rows(&mut tx, "DELETE FROM steps WHERE user_id = $1", user_id).await?;
            report.tasks_deleted +=
                delete_user_rows(&mut tx, "DELETE FROM tasks WHERE user_id = $1", user_id).await?;
            report.lists_deleted +=
                delete_user_rows(&mut tx, "DELETE FROM lists WHERE user_id = $1", user_id).await?;
            report.op_receipts_deleted += delete_user_rows(
                &mut tx,
                "DELETE FROM op_receipts WHERE user_id = $1",
                user_id,
            )
            .await?;
            report.change_log_rows_deleted += delete_user_rows(
                &mut tx,
                "DELETE FROM change_log WHERE user_id = $1",
                user_id,
            )
            .await?;
            report.account_sync_states_deleted += delete_user_rows(
                &mut tx,
                "DELETE FROM account_sync_state WHERE user_id = $1",
                user_id,
            )
            .await?;
            report.refresh_tokens_deleted += delete_user_rows(
                &mut tx,
                "DELETE FROM refresh_tokens rt USING sessions s \
                 WHERE rt.session_id = s.id AND s.user_id = $1",
                user_id,
            )
            .await?;
            report.sessions_deleted +=
                delete_user_rows(&mut tx, "DELETE FROM sessions WHERE user_id = $1", user_id)
                    .await?;
            report.devices_deleted +=
                delete_user_rows(&mut tx, "DELETE FROM devices WHERE user_id = $1", user_id)
                    .await?;
            report.auth_codes_deleted +=
                sqlx::query("DELETE FROM auth_codes WHERE email_normalized = $1")
                    .bind(&email)
                    .execute(&mut *tx)
                    .await?
                    .rows_affected();
            delete_user_rows(&mut tx, "DELETE FROM users WHERE id = $1", user_id).await?;
        }
        tx.commit().await?;
        if candidate_count < config.batch_size as usize {
            break;
        }
    }
    tracing::info!(
        accounts_purged = report.accounts_purged,
        "deleted-account purge completed"
    );
    Ok(report)
}

async fn delete_user_rows(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    query: &'static str,
    user_id: Uuid,
) -> Result<u64, sqlx::Error> {
    Ok(sqlx::query(query)
        .bind(user_id)
        .execute(&mut **tx)
        .await?
        .rows_affected())
}

async fn count(
    pool: &PgPool,
    query: &'static str,
    cutoff: DateTime<Utc>,
) -> Result<u64, sqlx::Error> {
    let count: i64 = sqlx::query_scalar(query)
        .bind(cutoff)
        .fetch_one(pool)
        .await?;
    Ok(count as u64)
}

async fn delete_batches(
    pool: &PgPool,
    query: &'static str,
    cutoff: DateTime<Utc>,
    batch_size: i64,
) -> Result<u64, sqlx::Error> {
    let mut total = 0_u64;
    loop {
        let deleted = sqlx::query(query)
            .bind(cutoff)
            .bind(batch_size)
            .execute(pool)
            .await?
            .rows_affected();
        total += deleted;
        if deleted < batch_size as u64 {
            break;
        }
    }
    Ok(total)
}

fn parse_env<T>(name: &str, default: T, range: std::ops::RangeInclusive<T>) -> Result<T, OpsError>
where
    T: FromStr + PartialOrd + Display + Copy,
    T::Err: Display,
{
    let value = match env::var(name) {
        Ok(raw) if !raw.trim().is_empty() => raw
            .trim()
            .parse::<T>()
            .map_err(|error| usage(format!("{name} is invalid: {error}")))?,
        _ => default,
    };
    if !range.contains(&value) {
        return Err(usage(format!(
            "{name} must be between {} and {}",
            range.start(),
            range.end()
        )));
    }
    Ok(value)
}

#[derive(Debug)]
pub enum OpsError {
    Usage(String),
    Database(sqlx::Error),
    Internal(String),
}

impl Display for OpsError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Usage(message) | Self::Internal(message) => formatter.write_str(message),
            Self::Database(error) => write!(formatter, "database operation failed: {error}"),
        }
    }
}

impl Error for OpsError {}

impl From<sqlx::Error> for OpsError {
    fn from(error: sqlx::Error) -> Self {
        Self::Database(error)
    }
}

fn usage(message: impl Into<String>) -> OpsError {
    OpsError::Usage(message.into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_serve_and_help() {
        assert_eq!(parse_command(Vec::<String>::new()).unwrap(), Command::Serve);
        assert_eq!(parse_command(["serve"]).unwrap(), Command::Serve);
        assert_eq!(parse_command(["--help"]).unwrap(), Command::Help);
    }

    #[test]
    fn operations_default_to_dry_run() {
        assert_eq!(
            parse_command(["ops", "cleanup"]).unwrap(),
            Command::Ops(OpsRun {
                action: OpsAction::Cleanup,
                dry_run: true
            })
        );
        assert_eq!(
            parse_command(["ops", "all", "--apply"]).unwrap(),
            Command::Ops(OpsRun {
                action: OpsAction::All,
                dry_run: false
            })
        );
    }

    #[test]
    fn invalid_or_conflicting_flags_are_rejected() {
        assert!(parse_command(["ops"]).is_err());
        assert!(parse_command(["ops", "nope"]).is_err());
        assert!(parse_command(["ops", "cleanup", "--apply", "--dry-run"]).is_err());
        assert!(parse_command(["serve", "extra"]).is_err());
    }
}
