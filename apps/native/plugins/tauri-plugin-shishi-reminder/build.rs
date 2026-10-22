const COMMANDS: &[&str] = &[
    "schedule",
    "cancel",
    "reschedule",
    "list",
    "clear",
    "checkPermission",
    "requestPermission",
    "secureTokenGet",
    "secureTokenSet",
    "secureTokenRemove",
];

fn main() {
    tauri_plugin::Builder::new(COMMANDS)
        .android_path("android")
        .ios_path("ios")
        .try_build()
        .expect("failed to build tauri-plugin-shishi-reminder");
}
