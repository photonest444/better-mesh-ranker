//! `mesh-rank serve` — мост JSON-lines для Node/Electron и любых других хостов.
//!
//! Строка stdin = один запрос, строка stdout = один ответ. В stdout не попадает
//! ничего лишнего (диагностика идёт в stderr), поэтому хост может читать поток
//! построчно без парсинга «шума».

use std::io::{BufRead, Write};

use mesh_core::bridge::Session;
use mesh_core::json::Json;

use crate::session_from_args;
use crate::Args;

/// Обрабатывает одну строку запроса и возвращает строку ответа.
pub fn handle_line(session: &mut Session, line: &str) -> Option<String> {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return None;
    }

    // Приветствие хоста («hello») и служебные команды требуют только method.
    let request = match Json::parse(trimmed) {
        Ok(value) => value,
        Err(error) => {
            let payload = Json::object(vec![
                ("id", Json::Null),
                ("ok", Json::Bool(false)),
                (
                    "error",
                    Json::object(vec![
                        ("code", Json::str("bad-json")),
                        ("message", Json::str(format!("Некорректный JSON запроса: {}", error))),
                    ]),
                ),
            ]);
            return Some(payload.to_json_string());
        }
    };

    let id = request.get("id").cloned().unwrap_or(Json::Null);
    let method = request.get("method").map(Json::text).unwrap_or_default();
    let params = request.get("params").cloned().unwrap_or(Json::obj());

    if method == "shutdown" || method == "exit" {
        let payload = Json::object(vec![
            ("id", id),
            ("ok", Json::Bool(true)),
            ("result", Json::object(vec![("bye", Json::Bool(true))])),
        ]);
        return Some(payload.to_json_string());
    }

    match session.handle(&method, &params) {
        Ok(result) => Some(
            Json::object(vec![
                ("id", id),
                ("ok", Json::Bool(true)),
                ("result", result),
            ])
            .to_json_string(),
        ),
        Err(error) => Some(
            Json::object(vec![
                ("id", id),
                ("ok", Json::Bool(false)),
                ("error", error.to_json()),
            ])
            .to_json_string(),
        ),
    }
}

/// Главный цикл моста.
pub fn run(args: &Args) -> i32 {
    let mut session = match session_from_args(args) {
        Ok(session) => session,
        Err(error) => {
            eprintln!("Не удалось запустить сессию: {}", error.describe());
            return 2;
        }
    };

    let stdin = std::io::stdin();
    let mut stdout = std::io::stdout();
    let mut buffer = String::new();
    loop {
        buffer.clear();
        match stdin.lock().read_line(&mut buffer) {
            Ok(0) => break,
            Ok(_) => {}
            Err(error) => {
                eprintln!("Ошибка чтения stdin: {}", error);
                break;
            }
        }
        if let Some(response) = handle_line(&mut session, &buffer) {
            if writeln!(stdout, "{}", response).is_err() {
                break;
            }
            let _ = stdout.flush();
        }
        if buffer.contains("\"shutdown\"") || buffer.contains("\"exit\"") {
            break;
        }
    }
    session.flush();
    0
}

#[cfg(test)]
mod tests {
    use super::*;
    use mesh_core::bridge::SessionOptions;

    #[test]
    fn hello_answer_is_ok() {
        let mut session = Session::new(SessionOptions::default());
        let response = handle_line(&mut session, r#"{"id":1,"method":"hello"}"#).expect("ответ");
        assert!(response.contains("\"ok\":true"));
        assert!(response.contains("mesh-rank"));
    }

    #[test]
    fn broken_json_is_reported_not_panicking() {
        let mut session = Session::new(SessionOptions::default());
        let response = handle_line(&mut session, "{это не json").expect("ответ");
        assert!(response.contains("bad-json"));
    }

    #[test]
    fn offline_methods_work_through_the_bridge() {
        let mut session = Session::new(SessionOptions::default());
        let request = r#"{"id":7,"method":"rank.build","params":{"members":[{"personId":"a","rank":{"averageMarkFive":5,"rankPlace":1}}],"names":{"a":"Иванов Иван"},"meId":"a"}}"#;
        let response = handle_line(&mut session, request).expect("ответ");
        assert!(response.contains("\"Иванов Иван\""));
        assert!(response.contains("\"myPlace\":1"));
    }

    #[test]
    fn empty_lines_are_ignored() {
        let mut session = Session::new(SessionOptions::default());
        assert!(handle_line(&mut session, "   ").is_none());
    }
}
