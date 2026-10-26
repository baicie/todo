# RC2-D Native QA Run

- Run: `rc2d-20261026T102328Z`
- App: `D:\workspace\git-code\todo\apps\native\src-tauri\target\release\todo-native.exe`
- Status: **PARTIAL**
- Tests: 9 PASS / 0 FAIL / 2 NOT_RUN
- Duration: 1900 ms

## Tests

| Test | Status | Duration | Detail |
| --- | --- | ---: | --- |
| qa_build_identity | PASS | 0 ms |  |
| qa_boot_context | PASS | 10 ms |  |
| qa_storage_roundtrip | PASS | 1051 ms |  |
| qa_reminder_permission_contract | PASS | 3 ms |  |
| qa_reminder_schedule_cancel | PASS | 13 ms |  |
| qa_credential_namespace | PASS | 39 ms |  |
| qa_invalid_switch_does_not_change_active_account | PASS | 10 ms |  |
| qa_desktop_notification_action_target | NOT_RUN | 0 ms |  |
| qa_wrong_account_notification_is_rejected | NOT_RUN | 0 ms |  |
| qa_fault_injection_prepared_recovery | PASS | 34 ms |  |
| qa_fault_evidence | PASS | 2 ms |  |

NOT_RUN is not a pass. Real toast click and two-account notification routing require an interactive desktop account fixture.