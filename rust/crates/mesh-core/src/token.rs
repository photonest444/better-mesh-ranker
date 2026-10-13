//! Токен МЭШ: распознавание, извлечение из текста/URL/JSON, разбор JWT и маска.
//!
//! Полный порт `shared/core/mesh-core.js` (раздел «Токен»), включая «мягкий»
//! режим для демо-сервера: там токены короткие (`mock-token-1`) и строгая
//! проверка формата отключается.

use crate::json::Json;

/// Ключи, по которым МЭШ (и страница входа) отдаёт токен.
pub const TOKEN_KEYS: [&str; 8] = [
    "token",
    "access_token",
    "accesstoken",
    "auth_token",
    "authtoken",
    "auth-token",
    "bearer",
    "jwt",
];

fn is_base64url_char(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_'
}

fn is_opaque_char(byte: u8) -> bool {
    byte.is_ascii_alphanumeric()
        || matches!(byte, b'.' | b'_' | b'~' | b'+' | b'/' | b'=' | b'-')
}

fn is_key_char(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.')
}

/// Похоже ли на JWT: три сегмента base64url, первый начинается с «eyJ».
pub fn jwt_like(value: &str) -> bool {
    let parts: Vec<&str> = value.split('.').collect();
    if parts.len() != 3 {
        return false;
    }
    if !parts[0].starts_with("eyJ") || parts[0].len() < 8 {
        return false;
    }
    parts
        .iter()
        .all(|part| part.len() >= 5 && part.as_bytes().iter().all(|b| is_base64url_char(*b)))
}

/// Находит JWT внутри произвольного текста (аналог регулярного выражения `JWT_RE`).
pub fn find_jwt(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let mut index = 0usize;
    while index + 3 <= bytes.len() {
        if &bytes[index..index + 3] == b"eyJ" {
            let mut end = index;
            while end < bytes.len() && (is_base64url_char(bytes[end]) || bytes[end] == b'.') {
                end += 1;
            }
            let candidate = &text[index..end];
            if jwt_like(candidate) {
                return Some(candidate.to_string());
            }
            index = end.max(index + 1);
        } else {
            index += 1;
        }
    }
    None
}

/// Значение целиком похоже на токен МЭШ (JWT или длинная «непрозрачная» строка).
pub fn looks_like_token(value: &str) -> bool {
    let trimmed = value.trim();
    if trimmed.chars().count() < 20 || trimmed.chars().any(|c| c.is_whitespace()) {
        return false;
    }
    if find_jwt(trimmed).is_some() {
        return true;
    }
    opaque_token(trimmed)
}

/// Строка целиком — это токен, а не текст, внутри которого он встречается.
pub fn is_whole_token(value: &str) -> bool {
    let trimmed = value.trim();
    if trimmed.chars().count() < 20 || trimmed.chars().any(|c| c.is_whitespace()) {
        return false;
    }
    if jwt_like(trimmed) {
        return true;
    }
    opaque_token(trimmed)
}

fn opaque_token(value: &str) -> bool {
    if value.chars().count() < 24 {
        return false;
    }
    if !value.as_bytes().iter().all(|byte| is_opaque_char(*byte)) {
        return false;
    }
    let has_letter = value.chars().any(|c| c.is_alphabetic());
    let has_digit = value.chars().any(|c| c.is_numeric());
    has_letter && has_digit
}

/// Декодирование base64url (без паддинга) — для разбора полезной нагрузки JWT.
pub fn base64url_decode(value: &str) -> Option<Vec<u8>> {
    let mut buffer: u32 = 0;
    let mut bits: u32 = 0;
    let mut out: Vec<u8> = Vec::with_capacity(value.len() * 3 / 4 + 3);
    for byte in value.bytes() {
        let digit = match byte {
            b'A'..=b'Z' => (byte - b'A') as u32,
            b'a'..=b'z' => (byte - b'a') as u32 + 26,
            b'0'..=b'9' => (byte - b'0') as u32 + 52,
            b'-' | b'+' => 62,
            b'_' | b'/' => 63,
            b'=' => continue,
            _ => return None,
        };
        buffer = (buffer << 6) | digit;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push(((buffer >> bits) & 0xFF) as u8);
        }
    }
    Some(out)
}

