use std::{
    cmp::Ordering,
    collections::{BTreeMap, HashMap, HashSet},
    path::Path,
    sync::{Arc, Mutex, MutexGuard},
    time::Duration,
};

use chrono::{DateTime, NaiveDate, SecondsFormat, Utc};
use rusqlite::{
    Connection, OptionalExtension, Row, Transaction, params, params_from_iter,
    types::Value as SqlValue,
};
use serde_json::{Map, Value, json};
use uuid::Uuid;

use crate::{
    error::{StoreError, StoreResult},
    models::*,
};

mod sync_support;

const TASK_COLUMNS: &str = "id, list_id, title, note, status, important, due_on, \
    remind_at, remind_timezone, rank, series_id, occurrence_key, recurrence_json, \
    completed_at, created_at, updated_at, deleted_at, tags_json";
const TASK_QUALIFIED: &str = "t.id, t.list_id, t.title, t.note, t.status, t.important, \
    t.due_on, t.remind_at, t.remind_timezone, t.rank, t.series_id, t.occurrence_key, \
    t.recurrence_json, t.completed_at, t.created_at, t.updated_at, t.deleted_at, t.tags_json";
const LIST_COLUMNS: &str = "id, name, color, icon, rank, created_at, updated_at, deleted_at";
const STEP_COLUMNS: &str =
    "id, task_id, title, is_completed, rank, created_at, updated_at, deleted_at";
const DAY_PLAN_COLUMNS: &str = "id, task_id, local_date, rank, created_at, updated_at, deleted_at";

const SCHEMA_V1: &str = r#"
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS local_lists (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  color TEXT,
  icon TEXT,
  rank TEXT NOT NULL DEFAULT 'a0',
  created_at TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT '',
  deleted_at TEXT
);

CREATE TABLE IF NOT EXISTS local_tasks (
  id TEXT PRIMARY KEY,
  list_id TEXT REFERENCES local_lists(id),
  title TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('open', 'completed')),
  important INTEGER NOT NULL DEFAULT 0 CHECK (important IN (0, 1)),
  due_on TEXT,
  remind_at TEXT,
  remind_timezone TEXT,
  rank TEXT NOT NULL DEFAULT 'a0',
  series_id TEXT,
  occurrence_key TEXT,
  recurrence_json TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  tags_json TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS local_steps (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES local_tasks(id),
  title TEXT NOT NULL,
  is_completed INTEGER NOT NULL DEFAULT 0,
  rank TEXT NOT NULL DEFAULT 'a0',
  created_at TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT '',
  deleted_at TEXT
);

CREATE TABLE IF NOT EXISTS local_day_plans (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES local_tasks(id),
  local_date TEXT NOT NULL,
  rank TEXT NOT NULL DEFAULT 'a0',
  created_at TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT '',
  deleted_at TEXT,
  UNIQUE(task_id, local_date)
);

CREATE TABLE IF NOT EXISTS server_shadow (
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  server_rev INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  PRIMARY KEY (entity_type, entity_id)
);

CREATE TABLE IF NOT EXISTS outbox (
  op_id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,
  client_seq INTEGER NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  patch_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  sync_status TEXT NOT NULL DEFAULT 'pending',
  error_code TEXT,
  UNIQUE(device_id, client_seq)
);

CREATE TABLE IF NOT EXISTS kv_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_local_tasks_list ON local_tasks(list_id, status, rank);
CREATE INDEX IF NOT EXISTS idx_local_tasks_due ON local_tasks(due_on, status);
CREATE INDEX IF NOT EXISTS idx_local_tasks_status ON local_tasks(status, deleted_at);
CREATE INDEX IF NOT EXISTS idx_local_lists_rank ON local_lists(rank);
CREATE INDEX IF NOT EXISTS idx_local_steps_task ON local_steps(task_id, rank);
CREATE INDEX IF NOT EXISTS idx_local_day_plans ON local_day_plans(local_date, rank);
CREATE INDEX IF NOT EXISTS idx_outbox_pending ON outbox(sync_status, client_seq);

CREATE VIRTUAL TABLE IF NOT EXISTS task_fts USING fts5(
  title,
  note,
  content='local_tasks',
  content_rowid='rowid',
  tokenize='trigram'
);

CREATE TRIGGER IF NOT EXISTS task_ai AFTER INSERT ON local_tasks BEGIN
  INSERT INTO task_fts(rowid, title, note) VALUES(new.rowid, new.title, new.note);
END;

CREATE TRIGGER IF NOT EXISTS task_ad AFTER DELETE ON local_tasks BEGIN
  INSERT INTO task_fts(task_fts, rowid, title, note)
    VALUES('delete', old.rowid, old.title, old.note);
END;

CREATE TRIGGER IF NOT EXISTS task_au AFTER UPDATE OF title, note ON local_tasks BEGIN
  INSERT INTO task_fts(task_fts, rowid, title, note)
    VALUES('delete', old.rowid, old.title, old.note);
  INSERT INTO task_fts(rowid, title, note) VALUES(new.rowid, new.title, new.note);
END;
"#;

/// A dedicated SQLite connection serialized by a mutex.
///
/// `rusqlite::Connection` is `Send` but not `Sync`; the `Arc<Mutex<_>>`
/// wrapper makes this store clonable, `Send + Sync`, and safe to move into
/// Tauri's blocking thread pool.
#[derive(Clone)]
pub struct TodoStore {
    connection: Arc<Mutex<Connection>>,
}

impl std::fmt::Debug for TodoStore {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.debug_struct("TodoStore").finish_non_exhaustive()
    }
}

impl TodoStore {
    pub fn open(path: impl AsRef<Path>) -> StoreResult<Self> {
        let connection = Connection::open(path)?;
        Self::from_connection(connection)
    }

    /// Intended for tests and previews; production uses a file-backed DB.
    pub fn open_in_memory() -> StoreResult<Self> {
        let connection = Connection::open_in_memory()?;
        Self::from_connection(connection)
    }

    fn from_connection(mut connection: Connection) -> StoreResult<Self> {
        configure_connection(&connection)?;
        migrate(&mut connection)?;
        let transaction = connection.transaction()?;
        ensure_local_identity(&transaction)?;
        transaction.commit()?;
        Ok(Self {
            connection: Arc::new(Mutex::new(connection)),
        })
    }

    pub fn initialize(&self) -> StoreResult<()> {
        let mut connection = self.lock()?;
        migrate(&mut connection)?;
        let transaction = connection.transaction()?;
        ensure_local_identity(&transaction)?;
        transaction.commit()?;
        Ok(())
    }

