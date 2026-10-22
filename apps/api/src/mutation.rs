use std::{collections::HashSet, str::FromStr};

use chrono::{DateTime, NaiveDate, Utc};
use chrono_tz::Tz;
use serde::{Deserialize, Deserializer};
use serde_json::{Value, json};
use uuid::Uuid;

use crate::domain::TaskStatus;

pub const MAX_TAGS: usize = 20;
pub const MAX_TAG_LENGTH: usize = 32;

/// Matches the client's normalizeTags cleaning rules while rejecting invalid
/// input instead of silently truncating it:
/// - single-line whitespace cleanup and trim
/// - strip one leading "#"
/// - case-insensitive deduplication, preserving the first spelling
/// - 1..=32 characters per tag, at most 20 unique tags
fn normalize_tags(tags: &[String]) -> Result<Vec<String>, MutationError> {
    let mut seen = HashSet::new();
    let mut result = Vec::new();
    for raw in tags {
        let tag = clean_tag(raw);
        if tag.is_empty() {
            return Err(MutationError::validation(
                "tags may not contain empty strings",
            ));
        }
        if tag.chars().count() > MAX_TAG_LENGTH {
            return Err(MutationError::validation(format!(
                "each tag must be at most {MAX_TAG_LENGTH} characters"
            )));
        }
        let key = tag.to_lowercase();
        if seen.insert(key) {
            result.push(tag);
            if result.len() > MAX_TAGS {
                return Err(MutationError::validation(format!(
                    "a task may have at most {MAX_TAGS} tags"
                )));
            }
        }
    }
    Ok(result)
}

