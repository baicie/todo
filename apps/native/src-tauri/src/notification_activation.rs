//! Account-safe routing for reminder notification clicks.
//!
//! A notification action carries a versioned target token. Native validates it
//! against the account registry, the runtime gate and the live task store before
//! the WebView receives it. A target from another account is never opened, and
//! Native never switches accounts as a side effect of a click.
//!
//! # Delivery state machine
//!
//! Every activation ends in exactly one terminal state - delivered and
//! acknowledged, or rejected with observable evidence. The machine is a single
//! `Mutex<DeliveryState>` on purpose: the previous pending/delivery split let a
//! stale re-check after the pending pop silently drop an activation that had no
//! terminal outcome. With one lock and a *reserved* ownership slot there is no
//! window between "accounted for" and "committed":
//!
//! 1. reserve: under the lock verify the session and that nothing is in flight,
//!    pop the front activation and move it into the reserved slot.
//! 2. validate: outside the lock (the account registry and SQLite are touched
//!    here) - never hold the state lock across it.
//! 3. commit: under the lock, either promote the reservation to in flight, or
//!    reject it with evidence, or restore it to the queue front. A reserved slot
//!    is already owned, so a restore can never fail on capacity.
//!
//! The retry budget lives on the activation itself, so one activation can never
//! spend another's reload retry.
//!
//! # Clock boundary
//!
//! Every state boundary samples the monotonic clock itself - reserve, commit,
//! restore, reload-requeue and acknowledge. Validation touches the account
//! registry and SQLite and can outlast the remaining TTL, so a commit that
//! reused the pre-validation reading could deliver an activation that had
//! already expired. A commit that finds the activation expired therefore has a
//! distinct outcome, `ACTIVATION_EXPIRED_DURING_VALIDATION`.
//!
//! Each transition also records one bounded, redacted `ActivationDiagnostic`, so
//! a production rejection can be correlated back to its activation, its
//! notification instance, the listener session that was delivering and the
//! attempt number.

use std::{
    collections::VecDeque,
    sync::{
        Mutex,
        atomic::{AtomicU64, Ordering},
    },
    time::{Duration, Instant},
};

#[cfg(test)]
use std::collections::BTreeSet;

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
    /// Per-notification instance. Legacy/action tokens without this field retain
    /// target-key deduplication; new reminders get a fresh instance id so two
    /// legitimate reminders for the same task are not collapsed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notification_id: Option<String>,
}

impl NotificationTargetV1 {
    pub fn new(account_id: impl Into<String>, task_id: impl Into<String>) -> Option<Self> {
        let target = Self {
            account_id: account_id.into(),
            task_id: task_id.into(),
            source_version: 1,
            notification_id: None,
        };
        target.is_valid().then_some(target)
    }

    pub fn new_with_notification(
        account_id: impl Into<String>,
        task_id: impl Into<String>,
        notification_id: impl Into<String>,
    ) -> Option<Self> {
        let target = Self {
            account_id: account_id.into(),
            task_id: task_id.into(),
            source_version: 1,
            notification_id: Some(notification_id.into()),
        };
        target.is_valid().then_some(target)
    }

    pub fn is_valid(&self) -> bool {
        self.source_version == 1
            && valid_component(&self.account_id)
            && valid_component(&self.task_id)
            && self.notification_id.as_deref().is_none_or(valid_component)
            && self.account_id != self.task_id
    }

    pub fn encode_action_id(&self) -> String {
        match &self.notification_id {
            Some(notification_id) => format!(
                "{ACTION_PREFIX}{}:{}:{}",
                self.account_id, self.task_id, notification_id
            ),
            None => format!("{ACTION_PREFIX}{}:{}", self.account_id, self.task_id),
        }
    }

    pub fn parse_action_id(value: &str) -> Option<Self> {
        let rest = value.strip_prefix(ACTION_PREFIX)?;
        let mut parts = rest.splitn(3, ':');
        let account_id = parts.next()?;
        let task_id = parts.next()?;
        if task_id.contains(':') {
            return None;
        }
        match parts.next() {
            Some(notification_id) => {
                Self::new_with_notification(account_id, task_id, notification_id)
            }
            None => Self::new(account_id, task_id),
        }
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
#[cfg(test)]
pub fn target_from_reminder_id(reminder_id: &str) -> Option<NotificationTargetV1> {
    let rest = reminder_id.strip_prefix("account:")?;
    let (account_id, task_id) = rest.split_once(':')?;
    if task_id.contains(':') {
        return None;
    }
    NotificationTargetV1::new(account_id, task_id)
}

pub fn target_from_reminder_id_with_notification(
    reminder_id: &str,
    notification_id: &str,
) -> Option<NotificationTargetV1> {
    let rest = reminder_id.strip_prefix("account:")?;
    let (account_id, task_id) = rest.split_once(':')?;
    if task_id.contains(':') {
        return None;
    }
    NotificationTargetV1::new_with_notification(account_id, task_id, notification_id)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Activation {
    pub activation_id: String,
    pub target: NotificationTargetV1,
    pub task_title: String,
    /// Delivery bookkeeping owned by this activation. Skipped so the serialized
    /// WebView contract stays exactly `{activationId, target, taskTitle}`.
    #[serde(skip)]
    meta: ActivationMeta,
}

impl Activation {
    fn new(activation_id: String, target: NotificationTargetV1, task_title: String) -> Self {
        Self {
            activation_id,
            target,
            task_title,
            meta: ActivationMeta::default(),
        }
    }

    fn is_expired(&self, now: Instant) -> bool {
        self.meta.is_expired(now)
    }
}

/// Delivery bookkeeping for one activation. It never lives on the shared state:
/// a shared retry flag is what let one activation spend another's first requeue.
#[derive(Debug, Clone, Default)]
struct ActivationMeta {
    attempts: u32,
    requeues_used: u32,
    enqueued_at: Option<Instant>,
}

impl ActivationMeta {
    fn admitted_at(now: Instant) -> Self {
        Self {
            attempts: 0,
            requeues_used: 0,
            enqueued_at: Some(now),
        }
    }

    fn is_expired(&self, now: Instant) -> bool {
        self.enqueued_at
            .is_some_and(|enqueued_at| now.saturating_duration_since(enqueued_at) >= ACTIVATION_TTL)
    }
}

const DUPLICATE_TARGET_TTL: Duration = Duration::from_secs(300);
const COMPLETED_TARGET_CAPACITY: usize = 32;
const ACKED_ID_CAPACITY: usize = 32;

/// A click is only meaningful while its reminder is fresh. The budget is checked
/// when an activation is reserved and again when the reservation commits, so an
/// expired click never reaches the WebView.
const ACTIVATION_TTL: Duration = Duration::from_secs(300);

/// Reload retries that belong to a single activation: one listener reload may
/// requeue it, a second reload of the same unacknowledged activation expires it.
const MAX_REQUEUES_PER_ACTIVATION: u32 = 1;

/// The first delivery plus the single allowed requeue.
const MAX_DELIVERY_ATTEMPTS: u32 = 2;

/// Capacity for every activation the state holds: pending + reserved + in flight.
const ACTIVATION_CAPACITY: usize = 8;

/// Bounded rejection window handed to the WebView.
const REJECTION_CAPACITY: usize = 8;

/// Bounded drain size. Invalid or expired activations are reported and skipped in
/// one command call so the WebView does not have to poll once per stale click.
const MAX_ACTIVATION_DRAIN_ATTEMPTS: usize = 8;

/// The only ACK outcomes the delivery state machine accepts. Single source of
/// truth for the protocol: anything else fails closed before the state lock is
/// taken, which is what the WebView bridge relies on to detect a mismatch.
const ACCEPTED_ACK_OUTCOMES: [&str; 4] = ["opened", "rejected", "expired", "duplicate"];

fn is_accepted_ack_outcome(outcome: &str) -> bool {
    ACCEPTED_ACK_OUTCOMES.contains(&outcome)
}

/// The one place the delivery state machine reads the monotonic clock.
///
/// Every state boundary calls `now` for itself, so no reading is ever carried
/// across the account/SQLite validation in between. Production compiles this to
/// `Instant::now()`; a test pins a reading and moves it explicitly, which is why
/// no TTL case needs a sleep and no test has to subtract from an `Instant`.
#[derive(Default)]
struct Clock {
    #[cfg(test)]
    pinned: Mutex<Option<Instant>>,
}

impl Clock {
    fn now(&self) -> Instant {
        #[cfg(test)]
        if let Some(at) = *self.pinned.lock().expect("clock pin") {
            return at;
        }
        Instant::now()
    }

    #[cfg(test)]
    fn pin(&self, at: Instant) {
        *self.pinned.lock().expect("clock pin") = Some(at);
    }
}

/// Fixed capacity of the activation diagnostic window. Bounded memory only: the
/// state machine never writes diagnostics to disk.
const ACTIVATION_DIAGNOSTIC_CAPACITY: usize = 64;

/// Evidence older than this is dropped, on read and on write.
const ACTIVATION_DIAGNOSTIC_TTL: Duration = Duration::from_secs(300);

const TERMINAL_ACKED: &str = "acked";
const TERMINAL_REJECTED: &str = "rejected";

/// The transition an `ActivationDiagnostic` describes. `Acked` and `Rejected` are
/// the only terminal ones, and an activation owns at most one of them.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ActivationDiagnosticEvent {
    Delivered,
    Requeued,
    Rejected,
    Acked,
    DuplicateAck,
}

impl ActivationDiagnosticEvent {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Delivered => "delivered",
            Self::Requeued => "requeued",
            Self::Rejected => "rejected",
            Self::Acked => "acked",
            Self::DuplicateAck => "duplicate_ack",
        }
    }

    const fn terminal_outcome(self) -> Option<&'static str> {
        match self {
            Self::Rejected => Some(TERMINAL_REJECTED),
            Self::Acked => Some(TERMINAL_ACKED),
            Self::Delivered | Self::Requeued | Self::DuplicateAck => None,
        }
    }
}

/// Stable, short fingerprint of a listener session: FNV-1a over the session id.
/// Correlation needs stability, not secrecy - but the raw session string never
/// leaves the state machine, so support bundles stay free of it.
fn session_correlation(session_id: &str) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in session_id.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{hash:016x}")
}

/// One activation outcome, redacted for production support.
///
/// This field set is the whole contract. It deliberately cannot carry a task
/// title, a task id, task content, an account id, an account email, a refresh
/// token, raw notification text or any path: a bundle built from these records
/// must stay a correlation aid and never become a data-leak channel.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivationDiagnostic {
    pub activation_id: String,
    /// The notification instance the click came from, when the target has one.
    pub notification_instance_id: Option<String>,
    pub event_type: &'static str,
    pub rejection_code: Option<&'static str>,
    /// `acked` or `rejected` for a terminal record, `None` for every other event.
    pub terminal_outcome: Option<&'static str>,
    pub delivery_attempt: u32,
    /// Fingerprint of the listener session that produced this record.
    pub session_correlation: String,
    /// Monotonic milliseconds since the window was created.
    pub timestamp_millis: u64,
}

impl ActivationDiagnostic {
    fn from_activation(
        activation: &Activation,
        event: ActivationDiagnosticEvent,
        session_id: &str,
        rejection_code: Option<RejectionCode>,
    ) -> Self {
        Self {
            activation_id: activation.activation_id.clone(),
            notification_instance_id: activation.target.notification_id.clone(),
            event_type: event.as_str(),
            rejection_code: rejection_code.map(RejectionCode::as_str),
            terminal_outcome: event.terminal_outcome(),
            delivery_attempt: activation.meta.attempts,
            session_correlation: session_correlation(session_id),
            timestamp_millis: 0,
        }
    }

    fn duplicate_ack(acked: &AckedActivation, session_id: &str) -> Self {
        Self {
            activation_id: acked.activation_id.clone(),
            notification_instance_id: acked.notification_instance_id.clone(),
            event_type: ActivationDiagnosticEvent::DuplicateAck.as_str(),
            rejection_code: None,
            terminal_outcome: None,
            delivery_attempt: acked.delivery_attempt,
            session_correlation: session_correlation(session_id),
            timestamp_millis: 0,
        }
    }
}

/// Bounded ring of activation evidence: fixed capacity, fixed TTL, pruned on
/// read and on write, never persisted. Recording is best effort by
/// construction - it returns nothing and cannot change a delivery outcome.
#[derive(Default)]
struct ActivationDiagnostics {
    entries: VecDeque<ActivationDiagnostic>,
    /// Origin of the monotonic `timestamp_millis` column.
    origin: Option<Instant>,
}

