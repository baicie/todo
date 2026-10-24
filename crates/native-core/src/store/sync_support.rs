use std::collections::{BTreeMap, HashMap, HashSet};

use serde::Serialize;
use serde_json::{Map, Value, json};

use super::*;

#[derive(Debug, Clone)]
struct OutboxRow {
    entity: String,
    entity_id: String,
    kind: String,
    patch: Value,
}

pub(super) fn assert_sync_session(
    connection: &Connection,
    expected: Option<&str>,
) -> StoreResult<()> {
    if let Some(expected) = expected
        && kv_string(connection, "sync_session").as_deref() != Some(expected)
    {
        return Err(StoreError::StaleSyncSession);
    }
    Ok(())
}

#[derive(Debug, Clone)]
struct PreparedOp {
    entity: &'static str,
    entity_id: String,
    kind: &'static str,
    patch: Value,
}

struct LocalEntities {
    lists: Vec<TaskList>,
    tasks: Vec<Task>,
    steps: Vec<Step>,
    day_plans: Vec<DayPlan>,
}

impl TodoStore {
    /// Bind or clear the local sync session token. Server responses carry the
    /// token they were requested under; a mismatch is rejected inside the same
    /// transaction as the shadow/outbox mutation.
    pub fn sync_set_session(&self, session_id: Option<&str>) -> StoreResult<()> {
        let connection = self.lock()?;
        match session_id {
            Some(value) => {
                connection.execute(
                    "INSERT INTO kv_state (key, value) VALUES ('sync_session', ?1)
                     ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                    [value],
                )?;
            }
            None => {
                connection.execute("DELETE FROM kv_state WHERE key = 'sync_session'", [])?;
            }
        }
        Ok(())
    }

    /// Clear the fence only when it still belongs to the caller's session.
    /// A delayed logout from session A must never delete session B's token.
    pub fn sync_clear_session_if(&self, expected_session_id: Option<&str>) -> StoreResult<()> {
        let Some(expected_session_id) = expected_session_id else {
            return Ok(());
        };
        let mut connection = self.lock()?;
        let transaction = connection.transaction()?;
        if kv_string(&transaction, "sync_session").as_deref() != Some(expected_session_id) {
            return Ok(());
        }
        transaction.execute("DELETE FROM kv_state WHERE key = 'sync_session'", [])?;
        transaction.commit()?;
        Ok(())
    }

    // ------------------------------------------------------------------
    // Device and sync identity
    // ------------------------------------------------------------------

    pub fn rotate_device_id(&self) -> StoreResult<String> {
        let mut connection = self.lock()?;
        let transaction = connection.transaction()?;
        let device_id = Uuid::now_v7().to_string();
        let op_ids = {
            let mut statement =
                transaction.prepare("SELECT op_id FROM outbox ORDER BY client_seq, created_at")?;
            statement
                .query_map([], |row| row.get::<_, String>(0))?
                .collect::<Result<Vec<_>, _>>()?
        };
        for (index, op_id) in op_ids.iter().enumerate() {
            transaction.execute(
                "UPDATE outbox
                 SET device_id = ?1, client_seq = ?2, sync_status = 'local', error_code = NULL
                 WHERE op_id = ?3",
                params![device_id, (index + 1) as i64, op_id],
            )?;
        }
        kv_set(&transaction, "device_id", &device_id)?;
        kv_set(&transaction, "client_seq", "0")?;
        kv_set(&transaction, "sync_cursor", "0")?;
        kv_set(&transaction, "sync_enabled", "false")?;
        kv_set(&transaction, "bootstrap_required", "0")?;
        transaction.commit()?;
        Ok(device_id)
    }

    pub fn sync_diagnostics(&self) -> StoreResult<SyncDiagnostics> {
        let connection = self.lock()?;
        let enabled = kv_string(&connection, "sync_enabled")
            .map(|value| value == "true")
            .unwrap_or(false);
        let device_id = kv_string(&connection, "device_id").unwrap_or_default();
        let cursor = kv_string(&connection, "sync_cursor").unwrap_or_else(|| "0".to_owned());
        let bound_account =
            kv_string(&connection, "bound_account").filter(|value| !value.is_empty());
        let bound_api_url =
            kv_string(&connection, "bound_api_url").filter(|value| !value.is_empty());
        let pending: i64 = connection.query_row(
            "SELECT COUNT(*) FROM outbox WHERE sync_status = 'pending'",
            [],
            |row| row.get(0),
        )?;
        let rejected: i64 = connection.query_row(
            "SELECT COUNT(*) FROM outbox WHERE sync_status = 'rejected'",
            [],
            |row| row.get(0),
        )?;
        Ok(SyncDiagnostics {
            enabled,
            device_id,
            cursor,
            pending,
            rejected,
            bound_account,
            bound_api_url,
        })
    }

    pub fn sync_set_enabled(&self, enabled: bool) -> StoreResult<()> {
        let mut connection = self.lock()?;
        let transaction = connection.transaction()?;
        if enabled {
            transaction.execute(
                "UPDATE outbox SET sync_status = 'pending' WHERE sync_status = 'local'",
                [],
            )?;
        } else {
            transaction.execute(
                "UPDATE outbox SET sync_status = 'local' WHERE sync_status = 'pending'",
                [],
            )?;
        }
        kv_set(
            &transaction,
            "sync_enabled",
            if enabled { "true" } else { "false" },
        )?;
        transaction.commit()?;
        Ok(())
    }

