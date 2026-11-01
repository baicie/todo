//! PostgreSQL migration upgrade coverage (docs/roadmap-v2/05-quality.md §3).
//!
//! For every historical migration version this test creates a temporary
//! database (random name, dropped at the end even when an assertion fails),
//! applies migrations only up to that version, writes representative rows that
//! are valid for that schema, and then runs the API's real migrator to upgrade
//! to the latest version. It asserts that:
//!
//! - every row written before the upgrade survives with the same values;
//! - the upgraded schema is identical to a fresh install (columns, constraints,
//!   indexes) and has no unvalidated constraints;
//! - constraints added later apply to rows written before them;
//! - the current API can read the upgraded data (readiness, export, sync pull,
//!   shared lists).
//!
//! Requires a PostgreSQL role that may create databases:
//!
//!   DATABASE_URL=postgres://todo:todo@127.0.0.1:5432/todo \
//!     cargo test -p todo-api --test postgres_migrations -- --ignored --test-threads=1
//!
//! New migrations are upgraded through automatically. When a migration creates
//! tables, add rows for them in `seed_for` so their data is covered as well.

use std::{
    collections::BTreeMap,
    str::FromStr,
    sync::{Arc, Mutex},
};

use async_trait::async_trait;
use axum::{
    Router,
    body::Body,
    http::{
        Method, Request, StatusCode,
        header::{AUTHORIZATION, CONTENT_TYPE},
    },
};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use sqlx::{
    PgPool,
    migrate::Migrate,
    postgres::{PgConnectOptions, PgPoolOptions},
};
use todo_api::{
    AppState, build_router,
    config::Config,
    db::{self, MIGRATOR},
    mail::{MailError, MailProvider},
};
use tower::ServiceExt;
use uuid::Uuid;

const CORE: i64 = 20261021000100;
const SYNC_AND_REFRESH: i64 = 20261021000200;
const PRODUCTION_OPS: i64 = 20261021000300;
const TASK_TAGS: i64 = 20261022000100;
const PUSH: i64 = 20261022000200;
const SHARED_LISTS: i64 = 20261022000300;
const SEEDED_VERSIONS: [i64; 6] = [
    CORE,
    SYNC_AND_REFRESH,
    PRODUCTION_OPS,
    TASK_TAGS,
    PUSH,
    SHARED_LISTS,
];

struct NoopMailer;

#[async_trait]
impl MailProvider for NoopMailer {
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
        "noop"
    }
}

/// Temporary databases on the server named by `DATABASE_URL`.
#[derive(Clone)]
struct TempDatabases {
    admin: PgPool,
    base: PgConnectOptions,
    created: Arc<Mutex<Vec<String>>>,
}

impl TempDatabases {
    async fn connect() -> Self {
        dotenvy::dotenv().ok();
        let url = std::env::var("DATABASE_URL")
            .expect("DATABASE_URL must point at a disposable PostgreSQL test server");
        let base = PgConnectOptions::from_str(&url).expect("DATABASE_URL is a valid URL");
        let admin = PgPoolOptions::new()
            .max_connections(1)
            .connect_with(base.clone())
            .await
            .expect("connect to test PostgreSQL");
        Self {
            admin,
            base,
            created: Arc::default(),
        }
    }

    async fn create(&self) -> PgPool {
        let name = format!("todo_migtest_{}", Uuid::new_v4().simple());
        sqlx::raw_sql(&format!("CREATE DATABASE \"{name}\""))
            .execute(&self.admin)
            .await
            .expect("create a temporary database (the role needs CREATEDB)");
        self.created.lock().unwrap().push(name.clone());
        PgPoolOptions::new()
            .max_connections(2)
            .connect_with(self.base.clone().database(&name))
            .await
            .expect("connect to the temporary database")
    }

    async fn drop_all(&self) {
        let names = std::mem::take(&mut *self.created.lock().unwrap());
        for name in names {
            let sql = format!("DROP DATABASE IF EXISTS \"{name}\" WITH (FORCE)");
            if let Err(error) = sqlx::raw_sql(&sql).execute(&self.admin).await {
                eprintln!("could not drop temporary database {name}: {error}");
            }
        }
    }
}

