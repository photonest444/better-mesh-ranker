//! HTTP/1.1 своими руками: без внешних крейтов и без TLS-зависимостей.
//!
//! Почему так:
//!   • `http://` (мок-сервер МЭШ, локальный прокси, корпоративный шлюз) идёт
//!     напрямую через `std::net::TcpStream` — быстро и без зависимостей;
//!   • `https://school.mos.ru` обслуживается системным `curl`, если он есть
//!     (Linux/macOS/Windows 10+). Так сборка остаётся «нулевой по зависимостям»,
//!     а нативный CLI умеет работать с боевым МЭШ.
//!
//! Если ни один вариант недоступен, возвращается понятная ошибка `unsupported`.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::process::Command;
use std::time::Duration;

use crate::error::{MeshError, MeshResult};

/// HTTP-запрос.
#[derive(Clone, Debug)]
pub struct Request {
    pub method: String,
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub body: Option<String>,
}

impl Request {
    pub fn get(url: &str, headers: Vec<(String, String)>) -> Request {
        Request { method: "GET".to_string(), url: url.to_string(), headers, body: None }
    }
}

/// HTTP-ответ.
#[derive(Clone, Debug)]
pub struct Response {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: String,
}

impl Response {
    pub fn is_ok(&self) -> bool {
        (200..300).contains(&self.status)
    }

    pub fn header(&self, name: &str) -> Option<&str> {
        let lowered = name.to_lowercase();
        for (key, value) in &self.headers {
            if key.to_lowercase() == lowered {
                return Some(value.as_str());
            }
        }
        None
    }

    /// Разбор ответа как JSON.
    pub fn json(&self) -> MeshResult<crate::json::Json> {
        crate::json::Json::parse(&self.body).map_err(|error| {
            MeshError::invalid_json(format!("Не удалось разобрать ответ МЭШ как JSON: {}", error))
        })
    }
}

/// Транспорт: низкоуровневая доставка запроса.
pub trait Transport: Send + Sync {
    fn send(&self, request: &Request, timeout: Duration) -> MeshResult<Response>;
    fn name(&self) -> &'static str;
}

/// Разобранный URL.
#[derive(Clone, Debug, PartialEq)]
pub struct ParsedUrl {
    pub scheme: String,
    pub host: String,
    pub port: u16,
    pub path: String,
}

impl ParsedUrl {
    pub fn host_header(&self) -> String {
        let default_port = (self.scheme == "http" && self.port == 80) || (self.scheme == "https" && self.port == 443);
        if default_port {
            self.host.clone()
        } else {
            format!("{}:{}", self.host, self.port)
        }
    }
}

pub fn parse_url(url: &str) -> MeshResult<ParsedUrl> {
    let (scheme, rest) = match url.find("://") {
        Some(index) => (url[..index].to_lowercase(), &url[index + 3..]),
        None => return Err(MeshError::network(format!("Некорректный адрес: {}", url))),
    };
    if scheme != "http" && scheme != "https" {
        return Err(MeshError::unsupported(format!("Схема {} не поддерживается", scheme)));
    }
    let (authority, path) = match rest.find('/') {
        Some(index) => (&rest[..index], &rest[index..]),
        None => (rest, "/"),
    };
    let (host, port) = match authority.rfind(':') {
        Some(index) if authority[index + 1..].chars().all(|c| c.is_ascii_digit()) => (
            authority[..index].to_string(),
            authority[index + 1..].parse::<u16>().unwrap_or(80),
        ),
        _ => (
            authority.to_string(),
            if scheme == "https" { 443 } else { 80 },
        ),
    };
    if host.is_empty() {
        return Err(MeshError::network(format!("В адресе нет хоста: {}", url)));
    }
    Ok(ParsedUrl { scheme, host, port, path: if path.is_empty() { "/".to_string() } else { path.to_string() } })
}

/// Обычный (небезопасный) HTTP через TCP-сокет.
pub struct PlainHttpTransport;

