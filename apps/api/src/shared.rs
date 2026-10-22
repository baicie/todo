use axum::{
    Json, Router,
    body::Bytes,
    extract::{Path, State},
    http::{HeaderMap, StatusCode, header::IF_MATCH},
    response::{IntoResponse, Response},
    routing::{get, patch, post},
};
use chrono::{DateTime, NaiveDate, Utc};
use serde::{Deserialize, Deserializer, Serialize};
use sqlx::{FromRow, Postgres, Transaction};
use uuid::Uuid;

use crate::{
    auth::AuthUser,
    domain::TaskStatus,
    email::normalize_email,
    error::{ApiResult, AppError},
    extract::ApiJson,
    state::AppState,
};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/v1/shared/lists", get(list_lists).post(create_list))
        .route(
            "/api/v1/shared/lists/{list_id}",
            get(get_list).delete(delete_list),
        )
        .route("/api/v1/shared/lists/{list_id}/tasks", post(create_task))
        .route(
            "/api/v1/shared/lists/{list_id}/tasks/{task_id}",
            patch(patch_task).delete(delete_task),
        )
        .route("/api/v1/shared/lists/{list_id}/members", post(add_member))
        .route(
            "/api/v1/shared/lists/{list_id}/members/{user_id}",
            patch(patch_member).delete(remove_member),
        )
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SharedRole {
    Owner,
    Editor,
    Viewer,
}

impl SharedRole {
    fn parse(value: &str) -> Option<Self> {
        match value {
            "owner" => Some(Self::Owner),
            "editor" => Some(Self::Editor),
            "viewer" => Some(Self::Viewer),
            _ => None,
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::Owner => "owner",
            Self::Editor => "editor",
            Self::Viewer => "viewer",
        }
    }

    fn can_edit(self) -> bool {
        matches!(self, Self::Owner | Self::Editor)
    }

    fn is_owner(self) -> bool {
        self == Self::Owner
    }
}

#[derive(Debug, FromRow, Serialize)]
pub struct SharedListSummary {
    pub id: Uuid,
    pub owner_id: Uuid,
    pub name: String,
    pub color: Option<String>,
    pub icon: Option<String>,
    pub rank: String,
    pub revision: i64,
    pub role: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, FromRow, Serialize)]
pub struct SharedTask {
    pub id: Uuid,
    pub list_id: Uuid,
    pub title: String,
    pub note: String,
    pub status: String,
    pub important: bool,
    pub due_on: Option<NaiveDate>,
    pub rank: String,
    pub revision: i64,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, FromRow, Serialize)]
pub struct SharedStep {
    pub id: Uuid,
    pub task_id: Uuid,
    pub title: String,
    pub is_completed: bool,
    pub rank: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, FromRow, Serialize)]
pub struct SharedMember {
    pub user_id: Uuid,
    pub email: String,
    pub role: String,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Serialize)]