#[tokio::test]
#[ignore = "requires PostgreSQL with CREATEDB; set DATABASE_URL and pass --ignored"]
async fn every_historical_schema_upgrades_to_latest_without_data_loss() {
    let databases = TempDatabases::connect().await;
    // Run the body in its own task so the temporary databases are dropped even
    // when an assertion panics, then report the panic.
    let result = tokio::spawn(run_upgrades(databases.clone())).await;
    databases.drop_all().await;
    if let Err(error) = result {
        std::panic::resume_unwind(error.into_panic());
    }
}

async fn run_upgrades(databases: TempDatabases) {
    let migrations: Vec<_> = MIGRATOR.iter().collect();
    assert!(
        migrations.len() >= 2,
        "an upgrade test needs at least two migrations"
    );
    for version in SEEDED_VERSIONS {
        assert!(
            MIGRATOR.version_exists(version),
            "seed data refers to unknown migration {version}"
        );
    }

    let fresh = databases.create().await;
    MIGRATOR
        .run(&fresh)
        .await
        .expect("migrate a fresh database");
    let fresh_schema = schema_fingerprint(&fresh).await;
    fresh.close().await;

    // The latest version is included as a base too: its upgrade is a no-op,
    // but it still checks that the newest tables' seed rows are readable.
    for (index, base) in migrations.iter().enumerate() {
        let context = format!("upgrade from {} ({})", base.version, base.description);
        let pool = databases.create().await;
        let ids = Ids::new();

        apply_through(&pool, index).await;
        let seeded = seed(&pool, base.version, &ids).await;
        let before = snapshot(&pool).await;
        for table in &seeded {
            assert!(
                before.get(*table).is_some_and(|rows| !rows.is_empty()),
                "{context}: the seed left {table} empty"
            );
        }

        // The same call the API makes at startup.
        MIGRATOR
            .run(&pool)
            .await
            .unwrap_or_else(|error| panic!("{context}: {error}"));
        assert!(
            db::schema_is_current(&pool).await.unwrap(),
            "{context}: schema is not current after the upgrade"
        );

        assert_rows_preserved(&context, &before, &snapshot(&pool).await);
        assert_same_schema(&context, &fresh_schema, &schema_fingerprint(&pool).await);
        assert_constraints_hold(&context, &pool, &ids).await;
        assert_api_reads_upgraded_data(&context, &pool, &ids, base.version).await;

        MIGRATOR
            .run(&pool)
            .await
            .unwrap_or_else(|error| panic!("{context}: re-running migrations: {error}"));
        pool.close().await;
    }
}

async fn apply_through(pool: &PgPool, index: usize) {
    let mut conn = pool.acquire().await.unwrap();
    conn.ensure_migrations_table().await.unwrap();
    for migration in MIGRATOR.iter().take(index + 1) {
        conn.apply(migration)
            .await
            .unwrap_or_else(|error| panic!("apply {}: {error}", migration.version));
    }
}

// ---------------------------------------------------------------------------
// Representative data per schema version
// ---------------------------------------------------------------------------

/// Identifiers of seeded rows that later seeds and assertions refer to.
struct Ids {
    user: Uuid,
    member: Uuid,
    device: Uuid,
    session: Uuid,
    list: Uuid,
    task: Uuid,
    tagged_task: Uuid,
    step: Uuid,
    day_plan: Uuid,
    applied_op: Uuid,
    subscription: Uuid,
    shared_list: Uuid,
    shared_task: Uuid,
}

impl Ids {
    fn new() -> Self {
        Self {
            user: Uuid::new_v4(),
            member: Uuid::new_v4(),
            device: Uuid::new_v4(),
            session: Uuid::new_v4(),
            list: Uuid::new_v4(),
            task: Uuid::new_v4(),
            tagged_task: Uuid::new_v4(),
            step: Uuid::new_v4(),
            day_plan: Uuid::new_v4(),
            applied_op: Uuid::new_v4(),
            subscription: Uuid::new_v4(),
            shared_list: Uuid::new_v4(),
            shared_task: Uuid::new_v4(),
        }
    }
}

