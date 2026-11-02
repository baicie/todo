#!/usr/bin/env bash
# Backup/restore drill (docs/roadmap-v2/05-quality.md §4).
#
# 1. Start a temporary PostgreSQL (--compose) or create a temporary database on
#    an existing server (default).
# 2. Start the API once so its migrator brings the schema to the latest version.
# 3. Insert a golden dataset.
# 4. backup.sh writes a dump and checksum.
# 5. restore.sh must refuse without RESTORE_CONFIRM=YES and refuse a tampered
#    dump; then the database is dropped, recreated empty and restored.
# 6. Every table must match the pre-backup fingerprint, golden row counts must
#    match, the API must report ready and `ops all --dry-run` must pass.
#    A second restore over a modified database must also return to the backup.
# 7. Shared collaboration data is exercised through the real API against the
#    restored database: the list revision and tasks, an active member's access,
#    a removed member staying revoked, op-receipt replay by its own actor and
#    by another actor, and a new invite/accept round trip. Row counts alone
#    cannot prove those decisions survived.
# 8. The temporary database, Compose project and volume are removed on exit.
#
# The browser's unsent shared-list outbox is NOT covered here and cannot be:
# it lives in the user's IndexedDB, a separate persistence boundary from
# PostgreSQL. A database backup restores the server's copy only; unsent local
# edits still exist solely on the device that made them.
#
# Usage:
#   scripts/ops/backup-restore-test.sh --compose
#       Uses Docker Compose's postgres service under a throwaway project name.
#   PGHOST=127.0.0.1 PGPORT=5432 PGUSER=todo PGPASSWORD=todo \
#     scripts/ops/backup-restore-test.sh
#       Uses an existing server. The role needs CREATEDB. Only a database named
#       todo_backup_test_<random> is created and dropped.
#
# Environment: TODO_API_BIN skips the cargo build, BACKUP_TEST_API_PORT sets the
# API port (default 18787) and BACKUP_TEST_PG_PORT the Compose server port
# (default 55433).
#
# Needs psql, pg_dump, pg_restore, createdb, dropdb, sha256sum, curl and cargo
# (or TODO_API_BIN pointing at a built todo-api binary). The client tools and
# the server must be the same major version: pg_dump from a newer major writes
# settings (for example SET transaction_timeout, added in PostgreSQL 17) that
# an older server rejects, so the drill refuses such a pair up front instead of
# failing later with a restore error that looks like a backup problem.
set -euo pipefail
umask 077

usage() {
  # Everything between the shebang and the first command is the usage text.
  awk 'NR > 1 && /^set -euo pipefail/ { exit } NR > 1' "$0" |
    sed 's/^# \{0,1\}//'
}

MODE=server
case "${1:-}" in
  '') ;;
  --compose) MODE=compose ;;
  -h | --help)
    usage
    exit 0
    ;;
  *)
    usage >&2
    exit 2
    ;;
esac

SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(CDPATH='' cd -- "$SCRIPT_DIR/../.." && pwd)
SUFFIX=$(od -An -N6 -tx1 /dev/urandom | tr -d ' \n')
TEST_DB="todo_backup_test_$SUFFIX"
WORK_DIR=$(mktemp -d)
BACKUP_DIR="$WORK_DIR/backups"
API_PORT="${BACKUP_TEST_API_PORT:-18787}"
API_PID=''
COMPOSE_PROJECT=''
DB_CREATED=0

# Deterministic text output from every psql session, independent of the
# console code page (Windows) and the server's default time zone.
export PGCLIENTENCODING=UTF8 PGTZ=UTC

log() { printf 'backup-restore-test: %s\n' "$*"; }
fail() {
  printf 'backup-restore-test: FAIL: %s\n' "$*" >&2
  exit 1
}

stop_api() {
  if [ -n "$API_PID" ]; then
    kill "$API_PID" 2>/dev/null || true
    wait "$API_PID" 2>/dev/null || true
    API_PID=''
  fi
}