    fn lock(&self) -> StoreResult<MutexGuard<'_, Connection>> {
        self.connection
            .lock()
            .map_err(|_| StoreError::Internal("SQLite connection mutex was poisoned".to_owned()))
    }

    // ------------------------------------------------------------------
    // Lists
    // ------------------------------------------------------------------

    pub fn list_lists(&self) -> StoreResult<Vec<TaskList>> {
        let connection = self.lock()?;
        self.list_lists_unlocked(&connection)
    }

    fn list_lists_unlocked(&self, connection: &Connection) -> StoreResult<Vec<TaskList>> {
        let mut statement =
            connection.prepare(&format!("SELECT {LIST_COLUMNS} FROM local_lists"))?;
        let lists = statement
            .query_map([], row_to_list)?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(sorted_lists(lists))
    }

    pub fn create_list(&self, input: NewList) -> StoreResult<TaskList> {
        let name = clean_list_name(&input.name)?;
        let color = validate_optional_text("color", input.color, 64)?;
        let icon = validate_optional_text("icon", input.icon, 128)?;
        let mut connection = self.lock()?;
        let transaction = connection.transaction()?;
        let now = now();
        let ranks = {
            let mut statement = transaction.prepare("SELECT rank FROM local_lists")?;
            statement
                .query_map([], |row| row.get::<_, String>(0))?
                .collect::<Result<Vec<_>, _>>()?
        };
        let list = TaskList {
            id: Uuid::now_v7().to_string(),
            name,
            color,
            icon,
            rank: next_rank(&ranks),
            created_at: now.clone(),
            updated_at: now,
            deleted_at: None,
        };
        transaction.execute(
            "INSERT INTO local_lists (id, name, color, icon, rank, created_at, updated_at, deleted_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, NULL)",
            params![
                list.id,
                list.name,
                list.color,
                list.icon,
                list.rank,
                list.created_at,
                list.updated_at
            ],
        )?;
        append_mutation(
            &transaction,
            "list",
            &list.id,
            "create",
            &serde_json::to_value(&list)?,
        )?;
        transaction.commit()?;
        Ok(list)
    }

    pub fn patch_list(&self, id: &str, patch: ListPatch) -> StoreResult<TaskList> {
        if patch.is_empty() {
            return Err(StoreError::Validation(
                "list patch must contain at least one field".to_owned(),
            ));
        }
        validate_non_empty_id(id)?;
        let mut connection = self.lock()?;
        let transaction = connection.transaction()?;
        let current = list_by_id(&transaction, id)?
            .ok_or_else(|| StoreError::NotFound("清单不存在".to_owned()))?;
        if current.deleted_at.is_some() {
            return Err(StoreError::NotFound("清单不存在".to_owned()));
        }

        let mut sets = Vec::new();
        let mut values: Vec<SqlValue> = Vec::new();
        if patch.name.is_some() {
            let name = clean_list_name(required(patch.name.as_ref(), "name")?)?;
            sets.push("name = ?");
            values.push(SqlValue::Text(name));
        }
        if let Some(value) = &patch.color {
            sets.push("color = ?");
            values.push(optional_string_sql(value.clone(), "color", 64)?);
        }
        if let Some(value) = &patch.icon {
            sets.push("icon = ?");
            values.push(optional_string_sql(value.clone(), "icon", 128)?);
        }
        if patch.rank.is_some() {
            let rank = required(patch.rank.as_ref(), "rank")?.trim();
            if rank.is_empty() || rank.chars().count() > 128 {
                return Err(StoreError::Validation("rank 无效".to_owned()));
            }
            sets.push("rank = ?");
            values.push(SqlValue::Text(rank.to_owned()));
        }
        let now = now();
        sets.push("updated_at = ?");
        values.push(SqlValue::Text(now));
        values.push(SqlValue::Text(id.to_owned()));
        transaction.execute(
            &format!("UPDATE local_lists SET {} WHERE id = ?", sets.join(", ")),
            params_from_iter(values),
        )?;
        let updated = list_by_id(&transaction, id)?
            .ok_or_else(|| StoreError::NotFound("清单不存在".to_owned()))?;
        append_mutation(
            &transaction,
            "list",
            id,
            "patch",
            &serde_json::to_value(&patch)?,
        )?;
        transaction.commit()?;
        Ok(updated)
    }

    pub fn delete_list(&self, id: &str) -> StoreResult<()> {
        validate_non_empty_id(id)?;
        let mut connection = self.lock()?;
        let transaction = connection.transaction()?;
        let Some(list) = list_by_id(&transaction, id)? else {
            return Ok(());
        };
        if list.deleted_at.is_some() {
            return Ok(());
        }
        let deleted_at = now();
        transaction.execute(
            "UPDATE local_lists SET deleted_at = ?1, updated_at = ?1 WHERE id = ?2",
            params![deleted_at, id],
        )?;
        append_mutation(&transaction, "list", id, "delete", &json!({}))?;
        let task_ids = {
            let mut statement = transaction
                .prepare("SELECT id FROM local_tasks WHERE list_id = ?1 AND deleted_at IS NULL")?;
            statement
                .query_map([id], |row| row.get::<_, String>(0))?
                .collect::<Result<Vec<_>, _>>()?
        };
        for task_id in task_ids {
            transaction.execute(
                "UPDATE local_tasks SET list_id = NULL, updated_at = ?1 WHERE id = ?2",
                params![deleted_at, task_id],
            )?;
            append_mutation(
                &transaction,
                "task",
                &task_id,
                "patch",
                &json!({ "listId": null }),
            )?;
        }
        transaction.commit()?;
        Ok(())
    }

    pub fn restore_list(&self, id: &str) -> StoreResult<()> {
        validate_non_empty_id(id)?;
        let mut connection = self.lock()?;
        let transaction = connection.transaction()?;
        let Some(list) = list_by_id(&transaction, id)? else {
            return Ok(());
        };
        if list.deleted_at.is_none() {
            return Ok(());
        }
        transaction.execute(
            "UPDATE local_lists SET deleted_at = NULL, updated_at = ?1 WHERE id = ?2",
            params![now(), id],
        )?;
        append_mutation(&transaction, "list", id, "restore", &json!({}))?;
        transaction.commit()?;
        Ok(())
    }

    // ------------------------------------------------------------------
    // Tasks
    // ------------------------------------------------------------------

    pub fn create_task(&self, input: NewTask) -> StoreResult<Task> {
        let prepared = prepare_new_task(input)?;
        let mut connection = self.lock()?;
        let transaction = connection.transaction()?;
        if let Some(list_id) = &prepared.list_id {
            ensure_active_list(&transaction, list_id)?;
        }
        let rank = match prepared.rank {
            Some(rank) => rank,
            None => {
                let ranks = {
                    let mut statement = transaction.prepare("SELECT rank FROM local_tasks")?;
                    statement
                        .query_map([], |row| row.get::<_, String>(0))?
                        .collect::<Result<Vec<_>, _>>()?
                };
                next_rank(&ranks)
            }
        };
        let created_at = now();
        let task = Task {
            id: Uuid::now_v7().to_string(),
            list_id: prepared.list_id,
            title: prepared.title,
            note: prepared.note,
            tags: prepared.tags,
            status: TaskStatus::Open,
            important: prepared.important,
            due_on: prepared.due_on.clone(),
            remind_at: prepared.remind_at,
            remind_timezone: prepared.remind_timezone,
            rank,
            series_id: None,
            occurrence_key: prepared.due_on,
            recurrence: prepared.recurrence,
            completed_at: None,
            created_at: created_at.clone(),
            updated_at: created_at.clone(),
            deleted_at: None,
        };
        insert_task(&transaction, &task)?;
        append_mutation(
            &transaction,
            "task",
            &task.id,
            "create",
            &serde_json::to_value(&task)?,
        )?;
        if let Some(plan_date) = prepared.plan_date {
            let ranks = {
                let mut statement = transaction.prepare(
                    "SELECT rank FROM local_day_plans WHERE local_date = ?1 AND deleted_at IS NULL",
                )?;
                statement
                    .query_map([&plan_date], |row| row.get::<_, String>(0))?
                    .collect::<Result<Vec<_>, _>>()?
            };
            let plan = DayPlan {
                id: Uuid::now_v7().to_string(),
                task_id: task.id.clone(),
                local_date: plan_date,
                rank: next_rank(&ranks),
                created_at: created_at.clone(),
                updated_at: created_at,
                deleted_at: None,
            };
            insert_day_plan(&transaction, &plan)?;
            append_mutation(
                &transaction,
                "day_plan",
                &plan.id,
                "create",
                &serde_json::to_value(&plan)?,
            )?;
        }
        transaction.commit()?;
        Ok(task)
    }

    pub fn patch_task(&self, id: &str, patch: TaskPatch) -> StoreResult<Task> {
        if patch.is_empty() {
            return Err(StoreError::Validation(
                "task patch must contain at least one field".to_owned(),
            ));
        }
        validate_non_empty_id(id)?;
        let mut connection = self.lock()?;
        let transaction = connection.transaction()?;
        let current = task_by_id(&transaction, id)?
            .ok_or_else(|| StoreError::NotFound("任务不存在".to_owned()))?;
        if current.deleted_at.is_some() {
            return Err(StoreError::NotFound("任务不存在".to_owned()));
        }

        let mut effective_patch = patch.clone();
        let mut sets: Vec<&str> = Vec::new();
        let mut values: Vec<SqlValue> = Vec::new();

        if patch.title.is_some() {
            let title = clean_title(required(patch.title.as_ref(), "title")?)?;
            sets.push("title = ?");
            values.push(SqlValue::Text(title.clone()));
            effective_patch.title = Some(Some(title));
        }
        if let Some(value) = &patch.list_id {
            match value {
                Some(list_id) => {
                    validate_non_empty_id(list_id)?;
                    ensure_active_list(&transaction, list_id)?;
                    sets.push("list_id = ?");
                    values.push(SqlValue::Text(list_id.clone()));
                }
                None => {
                    sets.push("list_id = ?");
                    values.push(SqlValue::Null);
                }
            }
        }
        if patch.note.is_some() {
            let note = clean_note(patch.note.as_ref().and_then(|value| value.as_deref()));
            sets.push("note = ?");
            values.push(SqlValue::Text(note.clone()));
            effective_patch.note = Some(Some(note));
        }
        if let Some(tags) = &patch.tags {
            let tags = normalize_tags(tags.clone())?;
            sets.push("tags_json = ?");
            values.push(SqlValue::Text(serde_json::to_string(&tags)?));
            effective_patch.tags = Some(tags);
        }
        if patch.important.is_some() {
            let important = *required(patch.important.as_ref(), "important")?;
            sets.push("important = ?");
            values.push(SqlValue::Integer(i64::from(important)));
        }
        if patch.due_on.is_some() {
            match required_optional(patch.due_on.as_ref(), "dueOn")? {
                Some(date) => {
                    validate_date(date, "dueOn")?;
                    sets.push("due_on = ?");
                    values.push(SqlValue::Text(date.clone()));
                }
                None => {
                    sets.push("due_on = ?");
                    values.push(SqlValue::Null);
                }
            }
        }
        if patch.remind_at.is_some() {
            match required_optional(patch.remind_at.as_ref(), "remindAt")? {
                Some(instant) => {
                    let instant = normalize_instant(instant, "remindAt")?;
                    sets.push("remind_at = ?");
                    values.push(SqlValue::Text(instant.clone()));
                    effective_patch.remind_at = Some(Some(instant));
                }
                None => {
                    sets.push("remind_at = ?");
                    values.push(SqlValue::Null);
                }
            }
        }
        if patch.remind_timezone.is_some() {
            match required_optional(patch.remind_timezone.as_ref(), "remindTimezone")? {
                Some(timezone) => {
                    let timezone = timezone.trim();
                    if timezone.is_empty() || timezone.chars().count() > 64 {
                        return Err(StoreError::Validation("remindTimezone 无效".to_owned()));
                    }
                    sets.push("remind_timezone = ?");
                    values.push(SqlValue::Text(timezone.to_owned()));
                    effective_patch.remind_timezone = Some(Some(timezone.to_owned()));
                }
                None => {
                    sets.push("remind_timezone = ?");
                    values.push(SqlValue::Null);
                }
            }
        }
        if patch.recurrence.is_some() {
            match required_optional(patch.recurrence.as_ref(), "recurrence")? {
                Some(value) => {
                    if !value.is_object() {
                        return Err(StoreError::Validation(
                            "recurrence 必须是 JSON 对象".to_owned(),
                        ));
                    }
                    sets.push("recurrence_json = ?");
                    values.push(SqlValue::Text(serde_json::to_string(value)?));
                }
                None => {
                    sets.push("recurrence_json = ?");
                    values.push(SqlValue::Null);
                }
            }
        }
        if patch.rank.is_some() {
            let rank = required(patch.rank.as_ref(), "rank")?.trim();
            if rank.is_empty() || rank.chars().count() > 128 {
                return Err(StoreError::Validation("rank 无效".to_owned()));
            }
            sets.push("rank = ?");
            values.push(SqlValue::Text(rank.to_owned()));
        }

        let status_update = if patch.status.is_some() {
            Some(*required(patch.status.as_ref(), "status")?)
        } else {
            None
        };
        if let Some(status) = status_update {
            sets.push("status = ?");
            values.push(SqlValue::Text(status.as_str().to_owned()));
        }
        let completed_at = if status_update == Some(TaskStatus::Open) {
            effective_patch.completed_at = Some(None);
            Some(None)
        } else if let Some(value) = &patch.completed_at {
            match value {
                Some(instant) => {
                    let instant = normalize_instant(instant, "completedAt")?;
                    effective_patch.completed_at = Some(Some(instant.clone()));
                    Some(Some(instant))
                }
                None => Some(None),
            }
        } else if status_update == Some(TaskStatus::Completed) {
            let instant = now();
            effective_patch.completed_at = Some(Some(instant.clone()));
            Some(Some(instant))
        } else {
            None
        };
        if let Some(value) = completed_at {
            sets.push("completed_at = ?");
            values.push(value.map_or(SqlValue::Null, SqlValue::Text));
        }

        let updated_at = now();
        if sets.is_empty() {
            return Err(StoreError::Validation(
                "task patch must contain at least one field".to_owned(),
            ));
        }
        sets.push("updated_at = ?");
        values.push(SqlValue::Text(updated_at));
        values.push(SqlValue::Text(id.to_owned()));
        transaction.execute(
            &format!("UPDATE local_tasks SET {} WHERE id = ?", sets.join(", ")),
            params_from_iter(values),
        )?;
        let updated = task_by_id(&transaction, id)?
            .ok_or_else(|| StoreError::NotFound("任务不存在".to_owned()))?;
        append_mutation(
            &transaction,
            "task",
            id,
            "patch",
            &serde_json::to_value(&effective_patch)?,
        )?;
        transaction.commit()?;
        Ok(updated)
    }

    pub fn get_task(&self, id: &str) -> StoreResult<Option<TaskWithSteps>> {
        validate_non_empty_id(id)?;
        let connection = self.lock()?;
        let Some(task) = task_by_id(&connection, id)? else {
            return Ok(None);
        };
        if task.deleted_at.is_some() {
            return Ok(None);
        }
        Ok(attach_details(&connection, vec![task])?.into_iter().next())
    }

    pub fn list_tasks(&self, query: TaskQuery) -> StoreResult<Page<TaskWithSteps>> {
        if let Some(date) = &query.local_date {
            validate_date(date, "localDate")?;
        }
        if let Some(date) = &query.due_from {
            validate_date(date, "dueFrom")?;
        }
        if let Some(date) = &query.due_to {
            validate_date(date, "dueTo")?;
        }
        if query.view == TaskView::MyDay && query.local_date.is_none() {
            return Err(StoreError::Validation(
                "my-day 查询需要 localDate".to_owned(),
            ));
        }

        let connection = self.lock()?;
        let mut rows: Vec<(Task, String)> = if query.view == TaskView::MyDay {
            let mut statement = connection.prepare(&format!(
                "SELECT {TASK_QUALIFIED}, p.rank
                 FROM local_tasks t
                 JOIN local_day_plans p ON p.task_id = t.id
                 WHERE t.deleted_at IS NULL AND p.deleted_at IS NULL AND p.local_date = ?1"
            ))?;
            statement
                .query_map([query.local_date.as_deref().unwrap_or_default()], |row| {
                    Ok((row_to_task(row)?, row.get::<_, String>(18)?))
                })?
                .collect::<Result<Vec<_>, _>>()?
        } else {
            let mut statement =
                connection.prepare(&format!("SELECT {TASK_COLUMNS} FROM local_tasks"))?;
            statement
                .query_map([], row_to_task)?
                .collect::<Result<Vec<_>, _>>()?
                .into_iter()
                .map(|task| (task, String::new()))
                .collect()
        };
        rows.retain(|(task, _)| task_matches_query(task, &query));
        if query.view == TaskView::MyDay {
            rows.sort_by(|(left, left_rank), (right, right_rank)| {
                left_rank
                    .cmp(right_rank)
                    .then_with(|| left.created_at.cmp(&right.created_at))
            });
        } else {
            rows.sort_by(|(left, _), (right, _)| compare_tasks(left, right));
        }
        let limit = query.limit.unwrap_or(500).clamp(1, 5_000) as usize;
        let tasks = rows
            .into_iter()
            .take(limit)
            .map(|(task, _)| task)
            .collect::<Vec<_>>();
        Ok(Page {
            items: attach_details(&connection, tasks)?,
            next_cursor: None,
        })
    }

    pub fn get_counts(&self, local_date: &str) -> StoreResult<ViewCounts> {
        validate_date(local_date, "localDate")?;
        let connection = self.lock()?;
        let tasks = {
            let mut statement =
                connection.prepare(&format!("SELECT {TASK_COLUMNS} FROM local_tasks"))?;
            statement
                .query_map([], row_to_task)?
                .collect::<Result<Vec<_>, _>>()?
        };
        let open_tasks = tasks
            .iter()
            .filter(|task| task.deleted_at.is_none() && task.status == TaskStatus::Open)
            .collect::<Vec<_>>();
        let my_day_ids = {
            let mut statement = connection.prepare(
                "SELECT task_id FROM local_day_plans
                 WHERE local_date = ?1 AND deleted_at IS NULL",
            )?;
            statement
                .query_map([local_date], |row| row.get::<_, String>(0))?
                .collect::<Result<HashSet<_>, _>>()?
        };
        let lists = self.list_lists_unlocked(&connection)?;
        let mut list_counts = BTreeMap::new();
        for list in &lists {
            list_counts.insert(list.id.clone(), 0);
        }
        let mut counts = ViewCounts {
            all: open_tasks.len() as i64,
            completed: tasks
                .iter()
                .filter(|task| task.deleted_at.is_none() && task.status == TaskStatus::Completed)
                .count() as i64,
            ..ViewCounts::default()
        };
        for task in open_tasks {
            if my_day_ids.contains(&task.id) {
                counts.my_day += 1;
            }
            if task.important {
                counts.important += 1;
            }
            if task.due_on.is_some() {
                counts.planned += 1;
            }
            if let Some(list_id) = &task.list_id {
                *list_counts.entry(list_id.clone()).or_insert(0) += 1;
            }
        }
        counts.lists = list_counts;
        Ok(counts)
    }

    pub fn commit_completion(
        &self,
        task_id: &str,
        completed_at: &str,
        next_task: Option<Task>,
    ) -> StoreResult<CompleteResult> {
        validate_non_empty_id(task_id)?;
        let completed_at = normalize_instant(completed_at, "completedAt")?;
        if let Some(next) = &next_task {
            validate_non_empty_id(&next.id)?;
            if next.id == task_id {
                return Err(StoreError::Conflict(
                    "nextTask 不能与已完成任务相同".to_owned(),
                ));
            }
        }
        let mut connection = self.lock()?;
        let transaction = connection.transaction()?;
        let current = task_by_id(&transaction, task_id)?
            .ok_or_else(|| StoreError::NotFound("任务不存在".to_owned()))?;
        if current.deleted_at.is_some() {
            return Err(StoreError::NotFound("任务不存在".to_owned()));
        }
        if let Some(next) = &next_task
            && let Some(list_id) = &next.list_id
        {
            ensure_active_list(&transaction, list_id)?;
        }
        transaction.execute(
            "UPDATE local_tasks
             SET status = 'completed', completed_at = ?1, updated_at = ?2
             WHERE id = ?3",
            params![completed_at, now(), task_id],
        )?;
        let completed = task_by_id(&transaction, task_id)?
            .ok_or_else(|| StoreError::NotFound("任务不存在".to_owned()))?;
        append_mutation(
            &transaction,
            "task",
            task_id,
            "patch",
            &json!({ "status": "completed", "completedAt": completed_at }),
        )?;
        let next = if let Some(next) = next_task {
            insert_task(&transaction, &next)?;
            append_mutation(
                &transaction,
                "task",
                &next.id,
                "create",
                &serde_json::to_value(&next)?,
            )?;
            Some(next)
        } else {
            None
        };
        transaction.commit()?;
        Ok(CompleteResult {
            task: completed,
            next_task: next,
        })
    }

    pub fn delete_task(&self, id: &str) -> StoreResult<()> {
        validate_non_empty_id(id)?;
        let mut connection = self.lock()?;
        let transaction = connection.transaction()?;
        let Some(task) = task_by_id(&transaction, id)? else {
            return Ok(());
        };
        if task.deleted_at.is_some() {
            return Ok(());
        }
        let deleted_at = now();
        transaction.execute(
            "UPDATE local_tasks SET deleted_at = ?1, updated_at = ?1 WHERE id = ?2",
            params![deleted_at, id],
        )?;
        append_mutation(&transaction, "task", id, "delete", &json!({}))?;
        transaction.commit()?;
        Ok(())
    }

    pub fn restore_task(&self, id: &str) -> StoreResult<()> {
        validate_non_empty_id(id)?;
        let mut connection = self.lock()?;
        let transaction = connection.transaction()?;
        let Some(task) = task_by_id(&transaction, id)? else {
            return Ok(());
        };
        if task.deleted_at.is_none() {
            return Ok(());
        }
        transaction.execute(
            "UPDATE local_tasks SET deleted_at = NULL, updated_at = ?1 WHERE id = ?2",
            params![now(), id],
        )?;
        append_mutation(&transaction, "task", id, "restore", &json!({}))?;
        transaction.commit()?;
        Ok(())
    }

    pub fn reorder_task(&self, id: &str, direction: &str) -> StoreResult<()> {
        validate_non_empty_id(id)?;
        if direction != "up" && direction != "down" {
            return Err(StoreError::Validation(
                "direction 必须是 up 或 down".to_owned(),
            ));
        }
        let mut connection = self.lock()?;
        let transaction = connection.transaction()?;
        let current = task_by_id(&transaction, id)?
            .ok_or_else(|| StoreError::NotFound("任务不存在".to_owned()))?;
        if current.deleted_at.is_some() {
            return Err(StoreError::NotFound("任务不存在".to_owned()));
        }
        let mut siblings = if let Some(list_id) = &current.list_id {
            let mut statement = transaction.prepare(&format!(
                "SELECT {TASK_COLUMNS} FROM local_tasks
                 WHERE deleted_at IS NULL AND status = ?1 AND list_id = ?2"
            ))?;
            statement
                .query_map(params![current.status.as_str(), list_id], row_to_task)?
                .collect::<Result<Vec<_>, _>>()?
        } else {
            let mut statement = transaction.prepare(&format!(
                "SELECT {TASK_COLUMNS} FROM local_tasks
                 WHERE deleted_at IS NULL AND status = ?1 AND list_id IS NULL"
            ))?;
            statement
                .query_map([current.status.as_str()], row_to_task)?
                .collect::<Result<Vec<_>, _>>()?
        };
        siblings.sort_by(compare_tasks);
        let Some(index) = siblings.iter().position(|task| task.id == id) else {
            return Ok(());
        };
        let target = if direction == "up" {
            index.checked_sub(1)
        } else {
            Some(index + 1).filter(|target| *target < siblings.len())
        };
        let Some(target) = target else {
            return Ok(());
        };
        let other = siblings[target].clone();
        let updated_at = now();
        transaction.execute(
            "UPDATE local_tasks SET rank = ?1, updated_at = ?2 WHERE id = ?3",
            params![other.rank, updated_at, current.id],
        )?;
        transaction.execute(
            "UPDATE local_tasks SET rank = ?1, updated_at = ?2 WHERE id = ?3",
            params![current.rank, updated_at, other.id],
        )?;
        append_mutation(
            &transaction,
            "task",
            &current.id,
            "patch",
            &json!({ "rank": other.rank }),
        )?;
        append_mutation(
            &transaction,
            "task",
            &other.id,
            "patch",
            &json!({ "rank": current.rank }),
        )?;
        transaction.commit()?;
        Ok(())
    }

    // ------------------------------------------------------------------
    // Day plans
    // ------------------------------------------------------------------

    pub fn list_day_plan(&self, date: &str) -> StoreResult<Vec<TaskWithSteps>> {
        validate_date(date, "date")?;
        let connection = self.lock()?;
        let tasks = {
            let mut statement = connection.prepare(&format!(
                "SELECT {TASK_QUALIFIED}
                 FROM local_tasks t
                 JOIN local_day_plans p ON p.task_id = t.id
                 WHERE p.local_date = ?1 AND p.deleted_at IS NULL AND t.deleted_at IS NULL
                 ORDER BY p.rank ASC, t.created_at ASC"
            ))?;
            statement
                .query_map([date], row_to_task)?
                .collect::<Result<Vec<_>, _>>()?
        };
        attach_details(&connection, tasks)
    }

    pub fn add_to_day(&self, task_id: &str, date: &str) -> StoreResult<()> {
        validate_non_empty_id(task_id)?;
        validate_date(date, "date")?;
        let mut connection = self.lock()?;
        let transaction = connection.transaction()?;
        let task = task_by_id(&transaction, task_id)?
            .ok_or_else(|| StoreError::NotFound("任务不存在".to_owned()))?;
        if task.deleted_at.is_some() {
            return Err(StoreError::NotFound("任务不存在".to_owned()));
        }
        let existing = transaction
            .query_row(
                &format!(
                    "SELECT {DAY_PLAN_COLUMNS} FROM local_day_plans
                     WHERE task_id = ?1 AND local_date = ?2"
                ),
                params![task_id, date],
                row_to_day_plan,
            )
            .optional()?;
        if let Some(plan) = existing {
            if plan.deleted_at.is_some() {
                transaction.execute(
                    "UPDATE local_day_plans SET deleted_at = NULL, updated_at = ?1 WHERE id = ?2",
                    params![now(), plan.id],
                )?;
                append_mutation(&transaction, "day_plan", &plan.id, "restore", &json!({}))?;
            }
            transaction.commit()?;
            return Ok(());
        }
        let ranks = {
            let mut statement = transaction.prepare(
                "SELECT rank FROM local_day_plans
                 WHERE local_date = ?1 AND deleted_at IS NULL",
            )?;
            statement
                .query_map([date], |row| row.get::<_, String>(0))?
                .collect::<Result<Vec<_>, _>>()?
        };
        let created_at = now();
        let plan = DayPlan {
            id: Uuid::now_v7().to_string(),
            task_id: task_id.to_owned(),
            local_date: date.to_owned(),
            rank: next_rank(&ranks),
            created_at: created_at.clone(),
            updated_at: created_at,
            deleted_at: None,
        };
        insert_day_plan(&transaction, &plan)?;
        append_mutation(
            &transaction,
            "day_plan",
            &plan.id,
            "create",
            &serde_json::to_value(&plan)?,
        )?;
        transaction.commit()?;
        Ok(())
    }

    pub fn remove_from_day(&self, task_id: &str, date: &str) -> StoreResult<()> {
        validate_non_empty_id(task_id)?;
        validate_date(date, "date")?;
        let mut connection = self.lock()?;
        let transaction = connection.transaction()?;
        let existing = transaction
            .query_row(
                &format!(
                    "SELECT {DAY_PLAN_COLUMNS} FROM local_day_plans
                     WHERE task_id = ?1 AND local_date = ?2"
                ),
                params![task_id, date],
                row_to_day_plan,
            )
            .optional()?;
        let Some(plan) = existing else {
            return Ok(());
        };
        if plan.deleted_at.is_some() {
            return Ok(());
        }
        transaction.execute(
            "UPDATE local_day_plans SET deleted_at = ?1, updated_at = ?1 WHERE id = ?2",
            params![now(), plan.id],
        )?;
        append_mutation(&transaction, "day_plan", &plan.id, "delete", &json!({}))?;
        transaction.commit()?;
        Ok(())
    }

    // ------------------------------------------------------------------
    // Steps
    // ------------------------------------------------------------------

    pub fn create_step(&self, task_id: &str, title: &str) -> StoreResult<Step> {
        validate_non_empty_id(task_id)?;
        let title = clean_title(title)?;
        let mut connection = self.lock()?;
        let transaction = connection.transaction()?;
        let task = task_by_id(&transaction, task_id)?
            .ok_or_else(|| StoreError::NotFound("任务不存在".to_owned()))?;
        if task.deleted_at.is_some() {
            return Err(StoreError::NotFound("任务不存在".to_owned()));
        }
        let ranks = {
            let mut statement = transaction.prepare(
                "SELECT rank FROM local_steps WHERE task_id = ?1 AND deleted_at IS NULL",
            )?;
            statement
                .query_map([task_id], |row| row.get::<_, String>(0))?
                .collect::<Result<Vec<_>, _>>()?
        };
        let created_at = now();
        let step = Step {
            id: Uuid::now_v7().to_string(),
            task_id: task_id.to_owned(),
            title,
            is_completed: false,
            rank: next_rank(&ranks),
            created_at: created_at.clone(),
            updated_at: created_at,
            deleted_at: None,
        };
        insert_step(&transaction, &step)?;
        append_mutation(
            &transaction,
            "step",
            &step.id,
            "create",
            &serde_json::to_value(&step)?,
        )?;
        transaction.commit()?;
        Ok(step)
    }

    pub fn patch_step(&self, id: &str, patch: StepPatch) -> StoreResult<Step> {
        if patch.is_empty() {
            return Err(StoreError::Validation(
                "step patch must contain at least one field".to_owned(),
            ));
        }
        validate_non_empty_id(id)?;
        let mut connection = self.lock()?;
        let transaction = connection.transaction()?;
        let current = step_by_id(&transaction, id)?
            .ok_or_else(|| StoreError::NotFound("子步骤不存在".to_owned()))?;
        if current.deleted_at.is_some() {
            return Err(StoreError::NotFound("子步骤不存在".to_owned()));
        }
        let mut sets = Vec::new();
        let mut values: Vec<SqlValue> = Vec::new();
        if patch.title.is_some() {
            let title = clean_title(required(patch.title.as_ref(), "title")?)?;
            sets.push("title = ?");
            values.push(SqlValue::Text(title));
        }
        if patch.is_completed.is_some() {
            let is_completed = *required(patch.is_completed.as_ref(), "isCompleted")?;
            sets.push("is_completed = ?");
            values.push(SqlValue::Integer(i64::from(is_completed)));
        }
        if patch.rank.is_some() {
            let rank = required(patch.rank.as_ref(), "rank")?.trim();
            if rank.is_empty() || rank.chars().count() > 128 {
                return Err(StoreError::Validation("rank 无效".to_owned()));
            }
            sets.push("rank = ?");
            values.push(SqlValue::Text(rank.to_owned()));
        }
        sets.push("updated_at = ?");
        values.push(SqlValue::Text(now()));
        values.push(SqlValue::Text(id.to_owned()));
        transaction.execute(
            &format!("UPDATE local_steps SET {} WHERE id = ?", sets.join(", ")),
            params_from_iter(values),
        )?;
        let updated = step_by_id(&transaction, id)?
            .ok_or_else(|| StoreError::NotFound("子步骤不存在".to_owned()))?;
        append_mutation(
            &transaction,
            "step",
            id,
            "patch",
            &serde_json::to_value(&patch)?,
        )?;
        transaction.commit()?;
        Ok(updated)
    }

    pub fn delete_step(&self, id: &str) -> StoreResult<()> {
        validate_non_empty_id(id)?;
        let mut connection = self.lock()?;
        let transaction = connection.transaction()?;
        let Some(step) = step_by_id(&transaction, id)? else {
            return Ok(());
        };
        if step.deleted_at.is_some() {
            return Ok(());
        }
        transaction.execute(
            "UPDATE local_steps SET deleted_at = ?1, updated_at = ?1 WHERE id = ?2",
            params![now(), id],
        )?;
        append_mutation(&transaction, "step", id, "delete", &json!({}))?;
        transaction.commit()?;
        Ok(())
    }
}

