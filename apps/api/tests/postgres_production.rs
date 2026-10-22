//! PostgreSQL integration coverage for shared rate limiting and operations.
//!
//! Run with:
//!   DATABASE_URL=postgres://todo:todo@127.0.0.1:55432/todo_test \
//!     cargo test -p todo-api --test postgres_production -- --ignored --test-threads=1
//!
//! These tests use unique UUIDs and clean up their own rows.

use std::{sync::Arc, time::Duration as StdDuration};

use chrono::{DateTime, Duration, Utc};
use sqlx::{PgPool, postgres::PgPoolOptions};
use todo_api::{
    auth::rate_limit::{AuthRateLimiter, AuthRequestLimit},
    db::MIGRATOR,
    ops::{OpsConfig, cleanup_expired, prune_change_log, purge_accounts},
};
use uuid::Uuid;

async fn test_pool() -> PgPool {
    dotenvy::dotenv().ok();
    let database_url = std::env::var("DATABASE_URL")
        .expect("DATABASE_URL must point at a disposable PostgreSQL test database");
    let pool = PgPoolOptions::new()
        .max_connections(8)
        .acquire_timeout(StdDuration::from_secs(5))
        .connect(&database_url)
        .await
        .expect("connect to PostgreSQL");
    MIGRATOR.run(&pool).await.expect("apply migrations");
    pool
}

fn random_hash() -> Vec<u8> {
    let mut bytes = Uuid::new_v4().as_bytes().to_vec();
    bytes.extend_from_slice(Uuid::new_v4().as_bytes());
    bytes
}

async fn insert_user(pool: &PgPool, email: &str, deleted_at: Option<DateTime<Utc>>) -> Uuid {
    let user_id = Uuid::new_v4();
    sqlx::query("INSERT INTO users (id, email_normalized, deleted_at) VALUES ($1, $2, $3)")
        .bind(user_id)
        .bind(email)
        .bind(deleted_at)
        .execute(pool)
        .await
        .unwrap();
    user_id
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires PostgreSQL; set DATABASE_URL and pass --ignored"]
async fn shared_rate_limiter_is_atomic_across_connections() {
    let pool = test_pool().await;
    let limiter = Arc::new(AuthRateLimiter::new(
        "integration-test-rate-limit-secret-32-bytes",
        5,
        100_000,
        900,
    ));
    let email = format!("rate-{}@example.com", Uuid::new_v4());

    let mut tasks = tokio::task::JoinSet::new();
    for _ in 0..12 {
        let pool = pool.clone();
        let limiter = limiter.clone();
        let email = email.clone();
        tasks.spawn(async move {
            let mut tx = pool.begin().await.unwrap();
            let decision = limiter.check(&mut tx, &email).await.unwrap();
            tx.commit().await.unwrap();
            decision
        });
    }

    let mut allowed = 0;
    let mut suppressed = 0;
    while let Some(result) = tasks.join_next().await {
        match result.unwrap() {
            AuthRequestLimit::Allowed => allowed += 1,
            AuthRequestLimit::Suppressed => suppressed += 1,
            AuthRequestLimit::GlobalExceeded => panic!("global limit should be high"),
        }
    }
    assert_eq!(allowed, 5);
    assert_eq!(suppressed, 7);
}

#[tokio::test]
#[ignore = "requires PostgreSQL; set DATABASE_URL and pass --ignored"]
async fn cleanup_removes_expired_rows() {
    let pool = test_pool().await;
    let email = format!("cleanup-{}@example.com", Uuid::new_v4());
    let user_id = insert_user(&pool, &email, None).await;
    let device_id = Uuid::new_v4();
    let session_id = Uuid::new_v4();
    let old = Utc::now() - Duration::days(100);

    sqlx::query(
        "INSERT INTO devices (id, user_id, name, platform, revoked_at) \
         VALUES ($1, $2, 'old device', 'linux', $3)",
    )
    .bind(device_id)
    .bind(user_id)
    .bind(old)
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO sessions (id, user_id, device_id, refresh_token_hash, expires_at) \
         VALUES ($1, $2, $3, $4, $5)",
    )
    .bind(session_id)
    .bind(user_id)
    .bind(device_id)
    .bind(random_hash())
    .bind(old)
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO refresh_tokens (id, session_id, token_hash, expires_at) \
         VALUES ($1, $2, $3, $4)",
    )
    .bind(Uuid::new_v4())
    .bind(session_id)
    .bind(random_hash())
    .bind(old)
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO auth_codes (id, email_normalized, code_hash, expires_at) \
         VALUES ($1, $2, $3, $4)",
    )
    .bind(Uuid::new_v4())
    .bind(&email)
    .bind(random_hash())
    .bind(old)
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO op_receipts \
         (op_id, user_id, device_id, client_seq, server_seq, status, created_at) \
         VALUES ($1, $2, $3, 1, 1, 'applied', $4)",
    )
    .bind(Uuid::new_v4())
    .bind(user_id)
    .bind(device_id)
    .bind(old)
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO auth_rate_limit_windows \
         (bucket, subject_hash, window_start, request_count) \
         VALUES ('test-cleanup', $1, $2, 1)",
    )
    .bind(vec![4_u8; 32])
    .bind(old)
    .execute(&pool)
    .await
    .unwrap();

    let config = OpsConfig::for_test(String::new());
    let report = cleanup_expired(&pool, &config, true).await.unwrap();
    assert!(report.dry_run);
    assert!(report.auth_codes_deleted >= 1);
    assert!(report.sessions_deleted >= 1);
    assert!(report.refresh_tokens_deleted >= 1);
    assert!(report.op_receipts_deleted >= 1);
    assert!(report.rate_limit_windows_deleted >= 1);
    let still_there: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM auth_codes WHERE email_normalized = $1")
            .bind(&email)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(still_there, 1, "dry-run must not delete auth codes");

    let report = cleanup_expired(&pool, &config, false).await.unwrap();
    assert!(!report.dry_run);
    assert!(report.auth_codes_deleted >= 1);
    assert!(report.sessions_deleted >= 1);

    let auth_codes: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM auth_codes WHERE email_normalized = $1")
            .bind(&email)
            .fetch_one(&pool)
            .await
            .unwrap();
    let sessions: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sessions WHERE user_id = $1")
        .bind(user_id)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(auth_codes, 0);
    assert_eq!(sessions, 0);

    sqlx::query("DELETE FROM users WHERE id = $1")
        .bind(user_id)
        .execute(&pool)
        .await
        .unwrap();
}

