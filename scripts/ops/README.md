# Operations scripts

These scripts are intended for the optional Compose `ops` profile or a controlled
maintenance host. They never print database passwords, tokens, or task data.

- `backup.sh` creates a PostgreSQL custom-format dump and SHA-256 checksum in
  `/backups` (or `BACKUP_DIR`), then prunes files older than
  `BACKUP_RETENTION_DAYS`.
- `restore.sh` requires `RESTORE_CONFIRM=YES` and a checksum-verified dump. It is
  destructive and must be run only after stopping API traffic.

See `docs/runbooks/operations.md` and `docs/runbooks/backup-restore.md`.

The protected maintenance CLI is part of the API image:

```bash
docker compose --profile ops run --rm ops ops all --dry-run
```