// ----------------------------------------------------------------------
// Connection, migration, row mapping and validation helpers
// ----------------------------------------------------------------------

fn configure_connection(connection: &Connection) -> StoreResult<()> {
    connection.busy_timeout(Duration::from_secs(5))?;
    connection.pragma_update(None, "foreign_keys", "ON")?;
    let _: String = connection.query_row("PRAGMA journal_mode=WAL", [], |row| row.get(0))?;
    connection.pragma_update(None, "synchronous", "NORMAL")?;
    connection.pragma_update(None, "temp_store", "MEMORY")?;
    Ok(())
}

fn migrate(connection: &mut Connection) -> StoreResult<()> {
    connection.execute_batch(
        "CREATE TABLE IF NOT EXISTS schema_migrations (
           version INTEGER PRIMARY KEY,
           applied_at TEXT NOT NULL
         );",
    )?;
    let version: i64 = connection.query_row(
        "SELECT COALESCE(MAX(version), 0) FROM schema_migrations",
        [],
        |row| row.get(0),
    )?;
    if version >= 1 {
        // v1.1 migration for databases created before task tags existed.
        ensure_column(
            connection,
            "local_tasks",
            "tags_json",
            "TEXT NOT NULL DEFAULT '[]'",
        )?;
        return Ok(());
    }
    let transaction = connection.transaction()?;
    transaction.execute_batch(SCHEMA_V1)?;
    ensure_column(
        &transaction,
        "local_lists",
        "created_at",
        "TEXT NOT NULL DEFAULT ''",
    )?;
    ensure_column(
        &transaction,
        "local_lists",
        "updated_at",
        "TEXT NOT NULL DEFAULT ''",
    )?;
    ensure_column(
        &transaction,
        "local_steps",
        "created_at",
        "TEXT NOT NULL DEFAULT ''",
    )?;
    ensure_column(
        &transaction,
        "local_steps",
        "updated_at",
        "TEXT NOT NULL DEFAULT ''",
    )?;
    ensure_column(
        &transaction,
        "local_day_plans",
        "created_at",
        "TEXT NOT NULL DEFAULT ''",
    )?;
    ensure_column(
        &transaction,
        "local_day_plans",
        "updated_at",
        "TEXT NOT NULL DEFAULT ''",
    )?;
    ensure_column(
        &transaction,
        "local_tasks",
        "tags_json",
        "TEXT NOT NULL DEFAULT '[]'",
    )?;
    transaction.execute(
        "INSERT INTO schema_migrations (version, applied_at) VALUES (1, ?1)",
        params![now()],
    )?;
    transaction.commit()?;
    Ok(())
}

