use std::fmt;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct ChangeCursor(i64);

impl ChangeCursor {
    pub fn initial() -> Self {
        Self(0)
    }

    pub fn parse(value: &str) -> Result<Self, CursorError> {
        if value.is_empty() || !value.bytes().all(|byte| byte.is_ascii_digit()) {
            return Err(CursorError);
        }
        let parsed = value.parse::<i64>().map_err(|_| CursorError)?;
        if parsed < 0 {
            return Err(CursorError);
        }
        Ok(Self(parsed))
    }

    pub fn get(self) -> i64 {
        self.0
    }
}

impl fmt::Display for ChangeCursor {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}", self.0)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CursorError;

impl fmt::Display for CursorError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("cursor must be a non-negative base-10 integer")
    }
}

pub fn parse_page_limit(
    value: Option<u32>,
    default: u32,
    maximum: u32,
) -> Result<u32, CursorError> {
    match value {
        None => Ok(default),
        Some(value) if value >= 1 && value <= maximum => Ok(value),
        Some(_) => Err(CursorError),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cursor_accepts_zero_and_positive_numbers() {
        assert_eq!(ChangeCursor::parse("0").unwrap().get(), 0);
        assert_eq!(ChangeCursor::parse("42").unwrap().get(), 42);
        assert_eq!(ChangeCursor::parse("00042").unwrap().get(), 42);
    }

    #[test]
    fn cursor_rejects_negative_or_signed_values() {
        for invalid in ["", "-1", "+2", " 2", "2 ", "1.5", "abc"] {
            assert!(ChangeCursor::parse(invalid).is_err(), "{invalid:?}");
        }
    }

    #[test]
    fn cursor_rejects_overflow() {
        assert!(ChangeCursor::parse("999999999999999999999999999").is_err());
    }

    #[test]
    fn page_limits_are_bounded() {
        assert_eq!(parse_page_limit(None, 500, 500).unwrap(), 500);
        assert_eq!(parse_page_limit(Some(1), 500, 500).unwrap(), 1);
        assert_eq!(parse_page_limit(Some(500), 500, 500).unwrap(), 500);
        assert!(parse_page_limit(Some(0), 500, 500).is_err());
        assert!(parse_page_limit(Some(501), 500, 500).is_err());
    }
}
