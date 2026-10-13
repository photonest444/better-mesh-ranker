//! Ошибки нативного ядра и их «человеческие» описания для интерфейса.

use std::fmt;

/// Код ошибки совпадает с кодами JS-ядра (`network`, `timeout`, `unauthorized`, …),
/// поэтому интерфейс одинаково показывает сообщения от любого движка.
#[derive(Clone, Debug, PartialEq)]
pub struct MeshError {
    pub code: String,
    pub message: String,
    pub status: u16,
}

/// Результат операции ядра.
pub type MeshResult<T> = Result<T, MeshError>;

impl MeshError {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> MeshError {
        MeshError { code: code.into(), message: message.into(), status: 0 }
    }

    pub fn with_status(mut self, status: u16) -> MeshError {
        self.status = status;
        self
    }

    pub fn network(message: impl Into<String>) -> MeshError {
        MeshError::new("network", message)
    }

    pub fn timeout(message: impl Into<String>) -> MeshError {
        MeshError::new("timeout", message)
    }

    pub fn unauthorized() -> MeshError {
        MeshError::new("unauthorized", "Не авторизован (401)").with_status(401)
    }

    pub fn forbidden() -> MeshError {
        MeshError::new("forbidden", "Доступ запрещён (403)").with_status(403)
    }

    pub fn not_found(path: &str) -> MeshError {
        MeshError::new("not-found", format!("Метод не найден (404): {}", path)).with_status(404)
    }

    pub fn invalid_json(detail: impl Into<String>) -> MeshError {
        MeshError::new("invalid-json", detail)
    }

    pub fn bad_token(message: impl Into<String>) -> MeshError {
        MeshError::new("bad-token", message)
    }

    pub fn http(status: u16, path: &str) -> MeshError {
        MeshError::new("http-", format!("Ошибка МЭШ: HTTP {} ({})", status, path))
            .with_status(status)
    }

    pub fn unsupported(feature: impl Into<String>) -> MeshError {
        MeshError::new("unsupported", feature)
    }

    /// Текст для человека — повторяет `describeError` из JS-ядра.
    pub fn describe(&self) -> String {
        match self.code.as_str() {
            "network" => "Нет связи с school.mos.ru. Проверьте интернет и попробуйте ещё раз.".to_string(),
            "timeout" => "Сервер МЭШ не ответил вовремя. Попробуйте ещё раз.".to_string(),
            "unauthorized" => "Токен недействителен или истёк. Выполните вход в МЭШ заново.".to_string(),
            "forbidden" => "Нет доступа к данным (403). Возможно, нужен вход под ролью родителя.".to_string(),
            "not-found" => "Метод недоступен для вашего региона или подсистемы (404).".to_string(),
            "invalid-json" => "МЭШ вернул неожиданный ответ. Возможно, требуется повторный вход.".to_string(),
            "bad-token" => self.message.clone(),
            _ => {
                if self.code.starts_with("http-") {
                    format!("Ошибка сервера МЭШ ({}). Попробуйте позже.", self.status)
                } else if self.message.is_empty() {
                    "Неизвестная ошибка".to_string()
                } else {
                    self.message.clone()
                }
            }
        }
    }

    /// Представление для моста Node/CLI.
    pub fn to_json(&self) -> crate::json::Json {
        crate::json::Json::object(vec![
            ("code", crate::json::Json::str(self.code.clone())),
            ("message", crate::json::Json::str(self.describe())),
            ("raw", crate::json::Json::str(self.message.clone())),
            ("status", crate::json::Json::Num(self.status as f64)),
        ])
    }
}

impl fmt::Display for MeshError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for MeshError {}

impl From<std::io::Error> for MeshError {
    fn from(error: std::io::Error) -> MeshError {
        match error.kind() {
            std::io::ErrorKind::TimedOut | std::io::ErrorKind::WouldBlock => {
                MeshError::timeout(format!("Таймаут сетевого соединения: {}", error))
            }
            _ => MeshError::network(format!("Сеть недоступна: {}", error)),
        }
    }
}
