//! Build-identity isolation for the three Shishi channels.
//!
//! The desktop credential namespace is a pure function of the runtime Tauri
//! identifier, so a build can only reach its own namespace. An unknown
//! identifier resolves to nothing and the credential path fails closed instead
//! of falling back to the Stable namespace that holds existing refresh tokens.
//!
//! This is independent of the `native-qa` cargo feature: that feature only
//! selects fault injection and the in-memory QA credential backend.

use std::fmt;

/// The shipping channels, in packaging order.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Channel {
    Stable,
    Dev,
    Qa,
}

impl Channel {
    /// Every channel, used by `resolve` and the packaging contract test.
    pub const ALL: [Self; 3] = [Self::Stable, Self::Dev, Self::Qa];

    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Stable => "stable",
            Self::Dev => "dev",
            Self::Qa => "qa",
        }
    }

    /// The Tauri identifier that selects this channel.
    pub const fn identifier(self) -> &'static str {
        match self {
            Self::Stable => "app.shishi.todo",
            Self::Dev => "app.shishi.todo.dev",
            Self::Qa => "app.shishi.todo.qa",
        }
    }

    /// The desktop credential service (Windows Credential Manager target).
    /// The Stable and QA values predate channel isolation and must stay
    /// byte-identical: existing refreshes live under both of them.
    pub const fn credential_service(self) -> &'static str {
        match self {
            Self::Stable => "app.shishi.todo.secure-token",
            Self::Dev => "app.shishi.todo.dev.secure-token",
            Self::Qa => "app.shishi.todo.rc2d-qa.secure-token",
        }
    }

    pub const fn is_dev(self) -> bool {
        matches!(self, Self::Dev)
    }

    pub const fn is_qa(self) -> bool {
        matches!(self, Self::Qa)
    }
}

/// The runtime identifier matched no channel. The credential layer returns
/// this instead of selecting the Stable namespace.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UnknownIdentifier(String);

impl fmt::Display for UnknownIdentifier {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "unknown build identifier {}: no credential namespace selected",
            self.0
        )
    }
}

/// Map a runtime Tauri identifier to its channel.
///
/// There is no default: an unknown identifier is an error, so a build with a
/// typo'd identifier cannot reach another channel's credentials or data root.
pub fn resolve(identifier: &str) -> Result<Channel, UnknownIdentifier> {
    Channel::ALL
        .into_iter()
        .find(|channel| channel.identifier() == identifier)
        .ok_or_else(|| UnknownIdentifier(identifier.to_owned()))
}

#[cfg(test)]
mod tests {
    use super::*;

    const STABLE_CONFIG: &str = include_str!("../tauri.conf.json");
    const DEV_CONFIG: &str = include_str!("../tauri.dev.conf.json");
    const QA_CONFIG: &str = include_str!("../tauri.qa.conf.json");

    fn field(config: &serde_json::Value, pointer: &str) -> String {
        config
            .pointer(pointer)
            .and_then(serde_json::Value::as_str)
            .unwrap_or_else(|| panic!("config is missing string {pointer}"))
            .to_owned()
    }

    #[track_caller]
    fn assert_pairwise_distinct(values: &[String], label: &str) {
        for (index, value) in values.iter().enumerate() {
            for other in &values[index + 1..] {
                assert_ne!(value, other, "{label} collide: {value}");
            }
        }
    }

    #[test]
    fn every_known_identifier_maps_to_its_own_service() {
        assert_eq!(resolve("app.shishi.todo"), Ok(Channel::Stable));
        assert_eq!(resolve("app.shishi.todo.dev"), Ok(Channel::Dev));
        assert_eq!(resolve("app.shishi.todo.qa"), Ok(Channel::Qa));
        assert_eq!(
            Channel::Stable.credential_service(),
            "app.shishi.todo.secure-token"
        );
        assert_eq!(
            Channel::Dev.credential_service(),
            "app.shishi.todo.dev.secure-token"
        );
        assert_eq!(Channel::Stable.as_str(), "stable");
        assert_eq!(Channel::Dev.as_str(), "dev");
        assert!(Channel::Dev.is_dev());
        assert!(!Channel::Dev.is_qa());
        assert!(Channel::Qa.is_qa());
        assert!(!Channel::Stable.is_dev());
    }

