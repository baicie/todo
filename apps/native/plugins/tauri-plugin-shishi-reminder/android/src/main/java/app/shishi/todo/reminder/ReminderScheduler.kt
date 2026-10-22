package app.shishi.todo.reminder

import android.Manifest
import android.app.AlarmManager
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import java.text.SimpleDateFormat
import java.util.Locale
import java.util.TimeZone

object ReminderScheduler {
  const val CHANNEL_ID = "shishi_reminders"
  const val ACTION_FIRE = "app.shishi.todo.reminder.FIRE"
  const val EXTRA_REMINDER_ID = "reminderId"
  const val EXTRA_TITLE = "title"
  const val EXTRA_BODY = "body"
  const val EXTRA_FIRE_AT = "fireAtUtc"

  fun ensureChannel(context: Context) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val manager = context.getSystemService(NotificationManager::class.java) ?: return
    val channel = NotificationChannel(
      CHANNEL_ID,
      "拾事提醒",
      NotificationManager.IMPORTANCE_HIGH,
    ).apply {
      description = "任务到期与本机预约提醒"
      setShowBadge(true)
    }
    manager.createNotificationChannel(channel)
  }

  /**
   * Schedules an absolute reminder. The default is an inexact wake-up that
   * survives Doze. Exact alarms are only used when requested and the user has
   * granted the special exact-alarm access; failures degrade to inexact.
   */
  fun schedule(
    context: Context,
    reminderId: String,
    fireAtUtc: String,
    title: String,
    body: String,
    exact: Boolean,
  ): StoredReminder {
    require(reminderId.isNotBlank()) { "reminderId must not be blank" }
    val fireAtMillis = parseInstant(fireAtUtc)
      ?: throw IllegalArgumentException("fireAtUtc is not a valid ISO-8601 instant")
    if (fireAtMillis <= System.currentTimeMillis()) {
      cancelAlarm(context, reminderId)
      ReminderStorage.remove(context, reminderId)
      return StoredReminder(reminderId, fireAtUtc, fireAtMillis, title, body, exact, "past")
    }

    ensureChannel(context)
    val alarmManager = context.getSystemService(AlarmManager::class.java)
      ?: throw IllegalStateException("AlarmManager is unavailable")
    val pendingIntent = alarmPendingIntent(context, reminderId)
    var mode = if (exact && canScheduleExact(alarmManager)) "exact" else "inexact"

    try {
      if (mode == "exact") {
        alarmManager.setExactAndAllowWhileIdle(
          AlarmManager.RTC_WAKEUP,
          fireAtMillis,
          pendingIntent,
        )
      } else {
        alarmManager.setAndAllowWhileIdle(
          AlarmManager.RTC_WAKEUP,
          fireAtMillis,
          pendingIntent,
        )
      }
    } catch (_: SecurityException) {
      // API 31+ may revoke exact-alarm access after it was checked. The
      // fallback is intentionally inexact and visible in the returned mode.
      mode = "inexact"
      alarmManager.setAndAllowWhileIdle(
        AlarmManager.RTC_WAKEUP,
        fireAtMillis,
        pendingIntent,
      )
    }

    val stored = StoredReminder(
      reminderId = reminderId,
      fireAtUtc = fireAtUtc,
      fireAtMillis = fireAtMillis,
      title = title,
      body = body,
      exact = exact && mode == "exact",
      mode = mode,
    )
    ReminderStorage.upsert(context, stored)
    return stored
  }

  fun cancel(context: Context, reminderId: String) {
    cancelAlarm(context, reminderId)
    ReminderStorage.remove(context, reminderId)
    val manager = context.getSystemService(NotificationManager::class.java)
    manager?.cancel(notificationId(reminderId))
  }

  fun pending(context: Context): List<StoredReminder> {
    val now = System.currentTimeMillis()
    val all = ReminderStorage.all(context)
    val future = all.filter { it.fireAtMillis > now }
    if (future.size != all.size) {
      ReminderStorage.save(context, future)
    }
    return future
  }

  fun rescheduleAll(context: Context): Int {
    val future = pending(context)
    val rearmed = mutableListOf<StoredReminder>()
    for (item in future) {
      // Cancel first so an OEM AlarmManager does not keep a duplicate.
      cancelAlarm(context, item.reminderId)
      try {
        val scheduled = schedule(
          context = context,
          reminderId = item.reminderId,
          fireAtUtc = item.fireAtUtc,
          title = item.title,
          body = item.body,
          exact = item.exact,
        )
        if (scheduled.mode != "past") rearmed.add(scheduled)
      } catch (_: Exception) {
        // Keep the app launchable even if one stale record is malformed.
      }
    }
    ReminderStorage.save(context, rearmed)
    return rearmed.size
  }

  fun clear(context: Context) {
    for (item in ReminderStorage.all(context)) {
      cancelAlarm(context, item.reminderId)
    }
    ReminderStorage.clear(context)
    context.getSystemService(NotificationManager::class.java)?.cancelAll()
  }

  fun showNotification(
    context: Context,
    reminderId: String,
    title: String,
    body: String,
  ) {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
      context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) !=
      PackageManager.PERMISSION_GRANTED
    ) {
      return
    }
    val manager = context.getSystemService(NotificationManager::class.java) ?: return
    ensureChannel(context)

    val launchIntent = context.packageManager.getLaunchIntentForPackage(context.packageName)
    val contentIntent = launchIntent?.let {
      PendingIntent.getActivity(
        context,
        notificationId(reminderId),
        it,
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
      )
    }

    val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      Notification.Builder(context, CHANNEL_ID)
    } else {
      @Suppress("DEPRECATION")
      Notification.Builder(context)
    }
    val smallIcon = context.applicationInfo.icon.takeIf { it != 0 }
      ?: android.R.drawable.ic_dialog_info
    builder
      .setSmallIcon(smallIcon)
      .setContentTitle(title.ifBlank { "拾事提醒" })
      .setContentText(body.ifBlank { "该完成这项任务了" })
      .setStyle(
        Notification.BigTextStyle().bigText(
          body.ifBlank { "该完成这项任务了" },
        ),
      )
      .setAutoCancel(true)
      .setCategory(Notification.CATEGORY_REMINDER)
      .setWhen(System.currentTimeMillis())
      .setShowWhen(true)
    if (contentIntent != null) {
      builder.setContentIntent(contentIntent)
    }
    @Suppress("DEPRECATION")
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
      builder.setPriority(Notification.PRIORITY_HIGH)
    }
    manager.notify(notificationId(reminderId), builder.build())
  }

  private fun alarmPendingIntent(context: Context, reminderId: String): PendingIntent {
    val intent = Intent(context, ReminderAlarmReceiver::class.java).apply {
      action = ACTION_FIRE
      data = Uri.parse("shishi-reminder://${Uri.encode(reminderId)}")
      putExtra(EXTRA_REMINDER_ID, reminderId)
    }
    return PendingIntent.getBroadcast(
      context,
      requestCode(reminderId),
      intent,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
  }

  private fun cancelAlarm(context: Context, reminderId: String) {
    val manager = context.getSystemService(AlarmManager::class.java) ?: return
    val intent = Intent(context, ReminderAlarmReceiver::class.java).apply {
      action = ACTION_FIRE
      data = Uri.parse("shishi-reminder://${Uri.encode(reminderId)}")
    }
    val pendingIntent = PendingIntent.getBroadcast(
      context,
      requestCode(reminderId),
      intent,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
    manager.cancel(pendingIntent)
    pendingIntent.cancel()
  }

  private fun canScheduleExact(manager: AlarmManager): Boolean =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      manager.canScheduleExactAlarms()
    } else {
      true
    }

  private fun requestCode(reminderId: String): Int = reminderId.hashCode() and 0x7fffffff

  private fun notificationId(reminderId: String): Int = requestCode(reminderId)

  private fun parseInstant(value: String): Long? {
    val patterns = arrayOf(
      "yyyy-MM-dd'T'HH:mm:ss.SSSXXX",
      "yyyy-MM-dd'T'HH:mm:ssXXX",
      "yyyy-MM-dd'T'HH:mm:ss.SSS'Z'",
      "yyyy-MM-dd'T'HH:mm:ss'Z'",
    )
    for (pattern in patterns) {
      try {
        val format = SimpleDateFormat(pattern, Locale.US).apply {
          isLenient = false
          timeZone = TimeZone.getTimeZone("UTC")
        }
        return format.parse(value)?.time
      } catch (_: Exception) {
        // Try the next accepted absolute-time representation.
      }
    }
    return null
  }
}