/// Разбор полезной нагрузки JWT без проверки подписи (только для отображения).
pub fn decode_jwt(token: &str) -> Option<Json> {
    let parts: Vec<&str> = token.split('.').collect();
    if parts.len() < 2 {
        return None;
    }
    let decoded = base64url_decode(parts[1])?;
    let text = String::from_utf8_lossy(&decoded);
    Json::parse(&text).ok()
}

/// Сведения о токене: тип, маска, срок действия (как `describeToken` в JS).
pub fn describe_token(token: Option<&str>, now_ms: i64) -> Json {
    let token = match token {
        Some(value) if !value.is_empty() => value,
        _ => {
            return Json::object(vec![
                ("present", Json::Bool(false)),
                ("kind", Json::str("none")),
                ("mask", Json::str("—")),
                ("expiresAt", Json::Null),
                ("issuedAt", Json::Null),
                ("subjects", Json::Null),
                ("length", Json::Num(0.0)),
                ("expired", Json::Bool(false)),
            ])
        }
    };
    let jwt = decode_jwt(token);
    let expires_at = jwt.as_ref().and_then(|value| value.get("exp")).and_then(Json::as_i64);
    let issued_at = jwt.as_ref().and_then(|value| value.get("iat")).and_then(Json::as_i64);
    let subject = jwt.as_ref().and_then(|value| value.get("sub")).map(|value| value.text());
    let expires_ms = expires_at.map(|seconds| seconds * 1000);
    Json::object(vec![
        ("present", Json::Bool(true)),
        ("kind", Json::str(if jwt.is_some() { "jwt" } else { "opaque" })),
        ("mask", Json::str(mask_token(token))),
        ("expiresAt", Json::int(expires_ms)),
        ("issuedAt", Json::int(issued_at.map(|seconds| seconds * 1000))),
        ("subjects", Json::text_or_null(&subject)),
        ("length", Json::Num(token.chars().count() as f64)),
        ("expired", Json::Bool(match expires_ms {
            Some(value) => value < now_ms,
            None => false,
        })),
    ])
}

/// «abcdef…yz12» — токен показываем только частично.
pub fn mask_token(token: &str) -> String {
    let chars: Vec<char> = token.chars().collect();
    if chars.len() <= 12 {
        return chars.iter().map(|_| '•').collect();
    }
    let head: String = chars[..6].iter().collect();
    let tail: String = chars[chars.len() - 4..].iter().collect();
    format!("{}…{}", head, tail)
}

/// Рекурсивный поиск токена в JSON-структуре (сначала «говорящие» ключи).
pub fn extract_token_from_object(value: &Json) -> Option<String> {
    extract_at_depth(value, 0)
}

fn extract_at_depth(value: &Json, depth: usize) -> Option<String> {
    if depth > 6 {
        return None;
    }
    match value {
        Json::Str(text) => {
            if looks_like_token(text) {
                return Some(text.trim().to_string());
            }
            None
        }
        Json::Arr(items) => {
            for item in items {
                if let Some(found) = extract_at_depth(item, depth + 1) {
                    return Some(found);
                }
            }
            None
        }
        Json::Obj(entries) => {
            for (key, item) in entries {
                let lowered = key.to_lowercase();
                if TOKEN_KEYS.contains(&lowered.as_str()) {
                    if let Json::Str(text) = item {
                        if looks_like_token(text) {
                            return Some(text.trim().to_string());
                        }
                    }
                }
            }
            for (_, item) in entries {
                if let Some(found) = extract_at_depth(item, depth + 1) {
                    return Some(found);
                }
            }
            None
        }
        _ => None,
    }
}