impl ActivationDiagnostics {
    fn record(
        &mut self,
        activation: &Activation,
        event: ActivationDiagnosticEvent,
        session_id: &str,
        rejection_code: Option<RejectionCode>,
        now: Instant,
    ) {
        let diagnostic =
            ActivationDiagnostic::from_activation(activation, event, session_id, rejection_code);
        self.push(diagnostic, now);
    }

    fn record_duplicate_ack(&mut self, acked: &AckedActivation, session_id: &str, now: Instant) {
        self.push(ActivationDiagnostic::duplicate_ack(acked, session_id), now);
    }

    /// Stamp, prune, then apply the capacity bound: expired evidence must never
    /// evict fresh evidence.
    fn push(&mut self, mut diagnostic: ActivationDiagnostic, now: Instant) {
        diagnostic.timestamp_millis = self.stamp(now);
        self.prune(now);
        while self.entries.len() >= ACTIVATION_DIAGNOSTIC_CAPACITY {
            self.entries.pop_front();
        }
        self.entries.push_back(diagnostic);
    }

    fn stamp(&mut self, now: Instant) -> u64 {
        let origin = *self.origin.get_or_insert(now);
        u64::try_from(now.saturating_duration_since(origin).as_millis()).unwrap_or(u64::MAX)
    }

    fn prune(&mut self, now: Instant) {
        let Some(origin) = self.origin else {
            return;
        };
        let ttl = u64::try_from(ACTIVATION_DIAGNOSTIC_TTL.as_millis()).unwrap_or(u64::MAX);
        let age =
            u64::try_from(now.saturating_duration_since(origin).as_millis()).unwrap_or(u64::MAX);
        self.entries
            .retain(|entry| age.saturating_sub(entry.timestamp_millis) < ttl);
    }

    /// Read side of the prune: a snapshot never contains expired evidence.
    fn snapshot(&mut self, now: Instant) -> Vec<ActivationDiagnostic> {
        self.prune(now);
        self.entries.iter().cloned().collect()
    }
}

struct ReservedActivation {
    /// Reservation identity. A commit or restore only applies to the reservation
    /// it owns, so a stale holder can neither commit nor displace another one.
    ticket: u64,
    session_id: String,
    activation: Activation,
}

struct InFlightActivation {
    activation: Activation,
    session_id: String,
}

struct CompletedActivation {
    target_key: String,
    opened_at: Instant,
}

/// Terminal ACK record. It carries the handful of redacted fields a duplicate
/// ACK needs to correlate itself to the activation that already ended.
#[derive(Clone)]
struct AckedActivation {
    activation_id: String,
    notification_instance_id: Option<String>,
    delivery_attempt: u32,
}

/// Everything the delivery state machine owns, behind one lock.
#[derive(Default)]
struct DeliveryState {
    session_id: Option<String>,
    pending: VecDeque<Activation>,
    reserved: Option<ReservedActivation>,
    in_flight: Option<InFlightActivation>,
    completed: VecDeque<CompletedActivation>,
    acked: VecDeque<AckedActivation>,
    rejections: VecDeque<RejectedActivation>,
    diagnostics: ActivationDiagnostics,
    next_ticket: u64,
    #[cfg(test)]
    audit: AuditLedger,
}

impl DeliveryState {
    /// Every activation the state currently holds. The capacity cap applies to
    /// this number, not to the pending queue alone.
    fn live_count(&self) -> usize {
        self.pending.len()
            + usize::from(self.reserved.is_some())
            + usize::from(self.in_flight.is_some())
    }

    /// The rejection notice is best-effort UX; keep only the newest bounded
    /// window. Losing the oldest notice never loses an activation silently,
    /// because the terminal record is the rejection itself.
    fn push_rejection(&mut self, rejection: RejectedActivation) {
        while self.rejections.len() >= REJECTION_CAPACITY {
            self.rejections.pop_front();
        }
        self.rejections.push_back(rejection);
    }

    /// Terminal outcome: the activation was delivered and acknowledged. The
    /// bounded ACK record makes a duplicate ACK idempotent.
    fn terminate_acked(&mut self, activation: &Activation, session_id: &str, now: Instant) {
        self.acked.push_back(AckedActivation {
            activation_id: activation.activation_id.clone(),
            notification_instance_id: activation.target.notification_id.clone(),
            delivery_attempt: activation.meta.attempts,
        });
        while self.acked.len() > ACKED_ID_CAPACITY {
            self.acked.pop_front();
        }
        self.diagnostics.record(
            activation,
            ActivationDiagnosticEvent::Acked,
            session_id,
            None,
            now,
        );
        #[cfg(test)]
        self.audit
            .terminate(&activation.activation_id, Terminal::Acked);
    }

    /// Terminal outcome: the activation will never be delivered, and the reason
    /// is observable through the bounded rejection queue.
    fn terminate_rejected(
        &mut self,
        activation: &Activation,
        code: RejectionCode,
        session_id: &str,
        now: Instant,
    ) {
        // The bounded rejection is what the WebView shows; the redacted
        // diagnostic is what lets production correlate it to the activation.
        self.push_rejection(RejectedActivation::from_code(code));
        self.diagnostics.record(
            activation,
            ActivationDiagnosticEvent::Rejected,
            session_id,
            Some(code),
            now,
        );
        #[cfg(test)]
        self.audit
            .terminate(&activation.activation_id, Terminal::Rejected);
    }

    /// Admit a new activation. Capacity counts every held activation, and a
    /// displacement is always observable: reserved and in-flight slots belong to
    /// a delivery in progress and are never touched here.
    fn admit(&mut self, activation: Activation, now: Instant) {
        #[cfg(test)]
        self.audit.admit(&activation.activation_id);
        // A displaced activation is attributed to the listener session that
        // would have received it, if one is registered.
        let session_id = self.session_id.clone().unwrap_or_default();
        if self.live_count() >= ACTIVATION_CAPACITY
            && let Some(victim) = self.pending.pop_front()
        {
            self.terminate_rejected(
                &victim,
                RejectionCode::ActivationQueueOverflow,
                &session_id,
                now,
            );
        }
        if self.live_count() >= ACTIVATION_CAPACITY {
            // Unreachable while the cap exceeds the reserved/in-flight slots, so
            // the arrival itself is rejected rather than admitted over the cap.
            self.terminate_rejected(
                &activation,
                RejectionCode::ActivationQueueOverflow,
                &session_id,
                now,
            );
            return;
        }
        self.pending.push_back(activation);
    }

    fn completed_target_at(&mut self, target: &NotificationTargetV1, now: Instant) -> bool {
        let key = target_key(target);
        self.completed.retain(|completed| {
            now.saturating_duration_since(completed.opened_at) < DUPLICATE_TARGET_TTL
        });
        self.completed
            .iter()
            .any(|completed| completed.target_key == key)
    }

    /// Acknowledge the delivery outcome. Duplicate ACKs are idempotent; unknown
    /// ids, unknown outcomes and an ACK from another session fail closed without
    /// consuming the in-flight slot.
    fn acknowledge(
        &mut self,
        session_id: &str,
        activation_id: &str,
        outcome: &str,
        now: Instant,
    ) -> bool {
        // The command surface rejects an unknown outcome before taking the lock;
        // the check is repeated here so no future caller can reach the state
        // machine with an outcome outside the allow-list either.
        if !is_accepted_ack_outcome(outcome) {
            return false;
        }
        if let Some(in_flight) = self.in_flight.take() {
            if in_flight.activation.activation_id != activation_id
                || in_flight.session_id != session_id
            {
                self.in_flight = Some(in_flight);
                return false;
            }
            // Only a true opened business result suppresses future clicks of the
            // same target. rejected/expired/duplicate must not poison the target.
            if outcome == "opened" {
                self.completed.push_back(CompletedActivation {
                    target_key: target_key(&in_flight.activation.target),
                    opened_at: now,
                });
                while self.completed.len() > COMPLETED_TARGET_CAPACITY {
                    self.completed.pop_front();
                }
            }
            self.terminate_acked(&in_flight.activation, session_id, now);
            return true;
        }
        // A duplicate ACK is idempotent. It gets a non-terminal record so the
        // same activation can be correlated to both the ACK and its repeat
        // without owning two contradictory terminals.
        let duplicate = self
            .acked
            .iter()
            .find(|acked| acked.activation_id == activation_id)
            .cloned();
        match duplicate {
            Some(acked) => {
                self.diagnostics
                    .record_duplicate_ack(&acked, session_id, now);
                true
            }
            None => false,
        }
    }
}

/// What the reserve step produced.
enum ReserveOutcome {
    /// The activation is now in the reserved slot and owned by the caller.
    Reserved { ticket: u64, activation: Activation },
    /// One activation was finished terminally (duplicate or expired); the drain
    /// loop may keep going.
    Drained,
    /// Nothing can be reserved right now: no session, a delivery already in
    /// flight, a reservation outstanding, or an empty queue.
    Unavailable,
}

/// What the commit step produced.
enum CommitOutcome {
    Committed(Activation),
    /// The activation reached a terminal state (expiry) with evidence recorded.
    Expired,
    /// The reserve boundary accepted the activation, but validation outlived the
    /// remaining TTL and the commit boundary found it expired.
    ExpiredDuringValidation,
    /// The reservation was restored to the queue or was no longer ours.
    Relinquished,
    Poisoned,
}

/// Ownership of a reserved slot. While it is alive the activation is accounted
/// for in `DeliveryState::reserved`: capacity cannot displace it and no other
/// session can take it. Dropping it unresolved (panic in validation, early
/// return) restores the activation instead of leaking the slot.
struct ReservationGuard<'a> {
    state: &'a NotificationActivationState,
    ticket: u64,
    resolved: bool,
}

impl ReservationGuard<'_> {
    fn resolve(&mut self) {
        self.resolved = true;
    }
}

impl Drop for ReservationGuard<'_> {
    fn drop(&mut self) {
        if !self.resolved {
            // The restore boundary takes its own reading: a panic during a slow
            // validation must not resurrect a stale instant.
            self.state.restore_reservation(self.ticket);
        }
    }
}

#[derive(Default)]
pub struct NotificationActivationState {
    state: Mutex<DeliveryState>,
    sequence: AtomicU64,
    /// Every state boundary samples this; see `Clock`.
    clock: Clock,
}

impl NotificationActivationState {
    fn next_id(&self) -> String {
        let sequence = self.sequence.fetch_add(1, Ordering::SeqCst);
        let millis = chrono::Utc::now().timestamp_millis();
        format!("{millis}-{sequence}")
    }

    /// Run `visit` under the one state lock. `None` means the lock is poisoned:
    /// every caller fails closed instead of unwrapping a poisoned lock.
    fn with_state<R>(&self, visit: impl FnOnce(&mut DeliveryState) -> R) -> Option<R> {
        match self.state.lock() {
            Ok(mut state) => Some(visit(&mut state)),
            Err(_) => None,
        }
    }

    /// Admit boundary: the admission instant is sampled here.
    fn put(&self, activation: Activation) {
        self.admit_at(activation, self.clock.now());
    }

    fn admit_at(&self, mut activation: Activation, now: Instant) {
        activation.meta = ActivationMeta::admitted_at(now);
        let _ = self.with_state(|state| state.admit(activation, now));
    }

    /// Test entry point: run the admit boundary as if the clock reads `now`.
    #[cfg(test)]
    fn put_at(&self, activation: Activation, now: Instant) {
        self.clock.pin(now);
        self.put(activation);
    }

    /// Test-only raw pop. Bypasses delivery accounting, so tests that audit the
    /// invariant must not use it: it exists to assert queue order.
    #[cfg(test)]
    pub fn take(&self) -> Option<Activation> {
        self.with_state(|state| state.pending.pop_front()).flatten()
    }

    fn put_rejection(&self, rejection: RejectedActivation) {
        let _ = self.with_state(|state| state.push_rejection(rejection));
    }

    pub fn take_rejection(&self) -> Option<RejectedActivation> {
        self.with_state(|state| state.rejections.pop_front())
            .flatten()
    }

