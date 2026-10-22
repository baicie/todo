# To Do API

Rust 1.96 + Axum 0.8 + Tokio + SQLx (PostgreSQL) + `tracing` implementation of the
local-first To Do sync protocol. The service owns accounts, devices, sessions, and
the account-scoped change log. Clients continue to write locally first and send
field-level mutations through `POST /api/v1/sync`.

## Local run

Prerequisites: Rust 1.96, Cargo, and PostgreSQL 16 (or Docker Compose).

```bash
cp .env.example .env
docker compose up -d postgres
cargo run -p todo-api
```

Migrations in `db/postgres/migrations/` are embedded in the binary and run at
startup. To run the complete API + database stack:

```bash
docker compose up --build
curl -fsS http://127.0.0.1:8787/healthz
```

The Compose file includes PostgreSQL and API health checks. The API container
does not need a migration volume because migrations are compiled into the image.
Stop with `docker compose down`; use `docker compose down -v` only when you intend
to delete the local database volume.

Optional profiles do not affect the default quick start:

```bash
# Caddy TLS termination (set APP_DOMAIN)
docker compose --profile tls up -d

# One-shot PostgreSQL backup
docker compose --profile ops run --rm backup

# Protected maintenance CLI
docker compose --profile ops run --rm ops ops all --dry-run
```

See `docs/runbooks/production.md`, `docs/runbooks/operations.md`, and
`docs/runbooks/backup-restore.md`.

## Configuration

`.env.example` contains the common development settings. The API loads `.env` if
present and environment variables always take precedence. Production SMTP, Web
Push, and security settings must be supplied by the deployment environment and
are described below and in `docs/runbooks/production.md`; do not put real
passwords or tokens in `.env.example`.

| Variable                               | Default                                   | Notes                                                                                                                                                   |
| -------------------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `APP_ENV`                              | `development`                             | `development`, `test`, or `production`.                                                                                                                 |
| `DATABASE_URL`                         | required                                  | PostgreSQL URL.                                                                                                                                         |
| `BIND_ADDR`                            | `127.0.0.1:8787`                          | Compose sets `0.0.0.0:8787`.                                                                                                                            |
| `JWT_SECRET`                           | required                                  | At least 32 bytes. Also derives HMAC keys for codes, continuations, and rate-limit fingerprints. Known development defaults are rejected in production. |
| `CORS_ORIGINS`                         | `http://localhost:5173` in development    | Comma-separated exact allowlist. Wildcards, paths, and HTTP origins in production are rejected; use HTTPS.                                              |
| `AUTH_DEV_CODE`                        | `246810` in development                   | Six digits. Ignored outside development.                                                                                                                |
| `SMTP_HOST`                            | production required                       | SMTP hostname, no scheme or path.                                                                                                                       |
| `SMTP_PORT`                            | `587` or `465` by TLS mode                | SMTP submission port.                                                                                                                                   |
| `SMTP_TLS`                             | `starttls`                                | `starttls` or `implicit`; `none` is rejected in production.                                                                                             |
| `AUTH_USERNAME`                        | production required                       | SMTP username; redacted from debug output.                                                                                                              |
| `AUTH_PASSWORD`                        | production required                       | SMTP password; never logged.                                                                                                                            |
| `MAIL_FROM`                            | production required                       | Valid mailbox, for example `Shishi <no-reply@example.com>`.                                                                                             |
| `WEB_PUSH_ENABLED`                     | `false`                                   | Enables Web Push only when `true`; requires all VAPID values.                                                                                           |
| `VAPID_PUBLIC_KEY`                     | required when enabled                     | URL-safe base64 uncompressed P-256 public key (65 bytes).                                                                                               |
| `VAPID_PRIVATE_KEY`                    | required when enabled                     | URL-safe base64 raw P-256 private key (32 bytes); redacted from debug output.                                                                           |
| `VAPID_SUBJECT`                        | required when enabled                     | `mailto:` URI containing an email address.                                                                                                              |
| `PUSH_WORKER_INTERVAL_SECONDS`         | `30`                                      | Reminder worker interval, 1–3600 seconds.                                                                                                               |
| `COOKIE_SECURE`                        | true in production                        | Production requires `true`; set false only for local HTTP development.                                                                                  |
| `ACCESS_TOKEN_TTL_SECONDS`             | `900`                                     | 60–3600 seconds.                                                                                                                                        |
| `REFRESH_TOKEN_TTL_DAYS`               | `30`                                      | 1–365 days.                                                                                                                                             |
| `AUTH_CODE_TTL_SECONDS`                | `600`                                     | One-time code lifetime.                                                                                                                                 |
| `AUTH_CODE_RESEND_SECONDS`             | `60`                                      | Minimum per-email resend interval.                                                                                                                      |
| `AUTH_CODE_REQUESTS_PER_WINDOW`        | `5`                                       | Per-email request cap stored in PostgreSQL.                                                                                                             |
| `AUTH_CODE_WINDOW_SECONDS`             | `900`                                     | Shared fixed-window duration.                                                                                                                           |
| `AUTH_CODE_GLOBAL_REQUESTS_PER_WINDOW` | `300`                                     | Shared global cap across all API instances.                                                                                                             |
| `AUTH_CODE_MAX_ATTEMPTS`               | `5`                                       | Wrong-code attempts before a code is unusable.                                                                                                          |
| `REQUEST_TIMEOUT_SECONDS`              | `30`                                      | Whole-request timeout.                                                                                                                                  |
| `MAX_BODY_BYTES`                       | `1048576`                                 | Request body limit.                                                                                                                                     |
| `DB_MAX_CONNECTIONS`                   | `10`                                      | SQLx pool maximum.                                                                                                                                      |
| `RUST_LOG`                             | `todo_api=info,tower_http=info,sqlx=warn` | Log filter. Do not enable SQLx trace in production; it can include parameter values.                                                                    |

