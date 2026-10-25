# RC2-D Native QA Run

- Run: `rc2d-20261025T094545Z`
- App: `C:\Users\20555\AppData\Local\Shishi QA RC2D\todo-native.exe`
- Status: **PARTIAL**
- Tests: 7 PASS / 0 FAIL / 4 NOT_RUN
- Duration: 4674 ms

## Tests

| Test                                             | Status  | Duration | Detail |
| ------------------------------------------------ | ------- | -------: | ------ |
| qa_build_identity                                | PASS    |     0 ms |        |
| qa_boot_context                                  | PASS    |    28 ms |        |
| qa_storage_roundtrip                             | PASS    |  1762 ms |        |
| qa_reminder_permission_contract                  | PASS    |   113 ms |        |
| qa_reminder_schedule_cancel                      | PASS    |    25 ms |        |
| qa_credential_namespace                          | PASS    |   533 ms |        |
| qa_invalid_switch_does_not_change_active_account | PASS    |    43 ms |        |
| qa_desktop_notification_action_target            | NOT_RUN |     0 ms |        |
| qa_wrong_account_notification_is_rejected        | NOT_RUN |     0 ms |        |
| qa_fault_injection_prepared_recovery             | NOT_RUN |     0 ms |        |
| qa_fault_evidence                                | NOT_RUN |     0 ms |        |

NOT_RUN is not a pass. Real toast click and two-account notification routing require an interactive desktop account fixture.