    /// Register the WebView listener session. A reload with a different session
    /// may have left an activation in flight; requeue it so a lost ACK does not
    /// lose the click. The retry budget belongs to that activation: its second
    /// reload expires it instead of delivering it a third time.
    pub fn listener_ready(&self, session_id: &str) -> bool {
        // Reload-requeue boundary: the requeue-versus-expire decision samples
        // the clock here, never at the caller.
        let now = self.clock.now();
        if !valid_component(session_id) {
            return false;
        }
        self.with_state(|state| {
            let is_new_session = state.session_id.as_deref() != Some(session_id);
            if is_new_session && let Some(in_flight) = state.in_flight.take() {
                let mut activation = in_flight.activation;
                if activation.meta.requeues_used >= MAX_REQUEUES_PER_ACTIVATION
                    || activation.is_expired(now)
                {
                    state.terminate_rejected(
                        &activation,
                        RejectionCode::ActivationExpired,
                        &in_flight.session_id,
                        now,
                    );
                } else {
                    activation.meta.requeues_used = activation.meta.requeues_used.saturating_add(1);
                    state.diagnostics.record(
                        &activation,
                        ActivationDiagnosticEvent::Requeued,
                        &in_flight.session_id,
                        None,
                        now,
                    );
                    // Ownership transfer inside one critical section: the slot is
                    // already accounted for, so capacity policy does not apply.
                    state.pending.push_front(activation);
                }
            }
            state.session_id = Some(session_id.to_owned());
        })
        .is_some()
    }

    /// Test entry point: run the reload boundary as if the clock reads `now`.
    #[cfg(test)]
    fn listener_ready_at(&self, session_id: &str, now: Instant) -> bool {
        self.clock.pin(now);
        self.listener_ready(session_id)
    }

    /// Reserve the front activation for a session - one critical section, no
    /// window in which the activation is accounted for nowhere.
    fn reserve_for_session(&self, session_id: &str) -> ReserveOutcome {
        // Reserve boundary.
        let now = self.clock.now();
        self.with_state(|state| {
            if state.session_id.as_deref() != Some(session_id)
                || state.in_flight.is_some()
                || state.reserved.is_some()
            {
                return ReserveOutcome::Unavailable;
            }
            let Some(activation) = state.pending.pop_front() else {
                return ReserveOutcome::Unavailable;
            };
            if state.completed_target_at(&activation.target, now) {
                // A duplicate click of a target that already opened must not open
                // it again; its terminal evidence is the bounded ACK record.
                state.terminate_acked(&activation, session_id, now);
                return ReserveOutcome::Drained;
            }
            if activation.is_expired(now) {
                state.terminate_rejected(
                    &activation,
                    RejectionCode::ActivationExpired,
                    session_id,
                    now,
                );
                return ReserveOutcome::Drained;
            }
            let ticket = state.next_ticket;
            state.next_ticket = state.next_ticket.wrapping_add(1);
            state.reserved = Some(ReservedActivation {
                ticket,
                session_id: session_id.to_owned(),
                activation: activation.clone(),
            });
            ReserveOutcome::Reserved { ticket, activation }
        })
        .unwrap_or(ReserveOutcome::Unavailable)
    }

    /// Promote our reservation to the in-flight slot, or hand it back / reject it.
    fn commit_reservation(&self, ticket: u64, session_id: &str, task_title: &str) -> CommitOutcome {
        // Commit boundary. Validation (account registry + SQLite) ran since the
        // reserve boundary and may have spent the whole remaining TTL, so this
        // reading is the only one that may decide expiry.
        let now = self.clock.now();
        self.with_state(|state| {
            let Some(reserved) = state.reserved.take() else {
                return CommitOutcome::Relinquished;
            };
            if reserved.ticket != ticket {
                state.reserved = Some(reserved);
                return CommitOutcome::Relinquished;
            }
            if reserved.session_id != session_id {
                state.pending.push_front(reserved.activation);
                return CommitOutcome::Relinquished;
            }
            let mut activation = reserved.activation;
            activation.task_title = task_title.to_owned();
            if activation.is_expired(now) {
                // The reserve boundary already rejected anything stale, so
                // reaching this branch means validation crossed the TTL.
                state.terminate_rejected(
                    &activation,
                    RejectionCode::ActivationExpiredDuringValidation,
                    session_id,
                    now,
                );
                return CommitOutcome::ExpiredDuringValidation;
            }
            if activation.meta.attempts >= MAX_DELIVERY_ATTEMPTS {
                state.terminate_rejected(
                    &activation,
                    RejectionCode::ActivationExpired,
                    session_id,
                    now,
                );
                return CommitOutcome::Expired;
            }
            if state.session_id.as_deref() != Some(session_id) || state.in_flight.is_some() {
                // The listener session changed while validation ran. Restoring is
                // an ownership transfer, so it can never fail on capacity.
                state.pending.push_front(activation);
                return CommitOutcome::Relinquished;
            }
            activation.meta.attempts = activation.meta.attempts.saturating_add(1);
            state.diagnostics.record(
                &activation,
                ActivationDiagnosticEvent::Delivered,
                session_id,
                None,
                now,
            );
            let delivered = activation.clone();
            state.in_flight = Some(InFlightActivation {
                activation,
                session_id: session_id.to_owned(),
            });
            CommitOutcome::Committed(delivered)
        })
        .unwrap_or(CommitOutcome::Poisoned)
    }

    /// Terminal for a reservation whose validation failed.
    fn reject_reservation(&self, ticket: u64, code: RejectionCode) {
        // Validation-failure boundary.
        let now = self.clock.now();
        let _ = self.with_state(|state| {
            let Some(reserved) = state.reserved.take() else {
                return;
            };
            if reserved.ticket != ticket {
                state.reserved = Some(reserved);
                return;
            }
            state.terminate_rejected(&reserved.activation, code, &reserved.session_id, now);
        });
    }

    /// Hand an unresolved reservation back to the queue front (same position it
    /// was taken from). On a poisoned lock the slot simply stays accounted for in
    /// the reserved state, which is inspectable, rather than being lost.
    fn restore_reservation(&self, ticket: u64) {
        // Restore boundary.
        let now = self.clock.now();
        let _ = self.with_state(|state| {
            let Some(reserved) = state.reserved.take() else {
                return;
            };
            if reserved.ticket != ticket {
                state.reserved = Some(reserved);
                return;
            }
            if reserved.activation.is_expired(now) {
                state.terminate_rejected(
                    &reserved.activation,
                    RejectionCode::ActivationExpired,
                    &reserved.session_id,
                    now,
                );
                return;
            }
            state.pending.push_front(reserved.activation);
        });
    }

    /// Take one valid activation for a specific listener session. The activation
    /// remains in flight until the WebView acknowledges the business outcome.
    fn take_for_listener<F, R>(
        &self,
        session_id: &str,
        mut validate: F,
        mut reject: R,
    ) -> Option<Activation>
    where
        F: FnMut(&Activation) -> Result<String, RejectionCode>,
        R: FnMut(RejectionCode),
    {
        for _ in 0..MAX_ACTIVATION_DRAIN_ATTEMPTS {
            // Each boundary samples the clock for itself. A validation that
            // outlives the remaining TTL is caught at commit instead of
            // inheriting a reading taken before the account/SQLite work.
            let (ticket, activation) = match self.reserve_for_session(session_id) {
                ReserveOutcome::Reserved { ticket, activation } => (ticket, activation),
                ReserveOutcome::Drained => continue,
                ReserveOutcome::Unavailable => return None,
            };
            let mut reservation = ReservationGuard {
                state: self,
                ticket,
                resolved: false,
            };
            // The account registry and SQLite are touched here: never hold the
            // state lock across validation.
            match validate(&activation) {
                Ok(task_title) => match self.commit_reservation(ticket, session_id, &task_title) {
                    CommitOutcome::Committed(delivered) => {
                        reservation.resolve();
                        return Some(delivered);
                    }
                    CommitOutcome::Expired | CommitOutcome::ExpiredDuringValidation => {
                        reservation.resolve();
                        continue;
                    }
                    CommitOutcome::Relinquished => {
                        reservation.resolve();
                        return None;
                    }
                    CommitOutcome::Poisoned => return None,
                },
                Err(code) => {
                    self.reject_reservation(ticket, code);
                    reservation.resolve();
                    reject(code);
                    continue;
                }
            }
        }
        None
    }

    /// Test entry point: run the drain as if every boundary read `now` - unless
    /// `validate` moves the clock, in which case commit sees the moved reading.
    #[cfg(test)]
    fn take_for_listener_at<F, R>(
        &self,
        session_id: &str,
        now: Instant,
        validate: F,
        reject: R,
    ) -> Option<Activation>
    where
        F: FnMut(&Activation) -> Result<String, RejectionCode>,
        R: FnMut(RejectionCode),
    {
        self.clock.pin(now);
        self.take_for_listener(session_id, validate, reject)
    }

    /// Read-only snapshot of the bounded, pruned activation diagnostic window.
    pub fn activation_diagnostics(&self) -> Vec<ActivationDiagnostic> {
        // Read boundary: stale evidence is dropped here.
        let now = self.clock.now();
        self.with_state(|state| state.diagnostics.snapshot(now))
            .unwrap_or_default()
    }

    /// Acknowledge the delivery outcome. Duplicate ACKs are idempotent; unknown
    /// ids or unknown outcomes fail closed.
    pub fn acknowledge(&self, session_id: &str, activation_id: &str, outcome: &str) -> bool {
        if !is_accepted_ack_outcome(outcome) {
            return false;
        }
        // ACK boundary.
        let now = self.clock.now();
        self.with_state(|state| state.acknowledge(session_id, activation_id, outcome, now))
            .unwrap_or(false)
    }
}

fn target_key(target: &NotificationTargetV1) -> String {
    match &target.notification_id {
        Some(notification_id) => {
            format!(
                "{}:{}:{}",
                target.account_id, target.task_id, notification_id
            )
        }
        None => format!("{}:{}", target.account_id, target.task_id),
    }
}

/// Test-only terminal marker for the accounting audit.
#[cfg(test)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Terminal {
    Acked,
    Rejected,
}

/// Test-only ledger: what was admitted and how each activation terminated.
#[cfg(test)]
#[derive(Default)]
struct AuditLedger {
    admitted: BTreeSet<String>,
    terminated: Vec<(String, Terminal)>,
}

#[cfg(test)]
impl AuditLedger {
    fn admit(&mut self, activation_id: &str) {
        self.admitted.insert(activation_id.to_owned());
    }

    fn terminate(&mut self, activation_id: &str, terminal: Terminal) {
        self.terminated.push((activation_id.to_owned(), terminal));
    }
}

#[cfg(test)]
impl NotificationActivationState {
    fn completed_target(&self, target: &NotificationTargetV1) -> bool {
        self.completed_target_at(target, Instant::now())
    }

    fn completed_target_at(&self, target: &NotificationTargetV1, now: Instant) -> bool {
        self.clock.pin(now);
        self.with_state(|state| state.completed_target_at(target, now))
            .unwrap_or(true)
    }