Operations-only variables are documented in `docs/runbooks/operations.md`.

## Development sign-in code

In `APP_ENV=development`, a sign-in code is deterministic: `AUTH_DEV_CODE` or
`246810` when unset. It is never included in a response and is never logged. The
API also never looks up the account during the code request, so its generic
`202 Accepted` does not reveal whether an account exists.

In production a random six-digit code is generated after the rate-limit checks,
stored as a keyed hash, and delivered through lettre SMTP. Production startup fails
unless `SMTP_HOST`, `AUTH_USERNAME`, `AUTH_PASSWORD`, and `MAIL_FROM` are set, TLS
is enabled, and `COOKIE_SECURE=true`. Delivery errors are logged with only a fixed
provider/error class; the code, recipient, SMTP response, and message content are
never logged. The endpoint still returns generic `202` so account existence and
delivery status are not exposed.

`/readyz` reports mail configuration readiness. It does not make a live SMTP
connection on every probe. See `docs/runbooks/production.md` for deployment
requirements.

## Response errors

Application errors use one JSON envelope:

```json
{ "code": "VALIDATION_FAILED", "message": "request body must be valid JSON" }
```

Notable codes:

- `UNAUTHORIZED`, `INVALID_TOKEN`, `INVALID_CODE`, `REFRESH_TOKEN_REUSED`,
  `REAUTH_REQUIRED`
- `VALIDATION_FAILED`, `NOT_FOUND`, `DEVICE_NOT_FOUND`
- `SEQUENCE_MISMATCH` (409): a device batch is not contiguous or a receipt conflicts
- `CURSOR_EXPIRED` (409): the change cursor predates retained history; bootstrap first
- `INVALID_CURSOR` (400): cursor is malformed or ahead of the account log
- `CONTINUATION_EXPIRED`, `INVALID_CONTINUATION`
- `ENTITY_NOT_FOUND`, `ENTITY_TOMBSTONED`, `ENTITY_ALREADY_EXISTS`,
  `INVALID_PARENT`, `CONSTRAINT_VIOLATION` (inside a sync rejection receipt)
