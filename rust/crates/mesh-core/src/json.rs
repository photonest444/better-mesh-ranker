//! Минимальный, но полноценный JSON: разбор и сериализация без внешних зависимостей.
//!
//! Особенности, важные для протокола МЭШ:
//!   • объект хранится как `Vec<(String, Json)>` — порядок ключей сохраняется,
//!     что делает вывод детерминированным (важно для тестов и diff'ов);
//!   • числа хранятся как `f64`, но печатаются «как в JS»: `4.0` → `4`,
//!     `4.75` → `4.75` (короткое представление, как `JSON.stringify`);
//!   • `Json::text()` повторяет поведение JS-хелпера `util.asStr`.

use std::fmt;

/// Значение JSON.
#[derive(Clone, Debug, PartialEq)]
pub enum Json {
    Null,
    Bool(bool),
    Num(f64),
    Str(String),
    Arr(Vec<Json>),
    Obj(Vec<(String, Json)>),
}

/// Ошибка разбора с позицией — чтобы в логах было понятно, где сломался ответ.
#[derive(Clone, Debug, PartialEq)]
pub struct JsonError {
    pub message: String,
    pub offset: usize,
}

impl JsonError {
    fn new(message: impl Into<String>, offset: usize) -> JsonError {
        JsonError { message: message.into(), offset }
    }
}

impl fmt::Display for JsonError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{} (позиция {})", self.message, self.offset)
    }
}

impl std::error::Error for JsonError {}

/// Результат разбора JSON.
pub type JsonResult<T> = Result<T, JsonError>;

/// Печать числа так же, как это делает `JSON.stringify` в JavaScript.
pub fn num_text(n: f64) -> String {
    if !n.is_finite() {
        return "null".to_string();
    }
    if n.fract() == 0.0 && n.abs() < 1e15 {
        return format!("{}", n as i64);
    }
    format!("{}", n)
}

impl Json {
    // ------------------------------------------------------------- конструкторы --

    pub fn obj() -> Json {
        Json::Obj(Vec::new())
    }

    pub fn array(items: Vec<Json>) -> Json {
        Json::Arr(items)
    }

    pub fn str<S: Into<String>>(value: S) -> Json {
        Json::Str(value.into())
    }

    /// Объект из пар «ключ — значение» (порядок сохраняется).
    pub fn object(entries: Vec<(&str, Json)>) -> Json {
        Json::Obj(entries.into_iter().map(|(k, v)| (k.to_string(), v)).collect())
    }

    /// Число или `null` — удобно для средних баллов и мест.
    pub fn num(value: Option<f64>) -> Json {
        match value {
            Some(n) if n.is_finite() => Json::Num(n),
            _ => Json::Null,
        }
    }

    /// Целое или `null`.
    pub fn int(value: Option<i64>) -> Json {
        match value {
            Some(n) => Json::Num(n as f64),
            None => Json::Null,
        }
    }

    pub fn text_or_null(value: &Option<String>) -> Json {
        match value {
            Some(s) => Json::Str(s.clone()),
            None => Json::Null,
        }
    }

    // ------------------------------------------------------------------- доступ --

    pub fn get(&self, key: &str) -> Option<&Json> {
        match self {
            Json::Obj(entries) => {
                let mut found: Option<&Json> = None;
                for (k, v) in entries {
                    if k == key {
                        found = Some(v);
                        break;
                    }
                }
                found
            }
            _ => None,
        }
    }

    /// Значение по пути `"a.b.c"`.
    pub fn get_path(&self, path: &str) -> Option<&Json> {
        let mut cur = self;
        for part in path.split('.') {
            cur = cur.get(part)?;
        }
        Some(cur)
    }

    pub fn as_arr(&self) -> Option<&[Json]> {
        match self {
            Json::Arr(items) => Some(items.as_slice()),
            _ => None,
        }
    }

    pub fn as_str(&self) -> Option<&str> {
        match self {
            Json::Str(s) => Some(s.as_str()),
            _ => None,
        }
    }