    /// Accounting invariant: every admitted activation is live in exactly one
    /// slot, or has exactly one terminal record - never both, never neither.
    /// Capacity is never exceeded.
    fn audit(&self) -> Result<(), String> {
        let Ok(state) = self.state.lock() else {
            return Err("state lock poisoned".to_owned());
        };
        if state.live_count() > ACTIVATION_CAPACITY {
            return Err(format!(
                "live activation count {} exceeds capacity {ACTIVATION_CAPACITY}",
                state.live_count()
            ));
        }
        let mut live: Vec<(&str, &'static str)> = Vec::new();
        live.extend(
            state
                .pending
                .iter()
                .map(|item| (item.activation_id.as_str(), "pending")),
        );
        if let Some(reserved) = state.reserved.as_ref() {
            live.push((reserved.activation.activation_id.as_str(), "reserved"));
        }
        if let Some(in_flight) = state.in_flight.as_ref() {
            live.push((in_flight.activation.activation_id.as_str(), "in_flight"));
        }
        for (index, (activation_id, slot)) in live.iter().enumerate() {
            if live[..index]
                .iter()
                .any(|(earlier, _)| earlier == activation_id)
            {
                return Err(format!(
                    "activation {activation_id} is live in more than one slot ({slot})"
                ));
            }
            if !state
                .audit
                .admitted
                .iter()
                .any(|admitted| admitted == activation_id)
            {
                return Err(format!(
                    "activation {activation_id} is live in {slot} but was never admitted"
                ));
            }
        }
        for activation_id in &state.audit.admitted {
            let live_slot = live
                .iter()
                .find(|(live_id, _)| live_id == &activation_id.as_str())
                .map(|(_, slot)| *slot);
            let terminals = state
                .audit
                .terminated
                .iter()
                .filter(|(terminal_id, _)| terminal_id == activation_id)
                .count();
            match (live_slot, terminals) {
                (Some(_), 0) | (None, 1) => {}
                (Some(slot), terminals) => {
                    return Err(format!(
                        "activation {activation_id} is live in {slot} and has {terminals} terminal records"
                    ));
                }
                (None, terminals) => {
                    return Err(format!(
                        "activation {activation_id} has no live slot and {terminals} terminal records"
                    ));
                }
            }
        }
        Ok(())
    }

    fn assert_audit(&self) {
        if let Err(failure) = self.audit() {
            panic!("activation accounting invariant violated: {failure}");
        }
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
    ActivationExpired,
    /// The reserve boundary accepted the activation but validation outlived the
    /// remaining TTL, so the commit boundary found it expired. Kept distinct
    /// from a plain expiry so production can tell a slow validation apart from
    /// a click that was already stale when it was picked up.
    ActivationExpiredDuringValidation,
    ActivationQueueOverflow,
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
            Self::ActivationExpired => "ACTIVATION_EXPIRED",
            Self::ActivationExpiredDuringValidation => "ACTIVATION_EXPIRED_DURING_VALIDATION",
            Self::ActivationQueueOverflow => "ACTIVATION_QUEUE_OVERFLOW",
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
            Self::ActivationExpired | Self::ActivationExpiredDuringValidation => {
                "提醒已过期，请重新打开任务"
            }
            Self::ActivationQueueOverflow => "提醒打开过于频繁，请稍后重新打开任务",
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
    let activation = Activation::new(
        app.state::<NotificationActivationState>().next_id(),
        target,
        task_title,
    );
    app.state::<NotificationActivationState>()
        .put(activation.clone());
    show_window(app);
    let _ = app.emit(EVENT_OPEN, activation);
}

#[cfg(test)]
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
pub fn native_notification_listener_ready(
    activation_state: State<'_, NotificationActivationState>,
    session_id: String,
) -> bool {
    activation_state.listener_ready(&session_id)
}

#[tauri::command]
pub fn native_take_notification_activation(
    app: AppHandle,
    activation_state: State<'_, NotificationActivationState>,
    app_state: State<'_, AppState>,
    session_id: String,
) -> Option<Activation> {
    activation_state.take_for_listener(
        &session_id,
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
pub fn native_ack_notification_activation(
    activation_state: State<'_, NotificationActivationState>,
    session_id: String,
    activation_id: String,
    outcome: String,
) -> bool {
    activation_state.acknowledge(&session_id, &activation_id, &outcome)
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
    use std::sync::{Arc, Barrier};

    use super::*;

    fn activation(id: &str, task: &str) -> Activation {
        Activation::new(
            id.to_owned(),
            NotificationTargetV1::new("default", task).expect("target"),
            "task".to_owned(),
        )
    }

    fn activation_for(account: &str, id: &str, task: &str) -> Activation {
        Activation::new(
            id.to_owned(),
            NotificationTargetV1::new(account, task).expect("target"),
            "task".to_owned(),
        )
    }

    fn activation_with_notification(id: &str, task: &str, notification: &str) -> Activation {
        Activation::new(
            id.to_owned(),
            NotificationTargetV1::new_with_notification("default", task, notification)
                .expect("target"),
            "task".to_owned(),
        )
    }

    fn deliver(state: &NotificationActivationState, session_id: &str) -> Option<String> {
        deliver_at(state, session_id, Instant::now())
    }

    fn deliver_at(
        state: &NotificationActivationState,
        session_id: &str,
        at: Instant,
    ) -> Option<String> {
        state
            .take_for_listener_at(session_id, at, |_| Ok("live".to_owned()), |_| {})
            .map(|activation| activation.activation_id)
    }

    /// Forward-only clock helper. `Instant + Duration` cannot fail, while
    /// `Instant - Duration` panics whenever the result would precede the
    /// monotonic clock origin (the machine boot), so no test may go backwards.
    fn after(base: Instant, delta: Duration) -> Instant {
        base + delta
    }

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
            "shishi.task.v1:account:task:../escape",
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
    fn notification_instance_round_trips_and_distinguishes_targets() {
        let first = NotificationTargetV1::new_with_notification("default", "task-1", "instance-1")
            .expect("first target");
        let second = NotificationTargetV1::new_with_notification("default", "task-1", "instance-2")
            .expect("second target");
        assert_ne!(target_key(&first), target_key(&second));
        assert_eq!(
            NotificationTargetV1::parse_action_id(&first.encode_action_id()),
            Some(first)
        );
        assert_eq!(
            NotificationTargetV1::parse_action_id(&second.encode_action_id()),
            Some(second)
        );
        let scoped =
            target_from_reminder_id_with_notification("account:default:task-1", "instance-1")
                .expect("scoped instance");
        assert_eq!(scoped.notification_id.as_deref(), Some("instance-1"));
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
        state.put(activation("stale", "stale-task"));
        state.put(activation("valid", "task-ok"));

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
        state.put(activation("a1", "task-1"));
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
            state.put(activation(&format!("a{index}"), &format!("task-{index}")));
        }
        assert_eq!(state.take().expect("pending").activation_id, "a2");
        // Both displaced clicks are observable instead of silently dropped.
        assert_eq!(
            state.take_rejection().expect("first overflow").code,
            "ACTIVATION_QUEUE_OVERFLOW"
        );
        assert_eq!(
            state.take_rejection().expect("second overflow").code,
            "ACTIVATION_QUEUE_OVERFLOW"
        );
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
            (RejectionCode::ActivationExpired, "ACTIVATION_EXPIRED"),
            (
                RejectionCode::ActivationExpiredDuringValidation,
                "ACTIVATION_EXPIRED_DURING_VALIDATION",
            ),
            (
                RejectionCode::ActivationQueueOverflow,
                "ACTIVATION_QUEUE_OVERFLOW",
            ),
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
        state.put(activation("valid", "task-1"));
        assert_eq!(state.take().expect("activation").activation_id, "valid");
        assert_eq!(
            state.take_rejection().expect("rejection").code,
            "TASK_NOT_FOUND"
        );
    }

    #[test]
    fn distinct_notification_instances_for_same_task_are_both_delivered() {
        let state = NotificationActivationState::default();
        state.put(activation_with_notification("a1", "task-1", "instance-1"));
        state.put(activation_with_notification("a2", "task-1", "instance-2"));
        assert!(state.listener_ready("s1"));
        let first = state
            .take_for_listener("s1", |_| Ok("task".to_owned()), |_| {})
            .expect("first");
        assert_eq!(first.activation_id, "a1");
        assert!(state.acknowledge("s1", "a1", "opened"));
        let second = state
            .take_for_listener("s1", |_| Ok("task".to_owned()), |_| {})
            .expect("second legitimate reminder");
        assert_eq!(second.activation_id, "a2");
        assert!(state.acknowledge("s1", "a2", "opened"));
        state.assert_audit();
    }

    #[test]
    fn delivery_requires_ready_session_and_ack() {
        let state = NotificationActivationState::default();
        state.put(activation("a1", "task-1"));
        state.put(activation("a2", "task-2"));
        assert!(
            state
                .take_for_listener("s1", |_| Ok("task".to_owned()), |_| {})
                .is_none()
        );
        assert!(state.listener_ready("s1"));
        let first = state
            .take_for_listener("s1", |_| Ok("task".to_owned()), |_| {})
            .expect("first");
        assert_eq!(first.activation_id, "a1");
        assert!(
            state
                .take_for_listener("s1", |_| Ok("task".to_owned()), |_| {})
                .is_none(),
            "in-flight activation must not be concurrently redelivered"
        );
        assert!(state.acknowledge("s1", "a1", "opened"));
        let second = state
            .take_for_listener("s1", |_| Ok("task".to_owned()), |_| {})
            .expect("second");
        assert_eq!(second.activation_id, "a2");
        assert!(state.acknowledge("s1", "a2", "opened"));
        state.assert_audit();
    }

    #[test]
    fn listener_reload_requeues_inflight_once() {
        let state = NotificationActivationState::default();
        state.put(activation("a1", "task-1"));
        assert!(state.listener_ready("s1"));
        assert_eq!(
            state
                .take_for_listener("s1", |_| Ok("task".to_owned()), |_| {})
                .expect("first")
                .activation_id,
            "a1"
        );
        assert!(state.listener_ready("s2"));
        assert!(
            !state.acknowledge("s1", "a1", "opened"),
            "old session must not ACK a requeued activation"
        );
        assert_eq!(
            state
                .take_for_listener("s2", |_| Ok("task".to_owned()), |_| {})
                .expect("requeued")
                .activation_id,
            "a1"
        );
        assert!(
            !state.acknowledge("s1", "a1", "opened"),
            "old session must not ACK the new in-flight delivery"
        );
        assert!(state.acknowledge("s2", "a1", "opened"));
        state.assert_audit();
    }

    #[test]
    fn rejected_or_expired_ack_does_not_block_same_target() {
        for outcome in ["rejected", "expired"] {
            let state = NotificationActivationState::default();
            state.put(activation("a1", "task-1"));
            assert!(state.listener_ready("s1"));
            assert!(
                state
                    .take_for_listener("s1", |_| Ok("task".to_owned()), |_| {})
                    .is_some()
            );
            assert!(state.acknowledge("s1", "a1", outcome));
            state.put(activation("a2", "task-1"));
            assert_eq!(
                state
                    .take_for_listener("s1", |_| Ok("task".to_owned()), |_| {})
                    .expect("legitimate later activation")
                    .activation_id,
                "a2",
                "{outcome} must not poison target"
            );
            state.assert_audit();
        }
    }

    #[test]
    fn opened_target_is_suppressed_only_within_ttl() {
        let state = NotificationActivationState::default();
        let target = NotificationTargetV1::new("default", "task-1").expect("target");
        state.put(Activation::new(
            "a1".to_owned(),
            target.clone(),
            "task".to_owned(),
        ));
        assert!(state.listener_ready("s1"));
        assert!(
            state
                .take_for_listener("s1", |_| Ok("task".to_owned()), |_| {})
                .is_some()
        );
        assert!(state.acknowledge("s1", "a1", "opened"));
        assert!(state.completed_target(&target));
        assert!(
            !state.completed_target_at(
                &target,
                after(
                    Instant::now(),
                    DUPLICATE_TARGET_TTL + Duration::from_secs(1)
                )
            ),
            "target suppression must expire"
        );
    }

    #[test]
    fn identical_target_distinct_legitimate_reminders_after_rejection() {
        let state = NotificationActivationState::default();
        state.put(activation("a1", "task-1"));
        state.put(activation("a2", "task-1"));
        assert!(state.listener_ready("s1"));
        assert_eq!(
            state
                .take_for_listener("s1", |_| Ok("task".to_owned()), |_| {})
                .expect("first")
                .activation_id,
            "a1"
        );
        assert!(state.acknowledge("s1", "a1", "rejected"));
        assert_eq!(
            state
                .take_for_listener("s1", |_| Ok("task".to_owned()), |_| {})
                .expect("second")
                .activation_id,
            "a2"
        );
        state.assert_audit();
    }

    #[test]
    fn delivery_queue_drops_oldest_and_drains_fifo() {
        let state = NotificationActivationState::default();
        for index in 0..10 {
            state.put(activation(&format!("a{index}"), &format!("task-{index}")));
        }
        assert!(state.listener_ready("s1"));
        for index in 2..10 {
            let delivered = state
                .take_for_listener("s1", |_| Ok("task".to_owned()), |_| {})
                .expect("queued");
            assert_eq!(delivered.activation_id, format!("a{index}"));
            assert!(state.acknowledge("s1", &delivered.activation_id, "opened"));
            state.assert_audit();
        }
        assert!(
            state
                .take_for_listener("s1", |_| Ok("task".to_owned()), |_| {})
                .is_none()
        );
        state.assert_audit();
    }

    #[test]
    fn second_listener_reload_expires_inflight_without_redelivery() {
        let state = NotificationActivationState::default();
        state.put(activation("a1", "task-1"));
        assert!(state.listener_ready("s1"));
        assert!(
            state
                .take_for_listener("s1", |_| Ok("task".to_owned()), |_| {})
                .is_some()
        );
        assert!(state.listener_ready("s2"));
        assert!(
            state
                .take_for_listener("s2", |_| Ok("task".to_owned()), |_| {})
                .is_some()
        );
        assert!(state.listener_ready("s3"));
        assert!(
            state
                .take_for_listener("s3", |_| Ok("task".to_owned()), |_| {})
                .is_none()
        );
        assert_eq!(
            state.take_rejection().expect("expired").code,
            "ACTIVATION_EXPIRED"
        );
        state.assert_audit();
    }

    #[test]
    fn invalid_listener_session_is_rejected() {
        let state = NotificationActivationState::default();
        assert!(!state.listener_ready(""));
        assert!(!state.listener_ready("bad session/with/slash"));
        assert!(state.listener_ready("session-1"));
    }

    #[test]
    fn duplicate_target_is_delivered_once() {
        let state = NotificationActivationState::default();
        state.put(activation("a1", "task-1"));
        state.put(activation("a2", "task-1"));
        assert!(state.listener_ready("s1"));
        assert_eq!(
            state
                .take_for_listener("s1", |_| Ok("task".to_owned()), |_| {})
                .expect("first")
                .activation_id,
            "a1"
        );
        assert!(state.acknowledge("s1", "a1", "opened"));
        assert!(
            state
                .take_for_listener("s1", |_| Ok("task".to_owned()), |_| {})
                .is_none(),
            "completed target must be deduplicated"
        );
        state.assert_audit();
    }

    #[test]
    fn invalid_activation_is_rejected_before_valid_delivery() {
        let state = NotificationActivationState::default();
        state.put(activation("stale", "deleted-task"));
        state.put(activation("valid", "task-ok"));
        assert!(state.listener_ready("s1"));
        let mut rejected = Vec::new();
        let delivered = state
            .take_for_listener(
                "s1",
                |item| {
                    if item.target.task_id == "deleted-task" {
                        Err(RejectionCode::TaskNotFound)
                    } else {
                        Ok("live".to_owned())
                    }
                },
                |code| rejected.push(code.as_str()),
            )
            .expect("valid");
        assert_eq!(delivered.activation_id, "valid");
        assert_eq!(rejected, vec!["TASK_NOT_FOUND"]);
        state.assert_audit();
    }

    #[test]
    fn ack_is_idempotent_and_session_bound() {
        let state = NotificationActivationState::default();
        state.put(activation("a1", "task-1"));
        assert!(state.listener_ready("s1"));
        let delivered = state
            .take_for_listener("s1", |_| Ok("task".to_owned()), |_| {})
            .expect("delivery");
        assert!(!state.acknowledge("s2", &delivered.activation_id, "opened"));
        assert!(state.acknowledge("s1", &delivered.activation_id, "opened"));
        assert!(state.acknowledge("s1", &delivered.activation_id, "opened"));
        assert!(!state.acknowledge("s1", "unknown", "opened"));
        assert!(!state.acknowledge("s1", &delivered.activation_id, "bogus"));
        state.assert_audit();
    }

    #[test]
    fn unknown_ack_outcome_fails_closed_without_consuming_the_in_flight_slot() {
        let state = NotificationActivationState::default();
        assert!(state.listener_ready("s1"));
        state.put(activation("a", "task-a"));
        let delivered = state
            .take_for_listener("s1", |_| Ok("live".to_owned()), |_| {})
            .expect("delivery");
        assert_eq!(delivered.activation_id, "a");

        for outcome in ["garbage", "", "OPENED", "opened ", "Opened", "ack"] {
            assert!(
                !state.acknowledge("s1", "a", outcome),
                "unknown outcome {outcome:?} must fail closed"
            );
            // Returning false is not enough: the in-flight slot must still be
            // held, so the same activation can still be acknowledged for real.
            assert!(
                state
                    .take_for_listener("s1", |_| Ok("live".to_owned()), |_| {})
                    .is_none(),
                "in-flight slot consumed by {outcome:?}"
            );
            assert!(
                state.take_rejection().is_none(),
                "a rejected ACK must not fabricate rejection evidence for the click"
            );
            state.assert_audit();
        }

        // The activation is still live in the in-flight slot and terminates only
        // on an accepted outcome.
        assert!(state.acknowledge("s1", "a", "opened"));
        assert!(
            !state.acknowledge("s1", "a", "garbage"),
            "an unknown outcome must fail closed even for an already acked id"
        );
        state.assert_audit();
    }

    #[test]
    fn pre_listener_rejection_is_queued_without_activation() {
        let state = NotificationActivationState::default();
        state.put_rejection(RejectedActivation::from_code(RejectionCode::TaskNotFound));
        assert!(state.take().is_none());
        assert_eq!(
            state.take_rejection().expect("pre-listener rejection").code,
            "TASK_NOT_FOUND"
        );
    }

    #[test]
    fn activation_json_contract_is_stable() {
        let mut activation = Activation::new(
            "a1".to_owned(),
            NotificationTargetV1::new("default", "task-1").expect("target"),
            "任务标题".to_owned(),
        );
        activation.meta = ActivationMeta::admitted_at(Instant::now());
        let value = serde_json::to_value(&activation).expect("serialize");
        let object = value.as_object().expect("activation object");
        let mut keys: Vec<&str> = object.keys().map(String::as_str).collect();
        keys.sort_unstable();
        assert_eq!(keys, vec!["activationId", "target", "taskTitle"]);
        assert_eq!(
            serde_json::to_string(&activation).expect("serialize"),
            r#"{"activationId":"a1","target":{"accountId":"default","taskId":"task-1","sourceVersion":1},"taskTitle":"任务标题"}"#
        );
    }

    #[test]
    fn requeued_activation_expiry_does_not_spend_a_later_activations_retry() {
        let state = NotificationActivationState::default();
        state.put(activation("a", "task-a"));
        assert!(state.listener_ready("s1"));
        assert_eq!(deliver(&state, "s1"), Some("a".to_owned()));
        assert!(state.listener_ready("s2"));
        assert_eq!(deliver(&state, "s2"), Some("a".to_owned()));
        // The second reload of the same unacknowledged activation spends its one
        // allowed requeue and terminates it with evidence.
        assert!(state.listener_ready("s3"));
        assert_eq!(deliver(&state, "s3"), None);
        assert_eq!(
            state.take_rejection().expect("activation a expired").code,
            "ACTIVATION_EXPIRED"
        );
        assert!(
            state.take_rejection().is_none(),
            "only one activation has ended so far"
        );
        state.assert_audit();

        // A different activation owns its own retry budget: the expiry of a must
        // not spend b's first requeue.
        state.put(activation("b", "task-b"));
        assert_eq!(deliver(&state, "s3"), Some("b".to_owned()));
        assert!(state.listener_ready("s4"));
        assert_eq!(
            deliver(&state, "s4"),
            Some("b".to_owned()),
            "B must get its own first requeue after another activation expired"
        );
        assert!(state.acknowledge("s4", "b", "opened"));
        state.assert_audit();
    }

    #[test]
    fn terminal_outcome_does_not_spend_a_later_activations_retry() {
        for outcome in ["opened", "rejected"] {
            let state = NotificationActivationState::default();
            assert!(state.listener_ready("s1"));
            state.put(activation("a", "task-a"));
            assert_eq!(deliver(&state, "s1"), Some("a".to_owned()));
            assert!(state.acknowledge("s1", "a", outcome));
            state.put(activation("b", "task-b"));
            assert_eq!(deliver(&state, "s1"), Some("b".to_owned()));
            assert!(state.listener_ready("s2"));
            assert_eq!(
                deliver(&state, "s2"),
                Some("b".to_owned()),
                "{outcome} must not spend B's retry budget"
            );
            assert!(state.acknowledge("s2", "b", "opened"));
            state.assert_audit();
        }

        // A ends through the time budget instead of an ACK. The base instant is
        // captured and the check instant is derived by going FORWARD, so nothing
        // here depends on how long the machine has been up.
        let state = NotificationActivationState::default();
        let base = Instant::now();
        let check = after(base, ACTIVATION_TTL + Duration::from_secs(1));
        assert!(state.listener_ready_at("s1", base));
        state.put_at(activation("a", "task-a"), base);
        assert_eq!(deliver_at(&state, "s1", check), None);
        assert_eq!(
            state.take_rejection().expect("timed out").code,
            "ACTIVATION_EXPIRED"
        );
        // B is admitted at the check instant, so B has spent zero time itself.
        state.put_at(activation("b", "task-b"), check);
        assert_eq!(deliver_at(&state, "s1", check), Some("b".to_owned()));
        assert!(state.listener_ready_at("s2", check));
        assert_eq!(
            deliver_at(&state, "s2", check),
            Some("b".to_owned()),
            "a timed-out activation must not spend B's retry budget"
        );
        assert!(state.acknowledge("s2", "b", "opened"));
        state.assert_audit();
    }

    #[test]
    fn ten_activations_delivered_in_click_order_reach_terminal_state() {
        let state = NotificationActivationState::default();
        assert!(state.listener_ready("s1"));
        let mut delivered = Vec::new();
        for index in 0..10 {
            let id = format!("a{index}");
            state.put(activation(&id, &format!("task-{index}")));
            let item = state
                .take_for_listener("s1", |_| Ok("live".to_owned()), |_| {})
                .expect("click must be delivered");
            assert_eq!(item.activation_id, id, "click order must be preserved");
            assert!(state.acknowledge("s1", &item.activation_id, "opened"));
            delivered.push(item.activation_id);
            state.assert_audit();
        }
        assert_eq!(delivered.len(), 10);
        assert!(
            state
                .take_for_listener("s1", |_| Ok("live".to_owned()), |_| {})
                .is_none()
        );
        assert!(
            state.take_rejection().is_none(),
            "no click may be lost or overflowed"
        );
        state.assert_audit();
    }

    #[test]
    fn old_session_ack_is_rejected_duplicate_ack_is_idempotent_and_instances_are_distinct() {
        let state = NotificationActivationState::default();
        assert!(state.listener_ready("s1"));
        state.put(activation_with_notification("a", "task-1", "instance-1"));
        assert_eq!(deliver(&state, "s1"), Some("a".to_owned()));
        assert!(
            !state.acknowledge("stale-session", "a", "opened"),
            "an ACK is bound to the session that received the activation"
        );
        assert!(
            state.acknowledge("s1", "a", "opened"),
            "the failed old-session ACK must not consume the in-flight slot"
        );
        assert!(
            state.acknowledge("s1", "a", "opened"),
            "duplicate ACK is idempotent"
        );
        assert!(!state.acknowledge("s1", "a", "bogus"));
        state.assert_audit();

        // Same target and same notification instance: delivered once.
        state.put(activation_with_notification("dup", "task-2", "instance-1"));
        assert_eq!(deliver(&state, "s1"), Some("dup".to_owned()));
        assert!(state.acknowledge("s1", "dup", "opened"));
        state.put(activation_with_notification(
            "dup-again",
            "task-2",
            "instance-1",
        ));
        assert_eq!(
            deliver(&state, "s1"),
            None,
            "a duplicate instance of an opened target is suppressed"
        );
        state.assert_audit();

        // Same task with distinct notification instances: two deliveries.
        state.put(activation_with_notification("i1", "task-3", "instance-1"));
        state.put(activation_with_notification("i2", "task-3", "instance-2"));
        assert_eq!(deliver(&state, "s1"), Some("i1".to_owned()));
        assert!(state.acknowledge("s1", "i1", "rejected"));
        assert_eq!(deliver(&state, "s1"), Some("i2".to_owned()));
        assert!(state.acknowledge("s1", "i2", "opened"));
        state.assert_audit();
    }

    #[test]
    fn queue_overflow_rejects_with_evidence_and_never_displaces_a_held_slot() {
        let state = NotificationActivationState::default();
        assert!(state.listener_ready("s1"));
        state.put(activation("held", "task-held"));
        let mut flooded = false;
        let held = state
            .take_for_listener(
                "s1",
                |_| {
                    if !flooded {
                        flooded = true;
                        // A burst arrives while "held" is reserved: capacity may
                        // only displace pending activations, and only with
                        // observable evidence.
                        for index in 0..8 {
                            state.put(activation(
                                &format!("burst{index}"),
                                &format!("burst-{index}"),
                            ));
                            state.assert_audit();
                        }
                    }
                    Ok("live".to_owned())
                },
                |_| {},
            )
            .expect("the reserved activation must still commit");
        assert_eq!(held.activation_id, "held");
        assert!(state.acknowledge("s1", "held", "opened"));

        let mut delivered = Vec::new();
        while let Some(item) = state.take_for_listener("s1", |_| Ok("live".to_owned()), |_| {}) {
            assert!(state.acknowledge("s1", &item.activation_id, "opened"));
            delivered.push(item.activation_id);
            state.assert_audit();
        }
        assert_eq!(
            delivered.len(),
            7,
            "seven of eight burst activations fit under the cap"
        );
        assert_eq!(
            delivered.first().map(String::as_str),
            Some("burst1"),
            "the oldest pending activation was displaced"
        );

        let overflow = state.take_rejection().expect("overflow evidence");
        assert_eq!(overflow.code, "ACTIVATION_QUEUE_OVERFLOW");
        assert_eq!(overflow.message, "提醒打开过于频繁，请稍后重新打开任务");
        assert!(state.take_rejection().is_none());
        state.assert_audit();
    }

    #[test]
    fn activation_ttl_expires_with_evidence() {
        let state = NotificationActivationState::default();
        let base = Instant::now();
        let check = after(base, ACTIVATION_TTL + Duration::from_secs(1));
        assert!(state.listener_ready_at("s1", base));
        // "stale" is admitted at the base instant while "fresh" is admitted at the
        // later check instant, so stale is past its TTL and fresh has spent zero
        // time. The check instant is reached by adding, never by subtracting.
        state.put_at(activation("stale", "task-stale"), base);
        state.put_at(activation("fresh", "task-fresh"), check);
        assert_eq!(
            state
                .take_for_listener_at("s1", check, |_| Ok("live".to_owned()), |_| {})
                .expect("fresh activation")
                .activation_id,
            "fresh"
        );
        assert_eq!(
            state.take_rejection().expect("ttl expiry").code,
            "ACTIVATION_EXPIRED"
        );
        assert!(state.take_rejection().is_none());
        state.assert_audit();

        // "fresh" is acknowledged, so the in-flight slot is free again.
        assert!(state.acknowledge("s1", "fresh", "opened"));
        state.assert_audit();

        // The clock is injectable: an activation that was fresh when it was
        // delivered and then crosses the TTL across a listener reload expires
        // instead of being requeued.
        state.put_at(activation("aging", "task-aging"), check);
        assert_eq!(
            state
                .take_for_listener_at("s1", check, |_| Ok("live".to_owned()), |_| {})
                .expect("fresh at reservation time")
                .activation_id,
            "aging"
        );
        let later = after(check, ACTIVATION_TTL + Duration::from_secs(1));
        assert!(state.listener_ready_at("s2", later));
        assert!(
            state
                .take_for_listener_at("s2", later, |_| Ok("live".to_owned()), |_| {})
                .is_none(),
            "an expired activation must never be delivered"
        );
        assert_eq!(
            state.take_rejection().expect("reload expiry").code,
            "ACTIVATION_EXPIRED"
        );
        assert!(state.take_rejection().is_none());
        state.assert_audit();
    }

    #[test]
    fn five_chained_listener_reloads_keep_the_accounting_invariant() {
        let state = NotificationActivationState::default();
        state.put(activation("a", "task-a"));
        state.put(activation("b", "task-b"));
        assert!(state.listener_ready("s1"));
        assert_eq!(deliver(&state, "s1"), Some("a".to_owned()));
        state.assert_audit();

        let expected = [Some("a"), Some("b"), Some("b"), None];
        for (session, expected) in ["s2", "s3", "s4", "s5"].into_iter().zip(expected) {
            assert!(state.listener_ready(session));
            state.assert_audit();
            assert_eq!(
                deliver(&state, session),
                expected.map(str::to_owned),
                "{session}"
            );
            state.assert_audit();
        }
        // Each activation spent exactly its own single requeue.
        assert_eq!(
            state.take_rejection().expect("a expired").code,
            "ACTIVATION_EXPIRED"
        );
        assert_eq!(
            state.take_rejection().expect("b expired").code,
            "ACTIVATION_EXPIRED"
        );
        assert!(state.take_rejection().is_none());
        state.assert_audit();
    }

    #[test]
    fn session_change_during_validation_restores_the_activation_instead_of_dropping_it() {
        let state = NotificationActivationState::default();
        assert!(state.listener_ready("s1"));
        for index in 0..8 {
            state.put(activation(&format!("q{index}"), &format!("task-{index}")));
        }
        let mut swapped = false;
        let delivered = state.take_for_listener(
            "s1",
            |_| {
                if !swapped {
                    swapped = true;
                    assert!(state.listener_ready("s2"));
                    // The queue is at capacity while the reservation is held.
                    state.put(activation("late", "task-late"));
                }
                Ok("live".to_owned())
            },
            |_| {},
        );
        assert!(
            delivered.is_none(),
            "the replaced session must not receive the old session's activation"
        );
        assert_eq!(
            deliver(&state, "s2"),
            Some("q0".to_owned()),
            "the reserved activation is restored, not dropped"
        );
        state.assert_audit();
    }

    #[test]
    fn panicking_validation_restores_the_reserved_activation() {
        let state = NotificationActivationState::default();
        assert!(state.listener_ready("s1"));
        state.put(activation("a", "task-a"));
        let panicked = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            state.take_for_listener("s1", |_| panic!("validation exploded"), |_| {})
        }));
        assert!(panicked.is_err(), "validation must unwind");
        state.assert_audit();
        assert_eq!(
            deliver(&state, "s1"),
            Some("a".to_owned()),
            "the drop guard must restore the reservation instead of leaking the slot"
        );
        assert!(state.acknowledge("s1", "a", "opened"));
        state.assert_audit();
    }

