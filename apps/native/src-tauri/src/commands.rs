use std::{path::PathBuf, sync::Arc};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Manager, State, WebviewWindow};
use todo_native_accounts::{
    AbortSwitchOutcome, AccountList, AccountSummary, FaultPoint, SwitchStatus,
    abort_prepared_switch, create_pending_cloud_account, fault_point, list_accounts,
    mark_account_verified, normalize_api_url, normalize_email, prepare_account_switch,
    request_account_switch, rollback_pending_switch, switch_status,
    validate_account_switch_request, verify_cloud_identity,
};
use todo_native_core::{CloudInitializeRequest, StoreError, TodoStore};

use crate::{
    build_identity,
    db::{AppState, GateError},
    lifecycle::{self, DesktopSettings, LifecycleState},
    reminders::ReminderAdapter,
    secure_tokens, security,
};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageRequest {
    pub action: String,
    #[serde(default)]
    pub payload: Value,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandError {
    pub code: String,
    pub message: String,
}

impl CommandError {
    pub(crate) fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.to_owned(),
            message: message.into(),
        }
    }

    fn from_store(error: StoreError) -> Self {
        Self {
            code: error.code().as_str().to_owned(),
            message: error.to_string(),
        }
    }

    fn reminder(message: impl Into<String>) -> Self {
        Self::new("REMINDER_ERROR", message)
    }

    fn account_switch(message: impl Into<String>) -> Self {
        Self::new("ACCOUNT_SWITCH", message)
    }
}

/// Compile-time marker embedded by `build.rs`: `QA_BUILD_COMMIT:<sha>`.
///
/// The QA harness target probe (scripts/qa/native/run-windows.ps1) reads this
/// string back out of the executable bytes, so the value below and the value in
/// the file cannot drift apart. Trust boundary: a metadata file next to the
/// artifact can be edited, this string cannot - rewriting it changes the
/// executable sha256 that the provenance records alongside it.
const QA_BUILD_COMMIT_MARKER: &str = concat!("QA_BUILD_COMMIT:", env!("QA_BUILD_COMMIT"));
const QA_BUILD_COMMIT_MARKER_PREFIX: &str = "QA_BUILD_COMMIT:";

/// The commit part of the marker, reported over IPC by `qa_build_identity`.
fn qa_build_commit() -> &'static str {
    QA_BUILD_COMMIT_MARKER
        .strip_prefix(QA_BUILD_COMMIT_MARKER_PREFIX)
        .unwrap_or(QA_BUILD_COMMIT_MARKER)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QaBuildIdentity {
    pub channel: String,
    pub is_dev: bool,
    pub is_qa: bool,
    pub identifier: String,
    pub data_root: String,
    pub credential_service: String,
    pub fault_injection_enabled: bool,
    /// Git commit this binary was built from; `unknown` when the build could
    /// not determine one.
    pub build_commit: String,
}

/// A read-only identity probe used by the QA harness before any destructive
/// fixture. A production build returns `isQa: false`; the harness must abort.
/// This command cannot arm faults, change credentials or write data.
///
/// The channel comes from the runtime identifier. An identifier that matches no
/// channel is rejected instead of being reported as Stable, so a mispackaged
/// build can never be mistaken for one that may touch Stable credentials.
#[tauri::command]
pub fn qa_build_identity(app: AppHandle) -> Result<QaBuildIdentity, CommandError> {
    let identifier = app.config().identifier.clone();
    let channel = build_identity::resolve(&identifier)
        .map_err(|error| CommandError::new("BUILD_IDENTITY_UNKNOWN", error.to_string()))?;
    let data_root = app
        .path()
        .app_data_dir()
        .map(|path| path.display().to_string())
        .unwrap_or_default();
    let credential_service = secure_tokens::service_name(&app)
        .map_err(|error| CommandError::new("CREDENTIAL_NAMESPACE_UNAVAILABLE", error))?;
    Ok(QaBuildIdentity {
        channel: channel.as_str().to_owned(),
        is_dev: channel.is_dev(),
        is_qa: channel.is_qa(),
        identifier,
        data_root,
        credential_service: credential_service.to_owned(),
        fault_injection_enabled: cfg!(feature = "native-qa"),
        build_commit: qa_build_commit().to_owned(),
    })
}

fn data_dir(app: &AppHandle) -> Result<PathBuf, CommandError> {
    app.path()
        .app_data_dir()
        .map_err(|error| CommandError::account_switch(format!("无法定位应用数据目录: {error}")))
}

fn identity_error(error: todo_native_accounts::AccountError) -> CommandError {
    let code = match error {
        todo_native_accounts::AccountError::VerificationMismatch(_) => "ACCOUNT_IDENTITY_MISMATCH",
        _ => "ACCOUNT_IDENTITY_ERROR",
    };
    CommandError::new(code, error.to_string())
}

fn gate_error(error: GateError) -> CommandError {
    match error {
        GateError::SwitchInProgress => CommandError::new(
            "ACCOUNT_SWITCH_IN_PROGRESS",
            "账号切换进行中，当前账号已停止接受写入",
        ),
        GateError::DrainTimeout => CommandError::new(
            "ACCOUNT_SWITCH_DRAIN_TIMEOUT",
            "旧账号仍有未结束的本地写事务，已取消本次切换",
        ),
        GateError::NotPrepared => CommandError::new(
            "ACCOUNT_SWITCH_NOT_PREPARED",
            "账号切换不处于可请求的已准备状态",
        ),
        GateError::NotAbortable => CommandError::new(
            "ACCOUNT_SWITCH_ABORT_FORBIDDEN",
            "账号切换已进入不可回退阶段，需冷重启恢复",
        ),
        GateError::Poisoned => CommandError::new("INTERNAL", "账号切换状态机锁异常"),
    }
}

fn recovery_required(message: impl Into<String>) -> CommandError {
    CommandError::new("ACCOUNT_RECOVERY_REQUIRED", message)
}

fn ensure_runtime_active(state: &State<'_, AppState>) -> Result<(), CommandError> {
    if state.runtime.accepts_storage() {
        Ok(())
    } else {
        Err(CommandError::new(
            "ACCOUNT_SWITCH_IN_PROGRESS",
            "账号切换进行中，当前账号已停止接受写入",
        ))
    }
}