impl Transport for PlainHttpTransport {
    fn name(&self) -> &'static str {
        "tcp"
    }

    fn send(&self, request: &Request, timeout: Duration) -> MeshResult<Response> {
        let parsed = parse_url(&request.url)?;
        if parsed.scheme != "http" {
            return Err(MeshError::unsupported("TcpTransport умеет только http://"));
        }
        let address = format!("{}:{}", parsed.host, parsed.port);
        let mut last_error: Option<MeshError> = None;
        let mut stream: Option<TcpStream> = None;
        let addrs = address
            .to_socket_addrs()
            .map_err(|error| MeshError::network(format!("Не удалось разрешить {}: {}", parsed.host, error)))?;
        for candidate in addrs {
            match TcpStream::connect_timeout(&candidate, timeout) {
                Ok(connection) => {
                    stream = Some(connection);
                    break;
                }
                Err(error) => {
                    last_error = Some(MeshError::network(format!("Не удалось подключиться к {}: {}", address, error)));
                }
            }
        }
        let stream = match stream {
            Some(value) => value,
            None => return Err(last_error.unwrap_or_else(|| MeshError::network("Нет подходящего адреса"))),
        };
        stream.set_read_timeout(Some(timeout)).ok();
        stream.set_write_timeout(Some(timeout)).ok();

        let body = request.body.clone().unwrap_or_default();
        let mut head = String::new();
        head.push_str(&format!("{} {} HTTP/1.1\r\n", request.method, parsed.path));
        head.push_str(&format!("Host: {}\r\n", parsed.host_header()));
        head.push_str("Accept-Encoding: identity\r\n");
        head.push_str("Connection: close\r\n");
        for (key, value) in &request.headers {
            head.push_str(&format!("{}: {}\r\n", key, value));
        }
        if !body.is_empty() {
            head.push_str(&format!("Content-Length: {}\r\n", body.as_bytes().len()));
        }
        head.push_str("\r\n");

        let mut writer = stream
            .try_clone()
            .map_err(|error| MeshError::network(format!("Сокет недоступен: {}", error)))?;
        writer
            .write_all(head.as_bytes())
            .map_err(|error| MeshError::network(format!("Не удалось отправить запрос: {}", error)))?;
        if !body.is_empty() {
            writer
                .write_all(body.as_bytes())
                .map_err(|error| MeshError::network(format!("Не удалось отправить тело запроса: {}", error)))?;
        }
        writer.flush().ok();

        let mut reader = BufReader::new(stream);
        read_response(&mut reader)
    }
}

/// HTTPS через системный `curl` (если он есть в PATH).
pub struct CurlTransport;

impl CurlTransport {
    pub fn available() -> bool {
        Command::new("curl")
            .arg("--version")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .map(|status| status.success())
            .unwrap_or(false)
    }
}

impl Transport for CurlTransport {
    fn name(&self) -> &'static str {
        "curl"
    }

    fn send(&self, request: &Request, timeout: Duration) -> MeshResult<Response> {
        let seconds = timeout.as_secs().max(1).to_string();
        let mut command = Command::new("curl");
        command
            .arg("-s")
            .arg("-S")
            .arg("-i")
            .arg("--max-time")
            .arg(seconds)
            .arg("-X")
            .arg(&request.method);
        for (key, value) in &request.headers {
            command.arg("-H").arg(format!("{}: {}", key, value));
        }
        if let Some(body) = &request.body {
            command.arg("--data-binary").arg(body);
        }
        command.arg(&request.url);
        let output = command
            .output()
            .map_err(|error| MeshError::network(format!("Не удалось запустить curl: {}", error)))?;
        if output.stdout.is_empty() {
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            return Err(MeshError::network(if stderr.is_empty() {
                "curl не вернул ответ".to_string()
            } else {
                format!("curl: {}", stderr)
            }));
        }
        let text = String::from_utf8_lossy(&output.stdout);
        parse_response(&text)
    }
}

/// Транспорт «сам выбирает»: http → TCP, https → curl.
pub struct AutoTransport;

