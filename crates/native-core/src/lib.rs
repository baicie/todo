//! Pure SQLite repository and command contract for the Shishi native client.
//!
//! This crate intentionally has no Tauri dependency. The Tauri shell wraps
//! [`TodoStore`] in `spawn_blocking`; tests exercise the same code directly.

mod dispatch;
mod error;
mod models;
mod store;

pub use dispatch::{action_names, dispatch, dispatch_tauri_arguments, error_payload};
pub use error::{ErrorCode, StoreError};
pub use models::*;
pub use store::TodoStore;
