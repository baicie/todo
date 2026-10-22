/// Normalize an email for account lookup. Email local parts are technically
/// case-sensitive, but every mainstream identity provider treats them
/// case-insensitively; using one canonical value avoids duplicate accounts.
pub fn normalize_email(input: &str) -> Result<String, EmailError> {
    let trimmed = input.trim();
    if trimmed.len() > 254 {
        return Err(EmailError);
    }
    let mut parts = trimmed.split('@');
    let local = parts.next().unwrap_or_default();
    let domain = parts.next().unwrap_or_default();
    if parts.next().is_some()
        || local.is_empty()
        || local.len() > 64
        || domain.is_empty()
        || domain.len() > 253
    {
        return Err(EmailError);
    }
    if local.starts_with('.')
        || local.ends_with('.')
        || local.contains("..")
        || !local.bytes().all(is_valid_local_byte)
    {
        return Err(EmailError);
    }
    if !domain.contains('.') || domain.split('.').any(|label| !valid_domain_label(label)) {
        return Err(EmailError);
    }
    Ok(trimmed.to_ascii_lowercase())
}

fn is_valid_local_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric()
        || matches!(
            byte,
            b'.' | b'!'
                | b'#'
                | b'$'
                | b'%'
                | b'&'
                | b'\''
                | b'*'
                | b'+'
                | b'-'
                | b'/'
                | b'='
                | b'?'
                | b'^'
                | b'_'
                | b'`'
                | b'{'
                | b'|'
                | b'}'
                | b'~'
        )
}

fn valid_domain_label(label: &str) -> bool {
    !label.is_empty()
        && label.len() <= 63
        && !label.starts_with('-')
        && !label.ends_with('-')
        && label
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EmailError;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn email_is_normalized() {
        assert_eq!(
            normalize_email("  Person@Example.COM ").unwrap(),
            "person@example.com"
        );
    }

    #[test]
    fn malformed_emails_are_rejected() {
        for value in [
            "",
            "missing-at.example.com",
            "a@b",
            "a@@example.com",
            "@example.com",
            "a@.example.com",
            "a@example..com",
            "a@-example.com",
            "a b@example.com",
            ".a@example.com",
            "a.@example.com",
            "a..b@example.com",
            "é@example.com",
        ] {
            assert!(normalize_email(value).is_err(), "{value:?}");
        }
    }
}