/// Поиск токена в JSON, HTML или обычной строке.
pub fn extract_token_from_text(text: &str) -> Option<String> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return None;
    }
    if is_whole_token(trimmed) {
        return Some(trimmed.to_string());
    }
    if let Ok(parsed) = Json::parse(trimmed) {
        if let Some(found) = extract_token_from_object(&parsed) {
            return Some(found);
        }
    }
    if let Some(found) = token_by_key(trimmed) {
        return Some(found);
    }
    if let Some(found) = find_jwt(trimmed) {
        return Some(found);
    }
    None
}

/// `"token": "…"` / `"access_token": "…"` внутри произвольного текста.
fn token_by_key(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let mut index = 0usize;
    while index < bytes.len() {
        if bytes[index] != b'"' {
            index += 1;
            continue;
        }
        let start = index + 1;
        let mut end = start;
        while end < bytes.len() && is_key_char(bytes[end]) {
            end += 1;
        }
        if end == start || end >= bytes.len() || bytes[end] != b'"' {
            index = end.max(index + 1);
            continue;
        }
        let key = text[start..end].to_lowercase();
        if TOKEN_KEYS.contains(&key.as_str()) {
            let mut cursor = end + 1;
            while cursor < bytes.len() && (bytes[cursor] == b' ' || bytes[cursor] == b'\t') {
                cursor += 1;
            }
            let separator_ok = cursor < bytes.len() && (bytes[cursor] == b':' || bytes[cursor] == b'=');
            if separator_ok {
                cursor += 1;
                while cursor < bytes.len() && (bytes[cursor] == b' ' || bytes[cursor] == b'\t') {
                    cursor += 1;
                }
                if cursor < bytes.len() && bytes[cursor] == b'"' {
                    let value_start = cursor + 1;
                    let mut value_end = value_start;
                    while value_end < bytes.len() && bytes[value_end] != b'"' {
                        value_end += 1;
                    }
                    let candidate = &text[value_start..value_end];
                    if candidate.len() >= 16 && looks_like_token(candidate) {
                        return Some(candidate.to_string());
                    }
                }
            }
        }
        index = end + 1;
    }
    None
}

/// Поиск токена в URL: `?token=…`, `#access_token=…`, `…&auth_token=…`.
pub fn extract_token_from_url(url: &str) -> Option<String> {
    let bytes = url.as_bytes();
    let patterns: [&str; 3] = ["token=", "access_token=", "auth_token="];
    for pattern in patterns {
        let mut search_from = 0usize;
        while let Some(offset) = url[search_from..].find(pattern) {
            let position = search_from + offset;
            let prefix_ok = position > 0
                && matches!(bytes[position - 1], b'?' | b'&' | b'#');
            if prefix_ok {
                let value_start = position + pattern.len();
                let mut value_end = value_start;
                while value_end < bytes.len() {
                    let byte = bytes[value_end];
                    if byte == b'&' || byte == b'#' || byte == b' ' || byte == b'\t' {
                        break;
                    }
                    value_end += 1;
                }
                let raw = &url[value_start..value_end];
                let decoded = crate::util::percent_decode(raw);
                if looks_like_token(&decoded) {
                    return Some(decoded);
                }
                if let Some(found) = extract_token_from_text(&decoded) {
                    return Some(found);
                }
            }
            search_from = position + pattern.len();
            if search_from >= url.len() {
                break;
            }
        }
    }
    if let Some(hash_position) = url.find('#') {
        let hash = &url[hash_position + 1..];
        if looks_like_token(hash) {
            return Some(hash.trim().to_string());
        }
    }
    None
}

/// Универсальный поиск токена: объект/строка → URL → текст.
pub fn extract_token(source: &Json) -> Option<String> {
    match source {
        Json::Null => None,
        Json::Obj(_) | Json::Arr(_) => extract_token_from_object(source),
        Json::Str(text) => {
            if text.trim().is_empty() {
                return None;
            }
            if let Some(found) = extract_token_from_url(text) {
                return Some(found);
            }
            extract_token_from_text(text)
        }
        other => {
            let text = other.text();
            if text.is_empty() {
                None
            } else {
                extract_token_from_text(&text)
            }
        }
    }
}