    #[test]
    fn accounting_invariant_survives_every_transition() {
        let state = NotificationActivationState::default();
        let now = Instant::now();
        assert!(state.listener_ready_at("s1", now));
        state.assert_audit();

        state.put_at(activation("a", "task-a"), now);
        state.put_at(activation("b", "task-b"), now);
        state.assert_audit();

        let first = state
            .take_for_listener_at("s1", now, |_| Ok("live".to_owned()), |_| {})
            .expect("committed delivery");
        assert_eq!(first.activation_id, "a");
        state.assert_audit();

        assert!(state.listener_ready_at("s2", now));
        state.assert_audit();
        let requeued = state
            .take_for_listener_at("s2", now, |_| Ok("live".to_owned()), |_| {})
            .expect("requeued delivery");
        assert_eq!(requeued.activation_id, "a");
        state.assert_audit();

        assert!(state.listener_ready_at("s3", now));
        state.assert_audit();
        assert_eq!(
            state.take_rejection().expect("expired").code,
            "ACTIVATION_EXPIRED"
        );
        assert!(
            !state.acknowledge("s3", "a", "opened"),
            "an expired activation is not an accepted ACK"
        );
        state.assert_audit();

        let second = state
            .take_for_listener_at("s3", now, |_| Ok("live".to_owned()), |_| {})
            .expect("second delivery");
        assert_eq!(second.activation_id, "b");
        state.assert_audit();
        assert!(state.acknowledge("s3", "b", "opened"));
        state.assert_audit();
        assert!(
            state.acknowledge("s3", "b", "opened"),
            "duplicate ACK is idempotent"
        );
        state.assert_audit();
        assert!(
            state
                .take_for_listener_at("s3", now, |_| Ok("live".to_owned()), |_| {})
                .is_none()
        );
        state.assert_audit();
    }