- `RATE_LIMITED`, `PAYLOAD_TOO_LARGE`, `REQUEST_TIMEOUT`

## Endpoints

All authenticated routes take `Authorization: Bearer <access_token>`. The user id
is taken only from the verified JWT and its database session/device checks; no
route accepts a `user_id` from the client.

### `GET /healthz` and `GET /readyz`

- `/healthz` is the liveness probe. It has no database dependency and returns
  `200 {"status":"ok","service":"todo-api"}` while the process can serve HTTP.
- `/readyz` is the readiness probe. It checks PostgreSQL connectivity, that every
  embedded SQLx migration is applied, and that the mail provider configuration is
  ready. Success is `200 {"status":"ready"}`; failure is `503 NOT_READY` with
  component status only. Docker healthchecks and load balancers use `/readyz`.

### Authentication

`POST /api/v1/auth/code/request`

```bash
curl -i -X POST http://127.0.0.1:8787/api/v1/auth/code/request \
  -H 'Content-Type: application/json' \
  -d '{"email":"person@example.com"}'
```

Always returns `202` for a valid request (including when the per-email window limit
suppresses delivery). A shared global limit may return `429 RATE_LIMITED`. Both
email and global counters are persisted in PostgreSQL with atomic upserts, so
multiple API instances enforce one budget. No email code is returned in JSON. In
development use the configured `AUTH_DEV_CODE` / `246810`.

`POST /api/v1/auth/code/verify`

```bash
curl -X POST http://127.0.0.1:8787/api/v1/auth/code/verify \
  -H 'Content-Type: application/json' \
  -d '{
    "email":"person@example.com",
    "code":"246810",
    "device_id":"019a0000-0000-7000-8000-000000000001",
    "platform":"windows",
    "device_name":"Workstation"
  }'
```

Native response:

```json
{
  "access_token": "<JWT>",
  "token_type": "Bearer",
  "expires_in": 900,
  "refresh_token": "<opaque 256-bit token>"
}
```

For `platform: "web"` the refresh token is set as an `HttpOnly`, `SameSite=Strict`
cookie (`Secure` when `COOKIE_SECURE=true`) with path `/api/v1/auth`, and is not
returned to JavaScript. The access token lifetime is 15 minutes by default.
Refresh tokens are stored only as SHA-256 hashes and the versioned session history
supports reuse detection.

`POST /api/v1/auth/refresh`

Native clients send JSON:

```json
{ "refresh_token": "<opaque token>" }
```

Web clients send no body and rely on the cookie (a configurable origin allowlist,
`SameSite=Strict`, and an optional `Origin` check protect cookie use). Do not send
both. Each successful refresh rotates the token and revokes the old token record.
Presenting a rotated/revoked token revokes the session and returns
`401 REFRESH_TOKEN_REUSED`.

`POST /api/v1/auth/logout`

Requires a bearer access token. Revokes the current session and all its refresh
tokens and clears the cookie.

### Devices

`GET /api/v1/devices` returns active devices for the account:

```json
[
  {
    "id": "019a0000-0000-7000-8000-000000000001",
    "name": "Workstation",
    "platform": "windows",
    "last_seen_at": "2026-10-21T05:00:00Z",
    "created_at": "2026-10-21T04:00:00Z",
    "current": true
  }
]
```

`DELETE /api/v1/devices/:id` revokes that device, all of its sessions, and all of
its refresh tokens. The current device may also be revoked. It returns `204`;
unknown or another account's device returns `404 DEVICE_NOT_FOUND`.

### Web Push

All Web Push routes require a bearer access token.

`GET /api/v1/push/config` returns whether Web Push is enabled and the public VAPID
key to pass to `PushManager.subscribe`:

```json
{ "enabled": true, "public_key": "<URL-safe base64 public key>" }
```