#[tokio::test]
#[ignore = "requires PostgreSQL; set DATABASE_URL and pass --ignored"]
async fn change_log_prune_advances_min_cursor() {
    let pool = test_pool().await;
    let email = format!("prune-{}@example.com", Uuid::new_v4());
    let user_id = insert_user(&pool, &email, None).await;
    let entity_id = Uuid::new_v4();
    let old = Utc::now() - Duration::days(100);
    sqlx::query("INSERT INTO account_sync_state (user_id, next_server_seq) VALUES ($1, 3)")
        .bind(user_id)
        .execute(&pool)
        .await
        .unwrap();
    for (seq, created_at) in [(1_i64, old), (2_i64, Utc::now())] {
        sqlx::query(
            "INSERT INTO change_log \
             (user_id, server_seq, op_id, entity_type, entity_id, kind, patch, created_at) \
             VALUES ($1, $2, $3, 'list', $4, 'create', '{}'::jsonb, $5)",
        )
        .bind(user_id)
        .bind(seq)
        .bind(Uuid::new_v4())
        .bind(entity_id)
        .bind(created_at)
        .execute(&pool)
        .await
        .unwrap();
    }

    let config = OpsConfig::for_test(String::new());
    let dry = prune_change_log(&pool, &config, true).await.unwrap();
    assert!(dry.dry_run);
    assert!(dry.change_log_rows_deleted >= 1);
    let still_present: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM change_log WHERE user_id = $1")
            .bind(user_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(still_present, 2, "dry-run must not delete change log rows");
    let report = prune_change_log(&pool, &config, false).await.unwrap();
    assert!(!report.dry_run);
    assert!(report.change_log_rows_deleted >= 1);

    let retained: Vec<i64> = sqlx::query_scalar(
        "SELECT server_seq FROM change_log WHERE user_id = $1 ORDER BY server_seq",
    )
    .bind(user_id)
    .fetch_all(&pool)
    .await
    .unwrap();
    let min_cursor: i64 =
        sqlx::query_scalar("SELECT min_available_seq FROM account_sync_state WHERE user_id = $1")
            .bind(user_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(retained, vec![2]);
    assert_eq!(min_cursor, 2);

    sqlx::query("DELETE FROM users WHERE id = $1")
        .bind(user_id)
        .execute(&pool)
        .await
        .unwrap();
}

#[tokio::test]
#[ignore = "requires PostgreSQL; set DATABASE_URL and pass --ignored"]
async fn purge_account_physically_removes_all_data() {
    let pool = test_pool().await;
    let email = format!("purge-{}@example.com", Uuid::new_v4());
    let user_id = insert_user(&pool, &email, Some(Utc::now() - Duration::days(30))).await;
    let device_id = Uuid::new_v4();
    let session_id = Uuid::new_v4();
    let list_id = Uuid::new_v4();
    let task_id = Uuid::new_v4();

    sqlx::query("INSERT INTO account_sync_state (user_id) VALUES ($1)")
        .bind(user_id)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO devices (id, user_id, name, platform) VALUES ($1, $2, 'purge', 'linux')",
    )
    .bind(device_id)
    .bind(user_id)
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO sessions (id, user_id, device_id, refresh_token_hash, expires_at) \
         VALUES ($1, $2, $3, $4, now() + interval '1 day')",
    )
    .bind(session_id)
    .bind(user_id)
    .bind(device_id)
    .bind(random_hash())
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO refresh_tokens (id, session_id, token_hash, expires_at) \
         VALUES ($1, $2, $3, now() + interval '1 day')",
    )
    .bind(Uuid::new_v4())
    .bind(session_id)
    .bind(random_hash())
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query("INSERT INTO lists (id, user_id, name) VALUES ($1, $2, 'Purge list')")
        .bind(list_id)
        .bind(user_id)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO tasks (id, user_id, list_id, title) VALUES ($1, $2, $3, 'Purge task')",
    )
    .bind(task_id)
    .bind(user_id)
    .bind(list_id)
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO steps (id, user_id, task_id, title) VALUES ($1, $2, $3, 'Purge step')",
    )
    .bind(Uuid::new_v4())
    .bind(user_id)
    .bind(task_id)
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO day_plans (id, user_id, task_id, local_date) \
         VALUES ($1, $2, $3, current_date)",
    )
    .bind(Uuid::new_v4())
    .bind(user_id)
    .bind(task_id)
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO change_log \
         (user_id, server_seq, op_id, entity_type, entity_id, kind, patch) \
         VALUES ($1, 1, $2, 'list', $3, 'create', '{}'::jsonb)",
    )
    .bind(user_id)
    .bind(Uuid::new_v4())
    .bind(list_id)
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO op_receipts \
         (op_id, user_id, device_id, client_seq, server_seq, status) \
         VALUES ($1, $2, $3, 1, 1, 'applied')",
    )
    .bind(Uuid::new_v4())
    .bind(user_id)
    .bind(device_id)
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO auth_codes (id, email_normalized, code_hash, expires_at) \
         VALUES ($1, $2, $3, now() + interval '10 minutes')",
    )
    .bind(Uuid::new_v4())
    .bind(&email)
    .bind(random_hash())
    .execute(&pool)
    .await
    .unwrap();

    let config = OpsConfig::for_test(String::new());
    let report = purge_accounts(&pool, &config, true).await.unwrap();
    assert!(report.dry_run);
    assert!(report.accounts_purged >= 1);
    let still_present: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM users WHERE id = $1")
        .bind(user_id)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(still_present, 1, "dry-run must not purge users");
    let report = purge_accounts(&pool, &config, false).await.unwrap();
    assert!(!report.dry_run);
    assert!(report.accounts_purged >= 1);
    let second_run = purge_accounts(&pool, &config, false).await.unwrap();
    assert_eq!(second_run.accounts_purged, 0);

    let users: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM users WHERE id = $1")
        .bind(user_id)
        .fetch_one(&pool)
        .await
        .unwrap();
    let lists: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM lists WHERE user_id = $1")
        .bind(user_id)
        .fetch_one(&pool)
        .await
        .unwrap();
    let auth_codes: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM auth_codes WHERE email_normalized = $1")
            .bind(&email)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(users, 0);
    assert_eq!(lists, 0);
    assert_eq!(auth_codes, 0);
}