fn ensure_column(
    connection: &Connection,
    table: &str,
    column: &str,
    declaration: &str,
) -> StoreResult<()> {
    let mut statement = connection.prepare(&format!("PRAGMA table_info({table})"))?;
    let exists = statement
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<Result<Vec<_>, _>>()?
        .iter()
        .any(|name| name == column);
    drop(statement);
    if !exists {
        connection.execute_batch(&format!(
            "ALTER TABLE {table} ADD COLUMN {column} {declaration}"
        ))?;
    }
    Ok(())
}

fn ensure_local_identity(transaction: &Transaction<'_>) -> StoreResult<()> {
    let device_id: Option<String> = transaction
        .query_row(
            "SELECT value FROM kv_state WHERE key = 'device_id'",
            [],
            |row| row.get(0),
        )
        .optional()?;
    if device_id.is_none() {
        transaction.execute(
            "INSERT INTO kv_state (key, value) VALUES ('device_id', ?1)",
            params![Uuid::now_v7().to_string()],
        )?;
    }
    let client_seq: Option<String> = transaction
        .query_row(
            "SELECT value FROM kv_state WHERE key = 'client_seq'",
            [],
            |row| row.get(0),
        )
        .optional()?;
    if client_seq.is_none() {
        transaction.execute(
            "INSERT INTO kv_state (key, value) VALUES ('client_seq', '0')",
            [],
        )?;
    }
    let sync_cursor: Option<String> = transaction
        .query_row(
            "SELECT value FROM kv_state WHERE key = 'sync_cursor'",
            [],
            |row| row.get(0),
        )
        .optional()?;
    if sync_cursor.is_none() {
        transaction.execute(
            "INSERT INTO kv_state (key, value) VALUES ('sync_cursor', '0')",
            [],
        )?;
    }
    let sync_enabled: Option<String> = transaction
        .query_row(
            "SELECT value FROM kv_state WHERE key = 'sync_enabled'",
            [],
            |row| row.get(0),
        )
        .optional()?;
    if sync_enabled.is_none() {
        transaction.execute(
            "INSERT INTO kv_state (key, value) VALUES ('sync_enabled', 'false')",
            [],
        )?;
    }
    Ok(())
}