/// Rows that are valid once `version` is applied, and the tables they fill.
/// Every value is a generated UUID or a literal, so formatting them into SQL
/// is safe.
fn seed_for(version: i64, ids: &Ids) -> Option<(&'static [&'static str], String)> {
    let Ids {
        user,
        member,
        device,
        session,
        list,
        task,
        tagged_task,
        step,
        day_plan,
        applied_op,
        subscription,
        shared_list,
        shared_task,
    } = ids;
    let seed: (&'static [&'static str], String) = match version {
        CORE => (
            &[
                "users",
                "auth_codes",
                "devices",
                "sessions",
                "lists",
                "tasks",
                "steps",
                "day_plans",
                "account_sync_state",
            ],
            format!(
                r#"
                INSERT INTO users (id, email_normalized, preferred_timezone)
                    VALUES ('{user}', 'legacy-{user}@example.com', 'Europe/Berlin');
                INSERT INTO auth_codes (id, email_normalized, code_hash, expires_at, attempts)
                    VALUES (gen_random_uuid(), 'legacy-{user}@example.com', '\x0102'::bytea,
                            now() + interval '10 minutes', 1);
                INSERT INTO devices (id, user_id, name, platform, last_client_seq, last_seen_at)
                    VALUES ('{device}', '{user}', 'Legacy laptop', 'linux', 2, now());
                INSERT INTO sessions (id, user_id, device_id, refresh_token_hash, expires_at)
                    VALUES ('{session}', '{user}', '{device}', '\x0a0b'::bytea,
                            now() + interval '30 days');
                INSERT INTO lists (id, user_id, name, color, icon, rank, server_rev)
                    VALUES ('{list}', '{user}', 'Legacy list', '#3d66d9', 'inbox', 'a1', 1);
                INSERT INTO tasks (id, user_id, list_id, title, note, status, important, due_on,
                                   remind_at, remind_timezone, rank, series_id, occurrence_key,
                                   recurrence, completed_at, server_rev)
                    VALUES ('{task}', '{user}', '{list}', 'Legacy task', 'note ✓ 中文',
                            'completed', true, '2026-10-21', '2026-10-21T01:00:00Z',
                            'Asia/Shanghai', 'a1', gen_random_uuid(), '2026-10-21',
                            '{{"freq": "daily", "interval": 1}}', '2026-10-21T02:00:00Z', 2);
                INSERT INTO tasks (id, user_id, title, deleted_at)
                    VALUES (gen_random_uuid(), '{user}', 'Deleted task', now());
                INSERT INTO steps (id, user_id, task_id, title, is_completed, rank, server_rev)
                    VALUES ('{step}', '{user}', '{task}', 'Legacy step', true, 'a1', 2);
                INSERT INTO day_plans (id, user_id, task_id, local_date, rank, server_rev)
                    VALUES ('{day_plan}', '{user}', '{task}', '2026-10-21', 'a1', 2);
                INSERT INTO account_sync_state (user_id, next_server_seq, min_available_seq)
                    VALUES ('{user}', 2, 0);
                "#
            ),
        ),
        SYNC_AND_REFRESH => (
            &["refresh_tokens", "op_receipts", "change_log"],
            format!(
                r#"
                INSERT INTO refresh_tokens (id, session_id, token_hash, expires_at)
                    VALUES (gen_random_uuid(), '{session}', '\x0a0b'::bytea,
                            now() + interval '30 days');
                INSERT INTO op_receipts
                    (op_id, user_id, device_id, client_seq, server_seq, status, error_code)
                    VALUES ('{applied_op}', '{user}', '{device}', 1, 1, 'applied', NULL),
                           (gen_random_uuid(), '{user}', '{device}', 2, NULL, 'rejected',
                            'VALIDATION_FAILED');
                INSERT INTO change_log (user_id, server_seq, op_id, entity_type, entity_id,
                                        kind, patch)
                    VALUES ('{user}', 1, '{applied_op}', 'task', '{task}', 'create',
                            '{{"title": "Legacy task"}}');
                "#
            ),
        ),
        PRODUCTION_OPS => (
            &["auth_rate_limit_windows"],
            r#"
            INSERT INTO auth_rate_limit_windows (bucket, subject_hash, window_start, request_count)
                VALUES ('auth_code_request_email', decode(repeat('ab', 32), 'hex'),
                        date_trunc('hour', now()), 3);
            "#
            .to_owned(),
        ),
        TASK_TAGS => (
            &["tasks"],
            format!(
                r#"
                INSERT INTO tasks (id, user_id, list_id, title, tags, server_rev)
                    VALUES ('{tagged_task}', '{user}', '{list}', 'Tagged task',
                            ARRAY['work', '家'], 3);
                "#
            ),
        ),
        PUSH => (
            &["push_subscriptions", "push_deliveries", "push_test_usage"],
            format!(
                r#"
                INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, user_agent)
                    VALUES ('{subscription}', '{user}', 'https://push.example/{subscription}',
                            'BPublicKey', 'AuthSecret', 'Legacy browser');
                INSERT INTO push_deliveries (task_id, subscription_id)
                    VALUES ('{task}', '{subscription}');
                INSERT INTO push_test_usage (user_id, usage_day, used)
                    VALUES ('{user}', '2026-10-22', 2);
                "#
            ),
        ),
        SHARED_LISTS => (
            &[
                "shared_lists",
                "shared_list_members",
                "shared_tasks",
                "shared_steps",
                "shared_op_receipts",
            ],
            format!(
                r#"
                INSERT INTO users (id, email_normalized)
                    VALUES ('{member}', 'member-{member}@example.com');
                INSERT INTO shared_lists (id, owner_id, name, color, revision)
                    VALUES ('{shared_list}', '{user}', 'Legacy shared', '#22aa66', 3);
                INSERT INTO shared_list_members (list_id, user_id, role)
                    VALUES ('{shared_list}', '{user}', 'owner'),
                           ('{shared_list}', '{member}', 'editor');
                INSERT INTO shared_tasks (id, list_id, title, note, due_on)
                    VALUES ('{shared_task}', '{shared_list}', 'Shared task', 'shared note',
                            '2026-10-23');
                INSERT INTO shared_steps (id, task_id, title, is_completed)
                    VALUES (gen_random_uuid(), '{shared_task}', 'Shared step', true);
                INSERT INTO shared_op_receipts (list_id, op_id, actor_id, revision, status)
                    VALUES ('{shared_list}', gen_random_uuid(), '{member}', 3, 'applied');
                "#
            ),
        ),
        _ => return None,
    };
    Some(seed)
}

