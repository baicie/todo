# Operations scripts

These scripts are intended for the optional Compose `ops` profile or a controlled
maintenance host. They never print database passwords, tokens, or task data.

- `backup.sh` creates a PostgreSQL custom-format dump and SHA-256 checksum in
  `/backups` (or `BACKUP_DIR`), then prunes files older than
  `BACKUP_RETENTION_DAYS`.
- `restore.sh` requires `RESTORE_CONFIRM=YES` and a checksum-verified dump. It is
  destructive and must be run only after stopping API traffic.
- `backup-restore-test.sh` is the automated drill for the two scripts above. It
  migrates a throwaway database through the API, inserts a golden dataset, runs
  `backup.sh`, checks that `restore.sh` refuses an unconfirmed or tampered dump,
  restores into an empty database and over a modified one, and compares every
  table with the pre-backup state. It also starts the API and runs
  `ops all --dry-run` against the restored data. It only creates and drops a
  database named `todo_backup_test_<random>` (or a Compose project of the same
  shape with `--compose`):

  ```bash
  scripts/ops/backup-restore-test.sh --compose
  PGHOST=127.0.0.1 PGPORT=5432 PGUSER=todo PGPASSWORD=todo scripts/ops/backup-restore-test.sh
  ```

  The second form needs a role with `CREATEDB` and PostgreSQL client tools at
  least as new as the server. CI runs the `--compose` form in the
  `backup-restore` job of `.github/workflows/api.yml`.

See `docs/runbooks/operations.md` and `docs/runbooks/backup-restore.md`.

The protected maintenance CLI is part of the API image:

```bash
docker compose --profile ops run --rm ops ops all --dry-run
```
