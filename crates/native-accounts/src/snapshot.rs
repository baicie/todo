use std::{collections::BTreeMap, path::Path};

use rusqlite::{Connection, OpenFlags, params};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::error::{AccountError, AccountResult};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VerificationSummary {
    pub integrity: String,
    pub counts: BTreeMap<String, i64>,
    pub device_id: Option<String>,
    pub sync_cursor: Option<String>,
    pub client_seq: Option<String>,
    pub bound_account: Option<String>,
    pub outbox_count: usize,
    pub shadow_count: usize,
    pub schema_versions: Vec<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DataSnapshot {
    pub integrity: String,
    pub counts: BTreeMap<String, i64>,
    pub device_id: Option<String>,
    pub sync_cursor: Option<String>,
    pub client_seq: Option<String>,
    pub bound_account: Option<String>,
    pub outbox_rows: Vec<String>,
    pub shadow_rows: Vec<String>,
    pub schema_versions: Vec<i64>,
    pub fingerprint: String,
}

#[derive(Serialize)]
struct FingerprintInput<'a> {
    integrity: &'a str,
    counts: &'a BTreeMap<String, i64>,
    device_id: &'a Option<String>,
    sync_cursor: &'a Option<String>,
    client_seq: &'a Option<String>,
    bound_account: &'a Option<String>,
    outbox_rows: &'a [String],
    shadow_rows: &'a [String],
    schema_versions: &'a [i64],
}

impl DataSnapshot {
    pub fn summary(&self) -> VerificationSummary {
        VerificationSummary {
            integrity: self.integrity.clone(),
            counts: self.counts.clone(),
            device_id: self.device_id.clone(),
            sync_cursor: self.sync_cursor.clone(),
            client_seq: self.client_seq.clone(),
            bound_account: self.bound_account.clone(),
            outbox_count: self.outbox_rows.len(),
            shadow_count: self.shadow_rows.len(),
            schema_versions: self.schema_versions.clone(),
        }
    }

    pub fn assert_same(&self, other: &Self, context: &str) -> AccountResult<()> {
        if self.fingerprint != other.fingerprint || self.summary() != other.summary() {
            return Err(AccountError::VerificationMismatch(context.to_owned()));
        }
        Ok(())
    }
}

pub fn read_snapshot(path: &Path) -> AccountResult<DataSnapshot> {
    let connection = open_read_only(path)?;
    connection.busy_timeout(std::time::Duration::from_secs(5))?;
    let integrity = integrity_check(&connection, path)?;
    let mut counts = BTreeMap::new();
    for table in [
        "local_lists",
        "local_tasks",
        "local_steps",
        "local_day_plans",
        "outbox",
        "server_shadow",
        "kv_state",
        "schema_migrations",
    ] {
        if table_exists(&connection, table)? {
            let count: i64 =
                connection.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                    row.get(0)
                })?;
            counts.insert(table.to_owned(), count);
        }
    }
    let (device_id, sync_cursor, client_seq, bound_account) =
        if table_exists(&connection, "kv_state")? {
            (
                kv_get(&connection, "device_id")?,
                kv_get(&connection, "sync_cursor")?,
                kv_get(&connection, "client_seq")?,
                kv_get(&connection, "bound_account")?,
            )
        } else {
            (None, None, None, None)
        };
    let outbox_rows = if table_exists(&connection, "outbox")? {
        let mut statement = connection.prepare(
            "SELECT op_id, device_id, client_seq, entity_type, entity_id, kind,
                    patch_json, sync_status, error_code
             FROM outbox ORDER BY op_id",
        )?;
        statement
            .query_map([], |row| {
                Ok(serde_json::json!([
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, String>(6)?,
                    row.get::<_, String>(7)?,
                    row.get::<_, Option<String>>(8)?,
                ])
                .to_string())
            })?
            .collect::<Result<Vec<_>, _>>()?
    } else {
        Vec::new()
    };
    let shadow_rows = if table_exists(&connection, "server_shadow")? {
        let mut statement = connection.prepare(
            "SELECT entity_type, entity_id, server_rev, payload_json
             FROM server_shadow ORDER BY entity_type, entity_id",
        )?;
        statement
            .query_map([], |row| {
                Ok(serde_json::json!([
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, String>(3)?,
                ])
                .to_string())
            })?
            .collect::<Result<Vec<_>, _>>()?
    } else {
        Vec::new()
    };
    let schema_versions = if table_exists(&connection, "schema_migrations")? {
        let mut statement =
            connection.prepare("SELECT version FROM schema_migrations ORDER BY version")?;
        statement
            .query_map([], |row| row.get::<_, i64>(0))?
            .collect::<Result<Vec<_>, _>>()?
    } else {
        Vec::new()
    };
    let mut snapshot = DataSnapshot {
        integrity,
        counts,
        device_id,
        sync_cursor,
        client_seq,
        bound_account,
        outbox_rows,
        shadow_rows,
        schema_versions,
        fingerprint: String::new(),
    };
    let input = serde_json::to_vec(&FingerprintInput {
        integrity: &snapshot.integrity,
        counts: &snapshot.counts,
        device_id: &snapshot.device_id,
        sync_cursor: &snapshot.sync_cursor,
        client_seq: &snapshot.client_seq,
        bound_account: &snapshot.bound_account,
        outbox_rows: &snapshot.outbox_rows,
        shadow_rows: &snapshot.shadow_rows,
        schema_versions: &snapshot.schema_versions,
    })?;
    snapshot.fingerprint = hex(&Sha256::digest(input));
    Ok(snapshot)
}

pub fn verify_integrity(path: &Path) -> AccountResult<()> {
    let connection = open_read_only(path)?;
    integrity_check(&connection, path)?;
    Ok(())
}

pub fn integrity_check(connection: &Connection, path: &Path) -> AccountResult<String> {
    let mut statement = connection.prepare("PRAGMA integrity_check")?;
    let rows = statement
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    let result = rows.join("; ");
    if result != "ok" {
        return Err(AccountError::Integrity {
            path: path.to_path_buf(),
            detail: result,
        });
    }
    Ok(result)
}

pub fn table_exists(connection: &Connection, table: &str) -> AccountResult<bool> {
    Ok(connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1)",
        [table],
        |row| row.get::<_, i64>(0),
    )? != 0)
}

pub fn kv_get(connection: &Connection, key: &str) -> AccountResult<Option<String>> {
    if !table_exists(connection, "kv_state")? {
        return Ok(None);
    }
    let value = connection
        .query_row(
            "SELECT value FROM kv_state WHERE key=?1",
            params![key],
            |row| row.get::<_, String>(0),
        )
        .optional()?;
    Ok(value.filter(|value| !value.is_empty()))
}

fn open_read_only(path: &Path) -> AccountResult<Connection> {
    if !path.is_file() {
        return Err(AccountError::Io(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            format!("database not found: {}", path.display()),
        )));
    }
    match Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY) {
        Ok(connection) => Ok(connection),
        // A WAL database without a usable shm sidecar can reject read-only
        // opens; a normal connection is still non-mutating for our queries.
        Err(_) => Ok(Connection::open(path)?),
    }
}

fn hex(bytes: &[u8]) -> String {
    let mut result = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        use std::fmt::Write as _;
        let _ = write!(result, "{byte:02x}");
    }
    result
}

use rusqlite::OptionalExtension;