When `WEB_PUSH_ENABLED` is false or absent, this endpoint still returns `200` with
`{"enabled": false, "public_key": null}`; the subscription and test endpoints
return `503 PUSH_DISABLED`. Enabling Web Push without any required VAPID value
fails startup with a configuration error.

`POST /api/v1/push/subscriptions` registers or refreshes a browser subscription:

```json
{
  "endpoint": "https://push.example.net/send/...",
  "p256dh": "<URL-safe base64>",
  "auth": "<URL-safe base64>",
  "user_agent": "Mozilla/5.0 ..."
}
```

The request is an idempotent upsert for the authenticated user and endpoint:
keys, user agent, `last_seen_at`, and `failed_at` are refreshed while `created_at`
is retained. An endpoint already owned by another account returns
`409 PUSH_SUBSCRIPTION_CONFLICT`. Endpoints must be HTTPS; HTTP is accepted only
for `localhost`/`127.0.0.1` in development. The response is
`{"id":"<uuid>","endpoint":"..."}`.

`DELETE /api/v1/push/subscriptions` accepts `{"endpoint":"..."}` and returns `204`.
Deletion is idempotent and scoped to the authenticated account.

`POST /api/v1/push/test` sends a test notification to all active subscriptions
for the account. It is limited to five requests per user per UTC day and returns
`429 PUSH_TEST_RATE_LIMITED` when exhausted. The response reports
`{"sent":0,"failed":0,"skipped":0}`.

The reminder worker runs every `PUSH_WORKER_INTERVAL_SECONDS` (30 seconds by
default). It processes open, non-deleted tasks whose `remind_at` is in the last
five minutes. Each task/subscription pair is claimed in `push_deliveries`, so a
successful or permanently rejected delivery is not sent twice. A 404/410 push
service response sets `push_subscriptions.failed_at`; transient errors release
the claim and are retried on the next worker tick. The notification payload is:

```json
{
  "title": "<task title>",
  "body": "<task note or Task reminder>",
  "taskId": "<task uuid>",
  "url": "/?task=<task uuid>"
}
```

Metrics expose `todo_push_sent_total`, `todo_push_failed_total`, and
`todo_push_skipped_total`. Web Push payloads are transport-encrypted by the Web
Push protocol; this API does not add a separate end-to-end encryption layer.

### Shared lists

Shared lists are a separate collaboration surface from personal sync. All routes
require an authenticated bearer token and only expose lists where the caller has
an active membership. A non-member receives `404 SHARED_LIST_NOT_FOUND`; a member
with insufficient role receives `403 SHARED_LIST_FORBIDDEN`. Viewers are
read-only, editors may create/update/delete tasks, and owners may also manage
members and delete the list.

`GET /api/v1/shared/lists` returns the caller's visible lists:

```json
[
  {
    "id": "019a0000-0000-7000-8000-000000000010",
    "owner_id": "019a0000-0000-7000-8000-000000000001",
    "name": "Team list",
    "color": "#3d66d9",
    "icon": "users",
    "rank": "a0",
    "revision": 3,
    "role": "editor",
    "created_at": "2026-10-22T04:00:00Z",
    "updated_at": "2026-10-22T04:10:00Z"
  }
]
```

`POST /api/v1/shared/lists` with `{"name":"Team list","color":"#3d66d9","icon":"users"}`
creates a list owned by the caller, inserts an owner membership, and returns the
list summary with `role: "owner"` and `revision: 1`.

`GET /api/v1/shared/lists/{id}` returns a snapshot for any member:

```json
{
  "list": { "...": "same shape as the list summary" },
  "members": [
    {
      "user_id": "019a0000-0000-7000-8000-000000000001",
      "email": "owner@example.com",
      "role": "owner",
      "created_at": "2026-10-22T04:00:00Z"
    }
  ],
  "tasks": [
    {
      "id": "019a0000-0000-7000-8000-000000000011",
      "list_id": "019a0000-0000-7000-8000-000000000010",
      "title": "Prepare agenda",
      "note": "",
      "status": "open",
      "important": false,
      "due_on": null,
      "rank": "a0",
      "revision": 3,
      "created_at": "2026-10-22T04:05:00Z",
      "updated_at": "2026-10-22T04:05:00Z"
    }
  ],
  "steps": [],
  "revision": 3
}
```