impl Transport for AutoTransport {
    fn name(&self) -> &'static str {
        "auto"
    }

    fn send(&self, request: &Request, timeout: Duration) -> MeshResult<Response> {
        let parsed = parse_url(&request.url)?;
        if parsed.scheme == "https" {
            if !CurlTransport::available() {
                return Err(MeshError::unsupported(
                    "Для https:// нужен системный curl (или используйте локальный прокси: --base-url http://127.0.0.1:PORT)",
                ));
            }
            return CurlTransport.send(request, timeout);
        }
        PlainHttpTransport.send(request, timeout)
    }
}

/// Клиент с поддержкой переходов по редиректам (МЭШ иногда отвечает 302 на входе).
pub struct HttpClient {
    transport: Box<dyn Transport>,
}

impl HttpClient {
    pub fn new(transport: Box<dyn Transport>) -> HttpClient {
        HttpClient { transport }
    }

    pub fn auto() -> HttpClient {
        HttpClient::new(Box::new(AutoTransport))
    }

    pub fn transport_name(&self) -> &'static str {
        self.transport.name()
    }

    pub fn send(&self, request: &Request, timeout: Duration) -> MeshResult<Response> {
        let mut current = request.clone();
        let mut hops = 0;
        loop {
            let response = self.transport.send(&current, timeout)?;
            let is_redirect = matches!(response.status, 301 | 302 | 303 | 307 | 308);
            if !is_redirect || hops >= 4 {
                return Ok(response);
            }
            let location = match response.header("location") {
                Some(value) => value.to_string(),
                None => return Ok(response),
            };
            hops += 1;
            let next_url = if location.starts_with("http://") || location.starts_with("https://") {
                location
            } else {
                let parsed = parse_url(&current.url)?;
                let prefix = format!("{}://{}:{}", parsed.scheme, parsed.host, parsed.port);
                if location.starts_with('/') {
                    format!("{}{}", prefix, location)
                } else {
                    format!("{}/{}", prefix, location)
                }
            };
            current = Request {
                method: if response.status == 303 { "GET".to_string() } else { current.method.clone() },
                url: next_url,
                headers: current.headers.clone(),
                body: if response.status == 303 { None } else { current.body.clone() },
            };
        }
    }
}

/// Разбор HTTP-ответа из текста (используется и в TCP-, и в curl-транспорте).
pub fn parse_response(text: &str) -> MeshResult<Response> {
    let split = text.find("\r\n\r\n").or_else(|| text.find("\n\n"));
    let (head, body) = match split {
        Some(index) => {
            let separator = if text[index..].starts_with("\r\n\r\n") { 4 } else { 2 };
            (&text[..index], &text[index + separator..])
        }
        None => (text, ""),
    };
    let mut lines = head.lines();
    let status_line = lines.next().unwrap_or_default();
    let status = parse_status(status_line)
        .ok_or_else(|| MeshError::network(format!("Не удалось разобрать статус HTTP: {}", status_line)))?;
    let mut headers: Vec<(String, String)> = Vec::new();
    for line in lines {
        if let Some(index) = line.find(':') {
            headers.push((line[..index].trim().to_string(), line[index + 1..].trim().to_string()));
        }
    }
    let chunked = headers
        .iter()
        .any(|(key, value)| key.to_lowercase() == "transfer-encoding" && value.to_lowercase().contains("chunked"));
    let decoded = if chunked { dechunk(body) } else { body.to_string() };
    Ok(Response { status, headers, body: decoded })
}

fn parse_status(line: &str) -> Option<u16> {
    let mut parts = line.split_whitespace();
    let _protocol = parts.next()?;
    parts.next()?.parse::<u16>().ok()
}

/// Декодирование `Transfer-Encoding: chunked`.
pub fn dechunk(body: &str) -> String {
    let mut out = String::new();
    let mut rest = body;
    loop {
        let line_end = match rest.find("\r\n") {
            Some(index) => index,
            None => break,
        };
        let size_text = rest[..line_end].trim();
        let size = match usize::from_str_radix(size_text.split(';').next().unwrap_or("").trim(), 16) {
            Ok(value) => value,
            Err(_) => break,
        };
        if size == 0 {
            break;
        }
        let chunk_start = line_end + 2;
        let chunk_end = chunk_start + size;
        if chunk_end > rest.len() {
            out.push_str(&rest[chunk_start..]);
            break;
        }
        out.push_str(&rest[chunk_start..chunk_end]);
        rest = &rest[(chunk_end + 2).min(rest.len())..];
    }
    out
}

