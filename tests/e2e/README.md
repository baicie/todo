# Browser / PWA / accessibility tests

Self-contained Playwright project for the production web build. It is a nested
pnpm workspace (`tests/e2e/pnpm-workspace.yaml`) and is intentionally **not** a
member of the root workspace, so Playwright and axe-core never enter the app's
dependency graph or lockfile.

## First-time setup

```bash
pnpm --dir tests/e2e install
pnpm --dir tests/e2e exec playwright install chromium
pnpm --filter @todo/app build
```

## Run

```bash
# Starts `vite preview` on http://127.0.0.1:4173 automatically.
pnpm --dir tests/e2e test

# Or point at an already-running production preview. When APP_URL is set, the
# config will not start its own server.
$env:APP_URL = 'https://preview.example.com'
pnpm --dir tests/e2e test

# Focused runs.
pnpm --dir tests/e2e test:functional
pnpm --dir tests/e2e test:pwa
pnpm --dir tests/e2e test:a11y
```

The config always expects a **production** build: `App.tsx` registers `/sw.js`
only when `import.meta.env.PROD`, so the PWA test will fail against `vite dev`.
The preview server is started with `--strictPort`; stop any process already
bound to port 4173 before a CI-style run.

## Coverage

| File                          | What it checks                                                                                                           |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `tests/app.spec.ts`           | Desktop my-day/add/complete/search/settings/export, mobile add/detail/bottom nav, no horizontal overflow at 390/768/1440 |
| `tests/keyboard.spec.ts`      | `Ctrl/⌘+K`, `Ctrl/⌘+N`, `Space`, `Escape`, modal focus trap and focus restoration                                        |
| `tests/pwa.spec.ts`           | Manifest metadata; service worker activation/control; online → offline reload; local tasks and offline edits survive     |
| `tests/accessibility.spec.ts` | Landmarks, accessible names, theme radiogroup, axe WCAG A/AA scans in light/dark/mobile/detail/settings                  |

No fixed sleeps are used for readiness. Assertions that depend on async loading
or layout transitions use Playwright/expect polling (`expect.poll`, `toHaveCount`,
`waitForFunction`). Search intentionally waits for the app's own 120 ms debounce
by observing the rendered result.

## Interpreting failures

- A new axe rule ID outside `KNOWN_AXE_RULES` fails `accessibility.spec.ts`.
  Known issues are documented in [`docs/accessibility.md`](../../docs/accessibility.md).
- Layout overflow is allowed a 1px sub-pixel tolerance and is polled for up to
  3 seconds to let the detail-column transition settle.
- PWA tests leave the service worker in place inside their own browser context;
  contexts are isolated, so tests do not leak registrations into each other.

## CI

`.github/workflows/browser.yml` runs the same commands on Ubuntu with Chromium.
The Axum API is not started because the web build is local-only unless
`VITE_API_URL` is configured; API tests run in `.github/workflows/api.yml`.
