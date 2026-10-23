use rusqlite::Connection;
use serde_json::json;
use todo_native_core::{
    ApplyServerResultRequest, CloudInitializeRequest, CloudMergeMode, CloudSnapshot, DayPlan,
    ImportMode, ImportRequest, NewList, NewTask, TaskPatch, TaskStatus, TaskView, TodoStore,
    dispatch,
};

fn new_task(title: &str) -> NewTask {
    NewTask {
        title: title.to_owned(),
        ..NewTask::default()
    }
}

fn create_list(store: &TodoStore, name: &str) -> todo_native_core::TaskList {
    store
        .create_list(NewList {
            name: name.to_owned(),
            ..NewList::default()
        })
        .expect("create list")
}

fn seed_shadow(store: &TodoStore) {
    let bundle = store.export_data().expect("export local seed");
    let snapshot = CloudSnapshot {
        cursor: "0".to_owned(),
        lists: bundle.lists,
        tasks: bundle.tasks,
        steps: bundle.steps,
        day_plans: bundle.day_plans,
    };
    let result = store
        .sync_initialize_cloud(CloudInitializeRequest {
            snapshot,
            mode: CloudMergeMode::Cloud,
            account_email: "test@example.com".to_owned(),
            session_id: None,
        })
        .expect("seed shadow");
    assert_eq!(result.prepared_ops, 0);
}

#[test]
fn crud_outbox_and_list_delete_are_transactional() {
    let store = TodoStore::open_in_memory().expect("open store");
    let list = create_list(&store, "工作");
    let task = store
        .create_task(NewTask {
            title: "  写周报  ".to_owned(),
            list_id: Some(list.id.clone()),
            note: Some("第一行\r\n第二行".to_owned()),
            important: Some(true),
            plan_date: Some("2026-10-21".to_owned()),
            ..NewTask::default()
        })
        .expect("create task");

    assert_eq!(task.title, "写周报");
    assert_eq!(task.note, "第一行\n第二行");
    assert_eq!(task.list_id.as_deref(), Some(list.id.as_str()));
    assert_eq!(task.occurrence_key, task.due_on);

    let detailed = store.get_task(&task.id).expect("get task").expect("task");
    assert!(detailed.steps.is_empty());
    assert_eq!(detailed.day_plan_dates, vec!["2026-10-21".to_owned()]);

    assert_eq!(store.get_sync_cursor().expect("cursor"), "0");
    assert_eq!(
        store.sync_diagnostics().expect("diagnostics").pending,
        0,
        "sync is disabled by default, so new outbox rows stay local"
    );
    store.sync_set_enabled(true).expect("enable sync");
    let pending = store.pending_mutations(50).expect("pending");
    assert_eq!(pending.len(), 3, "list + task + day plan");
    let task_mutation = pending
        .iter()
        .find(|item| item.entity == "task")
        .expect("task mutation");
    let plan_mutation = pending
        .iter()
        .find(|item| item.entity == "day_plan")
        .expect("day plan mutation");
    assert_eq!(task_mutation.status, "pending");
    assert!(task_mutation.client_seq < plan_mutation.client_seq);
    assert!(!store.get_device_id().expect("device").is_empty());

    store.delete_list(&list.id).expect("delete list");
    let reloaded = store.get_task(&task.id).expect("get task").expect("task");
    assert!(reloaded.list_id.is_none());
    assert!(
        store
            .list_lists()
            .expect("lists")
            .iter()
            .all(|item| item.id != list.id)
    );
    let pending = store.pending_mutations(50).expect("pending");
    assert!(
        pending
            .iter()
            .any(|item| item.entity == "list" && item.kind == "delete")
    );
    assert!(pending.iter().any(|item| {
        item.entity == "task" && item.kind == "patch" && item.patch["listId"].is_null()
    }));
}

#[test]
fn completion_failure_rolls_back_materialized_and_outbox_rows() {
    let store = TodoStore::open_in_memory().expect("open store");
    let task = store.create_task(new_task("原任务")).expect("task");
    let existing = store.create_task(new_task("已存在")).expect("other");
    store.sync_set_enabled(true).expect("enable sync");
    let pending_before = store.pending_mutations(100).expect("pending").len();

    let mut duplicate_next = existing.clone();
    duplicate_next.title = "重复生成".to_owned();

    let error = store
        .commit_completion(&task.id, "2026-10-21T08:00:00Z", Some(duplicate_next))
        .expect_err("duplicate id must fail");
    assert!(error.to_string().contains("database error"));

    let task_after = store.get_task(&task.id).expect("get").expect("task");
    assert_eq!(task_after.status, TaskStatus::Open);
    assert_eq!(
        store.pending_mutations(100).expect("pending").len(),
        pending_before,
        "completion update/outbox must roll back with the failed next insert"
    );
}