/// Writes the rows of every seeded migration up to `through`.
async fn seed(pool: &PgPool, through: i64, ids: &Ids) -> Vec<&'static str> {
    let mut tables = Vec::new();
    for migration in MIGRATOR.iter().take_while(|m| m.version <= through) {
        if let Some((seeded, sql)) = seed_for(migration.version, ids) {
            sqlx::raw_sql(&sql)
                .execute(pool)
                .await
                .unwrap_or_else(|error| panic!("seed {}: {error}", migration.version));
            tables.extend_from_slice(seeded);
        }
    }
    tables
}

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

type Snapshot = BTreeMap<String, Vec<Value>>;

/// Every row of every application table, as JSON objects keyed by column.
async fn snapshot(pool: &PgPool) -> Snapshot {
    let tables: Vec<String> = sqlx::query_scalar(
        "SELECT table_name::text FROM information_schema.tables \
         WHERE table_schema = 'public' AND table_type = 'BASE TABLE' \
           AND table_name <> '_sqlx_migrations' \
         ORDER BY 1",
    )
    .fetch_all(pool)
    .await
    .unwrap();
    let mut snapshot = BTreeMap::new();
    for table in tables {
        let quoted = format!("\"{}\"", table.replace('"', "\"\""));
        let rows: Vec<Value> = sqlx::query_scalar(&format!("SELECT to_jsonb(t) FROM {quoted} t"))
            .fetch_all(pool)
            .await
            .unwrap();
        snapshot.insert(table, rows);
    }
    snapshot
}

/// Each original row must still exist with the same values. Columns added by
/// later migrations may appear; rows may not be added or removed.
fn assert_rows_preserved(context: &str, before: &Snapshot, after: &Snapshot) {
    for (table, rows) in before {
        let upgraded = after
            .get(table)
            .unwrap_or_else(|| panic!("{context}: table {table} disappeared"));
        assert_eq!(
            upgraded.len(),
            rows.len(),
            "{context}: {table} row count changed"
        );
        let mut unmatched: Vec<&Value> = upgraded.iter().collect();
        for row in rows {
            let position = unmatched
                .iter()
                .position(|candidate| contains(candidate, row))
                .unwrap_or_else(|| panic!("{context}: {table} row was changed or lost: {row}"));
            unmatched.swap_remove(position);
        }
    }
}

