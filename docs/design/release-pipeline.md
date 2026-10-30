# Release Pipeline — cc-switch inspired dev releases

Reference: [farion1231/cc-switch](https://github.com/farion1231/cc-switch)
`.github/workflows/release.yml` (inspected at `main` during RC2-D.10).

## Adopted patterns

- Build each platform/architecture in its own GitHub Actions job.
- Keep artifacts named with product, version and architecture:
  - `Shishi-<version>-macos-arm64.dmg`
  - `Shishi-<version>-macos-x64.dmg`
  - `Shishi_<version>_x64-setup.exe`
  - `Shishi-<version>-android-<abi>-debug.apk|aab`
- Verify the built architecture before publishing:
  - macOS: mount DMG, `lipo -archs` the app binary;
  - Android: inspect `lib/<abi>/` in every split APK/AAB.
- Publish with `softprops/action-gh-release`, not ad-hoc shell release
  mutation, so an existing pre-release can be updated idempotently.
- Use one release job after all build jobs; never publish a partial release.
- Generate `SHA256SUMS.txt` for all release files and per-DMG checksums.
- Keep a human-readable release body with direct download names.
- Use `concurrency` so a retag cannot race another release run.
- Dev tags intentionally use `*-dev.*` without a `v` prefix so production
  `v*` workflows are not triggered.

## Deliberately not adopted (no credentials/scope)

- Apple Developer ID signing and notarization (cc-switch imports
  `APPLE_CERTIFICATE`, notarizes and runs `spctl`/`stapler`).
- Windows Authenticode signing (`WINDOWS_CERTIFICATE`).
- Tauri updater signatures and `latest.json` (`TAURI_SIGNING_PRIVATE_KEY`);
  publishing an unsigned `latest.json` would be misleading.
- Linux AppImage/deb/rpm and Windows ARM64 builds are out of scope for the
  current dev release; they can be added as separate matrix entries later.

## Workflow shape

`web` → web ZIP + checksum
`windows` → unsigned NSIS x64
`macos` matrix → arm64 and x64 DMG + per-DMG SHA-256, architecture verified
`android` → debug APK/AAB split per ABI, ABI verified
`release` → download all, normalize Android names, write `SHA256SUMS.txt`,
`softprops/action-gh-release` updates the existing pre-release.
