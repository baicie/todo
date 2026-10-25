# RC2-D Native QA Run

- Run: `rc2d-20261025T063603Z`
- App: `<user>\AppData\Local\Shishi QA RC2D\todo-native.exe`
- Status: **PARTIAL**
- Tests: 8 PASS / 0 FAIL / 4 NOT_RUN
- Duration: 36723 ms

## Tests

| Test                                             | Status  | Duration | Detail |
| ------------------------------------------------ | ------- | -------: | ------ |
| qa_build_identity                                | PASS    |     0 ms |        |
| qa_boot_context                                  | PASS    |    12 ms |        |
| qa_storage_roundtrip                             | PASS    |   476 ms |        |
| qa_reminder_permission_contract                  | PASS    |     5 ms |        |
| qa_reminder_schedule_cancel                      | PASS    |    14 ms |        |
| qa_credential_namespace                          | PASS    |    32 ms |        |
| qa_invalid_switch_does_not_change_active_account | PASS    |    10 ms |        |
| qa_desktop_notification_action_target            | NOT_RUN |     0 ms |        |
| qa_wrong_account_notification_is_rejected        | NOT_RUN |     0 ms |        |
| qa_fault_injection_prepared_recovery             | NOT_RUN |     0 ms |        |
| qa_fault_evidence                                | NOT_RUN |     0 ms |        |
| qa_performance_create_tasks                      | PASS    | 35423 ms |        |

NOT_RUN is not a pass. Real toast click and two-account notification routing require an interactive desktop account fixture.
