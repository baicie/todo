import Foundation
import Security
import Tauri
import UIKit
import UserNotifications
import WebKit

private let maxPendingNotifications = 64
private let schedulingWindowSeconds: TimeInterval = 30 * 24 * 60 * 60
private let secureTokenService = "app.shishi.todo.secure-token"

struct ScheduleArgs: Decodable {
  let reminderId: String
  let fireAtUtc: String
  let title: String
  let body: String?
  let exact: Bool?
}

struct CancelArgs: Decodable {
  let reminderId: String
}

struct SecureTokenKeyArgs: Decodable {
  let key: String
}

struct SecureTokenSetArgs: Decodable {
  let key: String
  let value: String
}

private enum SecureTokenError: LocalizedError {
  case invalidKey
  case corruptData
  case keychain(OSStatus)

  var errorDescription: String? {
    switch self {
    case .invalidKey:
      return "secure token key 只允许 ASCII 字母、数字和 . _ : -"
    case .corruptData:
      return "安全令牌数据损坏"
    case .keychain(let status):
      let detail = (SecCopyErrorMessageString(status, nil) as String?) ?? "OSStatus \(status)"
      return "Keychain 错误: \(detail)"
    }
  }
}

struct ScheduledReminderResponse: Encodable {
  let reminderId: String
  let fireAtUtc: String
  let title: String
  let body: String
  let exact: Bool
  let mode: String
}

struct RescheduleResponse: Encodable {
  let count: Int
}

final class ShishiNotificationDelegate: NSObject, UNUserNotificationCenterDelegate {
  static let shared = ShishiNotificationDelegate()

  func userNotificationCenter(
    _ center: UNUserNotificationCenter,
    willPresent notification: UNNotification,
    withCompletionHandler completionHandler:
      @escaping (UNNotificationPresentationOptions) -> Void
  ) {
    if #available(iOS 14.0, *) {
      completionHandler([.banner, .sound, .badge])
    } else {
      completionHandler([.alert, .sound, .badge])
    }
  }
}

class ReminderPlugin: Plugin {
  override func load(webview: WKWebView) {
    UNUserNotificationCenter.current().delegate = ShishiNotificationDelegate.shared
  }

  @objc public func schedule(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(ScheduleArgs.self)
    let center = UNUserNotificationCenter.current()

    guard !args.reminderId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
      invoke.reject("reminderId must not be blank")
      return
    }
    guard let fireAt = parseInstant(args.fireAtUtc) else {
      invoke.reject("fireAtUtc is not a valid ISO-8601 instant")
      return
    }

    let interval = fireAt.timeIntervalSinceNow
    if interval <= 0 {
      resolveSchedule(invoke, mode: "past")
      return
    }
    if interval > schedulingWindowSeconds {
      // iOS is deliberately limited to a 30-day pre-scheduling window. The
      // app rebuilds the queue on launch/foreground; skipping here avoids
      // exhausting the 64 pending-request budget with distant reminders.
      resolveSchedule(invoke, mode: "outside-window")
      return
    }