fn contains(upgraded: &Value, original: &Value) -> bool {
    let (Some(upgraded), Some(original)) = (upgraded.as_object(), original.as_object()) else {
        return false;
    };
    original
        .iter()
        .all(|(column, value)| upgraded.get(column) == Some(value))
}

async fn schema_fingerprint(pool: &PgPool) -> Vec<String> {
    sqlx::query_scalar(
        r#"
        SELECT 'column ' || table_name::text || '.' || column_name::text || ' '
               || data_type::text || ' nullable=' || is_nullable::text
               || ' default=' || coalesce(column_default::text, '')
        FROM information_schema.columns
        WHERE table_schema = 'public'
        UNION ALL
        SELECT 'constraint ' || conrelid::regclass::text || ' ' || conname::text || ' '
               || pg_get_constraintdef(oid)
        FROM pg_constraint
        WHERE connamespace = 'public'::regnamespace
        UNION ALL
        SELECT 'index ' || indexdef
        FROM pg_indexes
        WHERE schemaname = 'public'
        ORDER BY 1
        "#,
    )
    .fetch_all(pool)
    .await
    .unwrap()
}

fn assert_same_schema(context: &str, fresh: &[String], upgraded: &[String]) {
    let missing: Vec<&String> = fresh
        .iter()
        .filter(|item| !upgraded.contains(item))
        .collect();
    let extra: Vec<&String> = upgraded
        .iter()
        .filter(|item| !fresh.contains(item))
        .collect();
    assert!(
        missing.is_empty() && extra.is_empty(),
        "{context}: upgraded schema differs from a fresh install\n\
         missing: {missing:#?}\nextra: {extra:#?}"
    );
}

async fn assert_constraints_hold(context: &str, pool: &PgPool, ids: &Ids) {
    let unvalidated: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM pg_constraint \
         WHERE connamespace = 'public'::regnamespace AND NOT convalidated",
    )
    .fetch_one(pool)
    .await
    .unwrap();
    assert_eq!(unvalidated, 0, "{context}: NOT VALID constraints remain");

    // Each probe targets rows written before the upgrade (the core seed exists
    // for every base version) and must be rejected by the database.
    let Ids {
        user,
        device,
        task,
        step,
        ..
    } = ids;
    let probes = [
        (
            "more than 20 tags on a pre-existing task",
            format!("UPDATE tasks SET tags = array_fill('x'::text, ARRAY[21]) WHERE id = '{task}'"),
            "23514",
        ),
        (
            "unknown task status",
            format!("UPDATE tasks SET status = 'archived' WHERE id = '{task}'"),
            "23514",
        ),
        (
            "step pointing at a missing task",
            format!("UPDATE steps SET task_id = gen_random_uuid() WHERE id = '{step}'"),
            "23503",
        ),
        (
            "non-positive client_seq receipt",
            format!(
                "INSERT INTO op_receipts (op_id, user_id, device_id, client_seq, status) \
                 VALUES (gen_random_uuid(), '{user}', '{device}', 0, 'rejected')"
            ),
            "23514",
        ),
        (
            "push delivery for a missing subscription",
            format!(
                "INSERT INTO push_deliveries (task_id, subscription_id) \
                 VALUES ('{task}', gen_random_uuid())"
            ),
            "23503",
        ),
    ];
    for (description, sql, sqlstate) in probes {
        let error = match sqlx::raw_sql(&sql).execute(pool).await {
            Ok(_) => panic!("{context}: {description} was accepted"),
            Err(error) => error,
        };
        let code = error
            .as_database_error()
            .and_then(|error| error.code())
            .map(|code| code.into_owned());
        assert_eq!(
            code.as_deref(),
            Some(sqlstate),
            "{context}: {description}: {error}"
        );
    }
}