fn clean_tag(value: &str) -> String {
    let mut cleaned = String::with_capacity(value.len());
    let mut pending_space = false;
    for character in value.chars() {
        let character = match character {
            '\r' | '\n' | '\t' => ' ',
            other => other,
        };
        if character.is_whitespace() {
            if !cleaned.is_empty() {
                pending_space = true;
            }
            continue;
        }
        if pending_space && !cleaned.is_empty() {
            cleaned.push(' ');
        }
        pending_space = false;
        cleaned.push(character);
    }
    cleaned
        .trim()
        .strip_prefix('#')
        .unwrap_or(&cleaned)
        .trim()
        .to_owned()
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MutationError {
    pub code: &'static str,
    pub detail: String,
}

impl MutationError {
    pub fn validation(detail: impl Into<String>) -> Self {
        Self {
            code: "VALIDATION_FAILED",
            detail: detail.into(),
        }
    }

    pub fn not_found() -> Self {
        Self {
            code: "ENTITY_NOT_FOUND",
            detail: "entity does not exist under this account".to_owned(),
        }
    }

    pub fn tombstoned() -> Self {
        Self {
            code: "ENTITY_TOMBSTONED",
            detail: "entity is deleted; an explicit restore is required".to_owned(),
        }
    }

    pub fn already_exists() -> Self {
        Self {
            code: "ENTITY_ALREADY_EXISTS",
            detail: "entity id already exists".to_owned(),
        }
    }

    pub fn invalid_state(detail: impl Into<String>) -> Self {
        Self {
            code: "INVALID_STATE",
            detail: detail.into(),
        }
    }

    pub fn invalid_parent(detail: impl Into<String>) -> Self {
        Self {
            code: "INVALID_PARENT",
            detail: detail.into(),
        }
    }

    pub fn constraint(detail: impl Into<String>) -> Self {
        Self {
            code: "CONSTRAINT_VIOLATION",
            detail: detail.into(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ListValues {
    pub name: String,
    pub color: Option<String>,
    pub icon: Option<String>,
    pub rank: String,
}

impl ListValues {
    pub fn empty() -> Self {
        Self {
            name: String::new(),
            color: None,
            icon: None,
            rank: "a0".to_owned(),
        }
    }

    pub fn validate(&self) -> Result<(), MutationError> {
        required_text("name", &self.name, 120)?;
        optional_text("color", self.color.as_deref(), 64)?;
        optional_text("icon", self.icon.as_deref(), 128)?;
        required_text("rank", &self.rank, 128)
    }

    pub fn change_patch(&self) -> Value {
        json!({
            "name": self.name,
            "color": self.color,
            "icon": self.icon,
            "rank": self.rank
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskValues {
    pub list_id: Option<Uuid>,
    pub title: String,
    pub note: String,
    pub status: TaskStatus,
    pub important: bool,
    pub tags: Vec<String>,
    pub due_on: Option<NaiveDate>,
    pub remind_at: Option<DateTime<Utc>>,
    pub remind_timezone: Option<String>,
    pub rank: String,
    pub series_id: Option<Uuid>,
    pub occurrence_key: Option<String>,
    pub recurrence: Option<Value>,
    pub completed_at: Option<DateTime<Utc>>,
}

impl TaskValues {
    pub fn empty() -> Self {
        Self {
            list_id: None,
            title: String::new(),
            note: String::new(),
            status: TaskStatus::Open,
            important: false,
            tags: Vec::new(),
            due_on: None,
            remind_at: None,
            remind_timezone: None,
            rank: "a0".to_owned(),
            series_id: None,
            occurrence_key: None,
            recurrence: None,
            completed_at: None,
        }
    }

    pub fn validate(&self) -> Result<(), MutationError> {
        required_text("title", &self.title, 1000)?;
        optional_text("note", Some(&self.note), 100_000)?;
        required_text("rank", &self.rank, 128)?;
        let normalized_tags = normalize_tags(&self.tags)?;
        if normalized_tags != self.tags {
            return Err(MutationError::validation(
                "tags must be normalized before storage",
            ));
        }
        if let Some(timezone) = &self.remind_timezone {
            required_text("remind_timezone", timezone, 64)?;
            if Tz::from_str(timezone).is_err() {
                return Err(MutationError::validation(
                    "remind_timezone must be a valid IANA timezone name",
                ));
            }
        }
        if let Some(key) = &self.occurrence_key {
            required_text("occurrence_key", key, 64)?;
        }
        if let Some(recurrence) = &self.recurrence {
            if !recurrence.is_object() {
                return Err(MutationError::validation(
                    "recurrence must be a JSON object",
                ));
            }
            if recurrence.to_string().len() > 16 * 1024 {
                return Err(MutationError::validation("recurrence is too large"));
            }
        }
        Ok(())
    }

    pub fn change_patch(&self) -> Value {
        json!({
            "list_id": self.list_id,
            "title": self.title,
            "note": self.note,
            "status": self.status.as_str(),
            "important": self.important,
            "tags": self.tags,
            "due_on": self.due_on,
            "remind_at": self.remind_at,
            "remind_timezone": self.remind_timezone,
            "rank": self.rank,
            "series_id": self.series_id,
            "occurrence_key": self.occurrence_key,
            "recurrence": self.recurrence,
            "completed_at": self.completed_at
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StepValues {
    pub task_id: Uuid,
    pub title: String,
    pub is_completed: bool,
    pub rank: String,
}

impl StepValues {
    pub fn empty(task_id: Uuid) -> Self {
        Self {
            task_id,
            title: String::new(),
            is_completed: false,
            rank: "a0".to_owned(),
        }
    }

    pub fn validate(&self) -> Result<(), MutationError> {
        required_text("title", &self.title, 1000)?;
        required_text("rank", &self.rank, 128)
    }

    pub fn change_patch(&self) -> Value {
        json!({
            "task_id": self.task_id,
            "title": self.title,
            "is_completed": self.is_completed,
            "rank": self.rank
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DayPlanValues {
    pub task_id: Uuid,
    pub local_date: NaiveDate,
    pub rank: String,
}

impl DayPlanValues {
    pub fn empty(task_id: Uuid) -> Self {
        Self {
            task_id,
            local_date: Utc::now().date_naive(),
            rank: "a0".to_owned(),
        }
    }

    pub fn validate(&self) -> Result<(), MutationError> {
        required_text("rank", &self.rank, 128)
    }

    pub fn change_patch(&self) -> Value {
        json!({
            "task_id": self.task_id,
            "local_date": self.local_date,
            "rank": self.rank
        })
    }
}

#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ListPatch {
    #[serde(default, deserialize_with = "double_option")]
    pub name: Option<Option<String>>,
    #[serde(default, deserialize_with = "double_option")]
    pub color: Option<Option<String>>,
    #[serde(default, deserialize_with = "double_option")]
    pub icon: Option<Option<String>>,
    #[serde(default, deserialize_with = "double_option")]
    pub rank: Option<Option<String>>,
}

impl ListPatch {
    pub fn apply(&self, values: &mut ListValues) -> Result<(), MutationError> {
        if let Some(value) = required_field("name", &self.name)? {
            values.name = value.to_owned();
        }
        if let Some(value) = &self.color {
            values.color = value.clone();
        }
        if let Some(value) = &self.icon {
            values.icon = value.clone();
        }
        if let Some(value) = required_field("rank", &self.rank)? {
            values.rank = value.to_owned();
        }
        values.validate()
    }
}

#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TaskPatch {
    #[serde(default, deserialize_with = "double_option")]
    pub list_id: Option<Option<Uuid>>,
    #[serde(default, deserialize_with = "double_option")]
    pub title: Option<Option<String>>,
    #[serde(default, deserialize_with = "double_option")]
    pub note: Option<Option<String>>,
    #[serde(default, deserialize_with = "double_option")]
    pub status: Option<Option<TaskStatus>>,
    #[serde(default, deserialize_with = "double_option")]
    pub important: Option<Option<bool>>,
    #[serde(default, deserialize_with = "double_option")]
    pub tags: Option<Option<Vec<String>>>,
    #[serde(default, deserialize_with = "double_option")]
    pub due_on: Option<Option<NaiveDate>>,
    #[serde(default, deserialize_with = "double_option")]
    pub remind_at: Option<Option<DateTime<Utc>>>,
    #[serde(default, deserialize_with = "double_option")]
    pub remind_timezone: Option<Option<String>>,
    #[serde(default, deserialize_with = "double_option")]
    pub rank: Option<Option<String>>,
    #[serde(default, deserialize_with = "double_option")]
    pub series_id: Option<Option<Uuid>>,
    #[serde(default, deserialize_with = "double_option")]
    pub occurrence_key: Option<Option<String>>,
    #[serde(default, deserialize_with = "double_option")]
    pub recurrence: Option<Option<Value>>,
    #[serde(default, deserialize_with = "double_option")]
    pub completed_at: Option<Option<DateTime<Utc>>>,
}

impl TaskPatch {
    pub fn apply(&self, values: &mut TaskValues) -> Result<(), MutationError> {
        if let Some(value) = &self.list_id {
            values.list_id = *value;
        }
        if let Some(value) = required_field("title", &self.title)? {
            values.title = value.to_owned();
        }
        if let Some(value) = required_field("note", &self.note)? {
            values.note = value.to_owned();
        }
        if let Some(value) = required_field("status", &self.status)? {
            values.status = *value;
        }
        if let Some(value) = required_field("important", &self.important)? {
            values.important = *value;
        }
        if let Some(value) = required_field("tags", &self.tags)? {
            values.tags = normalize_tags(value)?;
        }
        if let Some(value) = &self.due_on {
            values.due_on = *value;
        }
        if let Some(value) = &self.remind_at {
            values.remind_at = *value;
        }
        if let Some(value) = &self.remind_timezone {
            values.remind_timezone = value.clone();
        }
        if let Some(value) = required_field("rank", &self.rank)? {
            values.rank = value.to_owned();
        }
        if let Some(value) = &self.series_id {
            values.series_id = *value;
        }
        if let Some(value) = &self.occurrence_key {
            values.occurrence_key = value.clone();
        }
        if let Some(value) = &self.recurrence {
            values.recurrence = value.clone();
        }
        if let Some(value) = &self.completed_at {
            values.completed_at = *value;
        }
        values.validate()
    }
}

#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StepPatch {
    #[serde(default, deserialize_with = "double_option")]
    pub task_id: Option<Option<Uuid>>,
    #[serde(default, deserialize_with = "double_option")]
    pub title: Option<Option<String>>,
    #[serde(default, deserialize_with = "double_option")]
    pub is_completed: Option<Option<bool>>,
    #[serde(default, deserialize_with = "double_option")]
    pub rank: Option<Option<String>>,
}

impl StepPatch {
    pub fn apply(&self, values: &mut StepValues) -> Result<(), MutationError> {
        if let Some(value) = required_field("task_id", &self.task_id)? {
            values.task_id = *value;
        }
        if let Some(value) = required_field("title", &self.title)? {
            values.title = value.to_owned();
        }
        if let Some(value) = required_field("is_completed", &self.is_completed)? {
            values.is_completed = *value;
        }
        if let Some(value) = required_field("rank", &self.rank)? {
            values.rank = value.to_owned();
        }
        values.validate()
    }
}

#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DayPlanPatch {
    #[serde(default, deserialize_with = "double_option")]
    pub task_id: Option<Option<Uuid>>,
    #[serde(default, deserialize_with = "double_option")]
    pub local_date: Option<Option<NaiveDate>>,
    #[serde(default, deserialize_with = "double_option")]
    pub rank: Option<Option<String>>,
}

impl DayPlanPatch {
    pub fn apply(&self, values: &mut DayPlanValues) -> Result<(), MutationError> {
        if let Some(value) = required_field("task_id", &self.task_id)? {
            values.task_id = *value;
        }
        if let Some(value) = required_field("local_date", &self.local_date)? {
            values.local_date = *value;
        }
        if let Some(value) = required_field("rank", &self.rank)? {
            values.rank = value.to_owned();
        }
        values.validate()
    }
}

pub fn parse_list_patch(value: &Value, allow_empty: bool) -> Result<ListPatch, MutationError> {
    parse_patch(value, allow_empty)
}

pub fn parse_task_patch(value: &Value, allow_empty: bool) -> Result<TaskPatch, MutationError> {
    parse_patch(value, allow_empty)
}

pub fn parse_step_patch(value: &Value, allow_empty: bool) -> Result<StepPatch, MutationError> {
    parse_patch(value, allow_empty)
}

pub fn parse_day_plan_patch(
    value: &Value,
    allow_empty: bool,
) -> Result<DayPlanPatch, MutationError> {
    parse_patch(value, allow_empty)
}

fn parse_patch<T>(value: &Value, allow_empty: bool) -> Result<T, MutationError>
where
    T: for<'de> Deserialize<'de>,
{
    let object = value
        .as_object()
        .ok_or_else(|| MutationError::validation("patch must be a JSON object"))?;
    if object.is_empty() && !allow_empty {
        return Err(MutationError::validation(
            "patch must contain at least one field",
        ));
    }
    serde_json::from_value(value.clone())
        .map_err(|error| MutationError::validation(format!("invalid patch: {error}")))
}

/// Distinguishes an absent field (`None`) from an explicit JSON null
/// (`Some(None)`) for nullable columns.
fn double_option<'de, D, T>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer).map(Some)
}

fn required_field<'a, T>(
    field: &str,
    value: &'a Option<Option<T>>,
) -> Result<Option<&'a T>, MutationError> {
    match value {
        None => Ok(None),
        Some(Some(value)) => Ok(Some(value)),
        Some(None) => Err(MutationError::validation(format!(
            "field {field:?} may not be null"
        ))),
    }
}

fn required_text(field: &str, value: &str, max_chars: usize) -> Result<(), MutationError> {
    if value.trim().is_empty() {
        return Err(MutationError::validation(format!(
            "field {field:?} may not be empty"
        )));
    }
    if value.chars().count() > max_chars {
        return Err(MutationError::validation(format!(
            "field {field:?} exceeds {max_chars} characters"
        )));
    }
    Ok(())
}

fn optional_text(field: &str, value: Option<&str>, max_chars: usize) -> Result<(), MutationError> {
    if let Some(value) = value
        && value.chars().count() > max_chars
    {
        return Err(MutationError::validation(format!(
            "field {field:?} exceeds {max_chars} characters"
        )));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn task_patch(value: Value) -> Result<TaskPatch, MutationError> {
        parse_task_patch(&value, false)
    }

    #[test]
    fn unknown_fields_are_rejected() {
        let error = task_patch(json!({"title": "ok", "user_id": Uuid::new_v4()})).unwrap_err();
        assert_eq!(error.code, "VALIDATION_FAILED");
        assert!(error.detail.contains("unknown field"));
    }

    #[test]
    fn empty_patch_is_rejected_unless_allowed() {
        assert!(task_patch(json!({})).is_err());
        assert!(parse_task_patch(&json!({}), true).is_ok());
    }

    #[test]
    fn null_is_rejected_for_non_nullable_fields() {
        let patch = task_patch(json!({"title": null})).unwrap();
        let mut values = TaskValues::empty();
        values.title = "Existing".to_owned();
        let error = patch.apply(&mut values).unwrap_err();
        assert!(error.detail.contains("may not be null"));
    }

    #[test]
    fn null_is_accepted_for_nullable_fields() {
        let patch = task_patch(json!({"due_on": null, "list_id": null})).unwrap();
        let mut values = TaskValues::empty();
        values.title = "Task".to_owned();
        patch.apply(&mut values).unwrap();
        assert_eq!(values.due_on, None);
        assert_eq!(values.list_id, None);
    }

    #[test]
    fn title_length_and_emptiness_are_validated() {
        let mut values = TaskValues::empty();
        let patch = task_patch(json!({"title": "   "})).unwrap();
        assert!(patch.apply(&mut values).is_err());

        let mut values = TaskValues::empty();
        let patch = task_patch(json!({"title": "x".repeat(1001)})).unwrap();
        assert!(patch.apply(&mut values).is_err());
    }

    #[test]
    fn invalid_timezone_is_rejected() {
        let mut values = TaskValues::empty();
        values.title = "Task".to_owned();
        let patch = task_patch(json!({"remind_timezone": "Mars/Olympus"})).unwrap();
        let error = patch.apply(&mut values).unwrap_err();
        assert!(error.detail.contains("IANA timezone"));
    }

    #[test]
    fn valid_task_patch_is_applied() {
        let mut values = TaskValues::empty();
        values.title = "Old".to_owned();
        let patch = task_patch(json!({
            "title": "New",
            "important": true,
            "status": "completed",
            "due_on": "2026-10-21",
            "remind_at": "2026-10-21T05:00:00Z",
            "remind_timezone": "Asia/Shanghai",
            "recurrence": {"frequency": "daily"}
        }))
        .unwrap();
        patch.apply(&mut values).unwrap();
        assert_eq!(values.title, "New");
        assert!(values.important);
        assert_eq!(values.status, TaskStatus::Completed);
        assert_eq!(values.due_on, NaiveDate::from_ymd_opt(2026, 10, 21));
        assert_eq!(values.remind_timezone.as_deref(), Some("Asia/Shanghai"));
    }

    #[test]
    fn tags_are_trimmed_hash_stripped_and_deduplicated_case_insensitively() {
        let mut values = TaskValues::empty();
        values.title = "Task".to_owned();
        let patch = task_patch(json!({
            "tags": [" Work ", "work", "#Home", "HOME", "multi\t  space"]
        }))
        .unwrap();
        patch.apply(&mut values).unwrap();
        assert_eq!(values.tags, vec!["Work", "Home", "multi space"]);
    }

    #[test]
    fn tag_patch_replaces_the_complete_array() {
        let mut values = TaskValues::empty();
        values.title = "Task".to_owned();
        values.tags = vec!["old".to_owned(), "keep?".to_owned()];
        let patch = task_patch(json!({"tags": ["new", "NEW", "#next"]})).unwrap();
        patch.apply(&mut values).unwrap();
        assert_eq!(values.tags, vec!["new", "next"]);
    }

    #[test]
    fn patches_without_tags_preserve_existing_tags() {
        let mut values = TaskValues::empty();
        values.title = "Task".to_owned();
        values.tags = vec!["existing".to_owned()];
        let patch = task_patch(json!({"title": "Renamed"})).unwrap();
        patch.apply(&mut values).unwrap();
        assert_eq!(values.tags, vec!["existing"]);
    }

    #[test]
    fn tags_enforce_count_and_length_limits() {
        let mut values = TaskValues::empty();
        values.title = "Task".to_owned();
        let too_many: Vec<String> = (0..=MAX_TAGS).map(|index| format!("tag-{index}")).collect();
        let patch = task_patch(json!({"tags": too_many})).unwrap();
        assert!(patch.apply(&mut values).is_err());

        let mut values = TaskValues::empty();
        values.title = "Task".to_owned();
        let patch = task_patch(json!({"tags": ["x".repeat(MAX_TAG_LENGTH + 1)]})).unwrap();
        assert!(patch.apply(&mut values).is_err());

        let mut values = TaskValues::empty();
        values.title = "Task".to_owned();
        let patch = task_patch(json!({"tags": ["ok", ""]})).unwrap();
        assert!(patch.apply(&mut values).is_err());
    }

    #[test]
    fn tag_length_counts_unicode_characters() {
        let mut values = TaskValues::empty();
        values.title = "Task".to_owned();
        let max_unicode = "标".repeat(MAX_TAG_LENGTH);
        let patch = task_patch(json!({"tags": [max_unicode]})).unwrap();
        patch.apply(&mut values).unwrap();
        assert_eq!(values.tags[0].chars().count(), MAX_TAG_LENGTH);

        let mut values = TaskValues::empty();
        values.title = "Task".to_owned();
        let patch = task_patch(json!({"tags": ["标".repeat(MAX_TAG_LENGTH + 1)]})).unwrap();
        assert!(patch.apply(&mut values).is_err());
    }

    #[test]
    fn tags_null_is_rejected() {
        let mut values = TaskValues::empty();
        values.title = "Task".to_owned();
        let patch = task_patch(json!({"tags": null})).unwrap();
        assert!(patch.apply(&mut values).is_err());
    }

    #[test]
    fn create_values_require_identity_fields() {
        assert!(ListValues::empty().validate().is_err());
        assert!(TaskValues::empty().validate().is_err());
        assert!(StepValues::empty(Uuid::new_v4()).validate().is_err());
        let day_plan = DayPlanValues::empty(Uuid::new_v4());
        assert!(day_plan.validate().is_ok());
    }

    #[test]
    fn list_whitelist_rejects_rank_null() {
        let patch = parse_list_patch(&json!({"name": "Home", "rank": null}), false).unwrap();
        let mut values = ListValues::empty();
        assert!(patch.apply(&mut values).is_err());
    }

    #[test]
    fn recurrence_must_be_an_object() {
        let mut values = TaskValues::empty();
        values.title = "Task".to_owned();
        let patch = task_patch(json!({"recurrence": ["daily"]})).unwrap();
        assert!(patch.apply(&mut values).is_err());
    }
}