#[test]
fn day_plan_tombstone_is_restored_without_unique_violation() {
    let store = TodoStore::open_in_memory().expect("open store");
    let task = store.create_task(new_task("加入今天")).expect("task");
    store.add_to_day(&task.id, "2026-10-21").expect("add");
    store
        .remove_from_day(&task.id, "2026-10-21")
        .expect("remove");
    store
        .add_to_day(&task.id, "2026-10-21")
        .expect("restore tombstone");
    let task = store.get_task(&task.id).expect("get").expect("task");
    assert_eq!(task.day_plan_dates, vec!["2026-10-21"]);

    store.sync_set_enabled(true).expect("enable sync");
    let mutations = store.pending_mutations(50).expect("pending");
    let day_plan_kinds = mutations
        .iter()
        .filter(|mutation| mutation.entity == "day_plan")
        .map(|mutation| mutation.kind.as_str())
        .collect::<Vec<_>>();
    assert_eq!(day_plan_kinds, vec!["create", "delete", "restore"]);
}

#[test]
fn queries_counts_patches_and_steps_work() {
    let store = TodoStore::open_in_memory().expect("open store");
    let list = create_list(&store, "生活");
    let important = store
        .create_task(NewTask {
            list_id: Some(list.id.clone()),
            due_on: Some("2026-10-21".to_owned()),
            important: Some(true),
            plan_date: Some("2026-10-21".to_owned()),
            ..new_task("交电费")
        })
        .expect("task");
    store.create_task(new_task("收件箱任务")).expect("task");

    let patch = serde_json::from_value::<TaskPatch>(json!({
        "title": "交电费（已完成）",
        "remindAt": "2026-10-21T09:30:00+08:00",
        "remindTimezone": "Asia/Shanghai",
        "dueOn": null
    }))
    .expect("patch");
    let patched = store.patch_task(&important.id, patch).expect("patch");
    assert_eq!(patched.title, "交电费（已完成）");
    assert_eq!(patched.due_on, None);
    assert_eq!(
        patched.remind_at.as_deref(),
        Some("2026-10-21T01:30:00.000Z")
    );

    let step = store.create_step(&important.id, "核对账单").expect("step");
    let patched_step = serde_json::from_value(json!({"isCompleted": true})).expect("step patch");
    let step = store
        .patch_step(&step.id, patched_step)
        .expect("patch step");
    assert!(step.is_completed);

    let detailed = store.get_task(&important.id).expect("get").expect("task");
    assert_eq!(detailed.steps.len(), 1);
    assert_eq!(detailed.steps[0].title, "核对账单");

    let counts = store.get_counts("2026-10-21").expect("counts");
    assert_eq!(counts.my_day, 1);
    assert_eq!(counts.important, 1);
    assert_eq!(counts.planned, 0);
    assert_eq!(counts.all, 2);
    assert_eq!(counts.lists.get(&list.id), Some(&1));

    let page = serde_json::from_value::<todo_native_core::TaskQuery>(json!({
        "view": "list",
        "listId": list.id,
        "search": "电费",
        "includeCompleted": false
    }))
    .expect("query");
    let page = store.list_tasks(page).expect("list");
    assert_eq!(page.items.len(), 1);
    assert_eq!(page.items[0].id, important.id);
    assert_eq!(page.items[0].steps.len(), 1);
}

#[test]
fn apply_server_result_updates_ack_cursor_and_shadow() {
    let store = TodoStore::open_in_memory().expect("open store");
    let task = store.create_task(new_task("待同步")).expect("task");
    store.sync_set_enabled(true).expect("enable sync");
    let pending = store.pending_mutations(10).expect("pending");
    let op = pending.first().expect("mutation");

    store
        .apply_server_result(ApplyServerResultRequest {
            acks: vec![todo_native_core::ServerAck {
                op_id: op.op_id.clone(),
                server_seq: Some(1),
                status: "applied".to_owned(),
                error_code: None,
            }],
            changes: vec![
                serde_json::from_value(json!({
                    "serverSeq": 1,
                    "opId": op.op_id,
                    "entity": "task",
                    "entityId": task.id,
                    "kind": "patch",
                    "patch": { "title": "服务端标题", "note": "shadow" }
                }))
                .expect("change"),
            ],
            next_cursor: "1".to_owned(),
            session_id: None,
        })
        .expect("apply");

    assert!(store.pending_mutations(10).expect("pending").is_empty());
    assert_eq!(store.get_sync_cursor().expect("cursor"), "1");
    let task = store.get_task(&task.id).expect("get").expect("task");
    assert_eq!(task.title, "服务端标题");
    assert_eq!(task.note, "shadow");
}