async fn call(
    app: &Router,
    method: Method,
    uri: &str,
    token: Option<&str>,
    body: Option<Value>,
) -> (StatusCode, Value) {
    let mut builder = Request::builder().method(method).uri(uri);
    if let Some(token) = token {
        builder = builder.header(AUTHORIZATION, format!("Bearer {token}"));
    }
    let body = match body {
        Some(body) => {
            builder = builder.header(CONTENT_TYPE, "application/json");
            Body::from(serde_json::to_vec(&body).unwrap())
        }
        None => Body::empty(),
    };
    let response = app
        .clone()
        .oneshot(builder.body(body).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

fn find<'a>(context: &str, rows: &'a Value, id: Uuid) -> &'a Value {
    rows.as_array()
        .and_then(|rows| rows.iter().find(|row| row["id"] == json!(id)))
        .unwrap_or_else(|| panic!("{context}: {id} is missing from {rows}"))
}

/// The current API reads data written under the older schema.
async fn assert_api_reads_upgraded_data(context: &str, pool: &PgPool, ids: &Ids, base: i64) {
    let state = AppState::with_mailer(pool.clone(), Config::for_test(), Arc::new(NoopMailer));
    let (token, _) = state
        .jwt
        .issue_access(ids.user, ids.session, ids.device)
        .unwrap();
    let app = build_router(state).unwrap();
    let token = Some(token.as_str());

    let (status, ready) = call(&app, Method::GET, "/readyz", None, None).await;
    assert_eq!(status, StatusCode::OK, "{context}: readiness {ready}");

    let (status, export) = call(&app, Method::GET, "/api/v1/export", token, None).await;
    assert_eq!(status, StatusCode::OK, "{context}: export {export}");
    assert_eq!(export["user"]["preferred_timezone"], "Europe/Berlin");
    assert_eq!(
        find(context, &export["lists"], ids.list)["name"],
        "Legacy list"
    );
    let task = find(context, &export["tasks"], ids.task);
    assert_eq!(task["title"], "Legacy task", "{context}");
    assert_eq!(task["note"], "note ✓ 中文", "{context}");
    assert_eq!(task["due_on"], "2026-10-21", "{context}");
    assert_eq!(
        task["recurrence"],
        json!({ "freq": "daily", "interval": 1 }),
        "{context}"
    );
    // Tasks written before the tags column existed read back with no tags.
    assert_eq!(task["tags"], json!([]), "{context}");
    let active_tasks = if base >= TASK_TAGS {
        let tagged = find(context, &export["tasks"], ids.tagged_task);
        assert_eq!(tagged["tags"], json!(["work", "家"]), "{context}");
        2
    } else {
        1
    };
    assert_eq!(
        export["tasks"].as_array().map(Vec::len),
        Some(active_tasks),
        "{context}: tombstoned tasks must stay out of the export"
    );
    assert_eq!(
        find(context, &export["steps"], ids.step)["title"],
        "Legacy step"
    );
    find(context, &export["day_plans"], ids.day_plan);

    let (status, pulled) = call(
        &app,
        Method::POST,
        "/api/v1/sync",
        token,
        Some(json!({ "device_id": ids.device, "cursor": "0", "ops": [] })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{context}: sync pull {pulled}");
    let expected_changes = if base >= SYNC_AND_REFRESH {
        json!([ids.applied_op])
    } else {
        json!([])
    };
    let changes: Vec<Value> = pulled["changes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|change| change["op_id"].clone())
        .collect();
    assert_eq!(json!(changes), expected_changes, "{context}");

    if base >= SHARED_LISTS {
        let (status, lists) = call(&app, Method::GET, "/api/v1/shared/lists", token, None).await;
        assert_eq!(status, StatusCode::OK, "{context}: shared lists {lists}");
        assert_eq!(
            find(context, &lists, ids.shared_list)["role"],
            "owner",
            "{context}"
        );
        let uri = format!("/api/v1/shared/lists/{}", ids.shared_list);
        let (status, snapshot) = call(&app, Method::GET, &uri, token, None).await;
        assert_eq!(status, StatusCode::OK, "{context}: shared list {snapshot}");
        assert_eq!(
            find(context, &snapshot["tasks"], ids.shared_task)["title"],
            "Shared task"
        );
        assert_eq!(snapshot["revision"], 3, "{context}");
    }
}