    pub fn sync_clear_account_binding(&self) -> StoreResult<()> {
        let mut connection = self.lock()?;
        let transaction = connection.transaction()?;
        transaction.execute("DELETE FROM outbox", [])?;
        kv_delete(&transaction, "bound_account")?;
        kv_delete(&transaction, "bound_api_url")?;
        kv_set(&transaction, "sync_enabled", "false")?;
        kv_set(&transaction, "sync_cursor", "0")?;
        kv_set(&transaction, "client_seq", "0")?;
        kv_set(&transaction, "bootstrap_required", "0")?;
        transaction.commit()?;
        Ok(())
    }

    pub fn sync_clear_rejected(&self) -> StoreResult<()> {
        let mut connection = self.lock()?;
        let transaction = connection.transaction()?;
        let rejected = {
            let mut statement = transaction.prepare(
                "SELECT entity_type, entity_id FROM outbox
                 WHERE sync_status = 'rejected' ORDER BY client_seq",
            )?;
            statement
                .query_map([], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })?
                .collect::<Result<Vec<_>, _>>()?
        };
        if rejected.is_empty() {
            return Ok(());
        }
        transaction.execute("DELETE FROM outbox WHERE sync_status = 'rejected'", [])?;
        let now = now();
        reproject_entities(&transaction, rejected, &now)?;
        transaction.commit()?;
        Ok(())
    }
}

// ----------------------------------------------------------------------
// Projection helpers shared by rejected cleanup and snapshot rebases
// ----------------------------------------------------------------------

fn kv_string(connection: &Connection, key: &str) -> Option<String> {
    connection
        .query_row("SELECT value FROM kv_state WHERE key = ?1", [key], |row| {
            row.get(0)
        })
        .optional()
        .ok()
        .flatten()
}

fn kv_set(connection: &Connection, key: &str, value: &str) -> StoreResult<()> {
    connection.execute(
        "INSERT INTO kv_state (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )?;
    Ok(())
}

fn kv_delete(connection: &Connection, key: &str) -> StoreResult<()> {
    connection.execute("DELETE FROM kv_state WHERE key = ?1", [key])?;
    Ok(())
}

fn entity_order(entity: &str) -> u8 {
    match entity {
        "list" => 0,
        "task" => 1,
        "step" => 2,
        "day_plan" => 3,
        _ => 4,
    }
}

fn mutable_fields(entity: &str) -> &'static [&'static str] {
    match entity {
        "task" => &[
            "listId",
            "title",
            "note",
            "tags",
            "status",
            "important",
            "dueOn",
            "remindAt",
            "remindTimezone",
            "rank",
            "seriesId",
            "occurrenceKey",
            "recurrence",
            "completedAt",
        ],
        "list" => &["name", "color", "icon", "rank"],
        "step" => &["taskId", "title", "isCompleted", "rank"],
        "day_plan" => &["taskId", "localDate", "rank"],
        _ => &[],
    }
}

fn as_object(value: Value) -> Map<String, Value> {
    value.as_object().cloned().unwrap_or_default()
}

fn entity_data<T: Serialize>(value: &T) -> StoreResult<Map<String, Value>> {
    Ok(as_object(serde_json::to_value(value)?))
}

fn local_entities(transaction: &Transaction<'_>) -> StoreResult<LocalEntities> {
    let lists = {
        let mut statement =
            transaction.prepare(&format!("SELECT {LIST_COLUMNS} FROM local_lists"))?;
        statement
            .query_map([], row_to_list)?
            .collect::<Result<Vec<_>, _>>()?
    };
    let tasks = {
        let mut statement =
            transaction.prepare(&format!("SELECT {TASK_COLUMNS} FROM local_tasks"))?;
        statement
            .query_map([], row_to_task)?
            .collect::<Result<Vec<_>, _>>()?
    };
    let steps = {
        let mut statement =
            transaction.prepare(&format!("SELECT {STEP_COLUMNS} FROM local_steps"))?;
        statement
            .query_map([], row_to_step)?
            .collect::<Result<Vec<_>, _>>()?
    };
    let day_plans = {
        let mut statement =
            transaction.prepare(&format!("SELECT {DAY_PLAN_COLUMNS} FROM local_day_plans"))?;
        statement
            .query_map([], row_to_day_plan)?
            .collect::<Result<Vec<_>, _>>()?
    };
    Ok(LocalEntities {
        lists,
        tasks,
        steps,
        day_plans,
    })
}

fn full_patch(entity: &str, value: &Value) -> Value {
    let source = value.as_object();
    let mut patch = Map::new();
    if let Some(source) = source {
        for field in mutable_fields(entity) {
            if let Some(value) = source.get(*field) {
                patch.insert((*field).to_owned(), value.clone());
            }
        }
    }
    Value::Object(patch)
}