fn reminder_scope(account_id: &str, reminder_id: &str) -> String {
    format!("account:{account_id}:{reminder_id}")
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeAccountContextDto {
    pub account_id: String,
    pub kind: String,
    pub email: Option<String>,
    pub api_url: Option<String>,
    pub migrated_from_legacy: bool,
}

#[tauri::command]
pub fn native_account_context(state: State<'_, AppState>) -> NativeAccountContextDto {
    NativeAccountContextDto {
        account_id: state.account.account_id.clone(),
        kind: state.account.kind.as_str().to_owned(),
        email: state.account.email.clone(),
        api_url: state.account.api_url.clone(),
        migrated_from_legacy: state.account.migrated_from_legacy,
    }
}

#[tauri::command]
pub fn native_list_accounts(app: AppHandle) -> Result<AccountList, CommandError> {
    list_accounts(&data_dir(&app)?).map_err(|error| CommandError::account_switch(error.to_string()))
}

#[tauri::command]
pub fn native_create_account(
    app: AppHandle,
    state: State<'_, AppState>,
    email: String,
    api_url: String,
) -> Result<AccountSummary, CommandError> {
    ensure_runtime_active(&state)?;
    let _lease = state
        .runtime
        .enter_storage()
        .ok_or_else(|| CommandError::new("ACCOUNT_SWITCH_IN_PROGRESS", "账号切换进行中"))?;
    create_pending_cloud_account(&data_dir(&app)?, &email, &api_url)
        .map_err(|error| CommandError::account_switch(error.to_string()))
}

fn abort_account_switch_inner(
    root: &std::path::Path,
    state: &State<'_, AppState>,
) -> Result<(), CommandError> {
    let guard = state.runtime.begin_abort().map_err(gate_error)?;
    let outcome = abort_prepared_switch(root)
        .map_err(|error| CommandError::account_switch(error.to_string()))?;
    match outcome {
        AbortSwitchOutcome::Aborted | AbortSwitchOutcome::NoPreparedSwitch => {
            guard.activate_after_abort();
            Ok(())
        }
        AbortSwitchOutcome::NotPrepared(phase) => {
            guard.fail_closed();
            Err(CommandError::new(
                "ACCOUNT_SWITCH_ABORT_FORBIDDEN",
                format!("账号切换 journal 已推进到 {phase:?}，不能原地 abort"),
            ))
        }
    }
}

#[tauri::command]
pub fn native_prepare_account_switch(
    app: AppHandle,
    state: State<'_, AppState>,
    target_account_id: String,
) -> Result<SwitchStatus, CommandError> {
    ensure_restart_supported()?;
    ensure_runtime_active(&state)?;
    let root = data_dir(&app)?;
    // Close and drain before writing PREPARED. A concurrent prepare therefore
    // fails without creating another journal to abort.
    if let Err(error) = state.runtime.begin_switch() {
        if error == GateError::DrainTimeout
            && let Err(abort_error) = abort_account_switch_inner(&root, &state)
        {
            return Err(recovery_required(format!(
                "账号切换排空超时且无法回滚: {}",
                abort_error.message
            )));
        }
        return Err(gate_error(error));
    }
    let status = match prepare_account_switch(&root, &target_account_id) {
        Ok(status) => status,
        Err(error) => {
            // Preflight failed after the gate closed. There is no requestable
            // journal yet; reopen only if the journal is still absent/PREPARED.
            state.runtime.prepare_failed();
            if let Err(abort_error) = abort_account_switch_inner(&root, &state) {
                return Err(recovery_required(format!(
                    "目标校验失败且无法恢复写门: {}",
                    abort_error.message
                )));
            }
            return Err(CommandError::account_switch(error.to_string()));
        }
    };
    state.runtime.prepare_committed();
    Ok(status)
}

#[tauri::command]
pub fn native_request_account_switch(
    app: AppHandle,
    state: State<'_, AppState>,
    target_account_id: String,
    generation: u64,
) -> Result<SwitchStatus, CommandError> {
    // A direct mobile/unsupported restart request must fail before reminders are
    // cancelled or the journal advances.
    ensure_restart_supported()?;
    let root = data_dir(&app)?;
    let mut request = state.runtime.begin_request().map_err(gate_error)?;
    // Validate the journal before cancelling anything: a stale/malformed request
    // must not remove the active account's notifications.
    validate_account_switch_request(&root, &target_account_id, generation)
        .map_err(|error| CommandError::account_switch(error.to_string()))?;
    // Cancel the old account's system notifications before the process exits.
    // Failure keeps the gate closed at PREPARED; the frontend must cold-restart.
    cancel_current_account_reminders(&state)?;
    let status = request_account_switch(&root, &target_account_id, generation)
        .map_err(|error| CommandError::account_switch(error.to_string()))?;
    if let Err(error) = restart_after_switch(&app) {
        let rollback = rollback_pending_switch(&root, "RESTART_UNAVAILABLE");
        request.mark_failed();
        return Err(recovery_required(match rollback {
            Ok(_) => format!("无法自动重启，账号切换已回滚: {}", error.message),
            Err(rollback) => format!(
                "无法自动重启且回滚失败，需人工冷启动恢复: {}; {rollback}",
                error.message
            ),
        }));
    }
    request.mark_restart_required();
    Ok(status)
}

#[tauri::command]
pub fn native_abort_account_switch(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), CommandError> {
    let root = data_dir(&app)?;
    abort_account_switch_inner(&root, &state)
}

#[tauri::command]
pub fn native_restart_account_recovery(
    app: AppHandle,
    _state: State<'_, AppState>,
) -> Result<(), CommandError> {
    // No gate reset here: the replacement process performs startup recovery and
    // rebuilds CloudController/listeners from a fresh WebView.
    ensure_restart_supported()?;
    restart_after_switch(&app)
}

#[tauri::command]
pub fn native_account_switch_status(app: AppHandle) -> Result<SwitchStatus, CommandError> {
    switch_status(&data_dir(&app)?).map_err(|error| CommandError::account_switch(error.to_string()))
}

#[tauri::command]
pub fn native_verify_cloud_identity(
    app: AppHandle,
    state: State<'_, AppState>,
    email: String,
    api_url: String,
) -> Result<(), CommandError> {
    ensure_runtime_active(&state)?;
    verify_cloud_identity(&data_dir(&app)?, &email, &api_url).map_err(identity_error)
}

#[tauri::command]
pub fn native_mark_account_verified(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<AccountSummary, CommandError> {
    if !state.runtime.accepts_storage() {
        return Err(CommandError::new(
            "ACCOUNT_SWITCH_IN_PROGRESS",
            "账号切换进行中",
        ));
    }
    let _lease = state
        .runtime
        .enter_storage()
        .ok_or_else(|| CommandError::new("ACCOUNT_SWITCH_IN_PROGRESS", "账号切换进行中"))?;
    mark_account_verified(&data_dir(&app)?).map_err(identity_error)
}

#[cfg(desktop)]
fn ensure_restart_supported() -> Result<(), CommandError> {
    Ok(())
}

#[cfg(mobile)]
fn ensure_restart_supported() -> Result<(), CommandError> {
    Err(CommandError::new(
        "RESTART_UNSUPPORTED",
        "当前移动端运行时无法冷重启应用，账号切换未开始",
    ))
}

#[cfg(desktop)]
fn restart_after_switch(app: &AppHandle) -> Result<(), CommandError> {
    let handle = app.clone();
    std::thread::Builder::new()
        .name("shishi-account-switch-restart".to_owned())
        .spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(350));
            let env = handle.env();
            tauri::process::restart(&env);
        })
        .map(|_| ())
        .map_err(|error| CommandError::account_switch(format!("无法启动应用重启: {error}")))
}

#[cfg(mobile)]
fn restart_after_switch(_app: &AppHandle) -> Result<(), CommandError> {
    Err(CommandError::new(
        "RESTART_UNSUPPORTED",
        "当前移动端运行时无法冷重启应用，账号切换已回滚",
    ))
}