#[test]
fn apply_server_result_keeps_pending_fields_over_remote_changes() {
    let store = TodoStore::open_in_memory().expect("open store");
    let task = store
        .create_task(NewTask {
            note: Some("初始备注".to_owned()),
            ..new_task("初始标题")
        })
        .expect("task");
    seed_shadow(&store);
    store
        .patch_task(
            &task.id,
            serde_json::from_value(json!({ "title": "本地标题" })).expect("patch"),
        )
        .expect("local patch");

    store
        .apply_server_result(ApplyServerResultRequest {
            acks: vec![],
            changes: vec![
                serde_json::from_value(json!({
                    "serverSeq": 2,
                    "opId": "remote-different-field",
                    "entity": "task",
                    "entityId": task.id,
                    "kind": "patch",
                    "patch": { "note": "远端备注" }
                }))
                .expect("change"),
            ],
            next_cursor: "2".to_owned(),
            session_id: None,
        })
        .expect("apply");

    let loaded = store.get_task(&task.id).expect("get").expect("task");
    assert_eq!(loaded.title, "本地标题", "pending title must survive");
    assert_eq!(loaded.note, "远端备注", "remote unrelated field must apply");
    assert_eq!(store.sync_diagnostics().expect("diagnostics").pending, 1);

    store
        .apply_server_result(ApplyServerResultRequest {
            acks: vec![],
            changes: vec![
                serde_json::from_value(json!({
                    "serverSeq": 3,
                    "opId": "remote-same-field",
                    "entity": "task",
                    "entityId": task.id,
                    "kind": "patch",
                    "patch": { "title": "远端标题" }
                }))
                .expect("change"),
            ],
            next_cursor: "3".to_owned(),
            session_id: None,
        })
        .expect("apply");

    let loaded = store.get_task(&task.id).expect("get").expect("task");
    assert_eq!(loaded.title, "本地标题", "pending same-field edit wins");
    assert_eq!(loaded.note, "远端备注");
}

#[test]
fn apply_server_result_rejected_ack_rolls_back_pending_patch() {
    let store = TodoStore::open_in_memory().expect("open store");
    let task = store.create_task(new_task("影子标题")).expect("task");
    seed_shadow(&store);
    store
        .patch_task(
            &task.id,
            serde_json::from_value(json!({ "title": "被拒绝的本地标题" })).expect("patch"),
        )
        .expect("local patch");
    let pending = store.pending_mutations(10).expect("pending");
    let op = pending.first().expect("pending op");

    store
        .apply_server_result(ApplyServerResultRequest {
            acks: vec![todo_native_core::ServerAck {
                op_id: op.op_id.clone(),
                server_seq: None,
                status: "rejected".to_owned(),
                error_code: Some("VALIDATION_FAILED".to_owned()),
            }],
            changes: vec![],
            next_cursor: "2".to_owned(),
            session_id: None,
        })
        .expect("apply ack");

    let loaded = store.get_task(&task.id).expect("get").expect("task");
    assert_eq!(loaded.title, "影子标题", "rejected patch must be removed");
    let diagnostics = store.sync_diagnostics().expect("diagnostics");
    assert_eq!(diagnostics.pending, 0);
    assert_eq!(diagnostics.rejected, 1);
}

#[test]
fn apply_server_result_applied_ack_uses_updated_shadow() {
    let store = TodoStore::open_in_memory().expect("open store");
    let task = store.create_task(new_task("影子标题")).expect("task");
    seed_shadow(&store);
    store
        .patch_task(
            &task.id,
            serde_json::from_value(json!({ "title": "本地待同步标题" })).expect("patch"),
        )
        .expect("local patch");
    let pending = store.pending_mutations(10).expect("pending");
    let op = pending.first().expect("pending op");

    store
        .apply_server_result(ApplyServerResultRequest {
            acks: vec![todo_native_core::ServerAck {
                op_id: op.op_id.clone(),
                server_seq: Some(2),
                status: "applied".to_owned(),
                error_code: None,
            }],
            changes: vec![
                serde_json::from_value(json!({
                    "serverSeq": 2,
                    "opId": op.op_id,
                    "entity": "task",
                    "entityId": task.id,
                    "kind": "patch",
                    "patch": { "title": "服务端确认标题", "tags": ["remote-tag"] }
                }))
                .expect("change"),
            ],
            next_cursor: "2".to_owned(),
            session_id: None,
        })
        .expect("apply ack");

    let loaded = store.get_task(&task.id).expect("get").expect("task");
    assert_eq!(loaded.title, "服务端确认标题");
    assert_eq!(loaded.tags, vec!["remote-tag".to_owned()]);
    assert!(store.pending_mutations(10).expect("pending").is_empty());
}