fn apply_mutation_to_data(
    entity: &str,
    base: &Map<String, Value>,
    mutation: &OutboxRow,
    now: &str,
) -> Map<String, Value> {
    let mut data = if mutation.kind == "create" {
        let mut data = Map::new();
        data.insert("id".to_owned(), Value::String(mutation.entity_id.clone()));
        data.insert("createdAt".to_owned(), Value::String(now.to_owned()));
        data
    } else {
        let mut data = base.clone();
        data.insert("id".to_owned(), Value::String(mutation.entity_id.clone()));
        data
    };
    if mutation.kind == "delete" {
        data.insert("deletedAt".to_owned(), Value::String(now.to_owned()));
        data.insert("updatedAt".to_owned(), Value::String(now.to_owned()));
        return data;
    }
    if mutation.kind == "restore" {
        data.insert("deletedAt".to_owned(), Value::Null);
    }
    if let Some(patch) = mutation.patch.as_object() {
        for field in mutable_fields(entity) {
            if let Some(value) = patch.get(*field) {
                data.insert((*field).to_owned(), value.clone());
            }
        }
    }
    data.insert("updatedAt".to_owned(), Value::String(now.to_owned()));
    data
}

fn string_field(data: &Map<String, Value>, key: &str) -> Option<String> {
    data.get(key).and_then(Value::as_str).map(str::to_owned)
}

