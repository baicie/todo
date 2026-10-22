use std::collections::BTreeMap;

use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;

pub type Id = String;
pub type DateOnly = String;
pub type Instant = String;

fn double_option<'de, D, T>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer).map(Some)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TaskStatus {
    Open,
    Completed,
}

impl TaskStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Open => "open",
            Self::Completed => "completed",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "open" => Some(Self::Open),
            "completed" => Some(Self::Completed),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskList {
    pub id: Id,
    pub name: String,
    pub color: Option<String>,
    pub icon: Option<String>,
    pub rank: String,
    pub created_at: Instant,
    pub updated_at: Instant,
    pub deleted_at: Option<Instant>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    pub id: Id,
    pub list_id: Option<Id>,
    pub title: String,
    pub note: String,
    #[serde(default)]
    pub tags: Vec<String>,
    pub status: TaskStatus,
    pub important: bool,
    pub due_on: Option<DateOnly>,
    pub remind_at: Option<Instant>,
    pub remind_timezone: Option<String>,
    pub rank: String,
    pub series_id: Option<Id>,
    pub occurrence_key: Option<String>,
    pub recurrence: Option<Value>,
    pub completed_at: Option<Instant>,
    pub created_at: Instant,
    pub updated_at: Instant,
    pub deleted_at: Option<Instant>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Step {
    pub id: Id,
    pub task_id: Id,
    pub title: String,
    pub is_completed: bool,
    pub rank: String,
    pub created_at: Instant,
    pub updated_at: Instant,
    pub deleted_at: Option<Instant>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DayPlan {
    pub id: Id,
    pub task_id: Id,
    pub local_date: DateOnly,
    pub rank: String,
    pub created_at: Instant,
    pub updated_at: Instant,
    pub deleted_at: Option<Instant>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskWithSteps {
    #[serde(flatten)]
    pub task: Task,
    pub steps: Vec<Step>,
    pub day_plan_dates: Vec<DateOnly>,
}

impl std::ops::Deref for TaskWithSteps {
    type Target = Task;

    fn deref(&self) -> &Self::Target {
        &self.task
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NewTask {
    pub title: String,
    #[serde(default)]
    pub list_id: Option<Id>,
    #[serde(default)]
    pub note: Option<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub important: Option<bool>,
    #[serde(default)]
    pub due_on: Option<DateOnly>,
    #[serde(default)]
    pub remind_at: Option<Instant>,
    #[serde(default)]
    pub remind_timezone: Option<String>,
    #[serde(default)]
    pub recurrence: Option<Value>,
    #[serde(default)]
    pub rank: Option<String>,
    #[serde(default)]
    pub plan_date: Option<DateOnly>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TaskPatch {
    #[serde(
        default,
        deserialize_with = "double_option",
        skip_serializing_if = "Option::is_none"
    )]
    pub title: Option<Option<String>>,
    #[serde(
        default,
        deserialize_with = "double_option",
        skip_serializing_if = "Option::is_none"
    )]
    pub list_id: Option<Option<Id>>,
    #[serde(
        default,
        deserialize_with = "double_option",
        skip_serializing_if = "Option::is_none"
    )]
    pub note: Option<Option<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tags: Option<Vec<String>>,
    #[serde(
        default,
        deserialize_with = "double_option",
        skip_serializing_if = "Option::is_none"
    )]
    pub status: Option<Option<TaskStatus>>,
    #[serde(
        default,
        deserialize_with = "double_option",
        skip_serializing_if = "Option::is_none"
    )]
    pub important: Option<Option<bool>>,
    #[serde(
        default,
        deserialize_with = "double_option",
        skip_serializing_if = "Option::is_none"
    )]
    pub due_on: Option<Option<DateOnly>>,
    #[serde(
        default,
        deserialize_with = "double_option",
        skip_serializing_if = "Option::is_none"
    )]
    pub remind_at: Option<Option<Instant>>,
    #[serde(
        default,
        deserialize_with = "double_option",
        skip_serializing_if = "Option::is_none"
    )]
    pub remind_timezone: Option<Option<String>>,
    #[serde(
        default,
        deserialize_with = "double_option",
        skip_serializing_if = "Option::is_none"
    )]
    pub recurrence: Option<Option<Value>>,
    #[serde(
        default,
        deserialize_with = "double_option",
        skip_serializing_if = "Option::is_none"
    )]
    pub rank: Option<Option<String>>,
    #[serde(
        default,
        deserialize_with = "double_option",
        skip_serializing_if = "Option::is_none"
    )]
    pub completed_at: Option<Option<Instant>>,
}