fn row_to_list(row: &Row<'_>) -> rusqlite::Result<TaskList> {
    Ok(TaskList {
        id: row.get(0)?,
        name: row.get(1)?,
        color: row.get(2)?,
        icon: row.get(3)?,
        rank: row.get(4)?,
        created_at: row.get(5)?,
        updated_at: row.get(6)?,
        deleted_at: row.get(7)?,
    })
}

fn row_to_task(row: &Row<'_>) -> rusqlite::Result<Task> {
    let status: String = row.get(4)?;
    let recurrence_json: Option<String> = row.get(12)?;
    let tags_json: String = row.get(17)?;
    Ok(Task {
        id: row.get(0)?,
        list_id: row.get(1)?,
        title: row.get(2)?,
        note: row.get(3)?,
        tags: serde_json::from_str::<Vec<String>>(&tags_json).unwrap_or_default(),
        status: TaskStatus::parse(&status).unwrap_or(TaskStatus::Open),
        important: row.get::<_, i64>(5)? != 0,
        due_on: row.get(6)?,
        remind_at: row.get(7)?,
        remind_timezone: row.get(8)?,
        rank: row.get(9)?,
        series_id: row.get(10)?,
        occurrence_key: row.get(11)?,
        recurrence: recurrence_json.and_then(|value| serde_json::from_str(&value).ok()),
        completed_at: row.get(13)?,
        created_at: row.get(14)?,
        updated_at: row.get(15)?,
        deleted_at: row.get(16)?,
    })
}

fn row_to_step(row: &Row<'_>) -> rusqlite::Result<Step> {
    Ok(Step {
        id: row.get(0)?,
        task_id: row.get(1)?,
        title: row.get(2)?,
        is_completed: row.get::<_, i64>(3)? != 0,
        rank: row.get(4)?,
        created_at: row.get(5)?,
        updated_at: row.get(6)?,
        deleted_at: row.get(7)?,
    })
}

fn row_to_day_plan(row: &Row<'_>) -> rusqlite::Result<DayPlan> {
    Ok(DayPlan {
        id: row.get(0)?,
        task_id: row.get(1)?,
        local_date: row.get(2)?,
        rank: row.get(3)?,
        created_at: row.get(4)?,
        updated_at: row.get(5)?,
        deleted_at: row.get(6)?,
    })
}

fn now() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn validate_non_empty_id(id: &str) -> StoreResult<()> {
    if id.trim().is_empty() || id.len() > 128 {
        return Err(StoreError::Validation("id 无效".to_owned()));
    }
    Ok(())
}

fn clean_single_line(value: &str, max_chars: usize) -> String {
    value
        .replace(['\r', '\n', '\t'], " ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(max_chars)
        .collect()
}

fn clean_title(value: &str) -> StoreResult<String> {
    let value = clean_single_line(value, 1000);
    if value.is_empty() {
        return Err(StoreError::Validation("任务标题不能为空".to_owned()));
    }
    Ok(value)
}

fn clean_list_name(value: &str) -> StoreResult<String> {
    let value = clean_single_line(value, 120);
    if value.is_empty() {
        return Err(StoreError::Validation("清单名称不能为空".to_owned()));
    }
    Ok(value)
}

fn clean_note(value: Option<&str>) -> String {
    value
        .unwrap_or_default()
        .replace("\r\n", "\n")
        .chars()
        .take(20_000)
        .collect()
}

/// Trims tags, removes case-insensitive duplicates and enforces v1.1 limits.
fn normalize_tags(tags: Vec<String>) -> StoreResult<Vec<String>> {
    let mut seen = HashSet::new();
    let mut normalized = Vec::new();
    for raw in tags {
        let tag = raw.trim();
        let length = tag.chars().count();
        if length == 0 || length > 32 {
            return Err(StoreError::Validation(
                "每个标签必须为 1–32 个字符".to_owned(),
            ));
        }
        if seen.insert(tag.to_lowercase()) {
            normalized.push(tag.to_owned());
        }
    }
    if normalized.len() > 20 {
        return Err(StoreError::Validation("任务标签最多 20 个".to_owned()));
    }
    Ok(normalized)
}

fn validate_date(value: &str, field: &str) -> StoreResult<()> {
    NaiveDate::parse_from_str(value, "%Y-%m-%d")
        .map(|_| ())
        .map_err(|_| StoreError::InvalidDate(format!("{field} 格式应为 YYYY-MM-DD")))
}

fn normalize_instant(value: &str, field: &str) -> StoreResult<String> {
    let parsed = DateTime::parse_from_rfc3339(value)
        .map_err(|_| StoreError::InvalidDate(format!("{field} 不是有效的 ISO-8601 时间")))?;
    Ok(parsed
        .with_timezone(&Utc)
        .to_rfc3339_opts(SecondsFormat::Millis, true))
}

fn validate_optional_text(
    field: &str,
    value: Option<String>,
    max_chars: usize,
) -> StoreResult<Option<String>> {
    match value {
        None => Ok(None),
        Some(value) => {
            let value = value.trim().to_owned();
            if value.chars().count() > max_chars {
                return Err(StoreError::Validation(format!("{field} 过长")));
            }
            Ok(if value.is_empty() { None } else { Some(value) })
        }
    }
}

fn optional_string_sql(
    value: Option<String>,
    field: &str,
    max_chars: usize,
) -> StoreResult<SqlValue> {
    Ok(match validate_optional_text(field, value, max_chars)? {
        Some(value) => SqlValue::Text(value),
        None => SqlValue::Null,
    })
}

fn required<'a, T>(value: Option<&'a Option<T>>, field: &str) -> StoreResult<&'a T> {
    value
        .and_then(|value| value.as_ref())
        .ok_or_else(|| StoreError::Validation(format!("{field} 不能为 null")))
}

fn required_optional<'a, T>(
    value: Option<&'a Option<T>>,
    field: &str,
) -> StoreResult<Option<&'a T>> {
    value
        .map(|value| value.as_ref())
        .ok_or_else(|| StoreError::Validation(format!("{field} 缺省")))
}

fn list_by_id(connection: &Connection, id: &str) -> StoreResult<Option<TaskList>> {
    Ok(connection
        .query_row(
            &format!("SELECT {LIST_COLUMNS} FROM local_lists WHERE id = ?1"),
            params![id],
            row_to_list,
        )
        .optional()?)
}

fn task_by_id(connection: &Connection, id: &str) -> StoreResult<Option<Task>> {
    Ok(connection
        .query_row(
            &format!("SELECT {TASK_COLUMNS} FROM local_tasks WHERE id = ?1"),
            params![id],
            row_to_task,
        )
        .optional()?)
}

fn step_by_id(connection: &Connection, id: &str) -> StoreResult<Option<Step>> {
    Ok(connection
        .query_row(
            &format!("SELECT {STEP_COLUMNS} FROM local_steps WHERE id = ?1"),
            params![id],
            row_to_step,
        )
        .optional()?)
}

fn sorted_lists(mut lists: Vec<TaskList>) -> Vec<TaskList> {
    lists.retain(|list| list.deleted_at.is_none());
    lists.sort_by(|left, right| {
        left.rank
            .cmp(&right.rank)
            .then_with(|| left.created_at.cmp(&right.created_at))
    });
    lists
}

fn parse_rank(rank: &str) -> u64 {
    u64::from_str_radix(rank, 36).unwrap_or(0)
}

fn encode_base36(mut value: u64) -> String {
    if value == 0 {
        return "0".to_owned();
    }
    const DIGITS: &[u8; 36] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    let mut result = Vec::new();
    while value > 0 {
        result.push(DIGITS[(value % 36) as usize] as char);
        value /= 36;
    }
    result.iter().rev().collect()
}

fn next_rank(rows: &[String]) -> String {
    let next = rows
        .iter()
        .map(|rank| parse_rank(rank))
        .max()
        .unwrap_or(0)
        .saturating_add(1);
    format!("{:0>6}", encode_base36(next))
}