pub(super) fn tags_from_data(data: &Map<String, Value>) -> Vec<String> {
    data.get("tags")
        .and_then(Value::as_array)
        .map(|values| {
            values
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

fn nullable_string(data: &Map<String, Value>, key: &str) -> Option<String> {
    string_field(data, key).filter(|value| !value.is_empty())
}

fn required_string(data: &Map<String, Value>, key: &str, fallback: &str) -> String {
    string_field(data, key)
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| fallback.to_owned())
}

fn bool_field(data: &Map<String, Value>, key: &str) -> bool {
    data.get(key).and_then(Value::as_bool).unwrap_or(false)
}

fn date_field(data: &Map<String, Value>, key: &str) -> Option<String> {
    let value = string_field(data, key)?;
    NaiveDate::parse_from_str(&value, "%Y-%m-%d")
        .ok()
        .map(|_| value)
}

fn task_from_data(id: &str, data: &Map<String, Value>, now: &str) -> Task {
    Task {
        id: id.to_owned(),
        list_id: nullable_string(data, "listId"),
        title: required_string(data, "title", "未命名任务"),
        note: string_field(data, "note").unwrap_or_default(),
        tags: tags_from_data(data),
        status: string_field(data, "status")
            .as_deref()
            .and_then(TaskStatus::parse)
            .unwrap_or(TaskStatus::Open),
        important: bool_field(data, "important"),
        due_on: date_field(data, "dueOn"),
        remind_at: nullable_string(data, "remindAt"),
        remind_timezone: nullable_string(data, "remindTimezone"),
        rank: required_string(data, "rank", "a0"),
        series_id: nullable_string(data, "seriesId"),
        occurrence_key: nullable_string(data, "occurrenceKey"),
        recurrence: data
            .get("recurrence")
            .filter(|value| value.is_object())
            .cloned(),
        completed_at: nullable_string(data, "completedAt"),
        created_at: string_field(data, "createdAt").unwrap_or_else(|| now.to_owned()),
        updated_at: string_field(data, "updatedAt").unwrap_or_else(|| now.to_owned()),
        deleted_at: nullable_string(data, "deletedAt"),
    }
}

fn list_from_data(id: &str, data: &Map<String, Value>, now: &str) -> TaskList {
    TaskList {
        id: id.to_owned(),
        name: required_string(data, "name", "未命名清单"),
        color: nullable_string(data, "color"),
        icon: nullable_string(data, "icon"),
        rank: required_string(data, "rank", "a0"),
        created_at: string_field(data, "createdAt").unwrap_or_else(|| now.to_owned()),
        updated_at: string_field(data, "updatedAt").unwrap_or_else(|| now.to_owned()),
        deleted_at: nullable_string(data, "deletedAt"),
    }
}

fn step_from_data(id: &str, data: &Map<String, Value>, now: &str) -> Step {
    Step {
        id: id.to_owned(),
        task_id: required_string(data, "taskId", ""),
        title: string_field(data, "title").unwrap_or_default(),
        is_completed: bool_field(data, "isCompleted"),
        rank: required_string(data, "rank", "a0"),
        created_at: string_field(data, "createdAt").unwrap_or_else(|| now.to_owned()),
        updated_at: string_field(data, "updatedAt").unwrap_or_else(|| now.to_owned()),
        deleted_at: nullable_string(data, "deletedAt"),
    }
}

fn day_plan_from_data(id: &str, data: &Map<String, Value>, now: &str) -> DayPlan {
    DayPlan {
        id: id.to_owned(),
        task_id: required_string(data, "taskId", ""),
        local_date: date_field(data, "localDate").unwrap_or_else(|| "1970-01-01".to_owned()),
        rank: required_string(data, "rank", "a0"),
        created_at: string_field(data, "createdAt").unwrap_or_else(|| now.to_owned()),
        updated_at: string_field(data, "updatedAt").unwrap_or_else(|| now.to_owned()),
        deleted_at: nullable_string(data, "deletedAt"),
    }
}

fn upsert_shadow(
    transaction: &Transaction<'_>,
    entity: &str,
    entity_id: &str,
    server_rev: i64,
    data: &Map<String, Value>,
) -> StoreResult<()> {
    transaction.execute(
        "INSERT INTO server_shadow (entity_type, entity_id, server_rev, payload_json)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(entity_type, entity_id) DO UPDATE SET
           server_rev = excluded.server_rev,
           payload_json = excluded.payload_json",
        params![
            entity,
            entity_id,
            server_rev,
            serde_json::to_string(&Value::Object(data.clone()))?
        ],
    )?;
    Ok(())
}

fn upsert_entity_data(
    transaction: &Transaction<'_>,
    entity: &str,
    entity_id: &str,
    data: &Map<String, Value>,
    now: &str,
    remote_wins_plan_slot: bool,
) -> StoreResult<()> {
    match entity {
        "task" => {
            let mut task = task_from_data(entity_id, data, now);
            if let Some(list_id) = &task.list_id
                && list_by_id(transaction, list_id)?.is_none()
            {
                // A snapshot can arrive with a tombstoned/missing parent.
                // Keep the row locally without violating the FK.
                task.list_id = None;
            }
            upsert_task_row(transaction, &task)
        }
        "list" => upsert_list_row(transaction, &list_from_data(entity_id, data, now)),
        "step" => {
            let step = step_from_data(entity_id, data, now);
            if task_by_id(transaction, &step.task_id)?.is_none() {
                return Ok(());
            }
            upsert_step_row(transaction, &step)
        }
        "day_plan" => {
            let plan = day_plan_from_data(entity_id, data, now);
            if task_by_id(transaction, &plan.task_id)?.is_none() {
                return Ok(());
            }
            if remote_wins_plan_slot {
                transaction.execute(
                    "DELETE FROM local_day_plans
                     WHERE task_id = ?1 AND local_date = ?2 AND id <> ?3",
                    params![plan.task_id, plan.local_date, plan.id],
                )?;
            }
            upsert_day_plan_row(transaction, &plan)
        }
        other => Err(StoreError::Unsupported(format!(
            "unknown entity for projection: {other}"
        ))),
    }
}

fn upsert_task_row(transaction: &Transaction<'_>, task: &Task) -> StoreResult<()> {
    transaction.execute(
        "INSERT INTO local_tasks
           (id, list_id, title, note, status, important, due_on, remind_at,
            remind_timezone, rank, series_id, occurrence_key, recurrence_json,
            completed_at, created_at, updated_at, deleted_at, tags_json)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18)
         ON CONFLICT(id) DO UPDATE SET
           list_id = excluded.list_id, title = excluded.title, note = excluded.note,
           status = excluded.status, important = excluded.important,
           due_on = excluded.due_on, remind_at = excluded.remind_at,
           remind_timezone = excluded.remind_timezone, rank = excluded.rank,
           series_id = excluded.series_id, occurrence_key = excluded.occurrence_key,
           recurrence_json = excluded.recurrence_json,
           completed_at = excluded.completed_at, created_at = excluded.created_at,
           updated_at = excluded.updated_at, deleted_at = excluded.deleted_at,
           tags_json = excluded.tags_json",
        params![
            task.id,
            task.list_id,
            task.title,
            task.note,
            task.status.as_str(),
            i64::from(task.important),
            task.due_on,
            task.remind_at,
            task.remind_timezone,
            task.rank,
            task.series_id,
            task.occurrence_key,
            task.recurrence
                .as_ref()
                .map(serde_json::to_string)
                .transpose()?,
            task.completed_at,
            task.created_at,
            task.updated_at,
            task.deleted_at,
            serde_json::to_string(&task.tags)?
        ],
    )?;
    Ok(())
}

fn upsert_list_row(transaction: &Transaction<'_>, list: &TaskList) -> StoreResult<()> {
    transaction.execute(
        "INSERT INTO local_lists
           (id, name, color, icon, rank, created_at, updated_at, deleted_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name, color = excluded.color, icon = excluded.icon,
           rank = excluded.rank, created_at = excluded.created_at,
           updated_at = excluded.updated_at, deleted_at = excluded.deleted_at",
        params![
            list.id,
            list.name,
            list.color,
            list.icon,
            list.rank,
            list.created_at,
            list.updated_at,
            list.deleted_at
        ],
    )?;
    Ok(())
}

fn upsert_step_row(transaction: &Transaction<'_>, step: &Step) -> StoreResult<()> {
    transaction.execute(
        "INSERT INTO local_steps
           (id, task_id, title, is_completed, rank, created_at, updated_at, deleted_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
         ON CONFLICT(id) DO UPDATE SET
           task_id = excluded.task_id, title = excluded.title,
           is_completed = excluded.is_completed, rank = excluded.rank,
           created_at = excluded.created_at, updated_at = excluded.updated_at,
           deleted_at = excluded.deleted_at",
        params![
            step.id,
            step.task_id,
            step.title,
            i64::from(step.is_completed),
            step.rank,
            step.created_at,
            step.updated_at,
            step.deleted_at
        ],
    )?;
    Ok(())
}

fn upsert_day_plan_row(transaction: &Transaction<'_>, plan: &DayPlan) -> StoreResult<()> {
    transaction.execute(
        "INSERT INTO local_day_plans
           (id, task_id, local_date, rank, created_at, updated_at, deleted_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT(id) DO UPDATE SET
           task_id = excluded.task_id, local_date = excluded.local_date,
           rank = excluded.rank, created_at = excluded.created_at,
           updated_at = excluded.updated_at, deleted_at = excluded.deleted_at",
        params![
            plan.id,
            plan.task_id,
            plan.local_date,
            plan.rank,
            plan.created_at,
            plan.updated_at,
            plan.deleted_at
        ],
    )?;
    Ok(())
}

fn pending_for_entity(
    transaction: &Transaction<'_>,
    entity: &str,
    entity_id: &str,
) -> StoreResult<Vec<OutboxRow>> {
    let mut statement = transaction.prepare(
        "SELECT entity_type, entity_id, kind, patch_json
         FROM outbox
         WHERE entity_type = ?1 AND entity_id = ?2 AND sync_status = 'pending'
         ORDER BY client_seq ASC",
    )?;
    Ok(statement
        .query_map(params![entity, entity_id], row_to_outbox)?
        .collect::<Result<Vec<_>, _>>()?)
}

fn row_to_outbox(row: &Row<'_>) -> rusqlite::Result<OutboxRow> {
    let patch_json: String = row.get(3)?;
    Ok(OutboxRow {
        entity: row.get(0)?,
        entity_id: row.get(1)?,
        kind: row.get(2)?,
        patch: serde_json::from_str(&patch_json).unwrap_or_else(|_| json!({})),
    })
}

pub(super) fn reproject_entities(
    transaction: &Transaction<'_>,
    affected: Vec<(String, String)>,
    now: &str,
) -> StoreResult<()> {
    let mut unique = HashSet::new();
    let mut affected = affected
        .into_iter()
        .filter(|(entity, entity_id)| unique.insert((entity.clone(), entity_id.clone())))
        .collect::<Vec<_>>();
    affected.sort_by_key(|(entity, entity_id)| (entity_order(entity), entity_id.clone()));
    for (entity, entity_id) in affected {
        reproject_entity(transaction, &entity, &entity_id, now)?;
    }
    Ok(())
}

fn reproject_entity(
    transaction: &Transaction<'_>,
    entity: &str,
    entity_id: &str,
    now: &str,
) -> StoreResult<()> {
    let Some(shadow_json) = transaction
        .query_row(
            "SELECT payload_json FROM server_shadow
             WHERE entity_type = ?1 AND entity_id = ?2",
            params![entity, entity_id],
            |row| row.get::<_, String>(0),
        )
        .optional()?
    else {
        // With no authoritative shadow there is nothing safe to rebuild from.
        return Ok(());
    };
    let mut data = serde_json::from_str::<Value>(&shadow_json)
        .ok()
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default();
    data.insert("id".to_owned(), Value::String(entity_id.to_owned()));
    for mutation in pending_for_entity(transaction, entity, entity_id)? {
        data = apply_mutation_to_data(entity, &data, &mutation, now);
    }
    upsert_entity_data(transaction, entity, entity_id, &data, now, true)
}

fn clear_materialized(transaction: &Transaction<'_>) -> StoreResult<()> {
    transaction.execute("DELETE FROM local_day_plans", [])?;
    transaction.execute("DELETE FROM local_steps", [])?;
    transaction.execute("DELETE FROM local_tasks", [])?;
    transaction.execute("DELETE FROM local_lists", [])?;
    Ok(())
}

fn write_shadow_snapshot(
    transaction: &Transaction<'_>,
    snapshot: &CloudSnapshot,
) -> StoreResult<()> {
    transaction.execute("DELETE FROM server_shadow", [])?;
    for list in &snapshot.lists {
        upsert_shadow(transaction, "list", &list.id, 0, &entity_data(list)?)?;
    }
    for task in &snapshot.tasks {
        upsert_shadow(transaction, "task", &task.id, 0, &entity_data(task)?)?;
    }
    for step in &snapshot.steps {
        upsert_shadow(transaction, "step", &step.id, 0, &entity_data(step)?)?;
    }
    for plan in &snapshot.day_plans {
        upsert_shadow(transaction, "day_plan", &plan.id, 0, &entity_data(plan)?)?;
    }
    Ok(())
}

fn later(local: &str, remote: &str) -> bool {
    if local.is_empty() {
        return false;
    }
    remote.is_empty() || local > remote
}

fn write_materialized(
    transaction: &Transaction<'_>,
    lists: &HashMap<String, TaskList>,
    tasks: &HashMap<String, Task>,
    steps: &HashMap<String, Step>,
    plans: &HashMap<String, DayPlan>,
) -> StoreResult<()> {
    clear_materialized(transaction)?;
    for list in lists.values() {
        upsert_list_row(transaction, list)?;
    }
    for task in tasks.values() {
        upsert_task_row(transaction, task)?;
    }
    for step in steps.values() {
        if task_by_id(transaction, &step.task_id)?.is_some() {
            upsert_step_row(transaction, step)?;
        }
    }
    for plan in plans.values() {
        if task_by_id(transaction, &plan.task_id)?.is_some() {
            upsert_day_plan_row(transaction, plan)?;
        }
    }
    Ok(())
}

fn local_data_index(
    local: &LocalEntities,
) -> StoreResult<HashMap<(String, String), Map<String, Value>>> {
    let mut index = HashMap::new();
    for list in &local.lists {
        index.insert(("list".to_owned(), list.id.clone()), entity_data(list)?);
    }
    for task in &local.tasks {
        index.insert(("task".to_owned(), task.id.clone()), entity_data(task)?);
    }
    for step in &local.steps {
        index.insert(("step".to_owned(), step.id.clone()), entity_data(step)?);
    }
    for plan in &local.day_plans {
        index.insert(("day_plan".to_owned(), plan.id.clone()), entity_data(plan)?);
    }
    Ok(index)
}

fn remote_data_index(
    snapshot: &CloudSnapshot,
) -> StoreResult<HashMap<(String, String), Map<String, Value>>> {
    let mut index = HashMap::new();
    for list in &snapshot.lists {
        index.insert(("list".to_owned(), list.id.clone()), entity_data(list)?);
    }
    for task in &snapshot.tasks {
        index.insert(("task".to_owned(), task.id.clone()), entity_data(task)?);
    }
    for step in &snapshot.steps {
        index.insert(("step".to_owned(), step.id.clone()), entity_data(step)?);
    }
    for plan in &snapshot.day_plans {
        index.insert(("day_plan".to_owned(), plan.id.clone()), entity_data(plan)?);
    }
    Ok(index)
}

impl TodoStore {
    pub fn sync_initialize_cloud(
        &self,
        request: CloudInitializeRequest,
    ) -> StoreResult<CloudInitializeResult> {
        let account_email = request.account_email.trim().to_ascii_lowercase();
        if account_email.is_empty() {
            return Err(StoreError::Validation("accountEmail 不能为空".to_owned()));
        }
        let account_api_url = request
            .account_api_url
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(|value| value.trim_end_matches('/').to_ascii_lowercase());
        let mut connection = self.lock()?;
        let transaction = connection.transaction()?;
        assert_sync_session(&transaction, request.session_id.as_deref())?;
        let local = local_entities(&transaction)?;
        let remote = &request.snapshot;
        let remote_lists = remote
            .lists
            .iter()
            .cloned()
            .map(|list| (list.id.clone(), list))
            .collect::<HashMap<_, _>>();
        let remote_tasks = remote
            .tasks
            .iter()
            .cloned()
            .map(|task| (task.id.clone(), task))
            .collect::<HashMap<_, _>>();
        let remote_steps = remote
            .steps
            .iter()
            .cloned()
            .map(|step| (step.id.clone(), step))
            .collect::<HashMap<_, _>>();
        let remote_plans = remote
            .day_plans
            .iter()
            .cloned()
            .map(|plan| (plan.id.clone(), plan))
            .collect::<HashMap<_, _>>();
        let remote_plan_slots = remote
            .day_plans
            .iter()
            .map(|plan| {
                (
                    (plan.task_id.clone(), plan.local_date.clone()),
                    plan.id.clone(),
                )
            })
            .collect::<HashMap<_, _>>();

        transaction.execute("DELETE FROM outbox", [])?;
        transaction.execute("DELETE FROM server_shadow", [])?;
        let mut prepared = Vec::new();

        match request.mode {
            CloudMergeMode::Cloud => {
                clear_materialized(&transaction)?;
                write_materialized(
                    &transaction,
                    &remote_lists,
                    &remote_tasks,
                    &remote_steps,
                    &remote_plans,
                )?;
            }
            CloudMergeMode::Merge => {
                let mut merged_lists = remote_lists.clone();
                let mut merged_tasks = remote_tasks.clone();
                let mut merged_steps = remote_steps.clone();
                let mut merged_plans = remote_plans.clone();

                let mut list_ops = Vec::new();
                let mut task_ops = Vec::new();
                let mut step_ops = Vec::new();
                let mut plan_ops = Vec::new();

                for list in &local.lists {
                    let Some(server) = remote_lists.get(&list.id) else {
                        if list.deleted_at.is_none() {
                            merged_lists.insert(list.id.clone(), list.clone());
                            list_ops.push(PreparedOp {
                                entity: "list",
                                entity_id: list.id.clone(),
                                kind: "create",
                                patch: full_patch("list", &serde_json::to_value(list)?),
                            });
                        }
                        continue;
                    };
                    if list.deleted_at.is_some() {
                        merged_lists.insert(list.id.clone(), list.clone());
                        if server.deleted_at.is_none() {
                            list_ops.push(PreparedOp {
                                entity: "list",
                                entity_id: list.id.clone(),
                                kind: "delete",
                                patch: json!({}),
                            });
                        }
                    } else if server.deleted_at.is_some() {
                        if later(&list.updated_at, &server.updated_at) {
                            merged_lists.insert(list.id.clone(), list.clone());
                            list_ops.push(PreparedOp {
                                entity: "list",
                                entity_id: list.id.clone(),
                                kind: "restore",
                                patch: full_patch("list", &serde_json::to_value(list)?),
                            });
                        }
                    } else if later(&list.updated_at, &server.updated_at) {
                        merged_lists.insert(list.id.clone(), list.clone());
                        list_ops.push(PreparedOp {
                            entity: "list",
                            entity_id: list.id.clone(),
                            kind: "patch",
                            patch: full_patch("list", &serde_json::to_value(list)?),
                        });
                    }
                }

                for task in &local.tasks {
                    let Some(server) = remote_tasks.get(&task.id) else {
                        if task.deleted_at.is_none() {
                            merged_tasks.insert(task.id.clone(), task.clone());
                            task_ops.push(PreparedOp {
                                entity: "task",
                                entity_id: task.id.clone(),
                                kind: "create",
                                patch: full_patch("task", &serde_json::to_value(task)?),
                            });
                        }
                        continue;
                    };
                    if task.deleted_at.is_some() {
                        merged_tasks.insert(task.id.clone(), task.clone());
                        if server.deleted_at.is_none() {
                            task_ops.push(PreparedOp {
                                entity: "task",
                                entity_id: task.id.clone(),
                                kind: "delete",
                                patch: json!({}),
                            });
                        }
                    } else if server.deleted_at.is_some() {
                        if later(&task.updated_at, &server.updated_at) {
                            merged_tasks.insert(task.id.clone(), task.clone());
                            task_ops.push(PreparedOp {
                                entity: "task",
                                entity_id: task.id.clone(),
                                kind: "restore",
                                patch: full_patch("task", &serde_json::to_value(task)?),
                            });
                        }
                    } else if later(&task.updated_at, &server.updated_at) {
                        merged_tasks.insert(task.id.clone(), task.clone());
                        task_ops.push(PreparedOp {
                            entity: "task",
                            entity_id: task.id.clone(),
                            kind: "patch",
                            patch: full_patch("task", &serde_json::to_value(task)?),
                        });
                    }
                }

                for step in &local.steps {
                    let Some(server) = remote_steps.get(&step.id) else {
                        if step.deleted_at.is_none() {
                            merged_steps.insert(step.id.clone(), step.clone());
                            step_ops.push(PreparedOp {
                                entity: "step",
                                entity_id: step.id.clone(),
                                kind: "create",
                                patch: full_patch("step", &serde_json::to_value(step)?),
                            });
                        }
                        continue;
                    };
                    if step.deleted_at.is_some() {
                        merged_steps.insert(step.id.clone(), step.clone());
                        if server.deleted_at.is_none() {
                            step_ops.push(PreparedOp {
                                entity: "step",
                                entity_id: step.id.clone(),
                                kind: "delete",
                                patch: json!({}),
                            });
                        }
                    } else if server.deleted_at.is_some() {
                        if later(&step.updated_at, &server.updated_at) {
                            merged_steps.insert(step.id.clone(), step.clone());
                            step_ops.push(PreparedOp {
                                entity: "step",
                                entity_id: step.id.clone(),
                                kind: "restore",
                                patch: full_patch("step", &serde_json::to_value(step)?),
                            });
                        }
                    } else if later(&step.updated_at, &server.updated_at) {
                        merged_steps.insert(step.id.clone(), step.clone());
                        step_ops.push(PreparedOp {
                            entity: "step",
                            entity_id: step.id.clone(),
                            kind: "patch",
                            patch: full_patch("step", &serde_json::to_value(step)?),
                        });
                    }
                }

                for plan in &local.day_plans {
                    let Some(server) = remote_plans.get(&plan.id) else {
                        if plan.deleted_at.is_none() {
                            let slot = (plan.task_id.clone(), plan.local_date.clone());
                            if let Some(remote_id) = remote_plan_slots.get(&slot)
                                && remote_id != &plan.id
                            {
                                // Remote wins the unique local_date/task slot.
                                continue;
                            }
                            merged_plans.insert(plan.id.clone(), plan.clone());
                            plan_ops.push(PreparedOp {
                                entity: "day_plan",
                                entity_id: plan.id.clone(),
                                kind: "create",
                                patch: full_patch("day_plan", &serde_json::to_value(plan)?),
                            });
                        }
                        continue;
                    };
                    if plan.deleted_at.is_some() {
                        merged_plans.insert(plan.id.clone(), plan.clone());
                        if server.deleted_at.is_none() {
                            plan_ops.push(PreparedOp {
                                entity: "day_plan",
                                entity_id: plan.id.clone(),
                                kind: "delete",
                                patch: json!({}),
                            });
                        }
                    } else if server.deleted_at.is_some() {
                        if later(&plan.updated_at, &server.updated_at) {
                            merged_plans.insert(plan.id.clone(), plan.clone());
                            plan_ops.push(PreparedOp {
                                entity: "day_plan",
                                entity_id: plan.id.clone(),
                                kind: "restore",
                                patch: full_patch("day_plan", &serde_json::to_value(plan)?),
                            });
                        }
                    } else if later(&plan.updated_at, &server.updated_at) {
                        merged_plans.insert(plan.id.clone(), plan.clone());
                        plan_ops.push(PreparedOp {
                            entity: "day_plan",
                            entity_id: plan.id.clone(),
                            kind: "patch",
                            patch: full_patch("day_plan", &serde_json::to_value(plan)?),
                        });
                    }
                }

                prepared.extend(list_ops);
                prepared.extend(task_ops);
                prepared.extend(step_ops);
                prepared.extend(plan_ops);
                write_materialized(
                    &transaction,
                    &merged_lists,
                    &merged_tasks,
                    &merged_steps,
                    &merged_plans,
                )?;
            }
        }

        write_shadow_snapshot(&transaction, remote)?;
        kv_set(&transaction, "client_seq", "0")?;
        kv_set(&transaction, "sync_enabled", "true")?;
        for operation in &prepared {
            append_mutation(
                &transaction,
                operation.entity,
                &operation.entity_id,
                operation.kind,
                &operation.patch,
            )?;
        }
        kv_set(&transaction, "sync_cursor", &remote.cursor)?;
        kv_set(&transaction, "bound_account", &account_email)?;
        if let Some(api_url) = &account_api_url {
            kv_set(&transaction, "bound_api_url", api_url)?;
        } else {
            kv_delete(&transaction, "bound_api_url")?;
        }
        kv_set(&transaction, "bootstrap_required", "0")?;
        transaction.commit()?;
        Ok(CloudInitializeResult {
            prepared_ops: prepared.len(),
        })
    }

    pub fn sync_replace_snapshot(&self, snapshot: &CloudSnapshot) -> StoreResult<()> {
        self.sync_replace_snapshot_fenced(snapshot, None)
    }

    pub fn sync_replace_snapshot_fenced(
        &self,
        snapshot: &CloudSnapshot,
        session_id: Option<&str>,
    ) -> StoreResult<()> {
        let mut connection = self.lock()?;
        let transaction = connection.transaction()?;
        assert_sync_session(&transaction, session_id)?;
        let local = local_entities(&transaction)?;
        let local_index = local_data_index(&local)?;
        let shadow_index = remote_data_index(snapshot)?;
        let now = now();

        let remote_lists = snapshot
            .lists
            .iter()
            .cloned()
            .map(|list| (list.id.clone(), list))
            .collect::<HashMap<_, _>>();
        let remote_tasks = snapshot
            .tasks
            .iter()
            .cloned()
            .map(|task| (task.id.clone(), task))
            .collect::<HashMap<_, _>>();
        let remote_steps = snapshot
            .steps
            .iter()
            .cloned()
            .map(|step| (step.id.clone(), step))
            .collect::<HashMap<_, _>>();
        let remote_plans = snapshot
            .day_plans
            .iter()
            .cloned()
            .map(|plan| (plan.id.clone(), plan))
            .collect::<HashMap<_, _>>();
        let remote_slots = snapshot
            .day_plans
            .iter()
            .map(|plan| {
                (
                    (plan.task_id.clone(), plan.local_date.clone()),
                    plan.id.clone(),
                )
            })
            .collect::<HashMap<_, _>>();

        let pending = {
            let mut statement = transaction.prepare(
                "SELECT entity_type, entity_id, kind, patch_json
                 FROM outbox WHERE sync_status = 'pending' ORDER BY client_seq ASC",
            )?;
            statement
                .query_map([], row_to_outbox)?
                .collect::<Result<Vec<_>, _>>()?
        };
        let mut groups: BTreeMap<(String, String), Vec<OutboxRow>> = BTreeMap::new();
        for mutation in pending {
            groups
                .entry((mutation.entity.clone(), mutation.entity_id.clone()))
                .or_default()
                .push(mutation);
        }

        let mut merged_lists = remote_lists.clone();
        let mut merged_tasks = remote_tasks.clone();
        let mut merged_steps = remote_steps.clone();
        let mut merged_plans = remote_plans.clone();

        for ((entity, entity_id), mutations) in groups {
            let key = (entity.clone(), entity_id.clone());
            let mut data = shadow_index
                .get(&key)
                .cloned()
                .or_else(|| local_index.get(&key).cloned())
                .unwrap_or_default();
            data.insert("id".to_owned(), Value::String(entity_id.clone()));
            for mutation in &mutations {
                data = apply_mutation_to_data(&entity, &data, mutation, &now);
            }
            match entity.as_str() {
                "list" => {
                    merged_lists.insert(entity_id.clone(), list_from_data(&entity_id, &data, &now));
                }
                "task" => {
                    merged_tasks.insert(entity_id.clone(), task_from_data(&entity_id, &data, &now));
                }
                "step" => {
                    merged_steps.insert(entity_id.clone(), step_from_data(&entity_id, &data, &now));
                }
                "day_plan" => {
                    let plan = day_plan_from_data(&entity_id, &data, &now);
                    let slot = (plan.task_id.clone(), plan.local_date.clone());
                    if let Some(remote_id) = remote_slots.get(&slot)
                        && remote_id != &plan.id
                    {
                        continue;
                    }
                    merged_plans.insert(entity_id, plan);
                }
                _ => {}
            }
        }

        write_materialized(
            &transaction,
            &merged_lists,
            &merged_tasks,
            &merged_steps,
            &merged_plans,
        )?;
        write_shadow_snapshot(&transaction, snapshot)?;
        kv_set(&transaction, "sync_cursor", &snapshot.cursor)?;
        kv_set(&transaction, "bootstrap_required", "0")?;
        transaction.commit()?;
        Ok(())
    }
}