fn cancel_reminders_for_account(
    reminders: &dyn ReminderAdapter,
    account_id: &str,
) -> Result<(), CommandError> {
    fault_point(
        FaultPoint::ReminderCancel,
        Some("ACCOUNT_SWITCH_REQUEST"),
        Some(account_id),
        Some("cancel account-scoped reminders"),
    )
    .map_err(|error| CommandError::reminder(error.to_string()))?;
    let prefix = format!("account:{account_id}:");
    let entries = reminders.scheduled().map_err(CommandError::reminder)?;
    let mut failures = Vec::new();
    for entry in entries {
        if (entry.reminder_id.starts_with(&prefix) || !entry.reminder_id.starts_with("account:"))
            && let Err(error) = reminders.cancel(&entry.reminder_id)
        {
            failures.push(format!("{}: {error}", entry.reminder_id));
        }
    }
    if !failures.is_empty() {
        return Err(CommandError::reminder(format!(
            "无法取消旧账号系统通知: {}",
            failures.join("; ")
        )));
    }
    let remaining = reminders.scheduled().map_err(CommandError::reminder)?;
    if remaining.iter().any(|entry| {
        entry.reminder_id.starts_with(&prefix) || !entry.reminder_id.starts_with("account:")
    }) {
        return Err(CommandError::reminder(
            "旧账号系统通知仍有残留，已中止切换".to_owned(),
        ));
    }
    Ok(())
}

fn cancel_current_account_reminders(state: &State<'_, AppState>) -> Result<(), CommandError> {
    cancel_reminders_for_account(state.reminders.as_ref(), &state.account.account_id)
}

fn dispatch_scoped_storage(
    root: &std::path::Path,
    store: &TodoStore,
    action: &str,
    payload: Value,
) -> Result<Value, CommandError> {
    if action == "sync_initialize_cloud" {
        // Revalidate against the registry's active account immediately before
        // dispatch. Never trust a mutable WebView account id, and do this before
        // any snapshot/shadow/outbox/cursor transaction can begin.
        let initialize: CloudInitializeRequest =
            serde_json::from_value(payload.clone()).map_err(|error| {
                CommandError::new(
                    "VALIDATION_FAILED",
                    format!("cloud initialize payload is invalid: {error}"),
                )
            })?;
        let api_url = initialize.account_api_url.as_deref().ok_or_else(|| {
            CommandError::new(
                "ACCOUNT_IDENTITY_MISMATCH",
                "cloud initialization must include an API server identity",
            )
        })?;
        verify_cloud_identity(root, &initialize.account_email, api_url).map_err(identity_error)?;
        let canonical_api_url = normalize_api_url(api_url).map_err(identity_error)?;
        let diagnostics = store.sync_diagnostics().map_err(CommandError::from_store)?;
        if let Some(bound_email) = diagnostics.bound_account.as_deref()
            && normalize_email(bound_email) != normalize_email(&initialize.account_email)
        {
            return Err(CommandError::new(
                "ACCOUNT_IDENTITY_MISMATCH",
                "本机数据库已绑定其他登录邮箱，拒绝写入该云端快照",
            ));
        }
        if let Some(bound_api_url) = diagnostics.bound_api_url.as_deref()
            && normalize_api_url(bound_api_url).map_err(identity_error)? != canonical_api_url
        {
            return Err(CommandError::new(
                "ACCOUNT_IDENTITY_MISMATCH",
                "本机数据库已绑定其他 API 服务端，拒绝写入该云端快照",
            ));
        }
    }
    todo_native_core::dispatch(store, action, payload).map_err(CommandError::from_store)
}

/// The single storage IPC entry point. It runs on Tauri's blocking pool so a
/// slow SQLite query never parks the async runtime or the WebView thread.
#[tauri::command]
pub async fn todo_storage(
    app: AppHandle,
    state: State<'_, AppState>,
    request: StorageRequest,
) -> Result<Value, CommandError> {
    security::validate_storage_action(&request.action)
        .map_err(|message| CommandError::new("UNSUPPORTED", message))?;
    // A sync fence clear is the one write that must remain possible while the
    // switch gate is closed; quiescing the old cloud session needs it.
    let _lease = if request.action == "sync_clear_session" {
        None
    } else {
        Some(state.runtime.enter_storage().ok_or_else(|| {
            CommandError::new(
                "ACCOUNT_SWITCH_IN_PROGRESS",
                "账号切换进行中，当前账号已停止接受写入",
            )
        })?)
    };
    let store = Arc::clone(&state.store);
    let root = data_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        dispatch_scoped_storage(&root, &store, &request.action, request.payload)
    })
    .await
    .map_err(|error| CommandError::new("INTERNAL", format!("数据库任务异常: {error}")))?
}

#[tauri::command]
pub async fn schedule_reminder(
    state: State<'_, AppState>,
    reminder_id: String,
    fire_at_utc: String,
    title: String,
    body: Option<String>,
    exact: Option<bool>,
) -> Result<String, CommandError> {
    ensure_runtime_active(&state)?;
    let _lease = state.runtime.enter_storage().ok_or_else(|| {
        CommandError::new(
            "ACCOUNT_SWITCH_IN_PROGRESS",
            "账号切换进行中，当前账号已停止调度通知",
        )
    })?;
    ensure_reminder_permission(&state)?;
    state
        .reminders
        .schedule(
            &reminder_scope(&state.account.account_id, &reminder_id),
            &fire_at_utc,
            &title,
            body.as_deref().unwrap_or(""),
            exact.unwrap_or(false),
        )
        .map_err(CommandError::reminder)
}

#[tauri::command]
pub fn cancel_reminder(
    state: State<'_, AppState>,
    reminder_id: String,
) -> Result<(), CommandError> {
    ensure_runtime_active(&state)?;
    let _lease = state.runtime.enter_storage().ok_or_else(|| {
        CommandError::new(
            "ACCOUNT_SWITCH_IN_PROGRESS",
            "账号切换进行中，当前账号已停止调度通知",
        )
    })?;
    let scoped = reminder_scope(&state.account.account_id, &reminder_id);
    state
        .reminders
        .cancel(&scoped)
        .map_err(CommandError::reminder)?;
    match state.reminders.scheduled() {
        Ok(items) if items.iter().any(|item| item.reminder_id == scoped) => Err(CommandError::new(
            "REMINDER_CANCEL_RESIDUAL",
            "平台返回取消成功但队列仍有该提醒",
        )),
        Ok(_) => Ok(()),
        Err(error) => Err(CommandError::new(
            "REMINDER_CANCEL_VERIFY_FAILED",
            format!("无法核验提醒取消结果: {error}"),
        )),
    }
}

/// Reconcile the platform queue against open SQLite tasks. The queue is the
/// source of truth for already-armed notifications; only changed or stale
/// entries are touched.
#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReminderReconcileReport {
    pub scheduled: u32,
    pub cancelled: u32,
    pub unchanged: u32,
    pub skipped_past: u32,
    pub outside_window: u32,
    pub capacity_exceeded: u32,
    pub permission_denied: u32,
    pub failed: Vec<String>,
}

fn same_instant(left: &str, right: &str) -> bool {
    match (
        chrono::DateTime::parse_from_rfc3339(left),
        chrono::DateTime::parse_from_rfc3339(right),
    ) {
        (Ok(left), Ok(right)) => left == right,
        _ => left == right,
    }
}

const DEFAULT_REMINDER_BODY: &str = "该完成这项任务了";