cleanup() {
  local status=$?
  set +e
  stop_api
  if [ "$DB_CREATED" = 1 ]; then
    dropdb --maintenance-db=postgres --if-exists --force "$TEST_DB" >/dev/null 2>&1
  fi
  if [ -n "$COMPOSE_PROJECT" ]; then
    (cd "$REPO_ROOT" && docker compose -p "$COMPOSE_PROJECT" down -v --remove-orphans) >/dev/null 2>&1
  fi
  rm -rf "$WORK_DIR"
  if [ "$status" = 0 ]; then
    log PASS
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

for tool in psql pg_dump pg_restore createdb dropdb sha256sum curl; do
  command -v "$tool" >/dev/null || fail "$tool is not installed"
done
log "client $(pg_dump --version)"

# The client tools and the server must be the same major version. A dump from a
# newer client carries settings that an older server rejects on restore (since
# PostgreSQL 17, pg_dump writes `SET transaction_timeout`), and pg_dump is not
# guaranteed to work against a newer server either. A mismatch would otherwise
# surface as a restore error and look like a broken backup. In server mode the
# check runs before anything is created, so a mismatch leaves no database
# behind; in Compose mode it runs once the container is up.
check_client_server_versions() {
  local server_version_num server_major tool client_version client_major
  server_version_num=$(psql -X -q -At -v ON_ERROR_STOP=1 -d postgres -c 'SHOW server_version_num') ||
    fail "cannot read the server version from $PGHOST:$PGPORT"
  case "$server_version_num" in
    '' | *[!0-9]*) fail "unexpected server_version_num '$server_version_num'" ;;
  esac
  server_major=$((server_version_num / 10000))
  log "server PostgreSQL major $server_major"
  for tool in psql pg_dump pg_restore; do
    client_version=$("$tool" --version)
    client_major=$(printf '%s\n' "$client_version" |
      sed -n 's/^[a-z_]* (PostgreSQL) \([0-9][0-9]*\).*/\1/p')
    [ -n "$client_major" ] || fail "cannot parse the major version from '$client_version'"
    if [ "$client_major" -gt "$server_major" ]; then
      fail "$client_version is newer than the server (major $server_major): a dump from a newer client sets options (for example transaction_timeout, added in PostgreSQL 17) that an older server rejects on restore. Use client tools of major $server_major (Debian/Ubuntu: postgresql-client-$server_major) or a server of major $client_major."
    fi
    if [ "$client_major" -lt "$server_major" ]; then
      fail "$client_version is older than the server (major $server_major): pg_dump does not support servers newer than itself. Use client tools of major $server_major (Debian/Ubuntu: postgresql-client-$server_major)."
    fi
  done
}

if [ "$MODE" = compose ]; then
  COMPOSE_PROJECT="todo-backup-test-$SUFFIX"
  # Pin credentials so a local .env cannot change them; the project name gives
  # the container and its volume names of their own.
  export POSTGRES_USER=todo POSTGRES_PASSWORD=todo POSTGRES_DB=todo
  export POSTGRES_PORT="${BACKUP_TEST_PG_PORT:-55433}"
  log "starting temporary PostgreSQL (compose project $COMPOSE_PROJECT, port $POSTGRES_PORT)"
  (cd "$REPO_ROOT" && docker compose -p "$COMPOSE_PROJECT" up -d --wait postgres)
  export PGHOST=127.0.0.1 PGPORT="$POSTGRES_PORT" PGUSER=todo PGPASSWORD=todo
  check_client_server_versions
else
  : "${PGHOST:?PGHOST is required (or pass --compose)}"
  : "${PGUSER:?PGUSER is required (or pass --compose)}"
  export PGPORT="${PGPORT:-5432}"
  check_client_server_versions
fi

psql_db() {
  # Windows psql writes CRLF; strip it so output compares and splits cleanly.
  psql -X -q -v ON_ERROR_STOP=1 -d "$TEST_DB" "$@" | tr -d '\r'
}

if [ -n "${TODO_API_BIN:-}" ]; then
  API_BIN="$TODO_API_BIN"
else
  log "building todo-api"
  (cd "$REPO_ROOT" && cargo build --quiet -p todo-api)
  API_BIN="${CARGO_TARGET_DIR:-$REPO_ROOT/target}/debug/todo-api"
  [ -f "$API_BIN" ] || API_BIN="$API_BIN.exe"
fi
[ -f "$API_BIN" ] || fail "todo-api binary not found at $API_BIN"

