//! `mesh-rank` — нативная командная строка Mesh Ranker (МЭШ).
//!
//! Команды:
//!   rank, subjects, marks, homeworks, schedule, insights, history, csv,
//!   bench, serve, state, token, selftest, version, help.
//!
//! `serve` — мост JSON-lines для Node (приложение использует нативное ядро
//! вместо JS-вычислений, см. `shared/core/native.js`).

mod args;
mod commands;
mod render;
mod selftest;
mod serve;

use std::path::{Path, PathBuf};

use mesh_core::bridge::{Session, SessionOptions};
use mesh_core::cache::TokenFile;
use mesh_core::client::HOST;
use mesh_core::error::MeshResult;

pub use args::Args;

/// Каталог данных по умолчанию (история снимков и кэш имён).
const DEFAULT_DATA_DIR: &str = ".mesh-ranker";
/// Файл токена, совместимый с `ranker.py` и JS-ядром.
const DEFAULT_TOKEN_FILE: &str = "school-mos-ru.json";

/// Записывает текст в файл, создавая каталоги.
pub fn write_text_file(path: &Path, text: &str) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent)?;
        }
    }
    std::fs::write(path, text)
}

fn data_dir(args: &Args) -> PathBuf {
    PathBuf::from(args.value("data-dir").unwrap_or_else(|| DEFAULT_DATA_DIR.to_string()))
}

/// Собирает сессию из аргументов: адрес, токен, кэши и каталог данных.
pub fn session_from_args(args: &Args) -> MeshResult<Session> {
    let data = data_dir(args);
    let base_url = if args.has("demo") {
        args.value("base-url")
            .unwrap_or_else(|| "http://127.0.0.1:8787".to_string())
    } else {
        args.value("base-url").unwrap_or_else(|| HOST.to_string())
    };
    let demo = args.has("demo") || base_url.contains("127.0.0.1") || base_url.contains("localhost");

    let mut options = SessionOptions {
        base_url,
        token: args.value("token"),
        profile_id: args.value("profile-id"),
        timeout_ms: args.number("timeout").unwrap_or(15_000).max(500) as u64,
        cache_ttl_ms: if args.has("no-cache") { 0 } else { 30_000 },
        demo,
        auto_refresh: !args.has("no-refresh"),
        history_path: Some(data.join("history.json")),
        name_cache_path: Some(data.join("users_cache.json")),
    };

    // Токен из файла: сначала явный --token-file, потом файл в текущем каталоге.
    if options.token.is_none() {
        let token_path = args
            .value("token-file")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(DEFAULT_TOKEN_FILE));
        if let Some(data_file) = TokenFile::load(&token_path) {
            options.token = Some(data_file.token.clone());
            if options.profile_id.is_none() && !data_file.profile_id.is_empty() {
                options.profile_id = Some(data_file.profile_id.clone());
            }
            let mut session = Session::new(options);
            if !data_file.contingent_guid.is_empty() {
                session.active_person_id = Some(data_file.contingent_guid.clone());
            }
            return Ok(session);
        }
    }
    Ok(Session::new(options))
}

