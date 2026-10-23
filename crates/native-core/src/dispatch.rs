use serde::Deserialize;
use serde_json::{Value, json};

use crate::{
    error::{StoreError, StoreResult},
    models::*,
    store::TodoStore,
};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct IdPayload {
    id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ListIdPayload {
    id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ListPatchPayload {
    id: String,
    patch: ListPatch,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TaskPatchPayload {
    id: String,
    patch: TaskPatch,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StepPatchPayload {
    id: String,
    patch: StepPatch,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CommitCompletionPayload {
    task_id: String,
    completed_at: String,
    #[serde(default)]
    next_task: Option<Task>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReorderPayload {
    id: String,
    direction: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TaskDayPayload {
    task_id: String,
    date: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateStepPayload {
    task_id: String,
    title: String,
}

#[derive(Debug, Deserialize)]
struct CountsPayload {
    #[serde(rename = "localDate")]
    local_date: String,
}

#[derive(Debug, Deserialize)]
struct PendingPayload {
    limit: Option<u32>,
}

#[derive(Debug, Deserialize)]
struct DatePayload {
    date: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SyncSessionPayload {
    #[serde(default)]
    session_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SyncSessionClearPayload {
    #[serde(default)]
    expected_session_id: Option<String>,
}

/// Execute one frontend storage action against the SQLite store.
///
/// The action surface is deliberately finite: no SQL, file or shell input
/// crosses this boundary. Wrappers accepted here (`input`/`query`) keep the
/// bridge compatible with the first generated client adapter while the
/// canonical contract is a direct payload.
pub fn dispatch(store: &TodoStore, action: &str, payload: Value) -> StoreResult<Value> {
    match action {
        "initialize" => {
            store.initialize()?;
            Ok(Value::Null)
        }
        "list_lists" => serialize(store.list_lists()?),
        "create_list" => {
            let payload = unwrap_alias(payload, &["input"]);
            let input: NewList = parse(payload)?;
            serialize(store.create_list(input)?)
        }
        "patch_list" => {
            let payload = unwrap_alias(payload, &["input"]);
            let request: ListPatchPayload = parse(payload)?;
            serialize(store.patch_list(&request.id, request.patch)?)
        }
        "delete_list" => {
            let request: ListIdPayload = parse(payload)?;
            store.delete_list(&request.id)?;
            Ok(Value::Null)
        }
        "restore_list" => {
            let request: ListIdPayload = parse(payload)?;
            store.restore_list(&request.id)?;
            Ok(Value::Null)
        }
        "create_task" => {
            let payload = unwrap_alias(payload, &["input"]);
            let input: NewTask = parse(payload)?;
            serialize(store.create_task(input)?)
        }
        "patch_task" => {
            let request: TaskPatchPayload = parse(payload)?;
            serialize(store.patch_task(&request.id, request.patch)?)
        }
        "get_task" => {
            let request: IdPayload = parse(payload)?;
            serialize(store.get_task(&request.id)?)
        }
        "list_tasks" => {
            let payload = unwrap_alias(payload, &["query"]);
            let query: TaskQuery = parse(payload)?;
            serialize(store.list_tasks(query)?)
        }
        "list_reminder_candidates" => serialize(store.upcoming_reminders()?),
        "get_counts" => {
            let request: CountsPayload = parse(payload)?;
            serialize(store.get_counts(&request.local_date)?)
        }
        "commit_completion" => {
            let request: CommitCompletionPayload = parse(payload)?;
            serialize(store.commit_completion(
                &request.task_id,
                &request.completed_at,
                request.next_task,
            )?)
        }
        "delete_task" => {
            let request: IdPayload = parse(payload)?;
            store.delete_task(&request.id)?;
            Ok(Value::Null)
        }
        "restore_task" => {
            let request: IdPayload = parse(payload)?;
            store.restore_task(&request.id)?;
            Ok(Value::Null)
        }
        "reorder_task" => {
            let request: ReorderPayload = parse(payload)?;
            store.reorder_task(&request.id, &request.direction)?;
            Ok(Value::Null)
        }
        "list_day_plan" => {
            let request: DatePayload = parse(payload)?;
            serialize(store.list_day_plan(&request.date)?)
        }
        "add_to_day" => {
            let request: TaskDayPayload = parse(payload)?;
            store.add_to_day(&request.task_id, &request.date)?;
            Ok(Value::Null)
        }
        "remove_from_day" => {
            let request: TaskDayPayload = parse(payload)?;
            store.remove_from_day(&request.task_id, &request.date)?;
            Ok(Value::Null)
        }
        "create_step" => {
            let request: CreateStepPayload = parse(payload)?;
            serialize(store.create_step(&request.task_id, &request.title)?)
        }
        "patch_step" => {
            let request: StepPatchPayload = parse(payload)?;
            serialize(store.patch_step(&request.id, request.patch)?)
        }
        "delete_step" => {
            let request: IdPayload = parse(payload)?;
            store.delete_step(&request.id)?;
            Ok(Value::Null)
        }
        "export_data" => serialize(store.export_data()?),
        "import_data" => {
            let request: ImportRequest = parse(payload)?;
            store.import_data(request)?;
            Ok(Value::Null)
        }
        "clear_all" => {
            store.clear_all()?;
            Ok(Value::Null)
        }
        "get_device_id" => serialize(store.get_device_id()?),
        "get_sync_cursor" => serialize(store.get_sync_cursor()?),
        "pending_mutations" => {
            let request: PendingPayload = parse(payload)?;
            serialize(store.pending_mutations(request.limit.unwrap_or(100))?)
        }
        "apply_server_result" => {
            let request: ApplyServerResultRequest = parse(payload)?;
            store.apply_server_result(request)?;
            Ok(Value::Null)
        }
        "rotate_device_id" => serialize(store.rotate_device_id()?),
        "sync_diagnostics" => serialize(store.sync_diagnostics()?),
        "sync_set_enabled" => {
            let request: SyncSetEnabledRequest = parse(payload)?;
            store.sync_set_enabled(request.enabled)?;
            Ok(Value::Null)
        }
        "sync_set_session" => {
            let request: SyncSessionPayload = parse(payload)?;
            store.sync_set_session(request.session_id.as_deref())?;
            Ok(Value::Null)
        }
        "sync_clear_session" => {
            let request: SyncSessionClearPayload = parse(payload)?;
            store.sync_clear_session_if(request.expected_session_id.as_deref())?;
            Ok(Value::Null)
        }
        "sync_clear_rejected" => {
            store.sync_clear_rejected()?;
            Ok(Value::Null)
        }
        "sync_clear_account_binding" => {
            store.sync_clear_account_binding()?;
            Ok(Value::Null)
        }
        "sync_initialize_cloud" => {
            let request: CloudInitializeRequest = parse(payload)?;
            serialize(store.sync_initialize_cloud(request)?)
        }
        "sync_replace_snapshot" => {
            let request: SyncReplaceSnapshotRequest = parse(payload)?;
            store.sync_replace_snapshot_fenced(&request.snapshot, request.session_id.as_deref())?;
            Ok(Value::Null)
        }
        "bootstrap_required" => {
            store.bootstrap_required()?;
            Ok(Value::Null)
        }
        other => Err(StoreError::Unsupported(format!(
            "未知的 todo_storage action: {other}"
        ))),
    }
}

/// Also accept `{ request: { action, payload } }` when invoked by a thin
/// test harness that forwards the whole IPC argument object.
pub fn dispatch_tauri_arguments(store: &TodoStore, arguments: Value) -> StoreResult<Value> {
    let request_value = arguments.get("request").cloned().unwrap_or(arguments);
    let request: ActionRequest = parse(request_value)?;
    dispatch(store, &request.action, request.payload)
}

fn serialize<T: serde::Serialize>(value: T) -> StoreResult<Value> {
    Ok(serde_json::to_value(value)?)
}

fn parse<T: for<'de> Deserialize<'de>>(value: Value) -> StoreResult<T> {
    serde_json::from_value(value)
        .map_err(|error| StoreError::Validation(format!("请求参数无效: {error}")))
}

fn unwrap_alias(payload: Value, keys: &[&str]) -> Value {
    if let Value::Object(object) = &payload
        && object.len() == 1
    {
        for key in keys {
            if let Some(value) = object.get(*key) {
                return value.clone();
            }
        }
    }
    payload
}

pub fn action_names() -> &'static [&'static str] {
    &[
        "initialize",
        "list_lists",
        "create_list",
        "patch_list",
        "delete_list",
        "restore_list",
        "create_task",
        "patch_task",
        "get_task",
        "list_tasks",
        "list_reminder_candidates",
        "get_counts",
        "commit_completion",
        "delete_task",
        "restore_task",
        "reorder_task",
        "list_day_plan",
        "add_to_day",
        "remove_from_day",
        "create_step",
        "patch_step",
        "delete_step",
        "export_data",
        "import_data",
        "clear_all",
        "get_device_id",
        "get_sync_cursor",
        "pending_mutations",
        "apply_server_result",
        "bootstrap_required",
        "rotate_device_id",
        "sync_diagnostics",
        "sync_set_enabled",
        "sync_set_session",
        "sync_clear_session",
        "sync_clear_rejected",
        "sync_clear_account_binding",
        "sync_initialize_cloud",
        "sync_replace_snapshot",
    ]
}

pub fn error_payload(error: &StoreError) -> Value {
    json!({
        "code": error.code(),
        "message": error.to_string(),
    })
}