# The API reads its configuration from the environment. The values are exported
# instead of passed through `env`, so `$!` is the API process itself: on Git
# Bash, killing an `env` wrapper leaves the native child running. PGPASSWORD is
# read by sqlx when the URL has no password, so passwords never need URL
# encoding.
export DATABASE_URL="postgres://$PGUSER@$PGHOST:$PGPORT/$TEST_DB" \
  APP_ENV=test \
  JWT_SECRET=backup-restore-test-only-jwt-secret-0123456789 \
  OPS_ADMIN_TOKEN=backup-restore-test-only-ops-token-0123456789 \
  BIND_ADDR="127.0.0.1:$API_PORT" \
  CORS_ORIGINS=http://localhost:5173 \
  RUST_LOG=warn

start_api_until_ready() {
  if curl -fsS "http://127.0.0.1:$API_PORT/healthz" >/dev/null 2>&1; then
    fail "port $API_PORT is already in use; set BACKUP_TEST_API_PORT"
  fi
  "$API_BIN" >"$WORK_DIR/api.log" 2>&1 &
  API_PID=$!
  local attempt
  for attempt in $(seq 1 60); do
    if curl -fsS "http://127.0.0.1:$API_PORT/readyz" >/dev/null 2>&1; then
      return 0
    fi
    if ! kill -0 "$API_PID" 2>/dev/null; then
      cat "$WORK_DIR/api.log" >&2
      fail "the API exited before it became ready"
    fi
    sleep 1
  done
  cat "$WORK_DIR/api.log" >&2
  fail "the API did not become ready within 60 seconds (attempt $attempt)"
}

# One line per public table: name, row count and a hash of every row's text.
fingerprint() {
  local table
  for table in $(psql_db -At -c \
    "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename"); do
    psql_db -At -c "SELECT '$table', count(*), \
      coalesce(md5(string_agg(row_text, E'\\n' ORDER BY row_text)), '-') \
      FROM (SELECT t::text AS row_text FROM public.\"$table\" t) rows"
  done
}

expect_same_fingerprint() {
  local context=$1 expected=$2 actual
  actual=$(fingerprint)
  if [ "$actual" != "$expected" ]; then
    diff <(printf '%s\n' "$expected") <(printf '%s\n' "$actual") >&2 || true
    fail "$context: database content differs from the backup"
  fi
}

log "creating database $TEST_DB on $PGHOST:$PGPORT"
createdb --maintenance-db=postgres "$TEST_DB"
DB_CREATED=1
export PGDATABASE="$TEST_DB"

log "applying migrations through the API"
start_api_until_ready
stop_api

log "inserting golden dataset"
psql_db <<'SQL'
BEGIN;
INSERT INTO users (id, email_normalized, preferred_timezone, deleted_at) VALUES
  ('00000000-0000-4000-8000-000000000001', 'golden-owner@example.com', 'Asia/Shanghai', NULL),
  ('00000000-0000-4000-8000-000000000002', 'golden-member@example.com', 'Europe/Berlin', NULL),
  ('00000000-0000-4000-8000-000000000003', 'golden-deleted@example.com', 'UTC',
   '2026-10-30T00:00:00Z'),
  ('00000000-0000-4000-8000-000000000004', 'golden-removed@example.com', 'UTC', NULL);
INSERT INTO account_sync_state (user_id, next_server_seq, min_available_seq)
  VALUES ('00000000-0000-4000-8000-000000000001', 4, 0);
INSERT INTO devices (id, user_id, name, platform, last_client_seq, last_seen_at) VALUES
  ('00000000-0000-4000-8000-000000000011', '00000000-0000-4000-8000-000000000001',
   'Golden laptop', 'linux', 3, '2026-10-31T08:00:00Z');
INSERT INTO sessions (id, user_id, device_id, refresh_token_hash, expires_at) VALUES
  ('00000000-0000-4000-8000-000000000021', '00000000-0000-4000-8000-000000000001',
   '00000000-0000-4000-8000-000000000011', '\x0102'::bytea, '2026-12-01T00:00:00Z');
INSERT INTO refresh_tokens (id, session_id, token_hash, expires_at) VALUES
  ('00000000-0000-4000-8000-000000000022', '00000000-0000-4000-8000-000000000021',
   '\x0102'::bytea, '2026-12-01T00:00:00Z');
