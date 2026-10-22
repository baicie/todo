// swift-tools-version:5.5
import PackageDescription

let package = Package(
  name: "tauri-plugin-shishi-reminder",
  platforms: [
    .iOS(.v13)
  ],
  products: [
    .library(
      name: "tauri-plugin-shishi-reminder",
      type: .static,
      targets: ["tauri-plugin-shishi-reminder"]
    )
  ],
  dependencies: [
    .package(name: "Tauri", path: "../.tauri/tauri-api")
  ],
  targets: [
    .target(
      name: "tauri-plugin-shishi-reminder",
      dependencies: [
        .byName(name: "Tauri")
      ],
      path: "Sources",
      linkerSettings: [
        .linkedFramework("Security")
      ]
    )
  ]
)