Only active tasks and steps are included. `revision` is the list version.

`POST /api/v1/shared/lists/{id}/tasks` is allowed for owners/editors:

```json
{
  "id": "019a0000-0000-7000-8000-000000000011",
  "title": "Prepare agenda",
  "note": "",
  "important": false,
  "due_on": "2026-11-01",
  "revision": 3,
  "op_id": "019a0000-0000-7000-8000-000000000012"
}
```

`id` and `op_id` are optional; an omitted task id is generated by the server. The
response is the task object. `PATCH /shared/lists/{id}/tasks/{task_id}` accepts
`title`, `note`, `status` (`open`/`completed`), `important`, and `due_on`
(`due_on: null` clears the date).
`DELETE /shared/lists/{id}/tasks/{task_id}` soft-deletes the task and returns
`204`. All task mutations require a revision and bump the list revision.

`POST /api/v1/shared/lists/{id}/members` is owner-only:

```json
{ "email": "editor@example.com", "role": "editor", "revision": 3 }
```

The email must belong to a registered, non-deleted account; otherwise the API
returns `404 MEMBER_NOT_FOUND`. Roles are `owner`, `editor`, or `viewer`.
`PATCH /shared/lists/{id}/members/{user_id}` changes a role. `DELETE` removes a
member. The owner cannot remove their own membership.

Revision concurrency is mandatory for every mutation. Supply either an
`If-Match: "3"` header or `"revision": 3` in the JSON body. Both forms are
equivalent; if both are present they must match. A stale value returns:

```json
{
  "code": "REVISION_CONFLICT",
  "message": "The shared list revision changed; refresh and retry",
  "current_revision": 4
}
```

with HTTP `409`. Each successful mutation writes an applied
`shared_op_receipts` row and increments the list revision exactly once. For
task and member operations, repeating the same `op_id` on the same list returns
the existing result/revision without applying the mutation twice. The optional
`op_id` is also recorded for client audit/retry correlation.

`DELETE /api/v1/shared/lists/{id}` is owner-only, requires a revision, soft-deletes
the list, and returns `204`.

### Bootstrap

`GET /api/v1/sync/bootstrap?limit=500` starts a snapshot; subsequent pages pass
`continuation=<opaque token>`.

```json
{
  "entities": [
    {
      "entity": "task",
      "entity_id": "019a0000-0000-7000-8000-000000000003",
      "data": {
        "title": "Submit expense report",
        "status": "open",
        "tags": ["work", "finance"],
        "deleted_at": null
      }
    }
  ],
  "snapshot_cursor": "195",
  "next_page": "<HMAC continuation>",
  "has_more": true
}
```

The first page records an account-scoped snapshot cursor and timestamp. Pages are
ordered by `(entity, entity_id)` and include tombstones (`deleted_at` is present).
The continuation is an HMAC-signed, expiring token bound to the authenticated
account and snapshot; it cannot be used by another account. The page size is 1–500
(default 500). Changes that occur after the snapshot are caught by pulling changes
after `snapshot_cursor`. If a continuation expires, restart bootstrap.

### Sync

`POST /api/v1/sync`

Pull-only request (the ops array may be empty):

```json
{ "device_id": "019a0000-0000-7000-8000-000000000001", "cursor": "0", "ops": [], "limit": 500 }
```

Mutation request:

```json
{
  "device_id": "019a0000-0000-7000-8000-000000000001",
  "cursor": "195",
  "limit": 500,
  "ops": [
    {
      "op_id": "019a0000-0000-7000-8000-000000000002",
      "client_seq": 39,
      "entity": "task",
      "entity_id": "019a0000-0000-7000-8000-000000000003",
      "kind": "patch",
      "patch": { "title": "Submit expense report" }
    }
  ]
}
```