INSERT INTO lists (id, user_id, name, color, icon, rank, server_rev, deleted_at) VALUES
  ('00000000-0000-4000-8000-000000000031', '00000000-0000-4000-8000-000000000001',
   '工作 Work', '#3d66d9', 'briefcase', 'a1', 1, NULL),
  ('00000000-0000-4000-8000-000000000032', '00000000-0000-4000-8000-000000000001',
   'Archived', NULL, NULL, 'a2', 3, '2026-10-29T00:00:00Z');
INSERT INTO tasks (id, user_id, list_id, title, note, status, important, due_on, remind_at,
                   remind_timezone, rank, series_id, occurrence_key, recurrence, completed_at,
                   server_rev, tags, deleted_at) VALUES
  ('00000000-0000-4000-8000-000000000041', '00000000-0000-4000-8000-000000000001',
   '00000000-0000-4000-8000-000000000031', '整理发票 ✓ Expense report', E'line 1\nline 2',
   'completed', true, '2026-11-03', '2026-11-02T01:30:00Z', 'Asia/Shanghai', 'a1',
   '00000000-0000-4000-8000-000000000049', '2026-11-03',
   '{"freq": "weekly", "interval": 2, "byweekday": ["mo"]}', '2026-11-02T03:00:00Z', 2,
   ARRAY['work', '财务'], NULL),
  ('00000000-0000-4000-8000-000000000042', '00000000-0000-4000-8000-000000000001', NULL,
   'Inbox task', '', 'open', false, '1999-12-31', NULL, NULL, 'a2', NULL, NULL, NULL, NULL, 3,
   '{}', NULL),
  ('00000000-0000-4000-8000-000000000043', '00000000-0000-4000-8000-000000000001',
   '00000000-0000-4000-8000-000000000031', 'Deleted task', '', 'open', false, NULL, NULL, NULL,
   'a3', NULL, NULL, NULL, NULL, 1, '{}', '2026-10-31T00:00:00Z');
INSERT INTO steps (id, user_id, task_id, title, is_completed, rank, server_rev) VALUES
  ('00000000-0000-4000-8000-000000000051', '00000000-0000-4000-8000-000000000001',
   '00000000-0000-4000-8000-000000000041', 'Scan receipts', true, 'a1', 2),
  ('00000000-0000-4000-8000-000000000052', '00000000-0000-4000-8000-000000000001',
   '00000000-0000-4000-8000-000000000041', 'Submit 报销单', false, 'a2', 2);
INSERT INTO day_plans (id, user_id, task_id, local_date, rank, server_rev) VALUES
  ('00000000-0000-4000-8000-000000000061', '00000000-0000-4000-8000-000000000001',
   '00000000-0000-4000-8000-000000000042', '2026-11-01', 'a1', 3);
INSERT INTO change_log (user_id, server_seq, op_id, entity_type, entity_id, kind, patch) VALUES
  ('00000000-0000-4000-8000-000000000001', 1, '00000000-0000-4000-8000-000000000071', 'list',
   '00000000-0000-4000-8000-000000000031', 'create', '{"name": "工作 Work"}'),
  ('00000000-0000-4000-8000-000000000001', 2, '00000000-0000-4000-8000-000000000072', 'task',
   '00000000-0000-4000-8000-000000000041', 'patch', '{"status": "completed"}'),
  ('00000000-0000-4000-8000-000000000001', 3, '00000000-0000-4000-8000-000000000073', 'day_plan',
   '00000000-0000-4000-8000-000000000061', 'create', '{"local_date": "2026-11-01"}');
INSERT INTO op_receipts (op_id, user_id, device_id, client_seq, server_seq, status) VALUES
  ('00000000-0000-4000-8000-000000000071', '00000000-0000-4000-8000-000000000001',
   '00000000-0000-4000-8000-000000000011', 1, 1, 'applied'),
  ('00000000-0000-4000-8000-000000000072', '00000000-0000-4000-8000-000000000001',
   '00000000-0000-4000-8000-000000000011', 2, 2, 'applied'),
  ('00000000-0000-4000-8000-000000000073', '00000000-0000-4000-8000-000000000001',
   '00000000-0000-4000-8000-000000000011', 3, 3, 'applied');
INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth) VALUES
  ('00000000-0000-4000-8000-000000000081', '00000000-0000-4000-8000-000000000001',
   'https://push.example/golden', 'AAAA', 'BBBB');
