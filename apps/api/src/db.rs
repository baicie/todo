use sqlx::{PgPool, migrate::Migrator};

/// Embedded migrations are the single source of truth for startup and
/// readiness checks.
pub static MIGRATOR: Migrator = sqlx::migrate!("../../db/postgres/migrations");

pub fn expected_schema_version() -> i64 {
    MIGRATOR
        .iter()
        .map(|migration| migration.version)
        .max()
        .unwrap_or(0)
}

/// Returns true only when SQLx has recorded every embedded migration and no
/// migration has failed. It deliberately does not expose SQL errors to callers.
pub async fn schema_is_current(pool: &PgPool) -> Result<bool, sqlx::Error> {
    let row: (Option<i64>, i64) = sqlx::query_as(
        "SELECT MAX(version) FILTER (WHERE success), \
         COUNT(*) FILTER (WHERE NOT success) \
         FROM _sqlx_migrations",
    )
    .fetch_one(pool)
    .await?;
    Ok(row.0 == Some(expected_schema_version()) && row.1 == 0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn embedded_migrations_are_ordered_and_have_a_version() {
        let versions: Vec<i64> = MIGRATOR.iter().map(|migration| migration.version).collect();
        assert!(!versions.is_empty());
        assert!(versions.windows(2).all(|window| window[0] < window[1]));
        assert_eq!(expected_schema_version(), versions.last().copied().unwrap());
    }
}