fn print_help() {
    let mut out = String::new();
    out.push_str("mesh-rank — нативный CLI и мост Mesh Ranker (МЭШ, school.mos.ru)\n\n");
    out.push_str("Использование:\n  mesh-rank <команда> [параметры]\n\nКоманды:\n");
    for (name, description) in commands::features() {
        out.push_str(&format!("  {:<10} {}\n", name, description));
    }
    out.push_str(
        "\nОбщие параметры:\n\
         \x20 --token <TOKEN>          токен МЭШ (или файл school-mos-ru.json рядом)\n\
         \x20 --token-file <FILE>      файл с токеном (формат ranker.py)\n\
         \x20 --profile-id <ID>        Profile-Id ученика\n\
         \x20 --person-id <UUID>       contingent_guid ученика\n\
         \x20 --student-id <ID>        числовой id ученика\n\
         \x20 --base-url <URL>         адрес МЭШ (по умолчанию https://school.mos.ru)\n\
         \x20 --demo                   демо-режим против локального мок-сервера\n\
         \x20 --date <YYYY-MM-DD>      дата снимка\n\
         \x20 --from/--to <DATE>       период для оценок и заданий\n\
         \x20 --subject <ID|ИМЯ>       предмет (можно повторять; --all — все предметы)\n\
         \x20 --target <БАЛЛ>          цель по среднему баллу (insights)\n\
         \x20 --remaining <N>          сколько работ ещё ожидается (insights)\n\
         \x20 --top <N>                сколько строк показывать (0 — все)\n\
         \x20 --data-dir <DIR>         каталог истории и кэша (по умолчанию .mesh-ranker)\n\
         \x20 --save-history           сохранить снимок рейтинга в историю\n\
         \x20 --json                   вывод в JSON (для скриптов)\n\
         \x20 --csv                    вывод в CSV (rank/marks/subjects)\n\
         \x20 --out <FILE>             файл вместо stdout\n\
         \x20 --no-color               без ANSI-цвета\n\n\
         Примеры:\n\
         \x20 mesh-rank selftest\n\
         \x20 mesh-rank bench --students 26 --iterations 500\n\
         \x20 mesh-rank rank --date 2026-10-12 --top 10\n\
         \x20 mesh-rank insights --target 4.5 --remaining 3\n\
         \x20 mesh-rank demo --base-url http://127.0.0.1:8787 --token mock-token-1\n\
         \x20 mesh-rank serve            # мост JSON-lines для приложения\n",
    );
    print!("{}", out);
}

fn main() {
    let items: Vec<String> = std::env::args().skip(1).collect();
    let args = Args::parse(items);
    let command = args.command();
    let code = match command.as_str() {
        "" | "help" | "--help" => {
            print_help();
            0
        }
        "version" => {
            println!("{}", mesh_core::about());
            println!("методов моста: {}", mesh_core::bridge::METHODS.len());
            0
        }
        "selftest" => selftest::run(),
        "bench" => commands::bench(&args),
        "serve" => serve::run(&args),
        "state" => commands::state(&args),
        "token" => commands::token(&args),
        "rank" => commands::rank(&args),
        "subjects" => commands::subjects(&args),
        "marks" => commands::marks(&args),
        "homeworks" => commands::homeworks(&args),
        "schedule" => commands::schedule(&args),
        "insights" => commands::insights_command(&args),
        "history" => commands::history(&args),
        "csv" => commands::csv(&args),
        other => {
            eprintln!("Неизвестная команда: {}", other);
            print_help();
            2
        }
    };
    std::process::exit(code);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_prefers_explicit_token() {
        let args = Args::parse(vec![
            "rank".to_string(),
            "--token".to_string(),
            "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghi".to_string(),
            "--base-url".to_string(),
            "https://school.mos.ru".to_string(),
            "--data-dir".to_string(),
            std::env::temp_dir().to_string_lossy().to_string(),
        ]);
        let session = session_from_args(&args).expect("сессия");
        assert!(session.client.token.is_some());
        assert!(!session.demo);
        assert!(session.history_path.is_some() || session.history.is_some());
    }

    #[test]
    fn demo_mode_is_detected_for_localhost() {
        let args = Args::parse(vec![
            "rank".to_string(),
            "--base-url".to_string(),
            "http://127.0.0.1:8787".to_string(),
        ]);
        let session = session_from_args(&args).expect("сессия");
        assert!(session.demo);
        assert!(session.client.allow_loose_token);
    }

    #[test]
    fn missing_token_is_not_an_error() {
        let args = Args::parse(vec!["state".to_string()]);
        let session = session_from_args(&args).expect("сессия");
        assert!(session.client.token.is_none());
    }
}
