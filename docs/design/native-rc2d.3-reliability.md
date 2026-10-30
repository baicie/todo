# RC2-D.3 — Native Notification Safety & Platform Reliability Design

Baseline: RC2-D.2 code `00e3dcd`, docs `0bb76b0`. Scope: sanitize rejection
messages, close queue contract gaps, expand real process-crash coverage, and
define accurate platform/manual acceptance. No merge/release.

## 1. Rejection message contract (A)

### 1.1 Internal vs user-visible

Native internal `AccountError`/`StoreError`/`Display` values may contain absolute
paths, SQL text, registry details or account identifiers. They are never copied
into a user-visible rejection result.

The notification path exposes only an allowlisted `RejectionCode`:

| Code                         | Stable user message                    |
| ---------------------------- | -------------------------------------- |
| `APP_NOT_READY`              | 应用尚未完成初始化，请稍后重试         |
| `DATA_DIR_UNAVAILABLE`       | 暂时无法读取本地账号数据               |
| `ACCOUNT_REGISTRY_MISSING`   | 本地账号状态不可用，请检查账号恢复状态 |
| `ACCOUNT_REGISTRY_INVALID`   | 本地账号状态不可用，请检查账号恢复状态 |
| `ACCOUNT_SWITCH_REQUIRED`    | 该提醒属于另一个账号，请先切换账号     |
| `ACCOUNT_SWITCH_IN_PROGRESS` | 账号切换进行中，请稍后重试             |
| `TASK_NOT_FOUND`             | 提醒对应的任务已删除或不可见           |
| `TASK_READ_FAILED`           | 暂时无法读取提醒对应的任务             |

`RejectedActivation { code, message }` is constructed only from a
`RejectionCode`; the message is a fixed `&'static str`. There is no
`format!("{error}")` on the user path.

Internal errors are represented by the original error type until the mapping
point. Diagnostics must use only the stable code (and never the raw `Display`)
in notification rejection records/log lines. If further internal diagnosis is
needed, it belongs in a separate, non-user, path-safe diagnostic channel; this
round does not add one.

### 1.2 Mapping points

- `data_dir` error → `DATA_DIR_UNAVAILABLE`.
- registry `Ok(None)` → `ACCOUNT_REGISTRY_MISSING`.
- registry `Err(_)` → `ACCOUNT_REGISTRY_INVALID`.
- registry/AppState account mismatch → `ACCOUNT_SWITCH_REQUIRED`.
- RuntimeGate denied → `ACCOUNT_SWITCH_IN_PROGRESS`.
- task `Ok(None)` → `TASK_NOT_FOUND`.
- task `Err(_)` → `TASK_READ_FAILED`.
- AppState missing → `APP_NOT_READY`.

Security checks and ordering are unchanged. The mapping must be pure and
unit-testable; a serialized `RejectedActivation` must not contain a synthetic
absolute path, `UnsafePath` text, SQL text or task title.

## 2. Activation / rejection queue contract (B)

| Step                     | Contract                                                                               |
| ------------------------ | -------------------------------------------------------------------------------------- |
| Native validates target  | fail-closed; no queueing on invalid target                                             |
| activation queued        | FIFO, capacity 8, overflow drops oldest                                                |
| rejection queued         | FIFO, capacity 8, overflow drops oldest                                                |
| pop-on-read              | one read consumes one item; second read returns None; no ACK                           |
| frontend activation take | re-check `activeAccountId`; dedupe `activationId`; open at most once                   |
| frontend rejection take  | notify once; never open a task                                                         |
| event delivery           | wake-up only; no payload delivery                                                      |
| process exit             | in-memory queues lost; no task opens; at-most-once UX                                  |
| cleanup                  | abort/dispose; pending queue items stay in Native for a future bridge                  |
| Native failure           | end current cycle; a later wake may retry; no busy loop                                |
| wake burst               | coalesced into serial cycles with bounded per-cycle consumes                           |
| scheduling               | serial; activation and rejection drains cannot interleave; each preserves its own FIFO |

Activation and rejection queues are independent; neither command consumes the
other queue. Overflow changes only UX delivery, never account/gate/task checks.

## 3. Crash recovery matrix (C)

Use `fault-injection` feature + child process with `FaultAction::Terminate` to
exit at exact persisted boundaries. Parent recovers in a fresh process logic and
compares full `read_snapshot()` fingerprints.

| Boundary                         | Child op        | Expected after restart                                   |
| -------------------------------- | --------------- | -------------------------------------------------------- |
| `SwitchPreparedPersisted`        | prepare         | journal discarded; source active                         |
| `SwitchRestartRequiredPersisted` | request         | target committed; finish idempotent                      |
| `SwitchVerifyingTargetPersisted` | recover         | journal VERIFYING; retry commits target                  |
| `RegistryActiveBeforeUpdate`     | recover         | journal VERIFYING; registry source; retry commits target |
| `RegistryActiveAfterUpdate`      | recover         | journal VERIFYING; registry target; retry commits target |
| `SwitchJournalBeforeCleanup`     | finish          | journal stays; retry finish removes                      |
| Target DB corrupt                | request/recover | fail-closed; source restored; FAILED                     |
| external SQLite lock             | unit            | busy, no partial state                                   |

The child is a real process and exits with a non-zero code at the fault point;
tests assert the exit code, not a returned error. No production IPC/terminate
hook is added.

## 4. Windows real Toast (D)

Automated harness can install/launch/check identity/storage/fault, but cannot
claim real Toast click. `manual-platform.json` M1–M10 remain `NOT_RUN` until an
operator records real desktop evidence. The QA package uses isolated identifier,
data root and credential service; production root must remain absent.

## 5. Platform gates (E)

- Windows: QA bundle/install/discovery plus manual Toast.
- macOS/Linux: CI compile check only.
- Android/iOS: no SDK/NDK/Xcode/signing in this environment; `NOT_RUN`.
- Compile check is not installation/runtime/release acceptance.

## 6. Implementation status

- Rejection allowlist mapping implemented in `631e2ef`; all user-visible
  messages are fixed static strings, and serialized-path/SQL regression tests
  pass.
- Queue boundary tests added in `e04c45e`; 24 frontend notification tests and
  11 Native notification tests pass.
- Six real child-process termination points implemented in `ca3db08`; the
  existing SIGKILL tests remain. Other boundaries stay PARTIAL/NOT_RUN.
- Manual M1–M10 plus generated `manual-platform.json`; real Toast/cold-start
  remain NOT_RUN.
- No production IPC or default-build terminate hook was added.

## 7. Acceptance

- Serialized rejection results contain no path/internal error text for all
  mapped error branches.
- Queue boundary tests cover 8/9 overflow, alternating queues, wake
  before/during/after drain, null, repeated invoke failure, cleanup race,
  duplicate wake, cross-queue independence.
- Crash child tests exit at each listed fault point and pass recovery invariants.
- Windows QA harness + CI on final SHA; real Toast remains NOT_RUN.
- Final status: `CODE_RC_READY` only if gates pass; `PLATFORM_RELEASE_READY`
  remains `NOT_READY` without real platform evidence.