    #[test]
    fn audit_helper_detects_an_unaccounted_activation() {
        let state = NotificationActivationState::default();
        state.put(activation("lost", "task-lost"));
        let popped = state.take().expect("test-only raw pop");
        assert_eq!(popped.activation_id, "lost");
        assert!(
            state.audit().is_err(),
            "the accounting audit must not be vacuous"
        );
    }

    #[test]
    fn concurrent_reload_and_enqueue_never_loses_or_duplicates_an_activation() {
        let state = Arc::new(NotificationActivationState::default());
        assert!(state.listener_ready("s1"));
        state.put(activation("a0", "task-a0"));

        let at_validation = Arc::new(Barrier::new(3));
        let after_interference = Arc::new(Barrier::new(3));

        let (reserved_delivery, reload_ok) = std::thread::scope(|scope| {
            let thread_state = Arc::clone(&state);
            let at = Arc::clone(&at_validation);
            let after = Arc::clone(&after_interference);
            let worker_a = scope.spawn(move || {
                thread_state.take_for_listener(
                    "s1",
                    |_| {
                        // Validation runs outside the state lock: this is exactly
                        // the window in which the listener session may be replaced
                        // and a burst of activations may arrive.
                        at.wait();
                        after.wait();
                        Ok("validated".to_owned())
                    },
                    |_| {},
                )
            });

            let thread_state = Arc::clone(&state);
            let at = Arc::clone(&at_validation);
            let after = Arc::clone(&after_interference);
            let worker_b = scope.spawn(move || {
                at.wait();
                let ready = thread_state.listener_ready("s2");
                after.wait();
                ready
            });

            let thread_state = Arc::clone(&state);
            let at = Arc::clone(&at_validation);
            let after = Arc::clone(&after_interference);
            let worker_c = scope.spawn(move || {
                at.wait();
                for index in 0..8 {
                    let account = if index % 2 == 0 { "default" } else { "other" };
                    thread_state.put(activation_for(
                        account,
                        &format!("c{index}"),
                        &format!("task-c{index}"),
                    ));
                    thread_state.assert_audit();
                }
                after.wait();
            });

            let reload_ok = worker_b.join().expect("thread B");
            worker_c.join().expect("thread C");
            let reserved_delivery = worker_a.join().expect("thread A");
            (reserved_delivery, reload_ok)
        });

        assert!(reload_ok, "the reload must register the new session");
        assert!(
            reserved_delivery.is_none(),
            "a reservation taken for the replaced session must not be delivered to it"
        );

        let mut delivered = Vec::new();
        while let Some(item) = state.take_for_listener(
            "s2",
            |activation| {
                if activation.target.account_id == "default" {
                    Ok("validated".to_owned())
                } else {
                    Err(RejectionCode::AccountSwitchRequired)
                }
            },
            |_| {},
        ) {
            assert_eq!(
                item.target.account_id, "default",
                "no cross-account delivery"
            );
            assert!(
                !delivered.contains(&item.activation_id),
                "activation {} was delivered twice",
                item.activation_id
            );
            assert!(state.acknowledge("s2", &item.activation_id, "opened"));
            delivered.push(item.activation_id);
            state.assert_audit();
        }
        let mut rejected = Vec::new();
        while let Some(rejection) = state.take_rejection() {
            rejected.push(rejection.code);
        }

        assert_eq!(
            delivered.iter().map(String::as_str).collect::<Vec<_>>(),
            vec!["a0", "c2", "c4", "c6"],
            "the reserved activation is restored ahead of the burst and nothing is lost"
        );
        assert_eq!(
            rejected
                .iter()
                .filter(|code| **code == "ACTIVATION_QUEUE_OVERFLOW")
                .count(),
            1,
            "the capacity overflow must be observable"
        );
        assert_eq!(
            rejected
                .iter()
                .filter(|code| **code == "ACCOUNT_SWITCH_REQUIRED")
                .count(),
            4,
            "every other-account activation must be rejected, never delivered"
        );
        state.assert_audit();
    }

    /// Deterministic linear congruential generator: the randomized state machine
    /// must reproduce exactly, so no external rand dependency is used.
    struct Lcg(u64);

    impl Lcg {
        fn next(&mut self) -> u64 {
            self.0 = self
                .0
                .wrapping_mul(6_364_136_223_846_793_005)
                .wrapping_add(1_442_695_040_888_963_407);
            self.0 >> 33
        }

        fn below(&mut self, bound: u64) -> u64 {
            self.next() % bound
        }
    }

    #[test]
    fn randomized_state_machine_keeps_accounting_consistent() {
        let sessions = ["s1", "s2", "s3"];
        let mut random = Lcg(0x5eed_1a2b_3c4d_5e6f);
        let mut clock = Instant::now();
        let state = NotificationActivationState::default();
        let mut admitted: u64 = 0;
        let mut delivered: Vec<String> = Vec::new();
        assert!(state.listener_ready_at(sessions[0], clock));

        for step in 0..400 {
            clock += Duration::from_millis(random.below(20_000));
            match random.below(6) {
                0 | 1 => {
                    let id = format!("a{admitted}");
                    state.put_at(activation(&id, &format!("task-{}", admitted % 7)), clock);
                    admitted += 1;
                }
                2 => {
                    let session = sessions[random.below(3) as usize];
                    assert!(state.listener_ready_at(session, clock));
                }
                3 | 4 => {
                    let session = sessions[random.below(3) as usize];
                    let outcomes = ["opened", "rejected", "expired", "duplicate"];
                    let outcome = outcomes[random.below(4) as usize];
                    let taken = state.take_for_listener_at(
                        session,
                        clock,
                        |_| Ok("live".to_owned()),
                        |_| {},
                    );
                    if let Some(item) = taken {
                        assert!(
                            !delivered.contains(&item.activation_id),
                            "activation {} was delivered twice (step {step})",
                            item.activation_id
                        );
                        assert!(
                            state.acknowledge(session, &item.activation_id, outcome),
                            "the in-flight ACK must succeed (step {step})"
                        );
                        delivered.push(item.activation_id);
                    }
                }
                _ => {
                    let _ = state.take_rejection();
                }
            }
            state.assert_audit();
        }
        assert!(admitted > 0 && !delivered.is_empty());
    }

    // -- clock boundary: TTL is decided at the boundary that observes it ------