pub struct SharedSnapshot {
    pub list: SharedListSummary,
    pub members: Vec<SharedMember>,
    pub tasks: Vec<SharedTask>,
    pub steps: Vec<SharedStep>,
    pub revision: i64,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct CreateListRequest {
    name: String,
    color: Option<String>,
    icon: Option<String>,
    op_id: Option<Uuid>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct CreateTaskRequest {
    id: Option<Uuid>,
    title: String,
    note: Option<String>,
    important: Option<bool>,
    due_on: Option<NaiveDate>,
    revision: Option<i64>,
    op_id: Option<Uuid>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct PatchTaskRequest {
    title: Option<String>,
    note: Option<String>,
    status: Option<String>,
    important: Option<bool>,
    #[serde(default, deserialize_with = "double_option")]
    due_on: Option<Option<NaiveDate>>,
    revision: Option<i64>,
    op_id: Option<Uuid>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RevisionRequest {
    revision: Option<i64>,
    op_id: Option<Uuid>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct AddMemberRequest {
    email: String,
    role: String,
    revision: Option<i64>,
    op_id: Option<Uuid>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct PatchMemberRequest {
    role: String,
    revision: Option<i64>,
    op_id: Option<Uuid>,
}

struct SharedAccess {
    revision: i64,
    role: SharedRole,
}

async fn list_lists(
    State(state): State<AppState>,
    auth: AuthUser,
) -> ApiResult<Json<Vec<SharedListSummary>>> {
    let lists = sqlx::query_as::<_, SharedListSummary>(
        r#"
        SELECT l.id, l.owner_id, l.name, l.color, l.icon, l.rank, l.revision,
               m.role, l.created_at, l.updated_at
        FROM shared_lists l
        JOIN shared_list_members m ON m.list_id = l.id
        WHERE m.user_id = $1 AND m.deleted_at IS NULL AND l.deleted_at IS NULL
        ORDER BY l.updated_at DESC, l.id
        "#,
    )
    .bind(auth.user_id)
    .fetch_all(&state.pool)
    .await?;
    Ok(Json(lists))
}

async fn create_list(
    State(state): State<AppState>,
    auth: AuthUser,
    ApiJson(request): ApiJson<CreateListRequest>,
) -> ApiResult<Json<SharedListSummary>> {
    let name = validate_text("name", &request.name, 120)?;
    let color = validate_optional_text("color", request.color.as_deref(), 64)?;
    let icon = validate_optional_text("icon", request.icon.as_deref(), 128)?;
    let list_id = Uuid::new_v4();
    let mut tx = state.pool.begin().await?;
    sqlx::query(
        "INSERT INTO shared_lists (id, owner_id, name, color, icon) \
         VALUES ($1, $2, $3, $4, $5)",
    )
    .bind(list_id)
    .bind(auth.user_id)
    .bind(&name)
    .bind(&color)
    .bind(&icon)
    .execute(&mut *tx)
    .await?;
    sqlx::query(
        "INSERT INTO shared_list_members (list_id, user_id, role) VALUES ($1, $2, 'owner')",
    )
    .bind(list_id)
    .bind(auth.user_id)
    .execute(&mut *tx)
    .await?;
    insert_receipt(&mut tx, list_id, auth.user_id, request.op_id, 1).await?;
    tx.commit().await?;

    Ok(Json(SharedListSummary {
        id: list_id,
        owner_id: auth.user_id,
        name,
        color,
        icon,
        rank: "a0".to_owned(),
        revision: 1,
        role: SharedRole::Owner.as_str().to_owned(),
        created_at: Utc::now(),
        updated_at: Utc::now(),
    }))
}

async fn get_list(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(list_id): Path<String>,
) -> ApiResult<Json<SharedSnapshot>> {
    let list_id = parse_uuid("list_id", &list_id)?;
    let mut tx = state.pool.begin().await?;
    let _access = lock_access(&mut tx, list_id, auth.user_id).await?;
    let list = fetch_list_summary(&mut tx, list_id, auth.user_id).await?;
    let members = sqlx::query_as::<_, SharedMember>(
        "SELECT u.id AS user_id, u.email_normalized AS email, m.role, m.created_at \
         FROM shared_list_members m JOIN users u ON u.id = m.user_id \
         WHERE m.list_id = $1 AND m.deleted_at IS NULL AND u.deleted_at IS NULL \
         ORDER BY m.created_at, m.user_id",
    )
    .bind(list_id)
    .fetch_all(&mut *tx)
    .await?;
    let tasks = sqlx::query_as::<_, SharedTask>(
        "SELECT t.id, t.list_id, t.title, t.note, t.status, t.important, t.due_on, \
                t.rank, l.revision, t.created_at, t.updated_at \
         FROM shared_tasks t JOIN shared_lists l ON l.id = t.list_id \
         WHERE t.list_id = $1 AND t.deleted_at IS NULL \
         ORDER BY t.rank, t.created_at, t.id",
    )
    .bind(list_id)
    .fetch_all(&mut *tx)
    .await?;
    let steps = sqlx::query_as::<_, SharedStep>(
        "SELECT s.id, s.task_id, s.title, s.is_completed, s.rank, s.created_at, s.updated_at \
         FROM shared_steps s JOIN shared_tasks t ON t.id = s.task_id \
         WHERE t.list_id = $1 AND t.deleted_at IS NULL AND s.deleted_at IS NULL \
         ORDER BY s.task_id, s.rank, s.created_at, s.id",
    )
    .bind(list_id)
    .fetch_all(&mut *tx)
    .await?;
    tx.commit().await?;

    Ok(Json(SharedSnapshot {
        revision: list.revision,
        list,
        members,
        tasks,
        steps,
    }))
}

async fn create_task(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(list_id): Path<String>,
    headers: HeaderMap,
    ApiJson(request): ApiJson<CreateTaskRequest>,
) -> ApiResult<Response> {
    let list_id = parse_uuid("list_id", &list_id)?;
    let mut tx = state.pool.begin().await?;
    let access = lock_access(&mut tx, list_id, auth.user_id).await?;
    require_editor(access.role)?;
    if let Some(replayed_revision) =
        replay_receipt(&mut tx, list_id, request.op_id, auth.user_id).await?
    {
        if let Some(task_id) = request.id
            && let Ok(task) = fetch_task(&mut tx, list_id, task_id).await
        {
            return Ok(Json(task).into_response());
        }
        return Ok(Json(serde_json::json!({
            "replayed": true,
            "revision": replayed_revision
        }))
        .into_response());
    }
    let expected = expected_revision(&headers, request.revision)?;
    check_revision(access.revision, expected)?;

    let title = validate_text("title", &request.title, 1000)?;
    let note = validate_note(request.note.unwrap_or_default())?;
    let task_id = request.id.unwrap_or_else(Uuid::new_v4);
    let created_at = Utc::now();
    sqlx::query(
        "INSERT INTO shared_tasks \
         (id, list_id, title, note, status, important, due_on, rank, created_at, updated_at) \
         VALUES ($1, $2, $3, $4, 'open', $5, $6, 'a0', $7, $7)",
    )
    .bind(task_id)
    .bind(list_id)
    .bind(&title)
    .bind(&note)
    .bind(request.important.unwrap_or(false))
    .bind(request.due_on)
    .bind(created_at)
    .execute(&mut *tx)
    .await
    .map_err(map_task_insert_error)?;

    let new_revision = bump_revision(&mut tx, list_id, access.revision).await?;
    insert_receipt(&mut tx, list_id, auth.user_id, request.op_id, new_revision).await?;
    tx.commit().await?;

    Ok(Json(SharedTask {
        id: task_id,
        list_id,
        title,
        note,
        status: "open".to_owned(),
        important: request.important.unwrap_or(false),
        due_on: request.due_on,
        rank: "a0".to_owned(),
        revision: new_revision,
        created_at,
        updated_at: created_at,
    })
    .into_response())
}

async fn patch_task(
    State(state): State<AppState>,
    auth: AuthUser,
    Path((list_id, task_id)): Path<(String, String)>,
    headers: HeaderMap,
    ApiJson(request): ApiJson<PatchTaskRequest>,
) -> ApiResult<Response> {
    let list_id = parse_uuid("list_id", &list_id)?;
    let task_id = parse_uuid("task_id", &task_id)?;
    if request.title.is_none()
        && request.note.is_none()
        && request.status.is_none()
        && request.important.is_none()
        && request.due_on.is_none()
    {
        return Err(AppError::validation(
            "at least one task field must be supplied",
        ));
    }

    let mut tx = state.pool.begin().await?;
    let access = lock_access(&mut tx, list_id, auth.user_id).await?;
    require_editor(access.role)?;
    if let Some(_replayed_revision) =
        replay_receipt(&mut tx, list_id, request.op_id, auth.user_id).await?
    {
        let task = fetch_task(&mut tx, list_id, task_id).await?;
        return Ok(Json(task).into_response());
    }
    let expected = expected_revision(&headers, request.revision)?;
    check_revision(access.revision, expected)?;
    let row: Option<SharedTaskRow> = sqlx::query_as(
        "SELECT title, note, status, important, due_on \
         FROM shared_tasks WHERE id = $1 AND list_id = $2 AND deleted_at IS NULL FOR UPDATE",
    )
    .bind(task_id)
    .bind(list_id)
    .fetch_optional(&mut *tx)
    .await?;
    let Some(row) = row else {
        return Err(task_not_found());
    };

    let title = match request.title {
        Some(value) => validate_text("title", &value, 1000)?,
        None => row.title,
    };
    let note = match request.note {
        Some(value) => validate_note(value)?,
        None => row.note,
    };
    let status = match request.status {
        Some(value) => parse_task_status(&value)?,
        None => row.status,
    };
    let important = request.important.unwrap_or(row.important);
    let due_on = request.due_on.unwrap_or(row.due_on);
    sqlx::query(
        "UPDATE shared_tasks SET title = $3, note = $4, status = $5, \
         important = $6, due_on = $7, updated_at = now() \
         WHERE id = $1 AND list_id = $2",
    )
    .bind(task_id)
    .bind(list_id)
    .bind(&title)
    .bind(&note)
    .bind(&status)
    .bind(important)
    .bind(due_on)
    .execute(&mut *tx)
    .await?;
    let new_revision = bump_revision(&mut tx, list_id, access.revision).await?;
    insert_receipt(&mut tx, list_id, auth.user_id, request.op_id, new_revision).await?;
    let task = fetch_task(&mut tx, list_id, task_id).await?;
    tx.commit().await?;

    Ok(Json(task).into_response())
}

async fn delete_task(
    State(state): State<AppState>,
    auth: AuthUser,
    Path((list_id, task_id)): Path<(String, String)>,
    headers: HeaderMap,
    body: Bytes,
) -> ApiResult<StatusCode> {
    let request = revision_body(body)?;
    let list_id = parse_uuid("list_id", &list_id)?;
    let task_id = parse_uuid("task_id", &task_id)?;
    let mut tx = state.pool.begin().await?;
    let access = lock_access(&mut tx, list_id, auth.user_id).await?;
    require_editor(access.role)?;
    if replay_receipt(&mut tx, list_id, request.op_id, auth.user_id)
        .await?
        .is_some()
    {
        tx.commit().await?;
        return Ok(StatusCode::NO_CONTENT);
    }
    let expected = expected_revision(&headers, request.revision)?;
    check_revision(access.revision, expected)?;
    let result = sqlx::query(
        "UPDATE shared_tasks SET deleted_at = now(), updated_at = now() \
         WHERE id = $1 AND list_id = $2 AND deleted_at IS NULL",
    )
    .bind(task_id)
    .bind(list_id)
    .execute(&mut *tx)
    .await?;
    if result.rows_affected() == 0 {
        return Err(task_not_found());
    }
    let new_revision = bump_revision(&mut tx, list_id, access.revision).await?;
    insert_receipt(&mut tx, list_id, auth.user_id, request.op_id, new_revision).await?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn add_member(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(list_id): Path<String>,
    headers: HeaderMap,
    ApiJson(request): ApiJson<AddMemberRequest>,
) -> ApiResult<Response> {
    let list_id = parse_uuid("list_id", &list_id)?;
    let role = parse_role(&request.role)?;
    let email = normalize_email(&request.email)
        .map_err(|_| AppError::validation("email must be a valid email address"))?;
    let mut tx = state.pool.begin().await?;
    let access = lock_access(&mut tx, list_id, auth.user_id).await?;
    require_owner(access.role)?;
    if let Some(revision) = replay_receipt(&mut tx, list_id, request.op_id, auth.user_id).await? {
        return Ok(Json(serde_json::json!({
            "replayed": true,
            "revision": revision
        }))
        .into_response());
    }
    let expected = expected_revision(&headers, request.revision)?;
    check_revision(access.revision, expected)?;
    let target: Option<Uuid> = sqlx::query_scalar(
        "SELECT id FROM users WHERE email_normalized = $1 AND deleted_at IS NULL",
    )
    .bind(&email)
    .fetch_optional(&mut *tx)
    .await?;
    let Some(target_id) = target else {
        return Err(AppError::NotFound {
            code: "MEMBER_NOT_FOUND",
            message: "No registered account was found for that email".to_owned(),
        });
    };
    sqlx::query(
        "INSERT INTO shared_list_members (list_id, user_id, role) VALUES ($1, $2, $3) \
         ON CONFLICT (list_id, user_id) DO UPDATE SET role = EXCLUDED.role, deleted_at = NULL",
    )
    .bind(list_id)
    .bind(target_id)
    .bind(role.as_str())
    .execute(&mut *tx)
    .await?;
    let new_revision = bump_revision(&mut tx, list_id, access.revision).await?;
    insert_receipt(&mut tx, list_id, auth.user_id, request.op_id, new_revision).await?;
    let member = fetch_member(&mut tx, list_id, target_id).await?;
    tx.commit().await?;
    Ok(Json(member).into_response())
}

async fn patch_member(
    State(state): State<AppState>,
    auth: AuthUser,
    Path((list_id, user_id)): Path<(String, String)>,
    headers: HeaderMap,
    ApiJson(request): ApiJson<PatchMemberRequest>,
) -> ApiResult<Response> {
    let list_id = parse_uuid("list_id", &list_id)?;
    let target_id = parse_uuid("user_id", &user_id)?;
    let role = parse_role(&request.role)?;
    if target_id == auth.user_id && !role.is_owner() {
        return Err(AppError::validation(
            "the list owner cannot demote their own membership",
        ));
    }
    let mut tx = state.pool.begin().await?;
    let access = lock_access(&mut tx, list_id, auth.user_id).await?;
    require_owner(access.role)?;
    if replay_receipt(&mut tx, list_id, request.op_id, auth.user_id)
        .await?
        .is_some()
    {
        let member = fetch_member(&mut tx, list_id, target_id).await?;
        tx.commit().await?;
        return Ok(Json(member).into_response());
    }
    let expected = expected_revision(&headers, request.revision)?;
    check_revision(access.revision, expected)?;
    let result = sqlx::query(
        "UPDATE shared_list_members SET role = $3 \
         WHERE list_id = $1 AND user_id = $2 AND deleted_at IS NULL",
    )
    .bind(list_id)
    .bind(target_id)
    .bind(role.as_str())
    .execute(&mut *tx)
    .await?;
    if result.rows_affected() == 0 {
        return Err(member_not_found());
    }
    let new_revision = bump_revision(&mut tx, list_id, access.revision).await?;
    insert_receipt(&mut tx, list_id, auth.user_id, request.op_id, new_revision).await?;
    let member = fetch_member(&mut tx, list_id, target_id).await?;
    tx.commit().await?;
    Ok(Json(member).into_response())
}

async fn remove_member(
    State(state): State<AppState>,
    auth: AuthUser,
    Path((list_id, user_id)): Path<(String, String)>,
    headers: HeaderMap,
    body: Bytes,
) -> ApiResult<StatusCode> {
    let request = revision_body(body)?;
    let list_id = parse_uuid("list_id", &list_id)?;
    let target_id = parse_uuid("user_id", &user_id)?;
    if target_id == auth.user_id {
        return Err(AppError::validation(
            "the list owner cannot remove themselves",
        ));
    }
    let mut tx = state.pool.begin().await?;
    let access = lock_access(&mut tx, list_id, auth.user_id).await?;
    require_owner(access.role)?;
    if replay_receipt(&mut tx, list_id, request.op_id, auth.user_id)
        .await?
        .is_some()
    {
        tx.commit().await?;
        return Ok(StatusCode::NO_CONTENT);
    }
    let expected = expected_revision(&headers, request.revision)?;
    check_revision(access.revision, expected)?;
    let result = sqlx::query(
        "UPDATE shared_list_members SET deleted_at = now() \
         WHERE list_id = $1 AND user_id = $2 AND deleted_at IS NULL",
    )
    .bind(list_id)
    .bind(target_id)
    .execute(&mut *tx)
    .await?;
    if result.rows_affected() == 0 {
        return Err(member_not_found());
    }
    let new_revision = bump_revision(&mut tx, list_id, access.revision).await?;
    insert_receipt(&mut tx, list_id, auth.user_id, request.op_id, new_revision).await?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn delete_list(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(list_id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> ApiResult<StatusCode> {
    let request = revision_body(body)?;
    let list_id = parse_uuid("list_id", &list_id)?;
    let mut tx = state.pool.begin().await?;
    let access = lock_access(&mut tx, list_id, auth.user_id).await?;
    require_owner(access.role)?;
    if replay_receipt(&mut tx, list_id, request.op_id, auth.user_id)
        .await?
        .is_some()
    {
        tx.commit().await?;
        return Ok(StatusCode::NO_CONTENT);
    }
    let expected = expected_revision(&headers, request.revision)?;
    check_revision(access.revision, expected)?;
    let new_revision = bump_revision(&mut tx, list_id, access.revision).await?;
    sqlx::query("UPDATE shared_lists SET deleted_at = now(), updated_at = now() WHERE id = $1")
        .bind(list_id)
        .execute(&mut *tx)
        .await?;
    insert_receipt(&mut tx, list_id, auth.user_id, request.op_id, new_revision).await?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn lock_access(
    tx: &mut Transaction<'_, Postgres>,
    list_id: Uuid,
    user_id: Uuid,
) -> ApiResult<SharedAccess> {
    let row: Option<(i64, String)> = sqlx::query_as(
        "SELECT l.revision, m.role FROM shared_lists l \
         JOIN shared_list_members m ON m.list_id = l.id \
         WHERE l.id = $1 AND l.deleted_at IS NULL \
           AND m.user_id = $2 AND m.deleted_at IS NULL \
         FOR UPDATE OF l, m",
    )
    .bind(list_id)
    .bind(user_id)
    .fetch_optional(&mut **tx)
    .await?;
    let Some((revision, role)) = row else {
        return Err(list_not_found());
    };
    let role = SharedRole::parse(&role)
        .ok_or_else(|| AppError::Internal("stored shared role is invalid".to_owned()))?;
    Ok(SharedAccess { revision, role })
}

async fn fetch_list_summary(
    tx: &mut Transaction<'_, Postgres>,
    list_id: Uuid,
    user_id: Uuid,
) -> ApiResult<SharedListSummary> {
    sqlx::query_as::<_, SharedListSummary>(
        "SELECT l.id, l.owner_id, l.name, l.color, l.icon, l.rank, l.revision, \
                m.role, l.created_at, l.updated_at \
         FROM shared_lists l JOIN shared_list_members m ON m.list_id = l.id \
         WHERE l.id = $1 AND m.user_id = $2 AND m.deleted_at IS NULL \
           AND l.deleted_at IS NULL",
    )
    .bind(list_id)
    .bind(user_id)
    .fetch_optional(&mut **tx)
    .await?
    .ok_or_else(list_not_found)
}

async fn fetch_task(
    tx: &mut Transaction<'_, Postgres>,
    list_id: Uuid,
    task_id: Uuid,
) -> ApiResult<SharedTask> {
    sqlx::query_as::<_, SharedTask>(
        "SELECT t.id, t.list_id, t.title, t.note, t.status, t.important, t.due_on, \
                t.rank, l.revision, t.created_at, t.updated_at \
         FROM shared_tasks t JOIN shared_lists l ON l.id = t.list_id \
         WHERE t.id = $1 AND t.list_id = $2 AND t.deleted_at IS NULL",
    )
    .bind(task_id)
    .bind(list_id)
    .fetch_optional(&mut **tx)
    .await?
    .ok_or_else(task_not_found)
}

async fn fetch_member(
    tx: &mut Transaction<'_, Postgres>,
    list_id: Uuid,
    user_id: Uuid,
) -> ApiResult<SharedMember> {
    sqlx::query_as::<_, SharedMember>(
        "SELECT u.id AS user_id, u.email_normalized AS email, m.role, m.created_at \
         FROM shared_list_members m JOIN users u ON u.id = m.user_id \
         WHERE m.list_id = $1 AND m.user_id = $2 AND m.deleted_at IS NULL",
    )
    .bind(list_id)
    .bind(user_id)
    .fetch_optional(&mut **tx)
    .await?
    .ok_or_else(member_not_found)
}

async fn bump_revision(
    tx: &mut Transaction<'_, Postgres>,
    list_id: Uuid,
    current: i64,
) -> ApiResult<i64> {
    let next = current + 1;
    sqlx::query("UPDATE shared_lists SET revision = $1, updated_at = now() WHERE id = $2")
        .bind(next)
        .bind(list_id)
        .execute(&mut **tx)
        .await?;
    Ok(next)
}

async fn replay_receipt(
    tx: &mut Transaction<'_, Postgres>,
    list_id: Uuid,
    op_id: Option<Uuid>,
    actor_id: Uuid,
) -> ApiResult<Option<i64>> {
    let Some(op_id) = op_id else {
        return Ok(None);
    };
    let row: Option<(Uuid, i64)> = sqlx::query_as(
        "SELECT actor_id, revision FROM shared_op_receipts WHERE list_id = $1 AND op_id = $2",
    )
    .bind(list_id)
    .bind(op_id)
    .fetch_optional(&mut **tx)
    .await?;
    match row {
        Some((stored_actor, revision)) if stored_actor == actor_id => Ok(Some(revision)),
        Some(_) => Err(AppError::Conflict {
            code: "OP_ID_CONFLICT",
            message: "This operation id was used by another actor".to_owned(),
        }),
        None => Ok(None),
    }
}

async fn insert_receipt(
    tx: &mut Transaction<'_, Postgres>,
    list_id: Uuid,
    actor_id: Uuid,
    op_id: Option<Uuid>,
    revision: i64,
) -> ApiResult<()> {
    let op_id = op_id.unwrap_or_else(Uuid::new_v4);
    sqlx::query(
        "INSERT INTO shared_op_receipts (list_id, op_id, actor_id, revision, status) \
         VALUES ($1, $2, $3, $4, 'applied')",
    )
    .bind(list_id)
    .bind(op_id)
    .bind(actor_id)
    .bind(revision)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

fn require_editor(role: SharedRole) -> ApiResult<()> {
    if role.can_edit() {
        Ok(())
    } else {
        Err(AppError::Forbidden {
            code: "SHARED_LIST_FORBIDDEN",
            message: "Editor access is required for this shared list".to_owned(),
        })
    }
}

fn require_owner(role: SharedRole) -> ApiResult<()> {
    if role.is_owner() {
        Ok(())
    } else {
        Err(AppError::Forbidden {
            code: "SHARED_LIST_FORBIDDEN",
            message: "Owner access is required for this shared list".to_owned(),
        })
    }
}

fn expected_revision(headers: &HeaderMap, body_revision: Option<i64>) -> ApiResult<i64> {
    let header_revision = match headers.get(IF_MATCH) {
        Some(value) => {
            let value = value
                .to_str()
                .map_err(|_| AppError::validation("If-Match must be an integer revision"))?
                .trim()
                .trim_start_matches("W/")
                .trim_matches('"');
            Some(
                value
                    .parse::<i64>()
                    .map_err(|_| AppError::validation("If-Match must be an integer revision"))?,
            )
        }
        None => None,
    };
    if let (Some(header), Some(body)) = (header_revision, body_revision)
        && header != body
    {
        return Err(AppError::validation(
            "If-Match and body revision must agree",
        ));
    }
    let revision = header_revision
        .or(body_revision)
        .ok_or_else(|| AppError::BadRequest {
            code: "REVISION_REQUIRED",
            message: "Provide If-Match or a revision in the request body".to_owned(),
        })?;
    if revision <= 0 {
        return Err(AppError::validation("revision must be positive"));
    }
    Ok(revision)
}

fn check_revision(current: i64, expected: i64) -> ApiResult<()> {
    if current != expected {
        return Err(AppError::revision_conflict(current));
    }
    Ok(())
}

fn parse_uuid(name: &str, value: &str) -> ApiResult<Uuid> {
    Uuid::parse_str(value).map_err(|_| AppError::validation(format!("{name} must be a UUID")))
}

fn revision_body(body: Bytes) -> ApiResult<RevisionRequest> {
    if body.is_empty() {
        return Ok(RevisionRequest {
            revision: None,
            op_id: None,
        });
    }
    serde_json::from_slice(&body).map_err(|_| {
        AppError::validation("Request body must be valid JSON matching the endpoint schema")
    })
}

fn double_option<'de, D, T>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer).map(Some)
}

fn validate_text(name: &str, value: &str, max: usize) -> ApiResult<String> {
    let value = value.trim();
    if value.is_empty() || value.chars().count() > max {
        return Err(AppError::validation(format!(
            "{name} must contain 1–{max} characters"
        )));
    }
    Ok(value.to_owned())
}

fn validate_note(value: String) -> ApiResult<String> {
    if value.len() > 100_000 {
        return Err(AppError::validation("note is too long"));
    }
    Ok(value)
}

fn validate_optional_text(
    name: &str,
    value: Option<&str>,
    max: usize,
) -> ApiResult<Option<String>> {
    match value.map(str::trim).filter(|value| !value.is_empty()) {
        Some(value) if value.chars().count() <= max => Ok(Some(value.to_owned())),
        Some(_) => Err(AppError::validation(format!(
            "{name} must be at most {max} characters"
        ))),
        None => Ok(None),
    }
}

fn parse_role(value: &str) -> ApiResult<SharedRole> {
    SharedRole::parse(value)
        .ok_or_else(|| AppError::validation("role must be owner, editor, or viewer"))
}

fn parse_task_status(value: &str) -> ApiResult<String> {
    TaskStatus::parse(value)
        .map(|status| status.as_str().to_owned())
        .ok_or_else(|| AppError::validation("status must be open or completed"))
}

fn list_not_found() -> AppError {
    AppError::NotFound {
        code: "SHARED_LIST_NOT_FOUND",
        message: "The shared list was not found".to_owned(),
    }
}

fn task_not_found() -> AppError {
    AppError::NotFound {
        code: "SHARED_TASK_NOT_FOUND",
        message: "The shared task was not found".to_owned(),
    }
}

fn member_not_found() -> AppError {
    AppError::NotFound {
        code: "SHARED_MEMBER_NOT_FOUND",
        message: "The shared list member was not found".to_owned(),
    }
}

fn map_task_insert_error(error: sqlx::Error) -> AppError {
    if let sqlx::Error::Database(database_error) = &error
        && database_error.is_unique_violation()
    {
        return AppError::Conflict {
            code: "SHARED_TASK_EXISTS",
            message: "A shared task with that id already exists".to_owned(),
        };
    }
    AppError::from(error)
}

#[derive(Debug, FromRow)]
struct SharedTaskRow {
    title: String,
    note: String,
    status: String,
    important: bool,
    due_on: Option<NaiveDate>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn role_hierarchy_is_strict() {
        assert!(SharedRole::Owner.can_edit());
        assert!(SharedRole::Editor.can_edit());
        assert!(!SharedRole::Viewer.can_edit());
        assert!(SharedRole::Owner.is_owner());
    }

    #[test]
    fn revision_header_parses_quotes_and_weak_etags() {
        let mut headers = HeaderMap::new();
        headers.insert(IF_MATCH, "\"7\"".parse().unwrap());
        assert_eq!(expected_revision(&headers, None).unwrap(), 7);
        headers.insert(IF_MATCH, "W/\"8\"".parse().unwrap());
        assert_eq!(expected_revision(&headers, None).unwrap(), 8);
        assert!(expected_revision(&HeaderMap::new(), None).is_err());
        assert!(expected_revision(&headers, Some(7)).is_err());
    }

    #[test]
    fn role_parser_rejects_unknown_values() {
        assert_eq!(parse_role("owner").unwrap(), SharedRole::Owner);
        assert!(parse_role("admin").is_err());
    }
}