fn append_mutation(
    transaction: &Transaction<'_>,
    entity: &str,
    entity_id: &str,
    kind: &str,
    patch: &Value,
) -> StoreResult<()> {
    let device_id: String = transaction
        .query_row(
            "SELECT value FROM kv_state WHERE key = 'device_id'",
            [],
            |row| row.get(0),
        )
        .map_err(|_| StoreError::Internal("device_id 尚未初始化".to_owned()))?;
    let current_seq: String = transaction
        .query_row(
            "SELECT value FROM kv_state WHERE key = 'client_seq'",
            [],
            |row| row.get(0),
        )
        .map_err(|_| StoreError::Internal("client_seq 尚未初始化".to_owned()))?;
    let max_outbox_seq: i64 = transaction.query_row(
        "SELECT COALESCE(MAX(client_seq), 0) FROM outbox WHERE device_id = ?1",
        [&device_id],
        |row| row.get(0),
    )?;
    let client_seq = current_seq
        .parse::<i64>()
        .map_err(|_| StoreError::Internal("client_seq 损坏".to_owned()))?
        .max(max_outbox_seq)
        .saturating_add(1);
    let sync_enabled: String = transaction
        .query_row(
            "SELECT value FROM kv_state WHERE key = 'sync_enabled'",
            [],
            |row| row.get(0),
        )
        .unwrap_or_else(|_| "false".to_owned());
    let status = if sync_enabled == "true" {
        "pending"
    } else {
        "local"
    };
    transaction.execute(
        "UPDATE kv_state SET value = ?1 WHERE key = 'client_seq'",
        params![client_seq.to_string()],
    )?;
    transaction.execute(
        "INSERT INTO outbox
           (op_id, device_id, client_seq, entity_type, entity_id, kind, patch_json,
            created_at, sync_status, error_code)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, NULL)",
        params![
            Uuid::now_v7().to_string(),
            device_id,
            client_seq,
            entity,
            entity_id,
            kind,
            serde_json::to_string(patch)?,
            now(),
            status
        ],
    )?;
    Ok(())
}

struct PreparedNewTask {
    list_id: Option<String>,
    title: String,
    note: String,
    tags: Vec<String>,
    important: bool,
    due_on: Option<String>,
    remind_at: Option<String>,
    remind_timezone: Option<String>,
    recurrence: Option<Value>,
    rank: Option<String>,
    plan_date: Option<String>,
}

fn prepare_new_task(input: NewTask) -> StoreResult<PreparedNewTask> {
    let title = clean_title(&input.title)?;
    if let Some(due_on) = &input.due_on {
        validate_date(due_on, "dueOn")?;
    }
    if let Some(plan_date) = &input.plan_date {
        validate_date(plan_date, "planDate")?;
    }
    let remind_at = match input.remind_at {
        Some(value) => Some(normalize_instant(&value, "remindAt")?),
        None => None,
    };
    let remind_timezone = match input.remind_timezone {
        Some(value) => {
            let value = value.trim().to_owned();
            if value.is_empty() || value.chars().count() > 64 {
                return Err(StoreError::Validation("remindTimezone 无效".to_owned()));
            }
            Some(value)
        }
        None => None,
    };
    if let Some(recurrence) = &input.recurrence
        && !recurrence.is_object()
    {
        return Err(StoreError::Validation(
            "recurrence 必须是 JSON 对象".to_owned(),
        ));
    }
    let rank = match input.rank {
        Some(rank) => {
            let rank = rank.trim().to_owned();
            if rank.is_empty() || rank.chars().count() > 128 {
                return Err(StoreError::Validation("rank 无效".to_owned()));
            }
            Some(rank)
        }
        None => None,
    };
    Ok(PreparedNewTask {
        list_id: input.list_id,
        title,
        note: clean_note(input.note.as_deref()),
        tags: normalize_tags(input.tags)?,
        important: input.important.unwrap_or(false),
        due_on: input.due_on,
        remind_at,
        remind_timezone,
        recurrence: input.recurrence,
        rank,
        plan_date: input.plan_date,
    })
}

fn ensure_active_list(connection: &Connection, list_id: &str) -> StoreResult<()> {
    validate_non_empty_id(list_id)?;
    match list_by_id(connection, list_id)? {
        Some(list) if list.deleted_at.is_none() => Ok(()),
        _ => Err(StoreError::NotFound("清单不存在".to_owned())),
    }
}

