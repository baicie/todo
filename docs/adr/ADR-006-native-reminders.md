# ADR-006：系统提醒由 Native Scheduler 承担

- 状态：接受
- 日期：2026-10-21

## 背景

WebView 的 `setTimeout` 会在应用挂起、设备休眠或进程被系统回收后失效。把 JS Timer
当成后台提醒会向用户做出无法兑现的承诺。

## 决策

定义 `ReminderScheduler` 端口：

- Android：AlarmManager / NotificationManager（优先 inexact，精确闹钟需合规权限）。
- iOS：UNUserNotificationCenter。
- 桌面：系统通知 + 进程内调度队列，启动时重建。
- Web：明确标注只在页面存活时有效。

多设备各自安排提醒；远端修改后由下一次同步或推送提示重建。

## 后果

需要平台插件、权限弹窗、失败降级说明和真机验收；不能承诺所有 OEM 系统 100% 准点。