    /// Admit at T0, reserve at T0+290s, let validation finish `validation_took`
    /// later, and report (delivered, rejection code). Moving the injected clock
    /// inside `validate` is how a test simulates a slow account/SQLite read
    /// without sleeping.
    fn deliver_after_slow_validation(validation_took: Duration) -> (bool, Option<String>) {
        let state = NotificationActivationState::default();
        let t0 = Instant::now();
        state.put_at(activation("slow", "task-slow"), t0);
        let reserved_at = after(t0, Duration::from_secs(290));
        assert!(state.listener_ready_at("s1", reserved_at));
        let delivered = state.take_for_listener(
            "s1",
            |_| {
                state.clock.pin(reserved_at + validation_took);
                Ok("live".to_owned())
            },
            |_| {},
        );
        let code = state
            .take_rejection()
            .map(|rejection| rejection.code.to_owned());
        state.assert_audit();
        (delivered.is_some(), code)
    }

    #[test]
    fn ttl_boundary_just_inside_the_budget_is_delivered() {
        let (delivered, code) = deliver_after_slow_validation(Duration::from_micros(9_999_000));
        assert!(delivered, "an age of 299.999s is still inside the TTL");
        assert_eq!(code, None);
    }

    #[test]
    fn ttl_boundary_exactly_at_the_budget_is_expired() {
        // Boundary definition: the TTL is exclusive. An age of exactly 300s is
        // already expired, which is the same `>=` rule `ActivationMeta` uses.
        let (delivered, code) = deliver_after_slow_validation(Duration::from_secs(10));
        assert!(!delivered, "an age of exactly 300s is expired");
        assert_eq!(
            code.as_deref(),
            Some("ACTIVATION_EXPIRED_DURING_VALIDATION")
        );
    }

    #[test]
    fn ttl_boundary_just_past_the_budget_is_expired() {
        let (delivered, code) = deliver_after_slow_validation(Duration::from_micros(10_001_000));
        assert!(!delivered);
        assert_eq!(
            code.as_deref(),
            Some("ACTIVATION_EXPIRED_DURING_VALIDATION")
        );
    }

    #[test]
    fn slow_validation_across_the_ttl_boundary_is_rejected_at_commit() {
        let state = NotificationActivationState::default();
        let t0 = Instant::now();
        state.put_at(activation("slow", "task-slow"), t0);
        // Reserve succeeds with 10s of TTL still left.
        assert!(state.listener_ready_at("s1", after(t0, Duration::from_secs(290))));
        let delivered = state.take_for_listener(
            "s1",
            |_| {
                // Validation finishes 11s later: the commit boundary must judge
                // expiry by its own reading, not by the reserve reading.
                state.clock.pin(after(t0, Duration::from_secs(301)));
                Ok("live".to_owned())
            },
            |_| {},
        );
        assert!(
            delivered.is_none(),
            "an activation that expired during validation must never be delivered"
        );
        assert_eq!(
            state.take_rejection().expect("commit-time expiry").code,
            "ACTIVATION_EXPIRED_DURING_VALIDATION"
        );
        assert!(state.take_rejection().is_none());
        state.assert_audit();

        let diagnostics = state.activation_diagnostics();
        assert_eq!(
            diagnostics.len(),
            1,
            "no delivery record for a rejected commit"
        );
        assert_eq!(diagnostics[0].activation_id, "slow");
        assert_eq!(diagnostics[0].event_type, "rejected");
        assert_eq!(diagnostics[0].terminal_outcome, Some("rejected"));
        assert_eq!(
            diagnostics[0].rejection_code,
            Some("ACTIVATION_EXPIRED_DURING_VALIDATION")
        );
        assert_eq!(
            diagnostics[0].session_correlation,
            session_correlation("s1")
        );
        assert_eq!(diagnostics[0].delivery_attempt, 0);
    }

    #[test]
    fn delayed_validation_inside_the_ttl_is_delivered() {
        let state = NotificationActivationState::default();
        let t0 = Instant::now();
        state.put_at(activation("slow-ok", "task-ok"), t0);
        assert!(state.listener_ready_at("s1", t0));
        let delivered = state.take_for_listener(
            "s1",
            |_| {
                // 299s of validation, still inside the TTL.
                state.clock.pin(after(t0, Duration::from_secs(299)));
                Ok("live".to_owned())
            },
            |_| {},
        );
        assert_eq!(
            delivered.map(|activation| activation.activation_id),
            Some("slow-ok".to_owned())
        );
        let diagnostics = state.activation_diagnostics();
        let record = diagnostics.last().expect("delivery record");
        assert_eq!(record.event_type, "delivered");
        assert_eq!(record.delivery_attempt, 1);
        assert_eq!(record.terminal_outcome, None);
        state.assert_audit();
    }

    #[test]
    fn reload_after_expiry_rejects_the_in_flight_activation() {
        let state = NotificationActivationState::default();
        let t0 = Instant::now();
        state.put_at(
            activation_with_notification("stale", "task-1", "notif-1"),
            t0,
        );
        assert!(state.listener_ready_at("s1", t0));
        assert_eq!(deliver_at(&state, "s1", t0), Some("stale".to_owned()));
        // The reload arrives past the TTL: the requeue boundary expires it.
        assert!(
            state.listener_ready_at("s2", after(t0, ACTIVATION_TTL + Duration::from_millis(1)))
        );
        assert_eq!(
            state.take_rejection().expect("reload expiry").code,
            "ACTIVATION_EXPIRED"
        );
        let diagnostics = state.activation_diagnostics();
        let rejected = diagnostics
            .iter()
            .find(|diagnostic| diagnostic.event_type == "rejected")
            .expect("rejection record");
        assert_eq!(rejected.activation_id, "stale");
        assert_eq!(
            rejected.notification_instance_id.as_deref(),
            Some("notif-1")
        );
        assert_eq!(rejected.rejection_code, Some("ACTIVATION_EXPIRED"));
        // The delivering session is the one that was holding it in flight.
        assert_eq!(rejected.session_correlation, session_correlation("s1"));
        assert_eq!(rejected.delivery_attempt, 1);
        state.assert_audit();
    }

    #[test]
    fn session_change_during_a_slow_validation_restores_instead_of_dropping() {
        let state = NotificationActivationState::default();
        let t0 = Instant::now();
        state.put_at(activation("restored", "task-r"), t0);
        assert!(state.listener_ready_at("s1", t0));
        let delivered = state.take_for_listener(
            "s1",
            |_| {
                // A slow validation that stays inside the TTL, during which the
                // listener reloads and registers a different session.
                state.clock.pin(after(t0, Duration::from_secs(5)));
                assert!(state.listener_ready("s2"));
                Ok("live".to_owned())
            },
            |_| {},
        );
        assert!(
            delivered.is_none(),
            "the replaced session must not receive the old session's activation"
        );
        assert!(
            state.take_rejection().is_none(),
            "a restore is not a rejection"
        );
        assert_eq!(
            deliver_at(&state, "s2", after(t0, Duration::from_secs(6))),
            Some("restored".to_owned()),
            "the reserved activation is restored, not dropped"
        );
        state.assert_audit();
    }

    #[test]
    fn stale_ack_is_refused_after_a_reload_expiry() {
        let state = NotificationActivationState::default();
        let t0 = Instant::now();
        state.put_at(activation("stale", "task-s"), t0);
        assert!(state.listener_ready_at("s1", t0));
        assert_eq!(deliver_at(&state, "s1", t0), Some("stale".to_owned()));
        assert!(state.listener_ready_at("s2", after(t0, ACTIVATION_TTL + Duration::from_secs(1))));
        assert_eq!(
            state.take_rejection().expect("expiry").code,
            "ACTIVATION_EXPIRED"
        );
        assert!(
            !state.acknowledge("s1", "stale", "opened"),
            "an ACK for an activation that already ended must fail closed"
        );
        let terminals = state
            .activation_diagnostics()
            .into_iter()
            .filter(|diagnostic| {
                diagnostic.activation_id == "stale" && diagnostic.terminal_outcome.is_some()
            })
            .count();
        assert_eq!(terminals, 1, "a refused ACK must not add a terminal record");
        state.assert_audit();
    }

    #[test]
    fn a_new_activation_after_a_commit_time_expiry_is_delivered() {
        let state = NotificationActivationState::default();
        let t0 = Instant::now();
        state.put_at(activation("crossed", "task-crossed"), t0);
        assert!(state.listener_ready_at("s1", after(t0, Duration::from_secs(290))));
        let mut advanced = false;
        let first = state.take_for_listener(
            "s1",
            |_| {
                if !advanced {
                    advanced = true;
                    state.clock.pin(after(t0, Duration::from_secs(301)));
                }
                Ok("live".to_owned())
            },
            |_| {},
        );
        assert!(first.is_none());
        assert_eq!(
            state.take_rejection().expect("crossed").code,
            "ACTIVATION_EXPIRED_DURING_VALIDATION"
        );
        // The terminal failure must not poison the session or the queue.
        state.put(activation("fresh", "task-fresh"));
        assert_eq!(
            state
                .take_for_listener("s1", |_| Ok("live".to_owned()), |_| {})
                .map(|activation| activation.activation_id),
            Some("fresh".to_owned())
        );
        state.assert_audit();
    }

    // -- activation diagnostics ----------------------------------------------

    /// One rejected activation, which produces exactly one diagnostic record.
    fn reject_activation(state: &NotificationActivationState, id: &str) {
        state.put(activation(id, &format!("task-{id}")));
        let taken = state.take_for_listener("s1", |_| Err(RejectionCode::TaskNotFound), |_| {});
        assert!(taken.is_none(), "{id} must not be delivered");
    }