#[test]
fn export_import_roundtrip_and_clear_all_keep_device() {
    let store = TodoStore::open_in_memory().expect("open store");
    let list = create_list(&store, "工作");
    let task = store
        .create_task(NewTask {
            list_id: Some(list.id.clone()),
            plan_date: Some("2026-10-21".to_owned()),
            ..new_task("导出任务")
        })
        .expect("task");
    store.create_step(&task.id, "步骤").expect("step");
    let device_before = store.get_device_id().expect("device");
    let bundle = store.export_data().expect("export");
    assert_eq!(bundle.format, "todo-export");
    assert_eq!(bundle.version, 1);
    assert_eq!(bundle.app_version, "1.0.0");
    assert_eq!(bundle.tasks.len(), 1);

    store.clear_all().expect("clear");
    assert!(store.list_lists().expect("lists").is_empty());
    assert!(store.pending_mutations(100).expect("pending").is_empty());
    assert_eq!(store.get_device_id().expect("device"), device_before);

    store
        .import_data(ImportRequest {
            bundle,
            mode: ImportMode::Replace,
        })
        .expect("import");
    let loaded = store.get_task(&task.id).expect("get").expect("task");
    assert_eq!(loaded.title, "导出任务");
    assert_eq!(loaded.day_plan_dates, vec!["2026-10-21"]);
    assert_eq!(loaded.steps.len(), 1);
}

#[test]
fn dispatch_uses_camel_case_contract_and_rejects_unknown_actions() {
    let store = TodoStore::open_in_memory().expect("open store");
    let list = dispatch(
        &store,
        "create_list",
        json!({ "name": "清单", "color": "#4f6ed0" }),
    )
    .expect("create list");
    assert_eq!(list["color"], "#4f6ed0");

    let task = dispatch(
        &store,
        "create_task",
        json!({ "title": "命令任务", "listId": list["id"], "important": true }),
    )
    .expect("create task");
    assert!(task["listId"].is_string());
    assert_eq!(task["important"], true);

    let error = dispatch(
        &store,
        "run_sql",
        json!({ "sql": "DELETE FROM local_tasks" }),
    )
    .expect_err("unknown action must be rejected");
    assert!(error.to_string().contains("未知"));
}

#[test]
fn rotate_device_id_rewrites_outbox_and_resets_sync_state() {
    let store = TodoStore::open_in_memory().expect("open store");
    create_list(&store, "工作");
    store.create_task(new_task("离线任务")).expect("task");
    let old_device = store.get_device_id().expect("device");

    let new_device = store.rotate_device_id().expect("rotate");
    assert_ne!(old_device, new_device);
    assert_eq!(store.get_device_id().expect("device"), new_device);
    assert_eq!(store.get_sync_cursor().expect("cursor"), "0");
    let diagnostics = store.sync_diagnostics().expect("diagnostics");
    assert!(!diagnostics.enabled);
    assert_eq!(diagnostics.pending, 0, "rotated rows must be local");

    store.sync_set_enabled(true).expect("enable sync");
    let pending = store.pending_mutations(20).expect("pending");
    assert_eq!(pending.len(), 2);
    assert!(
        pending
            .iter()
            .all(|mutation| mutation.device_id == new_device)
    );
    assert!(
        pending
            .windows(2)
            .all(|pair| pair[0].client_seq < pair[1].client_seq)
    );
}

#[test]
fn merge_initialization_prepares_ordered_ops_and_remote_wins_day_plan_slot() {
    let store = TodoStore::open_in_memory().expect("open store");
    let list = create_list(&store, "工作");
    let task = store
        .create_task(NewTask {
            list_id: Some(list.id.clone()),
            ..new_task("原任务")
        })
        .expect("task");
    store.add_to_day(&task.id, "2026-10-21").expect("plan");
    store
        .create_task(new_task("仅本机任务"))
        .expect("local extra");
    let local = store.export_data().expect("export");
    let local_plan_id = local.day_plans[0].id.clone();

    let remote_task = local
        .tasks
        .iter()
        .find(|candidate| candidate.id == task.id)
        .cloned()
        .expect("remote task");
    let remote_list = local.lists[0].clone();
    let remote_plan = DayPlan {
        id: "remote-plan-id".to_owned(),
        task_id: task.id.clone(),
        local_date: "2026-10-21".to_owned(),
        rank: "a1".to_owned(),
        created_at: remote_task.created_at.clone(),
        updated_at: remote_task.updated_at.clone(),
        deleted_at: None,
    };
    let snapshot = CloudSnapshot {
        cursor: "7".to_owned(),
        lists: vec![remote_list],
        tasks: vec![remote_task],
        steps: vec![],
        day_plans: vec![remote_plan],
    };
    let result = store
        .sync_initialize_cloud(CloudInitializeRequest {
            snapshot,
            mode: CloudMergeMode::Merge,
            account_email: "user@example.com".to_owned(),
            session_id: None,
        })
        .expect("initialize");
    assert_eq!(result.prepared_ops, 1, "only the local-only task is an op");
    let diagnostics = store.sync_diagnostics().expect("diagnostics");
    assert!(diagnostics.enabled);
    assert_eq!(diagnostics.cursor, "7");
    assert_eq!(diagnostics.pending, 1);
    assert_eq!(
        diagnostics.bound_account.as_deref(),
        Some("user@example.com")
    );

    let plans = store.export_data().expect("export").day_plans;
    assert_eq!(plans.len(), 1);
    assert_eq!(plans[0].id, "remote-plan-id");
    assert_ne!(plans[0].id, local_plan_id);
}