impl TaskPatch {
    /// True when no field was provided. Explicit JSON null is still a field.
    pub fn is_empty(&self) -> bool {
        self.title.is_none()
            && self.list_id.is_none()
            && self.note.is_none()
            && self.tags.is_none()
            && self.status.is_none()
            && self.important.is_none()
            && self.due_on.is_none()
            && self.remind_at.is_none()
            && self.remind_timezone.is_none()
            && self.recurrence.is_none()
            && self.rank.is_none()
            && self.completed_at.is_none()
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewList {
    pub name: String,
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default)]
    pub icon: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListPatch {
    #[serde(
        default,
        deserialize_with = "double_option",
        skip_serializing_if = "Option::is_none"
    )]
    pub name: Option<Option<String>>,
    #[serde(
        default,
        deserialize_with = "double_option",
        skip_serializing_if = "Option::is_none"
    )]
    pub color: Option<Option<String>>,
    #[serde(
        default,
        deserialize_with = "double_option",
        skip_serializing_if = "Option::is_none"
    )]
    pub icon: Option<Option<String>>,
    #[serde(
        default,
        deserialize_with = "double_option",
        skip_serializing_if = "Option::is_none"
    )]
    pub rank: Option<Option<String>>,
}

impl ListPatch {
    pub fn is_empty(&self) -> bool {
        self.name.is_none() && self.color.is_none() && self.icon.is_none() && self.rank.is_none()
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StepPatch {
    #[serde(
        default,
        deserialize_with = "double_option",
        skip_serializing_if = "Option::is_none"
    )]
    pub title: Option<Option<String>>,
    #[serde(
        default,
        deserialize_with = "double_option",
        skip_serializing_if = "Option::is_none"
    )]
    pub is_completed: Option<Option<bool>>,
    #[serde(
        default,
        deserialize_with = "double_option",
        skip_serializing_if = "Option::is_none"
    )]
    pub rank: Option<Option<String>>,
}

impl StepPatch {
    pub fn is_empty(&self) -> bool {
        self.title.is_none() && self.is_completed.is_none() && self.rank.is_none()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TaskView {
    MyDay,
    Important,
    Planned,
    All,
    Completed,
    List,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskQuery {
    pub view: TaskView,
    #[serde(default)]
    pub list_id: Option<Id>,
    #[serde(default)]
    pub search: Option<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub local_date: Option<DateOnly>,
    #[serde(default)]
    pub due_from: Option<DateOnly>,
    #[serde(default)]
    pub due_to: Option<DateOnly>,
    #[serde(default)]
    pub include_completed: bool,
    #[serde(default)]
    pub limit: Option<u32>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Page<T> {
    pub items: Vec<T>,
    pub next_cursor: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewCounts {
    pub my_day: i64,
    pub important: i64,
    pub planned: i64,
    pub completed: i64,
    pub all: i64,
    pub lists: BTreeMap<String, i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompleteResult {
    pub task: Task,
    pub next_task: Option<Task>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportBundle {
    pub format: String,
    pub version: u32,
    pub exported_at: Instant,
    pub app_version: String,
    pub tasks: Vec<Task>,
    pub lists: Vec<TaskList>,
    pub steps: Vec<Step>,
    pub day_plans: Vec<DayPlan>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ImportMode {
    Merge,
    Replace,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportRequest {
    pub bundle: ExportBundle,
    pub mode: ImportMode,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredMutation {
    pub op_id: String,
    pub device_id: String,
    pub client_seq: i64,
    pub entity: String,
    pub entity_id: String,
    pub kind: String,
    pub patch: Value,
    pub created_at: Instant,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_code: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerAck {
    #[serde(alias = "op_id")]
    pub op_id: String,
    #[serde(default, alias = "server_seq")]
    pub server_seq: Option<i64>,
    pub status: String,
    #[serde(default, alias = "error_code")]
    pub error_code: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerChange {
    #[serde(alias = "server_seq")]
    pub server_seq: i64,
    #[serde(alias = "op_id")]
    pub op_id: String,
    pub entity: String,
    #[serde(alias = "entity_id")]
    pub entity_id: String,
    pub kind: String,
    #[serde(default)]
    pub patch: Value,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyServerResultRequest {
    #[serde(default)]
    pub acks: Vec<ServerAck>,
    #[serde(default)]
    pub changes: Vec<ServerChange>,
    #[serde(alias = "next_cursor")]
    pub next_cursor: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudSnapshot {
    pub cursor: String,
    pub lists: Vec<TaskList>,
    pub tasks: Vec<Task>,
    pub steps: Vec<Step>,
    pub day_plans: Vec<DayPlan>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CloudMergeMode {
    Merge,
    Cloud,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudInitializeRequest {
    pub snapshot: CloudSnapshot,
    pub mode: CloudMergeMode,
    pub account_email: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudInitializeResult {
    pub prepared_ops: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncDiagnostics {
    pub enabled: bool,
    pub device_id: String,
    pub cursor: String,
    pub pending: i64,
    pub rejected: i64,
    pub bound_account: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncSetEnabledRequest {
    pub enabled: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncReplaceSnapshotRequest {
    pub snapshot: CloudSnapshot,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActionRequest {
    pub action: String,
    #[serde(default)]
    pub payload: Value,
}