/// «Мягкий» поиск токена: нужен демо-режиму и мок-серверу с короткими токенами.
pub fn extract_loose_token(text: &str) -> Option<String> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return None;
    }
    if let Ok(parsed) = Json::parse(trimmed) {
        if let Some(Json::Str(value)) = parsed.get("token") {
            if !value.is_empty() {
                return Some(value.clone());
            }
        }
    }
    let lower = trimmed.to_lowercase();
    if let Some(position) = lower.find("\"token\"") {
        let rest = &trimmed[position + 7..];
        if let Some(colon) = rest.find(':') {
            let after = &rest[colon + 1..];
            if let Some(quote_start) = after.find('"') {
                let tail = &after[quote_start + 1..];
                if let Some(quote_end) = tail.find('"') {
                    return Some(tail[..quote_end].to_string());
                }
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    const JWT: &str = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwiZXhwIjo0MTAyNDQ0ODAwfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";

    #[test]
    fn tokens_are_found_in_any_shape() {
        assert_eq!(extract_token_from_text(JWT), Some(JWT.to_string()));
        assert_eq!(
            extract_token_from_text(&format!("<html>{{\"access_token\": \"{}\"}}</html>", JWT)),
            Some(JWT.to_string())
        );
        assert_eq!(
            extract_token_from_url(&format!("https://school.mos.ru/v2/token/refresh?token={}&x=1", JWT)),
            Some(JWT.to_string())
        );
        assert_eq!(
            extract_token_from_url(&format!("https://school.mos.ru/#access_token={}", JWT)),
            Some(JWT.to_string())
        );
        let source = Json::parse(&format!("{{\"data\":{{\"accessToken\":\"{}\"}}}}", JWT)).unwrap();
        assert_eq!(extract_token(&source), Some(JWT.to_string()));
        assert_eq!(extract_token_from_text("нет тут токена"), None);
    }

    #[test]
    fn loose_tokens_for_demo() {
        assert_eq!(extract_loose_token("{\"token\":\"mock-token-1\"}"), Some("mock-token-1".to_string()));
        assert_eq!(extract_loose_token("<b>\"token\": \"mock-token-7\"</b>"), Some("mock-token-7".to_string()));
    }

    #[test]
    fn token_format_checks() {
        assert!(!looks_like_token("abc"));
        assert!(!looks_like_token(&"a".repeat(40)));
        assert!(!looks_like_token("mock-token-1"));
        assert!(looks_like_token("Ab1Cd2Ef3Gh4Ij5Kl6Mn7Op8Qr9St0"));
        assert!(is_whole_token(JWT));
        assert!(!is_whole_token(&format!("текст {} текст", JWT)));
        // токен может быть найден внутри текста, но сама строка с пробелами токеном не считается
        assert!(find_jwt(&format!("текст {} текст", JWT)).is_some());
        assert!(!looks_like_token(&format!("текст {} текст", JWT)));
    }

    #[test]
    fn jwt_payload_and_mask() {
        let payload = decode_jwt(JWT).expect("полезная нагрузка");
        assert_eq!(payload.get("sub").and_then(Json::as_str), Some("1234567890"));
        assert_eq!(payload.get("exp").and_then(Json::as_i64), Some(4102444800));
        let info = describe_token(Some(JWT), 0);
        assert_eq!(info.get("kind").and_then(Json::as_str), Some("jwt"));
        assert_eq!(info.get("expiresAt").and_then(Json::as_i64), Some(4102444800000));
        assert_eq!(info.get("expired").and_then(Json::as_bool), Some(false));
        assert!(info.get("mask").unwrap().text().contains('…'));
        assert_eq!(describe_token(None, 0).get("present").and_then(Json::as_bool), Some(false));
        assert_eq!(mask_token("короткий"), "••••••••");
    }

    #[test]
    fn expired_token_is_marked() {
        let info = describe_token(Some(JWT), 9_999_999_999_999);
        assert_eq!(info.get("expired").and_then(Json::as_bool), Some(true));
    }
}
