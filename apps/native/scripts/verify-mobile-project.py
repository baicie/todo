#!/usr/bin/env python3
"""Verify mobile plugin registration after `cargo tauri android/ios init`.

This script is intentionally read-only. Tauri/Gradle merge the plugin's Android
library manifest automatically; generated `gen/` projects must never be
committed. It checks the checked-in plugin sources and the generated project
locations, and prints the remaining manual checks for a real device build.
"""

from __future__ import annotations

import argparse
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

ANDROID_NS = "{http://schemas.android.com/apk/res/android}"
REPO = Path(__file__).resolve().parents[1]
PLUGIN = REPO / "plugins" / "tauri-plugin-shishi-reminder"
TAURI = REPO / "src-tauri"


def verify_android() -> int:
    manifest = PLUGIN / "android" / "src" / "main" / "AndroidManifest.xml"
    if not manifest.exists():
        print(f"FAIL: missing plugin manifest {manifest}")
        return 1
    root = ET.parse(manifest).getroot()
    permissions = {
        node.attrib.get(f"{ANDROID_NS}name", "")
        for node in root.findall("uses-permission")
    }
    required_permissions = {
        "android.permission.POST_NOTIFICATIONS",
        "android.permission.RECEIVE_BOOT_COMPLETED",
        "android.permission.SCHEDULE_EXACT_ALARM",
    }
    missing = required_permissions - permissions
    if missing:
        print("FAIL: plugin manifest missing permissions: " + ", ".join(sorted(missing)))
        return 1
    receivers = {
        node.attrib.get(f"{ANDROID_NS}name", "")
        for app in root.findall("application")
        for node in app.findall("receiver")
    }
    for receiver in (
        "app.shishi.todo.reminder.ReminderAlarmReceiver",
        "app.shishi.todo.reminder.ReminderBootReceiver",
    ):
        if receiver not in receivers:
            print(f"FAIL: plugin manifest missing receiver {receiver}")
            return 1

    token_store = PLUGIN / "android" / "src" / "main" / "java" / "app" / "shishi" / "todo" / "reminder" / "SecureTokenStore.kt"
    plugin = PLUGIN / "android" / "src" / "main" / "java" / "app" / "shishi" / "todo" / "reminder" / "ReminderPlugin.kt"
    if not token_store.exists() or not plugin.exists():
        print("FAIL: missing Android secure-token sources")
        return 1
    token_store_source = token_store.read_text(encoding="utf-8")
    plugin_source = plugin.read_text(encoding="utf-8")
    for marker in ("AndroidKeyStore", "AES/GCM/NoPadding", "setKeySize(256)", "keyAlias"):
        if marker not in token_store_source:
            print(f"FAIL: Android token store missing {marker}")
            return 1
    build_source = (PLUGIN / "build.rs").read_text(encoding="utf-8")
    for command in ("secureTokenGet", "secureTokenSet", "secureTokenRemove"):
        if command not in plugin_source or command not in build_source:
            print(f"FAIL: Android plugin missing {command}")
            return 1
    print("OK: Android sources declare Keystore AES-GCM token commands.")

    generated = TAURI / "gen" / "android" / "app" / "src" / "main" / "AndroidManifest.xml"
    if not generated.exists():
        print(f"NOT READY: run `cargo tauri android init`; expected {generated}")
        return 1
    print("OK: plugin manifest declares notification, boot, exact-alarm permissions and receivers.")
    print(f"OK: generated Android project found at {generated.parent.parent}")
    print("Gradle library-manifest merge supplies the receiver entries; do not duplicate them manually.")
    print("Manual/device checks: minSdk >= 24, notification permission prompt, Doze, reboot,")
    print("exact-alarm settings fallback, OEM battery restrictions, signed release build.")
    return 0


def verify_ios() -> int:
    package = PLUGIN / "ios" / "Package.swift"
    swift = PLUGIN / "ios" / "Sources" / "ReminderPlugin.swift"
    if not package.exists() or not swift.exists():
        print("FAIL: missing iOS plugin sources")
        return 1
    swift_source = swift.read_text(encoding="utf-8")
    if "init_plugin_shishi_reminder" not in swift_source:
        print("FAIL: missing iOS plugin registration symbol")
        return 1
    for marker in (
        "app.shishi.todo.secure-token",
        "kSecClassGenericPassword",
        "secureTokenGet",
        "secureTokenSet",
        "secureTokenRemove",
    ):
        if marker not in swift_source:
            print(f"FAIL: iOS token store missing {marker}")
            return 1
    print("OK: iOS sources declare Security.framework Keychain token commands.")
    generated = TAURI / "gen" / "apple"
    if not generated.exists():
        print(f"NOT READY: run `cargo tauri ios init` (macOS/Xcode); expected {generated}")
        return 1
    print("OK: iOS plugin sources and @_cdecl registration symbol are present.")
    print(f"OK: generated Apple project found at {generated}")
    print("No Info.plist notification usage key or push entitlement is required for local notifications.")
    print("Manual/device checks: Xcode signing, authorization prompt, foreground delegate,")
    print("30-day window, 64 pending cap, background/terminated delivery, reboot, DST/time zone.")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("platform", choices=["android", "ios"])
    args = parser.parse_args()
    return verify_android() if args.platform == "android" else verify_ios()


if __name__ == "__main__":
    sys.exit(main())