/// iOS may report its display fallback from older pending requests. Treat the
/// fallback as the empty raw body so legacy entries are not rebuilt forever.
fn body_matches(current_body: &str, raw_body: &str) -> bool {
    if raw_body.is_empty() {
        current_body.is_empty() || current_body == DEFAULT_REMINDER_BODY
    } else {
        current_body == raw_body
    }
}

/// Cancel one entry and verify the platform queue no longer reports it. A
/// platform can return success while retaining the old notification; that must
/// become a visible failed item rather than a silent success.
fn cancel_entry(
    reminders: &dyn ReminderAdapter,
    reminder_id: &str,
    report: &mut ReminderReconcileReport,
    cancelled_ids: &mut Vec<String>,
) {
    match reminders.cancel(reminder_id) {
        Ok(()) => cancelled_ids.push(reminder_id.to_owned()),
        Err(error) => report
            .failed
            .push(format!("{reminder_id}: cancel failed: {error}")),
    }
}

/// Verify all successful cancellation calls in one platform queue read. Doing
/// this per entry made a large stale queue O(n^2) and could hold the storage
/// lease long enough to trip the 2 second switch drain timeout.
fn verify_cancellations(
    reminders: &dyn ReminderAdapter,
    cancelled_ids: &[String],
    report: &mut ReminderReconcileReport,
) {
    if cancelled_ids.is_empty() {
        return;
    }
    match reminders.scheduled() {
        Ok(items) => {
            for reminder_id in cancelled_ids {
                if items.iter().any(|item| &item.reminder_id == reminder_id) {
                    report.failed.push(format!(
                        "{reminder_id}: cancel reported success but entry remains"
                    ));
                } else {
                    report.cancelled += 1;
                }
            }
        }
        Err(error) => report
            .failed
            .push(format!("cancel residual verification failed: {error}")),
    }
}

/// Reconcile the system queue without any Tauri state. Keeping this pure makes
/// the repeated-reconcile/idempotency contract directly testable.
fn reconcile_reminder_queue(
    reminders: &dyn ReminderAdapter,
    tasks: &[todo_native_core::Task],
    account_id: &str,
) -> Result<ReminderReconcileReport, String> {
    let active: std::collections::HashSet<&str> =
        tasks.iter().map(|task| task.id.as_str()).collect();
    let prefix = format!("account:{account_id}:");
    let existing = reminders.scheduled()?;
    let mut report = ReminderReconcileReport::default();
    let mut cancelled_ids = Vec::new();
    let mut existing_by_id: std::collections::HashMap<
        String,
        crate::reminders::ScheduledReminderInfo,
    > = std::collections::HashMap::new();

    for item in existing {
        if let Some(task_id) = item.reminder_id.strip_prefix(&prefix) {
            if active.contains(task_id) {
                existing_by_id.insert(task_id.to_owned(), item);
            } else {
                cancel_entry(
                    reminders,
                    &item.reminder_id,
                    &mut report,
                    &mut cancelled_ids,
                );
            }
        } else {
            // Notifications created by another account, or legacy untagged
            // entries from before account scoping, must never be interpreted as
            // the current account's tasks.
            cancel_entry(
                reminders,
                &item.reminder_id,
                &mut report,
                &mut cancelled_ids,
            );
        }
    }

    if reminders.permission() != "granted" {
        verify_cancellations(reminders, &cancelled_ids, &mut report);
        report.permission_denied =
            tasks.iter().filter(|task| task.remind_at.is_some()).count() as u32;
        return Ok(report);
    }

    for task in tasks {
        if let Some(fire_at) = &task.remind_at {
            // The raw note is the fingerprint body. Empty notes must stay
            // empty here even when a platform shows a localized fallback.
            let body = if task.note.trim().is_empty() {
                ""
            } else {
                task.note.as_str()
            };
            if let Some(current) = existing_by_id.get(&task.id)
                && same_instant(&current.fire_at_utc, fire_at)
                && current.title == task.title
                && body_matches(&current.body, body)
            {
                report.unchanged += 1;
                continue;
            }
            let scoped = format!("{prefix}{}", task.id);
            match reminders.schedule(&scoped, fire_at, &task.title, body, false) {
                Ok(mode) if mode == "scheduled" || mode == "exact" || mode == "inexact" => {
                    report.scheduled += 1;
                }
                Ok(mode) if mode == "past" || mode == "skipped-past" => {
                    cancel_entry(reminders, &scoped, &mut report, &mut cancelled_ids);
                    report.skipped_past += 1;
                }
                Ok(mode) if mode == "outside-window" => {
                    cancel_entry(reminders, &scoped, &mut report, &mut cancelled_ids);
                    report.outside_window += 1;
                }
                Ok(mode) if mode == "capacity-exceeded" => {
                    cancel_entry(reminders, &scoped, &mut report, &mut cancelled_ids);
                    report.capacity_exceeded += 1;
                }
                Ok(mode) => report
                    .failed
                    .push(format!("{}: unknown mode {mode}", task.id)),
                Err(error) => {
                    cancel_entry(reminders, &scoped, &mut report, &mut cancelled_ids);
                    report.failed.push(format!("{}: {error}", task.id));
                }
            }
        }
    }
    verify_cancellations(reminders, &cancelled_ids, &mut report);
    Ok(report)
}

#[tauri::command]
pub async fn reschedule_reminders(
    state: State<'_, AppState>,
) -> Result<ReminderReconcileReport, CommandError> {
    ensure_runtime_active(&state)?;
    let account_id = state.account.account_id.clone();
    let store = Arc::clone(&state.store);
    let reminders: Arc<dyn ReminderAdapter> = Arc::clone(&state.reminders);
    // SQLite read-only candidate scan does not need to hold the switch lease.
    // Release it while the blocking query runs, then re-acquire before touching
    // the platform queue so a switch cannot be held up by a 100k scan.
    let tasks = tauri::async_runtime::spawn_blocking(move || store.upcoming_reminders())
        .await
        .map_err(|error| CommandError::new("INTERNAL", format!("提醒查询异常: {error}")))?
        .map_err(CommandError::from_store)?;
    let _lease = state.runtime.enter_storage().ok_or_else(|| {
        CommandError::new(
            "ACCOUNT_SWITCH_IN_PROGRESS",
            "账号切换进行中，当前账号已停止调度通知",
        )
    })?;
    reconcile_reminder_queue(reminders.as_ref(), &tasks, &account_id)
        .map_err(CommandError::reminder)
}

#[tauri::command]
pub fn reminder_permission(state: State<'_, AppState>) -> String {
    state.reminders.permission()
}

/// Explicitly prompts for notification permission. The existing
/// `schedule_reminder` command uses the same check before arming a reminder.
#[tauri::command]
pub fn request_reminder_permission(state: State<'_, AppState>) -> Result<String, CommandError> {
    state
        .reminders
        .request_permission()
        .map_err(CommandError::reminder)
}

#[cfg(desktop)]
#[tauri::command]
pub fn set_badge_count(window: WebviewWindow, count: i64) -> Result<(), CommandError> {
    let count = if count > 0 { Some(count) } else { None };
    window
        .set_badge_count(count)
        .map_err(|error| CommandError::new("BADGE_UNSUPPORTED", error.to_string()))
}

