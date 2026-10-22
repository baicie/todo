package app.shishi.todo.reminder

import android.Manifest
import android.app.Activity
import android.app.NotificationManager
import android.os.Build
import android.webkit.WebView
import app.tauri.PermissionState
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.Permission
import app.tauri.annotation.PermissionCallback
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import org.json.JSONObject

private const val NOTIFICATION_PERMISSION_ALIAS = "notifications"

@InvokeArg
class ScheduleArgs {
  lateinit var reminderId: String
  lateinit var fireAtUtc: String
  lateinit var title: String
  var body: String = ""
  var exact: Boolean = false
}

@InvokeArg
class CancelArgs {
  lateinit var reminderId: String
}

@InvokeArg
class SecureTokenKeyArgs {
  lateinit var key: String
}

@InvokeArg
class SecureTokenSetArgs {
  lateinit var key: String
  var value: String = ""
}

@TauriPlugin(
  permissions = [
    Permission(
      strings = [Manifest.permission.POST_NOTIFICATIONS],
      alias = NOTIFICATION_PERMISSION_ALIAS,
    )
  ]
)
class ReminderPlugin(private val activity: Activity) : Plugin(activity) {
  override fun load(webView: WebView) {
    super.load(webView)
    ReminderScheduler.ensureChannel(activity)
    Thread {
      ReminderScheduler.rescheduleAll(activity)
    }.start()
  }

  @Command
  fun schedule(invoke: Invoke) {
    try {
      val args = invoke.parseArgs(ScheduleArgs::class.java)
      val reminder = ReminderScheduler.schedule(
        activity,
        args.reminderId,
        args.fireAtUtc,
        args.title,
        args.body,
        args.exact,
      )
      val result = JSObject()
      result.put("scheduled", reminder.mode != "past")
      result.put("mode", reminder.mode)
      invoke.resolve(result)
    } catch (error: Exception) {
      invoke.reject(error.message ?: "Unable to schedule reminder", error)
    }
  }

  @Command
  fun cancel(invoke: Invoke) {
    try {
      val args = invoke.parseArgs(CancelArgs::class.java)
      ReminderScheduler.cancel(activity, args.reminderId)
      invoke.resolve()
    } catch (error: Exception) {
      invoke.reject(error.message ?: "Unable to cancel reminder", error)
    }
  }

  @Command
  fun reschedule(invoke: Invoke) {
    try {
      val count = ReminderScheduler.rescheduleAll(activity)
      val result = JSObject()
      result.put("count", count)
      invoke.resolve(result)
    } catch (error: Exception) {
      invoke.reject(error.message ?: "Unable to reschedule reminders", error)
    }
  }

  @Command
  fun list(invoke: Invoke) {
    val items = ReminderScheduler.pending(activity).map { reminder ->
      mapOf(
        "reminderId" to reminder.reminderId,
        "fireAtUtc" to reminder.fireAtUtc,
        "title" to reminder.title,
        "body" to reminder.body,
        "exact" to reminder.exact,
        "mode" to reminder.mode,
      )
    }
    invoke.resolveObject(items)
  }

  @Command
  fun clear(invoke: Invoke) {
    ReminderScheduler.clear(activity)
    invoke.resolve()
  }

  @Command
  fun secureTokenGet(invoke: Invoke) {
    try {
      val args = invoke.parseArgs(SecureTokenKeyArgs::class.java)
      val result = JSObject()
      result.put("value", SecureTokenStore.get(activity, args.key) ?: JSONObject.NULL)
      invoke.resolve(result)
    } catch (error: Exception) {
      invoke.reject(error.message ?: "无法读取安全令牌", error)
    }
  }

  @Command
  fun secureTokenSet(invoke: Invoke) {
    try {
      val args = invoke.parseArgs(SecureTokenSetArgs::class.java)
      SecureTokenStore.set(activity, args.key, args.value)
      invoke.resolve()
    } catch (error: Exception) {
      invoke.reject(error.message ?: "无法保存安全令牌", error)
    }
  }

  @Command
  fun secureTokenRemove(invoke: Invoke) {
    try {
      val args = invoke.parseArgs(SecureTokenKeyArgs::class.java)
      SecureTokenStore.remove(activity, args.key)
      invoke.resolve()
    } catch (error: Exception) {
      invoke.reject(error.message ?: "无法清除安全令牌", error)
    }
  }

  @Command
  fun checkPermission(invoke: Invoke) {
    resolvePermission(invoke)
  }

  @Command
  fun requestPermission(invoke: Invoke) {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
      getPermissionState(NOTIFICATION_PERMISSION_ALIAS) != PermissionState.GRANTED
    ) {
      requestPermissionForAlias(NOTIFICATION_PERMISSION_ALIAS, invoke, "permissionCallback")
      return
    }
    resolvePermission(invoke)
  }

  @PermissionCallback
  private fun permissionCallback(invoke: Invoke) {
    resolvePermission(invoke)
  }

  private fun resolvePermission(invoke: Invoke) {
    val result = JSObject()
    result.put("permission", permissionValue())
    invoke.resolve(result)
  }

  private fun permissionValue(): String {
    val manager = activity.getSystemService(NotificationManager::class.java)
    if (manager?.areNotificationsEnabled() != true) {
      return "denied"
    }
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      return when (getPermissionState(NOTIFICATION_PERMISSION_ALIAS)) {
        PermissionState.GRANTED -> "granted"
        PermissionState.DENIED -> "denied"
        PermissionState.PROMPT, PermissionState.PROMPT_WITH_RATIONALE -> "prompt"
        null -> "prompt"
      }
    }
    return "granted"
  }
}