    pub fn as_f64(&self) -> Option<f64> {
        match self {
            Json::Num(n) => Some(*n),
            Json::Str(s) => parse_number(s),
            Json::Bool(b) => Some(if *b { 1.0 } else { 0.0 }),
            _ => None,
        }
    }

    pub fn as_i64(&self) -> Option<i64> {
        self.as_f64().map(|n| n.trunc() as i64)
    }

    pub fn as_bool(&self) -> Option<bool> {
        match self {
            Json::Bool(b) => Some(*b),
            Json::Num(n) => Some(*n != 0.0),
            Json::Str(s) => {
                let t = s.trim().to_lowercase();
                Some(t == "true" || t == "1" || t == "да" || t == "yes")
            }
            _ => None,
        }
    }

    pub fn is_null(&self) -> bool {
        matches!(self, Json::Null)
    }

    /// Пусто ли значение: `null` или строка из пробелов (как `util.isBlank`).
    pub fn is_blank(&self) -> bool {
        match self {
            Json::Null => true,
            Json::Str(s) => s.trim().is_empty(),
            _ => false,
        }
    }

    pub fn is_obj(&self) -> bool {
        matches!(self, Json::Obj(_))
    }

    /// Аналог JS-хелпера `util.asStr`: `null` → пустая строка, число без «.0».
    pub fn text(&self) -> String {
        match self {
            Json::Null => String::new(),
            Json::Str(s) => s.clone(),
            Json::Bool(b) => {
                if *b {
                    "true".to_string()
                } else {
                    "false".to_string()
                }
            }
            Json::Num(n) => num_text(*n),
            Json::Arr(_) | Json::Obj(_) => String::new(),
        }
    }

    /// Первое непустое значение из списка ключей (аналог `util.firstDefined`).
    pub fn pick(&self, keys: &[&str]) -> Option<&Json> {
        for key in keys {
            if let Some(value) = self.get(key) {
                if !value.is_null() && !value.is_blank() {
                    return Some(value);
                }
            }
        }
        None
    }

    /// Строка из первого непустого ключа.
    pub fn pick_text(&self, keys: &[&str]) -> String {
        match self.pick(keys) {
            Some(value) => value.text(),
            None => String::new(),
        }
    }

    /// Число из первого непустого ключа.
    pub fn pick_num(&self, keys: &[&str]) -> Option<f64> {
        match self.pick(keys) {
            Some(value) => value.as_f64(),
            None => None,
        }
    }

    /// Целое из первого непустого ключа.
    pub fn pick_int(&self, keys: &[&str]) -> Option<i64> {
        self.pick_num(keys).map(|n| n.trunc() as i64)
    }

    /// Строка из строки или массива строк (МЭШ иногда отдаёт и то, и другое).
    pub fn as_str_list(&self) -> Vec<String> {
        match self {
            Json::Arr(items) => items.iter().map(|item| item.text()).collect(),
            Json::Null => Vec::new(),
            other => vec![other.text()],
        }
    }

    // -------------------------------------------------------------------- запись --

    pub fn write_compact(&self, out: &mut String) {
        match self {
            Json::Null => out.push_str("null"),
            Json::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
            Json::Num(n) => out.push_str(&num_text(*n)),
            Json::Str(s) => write_escaped(s, out),
            Json::Arr(items) => {
                out.push('[');
                for (index, item) in items.iter().enumerate() {
                    if index > 0 {
                        out.push(',');
                    }
                    item.write_compact(out);
                }
                out.push(']');
            }
            Json::Obj(entries) => {
                out.push('{');
                for (index, (key, value)) in entries.iter().enumerate() {
                    if index > 0 {
                        out.push(',');
                    }
                    write_escaped(key, out);
                    out.push(':');
                    value.write_compact(out);
                }
                out.push('}');
            }
        }
    }

