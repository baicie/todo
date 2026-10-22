use std::collections::HashSet;

use axum::{Json, Router, extract::State, routing::post};
use chrono::{DateTime, NaiveDate, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::{FromRow, Postgres, Transaction, types::Json as SqlJson};
use uuid::Uuid;

use crate::{
    auth::AuthUser,
    config::{MAX_SYNC_CHANGES, MAX_SYNC_OPS},
    cursor::{ChangeCursor, parse_page_limit},
    domain::{EntityType, MutationKind, TaskStatus},
    error::{ApiResult, AppError},
    extract::ApiJson,
    mutation::{
        DayPlanValues, ListValues, MutationError, StepValues, TaskValues, parse_day_plan_patch,
        parse_list_patch, parse_step_patch, parse_task_patch,
    },
    state::AppState,
};

pub fn router() -> Router<AppState> {
    Router::new().route("/api/v1/sync", post(sync))
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct SyncRequest {
    device_id: Uuid,
    cursor: String,
    ops: Vec<Mutation>,
    limit: Option<u32>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Mutation {
    pub op_id: Uuid,
    pub client_seq: i64,
    pub entity: EntityType,
    pub entity_id: Uuid,
    pub kind: MutationKind,
    pub patch: Value,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AckStatus {
    Applied,
    Rejected,
    AlreadyProcessed,
}

#[derive(Debug, Serialize)]
struct Ack {
    op_id: Uuid,
    server_seq: Option<i64>,
    status: AckStatus,
    error_code: Option<String>,
}

#[derive(Debug, Serialize)]
struct Change {
    server_seq: i64,
    op_id: Uuid,
    entity: EntityType,
    entity_id: Uuid,
    kind: MutationKind,
    patch: Value,
}

#[derive(Debug, FromRow)]
struct ChangeRow {
    server_seq: i64,
    op_id: Uuid,
    entity_type: String,
    entity_id: Uuid,
    kind: String,
    patch: SqlJson<Value>,
}

#[derive(Debug, Serialize)]
struct SyncResponse {
    ack: Vec<Ack>,
    changes: Vec<Change>,
    next_cursor: String,
    has_more: bool,
    server_time: DateTime<Utc>,
}

#[derive(Debug, FromRow)]
struct ReceiptRow {
    op_id: Uuid,
    user_id: Uuid,
    device_id: Uuid,
    client_seq: i64,
    server_seq: Option<i64>,
    status: String,
    error_code: Option<String>,
}

#[derive(Debug, FromRow)]
struct SyncStateRow {
    next_server_seq: i64,
    min_available_seq: i64,
}

#[derive(Debug, FromRow)]
struct DeviceRow {
    last_client_seq: i64,
    revoked_at: Option<DateTime<Utc>>,
}

async fn sync(
    State(state): State<AppState>,
    auth: AuthUser,
    ApiJson(body): ApiJson<SyncRequest>,
) -> ApiResult<Json<SyncResponse>> {
    if auth.device_id != body.device_id {
        return Err(AppError::Forbidden {
            code: "DEVICE_MISMATCH",
            message: "The access token was issued for a different device".to_owned(),
        });
    }
    let limit = parse_page_limit(body.limit, MAX_SYNC_CHANGES, MAX_SYNC_CHANGES)
        .map_err(|_| AppError::validation("limit must be between 1 and 500"))?;
    validate_batch(&body.ops)?;
    let prior_cursor = ChangeCursor::parse(&body.cursor)
        .map_err(|_| AppError::validation("cursor must be a non-negative integer string"))?;

    let mut tx = state.pool.begin().await?;

    // All account sync transactions take locks in this order:
    // users -> account_sync_state -> devices. Account deletion takes the same
    // user/state locks, and device revocation takes the same user/device locks.
    let user: Option<(Uuid, Option<DateTime<Utc>>)> =
        sqlx::query_as("SELECT id, deleted_at FROM users WHERE id = $1 FOR UPDATE")
            .bind(auth.user_id)
            .fetch_optional(&mut *tx)
            .await?;
    if user.is_none_or(|(_, deleted_at)| deleted_at.is_some()) {
        return Err(AppError::unauthorized());
    }

    sqlx::query(
        "INSERT INTO account_sync_state (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING",
    )
    .bind(auth.user_id)
    .execute(&mut *tx)
    .await?;
    let sync_state = sqlx::query_as::<_, SyncStateRow>(
        "SELECT next_server_seq, min_available_seq FROM account_sync_state \
         WHERE user_id = $1 FOR UPDATE",
    )
    .bind(auth.user_id)
    .fetch_one(&mut *tx)
    .await?;

    let max_allocated = sync_state.next_server_seq - 1;
    if prior_cursor.get() > max_allocated {
        return Err(AppError::BadRequest {
            code: "INVALID_CURSOR",
            message: "Cursor is ahead of this account's change log".to_owned(),
        });
    }
    let earliest_readable_cursor = sync_state.min_available_seq.saturating_sub(1);
    if prior_cursor.get() < earliest_readable_cursor {
        return Err(AppError::cursor_expired());
    }

    let device = sqlx::query_as::<_, DeviceRow>(
        "SELECT last_client_seq, revoked_at FROM devices \
         WHERE user_id = $1 AND id = $2 FOR UPDATE",
    )
    .bind(auth.user_id)
    .bind(body.device_id)
    .fetch_optional(&mut *tx)
    .await?;
    let Some(device) = device else {
        return Err(AppError::Forbidden {
            code: "DEVICE_NOT_FOUND",
            message: "Device is not registered for this account".to_owned(),
        });
    };
    if device.revoked_at.is_some() {
        return Err(AppError::Unauthorized {
            code: "DEVICE_REVOKED",
            message: "This device has been revoked".to_owned(),
        });
    }

    let op_ids: Vec<Uuid> = body.ops.iter().map(|op| op.op_id).collect();
    let client_seqs: Vec<i64> = body.ops.iter().map(|op| op.client_seq).collect();
    let receipts_by_op = sqlx::query_as::<_, ReceiptRow>(
        r#"
        SELECT op_id, user_id, device_id, client_seq, server_seq, status, error_code
        FROM op_receipts
        WHERE op_id = ANY($1)
        "#,
    )
    .bind(&op_ids)
    .fetch_all(&mut *tx)
    .await?;
    let receipts_by_seq = sqlx::query_as::<_, ReceiptRow>(
        r#"
        SELECT op_id, user_id, device_id, client_seq, server_seq, status, error_code
        FROM op_receipts
        WHERE user_id = $1 AND device_id = $2 AND client_seq = ANY($3)
        "#,
    )
    .bind(auth.user_id)
    .bind(body.device_id)
    .bind(&client_seqs)
    .fetch_all(&mut *tx)
    .await?;

    let by_op: std::collections::HashMap<Uuid, ReceiptRow> = receipts_by_op
        .into_iter()
        .map(|receipt| (receipt.op_id, receipt))
        .collect();
    let by_seq: std::collections::HashMap<i64, ReceiptRow> = receipts_by_seq
        .into_iter()
        .map(|receipt| (receipt.client_seq, receipt))
        .collect();

    let mut expected_client_seq = device.last_client_seq + 1;
    let mut next_server_seq = sync_state.next_server_seq;
    let mut acks = Vec::with_capacity(body.ops.len());

    for mutation in &body.ops {
        if let Some(receipt) = by_op.get(&mutation.op_id) {
            if receipt.user_id != auth.user_id
                || receipt.device_id != body.device_id
                || receipt.client_seq != mutation.client_seq
            {
                return Err(AppError::sequence_mismatch(
                    "op_id was previously accepted with a different device or client_seq",
                ));
            }
            acks.push(receipt_ack(receipt));
            continue;
        }

        if mutation.client_seq <= device.last_client_seq {
            // The receipt may have been pruned after the device watermark was
            // persisted. The watermark is authoritative: never reapply it.
            if let Some(existing) = by_seq.get(&mutation.client_seq)
                && existing.op_id != mutation.op_id
            {
                return Err(AppError::sequence_mismatch(
                    "client_seq was already processed for a different op_id",
                ));
            }
            acks.push(Ack {
                op_id: mutation.op_id,
                server_seq: None,
                status: AckStatus::AlreadyProcessed,
                error_code: None,
            });
            continue;
        }

        if mutation.client_seq != expected_client_seq {
            return Err(AppError::sequence_mismatch(format!(
                "expected client_seq {}, received {}",
                expected_client_seq, mutation.client_seq
            )));
        }
        if by_seq.contains_key(&mutation.client_seq) {
            return Err(AppError::sequence_mismatch(
                "client_seq conflicts with an existing receipt",
            ));
        }

        sqlx::query("SAVEPOINT todo_sync_operation")
            .execute(&mut *tx)
            .await?;
        let server_seq = next_server_seq;
        match apply_mutation(&mut tx, auth.user_id, mutation, server_seq).await {
            Ok(change_patch) => {
                sqlx::query(
                    "INSERT INTO change_log \
                     (user_id, server_seq, op_id, entity_type, entity_id, kind, patch) \
                     VALUES ($1, $2, $3, $4, $5, $6, $7)",
                )
                .bind(auth.user_id)
                .bind(server_seq)
                .bind(mutation.op_id)
                .bind(mutation.entity.as_str())
                .bind(mutation.entity_id)
                .bind(mutation.kind.as_str())
                .bind(SqlJson(change_patch))
                .execute(&mut *tx)
                .await?;
                sqlx::query(
                    "INSERT INTO op_receipts \
                     (op_id, user_id, device_id, client_seq, server_seq, status) \
                     VALUES ($1, $2, $3, $4, $5, 'applied')",
                )
                .bind(mutation.op_id)
                .bind(auth.user_id)
                .bind(body.device_id)
                .bind(mutation.client_seq)
                .bind(server_seq)
                .execute(&mut *tx)
                .await?;
                sqlx::query("RELEASE SAVEPOINT todo_sync_operation")
                    .execute(&mut *tx)
                    .await?;
                next_server_seq += 1;
                acks.push(Ack {
                    op_id: mutation.op_id,
                    server_seq: Some(server_seq),
                    status: AckStatus::Applied,
                    error_code: None,
                });
            }
            Err(ApplyFailure::Reject(rejection)) => {
                sqlx::query("ROLLBACK TO SAVEPOINT todo_sync_operation")
                    .execute(&mut *tx)
                    .await?;
                sqlx::query("RELEASE SAVEPOINT todo_sync_operation")
                    .execute(&mut *tx)
                    .await?;
                insert_rejected_receipt(
                    &mut tx,
                    auth.user_id,
                    body.device_id,
                    mutation,
                    rejection.code,
                )
                .await?;
                acks.push(Ack {
                    op_id: mutation.op_id,
                    server_seq: None,
                    status: AckStatus::Rejected,
                    error_code: Some(rejection.code.to_owned()),
                });
            }
            Err(ApplyFailure::Database(error)) if is_constraint_violation(&error) => {
                sqlx::query("ROLLBACK TO SAVEPOINT todo_sync_operation")
                    .execute(&mut *tx)
                    .await?;
                sqlx::query("RELEASE SAVEPOINT todo_sync_operation")
                    .execute(&mut *tx)
                    .await?;
                insert_rejected_receipt(
                    &mut tx,
                    auth.user_id,
                    body.device_id,
                    mutation,
                    "CONSTRAINT_VIOLATION",
                )
                .await?;
                acks.push(Ack {
                    op_id: mutation.op_id,
                    server_seq: None,
                    status: AckStatus::Rejected,
                    error_code: Some("CONSTRAINT_VIOLATION".to_owned()),
                });
            }
            Err(ApplyFailure::Database(error)) => return Err(error.into()),
        }

        expected_client_seq += 1;
    }

    if expected_client_seq - 1 > device.last_client_seq {
        sqlx::query(
            "UPDATE devices SET last_client_seq = $1, last_seen_at = now() \
             WHERE user_id = $2 AND id = $3",
        )
        .bind(expected_client_seq - 1)
        .bind(auth.user_id)
        .bind(body.device_id)
        .execute(&mut *tx)
        .await?;
    }
    if next_server_seq != sync_state.next_server_seq {
        sqlx::query("UPDATE account_sync_state SET next_server_seq = $1 WHERE user_id = $2")
            .bind(next_server_seq)
            .bind(auth.user_id)
            .execute(&mut *tx)
            .await?;
    }

    let change_rows = sqlx::query_as::<_, ChangeRow>(
        r#"
        SELECT server_seq, op_id, entity_type, entity_id, kind, patch
        FROM change_log
        WHERE user_id = $1 AND server_seq > $2
        ORDER BY server_seq
        LIMIT $3
        "#,
    )
    .bind(auth.user_id)
    .bind(prior_cursor.get())
    .bind(i64::from(limit) + 1)
    .fetch_all(&mut *tx)
    .await?;

    let has_more = change_rows.len() > limit as usize;
    let mut changes = Vec::with_capacity(change_rows.len().min(limit as usize));
    for row in change_rows.into_iter().take(limit as usize) {
        let entity = EntityType::parse(&row.entity_type)
            .ok_or_else(|| AppError::Internal("unknown entity type in change log".to_owned()))?;
        let kind = parse_kind(&row.kind)
            .ok_or_else(|| AppError::Internal("unknown mutation kind in change log".to_owned()))?;
        changes.push(Change {
            server_seq: row.server_seq,
            op_id: row.op_id,
            entity,
            entity_id: row.entity_id,
            kind,
            patch: row.patch.0,
        });
    }
    let next_cursor = changes
        .last()
        .map_or(prior_cursor.get(), |change| change.server_seq);

    tx.commit().await?;

    let applied = acks
        .iter()
        .filter(|ack| ack.status == AckStatus::Applied)
        .count() as u64;
    let rejected = acks
        .iter()
        .filter(|ack| ack.status == AckStatus::Rejected)
        .count() as u64;
    let already_processed = acks
        .iter()
        .filter(|ack| ack.status == AckStatus::AlreadyProcessed)
        .count() as u64;
    state.metrics.record_sync("applied", applied);
    state.metrics.record_sync("rejected", rejected);
    state
        .metrics
        .record_sync("already_processed", already_processed);

    Ok(Json(SyncResponse {
        ack: acks,
        changes,
        next_cursor: next_cursor.to_string(),
        has_more,
        server_time: Utc::now(),
    }))
}

fn parse_kind(value: &str) -> Option<MutationKind> {
    match value {
        "create" => Some(MutationKind::Create),
        "patch" => Some(MutationKind::Patch),
        "delete" => Some(MutationKind::Delete),
        "restore" => Some(MutationKind::Restore),
        _ => None,
    }
}

fn validate_batch(ops: &[Mutation]) -> ApiResult<()> {
    if ops.len() > MAX_SYNC_OPS {
        return Err(AppError::validation(format!(
            "a sync request may contain at most {MAX_SYNC_OPS} operations"
        )));
    }
    let mut previous_seq = 0_i64;
    let mut op_ids = HashSet::new();
    for op in ops {
        if op.client_seq <= 0 {
            return Err(AppError::sequence_mismatch(
                "client_seq must be greater than zero",
            ));
        }
        if op.client_seq <= previous_seq {
            return Err(AppError::sequence_mismatch(
                "ops must be ordered by strictly increasing client_seq",
            ));
        }
        if !op_ids.insert(op.op_id) {
            return Err(AppError::sequence_mismatch(
                "duplicate op_id in a sync request",
            ));
        }
        previous_seq = op.client_seq;
    }
    Ok(())
}

fn receipt_ack(receipt: &ReceiptRow) -> Ack {
    let status = match receipt.status.as_str() {
        "applied" => AckStatus::Applied,
        "rejected" => AckStatus::Rejected,
        _ => AckStatus::Rejected,
    };
    Ack {
        op_id: receipt.op_id,
        server_seq: receipt.server_seq,
        status,
        error_code: receipt.error_code.clone(),
    }
}

async fn insert_rejected_receipt(
    tx: &mut Transaction<'_, Postgres>,
    user_id: Uuid,
    device_id: Uuid,
    mutation: &Mutation,
    error_code: &str,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "INSERT INTO op_receipts \
         (op_id, user_id, device_id, client_seq, server_seq, status, error_code) \
         VALUES ($1, $2, $3, $4, NULL, 'rejected', $5)",
    )
    .bind(mutation.op_id)
    .bind(user_id)
    .bind(device_id)
    .bind(mutation.client_seq)
    .bind(error_code)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

fn is_constraint_violation(error: &sqlx::Error) -> bool {
    matches!(
        error,
        sqlx::Error::Database(database_error)
            if database_error.code().is_some_and(|code| code.starts_with("23"))
    )
}

enum ApplyFailure {
    Reject(MutationError),
    Database(sqlx::Error),
}

impl From<sqlx::Error> for ApplyFailure {
    fn from(error: sqlx::Error) -> Self {
        Self::Database(error)
    }
}

impl From<MutationError> for ApplyFailure {
    fn from(error: MutationError) -> Self {
        Self::Reject(error)
    }
}

#[derive(Debug, FromRow)]
struct ListRow {
    name: String,
    color: Option<String>,
    icon: Option<String>,
    rank: String,
    deleted_at: Option<DateTime<Utc>>,
}

#[derive(Debug, FromRow)]
struct TaskRow {
    list_id: Option<Uuid>,
    title: String,
    note: String,
    status: String,
    important: bool,
    tags: Vec<String>,
    due_on: Option<NaiveDate>,
    remind_at: Option<DateTime<Utc>>,
    remind_timezone: Option<String>,
    rank: String,
    series_id: Option<Uuid>,
    occurrence_key: Option<String>,
    recurrence: Option<SqlJson<Value>>,
    completed_at: Option<DateTime<Utc>>,
    deleted_at: Option<DateTime<Utc>>,
}

#[derive(Debug, FromRow)]
struct StepRow {
    task_id: Uuid,
    title: String,
    is_completed: bool,
    rank: String,
    deleted_at: Option<DateTime<Utc>>,
}

#[derive(Debug, FromRow)]
struct DayPlanRow {
    task_id: Uuid,
    local_date: NaiveDate,
    rank: String,
    deleted_at: Option<DateTime<Utc>>,
}

async fn apply_mutation(
    tx: &mut Transaction<'_, Postgres>,
    user_id: Uuid,
    mutation: &Mutation,
    server_seq: i64,
) -> Result<Value, ApplyFailure> {
    match mutation.entity {
        EntityType::List => apply_list(tx, user_id, mutation, server_seq).await,
        EntityType::Task => apply_task(tx, user_id, mutation, server_seq).await,
        EntityType::Step => apply_step(tx, user_id, mutation, server_seq).await,
        EntityType::DayPlan => apply_day_plan(tx, user_id, mutation, server_seq).await,
    }
}

async fn apply_list(
    tx: &mut Transaction<'_, Postgres>,
    user_id: Uuid,
    mutation: &Mutation,
    server_seq: i64,
) -> Result<Value, ApplyFailure> {
    match mutation.kind {
        MutationKind::Create => {
            require_present_fields(&mutation.patch, &["name"])?;
            let existing: Option<(Uuid,)> =
                sqlx::query_as("SELECT id FROM lists WHERE user_id = $1 AND id = $2 FOR UPDATE")
                    .bind(user_id)
                    .bind(mutation.entity_id)
                    .fetch_optional(&mut **tx)
                    .await?;
            if existing.is_some() {
                return Err(MutationError::already_exists().into());
            }
            let patch = parse_list_patch(&mutation.patch, true)?;
            let mut values = ListValues::empty();
            patch.apply(&mut values)?;
            values.validate()?;
            sqlx::query(
                "INSERT INTO lists \
                 (id, user_id, name, color, icon, rank, server_rev) \
                 VALUES ($1, $2, $3, $4, $5, $6, $7)",
            )
            .bind(mutation.entity_id)
            .bind(user_id)
            .bind(&values.name)
            .bind(&values.color)
            .bind(&values.icon)
            .bind(&values.rank)
            .bind(server_seq)
            .execute(&mut **tx)
            .await?;
            Ok(values.change_patch())
        }
        MutationKind::Patch => {
            let row = sqlx::query_as::<_, ListRow>(
                "SELECT name, color, icon, rank, deleted_at FROM lists \
                 WHERE user_id = $1 AND id = $2 FOR UPDATE",
            )
            .bind(user_id)
            .bind(mutation.entity_id)
            .fetch_optional(&mut **tx)
            .await?
            .ok_or_else(MutationError::not_found)?;
            if row.deleted_at.is_some() {
                return Err(MutationError::tombstoned().into());
            }
            let patch = parse_list_patch(&mutation.patch, false)?;
            let mut values = list_values(row);
            patch.apply(&mut values)?;
            values.validate()?;
            sqlx::query(
                "UPDATE lists SET name = $3, color = $4, icon = $5, rank = $6, \
                 server_rev = $7, updated_at = now() WHERE user_id = $1 AND id = $2",
            )
            .bind(user_id)
            .bind(mutation.entity_id)
            .bind(&values.name)
            .bind(&values.color)
            .bind(&values.icon)
            .bind(&values.rank)
            .bind(server_seq)
            .execute(&mut **tx)
            .await?;
            Ok(mutation.patch.clone())
        }
        MutationKind::Delete => {
            let row = sqlx::query_as::<_, ListRow>(
                "SELECT name, color, icon, rank, deleted_at FROM lists \
                 WHERE user_id = $1 AND id = $2 FOR UPDATE",
            )
            .bind(user_id)
            .bind(mutation.entity_id)
            .fetch_optional(&mut **tx)
            .await?
            .ok_or_else(MutationError::not_found)?;
            if row.deleted_at.is_some() {
                return Err(MutationError::tombstoned().into());
            }
            ensure_empty_patch(&mutation.patch)?;
            sqlx::query(
                "UPDATE lists SET deleted_at = now(), updated_at = now(), server_rev = $3 \
                 WHERE user_id = $1 AND id = $2",
            )
            .bind(user_id)
            .bind(mutation.entity_id)
            .bind(server_seq)
            .execute(&mut **tx)
            .await?;
            Ok(json!({}))
        }
        MutationKind::Restore => {
            let row = sqlx::query_as::<_, ListRow>(
                "SELECT name, color, icon, rank, deleted_at FROM lists \
                 WHERE user_id = $1 AND id = $2 FOR UPDATE",
            )
            .bind(user_id)
            .bind(mutation.entity_id)
            .fetch_optional(&mut **tx)
            .await?
            .ok_or_else(MutationError::not_found)?;
            if row.deleted_at.is_none() {
                return Err(MutationError::invalid_state("entity is not deleted").into());
            }
            let patch = parse_list_patch(&mutation.patch, true)?;
            let mut values = list_values(row);
            patch.apply(&mut values)?;
            values.validate()?;
            sqlx::query(
                "UPDATE lists SET name = $3, color = $4, icon = $5, rank = $6, \
                 deleted_at = NULL, server_rev = $7, updated_at = now() \
                 WHERE user_id = $1 AND id = $2",
            )
            .bind(user_id)
            .bind(mutation.entity_id)
            .bind(&values.name)
            .bind(&values.color)
            .bind(&values.icon)
            .bind(&values.rank)
            .bind(server_seq)
            .execute(&mut **tx)
            .await?;
            Ok(mutation.patch.clone())
        }
    }
}

async fn apply_task(
    tx: &mut Transaction<'_, Postgres>,
    user_id: Uuid,
    mutation: &Mutation,
    server_seq: i64,
) -> Result<Value, ApplyFailure> {
    match mutation.kind {
        MutationKind::Create => {
            require_present_fields(&mutation.patch, &["title"])?;
            let existing: Option<(Uuid,)> =
                sqlx::query_as("SELECT id FROM tasks WHERE user_id = $1 AND id = $2 FOR UPDATE")
                    .bind(user_id)
                    .bind(mutation.entity_id)
                    .fetch_optional(&mut **tx)
                    .await?;
            if existing.is_some() {
                return Err(MutationError::already_exists().into());
            }
            let patch = parse_task_patch(&mutation.patch, true)?;
            let mut values = TaskValues::empty();
            patch.apply(&mut values)?;
            values.validate()?;
            ensure_active_list(tx, user_id, values.list_id).await?;
            insert_task(tx, user_id, mutation.entity_id, &values, server_seq).await?;
            Ok(values.change_patch())
        }
        MutationKind::Patch => {
            let row = select_task(tx, user_id, mutation.entity_id).await?;
            let Some(row) = row else {
                return Err(MutationError::not_found().into());
            };
            if row.deleted_at.is_some() {
                return Err(MutationError::tombstoned().into());
            }
            let patch = parse_task_patch(&mutation.patch, false)?;
            let mut values = task_values(&row)?;
            patch.apply(&mut values)?;
            values.validate()?;
            ensure_active_list(tx, user_id, values.list_id).await?;
            update_task(tx, user_id, mutation.entity_id, &values, server_seq, false).await?;
            Ok(task_patch_change(mutation, &values))
        }
        MutationKind::Delete => {
            let row = select_task(tx, user_id, mutation.entity_id).await?;
            let Some(row) = row else {
                return Err(MutationError::not_found().into());
            };
            if row.deleted_at.is_some() {
                return Err(MutationError::tombstoned().into());
            }
            ensure_empty_patch(&mutation.patch)?;
            sqlx::query(
                "UPDATE tasks SET deleted_at = now(), updated_at = now(), server_rev = $3 \
                 WHERE user_id = $1 AND id = $2",
            )
            .bind(user_id)
            .bind(mutation.entity_id)
            .bind(server_seq)
            .execute(&mut **tx)
            .await?;
            Ok(json!({}))
        }
        MutationKind::Restore => {
            let row = select_task(tx, user_id, mutation.entity_id).await?;
            let Some(row) = row else {
                return Err(MutationError::not_found().into());
            };
            if row.deleted_at.is_none() {
                return Err(MutationError::invalid_state("entity is not deleted").into());
            }
            let patch = parse_task_patch(&mutation.patch, true)?;
            let mut values = task_values(&row)?;
            patch.apply(&mut values)?;
            values.validate()?;
            ensure_active_list(tx, user_id, values.list_id).await?;
            update_task(tx, user_id, mutation.entity_id, &values, server_seq, true).await?;
            Ok(task_patch_change(mutation, &values))
        }
    }
}

fn task_patch_change(mutation: &Mutation, values: &TaskValues) -> Value {
    let mut patch = mutation.patch.clone();
    if patch.get("tags").is_some()
        && let Some(object) = patch.as_object_mut()
    {
        object.insert("tags".to_owned(), json!(values.tags));
    }
    patch
}

async fn apply_step(
    tx: &mut Transaction<'_, Postgres>,
    user_id: Uuid,
    mutation: &Mutation,
    server_seq: i64,
) -> Result<Value, ApplyFailure> {
    match mutation.kind {
        MutationKind::Create => {
            require_present_fields(&mutation.patch, &["task_id", "title"])?;
            let existing: Option<(Uuid,)> =
                sqlx::query_as("SELECT id FROM steps WHERE user_id = $1 AND id = $2 FOR UPDATE")
                    .bind(user_id)
                    .bind(mutation.entity_id)
                    .fetch_optional(&mut **tx)
                    .await?;
            if existing.is_some() {
                return Err(MutationError::already_exists().into());
            }
            let patch = parse_step_patch(&mutation.patch, true)?;
            let mut values = StepValues::empty(Uuid::nil());
            patch.apply(&mut values)?;
            if values.task_id.is_nil() {
                return Err(MutationError::validation("field \"task_id\" is required").into());
            }
            values.validate()?;
            ensure_active_task(tx, user_id, values.task_id).await?;
            sqlx::query(
                "INSERT INTO steps \
                 (id, user_id, task_id, title, is_completed, rank, server_rev) \
                 VALUES ($1, $2, $3, $4, $5, $6, $7)",
            )
            .bind(mutation.entity_id)
            .bind(user_id)
            .bind(values.task_id)
            .bind(&values.title)
            .bind(values.is_completed)
            .bind(&values.rank)
            .bind(server_seq)
            .execute(&mut **tx)
            .await?;
            Ok(values.change_patch())
        }
        MutationKind::Patch => {
            let row = select_step(tx, user_id, mutation.entity_id).await?;
            let Some(row) = row else {
                return Err(MutationError::not_found().into());
            };
            if row.deleted_at.is_some() {
                return Err(MutationError::tombstoned().into());
            }
            let patch = parse_step_patch(&mutation.patch, false)?;
            let mut values = step_values(row);
            patch.apply(&mut values)?;
            values.validate()?;
            ensure_active_task(tx, user_id, values.task_id).await?;
            update_step(tx, user_id, mutation.entity_id, &values, server_seq, false).await?;
            Ok(mutation.patch.clone())
        }
        MutationKind::Delete => {
            let row = select_step(tx, user_id, mutation.entity_id).await?;
            let Some(row) = row else {
                return Err(MutationError::not_found().into());
            };
            if row.deleted_at.is_some() {
                return Err(MutationError::tombstoned().into());
            }
            ensure_empty_patch(&mutation.patch)?;
            sqlx::query(
                "UPDATE steps SET deleted_at = now(), updated_at = now(), server_rev = $3 \
                 WHERE user_id = $1 AND id = $2",
            )
            .bind(user_id)
            .bind(mutation.entity_id)
            .bind(server_seq)
            .execute(&mut **tx)
            .await?;
            Ok(json!({}))
        }
        MutationKind::Restore => {
            let row = select_step(tx, user_id, mutation.entity_id).await?;
            let Some(row) = row else {
                return Err(MutationError::not_found().into());
            };
            if row.deleted_at.is_none() {
                return Err(MutationError::invalid_state("entity is not deleted").into());
            }
            let patch = parse_step_patch(&mutation.patch, true)?;
            let mut values = step_values(row);
            patch.apply(&mut values)?;
            values.validate()?;
            ensure_active_task(tx, user_id, values.task_id).await?;
            update_step(tx, user_id, mutation.entity_id, &values, server_seq, true).await?;
            Ok(mutation.patch.clone())
        }
    }
}

async fn apply_day_plan(
    tx: &mut Transaction<'_, Postgres>,
    user_id: Uuid,
    mutation: &Mutation,
    server_seq: i64,
) -> Result<Value, ApplyFailure> {
    match mutation.kind {
        MutationKind::Create => {
            require_present_fields(&mutation.patch, &["task_id", "local_date"])?;
            let existing: Option<(Uuid,)> = sqlx::query_as(
                "SELECT id FROM day_plans WHERE user_id = $1 AND id = $2 FOR UPDATE",
            )
            .bind(user_id)
            .bind(mutation.entity_id)
            .fetch_optional(&mut **tx)
            .await?;
            if existing.is_some() {
                return Err(MutationError::already_exists().into());
            }
            let patch = parse_day_plan_patch(&mutation.patch, true)?;
            let mut values = DayPlanValues::empty(Uuid::nil());
            patch.apply(&mut values)?;
            if values.task_id.is_nil() {
                return Err(MutationError::validation("field \"task_id\" is required").into());
            }
            values.validate()?;
            ensure_active_task(tx, user_id, values.task_id).await?;
            sqlx::query(
                "INSERT INTO day_plans \
                 (id, user_id, task_id, local_date, rank, server_rev) \
                 VALUES ($1, $2, $3, $4, $5, $6)",
            )
            .bind(mutation.entity_id)
            .bind(user_id)
            .bind(values.task_id)
            .bind(values.local_date)
            .bind(&values.rank)
            .bind(server_seq)
            .execute(&mut **tx)
            .await?;
            Ok(values.change_patch())
        }
        MutationKind::Patch => {
            let row = select_day_plan(tx, user_id, mutation.entity_id).await?;
            let Some(row) = row else {
                return Err(MutationError::not_found().into());
            };
            if row.deleted_at.is_some() {
                return Err(MutationError::tombstoned().into());
            }
            let patch = parse_day_plan_patch(&mutation.patch, false)?;
            let mut values = day_plan_values(row);
            patch.apply(&mut values)?;
            values.validate()?;
            ensure_active_task(tx, user_id, values.task_id).await?;
            update_day_plan(tx, user_id, mutation.entity_id, &values, server_seq, false).await?;
            Ok(mutation.patch.clone())
        }
        MutationKind::Delete => {
            let row = select_day_plan(tx, user_id, mutation.entity_id).await?;
            let Some(row) = row else {
                return Err(MutationError::not_found().into());
            };
            if row.deleted_at.is_some() {
                return Err(MutationError::tombstoned().into());
            }
            ensure_empty_patch(&mutation.patch)?;
            sqlx::query(
                "UPDATE day_plans SET deleted_at = now(), updated_at = now(), server_rev = $3 \
                 WHERE user_id = $1 AND id = $2",
            )
            .bind(user_id)
            .bind(mutation.entity_id)
            .bind(server_seq)
            .execute(&mut **tx)
            .await?;
            Ok(json!({}))
        }
        MutationKind::Restore => {
            let row = select_day_plan(tx, user_id, mutation.entity_id).await?;
            let Some(row) = row else {
                return Err(MutationError::not_found().into());
            };
            if row.deleted_at.is_none() {
                return Err(MutationError::invalid_state("entity is not deleted").into());
            }
            let patch = parse_day_plan_patch(&mutation.patch, true)?;
            let mut values = day_plan_values(row);
            patch.apply(&mut values)?;
            values.validate()?;
            ensure_active_task(tx, user_id, values.task_id).await?;
            update_day_plan(tx, user_id, mutation.entity_id, &values, server_seq, true).await?;
            Ok(mutation.patch.clone())
        }
    }
}

fn list_values(row: ListRow) -> ListValues {
    ListValues {
        name: row.name,
        color: row.color,
        icon: row.icon,
        rank: row.rank,
    }
}

fn task_values(row: &TaskRow) -> Result<TaskValues, ApplyFailure> {
    let status = TaskStatus::parse(&row.status)
        .ok_or_else(|| MutationError::invalid_state("stored task status is invalid"))?;
    Ok(TaskValues {
        list_id: row.list_id,
        title: row.title.clone(),
        note: row.note.clone(),
        status,
        important: row.important,
        tags: row.tags.clone(),
        due_on: row.due_on,
        remind_at: row.remind_at,
        remind_timezone: row.remind_timezone.clone(),
        rank: row.rank.clone(),
        series_id: row.series_id,
        occurrence_key: row.occurrence_key.clone(),
        recurrence: row.recurrence.as_ref().map(|value| value.0.clone()),
        completed_at: row.completed_at,
    })
}

fn step_values(row: StepRow) -> StepValues {
    StepValues {
        task_id: row.task_id,
        title: row.title,
        is_completed: row.is_completed,
        rank: row.rank,
    }
}

fn day_plan_values(row: DayPlanRow) -> DayPlanValues {
    DayPlanValues {
        task_id: row.task_id,
        local_date: row.local_date,
        rank: row.rank,
    }
}

async fn select_task(
    tx: &mut Transaction<'_, Postgres>,
    user_id: Uuid,
    id: Uuid,
) -> Result<Option<TaskRow>, sqlx::Error> {
    sqlx::query_as::<_, TaskRow>(
        r#"
        SELECT list_id, title, note, status, important, tags, due_on, remind_at,
               remind_timezone, rank, series_id, occurrence_key, recurrence,
               completed_at, deleted_at
        FROM tasks
        WHERE user_id = $1 AND id = $2
        FOR UPDATE
        "#,
    )
    .bind(user_id)
    .bind(id)
    .fetch_optional(&mut **tx)
    .await
}

async fn insert_task(
    tx: &mut Transaction<'_, Postgres>,
    user_id: Uuid,
    id: Uuid,
    values: &TaskValues,
    server_seq: i64,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        r#"
        INSERT INTO tasks
        (id, user_id, list_id, title, note, status, important, tags, due_on, remind_at,
         remind_timezone, rank, series_id, occurrence_key, recurrence, completed_at, server_rev)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
        "#,
    )
    .bind(id)
    .bind(user_id)
    .bind(values.list_id)
    .bind(&values.title)
    .bind(&values.note)
    .bind(values.status.as_str())
    .bind(values.important)
    .bind(&values.tags)
    .bind(values.due_on)
    .bind(values.remind_at)
    .bind(&values.remind_timezone)
    .bind(&values.rank)
    .bind(values.series_id)
    .bind(&values.occurrence_key)
    .bind(
        values
            .recurrence
            .as_ref()
            .map(|value| SqlJson(value.clone())),
    )
    .bind(values.completed_at)
    .bind(server_seq)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

async fn update_task(
    tx: &mut Transaction<'_, Postgres>,
    user_id: Uuid,
    id: Uuid,
    values: &TaskValues,
    server_seq: i64,
    restoring: bool,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        r#"
        UPDATE tasks SET
            list_id = $3, title = $4, note = $5, status = $6, important = $7,
            tags = $8, due_on = $9, remind_at = $10, remind_timezone = $11, rank = $12,
            series_id = $13, occurrence_key = $14, recurrence = $15,
            completed_at = $16, deleted_at = CASE WHEN $17 THEN NULL ELSE deleted_at END,
            server_rev = $18, updated_at = now()
        WHERE user_id = $1 AND id = $2
        "#,
    )
    .bind(user_id)
    .bind(id)
    .bind(values.list_id)
    .bind(&values.title)
    .bind(&values.note)
    .bind(values.status.as_str())
    .bind(values.important)
    .bind(&values.tags)
    .bind(values.due_on)
    .bind(values.remind_at)
    .bind(&values.remind_timezone)
    .bind(&values.rank)
    .bind(values.series_id)
    .bind(&values.occurrence_key)
    .bind(
        values
            .recurrence
            .as_ref()
            .map(|value| SqlJson(value.clone())),
    )
    .bind(values.completed_at)
    .bind(restoring)
    .bind(server_seq)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

async fn select_step(
    tx: &mut Transaction<'_, Postgres>,
    user_id: Uuid,
    id: Uuid,
) -> Result<Option<StepRow>, sqlx::Error> {
    sqlx::query_as::<_, StepRow>(
        "SELECT task_id, title, is_completed, rank, deleted_at FROM steps \
         WHERE user_id = $1 AND id = $2 FOR UPDATE",
    )
    .bind(user_id)
    .bind(id)
    .fetch_optional(&mut **tx)
    .await
}

async fn update_step(
    tx: &mut Transaction<'_, Postgres>,
    user_id: Uuid,
    id: Uuid,
    values: &StepValues,
    server_seq: i64,
    restoring: bool,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "UPDATE steps SET task_id = $3, title = $4, is_completed = $5, rank = $6, \
         deleted_at = CASE WHEN $7 THEN NULL ELSE deleted_at END, \
         server_rev = $8, updated_at = now() WHERE user_id = $1 AND id = $2",
    )
    .bind(user_id)
    .bind(id)
    .bind(values.task_id)
    .bind(&values.title)
    .bind(values.is_completed)
    .bind(&values.rank)
    .bind(restoring)
    .bind(server_seq)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

async fn select_day_plan(
    tx: &mut Transaction<'_, Postgres>,
    user_id: Uuid,
    id: Uuid,
) -> Result<Option<DayPlanRow>, sqlx::Error> {
    sqlx::query_as::<_, DayPlanRow>(
        "SELECT task_id, local_date, rank, deleted_at FROM day_plans \
         WHERE user_id = $1 AND id = $2 FOR UPDATE",
    )
    .bind(user_id)
    .bind(id)
    .fetch_optional(&mut **tx)
    .await
}

async fn update_day_plan(
    tx: &mut Transaction<'_, Postgres>,
    user_id: Uuid,
    id: Uuid,
    values: &DayPlanValues,
    server_seq: i64,
    restoring: bool,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "UPDATE day_plans SET task_id = $3, local_date = $4, rank = $5, \
         deleted_at = CASE WHEN $6 THEN NULL ELSE deleted_at END, \
         server_rev = $7, updated_at = now() WHERE user_id = $1 AND id = $2",
    )
    .bind(user_id)
    .bind(id)
    .bind(values.task_id)
    .bind(values.local_date)
    .bind(&values.rank)
    .bind(restoring)
    .bind(server_seq)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

async fn ensure_active_list(
    tx: &mut Transaction<'_, Postgres>,
    user_id: Uuid,
    list_id: Option<Uuid>,
) -> Result<(), ApplyFailure> {
    let Some(list_id) = list_id else {
        return Ok(());
    };
    let row: Option<(Uuid,)> = sqlx::query_as(
        "SELECT id FROM lists WHERE user_id = $1 AND id = $2 AND deleted_at IS NULL",
    )
    .bind(user_id)
    .bind(list_id)
    .fetch_optional(&mut **tx)
    .await?;
    if row.is_none() {
        return Err(MutationError::invalid_parent(
            "list_id must reference an active list owned by this account",
        )
        .into());
    }
    Ok(())
}

async fn ensure_active_task(
    tx: &mut Transaction<'_, Postgres>,
    user_id: Uuid,
    task_id: Uuid,
) -> Result<(), ApplyFailure> {
    let row: Option<(Uuid,)> = sqlx::query_as(
        "SELECT id FROM tasks WHERE user_id = $1 AND id = $2 AND deleted_at IS NULL",
    )
    .bind(user_id)
    .bind(task_id)
    .fetch_optional(&mut **tx)
    .await?;
    if row.is_none() {
        return Err(MutationError::invalid_parent(
            "task_id must reference an active task owned by this account",
        )
        .into());
    }
    Ok(())
}

fn require_present_fields(patch: &Value, fields: &[&str]) -> Result<(), MutationError> {
    let object = patch
        .as_object()
        .ok_or_else(|| MutationError::validation("patch must be a JSON object"))?;
    for field in fields {
        if !object.contains_key(*field) {
            return Err(MutationError::validation(format!(
                "field {field:?} is required for create"
            )));
        }
    }
    Ok(())
}

fn ensure_empty_patch(patch: &Value) -> Result<(), MutationError> {
    match patch.as_object() {
        Some(object) if object.is_empty() => Ok(()),
        Some(_) => Err(MutationError::validation(
            "delete patches must be an empty object",
        )),
        None => Err(MutationError::validation("patch must be a JSON object")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mutation(client_seq: i64, op_id: Uuid) -> Mutation {
        Mutation {
            op_id,
            client_seq,
            entity: EntityType::Task,
            entity_id: Uuid::new_v4(),
            kind: MutationKind::Patch,
            patch: json!({"title": "x"}),
        }
    }

    #[test]
    fn batch_requires_strictly_increasing_client_sequences() {
        let ops = vec![mutation(2, Uuid::new_v4()), mutation(2, Uuid::new_v4())];
        assert!(validate_batch(&ops).is_err());
        let ops = vec![mutation(3, Uuid::new_v4()), mutation(2, Uuid::new_v4())];
        assert!(validate_batch(&ops).is_err());
        let ops = vec![mutation(1, Uuid::new_v4()), mutation(2, Uuid::new_v4())];
        assert!(validate_batch(&ops).is_ok());
    }

    #[test]
    fn batch_rejects_zero_and_duplicate_op_ids() {
        let op_id = Uuid::new_v4();
        assert!(validate_batch(&[mutation(0, op_id)]).is_err());
        assert!(validate_batch(&[mutation(1, op_id), mutation(2, op_id)]).is_err());
    }

    #[test]
    fn batch_is_limited_to_one_hundred_operations() {
        let ops: Vec<Mutation> = (1..=101).map(|seq| mutation(seq, Uuid::new_v4())).collect();
        assert!(validate_batch(&ops).is_err());
    }

    #[test]
    fn delete_patch_must_be_empty_object() {
        assert!(ensure_empty_patch(&json!({})).is_ok());
        assert!(ensure_empty_patch(&json!({"title": "x"})).is_err());
        assert!(ensure_empty_patch(&json!(null)).is_err());
    }

    #[test]
    fn entity_enum_serializes_snake_case() {
        assert_eq!(
            serde_json::to_value(EntityType::DayPlan).unwrap(),
            json!("day_plan")
        );
    }
}