    center.getPendingNotificationRequests { [weak self] requests in
      guard let self = self else { return }
      let alreadyScheduled = requests.contains { $0.identifier == args.reminderId }
      if !alreadyScheduled && requests.count >= maxPendingNotifications {
        invoke.reject(
          "iOS pending notification limit reached (maximum \(maxPendingNotifications)); " +
            "call reschedule_reminders after clearing older reminders"
        )
        return
      }

      center.removePendingNotificationRequests(withIdentifiers: [args.reminderId])
      let content = UNMutableNotificationContent()
      content.title = args.title.isEmpty ? "拾事提醒" : args.title
      content.body = (args.body?.isEmpty == false)
        ? args.body!
        : "该完成这项任务了"
      content.sound = .default
      content.badge = nil
      content.threadIdentifier = "shishi-reminders"
      content.userInfo = [
        "reminderId": args.reminderId,
        "fireAtUtc": args.fireAtUtc,
        "exact": args.exact ?? false,
        "mode": "scheduled",
      ]

      let trigger = UNTimeIntervalNotificationTrigger(
        timeInterval: max(1, interval),
        repeats: false
      )
      let request = UNNotificationRequest(
        identifier: args.reminderId,
        content: content,
        trigger: trigger
      )
      center.add(request) { error in
        if let error = error {
          invoke.reject("Unable to schedule iOS reminder: \(error.localizedDescription)")
          return
        }
        self.resolveSchedule(invoke, mode: "scheduled")
      }
    }
  }

  @objc public func cancel(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(CancelArgs.self)
    let center = UNUserNotificationCenter.current()
    center.removePendingNotificationRequests(withIdentifiers: [args.reminderId])
    center.removeDeliveredNotifications(withIdentifiers: [args.reminderId])
    invoke.resolve()
  }

  @objc public func reschedule(_ invoke: Invoke) {
    let center = UNUserNotificationCenter.current()
    center.getPendingNotificationRequests { requests in
      let stale = requests.filter { request in
        guard let trigger = request.trigger as? UNTimeIntervalNotificationTrigger,
          let next = trigger.nextTriggerDate()
        else {
          return false
        }
        return next <= Date()
      }
      center.removePendingNotificationRequests(withIdentifiers: stale.map(\.identifier))
      let count = requests.count - stale.count
      invoke.resolve(RescheduleResponse(count: count))
    }
  }

  @objc public func list(_ invoke: Invoke) {
    UNUserNotificationCenter.current().getPendingNotificationRequests { requests in
      let items: [ScheduledReminderResponse] = requests.compactMap { request in
        guard let reminderId = request.content.userInfo["reminderId"] as? String,
          let fireAtUtc = request.content.userInfo["fireAtUtc"] as? String
        else {
          return nil
        }
        return ScheduledReminderResponse(
          reminderId: reminderId,
          fireAtUtc: fireAtUtc,
          title: request.content.title,
          body: request.content.body,
          exact: request.content.userInfo["exact"] as? Bool ?? false,
          mode: "scheduled"
        )
      }
      invoke.resolve(items)
    }
  }

  @objc public func clear(_ invoke: Invoke) {
    let center = UNUserNotificationCenter.current()
    center.removeAllPendingNotificationRequests()
    center.removeAllDeliveredNotifications()
    invoke.resolve()
  }

  @objc public func secureTokenGet(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(SecureTokenKeyArgs.self)
    do {
      let value = try readSecureToken(args.key)
      var response: JsonObject = [:]
      if let value = value {
        response["value"] = value
      } else {
        response["value"] = NSNull()
      }
      invoke.resolve(response)
    } catch {
      invoke.reject("无法读取安全令牌: \(error.localizedDescription)")
    }
  }

  @objc public func secureTokenSet(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(SecureTokenSetArgs.self)
    do {
      try writeSecureToken(args.key, value: args.value)
      invoke.resolve()
    } catch {
      invoke.reject("无法保存安全令牌: \(error.localizedDescription)")
    }
  }

  @objc public func secureTokenRemove(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(SecureTokenKeyArgs.self)
    do {
      try removeSecureToken(args.key)
      invoke.resolve()
    } catch {
      invoke.reject("无法清除安全令牌: \(error.localizedDescription)")
    }
  }

  @objc public func checkPermission(_ invoke: Invoke) {
    resolvePermission(invoke)
  }

  @objc public func requestPermission(_ invoke: Invoke) {
    UNUserNotificationCenter.current().requestAuthorization(
      options: [.alert, .sound, .badge]
    ) { _, error in
      if let error = error {
        invoke.reject("Unable to request notification permission: \(error.localizedDescription)")
        return
      }
      self.resolvePermission(invoke)
    }
  }

  private func resolvePermission(_ invoke: Invoke) {
    UNUserNotificationCenter.current().getNotificationSettings { settings in
      let permission: String
      switch settings.authorizationStatus {
      case .authorized, .provisional, .ephemeral:
        permission = "granted"
      case .denied:
        permission = "denied"
      case .notDetermined:
        permission = "prompt"
      @unknown default:
        permission = "prompt"
      }
      invoke.resolve(["permission": permission])
    }
  }

  private func resolveSchedule(_ invoke: Invoke, mode: String) {
    let response: JsonObject = [
      "scheduled": mode == "scheduled",
      "mode": mode,
    ]
    invoke.resolve(response)
  }

  private func secureTokenQuery(_ key: String) -> [String: Any] {
    return [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: secureTokenService,
      kSecAttrAccount as String: key,
    ]
  }

  private func validateSecureTokenKey(_ key: String) throws {
    let allowed = CharacterSet(
      charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._:-"
    )
    if key.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
      || key.count > 256
      || key.unicodeScalars.contains(where: { !allowed.contains($0) })
    {
      throw SecureTokenError.invalidKey
    }
  }

  private func readSecureToken(_ key: String) throws -> String? {
    try validateSecureTokenKey(key)
    var query = secureTokenQuery(key)
    query[kSecReturnData as String] = true
    query[kSecMatchLimit as String] = kSecMatchLimitOne
    var item: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &item)
    if status == errSecItemNotFound {
      return nil
    }
    guard status == errSecSuccess else {
      throw SecureTokenError.keychain(status)
    }
    guard let data = item as? Data,
      let value = String(data: data, encoding: .utf8)
    else {
      throw SecureTokenError.corruptData
    }
    return value
  }

  private func writeSecureToken(_ key: String, value: String) throws {
    try validateSecureTokenKey(key)
    let data = Data(value.utf8)
    let query = secureTokenQuery(key)
    let update: [String: Any] = [kSecValueData as String: data]
    let status = SecItemUpdate(query as CFDictionary, update as CFDictionary)
    if status == errSecItemNotFound {
      var add = query
      add[kSecValueData as String] = data
      add[kSecAttrAccessible as String] =
        kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
      let addStatus = SecItemAdd(add as CFDictionary, nil)
      guard addStatus == errSecSuccess else {
        throw SecureTokenError.keychain(addStatus)
      }
      return
    }
    guard status == errSecSuccess else {
      throw SecureTokenError.keychain(status)
    }
  }

  private func removeSecureToken(_ key: String) throws {
    try validateSecureTokenKey(key)
    let status = SecItemDelete(secureTokenQuery(key) as CFDictionary)
    if status != errSecSuccess && status != errSecItemNotFound {
      throw SecureTokenError.keychain(status)
    }
  }

  private func parseInstant(_ value: String) -> Date? {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    if let date = formatter.date(from: value) {
      return date
    }
    formatter.formatOptions = [.withInternetDateTime]
    return formatter.date(from: value)
  }
}

@_cdecl("init_plugin_shishi_reminder")
public func initPlugin() -> Plugin {
  return ReminderPlugin()
}
