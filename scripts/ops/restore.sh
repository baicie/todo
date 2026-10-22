#!/bin/sh
set -eu

if [ "${RESTORE_CONFIRM:-}" != "YES" ]; then
  printf '%s\n' "Refusing to restore without RESTORE_CONFIRM=YES." >&2
  printf '%s\n' "Stop the API first, take a fresh backup, and verify the target database." >&2
  exit 2
fi

if [ "$#" -ne 1 ]; then
  printf 'Usage: RESTORE_CONFIRM=YES %s /backups/todo-YYYYMMDDTHHMMSSZ.dump\n' "$0" >&2
  exit 2
fi

DUMP="$1"
if [ ! -f "$DUMP" ]; then
  printf 'Backup file not found: %s\n' "$DUMP" >&2
  exit 2
fi
if [ ! -f "$DUMP.sha256" ]; then
  printf 'Checksum file not found: %s.sha256\n' "$DUMP" >&2
  exit 2
fi
(cd "$(dirname "$DUMP")" && sha256sum -c "$(basename "$DUMP").sha256")

: "${PGHOST:?PGHOST is required}"
: "${PGUSER:?PGUSER is required}"
: "${PGDATABASE:?PGDATABASE is required}"

pg_restore \
  --host="$PGHOST" \
  --username="$PGUSER" \
  --dbname="$PGDATABASE" \
  --clean \
  --if-exists \
  --no-owner \
  --no-acl \
  --single-transaction \
  "$DUMP"

printf '%s\n' "restore_completed"