    pub fn write_pretty(&self, out: &mut String, depth: usize) {
        let pad = |level: usize| "  ".repeat(level);
        match self {
            Json::Arr(items) => {
                if items.is_empty() {
                    out.push_str("[]");
                    return;
                }
                out.push_str("[\n");
                for (index, item) in items.iter().enumerate() {
                    if index > 0 {
                        out.push_str(",\n");
                    }
                    out.push_str(&pad(depth + 1));
                    item.write_pretty(out, depth + 1);
                }
                out.push('\n');
                out.push_str(&pad(depth));
                out.push(']');
            }
            Json::Obj(entries) => {
                if entries.is_empty() {
                    out.push_str("{}");
                    return;
                }
                out.push_str("{\n");
                for (index, (key, value)) in entries.iter().enumerate() {
                    if index > 0 {
                        out.push_str(",\n");
                    }
                    out.push_str(&pad(depth + 1));
                    write_escaped(key, out);
                    out.push_str(": ");
                    value.write_pretty(out, depth + 1);
                }
                out.push('\n');
                out.push_str(&pad(depth));
                out.push('}');
            }
            other => other.write_compact(out),
        }
    }

    pub fn to_json_string(&self) -> String {
        let mut out = String::new();
        self.write_compact(&mut out);
        out
    }

    pub fn to_json_pretty(&self) -> String {
        let mut out = String::new();
        self.write_pretty(&mut out, 0);
        out
    }

    // -------------------------------------------------------------------- разбор --

    pub fn parse(text: &str) -> JsonResult<Json> {
        let mut parser = Parser { bytes: text.as_bytes(), pos: 0, depth: 0 };
        parser.skip_ws();
        let value = parser.value()?;
        parser.skip_ws();
        if parser.pos < parser.bytes.len() {
            return Err(JsonError::new("лишние символы после значения JSON", parser.pos));
        }
        Ok(value)
    }
}

/// Экранирование строки в кавычках (UTF-8 не трогаем — как serde/JS).
pub fn write_escaped(text: &str, out: &mut String) {
    out.push('"');
    for ch in text.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\u{08}' => out.push_str("\\b"),
            '\u{0c}' => out.push_str("\\f"),
            c if (c as u32) < 0x20 => {
                out.push_str(&format!("\\u{:04x}", c as u32));
            }
            c => out.push(c),
        }
    }
    out.push('"');
}

/// Разбор числа из строки («4,75» тоже понимаем — как это делает `util.asNum`).
pub fn parse_number(text: &str) -> Option<f64> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return None;
    }
    if let Ok(value) = trimmed.parse::<f64>() {
        if value.is_finite() {
            return Some(value);
        }
    }
    if trimmed.contains(',') {
        let swapped = trimmed.replace(',', ".");
        if let Ok(value) = swapped.parse::<f64>() {
            if value.is_finite() {
                return Some(value);
            }
        }
    }
    None
}

const MAX_DEPTH: usize = 64;

struct Parser<'a> {
    bytes: &'a [u8],
    pos: usize,
    depth: usize,
}

impl<'a> Parser<'a> {
    fn skip_ws(&mut self) {
        while self.pos < self.bytes.len() {
            let byte = self.bytes[self.pos];
            if byte == b' ' || byte == b'\t' || byte == b'\n' || byte == b'\r' {
                self.pos += 1;
            } else {
                break;
            }
        }
    }

    fn peek(&self) -> Option<u8> {
        self.bytes.get(self.pos).copied()
    }

    fn expect(&mut self, byte: u8) -> JsonResult<()> {
        if self.peek() == Some(byte) {
            self.pos += 1;
            Ok(())
        } else {
            Err(JsonError::new(format!("ожидался символ '{}'", byte as char), self.pos))
        }
    }

    fn literal(&mut self, word: &str) -> JsonResult<()> {
        if self.bytes.len() >= self.pos + word.len()
            && &self.bytes[self.pos..self.pos + word.len()] == word.as_bytes()
        {
            self.pos += word.len();
            Ok(())
        } else {
            Err(JsonError::new(format!("ожидалось слово '{}'", word), self.pos))
        }
    }

    fn value(&mut self) -> JsonResult<Json> {
        self.depth += 1;
        if self.depth > MAX_DEPTH {
            return Err(JsonError::new("слишком глубокая вложенность JSON", self.pos));
        }
        let result = self.value_inner();
        self.depth -= 1;
        result
    }