INSERT INTO shared_lists (id, owner_id, name, revision) VALUES
  ('00000000-0000-4000-8000-000000000091', '00000000-0000-4000-8000-000000000001',
   'Family 家庭', 3);
INSERT INTO shared_list_members (list_id, user_id, role) VALUES
  ('00000000-0000-4000-8000-000000000091', '00000000-0000-4000-8000-000000000001', 'owner'),
  ('00000000-0000-4000-8000-000000000091', '00000000-0000-4000-8000-000000000002', 'editor');
INSERT INTO shared_tasks (id, list_id, title, due_on) VALUES
  ('00000000-0000-4000-8000-000000000092', '00000000-0000-4000-8000-000000000091',
   'Buy milk', '2026-11-04');
INSERT INTO shared_steps (id, task_id, title) VALUES
  ('00000000-0000-4000-8000-000000000093', '00000000-0000-4000-8000-000000000092', 'Oat milk');
INSERT INTO shared_op_receipts (list_id, op_id, actor_id, revision, status) VALUES
  ('00000000-0000-4000-8000-000000000091', '00000000-0000-4000-8000-000000000094',
   '00000000-0000-4000-8000-000000000002', 3, 'applied');
-- Shared-list state that a restore must preserve exactly: a pending invitation to
-- an address with no account, an accepted one, and an accepted one whose member
-- was later removed. The membership row is soft-deleted rather than deleted, so
-- the restore keeps both the audit trail and the revoked state.
INSERT INTO shared_list_invitations
  (id, list_id, email_normalized, role, status, invited_by, responded_by, responded_at) VALUES
  ('00000000-0000-4000-8000-000000000095', '00000000-0000-4000-8000-000000000091',
   'golden-unregistered@example.com', 'viewer', 'pending',
   '00000000-0000-4000-8000-000000000001', NULL, NULL),
  ('00000000-0000-4000-8000-000000000096', '00000000-0000-4000-8000-000000000091',
   'golden-member@example.com', 'editor', 'accepted',
   '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002',
   '2026-10-31T09:00:00Z'),
  ('00000000-0000-4000-8000-000000000097', '00000000-0000-4000-8000-000000000091',
   'golden-removed@example.com', 'viewer', 'accepted',
   '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000004',
   '2026-10-31T09:05:00Z');
-- The removed member's membership row is already soft-deleted; only the audit
-- trail remains, so a restore must not resurrect access from the invitation.
INSERT INTO shared_list_members (list_id, user_id, role, deleted_at) VALUES
  ('00000000-0000-4000-8000-000000000091', '00000000-0000-4000-8000-000000000004',
   'viewer', '2026-10-31T10:00:00Z');
COMMIT;
SQL
ORIGINAL=$(fingerprint)

log "running backup.sh"
BACKUP_DIR="$BACKUP_DIR" bash "$SCRIPT_DIR/backup.sh"
DUMPS=("$BACKUP_DIR"/todo-*.dump)
[ "${#DUMPS[@]}" = 1 ] && [ -f "${DUMPS[0]}" ] || fail "expected exactly one dump in $BACKUP_DIR"
DUMP=${DUMPS[0]}
[ -f "$DUMP.sha256" ] || fail "backup.sh did not write $DUMP.sha256"

log "restore.sh must refuse without RESTORE_CONFIRM=YES"
set +e
env -u RESTORE_CONFIRM bash "$SCRIPT_DIR/restore.sh" "$DUMP" >"$WORK_DIR/refused.log" 2>&1
status=$?
set -e
[ "$status" = 2 ] || fail "restore.sh without confirmation exited $status, expected 2"

log "restore.sh must refuse a dump that does not match its checksum"
mkdir "$WORK_DIR/tampered"
TAMPERED="$WORK_DIR/tampered/$(basename "$DUMP")"
cp "$DUMP" "$TAMPERED"
cp "$DUMP.sha256" "$TAMPERED.sha256"
printf 'tampered' >>"$TAMPERED"
set +e
RESTORE_CONFIRM=YES bash "$SCRIPT_DIR/restore.sh" "$TAMPERED" >"$WORK_DIR/tampered.log" 2>&1
status=$?
set -e
[ "$status" != 0 ] || fail "restore.sh accepted a dump with a mismatched checksum"
expect_same_fingerprint "after the refused restores" "$ORIGINAL"