#[test]
fn snapshot_rebase_keeps_pending_mutations() {
    let store = TodoStore::open_in_memory().expect("open store");
    let task = store.create_task(new_task("初始标题")).expect("task");
    store.sync_set_enabled(true).expect("enable sync");
    let patched = store
        .patch_task(
            &task.id,
            serde_json::from_value(json!({ "title": "本机修改" })).expect("patch"),
        )
        .expect("patch");
    assert_eq!(patched.title, "本机修改");

    let mut remote_task = task.clone();
    remote_task.title = "远端标题".to_owned();
    remote_task.updated_at = "2026-10-21T00:00:00.000Z".to_owned();
    let snapshot = CloudSnapshot {
        cursor: "9".to_owned(),
        lists: vec![],
        tasks: vec![remote_task],
        steps: vec![],
        day_plans: vec![],
    };
    store.sync_replace_snapshot(&snapshot).expect("rebase");
    let rebased = store.get_task(&task.id).expect("get").expect("task");
    assert_eq!(
        rebased.title, "本机修改",
        "pending ops replay over remote shadow"
    );
    assert_eq!(store.get_sync_cursor().expect("cursor"), "9");
    assert_eq!(store.sync_diagnostics().expect("diagnostics").pending, 2);
}

#[test]
fn clear_account_binding_resets_outbox_and_cloud_state() {
    let store = TodoStore::open_in_memory().expect("open store");
    let task = store.create_task(new_task("保留本机数据")).expect("task");
    let snapshot = CloudSnapshot {
        cursor: "0".to_owned(),
        lists: vec![],
        tasks: vec![],
        steps: vec![],
        day_plans: vec![],
    };
    let result = store
        .sync_initialize_cloud(CloudInitializeRequest {
            snapshot,
            mode: CloudMergeMode::Merge,
            account_email: "first@example.com".to_owned(),
            session_id: None,
        })
        .expect("initialize");
    assert_eq!(result.prepared_ops, 1);

    store.sync_clear_account_binding().expect("clear binding");
    let diagnostics = store.sync_diagnostics().expect("diagnostics");
    assert!(!diagnostics.enabled);
    assert_eq!(diagnostics.cursor, "0");
    assert_eq!(diagnostics.pending, 0);
    assert_eq!(diagnostics.rejected, 0);
    assert!(diagnostics.bound_account.is_none());
    assert!(store.get_task(&task.id).expect("get").is_some());
}

#[test]
fn clear_rejected_reprojects_from_shadow() {
    let store = TodoStore::open_in_memory().expect("open store");
    let task = store.create_task(new_task("初始标题")).expect("task");
    let mut remote_task = task.clone();
    remote_task.title = "远端标题".to_owned();
    let snapshot = CloudSnapshot {
        cursor: "3".to_owned(),
        lists: vec![],
        tasks: vec![remote_task],
        steps: vec![],
        day_plans: vec![],
    };
    store
        .sync_initialize_cloud(CloudInitializeRequest {
            snapshot,
            mode: CloudMergeMode::Cloud,
            account_email: "user@example.com".to_owned(),
            session_id: None,
        })
        .expect("initialize");
    store
        .patch_task(
            &task.id,
            serde_json::from_value(json!({ "title": "被拒绝的本地修改" })).expect("patch"),
        )
        .expect("patch");
    let pending = store.pending_mutations(10).expect("pending");
    let op = pending.first().expect("pending op");

    store
        .apply_server_result(ApplyServerResultRequest {
            acks: vec![todo_native_core::ServerAck {
                op_id: op.op_id.clone(),
                server_seq: None,
                status: "rejected".to_owned(),
                error_code: Some("VALIDATION_FAILED".to_owned()),
            }],
            changes: vec![],
            next_cursor: "3".to_owned(),
            session_id: None,
        })
        .expect("reject");
    assert_eq!(store.sync_diagnostics().expect("diagnostics").rejected, 1);
    store.sync_clear_rejected().expect("clear rejected");
    let restored = store.get_task(&task.id).expect("get").expect("task");
    assert_eq!(restored.title, "远端标题");
    assert_eq!(store.sync_diagnostics().expect("diagnostics").rejected, 0);
}

