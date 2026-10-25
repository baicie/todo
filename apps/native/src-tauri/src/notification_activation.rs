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
use todo_native_accounts::{AccountError, load_with_recovery};

use crate::db::AppState;
#[cfg(desktop)]
use crate::desktop_shell;
use todo_native_core::StoreError;

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
    rejections: Mutex<VecDeque<RejectedActivation>>,
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

    fn put_rejection(&self, rejection: RejectedActivation) {
        if let Ok(mut rejections) = self.rejections.lock() {
            // The rejection notice is best-effort UX; failure to deliver it is
            // fail-closed. Keep only the newest bounded window.
            while rejections.len() >= 8 {
                rejections.pop_front();
            }
            rejections.push_back(rejection);
        }
    }

    pub fn take_rejection(&self) -> Option<RejectedActivation> {
        self.rejections
            .lock()
            .ok()
            .and_then(|mut rejections| rejections.pop_front())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RejectionCode {
    AppNotReady,
    DataDirUnavailable,
    AccountRegistryMissing,
    AccountRegistryInvalid,
    AccountSwitchRequired,
    AccountSwitchInProgress,
    TaskNotFound,
    TaskReadFailed,
}

impl RejectionCode {
    const fn as_str(self) -> &'static str {
        match self {
            Self::AppNotReady => "APP_NOT_READY",
            Self::DataDirUnavailable => "DATA_DIR_UNAVAILABLE",
            Self::AccountRegistryMissing => "ACCOUNT_REGISTRY_MISSING",
            Self::AccountRegistryInvalid => "ACCOUNT_REGISTRY_INVALID",
            Self::AccountSwitchRequired => "ACCOUNT_SWITCH_REQUIRED",
            Self::AccountSwitchInProgress => "ACCOUNT_SWITCH_IN_PROGRESS",
            Self::TaskNotFound => "TASK_NOT_FOUND",
            Self::TaskReadFailed => "TASK_READ_FAILED",
        }
    }

    /// Fixed user-visible message. Never interpolate internal error text,
    /// paths, SQL, tokens, emails or task titles here.
    const fn user_message(self) -> &'static str {
        match self {
            Self::AppNotReady => "应用尚未完成初始化，请稍后重试",
            Self::DataDirUnavailable => "暂时无法读取本地账号数据",
            Self::AccountRegistryMissing | Self::AccountRegistryInvalid => {
                "本地账号状态不可用，请检查账号恢复状态"
            }
            Self::AccountSwitchRequired => "该提醒属于另一个账号，请先切换账号",
            Self::AccountSwitchInProgress => "账号切换进行中，请稍后重试",
            Self::TaskNotFound => "提醒对应的任务已删除或不可见",
            Self::TaskReadFailed => "暂时无法读取提醒对应的任务",
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RejectedActivation {
    code: &'static str,
    message: &'static str,
}

impl RejectedActivation {
    fn from_code(code: RejectionCode) -> Self {
        Self {
            code: code.as_str(),
            message: code.user_message(),
        }
    }
}

fn map_registry_error(_error: &AccountError) -> RejectionCode {
    // Deliberately discard internal Display text (paths, JSON details, SQL).
    RejectionCode::AccountRegistryInvalid
}

fn map_task_read_error(_error: &StoreError) -> RejectionCode {
    RejectionCode::TaskReadFailed
}

fn show_window(app: &AppHandle) {
    #[cfg(desktop)]
    desktop_shell::show_main_window(app);
}

fn reject(app: &AppHandle, code: RejectionCode) {
    let rejection = RejectedActivation::from_code(code);
    if let Some(state) = app.try_state::<NotificationActivationState>() {
        state.put_rejection(rejection);
    }
    show_window(app);
    // The event is only a wake-up. The WebView reads the bounded queue through
    // native_take_notification_rejection, so a pre-listener rejection is not lost.
    let _ = app.emit(EVENT_REJECTED, ());
}

/// Called from the notification plugin's action handler. This is deliberately
/// synchronous and does not expose any command with the same power.
fn validate_target(
    app: &AppHandle,
    state: &AppState,
    target: &NotificationTargetV1,
) -> Result<String, RejectionCode> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|_| RejectionCode::DataDirUnavailable)?;
    let registry = match load_with_recovery(&data_dir) {
        Ok(Some(registry)) => registry,
        Ok(None) => return Err(RejectionCode::AccountRegistryMissing),
        Err(error) => return Err(map_registry_error(&error)),
    };
    if registry.active_account_id != target.account_id
        || registry.account(&target.account_id).is_none()
    {
        return Err(RejectionCode::AccountSwitchRequired);
    }
    if state.account.account_id != target.account_id {
        return Err(RejectionCode::AccountSwitchRequired);
    }
    let Some(_lease) = state.runtime.enter_storage() else {
        return Err(RejectionCode::AccountSwitchInProgress);
    };
    match state.store.get_task(&target.task_id) {
        Ok(Some(task)) => Ok(task.title.clone()),
        Ok(None) => Err(RejectionCode::TaskNotFound),
        Err(error) => Err(map_task_read_error(&error)),
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
        reject(app, RejectionCode::AppNotReady);
        return;
    };
    let task_title = match validate_target(app, &state, &target) {
        Ok(title) => title,
        Err(code) => {
            reject(app, code);
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

/// Bounded drain size. Invalid activations are reported and skipped in one
/// command call so the WebView does not have to poll once per stale click.
const MAX_ACTIVATION_DRAIN_ATTEMPTS: usize = 8;

fn take_valid_activation<F, R>(
    state: &NotificationActivationState,
    mut validate: F,
    mut reject: R,
) -> Option<Activation>
where
    F: FnMut(&Activation) -> Result<String, RejectionCode>,
    R: FnMut(RejectionCode),
{
    for _ in 0..MAX_ACTIVATION_DRAIN_ATTEMPTS {
        let activation = state.take()?;
        match validate(&activation) {
            Ok(task_title) => {
                return Some(Activation {
                    task_title,
                    ..activation
                });
            }
            Err(code) => reject(code),
        }
    }
    None
}

#[tauri::command]
pub fn native_take_notification_activation(
    app: AppHandle,
    activation_state: State<'_, NotificationActivationState>,
    app_state: State<'_, AppState>,
) -> Option<Activation> {
    take_valid_activation(
        &activation_state,
        |activation| validate_target(&app, &app_state, &activation.target),
        |code| {
            // The account can switch after the notification was clicked but
            // before the WebView takes it. Never deliver a target that is no
            // longer valid for the active account.
            reject(&app, code);
        },
    )
}

#[tauri::command]
pub fn native_take_notification_rejection(
    activation_state: State<'_, NotificationActivationState>,
) -> Option<RejectedActivation> {
    activation_state.take_rejection()
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
    fn take_drains_rejected_activations_and_returns_first_valid() {
        let state = NotificationActivationState::default();
        for (activation_id, task_id) in [("stale", "stale-task"), ("valid", "task-ok")] {
            state.put(Activation {
                activation_id: activation_id.to_owned(),
                target: NotificationTargetV1::new("default", task_id).expect("target"),
                task_title: "queued".to_owned(),
            });
        }

        let mut rejected = Vec::new();
        let activation = take_valid_activation(
            &state,
            |activation| {
                if activation.target.task_id == "stale-task" {
                    Err(RejectionCode::AccountSwitchRequired)
                } else {
                    Ok("current title".to_owned())
                }
            },
            |code| rejected.push(code.as_str()),
        )
        .expect("valid activation");

        assert_eq!(activation.activation_id, "valid");
        assert_eq!(activation.task_title, "current title");
        assert_eq!(rejected, vec!["ACCOUNT_SWITCH_REQUIRED"]);
        assert!(state.take().is_none());
    }

    #[test]
    fn activation_is_consumed_once() {
        let state = NotificationActivationState::default();
        let target = NotificationTargetV1::new("default", "task-1").expect("target");
        state.put(Activation {
            activation_id: "a1".to_owned(),
            target,
            task_title: "task".to_owned(),
        });
        assert_eq!(state.take().expect("pending").activation_id, "a1");
        assert!(
            state.take().is_none(),
            "pop-on-read is the delivery contract"
        );
    }

    #[test]
    fn activation_queue_preserves_click_order_and_drops_oldest() {
        let state = NotificationActivationState::default();
        for index in 0..10 {
            state.put(Activation {
                activation_id: format!("a{index}"),
                target: NotificationTargetV1::new("default", format!("task-{index}"))
                    .expect("target"),
                task_title: "task".to_owned(),
            });
        }
        assert_eq!(state.take().expect("pending").activation_id, "a2");
    }
    #[test]
    fn rejection_queue_is_fifo_and_consumed_once() {
        let state = NotificationActivationState::default();
        state.put_rejection(RejectedActivation::from_code(
            RejectionCode::AccountSwitchRequired,
        ));
        state.put_rejection(RejectedActivation::from_code(RejectionCode::TaskNotFound));
        assert_eq!(
            state.take_rejection().expect("first").code,
            "ACCOUNT_SWITCH_REQUIRED"
        );
        assert_eq!(
            state.take_rejection().expect("second").code,
            "TASK_NOT_FOUND"
        );
        assert!(state.take_rejection().is_none());
    }

    #[test]
    fn rejection_queue_keeps_newest_eight() {
        const TEST_CODES: [&str; 10] = ["R0", "R1", "R2", "R3", "R4", "R5", "R6", "R7", "R8", "R9"];
        let state = NotificationActivationState::default();
        for code in TEST_CODES {
            state.put_rejection(RejectedActivation {
                code,
                message: "fixed test message",
            });
        }
        assert_eq!(state.take_rejection().expect("first kept").code, "R2");
        for code in &TEST_CODES[3..] {
            assert_eq!(state.take_rejection().expect("queued").code, *code);
        }
        assert!(state.take_rejection().is_none());
    }

    #[test]
    fn rejection_serialization_does_not_leak_internal_errors() {
        let registry_error = AccountError::UnsafePath(
            "/Users/alice/Library/Application Support/app.shishi.todo/accounts.json".to_owned(),
        );
        let registry_rejection = RejectedActivation::from_code(map_registry_error(&registry_error));
        let registry_json = serde_json::to_string(&registry_rejection).expect("serialize");
        assert_eq!(
            registry_json,
            r#"{"code":"ACCOUNT_REGISTRY_INVALID","message":"本地账号状态不可用，请检查账号恢复状态"}"#
        );
        assert!(!registry_json.contains("UnsafePath"));
        assert!(!registry_json.contains("/Users/alice"));

        let parse_error = serde_json::from_str::<serde_json::Value>("{").expect_err("invalid json");
        let parse_rejection =
            RejectedActivation::from_code(map_registry_error(&AccountError::Json(parse_error)));
        let parse_json = serde_json::to_string(&parse_rejection).expect("serialize");
        assert!(!parse_json.contains("expected"));
        assert_eq!(
            parse_json,
            r#"{"code":"ACCOUNT_REGISTRY_INVALID","message":"本地账号状态不可用，请检查账号恢复状态"}"#
        );

        let task_error = StoreError::Internal(
            "SELECT secret FROM local_tasks; /private/tmp/shishi.sqlite3".to_owned(),
        );
        let task_rejection = RejectedActivation::from_code(map_task_read_error(&task_error));
        let task_json = serde_json::to_string(&task_rejection).expect("serialize");
        assert_eq!(
            task_json,
            r#"{"code":"TASK_READ_FAILED","message":"暂时无法读取提醒对应的任务"}"#
        );
        assert!(!task_json.contains("SELECT"));
        assert!(!task_json.contains("/private/tmp"));
    }

    #[test]
    fn all_rejection_codes_have_stable_public_messages() {
        for (code, expected) in [
            (RejectionCode::AppNotReady, "APP_NOT_READY"),
            (RejectionCode::DataDirUnavailable, "DATA_DIR_UNAVAILABLE"),
            (
                RejectionCode::AccountRegistryMissing,
                "ACCOUNT_REGISTRY_MISSING",
            ),
            (
                RejectionCode::AccountRegistryInvalid,
                "ACCOUNT_REGISTRY_INVALID",
            ),
            (
                RejectionCode::AccountSwitchRequired,
                "ACCOUNT_SWITCH_REQUIRED",
            ),
            (
                RejectionCode::AccountSwitchInProgress,
                "ACCOUNT_SWITCH_IN_PROGRESS",
            ),
            (RejectionCode::TaskNotFound, "TASK_NOT_FOUND"),
            (RejectionCode::TaskReadFailed, "TASK_READ_FAILED"),
        ] {
            assert_eq!(code.as_str(), expected);
            let rejection = RejectedActivation::from_code(code);
            assert!(!rejection.message.is_empty());
            assert!(!rejection.message.contains('/'));
            assert!(!rejection.message.contains("SELECT"));
        }
    }

    #[test]
    fn rejected_notification_does_not_consume_valid_activation() {
        let state = NotificationActivationState::default();
        state.put_rejection(RejectedActivation::from_code(RejectionCode::TaskNotFound));
        state.put(Activation {
            activation_id: "valid".to_owned(),
            target: NotificationTargetV1::new("default", "task-1").expect("target"),
            task_title: "current".to_owned(),
        });
        assert_eq!(state.take().expect("activation").activation_id, "valid");
        assert_eq!(
            state.take_rejection().expect("rejection").code,
            "TASK_NOT_FOUND"
        );
    }
}