log "dropping the database and restoring into an empty one"
dropdb --maintenance-db=postgres --force "$TEST_DB"
createdb --maintenance-db=postgres "$TEST_DB"
RESTORE_CONFIRM=YES bash "$SCRIPT_DIR/restore.sh" "$DUMP"
expect_same_fingerprint "after restoring into an empty database" "$ORIGINAL"

expect_count() {
  local table=$1 expected=$2 actual
  actual=$(psql_db -At -c "SELECT count(*) FROM public.$table")
  [ "$actual" = "$expected" ] || fail "$table has $actual rows after restore, expected $expected"
}
expect_count users 4
expect_count devices 1
expect_count lists 2
expect_count tasks 3
expect_count steps 2
expect_count day_plans 1
expect_count change_log 3
expect_count op_receipts 3
expect_count shared_lists 1
# Two active members and one soft-deleted (removed) membership row: the row must
# survive so a restore cannot resurrect access from the accepted invitation.
expect_count shared_list_members 3
expect_count shared_list_invitations 3
expect_count shared_tasks 1
due_on=$(psql_db -At -c \
  "SELECT due_on FROM tasks WHERE id = '00000000-0000-4000-8000-000000000042'")
[ "$due_on" = 1999-12-31 ] || fail "task due date changed to $due_on"

log "checking the API and operations CLI against the restored database"
start_api_until_ready
stop_api
"$API_BIN" ops all --dry-run >"$WORK_DIR/ops.json" ||
  fail "ops all --dry-run failed on the restored database"
expect_same_fingerprint "after starting the API on the restored database" "$ORIGINAL"

# ---------------------------------------------------------------------------
# Shared data after a restore. A row-count check is not enough: the point of
# restoring a collaboration database is that the relationships and the
# idempotency records still make the same decisions. These checks run against
# the restored database through the real API, and each one asserts a permission
# or replay outcome that a merely "complete" restore could get wrong.
# ---------------------------------------------------------------------------
api_call() {
  local method=$1 path=$2 token=$3 body=${4:-} extra=${5:-}
  curl -sS -o "$WORK_DIR/reply.json" -w '%{http_code}' \
    -X "$method" "http://127.0.0.1:$API_PORT$path" \
    -H 'content-type: application/json' \
    ${token:+-H "authorization: Bearer $token"} \
    ${extra:+-H "$extra"} \
    ${body:+--data "$body"}
}

api_json_field() {
  node -e 'const fs=require("node:fs");const v=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));let cur=v;for(const key of process.argv.slice(2)){if(cur===undefined||cur===null)break;cur=cur[key];}process.stdout.write(cur===undefined||cur===null?"":String(cur));' \
    "$WORK_DIR/reply.json" "$@"
}

log "logging in as the restored shared-list owner"
# The API was stopped above; the shared-data checks need it running.
start_api_until_ready
OWNER_EMAIL='golden-owner@example.com'
EQUIPMENT_ID='00000000-0000-4000-8000-0000000000a1'
status=$(api_call POST /api/v1/auth/code/request '' "{\"email\":\"$OWNER_EMAIL\"}")
[ "$status" = 202 ] || fail "code request after restore returned $status"
status=$(api_call POST /api/v1/auth/code/verify '' "{\"email\":\"$OWNER_EMAIL\",\"code\":\"246810\",\"device_id\":\"$EQUIPMENT_ID\",\"platform\":\"linux\",\"device_name\":\"restore drill\"}")
[ "$status" = 200 ] || { cat "$WORK_DIR/reply.json" >&2; fail "login after restore returned $status"; }
OWNER_TOKEN=$(api_json_field access_token)
[ -n "$OWNER_TOKEN" ] || fail "login after restore returned no access token"

log "the restored shared list keeps its revision, members and tasks"
status=$(api_call GET '/api/v1/shared/lists' "$OWNER_TOKEN")
[ "$status" = 200 ] || fail "listing shared lists after restore returned $status"
[ "$(api_json_field 0 id)" = '00000000-0000-4000-8000-000000000091' ] ||
  fail "the restored shared list is missing from the owner's list"