fn read_response(reader: &mut BufReader<TcpStream>) -> MeshResult<Response> {
    let mut status_line = String::new();
    reader
        .read_line(&mut status_line)
        .map_err(|error| MeshError::network(format!("МЭШ не ответил: {}", error)))?;
    if status_line.trim().is_empty() {
        return Err(MeshError::network("Пустой ответ МЭШ"));
    }
    let status = parse_status(&status_line)
        .ok_or_else(|| MeshError::network(format!("Некорректный статус HTTP: {}", status_line.trim())))?;
    let mut headers: Vec<(String, String)> = Vec::new();
    loop {
        let mut line = String::new();
        let read = reader
            .read_line(&mut line)
            .map_err(|error| MeshError::network(format!("Обрыв соединения: {}", error)))?;
        if read == 0 {
            break;
        }
        let trimmed = line.trim_end();
        if trimmed.is_empty() {
            break;
        }
        if let Some(index) = trimmed.find(':') {
            headers.push((trimmed[..index].trim().to_string(), trimmed[index + 1..].trim().to_string()));
        }
    }

    let chunked = headers
        .iter()
        .any(|(key, value)| key.to_lowercase() == "transfer-encoding" && value.to_lowercase().contains("chunked"));
    let content_length = headers
        .iter()
        .find(|(key, _)| key.to_lowercase() == "content-length")
        .and_then(|(_, value)| value.parse::<usize>().ok());

    let mut raw: Vec<u8> = Vec::new();
    match (chunked, content_length) {
        (false, Some(length)) => {
            let _ = reader.by_ref().take(length as u64).read_to_end(&mut raw);
        }
        _ => {
            let _ = reader.read_to_end(&mut raw);
        }
    }
    let text = String::from_utf8_lossy(&raw).into_owned();
    let body = if chunked { dechunk(&text) } else { text };
    Ok(Response { status, headers, body })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn urls_are_parsed() {
        let parsed = parse_url("https://school.mos.ru/api/ej/rating/v1/rank/class?date=2026-10-12").expect("url");
        assert_eq!(parsed.scheme, "https");
        assert_eq!(parsed.host, "school.mos.ru");
        assert_eq!(parsed.port, 443);
        assert_eq!(parsed.host_header(), "school.mos.ru");
        assert!(parsed.path.starts_with("/api/ej/rating"));

        let local = parse_url("http://127.0.0.1:8787/api/state").expect("url");
        assert_eq!(local.port, 8787);
        assert_eq!(local.host_header(), "127.0.0.1:8787");
        assert!(parse_url("ftp://example.com").is_err());
    }

    #[test]
    fn responses_are_parsed() {
        let raw = "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 11\r\n\r\n{\"ok\":true}";
        let response = parse_response(raw).expect("ответ");
        assert_eq!(response.status, 200);
        assert!(response.is_ok());
        assert_eq!(response.header("content-type"), Some("application/json"));
        assert_eq!(response.json().expect("json").get("ok").and_then(crate::json::Json::as_bool), Some(true));
    }

    #[test]
    fn chunked_bodies_are_decoded() {
        let raw = "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n6\r\n{\"ok\":\r\n5\r\ntrue}\r\n0\r\n\r\n";
        let response = parse_response(raw).expect("ответ");
        assert_eq!(response.body, "{\"ok\":true}");
    }

    #[test]
    fn redirects_are_not_mistaken_for_errors() {
        let response = parse_response("HTTP/1.1 302 Found\r\nLocation: /v2/token/refresh\r\n\r\n").expect("ответ");
        assert_eq!(response.status, 302);
        assert_eq!(response.header("location"), Some("/v2/token/refresh"));
    }
}
