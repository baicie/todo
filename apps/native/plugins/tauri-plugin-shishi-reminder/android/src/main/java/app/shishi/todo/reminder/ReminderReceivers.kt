package app.shishi.todo.reminder

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * Fires at the AlarmManager trigger time. The receiver runs in the app process
 * and does not require the WebView or JavaScript to be alive.
 */
class ReminderAlarmReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    if (intent.action != ReminderScheduler.ACTION_FIRE) return
    val reminderId = intent.getStringExtra(ReminderScheduler.EXTRA_REMINDER_ID) ?: return
    val reminder = ReminderStorage.all(context).firstOrNull { it.reminderId == reminderId }
    ReminderStorage.remove(context, reminderId)
    if (reminder != null) {
      ReminderScheduler.showNotification(
        context,
        reminder.reminderId,
        reminder.title,
        reminder.body,
      )
    }
  }
}

/**
 * Restores alarms after reboot. It reads only the small plugin-owned pending
 * queue; the UI's SQLite database is untouched.
 */
class ReminderBootReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    val action = intent.action ?: return
    if (action != Intent.ACTION_BOOT_COMPLETED &&
      action != "android.intent.action.QUICKBOOT_POWERON" &&
      action != "com.htc.intent.action.QUICKBOOT_POWERON"
    ) {
      return
    }
    val pendingResult = goAsync()
    Thread {
      try {
        ReminderScheduler.rescheduleAll(context.applicationContext)
      } finally {
        pendingResult.finish()
      }
    }.start()
  }
}
