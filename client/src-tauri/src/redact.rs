use regex::Regex;
use std::sync::OnceLock;

const MASK: &str = "[REDACTED]";

fn patterns() -> &'static [(Regex, &'static str)] {
    static PATTERNS: OnceLock<Vec<(Regex, &'static str)>> = OnceLock::new();
    PATTERNS.get_or_init(|| {
        [
            (
                r"(?s)-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----.*?(-----END [A-Z0-9 ]*PRIVATE KEY-----|\z)",
                MASK,
            ),
            (r"\b(AKIA|ASIA)[0-9A-Z]{16}\b", MASK),
            (r"\bgh[pousr]_[A-Za-z0-9]{30,}\b", MASK),
            (r"\bgithub_pat_[A-Za-z0-9_]{30,}\b", MASK),
            (r"\bglpat-[A-Za-z0-9_\-]{20,}\b", MASK),
            (r"\bsk-(proj-|ant-)?[A-Za-z0-9_\-]{20,}\b", MASK),
            (r"\bxox[abprs]-[A-Za-z0-9\-]{10,}\b", MASK),
            (r"\bAIza[0-9A-Za-z_\-]{35}\b", MASK),
            (
                r"\beyJ[A-Za-z0-9_\-]{8,}\.eyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\b",
                MASK,
            ),
            (r"(?i)\b(bearer|basic)\s+[A-Za-z0-9._~+/=\-]{12,}", "$1 [REDACTED]"),
            (
                r#"(?i)\b([A-Z0-9_]*(password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret)[A-Z0-9_]*)(\s*[:=]\s*)("[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)"#,
                "$1$3[REDACTED]",
            ),
            (r"(?i)\b([a-z][a-z0-9+.\-]*://)[^/\s:@]+:[^/\s@]+@", "$1[REDACTED]@"),
        ]
        .into_iter()
        .filter_map(|(p, r)| Regex::new(p).ok().map(|re| (re, r)))
        .collect()
    })
}

/// Masks common secret shapes before local output leaves the PC.
pub fn redact(text: &str) -> String {
    let mut out = text.to_string();
    for (re, replacement) in patterns() {
        out = re.replace_all(&out, *replacement).into_owned();
    }
    out
}

/// Bounded, redacted, valid UTF-8 text with a truncation flag.
pub fn bounded_text(bytes: &[u8], limit: usize) -> (String, bool) {
    let truncated = bytes.len() > limit;
    let mut end = bytes.len().min(limit);
    if truncated {
        let floor = end.saturating_sub(3);
        while end > floor && std::str::from_utf8(&bytes[..end]).is_err() {
            end -= 1;
        }
    }
    let text = String::from_utf8_lossy(&bytes[..end]);
    (redact(&text), truncated)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn masks_known_secret_shapes() {
        let aws = format!("{}{}", "AKIA", "ABCDEFGHIJKLMNOP");
        let gh = format!("ghp_{}", "abcdefghijklmnopqrstuvwxyz0123456789");
        let openai = format!("sk-proj-{}", "abcdefghijklmnopqrstuvwx");
        let bearer = format!("{}{}", "abcdefghij", "klmnopqrstu");
        let password = format!("{}{}", "hunter2", "hunter2");
        let quoted = "quoted value";
        let key_body = format!("{}{}", "b3BlbnNzaC1r", "ZXktdjEAAAAA");
        let jwt_sig = format!("{}{}", "c2lnbmF0", "dXJlLXZhbHVl");
        let jwt = format!(
            "{}.{}.{}",
            format!("{}{}", "eyJ", "hbGciOiJIUzI1NiJ9"),
            format!("{}{}", "eyJ", "zdWIiOiIxMjM0NTY3ODkwIn0"),
            &jwt_sig
        );
        let header = format!("-----BEGIN {}-----", "OPENSSH PRIVATE KEY");
        let footer = format!("-----END {}-----", "OPENSSH PRIVATE KEY");
        let input = format!(
            "AWS={aws}\ngh={gh}\nopenai {openai}\nAuthorization: Bearer {bearer}\nDB_PASSWORD={password}\napi_key: \"{quoted}\"\nurl=https://user:pa55@example.com/x\n{header}\n{key_body}\n{footer}\njwt {jwt}"
        );
        let out = redact(&input);
        for leaked in [&aws, &gh, &openai, &bearer, &password, quoted, "pa55", &key_body, &jwt_sig] {
            assert!(!out.contains(leaked), "leaked {leaked}: {out}");
        }
        assert!(out.contains("DB_PASSWORD=[REDACTED]"));
        assert!(out.contains("https://[REDACTED]@example.com/x"));
    }

    #[test]
    fn unterminated_private_key_is_masked_to_end() {
        let header = format!("-----BEGIN {}-----", "RSA PRIVATE KEY");
        let body = "MIIEow";
        let out = redact(&format!("x\n{header}\n{body}"));
        assert!(!out.contains(body));
    }

    #[test]
    fn ordinary_text_is_unchanged() {
        let text = "build ok: 12 passed, token count 40";
        assert_eq!(redact(text), text);
    }

    #[test]
    fn bounded_text_truncates_and_keeps_utf8() {
        let (text, truncated) = bounded_text("привет".as_bytes(), 3);
        assert!(truncated);
        assert_eq!(text, "п");
    }
}