#[cfg(mobile)]
#[tauri::command]
pub fn set_badge_count(_window: WebviewWindow, _count: i64) -> Result<(), CommandError> {
    Ok(())
}

#[tauri::command]
pub async fn secure_token_get(
    app: AppHandle,
    state: State<'_, AppState>,
    key: String,
) -> Result<Option<String>, CommandError> {
    ensure_runtime_active(&state)?;
    let _lease = state.runtime.enter_storage().ok_or_else(|| {
        CommandError::new(
            "ACCOUNT_SWITCH_IN_PROGRESS",
            "账号切换进行中，当前账号已停止访问凭据",
        )
    })?;
    authorize_secure_key(&state, &key)?;
    tauri::async_runtime::spawn_blocking(move || secure_tokens::get(&app, &key))
        .await
        .map_err(|error| CommandError::new("SECURE_STORAGE", error.to_string()))?
        .map_err(|message| CommandError::new("SECURE_STORAGE", message))
}

#[tauri::command]
pub async fn secure_token_set(
    app: AppHandle,
    state: State<'_, AppState>,
    key: String,
    value: String,
) -> Result<(), CommandError> {
    ensure_runtime_active(&state)?;
    let _lease = state.runtime.enter_storage().ok_or_else(|| {
        CommandError::new(
            "ACCOUNT_SWITCH_IN_PROGRESS",
            "账号切换进行中，当前账号已停止访问凭据",
        )
    })?;
    authorize_secure_key(&state, &key)?;
    tauri::async_runtime::spawn_blocking(move || secure_tokens::set(&app, &key, &value))
        .await
        .map_err(|error| CommandError::new("SECURE_STORAGE", error.to_string()))?
        .map_err(|message| CommandError::new("SECURE_STORAGE", message))
}

#[tauri::command]
pub async fn secure_token_remove(
    app: AppHandle,
    state: State<'_, AppState>,
    key: String,
) -> Result<(), CommandError> {
    ensure_runtime_active(&state)?;
    let _lease = state.runtime.enter_storage().ok_or_else(|| {
        CommandError::new(
            "ACCOUNT_SWITCH_IN_PROGRESS",
            "账号切换进行中，当前账号已停止访问凭据",
        )
    })?;
    authorize_secure_key(&state, &key)?;
    tauri::async_runtime::spawn_blocking(move || secure_tokens::remove(&app, &key))
        .await
        .map_err(|error| CommandError::new("SECURE_STORAGE", error.to_string()))?
        .map_err(|message| CommandError::new("SECURE_STORAGE", message))
}

fn authorize_secure_key(state: &State<'_, AppState>, key: &str) -> Result<(), CommandError> {
    if is_refresh_key_for(&state.account.account_id, key) {
        return Ok(());
    }
    Err(CommandError::new(
        "CROSS_ACCOUNT_TOKEN",
        "不能访问其他账号的 Refresh Token",
    ))
}

fn is_refresh_key_for(account_id: &str, key: &str) -> bool {
    todo_native_accounts::refresh_token_key(account_id)
        .map(|expected| expected == key)
        .unwrap_or(false)
}

#[tauri::command]
pub fn get_desktop_settings(
    app: AppHandle,
    state: State<'_, LifecycleState>,
) -> Result<DesktopSettings, CommandError> {
    lifecycle::settings(&app, &state)
        .map_err(|message| CommandError::new("SETTINGS_ERROR", message))
}

#[tauri::command]
pub fn set_close_to_tray(
    state: State<'_, LifecycleState>,
    enabled: bool,
) -> Result<(), CommandError> {
    state
        .set_close_to_tray(enabled)
        .map_err(|message| CommandError::new("SETTINGS_ERROR", message))
}

#[tauri::command]
pub fn set_autostart(app: AppHandle, enabled: bool) -> Result<(), CommandError> {
    lifecycle::set_autostart(&app, enabled)
        .map_err(|message| CommandError::new("SETTINGS_ERROR", message))
}