    fn value_inner(&mut self) -> JsonResult<Json> {
        match self.peek() {
            None => Err(JsonError::new("неожиданный конец JSON", self.pos)),
            Some(b'{') => self.object(),
            Some(b'[') => self.array(),
            Some(b'"') => {
                let text = self.string()?;
                Ok(Json::Str(text))
            }
            Some(b't') => {
                self.literal("true")?;
                Ok(Json::Bool(true))
            }
            Some(b'f') => {
                self.literal("false")?;
                Ok(Json::Bool(false))
            }
            Some(b'n') => {
                self.literal("null")?;
                Ok(Json::Null)
            }
            Some(_) => self.number(),
        }
    }

    fn object(&mut self) -> JsonResult<Json> {
        self.expect(b'{')?;
        let mut entries: Vec<(String, Json)> = Vec::new();
        self.skip_ws();
        if self.peek() == Some(b'}') {
            self.pos += 1;
            return Ok(Json::Obj(entries));
        }
        loop {
            self.skip_ws();
            let key = self.string()?;
            self.skip_ws();
            self.expect(b':')?;
            self.skip_ws();
            let value = self.value()?;
            entries.push((key, value));
            self.skip_ws();
            match self.peek() {
                Some(b',') => {
                    self.pos += 1;
                }
                Some(b'}') => {
                    self.pos += 1;
                    break;
                }
                _ => return Err(JsonError::new("ожидалась ',' или '}' в объекте", self.pos)),
            }
        }
        Ok(Json::Obj(entries))
    }

    fn array(&mut self) -> JsonResult<Json> {
        self.expect(b'[')?;
        let mut items: Vec<Json> = Vec::new();
        self.skip_ws();
        if self.peek() == Some(b']') {
            self.pos += 1;
            return Ok(Json::Arr(items));
        }
        loop {
            self.skip_ws();
            let value = self.value()?;
            items.push(value);
            self.skip_ws();
            match self.peek() {
                Some(b',') => {
                    self.pos += 1;
                }
                Some(b']') => {
                    self.pos += 1;
                    break;
                }
                _ => return Err(JsonError::new("ожидалась ',' или ']' в массиве", self.pos)),
            }
        }
        Ok(Json::Arr(items))
    }

    fn string(&mut self) -> JsonResult<String> {
        self.expect(b'"')?;
        let mut out: Vec<u8> = Vec::new();
        loop {
            let byte = match self.peek() {
                Some(b) => b,
                None => return Err(JsonError::new("незакрытая строка JSON", self.pos)),
            };
            self.pos += 1;
            match byte {
                b'"' => break,
                b'\\' => {
                    let escaped = match self.peek() {
                        Some(b) => b,
                        None => return Err(JsonError::new("незакрытая escape-последовательность", self.pos)),
                    };
                    self.pos += 1;
                    match escaped {
                        b'"' => out.push(b'"'),
                        b'\\' => out.push(b'\\'),
                        b'/' => out.push(b'/'),
                        b'b' => out.push(0x08),
                        b'f' => out.push(0x0c),
                        b'n' => out.push(b'\n'),
                        b'r' => out.push(b'\r'),
                        b't' => out.push(b'\t'),
                        b'u' => {
                            let code = self.hex4()?;
                            let ch = if (0xD800..0xDC00).contains(&code) {
                                // суррогатная пара
                                if self.peek() == Some(b'\\') {
                                    self.pos += 1;
                                    if self.peek() == Some(b'u') {
                                        self.pos += 1;
                                        let low = self.hex4()?;
                                        let combined = 0x10000
                                            + ((code - 0xD800) << 10)
                                            + (low.wrapping_sub(0xDC00));
                                        char::from_u32(combined).unwrap_or('\u{fffd}')
                                    } else {
                                        '\u{fffd}'
                                    }
                                } else {
                                    '\u{fffd}'
                                }
                            } else {
                                char::from_u32(code).unwrap_or('\u{fffd}')
                            };
                            let mut buffer = [0u8; 4];
                            out.extend_from_slice(ch.encode_utf8(&mut buffer).as_bytes());
                        }
                        other => {
                            return Err(JsonError::new(
                                format!("неизвестная escape-последовательность '\\{}'", other as char),
                                self.pos,
                            ))
                        }
                    }
                }
                other => out.push(other),
            }
        }
        Ok(String::from_utf8_lossy(&out).into_owned())
    }

