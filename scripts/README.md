# Browser QA scripts

These scripts are optional smoke checks against a running production preview. They are
not part of the application bundle.

```bash
pnpm --filter @todo/app build
pnpm --filter @todo/app preview --host 127.0.0.1 --port 4173

# In another shell
$env:APP_URL = 'http://127.0.0.1:4173'
node scripts/e2e-check.mjs
node scripts/flow-check.mjs
node scripts/offline-check.mjs
node scripts/visual-check.mjs
```

They use the installed Google Chrome through `playwright-core`. If Chrome is installed
elsewhere, adjust `executablePath` at the top of each script. Screenshots are written
to `artifacts/`, which is git-ignored.
