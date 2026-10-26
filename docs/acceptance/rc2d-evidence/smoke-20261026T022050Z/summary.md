# RC2-D Native QA Run

- Run: `rc2d-20261026T022050Z`
- App: `D:\workspace\git-code\todo\apps\native\src-tauri\target\release\todo-native.exe`
- Status: **PARTIAL**
- Tests: 7 PASS / 0 FAIL / 4 NOT_RUN
- Duration: 1825 ms

## Tests

| Test                                             | Status  | Duration | Detail |
| ------------------------------------------------ | ------- | -------: | ------ |
| qa_build_identity                                | PASS    |     0 ms |        |
| qa_boot_context                                  | PASS    |     9 ms |        |
| qa_storage_roundtrip                             | PASS    |   993 ms |        |
| qa_reminder_permission_contract                  | PASS    |     3 ms |        |
| qa_reminder_schedule_cancel                      | PASS    |    12 ms |        |
| qa_credential_namespace                          | PASS    |    32 ms |        |
| qa_invalid_switch_does_not_change_active_account | PASS    |    15 ms |        |
| qa_desktop_notification_action_target            | NOT_RUN |     0 ms |        |
| qa_wrong_account_notification_is_rejected        | NOT_RUN |     1 ms |        |
| qa_fault_injection_prepared_recovery             | NOT_RUN |     0 ms |        |
| qa_fault_evidence                                | NOT_RUN |     0 ms |        |

NOT_RUN is not a pass. Real toast click and two-account notification routing require an interactive desktop account fixture.
