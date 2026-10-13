//! # mesh-core — нативное ядро Mesh Ranker
//!
//! Всё, что делает приложение с данными МЭШ (school.mos.ru), но на Rust:
//! разбор ответов, рейтинг класса, статистика, прогноз до цели, дедлайны,
//! экспорт в CSV и HTTP-клиент с автообновлением токена.
//!
//! ## Почему без зависимостей
//!
//! Крейт использует только `std`: JSON, base64, HTTP/1.1 и русские склонения
//! написаны здесь же. Это даёт:
//!   • сборку без crates.io (важно для CI и офлайн-сборок);
//!   • маленький бинарник и мгновенный старт (не нужен Node/JVM);
//!   • одинаковое поведение на Windows, Linux и macOS.
//!
//! ## Как это связано с JS-ядром
//!
//! `shared/core/mesh-core.js` остаётся источником правды для интерфейса, а этот
//! крейт повторяет его протокол и формы данных. Мост (`bridge::Session`) умеет
//! принимать те же JSON-структуры и отвечать теми же полями, поэтому Node может
//! подменять «горячие» вычисления нативными без изменения интерфейса.

pub const VERSION: &str = env!("CARGO_PKG_VERSION");

/// Краткое описание ядра (для `--version` и диагностики в приложении).
pub fn about() -> String {
    format!(
        "mesh-core {} — ядро Mesh Ranker (МЭШ) на Rust: разбор данных, рейтинг, статистика, прогноз, CSV, HTTP",
        VERSION
    )
}

pub mod bench;
pub mod bridge;
pub mod cache;
pub mod client;
pub mod error;
pub mod format;
pub mod http;
pub mod insights;
pub mod json;
pub mod marks;
pub mod model;
pub mod normalize;
pub mod rank;
pub mod stats;
pub mod token;
pub mod util;

pub use error::{MeshError, MeshResult};
pub use json::Json;
