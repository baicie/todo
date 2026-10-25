//! Account-safe routing for reminder notification clicks.
//!
//! A notification action carries a versioned target token. Native validates it
//! against the account registry, the runtime gate and the live task store before
//! the WebView receives it. A target from another account is never opened, and
//! Native never switches accounts as a side effect of a click.

use std::{
    collections::VecDeque,
    sync::{
        Mutex,
        atomic::{AtomicU64, Ordering},
    },
};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};
use todo_native_accounts::load_with_recovery;

use crate::db::AppState;
#[cfg(desktop)]
use crate::desktop_shell;

pub const ACTION_TYPE_ID: &str = "app.shishi.todo.notification.task.v1";
pub const ACTION_PREFIX: &str = "shishi.task.v1:";
pub const EVENT_OPEN: &str = "native-notification-activation";
pub const EVENT_REJECTED: &str = "native-notification-rejected";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotificationTargetV1 {
    pub account_id: String,
    pub task_id: String,
    pub source_version: u32,
}

impl NotificationTargetV1 {
    pub fn new(account_id: impl Into<String>, task_id: impl Into<String>) -> Option<Self> {
        let target = Self {
            account_id: account_id.into(),
            task_id: task_id.into(),
            source_version: 1,
        };
        target.is_valid().then_some(target)
    }

    pub fn is_valid(&self) -> bool {
        self.source_version == 1
            && valid_component(&self.account_id)
            && valid_component(&self.task_id)
            && self.account_id != self.task_id
    }

    pub fn encode_action_id(&self) -> String {
        format!("{ACTION_PREFIX}{}:{}", self.account_id, self.task_id)
    }

    pub fn parse_action_id(value: &str) -> Option<Self> {
        let rest = value.strip_prefix(ACTION_PREFIX)?;
        let (account_id, task_id) = rest.split_once(':')?;
        Self::new(account_id, task_id)
    }
}

fn valid_component(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || "-_.".contains(character))
}