    fn event_types(diagnostics: &[ActivationDiagnostic]) -> Vec<&'static str> {
        diagnostics
            .iter()
            .map(|diagnostic| diagnostic.event_type)
            .collect()
    }

    #[test]
    fn activation_diagnostics_keep_fifo_order() {
        let state = NotificationActivationState::default();
        assert!(state.listener_ready("s1"));
        for index in 1..=5 {
            reject_activation(&state, &format!("d{index}"));
        }
        let diagnostics = state.activation_diagnostics();
        let ids: Vec<&str> = diagnostics
            .iter()
            .map(|diagnostic| diagnostic.activation_id.as_str())
            .collect();
        assert_eq!(ids, vec!["d1", "d2", "d3", "d4", "d5"]);
        assert!(
            event_types(&diagnostics)
                .iter()
                .all(|event| *event == "rejected")
        );
        assert!(
            diagnostics
                .iter()
                .all(|diagnostic| diagnostic.rejection_code == Some("TASK_NOT_FOUND"))
        );
        assert!(
            diagnostics
                .windows(2)
                .all(|pair| pair[0].timestamp_millis <= pair[1].timestamp_millis),
            "timestamps are monotonic within one producer"
        );
        state.assert_audit();
    }

    #[test]
    fn activation_diagnostics_evict_the_oldest_at_capacity() {
        let state = NotificationActivationState::default();
        assert!(state.listener_ready("s1"));
        for index in 0..ACTIVATION_DIAGNOSTIC_CAPACITY + 1 {
            reject_activation(&state, &format!("d{index}"));
        }
        let diagnostics = state.activation_diagnostics();
        assert_eq!(diagnostics.len(), ACTIVATION_DIAGNOSTIC_CAPACITY);
        assert_eq!(
            diagnostics[0].activation_id, "d1",
            "the 65th record evicts the oldest one"
        );
        assert_eq!(
            diagnostics[ACTIVATION_DIAGNOSTIC_CAPACITY - 1].activation_id,
            "d64"
        );
        state.assert_audit();
    }

    #[test]
    fn activation_diagnostics_prune_expired_evidence() {
        let state = NotificationActivationState::default();
        let t0 = Instant::now();
        assert!(state.listener_ready_at("s1", t0));
        state.put_at(activation("old", "task-old"), t0);
        let _ = state.take_for_listener_at("s1", t0, |_| Err(RejectionCode::TaskNotFound), |_| {});
        assert_eq!(state.activation_diagnostics().len(), 1);

        state.clock.pin(after(
            t0,
            ACTIVATION_DIAGNOSTIC_TTL - Duration::from_millis(1),
        ));
        assert_eq!(
            state.activation_diagnostics().len(),
            1,
            "evidence just inside the window is still readable"
        );
        // Same exclusive rule as the activation TTL: an age of exactly 300s is
        // already out of the window.
        state.clock.pin(after(t0, ACTIVATION_DIAGNOSTIC_TTL));
        assert!(
            state.activation_diagnostics().is_empty(),
            "expired evidence is pruned on read"
        );
    }

    #[test]
    fn activation_diagnostics_are_redacted() {
        let state = NotificationActivationState::default();
        let account = "secretaccount0042";
        let task = "secrettask0042";
        let title = "SECRET-TITLE-0042";
        let session = "secretsession0042";
        let other_session = "session0044";
        let target =
            NotificationTargetV1::new_with_notification(account, task, "notif-1").expect("target");
        state.put(Activation::new(
            "act-1".to_owned(),
            target,
            title.to_owned(),
        ));
        assert!(state.listener_ready(session));
        let refused = state.take_for_listener(
            session,
            |_| Err(RejectionCode::AccountSwitchRequired),
            |_| {},
        );
        assert!(refused.is_none());

        let target =
            NotificationTargetV1::new_with_notification(account, "secrettask0043", "notif-2")
                .expect("target");
        state.put(Activation::new(
            "act-2".to_owned(),
            target,
            title.to_owned(),
        ));
        let delivered = state.take_for_listener(
            session,
            |activation| Ok(activation.task_title.clone()),
            |_| {},
        );
        assert!(delivered.is_some());
        // A reload requeues it, the redelivery is acknowledged, and the repeated
        // ACK must correlate without adding a second terminal.
        assert!(state.listener_ready(other_session));
        let redelivered = state.take_for_listener(
            other_session,
            |activation| Ok(activation.task_title.clone()),
            |_| {},
        );
        assert!(redelivered.is_some());
        assert!(state.acknowledge(other_session, "act-2", "opened"));
        assert!(state.acknowledge(other_session, "act-2", "opened"));

        let diagnostics = state.activation_diagnostics();
        let json = serde_json::to_string(&diagnostics).expect("serialize");
        for forbidden in [
            account,
            task,
            title,
            session,
            other_session,
            "secret",
            "SECRET",
            "@",
            "token",
            "refresh",
            ".json",
            "\\",
            "/",
            "accountId",
            "taskId",
            "taskTitle",
        ] {
            assert!(
                !json.contains(forbidden),
                "activation diagnostics must never carry {forbidden}: {json}"
            );
        }
        for event in [
            "delivered",
            "requeued",
            "rejected",
            "acked",
            "duplicate_ack",
        ] {
            assert!(
                json.contains(event),
                "the redaction test must cover the {event} record: {json}"
            );
        }
        state.assert_audit();
    }

    #[test]
    fn duplicate_ack_correlates_to_the_same_activation() {
        let state = NotificationActivationState::default();
        let t0 = Instant::now();
        assert!(state.listener_ready_at("s1", t0));
        state.put_at(
            activation_with_notification("dup", "task-dup", "notif-dup"),
            t0,
        );
        assert_eq!(deliver_at(&state, "s1", t0), Some("dup".to_owned()));
        assert!(state.acknowledge("s1", "dup", "opened"));
        assert!(
            state.acknowledge("s1", "dup", "opened"),
            "a duplicate ACK stays idempotent"
        );
        let diagnostics = state.activation_diagnostics();
        let acked: Vec<&ActivationDiagnostic> = diagnostics
            .iter()
            .filter(|diagnostic| diagnostic.event_type == "acked")
            .collect();
        let duplicates: Vec<&ActivationDiagnostic> = diagnostics
            .iter()
            .filter(|diagnostic| diagnostic.event_type == "duplicate_ack")
            .collect();
        assert_eq!(acked.len(), 1);
        assert_eq!(duplicates.len(), 1);
        assert_eq!(duplicates[0].activation_id, "dup");
        assert_eq!(
            duplicates[0].notification_instance_id.as_deref(),
            Some("notif-dup")
        );
        assert_eq!(duplicates[0].session_correlation, session_correlation("s1"));
        assert_eq!(duplicates[0].delivery_attempt, 1);
        assert_eq!(
            duplicates[0].terminal_outcome, None,
            "a duplicate ACK is not a second terminal"
        );
        state.assert_audit();
    }

    #[test]
    fn cross_account_rejection_correlates_to_the_activation() {
        let state = NotificationActivationState::default();
        let t0 = Instant::now();
        assert!(state.listener_ready_at("s1", t0));
        state.put_at(activation_for("other-account", "cross", "task-cross"), t0);
        let taken = state.take_for_listener_at(
            "s1",
            t0,
            |_| Err(RejectionCode::AccountSwitchRequired),
            |_| {},
        );
        assert!(taken.is_none());
        assert_eq!(
            state.take_rejection().expect("cross-account").code,
            "ACCOUNT_SWITCH_REQUIRED"
        );
        let diagnostics = state.activation_diagnostics();
        assert_eq!(diagnostics.len(), 1);
        assert_eq!(diagnostics[0].activation_id, "cross");
        assert_eq!(
            diagnostics[0].rejection_code,
            Some("ACCOUNT_SWITCH_REQUIRED")
        );
        assert_eq!(diagnostics[0].terminal_outcome, Some("rejected"));
        assert_eq!(
            diagnostics[0].session_correlation,
            session_correlation("s1")
        );
        assert_eq!(diagnostics[0].delivery_attempt, 0);
        assert!(
            !serde_json::to_string(&diagnostics)
                .expect("json")
                .contains("other-account"),
            "the account id must never reach a diagnostic"
        );
        state.assert_audit();
    }

    #[test]
    fn queue_overflow_correlates_to_the_evicted_activation() {
        let state = NotificationActivationState::default();
        let t0 = Instant::now();
        assert!(state.listener_ready_at("s1", t0));
        for index in 0..ACTIVATION_CAPACITY {
            state.put_at(
                activation(&format!("q{index}"), &format!("task-{index}")),
                t0,
            );
        }
        state.put_at(activation("q8", "task-8"), t0);
        assert_eq!(
            state.take_rejection().expect("overflow").code,
            "ACTIVATION_QUEUE_OVERFLOW"
        );
        let diagnostics = state.activation_diagnostics();
        assert_eq!(diagnostics.len(), 1);
        assert_eq!(diagnostics[0].activation_id, "q0");
        assert_eq!(
            diagnostics[0].rejection_code,
            Some("ACTIVATION_QUEUE_OVERFLOW")
        );
        assert_eq!(diagnostics[0].terminal_outcome, Some("rejected"));
        assert_eq!(
            diagnostics[0].session_correlation,
            session_correlation("s1")
        );
        state.assert_audit();
    }

    #[test]
    fn exactly_one_terminal_record_per_activation() {
        let state = NotificationActivationState::default();
        assert!(state.listener_ready("s1"));

        // delivered -> acked (twice, so a duplicate ACK exists too)
        state.put(activation("acked", "task-a"));
        assert_eq!(deliver(&state, "s1"), Some("acked".to_owned()));
        assert!(state.acknowledge("s1", "acked", "opened"));
        assert!(state.acknowledge("s1", "acked", "opened"));

        // delivered -> requeued -> delivered -> requeue budget spent
        state.put(activation("requeued", "task-q"));
        assert_eq!(deliver(&state, "s1"), Some("requeued".to_owned()));
        assert!(state.listener_ready("s2"));
        assert_eq!(deliver(&state, "s2"), Some("requeued".to_owned()));
        assert!(state.listener_ready("s3"));
        assert_eq!(
            state.take_rejection().expect("requeue budget").code,
            "ACTIVATION_EXPIRED"
        );

        // refused during validation
        state.put(activation("refused", "task-r"));
        let taken = state.take_for_listener("s3", |_| Err(RejectionCode::TaskNotFound), |_| {});
        assert!(taken.is_none());
        assert_eq!(
            state.take_rejection().expect("validation refusal").code,
            "TASK_NOT_FOUND"
        );

        // a second activation acknowledged with a business rejection outcome
        state.put(activation("second", "task-s"));
        assert_eq!(deliver(&state, "s3"), Some("second".to_owned()));
        assert!(state.acknowledge("s3", "second", "rejected"));
        state.assert_audit();

        let diagnostics = state.activation_diagnostics();
        for activation_id in ["acked", "requeued", "refused", "second"] {
            let terminals: Vec<&ActivationDiagnostic> = diagnostics
                .iter()
                .filter(|diagnostic| {
                    diagnostic.activation_id == activation_id
                        && diagnostic.terminal_outcome.is_some()
                })
                .collect();
            assert_eq!(
                terminals.len(),
                1,
                "activation {activation_id} must own exactly one terminal record: {diagnostics:?}"
            );
        }
        assert!(
            !diagnostics
                .iter()
                .any(|diagnostic| diagnostic.activation_id == "requeued"
                    && diagnostic.terminal_outcome == Some("acked")),
            "an expired activation must never also be acked"
        );
        assert_eq!(
            event_types(&diagnostics)
                .iter()
                .filter(|event| **event == "duplicate_ack")
                .count(),
            1,
            "the duplicate ACK is correlated but never terminal"
        );
    }

    #[test]
    fn concurrent_producers_keep_the_diagnostic_window_bounded() {
        let state = Arc::new(NotificationActivationState::default());
        assert!(state.listener_ready("s1"));
        std::thread::scope(|scope| {
            for worker in 0..4 {
                let state = Arc::clone(&state);
                scope.spawn(move || {
                    for index in 0..40 {
                        let id = format!("w{worker}-{index}");
                        state.put(activation(&id, &format!("task-{id}")));
                        let _ = state.take_for_listener(
                            "s1",
                            |_| Err(RejectionCode::TaskNotFound),
                            |_| {},
                        );
                    }
                });
            }
        });
        let diagnostics = state.activation_diagnostics();
        assert!(
            diagnostics.len() <= ACTIVATION_DIAGNOSTIC_CAPACITY,
            "the window stayed bounded: {}",
            diagnostics.len()
        );
        assert!(!diagnostics.is_empty());
        // Under contention a worker may reserve another worker's activation, and
        // the queue cap may displace one, so both refusal codes are legitimate -
        // anything else would mean a record that no transition produced.
        assert!(
            diagnostics
                .iter()
                .all(|diagnostic| diagnostic.event_type == "rejected"
                    && matches!(
                        diagnostic.rejection_code,
                        Some("TASK_NOT_FOUND") | Some("ACTIVATION_QUEUE_OVERFLOW")
                    )),
            "every record is one refused activation: {diagnostics:?}"
        );
        assert!(
            diagnostics
                .iter()
                .all(|diagnostic| diagnostic.session_correlation == session_correlation("s1")),
            "every record correlates to the delivering session"
        );
        state.assert_audit();
    }

    #[test]
    fn diagnostic_recording_never_changes_a_delivery_outcome() {
        let state = NotificationActivationState::default();
        assert!(state.listener_ready("s1"));
        // Fill the window to capacity: the eviction a delivery causes must not
        // perturb that delivery.
        for index in 0..ACTIVATION_DIAGNOSTIC_CAPACITY {
            reject_activation(&state, &format!("f{index}"));
        }
        assert_eq!(
            state.activation_diagnostics().len(),
            ACTIVATION_DIAGNOSTIC_CAPACITY
        );
        state.put(activation("live", "task-live"));
        assert_eq!(
            state
                .take_for_listener("s1", |_| Ok("live".to_owned()), |_| {})
                .map(|activation| activation.activation_id),
            Some("live".to_owned())
        );
        assert!(state.acknowledge("s1", "live", "opened"));
        let diagnostics = state.activation_diagnostics();
        assert_eq!(
            diagnostics.len(),
            ACTIVATION_DIAGNOSTIC_CAPACITY,
            "capacity still bounds the window"
        );
        assert_eq!(
            diagnostics.last().map(|diagnostic| diagnostic.event_type),
            Some("acked")
        );
        state.assert_audit();
    }

    #[test]
    fn activation_diagnostics_export_through_the_diagnostics_bundle() {
        let directory = tempfile::tempdir().expect("tempdir");
        let root = directory.path();
        todo_native_accounts::ensure_active_account(root).expect("fresh install");
        let state = NotificationActivationState::default();
        assert!(state.listener_ready("s1"));
        state.put(activation_with_notification(
            "exported",
            "task-exported",
            "notif-exported",
        ));
        let refused =
            state.take_for_listener("s1", |_| Err(RejectionCode::AccountSwitchRequired), |_| {});
        assert!(refused.is_none());

        let report = crate::diagnostics::collect(
            root,
            todo_native_accounts::DEFAULT_ACCOUNT_ID,
            state.activation_diagnostics(),
        )
        .expect("diagnostics bundle");
        assert_eq!(report.activation_diagnostics.len(), 1);
        assert_eq!(report.activation_diagnostics[0].activation_id, "exported");
        assert_eq!(
            report.activation_diagnostics[0]
                .notification_instance_id
                .as_deref(),
            Some("notif-exported")
        );
        let json = serde_json::to_string(&report).expect("json");
        assert!(json.contains("activationDiagnostics"));
        assert!(json.contains("ACCOUNT_SWITCH_REQUIRED"));
        assert!(
            !json.contains("task-exported"),
            "the task id must never reach the bundle"
        );
        assert!(!json.contains("token"));
        state.assert_audit();
    }
}