#[test]
fn task_tags_are_normalized_patched_and_exported() {
    let store = TodoStore::open_in_memory().expect("open store");
    let task = store
        .create_task(NewTask {
            tags: vec![
                " Work ".to_owned(),
                "work".to_owned(),
                " Personal ".to_owned(),
            ],
            ..new_task("带标签任务")
        })
        .expect("create task");
    assert_eq!(task.tags, vec!["Work".to_owned(), "Personal".to_owned()]);

    store.sync_set_enabled(true).expect("enable sync");
    let patched = store
        .patch_task(
            &task.id,
            serde_json::from_value(json!({
                "tags": [" Urgent ", "urgent", " home "]
            }))
            .expect("patch"),
        )
        .expect("patch tags");
    assert_eq!(patched.tags, vec!["Urgent".to_owned(), "home".to_owned()]);

    let pending = store.pending_mutations(20).expect("pending");
    let tag_patch = pending
        .iter()
        .find(|mutation| mutation.entity == "task" && mutation.kind == "patch")
        .expect("tag patch");
    assert_eq!(tag_patch.patch["tags"], json!(["Urgent", "home"]));

    let exported = store.export_data().expect("export");
    let exported_task = exported
        .tasks
        .iter()
        .find(|candidate| candidate.id == task.id)
        .expect("exported task");
    assert_eq!(
        exported_task.tags,
        vec!["Urgent".to_owned(), "home".to_owned()]
    );

    let page = store
        .list_tasks(todo_native_core::TaskQuery {
            view: TaskView::All,
            list_id: None,
            search: None,
            tags: vec!["URGENT".to_owned()],
            local_date: None,
            due_from: None,
            due_to: None,
            include_completed: false,
            limit: None,
        })
        .expect("query by tag");
    assert_eq!(page.items.len(), 1);
    assert_eq!(
        page.items[0].tags,
        vec!["Urgent".to_owned(), "home".to_owned()]
    );
}

#[test]
fn task_tags_reject_invalid_limits_and_unknown_fields() {
    let store = TodoStore::open_in_memory().expect("open store");
    let too_many = (0..21)
        .map(|index| format!("tag-{index}"))
        .collect::<Vec<_>>();
    let error = store
        .create_task(NewTask {
            tags: too_many,
            ..new_task("太多标签")
        })
        .expect_err("more than 20 tags must fail");
    assert!(error.to_string().contains("20"));

    let too_long = "x".repeat(33);
    assert!(
        store
            .create_task(NewTask {
                tags: vec![too_long],
                ..new_task("标签过长")
            })
            .is_err()
    );
    assert!(
        store
            .create_task(NewTask {
                tags: vec!["   ".to_owned()],
                ..new_task("空标签")
            })
            .is_err()
    );
    assert!(
        serde_json::from_value::<TaskPatch>(json!({
            "tags": [],
            "unknownField": true
        }))
        .is_err()
    );
    assert!(
        serde_json::from_value::<NewTask>(json!({
            "title": "未知字段",
            "unknownField": true
        }))
        .is_err()
    );
}

#[test]
fn merge_and_snapshot_preserve_task_tags() {
    let store = TodoStore::open_in_memory().expect("open store");
    let task = store
        .create_task(NewTask {
            tags: vec!["local".to_owned()],
            ..new_task("标签同步任务")
        })
        .expect("task");
    let bundle = store.export_data().expect("export");
    let mut remote_task = bundle
        .tasks
        .iter()
        .find(|candidate| candidate.id == task.id)
        .cloned()
        .expect("remote task");
    remote_task.tags = vec!["remote".to_owned()];
    let snapshot = CloudSnapshot {
        cursor: "4".to_owned(),
        lists: bundle.lists.clone(),
        tasks: vec![remote_task.clone()],
        steps: bundle.steps.clone(),
        day_plans: bundle.day_plans.clone(),
    };
    let result = store
        .sync_initialize_cloud(CloudInitializeRequest {
            snapshot,
            mode: CloudMergeMode::Merge,
            account_email: "tags@example.com".to_owned(),
            session_id: None,
        })
        .expect("merge");
    assert_eq!(result.prepared_ops, 0);
    assert_eq!(
        store.get_task(&task.id).expect("get").expect("task").tags,
        vec!["remote".to_owned()]
    );

    store
        .patch_task(
            &task.id,
            serde_json::from_value(json!({ "tags": ["pending"] })).expect("patch"),
        )
        .expect("pending tag patch");
    let remote_after_rebase = {
        let mut task = remote_task;
        task.tags = vec!["snapshot".to_owned()];
        task
    };
    store
        .sync_replace_snapshot(&CloudSnapshot {
            cursor: "5".to_owned(),
            lists: bundle.lists,
            tasks: vec![remote_after_rebase],
            steps: bundle.steps,
            day_plans: bundle.day_plans,
        })
        .expect("rebase");
    assert_eq!(
        store.get_task(&task.id).expect("get").expect("task").tags,
        vec!["pending".to_owned()],
        "pending tags must replay over the snapshot"
    );
}