/// Reminder IDs are `account:<account-id>:<task-id>`. Legacy unscoped entries
/// are not routable and must never be interpreted as a current-account task.
pub fn target_from_reminder_id(reminder_id: &str) -> Option<NotificationTargetV1> {
    let rest = reminder_id.strip_prefix("account:")?;
    let (account_id, task_id) = rest.split_once(':')?;
    if task_id.contains(':') {
        return None;
    }
    NotificationTargetV1::new(account_id, task_id)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Activation {
    pub activation_id: String,
    pub target: NotificationTargetV1,
    pub task_title: String,
}

#[derive(Default)]
pub struct NotificationActivationState {
    pending: Mutex<VecDeque<Activation>>,
    sequence: AtomicU64,
}

impl NotificationActivationState {
    fn next_id(&self) -> String {
        let sequence = self.sequence.fetch_add(1, Ordering::SeqCst);
        let millis = chrono::Utc::now().timestamp_millis();
        format!("{millis}-{sequence}")
    }

    fn put(&self, activation: Activation) {
        if let Ok(mut pending) = self.pending.lock() {
            // Bound the in-memory queue; a burst of clicks must not grow without
            // limit. Oldest activations are dropped before newer ones.
            while pending.len() >= 8 {
                pending.pop_front();
            }
            pending.push_back(activation);
        }
    }

    pub fn take(&self) -> Option<Activation> {
        self.pending
            .lock()
            .ok()
            .and_then(|mut pending| pending.pop_front())
    }

    pub fn acknowledge(&self, activation_id: &str) -> bool {
        let Ok(mut pending) = self.pending.lock() else {
            return false;
        };
        let before = pending.len();
        pending.retain(|item| item.activation_id != activation_id);
        pending.len() != before
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RejectedActivation {
    code: &'static str,
    message: String,
}

fn show_window(app: &AppHandle) {
    #[cfg(desktop)]
    desktop_shell::show_main_window(app);
}

fn reject(app: &AppHandle, code: &'static str, message: impl Into<String>) {
    let message = message.into();
    show_window(app);
    let _ = app.emit(EVENT_REJECTED, RejectedActivation { code, message });
}

/// Called from the notification plugin's action handler. This is deliberately
/// synchronous and does not expose any command with the same power.
fn validate_target(
    app: &AppHandle,
    state: &AppState,
    target: &NotificationTargetV1,
) -> Result<String, (&'static str, String)> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| ("DATA_DIR_UNAVAILABLE", format!("无法定位数据目录: {error}")))?;
    let registry = match load_with_recovery(&data_dir) {
        Ok(Some(registry)) => registry,
        Ok(None) => {
            return Err(("ACCOUNT_REGISTRY_MISSING", "账号注册表不可用".to_owned()));
        }
        Err(error) => return Err(("ACCOUNT_REGISTRY_INVALID", error.to_string())),
    };
    if registry.active_account_id != target.account_id
        || registry.account(&target.account_id).is_none()
    {
        return Err((
            "ACCOUNT_SWITCH_REQUIRED",
            "该提醒属于另一个账号；请先手动切换账号后重试".to_owned(),
        ));
    }
    if state.account.account_id != target.account_id {
        return Err((
            "ACCOUNT_SWITCH_REQUIRED",
            "当前打开的账号与提醒目标不一致".to_owned(),
        ));
    }
    let Some(_lease) = state.runtime.enter_storage() else {
        return Err((
            "ACCOUNT_SWITCH_IN_PROGRESS",
            "账号切换进行中，暂时无法打开任务".to_owned(),
        ));
    };
    match state.store.get_task(&target.task_id) {
        Ok(Some(task)) => Ok(task.title.clone()),
        Ok(None) => Err(("TASK_NOT_FOUND", "提醒对应的任务已删除或不可见".to_owned())),
        Err(error) => Err(("TASK_READ_FAILED", format!("无法读取任务: {error}"))),
    }
}

/// Called from the notification plugin's action handler. This is deliberately
/// synchronous and does not expose any command with the same power.
pub fn handle_action(app: &AppHandle, action_id: &str) {
    // A body tap is reported as `tap`; without a target token it must not open
    // an arbitrary task. The product uses an explicit "打开任务" action.
    let Some(target) = NotificationTargetV1::parse_action_id(action_id) else {
        return;
    };
    let Some(state) = app.try_state::<AppState>() else {
        reject(app, "APP_NOT_READY", "应用尚未完成初始化");
        return;
    };
    let task_title = match validate_target(app, &state, &target) {
        Ok(title) => title,
        Err((code, message)) => {
            reject(app, code, message);
            return;
        }
    };
    let activation = Activation {
        activation_id: app.state::<NotificationActivationState>().next_id(),
        target,
        task_title,
    };
    app.state::<NotificationActivationState>()
        .put(activation.clone());
    show_window(app);
    let _ = app.emit(EVENT_OPEN, activation);
}

#[tauri::command]
pub fn native_take_notification_activation(
    app: AppHandle,
    activation_state: State<'_, NotificationActivationState>,
    app_state: State<'_, AppState>,
) -> Option<Activation> {
    let activation = activation_state.take()?;
    match validate_target(&app, &app_state, &activation.target) {
        Ok(task_title) => Some(Activation {
            task_title,
            ..activation
        }),
        Err((code, message)) => {
            // The account can switch after the notification was clicked but
            // before the WebView takes it. Never deliver a target that is no
            // longer valid for the active account.
            reject(&app, code, message);
            None
        }
    }
}

#[tauri::command]
pub fn native_ack_notification_activation(
    state: State<'_, NotificationActivationState>,
    activation_id: String,
) -> bool {
    state.acknowledge(&activation_id)
}

/// Register the action handler. Only desktop arms this path; mobile reminders
/// are delivered by the mobile plugin and are not routed through this command.
#[cfg(desktop)]
pub fn install_handler(app: &AppHandle) -> tauri_plugin_notification::Result<()> {
    use tauri_plugin_notification::NotificationExt;
    let handle = app.clone();
    app.notification().on_action(move |action| {
        handle_action(&handle, action.action_id());
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn target_round_trips_through_the_action_id() {
        let target = NotificationTargetV1::new(
            "01a1673d-1000-7000-8000-000000000001",
            "01a1673d-1000-7000-8000-000000000099",
        )
        .expect("target");
        let encoded = target.encode_action_id();
        assert_eq!(
            NotificationTargetV1::parse_action_id(&encoded),
            Some(target)
        );
    }

    #[test]
    fn malformed_or_unversioned_targets_are_rejected() {
        for value in [
            "tap",
            "shishi.task.v1:",
            "shishi.task.v1:account",
            "shishi.task.v1:account:",
            "shishi.task.v1:account:task:extra",
            "shishi.task.v1:../escape:task",
            "shishi.task.v1:account:task/with/slash",
        ] {
            assert!(
                NotificationTargetV1::parse_action_id(value).is_none(),
                "{value}"
            );
        }
    }

    #[test]
    fn legacy_unscoped_reminders_have_no_target() {
        assert!(target_from_reminder_id("legacy-reminder").is_none());
        assert!(target_from_reminder_id("account:default").is_none());
        let target = target_from_reminder_id("account:default:task-1").expect("scoped");
        assert_eq!(target.account_id, "default");
        assert_eq!(target.task_id, "task-1");
        assert_eq!(target.source_version, 1);
    }

    #[test]
    fn activation_ack_is_idempotent_only_for_the_same_id() {
        let state = NotificationActivationState::default();
        let target = NotificationTargetV1::new("default", "task-1").expect("target");
        state.put(Activation {
            activation_id: "a1".to_owned(),
            target,
            task_title: "task".to_owned(),
        });
        assert!(!state.acknowledge("other"));
        assert_eq!(state.take().expect("pending").activation_id, "a1");
        assert!(state.take().is_none());
    }
}
