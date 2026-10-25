//! QA-only fault injection configuration and isolated fixtures.
//!
//! This module is compiled only with the `native-qa` feature. It is armed by an
//! explicit process argument, never by an environment variable or a WebView
//! command. The build refuses to run unless the Tauri identifier is the QA
//! identifier, so a QA binary cannot accidentally write a production data root.

use std::{
    collections::HashMap,
    fs::{self, File, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

use serde::Deserialize;
use tauri::{AppHandle, Manager};
use todo_native_accounts::{FaultAction, FaultEvent, FaultEvidence, FaultInjector, FaultPoint};

use crate::secure_tokens::{self, CredentialBackend};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FaultConfig {
    evidence_path: PathBuf,
    #[serde(default)]
    rules: Vec<FaultRule>,
    #[serde(default)]
    credential_backend: CredentialBackendKind,
}

#[derive(Debug, Clone, Copy, Default, Deserialize)]
#[serde(rename_all = "snake_case")]
enum CredentialBackendKind {
    #[default]
    Os,
    Memory,
}

#[derive(Debug, Deserialize)]
struct FaultRule {
    point: FaultPoint,
    action: Action,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum Action {
    Error { code: String, message: String },
    Block { duration_ms: u64 },
    Terminate { exit_code: i32 },
}

impl From<Action> for FaultAction {
    fn from(action: Action) -> Self {
        match action {
            Action::Error { code, message } => Self::Error { code, message },
            Action::Block { duration_ms } => Self::Block { duration_ms },
            Action::Terminate { exit_code } => Self::Terminate { exit_code },
        }
    }
}

struct FileInjector {
    rules: Mutex<HashMap<FaultPoint, FaultAction>>,
    evidence: Mutex<File>,
}

impl FaultInjector for FileInjector {
    fn decide(&self, event: &FaultEvent) -> Option<FaultAction> {
        self.rules
            .lock()
            .ok()
            .and_then(|rules| rules.get(&event.point).cloned())
    }

    fn record(&self, evidence: &FaultEvidence) {
        if let Ok(mut file) = self.evidence.lock()
            && let Ok(line) = serde_json::to_string(evidence)
        {
            let _ = writeln!(file, "{line}");
            let _ = file.flush();
        }
    }
}

#[derive(Default)]
struct MemoryCredentialBackend {
    values: Mutex<HashMap<String, String>>,
}

impl CredentialBackend for MemoryCredentialBackend {
    fn get(&self, key: &str) -> Result<Option<String>, String> {
        Ok(self
            .values
            .lock()
            .map_err(|_| "QA credential store poisoned".to_owned())?
            .get(key)
            .cloned())
    }

    fn set(&self, key: &str, value: &str) -> Result<(), String> {
        self.values
            .lock()
            .map_err(|_| "QA credential store poisoned".to_owned())?
            .insert(key.to_owned(), value.to_owned());
        Ok(())
    }

    fn delete(&self, key: &str) -> Result<(), String> {
        self.values
            .lock()
            .map_err(|_| "QA credential store poisoned".to_owned())?
            .remove(key);
        Ok(())
    }
}

fn argument_value(name: &str) -> Option<PathBuf> {
    let args: Vec<String> = std::env::args().collect();
    args.windows(2)
        .find(|pair| pair[0] == name)
        .map(|pair| PathBuf::from(&pair[1]))
}

fn require_qa_identifier(app: &AppHandle) -> Result<(), String> {
    let identifier = app.config().identifier.clone();
    if identifier.starts_with("app.shishi.todo.qa") {
        Ok(())
    } else {
        Err(format!(
            "QA fault injection refused for non-QA identifier {identifier}"
        ))
    }
}

fn open_evidence(path: &Path) -> Result<File, String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|error| error.to_string())
}

pub fn initialize(app: &AppHandle) -> Result<(), String> {
    require_qa_identifier(app)?;
    let Some(config_path) = argument_value("--rc2d-fault-config") else {
        return Ok(());
    };
    if !config_path.is_file() {
        return Err(format!(
            "QA fault config does not exist: {}",
            config_path.display()
        ));
    }
    let raw = fs::read(&config_path).map_err(|error| error.to_string())?;
    let config: FaultConfig = serde_json::from_slice(&raw).map_err(|error| error.to_string())?;
    let rules = config
        .rules
        .into_iter()
        .map(|rule| (rule.point, rule.action.into()))
        .collect();
    let injector = Arc::new(FileInjector {
        rules: Mutex::new(rules),
        evidence: Mutex::new(open_evidence(&config.evidence_path)?),
    });
    todo_native_accounts::fault::install(injector)
        .map_err(|error| format!("unable to install QA fault injector: {error}"))?;
    if matches!(config.credential_backend, CredentialBackendKind::Memory) {
        secure_tokens::install_qa_backend(Arc::new(MemoryCredentialBackend::default()))?;
    }
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    fs::create_dir_all(&app_data).map_err(|error| error.to_string())?;
    Ok(())
}