fn ensure_reminder_permission(state: &State<'_, AppState>) -> Result<(), CommandError> {
    if state.reminders.permission() == "granted" {
        return Ok(());
    }
    let permission = state
        .reminders
        .request_permission()
        .map_err(CommandError::reminder)?;
    if permission == "granted" {
        Ok(())
    } else {
        Err(CommandError::new(
            "REMINDER_PERMISSION_DENIED",
            "系统通知权限未授予，无法预约提醒",
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::reminders::ScheduledReminderInfo;
    use std::sync::{
        Mutex,
        atomic::{AtomicUsize, Ordering},
    };
    use todo_native_core::{Task, TaskStatus};

    #[derive(Default)]
    struct FakeReminderAdapter {
        entries: Mutex<Vec<ScheduledReminderInfo>>,
        schedule_calls: AtomicUsize,
        permission: String,
        cancel_failures: Mutex<std::collections::HashSet<String>>,
        schedule_failure: std::sync::atomic::AtomicBool,
        scheduled_failure: std::sync::atomic::AtomicBool,
        retain_after_cancel: std::sync::atomic::AtomicBool,
    }

    impl FakeReminderAdapter {
        fn granted() -> Self {
            Self {
                entries: Mutex::new(Vec::new()),
                schedule_calls: AtomicUsize::new(0),
                permission: "granted".to_owned(),
                cancel_failures: Mutex::new(std::collections::HashSet::new()),
                schedule_failure: std::sync::atomic::AtomicBool::new(false),
                scheduled_failure: std::sync::atomic::AtomicBool::new(false),
                retain_after_cancel: std::sync::atomic::AtomicBool::new(false),
            }
        }
    }

    impl ReminderAdapter for FakeReminderAdapter {
        fn schedule(
            &self,
            reminder_id: &str,
            fire_at_utc: &str,
            title: &str,
            body: &str,
            _exact: bool,
        ) -> Result<String, String> {
            self.schedule_calls.fetch_add(1, Ordering::SeqCst);
            if self.schedule_failure.load(Ordering::SeqCst) {
                return Err("simulated schedule failure".to_owned());
            }
            let mut entries = self.entries.lock().expect("entries");
            entries.retain(|entry| entry.reminder_id != reminder_id);
            entries.push(ScheduledReminderInfo {
                reminder_id: reminder_id.to_owned(),
                fire_at_utc: fire_at_utc.to_owned(),
                title: title.to_owned(),
                body: body.to_owned(),
            });
            Ok("scheduled".to_owned())
        }

        fn cancel(&self, reminder_id: &str) -> Result<(), String> {
            if self
                .cancel_failures
                .lock()
                .expect("failures")
                .contains(reminder_id)
            {
                return Err("platform cancel failed".to_owned());
            }
            if self.retain_after_cancel.load(Ordering::SeqCst) {
                return Ok(());
            }
            self.entries
                .lock()
                .expect("entries")
                .retain(|entry| entry.reminder_id != reminder_id);
            Ok(())
        }

        fn scheduled(&self) -> Result<Vec<ScheduledReminderInfo>, String> {
            if self.scheduled_failure.load(Ordering::SeqCst) {
                return Err("simulated scheduled() failure".to_owned());
            }
            Ok(self.entries.lock().expect("entries").clone())
        }

        fn permission(&self) -> String {
            self.permission.clone()
        }

        fn request_permission(&self) -> Result<String, String> {
            Ok(self.permission.clone())
        }
    }

    fn reminder_task(id: &str, note: &str) -> Task {
        Task {
            id: id.to_owned(),
            list_id: None,
            title: format!("task {id}"),
            note: note.to_owned(),
            tags: Vec::new(),
            status: TaskStatus::Open,
            important: false,
            due_on: None,
            remind_at: Some("2026-10-24T09:00:00Z".to_owned()),
            remind_timezone: None,
            rank: "a0".to_owned(),
            series_id: None,
            occurrence_key: None,
            recurrence: None,
            completed_at: None,
            created_at: "2026-10-23T00:00:00Z".to_owned(),
            updated_at: "2026-10-23T00:00:00Z".to_owned(),
            deleted_at: None,
        }
    }

    #[test]
    fn repeated_reconcile_does_not_reschedule_unchanged_empty_body_reminders() {
        assert!(same_instant(
            "2026-10-24T09:00:00Z",
            "2026-10-24T09:00:00+00:00"
        ));
        let adapter = FakeReminderAdapter::granted();
        let tasks = vec![reminder_task("a", ""), reminder_task("b", "note")];

        let first = reconcile_reminder_queue(&adapter, &tasks, "default").expect("first reconcile");
        assert_eq!(first.scheduled, 2);
        assert_eq!(first.unchanged, 0);
        assert_eq!(adapter.schedule_calls.load(Ordering::SeqCst), 2);

        let second =
            reconcile_reminder_queue(&adapter, &tasks, "default").expect("second reconcile");
        assert_eq!(second.scheduled, 0);
        assert_eq!(second.unchanged, 2);
        assert!(second.failed.is_empty());
        assert_eq!(
            adapter.schedule_calls.load(Ordering::SeqCst),
            2,
            "unchanged notifications must not be cancelled/recreated"
        );
        let entries = adapter.scheduled().expect("entries");
        assert!(
            entries
                .iter()
                .any(|entry| entry.reminder_id == "account:default:a" && entry.body.is_empty())
        );
    }

    #[test]
    fn ios_default_body_is_treated_as_empty_raw_body() {
        let adapter = FakeReminderAdapter::granted();
        adapter
            .entries
            .lock()
            .expect("entries")
            .push(ScheduledReminderInfo {
                reminder_id: "account:default:a".to_owned(),
                fire_at_utc: "2026-10-24T09:00:00Z".to_owned(),
                title: "task a".to_owned(),
                body: DEFAULT_REMINDER_BODY.to_owned(),
            });
        let report = reconcile_reminder_queue(&adapter, &[reminder_task("a", "")], "default")
            .expect("legacy iOS entry");
        assert_eq!(report.scheduled, 0);
        assert_eq!(report.unchanged, 1);
        assert_eq!(adapter.schedule_calls.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn changed_raw_body_is_the_only_body_fingerprint_change() {
        let adapter = FakeReminderAdapter::granted();
        let task = reminder_task("a", "note");
        reconcile_reminder_queue(&adapter, std::slice::from_ref(&task), "default").expect("first");
        let mut changed = task.clone();
        changed.note = "changed".to_owned();
        let report = reconcile_reminder_queue(&adapter, std::slice::from_ref(&changed), "default")
            .expect("second");
        assert_eq!(report.scheduled, 1);
        assert_eq!(report.unchanged, 0);
        assert_eq!(adapter.schedule_calls.load(Ordering::SeqCst), 2);
    }

    #[cfg(feature = "native-qa")]
    struct RejectReminderCancel;

    #[cfg(feature = "native-qa")]
    impl todo_native_accounts::FaultInjector for RejectReminderCancel {
        fn decide(
            &self,
            event: &todo_native_accounts::FaultEvent,
        ) -> Option<todo_native_accounts::FaultAction> {
            (event.point == FaultPoint::ReminderCancel).then(|| {
                todo_native_accounts::FaultAction::Error {
                    code: "QA_REMINDER_CANCEL".to_owned(),
                    message: "QA injected reminder cancellation failure".to_owned(),
                }
            })
        }

        fn record(&self, _evidence: &todo_native_accounts::FaultEvidence) {}
    }

    #[cfg(feature = "native-qa")]
    #[test]
    fn reminder_cancel_fault_is_propagated_before_mutation() {
        let _fault_lock = crate::QA_FAULT_TEST_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let adapter = FakeReminderAdapter::granted();
        adapter
            .entries
            .lock()
            .expect("entries")
            .push(ScheduledReminderInfo {
                reminder_id: "account:default:a".to_owned(),
                fire_at_utc: "2026-10-24T09:00:00Z".to_owned(),
                title: "task a".to_owned(),
                body: String::new(),
            });
        todo_native_accounts::fault::install(std::sync::Arc::new(RejectReminderCancel))
            .expect("install fault");
        let error = cancel_reminders_for_account(&adapter, "default").expect_err("fault");
        assert!(
            error
                .message
                .contains("QA injected reminder cancellation failure")
        );
        assert_eq!(adapter.scheduled().expect("entries").len(), 1);
        todo_native_accounts::fault::clear();
    }

    #[test]
    fn reminder_schedule_and_queue_failures_are_visible() {
        let adapter = FakeReminderAdapter::granted();
        adapter.schedule_failure.store(true, Ordering::SeqCst);
        let report = reconcile_reminder_queue(&adapter, &[reminder_task("a", "")], "default")
            .expect("reconcile");
        assert_eq!(report.scheduled, 0);
        assert!(
            report
                .failed
                .iter()
                .any(|item| item.contains("simulated schedule failure"))
        );

        let adapter = FakeReminderAdapter::granted();
        adapter.scheduled_failure.store(true, Ordering::SeqCst);
        let error =
            reconcile_reminder_queue(&adapter, &[], "default").expect_err("scheduled error");
        assert!(error.contains("simulated scheduled() failure"));
    }

    #[test]
    fn cancel_success_with_a_residual_entry_is_a_failure() {
        let adapter = FakeReminderAdapter::granted();
        adapter
            .entries
            .lock()
            .expect("entries")
            .push(ScheduledReminderInfo {
                reminder_id: "account:default:old".to_owned(),
                fire_at_utc: "2026-10-24T09:00:00Z".to_owned(),
                title: "old".to_owned(),
                body: String::new(),
            });
        adapter.retain_after_cancel.store(true, Ordering::SeqCst);
        let report = reconcile_reminder_queue(&adapter, &[], "default").expect("reconcile");
        assert_eq!(
            report.cancelled, 0,
            "a residual entry is not a cancellation"
        );
        assert!(
            report
                .failed
                .iter()
                .any(|item| item.contains("reported success but entry remains"))
        );
        assert_eq!(adapter.scheduled().expect("entries").len(), 1);
    }

    #[test]
    fn legacy_and_other_account_notifications_are_never_reused() {
        let adapter = FakeReminderAdapter::granted();
        adapter.entries.lock().expect("entries").extend([
            ScheduledReminderInfo {
                reminder_id: "account:default:a".to_owned(),
                fire_at_utc: "2026-10-24T09:00:00Z".to_owned(),
                title: "task a".to_owned(),
                body: String::new(),
            },
            ScheduledReminderInfo {
                reminder_id: "account:other:leak".to_owned(),
                fire_at_utc: "2026-10-24T09:00:00Z".to_owned(),
                title: "other".to_owned(),
                body: String::new(),
            },
            ScheduledReminderInfo {
                reminder_id: "legacy-unprefixed".to_owned(),
                fire_at_utc: "2026-10-24T09:00:00Z".to_owned(),
                title: "legacy".to_owned(),
                body: String::new(),
            },
        ]);
        let report = reconcile_reminder_queue(&adapter, &[reminder_task("a", "")], "default")
            .expect("reconcile");
        assert_eq!(
            report.cancelled, 2,
            "foreign and legacy entries are cancelled"
        );
        assert!(report.failed.is_empty());
        let remaining = adapter.scheduled().expect("entries");
        assert_eq!(remaining.len(), 1);
        assert_eq!(remaining[0].reminder_id, "account:default:a");

        adapter.entries.lock().expect("entries").extend([
            ScheduledReminderInfo {
                reminder_id: "account:other:leak2".to_owned(),
                fire_at_utc: "2026-10-24T09:00:00Z".to_owned(),
                title: "other".to_owned(),
                body: String::new(),
            },
            ScheduledReminderInfo {
                reminder_id: "legacy-unprefixed-2".to_owned(),
                fire_at_utc: "2026-10-24T09:00:00Z".to_owned(),
                title: "legacy".to_owned(),
                body: String::new(),
            },
        ]);
        crate::reminders::cleanup_foreign_queue(&adapter, "default").expect("restart cleanup");
        let remaining = adapter.scheduled().expect("entries");
        assert_eq!(remaining.len(), 1);
        assert_eq!(remaining[0].reminder_id, "account:default:a");
    }

    #[test]
    fn scheduling_the_same_id_replaces_instead_of_duplicating() {
        let adapter = FakeReminderAdapter::granted();
        let mut task = reminder_task("a", "");
        reconcile_reminder_queue(&adapter, std::slice::from_ref(&task), "default").expect("first");
        task.title = "changed title".to_owned();
        reconcile_reminder_queue(&adapter, std::slice::from_ref(&task), "default").expect("second");
        let entries = adapter.scheduled().expect("entries");
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].title, "changed title");
        assert_eq!(adapter.schedule_calls.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn refresh_tokens_are_bound_to_the_current_account() {
        let a = "01a1673d-1000-7000-8000-000000000001";
        let b = "01a1673d-1000-7000-8000-000000000002";
        assert!(is_refresh_key_for(a, &format!("cloud-refresh:{a}")));
        assert!(!is_refresh_key_for(a, &format!("cloud-refresh:{b}")));
        assert!(!is_refresh_key_for(a, "refresh_token:v1"));
    }

    fn activate_pending_account(
        root: &std::path::Path,
        email: &str,
        api_url: &str,
    ) -> (todo_native_accounts::AccountSummary, std::path::PathBuf) {
        todo_native_accounts::ensure_active_account(root).expect("default");
        let account = todo_native_accounts::create_pending_cloud_account(root, email, api_url)
            .expect("pending account");
        let prepared = todo_native_accounts::prepare_account_switch(root, &account.id)
            .expect("prepare account");
        todo_native_accounts::request_account_switch(
            root,
            &account.id,
            prepared.generation.expect("generation"),
        )
        .expect("request account");
        todo_native_accounts::recover_pending_switch(root).expect("recover account");
        todo_native_accounts::finish_pending_switch(root).expect("finish account");
        let active = todo_native_accounts::ensure_active_account(root).expect("active account");
        assert_eq!(active.account_id, account.id);
        (account, active.database_path)
    }

    fn cloud_initialize(
        email: &str,
        api_url: &str,
        mode: todo_native_core::CloudMergeMode,
    ) -> Value {
        serde_json::to_value(CloudInitializeRequest {
            snapshot: todo_native_core::CloudSnapshot {
                cursor: "99".to_owned(),
                lists: Vec::new(),
                tasks: vec![reminder_task("cloud-c", "cloud C")],
                steps: Vec::new(),
                day_plans: Vec::new(),
            },
            mode,
            account_email: email.to_owned(),
            account_api_url: Some(api_url.to_owned()),
            session_id: None,
        })
        .expect("cloud payload")
    }

    fn assert_identity_rejected_without_db_change(
        root: &std::path::Path,
        db: &std::path::Path,
        payload: Value,
    ) {
        let store = TodoStore::open(db).expect("store");
        store.sync_set_enabled(true).expect("enable outbox");
        store
            .create_task(todo_native_core::NewTask {
                title: "pending local task".to_owned(),
                ..Default::default()
            })
            .expect("local task");
        let before = todo_native_accounts::read_snapshot(db).expect("before");
        let error = dispatch_scoped_storage(root, &store, "sync_initialize_cloud", payload)
            .expect_err("identity mismatch must fail before SQLite");
        assert_eq!(error.code, "ACCOUNT_IDENTITY_MISMATCH");
        let after = todo_native_accounts::read_snapshot(db).expect("after");
        assert_eq!(after, before, "cloud identity failure changed SQLite state");
    }

    #[test]
    fn pending_cloud_identity_is_checked_before_cloud_and_merge_writes() {
        let directory = tempfile::tempdir().expect("tempdir");
        let (_account, db) =
            activate_pending_account(directory.path(), "b@example.com", "https://b.example");
        for mode in [
            todo_native_core::CloudMergeMode::Cloud,
            todo_native_core::CloudMergeMode::Merge,
        ] {
            assert_identity_rejected_without_db_change(
                directory.path(),
                &db,
                cloud_initialize("c@example.com", "https://b.example", mode),
            );
            assert_identity_rejected_without_db_change(
                directory.path(),
                &db,
                cloud_initialize("b@example.com", "https://c.example", mode),
            );
        }
    }

    #[test]
    fn pending_cloud_identity_accepts_only_the_registered_email_and_server() {
        let directory = tempfile::tempdir().expect("tempdir");
        let (_account, db) =
            activate_pending_account(directory.path(), "b@example.com", "https://b.example");
        let store = TodoStore::open(&db).expect("store");
        let payload = cloud_initialize(
            "B@example.com",
            "HTTPS://B.EXAMPLE///",
            todo_native_core::CloudMergeMode::Cloud,
        );
        dispatch_scoped_storage(directory.path(), &store, "sync_initialize_cloud", payload)
            .expect("matching identity");
        let diagnostics = store.sync_diagnostics().expect("diagnostics");
        assert_eq!(diagnostics.bound_account.as_deref(), Some("b@example.com"));
        assert_eq!(
            diagnostics.bound_api_url.as_deref(),
            Some("https://b.example")
        );
    }

    #[test]
    fn cloud_identity_check_also_enforces_the_database_binding() {
        let directory = tempfile::tempdir().expect("tempdir");
        let active =
            todo_native_accounts::ensure_active_account(directory.path()).expect("default");
        let store = TodoStore::open(&active.database_path).expect("store");
        dispatch_scoped_storage(
            directory.path(),
            &store,
            "sync_initialize_cloud",
            cloud_initialize(
                "bound@example.com",
                "https://bound.example",
                todo_native_core::CloudMergeMode::Cloud,
            ),
        )
        .expect("initial binding");
        let before = todo_native_accounts::read_snapshot(&active.database_path).expect("before");

        let email_error = dispatch_scoped_storage(
            directory.path(),
            &store,
            "sync_initialize_cloud",
            cloud_initialize(
                "other@example.com",
                "https://bound.example",
                todo_native_core::CloudMergeMode::Merge,
            ),
        )
        .expect_err("bound email mismatch");
        assert_eq!(email_error.code, "ACCOUNT_IDENTITY_MISMATCH");
        let api_error = dispatch_scoped_storage(
            directory.path(),
            &store,
            "sync_initialize_cloud",
            cloud_initialize(
                "bound@example.com",
                "https://other.example",
                todo_native_core::CloudMergeMode::Merge,
            ),
        )
        .expect_err("bound API mismatch");
        assert_eq!(api_error.code, "ACCOUNT_IDENTITY_MISMATCH");
        let after = todo_native_accounts::read_snapshot(&active.database_path).expect("after");
        assert_eq!(
            after, before,
            "database binding failure changed SQLite state"
        );
    }

    #[test]
    fn foreign_account_and_legacy_reminders_are_cancelled_before_scheduling() {
        let adapter = FakeReminderAdapter::granted();
        adapter.entries.lock().expect("entries").extend([
            ScheduledReminderInfo {
                reminder_id: "account:other:a".to_owned(),
                fire_at_utc: "2026-10-24T09:00:00Z".to_owned(),
                title: "other".to_owned(),
                body: String::new(),
            },
            ScheduledReminderInfo {
                reminder_id: "account:default:stale".to_owned(),
                fire_at_utc: "2026-10-24T09:00:00Z".to_owned(),
                title: "stale".to_owned(),
                body: String::new(),
            },
            ScheduledReminderInfo {
                reminder_id: "legacy-raw-id".to_owned(),
                fire_at_utc: "2026-10-24T09:00:00Z".to_owned(),
                title: "legacy".to_owned(),
                body: String::new(),
            },
        ]);
        let report = reconcile_reminder_queue(&adapter, &[reminder_task("a", "")], "default")
            .expect("reconcile");
        assert_eq!(report.cancelled, 3);
        assert_eq!(report.scheduled, 1);
        let entries = adapter.scheduled().expect("entries");
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].reminder_id, "account:default:a");
    }

    #[test]
    fn startup_cleanup_removes_other_account_and_legacy_notifications() {
        let adapter = FakeReminderAdapter::granted();
        adapter.entries.lock().expect("entries").extend([
            ScheduledReminderInfo {
                reminder_id: "account:a:task-a".to_owned(),
                fire_at_utc: "2026-10-24T09:00:00Z".to_owned(),
                title: "A".to_owned(),
                body: String::new(),
            },
            ScheduledReminderInfo {
                reminder_id: "account:b:task-b".to_owned(),
                fire_at_utc: "2026-10-24T09:00:00Z".to_owned(),
                title: "B".to_owned(),
                body: String::new(),
            },
            ScheduledReminderInfo {
                reminder_id: "legacy".to_owned(),
                fire_at_utc: "2026-10-24T09:00:00Z".to_owned(),
                title: "legacy".to_owned(),
                body: String::new(),
            },
        ]);
        crate::reminders::cleanup_foreign_queue(&adapter, "b").expect("cleanup");
        let entries = adapter.scheduled().expect("entries");
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].reminder_id, "account:b:task-b");
    }

    #[test]
    fn switch_reminder_cancellation_failure_stops_the_switch() {
        let adapter = FakeReminderAdapter::granted();
        adapter.entries.lock().expect("entries").extend([
            ScheduledReminderInfo {
                reminder_id: "account:default:task-a".to_owned(),
                fire_at_utc: "2026-10-24T09:00:00Z".to_owned(),
                title: "A".to_owned(),
                body: String::new(),
            },
            ScheduledReminderInfo {
                reminder_id: "legacy-raw".to_owned(),
                fire_at_utc: "2026-10-24T09:00:00Z".to_owned(),
                title: "legacy".to_owned(),
                body: String::new(),
            },
            ScheduledReminderInfo {
                reminder_id: "account:other:task-c".to_owned(),
                fire_at_utc: "2026-10-24T09:00:00Z".to_owned(),
                title: "other".to_owned(),
                body: String::new(),
            },
        ]);
        adapter
            .cancel_failures
            .lock()
            .expect("failures")
            .insert("account:default:task-a".to_owned());
        let error = cancel_reminders_for_account(&adapter, "default").expect_err("cancel failure");
        assert_eq!(error.code, "REMINDER_ERROR");
        assert!(error.message.contains("无法取消旧账号系统通知"));

        adapter.cancel_failures.lock().expect("failures").clear();
        cancel_reminders_for_account(&adapter, "default").expect("retry cancel");
        let remaining = adapter.entries.lock().expect("entries").clone();
        assert_eq!(remaining.len(), 1);
        assert_eq!(remaining[0].reminder_id, "account:other:task-c");
    }

    #[test]
    fn startup_cleanup_reports_platform_cancel_failure() {
        let adapter = FakeReminderAdapter::granted();
        adapter
            .entries
            .lock()
            .expect("entries")
            .push(ScheduledReminderInfo {
                reminder_id: "account:other:a".to_owned(),
                fire_at_utc: "2026-10-24T09:00:00Z".to_owned(),
                title: "other".to_owned(),
                body: String::new(),
            });
        adapter
            .cancel_failures
            .lock()
            .expect("failures")
            .insert("account:other:a".to_owned());
        assert!(
            crate::reminders::cleanup_foreign_queue(&adapter, "default").is_err(),
            "platform failure must not be reported as success"
        );
    }

    #[test]
    fn reminder_cancel_failure_is_reported_not_hidden() {
        let adapter = FakeReminderAdapter::granted();
        adapter
            .entries
            .lock()
            .expect("entries")
            .push(ScheduledReminderInfo {
                reminder_id: "account:other:a".to_owned(),
                fire_at_utc: "2026-10-24T09:00:00Z".to_owned(),
                title: "other".to_owned(),
                body: String::new(),
            });
        adapter
            .cancel_failures
            .lock()
            .expect("failures")
            .insert("account:other:a".to_owned());
        let report = reconcile_reminder_queue(&adapter, &[reminder_task("a", "")], "default")
            .expect("reconcile");
        assert_eq!(report.cancelled, 0);
        assert!(!report.failed.is_empty());
        assert!(
            adapter
                .scheduled()
                .expect("entries")
                .iter()
                .any(|entry| entry.reminder_id == "account:other:a")
        );
    }

    #[test]
    fn permission_denied_is_reported_and_does_not_claim_scheduled() {
        let adapter = FakeReminderAdapter {
            permission: "denied".to_owned(),
            ..FakeReminderAdapter::granted()
        };
        let report = reconcile_reminder_queue(&adapter, &[reminder_task("a", "")], "default")
            .expect("report");
        assert_eq!(report.permission_denied, 1);
        assert_eq!(report.scheduled, 0);
        assert_eq!(adapter.schedule_calls.load(Ordering::SeqCst), 0);
    }
}