LIST_PATH='/api/v1/shared/lists/00000000-0000-4000-8000-000000000091'
status=$(api_call GET "$LIST_PATH" "$OWNER_TOKEN")
[ "$status" = 200 ] || fail "reading the restored shared list returned $status"
[ "$(api_json_field revision)" = 3 ] || fail "the restored shared list revision is $(api_json_field revision), expected 3"
[ "$(api_json_field list role)" = owner ] || fail "the restored owner role is not owner"
[ "$(api_json_field tasks 0 title)" = 'Buy milk' ] ||
  fail "the restored shared task is missing"
# Pending invitations survived, including the one addressed to an account that
# does not exist yet.
[ "$(api_json_field invitations 0 email)" = 'golden-unregistered@example.com' ] ||
  fail "the restored pending invitation is missing or changed"

log "a restored member keeps access, and a removed member stays removed"
restore_login() {
  local email=$1 device=$2 name=$3
  api_call POST /api/v1/auth/code/request '' "{\"email\":\"$email\"}" >/dev/null
  local status
  status=$(api_call POST /api/v1/auth/code/verify '' \
    "{\"email\":\"$email\",\"code\":\"246810\",\"device_id\":\"$device\",\"platform\":\"linux\",\"device_name\":\"$name\"}")
  [ "$status" = 200 ] || { cat "$WORK_DIR/reply.json" >&2; fail "$email login after restore returned $status"; }
  api_json_field access_token
}

MEMBER_TOKEN=$(restore_login 'golden-member@example.com' \
  '00000000-0000-4000-8000-0000000000a2' 'restore drill member')
status=$(api_call GET "$LIST_PATH" "$MEMBER_TOKEN")
[ "$status" = 200 ] || fail "the restored editor got $status from the shared list, expected 200"
[ "$(api_json_field list role)" = editor ] ||
  fail "the restored editor role is $(api_json_field list role), expected editor"

REMOVED_TOKEN=$(restore_login 'golden-removed@example.com' \
  '00000000-0000-4000-8000-0000000000a3' 'restore drill removed')
status=$(api_call GET "$LIST_PATH" "$REMOVED_TOKEN")
# The membership row was already soft-deleted before the backup, so access must
# still be revoked after the restore rather than resurrected from the accepted
# invitation audit row.
[ "$status" = 403 ] || fail "a removed member got $status from the restored list, expected 403"
[ "$(api_json_field code)" = SHARED_LIST_ACCESS_REVOKED ] ||
  fail "a removed member got $(api_json_field code), expected SHARED_LIST_ACCESS_REVOKED"

log "op-receipt idempotency survives the restore"
# The golden dataset records op 94 for revision 3, made by the member. Both
# halves of the receipt survive: the original actor replays it as a no-op, and
# anyone else replaying it is refused rather than treated as a fresh write.
OP_RECEIPT_BODY='{"title":"should not be created","revision":3,"op_id":"00000000-0000-4000-8000-000000000094"}'
status=$(api_call POST "$LIST_PATH/tasks" "$MEMBER_TOKEN" "$OP_RECEIPT_BODY" 'if-match: "3"')
[ "$status" = 200 ] || { cat "$WORK_DIR/reply.json" >&2; fail "replaying a pre-restore op returned $status"; }
status=$(api_call POST "$LIST_PATH/tasks" "$OWNER_TOKEN" "$OP_RECEIPT_BODY" 'if-match: "3"')
[ "$status" = 409 ] || fail "another actor replaying the restored op returned $status, expected 409"
[ "$(api_json_field code)" = OP_ID_CONFLICT ] ||
  fail "another actor got $(api_json_field code), expected OP_ID_CONFLICT"
[ "$(psql_db -At -c "SELECT count(*) FROM shared_op_receipts WHERE op_id = '00000000-0000-4000-8000-000000000094'")" = 1 ] ||
  fail "the restored op receipt was duplicated"
[ "$(psql_db -At -c "SELECT count(*) FROM shared_tasks WHERE list_id = '00000000-0000-4000-8000-000000000091'")" = 1 ] ||
  fail "replaying the restored op created a second task"

log "the restored database still accepts new shared writes"
status=$(api_call POST "$LIST_PATH/tasks" "$OWNER_TOKEN" \
  '{"title":"written after restore","revision":3}' 'if-match: "3"')
