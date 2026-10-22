#!/bin/sh
set -eu
umask 077

: "${PGHOST:?PGHOST is required}"
: "${PGUSER:?PGUSER is required}"
: "${PGDATABASE:?PGDATABASE is required}"

BACKUP_DIR="${BACKUP_DIR:-/backups}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
FILE="$BACKUP_DIR/todo-$STAMP.dump"

mkdir -p "$BACKUP_DIR"
pg_dump \
  --host="$PGHOST" \
  --username="$PGUSER" \
  --dbname="$PGDATABASE" \
  --format=custom \
  --no-owner \
  --no-acl \
  --file="$FILE"

FILE_NAME="$(basename "$FILE")"
(cd "$BACKUP_DIR" && sha256sum "$FILE_NAME" > "$FILE_NAME.sha256")
chmod 600 "$FILE" "$FILE.sha256"

find "$BACKUP_DIR" -type f -name 'todo-*.dump*' -mtime "+$RETENTION_DAYS" -delete
printf 'backup_completed file=%s\n' "$FILE"