    fn hex4(&mut self) -> JsonResult<u32> {
        if self.pos + 4 > self.bytes.len() {
            return Err(JsonError::new("оборван \\uXXXX", self.pos));
        }
        let digits = &self.bytes[self.pos..self.pos + 4];
        let mut value = 0u32;
        for byte in digits {
            let digit = match *byte {
                b'0'..=b'9' => (byte - b'0') as u32,
                b'a'..=b'f' => (byte - b'a') as u32 + 10,
                b'A'..=b'F' => (byte - b'A') as u32 + 10,
                _ => return Err(JsonError::new("\\uXXXX: не шестнадцатеричная цифра", self.pos)),
            };
            value = value * 16 + digit;
        }
        self.pos += 4;
        Ok(value)
    }

    fn number(&mut self) -> JsonResult<Json> {
        let start = self.pos;
        if self.peek() == Some(b'-') || self.peek() == Some(b'+') {
            self.pos += 1;
        }
        while let Some(byte) = self.peek() {
            if byte.is_ascii_digit() || byte == b'.' || byte == b'e' || byte == b'E' || byte == b'+' || byte == b'-' {
                self.pos += 1;
            } else {
                break;
            }
        }
        if start == self.pos {
            return Err(JsonError::new("неожиданный символ в JSON", self.pos));
        }
        let slice = &self.bytes[start..self.pos];
        let text = String::from_utf8_lossy(slice);
        match text.parse::<f64>() {
            Ok(value) if value.is_finite() => Ok(Json::Num(value)),
            _ => Err(JsonError::new(format!("не число: {}", text), start)),
        }
    }
}

/// Удобные конструкторы для тестов и CLI.
pub fn json_str(value: impl Into<String>) -> Json {
    Json::Str(value.into())
}

pub fn json_num(value: f64) -> Json {
    Json::Num(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_objects() {
        let text = r#"{"a":[1,2.5,"три"],"b":{"c":null},"d":true}"#;
        let parsed = Json::parse(text).expect("разбор");
        assert_eq!(parsed.get("d").and_then(Json::as_bool), Some(true));
        assert_eq!(parsed.get_path("b.c").map(Json::is_null), Some(true));
        assert_eq!(parsed.to_json_string(), text);
    }

    #[test]
    fn numbers_print_like_js() {
        assert_eq!(Json::Num(4.0).to_json_string(), "4");
        assert_eq!(Json::Num(4.75).to_json_string(), "4.75");
        assert_eq!(Json::Str("х".into()).to_json_string(), "\"х\"");
    }

    #[test]
    fn escapes_and_unicode() {
        let parsed = Json::parse(r#""строка \"в кавычках\" \n и \u0041""#).expect("разбор");
        assert_eq!(parsed.as_str(), Some("строка \"в кавычках\" \n и A"));
    }

    #[test]
    fn broken_json_reports_position() {
        assert!(Json::parse("{\"a\":}").is_err());
        assert!(Json::parse("[1,2").is_err());
    }

    #[test]
    fn number_parsing_is_tolerant() {
        assert_eq!(parse_number("4,75"), Some(4.75));
        assert_eq!(parse_number("4.75"), Some(4.75));
        assert_eq!(parse_number("abc"), None);
    }

    #[test]
    fn pick_skips_empty() {
        let value = Json::parse(r#"{"a":"","b":null,"c":"да"}"#).expect("разбор");
        assert_eq!(value.pick_text(&["a", "b", "c"]), "да");
        assert_eq!(value.pick_text(&["x"]), "");
    }
}