#[test]
fn stale_sync_session_cannot_commit_server_results() {
    let store = TodoStore::open_in_memory().expect("open store");
    store.sync_set_enabled(true).expect("enable sync");
    store
        .sync_set_session(Some("session-a"))
        .expect("session a");
    store.create_task(new_task("first")).expect("first task");
    let first = store.pending_mutations(10).expect("pending first");
    let first_op = first.first().expect("first op");
    store
        .apply_server_result(ApplyServerResultRequest {
            acks: vec![todo_native_core::ServerAck {
                op_id: first_op.op_id.clone(),
                server_seq: Some(1),
                status: "applied".to_owned(),
                error_code: None,
            }],
            changes: vec![],
            next_cursor: "1".to_owned(),
            session_id: Some("session-a".to_owned()),
        })
        .expect("first apply");

    store.create_task(new_task("second")).expect("second task");
    let second = store.pending_mutations(10).expect("pending second");
    let second_op = second.last().expect("second op").clone();
    store
        .sync_set_session(Some("session-b"))
        .expect("session b");
    let error = store
        .apply_server_result(ApplyServerResultRequest {
            acks: vec![todo_native_core::ServerAck {
                op_id: second_op.op_id.clone(),
                server_seq: Some(2),
                status: "applied".to_owned(),
                error_code: None,
            }],
            changes: vec![],
            next_cursor: "2".to_owned(),
            session_id: Some("session-a".to_owned()),
        })
        .expect_err("stale write must fail");

    assert_eq!(error.code().as_str(), "STALE_SYNC_SESSION");
    assert_eq!(store.get_sync_cursor().expect("cursor"), "1");
    assert!(
        store
            .pending_mutations(10)
            .expect("pending after rejection")
            .iter()
            .any(|mutation| mutation.op_id == second_op.op_id)
    );
}

#[test]
fn stale_sync_session_cannot_replace_a_snapshot() {
    let store = TodoStore::open_in_memory().expect("open store");
    let task = store.create_task(new_task("keep")).expect("task");
    store
        .sync_set_session(Some("session-b"))
        .expect("session b");
    let error = store
        .sync_replace_snapshot_fenced(
            &CloudSnapshot {
                cursor: "9".to_owned(),
                lists: vec![],
                tasks: vec![],
                steps: vec![],
                day_plans: vec![],
            },
            Some("session-a"),
        )
        .expect_err("stale snapshot must fail");
    assert_eq!(error.code().as_str(), "STALE_SYNC_SESSION");
    assert!(store.get_task(&task.id).expect("get").is_some());
}

#[test]
fn stale_sync_session_cannot_initialize_cloud_data() {
    let store = TodoStore::open_in_memory().expect("open store");
    let task = store.create_task(new_task("keep")).expect("task");
    store
        .sync_set_session(Some("session-b"))
        .expect("session b");
    let error = store
        .sync_initialize_cloud(CloudInitializeRequest {
            snapshot: CloudSnapshot {
                cursor: "9".to_owned(),
                lists: vec![],
                tasks: vec![],
                steps: vec![],
                day_plans: vec![],
            },
            mode: CloudMergeMode::Cloud,
            account_email: "a@example.com".to_owned(),
            session_id: Some("session-a".to_owned()),
        })
        .expect_err("stale initialize must fail");
    assert_eq!(error.code().as_str(), "STALE_SYNC_SESSION");
    assert!(store.get_task(&task.id).expect("get").is_some());
}

#[test]
fn reminder_query_returns_only_open_visible_tasks_in_due_order() {
    let store = TodoStore::open_in_memory().expect("open store");
    let later = store
        .create_task(NewTask {
            title: "later".to_owned(),
            remind_at: Some("2026-10-24T10:00:00Z".to_owned()),
            ..NewTask::default()
        })
        .expect("later");
    let sooner = store
        .create_task(NewTask {
            title: "sooner".to_owned(),
            remind_at: Some("2026-10-24T09:00:00Z".to_owned()),
            ..NewTask::default()
        })
        .expect("sooner");
    let completed = store
        .create_task(NewTask {
            title: "completed".to_owned(),
            remind_at: Some("2026-10-24T08:00:00Z".to_owned()),
            ..NewTask::default()
        })
        .expect("completed");
    store
        .commit_completion(&completed.id, "2026-10-23T08:00:00Z", None)
        .expect("complete");
    let deleted = store
        .create_task(NewTask {
            title: "deleted".to_owned(),
            remind_at: Some("2026-10-24T07:00:00Z".to_owned()),
            ..NewTask::default()
        })
        .expect("deleted");
    store.delete_task(&deleted.id).expect("delete");

    let reminders = store.upcoming_reminders().expect("reminders");
    assert_eq!(
        reminders
            .iter()
            .map(|task| task.id.as_str())
            .collect::<Vec<_>>(),
        vec![sooner.id.as_str(), later.id.as_str()]
    );
}