Rules:

- `device_id` must match the device embedded in the access token.
- At most 100 ops and 500 changes per request. Ops must be sorted by strictly
  increasing `client_seq` and start at the device's next expected sequence. The
  server persists a contiguous device watermark (`last_client_seq`); gaps cause
  `409 SEQUENCE_MISMATCH` and roll back the whole request.
- The account's `account_sync_state` row and device row are locked in one
  transaction. Successful mutations get account-scoped increasing `server_seq`
  values from that locked row; changes and receipts commit with the entity writes.
- Retrying an identical `op_id` returns its original receipt without creating a
  duplicate change. If a receipt was pruned, a client_seq at or below the device
  watermark is acknowledged as `already_processed` and is never applied again.
- Rejected mutations are persisted as receipts, acknowledged with `status:
"rejected"` and an error code, and still advance the device watermark so they
  cannot deadlock an outbox.
- Deleted entities are tombstones (`deleted_at`). Patches and deletes targeting a
  tombstone are rejected; only an explicit `restore` can revive it. Creates cannot
  reuse an existing/tombstoned id.
- Parent references are validated under the same account (`task.list_id`,
  `step.task_id`, `day_plan.task_id`); cross-account and tombstoned parents are
  rejected.

Response:

```json
{
  "ack": [
    {
      "op_id": "019a0000-0000-7000-8000-000000000002",
      "server_seq": 196,
      "status": "applied",
      "error_code": null
    }
  ],
  "changes": [
    {
      "server_seq": 196,
      "op_id": "019a0000-0000-7000-8000-000000000002",
      "entity": "task",
      "entity_id": "019a0000-0000-7000-8000-000000000003",
      "kind": "patch",
      "patch": { "title": "Submit expense report" }
    }
  ],
  "next_cursor": "196",
  "has_more": false,
  "server_time": "2026-10-21T05:00:00Z"
}
```

`next_cursor` is the last returned change sequence, or the incoming cursor when no
changes were returned. It is not necessarily the server's maximum sequence. For a
client whose cursor is older than `min_available_seq` the service returns
`409 CURSOR_EXPIRED` and applies no writes; the client must bootstrap and rebase
unconfirmed outbox operations using the device watermark.

See `db/postgres/migrations/` for the exact tables and indexes. Use
`todo-api ops prune-change-log` to remove expired `op_receipts` / `change_log`
rows after the configured retention window and atomically raise
`account_sync_state.min_available_seq`. The command defaults to dry-run; see
[`docs/runbooks/operations.md`](runbooks/operations.md) for the protected apply flow.

#### Supported entity fields

Fields use snake_case exactly as in the database/OpenAPI design.

- `list`: `name`, `color`, `icon`, `rank`
- `task`: `list_id`, `title`, `note`, `status` (`open`/`completed`), `important`,
  `tags` (string array), `due_on` (`YYYY-MM-DD`), `remind_at` (RFC 3339 UTC),
  `remind_timezone` (IANA name), `rank`, `series_id`, `occurrence_key`, `recurrence`,
  `completed_at`
- `step`: `task_id`, `title`, `is_completed`, `rank`
- `day_plan`: `task_id`, `local_date` (`YYYY-MM-DD`), `rank`

`tags` follows the client `normalizeTags` rules: whitespace is collapsed and
trimmed, one leading `#` is removed, and duplicates are removed case-insensitively
while preserving the first spelling. A tag must contain 1–32 characters, and a
task may have at most 20 unique tags; violations are rejected instead of being
silently truncated. On `patch`, `tags` is the complete replacement array (not an
incremental merge): omitting it preserves the current tags and `[]` clears them.
On `create`, omitting it stores `[]`. Bootstrap and export task objects both
include the normalized `tags` array.

Unknown fields, wrong types, null for non-nullable fields, empty required strings,
and invalid timezones are rejected as `VALIDATION_FAILED` receipts. `create` inserts
all fields (using defaults for omitted optional fields); `patch` updates only the
supplied fields; `delete` soft-deletes and requires an empty patch; `restore`
requires an explicit kind and may carry a patch.

