use axum::{Json, Router, extract::State, routing::get};
use chrono::Utc;
use serde_json::{Value, json};

use crate::{auth::AuthUser, error::ApiResult, state::AppState};

pub fn router() -> Router<AppState> {
    Router::new().route("/api/v1/export", get(export_account))
}

async fn export_account(State(state): State<AppState>, auth: AuthUser) -> ApiResult<Json<Value>> {
    let mut tx = state.pool.begin().await?;
    sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY")
        .execute(&mut *tx)
        .await?;

    let user: Option<Value> = sqlx::query_scalar(
        r#"
        SELECT jsonb_build_object(
            'id', id,
            'email', email_normalized,
            'preferred_timezone', preferred_timezone,
            'created_at', created_at
        )
        FROM users
        WHERE id = $1 AND deleted_at IS NULL
        "#,
    )
    .bind(auth.user_id)
    .fetch_optional(&mut *tx)
    .await?;
    let Some(user) = user else {
        tx.rollback().await?;
        return Err(crate::error::AppError::unauthorized());
    };

    let snapshot_cursor: Option<i64> =
        sqlx::query_scalar("SELECT next_server_seq - 1 FROM account_sync_state WHERE user_id = $1")
            .bind(auth.user_id)
            .fetch_optional(&mut *tx)
            .await?;

    let lists: Value = sqlx::query_scalar(
        r#"
        SELECT COALESCE(jsonb_agg(jsonb_build_object(
            'id', id, 'name', name, 'color', color, 'icon', icon, 'rank', rank,
            'server_rev', server_rev, 'created_at', created_at,
            'updated_at', updated_at
        ) ORDER BY rank, id), '[]'::jsonb)
        FROM lists WHERE user_id = $1 AND deleted_at IS NULL
        "#,
    )
    .bind(auth.user_id)
    .fetch_one(&mut *tx)
    .await?;

    let tasks: Value = sqlx::query_scalar(
        r#"
        SELECT COALESCE(jsonb_agg(jsonb_build_object(
            'id', id, 'list_id', list_id, 'title', title, 'note', note,
            'status', status, 'important', important, 'tags', tags,
            'due_on', due_on,
            'remind_at', remind_at, 'remind_timezone', remind_timezone,
            'rank', rank, 'series_id', series_id, 'occurrence_key', occurrence_key,
            'recurrence', recurrence, 'completed_at', completed_at,
            'server_rev', server_rev, 'created_at', created_at, 'updated_at', updated_at
        ) ORDER BY created_at, id), '[]'::jsonb)
        FROM tasks WHERE user_id = $1 AND deleted_at IS NULL
        "#,
    )
    .bind(auth.user_id)
    .fetch_one(&mut *tx)
    .await?;

    let steps: Value = sqlx::query_scalar(
        r#"
        SELECT COALESCE(jsonb_agg(jsonb_build_object(
            'id', id, 'task_id', task_id, 'title', title, 'is_completed', is_completed,
            'rank', rank, 'server_rev', server_rev, 'created_at', created_at,
            'updated_at', updated_at
        ) ORDER BY task_id, rank, id), '[]'::jsonb)
        FROM steps WHERE user_id = $1 AND deleted_at IS NULL
        "#,
    )
    .bind(auth.user_id)
    .fetch_one(&mut *tx)
    .await?;

    let day_plans: Value = sqlx::query_scalar(
        r#"
        SELECT COALESCE(jsonb_agg(jsonb_build_object(
            'id', id, 'task_id', task_id, 'local_date', local_date, 'rank', rank,
            'server_rev', server_rev, 'created_at', created_at, 'updated_at', updated_at
        ) ORDER BY local_date, rank, id), '[]'::jsonb)
        FROM day_plans WHERE user_id = $1 AND deleted_at IS NULL
        "#,
    )
    .bind(auth.user_id)
    .fetch_one(&mut *tx)
    .await?;

    tx.commit().await?;

    Ok(Json(json!({
        "format": "todo-account-export",
        "format_version": 1,
        "exported_at": Utc::now(),
        "snapshot_cursor": snapshot_cursor.unwrap_or(0).to_string(),
        "user": user,
        "lists": lists,
        "tasks": tasks,
        "steps": steps,
        "day_plans": day_plans
    })))
}
