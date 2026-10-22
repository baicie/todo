package app.shishi.todo.reminder

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject

data class StoredReminder(
  val reminderId: String,
  val fireAtUtc: String,
  val fireAtMillis: Long,
  val title: String,
  val body: String,
  val exact: Boolean,
  val mode: String,
)

/**
 * Small local queue used by BOOT_COMPLETED recovery. It deliberately lives in
 * SharedPreferences rather than the app's SQLite database because a boot
 * receiver must be able to reschedule alarms before the WebView/SQLite app is
 * running. The authoritative task data remains in SQLite.
 */
object ReminderStorage {
  private const val PREFERENCES = "shishi_system_reminders"
  private const val KEY_PENDING = "pending"

  private fun prefs(context: Context) =
    context.applicationContext.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)

  @Synchronized
  fun all(context: Context): List<StoredReminder> {
    val raw = prefs(context).getString(KEY_PENDING, null) ?: return emptyList()
    return try {
      val array = JSONArray(raw)
      buildList {
        for (index in 0 until array.length()) {
          val item = array.optJSONObject(index) ?: continue
          val id = item.optString("reminderId")
          if (id.isBlank()) continue
          add(
            StoredReminder(
              reminderId = id,
              fireAtUtc = item.optString("fireAtUtc"),
              fireAtMillis = item.optLong("fireAtMillis"),
              title = item.optString("title"),
              body = item.optString("body"),
              exact = item.optBoolean("exact", false),
              mode = item.optString("mode", "inexact"),
            )
          )
        }
      }
    } catch (_: Exception) {
      emptyList()
    }
  }

  @Synchronized
  fun save(context: Context, reminders: List<StoredReminder>) {
    val array = JSONArray()
    for (item in reminders) {
      array.put(
        JSONObject().apply {
          put("reminderId", item.reminderId)
          put("fireAtUtc", item.fireAtUtc)
          put("fireAtMillis", item.fireAtMillis)
          put("title", item.title)
          put("body", item.body)
          put("exact", item.exact)
          put("mode", item.mode)
        }
      )
    }
    prefs(context).edit().putString(KEY_PENDING, array.toString()).commit()
  }

  @Synchronized
  fun upsert(context: Context, reminder: StoredReminder) {
    val next = all(context).filterNot { it.reminderId == reminder.reminderId }.toMutableList()
    next.add(reminder)
    save(context, next)
  }

  @Synchronized
  fun remove(context: Context, reminderId: String) {
    save(context, all(context).filterNot { it.reminderId == reminderId })
  }

  @Synchronized
  fun clear(context: Context) {
    prefs(context).edit().remove(KEY_PENDING).commit()
  }
}