[ "$status" = 200 ] || { cat "$WORK_DIR/reply.json" >&2; fail "creating a shared task after restore returned $status"; }
[ "$(psql_db -At -c "SELECT revision FROM shared_lists WHERE id = '00000000-0000-4000-8000-000000000091'")" = 4 ] ||
  fail "a shared write after restore did not advance the revision"

log "the restored database can still invite and accept"
# A pending invitation from the backup is still answerable, and a brand new
# invitation still works. Both prove the invitation table and the partial unique
# pending index came back intact, not just that the rows exist.
status=$(api_call POST /api/v1/shared/invitations/00000000-0000-4000-8000-000000000095/accept "$MEMBER_TOKEN" '{}')
[ "$status" = 404 ] || { cat "$WORK_DIR/reply.json" >&2; fail "an invitation addressed to another address returned $status, expected 404"; }
[ "$(api_json_field code)" = SHARED_INVITATION_NOT_FOUND ] ||
  fail "an invitation addressed to another address got $(api_json_field code)"
NEW_INVITEE='golden-reinvite@example.com'
status=$(api_call POST "$LIST_PATH/members" "$OWNER_TOKEN" \
  "{\"email\":\"$NEW_INVITEE\",\"role\":\"viewer\",\"revision\":4}" 'if-match: "4"')
[ "$status" = 200 ] || { cat "$WORK_DIR/reply.json" >&2; fail "inviting after restore returned $status"; }
INVITATION_ID=$(api_json_field id)
[ -n "$INVITATION_ID" ] || fail "the invitation after restore returned no id"
NEW_INVITEE_TOKEN=$(restore_login "$NEW_INVITEE" \
  '00000000-0000-4000-8000-0000000000a4' 'restore drill invitee')
status=$(api_call POST "/api/v1/shared/invitations/$INVITATION_ID/accept" "$NEW_INVITEE_TOKEN" '{}')
[ "$status" = 200 ] || { cat "$WORK_DIR/reply.json" >&2; fail "accepting an invitation after restore returned $status"; }
[ "$(api_json_field role)" = viewer ] || fail "the accepted role after restore is $(api_json_field role)"
# Re-inviting the same pending address must hit the restored partial unique
# index rather than creating a duplicate open invitation.
CURRENT_REVISION=$(psql_db -At -c \
  "SELECT revision FROM shared_lists WHERE id = '00000000-0000-4000-8000-000000000091'")
status=$(api_call POST "$LIST_PATH/members" "$OWNER_TOKEN" \
  "{\"email\":\"$NEW_INVITEE\",\"role\":\"editor\",\"revision\":$CURRENT_REVISION}" \
  "if-match: \"$CURRENT_REVISION\"")
[ "$status" = 409 ] || fail "re-inviting an accepted member returned $status, expected 409"
[ "$(api_json_field code)" = SHARED_MEMBER_EXISTS ] ||
  fail "re-inviting an accepted member got $(api_json_field code), expected SHARED_MEMBER_EXISTS"
[ "$(psql_db -At -c "SELECT count(*) FROM shared_list_invitations WHERE list_id = '00000000-0000-4000-8000-000000000091' AND email_normalized = '$NEW_INVITEE'")" = 1 ] ||
  fail "the post-restore invitation flow created duplicate invitation rows"
# The write above is expected state, not backup content: bring the database back
# to the backed-up state before the fingerprint comparison. The API must be down
# for that; pg_restore --clean rewrites every table under it.
stop_api
RESTORE_CONFIRM=YES bash "$SCRIPT_DIR/restore.sh" "$DUMP"
expect_same_fingerprint "after the post-restore shared-data checks" "$ORIGINAL"

log "restoring over a modified database"
psql_db -c "DELETE FROM steps WHERE id = '00000000-0000-4000-8000-000000000052'; \
  UPDATE tasks SET title = 'changed after backup' \
    WHERE id = '00000000-0000-4000-8000-000000000041'; \
  INSERT INTO lists (id, user_id, name) VALUES (gen_random_uuid(), \
    '00000000-0000-4000-8000-000000000001', 'created after backup');"
RESTORE_CONFIRM=YES bash "$SCRIPT_DIR/restore.sh" "$DUMP"
expect_same_fingerprint "after restoring over a modified database" "$ORIGINAL"