fn insert_task(connection: &Connection, task: &Task) -> StoreResult<()> {
    validate_non_empty_id(&task.id)?;
    clean_title(&task.title)?;
    connection.execute(
        "INSERT INTO local_tasks
           (id, list_id, title, note, status, important, due_on, remind_at,
            remind_timezone, rank, series_id, occurrence_key, recurrence_json,
            completed_at, created_at, updated_at, deleted_at, tags_json)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18)",
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

fn insert_step(connection: &Connection, step: &Step) -> StoreResult<()> {
    connection.execute(
        "INSERT INTO local_steps
           (id, task_id, title, is_completed, rank, created_at, updated_at, deleted_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
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

fn insert_day_plan(connection: &Connection, plan: &DayPlan) -> StoreResult<()> {
    connection.execute(
        "INSERT INTO local_day_plans
           (id, task_id, local_date, rank, created_at, updated_at, deleted_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
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

fn task_matches_query(task: &Task, query: &TaskQuery) -> bool {
    if task.deleted_at.is_some() {
        return false;
    }
    if query.view == TaskView::Completed {
        if task.status != TaskStatus::Completed {
            return false;
        }
    } else if !query.include_completed && task.status != TaskStatus::Open {
        return false;
    }
    if query.view == TaskView::Important && !task.important {
        return false;
    }
    if query.view == TaskView::Planned && task.due_on.is_none() {
        return false;
    }
    if query.view == TaskView::List && task.list_id != query.list_id {
        return false;
    }
    if let Some(due_from) = &query.due_from
        && task
            .due_on
            .as_deref()
            .is_none_or(|due| due < due_from.as_str())
    {
        return false;
    }
    if let Some(due_to) = &query.due_to
        && task
            .due_on
            .as_deref()
            .is_none_or(|due| due > due_to.as_str())
    {
        return false;
    }
    if !query.tags.is_empty() {
        let task_tags = task
            .tags
            .iter()
            .map(|tag| tag.to_lowercase())
            .collect::<HashSet<_>>();
        if !query
            .tags
            .iter()
            .map(|tag| tag.trim().to_lowercase())
            .all(|tag| task_tags.contains(&tag))
        {
            return false;
        }
    }
    task_matches_search(task, query.search.as_deref().unwrap_or_default())
}

fn task_matches_search(task: &Task, search: &str) -> bool {
    let needle = search.trim().to_lowercase();
    if needle.is_empty() {
        return true;
    }
    let haystack = format!("{}\n{}\n{}", task.title, task.note, task.tags.join(" ")).to_lowercase();
    needle
        .split_whitespace()
        .all(|token| haystack.contains(token))
}

fn compare_tasks(left: &Task, right: &Task) -> Ordering {
    if left.status != right.status {
        return if left.status == TaskStatus::Open {
            Ordering::Less
        } else {
            Ordering::Greater
        };
    }
    match (&left.due_on, &right.due_on) {
        (Some(left_due), Some(right_due)) if left_due != right_due => left_due.cmp(right_due),
        (Some(_), None) => Ordering::Less,
        (None, Some(_)) => Ordering::Greater,
        _ => left
            .rank
            .cmp(&right.rank)
            .then_with(|| left.created_at.cmp(&right.created_at)),
    }
}

fn attach_details(connection: &Connection, tasks: Vec<Task>) -> StoreResult<Vec<TaskWithSteps>> {
    if tasks.is_empty() {
        return Ok(Vec::new());
    }
    let ids = tasks.iter().map(|task| task.id.clone()).collect::<Vec<_>>();
    let placeholders = std::iter::repeat_n("?", ids.len())
        .collect::<Vec<_>>()
        .join(",");
    let mut index_by_task = HashMap::new();
    for (index, id) in ids.iter().enumerate() {
        index_by_task.insert(id.clone(), index);
    }
    let mut steps = vec![Vec::new(); tasks.len()];
    {
        let mut statement = connection.prepare(&format!(
            "SELECT {STEP_COLUMNS} FROM local_steps
             WHERE deleted_at IS NULL AND task_id IN ({placeholders})
             ORDER BY rank ASC, created_at ASC"
        ))?;
        let rows = statement.query_map(params_from_iter(ids.iter()), row_to_step)?;
        for row in rows {
            let step = row?;
            if let Some(index) = index_by_task.get(&step.task_id) {
                steps[*index].push(step);
            }
        }
    }
    let mut dates = vec![Vec::new(); tasks.len()];
    {
        let mut statement = connection.prepare(&format!(
            "SELECT task_id, local_date FROM local_day_plans
             WHERE deleted_at IS NULL AND task_id IN ({placeholders})
             ORDER BY local_date ASC, rank ASC"
        ))?;
        let rows = statement.query_map(params_from_iter(ids.iter()), |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?;
        for row in rows {
            let (task_id, local_date) = row?;
            if let Some(index) = index_by_task.get(&task_id) {
                dates[*index].push(local_date);
            }
        }
    }
    Ok(tasks
        .into_iter()
        .enumerate()
        .map(|(index, task)| TaskWithSteps {
            task,
            steps: std::mem::take(&mut steps[index]),
            day_plan_dates: std::mem::take(&mut dates[index]),
        })
        .collect())
}

impl TodoStore {
    // ------------------------------------------------------------------
    // Export/import and local reset
    // ------------------------------------------------------------------

    pub fn export_data(&self) -> StoreResult<ExportBundle> {
        let connection = self.lock()?;
        let lists = {
            let mut statement =
                connection.prepare(&format!("SELECT {LIST_COLUMNS} FROM local_lists"))?;
            let mut lists = statement
                .query_map([], row_to_list)?
                .collect::<Result<Vec<_>, _>>()?;
            lists.sort_by(|left, right| {
                left.rank
                    .cmp(&right.rank)
                    .then_with(|| left.created_at.cmp(&right.created_at))
            });
            lists
        };
        let tasks = {
            let mut statement =
                connection.prepare(&format!("SELECT {TASK_COLUMNS} FROM local_tasks"))?;
            let mut tasks = statement
                .query_map([], row_to_task)?
                .collect::<Result<Vec<_>, _>>()?;
            tasks.sort_by(compare_tasks);
            tasks
        };
        let steps = {
            let mut statement =
                connection.prepare(&format!("SELECT {STEP_COLUMNS} FROM local_steps"))?;
            let mut steps = statement
                .query_map([], row_to_step)?
                .collect::<Result<Vec<_>, _>>()?;
            steps.sort_by(|left, right| {
                left.task_id
                    .cmp(&right.task_id)
                    .then_with(|| left.rank.cmp(&right.rank))
                    .then_with(|| left.created_at.cmp(&right.created_at))
            });
            steps
        };
        let day_plans = {
            let mut statement =
                connection.prepare(&format!("SELECT {DAY_PLAN_COLUMNS} FROM local_day_plans"))?;
            let mut plans = statement
                .query_map([], row_to_day_plan)?
                .collect::<Result<Vec<_>, _>>()?;
            plans.sort_by(|left, right| {
                left.local_date
                    .cmp(&right.local_date)
                    .then_with(|| left.rank.cmp(&right.rank))
            });
            plans
        };
        Ok(ExportBundle {
            format: "todo-export".to_owned(),
            version: 1,
            exported_at: now(),
            app_version: "1.0.0".to_owned(),
            tasks,
            lists,
            steps,
            day_plans,
        })
    }

    pub fn import_data(&self, request: ImportRequest) -> StoreResult<()> {
        if request.bundle.format != "todo-export" || request.bundle.version != 1 {
            return Err(StoreError::Validation("备份格式不受支持".to_owned()));
        }
        for list in &request.bundle.lists {
            clean_list_name(&list.name)?;
        }
        for task in &request.bundle.tasks {
            clean_title(&task.title)?;
        }
        let mut connection = self.lock()?;
        let transaction = connection.transaction()?;
        if matches!(request.mode, ImportMode::Replace) {
            transaction.execute("DELETE FROM local_day_plans", [])?;
            transaction.execute("DELETE FROM local_steps", [])?;
            transaction.execute("DELETE FROM local_tasks", [])?;
            transaction.execute("DELETE FROM local_lists", [])?;
            transaction.execute("DELETE FROM outbox", [])?;
            transaction.execute("DELETE FROM server_shadow", [])?;
        }

        for list in request.bundle.lists {
            let exists: bool = transaction.query_row(
                "SELECT EXISTS(SELECT 1 FROM local_lists WHERE id = ?1)",
                [&list.id],
                |row| row.get(0),
            )?;
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
            append_mutation(
                &transaction,
                "list",
                &list.id,
                if exists { "patch" } else { "create" },
                &serde_json::to_value(&list)?,
            )?;
        }
        for mut task in request.bundle.tasks {
            task.tags = normalize_tags(task.tags)?;
            let exists: bool = transaction.query_row(
                "SELECT EXISTS(SELECT 1 FROM local_tasks WHERE id = ?1)",
                [&task.id],
                |row| row.get(0),
            )?;
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
            append_mutation(
                &transaction,
                "task",
                &task.id,
                if exists { "patch" } else { "create" },
                &serde_json::to_value(&task)?,
            )?;
        }
        for step in request.bundle.steps {
            let exists: bool = transaction.query_row(
                "SELECT EXISTS(SELECT 1 FROM local_steps WHERE id = ?1)",
                [&step.id],
                |row| row.get(0),
            )?;
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
            append_mutation(
                &transaction,
                "step",
                &step.id,
                if exists { "patch" } else { "create" },
                &serde_json::to_value(&step)?,
            )?;
        }
        for plan in request.bundle.day_plans {
            let exists: bool = transaction.query_row(
                "SELECT EXISTS(SELECT 1 FROM local_day_plans WHERE id = ?1)",
                [&plan.id],
                |row| row.get(0),
            )?;
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
            append_mutation(
                &transaction,
                "day_plan",
                &plan.id,
                if exists { "patch" } else { "create" },
                &serde_json::to_value(&plan)?,
            )?;
        }
        transaction.commit()?;
        Ok(())
    }

    pub fn clear_all(&self) -> StoreResult<()> {
        let mut connection = self.lock()?;
        let transaction = connection.transaction()?;
        transaction.execute("DELETE FROM local_day_plans", [])?;
        transaction.execute("DELETE FROM local_steps", [])?;
        transaction.execute("DELETE FROM local_tasks", [])?;
        transaction.execute("DELETE FROM local_lists", [])?;
        transaction.execute("DELETE FROM outbox", [])?;
        transaction.execute("DELETE FROM server_shadow", [])?;
        transaction.commit()?;
        Ok(())
    }

    // ------------------------------------------------------------------
    // Sync-backed identity, cursor and outbox
    // ------------------------------------------------------------------

    pub fn get_device_id(&self) -> StoreResult<String> {
        let mut connection = self.lock()?;
        let transaction = connection.transaction()?;
        ensure_local_identity(&transaction)?;
        let id: String = transaction.query_row(
            "SELECT value FROM kv_state WHERE key = 'device_id'",
            [],
            |row| row.get(0),
        )?;
        transaction.commit()?;
        Ok(id)
    }

    pub fn get_sync_cursor(&self) -> StoreResult<String> {
        let connection = self.lock()?;
        Ok(connection
            .query_row(
                "SELECT value FROM kv_state WHERE key = 'sync_cursor'",
                [],
                |row| row.get(0),
            )
            .optional()?
            .unwrap_or_else(|| "0".to_owned()))
    }

    pub fn bootstrap_required(&self) -> StoreResult<()> {
        let connection = self.lock()?;
        connection.execute(
            "INSERT INTO kv_state (key, value) VALUES ('bootstrap_required', '1')
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            [],
        )?;
        Ok(())
    }

    pub fn pending_mutations(&self, limit: u32) -> StoreResult<Vec<StoredMutation>> {
        let limit = limit.clamp(1, 500);
        let connection = self.lock()?;
        let mut statement = connection.prepare(
            "SELECT op_id, device_id, client_seq, entity_type, entity_id, kind,
                    patch_json, created_at, sync_status, error_code
             FROM outbox
             WHERE sync_status = 'pending'
             ORDER BY client_seq ASC
             LIMIT ?1",
        )?;
        let rows = statement.query_map([limit], |row| {
            let patch_json: String = row.get(6)?;
            Ok(StoredMutation {
                op_id: row.get(0)?,
                device_id: row.get(1)?,
                client_seq: row.get(2)?,
                entity: row.get(3)?,
                entity_id: row.get(4)?,
                kind: row.get(5)?,
                patch: serde_json::from_str(&patch_json).unwrap_or(Value::Null),
                created_at: row.get(7)?,
                status: row.get(8)?,
                error_code: row.get(9)?,
            })
        })?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    pub fn apply_server_result(&self, request: ApplyServerResultRequest) -> StoreResult<()> {
        let mut connection = self.lock()?;
        let transaction = connection.transaction()?;
        let mut affected = Vec::new();
        for ack in &request.acks {
            // Acks only carry opId. Resolve the entity before deleting the
            // outbox row so the projection can be rebuilt from the shadow.
            let acknowledged: Option<(String, String)> = transaction
                .query_row(
                    "SELECT entity_type, entity_id FROM outbox WHERE op_id = ?1",
                    params![&ack.op_id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()?;
            if let Some(entity) = acknowledged {
                affected.push(entity);
            }
            match ack.status.as_str() {
                "rejected" => {
                    transaction.execute(
                        "UPDATE outbox SET sync_status = 'rejected', error_code = ?1
                         WHERE op_id = ?2",
                        params![ack.error_code.as_deref(), &ack.op_id],
                    )?;
                }
                "applied" | "already_processed" | "accepted" => {
                    transaction.execute("DELETE FROM outbox WHERE op_id = ?1", [&ack.op_id])?;
                }
                _ => {}
            }
        }
        for change in request.changes {
            affected.push((change.entity.clone(), change.entity_id.clone()));
            apply_server_change(&transaction, change)?;
        }
        // Remote changes and acknowledgements can only be observed through the
        // shadow. Replaying remaining pending mutations keeps local fields
        // (including same-field local edits) authoritative over remote data.
        let now = now();
        sync_support::reproject_entities(&transaction, affected, &now)?;
        transaction.execute(
            "INSERT INTO kv_state (key, value) VALUES ('sync_cursor', ?1)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            [&request.next_cursor],
        )?;
        transaction.execute(
            "UPDATE kv_state SET value = '0' WHERE key = 'bootstrap_required'",
            [],
        )?;
        transaction.commit()?;
        Ok(())
    }
}

fn apply_server_change(transaction: &Transaction<'_>, change: ServerChange) -> StoreResult<()> {
    let mut patch_object = match &change.patch {
        Value::Object(object) => object.clone(),
        Value::Null => Map::new(),
        _ => {
            return Err(StoreError::Validation(
                "server change patch 必须是对象".to_owned(),
            ));
        }
    };
    patch_object = camelize_object(patch_object);
    let now = now();
    match change.kind.as_str() {
        "delete" => {
            patch_object
                .entry("deletedAt".to_owned())
                .or_insert_with(|| Value::String(now.clone()));
        }
        "restore" => {
            patch_object.insert("deletedAt".to_owned(), Value::Null);
        }
        "create" | "patch" => {}
        other => {
            return Err(StoreError::Unsupported(format!(
                "unknown server change kind: {other}"
            )));
        }
    }
    let normalized_patch = Value::Object(patch_object.clone());

    let shadow_json: Option<String> = transaction
        .query_row(
            "SELECT payload_json FROM server_shadow
             WHERE entity_type = ?1 AND entity_id = ?2",
            params![change.entity, change.entity_id],
            |row| row.get(0),
        )
        .optional()?;
    let mut merged_shadow = shadow_json
        .and_then(|value| serde_json::from_str::<Value>(&value).ok())
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default();
    for (key, value) in &patch_object {
        merged_shadow.insert(key.clone(), value.clone());
    }
    transaction.execute(
        "INSERT INTO server_shadow (entity_type, entity_id, server_rev, payload_json)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(entity_type, entity_id) DO UPDATE SET
           server_rev = excluded.server_rev,
           payload_json = excluded.payload_json",
        params![
            change.entity,
            change.entity_id,
            change.server_seq,
            serde_json::to_string(&Value::Object(merged_shadow.clone()))?
        ],
    )?;

    apply_materialized_change(
        transaction,
        &change.entity,
        &change.entity_id,
        &change.kind,
        &normalized_patch,
        &merged_shadow,
        &now,
    )
}

/// Convert top-level server snake_case keys to the domain's camelCase keys.
fn camelize_object(object: Map<String, Value>) -> Map<String, Value> {
    object
        .into_iter()
        .map(|(key, value)| (snake_to_camel(&key), value))
        .collect()
}

fn snake_to_camel(value: &str) -> String {
    let mut result = String::with_capacity(value.len());
    let mut uppercase = false;
    for character in value.chars() {
        if character == '_' {
            uppercase = true;
        } else if uppercase {
            result.extend(character.to_uppercase());
            uppercase = false;
        } else {
            result.push(character);
        }
    }
    result
}

fn apply_materialized_change(
    transaction: &Transaction<'_>,
    entity: &str,
    entity_id: &str,
    kind: &str,
    patch: &Value,
    merged: &Map<String, Value>,
    now: &str,
) -> StoreResult<()> {
    let exists: bool = match entity {
        "task" => transaction.query_row(
            "SELECT EXISTS(SELECT 1 FROM local_tasks WHERE id = ?1)",
            [entity_id],
            |row| row.get(0),
        )?,
        "list" => transaction.query_row(
            "SELECT EXISTS(SELECT 1 FROM local_lists WHERE id = ?1)",
            [entity_id],
            |row| row.get(0),
        )?,
        "step" => transaction.query_row(
            "SELECT EXISTS(SELECT 1 FROM local_steps WHERE id = ?1)",
            [entity_id],
            |row| row.get(0),
        )?,
        "day_plan" => transaction.query_row(
            "SELECT EXISTS(SELECT 1 FROM local_day_plans WHERE id = ?1)",
            [entity_id],
            |row| row.get(0),
        )?,
        other => {
            return Err(StoreError::Unsupported(format!(
                "unknown server entity: {other}"
            )));
        }
    };

    if exists {
        // An UPDATE applies only the fields in this change. Delete/restore
        // state was normalized into the patch above.
        let (table, id_column) = match entity {
            "task" => ("local_tasks", "id"),
            "list" => ("local_lists", "id"),
            "step" => ("local_steps", "id"),
            "day_plan" => ("local_day_plans", "id"),
            _ => unreachable!(),
        };
        let assignments = server_assignments(entity, patch)?;
        let mut sql_parts = Vec::new();
        let mut values = Vec::new();
        for (column, value) in assignments {
            sql_parts.push(format!("{column} = ?"));
            values.push(value);
        }
        sql_parts.push("updated_at = ?".to_owned());
        values.push(SqlValue::Text(now.to_owned()));
        values.push(SqlValue::Text(entity_id.to_owned()));
        transaction.execute(
            &format!(
                "UPDATE {table} SET {} WHERE {id_column} = ?",
                sql_parts.join(", ")
            ),
            params_from_iter(values),
        )?;
        return Ok(());
    }

    if kind != "create" {
        // Shadow state is still retained; materialization will catch up on a
        // later bootstrap if an earlier page was missing the parent row.
        return Ok(());
    }

    match entity {
        "task" => {
            let list_id = optional_text_value(merged.get("listId"))?;
            if let Some(list_id) = &list_id {
                ensure_active_list(transaction, list_id)?;
            }
            let task = Task {
                id: entity_id.to_owned(),
                list_id,
                title: merged
                    .get("title")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
                    .filter(|title| !title.trim().is_empty())
                    .unwrap_or_else(|| "未命名任务".to_owned()),
                note: merged
                    .get("note")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned(),
                tags: sync_support::tags_from_data(merged),
                status: merged
                    .get("status")
                    .and_then(Value::as_str)
                    .and_then(TaskStatus::parse)
                    .unwrap_or(TaskStatus::Open),
                important: bool_value(merged.get("important")).unwrap_or(false),
                due_on: optional_text_value(merged.get("dueOn"))?,
                remind_at: optional_text_value(merged.get("remindAt"))?,
                remind_timezone: optional_text_value(merged.get("remindTimezone"))?,
                rank: merged
                    .get("rank")
                    .and_then(Value::as_str)
                    .unwrap_or("a0")
                    .to_owned(),
                series_id: optional_text_value(merged.get("seriesId"))?,
                occurrence_key: optional_text_value(merged.get("occurrenceKey"))?,
                recurrence: merged
                    .get("recurrence")
                    .filter(|value| value.is_object())
                    .cloned(),
                completed_at: optional_text_value(merged.get("completedAt"))?,
                created_at: merged
                    .get("createdAt")
                    .and_then(Value::as_str)
                    .unwrap_or(now)
                    .to_owned(),
                updated_at: now.to_owned(),
                deleted_at: optional_text_value(merged.get("deletedAt"))?,
            };
            insert_task(transaction, &task)?;
        }
        "list" => {
            let list = TaskList {
                id: entity_id.to_owned(),
                name: merged
                    .get("name")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
                    .filter(|name| !name.trim().is_empty())
                    .unwrap_or_else(|| "未命名清单".to_owned()),
                color: optional_text_value(merged.get("color"))?,
                icon: optional_text_value(merged.get("icon"))?,
                rank: merged
                    .get("rank")
                    .and_then(Value::as_str)
                    .unwrap_or("a0")
                    .to_owned(),
                created_at: merged
                    .get("createdAt")
                    .and_then(Value::as_str)
                    .unwrap_or(now)
                    .to_owned(),
                updated_at: now.to_owned(),
                deleted_at: optional_text_value(merged.get("deletedAt"))?,
            };
            transaction.execute(
                "INSERT INTO local_lists
                   (id, name, color, icon, rank, created_at, updated_at, deleted_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
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
        }
        "step" => {
            let Some(task_id) = optional_text_value(merged.get("taskId"))? else {
                return Ok(());
            };
            let step = Step {
                id: entity_id.to_owned(),
                task_id,
                title: merged
                    .get("title")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned(),
                is_completed: bool_value(merged.get("isCompleted")).unwrap_or(false),
                rank: merged
                    .get("rank")
                    .and_then(Value::as_str)
                    .unwrap_or("a0")
                    .to_owned(),
                created_at: merged
                    .get("createdAt")
                    .and_then(Value::as_str)
                    .unwrap_or(now)
                    .to_owned(),
                updated_at: now.to_owned(),
                deleted_at: optional_text_value(merged.get("deletedAt"))?,
            };
            insert_step(transaction, &step)?;
        }
        "day_plan" => {
            let Some(task_id) = optional_text_value(merged.get("taskId"))? else {
                return Ok(());
            };
            let Some(local_date) = optional_text_value(merged.get("localDate"))? else {
                return Ok(());
            };
            let plan = DayPlan {
                id: entity_id.to_owned(),
                task_id,
                local_date,
                rank: merged
                    .get("rank")
                    .and_then(Value::as_str)
                    .unwrap_or("a0")
                    .to_owned(),
                created_at: merged
                    .get("createdAt")
                    .and_then(Value::as_str)
                    .unwrap_or(now)
                    .to_owned(),
                updated_at: now.to_owned(),
                deleted_at: optional_text_value(merged.get("deletedAt"))?,
            };
            insert_day_plan(transaction, &plan)?;
        }
        _ => unreachable!(),
    }
    Ok(())
}

fn server_assignments(entity: &str, patch: &Value) -> StoreResult<Vec<(&'static str, SqlValue)>> {
    let Some(object) = patch.as_object() else {
        return Ok(Vec::new());
    };
    let mut assignments = Vec::new();
    for (key, value) in object {
        let mapping: Option<(&'static str, FieldKind)> = match entity {
            "task" => match key.as_str() {
                "listId" => Some(("list_id", FieldKind::Text)),
                "title" => Some(("title", FieldKind::Text)),
                "note" => Some(("note", FieldKind::Text)),
                "tags" => Some(("tags_json", FieldKind::Json)),
                "status" => Some(("status", FieldKind::Text)),
                "important" => Some(("important", FieldKind::Bool)),
                "dueOn" => Some(("due_on", FieldKind::Text)),
                "remindAt" => Some(("remind_at", FieldKind::Text)),
                "remindTimezone" => Some(("remind_timezone", FieldKind::Text)),
                "rank" => Some(("rank", FieldKind::Text)),
                "seriesId" => Some(("series_id", FieldKind::Text)),
                "occurrenceKey" => Some(("occurrence_key", FieldKind::Text)),
                "recurrence" => Some(("recurrence_json", FieldKind::Json)),
                "completedAt" => Some(("completed_at", FieldKind::Text)),
                "createdAt" => Some(("created_at", FieldKind::Text)),
                "deletedAt" => Some(("deleted_at", FieldKind::Text)),
                _ => None,
            },
            "list" => match key.as_str() {
                "name" => Some(("name", FieldKind::Text)),
                "color" => Some(("color", FieldKind::Text)),
                "icon" => Some(("icon", FieldKind::Text)),
                "rank" => Some(("rank", FieldKind::Text)),
                "createdAt" => Some(("created_at", FieldKind::Text)),
                "deletedAt" => Some(("deleted_at", FieldKind::Text)),
                _ => None,
            },
            "step" => match key.as_str() {
                "taskId" => Some(("task_id", FieldKind::Text)),
                "title" => Some(("title", FieldKind::Text)),
                "isCompleted" => Some(("is_completed", FieldKind::Bool)),
                "rank" => Some(("rank", FieldKind::Text)),
                "createdAt" => Some(("created_at", FieldKind::Text)),
                "deletedAt" => Some(("deleted_at", FieldKind::Text)),
                _ => None,
            },
            "day_plan" => match key.as_str() {
                "taskId" => Some(("task_id", FieldKind::Text)),
                "localDate" => Some(("local_date", FieldKind::Text)),
                "rank" => Some(("rank", FieldKind::Text)),
                "createdAt" => Some(("created_at", FieldKind::Text)),
                "deletedAt" => Some(("deleted_at", FieldKind::Text)),
                _ => None,
            },
            _ => None,
        };
        if let Some((column, field_kind)) = mapping {
            let sql_value = match field_kind {
                FieldKind::Text => {
                    optional_text_value(Some(value))?.map_or(SqlValue::Null, SqlValue::Text)
                }
                FieldKind::Bool => bool_value(Some(value))
                    .map(|value| SqlValue::Integer(i64::from(value)))
                    .unwrap_or(SqlValue::Null),
                FieldKind::Json => match value {
                    Value::Null => SqlValue::Null,
                    value => SqlValue::Text(serde_json::to_string(value)?),
                },
            };
            assignments.push((column, sql_value));
        }
    }
    Ok(assignments)
}

enum FieldKind {
    Text,
    Bool,
    Json,
}

fn optional_text_value(value: Option<&Value>) -> StoreResult<Option<String>> {
    match value {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) => Ok(Some(value.clone())),
        Some(_) => Err(StoreError::Validation(
            "server change expected a string".to_owned(),
        )),
    }
}

fn bool_value(value: Option<&Value>) -> Option<bool> {
    match value {
        Some(Value::Bool(value)) => Some(*value),
        Some(Value::Number(value)) => Some(value.as_i64().unwrap_or(0) != 0),
        _ => None,
    }
}

impl TodoStore {
    /// Open tasks with a reminder, used by the native reminder bridge when
    /// rebuilding the in-process desktop queue.
    pub fn upcoming_reminders(&self) -> StoreResult<Vec<Task>> {
        let connection = self.lock()?;
        let mut statement = connection.prepare(&format!(
            "SELECT {TASK_COLUMNS} FROM local_tasks
             WHERE deleted_at IS NULL AND status = 'open' AND remind_at IS NOT NULL
             ORDER BY remind_at ASC"
        ))?;
        Ok(statement
            .query_map([], row_to_task)?
            .collect::<Result<Vec<_>, _>>()?)
    }
}