    #[test]
    fn unknown_identifier_is_refused_not_defaulted() {
        let error = resolve("app.shishi.todo.devv").expect_err("unknown identifier");
        assert!(
            error.to_string().contains("app.shishi.todo.devv"),
            "error must name the rejected identifier: {error}"
        );
        assert!(
            error
                .to_string()
                .contains("no credential namespace selected"),
            "error must state that no namespace was selected: {error}"
        );
        // Neither a truncated nor a service-shaped identifier may resolve.
        for identifier in [
            "",
            "app.shishi.todo.",
            "APP.SHISHI.TODO",
            "app.shishi.todo.secure-token",
            "app.shishi.todo.dev.secure-token",
        ] {
            assert!(
                resolve(identifier).is_err(),
                "{identifier:?} must not resolve to a channel"
            );
        }
    }

    #[test]
    fn identifier_and_service_mapping_is_injective() {
        let identifiers: Vec<String> = Channel::ALL
            .iter()
            .map(|channel| channel.identifier().to_owned())
            .collect();
        assert_pairwise_distinct(&identifiers, "identifier");
        let services: Vec<String> = Channel::ALL
            .iter()
            .map(|channel| channel.credential_service().to_owned())
            .collect();
        assert_pairwise_distinct(&services, "credential namespace");
        for identifier in &identifiers {
            let channel = resolve(identifier).expect("known identifier");
            assert_eq!(&channel.identifier(), identifier);
        }
    }

    #[test]
    fn qa_credential_namespace_is_unchanged() {
        assert_eq!(
            resolve("app.shishi.todo.qa")
                .expect("qa")
                .credential_service(),
            "app.shishi.todo.rc2d-qa.secure-token"
        );
    }

    #[test]
    fn packaging_contract_keeps_three_build_identities_apart() {
        let stable = serde_json::from_str::<serde_json::Value>(STABLE_CONFIG).expect("stable json");
        let dev = serde_json::from_str::<serde_json::Value>(DEV_CONFIG).expect("dev json");
        let qa = serde_json::from_str::<serde_json::Value>(QA_CONFIG).expect("qa json");
        let configs = [("stable", &stable), ("dev", &dev), ("qa", &qa)];

        let identifiers: Vec<String> = configs
            .iter()
            .map(|(_, config)| field(config, "/identifier"))
            .collect();
        assert_eq!(identifiers[0], "app.shishi.todo");
        assert_eq!(identifiers[1], "app.shishi.todo.dev");
        assert_eq!(identifiers[2], "app.shishi.todo.qa");
        assert_pairwise_distinct(&identifiers, "identifier");

        let services: Vec<String> = identifiers
            .iter()
            .map(|identifier| {
                resolve(identifier)
                    .expect("config identifier must be a known channel")
                    .credential_service()
                    .to_owned()
            })
            .collect();
        assert_pairwise_distinct(&services, "credential namespace");
        assert_eq!(services[2], "app.shishi.todo.rc2d-qa.secure-token");

        let products: Vec<String> = configs
            .iter()
            .map(|(_, config)| field(config, "/productName"))
            .collect();
        assert_eq!(products[1], "Shishi Dev");
        assert_pairwise_distinct(&products, "productName");

        for (label, config) in configs {
            assert_eq!(
                config.pointer("/bundle/active").and_then(|v| v.as_bool()),
                Some(true),
                "{label} config must keep bundle.active true"
            );
        }
        assert_eq!(
            dev.pointer("/bundle/windows/nsis/installMode")
                .and_then(|v| v.as_str()),
            Some("currentUser")
        );
    }

    #[test]
    #[should_panic(expected = "identifier collide")]
    fn packaging_contract_rejects_colliding_identities() {
        assert_pairwise_distinct(
            &["app.shishi.todo".to_owned(), "app.shishi.todo".to_owned()],
            "identifier",
        );
    }
}