#[test]
fn reminder_query_handles_more_than_one_thousand_entries() {
    let store = TodoStore::open_in_memory().expect("open store");
    for index in 0..1001 {
        store
            .create_task(NewTask {
                title: format!("reminder {index}"),
                remind_at: Some(format!(
                    "2026-10-24T{:02}:{:02}:00Z",
                    index / 60,
                    index % 60
                )),
                ..NewTask::default()
            })
            .expect("create reminder");
    }
    let started = std::time::Instant::now();
    let reminders = store.upcoming_reminders().expect("reminders");
    println!(
        "[reminder-query] 1001 native candidates in {:?}",
        started.elapsed()
    );
    assert_eq!(reminders.len(), 1001);
}

#[test]
fn reopened_sqlite_database_preserves_offline_tasks_and_outbox() {
    let directory = tempfile::tempdir().expect("temp dir");
    let path = directory.path().join("restart.sqlite3");
    {
        let store = TodoStore::open(&path).expect("open store");
        store.sync_set_enabled(true).expect("enable sync");
        for index in 0..100 {
            store
                .create_task(NewTask {
                    title: format!("离线任务 {index}"),
                    ..NewTask::default()
                })
                .expect("create offline task");
        }
        assert_eq!(store.export_data().expect("export").tasks.len(), 100);
    }

    let reopened = TodoStore::open(&path).expect("reopen store");
    let bundle = reopened.export_data().expect("export after restart");
    assert_eq!(bundle.tasks.len(), 100);
    assert!(
        reopened.pending_mutations(200).expect("pending").len() >= 100,
        "unacknowledged offline mutations must survive restart"
    );
}

#[test]
fn migrates_legacy_task_table_with_empty_tags() {
    let directory = tempfile::tempdir().expect("temp dir");
    let path = directory.path().join("legacy.sqlite3");
    let connection = Connection::open(&path).expect("legacy db");
    connection
        .execute_batch(
            r#"
            CREATE TABLE schema_migrations (
              version INTEGER PRIMARY KEY,
              applied_at TEXT NOT NULL
            );
            INSERT INTO schema_migrations (version, applied_at)
              VALUES (1, '2026-01-01T00:00:00.000Z');
            CREATE TABLE local_lists (
              id TEXT PRIMARY KEY,
              name TEXT NOT NULL,
              color TEXT,
              icon TEXT,
              rank TEXT NOT NULL DEFAULT 'a0',
              created_at TEXT NOT NULL DEFAULT '',
              updated_at TEXT NOT NULL DEFAULT '',
              deleted_at TEXT
            );
            CREATE TABLE local_tasks (
              id TEXT PRIMARY KEY,
              list_id TEXT REFERENCES local_lists(id),
              title TEXT NOT NULL,
              note TEXT NOT NULL DEFAULT '',
              status TEXT NOT NULL CHECK (status IN ('open', 'completed')),
              important INTEGER NOT NULL DEFAULT 0,
              due_on TEXT,
              remind_at TEXT,
              remind_timezone TEXT,
              rank TEXT NOT NULL DEFAULT 'a0',
              series_id TEXT,
              occurrence_key TEXT,
              recurrence_json TEXT,
              completed_at TEXT,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL,
              deleted_at TEXT
            );
            CREATE TABLE local_steps (
              id TEXT PRIMARY KEY,
              task_id TEXT NOT NULL REFERENCES local_tasks(id),
              title TEXT NOT NULL,
              is_completed INTEGER NOT NULL DEFAULT 0,
              rank TEXT NOT NULL DEFAULT 'a0',
              created_at TEXT NOT NULL DEFAULT '',
              updated_at TEXT NOT NULL DEFAULT '',
              deleted_at TEXT
            );
            CREATE TABLE local_day_plans (
              id TEXT PRIMARY KEY,
              task_id TEXT NOT NULL REFERENCES local_tasks(id),
              local_date TEXT NOT NULL,
              rank TEXT NOT NULL DEFAULT 'a0',
              created_at TEXT NOT NULL DEFAULT '',
              updated_at TEXT NOT NULL DEFAULT '',
              deleted_at TEXT,
              UNIQUE(task_id, local_date)
            );
            CREATE TABLE kv_state (
              key TEXT PRIMARY KEY,
              value TEXT NOT NULL
            );
            INSERT INTO local_tasks
              (id, list_id, title, note, status, important, due_on, remind_at,
               remind_timezone, rank, series_id, occurrence_key, recurrence_json,
               completed_at, created_at, updated_at, deleted_at)
            VALUES
              ('legacy-task', NULL, '旧任务', '旧备注', 'open', 0, NULL, NULL,
               NULL, 'a0', NULL, NULL, NULL, NULL,
               '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', NULL);
            "#,
        )
        .expect("legacy schema");
    drop(connection);

    let store = TodoStore::open(&path).expect("open migrated store");
    let task = store
        .get_task("legacy-task")
        .expect("get")
        .expect("legacy task");
    assert_eq!(task.title, "旧任务");
    assert!(task.tags.is_empty());
    assert_eq!(
        store.export_data().expect("export").tasks[0].tags,
        Vec::<String>::new()
    );
}
