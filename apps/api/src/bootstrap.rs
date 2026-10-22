use axum::{Json, Router, extract::State, routing::get};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

use crate::{
    auth::{AuthUser, continuation::ContinuationError},
    cursor::parse_page_limit,
    domain::EntityType,
    error::{ApiResult, AppError},
    extract::ApiQuery,
    state::AppState,
};

pub fn router() -> Router<AppState> {
    Router::new().route("/api/v1/sync/bootstrap", get(bootstrap))
}

#[derive(Debug, Deserialize)]
struct BootstrapQuery {
    continuation: Option<String>,
    limit: Option<u32>,
}

#[derive(Debug, Serialize)]
struct BootstrapEntity {
    entity: EntityType,
    entity_id: Uuid,
    data: Value,
}

#[derive(Debug, Serialize)]
struct BootstrapPage {
    entities: Vec<BootstrapEntity>,
    snapshot_cursor: String,
    next_page: Option<String>,
    has_more: bool,
}

async fn bootstrap(
    State(state): State<AppState>,
    auth: AuthUser,
    ApiQuery(query): ApiQuery<BootstrapQuery>,
) -> ApiResult<Json<BootstrapPage>> {
    let limit = parse_page_limit(query.limit, 500, 500)
        .map_err(|_| AppError::validation("limit must be between 1 and 500"))?;

    let continuation = match query.continuation.as_deref() {
        Some(token) => Some(
            state
                .continuation
                .verify(token, auth.user_id)
                .map_err(map_continuation_error)?,
        ),
        None => None,
    };

    let (snapshot_cursor, snapshot_at, last_entity, last_id) = match continuation {
        Some(continuation) => (
            continuation.snapshot_cursor,
            continuation.snapshot_at,
            continuation.last_entity,
            continuation.last_id,
        ),
        None => {
            sqlx::query(
                "INSERT INTO account_sync_state (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING",
            )
            .bind(auth.user_id)
            .execute(&state.pool)
            .await?;
            let (next_server_seq, snapshot_at): (i64, DateTime<Utc>) = sqlx::query_as(
                "SELECT next_server_seq, clock_timestamp() FROM account_sync_state WHERE user_id = $1",
            )
            .bind(auth.user_id)
            .fetch_one(&state.pool)
            .await?;
            (next_server_seq - 1, snapshot_at, None, None)
        }
    };

    let last_entity_text = last_entity.map(EntityType::as_str);
    let rows: Vec<(String, Uuid, Value)> = sqlx::query_as(
        r#"
        SELECT entity_type, entity_id, data
        FROM (
            SELECT 'list'::text AS entity_type, id AS entity_id,
                   jsonb_build_object(
                       'id', id, 'name', name, 'color', color, 'icon', icon,
                       'rank', rank, 'server_rev', server_rev,
                       'created_at', created_at, 'updated_at', updated_at,
                       'deleted_at', deleted_at
                   ) AS data
            FROM lists
            WHERE user_id = $1 AND created_at <= $2
            UNION ALL
            SELECT 'task'::text AS entity_type, id AS entity_id,
                   jsonb_build_object(
                       'id', id, 'list_id', list_id, 'title', title, 'note', note,
                       'status', status, 'important', important, 'tags', tags,
                       'due_on', due_on,
                       'remind_at', remind_at, 'remind_timezone', remind_timezone,
                       'rank', rank, 'series_id', series_id, 'occurrence_key', occurrence_key,
                       'recurrence', recurrence, 'completed_at', completed_at,
                       'server_rev', server_rev, 'created_at', created_at,
                       'updated_at', updated_at, 'deleted_at', deleted_at
                   ) AS data
            FROM tasks
            WHERE user_id = $1 AND created_at <= $2
            UNION ALL
            SELECT 'step'::text AS entity_type, id AS entity_id,
                   jsonb_build_object(
                       'id', id, 'task_id', task_id, 'title', title,
                       'is_completed', is_completed, 'rank', rank,
                       'server_rev', server_rev, 'created_at', created_at,
                       'updated_at', updated_at, 'deleted_at', deleted_at
                   ) AS data
            FROM steps
            WHERE user_id = $1 AND created_at <= $2
            UNION ALL
            SELECT 'day_plan'::text AS entity_type, id AS entity_id,
                   jsonb_build_object(
                       'id', id, 'task_id', task_id, 'local_date', local_date,
                       'rank', rank, 'server_rev', server_rev,
                       'created_at', created_at, 'updated_at', updated_at,
                       'deleted_at', deleted_at
                   ) AS data
            FROM day_plans
            WHERE user_id = $1 AND created_at <= $2
        ) AS page
        WHERE (
            $3::text IS NULL
            OR (entity_type, entity_id) > ($3::text, $4::uuid)
        )
        ORDER BY entity_type, entity_id
        LIMIT $5
        "#,
    )
    .bind(auth.user_id)
    .bind(snapshot_at)
    .bind(last_entity_text)
    .bind(last_id)
    .bind(i64::from(limit) + 1)
    .fetch_all(&state.pool)
    .await?;

    let has_more = rows.len() > limit as usize;
    let mut entities = Vec::with_capacity(rows.len().min(limit as usize));
    for (entity_type, entity_id, data) in rows.into_iter().take(limit as usize) {
        let entity = EntityType::parse(&entity_type).ok_or_else(|| {
            AppError::Internal(format!("unknown entity type {entity_type:?} in bootstrap"))
        })?;
        entities.push(BootstrapEntity {
            entity,
            entity_id,
            data,
        });
    }

    let next_page = if has_more {
        let last = entities
            .last()
            .ok_or_else(|| AppError::Internal("missing snapshot page position".to_owned()))?;
        Some(state.continuation.issue(
            auth.user_id,
            snapshot_cursor,
            snapshot_at,
            Some(last.entity),
            Some(last.entity_id),
        ))
    } else {
        None
    };

    Ok(Json(BootstrapPage {
        entities,
        snapshot_cursor: snapshot_cursor.to_string(),
        next_page,
        has_more,
    }))
}

fn map_continuation_error(error: ContinuationError) -> AppError {
    match error {
        ContinuationError::Expired => AppError::BadRequest {
            code: "CONTINUATION_EXPIRED",
            message: "The bootstrap continuation expired; restart bootstrap".to_owned(),
        },
        ContinuationError::Invalid => AppError::BadRequest {
            code: "INVALID_CONTINUATION",
            message: "The bootstrap continuation is invalid".to_owned(),
        },
    }
}
