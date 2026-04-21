# Deployment

## Shared Packages (`@baicie/orbit-*`)

Shared packages are published to npm via GitHub Actions when a version tag is pushed.

```bash
git tag v0.0.1
git push origin v0.0.1
```

This triggers the `Release` workflow which builds and publishes all non-private packages:
- `@baicie/orbit` - Core data model
- `@baicie/orbit-hooks` - React hooks
- `@baicie/orbit-ui` - UI components
- `@baicie/orbit-utils` - Utilities

Note: `@baicie/orbit-tsconfig` is private and not published.

## Web App (Docker)

```bash
cd apps/web
docker build -t orbit-web .
docker run -p 8080:80 orbit-web
```

Or use docker-compose from the root:

```bash
docker-compose up -d --build
```

Web app runs at: http://localhost:8080

## Backend (Docker)

```bash
cd apps/backend
docker build -t orbit-backend .
docker run -p 3001:3001 orbit-backend
```

Backend runs at: http://localhost:3001

## Mobile App (Expo + EAS)

### iOS

```bash
cd apps/mobile
eas build --platform ios --profile production
eas submit --platform ios
```

### Android

```bash
cd apps/mobile
eas build --platform android --profile production
eas submit --platform android
```

Requires `eas.json` configuration. See [EAS Build docs](https://docs.expo.dev/build/introduction/).

## Browser Extension

```bash
cd apps/browser-ext
pnpm build

# Chrome: Load dist/ as unpacked extension
# Firefox: Package with web-ext or upload to AMO
```

## VSCode Extension

```bash
cd apps/vscode-ext
pnpm package
# Upload .vsix to VSCode Marketplace
```

## Desktop App (Tauri)

```bash
cd apps/desktop
pnpm build
# Output in src-tauri/target/release/
```

Build for specific platform:

```bash
cargo build --release --target x86_64-pc-windows-msvc  # Windows
cargo build --release --target x86_64-unknown-linux-gnu  # Linux
cargo build --release --target x86_64-apple-darwin       # macOS
```