### Export

`GET /api/v1/export` returns a repeatable-read JSON export of the authenticated
account's active lists, tasks, steps, day plans, profile metadata, and snapshot
cursor. Authentication secrets and token hashes are never exported.

### Account deletion

`DELETE /api/v1/account` requires an access token issued within the last five
minutes (`403 REAUTH_REQUIRED` otherwise). It returns
`202 {"status":"deletion_scheduled"}`, marks the account deleted, revokes all
devices/sessions/refresh tokens, and clears the web cookie. The protected
`ops purge-accounts --apply` job performs physical cleanup after
`ACCOUNT_PURGE_GRACE_DAYS`; backups must be handled by the retention policy.

### Operations CLI and TLS

The API binary also exposes protected, non-HTTP operations for retention and
physical account purge:

```bash
OPS_ADMIN_TOKEN='<32+ chars>' cargo run -p todo-api -- ops all --dry-run
OPS_ADMIN_TOKEN='<32+ chars>' OPS_CONFIRM=APPLY \
  cargo run -p todo-api -- ops all --apply
```

See `docs/runbooks/operations.md`. Caddy TLS termination and Docker profiles are
documented in `docs/runbooks/production.md`; default `docker compose up` remains a
local, non-TLS setup.

## Tests

```bash
cargo fmt -p todo-api -- --check
cargo clippy -p todo-api --all-targets -- -D warnings
cargo test -p todo-api
```

Unit tests cover continuation signing/account binding/tamper/expiry, change cursor
and page-limit parsing, JWT round trips, refresh-token entropy/hashing, patch field
whitelists and validation, sequence-batch validation, SMTP provider handoff and
redacted logging, Web Push configuration/payload/subscription validation, shared
revision/role parsing, CLI parsing, migration ordering, and router error/CORS
behavior.

Ignored PostgreSQL integration tests cover migrations/readiness, atomic shared rate
limiting across connections, retention cleanup, change-log pruning/min-cursor
updates, physical account purge, Web Push subscription upsert/delete and test
limits, task-delivery deduplication, and shared-list permissions/revisions/task
CRUD:

```bash
DATABASE_URL=postgres://todo:todo@127.0.0.1:5432/todo \
  cargo test -p todo-api --test postgres_smoke -- --ignored
DATABASE_URL=postgres://todo:todo@127.0.0.1:5432/todo \
  cargo test -p todo-api --test postgres_production -- --ignored --test-threads=1
DATABASE_URL=postgres://todo:todo@127.0.0.1:5432/todo \
  cargo test -p todo-api --test postgres_shared -- --ignored --test-threads=1
```

CI starts PostgreSQL 16, runs these tests, invokes the ops CLI dry-run, and starts
the API until `/readyz` succeeds.

## Security notes

- Request bodies, authorization headers, codes, JWTs, refresh tokens, and task
  content are never intentionally logged. Trace spans exclude headers.
- Access tokens are short-lived and checked against the current session, user, and
  device on every authenticated request, so logout/device revocation takes effect
  immediately.
- CORS is an exact allowlist; wildcard origins and credentialed wildcard CORS are
  rejected. Compression, whole-request timeout, request body limits, and tracing
  middleware are enabled.
- Web refresh cookies are `HttpOnly`, `SameSite=Strict`, optionally `Secure`, and
  limited to `/api/v1/auth`. Deploy behind TLS with `COOKIE_SECURE=true` in
  production and keep the CORS allowlist exact.
- Auth request counters live in PostgreSQL, keyed by a keyed email fingerprint, so
  horizontal API instances share one atomic limit.
- Caddy access logging is intentionally disabled because bootstrap continuations
  appear in query strings. Application trace spans log only method and path, never
  query, headers, or bodies.
- Production startup validates SMTP configuration and cookie security; `/readyz`
  gates traffic on DB, migrations, and mail configuration.
